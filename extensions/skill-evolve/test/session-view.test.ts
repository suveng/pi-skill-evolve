/**
 * 会话详情的解析单测（node --test）：JSONL 只认 message、跳过 system / thinking、
 * 工具调用回连结果、连续调用聚块、条数与长度上限。
 *
 * 渲染部分（Markdown-lite、折叠抬头、目录、总输出上限）在 ./session-render.test.ts 与 ./session-nav.test.ts 里，
 * 因为解析与渲染已经是两个文件，测试也各盯一处，失败时不用先猜是哪一半。
 *
 * 纪律：不读真实 `~/.pi/agent/sessions`、不读真实 run 目录 —— 所有输入都是本文件里现造的 JSONL 片段。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { MAX_MESSAGES, MAX_OUTPUT, parseSessionText, type SessionTranscript } from "../lib/web/session-view.ts";
import { renderTranscript } from "../lib/web/session-render.ts";

/** 一行 JSONL（pi 的真实形态：顶层 type + message，可选 timestamp） */
function line(record: unknown): string {
  return `${JSON.stringify(record)}\n`;
}

function userMessage(text: string, at?: number): string {
  const record = { type: "message", message: { role: "user", content: [{ type: "text", text }] } };
  return line(at === undefined ? record : { ...record, timestamp: new Date(at).toISOString() });
}

function assistantMessage(
  text: string,
  calls: { id: string; name: string; arguments?: unknown }[] = [],
  at?: number,
): string {
  const content: unknown[] = [];
  if (text.length > 0) content.push({ type: "text", text });
  for (const call of calls) content.push({ type: "toolCall", id: call.id, name: call.name, arguments: call.arguments ?? {} });
  const record = { type: "message", message: { role: "assistant", content } };
  return line(at === undefined ? record : { ...record, timestamp: new Date(at).toISOString() });
}

function toolResult(toolCallId: string, text: string): string {
  return line({
    type: "message",
    message: { role: "toolResult", toolCallId, toolName: "read", content: [{ type: "text", text }] },
  });
}

test("解析：只认顶层 type=message，session / model_change / custom 全跳过", () => {
  const raw =
    line({ type: "session", id: "s1" }) +
    line({ type: "model_change", model: "x" }) +
    line({ type: "custom", data: {} }) +
    userMessage("你好") +
    "这不是 JSON\n";
  const transcript = parseSessionText(raw);
  assert.equal(transcript.messages, 1);
  assert.deepEqual(transcript.entries, [{ kind: "user", text: "你好", at: null }]);
});

test("解析：system 提示词与 thinking 块都不渲染（它们不是对话）", () => {
  const raw =
    line({ type: "message", message: { role: "system", content: [{ type: "text", text: "你是复盘助手" }] } }) +
    line({
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "thinking", thinking: "先看看 diff" }, { type: "text", text: "结论：没问题" }],
      },
    });
  const transcript = parseSessionText(raw);
  assert.deepEqual(transcript.entries, [{ kind: "assistant", text: "结论：没问题", at: null }]);
});

test("解析：顶层 timestamp 记进 at，首末时刻写进 firstAt / lastAt（概览要用）", () => {
  const early = new Date(2026, 10, 8, 10, 32).getTime();
  const late = new Date(2026, 10, 8, 11, 52).getTime();
  const transcript = parseSessionText(userMessage("开始", early) + assistantMessage("结束", [], late));
  assert.deepEqual(
    transcript.entries.map((entry) => entry.at),
    [early, late],
  );
  assert.equal(transcript.firstAt, early);
  assert.equal(transcript.lastAt, late);
});

test("解析：工具调用按 toolCallId 回连结果，连续调用聚成一个块", () => {
  const raw =
    userMessage("看两个文件") +
    assistantMessage("", [
      { id: "c1", name: "read", arguments: { path: "a.ts" } },
      { id: "c2", name: "read", arguments: { path: "b.ts" } },
    ]) +
    toolResult("c1", "文件 a 的内容") +
    toolResult("c2", "文件 b 的内容") +
    assistantMessage("看完了");
  const transcript = parseSessionText(raw);
  assert.deepEqual(
    transcript.entries.map((entry) => entry.kind),
    ["user", "tools", "assistant"],
  );
  const tools = transcript.entries[1];
  assert.equal(tools.kind, "tools");
  if (tools.kind !== "tools") return;
  assert.equal(tools.calls.length, 2);
  assert.deepEqual(
    tools.calls.map((call) => [call.name, call.args, call.result]),
    [
      ["read", '{"path":"a.ts"}', "文件 a 的内容"],
      ["read", '{"path":"b.ts"}', "文件 b 的内容"],
    ],
  );
  assert.equal(transcript.toolCalls, 2);
});

