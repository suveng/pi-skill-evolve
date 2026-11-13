/**
 * 分级采纳的代码判定单测（13.1）：只看 diff 真改了什么，不看模型写的 action。
 *
 * 重点是边界：只改 description 才能 auto；同时碰正文就退成 approval；
 * 路径越界 / 删文件 / 改 frontmatter 语义字段一律 forbidden。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyAction, classifyChange, parseSections } from "../lib/classify-action.ts";

function diff(path: string, body: string, oldPath = path, created = false): string {
  const head = `--- ${created ? "/dev/null" : `a/${oldPath}`}\n+++ b/${path}\n@@ -1,3 +1,3 @@\n`;
  return `${head}${body}\n`;
}

const SKILL = ".pi/skills/deploy-test/SKILL.md";

test("只改 description 一行 → auto", () => {
  const result = classifyChange({
    diffText: diff(SKILL, "-description: 部署测试服\n+description: 部署测服并给出验收清单"),
    proposalType: "improve",
    skill: "deploy-test",
  });
  assert.equal(result.level, "auto");
  assert.deepEqual(result.targets, [SKILL]);
});

test("description 连正文一起改 → auto（正文与 description 同等授权）", () => {
  const result = classifyChange({
    diffText: diff(SKILL, "-description: 部署测试服\n+description: 部署测服并给出验收清单\n-禁止 pkill -f\n+禁止用 pkill -f"),
    proposalType: "improve",
    skill: "deploy-test",
  });
  assert.equal(result.level, "auto");
});

test("description 续行（缩进 ≥2）与纯空白改动仍算 auto", () => {
  const result = classifyChange({
    diffText: diff(SKILL, "-description: 部署测试服\n+description: 部署测试服，\n+  并在成功后给出验收清单\n-  \n+  "),
    proposalType: "improve",
    skill: "deploy-test",
  });
  assert.equal(result.level, "auto");
});

test("技能目录下的附属文件（notes.md）不再是越界：允许改，自动采纳", () => {
  const result = classifyChange({
    diffText: diff(".pi/skills/deploy-test/notes.md", "-旧\n+新"),
    proposalType: "improve",
    skill: "deploy-test",
  });
  assert.equal(result.level, "auto");
});

test("删除技能文件（+++ /dev/null）→ forbidden", () => {
  const text = `--- a/${SKILL}\n+++ /dev/null\n@@ -1,1 +0,0 @@\n--description: x\n`;
  assert.equal(classifyChange({ diffText: text, proposalType: "improve", skill: "deploy-test" }).level, "forbidden");
});

test("改 frontmatter 的 name / allowed-tools / disable-model-invocation → forbidden", () => {
  for (const field of ["name: 别的名字", "allowed-tools: bash", "disable-model-invocation: true"]) {
    const result = classifyChange({
      diffText: diff(SKILL, `-旧值\n+${field}`),
      proposalType: "improve",
      skill: "deploy-test",
    });
    assert.equal(result.level, "forbidden", `${field} 应 forbidden`);
  }
});

test("动插件自身目录 → forbidden", () => {
  const result = classifyChange({
    diffText: diff(".pi/extensions/skill-evolve/prompts/复盘.md", "-旧\n+新"),
    proposalType: "improve",
    skill: "skill-evolve",
  });
  assert.equal(result.level, "forbidden");
  assert.match(result.reasons[0] ?? "", /插件自身/);
});

test("prune（删技能提案）不论 diff 内容都 forbidden：插件只出清单不真删", () => {
  const result = classifyChange({ diffText: diff(SKILL, "-旧\n+新"), proposalType: "prune", skill: "deploy-test" });
  assert.equal(result.level, "forbidden");
  assert.match(result.reasons[0] ?? "", /prune/);
});

test("新建 .cursor 路由 stub → auto", () => {
  const text = `--- /dev/null\n+++ b/.cursor/skills/new-skill/SKILL.md\n@@ -0,0 +1,3 @@\n+唯一 SSOT：.pi/skills/new-skill/SKILL.md\n+动手前先 Read 它\n+# 路由\n`;
  const result = classifyChange({ diffText: text, proposalType: "create", skill: "new-skill" });
  assert.equal(result.level, "auto");
  assert.deepEqual(result.targets, [".cursor/skills/new-skill/SKILL.md"]);
});

test("AGENTS.md 索引表只增一行 → auto；增两行 → approval", () => {
  const one = diff("AGENTS.md", "+- `new-skill` —— `.pi/skills/new-skill/SKILL.md`");
  assert.equal(classifyChange({ diffText: one, proposalType: "create", skill: "new-skill" }).level, "auto");
  const two = diff("AGENTS.md", "+- `new-skill` —— `.pi/skills/new-skill/SKILL.md`\n+- `other` —— `.pi/skills/other/SKILL.md`");
  assert.equal(classifyChange({ diffText: two, proposalType: "create", skill: "new-skill" }).level, "approval");
});

test("新增技能正文（.pi/skills/<新名>/SKILL.md 纯新建）→ approval", () => {
  const text = `--- /dev/null\n+++ b/.pi/skills/new-skill/SKILL.md\n@@ -0,0 +1,2 @@\n+---\n+description: 新技能\n`;
  assert.equal(classifyChange({ diffText: text, proposalType: "create", skill: "new-skill" }).level, "approval");
});

test("空 diff / 无增删行 → approval（判不动就不许自动写盘）", () => {
  assert.equal(classifyChange({ diffText: "", proposalType: "improve", skill: "x" }).level, "approval");
  const onlyContext = `--- a/${SKILL}\n+++ b/${SKILL}\n@@ -1,1 +1,1 @@\n 只有上下文\n`;
  assert.equal(classifyChange({ diffText: onlyContext, proposalType: "improve", skill: "x" }).level, "approval");
});

test("多文件 diff 逐段判：技能文件 + 同 skill 的 .cursor stub 都只改描述/新建 → 仍 auto 需逐段合规", () => {
  const text =
    `--- a/${SKILL}\n+++ b/${SKILL}\n@@ -1,1 +1,1 @@\n-description: 旧\n+description: 新\n` +
    `--- /dev/null\n+++ b/.cursor/skills/deploy-test/SKILL.md\n@@ -0,0 +1,1 @@\n+唯一 SSOT\n`;
  const result = classifyChange({ diffText: text, proposalType: "improve", skill: "deploy-test" });
  assert.equal(result.level, "auto");
  assert.deepEqual(result.targets, [SKILL, ".cursor/skills/deploy-test/SKILL.md"]);
});

test("parseSections 跳过头部元信息与 @@ / \\ 行，保留改动的符号", () => {
  const text = `diff --git a/${SKILL} b/${SKILL}\nindex 111..222 100644\n--- a/${SKILL}\n+++ b/${SKILL}\n@@ -1,2 +1,2 @@\n-old\n+new\n\\ No newline\n`;
  const sections = parseSections(text);
  assert.equal(sections.length, 1);
  assert.deepEqual(sections[0]?.lines.map((line) => line.sign), ["-", "+"]);
});

test("classifyAction 兼容旧调用面（只看级别）", () => {
  assert.equal(classifyAction(diff(SKILL, "-description: 旧\n+description: 新"), "improve"), "auto");
  assert.equal(classifyAction(diff(SKILL, "-正文\n+正文2"), "improve"), "auto");
  assert.equal(classifyAction(diff(SKILL, "-a\n+b"), "prune"), "forbidden");
});

test("references 与 scripts 允许改，且与 SKILL.md 同档自动采纳（2026-11-14 用户口径）", () => {
  const ref = classifyChange({
    diffText: diff(".pi/skills/deploy-test/references/checklist.md", "-旧清单\n+新清单"),
    proposalType: "improve",
    skill: "deploy-test",
  });
  assert.equal(ref.level, "auto");

  const script = classifyChange({
    diffText: diff(".pi/skills/deploy-test/scripts/deploy.sh", "-old\n+new"),
    proposalType: "improve",
    skill: "deploy-test",
  });
  assert.equal(script.level, "auto");

  // 技能目录里新建一个参考文件也自动采纳
  const created = classifyChange({
    diffText: diff(".pi/skills/deploy-test/references/new.md", "+# 新参考", "/dev/null", true),
    proposalType: "improve",
    skill: "deploy-test",
  });
  assert.equal(created.level, "auto");

  // 但「新建整份 SKILL.md」仍然被拦：它必然要写 name: 字段，按行判即时 forbidden
  const newSkill = classifyChange({
    diffText: diff(".pi/skills/brand-new/SKILL.md", "+---\n+name: brand-new", "/dev/null", true),
    proposalType: "create",
    skill: "brand-new",
  });
  assert.equal(newSkill.level, "forbidden");
});

test("技能目录之外仍然越界：`..`、绝对路径、别的技能树一律 forbidden", () => {
  for (const path of [
    ".pi/skills/../secrets.md",
    ".pi/skills/a/../../etc/passwd",
    "rust_server/src/x.rs",
    ".pi/evolution/config.json",
    ".pi/skills/.hidden/x.md",
  ]) {
    const verdict = classifyChange({ diffText: diff(path, "-a\n+b"), proposalType: "improve", skill: "a" });
    assert.equal(verdict.level, "forbidden", path);
  }
});
