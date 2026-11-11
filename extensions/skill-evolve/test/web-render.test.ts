/** 只读面板的服务端渲染：HTML 转义（技能正文里可能有 <script>）、各视图标题与空态、状态栏数字。 */
import assert from "node:assert/strict";
import test from "node:test";
import type { WebState } from "../lib/web/data.ts";
import { escapeHtml, formatStamp, parseView, renderPage } from "../lib/web/render.ts";

const NOW = new Date(2026, 10, 8, 12).getTime();
const NO_SESSION = { sessionId: null, sessionFile: null };

function withApproval(): WebState {
  const state = emptyState();
  state.approvals.push({
    runId: "run-a",
    session: NO_SESSION,
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
    summary: { reviewing: 0, stale: 0, pendingApprovals: 0, appliedTotal: 0, rollbackRate: 0 },
  };
}

function withPending(head: string, detail: string): WebState {
  const state = emptyState();
  state.pending.push({ runId: "run-x", kind: "approval", skill: head, at: 0, detail, session: NO_SESSION });
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

test("四个视图：标题、active 标签与列表内容各就各位", () => {
  const state = withPending("demo", "详情");
  const pending = renderPage(state, "pending");
  assert.match(pending, /<title>技能进化 · 待处理<\/title>/);
  assert.match(pending, /<a href="\/\?view=pending" class="active">待处理<span class="cnt">1<\/span><\/a>/);
  // 列表里不再有「[待批] run-x · demo」这种行头：状态是徽章、runId 只在操作列
  assert.match(pending, /<span class="badge blue" title="详情">待落盘<\/span>/);
  assert.match(pending, /<td class="skill"><code>demo<\/code><\/td>/);

  const approvals = renderPage(withApproval(), "approvals");
  assert.match(approvals, /<title>技能进化 · 待落盘<\/title>/);
  assert.match(approvals, /<a href="\/\?view=approvals" class="active">待落盘<span class="cnt">1<\/span><\/a>/);
  assert.equal(approvals.includes("run-x"), false, "待审批页只收 approvals，不串待处理条目");

  const done = renderPage(state, "done");
  assert.match(done, /<title>技能进化 · 已结束<\/title>/);
  assert.match(done, /<a href="\/\?view=done" class="active">已结束<span class="cnt">0<\/span><\/a>/);
  assert.equal(done.includes("run-x"), false, "别的视图不能串内容");
});

test("六个 tab：顺序是 待处理 / 待落盘 / 已采纳 / 已结束 / 技能管理 / 设置（复盘报告已下线）", () => {
  const html = renderPage(emptyState(), "pending");
  // 只扫 nav：状态栏与页脚里也有 /?view=approvals 链接，整页扫会把它们算进来
  const nav = html.slice(html.indexOf('<nav class="tabs">'), html.indexOf("</nav>"));
  const order = [...nav.matchAll(/<a href="\/\?view=(\w+)"/g)].map((match) => match[1]);
  assert.deepEqual(order, ["pending", "approvals", "applied", "done", "skills", "settings"]);
  assert.equal(nav.includes("复盘报告"), false, "复盘报告 tab 已下线，导航里不许再出现");
});

test("空态：每个列表视图各有一句人话", () => {
  for (const [view, text] of [
    ["pending", "暂无待处理：所有复盘都已完成，也没有待人批的改动。"],
    ["approvals", "没有待落盘：队列里没有 status=pending 的提案。"],
    ["applied", "还没有已采纳的提案：采纳过的会连 diff 一起留在这里。"],
    ["done", "暂无已结束记录：还没有回滚、失败或被否决的提案。"],
  ] as const) {
    const html = renderPage(emptyState(), view);
    assert.match(html, new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.equal(html.includes("<ul>"), false, `${view} 空态不该有列表`);
  }
});

test("摘要行：四个数字按顺序，待批数字链到待审批页（回滚率不在这一行）", () => {
  const state = emptyState();
  state.summary = { reviewing: 2, stale: 1, pendingApprovals: 3, appliedTotal: 4, rollbackRate: 0.256 };
  const html = renderPage(state, "pending", { now: new Date(2026, 10, 8, 21, 57, 3).getTime() });
  assert.match(
    html,
    /<p class="sum">复盘中 2 · 卡死 1 · 待批 <a href="\/\?view=approvals">3<\/a> · 已采纳 <a href="\/\?view=applied">4<\/a> · 更新于 21:57:03 · <a href="[^"]+">刷新<\/a><\/p>/,
  );
});

test("页脚是本机面板口径：只绑 127.0.0.1、无鉴权、机器可读副本见 /api/state", () => {
  const html = renderPage(emptyState(), "pending");
  assert.match(html, /本机面板 · 只绑 127\.0\.0\.1 · 无鉴权/);
  assert.match(html, /机器可读副本见 <a href="\/api\/state">\/api\/state<\/a>/);
  // 面板已能开关 / 重跑 / 清理 / 批准，再说「只读、不能在这里点批准」就是过时文案
  assert.equal(html.includes("只读面板"), false);
  assert.equal(html.includes("不能在这里点批准"), false);
});

test("parseView：认 approvals / applied / done，其余回落待处理（reports 已下线）", () => {
  assert.equal(parseView("approvals"), "approvals");
  assert.equal(parseView("done"), "done");
  assert.equal(parseView("reports"), "pending", "复盘报告页已下线，旧链接回落待处理");
  assert.equal(parseView("pending"), "pending");
  assert.equal(parseView(null), "pending");
  assert.equal(parseView("bogus"), "pending");
});

test("formatStamp：null 给破折号，时间按本地 YYYY-MM-DD HH:mm", () => {
  assert.equal(formatStamp(null), "—");
  assert.equal(formatStamp(new Date(2026, 10, 8, 9, 5).getTime()), "2026-11-08 09:05");
});

test("自动刷新默认关闭：只有显式 &live=1 的待处理页才 5 秒重载", () => {
  const state = emptyState();
  assert.equal(renderPage(state, "pending").includes('http-equiv="refresh"'), false, "默认不刷新（刷新会丢展开态）");
  assert.match(renderPage(state, "pending", { extras: { live: true, open: "all", only: null } }), /http-equiv="refresh" content="5; url=\/\?view=pending/);
  // live 只对待处理页有意义：别的页给了也忽略
  assert.equal(
    renderPage(state, "done", { extras: { live: true, open: "all", only: null } }).includes('http-equiv="refresh"'),
    false,
    "看档案时刷新会把页面跳回去",
  );
});

test("待处理页：运行中的条目有自己的徽章，不是只给个数字", () => {
  const state = emptyState();
  state.pending.push({ runId: "run-live", kind: "running", skill: "", at: 0, detail: "阶段：复盘产出中", session: NO_SESSION });
  const html = renderPage(state, "pending");
  assert.match(html, /<span class="badge yellow" title="阶段：复盘产出中">复盘中<\/span>/);
});

test("待落盘页：条目上是 targets / 提案增删行 / verdict 与 blocking 条数", () => {
  const html = renderPage(withApproval(), "approvals");
  assert.match(html, /<span class="badge blue" title="approval 级（必须人批） · 目标：\.pi\/skills\/demo\/SKILL\.md · 评审：verdict=pass · blocking 0 条">待落盘<\/span>/);
  assert.match(html, /<td class="delta">\+3 \/ -1<\/td>/);
  assert.match(html, /<a class="rid" href="\/\?view=run&amp;runId=run-a" title="run-a">详情<\/a>/);
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

test("待审批页脚仍然写清「批准」等价于哪条 TUI 命令", () => {
  const html = renderPage(withApproval(), "approvals", { canWrite: true, csrf: "t" });
  assert.match(html, /在 TUI 敲 <code>\/skill-evolve approve &lt;runId&gt;<\/code>/);
  assert.match(html, /机器可读副本：<a href="\/api\/state">/);
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

test("控制条：四个独立开关，各自 post 到 /toggle?field=", () => {
  const html = renderPage(emptyState(), "pending", {
    controls: { telemetry: true, enabled: false, autoReview: false, autoApply: false, pendingAuto: 0, lastActivityAt: null },
    csrf: "tok",
    canWrite: true,
  });
  assert.match(html, /采集遥测：开/);
  assert.match(html, /自动复盘：关/);
  assert.match(html, /自动评审：关/);
  assert.match(html, /自动采纳：关/);
  // 四个按钮各自打自己的字段：一个按钮同时翻两个，就回到了「捆在一起」的老问题
  for (const field of ["telemetry", "enabled", "autoReview", "autoApply"]) {
    assert.equal(html.includes(`action="/toggle?field=${field}"`), true, field);
  }
  assert.match(html, /只写本地日志，不花 token/);
  assert.match(html, /会派生子进程，花 token/);
  assert.match(html, /关闭采集遥测/, "按钮文案是动作（当前开 → 关闭），不是状态的复读");
  assert.match(html, /开启自动复盘/);
  assert.match(html, /再起一个督导子进程，再花一份 token/);
  assert.match(html, /改 \.pi\/skills\/ 与 \.cursor\/ 文件，可回滚/);
  assert.equal(html.includes("复盘在跑但采集关着"), false, "两个状态正常时不带警告");
  // 只读（没 csrf）时两个开关只显示状态，不渲染表单
  const readonly = renderPage(emptyState(), "pending", {
    controls: { telemetry: false, enabled: false, autoReview: true, autoApply: true, pendingAuto: 2, lastActivityAt: null },
  });
  assert.match(readonly, /采集遥测：关/);
  assert.equal(readonly.includes("/toggle?field="), false);
});

test("控制条：自动采纳关着且队列有 auto 条时写「N 条待人工」，关了预警就消失", () => {
  const backlog = renderPage(emptyState(), "pending", {
    controls: { telemetry: true, enabled: true, autoReview: true, autoApply: false, pendingAuto: 3, lastActivityAt: null },
    csrf: "tok",
    canWrite: true,
  });
  assert.match(backlog, /⏸ 3 条 auto 提案待人工（自动采纳关着）/);
  // 采纳打开后那些条会被自动消化，提醒必须跟着消失（否则永远挂着一条假待办）
  const cleared = renderPage(emptyState(), "pending", {
    controls: { telemetry: true, enabled: true, autoReview: true, autoApply: true, pendingAuto: 3, lastActivityAt: null },
    csrf: "tok",
    canWrite: true,
  });
  assert.equal(cleared.includes("条 auto 提案待人工"), false);
});

test("控制条：只开复盘不采集时给一行警告，两个都开后警告消失", () => {
  const warn = renderPage(emptyState(), "pending", {
    controls: { telemetry: false, enabled: true, autoReview: true, autoApply: false, pendingAuto: 0, lastActivityAt: null },
    csrf: "tok",
    canWrite: true,
  });
  assert.match(warn, /<p class="warn">⚠ 复盘在跑但采集关着：归因只能靠原始会话，加载率不可得<\/p>/);
  const ok = renderPage(emptyState(), "pending", {
    controls: { telemetry: true, enabled: true, autoReview: true, autoApply: false, pendingAuto: 0, lastActivityAt: null },
    csrf: "tok",
    canWrite: true,
  });
  assert.equal(ok.includes("复盘在跑但采集关着"), false);
});
