/**
 * 技能管理页（`?view=skills`）与技能详情页（`?view=skill&name=...`）的渲染。
 *
 * 一行一个技能，字段顺序按「先看规模、再看效果、最后看该不该动手」：
 * 技能名 · 曝光/加载/加载率 · 最近一次相关 run · 三个状态标签。
 *
 * 空态分两种，绝不含糊成一句「暂无数据」：
 * - 采集关着 → 「没有遥测数据（采集关着）」，并指路去开（页面顶部控制条就是开关）；
 * - 采集开着但窗口内没事件 → 「最近 N 天没有遥测事件」，说明是没跑过还是窗口太窄。
 */
import type { WebState } from "./data.ts";
import type { WebControls } from "./activity.ts";
import { renderControlBar } from "./render-controls.ts";
import type { SkillDetail, SkillRow, SkillsView } from "./skills.ts";
import { SKILL_DAYS } from "./skills.ts";
import { shellPage } from "./shell.ts";
import { escapeHtml, formatStamp, shortRunId } from "./text.ts";

/** 加载率：没曝光时写「—」而不是 0%（0% 会被当成「一百次曝光一次没加载」） */
export function rateText(rate: number | null): string {
  return rate === null ? "—" : `${(rate * 100).toFixed(0)}%`;
}

/** 采集关着时曝光/加载写「—」：0 会被读成「这技能没人用」，实际是「没采到」 */
function countText(unknown: boolean, value: number): string {
  return unknown ? "—" : String(value);
}

/** 三个状态标签各自一色，且**不合并**：每个标签对应一个不同的处置动作 */
export function skillTags(row: SkillRow): string {
  const tags: string[] = [];
  if (row.hasPendingProposal) tags.push(`<span class="tag warn">有待批提案</span>`);
  if (row.hasBaseline) tags.push(`<span class="tag fail">存量违规</span>`);
  if (row.missingCursorStub) tags.push(`<span class="tag">缺 .cursor stub</span>`);
  return tags.length > 0 ? tags.join(" ") : `<span class="hint">—</span>`;
}

function skillHref(name: string, days: number): string {
  return `/?view=skill&name=${encodeURIComponent(name)}&days=${days}`;
}

function runHref(runId: string): string {
  return `/?view=run&runId=${encodeURIComponent(runId)}`;
}

/** 窗口切换：只给白名单里的三个值，当前那个不再是链接 */
function dayLinks(current: number): string {
  const parts = SKILL_DAYS.map((days) =>
    days === current
      ? `<span class="on">近 ${days} 天</span>`
      : `<a href="${escapeHtml(`/?view=skills&days=${days}`)}">近 ${days} 天</a>`,
  );
  return `<p class="days">统计窗口：${parts.join(" · ")}</p>`;
}

/** 遥测空态的两种说法（采集关着 / 开着但没数据） */
function telemetryNote(view: SkillsView): string {
  if (view.events > 0) return "";
  if (!view.telemetryOn) {
    return `<p class="warn">没有遥测数据（采集关着）：曝光与加载都是 0 是因为没采集，不是技能没被用。
用顶部控制条打开采集后会开始记录。</p>`;
  }
  return `<p class="hint">最近 ${view.days} 天没有遥测事件：采集开着，但这段时间没有会话记录。</p>`;
}

export interface RenderSkillsOptions {
  /** 从哪一页链进来的（详情页的返回链接） */
  back?: { view: string; label: string };
}

/** 列表页要能就地开关采集（曝光/加载就是它采的），所以把控制条数据一起传进来 */
export interface SkillsPageControls {
  csrf?: string;
  canWrite?: boolean;
  controls?: WebControls | null;
  now?: number;
}

