/**
 * 同会话聚合检测：**接线**的单测（派发器与退出前补发真的走到并入分支）。
 *
 * 这里断言的是「没建新 run、没起进程」这类后果 —— 只看返回值会漏掉「返回说并入了，其实又派了一个」。
 * 场景与用户现场一致：同一会话连着几轮结算，第二轮起只并轮数。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { DEFAULT_CONFIG } from "../lib/config.ts";
import { patchRunRecordSync } from "../lib/runs.ts";
import { flushPendingSync } from "../lib/shutdown-dispatch.ts";
import { type SpawnedChild } from "../lib/spawn-plan.ts";
import { type TelemetryEvent } from "../lib/telemetry.ts";
import { FakeChild, NOW, TEMPLATE, harness, readRun, settleAsync } from "./aggregate-harness.ts";

test("派发：同会话第二条不再派新 run，而是并入（不起进程、轮数与 merged 累加）", async () => {
  const h = harness("merge");
  const first = await h.dispatch({ sessionId: "s1", skills: ["a"] });
  assert.equal(first.status, "dispatched");
  if (first.status !== "dispatched") return;
  const runId = first.run.runId;
  const spawns = h.calls.length;

  // 去抖窗口已过：这一轮会真的走到派发逻辑，聚合检测在单飞闸之前
  h.tick(DEFAULT_CONFIG.idleMs + 1_000);
  const second = await h.dispatch({ sessionId: "s1", skills: ["b"] });
  assert.deepEqual(second, { status: "merged", runId, rounds: 2 });
  assert.equal(h.calls.length, spawns, "并入的轮次不许再起子进程");
  assert.equal(fs.readdirSync(path.join(h.evolutionDir, "runs")).length, 1, "也不许再建 run 目录");

  const record = readRun(h, runId);
  const coverage = record.coverage as Record<string, unknown>;
  assert.deepEqual([coverage.rounds, coverage.merged, coverage.lastAt], [2, 1, NOW + DEFAULT_CONFIG.idleMs + 1_000]);
  // run 原有的状态与 skills 不被并入操作改写：本轮并进去的是「覆盖轮数」，不是新一轮技能清单
  assert.deepEqual([record.status, record.trigger], ["dispatched", "auto"]);

  const merged = h.events.filter((event) => event.kind === "merged");
  assert.equal(merged.length, 1);
  assert.deepEqual([merged[0]?.sessionId, merged[0]?.runId, merged[0]?.rounds], ["s1", runId, 2]);
  assert.equal(h.logs.some((line) => line.includes(`同会话已有在途复盘 ${runId}，本轮并入（共 2 轮），不再派生`)), true);
});

test("派发：连续并入时 rounds 递增、merged 累计；被去抖挡下的轮次也算进总数", async () => {
  const h = harness("merge-twice");
  const first = await h.dispatch({ sessionId: "s1", skills: ["a"] });
  assert.equal(first.status, "dispatched");
  if (first.status !== "dispatched") return;

  // 窗口内又结算一轮：走老路记 pending（superseded），不是并入
  const superseded = await h.dispatch({ sessionId: "s1", skills: ["a"] });
  assert.deepEqual(superseded, { status: "superseded", rounds: 1 });

  // 窗口过后这一轮：pending 里的那轮 + 这一轮一起并进去
  h.tick(DEFAULT_CONFIG.idleMs + 1_000);
  const merged = await h.dispatch({ sessionId: "s1", skills: ["a"] });
  // 派发时覆盖 1 轮 + pending 里 1 轮 + 这一轮 = 3 轮
  assert.deepEqual(merged, { status: "merged", runId: first.run.runId, rounds: 3 });

  h.tick(DEFAULT_CONFIG.idleMs + 1_000);
  const third = await h.dispatch({ sessionId: "s1", skills: ["a"] });
  assert.deepEqual(third, { status: "merged", runId: first.run.runId, rounds: 4 });

  const coverage = readRun(h, first.run.runId).coverage as Record<string, unknown>;
  assert.deepEqual([coverage.rounds, coverage.merged], [4, 2]);
  assert.equal(h.events.filter((event) => event.kind === "merged").length, 2);
});

test("派发：在途 run 的子进程已死 → 不并入，另开新 run（尸体交给 stale 逻辑）", async () => {
  const h = harness("dead");
  const first = await h.dispatch({ sessionId: "s1", skills: ["a"] });
  assert.equal(first.status, "dispatched");
  if (first.status !== "dispatched") return;

  // 子进程退出（收尸会放锁并把这条 run 记成 abandoned），pid 判死：它不再是在途复盘
  h.children[0].emit("exit", 1);
  await settleAsync();
  h.setAlive(false);
  h.tick(DEFAULT_CONFIG.idleMs + 1_000);

  const second = await h.dispatch({ sessionId: "s1", skills: ["a"] });
  assert.equal(second.status, "dispatched");
  if (second.status !== "dispatched") return;
  assert.notEqual(second.run.runId, first.run.runId, "死 run 不许被并入，必须另开一条");
  assert.equal(h.calls.length, 2);
  // 聚合检测不擅自改别人的 run.json：这次并入失败，那条老 run 的 coverage 一个字都没动
  assert.equal(readRun(h, first.run.runId).coverage, undefined);
  assert.equal(h.events.filter((event) => event.kind === "merged").length, 0);
});

test("派发：同会话那条 run 已 analyzed（复盘确实跑完）→ 允许另开新 run", async () => {
  const h = harness("analyzed");
  const first = await h.dispatch({ sessionId: "s1", skills: ["a"] });
  assert.equal(first.status, "dispatched");
  if (first.status !== "dispatched") return;
  // 复盘跑完 = 子进程已退出：先收尸放锁，再把状态写成 analyzed（复盘确实读到了产出）
  h.children[0].emit("exit", 0);
  await settleAsync();
  h.setAlive(false);
  assert.equal(patchRunRecordSync(first.run.runDir, { status: "analyzed" }), true);
  h.tick(DEFAULT_CONFIG.idleMs + 1_000);

  const second = await h.dispatch({ sessionId: "s1", skills: ["a"] });
  assert.equal(second.status, "dispatched");
  if (second.status !== "dispatched") return;
  assert.notEqual(second.run.runId, first.run.runId);
});

test("派发：不同 sessionId 互不影响（各自照常派发）", async () => {
  const h = harness("other-session");
  const a = await h.dispatch({ sessionId: "s1", skills: ["a"] });
  // s1 的子进程跑完退出（别让全局单飞闸挡住 s2 —— 它本来就该挡，这里测的是聚合不跨会话误判）
  h.children[0].emit("exit", 0);
  await settleAsync();
  h.setAlive(false);
  h.tick(DEFAULT_CONFIG.idleMs + 1_000);
  const b = await h.dispatch({ sessionId: "s2", skills: ["a"] });
  assert.equal(a.status, "dispatched");
  assert.equal(b.status, "dispatched");
  if (a.status !== "dispatched" || b.status !== "dispatched") return;
  assert.notEqual(a.run.runId, b.run.runId);
  assert.equal(h.calls.length, 2);
  assert.equal(h.events.filter((event) => event.kind === "merged").length, 0);
});

test("退出补发：同样先过聚合检查，命中就只并轮次 + 写 merged 遥测", async () => {
  const h = harness("shutdown");
  const first = await h.dispatch({ sessionId: "s1", skills: ["a"] });
  assert.equal(first.status, "dispatched");
  if (first.status !== "dispatched") return;
  const spawns = h.calls.length;

  const result = flushPendingSync(
    { sessionId: "s1", since: NOW - 1000, rounds: 2, skills: ["a"] },
    {
      evolutionDir: h.evolutionDir,
      cwd: os.tmpdir(),
      promptTemplatePath: TEMPLATE,
      maxRuntimeMs: 20 * 60_000,
      telemetry: { append: () => {}, appendSync: (event) => { h.events.push({ ...event, ts: NOW, iso: "" } as TelemetryEvent); }, flush: async () => undefined },
      env: {},
      spawnFn: (command, args, options) => {
        h.calls.push({ command, args, options });
        const child = new FakeChild(95_001 + h.children.length);
        h.children.push(child);
        return child as unknown as SpawnedChild;
      },
      autoReview: false,
      alive: () => true,
      log: (msg) => h.logs.push(msg),
    },
    NOW + 5_000,
  );

  assert.equal(result, "merged");
  assert.equal(h.calls.length, spawns, "补发并入时不许再起子进程");
  const coverage = readRun(h, first.run.runId).coverage as Record<string, unknown>;
  // 在途 run 派发时覆盖 1 轮，补发这 2 轮并进去 → 3 轮
  assert.deepEqual([coverage.rounds, coverage.merged], [3, 1]);
  const merged = h.events.filter((event) => event.kind === "merged");
  assert.deepEqual([merged[0]?.sessionId, merged[0]?.rounds], ["s1", 3]);
});
