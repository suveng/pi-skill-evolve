/**
 * G3 机械硬禁令扫描单测（零依赖，node --test）。
 *
 * 运行：
 *   cd .pi/extensions/skill-evolve
 *   node --experimental-strip-types --test test/hard-rules.test.ts
 *
 * 覆盖：坏正则不许拖垮整条链路、行号是 1 基物理行号、allow 豁免生效、
 * 以及仓库里那份 hard-rules.json 本身是可用的（6 条 P0、字段齐全）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { compileRules, listSkillDirs, loadHardRules, scanSkillsDir, scanText } from "../lib/hard-rules.ts";

const REPO = "/home/suveng/doger/ev/vkk_client_flutter";
const RULES_FILE = path.join(REPO, ".pi/evolution/rules/hard-rules.json");

test("仓库自带的 hard-rules.json 能编译：6 条 P0、无坏规则、字段齐全", () => {
  const loaded = loadHardRules(RULES_FILE);
  assert.deepEqual(loaded.invalid, []);
  assert.equal(loaded.compiled.length, 6);
  for (const item of loaded.compiled) {
    assert.equal(item.rule.level, "P0", `${item.rule.id} 必须是 P0`);
    assert.ok(item.rule.expect.length > 0, `${item.rule.id} 缺 expect`);
    assert.ok((item.rule.why ?? "").length > 0, `${item.rule.id} 缺 why`);
  }
});

test("坏正则只丢掉那一条，其余规则照跑", () => {
  const result = compileRules({
    rules: [
      { id: "good", level: "P0", pattern: "违规", expect: "x", why: "y" },
      { id: "broken", level: "P0", pattern: "([", expect: "x", why: "y" },
    ],
  });
  assert.equal(result.compiled.length, 1);
  assert.equal(result.compiled[0].rule.id, "good");
  assert.equal(result.invalid.length, 1);
  assert.match(result.invalid[0], /^broken: 正则编译失败/);
});

test("缺 pattern 的规则记 invalid 且不抛", () => {
  const result = compileRules({ rules: [{ id: "naked" }] });
  assert.equal(result.compiled.length, 0);
  assert.deepEqual(result.invalid, ["naked: 缺 pattern"]);
});

test("扫描：行号是 1 基物理行号，quote 是当行原文", () => {
  const rules = compileRules({ rules: [{ id: "r", level: "P0", pattern: "grep -r" }] }).compiled;
  const text = ["# 标题", "", "正常一行", "用 grep -r 搜全仓"].join("\n");
  const hits = scanText(text, rules, "demo");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].line, 4);
  assert.equal(hits[0].skill, "demo");
  assert.equal(hits[0].ruleId, "r");
  assert.equal(hits[0].level, "P0");
  assert.equal(hits[0].quote, "用 grep -r 搜全仓");
});

test("扫描：allow 命中时豁免（本仓技能大量写「禁止 grep -r」）", () => {
  const rules = compileRules({
    rules: [{ id: "r", level: "P0", pattern: "grep -r", allow: "禁止" }],
  }).compiled;
  const text = ["禁止 grep -r，必须用 rg", "用 grep -r 搜"].join("\n");
  const hits = scanText(text, rules, "demo");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].line, 2);
});

test("扫描：一条行同时命中两条规则时都给（不互斥）", () => {
  const rules = compileRules({
    rules: [
      { id: "first", level: "P0", pattern: "golden" },
      { id: "second", level: "P0", pattern: "允许" },
    ],
  }).compiled;
  const hits = scanText("允许写 golden 测试", rules, "demo");
  assert.deepEqual(hits.map((hit) => hit.ruleId).sort(), ["first", "second"]);
  assert.ok(hits.every((hit) => hit.line === 1));
});

test("规则文件缺失 / JSON 坏都只返回 invalid", () => {
  const missing = loadHardRules(path.join(os.tmpdir(), "不存在的规则文件.json"));
  assert.equal(missing.compiled.length, 0);
  assert.match(missing.invalid[0], /规则文件不存在/);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hard-rules-"));
  const broken = path.join(dir, "broken.json");
  fs.writeFileSync(broken, "{ 坏 json", "utf8");
  const parsed = loadHardRules(broken);
  assert.equal(parsed.compiled.length, 0);
  assert.match(parsed.invalid[0], /JSON 解析失败/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("scanSkillsDir：只扫 */SKILL.md，读不到的文件跳过不抛", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skills-"));
  fs.mkdirSync(path.join(dir, "one"), { recursive: true });
  fs.writeFileSync(path.join(dir, "one/SKILL.md"), "# one\n允许写 golden 测试\n", "utf8");
  fs.mkdirSync(path.join(dir, "README"), { recursive: true });
  fs.mkdirSync(path.join(dir, "two"), { recursive: true });
  fs.writeFileSync(path.join(dir, "two/notes.md"), "允许写 golden 测试\n", "utf8");

  const rules = compileRules({ rules: [{ id: "golden", level: "P0", pattern: "允许.{0,6}golden" }] }).compiled;
  const scan = scanSkillsDir(dir, rules);
  assert.equal(scan.hits.length, 1);
  assert.equal(scan.hits[0].skill, "one");
  assert.equal(scan.hits[0].line, 2);
  assert.deepEqual(scan.invalid, []);
  assert.deepEqual(listSkillDirs(dir), ["README", "one", "two"]); // 码位排序，大写在前
  fs.rmSync(dir, { recursive: true, force: true });
});
