/**
 * 卡死判定与「失败可见」单测（设计稿 14 章的可观测补丁）。
 *
 * 铁律：全程**不真起 pi / node 子进程**。spawn 一律传假 spawnFn，
 * 只断言它收到的 stdio / 目录，进程由测试自己用 fs 模拟写日志。
 * 依据：2026-11-08 漏注入 spawnFn，一次跑出 51 个孤儿复盘子进程。
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../lib/config.ts";
import { collectPanelState, panelWidget, statusEntries, statusLine } from "../lib/panel.ts";
import { renderStatus } from "../lib/report.ts";
import { SUPERVISOR_LOG, spawnReviewSupervisor } from "../lib/review-spawn.ts";
import { CHILD_LOG, spawnDetached } from "../lib/spawn-plan.ts";
import { classifyStale, listStaleRuns, readRunError, scanStaleRuns, STALE_MS } from "../lib/stale.ts";

const NOW = Date.UTC(2026, 10, 8, 12);
const MINUTE = 60_000;

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "skill-evolve-stale-"));
}

/** 写一条 run.json；raw 里给了什么就写什么（pid 缺省不写 = dispatch 半路被打断的形态） */
function writeRun(dir: string, runId: string, raw: Record<string, unknown>): string {
  const runDir = path.join(dir, "runs", runId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, "run.json"), `${JSON.stringify({ runId, sessionId: "s", ...raw }, null, 2)}\n`, "utf8");
  return runDir;
}

function readRun(runDir: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(runDir, "run.json"), "utf8")) as Record<string, unknown>;
}

const deadPid = (): boolean => false;
const alivePid = (): boolean => true;

test("classifyStale：刚派发 10 秒内即使 pid 不在也不算卡死", () => {
  const verdict = classifyStale({ status: "dispatched", pid: 291916, dispatchedAt: NOW - 10_000 }, NOW, { alive: deadPid });
  assert.deepEqual(verdict, { stale: false });
});

test("classifyStale：子进程已死且超过 5 分钟 → child-exited", () => {
  assert.deepEqual(
    classifyStale({ status: "dispatched", pid: 291916, dispatchedAt: NOW - STALE_MS - 1000 }, NOW, { alive: deadPid }),
    { stale: true, reason: "child-exited" },
  );
  assert.deepEqual(classifyStale({ status: "proposed", pid: 1, dispatchedAt: NOW - STALE_MS }, NOW, { alive: deadPid }), {
    stale: false,
  }, "正好 5 分钟不算「超过」");
  assert.deepEqual(
    classifyStale({ status: "analyzed", dispatchedAt: NOW - STALE_MS - 1 }, NOW, { alive: deadPid }),
    { stale: false },
    "analyzed 说明结论已经写盘：子进程退出是正常的，不能报成卡死",
  );
});

test("classifyStale：pid 还活着但超单 run 上限 → timeout", () => {
  assert.deepEqual(
    classifyStale({ status: "dispatched", pid: 11367, dispatchedAt: NOW - DEFAULT_CONFIG.maxRuntimeMs - 1 }, NOW, { alive: alivePid }),
    { stale: true, reason: "timeout" },
  );
  assert.deepEqual(
    classifyStale({ status: "dispatched", pid: 11367, dispatchedAt: NOW - 1000 }, NOW, { alive: alivePid }),
    { stale: false },
    "活着且没超时不能误报",
  );
});

test("classifyStale：已出结论的状态与缺 dispatchedAt 的历史记录都不判", () => {
  for (const status of ["reviewed", "applied", "rolled-back", "stale", "abandoned"]) {
    assert.deepEqual(classifyStale({ status, pid: 1, dispatchedAt: NOW - 10 * 60 * MINUTE }, NOW, { alive: deadPid }), { stale: false });
  }
  assert.deepEqual(classifyStale({ status: "dispatched", pid: 1 }, NOW, { alive: deadPid }), { stale: false });
});

