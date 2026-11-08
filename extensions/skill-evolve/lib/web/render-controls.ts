/**
 * 页面骨架里的四块「管理性质」的东西：顶部控制条、列表筛选、分页、最近操作。
 *
 * 都不依赖列表行，所以与 render-rows.ts 分开。
 *
 * 两条设计取舍：
 * 1. **控制条只在服务端传了数据时才渲染**：渲染层不自己去读盘（否则 renderPage 会变成「读盘 + 渲染」两件事），
 *    也不在拿不到开关状态时猜一个出来 —— 顶部写「复盘：开」而实际是关的，比不写更糟；
 * 2. **筛选用 `<form method="get">` + hidden view**：零 JS，所以筛选结果能被拷成链接、
 *    能退回上一页、能在刷新后保持；翻页链接由 pageHref 带上全部筛选参数，不保留就等于点下一页即清空筛选。
 */
import type { AuditEntry } from "./audit-log.ts";
import type { ConfigFlag } from "../config.ts";
import { FLAG_EFFECT, FLAG_LABEL, TELEMETRY_OFF_WARNING, telemetryOffWhileEnabled } from "../flags.ts";
import type { WebView } from "./data.ts";
import { RANGE_KEYS, RANGE_LABEL, STATUS_OPTIONS, pageHref, type ListFilter, type ViewPage } from "./filter.ts";
import { escapeHtml, formatStamp } from "./text.ts";
import type { WebControls } from "./activity.ts";

export interface ControlBarOptions {
  /** 动作用户在哪一页点的，就回哪一页：技能管理页也要能开关采集（曝光数据就是它采的） */
  view: WebView | "skills";
  /** 现时（单测注入固定时钟）：决定「最后活动」写成几分钟前 */
  now: number;
  csrf?: string;
  canWrite?: boolean;
}

const MINUTE_MS = 60_000;

/**
 * 「最后活动」的人话：只给粗粒度，不给秒 —— 精确到秒反而看不出差别，
 * 而「几分钟前 / 几小时前 / 几天前」正好是「这个插件还在动吗」需要的精度。
 */
