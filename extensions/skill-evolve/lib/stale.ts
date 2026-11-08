/**
 * 卡死判定（设计稿 14 章的可观测补丁）：复盘子进程死掉之后，run.json 会永远停在 dispatched，
 * 面板永远显示「复盘 1」，run 目录里也没有一行日志 —— 这种「静默失败」靠人肉 ps 才查得出来。
 *
 * 三条纪律：
 * 1. 只判「派发出去还没出结论」的三种状态（dispatched / analyzed / proposed）：
 *    reviewed / applied 已经不缺结论，超不超时都无所谓；
 * 2. **绝不自动重跑**：一次复盘要烧一整段会话的 token，重跑必须人来点（`/skill-evolve run`）；
 * 3. 判定必须留下能查的证据：run.json 改成 stale，同目录落 run-error.json（含子进程日志尾部）。
 *
 * 读/写在同一个文件里：这条链路只有「读 run.json → 判 → 写 run.json + run-error.json」三步，
 * 拆开反而要让三个模块共享路径口径。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { DEFAULT_CONFIG } from "./config.ts";
import { isPidAlive } from "./lock.ts";
import { CHILD_LOG } from "./spawn-plan.ts";
import { writeRunRecordSync, type RunRecord } from "./runs.ts";

/** 在途状态：只有这些状态的 run「没结论」才叫卡死 */
/**
 * 只有 `dispatched` 算「可能卡住」：run 一旦进到 analyzed/proposed，说明子进程已经把结论写回磁盘，
 * 它的进程晚一点退出是正常的（本来就是一次性 CLI）。把 analyzed 也算成卡死，等于把「已经成功的复盘」
 * 报成「复盘失败」—— 面板宁可少报一类，也不能误报。
 */
export const STALE_STATUSES = new Set(["dispatched"]);

/** 判「子进程已死」前要等多久：5 分钟足够躲开 pi 启动慢与机器抖动，又不至于让人等半天 */
export const STALE_MS = 5 * 60_000;

/** run-error.json 保留的日志行数：够看出最后一句报错，又不会把文件撑大 */
export const LOG_TAIL_LINES = 20;

/** child-exited = 子进程没了；timeout = 还活着但超过单 run 上限 */
export type StaleReason = "child-exited" | "timeout";

export interface StaleVerdict {
  stale: boolean;
  reason?: StaleReason;
}

export interface StaleDeps {
  /** 判「子进程已死」的等待时长（默认 STALE_MS） */
  staleMs?: number;
  /** 判「还在跑但太久」的上限（默认配置的 maxRuntimeMs） */
  maxRuntimeMs?: number;
  /** pid 存活判定：生产用 lock.ts 的 isPidAlive（kill(pid,0) 抛 ESRCH 即死），单测注入 */
  alive?: (pid: number) => boolean;
}

/** 判定只需要三个字段：状态、子进程 pid、派发时刻 */
export interface StaleTarget {
  status: string;
  pid?: number | null;
  dispatchedAt?: number | null;
}

export interface RunError {
  reason: StaleReason;
  at: number;
  /** child.log 的最后 LOG_TAIL_LINES 行；没有日志就是空数组 —— 「一条日志都没有」本身是证据 */
  childLogTail: string[];
}

export interface StaleRun {
  runId: string;
  runDir: string;
  reason: StaleReason;
  /** 日志最后一行（展示用）；没有日志为 null */
  lastLine: string | null;
  at: number;
}

/**
 * 纯判定，不做任何副作用 —— 面板要拿它算数，不能因为「看一眼面板」就去 kill 进程。
 * 返回 timeout 时由 scanStaleRuns 负责真的收尾（kill + 落盘）。
 */
export function classifyStale(run: StaleTarget, now: number, deps: StaleDeps = {}): StaleVerdict {
  if (!STALE_STATUSES.has(run.status)) return { stale: false };
  // 没有派发时刻就证明不了「卡了多久」：宁可漏报一条，也不误伤刚起来的 run
  const started = typeof run.dispatchedAt === "number" && Number.isFinite(run.dispatchedAt) ? run.dispatchedAt : null;
  if (started === null) return { stale: false };
  const elapsed = now - started;
  const pid = typeof run.pid === "number" && run.pid > 0 ? run.pid : null;
  const alive = deps.alive ?? isPidAlive;
  // pid 缺失也算已死：dispatch 是先写 pid=null 再补写 pid，中间被打断就是这个形态
  if (pid === null || !alive(pid)) {
    return elapsed > (deps.staleMs ?? STALE_MS) ? { stale: true, reason: "child-exited" } : { stale: false };
  }
  return elapsed > (deps.maxRuntimeMs ?? DEFAULT_CONFIG.maxRuntimeMs) ? { stale: true, reason: "timeout" } : { stale: false };
}

