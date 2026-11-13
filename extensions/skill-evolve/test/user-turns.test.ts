/**
 * 会话轮次门槛单测（2026-11-13）：用户消息 > minUserMessages 才值得花一次复盘 token。
 * 覆盖：两种消息写法、坏行跳过、空文本、读不到文件返回 null。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { countUserMessages, readUserMessages } from "../lib/user-turns.ts";

const user = (text: string) => JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text }] } });
const assistant = (text: string) => JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text }] } });

test("countUserMessages：只数 user，assistant / toolResult / 系统行都不算", () => {
  const raw = [
    JSON.stringify({ type: "session", id: "s1" }),
    user("一"),
    assistant("答一"),
    JSON.stringify({ type: "message", message: { role: "toolResult", content: [] } }),
    user("二"),
    JSON.stringify({ type: "message", message: { role: "system", content: [] } }),
  ].join("\n");
  assert.equal(countUserMessages(raw), 2);
});

test("countUserMessages：兼容顶层 role 写法，坏行与空行直接跳过", () => {
  const raw = ["", "   ", '{"role":"user","content":"一"}', '{"role":"assistant"}', "{半截 JSON", user("三")].join("\n");
  assert.equal(countUserMessages(raw), 2);
});

test("countUserMessages：空文件是 0，不是 null（0 条 = 明确「没说过话」）", () => {
  assert.equal(countUserMessages(""), 0);
});

test("readUserMessages：没有路径 / 文件不存在都返回 null（数不了轮次，交给调用方决定）", () => {
  assert.equal(readUserMessages(undefined), null);
  assert.equal(readUserMessages(null), null);
  assert.equal(readUserMessages(path.join(os.tmpdir(), "不存在的会话文件.skill-evolve.jsonl")), null);
});

test("readUserMessages：读到文件就返回真实条数", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skill-evolve-turns-"));
  const file = path.join(dir, "session.jsonl");
  fs.writeFileSync(file, [user("一"), user("二"), user("三")].join("\n"), "utf8");
  assert.equal(readUserMessages(file), 3);
});