export function activityText(at: number | null, now: number): string {
  if (at === null) return "最后活动：还没有任何记录";
  const minutes = Math.floor(Math.max(0, now - at) / MINUTE_MS);
  if (minutes < 1) return "最后活动：刚刚";
  if (minutes < 60) return `最后活动：${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `最后活动：${hours} 小时前`;
  return `最后活动：${Math.floor(hours / 24)} 天前`;
}

/** 控制条上的「立即复盘」按钮；只读面板不渲染任何表单 */
function runForm(ctx: ControlBarOptions): string {
  return `<form method="post" action="/action">
<input type="hidden" name="csrf" value="${escapeHtml(ctx.csrf ?? "")}">
<input type="hidden" name="name" value="run">
<input type="hidden" name="view" value="${ctx.view}">
<button type="submit">立即复盘</button>
</form>`;
}

/**
 * 一个独立开关：状态 + 后果说明 + 「点下去会发生什么」的按钮。
 *
 * 两个开关各自 post 到 `/toggle?field=`（带上隐藏的 view，动作完回同一页），
 * 按钮文案写动作不写状态 —— 状态已经在左边那一段里，按钮再写一遍会让人把「当前值」看成「点了会变的值」。
 */
function flagSwitch(field: ConfigFlag, on: boolean, ctx: ControlBarOptions): string {
  const state = `<span class="state ${on ? "on" : "off"}">${FLAG_LABEL[field]}：${on ? "开" : "关"}</span>`;
  const effect = `<span class="hint">${FLAG_EFFECT[field]}</span>`;
  const writable = ctx.canWrite === true && (ctx.csrf ?? "").length > 0;
  const form = writable
    ? `<form method="post" action="/toggle?field=${field}">
<input type="hidden" name="csrf" value="${escapeHtml(ctx.csrf ?? "")}">
<input type="hidden" name="view" value="${ctx.view}">
<button type="submit">${on ? "关闭" : "开启"}${FLAG_LABEL[field]}</button>
</form>`
    : "";
  return `<span class="sw">${state}${effect}${form}</span>`;
}

/**
 * 顶部控制条：两个独立开关（采集 / 复盘）+ 立即复盘 + 最后活动。
 *
 * 两个开关不许合成一个「开启采集与派生」：采集只写本地文件，复盘才花 token，
 * 想采集样本但不想花钱是常见的中间状态，捆在一起就无路可走。
 * 只开复盘不采集时另给一行警告（见 flags.ts 的 TELEMETRY_OFF_WARNING），不许静默。
 */
export function renderControlBar(controls: WebControls, ctx: ControlBarOptions): string {
  const writable = ctx.canWrite === true && (ctx.csrf ?? "").length > 0;
  const run = writable ? runForm(ctx) : "";
  const warn = telemetryOffWhileEnabled(controls.enabled, controls.telemetry)
    ? `<p class="warn">⚠ ${TELEMETRY_OFF_WARNING}</p>\n`
    : "";
  return `<div class="ctl">
${flagSwitch("telemetry", controls.telemetry, ctx)}
${flagSwitch("enabled", controls.enabled, ctx)}
${run}<span class="act">${escapeHtml(activityText(controls.lastActivityAt, ctx.now))}</span>
</div>
${warn}`;
}

/** 状态下拉：先「全部」，再固定七个状态（顺序与 STATUS_OPTIONS 一致，别在渲染层重排） */
function statusSelect(current: string): string {
  const options = [`<option value="">全部状态</option>`];
  for (const status of STATUS_OPTIONS) {
    options.push(`<option value="${status}"${status === current ? " selected" : ""}>${status}</option>`);
  }
  return options.join("");
}

function rangeSelect(current: string): string {
  return RANGE_KEYS.map(
    (key) => `<option value="${key}"${key === current ? " selected" : ""}>${RANGE_LABEL[key]}</option>`,
  ).join("");
}

/** 筛选表单：hidden view 保证 GET 提交后还在同一页；「重置」链回不带筛选的本页 */
export function renderFilterForm(view: WebView, filter: ListFilter): string {
  return `<form class="filter" method="get">
<input type="hidden" name="view" value="${view}">
<label>技能 <input type="text" name="skill" value="${escapeHtml(filter.skill)}" placeholder="全部技能" size="16"></label>
<label>状态 <select name="status">${statusSelect(filter.status)}</select></label>
<label>时间 <select name="range">${rangeSelect(filter.range)}</select></label>
<button type="submit">筛选</button>
<a class="btn" href="/?view=${view}">重置</a>
</form>`;
}

/**
 * 分页条：`第 X / Y 页，共 N 条` 永远显示（空列表也显示「第 1 / 1 页，共 0 条」——
 * 页脚消失了人只会以为筛选坏了），只有到底时才把箭头换成灰字。
 */
export function renderPagination(view: WebView, page: ViewPage, filter: ListFilter): string {
  const prev =
    page.page > 1
      ? `<a href="${escapeHtml(pageHref(view, filter, page.page - 1))}">← 上一页</a>`
      : `<span class="off">← 上一页</span>`;
  const next =
    page.page < page.pages
      ? `<a href="${escapeHtml(pageHref(view, filter, page.page + 1))}">下一页 →</a>`
      : `<span class="off">下一页 →</span>`;
  return `<p class="page">${prev} <span class="count">第 ${page.page} / ${page.pages} 页，共 ${page.total} 条</span> ${next}</p>`;
}

/** 「最近操作」：时间 + 动作 + runId + 结果；结果里的 error 前缀单独染色，扫一眼就知道有没有出事 */
function auditRow(entry: AuditEntry): string {
  const failed = entry.result.startsWith("error");
  const cls = failed ? "fail" : entry.result === "partial" ? "partial" : "ok";
  const runId = entry.runId ? ` · <code>${escapeHtml(entry.runId)}</code>` : "";
  return `<li><span class="when">${formatStamp(entry.at)}</span> · <b>${entry.action}</b>${runId} · <span class="${cls}">${escapeHtml(entry.result)}</span></li>`;
}

export function renderAudit(entries: readonly AuditEntry[]): string {
  const body =
    entries.length === 0
      ? `<p class="empty">还没有网页操作记录。</p>`
      : `<ul>\n${entries.map(auditRow).join("\n")}\n</ul>`;
  return `<section class="audit">
<h2>最近操作</h2>
${body}
</section>`;
}
