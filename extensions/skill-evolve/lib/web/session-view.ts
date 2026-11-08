/**
 * 会话详情页的**纯函数**：把 pi 的会话 JSONL 解析成「可渲染的块」，再拼成 HTML 片段。
 *
 * 为什么要这一页（用户 2026-11-08：「支持打开会话的详情, 工具调用可收起展开, 默认收起」）：
 * 面板上每条 run 都关联一段 pi 会话，出问题时要看的是「那段对话里到底发生了什么」——
 * 而 sessions/*.jsonl 有几 MB、几千行，在编辑器里翻根本对不上哪句是哪轮。
 *
 * 结构口径（与 pi 的真实写入一致）：
 * - 只取顶层 `type === "message"` 的条目，其余（session / model_change / thinking_level_change / custom）全跳过；
 * - `message.role` = user / assistant / toolResult / system；system 不渲染（它是系统提示词，不是对话）；
 * - assistant 的内容里 `text` 是给人看的、`thinking` 不渲染、`toolCall` 聚成折叠块；
 * - toolResult 消息按 `toolCallId` 回连到那次调用（结果贴在该调用的参数之后）。
 *
 * 三条上限（会话可能很大，页面不能被一段对话撑爆浏览器）：
 * 只渲染最后 200 条消息 · 单条 4000 字 · 用户原文 2000 字 · 总输出超 2MB 就停手并指路原文件。
 *
 * 这个文件里**没有一行 IO**：入参是字符串，出参是 HTML 字符串，所以能直接拿临时 JSONL 片段做单测。
 */
import { escapeHtml } from "./text.ts";

/** 只渲染最后多少条 message（更早的对话对排查当前问题几乎无用） */
export const MAX_MESSAGES = 200;
/** 单条消息正文上限 */
export const MAX_TEXT = 4000;
/** 用户消息正文上限：用户要的是「原文」，所以给得比 assistant 宽，但仍要防一次粘贴几万字 */
export const MAX_USER_TEXT = 2000;
/** 一次工具调用的参数摘要上限 */
export const MAX_ARGS = 400;
/** 一次工具调用的结果上限 */
export const MAX_RESULT = 200;
/** 整页会话正文的输出上限（字符数，UTF-8 下中文 3 字节，这里按保守值算） */
export const MAX_OUTPUT = 2 * 1024 * 1024;

export interface SessionToolCall {
  name: string;
  /** 参数摘要（JSON 压成一行后截断） */
  args: string;
  /** 结果前 200 字（没有结果就是「（没有结果）」） */
  result: string;
}

export type SessionEntry =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "tools"; calls: SessionToolCall[] };

/**
 * 解析中途的调用记录：结果（toolResult）总是排在携带 toolCall 的 assistant 消息**之后**，
 * 所以先带 id 收进来，全文扫完再回填结果 —— 边扫边取会永远取不到（那时结果还没出现）。
 */
interface RawCall {
  id: string;
  name: string;
  args: string;
}

export interface SessionTranscript {
  entries: SessionEntry[];
  /** 解析到的 message 总条数（不限 200） */
  messages: number;
  /** 工具调用总次数 */
  toolCalls: number;
  /** 因为只留最后 200 条而丢掉的消息条数 */
  dropped: number;
}

/** 截断并加省略号：中文一行话也可能超长，所以在字符数上截，不在行上截 */
function clip(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

/** 参数压成一行 JSON：多行缩进在面板里只会占满屏 */
function argumentsText(value: unknown): string {
  let text: string;
  if (typeof value === "string") {
    text = value;
  } else {
    try {
      text = JSON.stringify(value) ?? "";
    } catch {
      text = String(value);
    }
  }
  return clip(text.replace(/\s+/g, " "), MAX_ARGS);
}

/** toolResult / user 的 content：可能是字符串，也可能是 [{type:"text",text}]，图片只留一句占位 */
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (typeof part !== "object" || part === null) continue;
    const record = part as Record<string, unknown>;
    if (record.type === "text" && typeof record.text === "string") parts.push(record.text);
    else if (record.type === "image") parts.push("（图片输出）");
  }
  return parts.join("\n");
}

/** 工具结果：只留前 200 字（完整输出在原理行数里，面板里看首尾就够判断成败） */
function resultText(content: unknown): string {
  return clip(contentText(content), MAX_RESULT);
}

/** assistant 内容块：文本拼接、toolCall 收集；thinking 不渲染（它是推理过程，不是回答） */
function readAssistantParts(content: unknown): { text: string; calls: RawCall[] } {
  if (typeof content === "string") return { text: content, calls: [] };
  if (!Array.isArray(content)) return { text: "", calls: [] };
  const texts: string[] = [];
  const calls: RawCall[] = [];
  for (const part of content) {
    if (typeof part !== "object" || part === null) continue;
    const record = part as Record<string, unknown>;
    if (record.type === "text" && typeof record.text === "string") texts.push(record.text);
    else if (record.type === "toolCall") {
      calls.push({
        id: typeof record.id === "string" ? record.id : "",
        name: typeof record.name === "string" ? record.name : "（未命名工具）",
        args: argumentsText(record.arguments),
      });
    }
  }
  return { text: texts.join("\n"), calls };
}

