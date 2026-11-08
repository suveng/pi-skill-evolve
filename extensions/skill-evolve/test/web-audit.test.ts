/**
 * Web 操作审计（`.pi/evolution/actions.log`）：只追加、坏行跳过、只读尾部 limit 条。
 * 全部用临时目录，不起任何子进程。
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { AUDIT_FILE, appendAudit, auditFile, readAudit, type AuditEntry } from "../lib/web/audit-log.ts";

function evolutionDir(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "skill-evolve-audit-")), ".pi", "evolution");
}

function entry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return { at: 1_760_000_000_000, action: "run", result: "ok", via: "web", ...overrides };
}

test("appendAudit：目录不存在也建，一行一条 JSONL，字段齐全", () => {
  const dir = evolutionDir();
  appendAudit(dir, entry());
  const text = fs.readFileSync(auditFile(dir), "utf8");
  assert.equal(text.split("\n").filter((line) => line.length > 0).length, 1);
  assert.deepEqual(JSON.parse(text.trim()), { at: 1_760_000_000_000, action: "run", result: "ok", via: "web" });
  assert.equal(path.basename(auditFile(dir)), AUDIT_FILE);
});

test("appendAudit：追加不覆盖，readAudit 按文件顺序（老的在前）返回", () => {
  const dir = evolutionDir();
  appendAudit(dir, entry({ at: 1, action: "toggle" }));
  appendAudit(dir, entry({ at: 2, action: "cleanup", runId: "run-a" }));
  const entries = readAudit(dir);
  assert.deepEqual(
    entries.map((item) => item.action),
    ["toggle", "cleanup"],
  );
  assert.equal(entries[1]?.runId, "run-a");
  assert.equal("runId" in entries[0]!, false, "没有 runId 的条目不写这个字段");
});

test("readAudit：文件不存在返回空数组（没发生过动作不是错误）", () => {
  assert.deepEqual(readAudit(evolutionDir()), []);
});

test("readAudit：坏行跳过（半行 / 非 JSON / 未知动作 / 缺字段 / via 不是 web），好行照常返回", () => {
  const dir = evolutionDir();
  fs.mkdirSync(dir, { recursive: true });
  const good = JSON.stringify(entry({ action: "reject" }));
  const lines = [
    good,
    '{"at": 1, "action": "tog', // 写入中途被杀留下的半行
    "not json at all",
    JSON.stringify({ at: 3, action: "not-an-action", result: "ok", via: "web" }),
    JSON.stringify({ action: "run", result: "ok", via: "web" }), // 缺 at
    JSON.stringify({ at: 4, action: "run", result: "", via: "web" }), // 空 result
    JSON.stringify({ at: 5, action: "run", result: "ok", via: "tui" }),
    "",
  ];
  fs.writeFileSync(auditFile(dir), `${lines.join("\n")}\n`, "utf8");
  const entries = readAudit(dir);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.action, "reject");
});

test("readAudit：limit 只取尾部 N 条（默认 20）", () => {
  const dir = evolutionDir();
  for (let index = 1; index <= 25; index += 1) appendAudit(dir, entry({ at: index }));
  assert.deepEqual(
    readAudit(dir, 3).map((item) => item.at),
    [23, 24, 25],
  );
  const all = readAudit(dir);
  assert.equal(all.length, 20, "默认 limit=20");
  assert.equal(all[0]?.at, 6);
  assert.equal(all[19]?.at, 25);
  assert.deepEqual(readAudit(dir, 0), [], "limit=0 = 一条都不要");
});

test("readAudit：error 结果原样保留（带原因），供页面区分 ok / partial / 失败", () => {
  const dir = evolutionDir();
  appendAudit(dir, entry({ result: "partial" }));
  appendAudit(dir, entry({ result: "error: 只有卡死（stale）的 run 能清理，当前状态：applied", runId: "run-b" }));
  const [, failed] = readAudit(dir);
  assert.equal(failed?.result, "error: 只有卡死（stale）的 run 能清理，当前状态：applied");
  assert.equal(failed?.runId, "run-b");
});
