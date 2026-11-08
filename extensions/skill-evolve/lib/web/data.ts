/**
 * 只读 Web 面板的数据聚合：把 `.pi/evolution/` 的散落文件拼成三个视图要的形状。
 *
 * 三条纪律：
 * 1. **只读**：这里不写盘、不开监听、不改任何状态 —— 面板永远不能变成第二个写入方；
 * 2. **坏数据当空**：run.json / 队列 / 各类产出一律可能「写到一半被 kill」，任何字段缺失都退化成
 *    null / []，绝不因为一条烂记录让整页 500（用户从飞书点进来只想要个概览）；
 * 3. **数字不重算**：summary 直接复用 collectPanelState，和 TUI 状态栏同一口径 ——
 *    两处各算一套，迟早出现「TUI 说待批 2、网页说待批 3」。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { collectPanelState } from "../panel.ts";
import { readQueue, type QueueItem } from "../queue.ts";
import { listRuns, type RunSummary } from "../runs.ts";
import { CHILD_LOG } from "../spawn-plan.ts";
import { classifyStale, readLogTail } from "../stale.ts";
import { readRunError } from "../stale.ts";
import { asNumber, asText } from "./json-read.ts";
import { buildApplied, type AppliedItem } from "./applied.ts";
import { buildApprovals, type ApprovalItem } from "./approvals.ts";
import { buildReports, type RunReport } from "./reports.ts";

export { MAX_FINDING_ROWS } from "./reports.ts";
export type { FindingRow, RunReport } from "./reports.ts";
export type { ApprovalItem } from "./approvals.ts";
export type { AppliedItem } from "./applied.ts";

/** 列表页（技能管理页 `skills` 与两个详情页 `run` / `skill` 不在这个联合里，见 filter.ts 的 PANEL_VIEWS） */
export const WEB_VIEWS = ["pending", "approvals", "applied", "done", "reports"] as const;
export type WebView = (typeof WEB_VIEWS)[number];

/** 已处理列表上限：网页是「翻最近发生了什么」，不是审计日志（审计看 runs/ 目录本身） */
export const DONE_LIMIT = 50;
/** 扫描最近多少个 run：卡死 / 待入队这类判断只需要看近期，runs/ 里可能有几百个历史目录 */
const SCAN_LIMIT = 100;

/** 单 run 默认上限：与 DEFAULT_CONFIG.maxRuntimeMs 同值，面板只用来算「上限 N 分钟」 */
const DEFAULT_MAX_RUNTIME_MS = 20 * 60_000;

/** 待处理四来源：正在跑 / 已判卡死 / 队列待批 / 评审通过但还没入队 */
export type PendingKind = "running" | "approval" | "stale" | "reviewed";

export interface PendingItem {
  runId: string;
  kind: PendingKind;
  skill: string;
  at: number | null;
  /** 展开后的纯文本（渲染层负责转义） */
  detail: string;
}

export interface DoneItem {
  runId: string;
  status: string;
  /** queue = 采纳队列（有层级与详情）；run = 只有 run.json 的终态（比如 rejected 从未入队） */
  source: "queue" | "run";
  level: string;
  skill: string;
  at: number | null;
  detail: string;
}

export interface WebSummary {
  reviewing: number;
  stale: number;
  pendingApprovals: number;
  appliedTotal: number;
  rollbackRate: number;
}

export interface WebState {
  pending: PendingItem[];
  /** 待审批：只收 pending + approval 级，带按钮所需的最小事实（见 ./approvals.ts） */
  approvals: ApprovalItem[];
  /** 已采纳：只收队列 applied，且**不再**进 done（两个 tab 不许混） */
  applied: AppliedItem[];
  done: DoneItem[];
  reports: RunReport[];
  summary: WebSummary;
}

export interface WebStateDeps {
  /** 现时（单测注入固定时钟） */
  now?: number;
  /** pid 存活判定（默认 process.kill(pid,0)；单测注入，测试里不起真进程） */
  alive?: (pid: number) => boolean;
  /** 单 run 上限（毫秒），只用于「上限 N 分钟」那一行 */
  maxRuntimeMs?: number;
}

function defaultAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // 信号 0 只探测存在性，不真发信号
    return true;
  } catch {
    return false;
  }
}

