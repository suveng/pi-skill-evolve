/**
 * run 详情页（`?view=run&runId=...`）的渲染：概要 + 提案 diff + 改后全文 + 评审 + 五闸 + 发现。
 *
 * 为什么 diff 放最前：用户点进这一页 90% 是为了「看看它到底改了什么」。
 * 结论（评审 / 五闸）排在 diff 之后，因为先看结论再看改动的人，一定会回头再看改动。
 *
 * 六块各自的空态都要写明「缺的是哪个文件」—— 一句「暂无数据」会让人以为页面坏了。
 */
import { renderPipelineLine, type Pipeline, type PipelineStage } from "../pipeline.ts";
import type { WebState } from "./data.ts";
import { DIFF_PREVIEW_LINES, renderDiffLines, parseDiffLines } from "./diff-lines.ts";
import type { RunBlocking, RunDetail, RunPassing } from "./run-detail.ts";
import { sessionHref } from "./run-session.ts";
import { shellPage } from "./shell.ts";
import { escapeHtml, formatStamp } from "./text.ts";

/** 概要的一行：标签 + 值（值已转义） */
function kv(label: string, value: string): string {
  return `<div class="kv-row"><span class="k">${label}</span><span class="v">${value}</span></div>`;
}

/**
 * Agent 会话入口：提案 Agent 的会话就是 child.log（它的 stdout 全量），
 * 评审 Agent 的原始输出在 agent-review.log。两个都给同一个详情页里可点，不用去翻目录。
 */
/** Agent 会话链接：真会话文件在 runs/<id>/agents/ 里，用会话页渲染（角色过滤、工具折叠都能用） */
function agentSessionLink(runId: string, role: string, label: string): string {
  const href = `/?view=session&amp;runId=${encodeURIComponent(runId)}&amp;agent=${encodeURIComponent(role)}`;
  return `<a href="${href}">${escapeHtml(label)}</a>`;
}

function agentSection(detail: RunDetail): string {
  const rid = encodeURIComponent(detail.runId);
  const sessions = detail.agentSessions ?? [];
  const roleOf = (role: string): string | null => (sessions.some((item) => item.role === role) ? role : null);
  const analyzeRole = roleOf("analyze");
  const reviewRole = roleOf("review");
  const propose = detail.hasChildLog
    ? `<a href="/log?runId=${rid}&amp;file=child.log">child.log</a> <span class="hint">（提案 Agent 的完整输出）</span>`
    : `<span class="off">没有 child.log（这轮没派发出提案）</span>`;
  const review = detail.hasReviewLog
    ? `<a href="/log?runId=${rid}&amp;file=agent-review.log">agent-review.log</a> <span class="hint">（评审 Agent 的完整输出，两轮都在）</span>`
    : `<span class="off">没有 agent-review.log（这轮没起评审，或是 v0.1.20 之前的旧 run）</span>`;
  // 重写日志：评审不通过时提案 Agent 会重写，每一轮都要能点开看（不然「重写了 3 次」只是个数
  // 旧 fixture / 旧 run 可能没有这个字段，缺了当空数组，别让整页崩
  const rewriteLinks = (detail.rewriteLogs ?? []).map(
    (name) => `<a href="/log?runId=${rid}&amp;file=${encodeURIComponent(name)}">${escapeHtml(name)}</a>`,
  );
  const rewrite =
    rewriteLinks.length > 0
      ? `${rewriteLinks.join(" · ")} <span class="hint">（第 N 次重写的完整输出）</span>`
      : `<span class="off">没有重写日志（评审一次就过，或这一版还没评到）</span>`;
  // 有会话文件就给「会话」入口（能看问答轮次 + 工具调用），日志作为原始输出备查
  const withSession = (role: string | null, label: string, fallback: string): string =>
    role === null ? fallback : `${agentSessionLink(detail.runId, role, label)} ${fallback}`;
  const rewriteSessions = sessions
    .filter((item) => /^rewrite-\d+$/.test(item.role))
    .map((item) => agentSessionLink(detail.runId, item.role, `第 ${item.role.replace("rewrite-", "")} 次`));
  const rewriteAll =
    rewriteSessions.length > 0 ? `${rewriteSessions.join(" · ")} <span class="hint">（每次重写的会话）</span>` : rewrite;
  return `<section>
<h2>Agent 会话</h2>
<div class="kv">
${kv("提案 Agent", withSession(analyzeRole, "会话", propose))}
${kv("评审 Agent", withSession(reviewRole, "会话", review))}
${kv("重写 Agent", rewriteAll)}
</div>
<p class="hint">「会话」是 pi 落盘的完整对话（含工具调用），日志是它的原始 stdout；用户会话（这段对话本身）见上面的「会话」一行。</p>
</section>`;
}

