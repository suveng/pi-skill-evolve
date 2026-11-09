/**
 * 重启 / `/reload` 之后的自动恢复。
 *
 * 为什么需要它：派发出去的两个子进程都是 detached 的，但**收尸逻辑在内存里**。
 * 主进程一重启，`watchRunChild` 的 exit 回调就没了；督导若也被带走了（机器重启、
 * 端口没放开被旧实例挡掉、面板手动清理），run 会永久停在 `dispatched` / `analyzed`，
 * 用户看到的就是「已分析」但提案永远不出 —— 2026-11-09 的事故现场。
 *
 * 恢复只做三件保守的事，绝不重跑复盘（花 token 且会覆盖已有产物）：
 * 1. 有 `01-findings.json` 却还写着 `dispatched` → 补成 `analyzed`（分析其实已经跑完）
 * 2. 有 `02-proposal.json` 但没 `03-review.json`、督导进程已死 → 重挂一个督导接着评审
 * 3. 其余情况只报告，不动手（复盘子进程还在跑就别打扰它）
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { withLock } from "./lock.ts";
import { spawnReviewSupervisor, type SpawnSupervisorOptions } from "./review-spawn.ts";
import { listRuns, updateRunStatus, type RunRecord } from "./runs.ts";
import type { MutationQueue } from "./telemetry.ts";

/** 只恢复最近这么多小时内派发的 run：更老的多半是用户已经不管的历史 */
export const RECOVER_WINDOW_MS = 6 * 60 * 60 * 1000;

/** 还在「半路」的状态：出终态的不该被碰 */
const RESUMABLE = new Set(["dispatched", "analyzed", "proposed"]);

export type RecoveryKind =
  /** 分析产物在、状态落后：只补状态 */
  | "advanced-analyzed"
  /** 提案在、督导不在：重挂督导 */
  | "supervisor-respawned"
  /** 提案在、督导还在跑：不打扰 */
  | "waiting-review"
  /** 还没出提案，复盘子进程还活着 */
  | "waiting-proposal"
  /** 还没出提案，复盘子进程也没了：不重跑，等 stale 收尾 */
  | "interrupted"
  /** 已有评审结论：交给会话起点的入队 / 自动采纳 */
  | "review-done"
  /** 重挂被挡下（单飞闸占满 / 关着自动评审 / 起不来） */
  | "respawn-blocked";

export interface RecoveryAction {
  runId: string;
  kind: RecoveryKind;
  detail: string;
}

export interface RecoverDeps {
  evolutionDir: string;
  cwd: string;
  queue: MutationQueue;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
  alive?: (pid: number) => boolean;
  /** 现读配置：自动评审关着就不重挂督导（用户手动关的不该被重启偷偷打开） */
  autoReview?: () => boolean;
  reviewModel?: () => string;
  spawnSupervisor?: (options: SpawnSupervisorOptions) => number | null;
  /** 本会话 ID：写进锁 owner.json，排查「谁在重挂」时有用 */
  sessionId?: string;
  log?: (msg: string) => void;
  windowMs?: number;
}

/** 督导锁只护「起来 + 写 supervisorPid」这几毫秒，留 60 秒足够，锁主崩了也不会长期占住 */
const SUPERVISOR_LOCK_MS = 60_000;

/** 抢到锁后重新确认「这条 run 的督导确实不在」，防止两边都判死、抢完各起一个 */
function supervisorStillGone(
  runDir: string,
  record: RunRecord,
  alive: (pid: number) => boolean,
): boolean {
  const fresh = readRecord(runDir) ?? record;
  const pid = fresh.supervisorPid;
  return !(typeof pid === "number" && alive(pid));
}

function exists(runDir: string, name: string): boolean {
  try {
    return fs.statSync(path.join(runDir, name)).isFile();
  } catch {
    return false;
  }
}

/** 生产里就是读 run.json：坏数据当「没有」处理，宁可不动手 */
function readRecord(runDir: string): RunRecord | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(runDir, "run.json"), "utf8")) as RunRecord;
  } catch {
    return null;
  }
}

