/**
 * 机械层的接线单测：settle 之后遥测里必须真的出现 attributed / conflict，
 * 且派生 prompt 里带着「已机械归因」清单（复盘 agent 据此只做 F/G）。
 *
 * 运行：
 *   cd .pi/extensions/skill-evolve
 *   node --experimental-strip-types --test test/mechanical-wiring.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { fakeSupervisorSpawn } from "./fake-review-spawn.ts";
import { createEvolution } from "../lib/evolution.ts";
import { directQueue, type TelemetryEvent, type TelemetrySkill } from "../lib/telemetry.ts";
import type { SpawnedChild, SpawnLike } from "../lib/spawn-plan.ts";

const TEMPLATE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "prompts", "复盘.md");
const NOW = 1_760_000_000_000;

const RULES = {
  version: 1,
  rules: [
    { id: "rg-over-find", level: "P0", pattern: "\\bgrep\\s+-[a-zA-Z]*r", expect: "用 rg", why: "实测 find 全盘 180s" },
  ],
};

function skill(name: string, disabled = false): TelemetrySkill {
  return { name, filePath: `/repo/.pi/skills/${name}/SKILL.md`, disabled, source: "project" };
}

/** 生产默认全关（clone 即静默）：这三个用例要验证采集，必须在夹具里显式打开 */
function enableEvolution(dir: string): void {
  fs.mkdirSync(path.join(dir, ".pi", "evolution"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, ".pi", "evolution", "config.json"),
    `${JSON.stringify({ enabled: true, telemetry: true }, null, 2)}\n`,
    "utf8",
  );
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
      if (line.trim().length > 0) events.push(JSON.parse(line));
    }
  }
  return events;
}

class FakeChild {
  readonly pid = process.pid;
  unref(): void {}
  once(): this {
    return this;
  }
}

