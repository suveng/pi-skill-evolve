/**
 * 派发单测（零依赖，node --test）。
 *
 * 运行：
 *   cd .pi/extensions/skill-evolve
 *   node --experimental-strip-types --test test/dispatch.test.ts
 *
 * 覆盖：pi 路径解析优先级、runId 形态、去抖判据、run.json 落盘与状态机、
 * 抢锁失败/开关关闭/单会话上限三条跳过路径、「无会话原文降级 telemetry-only」、
 * 以及本轮重点：**去抖把尾巴整段带上的三条路径**（窗口过后合并派发 / 退出补发 / 手动绕过去抖）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_CONFIG, type EvolutionConfig } from "../lib/config.ts";
import { createDispatcher, shouldDebounce } from "../lib/dispatch.ts";
import { acquireLock, releaseLock } from "../lib/lock.ts";
import { buildPrompt } from "../lib/prompt.ts";
import { DEFAULT_PI_BIN, resolvePiBin, runIdFor, sessionHashOf, type SpawnedChild, type SpawnLike } from "../lib/spawn-plan.ts";
import { directQueue, type TelemetryEvent, type TelemetryInput, type TelemetryWriter } from "../lib/telemetry.ts";
import { fakeSupervisorSpawn } from "./fake-review-spawn.ts";

const TEMPLATE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "prompts", "复盘.md");
const NOW = 1_760_000_000_000;
const MAX = 20 * 60_000;

class FakeChild {
  readonly pid: number;
  private listeners = new Map<string, (arg: unknown) => void>();
  // 锁回收用 process.kill(pid, 0) 校验存活：拿一个乱编的 pid 会被当成死进程、锁被当成孤儿回收，
  // 所以假子进程统一用真实存活的 pid（就是本进程）模拟
  constructor() {
    this.pid = process.pid;
  }
  unref(): void {
    // detached 子进程交还给 init，测试里无事可做
  }
  once(event: string, listener: (arg: unknown) => void): this {
    this.listeners.set(event, listener);
    return this;
  }
  emit(event: string, arg: unknown): void {
    this.listeners.get(event)?.(arg);
  }
}

interface Harness {
  dir: string;
  calls: { command: string; args: string[]; options: Record<string, unknown> }[];
  children: FakeChild[];
  supervisorCalls: { args: string[]; options: Record<string, unknown> }[];
  events: TelemetryEvent[];
  tick: (ms: number) => void;
  dispatch: ReturnType<typeof createDispatcher>["dispatch"];
  flushPending: ReturnType<typeof createDispatcher>["flushPending"];
  config: EvolutionConfig;
}

function harness(tag: string, overrides: Partial<EvolutionConfig> = {}): Harness {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `skill-evolve-${tag}-`));
  const calls: Harness["calls"] = [];
  const children: FakeChild[] = [];
  const events: TelemetryEvent[] = [];
  const spawnFn: SpawnLike = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new FakeChild();
    children.push(child);
    return child as unknown as SpawnedChild;
  };
  const pushEvent = (event: TelemetryInput): void => {
    events.push({ ...event, ts: NOW, iso: "" } as TelemetryEvent);
  };
  const writer: TelemetryWriter = { append: pushEvent, appendSync: pushEvent, flush: async () => undefined };
  // 生产默认全关（clone 即静默）：夹具必须显式打开，否则每个用例都会被「未启用」静默跳过
  const config: EvolutionConfig = { ...DEFAULT_CONFIG, enabled: true, telemetry: true, ...overrides };
  const supervisorCalls: { args: string[]; options: Record<string, unknown> }[] = []; // 假督导只记参数：真起 node 会留 900 秒后台进程
  let clock = NOW;
  const dispatcher = createDispatcher({
    evolutionDir: path.join(dir, ".pi", "evolution"),
    cwd: dir,
    config,
    telemetry: writer,
    queue: directQueue,
    promptTemplatePath: TEMPLATE,
    log: () => {},
    now: () => clock,
    env: {},
    spawnFn,
    // 假子进程 pid = 本进程 pid（锁回收靠真 pid 判活）；单飞闸用注入的 alive 模拟「已退出」
    alive: () => false,
    supervisorSpawnFn: fakeSupervisorSpawn(supervisorCalls),
  });
  return {
    dir,
    calls,
    supervisorCalls,
    children,
    events,
    tick: (ms) => { clock += ms; },
    dispatch: dispatcher.dispatch,
    flushPending: dispatcher.flushPending,
    config,
  };
}

function readRun(dir: string, runId: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(dir, ".pi", "evolution", "runs", runId, "run.json"), "utf8"));
}

const settleAsync = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 120));

/** 模拟子进程正常跑完：收尸会顺手放锁，后面的派发才抢得到 */
async function childExits(h: Harness, index: number): Promise<void> {
  h.children[index].emit("exit", 0);
  await settleAsync();
}

