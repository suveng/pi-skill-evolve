/**
 * 扩展自己的日志文件：`.pi/evolution/logs/extension.log`。
 *
 * 为什么不打终端（用户 2026-11-08：「tui 的这些推送不看了，影响我」）：每一次 settle 都可能派生
 * 复盘 + 督导，台面上每轮刷两行进程号，等于把对话区当日志区。所以**默认一律落盘**，
 * 只有 `PI_SKILL_EVOLVE_DEBUG=1` 才同步回显一份到 stdout（排查时才开）。
 *
 * 轮转：单文件超过 1MB 就改名成 `.1`（只留一份历史，够查一次事故，又不至于占满磁盘）。
 * 写日志失败绝不向上抛：这条链路是旁路，不能因为盘满把派发搞挂。
 */
import * as fs from "node:fs";
import * as path from "node:path";

/** 轮转阈值：1MB；超过就把当前文件换成 `.1` */
export const LOG_MAX_BYTES = 1024 * 1024;

/** 日志文件路径（父目录由 logLine 按需创建） */
export function logFile(evolutionDir: string): string {
  return path.join(evolutionDir, "logs", "extension.log");
}

function rotateIfTooBig(file: string): void {
  let size: number;
  try {
    size = fs.statSync(file).size;
  } catch {
    return; // 还没有日志文件：第一条 append 会自己建
  }
  if (size <= LOG_MAX_BYTES) return;
  try {
    // POSIX 下 rename 直接覆盖旧 `.1`：只留最近一轮历史，不做无限堆叠
    fs.renameSync(file, `${file}.1`);
  } catch {
    // 轮转失败就继续追加：宁可文件变大，也不能丢日志
  }
}

/**
 * 追加一行日志。`debug` 缺省时看环境变量 `PI_SKILL_EVOLVE_DEBUG === "1"`；
 * 显式传参只给单测用，免得测试之间互相污染环境变量。
 */
export function logLine(evolutionDir: string, msg: string, debug?: boolean): void {
  if (debug ?? process.env.PI_SKILL_EVOLVE_DEBUG === "1") console.log(msg);
  const file = logFile(evolutionDir);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    rotateIfTooBig(file);
    fs.appendFileSync(file, `${new Date().toISOString()} ${msg}\n`, "utf8");
  } catch {
    // 盘满 / 权限不足：日志是旁路，静默跳过比把主流程带崩更合适
  }
}