test("spawnDetached：stdout+stderr 指向 logFile，子进程写入能落到文件", () => {
  const dir = tmpDir();
  const logFile = path.join(dir, "runs", "run-1", CHILD_LOG);
  let seen: Record<string, unknown> = {};
  const child = spawnDetached(
    (command, args, options) => {
      seen = { command, args, options };
      const stdio = options.stdio as [string, number, number];
      // 父进程的 fd 此刻还开着：用 fs 模拟子进程写日志（不真起进程）
      fs.writeSync(stdio[1], "子进程崩了\n");
      return { pid: 4242, unref: () => {} };
    },
    "/bin/pi",
    ["-p", "--no-session", "-ns", "prompt"],
    { cwd: dir, env: {}, logFile },
  );
  assert.equal(child.pid, 4242);
  const stdio = seen.options.stdio as [string, number, number];
  assert.deepEqual([stdio[0], stdio[1] === stdio[2], typeof stdio[1]], ["ignore", true, "number"]);
  assert.equal(seen.options.detached, true);
  assert.equal(fs.readFileSync(logFile, "utf8"), "子进程崩了\n");
});

test("spawnDetached：日志文件开不出来时退回 stdio:\"ignore\"，不阻断派发", () => {
  let stdio: unknown = null;
  const child = spawnDetached(
    (_command, _args, options) => {
      stdio = options.stdio;
      return { pid: 1, unref: () => {} };
    },
    "/bin/pi",
    [],
    { cwd: "/", env: {}, logFile: "/r/不许写的目录/child.log" },
  );
  assert.equal(child.pid, 1);
  assert.equal(stdio, "ignore");
});

test("督导进程同样落盘：supervisor.log 就在 run 目录里", () => {
  const dir = tmpDir();
  const runDir = path.join(dir, "runs", "run-1");
  fs.mkdirSync(runDir, { recursive: true });
  let stdio: unknown = null;
  spawnReviewSupervisor({
    runDir,
    cwd: dir,
    env: {},
    autoReview: true,
    spawnFn: (_command, _args, options) => {
      stdio = options.stdio;
      return { pid: 7777, unref: () => {} };
    },
  });
  assert.equal(Array.isArray(stdio), true, "写法必须是 fd 数组");
  assert.equal(fs.existsSync(path.join(runDir, SUPERVISOR_LOG)), true);
});

test("scanStaleRuns：子进程已死 → run.json 转 stale + run-error.json 带日志尾部 20 行", () => {
  const dir = tmpDir();
  const runDir = writeRun(dir, "354df7db-1794130855", { status: "dispatched", pid: 291916, dispatchedAt: NOW - 10 * MINUTE });
  const lines = Array.from({ length: 25 }, (_value, index) => `日志第 ${index + 1} 行`);
  fs.writeFileSync(path.join(runDir, CHILD_LOG), `${lines.join("\n")}\n`, "utf8");

  const found = scanStaleRuns(dir, NOW, { alive: deadPid });
  assert.equal(found.length, 1);
  assert.deepEqual([found[0]!.runId, found[0]!.reason], ["354df7db-1794130855", "child-exited"]);
  assert.equal(found[0]!.lastLine, "日志第 25 行");
  assert.equal(readRun(runDir).status, "stale");

  const error = readRunError(runDir);
  assert.equal(error?.reason, "child-exited");
  assert.equal(error?.at, NOW);
  assert.equal(error?.childLogTail.length, 20, "只留最后 20 行");
  assert.equal(error?.childLogTail[0], "日志第 6 行");
  assert.equal(error?.childLogTail[19], "日志第 25 行");
});

