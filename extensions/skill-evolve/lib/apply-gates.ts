/**
 * 设计稿 13.2 的五道闸：授权核对 → 备份 → 原子写 → 复验 → 生效边界。
 *
 * 逐闸失败即回滚（闸0 是例外：它还没写盘，没有可回滚的东西）。
 * git / md-check / skills diagnostics 全部走注入 —— 单测里绝不起真进程（M4 那 51 个督导进程的教训）。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { PlannedTarget } from "./apply-targets.ts";
import { renderUnifiedDiff } from "./diff-gen.ts";
import { captureGate0, gate0Drift, readGate0, type GitRunner } from "./gate0.ts";
import type { MutationQueue } from "./telemetry.ts";

export type GateId = "gate0" | "gate1" | "gate2" | "gate3" | "gate4";

export interface GateResult {
  gate: GateId;
  name: string;
  ok: boolean;
  ms: number;
  detail?: string;
}

export interface GateDeps {
  evolutionDir: string;
  cwd: string;
  runId: string;
  queue: MutationQueue;
  now: () => number;
  log: (msg: string) => void;
  git: GitRunner;
  /** 生产：loadSkillsFromDir({ dir: join(cwd,".pi/skills"), source:"project" }).diagnostics */
  loadDiagnostics: () => { path: string; message: string }[];
  /** 生产：spawnSync python3 .pi/skills/md-check/scripts/check_md.py <文件> */
  runMdCheck: (absPath: string) => { code: number; output: string };
}

export interface GateRun {
  ok: boolean;
  /** 闸0 拒采：没写盘，调用方据此标 unauthorized_write 而不是 rolled-back */
  unauthorized: boolean;
  gates: GateResult[];
  wrote: string[];
  appliedDiff: string;
  detail?: string;
}

export const BACKUP_RETENTION_DAYS = 30;
const DAY_MS = 86_400_000;

export function backupRoot(evolutionDir: string): string {
  return path.join(evolutionDir, "backups");
}

export function backupDir(evolutionDir: string, runId: string): string {
  return path.join(backupRoot(evolutionDir), runId);
}

/** 备份 30 天清理：只在 session_start 调，删不掉就留到下次（不影响采纳） */
export function cleanupBackups(evolutionDir: string, now: number, log: (msg: string) => void): number {
  let names: string[];
  try {
    names = fs.readdirSync(backupRoot(evolutionDir));
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    const dir = path.join(backupRoot(evolutionDir), name);
    try {
      if (now - fs.statSync(dir).mtimeMs <= BACKUP_RETENTION_DAYS * DAY_MS) continue;
      fs.rmSync(dir, { recursive: true, force: true });
      removed += 1;
    } catch {
      // 单个目录清不掉不影响采纳
    }
  }
  if (removed > 0) log(`[skill-evolve] 清理 ${removed} 个超过 ${BACKUP_RETENTION_DAYS} 天的备份`);
  return removed;
}

