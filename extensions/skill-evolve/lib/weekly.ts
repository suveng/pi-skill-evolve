/**
 * `/skill-evolve report --week`：一周一句结论的周报（设计稿 14.2 + 10.4）。
 *
 * 术语纪律：能观测的只有「技能文件是否被读取」，所以这份报告里只有**加载率**，
 * 任何地方都不许写成「使用率」（读 ≠ 用，读了没照做也测不到）。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { listSkillDirs } from "./hard-rules.ts";
import { ATTRIBUTION_KEYS } from "./metrics.ts";
import { createReferenceScan } from "./proc.ts";
import { readFrontmatter } from "./proposal.ts";
import { readQueue, type QueueItem } from "./queue.ts";
import { listRuns } from "./runs.ts";
import { ratio, readEvents, type TelemetryEvent, type TelemetrySkill } from "./telemetry.ts";
import { isoWeek } from "./metrics.ts";

/** 零加载候选的判据：近 4 周每周都有曝光、且一次都没被读过 */
export const CANDIDATE_WEEKS = 4;

export interface SkillRef {
  name: string;
  description: string;
}

/** 引用面清单：由 proc.ts 的 rg / 文件探测提供，单测注入假实现 */
export interface ReferenceScan {
  cursorStub: boolean;
  agentsIndex: boolean;
  /** 其它技能 / 文档里提到该技能名的处数 */
  mentions: number;
}

export interface AppliedRun {
  skill: string;
  /** 采纳（或入队）时刻：进化收益的前后 7 天窗口以它为界 */
  at: number;
}

export interface WeeklyInput {
  cwd: string;
  now: number;
  events: readonly TelemetryEvent[];
  runs: readonly { runId: string; status: string; dispatchedAt: number | null }[];
  queue: readonly QueueItem[];
  skills: readonly SkillRef[];
  applied: readonly AppliedRun[];
  referenceScan?: (skill: string) => ReferenceScan;
}

interface SkillWeek {
  advertised: number;
  loaded: number;
}

function weekOf(ts: number): string {
  return isoWeek(ts);
}

function emptyStat(): SkillWeek {
  return { advertised: 0, loaded: 0 };
}

/** 周 → 技能 → 曝光/加载：零加载候选与趋势表都从这张表出 */
function perSkillWeeks(events: readonly TelemetryEvent[]): Map<string, Map<string, SkillWeek>> {
  const table = new Map<string, Map<string, SkillWeek>>();
  const bucket = (week: string, skill: string): SkillWeek => {
    let inner = table.get(week);
    if (!inner) {
      inner = new Map<string, SkillWeek>();
      table.set(week, inner);
    }
    let stat = inner.get(skill);
    if (!stat) {
      stat = emptyStat();
      inner.set(skill, stat);
    }
    return stat;
  };
  for (const event of events) {
    if (typeof event.ts !== "number") continue;
    const week = weekOf(event.ts);
    if (event.kind === "advertised") {
      const skills = Array.isArray(event.skills) ? (event.skills as TelemetrySkill[]) : [];
      for (const skill of skills) {
        if (!skill || typeof skill.name !== "string" || skill.disabled === true) continue;
        bucket(week, skill.name).advertised += 1;
      }
    } else if (event.kind === "loaded" && typeof event.skill === "string") {
      bucket(week, event.skill).loaded += 1;
    }
  }
  return table;
}

function percent(part: number, total: number): string {
  return `${(ratio(part, total) * 100).toFixed(1)}%`;
}

/** 描述重叠度：中文按二元组、英文按词，取 Jaccard；用来区分「真没人用」和「两个技能抢同一件事」 */
export function descriptionOverlap(left: string, right: string): number {
  const tokens = (text: string): Set<string> => {
    const set = new Set<string>();
    for (const word of text.toLowerCase().match(/[a-z0-9]{2,}/g) ?? []) set.add(word);
    const cjk = (text.match(/[\u4e00-\u9fa5]+/g) ?? []).join("");
    for (let index = 0; index + 1 < cjk.length; index += 1) set.add(cjk.slice(index, index + 2));
    return set;
  };
  const a = tokens(left);
  const b = tokens(right);
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared / (a.size + b.size - shared);
}

function topOverlap(skill: SkillRef, all: readonly SkillRef[]): { name: string; score: number } | null {
  let best: { name: string; score: number } | null = null;
  for (const other of all) {
    if (other.name === skill.name) continue;
    const score = descriptionOverlap(skill.description, other.description);
    if (score > 0 && (best === null || score > best.score)) best = { name: other.name, score };
  }
  return best;
}

