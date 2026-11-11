/**
 * tab 归属判据（用户 2026-11-10：「每个 tab 不要出现重复的，还有现在这个任务，
 * 我要看到它从哪个 tab 出来的，出来的证据是什么」）。
 *
 * 本文件钉两件事：
 * 1. 顺位：已采纳 > 已结束 > 待审批 > 待处理，同一 runId 命中多条判据时取第一个；
 * 2. 证据：reason 与 evidence 必须是真的能从磁盘复核的文件与字段（不许写「系统认为」）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { QueueItem } from "../lib/queue.ts";
import { originOfRun, TAB_LABEL, TAB_RANK } from "../lib/web/tab-origin.ts";

const REL = "runs/run-1";

function queueItem(extra: Partial<QueueItem> = {}): QueueItem {
  return {
    runId: "run-1",
    level: "auto",
    skill: "demo",
    targets: [".pi/skills/demo/SKILL.md"],
    createdAt: 0,
    status: "pending",
    ...extra,
  };
}

test("已采纳：队列 applied 排在最前，证据里给 queue.json 的字段与 06-verify.json", () => {
  const origin = originOfRun({ runId: "run-1", runRelDir: REL, queue: queueItem({ status: "applied" }), runStatus: "applied" });
  assert.equal(origin.tab, "applied");
  assert.equal(origin.label, "已采纳");
  assert.match(origin.reason, /applied/);
  assert.match(origin.evidence.join("\n"), /queue\.json：status=applied/);
  assert.match(origin.evidence.join("\n"), /runs\/run-1\/06-verify\.json/);
});

test("已结束：队列终态与 run.json 终态都归已结束，reason 说清是哪一条命中的", () => {
  const fromQueue = originOfRun({ runId: "run-1", runRelDir: REL, queue: queueItem({ status: "rolled-back" }) });
  assert.equal(fromQueue.tab, "done");
  assert.match(fromQueue.reason, /采纳队列状态 rolled-back/);

  const fromRun = originOfRun({ runId: "run-1", runRelDir: REL, runStatus: "review_failed" });
  assert.equal(fromRun.tab, "done");
  assert.match(fromRun.reason, /run\.json 状态 review_failed/);
});

test("待审批：只有 pending + level=approval 才进；auto 级仍是待处理", () => {
  const approval = originOfRun({ runId: "run-1", runRelDir: REL, queue: queueItem({ level: "approval" }), runStatus: "reviewed" });
  assert.equal(approval.tab, "approvals");
  assert.match(approval.reason, /level=approval/);

  const auto = originOfRun({ runId: "run-1", runRelDir: REL, queue: queueItem({ level: "auto" }), runStatus: "reviewed" });
  assert.equal(auto.tab, "pending");
  assert.match(auto.reason, /level=auto/);
});

test("优先级：同时命中已采纳与已结束、或待审批与已结束时，一次只归一个 tab", () => {
  const appliedWins = originOfRun({ runId: "run-1", runRelDir: REL, queue: queueItem({ status: "applied" }), runStatus: "rolled-back" });
  assert.equal(appliedWins.tab, "applied", "队列是采纳的唯一事实");

  const doneBeatsApprovals = originOfRun({ runId: "run-1", runRelDir: REL, queue: queueItem({ level: "approval" }), runStatus: "abandoned" });
  assert.equal(doneBeatsApprovals.tab, "done", "终态不再要求人点批准");
});

test("没入队也没 run.json：仍在待处理，理由与证据都不留空", () => {
  const origin = originOfRun({ runId: "run-1", runRelDir: REL });
  assert.equal(origin.tab, "pending");
  assert.ok(origin.reason.length > 0);
  assert.deepEqual(origin.evidence, ["runs/run-1/run.json", "runs/run-1/03-review.json"]);
});

test("顺位与文案是唯一事实：TAB_RANK 从已采纳往待处理递增，四个 tab 都有中文名", () => {
  assert.ok(TAB_RANK.applied < TAB_RANK.done);
  assert.ok(TAB_RANK.done < TAB_RANK.approvals);
  assert.ok(TAB_RANK.approvals < TAB_RANK.pending);
  assert.deepEqual(Object.keys(TAB_LABEL).sort(), ["applied", "approvals", "done", "pending"]);
});

test("originOfRun：analyzed 且没有提案 → 已结束（分析判定不需要改，别在 tab 里消失）", () => {
  const origin = originOfRun({ runId: "r1", runRelDir: "runs/r1", runStatus: "analyzed", hasProposal: false });
  assert.equal(origin.tab, "done");
  assert.match(origin.reason, /分析判定不需要改/);
  assert.ok(origin.evidence.some((line) => line.endsWith("01-findings.json")));
});

test("originOfRun：analyzed 但有提案 → 仍是待处理（等评审 / 等入队）", () => {
  const origin = originOfRun({ runId: "r2", runRelDir: "runs/r2", runStatus: "analyzed", hasProposal: true });
  assert.equal(origin.tab, "pending");
});
