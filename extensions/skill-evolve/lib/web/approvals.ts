/**
 * 「待落盘」视图的数据：收所有 `status === "pending"` 的队列条目，不分 level。
 *
 * 为什么不按 level 过滤（2026-11-11 用户实测踩到）：`autoApply=false` 时 auto 级提案永远没人执行，
 * 但界面上「待审批」写 0、列表里也看不到它们 —— 只剩顶部一行「N 条 auto 提案待人工」的黄字，
 * 人点不进去、批不了。层级只影响「要不要人点」，不影响「能不能在面板上看见并点」。
 *
 * 为什么不复用 pending 视图的条目：待处理页混了正在跑 / 卡死 / 待入队，那一页是「现在发生了什么」；
 * 待落盘页要能直接点按钮，所以每条必须自带批与不批所需的最小事实 ——
 * 改了哪个文件（targets）、改了多少行（proposal）、评审怎么说（verdict + blocking 条数）。
 *
 * 纪律与 data.ts 相同：只读、坏数据当空、绝不因为一条烂 run.json 让整页 500。
 */
import * as path from "node:path";
import type { QueueItem } from "../queue.ts";
import { readProposalSummary } from "../proposal.ts";
import type { RunStatus } from "../runs.ts";
import { asNumber, asText, readJson } from "./json-read.ts";
import { readRunSession, type SessionRef } from "./run-session.ts";

/**
 * 待落盘页对应的 run 状态（导出给覆盖性测试）：条目靠队列条件选（status=pending），
 * 能进队列就说明提案与评审都已写过，所以这里只能是 reviewed。
 */
export const APPROVALS_RUN_STATUSES: readonly RunStatus[] = ["reviewed"];

export interface ApprovalItem {
  runId: string;
  /** 这条 run 是哪个会话跑出来的：行上「会话」列要用（缺 = NO_SESSION） */
  session: SessionRef;
  skill: string;
  level: string;
  /** 相对仓库根的落盘目标（队列里就存着，不重算） */
  targets: string[];
  createdAt: number | null;
  /** 提案摘要：类型与增删行数（读不到 02-proposal.json 就是 null） */
  proposal: { type: string; added: number; removed: number } | null;
  /** 评审结论：verdict 与 blocking 条数（读不到 03-review.json 就是 null） */
  review: { verdict: string | null; blocking: number } | null;
  /** 队列里记的备注（入队时写的层级理由等） */
  detail: string;
}

function readReview(runDir: string): ApprovalItem["review"] {
  const raw = readJson<Record<string, unknown>>(path.join(runDir, "03-review.json"));
  if (!raw) return null;
  return {
    verdict: typeof raw.verdict === "string" ? raw.verdict : null,
    blocking: Array.isArray(raw.blocking) ? raw.blocking.length : 0,
  };
}

/** 待落盘条目：auto 级在自动采纳开着时会被 session_start / settle 跑掉，关着时同样等人点 */
export function buildApprovals(evolutionDir: string, items: readonly QueueItem[]): ApprovalItem[] {
  return items
    .filter((item) => item.status === "pending")
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((item) => {
      const runDir = path.join(evolutionDir, "runs", item.runId);
      const summary = readProposalSummary(runDir);
      return {
        runId: item.runId,
        session: readRunSession(runDir),
        skill: item.skill,
        level: item.level,
        targets: item.targets,
        createdAt: asNumber(item.createdAt),
        proposal: summary ? { type: summary.type, added: summary.added, removed: summary.removed } : null,
        review: readReview(runDir),
        detail: asText(item.detail),
      };
    });
}
