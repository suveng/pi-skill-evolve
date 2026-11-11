/**
 * 页面骨架里的四块「管理性质」的东西：顶部控制条、列表筛选、刷新提示、分页、最近操作。
 *
 * 都不依赖列表行，所以与 render-rows.ts 分开。
 *
 * 三条设计取舍：
 * 1. **控制条只在服务端传了数据时才渲染**：渲染层不自己去读盘（否则 renderPage 会变成「读盘 + 渲染」两件事），
 *    也不在拿不到开关状态时猜一个出来 —— 顶部写「复盘：开」而实际是关的，比不写更糟；
 * 2. **筛选用 `<form method="get">` + hidden view**：零 JS，所以筛选结果能被拷成链接、
 *    能退回上一页、能在刷新后保持；翻页链接由 pageHref 带上全部筛选参数，不保留就等于点下一页即清空筛选；
 * 3. **默认不自动刷新**：整页重载会丢掉 `<details>` 的展开态与滚动位置（用户 2026-11-08 报「点击展开过一会又被收起」），
 *    所以默认只给一个「刷新」链接，`&live=1` 才是显式要求的 5 秒自动刷新。
 */
import type { AuditEntry } from "./audit-log.ts";
import type { ConfigFlag } from "../config.ts";
import {
  FLAG_EFFECT,
  FLAG_FIELDS,
  FLAG_LABEL,
  TELEMETRY_OFF_WARNING,
  telemetryOffWhileEnabled,
} from "../flags.ts";
import type { WebView } from "./data.ts";
import { RANGE_KEYS, RANGE_LABEL, type ListFilter, type ViewPage } from "./filter.ts";
import { listHref, type ListExtras } from "./list-query.ts";
import { escapeHtml, formatStamp, formatTimeSeconds } from "./text.ts";
import type { WebControls } from "./activity.ts";

export interface ControlBarOptions {
  /** 动作用户在哪一页点的，就回哪一页：技能管理页也要能开关采集（曝光数据就是它采的） */
  view: WebView | "skills";
  csrf?: string;
  canWrite?: boolean;
}

const MINUTE_MS = 60_000;

/**
 * 「最后活动」的人话（摘要行尾部）：只给粗粒度，不给秒 —— 精确到秒反而看不出差别，
 * 而「几分钟前 / 几小时前 / 几天前」正好是「这个插件还在动吗」需要的精度。
 */
