/**
 * 采集与门禁单测（零依赖，node --test）。
 *
 * 运行：
 *   cd .pi/extensions/skill-evolve
 *   node --experimental-strip-types --test test/evolution.test.ts
 *
 * 覆盖：一轮只结算一次（连续 agent_settled 只派生一次）、无曝光不派生、
 * 子进程门禁、未命中只记「曝光了但没读」、读非曝光技能不算加载、状态与报告文本。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { fakeSupervisorSpawn } from "./fake-review-spawn.ts";
import { createEvolution, isChildProcess, type Evolution } from "../lib/evolution.ts";
import { writeWebPid } from "../lib/web/panel-pid.ts";
import { directQueue, type TelemetryEvent, type TelemetrySkill } from "../lib/telemetry.ts";
import type { SpawnedChild, SpawnLike } from "../lib/spawn-plan.ts";

const TEMPLATE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "prompts", "复盘.md");
const NOW = 1_760_000_000_000;

function skill(name: string, disabled = false): TelemetrySkill {
  return { name, filePath: `/repo/.pi/skills/${name}/SKILL.md`, disabled, source: "project" };
}

interface Harness {
  dir: string;
  evo: Evolution;
  spawns: number;
  /** 模拟某个子进程退出（收尸会顺手放锁） */
  exitChild: (index: number) => Promise<void>;
  children: FakeChild[];
  /** 评审督导的起进程记录（断言「关着就一个都不起」用） */
  supervisorCalls: { args: string[]; options: Record<string, unknown> }[];
  events: () => TelemetryEvent[];
  tick: (ms: number) => void;
}

class FakeChild {
  /** 锁回收用 kill(pid,0) 判存活：假 pid 会被当死进程，所以用真实存活的本进程 pid */
  readonly pid = process.pid;
  private listeners = new Map<string, (arg: unknown) => void>();
  unref(): void {} // detached 子进程交还给 init，测试里无事可做
  once(event: string, listener: (arg: unknown) => void): this {
    this.listeners.set(event, listener);
    return this;
  }
  emit(event: string, arg: unknown): void {
    this.listeners.get(event)?.(arg);
  }
}

/**
 * 夹具的 config.json：生产默认只开自动评审（采集 / 复盘 / 采纳关），所以每个用例都得显式打开；
 * 要验证「默认啥都不做」的用例直接自己建目录、不走这个 helper。
 */
function writeConfig(dir: string, config: Record<string, unknown> = {}): void {
  const evolutionDir = path.join(dir, ".pi", "evolution");
  fs.mkdirSync(evolutionDir, { recursive: true });
  fs.writeFileSync(
    path.join(evolutionDir, "config.json"),
    `${JSON.stringify({ enabled: true, telemetry: true, ...config }, null, 2)}\n`,
    "utf8",
  );
}

function harness(env: NodeJS.ProcessEnv = {}, config: Record<string, unknown> = {}): Harness {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skill-evolve-evo-"));
  writeConfig(dir, config);
  let clock = NOW;
  const children: FakeChild[] = [];
  const supervisorCalls: { args: string[]; options: Record<string, unknown> }[] = [];
  const spawnFn: SpawnLike = () => (children.push(new FakeChild()), children[children.length - 1] as unknown as SpawnedChild);
  const evo = createEvolution({
    cwd: dir,
    promptTemplatePath: TEMPLATE,
    queue: directQueue,
    log: () => {},
    now: () => clock,
    env,
    spawnFn,
    // 假子进程的 pid 就是本进程 pid（锁回收要真 pid 才判得活）；单飞闸用注入的 alive 模拟「子进程已退出」
    alive: () => false,
    supervisorSpawnFn: fakeSupervisorSpawn(supervisorCalls),
  });
  return {
    dir,
    evo,
    children,
    supervisorCalls,
    get spawns() {
      return children.length;
    },
    exitChild: async (index) => {
      children[index].emit("exit", 0);
      await settleAsync();
    },
    events: () => readTelemetry(dir),
    tick: (ms) => {
      clock += ms;
    },
  };
}

function readTelemetry(dir: string): TelemetryEvent[] {
  const shard = path.join(dir, ".pi", "evolution", "telemetry");
  let names: string[];
  try {
    names = fs.readdirSync(shard);
  } catch {
    return [];
  }
  const events: TelemetryEvent[] = [];
  for (const name of names.sort()) {
    for (const line of fs.readFileSync(path.join(shard, name), "utf8").split("\n")) {
      if (line.trim().length === 0) continue;
      events.push(JSON.parse(line));
    }
  }
  return events;
}

