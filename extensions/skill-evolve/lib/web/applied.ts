/**
 * 「已采纳」列表的数据：队列里 `status="applied"` 的条目 + 提案摘要 + 五闸结果。
 *
 * 为什么单独一个文件：「已采纳」是用户要反复回看的一页（改了什么、五闸过没过、什么时候落的地），
 * 它的字段比其它列表都多（提案类型 / 行数 / 采纳时刻 / 逐闸结果），塞回 data.ts 会把那个文件推过 300 行。
 *
 * 只读：读 02-proposal.json、04-decision.json、06-verify.json，一个都不写。
 */
import * as path from "node:path";
import { readVerify } from "../apply.ts";
import { readProposalSummary } from "../proposal.ts";
import type { QueueItem } from "../queue.ts";
import { asNumber, asText, readJson } from "./json-read.ts";
import { readRunSession, type SessionRef } from "./run-session.ts";

/** 已采纳列表上限：与 DONE_LIMIT 同量级 —— 网页看近期，不是审计日志 */
export const APPLIED_LIMIT = 50;

/** 一个已采纳条目：技能 · 提案类型 · +N/-M · 采纳时间 · 五闸是否全 ok */
export interface AppliedItem {
  runId: string;
  /** 这条 run 是哪个会话跑出来的：行上「会话」列要用（缺 = NO_SESSION） */
  session: SessionRef;
  /** auto（不需要人） / approval（人批） */
  level: string;
  skill: string;
  /** 提案类型：improve / create / merge / prune；读不到 02-proposal.json 时写「—」 */
  type: string;
  added: number;
  removed: number;
  /** 采纳时间：取 04-decision.json 的 at（队列 createdAt 是入队时刻），读不到退回入队时刻 */
  appliedAt: number | null;
  /** 五闸逐条（06-verify.json）；没有记录就是空数组 */
  gates: { gate: string; name: string; ok: boolean }[];
  /** 五闸是否全 ok；null = 没有 06-verify.json（判不了，不能显示成失败） */
  gatesOk: boolean | null;
}

/**
 * 采纳时刻为什么取 04-decision.json 而不是队列 createdAt：
 * 队列 createdAt 是**入队**时刻（可能比批准早几小时），用户看「已采纳」要看的是技能文件真正落地的时刻。
 */
export function buildApplied(items: readonly QueueItem[], evolutionDir: string): AppliedItem[] {
  const rows: AppliedItem[] = [];
  for (const item of items) {
    if (item.status !== "applied") continue;
    const runDir = path.join(evolutionDir, "runs", item.runId);
    const proposal = readProposalSummary(runDir);
    const verify = readVerify(runDir);
    const decision = readJson<Record<string, unknown>>(path.join(runDir, "04-decision.json"));
    const gates = Array.isArray(verify?.gates)
      ? verify.gates.map((gate) => ({ gate: asText(gate.gate), name: asText(gate.name), ok: gate.ok === true }))
      : [];
    rows.push({
      runId: item.runId,
      session: readRunSession(runDir),
      level: item.level,
      skill: item.skill.length > 0 ? item.skill : (proposal?.skill ?? ""),
      type: proposal?.type ?? asText(item.proposalType, "—"),
      added: proposal?.added ?? 0,
      removed: proposal?.removed ?? 0,
      appliedAt: asNumber(decision?.at) ?? asNumber(item.createdAt),
      gates,
      gatesOk: verify ? gates.every((gate) => gate.ok) : null,
    });
  }
  return rows.sort((a, b) => (b.appliedAt ?? 0) - (a.appliedAt ?? 0)).slice(0, APPLIED_LIMIT);
}
