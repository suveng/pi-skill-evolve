/**
 * 「已处理」视图的数据：回滚 / 失败 / 否决 / 被取代这四种终态。
 *
 * 为什么不和「已采纳」混：采纳有自己的页（见 ./applied.ts），两边都收就等于两个 tab 各算一遍。
 * 队列记录会覆盖同一个 runId 的 run.json 版本：它有层级（auto/approval）与失败详情，比只有状态有用。
 */
import type { QueueItem } from "../queue.ts";
import type { RunSummary } from "../runs.ts";
import { asNumber, asText } from "./json-read.ts";
import { sessionForRun, sessionIndex, sessionOfRun, type SessionRef } from "./run-session.ts";

/** 已处理列表上限：网页是「翻最近发生了什么」，不是审计日志（审计看 runs/ 目录本身） */
export const DONE_LIMIT = 50;

export interface DoneItem {
  runId: string;
  status: string;
  /** queue = 采纳队列（有层级与详情）；run = 只有 run.json 的终态（比如 rejected 从未入队） */
  source: "queue" | "run";
  /** 会话信息：行上「会话」列要用（缺 = NO_SESSION） */
  session: SessionRef;
  level: string;
  skill: string;
  at: number | null;
  detail: string;
}

/**
 * 「已处理」收的终态：回滚 / 失败 / 否决 / 被取代。
 * **不含 applied** —— 采纳有自己的页（见 ./applied.ts），两边都收就等于两个 tab 都算一遍。
 */
const DONE_STATUSES = new Set(["rolled-back", "failed", "rejected", "superseded"]);

export function buildDone(items: readonly QueueItem[], runs: readonly RunSummary[], evolutionDir: string): DoneItem[] {
  const byRun = new Map<string, DoneItem>();
  const sessions = sessionIndex(runs);
  for (const run of runs) {
    if (!DONE_STATUSES.has(run.status)) continue;
    byRun.set(run.runId, {
      runId: run.runId,
      status: run.status,
      source: "run",
      session: sessionOfRun(run),
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
      session: sessionForRun(item.runId, sessions, evolutionDir),
      level: item.level,
      skill: item.skill,
      at: asNumber(item.createdAt),
      detail: item.detail ?? "",
    });
  }
  return [...byRun.values()].sort((a, b) => (b.at ?? 0) - (a.at ?? 0)).slice(0, DONE_LIMIT);
}
