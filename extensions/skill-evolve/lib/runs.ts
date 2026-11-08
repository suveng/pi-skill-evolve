/**
 * run 记录（`runs/<runId>/run.json`）的读写：
 * 状态机 dispatched → analyzed / proposed → reviewed / rejected / review_failed（或任一步 abandoned）。
 *
 * 拆成独立文件是为了让 dispatch.ts（派生流程）与 evolution.ts（状态/报告）共用同一套
 * 序列化口径，同时把 dispatch.ts 压在 300 行以内。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { readProposalSummary, type ProposalSummary } from "./proposal.ts";
import type { SupervisorStatus } from "./review-record.ts";
import type { ActionLevel } from "./classify-action.ts";
import type { MutationQueue } from "./telemetry.ts";

export const RUN_STATUSES = [
  "dispatched",
  "analyzed",
  "proposed",
  "reviewed",
  "rejected",
  "review_failed",
  "abandoned",
  // M5 采纳结果（闸门逐闸推进，见 apply.ts）
  "applied",
  "rolled-back",
  "unauthorized_write",
  "failed",
  // 卡死（子进程已死 / 超时）：判定见 lib/stale.ts，不自动重跑
  "stale",
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export interface RunStage {
  name: string;
  model: string | null;
  usage: unknown;
  ms: number;
}

/**
 * 覆盖轮数：`rounds` 是这条 run 一共复盘了几轮，`merged` 是其中有多少轮属于
 * 「同一会话已有在途复盘」被并进来的（见 lib/aggregate.ts）。
 */
export interface RunCoverage {
  rounds: number;
  /** 覆盖起点：第一次被挡下的时刻（缺省同 dispatchedAt） */
  since: number;
  /** 最近一次并进新轮次的时刻 */
  lastAt?: number;
  /** 其中有多少轮是并入在途 run 的（缺省 0） */
  merged?: number;
}

export interface RunRecord {
  runId: string;
  status: RunStatus;
  /** 谁触发的：自动结算 / 手动命令 / 退出前补发 —— 报告里能区分别把“手动兜底”当自动行为 */
  trigger: "auto" | "manual" | "shutdown";
  sessionId: string;
  sessionHash: string;
  sessionFile: string | null;
  /** 会话原文不可读时降级为 telemetry-only，报告里要写明 */
  evidenceMode: "session+telemetry" | "telemetry-only";
  dispatchedAt: number;
  dispatchedAtIso: string;
  pid: number | null;
  /** 评审督导 pid（全局单飞闸的第二个占用位）：派发时写入，督导退出/失败时清成 null */
  supervisorPid?: number | null;
  cwd: string;
  skills: string[];
  /** 去抖合并 / 同会话聚合记下的轮次范围（缺省 = 只覆盖刚结束的 1 轮） */
  coverage?: RunCoverage;
  stages: RunStage[];
  artifacts: Record<string, string>;
  /** M3：复盘子进程产出提案后回写（{type, skill, status, added, removed, file}） */
  proposal?: ProposalSummary;
  /** M4：评审督导回写（只给建议动作，本版一律不写 .pi/skills） */
  review?: RunReview;
  abandonedReason?: string;
}

export interface RunReview {
  status: SupervisorStatus;
  verdict: string | null;
  action: ActionLevel | null;
  reviewerModel: string;
  proposerModel: string;
  sameModel: boolean;
}

export interface RunSummary {
  runId: string;
  status: string;
  dispatchedAt: number | null;
  sessionId: string;
  /** 会话原文的绝对路径：面板据此打开「会话详情」页（同会话聚合也要它） */
  sessionFile: string | null;
  /** 复盘的轮次覆盖（缺省 null = 只覆盖 1 轮，没被并过） */
  coverage: RunCoverage | null;
  /** 子进程 pid：面板靠它判「还活着吗」（见 lib/stale.ts） */
  pid: number | null;
  /** 评审督导 pid：面板据此把阶段标成「评审中」 */
  supervisorPid: number | null;
  /** 本轮产出的提案摘要（M3）：只用于展示，不应用 */
  proposal?: ProposalSummary;
  /** 本轮评审结论（M4）：只用于展示，不应用 */
  review?: RunReview;
}