const argsOf = (h: Harness, index = 0): string => (h.calls.length > index ? h.calls[index].args.join("\n") : "");

test("纯函数：pi 路径优先级、runId 形态、去抖判据", () => {
  assert.equal(resolvePiBin({ SKILL_EVOLVE_PI_BIN: "/a/pi", PI_SUBAGENT_PI_BINARY: "/b/pi" }), "/a/pi");
  assert.equal(resolvePiBin({ PI_SUBAGENT_PI_BINARY: "/b/pi" }), "/b/pi");
  assert.equal(resolvePiBin({}), DEFAULT_PI_BIN);
  assert.equal(runIdFor("sess-1", NOW), `${sessionHashOf("sess-1").slice(0, 8)}-${Math.floor(NOW / 1000)}`);
  assert.notEqual(runIdFor("sess-1", NOW), runIdFor("sess-2", NOW));
  assert.equal(shouldDebounce(undefined, NOW, 90_000), false);
  assert.equal(shouldDebounce(NOW - 1000, NOW, 90_000), true);
  assert.equal(shouldDebounce(NOW - 90_000, NOW, 90_000), false);
});

test("纯函数：pi 路径在陌生机器上也解得出来（不写死别人的家目录）", () => {
  // 2026-11-09 事故回归：常量必须跟当前用户 home 走，且 home 不存在时退到 PATH
  assert.equal(DEFAULT_PI_BIN, path.join(os.homedir(), ".pi", "agent", "bin", "pi"));
  const none = (): boolean => false;
  assert.equal(resolvePiBin({}, { exists: none }), DEFAULT_PI_BIN);
  const onPath = path.join("/opt/node/bin", "pi");
  assert.equal(resolvePiBin({ PATH: ["/x", path.dirname(onPath)].join(path.delimiter) }, { exists: (p) => p === onPath }), onPath);
  // home 下的优先于 PATH
  assert.equal(resolvePiBin({ PATH: path.dirname(onPath) }, { exists: () => true }), DEFAULT_PI_BIN);
});

test("buildPrompt：带会话原文/索引/run 目录，并写清覆盖轮数", () => {
  const full = buildPrompt({ template: "模板", sessionFile: "/s.jsonl", indexFile: "/i.json", runDir: "/r", sessionId: "s1", skills: ["a", "b"], dispatchedAt: NOW });
  assert.equal(full.includes("会话原文：/s.jsonl"), true);
  assert.equal(full.includes("技能清单（逐个判定，不许遗漏也不许新增）：a、b"), true);
  assert.equal(full.includes("覆盖轮数：1 轮"), true);
  const merged = buildPrompt({ template: "模板", indexFile: "/i.json", runDir: "/r", sessionId: "s1", skills: [], dispatchedAt: NOW, coverage: { rounds: 3, since: NOW } });
  assert.equal(merged.includes("合并了 3 轮"), true);
  assert.equal(merged.includes("telemetry-only"), true);
  assert.equal(merged.includes("（本轮无曝光技能）"), true);
});

