/**
 * 面板层（设计稿 14.1 的前三层）：实时 widget / 状态栏 / `/tree` 条目。
 *
 * 三条纪律：
 * 1. 没数据就不占位——widget 返回 null 由调用方清空，不显示「0」这种噪音；
 * 2. 状态栏只显示最紧急的一件事，其余一律不挤进去；
 * 3. 这里只读盘算数值，不建定时器、不写文件（刷新时机由 index.ts 决定）。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { isPidAlive } from "./lock.ts";
import { readQueue } from "./queue.ts";
import { listRuns } from "./runs.ts";
import { childGone, classifyStale, type StaleDeps } from "./stale.ts";

/** 回滚率告警线：设计稿 14.2 定的 5%，样本少于 5 次不下结论 */
export const ROLLBACK_ALERT = 0.05;
export const MIN_APPLY_SAMPLES = 5;

/** 进行中的「复盘」：派发出去还没出评审结论的那些 run */
const IN_FLIGHT = new Set(["dispatched", "analyzed", "proposed", "review_failed"]);

export interface PanelState {
  reviewing: number;
  /** 已判定卡死的 run 数（run.json status=stale）：它在状态栏/ widget 上压过「待批」 */
  staleCount: number;
  pendingApprovals: number;
  lastAppliedAt: number | null;
  rollbackRate: number;
  appliedSamples: number;
}

