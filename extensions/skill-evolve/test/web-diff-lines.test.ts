/**
 * 统一 diff 的解析与渲染：行号推进、着色 class、转义、400 行截断。
 * 全部是字符串进出，不读盘、不起子进程、不占端口。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  DIFF_PREVIEW_LINES,
  parseDiffLines,
  renderDiff,
  renderDiffLines,
} from "../lib/web/diff-lines.ts";

/** 一份最小的单 hunk diff：文件头 2 行 + hunk 头 1 行 + 上下文/删/增/增/上下文 */
const SAMPLE = [
  "--- a/.pi/skills/demo/SKILL.md",
  "+++ b/.pi/skills/demo/SKILL.md",
  "@@ -1,3 +1,4 @@",
  " ---",
  "-old line",
  "+new line",
  "+another new line",
  " tail",
  "",
].join("\n");

test("parseDiffLines：文件头 / hunk / 增 / 删 / 上下文各自归类", () => {
  const lines = parseDiffLines(SAMPLE);
  assert.deepEqual(
    lines.map((line) => line.kind),
    ["file", "file", "hunk", "ctx", "del", "add", "add", "ctx"],
  );
  assert.deepEqual(
    lines.slice(0, 3).map((line) => [line.oldLine, line.newLine]),
    [
      [null, null],
      [null, null],
      [null, null],
    ],
    "文件头与 hunk 头不给行号",
  );
});

test("parseDiffLines：@@ -1,3 +1,4 @@ 之后删行只推旧号、增行只推新号", () => {
  const lines = parseDiffLines(SAMPLE);
  assert.deepEqual(
    lines.slice(3).map((line) => [line.text, line.oldLine, line.newLine]),
    [
      [" ---", 1, 1],
      ["-old line", 2, null],
      ["+new line", null, 2],
      ["+another new line", null, 3],
      [" tail", 3, 4],
    ],
    "算错这里，用户就会对着行号去改文件、改错行",
  );
});

test("parseDiffLines：多个 hunk 各自从自己的起点重新计数", () => {
  const text = [
    "--- a/x",
    "+++ b/x",
    "@@ -1,1 +1,1 @@",
    "-a",
    "+b",
    "@@ -10,1 +20,2 @@",
    " keep",
    "+added",
  ].join("\n");
  const lines = parseDiffLines(text);
  const second = lines.slice(lines.findIndex((line) => line.text.startsWith("@@ -10")));
  assert.deepEqual(
    second.map((line) => [line.text, line.oldLine, line.newLine]),
    [
      ["@@ -10,1 +20,2 @@", null, null],
      [" keep", 10, 20],
      ["+added", null, 21],
    ],
  );
});

test("parseDiffLines：hunk 外的行（diff --git / index）与 \\ No newline 都不占行号", () => {
  const text = [
    "diff --git a/x b/x",
    "index 123..456 100644",
    "--- a/x",
    "+++ b/x",
    "@@ -1,1 +1,1 @@",
    "-a",
    "\\ No newline at end of file",
    "+b",
  ].join("\n");
  const lines = parseDiffLines(text);
  assert.deepEqual(
    lines.map((line) => [line.kind, line.oldLine, line.newLine]),
    [
      ["meta", null, null],
      ["meta", null, null],
      ["file", null, null],
      ["file", null, null],
      ["hunk", null, null],
      ["del", 1, null],
      ["meta", null, null],
      ["add", null, 1],
    ],
    "「\\ No newline」不是一行内容，推进它会把它后面的行号整体错一位",
  );
});

test("parseDiffLines：末尾换行不额外造出一个空行", () => {
  assert.equal(parseDiffLines(SAMPLE).length, 8);
  assert.equal(parseDiffLines("one\n").length, 1, "只有一个换行不是两行");
  assert.equal(parseDiffLines("one\n\n").length, 2, "真正的空行仍然保留");
});

test("renderDiffLines：+ / - / @@ 三类 class 与两列行号都渲染出来", () => {
  const html = renderDiffLines(parseDiffLines(SAMPLE));
  assert.match(html, /^<pre class="diff">/);
  assert.match(html, /<span class="dl file"><span class="ln old"> {1}<\/span><span class="ln new"> {1}<\/span><span class="tx">--- a\/\.pi\/skills\/demo\/SKILL\.md<\/span><\/span>/);
  assert.match(html, /<span class="dl hunk">/);
  assert.match(html, /<span class="dl add"><span class="ln old"> {1}<\/span><span class="ln new">2<\/span>/);
  assert.match(html, /<span class="dl del"><span class="ln old">2<\/span><span class="ln new"> {1}<\/span>/);
  assert.match(html, /<span class="dl ctx"><span class="ln old">3<\/span><span class="ln new">4<\/span>/);
});

test("renderDiffLines：diff 里的 <script> 与 & 一律转义（这里最容易被当成可信内容）", () => {
  const text = [
    "--- a/x",
    "+++ b/x",
    "@@ -1,1 +1,1 @@",
    "-<b>old</b>",
    "+<script>alert('a&b')</script>",
  ].join("\n");
  const html = renderDiffLines(parseDiffLines(text));
  assert.equal(html.includes("<script>"), false, "页面里不许出现裸 <script>");
  assert.equal(html.includes("<b>old</b>"), false);
  assert.match(html, /&lt;script&gt;alert\(&#39;a&amp;b&#39;\)&lt;\/script&gt;/);
});

test("renderDiff：超过 400 行只渲前 400 行并标 truncated", () => {
  const body = Array.from({ length: 500 }, (_unused, index) => ` line ${index + 1}`);
  const text = ["--- a/x", "+++ b/x", "@@ -1,500 +1,500 @@", ...body].join("\n");
  const view = renderDiff(text);
  assert.equal(view.total, 503);
  assert.equal(view.truncated, true);
  assert.equal(view.html.match(/class="dl /g)?.length, DIFF_PREVIEW_LINES);
  assert.equal(view.html.includes("line 401"), false, "第 401 行不渲染");
});

test("renderDiff：不到 400 行不截断，也不加下载提示的依据（truncated=false）", () => {
  const view = renderDiff(SAMPLE);
  assert.equal(view.total, 8);
  assert.equal(view.truncated, false);
  assert.equal(view.html.match(/class="dl /g)?.length, 8);
});
