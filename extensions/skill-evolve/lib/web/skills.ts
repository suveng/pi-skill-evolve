/**
 * 技能管理页（`?view=skills`）与技能详情页（`?view=skill&name=...`）的数据聚合。
 *
 * 「技能改进」这件事有两个真相来源，这里把它们并为一行：
 * - `.pi/skills/*\/SKILL.md` 目录 = **有哪些技能**（目录是权威，不是遥测里出现过的名字）；
 * - `.pi/evolution/telemetry/*.jsonl` = **曝光与加载**（advertised / loaded 事件，默认看最近 30 天）。
 *
 * 三个状态标签**不合并**（用户明确要求）：有待批提案 / 存量违规 / 缺 .cursor stub。
 * 合成就得二选一显示，而这三件事的处置动作完全不同（去批 / 去改 / 去补 stub）。
 *
 * 只读：这里只读目录与 jsonl，不写任何文件。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { baselinePath, readBaseline } from "../baseline.ts";
import { listSkillDirs } from "../hard-rules.ts";
import { readQueue } from "../queue.ts";
import { listRuns } from "../runs.ts";
import { readEvents, ratio, type TelemetryEvent } from "../telemetry.ts";
import { asRecord, asText } from "./json-read.ts";

/** 允许的统计窗口（白名单）：URL 上的 `?days=` 只认这三个值，其余回落默认 */
export const SKILL_DAYS = [7, 30, 90] as const;
export const DEFAULT_SKILL_DAYS = 30;
/** 详情页要列历史提案，扫的 run 数比列表页多：一个技能一年可能被改几十次 */
const RUN_SCAN_LIMIT = 200;

/**
 * 允许没有 `.cursor/skills/<名>/SKILL.md` 的路由 stub 的技能。
 * 依据 AGENTS.md 明文例外：描述 pi 自身机制的技能不加 Cursor 路由（Cursor 没有对应物，加了是误导）。
 */
const CURSOR_STUB_EXEMPT = new Set(["nested-agents-md", "pi-deepseek-search"]);

export interface SkillRow {
  name: string;
  /** 曝光：最近 N 天里「含这个技能的 advertised 轮数」（同一轮重复只算一次，disabled 不计） */
  exposed: number;
  /** 加载：loaded 事件数（`ok === false` 不计） */
  loaded: number;
  /** 加载率：loaded / exposed；exposed 为 0 时 null（页面写「—」，不能写 0%） */
  rate: number | null;
  /** 最近一次相关 run（proposal.skill === name 的最新一条）；没有就是 null */
  lastRunId: string | null;
  lastRunAt: number | null;
  /** 状态标签一：队列里有 pending 且是它的提案 */
  hasPendingProposal: boolean;
  /** 状态标签二：baseline.json 里有它一条违规 */
  hasBaseline: boolean;
  /** 状态标签三：`.cursor/skills/<名>/SKILL.md` 不存在（豁免名单除外） */
  missingCursorStub: boolean;
}

export interface SkillsView {
  days: number;
  rows: SkillRow[];
  /** 采集开关：关着时页面要写「没有遥测数据（采集关着）」而不是一屏 0 */
  telemetryOn: boolean;
  /** 窗口内遥测事件总数（0 = 采集开着但没数据，与「关着」是两种空态） */
  events: number;
}

export interface SkillRunRow {
  runId: string;
  status: string;
  at: number | null;
  type: string;
  added: number;
  removed: number;
  verdict: string;
  action: string;
}

export interface SkillDetail {
  name: string;
  days: number;
  row: SkillRow | null;
  runs: SkillRunRow[];
  /** 采集总开关与窗口内事件数：关着且没事件时，曝光/加载是「不知道」而不是 0 */
  telemetryOn: boolean;
  events: number;
}

/** 工作区根：约定 evolutionDir 恒为 `<cwd>/.pi/evolution`，所以往上两层就是仓库根 */
export function workspaceRoot(evolutionDir: string): string {
  return path.dirname(path.dirname(path.resolve(evolutionDir)));
}

function hasFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** 曝光按「轮」算：同一轮 advertised 里同名的技能只计一次（disabled 的不算曝光） */
function countExposure(events: readonly TelemetryEvent[]): Map<string, number> {
  const exposure = new Map<string, number>();
  for (const event of events) {
    if (asText(event.kind) !== "advertised") continue;
    const seen = new Set<string>();
    for (const item of Array.isArray(event.skills) ? event.skills : []) {
      const record = asRecord(item);
      if (!record || record.disabled === true) continue;
      const name = asText(record.name);
      if (name.length > 0) seen.add(name);
    }
    for (const name of seen) exposure.set(name, (exposure.get(name) ?? 0) + 1);
  }
  return exposure;
}

function countLoaded(events: readonly TelemetryEvent[]): Map<string, number> {
  const loaded = new Map<string, number>();
  for (const event of events) {
    if (asText(event.kind) !== "loaded") continue;
    if (event.ok === false) continue; // 读失败不算加载
    const name = asText(event.skill);
    if (name.length > 0) loaded.set(name, (loaded.get(name) ?? 0) + 1);
  }
  return loaded;
}

export interface SkillsOptions {
  /** 统计窗口天数，只接受 SKILL_DAYS 里的值 */
  days?: number;
  now?: number;
  telemetryOn?: boolean;
}

/** 归一窗口：非法值（含 `?days=9999`）回落 30，避免有人用 URL 拉全量历史 */
export function parseDays(raw: string | null): number {
  const value = Number(raw);
  return (SKILL_DAYS as readonly number[]).includes(value) ? value : DEFAULT_SKILL_DAYS;
}

/** 技能列表：目录为准，遥测补曝光/加载，队列/baseline/cursor 补三个标签 */
export function readSkills(evolutionDir: string, options: SkillsOptions = {}): SkillsView {
  const days = options.days ?? DEFAULT_SKILL_DAYS;
  const now = options.now ?? Date.now();
  const root = workspaceRoot(evolutionDir);
  const events = readEvents(path.join(evolutionDir, "telemetry"), days, now);
  const exposure = countExposure(events);
  const loaded = countLoaded(events);
  const pending = new Set(readQueue(evolutionDir).filter((item) => item.status === "pending").map((item) => item.skill));
  const baseline = readBaseline(baselinePath(evolutionDir));
  const offending = new Set((baseline?.violations ?? []).map((item) => item.skill));
  // 最近一次相关 run：listRuns 已按派生时间倒序，第一个命中的就是最新的
  const lastRun = new Map<string, { runId: string; at: number | null }>();
  for (const run of listRuns(evolutionDir, RUN_SCAN_LIMIT)) {
    const skill = run.proposal?.skill;
    if (!skill || lastRun.has(skill)) continue;
    lastRun.set(skill, { runId: run.runId, at: run.dispatchedAt });
  }
  const rows: SkillRow[] = listSkillDirs(path.join(root, ".pi", "skills")).map((name) => {
    const exposed = exposure.get(name) ?? 0;
    const loadCount = loaded.get(name) ?? 0;
    return {
      name,
      exposed,
      loaded: loadCount,
      rate: exposed === 0 ? null : ratio(loadCount, exposed),
      lastRunId: lastRun.get(name)?.runId ?? null,
      lastRunAt: lastRun.get(name)?.at ?? null,
      hasPendingProposal: pending.has(name),
      hasBaseline: offending.has(name),
      missingCursorStub: !CURSOR_STUB_EXEMPT.has(name) && !hasFile(path.join(root, ".cursor", "skills", name, "SKILL.md")),
    };
  });
  return { days, rows, telemetryOn: options.telemetryOn === true, events: events.length };
}

/** 技能详情：这一行的统计 + 它所有历史提案（每个 run 一行，带 verdict 与 diff 链接） */
export function readSkillDetail(
  evolutionDir: string,
  name: string,
  options: SkillsOptions = {},
): SkillDetail {
  const view = readSkills(evolutionDir, options);
  const runs: SkillRunRow[] = [];
  for (const run of listRuns(evolutionDir, RUN_SCAN_LIMIT)) {
    if (run.proposal?.skill !== name) continue;
    runs.push({
      runId: run.runId,
      status: run.status,
      at: run.dispatchedAt,
      type: run.proposal.type,
      added: run.proposal.added,
      removed: run.proposal.removed,
      verdict: run.review?.verdict ?? "—",
      action: run.review?.action ?? "—",
    });
  }
  return {
    name,
    days: view.days,
    row: view.rows.find((row) => row.name === name) ?? null,
    runs,
    telemetryOn: view.telemetryOn,
    events: view.events,
  };
}
