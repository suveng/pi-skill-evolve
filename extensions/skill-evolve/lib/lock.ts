/**
 * 跨进程目录锁：`mkdir .pi/evolution/locks/dispatch` 原子创建即拿到锁。
 *
 * 为什么不用内存锁：复盘子进程是独立的 pi 进程，同一时刻只允许一个 run。
 * 为什么不用文件锁库：零第三方依赖，`mkdir` 在 POSIX 与 Windows 上都是原子的。
 * 防死锁：kill -9 之后目录会留下，靠「owner 的 pid 已不存在」立即回收；只有 owner.json
 * 本身读不出来时才退化成「超过 2×maxRuntimeMs」兜底。
 */
import * as fs from "node:fs";
import * as path from "node:path";

export interface LockOwner {
  pid: number;
  /** 抢锁毫秒戳 */
  ts: number;
  sessionId?: string;
}

/** pid 是否存活：EPERM 说明进程存在但当前用户无权发信号，同样算活着 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

/** 锁名 → 目录名。`dispatch` 是复盘派发的老锁；`supervisor` / `apply` 是 0.1.13 加的跨实例锁 */
export type LockName = "dispatch" | "supervisor" | "apply";

export function lockDir(evolutionDir: string, name: LockName = "dispatch"): string {
  return path.join(evolutionDir, "locks", name);
}

/**
 * 是否回收这把锁（纯函数，可单测）。判据分两类：
 * 1. owner.json 能读出合法 pid → **只看进程是否存活**：pid 已死立即回收，与等了多久无关。
 *    理由：kill(pid, 0) 说「进程不存在」就说明没人持有这把锁；pid 复用导致的误判方向是「假活」
 *    （继续阻塞，安全），不是「假死」（抢锁，危险）。
 * 2. owner.json 缺失 / JSON 坏 / pid 或 ts 非法 → 无法证明有活着的持有者，才用
 *    now - ts >= 2×maxRuntimeMs 兜底（ts 也读不出来时按残锁直接回收）。
 */
export function shouldReclaim(
  owner: LockOwner | null,
  now: number,
  maxRuntimeMs: number,
  alive: (pid: number) => boolean = isPidAlive,
): boolean {
  const pid = owner?.pid;
  const ts = owner?.ts;
  if (owner && Number.isInteger(pid) && pid > 0 && Number.isFinite(ts)) {
    return !alive(pid);
  }
  if (!owner || !Number.isFinite(ts)) return true;
  return now - (ts as number) >= 2 * maxRuntimeMs;
}

export function readOwnerSync(dir: string): LockOwner | null {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(path.join(dir, "owner.json"), "utf8"));
    if (!raw || typeof raw !== "object") return null;
    const owner = raw as LockOwner;
    return { pid: Number(owner.pid), ts: Number(owner.ts), sessionId: owner.sessionId };
  } catch {
    return null;
  }
}

export async function readOwner(dir: string): Promise<LockOwner | null> {
  return readOwnerSync(dir);
}

export interface AcquireOptions {
  evolutionDir: string;
  /** 哪把锁，缺省 `dispatch`（老行为不变） */
  name?: LockName;
  owner: LockOwner;
  maxRuntimeMs: number;
  log?: (msg: string) => void;
  now?: () => number;
}

export interface AcquireResult {
  ok: boolean;
  why?: "busy" | "error";
  /** 抢失败时把当前的持有者带出来，日志与 status 用得上 */
  owner?: LockOwner | null;
}

export async function acquireLock(options: AcquireOptions): Promise<AcquireResult> {
  const log = options.log ?? (() => {});
  const dir = lockDir(options.evolutionDir, options.name);
  const now = options.now?.() ?? Date.now();

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await fs.promises.mkdir(path.dirname(dir), { recursive: true });
      await fs.promises.mkdir(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") {
        log(`[skill-evolve] 抢锁失败（mkdir）：${String(error)}`);
        return { ok: false, why: "error" };
      }
      // 目录已存在：要么别人正拿着，要么是残锁
      const owner = await readOwner(dir);
      if (!shouldReclaim(owner, now, options.maxRuntimeMs)) return { ok: false, why: "busy", owner };
      log(
        `[skill-evolve] 回收孤儿锁：owner=${owner ? `pid ${owner.pid} @ ${new Date(owner.ts).toISOString()}` : "无 owner.json"}`,
      );
      try {
        await fs.promises.rm(dir, { recursive: true, force: true });
      } catch (rmError) {
        log(`[skill-evolve] 回收残锁失败：${String(rmError)}`);
        return { ok: false, why: "error" };
      }
      continue;
    }
    try {
      await fs.promises.writeFile(path.join(dir, "owner.json"), `${JSON.stringify(options.owner)}\n`, "utf8");
      log(`[skill-evolve] 起锁：pid ${options.owner.pid}（${dir}）`);
      return { ok: true };
    } catch (error) {
      // 目录建好了但 owner 写不进去：立刻还回去，避免留下无人认领的锁
      log(`[skill-evolve] 写 owner.json 失败：${String(error)}`);
      await releaseLock(options.evolutionDir, options.log, options.name);
      return { ok: false, why: "error" };
    }
  }
  return { ok: false, why: "busy" };
}

