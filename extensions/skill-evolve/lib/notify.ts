/**
 * 失败 / 待批 / 自动采纳的会话送达（设计稿 14.1「会话内可见」的补丁）。
 *
 * 为什么必须有：用户从飞书进来时没有 TUI，widget 与状态栏一眼都看不到，唯一能看见的是会话消息。
 * 复盘子进程悄悄死掉、评审悄悄通过等人批、auto 悄悄改了技能 —— 这三件事不写进会话，
 * 就等于「静默失败」（见 AGENTS.md 的个人约定第 8 条）。
 *
 * 两条纪律：
 * 1. 一律 `pi.sendMessage`（CustomMessage，不触发新回合），绝不用 `sendUserMessage`
 *    —— 那会让 agent 为一条通知再跑一整轮，烧 token 还打断用户；
 * 2. 同一 run 的同一类事件只发一次：判据落 `runs/<runId>/notified.json`，跨进程重启也认。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { readQueue } from "./queue.ts";
import { listRuns } from "./runs.ts";
import { readRunError, type StaleReason } from "./stale.ts";

export type NotifyKind = "stale" | "pending-approval" | "auto-applied";

export interface NotifyEvent {
  runId: string;
  kind: NotifyKind;
  /** 直接交给 pi.sendMessage 的正文：最多两行，不带 diff */
  text: string;
}

export const NOTIFIED_FILE = "notified.json";
/** 日志末行截断长度：会话消息要短，长尾巴进 run-error.json 看 */
const TAIL_CHARS = 120;

export interface NotifyDeps {
  evolutionDir: string;
  now?: number;
  /** 生产传 `text => pi.sendMessage(...)`；拿不到（老版本 / 无 UI）就不传，只写日志 */
  send?: (text: string) => void;
  log?: (msg: string) => void;
}

const REASON_LABEL: Record<StaleReason, string> = { "child-exited": "子进程已退出", timeout: "超时" };

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

function readNotified(runDir: string): NotifyKind[] {
  const raw = readJson<{ kinds?: unknown }>(path.join(runDir, NOTIFIED_FILE));
  const kinds = Array.isArray(raw?.kinds) ? raw.kinds : [];
  return kinds.filter((kind): kind is NotifyKind => kind === "stale" || kind === "pending-approval" || kind === "auto-applied");
}

function clip(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > TAIL_CHARS ? `${trimmed.slice(0, TAIL_CHARS)}…` : trimmed;
}

/** 三类事件的判定全部只看「已落盘的事实」：队列状态 + run.json 状态，不猜中间态 */
export function collectNotifications(evolutionDir: string): NotifyEvent[] {
  const events: NotifyEvent[] = [];
  const runs = listRuns(evolutionDir, 50);
  const runIds = new Set(runs.map((run) => run.runId));
  for (const run of runs) {
    if (run.status !== "stale") continue;
    const error = readRunError(path.join(evolutionDir, "runs", run.runId));
    const reason = error?.reason ?? "child-exited";
    const tail = error && error.childLogTail.length > 0 ? clip(error.childLogTail[error.childLogTail.length - 1]!) : "";
    events.push({
      runId: run.runId,
      kind: "stale",
      text: `技能复盘失败：${run.runId}（${REASON_LABEL[reason]}）\n日志末行：${tail.length > 0 ? tail : "（子进程没留下输出）"}`,
    });
  }
  for (const item of readQueue(evolutionDir)) {
    // 队列里没有对应 run 目录的条目（手工塞的）不推送：没有证据就没必要打扰用户
    if (!runIds.has(item.runId)) continue;
    if (item.status === "pending" && item.level === "approval") {
      events.push({
        runId: item.runId,
        kind: "pending-approval",
        text: `待批：${item.runId} 改动 ${item.skill || "（未知技能）"}\n/skill-evolve approve ${item.runId}`,
      });
    } else if (item.status === "applied" && item.level === "auto") {
      events.push({
        runId: item.runId,
        kind: "auto-applied",
        text: `已自动采纳：${item.runId}（${item.skill || "未知技能"}）`,
      });
    }
  }
  return events;
}

function writeNotified(runDir: string, kinds: NotifyKind[], at: number, log?: (msg: string) => void): void {
  try {
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, NOTIFIED_FILE), `${JSON.stringify({ kinds, at }, null, 2)}\n`, "utf8");
  } catch (error) {
    // 写不进去只会导致下次重复推送，不该把刷新流程搞挂
    log?.(`[skill-evolve] 记 notified.json 失败（${runDir}）：${String(error)}`);
  }
}

/**
 * 发一遍「还没发过」的事件。返回本次真的发出去的条目（单测靠它断言去重）。
 * `send` 抛错时**不**记 notified：下一轮还能重试，丢通知比重复一次更糟。
 */
export function deliverNotifications(deps: NotifyDeps): NotifyEvent[] {
  const delivered: NotifyEvent[] = [];
  for (const event of collectNotifications(deps.evolutionDir)) {
    const runDir = path.join(deps.evolutionDir, "runs", event.runId);
    const known = readNotified(runDir);
    if (known.includes(event.kind)) continue;
    if (deps.send) {
      try {
        deps.send(event.text);
      } catch (error) {
        deps.log?.(`[skill-evolve] 会话消息发送失败（${event.runId}）：${String(error)}`);
        continue;
      }
    } else {
      // 无 UI / 老版本 pi：降级成日志，行为与「发出去了」等价（不再重试，免得刷日志）
      deps.log?.(`[skill-evolve] ${event.text.replace(/\n/g, " ｜ ")}`);
    }
    writeNotified(runDir, [...known, event.kind], deps.now ?? Date.now(), deps.log);
    delivered.push(event);
  }
  return delivered;
}
