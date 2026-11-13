/**
 * 全局单飞闸的三处接入点（用户 2026-11-08：「每次最多一个复盘agent」）：
 * 派发 / 退出补发 / 评审督导都必须在已有活着子进程时**不 spawn**，并写 `skipped(busy)` 遥测。
 *
 * spawn 一律换成抛错或计数的假函数：这个文件不产生任何真进程。
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { DEFAULT_CONFIG } from "../lib/config.ts";
import { createDispatcher } from "../lib/dispatch.ts";
import { spawnReviewSupervisor } from "../lib/review-spawn.ts";
import { flushPendingSync } from "../lib/shutdown-dispatch.ts";
import type { SpawnedChild, SpawnLike } from "../lib/spawn-plan.ts";
import { directQueue, type TelemetryInput, type TelemetryWriter } from "../lib/telemetry.ts";

const TEMPLATE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "prompts", "复盘.md");
const NOW = 1_760_000_000_000;
const OCCUPIED_PID = 7777;

class FakeChild {
  readonly pid: number;
  constructor(pid: number) {
    this.pid = pid;
  }
  unref(): void {
    // 测试里不存在真子进程，无需交还
  }
  once(): this {
    // 不收尸：本文件只验证「有没有 spawn」，退出一条另有用例
    return this;
  }
}

interface Ctx {
  cwd: string;
  evolutionDir: string;
  spawns: number;
  supervisorSpawns: number;
  events: TelemetryInput[];
  syncEvents: TelemetryInput[];
  telemetry: TelemetryWriter;
  /** 只有 OCCUPIED_PID 算活着：其余 pid（含本进程）一律当已退出 */
  alive: (pid: number) => boolean;
}

function workspace(): Ctx {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "skill-evolve-busy-"));
  const events: TelemetryInput[] = [];
  const syncEvents: TelemetryInput[] = [];
  const ctx: Ctx = {
    cwd,
    evolutionDir: path.join(cwd, ".pi", "evolution"),
    spawns: 0,
    supervisorSpawns: 0,
    events,
    syncEvents,
    telemetry: {
      append: (event) => events.push(event),
      appendSync: (event) => syncEvents.push(event),
      flush: async () => undefined,
    },
    alive: (pid) => pid === OCCUPIED_PID,
  };
  return ctx;
}

/** 造一条「已被别人占着」的 run：pid 活着 */
function occupy(ctx: Ctx, runId = "other"): string {
  const runDir = path.join(ctx.evolutionDir, "runs", runId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(
    path.join(runDir, "run.json"),
    JSON.stringify({ runId, status: "dispatched", pid: OCCUPIED_PID, dispatchedAt: NOW - 60_000 }),
    "utf8",
  );
  return runDir;
}

function readRun(runDir: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(runDir, "run.json"), "utf8"));
}

const noSpawn: SpawnLike = () => {
  throw new Error("全局单飞闸挡住的派发不该 spawn");
};

test("dispatch：已有活的复盘子进程 → 不 spawn，返回 queued 排队并写遥测", async () => {
  const ctx = workspace();
  occupy(ctx);
  const dispatcher = createDispatcher({
    evolutionDir: ctx.evolutionDir,
    cwd: ctx.cwd,
    config: { ...DEFAULT_CONFIG, enabled: true, telemetry: true },
    telemetry: ctx.telemetry,
    queue: directQueue,
    promptTemplatePath: TEMPLATE,
    log: () => {},
    now: () => NOW,
    env: {},
    spawnFn: noSpawn,
    alive: ctx.alive,
    supervisorSpawnFn: () => {
      throw new Error("被挡住时也不该起督导");
    },
  });
  const outcome = await dispatcher.dispatch({ sessionId: "s1", skills: ["fast-test"] });
  // 2026-11-13 用户要求「多个会话结束要支持排队」：挡下的一轮不再丢，而是排进 dispatch-queue.json
  assert.deepEqual(outcome, { status: "queued", sessionId: "s1", depth: 1 });
  const queuedFile = path.join(ctx.evolutionDir, "dispatch-queue.json");
  assert.equal(fs.existsSync(queuedFile), true, "被单飞闸挡下的一轮必须排队，不能丢");
  const queued = JSON.parse(fs.readFileSync(queuedFile, "utf8")) as Array<Record<string, unknown>>;
  assert.deepEqual(queued.map((row) => [row.sessionId, row.rounds, row.skills]), [["s1", 1, ["fast-test"]]]);
  const busy = ctx.events.filter((event) => event.kind === "skipped" && event.why === "busy");
  assert.equal(busy.length, 1);
  assert.deepEqual(busy[0]!.occupant, { runId: "other", pid: OCCUPIED_PID, kind: "复盘" });
  assert.equal(fs.existsSync(path.join(ctx.evolutionDir, "runs", "other", "child.log")), false, "占用者的东西不能被改");
});

