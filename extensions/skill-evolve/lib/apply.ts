/**
 * 采纳一条队列条目：解析目标 → 过五道闸 → 写 05/06 留证 → auto 级单独一条 commit。
 *
 * 只在扩展进程里跑（`withFileMutationQueue` 只有 pi 运行时能提供）。督导进程只写 03-review.json，
 * 所以主会话退出也不会丢：队列在 `.pi/evolution/queue.json`，下次 session_start 接着采纳。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { planTargets } from "./apply-targets.ts";
import { restoreTargets, runGates, type GateDeps, type GateResult } from "./apply-gates.ts";
import { markDone, type QueueItem } from "./queue.ts";
import { updateRunStatus } from "./runs.ts";

export type ApplyStatus = "applied" | "rolled-back" | "failed" | "unauthorized_write";

export interface ApplyOutcome {
  runId: string;
  status: ApplyStatus;
  gates: GateResult[];
  wrote: string[];
  detail?: string;
  /** auto 级成功后的 commit 短 hash（approval 级不自动提交，留给人手动提交） */
  commit?: string | null;
}

export interface ApplyDeps extends GateDeps {
  /** auto 级成功后单独一条 `docs(skill): ...`；返回 ok=false 即回滚该条 */
  commit?: (item: QueueItem, runDir: string) => { ok: boolean; hash?: string; detail?: string };
}

export interface VerifyRecord {
  runId: string;
  status: ApplyStatus;
  at: number;
  atIso: string;
  ms: number;
  gates: GateResult[];
  wrote: string[];
  detail?: string;
  commit?: string | null;
}

export const APPLIED_DIFF_FILE = "05-applied.diff";
export const VERIFY_FILE = "06-verify.json";

export function appliedDiffFile(runDir: string): string {
  return path.join(runDir, APPLIED_DIFF_FILE);
}

export function verifyFile(runDir: string): string {
  return path.join(runDir, VERIFY_FILE);
}

export function readVerify(runDir: string): VerifyRecord | null {
  try {
    return JSON.parse(fs.readFileSync(verifyFile(runDir), "utf8")) as VerifyRecord;
  } catch {
    return null;
  }
}

async function writeText(deps: ApplyDeps, file: string, text: string): Promise<void> {
  await deps.queue(file, async () => {
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(file, text, "utf8");
  });
}

export async function applyRun(item: QueueItem, deps: ApplyDeps): Promise<ApplyOutcome> {
  const runDir = path.join(deps.evolutionDir, "runs", item.runId);
  const started = deps.now();
  const plan = planTargets(runDir, deps.cwd);
  let outcome: ApplyOutcome;

  if (!plan.ok) {
    outcome = { runId: item.runId, status: "failed", gates: [], wrote: [], detail: plan.reason ?? "提案不可用" };
  } else {
    const run = await runGates({ ...deps, runId: item.runId }, plan.targets);
    const status: ApplyStatus = run.ok
      ? "applied"
      : run.unauthorized
        ? "unauthorized_write"
        : run.wrote.length > 0
          ? "rolled-back"
          : "failed";
    outcome = { runId: item.runId, status, gates: run.gates, wrote: run.wrote, ...(run.detail ? { detail: run.detail } : {}) };

    if (run.ok) {
      // 05 只记真实落盘的 diff：被闸拦下的提案不该留下「已应用」的证据
      await writeText(deps, appliedDiffFile(runDir), run.appliedDiff);
      if (item.level === "auto" && deps.commit) {
        const committed = deps.commit(item, runDir);
        if (committed.ok) outcome = { ...outcome, commit: committed.hash ?? null };
        else {
          const reverted = await restoreTargets(deps, plan.targets, run.wrote);
          outcome = { ...outcome, status: "rolled-back", detail: `commit 失败：${committed.detail ?? "未知原因"}；${reverted}` };
        }
      }
    }
  }

  const record: VerifyRecord = {
    runId: item.runId,
    status: outcome.status,
    at: started,
    atIso: new Date(started).toISOString(),
    ms: deps.now() - started,
    gates: outcome.gates,
    wrote: outcome.wrote,
    ...(outcome.detail ? { detail: outcome.detail } : {}),
    ...(outcome.commit !== undefined ? { commit: outcome.commit } : {}),
  };
  await writeText(deps, verifyFile(runDir), `${JSON.stringify(record, null, 2)}\n`);
  return outcome;
}

/** 拒绝只改状态：队列条目 + run.json，绝不碰任何技能文件（和采纳走的是两条路） */
export interface RejectDeps {
  evolutionDir: string;
  queue: MutationQueue;
}

export interface RejectOutcome {
  ok: boolean;
  detail: string;
}

/**
 * 否掉一条待批提案：队列 pending → rejected，run.json → rejected。
 *
 * 为什么不做更多：拒绝的语义是「这条提案不要了」，不是「撤销一次已发生的写入」——
 * 回滚已经应用过的改动是另一条路径（05-applied.diff + restoreTargets）。这里写盘只写状态文件。
 */
export async function rejectRun(item: QueueItem, deps: RejectDeps): Promise<RejectOutcome> {
  if (item.status !== "pending") return { ok: false, detail: `当前状态是 ${item.status}，只有 pending 能拒绝` };
  // 顺序与 apply 相反：队列是外部可见的终态标志，run.json 缺了也不能让条目永远 pending
  const marked = await markDone(deps, item.runId, "rejected", "人主动拒绝（未改任何技能文件）");
  if (!marked) return { ok: false, detail: `队列里没有 ${item.runId}` };
  const patched = await updateRunStatus(deps.evolutionDir, item.runId, "rejected", deps.queue);
  return { ok: true, detail: patched ? "" : "run.json 不存在，只改了队列状态" };
}
