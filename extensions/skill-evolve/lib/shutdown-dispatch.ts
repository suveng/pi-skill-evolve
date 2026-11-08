/**
 * 退出前补发：`session_shutdown` 里把还没派发的轮次再试一次。
 *
 * 为什么单独一个文件：这条路径全部是**同步** fs + 同步 spawn —— 主进程马上就要退出，
 * 用异步队列很可能写完进程就没了（设计稿「静默失败」原则：命令返回成功 ≠ 真的落盘）。
 * 代价是这几步会阻塞退出几十毫秒，所以只在真的还有待复盘轮次时才走。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { Attribution } from "./attribution.ts";
import { acquireLockSync, releaseLockSync, writeOwnerSync } from "./lock.ts";
import { buildPrompt, readPromptTemplateSync } from "./prompt.ts";
import { spawnReviewSupervisor, type SupervisorSpawn } from "./review-spawn.ts";
import { guardBusy } from "./single-flight.ts";
import { CHILD_LOG, uniqueRunId, sessionHashOf, resolvePiBin, spawnDetached, type SpawnLike } from "./spawn-plan.ts";
import { writeRunRecordSync, type RunRecord } from "./runs.ts";
import { writeSessionIndexSync } from "./session-index.ts";
import type { TelemetryWriter } from "./telemetry.ts";

/** 待复盘的轮次（去抖期间累计，退出时补发一次） */
export interface PendingRounds {
  sessionId: string;
  /** 待复盘区间的起点：第一次被去抖掉的时刻 */
  since: number;
  /** 合并了几轮（superseded 的次数） */
  rounds: number;
  skills: string[];
  sessionFile?: string;
  /** 已经机械归因过的技能（A~E），多轮合并时去重 */
  attributions?: Attribution[];
}

export interface ShutdownDeps {
  evolutionDir: string;
  cwd: string;
  promptTemplatePath: string;
  maxRuntimeMs: number;
  telemetry: TelemetryWriter;
  env: NodeJS.ProcessEnv;
  spawnFn: SpawnLike;
  /** 评审模型（"inherit" 或 provider/model），退出补发这条路径同样要起督导 */
  reviewModel?: string;
  supervisorSpawnFn?: SupervisorSpawn;
  /** pid 存活判定（全局单飞闸用；单测注入，测试里不起真子进程） */
  alive?: (pid: number) => boolean;
  log: (msg: string) => void;
}

export type ShutdownResult = "dispatched" | "skipped" | "failed";

