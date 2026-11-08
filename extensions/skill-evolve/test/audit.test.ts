/**
 * `/skill-audit` 文本单测（零依赖，node --test）。
 *
 * 运行：
 *   cd .pi/extensions/skill-evolve
 *   node --experimental-strip-types --test test/audit.test.ts
 *
 * 覆盖：六类都出现（0 也要列）、attributed 事件按次数累计、
 * 无归因记录的历史 missed 走现算并计入来源、硬禁令 P0 列表、加载率注解文案。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fingerprintOf } from "../lib/baseline.ts";

import { AUDIT_LOAD_RATE_NOTE, activeToolsFromEvents, auditText, buildAuditModel, exposedFromEvents } from "../lib/audit.ts";
import type { TelemetryEvent } from "../lib/telemetry.ts";

function event(partial: Partial<TelemetryEvent> & { kind: TelemetryEvent["kind"] }): TelemetryEvent {
  return { ts: 1_700_000_000_000, iso: "2023-11-14T22:13:20.000Z", ...partial } as TelemetryEvent;
}

const EVENTS: TelemetryEvent[] = [
  event({
    kind: "advertised",
    sessionId: "s1",
    skills: [
      { name: "alpha", filePath: "/r/.pi/skills/alpha/SKILL.md", disabled: false, source: "project" },
      { name: "beta", filePath: "/r/.pi/skills/beta/SKILL.md", disabled: false, source: "project" },
    ],
    activeTools: ["read", "bash"],
  }),
  event({ kind: "loaded", sessionId: "s1", skill: "alpha" }),
  event({ kind: "missed", sessionId: "s1", skill: "beta" }),
  event({ kind: "missed", sessionId: "s1", skill: "beta" }),
  event({ kind: "attributed", sessionId: "s1", skill: "beta", category: "B", reason: "frontmatter 坏" }),
  event({ kind: "attributed", sessionId: "s1", skill: "beta", category: "B", reason: "frontmatter 坏" }),
  // 历史数据（M2 之前）：missed 有记录，但没有任何 attributed
  event({ kind: "missed", sessionId: "s0", skill: "gamma" }),
  event({ kind: "missed", sessionId: "s0", skill: "gamma" }),
  event({ kind: "missed", sessionId: "s0", skill: "gamma" }),
  event({ kind: "missed", sessionId: "s0", skill: "delta" }),
];

test("buildAuditModel：attributed 按次数累计，历史 missed 走现算", () => {
  const model = buildAuditModel({
    days: 7,
    events: EVENTS,
    classify: (skill) => (skill === "gamma" ? "E" : "semantic"),
    conflicts: [],
    invalidRules: [],
  });
  const byCategory = new Map(model.rows.map((row) => [row.category, row.count]));
  assert.equal(byCategory.get("B"), 2);
  assert.equal(byCategory.get("E"), 3);
  assert.equal(byCategory.get("semantic"), 1);
  assert.equal(model.fromTelemetry, 2);
  assert.equal(model.fromLive, 4);
  assert.deepEqual(model.unattributed, []);
  assert.equal(model.summary.advertised, 2);
  assert.equal(model.summary.loaded, 1);
});

test("buildAuditModel：不给 classify 时历史 missed 进「未归因」，不硬编类别", () => {
  const model = buildAuditModel({ days: 7, events: EVENTS, conflicts: [], invalidRules: [] });
  assert.deepEqual(model.unattributed, [{ skill: "gamma", count: 3 }, { skill: "delta", count: 1 }]);
  const total = model.rows.reduce((sum, row) => sum + row.count, 0);
  assert.equal(total, 2); // 只有 attributed 的 2 条
});

test("auditText：六类全列、P0 列表、行号、加载率注解都在", () => {
  const text = auditText(
    buildAuditModel({
      days: 7,
      events: EVENTS,
      classify: (skill) => (skill === "gamma" ? "E" : "semantic"),
      conflicts: [
        { ruleId: "rg-over-find", level: "P0", skill: "deploy-test", line: 129, quote: "grep -rho 对账" },
      ],
      invalidRules: ["broken-rule: 正则编译失败"],
    }),
  );
  for (const category of ["A", "B", "C", "D", "E", "semantic"]) {
    assert.match(text, new RegExp(`^\\s+${category === "semantic" ? "semantic" : category}\\s`, "m"), `缺类别 ${category}`);
  }
  assert.match(text, /加载率 50\.0%/);
  assert.match(text, /B\s+frontmatter 坏\s+2/);
  assert.match(text, /rg-over-find\s+deploy-test:129\s+P0/);
  assert.match(text, /规则不可用：/);
  assert.ok(text.includes(AUDIT_LOAD_RATE_NOTE));
  assert.match(text, /加载率低 ≠ 技能没用/);
});

test("auditText：无冲突、无数据时也要有明确结论而不是空白", () => {
  const text = auditText(buildAuditModel({ days: 7, events: [], conflicts: [], invalidRules: [] }));
  assert.match(text, /P0 命中 0 条/);
  assert.match(text, /无曝光数据/);
  assert.match(text, /没有可归因的未命中/);
});

test("exposedFromEvents / activeToolsFromEvents 取最近一次 advertised", () => {
  const events = [
    ...EVENTS,
    event({
      kind: "advertised",
      sessionId: "s2",
      skills: [{ name: "omega", filePath: "", disabled: true, source: "embedded" }],
      activeTools: ["edit"],
    }),
  ];
  assert.deepEqual(exposedFromEvents(events), [{ name: "omega", filePath: "", disabled: true }]);
  assert.deepEqual(activeToolsFromEvents(events), ["edit"]);
  // 老数据没有 activeTools 字段：返回空数组，调用方据此不判 E
  assert.deepEqual(activeToolsFromEvents(EVENTS), ["read", "bash"]);
  assert.deepEqual(activeToolsFromEvents([event({ kind: "missed", skill: "x" })]), []);
});

test("auditText：存量命中与新增命中分两段，只有新增算失败信号", () => {
  const stockHit = { ruleId: "rg-over-find", level: "P0", skill: "deploy-test", line: 129, quote: "老问题" };
  const addedHit = { ruleId: "file-size-limit", level: "P0", skill: "big-skill", line: 12, quote: "600 行" };
  const text = auditText(
    buildAuditModel({
      days: 7,
      events: [],
      conflicts: [stockHit, addedHit],
      knownFingerprints: new Set([fingerprintOf(stockHit)]),
      invalidRules: [],
    }),
  );
  assert.match(text, /P0 命中 2 条：存量（baseline）1 条 · 新增 1 条/);
  assert.match(text, /新增\s+file-size-limit\s+big-skill:12\s+P0/);
  assert.match(text, /存量\s+rg-over-find\s+deploy-test:129\s+P0/);
  assert.match(text, /确认无害后跑 \/skill-evolve baseline 接受/);
});

test("auditText：全是存量时不出现「新增命中」提示", () => {
  const hits = [
    { ruleId: "rg-over-find", level: "P0", skill: "deploy-test", line: 129, quote: "老问题一" },
    { ruleId: "rg-over-find", level: "P0", skill: "deploy-test", line: 196, quote: "老问题二" },
  ];
  const text = auditText(
    buildAuditModel({
      days: 7,
      events: [],
      conflicts: hits,
      knownFingerprints: new Set(hits.map((hit) => fingerprintOf(hit))),
      invalidRules: [],
    }),
  );
  assert.match(text, /P0 命中 2 条：存量（baseline）2 条 · 新增 0 条/);
  assert.doesNotMatch(text, /新增命中：/);
});