export async function writeRunRecord(runDir: string, record: RunRecord, queue: MutationQueue): Promise<void> {
  const file = path.join(runDir, "run.json");
  await queue(file, async () => {
    await fs.promises.mkdir(runDir, { recursive: true });
    await fs.promises.writeFile(file, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  });
}

/** 同步写 run.json：只给退出前补发用（主进程马上退出，不能等异步队列） */
export function writeRunRecordSync(runDir: string, record: RunRecord): void {
  const file = path.join(runDir, "run.json");
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

/**
 * 同步打补丁：只改给定字段，其余原样保留（督导 pid 的写入 / 清除走这条）。
 * 读不到 run.json 就返回 false，不凭空造记录。
 */
export function patchRunRecordSync(runDir: string, patch: Record<string, unknown>): boolean {
  const file = path.join(runDir, "run.json");
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    Object.assign(raw, patch);
    writeRunRecordSync(runDir, raw as unknown as RunRecord);
    return true;
  } catch {
    return false;
  }
}

/** 记容器的失败态：写不进去只记日志，绝不让「收尸」这一步反过来把主流程搞挂 */
export async function markRunAbandoned(
  runDir: string,
  reason: string,
  queue: MutationQueue,
  log: (msg: string) => void,
): Promise<void> {
  try {
    const record = JSON.parse(await fs.promises.readFile(path.join(runDir, "run.json"), "utf8")) as RunRecord;
    record.status = "abandoned";
    record.abandonedReason = reason;
    await writeRunRecord(runDir, record, queue);
  } catch (error) {
    log(`[skill-evolve] 标记 abandoned 失败：${String(error)}`);
  }
}

/** 采纳后回写状态：只改 status 与可选补丁字段，其余字段原样保留 */
export async function updateRunStatus(
  evolutionDir: string,
  runId: string,
  status: RunStatus,
  queue: MutationQueue,
  patch: Record<string, unknown> = {},
): Promise<boolean> {
  const runDir = path.join(evolutionDir, "runs", runId);
  const file = path.join(runDir, "run.json");
  let found = false;
  try {
    await queue(file, async () => {
      let raw: Record<string, unknown>;
      try {
        raw = JSON.parse(await fs.promises.readFile(file, "utf8")) as Record<string, unknown>;
      } catch {
        return; // run.json 不在：不凭空造一条假记录
      }
      found = true;
      raw.status = status;
      Object.assign(raw, patch);
      await fs.promises.writeFile(file, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
    });
  } catch {
    return false;
  }
  return found;
}

/** run.json 里的 coverage：字段缺失或类型不对一律当 null（坏数据当空，不让它污染展示） */
export function parseCoverage(value: unknown): RunCoverage | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.rounds !== "number" || typeof record.since !== "number") return null;
  return {
    rounds: record.rounds,
    since: record.since,
    ...(typeof record.lastAt === "number" ? { lastAt: record.lastAt } : {}),
    ...(typeof record.merged === "number" ? { merged: record.merged } : {}),
  };
}

/** 按派生时间倒序列出最近若干个 run（run.json 坏掉的目录直接跳过） */
export function listRuns(evolutionDir: string, limit = 10): RunSummary[] {
  const dir = path.join(evolutionDir, "runs");
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const runs: RunSummary[] = [];
  for (const name of names) {
    const runDir = path.join(dir, name);
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(runDir, "run.json"), "utf8")) as Partial<RunRecord>;
      // 子进程可能只写了 02-proposal.json 而没回写 run.json，所以两处都要看
      const proposal = raw.proposal ?? readProposalSummary(runDir);
      // 同理：结论写盘了但宿主进程已退出、没人把状态推到 analyzed —— 读的时候补上。
      // 不补的话，一个已经成功的复盘会被卡死判定误抦成「复盘失败」（面板最忌讳的事）。
      // 但**写了 run-error.json 的 run 不许补**：那是判定过卡死并留了证据的失败案件，
      // 补成 analyzed 会让它从「卡死」里消失、还挂着「待入队」的灰牌（2026-11-08 实测 7 条被误标）。
      const hasFindings = fs.existsSync(path.join(runDir, "01-findings.json"));
      const hasErrorReport = fs.existsSync(path.join(runDir, "run-error.json"));
      const status =
        hasFindings && !hasErrorReport && (raw.status === "dispatched" || raw.status === "stale")
          ? "analyzed"
          : (raw.status ?? "unknown");
      runs.push({
        runId: raw.runId ?? name,
        status,
        dispatchedAt: typeof raw.dispatchedAt === "number" ? raw.dispatchedAt : null,
        sessionId: raw.sessionId ?? "",
        sessionFile: typeof raw.sessionFile === "string" ? raw.sessionFile : null,
        coverage: parseCoverage(raw.coverage),
        pid: typeof raw.pid === "number" ? raw.pid : null,
        supervisorPid: typeof raw.supervisorPid === "number" ? raw.supervisorPid : null,
        ...(proposal ? { proposal } : {}),
        ...(raw.review ? { review: raw.review } : {}),
      });
    } catch {
      continue;
    }
  }
  return runs.sort((a, b) => (b.dispatchedAt ?? 0) - (a.dispatchedAt ?? 0)).slice(0, limit);
}
