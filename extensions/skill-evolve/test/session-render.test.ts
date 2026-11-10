/**
 * 会话正文的渲染测试（node --test）：Markdown-lite（粗体 / 行内代码 / 标题 / 列表 / 代码块）、
 * 注入防护、工具块折叠抬头、正文与目录截断。
 *
 * 纪律：只用本文件现造的 JSONL 片段解析，不读真实 `~/.pi/agent/sessions`。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { renderTranscript, renderToc, TOOL_PREVIEW, TOC_TEXT } from "../lib/web/session-render.ts";
import { parseSessionText } from "../lib/web/session-view.ts";

function line(record: unknown): string {
  return `${JSON.stringify(record)}\n`;
}

function user(text: string, at?: number): string {
  const record = { type: "message", message: { role: "user", content: [{ type: "text", text }] } };
  return line(at === undefined ? record : { ...record, timestamp: new Date(at).toISOString() });
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

test("消息块：用户蓝徽章 + 时刻 + 用户底色 class，助手绿徽章", () => {
  const at = new Date(2026, 10, 8, 19, 35, 12).getTime();
  const view = renderTranscript(parseSessionText(user("你好", at) + assistant("你好，有什么要看的？")));
  assert.match(view.body, /<div class="msg user m" id="m-1">\n<div class="mhead"><span class="badge blue">用户<\/span><span class="at">19:35:12<\/span><\/div>/);
  assert.match(view.body, /<div class="msg assistant m" id="m-2">\n<div class="mhead"><span class="badge green">助手<\/span>/);
});

test("Markdown-lite：粗体与行内代码（不再把星号原样念给人听）", () => {
  const view = renderTranscript(parseSessionText(assistant("这是 **重点**，路径是 `lib/web/render.ts`。")));
  assert.match(view.body, /<strong>重点<\/strong>/);
  assert.match(view.body, /<code>lib\/web\/render\.ts<\/code>/);
  assert.equal(view.body.includes("**重点**"), false);
});

test("Markdown-lite：# / ## 出标题（h3 / h4，不用 h1 抢页面标题）", () => {
  const view = renderTranscript(parseSessionText(assistant("# 结论\n\n## 细节")));
  assert.match(view.body, /<h3 class="md-h">结论<\/h3>/);
  assert.match(view.body, /<h4 class="md-h">细节<\/h4>/);
  assert.equal(/<h1/.test(view.body), false);
});

test("Markdown-lite：`- ` 列表与 ``` 代码块", () => {
  const view = renderTranscript(parseSessionText(assistant("- 第一行\n- 第二行\n\n```ts\nconst a = 1;\n```")));
  assert.match(view.body, /<ul class="md-ul"><li>第一行<\/li><li>第二行<\/li><\/ul>/);
  assert.match(view.body, /<pre class="code"><code>const a = 1;<\/code><\/pre>/);
});

test("注入防护：<script> 被转义，[x](javascript:...) 只留文字不留链接", () => {
  const view = renderTranscript(parseSessionText(user("<script>alert(1)</script> 看 [点我](javascript:alert(1))")));
  assert.equal(/<script/i.test(view.body), false);
  assert.match(view.body, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.equal(view.body.includes("javascript:"), false, "URL 整段丢弃，不能变成可点的洞");
  assert.match(view.body, /看 点我/);
});

test("工具块：默认收起（不带 open），抬头是「▸ 工具名 ×次数 · 首个参数摘要」", () => {
  const raw =
    assistant("", [
      { id: "c1", name: "read", arguments: { path: "a.ts" } },
      { id: "c2", name: "read", arguments: { path: "b.ts" } },
      { id: "c3", name: "bash", arguments: { command: "ls" } },
    ]) +
    result("c1", "A") +
    result("c2", "B") +
    result("c3", "C");
  const view = renderTranscript(parseSessionText(raw));
  assert.match(view.body, /<details class="tools"><summary>▸ read ×2、bash ×1 · <span class="muted">/);
  assert.equal(/<details[^>]*\sopen/.test(view.body), false, "默认收起");
  assert.match(view.body, /<p class="tool-name">read<\/p>/);
  assert.match(view.body, /<pre class="tool-args">\{&quot;path&quot;:&quot;a\.ts&quot;\}<\/pre>/);
  assert.match(view.body, /<pre class="tool-result">A<\/pre>/);
});

/** 取工具块抬头里那句摘要（没有摘要就是空串） */
function muted(view: { body: string }): string {
  return /<span class="muted">([^<]*)<\/span>/.exec(view.body)?.[1] ?? "";
}

test("工具抬头：bash 只取 command 第一行（\\n 还原成空格、首尾引号去掉）", () => {
  // 两种情况：真换行只留第一行；字面量 \n 还原成空格。首尾引号一律去掉
  const realNewline = '"T0=$(date +%s%N)\\nD=$((1 + 1))"'.replace("\\n", "\n");
  const literal = '"T0=$(date +%s%N)\\nD=$((1 + 1))"';
  const head = (command: string): string =>
    muted(
      renderTranscript(
        parseSessionText(assistant("", [{ id: "c1", name: "bash", arguments: { command } }]) + result("c1", "ok")),
      ),
    );
  assert.equal(head(realNewline), "T0=$(date +%s%N)", "真换行只留第一行");
  assert.equal(head(literal), "T0=$(date +%s%N) D=$((1 + 1))", "字面量 \\n 还原成空格");
});

