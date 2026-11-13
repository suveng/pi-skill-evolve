/**
 * 13.1 三级权限的代码判定：只看 diff 真改了什么，不看 LLM 写的 action 字段（它只作参考，冲突以本文件为准）。
 *
 * forbidden = 立即拒绝（删技能、改 frontmatter 语义字段、动插件自身、路径越界）；
 * auto = settle 时自动应用（改描述或正文、新建 .cursor 路由 stub、AGENTS.md 索引表增删一行）；
 * approval = 其余全部（新增技能、合并），必须 `/skill-evolve approve <runId>` 或面板点批准。
 *
 * 为什么按「行」判而不是按意图判：模型可以声称自己只改了 description，代码只认它真改的行。
 */

export type ActionLevel = "auto" | "approval" | "forbidden";

export interface ClassifyInput {
  diffText: string;
  /** improve / create / merge / prune */
  proposalType: string;
  skill: string;
}

export interface ClassifyResult {
  level: ActionLevel;
  /** 判定依据（人话，进 06-verify.json 与告警） */
  reasons: string[];
  /** diff 里出现的所有目标路径（相对仓库根） */
  targets: string[];
}

export interface DiffSection {
  path: string;
  created: boolean;
  deleted: boolean;
  lines: { sign: "+" | "-" | " "; text: string }[];
}

