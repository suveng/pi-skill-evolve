/**
 * 列表行的渲染：五种视图（待处理 / 待落盘 / 已采纳 / 已结束）先各自映射成同一份 `ListRow`，
 * 再由这里的表格与分组渲染成 HTML。
 *
 * 为什么分两步：五个视图的数据字段不同（提议数在 applied、verdict 在 approvals、findings 在 reports），
 * 但「一行长什么样」必须完全一致 —— 否则同一个人在两页看到的徽章颜色与操作位置都不一样。
 * 映射（本文件的 `xxxRows`）负责取数与措辞，渲染（./render-table.ts）负责表格、分组。
 * 拆两个文件是因为「取数」与「画表」各自都会长；合在一起必然破 300 行。
 *
 * 三条取舍：
 * 1. **不再把 runId 当主标识**：真实数据里同一个会话的 9 条 run 前 8 位完全一样（`354df7db…`），
 *    拿它当抬头等于每行都在报同一串字符。runId 只留在操作列里，显示末 8 位、`title` 放完整值。
 * 2. **操作是小号链接，不是每行两个大按钮**：一行一条 run，按钮比信息显眼就本末倒置了。
 * 3. **同一会话的多条 run 收进一个 `<details>`**：9 条 run 逐行重复「重跑 / 日志」正是原来列表被压没的原因。
 */
import { chainHtml, chainOf, nextStepText } from "./chain.ts";
import type { AppliedItem, ApprovalItem, DoneItem, PendingItem, WebView } from "./data.ts";
import type { SessionRef } from "./run-session.ts";
import { escapeHtml } from "./text.ts";

/** 行内操作需要的上下文：csrf 与 canWrite 决定按钮渲不渲染，view 决定动作做完回哪一页 */
export interface RowContext {
  csrf: string;
  writable: boolean;
  view: WebView;
  /** 现时：决定时间列写 `19:35` 还是 `11-07 18:24` */
  now: number;
}

/** 徽章颜色：同一个概念全站一色（灰=排队、蓝=等人、黄=在跑、绿=落地、红=卡死、暗红=被拒、淡灰=归档） */
export type BadgeTone = "gray" | "blue" | "green" | "red" | "yellow" | "darkred" | "faint";

export interface ListRow {
  runId: string;
  /** 状态徽章：`title` 放不能进表格的次要事实（五闸结论 / 层级 / 目标文件 / 失败原因） */
  badge: { text: string; tone: BadgeTone; title: string };
  /** 该条自己的时间；null 表示读不到（时间列写「—」，不拿别的字段冒充） */
  at: number | null;
  skill: string;
  /** 提案改动行数；没有提案（还没出稿）就是 null，列里写「—」 */
  delta: { type: string; added: number; removed: number } | null;
  session: SessionRef;
  /** 操作列（已转义的 HTML 片段） */
  ops: string;
  /** 要不要人动手：组标题的「N 条需要处理」靠它算 */
  needsAction: boolean;
  /** 五段状态链（已转义的 HTML）：派发 ✓ 分析 ✓ 提案 ✓ 评审 · 采纳 · */
  chain?: string;
  /** 这一行「下一步该做什么」的一句话（不解释原因，原因在详情页） */
  next?: string;
}

/** 由 run 状态拼好的状态链 + 下一步文案：四个视图共用，避免各写一份映射 */
function chainBits(status: string | undefined, queuedPending = false): Pick<ListRow, "chain" | "next"> {
  const chain = chainOf({ status, queuedPending });
  return { chain: chainHtml(chain), next: nextStepText({ status, queuedPending }) };
}

/** 待处理条目 → run 状态：待处理页拿不到 run.json 状态时按 kind 反推（kind 本身就是状态派生的） */
const PENDING_STATUS: Record<PendingItem["kind"], string> = {
  running: "dispatched",
  stale: "stale",
  "to-review": "proposed",
  reviewed: "reviewed",
  approval: "reviewed",
};

/** 详情链接：文字是 runId 末 8 位，`title` 是完整 runId（真实数据前 8 位全同，只能靠尾巴区分） */
function detailLink(runId: string): string {
  const href = escapeHtml(`/?view=run&runId=${encodeURIComponent(runId)}`);
  // runId 只放 title 与详情页：末 8 位混在操作列里（详情 …94137752 · 重跑 · 日志）看着像乱码
  return `<a class="rid" href="${href}" title="${escapeHtml(runId)}">详情</a>`;
}