/** 把毫秒压成「Xm Ys」：面板上人只关心量级，不关心毫秒 */
function duration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}m ${total % 60}s`;
}

/**
 * 「正在跑」那一条：光看 `复盘 1` 这个数字不知道是谁、跑到哪、要不要杀，
 * 所以把阶段 / 进程 / 最近输出 / 看日志的命令四行摊开（用户 2026-11-08：「复盘中我也想看到状态呢」）。
 */
function runningItem(
  run: RunSummary,
  evolutionDir: string,
  now: number,
  alive: (pid: number) => boolean,
  maxRuntimeMs: number,
): PendingItem | null {
  if (run.status !== "dispatched" || run.pid === null || !alive(run.pid)) return null;
  const reviewing = run.supervisorPid !== null && alive(run.supervisorPid);
  const logPath = path.join(evolutionDir, "runs", run.runId, CHILD_LOG);
  let mtime: number | null = null;
  try {
    mtime = fs.statSync(logPath).mtimeMs; // 拿不到就是还没写过日志
  } catch {
    mtime = null;
  }
  const tail = readLogTail(logPath, 1);
  const lastLine = tail.length > 0 ? tail[tail.length - 1]!.trim() : "";
  const progressLine =
    mtime === null
      ? "最近输出：（还没有输出）"
      : `最近输出：${Math.max(0, Math.round((now - mtime) / 1000))}s 前 · 末行：${lastLine.length > 0 ? lastLine : "（还没有输出）"}`;
  return {
    runId: run.runId,
    kind: "running",
    skill: run.proposal?.skill ?? "",
    at: run.dispatchedAt,
    detail: [
      `阶段：${reviewing ? "评审中" : "复盘产出中"}`,
      `进程：pid ${run.pid} · 已跑 ${duration(now - (run.dispatchedAt ?? now))}（上限 ${Math.round(maxRuntimeMs / 60_000)} 分钟）`,
      progressLine,
      `日志：tail -f .pi/evolution/runs/${run.runId}/${CHILD_LOG}`,
    ].join("\n"),
  };
}

/** 四类条目的展示优先级：正在跑最上头，然后卡死、待批、待入队 */
const PENDING_RANK: Record<PendingKind, number> = { running: 0, stale: 1, approval: 2, reviewed: 3 };

function buildPending(
  items: readonly QueueItem[],
  runs: readonly RunSummary[],
  evolutionDir: string,
  deps: WebStateDeps = {},
): PendingItem[] {
  const now = deps.now ?? Date.now();
  const alive = deps.alive ?? defaultAlive;
  const maxRuntimeMs = deps.maxRuntimeMs ?? DEFAULT_MAX_RUNTIME_MS;
  const pending: PendingItem[] = [];
  // ⓪ 正在跑的：有活 pid 就是「进行中」，先列出来（它不是等批也不是失败）
  const running = new Set<string>();
  for (const run of runs) {
    const item = runningItem(run, evolutionDir, now, alive, maxRuntimeMs);
    if (!item) continue;
    running.add(run.runId);
    pending.push(item);
  }
  // ① 队列里待人批的（approval 级；auto 级不需要人，出现 pending 只是还没轮到执行）
  for (const item of items) {
    if (item.status !== "pending" || item.level !== "approval") continue;
    pending.push({
      runId: item.runId,
      kind: "approval",
      skill: item.skill,
      at: asNumber(item.createdAt),
      detail: [
        "层级：approval（必须人批，auto 不会替你执行）",
        `目标：${item.targets.join("、") || "（未写 targets）"}`,
        item.detail ? `备注：${item.detail}` : "",
        `操作：去「待审批」页（?view=approvals）直接点批准 / 拒绝，也可以在这里回 TUI 敲 /skill-evolve approve ${item.runId}`,
      ]
        .filter((line) => line.length > 0)
        .join("\n"),
    });
  }
  // ② 已判定卡死的 run：它是「失败」而不是「等批」，单独一类，别混进待批数字里。
  //    这里必须包含「判据命中、run.json 还没落盘」的那一批：顶部 summary.stale 用的是
  //    collectPanelState 的同一口径，少一类就会出现「头顶说卡死 5、列表只有 3 条」。
  for (const run of runs) {
    if (running.has(run.runId)) continue; // 同一个 run 不能既「进行中」又「卡死」
    const persisted = run.status === "stale";
    if (!persisted && !classifyStale(run, now).stale) continue;
    const error = readRunError(path.join(evolutionDir, "runs", run.runId));
    const tail = error?.childLogTail ?? [];
    const lastLine = tail.length > 0 ? tail[tail.length - 1]!.trim() : "";
    pending.push({
      runId: run.runId,
      kind: "stale",
      skill: run.proposal?.skill ?? "",
      at: error?.at ?? run.dispatchedAt,
      detail: [
        `原因：${error?.reason === "timeout" ? "超时（子进程还活着但超过单 run 上限）" : "子进程已退出"}`,
        lastLine.length > 0 ? `日志末行：${lastLine}` : "日志末行：（子进程没留下任何输出）",
        `排查：cat ${path.join(evolutionDir, "runs", run.runId, "run-error.json")}`,
        "不会自动重跑：需要重新复盘就 /skill-evolve run",
      ].join("\n"),
    });
  }
  // ④ 子进程已产出结论、评审还没跑的：不是失败（子进程本来就该退出），属于「等下一轮接上」
  for (const run of runs) {
    if (run.status !== "analyzed" && run.status !== "proposed") continue;
    pending.push({
      runId: run.runId,
      kind: "reviewed",
      skill: run.proposal?.skill ?? "",
      at: run.dispatchedAt,
      detail: [
        `状态：已出结论（${run.status}），评审还没跑`,
        "会自动接上：下次 settle 或 session_start 继续；想立即接上就 /skill-evolve run",
        `证据：cat ${path.join(evolutionDir, "runs", run.runId, "01-findings.json")}`,
      ].join("\n"),
    });
  }
  // ③ 评审通过但还没进队列（入队发生在 settle / session_start，中间可能还没轮到）
  const queued = new Set(items.map((item) => item.runId));
  for (const run of runs) {
    if (run.status !== "reviewed" || queued.has(run.runId)) continue;
    pending.push({
      runId: run.runId,
      kind: "reviewed",
      skill: run.proposal?.skill ?? "",
      at: run.dispatchedAt,
      detail: [
        `评审：${asText(run.review?.verdict, "（未写 verdict）")} · 建议动作 ${asText(run.review?.action, "无")}`,
        "状态：评审已通过，尚未入队（settle / session_start 会自动补）",
        `兜底：/skill-evolve approve ${run.runId}`,
      ].join("\n"),
    });
  }
  return pending.sort((a, b) => PENDING_RANK[a.kind] - PENDING_RANK[b.kind] || (b.at ?? 0) - (a.at ?? 0));
}

/**
 * 「已处理」收的终态：回滚 / 失败 / 否决 / 被取代。
 * **不含 applied** —— 采纳有自己的页（见 ./applied.ts），两边都收就等于两个 tab 都算一遍。
 */
const DONE_STATUSES = new Set(["rolled-back", "failed", "rejected", "superseded"]);

function buildDone(items: readonly QueueItem[], runs: readonly RunSummary[]): DoneItem[] {
  const byRun = new Map<string, DoneItem>();
  for (const run of runs) {
    if (!DONE_STATUSES.has(run.status)) continue;
    byRun.set(run.runId, {
      runId: run.runId,
      status: run.status,
      source: "run",
      level: asText(run.review?.action, "-"),
      skill: run.proposal?.skill ?? "",
      at: run.dispatchedAt,
      detail: run.review?.verdict ? `评审：${run.review.verdict}` : "",
    });
  }
  // 队列记录覆盖同 runId：它有层级（auto/approval）与失败详情，比 run.json 只有状态有用
  for (const item of items) {
    if (!DONE_STATUSES.has(item.status)) continue;
    byRun.set(item.runId, {
      runId: item.runId,
      status: item.status,
      source: "queue",
      level: item.level,
      skill: item.skill,
      at: asNumber(item.createdAt),
      detail: item.detail ?? "",
    });
  }
  return [...byRun.values()].sort((a, b) => (b.at ?? 0) - (a.at ?? 0)).slice(0, DONE_LIMIT);
}

export function collectWebState(input: { evolutionDir: string } & WebStateDeps): WebState {
  const { evolutionDir, ...deps } = input;
  const items = readQueue(evolutionDir);
  const runs = listRuns(evolutionDir, SCAN_LIMIT);
  const panel = collectPanelState({ evolutionDir });
  return {
    pending: buildPending(items, runs, evolutionDir, deps),
    approvals: buildApprovals(evolutionDir, items),
    applied: buildApplied(items, evolutionDir),
    done: buildDone(items, runs),
    reports: buildReports(evolutionDir, runs),
    summary: {
      reviewing: panel.reviewing,
      stale: panel.staleCount,
      pendingApprovals: panel.pendingApprovals,
      appliedTotal: items.filter((item) => item.status === "applied").length,
      rollbackRate: panel.rollbackRate,
    },
  };
}
