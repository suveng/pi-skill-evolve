/**
 * M6 面板：没数据不显示 0、状态栏只放最紧急一件、状态变迁只发一次 `/tree` 条目。
 * 用例编号对应设计稿 14.1（四层可见性）。
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { collectPanelState, entryLines, panelWidget, statusEntries, statusLine } from "../lib/panel.ts";

const NOW = Date.UTC(2026, 10, 8, 12);

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "skill-evolve-panel-"));
}

function writeRun(dir: string, runId: string, status: string, dispatchedAt = NOW, extra: Record<string, unknown> = {}): void {
  const runDir = path.join(dir, "runs", runId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, "run.json"), JSON.stringify({ runId, status, dispatchedAt, sessionId: "s", ...extra }), "utf8");
}

function writeQueue(dir: string, items: unknown[]): void {
  fs.writeFileSync(path.join(dir, "queue.json"), JSON.stringify(items), "utf8");
}

test("panelWidget：全零返回 null，不显示「复盘 0 / 待批 0」", () => {
  assert.equal(panelWidget({ reviewing: 0, staleCount: 0, pendingApprovals: 0, lastAppliedAt: null, rollbackRate: 0, appliedSamples: 0 }), null);
});

test("panelWidget：有哪项就拼哪项，缺项不占位", () => {
  const state = { reviewing: 3, staleCount: 0, pendingApprovals: 0, lastAppliedAt: Date.UTC(2026, 10, 7), rollbackRate: 0, appliedSamples: 2 };
  assert.deepEqual(panelWidget(state), ["复盘 3 / 上次采纳 11-07"]);
  assert.deepEqual(panelWidget({ ...state, pendingApprovals: 2, reviewing: 0 }), ["待批 2 / 上次采纳 11-07"]);
});

test("statusLine：待批优先于回滚率告警，只显示一件事", () => {
  const state = { reviewing: 4, staleCount: 0, pendingApprovals: 2, lastAppliedAt: NOW, rollbackRate: 0.5, appliedSamples: 10 };
  assert.equal(statusLine(state), "待批 2");
});

test("statusLine：样本少于 5 次不下回滚率结论", () => {
  assert.equal(statusLine({ reviewing: 0, staleCount: 0, pendingApprovals: 0, lastAppliedAt: NOW, rollbackRate: 0.4, appliedSamples: 4 }), null);
});

test("statusLine：样本够且超 5% 才告警（含建议关 auto）", () => {
  const state = { reviewing: 1, staleCount: 0, pendingApprovals: 0, lastAppliedAt: NOW, rollbackRate: 0.06, appliedSamples: 6 };
  assert.equal(statusLine(state), "回滚率 6% 超 5%，建议关 auto");
  assert.equal(statusLine({ ...state, rollbackRate: 0.05 }), null, "正好 5% 不算「超」");
});

test("collectPanelState：进行中的 run 算「复盘」，待批只数 approval 级 pending", () => {
  const dir = tmpDir();
  writeRun(dir, "r1", "dispatched");
  writeRun(dir, "r2", "proposed", NOW, { supervisorPid: 1 });
  writeRun(dir, "r5", "proposed", NOW, { pid: 999999 });
  writeRun(dir, "r3", "reviewed");
  writeQueue(dir, [
    { runId: "r3", level: "approval", skill: "a", targets: [], proposalType: "improve", status: "pending", createdAt: NOW },
    { runId: "r4", level: "auto", skill: "b", targets: [], proposalType: "improve", status: "pending", createdAt: NOW },
  ]);
  const state = collectPanelState({ evolutionDir: dir, now: NOW, alive: (pid) => pid === 1 });
  assert.equal(state.reviewing, 2, "dispatched 宽限期内 + 督导活着的 proposed 算；结论已出且进程不在的不算");
  assert.equal(state.pendingApprovals, 1, "auto 条不等审批");
});

test("collectPanelState：上次采纳取 04-decision.json 的 at，采纳 / 回滚率按队列算", () => {
  const dir = tmpDir();
  const appliedAt = Date.UTC(2026, 10, 7, 8);
  writeRun(dir, "r1", "applied");
  fs.writeFileSync(path.join(dir, "runs", "r1", "04-decision.json"), JSON.stringify({ at: appliedAt }), "utf8");
  writeRun(dir, "r2", "rolled-back");
  writeQueue(dir, [
    { runId: "r1", level: "approval", skill: "a", targets: [], proposalType: "improve", status: "applied", createdAt: NOW },
    { runId: "r2", level: "approval", skill: "a", targets: [], proposalType: "improve", status: "rolled-back", createdAt: NOW },
  ]);
  const state = collectPanelState({ evolutionDir: dir, now: NOW });
  assert.equal(state.lastAppliedAt, appliedAt);
  assert.equal(state.appliedSamples, 2);
  assert.equal(state.rollbackRate, 0.5);
});

test("statusEntries：同一状态只发一次，dispatched 由调用方单独记", () => {
  const seen = new Map<string, string>();
  const runs = [
    { runId: "r1", status: "dispatched" },
    { runId: "r2", status: "reviewed" },
    { runId: "r3", status: "applied" },
    { runId: "r4", status: "rolled-back" },
    { runId: "r5", status: "rejected" },
  ];
  const first = statusEntries(runs, seen, NOW);
  assert.deepEqual(
    first.map((entry) => [entry.runId, entry.kind]),
    [
      ["r2", "reviewed"],
      ["r3", "applied"],
      ["r4", "rolled-back"],
      ["r5", "reviewed"],
    ],
  );
  assert.equal(first.find((entry) => entry.runId === "r5")?.detail, "rejected", "非 pass 的结论要带上原因");
  assert.deepEqual(statusEntries(runs, seen, NOW), [], "同状态不重复发");
  assert.deepEqual(
    statusEntries([...runs, { runId: "r6", status: "applied" }], seen, NOW).map((entry) => entry.runId),
    ["r6"],
  );
});

test("entryLines：/tree 条目单行、带短日期与动作", () => {
  const lines = entryLines({ kind: "applied", runId: "run-1", at: NOW, detail: "approval · a" });
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /\[skill-evolve\] 采纳 run-1 · 11-08 · approval · a/);
});
