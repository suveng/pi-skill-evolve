/**
 * 采纳胶水单测：扫 reviewed → 入队 → auto 自动应用 / approve 手动应用 / 队列文本。
 *
 * 全部临时目录 + 注入的 git/md-check/commit 假实现：不起任何真实子进程，
 * 也不碰仓库里的 `.pi/skills`。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { gate0Path, readGate0, saveGate0 } from "../lib/gate0.ts";
import { createApplyTools } from "../lib/evolution-apply.ts";
import { readQueue } from "../lib/queue.ts";
import { directQueue } from "../lib/telemetry.ts";

const NOW = 1_760_000_000_000;
const SKILL_REL = ".pi/skills/demo/SKILL.md";
const SKILL_TEXT = "---\nname: demo\ndescription: 演示技能\n---\n\n## 步骤\n1. 先读文档\n";
const AUTO_DIFF = `--- a/${SKILL_REL}\n+++ b/${SKILL_REL}\n@@ -3,1 +3,1 @@\n-description: 演示技能\n+description: 演示技能（改后）\n`;
const BODY_DIFF = `--- a/${SKILL_REL}\n+++ b/${SKILL_REL}\n@@ -7,1 +7,1 @@\n-1. 先读文档\n+1. 先读文档，再确认\n`;
/** 把队列里某条 pending 强行抬到 approval：approve 路径本身不该依赖分级算法的实现细节 */
function forceApproval(evolutionDir: string, runId: string): void {
  const file = path.join(evolutionDir, "queue.json");
  const list = JSON.parse(fs.readFileSync(file, "utf8")) as { runId: string; level?: string }[];
  for (const item of list) if (item.runId === runId) item.level = "approval";
  fs.writeFileSync(file, JSON.stringify(list), "utf8");
}


interface Fixture {
  cwd: string;
  evolutionDir: string;
  skillAbs: string;
}

function setup(): Fixture {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "skill-evolve-approve-"));
  const skillAbs = path.join(cwd, SKILL_REL);
  fs.mkdirSync(path.dirname(skillAbs), { recursive: true });
  fs.writeFileSync(skillAbs, SKILL_TEXT, "utf8");
  return { cwd, evolutionDir: path.join(cwd, ".pi", "evolution"), skillAbs };
}

/** 造一个评审通过的 run：run.json status + 提案 json/diff */
function seedRun(fixture: Fixture, runId: string, status: string, diffText = AUTO_DIFF, type = "improve"): string {
  const runDir = path.join(fixture.evolutionDir, "runs", runId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, "run.json"), JSON.stringify({ runId, status, dispatchedAt: NOW }), "utf8");
  fs.writeFileSync(path.join(runDir, "02-proposal.json"), JSON.stringify({ type, skill: "demo" }), "utf8");
  fs.writeFileSync(path.join(runDir, "02-proposal.diff"), diffText, "utf8");
  return runDir;
}

/** 闸0 需要会话起点快照：测试里直接写一份「干净」的，不去真跑 session_start */
async function seedGate0(fixture: Fixture): Promise<void> {
  await saveGate0(fixture.evolutionDir, { at: NOW, status: "", diff: "" }, directQueue);
}

function tools(fixture: Fixture, over: Partial<Parameters<typeof createApplyTools>[0]> = {}) {
  return createApplyTools({
    evolutionDir: fixture.evolutionDir,
    cwd: fixture.cwd,
    queue: directQueue,
    now: () => NOW,
    log: () => {},
    git: (args: string[]) => ({ code: 0, out: args[0] === "status" ? "" : "" }),
    loadDiagnostics: () => [],
    runMdCheck: () => ({ code: 0, output: "" }),
    // 开关默认全开（老用例断言的是「开关都开着」时的行为）；个别用例自己 over 掉
    flags: () => ({ autoReview: true, autoApply: true }),
    ...over,
  });
}

test("autoApply 关着：auto 条照旧入队但不落盘，提示只打一次", async () => {
  const fixture = setup();
  seedRun(fixture, "run-auto", "reviewed");
  await seedGate0(fixture);
  const logs: string[] = [];
  const t = tools(fixture, { flags: () => ({ autoReview: true, autoApply: false }), log: (line: string) => logs.push(line) });
  assert.equal(await t.enqueueReady(), 1, "入队不受采纳开关影响：待审批页要看得见");
  assert.equal(await t.autoApplyPending(), 0, "采纳关着一条都不许动");
  assert.equal(await t.autoApplyPending(), 0);
  const item = readQueue(fixture.evolutionDir)[0]!;
  assert.equal(item.status, "pending", "队列条目必须还在，等人工批准");
  assert.equal(item.level, "auto");
  assert.equal(fs.readFileSync(fixture.skillAbs, "utf8"), SKILL_TEXT, "技能文件一个字都不许改");
  const notices = logs.filter((line) => line.includes("自动采纳已关"));
  assert.equal(notices.length, 1, "同一批待办只提示一次，不能每轮扫描刷一遍");
  assert.match(notices[0]!, /1 条 auto 提案在队列里等人工批准/);
});