test("scanStaleRuns：超时的 run 先 kill 再标 stale，重复扫描不重复写（幂等）", () => {
  const dir = tmpDir();
  const runDir = writeRun(dir, "run-timeout", { status: "dispatched", pid: 4321, dispatchedAt: NOW - 30 * MINUTE });
  const killed: number[] = [];
  const found = scanStaleRuns(dir, NOW, { alive: alivePid, kill: (pid) => killed.push(pid), maxRuntimeMs: 20 * MINUTE });
  assert.deepEqual(killed, [4321]);
  assert.equal(found[0]!.reason, "timeout");
  assert.equal(readRun(runDir).status, "stale");
  const before = fs.readFileSync(path.join(runDir, "run-error.json"), "utf8");
  assert.deepEqual(scanStaleRuns(dir, NOW + MINUTE, { alive: alivePid, kill: (pid) => killed.push(pid) }), []);
  assert.deepEqual(killed, [4321], "已标 stale 的不再 kill 第二次");
  assert.equal(fs.readFileSync(path.join(runDir, "run-error.json"), "utf8"), before);
});

test("scanStaleRuns：活着且没超时的 run 一动不动；run.json 坏掉的目录直接跳过", () => {
  const dir = tmpDir();
  const runDir = writeRun(dir, "run-alive", { status: "dispatched", pid: 1, dispatchedAt: NOW - MINUTE });
  const broken = path.join(dir, "runs", "broken");
  fs.mkdirSync(broken, { recursive: true });
  fs.writeFileSync(path.join(broken, "run.json"), "{ 不是 json", "utf8");
  assert.deepEqual(scanStaleRuns(dir, NOW, { alive: alivePid }), []);
  assert.equal(readRun(runDir).status, "dispatched");
  assert.equal(fs.existsSync(path.join(runDir, "run-error.json")), false);
});

test("collectPanelState：reviewing 只数活着的 run，staleCount 覆盖「已落盘 + 判定命中」", () => {
  const dir = tmpDir();
  writeRun(dir, "r-dead", { status: "dispatched", pid: 291916, dispatchedAt: NOW - 10 * MINUTE });
  writeRun(dir, "r-alive", { status: "dispatched", pid: 1, dispatchedAt: NOW - MINUTE });
  writeRun(dir, "r-young", { status: "dispatched", pid: 291917, dispatchedAt: NOW - MINUTE });
  writeRun(dir, "r-stale", { status: "stale", pid: 2, dispatchedAt: NOW - 20 * MINUTE });
  const state = collectPanelState({ evolutionDir: dir, now: NOW, alive: (pid) => pid === 1, maxRuntimeMs: 20 * MINUTE });
  assert.equal(state.reviewing, 2, "r-dead 超期且 pid 不在不再算「复盘」；r-alive 与宽限期内的 r-young 仍算");
  assert.equal(state.staleCount, 2, "r-stale 已落盘 + r-dead 判定命中：两处口径必须一致，否则网页会出现「卡死 1、列表 2 条」");

  // 5 分钟宽限内即使 pid 不在也还当在跑：与扫描共用同一口径，免得面板在子进程刚退出时闪一下
  const youngDead = collectPanelState({ evolutionDir: dir, now: NOW, alive: deadPid, maxRuntimeMs: 20 * MINUTE });
  assert.equal(youngDead.reviewing, 2, "宽限期内的 r-young 仍算在跑");
  assert.equal(youngDead.staleCount, 2, "宽限期内的死 pid 不算卡死，只有已落盘的 r-stale 与超期的 r-dead");
});

test("collectPanelState：analyzed 的 run 进程死掉不算「复盘」，督导活着才算", () => {
  const dir = tmpDir();
  writeRun(dir, "a-dead", { status: "analyzed", pid: 3001, dispatchedAt: NOW - 2 * MINUTE });
  writeRun(dir, "a-live", { status: "analyzed", pid: 1, dispatchedAt: NOW - 2 * MINUTE });
  writeRun(dir, "a-sup", { status: "analyzed", pid: 3002, supervisorPid: 1, dispatchedAt: NOW - 3 * MINUTE });
  const state = collectPanelState({ evolutionDir: dir, now: NOW, alive: (pid) => pid === 1 });
  assert.equal(state.reviewing, 2, "a-dead 结论已出且进程不在：不再算「复盘」；a-live 与有活督导的 a-sup 算");
});

