/**
 * 采纳队列：`.pi/evolution/queue.json`（运行态，不入库）。
 *
 * 为什么要有队列而不是评审完立刻写盘：评审督导是独立 node 进程、没有 withFileMutationQueue
 * （闸2 只能在 pi 运行时里用）。督导只写 03-review.json，把「可采纳」排进队列；扩展在
 * session_start 与 settle 时扫队列并执行，所以主会话退出也不会丢。
 *
 * superseded 规则：同一个 skill 已经有更早的 pending 时，新条目直接标 superseded ——
 * 否则两次改动会落到同一文件上，谁先谁后都不对。要采纳新的，先把旧的处理掉。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { ActionLevel } from "./classify-action.ts";
import type { MutationQueue } from "./telemetry.ts";

export type QueueStatus = "pending" | "applied" | "rolled-back" | "failed" | "superseded" | "rejected";

export interface QueueItem {
  runId: string;
  level: ActionLevel;
  skill: string;
  /** 相对仓库根的路径（.pi/skills/… / .cursor/skills/… / AGENTS.md） */
  targets: string[];
  createdAt: number;
  status: QueueStatus;
  proposalType?: string;
  detail?: string;
  /** 被哪条更早的 pending 顶掉（superseded 专用）：面板据此给「换成这份」的按钮 */
  supersededBy?: string;
  /** 自动评审关着时入队的条目：run 没有 03-review.json，等人工 `/skill-evolve approve`（待落盘页可见） */
  reviewSkipped?: boolean;
}

export const QUEUE_FILE = "queue.json";
const LEVELS: readonly ActionLevel[] = ["auto", "approval", "forbidden"];
// rejected 是人主动否掉（网页点「拒绝」/TUI），与 superseded（被更早的 pending 顶掉）不是一回事
const STATUSES: readonly QueueStatus[] = ["pending", "applied", "rolled-back", "failed", "superseded", "rejected"];

export function queueFile(evolutionDir: string): string {
  return path.join(evolutionDir, QUEUE_FILE);
}

function isItem(raw: unknown): raw is QueueItem {
  if (typeof raw !== "object" || raw === null) return false;
  const item = raw as Record<string, unknown>;
  return (
    typeof item.runId === "string" &&
    typeof item.skill === "string" &&
    LEVELS.includes(item.level as ActionLevel) &&
    STATUSES.includes(item.status as QueueStatus)
  );
}

/** 读队列：文件缺 / JSON 坏 / 单条字段不合规都只丢那一条，绝不让命令挂掉 */
export function readQueue(evolutionDir: string): QueueItem[] {
  try {
    const raw = JSON.parse(fs.readFileSync(queueFile(evolutionDir), "utf8")) as unknown;
    return Array.isArray(raw) ? raw.filter(isItem) : [];
  } catch {
    return [];
  }
}

function writeJson(evolutionDir: string, items: readonly QueueItem[]): void {
  fs.mkdirSync(evolutionDir, { recursive: true });
  fs.writeFileSync(queueFile(evolutionDir), `${JSON.stringify(items, null, 2)}\n`, "utf8");
}

export interface QueueDeps {
  evolutionDir: string;
  queue: MutationQueue;
  now?: () => number;
}

export interface EnqueueResult {
  item: QueueItem;
  /** 新条目被更早的 pending 顶掉时给出对方 runId */
  supersededBy?: string;
}

/** 入队（幂等：同一个 runId 已存在就直接返回原条目） */
export async function enqueue(
  deps: QueueDeps,
  input: Omit<QueueItem, "createdAt" | "status">,
): Promise<EnqueueResult> {
  const now = deps.now ?? (() => Date.now());
  let result: EnqueueResult | undefined;
  await deps.queue(queueFile(deps.evolutionDir), async () => {
    // 队列内重读：并发入队时后写的一方不会用旧快照覆盖前一方
    const items = readQueue(deps.evolutionDir);
    const existing = items.find((item) => item.runId === input.runId);
    if (existing) {
      result = { item: existing };
      return;
    }
    const older = items.find((item) => item.skill === input.skill && item.status === "pending");
    const item: QueueItem = {
      ...input,
      createdAt: now(),
      status: older ? "superseded" : "pending",
      ...(older ? { detail: `同一技能已有更早的 pending：${older.runId}`, supersededBy: older.runId } : {}),
    };
    items.push(item);
    writeJson(deps.evolutionDir, items);
    result = older ? { item, supersededBy: older.runId } : { item };
  });
  if (!result) throw new Error("入队失败：队列写回调未返回结果");
  return result;
}

/** 取待办（按入队时间升序；给 level 就只看该级） */
export function takePending(items: readonly QueueItem[], level?: ActionLevel): QueueItem[] {
  return items
    .filter((item) => item.status === "pending" && (level === undefined || item.level === level))
    .sort((a, b) => a.createdAt - b.createdAt);
}

export function findItem(items: readonly QueueItem[], runId: string): QueueItem | undefined {
  return items.find((item) => item.runId === runId);
}

/** 把被顶掉的条目换成真正生效的那份：旧 pending 让位，新条目接管 */
export async function replacePending(
  deps: QueueDeps,
  newRunId: string,
): Promise<{ ok: true; replaced: string } | { ok: false; detail: string }> {
  let result: { ok: true; replaced: string } | { ok: false; detail: string } = {
    ok: false,
    detail: "队列写回调未返回结果",
  };
  await deps.queue(queueFile(deps.evolutionDir), async () => {
    const items = readQueue(deps.evolutionDir);
    const fresh = items.find((item) => item.runId === newRunId);
    if (!fresh) {
      result = { ok: false, detail: `队列里没有 ${newRunId}` };
      return;
    }
    if (fresh.status !== "superseded") {
      result = { ok: false, detail: `${newRunId} 当前是 ${fresh.status}，只有 superseded 能替换` };
      return;
    }
    const older =
      items.find((item) => item.runId === fresh.supersededBy) ??
      items.find((item) => item.runId !== fresh.runId && item.status === "pending" && item.skill === fresh.skill);
    if (!older) {
      result = { ok: false, detail: `找不到被顶掉的 ${fresh.supersededBy ?? "旧条目"}（可能已被处理）` };
      return;
    }
    older.status = "superseded";
    older.detail = `被更新的提案 ${newRunId} 取代`;
    older.supersededBy = newRunId;
    fresh.status = "pending";
    delete fresh.supersededBy;
    delete fresh.detail;
    writeJson(deps.evolutionDir, items);
    result = { ok: true, replaced: older.runId };
  });
  return result;
}

/** 改某条状态；返回是否找到了该 runId（命令据此区分「没有这条」与「已处理」） */
export async function markDone(
  deps: QueueDeps,
  runId: string,
  status: QueueStatus,
  detail?: string,
): Promise<boolean> {
  let found = false;
  await deps.queue(queueFile(deps.evolutionDir), async () => {
    const items = readQueue(deps.evolutionDir);
    const target = items.find((item) => item.runId === runId);
    if (!target) return;
    found = true;
    target.status = status;
    if (detail) target.detail = detail;
    writeJson(deps.evolutionDir, items);
  });
  return found;
}
