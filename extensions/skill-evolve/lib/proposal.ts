/**
 * 提案产物的解析与校验（设计稿 九、十）：M3 只做「生成 + 校验」，不评审、不写 `.pi/skills`。
 *
 * 复盘子进程把提案写在 `runs/<runId>/` 下：
 *   - 改现有技能：`02-proposal.json`（元信息）+ `02-proposal.diff`（unified diff，不是整篇）
 *   - 新建技能：`02-proposal.json` + `candidate/<名>/SKILL.md`
 * 这里只做纯解析（diff / frontmatter）与读盘一层，方便 `node --test` 直接跑。
 */
import * as fs from "node:fs";
import * as path from "node:path";

export const PROPOSAL_TYPES = ["improve", "create", "merge", "prune"] as const;
export type ProposalType = (typeof PROPOSAL_TYPES)[number];

/** 增删行合计超过它不拒绝生成，但标记转人工：一次改 40 行以上的技能文案没人能审 */
export const MAX_DIFF_LINES = 40;
/** 提案只许动技能目录，别的路径一律 bad_path */
export const SKILL_PATH_PREFIX = ".pi/skills/";

export type ProposalStatus = "ok" | "missing" | "too_large" | "bad_path" | "invalid_candidate";

export interface DiffFile {
  path: string;
  hunks: number;
}

export interface DiffParseResult {
  ok: boolean;
  reason?: "empty" | "bad_path" | "malformed";
  detail?: string;
  files: DiffFile[];
  added: number;
  removed: number;
}

/** 去掉 git 的 `a/` `b/` 前缀与行尾 tab 时间戳；`/dev/null` 返回 null（新建/删除文件时会出现） */
function normalizeDiffPath(raw: string): string | null {
  const head = raw.split("\t")[0].trim();
  if (head === "/dev/null" || head.length === 0) return null;
  return head.replace(/^[ab]\//, "");
}

function isSkillPath(filePath: string): boolean {
  return filePath.startsWith(SKILL_PATH_PREFIX);
}

/**
 * 解析 unified diff，只统计增删行与文件路径，不重建内容。
 * 注意：hunk 里以 `--- ` 开头的内容行会被当成文件头 —— 技能文档里出现这种行的概率可忽略，
 * 真要写这种内容就得用转义形式，属于可接受的解析边界。
 */
export function parseUnifiedDiff(text: string): DiffParseResult {
  const files: DiffFile[] = [];
  let added = 0;
  let removed = 0;
  let badPath: string | null = null;
  let current: DiffFile | null = null;

  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("--- ")) {
      const oldPath = normalizeDiffPath(line.slice(4));
      if (oldPath !== null && !isSkillPath(oldPath)) badPath ??= oldPath;
      continue;
    }
    if (line.startsWith("+++ ")) {
      const newPath = normalizeDiffPath(line.slice(4));
      if (newPath === null) {
        current = null;
        continue;
      }
      if (!isSkillPath(newPath)) {
        badPath ??= newPath;
        current = null;
        continue;
      }
      current = { path: newPath, hunks: 0 };
      files.push(current);
      continue;
    }
    if (line.startsWith("@@")) {
      if (current) current.hunks += 1;
      continue;
    }
    // `diff --git` / `index abc..def` 之类的头对统计无意义，直接跳过
    if (line.startsWith("diff ") || line.startsWith("index ")) continue;
    if (!current) continue;
    if (line.startsWith("+")) added += 1;
    else if (line.startsWith("-")) removed += 1;
  }

  if (badPath !== null) return { ok: false, reason: "bad_path", detail: badPath, files, added, removed };
  if (files.length === 0) return { ok: false, reason: "empty", detail: "没有可用文件头", files, added, removed };
  return { ok: true, files, added, removed };
}

export interface CandidateCheck {
  ok: boolean;
  detail: string;
  name?: string;
}

/** 读 frontmatter 的 name / description：只认 `key: value` 单行形式（技能 frontmatter 就这两种） */
export function readFrontmatter(text: string): Record<string, string> {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return {};
  const fields: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    if (line.trim() === "---") break;
    const match = /^([A-Za-z_-]+):\s*(.*)$/.exec(line);
    if (!match) continue;
    fields[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
  }
  return fields;
}

