/**
 * 会话正文与目录的**渲染**：把 session-view.ts 解析出来的块拼成 HTML 与目录条目。
 *
 * 与解析拆开是因为两件事的行数各自都不小：解析要处理 pi 的 JSONL 细节，
 * 渲染要处理 Markdown、折叠、目录锚点与总输出上限 —— 合在一个文件里必然破 300 行。
 *
 * 三条口径：
 * 1. **正文走 Markdown-lite**：pi 的对话里满是 `**加粗**`、`` `代码` ``、列表，
 *    原样输出等于让人读一堆星号（用户 2026-11-08：「Markdown 原样输出」）；
 * 2. **工具块默认收起**，抬头给「次数 + 首个参数摘要」——`bash ×9` 看不出调了什么；
 * 3. **正文与目录一次遍历产出**：锚点 id 与目录 href 因此不会对不上。
 */
import { renderMarkdownLite } from "./markdown-lite.ts";
import {
  MAX_MESSAGES,
  MAX_OUTPUT,
  MAX_TEXT,
  MAX_USER_TEXT,
  type SessionEntry,
  type SessionToolCall,
  type SessionTranscript,
} from "./session-view.ts";
import { escapeHtml, formatTime, formatTimeSeconds } from "./text.ts";

/** 折叠抬头里的首个参数摘要上限 */
export const TOOL_PREVIEW = 60;
/** 目录条目里的用户消息摘要上限 */
export const TOC_TEXT = 40;

