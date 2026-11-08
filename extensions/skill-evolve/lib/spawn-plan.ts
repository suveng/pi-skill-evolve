/**
 * 派生的「开工参数」：pi 可执行文件、runId、会话 hash，以及子进程接口的最小形状。
 *
 * 单独成文件是为了让 dispatch.ts（常规派发）与 shutdown-dispatch.ts（退出前补发）
 * 共享同一套命名与路径口径，而不互相 import 形成环。
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

/** pi 不能靠 PATH 找：GUI / 非交互环境里 PATH 常常没有它 */
export const DEFAULT_PI_BIN = "/home/suveng/.pi/agent/bin/pi";

export interface SpawnedChild {
  pid?: number;
  unref(): void;
  once(event: "exit", listener: (code: number | null) => void): unknown;
  once(event: "error", listener: (error: unknown) => void): unknown;
}

export type SpawnLike = (command: string, args: string[], options: Record<string, unknown>) => SpawnedChild;

export function resolvePiBin(env: NodeJS.ProcessEnv = process.env): string {
  return env.SKILL_EVOLVE_PI_BIN || env.PI_SUBAGENT_PI_BINARY || DEFAULT_PI_BIN;
}

/** 复盘子进程的日志文件名（落在 run 目录下，与 run.json 同级） */
export const CHILD_LOG = "child.log";

export interface DetachedSpawnOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** stdout+stderr 追加到这个文件；null = 丢弃（只丢证据，不丢功能） */
  logFile: string | null;
}

/**
 * detached 派生子进程，并把它的 stdout+stderr 追加进 logFile。
 *
 * 为什么必须落盘：子进程静默死掉时，run.json 只会停在 dispatched、面板永远显示「复盘 1」，
 * 连一行报错都拿不到 —— 那种现场根本查不出「为什么死」（2026-11-08 真实事故）。
 *
 * 日志文件开不出来（磁盘满 / 权限 / 目录不在）时退回 stdio:"ignore"：光有证据不如先有功能。
 * 父进程 spawn 完立刻关掉自己那份 fd —— 子进程已拿到独立副本，父进程留着纯属泄漏。
 * 单测注入假 spawnFn，本函数只负责拼 stdio 与关 fd，绝不真起进程。
 */
export function spawnDetached<T extends { unref?: () => void }>(
  spawnFn: (command: string, args: string[], options: Record<string, unknown>) => T,
  command: string,
  args: string[],
  options: DetachedSpawnOptions,
): T {
  let fd: number | null = null;
  if (options.logFile !== null) {
    try {
      fs.mkdirSync(path.dirname(options.logFile), { recursive: true });
      fd = fs.openSync(options.logFile, "a");
    } catch {
      fd = null;
    }
  }
  try {
    const child = spawnFn(command, args, {
      cwd: options.cwd,
      detached: true,
      // stdin 不给（子进程不读输入），stdout 与 stderr 共用同一个 fd
      stdio: fd === null ? "ignore" : ["ignore", fd, fd],
      env: options.env,
    });
    child.unref?.();
    return child;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // 关 fd 失败无影响：父进程退出时内核也会收
      }
    }
  }
}

export function sessionHashOf(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("hex").slice(0, 16);
}

/** runId = 会话 hash 前 8 位 + 秒级时间戳，肉眼可排序、可回溯到会话 */
export function runIdFor(sessionId: string, ts: number): string {
  return `${sessionHashOf(sessionId).slice(0, 8)}-${Math.floor(ts / 1000)}`;
}

/**
 * 同一秒内可能派发两次（自动结算 + 手动 `/skill-evolve run`），或两个会话刚好撞秒。
 * run.json 是按 runId 建的目录，撞了就会互相覆盖，所以撞号时加序号后缀。
 */
export function uniqueRunId(evolutionDir: string, sessionId: string, ts: number): string {
  const base = runIdFor(sessionId, ts);
  let candidate = base;
  for (let suffix = 2; fs.existsSync(path.join(evolutionDir, "runs", candidate)); suffix += 1) {
    candidate = `${base}-${suffix}`;
  }
  return candidate;
}
