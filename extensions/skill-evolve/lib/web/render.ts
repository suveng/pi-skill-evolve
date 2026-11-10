/**
 * Web 面板的服务端渲染：纯字符串拼 HTML，不引模板库、不发任何外部请求、不依赖 JS。
 *
 * 这一版只负责**列表页**：粘性头部（摘要 + tabs + 控制条）→ 横幅 → 筛选 → 表格 → 分页 → 最近操作 → 页脚。
 * 页面骨架（`<head>` / 状态栏 / 六个 tab / 页脚）在 ./shell.ts；
 * 列表行与分组在 ./render-rows.ts，控制条/筛选/分页/刷新提示/最近操作在 ./render-controls.ts，
 * 技能管理页在 ./render-skills.ts，run 详情页在 ./render-run.ts —— 拆开是因为合在一起必然破 300 行。
 *
 * 渲染层不读盘：`controls`（开关与最后活动）与 `audit`（最近操作）都由服务端读好传进来。
 * 拿不到开关状态时**不渲染控制条**，而不是猜一个「已开」——顶部写错状态比不写更糟。
 *
 * 刷新策略（用户 2026-11-08 报「待处理一直帮我收起，点开过一会又被收起」）：
 * 默认**不**自动刷新，只给「更新于 …· 刷新」；`&live=1` 才是用户显式要的 5 秒重载，
 * 且那时页头会写清「展开态会重置」。整页重载必然丢 `<details>` 展开态，这代价只该由要求它的人承担。
 */
import type { AuditEntry } from "./audit-log.ts";
import type { WebControls } from "./activity.ts";
import type { WebState, WebView } from "./data.ts";
import { NO_FILTER, buildViewPage, parseView, type ListFilter, type ViewPage } from "./filter.ts";
import { DEFAULT_EXTRAS, listHref, type ListExtras } from "./list-query.ts";
import {
  appliedRows,
  approvalRows,
  doneRows,
  pendingRows,
  type ListRow,
  type RowContext,
} from "./render-rows.ts";
import { groupRows, renderRows } from "./render-table.ts";
import {
  activityText,
  renderAudit,
  renderControlBar,
  renderFilterForm,
  renderLiveNote,
  renderPagination,
  renderUpdatedAt,
} from "./render-controls.ts";
import { VIEW_LABEL, shellPage } from "./shell.ts";
import { escapeHtml } from "./text.ts";

// 这些格式化函数原来住在本文件，拆文件后仍然从这里导出：既有测试与调用方都按这个路径取
export { escapeHtml, formatStamp, shortRunId } from "./text.ts";
export { parseView } from "./filter.ts";

/**
 * 每个列表页的空态：一句话说「为什么空」+ 一句下一步。
 * 只写「暂无数据」等于把「接下来该敲什么」留给人自己猜，而这里每个空态都对应一个具体动作。
 */
export const EMPTY: Record<WebView, { text: string; next: string }> = {
  pending: {
    text: "暂无待处理：所有复盘都已完成，也没有待人批的改动。",
    next: "下一批提案来自真实会话：确认 <code>/skill-evolve telemetry on</code> 与 <code>/skill-evolve dispatch on</code>。",
  },
  approvals: {
    text: "没有待批：auto 级不需要人批，approval 级的会出现在这里。",
    next: "想让提案先来这儿：<code>/skill-evolve level approval</code>。",
  },
  applied: {
    text: "还没有已采纳的提案：采纳过的会连 diff 一起留在这里。",
    next: "先 <code>/skill-evolve dispatch on</code>，让真实会话自动出提案。",
  },
  done: {
    text: "暂无已结束记录：还没有回滚、失败或被否决的提案。",
    next: "只有走完终态的 run 才进这里；在跑的 run 看「待处理」。",
  },
};

/** 页脚按视图分：只有待审批页能点，其它页要把「去哪批」写清楚 */
function footer(view: WebView, canWrite: boolean): string {
  const api = `机器可读副本：<a href="/api/state">/api/state</a>。`;
  if (view === "approvals") {
    if (!canWrite) {
      return `本实例只读：没注入审批回调，页面上不能点批准 —— 采纳请回 TUI 跑 <code>/skill-evolve approve &lt;runId&gt;</code>。${api}`;
    }
    return `点「批准」= 在 TUI 敲 <code>/skill-evolve approve &lt;runId&gt;</code>，走同一套五道闸；「拒绝」只改队列状态，不动任何技能文件。${api}`;
  }
  return `本机面板 · 只绑 127.0.0.1 · 无鉴权 · 机器可读副本见 <a href="/api/state">/api/state</a>。`;
}

/** 五个视图各自的「条目 → 行」映射；字段差异都在各自函数里消化，渲染层只认 ListRow */
function rowsOf(page: ViewPage, ctx: RowContext): ListRow[] {
  switch (page.view) {
    case "pending":
      return pendingRows(page.rows, ctx);
    case "approvals":
      return approvalRows(page.rows, ctx);
    case "applied":
      return appliedRows(page.rows);
    case "done":
      return doneRows(page.rows);
  }
}

