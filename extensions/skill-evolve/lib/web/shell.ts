/**
 * 页面骨架与顶部导航：五个列表页 + 技能管理页 + 两个详情页共用同一份。
 *
 * 为什么抽出来：run 详情页与技能详情页也要状态栏、六个 tab、内联样式，
 * 各自复制一遍必然出现「点进详情页 tab 高亮错页、状态栏数字少算一个」。
 * 这里只拼字符串：不读盘、不发请求、不引外部资源 —— 数据由调用方读好传进来。
 */
import type { WebState, WebView } from "./data.ts";
import { STYLE } from "./style.ts";

/** 导航里的 tab 与顺序（用户 2026-11-08 点名要的顺序：已采纳独立、技能管理排最后） */
export const TAB_ORDER = ["pending", "approvals", "applied", "done", "reports", "skills"] as const;
export type TabView = (typeof TAB_ORDER)[number];

export const VIEW_LABEL: Record<TabView, string> = {
  pending: "待处理",
  approvals: "待审批",
  applied: "已采纳",
  done: "已处理",
  reports: "复盘报告",
  skills: "技能管理",
};

/**
 * 当前高亮的 tab。详情页传 `null`：它们不在导航里（要 runId / 技能名才能进来），
 * 硬highlight 某个 tab 等于骗人 —— 点那个 tab 回不到这一页。
 */
export type ActiveTab = WebView | "skills" | null;

/** 导航：`<a href>` 只用枚举值拼，绝不把 query 原样回显 */
export function tabs(active: ActiveTab): string {
  return TAB_ORDER.map((item) => {
    const className = item === active ? ' class="active"' : "";
    return `<a href="/?view=${item}"${className}>${VIEW_LABEL[item]}</a>`;
  }).join("\n");
}

/** 状态栏：全是数字，安全；「待批 N」「已采纳 N」都直接链到对应页（用户就是点那个数字的） */
export function statusBar(state: WebState): string {
  const percent = (state.summary.rollbackRate * 100).toFixed(0);
  return [
    `复盘中 ${state.summary.reviewing}`,
    `卡死 ${state.summary.stale}`,
    `待批 <a href="/?view=approvals">${state.summary.pendingApprovals}</a>`,
    `已采纳 <a href="/?view=applied">${state.summary.appliedTotal}</a>`,
    `回滚率 ${percent}%`,
  ].join(" · ");
}

export interface ShellInput {
  state: WebState;
  /** 页面标题：进 `<title>`，页面上不再重复一遍 */
  title: string;
  active: ActiveTab;
  /** `<head>` 里的额外标签（目前只有待处理页的 5 秒自刷新） */
  head?: string;
  /** 导航上方的「控制条 + 横幅」 */
  top?: string;
  /** `<main>` 内容 */
  body: string;
  /** 页脚内容（列表页传「最近操作 + 只读说明」） */
  foot?: string;
}

export function shellPage(input: ShellInput): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${input.head ?? ""}<title>技能进化 · ${input.title}</title>
<style>${STYLE}</style>
</head>
<body>
<h1>技能进化面板</h1>
<p class="bar">${statusBar(input.state)}</p>
${input.top ?? ""}<nav>
${tabs(input.active)}
</nav>
${input.body}
<footer>
${input.foot ?? ""}
</footer>
</body>
</html>
`;
}
