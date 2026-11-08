/**
 * 只读 Web 面板的数据聚合：空目录 / 坏 JSON / 三类待处理 / 已处理合并 / 报告字段 / 上限截断。
 * 全部喂临时目录，不起 server、不碰真仓库。
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { collectControls } from "../lib/web/activity.ts";
import { collectWebState, DONE_LIMIT } from "../lib/web/data.ts";
import { APPLIED_LIMIT } from "../lib/web/applied.ts";

const NOW = Date.UTC(2026, 10, 8, 12);

function workspace(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "skill-evolve-webdata-"));
  const evolutionDir = path.join(cwd, ".pi", "evolution");
  fs.mkdirSync(path.join(evolutionDir, "runs"), { recursive: true });
  return evolutionDir;
}

function writeRun(evolutionDir: string, runId: string, record: Record<string, unknown> = {}): string {
  const runDir = path.join(evolutionDir, "runs", runId);
  fs.mkdirSync(runDir, { recursive: true });
  const base = { runId, status: "dispatched", dispatchedAt: NOW, sessionId: "s", trigger: "auto" };
  fs.writeFileSync(path.join(runDir, "run.json"), JSON.stringify({ ...base, ...record }), "utf8");
  return runDir;
}

function writeQueue(evolutionDir: string, items: Record<string, unknown>[]): void {
  fs.mkdirSync(evolutionDir, { recursive: true });
  fs.writeFileSync(path.join(evolutionDir, "queue.json"), JSON.stringify(items), "utf8");
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value), "utf8");
}

function item(runId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    runId,
    level: "approval",
    skill: "demo",
    targets: [".pi/skills/demo/SKILL.md"],
    createdAt: NOW,
    status: "pending",
    ...extra,
  };
}

test("collectWebState：空目录返回五个空集合与全零 summary", () => {
  const state = collectWebState({ evolutionDir: workspace() });
  assert.deepEqual(state.pending, []);
  assert.deepEqual(state.approvals, []);
  assert.deepEqual(state.applied, []);
  assert.deepEqual(state.done, []);
  assert.deepEqual(state.reports, []);
  assert.deepEqual(state.summary, { reviewing: 0, stale: 0, pendingApprovals: 0, appliedTotal: 0, rollbackRate: 0 });
});

test("collectWebState：队列 / run.json / findings 全是坏 JSON 也不抛，一律当空", () => {
  const evolutionDir = workspace();
  const runDir = path.join(evolutionDir, "runs", "bad");
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, "run.json"), "{ 坏掉", "utf8");
  fs.writeFileSync(path.join(runDir, "01-findings.json"), "{ 也坏", "utf8");
  fs.writeFileSync(path.join(evolutionDir, "queue.json"), "not json", "utf8");
  const state = collectWebState({ evolutionDir });
  assert.deepEqual(state.pending, [], "坏队列不产生待处理");
  assert.equal(state.reports.length, 0, "坏 findings 不进报告");
  assert.equal(state.summary.appliedTotal, 0);
});

test("pending：只收 approval 级 pending，detail 里带采纳命令", () => {
  const evolutionDir = workspace();
  writeRun(evolutionDir, "r1", { status: "reviewed" });
  writeQueue(evolutionDir, [item("r1")]);
  const state = collectWebState({ evolutionDir });
  assert.equal(state.pending.length, 1);
  assert.equal(state.pending[0]!.kind, "approval");
  assert.equal(state.pending[0]!.skill, "demo");
  assert.match(state.pending[0]!.detail, /\/skill-evolve approve r1/);
  assert.equal(state.summary.pendingApprovals, 1);
});

test("pending：auto 级 pending 不算待批（不需要人），也不进待处理列表", () => {
  const evolutionDir = workspace();
  writeRun(evolutionDir, "r2", { status: "reviewed" });
  writeQueue(evolutionDir, [item("r2", { level: "auto" })]);
  const state = collectWebState({ evolutionDir });
  assert.deepEqual(state.pending, []);
  assert.equal(state.summary.pendingApprovals, 0);
});

test("pending：stale 的 run 单列一类，带原因与日志末行", () => {
  const evolutionDir = workspace();
  const runDir = writeRun(evolutionDir, "dead", { status: "stale", pid: 4242 });
  writeJson(path.join(runDir, "run-error.json"), {
    reason: "timeout",
    at: NOW + 1_000,
    childLogTail: ["启动复盘子进程", "mcp timeout"],
  });
  const state = collectWebState({ evolutionDir });
  assert.equal(state.pending.length, 1);
  assert.equal(state.pending[0]!.kind, "stale");
  assert.match(state.pending[0]!.detail, /超时/);
  assert.match(state.pending[0]!.detail, /mcp timeout/);
  assert.equal(state.summary.stale, 1);
});

test("pending：reviewed 且未入队算待入队，已在队列里的（含 superseded）不重复出现", () => {
  const evolutionDir = workspace();
  writeRun(evolutionDir, "r4", { status: "reviewed" });
  writeRun(evolutionDir, "r5", { status: "reviewed" });
  writeQueue(evolutionDir, [item("r5", { status: "superseded" })]);
  const state = collectWebState({ evolutionDir });
  assert.deepEqual(
    state.pending.map((entry) => `${entry.runId}:${entry.kind}`),
    ["r4:reviewed"],
  );
});

test("done：只剩回滚 / 失败 / 否决 / 被顶替四种终态，applied 不再进 done", () => {
  const evolutionDir = workspace();
  writeRun(evolutionDir, "r5", { status: "applied" });
  writeRun(evolutionDir, "r7", { status: "rejected", dispatchedAt: NOW + 4_000 });
  writeQueue(evolutionDir, [
    item("r5", { level: "auto", status: "applied", createdAt: NOW + 2_000, detail: "闸门全绿" }),
    item("r6", { status: "superseded", createdAt: NOW + 3_000 }),
  ]);
  const state = collectWebState({ evolutionDir });
  assert.deepEqual(
    state.done.map((entry) => `${entry.runId}:${entry.status}`),
    ["r7:rejected", "r6:superseded"],
    "已采纳单独成 tab，混进已处理就分不清「留下了什么」和「撤了什么」",
  );
  assert.deepEqual(
    state.applied.map((entry) => entry.runId),
    ["r5"],
  );
});

test("applied：读 04-decision.at 当采纳时间，带五闸结论，按时间倒序", () => {
  const evolutionDir = workspace();
  const older = writeRun(evolutionDir, "a-old", { status: "applied" });
  const newer = writeRun(evolutionDir, "a-new", { status: "applied" });
  for (const [runId, runDir, at] of [
    ["a-old", older, NOW - 60_000],
    ["a-new", newer, NOW],
  ] as const) {
    writeJson(path.join(runDir, "02-proposal.json"), {
      type: "improve",
      skill: "demo",
      status: "ok",
      added: 3,
      removed: 1,
      file: "02-proposal.diff",
    });
    // 增删行数是数 diff 来的，不是读 JSON 里的数字
    fs.writeFileSync(
      path.join(runDir, "02-proposal.diff"),
      "--- a/.pi/skills/demo/SKILL.md\n+++ b/.pi/skills/demo/SKILL.md\n@@ -1,2 +1,4 @@\n ---\n-old\n+new1\n+new2\n+new3\n",
      "utf8",
    );
    writeJson(path.join(runDir, "04-decision.json"), { status: "applied", approver: "auto", at, detail: "ok" });
    writeJson(path.join(runDir, "06-verify.json"), {
      runId,
      status: "applied",
      at,
      ms: 3,
      wrote: [],
      gates: [
        { gate: "gate0", name: "授权核对", ok: true, ms: 1 },
        { gate: "gate3", name: "复验", ok: false, ms: 1, detail: "复验失败" },
      ],
    });
  }
  writeQueue(evolutionDir, [
    item("a-old", { status: "applied", createdAt: NOW - 60_000 }),
    item("a-new", { status: "applied", createdAt: NOW }),
    // 还没采纳的不该出现在已采纳页
    item("a-pending", { status: "pending" }),
  ]);
  const state = collectWebState({ evolutionDir });
  assert.deepEqual(
    state.applied.map((entry) => entry.runId),
    ["a-new", "a-old"],
  );
  const [newest] = state.applied;
  assert.equal(newest!.appliedAt, NOW, "采纳时间取 04-decision.at");
  assert.equal(newest!.type, "improve");
  assert.equal(newest!.added, 3);
  assert.equal(newest!.removed, 1);
  assert.equal(newest!.gatesOk, false, "有一闸失败就不是全 ok");
  assert.equal(state.applied[1]!.gatesOk, false);
  assert.deepEqual(newest!.gates.map((gate) => gate.gate), ["gate0", "gate3"]);
});

test("reports：只收有 01-findings.json 的 run，前 5 条归因 + 提案/评审/决策/五闸", () => {
  const evolutionDir = workspace();
  const runDir = writeRun(evolutionDir, "r8", {
    status: "applied",
    trigger: "manual",
    proposal: { type: "improve", skill: "demo", status: "ok", added: 5, removed: 2, file: "02-proposal.diff" },
    review: { status: "reviewed", verdict: "pass", action: "auto", reviewerModel: "m", proposerModel: "m", sameModel: true },
  });
  writeJson(path.join(runDir, "01-findings.json"), {
    skills: [
      { name: "demo", advertised: true, loaded: false, whyNotLoaded: "B", confidence: "high" },
      { name: "s2", advertised: true, loaded: true },
      { name: "s3", advertised: false, loaded: false },
      { name: "s4", advertised: true, loaded: false, whyNotLoaded: "G" },
      { name: "s5", advertised: true, loaded: false, whyNotLoaded: "F" },
      { name: "s6", advertised: true, loaded: false },
    ],
    notes: [],
  });
  writeJson(path.join(runDir, "03-review.json"), { status: "reviewed", verdict: "pass", blocking: [{ issue: "x" }] });
  writeJson(path.join(runDir, "04-decision.json"), { status: "applied", approver: "auto", at: NOW, detail: "ok" });
  writeJson(path.join(runDir, "06-verify.json"), {
    runId: "r8",
    status: "applied",
    at: NOW,
    ms: 12,
    wrote: [".pi/skills/demo/SKILL.md"],
    gates: [
      { gate: "gate0", name: "授权核对", ok: true, ms: 1 },
      { gate: "gate1", name: "备份", ok: true, ms: 1 },
      { gate: "gate2", name: "原子写", ok: true, ms: 1 },
      { gate: "gate3", name: "诊断", ok: false, ms: 1 },
      { gate: "gate4", name: "生效边界", ok: true, ms: 0 },
    ],
  });
  // 另一个没有 findings 的 run：不产生报告
  writeRun(evolutionDir, "r9", { status: "reviewed" });

  const state = collectWebState({ evolutionDir });
  assert.equal(state.reports.length, 1);
  const report = state.reports[0]!;
  assert.equal(report.runId, "r8");
  assert.equal(report.trigger, "manual");
  assert.equal(report.findings.total, 6);
  assert.equal(report.findings.rows.length, 5, "只列前 5 条");
  assert.deepEqual(report.findings.rows[0], { skill: "demo", kind: "未加载", reason: "B frontmatter 坏" });
  assert.deepEqual(report.findings.rows[1], { skill: "s2", kind: "已加载", reason: "—" });
  assert.equal(report.findings.rows[2]!.kind, "未曝光");
  assert.equal(report.proposal?.added, 5);
  assert.equal(report.proposal?.removed, 2);
  assert.equal(report.review?.blocking, 1);
  assert.equal(report.decision?.approver, "auto");
  assert.equal(report.verify?.gates.length, 5);
  assert.equal(report.verify?.gates[3]!.ok, false);
});

test("done：超过 50 条只留最近 50 条", () => {
  const evolutionDir = workspace();
  const items = Array.from({ length: DONE_LIMIT + 10 }, (_unused, index) =>
    item(`run-${index}`, { status: "superseded", createdAt: NOW + index * 1_000 }),
  );
  writeQueue(evolutionDir, items);
  const state = collectWebState({ evolutionDir });
  assert.equal(state.done.length, DONE_LIMIT);
  assert.equal(state.done[0]!.runId, `run-${DONE_LIMIT + 9}`, "第一条是最新的");
  assert.equal(state.done.at(-1)!.runId, "run-10", "最早的十条被截掉");
});

test("applied：超过 50 条只留最近 50 条（看不过来的历史不当成待处理）", () => {
  const evolutionDir = workspace();
  const items = Array.from({ length: APPLIED_LIMIT + 10 }, (_unused, index) =>
    item(`run-${index}`, { status: "applied", createdAt: NOW + index * 1_000 }),
  );
  writeQueue(evolutionDir, items);
  const state = collectWebState({ evolutionDir });
  assert.equal(state.applied.length, APPLIED_LIMIT);
  assert.equal(state.applied[0]!.runId, `run-${APPLIED_LIMIT + 9}`, "第一条是最新的");
  assert.equal(state.applied.at(-1)!.runId, "run-10", "最早的十条被截掉");
  assert.equal(state.applied[0]!.gatesOk, null, "没有 06-verify.json 就是「无记录」，不是「全 ok」");
  assert.equal(state.applied[0]!.appliedAt, NOW + (APPLIED_LIMIT + 9) * 1_000, "没有 04-decision 就退回入队时刻");
});

test("summary：已采纳数取队列 applied，回滚率 = 回滚 / (采纳 + 回滚)", () => {
  const evolutionDir = workspace();
  writeQueue(evolutionDir, [
    item("a1", { status: "applied" }),
    item("a2", { status: "applied" }),
    item("a3", { status: "applied" }),
    item("b1", { status: "rolled-back" }),
  ]);
  const state = collectWebState({ evolutionDir });
  assert.equal(state.summary.appliedTotal, 3);
  assert.equal(state.summary.rollbackRate, 0.25);
});

/** 造 child.log 并回拨 mtime：模拟「子进程上次输出在 N 秒前」 */
function writeChildLog(runDir: string, lines: string[], mtimeMs: number): void {
  const file = path.join(runDir, "child.log");
  fs.writeFileSync(file, `${lines.join("\n")}\n`, "utf8");
  const at = new Date(mtimeMs);
  fs.utimesSync(file, at, at);
}

