/**
 * 派发排队：多个会话几乎同时结束、或上一个复盘还没跑完时，这一轮**不丢**，排进 `dispatch-queue.json`。
 *
 * 为什么要有它：全局单飞闸（一次只跑一个复盘子进程）原本把后来的请求直接记 `skipped: busy` 丢掉，
 * 多开几个会话时最后一个会话的轮次就永远没人复盘（2026-11-13 用户：「应该有多个会话结束，应该要支持排队」）。
 *
 * 语义：
 * - 同一会话反复被挡 → 合并成一条（轮数累加、技能取并集、`since` 保留最早那次），不会一个会话占满队列。
 * - 队列有条数上限（20）：超了就丢最早的，并返回被丢的那条，让调用方能记日志。
 * - 读写都走 `MutationQueue`（跨进程串行），避免主进程与面板进程同时改写。
 */
import * as fs from "node:fs";
import * as path from "node:path";

import type { Attribution } from "./attribution.ts";
import type { DispatchInput } from "./dispatch-types.ts";
import type { MutationQueue } from "./telemetry.ts";

export const DISPATCH_QUEUE_FILE = "dispatch-queue.json";
/** 队列上限：超过就丢最早的（正常情况远到不了，防御的是「会话疯狂结束」的异常场景） */
export const DISPATCH_QUEUE_LIMIT = 20;

export interface QueuedDispatch {
  sessionId: string;
  skills: string[];
  sessionFile?: string;
  attributions?: Attribution[];
  /** 合并了几轮（同一会话被挡几次就累加几次） */
  rounds: number;
  /** 最早一次被挡下的时刻：派发时当作覆盖起点 */
  since: number;
  /** 最近一次请求的时刻（排序用，先到先跑） */
  requestedAt: number;
}

export function dispatchQueueFile(evolutionDir: string): string {
  return path.join(evolutionDir, DISPATCH_QUEUE_FILE);
}

/** 读队列：文件不存在 / 坏 JSON / 结构不对 → 空队列（排队是尽力而为，不能因为它把主流程搞挂） */
export function readDispatchQueue(evolutionDir: string): QueuedDispatch[] {
  let raw = "";
  try {
    raw = fs.readFileSync(dispatchQueueFile(evolutionDir), "utf8");
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((item): item is QueuedDispatch => {
    if (typeof item !== "object" || item === null) return false;
    const row = item as Record<string, unknown>;
    return typeof row.sessionId === "string" && Array.isArray(row.skills);
  });
}

/** 纯函数：把一次被挡下的派发并进队列（同会话合并），返回新队列 */
export function upsertQueued(
  list: readonly QueuedDispatch[],
  input: DispatchInput,
  at: number,
): { queue: QueuedDispatch[]; dropped: QueuedDispatch | null } {
  const existing = list.find((item) => item.sessionId === input.sessionId);
  let next: QueuedDispatch;
  if (existing) {
    const skills = [...existing.skills];
    for (const name of input.skills) if (!skills.includes(name)) skills.push(name);
    next = {
      sessionId: existing.sessionId,
      skills,
      ...(input.sessionFile ?? existing.sessionFile ? { sessionFile: input.sessionFile ?? existing.sessionFile } : {}),
      ...(input.attributions ?? existing.attributions
        ? { attributions: input.attributions ?? existing.attributions }
        : {}),
      rounds: existing.rounds + 1,
      since: existing.since,
      requestedAt: at,
    };
  } else {
    next = {
      sessionId: input.sessionId,
      skills: [...input.skills],
      ...(input.sessionFile ? { sessionFile: input.sessionFile } : {}),
      ...(input.attributions ? { attributions: input.attributions } : {}),
      rounds: 1,
      since: at,
      requestedAt: at,
    };
  }

  const rest = list.filter((item) => item.sessionId !== input.sessionId);
  const queue = [...rest, next].sort((a, b) => a.requestedAt - b.requestedAt);
  if (queue.length <= DISPATCH_QUEUE_LIMIT) return { queue, dropped: null };
  const overflow = queue.length - DISPATCH_QUEUE_LIMIT;
  return { queue: queue.slice(overflow), dropped: queue[overflow - 1] ?? null };
}

/** 纯函数：取队首（最早请求的那条），返回剩下的队列 */
export function takeQueued(list: readonly QueuedDispatch[]): { next: QueuedDispatch | null; rest: QueuedDispatch[] } {
  if (list.length === 0) return { next: null, rest: [] };
  const [next, ...rest] = list;
  return { next: next ?? null, rest };
}

/** 入队（读改写走 MutationQueue，跨进程串行） */
export async function enqueueDispatch(
  evolutionDir: string,
  queue: MutationQueue,
  input: DispatchInput,
  at: number,
  log?: (msg: string) => void,
): Promise<number> {
  let size = 0;
  await queue(dispatchQueueFile(evolutionDir), async () => {
    const { queue: next, dropped } = upsertQueued(readDispatchQueue(evolutionDir), input, at);
    fs.mkdirSync(evolutionDir, { recursive: true });
    fs.writeFileSync(dispatchQueueFile(evolutionDir), `${JSON.stringify(next, null, 2)}\n`, "utf8");
    size = next.length;
    if (dropped) log?.(`[skill-evolve] 派发队列超过 ${DISPATCH_QUEUE_LIMIT} 条，丢弃最早的会话 ${dropped.sessionId}`);
  });
  return size;
}

/** 出队一条（取最早的），返回被取走的那条 */
export async function popDispatch(
  evolutionDir: string,
  queue: MutationQueue,
): Promise<QueuedDispatch | null> {
  let taken: QueuedDispatch | null = null;
  await queue(dispatchQueueFile(evolutionDir), async () => {
    const { next, rest } = takeQueued(readDispatchQueue(evolutionDir));
    taken = next;
    if (next === null) return;
    fs.writeFileSync(dispatchQueueFile(evolutionDir), `${JSON.stringify(rest, null, 2)}\n`, "utf8");
  });
  return taken;
}

/** 出队后又发现跑不了（又忙了 / 被禁用）：原样塞回队首，轮数与时间都不动 —— 不许重复计数 */
export async function restoreDispatch(
  evolutionDir: string,
  queue: MutationQueue,
  item: QueuedDispatch,
): Promise<void> {
  await queue(dispatchQueueFile(evolutionDir), async () => {
    const list = readDispatchQueue(evolutionDir);
    if (list.some((row) => row.sessionId === item.sessionId)) return;
    fs.mkdirSync(evolutionDir, { recursive: true });
    fs.writeFileSync(dispatchQueueFile(evolutionDir), `${JSON.stringify([item, ...list], null, 2)}\n`, "utf8");
  });
}

/** 队列长度（面板显示用，不拿锁、读失败算 0） */
export function queuedDepth(evolutionDir: string): number {
  return readDispatchQueue(evolutionDir).length;
}
