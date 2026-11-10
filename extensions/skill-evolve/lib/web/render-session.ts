/**
 * 会话详情页（`?view=session&sessionId=...`）的渲染：顶部一行 + 概览 + 目录 + 消息流 + 出口。
 *
 * 这一页的四件东西（用户 2026-11-08 现场反馈）：
 * 1. **顶部一行**：`← 返回待处理` / `会话 01a1b90f` / 原文件路径 / `跳到最新 ↓` —— 原来没有返回入口，进来就出不去；
 * 2. **左侧粘性目录**（`>=1200px`）：会话动辄几千行，一路往下滚太累；窄屏改用顶部折叠目录兜底；
 * 3. **只看对话**（`?only=user`）：只在服务端过滤，工具调用压成一行（不引 JS）；
 * 4. **底部出口**：说明渲染了多少条、还剩多少没显示、原文件在哪 —— 面板解析不了的，一键回到原文件。
 *
 * 找不到会话文件不报错：换机器 / 清理过 sessions 是常态，说清「会话文件已不在本机」比 500 有用。
 */
import type { WebState } from "./data.ts";
import { renderToc, renderTranscript } from "./session-render.ts";
import type { SessionSource } from "./session-file.ts";
import { MAX_MESSAGES } from "./session-view.ts";
import { shellPage } from "./shell.ts";
import { escapeHtml, formatSpan } from "./text.ts";

/** 大小：字节 / KB / MB 三档，MB 给两位小数（5MB 级会话差 0.5MB reader 也看得出） */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)}MB`;
}

/** `?only=` 的唯一解析入口：只认 user / assistant，其它（含拼错、空串）一律回到全部 */
export function parseOnly(raw: string | null): OnlyRole {
  return raw === "user" || raw === "assistant" ? raw : null;
}

/** 角色过滤：`null` = 全部（工具块压成可展开的折叠块），user/assistant = 只要这一方 */
export type OnlyRole = "user" | "assistant" | null;

/** 本页自己的地址：`sessionId` + 可选 `file` + 可选 `only=user|assistant`（全部走编码后的枚举值） */
function sessionUrl(sessionId: string, file: string | null, only: OnlyRole): string {
  const params = new URLSearchParams({ view: "session", sessionId });
  if (file !== null) params.set("file", file);
  if (only !== null) params.set("only", only);
  return `/?${params.toString()}`;
}

/** 缺文件时的正文：给三句人话，说明为什么没有、去哪里看 */
function missingBody(sessionId: string): string {
  return `<p class="empty">会话文件已不在本机：sessionId <code>${escapeHtml(sessionId)}</code> 在
<code>~/.pi/agent/sessions/*</code> 下没有对应的 <code>.jsonl</code>。
可能是换了机器、或 sessions 目录被清理过 —— 这一段对话的原文已经取不到了。</p>`;
}

/** 顶部一行：返回入口 + 会话标识 + 原文件 + 跳到最新（长路径自己换行，不挤掉别的元素） */
function topRow(source: SessionSource, lastId: string | null): string {
  const id = escapeHtml(source.sessionId.slice(0, 8));
  const file =
    source.file === null
      ? `<span class="off">会话文件已不在本机</span>`
      : `<code title="${escapeHtml(source.file)}">${escapeHtml(source.file)}</code>`;
  const toEnd = lastId === null ? "" : `<a class="to-end" href="#${lastId}">跳到最新 ↓</a>`;
  return `<div class="ses-top">
<a href="/?view=pending&amp;range=all">← 返回待处理</a>
<span class="ses-id">会话 <code>${id}</code></span>
<span class="ses-file">原文件 ${file}</span>
${toEnd}
</div>`;
}

