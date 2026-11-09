/**
 * 流水线渲染单测：五段各挑一次真实故障当用例 —— 缺 01 / 有提案没督导 / 驳回 / 采纳完 / 自动关着。
 * 断言只压「状态 + 下一步」，不锁具体措辞（文案会改，状态语义不该改）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildPipeline, pipelineProgress, renderPipelineLine, type PipelineInput } from "../lib/pipeline.ts";

function runDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "skill-evolve-pipeline-"));
}

function write(dir: string, name: string, content: string): void {
  fs.writeFileSync(path.join(dir, name), content);
}

function input(dir: string, patch: Partial<PipelineInput> = {}): PipelineInput {
  return {
    runDir: dir,
    status: "analyzed",
    pid: null,
    supervisorPid: null,
    dispatchedAt: 1_800_000_000_000,
    ...patch,
  };
}

const stateOf = (pipeline: ReturnType<typeof buildPipeline>, key: string): string =>
  pipeline.stages.find((stage) => stage.key === key)?.state ?? "missing";

test("只有 run.json（分析没出结论、子进程也死了）：分析等收尾，不提评审", () => {
  const dir = runDir();
  const pipeline = buildPipeline(input(dir, { status: "dispatched" }));
  assert.equal(stateOf(pipeline, "dispatch"), "done");
  assert.equal(stateOf(pipeline, "analyze"), "waiting");
  assert.equal(stateOf(pipeline, "propose"), "waiting");
  assert.equal(stateOf(pipeline, "review"), "waiting");
  assert.equal(stateOf(pipeline, "apply"), "waiting");
  assert.match(pipeline.hint, /下一步「分析」/);
});

test("分析在跑：分析=进行中，提案=进行中（同一子进程）", () => {
  const dir = runDir();
  const pipeline = buildPipeline(input(dir, { status: "dispatched", pid: 4242, alive: (pid) => pid === 4242 }));
  assert.equal(stateOf(pipeline, "analyze"), "running");
  assert.equal(stateOf(pipeline, "propose"), "running");
  assert.match(pipeline.stages[0]!.detail, /4242 在跑/);
});

test("分析完成没提案（状态已 analyzed）：提案段是 skipped 终态，不催「下一步提案」", () => {
  const dir = runDir();
  write(dir, "01-findings.json", "{}");
  const pipeline = buildPipeline(input(dir));
  assert.equal(stateOf(pipeline, "analyze"), "done");
  assert.equal(stateOf(pipeline, "propose"), "skipped");
  assert.match(pipeline.stages[2]!.detail, /不需要改/);
});

test("分析产物在但状态还 dispatched：提案段仍是 waiting（恢复会先补状态）", () => {
  const dir = runDir();
  write(dir, "01-findings.json", "{}");
  const pipeline = buildPipeline(input(dir, { status: "dispatched" }));
  assert.equal(stateOf(pipeline, "propose"), "waiting");
  assert.match(pipeline.stages[2]!.detail, /没写提案/);
});

test("提案在、督导已死：评审判 blocked 且指向自动重挂（2026-11-09 事故现场）", () => {
  const dir = runDir();
  write(dir, "01-findings.json", "{}");
  write(dir, "01-findings.json", "{}");
  write(dir, "02-proposal.json", JSON.stringify({ type: "improve", skill: "demo" }));
  const pipeline = buildPipeline(input(dir, { autoReview: true }));
  assert.equal(stateOf(pipeline, "review"), "blocked");
  assert.match(pipeline.stages[3]!.detail, /下次会话起点自动重挂/);
  assert.match(pipeline.hint, /下一步「评审」/);
});

test("提案在、督导在跑：评审=进行中", () => {
  const dir = runDir();
  write(dir, "02-proposal.json", JSON.stringify({ type: "improve", skill: "demo" }));
  const pipeline = buildPipeline(input(dir, { status: "proposed", supervisorPid: 777, alive: (pid) => pid === 777 }));
  assert.equal(stateOf(pipeline, "review"), "running");
  assert.match(pipeline.stages[1]!.detail, /01-findings.json/);
});

test("自动评审关着：评审=跳过而不是卡住", () => {
  const dir = runDir();
  write(dir, "01-findings.json", "{}");
  write(dir, "02-proposal.json", "{}");
  const pipeline = buildPipeline(input(dir, { autoReview: false }));
  assert.equal(stateOf(pipeline, "review"), "skipped");
  assert.match(pipeline.hint, /下一步「采纳」/);
});

test("评审驳回：采纳=跳过，hint 明说不会采纳", () => {
  const dir = runDir();
  write(dir, "01-findings.json", "{}");
  write(dir, "02-proposal.json", "{}");
  write(dir, "03-review.json", JSON.stringify({ status: "rejected", verdict: "revise" }));
  const pipeline = buildPipeline(input(dir, { status: "rejected" }));
  assert.equal(stateOf(pipeline, "review"), "done");
  assert.match(pipeline.stages[3]!.detail, /rejected \/ revise/);
  assert.equal(stateOf(pipeline, "apply"), "skipped");
  assert.match(pipeline.hint, /驳回|不会采纳|结束/);
});

test("评审通过 + 队列 pending + 自动采纳开着：采纳=进行中", () => {
  const dir = runDir();
  write(dir, "03-review.json", JSON.stringify({ status: "approved", verdict: "accept" }));
  const pipeline = buildPipeline(input(dir, { status: "approved", queued: "pending", autoApply: true }));
  assert.equal(stateOf(pipeline, "apply"), "running");
});

test("评审通过但自动采纳关着：采纳=卡住等人工批准", () => {
  const dir = runDir();
  write(dir, "03-review.json", JSON.stringify({ status: "approved" }));
  const pipeline = buildPipeline(input(dir, { status: "approved", queued: "pending", autoApply: false }));
  assert.equal(stateOf(pipeline, "apply"), "blocked");
  assert.match(pipeline.stages[4]!.detail, /等面板批准/);
});

test("采纳完成：五段全 done，hint 说走完", () => {
  const dir = runDir();
  write(dir, "01-findings.json", "{}");
  write(dir, "02-proposal.json", "{}");
  write(dir, "03-review.json", JSON.stringify({ status: "approved" }));
  write(dir, "04-decision.json", "{}");
  const pipeline = buildPipeline(input(dir, { status: "applied" }));
  assert.equal(pipeline.stages.every((stage) => stage.state === "done"), true);
  assert.match(pipeline.hint, /走完/);
  assert.deepEqual(pipelineProgress(pipeline), { done: 5, total: 5 });
});

test("卡死状态：分析=失败，不再假装在跑", () => {
  const dir = runDir();
  const pipeline = buildPipeline(input(dir, { status: "stale" }));
  assert.equal(stateOf(pipeline, "analyze"), "failed");
  assert.deepEqual(pipelineProgress(pipeline), { done: 1, total: 5 });
});

test("一行进度与符号：派发✓ 分析✗ …", () => {
  const dir = runDir();
  const line = renderPipelineLine(buildPipeline(input(dir, { status: "stale" })));
  assert.equal(line, "派发✓ 分析✗ 提案· 评审· 采纳·");
});
