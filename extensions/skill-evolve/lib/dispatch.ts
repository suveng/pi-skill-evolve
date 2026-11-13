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
import { mergeRoundIntoRun } from "./aggregate.ts";
import { mergeAttributions } from "./attribution.ts";
import { acquireLock, releaseLock, writeOwnerSync } from "./lock.ts";
import { buildPrompt, readPromptTemplateSync } from "./prompt.ts";
import { writeRunRecord } from "./runs.ts";
import { writeSessionIndex } from "./session-index.ts";
import { agentSessionFlags, CHILD_LOG, childEnvOf, isExecutableFile, resolvePiBin, spawnDetached, uniqueRunId, sessionHashOf } from "./spawn-plan.ts";
import { mergePendingRounds } from "./pending.ts";
import { watchRunChild } from "./run-watch.ts";
import { spawnReviewSupervisor } from "./review-spawn.ts";
import { readSessionMtime, readUserMessages } from "./user-turns.ts";
import { guardBusy } from "./single-flight.ts";
import { DISPATCH_QUEUE_LIMIT, enqueueDispatch, popDispatch, restoreDispatch } from "./dispatch-queue.ts";
import { drainPending } from "./drain-pending.ts";
import type { PendingRounds } from "./shutdown-dispatch.ts";
import type { DispatchDeps, DispatchInput, DispatchOptions, DispatchOutcome } from "./dispatch-types.ts";

// 类型都搬到了 ./dispatch-types.ts（本文件贴着 300 行闸门），这里原样再导出，调用方路径不变
export type { DispatchInput, DispatchDeps, DispatchedRun, DispatchOutcome, DispatchOptions } from "./dispatch-types.ts";

/**
 * 静默窗口还剩多少毫秒（<=0 表示静默够了，可以派发）。
 *
 * `lastActivity` 为 null（拿不到会话文件 / 文件被删）时返回 0 —— 不知道就别拦，
 * 让既有的「上次派发 + idleMs」去抖兜住，避免把手动触发和没有会话文件的路径永久卡住。
 */
export function idleRemaining(lastActivity: number | null, now: number, idleMs: number): number {
  if (lastActivity === null) return 0;
  return idleMs - (now - lastActivity);
}

/** 去抖：窗口内又结束一轮，只更新 pending，不再叠加进程 */
export function shouldDebounce(lastDispatchAt: number | undefined, now: number, idleMs: number): boolean {
  return typeof lastDispatchAt === "number" && now - lastDispatchAt < idleMs;
}

export interface Dispatcher {
  dispatch(input: DispatchInput, options?: DispatchOptions): Promise<DispatchOutcome>;
  /** 退出前同步补发所有 pending，返回真正派发成功的条数；任何失败都不抛 */
  flushPending(): number;
  /**
   * 把排队中的派发往下推：队首那条派出去，派成功再接着推下一条，遇到忙就停下。
   * 返回这一轮真正派出去的条数。子进程退出、以及每次结算都会调它。
   */
  drain(): Promise<number>;
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

  /**
   * 并入在途复盘的这一轮：不建 run、不抢锁、不起进程，只把轮数累加进那条 run 的 coverage。
   * 手动 `/skill-evolve run` 也走这道检查 —— 「立刻复盘」不该变成「同一会话并行两条」。
   */
  const tryMerge = (input: DispatchInput, at: number): DispatchOutcome | null => {
    const result = mergeRoundIntoRun({
      evolutionDir: deps.evolutionDir,
      sessionId: input.sessionId,
      // 本轮 + 之前被去抖挡下、还没派出去的轮次
      rounds: (pending.get(input.sessionId)?.rounds ?? 0) + 1,
      now: at,
      telemetry: deps.telemetry,
      log,
      ...(deps.alive ? { isAlive: deps.alive } : {}),
    });
    if (result === null) return null;
    pending.delete(input.sessionId);
    return { status: "merged", runId: result.runId, rounds: result.rounds };
  };