test("dispatch 成功：spawn 参数、env、run.json、会话索引都到位", async () => {
  const h = harness("ok");
  const sessionFile = path.join(h.dir, "session.jsonl");
  fs.writeFileSync(sessionFile, `${JSON.stringify({ type: "session", id: "sess-1", cwd: h.dir })}\n`, "utf8");

  const outcome = await h.dispatch({ sessionId: "sess-1", skills: ["a"], sessionFile });
  assert.equal(outcome.status, "dispatched");
  if (outcome.status !== "dispatched") return;
  const { command, args, options } = h.calls[0];
  assert.equal(command, DEFAULT_PI_BIN);
  // 子进程会话落进 run 目录的 agents/：面板要能像看待普通会话一样打开它
  assert.deepEqual(args.slice(0, 6), [
    "-p",
    "--session-dir",
    path.join(h.dir, ".pi", "evolution", "runs", outcome.run.runId, "agents"),
    "--session-id",
    "se-analyze",
    "-ns",
  ]);
  assert.equal(args.some((arg) => arg.includes(sessionFile)), true, "prompt 里要带上用户会话路径");
  assert.equal(options.detached, true);
  assert.equal((options.env as NodeJS.ProcessEnv).SKILL_EVOLVE_CHILD, "1");
  // stdout+stderr 必须落到 run 目录下的 child.log：子进程静默死掉时这是唯一的现场
  const stdio = options.stdio as [string, number, number];
  assert.deepEqual([stdio[0], stdio[1] === stdio[2], typeof stdio[1]], ["ignore", true, "number"]);
  const childLog = path.join(h.dir, ".pi", "evolution", "runs", outcome.run.runId, "child.log");
  assert.equal(fs.existsSync(childLog), true, "child.log 必须先建出来（append 模式）");

  const record = readRun(h.dir, outcome.run.runId);
  assert.deepEqual([record.status, record.trigger, record.evidenceMode, record.pid], ["dispatched", "auto", "session+telemetry", process.pid]);
  assert.deepEqual(record.skills, ["a"]);
  assert.equal(fs.existsSync(path.join(h.dir, ".pi", "evolution", "runs", outcome.run.runId, "00-session", "index.json")), true);
  assert.equal(h.events.some((event) => event.kind === "dispatched"), true);
  await releaseLock(path.join(h.dir, ".pi", "evolution"));
});

test("dispatch 去抖：窗口内第二次写 superseded 并记 pending，不再起进程", async () => {
  const h = harness("debounce");
  assert.equal((await h.dispatch({ sessionId: "sess-1", skills: ["a"] })).status, "dispatched");
  h.tick(1000);
  const second = await h.dispatch({ sessionId: "sess-1", skills: ["b"] });
  assert.deepEqual(second, { status: "superseded", rounds: 1 });
  assert.equal(h.calls.length, 1);
  assert.equal(h.events.filter((event) => event.kind === "superseded").length, 1);
  await releaseLock(path.join(h.dir, ".pi", "evolution"));
});

test("去抖尾巴：3 轮 → 1 次派发 + 2 次 superseded，退出时补发一次补上后 2 轮", async () => {
  const h = harness("tail");
  assert.equal((await h.dispatch({ sessionId: "s1", skills: ["a"] })).status, "dispatched");
  await childExits(h, 0); // 第一轮的子进程跑完并放锁

  h.tick(1000);
  assert.deepEqual(await h.dispatch({ sessionId: "s1", skills: ["b"] }), { status: "superseded", rounds: 1 });
  h.tick(1000);
  assert.deepEqual(await h.dispatch({ sessionId: "s1", skills: ["c"] }), { status: "superseded", rounds: 2 });
  assert.equal(h.calls.length, 1);

  assert.equal(h.flushPending(), 1);
  assert.equal(h.calls.length, 2);
  // 第一轮已经被第一次派发覆盖，补发只盖后面 2 轮
  assert.equal(argsOf(h, 1).includes("合并了 2 轮"), true);
  const records = fs.readdirSync(path.join(h.dir, ".pi", "evolution", "runs"));
  const last = records.map((runId) => readRun(h.dir, runId)).find((record) => record.trigger === "shutdown");
  assert.ok(last);
  assert.deepEqual(last.skills, ["b", "c"]);
  assert.deepEqual((last.coverage as { rounds: number }).rounds, 2);
  assert.equal(h.events.some((event) => event.kind === "dispatched" && event.trigger === "shutdown"), true);
  // 已经补发过，再调一次不会重复起进程
  assert.equal(h.flushPending(), 0);
});

test("去抖尾巴：静默窗口过后的一轮正常派发，并合并在途的 2 轮", async () => {
  const h = harness("window");
  await h.dispatch({ sessionId: "s1", skills: ["a"] });
  await childExits(h, 0);
  h.tick(1000);
  await h.dispatch({ sessionId: "s1", skills: ["b"] });
  h.tick(1000);
  await h.dispatch({ sessionId: "s1", skills: ["c"] });
  assert.equal(h.calls.length, 1);

  h.tick(DEFAULT_CONFIG.idleMs + 1);
  const outcome = await h.dispatch({ sessionId: "s1", skills: ["d"] });
  assert.equal(outcome.status, "dispatched");
  assert.equal(h.calls.length, 2);
  assert.equal(argsOf(h, 1).includes("合并了 3 轮"), true);
  await releaseLock(path.join(h.dir, ".pi", "evolution"));
});

