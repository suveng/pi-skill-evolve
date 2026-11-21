/**
 * description 闸门单测：定位（单行裸标量）+ 长度（1024，与 pi 同一口径）。
 *
 * 这里只测纯函数；「提案校验 / 闸3 复验真的会拦」在 proposal.test.ts 与 apply.test.ts 各一条。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkDescription,
  DESCRIPTION_ADVICE,
  descriptionValueOf,
  MAX_DESCRIPTION_LENGTH,
} from "../lib/description-limit.ts";

function skill(description: string): string {
  return `---\nname: demo\ndescription: ${description}\n---\n\n## 步骤\n1. 先读文档\n`;
}

test("1024 字刚好通过（中文按 1 字算，与 pi 的 description.length 同口径）", () => {
  const check = checkDescription(skill("中".repeat(MAX_DESCRIPTION_LENGTH)));
  assert.equal(check.ok, true);
  assert.equal(check.length, MAX_DESCRIPTION_LENGTH);
});

test("1025 字判失败：detail 写清超多少 + 该怎么改（压缩摘要而不是追加）", () => {
  const check = checkDescription(skill("中".repeat(MAX_DESCRIPTION_LENGTH + 1)));
  assert.equal(check.ok, false);
  assert.equal(check.length, MAX_DESCRIPTION_LENGTH + 1);
  assert.match(check.detail, /1025 字 > 1024 上限（超 1 字）/);
  assert.ok(check.detail.includes(DESCRIPTION_ADVICE));
});

test("缺 description 判失败（而不是当成 0 字通过）", () => {
  const check = checkDescription("---\nname: demo\n---\n\n正文\n");
  assert.equal(check.ok, false);
  assert.match(check.detail, /缺 description/);
});

test("没有 frontmatter 判失败", () => {
  assert.equal(checkDescription("## 只有正文\n").ok, false);
  assert.equal(descriptionValueOf("## 只有正文\n").value, null);
});

test("块标量（| / >）判失败：description 必须一行裸标量", () => {
  for (const marker of ["|", ">", "|-", ">-"]) {
    const check = checkDescription(`---\nname: demo\ndescription: ${marker}\n  第一行\n  第二行\n---\n`);
    assert.equal(check.ok, false, marker);
    assert.match(check.detail, /块标量/);
  }
});

test("折行续行判失败：YAML 会把续行并进 description，等于偷偷变长", () => {
  const check = checkDescription("---\nname: demo\ndescription: 第一行\n  第二行\n---\n");
  assert.equal(check.ok, false);
  assert.match(check.detail, /折行/);
});

test("同级 key 之后的缩进行不算 description 续行", () => {
  const value = descriptionValueOf("---\nname: demo\ndescription: 好\nallowed-tools: read\n---\n");
  assert.equal(value.value, "好");
  assert.equal(value.multiline, false);
  assert.equal(checkDescription("---\nname: demo\ndescription: 好\nallowed-tools: read\n---\n").ok, true);
});