/** 日志尾部：文件不在 / 读不出来都返回空数组（缺日志是常态，不能因此抛） */
export function readLogTail(file: string, maxLines = LOG_TAIL_LINES): string[] {
  try {
    const lines = fs.readFileSync(file, "utf8").split("\n");
    while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    return lines.slice(-maxLines);
  } catch {
    return [];
  }
}

export interface ScanDeps extends StaleDeps {
  /** 超时收尾用：默认 process.kill，单测注入，绝不真杀 */
  kill?: (pid: number) => void;
  log?: (msg: string) => void;
}

/** run-error.json 的内容口径：一条 reason + 判定时刻 + 日志尾部 */
export function readRunError(runDir: string): RunError | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(runDir, "run-error.json"), "utf8")) as Partial<RunError>;
    const reason = raw.reason === "timeout" || raw.reason === "child-exited" ? raw.reason : null;
    if (!reason) return null;
    return {
      reason,
      at: typeof raw.at === "number" ? raw.at : 0,
      childLogTail: Array.isArray(raw.childLogTail) ? raw.childLogTail.map((line) => String(line)) : [],
    };
  } catch {
    return null;
  }
}

const lastLineOf = (tail: readonly string[]): string | null => {
  const line = tail.length > 0 ? tail[tail.length - 1]!.trim() : "";
  return line.length > 0 ? line : null;
};

/**
 * 扫一遍 runs/：把卡死的 run 标成 stale 并落 run-error.json，返回本次新判定的条目。
 * 已标过 stale 的 run 状态不再属于在途，所以重复扫描不会重复写（幂等）。
 */
export function scanStaleRuns(evolutionDir: string, now: number, deps: ScanDeps = {}): StaleRun[] {
  let names: string[];
  try {
    names = fs.readdirSync(path.join(evolutionDir, "runs"));
  } catch {
    return [];
  }
  const found: StaleRun[] = [];
  for (const name of names) {
    const runDir = path.join(evolutionDir, "runs", name);
    const file = path.join(runDir, "run.json");
    let raw: Record<string, unknown> & StaleTarget;
    try {
      raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown> & StaleTarget;
    } catch {
      continue; // run.json 不在或坏掉：没有可判的记录
    }
    const verdict = classifyStale(raw, now, deps);
    if (!verdict.stale || !verdict.reason) continue;
    const reason = verdict.reason;
    // 超时的那类进程还活着：先杀掉，否则下一次扫描会再判一次、再 kill 一次
    if (reason === "timeout" && typeof raw.pid === "number" && raw.pid > 0) {
      try {
        (deps.kill ?? ((pid: number) => process.kill(pid)))(raw.pid);
      } catch (error) {
        deps.log?.(`[skill-evolve] 超时收尾 kill(${raw.pid}) 失败：${String(error)}`);
      }
    }
    const childLogTail = readLogTail(path.join(runDir, CHILD_LOG));
    const error: RunError = { reason, at: now, childLogTail };
    try {
      raw.status = "stale";
      writeRunRecordSync(runDir, raw as unknown as RunRecord);
      fs.writeFileSync(path.join(runDir, "run-error.json"), `${JSON.stringify(error, null, 2)}\n`, "utf8");
    } catch (caused) {
      // 写不进去只记日志：扫描本身不能把面板刷新的调用方搞挂
      deps.log?.(`[skill-evolve] 标记 stale 失败（${name}）：${String(caused)}`);
      continue;
    }
    found.push({
      runId: typeof raw.runId === "string" ? raw.runId : name,
      runDir,
      reason,
      lastLine: lastLineOf(childLogTail),
      at: now,
    });
    deps.log?.(`[skill-evolve] run ${name} 判定卡死（${reason}）`);
  }
  return found;
}

/** 已经标过 stale 的 run（只读，不重新判定、不写文件）：`/skill-evolve status` 用它列失败条目 */
export function listStaleRuns(evolutionDir: string, limit = 5): StaleRun[] {
  let names: string[];
  try {
    names = fs.readdirSync(path.join(evolutionDir, "runs"));
  } catch {
    return [];
  }
  const found: { run: StaleRun; dispatchedAt: number }[] = [];
  for (const name of names) {
    const runDir = path.join(evolutionDir, "runs", name);
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(runDir, "run.json"), "utf8")) as Record<string, unknown>;
      if (raw.status !== "stale") continue;
      const error = readRunError(runDir);
      found.push({
        run: {
          runId: typeof raw.runId === "string" ? raw.runId : name,
          runDir,
          reason: error?.reason ?? "child-exited",
          lastLine: lastLineOf(error?.childLogTail ?? []),
          at: error?.at ?? 0,
        },
        dispatchedAt: typeof raw.dispatchedAt === "number" ? raw.dispatchedAt : 0,
      });
    } catch {
      continue;
    }
  }
  return found.sort((a, b) => b.dispatchedAt - a.dispatchedAt).slice(0, limit).map((item) => item.run);
}