function overview(detail: RunDetail): string {
  const log = detail.hasChildLog
    ? `<a href="/log?runId=${encodeURIComponent(detail.runId)}">child.log</a>`
    : `<span class="off">没有 child.log</span>`;
  // 会话：完整 sessionId 做成「会话详情」链接（列表行上只有前 8 位，这里给全的）
  const sessionFile = detail.sessionFile ?? null;
  const href = sessionHref({ sessionId: detail.sessionId ?? null, sessionFile });
  const session =
    href === null
      ? `<span class="off">run.json 没写 sessionId</span>`
      : `<a href="${escapeHtml(href)}"><code>${escapeHtml(detail.sessionId ?? "")}</code></a> <span class="hint">（点开看会话原文）</span>`;
  const sessionFileCell =
    sessionFile === null
      ? `<span class="off">run.json 没写 sessionFile</span>`
      : `<code>${escapeHtml(sessionFile)}</code>`;
  // 归属块放在最前：用户点进详情第一件事是「它现在属于哪个 tab、凭什么是它」，
  // 证据列给的是可以自己去 cat 的文件与字段值（判据见 ./tab-origin.ts，这里只显示）
  const evidence = detail.origin.evidence
    .map((item) => `<code>${escapeHtml(item)}</code>`)
    .join(" · ");
  const originBlock = `<section>
<h2>归属</h2>
<div class="kv">
${kv("现在在", `<a href="/?view=${detail.origin.tab}">${escapeHtml(detail.origin.label)}</a>`)}
${kv("为什么", escapeHtml(detail.origin.reason))}
${kv("证据", evidence)}
</div>
</section>
`;
  return originBlock + `<section>
<h2>概要</h2>
<div class="kv">
${kv("runId", `<code>${escapeHtml(detail.runId)}</code>`)}
${kv("状态", escapeHtml(detail.status))}
${kv("技能", escapeHtml(detail.skill.length > 0 ? detail.skill : "—"))}
${kv("触发", escapeHtml(detail.trigger))}
${kv("会话", session)}
${kv("会话文件", sessionFileCell)}
${kv("开始", escapeHtml(formatStamp(detail.startedAt)))}
${kv("结束", escapeHtml(formatStamp(detail.endedAt)) + (detail.endedAt === null ? "" : ' <span class="hint">（取最后一个产出时刻）</span>'))}
${kv("pid", detail.pid === null ? "—" : String(detail.pid))}
${kv("日志", log)}
</div>
</section>`;
}

/** 提案 diff：逐行统一 diff；超 400 行只渲染前 400 行并给完整下载链接 */
function diffSection(detail: RunDetail): string {
  if (detail.diff === null) {
    return `<section>
<h2>提案 diff</h2>
<p class="empty">这个 run 没有 02-proposal.diff：提案阶段没写出改动（或已被清理）。</p>
</section>`;
  }
  const lines = parseDiffLines(detail.diff);
  const shown = lines.slice(0, DIFF_PREVIEW_LINES);
  const truncated = lines.length > shown.length;
  const note = truncated
    ? `<p class="hint">diff 共 ${lines.length} 行，页面只渲染前 ${DIFF_PREVIEW_LINES} 行：
<a class="btn" href="/diff?runId=${encodeURIComponent(detail.runId)}">完整 diff</a></p>`
    : `<p class="hint">diff 共 ${lines.length} 行。</p>`;
  return `<section>
<h2>提案 diff</h2>
${note}
${renderDiffLines(shown)}
</section>`;
}