export async function recoverRuns(deps: RecoverDeps): Promise<RecoveryAction[]> {
  const log = deps.log ?? (() => {});
  const now = deps.now ?? (() => Date.now());
  const alive = deps.alive ?? ((pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  });
  const windowMs = deps.windowMs ?? RECOVER_WINDOW_MS;
  const spawnSupervisor = deps.spawnSupervisor ?? spawnReviewSupervisor;
  const actions: RecoveryAction[] = [];
  const runsRoot = path.join(deps.evolutionDir, "runs");
  let entries: string[];
  try {
    entries = fs.readdirSync(runsRoot);
  } catch {
    return actions;
  }
  const cutoff = now() - windowMs;
  for (const runId of entries.sort()) {
    const runDir = path.join(runsRoot, runId);
    const record = readRecord(runDir);
    if (!record) continue;
    if (!RESUMABLE.has(record.status ?? "")) continue;
    if (typeof record.dispatchedAt === "number" && record.dispatchedAt < cutoff) continue;

    const hasFindings = exists(runDir, "01-findings.json");
    const hasProposal = exists(runDir, "02-proposal.json");
    const hasReview = exists(runDir, "03-review.json");
    const childAlive = typeof record.pid === "number" && alive(record.pid);
    const supervisorAlive = typeof record.supervisorPid === "number" && alive(record.supervisorPid);

    if (hasReview) {
      actions.push({ runId, kind: "review-done", detail: "评审已落盘，等会话起点入队 / 自动采纳" });
      continue;
    }

    // 1. 分析跑完了但状态没跟上：补状态（不重跑、不花 token）
    if (record.status === "dispatched" && hasFindings) {
      const ok = await updateRunStatus(deps.evolutionDir, runId, "analyzed", deps.queue);
      actions.push({
        runId,
        kind: ok ? "advanced-analyzed" : "interrupted",
        detail: ok ? "01-findings.json 已在，状态补成 analyzed（未重跑）" : "补状态失败：run.json 写不进去",
      });
      if (!ok) continue;
    }

    if (!hasProposal) {
      if (childAlive) {
        actions.push({ runId, kind: "waiting-proposal", detail: `复盘子进程 pid ${record.pid} 还活着，不打扰` });
      } else {
        actions.push({ runId, kind: "interrupted", detail: "还没出提案，复盘子进程已不在：不自动重跑，等 stale 收尾" });
      }
      continue;
    }

    // 2. 提案在、评审没做：重挂督导（这才是「后台任务丢了」的正解）
    if (supervisorAlive) {
      actions.push({ runId, kind: "waiting-review", detail: `督导 pid ${record.supervisorPid} 还在跑，等它出结论` });
      continue;
    }
    if (deps.autoReview && !deps.autoReview()) {
      actions.push({ runId, kind: "respawn-blocked", detail: "自动评审关着：停在待人工 /skill-evolve approve" });
      continue;
    }
    // 3. 跨实例互斥：同一个工作区开两个 pi 时，两边 session_start 都会走到这里。
    //    单飞闸只认「已经写进 run.json 的活 pid」，两边的 spawn 之间有空档，会各起一个督导（双花 token、双写 03-review）。
    //    所以先用 locks/supervisor 抢一下，抢不到说明对面那份正在重挂，让它挂。
    const spawned = await withLock(
      {
        evolutionDir: deps.evolutionDir,
        name: "supervisor",
        owner: { pid: process.pid, ts: now(), ...(deps.sessionId ? { sessionId: deps.sessionId } : {}) },
        maxRuntimeMs: SUPERVISOR_LOCK_MS,
        log,
        ...(deps.now ? { now: deps.now } : {}),
      },
      () =>
        // 抢到锁后再判一次：对面可能刚好在抢锁之前写完 supervisorPid
        supervisorStillGone(runDir, record, alive)
          ? spawnSupervisor({
              runDir,
              cwd: deps.cwd,
              autoReview: true,
              reviewModel: deps.reviewModel?.() ?? "inherit",
              ...(deps.env ? { env: deps.env } : {}),
              ...(deps.alive ? { alive: deps.alive } : {}),
              log,
            })
          : "taken", 
    );
    if (!spawned.ok) {
      actions.push({
        runId,
        kind: "respawn-blocked",
        detail: `另一个 pi 实例正在重挂督导（locks/supervisor 被 pid ${spawned.owner?.pid ?? "?"} 持有）`,
      });
      continue;
    }
    const pid = spawned.value;
    if (pid === "taken") {
      actions.push({ runId, kind: "waiting-review", detail: "等到锁时督导已经在了（另一个实例刚挂上），不重复起" });
      continue;
    }
    actions.push(
      pid === null
        ? { runId, kind: "respawn-blocked", detail: "督导没起来（单飞闸占满或 spawn 失败），下次会话起点还会再试" }
        : { runId, kind: "supervisor-respawned", detail: `提案已在、督导原本不在：重挂 pid ${pid}` },
    );
  }
  return actions;
}

/** 面板文案：一句话说清「重启后补了什么」 */
export function renderRecovery(actions: RecoveryAction[]): string {
  if (actions.length === 0) return "重启恢复：没有需要接手的 run";
  const label: Record<RecoveryKind, string> = {
    "advanced-analyzed": "补状态",
    "supervisor-respawned": "重挂督导",
    "waiting-review": "等评审",
    "waiting-proposal": "等提案",
    interrupted: "已中断",
    "review-done": "评审完成",
    "respawn-blocked": "未能重挂",
  };
  const lines = [`重启恢复：${actions.length} 条 run 被检查`];
  for (const action of actions) lines.push(`  · ${action.runId}  ${label[action.kind]} — ${action.detail}`);
  return lines.join("\n");
}
