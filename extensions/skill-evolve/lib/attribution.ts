/**
 * G2 机械归因：把「曝光了但没加载」的技能判定成 A~E 中的一类，判不动的留给复盘 agent 做 F/G。
 *
 * 判定顺序是硬的（设计稿第八章）：A → B → C → D → E → semantic，命中即停。
 * 顺序颠倒的后果不是「少一条建议」，而是得到一堆「建议重写 description」的错误建议——
 * 一个 frontmatter 坏掉、或者本轮根本没有 read 工具的会话，文案改成天花乱坠也加载不了。
 *
 * 本模块是纯函数：不读盘、不调 pi，输入全部由调用方（mechanical.ts）备好。
 */

export type AttributionCategory = "A" | "B" | "C" | "D" | "E" | "semantic";

/** 报告与 prompt 都按这个顺序展示，别处不要再自己排序 */
export const CATEGORY_ORDER: readonly AttributionCategory[] = ["A", "B", "C", "D", "E", "semantic"];

export interface ExposedSkill {
  name: string;
  filePath: string;
  /** 对应 Skill.disableModelInvocation */
  disabled?: boolean;
}

export interface DiagnosticEntry {
  file: string;
  message: string;
  /** pi 的 ResourceDiagnostic.type：warning / error / collision */
  type?: string;
}

export interface LoadedSkill {
  name: string;
  filePath: string;
}

export interface AttributionInput {
  /** 本轮曝光但没加载的技能名 */
  missed: string[];
  /** 本轮 prompt 里的技能（含被禁用的） */
  exposed: ExposedSkill[];
  /** loadSkillsFromDir 的发现结果（同名多次 = 发现顺序冲突） */
  loadedFromPi: LoadedSkill[];
  diagnostics: DiagnosticEntry[];
  /** 本轮会话声明的工具名（pi.getActiveTools()） */
  activeTools: string[];
  /** 磁盘上 .pi/skills/* 的目录名 */
  diskSkillNames: string[];
}

export interface Attribution {
  skill: string;
  category: AttributionCategory;
  reason: string;
}

/** 每个类别的处置建议（设计稿第八章表格）：报告里照抄，不自动执行 */
export const DISPOSITIONS: Record<AttributionCategory, { label: string; action: string; auto: string }> = {
  A: { label: "设计如此", action: "提示「仅支持 /skill:名字 显式调用」，不视为缺陷", auto: "-" },
  B: { label: "frontmatter 坏", action: "修 frontmatter（缺 description 或名字不合规）", auto: "auto" },
  C: { label: "同名冲突", action: "改名或调整发现顺序（高风险，必须人批）", auto: "forbidden" },
  D: { label: "不在发现范围", action: "只记「不在 .pi/skills 观测范围」，不清理", auto: "-" },
  E: { label: "缺读工具", action: "提示会话配置缺 read/bash 工具，与技能内容无关", auto: "-" },
  semantic: { label: "待语义判定", action: "由复盘 agent 判 F（兄弟竞争）/ G（文案路由词）", auto: "approval" },
};

const TOOL_NAMES_FOR_READING = ["read", "bash"];

/** 路径比较：pi 的诊断里 file 可能是绝对路径也可能是相对的，末端一致就算同一个文件 */
function samePath(a: string, b: string): boolean {
  const norm = (value: string): string => value.replace(/\\/g, "/").replace(/\/+$/, "");
  const left = norm(a);
  const right = norm(b);
  if (left.length === 0 || right.length === 0) return false;
  return left === right || left.endsWith(right) || right.endsWith(left);
}

function namesSkill(message: string, name: string): boolean {
  // 描述里出现 `name` 这个词才算，避免 "a" 命中 "schema"
  return new RegExp(`(^|[^\\w-])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^\\w-]|$)`).test(message);
}

/** 归类一个未命中技能。顺序即设计稿的决策树，改动前先读第八章 */
export function classifyOne(name: string, input: AttributionInput): Attribution {
  const exposed = input.exposed.find((skill) => skill.name === name);
  const found = input.loadedFromPi.filter((skill) => skill.name === name);

  // A：disableModelInvocation —— 它本来就不进 prompt，不是缺陷
  if (exposed?.disabled === true) {
    return { skill: name, category: "A", reason: "disableModelInvocation=true，只能 /skill:<名> 显式调用" };
  }

  // B：frontmatter 坏（pi 只 warning 不报错，所以它「看起来存在」但没被正常加载）
  const diagnostics = input.diagnostics.filter((entry) => samePath(entry.file, exposed?.filePath ?? ""));
  if (diagnostics.length > 0) {
    return { skill: name, category: "B", reason: `frontmatter/diagnostics：${diagnostics[0].message}` };
  }

  // C：同名被抢先（发现顺序问题）
  if (found.length >= 2) {
    return { skill: name, category: "C", reason: `同名在 ${found.length} 处被定义：${found.map((item) => item.filePath).join("、")}` };
  }
  const collision = input.diagnostics.find((entry) => entry.type === "collision" && namesSkill(entry.message, name));
  if (collision) return { skill: name, category: "C", reason: `发现冲突：${collision.message}` };

  // D：磁盘上有这个技能，但不在发现结果里 —— 不在观测范围
  if (input.diskSkillNames.includes(name) && found.length === 0) {
    return { skill: name, category: "D", reason: `磁盘上有 .pi/skills/${name}/，但 loadSkillsFromDir 没有返回它` };
  }

  // E：本轮根本没有读工具 —— 必须排在文案类之前，否则会得出「改 description」的错误建议
  // 注意：activeTools 为空表示「没采到」，不是「工具全关了」；采集缺口不能拿来当结论
  const hasReader = TOOL_NAMES_FOR_READING.some((tool) => input.activeTools.includes(tool));
  if (input.activeTools.length > 0 && !hasReader) {
    return {
      skill: name,
      category: "E",
      reason: `本轮 activeTools 里既没有 read 也没有 bash（当前：${input.activeTools.join("、")}），模型读不到技能文件`,
    };
  }

  return { skill: name, category: "semantic", reason: "机械层判不了，交给复盘 agent 判 F（兄弟竞争）/ G（文案路由词）" };
}

/** 对一批未命中技能逐个归类，保持传入顺序 */
export function classifyMechanical(input: AttributionInput): Attribution[] {
  return input.missed.map((name) => classifyOne(name, input));
}

/** 多轮合并时的归因去重：同一技能只留第一次的分类，避免一句话里出现两种结论 */
export function mergeAttributions(
  a: readonly Attribution[] | undefined,
  b: readonly Attribution[] | undefined,
): Attribution[] {
  const merged: Attribution[] = [];
  for (const item of [...(a ?? []), ...(b ?? [])]) {
    if (!merged.some((existing) => existing.skill === item.skill)) merged.push(item);
  }
  return merged;
}
