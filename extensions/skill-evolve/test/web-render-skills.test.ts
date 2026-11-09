/**
 * 技能管理页与技能详情页的渲染：六列表格、加载率的「—」、两种遥测空态、历史提案表。
 * 直接喂 SkillsView / SkillDetail（不读盘）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { WebState } from "../lib/web/data.ts";
import { renderSkillPage, renderSkillsPage } from "../lib/web/render-skills.ts";
import type { SkillDetail, SkillRow, SkillsView } from "../lib/web/skills.ts";

function state(): WebState {
  return {
    pending: [],
    approvals: [],
    applied: [],
    done: [],
    reports: [],
    summary: { reviewing: 0, stale: 0, pendingApprovals: 0, appliedTotal: 0, rollbackRate: 0 },
  };
}

function row(name: string, parts: Partial<SkillRow> = {}): SkillRow {
  return {
    name,
    exposed: 0,
    loaded: 0,
    rate: null,
    lastRunId: null,
    lastRunAt: null,
    hasPendingProposal: false,
    hasBaseline: false,
    ...parts,
  };
}

function view(rows: SkillRow[], parts: Partial<SkillsView> = {}): SkillsView {
  return { days: 30, rows, telemetryOn: true, events: 10, ...parts };
}

function detail(parts: Partial<SkillDetail> = {}): SkillDetail {
  return { name: "demo", days: 30, row: row("demo"), runs: [], telemetryOn: true, events: 10, ...parts };
}

test("技能列表：六列齐全，技能名与最近 run 都能点进详情", () => {
  const html = renderSkillsPage(
    view([
      row("demo", {
        exposed: 4,
        loaded: 1,
        rate: 0.25,
        lastRunId: "354df7db-1794133942",
        lastRunAt: 1794133942865,
        hasPendingProposal: true,
      }),
      row("quiet"),
    ]),
    state(),
  );
  assert.match(html, /<title>技能进化 · 技能管理<\/title>/);
  for (const head of ["技能", "曝光", "加载", "加载率", "最近一次相关 run", "状态"]) {
    assert.match(html, new RegExp(`<th>${head}</th>`));
  }
  assert.match(html, /<h2>技能（2 个，窗口 30 天）<\/h2>/);
  assert.match(html, /<a href="\/\?view=skill&amp;name=demo&amp;days=30">demo<\/a><\/td><td>4<\/td><td>1<\/td><td>25%<\/td>/);
  assert.match(html, /<a href="\/\?view=run&amp;runId=354df7db-1794133942">354df7db…3942<\/a>/);
  assert.match(html, /<span class="tag warn">有待批提案<\/span>/);
  assert.equal(html.includes(".cursor stub"), false, "缺 .cursor stub 检查已移除");
  // 没曝光的技能写「—」而不是 0%：0% 会被当成「一百次曝光一次没加载」
  assert.match(html, /<td><a href="\/\?view=skill&amp;name=quiet&amp;days=30">quiet<\/a><\/td><td>0<\/td><td>0<\/td><td>—<\/td>/);
});

test("空遥测两种说法：采集关着 vs 采集开着但窗口内没事件", () => {
  const off = renderSkillsPage(view([row("demo")], { telemetryOn: false, events: 0 }), state());
  assert.match(off, /没有遥测数据（采集关着）/);
  assert.match(off, /曝光与加载都是 0 是因为没采集/);
  // 采集关着时数值是「不知道」而不是 0：一屏 0 会被读成「这些技能没人用」
  assert.match(off, /<td><a href="\/\?view=skill&amp;name=demo&amp;days=30">demo<\/a><\/td><td>—<\/td><td>—<\/td><td>—<\/td>/);
  const on = renderSkillsPage(view([row("demo")], { telemetryOn: true, events: 0, days: 7 }), state());
  assert.match(on, /最近 7 天没有遥测事件/);
  assert.equal(on.includes("采集关着"), false);
});

test("窗口切换：当前窗口是字不是链接，另外两个可点", () => {
  const html = renderSkillsPage(view([row("demo")], { days: 7 }), state());
  assert.match(html, /<span class="on">近 7 天<\/span>/);
  assert.match(html, /<a href="\/\?view=skills&amp;days=30">近 30 天<\/a>/);
  assert.match(html, /近 90 天/);
});

test("技能详情：统计一行 + 历史提案表（run / 状态 / 时间 / 提案 / verdict / action）", () => {
  const html = renderSkillPage(
    detail({
      row: row("demo", { exposed: 4, loaded: 2, rate: 0.5, hasBaseline: true }),
      runs: [
        {
          runId: "354df7db-1794133942",
          status: "rejected",
          at: 1794133942865,
          type: "improve",
          added: 3,
          removed: 1,
          verdict: "revise",
          action: "forbidden",
        },
      ],
    }),
    state(),
  );
  assert.match(html, /<title>技能进化 · 技能 demo<\/title>/);
  assert.match(html, /曝光 <b>4<\/b> · 加载 <b>2<\/b> · 加载率 <b>50%<\/b> · 窗口 30 天/);
  assert.match(html, /<span class="tag fail">存量违规<\/span>/);
  assert.match(html, /<a href="\/\?view=run&amp;runId=354df7db-1794133942">354df7db…3942<\/a><\/td><td>rejected<\/td>/);
  assert.match(html, /improve \+3\/-1<\/td><td>revise<\/td><td>forbidden<\/td>/);
  assert.match(html, /<a href="\/\?view=skills">← 回技能管理<\/a>/);
});

test("技能详情空态：没有提案时说明是 runs/ 里没这个技能的提案，不是页面坏了", () => {
  const html = renderSkillPage(detail(), state());
  assert.match(html, /还没有针对 demo 的提案：runs\/ 里没有 skill=demo 的 02-proposal\.json。/);
  const gone = renderSkillPage(detail({ name: "gone", row: null, runs: [] }), state());
  assert.match(gone, /gone 不在 \.pi\/skills 目录里（可能已改名或删除）/);
});

test("技能详情也守同一条：采集关着时曝光/加载写「—」，不写 0", () => {
  const html = renderSkillPage(detail({ telemetryOn: false, events: 0 }), state());
  assert.match(html, /曝光 <b>—<\/b> · 加载 <b>—<\/b> · 加载率 <b>—<\/b> · 窗口 30 天/);
});

test("技能列表空目录：说清是工作区根路径推断错了，不是「没有技能」", () => {
  const html = renderSkillsPage(view([], { events: 0 }), state());
  assert.match(html, /\.pi\/skills 下没有技能目录/);
});
