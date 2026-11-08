/** 只读面板的服务端渲染：HTML 转义（技能正文里可能有 <script>）、各视图标题与空态、状态栏数字。 */
import assert from "node:assert/strict";
import test from "node:test";
import type { WebState } from "../lib/web/data.ts";
import { escapeHtml, formatStamp, parseView, renderPage } from "../lib/web/render.ts";

function withApproval(): WebState {
  const state = emptyState();
  state.approvals.push({
    runId: "run-a",
    skill: "demo",
    level: "approval",
    targets: [".pi/skills/demo/SKILL.md"],
    createdAt: new Date(2026, 10, 8, 12).getTime(),
    proposal: { type: "improve", added: 3, removed: 1 },
    review: { verdict: "pass", blocking: 0 },
    detail: "",
  });
  return state;
}

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

function withPending(head: string, detail: string): WebState {
  const state = emptyState();
  state.pending.push({ runId: "run-x", kind: "approval", skill: head, at: 0, detail });
  return state;
}

test("escapeHtml：五个字符全转，且 & 先转", () => {
  assert.equal(escapeHtml(`& < > " '`), "&amp; &lt; &gt; &quot; &#39;");
  assert.equal(escapeHtml("<script>alert(1)</script>"), "&lt;script&gt;alert(1)&lt;/script&gt;");
  assert.equal(escapeHtml("a&amp;b"), "a&amp;amp;b", "已转义文本再转一次也不会被二次解码");
});

test("渲染：技能名与详情里的 <script> 一律转义，页面里没有裸 <script>", () => {
  const html = renderPage(withPending("<script>alert(1)</script>", "证据：<script>x()</script>"), "pending");
  assert.equal(/<script/i.test(html), false, "不能出现裸 <script>");
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /&lt;script&gt;x\(\)&lt;\/script&gt;/);
});

