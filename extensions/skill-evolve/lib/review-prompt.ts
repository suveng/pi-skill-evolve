/**
 * 评审 prompt 拼装（设计稿 12.2）：只给四样东西 —— 仓库硬约束、diff、改后全文、验收标准。
 *
 * 五条硬约束里的第 2 条是这里的唯一职责：**不给提案理由、不给 findings**，
 * 否则评审员会顺着提案者的推理复述一遍，评不出真问题。所以入参里根本没有这两个字段，
 * 单测直接断言产物里不出现这两个来源的痕迹。
 */
import type { CompiledRule } from "./hard-rules.ts";

export interface ReviewRuleInput {
  id: string;
  level: string;
  expect: string;
  why?: string;
}

export interface ReviewPromptInput {
  skillName: string;
  /** 改动后的技能全文；diff 应用失败时是改动前的全文，靠 diffApplied 标注 */
  skillText: string;
  diffApplied: boolean;
  diff: string;
  hardRules: readonly ReviewRuleInput[] | readonly CompiledRule[];
  /** 覆盖默认验收标准（必红自检用不到，但保留注入点便于单测） */
  acceptance?: readonly string[];
}

export const ACCEPTANCE_STANDARDS: readonly string[] = [
  "不得引入与硬约束冲突的条款",
  "不得删除原有的明确禁止项",
  "新增条款必须能用一句话说清「什么时候适用」",
  "描述（description）必须包含触发场景词，且不超过 1024 字",
];

function ruleLines(items: readonly ReviewRuleInput[] | readonly CompiledRule[]): string[] {
  if (items.length === 0) return ["（规则文件缺失：没有可注入的硬约束，此时应按验收标准判，拿不准的给 revise）"];
  return items.map((item) => {
    const rule = "rule" in item ? item.rule : item;
    const impl = "rule" in item ? `（匹配 ${rule.pattern}）` : "";
    return `- ${rule.id}（${rule.level}）：${rule.expect}${impl}${rule.why ? ` —— ${rule.why}` : ""}`;
  });
}

export function buildReviewPrompt(input: ReviewPromptInput): string {
  const acceptance = input.acceptance ?? ACCEPTANCE_STANDARDS;
  const textHeader = input.diffApplied
    ? "## 改动后的技能全文"
    : "## 技能全文（diff 无法自动应用，下面是**改动前**的版本，只有上面的 diff 可信）";
  return [
    "你是本仓库的技能评审员。你只看到一个候选改动和仓库硬约束，看不到提案者的理由。",
    "",
    "## 仓库硬约束（违反任一条 = reject）",
    ...ruleLines(input.hardRules),
    "",
    "## 候选改动（unified diff）",
    "```diff",
    input.diff.trimEnd(),
    "```",
    "",
    textHeader,
    "```markdown",
    input.skillText.trimEnd(),
    "```",
    "",
    "## 验收标准",
    ...acceptance.map((item, index) => `${index + 1}. ${item}`),
    "",
    "## verdict 怎么选（别把能改的小毛病判成 reject）",
    "- reject：删掉了原有的明确禁止项 / 引入与硬约束冲突的内容 / 改动方向本身就是错的",
    "- revise：方向可以接受，但有具体的可修点（如 description 太笼统、缺触发场景词、某句表述含糊）",
    "- pass：没有阻塞问题",
    "",
    "## 输出格式（严格遵守，只输出 JSON，不要代码围栏、不要解释）",
    '{"verdict":"pass|reject|revise",',
    ' "summary":"一句话结论（≤80 字，必须写清因为什么）",',
    ' "blocking":[{"issue":"...","evidence":{"file":"...","line":42,"quote":"原文"}}],',
    ' "passed":[{"point":"...","evidence":{"file":"...","line":42,"quote":"原文"}}],',
    ' "notes":"..."}',
    "",
    `技能名：${input.skillName}`,
    "说明：summary 必填，不要写成「没问题」或「建议修改」这种没有原因的空话，要写「因为哪一句 / 少哪一项所以这个结论」。",
    "blocking 每条都必须给 file/line/quote（quote 是被改动文件里的原文片段）；verdict=reject/revise 时 blocking 至少 1 条。",
    "passed 写「哪一点没问题 + 支撑它的原文」；verdict=pass 时 blocking=[] 且 passed 至少 1 条（只写「通过」两个字等于没说）。",
    "",
  ].join("\n");
}
