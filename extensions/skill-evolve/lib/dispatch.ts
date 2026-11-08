/**
 * 派生复盘子进程：抢锁 → 写 run.json 与会话索引 → detached spawn → unref。
 *
 * 主会话侧的铁律（设计稿 4.3）：`dispatch()` 背后的长活儿全在 Promise 里，所有错误在内部吞掉，
 * 绝不惊动用户正在做的事。
 *
 * 去抖语义（设计稿 4.4）：`idleMs` 窗口内又结束一轮，不叠加新进程，而是把这一轮**记进 pending**；
 * 窗口过去后的下一次结算，把 pending 合并成一次派发，子进程读同一个会话文件，自然覆盖整段。
 * 若整个会话再也没等到那个「下一次」，`flushPending()` 在退出前补发最后一次。
 */
import { spawn } from "node:child_process";
import * as path from "node:path";
import { mergeAttributions, type Attribution } from "./attribution.ts";
import type { EvolutionConfig } from "./config.ts";
import { acquireLock, releaseLock, writeOwnerSync } from "./lock.ts";
import { buildPrompt, readPromptTemplateSync } from "./prompt.ts";
import { writeRunRecord, type RunRecord } from "./runs.ts";
import { writeSessionIndex } from "./session-index.ts";
import { CHILD_LOG, resolvePiBin, spawnDetached, uniqueRunId, sessionHashOf, type SpawnLike } from "./spawn-plan.ts";
import { mergePendingRounds } from "./pending.ts";
import { watchRunChild } from "./run-watch.ts";
import { spawnReviewSupervisor, type SupervisorSpawn } from "./review-spawn.ts";
import { guardBusy } from "./single-flight.ts";
import { drainPending } from "./drain-pending.ts";
import type { PendingRounds } from "./shutdown-dispatch.ts";
import type { MutationQueue, TelemetryWriter } from "./telemetry.ts";

export interface DispatchInput {
  sessionId: string;
  skills: string[];
  sessionFile?: string;
  /** 已经机械归因过的技能（A~E）：写进 prompt，复盘 agent 不必重判 */
  attributions?: Attribution[];
}

export interface DispatchDeps {
  evolutionDir: string;
  cwd: string;
  config: EvolutionConfig;
  telemetry: TelemetryWriter;
  queue: MutationQueue;
  promptTemplatePath: string;
  log?: (msg: string) => void;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
  spawnFn?: SpawnLike;
  /** 评审模型（"inherit" 或 provider/model）：每次派生现取，配置改动立即生效 */
  reviewModel?: () => string;
  /** 必红自检没过 → 整条流水线停用（设计稿 12.4） */
  selftestFailed?: () => boolean;
  /** 评审督导的 spawn（默认 node spawn；单测注入假实现） */
  supervisorSpawnFn?: SupervisorSpawn;
  /** pid 存活判定（全局单飞闸用；单测注入，测试里不起真子进程） */
  alive?: (pid: number) => boolean;
}

export interface DispatchedRun {
  runId: string;
  runDir: string;
  pid: number | null;
}

/** 派发结果：调用方（命令 / 事件）要据此出文案，所以不能再只用 null 表示「没派」 */
export type DispatchOutcome =
  | { status: "dispatched"; run: DispatchedRun }
  | { status: "skipped"; why: "disabled" | "cap" | "lock" | "lock-error" | "selftest-failed" | "busy"; ownerPid: number | null }
  | { status: "superseded"; rounds: number };

export interface DispatchOptions {
  /** 手动 `/skill-evolve run`：跳过去抖与单会话上限，但**仍必须守全局锁** */
  bypassThrottle?: boolean;
  trigger?: RunRecord["trigger"];
}

/** 去抖：窗口内又结束一轮，只更新 pending，不再叠加进程 */
export function shouldDebounce(lastDispatchAt: number | undefined, now: number, idleMs: number): boolean {
  return typeof lastDispatchAt === "number" && now - lastDispatchAt < idleMs;
}

export interface Dispatcher {
  dispatch(input: DispatchInput, options?: DispatchOptions): Promise<DispatchOutcome>;
  /** 退出前同步补发所有 pending，返回真正派发成功的条数；任何失败都不抛 */
  flushPending(): number;
}

