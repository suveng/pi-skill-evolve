/**
 * 技能管理页的数据聚合：曝光按「轮」算、加载按事件算、三个状态标签不合并、窗口只认 7/30/90。
 * 全部喂临时目录（技能目录 + jsonl 遥测 + queue + baseline），不读真仓库。
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { skillTags } from "../lib/web/render-skills.ts";
import { DEFAULT_SKILL_DAYS, parseDays, readSkillDetail, readSkills } from "../lib/web/skills.ts";
import { shardFile } from "../lib/telemetry.ts";

const DAY = 24 * 60 * 60 * 1000;
/** 固定时钟：readEvents 按本地日期倒推分片，所以本地日期往前推才和写盘时的 shardFile 对齐 */
const NOW = new Date(2026, 10, 8, 12).getTime();

interface Fixture {
  cwd: string;
  evolutionDir: string;
}

function workspace(): Fixture {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "skill-evolve-webskills-"));
  const evolutionDir = path.join(cwd, ".pi", "evolution");
  fs.mkdirSync(path.join(evolutionDir, "runs"), { recursive: true });
  return { cwd, evolutionDir };
}

/** 建一个技能目录（`.pi/skills/<名>/SKILL.md`），可选带 `.cursor/skills/<名>/SKILL.md` */
function makeSkill(fixture: Fixture, name: string, options: { cursorStub?: boolean } = {}): void {
  const skillDir = path.join(fixture.cwd, ".pi", "skills", name);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), `---\nname: ${name}\n---\n# ${name}\n`, "utf8");
  if (options.cursorStub) {
    const stub = path.join(fixture.cwd, ".cursor", "skills", name);
    fs.mkdirSync(stub, { recursive: true });
    fs.writeFileSync(path.join(stub, "SKILL.md"), "路由 stub\n", "utf8");
  }
}

/** 往某一天的遥测分片追事件（与 telemetry.shardFile 同一口径，测试自己拼文件名就会对不上） */
function appendEvents(fixture: Fixture, ts: number, events: Record<string, unknown>[]): void {
  const file = shardFile(path.join(fixture.evolutionDir, "telemetry"), ts);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const text = events.map((event) => JSON.stringify({ ts, iso: new Date(ts).toISOString(), ...event })).join("\n");
  fs.appendFileSync(file, `${text}\n`, "utf8");
}

function writeRun(fixture: Fixture, runId: string, record: Record<string, unknown>): void {
  const runDir = path.join(fixture.evolutionDir, "runs", runId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, "run.json"), JSON.stringify({ runId, ...record }), "utf8");
}

test("曝光按轮算：同一轮里的重复技能只算一次，disabled 不计；加载按事件算，ok:false 不计", () => {
  const fixture = workspace();
  makeSkill(fixture, "demo", { cursorStub: true });
  makeSkill(fixture, "other", { cursorStub: true });
  // 第 1 轮：demo 出现两次（同一轮去重）+ other 一次 + 一个 disabled 的
  appendEvents(fixture, NOW - 2 * DAY, [
    {
      kind: "advertised",
      sessionId: "s1",
      skills: [
        { name: "demo", disabled: false },
        { name: "demo", disabled: false },
        { name: "other", disabled: false },
        { name: "retired", disabled: true },
      ],
    },
    { kind: "loaded", sessionId: "s1", skill: "demo", ok: true, how: "read" },
    { kind: "loaded", sessionId: "s1", skill: "demo", ok: false, how: "read" },
  ]);
  // 第 2 轮：只有 demo
  appendEvents(fixture, NOW - 1 * DAY, [
    { kind: "advertised", sessionId: "s2", skills: [{ name: "demo", disabled: false }] },
    { kind: "loaded", sessionId: "s2", skill: "other", how: "read" },
  ]);

  const view = readSkills(fixture.evolutionDir, { now: NOW, telemetryOn: true });
  const demo = view.rows.find((row) => row.name === "demo")!;
  assert.equal(demo.exposed, 2, "两轮里出现过 demo，同轮重复不重复计数");
  assert.equal(demo.loaded, 1, "ok:false 的读取不算加载");
  assert.equal(demo.rate, 0.5);
  const other = view.rows.find((row) => row.name === "other")!;
  assert.equal(other.exposed, 1);
  assert.equal(other.loaded, 1);
  assert.equal(other.rate, 1);
  assert.equal(view.events, 5);
});

