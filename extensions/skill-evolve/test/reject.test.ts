/**
 * 拒绝胶水单测：Web 面板「拒绝」只改状态，不碰技能文件。
 *
 * 走的是 index.ts 注入的同一条路径（createApplyTools(...).reject），
 * 全部临时目录 + 注入的 git/md-check 假实现：不起任何真实子进程，也不碰仓库里的 `.pi/skills`。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createApplyTools } from "../lib/evolution-apply.ts";
import { gate0Path, readGate0, saveGate0 } from "../lib/gate0.ts";
import { readQueue } from "../lib/queue.ts";
import { directQueue } from "../lib/telemetry.ts";

const NOW = 1_760_000_000_000;
const SKILL_REL = ".pi/skills/demo/SKILL.md";
const SKILL_TEXT = "---\nname: demo\ndescription: 演示技能\n---\n\n## 步骤\n1. 先读文档\n";
/** 正文改动 → approval 级：正是需要人批的那种提案 */
const BODY_DIFF = `--- a/${SKILL_REL}\n+++ b/${SKILL_REL}\n@@ -7,1 +7,1 @@\n-1. 先读文档\n+1. 先读文档，再确认\n`;

interface Fixture {
  cwd: string;
  evolutionDir: string;
  skillAbs: string;
  runDir: string;
}

function setup(runId = "run-body"): Fixture {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "skill-evolve-reject-"));
  const skillAbs = path.join(cwd, SKILL_REL);
  fs.mkdirSync(path.dirname(skillAbs), { recursive: true });
  fs.writeFileSync(skillAbs, SKILL_TEXT, "utf8");
  const evolutionDir = path.join(cwd, ".pi", "evolution");
  const runDir = path.join(evolutionDir, "runs", runId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, "run.json"), JSON.stringify({ runId, status: "reviewed", dispatchedAt: NOW }), "utf8");
  fs.writeFileSync(path.join(runDir, "02-proposal.json"), JSON.stringify({ type: "improve", skill: "demo" }), "utf8");
  fs.writeFileSync(path.join(runDir, "02-proposal.diff"), BODY_DIFF, "utf8");
  return { cwd, evolutionDir, skillAbs, runDir };
}

function tools(fixture: Fixture) {
  return createApplyTools({
    evolutionDir: fixture.evolutionDir,
    cwd: fixture.cwd,
    queue: directQueue,
    now: () => NOW,
    log: () => {},
    git: () => ({ code: 0, out: "" }),
    loadDiagnostics: () => [],
    runMdCheck: () => ({ code: 0, output: "" }),
    // 开关默认全开：拒绝侧的用例只关心队列/run 状态，不该被自动采纳开关挡住
    flags: () => ({ autoReview: true, autoApply: true }),
  });
}

async function seedQueue(fixture: Fixture): Promise<void> {
  await saveGate0(fixture.evolutionDir, { at: NOW, status: "", diff: "" }, directQueue);
  const added = await tools(fixture).enqueueReady();
  assert.equal(added, 1, "前置条件：正文改动应入队一条");
  // 正文改动现在默认 auto；这条用例测的是「人拒绝」，把级别抬成 approval 才走人工路径
  const file = path.join(fixture.evolutionDir, "queue.json");
  const list = JSON.parse(fs.readFileSync(file, "utf8")) as { runId: string; level?: string }[];
  for (const item of list) if (item.runId === "run-body") item.level = "approval";
  fs.writeFileSync(file, JSON.stringify(list), "utf8");
}

function runStatus(fixture: Fixture): string {
  return JSON.parse(fs.readFileSync(path.join(fixture.runDir, "run.json"), "utf8")).status as string;
}

test("reject：队列条目转 rejected，run.json 转 rejected，技能文件一字未动", async () => {
  const fixture = setup();
  await seedQueue(fixture);
  assert.equal(readQueue(fixture.evolutionDir)[0]?.level, "approval");

  const text = await tools(fixture).reject("run-body");
  assert.match(text, /已拒绝 run-body/);
  assert.match(text, /技能文件未改动/);

  const item = readQueue(fixture.evolutionDir)[0];
  assert.equal(item?.status, "rejected");
  assert.match(item?.detail ?? "", /人主动拒绝/);
  assert.equal(runStatus(fixture), "rejected");
  // 拒绝的核心承诺：技能文件一个字节都不变
  assert.equal(fs.readFileSync(fixture.skillAbs, "utf8"), SKILL_TEXT);
  // 闸0 快照也不该被拒绝动作刷新
  assert.equal((await readGate0(fixture.evolutionDir))?.at, NOW);
  assert.equal(fs.existsSync(gate0Path(fixture.evolutionDir)), true);
});

test("reject：队列里没有这个 runId → 回人话，不动任何状态", async () => {
  const fixture = setup();
  await seedQueue(fixture);
  const text = await tools(fixture).reject("run-nope");
  assert.match(text, /队列里没有 run-nope/);
  assert.equal(readQueue(fixture.evolutionDir)[0]?.status, "pending");
  assert.equal(runStatus(fixture), "reviewed");
});

test("reject：空 runId → 只回用法，不猜目标", async () => {
  const fixture = setup();
  await seedQueue(fixture);
  const text = await tools(fixture).reject("");
  assert.match(text, /用法/);
  assert.equal(readQueue(fixture.evolutionDir)[0]?.status, "pending");
});

test("reject：已 applied 的条目不能再拒绝（幂等不靠猜）", async () => {
  const fixture = setup();
  await seedQueue(fixture);
  const queueFile = path.join(fixture.evolutionDir, "queue.json");
  const items = JSON.parse(fs.readFileSync(queueFile, "utf8")) as Record<string, unknown>[];
  items[0]!.status = "applied";
  fs.writeFileSync(queueFile, JSON.stringify(items), "utf8");

  const text = await tools(fixture).reject("run-body");
  assert.match(text, /当前状态是 applied，只有 pending 能拒绝/);
  assert.equal(runStatus(fixture), "reviewed", "run.json 保持评审通过，不被一次无效拒绝改写");
});

test("reject：run.json 丢了也能拒（队列先转 rejected，不留下永远 pending 的条目）", async () => {
  const fixture = setup();
  await seedQueue(fixture);
  fs.rmSync(path.join(fixture.runDir, "run.json"));

  const text = await tools(fixture).reject("run-body");
  assert.match(text, /只改了队列状态/);
  assert.equal(readQueue(fixture.evolutionDir)[0]?.status, "rejected");
});

test("queueText：拒绝后条目归到 rejected 组，不再算待批", async () => {
  const fixture = setup();
  await seedQueue(fixture);
  await tools(fixture).reject("run-body");
  const text = await tools(fixture).queueText();
  assert.match(text, /rejected 1 条/);
  assert.equal(/pending 1 条/.test(text), false);
});
