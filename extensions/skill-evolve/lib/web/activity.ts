/**
 * 顶部控制条要的两个事实：总开关现在是什么状态、最后一次动作发生在什么时候。
 *
 * 「最后活动」取两个来源的较大值：`runs/<runId>/run.json` 的 dispatchedAt（复盘派发）与遥测最新事件的 ts（采集）。
 * 一个记录都没有就返回 null，让页面写「还没有任何记录」—— 绝不能拿 now 顶替，
 * 否则一台刚装好、什么都没跑过的机器会显示「刚刚有活动」。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { loadConfig } from "../config.ts";
import { listRuns } from "../runs.ts";
import { readLogTail } from "../stale.ts";

export interface WebControls {
  /** 采集遥测开关（config.telemetry，与 `/skill-evolve collect` 同一个字段）：只写本地 jsonl，不花 token */
  telemetry: boolean;
  /** 自动复盘开关（config.enabled，与 `/skill-evolve review` 同一个字段）：派生子进程，花 token */
  enabled: boolean;
  lastActivityAt: number | null;
}

/** 只需要「最新那一条」，但 dispatchedAt 为 null 的 run 会占名额，多取一些兜住 */
const RUN_SCAN_LIMIT = 50;
/** 一天一个分片，最后一条就是最新的；50 行足够跳过坏行与残行 */
const TELEMETRY_TAIL_LINES = 50;

function latestTelemetryTs(telemetryDir: string): number | null {
  let names: string[];
  try {
    names = fs.readdirSync(telemetryDir).filter((name) => name.endsWith(".jsonl"));
  } catch {
    return null; // 没开过采集 = 没有分片目录，不是错误
  }
  // 分片名是 YYYY-MM-DD.jsonl：字典序倒排即时间倒排，第一个读得出 ts 的分片就是最新的
  for (const name of names.sort().reverse()) {
    const lines = readLogTail(path.join(telemetryDir, name), TELEMETRY_TAIL_LINES);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try {
        const ts = (JSON.parse(lines[index]!) as { ts?: unknown }).ts;
        if (typeof ts === "number" && Number.isFinite(ts)) return ts;
      } catch {
        // 坏行（写入中途被杀）继续往前找，不能因为最后一行坏了就说「没有活动」
      }
    }
  }
  return null;
}

export function collectControls(evolutionDir: string): WebControls {
  let latest = latestTelemetryTs(path.join(evolutionDir, "telemetry"));
  for (const run of listRuns(evolutionDir, RUN_SCAN_LIMIT)) {
    if (run.dispatchedAt === null) continue;
    if (latest === null || run.dispatchedAt > latest) latest = run.dispatchedAt;
  }
  const config = loadConfig(evolutionDir);
  return { telemetry: config.telemetry, enabled: config.enabled, lastActivityAt: latest };
}
