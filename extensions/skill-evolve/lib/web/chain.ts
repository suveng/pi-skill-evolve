/**
 * 列表行里的「状态链」：派发 · 分析 · 提案 · 评审 · 采纳 五段，一眼看出这条 run 卡在哪。
 *
 * 为什么要有它（2026-11-11 用户：「现在这个管理面板，它的状态流转我其实看得不是特别清晰」）：
 * 原来每行只有一个状态徽章（复盘中 / 待评审 / 待落盘），同一个徽章后面可能是「在跑」「卡死五分钟了」
 * 「提案出来了但督导没接上」三种完全不同的处境；想分清必须点进详情页看流水线块。
 *
 * 三条约定：
 * 1. **只由记录推导**：入参只有 run.json 的 status 与队列条目，不猜、不读进程表（那是 pending.ts 的事）。
 * 2. **每一步只有五种状态**：done / running / waiting / dead / skipped —— 颜色与符号固定，
 *    同一符号在不同页含义一致（`✗` 永远是「卡住或已被否，要人看」）。
 * 3. **不写「下一步」以外的建议**：`nextStepText` 只说该做什么，不解释为什么（原因在详情页的归属块里）。
 */

/** 五段的固定顺序与名字：改这里就等于改全站的状态链 */
export const CHAIN_STEPS = ["派发", "分析", "提案", "评审", "采纳"] as const;

export type ChainState = "done" | "running" | "waiting" | "dead" | "skipped";

export interface ChainStep {
  label: string;
  state: ChainState;
}

export interface ChainInput {
  /** run.json 的 status（读不到就传 undefined） */
  status?: string;
  /** 队列里这条 run 是 pending 吗（决定「采纳」段是不是在等人点） */
  queuedPending?: boolean;
}

/** 符号固定：done ✓ · running … · waiting · · dead ✗ · skipped – */
const MARKS: Record<ChainState, string> = {
  done: "✓",
  running: "…",
  waiting: "·",
  dead: "✗",
  skipped: "–",
};

function steps(states: ChainState[]): ChainStep[] {
  return CHAIN_STEPS.map((label, index) => ({ label, state: states[index] ?? "waiting" }));
}

/** 走完全程：派发/分析/提案/评审都成，采纳也落了 */
const ALL_DONE: ChainState[] = ["done", "done", "done", "done", "done"];

/**
 * 由 run 状态推导五段状态。
 *
 * 分档依据（每档都来自真实出现过的状态，见 done.ts 的终态清单）：
 * - dispatched / stale：还在派发后的分析段，stale = 子进程没了又过了收口窗口
 * - analyzed：分析完成；有没有提案决定第三段是 done 还是 skipped（判定不需要改就 skipped）
 * - proposed：提案出来了，评审还没跑（督导没接上时会长这样）
 * - reviewed：评审完成；队列 pending = 采纳段等人点，否则等人重新入队
 * - rejected / review_failed：评审段 dead
 * - failed / abandoned / unauthorized_write：都能发生在采纳前，统一标在评审段之后
 * - rolled-back：采纳段 dead（落盘后又回滚）
 */
export function chainOf(input: ChainInput): ChainStep[] {
  const { status, queuedPending } = input;
  switch (status) {
    case "dispatched":
      return steps(["done", "running", "waiting", "waiting", "waiting"]);
    case "stale":
      return steps(["done", "dead", "waiting", "waiting", "waiting"]);
    case "analyzed":
      // 没有提案时分析 Agent 判定「不需要改」，提案段记为 skipped（不是失败）
      return steps(["done", "done", "done", "skipped", "skipped"]);
    case "proposed":
      return steps(["done", "done", "done", "waiting", "waiting"]);
    case "reviewed":
      return steps(["done", "done", "done", "done", queuedPending ? "waiting" : "waiting"]);
    case "applied":
      return steps(ALL_DONE);
    case "rejected":
    case "review_failed":
      return steps(["done", "done", "done", "dead", "waiting"]);
    case "rolled-back":
      return steps(["done", "done", "done", "done", "dead"]);
    case "failed":
    case "superseded":
    case "abandoned":
    case "unauthorized_write":
      return steps(["done", "done", "done", "dead", "waiting"]);
    default:
      // 读不到 run.json：只点亮第一段，其余留空等，别假装知道进度
      return steps(["done", "waiting", "waiting", "waiting", "waiting"]);
  }
}

/** 把五段渲染成一行小字；`title` 写全名，符号本身不解释 */
export function chainHtml(chain: readonly ChainStep[]): string {
  const parts = chain.map(
    (step) => `<span class="c-${step.state}" title="${step.label}">${step.label}${MARKS[step.state]}</span>`,
  );
  return `<span class="chain">${parts.join("")}</span>`;
}

/**
 * 这一行的「下一步」一句话（列表里不再让用户自己去猜）。
 * 只讲动作，不讲原因；讲不出确定动作时给「等它自己走」，不要编。
 */
export function nextStepText(input: ChainInput): string {
  const { status, queuedPending } = input;
  switch (status) {
    case "dispatched":
      return "等它跑完";
    case "stale":
      return "重跑或清理";
    case "analyzed":
      return "不用管（判定不需要改）";
    case "proposed":
      return "等督导接上；急就点重跑";
    case "reviewed":
      return queuedPending ? "待落盘点批准" : "提案未入队，点重跑";
    case "applied":
      return "已落盘";
    case "rejected":
    case "review_failed":
      return "被否，看评审意见";
    case "rolled-back":
      return "已回滚，看五闸";
    case "failed":
    case "superseded":
    case "abandoned":
    case "unauthorized_write":
      return "终态，不用管";
    default:
      return "等它自己走";
  }
}
