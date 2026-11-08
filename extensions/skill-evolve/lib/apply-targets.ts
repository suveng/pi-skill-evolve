/**
 * 从 run 目录推出「这次采纳要写哪些文件、写成什么」。
 *
 * 为什么单独一层：apply 的五道闸只关心 (path, before, after)，把「提案 → 目标」的解析
 * 与闸门执行分开，边界用例（多文件 diff、新建技能、diff 应用失败）才能单独测。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { applyUnifiedDiff } from "./diff-apply.ts";
import { splitDiffByFile } from "./diff-gen.ts";

export interface PlannedTarget {
  /** 相对仓库根，统一用 `/` 分隔 */
  path: string;
  abs: string;
  /** null = 新建文件 */
  before: string | null;
  after: string;
}

export interface PlanResult {
  ok: boolean;
  reason?: string;
  skill: string;
  type: string;
  targets: PlannedTarget[];
}

export interface ProposalMeta {
  type: string;
  skill: string;
  diffFile: string;
  candidateFile?: string;
}

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

export function readProposalMeta(runDir: string): ProposalMeta | null {
  const raw = readText(path.join(runDir, "02-proposal.json"));
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed.skill !== "string" || parsed.skill.trim().length === 0) return null;
    return {
      type: typeof parsed.type === "string" ? parsed.type : "improve",
      skill: parsed.skill.trim(),
      diffFile: typeof parsed.diffFile === "string" ? parsed.diffFile : "02-proposal.diff",
      ...(typeof parsed.candidateFile === "string" ? { candidateFile: parsed.candidateFile } : {}),
    };
  } catch {
    return null;
  }
}

export function planTargets(runDir: string, cwd: string): PlanResult {
  const meta = readProposalMeta(runDir);
  if (!meta) return { ok: false, reason: "02-proposal.json 缺失或不可读", skill: "", type: "", targets: [] };
  const base = { skill: meta.skill, type: meta.type };
  const targets: PlannedTarget[] = [];
  const diffText = readText(path.join(runDir, meta.diffFile)) ?? "";

  if (meta.type === "create") {
    const candidateFile = meta.candidateFile ?? path.posix.join("candidate", meta.skill, "SKILL.md");
    const after = readText(path.join(runDir, candidateFile));
    if (after === null) return { ok: false, reason: `候选文件缺失：${candidateFile}`, ...base, targets: [] };
    const rel = `.pi/skills/${meta.skill}/SKILL.md`;
    targets.push({ path: rel, abs: path.join(cwd, rel), before: readText(path.join(cwd, rel)), after });
  }

  for (const { path: rel, chunk } of splitDiffByFile(diffText)) {
    if (rel === null) return { ok: false, reason: "提案里含删除文件（+++ /dev/null），删除必须走 --prune 人批", ...base, targets: [] };
    if (targets.some((target) => target.path === rel)) continue; // 新建技能的主文件已由 candidate 生成
    const abs = path.join(cwd, rel);
    const before = readText(abs);
    const applied = applyUnifiedDiff(before ?? "", chunk);
    if (!applied.ok) {
      return { ok: false, reason: `diff 无法应用（${rel}）：${applied.reason ?? "未知原因"}`, ...base, targets: [] };
    }
    targets.push({ path: rel, abs, before, after: applied.text });
  }

  if (targets.length === 0) return { ok: false, reason: "提案没有任何可写目标", ...base, targets: [] };
  return { ok: true, ...base, targets };
}
