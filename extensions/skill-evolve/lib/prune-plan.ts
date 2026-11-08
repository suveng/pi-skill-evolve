/**
 * 删技能的「待执行清单」（设计稿 10.4）：插件只出清单，真删留给人手动执行。
 *
 * 为什么不在插件里真删：删技能是不可逆操作，插件能做的只有把「要动哪五处、当前哪处还缺」
 * 摊开给人看。人批（`approve <runId> --prune`）只换取这份清单，不换取删除动作。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { readProposalMeta } from "./apply-targets.ts";

export interface PrunePlan {
  skill: string;
  steps: string[];
  /** 当前就不存在 / 已经缺的引用面（清单里标出来，别让人白跑） */
  missing: string[];
}

function exists(file: string): boolean {
  return fs.existsSync(file);
}

function readText(file: string): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

export function buildPrunePlan(runDir: string, cwd: string): PrunePlan | null {
  const meta = readProposalMeta(runDir);
  if (!meta || meta.skill.length === 0) return null;
  const skill = meta.skill;
  const missing: string[] = [];
  const stub = path.join(cwd, ".cursor", "skills", skill, "SKILL.md");
  if (!exists(stub)) missing.push(`.cursor/skills/${skill}/SKILL.md（已不存在）`);
  const agents = readText(path.join(cwd, "AGENTS.md"));
  if (agents.length > 0 && !new RegExp(`^\\s*[-*]\\s+\`${skill.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\``, "m").test(agents)) {
    missing.push(`AGENTS.md 索引表（已无 ${skill} 那一行）`);
  }
  const steps = [
    `① 删除技能目录：rm -rf .pi/skills/${skill}/`,
    `② 删除 .cursor 路由 stub：rm -f .cursor/skills/${skill}/SKILL.md`,
    `③ 从 AGENTS.md 的 Skill 索引表删掉 ${skill} 那一行（先 rg -n "\`${skill}\`" AGENTS.md 定位）`,
    `④ .dsh/skills/${skill}/ 不动（SSOT 只认 .pi，见设计稿 17.1）`,
    `⑤ 扫其余引用：rg -n "${skill}" --no-ignore -uu . —— 逐条改，只允许剩进化记录里的历史引用`,
    `校验：rg -n "${skill}" --no-ignore -uu . 只剩 .pi/evolution/ 下的历史记录`,
    `收尾：git add -A && git commit -m "docs(skill): 移除技能 ${skill}"`,
  ];
  return { skill, steps, missing };
}

export function renderPrunePlan(plan: PrunePlan): string {
  const lines = [`删技能待执行清单：${plan.skill}（插件不执行，请手动逐条确认后再删）`, ""];
  lines.push(...plan.steps);
  if (plan.missing.length > 0) {
    lines.push("", "已有缺口（不必重复处理）：");
    lines.push(...plan.missing.map((item) => `  · ${item}`));
  }
  lines.push("", "删除不可逆：确认没有其它技能/文档仍依赖它之后再动手。");
  return lines.join("\n");
}