/** 等派发链路（异步写盘 + spawn）跑完 */
const settleAsync = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 150));

test("isChildProcess：任一子进程环境变量在场即为子进程", () => {
  assert.equal(isChildProcess({}), false);
  for (const key of ["SKILL_EVOLVE_CHILD", "PI_SUBAGENT_CHILD", "PI_AGENT_RUNNER", "PI_ASYNC_NATIVE_RUNNER"]) {
    assert.equal(isChildProcess({ [key]: "1" }), true);
  }
});

test("连续 agent_settled 只派生一次（一轮只结算一次）", async () => {
  const h = harness();
  h.evo.recordAdvertised({ sessionId: "s1", cwd: h.dir, prompt: "把需求推进到开发中", skills: [skill("a")] });
  h.evo.settle({ sessionId: "s1" });
  h.evo.settle({ sessionId: "s1" });
  await settleAsync();
  assert.equal(h.spawns, 1);
  assert.equal(h.events().filter((event) => event.kind === "pending").length, 1);
});

test("去抖：窗口内再结算一轮只写 superseded，不叠加进程", async () => {
  const h = harness();
  h.evo.recordAdvertised({ sessionId: "s1", cwd: h.dir, prompt: "第一轮", skills: [skill("a")] });
  h.evo.settle({ sessionId: "s1" });
  await settleAsync();
  assert.equal(h.spawns, 1);

  h.tick(1000); // 仍在 idleMs(90s) 内
  h.evo.recordAdvertised({ sessionId: "s1", cwd: h.dir, prompt: "第二轮", skills: [skill("a")] });
  h.evo.settle({ sessionId: "s1" });
  await settleAsync();
  assert.deepEqual([h.spawns, h.events().some((event) => event.kind === "superseded")], [1, true]);
});

test("本轮无技能曝光：不记未命中，也不派生", async () => {
  const h = harness();
  h.evo.recordAdvertised({ sessionId: "s1", cwd: h.dir, prompt: "闲聊", skills: [] });
  h.evo.settle({ sessionId: "s1" });
  await settleAsync();
  assert.deepEqual([h.spawns, h.events().some((event) => event.kind === "missed")], [0, false]);
});

test("子进程门禁：SKILL_EVOLVE_CHILD=1 时照常采集但不派生", async () => {
  const h = harness({ SKILL_EVOLVE_CHILD: "1" });
  h.evo.recordAdvertised({ sessionId: "s1", cwd: h.dir, prompt: "x", skills: [skill("a")] });
  h.evo.settle({ sessionId: "s1" });
  await settleAsync();
  assert.deepEqual([h.spawns, h.events().some((event) => event.kind === "pending")], [0, true]);
});

test("未命中只记「曝光了但没读」的技能，disabled 的不算曝光", async () => {
  const h = harness();
  h.evo.recordAdvertised({ sessionId: "s1", cwd: h.dir, prompt: "x", skills: [skill("a"), skill("b"), skill("c", true)] });
  h.evo.noteToolCall({ sessionId: "s1", toolCallId: "call-1", toolName: "read", input: { path: ".pi/skills/a/SKILL.md" } });
  h.evo.resolveToolResult({ sessionId: "s1", toolCallId: "call-1", isError: false });
  h.evo.settle({ sessionId: "s1" });
  await settleAsync();

  const events = h.events();
  assert.equal(events.filter((event) => event.kind === "loaded").length, 1);
  assert.deepEqual(events.filter((event) => event.kind === "missed").map((event) => event.skill), ["b"]);
  const pending = events.find((event) => event.kind === "pending");
  assert.deepEqual([pending?.exposed, pending?.missed], [2, 1]);
});

test("读技能失败记 failed，不记 loaded", async () => {
  const h = harness();
  h.evo.recordAdvertised({ sessionId: "s1", cwd: h.dir, prompt: "x", skills: [skill("a")] });
  h.evo.noteToolCall({ sessionId: "s1", toolCallId: "call-1", toolName: "bash", input: { command: 'cat ".pi/skills/a/SKILL.md"' } });
  h.evo.resolveToolResult({ sessionId: "s1", toolCallId: "call-1", isError: true });
  h.evo.settle({ sessionId: "s1" });
  await settleAsync();
  const kinds = h.events().map((event) => event.kind);
  assert.deepEqual([kinds.filter((kind) => kind === "failed").length, kinds.includes("loaded")], [1, false]);
});