/** 改后全文：`<details>` 折叠，默认收起（全文可能很长） */
function candidateSection(detail: RunDetail): string {
  if (detail.candidateText === null) {
    return `<section>
<h2>改后全文</h2>
<p class="empty">没有 candidate/${escapeHtml(detail.skill || "<技能名>")}/SKILL.md：这个 run 没留候选文件。</p>
</section>`;
  }
  const lines = detail.candidateText.split(/\r?\n/).length;
  return `<section>
<h2>改后全文</h2>
<details><summary>candidate/${escapeHtml(detail.candidateSkill ?? "")}/SKILL.md（${lines} 行）</summary>
<pre class="candidate">${escapeHtml(detail.candidateText)}</pre>
</details>
</section>`;
}

/** 旧 run 的兼容文案：03-review.json 没有 summary / passed 时明说「不是页面坏了」 */
const LEGACY_REVIEW_NOTE = "该 run 由旧版评审产出，没有结论摘要（重跑一次就有）";
/** 新版评审也确实可能两块全空（比如 skipped）：那时不能说「旧版」，要说「没给理由」 */
const NO_REASON_NOTE = "03-review.json 里没有 blocking / passed：这一轮评审只写了结论，没写理由。";

/** 理由表的一行：blocking 用 issue、passed 用 point，但三列形状一样（说明 / 证据位置 / 原文引用） */
interface ReasonRow {
  text: string;
  file: string;
  line: number | null;
  quote: string;
}

function reasonTable(head: string, rows: readonly ReasonRow[]): string {
  if (rows.length === 0) return "";
  const body = rows.map((row) => {
    const where = row.file.length > 0 ? `${row.file}${row.line === null ? "" : `:${row.line}`}` : "（未写位置）";
    return `<tr><td>${escapeHtml(row.text)}</td><td><code>${escapeHtml(where)}</code></td><td>${escapeHtml(row.quote)}</td></tr>`;
  });
  return `<h3>${head}</h3>
<table class="tbl">
<thead><tr><th>${head === "阻断意见" ? "问题" : "通过点"}</th><th>证据位置</th><th>原文引用</th></tr></thead>
<tbody>
${body.join("\n")}
</tbody>
</table>`;
}

function blockingRows(blocking: readonly RunBlocking[]): ReasonRow[] {
  return blocking.map((item) => ({ text: item.issue, file: item.file, line: item.line, quote: item.quote }));
}

function passedRows(passed: readonly RunPassing[]): ReasonRow[] {
  return passed.map((item) => ({ text: item.point, file: item.file, line: item.line, quote: item.quote }));
}

function reviewSection(detail: RunDetail): string {
  if (detail.review === null) {
    return `<section>
<h2>评审结论</h2>
<p class="empty">没有 03-review.json：这一轮还没评审完，或被跳过。</p>
</section>`;
  }
  const review = detail.review;
  // 结论摘要：用户问的第一句永远是「为什么」，所以它排在 verdict 那一行之后、理由表之前，且字号大一档
  // legacy 看的是 03-review.json 里有没有新契约的键，不是「summary 空不空」：
  // 新版评审失败时同样没有 summary，那时要说「没给理由」，不能说成旧版
  const legacy = review.legacy;
  const summary = legacy
    ? `<p class="hint">${LEGACY_REVIEW_NOTE}</p>`
    : `<p class="verdict-summary">${escapeHtml(review.summary ?? "")}</p>`;
  const blocked = reasonTable("阻断意见", blockingRows(detail.blocking));
  const passed = reasonTable("通过理由", passedRows(detail.passed));
  // 旧 run 已经有上面那句兼容文案了，不再叠一句「没给理由」
  const emptyNote = !legacy && blocked === "" && passed === "" ? `<p class="hint">${NO_REASON_NOTE}</p>` : "";
  return `<section>
<h2>评审结论</h2>
<p class="kv-line">
verdict <b class="${review.verdict === "pass" ? "ok" : "fail"}">${escapeHtml(review.verdict)}</b> ·
action <b>${escapeHtml(review.action)}</b> ·
状态 ${escapeHtml(review.status)} ·
重写 <b>${detail.rewrites}</b> 次 ·
评审模型 <code>${escapeHtml(review.reviewerModel)}</code>
</p>
${summary}
${emptyNote}
${blocked}
${passed}
</section>`;
}

