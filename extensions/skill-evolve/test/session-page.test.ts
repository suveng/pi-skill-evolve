/**
 * 会话详情页的读盘层与整页渲染（node --test）。
 *
 * 纪律：所有会话文件都造在临时目录里，并把 `home` 显式传进 readSessionSource ——
 * 绝不扫真实 `~/.pi/agent/sessions`（本机会话文件随时在变，测试不能依赖它）。
 *
 * 覆盖：按 sessionId 反查、三条安全闸（根外路径 / 名字不含 sessionId / 非 .jsonl）、
 * run.json 里的 sessionFile 优先、文件不在本机的文案、整页统计与「工具块默认收起」、HTTP 路由接对。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { WebState } from "../lib/web/data.ts";
import { renderSessionPage } from "../lib/web/render-session.ts";
import {
  declaredSessionFile,
  findSessionFile,
  readSessionSource,
  resolveSessionFile,
  safeSessionId,
  sessionsRoot,
} from "../lib/web/session-file.ts";
import { startWebPanel } from "../lib/web/server.ts";

const SESSION_ID = "01a1b90f-08c3-722c-871d-d024b083770a";

/** 一段最小的会话 JSONL：一条用户消息 + 一次带结果的工具调用 */
function sessionJsonl(): string {
  return [
    JSON.stringify({ type: "session", id: SESSION_ID }),
    JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "看一下这个文件" }] } }),
    JSON.stringify({
      type: "message",
      message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "a.ts" } }] },
    }),
    JSON.stringify({ type: "message", message: { role: "toolResult", toolCallId: "c1", toolName: "read", content: [{ type: "text", text: "文件内容" }] } }),
  ].join("\n") + "\n";
}

/** 临时 home：`<home>/.pi/agent/sessions/--project--/2026-11-08T00-00-00-000Z_<id>.jsonl` */
function fakeHome(): { home: string; file: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "skill-evolve-home-"));
  const dir = path.join(sessionsRoot(home), "--home-suveng-demo--");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `2026-11-08T00-00-00-000Z_${SESSION_ID}.jsonl`);
  fs.writeFileSync(file, sessionJsonl(), "utf8");
  return { home, file };
}

/** 临时工作区：只造 runs/<runId>/run.json，够 readSessionSource 反查 sessionFile */
function fakeEvolution(runId: string, record: Record<string, unknown>): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "skill-evolve-evo-"));
  const evolutionDir = path.join(cwd, ".pi", "evolution");
  const runDir = path.join(evolutionDir, "runs", runId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, "run.json"), JSON.stringify({ runId, ...record }), "utf8");
  return evolutionDir;
}

function emptyState(): WebState {
  return {
    pending: [],
    approvals: [],
    applied: [],
    done: [],
    reports: [],
    summary: { reviewing: 0, stale: 0, pendingApprovals: 0, appliedTotal: 0, rollbackRate: 0 },
  };
}

test("sessionsRoot / safeSessionId：路径拼对，非法 id 一律拒（它会被当文件名匹配词）", () => {
  assert.equal(sessionsRoot("/home/demo"), path.join("/home/demo", ".pi", "agent", "sessions"));
  assert.equal(safeSessionId(SESSION_ID), SESSION_ID);
  assert.equal(safeSessionId("  " + SESSION_ID + "  "), SESSION_ID);
  for (const bad of ["", "../../etc/passwd", "a/b", "x".repeat(200), "id with space"]) {
    assert.equal(safeSessionId(bad), null, bad);
  }
});

test("findSessionFile：按 sessionId 在 sessions 子目录里反查，命中多条取最近（文件名时间最大）", () => {
  const { home, file } = fakeHome();
  const dir = path.dirname(file);
  const older = path.join(dir, `2026-11-07T00-00-00-000Z_${SESSION_ID}.jsonl`);
  fs.copyFileSync(file, older);
  assert.equal(findSessionFile(SESSION_ID, sessionsRoot(home)), file);
  // 换一个 sessionId 就找不到（绝不模糊匹配到别的会话）
  assert.equal(findSessionFile("ffffffff-0000-0000-0000-000000000000", sessionsRoot(home)), null);
});

test("resolveSessionFile 安全闸：根目录外 / 名字不含 sessionId / 非 .jsonl 一律不采纳（回落到按 id 反查）", () => {
  const { home, file } = fakeHome();
  const root = sessionsRoot(home);
  assert.equal(resolveSessionFile({ sessionId: SESSION_ID, file, root }), file);

  // 根目录内但不是这个会话的文件：不采纳那一条，落到反查（反查命中的才是真会话）
  const other = path.join(path.dirname(file), "2026-11-08T00-00-00-000Z_other.jsonl");
  fs.writeFileSync(other, "{}\n", "utf8");
  assert.equal(resolveSessionFile({ sessionId: SESSION_ID, file: other, root }), file);
  // 后缀不是 .jsonl 同理
  const txt = path.join(path.dirname(file), `${SESSION_ID}.txt`);
  fs.writeFileSync(txt, "x", "utf8");
  assert.equal(resolveSessionFile({ sessionId: SESSION_ID, file: txt, root }), file);

  // ?file=/etc/passwd 这种绝不能读（根目录外）：任何情况下都不会返回它
  const outside = resolveSessionFile({ sessionId: SESSION_ID, file: "/etc/passwd", root });
  assert.equal(outside, file);
  assert.equal(resolveSessionFile({ sessionId: "ffffffff-0000-0000-0000-000000000000", file: "/etc/passwd", root }), null);
});