/** 进化收益：采纳后 7 天该技能加载率相对前 7 天的变化（单位 pp）；任一窗口无曝光 = 样本不足 */
function gainOf(input: WeeklyInput, applied: AppliedRun): string {
  const before = emptyStat();
  const after = emptyStat();
  const day = 86_400_000;
  for (const event of input.events) {
    if (typeof event.ts !== "number") continue;
    const inBefore = event.ts >= applied.at - 7 * day && event.ts < applied.at;
    const inAfter = event.ts >= applied.at && event.ts < applied.at + 7 * day;
    if (!inBefore && !inAfter) continue;
    const isAdvertised = event.kind === "advertised" && Array.isArray(event.skills)
      && (event.skills as TelemetrySkill[]).some((skill) => skill?.name === applied.skill && skill.disabled !== true);
    const target = inBefore ? before : after;
    if (isAdvertised) target.advertised += 1;
    else if (event.kind === "loaded" && event.skill === applied.skill) target.loaded += 1;
  }
  if (before.advertised === 0 || after.advertised === 0) return "样本不足";
  const delta = (ratio(after.loaded, after.advertised) - ratio(before.loaded, before.advertised)) * 100;
  return `${delta >= 0 ? "+" : ""}${delta.toFixed(1)}pp`;
}

export function buildWeeklyReport(input: WeeklyInput): string {
  const table = perSkillWeeks(input.events);
  const currentWeek = weekOf(input.now);
  const lines: string[] = [`技能进化周报：${currentWeek}（工作区：${input.cwd}，只含 .pi/skills）`];

  const weeks = [...table.keys()].sort().slice(-CANDIDATE_WEEKS);
  for (const week of weeks) {
    const stats = [...(table.get(week)?.values() ?? [])];
    const advertised = stats.reduce((sum, stat) => sum + stat.advertised, 0);
    const loaded = stats.reduce((sum, stat) => sum + stat.loaded, 0);
    lines.push(`  ${week}  曝光 ${advertised} · 加载 ${loaded} · 加载率 ${percent(loaded, advertised)}`);
  }

  let advertised = 0;
  let loaded = 0;
  let failed = 0;
  const attribution = new Map<string, number>();
  const conflicts = { p0: 0, p1: 0, stock: 0, added: 0 };
  for (const event of input.events) {
    if (event.kind === "advertised") {
      const skills = Array.isArray(event.skills) ? (event.skills as TelemetrySkill[]) : [];
      advertised += skills.filter((skill) => skill?.disabled !== true).length;
    } else if (event.kind === "loaded") loaded += 1;
    else if (event.kind === "failed") failed += 1;
    else if (event.kind === "attributed" && typeof event.category === "string") {
      attribution.set(event.category, (attribution.get(event.category) ?? 0) + 1);
    } else if (event.kind === "conflict") {
      if (event.level === "P0") conflicts.p0 += 1;
      else if (event.level === "P1") conflicts.p1 += 1;
      if (event.stock === true) conflicts.stock += 1;
      else conflicts.added += 1;
    }
  }

  lines.push(`加载率 ${percent(loaded, advertised)}（加载 ${loaded} / 曝光 ${advertised}）`);
  // 分母是「加载 + 尝试失败」：只除加载数会算出 >100% 的假值
  lines.push(`尝试失败率 ${percent(failed, loaded + failed)}（失败 ${failed} / 尝试 ${loaded + failed}）`);
  const attributionTotal = [...attribution.values()].reduce((sum, count) => sum + count, 0);
  // 只用 metrics 的字母表当唯一事实：新增归因（I 正文 / J 该用没用）自动出现在周报里
  const distribution = ATTRIBUTION_KEYS
    .map((key) => `${key} ${attribution.get(key) ?? 0}`)
    .join(" · ");
  lines.push(`归因分布：${distribution}${attributionTotal === 0 ? "（本次无归因记录）" : ""}`);
  lines.push(`冲突密度：存量 ${conflicts.stock} 条 / 新增 ${conflicts.added} 条（P0 ${conflicts.p0} · P1 ${conflicts.p1}）`);

  // stale = 卡死没出提案，既不是提案也不能算耗掉一次机会，排除在外（否则卡死越多采纳率越低）
  const proposed = input.runs.filter(
    (run) => run.status !== "dispatched" && run.status !== "abandoned" && run.status !== "stale",
  ).length;
  const appliedRuns = input.runs.filter((run) => run.status === "applied").length;
  const rolledBack = input.runs.filter((run) => run.status === "rolled-back").length;
  lines.push(`采纳率 ${percent(appliedRuns, proposed)}（采纳 ${appliedRuns} / 提案 ${proposed}）`);
  lines.push(`回滚率 ${percent(rolledBack, appliedRuns + rolledBack)}（回滚 ${rolledBack} / 采纳 ${appliedRuns}）`);

  const gains = (input.applied ?? []).map((run) => `${run.skill} ${gainOf(input, run)}`);
  lines.push(`进化收益（采纳后 7 天加载率 Δ）：${gains.length > 0 ? gains.join("、") : "样本不足"}`);

  lines.push(`零加载候选（近 ${CANDIDATE_WEEKS} 周 曝光>0 且 加载=0）：`);
  const candidates: string[] = [];
  for (const skill of input.skills) {
    const hit = weeks.length === CANDIDATE_WEEKS
      && weeks.every((week) => {
        const stat = table.get(week)?.get(skill.name);
        return stat !== undefined && stat.advertised > 0 && stat.loaded === 0;
      });
    if (!hit) continue;
    const refs = input.referenceScan?.(skill.name);
    const parts: string[] = [];
    if (refs) {
      parts.push(`AGENTS 索引 ${refs.agentsIndex ? "有" : "缺"}`);
      parts.push(`其它引用 ${refs.mentions} 处`);
    }
    const overlap = topOverlap(skill, input.skills);
    parts.push(overlap ? `描述重叠 ${overlap.name} ${overlap.score.toFixed(2)}` : "描述重叠 无");
    candidates.push(`  · ${skill.name}  ${parts.join(" · ")}`);
  }
  if (weeks.length < CANDIDATE_WEEKS) {
    lines.push(`  样本不足：当前只有 ${weeks.length} 周遥测，需要连续 ${CANDIDATE_WEEKS} 周`);
  } else if (candidates.length === 0) {
    lines.push("  无");
  } else {
    lines.push(...candidates);
  }

  lines.push("注：加载率只反映「技能文件被读取」，读 ≠ 用；只读 description 就照做的情况记不到。");
  lines.push("候选表只是提醒，不是判决；删技能要 /skill-evolve approve <runId> --prune");
  return lines.join("\n");
}

