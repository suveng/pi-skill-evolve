/**
 * M6 指标：按 ISO 周聚合、去重落盘、除零不算 NaN。
 * 用例编号对应设计稿 14.2（趋势指标）与 5.1（metrics.jsonl）。
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { ATTRIBUTION_KEYS, appendMetrics, buildMetrics, isoWeek, metricsFile, readMetrics, rollbackRate } from "../lib/metrics.ts";
import { directQueue, type TelemetryEvent } from "../lib/telemetry.ts";

const DAY = 86_400_000;

function ev(kind: TelemetryEvent["kind"], ts: number, extra: Record<string, unknown> = {}): TelemetryEvent {
  return { kind, ts, iso: new Date(ts).toISOString(), ...extra };
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "skill-evolve-metrics-"));
}

test("isoWeek：UTC 周四分周，跨年边界不拆成两周", () => {
  // 2026-01-01 是周四 → 属于 2026-W01
  assert.equal(isoWeek(Date.UTC(2026, 0, 1)), "2026-W01");
  // 2026-01-04（周日）仍属 2026-W01
  assert.equal(isoWeek(Date.UTC(2026, 0, 4)), "2026-W01");
  // 2026-01-05（周一）进入 2026-W02
  assert.equal(isoWeek(Date.UTC(2026, 0, 5)), "2026-W02");
  // 2025-12-29（周一）属 2026-W01：ISO 周跨年跟周四走
  assert.equal(isoWeek(Date.UTC(2025, 11, 29)), "2026-W01");
});

test("buildMetrics：按周聚合曝光 / 加载 / 尝试失败 / 冲突 / 归因", () => {
  const now = Date.UTC(2026, 10, 5, 9);
  const events = [
    ev("advertised", now, {
      skills: [
        { name: "a", filePath: "/a/SKILL.md", disabled: false, source: "project" },
        { name: "b", filePath: "/b/SKILL.md", disabled: true, source: "project" },
      ],
    }),
    ev("advertised", now - DAY, { skills: [{ name: "a", filePath: "/a/SKILL.md", disabled: false, source: "project" }] }),
    ev("loaded", now, { skill: "a" }),
    ev("failed", now, { skill: "a" }),
    ev("conflict", now, { level: "P0", ruleId: "rg-over-find" }),
    ev("conflict", now, { level: "P1", ruleId: "x" }),
    ev("attributed", now, { skill: "a", category: "G" }),
    ev("attributed", now, { skill: "a", category: "semantic" }),
  ];
  const rows = buildMetrics(events, now);
  assert.equal(rows.length, 1);
  const row = rows[0]!;
  assert.equal(row.advertised, 2, "disabled 的技能不算曝光");
  assert.equal(row.loaded, 1);
  assert.equal(row.attemptedFailed, 1);
  assert.equal(row.loadRate, 0.5);
  assert.deepEqual(row.conflicts, { p0: 1, p1: 1 });
  assert.equal(row.attribution.G, 1);
  assert.equal(Object.values(row.attribution).reduce((sum, n) => sum + n, 0), 1, "semantic 不算 A~G 之一");
});

test("buildMetrics：空数据返回空数组，零曝光周不产生 NaN", () => {
  assert.deepEqual(buildMetrics([], Date.now()), []);
  const rows = buildMetrics([ev("missed", Date.UTC(2026, 10, 5), { skill: "a" })], Date.UTC(2026, 10, 5));
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.loadRate, 0);
  assert.ok(Number.isFinite(rows[0]!.loadRate));
});

test("buildMetrics：run 状态按派发日归周，提案 / 采纳 / 回滚分开数", () => {
  const now = Date.UTC(2026, 10, 5);
  const runs = [
    { runId: "r1", status: "proposed", dispatchedAt: now },
    { runId: "r2", status: "applied", dispatchedAt: now },
    { runId: "r3", status: "rolled-back", dispatchedAt: now },
    { runId: "r4", status: "skipped-before-dispatch", dispatchedAt: null },
  ];
  const row = buildMetrics([], now, runs)[0]!;
  assert.equal(row.proposed, 3, "proposed / applied / rolled-back 都算走到过提案阶段");
  assert.equal(row.applied, 1);
  assert.equal(row.rolledBack, 1);
});

test("buildMetrics：多周按周升序返回", () => {
  const now = Date.UTC(2026, 10, 20);
  const rows = buildMetrics([ev("loaded", now), ev("loaded", now - 14 * DAY)], now);
  assert.equal(rows.length, 2);
  assert.ok(rows[0]!.week < rows[1]!.week);
});

test("appendMetrics：同 week + runId 只落一行（去重）", async () => {
  const dir = tmpDir();
  const now = Date.UTC(2026, 10, 5);
  const week = isoWeek(now);
  const row = { ...emptyRow(week, now) };
  assert.equal(await appendMetrics(dir, row, directQueue), true);
  assert.equal(await appendMetrics(dir, row, directQueue), false, "重复写同周汇总必须被跳过");
  const single = { ...row, runId: "r1" };
  assert.equal(await appendMetrics(dir, single, directQueue), true, "同周不同 runId 是另一行");
  assert.equal(await appendMetrics(dir, single, directQueue), false);
  assert.equal(readMetrics(dir).length, 2);
  assert.equal(fs.readFileSync(metricsFile(dir), "utf8").trim().split("\n").length, 2);
});

test("rollbackRate：没有采纳样本返回 0，不返回 NaN", () => {
  assert.equal(rollbackRate([]), 0);
  const now = Date.now();
  assert.equal(rollbackRate([emptyRow("2026-W45", now)]), 0);
  const row = { ...emptyRow("2026-W45", now), applied: 4, rolledBack: 1 };
  assert.equal(rollbackRate([row]), 0.25);
});

/** 造一行空指标：数值字段全零，避免各用例重复写字段 */
function emptyRow(week: string, ts: number) {
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

test("归因分布含 H：请求与技能领域无关不算「缺词」，单独一列", () => {
  // G = 领域内缺词（该改 description），H = 与这个技能无关（不该改）；两件事必须分开统计
  assert.ok((ATTRIBUTION_KEYS as readonly string[]).includes("H"));
  assert.equal((ATTRIBUTION_KEYS as readonly string[]).indexOf("H"), 7);
  assert.equal(ATTRIBUTION_KEYS.length, 8);
});
