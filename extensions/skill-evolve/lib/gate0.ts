/**
 * 闸0 · 授权核对（设计稿 13.2）：会话开始时记一份 `.pi/skills` 的 git 摘要，采纳前重算。
 *
 * 判据只有一条：这段时间里 `.pi/skills` 的 git status / diff **一个字节都不能变**。
 * 变了就说明有人（或另一个会话）也在改同一片文件 —— 这时写盘会把别人的改动一起提交，
 * 所以本插件**不写盘**，只告警并留证据（03/06 里都有），绝不自动还原别人的改动：
 * 并发编辑时「自动还原」= 直接把别人的活儿删掉。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { MutationQueue } from "./telemetry.ts";

/** 同步跑 git 的注入点：测试给假实现，生产给 spawnSync 包装（绝不在测试里真起进程） */
export type GitRunner = (args: string[], cwd: string) => { code: number; out: string };

export interface Gate0Snapshot {
  at: number;
  status: string;
  diff: string;
  /** git 自身失败的说明（非空即视为无法核对） */
  error?: string;
}

export const GATE0_FILE = "gate0.json";

export function gate0Path(evolutionDir: string): string {
  return path.join(evolutionDir, "locks", GATE0_FILE);
}

export function captureGate0(git: GitRunner, cwd: string, now: number): Gate0Snapshot {
  const status = git(["status", "--porcelain", "--", ".pi/skills"], cwd);
  const diff = git(["diff", "--", ".pi/skills"], cwd);
  const failed: string[] = [];
  if (status.code !== 0) failed.push(`status 退出码 ${status.code}`);
  if (diff.code !== 0) failed.push(`diff 退出码 ${diff.code}`);
  return {
    at: now,
    status: status.out,
    diff: diff.out,
    ...(failed.length > 0 ? { error: failed.join("；") } : {}),
  };
}

/**
 * 与采纳前的现场比对。返回 null = 未漂移；返回字符串 = 拒绝采纳的原因（人话）。
 * 没有快照（扩展不是从 session_start 起来的）时按「无法核对」处理 —— 宁可拒采，不赌。
 */
export function gate0Drift(before: Gate0Snapshot | null, after: Gate0Snapshot): string {
  if (!before) return "闸0：没有会话起点的 .pi/skills 快照，无法核对授权面";
  if (after.error) return `闸0：git 不可用（${after.error}）`;
  if (before.status !== after.status || before.diff !== after.diff) {
    return "闸0：.pi/skills 在会话开始后被改动过（并发编辑），本次拒绝写盘并告警";
  }
  return "";
}

export async function saveGate0(evolutionDir: string, snapshot: Gate0Snapshot, queue: MutationQueue): Promise<void> {
  const file = gate0Path(evolutionDir);
  await queue(file, async () => {
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(file, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  });
}

export function readGate0(evolutionDir: string): Gate0Snapshot | null {
  try {
    const raw = JSON.parse(fs.readFileSync(gate0Path(evolutionDir), "utf8")) as Partial<Gate0Snapshot>;
    if (typeof raw.status !== "string" || typeof raw.diff !== "string") return null;
    return {
      at: typeof raw.at === "number" ? raw.at : 0,
      status: raw.status,
      diff: raw.diff,
      ...(typeof raw.error === "string" ? { error: raw.error } : {}),
    };
  } catch {
    return null;
  }
}
