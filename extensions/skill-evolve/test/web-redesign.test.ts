/**
 * 列表页重做的验收测试（node --test）：分组、表格五列、时间与提案格式、徽章、空态、分页，
 * 以及用户现场报过的「待处理一直帮我收起」（默认不自动刷新、分组默认展开、`open=none` 才收起）。
 *
 * 纪律：全部走 `renderPage` 的纯字符串渲染 + 本文件现造的 state，不读真实 `.pi/evolution`。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import type { DoneItem, PendingItem, WebState } from "../lib/web/data.ts";
import { renderPage } from "../lib/web/render.ts";
import { STYLE } from "../lib/web/style.ts";
import { formatClock, formatIso } from "../lib/web/text.ts";

const NOW = new Date(2026, 10, 8, 21, 57, 3).getTime();
const T_LATE = new Date(2026, 10, 8, 19, 35).getTime();
const T_EARLY = new Date(2026, 10, 7, 18, 24).getTime();
const SID = "01a1b90f-08c3-722c-871d-d024b083770a";
const SESSION = { sessionId: SID, sessionFile: "/tmp/demo.jsonl" };
const NO_SESSION = { sessionId: null, sessionFile: null };

function emptyState(): WebState {
  return {
    pending: [],
    approvals: [],
    applied: [],
    done: [],
    reports: [],
    summary: { reviewing: 0, stale: 0, pendingApprovals: 0, appliedTotal: 0, rollbackRate: 0 },
  };
}

function pending(runId: string, at: number, parts: Partial<PendingItem> = {}): PendingItem {
  return { runId, kind: "approval", session: SESSION, skill: "demo", at, detail: "", ...parts };
}

function doneItem(runId: string, status: string, at: number): DoneItem {
  return { runId, status, source: "run", level: "-", skill: "demo", at, detail: "", session: NO_SESSION };
}

function withPending(items: PendingItem[]): WebState {
  const state = emptyState();
  state.pending = items;
  return state;
}

test("分组：同一会话的多条 run 合成一个 <details open>，标题写「条数 · 最近 · 几条要处理」", () => {
  const html = renderPage(withPending([pending("run-1", T_EARLY), pending("run-2", T_LATE)]), "pending", { now: NOW });
  assert.match(html, /<details class="grp" open>\n<summary><a class="sess" [^>]*>会话 01a1b90f<\/a> · 2 条 · 最近 19:35 · 2 条需要处理<\/summary>/);
});

test("分组标题：全部已处理时写「无待办」，不写「0 条需要处理」", () => {
  const html = renderPage(
    withPending([pending("run-1", T_EARLY, { kind: "reviewed" }), pending("run-2", T_LATE, { kind: "reviewed" })]),
    "pending",
    { now: NOW },
  );
  assert.match(html, /· 2 条 · 最近 19:35 · 无待办<\/summary>/);
});

test("单条会话的 run 不进组：直接一行表格，会话名写在状态格里", () => {
  const html = renderPage(withPending([pending("run-1", T_LATE)]), "pending", { now: NOW });
  assert.equal(html.includes('<details class="grp"'), false, "一条没必要折叠");
  assert.match(html, /<span class="sk-sess"><a class="sess" href="[^"]+" title="01a1b90f[^"]*">会话 01a1b90f<\/a><\/span>/);
});

test("操作列只写「详情 · 日志」，runId 只在链接 title 与详情页里", () => {
  const runId = "354df7db-1794133942";
  const html = renderPage(withPending([pending(runId, T_LATE)]), "pending", { now: NOW });
  assert.match(html, new RegExp(`<a class="rid" href="/\\?view=run&amp;runId=${runId}" title="${runId}">详情</a>`));
  // 「详情 …94133942」这种半截 runId 不再出现在页面上（只读面板没有重跑，操作就是 详情 · 日志）
  assert.equal(html.includes(`…${runId.slice(-8)}`), false, "操作列不再显示 runId 尾巴");
  const cells = html.slice(html.indexOf('<td class="status">'), html.indexOf('<td class="ops">'));
  assert.equal(cells.includes(runId.slice(0, 8)), false, "runId 前缀不该占着行首");
});

test("操作列文案：只读「详情 · 日志」，可写「详情 · 重跑 · 日志」", () => {
  const readonly = renderPage(withPending([pending("run-ops", T_LATE)]), "pending", { now: NOW });
  assert.match(readonly, /<td class="ops"><a class="rid"[^>]*>详情<\/a> · <a href="\/log\?runId=run-ops">日志<\/a><\/td>/);
  const writable = renderPage(withPending([pending("run-ops", T_LATE)]), "pending", {
    now: NOW,
    canWrite: true,
    csrf: "t",
  });
  assert.match(
    writable,
    /<td class="ops"><a class="rid"[^>]*>详情<\/a> · <form[\s\S]*?value="rerun"[\s\S]*?<\/form> · <a href="\/log\?runId=run-ops">日志<\/a><\/td>/,
  );
});

test("tab 计数是 .cnt 徽章，当前 tab 的计数用 --blue 底", () => {
  const html = renderPage(withPending([pending("run-1", T_LATE), pending("run-2", T_EARLY)]), "pending", { now: NOW });
  assert.match(html, /<a href="\/\?view=pending" class="active">待处理<span class="cnt">2<\/span><\/a>/);
  assert.match(html, /<a href="\/\?view=done">已处理<span class="cnt">0<\/span><\/a>/);
  assert.match(html, /\.tabs \.cnt \{[^}]*border-radius: 999px[^}]*\}/);
  assert.match(html, /\.tabs a\.active \.cnt \{ background: var\(--blue\)/);
});

test("时间：今天写 HH:mm，更早写 MM-DD HH:mm，title 一律是完整 ISO", () => {
  const state = emptyState();
  state.done = [doneItem("run-today", "applied", T_LATE), doneItem("run-old", "applied", T_EARLY)];
  const html = renderPage(state, "done", { now: NOW });
  const today = formatClock(T_LATE, NOW);
  const early = formatClock(T_EARLY, NOW);
  assert.equal(today.length, 5, "今天只给时分");
  assert.match(today, /^\d\d:\d\d$/);
  assert.match(early, /^\d\d-\d\d \d\d:\d\d$/);
  assert.match(html, new RegExp(`<td class="time" title="${formatIso(T_LATE)}">${today}</td>`));
  assert.match(html, new RegExp(`<td class="time" title="${formatIso(T_EARLY)}">${early}</td>`));
});

test("提案列：有增删写「+3 / -1」，没有就写占位符（不是空白）", () => {
  const state = emptyState();
  state.applied = [
    {
      runId: "run-a",
      session: NO_SESSION,
      level: "auto",
      skill: "demo",
      type: "improve",
      added: 3,
      removed: 1,
      appliedAt: T_LATE,
      gates: [],
      gatesOk: null,
    },
  ];
  assert.match(renderPage(state, "applied", { now: NOW }), /<td class="delta">\+3 \/ -1<\/td>/);
  // 待处理行没有提案数字（还没生成或还没采纳）
  assert.match(renderPage(withPending([pending("run-p", T_LATE)]), "pending", { now: NOW }), /<td class="delta"><span class="off">—<\/span><\/td>/);
});

test("徽章：七种状态各一色（待入队灰 / 待审批蓝 / 复盘中黄 / 已采纳绿 / 卡死红 / 已拒绝暗红 / 已回滚淡）", () => {
  const pendingCase = (kind: PendingItem["kind"], detail: string): string =>
    renderPage(withPending([pending("r1", T_LATE, { kind, detail })]), "pending", { now: NOW });
  const doneCase = (status: string): string => {
    const state = emptyState();
    state.done = [doneItem("r1", status, T_LATE)];
    return renderPage(state, "done", { now: NOW });
  };
  assert.match(pendingCase("reviewed", "详情"), /<span class="badge gray" title="详情">待入队<\/span>/);
  assert.match(pendingCase("approval", "详情"), /<span class="badge blue" title="详情">待审批<\/span>/);
  assert.match(pendingCase("running", "阶段：复盘产出中"), /<span class="badge yellow" title="阶段：复盘产出中">复盘中<\/span>/);
  assert.match(pendingCase("stale", "跑了 10 小时"), /<span class="badge red" title="跑了 10 小时">卡死<\/span>/);
  assert.match(doneCase("applied"), /<span class="badge green" title="">已采纳<\/span>/);
  assert.match(doneCase("rejected"), /<span class="badge darkred" title="">已拒绝<\/span>/);
  assert.match(doneCase("rolledback"), /<span class="badge faint" title="">已回滚<\/span>/);
  assert.match(doneCase("failed"), /<span class="badge red" title="">失败<\/span>/);
});

test("表格：五列固定表头，行是 <tr> 而不是卡片", () => {
  const html = renderPage(withPending([pending("run-1", T_LATE)]), "pending", { now: NOW });
  assert.match(html, /<table class="rows">/);
  assert.match(html, /<thead><tr><th class="status">状态<\/th><th class="time">时间<\/th><th class="skill">技能<\/th><th class="delta">提案<\/th><th class="ops">操作<\/th><\/tr><\/thead>/);
  assert.match(html, /<th class="ops">操作<\/th>/);
});

test("操作列：只读实例给「详情 · 日志」两个链接（不再是每行两个大按钮）", () => {
  const html = renderPage(withPending([pending("run-1", T_LATE)]), "pending", { now: NOW });
  assert.match(html, /<\/a> · <a href="[^"]*">日志<\/a>/);
  assert.equal(html.includes('name="name" value="rerun"'), false, "只读实例不该出现重跑表单");
});

test("操作列：可写实例才给「重跑」，卡死的才给「清理」", () => {
  const html = renderPage(withPending([pending("run-1", T_LATE)]), "pending", {
    now: NOW,
    canWrite: true,
    csrf: "tok",
  });
  assert.match(html, /name="name" value="rerun"/);
  assert.equal(html.includes('value="cleanup"'), false, "没卡死就不给清理");

  const staleHtml = renderPage(withPending([pending("run-1", T_LATE, { kind: "stale", detail: "跑了 10 小时" })]), "pending", {
    now: NOW,
    canWrite: true,
    csrf: "tok",
  });
  assert.match(staleHtml, /name="name" value="cleanup"/);
});

test("空态：一句话说清为什么空，再给一句下一步（带具体命令）", () => {
  const html = renderPage(emptyState(), "pending", { now: NOW });
  assert.match(html, /<p class="empty">暂无待处理：所有复盘都已完成，也没有待人批的改动。<\/p>/);
  assert.match(html, /<p class="next">.*\/skill-evolve dispatch on/);
});

test("分页：写「第 1 / 2 页 · 共 23 条」，下一页链接保留筛选参数", () => {
  const items = Array.from({ length: 23 }, (_, index) => pending(`run-${index}`, T_LATE - index * 1000));
  const state = withPending(items);
  const filter = { skill: "demo", status: "", range: "7d" as const, page: 1 };
  const html = renderPage(state, "pending", { now: NOW, filter });
  assert.match(html, /<p class="page"><span class="off">← 上一页<\/span> <span class="count">第 1 \/ 2 页 · 共 23 条<\/span> <a href="[^"]*">下一页 →<\/a><\/p>/);
  const next = /<a href="([^"]*)">下一页 →<\/a>/.exec(html)?.[1] ?? "";
  assert.ok(next.includes("skill=demo"), "技能筛选要留住");
  assert.ok(next.includes("range=7d"), "时间范围要留住");
  assert.ok(next.includes("page=2"), "翻到第 2 页");
});

test("默认不自动刷新：没有 meta refresh，只有「更新于 … · 刷新」", () => {
  const html = renderPage(withPending([pending("run-1", T_LATE)]), "pending", { now: NOW });
  assert.equal(html.includes('http-equiv="refresh"'), false, "默认整页重载会把展开态清掉");
  assert.match(html, /更新于 21:57:03 · <a href="[^"]+">刷新<\/a>/);
});

test("&live=1 才 5 秒重载，并在页头写清代价 + 给「关掉」", () => {
  const html = renderPage(withPending([pending("run-1", T_LATE)]), "pending", {
    now: NOW,
    extras: { live: true, open: "all", only: null },
  });
  assert.match(html, /<meta http-equiv="refresh" content="5; url=\/\?view=pending/);
  assert.match(html, /自动刷新中（每 5 秒整页重载，展开态会重置）· <a href="[^"]*">关掉<\/a>/);
  const off = /自动刷新中[^<]*· <a href="([^"]*)">关掉<\/a>/.exec(html)?.[1] ?? "";
  assert.equal(off.includes("live=1"), false, "关掉链接不能还带着 live=1");
});

test("live=1 只对待处理页生效：其它视图给了也忽略（数据不会自己变）", () => {
  const html = renderPage(emptyState(), "done", { now: NOW, extras: { live: true, open: "all", only: null } });
  assert.equal(html.includes('http-equiv="refresh"'), false);
  assert.equal(html.includes("自动刷新中"), false);
});

test("open=none 时分组不带 open 属性（用户点过「收起」，就靠 URL 记住）", () => {
  const items = [pending("run-1", T_EARLY), pending("run-2", T_LATE)];
  const open = renderPage(withPending(items), "pending", { now: NOW });
  assert.match(open, /<details class="grp" open>/);
  const closed = renderPage(withPending(items), "pending", { now: NOW, extras: { live: false, open: "none", only: null } });
  assert.match(closed, /<details class="grp">/);
  assert.equal(closed.includes('<details class="grp" open>'), false);
});

test("刷新链接保留原始 query：页码、时间范围、技能筛选一个都不丢", () => {
  const items = Array.from({ length: 23 }, (_, index) => pending(`run-${index}`, T_LATE - index * 1000));
  const filter = { skill: "demo", status: "", range: "30d" as const, page: 2 };
  const html = renderPage(withPending(items), "pending", { now: NOW, filter });
  const refresh = /更新于 [^·]*· <a href="([^"]+)">刷新<\/a>/.exec(html)?.[1] ?? "";
  assert.ok(refresh.includes("page=2"), "刷新不能把人弹回第 1 页");
  assert.ok(refresh.includes("range=30d"));
  assert.ok(refresh.includes("skill=demo"));
});

test("分组开关：有组才给「收起全部分组」，没有组不给点了没反应的链接", () => {
  const grouped = renderPage(withPending([pending("run-1", T_EARLY), pending("run-2", T_LATE)]), "pending", { now: NOW });
  assert.match(grouped, /<a href="[^"]*open=none">收起全部分组<\/a>/);
  const single = renderPage(withPending([pending("run-1", T_LATE)]), "pending", { now: NOW });
  assert.equal(single.includes("收起全部分组"), false);
});

test("顶部粘性区：摘要行四个数字 + 每个 tab 带计数徽章", () => {
  const state = withPending([pending("run-1", T_LATE), pending("run-2", T_EARLY)]);
  state.summary = { reviewing: 2, stale: 1, pendingApprovals: 0, appliedTotal: 5, rollbackRate: 0.2 };
  const html = renderPage(state, "pending", { now: NOW });
  assert.match(html, /<p class="sum">复盘中 2 · 卡死 1 · 待批 <a href="\/\?view=approvals">0<\/a> · 已采纳 <a href="\/\?view=applied">5<\/a>/);
  assert.match(html, /<a href="\/\?view=pending" class="active">待处理<span class="cnt">2<\/span><\/a>/);
});

test("窄屏靠 CSS 让位：≤900px 隐藏时间/提案列，宽屏才给左侧目录", () => {
  assert.match(STYLE, /\.hd \{ position: sticky; top: 0/);
  assert.ok(STYLE.includes("@media (max-width: 900px)"), "要有窄屏断点");
  assert.ok(STYLE.includes(".rows .time, .rows .delta { display: none }"), "窄屏让时间/提案列让位");
  assert.match(STYLE, /@media \(min-width: 1200px\)/);
  const html = renderPage(emptyState(), "pending", { now: NOW });
  assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
  assert.match(html, /max-width: 980px/);
});
