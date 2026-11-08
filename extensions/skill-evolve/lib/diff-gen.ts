/**
 * diff 的两个小工具（不是通用 diff 实现）：
 * ① `splitDiffByFile`：把多文件 diff 按文件切开，逐文件应用到各自的原文；
 * ② `renderUnifiedDiff`：把「本次真实写盘前/后内容」渲染成 `05-applied.diff`（整文件单 hunk）。
 *
 * 为什么要自己渲染 05：设计要求它是**实际落盘的 diff**，不是提案里的那份 ——
 * 提案可能被闸3拦下或回滚，落盘 diff 必须来自真实内容。
 */

export interface DiffChunk {
  /** null = 删除文件（`+++ /dev/null`） */
  path: string | null;
  chunk: string;
}

export function splitDiffByFile(text: string): DiffChunk[] {
  const lines = text.split(/\r?\n/);
  const chunks: DiffChunk[] = [];
  let head: string[] = [];
  let body: string[] = [];
  let path: string | null = null;
  let inHunk = false;

  const flush = (): void => {
    if (path !== null || body.length > 0) chunks.push({ path, chunk: [...head, ...body].join("\n") });
    head = [];
    body = [];
    path = null;
    inHunk = false;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    // 文件头成对出现：`--- a/x` 紧跟 `+++ b/x` —— 见到这样的 `---` 就收掉上一段
    if (line.startsWith("--- ") && lines[index + 1]?.startsWith("+++ ")) {
      flush();
      head.push(line);
      continue;
    }
    if (line.startsWith("+++ ")) {
      const raw = line.slice(4).split("\t")[0].trim();
      path = raw === "/dev/null" || raw.length === 0 ? null : raw.replace(/^[ab]\//, "");
      head.push(line);
      continue;
    }
    if (line.startsWith("@@")) {
      inHunk = true;
      body.push(line);
      continue;
    }
    if (!inHunk && (line.startsWith("diff ") || line.startsWith("index ") || line.startsWith("new file mode") || line.startsWith("deleted file mode"))) {
      head.push(line);
      continue;
    }
    body.push(line);
  }
  flush();
  return chunks;
}

function toLines(text: string | null): string[] {
  if (text === null) return [];
  const body = text.endsWith("\n") ? text.slice(0, -1) : text;
  return body.length === 0 ? [] : body.split("\n");
}

/** 整文件单 hunk 的 diff：只用于留证，不参与再应用（应用走 diff-apply.ts） */
export function renderUnifiedDiff(relPath: string, before: string | null, after: string): string {
  const oldLines = toLines(before);
  const newLines = toLines(after);
  const header = [
    `--- ${before === null ? "/dev/null" : `a/${relPath}`}`,
    `+++ b/${relPath}`,
    `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
  ];
  const body = [...oldLines.map((line) => `-${line}`), ...newLines.map((line) => `+${line}`)];
  return `${[...header, ...body].join("\n")}\n`;
}
