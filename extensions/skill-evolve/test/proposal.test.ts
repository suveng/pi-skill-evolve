/**
 * 提案解析与校验单测（设计稿 九、十）：正常 diff、超 40 行、越界路径、candidate frontmatter。
 *
 * 全部走临时 run 目录：校验函数本来就是「读盘 + 判定」，只测纯函数会漏掉 diff 文件名约定。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  MAX_DIFF_LINES,
  parseUnifiedDiff,
  readProposalSummary,
  validateCandidate,
  validateProposal,
} from "../lib/proposal.ts";

const DIFF_OK = [
  "--- a/.pi/skills/deploy-test/SKILL.md",
  "+++ b/.pi/skills/deploy-test/SKILL.md",
  "@@ -1,4 +1,5 @@",
  " name: deploy-test",
  "-description: 老的描述",
  "+description: 部署验收、验收清单、测服部署",
  "+路由：部署验收",
].join("\n");

function runDir(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skill-evolve-proposal-"));
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(dir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, "utf8");
  }
  return dir;
}

function proposalJson(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "improve",
    skill: "deploy-test",
    rationale: "description 缺「验收」路由词",
    evidence: [1234],
    diffFile: "02-proposal.diff",
    ...over,
  });
}

test("parseUnifiedDiff：统计增删行与文件路径", () => {
  const parsed = parseUnifiedDiff(DIFF_OK);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.added, 2);
  assert.equal(parsed.removed, 1);
  assert.deepEqual(parsed.files.map((item) => item.path), [".pi/skills/deploy-test/SKILL.md"]);
  assert.equal(parsed.files[0].hunks, 1);
});

test("parseUnifiedDiff：空文本判空，不是 ok", () => {
  const parsed = parseUnifiedDiff("");
  assert.equal(parsed.ok, false);
  assert.equal(parsed.reason, "empty");
});

test("validateProposal：正常 diff 判 ok 并带增删行数", () => {
  const dir = runDir({ "02-proposal.json": proposalJson(), "02-proposal.diff": DIFF_OK });
  const check = validateProposal(dir);
  assert.equal(check.status, "ok");
  assert.equal(check.type, "improve");
  assert.equal(check.skill, "deploy-test");
  assert.equal(check.added, 2);
  assert.equal(check.removed, 1);
  assert.equal(check.file, "02-proposal.diff");
});

test("validateProposal：没有 02-proposal.json 判 missing", () => {
  const dir = runDir({});
  assert.equal(validateProposal(dir).status, "missing");
});

test("validateProposal：增删超过 40 行判 too_large（不拒绝生成，标给人工）", () => {
  const long = [
    "--- a/.pi/skills/deploy-test/SKILL.md",
    "+++ b/.pi/skills/deploy-test/SKILL.md",
    "@@ -1,60 +1,60 @@",
    ...Array.from({ length: MAX_DIFF_LINES }, (_, index) => `-旧行 ${index}`),
    ...Array.from({ length: MAX_DIFF_LINES }, (_, index) => `+新行 ${index}`),
  ].join("\n");
  const dir = runDir({ "02-proposal.json": proposalJson(), "02-proposal.diff": long });
  const check = validateProposal(dir);
  assert.equal(check.status, "too_large");
  assert.equal(check.added, MAX_DIFF_LINES);
  assert.equal(check.removed, MAX_DIFF_LINES);
  assert.match(check.detail, /转人工/);
});

test("validateProposal：diff 动了技能目录外的路径判 bad_path", () => {
  const diff = [
    "--- a/rust_server/src/x.rs",
    "+++ b/rust_server/src/x.rs",
    "@@ -1,1 +1,2 @@",
    " fn main() {}",
    "+// 顺手改一下",
  ].join("\n");
  const dir = runDir({ "02-proposal.json": proposalJson(), "02-proposal.diff": diff });
  const check = validateProposal(dir);
  assert.equal(check.status, "bad_path");
  assert.match(check.detail, /rust_server\/src\/x\.rs/);
});

test("validateProposal：create 缺 candidate 目录判 invalid_candidate", () => {
  const dir = runDir({ "02-proposal.json": proposalJson({ type: "create", skill: "deploy-check" }) });
  const check = validateProposal(dir);
  assert.equal(check.status, "invalid_candidate");
  assert.match(check.detail, /缺 SKILL\.md/);
});

test("validateProposal：create 的 candidate 合规判 ok", () => {
  const dir = runDir({
    "02-proposal.json": proposalJson({ type: "create", skill: "deploy-check" }),
    "candidate/deploy-check/SKILL.md": "---\nname: deploy-check\ndescription: 部署后逐项验收\n---\n\n正文\n",
  });
  const check = validateProposal(dir);
  assert.equal(check.status, "ok");
  assert.equal(check.file, "candidate/deploy-check/SKILL.md");
});

test("validateCandidate：name 不合规 / 缺 description / 与目录名不一致都判坏", () => {
  const badName = runDir({ "SKILL.md": "---\nname: Deploy_Check\ndescription: x\n---\n" });
  assert.match(validateCandidate(badName).detail, /name 不合规/);

  const noDesc = runDir({ "SKILL.md": "---\nname: deploy-check\n---\n" });
  assert.equal(validateCandidate(noDesc).ok, false);
  assert.match(validateCandidate(noDesc).detail, /缺 description/);

  const mismatch = runDir({ "SKILL.md": "---\nname: other-name\ndescription: x\n---\n" });
  assert.match(validateCandidate(mismatch).detail, /不一致/);

  const okDir = path.join(runDir({}), "deploy-check");
  fs.mkdirSync(okDir, { recursive: true });
  fs.writeFileSync(path.join(okDir, "SKILL.md"), "---\nname: deploy-check\ndescription: 部署后逐项验收\n---\n", "utf8");
  const ok = validateCandidate(okDir);
  assert.equal(ok.ok, true);
  assert.equal(ok.name, "deploy-check");
});

test("readProposalSummary：没提案返回 undefined，有提案返回摘要（报告只显示不应用）", () => {
  assert.equal(readProposalSummary(runDir({})), undefined);
  const dir = runDir({ "02-proposal.json": proposalJson(), "02-proposal.diff": DIFF_OK });
  const summary = readProposalSummary(dir);
  assert.deepEqual(summary, {
    type: "improve",
    skill: "deploy-test",
    status: "ok",
    added: 2,
    removed: 1,
    file: "02-proposal.diff",
  });
});
