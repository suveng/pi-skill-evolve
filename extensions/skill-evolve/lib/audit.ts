/**
 * `/skill-audit`：把遥测里的归因记录、历史 missed、硬禁令现扫结果汇总成一份人读文本。
 *
 * 两个原则：
 * 1. 只报事实 —— attributed 事件是 M2 之后写的；M2 之前的历史 missed 没有类别，
 *    要么用当前快照现算（并标注「现算」），要么老实列进「未归因」，绝不把两者混成一份数字；
 * 2. 加载率必须带注解 —— 「读了 description 就照做」「读了文件没照做」都不在「读文件」这条证据链里，
 *    单看加载率会把最有用的技能判成最没用的。
 */
import {
  CATEGORY_ORDER,
  DISPOSITIONS,
  type AttributionCategory,
  type ExposedSkill,
} from "./attribution.ts";
import { splitHits } from "./baseline.ts";
import type { HardRuleHit } from "./hard-rules.ts";
import { summarize, type MissedStat, type TelemetryEvent, type TelemetrySkill, type TelemetrySummary } from "./telemetry.ts";

export interface AuditCategoryRow {
  category: AttributionCategory;
  label: string;
  count: number;
  skills: { skill: string; count: number }[];
}

export interface AuditModel {
  days: number;
  summary: TelemetrySummary;
  rows: AuditCategoryRow[];
  /** 一个归因记录都没有的历史 missed（M2 之前采集的数据），不硬编类别 */
  unattributed: MissedStat[];
  conflicts: HardRuleHit[];
  /** 存量债指纹：命中的算存量（设计稿 10.4 已接受），其余算新增 */
  knownFingerprints: ReadonlySet<string>;
  invalidRules: string[];
  /** 归因条数来源统计：遥测里已有的 / 用当前快照现算的 */
  fromTelemetry: number;
  fromLive: number;
}

export const AUDIT_LOAD_RATE_NOTE = "加载率低 ≠ 技能没用：只读 description 就照做、读了文件却没照做，这两类都不在「读文件」这条证据链里。";

/** 存量只列前几条：它们不是失败信号，列多了反而淹没真正要看的新增 */
const STOCK_PREVIEW = 5;
const SKILLS_PER_CATEGORY = 6;
const LABEL_WIDTH = 15;
const CATEGORY_WIDTH = 8;

/** 中文按 2 列宽计算：不然 padEnd 出来的表格在终端里必错位 */
function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) width += /[\u3000-\u9fff\uff00-\uffef]/.test(char) ? 2 : 1;
  return width;
}

function padTo(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - displayWidth(text)));
}

function asCategory(value: unknown): AttributionCategory | null {
  return typeof value === "string" && (CATEGORY_ORDER as readonly string[]).includes(value)
    ? (value as AttributionCategory)
    : null;
}

function countMissed(events: readonly TelemetryEvent[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const event of events) {
    if (event.kind !== "missed") continue;
    const skill = typeof event.skill === "string" && event.skill.length > 0 ? event.skill : "(未知)";
    counts.set(skill, (counts.get(skill) ?? 0) + 1);
  }
  return counts;
}

/** 最近一次 advertised 里的技能快照：给现算归因提供 filePath / disabled */
export function exposedFromEvents(events: readonly TelemetryEvent[]): ExposedSkill[] {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.kind !== "advertised" || !Array.isArray(event.skills)) continue;
    return (event.skills as TelemetrySkill[])
      .filter((skill) => typeof skill?.name === "string")
      .map((skill) => ({ name: skill.name, filePath: skill.filePath ?? "", disabled: skill.disabled === true }));
  }
  return [];
}

/** 最近一次 advertised 记下的 activeTools；没有记录就返回空（空 = 不知道，不能拿来判 E） */
export function activeToolsFromEvents(events: readonly TelemetryEvent[]): string[] {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.kind !== "advertised") continue;
    if (!Array.isArray(event.activeTools)) return [];
    return (event.activeTools as unknown[]).filter((tool): tool is string => typeof tool === "string");
  }
  return [];
}

