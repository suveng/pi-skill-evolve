/**
 * 「这条 run 现在归哪个 tab、凭什么归它」的唯一判据。
 *
 * 为什么要单独一个文件：tab 归属原本散在 pending.ts / approvals.ts / applied.ts / done.ts 四份实现里，
 * 同一个 runId 在「待处理」和「待审批」各出现一次的情况就是这么来的（2026-11-10 用户：
 * 「每个 tab 不要出现重复的，还有现在这个任务我要看到它从哪个 tab 出来的，出来的证据是什么」）。
 *
 * 三条纪律：
 * 1. **优先级固定、单向**：已采纳 > 已结束 > 待审批 > 待处理。一个 run 只落在第一个命中的 tab，
 *    列表聚合（data.ts）与详情页（run-detail.ts）都调这里，不许各写一遍判据。
 * 2. **证据只写磁盘上真有的东西**：queue.json 的状态、run.json 的状态、03-review.json / 06-verify.json
 *    这类文件是否存在 —— 让人能自己去 `cat` 一遍复核，而不是「面板说它在待审批」。
 * 3. **判据值取自实际记录**：状态字符串从入参读，不在本文件里另抄一份状态清单；
 *    状态清单（DONE_STATUSES 等）仍由各自模块导出，这里只做顺位判断。
 */
import type { QueueItem } from "../queue.ts";
import { DONE_STATUSES } from "./done.ts";

/** 会出现在导航里的四个「run 归属页」；技能管理 / 设置不是 run 的归属地 */
export type RunTab = "pending" | "approvals" | "applied" | "done";

/** 顺位：数字小的赢。同一个 runId 命中多个判据时取最小的那个 tab */
export const TAB_RANK: Record<RunTab, number> = { applied: 0, done: 1, approvals: 2, pending: 3 };

export const TAB_LABEL: Record<RunTab, string> = {
  applied: "已采纳",
  done: "已结束",
  approvals: "待审批",
  pending: "待处理",
};

export interface RunOrigin {
  tab: RunTab;
  label: string;
  /** 一句话判据（用的是记录本身的字段，不写「系统认为」这种空话） */
  reason: string;
  /** 可复核的证据：文件路径 / 字段值，人照着就能 cat 出来 */
  evidence: string[];
}

export interface OriginInput {
  runId: string;
  /** evolutionDir 下的相对路径前缀，用来拼证据文件路径 */
  runRelDir: string;
  /** 队列里这条 run 的记录（没有 = 从未入队） */
  queue?: QueueItem;
  /** run.json 里的状态（读不到 = undefined） */
  runStatus?: string;
  /** 磁盘上有没有 02-proposal.json（analyzed 时用它区分「已出提案」与「判定不用改」） */
  hasProposal?: boolean;
}

/** 队列状态里属于「已结束」的那一组：与 done.ts 的 run 状态清单互补 */
const QUEUE_TERMINAL = new Set(["failed", "rolled-back", "rejected", "superseded", "abandoned"]);

function queueLine(item: QueueItem | undefined): string[] {
  if (!item) return [];
  const out = [`${"queue.json"}：status=${item.status}${item.level ? ` level=${item.level}` : ""}`];
  if (item.targets.length > 0) out.push(`queue.json：targets=${item.targets.join("、")}`);
  return out;
}

/**
 * 判这条 run 归哪个 tab。调用方要保证 runId 一致 —— 这里不做校验，
 * 因为聚合与详情页都已各自过过 runId 白名单（见 run-path.ts / filter.ts）。
 */
export function originOfRun(input: OriginInput): RunOrigin {
  const { queue, runStatus, runRelDir } = input;
  const evidence = queueLine(queue);

  // ① 已采纳：队列是唯一事实（run.json 的 applied 由它回写，两条不一致时以队列为准）
  if (queue?.status === "applied") {
    return {
      tab: "applied",
      label: TAB_LABEL.applied,
      reason: "采纳队列里已标记 applied（技能文件已写盘）",
      evidence: [...evidence, `${runRelDir}/06-verify.json`, `${runRelDir}/run.json`],
    };
  }
  // ② 已结束：回滚 / 失败 / 否决 / 被取代 / 评审失败 / 放弃 / 越权写入
  const terminal = queue !== undefined ? QUEUE_TERMINAL.has(queue.status) : false;
  const runDone = runStatus !== undefined && (DONE_STATUSES as readonly string[]).includes(runStatus);
  if (terminal || runDone) {
    const why = terminal ? `采纳队列状态 ${queue?.status}` : `run.json 状态 ${runStatus}`;
    return {
      tab: "done",
      label: TAB_LABEL.done,
      reason: `${why} 属于终态（不会再往前走）`,
      evidence: [...evidence, `${runRelDir}/run.json`, `${runRelDir}/run-error.json`],
    };
  }
  // ②b 分析判定不需要改：analyzed 且没有提案，也是终态（2026-11-11 实测它曾在所有 tab 里消失）
  if (runStatus === "analyzed" && input.hasProposal === false) {
    return {
      tab: "done",
      label: TAB_LABEL.done,
      reason: "run.json 状态 analyzed 且没有 02-proposal.json：分析判定不需要改（终态）",
      evidence: [...evidence, `${runRelDir}/run.json`, `${runRelDir}/01-findings.json`],
    };
  }
  // ③ 待审批：队列 pending 且 level=approval —— 这类必须人点，auto 永不代劳
  if (queue?.status === "pending" && queue.level === "approval") {
    return {
      tab: "approvals",
      label: TAB_LABEL.approvals,
      reason: "队列 status=pending 且 level=approval（等待人工批准）",
      evidence: [...evidence, `${runRelDir}/02-proposal.json`, `${runRelDir}/03-review.json`],
    };
  }
  // ④ 其余都算待处理：在跑 / 卡死 / 待评审 / 已评审待入队
  return {
    tab: "pending",
    label: TAB_LABEL.pending,
    reason:
      queue?.status === "pending"
        ? "队列 status=pending 且 level=auto（不需要人点，等 settle 自动执行）"
        : "既不在采纳队列的终态里，也没有等待人工批准的记录（在跑 / 待评审 / 待入队）",
    evidence: [...evidence, `${runRelDir}/run.json`, `${runRelDir}/03-review.json`],
  };
}
