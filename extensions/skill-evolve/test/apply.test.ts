/**
 * 五道闸单测（13.2）：逐闸失败各一条 + 成功路径 + 回滚逐字节还原。
 *
 * 全部在临时目录里跑：`.pi/skills` 只允许被测试的临时副本碰，真仓库一个字节都不动。
 * git / md-check / commit 都是注入点，测试里绝不起真实子进程。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { APPLIED_DIFF_FILE, VERIFY_FILE, appliedDiffFile, applyRun, readVerify, verifyFile } from "../lib/apply.ts";
import type { GateDeps } from "../lib/apply-gates.ts";
import { backupDir, cleanupBackups, runGates } from "../lib/apply-gates.ts";
import { planTargets } from "../lib/apply-targets.ts";
import { saveGate0 } from "../lib/gate0.ts";
import type { QueueItem } from "../lib/queue.ts";
import { directQueue } from "../lib/telemetry.ts";

const NOW = 1_760_000_000_000;
const SKILL_REL = ".pi/skills/demo/SKILL.md";
const SKILL_TEXT = "---\nname: demo\ndescription: 演示技能\n---\n\n## 步骤\n1. 先读文档\n";
const DIFF = `--- a/${SKILL_REL}\n+++ b/${SKILL_REL}\n@@ -3,1 +3,1 @@\n-description: 演示技能\n+description: 演示技能（改后）\n`;

interface Fixture {
  cwd: string;
  evolutionDir: string;
  runDir: string;
  skillAbs: string;
}

function setup(options: { type?: string; diff?: string; skillText?: string } = {}): Fixture {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "skill-evolve-apply-"));
  const evolutionDir = path.join(cwd, ".pi", "evolution");
  const runDir = path.join(evolutionDir, "runs", "run-1");
  const skillAbs = path.join(cwd, SKILL_REL);
  fs.mkdirSync(path.dirname(skillAbs), { recursive: true });
  fs.writeFileSync(skillAbs, options.skillText ?? SKILL_TEXT, "utf8");
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, "02-proposal.json"), JSON.stringify({ type: options.type ?? "improve", skill: "demo" }), "utf8");
  fs.writeFileSync(path.join(runDir, "02-proposal.diff"), options.diff ?? DIFF, "utf8");
  return { cwd, evolutionDir, runDir, skillAbs };
}

function item(over: Partial<QueueItem> = {}): QueueItem {
  return { runId: "run-1", level: "auto", skill: "demo", targets: [SKILL_REL], createdAt: NOW, status: "pending", proposalType: "improve", ...over };
}

/** git 假实现：默认干净（status / diff 都空串） */
function fakeGit(status = "", diff = "") {
  return (args: string[]) => ({ code: 0, out: args[0] === "status" ? status : diff });
}

function deps(fixture: Fixture, over: Partial<GateDeps> = {}): GateDeps {
  return {
    evolutionDir: fixture.evolutionDir,
    cwd: fixture.cwd,
    runId: "run-1",
    queue: directQueue,
    now: () => NOW,
    log: () => {},
    git: fakeGit(),
    loadDiagnostics: () => [],
    runMdCheck: () => ({ code: 0, output: "" }),
    ...over,
  };
}

async function seedGate0(fixture: Fixture, status = "", diff = ""): Promise<void> {
  await saveGate0(fixture.evolutionDir, { at: NOW, status, diff }, directQueue);
}

test("成功路径：五闸全绿，文件真改成 after，05 与 06 都落盘", async () => {
  const fixture = setup();
  await seedGate0(fixture);
  const outcome = await applyRun(item(), deps(fixture));
  assert.equal(outcome.status, "applied");
  assert.deepEqual(outcome.gates.map((gate) => gate.gate), ["gate0", "gate1", "gate2", "gate3", "gate4"]);
  assert.equal(fs.readFileSync(fixture.skillAbs, "utf8"), SKILL_TEXT.replace("演示技能\n", "演示技能（改后）\n"));

  const applied = fs.readFileSync(appliedDiffFile(fixture.runDir), "utf8");
  assert.match(applied, /^\+\+\+ b\/\.pi\/skills\/demo\/SKILL\.md$/m);
  assert.match(applied, /^\+description: 演示技能（改后）$/m);
  const verify = readVerify(fixture.runDir);
  assert.equal(verify?.status, "applied");
  assert.equal(verify?.gates.length, 5);
  assert.deepEqual(verify?.wrote, [SKILL_REL]);
  assert.equal(fs.existsSync(verifyFile(fixture.runDir)), true);
  assert.equal(APPLIED_DIFF_FILE, "05-applied.diff");
  assert.equal(VERIFY_FILE, "06-verify.json");
});

test("闸1 把改动前的原文备份到 backups/<runId>/<相对路径>", async () => {
  const fixture = setup();
  await seedGate0(fixture);
  await applyRun(item(), deps(fixture));
  const backup = path.join(backupDir(fixture.evolutionDir, "run-1"), SKILL_REL);
  assert.equal(fs.readFileSync(backup, "utf8"), SKILL_TEXT);
});