export function createDispatcher(deps: DispatchDeps): Dispatcher {
  const log = deps.log ?? (() => {});
  const env = deps.env ?? process.env;
  const now = (): number => deps.now?.() ?? Date.now();
  const lastDispatchAt = new Map<string, number>();
  const dispatchCount = new Map<string, number>();
  /** 被去抖挡下的轮次，等窗口过去后在下一个结算点合并派发 */
  const pending = new Map<string, PendingRounds>();
  /** 一次进程生命周期内最多持有一把锁；释放后置回 false */
  let lockHeld = false;

  const releaseOnce = async (): Promise<void> => {
    if (!lockHeld) return;
    lockHeld = false;
    await releaseLock(deps.evolutionDir, log);
  };

  const mergePending = (input: DispatchInput, at: number): PendingRounds => {
    const merged = mergePendingRounds(pending.get(input.sessionId), input, at);
    pending.set(input.sessionId, merged);
    return merged;
  };

  const run = async (input: DispatchInput, options: DispatchOptions = {}): Promise<DispatchOutcome> => {
    const at = now();
    const bypass = options.bypassThrottle === true;
    const trigger: RunRecord["trigger"] = options.trigger ?? (bypass ? "manual" : "auto");

    if (!deps.config.enabled) {
      deps.telemetry.append({ kind: "skipped", sessionId: input.sessionId, why: "disabled", trigger });
      return { status: "skipped", why: "disabled", ownerPid: null };
    }

    // 必红自检没过就别再产出提案：评审器不可信时，继续派发只是在制造假结论
    if (deps.selftestFailed?.() === true) {
      deps.telemetry.append({ kind: "skipped", sessionId: input.sessionId, why: "selftest-failed", trigger });
      log("[skill-evolve] 跳过派生：必红自检未通过（评审器不可信，流水线停用）");
      return { status: "skipped", why: "selftest-failed", ownerPid: null };
    }

    if (!bypass) {
      const last = lastDispatchAt.get(input.sessionId);
      if (shouldDebounce(last, at, deps.config.idleMs)) {
        const carried = mergePending(input, at);
        deps.telemetry.append({
          kind: "superseded",
          sessionId: input.sessionId,
          lastDispatchAt: last ?? 0,
          idleMs: deps.config.idleMs,
          rounds: carried.rounds,
        });
        log(`[skill-evolve] 去抖：并入待复盘区间（已累计 ${carried.rounds} 轮，静默窗口过后补一次）`);
        return { status: "superseded", rounds: carried.rounds };
      }
      const used = dispatchCount.get(input.sessionId) ?? 0;
      if (used >= deps.config.perSessionCap) {
        deps.telemetry.append({ kind: "skipped", sessionId: input.sessionId, why: "cap", cap: deps.config.perSessionCap });
        return { status: "skipped", why: "cap", ownerPid: null };
      }
    }

    // 全局单飞（跨会话也成立）：已有复盘或督导在跑这一轮就不叠进程；放去抖 / 上限之后，那两条是「本轮不派」的既定语义
    const occupant = guardBusy({ evolutionDir: deps.evolutionDir, sessionId: input.sessionId, telemetry: deps.telemetry, trigger, alive: deps.alive, log });
    if (occupant) return { status: "skipped", why: "busy", ownerPid: occupant.pid };

    const carried = pending.get(input.sessionId);
    // 合并派发：本轮 + 之前被去抖挡下的所有轮次，覆盖起点取第一次被挡下的时刻
    const skills = carried
      ? [...carried.skills, ...input.skills.filter((name) => !carried.skills.includes(name))]
      : [...input.skills];
    const attributions = mergeAttributions(carried?.attributions, input.attributions);
    const coverage = carried ? { rounds: carried.rounds + 1, since: carried.since } : undefined;

    const runId = uniqueRunId(deps.evolutionDir, input.sessionId, at);
    const runDir = path.join(deps.evolutionDir, "runs", runId);
    const lock = await acquireLock({
      evolutionDir: deps.evolutionDir,
      owner: { pid: process.pid, ts: at, sessionId: input.sessionId },
      maxRuntimeMs: deps.config.maxRuntimeMs,
      log,
      now: () => at,
    });
    if (!lock.ok) {
      const why = lock.why === "error" ? "lock-error" : "lock";
      deps.telemetry.append({
        kind: "skipped",
        sessionId: input.sessionId,
        why,
        ownerPid: lock.owner?.pid ?? null,
        trigger,
      });
      log(`[skill-evolve] 跳过派生：锁不可用（owner pid ${lock.owner?.pid ?? "未知"}）`);
      return { status: "skipped", why, ownerPid: lock.owner?.pid ?? null };
    }
    lockHeld = true;

    try {
      const indexFile = path.join(runDir, "00-session", "index.json");
      const sessionFile = input.sessionFile ?? carried?.sessionFile;
      let evidenceMode: RunRecord["evidenceMode"] = "telemetry-only";
      if (sessionFile) {
        const index = await writeSessionIndex({ sessionFile, outDir: path.dirname(indexFile), queue: deps.queue, log });
        if (index) evidenceMode = "session+telemetry";
      }

      const record: RunRecord = {
        runId,
        status: "dispatched",
        trigger,
        sessionId: input.sessionId,
        sessionHash: sessionHashOf(input.sessionId),
        sessionFile: sessionFile ?? null,
        evidenceMode,
        dispatchedAt: at,
        dispatchedAtIso: new Date(at).toISOString(),
        pid: null,
        cwd: deps.cwd,
        skills,
        coverage,
        stages: [{ name: "dispatch", model: null, usage: null, ms: 0 }],
        artifacts: evidenceMode === "session+telemetry" ? { "00-session/index.json": indexFile } : {},
      };
      await writeRunRecord(runDir, record, deps.queue);

      const prompt = buildPrompt({
        template: readPromptTemplateSync(deps.promptTemplatePath, log),
        sessionFile,
        // telemetry-only 时 00-session/index.json 根本没生成，别把不存在的路径写进 prompt
        indexFile: evidenceMode === "session+telemetry" ? indexFile : undefined,
        runDir,
        sessionId: input.sessionId,
        skills,
        attributions,
        dispatchedAt: at,
        coverage,
      });
      const piBin = resolvePiBin(env);
      const spawnFn: SpawnLike = deps.spawnFn ?? (spawn as unknown as SpawnLike);
      const child = spawnDetached(spawnFn, piBin, ["-p", "--no-session", "-ns", prompt], {
        cwd: deps.cwd,
        env: { ...env, SKILL_EVOLVE_CHILD: "1" },
        // stdout+stderr 落到 run 目录：子进程怎么死的，只有这份日志答得出来
        logFile: path.join(runDir, CHILD_LOG),
      });

      record.pid = child.pid ?? null;
      await writeRunRecord(runDir, record, deps.queue);
      // 锁的 owner 换成子进程：主进程若先死，owner.pid 指向死进程会让下一个派发把还在跑的 run 当孤儿回收
      writeOwnerSync(deps.evolutionDir, { pid: child.pid ?? process.pid, ts: at, sessionId: input.sessionId }, log);
      deps.telemetry.append({ kind: "dispatched", sessionId: input.sessionId, runId, pid: record.pid, trigger, rounds: coverage?.rounds ?? 1 });
      log(
        `[skill-evolve] 已派生复盘：runId ${runId} pid ${record.pid ?? "未知"}（${piBin}，覆盖 ${coverage?.rounds ?? 1} 轮）`,
      );

      pending.delete(input.sessionId);
      lastDispatchAt.set(input.sessionId, at);
      dispatchCount.set(input.sessionId, (dispatchCount.get(input.sessionId) ?? 0) + 1);
      watchRunChild(child, { runDir, queue: deps.queue, log, onExit: releaseOnce });
      // 同一次派发再起一个独立督导：等 02-proposal.json → 另起评审进程 → 写 03-review.*
      // 开关在这里现读（用户可能中途 review on/off）；关着时由 spawnReviewSupervisor 自己拒绝并记日志
      spawnReviewSupervisor({
        runDir,
        cwd: deps.cwd,
        env,
        reviewModel: deps.reviewModel?.() ?? "inherit",
        spawnFn: deps.supervisorSpawnFn,
        sessionId: input.sessionId, telemetry: deps.telemetry, ...(deps.alive ? { alive: deps.alive } : {}),
        autoReview: deps.config.autoReview,
        log,
      });
      return { status: "dispatched", run: { runId, runDir, pid: record.pid } };
    } catch (error) {
      log(`[skill-evolve] 派生失败：${String(error)}`);
      await releaseOnce();
      return { status: "skipped", why: "lock-error", ownerPid: null };
    }
  };

  const flushPending = (): number => {
    if (pending.size === 0) return 0;
    const at = now();
    const sessions = drainPending(
      pending,
      {
        evolutionDir: deps.evolutionDir,
        cwd: deps.cwd,
        promptTemplatePath: deps.promptTemplatePath,
        maxRuntimeMs: deps.config.maxRuntimeMs,
        autoReview: deps.config.autoReview,
        telemetry: deps.telemetry,
        env,
        spawnFn: deps.spawnFn ?? (spawn as unknown as SpawnLike),
        ...(deps.reviewModel ? { reviewModel: deps.reviewModel } : {}),
        ...(deps.supervisorSpawnFn ? { supervisorSpawnFn: deps.supervisorSpawnFn } : {}),
        ...(deps.alive ? { alive: deps.alive } : {}),
        log,
      },
      at,
    );
    for (const sessionId of sessions) {
      lastDispatchAt.set(sessionId, at);
      dispatchCount.set(sessionId, (dispatchCount.get(sessionId) ?? 0) + 1);
    }
    return sessions.length;
  };

  return { dispatch: run, flushPending };
}
