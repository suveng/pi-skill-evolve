/**
 * Markdown-lite：会话正文里那一小撮「模型天天写、原样输出却很难看」的语法。
 *
 * 为什么只做这几个（用户 2026-11-08：「Markdown 原样输出满屏 `**加粗**`」）：
 * pi 的助手回复几乎每段都带 `**粗体**`、`` `路径` ``、`- ` 列表、``` 代码块、`[文字](url)`，
 * 直接 `<pre>` 输出等于把符号也念给人听。但面板不需要完整 Markdown 实现
 * （表格、脚注、嵌套列表一律不做），行数少、行为可预测比「支持得多」重要。
 *
 * **XSS 纪律**：先 `escapeHtml` 再替换语法，替换只插自己写的标签，用户文本永远进不了标签内部；
 * `[文字](url)` 只保留文字、整段丢弃 URL —— 否则 `[x](javascript:alert(1))` 就是一个可点的洞。
 */
import { escapeHtml } from "./text.ts";

/** 围栏代码块：开口行可带语言名（不渲染高亮，只要别把它当正文） */
const FENCE = /```[^\n]*\n([\s\S]*?)```/g;

/** 占位符用的控制字符：正文转义后不可能出现，所以不会被内容伪造 */
const SLOT = "\u0000";

/** 行内语法：先抠出代码块占位，再处理粗体 / 行内代码 / 链接（顺序不能反，否则代码块里的 `*` 会被当粗体） */
function inline(escaped: string, blocks: string[]): string {
  const withSlots = escaped.replace(FENCE, (_all, code: string) => {
    blocks.push(`<pre class="code"><code>${code.replace(/\n$/, "")}</code></pre>`);
    return `${SLOT}${blocks.length - 1}${SLOT}`;
  });
  return withSlots
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\[([^\]\n]+)\]\((?:[^()\s]|\([^()\s]*\))*\)/g, "$1");
}

/** 把段落里残留的代码块占位换回真区块（代码块夹在句子中间时不会独占一段） */
function restore(text: string, blocks: string[]): string {
  return text.replace(new RegExp(`${SLOT}(\\d+)${SLOT}`, "g"), (_all, index: string) => blocks[Number(index)] ?? "");
}

/**
 * 文字与代码块混在一段：按占位符切开，文字段各自包 `<p>`。
 * 不能直接把 `<pre>` 塞进 `<p>`（浏览器会把 `<p>` 提前闭合，后面的文字被踢出正文流）。
 */
function mixed(lines: string[], blocks: string[]): string {
  const out: string[] = [];
  let buffer: string[] = [];
  const flush = (): void => {
    const text = buffer.join("\n").trim();
    if (text.length > 0) out.push(`<p>${text.replace(/\n/g, "<br>")}</p>`);
    buffer = [];
  };
  for (const line of lines) {
    line.split(new RegExp(`${SLOT}(\\d+)${SLOT}`)).forEach((part, index) => {
      if (index % 2 === 1) {
        flush();
        out.push(blocks[Number(part)] ?? "");
      } else if (part.length > 0) {
        buffer.push(part);
      }
    });
  }
  flush();
  return out.join("\n");
}

/** 一个段落：代码块占位 / 标题 / 列表 / 普通段落（普通段落里的换行保留成 `<br>`） */
function block(text: string, blocks: string[]): string {
  const slot = new RegExp(`^${SLOT}(\\d+)${SLOT}$`).exec(text);
  if (slot !== null) return blocks[Number(slot[1])] ?? "";
  const heading = /^(#{1,2}) (.*)$/.exec(text);
  if (heading !== null) {
    const level = heading[1] === "#" ? 3 : 4;
    return `<h${level} class="md-h">${restore(heading[2], blocks)}</h${level}>`;
  }
  const lines = text.split("\n");
  if (lines.every((line) => line.startsWith("- "))) {
    return `<ul class="md-ul">${lines.map((line) => `<li>${restore(line.slice(2), blocks)}</li>`).join("")}</ul>`;
  }
  if (text.includes(SLOT)) return mixed(lines, blocks);
  return `<p>${lines.join("<br>")}</p>`;
}

/**
 * 正文 → HTML。空文本给空串（调用方据此判断「这条没有正文，别画空块」），
 * 其余按空行分段，每段单独判定类型。
 */
export function renderMarkdownLite(raw: string): string {
  if (raw.trim().length === 0) return "";
  const blocks: string[] = [];
  const text = inline(escapeHtml(raw), blocks);
  return text
    .split(/\n{2,}/)
    .map((part) => part.replace(/^\n+|\n+$/g, ""))
    .filter((part) => part.length > 0)
    .map((part) => block(part, blocks))
    .filter((part) => part.length > 0)
    .join("\n");
}
