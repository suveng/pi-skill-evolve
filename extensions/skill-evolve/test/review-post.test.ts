/**
 * 评审后处理单测（设计稿 12.3）：结构、证据、一致性一律代码判，不信 LLM 自觉。
 * 每条用例对应「模型输出的一种坏法」，覆盖判 invalid / reject 的每一道关。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseReviewJson, postProcessReview } from "../lib/review-post.ts";

const GOOD_PASS = JSON.stringify({ verdict: "pass", blocking: [], notes: "没问题" });
const withBlocking = (verdict: string, evidence: unknown): string =>
  JSON.stringify({ verdict, blocking: [{ issue: "有问题", evidence }], notes: "" });
const EVIDENCE = { file: ".pi/skills/demo/SKILL.md", line: 12, quote: "允许用 find" };

test("合法 pass 返回 ok", () => {
  const result = postProcessReview(GOOD_PASS);
  assert.equal(result.status, "ok");
  assert.equal(result.verdict, "pass");
  assert.deepEqual(result.blocking, []);
});

test("带 ```json 围栏与前后废话也能抠出 JSON", () => {
  const text = `好的，结论如下：\n\`\`\`json\n${GOOD_PASS}\n\`\`\`\n以上。`;
  assert.equal(parseReviewJson(text).json?.verdict, "pass");
  assert.equal(postProcessReview(text).status, "ok");
});

test("坏 verdict 判 invalid：bad-verdict", () => {
  for (const verdict of ["approved", "", 42, null]) {
    const result = postProcessReview(JSON.stringify({ verdict, blocking: [] }));
    assert.equal(result.status, "invalid");
    assert.match(result.detail ?? "", /bad-verdict/);
  }
});

test("根本不是 JSON 判 invalid：bad-json", () => {
  const result = postProcessReview("我觉得还行，可以过。");
  assert.equal(result.status, "invalid");
  assert.match(result.detail ?? "", /bad-json/);
});

test("blocking 不是数组判 invalid", () => {
  const result = postProcessReview(JSON.stringify({ verdict: "reject", blocking: "missing-evidence" }));
  assert.equal(result.status, "invalid");
  assert.match(result.detail ?? "", /bad-blocking/);
});

test("evidence 缺字段逐种判 invalid：file / line / quote", () => {
  const cases: [unknown, RegExp][] = [
    [{ line: 1, quote: "x" }, /evidence.file 为空/],
    [{ file: ".pi/skills/demo/SKILL.md", quote: "x" }, /evidence.line 不是正整数/],
    [{ file: ".pi/skills/demo/SKILL.md", line: 0, quote: "x" }, /evidence.line 不是正整数/],
    [{ file: ".pi/skills/demo/SKILL.md", line: -3, quote: "x" }, /evidence.line 不是正整数/],
    [{ file: ".pi/skills/demo/SKILL.md", line: 2.5, quote: "x" }, /evidence.line 不是正整数/],
    [{ file: ".pi/skills/demo/SKILL.md", line: "12", quote: "x" }, /evidence.line 不是正整数/],
    [{ file: ".pi/skills/demo/SKILL.md", line: 12, quote: "   " }, /evidence.quote 为空/],
    [null, /evidence 不是对象/],
  ];
  for (const [evidence, pattern] of cases) {
    const result = postProcessReview(withBlocking("reject", evidence));
    assert.equal(result.status, "invalid", `evidence=${JSON.stringify(evidence)}`);
    assert.match(result.detail ?? "", /missing-evidence/);
    assert.match(result.detail ?? "", pattern);
  }
});

test("pass 却带 blocking 判 invalid：contradiction", () => {
  const result = postProcessReview(withBlocking("pass", EVIDENCE));
  assert.equal(result.status, "invalid");
  assert.match(result.detail ?? "", /contradiction/);
  assert.equal(result.blocking.length, 1);
});

test("reject 带完整证据返回 ok 且保留 blocking/notes", () => {
  const result = postProcessReview(JSON.stringify({ verdict: "reject", blocking: [{ issue: "引入 find", evidence: EVIDENCE }], notes: "违反 P0" }));
  assert.equal(result.status, "ok");
  assert.equal(result.verdict, "reject");
  assert.equal(result.blocking[0].evidence.line, 12);
  assert.equal(result.notes, "违反 P0");
});

test("机械复验失败一票 reject，覆盖 LLM 的 pass", () => {
  const result = postProcessReview(GOOD_PASS, { recheck: () => "frontmatter 缺 name" });
  assert.equal(result.status, "reject");
  assert.equal(result.verdict, "reject");
  assert.match(result.detail ?? "", /frontmatter-invalid: frontmatter 缺 name/);
});

test("机械复验通过时不影响 LLM 结论", () => {
  const result = postProcessReview(GOOD_PASS, { recheck: () => null });
  assert.equal(result.status, "ok");
  assert.equal(result.verdict, "pass");
});