test("pending：正在跑的 run 排最前，阶段 / 进程 / 最近输出 / 看日志四行齐全", () => {
  const evolutionDir = workspace();
  writeRun(evolutionDir, "live", { status: "dispatched", pid: 1234, dispatchedAt: NOW - 90_000 });
  writeQueue(evolutionDir, [item("q1")]);
  const state = collectWebState({ evolutionDir, now: NOW, alive: (pid) => pid === 1234, maxRuntimeMs: 20 * 60_000 });
  assert.equal(state.pending[0]!.kind, "running", "正在跑的排最前，不排在待批后面");
  assert.equal(state.pending[0]!.runId, "live");
  const detail = state.pending[0]!.detail;
  assert.match(detail, /阶段：复盘产出中/);
  assert.match(detail, /进程：pid 1234 · 已跑 1m 30s（上限 20 分钟）/);
  assert.match(detail, /最近输出：（还没有输出）/, "child.log 还没生成时明确说没有输出");
  assert.match(detail, /日志：tail -f \.pi\/evolution\/runs\/live\/child\.log/);
  assert.equal(state.pending[1]!.kind, "approval", "待批排在运行中之后");
});

test("pending：督导活着 → 阶段写评审中，child.log 的 mtime 与末行都渲染出来", () => {
  const evolutionDir = workspace();
  const runDir = writeRun(evolutionDir, "live", {
    status: "dispatched",
    pid: 1234,
    supervisorPid: 5678,
    dispatchedAt: NOW - 5_000,
  });
  writeChildLog(runDir, ["第一行", "最后一行"], NOW - 12_000);
  const state = collectWebState({ evolutionDir, now: NOW, alive: (pid) => pid === 1234 || pid === 5678 });
  const detail = state.pending[0]!.detail;
  assert.match(detail, /阶段：评审中/, "督导在跑就是评审阶段");
  assert.match(detail, /末行：最后一行/);
  const seconds = Number(detail.match(/最近输出：(\d+)s 前/)![1]);
  assert.ok(Math.abs(seconds - 12) <= 1, `mtime 距今应按秒渲染（实际 ${seconds}s）`);
});

