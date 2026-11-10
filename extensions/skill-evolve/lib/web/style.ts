/**
 * 面板的全部样式：一份内联 CSS，不引外部资源（面板要离线可用，一条网络请求都不发）。
 *
 * 三块约定（改样式先看这三行，别各自发明）：
 * 1. **颜色只从 `:root` 的令牌里取**：同一个概念（蓝=要看、绿=已落地、黄=在跑、红=卡死）全站一色；
 * 2. **字号只有 12 / 13 / 14 / 20 四档，间距只用 4 / 8 / 12 / 16 / 24** —— 随手写 15px / 7px 是页面显得毛糙的根源；
 * 3. **列表行是表格、不是卡片**：一行一条，扫读靠列对齐；操作是小号链接，不是每行两个大按钮。
 */
export const STYLE = `
:root {
  color-scheme: dark;
  --bg: #0f1115; --panel: #161a21; --line: #252b36; --fg: #dfe3ea; --muted: #8b95a7;
  --blue: #3884ff; --green: #2ea043; --red: #d1435b; --yellow: #c69026;
}
* { box-sizing: border-box }
body { margin: 0; background: var(--bg); color: var(--fg);
  font: 13px/1.6 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace }
.wrap { max-width: 980px; margin: 0 auto; padding: 0 16px 24px }
a { color: var(--blue); text-decoration: none }
a:hover { text-decoration: underline }
code { font: inherit; color: #c8d3e6 }
h1 { margin: 0; font-size: 20px; font-weight: 600 }
h2 { margin: 20px 0 8px; font-size: 14px; font-weight: 600; color: #c8d3e6 }
h3, h4 { margin: 12px 0 4px; font-size: 14px; font-weight: 600; color: #c8d3e6 }
/* 顶部粘性区：标题 + 一行摘要 + tabs + 四个开关，滚动时永远看得到「现在有几条要处理」 */
.hd { position: sticky; top: 0; z-index: 10; padding: 12px 0 8px; background: var(--bg);
  border-bottom: 1px solid var(--line) }
.sum { margin: 4px 0 8px; color: var(--muted); font-size: 12px }
.sum a { color: #c8d3e6 }
.tabs { display: flex; gap: 4px; flex-wrap: wrap }
.tabs a { color: var(--muted); padding: 2px 8px; border-radius: 4px; white-space: nowrap }
.tabs a:hover { background: var(--panel); text-decoration: none }
.tabs a.active { color: #fff; background: #1c2740 }
.tabs .cnt { margin-left: 4px; padding: 0 6px; border-radius: 999px; font-size: 11px;
  background: var(--line); color: var(--fg) }
.tabs a.active .cnt { background: var(--blue); color: #fff }
/* 控制条：四个开关与「立即复盘」挤在一行，超宽就横向滚动 —— 换行会把列表挤到屏幕外 */
.ctl { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 8px 0 0 }
.ctl form { display: inline-flex; margin: 0 }
.ctl .sw { display: inline-flex; align-items: center; gap: 4px; padding: 1px 8px; border-radius: 999px;
  border: 1px solid var(--line); background: var(--panel); font-size: 12px }
.ctl .state.on { color: var(--green) }
.ctl .state.off { color: var(--muted) }
.notice { margin: 12px 0 0; padding: 8px 12px; border-left: 2px solid var(--green); background: #12221a; color: #b6e2c4 }
.notice.err { border-left-color: var(--red); background: #221316; color: #f0bdbd }
.warn { margin: 8px 0 0; padding: 4px 8px; border-left: 2px solid var(--yellow); background: #231d11; color: #e8d9a8; font-size: 12px }
/* 筛选：零 JS 的 GET 表单，选中项必须能在刷新后留住 */
.filter { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin: 12px 0; padding: 8px 12px;
  background: var(--panel); border: 1px solid var(--line); border-radius: 6px; font-size: 12px }
.filter label { color: var(--muted) }
.filter input, .filter select { font: inherit; color: var(--fg); background: var(--bg);
  border: 1px solid var(--line); border-radius: 4px; padding: 1px 6px }
button { font: inherit; color: #fff; background: var(--blue); border: 0; border-radius: 4px; padding: 2px 10px; cursor: pointer }
button:hover { filter: brightness(1.1) }
button.reject { background: #3a4453 }
button.danger { background: var(--red) }
a.btn { display: inline-block; color: var(--blue); padding: 1px 8px; border: 1px solid var(--line); border-radius: 4px }
/* 列表：真表格。一行等于一条 run，列对齐才扫得动；行尾是链接不是按钮 */
.rows { width: 100%; border-collapse: collapse; table-layout: fixed }
.rows th { padding: 4px 10px; color: var(--muted); font-size: 12px; font-weight: 600; text-align: left;
  border-bottom: 1px solid var(--line) }
.rows td { padding: 8px 10px; border-bottom: 1px solid #1b2029; white-space: nowrap; vertical-align: middle }
/* 配置页的「说明」列文字最长：单行不换行会被右边界裁掉（2026-11-10 实测 1180 宽就裁），
   所以只有它允许折行；列表页其它列仍保持单行，扫起来才不乱 */
.rows td.hint-cell { white-space: normal; word-break: break-word }
.rows tbody tr:hover { background: #1b2029 }
.rows .status { width: 112px }
/* 单条会话的 run 不进组，会话名就写在状态格里一行小字（窄屏也不隐藏） */
.rows .sk-sess { display: block; margin-top: 2px; font-size: 12px }
.rows .sk-sess a, .rows .sk-sess { color: var(--muted) }
.rows .time { width: 108px; color: var(--muted); font-size: 12px }
.rows .skill { max-width: 220px; overflow: hidden; text-overflow: ellipsis; font-size: 12px }
.rows .delta { width: 92px; color: var(--muted); font-size: 12px }
.rows .ops { text-align: right; font-size: 12px }
.rows .ops a, .rows .ops button { color: var(--blue); background: none; border: 0; padding: 0; font-size: 12px; cursor: pointer }
.rows .ops a:hover, .rows .ops button:hover { text-decoration: underline }
.rows .ops form { display: inline; margin: 0 }
.rows .ops .rid { color: var(--muted) }
/* 同一会话的多条 run 收进一个 details：抬头一行说清「哪个会话、几条、最近什么时候、几条要处理」 */
.grp { margin: 12px 0; border: 1px solid var(--line); border-radius: 6px; background: #12151b }
.grp > summary { padding: 8px 12px; color: #c8d3e6; cursor: pointer }
.grp .rows th { border-bottom: 1px solid var(--line) }
.badge { display: inline-block; padding: 1px 7px; border-radius: 999px; font-size: 12px; border: 1px solid currentColor }
.badge.gray { color: var(--muted) }
.badge.blue { color: var(--blue) }
.badge.green { color: var(--green) }
.badge.red { color: var(--red) }
.badge.yellow { color: var(--yellow) }
.badge.darkred { color: #8f2f3d }
.badge.faint { color: #5d6675 }
.empty { color: var(--muted); padding: 24px 0; text-align: center }
.empty code { color: #c8d3e6 }
.next { color: var(--muted); text-align: center; font-size: 12px; margin: 0 0 24px }
.page { display: flex; gap: 12px; align-items: center; justify-content: center; margin: 16px 0 0;
  color: var(--muted); font-size: 12px }
.page .count { color: var(--muted) }
.off { color: #45505f }
.hint { color: var(--muted); font-size: 12px }
.muted { color: var(--muted) }
/* 统计 / 明细表：评审 blocking、五闸、技能管理、发现共用（别每处各写一套颜色） */
.tbl { border-collapse: collapse; width: 100%; margin: 8px 0 0; font-size: 12px }
.tbl th, .tbl td { border-bottom: 1px solid #1b2029; padding: 4px 8px; text-align: left; vertical-align: top }
.tbl th { color: var(--muted); font-weight: 600 }
.tag { display: inline-block; padding: 1px 7px; border-radius: 999px; background: var(--panel); color: var(--muted); font-size: 12px }
.tag.warn { background: #231d11; color: #e8d9a8 }
.tag.fail { background: #221316; color: #f0bdbd }
.ok { color: #7fc78f }
.partial { color: #d6b25e }
.fail { color: #e08585 }
.days { margin: 0 0 8px; color: var(--muted); font-size: 12px }
.days a { margin-right: 8px }
.days .on { color: var(--fg); background: var(--panel); border-radius: 4px; padding: 0 6px }
/* run / 技能详情页的键值区：左标签右值，两列对齐才好扫 */
.kv { display: grid; grid-template-columns: 6em 1fr; gap: 2px 12px; margin: 8px 0 0 }
.kv-row { display: contents }
.kv .k { color: var(--muted); font-size: 12px }
.kv .v { color: var(--fg) }
.kv-line { margin: 4px 0 }
/* 流水线：五格等宽，颜色只表达状态（绿=完成、黄=在跑、蓝=卡住待人、红=失败、灰=等待/跳过）。
   窄屏自动折成两行，不横向滚动 —— 状态必须一屏看全。 */
.pipe { display: flex; flex-wrap: wrap; gap: 8px; margin: 8px 0 0; padding: 0; list-style: none }
.pipe .stage { flex: 1 1 150px; min-width: 140px; padding: 8px 10px; border: 1px solid var(--line);
  border-top: 2px solid var(--line); border-radius: 6px; background: var(--panel) }
.pipe .pl { display: block; color: var(--muted); font-size: 12px }
.pipe .ps { display: block; font-size: 13px; font-weight: 600 }
.pipe .pd { display: block; margin-top: 2px; color: #aeb7c4; font-size: 12px; line-height: 1.45 }
.pipe .pt { display: block; margin-top: 4px; color: #5d6675; font-size: 12px }
.pipe .s-done { border-top-color: var(--green) }
.pipe .s-done .ps { color: var(--green) }
.pipe .s-running { border-top-color: var(--yellow) }
.pipe .s-running .ps { color: var(--yellow) }
.pipe .s-blocked { border-top-color: var(--blue) }
.pipe .s-blocked .ps { color: var(--blue) }
.pipe .s-failed { border-top-color: var(--red) }
.pipe .s-failed .ps { color: var(--red) }
.pipe .s-waiting .ps, .pipe .s-skipped .ps { color: var(--muted) }
/* 终态：正常结束（判定不需要改 / 评审驳回），不是漏跑，用中性灰蓝而不是「–」的灰 */
.pipe .s-ended { border-top-color: #6b7a90 }
.pipe .s-ended .ps { color: #9fb0c7 }
/* 评审结论摘要：详情页里唯一「大一号」的正文，用户上来先读这一句 */
.verdict-summary { margin: 6px 0; font-size: 15px; font-weight: 600; color: var(--fg) }
a.run { color: #c8d3e6; border-bottom: 1px dashed #45505f }
a.run:hover { border-bottom-color: var(--blue); text-decoration: none }
a.sess { color: var(--muted); border-bottom: 1px dashed #45505f }
a.sess:hover { color: var(--blue); text-decoration: none }
/* diff：文件头灰底、hunk 灰字、+ 绿底、- 红底；行号定宽，长行横向滚动而不是被裁 */
.diff { margin: 8px 0 0; padding: 8px 0; background: #0c0e12; border: 1px solid var(--line); border-radius: 6px;
  overflow-x: auto; white-space: pre; font-size: 12px; line-height: 1.5 }
.diff .dl { display: block; padding: 0 8px; min-width: max-content }
.diff .ln { display: inline-block; width: 4.5em; color: #4a5364; text-align: right; padding-right: 8px; user-select: none }
.diff .tx { white-space: pre }
.diff .file { background: #22262f; color: #b8c1d1 }
.diff .hunk { color: var(--muted) }
.diff .add { background: #12281a; color: #b7e7c5 }
.diff .del { background: #221316; color: #f0bdbd }
.diff .meta { color: #6f7a8c }
.candidate { max-height: 480px; overflow: auto }
pre { margin: 8px 0 0; padding: 12px; background: #12151b; border-left: 2px solid var(--line);
  white-space: pre-wrap; word-break: break-word; color: #aeb7c4; font-size: 12px }
/* 最近操作：结果三色，ok / partial / error 扫一眼分开 */
.audit { margin-top: 24px; padding-top: 12px; border-top: 1px solid var(--line) }
.audit ul { list-style: none; margin: 0; padding: 0 }
.audit li { padding: 2px 0; color: #aeb7c4; font-size: 12px }
.audit .when { color: var(--muted) }
/* 会话页：顶部一行（返回 / 会话 / 原文件）+ 概览 + 左侧目录 + 消息流 */
.ses-top { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; margin: 16px 0 8px }
.ses-top .ses-id { color: #c8d3e6 }
.ses-top .to-end { margin-left: auto; font-size: 12px }
.ses-file { margin: 0; color: var(--muted); font-size: 12px; min-width: 0; word-break: break-all }
.ses-file code { user-select: all }
.ov { margin: 8px 0 16px; padding: 8px 12px; background: var(--panel); border: 1px solid var(--line);
  border-radius: 6px; color: var(--muted); font-size: 12px }
.ov .ov-link { margin-left: 12px }
.ses-wrap { display: flex; gap: 24px; align-items: flex-start }
.toc { display: none }
.m { scroll-margin-top: 80px }
/* 消息块：一条一块，抬头上是角色徽章与时刻 */
.msg { margin: 16px 0; padding: 0 0 0 12px; border-left: 3px solid transparent }
.msg .mhead { display: flex; align-items: center; gap: 8px; margin-bottom: 4px }
.msg .at { color: var(--muted); font-size: 12px }
.msg.user { border-left-color: var(--blue); background: rgba(56, 132, 255, .08); padding: 8px 12px; border-radius: 4px }
.msg-body { font-size: 14px; line-height: 1.6 }
.msg-body p { margin: 4px 0 }
.msg-body ul { margin: 4px 0; padding-left: 20px }
.msg-body pre.code { margin: 8px 0; border: 1px solid var(--line) }
details.tools { margin: 12px 0; padding: 8px 12px; background: var(--panel); border: 1px solid var(--line); border-radius: 6px }
details.tools > summary { cursor: pointer; color: #c8d3e6; font-size: 12px }
.tool { margin: 8px 0 0; padding: 8px 0 0; border-top: 1px solid var(--line) }
.tool-name { margin: 0; color: var(--blue); font-size: 12px }
.tool-args, .tool-result { margin: 4px 0 0; padding: 8px; background: var(--bg); border-left: 1px solid var(--line) }
.tool-result { color: var(--muted) }
.to-top { display: block; margin: 24px 0 0; text-align: right; font-size: 12px }
footer { margin-top: 24px; padding-top: 12px; border-top: 1px solid var(--line); color: var(--muted); font-size: 12px }
/* 窄屏：只保证不溢出，不做响应式框架。时间/提案列让位给内容，操作列可以换行 */
@media (max-width: 900px) {
  .wrap { padding: 0 8px 16px }
  .rows .time, .rows .delta { display: none }
  .rows .status { width: 72px }
  .rows td, .rows th { padding: 6px }
  .rows .ops { white-space: normal }
}
/* 宽屏才给左侧常驻目录：窄屏用顶部折叠目录兜底（在 render-session.ts 里） */
@media (min-width: 1200px) {
  .ses-wrap { flex-direction: row }
  .toc { display: block; position: sticky; top: 0; align-self: flex-start; width: 260px;
    max-height: calc(100vh - 80px); overflow: auto; font-size: 12px }
  .toc a { display: block; padding: 2px 0; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap }
  .toc a:hover { color: var(--blue); text-decoration: none }
  .ses-body { flex: 1; min-width: 0 }
}
details.toc-fold { display: block; margin: 0 0 12px; font-size: 12px }
details.toc-fold > summary { cursor: pointer; color: var(--muted) }
details.toc-fold .toc-list { padding: 8px 0 0 8px }
@media (min-width: 1200px) { details.toc-fold { display: none } }
`.trim();
