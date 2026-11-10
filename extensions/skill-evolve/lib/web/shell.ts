/**
 * 页面骨架与顶部导航：五个列表页 + 技能管理页 + 两个详情页共用同一份。
 *
 * 为什么抽出来：run 详情页与技能详情页也要状态栏、六个 tab、内联样式，
 * 各自复制一遍必然出现「点进详情页 tab 高亮错页、状态栏数字少算一个」。
 * 这里只拼字符串：不读盘、不发请求、不引外部资源 —— 数据由调用方读好传进来。
 *
 * 顶部是**粘性区**（`position: sticky`）：列表滚到第 30 行时，
 * 「现在有几条要处理、我在哪个 tab、四个开关什么状态」仍然看得见 —— 这三样是这一页的全部决策输入。
 */
import type { WebState, WebView } from "./data.ts";
import { STYLE } from "./style.ts";

/** 导航里的 tab 与顺序（用户 2026-11-08 点名要的顺序：已采纳独立、技能管理排最后） */
export const TAB_ORDER = ["pending", "approvals", "applied", "done", "skills", "settings"] as const;
export type TabView = (typeof TAB_ORDER)[number];

export const VIEW_LABEL: Record<TabView, string> = {
  pending: "待处理",
  approvals: "待审批",
  applied: "已采纳",
  done: "已结束",
  skills: "技能管理",
  settings: "设置",
};

/** 每个 tab 的计数徽章；`skills` 没有计数（它不是「条数」） */
export type TabCounts = Partial<Record<TabView, number>>;

/**
 * 当前高亮的 tab。详情页传 `null`：它们不在导航里（要 runId / 技能名才能进来），
 * 硬highlight 某个 tab 等于骗人 —— 点那个 tab 回不到这一页。
 */
export type ActiveTab = WebView | "skills" | "settings" | null;

/** 计数从状态里取：tab 上的数字与列表里的条数必须是同一份数据，不能各算一遍 */
export function tabCounts(state: WebState): TabCounts {
  return {
    pending: state.pending.length,
    approvals: state.approvals.length,
    // 已采纳用 summary 的累计值：列表本身有上限（50 条），拿它当总数会永远显示 50
    applied: state.summary.appliedTotal,
    done: state.done.length,
  };
}

/**
 * 导航：`<a href>` 只用枚举值拼，绝不把 query 原样回显。
 * 不给 counts 时只出标签（详情页与单测用），给了就在标签后面挂一个计数徽章（`.cnt`）。
 */
export function tabs(active: ActiveTab, counts: TabCounts = {}): string {
  return TAB_ORDER.map((item) => {
    const className = item === active ? ' class="active"' : "";
    const count = counts[item];
    const badge = count === undefined ? "" : `<span class="cnt">${count}</span>`;
    return `<a href="/?view=${item}"${className}>${VIEW_LABEL[item]}${badge}</a>`;
  }).join("\n");
}

/**
 * 摘要行：四个数字。「待批」与「已采纳」直接链到对应页 —— 用户就是点那个数字的。
 * 回滚率不在这里：它是周报口径的比率，挤进一行数字里只会让人以为「26% 也要现在处理」。
 */
export function statusBar(state: WebState): string {
  return [
    `复盘中 ${state.summary.reviewing}`,
    `卡死 ${state.summary.stale}`,
    `待批 <a href="/?view=approvals">${state.summary.pendingApprovals}</a>`,
    `已采纳 <a href="/?view=applied">${state.summary.appliedTotal}</a>`,
  ].join(" · ");
}

export interface ShellInput {
  state: WebState;
  /** 页面标题：进 `<title>`，页面上不再重复一遍 */
  title: string;
  active: ActiveTab;
  /** `<head>` 里的额外标签（目前只有 `&live=1` 时的 5 秒自刷新） */
  head?: string;
  /** 粘性区里、tabs 下面的那一行（列表页的四个开关与横幅） */
  top?: string;
  /** 摘要行尾部的小字（列表页的「更新于 … · 刷新」） */
  meta?: string;
  /** `<main>` 内容 */
  body: string;
  /** 页脚内容（列表页传「最近操作 + 只读说明」） */
  foot?: string;
}

export function shellPage(input: ShellInput): string {
  const meta = input.meta === undefined || input.meta.length === 0 ? "" : ` · ${input.meta}`;
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${input.head ?? ""}<title>技能进化 · ${input.title}</title>
<style>${STYLE}</style>
</head>
<body>
<div class="wrap" id="top">
<header class="hd">
<h1>技能进化面板</h1>
<p class="sum">${statusBar(input.state)}${meta}</p>
<nav class="tabs">
${tabs(input.active, tabCounts(input.state))}
</nav>
${input.top ?? ""}</header>
${input.body}
<footer>
${input.foot ?? ""}
</footer>
</div>
</body>
</html>
`;
}
