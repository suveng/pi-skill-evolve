/**
 * 评审后处理单测（设计稿 12.3）：结构、证据、一致性一律代码判，不信 LLM 自觉。
 * 每条用例对应「模型输出的一种坏法」，覆盖判 invalid / reject 的每一道关。
 * 「结论必须写为什么」也在这里钉住：没有 summary、pass 却没有 passed（或 reject 却没有 blocking）一律 invalid。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseReviewJson, postProcessReview, SUMMARY_MAX } from "../lib/review-post.ts";

const SUMMARY = "新描述补了触发场景词，没删原有禁令";
const EVIDENCE = { file: ".pi/skills/demo/SKILL.md", line: 12, quote: "允许用 find" };
const PASSED = [{ point: "原有禁止项仍完整保留", evidence: EVIDENCE }];
const GOOD_PASS = JSON.stringify({ verdict: "pass", summary: SUMMARY, blocking: [], passed: PASSED, notes: "没问题" });
const withBlocking = (verdict: string, evidence: unknown): string =>
  JSON.stringify({ verdict, summary: SUMMARY, blocking: [{ issue: "有问题", evidence }], passed: [], notes: "" });

test("合法 pass 返回 ok，且 summary / passed 原样带出", () => {
  const result = postProcessReview(GOOD_PASS);
  assert.equal(result.status, "ok");
  assert.equal(result.verdict, "pass");
  assert.deepEqual(result.blocking, []);
  assert.equal(result.summary, SUMMARY);
  assert.equal(result.passed.length, 1);
  assert.equal(result.passed[0].point, "原有禁止项仍完整保留");
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
  const text = JSON.stringify({ verdict: "reject", summary: SUMMARY, blocking: [{ issue: "引入 find", evidence: EVIDENCE }], notes: "违反 P0" });
  const result = postProcessReview(text);
  assert.equal(result.status, "ok");
  assert.equal(result.verdict, "reject");
  assert.equal(result.blocking[0].evidence.line, 12);
  assert.equal(result.notes, "违反 P0");
  assert.equal(result.summary, SUMMARY);
  assert.deepEqual(result.passed, [], "reject 时没给 passed 就是空数组，不补造");
});

test("pass 但没有 passed（只写「通过」两个字）判 invalid：missing-passed", () => {
  const text = JSON.stringify({ verdict: "pass", summary: SUMMARY, blocking: [] });
  const result = postProcessReview(text);
  assert.equal(result.status, "invalid");
  assert.match(result.detail ?? "", /missing-passed/);
});

test("reject / revise 但没有 blocking 判 invalid：missing-blocking", () => {
  for (const verdict of ["reject", "revise"]) {
    const result = postProcessReview(JSON.stringify({ verdict, summary: SUMMARY, blocking: [] }));
    assert.equal(result.status, "invalid", verdict);
    assert.match(result.detail ?? "", /missing-blocking/);
  }
});

test("passed 项也要有 point 与证据：缺了就是 missing-evidence", () => {
  const noEvidence = postProcessReview(JSON.stringify({ verdict: "pass", summary: SUMMARY, blocking: [], passed: [{ point: "没问题" }] }));
  assert.equal(noEvidence.status, "invalid");
  assert.match(noEvidence.detail ?? "", /missing-evidence: passed/);
  assert.match(noEvidence.detail ?? "", /evidence 不是对象/);
});

test("没写 summary（缺字段 / 空串 / 非字符串）判 invalid：bad-summary", () => {
  for (const summary of [undefined, "", "   ", 42]) {
    const result = postProcessReview(JSON.stringify({ verdict: "pass", summary, blocking: [], passed: PASSED }));
    assert.equal(result.status, "invalid", `summary=${String(summary)}`);
    assert.match(result.detail ?? "", /bad-summary/);
  }
});

test(`summary 超 ${SUMMARY_MAX} 字按上限截断（含省略号不超过 ${SUMMARY_MAX}），不判 invalid`, () => {
  const long = "因为".repeat(60);
  const result = postProcessReview(JSON.stringify({ verdict: "pass", summary: long, blocking: [], passed: PASSED }));
  assert.equal(result.status, "ok");
  assert.equal(result.summary?.length, SUMMARY_MAX);
  assert.ok(result.summary?.endsWith("…"), "截断要留省略号，让人知道后面还有话");
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