function gateSection(detail: RunDetail): string {
  if (detail.gates.length === 0) {
    return `<section>
<h2>五闸</h2>
<p class="empty">没有 06-verify.json：五闸未执行（这个 run 没被采纳）。</p>
</section>`;
  }
  const rows = detail.gates.map(
    (gate) =>
      `<tr><td><code>${escapeHtml(gate.gate)}</code></td><td>${escapeHtml(gate.name)}</td><td class="${gate.ok ? "ok" : "fail"}">${gate.ok ? "ok" : "fail"}</td><td>${escapeHtml(gate.detail)}</td></tr>`,
  );
  return `<section>
<h2>五闸</h2>
<p class="hint">验证状态：${escapeHtml(detail.verifyStatus ?? "—")}</p>
<table class="tbl">
<thead><tr><th>闸</th><th>名称</th><th>结果</th><th>说明</th></tr></thead>
<tbody>
${rows.join("\n")}
</tbody>
</table>
</section>`;
}

function findingsSection(detail: RunDetail): string {
  if (detail.findingsTotal === 0) {
    return `<section>
<h2>发现</h2>
<p class="empty">01-findings.json 里没有条目（这一轮没发现值得改的地方）。</p>
</section>`;
  }
  const rows = detail.findings.map((item) => {
    const lines = item.lines.length > 0 ? item.lines.join("、") : "—";
    return `<tr><td>${escapeHtml(item.skill)}</td><td>${escapeHtml(item.reason)}</td><td>${escapeHtml(item.confidence)}</td><td>${escapeHtml(lines)}</td></tr>`;
  });
  const more =
    detail.findingsTotal > detail.findings.length
      ? `<p class="hint">只列前 ${detail.findings.length} 条，共 ${detail.findingsTotal} 条（完整内容见 01-findings.json）。</p>`
      : "";
  return `<section>
<h2>发现</h2>
<p class="hint">共 ${detail.findingsTotal} 条${detail.notes.length > 0 ? `：${escapeHtml(detail.notes)}` : ""}</p>
<table class="tbl">
<thead><tr><th>技能</th><th>归因</th><th>置信度</th><th>证据行</th></tr></thead>
<tbody>
${rows.join("\n")}
</tbody>
</table>
${more}
</section>`;
}

/** 五段格子的短状态词：格子窄，只用四个字以内 */
const STAGE_WORD: Record<PipelineStage["state"], string> = {
  done: "完成",
  running: "进行中",
  waiting: "等待",
  blocked: "卡住",
  failed: "失败",
  skipped: "跳过",
  ended: "终态",
};

/**
 * 流水线：页面顶部那一排。放在概要**之前**是因为用户点进详情页的第一个问题永远是
 * 「它现在到哪一步了」，而不是「pid 是多少」。每格给状态词 + 明细，卡住的那格直接写出下一步谁接手。
 */
