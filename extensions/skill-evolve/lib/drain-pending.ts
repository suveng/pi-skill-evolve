/**
 * 把「待复盘区间」一次性补发干净（dispatch 的 flushPending 只留状态更新）。
 *
 * 为什么单独一个文件：`dispatch.ts` 已经贴着 300 行闸门，而这段是**独立职责** ——
 * 它只管遍历 pending 映射、逐条走同步补发、无论成败都把条目摘掉；
 * 派发成功后的「上次派发时刻 / 本会话已派次数」属于 dispatch 自己的状态，用返回值交回去。
 *
 * 任何异常都不许冒出来：这条路径的调用方是退出钩子，抛出去等于把退出流程也弄坏。
 */
import { flushPendingSync, type PendingRounds, type ShutdownResult } from "./shutdown-dispatch.ts";
import type { SupervisorSpawn } from "./review-spawn.ts";
import type { SpawnLike } from "./spawn-plan.ts";
import type { TelemetryWriter } from "./telemetry.ts";

export interface DrainPendingOptions {
  evolutionDir: string;
  cwd: string;
  promptTemplatePath: string;
  maxRuntimeMs: number;
  /** 自动评审开关（配置现读）：关着时补发照跑，但不起督导 */
  autoReview: boolean;
  telemetry: TelemetryWriter;
  env: NodeJS.ProcessEnv;
  spawnFn: SpawnLike;
  /** 每个会话现算一次的评审模型（"inherit" 或 provider/model） */
  reviewModel?: () => string;
  supervisorSpawnFn?: SupervisorSpawn;
  alive?: (pid: number) => boolean;
  log: (msg: string) => void;
}

/** 返回这次真的派发成功的 sessionId（按 pending 的遍历顺序） */
export function drainPending(pending: Map<string, PendingRounds>, options: DrainPendingOptions, at: number): string[] {
  const dispatched: string[] = [];
  for (const item of [...pending.values()]) {
    let result: ShutdownResult = "failed";
    try {
      result = flushPendingSync(
        item,
        {
          evolutionDir: options.evolutionDir,
          cwd: options.cwd,
          promptTemplatePath: options.promptTemplatePath,
          maxRuntimeMs: options.maxRuntimeMs,
          telemetry: options.telemetry,
          env: options.env,
          spawnFn: options.spawnFn,
          autoReview: options.autoReview,
          ...(options.reviewModel ? { reviewModel: options.reviewModel() } : {}),
          ...(options.supervisorSpawnFn ? { supervisorSpawnFn: options.supervisorSpawnFn } : {}),
          ...(options.alive ? { alive: options.alive } : {}),
          log: options.log,
        },
        at,
      );
    } catch (error) {
      // flushPendingSync 自己已 try/catch；这里再兜一层，退出路径不允许抛
      options.log(`[skill-evolve] 退出补发失败：${String(error)}`);
    }
    if (result === "dispatched") dispatched.push(item.sessionId);
    // 退出是最后一次机会：无论成败都从这里清掉，避免 shutdown 被调用两次时重复派发
    pending.delete(item.sessionId);
  }
  return dispatched;
}
