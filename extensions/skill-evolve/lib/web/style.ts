/**
 * 面板的内联样式：单文件放着是因为只有一处消费（render.ts），拆出来只是为了把 render.ts 压在 300 行内。
 * 不引外部 CSS：面板必须离线可用，一条网络请求都不发。
 */
export const STYLE = `
:root { color-scheme: dark }
* { box-sizing: border-box }
body { margin: 0; padding: 24px; background: #0f1115; color: #d7dce5;
  font: 14px/1.6 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace }
h1 { margin: 0 0 4px; font-size: 18px; font-weight: 600 }
.bar { margin: 0 0 16px; color: #8d99ae }
.bar a { color: #7cc4ff; text-decoration: none }
.notice { margin: 0 0 12px; padding: 8px 12px; border-left: 2px solid #3f9d5a; background: #131a17; color: #b6e2c4 }
.notice.err { border-left-color: #c05c5c; background: #1a1313; color: #f0bdbd }
nav { display: flex; gap: 12px; margin-bottom: 16px; border-bottom: 1px solid #232733; padding-bottom: 8px }
nav a { color: #8d99ae; text-decoration: none; padding: 2px 8px; border-radius: 4px }
nav a:hover { background: #1a1f29 }
nav a.active { color: #0f1115; background: #7cc4ff }
ul { list-style: none; margin: 0; padding: 0 }
li.row { border-bottom: 1px solid #1c202a; padding: 8px 0 }
summary.head { cursor: pointer; color: #cfe3ff }
span.head { color: #cfe3ff }
pre { margin: 8px 0 0; padding: 12px; background: #141821; border-left: 2px solid #2b3342;
  white-space: pre-wrap; word-break: break-word; color: #aeb7c4 }
.empty { color: #6f7a8c; padding: 24px 0 }
.acts { display: flex; gap: 8px; margin-top: 8px }
.acts form { display: inline; margin: 0 }
button { font: inherit; color: #0f1115; background: #7cc4ff; border: 0; border-radius: 4px; padding: 2px 12px; cursor: pointer }
button.reject { background: #6f7a8c; color: #0f1115 }
button.danger { background: #c05c5c; color: #fff }
button:hover { filter: brightness(1.1) }
/* 顶部控制条：开关状态、切换/立即复盘按钮、最后活动 */
.ctl { display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  margin: 0 0 16px; padding: 8px 12px; background: #141821; border: 1px solid #232733; border-radius: 6px }
.ctl form { display: inline; margin: 0 }
.ctl .state { padding: 1px 8px; border-radius: 4px }
.ctl .state.on { background: #16301f; color: #b6e2c4 }
.ctl .state.off { background: #2a1f1f; color: #e6b0b0 }
.ctl .act { color: #8d99ae }
/* 单个开关：状态 + 后果说明 + 按钮竖排，两个开关之间靠 .ctl 的 gap 分隔 */
.ctl .sw { display: inline-flex; align-items: center; gap: 6px }
.ctl .hint { color: #8d99ae; font-size: 12px }
.warn { margin: 6px 0 0; padding: 6px 10px; border-left: 3px solid #b58900;
  background: #2a2418; color: #e8d9a8 }
/* 筛选表单与翻页：零 JS，样式也要看得出它们是一组 */
.filter { display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
  margin: 0 0 12px; padding: 8px 12px; background: #141821; border: 1px solid #232733; border-radius: 6px }
.filter label { color: #8d99ae }
.filter input, .filter select { font: inherit; color: #d7dce5; background: #0f1115;
  border: 1px solid #2b3342; border-radius: 4px; padding: 1px 6px }
.page { display: flex; gap: 12px; align-items: center; margin: 12px 0 0; color: #8d99ae }
.page a { color: #7cc4ff; text-decoration: none }
.page .count { color: #6f7a8c }
.off { color: #3f4654 }
a.btn { color: #7cc4ff; text-decoration: none; padding: 2px 10px; border: 1px solid #2b3342; border-radius: 4px }
a.btn:hover { background: #1a1f29 }
/* 最近操作：结果分三色，ok / partial / error 扫一眼就能分开 */
.audit { margin-top: 24px; padding-top: 12px; border-top: 1px solid #232733 }
.audit h2 { margin: 0 0 8px; font-size: 14px; font-weight: 600; color: #8d99ae }
.audit li { padding: 2px 0; color: #aeb7c4 }
.audit .when { color: #6f7a8c }
.audit code { font: inherit; color: #cfe3ff }
.ok { color: #7fc78f }
.partial { color: #d6b25e }
.fail { color: #e08585 }
/* 表格：评审 blocking / 五闸 / 发现 / 技能管理都用同一套，避免每处各写一份颜色 */
.tbl { border-collapse: collapse; width: 100%; margin: 8px 0 0; font-size: 13px }
.tbl th, .tbl td { border-bottom: 1px solid #1c202a; padding: 4px 8px; text-align: left; vertical-align: top }
.tbl th { color: #8d99ae; font-weight: 600 }
.tbl a { color: #7cc4ff; text-decoration: none }
/* 状态标签：三个标签三色，合成一个就分不出该去批、去改还是去补 stub */
.tag { display: inline-block; padding: 0 6px; border-radius: 4px; background: #1a1f29; color: #aeb7c4; font-size: 12px }
.tag.warn { background: #2a2418; color: #e8d9a8 }
.tag.fail { background: #2a1616; color: #f0bdbd }
.hint { color: #8d99ae; font-size: 12px }
.days { margin: 0 0 8px; color: #8d99ae }
.days a { color: #7cc4ff; text-decoration: none }
.days .on { color: #d7dce5; padding: 0 6px; background: #1a1f29; border-radius: 4px }
/* run 详情页的概要：左标签右值，两列对齐才好扫 */
.kv { display: grid; grid-template-columns: 6em 1fr; gap: 2px 12px; margin: 8px 0 0 }
.kv-row { display: contents }
.kv .k { color: #8d99ae }
.kv .v { color: #d7dce5 }
.kv-line { margin: 4px 0 }
.kv .v code { font: inherit; color: #cfe3ff }
a.run { color: #cfe3ff; text-decoration: none; border-bottom: 1px dashed #3f4654 }
a.run:hover { border-bottom-color: #7cc4ff }
h2 { margin: 20px 0 6px; font-size: 15px; font-weight: 600; color: #cfe3ff }
/* diff：文件头灰底、hunk 灰字、+ 绿底、- 红底；行号两列宽固定，不随内容抹动 */
.diff { margin: 8px 0 0; padding: 8px 0; background: #0c0e12; border: 1px solid #232733; border-radius: 6px;
  overflow-x: auto; white-space: pre; font-size: 12.5px; line-height: 1.5 }
.diff .dl { display: block; padding: 0 8px }
/* 长行必须横向滚动而不是被裁掉：技能 description 动辄两三百字，截断等于看不见改了什么 */
.diff { overflow-x: auto }
.diff .dl { min-width: max-content }
.diff .ln { display: inline-block; width: 4.5em; color: #4a5364; text-align: right; padding-right: 8px; user-select: none }
.diff .tx { white-space: pre }
.diff .file { background: #22262f; color: #b8c1d1 }
.diff .hunk { color: #8d99ae }
.diff .add { background: #12281a; color: #b7e7c5 }
.diff .del { background: #2a1616; color: #f0bdbd }
.diff .meta { color: #6f7a8c }
/* 改后全文：长文件限高内部滚动，别把后面的评审/五闸顶到屏幕外 */
.candidate { max-height: 480px; overflow: auto }
/* 会话详情页：工具调用块默认收起（details 不带 open），抬头是一行可点的摘要 */
details > summary { cursor: pointer }
details.tools { margin: 10px 0; padding: 8px 10px; background: #171b24; border-left: 2px solid #2b3342; border-radius: 4px }
details.tools > summary { color: #cfe3ff }
.tool { margin: 8px 0 0; padding: 8px 0 0; border-top: 1px solid #232733 }
.tool-name { margin: 0; color: #7cc4ff }
.tool-args, .tool-result { margin: 4px 0 0; padding: 8px; background: #141821;
  border-left: 1px solid #2b3342; white-space: pre-wrap; word-break: break-word }
.tool-result { color: #8d99ae }
/* 对话消息：谁说的一句话决定左边框颜色，长文本靠 pre 自己的换行 */
.msg { margin: 14px 0; padding-left: 10px; border-left: 2px solid #2b3342 }
.msg.user { border-left-color: #7cc4ff }
.msg .who { margin: 0; color: #8d99ae; font-size: 12px }
.msg pre { margin: 4px 0 0; background: none; padding: 0; border: 0 }
/* 列表页「会话」列：只显示 sessionId 前 8 位，完整值在 title 里 */
a.sess { color: #8d99ae; text-decoration: none; border-bottom: 1px dashed #3f4654 }
a.sess:hover { color: #7cc4ff; border-bottom-color: #7cc4ff }
footer { margin-top: 24px; padding-top: 12px; border-top: 1px solid #232733; color: #6f7a8c }
footer a { color: #7cc4ff }
`.trim();
