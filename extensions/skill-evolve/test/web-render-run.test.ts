/**
 * run 详情页的渲染：概要 / diff 着色与截断 / 评审证据表 / 五闸 / 缺块空态。
 * 直接喂 RunDetail 对象（不读盘）：这一层只负责拼 HTML，读盘由 run-detail.ts 的单测覆盖。
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { WebState } from "../lib/web/data.ts";
import type { RunDetail } from "../lib/web/run-detail.ts";
import { renderRunPage } from "../lib/web/render-run.ts";

const RUN_ID = "354df7db-1794133942";

const DIFF_TEXT = [
  "--- a/.pi/skills/demo/SKILL.md",
  "+++ b/.pi/skills/demo/SKILL.md",
  "@@ -1,2 +1,2 @@",
  " ---",
  "-description: 旧",
  "+description: 新",
].join("\n");

function state(): WebState {
  return {
    pending: [],
    approvals: [],
    applied: [],
    done: [],
    reports: [],
    summary: { reviewing: 1, stale: 0, pendingApprovals: 2, appliedTotal: 3, rollbackRate: 0.25 },
  };
}

function detail(parts: Partial<RunDetail> = {}): RunDetail {
  return {
    runId: RUN_ID,
    status: "rejected",
    trigger: "auto",
    skill: "demo",
    startedAt: 1794133942865,
    endedAt: 1794134158913,
    pid: 65757,
    hasChildLog: true,
    diff: DIFF_TEXT,
    candidateSkill: "demo",
    candidateText: "---\nname: demo\n---\n# 改后\n",
    // 默认形态 = 仓库里真实的老 run（354df7db-1794133942）：03-review.json 没有 summary / passed
    review: {
      status: "rejected",
      verdict: "revise",
      action: "forbidden",
      reviewerModel: "deepseek/deepseek-flash",
      summary: null,
      legacy: true,
    },
    blocking: [
      {
        issue: "描述承诺大于正文能力",
        file: ".pi/skills/demo/SKILL.md",
        line: 3,
        quote: "<script> 引用",
      },
    ],
    passed: [],
    gates: [
      { gate: "gate0", name: "授权核对", ok: true, detail: "" },
      { gate: "gate3", name: "复验", ok: false, detail: "复验失败" },
    ],
    verifyStatus: "applied",
    findings: [{ skill: "demo", reason: "G", confidence: "high", lines: [578, 622] }],
    findingsTotal: 1,
    notes: "",
    // 流水线固定在详情页顶部：夹具给一条「已驳回」的完整链路，断言单独在 test/pipeline.test.ts
    pipeline: {
      stages: [
        { key: "dispatch", label: "派发", state: "done", detail: "复盘子进程 pid 65757 已退出", at: 1794133942865 },
        { key: "analyze", label: "分析", state: "done", detail: "01-findings.json 已落盘", at: 1794134000000 },
        { key: "propose", label: "提案", state: "done", detail: "improve → demo", at: 1794134050000 },
        { key: "review", label: "评审", state: "done", detail: "rejected / revise", at: 1794134158913 },
        { key: "apply", label: "采纳", state: "skipped", detail: "评审驳回，不会采纳", at: null },
      ],
      hint: "流程结束：卡在「采纳」— 评审驳回，不会采纳",
    },
    ...parts,
  };
}

test("概要：runId / 状态 / 技能 / 触发 / 开始结束 / pid / child.log 一次列全", () => {
  const html = renderRunPage(detail(), { state: state() });
  assert.match(html, /<title>技能进化 · run 354df7db-1794133942<\/title>/);
  assert.match(html, /<span class="k">runId<\/span><span class="v"><code>354df7db-1794133942<\/code><\/span>/);
  assert.match(html, /<span class="k">状态<\/span><span class="v">rejected<\/span>/);
  assert.match(html, /<span class="k">技能<\/span><span class="v">demo<\/span>/);
  assert.match(html, /<span class="k">触发<\/span><span class="v">auto<\/span>/);
  assert.match(html, /<span class="k">pid<\/span><span class="v">65757<\/span>/);
  assert.match(html, /<a href="\/log\?runId=354df7db-1794133942">child\.log<\/a>/);
  assert.match(html, /已采纳 <a href="\/\?view=applied">3<\/a>/, "详情页也带同一份状态栏");
});

test("diff：+ 绿底 / - 红底 / @@ 灰字三类 class 与两列行号都在", () => {
  const html = renderRunPage(detail(), { state: state() });
  assert.match(html, /<pre class="diff">/);
  assert.match(html, /<span class="dl file">/);
  assert.match(html, /<span class="dl hunk">/);
  assert.match(html, /<span class="dl del"><span class="ln old">2<\/span><span class="ln new"> {1}<\/span>/);
  assert.match(html, /<span class="dl add"><span class="ln old"> {1}<\/span><span class="ln new">2<\/span>/);
  assert.match(html, /diff 共 6 行。/);
  assert.equal(html.includes("完整 diff"), false, "没截断就不给下载链接");
});

test("diff 超 400 行：只渲前 400 行，并给 /diff 完整下载链接", () => {
  const body = Array.from({ length: 500 }, (_unused, index) => ` line ${index + 1}`);
  const diff = ["--- a/x", "+++ b/x", "@@ -1,500 +1,500 @@", ...body].join("\n");
  const html = renderRunPage(detail({ diff }), { state: state() });
  assert.match(html, /diff 共 503 行，页面只渲染前 400 行/);
  assert.match(html, /<a class="btn" href="\/diff\?runId=354df7db-1794133942">完整 diff<\/a>/);
  assert.equal(html.match(/class="dl /g)?.length, 400);
});

test("评审结论：verdict/action/模型 + blocking 表格（file:line 与引用），不是把 JSON 倒出来", () => {
  const html = renderRunPage(detail(), { state: state() });
  assert.match(html, /verdict <b class="fail">revise<\/b>/);
  assert.match(html, /action <b>forbidden<\/b>/);
  assert.match(html, /<code>deepseek\/deepseek-flash<\/code>/);
  assert.match(html, /<h3>阻断意见<\/h3>/);
  assert.match(html, /<td>描述承诺大于正文能力<\/td><td><code>\.pi\/skills\/demo\/SKILL\.md:3<\/code><\/td>/);
  assert.match(html, /&lt;script&gt; 引用/, "引用原文也要转义");
  assert.equal(html.includes('"blocking"'), false, "blocking 要做成表格，不许把 JSON 直接倒出来");
});

test("评审结论：summary 用大一号的字单独一行，排在 verdict 之后、理由表之前", () => {
  const html = renderRunPage(
    detail({ review: { ...detail().review!, summary: "因为 description 承诺了正文没有的能力", legacy: false } }),
    { state: state() },
  );
  assert.match(html, /<p class="verdict-summary">因为 description 承诺了正文没有的能力<\/p>/);
  const summaryAt = html.indexOf('class="verdict-summary"');
  assert.ok(summaryAt > html.indexOf('class="kv-line"'), "摘要要在 verdict 那一行之后");
  assert.ok(summaryAt < html.indexOf("<h3>阻断意见</h3>"), "摘要要在理由表之前");
});

test("评审结论：通过时列通过理由表（通过点 + 证据），不写阻断意见段", () => {
  const html = renderRunPage(
    detail({
      status: "reviewed",
      review: { status: "reviewed", verdict: "pass", action: "auto", reviewerModel: "m", summary: "新增条款只约束脚本用法，未碰原有禁令", legacy: false },
      blocking: [],
      passed: [{ point: "没有删除任何明确禁止项", file: "<b>", line: 5, quote: "一律用 rg" }],
    }),
    { state: state() },
  );
  assert.match(html, /verdict <b class="ok">pass<\/b>/);
  assert.match(html, /<h3>通过理由<\/h3>/);
  assert.match(html, /<th>通过点<\/th>/);
  assert.match(html, /<td>没有删除任何明确禁止项<\/td>/);
  assert.match(html, /&lt;b&gt;:5/, "证据里的尖括号也要转义");
  assert.equal(html.includes("阻断意见"), false, "没有 blocking 就没有阻断意见段");
});

test("评审结论：旧 run 没有 summary / passed 时显示兜底文案，不把空表当结论", () => {
  const html = renderRunPage(detail(), { state: state() });
  assert.match(html, /该 run 由旧版评审产出，没有结论摘要（重跑一次就有）/);
  assert.equal(html.includes("通过理由"), false);
  assert.equal(html.includes("只写了结论，没写理由"), false, "旧 run 已有兜底文案，不再叠一句");
});

test("评审结论：新版评审失败（无 summary，但写了 passed 键）说「没给理由」，不说成旧版", () => {
  const html = renderRunPage(
    detail({
      status: "review_failed",
      review: { status: "review_failed", verdict: "（未写 verdict）", action: "（未写 action）", reviewerModel: "m", summary: null, legacy: false },
      blocking: [],
      passed: [],
    }),
    { state: state() },
  );
  assert.match(html, /这一轮评审只写了结论，没写理由/);
  assert.equal(html.includes("旧版评审产出"), false, "新版评审失败不能标成旧版");
});

test("评审结论：新版评审两个理由表都空时说「只写了结论，没写理由」，不要说成旧版", () => {
  const html = renderRunPage(
    detail({ review: { ...detail().review!, summary: "跳过评审（配置关闭）", legacy: false }, blocking: [], passed: [] }),
    { state: state() },
  );
  assert.match(html, /03-review\.json 里没有 blocking \/ passed：这一轮评审只写了结论，没写理由。/);
  assert.equal(html.includes("旧版评审产出"), false);
});

test("五闸：逐条 ok/fail 上色，失败那条带说明", () => {
  const html = renderRunPage(detail(), { state: state() });
  assert.match(html, /<td><code>gate0<\/code><\/td><td>授权核对<\/td><td class="ok">ok<\/td>/);
  assert.match(html, /<td><code>gate3<\/code><\/td><td>复验<\/td><td class="fail">fail<\/td><td>复验失败<\/td>/);
  assert.match(html, /验证状态：applied/);
});

test("缺块空态：diff / 评审 / 五闸 / 候选全文各说清缺的是哪个文件", () => {
  const html = renderRunPage(
    detail({ diff: null, review: null, gates: [], verifyStatus: null, candidateText: null, candidateSkill: null, findingsTotal: 0, findings: [] }),
    { state: state() },
  );
  assert.match(html, /这个 run 没有 02-proposal\.diff/);
  assert.match(html, /没有 03-review\.json：这一轮还没评审完，或被跳过。/);
  assert.match(html, /没有 06-verify\.json：五闸未执行（这个 run 没被采纳）。/);
  assert.match(html, /没有 candidate\/demo\/SKILL\.md/);
  assert.match(html, /01-findings\.json 里没有条目/);
});

test("详情页不高亮任何 tab：点上去回不到这一页，highligh 就是在骗人", () => {
  const html = renderRunPage(detail(), { state: state() });
  const nav = html.slice(html.indexOf("<nav>"), html.indexOf("</nav>"));
  assert.equal(nav.includes('class="active"'), false);
});

/**
 * 「等面板批准」的断点修复（2026-11-10）：采纳段卡在等人时，批准 / 拒绝按钮必须就在这句话下面。
 * 反过来也断言：没有注入写回调（只读实例）时不能出现按钮，否则点了必然 403。
 */