function pipelineSection(pipeline: Pipeline, write: { csrf: string; runId: string } | null): string {
  const cells = pipeline.stages
    .map((stage) => {
      const at = stage.at === null ? "" : `<span class="pt">${escapeHtml(formatStamp(stage.at))}</span>`;
      return `<li class="stage s-${stage.state}">
<span class="pl">${escapeHtml(stage.label)}</span>
<span class="ps">${escapeHtml(STAGE_WORD[stage.state])}</span>
<span class="pd">${escapeHtml(stage.detail)}</span>
${at}
</li>`;
    })
    .join("\n");
  return `<section>
<h2>流水线</h2>
<p class="hint">${escapeHtml(renderPipelineLine(pipeline))} · ${escapeHtml(pipeline.hint)}</p>
<ol class="pipe">
${cells}
</ol>
${gateAction(pipeline, write)}
</section>`;
}

/**
 * 「下一步说要等面板批准」时，把批准/拒绝按钮就放在这句话下面（2026-11-10）。
 *
 * 这里原来是个断点：采纳段写「自动采纳关着：等面板批准」，但详情页没有任何按钮，
 * 批准按钮只在待审批列表页出现 —— 用户从一个明确写着「等你点」的页面被推去另一页找那一行。
 * 判据只看**采纳段是不是卡在等人**：其它阻塞（缺 04-decision、五闸没写决定）都不该给这两个按钮，
 * 点了也只会换回一句报错。
 */
function gateAction(pipeline: Pipeline, write: { csrf: string; runId: string } | null): string {
  if (write === null) return "";
  const apply = pipeline.stages.find((stage) => stage.key === "apply");
  if (!apply || apply.state !== "blocked" || !apply.detail.includes("等面板批准")) return "";
  return `<div class="ctl">
<form method="post" action="/approve">
<input type="hidden" name="csrf" value="${escapeHtml(write.csrf)}">
<input type="hidden" name="runId" value="${escapeHtml(write.runId)}">
<input type="hidden" name="view" value="approvals">
<button type="submit">批准并采纳</button>
</form>
<form method="post" action="/reject">
<input type="hidden" name="csrf" value="${escapeHtml(write.csrf)}">
<input type="hidden" name="runId" value="${escapeHtml(write.runId)}">
<input type="hidden" name="view" value="approvals">
<button type="submit" class="reject">拒绝</button>
</form>
</div>
<p class="hint">批准 = 在 TUI 敲 <code>/skill-evolve approve ${escapeHtml(write.runId)}</code>，走同一套五道闸；拒绝只改队列状态，不动任何技能文件。</p>`;
}

export interface RenderRunOptions {
  /** 状态栏要的数字（shell.ts 的 statusBar 唯一依赖） */
  state: WebState;
  /** 返回列表页的链接文案来源：从哪一页点进来的（缺省回待处理） */
  back?: { view: string; label: string };
  /** 写回调与 csrf 都在时，卡在「等面板批准」的 run 才渲染批准/拒绝按钮 */
  write?: { csrf: string };
}

export function renderRunPage(detail: RunDetail, options: RenderRunOptions): string {
  const back = options.back ?? { view: "pending", label: "待处理" };
  const body = `<main class="run">
<p class="hint"><a href="/?view=${escapeHtml(back.view)}">← 回${escapeHtml(back.label)}</a></p>
${pipelineSection(detail.pipeline, options.write ? { csrf: options.write.csrf, runId: detail.runId } : null)}
${overview(detail)}
${agentSection(detail)}
${diffSection(detail)}
${candidateSection(detail)}
${reviewSection(detail)}
${gateSection(detail)}
${findingsSection(detail)}
</main>`;
  return shellPage({
    state: options.state,
    title: `run ${detail.runId}`,
    active: null,
    body,
    foot: options.write
      ? `本页只对「等面板批准」的 run 提供批准 / 拒绝（与 TUI 走同一条路）；其余内容来自 <code>runs/${escapeHtml(detail.runId)}</code>，页面不写任何文件。`
      : `本页只读：diff 与全文来自 <code>runs/${escapeHtml(detail.runId)}</code>，页面不写任何文件。`,
  });
}