/** 释放锁（幂等）：目录不在也算成功 */
export async function releaseLock(
  evolutionDir: string,
  log: (msg: string) => void = () => {},
  name: LockName = "dispatch",
): Promise<void> {
  const dir = lockDir(evolutionDir, name);
  try {
    await fs.promises.rm(dir, { recursive: true, force: true });
  } catch (error) {
    log(`[skill-evolve] 释放锁失败：${String(error)}`);
  }
}

function writeOwnerFile(dir: string, owner: LockOwner): void {
  fs.writeFileSync(path.join(dir, "owner.json"), `${JSON.stringify(owner)}\n`, "utf8");
}

/**
 * 同步抢锁：只给 `session_shutdown` 用 —— 主进程马上要退出，不能 await。
 * 语义与 acquireLock 完全一致（mkdir 原子抢占 + 两轮「回收孤儿再抢」）。
 */
export function acquireLockSync(options: AcquireOptions): AcquireResult {
  const log = options.log ?? (() => {});
  const dir = lockDir(options.evolutionDir, options.name);
  const now = options.now?.() ?? Date.now();

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.mkdirSync(path.dirname(dir), { recursive: true });
      fs.mkdirSync(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") {
        log(`[skill-evolve] 抢锁失败（mkdir）：${String(error)}`);
        return { ok: false, why: "error" };
      }
      const owner = readOwnerSync(dir);
      if (!shouldReclaim(owner, now, options.maxRuntimeMs)) return { ok: false, why: "busy", owner };
      log(
        `[skill-evolve] 回收孤儿锁：owner=${owner ? `pid ${owner.pid} @ ${new Date(owner.ts).toISOString()}` : "无 owner.json"}`,
      );
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch (rmError) {
        log(`[skill-evolve] 回收残锁失败：${String(rmError)}`);
        return { ok: false, why: "error" };
      }
      continue;
    }
    try {
      writeOwnerFile(dir, options.owner);
      log(`[skill-evolve] 起锁：pid ${options.owner.pid}（${dir}）`);
      return { ok: true };
    } catch (error) {
      log(`[skill-evolve] 写 owner.json 失败：${String(error)}`);
      releaseLockSync(options.evolutionDir, options.log, options.name);
      return { ok: false, why: "error" };
    }
  }
  return { ok: false, why: "busy" };
}

/** 换掉锁的持有者：退出补发后要把 owner 指向复盘子进程，避免下次把活着的 run 当孤儿回收 */
export function writeOwnerSync(
  evolutionDir: string,
  owner: LockOwner,
  log: (msg: string) => void = () => {},
  name: LockName = "dispatch",
): boolean {
  try {
    writeOwnerFile(lockDir(evolutionDir, name), owner);
    return true;
  } catch (error) {
    log(`[skill-evolve] 改写 owner.json 失败：${String(error)}`);
    return false;
  }
}

/** 同步放锁：只给同步补发路径用（失败也只记日志） */
export function releaseLockSync(
  evolutionDir: string,
  log: (msg: string) => void = () => {},
  name: LockName = "dispatch",
): void {
  try {
    fs.rmSync(lockDir(evolutionDir, name), { recursive: true, force: true });
  } catch (error) {
    log(`[skill-evolve] 释放锁失败：${String(error)}`);
  }
}

export async function lockState(evolutionDir: string): Promise<{ held: boolean; owner: LockOwner | null }> {
  const dir = lockDir(evolutionDir);
  const held = fs.existsSync(dir);
  return { held, owner: held ? await readOwner(dir) : null };
}

export interface WithLockResult<T> {
  ok: boolean;
  value?: T;
  why?: "busy" | "error";
  /** 抢失败时的持有者：调用方可以据此说「另一个 pi 实例正在做」 */
  owner?: LockOwner | null;
}

/**
 * 跨实例互斥执行：抢到锁就执行并保证在 finally 里释放；抢不到立刻返回（不排队、不重试）。
 *
 * 为什么不做「等一会儿再抢」：这些锁护的都是毫秒级动作（spawn 督导、扫一遍队列采纳），
 * 排队只会把两个 pi 会话互相拖慢；抢不到的那一方跳过即可，下一次 session_start 还会再来。
 */
export async function withLock<T>(
  options: AcquireOptions & { name: LockName },
  run: () => Promise<T> | T,
): Promise<WithLockResult<T>> {
  const got = await acquireLock(options);
  if (!got.ok) return { ok: false, why: got.why ?? "busy", owner: got.owner ?? null };
  try {
    return { ok: true, value: await run() };
  } finally {
    await releaseLock(options.evolutionDir, options.log, options.name);
  }
}