/** 解析整份 JSONL：坏行跳过（可能是进程被 kill 时写了一半的最后一行） */
export function parseSessionText(raw: string): SessionTranscript {
  type Pending = { entry: SessionEntry | { kind: "tools"; calls: RawCall[] }; roles: string[] };
  const kept: Pending[] = [];
  const results = new Map<string, string>();
  let messages = 0;
  for (const line of raw.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (record.type !== "message") continue;
    const message = record.message;
    if (typeof message !== "object" || message === null) continue;
    const fields = message as Record<string, unknown>;
    const role = typeof fields.role === "string" ? fields.role : "";
    messages += 1;
    if (role === "toolResult") {
      // 结果先存起来：它总是排在携带 toolCall 的那条 assistant 消息之后
      const id = typeof fields.toolCallId === "string" ? fields.toolCallId : "";
      if (id.length > 0) results.set(id, resultText(fields.content));
      continue;
    }
    if (role === "user") {
      kept.push({ entry: { kind: "user", text: contentText(fields.content) }, roles: [role] });
      continue;
    }
    if (role !== "assistant") continue; // system 是系统提示词，不是对话
    const parts = readAssistantParts(fields.content);
    if (parts.text.trim().length > 0) {
      const last = kept[kept.length - 1];
      // 一条 assistant 消息里「文本 + toolCall」并存：文本先出，工具另起一段，顺序与真实发生一致
      if (last && last.roles[last.roles.length - 1] === "assistant-text") last.entry = { kind: "assistant", text: `${(last.entry as { text: string }).text}\n${parts.text}` };
      else kept.push({ entry: { kind: "assistant", text: parts.text }, roles: ["assistant-text"] });
    }
    if (parts.calls.length > 0) {
      const last = kept[kept.length - 1];
      // 连续工具调用（中间没有文本）聚成一个折叠块：一次 read 一个块会堆出上百个折叠框
      if (last && last.entry.kind === "tools" && last.roles[last.roles.length - 1] !== "assistant-text") {
        (last.entry.calls as RawCall[]).push(...parts.calls);
      } else {
        kept.push({ entry: { kind: "tools", calls: [...parts.calls] }, roles: ["tools"] });
      }
    }
  }
  const toolCalls = kept.reduce((sum, item) => (item.entry.kind === "tools" ? sum + item.entry.calls.length : sum), 0);
  const dropped = Math.max(0, kept.length - MAX_MESSAGES);
  // 全文扫完再回填结果：toolResult 一定在 toolCall 之后出现
  const entries: SessionEntry[] = kept.slice(dropped).map((item) =>
    item.entry.kind === "tools"
      ? {
          kind: "tools",
          calls: (item.entry.calls as RawCall[]).map((call) => ({
            name: call.name,
            args: call.args,
            result: results.get(call.id) ?? "（没有结果）",
          })),
        }
      : item.entry,
  );
  return { entries, messages, toolCalls, dropped };
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
 */
function toolGroup(calls: readonly SessionToolCall[]): string {
  return `<details class="tools"><summary>工具调用：${escapeHtml(toolSummary(calls))}（点击展开）</summary>
${calls.map(toolBlock).join("\n")}
</details>`;
}

/** 一条对话消息：user 给原文（2000 字上限），assistant 给纯文本（4000 字上限） */
function messageBlock(entry: Extract<SessionEntry, { kind: "user" | "assistant" }>): string {
  const label = entry.kind === "user" ? "用户" : "助手";
  const max = entry.kind === "user" ? MAX_USER_TEXT : MAX_TEXT;
  const body = clip(entry.text, max);
  if (body.length === 0) return "";
  return `<div class="msg ${entry.kind}">
<p class="who">${label}</p>
<pre>${escapeHtml(body)}</pre>
</div>`;
}

export interface RenderSessionOptions {
  /** 因「只渲染最后 200 条」丢掉的条数（>0 时在顶部说明一句） */
  dropped?: number;
}

/** 会话正文：按真实顺序渲染，超出总输出上限就停下并指路原文件 */
export function renderSessionBody(transcript: SessionTranscript, options: RenderSessionOptions = {}): string {
  const parts: string[] = [];
  let size = 0;
  let stopped = false;
  if (options.dropped !== undefined && options.dropped > 0) {
    parts.push(`<p class="hint">只渲染最后 ${MAX_MESSAGES} 条消息，前面还有 ${options.dropped} 条未显示（看全文请用 rg/read 打开原文件）。</p>`);
  }
  for (const entry of transcript.entries) {
    const html = entry.kind === "tools" ? toolGroup(entry.calls) : messageBlock(entry);
    if (html.length === 0) continue;
    if (size + html.length > MAX_OUTPUT) {
      stopped = true;
      break;
    }
    parts.push(html);
    size += html.length;
  }
  if (stopped) {
    parts.push(`<p class="hint">已达页面输出上限（${Math.round(MAX_OUTPUT / 1024)}KB），后面还有内容未渲染：继续看请用 rg/read 打开原文件。</p>`);
  }
  if (parts.length === 0) return '<p class="empty">这段会话里没有可渲染的对话（可能全是工具调用与系统提示）。</p>';
  return parts.join("\n");
}
