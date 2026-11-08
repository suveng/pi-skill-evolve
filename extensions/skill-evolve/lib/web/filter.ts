/**
 * 列表筛选 + 分页：五个列表页（待处理 / 待审批 / 已采纳 / 已处理 / 复盘报告）共用一套 query 语义。
 *
 * 为什么全用 GET query：面板零 JS，筛选必须能拷链接、能进浏览历史、刷新即最新；
 * 为什么页码在这里算而不是在渲染层：同一份 filter 决定「取哪 20 条」与「第 X / Y 页」，
 * 两处各算一次必然出现「页脚说 3 页、列表只有 2 页内容」。
 *
 * 筛选参数怎么落到条目上（三页字段名不同，这一层是唯一的转换点）：
 * - `skill` 精确匹配（不是模糊）：技能名本身就是完整标识，模糊匹配只会让人找不到自己要的那一个；
 * - `status` 精确匹配：待处理页没有 status 字段，用 kind 一一映射（running/stale/reviewed 同名，
 *   approval 映射成 `approval` —— 页面上看到的就是这个词）；
 * - `range` 按条目自己的时间字段算：待处理/已处理用 `at`，报告用 `startedAt`；取不到时间的一律**不**落进带范围的筛选
 *   （宁可让它只在 `range=all` 出现，也不能让「不知道时间」冒充「最近 7 天」）。
 */
import type { AppliedItem, ApprovalItem, DoneItem, PendingItem, RunReport, WebState, WebView } from "./data.ts";
import { WEB_VIEWS } from "./data.ts";

export const PAGE_SIZE = 20;
export const RANGE_KEYS = ["24h", "7d", "30d", "all"] as const;
export type RangeKey = (typeof RANGE_KEYS)[number];
export const DEFAULT_RANGE: RangeKey = "7d";
export const RANGE_LABEL: Record<RangeKey, string> = {
  "24h": "最近 24 小时",
  "7d": "最近 7 天",
  "30d": "最近 30 天",
  all: "全部时间",
};

/** 状态下拉的可选值：既有 run 终态，也有待处理页自己的两种（running / stale） */
export const STATUS_OPTIONS = ["running", "stale", "reviewed", "applied", "rejected", "failed", "analyzed"] as const;

export interface ListFilter {
  skill: string;
  /** 空串 = 全部 */
  status: string;
  range: RangeKey;
  /** 从 1 开始；非法或越界都在 paginate 里归位，不在这里猜 */
  page: number;
}

export const NO_FILTER: ListFilter = { skill: "", status: "", range: "all", page: 1 };

const DAY_MS = 24 * 60 * 60 * 1000;

/** 范围起点；`all` 返回 null 表示不限 */
export function rangeStart(range: RangeKey, now: number): number | null {
  switch (range) {
    case "24h":
      return now - DAY_MS;
    case "7d":
      return now - 7 * DAY_MS;
    case "30d":
      return now - 30 * DAY_MS;
    default:
      return null;
  }
}

/** 解析 query：缺省 range 用默认 7d，缺省 page 用 1；未知值一律回落默认，不报错（筛选是浏览工具，不该 400） */
export function parseListQuery(params: URLSearchParams): ListFilter {
  const range = params.get("range") ?? "";
  const page = Number.parseInt(params.get("page") ?? "1", 10);
  return {
    skill: (params.get("skill") ?? "").trim(),
    status: (params.get("status") ?? "").trim(),
    range: (RANGE_KEYS as readonly string[]).includes(range) ? (range as RangeKey) : DEFAULT_RANGE,
    page: Number.isFinite(page) && page >= 1 ? page : 1,
  };
}

/**
 * 分页结果就是渲染层唯一的数据来源：`page` 是归位之后的真实页码（越界会被夹到最后一页），
 * `pages` 至少是 1（空列表也要显示「第 1 / 1 页，共 0 条」，否则页脚会消失，人以为筛选坏了）。
 */
export function paginate<T>(
  rows: readonly T[],
  page: number,
): { rows: T[]; page: number; pages: number; total: number } {
  const total = rows.length;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const current = Math.min(Math.max(1, Math.trunc(page)), pages);
  const start = (current - 1) * PAGE_SIZE;
  return { rows: rows.slice(start, start + PAGE_SIZE), page: current, pages, total };
}

/** 列表页的数据形状：`view` 是判别字段，渲染层据此拿到强类型的 rows */
export type ViewPage =
  | { view: "pending"; rows: PendingItem[]; page: number; pages: number; total: number }
  | { view: "approvals"; rows: ApprovalItem[]; page: 1; pages: 1; total: number }
  | { view: "applied"; rows: AppliedItem[]; page: number; pages: number; total: number }
  | { view: "done"; rows: DoneItem[]; page: number; pages: number; total: number }
  | { view: "reports"; rows: RunReport[]; page: number; pages: number; total: number };

