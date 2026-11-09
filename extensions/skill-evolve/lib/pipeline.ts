/**
 * 五段流水线：派发 → 分析 → 提案 → 评审 → 采纳。
 *
 * 为什么单列一层：用户看「已分析」四个字永远不知道后台卡在哪一步（2026-11-09 真实困惑：
 * 面板写「已分析」，提案却永远不出现，其实督导崩在 import 阶段）。这里把「一步做什么、
 * 现在到哪一步、卡住时下一步谁来接」摊平成五个格子，面板与 `/tree` 都读同一份结论。
 *
 * 纪律：只看磁盘产物与 pid 存活，**不猜进度**。没有的产物就是没有，缺文件写缺哪个。
 */
import * as fs from "node:fs";
import * as path from "node:path";

/** done=已完成 / running=正在跑 / waiting=等上一步 / blocked=卡住等人或等重启 / failed=失败 / skipped=按配置跳过 */
export type StageState = "done" | "running" | "waiting" | "blocked" | "failed" | "skipped" | "ended";

/**
 * `skipped` 与 `ended` 的区别（用户 2026-11-09：「跳过很奇怪，是不是该加个终态」）：
 * - `skipped`：这一格本来就不跑（开关关着 / 评审驳回了采纳）。流程到此为止没问题。
 * - `ended`：前一格的**结论**就是「没有下一步」（分析判定不需要改），这是正常终态，
 *   不是谁把流程关掉了。混用一个「跳过」会让用户以为漏跑了什么。
 */

export type StageKey = "dispatch" | "analyze" | "propose" | "review" | "apply";

export interface PipelineStage {
  key: StageKey;
  label: string;
  state: StageState;
  /** 一句话说清「这一步现在是什么情况」：谁在跑、缺哪个文件、等谁 */
  detail: string;
  /** 该步完成/开始的时刻：没有就 null（不编时间） */
  at: number | null;
}

export interface Pipeline {
  stages: PipelineStage[];
  /** 第一处不是 done 的说明 + 下一步动作；全 done 时给结论 */
  hint: string;
}

export interface PipelineInput {
  runDir: string;
  /** run.json 的 status */
  status: string;
  pid: number | null;
  supervisorPid: number | null;
  dispatchedAt: number | null;
  /** 采纳队列里这条 run 的状态（pending / applied / rejected …）；不在队列为 null */
  queued?: string | null;
  /** 自动评审 / 自动采纳开关；null = 面板不知道（CLI 上下文）就不下结论 */
  autoReview?: boolean | null;
  autoApply?: boolean | null;
  alive?: (pid: number) => boolean;
}

const LABELS: Record<StageKey, string> = {
  dispatch: "派发",
  analyze: "分析",
  propose: "提案",
  review: "评审",
  apply: "采纳",
};

/** 终态里不该再往后走的那些 */
const DEAD_STATUS = new Set(["stale", "abandoned", "failed", "unauthorized_write"]);

function statOf(file: string): { at: number } | null {
  try {
    const stat = fs.statSync(file);
    return stat.isFile() ? { at: stat.mtimeMs } : null;
  } catch {
    return null;
  }
}

