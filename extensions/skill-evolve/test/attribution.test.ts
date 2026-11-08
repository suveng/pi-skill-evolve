/**
 * G2 机械归因单测（零依赖，node --test）。
 *
 * 运行：
 *   cd .pi/extensions/skill-evolve
 *   node --experimental-strip-types --test test/attribution.test.ts
 *
 * 重点不是「每类能判出来」，而是**顺序**：A 与 E 同时成立必须判 A，E 与 semantic 同时成立必须判 E。
 * 顺序错了会得到「建议改写 description」这种最误导人的结论。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { CATEGORY_ORDER, DISPOSITIONS, classifyMechanical, classifyOne, type AttributionInput } from "../lib/attribution.ts";

const SKILLS = "/repo/.pi/skills";

function base(overrides: Partial<AttributionInput> = {}): AttributionInput {
  return {
    missed: ["target"],
    exposed: [{ name: "target", filePath: `${SKILLS}/target/SKILL.md` }],
    loadedFromPi: [{ name: "target", filePath: `${SKILLS}/target/SKILL.md` }],
    diagnostics: [],
    activeTools: ["read", "bash", "edit"],
    diskSkillNames: ["target"],
    ...overrides,
  };
}

test("A：disableModelInvocation=true", () => {
  const input = base({ exposed: [{ name: "target", filePath: `${SKILLS}/target/SKILL.md`, disabled: true }] });
  assert.equal(classifyOne("target", input).category, "A");
});

test("B：诊断里点到该技能的 file", () => {
  const input = base({
    diagnostics: [{ file: `${SKILLS}/target/SKILL.md`, message: "缺少 description", type: "warning" }],
  });
  assert.equal(classifyOne("target", input).category, "B");
});

test("B：诊断给的是相对路径也能对上（末端路径比较）", () => {
  const input = base({ diagnostics: [{ file: ".pi/skills/target/SKILL.md", message: "YAML 解析失败" }] });
  assert.equal(classifyOne("target", input).category, "B");
});

test("C：同名技能出现在两处", () => {
  const input = base({
    loadedFromPi: [
      { name: "target", filePath: `${SKILLS}/target/SKILL.md` },
      { name: "target", filePath: "/other/skills/target/SKILL.md" },
    ],
  });
  assert.equal(classifyOne("target", input).category, "C");
});

test("C：collision 诊断点名也算（名字是子串时不误判）", () => {
  const collision = base({
    loadedFromPi: [],
    diskSkillNames: [],
    diagnostics: [{ file: "", message: "Skill name collision: target 与 target-extra 冲突", type: "collision" }],
  });
  assert.equal(classifyOne("target", collision).category, "C");
  const unrelated = base({
    loadedFromPi: [],
    diskSkillNames: [],
    diagnostics: [{ file: "", message: "Skill name collision: schema 与 schema-v2", type: "collision" }],
  });
  // "a" 不能命中 "schema" 里的那个 a：词边界判定
  assert.equal(classifyOne("a", unrelated).category, "semantic");
});

test("D：磁盘上有目录但不在发现结果里", () => {
  const input = base({ loadedFromPi: [], diskSkillNames: ["target", "other"] });
  assert.equal(classifyOne("target", input).category, "D");
});

test("E：本轮 activeTools 既没 read 也没 bash", () => {
  const input = base({ activeTools: ["edit", "write"] });
  assert.equal(classifyOne("target", input).category, "E");
});

test("E：activeTools 为空表示没采到，不许判 E（退回 semantic）", () => {
  assert.equal(classifyOne("target", base({ activeTools: [] })).category, "semantic");
});

test("都不命中 → semantic", () => {
  assert.equal(classifyOne("target", base()).category, "semantic");
});

test("顺序：同时满足 A 与 E 时判 A", () => {
  const input = base({
    exposed: [{ name: "target", filePath: `${SKILLS}/target/SKILL.md`, disabled: true }],
    activeTools: ["edit"],
  });
  assert.equal(classifyOne("target", input).category, "A");
});

test("顺序：同时满足 E 与 semantic 时判 E", () => {
  assert.equal(classifyOne("target", base({ activeTools: ["edit"] })).category, "E");
});

test("顺序：同时满足 D 与 E 时判 D（范围问题比工具问题更根本）", () => {
  const input = base({ loadedFromPi: [], activeTools: ["edit"] });
  assert.equal(classifyOne("target", input).category, "D");
});

test("classifyMechanical 保持传入顺序，且每条都带 reason", () => {
  const input = base({
    missed: ["target", "second"],
    exposed: [
      { name: "target", filePath: `${SKILLS}/target/SKILL.md`, disabled: true },
      { name: "second", filePath: `${SKILLS}/second/SKILL.md` },
    ],
    loadedFromPi: [
      { name: "target", filePath: `${SKILLS}/target/SKILL.md` },
      { name: "second", filePath: `${SKILLS}/second/SKILL.md` },
    ],
    diskSkillNames: ["target", "second"],
  });
  const result = classifyMechanical(input);
  assert.deepEqual(result.map((item) => item.skill), ["target", "second"]);
  assert.deepEqual(result.map((item) => item.category), ["A", "semantic"]);
  assert.ok(result.every((item) => item.reason.length > 0));
});

test("六类都有展示标签，顺序固定 A~E → semantic", () => {
  assert.deepEqual([...CATEGORY_ORDER], ["A", "B", "C", "D", "E", "semantic"]);
  for (const category of CATEGORY_ORDER) {
    assert.ok(DISPOSITIONS[category].label.length > 0);
    assert.ok(DISPOSITIONS[category].action.length > 0);
  }
});
