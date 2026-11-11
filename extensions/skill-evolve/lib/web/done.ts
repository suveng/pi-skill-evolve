/**
 * 「已处理」视图的数据：回滚 / 失败 / 否决 / 被取代 / 评审失败 / 已放弃 / 越权写入这七种终态。
 *
 * 为什么不和「已采纳」混：采纳有自己的页（见 ./applied.ts），两边都收就等于两个 tab 各算一遍。
 * 队列记录会覆盖同一个 runId 的 run.json 版本：它有层级（auto/approval）与失败详情，比只有状态有用。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { QueueItem } from "../queue.ts";
import type { RunStatus, RunSummary } from "../runs.ts";
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
 * 「已处理」收的终态：回滚 / 失败 / 否决 / 被取代，以及过去漏收的评审失败 / 已放弃 / 越权写入。
 * **不含 applied** —— 采纳有自己的页（见 ./applied.ts），两边都收就等于两个 tab 都算一遍。
 *
 * 导出成数组是为了「状态覆盖性」测试（test/web-view-coverage.test.ts）：
 * 新增一个 run 状态却没有任何视图收它，那类 run 会在面板上直接消失、只能翻目录 ——
 * review_failed / abandoned / unauthorized_write 就是这么丢的，所以这个清单必须可被测试读取。
 */
export const DONE_STATUSES: readonly RunStatus[] = [
  "rolled-back",
  "failed",
  "rejected",
  "superseded",
  "review_failed",
  "abandoned",
  "unauthorized_write",
];

const DONE_STATUS_SET = new Set<string>(DONE_STATUSES);

/**
 * 「分析判定不需要改」的 run 落在这一页：`analyzed` 且**没有** 02-proposal.json。
 * 它是终态（不会再生提案），以前挂在「复盘报告」页 —— 那个页 2026-11-10 删了之后，
 * 这类 run 一度在任何 tab 里都看不到（实测 2026-11-11）。
 */
export const ANALYZED_NO_PROPOSAL = "analyzed";

/** 默认判据：磁盘上有没有 02-proposal.json（单测可以注入） */
function defaultHasProposal(evolutionDir: string): (runId: string) => boolean {
  return (runId) => fs.existsSync(path.join(evolutionDir, "runs", runId, "02-proposal.json"));
}

export function buildDone(
  items: readonly QueueItem[],
  runs: readonly RunSummary[],
  evolutionDir: string,
  hasProposal: (runId: string) => boolean = defaultHasProposal(evolutionDir),
): DoneItem[] {
  const byRun = new Map<string, DoneItem>();
  const sessions = sessionIndex(runs);
  for (const run of runs) {
    const terminal = DONE_STATUS_SET.has(run.status);
    const analyzedNoProposal = run.status === ANALYZED_NO_PROPOSAL && !hasProposal(run.runId);
    if (!terminal && !analyzedNoProposal) continue;
    byRun.set(run.runId, {
      runId: run.runId,
      status: run.status,
      source: "run",
      session: sessionOfRun(run),
      level: asText(run.review?.action, "-"),
      skill: run.proposal?.skill ?? "",
      at: run.dispatchedAt,
      detail: analyzedNoProposal
        ? "分析判定不需要改（没有 02-proposal.json，终态）"
        : run.review?.verdict
          ? `评审：${run.review.verdict}`
          : "",
    });
  }
  // 队列记录覆盖同 runId：它有层级（auto/approval）与失败详情，比 run.json 只有状态有用
  for (const item of items) {
    if (!DONE_STATUS_SET.has(item.status)) continue;
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
