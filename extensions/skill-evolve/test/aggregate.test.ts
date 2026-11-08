/**
 * 同会话聚合检测：**判定规则**的单测（纯函数，不碰派发）。
 *
 * 现场（用户 2026-11-08 报的现象）：同一个 sessionId 下堆了 1 条 analyzed + 7 条 stale，
 * 同一段会话被反反复复复盘。根因是 runId 每轮结算都会算出新的，而全局单飞闸只管「同时一个子进程」。
 *
 * 判定口径：只有「同会话 + 仍在途（dispatched）+ 子进程活着 + 还没落 01-findings.json」才并入；
 * 尸体（进程已死）交 stale 逻辑、已跑完的交下一轮 —— 这三种不许混淆。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { findSameSessionRun, readAggregateRuns, type AggregateRun } from "../lib/aggregate.ts";
import { NOW } from "./aggregate-harness.ts";

/** 假 run 的构造器：纯函数用例不需要真目录，只有 readAggregateRuns 才碰盘 */
function runOf(overrides: Partial<AggregateRun> & { sessionId: string }): AggregateRun {
  return {
    runId: "run-1",
    runDir: "/tmp/run-1",
    status: "dispatched",
    pid: 4242,
    dispatchedAt: NOW - 1000,
    hasFindings: false,
    coverage: null,
    ...overrides,
  };
}

const alwaysAlive = (): boolean => true;
const alwaysDead = (): boolean => false;

test("纯函数：同会话在途且子进程活着 → 命中那条 run", () => {
  const runs = [runOf({ sessionId: "s1", runId: "r1" })];
  assert.equal(findSameSessionRun(runs, "s1", alwaysAlive, NOW)?.runId, "r1");
  // 不同会话一律不并
  assert.equal(findSameSessionRun(runs, "s2", alwaysAlive, NOW), null);
});

test("纯函数：状态不是 dispatched（复盘已跑完）→ 不命中", () => {
  for (const status of ["analyzed", "proposed", "reviewed", "applied", "stale", "failed"]) {
    const runs = [runOf({ sessionId: "s1", status })];
    assert.equal(findSameSessionRun(runs, "s1", alwaysAlive, NOW), null, status);
  }
});

test("纯函数：子进程已死 / 没有 pid → 不命中（尸体交给 stale，不往里并）", () => {
  assert.equal(findSameSessionRun([runOf({ sessionId: "s1" })], "s1", alwaysDead, NOW), null);
  assert.equal(findSameSessionRun([runOf({ sessionId: "s1", pid: null })], "s1", alwaysAlive, NOW), null);
});

test("纯函数：01-findings.json 已落盘 → 不命中（状态可能还没回写）", () => {
  assert.equal(findSameSessionRun([runOf({ sessionId: "s1", hasFindings: true })], "s1", alwaysAlive, NOW), null);
});

test("纯函数：多条命中取最近派发的；派发时刻在未来的（时钟回拨）不并", () => {
  const runs = [
    runOf({ sessionId: "s1", runId: "old", dispatchedAt: NOW - 5000 }),
    runOf({ sessionId: "s1", runId: "new", dispatchedAt: NOW - 100 }),
    runOf({ sessionId: "s1", runId: "future", dispatchedAt: NOW + 60_000 }),
  ];
  assert.equal(findSameSessionRun(runs, "s1", alwaysAlive, NOW)?.runId, "new");
});

test("readAggregateRuns：坏 run.json 一律跳过，不伪造在途记录", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skill-evolve-agg-scan-"));
  const evolutionDir = path.join(dir, ".pi", "evolution");
  fs.mkdirSync(path.join(evolutionDir, "runs", "good"), { recursive: true });
  fs.writeFileSync(path.join(evolutionDir, "runs", "good", "run.json"), JSON.stringify({ runId: "good", sessionId: "s1", status: "dispatched", pid: 7, dispatchedAt: NOW }), "utf8");
  fs.mkdirSync(path.join(evolutionDir, "runs", "half"), { recursive: true });
  fs.writeFileSync(path.join(evolutionDir, "runs", "half", "run.json"), '{"runId":"half"', "utf8");
  const runs = readAggregateRuns(evolutionDir);
  assert.deepEqual(runs.map((run) => run.runId), ["good"]);
  // 01-findings.json 存在即视为复盘已跑完
  fs.writeFileSync(path.join(evolutionDir, "runs", "good", "01-findings.json"), "{}", "utf8");
  assert.equal(readAggregateRuns(evolutionDir)[0]?.hasFindings, true);
});
