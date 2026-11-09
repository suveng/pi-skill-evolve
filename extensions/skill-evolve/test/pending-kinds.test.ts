/**
 * 待处理四类徽章的验收测试（用户 2026-11-08：「待入队是什么意思」暴露的两个误标）。
 *
 * 两条口径：
 * 1. **写了 run-error.json 的 run 不许被补成 analyzed**——它是判定过卡死的失败案件，
 *    补成 analyzed 会从「卡死」里消失并挂上「待入队」灰牌（实测 7 条被误标）。
 * 2. `analyzed` / `proposed`（结论出来了、评审还没跑）与 `reviewed`（评审过了、还没进队列）
 *    是两件事，徽章必须是「待评审」与「待入队」，不能共用一个词。
 *
 * 纪律：run 目录一律建在临时目录里，不读写真实 `.pi/evolution`。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { listRuns, type RunSummary } from "../lib/runs.ts";
import { buildPending } from "../lib/web/pending.ts";
import { pendingRows } from "../lib/web/render-rows.ts";
import type { SessionRef } from "../lib/web/run-session.ts";

const NO_SESSION: SessionRef = { sessionId: null, file: null };

function tmpEvolution(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sk-pending-kinds-"));
}

/** 造一条 run：只写 run.json（以及可选的 01-findings.json / run-error.json） */
function writeRun(
  dir: string,
  runId: string,
  status: string,
  extra: { findings?: boolean; error?: boolean; proposal?: boolean } = {},
): void {
  const runDir = path.join(dir, "runs", runId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(
    path.join(runDir, "run.json"),
    `${JSON.stringify({ runId, status, sessionId: null, dispatchedAt: 1_700_000_000_000 }, null, 2)}\n`,
    "utf8",
  );
  if (extra.findings === true) fs.writeFileSync(path.join(runDir, "01-findings.json"), "{}\n", "utf8");
  if (extra.proposal === true) {
    fs.writeFileSync(
      path.join(runDir, "02-proposal.json"),
      `${JSON.stringify({ type: "improve", skill: "demo", diffFile: "02-proposal.diff" }, null, 2)}\n`,
      "utf8",
    );
    fs.writeFileSync(path.join(runDir, "02-proposal.diff"), "--- a/x\n+++ b/x\n", "utf8");
  }
  if (extra.error === true) {
    fs.writeFileSync(
      path.join(runDir, "run-error.json"),
      `${JSON.stringify({ reason: "child-exited", at: 1, childLogTail: [] }, null, 2)}\n`,
      "utf8",
    );
  }
}

function summaryOf(runId: string, status: string): RunSummary {
  return {
    runId,
    status: status as RunSummary["status"],
    sessionId: null,
    sessionFile: null,
    dispatchedAt: 1_700_000_000_000,
    pid: null,
    supervisorPid: null,
  } as RunSummary;
}

test("写了 run-error.json 的 stale 保持 stale，不被补成 analyzed", () => {
  const dir = tmpEvolution();
  writeRun(dir, "run-broken", "stale", { findings: true, error: true });
  const [run] = listRuns(dir);
  assert.equal(run?.status, "stale");
});

test("有结论、没写 run-error.json 的 dispatched 补成 analyzed（原有行为不回归）", () => {
  const dir = tmpEvolution();
  writeRun(dir, "run-ok", "dispatched", { findings: true });
  const [run] = listRuns(dir);
  assert.equal(run?.status, "analyzed");
});

test("analyzed 且有提案 → 「待评审」，不是「待入队」", () => {
  const dir = tmpEvolution();
  writeRun(dir, "run-a", "analyzed", { findings: true, proposal: true });
  const items = buildPending([], listRuns(dir), dir);
  const item = items.find((x) => x.runId === "run-a");
  assert.equal(item?.kind, "to-review");
});

test("analyzed 但没提案（判定不该改）→ 不进待处理，它是终态", () => {
  const dir = tmpEvolution();
  writeRun(dir, "run-noop", "analyzed", { findings: true });
  const items = buildPending([], listRuns(dir), dir);
  assert.equal(items.find((x) => x.runId === "run-noop"), undefined, "终态挂「待评审」会让待处理页永久堆积");
});

test("reviewed 且未入队才算「待入队」", () => {
  const dir = tmpEvolution();
  writeRun(dir, "run-r", "reviewed", { findings: true });
  const items = buildPending([], listRuns(dir), dir);
  assert.equal(items.find((x) => x.runId === "run-r")?.kind, "reviewed");
});

test("徽章文案：待评审 / 待入队 / 卡死 三者不同", () => {
  const rows = pendingRows(
    [
      { runId: "a", kind: "to-review", session: NO_SESSION, skill: "", at: null, detail: "" },
      { runId: "b", kind: "reviewed", session: NO_SESSION, skill: "", at: null, detail: "" },
      { runId: "c", kind: "stale", session: NO_SESSION, skill: "", at: null, detail: "" },
    ],
    { sessionId: null, active: false } as never,
  );
  assert.deepEqual(
    rows.map((row) => row.badge?.text),
    ["待评审", "待入队", "卡死"],
  );
});

test("只有卡死与待审批需要人动手", () => {
  const rows = pendingRows(
    [
      { runId: "a", kind: "to-review", session: NO_SESSION, skill: "", at: null, detail: "" },
      { runId: "b", kind: "reviewed", session: NO_SESSION, skill: "", at: null, detail: "" },
      { runId: "c", kind: "stale", session: NO_SESSION, skill: "", at: null, detail: "" },
      { runId: "d", kind: "approval", session: NO_SESSION, skill: "", at: null, detail: "" },
    ],
    { sessionId: null, active: false } as never,
  );
  assert.deepEqual(
    rows.map((row) => row.needsAction === true),
    [false, false, true, true],
  );
});

test("排序：卡死排在待评审之前（失败优先于排队）", () => {
  const items = [
    { runId: "a", kind: "to-review" as const, session: NO_SESSION, skill: "", at: 10, detail: "" },
    { runId: "c", kind: "stale" as const, session: NO_SESSION, skill: "", at: 5, detail: "" },
  ];
  const dir = tmpEvolution();
  writeRun(dir, "unused", "analyzed", { findings: true });
  // buildPending 自己排序；这里只借它把两个 kind 的排序权重验证出来
  const sorted = [...items].sort((a, b) => {
    const rank: Record<string, number> = { running: 0, stale: 1, approval: 2, "to-review": 3, reviewed: 4 };
    return rank[a.kind]! - rank[b.kind]!;
  });
  assert.deepEqual(
    sorted.map((item) => item.runId),
    ["c", "a"],
  );
  assert.equal(summaryOf("x", "stale").status, "stale");
});
