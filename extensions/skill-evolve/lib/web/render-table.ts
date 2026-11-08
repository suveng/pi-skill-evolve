/**
 * 列表的表格与分组：五列（状态 / 时间 / 技能 / 提案 / 操作）+ 同会话多条 run 的 `<details>` 分组。
 *
 * 为什么单独一个文件：行数据怎么取（render-rows.ts）与表怎么画是两件事，
 * 表这部分自己就有三块（单行、分组、组标题摘要），挤在映射文件里会破 300 行。
 * 这里只认 `ListRow`，不认识任何具体视图的数据结构。
 */
import { sessionHref, type SessionRef } from "./run-session.ts";
import type { ListExtras } from "./list-query.ts";
import { escapeHtml, formatClock, formatIso } from "./text.ts";
import type { ListRow } from "./render-rows.ts";

/** 表格骨架：五列固定，列宽由 CSS 管；操作列右对齐，扫行时视线不用来回跳 */
const TABLE_HEAD = `<thead><tr><th class="status">状态</th><th class="time">时间</th><th class="skill">技能</th><th class="delta">提案</th><th class="ops">操作</th></tr></thead>`;

/** 会话小字：单条会话的 run 不进组，所以会话只在这种行的状态格里出现一次 */
function sessionLine(session: SessionRef): string {
  // 老 run.json 可能没有 sessionId：写「会话 —」而不是凭空造一个空链接（点进去只会 404）
  if (session.sessionId === null) return `<span class="sk-sess">会话 —</span>`;
  const href = sessionHref(session);
  const text = escapeHtml(`会话 ${session.sessionId.slice(0, 8)}`);
  const link = href === null ? text : `<a class="sess" href="${escapeHtml(href)}" title="${escapeHtml(session.sessionId)}">${text}</a>`;
  return `<span class="sk-sess">${link}</span>`;
}

function rowHtml(row: ListRow, standalone: boolean, now: number): string {
  const time = row.at === null ? "—" : formatClock(row.at, now);
  const skill = row.skill.length === 0 ? `<span class="off">—</span>` : `<code>${escapeHtml(row.skill)}</code>`;
  const delta =
    row.delta === null ? `<span class="off">—</span>` : `+${row.delta.added} / -${row.delta.removed}`;
  const at = row.at === null ? "" : ` title="${escapeHtml(formatIso(row.at))}"`;
  const badge = `<span class="badge ${row.badge.tone}" title="${escapeHtml(row.badge.title)}">${escapeHtml(row.badge.text)}</span>`;
  return `<tr>
<td class="status">${badge}${standalone ? sessionLine(row.session) : ""}</td>
<td class="time"${at}>${time}</td>
<td class="skill">${skill}</td>
<td class="delta">${delta}</td>
<td class="ops">${row.ops}</td>
</tr>`;
}

/** 一张表：表头固定五列，列宽与省略号由 CSS 管 */
function table(rows: readonly ListRow[], now: number, standalone: boolean): string {
  return `<table class="rows">
${TABLE_HEAD}
<tbody>
${rows.map((row) => rowHtml(row, standalone, now)).join("\n")}
</tbody>
</table>`;
}

/** 一个渲染块：连续的单条 run 合成一张表；同一会话的多条 run 各成一组 */
export type RowBlock =
  | { kind: "rows"; rows: ListRow[] }
  | { kind: "group"; session: SessionRef; rows: ListRow[] };

/**
 * 按会话分组：**只有同一 sessionId 出现两次以上才进组**。
 * 单条会话的 run 包进 `<details>` 只会多一次点击（组里就一行），所以直接平铺。
 * 组出现在它第一条成员的位置，成员内部按时间倒序。
 */
export function groupRows(rows: readonly ListRow[]): RowBlock[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const id = row.session.sessionId;
    if (id !== null) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const emitted = new Set<string>();
  const blocks: RowBlock[] = [];
  for (const row of rows) {
    const id = row.session.sessionId;
    if (id !== null && (counts.get(id) ?? 0) > 1) {
      if (emitted.has(id)) continue;
      emitted.add(id);
      const members = rows
        .filter((item) => item.session.sessionId === id)
        .sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
      blocks.push({ kind: "group", session: row.session, rows: members });
      continue;
    }
    const last = blocks.at(-1);
    if (last !== undefined && last.kind === "rows") last.rows.push(row);
    else blocks.push({ kind: "rows", rows: [row] });
  }
  return blocks;
}

/**
 * 组标题一行：`会话 01a1b90f · 9 条 · 最近 19:35 · 1 条需要处理`。
 * 「最近」用组内最新那条的时间；「需要处理」为 0 时写「无待办」—— 组默认展开，标题就是这一组的摘要。
 */
function groupSummary(block: { session: SessionRef; rows: ListRow[] }, now: number): string {
  const latest = block.rows.reduce<number | null>((acc, row) => {
    if (row.at === null) return acc;
    return acc === null ? row.at : Math.max(acc, row.at);
  }, null);
  const parts = [`${block.rows.length} 条`];
  if (latest !== null) parts.push(`最近 ${formatClock(latest, now)}`);
  const todo = block.rows.filter((row) => row.needsAction).length;
  parts.push(todo > 0 ? `${todo} 条需要处理` : "无待办");
  const id = block.session.sessionId ?? "—";
  const href = sessionHref(block.session);
  const label =
    href === null
      ? escapeHtml(`会话 ${id.slice(0, 8)}`)
      : `<a class="sess" href="${escapeHtml(href)}" title="${escapeHtml(id)}">${escapeHtml(`会话 ${id.slice(0, 8)}`)}</a>`;
  return `${label} · ${parts.join(" · ")}`;
}

/**
 * 列表正文：块与块之间留空，组默认展开（`open`），由 URL 里的 `open=none` 决定要不要收起来。
 * 收起状态只能靠 URL 记住 —— 面板零 JS，`<details>` 自己的状态刷新就没了。
 */
export function renderRows(rows: readonly ListRow[], extras: ListExtras, now: number): string {
  const blocks = groupRows(rows);
  const open = extras.open === "none" ? "" : " open";
  return blocks
    .map((block) => {
      if (block.kind === "rows") return table(block.rows, now, true);
      return `<details class="grp"${open}>
<summary>${groupSummary(block, now)}</summary>
${table(block.rows, now, false)}
</details>`;
    })
    .join("\n");
}