function logLink(runId: string): string {
  return `<a href="${escapeHtml(`/log?runId=${encodeURIComponent(runId)}`)}">日志</a>`;
}

/** 一个 `/action` 表单：csrf / name / runId / view 全走 hidden，按钮就是提交键 */
function actionForm(name: "rerun" | "cleanup" | "review", runId: string, ctx: RowContext, label?: string): string {
  const text = label ?? (name === "rerun" ? "重跑" : name === "review" ? "重试评审" : "清理");
  const title =
    name === "rerun"
      ? "重跑这条 run（花 token）"
      : name === "review"
        ? "提案已写出但督导没评：补起一次评审（沿用同一套评审逻辑）"
        : "移到 runs/.trash/，不会删数据";
  return `<form method="post" action="/action">
<input type="hidden" name="csrf" value="${escapeHtml(ctx.csrf)}">
<input type="hidden" name="name" value="${name}">
<input type="hidden" name="runId" value="${escapeHtml(runId)}">
<input type="hidden" name="view" value="${ctx.view}">
<button type="submit" title="${title}">${text}</button>
</form>`;
}

/**
 * 待处理 / 复盘报告的行操作：详情 + 重跑（+ 卡死时的清理）+ 日志。
 * 清理只给 `stale`：非卡死的 run 还在写盘，把目录移走等于抽掉活进程的 cwd。
 * 重跑只在可写面板出现 —— 只读面板给一个点了没反应的按钮等于骗人。
 */
function activeOps(runId: string, ctx: RowContext, stale: boolean, allowReview = false): string {
  const parts = [detailLink(runId)];
  if (ctx.writable) {
    // 督导崩掉时 run 会永远停在 proposed：给一条自己补刀的路，别让人只能干等
    if (allowReview) parts.push(actionForm("review", runId, ctx, "重试评审"));
    parts.push(actionForm("rerun", runId, ctx));
    if (stale) parts.push(actionForm("cleanup", runId, ctx));
  }
  parts.push(logLink(runId));
  return parts.join(" · ");
}

/**
 * 档案类（已采纳 / 已处理）的操作：只有详情与日志。
 * 一个已采纳的 run 旁边放「重跑」，只会让人以为它能重放整个采纳流程。
 */
function archiveOps(runId: string): string {
  return `${detailLink(runId)} · ${logLink(runId)}`;
}

/** 一个审批动作：csrf 与 runId 都走 hidden，按钮就是提交键 */
function approvalForm(action: "approve" | "reject", item: ApprovalItem, csrf: string): string {
  const label = action === "approve" ? "批准" : "拒绝";
  return `<form method="post" action="/${action}">
<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
<input type="hidden" name="runId" value="${escapeHtml(item.runId)}">
<button type="submit"${action === "reject" ? ' class="reject"' : ""}>${label}</button>
</form>`;
}

/** 待处理：五种 kind 各一个徽章；「待评审 / 待入队」是灰的（它们在排队，不需要人动手） */
export function pendingRows(items: readonly PendingItem[], ctx: RowContext): ListRow[] {
  const badge: Record<PendingItem["kind"], { text: string; tone: BadgeTone }> = {
    running: { text: "复盘中", tone: "yellow" },
    approval: { text: "待落盘", tone: "blue" },
    stale: { text: "卡死", tone: "red" },
    "to-review": { text: "待评审", tone: "gray" },
    reviewed: { text: "待入队", tone: "gray" },
  };
  return items.map((item) => ({
    runId: item.runId,
    badge: { ...badge[item.kind], title: item.detail },
    at: item.at,
    skill: item.skill,
    delta: null,
    session: item.session,
    ops: activeOps(item.runId, ctx, item.kind === "stale", item.kind === "to-review"),
    needsAction: item.kind === "stale" || item.kind === "approval" || item.kind === "to-review",
    ...chainBits(PENDING_STATUS[item.kind]),
  }));
}

/** 已处理：终态各一色；被拒绝是暗红（是结论，不是故障），失败才标题红色
 * 键必须与 run.json / 队列里的 status 一字不差：抄错一个字符（比如 rolledback）徽章就永远匹配不上，
 * 页面上会回落到淡灰 + 原始英文，而不是中文文案。 */