test("读不在本轮曝光清单里的技能文件，不算一次加载", async () => {
  const h = harness();
  h.evo.recordAdvertised({ sessionId: "s1", cwd: h.dir, prompt: "x", skills: [skill("alpha")] });
  h.evo.noteToolCall({ sessionId: "s1", toolCallId: "call-1", toolName: "read", input: { path: ".pi/skills/beta/SKILL.md" } });
  h.evo.resolveToolResult({ sessionId: "s1", toolCallId: "call-1", isError: false });
  assert.equal(h.events().some((event) => event.kind === "loaded"), false);
});

test("tool_result 对齐不到 tool_call 时静默忽略（跨会话/子代理的工具结果）", async () => {
  const h = harness();
  h.evo.recordAdvertised({ sessionId: "s1", cwd: h.dir, prompt: "x", skills: [skill("a")] });
  h.evo.resolveToolResult({ sessionId: "s1", toolCallId: "未知", isError: false });
  await settleAsync();
  assert.equal(h.events().some((event) => event.kind === "loaded"), false);
});

test("statusText / reportText：无数据也不崩，且带上盲区提示", async () => {
  const h = harness();
  const status = await h.evo.statusText();
  assert.equal(
    status.includes(
      "采集：开（遥测写入 .pi/evolution/telemetry/）｜复盘：开（会派生 agent）｜评审：关（提案停在 proposed 等人工）｜采纳：关（auto 提案等人工批准）",
    ),
    true,
  );
  assert.equal(status.includes("锁：空闲"), true);
  const report = h.evo.reportText();
  assert.equal(report.includes("无曝光数据"), true);
  assert.equal(report.includes("加载率低 ≠ 技能没用"), true);
});

test("statusText：活着的 Web 面板记录多一行地址与 pid，死记录不显示", async () => {
  const h = harness();
  const evolutionDir = path.join(h.dir, ".pi", "evolution");
  const url = "http://127.0.0.1:7788";
  writeWebPid(evolutionDir, { pid: process.pid, host: "127.0.0.1", port: 7788, url, startedAt: NOW });
  assert.equal((await h.evo.statusText()).includes(`Web 面板：${url}（pid ${process.pid}）`), true);
  // 换成已死 pid：残记录不能当活面板显示（否则用户照着不存在的 pid 去清理）
  writeWebPid(evolutionDir, { pid: 2_147_483_646, host: "127.0.0.1", port: 7788, url, startedAt: NOW });
  assert.equal((await h.evo.statusText()).includes("Web 面板："), false);
});

test("reportText：按遥测给出曝光/加载/未命中", async () => {
  const h = harness();
  h.evo.recordAdvertised({ sessionId: "s1", cwd: h.dir, prompt: "x", skills: [skill("a"), skill("b")] });
  h.evo.noteToolCall({ sessionId: "s1", toolCallId: "call-1", toolName: "read", input: { path: ".pi/skills/a/SKILL.md" } });
  h.evo.resolveToolResult({ sessionId: "s1", toolCallId: "call-1", isError: false });
  h.evo.settle({ sessionId: "s1" });
  await settleAsync();
  const report = h.evo.reportText();
  assert.deepEqual(
    [report.includes("曝光：1 轮 / 2 次"), report.includes("加载：1 次"), report.includes("50.0%"), report.includes("1. b × 1")],
    [true, true, true, true],
  );
});

test("setEnabled：off 四个全关、on 只开复盘（不动采集 / 评审 / 采纳）", async () => {
  const h = harness();
  const message = await h.evo.setEnabled(false);
  assert.equal(message.includes("关闭"), true);
  const raw = JSON.parse(fs.readFileSync(path.join(h.dir, ".pi", "evolution", "config.json"), "utf8"));
  assert.deepEqual([raw.enabled, raw.telemetry, raw.autoReview, raw.autoApply], [false, false, false, false]);
  assert.equal((await h.evo.statusText()).includes("采集：关（不写遥测）｜复盘：关（不会派生 agent）｜评审：关（提案停在 proposed 等人工）｜采纳：关（auto 提案等人工批准）"), true);

  await h.evo.setEnabled(true);
  const back = JSON.parse(fs.readFileSync(path.join(h.dir, ".pi", "evolution", "config.json"), "utf8"));
  // 用户定的语义（2026-11-08）：四个开关各管一段，on 只开自动复盘；评审要另外 review on
  assert.deepEqual([back.enabled, back.autoReview, back.telemetry, back.autoApply], [true, false, false, false]);
});

