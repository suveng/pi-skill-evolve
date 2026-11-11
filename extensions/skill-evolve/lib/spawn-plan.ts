/**
 * 派生的「开工参数」：pi 可执行文件、runId、会话 hash，以及子进程接口的最小形状。
 *
 * 单独成文件是为了让 dispatch.ts（常规派发）与 shutdown-dispatch.ts（退出前补发）
 * 共享同一套命名与路径口径，而不互相 import 形成环。
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * 兜底 pi 路径：按**当前用户 home** 拼，绝不写死某个人的家目录。
 *
 * 2026-11-09 事故：v0.1.10 把 Linux 家目录 `/home/suveng/.pi/agent/bin/pi` 写成常量，
 * 换到 macOS 上 spawn 直接 ENOENT；而 spawn 的 error 事件是**异步** emit 的，
 * 那一刻还没人挂 listener，于是 uncaughtException 把整个 pi 进程打死。
 */
export const DEFAULT_PI_BIN = path.join(os.homedir(), ".pi", "agent", "bin", "pi");

/** 可执行文件判定：不存在 / 无执行权限 / 是目录都算「不可用」，一律不抛 */
export function isExecutableFile(candidate: string): boolean {
  try {
    if (!fs.statSync(candidate).isFile()) return false;
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** 在 PATH 里找 pi：GUI / 非交互启动的 pi 常常带着不完整的 PATH，所以只作第二选择 */
function findOnPath(name: string, env: NodeJS.ProcessEnv, exists: (candidate: string) => boolean): string | null {
  const dirs = (env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, name);
    if (exists(candidate)) return candidate;
  }
  return null;
}

export interface SpawnedChild {
  pid?: number;
  unref(): void;
  once(event: "exit", listener: (code: number | null) => void): unknown;
  once(event: "error", listener: (error: unknown) => void): unknown;
}

export type SpawnLike = (command: string, args: string[], options: Record<string, unknown>) => SpawnedChild;

export interface ResolvePiBinOptions {
  /** 单测注入的存在性判定（默认查真磁盘） */
  exists?: (candidate: string) => boolean;
  /** 可执行文件名（Windows 上是 pi.cmd / pi.exe，默认 "pi"） */
  name?: string;
}

/**
 * pi 路径解析顺序：显式环境变量 → home 下的 `.pi/agent/bin/pi` → PATH 里的 `pi` → 兜底常量。
 * 返回的路径**不保证存在**（调用方要用 isExecutableFile 先验一次，别直接 spawn）。
 */
export function resolvePiBin(env: NodeJS.ProcessEnv = process.env, options: ResolvePiBinOptions = {}): string {
  const explicit = env.SKILL_EVOLVE_PI_BIN || env.PI_SUBAGENT_PI_BINARY;
  if (explicit) return explicit;
  const exists = options.exists ?? isExecutableFile;
  if (exists(DEFAULT_PI_BIN)) return DEFAULT_PI_BIN;
  return findOnPath(options.name ?? "pi", env, exists) ?? DEFAULT_PI_BIN;
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

/**
 * 复盘子进程的环境变量：父进程的 `env` 原样带上，只摘掉「抢守护进程」的那几个开关。
 *
 * 为什么必须摘（2026-11-11 实测 run 260928fa-1794361982）：
 * 父 pi 由飞书桥接以 `PI_FEISHU_DAEMON=1` 拉起，这个变量被子进程继承；子 pi 加载桥接扩展后
 * 走去 `start()` → 读到别的 daemon 已持有网关锁 → `process.exit(0)` ——
 * 于是复盘子进程只输出一行 `[feishu] daemon found existing owner, exiting` 就没了，
 * 整个复盘被判「子进程已退出」。
 *
 * 复盘只需要「读材料 + 写提案」，不该去当任何守护进程；其余变量（路径、代理、模型凭据）一律保留。
 */
/** 子进程的会话落在 run 目录下的 agents/：面板能像看待普通会话一样渲染它 */
export const AGENTS_DIR = "agents";

/** `pi -p` 的会话参数：id 定成 `se-<role>`，面板按 `_se-<role>.jsonl` 就能找回文件 */
export function agentSessionFlags(runDir: string, role: string): string[] {
  return ["--session-dir", path.join(runDir, AGENTS_DIR), "--session-id", `se-${role}`];
}

const CHILD_ENV_DROPS: readonly string[] = ["PI_FEISHU_DAEMON"];

export function stripDaemonFlags(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...env };
  for (const key of CHILD_ENV_DROPS) delete next[key];
  return next;
}

export function childEnvOf(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...stripDaemonFlags(env), SKILL_EVOLVE_CHILD: "1" };
}