test("渲染：findings 里的 HTML 也被转义（报告页同样不可注入）", () => {
  const state = emptyState();
  state.reports.push({
    runId: "run-1",
    status: "applied",
    trigger: "auto",
    startedAt: 0,
    findings: { total: 1, rows: [{ skill: "<img src=x onerror=alert(1)>", kind: "未加载", reason: "<b>没读</b>" }] },
    proposal: { type: "improve", skill: "demo", added: 3, removed: 1 },
    review: { status: "reviewed", verdict: "pass", blocking: 0 },
    decision: { status: "applied", approver: "auto", at: 0, detail: "<script>d</script>" },
    verify: { status: "applied", at: 0, gates: [{ gate: "gate0", name: "授权核对", ok: true }] },
  });
  const html = renderPage(state, "reports");
  assert.equal(/<img/i.test(html), false);
  assert.equal(/<script/i.test(html), false);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test("四个视图：标题、active 标签与列表内容各就各位", () => {
  const state = withPending("demo", "详情");
  const pending = renderPage(state, "pending");
  assert.match(pending, /<title>技能进化 · 待处理<\/title>/);
  assert.match(pending, /<a href="\/\?view=pending" class="active">待处理<\/a>/);
  assert.match(pending, /\[待批\] run-x · demo/);

  const approvals = renderPage(withApproval(), "approvals");
  assert.match(approvals, /<title>技能进化 · 待审批<\/title>/);
  assert.match(approvals, /<a href="\/\?view=approvals" class="active">待审批<\/a>/);
  assert.equal(approvals.includes("run-x"), false, "待审批页只收 approvals，不串待处理条目");

  const done = renderPage(state, "done");
  assert.match(done, /<title>技能进化 · 已处理<\/title>/);
  assert.match(done, /<a href="\/\?view=done" class="active">已处理<\/a>/);
  assert.equal(done.includes("[待批] run-x"), false, "别的视图不能串内容");

  const reports = renderPage(state, "reports");
  assert.match(reports, /<title>技能进化 · 复盘报告<\/title>/);
  assert.match(reports, /<a href="\/\?view=reports" class="active">复盘报告<\/a>/);
});

test("六个视图：tab 顺序是 待处理 / 待审批 / 已采纳 / 已处理 / 复盘报告 / 技能管理", () => {
  const html = renderPage(emptyState(), "pending");
  // 只扫 nav：状态栏与页脚里也有 /?view=approvals 链接，整页扫会把它们算进来
  const nav = html.slice(html.indexOf("<nav>"), html.indexOf("</nav>"));
  const order = [...nav.matchAll(/<a href="\/\?view=(\w+)"/g)].map((match) => match[1]);
  assert.deepEqual(order, ["pending", "approvals", "applied", "done", "reports", "skills"]);
});

test("空态：每个列表视图各有一句人话", () => {
  for (const [view, text] of [
    ["pending", "暂无待处理：所有复盘都已完成，也没有待人批的改动。"],
    ["approvals", "没有待批：auto 级不需要人批，approval 级的会出现在这里。"],
    ["applied", "还没有已采纳的提案：采纳过的会连 diff 一起留在这里。"],
    ["done", "暂无已处理记录：还没有回滚、失败或被否决的提案。"],
    ["reports", "暂无复盘报告：还没有 run 写过 01-findings.json。"],
  ] as const) {
    const html = renderPage(emptyState(), view);
    assert.match(html, new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.equal(html.includes("<ul>"), false, `${view} 空态不该有列表`);
  }
});

test("状态栏：五个数字按顺序，回滚率取整百分比，待批数字链到待审批页", () => {
  const state = emptyState();
  state.summary = { reviewing: 2, stale: 1, pendingApprovals: 3, appliedTotal: 4, rollbackRate: 0.256 };
  const html = renderPage(state, "pending");
  assert.match(
    html,
    /复盘中 2 · 卡死 1 · 待批 <a href="\/\?view=approvals">3<\/a> · 已采纳 <a href="\/\?view=applied">4<\/a> · 回滚率 26%/,
  );
});

test("报告详情：findings 条数、提案增删行、五闸对错都在展开区里", () => {
  const state = emptyState();
  state.reports.push({
    runId: "run-2",
    status: "applied",
    trigger: "manual",
    startedAt: 0,
    findings: { total: 7, rows: [{ skill: "demo", kind: "未加载", reason: "B frontmatter 坏" }] },
    proposal: { type: "improve", skill: "demo", added: 5, removed: 2 },
    review: { status: "reviewed", verdict: "pass", blocking: 1 },
    decision: null,
    verify: {
      status: "applied",
      at: 0,
      gates: [
        { gate: "gate0", name: "授权核对", ok: true },
        { gate: "gate3", name: "诊断", ok: false },
      ],
    },
  });
  const html = renderPage(state, "reports");
  assert.match(html, /findings：7 条/);
  assert.match(html, /…另有 6 条（见 01-findings\.json）/);
  assert.match(html, /提案：improve demo \+5\/-2/);
  assert.match(html, /blocking 1 条/);
  assert.match(html, /决策：未采纳（没有 04-decision\.json）/);
  assert.match(html, /gate0✓ gate3✗/);
});

test("页脚写清只读与采纳入口", () => {
  const html = renderPage(emptyState(), "pending");
  assert.match(html, /只读面板/);
  assert.match(html, /\/skill-evolve approve &lt;runId&gt;/);
  assert.match(html, /href="\/api\/state"/);
});

test("parseView：认 approvals / done / reports，其余回落待处理", () => {
  assert.equal(parseView("approvals"), "approvals");
  assert.equal(parseView("done"), "done");
  assert.equal(parseView("reports"), "reports");
  assert.equal(parseView("pending"), "pending");
  assert.equal(parseView(null), "pending");
  assert.equal(parseView("bogus"), "pending");
});

test("formatStamp：null 给破折号，时间按本地 YYYY-MM-DD HH:mm", () => {
  assert.equal(formatStamp(null), "—");
  assert.equal(formatStamp(new Date(2026, 10, 8, 9, 5).getTime()), "2026-11-08 09:05");
});

test("待处理页：5 秒自刷新只加在这一页，且刷完还在待处理", () => {
  const state = emptyState();
  assert.match(renderPage(state, "pending"), /<meta http-equiv="refresh" content="5; url=\?view=pending">/);
  assert.equal(renderPage(state, "done").includes('http-equiv="refresh"'), false, "看档案时刷新会把页面跳回去");
  assert.equal(renderPage(state, "reports").includes('http-equiv="refresh"'), false);
});

test("待处理页：运行中的条目有自己的徽章，不是只给个数字", () => {
  const state = emptyState();
  state.pending.push({ runId: "run-live", kind: "running", skill: "", at: 0, detail: "阶段：复盘产出中" });
  const html = renderPage(state, "pending");
  assert.match(html, /\[进行中\] run-live/);
});

test("复盘报告：卡死的 run 行首标 [卡死]，detail 里带失败原因", () => {
  const state = emptyState();
  state.reports.push({
    runId: "run-dead",
    status: "stale",
    trigger: "auto",
    startedAt: 0,
    findings: { total: 0, rows: [] },
    proposal: null,
    review: null,
    decision: null,
    verify: null,
    failure: "原因：子进程已退出\n日志末行：Error: 模板缺失",
  });
  const html = renderPage(state, "reports");
  assert.match(html, /\[卡死\] <a class="run" href="\/\?view=run&amp;runId=run-dead">run-dead<\/a>/);
  assert.match(html, /原因：子进程已退出/);
  assert.match(html, /日志末行：Error: 模板缺失/);
});

test("待审批页：条目上是 targets / 提案增删行 / verdict 与 blocking 条数", () => {
  const html = renderPage(withApproval(), "approvals");
  assert.match(html, /\[approval\] run-a · demo · improve \+3\/-1 · pass\/blocking 0/);
  assert.match(html, /目标：\.pi\/skills\/demo\/SKILL\.md/);
  assert.match(html, /提案：improve \+3\/-1 行/);
  assert.match(html, /评审：verdict=pass · blocking 0 条/);
  assert.match(html, /runId：run-a/, "详情第一行是完整 runId");
});

test("待审批页：注入回调 + csrf 时渲染批准与拒绝表单，csrf 与 runId 都是 hidden", () => {
  const html = renderPage(withApproval(), "approvals", { canWrite: true, csrf: "tok-123" });
  assert.match(html, /<form method="post" action="\/approve">/);
  assert.match(html, /<form method="post" action="\/reject">/);
  assert.equal(html.match(/name="csrf" value="tok-123"/g)?.length, 2, "两个表单各带一份 csrf");
  assert.equal(html.match(/name="runId" value="run-a"/g)?.length, 2, "两个表单各带一份 runId");
  assert.match(html, />批准</);
  assert.match(html, />拒绝</);
});

test("待审批页：没注入回调（canWrite 缺省）不渲染按钮，页脚写「本实例只读」", () => {
  const html = renderPage(withApproval(), "approvals");
  assert.equal(html.includes("<form"), false, "只读实例不能出现任何表单");
  assert.equal(html.includes("/approve"), false, "连 action 都不该出现");
  assert.match(html, /本实例只读/);
});

test("待审批页：显式 canWrite 但没有 csrf 也不渲染按钮（否则点了必 403）", () => {
  const html = renderPage(withApproval(), "approvals", { canWrite: true });
  assert.equal(html.includes("<form"), false);
});

test("待审批页脚：批准走同一套五道闸，拒绝不动任何技能文件", () => {
  const html = renderPage(withApproval(), "approvals", { canWrite: true, csrf: "t" });
  assert.match(html, /点「批准」= 在 TUI 敲/);
  assert.match(html, /走同一套五道闸/);
  assert.match(html, /「拒绝」只改队列状态，不动任何技能文件/);
});

test("待处理页脚：保留只读口径，并指向待审批页", () => {
  const html = renderPage(emptyState(), "pending");
  assert.match(html, /只读面板/);
  assert.match(html, /去<a href="\/\?view=approvals">待审批页<\/a>直接批/);
});

test("动作结果横幅：msg 与 err 都渲染且转义", () => {
  const ok = renderPage(emptyState(), "approvals", { notice: { kind: "msg", text: "已采纳 run-a" } });
  assert.match(ok, /<p class="notice">已采纳 run-a<\/p>/);
  const bad = renderPage(emptyState(), "approvals", { notice: { kind: "err", text: "<script>x</script>" } });
  assert.match(bad, /<p class="notice err">&lt;script&gt;x&lt;\/script&gt;<\/p>/);
  assert.equal(/<script/i.test(bad), false);
});

test("待审批页不做 5 秒自刷新：刷新会打断正在点的按钮", () => {
  assert.equal(renderPage(emptyState(), "approvals").includes('http-equiv="refresh"'), false);
});

test("控制条：采集与复盘是两个独立开关，各自 post 到 /toggle?field=", () => {
  const html = renderPage(emptyState(), "pending", {
    controls: { telemetry: true, enabled: false, lastActivityAt: null },
    csrf: "tok",
    canWrite: true,
  });
  assert.match(html, /采集遥测：开/);
  assert.match(html, /自动复盘：关/);
  // 两个按钮各自打自己的字段：一个按钮同时翻两个，就回到了「捆在一起」的老问题
  assert.equal(html.includes('action="/toggle?field=telemetry"'), true);
  assert.equal(html.includes('action="/toggle?field=enabled"'), true);
  assert.match(html, /只写本地日志，不花 token/);
  assert.match(html, /会派生子进程，花 token/);
  assert.match(html, /关闭采集遥测/, "按钮文案是动作（当前开 → 关闭），不是状态的复读");
  assert.match(html, /开启自动复盘/);
  assert.equal(html.includes("复盘在跑但采集关着"), false, "两个状态正常时不带警告");
  // 只读（没 csrf）时两个开关只显示状态，不渲染表单
  const readonly = renderPage(emptyState(), "pending", { controls: { telemetry: false, enabled: false, lastActivityAt: null } });
  assert.match(readonly, /采集遥测：关/);
  assert.equal(readonly.includes("/toggle?field="), false);
});

test("控制条：只开复盘不采集时给一行警告，两个都开后警告消失", () => {
  const warn = renderPage(emptyState(), "pending", {
    controls: { telemetry: false, enabled: true, lastActivityAt: null },
    csrf: "tok",
    canWrite: true,
  });
  assert.match(warn, /<p class="warn">⚠ 复盘在跑但采集关着：归因只能靠原始会话，加载率不可得<\/p>/);
  const ok = renderPage(emptyState(), "pending", {
    controls: { telemetry: true, enabled: true, lastActivityAt: null },
    csrf: "tok",
    canWrite: true,
  });
  assert.equal(ok.includes("复盘在跑但采集关着"), false);
});
