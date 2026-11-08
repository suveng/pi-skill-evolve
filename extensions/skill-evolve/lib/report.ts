/**
 * `/skill-evolve status|report` 的纯文本渲染（无 IO，序列化口径集中在这里）。
 *
 * 拆出来是为了把 evolution.ts 压在 300 行以内：那边只管读盘与状态，
 * 这里只管「拿到数据怎么排版」，所以本文件能被单测直接喂假数据。
 */
import type { EvolutionConfig } from "./config.ts";
import type { DispatchOutcome } from "./dispatch.ts";
import { flagStateText, TELEMETRY_OFF_WARNING, telemetryOffWhileEnabled } from "./flags.ts";
import type { ProposalSummary } from "./proposal.ts";
import type { RunReview, RunSummary } from "./runs.ts";
import type { StaleRun } from "./stale.ts";
import { UNTRUSTED_NOTE, type SelftestReport } from "./selftest.ts";
import type { TelemetrySummary } from "./telemetry.ts";

/** 提案摘要：只显示不应用（M3 只生成提案，评审/应用不在本版） */
function proposalText(proposal: ProposalSummary): string {
  const size = proposal.added + proposal.removed > 0 ? ` +${proposal.added}/-${proposal.removed}` : "";
  return `｜提案 ${proposal.type} ${proposal.skill} [${proposal.status}]${size}`;
}

/** 评审摘要：结论 + 建议动作；同模型自评单独标出来，避免被当成独立复核 */
function reviewText(review: RunReview): string {
  const verdict = review.verdict ? `/${review.verdict}` : "";
  const model = review.sameModel ? "｜同模型自评" : "";
  return `｜评审 ${review.status}${verdict}（建议 ${review.action ?? "无"}${model}）`;
}

function runLine(run: RunSummary): string {
  const extra = `${run.proposal ? proposalText(run.proposal) : ""}${run.review ? reviewText(run.review) : ""}`;
  return `    ${run.runId}  ${run.status}  ${stamp(run.dispatchedAt)}${extra}`;
}

/** 自检红字：没过就把流水线停用这件事顶到 status 的最前面 */
function selftestLine(selftest: SelftestReport | undefined): string[] {
  if (!selftest) return ["  自检：还没跑过（/skill-evolve selftest）"];
  if (!selftest.passed) return [`  【红】${UNTRUSTED_NOTE}`];
  return [`  自检：通过（${selftest.atIso}）`];
}

/** 时间戳统一按 ISO 输出；null 表示历史 run 缺字段，不要伪造成当前时间 */
function stamp(ts: number | null): string {
  return ts ? new Date(ts).toISOString() : "时间未知";
}

/** runId 前半段就是会话哈希：状态行只留它，否则一条就占满整行 */
export function shortRunId(runId: string): string {
  return runId.split("-")[0] ?? runId;
}

