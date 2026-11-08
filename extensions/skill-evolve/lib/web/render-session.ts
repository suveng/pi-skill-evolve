/**
 * 会话详情页（`?view=session&sessionId=...`）的渲染：概要 + 对话正文 + 原文件指路。
 *
 * 页面只有三段：顶部概要（完整 sessionId / 文件路径 / 统计）、中间正文（由 session-view 纯函数产出）、
 * 底部一行「原文件 路径（N 条消息 / M 次工具调用 / 大小 K）」——
 * 面板解析不了的情况（超大文件、非 JSONL）必须能一键回到原文件，不然这一页就成了死胡同。
 *
 * 找不到会话文件不报错：换机器 / 清理过 sessions 是常态，说清「会话文件已不在本机」比 500 有用。
 */
import type { WebState } from "./data.ts";
import type { SessionSource } from "./session-file.ts";
import { renderSessionBody } from "./session-view.ts";
import { shellPage } from "./shell.ts";
import { escapeHtml } from "./text.ts";

/** 概要的一行：标签 + 值（值必须已转义或本身就是标签串） */
function kv(label: string, value: string): string {
  return `<div class="kv-row"><span class="k">${label}</span><span class="v">${value}</span></div>`;
}

/** 大小：小于 1KB 说字节，其余按 KB 取整（MB 级数字太长，看个量级就够） */
function formatSize(bytes: number): string {
  return bytes < 1024 ? `${bytes}B` : `${Math.round(bytes / 1024)}KB`;
}

/** 缺文件时的正文：给三句人话，说明为什么没有、去哪里看 */
function missingBody(sessionId: string): string {
  return `<p class="empty">会话文件已不在本机：sessionId <code>${escapeHtml(sessionId)}</code> 在
<code>~/.pi/agent/sessions/*</code> 下没有对应的 <code>.jsonl</code>。
可能是换了机器、或 sessions 目录被清理过 —— 这一段对话的原文已经取不到了。</p>`;
}

/** 正文：有文件就渲染对话，没文件就给缺文件说明 */
function bodyOf(source: SessionSource): string {
  if (source.file === null || source.transcript === null) return missingBody(source.sessionId);
  return renderSessionBody(source.transcript, { dropped: source.transcript.dropped });
}

/**
 * 页脚那一行是这一页的「出口」：绝对路径可以直接粘到终端里 `rg` / `read`，
 * 统计数字则用来说明「页面里看到的是全面的还是截断的」。
 */
function footerOf(source: SessionSource): string {
  if (source.file === null || source.transcript === null) return `原文件：<span class="off">会话文件已不在本机</span>`;
  const { messages, toolCalls } = source.transcript;
  return `原文件 <code>${escapeHtml(source.file)}</code>（${messages} 条消息 / ${toolCalls} 次工具调用 / ${formatSize(source.sizeBytes)}）`;
}

export function renderSessionPage(source: SessionSource, options: { state: WebState }): string {
  const href = source.file === null ? null : source.file;
  const body = `<section>
<h2>会话</h2>
<div class="kv">
${kv("sessionId", `<code>${escapeHtml(source.sessionId)}</code>`)}
${kv("会话文件", href === null ? `<span class="off">会话文件已不在本机</span>` : `<code>${escapeHtml(href)}</code>`)}
${kv("工具调用", "折叠块默认收起，点标题展开（参数摘要 ≤400 字、结果前 200 字）")}
</div>
</section>
${bodyOf(source)}`;
  return shellPage({
    state: options.state,
    title: `会话 ${source.sessionId.slice(0, 8)}`,
    active: null,
    body,
    foot: footerOf(source),
  });
}
