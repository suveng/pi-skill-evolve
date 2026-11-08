/**
 * 技能文件识别单测（零依赖，node --test）。
 *
 * 运行：
 *   cd .pi/extensions/skill-evolve
 *   node --experimental-strip-types --test test/detect.test.ts
 *
 * 覆盖：read 的绝对/相对/带 @ 路径、非技能文件不误判、bash 命令带引号与不带引号、
 * 同一条命令里两个技能、以及路径以 `skills` 之外的目录名结尾时不误判。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { detectFromBash, detectFromRead, skillNameFromPath } from "../lib/detect.ts";

const CWD = "/home/suveng/doger/ev/vkk_client_flutter";

test("read：绝对路径命中技能", () => {
  const hit = detectFromRead(`${CWD}/.pi/skills/kb-test-map/SKILL.md`, CWD);
  assert.deepEqual(hit, { skill: "kb-test-map", how: "read", raw: `${CWD}/.pi/skills/kb-test-map/SKILL.md` });
});

test("read：相对路径按 cwd 解析成绝对路径", () => {
  const hit = detectFromRead(".pi/skills/fast-test/SKILL.md", CWD);
  assert.equal(hit?.skill, "fast-test");
  assert.equal(hit?.raw, `${CWD}/.pi/skills/fast-test/SKILL.md`);
});

test("read：带 @ 前缀与反斜杠路径同样命中", () => {
  assert.equal(detectFromRead("@.pi/skills/file-size/SKILL.md", CWD)?.skill, "file-size");
  assert.equal(detectFromRead("C:\\repo\\.pi\\skills\\file-size\\SKILL.md", CWD)?.skill, "file-size");
});

test("read：非技能文件不误判", () => {
  assert.equal(detectFromRead(".pi/skills/fast-test/reference.md", CWD), null);
  assert.equal(detectFromRead("AGENTS.md", CWD), null);
  assert.equal(detectFromRead("", CWD), null);
});

test("路径规则只认「父目录名 + SKILL.md」，是否真属曝光技能由上层过滤", () => {
  // 裸 `SKILL.md` 会被解析成 <cwd>/SKILL.md，父目录名是仓库名；它永远不会命中本轮的曝光清单，
  // 所以上层按 advertised 名字过滤后不会错记（见 evolution.ts 的 noteToolCall）
  assert.equal(detectFromRead("SKILL.md", CWD)?.skill, "vkk_client_flutter");
  assert.equal(skillNameFromPath("/repo/SKILL.md"), "repo");
  assert.equal(skillNameFromPath("/repo/.pi/skills/"), null);
  assert.equal(skillNameFromPath("/repo/.pi/skills/foo/assets/SKILL.md"), "assets");
});

test("bash：不带引号的 cat 命中", () => {
  const hits = detectFromBash("cat .pi/skills/kb-test-map/SKILL.md | head -40");
  assert.deepEqual(hits.map((hit) => hit.skill), ["kb-test-map"]);
  assert.equal(hits[0].how, "bash");
});

test("bash：带双引号/单引号同样命中", () => {
  assert.deepEqual(detectFromBash('sed -n "1,20p" ".pi/skills/fast-test/SKILL.md"').map((h) => h.skill), ["fast-test"]);
  assert.deepEqual(detectFromBash("rg -n 标题 '.pi/skills/git-workflow/SKILL.md'").map((h) => h.skill), ["git-workflow"]);
});

test("bash：绝对路径 + 一条命令里两个技能，按名字去重", () => {
  const hits = detectFromBash(
    `diff -u ${CWD}/.pi/skills/rust/SKILL.md /tmp/rust/SKILL.md && cat .pi/skills/rust/SKILL.md`,
  );
  assert.deepEqual(hits.map((hit) => hit.skill), ["rust"]);
});

test("bash：不含 SKILL.md 的命令直接返回空数组", () => {
  assert.deepEqual(detectFromBash("ls .pi/skills"), []);
  assert.deepEqual(detectFromBash("cat README.md"), []);
  assert.deepEqual(detectFromBash(""), []);
});
