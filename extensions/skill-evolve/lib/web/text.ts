/**
 * 面板上的文本格式化：转义、时间戳、短 runId。
 *
 * 单独一份是因为渲染层的三个文件（骨架 / 列表行 / 控制条）都要用它们，
 * 放在其中一个里会变成「A 引 B、B 又引 A」的循环。
 *
 * 为什么全转义：页面里的每个字都来自 run 产物与技能文件，而复盘内容本来就是「模型写的自由文本」
 * —— 一条 findings 里出现 `<script>` 完全可能。只要漏一个 `escapeHtml`，面板就成了本地 XSS 的跳板
 * （面板虽只绑 127.0.0.1，但同一台机器上的任意进程/浏览器标签都能打到它）。
 */

/** 五个字符全部要转：`'` 与 `"` 用于属性值，`&` 必须先转，否则实体会被二次解码 */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

/** 本地时间 `YYYY-MM-DD HH:mm`：面板上全是同一时区的人在看，不折腾 ISO */
export function formatStamp(ts: number | null): string {
  if (ts === null || !Number.isFinite(ts)) return "—";
  const date = new Date(ts);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * 列表里的短 runId：同一会话的 runId 都是 `<sessionHash8>-<时间戳>`，前缀一模一样，
 * 全量打印会变成一列看不出区别的字符串。保留前 8 + 后 4，完整值放详情里。
 */
export function shortRunId(runId: string): string {
  return runId.length > 16 && runId.includes("-") ? `${runId.slice(0, 8)}…${runId.slice(-4)}` : runId;
}

/**
 * 详情第一行永远是完整 runId：列表上显示的是缩写，复制要靠这一行。
 * 文案里带 `runId：` 前缀是因为详情区是纯文本，没有别的办法标出这一行是什么。
 */
export function withId(runId: string, detail: string): string {
  return detail.length > 0 ? `runId：${runId}\n${detail}` : `runId：${runId}`;
}