function jsonOf(file: string): Record<string, unknown> | null {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    return typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function textOf(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

/**
 * 五段状态。同一份产物只读一次：这里的判断全在文件系统上，多一次 stat 只是浪费。
 */
export function buildPipeline(input: PipelineInput): Pipeline {
  const alive = input.alive ?? (() => false);
  const dir = input.runDir;
  const findings = statOf(path.join(dir, "01-findings.json"));
  const proposalFile = statOf(path.join(dir, "02-proposal.json"));
  const reviewFile = statOf(path.join(dir, "03-review.json"));
  const decision = statOf(path.join(dir, "04-decision.json"));
  const verify = statOf(path.join(dir, "06-verify.json"));
  const proposal = proposalFile ? jsonOf(path.join(dir, "02-proposal.json")) : null;
  const review = reviewFile ? jsonOf(path.join(dir, "03-review.json")) : null;
  const reviewStatus = review ? textOf(review.status, "未知") : null;
  // 督导等提案超时会写 03-review（status=skipped, reason=proposal-timeout）：
  // 这是那些 run 的真实收尾原因，不能一律说成「分析判定不需要改」。
  const proposalTimeout = reviewStatus === "skipped" && textOf(review?.reason) === "proposal-timeout";
  const dead = DEAD_STATUS.has(input.status);
  const childAlive = input.pid !== null && alive(input.pid);
  const supervisorAlive = input.supervisorPid !== null && alive(input.supervisorPid);

  const stages: PipelineStage[] = [];

  // 1. 派发：run.json 存在就算完成（时间取 dispatchedAt，没有就 null）
  stages.push({
    key: "dispatch",
    label: LABELS.dispatch,
    state: "done",
    detail: input.pid === null ? "已派发（pid 未记）" : childAlive ? `复盘子进程 pid ${input.pid} 在跑` : `复盘子进程 pid ${input.pid} 已退出`,
    at: input.dispatchedAt,
  });

  // 2. 分析：产物是 01-findings.json
  const analyze: PipelineStage = findings
    ? { key: "analyze", label: LABELS.analyze, state: "done", detail: "01-findings.json 已落盘", at: findings.at }
    : dead
      ? { key: "analyze", label: LABELS.analyze, state: "failed", detail: `分析没出结论就结束了（${input.status}）`, at: null }
      : childAlive
        ? { key: "analyze", label: LABELS.analyze, state: "running", detail: `子进程 pid ${input.pid} 正在读会话`, at: null }
        : { key: "analyze", label: LABELS.analyze, state: "waiting", detail: "子进程已退出但没写 01-findings.json（等卡死判定收尾）", at: null };
  stages.push(analyze);

  // 3. 提案：产物是 02-proposal.json（候选 diff 由同一步写入 candidate/）
  const propose: PipelineStage = proposalFile
    ? {
        key: "propose",
        label: LABELS.propose,
        state: "done",
        detail: `${textOf(proposal?.type, "提案")} → ${textOf(proposal?.skill, "未写技能")}`,
        at: proposalFile.at,
      }
    : dead
      ? { key: "propose", label: LABELS.propose, state: "waiting", detail: "分析没走完，没到提案", at: null }
      : childAlive
        ? { key: "propose", label: LABELS.propose, state: "running", detail: "分析在跑，提案随后写", at: null }
        : findings
          ? input.status === "analyzed"
            // 有结论、没提案、子进程也退了：这就是终态（本轮判定「不需要改」），不是「还在等」
            ? {
                key: "propose",
                label: LABELS.propose,
                state: "ended",
                detail: proposalTimeout ? "督导等提案超时：本轮不出提案（终态）" : "分析判定不需要改：本轮不出提案（终态）",
                at: null,
              }
            : {
                key: "propose",
                label: LABELS.propose,
                state: "waiting",
                detail: proposalTimeout ? "督导等提案超时：分析没写提案" : "分析已结束但没写提案（多半是判定「不该改」）",
                at: null,
              }
          : { key: "propose", label: LABELS.propose, state: "waiting", detail: "等分析结论", at: null };
  stages.push(propose);

  // 提案段判成终态（分析结论就是「不需要改」）时，评审/采纳也没有下一步可走：
  // 留着 waiting 会让「下一步」一直催一个永远不会发生的动作。
  const noProposalTerminal = propose.state === "ended";

  // 4. 评审：产物是 03-review.json；有提案但督导不在 = 需要重启恢复接手
  let reviewStage: PipelineStage;
  if (reviewFile) {
    const failed = reviewStatus === "review_failed" || reviewStatus === "error";
    const closed = reviewStatus === "skipped";
    reviewStage = {
      key: "review",
      label: LABELS.review,
      state: failed ? "failed" : closed ? "ended" : "done",
      detail: closed
        ? `${proposalTimeout ? "没等到提案，跳过评审" : "跳过评审"}（${textOf(review?.reason, "无原因")}）`
        : `${reviewStatus}${textOf(review?.verdict) ? ` / ${textOf(review?.verdict)}` : ""}`,
      at: reviewFile.at,
    };
  } else if (proposalFile) {
    reviewStage = supervisorAlive
      ? { key: "review", label: LABELS.review, state: "running", detail: `督导 pid ${input.supervisorPid} 正在评审`, at: null }
      : input.autoReview === false
        ? { key: "review", label: LABELS.review, state: "skipped", detail: "自动评审关着：等人工 /skill-evolve approve", at: null }
        : { key: "review", label: LABELS.review, state: "blocked", detail: "提案在但督导不在：下次会话起点自动重挂", at: null };
  } else if (noProposalTerminal) {
    reviewStage = { key: "review", label: LABELS.review, state: "ended", detail: "没有提案，不需要评审", at: null };
  } else {
    reviewStage = { key: "review", label: LABELS.review, state: "waiting", detail: "等提案出来再评审", at: null };
  }
  stages.push(reviewStage);

  // 5. 采纳：需要 04-decision.json（队列 applied / 五闸）；rejected 的到此为止
  let applyStage: PipelineStage;
  if (decision) {
    applyStage = { key: "apply", label: LABELS.apply, state: "done", detail: "04-decision.json 已写（技能文件已改）", at: decision.at };
  } else if (reviewStatus === "rejected" || input.status === "rejected") {
    applyStage = { key: "apply", label: LABELS.apply, state: "ended", detail: "评审驳回：本轮到此结束，不会采纳", at: null };
  } else if (reviewStatus === "approved" || reviewStatus === "needs_human") {
    applyStage = input.queued === "pending" && input.autoApply !== false
      ? { key: "apply", label: LABELS.apply, state: "running", detail: "队列 pending，自动采纳正在走五闸", at: null }
      : { key: "apply", label: LABELS.apply, state: "blocked", detail: input.autoApply === false ? "自动采纳关着：等面板批准" : "已入队 pending，等采纳扫描", at: null };
  } else if (noProposalTerminal) {
    applyStage = { key: "apply", label: LABELS.apply, state: "ended", detail: "没有提案，不需要采纳", at: null };
  } else if (verify) {
    applyStage = { key: "apply", label: LABELS.apply, state: "blocked", detail: "五闸跑过但没写决定：看 06-verify.json", at: verify.at };
  } else {
    applyStage = { key: "apply", label: LABELS.apply, state: "waiting", detail: "等评审通过", at: null };
  }
  stages.push(applyStage);

  return { stages, hint: hintOf(stages) };
}

/**
 * 「下一步」的挑选顺序：先看**真在跑 / 真卡住 / 真失败**的那一步（用户能立刻行动），
 * 再退回第一处「等上一步」；全 done 时明说结束。只按顺序找第一处会让「分析等收尾」
 * 盖掉「提案在、督导死了」这种更该被看见的状态。
 */
function hintOf(stages: PipelineStage[]): string {
  const first =
    stages.find((stage) => stage.state === "running" || stage.state === "blocked" || stage.state === "failed") ??
    stages.find((stage) => stage.state === "waiting");
  if (!first) {
    const ended = stages.find((stage) => stage.state === "ended");
    if (ended) return `本轮终态：${ended.label}「${ended.detail}」`;
    const skipped = stages.find((stage) => stage.state === "skipped");
    return skipped ? `流程结束：卡在「${skipped.label}」— ${skipped.detail}` : "流程走完：五段全部完成";
  }
  return `下一步「${first.label}」— ${first.detail}`;
}

/** 面板用的一句话：`派发✓ 分析✓ 提案✓ 评审… 采纳·`，一眼看出卡在哪 */
export function renderPipelineLine(pipeline: Pipeline): string {
  const mark: Record<StageState, string> = { done: "✓", running: "…", waiting: "·", blocked: "!", failed: "✗", skipped: "–", ended: "■" };
  return pipeline.stages.map((stage) => `${stage.label}${mark[stage.state]}`).join(" ");
}

/** 把 stages 折成「进度 3/5」这种数字，列表列用 */
export function pipelineProgress(pipeline: Pipeline): { done: number; total: number } {
  // 终态也算「走完了这一格」：进度条不该在正常结束的 run 上永远差一格
  return { done: pipeline.stages.filter((stage) => stage.state === "done" || stage.state === "ended").length, total: pipeline.stages.length };
}