test("pending：pid 已死且没超时 → 不出现在待处理页（不当成在跑）", () => {
  const evolutionDir = workspace();
  writeRun(evolutionDir, "dead", { status: "dispatched", pid: 4321, dispatchedAt: NOW });
  const state = collectWebState({ evolutionDir, now: NOW, alive: () => false, maxRuntimeMs: 20 * 60_000 });
  assert.deepEqual(state.pending, []);
});

test("reports：卡死且没有 findings 的 run 也进档案，标 stale 并写明原因与日志末行", () => {
  const evolutionDir = workspace();
  const runDir = writeRun(evolutionDir, "stuck", { status: "stale", pid: 999, dispatchedAt: NOW - 600_000 });
  writeJson(path.join(runDir, "run-error.json"), {
    reason: "child-exited",
    at: NOW,
    childLogTail: ["跑了一半", "Error: 模板缺失"],
  });
  // reviewed 且无 findings 的 run 仍然不进档案（不是「失败」，只是没产出）
  writeRun(evolutionDir, "r9", { status: "reviewed" });
  const state = collectWebState({ evolutionDir });
  assert.equal(state.reports.length, 1, "每条 run 在档案里都要能找到一行，但不能把 reviewed 也算进来");
  const report = state.reports[0]!;
  assert.equal(report.runId, "stuck");
  assert.equal(report.status, "stale");
  assert.equal(report.findings.total, 0);
  assert.match(report.failure ?? "", /原因：子进程已退出/);
  assert.match(report.failure ?? "", /日志末行：Error: 模板缺失/);
});

