/**
 * 评审记录落盘形态的单测：`03-review.md` 必须写出「为什么」（summary + 通过理由），
 * 且 v0.1.9 之前的老记录（没有 summary / passed 字段）读进来也不能抛。
 *
 * 单独一份测试是因为 review-record.ts 全是纯函数；落盘字段与服务端回写由
 * test/review-supervisor.test.ts 覆盖，细节页读取由 test/web-run-detail.test.ts 覆盖。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { renderReviewMarkdown, type ReviewRecord } from "../lib/review-record.ts";

const EVIDENCE = { file: ".pi/skills/demo/SKILL.md", line: 3, quote: "description: 检索日志用 rg" };

function record(extra: Partial<ReviewRecord> = {}): ReviewRecord {
  return {
    status: "rejected",
    verdict: "revise",
    blocking: [{ issue: "描述承诺大于正文", evidence: EVIDENCE }],
    reviewerModel: "deepseek/deepseek-flash",
    proposerModel: "deepseek/deepseek-flash",
    sameModel: false,
    action: "forbidden",
    reviewedAt: 1794134158913,
    reviewedAtIso: "2026-11-08T10:35:58.913Z",
    ...extra,
  };
}

test("03-review.md：summary 紧跟在标题后，blocking 与 passed 各成一段", () => {
  const md = renderReviewMarkdown(
    record({
      summary: "描述承诺了正文没有的能力，其余约束未被破坏",
      passed: [{ point: "原有禁令仍完整保留", evidence: { ...EVIDENCE, line: 9, quote: "一律用 rg" } }],
    }),
    "demo",
  );
  const lines = md.split("\n");
  assert.equal(lines[0], "# 评审结论：revise");
  assert.equal(lines[2], "**描述承诺了正文没有的能力，其余约束未被破坏**", "摘要要排在元信息之前");
  assert.match(md, /## blocking\n\n- 描述承诺大于正文\n {2}- 证据：\.pi\/skills\/demo\/SKILL\.md:3 「description: 检索日志用 rg」/);
  assert.match(md, /## passed\n\n- 原有禁令仍完整保留\n {2}- 证据：\.pi\/skills\/demo\/SKILL\.md:9 「一律用 rg」/);
});

test("03-review.md：老记录（没有 summary / passed）不抛，也不渲染空段", () => {
  const md = renderReviewMarkdown(record(), "demo");
  assert.equal(md.includes("## passed"), false, "没有通过理由就别留空段");
  assert.equal(md.includes("**"), false, "没有摘要就没有加粗行（同模型警告是 > 开头，不受影响）");
  assert.match(md, /## blocking/);
});

test("03-review.md：pass 且没有 blocking 时写「blocking：无」，通过理由照常列出", () => {
  const md = renderReviewMarkdown(
    record({ status: "reviewed", verdict: "pass", action: "auto", blocking: [], summary: "只给 description 补了触发词", passed: [{ point: "原有禁令仍在", evidence: EVIDENCE }] }),
    "demo",
  );
  assert.match(md, /blocking：无/);
  assert.match(md, /## passed/);
  assert.equal(md.includes("## blocking"), false);
});
