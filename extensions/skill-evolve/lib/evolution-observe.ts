/**
 * 可观测层（设计稿 14 章）的胶水：面板刷新 + 状态变迁转 `/tree` 条目 + 周报与指标落盘。
 *
 * 与采集/门禁隔开的原因：这里只读盘、算数、出文本，既不写技能文件也不派发进程，
 * 单测与 evolution.test.ts 都能直接喂假目录。
 */
import { appendMetrics, buildMetrics, type MetricsRun } from "./metrics.ts";
import { collectPanelState, statusEntries, type PanelEntry, type PanelState } from "./panel.ts";
import { listRuns } from "./runs.ts";
import { scanStaleRuns } from "./stale.ts";
import { readEvents, type MutationQueue } from "./telemetry.ts";
import { createWeeklyReport } from "./weekly.ts";

/** 面板渲染交给 index.ts（widget / status / appendEntry 都是 pi 的能力）；这里只往外抛数据 */
export interface PanelDeps {
  onEntry?: (entry: PanelEntry) => void;
  onState?: (state: PanelState) => void;
}

export interface ObserverDeps {
  cwd: string;
  evolutionDir: string;
  telemetryDir: string;
  queue: MutationQueue;
  now: () => number;
  /** 单 run 上限（来自配置）：pid 还活着但跑超过它也算卡死 */
  maxRuntimeMs?: number;
  panel?: PanelDeps;
}

export interface Observer {
  /** settle / session_start / approve 之后调：顺带把新出现的状态变迁发成条目 */
  refresh(): PanelState;
  /** 派发成功时立刻记一条（此时 run.json 刚写，下一轮 refresh 才能看到） */
  noteDispatched(runId: string): void;
  /** `/skill-evolve report --week` */
  weekReportText(): Promise<string>;
}

export const METRICS_WINDOW_DAYS = 28;

export function createObserver(deps: ObserverDeps): Observer {
  const panelDeps = deps.panel ?? {};
  // 进程内记忆「上次见到的状态」：一条状态只发一次条目，不因反复刷新重复刷屏
  const seen = new Map<string, string>();

  const refresh: Observer["refresh"] = () => {
    const now = deps.now();
    // 先扫盘再算数：子进程已死的 run 在这里落成 stale，否则面板会永远显示「复盘 N」
    const limit = deps.maxRuntimeMs === undefined ? {} : { maxRuntimeMs: deps.maxRuntimeMs };
    scanStaleRuns(deps.evolutionDir, now, limit);
    const state = collectPanelState({ evolutionDir: deps.evolutionDir, now, ...limit });
    for (const entry of statusEntries(listRuns(deps.evolutionDir, 20), seen, now)) panelDeps.onEntry?.(entry);
    panelDeps.onState?.(state);
    return state;
  };

  const noteDispatched: Observer["noteDispatched"] = (runId) => {
    seen.set(runId, "dispatched");
    panelDeps.onEntry?.({ kind: "dispatched", runId, at: deps.now() });
    refresh();
  };

  /** 指标落盘：按周聚合后逐行 append，同 week 已有就跳过（appendMetrics 内部去重） */
  const weekReportText: Observer["weekReportText"] = async () => {
    const now = deps.now();
    const events = readEvents(deps.telemetryDir, METRICS_WINDOW_DAYS, now);
    const runs: MetricsRun[] = listRuns(deps.evolutionDir, 50).map((run) => ({
      runId: run.runId,
      status: run.status,
      dispatchedAt: run.dispatchedAt,
    }));
    const report = createWeeklyReport({ cwd: deps.cwd, evolutionDir: deps.evolutionDir, telemetryDir: deps.telemetryDir, now: deps.now });
    const text = report.weekText();
    for (const row of buildMetrics(events, now, runs)) {
      await appendMetrics(deps.evolutionDir, row, deps.queue);
    }
    return text;
  };

  return { refresh, noteDispatched, weekReportText };
}
