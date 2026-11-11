/**
 * 状态链（lib/web/chain.ts）与列表行里的链渲染：
 * 用户要的是「一眼看出这条卡在哪一步、下一步该干什么」（2026-11-11）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { CHAIN_STEPS, chainHtml, chainOf, nextStepText } from "../lib/web/chain.ts";

/** 取五段的状态串，断言时比字符串比数组好读：`done,running,waiting,waiting,waiting` */
function statesOf(status: string | undefined, queuedPending = false): string {
  return chainOf({ status, queuedPending })
    .map((step) => step.state)
    .join(",");
}

test("五段固定：派发 / 分析 / 提案 / 评审 / 采纳", () => {
  assert.deepEqual([...CHAIN_STEPS], ["派发", "分析", "提案", "评审", "采纳"]);
  assert.equal(chainOf({ status: "dispatched" }).length, 5);
});

test("在跑：分析段 running，后面全是 waiting", () => {
  assert.equal(statesOf("dispatched"), "done,running,waiting,waiting,waiting");
});

test("卡死：分析段 dead（子进程没了），不是 running", () => {
  assert.equal(statesOf("stale"), "done,dead,waiting,waiting,waiting");
});

test("分析判定不需要改：提案 / 评审 / 采纳三段 skipped（不是失败）", () => {
  assert.equal(statesOf("analyzed"), "done,done,done,skipped,skipped");
});

test("提案出来了：评审 waiting（督导还没接上时就是这个形状）", () => {
  assert.equal(statesOf("proposed"), "done,done,done,waiting,waiting");
});

test("评审完成且已入队：采纳 waiting（等人点批准）", () => {
  assert.equal(statesOf("reviewed", true), "done,done,done,done,waiting");
});

test("完整落地：五段全 done", () => {
  assert.equal(statesOf("applied"), "done,done,done,done,done");
  assert.equal(statesOf("reviewed", false), "done,done,done,done,waiting", "未入队时采纳段仍然空着");
});

test("被否与评审失败：评审段 dead", () => {
  assert.equal(statesOf("rejected"), "done,done,done,dead,waiting");
  assert.equal(statesOf("review_failed"), "done,done,done,dead,waiting");
});

test("回滚：采纳段 dead（前面都成过）", () => {
  assert.equal(statesOf("rolled-back"), "done,done,done,done,dead");
});

test("读不到 run.json：只点亮派发，其余留空等（不假装知道进度）", () => {
  assert.equal(statesOf(undefined), "done,waiting,waiting,waiting,waiting");
  assert.equal(statesOf("未知状态"), "done,waiting,waiting,waiting,waiting");
});

test("渲染：每段带状态色 class，done 用 ✓、running 用 …、dead 用 ✗、skipped 用 –", () => {
  const html = chainHtml([
    { label: "派发", state: "done" },
    { label: "分析", state: "running" },
    { label: "提案", state: "waiting" },
    { label: "评审", state: "dead" },
    { label: "采纳", state: "skipped" },
  ]);
  assert.match(html, /^<span class="chain">/);
  assert.match(html, /<span class="c-done" title="派发">派发✓<\/span>/);
  assert.match(html, /<span class="c-running" title="分析">分析…<\/span>/);
  assert.match(html, /<span class="c-waiting" title="提案">提案·<\/span>/);
  assert.match(html, /<span class="c-dead" title="评审">评审✗<\/span>/);
  assert.match(html, /<span class="c-skipped" title="采纳">采纳–<\/span>/);
});

test("下一步：每种处境都有一句能执行的话", () => {
  assert.equal(nextStepText({ status: "dispatched" }), "等它跑完");
  assert.equal(nextStepText({ status: "stale" }), "重跑或清理");
  assert.equal(nextStepText({ status: "proposed" }), "等督导接上；急就点重跑");
  assert.equal(nextStepText({ status: "reviewed", queuedPending: true }), "待落盘点批准");
  assert.equal(nextStepText({ status: "reviewed" }), "提案未入队，点重跑");
  assert.equal(nextStepText({ status: "applied" }), "已落盘");
  assert.equal(nextStepText({ status: "analyzed" }), "不用管（判定不需要改）");
  assert.equal(nextStepText({ status: "rejected" }), "被否，看评审意见");
  assert.equal(nextStepText({}), "等它自己走", "读不到状态时不给确定动作");
});
