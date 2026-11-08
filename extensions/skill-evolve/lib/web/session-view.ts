/**
 * 会话详情页的**纯函数**：把 pi 的会话 JSONL 解析成「可渲染的块」，再拼成 HTML 片段与目录。
 *
 * 为什么要这一页（用户 2026-11-08：「支持打开会话的详情, 工具调用可收起展开, 默认收起」）：
 * 面板上每条 run 都关联一段 pi 会话，出问题时要看的是「那段对话里到底发生了什么」——
 * 而 sessions/*.jsonl 有几 MB、几千行，在编辑器里翻根本对不上哪句是哪轮。
 *
 * 结构口径（与 pi 的真实写入一致）：
 * - 只取顶层 `type === "message"` 的条目，其余（session / model_change / thinking_level_change / custom）全跳过；
 * - `message.role` = user / assistant / toolResult / system；system 不渲染（它是系统提示词，不是对话）；
 * - assistant 的内容里 `text` 是给人看的、`thinking` 不渲染、`toolCall` 聚成折叠块；
 * - toolResult 消息按 `toolCallId` 回连到那次调用（结果贴在该调用的参数之后）；
 * - 时间取该条 JSONL 记录顶层的 `timestamp`（ISO 字符串），拿不到就是 null。
 *
 * 三条上限（会话可能很大，页面不能被一段对话撑爆浏览器）：
 * 只渲染最后 200 条消息 · 单条 4000 字 · 用户原文 2000 字 · 总输出超 2MB 就停手并指路原文件。
 *
 * 这个文件里**没有一行 IO**：入参是字符串，出参是数据结构，所以能直接拿临时 JSONL 片段做单测。
 * HTML 与目录在 ./session-render.ts —— 解析与渲染各自都够一屏，混在一起必然破 300 行。
 */

/** 只渲染最后多少条 message（更早的对话对排查当前问题几乎无用） */
export const MAX_MESSAGES = 200;
/** 单条消息正文上限 */
export const MAX_TEXT = 4000;
/** 用户消息正文上限：用户要的是「原文」，所以给得比 assistant 宽，但仍要防一次粘贴几万字 */
export const MAX_USER_TEXT = 2000;
/** 一次工具调用的参数摘要上限（目录与折叠抬头只用 60 字，见 `TOOL_PREVIEW`） */
export const MAX_ARGS = 400;
/** 折叠抬头里那句「调了什么」的上限：一行看得完，不抢工具名的位置 */
export const TOOL_SUMMARY = 60;
/** 一次工具调用的结果上限 */
export const MAX_RESULT = 200;
/** 整页会话正文的输出上限（字符数，UTF-8 下中文 3 字节，这里按保守值算） */
export const MAX_OUTPUT = 2 * 1024 * 1024;

export interface SessionToolCall {
  name: string;
  /** 参数原文（JSON 压成一行后截断）：展开后给「完整参数」看 */
  args: string;
  /** 抬头摘要：按工具挑一个可读参数（见 `toolArgSummary`），取不到就是空串 */
  summary: string;
  /** 结果前 200 字（没有结果就是「（没有结果）」） */
  result: string;
}

export type SessionEntry =
  | { kind: "user"; text: string; at: number | null }
  | { kind: "assistant"; text: string; at: number | null }
  | { kind: "tools"; calls: SessionToolCall[]; at: number | null };

/**
 * 解析中途的调用记录：结果（toolResult）总是排在携带 toolCall 的 assistant 消息**之后**，
 * 所以先带 id 收进来，全文扫完再回填结果 —— 边扫边取会永远取不到（那时结果还没出现）。
 */
interface RawCall {
  id: string;
  name: string;
  args: string;
  summary: string;
}

export interface SessionTranscript {
  entries: SessionEntry[];
  /** 解析到的 message 总条数（不限 200） */
  messages: number;
  /** 工具调用总次数 */
  toolCalls: number;
  /** 因为只留最后 200 条而丢掉的消息条数 */
  dropped: number;
  /** 第一条 / 最后一条消息的时间：概览卡片的「10:32 → 11:52」用它 */
  firstAt: number | null;
  lastAt: number | null;
}

