/**
 * 遥测单测（零依赖，node --test）。
 *
 * 运行：
 *   cd .pi/extensions/skill-evolve
 *   node --experimental-strip-types --test test/telemetry.test.ts
 *
 * 覆盖：除零返回 0（绝不返回 NaN）、disabled 技能不算曝光、未命中 top10 排序与截断、
 * 按天分片写入与跨天读取、写入失败只记日志不抛。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { createTelemetry, dayOf, directQueue, ratio, readEvents, shardFile, summarize, type MutationQueue, type TelemetryEvent, type TelemetrySkill } from "../lib/telemetry.ts";

const NOW = new Date(2026, 10, 8, 15, 30, 0).getTime(); // 本地时间 2026-11-08 15:30

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "skill-evolve-tele-"));
}

function skill(name: string, disabled = false): TelemetrySkill {
  return { name, filePath: `/repo/.pi/skills/${name}/SKILL.md`, disabled, source: "project" };
}

function advertised(skills: TelemetrySkill[]): TelemetryEvent {
  return { ts: NOW, iso: new Date(NOW).toISOString(), kind: "advertised", sessionId: "s1", skills };
}

test("ratio：除零与非法值一律返回 0", () => {
  assert.equal(ratio(0, 0), 0);
  assert.equal(ratio(3, 0), 0);
  assert.equal(ratio(Number.NaN, 5), 0);
  assert.equal(ratio(5, Number.POSITIVE_INFINITY), 0);
  assert.equal(ratio(2, 4), 0.5);
});

test("summarize：空数据不产生 NaN", () => {
  const summary = summarize([]);
  assert.equal(summary.loadRate, 0);
  assert.equal(Number.isNaN(summary.loadRate), false);
  assert.equal(summary.advertised, 0);
  assert.deepEqual(summary.missedTop, []);
});

test("summarize：disabled 技能不算曝光，加载率按有效曝光算", () => {
  const events: TelemetryEvent[] = [
    advertised([skill("a"), skill("b"), skill("c", true)]),
    { ts: NOW, iso: "", kind: "loaded", sessionId: "s1", skill: "a" },
    { ts: NOW, iso: "", kind: "failed", sessionId: "s1", skill: "b" },
  ];
  const summary = summarize(events);
  assert.equal(summary.rounds, 1);
  assert.equal(summary.advertised, 2);
  assert.equal(summary.loaded, 1);
  assert.equal(summary.failed, 1);
  assert.equal(summary.loadRate, 0.5);
});

test("summarize：未命中 top10 按次数倒序、同名同次按名字排序、最多 10 条", () => {
  const events: TelemetryEvent[] = [{ ts: NOW, iso: "", kind: "missed", sessionId: "s1", skill: "b" }];
  events.push({ ts: NOW, iso: "", kind: "missed", skill: "b" });
  events.push({ ts: NOW, iso: "", kind: "missed", skill: "a" });
  for (let i = 0; i < 12; i += 1) events.push({ ts: NOW, iso: "", kind: "missed", skill: `z${String(i).padStart(2, "0")}` });
  const summary = summarize(events);
  assert.equal(summary.missed, 15);
  assert.equal(summary.missedTop.length, 10);
  assert.deepEqual(summary.missedTop[0], { skill: "b", count: 2 });
  assert.deepEqual(summary.missedTop[1], { skill: "a", count: 1 });
});

test("dayOf / shardFile：按本地日期分片", () => {
  assert.equal(dayOf(NOW), "2026-11-08");
  assert.equal(shardFile("/x/telemetry", NOW), path.join("/x/telemetry", "2026-11-08.jsonl"));
});

test("createTelemetry：append 后 flush，跨天读取能读到今天的行", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skill-evolve-tel-"));
  const writer = createTelemetry({ dir, queue: directQueue, enabled: true, now: () => NOW });
  // 两次写之间必须 flush：测试里注入的是 directQueue（不串行），真实链路靠 withFileMutationQueue 保证同文件串行
  writer.append({ kind: "advertised", sessionId: "s1", skills: [skill("a")] });
  await writer.flush();
  writer.append({ kind: "loaded", sessionId: "s1", skill: "a", how: "read", ok: true });
  await writer.flush();

  const file = shardFile(dir, NOW);
  const lines = fs.readFileSync(file, "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
  const first = JSON.parse(lines[0]);
  assert.equal(first.kind, "advertised");
  assert.equal(first.ts, NOW);
  assert.equal(first.iso, new Date(NOW).toISOString());
  assert.equal(summarize(readEvents(dir, 1, NOW)).loaded, 1);
});

test("createTelemetry：enabled=false 时完全不写盘", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skill-evolve-tel-"));
  const writer = createTelemetry({ dir, queue: directQueue, enabled: false, now: () => NOW });
  writer.append({ kind: "pending", sessionId: "s1" });
  await writer.flush();
  assert.equal(fs.existsSync(shardFile(dir, NOW)), false);
});

test("createTelemetry：写失败只记日志，不抛到调用方", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skill-evolve-tel-"));
  const logs: string[] = [];
  const failing: MutationQueue = async () => {
    throw new Error("磁盘满了");
  };
  const writer = createTelemetry({ dir, queue: failing, enabled: true, now: () => NOW, log: (msg) => logs.push(msg) });
  writer.append({ kind: "loaded", sessionId: "s1", skill: "a" });
  await writer.flush();
  assert.equal(logs.some((line) => line.includes("遥测写入失败")), true);
});

test("readEvents：目录不存在、天数非法、坏行都安全", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skill-evolve-tel-"));
  fs.writeFileSync(shardFile(dir, NOW), '{"kind":"loaded","ts":1}\n不是 JSON\n\n', "utf8");
  assert.equal(readEvents(dir, 1, NOW).length, 1);
  assert.deepEqual(readEvents(path.join(dir, "不存在"), 1, NOW), []);
  assert.equal(readEvents(dir, 0, NOW).length, 1, "days<=0 回退 7 天应能读到今天的分片");
});

test("appendSync：同步落盘（退出前补发路径，不能等异步队列）", () => {
  const dir = tmpDir();
  const telemetry = createTelemetry({ dir, queue: directQueue, enabled: true, log: () => {}, now: () => NOW });
  telemetry.appendSync({ kind: "dispatched", sessionId: "s1", runId: "r1", pid: 42, trigger: "shutdown", ts: NOW });
  const file = shardFile(dir, NOW);
  assert.equal(fs.existsSync(file), true);
  assert.equal(fs.readFileSync(file, "utf8").includes("\"trigger\":\"shutdown\""), true);
});

test("appendSync：目录不可写时只记日志，不抛", () => {
  const dir = tmpDir();
  const logs: string[] = [];
  // 用一个「父路径是文件」的目录制造必然失败的 mkdir
  const blocked = path.join(dir, "not-a-dir");
  fs.writeFileSync(blocked, "x");
  const telemetry = createTelemetry({ dir: path.join(blocked, "telemetry"), queue: directQueue, enabled: true, log: (msg) => logs.push(msg), now: () => NOW });
  assert.doesNotThrow(() => telemetry.appendSync({ kind: "skipped", sessionId: "s1", why: "lock", trigger: "shutdown" }));
  assert.equal(logs.some((line) => line.includes("遥测写入失败")), true);
});