test("autoReview 关着：proposed 的 run 也入队并标 reviewSkipped（待审批页可见）", async () => {
  const fixture = setup();
  seedRun(fixture, "run-proposed", "proposed");
  const t = tools(fixture, { flags: () => ({ autoReview: false, autoApply: false }) });
  assert.equal(await t.enqueueReady(), 1, "评审关着时 run 停在 proposed，也要让待审批页看得见");
  const item = readQueue(fixture.evolutionDir)[0]!;
  assert.equal(item.reviewSkipped, true, "没有 03-review.json 的条目标记出来，页面才能区分");
  assert.equal(item.level, "auto", "级别仍按 classify-action 的分类走，不因为跳过评审就降级");
});

test("中途打开评审：同一个 tools 实例先关后开，下一轮扫描不再收 proposed", async () => {
  const fixture = setup();
  const flags = { autoReview: false, autoApply: false };
  const t = tools(fixture, { flags: () => flags });
  seedRun(fixture, "run-p1", "proposed");
  assert.equal(await t.enqueueReady(), 1, "关着的时候 proposed 也入队");
  flags.autoReview = true;
  seedRun(fixture, "run-p2", "proposed");
  assert.equal(await t.enqueueReady(), 0, "打开评审后要等督导写 reviewed，不再提前入队");
});

test("autoReview 开着：proposed 的 run 不入队（等督导写完 reviewed 再进）", async () => {
  const fixture = setup();
  seedRun(fixture, "run-proposed", "proposed");
  const t = tools(fixture, { flags: () => ({ autoReview: true, autoApply: true }) });
  assert.equal(await t.enqueueReady(), 0);
  assert.deepEqual(readQueue(fixture.evolutionDir), []);
});

test("中途改开关：同一个 tools 实例先关后开，下一轮扫描就落盘", async () => {
  const fixture = setup();
  seedRun(fixture, "run-auto", "reviewed");
  await seedGate0(fixture);
  const flags = { autoReview: true, autoApply: false };
  const t = tools(fixture, { flags: () => flags });
  await t.enqueueReady();
  assert.equal(await t.autoApplyPending(), 0);
  // 用户中途 `/skill-evolve apply on`：下一轮扫描就该生效，不许等重开会话
  flags.autoApply = true;
  assert.equal(await t.autoApplyPending(), 1);
  assert.equal(readQueue(fixture.evolutionDir)[0]!.status, "applied");
});

test("只给 reviewed 的 run 入队，级别由代码判（description 改动 → auto）", async () => {
  const fixture = setup();
  seedRun(fixture, "run-ok", "reviewed");
  seedRun(fixture, "run-rejected", "rejected", BODY_DIFF);
  const added = await tools(fixture).enqueueReady();
  assert.equal(added, 1);
  const queue = readQueue(fixture.evolutionDir);
  assert.deepEqual(queue.map((item) => item.runId), ["run-ok"]);
  assert.equal(queue[0]?.level, "auto");
  assert.deepEqual(queue[0]?.targets, [SKILL_REL]);
});

test("正文改动 → auto 级入队（2026-11-11 起正文也可以自动采纳）", async () => {
  const fixture = setup();
  seedRun(fixture, "run-body", "reviewed", BODY_DIFF);
  await tools(fixture).enqueueReady();
  assert.equal(readQueue(fixture.evolutionDir)[0]?.level, "auto");
});

test("路径越界的 run 判 forbidden：不入队并记日志", async () => {
  const fixture = setup();
  const badDiff = `--- a/.pi/skills/demo/notes.md\n+++ b/.pi/skills/demo/notes.md\n@@ -1,1 +1,1 @@\n-旧\n+新\n`;
  seedRun(fixture, "run-bad", "reviewed", badDiff);
  const logs: string[] = [];
  const added = await tools(fixture, { log: (msg) => logs.push(msg) }).enqueueReady();
  assert.equal(added, 0);
  assert.deepEqual(readQueue(fixture.evolutionDir), []);
  assert.match(logs.join("\n"), /forbidden/);
});