test("闸0 多出改动（会话起点后 .pi/skills 被改过）→ unauthorized_write，一个字节都不写", async () => {
  const fixture = setup();
  await seedGate0(fixture);
  const outcome = await applyRun(item(), deps(fixture, { git: fakeGit(" M .pi/skills/demo/SKILL.md") }));
  assert.equal(outcome.status, "unauthorized_write");
  assert.deepEqual(outcome.wrote, []);
  assert.equal(fs.readFileSync(fixture.skillAbs, "utf8"), SKILL_TEXT);
  assert.equal(fs.existsSync(appliedDiffFile(fixture.runDir)), false);
  assert.match(outcome.detail ?? "", /闸0/);
  assert.equal(readVerify(fixture.runDir)?.status, "unauthorized_write");
});

test("闸0 没有会话起点快照 → 同样拒采（宁可拒采，不赌）", async () => {
  const fixture = setup();
  const outcome = await applyRun(item(), deps(fixture));
  assert.equal(outcome.status, "unauthorized_write");
  assert.equal(fs.readFileSync(fixture.skillAbs, "utf8"), SKILL_TEXT);
});

test("闸1 备份写不进去（backups 路径被占成文件）→ failed，不写目标文件", async () => {
  const fixture = setup();
  await seedGate0(fixture);
  const blocker = backupDir(fixture.evolutionDir, "run-1");
  fs.mkdirSync(path.dirname(blocker), { recursive: true });
  fs.writeFileSync(blocker, "占位", "utf8");
  const outcome = await applyRun(item(), deps(fixture));
  assert.equal(outcome.status, "failed");
  assert.match(outcome.detail ?? "", /闸1/);
  assert.equal(fs.readFileSync(fixture.skillAbs, "utf8"), SKILL_TEXT);
});

test("闸2 原子写失败 → failed，磁盘内容不变（写入前 gate2 就抛，wrote 为空）", async () => {
  const fixture = setup();
  await seedGate0(fixture);
  const queue = async <T>(file: string, run: () => Promise<T>): Promise<T> => {
    if (file === fixture.skillAbs) throw new Error("模拟磁盘忙");
    return run();
  };
  const outcome = await applyRun(item(), deps(fixture, { queue }));
  assert.equal(outcome.status, "failed");
  assert.match(outcome.detail ?? "", /闸2/);
  assert.equal(fs.readFileSync(fixture.skillAbs, "utf8"), SKILL_TEXT);
});

test("闸3 diagnostics 非空 → rolled-back，文件逐字节还原", async () => {
  const fixture = setup();
  await seedGate0(fixture);
  const before = fs.readFileSync(fixture.skillAbs);
  const outcome = await applyRun(item(), deps(fixture, { loadDiagnostics: () => [{ path: SKILL_REL, message: "frontmatter 缺 description" }] }));
  assert.equal(outcome.status, "rolled-back");
  assert.match(outcome.detail ?? "", /diagnostics 非空/);
  assert.deepEqual(fs.readFileSync(fixture.skillAbs), before);
});

test("闸3 md-check 退出码非 0 → rolled-back", async () => {
  const fixture = setup();
  await seedGate0(fixture);
  const outcome = await applyRun(item(), deps(fixture, { runMdCheck: () => ({ code: 2, output: "P1 标题层级跳级" }) }));
  assert.equal(outcome.status, "rolled-back");
  assert.match(outcome.detail ?? "", /md-check 失败/);
  assert.equal(fs.readFileSync(fixture.skillAbs, "utf8"), SKILL_TEXT);
});

test("闸4 只提示「新会话生效」，不 reload", async () => {
  const fixture = setup();
  await seedGate0(fixture);
  const outcome = await applyRun(item(), deps(fixture));
  const gate4 = outcome.gates.find((gate) => gate.gate === "gate4");
  assert.equal(gate4?.ok, true);
  assert.match(gate4?.detail ?? "", /新会话生效/);
});

test("auto 级 commit 失败 → 回滚该条（文件还原、状态 rolled-back）", async () => {
  const fixture = setup();
  await seedGate0(fixture);
  const outcome = await applyRun(item({ level: "auto" }), deps(fixture, { commit: () => ({ ok: false, detail: "hook 拒绝" }) }));
  assert.equal(outcome.status, "rolled-back");
  assert.match(outcome.detail ?? "", /commit 失败/);
  assert.equal(fs.readFileSync(fixture.skillAbs, "utf8"), SKILL_TEXT);
});

test("auto 级 commit 成功 → outcome.commit 记短 hash", async () => {
  const fixture = setup();
  await seedGate0(fixture);
  const outcome = await applyRun(item({ level: "auto" }), deps(fixture, { commit: () => ({ ok: true, hash: "abc1234" }) }));
  assert.equal(outcome.status, "applied");
  assert.equal(outcome.commit, "abc1234");
});