test("退出补发：锁还被别人占着时写 skipped 且不起进程", async () => {
  const h = harness("flush-locked");
  await h.dispatch({ sessionId: "s1", skills: ["a"] });
  h.tick(1000);
  await h.dispatch({ sessionId: "s1", skills: ["b"] });
  // 第一轮的子进程没退出 → 锁仍被自己持有，补发必须让位
  assert.equal(h.flushPending(), 0);
  assert.equal(h.calls.length, 1);
  assert.equal(h.events.some((event) => event.kind === "skipped" && event.trigger === "shutdown"), true);
});

test("dispatch 跳过：开关关闭、单会话上限、锁被占用", async () => {
  const off = harness("disabled", { enabled: false });
  assert.deepEqual(await off.dispatch({ sessionId: "s1", skills: ["a"] }), { status: "skipped", why: "disabled", ownerPid: null });
  assert.equal(off.calls.length, 0);

  const capped = harness("cap", { perSessionCap: 1, idleMs: 0 });
  assert.equal((await capped.dispatch({ sessionId: "s1", skills: ["a"] })).status, "dispatched");
  await childExits(capped, 0);
  capped.tick(10);
  assert.deepEqual(await capped.dispatch({ sessionId: "s1", skills: ["a"] }), { status: "skipped", why: "cap", ownerPid: null });
  assert.equal(capped.calls.length, 1);

  const locked = harness("locked");
  const evolutionDir = path.join(locked.dir, ".pi", "evolution");
  const held = await acquireLock({ evolutionDir, owner: { pid: process.pid, ts: NOW, sessionId: "other" }, maxRuntimeMs: MAX, now: () => NOW });
  assert.equal(held.ok, true);
  const outcome = await locked.dispatch({ sessionId: "s1", skills: ["a"] });
  assert.equal(outcome.status, "skipped");
  assert.equal(outcome.status === "skipped" ? outcome.why : "", "lock");
  assert.equal(locked.calls.length, 0);
  await releaseLock(evolutionDir);
});

test("手动 run：跳过去抖与单会话上限，但仍守全局锁", async () => {
  const h = harness("manual", { perSessionCap: 1, idleMs: 0 });
  assert.equal((await h.dispatch({ sessionId: "s1", skills: ["a"] })).status, "dispatched");
  await childExits(h, 0);

  // 同会话第二次自动派发会被 cap 挡下
  h.tick(10);
  assert.equal((await h.dispatch({ sessionId: "s1", skills: ["a"] })).status, "skipped");

  const manual = await h.dispatch({ sessionId: "s1", skills: ["a"] }, { bypassThrottle: true });
  assert.equal(manual.status, "dispatched");
  assert.equal(h.calls.length, 2);
  const records = fs.readdirSync(path.join(h.dir, ".pi", "evolution", "runs")).map((runId) => readRun(h.dir, runId));
  assert.equal(records.some((record) => record.trigger === "manual"), true);

  // 子进程还在跑（锁未释放）时，手动派发也必须让位
  h.tick(10);
  const blocked = await h.dispatch({ sessionId: "s1", skills: ["a"] }, { bypassThrottle: true });
  assert.equal(blocked.status, "skipped");
  assert.equal(blocked.status === "skipped" ? blocked.ownerPid : 0, process.pid);
});

test("dispatch 无会话原文：降级 telemetry-only 且不产索引", async () => {
  const h = harness("degraded");
  const outcome = await h.dispatch({ sessionId: "s1", skills: ["a"] });
  if (outcome.status !== "dispatched") return assert.fail("应当派发成功");
  const record = readRun(h.dir, outcome.run.runId);
  assert.deepEqual([record.evidenceMode, record.artifacts], ["telemetry-only", {}]);
  assert.equal(argsOf(h).includes("telemetry-only"), true);
  // 没有索引就明说不可用，别让子进程去读一个不存在的 index.json
  assert.equal(argsOf(h).includes("索引：不可用（evidenceMode=telemetry-only"), true);
  await releaseLock(path.join(h.dir, ".pi", "evolution"));
});

test("dispatch 收尸：子进程非零退出 → run.json 标 abandoned 并放锁", async () => {
  const h = harness("abandon");
  const outcome = await h.dispatch({ sessionId: "s1", skills: ["a"] });
  if (outcome.status !== "dispatched") return assert.fail("应当派发成功");
  h.children[0].emit("exit", 3);
  await settleAsync();
  const record = readRun(h.dir, outcome.run.runId);
  assert.equal(record.status, "abandoned");
  assert.equal(String(record.abandonedReason).includes("exit 3"), true);
  assert.equal(fs.existsSync(path.join(h.dir, ".pi", "evolution", "locks", "dispatch")), false);
});
