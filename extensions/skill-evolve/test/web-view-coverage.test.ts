/**
 * 视图覆盖性单测（用户 2026-11-08：「tab 包含所有状态了吗?」）。
 *
 * `review_failed` / `abandoned` / `unauthorized_write` 这三种终态曾没有任何视图收，
 * 这些 run 在面板上直接消失、只能翻 `runs/` 目录。本文件钉住两件事：
 * 1. 行为：七种终态都真的能进「已处理」，徽章文案与颜色对得上；
 * 2. 结构：`RUN_STATUSES` 每一项至少被五个视图之一的判据清单收 ——
 *    以后新增状态却忘了接视图，这条测试会红并打印漏掉的状态，不会再静默消失。
 *
 * 五个清单都是各视图「判据旁边」的导出常量，而不是测试里另抄一份：抄一份的话，
 * 代码改了测试不会发现（rolledback 那种抄错字符的坑就是这么漏过去的）。
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { RUN_STATUSES, type RunSummary } from "../lib/runs.ts";
import { APPLIED_RUN_STATUSES } from "../lib/web/applied.ts";
import { APPROVALS_RUN_STATUSES } from "../lib/web/approvals.ts";
import { buildDone, DONE_STATUSES } from "../lib/web/done.ts";
import { PENDING_RUN_STATUSES } from "../lib/web/pending.ts";
import { doneRows } from "../lib/web/render-rows.ts";

const NOW = Date.UTC(2026, 10, 8, 12);

function workspace(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "skill-evolve-coverage-"));
  const evolutionDir = path.join(cwd, ".pi", "evolution");
  fs.mkdirSync(path.join(evolutionDir, "runs"), { recursive: true });
  return evolutionDir;
}

function run(runId: string, status: string, at: number): RunSummary {
  return {
    runId,
    status,
    dispatchedAt: at,
    sessionId: `session-${runId}`,
    sessionFile: null,
    coverage: null,
    pid: null,
    supervisorPid: null,
  };
}

test("三个曾静默消失的终态都进「已处理」，徽章文案与颜色对得上，排序仍是时间倒序", () => {
  const evolutionDir = workspace();
  const runs = [
    run("r-review-failed", "review_failed", NOW),
    run("r-abandoned", "abandoned", NOW + 1_000),
    run("r-unauthorized", "unauthorized_write", NOW + 2_000),
  ];
  const done = buildDone([], runs, evolutionDir);
  assert.deepEqual(
    done.map((item) => item.status),
    ["unauthorized_write", "abandoned", "review_failed"],
  );
  const rows = doneRows(done);
  const badge = (runId: string) => rows.find((row) => row.runId === runId)?.badge;
  assert.deepEqual(badge("r-review-failed"), { text: "评审失败", tone: "red", title: "" });
  assert.equal(badge("r-abandoned")?.text, "已放弃");
  assert.equal(badge("r-abandoned")?.tone, "faint");
  assert.equal(badge("r-unauthorized")?.text, "越权写入");
  assert.equal(badge("r-unauthorized")?.tone, "red");
});

test("覆盖性：RUN_STATUSES 每一项至少被一个视图的判据清单收", () => {
  const views: Record<string, readonly string[]> = {
    待处理: PENDING_RUN_STATUSES,
    待审批: APPROVALS_RUN_STATUSES,
    已采纳: APPLIED_RUN_STATUSES,
    已结束: DONE_STATUSES,
  };
  const missing = RUN_STATUSES.filter((status) => !Object.values(views).some((list) => list.includes(status)));
  assert.deepEqual(missing, [], `这些状态没有任何 tab 收，会在面板上直接消失：${missing.join("、")}`);
});

test("「已结束」清单里的每个状态都能真的被 buildDone 收到（防 rolledback 这种抄错字符）", () => {
  const evolutionDir = workspace();
  for (const status of DONE_STATUSES) {
    const done = buildDone([], [run(`r-${status}`, status, NOW)], evolutionDir);
    assert.equal(done.length, 1, `${status} 没进已处理`);
    assert.equal(done[0]?.status, status);
  }
});

test("七个终态都有中文徽章文案，不许回落成原始英文 status", () => {
  const evolutionDir = workspace();
  const runs = DONE_STATUSES.map((status, index) => run(`r-${status}`, status, NOW + index));
  const rows = doneRows(buildDone([], runs, evolutionDir));
  for (const status of DONE_STATUSES) {
    const badge = rows.find((row) => row.runId === `r-${status}`)?.badge;
    assert.ok(badge, `${status} 缺行`);
    assert.notEqual(badge.text, status, `${status} 回落成了原始英文：tone 表的键与真实 status 不一致`);
    assert.match(badge.text, /^[\u4e00-\u9fa5]+$/, `${status} 的文案不是中文`);
  }
});
