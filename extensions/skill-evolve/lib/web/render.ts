/**
 * Web 面板的服务端渲染：纯字符串拼 HTML，不引模板库、不发任何外部请求、不依赖 JS。
 *
 * 这一版只负责**列表页**：控制条 → 横幅 → 导航 → 筛选 → 列表 → 分页 → 最近操作 → 页脚。
 * 页面骨架（`<head>` / 状态栏 / 六个 tab / 页脚）在 ./shell.ts；
 * 列表行在 ./render-rows.ts，控制条/筛选/分页/最近操作在 ./render-controls.ts，
 * 技能管理页在 ./render-skills.ts，run 详情页在 ./render-run.ts ——
 * 拆开是因为合在一起必然破 300 行，而拆开之后每段都能单独看。
 *
 * 渲染层不读盘：`controls`（开关与最后活动）与 `audit`（最近操作）都由服务端读好传进来。
 * 拿不到开关状态时**不渲染控制条**，而不是猜一个「已开」——顶部写错状态比不写更糟。
 *
 * 展开交互交给 `<details>`：零 JS，刷新即最新，坏处只是不能记住展开状态 —— 面板不需要。
 */
import type { AuditEntry } from "./audit-log.ts";
import type { WebControls } from "./activity.ts";
import type { WebState, WebView } from "./data.ts";
import {
  NO_FILTER,
  buildViewPage,
  isDefaultFilter,
  pageHref,
  parseView,
  type ListFilter,
  type ViewPage,
} from "./filter.ts";
import { appliedRows, approvalRows, doneRows, pendingRows, reportRows, type RowContext } from "./render-rows.ts";
import { renderAudit, renderControlBar, renderFilterForm, renderPagination } from "./render-controls.ts";
import { VIEW_LABEL, shellPage } from "./shell.ts";
import { escapeHtml } from "./text.ts";

// 这些格式化函数原来住在本文件，拆文件后仍然从这里导出：既有测试与调用方都按这个路径取
export { escapeHtml, formatStamp, shortRunId } from "./text.ts";
export { parseView } from "./filter.ts";

/** 每个列表页的空态文案：写清「为什么空」与「空在这里意味着什么」，不是一句「暂无数据」 */
export const EMPTY: Record<WebView, string> = {
  pending: "暂无待处理：所有复盘都已完成，也没有待人批的改动。",
  approvals: "没有待批：auto 级不需要人批，approval 级的会出现在这里。",
  applied: "还没有已采纳的提案：采纳过的会连 diff 一起留在这里。",
  done: "暂无已处理记录：还没有回滚、失败或被否决的提案。",
  reports: "暂无复盘报告：还没有 run 写过 01-findings.json。",
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
  return `只读面板：只绑 127.0.0.1、无鉴权、不能在这里点批准 ——
采纳请回 TUI 跑 <code>/skill-evolve approve &lt;runId&gt;</code>，或去<a href="/?view=approvals">待审批页</a>直接批。${api}`;
}

/**
 * 列表区：筛选表单 + 列表 + 分页。待审批页不给筛选也不分页 ——
 * 它必须在一屏里看全（每个都等着人点），筛掉一部分只会制造「怎么还有没批的」。
 */
function listSection(view: WebView, page: ViewPage, filter: ListFilter, ctx: RowContext): string {
  const body =
    page.view === "pending"
      ? pendingRows(page.rows, ctx)
      : page.view === "approvals"
        ? approvalRows(page.rows, ctx)
        : page.view === "applied"
          ? appliedRows(page.rows)
          : page.view === "done"
            ? doneRows(page.rows)
            : reportRows(page.rows, ctx);
  const list = body.length === 0 ? `<p class="empty">${EMPTY[view]}</p>` : `<ul>\n${body}\n</ul>`;
  if (view === "approvals") return `<main>\n${list}\n</main>`;
  return `<main>
${renderFilterForm(view, filter)}
${list}
${renderPagination(view, page, filter)}
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
  /** 现时（单测注入固定时钟） */
  now?: number;
}

export function renderPage(state: WebState, view: WebView, options: RenderOptions = {}): string {
  const csrf = options.csrf ?? "";
  const writable = options.canWrite === true && csrf.length > 0;
  const now = options.now ?? Date.now();
  // 渲染层不自带筛选：不传就是「全部、第 1 页」；产品默认的 7 天由 HTTP 层（parseListQuery）给
  const filter = options.filter ?? NO_FILTER;
  const page = buildViewPage(state, view, filter, now);
  const ctx: RowContext = { csrf, writable, view };
  // 只给「待处理」加 5 秒自刷新：等待时人会停留，看档案 / 历史时刷新只会把页面跳回去；
  // 待审批页有按钮，刷新会打断正在点的动作，同样不加。
  // 带筛选时刷新必须带上同样的筛选参数，否则挑完技能看着看着就被弹回全部 —— 没筛时保持最短 URL。
  // 渲染层不传 filter（= 全量、第 1 页）与默认筛选（7d、第 1 页且没挑技能/状态）都用最短 URL
  const plainRefresh = options.filter === undefined || isDefaultFilter(filter);
  const refresh =
    view === "pending"
      ? `<meta http-equiv="refresh" content="5; url=${plainRefresh ? "?view=pending" : escapeHtml(pageHref(view, filter, page.page))}">\n`
      : "";
  const notice = options.notice
    ? `<p class="notice${options.notice.kind === "err" ? " err" : ""}">${escapeHtml(options.notice.text)}</p>\n`
    : "";
  const top = [
    options.controls ? renderControlBar(options.controls, { view, now, csrf, canWrite: writable }) : "",
    notice.trimEnd(),
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
    top,
    body: listSection(view, page, filter, ctx),
    foot: `${audit}${footer(view, writable)}`,
  });
}
