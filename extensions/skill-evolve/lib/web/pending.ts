/**
 * 「待处理」视图的数据：正在跑 / 已判卡死 / 队列待批 / 评审通过但还没入队。
 *
 * 为什么从 data.ts 拆出来：`data.ts` 只留视图形状与聚合入口，四类条目的判定各有各的判据
 * （活 pid、classifyStale、队列层级、run 状态），合在一起必然破 300 行闸门。
 * 纪律不变：只读、坏数据当空（判不了的那一条退化成不出现，绝不整页 500）。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { QueueItem } from "../queue.ts";
import { buildPipeline, renderPipelineLine } from "../pipeline.ts";
import type { RunStatus, RunSummary } from "../runs.ts";
import { CHILD_LOG } from "../spawn-plan.ts";
import { STALE_MS, childGone, classifyStale, readLogTail, readRunError } from "../stale.ts";
import type { WebStateDeps } from "./data.ts";
import { asNumber, asText } from "./json-read.ts";
import { sessionForRun, sessionIndex, sessionOfRun, type SessionRef } from "./run-session.ts";

/** 单 run 默认上限：与 DEFAULT_CONFIG.maxRuntimeMs 同值，面板只用来算「上限 N 分钟」 */
const DEFAULT_MAX_RUNTIME_MS = 20 * 60_000;

function defaultAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // 信号 0 只探测存在性，不真发信号
    return true;
  } catch {
    return false;
  }
}

/** 待处理五来源：正在跑 / 已判卡死 / 队列待批 / 已出结论等评审 / 评审通过等入队 */
export type PendingKind = "running" | "approval" | "stale" | "to-review" | "reviewed";

/**
 * 待处理页收的 run 状态（导出给 test/web-view-coverage.test.ts 做状态覆盖性检查）。
 * running 的判据是 dispatched + pid 还活着，所以 dispatched 算这里收；reviewed 是「等入队」。
 */
export const PENDING_RUN_STATUSES: readonly RunStatus[] = ["dispatched", "analyzed", "proposed", "reviewed", "stale"];

export interface PendingItem {
  runId: string;
  kind: PendingKind;
  /** 这条 run 是哪个会话跑出来的：行上「会话」列要用（缺 = NO_SESSION） */
  session: SessionRef;
  skill: string;
  at: number | null;
  /** 展开后的纯文本（渲染层负责转义） */
  detail: string;
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
  // 五段进度：光写「复盘产出中」看不出是卡在分析还是卡在提案（用户 2026-11-09 的真实困惑）
  const pipeline = renderPipelineLine(
    buildPipeline({
      runDir: path.join(evolutionDir, "runs", run.runId),
      status: run.status,
      pid: run.pid,
      supervisorPid: run.supervisorPid,
      dispatchedAt: run.dispatchedAt,
      alive,
    }),
  );
  return {
    runId: run.runId,
    kind: "running",
    session: sessionOfRun(run),
    skill: run.proposal?.skill ?? "",
    at: run.dispatchedAt,
    detail: [
      `阶段：${reviewing ? "评审中" : "复盘产出中"}`,
      `流水线：${pipeline}`,
      `进程：pid ${run.pid} · 已跑 ${duration(now - (run.dispatchedAt ?? now))}（上限 ${Math.round(maxRuntimeMs / 60_000)} 分钟）`,
      progressLine,
      `日志：tail -f .pi/evolution/runs/${run.runId}/${CHILD_LOG}`,
    ].join("\n"),
  };
}

/** 产物是否存在：判定「这条 run 还有没有下一步」时用，坏路径当不存在 */
function hasFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** 五类条目的展示优先级：正在跑最上头，然后卡死、待批、待评审、待入队 */
const PENDING_RANK: Record<PendingKind, number> = { running: 0, stale: 1, approval: 2, "to-review": 3, reviewed: 4 };

export function buildPending(
  items: readonly QueueItem[],
  runs: readonly RunSummary[],
  evolutionDir: string,
  deps: WebStateDeps = {},
): PendingItem[] {
  const now = deps.now ?? Date.now();
  const alive = deps.alive ?? defaultAlive;
  const maxRuntimeMs = deps.maxRuntimeMs ?? DEFAULT_MAX_RUNTIME_MS;
  const pending: PendingItem[] = [];
  const byRun = sessionIndex(runs);
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
      session: sessionForRun(item.runId, byRun, evolutionDir),
      skill: item.skill,
      at: asNumber(item.createdAt),
      detail: [
        "层级：approval（必须人批，auto 不会替你执行）",
        `目标：${item.targets.join("、") || "（未写 targets）"}`,
        item.detail ? `备注：${item.detail}` : "",
        `操作：去「待落盘」页（?view=approvals）直接点批准 / 拒绝，也可以在这里回 TUI 敲 /skill-evolve approve ${item.runId}`,
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
    const verdict = classifyStale(run, now);
    // 子进程没了就一定会列出来，哪怕还没到 5 分钟收口窗口：
    // 否则会出现「头顶写复盘中 1、列表一条都没有」——那条 run 的 pid 已经死了，不会再有下一步
    const gone = childGone(run);
    if (!persisted && !verdict.stale && !gone) continue;
    const error = readRunError(path.join(evolutionDir, "runs", run.runId));
    const tail = error?.childLogTail ?? [];
    const lastLine = tail.length > 0 ? tail[tail.length - 1]!.trim() : "";
    pending.push({
      runId: run.runId,
      kind: "stale",
      session: sessionOfRun(run),
      skill: run.proposal?.skill ?? "",
      at: error?.at ?? run.dispatchedAt,
      detail: [
        `原因：${
          error?.reason === "timeout"
            ? "超时（子进程还活着但超过单 run 上限）"
            : gone && !verdict.stale
              ? `子进程已退出（还没到 ${Math.round(STALE_MS / 60_000)} 分钟收口窗口，督导会补写 stale）`
              : "子进程已退出"
        }`,
        lastLine.length > 0 ? `日志末行：${lastLine}` : "日志末行：（子进程没留下任何输出）",
        `排查：cat ${path.join(evolutionDir, "runs", run.runId, "run-error.json")}`,
        "不会自动重跑：需要重新复盘就 /skill-evolve run",
      ].join("\n"),
    });
  }
  // ④ 子进程已产出结论、提案还没评审的：不是失败（子进程本来就该退出），属于「等下一轮接上」。
  //    但只有**真有提案**才需要接着走：分析完判定「不该改」的 run（没有 02-proposal.json 也没有
  //    run.json 里的 proposal 摘要）是终态，挂「待评审」只会在待处理页永久占位 ——
  //    用户 2026-11-09 七条记录全在待处理：「终态为什么还在待处理下」。
  for (const run of runs) {
    if (run.status !== "analyzed" && run.status !== "proposed") continue;
    if (run.proposal === undefined && !hasFile(path.join(evolutionDir, "runs", run.runId, "02-proposal.json"))) continue;
    pending.push({
      runId: run.runId,
      kind: "to-review",
      session: sessionOfRun(run),
      skill: run.proposal?.skill ?? "",
      at: run.dispatchedAt,
      detail: [
        `状态：已出结论（${run.status}）且提案已在，评审还没跑`,
        "会自动接上：下次 settle 或 session_start 重挂督导；想立即接上就 /skill-evolve run",
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
      session: sessionOfRun(run),
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
