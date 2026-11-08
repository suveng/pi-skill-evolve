/**
 * 会话索引：把 `getSessionFile()` 的 JSONL 变成「行号 → 类型/角色/时间/摘要」。
 *
 * 铁律（设计稿 5.4）：**只产索引，绝不把会话原文复制进 run 目录**。
 * 平均会话近 1MB，正文进 prompt 会立刻撑爆上下文；复盘子进程拿索引抽查，按行号回读原文。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { MutationQueue } from "./telemetry.ts";

export interface SessionIndexLine {
  /** 1 起算的物理行号，复盘证据就写这个 */
  line: number;
  type: string;
  role?: string;
  ts?: string;
  /** 该行原始字符数，用来判断这行值不值得读 */
  chars: number;
  /** 摘要，最多 80 字 */
  excerpt: string;
}

export interface SessionIndex {
  lines: SessionIndexLine[];
  stats: { lines: number; bytes: number; hasCompaction: boolean };
}

const EXCERPT_MAX = 80;

function flatten(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** 截到 80 字以内（超出时用省略号占最后一位） */
export function excerptOf(text: string): string {
  const flat = flatten(text);
  return flat.length > EXCERPT_MAX ? `${flat.slice(0, EXCERPT_MAX - 1)}…` : flat;
}

function textOfContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const piece = part as Record<string, unknown>;
    if (piece.type === "text" && typeof piece.text === "string") parts.push(piece.text);
    else if (piece.type === "toolCall") parts.push(`[调用 ${String(piece.name ?? "工具")}]`);
  }
  return parts.join(" ");
}

/** 一条 entry 里值得进摘要的文字 */
function excerptOfEntry(entry: Record<string, unknown>, type: string): string {
  if (type === "session") return String(entry.cwd ?? "");
  if (type === "compaction" || type === "branch_summary") return String(entry.summary ?? "");
  if (type === "custom" || type === "custom_message") return String(entry.customType ?? "");
  const message = entry.message;
  if (!message || typeof message !== "object") return "";
  const fields = message as Record<string, unknown>;
  const text = textOfContent(fields.content);
  const tool = typeof fields.toolName === "string" ? fields.toolName : "";
  return tool ? `[${tool}] ${text}` : text;
}

export function buildSessionIndex(text: string): SessionIndex {
  const rawLines = text.split("\n");
  const lines: SessionIndexLine[] = [];
  let total = 0;
  let hasCompaction = false;

  for (let i = 0; i < rawLines.length; i += 1) {
    const raw = rawLines[i];
    if (raw.trim().length === 0) continue;
    total += 1;
    let entry: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") continue;
      entry = parsed as Record<string, unknown>;
    } catch {
      // 坏行只计数不进索引：截断的会话尾巴很常见，不能因此整份索引失败
      continue;
    }
    const type = typeof entry.type === "string" ? entry.type : "unknown";
    if (type === "compaction") hasCompaction = true;
    const message = entry.message && typeof entry.message === "object" ? (entry.message as Record<string, unknown>) : null;
    const role = message && typeof message.role === "string" ? message.role : undefined;
    const ts = typeof entry.timestamp === "string" ? entry.timestamp : undefined;
    const line: SessionIndexLine = {
      line: i + 1,
      type,
      chars: raw.length,
      // 摘要一律过一遍 excerptOf：这是「≤80 字」的唯一出口，绝不让某类 entry 绕过它
      excerpt: excerptOf(excerptOfEntry(entry, type)),
    };
    if (role) line.role = role;
    if (ts) line.ts = ts;
    lines.push(line);
  }

  return { lines, stats: { lines: total, bytes: Buffer.byteLength(text, "utf8"), hasCompaction } };
}

/** 同步版索引生成：只给退出前补发用（主进程马上退出，不能 await） */
export function writeSessionIndexSync(options: {
  sessionFile: string;
  outDir: string;
  log?: (msg: string) => void;
}): SessionIndex | null {
  const log = options.log ?? (() => {});
  try {
    const text = fs.readFileSync(options.sessionFile, "utf8");
    const index = buildSessionIndex(text);
    fs.mkdirSync(options.outDir, { recursive: true });
    fs.writeFileSync(path.join(options.outDir, "index.json"), `${JSON.stringify(index, null, 2)}\n`, "utf8");
    return index;
  } catch (error) {
    log(`[skill-evolve] 会话索引生成失败（${options.sessionFile}）：${String(error)}`);
    return null;
  }
}

/** 写 `runs/<runId>/00-session/index.json`；会话不可读时返回 null，由调用方降级为 telemetry-only */
export async function writeSessionIndex(options: {
  sessionFile: string;
  outDir: string;
  queue: MutationQueue;
  log?: (msg: string) => void;
}): Promise<SessionIndex | null> {
  const log = options.log ?? (() => {});
  try {
    const text = await fs.promises.readFile(options.sessionFile, "utf8");
    const index = buildSessionIndex(text);
    const outFile = path.join(options.outDir, "index.json");
    await options.queue(outFile, async () => {
      await fs.promises.mkdir(options.outDir, { recursive: true });
      await fs.promises.writeFile(outFile, `${JSON.stringify(index, null, 2)}\n`, "utf8");
    });
    return index;
  } catch (error) {
    log(`[skill-evolve] 会话索引生成失败（${options.sessionFile}）：${String(error)}`);
    return null;
  }
}
