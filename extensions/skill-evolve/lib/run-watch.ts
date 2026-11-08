/**
 * 盯着复盘子进程收尾：非正常退出就把 run 标 abandoned，无论成败都释放全局锁。
 *
 * 单独一个文件是因为 dispatch.ts 已经贴着 300 行闸门，而这段逻辑与派发主流程无耦合：
 * 它只关心「子进程死了没有」，由调用方把释放锁的回调传进来。
 */
import { markRunAbandoned } from "./runs.ts";
import type { SpawnedChild } from "./spawn-plan.ts";
import type { MutationQueue } from "./telemetry.ts";

export interface WatchRunDeps {
  runDir: string;
  queue: MutationQueue;
  log: (msg: string) => void;
  /** 子进程结束（无论成败）后调用：派发方用它释放全局锁 */
  onExit: () => Promise<void>;
}

export function watchRunChild(child: SpawnedChild, deps: WatchRunDeps): void {
  let done = false;
  const finish = (reason: string | null): void => {
    if (done) return;
    done = true;
    void (async () => {
      if (reason) {
        deps.log(`[skill-evolve] 复盘子进程异常退出：${reason}`);
        await markRunAbandoned(deps.runDir, reason, deps.queue, deps.log);
      }
      await deps.onExit();
    })();
  };
  child.once("exit", (code) => finish(code === 0 ? null : `exit ${String(code)}`));
  child.once("error", (error) => finish(`spawn-error: ${String(error)}`));
}