function readTextOrNull(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 新增技能的引用面（设计稿 10.4 的 ②③）：缺 stub 或缺索引行就说明收口没做完 */
function missingReferences(cwd: string, skill: string): string[] {
  const missing: string[] = [];
  if (!fs.existsSync(path.join(cwd, ".cursor", "skills", skill, "SKILL.md"))) missing.push(`.cursor/skills/${skill}/SKILL.md`);
  const agents = readTextOrNull(path.join(cwd, "AGENTS.md")) ?? "";
  if (!new RegExp(`^\\s*[-*]\\s+\`${escapeRe(skill)}\``, "m").test(agents)) missing.push(`AGENTS.md 索引表（- \`${skill}\` …）`);
  return missing;
}

export async function restoreTargets(deps: GateDeps, targets: readonly PlannedTarget[], wrote: readonly string[]): Promise<string> {
  for (const rel of wrote) {
    const target = targets.find((item) => item.path === rel);
    if (!target) continue;
    await deps.queue(target.abs, async () => {
      if (target.before === null) await fs.promises.rm(target.abs, { force: true });
      else {
        await fs.promises.mkdir(path.dirname(target.abs), { recursive: true });
        await fs.promises.writeFile(target.abs, target.before, "utf8");
      }
    });
  }
  return `已从备份回滚 ${wrote.length} 个文件`;
}

export async function runGates(deps: GateDeps, targets: readonly PlannedTarget[]): Promise<GateRun> {
  const gates: GateResult[] = [];
  const wrote: string[] = [];
  const appliedDiff = targets.map((target) => renderUnifiedDiff(target.path, target.before, target.after)).join("");
  const fail = (detail: string, unauthorized = false): GateRun => ({ ok: false, unauthorized, gates, wrote, appliedDiff, detail });

  // 闸0 · 授权核对：没写盘，所以这一闸失败时什么都没有落地
  const t0 = deps.now();
  const snapshot = readGate0(deps.evolutionDir);
  const drift = gate0Drift(snapshot, captureGate0(deps.git, deps.cwd, deps.now()));
  gates.push({ gate: "gate0", name: "授权核对", ok: drift.length === 0, ms: deps.now() - t0, ...(drift ? { detail: drift } : {}) });
  if (drift.length > 0) {
    deps.log(`[skill-evolve] ${drift}`);
    return fail(drift, true);
  }

  // 闸1 · 备份：回滚的唯一依据，备份写不进去就不许写盘
  const t1 = deps.now();
  try {
    for (const target of targets) {
      if (target.before === null) continue;
      const dest = path.join(backupDir(deps.evolutionDir, deps.runId), target.path);
      await deps.queue(dest, async () => {
        await fs.promises.mkdir(path.dirname(dest), { recursive: true });
        await fs.promises.writeFile(dest, target.before as string, "utf8");
      });
    }
    for (const target of targets) {
      if (target.before !== null && !fs.existsSync(path.join(backupDir(deps.evolutionDir, deps.runId), target.path))) {
        throw new Error(`备份缺失：${target.path}`);
      }
    }
    gates.push({ gate: "gate1", name: "备份", ok: true, ms: deps.now() - t1 });
  } catch (error) {
    gates.push({ gate: "gate1", name: "备份", ok: false, ms: deps.now() - t1, detail: String(error) });
    return fail(`闸1 备份失败：${String(error)}`);
  }

  // 闸2 · 原子写：整个「重读 → 比对 → 写」窗口都在 withFileMutationQueue 里
  const t2 = deps.now();
  for (const target of targets) {
    try {
      await deps.queue(target.abs, async () => {
        const current = readTextOrNull(target.abs);
        if (current !== target.before) throw new Error(`磁盘内容与计划不一致：${target.path}`);
        await fs.promises.mkdir(path.dirname(target.abs), { recursive: true });
        await fs.promises.writeFile(target.abs, target.after, "utf8");
      });
      wrote.push(target.path);
    } catch (error) {
      gates.push({ gate: "gate2", name: "原子写", ok: false, ms: deps.now() - t2, detail: String(error) });
      const detail = `${String(error)}；${await restoreTargets(deps, targets, wrote)}`;
      return fail(`闸2 写入失败：${detail}`);
    }
  }
  gates.push({ gate: "gate2", name: "原子写", ok: true, ms: deps.now() - t2 });

  // 闸3 · 复验：diagnostics + md-check + 引用面
  const t3 = deps.now();
  const problems: string[] = [];
  const diagnostics = deps.loadDiagnostics();
  if (diagnostics.length > 0) problems.push(`skills diagnostics 非空：${diagnostics[0].message}`);
  for (const target of targets.filter((item) => item.path.startsWith(".pi/skills/"))) {
    const check = deps.runMdCheck(target.abs);
    if (check.code !== 0) problems.push(`md-check 失败（${target.path}）：${check.output.trim().split("\n").slice(-2).join(" / ")}`);
  }
  for (const target of targets.filter((item) => item.before === null && /^\.pi\/skills\/[^/]+\/SKILL\.md$/.test(item.path))) {
    const skill = target.path.split("/")[2];
    const missing = missingReferences(deps.cwd, skill);
    if (missing.length > 0) problems.push(`新增技能引用面缺：${missing.join("、")}`);
  }
  gates.push({
    gate: "gate3",
    name: "复验",
    ok: problems.length === 0,
    ms: deps.now() - t3,
    ...(problems.length > 0 ? { detail: problems.join("；") } : {}),
  });
  if (problems.length > 0) {
    const detail = `${problems.join("；")}；${await restoreTargets(deps, targets, wrote)}`;
    return fail(`闸3 复验失败：${detail}`);
  }

  // 闸4 · 生效边界：不做 /reload，只提示新会话生效（技能在 session_start 重新发现）
  gates.push({ gate: "gate4", name: "生效边界", ok: true, ms: 0, detail: "未 /reload：新会话生效" });
  return { ok: true, unauthorized: false, gates, wrote, appliedDiff };
}
