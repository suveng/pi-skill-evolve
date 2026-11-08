/**
 * G3 机械硬禁令扫描（设计稿 9.1 六条）：只做「出现即 P0」的机械检查，不做语义判断。
 *
 * 规则正文在 .pi/evolution/rules/hard-rules.json（入库），这里只负责解析、编译、逐行扫描。
 * 一条规则坏掉不许拖垮整条链路：逐条 try/catch，坏的记 invalid 后跳过。
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface HardRule {
  id: string;
  level: string;
  pattern: string;
  expect: string;
  /** 同一行里出现即豁免的写法：本仓技能正文大量引用「禁止 grep -r」这类反例 */
  allow?: string;
  flags?: string;
  why?: string;
}

export interface HardRuleHit {
  ruleId: string;
  level: string;
  skill: string;
  /** SKILL.md 的 1 基行号 */
  line: number;
  quote: string;
}

export interface CompiledRule {
  rule: HardRule;
  regex: RegExp;
  allowRegex?: RegExp;
}

export interface CompiledRules {
  compiled: CompiledRule[];
  /** 坏规则 / 缺字段的规则，形如 `<规则id>: <原因>` */
  invalid: string[];
}

export interface HardRuleScan {
  hits: HardRuleHit[];
  invalid: string[];
}

const QUOTE_MAX = 120;

function compileOne(raw: unknown): CompiledRule | string {
  if (typeof raw !== "object" || raw === null) return "无效规则：不是对象";
  const rule = raw as Partial<HardRule>;
  if (typeof rule.id !== "string" || rule.id.length === 0) return "无效规则：缺 id";
  if (typeof rule.pattern !== "string" || rule.pattern.length === 0) return `${rule.id}: 缺 pattern`;
  const level = typeof rule.level === "string" && rule.level.length > 0 ? rule.level : "P0";
  const flags = typeof rule.flags === "string" ? rule.flags : "";
  try {
    const regex = new RegExp(rule.pattern, flags);
    const allowRegex = typeof rule.allow === "string" && rule.allow.length > 0 ? new RegExp(rule.allow, flags) : undefined;
    return {
      rule: {
        id: rule.id,
        level,
        pattern: rule.pattern,
        expect: typeof rule.expect === "string" ? rule.expect : "",
        why: typeof rule.why === "string" ? rule.why : "",
        allow: rule.allow,
        flags,
      },
      regex,
      allowRegex,
    };
  } catch (error) {
    return `${rule.id}: 正则编译失败（${(error as Error).message}）`;
  }
}

/** 编译规则集：坏的跳过并记原因，绝不抛 */
export function compileRules(raw: unknown): CompiledRules {
  const list = Array.isArray((raw as { rules?: unknown })?.rules) ? ((raw as { rules: unknown[] }).rules) : [];
  const compiled: CompiledRule[] = [];
  const invalid: string[] = [];
  for (const item of list) {
    const result = compileOne(item);
    if (typeof result === "string") invalid.push(result);
    else compiled.push(result);
  }
  return { compiled, invalid };
}

/** 扫描一段 markdown 正文，返回命中行。纯函数，line 从 1 开始 */
export function scanText(text: string, rules: CompiledRule[], skill: string): HardRuleHit[] {
  const hits: HardRuleHit[] = [];
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.length === 0) continue;
    for (const item of rules) {
      if (!item.regex.test(line)) continue;
      if (item.allowRegex !== undefined && item.allowRegex.test(line)) continue;
      hits.push({
        ruleId: item.rule.id,
        level: item.rule.level,
        skill,
        line: index + 1,
        quote: line.trim().slice(0, QUOTE_MAX),
      });
    }
  }
  return hits;
}

/** 读规则文件；文件缺失 / JSON 坏 / 读失败都只返回 invalid，不抛 */
export function loadHardRules(file: string): CompiledRules & { file: string } {
  if (!existsSync(file)) return { file, compiled: [], invalid: [`规则文件不存在：${file}`] };
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    return { file, compiled: [], invalid: [`规则文件读取失败：${(error as Error).message}`] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { file, compiled: [], invalid: [`规则文件 JSON 解析失败：${(error as Error).message}`] };
  }
  return { file, ...compileRules(parsed) };
}

/** 扫 `.pi/skills/<名>/SKILL.md`；单个文件读失败只跳过它并记 invalid */
export function scanSkillsDir(skillsDir: string, rules: CompiledRule[]): HardRuleScan {
  const hits: HardRuleHit[] = [];
  const invalid: string[] = [];
  if (!existsSync(skillsDir)) return { hits, invalid: [`技能目录不存在：${skillsDir}`] };
  let entries: string[];
  try {
    entries = readdirSync(skillsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (error) {
    return { hits, invalid: [`技能目录读取失败：${(error as Error).message}`] };
  }
  for (const skill of entries) {
    const file = join(skillsDir, skill, "SKILL.md");
    if (!existsSync(file)) continue;
    try {
      hits.push(...scanText(readFileSync(file, "utf8"), rules, skill));
    } catch (error) {
      invalid.push(`${skill}: 读取失败（${(error as Error).message}）`);
    }
  }
  return { hits, invalid };
}

/** 磁盘上 `.pi/skills/*` 的目录名清单，用于 D 类判定 */
export function listSkillDirs(skillsDir: string): string[] {
  if (!existsSync(skillsDir)) return [];
  try {
    return readdirSync(skillsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}