test("settle 写 attributed + conflict，prompt 带上机械归因清单", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skill-evolve-wire-"));
  enableEvolution(dir);
  // 磁盘上真的放一个会命中硬禁令的技能，让 conflict 走真实扫描而不是桩
  fs.mkdirSync(path.join(dir, ".pi/skills/alpha"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".pi/skills/alpha/SKILL.md"), "# alpha\n用 grep -r 搜全仓\n", "utf8");
  fs.mkdirSync(path.join(dir, ".pi/evolution/rules"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".pi/evolution/rules/hard-rules.json"), JSON.stringify(RULES), "utf8");

  const prompts: string[] = [];
  // 技能 filePath 必须指向这个临时 cwd，否则 B 类的路径比较对不上（这正是它该做的事）
  const at = (name: string): TelemetrySkill => ({
    name,
    filePath: path.join(dir, ".pi/skills", name, "SKILL.md"),
    disabled: false,
    source: "project",
  });
  const spawnFn: SpawnLike = (_bin, args) => {
    prompts.push(args[args.length - 1]);
    return new FakeChild() as unknown as SpawnedChild;
  };
  const evo = createEvolution({
    cwd: dir,
    promptTemplatePath: TEMPLATE,
    queue: directQueue,
    log: () => {},
    now: () => NOW,
    env: {},
    spawnFn,
    supervisorSpawnFn: fakeSupervisorSpawn([]),
    // 注入发现结果：alpha 正常发现，beta 的 frontmatter 坏（诊断点名它）
    loadSkills: () => ({
      skills: [{ name: "alpha", filePath: path.join(dir, ".pi/skills/alpha/SKILL.md") }],
      diagnostics: [{ path: path.join(dir, ".pi/skills/beta/SKILL.md"), message: "缺少 description", type: "warning" }],
    }),
  });

  evo.recordAdvertised({
    sessionId: "s1",
    cwd: dir,
    prompt: "查一下技能",
    skills: [at("alpha"), at("beta")],
    activeTools: ["read", "bash"],
  });
  evo.settle({ sessionId: "s1" });
  await new Promise((resolve) => setTimeout(resolve, 200));

  const events = readTelemetry(dir);
  const advertised = events.find((item) => item.kind === "advertised");
  assert.deepEqual(advertised?.activeTools, ["read", "bash"], "activeTools 必须落进遥测，否则类 E 无据可依");

  // directQueue 是直写（生产用 withFileMutationQueue 串行），事件落盘顺序不保证，所以按技能名排序比对
  const attributed = events.filter((item) => item.kind === "attributed");
  assert.deepEqual(
    attributed.map((item) => [item.skill, item.category]).sort((a, b) => a[0].localeCompare(b[0])),
    [
      ["alpha", "semantic"],
      ["beta", "B"],
    ],
  );
  assert.ok(attributed.every((item) => typeof item.reason === "string" && item.reason.length > 0));

  const conflicts = events.filter((item) => item.kind === "conflict");
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].ruleId, "rg-over-find");
  assert.equal(conflicts[0].line, 2);
  assert.equal(conflicts[0].level, "P0");
  // 首次 settle 会自动 bootstrap 存量基线（把当时的命中当存量接受），所以这条标 stock
  assert.equal(conflicts[0].stock, true);

  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /已机械归因（2 条/);
  assert.match(prompts[0], /B beta/);
  assert.match(prompts[0], /只对上面没出现的技能做 F\/G 判定/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("同一冲突只记一次：两轮 settle 不重复刷同一条", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skill-evolve-wire2-"));
  enableEvolution(dir);
  fs.mkdirSync(path.join(dir, ".pi/skills/alpha"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".pi/skills/alpha/SKILL.md"), "# alpha\n用 grep -r 搜全仓\n", "utf8");
  fs.mkdirSync(path.join(dir, ".pi/evolution/rules"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".pi/evolution/rules/hard-rules.json"), JSON.stringify(RULES), "utf8");

  const evo = createEvolution({
    cwd: dir,
    promptTemplatePath: TEMPLATE,
    queue: directQueue,
    log: () => {},
    now: () => NOW,
    env: {},
    spawnFn: () => new FakeChild() as unknown as SpawnedChild,
    supervisorSpawnFn: fakeSupervisorSpawn([]),
    loadSkills: () => ({ skills: [{ name: "alpha", filePath: path.join(dir, ".pi/skills/alpha/SKILL.md") }], diagnostics: [] }),
  });

  for (let round = 0; round < 2; round += 1) {
    evo.recordAdvertised({ sessionId: "s1", cwd: dir, prompt: "再来一次", skills: [skill("alpha")], activeTools: ["read"] });
    evo.settle({ sessionId: "s1" });
  }
  await new Promise((resolve) => setTimeout(resolve, 200));

  const conflicts = readTelemetry(dir).filter((item) => item.kind === "conflict");
  assert.equal(conflicts.length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("conflict 事件带 stock：基线里没有的命中标成新增（stock=false）", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skill-evolve-wire3-"));
  enableEvolution(dir);
  fs.mkdirSync(path.join(dir, ".pi/skills/alpha"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".pi/skills/alpha/SKILL.md"), "# alpha\n用 grep -r 搜全仓\n", "utf8");
  fs.mkdirSync(path.join(dir, ".pi/evolution/rules"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".pi/evolution/rules/hard-rules.json"), JSON.stringify(RULES), "utf8");
  // 预置一份「只含别的存量」的基线：alpha 这条不在其中，应判新增
  fs.writeFileSync(
    path.join(dir, ".pi/evolution/baseline.json"),
    JSON.stringify({ version: 1, generatedAt: NOW, bootstrap: false, violations: [{ ruleId: "rg-over-find", level: "P0", skill: "other", line: 9, quote: "别的", fingerprint: "deadbeefdeadbeef" }] }),
    "utf8",
  );

  const evo = createEvolution({
    cwd: dir,
    promptTemplatePath: TEMPLATE,
    queue: directQueue,
    log: () => {},
    now: () => NOW,
    env: {},
    spawnFn: (() => new FakeChild() as unknown as SpawnedChild) as SpawnLike,
    supervisorSpawnFn: fakeSupervisorSpawn([]),
    loadSkills: () => ({ skills: [], diagnostics: [] }),
  });
  evo.recordAdvertised({
    sessionId: "s1",
    cwd: dir,
    prompt: "查一下技能",
    skills: [skill("alpha")],
    activeTools: ["read", "bash"],
  });
  evo.settle({ sessionId: "s1" });
  await new Promise((resolve) => setTimeout(resolve, 200));

  const conflicts = readTelemetry(dir).filter((item) => item.kind === "conflict");
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].stock, false);
  fs.rmSync(dir, { recursive: true, force: true });
});