test("setFlag：只切一个字段，并把当前四个开关的状态写进回执", async () => {
  const h = harness({}, { enabled: false, telemetry: false, autoReview: false });
  const text = await h.evo.setFlag("telemetry", true);
  // 回执要能看出「只开了采集、复盘/评审还关着」，否则用户以为已经会花 token 了
  assert.equal(
    text.includes("采集：开（遥测写入 .pi/evolution/telemetry/）｜复盘：关（不会派生 agent）｜评审：关（提案停在 proposed 等人工）"),
    true,
  );
  const raw = JSON.parse(fs.readFileSync(path.join(h.dir, ".pi", "evolution", "config.json"), "utf8"));
  assert.deepEqual([raw.enabled, raw.telemetry], [false, true], "setFlag(telemetry) 不碰复盘");
  await h.evo.setFlag("enabled", true);
  const after = JSON.parse(fs.readFileSync(path.join(h.dir, ".pi", "evolution", "config.json"), "utf8"));
  assert.deepEqual([after.enabled, after.telemetry], [true, true], "setFlag(enabled) 不碰采集");
  await h.evo.setFlag("autoReview", true);
  const judged = JSON.parse(fs.readFileSync(path.join(h.dir, ".pi", "evolution", "config.json"), "utf8"));
  assert.deepEqual(
    [judged.enabled, judged.telemetry, judged.autoReview, judged.autoApply],
    [true, true, true, false],
    "review 只翻 autoReview：复盘/采集/采纳都不许跟着动",
  );
});

test("没有 config.json 时默认全关：不派生、不落遥测", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skill-evolve-evo-default-"));
  const evo = createEvolution({
    cwd: dir,
    promptTemplatePath: TEMPLATE,
    queue: directQueue,
    log: () => {},
    now: () => NOW,
    env: {},
    spawnFn: (() => {
      throw new Error("默认全关时不该起子进程");
    }) as unknown as SpawnLike,
    supervisorSpawnFn: fakeSupervisorSpawn([]),
  });
  const status = await evo.statusText();
  assert.equal(
    status.includes("采集：关（不写遥测）｜复盘：关（不会派生 agent）｜评审：关（提案停在 proposed 等人工）｜采纳：关（auto 提案等人工批准）"),
    true,
    "默认四个全关：采集 / 复盘 / 评审 / 采纳都不动",
  );
  evo.recordAdvertised({ sessionId: "s1", cwd: dir, prompt: "x", skills: [skill("a")] });
  evo.settle({ sessionId: "s1" });
  await settleAsync();
  assert.deepEqual(readTelemetry(dir), [], "默认关：遥测也不写");
});

test("autoReview 关着：退出前补发照跑，但不起督导（run 停在 proposed 等人工）", async () => {
  const h = harness({}, { autoReview: false });
  h.evo.recordAdvertised({ sessionId: "s1", cwd: h.dir, prompt: "第1轮", skills: [skill("a")] });
  h.evo.settle({ sessionId: "s1" });
  await settleAsync();
  assert.equal(h.spawns, 1, "复盘本身照旧派发");
  assert.equal(h.supervisorCalls.length, 0, "评审关着：派发路径也不许起督导");
  await h.exitChild(0);

  h.tick(1000);
  h.evo.recordAdvertised({ sessionId: "s1", cwd: h.dir, prompt: "第2轮", skills: [skill("b")] });
  h.evo.settle({ sessionId: "s1" });
  await settleAsync();
  h.evo.shutdown();
  assert.equal(h.spawns, 2, "退出补发这条路径同样要派发复盘");
  assert.equal(h.supervisorCalls.length, 0, "退出补发路径也要看评审开关");
});

