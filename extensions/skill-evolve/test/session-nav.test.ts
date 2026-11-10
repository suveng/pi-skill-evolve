/**
 * 会话页快速导航（用户 2026-11-08：「会话缺少快速导航，一直往下滚动太累了」）的验收测试。
 *
 * 口径：目录与锚点由**服务端一次遍历**产出（不引 JS，不做滚动高亮）；
 * 宽屏左侧常驻、窄屏顶部折叠是同一份 HTML 的两种 CSS，所以两处内容必须一模一样。
 *
 * 纪律：`SessionSource` 一律由本文件现造的 JSONL 解析而来，不读真实 sessions 目录。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import type { WebState } from "../lib/web/data.ts";
import { renderSessionPage } from "../lib/web/render-session.ts";
import { parseSessionText } from "../lib/web/session-view.ts";
import type { SessionSource } from "../lib/web/session-file.ts";

const SID = "01a1b90f-08c3-722c-871d-d024b083770a";
const FILE = `/tmp/${SID}.jsonl`;

function line(record: unknown): string {
  return `${JSON.stringify(record)}\n`;
}

function user(text: string, at: number): string {
  return line({
    type: "message",
    timestamp: new Date(at).toISOString(),
    message: { role: "user", content: [{ type: "text", text }] },
  });
}

function assistant(text: string, calls: { id: string; name: string; arguments?: unknown }[] = []): string {
  const content: unknown[] = [];
  if (text.length > 0) content.push({ type: "text", text });
  for (const call of calls) content.push({ type: "toolCall", id: call.id, name: call.name, arguments: call.arguments ?? {} });
  return line({ type: "message", message: { role: "assistant", content } });
}

function result(toolCallId: string, text: string): string {
  return line({
    type: "message",
    message: { role: "toolResult", toolCallId, toolName: "read", content: [{ type: "text", text }] },
  });
}

/** 三条用户消息 + 两段工具调用（够测导航、锚点与「只看对话」） */
function jsonl(): string {
  const t = (hour: number, minute: number) => new Date(2026, 10, 8, hour, minute).getTime();
  return (
    user("第一段：先看列表页", t(10, 32)) +
    assistant("", [{ id: "c1", name: "read", arguments: { path: "render.ts" } }]) +
    result("c1", "ok") +
    user("第二段：再改样式", t(11, 5)) +
    assistant("", [
      { id: "c2", name: "bash", arguments: { command: "npm test" } },
      { id: "c3", name: "bash", arguments: { command: "npm run lint" } },
    ]) +
    result("c2", "ok") +
    result("c3", "ok") +
    user("第三段：收尾", t(11, 52)) +
    assistant("好了")
  );
}

function emptyState(): WebState {
  return {
    pending: [],
    approvals: [],
    applied: [],
    done: [],
    summary: { reviewing: 0, stale: 0, pendingApprovals: 0, appliedTotal: 0, rollbackRate: 0 },
  };
}

function source(raw = jsonl()): SessionSource {
  return { sessionId: SID, file: FILE, sizeBytes: Buffer.byteLength(raw, "utf8"), transcript: parseSessionText(raw) };
}

function page(options: { onlyUser?: boolean } = {}): string {
  return renderSessionPage(source(), { state: emptyState(), only: options.onlyUser === true ? "user" : null });
}

/** 取左侧可收起目录（`<details class="toc">`）里的链接 */
function tocLinks(html: string): string[] {
  const aside = /<details class="toc"[^>]*>([\s\S]*?)<\/details>/.exec(html)?.[1] ?? "";
  return [...aside.matchAll(/<a href="#(m-\d+)">/g)].map((match) => match[1] ?? "");
}

test("目录条目数等于渲染出的用户消息数（用户消息就是天然章节）", () => {
  const html = page();
  assert.equal(tocLinks(html).length, 3);
  assert.match(html, /<a href="#m-1">10:32 · 第一段：先看列表页<\/a>/);
});

test("锚点与目录一一对应：id 唯一、href 全都能落到实处", () => {
  const html = page();
  const ids = [...html.matchAll(/<div class="msg user m" id="(m-\d+)">/g)].map((match) => match[1]);
  assert.deepEqual(ids, ["m-1", "m-3", "m-5"], "三条用户消息的块号（工具块不占 msg 块号）");
  assert.deepEqual(new Set(ids).size, ids.length, "id 不许重复");
  assert.deepEqual(tocLinks(html), ids, "目录指向的正是这三块");
});

