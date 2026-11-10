/**
 * 采纳侧的胶水：扫「评审通过」的 run → 入队 → auto 自动应用 / approve 手动应用 → 人话输出。
 *
 * 为什么扫描在扩展进程：闸2 需要 withFileMutationQueue（只有 pi 运行时能给），
 * 所以评审督导只写 03-review.json，真正写盘永远回到这里。主会话退出也不丢：
 * 队列落在 `.pi/evolution/queue.json`，下次 session_start 接着采纳。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { applyRun, rejectRun, type ApplyDeps, type ApplyOutcome } from "./apply.ts";
import { cleanupBackups } from "./apply-gates.ts";
import { readProposalMeta } from "./apply-targets.ts";
import { classifyChange } from "./classify-action.ts";
import { captureGate0, saveGate0, type GitRunner } from "./gate0.ts";
import { buildPrunePlan, renderPrunePlan } from "./prune-plan.ts";
import { enqueue, findItem, markDone, readQueue, takePending, type QueueItem, type QueueStatus } from "./queue.ts";
import { withLock } from "./lock.ts";
import { logLine } from "./logfile.ts";
import { updateRunStatus } from "./runs.ts";
import type { MutationQueue } from "./telemetry.ts";
import type { EvolutionConfig } from "./config.ts";

export interface ApplyToolsDeps {
  evolutionDir: string;
  cwd: string;
  queue: MutationQueue;
  /**
   * 开关读取（每次调用现读，**不许拿会话起点的缓存**）：
   * `autoReview` 决定 proposed 的 run 要不要入队，`autoApply` 决定 auto 条要不要落盘 ——
   * 用户中途 `/skill-evolve apply on`，下一轮扫描就该生效。
   */
  flags: () => Pick<EvolutionConfig, "autoReview" | "autoApply">;
  now?: () => number;
  log?: (msg: string) => void;
  git: GitRunner;
  loadDiagnostics: () => { path: string; message: string }[];
  runMdCheck: (absPath: string) => { code: number; output: string };
  commit?: ApplyDeps["commit"];
}

export interface ApplyTools {
  /** session_start：闸0 快照 + 备份清理 + 扫队列并应用 auto 条 */
  sessionStart(): void;
  /** settle：评审可能刚写完，扫一遍（只应用 auto 条） */
  settle(): void;
  approve(runId: string, prune: boolean): Promise<string>;
  /** 拒绝一条待批提案：只改队列与 run.json 状态，不动任何技能文件 */
  reject(runId: string): Promise<string>;
  queueText(): string;
  /** 供测试与内部复用：返回实际应用成功的条数 */
  autoApplyPending(): Promise<number>;
  enqueueReady(): Promise<number>;
}