/**
 * 分组开关：只在真的出现了组（同会话 ≥2 条）时给链接 —— 没有组的页面给「收起分组」等于给一个点了没反应的开关。
 * 两个显式链接（`open=all` / `open=none`）优先于默认值，靠 URL 记住，不用 JS。
 */
function groupToggle(view: WebView, filter: ListFilter, extras: ListExtras, hasGroup: boolean): string {
  if (!hasGroup) return "";
  const collapsed = extras.open === "none";
  const target = { ...extras, open: collapsed ? ("all" as const) : ("none" as const) };
  const text = collapsed ? "展开全部分组" : "收起全部分组";
  return `<p class="hint"><a href="${escapeHtml(listHref(view, filter, 1, target))}">${text}</a></p>\n`;
}

/**
 * 列表区：筛选表单 + 表格（或空态）+ 分页。待审批页不给筛选也不分页 ——
 * 它必须在一屏里看全（每个都等着人点），筛掉一部分只会制造「怎么还有没批的」。
 */
function listSection(
  view: WebView,
  page: ViewPage,
  filter: ListFilter,
  extras: ListExtras,
  ctx: RowContext,
): string {
  const rows = rowsOf(page, ctx);
  const body =
    rows.length === 0
      ? `<p class="empty">${EMPTY[view].text}</p>\n<p class="next">${EMPTY[view].next}</p>`
      : `${groupToggle(view, filter, extras, groupRows(rows).some((block) => block.kind === "group"))}${renderRows(rows, extras, ctx.now)}`;
  if (view === "approvals") return `<main>\n${body}\n</main>`;
  return `<main>
${renderFilterForm(view, filter, extras)}
${body}
${renderPagination(view, page, filter, extras)}
</main>`;
}

export interface RenderOptions {
  /** 表单 CSRF token：只读实例不传，按钮就不渲染 */
  csrf?: string;
  /** 是否允许渲染写操作按钮：只有注入了回调的实例才 true */
  canWrite?: boolean;
  /** 上一步动作的结果 / 错误（来自 303 的 msg / err），页面顶部一条横幅 */
  notice?: { kind: "msg" | "err"; text: string } | null;
  /** 控制条数据（开关状态 + 最后活动）：不传就不渲染控制条 */
  controls?: WebControls | null;
  /** 最近操作；不传就不渲染「最近操作」区（空数组则渲染成「还没有记录」） */
  audit?: readonly AuditEntry[] | null;
  /** 列表筛选；不传按默认（全部技能 / 全部状态 / 最近 7 天 / 第 1 页） */
  filter?: ListFilter;
  /** 三个显式开关（自动刷新 / 分组展开）；不传就是默认（不刷新、展开） */
  extras?: ListExtras;
  /** 现时（单测注入固定时钟） */
  now?: number;
}

export function renderPage(state: WebState, view: WebView, options: RenderOptions = {}): string {
  const csrf = options.csrf ?? "";
  const writable = options.canWrite === true && csrf.length > 0;
  const now = options.now ?? Date.now();
  // 渲染层不自带筛选：不传就是「全部、第 1 页」；产品默认的 7 天由 HTTP 层（parseListQuery）给
  const filter = options.filter ?? NO_FILTER;
  const extras = options.extras ?? DEFAULT_EXTRAS;
  // `live` 只在待处理页有意义：别的页数据不会自己变，给了也忽略（与 parseListExtras 同一口径）
  const live = extras.live && view === "pending";
  const page = buildViewPage(state, view, filter, now);
  const ctx: RowContext = { csrf, writable, view, now };
  const here = listHref(view, filter, page.page, extras);
  // 只有 `&live=1` 的待处理页才 5 秒重载：别的页数据不会自己变，重载只会丢展开态与滚动位置
  const refresh = live ? `<meta http-equiv="refresh" content="5; url=${escapeHtml(here)}">\n` : "";
  const liveNote = live
    ? renderLiveNote(listHref(view, filter, page.page, { ...extras, live: false }))
    : "";
  const notice = options.notice
    ? `<p class="notice${options.notice.kind === "err" ? " err" : ""}">${escapeHtml(options.notice.text)}</p>`
    : "";
  const top = [
    options.controls ? renderControlBar(options.controls, { view, csrf, canWrite: writable }) : "",
    liveNote,
    notice,
  ]
    .filter((part) => part.length > 0)
    .map((part) => `${part}\n`)
    .join("");
  const audit = options.audit ? `${renderAudit(options.audit)}\n` : "";
  return shellPage({
    state,
    title: VIEW_LABEL[view],
    active: view,
    head: refresh,
    meta: options.controls
      ? `${renderUpdatedAt(now, here)} · ${escapeHtml(activityText(options.controls.lastActivityAt, now))}`
      : renderUpdatedAt(now, here),
    top,
    body: listSection(view, page, filter, extras, ctx),
    foot: `${audit}${footer(view, writable)}`,
  });
}
