/**
 * 必红自检单测（设计稿 12.4）：三个坏样本必须被拦住，一个正样本必须放行且写出理由；
 * 任何一条不符就算评审器不可信。
 *
 * 假 spawn 按 prompt 里的「技能名」回不同结论，所以用例不受 fixtures 目录枚举顺序影响。
 * 回的 JSON 必须是能过 postProcessReview 的合法形状（summary 必填，pass 必须带 passed），
 * 否则测的就不是「期望命中」而是「载荷校验」了。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ReviewSpawn } from "../lib/review-run.ts";
import { loadFixtures, renderSelftestReport, runSelftest, selftestFile, UNTRUSTED_NOTE } from "../lib/selftest.ts";
import { FakeReviewChild } from "./fake-review-spawn.ts";

const FIXTURES = fileURLToPath(new URL("../fixtures/selftest", import.meta.url));

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sk-selftest-"));
}

/** 按 prompt 末尾的「技能名：x」挑结论 */
function spawnBySkill(verdicts: Record<string, string>, opts: { dropPassed?: boolean } = {}): ReviewSpawn {
  return (_command, args) => {
    const prompt = args[3] ?? "";
    const skill = Object.keys(verdicts).find((name) => prompt.includes(`技能名：${name}`));
    const reply = fakeReply(skill ? (verdicts[skill] ?? "pass") : "pass", { dropPassed: opts.dropPassed === true });
    const child = new FakeReviewChild();
    setTimeout(() => {
      child.stdout.emit("data", reply);
      child.emit("exit", 0);
    }, 1);
    return child;
  };
}

const FAKE_EVIDENCE = { file: ".pi/skills/demo/SKILL.md", line: 9, quote: "凡是查日志一律用 rg" };

/** 造一份合法评审输出：reject/revise 带 blocking，pass 带 passed（可故意抽掉，测正样本的必红判定） */
function fakeReply(verdict: string, opts: { dropPassed: boolean }): string {
  const summary = "假评审：只校验自检链路，不代表真实评审质量";
  if (verdict === "pass") {
    const passed = opts.dropPassed ? [] : [{ point: "原有禁令仍完整保留", evidence: FAKE_EVIDENCE }];
    return JSON.stringify({ verdict, summary, blocking: [], passed, notes: "自检" });
  }
  return JSON.stringify({ verdict, summary, blocking: [{ issue: "有问题", evidence: FAKE_EVIDENCE }], passed: [], notes: "自检" });
}

test("三个坏样本 + 一个正样本都能被读到，期望分别是 reject/reject/revise/pass", () => {
  const fixtures = loadFixtures(FIXTURES);
  assert.deepEqual(fixtures.map((item) => item.name).sort(), ["delete-ban", "good-description", "rg-to-find", "weak-description"]);
  const expected = Object.fromEntries(fixtures.map((item) => [item.name, item.expected]));
  assert.deepEqual(expected, {
    "delete-ban": "reject",
    "good-description": "pass",
    "rg-to-find": "reject",
    "weak-description": "revise",
  });
  for (const fixture of fixtures) {
    assert.ok(fixture.diff.length > 0, `${fixture.name} 缺 diff`);
    assert.ok(fixture.after.length > 0, `${fixture.name} 缺改后全文`);
  }
});

test("四样本全部命中期望 → passed:true 并落盘 selftest.json", async () => {
  const dir = tmpDir();
  const report = await runSelftest({
    evolutionDir: dir,
    cwd: dir,
    fixturesDir: FIXTURES,
    spawnFn: spawnBySkill({ "ui-verify-lite": "reject", "rg-retrieval": "reject", "misc-helper": "revise", "log-helper": "pass" }),
  });
  assert.equal(report.passed, true);
  assert.equal(report.results.length, 4);
  assert.deepEqual(report.results.map((item) => item.actual), ["reject", "pass", "reject", "revise"]);
  const saved = JSON.parse(fs.readFileSync(selftestFile(dir), "utf8")) as { passed: boolean };
  assert.equal(saved.passed, true);
  assert.ok(!renderSelftestReport(report).includes("【红】"));
});

test("正样本判 pass 但没给 passed 理由 → 判不合格并写清差在哪（必红自检要能拉住无理由的通过）", async () => {
  const dir = tmpDir();
  const report = await runSelftest({
    evolutionDir: dir,
    cwd: dir,
    fixturesDir: FIXTURES,
    spawnFn: spawnBySkill({ "ui-verify-lite": "reject", "rg-retrieval": "reject", "misc-helper": "revise" }, { dropPassed: true }),
  });
  assert.equal(report.passed, false);
  const good = report.results.find((item) => item.name === "good-description");
  assert.equal(good?.ok, false);
  assert.equal(good?.actual, "pass（缺 passed 理由）");
  const text = renderSelftestReport(report);
  assert.ok(text.startsWith(`【红】${UNTRUSTED_NOTE}`), "红字必须在首行");
  assert.match(text, /✗ good-description/);
});

test("有一个被 pass → passed:false，报告首行是红字", async () => {
  const dir = tmpDir();
  const report = await runSelftest({
    evolutionDir: dir,
    cwd: dir,
    fixturesDir: FIXTURES,
    spawnFn: spawnBySkill({ "ui-verify-lite": "reject", "rg-retrieval": "reject", "misc-helper": "pass", "log-helper": "pass" }),
  });
  assert.equal(report.passed, false);
  const text = renderSelftestReport(report);
  assert.ok(text.startsWith(`【红】${UNTRUSTED_NOTE}`), `红字必须在首行，实际：${text.slice(0, 40)}`);
  assert.match(text, /✗ weak-description/);
});

test("单个样本就 pass（其余 reject）也判不可信", async () => {
  const dir = tmpDir();
  const report = await runSelftest({
    evolutionDir: dir,
    cwd: dir,
    fixturesDir: FIXTURES,
    spawnFn: spawnBySkill({ "ui-verify-lite": "pass", "rg-retrieval": "reject", "misc-helper": "revise", "log-helper": "pass" }),
  });
  assert.equal(report.passed, false);
  // 四个样本里 3 条命中（含正样本）也不算过：只要有一个坏样本被放行就是不可信
  assert.equal(report.results.filter((item) => item.ok).length, 3);
});

test("fixture 缺 change.diff 被跳过，不猜也不补", () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, "broken"), { recursive: true });
  fs.writeFileSync(path.join(dir, "broken", "fixture.json"), JSON.stringify({ name: "broken", skill: "x", expected: "reject" }));
  fs.writeFileSync(path.join(dir, "broken", "after.md"), "正文");
  const logs: string[] = [];
  const fixtures = loadFixtures(dir, (msg) => logs.push(msg));
  assert.deepEqual(fixtures, []);
  assert.match(logs.join("\n"), /缺 change\.diff/);
});

test("expected 非法同样跳过", () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, "bad"), { recursive: true });
  fs.writeFileSync(path.join(dir, "bad", "fixture.json"), JSON.stringify({ name: "bad", skill: "x", expected: "maybe" }));
  fs.writeFileSync(path.join(dir, "bad", "change.diff"), "+++ b/x\n");
  fs.writeFileSync(path.join(dir, "bad", "after.md"), "正文");
  const logs: string[] = [];
  assert.deepEqual(loadFixtures(dir, (msg) => logs.push(msg)), []);
  assert.match(logs.join("\n"), /expected 非法/);
});
