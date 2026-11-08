/**
 * 全局单飞闸：任意时刻最多一个子进程（复盘或督导都算）。
 *
 * 用户 2026-11-08：「每次最多一个复盘agent」。这条约束**跨会话也成立** —— 两个 pi 会话同时结算时，
 * 只让先到的那条跑；后来者不 spawn，只写一条 `skipped(busy)` 遥测，等占用者跑完的下一轮再派。
 *
 * 占用证据是**活着的 pid**：`runs/<runId>/run.json` 的 `pid`（复盘子进程）与 `supervisorPid`（评审督导）。
 * pid 判死即自然释放，不需要谁去清场；督导退出时仍会把 `supervisorPid` 写成 `null`，
 * 免得一个被系统复用的 pid 造成假占用。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { isPidAlive } from "./lock.ts";
import type { TelemetryWriter } from "./telemetry.ts";

/** 占用者：谁在跑、pid 多少、是复盘还是督导 */
export interface Occupant {
  runId: string;
  pid: number;
  kind: "复盘" | "督导";
}

export interface OccupantDeps {
  /** pid 存活判定（默认 kill(pid,0)）；单测注入，测试里不许起真进程 */
  alive?: (pid: number) => boolean;
  /**
   * 排除自己：督导与它那条复盘是同一 run 的配对进程（复盘子进程先起、督导后起）。
   * 不排除的话督导永远看不到「空闲」，功能直接死掉。
   */
  ignoreRunId?: string;
}

interface Candidate {
  occupant: Occupant;
  dispatchedAt: number;
}

function readCandidates(evolutionDir: string, deps: OccupantDeps): Candidate[] {
  const alive = deps.alive ?? isPidAlive;
  const runsDir = path.join(evolutionDir, "runs");
  let names: string[];
  try {
    names = fs.readdirSync(runsDir);
  } catch {
    return []; // 还没派过：没有 runs/ 目录就是没人占用
  }
  const found: Candidate[] = [];
  for (const name of names) {
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(fs.readFileSync(path.join(runsDir, name, "run.json"), "utf8")) as Record<string, unknown>;
    } catch {
      continue; // run.json 不在 / 坏掉：没有可判的记录，坏记录不能永久占住闸门
    }
    const runId = typeof raw.runId === "string" ? raw.runId : name;
    if (deps.ignoreRunId !== undefined && (runId === deps.ignoreRunId || name === deps.ignoreRunId)) continue;
    const dispatchedAt = typeof raw.dispatchedAt === "number" ? raw.dispatchedAt : 0;
    // 复盘在前、督导在后：同一 run 两个 pid 都活着时，先报花 token 的那个
    const slots: [Occupant["kind"], unknown][] = [
      ["复盘", raw.pid],
      ["督导", raw.supervisorPid],
    ];
    for (const [kind, value] of slots) {
      const pid = typeof value === "number" && value > 0 ? value : null;
      if (pid !== null && alive(pid)) found.push({ occupant: { runId, pid, kind }, dispatchedAt });
    }
  }
  return found;
}

/** 当前占用者：多条都在跑时返回最早派发的那条；没人占用返回 null */
export function findOccupant(evolutionDir: string, deps: OccupantDeps = {}): Occupant | null {
  // sort 是稳定排序：dispatchedAt 相同时保持「复盘先于督导」的先后
  const found = readCandidates(evolutionDir, deps).sort((a, b) => a.dispatchedAt - b.dispatchedAt);
  return found[0]?.occupant ?? null;
}

export interface BusyGuardInput extends OccupantDeps {
  evolutionDir: string;
  sessionId: string;
  /** 遥测写入器；缺省时只记日志（督导启动那条路径理论上总有） */
  telemetry?: TelemetryWriter;
  /** 退出补发路径：主进程马上退出，只能同步写 */
  sync?: boolean;
  trigger?: "auto" | "manual" | "shutdown";
  rounds?: number;
  log?: (msg: string) => void;
}

/**
 * 三处派发点共用的闸：占用时写一条 `skipped(busy)` 遥测并返回占用者，空闲返回 null。
 * 已有 run 的状态一律不动 —— 被挡住的是「再来一个」，不是「把正在跑的收掉」。
 */
export function guardBusy(input: BusyGuardInput): Occupant | null {
  const occupant = findOccupant(input.evolutionDir, input);
  if (occupant === null) return null;
  if (input.telemetry) {
    const event = {
      kind: "skipped" as const,
      sessionId: input.sessionId,
      why: "busy",
      occupant,
      ...(input.trigger === undefined ? {} : { trigger: input.trigger }),
      ...(input.rounds === undefined ? {} : { rounds: input.rounds }),
    };
    if (input.sync === true) input.telemetry.appendSync(event);
    else input.telemetry.append(event);
  }
  input.log?.(`[skill-evolve] 单飞闸拦下一次派生：已有子进程在跑（${occupant.kind} ${occupant.runId} pid ${occupant.pid}）`);
  return occupant;
}