/** 只有评审通过（reviewed）的 run 才进队列；rejected / review_failed 一律不排 */
const READY_STATUS = "reviewed";
/** 评审关着时 run 停在这里：提案写完了、没人看过，仍然入队等人工批准 */
const PROPOSED_STATUS = "proposed";
const MAX_SCAN = 50;
/** 采纳链的锁上限：一次扫队列 + 应用几份 diff，正常两秒内完成；锁主崩了 5 分钟后可回收 */
const APPLY_LOCK_MS = 5 * 60_000;

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function readRunJson(runDir: string): Record<string, unknown> | null {
  const raw = readText(path.join(runDir, "run.json"));
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function stamp(ts: number): string {
  return ts > 0 ? new Date(ts).toISOString() : "时间未知";
}

function renderOutcome(outcome: ApplyOutcome, item: QueueItem): string {
  const head =
    outcome.status === "applied"
      ? `已采纳 ${item.runId}（${item.level} · ${item.skill}）`
      : `采纳未完成 ${item.runId}：${outcome.status}`;
  const lines = [head];
  for (const gate of outcome.gates) {
    lines.push(`  ${gate.ok ? "✔" : "✘"} ${gate.gate} ${gate.name} ${gate.ms}ms${gate.detail ? ` — ${gate.detail}` : ""}`);
  }
  if (outcome.wrote.length > 0) lines.push(`写入：${outcome.wrote.join("、")}`);
  if (outcome.commit) lines.push(`commit：${outcome.commit}（docs(skill): …）`);
  if (outcome.detail) lines.push(`说明：${outcome.detail}`);
  if (outcome.status === "applied") lines.push("生效：未 reload，新会话生效（技能在 session_start 重新发现）");
  if (outcome.status === "applied" && item.level === "approval") lines.push("提醒：approval 级不自动提交，请人工检查后 git commit");
  if (outcome.status === "unauthorized_write") lines.push("告警：`.pi/skills` 在会话开始后被改动过，本次未写盘；证据见 06-verify.json");
  return lines.join("\n");
}

export function createApplyTools(deps: ApplyToolsDeps): ApplyTools {
  const now = deps.now ?? (() => Date.now());
  // 默认只落盘（`.pi/evolution/logs/extension.log`）：TUI 默认零推送
  const log = deps.log ?? ((msg: string) => logLine(deps.evolutionDir, msg));
  const queueDeps = { evolutionDir: deps.evolutionDir, queue: deps.queue, now };

  const targetsOf = (runDir: string, skill: string, type: string, fromDiff: readonly string[]): string[] => {
    const known = readProposalMeta(runDir);
    const head = type === "create" ? [`.pi/skills/${skill}/SKILL.md`] : [];
    return [...new Set([...head, ...(known ? fromDiff : [])])];
  };

  const enqueueReady: ApplyTools["enqueueReady"] = async () => {
    // 开关现读（不缓存）：中途 review off 就新提案进队列标 reviewSkipped，review on 就恢复只收 reviewed
    const autoReview = deps.flags().autoReview;
    const runsDir = path.join(deps.evolutionDir, "runs");
    let names: string[];
    try {
      names = fs.readdirSync(runsDir).slice(0, MAX_SCAN);
    } catch {
      return 0;
    }
    const known = new Set(readQueue(deps.evolutionDir).map((item) => item.runId));
    let added = 0;
    for (const name of names) {
      if (known.has(name)) continue;
      const runDir = path.join(runsDir, name);
      const raw = readRunJson(runDir);
      if (!raw) continue;
      // 评审关着时 run 停在 proposed：照旧入队（「待审批」页要看得见），只是标 reviewSkipped
      const reviewSkipped = !autoReview && raw.status === PROPOSED_STATUS;
      if (raw.status !== READY_STATUS && !reviewSkipped) continue;
      const meta = readProposalMeta(runDir);
      if (!meta) continue;
      const diffText = readText(path.join(runDir, meta.diffFile)) ?? "";
      const graded = classifyChange({ diffText, proposalType: meta.type, skill: meta.skill });
      if (graded.level === "forbidden") {
        log(`[skill-evolve] ${name} 判 forbidden，不入队：${graded.reasons[0] ?? ""}`);
        continue;
      }
      const result = await enqueue(queueDeps, {
        runId: name,
        level: graded.level,
        skill: meta.skill,
        targets: targetsOf(runDir, meta.skill, meta.type, graded.targets),
        proposalType: meta.type,
        ...(reviewSkipped ? { reviewSkipped: true } : {}),
      });
      if (result.supersededBy) log(`[skill-evolve] ${name} 被更早的 pending 顶掉（${result.supersededBy}）`);
      else if (reviewSkipped) log(`[skill-evolve] ${name} 入队（评审已关，待人工批准）：${graded.level}（${graded.reasons[0] ?? ""}）`);
      else log(`[skill-evolve] ${name} 入队：${graded.level}（${graded.reasons[0] ?? ""}）`);
      added += 1;
    }
    return added;
  };

  const writeDecision = async (runDir: string, item: QueueItem, outcome: ApplyOutcome): Promise<void> => {
    const record = {
      runId: item.runId,
      level: item.level,
      skill: item.skill,
      approver: item.level === "auto" ? "auto" : "command",
      status: outcome.status,
      at: now(),
      atIso: new Date(now()).toISOString(),
      ...(outcome.detail ? { detail: outcome.detail } : {}),
    };
    const file = path.join(runDir, "04-decision.json");
    await deps.queue(file, async () => {
      await fs.promises.mkdir(runDir, { recursive: true });
      await fs.promises.writeFile(file, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    });
  };

  const applyOne = async (item: QueueItem): Promise<ApplyOutcome> => {
    const applyDeps: ApplyDeps = {
      evolutionDir: deps.evolutionDir,
      cwd: deps.cwd,
      runId: item.runId,
      queue: deps.queue,
      now,
      log,
      git: deps.git,
      loadDiagnostics: deps.loadDiagnostics,
      runMdCheck: deps.runMdCheck,
      ...(deps.commit ? { commit: deps.commit } : {}),
    };
    const outcome = await applyRun(item, applyDeps);
    const status: QueueStatus =
      outcome.status === "applied" ? "applied" : outcome.status === "rolled-back" ? "rolled-back" : "failed";
    // 顺序不能换：先落决策记录，再改 run.json，最后改队列 / run 状态。
    // 队列状态是外部可见的「终态标志」，进程若在中间被 kill，早写队列会留下
    // 「已 applied 但读不到 04-decision.json」的空窗（approve.test.ts 的偶发 ENOENT 就是它）。
    await writeDecision(path.join(deps.evolutionDir, "runs", item.runId), item, outcome);
    await updateRunStatus(deps.evolutionDir, item.runId, outcome.status, deps.queue);
    await markDone(queueDeps, item.runId, status, outcome.detail);
    return outcome;
  };

  // 「自动采纳已关」只提示一次：settle 每轮都会调到，同一条不变就别反复刷日志
  let applyOffNotice = "";

  const autoApplyPending: ApplyTools["autoApplyPending"] = async () => {
    // 开关现读：`/skill-evolve apply on` 之后下一轮扫描就落盘，不用重开会话
    if (!deps.flags().autoApply) {
      const waiting = takePending(readQueue(deps.evolutionDir), "auto").length;
      const notice = `[skill-evolve] 自动采纳已关：${waiting} 条 auto 提案在队列里等人工批准`;
      if (waiting > 0 && notice !== applyOffNotice) {
        log(notice);
        applyOffNotice = notice;
      }
      return 0;
    }
    let applied = 0;
    for (const item of takePending(readQueue(deps.evolutionDir), "auto")) {
      try {
        const outcome = await applyOne(item);
        if (outcome.status === "applied") applied += 1;
        log(`[skill-evolve] auto 采纳 ${item.runId}：${outcome.status}${outcome.detail ? `（${outcome.detail}）` : ""}`);
      } catch (error) {
        // 单条失败不能拖垮整批：记 failed 后继续下一条
        await markDone(queueDeps, item.runId, "failed", String(error));
        log(`[skill-evolve] auto 采纳 ${item.runId} 异常：${String(error)}`);
      }
    }
    return applied;
  };

  /**
   * 采纳链（扫队列 → 应用）跨实例互斥。
   *
   * 为什么需要：同一个工作区开两个 pi 时，两边的 `session_start` / `settle` 都会扫同一份 queue.json。
   * 队列是「读-改-写」，两个进程同时写会互相覆盖；`autoApplyPending` 更糟 —— 同一份 diff 可能被
   * 两个进程各应用一次。抢不到锁的那一方直接跳过，下一次 settle / 会话起点还会再来。
   */
  const withApplyLock = async (run: () => Promise<unknown>): Promise<void> => {
    const got = await withLock(
      {
        evolutionDir: deps.evolutionDir,
        name: "apply",
        owner: { pid: process.pid, ts: now() },
        maxRuntimeMs: APPLY_LOCK_MS,
        log,
      },
      run,
    );
    if (!got.ok) {
      log(`[skill-evolve] 采纳链由另一个 pi 实例持有（locks/apply pid ${got.owner?.pid ?? "?"}），本次跳过`);
    }
  };

  const scanAndApply = (): void => {
    void withApplyLock(() => enqueueReady().then(() => autoApplyPending())).catch((error: unknown) =>
      log(`[skill-evolve] 采纳扫描失败：${String(error)}`),
    );
  };

  const sessionStart: ApplyTools["sessionStart"] = () => {
    const time = now();
    try {
      cleanupBackups(deps.evolutionDir, time, log, deps.retentionDays?.());
    } catch (error) {
      log(`[skill-evolve] 备份清理失败：${String(error)}`);
    }
    void saveGate0(deps.evolutionDir, captureGate0(deps.git, deps.cwd, time), deps.queue)
      .then(() => withApplyLock(() => enqueueReady().then(() => autoApplyPending())))
      .catch((error: unknown) => log(`[skill-evolve] 会话起点初始化失败：${String(error)}`));
  };

  const approve: ApplyTools["approve"] = async (runId, prune) => {
    if (!runId) return "用法：/skill-evolve approve <runId> [--prune]";
    const runDir = path.join(deps.evolutionDir, "runs", runId);
    if (prune) {
      const plan = buildPrunePlan(runDir, deps.cwd);
      return plan ? renderPrunePlan(plan) : `找不到 ${runId} 的提案（02-proposal.json），无法生成删除清单`;
    }
    const item = findItem(readQueue(deps.evolutionDir), runId);
    if (!item) return `队列里没有 ${runId}：先 /skill-evolve queue 看有哪些，或等评审通过后自动入队`;
    if (item.status === "applied") return `${runId} 已经应用过（${item.detail ?? "无详情"}），无需重复操作`;
    if (item.status !== "pending") return `${runId} 当前状态是 ${item.status}，只有 pending 能采纳`;
    if (item.level === "forbidden") return `${runId} 被判 forbidden（删技能 / 改语义字段 / 路径越界），插件不执行`;
    const outcome = await applyOne(item);
    return renderOutcome(outcome, item);
  };

  const reject: ApplyTools["reject"] = async (runId) => {
    if (!runId) return "用法：/skill-evolve approve <runId>（拒绝入口在 Web 面板的待审批页）";
    const item = findItem(readQueue(deps.evolutionDir), runId);
    if (!item) return `队列里没有 ${runId}：先 /skill-evolve queue 看有哪些，或等评审通过后自动入队`;
    const outcome = await rejectRun(item, queueDeps);
    if (!outcome.ok) return `拒绝未完成 ${runId}：${outcome.detail}`;
    log(`[skill-evolve] 拒绝 ${item.runId}（${item.level} · ${item.skill}）：只改队列与 run 状态，未动技能文件`);
    const tail = outcome.detail ? `（${outcome.detail}）` : "";
    return `已拒绝 ${runId}（${item.level} · ${item.skill}）${tail}：技能文件未改动`;
  };

  const queueText: ApplyTools["queueText"] = () => {
    const items = readQueue(deps.evolutionDir);
    if (items.length === 0) return `采纳队列为空：${path.join(deps.evolutionDir, "queue.json")}（评审通过后自动入队）`;
    const lines = [`采纳队列：${path.join(deps.evolutionDir, "queue.json")}`];
    const groups: QueueStatus[] = ["pending", "applied", "rolled-back", "failed", "superseded", "rejected"];
    for (const status of groups) {
      const group = items.filter((item) => item.status === status).sort((a, b) => b.createdAt - a.createdAt);
      if (group.length === 0) continue;
      lines.push(`${status} ${group.length} 条`);
      for (const item of group.slice(0, 5)) {
        const detail = item.detail ? ` · ${item.detail}` : "";
        lines.push(`  · ${item.runId}  ${item.level}  ${item.skill}  ${stamp(item.createdAt)}${detail}`);
        if (status === "pending") lines.push(`    targets：${item.targets.join("、")}`);
      }
    }
    lines.push("auto 级在 session_start / settle 自动执行；approval 用 /skill-evolve approve <runId> 或 Web 面板待审批页");
    return lines.join("\n");
  };

  return { sessionStart, settle: scanAndApply, approve, reject, queueText, autoApplyPending, enqueueReady };
}