/** 截断并加省略号：中文一行话也可能超长，所以在字符数上截，不在行上截 */
function clip(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

/** 顶层时间戳：ISO 字符串或已是数字；解析不了就当没有（不拿当前时间冒充） */
function stamp(record: Record<string, unknown>): number | null {
  const raw = record.timestamp;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw !== "string") return null;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
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

/** bash 的 command：只要第一行（多行脚本会把抬头撑成一屏），`\n` 还原成空格，首尾引号去掉 */
function commandHead(command: string | null): string | null {
  if (command === null) return null;
  const firstLine = command.split("\n")[0] ?? "";
  return firstLine.replace(/\\n/g, " ").replace(/^[\s"'`]+|[\s"'`]+$/g, "");
}

/** 路径的文件名：`read /home/x/a.ts` 的抬头只值 `a.ts`，整条路径会把抬头挤满 */
function basenameOf(path: string): string {
  const parts = path.split("/").filter((part) => part.length > 0);
  return parts.length > 0 ? (parts[parts.length - 1] as string) : path;
}

/** 参数对象里第一个非空字符串值：没有统一约定的工具就取它，总比一串 JSON 强 */
function firstString(record: Record<string, unknown> | null): string | null {
  if (record === null) return null;
  for (const value of Object.values(record)) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

/**
 * 折叠抬头的参数摘要：**按工具取那一个可读参数**，绝不把整段 JSON 泄出来。
 * `bash` → command 第一行；`read`/`edit`/`write` → path 的文件名；`rg`/`grep` → pattern；
 * `compress` → 没有单一可读参数（整段对话都在入参里），留空只显示 `×N`；
 * 其它工具取第一个字符串参数。取不到一律返回空串（抬头就只剩 `×N`）。
 * 参数本身是裸字符串时（少数工具直接传字符串）就把它当那一个参数。
 */
export function toolArgSummary(name: string, args: unknown): string {
  if (name === "compress") return "";
  const record = typeof args === "object" && args !== null && !Array.isArray(args)
    ? (args as Record<string, unknown>)
    : null;
  const single = typeof args === "string" ? args : null;
  const field = (key: string): string | null => {
    const value = record === null ? null : record[key];
    return typeof value === "string" ? value : null;
  };
  let picked: string | null;
  if (name === "bash") picked = commandHead(field("command") ?? single);
  else if (name === "read" || name === "edit" || name === "write") {
    const path = field("path") ?? single;
    picked = path === null ? null : basenameOf(path);
  } else if (name === "rg" || name === "grep") picked = field("pattern") ?? single;
  else picked = firstString(record) ?? single;
  return picked === null ? "" : clip(picked, TOOL_SUMMARY);
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
      const name = typeof record.name === "string" && record.name.length > 0 ? record.name : "（未命名工具）";
      calls.push({
        id: typeof record.id === "string" ? record.id : "",
        name,
        args: argumentsText(record.arguments),
        summary: toolArgSummary(name, record.arguments),
      });
    }
  }
  return { text: texts.join("\n"), calls };
}

/** 解析整份 JSONL：坏行跳过（可能是进程被 kill 时写了一半的最后一行） */
export function parseSessionText(raw: string): SessionTranscript {
  type Pending = { entry: SessionEntry | { kind: "tools"; calls: RawCall[]; at: number | null }; roles: string[] };
  const kept: Pending[] = [];
  const results = new Map<string, string>();
  const stamps: number[] = [];
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
    const at = stamp(record);
    messages += 1;
    if (at !== null) stamps.push(at);
    if (role === "toolResult") {
      // 结果先存起来：它总是排在携带 toolCall 的那条 assistant 消息之后
      const id = typeof fields.toolCallId === "string" ? fields.toolCallId : "";
      if (id.length > 0) results.set(id, resultText(fields.content));
      continue;
    }
    if (role === "user") {
      kept.push({ entry: { kind: "user", text: contentText(fields.content), at }, roles: [role] });
      continue;
    }
    if (role !== "assistant") continue; // system 是系统提示词，不是对话
    const parts = readAssistantParts(fields.content);
    if (parts.text.trim().length > 0) {
      const last = kept[kept.length - 1];
      // 一条 assistant 消息里「文本 + toolCall」并存：文本先出，工具另起一段，顺序与真实发生一致
      if (last && last.roles[last.roles.length - 1] === "assistant-text") {
        last.entry = { kind: "assistant", text: `${(last.entry as { text: string }).text}\n${parts.text}`, at };
      } else {
        kept.push({ entry: { kind: "assistant", text: parts.text, at }, roles: ["assistant-text"] });
      }
    }
    if (parts.calls.length > 0) {
      const last = kept[kept.length - 1];
      // 连续工具调用（中间没有文本）聚成一个折叠块：一次 read 一个块会堆出上百个折叠框
      if (last && last.entry.kind === "tools" && last.roles[last.roles.length - 1] !== "assistant-text") {
        (last.entry.calls as RawCall[]).push(...parts.calls);
      } else {
        kept.push({ entry: { kind: "tools", calls: [...parts.calls], at }, roles: ["tools"] });
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
          at: item.entry.at,
          calls: (item.entry.calls as RawCall[]).map((call) => ({
            name: call.name,
            args: call.args,
            summary: call.summary,
            result: results.get(call.id) ?? "（没有结果）",
          })),
        }
      : item.entry,
  );
  return {
    entries,
    messages,
    toolCalls,
    dropped,
    firstAt: stamps.length === 0 ? null : Math.min(...stamps),
    lastAt: stamps.length === 0 ? null : Math.max(...stamps),
  };
}
