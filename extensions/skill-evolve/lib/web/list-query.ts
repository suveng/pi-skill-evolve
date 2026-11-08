/**
 * 列表页的三个**显式开关** query：`live`（自动刷新）、`open`（分组是否展开）、`only`（会话页只看对话）。
 *
 * 为什么与 filter.ts 分开：筛选决定「哪些条目出现」，这三个开关决定「同一批条目怎么呈现/何时重载」。
 * 混进 `ListFilter` 会让 `paginate` / `buildViewPage` 每处都得带着两个不相干的字段。
 *
 * 为什么全走 URL 而不是 JS：面板零 JS。用户点过「收起分组」就该在这次刷新后仍然收着 ——
 * 只有 URL 能记住这件事（服务端读它并显式回写链接），localStorage 之类都不在这个面板的可用手段里。
 */
import { pageHref, type ListFilter } from "./filter.ts";
import type { WebView } from "./data.ts";

export interface ListExtras {
  /** 5 秒整页自动刷新：只在待处理页生效（其它页数据不会自己变，重载只会丢展开态） */
  live: boolean;
  /** 分组默认展开；`none` 是用户点了「全部收起」 */
  open: "all" | "none";
  /** 会话页只看对话（user 消息 + 助手纯文本），工具调用压成一行 */
  only: "user" | null;
}

export const DEFAULT_EXTRAS: ListExtras = { live: false, open: "all", only: null };

/**
 * 解析三个开关。**按页面白名单放行**：`live=1` 在已采纳页没有意义，
 * 照单全收会让「?view=done&live=1」也被 5 秒重载一次，用户会以为面板抽风。
 */
export function parseListExtras(params: URLSearchParams, view: WebView | "session"): ListExtras {
  return {
    live: view === "pending" && params.get("live") === "1",
    open: params.get("open") === "none" ? "none" : "all",
    only: view === "session" && params.get("only") === "user" ? "user" : null,
  };
}

/** 翻页 / 刷新 / 收起分组共用的链接拼装：筛选参数由 pageHref 负责，这里只追加三个开关 */
export function listHref(view: WebView, filter: ListFilter, page: number, extras: ListExtras): string {
  const base = pageHref(view, filter, page);
  const params = new URLSearchParams(base.slice(base.indexOf("?") + 1));
  if (extras.live) params.set("live", "1");
  if (extras.open === "none") params.set("open", "none");
  return `/?${params.toString()}`;
}