test("窄屏折叠目录：同一份内容放在顶部 <details> 里（宽屏由 CSS 隐藏）", () => {
  const html = page();
  assert.match(html, /<details class="toc-fold"><summary>目录（用户消息） 3 条<\/summary>/);
  assert.match(html, /<details class="toc" open><summary>目录（用户消息） 3 条 · 点标题收起<\/summary>/, "左侧目录可收起");
  const fold = /<div class="toc-list">([\s\S]*?)<\/div>/.exec(html)?.[1] ?? "";
  assert.deepEqual([...fold.matchAll(/<a href="#(m-\d+)">/g)].map((match) => match[1]), tocLinks(html));
});

test("目录文本：转义且截到 40 字（长标题不把侧栏撑成两行）", () => {
  const long = `${"很".repeat(60)}<b>x</b>`;
  const html = renderSessionPage(
    { sessionId: SID, file: FILE, sizeBytes: 10, transcript: parseSessionText(user(long, new Date(2026, 10, 8, 9, 0).getTime())) },
    { state: emptyState() },
  );
  const aside = tocLinks(html).length > 0 ? /<details class="toc"[^>]*>([\s\S]*?)<\/details>/.exec(html)?.[1] ?? "" : "";
  assert.match(aside, new RegExp(`09:00 · 很{40}…`));
  assert.equal(aside.includes("<b>"), false, "目录文本必须转义");
});

test("只看用户：工具块全部省略成一行，且给「看全部」的回头路", () => {
  const html = page({ onlyUser: true });
  assert.equal(html.includes('<details class="tools">'), false);
  assert.match(html, /<p class="hint">… 本轮省略 1 次工具调用/);
  assert.match(html, /<p class="hint">… 本轮省略 2 次工具调用（<a href="[^"]+">看全部<\/a>）<\/p>/);
  const back = /<a href="([^"]+)">看全部<\/a>/.exec(html)?.[1] ?? "";
  assert.ok(back.includes(`sessionId=${SID}`), "回头路必须还在这个会话");
  assert.equal(back.includes("only"), false, "看全部 = 去掉 only 参数");
});

test("看全部 ⇄ 只看对话：切换链接都带着 sessionId 与原文件路径", () => {
  const all = page();
  const toOnly = /<a href="([^"]+)">只看用户<\/a>/.exec(all)?.[1] ?? "";
  assert.ok(toOnly.includes("only=user"));
  assert.ok(toOnly.includes(encodeURIComponent(FILE)), "换机器时 file 参数是找回原文的关键");
  const only = page({ onlyUser: true });
  assert.match(only, /当前：只看用户消息/);
  const back = /<a href="([^"]+)">全部<\/a>/.exec(only)?.[1] ?? "";
  assert.equal(back.includes("only=user"), false, "全部 = 去掉 only 参数");
});

test("两个跳转：顶部「跳到最新 ↓」指向最后一块，底部「↑ 回到顶部」指回 #top", () => {
  const html = page();
  // 最后一块是收尾的助手消息（m-6）：跳转要落在它身上，不能落在工具块上
  assert.match(html, /<a class="to-end" href="#m-6">跳到最新 ↓<\/a>/);
  assert.match(html, /<a class="to-top" href="#top">↑ 回到顶部<\/a>/);
  assert.match(html, /<div class="wrap" id="top">/);
});

test("没有用户消息时目录给一句人话；没有任何块时也不给「跳到最新」", () => {
  const onlyAssistant = renderSessionPage(
    { sessionId: SID, file: FILE, sizeBytes: 10, transcript: parseSessionText(assistant("只有助手在自言自语")) },
    { state: emptyState() },
  );
  assert.match(onlyAssistant, /这段会话里没有用户消息/);

  const nothing = renderSessionPage(
    { sessionId: SID, file: FILE, sizeBytes: 0, transcript: parseSessionText("") },
    { state: emptyState() },
  );
  assert.equal(nothing.includes('class="to-end"'), false, "没有块可跳就不给「跳到最新」");
  assert.match(nothing, /没有可渲染的对话/);
});