test("days 窗口：20 天前的事件在 7 天窗口外、在 30 天窗口内；`?days` 只认 7/30/90", () => {
  const fixture = workspace();
  makeSkill(fixture, "demo");
  appendEvents(fixture, NOW - 20 * DAY, [
    { kind: "advertised", sessionId: "old", skills: [{ name: "demo", disabled: false }] },
    { kind: "loaded", sessionId: "old", skill: "demo", ok: true },
  ]);
  const week = readSkills(fixture.evolutionDir, { now: NOW, days: 7 });
  assert.equal(week.rows[0]!.exposed, 0);
  assert.equal(week.rows[0]!.rate, null, "没曝光写 null（页面显示「—」），不能写 0%");
  const month = readSkills(fixture.evolutionDir, { now: NOW, days: 30 });
  assert.equal(month.rows[0]!.exposed, 1);
  assert.equal(month.rows[0]!.loaded, 1);
  assert.equal(month.rows[0]!.rate, 1);

  assert.equal(parseDays("7"), 7);
  assert.equal(parseDays("90"), 90);
  assert.equal(parseDays("9999"), DEFAULT_SKILL_DAYS, "非法窗口回落 30，不能用 URL 拉全量历史");
  assert.equal(parseDays(null), DEFAULT_SKILL_DAYS);
  assert.equal(parseDays(""), DEFAULT_SKILL_DAYS);
});

test("无遥测：事件数为 0，采集开关原样透传（页面据此区分「没采集」与「没数据」）", () => {
  const fixture = workspace();
  makeSkill(fixture, "demo");
  const off = readSkills(fixture.evolutionDir, { now: NOW, telemetryOn: false });
  assert.equal(off.events, 0);
  assert.equal(off.telemetryOn, false);
  assert.equal(off.days, DEFAULT_SKILL_DAYS);
  assert.equal(off.rows.length, 1);
  assert.equal(off.rows[0]!.rate, null);
  assert.equal(readSkills(fixture.evolutionDir, { now: NOW, telemetryOn: true }).telemetryOn, true);
});

test("两个状态标签不合并：待批提案 / 存量违规 各自独立（.cursor stub 检查已移除）", () => {
  const fixture = workspace();
  makeSkill(fixture, "demo", { cursorStub: true });
  makeSkill(fixture, "other", { cursorStub: false });
  makeSkill(fixture, "third", { cursorStub: true });
  fs.writeFileSync(
    path.join(fixture.evolutionDir, "queue.json"),
    JSON.stringify([
      { runId: "run-p", level: "approval", skill: "demo", targets: [], createdAt: NOW, status: "pending" },
      // 已处理的不算「有待批提案」
      { runId: "run-q", level: "approval", skill: "third", targets: [], createdAt: NOW, status: "rejected" },
    ]),
    "utf8",
  );
  fs.writeFileSync(
    path.join(fixture.evolutionDir, "baseline.json"),
    JSON.stringify({
      version: 1,
      generatedAt: NOW,
      bootstrap: true,
      violations: [{ ruleId: "rg-over-find", level: "P0", skill: "other", line: 129, quote: "find", fingerprint: "x" }],
    }),
    "utf8",
  );

  const rows = readSkills(fixture.evolutionDir, { now: NOW });
  const byName = new Map(rows.rows.map((row) => [row.name, row]));
  assert.deepEqual(
    [byName.get("demo")!.hasPendingProposal, byName.get("demo")!.hasBaseline],
    [true, false],
  );
  assert.deepEqual(
    [byName.get("other")!.hasPendingProposal, byName.get("other")!.hasBaseline],
    [false, true],
  );
  assert.equal(byName.get("third")!.hasPendingProposal, false, "status=rejected 的队列条目不算待批");

  const tags = (name: string): string => skillTags(byName.get(name)!);
  assert.match(tags("demo"), /有待批提案/);
  assert.equal(tags("demo").includes("存量违规"), false);
  assert.match(tags("other"), /存量违规/);
  assert.equal(tags("other").includes(".cursor"), false, "缺 .cursor stub 不再是一个标签");
  assert.equal(tags("third"), '<span class="hint">—</span>', "一个标签都没有时给破折号，不留空白");
});

