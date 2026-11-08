/**
 * 把 unified diff 应用到「改动前的技能全文」，给评审员一份「改后全文」。
 *
 * 为什么不用 git apply：评审督导是独立 node 进程、只拿到 run 目录里的 diff 文本，
 * 不能假设工作区是干净的（更不能在这里 git 操作 — 设计稿闸0 要求改动面可核对）。
 * 这里只做最小实现：优先逐行精确匹配（忽略行尾空白），匹配不上就如实返回失败，
 * 由调用方在 prompt 里写明「全文是改动前的版本，只有 diff 可信」，绝不猜。
 */

export interface ApplyResult {
  ok: boolean;
  /** 应用成功是改后全文；失败时返回原文（调用方据此在 prompt 里说明） */
  text: string;
  /** diff 里声明的新文件路径（去掉 a/ b/ 前缀），用于回读原文 */
  file: string | null;
  reason?: string;
}

interface Hunk {
  oldStart: number;
  body: string[];
}

const HUNK_HEAD = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/;

/** 只取第一段文件头的 hunk：技能提案本来就是单文件改动 */
function parseHunks(diffText: string): { hunks: Hunk[]; path: string | null } {
  const hunks: Hunk[] = [];
  let path: string | null = null;
  let current: Hunk | null = null;
  for (const raw of diffText.split(/\r?\n/)) {
    const line = raw.replace(/\t$/, "");
    if (line.startsWith("+++ ")) {
      const head = line.slice(4).split("\t")[0].trim();
      if (head !== "/dev/null" && head.length > 0) path ??= head.replace(/^[ab]\//, "");
      continue;
    }
    const head = HUNK_HEAD.exec(line);
    if (head) {
      current = { oldStart: Number.parseInt(head[1], 10), body: [] };
      hunks.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith("\\ ")) continue; // \ No newline at end of file
    if (line.length === 0) continue; // 夹在 hunk 之间的空行
    current.body.push(line);
  }
  return { hunks, path };
}

function sameLine(a: string | undefined, b: string): boolean {
  return a !== undefined && a.replace(/\s+$/, "") === b.replace(/\s+$/, "");
}

export function applyUnifiedDiff(baseText: string, diffText: string): ApplyResult {
  const { hunks, path } = parseHunks(diffText);
  if (hunks.length === 0) return { ok: false, text: baseText, file: path, reason: "diff 里没有 hunk" };
  const lines = baseText.split("\n");
  const out: string[] = [];
  let cursor = 0;
  for (const hunk of hunks) {
    // 新建文件的 hunk 头是 `@@ -0,0 +1,N @@`：旧文件没有行，起点必须是 0 而不是 -1
    const start = hunk.oldStart === 0 ? 0 : hunk.oldStart - 1;
    if (start < cursor || start > lines.length) {
      return { ok: false, text: baseText, file: path, reason: `hunk 位置越界（第 ${hunk.oldStart} 行）` };
    }
    out.push(...lines.slice(cursor, start));
    cursor = start;
    for (const entry of hunk.body) {
      const tag = entry[0];
      const content = entry.slice(1);
      if (tag === " " || tag === "-") {
        if (!sameLine(lines[cursor], content)) {
          return { ok: false, text: baseText, file: path, reason: `第 ${cursor + 1} 行与原文件不一致：${content.trim().slice(0, 60)}` };
        }
        if (tag === " ") out.push(lines[cursor]);
        cursor += 1;
        continue;
      }
      if (tag === "+") {
        out.push(content);
        continue;
      }
      return { ok: false, text: baseText, file: path, reason: `无法识别的 diff 行：${entry.slice(0, 40)}` };
    }
  }
  out.push(...lines.slice(cursor));
  return { ok: true, text: out.join("\n"), file: path };
}
