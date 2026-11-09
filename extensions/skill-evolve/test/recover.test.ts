/**
 * 重启恢复单测：这里的每一条断言都对应一次「用户看到已分析却永远没提案」的真实死法。
 * 纪律是保守：能推状态就推，能重挂督导就重挂，**绝不重跑复盘**。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { recoverRuns, renderRecovery, RECOVER_WINDOW_MS } from "../lib/recover.ts";
import type { SpawnSupervisorOptions } from "../lib/review-spawn.ts";

const NOW = 1_800_000_000_000;
const queue = (file: string, run: () => Promise<void>): Promise<void> => run();

function setup(): { evolutionDir: string; write: (runId: string, record: Record<string, unknown>, files?: string[]) => string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "skill-evolve-recover-"));
  const evolutionDir = path.join(root, ".pi", "evolution");
  fs.mkdirSync(path.join(evolutionDir, "runs"), { recursive: true });
  const write = (runId: string, record: Record<string, unknown>, files: string[] = []): string => {
    const runDir = path.join(evolutionDir, "runs", runId);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(
      path.join(runDir, "run.json"),
      JSON.stringify({ runId, status: "dispatched", dispatchedAt: NOW - 60_000, pid: null, supervisorPid: null, ...record }, null, 2),
    );
    for (const name of files) fs.writeFileSync(path.join(runDir, name), "{}");
    return runDir;
  };
  return { evolutionDir, write };
}

function base(deps: Partial<Parameters<typeof recoverRuns>[0]> & { evolutionDir: string }) {
  return {
    cwd: "/repo",
    queue,
    now: () => NOW,
    alive: () => false,
    autoReview: () => true,
    reviewModel: () => "inherit",
    log: () => {},
    ...deps,
  } as Parameters<typeof recoverRuns>[0];
}

test("分析产物在但状态还写 dispatched：补成 analyzed，不重跑", async () => {
  const { evolutionDir, write } = setup();
  const runDir = write("r-1", { pid: 4242 }, ["01-findings.json"]);
  const actions = await recoverRuns(base({ evolutionDir, alive: () => false }));
  assert.deepEqual(actions.map((a) => a.kind), ["advanced-analyzed", "interrupted"]);
  const record = JSON.parse(fs.readFileSync(path.join(runDir, "run.json"), "utf8")) as { status: string };
  assert.equal(record.status, "analyzed");
});

test("提案在、督导已死：重挂一个督导接着评审", async () => {
  const { evolutionDir, write } = setup();
  const runDir = write("r-2", { status: "analyzed", pid: null, supervisorPid: 777 }, ["01-findings.json", "02-proposal.json"]);
  const seen: SpawnSupervisorOptions[] = [];
  const actions = await recoverRuns(
    base({
      evolutionDir,
      alive: (pid) => pid !== 777, // 只有督导死了
      spawnSupervisor: (options) => {
        seen.push(options);
        return 9999;
      },
    }),
  );
  assert.deepEqual(actions.map((a) => a.kind), ["supervisor-respawned"]);
  assert.equal(actions[0]!.detail.includes("9999"), true);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.runDir, runDir);
  assert.equal(seen[0]!.autoReview, true, "重挂时明确开着评审");
  assert.equal(seen[0]!.reviewModel, "inherit");
});

test("督导还活着：不重挂、不打扰", async () => {
  const { evolutionDir, write } = setup();
  write("r-3", { status: "analyzed", supervisorPid: 888 }, ["01-findings.json", "02-proposal.json"]);
  let spawned = 0;
  const actions = await recoverRuns(
    base({
      evolutionDir,
      alive: (pid) => pid === 888,
      spawnSupervisor: () => {
        spawned += 1;
        return 1;
      },
    }),
  );
  assert.deepEqual(actions.map((a) => a.kind), ["waiting-review"]);
  assert.equal(spawned, 0);
});

test("自动评审关着：不偷偷打开，只报告待人工", async () => {
  const { evolutionDir, write } = setup();
  write("r-4", { status: "analyzed", supervisorPid: 1 }, ["02-proposal.json"]);
  let spawned = 0;
  const actions = await recoverRuns(
    base({
      evolutionDir,
      autoReview: () => false,
      spawnSupervisor: () => {
        spawned += 1;
        return 1;
      },
    }),
  );
  assert.deepEqual(actions.map((a) => a.kind), ["respawn-blocked"]);
  assert.equal(spawned, 0);
});

test("复盘子进程还活着且没提案：等它，不插一脚", async () => {
  const { evolutionDir, write } = setup();
  write("r-5", { pid: 555 }, []);
  const actions = await recoverRuns(base({ evolutionDir, alive: (pid) => pid === 555 }));
  assert.deepEqual(actions.map((a) => a.kind), ["waiting-proposal"]);
});

test("已有 03-review.json：什么都不做，交给入队/自动采纳", async () => {
  const { evolutionDir, write } = setup();
  write("r-6", { status: "proposed" }, ["01-findings.json", "02-proposal.json", "03-review.json"]);
  const actions = await recoverRuns(base({ evolutionDir }));
  assert.deepEqual(actions.map((a) => a.kind), ["review-done"]);
});

test("终态与超窗 run 一律不碰", async () => {
  const { evolutionDir, write } = setup();
  write("r-applied", { status: "applied", pid: null }, ["01-findings.json", "02-proposal.json", "03-review.json"]);
  write("r-old", { status: "analyzed", dispatchedAt: NOW - RECOVER_WINDOW_MS - 1 }, ["02-proposal.json"]);
  write("r-stale", { status: "stale", pid: null }, ["01-findings.json"]);
  const actions = await recoverRuns(base({ evolutionDir }));
  assert.deepEqual(actions, []);
  assert.equal(renderRecovery([]), "重启恢复：没有需要接手的 run");
});

test("坏 run.json 当没有，不崩", async () => {
  const { evolutionDir } = setup();
  const broken = path.join(evolutionDir, "runs", "r-broken");
  fs.mkdirSync(broken, { recursive: true });
  fs.writeFileSync(path.join(broken, "run.json"), "{not json");
  assert.deepEqual(await recoverRuns(base({ evolutionDir })), []);
});

test("面板文案带 kinds 与明细", () => {
  const text = renderRecovery([
    { runId: "r-1", kind: "supervisor-respawned", detail: "重挂 pid 9" },
    { runId: "r-2", kind: "interrupted", detail: "没提案" },
  ]);
  assert.match(text, /重启恢复：2 条 run 被检查/);
  assert.match(text, /r-1 {2}重挂督导 — 重挂 pid 9/);
  assert.match(text, /r-2 {2}已中断 — 没提案/);
});

test("一个工作区两个 pi 同时启动恢复：督导只起一个（另一个看到锁里已经挂上了）", async () => {
  const { evolutionDir, write } = setup();
  write("r-9", { status: "analyzed", pid: null, supervisorPid: null }, ["01-findings.json", "02-proposal.json"]);
  let spawns = 0;
  const spawnSupervisor = (options: SpawnSupervisorOptions): number => {
    spawns += 1;
    // 模拟真实现：spawn 之后立刻把 supervisorPid 写回 run.json（这就是后到者的判断依据）
    const file = path.join(options.runDir, "run.json");
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    fs.writeFileSync(file, JSON.stringify({ ...raw, supervisorPid: process.pid }, null, 2));
    return process.pid;
  };
  // 督导 pid 就是本进程 pid：重挂后它「活着」，这正是后到者的判断依据
  const deps = base({ evolutionDir, spawnSupervisor, alive: (pid) => pid === process.pid });
  const both = await Promise.all([recoverRuns(deps), recoverRuns(deps)]);
  assert.equal(spawns, 1, "两个实例各起一个督导 = 双花 token + 双写 03-review");
  const kinds = both.flat().map((action) => action.kind);
  assert.ok(
    kinds.includes("supervisor-respawned") || kinds.includes("respawn-blocked"),
    `应当有人挂上、有人让位（实际 ${kinds.join(",")}）`,
  );
  assert.ok(!kinds.includes("interrupted"), "提案在、督导被重挂，不该判成中断");
});
