/**
 * 同会话聚合检测：同一个会话已经有在途复盘时，本轮**并入**它，不再另开一条 run。
 *
 * 为什么需要（用户 2026-11-08：「如果是同一会话产生的多个, 并且他还没开始跑复盘, 会导致一会话多次跑复盘」）：
 * runId 是 `会话哈希8-时间戳`，每轮结算都算出一个新的；全局单飞闸只保证「同时只有一个子进程」，
 * 挡不住「队列里排着同一个会话的好几条」。真实现场（2026-11-08 的 vkk_client_flutter 工作区）：
 * 同一个 sessionId 下堆了 1 条 analyzed + 7 条 stale，同一段会话被反反复复复盘。
 *
 * 三条边界，缺一条就会误并：
 * ① 只并 in-flight（status=dispatched）的 run；analyzed / proposed / reviewed 表示复盘确实跑完了，
 *    那是新的一轮对话，允许另开；
 * ② 只并**子进程还活着**的 run：pid 已死说明它已经是尸体，交给 lib/stale.ts 标 stale，本轮照旧另开；
 * ③ 01-findings.json 已落盘的一律不并 —— 状态可能还没被回写，判据与 runs.ts 的 listRuns 同一口径。
 *
 * 为什么这里用同步 fs：两个调用点（异步派发 / 退出前同步补发）必须给出**同一个**判定，
 * 拆成异步 + 同步两套实现迟早分叉；扫描量是 runs/ 下 ≤100 个 run.json，同步读的代价远小于分叉的代价。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { isPidAlive } from "./lock.ts";
import { parseCoverage, patchRunRecordSync, type RunCoverage } from "./runs.ts";
import type { TelemetryWriter } from "./telemetry.ts";

/** 只有这个状态算「复盘还在跑」：analyzed 起都是跑完了 */
export const IN_FLIGHT_STATUS = "dispatched";
/** 扫描上限：与面板同一个量级，够了；runs/ 里可能有几百个历史目录 */
const MAX_SCAN = 100;

export interface AggregateRun {
  runId: string;
  runDir: string;
  sessionId: string;
  status: string;
  pid: number | null;
  dispatchedAt: number;
  /** 01-findings.json 已落盘 = 复盘其实已经跑完（run.json 的状态可能还没被回写） */
  hasFindings: boolean;
  /** run.json 里已有的覆盖轮数（并入时要在它上面累加） */
  coverage: RunCoverage | null;
}

/** 扫 runs/ 下最近 MAX_SCAN 条；run.json 缺失或坏掉一律跳过（坏记录不能伪造出一条在途 run） */
export function readAggregateRuns(evolutionDir: string): AggregateRun[] {
  const runsDir = path.join(evolutionDir, "runs");
  let names: string[];
  try {
    names = fs.readdirSync(runsDir);
  } catch {
    return [];
  }
  const runs: AggregateRun[] = [];
  for (const name of names) {
    const runDir = path.join(runsDir, name);
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(fs.readFileSync(path.join(runDir, "run.json"), "utf8")) as Record<string, unknown>;
    } catch {
      continue;
    }
    runs.push({
      runId: typeof raw.runId === "string" ? raw.runId : name,
      runDir,
      sessionId: typeof raw.sessionId === "string" ? raw.sessionId : "",
      status: typeof raw.status === "string" ? raw.status : "unknown",
      pid: typeof raw.pid === "number" ? raw.pid : null,
      dispatchedAt: typeof raw.dispatchedAt === "number" ? raw.dispatchedAt : 0,
      hasFindings: fs.existsSync(path.join(runDir, "01-findings.json")),
      coverage: parseCoverage(raw.coverage),
    });
  }
  return runs.sort((a, b) => b.dispatchedAt - a.dispatchedAt).slice(0, MAX_SCAN);
}

/** 纯函数：找「同一会话、复盘还在跑、子进程活着」的那条 run；多条命中时取最近派发的 */
export function findSameSessionRun(
  runs: readonly AggregateRun[],
  sessionId: string,
  isAlive: (pid: number) => boolean,
  now: number,
): AggregateRun | null {
  let found: AggregateRun | null = null;
  for (const run of runs) {
    if (run.sessionId !== sessionId) continue;
    if (run.status !== IN_FLIGHT_STATUS || run.hasFindings) continue;
    if (run.pid === null || !isAlive(run.pid)) continue;
    // 时钟回拨写出来的「未来」派发时刻无法判断真伪：宁可不并（另开一条至少看得见）
    if (run.dispatchedAt > now) continue;
    if (found === null || run.dispatchedAt > found.dispatchedAt) found = run;
  }
  return found;
}

export interface MergeRoundInput {
  evolutionDir: string;
  sessionId: string;
  /** 本次要记的轮次总数（本轮 + 之前被去抖挡下的轮数） */
  rounds: number;
  now: number;
  /** pid 存活判定（默认 kill(pid,0)；单测注入，测试里不起真进程） */
  isAlive?: (pid: number) => boolean;
  telemetry?: TelemetryWriter;
  log?: (msg: string) => void;
}

export interface MergeOutcome {
  runId: string;
  /** 并入后的累计轮数 */
  rounds: number;
}

/**
 * 读盘 → 判定 → 打补丁。没命中返回 null，调用方照旧派生新 run。
 * 任何异常都吞掉并按「未命中」处理：聚合是省一次复盘，不能反过来把派发流程搞挂。
 */
export function mergeRoundIntoRun(input: MergeRoundInput): MergeOutcome | null {
  try {
    const target = findSameSessionRun(
      readAggregateRuns(input.evolutionDir),
      input.sessionId,
      input.isAlive ?? isPidAlive,
      input.now,
    );
    if (target === null) return null;
    const coverage = mergedCoverage(target, input);
    // run.json 读不到了：按未命中处理，走老路另开一条（宁可多一条看得见的 run，也不静默吞掉这一轮）
    if (!patchRunRecordSync(target.runDir, { coverage })) return null;
    input.telemetry?.append({ kind: "merged", sessionId: input.sessionId, runId: target.runId, rounds: coverage.rounds });
    input.log?.(
      `[skill-evolve] 同会话已有在途复盘 ${target.runId}，本轮并入（共 ${coverage.rounds} 轮），不再派生`,
    );
    return { runId: target.runId, rounds: coverage.rounds };
  } catch (error) {
    input.log?.(`[skill-evolve] 同会话聚合检测失败（按未命中处理）：${String(error)}`);
    return null;
  }
}

/**
 * 并入后的 coverage：在已有轮数上**累加**本次并入的轮数。
 *
 * `rounds` 必须做加法而不是取 max：那条在途 run 派发时已经覆盖了 1 轮（run.json 里可能还没有
 * coverage 字段，那就按 1 算），本次再并入 pending 里的 N 轮，总数是 1 + N。
 * `since` 保留原起点（区间起点不变，只是末尾又长了一截）。
 */
function mergedCoverage(target: AggregateRun, input: MergeRoundInput): RunCoverage {
  const base = target.coverage;
  return {
    rounds: (base?.rounds ?? 1) + input.rounds,
    since: base?.since ?? target.dispatchedAt,
    lastAt: input.now,
    merged: (base?.merged ?? 0) + 1,
  };
}