function fileText(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** 采纳时刻取 04-decision.json 的 at；读不到才退回入队时刻（宁可偏早，也不编一个时间） */
function appliedAtOf(evolutionDir: string, runId: string, fallback: number): number {
  const raw = fileText(path.join(evolutionDir, "runs", runId, "04-decision.json"));
  if (raw === null) return fallback;
  try {
    const at = (JSON.parse(raw) as { at?: unknown }).at;
    return typeof at === "number" && Number.isFinite(at) ? at : fallback;
  } catch {
    return fallback;
  }
}

export function collectPanelState(input: {
  evolutionDir: string;
  now?: number;
  /** 单 run 上限（来自配置）：pid 还活着但跑太久也算卡死 */
  maxRuntimeMs?: number;
  /** pid 存活判定，单测注入（默认 kill(pid,0)） */
  alive?: (pid: number) => boolean;
}): PanelState {
  const queue = readQueue(input.evolutionDir);
  const runs = listRuns(input.evolutionDir, 50);
  const now = input.now ?? Date.now();
  const staleDeps: StaleDeps = {};
  if (input.maxRuntimeMs !== undefined) staleDeps.maxRuntimeMs = input.maxRuntimeMs;
  if (input.alive !== undefined) staleDeps.alive = input.alive;
  const aliveOf = input.alive ?? isPidAlive;
  const applied = queue.filter((item) => item.status === "applied");
  const rolledBack = queue.filter((item) => item.status === "rolled-back").length;
  const lastApplied = applied.reduce<{ at: number } | null>((best, item) => {
    const at = appliedAtOf(input.evolutionDir, item.runId, item.createdAt);
    return best === null || at > best.at ? { at } : best;
  }, null);
  return {
    // 只数活着的：子进程死掉的 run 不该继续挂着「复盘 N」，否则面板永远在骗人。
    // dispatched 保留宽限期（刚派发就判死会误报）；analyzed / proposed 已经是「结论写完了」，
    // 进程退出属正常 —— 只有督导还活着（评审中）才算「复盘」，否则 8 条做完的 would-be 复盘
    // 会永远挂在面板头上（2026-11-08 真事：报「复盘中 8」，实际一个进程都没在跑）。
    reviewing: runs.filter((run) => {
      if (!IN_FLIGHT.has(run.status)) return false;
      if (classifyStale(run, now, staleDeps).stale) return false;
      // dispatched 也要看 pid：进程都没了，说「复盘中」就是骗人（与待处理页同一判据）
      if (run.status === "dispatched") {
        return (run.pid !== null && aliveOf(run.pid)) || (run.supervisorPid !== null && aliveOf(run.supervisorPid));
      }
      return (run.pid !== null && aliveOf(run.pid)) || (run.supervisorPid !== null && aliveOf(run.supervisorPid));
    }).length,
    // 已经落成 stale 的 + 判据命中但还没落盘的都要算：只数 run.json 里的 status，会让
    // 「网页说卡死 3、实际列表 4 条」这种自相矛盾的数字漏出去（web 面板只读，不在那里补写盘）
    staleCount: runs.filter(
      (run) => run.status === "stale" || classifyStale(run, now, staleDeps).stale || childGone(run, staleDeps),
    ).length,
    pendingApprovals: queue.filter((item) => item.status === "pending" && item.level === "approval").length,
    lastAppliedAt: lastApplied?.at ?? null,
    rollbackRate: applied.length + rolledBack > 0 ? rolledBack / (applied.length + rolledBack) : 0,
    appliedSamples: applied.length + rolledBack,
  };
}

/** `MM-DD`：面板只有一格宽，不写年份 */
export function shortDate(ts: number): string {
  const date = new Date(ts);
  return `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** widget 内容；全零返回 null（调用方用 undefined 清空，不留一行「复盘 0 / 待批 0」） */
export function panelWidget(state: PanelState): string[] | null {
  const parts: string[] = [];
  if (state.staleCount > 0) parts.push(`复盘失败 ${state.staleCount}`);
  if (state.reviewing > 0) parts.push(`复盘 ${state.reviewing}`);
  if (state.pendingApprovals > 0) parts.push(`待批 ${state.pendingApprovals}`);
  if (state.lastAppliedAt !== null) parts.push(`上次采纳 ${shortDate(state.lastAppliedAt)}`);
  return parts.length > 0 ? [parts.join(" / ")] : null;
}

/** 状态栏：只放最紧急的一件（失败 > 待批 > 回滚率告警），都没有就清空 */
export function statusLine(state: PanelState): string | null {
  if (state.staleCount > 0) return `复盘失败 ${state.staleCount}`;
  if (state.pendingApprovals > 0) return `待批 ${state.pendingApprovals}`;
  if (state.appliedSamples >= MIN_APPLY_SAMPLES && state.rollbackRate > ROLLBACK_ALERT) {
    const percent = (state.rollbackRate * 100).toFixed(0);
    return `回滚率 ${percent}% 超 5%，建议关 auto`;
  }
  return null;
}

/** `/tree` 条目的展示行（数据由 pi.appendEntry 落进会话，不参与 LLM 上下文） */
export interface PanelEntry {
  kind: "dispatched" | "reviewed" | "applied" | "rolled-back" | "stale";
  runId: string;
  detail?: string;
  at: number;
}

const ENTRY_LABEL: Record<PanelEntry["kind"], string> = {
  dispatched: "派发复盘",
  reviewed: "评审结论",
  applied: "采纳",
  "rolled-back": "回滚",
  stale: "卡死",
};

export function entryLines(entry: PanelEntry): string[] {
  const stamp = shortDate(entry.at);
  const detail = entry.detail ? ` · ${entry.detail}` : "";
  return [`[skill-evolve] ${ENTRY_LABEL[entry.kind]} ${entry.runId} · ${stamp}${detail}`];
}

/** 状态变迁 → `/tree` 条目：只认「评审结论 / 采纳 / 回滚」，派发由调用方单独记（它先于 run.json 出现） */
const STATUS_ENTRY: Record<string, PanelEntry["kind"] | undefined> = {
  reviewed: "reviewed",
  rejected: "reviewed",
  review_failed: "reviewed",
  applied: "applied",
  "rolled-back": "rolled-back",
  stale: "stale",
};

/**
 * 把 run 的状态与上次见到的比，产出新条目。`seen` 会被就地更新：
 * 调用方每次刷新传同一份 Map，就能保证一条状态只发一次条目（含重启后的第一轮「补记」）。
 */
export function statusEntries(
  runs: readonly { runId: string; status: string }[],
  seen: Map<string, string>,
  now: number,
): PanelEntry[] {
  const entries: PanelEntry[] = [];
  for (const run of runs) {
    const previous = seen.get(run.runId);
    if (previous === run.status) continue;
    seen.set(run.runId, run.status);
    const kind = STATUS_ENTRY[run.status];
    if (!kind) continue;
    const detail = run.status === kind ? undefined : run.status;
    entries.push({ kind, runId: run.runId, at: now, ...(detail ? { detail } : {}) });
  }
  return entries;
}
