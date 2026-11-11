/**
 * 评审督导单测（设计稿 12）：不真起 pi、不真等 900/300 秒。
 *
 * 覆盖四条最容易静默失败的路径：等提案超时、评审进程超时、invalid 重评、机械复验一票否决。
 * 文件系统用内存 Map 替代，readText/writeText 都可注入。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { compileRules } from "../lib/hard-rules.ts";
import { checkCandidateFrontmatter, parseProposal, runReviewSupervisor } from "../lib/review-supervisor.ts";
import { FakeReviewChild, fakeClock, fakeReviewSpawn, hangingReviewSpawn } from "./fake-review-spawn.ts";
import type { ReviewSpawn } from "../lib/review-run.ts";

const RUN_DIR = "/repo/.pi/evolution/runs/run-1";
const SKILL_FILE = "/repo/.pi/skills/demo/SKILL.md";
const SKILL_TEXT = ["---", "name: demo", "description: 旧描述", "---", "", "检索一律用 rg，禁止 find。"].join("\n");
const DESC_DIFF = [
  "--- a/.pi/skills/demo/SKILL.md",
  "+++ b/.pi/skills/demo/SKILL.md",
  "@@ -3,1 +3,1 @@",
  "-description: 旧描述",
  "+description: 检索日志时用 rg，禁止 find 全盘扫",
].join("\n");
const EVIDENCE_ROW = { file: ".pi/skills/demo/SKILL.md", line: 4, quote: "description: 检索日志时用 rg，禁止 find 全盘扫" };
const PASS = JSON.stringify({
  verdict: "pass",
  summary: "新描述只补了触发场景词，没删原有禁令",
  blocking: [],
  passed: [{ point: "原有禁止项仍在正文里", evidence: EVIDENCE_ROW }],
  notes: "没问题",
});
const RUN_JSON = JSON.stringify({ runId: "run-1", status: "dispatched", cwd: "/repo", stages: [{ name: "analyze", model: "deepseek/flash", usage: {}, ms: 10 }] });
/** 只放一条与仓库同形的 rg-over-find：用例不依赖 .pi/evolution/rules 文件是否在场 */
const RULES = compileRules({
  rules: [{ id: "rg-over-find", level: "P0", pattern: "\\bfind\\s+[.~/]", expect: "禁止 find 全盘扫", why: "慢" }],
});

function memFs(files: Record<string, string>) {
  const store = new Map(Object.entries(files).map(([file, text]) => [path.resolve(file), text]));
  return {
    readText: (file: string) => store.get(path.resolve(file)),
    writeText: (file: string, text: string) => {
      store.set(path.resolve(file), text);
    },
    // 内存版 io 没有目录概念：不建真目录（真实现由 lib/rewrite.ts 的 mkdirSync 兜底）
    mkdirText: () => undefined,
    text: (file: string) => store.get(path.resolve(file)),
    json: (file: string) => {
      const raw = store.get(path.resolve(file));
      return raw === undefined ? undefined : (JSON.parse(raw) as Record<string, unknown>);
    },
  };
}

function baseFiles(): Record<string, string> {
  return {
    [`${RUN_DIR}/run.json`]: RUN_JSON,
    [`${RUN_DIR}/02-proposal.json`]: JSON.stringify({ type: "improve", skill: "demo", rationale: "理由不该进评审", evidence: [3], diffFile: "02-proposal.diff" }),
    [`${RUN_DIR}/02-proposal.diff`]: DESC_DIFF,
    [SKILL_FILE]: SKILL_TEXT,
  };
}

