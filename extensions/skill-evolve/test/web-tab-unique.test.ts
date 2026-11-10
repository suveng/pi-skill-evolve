/**
 * 「每个 tab 不要出现重复的」（用户 2026-11-10）的唯一守卫。
 *
 * 一个 runId 只能落在一个 tab 里：先按 tab-origin.ts 判归属，再由 data.ts 按归属过滤。
 * 这里从真实目录结构造四种冲突场景，逐个数「这个 runId 在整个面板出现几次」——
 * 出现两次就是回归，不靠人眼在页面上翻。
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { collectWebState, type WebState } from "../lib/web/data.ts";

const NOW = Date.UTC(2026, 10, 10, 12);
const DAY = 86_400_000;

function workspace(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "skill-evolve-unique-"));
  const evolutionDir = path.join(cwd, ".pi", "evolution");
  fs.mkdirSync(path.join(evolutionDir, "runs"), { recursive: true });
  return evolutionDir;
}

function writeRun(evolutionDir: string, runId: string, record: Record<string, unknown> = {}): string {
  const runDir = path.join(evolutionDir, "runs", runId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(
    path.join(runDir, "run.json"),
    JSON.stringify({
      runId,
      status: "dispatched",
      trigger: "auto",
      sessionId: `session-${runId}`,
      dispatchedAt: NOW - DAY,
      ...record,
    }),
    "utf8",
  );
  return runDir;
}

function writeQueue(evolutionDir: string, rows: Record<string, unknown>[]): void {
  fs.writeFileSync(path.join(evolutionDir, "queue.json"), JSON.stringify(rows), "utf8");
}

function queueRow(runId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    runId,
    level: "auto",
    skill: "demo",
    targets: [".pi/skills/demo/SKILL.md"],
    createdAt: NOW - DAY,
    status: "pending",
    ...extra,
  };
}

/** 这个 runId 在四个列表里一共出现几次 */
function occurrences(state: WebState, runId: string): number {
  return [state.applied, state.approvals, state.done, state.pending].reduce(
    (sum, rows) => sum + rows.filter((row) => row.runId === runId).length,
    0,
  );
}

test("队列 applied + run.json 还是 dispatched：只出现在已采纳，不在待处理复现", () => {
  const evolutionDir = workspace();
  writeRun(evolutionDir, "r-applied", { status: "dispatched" });
  writeQueue(evolutionDir, [queueRow("r-applied", { status: "applied" })]);
  const state = collectWebState({ evolutionDir, now: NOW, alive: () => true });
  assert.equal(state.applied.filter((row) => row.runId === "r-applied").length, 1);
  assert.equal(occurrences(state, "r-applied"), 1, "同一个 run 只能在一个 tab 里");
});

test("队列 pending/approval + run.json 已 review_failed：归已结束，不再留在待审批等人点", () => {
  const evolutionDir = workspace();
  writeRun(evolutionDir, "r-dead", { status: "review_failed" });
  writeQueue(evolutionDir, [queueRow("r-dead", { level: "approval" })]);
  const state = collectWebState({ evolutionDir, now: NOW, alive: () => true });
  assert.equal(state.done.filter((row) => row.runId === "r-dead").length, 1);
  assert.equal(occurrences(state, "r-dead"), 1);
});

test("队列 pending/approval + run.json stale（卡死但没终态）：仍在待审批，不凭空归到已结束", () => {
  const evolutionDir = workspace();
  writeRun(evolutionDir, "r-stale", { status: "stale" });
  writeQueue(evolutionDir, [queueRow("r-stale", { level: "approval" })]);
  const state = collectWebState({ evolutionDir, now: NOW, alive: () => false });
  assert.equal(occurrences(state, "r-stale"), 1);
  assert.equal(state.approvals.filter((row) => row.runId === "r-stale").length, 1);
});

test("队列 pending/approval + run.json reviewed：只进待审批", () => {
  const evolutionDir = workspace();
  writeRun(evolutionDir, "r-approval", { status: "reviewed" });
  writeQueue(evolutionDir, [queueRow("r-approval", { level: "approval" })]);
  const state = collectWebState({ evolutionDir });
  assert.equal(state.approvals.filter((row) => row.runId === "r-approval").length, 1);
  assert.equal(state.pending.filter((row) => row.runId === "r-approval").length, 0);
  assert.equal(occurrences(state, "r-approval"), 1);
});

test("四条 run 各归各的 tab：总数等于 run 数，没有一条被两次收录", () => {
  const evolutionDir = workspace();
  writeRun(evolutionDir, "r-a", { status: "applied" });
  writeRun(evolutionDir, "r-b", { status: "dispatched" });
  writeRun(evolutionDir, "r-c", { status: "rejected" });
  writeRun(evolutionDir, "r-d", { status: "reviewed" });
  writeQueue(evolutionDir, [
    queueRow("r-a", { status: "applied" }),
    queueRow("r-d", { level: "approval" }),
  ]);
  const state = collectWebState({ evolutionDir, now: NOW, alive: () => true });
  const total = state.applied.length + state.approvals.length + state.done.length + state.pending.length;
  assert.equal(total, 4, `四条 run 一共只该出现 4 次，实际 ${total}`);
  for (const runId of ["r-a", "r-b", "r-c", "r-d"]) {
    assert.equal(occurrences(state, runId), 1, `${runId} 出现了多次`);
  }
  assert.deepEqual(state.applied.map((row) => row.runId), ["r-a"]);
  assert.deepEqual(state.approvals.map((row) => row.runId), ["r-d"]);
  assert.deepEqual(state.done.map((row) => row.runId), ["r-c"]);
  assert.deepEqual(state.pending.map((row) => row.runId), ["r-b"]);
});
