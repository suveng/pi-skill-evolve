/**
 * 操作审计：`.pi/evolution/actions.log`（JSONL，一行一个动作）。
 *
 * 三条纪律：
 * 1. **只追加**：审计是事后追溯用的，绝不改写既有行（读写同一份文件时，改写必然丢别人的尾行）；
 * 2. **写失败不反噬动作**：动作已经生效（或已经失败）了，日志写不进去只能留 console，
 *    不能把结果改写成报错 —— 与 lib/telemetry.ts「运行态写失败只记日志」同一口径；
 * 3. **只读尾部**：文件会一直长，读的时候只取尾部 64KB；从半行开始的那半截解析必然失败，靠坏行跳过自然吃掉。
 */
import * as fs from "node:fs";
import * as path from "node:path";

export const AUDIT_FILE = "actions.log";
/** 读尾部窗口：够装上千条动作，又不至于让一页面板去读一个几百 MB 的日志 */
const READ_WINDOW_BYTES = 64 * 1024;

export const AUDIT_ACTIONS = ["toggle", "run", "rerun", "cleanup", "approve", "reject"] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/**
 * `ok` = 全部生效；`partial` = 命令跑完但没派发（总开关关 / 已有复盘在跑 / 去抖窗口里）；
 * `error: …` = 没做成，后面跟一句原因（校验失败、回调抛错都走这条）。
 */
export type AuditResult = "ok" | "partial" | `error: ${string}`;

export interface AuditEntry {
  /** 毫秒时间戳：与 runs/config 用同一种时间，渲染层才能算出「几分钟前」 */
  at: number;
  action: AuditAction;
  /** 只有 rerun / cleanup 这类针对具体 run 的动作才有 */
  runId?: string;
  /**
   * 只有开关动作（`/toggle?field=`）才有：`telemetry`（采集）/ `enabled`（复盘），
   * 越界被拒时写的是原样的查询值 —— 事后才能分清「他点的是哪个开关」。
   */
  field?: string;
  result: AuditResult;
  /**
   * 来源标记固定 `web`：将来 TUI 也记审计时，靠它区分「谁点的」，
   * 现在写死也留字段，是因为日志是 append-only，事后补不回来。
   */
  via: "web";
}

export function auditFile(evolutionDir: string): string {
  return path.join(evolutionDir, AUDIT_FILE);
}

export function appendAudit(evolutionDir: string, entry: AuditEntry): void {
  try {
    fs.mkdirSync(evolutionDir, { recursive: true });
    fs.appendFileSync(auditFile(evolutionDir), `${JSON.stringify(entry)}\n`, "utf8");
  } catch (error) {
    console.error(`[skill-evolve] 审计写入失败（${auditFile(evolutionDir)}）：${String(error)}`);
  }
}

/** 读文件尾部窗口的文本；不存在或读失败返回空串（文件不存在 = 还没发生过动作，不是错误） */
function tailText(file: string): string {
  let fd: number | null = null;
  try {
    const size = fs.statSync(file).size;
    const start = Math.max(0, size - READ_WINDOW_BYTES);
    fd = fs.openSync(file, "r");
    const buffer = Buffer.alloc(size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    return buffer.toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // 关不掉不影响已读到的内容，下一次读还会重新 open
      }
    }
  }
}

/**
 * 尾部 `limit` 条，按文件顺序返回（老的在前）。
 * 坏行一律跳过：半行、手改、并发截断都当不存在 —— 审计不该因为一行写坏了整页打不开。
 */
export function readAudit(evolutionDir: string, limit = 20): AuditEntry[] {
  const entries: AuditEntry[] = [];
  for (const line of tailText(auditFile(evolutionDir)).split("\n")) {
    if (line.trim().length === 0) continue;
    let parsed: Partial<AuditEntry>;
    try {
      parsed = JSON.parse(line) as Partial<AuditEntry>;
    } catch {
      continue;
    }
    if (typeof parsed.at !== "number" || !Number.isFinite(parsed.at)) continue;
    if (typeof parsed.action !== "string" || !isAction(parsed.action)) continue;
    if (typeof parsed.result !== "string" || parsed.result.length === 0) continue;
    if (parsed.via !== "web") continue;
    const entry: AuditEntry = {
      at: parsed.at,
      action: parsed.action,
      result: parsed.result as AuditResult,
      via: "web",
    };
    if (typeof parsed.runId === "string" && parsed.runId.length > 0) entry.runId = parsed.runId;
    if (typeof parsed.field === "string" && parsed.field.length > 0) entry.field = parsed.field;
    entries.push(entry);
  }
  return limit > 0 ? entries.slice(-limit) : [];
}

/** 未知动作不往页面上渲染：日志里出现新动作（老版本 / 手改）时面板不能崩 */
function isAction(value: string): value is AuditAction {
  return (AUDIT_ACTIONS as readonly string[]).includes(value);
}