test("正常路径：pass → reviewed，写 03-review.json/.md 并回写 run.json", async () => {
  const fs = memFs(baseFiles());
  const prompts: string[] = [];
  const outcome = await runReviewSupervisor({
    runDir: RUN_DIR,
    evolutionDir: "/repo/.pi/evolution",
    reviewModel: "deepseek/flash",
    readText: fs.readText,
    writeText: fs.writeText,
    mkdirText: fs.mkdirText,
    spawnFn: fakeReviewSpawn([PASS]),
    pollMs: 1,
    // 记下发给评审的 prompt，验证独立性（不给 rationale）
    ...{},
  });
  assert.equal(outcome.status, "reviewed");
  const review = fs.json(`${RUN_DIR}/03-review.json`) as Record<string, unknown>;
  assert.equal(review.status, "reviewed");
  assert.equal(review.verdict, "pass");
  assert.equal(review.reviewerModel, "deepseek/flash");
  assert.equal(review.proposerModel, "deepseek/flash");
  assert.equal(review.sameModel, true);
  assert.equal(review.action, "auto");
  // 结论要能解释「为什么」：summary 与 passed 都得落盘（面板详情页读的就是这两个字段）
  assert.equal(review.summary, "新描述只补了触发场景词，没删原有禁令");
  assert.equal((review.passed as unknown[]).length, 1);
  const md = fs.text(`${RUN_DIR}/03-review.md`) ?? "";
  assert.ok(md.startsWith("> 同模型自评"), "同模型自评警告必须在首行");
  assert.match(md, /\*\*新描述只补了触发场景词，没删原有禁令\*\*/);
  assert.match(md, /## passed/);
  const run = fs.json(`${RUN_DIR}/run.json`) as Record<string, unknown>;
  assert.equal(run.status, "reviewed");
  assert.deepEqual((run.review as Record<string, unknown>).sameModel, true);
  assert.equal((run.review as Record<string, unknown>).summary, "新描述只补了触发场景词，没删原有禁令");
  assert.equal((run.review as Record<string, unknown>).passed, 1);
  assert.equal(prompts.length, 0);
});

test("评审 prompt 里不含提案 rationale", async () => {
  const fs = memFs(baseFiles());
  let captured = "";
  const spawnFn = ((_cmd: string, args: string[]) => {
    captured = args[3] ?? "";
    return fakeReviewSpawn([PASS])(_cmd, args, {});
  }) as unknown as Parameters<typeof runReviewSupervisor>[0]["spawnFn"];
  await runReviewSupervisor({
    runDir: RUN_DIR,
    evolutionDir: "/repo/.pi/evolution",
    readText: fs.readText,
    writeText: fs.writeText,
    mkdirText: fs.mkdirText,
    ...(spawnFn ? { spawnFn } : {}),
    pollMs: 1,
  });
  assert.ok(captured.length > 0, "应当真的组装并传了 prompt");
  assert.ok(!captured.includes("理由不该进评审"), "提案 rationale 不得进评审 prompt");
  assert.ok(!captured.includes("01-findings"));
});

test("提案永不出现：900s 后写 skipped/proposal-timeout", async () => {
  const fs = memFs({ [`${RUN_DIR}/run.json`]: RUN_JSON });
  const clock = fakeClock();
  const outcome = await runReviewSupervisor({
    runDir: RUN_DIR,
    evolutionDir: "/repo/.pi/evolution",
    readText: fs.readText,
    writeText: fs.writeText,
    mkdirText: fs.mkdirText,
    now: clock.now,
    sleep: clock.sleep,
    pollMs: 2000,
  });
  assert.equal(outcome.status, "skipped");
  const review = fs.json(`${RUN_DIR}/03-review.json`) as Record<string, unknown>;
  assert.equal(review.status, "skipped");
  assert.equal(review.reason, "proposal-timeout");
  assert.ok(clock.elapsed() >= 900_000, `应当等满 900s，实际推进 ${clock.elapsed()}ms`);
});

test("提案文件是坏 JSON：skipped/proposal-unreadable", async () => {
  const fs = memFs({ ...baseFiles(), [`${RUN_DIR}/02-proposal.json`]: "{坏掉的" });
  const clock = fakeClock();
  const outcome = await runReviewSupervisor({
    runDir: RUN_DIR,
    evolutionDir: "/repo/.pi/evolution",
    readText: fs.readText,
    writeText: fs.writeText,
    mkdirText: fs.mkdirText,
    now: clock.now,
    sleep: clock.sleep,
  });
  assert.equal(outcome.status, "skipped");
  assert.equal((fs.json(`${RUN_DIR}/03-review.json`) as Record<string, unknown>).reason, "proposal-unreadable");
});

test("评审进程超时 300s → review_failed 且 kill 被调用", async () => {
  const fs = memFs(baseFiles());
  const clock = fakeClock();
  const outcome = await runReviewSupervisor({
    runDir: RUN_DIR,
    evolutionDir: "/repo/.pi/evolution",
    readText: fs.readText,
    writeText: fs.writeText,
    mkdirText: fs.mkdirText,
    spawnFn: hangingReviewSpawn(),
    now: clock.now,
    sleep: clock.sleep,
    pollMs: 250,
  });
  assert.equal(outcome.status, "review_failed");
  assert.match(outcome.record.detail ?? "", /review-timeout/);
  assert.equal(outcome.record.attempts, 1, "超时不重试");
});

test("invalid 一次后重评成功：attempts=2 且 reviewed", async () => {
  const fs = memFs(baseFiles());
  const outcome = await runReviewSupervisor({
    runDir: RUN_DIR,
    evolutionDir: "/repo/.pi/evolution",
    readText: fs.readText,
    writeText: fs.writeText,
    mkdirText: fs.mkdirText,
    spawnFn: fakeReviewSpawn([JSON.stringify({ verdict: "maybe", blocking: [] }), PASS]),
    pollMs: 1,
  });
  assert.equal(outcome.status, "reviewed");
  assert.equal(outcome.record.attempts, 2);
});

test("两次都 invalid → review_failed，run.json 也是 review_failed", async () => {
  const fs = memFs(baseFiles());
  const bad = JSON.stringify({ verdict: "maybe", blocking: [] });
  const outcome = await runReviewSupervisor({
    runDir: RUN_DIR,
    evolutionDir: "/repo/.pi/evolution",
    readText: fs.readText,
    writeText: fs.writeText,
    mkdirText: fs.mkdirText,
    spawnFn: fakeReviewSpawn([bad, bad]),
    pollMs: 1,
  });
  assert.equal(outcome.status, "review_failed");
  assert.equal(outcome.record.attempts, 2);
  assert.match(outcome.record.detail ?? "", /bad-verdict/);
  assert.equal((fs.json(`${RUN_DIR}/run.json`) as Record<string, unknown>).status, "review_failed");
});

test("机械复验：diff 新增 P0 命中时一票 reject（即使评审说 pass）", async () => {
  const badDiff = [
    "--- a/.pi/skills/demo/SKILL.md",
    "+++ b/.pi/skills/demo/SKILL.md",
    "@@ -6,1 +6,1 @@",
    "-检索一律用 rg，禁止 find。",
    "+找不到就 find . -name 文件名 全盘扫一遍。",
  ].join("\n");
  const fs = memFs({ ...baseFiles(), [`${RUN_DIR}/02-proposal.diff`]: badDiff });
  const outcome = await runReviewSupervisor({
    runDir: RUN_DIR,
    evolutionDir: "/repo/.pi/evolution",
    rules: RULES,
    readText: fs.readText,
    writeText: fs.writeText,
    mkdirText: fs.mkdirText,
    spawnFn: fakeReviewSpawn([PASS]),
    pollMs: 1,
    maxRewrites: 0,
  });
  assert.equal(outcome.status, "rejected");
  assert.equal(outcome.record.verdict, "reject");
  assert.match(outcome.record.detail ?? "", /frontmatter-invalid: 新增 P0 命中/);
});

test("create 提案：candidate frontmatter 缺 description → reject", async () => {
  const candidate = ["---", "name: demo", "---", "正文"].join("\n");
  const fs = memFs({
    [`${RUN_DIR}/run.json`]: RUN_JSON,
    [`${RUN_DIR}/02-proposal.json`]: JSON.stringify({ type: "create", skill: "demo", candidateFile: "candidate/demo/SKILL.md" }),
    [`${RUN_DIR}/candidate/demo/SKILL.md`]: candidate,
  });
  const outcome = await runReviewSupervisor({
    runDir: RUN_DIR,
    evolutionDir: "/repo/.pi/evolution",
    rules: RULES,
    readText: fs.readText,
    writeText: fs.writeText,
    mkdirText: fs.mkdirText,
    spawnFn: fakeReviewSpawn([PASS]),
    pollMs: 1,
    maxRewrites: 0,
  });
  assert.equal(outcome.status, "rejected");
  assert.match(outcome.record.detail ?? "", /frontmatter 缺 description/);
  assert.equal(outcome.record.action, "approval");
});

test("parseProposal 只认真实字段，缺 type/skill 返回 undefined", () => {
  assert.equal(parseProposal(undefined), undefined);
  assert.equal(parseProposal("{}"), undefined);
  assert.equal(parseProposal(JSON.stringify({ type: "improve", skill: "demo" }))?.skill, "demo");
});

test("checkCandidateFrontmatter 三种坏法都能识别", () => {
  assert.equal(checkCandidateFrontmatter("没有 frontmatter"), "缺 frontmatter");
  assert.equal(checkCandidateFrontmatter("---\ndescription: x\n---\n"), "frontmatter 缺 name");
  assert.equal(checkCandidateFrontmatter("---\nname: x\n---\n"), "frontmatter 缺 description");
  assert.equal(checkCandidateFrontmatter("---\nname: x\ndescription: y\n---\n"), null);
});

// ── 评审不通过 → 重写提案（2026-11-11 用户：「复盘不通过时应该有 3 次重写这个提案的机会」）──
const REJECT = JSON.stringify({
  verdict: "reject",
  summary: "新描述没覆盖触发场景",
  blocking: [{ point: "description 没写「全盘扫描」这个触发场景", evidence: { file: ".pi/skills/demo/SKILL.md", line: 3, quote: "description: 旧描述" } }],
  passed: [],
});

/** 假重写子进程：每次 spawn 把提案改一版再退出（模拟 Agent 真的重写了文件） */
function fakeRewriteSpawn(fs: ReturnType<typeof memFs>): { spawn: ReviewSpawn; calls: number[] } {
  const calls: number[] = [];
  let round = 0;
  const spawn: ReviewSpawn = () => {
    round += 1;
    calls.push(round);
    const child = new FakeReviewChild();
    setTimeout(() => {
      fs.writeText(
        `${RUN_DIR}/02-proposal.json`,
        JSON.stringify({ type: "improve", skill: "demo", diffFile: "02-proposal.diff", rewrite: round }),
      );
      child.emit("exit", 0);
    }, 1);
    return child;
  };
  return { spawn, calls };
}

test("评审 reject → 自动重写一次提案，第二版通过即 reviewed（rewrites=1，上一版留档）", async () => {
  const fs = memFs(baseFiles());
  const rewrite = fakeRewriteSpawn(fs);
  const outcome = await runReviewSupervisor({
    runDir: RUN_DIR,
    evolutionDir: "/repo/.pi/evolution",
    rules: RULES,
    readText: fs.readText,
    writeText: fs.writeText,
    mkdirText: fs.mkdirText,
    spawnFn: fakeReviewSpawn([REJECT, PASS]),
    rewriteSpawnFn: rewrite.spawn,
    pollMs: 1,
    maxRewrites: 3,
  });
  assert.equal(outcome.status, "reviewed");
  assert.equal(outcome.record.rewrites, 1);
  assert.equal(rewrite.calls.length, 1);
  // 第一版被否的提案与它的评审结论都要留档，不然只有最后一版
  assert.ok(fs.text(`${RUN_DIR}/attempts/attempt-01/02-proposal.json`)?.includes("rationale"), "第一版提案在案");
  assert.match(fs.text(`${RUN_DIR}/attempts/attempt-01/03-review.json`) ?? "", /reject/);
});

test("三次重写都不通过 → 用满 3 次后判 rejected（评审 4 次）", async () => {
  const fs = memFs(baseFiles());
  const rewrite = fakeRewriteSpawn(fs);
  const outcome = await runReviewSupervisor({
    runDir: RUN_DIR,
    evolutionDir: "/repo/.pi/evolution",
    rules: RULES,
    readText: fs.readText,
    writeText: fs.writeText,
    mkdirText: fs.mkdirText,
    spawnFn: fakeReviewSpawn([REJECT]),
    rewriteSpawnFn: rewrite.spawn,
    pollMs: 1,
    maxRewrites: 3,
  });
  assert.equal(outcome.status, "rejected");
  assert.equal(outcome.record.rewrites, 3, "正好用满 3 次，不多不少");
  assert.equal(rewrite.calls.length, 3);
});

test("重写没写出新提案 → 立刻按当前结论收尾，不再空等", async () => {
  const fs = memFs(baseFiles());
  const spawn: ReviewSpawn = () => {
    const child = new FakeReviewChild();
    setTimeout(() => child.emit("exit", 0), 1);
    return child;
  };
  const outcome = await runReviewSupervisor({
    runDir: RUN_DIR,
    evolutionDir: "/repo/.pi/evolution",
    rules: RULES,
    readText: fs.readText,
    writeText: fs.writeText,
    mkdirText: fs.mkdirText,
    spawnFn: fakeReviewSpawn([REJECT]),
    rewriteSpawnFn: spawn,
    pollMs: 1,
    maxRewrites: 3,
    rewriteWaitMs: 30,
  });
  assert.equal(outcome.status, "rejected");
  assert.equal(outcome.record.rewrites, 1, "试过一次重写、没产物就停手");
});
