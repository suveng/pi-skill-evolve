/**
 * 趋势指标：把遥测事件按 ISO 周聚合，落 `.pi/evolution/metrics.jsonl`（已 gitignore）。
 *
 * 两条纪律：
 * 1. 只做聚合，不做解释——归因结论在 01-findings.json / 周报里；
 * 2. 除零一律返回 0（`ratio`），指标里出现 NaN 比没指标更糟。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { ratio, type MutationQueue, type TelemetryEvent } from "./telemetry.ts";

/** 归因分布只统计 A~H 八类（semantic 是「判不动」的兜底，不算一类原因）；G = 领域内缺词（该改），H = 与本技能无关（不该改） */
export const ATTRIBUTION_KEYS = ["A", "B", "C", "D", "E", "F", "G", "H", "I"] as const;
export type AttributionKey = (typeof ATTRIBUTION_KEYS)[number];

export interface MetricsRow {
  /** 落盘时刻（毫秒） */
  ts: number;
  /** ISO 周，如 `2026-W45` */
  week: string;
  advertised: number;
  loaded: number;
  attemptedFailed: number;
  /** loaded / advertised */
  loadRate: number;
  conflicts: { p0: number; p1: number };
  proposed: number;
  applied: number;
  rolledBack: number;
  attribution: Record<AttributionKey, number>;
  /** 单 run 行才带；按周汇总行省略（去重键：week + runId） */
  runId?: string;
}

/** 指标要看的 run 侧面：只取状态与派发时刻，其余字段与趋势无关 */
export interface MetricsRun {
  runId: string;
  status: string;
  dispatchedAt: number | null;
}

/** 走到过提案阶段的 run（用来算采纳率的分母） */
const PROPOSED_STATUSES = new Set(["proposed", "reviewed", "rejected", "review_failed", "applied", "rolled-back", "unauthorized_write", "failed"]);

/** ISO-8601 周编号：`2026-W45`。用 UTC 计算，避免本地时区跨年把同一周拆成两周 */
export function isoWeek(ts: number): string {
  const date = new Date(ts);
  const thursday = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const weekday = thursday.getUTCDay() || 7;
  thursday.setUTCDate(thursday.getUTCDate() + 4 - weekday);
  const yearStart = Date.UTC(thursday.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((thursday.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${thursday.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function emptyRow(week: string, ts: number): MetricsRow {
  return {
    ts,
    week,
    advertised: 0,
    loaded: 0,
    attemptedFailed: 0,
    loadRate: 0,
    conflicts: { p0: 0, p1: 0 },
    proposed: 0,
    applied: 0,
    rolledBack: 0,
    attribution: { A: 0, B: 0, C: 0, D: 0, E: 0, F: 0, G: 0 },
  };
}

function skillsOf(event: TelemetryEvent): { name: string; disabled: boolean }[] {
  const raw = Array.isArray(event.skills) ? (event.skills as { name?: unknown; disabled?: unknown }[]) : [];
  return raw
    .filter((skill) => typeof skill?.name === "string")
    .map((skill) => ({ name: String(skill.name), disabled: skill.disabled === true }));
}

/**
 * 按 ISO 周聚合。`runs` 可选：提案数 / 采纳数 / 回滚数只有 run.json 知道（复盘子进程不写遥测）。
 */
export function buildMetrics(events: readonly TelemetryEvent[], now: number, runs: readonly MetricsRun[] = []): MetricsRow[] {
  const weeks = new Map<string, MetricsRow>();
  const rowOf = (ts: number): MetricsRow => {
    const week = isoWeek(ts);
    let row = weeks.get(week);
    if (!row) {
      row = emptyRow(week, now);
      weeks.set(week, row);
    }
    return row;
  };

  for (const event of events) {
    if (typeof event.ts !== "number" || !Number.isFinite(event.ts)) continue;
    const row = rowOf(event.ts);
    if (event.kind === "advertised") {
      row.advertised += skillsOf(event).filter((skill) => !skill.disabled).length;
    } else if (event.kind === "loaded") {
      row.loaded += 1;
    } else if (event.kind === "failed") {
      row.attemptedFailed += 1;
    } else if (event.kind === "conflict") {
      if (event.level === "P0") row.conflicts.p0 += 1;
      else if (event.level === "P1") row.conflicts.p1 += 1;
    } else if (event.kind === "attributed") {
      const category = typeof event.category === "string" ? event.category : "";
      if ((ATTRIBUTION_KEYS as readonly string[]).includes(category)) {
        row.attribution[category as AttributionKey] += 1;
      }
    }
  }

  for (const run of runs) {
    if (run.dispatchedAt === null) continue;
    const row = rowOf(run.dispatchedAt);
    if (PROPOSED_STATUSES.has(run.status)) row.proposed += 1;
    if (run.status === "applied") row.applied += 1;
    if (run.status === "rolled-back") row.rolledBack += 1;
  }

  for (const row of weeks.values()) row.loadRate = ratio(row.loaded, row.advertised);
  return [...weeks.values()].sort((a, b) => a.week.localeCompare(b.week));
}

export function metricsFile(evolutionDir: string): string {
  return path.join(evolutionDir, "metrics.jsonl");
}

/** 去重键：同一周的汇总行只写一次；单 run 行按 week + runId 区分 */
function keyOf(row: MetricsRow): string {
  return `${row.week}|${row.runId ?? ""}`;
}

export function readMetrics(evolutionDir: string): MetricsRow[] {
  let text: string;
  try {
    text = fs.readFileSync(metricsFile(evolutionDir), "utf8");
  } catch {
    return [];
  }
  const rows: MetricsRow[] = [];
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      const parsed = JSON.parse(line) as MetricsRow;
      if (typeof parsed.week === "string") rows.push(parsed);
    } catch {
      // 坏行跳过：旁路数据不值得让整份趋势报错
    }
  }
  return rows;
}

/** 追加一行；同 week（+runId）已有则跳过，返回是否真的写入 */
export async function appendMetrics(evolutionDir: string, row: MetricsRow, queue: MutationQueue): Promise<boolean> {
  const file = metricsFile(evolutionDir);
  const key = keyOf(row);
  if (readMetrics(evolutionDir).some((existing) => keyOf(existing) === key)) return false;
  await queue(file, async () => {
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.appendFile(file, `${JSON.stringify(row)}\n`, "utf8");
  });
  return true;
}

/** 回滚率 = rolledBack / applied；没有采纳样本时为 0（「样本不足」由调用方判断） */
export function rollbackRate(rows: readonly MetricsRow[]): number {
  const applied = rows.reduce((sum, row) => sum + row.applied, 0);
  const rolledBack = rows.reduce((sum, row) => sum + row.rolledBack, 0);
  return ratio(rolledBack, applied);
}