test("解析：两次 assistant 消息之间的调用（中间只隔 toolResult）也聚成一个块", () => {
  const raw =
    assistantMessage("先读一个", [{ id: "c1", name: "read", arguments: { path: "a" } }]) +
    toolResult("c1", "ok") +
    assistantMessage("", [{ id: "c2", name: "bash", arguments: { command: "ls" } }]) +
    toolResult("c2", "ok");
  const transcript = parseSessionText(raw);
  assert.deepEqual(
    transcript.entries.map((entry) => entry.kind),
    ["assistant", "tools"],
  );
  const tools = transcript.entries[1];
  assert.equal(tools.kind === "tools" ? tools.calls.length : 0, 2);
});

test("解析：没有结果的调用写「（没有结果）」（子进程被 kill 时会这样）", () => {
  const transcript = parseSessionText(assistantMessage("", [{ id: "c9", name: "read", arguments: {} }]));
  const tools = transcript.entries[0];
  assert.equal(tools.kind === "tools" ? tools.calls[0]?.result : "", "（没有结果）");
});

test("解析：工具参数截到 400 字、结果截到 200 字", () => {
  const raw =
    assistantMessage("", [{ id: "c1", name: "read", arguments: "p".repeat(600) }]) + toolResult("c1", "r".repeat(400));
  const calls = parseSessionText(raw).entries[0];
  assert.equal(calls.kind, "tools");
  if (calls.kind !== "tools") return;
  assert.equal(calls.calls[0]?.args, `${"p".repeat(400)}…`);
  assert.equal(calls.calls[0]?.result, `${"r".repeat(200)}…`);
});

test("解析：消息正文不在解析层截断（截断归渲染：用户 2000 / 助手 4000）", () => {
  const transcript = parseSessionText(userMessage("u".repeat(2500)) + assistantMessage("a".repeat(4500)));
  const [user, assistant] = transcript.entries;
  assert.equal(user.kind === "user" ? user.text.length : 0, 2500);
  assert.equal(assistant.kind === "assistant" ? assistant.text.length : 0, 4500);
});

test("解析：超过 200 条只留最后 200 条，dropped 记下丢掉多少", () => {
  const raw = Array.from({ length: MAX_MESSAGES + 5 }, (_, index) => userMessage(`第 ${index} 条`)).join("");
  const transcript = parseSessionText(raw);
  assert.equal(transcript.messages, MAX_MESSAGES + 5);
  assert.equal(transcript.entries.length, MAX_MESSAGES);
  assert.equal(transcript.dropped, 5);
  assert.equal(transcript.entries[0]?.kind === "user" ? transcript.entries[0].text : "", "第 5 条");
  // 丢掉的要说明，否则用户以为会话只有 200 条
  const view = renderTranscript(transcript, { dropped: transcript.dropped });
  assert.match(view.body, /只渲染最后 200 条消息，前面还有 5 条未显示/);
});

test("渲染：总输出超 2MB 就停手并指路原文件", () => {
  // 用会被转义成 6 个字符的引号撑大输出：200 条 × 4000 字 → 转义后远超上限
  const entries: SessionTranscript["entries"] = Array.from({ length: MAX_MESSAGES }, () => ({
    kind: "assistant",
    text: '"'.repeat(4000),
    at: null,
  }));
  const view = renderTranscript({ entries, messages: entries.length, toolCalls: 0, dropped: 0, firstAt: null, lastAt: null });
  assert.equal(view.body.length > MAX_OUTPUT, false, "输出必须被截在上限以内");
  assert.equal(view.truncated, true);
  assert.match(view.body, /已达页面输出上限（2048KB），后面还有内容未渲染/);
  assert.match(view.body, /继续看请用 rg\/read 打开原文件/);
});

test("渲染：空会话给一句空态，不留白页", () => {
  const view = renderTranscript({ entries: [], messages: 0, toolCalls: 0, dropped: 0, firstAt: null, lastAt: null });
  assert.match(view.body, /没有可渲染的对话/);
  assert.equal(view.shown, 0);
});
