/**
 * diff 应用单测：评审要看「改后全文」，diff 能不能精确落到基线上必须先证明。
 * 不支持模糊定位是刻意的——定位失败时宁可如实说失败，也不能拼出一份假的改后全文。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyUnifiedDiff } from "../lib/diff-apply.ts";

const BASE = ["---", "name: demo", "description: 旧描述", "---", "", "正文第一行", "正文第二行"].join("\n");

test("标准 hunk 精确替换并返回文件名", () => {
  const diff = ["--- a/.pi/skills/demo/SKILL.md", "+++ b/.pi/skills/demo/SKILL.md", "@@ -2,2 +2,2 @@", " name: demo", "-description: 旧描述", "+description: 新描述"].join("\n");
  const result = applyUnifiedDiff(BASE, diff);
  assert.equal(result.ok, true);
  assert.equal(result.file, ".pi/skills/demo/SKILL.md");
  assert.ok(result.text.includes("description: 新描述"));
  assert.ok(!result.text.includes("旧描述"));
  assert.ok(result.text.includes("正文第二行"));
});

test("行尾空白差异不算不匹配", () => {
  const diff = ["+++ b/.pi/skills/demo/SKILL.md", "@@ -3,1 +3,1 @@", "-description: 旧描述   ", "+description: 新描述"].join("\n");
  const result = applyUnifiedDiff(BASE, diff);
  assert.equal(result.ok, true);
});

test("基线对不上就返回 ok:false 并给原因", () => {
  const diff = ["+++ b/.pi/skills/demo/SKILL.md", "@@ -3,1 +3,1 @@", "-description: 完全不存在的行", "+description: 新描述"].join("\n");
  const result = applyUnifiedDiff(BASE, diff);
  assert.equal(result.ok, false);
  assert.match(result.reason ?? "", /不一致/);
});

test("空 diff 视为失败而不是返回原文", () => {
  const result = applyUnifiedDiff(BASE, "");
  assert.equal(result.ok, false);
  assert.equal(result.file, null);
});

test("多行增删都落到结果里", () => {
  const diff = ["+++ b/.pi/skills/demo/SKILL.md", "@@ -6,2 +6,3 @@", " 正文第一行", "-正文第二行", "+正文第二行（改）", "+新增第三行"].join("\n");
  const result = applyUnifiedDiff(BASE, diff);
  assert.equal(result.ok, true);
  assert.ok(result.text.includes("正文第二行（改）"));
  assert.ok(result.text.includes("新增第三行"));
});