/** 允许被采纳路径的白名单：路径本身就是授权边界，白名单外一律 forbidden */
// 2026-11-14 用户口径「skill 的说明、正文、references、scripts 都要能进化」：
// 技能目录下的任何文件都算可改目标（SKILL.md / references/* / scripts/* / 其它资源），
// 但路径本身必须是「技能目录里的一层真实文件」—— 禁 `..`、禁绝对路径、禁藏文件。
const SKILL_ASSET_PATH = /^(?:\.pi|\.cursor)\/skills\/(?!\.)[^/]+\/(?!\.)[\w.-]+(?:\/[\w.-]+)*$/;
const ALLOWED_PATH = /^(?:(?:\.pi|\.cursor)\/skills\/[^/]+\/SKILL\.md|(?:\.pi\/)?AGENTS\.md)$/;
const SKILL_FILE = /^(?:\.pi|\.cursor)\/skills\/[^/]+\/SKILL\.md$/;
const CURSOR_STUB = /^\.cursor\/skills\/[^/]+\/SKILL\.md$/;
const AGENTS_FILE = /(?:^|\/)AGENTS\.md$/;
const PROTECTED_PATH = ".pi/extensions/skill-evolve";
/** 换掉这三个字段就是换技能语义（名字 / 工具面 / 是否进 prompt），不许自动采纳 */
const FORBIDDEN_FIELD = /^(name|allowed-tools|disable-model-invocation):/;
const DESCRIPTION_START = /^description:/;
/** AGENTS.md 的 Skill 索引表行：`- \`<名>\` —— <路径>` */
const INDEX_ROW = /^\s*[-*]\s+`[^`]+`\s/;

function normalizePath(raw: string): string | null {
  const head = raw.split("\t")[0].trim();
  if (head === "/dev/null" || head.length === 0) return null;
  return head.replace(/^[ab]\//, "");
}

/** 按 `+++` 切开文件段：多文件 diff（技能文件 + .cursor stub + AGENTS.md）必须逐段判 */
export function parseSections(diffText: string): DiffSection[] {
  const sections: DiffSection[] = [];
  let current: DiffSection | null = null;
  let oldPath: string | null = null;
  let oldIsNull = false;
  for (const raw of diffText.split(/\r?\n/)) {
    if (raw.startsWith("--- ")) {
      oldPath = normalizePath(raw.slice(4));
      oldIsNull = oldPath === null;
      continue;
    }
    if (raw.startsWith("+++ ")) {
      const newPath = normalizePath(raw.slice(4));
      current = {
        path: newPath ?? oldPath ?? "",
        created: oldIsNull,
        deleted: newPath === null,
        lines: [],
      };
      sections.push(current);
      continue;
    }
    if (!current || raw.length === 0) continue;
    if (raw.startsWith("@@") || raw.startsWith("\\ ")) continue;
    if (!raw.startsWith("+") && !raw.startsWith("-") && !raw.startsWith(" ")) continue;
    current.lines.push({ sign: raw[0] as "+" | "-" | " ", text: raw.slice(1) });
  }
  return sections;
}

/**
 * 标出每个改动行是否属于 description（含 YAML 续行：缩进 ≥2 且上一行在 description 里）。
 * 只有这类行的改动才够格走 auto —— 它改的是「什么时候该用我」的措辞，不是行为约束。
 */
function descriptionFlags(section: DiffSection): boolean[] {
  const flags: boolean[] = [];
  let inDescription = false;
  for (const line of section.lines) {
    if (DESCRIPTION_START.test(line.text)) inDescription = true;
    else if (line.text.trim().length === 0) {
      // 空行不打断：folded / literal 块里允许空行
    } else if (!/^\s{2,}\S/.test(line.text) || !inDescription) inDescription = false;
    flags.push(inDescription);
  }
  return flags;
}

export function classifyChange(input: ClassifyInput): ClassifyResult {
  const sections = parseSections(input.diffText);
  const targets = sections.map((section) => section.path).filter((item) => item.length > 0);
  const deny = (why: string): ClassifyResult => ({ level: "forbidden", reasons: [why], targets });

  if (sections.length === 0) return { level: "approval", reasons: ["diff 里没有可判定的文件段"], targets };
  if (input.proposalType === "prune") return deny("prune（删技能）必须人批：插件只出待执行清单，不真删");

  for (const section of sections) {
    if (section.deleted) return deny(`删除文件：${section.path || "(未知路径)"}`);
    if (section.path.includes(PROTECTED_PATH)) return deny(`改动插件自身：${section.path}`);
    const inSkillDir = SKILL_ASSET_PATH.test(section.path) && !section.path.split("/").includes("..");
    if (!ALLOWED_PATH.test(section.path) && !inSkillDir) return deny(`路径越界：${section.path || "(未知路径)"}`);
    for (const line of section.lines) {
      // 只看增删行：上下文行里出现 `name:` 不是「改动字段」，否则任何挨着 frontmatter 的提案都会被误判 forbidden
      if (line.sign === " " || line.text.trim().length === 0) continue;
      if (FORBIDDEN_FIELD.test(line.text.trim())) return deny(`改动 frontmatter 字段：${line.text.trim()}`);
    }
  }

  const changes = sections.flatMap((section) => section.lines.filter((line) => line.sign !== " "));
  if (changes.length === 0) return { level: "approval", reasons: ["没有任何增删行"], targets };

  // 逐段判「这一段自身是否够格 auto」：多文件提案必须每一段都够格，才能整条自动采纳
  const sectionAuto = (section: DiffSection): boolean => {
    // 新建 .cursor 路由 stub：内容天然只是指回 SSOT，没有行为约束
    if (CURSOR_STUB.test(section.path)) return section.created;
    // AGENTS.md：只认索引表行，且全文件合计只能一行（见下面的计数）
    if (AGENTS_FILE.test(section.path)) {
      return section.lines.every((line) => line.sign === " " || line.text.trim().length === 0 || INDEX_ROW.test(line.text));
    }
    // 技能目录里的 references / scripts 等附属文件：允许改，但要人看一眼再落盘。
    // 脚本会被执行、参考文件会改变行为边界，自动采纳的收益远小于「悄悄改了脚本」的风险。
    if (!SKILL_FILE.test(section.path)) return false;
    // 正文与 description 同等对待：2026-11-11 用户口径「正文也可以改，也可以自动采纳」。
    // 语义字段（name / allowed-tools / disable-model-invocation）已在上面按行判过 forbidden，这里不必再拦。
    // 仍然拦的只有「新建整份技能文件」——那是造技能，不是修技能。
    return !section.created;
  };

  if (!sections.every(sectionAuto)) {
    // 说清是哪一段不够格，方便人一眼看出为什么没自动采纳
    const offender = sections.find((section) => !sectionAuto(section));
    return {
      level: "approval",
      reasons: [`需要人批：新增技能文件 / 改到 references、scripts 等附属文件（${offender?.path ?? "未知路径"}）`],
      targets,
    };
  }

  // AGENTS.md 索引表只增/删一行：多行就是结构性改动
  const agentsChanges = sections
    .filter((section) => AGENTS_FILE.test(section.path))
    .flatMap((section) => section.lines.filter((line) => line.sign !== " " && line.text.trim().length > 0));
  if (agentsChanges.length > 1) return { level: "approval", reasons: ["AGENTS.md 改动超过一行索引"], targets };
  if (agentsChanges.length === 1) return { level: "auto", reasons: ["AGENTS.md 索引表增删一行"], targets };

  const cursorOnly = sections.every((section) => CURSOR_STUB.test(section.path));
  if (cursorOnly) return { level: "auto", reasons: ["新建 .cursor 路由 stub"], targets };
  return { level: "auto", reasons: ["改技能文件（描述或正文）与 .cursor stub"], targets };
}

/** 只看级别的旧调用面（评审督导写 03-review.json 的 action 用） */
export function classifyAction(diffText: string, proposalType: string): ActionLevel {
  return classifyChange({ diffText, proposalType, skill: "" }).level;
}
