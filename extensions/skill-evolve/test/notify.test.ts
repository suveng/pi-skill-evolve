/**
 * 会话送达：三类事件各发一条、同 runId 不重复、send 抛错不炸主流程、无 UI 时降级为日志。
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { collectNotifications, deliverNotifications, NOTIFIED_FILE } from "../lib/notify.ts";

const NOW = Date.UTC(2026, 10, 8, 12);

function workspace(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "skill-evolve-notify-"));
  const evolutionDir = path.join(cwd, ".pi", "evolution");
  fs.mkdirSync(path.join(evolutionDir, "runs"), { recursive: true });
  return evolutionDir;
}

function writeRun(evolutionDir: string, runId: string, status: string): string {
  const runDir = path.join(evolutionDir, "runs", runId);
  fs.mkdirSync(runDir, { recursive: true });
  const record = { runId, status, dispatchedAt: NOW, sessionId: "s", trigger: "auto", pid: 1 };
  fs.writeFileSync(path.join(runDir, "run.json"), JSON.stringify(record), "utf8");
  return runDir;
}

function writeQueue(evolutionDir: string, items: Record<string, unknown>[]): void {
  fs.writeFileSync(path.join(evolutionDir, "queue.json"), JSON.stringify(items), "utf8");
}

function item(runId: string, status: string, level: string, skill = "demo"): Record<string, unknown> {
  return { runId, level, skill, targets: [`.pi/skills/${skill}/SKILL.md`], createdAt: NOW, status };
}

test("stale：一条消息，带原因与日志末行", () => {
  const evolutionDir = workspace();
  const runDir = writeRun(evolutionDir, "run-dead", "stale");
  fs.writeFileSync(
    path.join(runDir, "run-error.json"),
    JSON.stringify({ reason: "timeout", at: NOW, childLogTail: ["准备中", "子进程 12 分钟没动静"] }),
    "utf8",
  );
  const sent: string[] = [];
  deliverNotifications({ evolutionDir, send: (text) => sent.push(text) });
  assert.equal(sent.length, 1);
  assert.match(sent[0]!, /^技能复盘失败：run-dead（超时）/);
  assert.match(sent[0]!, /日志末行：子进程 12 分钟没动静/);
  assert.equal(sent[0]!.split("\n").length, 2, "最多两行");
});

test("待批：一条消息，附采纳命令", () => {
  const evolutionDir = workspace();
  writeRun(evolutionDir, "run-wait", "reviewed");
  writeQueue(evolutionDir, [item("run-wait", "pending", "approval", "rust")]);
  const sent: string[] = [];
  deliverNotifications({ evolutionDir, send: (text) => sent.push(text) });
  assert.equal(sent.length, 1);
  assert.match(sent[0]!, /^待批：run-wait 改动 rust/);
  assert.match(sent[0]!, /\/skill-evolve approve run-wait/);
});

test("auto 采纳：一条消息，没有 diff", () => {
  const evolutionDir = workspace();
  writeRun(evolutionDir, "run-auto", "applied");
  writeQueue(evolutionDir, [item("run-auto", "applied", "auto")]);
  const sent: string[] = [];
  deliverNotifications({ evolutionDir, send: (text) => sent.push(text) });
  assert.deepEqual(sent, ["已自动采纳：run-auto（demo）"]);
});

test("去重：同一 runId 的同一类事件只发一次，跨调用也认（notified.json）", () => {
  const evolutionDir = workspace();
  writeRun(evolutionDir, "run-once", "stale");
  const first: string[] = [];
  const second: string[] = [];
  assert.equal(deliverNotifications({ evolutionDir, now: NOW, send: (text) => first.push(text) }).length, 1);
  assert.equal(deliverNotifications({ evolutionDir, now: NOW + 1, send: (text) => second.push(text) }).length, 0);
  assert.equal(first.length, 1);
  assert.deepEqual(second, []);
  const notified = JSON.parse(fs.readFileSync(path.join(evolutionDir, "runs", "run-once", NOTIFIED_FILE), "utf8"));
  assert.deepEqual(notified.kinds, ["stale"]);
});

test("send 抛错不炸主流程，且不记 notified（下一轮还能重试）", () => {
  const evolutionDir = workspace();
  writeRun(evolutionDir, "run-throw", "stale");
  const logs: string[] = [];
  const delivered = deliverNotifications({
    evolutionDir,
    send: () => {
      throw new Error("no ui");
    },
    log: (msg) => logs.push(msg),
  });
  assert.deepEqual(delivered, [], "这条没送出去，不算已送达");
  assert.equal(logs.length, 1);
  assert.match(logs[0]!, /会话消息发送失败（run-throw）/);
  assert.equal(fs.existsSync(path.join(evolutionDir, "runs", "run-throw", NOTIFIED_FILE)), false);

  const retried: string[] = [];
  assert.equal(deliverNotifications({ evolutionDir, send: (text) => retried.push(text) }).length, 1);
  assert.equal(retried.length, 1, "重试成功");
});

test("拿不到 send（老版本 / 无 UI）：降级成日志，且不再重复刷", () => {
  const evolutionDir = workspace();
  writeRun(evolutionDir, "run-log", "stale");
  const logs: string[] = [];
  assert.equal(deliverNotifications({ evolutionDir, log: (msg) => logs.push(msg) }).length, 1);
  assert.equal(logs.length, 1);
  assert.match(logs[0]!, /技能复盘失败：run-log/, "多行文本压成一行");
  assert.equal(logs[0]!.includes("\n"), false);
  assert.equal(deliverNotifications({ evolutionDir, log: (msg) => logs.push(msg) }).length, 0);
});

test("队列里没有对应 run 目录的条目（手工塞的）不推送", () => {
  const evolutionDir = workspace();
  writeQueue(evolutionDir, [item("run-ghost", "pending", "approval")]);
  assert.deepEqual(collectNotifications(evolutionDir), []);
  const sent: string[] = [];
  assert.deepEqual(deliverNotifications({ evolutionDir, send: (text) => sent.push(text) }), []);
  assert.deepEqual(sent, []);
});

test("三类事件混在一起时各发一条，顺序稳定", () => {
  const evolutionDir = workspace();
  writeRun(evolutionDir, "run-mixed", "stale");
  writeRun(evolutionDir, "run-ok", "applied");
  writeQueue(evolutionDir, [item("run-ok", "applied", "auto")]);
  const kinds = collectNotifications(evolutionDir).map((event) => `${event.runId}:${event.kind}`);
  assert.deepEqual(kinds, ["run-mixed:stale", "run-ok:auto-applied"]);
});
