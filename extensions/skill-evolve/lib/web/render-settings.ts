/**
 * 配置页：把以前只能改 config.json / 敲命令的六项搬到面板上。
 *
 * 四条设计取舍：
 * 1. **一个表单一次提交**：六项是一整份配置，分两个表单保存会出现「改了模型、忘了点数值那个保存」，
 *    也让每个表单各自带一份 csrf（少带一个就会被 403）；
 * 2. **范围写在字段旁边**：校验失败会整份拒绝，所以必须让人填之前就看到「允许什么」，
 *    而不是提交后才从横幅里读错误；
 * 3. **端口单独提示**：改端口不会当场生效（面板已经监听在旧端口上），这句话必须写在页面上，
 *    否则用户会以为「保存了但没反应」；
 * 4. 只读实例（没注入写回调）只显示当前值，不渲染表单 —— 给一个点了必然失败的按钮比不给更糟。
 */
import { escapeHtml } from "./text.ts";
import { SETTINGS_BOUNDS, type SettingsValues } from "../settings.ts";
import { INHERIT } from "../model-config.ts";
import { shellPage } from "./shell.ts";
import type { WebState } from "./data.ts";

export interface SettingsPageOptions {
  /** 表单 CSRF token；只读实例不传，表单就不渲染 */
  csrf?: string;
  /** 是否可写：只读实例只显示当前值 */
  canWrite?: boolean;
  /** 顶部横幅（保存成功 / 校验失败） */
  notice?: { kind: "msg" | "err"; text: string } | null;
}

const FOOT = `本机面板 · 只绑 127.0.0.1 · 无鉴权 · 机器可读副本见 <a href="/api/state">/api/state</a>。`;

/** 毫秒 → 「90 秒」「20 分钟」这种人话；范围提示用它，免得读到 1200000 要数零 */
function humanMs(ms: number): string {
  if (ms % 60_000 === 0) return `${ms / 60_000} 分钟`;
  if (ms % 1_000 === 0) return `${ms / 1_000} 秒`;
  return `${ms} 毫秒`;
}

/** 一行：字段名 + 输入框 + 允许范围 + 影响说明 */
function numRow(
  key: keyof SettingsValues,
  label: string,
  value: number,
  range: string,
  effect: string,
): string {
  return `<tr>
<td>${escapeHtml(label)}</td>
<td><input name="${key}" value="${value}" size="14" inputmode="numeric"></td>
<td>${escapeHtml(range)}</td>
<td>${escapeHtml(effect)}</td>
</tr>`;
}

function formSection(values: SettingsValues, csrf: string): string {
  const idle = SETTINGS_BOUNDS.idleMs;
  const runtime = SETTINGS_BOUNDS.maxRuntimeMs;
  const cap = SETTINGS_BOUNDS.perSessionCap;
  const port = SETTINGS_BOUNDS.port;
  const window = SETTINGS_BOUNDS.metricsWindowDays;
  const keep = SETTINGS_BOUNDS.backupRetentionDays;
  return `<form method="post" action="/config">
<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
<input type="hidden" name="view" value="settings">
<table class="rows">
<tbody>
<tr>
<td>提案模型</td>
<td><input name="propose" value="${escapeHtml(values.propose)}" size="34" spellcheck="false"></td>
<td>provider/id</td>
<td>出提案用哪个模型；${INHERIT} = 跟随主会话</td>
</tr>
<tr>
<td>评审模型</td>
<td><input name="review" value="${escapeHtml(values.review)}" size="34" spellcheck="false"></td>
<td>provider/id</td>
<td>评审用哪个模型；与提案用同一个模型时独立性有限</td>
</tr>
${numRow("idleMs", "空闲去抖（毫秒）", values.idleMs, `${idle.min}–${idle.max}（${humanMs(idle.min)}–${humanMs(idle.max)}）`, "会话空闲这么久才派发复盘；越小越灵敏，但每回合都可能触发")}
${numRow("maxRuntimeMs", "单轮上限（毫秒）", values.maxRuntimeMs, `${runtime.min}–${runtime.max}（${humanMs(runtime.min)}–${humanMs(runtime.max)}）`, "复盘子进程超过它就判卡死（stale），可被清理")}
${numRow("perSessionCap", "单会话次数", values.perSessionCap, `${cap.min}–${cap.max}`, "同一个会话最多自动复盘几次，防止一轮对话把 token 刷爆")}
${numRow("metricsWindowDays", "趋势窗口（天）", values.metricsWindowDays, `${window.min}–${window.max}`, "report --week 的指标回看范围；28 天 = 四个整周")}
${numRow("backupRetentionDays", "备份保留（天）", values.backupRetentionDays, `${keep.min}–${keep.max}`, "采纳前备份保留多久；超期在会话起点删除，回滚窗口靠 git 兜底")}
${numRow("port", "面板端口", values.port, `${port.min}–${port.max}`, "改完不会自动迁移：重启面板后新端口才生效")}
</tbody>
</table>
<button type="submit">保存</button>
</form>`;
}

/** 只读视图：同一份八项，用表格把「现在是什么」摊开 */
function readonlyTable(values: SettingsValues): string {
  return `<table class="rows">
<tbody>
<tr><td>提案模型</td><td><code>${escapeHtml(values.propose)}</code></td></tr>
<tr><td>评审模型</td><td><code>${escapeHtml(values.review)}</code></td></tr>
<tr><td>空闲去抖</td><td>${values.idleMs} 毫秒（${escapeHtml(humanMs(values.idleMs))}）</td></tr>
<tr><td>单轮上限</td><td>${values.maxRuntimeMs} 毫秒（${escapeHtml(humanMs(values.maxRuntimeMs))}）</td></tr>
<tr><td>单会话次数</td><td>${values.perSessionCap}</td></tr>
<tr><td>趋势窗口</td><td>${values.metricsWindowDays} 天</td></tr>
<tr><td>备份保留</td><td>${values.backupRetentionDays} 天</td></tr>
<tr><td>面板端口</td><td>${values.port}</td></tr>
</tbody>
</table>`;
}

export function renderSettingsPage(
  values: SettingsValues,
  state: WebState,
  options: SettingsPageOptions = {},
): string {
  const csrf = options.csrf ?? "";
  const writable = options.canWrite === true && csrf.length > 0;
  const notice = options.notice
    ? `<p class="notice${options.notice.kind === "err" ? " err" : ""}">${escapeHtml(options.notice.text)}</p>\n`
    : "";
  const intro = `<p class="hint">这些值写在 <code>.pi/evolution/config.json</code>；保存后立即生效，只有端口例外（面板已监听在旧端口上，改完要重启面板）。</p>`;
  const body = writable
    ? `${intro}\n${formSection(values, csrf)}\n<p class="hint">保存会一次性提交六项：任何一项不合法就整份拒绝，不会只写入一半。</p>`
    : `${intro}\n<p class="warn">本实例只读：没有注入写回调，页面上不能保存。改配置请用 <code>/skill-evolve config</code>。</p>\n${readonlyTable(values)}`;
  return shellPage({
    state,
    title: "设置",
    active: "settings",
    top: notice,
    body: `<main>\n${body}\n</main>`,
    foot: FOOT,
  });
}
