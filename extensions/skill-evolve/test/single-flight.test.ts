/**
 * 全局单飞闸（用户 2026-11-08：「每次最多一个复盘agent」）：
 * 扫 `runs/<runId>/run.json` 的 pid（复盘）与 supervisorPid（督导），alive 为真即占用。
 *
 * 用注入的 alive 模拟存活，不起真进程、不看真 pid。
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { findOccupant, guardBusy } from "../lib/single-flight.ts";
import type { TelemetryInput, TelemetryWriter } from "../lib/telemetry.ts";

const NOW = 1_760_000_000_000;

function workspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "skill-evolve-single-"));
}

function writeRun(evolutionDir: string, runId: string, record: Record<string, unknown>): void {
  const runDir = path.join(evolutionDir, "runs", runId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, "run.json"), JSON.stringify({ runId, ...record }), "utf8");
}

/** 只有列出来的 pid 算活着 */
function aliveOnly(...pids: number[]): (pid: number) => boolean {
  return (pid) => pids.includes(pid);
}

function writer(): { events: TelemetryInput[]; sync: TelemetryInput[]; telemetry: TelemetryWriter } {
  const events: TelemetryInput[] = [];
  const sync: TelemetryInput[] = [];
  return {
    events,
    sync,
    telemetry: {
      append: (event) => events.push(event),
      appendSync: (event) => sync.push(event),
      flush: async () => undefined,
    },
  };
}

test("findOccupant：没有 runs 目录 → null", () => {
  assert.equal(findOccupant(workspace()), null);
});

test("findOccupant：run.json 里没有 pid / supervisorPid → null", () => {
  const dir = workspace();
  writeRun(dir, "r1", { status: "dispatched", pid: null });
  assert.equal(findOccupant(dir, { alive: () => true }), null);
});

test("findOccupant：pid 已死 → null（死进程自然释放，不需要谁清场）", () => {
  const dir = workspace();
  writeRun(dir, "r1", { status: "dispatched", pid: 4242, dispatchedAt: NOW });
  assert.equal(findOccupant(dir, { alive: aliveOnly(9999) }), null);
});

test("findOccupant：复盘子进程活着 → kind=复盘", () => {
  const dir = workspace();
  writeRun(dir, "r1", { status: "dispatched", pid: 4242, dispatchedAt: NOW });
  assert.deepEqual(findOccupant(dir, { alive: aliveOnly(4242) }), { runId: "r1", pid: 4242, kind: "复盘" });
});

test("findOccupant：复盘 pid 死了但督导活着 → kind=督导", () => {
  const dir = workspace();
  writeRun(dir, "r1", { status: "analyzed", pid: 4242, supervisorPid: 5151, dispatchedAt: NOW });
  assert.deepEqual(findOccupant(dir, { alive: aliveOnly(5151) }), { runId: "r1", pid: 5151, kind: "督导" });
});

test("findOccupant：两条 run 都活着 → 返回最早派发的那条", () => {
  const dir = workspace();
  writeRun(dir, "new", { status: "dispatched", pid: 2, dispatchedAt: NOW + 1000 });
  writeRun(dir, "old", { status: "dispatched", pid: 1, dispatchedAt: NOW });
  assert.deepEqual(findOccupant(dir, { alive: aliveOnly(1, 2) }), { runId: "old", pid: 1, kind: "复盘" });
});

test("findOccupant：ignoreRunId 排除自己那条（督导与自己同属一条 run）", () => {
  const dir = workspace();
  writeRun(dir, "r1", { status: "dispatched", pid: 4242, dispatchedAt: NOW });
  assert.equal(findOccupant(dir, { alive: aliveOnly(4242), ignoreRunId: "r1" }), null);
});

test("guardBusy：占用时写 skipped(busy) 遥测并返回占用者", () => {
  const dir = workspace();
  writeRun(dir, "r1", { status: "dispatched", pid: 4242, dispatchedAt: NOW });
  const { events, sync, telemetry } = writer();
  const occupant = guardBusy({
    evolutionDir: dir,
    sessionId: "s1",
    telemetry,
    trigger: "auto",
    rounds: 2,
    alive: aliveOnly(4242),
  });
  assert.deepEqual(occupant, { runId: "r1", pid: 4242, kind: "复盘" });
  assert.deepEqual(events, [
    { kind: "skipped", sessionId: "s1", why: "busy", occupant: { runId: "r1", pid: 4242, kind: "复盘" }, trigger: "auto", rounds: 2 },
  ]);
  assert.deepEqual(sync, [], "非退出路径走异步 append");
});

test("guardBusy：退出补发路径用 appendSync 同步落盘", () => {
  const dir = workspace();
  writeRun(dir, "r1", { status: "dispatched", pid: 4242, dispatchedAt: NOW });
  const { events, sync, telemetry } = writer();
  guardBusy({ evolutionDir: dir, sessionId: "s1", telemetry, sync: true, trigger: "shutdown", alive: aliveOnly(4242) });
  assert.equal(events.length, 0);
  assert.equal(sync.length, 1);
  assert.equal(sync[0]!.why, "busy");
});

test("guardBusy：空闲时返回 null 且不写遥测", () => {
  const dir = workspace();
  writeRun(dir, "r1", { status: "dispatched", pid: 4242, dispatchedAt: NOW });
  const { events, telemetry } = writer();
  assert.equal(guardBusy({ evolutionDir: dir, sessionId: "s1", telemetry, alive: aliveOnly(9999) }), null);
  assert.deepEqual(events, []);
});