/** 概览卡片：消息数 / 工具调用 / 大小 / 时间跨度 + 角色切换（全部 / 只看用户 / 只看助手） */
function overview(
  source: SessionSource,
  toggle: string,
  only: OnlyRole,
): string {
  const transcript = source.transcript;
  if (transcript === null) return "";
  const span = formatSpan(transcript.firstAt, transcript.lastAt);
  const parts = [
    `消息 ${transcript.messages}`,
    `工具调用 ${transcript.toolCalls}`,
    formatSize(source.sizeBytes),
  ];
  if (span.length > 0) parts.push(span);
  const current = only === null ? "当前：全部（工具块可展开）" : only === "user" ? "当前：只看用户消息" : "当前：只看助手消息";
  return `<p class="ov">${parts.join(" · ")} <span class="ov-link">${toggle}</span> <span class="muted">${current}</span></p>`;
}

/**
 * 正文骨架：左侧粘性目录（宽屏）+ 消息流；窄屏把同一份目录换成顶部折叠块。
 * 目录与消息流共用 `renderTranscript` 的产出，锚点 id 与 href 一一对应。
 */
function streamOf(source: SessionSource, only: OnlyRole): { html: string; lastId: string | null } {
  const transcript = source.transcript;
  if (transcript === null) return { html: missingBody(source.sessionId), lastId: null };
  const view = renderTranscript(transcript, {
    dropped: transcript.dropped,
    onlyRole: only === null ? undefined : only,
    expandHref: only === "user" ? sessionUrl(source.sessionId, source.file, null) : null,
  });
  const toc = renderToc(view.toc);
  const tocTitle = only === "assistant" ? "目录（助手回复）" : "目录（用户消息）";
  const lastId = view.shown === 0 ? null : `m-${view.shown}`;
  return {
    html: `<div class="ses-wrap">
<details class="toc" open><summary>${tocTitle} ${view.toc.length} 条 · 点标题收起</summary>
<div class="toc-list">${toc}</div></details>
<div class="ses-body">
<details class="toc-fold"><summary>${tocTitle} ${view.toc.length} 条</summary>
<div class="toc-list">${toc}</div>
</details>
${view.body}
${lastId === null ? "" : `<a class="to-top" href="#top">↑ 回到顶部</a>`}
</div>
</div>`,
    lastId,
  };
}

/** 底部出口：渲染了多少、还剩多少、原文件在哪（面板解析不了时全靠这一行） */
function exitLine(source: SessionSource): string {
  if (source.file === null || source.transcript === null) {
    return `原文件：<span class="off">会话文件已不在本机</span>`;
  }
  const { dropped, messages } = source.transcript;
  const file = `<code>${escapeHtml(source.file)}</code>`;
  if (dropped > 0) {
    return `已渲染最后 ${MAX_MESSAGES} 条 · 前 ${dropped} 条未显示（原文件 ${file}，共 ${messages} 条消息）`;
  }
  return `已渲染全部 ${messages} 条消息（原文件 ${file}）`;
}

export function renderSessionPage(
  source: SessionSource,
  options: { state: WebState; only?: OnlyRole; /** 旧签名，等价于 only="user" */ onlyUser?: boolean },
): string {
  const only: OnlyRole = options.only ?? (options.onlyUser === true ? "user" : null);
  const transcript = source.transcript;
  const link = (role: OnlyRole, text: string): string => {
    if (role === only) return `<strong>${text}</strong>`;
    return `<a href="${escapeHtml(sessionUrl(source.sessionId, source.file, role))}">${text}</a>`;
  };
  const toggle =
    transcript === null ? "" : [link(null, "全部"), link("user", "只看用户"), link("assistant", "只看助手")].join(" / ");
  // 先渲染消息流：「跳到最新」要指向**实际渲染出的最后一块**，而不是 entries 条数（工具块与空正文都不占块号）
  const stream = streamOf(source, only);
  const body = `${topRow(source, stream.lastId)}
${overview(source, toggle, only)}
${stream.html}`;
  return shellPage({
    state: options.state,
    title: `会话 ${source.sessionId.slice(0, 8)}`,
    active: null,
    body,
    foot: exitLine(source),
  });
}