test("工具抬头：read / write / edit 取文件名，rg / grep 取 pattern，其它工具取第一个字符串参数", () => {
  const cases: { name: string; args: Record<string, unknown>; expect: string }[] = [
    { name: "read", args: { path: "/home/suveng/lib/web/a.ts" }, expect: "a.ts" },
    { name: "write", args: { path: "docs/README.md", content: "很长" }, expect: "README.md" },
    { name: "edit", args: { path: "/tmp/x/y.json" }, expect: "y.json" },
    { name: "rg", args: { pattern: "renderPage|escapeHtml", path: "lib" }, expect: "renderPage|escapeHtml" },
    { name: "grep", args: { pattern: "renderPage" }, expect: "renderPage" },
    { name: "custom_tool", args: { runId: "run-1", path: "p" }, expect: "run-1" },
  ];
  for (const item of cases) {
    const view = renderTranscript(
      parseSessionText(
        assistant("", [{ id: "c1", name: item.name, arguments: item.args }]) + result("c1", "ok"),
      ),
    );
    assert.equal(muted(view), item.expect, `${item.name} 的摘要`);
  }
});

test("工具抬头：compress 不给摘要，只显示 ×N；取不到参数时也只有 ×N", () => {
  const compress = renderTranscript(
    parseSessionText(
      assistant("", [{ id: "c1", name: "compress", arguments: { ranges: ["m1-m5"], note: "很长" } }]) + result("c1", "ok"),
    ),
  );
  assert.match(compress.body, /<summary>▸ compress ×1<\/summary>/, "compress 抬头不带参数");
  assert.equal(compress.body.includes('class="muted"'), false);

  const empty = renderTranscript(parseSessionText(assistant("", [{ id: "c1", name: "write", arguments: {} }]) + result("c1", "ok")));
  assert.match(empty.body, /<summary>▸ write ×1<\/summary>/);
});

test("工具抬头摘要里不出现原始 JSON 片段（花括号引号、转义引号、参数名）", () => {
  const args = { command: `bash -lc "curl -d '{"cmd": "x"}'" && echo \\n done`, pattern: "a", path: "b" };
  const view = renderTranscript(parseSessionText(assistant("", [{ id: "c1", name: "bash", arguments: args }]) + result("c1", "ok")));
  const summary = muted(view);
  assert.equal(summary.includes('{"'), false, "摘要里不许出现 {\"");
  assert.equal(summary.includes('\\"'), false, "摘要里不许出现转义引号");
  assert.equal(summary.includes('"command"'), false, "摘要里不许出现参数名");
});

test("工具抬头：摘要超过 60 字要截断并转义", () => {
  const command = `<b>${"x".repeat(TOOL_PREVIEW + 20)}</b>`;
  const view = renderTranscript(
    parseSessionText(assistant("", [{ id: "c1", name: "bash", arguments: { command } }]) + result("c1", "ok")),
  );
  const summary = muted(view);
  assert.equal(summary.endsWith("…"), true, "截断要看得出来");
  assert.equal(summary.includes("x".repeat(TOOL_PREVIEW)), false, `摘要按 ${TOOL_PREVIEW} 字截断`);
  assert.equal(summary.includes("<b>"), false, "摘要里的标签必须转义");
  assert.equal(summary.includes("&lt;b&gt;"), true);
});

test("正文截断：用户 2000 字、助手 4000 字，超了加省略号", () => {
  const view = renderTranscript(parseSessionText(user("u".repeat(2500)) + assistant("a".repeat(4500))));
  assert.equal(view.body.includes(`${"u".repeat(2000)}…`), true);
  assert.equal(view.body.includes("u".repeat(2001)), false);
  assert.equal(view.body.includes(`${"a".repeat(4000)}…`), true);
  assert.equal(view.body.includes("a".repeat(4001)), false);
});

test("只有工具调用的助手消息不产出空块（shown 不计它）", () => {
  const view = renderTranscript(parseSessionText(user("看一下") + assistant("", [{ id: "c1", name: "read", arguments: {} }]) + result("c1", "ok")));
  assert.equal(view.shown, 2, "一条用户消息 + 一个工具块");
  assert.equal(view.toc.length, 1);
});

test("只看用户：工具块换成一行「省略 N 次调用（看全部）」", () => {
  const raw =
    user("看一下") +
    assistant("", [
      { id: "c1", name: "read", arguments: { path: "a" } },
      { id: "c2", name: "read", arguments: { path: "b" } },
    ]) +
    result("c1", "A") +
    result("c2", "B");
  const view = renderTranscript(parseSessionText(raw), { onlyRole: "user", expandHref: "/?view=session&sessionId=x" });
  assert.equal(view.body.includes('<details class="tools">'), false);
  assert.match(view.body, /<p class="hint">… 本轮省略 2 次工具调用（<a href="[^"]+">看全部<\/a>）<\/p>/);
});

test("目录：只收用户消息，条目写「时刻 · 前 40 字」，换行压成空格并转义", () => {
  const at = new Date(2026, 10, 8, 19, 35, 12).getTime();
  const long = `${"很".repeat(TOC_TEXT + 10)}\n第二行 <b>粗</b>`;
  const view = renderTranscript(parseSessionText(user(long, at) + assistant("回复")));
  assert.equal(view.toc.length, 1);
  assert.equal(view.toc[0]?.id, "m-1");
  const toc = renderToc(view.toc);
  assert.match(toc, /<a href="#m-1">19:35 · 很{40}…<\/a>/);
  assert.equal(toc.includes("\n第二行"), false);
  assert.equal(toc.includes("<b>"), false, "目录文本必须转义");
});

test("目录没有用户消息时给一句人话（不留空栏）", () => {
  assert.match(renderToc([]), /这段会话里没有用户消息/);
});