/** 同步补发一次：任何异常都在内部吞掉，绝不阻塞退出、绝不抛给调用方 */
export function flushPendingSync(item: PendingRounds, deps: ShutdownDeps, now: number): ShutdownResult {
  // 全局单飞：退出补发也不能叠进程（已有活的复盘 / 督导就放弃本次，不建目录不抢锁）
  const occupant = guardBusy({
    evolutionDir: deps.evolutionDir,
    sessionId: item.sessionId,
    telemetry: deps.telemetry,
    sync: true,
    trigger: "shutdown",
    rounds: item.rounds,
    ...(deps.alive ? { alive: deps.alive } : {}),
    log: deps.log,
  });
  if (occupant) return "skipped";

  const runId = uniqueRunId(deps.evolutionDir, item.sessionId, now);
  const runDir = path.join(deps.evolutionDir, "runs", runId);
  const lock = acquireLockSync({
    evolutionDir: deps.evolutionDir,
    owner: { pid: process.pid, ts: now, sessionId: item.sessionId },
    maxRuntimeMs: deps.maxRuntimeMs,
    log: deps.log,
    now: () => now,
  });
  if (!lock.ok) {
    deps.telemetry.appendSync({
      kind: "skipped",
      ts: now,
      sessionId: item.sessionId,
      why: lock.why === "error" ? "lock-error" : "lock",
      trigger: "shutdown",
      ownerPid: lock.owner?.pid ?? null,
      rounds: item.rounds,
    });
    deps.log(`[skill-evolve] 退出补发放弃：锁被占用（pid ${lock.owner?.pid ?? "未知"}）`);
    return "skipped";
  }

  let childPid: number | null = null;
  try {
    const indexDir = path.join(runDir, "00-session");
    const indexFile = path.join(indexDir, "index.json");
    let evidenceMode: RunRecord["evidenceMode"] = "telemetry-only";
    if (item.sessionFile && writeSessionIndexSync({ sessionFile: item.sessionFile, outDir: indexDir, log: deps.log })) {
      evidenceMode = "session+telemetry";
    }

    const record: RunRecord = {
      runId,
      status: "dispatched",
      trigger: "shutdown",
      sessionId: item.sessionId,
      sessionHash: sessionHashOf(item.sessionId),
      sessionFile: item.sessionFile ?? null,
      evidenceMode,
      dispatchedAt: now,
      dispatchedAtIso: new Date(now).toISOString(),
      pid: null,
      cwd: deps.cwd,
      skills: [...item.skills],
      coverage: { rounds: item.rounds, since: item.since },
      stages: [{ name: "dispatch", model: null, usage: null, ms: 0 }],
      artifacts: evidenceMode === "session+telemetry" ? { "00-session/index.json": indexFile } : {},
    };
    writeRunRecordSync(runDir, record);

    const prompt = buildPrompt({
      template: readPromptTemplateSync(deps.promptTemplatePath, deps.log),
      sessionFile: item.sessionFile,
      indexFile: evidenceMode === "session+telemetry" ? indexFile : undefined,
      runDir,
      sessionId: item.sessionId,
      skills: item.skills,
      attributions: item.attributions,
      dispatchedAt: now,
      coverage: record.coverage,
    });
    const child = spawnDetached(deps.spawnFn, resolvePiBin(deps.env), ["-p", "--no-session", "-ns", prompt], {
      cwd: deps.cwd,
      env: { ...deps.env, SKILL_EVOLVE_CHILD: "1" },
      // 退出前补发这条路径最容易“静默失败”：日志落盘才知道子进程到底起没起来
      logFile: path.join(runDir, CHILD_LOG),
    });
    childPid = child.pid ?? null;

    record.pid = childPid;
    writeRunRecordSync(runDir, record);
    // 锁的 owner 换成子进程：主进程退出后 owner.pid 若指向死进程，下一次派发会把正在跑的 run 当孤儿回收
    writeOwnerSync(deps.evolutionDir, { pid: childPid ?? process.pid, ts: now, sessionId: item.sessionId }, deps.log);
    deps.telemetry.appendSync({
      kind: "dispatched",
      ts: now,
      sessionId: item.sessionId,
      runId,
      pid: childPid,
      trigger: "shutdown",
      rounds: item.rounds,
    });
    deps.log(`[skill-evolve] 退出前补发复盘：runId ${runId} pid ${childPid ?? "未知"}（合并 ${item.rounds} 轮）`);
    spawnReviewSupervisor({
      runDir,
      cwd: deps.cwd,
      env: deps.env,
      reviewModel: deps.reviewModel ?? "inherit",
      spawnFn: deps.supervisorSpawnFn,
      sessionId: item.sessionId,
      telemetry: deps.telemetry,
      sync: true,
      ...(deps.alive ? { alive: deps.alive } : {}),
      log: deps.log,
    });
    return "dispatched";
  } catch (error) {
    deps.log(`[skill-evolve] 退出补发失败：${String(error)}`);
    // 子进程已经起来了就留着锁（它自己跑完会死，下一次按死 pid 回收）；没起来必须放锁
    if (childPid === null) releaseLockSync(deps.evolutionDir, deps.log);
    try {
      const record = JSON.parse(fs.readFileSync(path.join(runDir, "run.json"), "utf8")) as RunRecord;
      record.status = "abandoned";
      record.abandonedReason = `shutdown-dispatch: ${String(error)}`;
      writeRunRecordSync(runDir, record);
    } catch {
      // run.json 本身都写不进去：日志已经记过，到此为止
    }
    return "failed";
  }
}
