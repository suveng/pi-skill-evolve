/**
 * 会话详情页的纯函数单测（node --test）：
 * JSONL 解析（只认 message、跳过 system / thinking、工具调用回连结果、连续工具聚块）、
 * 渲染（默认收起、全转义、单条与总输出截断、只留最后 200 条）。
 *
 * 纪律：不读真实 `~/.pi/agent/sessions`、不读真实 run 目录 —— 所有输入都是本文件里现造的 JSONL 片段，
 * 这样用例既快又不受本机会话文件变动影响。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MAX_MESSAGES,
  MAX_OUTPUT,
  parseSessionText,
  renderSessionBody,
  type SessionTranscript,
} from "../lib/web/session-view.ts";

/** 一行 JSONL（pi 的真实形态：顶层 type + message） */
function line(record: unknown): string {
  return `${JSON.stringify(record)}\n`;
}

function userMessage(text: string): string {
  return line({ type: "message", message: { role: "user", content: [{ type: "text", text }] } });
}

function assistantMessage(text: string, calls: { id: string; name: string; arguments?: unknown }[] = []): string {
  const content: unknown[] = [];
  if (text.length > 0) content.push({ type: "text", text });
  for (const call of calls) content.push({ type: "toolCall", id: call.id, name: call.name, arguments: call.arguments ?? {} });
  return line({ type: "message", message: { role: "assistant", content } });
}

function toolResult(toolCallId: string, text: string): string {
  return line({ type: "message", message: { role: "toolResult", toolCallId, toolName: "read", content: [{ type: "text", text }] } });
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
  assert.deepEqual(transcript.entries, [{ kind: "user", text: "你好" }]);
});

test("解析：system 提示词与 thinking 块都不渲染（它们不是对话）", () => {
  const raw =
    line({ type: "message", message: { role: "system", content: [{ type: "text", text: "你是复盘助手" }] } }) +
    line({ type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "先看看 diff" }, { type: "text", text: "结论：没问题" }] } });
  const transcript = parseSessionText(raw);
  assert.deepEqual(transcript.entries, [{ kind: "assistant", text: "结论：没问题" }]);
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
  assert.deepEqual(transcript.entries.map((entry) => entry.kind), ["user", "tools", "assistant"]);
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
  // 文本在前、工具在后：中间那两次调用仍属同一段连续工具调用
  assert.deepEqual(transcript.entries.map((entry) => entry.kind), ["assistant", "tools"]);
  const tools = transcript.entries[1];
  assert.equal(tools.kind === "tools" ? tools.calls.length : 0, 2);
});

test("解析：没有结果的调用写「（没有结果）」（子进程被 kill 时会这样）", () => {
  const transcript = parseSessionText(assistantMessage("", [{ id: "c9", name: "read", arguments: {} }]));
  const tools = transcript.entries[0];
  assert.equal(tools.kind === "tools" ? tools.calls[0]?.result : "", "（没有结果）");
});

test("渲染：用户与助手各一段，抬头写明是谁", () => {
  const html = renderSessionBody(parseSessionText(userMessage("你好") + assistantMessage("你好，有什么要看的？")));
  assert.match(html, /<div class="msg user">\s*<p class="who">用户<\/p>\s*<pre>你好<\/pre>/);
  assert.match(html, /<div class="msg assistant">\s*<p class="who">助手<\/p>/);
});

test("渲染：工具块默认收起（details 不带 open），抬头是「工具名 ×次数（点击展开）」", () => {
  const raw =
    assistantMessage("", [
      { id: "c1", name: "read", arguments: { path: "a" } },
      { id: "c2", name: "read", arguments: { path: "b" } },
      { id: "c3", name: "bash", arguments: { command: "ls" } },
    ]) +
    toolResult("c1", "A") +
    toolResult("c2", "B") +
    toolResult("c3", "C");
  const html = renderSessionBody(parseSessionText(raw));
  assert.match(html, /<details class="tools"><summary>工具调用：read ×2、bash ×1（点击展开）<\/summary>/);
  assert.equal(/<details[^>]*\sopen/.test(html), false, "默认收起：不许出现 open 属性");
  // 每次调用的三段都在：名字 / 参数 / 结果
  assert.match(html, /<p class="tool-name">read<\/p>/);
  assert.match(html, /<pre class="tool-args">\{&quot;path&quot;:&quot;a&quot;\}<\/pre>/);
  assert.match(html, /<pre class="tool-result">A<\/pre>/);
});

