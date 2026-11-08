/**
 * run ↔ 会话的对应关系：面板每一行都要能回答「这条复盘是哪个会话跑出来的」。
 *
 * 为什么需要（用户 2026-11-08：「面板展示的也应该是 pi sessionId 否则我都不知道怎么看对应会话」）：
 * 原来行上只有 `runId`（会话哈希8 + 时间戳），对着 TUI 里的 sessionId 完全对不上号，
 * 想回去看那段对话只能自己到 `~/.pi/agent/sessions/` 里翻。
 *
 * 纪律与 data.ts 一致：只读、坏记录当空（`sessionId` 缺失就当 null，绝不因为缺字段让整页 500）。
 * 本文件只管**数据**，链接与列渲染在 render-rows.ts（渲染层）。
 */
import * as path from "node:path";
import type { RunSummary } from "../runs.ts";
import { asText, readJson } from "./json-read.ts";

export interface SessionRef {
  /** pi 的 sessionId（UUID），缺失 = null */
  sessionId: string | null;
  /** 会话原文 .jsonl 的绝对路径（pi 写 run.json 时就带上了），缺失 = null */
  sessionFile: string | null;
}

export const NO_SESSION: SessionRef = { sessionId: null, sessionFile: null };

/** 从已解析的 run.json 里取会话信息（空白串当缺失：不能让它变成一个空链接） */
export function sessionFromRecord(raw: unknown): SessionRef {
  if (typeof raw !== "object" || raw === null) return NO_SESSION;
  const record = raw as Record<string, unknown>;
  const sessionId = asText(record.sessionId).trim();
  const sessionFile = asText(record.sessionFile).trim();
  return {
    sessionId: sessionId.length > 0 ? sessionId : null,
    sessionFile: sessionFile.length > 0 ? sessionFile : null,
  };
}

/** 读一条 run 的会话信息；run.json 读不到 / 坏掉都返回 NO_SESSION */
export function readRunSession(runDir: string): SessionRef {
  return sessionFromRecord(readJson<Record<string, unknown>>(path.join(runDir, "run.json")));
}

/** RunSummary → 会话信息（列表页「会话」列的数据源） */
export function sessionOfRun(run: Pick<RunSummary, "sessionId" | "sessionFile">): SessionRef {
  return { sessionId: run.sessionId.length > 0 ? run.sessionId : null, sessionFile: run.sessionFile };
}

/** runId → 会话信息：队列条目没有会话字段，只能按 runId 回推到 runs 里查 */
export function sessionIndex(runs: readonly Pick<RunSummary, "runId" | "sessionId" | "sessionFile">[]): Map<string, SessionRef> {
  return new Map(runs.map((run) => [run.runId, sessionOfRun(run)]));
}

/** 队列条目 → 会话信息；索引里没有它就现读一次 run.json（读不到 = NO_SESSION，链接不渲染） */
export function sessionForRun(runId: string, index: Map<string, SessionRef>, evolutionDir: string): SessionRef {
  return index.get(runId) ?? readRunSession(path.join(evolutionDir, "runs", runId));
}

/** `?view=session` 页的链接：sessionId 必有，文件路径可缺（缺了由服务端反查） */
export function sessionHref(session: SessionRef): string | null {
  if (session.sessionId === null) return null;
  const query = new URLSearchParams({ view: "session", sessionId: session.sessionId });
  if (session.sessionFile !== null) query.set("file", session.sessionFile);
  return `/?${query.toString()}`;
}