export interface WeeklyDeps {
  cwd: string;
  evolutionDir: string;
  telemetryDir: string;
  now?: () => number;
  loadSkills?: () => { skills: { name: string; description: string }[] };
  referenceScan?: (skill: string) => ReferenceScan;
}

/** 技能名 + description：零加载候选要靠描述重叠度判断「是不是兄弟技能在抢」 */
function readSkillRefs(cwd: string): SkillRef[] {
  const dirs = listSkillDirs(path.join(cwd, ".pi", "skills"));
  const refs: SkillRef[] = [];
  for (const name of dirs) {
    let text: string;
    try {
      text = fs.readFileSync(path.join(cwd, ".pi", "skills", name, "SKILL.md"), "utf8");
    } catch {
      continue;
    }
    refs.push({ name, description: readFrontmatter(text).description ?? "" });
  }
  return refs;
}

/** 生产入口：读盘 + 组数据，报告本体在 buildWeeklyReport。weekText 每次调用都重读，避免拿到旧盘面 */
export function createWeeklyReport(deps: WeeklyDeps): { weekText(): string } {
  const now = deps.now ?? (() => Date.now());
  const loadSkills = deps.loadSkills ?? (() => ({ skills: readSkillRefs(deps.cwd) }));
  const referenceScan = deps.referenceScan ?? createReferenceScan(deps.cwd);
  const weekText = (): string => {
    const time = now();
    const queue = readQueue(deps.evolutionDir);
    const applied = queue
      .filter((item) => item.status === "applied")
      .map((item) => ({ skill: item.skill, at: item.createdAt }));
    const skills = loadSkills().skills.map((skill) => ({ name: skill.name, description: skill.description ?? "" }));
    return buildWeeklyReport({
      cwd: deps.cwd,
      now: time,
      events: readEvents(deps.telemetryDir, CANDIDATE_WEEKS * 7, time),
      runs: listRuns(deps.evolutionDir, 50),
      queue,
      skills,
      applied,
      referenceScan,
    });
  };
  return { weekText };
}