test("approvals：只收 pending + approval 级，auto 级与已处理的行都不出现", () => {
  const evolutionDir = workspace();
  writeQueue(evolutionDir, [
    item("run-b", { level: "approval", createdAt: NOW + 2 }),
    item("run-a", { level: "approval", createdAt: NOW + 1 }),
    item("run-auto", { level: "auto", createdAt: NOW + 3 }),
    item("run-applied", { createdAt: NOW + 4, status: "applied" }),
    item("run-rejected", { createdAt: NOW + 5, status: "rejected" }),
  ]);
  const state = collectWebState({ evolutionDir });
  assert.deepEqual(
    state.approvals.map((row) => row.runId),
    ["run-a", "run-b"],
    "只留 approval 且 pending，按 createdAt 升序（先来的先批）",
  );
});

test("approvals：带 proposal 增删行与 review 的 verdict/blocking 条数", () => {
  const evolutionDir = workspace();
  const runDir = writeRun(evolutionDir, "run-full");
  // 增删行数是数 02-proposal.diff 的 +/- 行，不是读 json 字段
  writeJson(path.join(runDir, "02-proposal.json"), { type: "improve", skill: "demo" });
  fs.writeFileSync(
    path.join(runDir, "02-proposal.diff"),
    "--- a/.pi/skills/demo/SKILL.md\n+++ b/.pi/skills/demo/SKILL.md\n@@ -1,1 +1,2 @@\n-旧\n+新\n+又一行\n",
    "utf8",
  );
  writeJson(path.join(runDir, "03-review.json"), {
    verdict: "pass",
    blocking: [{ id: "P1", text: "缺成功征兆" }, { id: "P2", text: "步骤不完整" }],
  });
  writeQueue(evolutionDir, [item("run-full", { detail: "正文改动，需人批" })]);
  const row = collectWebState({ evolutionDir }).approvals[0]!;
  assert.equal(row.skill, "demo");
  assert.deepEqual(row.targets, [".pi/skills/demo/SKILL.md"]);
  assert.equal(row.proposal?.type, "improve");
  assert.equal(row.proposal?.added, 2);
  assert.equal(row.proposal?.removed, 1);
  assert.deepEqual(row.review, { verdict: "pass", blocking: 2 });
  assert.equal(row.detail, "正文改动，需人批");
});

test("approvals：缺 proposal / review 文件时给 null，不抛也不编造数字", () => {
  const evolutionDir = workspace();
  writeQueue(evolutionDir, [item("run-bare")]);
  const row = collectWebState({ evolutionDir }).approvals[0]!;
  assert.equal(row.proposal, null);
  assert.equal(row.review, null);
  assert.equal(row.createdAt, NOW);
});

test("collectControls：两个开关各读各的字段（采集关、复盘开这个中间态要能显示出来）", () => {
  const evolutionDir = workspace();
  fs.writeFileSync(path.join(evolutionDir, "config.json"), JSON.stringify({ enabled: true, telemetry: false }), "utf8");
  const controls = collectControls(evolutionDir);
  assert.deepEqual([controls.telemetry, controls.enabled], [false, true]);
  assert.equal(controls.lastActivityAt, null, "没有任何遥测 / run 时最后活动为 null，不编造时间");
});