test("dispatch：没有占用时照常派发（闸门不误伤正常路径）", async () => {
  const ctx = workspace();
  const calls: string[][] = [];
  const spawnFn: SpawnLike = (_command, args) => {
    calls.push(args);
    return new FakeChild(4242) as unknown as SpawnedChild;
  };
  const dispatcher = createDispatcher({
    evolutionDir: ctx.evolutionDir,
    cwd: ctx.cwd,
    config: { ...DEFAULT_CONFIG, enabled: true, telemetry: true },
    telemetry: ctx.telemetry,
    queue: directQueue,
    promptTemplatePath: TEMPLATE,
    log: () => {},
    now: () => NOW,
    env: {},
    spawnFn,
    alive: ctx.alive,
    supervisorSpawnFn: () => null,
  });
  const outcome = await dispatcher.dispatch({ sessionId: "s1", skills: ["fast-test"] });
  assert.equal(outcome.status, "dispatched");
  assert.equal(calls.length, 1);
});

test("shutdown-dispatch：已有活的督导 → 不 spawn，同步写 busy，且不建新 run 目录", () => {
  const ctx = workspace();
  const runDir = occupy(ctx);
  // 占用者只有督导活着（复盘 pid 已退出）：闸门看 supervisorPid 这一位
  fs.writeFileSync(
    path.join(runDir, "run.json"),
    JSON.stringify({ runId: "other", status: "analyzed", pid: null, supervisorPid: OCCUPIED_PID, dispatchedAt: NOW }),
    "utf8",
  );
  const before = fs.readdirSync(path.join(ctx.evolutionDir, "runs")).length;
  const result = flushPendingSync(
    { sessionId: "s1", since: NOW - 1000, rounds: 2, skills: ["fast-test"] },
    {
      evolutionDir: ctx.evolutionDir,
      cwd: ctx.cwd,
      promptTemplatePath: TEMPLATE,
      maxRuntimeMs: 20 * 60_000,
      telemetry: ctx.telemetry,
      env: {},
      spawnFn: noSpawn,
      autoReview: true,
      alive: ctx.alive,
      log: () => {},
    },
    NOW,
  );
  assert.equal(result, "skipped");
  assert.equal(fs.readdirSync(path.join(ctx.evolutionDir, "runs")).length, before, "被挡住就不该留下半成品 run");
  const busy = ctx.syncEvents.filter((event) => event.kind === "skipped" && event.why === "busy");
  assert.equal(busy.length, 1, "退出路径必须同步落盘（异步 append 可能来不及写）");
  assert.equal(busy[0]!.trigger, "shutdown");
  assert.equal(busy[0]!.rounds, 2);
});

test("review-spawn：别的 run 的复盘活着 → 不起督导，写 busy 遥测", () => {
  const ctx = workspace();
  occupy(ctx);
  const runDir = path.join(ctx.evolutionDir, "runs", "mine");
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, "run.json"), JSON.stringify({ runId: "mine", status: "dispatched" }), "utf8");

  const pid = spawnReviewSupervisor({
    runDir,
    cwd: ctx.cwd,
    env: {},
    autoReview: true,
    telemetry: ctx.telemetry,
    alive: ctx.alive,
    log: () => {},
    spawnFn: () => {
      throw new Error("被挡住时不该起督导");
    },
  });
  assert.equal(pid, null);
  const busy = ctx.events.filter((event) => event.kind === "skipped" && event.why === "busy");
  assert.equal(busy.length, 1);
  assert.equal(busy[0]!.occupant.runId, "other");
  assert.equal(readRun(runDir).supervisorPid, undefined, "没起督导就不能写 supervisorPid");
});

test("review-spawn：自己这条 run 的复盘活着不算占用，起督导并把 pid 写进 supervisorPid", () => {
  const ctx = workspace();
  const runDir = path.join(ctx.evolutionDir, "runs", "mine");
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(
    path.join(runDir, "run.json"),
    JSON.stringify({ runId: "mine", status: "dispatched", pid: OCCUPIED_PID }),
    "utf8",
  );
  const pid = spawnReviewSupervisor({
    runDir,
    cwd: ctx.cwd,
    env: {},
    autoReview: true,
    telemetry: ctx.telemetry,
    alive: ctx.alive,
    log: () => {},
    spawnFn: () => ({ pid: 9090, unref: () => undefined }),
  });
  assert.equal(pid, 9090);
  assert.equal(readRun(runDir).supervisorPid, 9090, "督导 pid 是第二个占用位，必须落盘");
});
