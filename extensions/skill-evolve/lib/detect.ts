/**
 * L0 采集的技能文件识别（纯函数，零依赖，可直接被 node --test 跑）。
 *
 * 只做事实判定：这一条工具调用是否读了某个技能文件、读的是哪个技能。
 * 「读到了有没有照做」是复盘阶段的事，这里不猜。
 */
import * as path from "node:path";

export interface SkillHit {
  /** 技能名（= SKILL.md 的父目录名） */
  skill: string;
  /** 识别途径：read 高置信、bash 中置信 */
  how: "read" | "bash";
  /** 与命中有关的原始路径（绝对路径或命令里的路径片段），写进遥测做证据 */
  raw: string;
}

const SKILL_FILE = "SKILL.md";
const SKILL_SUFFIX = `/${SKILL_FILE}`;

function normalize(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

/** `.../<名>/SKILL.md` → 名；不符合返回 null */
export function skillNameFromPath(filePath: string): string | null {
  const normalized = normalize(String(filePath ?? "")).replace(/\/+$/, "");
  if (normalized.length <= SKILL_SUFFIX.length) return null;
  if (normalized.slice(-SKILL_SUFFIX.length).toLowerCase() !== SKILL_SUFFIX.toLowerCase()) return null;
  const dir = normalized.slice(0, normalized.length - SKILL_SUFFIX.length);
  const name = dir.slice(dir.lastIndexOf("/") + 1);
  if (name.length === 0 || name === "." || name === "..") return null;
  return name;
}

/** read 工具：去掉 `@` 前缀后按 cwd 解析成绝对路径，必须以 `/SKILL.md` 结尾 */
export function detectFromRead(rawPath: string, cwd: string): SkillHit | null {
  const raw = String(rawPath ?? "").trim().replace(/^@/, "");
  if (raw.length === 0) return null;
  const absolute = normalize(path.resolve(cwd, raw));
  const skill = skillNameFromPath(absolute);
  return skill ? { skill, how: "read", raw: absolute } : null;
}

/**
 * bash 工具：命令串里出现 `skills/<名>/SKILL.md`。
 * 路径两侧的引号不在字符集里，所以 `cat ".pi/skills/x/SKILL.md"` 与不带引号都能命中。
 */
export function detectFromBash(command: string): SkillHit[] {
  const text = String(command ?? "");
  if (!text.includes(SKILL_FILE)) return [];
  // 正则放在函数内：带 g 的正则共享 lastIndex，模块级复用会在并发调用间串味。
  const pattern = /[^\s"'`]*skills\/[A-Za-z0-9._-]+\/SKILL\.md/gi;
  const hits = new Map<string, SkillHit>();
  for (const match of text.matchAll(pattern)) {
    const raw = match[0];
    const skill = skillNameFromPath(raw);
    if (!skill || hits.has(skill)) continue;
    hits.set(skill, { skill, how: "bash", raw });
  }
  return [...hits.values()];
}