/** 截断并加省略号：中文一行话也可能超长，所以在字符数上截，不在行上截 */
function clip(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

/** 工具调用的抬头：`read ×3、bash ×2`（同名的合成一个计数，别写三遍 read） */
function toolSummary(calls: readonly SessionToolCall[]): string {
  const counts = new Map<string, number>();
  for (const call of calls) counts.set(call.name, (counts.get(call.name) ?? 0) + 1);
  return [...counts.entries()].map(([name, count]) => `${name} ×${count}`).join("、");
}

/** 一个工具调用块：名字 + 参数摘要 + 结果前 200 字（全转义，original 里可能带尖括号） */
function toolBlock(call: SessionToolCall): string {
  return `<div class="tool">
<p class="tool-name">${escapeHtml(call.name)}</p>
<pre class="tool-args">${escapeHtml(call.args.length > 0 ? call.args : "（无参数）")}</pre>
<pre class="tool-result">${escapeHtml(call.result)}</pre>
</div>`;
}

/**
 * 一组工具调用：`<details>` **默认收起**（不加 `open`）——
 * 一段会话动辄几百次调用，默认展开等于把对话正文顶到十屏之外。
 * 抬头里给「首个参数摘要」：`bash ×9` 看不出调了什么，`rg -n "x" lib` 一眼就知道。
 */
function toolGroup(calls: readonly SessionToolCall[]): string {
  const first = calls[0];
  // 摘要按工具取（bash 取 command 第一行、read 取文件名…），取不到就只留 `▸ bash ×9`
  const preview = first === undefined ? "" : clip(first.summary, TOOL_PREVIEW);
  const tail = preview.length === 0 ? "" : ` · <span class="muted">${escapeHtml(preview)}</span>`;
  return `<details class="tools"><summary>▸ ${escapeHtml(toolSummary(calls))}${tail}</summary>
${calls.map(toolBlock).join("\n")}
</details>`;
}

/** `only=user` 时工具调用的替身：一行说清省略了多少次，并给「看全部」的链接 */
function omittedLine(calls: readonly SessionToolCall[], expandHref: string | null): string {
  const more = expandHref === null ? "" : `（<a href="${escapeHtml(expandHref)}">看全部</a>）`;
  return `<p class="hint">… 本轮省略 ${calls.length} 次工具调用${more}</p>`;
}

/** 目录条目：`19:35 · 前 40 字`（换行压成空格，否则目录会被一段代码撑成几行） */
export interface TocEntry {
  id: string;
  at: number | null;
  text: string;
}

export interface TranscriptView {
  /** 消息流 HTML */
  body: string;
  /** 目录条目（只收 user 消息，顺序与正文一致） */
  toc: TocEntry[];
  /** 实际渲染的块数 */
  shown: number;
  /** 是否撞到总输出上限 */
  truncated: boolean;
}

export interface RenderSessionOptions {
  /** 因「只渲染最后 200 条」丢掉的条数（>0 时在顶部说明一句） */
  dropped?: number;
  /** 只看对话：工具调用压成一行 */
  onlyUser?: boolean;
  /** 只留某一方的消息（"user" / "assistant"）：工具块与另一方的消息都不渲染，用于快速定位 */
  onlyRole?: "user" | "assistant";
  /** 「看全部」链接（去掉 only=user 的同一会话地址） */
  expandHref?: string | null;
}

/** 一条对话消息：徽章 + 时刻 + Markdown-lite 正文（用户底色更亮，扫读时能一眼分段） */
function messageBlock(
  entry: Extract<SessionEntry, { kind: "user" | "assistant" }>,
  id: string,
  label: { text: string; tone: string },
): { html: string; text: string } {
  const max = entry.kind === "user" ? MAX_USER_TEXT : MAX_TEXT;
  const body = clip(entry.text, max);
  if (body.length === 0) return { html: "", text: "" };
  const at = entry.at === null ? "" : `<span class="at">${formatTimeSeconds(entry.at)}</span>`;
  const html = `<div class="msg ${entry.kind} m" id="${id}">
<div class="mhead"><span class="badge ${label.tone}">${label.text}</span>${at}</div>
<div class="msg-body">${renderMarkdownLite(body)}</div>
</div>`;
  return { html, text: body.replace(/\s+/g, " ").trim() };
}

/**
 * 会话正文 + 目录：**一次遍历同时产出两者**，锚点 id 与目录 href 因此不会对不上
 * （分两处各自编号迟早出现「点了目录跳错块」）。
 */
export function renderTranscript(
  transcript: SessionTranscript,
  options: RenderSessionOptions = {},
): TranscriptView {
  const parts: string[] = [];
  const toc: TocEntry[] = [];
  let size = 0;
  let shown = 0;
  let truncated = false;
  if (options.dropped !== undefined && options.dropped > 0) {
    parts.push(
      `<p class="hint">只渲染最后 ${MAX_MESSAGES} 条消息，前面还有 ${options.dropped} 条未显示（看全文请用 rg/read 打开原文件）。</p>`,
    );
  }
  for (const entry of transcript.entries) {
    // 角色过滤：只看用户时工具调用压成一行（保留「省略了几次」的信息），只看助手时工具块整块跳过
    if (options.onlyRole === "assistant" && entry.kind === "tools") continue;
    if (options.onlyRole !== undefined && entry.kind !== "tools" && entry.kind !== options.onlyRole) continue;
    const id = `m-${shown + 1}`;
    const rendered =
      entry.kind === "tools"
        ? {
            html:
              options.onlyRole === "user"
                ? omittedLine(entry.calls, options.expandHref ?? null)
                : toolGroup(entry.calls),
            text: "",
          }
        : messageBlock(
            entry,
            id,
            entry.kind === "user" ? { text: "用户", tone: "blue" } : { text: "助手", tone: "green" },
          );
    if (rendered.html.length === 0) continue;
    if (size + rendered.html.length > MAX_OUTPUT) {
      truncated = true;
      break;
    }
    shown += 1;
    parts.push(rendered.html);
    size += rendered.html.length;
    // 目录跟着过滤走：看全部时以用户消息为章节，只看助手时以助手回复为章节
    const tocRole = options.onlyRole ?? "user";
    if (entry.kind === tocRole) {
      toc.push({ id, at: entry.at, text: clip(rendered.text, TOC_TEXT) });
    }
  }
  if (shown === 0) {
    return {
      body: '<p class="empty">这段会话里没有可渲染的对话（可能全是工具调用与系统提示）。</p>',
      toc,
      shown,
      truncated,
    };
  }
  if (truncated) {
    parts.push(
      `<p class="hint">已达页面输出上限（${Math.round(MAX_OUTPUT / 1024)}KB），后面还有内容未渲染：继续看请用 rg/read 打开原文件。</p>`,
    );
  }
  return { body: parts.join("\n"), toc, shown, truncated };
}

/**
 * 目录内容（左侧粘性栏与窄屏折叠目录共用同一份）：
 * 只列 user 消息 —— 一段会话里用户消息就是天然的「章节」。
 */
export function renderToc(toc: readonly TocEntry[]): string {
  if (toc.length === 0) return `<p class="hint">这段会话里没有用户消息。</p>`;
  return toc
    .map((item) => {
      const when = item.at === null ? "—" : formatTime(item.at);
      return `<a href="#${item.id}">${escapeHtml(when)} · ${escapeHtml(item.text)}</a>`;
    })
    .join("\n");
}
