/**
 * 统一 diff 的解析与渲染（纯函数：不读盘、不拼页面、不发请求）。
 *
 * 为什么自己写而不塞进 render-run.ts：解析（行号计数、hunk 边界）是最容易出错的一段，
 * 单独一个文件才能用喂字符串的方式把 hunk 计数、`\ No newline`、`<script>` 这些边界一个个钉住。
 *
 * 三条纪律：
 * 1. **全部转义**：diff 里出现 `<` `&` `-->` 是常态，渲染前逐行 escapeHtml，绝不拼原始字符串；
 * 2. **行号靠 hunk 头推**：`@@ -1,3 +1,4 @@` 只给起点，之后的增删各自推进哪一列必须算对，
 *    算错的后果是「用户对着行号去改文件，改错行」；
 * 3. **超长先截断**：一个技能 SKILL.md 的 diff 可能上千行，一次全渲会把页面卡住；
 *    截断后由调用方给「完整 diff」下载链接（`GET /diff?runId=`）。
 */
import { escapeHtml } from "./text.ts";

/** 页面内联预览行数上限：超过就只渲前 400 行 + 下载链接 */
export const DIFF_PREVIEW_LINES = 400;

/** 一行的角色：文件头 / hunk 头 / 增 / 删 / 上下文 / 其它元信息（`diff --git`、`\ No newline`） */
export type DiffLineKind = "file" | "hunk" | "add" | "del" | "ctx" | "meta";

export interface DiffLine {
  kind: DiffLineKind;
  /** 原文（未转义，渲染时才转义） */
  text: string;
  /** 旧文件行号；增行与元信息为 null */
  oldLine: number | null;
  /** 新文件行号；删行与元信息为 null */
  newLine: number | null;
}

/** `@@ -旧起点[,旧行数] +新起点[,新行数] @@ 可选的小节标题` */
const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * 逐行解析统一 diff。
 *
 * 行号规则（与 `git diff` / `patch` 的输出一致）：
 * - `@@` 头把两个计数器重置为头里给的起点；
 * - 上下文行两边都加一；
 * - `+` 只推进新行号，`-` 只推进旧行号；
 * - hunk 之外的行（`diff --git`、`index`、`\ No newline`）不给行号。
 */
export function parseDiffLines(text: string): DiffLine[] {
  const raw = text.split(/\r?\n/);
  // 末尾换行会 split 出一个空串：它不是一个空行，丢掉它，否则行号与真实文件差一行
  if (raw.length > 0 && raw[raw.length - 1] === "") raw.pop();
  const lines: DiffLine[] = [];
  let oldCursor = 0;
  let newCursor = 0;
  let inHunk = false;
  for (const line of raw) {
    const hunk = HUNK_HEADER.exec(line);
    if (hunk) {
      oldCursor = Number(hunk[1]);
      newCursor = Number(hunk[2]);
      inHunk = true;
      lines.push({ kind: "hunk", text: line, oldLine: null, newLine: null });
      continue;
    }
    if (line.startsWith("--- ") || line.startsWith("+++ ")) {
      inHunk = false;
      lines.push({ kind: "file", text: line, oldLine: null, newLine: null });
      continue;
    }
    if (line.startsWith("\\")) {
      // "\ No newline at end of file"：不算行，也不推计数器
      lines.push({ kind: "meta", text: line, oldLine: null, newLine: null });
      continue;
    }
    if (inHunk && line.startsWith("+")) {
      lines.push({ kind: "add", text: line, oldLine: null, newLine: newCursor });
      newCursor += 1;
      continue;
    }
    if (inHunk && line.startsWith("-")) {
      lines.push({ kind: "del", text: line, oldLine: oldCursor, newLine: null });
      oldCursor += 1;
      continue;
    }
    if (inHunk) {
      // 上下文行（含以空格开头、以及被裁掉前导空格的空行）
      lines.push({ kind: "ctx", text: line, oldLine: oldCursor, newLine: newCursor });
      oldCursor += 1;
      newCursor += 1;
      continue;
    }
    lines.push({ kind: "meta", text: line, oldLine: null, newLine: null });
  }
  return lines;
}

const KIND_CLASS: Record<DiffLineKind, string> = {
  file: "dl file",
  hunk: "dl hunk",
  add: "dl add",
  del: "dl del",
  ctx: "dl ctx",
  meta: "dl meta",
};

function lineNumber(value: number | null, width: number): string {
  return value === null ? " ".repeat(width) : String(value).padStart(width, " ");
}

/** 行号列宽度：取本段最大行号的位数（截断后按可见段算，避免 5 位行号把 3 位全挤歪） */
function numberWidth(lines: readonly DiffLine[]): number {
  let widest = 1;
  for (const line of lines) {
    for (const value of [line.oldLine, line.newLine]) {
      if (value !== null) widest = Math.max(widest, String(value).length);
    }
  }
  return widest;
}

/** 渲染成 `<pre class="diff">`；每行 `<span class="ln old">` + `<span class="ln new">` + 原文 */
export function renderDiffLines(lines: readonly DiffLine[]): string {
  const width = numberWidth(lines);
  const rows = lines.map((line) => {
    const old = lineNumber(line.oldLine, width);
    const next = lineNumber(line.newLine, width);
    return `<span class="${KIND_CLASS[line.kind]}"><span class="ln old">${old}</span><span class="ln new">${next}</span><span class="tx">${escapeHtml(line.text)}</span></span>`;
  });
  return `<pre class="diff">${rows.join("\n")}</pre>`;
}

export interface DiffView {
  html: string;
  /** diff 总行数（截断前的） */
  total: number;
  /** 是否被截断（调用方据此加「完整 diff」下载链接） */
  truncated: boolean;
}

/** 解析 + 渲染 + 截断一步到位：`maxLines` 默认 400，只渲前 400 行 */
export function renderDiff(text: string, maxLines: number = DIFF_PREVIEW_LINES): DiffView {
  const lines = parseDiffLines(text);
  const shown = lines.slice(0, maxLines);
  return { html: renderDiffLines(shown), total: lines.length, truncated: lines.length > shown.length };
}
