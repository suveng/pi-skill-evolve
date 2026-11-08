/**
 * 会话索引单测（零依赖，node --test）。
 *
 * 运行：
 *   cd .pi/extensions/skill-evolve
 *   node --experimental-strip-types --test test/session-index.test.ts
 *
 * 覆盖：行号 1 起算、compaction 标记、坏行只计数不崩、摘要 ≤80 字、
 * 以及「索引里不出现会话原文」这条铁律（设计稿 5.4）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { buildSessionIndex, excerptOf, writeSessionIndex } from "../lib/session-index.ts";
import { directQueue } from "../lib/telemetry.ts";

const LONG_TEXT = "这是一段用来撑长度的用户原话。".repeat(20);

/** 贴近真实会话的一小段 JSONL：头部 + 用户 + 助手带工具调用 + 工具结果 + compaction */
const SESSION_JSONL = [
  JSON.stringify({ type: "session", version: 3, id: "sess-1", timestamp: "2026-11-08T02:48:52.675Z", cwd: "/repo" }),
  JSON.stringify({ type: "model_change", id: "e0", timestamp: "2026-11-08T02:48:53.000Z" }),
  JSON.stringify({
    type: "message",
    id: "e1",
    parentId: "e0",
    timestamp: "2026-11-08T02:49:00.000Z",
    message: { role: "user", content: [{ type: "text", text: "帮我把需求 R-20261108 推进到开发中" }] },
  }),
  JSON.stringify({
    type: "message",
    id: "e2",
    parentId: "e1",
    timestamp: "2026-11-08T02:49:05.000Z",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "先看流程" },
        { type: "toolCall", id: "call-1", name: "read", arguments: { path: ".pi/skills/kb-test-map/SKILL.md" } },
      ],
    },
  }),
  JSON.stringify({
    type: "message",
    id: "e3",
    parentId: "e2",
    timestamp: "2026-11-08T02:49:06.000Z",
    message: { role: "toolResult", toolCallId: "call-1", toolName: "read", isError: false, content: [{ type: "text", text: "# kb-test-map" }] },
  }),
  JSON.stringify({ type: "compaction", id: "e4", timestamp: "2026-11-08T02:50:00.000Z", summary: "先前讨论了需求推进规则", firstKeptEntryId: "e2", tokensBefore: 42000 }),
  "",
].join("\n");

test("buildSessionIndex：行号 1 起算、类型与角色正确", () => {
  const index = buildSessionIndex(SESSION_JSONL);
  assert.equal(index.stats.lines, 6);
  assert.equal(index.stats.bytes, Buffer.byteLength(SESSION_JSONL, "utf8"));
  assert.equal(index.lines[0].line, 1);
  assert.equal(index.lines[0].type, "session");
  assert.equal(index.lines[0].excerpt, "/repo");
  assert.equal(index.lines[2].line, 3);
  assert.equal(index.lines[2].role, "user");
  assert.equal(index.lines[2].excerpt.includes("推进到开发中"), true);
  assert.equal(index.lines[2].ts, "2026-11-08T02:49:00.000Z");
  // 助手消息里的工具调用占位进摘要，方便复盘按行号回读
  assert.equal(index.lines[3].excerpt.includes("[调用 read]"), true);
  // 工具结果摘要前缀工具名
  assert.equal(index.lines[4].excerpt.startsWith("[read]"), true);
});

test("buildSessionIndex：compaction 被标记且摘要进索引", () => {
  const index = buildSessionIndex(SESSION_JSONL);
  assert.equal(index.stats.hasCompaction, true);
  const compaction = index.lines.find((line) => line.type === "compaction");
  assert.equal(compaction?.line, 6);
  assert.equal(compaction?.excerpt, "先前讨论了需求推进规则");
});

test("buildSessionIndex：坏行只计数不进索引，不整份失败", () => {
  const index = buildSessionIndex(`${SESSION_JSONL}\n{"type":"message","id":broken\n`);
  assert.equal(index.stats.lines, 7);
  assert.equal(index.lines.length, 6);
});

test("buildSessionIndex：空行不计入 lines 统计", () => {
  const index = buildSessionIndex("\n\n\n");
  assert.equal(index.stats.lines, 0);
  assert.deepEqual(index.lines, []);
  assert.equal(index.stats.hasCompaction, false);
});

test("excerptOf：折叠空白并截到 80 字", () => {
  assert.equal(excerptOf("a\n\n  b\tc"), "a b c");
  const short = excerptOf(LONG_TEXT);
  assert.equal(short.length, 80);
  assert.equal(short.endsWith("…"), true);
  assert.equal(excerptOf("x".repeat(80)).length, 80);
});

test("索引里不出现会话原文（长文本被截断，原文不入库）", () => {
  const long = JSON.stringify({ type: "message", id: "x", message: { role: "user", content: [{ type: "text", text: LONG_TEXT }] } });
  const index = buildSessionIndex(long);
  assert.equal(index.lines.length, 1);
  assert.equal(index.lines[0].chars, long.length);
  assert.equal(JSON.stringify(index).includes(LONG_TEXT), false);
});

test("writeSessionIndex：生成 index.json 并从原文取字节数", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skill-evolve-index-"));
  const sessionFile = path.join(dir, "session.jsonl");
  fs.writeFileSync(sessionFile, SESSION_JSONL, "utf8");
  const outDir = path.join(dir, "00-session");
  const index = await writeSessionIndex({ sessionFile, outDir, queue: directQueue });
  assert.equal(index?.stats.lines, 6);
  const written = JSON.parse(fs.readFileSync(path.join(outDir, "index.json"), "utf8"));
  assert.equal(written.stats.hasCompaction, true);
  assert.equal(written.lines.length, 6);
});

test("writeSessionIndex：原文读不到时返回 null（调用方降级 telemetry-only）", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skill-evolve-index-"));
  const index = await writeSessionIndex({ sessionFile: path.join(dir, "不存在.jsonl"), outDir: path.join(dir, "00-session"), queue: directQueue, log: () => {} });
  assert.equal(index, null);
  assert.equal(fs.existsSync(path.join(dir, "00-session", "index.json")), false);
});