test("telemetry 关着时只记开关状态不落盘（collect on 之后才采集）", async () => {
  const h = harness({}, { telemetry: false });
  h.evo.recordAdvertised({ sessionId: "s1", cwd: h.dir, prompt: "x", skills: [skill("a")] });
  await settleAsync();
  assert.deepEqual(h.events(), []);
  // 2026-11-08 起 on 不再顺带开采集：采集必须显式 collect on
  await h.evo.setFlag("telemetry", true);
  h.evo.recordAdvertised({ sessionId: "s1", cwd: h.dir, prompt: "y", skills: [skill("a")] });
  await settleAsync();
  assert.equal(h.events().some((event) => event.kind === "advertised"), true, "on 之后同一会话就采集");
});

test("去抖尾巴：3 轮 → 1 次派发 + 2 次 superseded，shutdown 再补发一次（覆盖后 2 轮）", async () => {
  const h = harness();
  h.evo.recordAdvertised({ sessionId: "s1", cwd: h.dir, prompt: "第1轮", skills: [skill("a")] });
  h.evo.settle({ sessionId: "s1" });
  await settleAsync();
  assert.equal(h.spawns, 1);
  await h.exitChild(0); // 第一轮的子进程跑完并放锁

  for (const [prompt, name] of [["第2轮", "b"], ["第3轮", "c"]] as const) {
    h.tick(1000);
    h.evo.recordAdvertised({ sessionId: "s1", cwd: h.dir, prompt, skills: [skill(name)] });
    h.evo.settle({ sessionId: "s1" });
    await settleAsync();
  }
  assert.equal(h.spawns, 1);
  assert.equal(h.events().filter((event) => event.kind === "superseded").length, 2);

  h.evo.shutdown();
  assert.equal(h.spawns, 2);
  const shutdownRun = readRuns(h.dir).find((record) => record.trigger === "shutdown");
  assert.deepEqual([shutdownRun?.skills, (shutdownRun?.coverage as { rounds: number } | undefined)?.rounds], [["b", "c"], 2]);
  assert.equal(h.events().some((event) => event.kind === "dispatched" && event.trigger === "shutdown"), true);
});

test("shutdown：锁仍被在跑的 run 占着时写 skipped，不起第二个进程", async () => {
  const h = harness();
  h.evo.recordAdvertised({ sessionId: "s1", cwd: h.dir, prompt: "第1轮", skills: [skill("a")] });
  h.evo.settle({ sessionId: "s1" });
  await settleAsync();
  h.tick(1000);
  h.evo.recordAdvertised({ sessionId: "s1", cwd: h.dir, prompt: "第2轮", skills: [skill("a")] });
  h.evo.settle({ sessionId: "s1" });
  await settleAsync();
  h.evo.shutdown(); // 锁仍被第一轮的 run 占着，补发必须让位
  assert.equal(h.spawns, 1);
  assert.equal(h.events().some((event) => event.kind === "skipped" && event.trigger === "shutdown"), true);
});

test("runNow：手动派发跳过去抖，锁被占时给明确文案", async () => {
  const h = harness();
  h.evo.recordAdvertised({ sessionId: "s1", cwd: h.dir, prompt: "x", skills: [skill("a")] });

  const first = await h.evo.runNow({ sessionId: "s1" });
  assert.equal(first.includes("已派生复盘"), true);
  assert.equal(first.includes(path.join(".pi", "evolution", "runs")), true);
  assert.equal(h.spawns, 1);

  // 子进程还在跑：第二次必须让位并说清是谁占着
  const blocked = await h.evo.runNow({ sessionId: "s1" });
  assert.equal(blocked.includes("已有复盘在跑（pid"), true);
});

test("runNow：总开关关着时提示先 on", async () => {
  const h = harness();
  await h.evo.setEnabled(false);
  h.evo.recordAdvertised({ sessionId: "s1", cwd: h.dir, prompt: "x", skills: [skill("a")] });
  const message = await h.evo.runNow({ sessionId: "s1" });
  assert.equal(message.includes("/skill-evolve on"), true);
});

function readRuns(dir: string): Record<string, unknown>[] {
  const runsDir = path.join(dir, ".pi", "evolution", "runs");
  let names: string[];
  try {
    names = fs.readdirSync(runsDir);
  } catch {
    return [];
  }
  return names.map((name) => JSON.parse(fs.readFileSync(path.join(runsDir, name, "run.json"), "utf8")) as Record<string, unknown>);
}
