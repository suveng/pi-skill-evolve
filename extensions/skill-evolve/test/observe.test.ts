/**
 * M6 可观测胶水：面板刷新把状态变迁转成条目、派发立刻记一条、周报顺带落指标。
 * 不 import pi 包，也不需要真子进程（周报在没有候选技能时不会去跑 rg）。
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { createObserver } from "../lib/evolution-observe.ts";
import { metricsFile, readMetrics } from "../lib/metrics.ts";
import { directQueue } from "../lib/telemetry.ts";

const NOW = Date.UTC(2026, 10, 8, 12);

function tmpWorkspace(): { cwd: string; evolutionDir: string; telemetryDir: string } {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "skill-evolve-observe-"));
  const evolutionDir = path.join(cwd, ".pi", "evolution");
  fs.mkdirSync(path.join(cwd, ".pi", "skills", "demo"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".pi", "skills", "demo", "SKILL.md"), "---\nname: demo\ndescription: 演示\n---\n", "utf8");
  return { cwd, evolutionDir, telemetryDir: path.join(evolutionDir, "telemetry") };
}

function writeRun(evolutionDir: string, runId: string, status: string): void {
  const runDir = path.join(evolutionDir, "runs", runId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, "run.json"), JSON.stringify({ runId, status, dispatchedAt: NOW, sessionId: "s" }), "utf8");
}

test("refresh：状态变迁发条目并推面板状态", () => {
  const { evolutionDir, cwd, telemetryDir } = tmpWorkspace();
  writeRun(evolutionDir, "r1", "reviewed");
  writeRun(evolutionDir, "r2", "dispatched");
  const entries: string[] = [];
  const states: number[] = [];
  const observer = createObserver({
    cwd,
    evolutionDir,
    telemetryDir,
    queue: directQueue,
    now: () => NOW,
    panel: {
      onEntry: (entry) => entries.push(`${entry.kind}:${entry.runId}`),
      onState: (state) => states.push(state.reviewing),
    },
  });
  observer.refresh();
  assert.deepEqual(entries, ["reviewed:r1"], "只有出了结论的 run 发条目");
  assert.deepEqual(states, [1], "dispatched 的 run 算进行中");
  observer.refresh();
  assert.deepEqual(entries, ["reviewed:r1"], "重复刷新不重复发");
});

test("noteDispatched：派发立刻记一条，下一轮 refresh 不会重复记同一状态", () => {
  const { evolutionDir, cwd, telemetryDir } = tmpWorkspace();
  writeRun(evolutionDir, "r9", "dispatched");
  const entries: string[] = [];
  const observer = createObserver({
    cwd,
    evolutionDir,
    telemetryDir,
    queue: directQueue,
    now: () => NOW,
    panel: { onEntry: (entry) => entries.push(`${entry.kind}:${entry.runId}`) },
  });
  observer.noteDispatched("r9");
  assert.deepEqual(entries, ["dispatched:r9"]);
  observer.refresh();
  assert.deepEqual(entries, ["dispatched:r9"]);
});

test("weekReportText：出周报并把当周指标落一行（重复调用不重复写）", async () => {
  const { evolutionDir, cwd, telemetryDir } = tmpWorkspace();
  fs.mkdirSync(telemetryDir, { recursive: true });
  const line = {
    ts: NOW,
    iso: new Date(NOW).toISOString(),
    kind: "advertised",
    sessionId: "s",
    skills: [{ name: "demo", filePath: "/x/demo/SKILL.md", disabled: false, source: "project" }],
  };
  fs.writeFileSync(path.join(telemetryDir, "2026-11-08.jsonl"), `${JSON.stringify(line)}\n`, "utf8");
  const observer = createObserver({ cwd, evolutionDir, telemetryDir, queue: directQueue, now: () => NOW });
  const first = await observer.weekReportText();
  assert.match(first, /加载率 0\.0%（加载 0 \/ 曝光 1）/);
  const rows = readMetrics(evolutionDir);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.advertised, 1);
  await observer.weekReportText();
  assert.equal(readMetrics(evolutionDir).length, 1, "同周同 runId 不重复写");
  assert.equal(fs.existsSync(metricsFile(evolutionDir)), true);
});

test("weekReportText：没有任何遥测也不抛，报告写样本不足", async () => {
  const { evolutionDir, cwd, telemetryDir } = tmpWorkspace();
  const observer = createObserver({ cwd, evolutionDir, telemetryDir, queue: directQueue, now: () => NOW });
  const text = await observer.weekReportText();
  assert.match(text, /技能进化周报：2026-W45/);
  assert.match(text, /候选表只是提醒，不是判决/);
});