test("panelWidget / statusLine：卡死压过待批，且不显示「复盘 0」", () => {
  const stale = { reviewing: 0, staleCount: 1, pendingApprovals: 2, lastAppliedAt: null, rollbackRate: 0, appliedSamples: 0 };
  assert.deepEqual(panelWidget(stale), ["复盘失败 1 / 待批 2"]);
  assert.equal(statusLine(stale), "复盘失败 1");
  assert.deepEqual(panelWidget({ ...stale, staleCount: 0, pendingApprovals: 0 }), null, "全零仍然返回 null");
});

test("statusEntries：stale 也会发一条 /tree 条目", () => {
  const entry = statusEntries([{ runId: "354df7db-1794130855", status: "stale" }], new Map(), NOW)[0];
  assert.deepEqual([entry?.kind, entry?.runId], ["stale", "354df7db-1794130855"]);
});

test("renderStatus：卡死单列一行，带原因与日志最后一行", () => {
  const text = renderStatus({
    config: DEFAULT_CONFIG,
    configPath: "/repo/.pi/evolution/config.json",
    telemetryDir: "/repo/.pi/evolution/telemetry",
    lockPid: undefined,
    runs: [],
    staleRuns: [{ runId: "354df7db-1794130855", runDir: "/repo/runs/x", reason: "child-exited", lastLine: "Error: 子进程崩了", at: NOW }],
  });
  assert.equal(text.includes("  卡死 1 条：354df7db（child-exited，日志最后一行：Error: 子进程崩了）"), true);
  const noLog = renderStatus({
    config: DEFAULT_CONFIG,
    configPath: "/c.json",
    telemetryDir: "/t",
    lockPid: undefined,
    runs: [],
    staleRuns: [{ runId: "abc-1", runDir: "/repo/runs/y", reason: "timeout", lastLine: null, at: NOW }],
  });
  assert.equal(noLog.includes("卡死 1 条：abc（timeout，日志最后一行：无日志（child.log 不存在或为空））"), true);
});

test("renderStatus：同一会话的多条卡死 run 用完整 runId，不写成两行一样的", () => {
  const text = renderStatus({
    config: DEFAULT_CONFIG,
    configPath: "/c.json",
    telemetryDir: "/t",
    lockPid: undefined,
    runs: [],
    staleRuns: [
      { runId: "354df7db-1794130855", runDir: "/r/a", reason: "child-exited", lastLine: null, at: NOW },
      { runId: "354df7db-1794131353", runDir: "/r/b", reason: "child-exited", lastLine: null, at: NOW },
    ],
  });
  assert.equal(text.includes("卡死 2 条：354df7db-1794130855（"), true);
  assert.equal(text.includes("354df7db-1794131353（"), true);
});

test("listStaleRuns：只列已判 stale 的，按派发时间倒序并带上日志最后一行", () => {
  const dir = tmpDir();
  const older = writeRun(dir, "old-1", { status: "stale", pid: 1, dispatchedAt: NOW - 60 * MINUTE });
  writeRun(dir, "new-2", { status: "stale", pid: 2, dispatchedAt: NOW - 10 * MINUTE });
  writeRun(dir, "live-3", { status: "dispatched", pid: 3, dispatchedAt: NOW - MINUTE });
  // run-error.json 是 stale 条目的唯一权威来源：lastLine 取它里面的 childLogTail 尾部
  fs.writeFileSync(
    path.join(older, "run-error.json"),
    JSON.stringify({ reason: "timeout", at: NOW, childLogTail: ["前一行", "最后一行"] }),
    "utf8",
  );
  scanStaleRuns(dir, NOW, { alive: deadPid });
  const runs = listStaleRuns(dir, 5);
  assert.deepEqual(runs.map((run) => run.runId), ["new-2", "old-1"]);
  assert.equal(runs[0]!.lastLine, null, "没有 run-error / 日志就是 null，不编内容");
  assert.deepEqual([runs[1]!.lastLine, runs[1]!.reason], ["最后一行", "timeout"]);
});
