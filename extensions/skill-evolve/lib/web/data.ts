/**
 * 只读 Web 面板的数据聚合：把 `.pi/evolution/` 的散落文件拼成五个视图要的形状。
 *
 * 三条纪律：
 * 1. **只读**：这里不写盘、不开监听、不改任何状态 —— 面板永远不能变成第二个写入方；
 * 2. **坏数据当空**：run.json / 队列 / 各类产出一律可能「写到一半被 kill」，任何字段缺失都退化成
 *    null / []，绝不因为一条烂记录让整页 500（用户从飞书点进来只想要个概览）；
 * 3. **数字不重算**：summary 直接复用 collectPanelState，和 TUI 状态栏同一口径 ——
 *    两处各算一套，迟早出现「TUI 说待批 2、网页说待批 3」。
 *
 * 这里只留**视图形状 + 聚合入口**：四类待处理条目的判定在 ./pending.ts，已处理在 ./done.ts，
 * 待审批 / 已采纳 / 报告各自一个文件 —— 合在一起必然破 300 行闸门。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { collectPanelState } from "../panel.ts";
import { readQueue } from "../queue.ts";
import { listRuns } from "../runs.ts";
import { originOfRun, type RunTab } from "./tab-origin.ts";
import { buildApplied, type AppliedItem } from "./applied.ts";
import { buildApprovals, type ApprovalItem } from "./approvals.ts";
import { buildDone, type DoneItem } from "./done.ts";
import { buildPending, type PendingItem } from "./pending.ts";

export type { ApprovalItem } from "./approvals.ts";
export type { AppliedItem } from "./applied.ts";
export type { PendingItem, PendingKind } from "./pending.ts";
export type { DoneItem } from "./done.ts";
export { DONE_LIMIT } from "./done.ts";

/** 列表页（技能管理页 `skills` 与三个详情页 `run` / `skill` / `session` 不在这个联合里，见 filter.ts 的 PANEL_VIEWS） */
export const WEB_VIEWS = ["pending", "approvals", "applied", "done"] as const;
export type WebView = (typeof WEB_VIEWS)[number];

/** 扫描最近多少个 run：卡死 / 待入队这类判断只需要看近期，runs/ 里可能有几百个历史目录 */
const SCAN_LIMIT = 100;

export interface WebSummary {
  reviewing: number;
  stale: number;
  pendingApprovals: number;
  appliedTotal: number;
  rollbackRate: number;
}

export interface WebState {
  pending: PendingItem[];
  /** 待落盘：所有 status=pending 的队列条目（不分 level），带按钮所需的最小事实（见 ./approvals.ts） */
  approvals: ApprovalItem[];
  /** 已采纳：只收队列 applied，且**不再**进 done（两个 tab 不许混） */
  applied: AppliedItem[];
  done: DoneItem[];
  summary: WebSummary;
}

export interface WebStateDeps {
  /** 现时（单测注入固定时钟） */
  now?: number;
  /** pid 存活判定（默认 process.kill(pid,0)；单测注入，测试里不起真进程） */
  alive?: (pid: number) => boolean;
  /** 单 run 上限（毫秒），只用于「上限 N 分钟」那一行 */
  maxRuntimeMs?: number;
}

export function collectWebState(input: { evolutionDir: string } & WebStateDeps): WebState {
  const { evolutionDir, ...deps } = input;
  const items = readQueue(evolutionDir);
  const runs = listRuns(evolutionDir, SCAN_LIMIT);
  const panel = collectPanelState({ evolutionDir });
  // 每个 run 只允许出现在一个 tab：先按「已采纳 > 已结束 > 待落盘 > 待处理」顺位算归属，
  // 再把低顺位里的重复项剔掉（判据唯一事实在 ./tab-origin.ts，别在这里另写一套）
  const originInputs = new Map<string, { queue?: (typeof items)[number]; runStatus?: string; hasProposal: boolean }>();
  const hasProposal = (runId: string): boolean =>
    fs.existsSync(path.join(evolutionDir, "runs", runId, "02-proposal.json"));
  for (const item of items) {
    originInputs.set(item.runId, {
      ...(originInputs.get(item.runId) ?? { hasProposal: hasProposal(item.runId) }),
      queue: item,
    });
  }
  for (const run of runs) {
    originInputs.set(run.runId, {
      ...(originInputs.get(run.runId) ?? { hasProposal: hasProposal(run.runId) }),
      runStatus: run.status,
    });
  }
  const tabOf = (runId: string): RunTab =>
    originOfRun({ runId, runRelDir: `runs/${runId}`, ...(originInputs.get(runId) ?? {}) }).tab;
  const inTab = (...tabs: RunTab[]) => (runId: string) => tabs.includes(tabOf(runId));

  const applied = buildApplied(items, evolutionDir);
  const done = buildDone(items, runs, evolutionDir).filter((item) => !inTab("applied")(item.runId));
  const approvals = buildApprovals(evolutionDir, items).filter((item) =>
    inTab("approvals")(item.runId),
  );
  const pending = buildPending(items, runs, evolutionDir, deps).filter((item) =>
    inTab("pending")(item.runId),
  );
  return {
    pending,
    approvals,
    applied,
    done,
    summary: {
      reviewing: panel.reviewing,
      stale: panel.staleCount,
      pendingApprovals: panel.pendingApprovals,
      appliedTotal: items.filter((item) => item.status === "applied").length,
      rollbackRate: panel.rollbackRate,
    },
  };
}
