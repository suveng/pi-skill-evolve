/**
 * M6 端到端复演：六段状态齐全、产物落盘、评审不通过时停在评审段。
 * 用例编号对应设计稿 15 章（M6 验收硬指标：整轮可复演）。
 * 这里一律用假评审 + 假 git：测试里绝不起真子进程（真跑用 scripts/replay.ts --real）。
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { FAKE_REVIEW_TEXT } from "../lib/replay-fixture.ts";
import { REPLAY_STAGES, runReplay } from "../lib/replay.ts";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "skill-evolve-replay-test-"));
}

const fakeGit = () => ({ code: 0, out: "" });

test("复演：六段全通，run.json status 序列完整", async () => {
  const dir = tmpDir();
  const outcome = await runReplay({
    cwd: dir,
    evolutionDir: path.join(dir, ".pi", "evolution"),
    fakeReview: true,
    git: fakeGit,
    now: () => Date.UTC(2026, 10, 8, 12),
  });
  assert.deepEqual(outcome.failures, []);
  assert.equal(outcome.ok, true);
  for (const stage of REPLAY_STAGES) {
    assert.ok(!outcome.stages[stage].startsWith("未执行"), `${stage} 段必须真的执行过`);
    assert.ok(!outcome.stages[stage].startsWith("失败"), `${stage} 段不应失败：${outcome.stages[stage]}`);
  }
  assert.deepEqual(outcome.statuses, ["dispatched", "analyzed", "proposed", "reviewed", "applied"]);
  assert.equal(outcome.lines.length, 6);
});

test("复演：产物齐全（00-session / 提案 / 评审 / 决策 / 采纳 diff / 复验）", async () => {
  const dir = tmpDir();
  const outcome = await runReplay({
    cwd: dir,
    evolutionDir: path.join(dir, ".pi", "evolution"),
    fakeReview: true,
    git: fakeGit,
    now: () => Date.UTC(2026, 10, 8, 12),
  });
  const runDir = path.join(dir, ".pi", "evolution", "runs", outcome.runId);
  for (const file of [
    "run.json",
    "00-session/index.json",
    "02-proposal.json",
    "02-proposal.diff",
    "03-review.json",
    "04-decision.json",
    "05-applied.diff",
    "06-verify.json",
  ]) {
    assert.ok(fs.existsSync(path.join(runDir, file)), `${file} 必须存在`);
  }
  // 05 是真实落盘的 diff，06 里五道闸全 ok
  assert.ok(fs.readFileSync(path.join(runDir, "05-applied.diff"), "utf8").includes("+"));
  const verify = JSON.parse(fs.readFileSync(path.join(runDir, "06-verify.json"), "utf8")) as {
    status: string;
    gates: { gate: string; ok: boolean }[];
  };
  assert.equal(verify.status, "applied");
  assert.equal(verify.gates.length, 5);
  assert.ok(verify.gates.every((gate) => gate.ok));
  // 技能文件真的被改了（复演的本质：碰了技能文件）
  const skillText = fs.readFileSync(path.join(dir, ".pi", "skills", "replay-demo", "SKILL.md"), "utf8");
  assert.match(skillText, /index\.json 再读会话原文/);
  // 会话索引不含原文正文：只留 ≤80 字摘录
  const index = JSON.parse(fs.readFileSync(path.join(runDir, "00-session", "index.json"), "utf8")) as {
    lines: { excerpt: string }[];
    stats: { lines: number; hasCompaction: boolean };
  };
  assert.ok(index.lines.length > 0);
  assert.ok(index.lines.every((line) => line.excerpt.length <= 80));
  assert.equal(index.stats.hasCompaction, false);
});

test("复演：评审 reject 时停在评审段，不改技能文件", async () => {
  const dir = tmpDir();
  const reject = JSON.stringify({
    verdict: "reject",
    blocking: [{ file: ".pi/skills/replay-demo/SKILL.md", line: 9, quote: "+- 复演时必须先看…", why: "新增条款与硬约束冲突" }],
    evidence: [{ file: ".pi/skills/replay-demo/SKILL.md", line: 9, quote: "index.json" }],
  });
  const outcome = await runReplay({
    cwd: dir,
    evolutionDir: path.join(dir, ".pi", "evolution"),
    fakeReview: true,
    fakeReviewText: reject,
    git: fakeGit,
    now: () => Date.UTC(2026, 10, 8, 12),
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.failures.length, 1);
  assert.match(outcome.failures[0]!, /^review：/);
  assert.equal(outcome.stages.approve, "未执行");
  const skillText = fs.readFileSync(path.join(dir, ".pi", "skills", "replay-demo", "SKILL.md"), "utf8");
  assert.ok(!skillText.includes("index.json 再读会话原文"), "评审没过就不许动技能文件");
});

test("复演假评审文本本身要过字段校验，否则流水线验的是假结论", async () => {
  const { postProcessReview } = await import("../lib/review-post.ts");
  const result = postProcessReview(FAKE_REVIEW_TEXT);
  assert.equal(result.status, "ok");
  assert.equal(result.verdict, "pass");
});