test("declaredSessionFile：从 runs 里的 run.json 反查同一会话的 sessionFile", () => {
  const file = "/tmp/demo-session.jsonl";
  const evolutionDir = fakeEvolution("run-1", { sessionId: SESSION_ID, sessionFile: file, status: "rejected" });
  assert.equal(declaredSessionFile(evolutionDir, SESSION_ID), file);
  assert.equal(declaredSessionFile(evolutionDir, "ffffffff-0000-0000-0000-000000000000"), null);
});

test("readSessionSource：解析会话原文并给出消息数 / 工具调用数 / 字节数", () => {
  const { home, file } = fakeHome();
  const evolutionDir = fakeEvolution("run-1", { sessionId: SESSION_ID, sessionFile: file, status: "rejected" });
  const source = readSessionSource({ evolutionDir, sessionId: SESSION_ID, home });
  assert.equal(source.file, file);
  assert.equal(source.transcript?.messages, 3);
  assert.equal(source.transcript?.toolCalls, 1);
  assert.equal(source.sizeBytes, Buffer.byteLength(sessionJsonl(), "utf8"));
});

test("readSessionSource：run.json 记的路径已不在本机时按 sessionId 反查兜底", () => {
  const { home, file } = fakeHome();
  const evolutionDir = fakeEvolution("run-1", { sessionId: SESSION_ID, sessionFile: "/gone/away.jsonl", status: "rejected" });
  const source = readSessionSource({ evolutionDir, sessionId: SESSION_ID, home });
  assert.equal(source.file, file, "声明的路径没了，但本机其它目录里还留着这个会话");
});

test("readSessionSource：彻底找不到 → file 与 transcript 都是 null（页面要说人话，不能 500）", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "skill-evolve-home-empty-"));
  const evolutionDir = fakeEvolution("run-1", { sessionId: SESSION_ID, sessionFile: null, status: "rejected" });
  const source = readSessionSource({ evolutionDir, sessionId: SESSION_ID, home });
  assert.deepEqual([source.file, source.transcript, source.sizeBytes], [null, null, 0]);
});

test("readSessionSource：非法 sessionId 直接返回空，不扫盘", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "skill-evolve-home-empty-"));
  const evolutionDir = fakeEvolution("run-1", { sessionId: SESSION_ID, status: "rejected" });
  const source = readSessionSource({ evolutionDir, sessionId: "../../etc/passwd", home });
  assert.deepEqual([source.file, source.transcript], [null, null]);
});

test("renderSessionPage：顶部一行给返回入口 / 会话短 id / 原文件，概览与出口给统计，工具块默认收起", () => {
  const { home, file } = fakeHome();
  const evolutionDir = fakeEvolution("run-1", { sessionId: SESSION_ID, sessionFile: file, status: "rejected" });
  const source = readSessionSource({ evolutionDir, sessionId: SESSION_ID, home });
  const html = renderSessionPage(source, { state: emptyState() });
  // 顶部一行：回来有路、会话只显示前 8 位（完整 id 在 title 里，9 条 run 的前缀全一样）
  assert.match(html, /<a href="\/\?view=pending&amp;range=all">← 返回待处理<\/a>/);
  assert.match(html, /<span class="ses-id">会话 <code>01a1b90f<\/code><\/span>/);
  assert.match(html, /原文件 <code title="[^"]*2026-11-08T00-00-00-000Z_.*\.jsonl">/);
  // 概览：消息 / 工具调用 / 大小（时间跨度只在这段会话有 timestamp 时才出现）
  assert.match(html, /<p class="ov">消息 3 · 工具调用 1 · \d+B/);
  // 出口：渲染了多少条、原文件在哪
  assert.match(html, /已渲染全部 3 条消息（原文件 <code>.*\.jsonl<\/code>）/);
  assert.equal(/<details[^>]*\sopen/.test(html), false, "工具块默认收起");
  assert.match(html, /看一下这个文件/);
});

test("renderSessionPage：会话文件不在本机时给一句人话，不是空白页", () => {
  const source = readSessionSource({
    evolutionDir: fakeEvolution("run-1", { sessionId: SESSION_ID, status: "rejected" }),
    sessionId: SESSION_ID,
    home: fs.mkdtempSync(path.join(os.tmpdir(), "skill-evolve-home-empty-")),
  });
  const html = renderSessionPage(source, { state: emptyState() });
  assert.match(html, /会话文件已不在本机/);
  assert.match(html, /原文件：<span class="off">会话文件已不在本机<\/span>/);
});

test("HTTP 路由：GET /?view=session&sessionId= 接对了（HOME 指到临时目录，绝不碰真实 sessions）", async () => {
  const { home, file } = fakeHome();
  const evolutionDir = fakeEvolution("run-1", { sessionId: SESSION_ID, sessionFile: file, status: "rejected" });
  const original = process.env.HOME;
  process.env.HOME = home;
  const result = await startWebPanel({ evolutionDir, port: 0 });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  try {
    const response = await fetch(`${result.panel.url}/?view=session&sessionId=${SESSION_ID}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/html/);
    const html = await response.text();
    assert.match(html, /<details class="tools"><summary>▸ read ×1 · <span class="muted">/);
    assert.equal(/<details[^>]*\sopen/.test(html), false);
    assert.match(html, /← 返回待处理/);
  } finally {
    await result.panel.close();
    if (original === undefined) delete process.env.HOME;
    else process.env.HOME = original;
  }
});
