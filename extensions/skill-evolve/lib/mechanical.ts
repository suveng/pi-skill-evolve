/**
 * 机械层的现场勘查：把 pi 的技能发现结果、磁盘目录清单、硬禁令扫描结果缓存成一份快照，
 * 再喂给纯函数做归因（attribution.ts）与冲突判定（hard-rules.ts）。
 *
 * 缓存与注入的理由：
 * - `loadSkillsFromDir` 要解析 28 个 SKILL.md 的 frontmatter，每进程只做一次；
 * - 硬禁令扫描要读 28 个文件（实测 8ms），只在第一次 settle 做一次，绝不放进 factory；
 * - 所有依赖靠注入，这样本模块不 import pi 包，能被 `node --test` 直接跑。
 */

import { join } from "node:path";
import {
  classifyMechanical,
  type Attribution,
  type DiagnosticEntry,
  type ExposedSkill,
} from "./attribution.ts";
import {
  listSkillDirs,
  loadHardRules,
  scanSkillsDir,
  type HardRuleHit,
  type CompiledRules,
} from "./hard-rules.ts";

export interface SnapshotSkill {
  name: string;
  filePath: string;
}

export interface SkillsSnapshot {
  skills: SnapshotSkill[];
  diagnostics: DiagnosticEntry[];
  /** 磁盘上 .pi/skills/* 的目录名 */
  diskSkillNames: string[];
  /** 发现失败的原因（此时 skills 为空，调用方要记 handler_error） */
  failed?: string;
}

/** pi 的 ResourceDiagnostic → 本模块的 DiagnosticEntry（字段名是 path 不是 file） */
export interface RawDiagnostic {
  path?: string;
  message: string;
  type?: string;
}

export interface MechanicalDeps {
  cwd: string;
  /** 生产实现：() => loadSkillsFromDir({ dir: join(cwd, ".pi/skills"), source: "project" }) */
  loadSkills: () => { skills: SnapshotSkill[]; diagnostics: RawDiagnostic[] };
  /** .pi/evolution/rules/hard-rules.json 绝对路径 */
  rulesFile: string;
  log: (message: string) => void;
}

export interface AttributeRequest {
  /** 本轮曝光但没加载的技能名 */
  missed: string[];
  /** 本轮 prompt 里的技能 */
  exposed: ExposedSkill[];
  /** 本轮 activeTools（pi.getActiveTools()） */
  activeTools: string[];
}

export interface ConflictScan {
  hits: HardRuleHit[];
  invalid: string[];
}

export interface Mechanical {
  snapshot(): SkillsSnapshot;
  attribute(request: AttributeRequest): Attribution[];
  conflicts(): ConflictScan;
}

export function createMechanical(deps: MechanicalDeps): Mechanical {
  const skillsDir = join(deps.cwd, ".pi", "skills");
  let cachedSnapshot: SkillsSnapshot | undefined;
  let cachedRules: CompiledRules | undefined;
  let cachedConflicts: ConflictScan | undefined;

  const snapshot = (): SkillsSnapshot => {
    if (cachedSnapshot !== undefined) return cachedSnapshot;
    const diskSkillNames = listSkillDirs(skillsDir);
    try {
      const result = deps.loadSkills();
      cachedSnapshot = {
        skills: result.skills.map((skill) => ({ name: skill.name, filePath: skill.filePath })),
        diagnostics: result.diagnostics.map((entry) => ({
          file: entry.path ?? "",
          message: entry.message,
          type: entry.type,
        })),
        diskSkillNames,
      };
    } catch (error) {
      const message = (error as Error).message;
      deps.log(`技能发现失败，机械归因降级为 D/semantic：${message}`);
      cachedSnapshot = { skills: [], diagnostics: [], diskSkillNames, failed: message };
    }
    return cachedSnapshot;
  };

  const rules = (): CompiledRules => {
    if (cachedRules !== undefined) return cachedRules;
    const loaded = loadHardRules(deps.rulesFile);
    for (const item of loaded.invalid) deps.log(`硬禁令规则不可用：${item}`);
    cachedRules = { compiled: loaded.compiled, invalid: loaded.invalid };
    return cachedRules;
  };

  return {
    snapshot,

    attribute(request: AttributeRequest): Attribution[] {
      const current = snapshot();
      return classifyMechanical({
        missed: request.missed,
        exposed: request.exposed,
        loadedFromPi: current.skills,
        diagnostics: current.diagnostics,
        activeTools: request.activeTools,
        diskSkillNames: current.diskSkillNames,
      });
    },

    conflicts(): ConflictScan {
      if (cachedConflicts !== undefined) return cachedConflicts;
      const compiled = rules();
      const scanned = scanSkillsDir(skillsDir, compiled.compiled);
      for (const item of scanned.invalid) deps.log(`硬禁令扫描跳过：${item}`);
      cachedConflicts = { hits: scanned.hits, invalid: [...compiled.invalid, ...scanned.invalid] };
      return cachedConflicts;
    },
  };
}