export function renderSkillsPage(view: SkillsView, state: WebState, options: SkillsPageControls = {}): string {
  const top = options.controls
    ? `${renderControlBar(options.controls, {
        view: "skills",
        now: options.now ?? Date.now(),
        csrf: options.csrf,
        canWrite: options.canWrite,
      })}\n`
    : "";
  const head = `<thead><tr><th>技能</th><th>曝光</th><th>加载</th><th>加载率</th><th>最近一次相关 run</th><th>状态</th></tr></thead>`;
  // 采集关着（且确实一个事件都没有）时曝光/加载是「不知道」而不是 0：写 0 会被读成「这技能没人用」
  const unknown = !view.telemetryOn && view.events === 0;
  const rows = view.rows.map((row) => {
    const last =
      row.lastRunId === null
        ? `<span class="hint">—</span>`
        : `<a href="${escapeHtml(runHref(row.lastRunId))}">${escapeHtml(shortRunId(row.lastRunId))}</a> <span class="hint">${escapeHtml(formatStamp(row.lastRunAt))}</span>`;
    return `<tr><td><a href="${escapeHtml(skillHref(row.name, view.days))}">${escapeHtml(row.name)}</a></td><td>${countText(unknown, row.exposed)}</td><td>${countText(unknown, row.loaded)}</td><td>${rateText(row.rate)}</td><td>${last}</td><td>${skillTags(row)}</td></tr>`;
  });
  const body =
    view.rows.length === 0
      ? `<p class="empty">.pi/skills 下没有技能目录：先确认工作区根路径对不对（面板从 .pi/evolution 往上两层推断）。</p>`
      : `<table class="tbl">
${head}
<tbody>
${rows.join("\n")}
</tbody>
</table>`;
  return shellPage({
    state,
    title: "技能管理",
    active: "skills",
    top,
    body: `<main>
<h2>技能（${view.rows.length} 个，窗口 ${view.days} 天）</h2>
${dayLinks(view.days)}
${telemetryNote(view)}
${body}
</main>`,
    foot: `只读：曝光 = 含该技能的 advertised 轮数（同一轮重复算一次，disabled 不计），加载 = loaded 事件数。
遥测原文在 <code>.pi/evolution/telemetry/</code>。`,
  });
}

/** 技能详情：统计一行 + 历史提案表（每个 run 一行，带 verdict 与 diff 链接） */
export function renderSkillPage(detail: SkillDetail, state: WebState, options: RenderSkillsOptions = {}): string {
  const back = options.back ?? { view: "skills", label: "技能管理" };
  const row = detail.row;
  const unknown = !detail.telemetryOn && detail.events === 0;
  const stats =
    row === null
      ? `<p class="hint">${escapeHtml(detail.name)} 不在 .pi/skills 目录里（可能已改名或删除），下面只列历史提案。</p>`
      : `<p class="kv-line">
曝光 <b>${countText(unknown, row.exposed)}</b> · 加载 <b>${countText(unknown, row.loaded)}</b> · 加载率 <b>${rateText(row.rate)}</b> · 窗口 ${detail.days} 天
</p>
<p class="kv-line">状态：${skillTags(row)}</p>`;
  // 第一列表头点明「点进去就是 diff 视图」：用户要的 diff 就藏在这个 runId 后面
  const head = `<thead><tr><th>run（点进看 diff）</th><th>状态</th><th>时间</th><th>提案</th><th>verdict</th><th>action</th></tr></thead>`;
  const rows = detail.runs.map((run) => {
    const delta = `${run.type} +${run.added}/-${run.removed}`;
    return `<tr><td><a href="${escapeHtml(runHref(run.runId))}">${escapeHtml(shortRunId(run.runId))}</a></td><td>${escapeHtml(run.status)}</td><td>${escapeHtml(formatStamp(run.at))}</td><td>${escapeHtml(delta)}</td><td>${escapeHtml(run.verdict)}</td><td>${escapeHtml(run.action)}</td></tr>`;
  });
  const table =
    detail.runs.length === 0
      ? `<p class="empty">还没有针对 ${escapeHtml(detail.name)} 的提案：runs/ 里没有 skill=${escapeHtml(detail.name)} 的 02-proposal.json。</p>`
      : `<table class="tbl">
${head}
<tbody>
${rows.join("\n")}
</tbody>
</table>`;
  return shellPage({
    state,
    title: `技能 ${detail.name}`,
    active: "skills",
    body: `<main>
<p class="hint"><a href="/?view=${escapeHtml(back.view)}">← 回${escapeHtml(back.label)}</a></p>
<h2>${escapeHtml(detail.name)}</h2>
${stats}
<h2>历史提案</h2>
${table}
</main>`,
    foot: `只读：历史提案来自 runs/*/02-proposal.json，点 run 进详情页看 diff 与评审证据。`,
  });
}

