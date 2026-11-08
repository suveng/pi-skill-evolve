/**
 * 派发 ↔ 评审督导的接线单测：同一次派发里必须同时起复盘与督导，
 * 而「自检没过」这道门禁必须早于任何 spawn（否则白起一个 900 秒的轮询进程）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_CONFIG, type EvolutionConfig } from "../lib/config.ts";
import { createDispatcher } from "../lib/dispatch.ts";
import type { SpawnedChild, SpawnLike } from "../lib/spawn-plan.ts";
import { directQueue, type TelemetryEvent, type TelemetryInput, type TelemetryWriter } from "../lib/telemetry.ts";
import { fakeSupervisorSpawn } from "./fake-review-spawn.ts";

const TEMPLATE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "prompts", "复盘.md");
const NOW = 1_760_000_000_000;

class FakeChild {
  readonly pid = process.pid;
  unref(): void {}
  once(): this {
    return this;
  }
}

function harness(options: { config?: Partial<EvolutionConfig>; selftestFailed?: () => boolean; reviewModel?: () => string } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skill-evolve-sup-"));
  const events: TelemetryEvent[] = [];
  const supervisorCalls: { args: string[]; options: Record<string, unknown> }[] = [];
  const writer: TelemetryWriter = {
    append: (event: TelemetryInput) => {
      events.push({ ...event, ts: NOW, iso: "" } as TelemetryEvent);
    },
    appendSync: (event: TelemetryInput) => {
      events.push({ ...event, ts: NOW, iso: "" } as TelemetryEvent);
    },
    flush: async () => undefined,
  };
  const spawnFn: SpawnLike = () => new FakeChild() as unknown as SpawnedChild;
  const dispatcher = createDispatcher({
    evolutionDir: path.join(dir, ".pi", "evolution"),
    cwd: dir,
    // 生产默认全关（clone 即静默）：夹具必须显式打开，否则派发用例会被「未启用」跳过
    config: { ...DEFAULT_CONFIG, enabled: true, telemetry: true, ...options.config },
    telemetry: writer,
    queue: directQueue,
    promptTemplatePath: TEMPLATE,
    log: () => {},
    now: () => NOW,
    env: {},
    spawnFn,
    // 假子进程 pid = 本进程 pid：单飞闸靠注入的 alive 模拟「子进程已退出」，否则督导那一跳被自己的复盘挡住
    alive: () => false,
    ...(options.reviewModel ? { reviewModel: options.reviewModel } : {}),
    ...(options.selftestFailed ? { selftestFailed: options.selftestFailed } : {}),
    supervisorSpawnFn: fakeSupervisorSpawn(supervisorCalls),
  });
  return { dir, events, supervisorCalls, dispatch: dispatcher.dispatch };
}

test("派发成功时同一轮就起评审督导，并把评审模型透传过去", async () => {
  const h = harness({ reviewModel: () => "deepseek/deepseek-v3.2" });
  const outcome = await h.dispatch({ sessionId: "sess-1", skills: ["alpha"] });
  assert.equal(outcome.status, "dispatched");
  assert.equal(h.supervisorCalls.length, 1, "必须起且只起一个督导");
  const args = h.supervisorCalls[0].args;
  assert.ok(args[args.length - 2].endsWith("run-1") || args[2].includes("runs"), `args=${args.join(" ")}`);
  assert.equal(args[args.length - 1], "deepseek/deepseek-v3.2");
});

test("总开关关闭：既不复盘也不起督导", async () => {
  const h = harness({ config: { enabled: false } });
  const outcome = await h.dispatch({ sessionId: "sess-1", skills: ["alpha"] });
  assert.equal(outcome.status, "skipped");
  assert.equal(h.supervisorCalls.length, 0);
});

test("必红自检没过：跳过派发并记 skipped/selftest-failed", async () => {
  const h = harness({ selftestFailed: () => true });
  const outcome = await h.dispatch({ sessionId: "sess-1", skills: ["alpha"] });
  assert.equal(outcome.status, "skipped");
  assert.equal(outcome.status === "skipped" ? outcome.why : "", "selftest-failed");
  assert.equal(h.supervisorCalls.length, 0, "自检没过时不得起督导");
  const skipped = h.events.find((event) => event.kind === "skipped");
  assert.equal((skipped as unknown as { why?: string }).why, "selftest-failed");
});