  const run = async (input: DispatchInput, options: DispatchOptions = {}): Promise<DispatchOutcome> => {
    const at = now();
    const bypass = options.bypassThrottle === true;
    const trigger: RunRecord["trigger"] = options.trigger ?? (bypass ? "manual" : "auto");

    if (!deps.config.enabled) {
      deps.telemetry.append({ kind: "skipped", sessionId: input.sessionId, why: "disabled", trigger });
      return { status: "skipped", why: "disabled", ownerPid: null };
    }

    // 轮次门槛（2026-11-13 用户口径）：用户消息 **大于** minUserMessages 才值得花一次复盘 token。
    // 放在起进程之前 —— 钱是起进程那一刻花掉的。手动 `run --now` 跳过这道闸（人明确要求就看）。
    if (!bypass) {
      const min = deps.config.minUserMessages;
      const turns = readUserMessages(input.sessionFile);
      // 没有会话文件 = 数不了轮次：这种情况放行（面板手动触发、无会话的历史轨迹都走这里），
      // 但文件在、能读时就必须数清楚 —— 读不到当 0 条会白白放过一个长会话。
      if (turns !== null && turns <= min) {
        deps.telemetry.append({ kind: "skipped", sessionId: input.sessionId, why: "too-few-turns", turns, min, trigger });
        log(`[skill-evolve] 跳过派生：本轮用户消息 ${turns} 条，未超过门槛 ${min} 条`);
        return { status: "skipped", why: "too-few-turns", ownerPid: null };
      }
      if (turns === null && input.sessionFile) {
        log(`[skill-evolve] 读不到会话文件（${input.sessionFile}），轮次门槛不生效，按原流程派发`);
      }
    }

    // 必红自检没过就别再产出提案：评审器不可信时，继续派发只是在制造假结论
    if (deps.selftestFailed?.() === true) {
      deps.telemetry.append({ kind: "skipped", sessionId: input.sessionId, why: "selftest-failed", trigger });
      log("[skill-evolve] 跳过派生：必红自检未通过（评审器不可信，流水线停用）");
      return { status: "skipped", why: "selftest-failed", ownerPid: null };
    }

    if (!bypass) {
      // 静默判据（2026-11-13 用户口径）：以**会话最后一次活动**（会话文件 mtime）为起算点，
      // 静默满 idleMs 才开始复盘。不到点就先攒着，并挂一个定时器到点自动补发 ——
      // 否则「会话说完就散了、再也没有下一个结算点」的会话永远等不到复盘。
      if (options.fromIdleTimer !== true) {
        const mtime = readSessionMtime(input.sessionFile);
        const remain = idleRemaining(mtime, at, deps.config.idleMs);
        if (remain > 0) {
          const carried = mergePending(input, at);
          deps.telemetry.append({
            kind: "superseded",
            sessionId: input.sessionId,
            lastDispatchAt: lastDispatchAt.get(input.sessionId) ?? 0,
            idleMs: deps.config.idleMs,
            rounds: carried.rounds,
          });
          scheduleIdle(input, remain);
          log(
            `[skill-evolve] 静默窗口未满：会话最后活动在 ${Math.round((at - (mtime ?? at)) / 1000)}s 前，` +
              `还要等 ${Math.round(remain / 1000)}s（已累计 ${carried.rounds} 轮）`,
          );
          return { status: "superseded", rounds: carried.rounds };
        }
      }
      const last = lastDispatchAt.get(input.sessionId);
      if (options.fromIdleTimer !== true && shouldDebounce(last, at, deps.config.idleMs)) {
        const carried = mergePending(input, at);
        deps.telemetry.append({
          kind: "superseded",
          sessionId: input.sessionId,
          lastDispatchAt: last ?? 0,
          idleMs: deps.config.idleMs,
          rounds: carried.rounds,
        });
        scheduleIdle(input, deps.config.idleMs);
        log(`[skill-evolve] 去抖：并入待复盘区间（已累计 ${carried.rounds} 轮，静默窗口过后补一次）`);
        return { status: "superseded", rounds: carried.rounds };
      }
      const used = dispatchCount.get(input.sessionId) ?? 0;
      if (used >= deps.config.perSessionCap) {
        deps.telemetry.append({ kind: "skipped", sessionId: input.sessionId, why: "cap", cap: deps.config.perSessionCap });
        return { status: "skipped", why: "cap", ownerPid: null };
      }
    }

    // 同会话聚合：已有在途复盘就把这一轮并进去（放单飞闸之前 —— 单飞闸只会回一句 busy 然后丢掉这一轮）
    const merged = tryMerge(input, at);
    if (merged) return merged;

    // 全局单飞（跨会话也成立）：已有复盘或督导在跑这一轮就不叠进程；放去抖 / 上限之后，那两条是「本轮不派」的既定语义
    const occupant = guardBusy({ evolutionDir: deps.evolutionDir, sessionId: input.sessionId, telemetry: deps.telemetry, trigger, alive: deps.alive, log });
    if (occupant) {
      // 排队而不是丢掉：多开几个会话同时结束是常态，丢了就永远没人复盘这一轮（2026-11-13 用户要求）
      const depth = await enqueueDispatch(deps.evolutionDir, deps.queue, input, at, log);
      log(`[skill-evolve] 已有复盘子进程在跑（pid ${occupant.pid}）：本轮排队第 ${depth} 位，跑完自动接上`);
      return { status: "queued", sessionId: input.sessionId, depth };
    }

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
      // 先验 pi 真的可执行：spawn 的 ENOENT 是**异步** emit 的，早于收尸 listener 挂载，
      // 会把整个 pi 进程 uncaughtException 打死（2026-11-09 写死路径事故）。宁可不派，也不炸宿主。
      // 注入了 spawnFn = 单测/嵌入式宿主，路径由调用方自负，这里不做磁盘校验。
      const piBin = resolvePiBin(env);
      if (!deps.spawnFn && !isExecutableFile(piBin)) {
        log(`[skill-evolve] 未派生：找不到可执行的 pi（${piBin}）。设 SKILL_EVOLVE_PI_BIN 或先装好 pi`);
        deps.telemetry.append({
          kind: "skipped",
          sessionId: input.sessionId,
          why: "pi-not-found",
          ownerPid: lock.owner?.pid ?? null,
          trigger,
        });
        await releaseOnce();
        return { status: "skipped", why: "pi-not-found", ownerPid: lock.owner?.pid ?? null };
      }

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
      const spawnFn: SpawnLike = deps.spawnFn ?? (spawn as unknown as SpawnLike);
      const child = spawnDetached(spawnFn, piBin, ["-p", ...agentSessionFlags(runDir, "analyze"), prompt], {
        cwd: deps.cwd,
        env: childEnvOf(env),
        // stdout+stderr 落到 run 目录：子进程怎么死的，只有这份日志答得出来
        logFile: path.join(runDir, CHILD_LOG),
      });
      // 兜底 listener：spawn 仍可能失败（权限、架构不匹配），没 listener 的 error 事件在 Node 里
      // 会直接抛成 uncaughtException。真正的收尸仍由 watchRunChild 负责，这里只保证不炸宿主。
      child.once("error", (error) => {
        log(`[skill-evolve] 复盘子进程启动失败：${String(error)}`);
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
      watchRunChild(child, {
        runDir,
        queue: deps.queue,
        log,
        // 子进程收尾：先解锁，再把排队中的派发推一条 ── 否则排队的轮次要等到下一次会话结束才动
        onExit: () => {
          void releaseOnce()
            .then(() => drainQueued())
            .catch((error: unknown) => log(`[skill-evolve] 排队推进失败：${String(error)}`));
        },
      });
      // 同一次派发再起一个独立督导：等 02-proposal.json → 另起评审进程 → 写 03-review.*
      // 开关在这里现读（用户可能中途 review on/off）；关着时由 spawnReviewSupervisor 自己拒绝并记日志
      spawnReviewSupervisor({
        runDir,
        cwd: deps.cwd,
        env,
        reviewModel: deps.reviewModel?.() ?? "inherit",
        maxRewrites: deps.config.maxRewrites,
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

  // ---- 静默定时器 ----
  /** 每个会话最多一个待触发的静默定时器；新活动来了就重置 */
  const idleTimers = new Map<string, ReturnType<typeof setTimeout>>();

  function cancelIdle(sessionId: string): void {
    const timer = idleTimers.get(sessionId);
    if (timer === undefined) return;
    clearTimeout(timer);
    idleTimers.delete(sessionId);
  }

  /** 到点补发：用原始输入再走一次 run()，跳过静默判据（这一刻静默确实满了） */
  function scheduleIdle(input: DispatchInput, waitMs: number): void {
    cancelIdle(input.sessionId);
    const timer = setTimeout(() => {
      idleTimers.delete(input.sessionId);
      void run(input, { trigger: "auto", fromIdleTimer: true }).catch((error: unknown) => {
        log(`[skill-evolve] 静默补发失败：${String(error)}`);
      });
    }, Math.max(1000, waitMs));
    // 不能因为挂了个定时器就把宿主进程钉住 —— pi 该退就退
    timer.unref?.();
    idleTimers.set(input.sessionId, timer);
  }

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
        // 注入了 spawnFn = 单测/嵌入式宿主：路径由调用方自负，退出补发也不做磁盘校验
        ...(deps.spawnFn ? { piBinExists: () => true } : {}),
        log,
      },
      at,
    );
    for (const sessionId of sessions) {
      cancelIdle(sessionId);
      lastDispatchAt.set(sessionId, at);
      dispatchCount.set(sessionId, (dispatchCount.get(sessionId) ?? 0) + 1);
    }
    return sessions.length;
  };

  /**
   * 推队列：队首派得出去就接着推下一条；遇到「又忙了 / 被禁用」就把它原样放回队首并停下。
   * 循环上限 DISPATCH_QUEUE_LIMIT 次，防御异常情况下的死循环。
   */
  const drainQueued = async (): Promise<number> => {
    let done = 0;
    for (let guard = 0; guard < DISPATCH_QUEUE_LIMIT + 1; guard += 1) {
      const next = await popDispatch(deps.evolutionDir, deps.queue);
      if (next === null) return done;
      const outcome = await run(
        {
          sessionId: next.sessionId,
          skills: next.skills,
          ...(next.sessionFile ? { sessionFile: next.sessionFile } : {}),
          ...(next.attributions ? { attributions: next.attributions } : {}),
        },
        { bypassThrottle: true, trigger: "auto" },
      );
      if (outcome.status === "dispatched") {
        done += 1;
        log(`[skill-evolve] 排队派发：会话 ${next.sessionId} 已接上（覆盖 ${next.rounds} 轮）`);
        continue;
      }
      // 并入在途复盘也算处理完：那一轮的轮次已经被 mergeRoundIntoRun 记进 coverage
      if (outcome.status === "merged") continue;
      await restoreDispatch(deps.evolutionDir, deps.queue, next);
      const why = outcome.status === "skipped" ? outcome.why : outcome.status;
      log(`[skill-evolve] 排队派发未成功（${why}）：会话 ${next.sessionId} 放回队首，等下一次`);
      return done;
    }
    return done;
  };

  return { dispatch: run, flushPending, drain: drainQueued };
}