test("卡在等面板批准：给了 write 就渲染批准 / 拒绝，没给就不渲染", () => {
  const blocked = detail({
    pipeline: {
      stages: [
        { key: "dispatch", label: "派发", state: "done", detail: "复盘子进程 pid 65757 已退出", at: 1794133942865 },
        { key: "analyze", label: "分析", state: "done", detail: "01-findings.json 已落盘", at: 1794134000000 },
        { key: "propose", label: "提案", state: "done", detail: "improve → demo", at: 1794134050000 },
        { key: "review", label: "评审", state: "done", detail: "approved / pass", at: 1794134158913 },
        { key: "apply", label: "采纳", state: "blocked", detail: "自动采纳关着：等面板批准", at: null },
      ],
      hint: "下一步「采纳」— 自动采纳关着：等面板批准",
    },
  });
  const html = renderRunPage(blocked, { state: state(), write: { csrf: "tok-9" } });
  assert.match(html, /<form method="post" action="\/approve">/);
  assert.match(html, /<form method="post" action="\/reject">/);
  assert.match(html, /name="runId" value="354df7db-1794133942"/);
  assert.match(html, /name="csrf" value="tok-9"/);

  const readonly = renderRunPage(blocked, { state: state() });
  assert.equal(readonly.includes('action="/approve"'), false, "只读实例不该给一个点了必然 403 的按钮");
});