/** 超长日志行截断：状态行不能被一行 panic 撞满 */
function elide(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * 卡死条目：`卡死 1 条：354df7db（child-exited，日志最后一行：…）`。
 * 行内就要带原因与最后一句日志 —— “复盘失败”四个字本身没法定位问题。
 */
function staleLine(runs: readonly StaleRun[]): string[] {
  if (runs.length === 0) return [];
  // 同一会话可能派生多条 run（runId 前缀就是会话哈希）：撞车时退回完整 runId，免得两条长得一模一样
  const prefixCount = new Map<string, number>();
  for (const run of runs) {
    const key = shortRunId(run.runId);
    prefixCount.set(key, (prefixCount.get(key) ?? 0) + 1);
  }
  const items = runs.map((run) => {
    const short = shortRunId(run.runId);
    const id = (prefixCount.get(short) ?? 0) > 1 ? run.runId : short;
    const tail = run.lastLine === null ? "无日志（child.log 不存在或为空）" : elide(run.lastLine, 80);
    return `${id}（${run.reason}，日志最后一行：${tail}）`;
  });
  return [`  卡死 ${runs.length} 条：${items.join("，")}`];
}

export interface StatusInput {
  config: EvolutionConfig;
  /** 配置文件路径，让用户知道 on/off 改的是哪个文件 */
  configPath: string;
  telemetryDir: string;
  /** undefined = 锁空闲；null = 锁在但 owner.json 读不出 pid */
  lockPid: number | null | undefined;
  /** 活着的 Web 面板（locks/web.json 且 pid 存活）；null/undefined 都表示不显示这一行 */
  webPanel?: { url: string; pid: number } | null;
  runs: RunSummary[];
  /** 已判卡死的 run（lib/stale.ts）：有就单列一行，带原因与日志尾部 */
  staleRuns?: StaleRun[];
  selftest?: SelftestReport;
}

/**
 * 开关行：采集 / 复盘 / 评审 / 采纳四段各自写。四个字段本来就是独立的，合成一句「已开」只会让人
 * 以为只有一个总开关；「只开复盘不采集」这个组合再补一句警告 —— 归因靠遥测，缺了就不能静默。
 */
export function switchLine(config: EvolutionConfig): string {
  const line = `${flagStateText(config)}（collect / dispatch / review / apply 单独控制；on / off 批量切）`;
  return telemetryOffWhileEnabled(config.enabled, config.telemetry) ? `${line} ⚠ ${TELEMETRY_OFF_WARNING}` : line;
}

/** Web 面板一行：只在记录活着时出现，死记录当作没起过（清理动作别照着它动手） */
function webPanelLine(panel: { url: string; pid: number } | null | undefined): string[] {
  return panel ? [`  Web 面板：${panel.url}（pid ${panel.pid}）`] : [];
}

export function renderStatus(input: StatusInput): string {
  const { config, lockPid } = input;
  const lockText =
    lockPid === undefined ? "空闲" : `持有中（pid ${lockPid ?? "未知"}）`;
  return [
    "技能进化 · 状态",
    `  ${switchLine(config)}`,
    `  配置：${input.configPath}（不存在即默认只开自动评审，采集 / 复盘 / 采纳关）· 遥测目录：${input.telemetryDir}`,
    `  去抖 ${Math.round(config.idleMs / 1000)}s · 单 run 上限 ${Math.round(config.maxRuntimeMs / 60_000)}min · 单会话派生上限 ${config.perSessionCap}`,
    `  锁：${lockText}`,
    ...webPanelLine(input.webPanel),
    ...selftestLine(input.selftest),
    ...staleLine(input.staleRuns ?? []),
    ...(input.runs.length === 0
      ? ["  最近 run：无"]
      : ["  最近 run：", ...input.runs.map(runLine)]),
  ].join("\n");
}

/** 报告固定的那句免责：加载率只覆盖「读了文件」这条证据链，读数时别当技能有效性的判决 */
export const LOAD_RATE_NOTE = [
  "注意：加载率低 ≠ 技能没用。只读了 description 就照做、读了文件却没照做，这两类都不在「读文件」这条证据链里；",
  "      结论要配合 runs/<runId>/01-findings.json 一起看。",
];

export interface ReportInput {
  days: number;
  summary: TelemetrySummary;
  runs: RunSummary[];
  selftest?: SelftestReport;
}

export function renderReport(input: ReportInput): string {
  const { summary, days } = input;
  const missed = summary.missedTop;
  return [
    `技能进化 · 近 ${days} 天报告`,
    `  曝光：${summary.rounds} 轮 / ${summary.advertised} 次`,
    `  加载：${summary.loaded} 次（读取失败 ${summary.failed} 次）`,
    `  加载率：${summary.advertised > 0 ? `${(summary.loadRate * 100).toFixed(1)}%` : "无曝光数据"}`,
    ...(missed.length === 0
      ? [`  未命中：${summary.missed} 次`]
      : [
          `  未命中：${summary.missed} 次，top${missed.length}：`,
          ...missed.map((item, index) => `    ${index + 1}. ${item.skill} × ${item.count}`),
        ]),
    ...(input.runs.length === 0
      ? ["  run：无"]
      : ["  run：", ...input.runs.map(runLine)]),
    ...selftestLine(input.selftest),
    ...(input.runs.some((run) => run.proposal)
      ? ["  提案只生成不应用：看 runs/<runId>/02-proposal.json 与 02-proposal.diff（或 candidate/），本版不评审不写入 .pi/skills"]
      : []),
    "",
    ...LOAD_RATE_NOTE,
  ].join("\n");
}

/** 手动 `/skill-evolve run` 的回执：把三种 outcome 翻译成一句人话（CLI 回显用） */
export function renderManualDispatch(outcome: DispatchOutcome): string {
  if (outcome.status === "dispatched") {
    const { runId, pid, runDir } = outcome.run;
    return [`已派生复盘：${runId}（pid ${pid ?? "未知"}）`, `  目录：${runDir}`].join("\n");
  }
  if (outcome.status === "skipped") {
    if (outcome.why === "disabled") return "技能进化总开关是关的：先 /skill-evolve on";
    if (outcome.why === "lock") return `已有复盘在跑（pid ${outcome.ownerPid ?? "未知"}），本次未派发`;
    if (outcome.why === "selftest-failed") return `必红自检未通过，流水线停用：先 /skill-evolve selftest 看哪条坏样本没被拦住`;
    if (outcome.why === "busy") {
      return `已有子进程在跑（pid ${outcome.ownerPid ?? "未知"}），全局同时只允许一个；本次未派发`;
    }
    return `本次未派发：${outcome.why}`;
  }
  return `本轮已在待复盘区间里（累计 ${outcome.rounds} 轮），静默窗口过后会自动补一次`;
}