test("重复扫描幂等：第二次不再重复入队", async () => {
  const fixture = setup();
  seedRun(fixture, "run-ok", "reviewed");
  const instance = tools(fixture);
  assert.equal(await instance.enqueueReady(), 1);
  assert.equal(await instance.enqueueReady(), 0);
  assert.equal(readQueue(fixture.evolutionDir).length, 1);
});

test("session_start：写闸0 快照 + 自动应用 auto 条（改文件、队列 applied、run.json applied、04-decision）", async () => {
  const fixture = setup();
  seedRun(fixture, "run-ok", "reviewed");
  tools(fixture).sessionStart();
  for (let waited = 0; waited < 100 && readQueue(fixture.evolutionDir)[0]?.status !== "applied"; waited += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(fs.existsSync(gate0Path(fixture.evolutionDir)), true);
  assert.equal(readGate0(fixture.evolutionDir)?.status, "");
  assert.match(fs.readFileSync(fixture.skillAbs, "utf8"), /改后/);
  assert.equal(readQueue(fixture.evolutionDir)[0]?.status, "applied");
  const runJson = JSON.parse(fs.readFileSync(path.join(fixture.evolutionDir, "runs", "run-ok", "run.json"), "utf8")) as { status: string };
  assert.equal(runJson.status, "applied");
  const decision = JSON.parse(fs.readFileSync(path.join(fixture.evolutionDir, "runs", "run-ok", "04-decision.json"), "utf8")) as { approver: string; level: string };
  assert.equal(decision.approver, "auto");
  assert.equal(decision.level, "auto");
});

test("approve：pending 的 approval 条走五道闸写盘，成功后队列 applied", async () => {
  const fixture = setup();
  seedRun(fixture, "run-body", "reviewed", BODY_DIFF);
  await seedGate0(fixture);
  const instance = tools(fixture);
  await instance.enqueueReady();
  forceApproval(fixture.evolutionDir, "run-body");
  assert.equal(readQueue(fixture.evolutionDir)[0]?.status, "pending");
  const text = await instance.approve("run-body", false);
  assert.match(text, /已采纳 run-body/);
  assert.match(text, /gate0 授权核对/);
  assert.match(fs.readFileSync(fixture.skillAbs, "utf8"), /再确认/);
  assert.equal(readQueue(fixture.evolutionDir)[0]?.status, "applied");
});

test("approve 已 applied 的 run 幂等提示，不重复写盘", async () => {
  const fixture = setup();
  seedRun(fixture, "run-ok", "reviewed");
  await seedGate0(fixture);
  const instance = tools(fixture);
  await instance.enqueueReady();
  await instance.autoApplyPending();
  const once = fs.readFileSync(fixture.skillAbs, "utf8");
  const text = await instance.approve("run-ok", false);
  assert.match(text, /已经应用过/);
  assert.equal(fs.readFileSync(fixture.skillAbs, "utf8"), once);
});

test("approve 队列里没有的 run：给出下一步提示，不动文件", async () => {
  const fixture = setup();
  const text = await tools(fixture).approve("run-404", false);
  assert.match(text, /队列里没有 run-404/);
  assert.equal(fs.readFileSync(fixture.skillAbs, "utf8"), SKILL_TEXT);
});

test("approve forbidden 条直接拒绝执行", async () => {
  const fixture = setup();
  seedRun(fixture, "run-fb", "reviewed", AUTO_DIFF);
  // 正常路径根本不会把 forbidden 入队（enqueueReady 已拦），手工塞一条验证 approve 自己的兜底
  fs.mkdirSync(fixture.evolutionDir, { recursive: true });
  fs.writeFileSync(
    path.join(fixture.evolutionDir, "queue.json"),
    JSON.stringify([{ runId: "run-fb", level: "forbidden", skill: "demo", targets: [SKILL_REL], createdAt: NOW, status: "pending" }]),
    "utf8",
  );
  const text = await tools(fixture).approve("run-fb", false);
  assert.match(text, /forbidden/);
  assert.deepEqual(readQueue(fixture.evolutionDir).map((item) => item.runId), ["run-fb"]);
});

test("approve --prune：只出删技能清单，不真删", async () => {
  const fixture = setup();
  const runDir = seedRun(fixture, "run-prune", "reviewed", AUTO_DIFF, "prune");
  fs.mkdirSync(path.join(fixture.cwd, ".cursor", "skills", "demo"), { recursive: true });
  fs.writeFileSync(path.join(fixture.cwd, ".cursor", "skills", "demo", "SKILL.md"), "stub\n", "utf8");
  fs.writeFileSync(path.join(fixture.cwd, "AGENTS.md"), "- `demo` —— `.pi/skills/demo/SKILL.md`\n", "utf8");
  const text = await tools(fixture).approve("run-prune", true);
  assert.match(text, /删技能待执行清单：demo/);
  assert.match(text, /rm -rf \.pi\/skills\/demo\//);
  assert.match(text, /\.dsh\/skills\/demo\/ 不动/);
  // 一个字节都没真删
  assert.equal(fs.existsSync(fixture.skillAbs), true);
  assert.equal(fs.existsSync(path.join(fixture.cwd, ".cursor", "skills", "demo", "SKILL.md")), true);
  assert.equal(fs.existsSync(path.join(runDir, "02-proposal.diff")), true);
});

test("queueText 分组列出 pending / applied 并给 pending 的 targets", async () => {
  const fixture = setup();
  seedRun(fixture, "run-body", "reviewed", BODY_DIFF);
  const instance = tools(fixture);
  await instance.enqueueReady();
  forceApproval(fixture.evolutionDir, "run-body");
  const text = instance.queueText();
  assert.match(text, /采纳队列：/);
  assert.match(text, /pending 1 条/);
  assert.match(text, /run-body\s+approval\s+demo/);
  assert.match(text, /targets：\.pi\/skills\/demo\/SKILL\.md/);
  assert.match(text, /approve <runId>/);
});

test("queueText 空队列给明确提示", () => {
  const fixture = setup();
  assert.match(tools(fixture).queueText(), /采纳队列为空/);
});

test("autoApplyPending 单条异常不拖垮整批：第一条失败第二条仍应用", async () => {
  const fixture = setup();
  const otherAbs = path.join(fixture.cwd, ".pi/skills/other/SKILL.md");
  fs.mkdirSync(path.dirname(otherAbs), { recursive: true });
  fs.writeFileSync(otherAbs, "---\nname: other\ndescription: 另一个\n---\n", "utf8");
  seedRun(fixture, "run-a", "reviewed", AUTO_DIFF);
  const otherDiff = `--- a/.pi/skills/other/SKILL.md\n+++ b/.pi/skills/other/SKILL.md\n@@ -3,1 +3,1 @@\n-description: 另一个\n+description: 另一个（改后）\n`;
  const otherDir = path.join(fixture.evolutionDir, "runs", "run-b");
  fs.mkdirSync(otherDir, { recursive: true });
  fs.writeFileSync(path.join(otherDir, "run.json"), JSON.stringify({ runId: "run-b", status: "reviewed", dispatchedAt: NOW }), "utf8");
  fs.writeFileSync(path.join(otherDir, "02-proposal.json"), JSON.stringify({ type: "improve", skill: "other" }), "utf8");
  fs.writeFileSync(path.join(otherDir, "02-proposal.diff"), otherDiff, "utf8");
  const queue = async <T>(file: string, run: () => Promise<T>): Promise<T> => {
    if (file === fixture.skillAbs) throw new Error("模拟写失败");
    return run();
  };
  await seedGate0(fixture);
  const instance = tools(fixture, { queue });
  await instance.enqueueReady();
  const applied = await instance.autoApplyPending();
  assert.equal(applied, 1);
  assert.match(fs.readFileSync(otherAbs, "utf8"), /改后/);
  const statuses = readQueue(fixture.evolutionDir).map((item) => `${item.runId}:${item.status}`).sort();
  assert.deepEqual(statuses, ["run-a:failed", "run-b:applied"]);
});

test("同一技能有更早 pending 时，新 run 入队即 superseded 且不会被自动应用", async () => {
  const fixture = setup();
  seedRun(fixture, "run-body", "reviewed", BODY_DIFF);
  const instance = tools(fixture);
  await instance.enqueueReady();
  forceApproval(fixture.evolutionDir, "run-body");
  // 再放一条同 skill 的 reviewed run（前一条还没处理）
  const second = path.join(fixture.evolutionDir, "runs", "run-second");
  fs.mkdirSync(second, { recursive: true });
  fs.writeFileSync(path.join(second, "run.json"), JSON.stringify({ runId: "run-second", status: "reviewed" }), "utf8");
  fs.writeFileSync(path.join(second, "02-proposal.json"), JSON.stringify({ type: "improve", skill: "demo" }), "utf8");
  fs.writeFileSync(path.join(second, "02-proposal.diff"), AUTO_DIFF, "utf8");
  await instance.enqueueReady();
  const queue = readQueue(fixture.evolutionDir);
  assert.equal(queue.find((item) => item.runId === "run-second")?.status, "superseded");
  assert.equal(await instance.autoApplyPending(), 0); // 前一条是 approval，不等自动
  assert.equal(fs.readFileSync(fixture.skillAbs, "utf8"), SKILL_TEXT);
});