test("approval 级即使给了 commit 也不调用（不自动提交）", async () => {
  const fixture = setup();
  await seedGate0(fixture);
  let called = 0;
  const outcome = await applyRun(item({ level: "approval" }), deps(fixture, { commit: () => { called += 1; return { ok: true, hash: "x" }; } }));
  assert.equal(outcome.status, "applied");
  assert.equal(called, 0);
});

test("新建技能缺引用面（无 .cursor stub / 无 AGENTS.md 索引行）→ 闸3 rolled-back 并删掉新文件", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "skill-evolve-apply-create-"));
  const evolutionDir = path.join(cwd, ".pi", "evolution");
  const runDir = path.join(evolutionDir, "runs", "run-1");
  const newRel = ".pi/skills/newbie/SKILL.md";
  const candidate = "---\nname: newbie\ndescription: 新技能\n---\n\n正文\n";
  fs.mkdirSync(path.join(runDir, "candidate", "newbie"), { recursive: true });
  fs.writeFileSync(path.join(runDir, "02-proposal.json"), JSON.stringify({ type: "create", skill: "newbie" }), "utf8");
  fs.writeFileSync(path.join(runDir, "02-proposal.diff"), `--- /dev/null\n+++ b/${newRel}\n@@ -0,0 +1,1 @@\n+占位\n`, "utf8");
  fs.writeFileSync(path.join(runDir, "candidate", "newbie", "SKILL.md"), candidate, "utf8");
  const fixture: Fixture = { cwd, evolutionDir, runDir, skillAbs: path.join(cwd, newRel) };
  await seedGate0(fixture);
  const outcome = await applyRun(item({ skill: "newbie", targets: [newRel], proposalType: "create" }), deps(fixture));
  assert.equal(outcome.status, "rolled-back");
  assert.match(outcome.detail ?? "", /引用面/);
  assert.equal(fs.existsSync(path.join(cwd, newRel)), false);
});

test("提案目录不可用（无 02-proposal.json）→ failed 且不写盘", async () => {
  const fixture = setup();
  fs.rmSync(path.join(fixture.runDir, "02-proposal.json"));
  const outcome = await applyRun(item(), deps(fixture));
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.gates.length, 0);
  assert.equal(fs.readFileSync(fixture.skillAbs, "utf8"), SKILL_TEXT);
});

test("planTargets 规划出 before / after，且 diff 应用不上时如实失败", async () => {
  const fixture = setup();
  const plan = planTargets(fixture.runDir, fixture.cwd);
  assert.equal(plan.ok, true);
  assert.equal(plan.targets[0]?.before, SKILL_TEXT);
  assert.match(plan.targets[0]?.after ?? "", /改后/);

  const broken = setup({ diff: `--- a/${SKILL_REL}\n+++ b/${SKILL_REL}\n@@ -3,1 +3,1 @@\n-description: 对不上\n+description: 新\n` });
  const failed = planTargets(broken.runDir, broken.cwd);
  assert.equal(failed.ok, false);
  assert.match(failed.reason ?? "", /不一致/);
});

test("排除删除提案：+++ /dev/null 不在这里执行（删技能必须走 --prune 人批）", async () => {
  const fixture = setup({ diff: `--- a/${SKILL_REL}\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-第一行\n` });
  const plan = planTargets(fixture.runDir, fixture.cwd);
  assert.equal(plan.ok, false);
  assert.match(plan.reason ?? "", /--prune/);
});

test("runGates 备份清理只删超过 30 天的目录", () => {
  const fixture = setup();
  const root = path.join(fixture.evolutionDir, "backups");
  const oldDir = path.join(root, "old");
  const freshDir = path.join(root, "fresh");
  fs.mkdirSync(oldDir, { recursive: true });
  fs.mkdirSync(freshDir, { recursive: true });
  const old = new Date(NOW - 40 * 86_400_000);
  fs.utimesSync(oldDir, old, old);
  const messages: string[] = [];
  assert.equal(cleanupBackups(fixture.evolutionDir, NOW, (msg) => messages.push(msg)), 1);
  assert.equal(fs.existsSync(oldDir), false);
  assert.equal(fs.existsSync(freshDir), true);
  assert.equal(messages.length, 1);
});

test("runGates 闸2 前会复核磁盘内容：中途被改过就拒写，不给别人覆盖", async () => {
  const fixture = setup();
  await seedGate0(fixture);
  const queue = async <T>(file: string, run: () => Promise<T>): Promise<T> => {
    // 备份阶段之后、写盘之前把文件改掉：模拟并发编辑
    if (file.endsWith(SKILL_REL) && !fs.readFileSync(fixture.skillAbs, "utf8").includes("并发")) {
      fs.writeFileSync(fixture.skillAbs, `${SKILL_TEXT}并发编辑\n`, "utf8");
    }
    return run();
  };
  const plan = planTargets(fixture.runDir, fixture.cwd);
  assert.equal(plan.ok, true);
  const run = await runGates(deps(fixture, { queue }), plan.targets);
  assert.equal(run.ok, false);
  assert.match(run.detail ?? "", /磁盘内容与计划不一致/);
  assert.equal(fs.readFileSync(fixture.skillAbs, "utf8").includes("并发编辑"), true);
});
