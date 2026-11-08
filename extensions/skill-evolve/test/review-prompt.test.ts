/**
 * 评审 prompt 组装单测：独立性靠「给什么」保证，所以这里断言的是「没给什么」。
 *
 * 设计稿 12.1 硬约束②：只给改后全文 + diff + 硬禁令 + 验收标准，
 * findings / rationale 一旦混进来，评审就会顺着提案者的话往下点头。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ACCEPTANCE_STANDARDS, buildReviewPrompt } from "../lib/review-prompt.ts";

const DIFF = [
  "--- a/.pi/skills/demo/SKILL.md",
  "+++ b/.pi/skills/demo/SKILL.md",
  "@@ -3,1 +3,1 @@",
  "-description: 处理各种事情",
  "+description: 检索日志时用 rg，禁止 find 全盘扫",
].join("\n");

const SKILL_TEXT = ["---", "name: demo", "description: 检索日志时用 rg，禁止 find 全盘扫", "---", "正文"].join("\n");

const RULES = [
  { id: "rg-over-find", level: "P0", expect: "禁止用 find 全盘扫描" },
  { id: "no-golden-midscene", level: "P0", expect: "不写 golden 截图" },
];

test("prompt 里不含复盘产物，也不含 rationale 字段", () => {
  const prompt = buildReviewPrompt({
    skillName: "demo",
    skillText: SKILL_TEXT,
    diffApplied: true,
    diff: DIFF,
    hardRules: RULES,
  });
  assert.ok(!prompt.includes("01-findings"), "不得出现 01-findings");
  assert.ok(!prompt.includes("rationale"), "不得出现 rationale 字样");
  assert.ok(!prompt.includes("02-proposal"), "不得出现 02-proposal 路径");
});

test("prompt 含全部硬禁令 ruleId 与 expect，且 diff 原样出现", () => {
  const prompt = buildReviewPrompt({
    skillName: "demo",
    skillText: SKILL_TEXT,
    diffApplied: true,
    diff: DIFF,
    hardRules: RULES,
  });
  for (const rule of RULES) {
    assert.ok(prompt.includes(rule.id), `缺规则 ${rule.id}`);
    assert.ok(prompt.includes(rule.expect), `缺规则说明 ${rule.id}`);
  }
  assert.ok(prompt.includes(DIFF), "diff 必须原样出现");
  assert.ok(prompt.includes("rg-over-find") && prompt.includes("P0"));
});

test("验收标准四条全部写入 prompt", () => {
  const prompt = buildReviewPrompt({
    skillName: "demo",
    skillText: SKILL_TEXT,
    diffApplied: true,
    diff: DIFF,
    hardRules: RULES,
  });
  for (const line of ACCEPTANCE_STANDARDS) assert.ok(prompt.includes(line), `缺验收标准：${line}`);
});

test("apply 失败时明说「只有 diff 可信」，不冒充改后全文", () => {
  const prompt = buildReviewPrompt({
    skillName: "demo",
    skillText: SKILL_TEXT,
    diffApplied: false,
    diff: DIFF,
    hardRules: RULES,
  });
  assert.match(prompt, /改动前/);
  assert.match(prompt, /只有上面的 diff 可信/);
});

test("CompiledRule 形态也能渲染出匹配模式", () => {
  const prompt = buildReviewPrompt({
    skillName: "demo",
    skillText: SKILL_TEXT,
    diffApplied: true,
    diff: DIFF,
    hardRules: [{ rule: { id: "rg-over-find", level: "P0", pattern: "\\bfind\\b", expect: "禁止 find" }, regex: /x/ }],
  });
  assert.ok(prompt.includes("rg-over-find"));
  assert.ok(prompt.includes("\\bfind\\b"));
});

test("空禁令列表给出明确文案而不是留白", () => {
  const prompt = buildReviewPrompt({
    skillName: "demo",
    skillText: SKILL_TEXT,
    diffApplied: true,
    diff: DIFF,
    hardRules: [],
  });
  assert.match(prompt, /没有可注入的硬约束/);
});

test("verdict 语义写进 prompt：能改的小毛病不许判 reject（真实自检第一跑就栽在这）", () => {
  const prompt = buildReviewPrompt({ skillName: "demo", skillText: "正文", diffApplied: true, diff: "+++ b/x\n", hardRules: [] });
  assert.match(prompt, /revise：方向可以接受/);
  assert.match(prompt, /reject：删掉了原有的明确禁止项/);
});