export function buildAuditModel(input: {
  days: number;
  events: readonly TelemetryEvent[];
  /** 给历史 missed 现算类别的回调；不给就把它们全列进「未归因」 */
  classify?: (skill: string) => AttributionCategory;
  conflicts: readonly HardRuleHit[];
  knownFingerprints?: ReadonlySet<string>;
  invalidRules: readonly string[];
}): AuditModel {
  const counted = new Map<AttributionCategory, Map<string, number>>();
  const add = (category: AttributionCategory, skill: string, amount: number): void => {
    const bucket = counted.get(category) ?? new Map<string, number>();
    bucket.set(skill, (bucket.get(skill) ?? 0) + amount);
    counted.set(category, bucket);
  };

  const covered = new Set<string>();
  let fromTelemetry = 0;
  for (const event of input.events) {
    if (event.kind !== "attributed") continue;
    const skill = typeof event.skill === "string" ? event.skill : "";
    const category = asCategory(event.category);
    if (skill.length === 0 || category === null) continue;
    covered.add(skill);
    add(category, skill, 1);
    fromTelemetry += 1;
  }

  let fromLive = 0;
  const unattributed: MissedStat[] = [];
  const misses = countMissed(input.events);
  for (const [skill, count] of misses) {
    if (covered.has(skill)) continue;
    if (input.classify !== undefined) {
      add(input.classify(skill), skill, count);
      fromLive += count;
    } else {
      unattributed.push({ skill, count });
    }
  }
  unattributed.sort((a, b) => b.count - a.count || a.skill.localeCompare(b.skill));

  const rows: AuditCategoryRow[] = CATEGORY_ORDER.map((category) => {
    const bucket = counted.get(category) ?? new Map<string, number>();
    const skills = [...bucket.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, SKILLS_PER_CATEGORY)
      .map(([skill, count]) => ({ skill, count }));
    const count = [...bucket.values()].reduce((sum, value) => sum + value, 0);
    return { category, label: DISPOSITIONS[category].label, count, skills };
  });

  return {
    days: input.days,
    summary: summarize(input.events),
    rows,
    unattributed,
    conflicts: [...input.conflicts],
    knownFingerprints: input.knownFingerprints ?? new Set<string>(),
    invalidRules: [...input.invalidRules],
    fromTelemetry,
    fromLive,
  };
}

/** 冲突段两段式：存量（已接受）只列前几条，新增才是本次要处理的失败信号 */
function renderConflicts(model: AuditModel): string[] {
  if (model.conflicts.length === 0) return ["  P0 命中 0 条（存量 0 / 新增 0）"];
  const { stock, added } = splitHits(model.conflicts, model.knownFingerprints);
  const line = (tag: string, hit: HardRuleHit): string =>
    `    ${tag}  ${hit.ruleId}  ${hit.skill}:${hit.line}  ${hit.level}  「${hit.quote}」`;
  const stockShown = stock.slice(0, STOCK_PREVIEW);
  return [
    `  P0 命中 ${model.conflicts.length} 条：存量（baseline）${stock.length} 条 · 新增 ${added.length} 条`,
    ...(added.length === 0 ? [] : [...added.map((hit) => line("新增", hit))]),
    ...(stock.length === 0 ? [] : ["  存量（已接受的存量债，只列前 5 条）："]),
    ...stockShown.map((hit) => line("存量", hit)),
    ...(stock.length > stockShown.length ? [`    存量其余 ${stock.length - stockShown.length} 条略`] : []),
    ...(added.length === 0 ? [] : ["  新增命中：修掉它，或确认无害后跑 /skill-evolve baseline 接受"]),
  ];
}

export function auditText(model: AuditModel): string {
  const { summary } = model;
  const percent = `${(summary.loadRate * 100).toFixed(1)}%`;
  const rate = summary.advertised > 0 ? percent : "无曝光数据";
  const total = model.rows.reduce((sum, row) => sum + row.count, 0);

  const categoryLines = model.rows.flatMap((row) => {
    const head = `  ${padTo(row.category, CATEGORY_WIDTH)} ${padTo(row.label, LABEL_WIDTH)} ${String(row.count).padStart(4)}`;
    const detail = row.skills.map((item) => `      - ${item.skill} × ${item.count}`);
    return [head, ...detail];
  });

  const categoryHeader = total === 0
    ? `按类别（近 ${model.days} 天没有可归因的未命中）：`
    : "按类别（顺序即设计稿第八章决策树，命中即停）：";

  const conflictLines = renderConflicts(model);

  return [
    `技能进化 · 机械审计（近 ${model.days} 天）`,
    `  曝光：${summary.rounds} 轮 / ${summary.advertised} 次 · 加载 ${summary.loaded} 次（读取失败 ${summary.failed} 次）· 加载率 ${rate}`,
    `  归因来源：遥测 attributed ${model.fromTelemetry} 条 ＋ 当前快照现算 ${model.fromLive} 条`,
    categoryHeader,
    ...categoryLines,
    ...(model.unattributed.length === 0
      ? []
      : [
          `未归因（M2 之前的历史 missed，没有类别记录）：${model.unattributed.length} 个技能`,
          ...model.unattributed.slice(0, 10).map((item, index) => `  ${index + 1}. ${item.skill} × ${item.count}`),
        ]),
    ...(summary.missedTop.length === 0
      ? []
      : ["未命中 top：", ...summary.missedTop.map((item, index) => `  ${index + 1}. ${item.skill} × ${item.count}`)]),
    `机械冲突（现扫 .pi/skills，规则 .pi/evolution/rules/hard-rules.json）：`,
    ...conflictLines,
    ...(model.invalidRules.length === 0 ? [] : ["规则不可用：", ...model.invalidRules.map((item) => `  - ${item}`)]),
    "",
    `注意：${AUDIT_LOAD_RATE_NOTE}`,
  ].join("\n");
}