test("不再检查 .cursor stub：没有 stub 的技能也不挂标签", () => {
  const fixture = workspace();
  makeSkill(fixture, "nested-agents-md");
  makeSkill(fixture, "feishu-collab");
  const rows = new Map(readSkills(fixture.evolutionDir, { now: NOW }).rows.map((row) => [row.name, row]));
  assert.equal("missingCursorStub" in rows.get("feishu-collab")!, false);
  assert.equal(skillTags(rows.get("feishu-collab")!), '<span class="hint">—</span>');
});

test("最近一次相关 run：取 proposal.skill 命中的最新一条，没有就是 null", () => {
  const fixture = workspace();
  makeSkill(fixture, "demo");
  makeSkill(fixture, "quiet");
  writeRun(fixture, "run-old", {
    status: "applied",
    dispatchedAt: NOW - 10 * DAY,
    proposal: { type: "improve", skill: "demo", status: "ok", added: 1, removed: 1, file: "02-proposal.diff" },
  });
  writeRun(fixture, "run-new", {
    status: "rejected",
    dispatchedAt: NOW - 1 * DAY,
    proposal: { type: "improve", skill: "demo", status: "ok", added: 2, removed: 0, file: "02-proposal.diff" },
  });
  const rows = new Map(readSkills(fixture.evolutionDir, { now: NOW }).rows.map((row) => [row.name, row]));
  assert.equal(rows.get("demo")!.lastRunId, "run-new");
  assert.equal(rows.get("demo")!.lastRunAt, NOW - 1 * DAY);
  assert.equal(rows.get("quiet")!.lastRunId, null);
});

test("技能详情：只收这个技能的历史提案，每个 run 一行，带 verdict 与 action", () => {
  const fixture = workspace();
  makeSkill(fixture, "demo");
  makeSkill(fixture, "other");
  writeRun(fixture, "run-a", {
    status: "rejected",
    dispatchedAt: NOW - 2 * DAY,
    proposal: { type: "improve", skill: "demo", status: "ok", added: 2, removed: 1, file: "02-proposal.diff" },
    review: { status: "rejected", verdict: "revise", action: "forbidden" },
  });
  writeRun(fixture, "run-b", {
    status: "applied",
    dispatchedAt: NOW - 1 * DAY,
    proposal: { type: "create", skill: "demo", status: "ok", added: 9, removed: 0, file: "02-proposal.diff" },
    review: { status: "reviewed", verdict: "pass", action: "auto" },
  });
  writeRun(fixture, "run-c", {
    status: "reviewed",
    dispatchedAt: NOW,
    proposal: { type: "improve", skill: "other", status: "ok", added: 1, removed: 1, file: "02-proposal.diff" },
  });

  const detail = readSkillDetail(fixture.evolutionDir, "demo", { now: NOW });
  assert.equal(detail.name, "demo");
  assert.equal(detail.row?.name, "demo");
  assert.deepEqual(
    detail.runs.map((run) => `${run.runId}:${run.type}:${run.verdict}/${run.action}`),
    ["run-b:create:pass/auto", "run-a:improve:revise/forbidden"],
  );
  assert.equal(detail.runs[0]!.added, 9);

  const missing = readSkillDetail(fixture.evolutionDir, "gone", { now: NOW });
  assert.equal(missing.row, null, "目录里没有的技能：统计为空，但仍可看历史提案");
  assert.deepEqual(missing.runs, []);
});
