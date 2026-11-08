/**
 * 「已采纳」单独成 tab：列表只列 applied，已处理页一条 applied 都不许有。
 * 五闸结论分三种说法：全 ok / N 项失败 / 无记录（判不了 ≠ 没过）。
 *
 * 重做列表页后五闸不再单占一列，而是写进状态徽章的 `title`（鼠标停一下才展开）：
 * 表格一行只放五个字段，五闸属于「点进去之前想看」的次要信息。
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { AppliedItem } from "../lib/web/applied.ts";
import type { DoneItem, WebState } from "../lib/web/data.ts";
import { renderPage } from "../lib/web/render.ts";
import { appliedRows } from "../lib/web/render-rows.ts";

const NOW = new Date(2026, 10, 8, 12).getTime();
const NO_SESSION = { sessionId: null, sessionFile: null };

function item(parts: Partial<AppliedItem> = {}): AppliedItem {
  return {
    runId: "run-a-1794133942",
    session: NO_SESSION,
    level: "approval",
    skill: "demo",
    type: "improve",
    added: 3,
    removed: 1,
    appliedAt: NOW,
    gates: [
      { gate: "gate0", name: "授权核对", ok: true },
      { gate: "gate1", name: "备份", ok: true },
    ],
    gatesOk: true,
    ...parts,
  };
}

function done(runId: string, status: string, skill: string): DoneItem {
  return { runId, status, source: "run", level: "-", skill, at: NOW, detail: "", session: NO_SESSION };
}

function state(parts: Partial<WebState> = {}): WebState {
  return {
    pending: [],
    approvals: [],
    applied: [],
    done: [],
    reports: [],
    summary: { reviewing: 0, stale: 0, pendingApprovals: 0, appliedTotal: 1, rollbackRate: 0 },
    ...parts,
  };
}

test("已采纳行：状态徽章 + 时间 + 技能 + 提案增删 + 五闸结论（在 title 里）", () => {
  const [row] = appliedRows([item()]);
  assert.equal(row.badge.text, "已采纳");
  assert.equal(row.badge.tone, "green");
  assert.equal(row.badge.title, "approval 级 · 五闸：全 ok");
  assert.equal(row.skill, "demo");
  assert.deepEqual(row.delta, { type: "improve", added: 3, removed: 1 });
  assert.equal(row.at, NOW);
  // 表格里一眼能看到的：`+3 / -1`
  const html = renderPage(state({ applied: [item()] }), "applied", { now: NOW });
  assert.match(html, /<td class="delta">\+3 \/ -1<\/td>/);
  assert.match(html, /<td class="skill"><code>demo<\/code><\/td>/);
});

test("已采纳行：有一闸没过要说几项失败（提示这是异常）", () => {
  const [row] = appliedRows([item({ gates: [{ gate: "gate3", name: "复验", ok: false }], gatesOk: false })]);
  assert.equal(row.badge.title, "approval 级 · 五闸：1 项失败");
});

test("已采纳行：没有 06-verify.json 时写「无记录」，不写成「失败」", () => {
  const [row] = appliedRows([item({ gates: [], gatesOk: null })]);
  assert.equal(row.badge.title, "approval 级 · 五闸：无记录");
  const html = renderPage(state({ applied: [item({ gates: [], gatesOk: null })] }), "applied", { now: NOW });
  assert.equal(html.includes("项失败"), false);
});

test("已采纳页只列 applied；已处理页一条 applied 都没有（两页不再混）", () => {
  const shared = state({
    applied: [item({ runId: "run-applied" })],
    done: [done("run-rolled", "rolledback", "demo"), done("run-rejected", "rejected", "other")],
  });
  const appliedPage = renderPage(shared, "applied", { now: NOW });
  assert.match(appliedPage, /<title>技能进化 · 已采纳<\/title>/);
  assert.match(appliedPage, /<a href="\/\?view=applied" class="active">已采纳<span class="cnt">1<\/span><\/a>/);
  assert.match(appliedPage, /run-applied/);
  assert.equal(appliedPage.includes("run-rolled"), false, "回滚的不算已采纳");

  const donePage = renderPage(shared, "done", { now: NOW });
  assert.match(donePage, /<title>技能进化 · 已处理<\/title>/);
  assert.match(donePage, /run-rolled/);
  assert.match(donePage, /run-rejected/);
  assert.equal(donePage.includes("run-applied"), false, "applied 已经移出已处理页");
});

test("已采纳页空态：说清采纳过的连 diff 一起留在这里，并给下一步", () => {
  const html = renderPage(state(), "applied", { now: NOW });
  assert.match(html, /<p class="empty">还没有已采纳的提案：采纳过的会连 diff 一起留在这里。<\/p>/);
  assert.match(html, /<p class="next">.*\/skill-evolve dispatch on/);
});

test("已采纳页有筛选与分页，但没有自动刷新（历史页刷新会把人弹回顶部）", () => {
  const html = renderPage(state({ applied: [item()] }), "applied", { now: NOW });
  assert.match(html, /<form class="filter"/);
  assert.match(html, /<p class="page">/);
  assert.equal(html.includes('http-equiv="refresh"'), false);
});