export function doneRows(items: readonly DoneItem[], ctx?: RowContext): ListRow[] {
  const tone: Record<string, { text: string; tone: BadgeTone }> = {
    applied: { text: "已采纳", tone: "green" },
    rejected: { text: "已拒绝", tone: "darkred" },
    failed: { text: "失败", tone: "red" },
    "rolled-back": { text: "已回滚", tone: "faint" },
    superseded: { text: "已被取代", tone: "faint" },
    // 评审器自己出问题：是故障，不是结论，所以给红（同 failed），不给暗红
    review_failed: { text: "评审失败", tone: "red" },
    // 提案者没下文 / 放弃：没发生坏事，用淡灰
    abandoned: { text: "已放弃", tone: "faint" },
    // 分析判定不需要改：不是故障，也不该把英文状态名直接甩给人看
    analyzed: { text: "不需要改", tone: "faint" },
    // 越权写入是纪律事故，必须红
    unauthorized_write: { text: "越权写入", tone: "red" },
  };
  return items.map((item) => ({
    runId: item.runId,
    badge: { ...(tone[item.status] ?? { text: item.status, tone: "faint" as BadgeTone }), title: item.detail },
    at: item.at,
    skill: item.skill,
    delta: null,
    session: item.session,
    ops: supersededOps(item, ctx),
    needsAction: false,
    ...chainBits(item.status),
  }));
}

/**
 * 已结束行的操作：普通终态只给详情；**被顶掉的**多一个「换成这份」——
 * 原来只能看到 superseded 徽章，既不知道为什么被顶、也没法改主意（2026-11-11 用户实测追问）。
 */
function supersededOps(item: DoneItem, ctx: RowContext | undefined): string {
  const base = archiveOps(item.runId);
  if (item.status !== "superseded" || !ctx?.writable) return base;
  const form = `<form method="post" action="/replace">
<input type="hidden" name="csrf" value="${escapeHtml(ctx.csrf)}">
<input type="hidden" name="runId" value="${escapeHtml(item.runId)}">
<button type="submit" title="旧的待落盘条目让位，改为等这份">换成这份</button>
</form>`;
  return `${form} · ${base}`;
}

/** 五闸一句话：没记录时写「无记录」而不是「失败」（判不了 ≠ 没过） */
function gateText(item: AppliedItem): string {
  if (item.gatesOk === null) return "五闸：无记录";
  const failed = item.gates.filter((gate) => !gate.ok).length;
  return failed === 0 ? "五闸：全 ok" : `五闸：${failed} 项失败`;
}

/** 已采纳：技能 · 提案类型 · +N/-M · 采纳时间 · 五闸结论（用户要的就是这五个字段） */
export function appliedRows(items: readonly AppliedItem[]): ListRow[] {
  return items.map((item) => ({
    runId: item.runId,
    badge: { text: "已采纳", tone: "green", title: `${item.level} 级 · ${gateText(item)}` },
    at: item.appliedAt,
    skill: item.skill,
    delta: { type: item.type, added: item.added, removed: item.removed },
    session: item.session,
    ops: archiveOps(item.runId),
    needsAction: false,
    ...chainBits("applied"),
  }));
}

/** 待落盘：每条都要人动手，所以整页 `needsAction` 全是 true */
export function approvalRows(items: readonly ApprovalItem[], ctx: RowContext): ListRow[] {
  return items.map((item) => {
    const ops = ctx.writable
      ? `${approvalForm("approve", item, ctx.csrf)} · ${approvalForm("reject", item, ctx.csrf)} · ${detailLink(item.runId)}`
      : detailLink(item.runId);
    const facts = [
      item.level === "auto" ? "auto 级（自动采纳关着，要你点）" : `${item.level} 级（必须人批）`,
      `目标：${item.targets.join("、") || "（未写 targets）"}`,
      item.review ? `评审：verdict=${item.review.verdict ?? "（未写）"} · blocking ${item.review.blocking} 条` : "评审：读不到 03-review.json",
    ].join(" · ");
    return {
      runId: item.runId,
      badge: { text: "待落盘", tone: "blue", title: facts },
      at: item.createdAt,
      skill: item.skill,
      delta: item.proposal
        ? { type: item.proposal.type, added: item.proposal.added, removed: item.proposal.removed }
        : null,
      session: item.session,
      ops,
      needsAction: true,
      ...chainBits("reviewed", true),
    };
  });
}