export function validateCandidate(dir: string): CandidateCheck {
  let text: string;
  try {
    text = fs.readFileSync(path.join(dir, "SKILL.md"), "utf8");
  } catch {
    return { ok: false, detail: `缺 SKILL.md：${dir}` };
  }
  const fields = readFrontmatter(text);
  const name = fields.name ?? "";
  if (name.length === 0) return { ok: false, detail: "frontmatter 缺 name" };
  if ((fields.description ?? "").length === 0) return { ok: false, detail: "frontmatter 缺 description" };
  if (name.length > 20) return { ok: false, detail: `name 超过 20 字：${name}` };
  if (!/^[a-z0-9-]+$/.test(name)) return { ok: false, detail: `name 不合规（只许小写字母/数字/短横线）：${name}` };
  const dirName = path.basename(dir);
  if (name !== dirName) return { ok: false, detail: `name(${name}) 与目录名(${dirName}) 不一致` };
  return { ok: true, detail: `${name} 校验通过`, name };
}

export interface ProposalCheck {
  status: ProposalStatus;
  detail: string;
  type?: ProposalType;
  skill?: string;
  added?: number;
  removed?: number;
  /** 相对 run 目录的产物文件名（diff 或 candidate 的 SKILL.md） */
  file?: string;
}

function readProposalJson(runDir: string): { json: Record<string, unknown> | null; error?: string } {
  try {
    const raw = fs.readFileSync(path.join(runDir, "02-proposal.json"), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return { json: null, error: "02-proposal.json 不是对象" };
    return { json: parsed as Record<string, unknown> };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { json: null, error: code === "ENOENT" ? "没有 02-proposal.json" : `02-proposal.json 解析失败：${String(error)}` };
  }
}

/** 校验一个 run 目录的提案：只有 status==="ok" 才允许后续（人工）评审 */
export function validateProposal(runDir: string): ProposalCheck {
  const { json, error } = readProposalJson(runDir);
  if (!json) return { status: "missing", detail: error ?? "没有提案" };

  const type = String(json.type ?? "");
  const skill = String(json.skill ?? "");
  if (!(PROPOSAL_TYPES as readonly string[]).includes(type)) {
    return { status: "missing", detail: `02-proposal.json 的 type 非法：${type || "（空）"}` };
  }
  if (skill.length === 0) return { status: "missing", detail: "02-proposal.json 缺 skill" };
  const typed = type as ProposalType;

  if (typed === "create") {
    const rel = path.join("candidate", skill, "SKILL.md");
    const check = validateCandidate(path.join(runDir, "candidate", skill));
    return check.ok
      ? { status: "ok", detail: check.detail, type: typed, skill, file: rel, added: 0, removed: 0 }
      : { status: "invalid_candidate", detail: check.detail, type: typed, skill, file: rel };
  }

  const diffRel = typeof json.diffFile === "string" && json.diffFile.length > 0 ? json.diffFile : "02-proposal.diff";
  let text: string;
  try {
    text = fs.readFileSync(path.resolve(runDir, diffRel), "utf8");
  } catch {
    return { status: "missing", detail: `缺 diff：${diffRel}`, type: typed, skill };
  }
  const parsed = parseUnifiedDiff(text);
  if (!parsed.ok) {
    return {
      status: parsed.reason === "bad_path" ? "bad_path" : "missing",
      detail: parsed.reason === "bad_path" ? `diff 改了技能目录外的路径：${parsed.detail}` : (parsed.detail ?? "diff 为空"),
      type: typed,
      skill,
      added: parsed.added,
      removed: parsed.removed,
      file: diffRel,
    };
  }
  const total = parsed.added + parsed.removed;
  const base = { type: typed, skill, added: parsed.added, removed: parsed.removed, file: diffRel };
  if (total > MAX_DIFF_LINES) {
    return { status: "too_large", detail: `增删 ${total} 行 > ${MAX_DIFF_LINES}，转人工`, ...base };
  }
  return { status: "ok", detail: `增删 ${total} 行，路径 ${parsed.files.map((item) => item.path).join("、")}`, ...base };
}

export interface ProposalSummary {
  type: string;
  skill: string;
  status: ProposalStatus;
  added: number;
  removed: number;
  file: string | null;
}

/** 报告里显示提案摘要：没有 `02-proposal.json` 返回 undefined（这一轮本来就没提案，不是错） */
export function readProposalSummary(runDir: string): ProposalSummary | undefined {
  const { json } = readProposalJson(runDir);
  if (!json) return undefined;
  const check = validateProposal(runDir);
  return {
    type: String(json.type ?? "?"),
    skill: check.skill ?? String(json.skill ?? "?"),
    status: check.status,
    added: check.added ?? 0,
    removed: check.removed ?? 0,
    file: check.file ?? null,
  };
}
