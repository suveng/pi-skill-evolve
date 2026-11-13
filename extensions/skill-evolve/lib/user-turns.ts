/**
 * 会话轮次门槛（2026-11-13 用户口径）：
 * 「触发复盘 Agent 去复盘会话有前提条件，就是这个会话用户的消息必须要大于 5 条」。
 *
 * 为什么要有这道门槛：一次复盘 = 起一个分析子进程（花 token）。三五句话的会话里几乎没有
 * 「技能没帮上忙」的可归因信号，早派发等于白烧钱。门槛放在**派发之前**，不放在分析内部 ——
 * 钱是在起进程那一刻花出去的。
 *
 * 边界语义：条数 <= 门槛就跳过（口径是「大于 5 条」，等于 5 条不派）。
 */
import fs from "node:fs";

/** 默认门槛：用户消息 > 5 条（第 6 条起才值得复盘） */
export const DEFAULT_MIN_USER_MESSAGES = 5;

/**
 * 从会话 JSONL 文本里数用户消息条数。
 *
 * 认两种写法（pi 落盘的是第一种，历史/导出文件里可能只有第二种）：
 *   {"type":"message","message":{"role":"user",...}}
 *   {"role":"user",...}
 *
 * 坏行（半截 JSON、空行、非对象）直接跳过：会话文件是流式追加产生的，
 * 最后一行常常没写完，不能因为一行坏就判定「不知道」。
 */
export function countUserMessages(raw: string): number {
  let count = 0;
  for (const line of raw.split("\n")) {
    const text = line.trim();
    if (text === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    const record = parsed as Record<string, unknown>;
    const message = record["message"];
    const role = message && typeof message === "object" ? (message as Record<string, unknown>)["role"] : record["role"];
    if (role === "user") count += 1;
  }
  return count;
}

/**
 * 读会话文件数用户消息。
 *
 * 返回 null = 「读不到 / 没有会话文件」，调用方在这种情况**不派发**：
 * 宁可少复盘一次，也不要因为读文件失败而按 0 条处理、跳过一整个真实会话，
 * 更不能因为读不到就当成「条数充足」白花一次 token。
 */
export function readUserMessages(filePath: string | null | undefined): number | null {
  if (!filePath) return null;
  try {
    return countUserMessages(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}