export function activityText(at: number | null, now: number): string {
  if (at === null) return "最后活动 还没有任何记录";
  const minutes = Math.floor(Math.max(0, now - at) / MINUTE_MS);
  if (minutes < 1) return "最后活动 刚刚";
  if (minutes < 60) return `最后活动 ${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `最后活动 ${hours} 小时前`;
  return `最后活动 ${Math.floor(hours / 24)} 天前`;
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
 * 一个独立开关：一个 chip = 状态 + 「点下去会发生什么」的按钮，代价说明塞进 `title`。
 *
 * 四个开关各自 post 到 `/toggle?field=`（带上隐藏的 view，动作完回同一页），**不互相联动**：
 * 想采集但不花钱、想评审但不自动采纳，都是常见中间态；要批量切只有命令 `on|off`。
 * 按钮文案写动作不写状态 —— 状态已经在左边那一段里，按钮再写一遍会让人把「当前值」看成「点了会变的值」。
 * 代价说明必须留着（「花 token」「改 .pi/skills/」是点之前就该知道的），只是不该占一整行把开关挤成两排。
 */
function flagSwitch(field: ConfigFlag, on: boolean, ctx: ControlBarOptions): string {
  const state = `<span class="state ${on ? "on" : "off"}">${FLAG_LABEL[field]}：${on ? "开" : "关"}</span>`;
  const title = ` title="${escapeHtml(FLAG_EFFECT[field])}"`;
  const writable = ctx.canWrite === true && (ctx.csrf ?? "").length > 0;
  const form = writable
    ? `<form method="post" action="/toggle?field=${field}">
<input type="hidden" name="csrf" value="${escapeHtml(ctx.csrf ?? "")}">
<input type="hidden" name="view" value="${ctx.view}">
<button type="submit">${on ? "关闭" : "开启"}${FLAG_LABEL[field]}</button>
</form>`
    : "";
  return `<span class="sw"${title}>${state}${form}</span>`;
}

/**
 * 顶部控制条：四个独立开关（采集 / 复盘 / 评审 / 采纳）+ 立即复盘，挤在同一行。
 *
 * 四个开关不许合成一个「开启全部」：采集只写本地文件，复盘与评审才花 token，
 * 采纳直接改仓库文件 —— 想采集样本但不想花钱、想评审但不想自动落盘，都是常见的中间状态。
 * 两类提醒不许静默：只开复盘不采集（见 flags.ts 的 TELEMETRY_OFF_WARNING）、
 * 采纳关着但队列里积了 auto 提案（告诉人有多少条等人工批）。
 */
export function renderControlBar(controls: WebControls, ctx: ControlBarOptions): string {
  const writable = ctx.canWrite === true && (ctx.csrf ?? "").length > 0;
  const run = writable ? runForm(ctx) : "";
  const warn = telemetryOffWhileEnabled(controls.enabled, controls.telemetry)
    ? `<p class="warn">⚠ ${TELEMETRY_OFF_WARNING}</p>\n`
    : "";
  const backlog =
    !controls.autoApply && controls.pendingAuto > 0
      ? `<p class="warn">⏸ ${controls.pendingAuto} 条 auto 提案待人工（自动采纳关着）</p>\n`
      : "";
  const switches = FLAG_FIELDS.map((field) => flagSwitch(field, controls[field], ctx)).join("\n");
  return `<div class="ctl">
${switches}
${run}</div>
${warn}${backlog}`;
}

/** 时间下拉：只有「看多久内」需要人手动换，状态与技能已在 tab 与技能页面各自解决了 */
function rangeSelect(current: string): string {
  return RANGE_KEYS.map(
    (key) => `<option value="${key}"${key === current ? " selected" : ""}>${RANGE_LABEL[key]}</option>`,
  ).join("");
}

/**
 * 筛选表单：只留「时间」一个条件。
 *   技能：每个列表页的行里已经有技能列，技能页可以按技能点进来，再摆一个模糊搜索框没人知道该填什么；
 *   状态：顶部 tab 本身就是按状态分的（待处理 / 待落盘 / 已采纳 / 已结束），重复选毫无意义。
 * 两个参数（skill / status）仍由 `parseListQuery` 支持，旧链接与代码内部跳转不会断，只是不再出输入框。
 */
export function renderFilterForm(view: WebView, filter: ListFilter, extras: ListExtras): string {
  const keep = extraInputs(extras);
  return `<form class="filter" method="get">
<input type="hidden" name="view" value="${view}">
${keep}<label>时间 <select name="range">${rangeSelect(filter.range)}</select></label>
<button type="submit">筛选</button>
<a class="btn" href="${escapeHtml(listHref(view, filter, 1, extras))}">重置</a>
</form>`;
}

/** 把非筛选的显式开关写成 hidden：表单提交只带这几个，不带的字段自然回落默认值 */
function extraInputs(extras: ListExtras): string {
  const parts: string[] = [];
  if (extras.live) parts.push(`<input type="hidden" name="live" value="1">`);
  if (extras.open === "none") parts.push(`<input type="hidden" name="open" value="none">`);
  return parts.length === 0 ? "" : `${parts.join("")}\n`;
}

/**
 * 「更新于 21:57:03 · 刷新」：默认的手动刷新入口。
 * 时间精确到秒：这是「我看到的就是这一刻的数据」的凭证，只到分钟会让人反复点刷新。
 */
export function renderUpdatedAt(now: number, href: string): string {
  return `更新于 ${formatTimeSeconds(now)} · <a href="${escapeHtml(href)}">刷新</a>`;
}

/**
 * `&live=1` 时的头部提示：明说「展开态会重置」。
 * 整页重载必然丢展开态与滚动位置，与其让人以为面板在帮他收起，不如提前讲清代价并给一个关掉的链接。
 */
export function renderLiveNote(offHref: string): string {
  return `<p class="warn">自动刷新中（每 5 秒整页重载，展开态会重置）· <a href="${escapeHtml(offHref)}">关掉</a></p>`;
}

/**
 * 分页条：`第 X / Y 页 · 共 N 条 · 上一页 / 下一页` 永远显示（空列表也显示「第 1 / 1 页 · 共 0 条」——
 * 页脚消失了人只会以为筛选坏了），只有到底时才把箭头换成灰字。
 */
export function renderPagination(view: WebView, page: ViewPage, filter: ListFilter, extras: ListExtras): string {
  const href = (target: number) => escapeHtml(listHref(view, filter, target, extras));
  const prev =
    page.page > 1 ? `<a href="${href(page.page - 1)}">← 上一页</a>` : `<span class="off">← 上一页</span>`;
  const next =
    page.page < page.pages ? `<a href="${href(page.page + 1)}">下一页 →</a>` : `<span class="off">下一页 →</span>`;
  return `<p class="page">${prev} <span class="count">第 ${page.page} / ${page.pages} 页 · 共 ${page.total} 条</span> ${next}</p>`;
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