const PENDING_STATUS: Record<PendingItem["kind"], string> = {
  running: "running",
  stale: "stale",
  reviewed: "reviewed",
  approval: "approval",
};

/** 时间是否落进范围：`at` 为 null 的条目只有不限范围时才出现（见文件头「不冒充最近 N 天」） */
function inRange(at: number | null, filter: ListFilter, now: number): boolean {
  const start = rangeStart(filter.range, now);
  if (start === null) return true;
  return at !== null && at >= start;
}

function skillMatched(skill: string, filter: ListFilter): boolean {
  return filter.skill.length === 0 || skill === filter.skill;
}

function statusMatched(status: string, filter: ListFilter): boolean {
  return filter.status.length === 0 || status === filter.status;
}

/** 报告页的技能名藏在提案里：没有提案（还没到出稿那一步）就是空串，只在「全部技能」时命中 */
function reportSkill(item: RunReport): string {
  return item.proposal?.skill ?? "";
}

/** 待处理没有分页（它天然很短，且有 5 秒自动刷新，翻页会把人翻丢） */
export function buildViewPage(state: WebState, view: WebView, filter: ListFilter, now: number): ViewPage {
  if (view === "approvals") {
    return { view, rows: state.approvals, page: 1, pages: 1, total: state.approvals.length };
  }
  if (view === "applied") {
    // 已采纳页的状态只有一个值（applied），下拉里选别的就什么都不剩 —— 这是筛选的真结果，不是 bug
    const rows = state.applied.filter(
      (item) =>
        skillMatched(item.skill, filter) &&
        (filter.status.length === 0 || filter.status === "applied") &&
        inRange(item.appliedAt, filter, now),
    );
    return { view, ...paginate(rows, filter.page) };
  }
  if (view === "done") {
    const rows = state.done.filter(
      (item) => skillMatched(item.skill, filter) && statusMatched(item.status, filter) && inRange(item.at, filter, now),
    );
    return { view, ...paginate(rows, filter.page) };
  }
  if (view === "reports") {
    const rows = state.reports.filter(
      (item) =>
        skillMatched(reportSkill(item), filter) &&
        statusMatched(item.status, filter) &&
        inRange(item.startedAt, filter, now),
    );
    return { view, ...paginate(rows, filter.page) };
  }
  const rows = state.pending.filter(
    (item) =>
      skillMatched(item.skill, filter) &&
      statusMatched(PENDING_STATUS[item.kind], filter) &&
      inRange(item.at, filter, now),
  );
  return { view, ...paginate(rows, filter.page) };
}

/** 生成翻页链接：必须带上其它筛选参数，否则点下一页等于把筛选清空 */
export function pageHref(view: WebView, filter: ListFilter, page: number): string {
  const params = new URLSearchParams({ view, range: filter.range, page: String(page) });
  if (filter.skill.length > 0) params.set("skill", filter.skill);
  if (filter.status.length > 0) params.set("status", filter.status);
  return `/?${params.toString()}`;
}

/**
 * `?view=` → 页面名。只认白名单，其它（含 null、空串、`../`）一律回落待处理页 ——
 * 这个值会进 `<a href>` 与 303 的 location，所以必须是枚举而不是原样回显。
 */
export function parseView(raw: string | null): WebView {
  return (WEB_VIEWS as readonly string[]).includes(raw ?? "") ? (raw as WebView) : "pending";
}

/**
 * 面板上的全部页面：五个列表页 + 技能管理 + 三个详情页。
 *
 * 详情页（run / skill / session）与技能管理页**需要额外参数**（runId / name / days / sessionId），
 * 所以它们不能进 `VIEW_ORDER`, 也不能靠 `parseView` 认 —— 这是两件事，两个函数各自负责一件事。
 */
export const PANEL_VIEWS = [...WEB_VIEWS, "skills", "skill", "run", "session"] as const;
export type PanelView = (typeof PANEL_VIEWS)[number];

/** `?view=` → 全页面名；只认白名单，其余（含 null、`../`）回落待处理页 */
export function parsePanelView(raw: string | null): PanelView {
  return (PANEL_VIEWS as readonly string[]).includes(raw ?? "") ? (raw as PanelView) : "pending";
}

/**
 * 303 回跳只能落在「能显示横幅」的页：列表页 + 技能管理。
 * 详情页回跳会丢参数（`?view=run` 没有 runId 就是 404），所以它们一律归一成待处理页。
 */
export function parseRedirectView(raw: string | null): WebView | "skills" {
  const view = parsePanelView(raw);
  if (view === "skills") return "skills";
  return (WEB_VIEWS as readonly string[]).includes(view) ? (view as WebView) : "pending";
}

/** 是不是「什么都没筛」（默认 range=7d、第 1 页）：待处理页的自动刷新靠它决定 URL 要不要带参数 */
export function isDefaultFilter(filter: ListFilter): boolean {
  return filter.skill.length === 0 && filter.status.length === 0 && filter.page === 1 && filter.range === DEFAULT_RANGE;
}