test("渲染：消息里的 HTML 一律转义，页面不出现裸 <script>", () => {
  const raw =
    userMessage("<script>alert(1)</script>") +
    assistantMessage("引用 <b>粗体</b>") +
    assistantMessage("", [{ id: "c1", name: "read", arguments: { path: "<img src=x>" } }]) +
    toolResult("c1", "<script>x()</script>");
  const html = renderSessionBody(parseSessionText(raw));
  assert.equal(/<script/i.test(html), false);
  assert.equal(/<img/i.test(html), false);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /&lt;b&gt;粗体&lt;\/b&gt;/);
  assert.match(html, /&lt;img src=x&gt;/);
});

test("渲染：用户原文超 2000 字截断并加省略号，助手正文超 4000 字同理", () => {
  const longUser = "u".repeat(2500);
  const longAssistant = "a".repeat(4500);
  const transcript = parseSessionText(userMessage(longUser) + assistantMessage(longAssistant));
  const html = renderSessionBody(transcript);
  assert.equal(html.includes("u".repeat(2000) + "…"), true);
  assert.equal(html.includes("u".repeat(2001)), false);
  assert.equal(html.includes("a".repeat(4000) + "…"), true);
  assert.equal(html.includes("a".repeat(4001)), false);
});

test("渲染：工具参数截到 400 字、结果截到 200 字", () => {
  const raw =
    assistantMessage("", [{ id: "c1", name: "read", arguments: "p".repeat(600) }]) +
    toolResult("c1", "r".repeat(400));
  const html = renderSessionBody(parseSessionText(raw));
  assert.equal(html.includes("p".repeat(400) + "…"), true);
  assert.equal(html.includes("p".repeat(401)), false);
  assert.equal(html.includes("r".repeat(200) + "…"), true);
  assert.equal(html.includes("r".repeat(201)), false);
});

test("解析：超过 200 条只留最后 200 条，dropped 记下丢掉多少", () => {
  const raw = Array.from({ length: MAX_MESSAGES + 5 }, (_, index) => userMessage(`第 ${index} 条`)).join("");
  const transcript = parseSessionText(raw);
  assert.equal(transcript.messages, MAX_MESSAGES + 5);
  assert.equal(transcript.entries.length, MAX_MESSAGES);
  assert.equal(transcript.dropped, 5);
  assert.equal(transcript.entries[0]?.kind === "user" ? transcript.entries[0].text : "", "第 5 条");
  // 丢掉的要说明，否则用户以为会话只有 200 条
  const html = renderSessionBody(transcript, { dropped: transcript.dropped });
  assert.match(html, /只渲染最后 200 条消息，前面还有 5 条未显示/);
});

test("渲染：总输出超 2MB 就停手并指路原文件", () => {
  // 用会被转义成 6 个字符的引号撑大输出：200 条 × 4000 字 → 转义后远超上限
  const entries: SessionTranscript["entries"] = Array.from({ length: MAX_MESSAGES }, () => ({
    kind: "assistant",
    text: '"'.repeat(4000),
  }));
  const html = renderSessionBody({ entries, messages: entries.length, toolCalls: 0, dropped: 0 });
  assert.equal(html.length > MAX_OUTPUT, false, "输出必须被截在上限以内");
  assert.match(html, /已达页面输出上限（2048KB），后面还有内容未渲染/);
  assert.match(html, /继续看请用 rg\/read 打开原文件/);
});

test("渲染：空会话给一句空态，不留白页", () => {
  assert.match(renderSessionBody({ entries: [], messages: 0, toolCalls: 0, dropped: 0 }), /没有可渲染的对话/);
});
