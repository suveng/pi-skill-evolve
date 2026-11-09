/**
 * M6 周报：术语只许写「加载率」、零加载候选按 4 周判据、样本不足要明说。
 * 用例编号对应设计稿 14.2（指标公式）与 10.4（零加载候选）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { buildWeeklyReport, descriptionOverlap, type WeeklyInput } from "../lib/weekly.ts";
import type { TelemetryEvent } from "../lib/telemetry.ts";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 8, 12); // 2026-W45

function advertised(ts: number, names: string[]): TelemetryEvent {
  return {
    kind: "advertised",
    ts,
    iso: new Date(ts).toISOString(),
    skills: names.map((name) => ({ name, filePath: `/x/${name}/SKILL.md`, disabled: false, source: "project" })),
  };
}

function loaded(ts: number, skill: string): TelemetryEvent {
  return { kind: "loaded", ts, iso: new Date(ts).toISOString(), skill };
}

function input(events: TelemetryEvent[], extra: Partial<WeeklyInput> = {}): WeeklyInput {
  return {
    cwd: "/repo",
    now: NOW,
    events,
    runs: [],
    queue: [],
    skills: [{ name: "dead-skill", description: "处理各种事情" }],
    ...extra,
  };
}

/** 连续 4 周、每周都曝光 dead-skill 且从不加载 */
function fourWeeksNeverLoaded(): TelemetryEvent[] {
  return [0, 7, 14, 21].map((offset) => advertised(NOW - offset * DAY, ["dead-skill"]));
}

test("周报：出现「加载率」，任何位置都不出现「使用率」", () => {
  const text = buildWeeklyReport(input(fourWeeksNeverLoaded()));
  assert.match(text, /加载率/);
  assert.ok(!text.includes("使用率"), "读 ≠ 用：报告里不许出现「使用率」这个词");
});

test("周报：逐周趋势 + 汇总加载率与尝试失败率", () => {
  const events = [...fourWeeksNeverLoaded(), loaded(NOW, "dead-skill"), { kind: "failed", ts: NOW, iso: "", skill: "dead-skill" }];
  const text = buildWeeklyReport(input(events));
  assert.match(text, /2026-W45  曝光 1 · 加载 1 · 加载率 100\.0%/);
  // 4 周 × 1 曝光 = 4，加载 1 次 → 25%
  assert.match(text, /加载率 25\.0%（加载 1 \/ 曝光 4）/);
  assert.match(text, /尝试失败率 50\.0%（失败 1 \/ 尝试 2）/, "分母是「加载 + 尝试失败」");
});

test("周报：连续 4 周零加载 -> 候选，并附引用面清单与描述重叠", () => {
  const text = buildWeeklyReport(
    input(fourWeeksNeverLoaded(), {
      skills: [
        { name: "dead-skill", description: "处理各种事情" },
        { name: "alive-skill", description: "处理各种事情的具体流程" },
      ],
      referenceScan: () => ({ cursorStub: false, agentsIndex: true, mentions: 2 }),
    }),
  );
  assert.match(text, /零加载候选（近 4 周 曝光>0 且 加载=0）：/);
  assert.match(text, /· dead-skill {2}AGENTS 索引 有 · 其它引用 2 处 · 描述重叠 alive-skill 0\.\d\d/);
  assert.ok(!/· alive-skill/.test(text), "有加载的不进候选表");
});

test("周报：不足 4 周时写「样本不足」，不列候选", () => {
  const events = [advertised(NOW, ["dead-skill"]), advertised(NOW - 7 * DAY, ["dead-skill"])];
  const text = buildWeeklyReport(input(events));
  assert.match(text, /样本不足：当前只有 2 周遥测，需要连续 4 周/);
  assert.ok(!/· dead-skill {2}\.cursor/.test(text));
});

test("周报：冲突密度把存量与新增分开数", () => {
  const events = [
    ...fourWeeksNeverLoaded(),
    { kind: "conflict", ts: NOW, iso: "", level: "P0", stock: true },
    { kind: "conflict", ts: NOW, iso: "", level: "P1", stock: false },
  ];
  const text = buildWeeklyReport(input(events));
  assert.match(text, /冲突密度：存量 1 条 \/ 新增 1 条（P0 1 · P1 1）/);
});

test("周报：采纳率 / 回滚率 / 归因分布", () => {
  const events = [
    ...fourWeeksNeverLoaded(),
    { kind: "attributed", ts: NOW, iso: "", skill: "dead-skill", category: "G" },
  ];
  const runs = [
    { runId: "r1", status: "applied", dispatchedAt: NOW, sessionId: "s" },
    { runId: "r2", status: "proposed", dispatchedAt: NOW, sessionId: "s" },
  ];
  const text = buildWeeklyReport(input(events, { runs }));
  assert.match(text, /归因分布：A 0 · B 0 · C 0 · D 0 · E 0 · F 0 · G 1/);
  assert.match(text, /采纳率 50\.0%（采纳 1 \/ 提案 2）/);
  assert.match(text, /回滚率 0\.0%（回滚 0 \/ 采纳 1）/);
});

test("周报：没有采纳样本时进化收益写「样本不足」", () => {
  const text = buildWeeklyReport(input(fourWeeksNeverLoaded()));
  assert.match(text, /进化收益（采纳后 7 天加载率 Δ）：样本不足/);
});

test("周报：表尾固定句与加载率盲区注解都在", () => {
  const text = buildWeeklyReport(input(fourWeeksNeverLoaded()));
  assert.match(text, /候选表只是提醒，不是判决；删技能要 \/skill-evolve approve <runId> --prune$/);
  assert.match(text, /加载率只反映「技能文件被读取」，读 ≠ 用/);
});

test("descriptionOverlap：中文二元组 + 英文词的 Jaccard，无交集为 0", () => {
  assert.equal(descriptionOverlap("处理各种事情", "处理各种事情"), 1);
  assert.equal(descriptionOverlap("处理各种事情", "完全无关的描述"), 0);
  const partial = descriptionOverlap("处理各种事情", "处理各种事情的具体流程");
  assert.ok(partial > 0 && partial < 1);
  // 英文按词取交集：deploy / to / server 三个词相同 → 3/5
  assert.equal(descriptionOverlap("deploy to test server", "deploy to prod server"), 0.6);
});
