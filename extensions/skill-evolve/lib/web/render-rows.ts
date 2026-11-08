/**
 * 列表行的渲染：五种视图（待处理 / 待审批 / 已采纳 / 已处理 / 复盘报告）各一段，加上每行针对那条 run 的操作按钮。
 *
 * 为什么单独一个文件：行渲染是面板里最长的一段（抬头 + 详情 + 行内表单），
 * 和页面骨架（状态栏 / 导航 / 页脚）混在一起必然破 300 行。
 *
 * 行的操作只有三个（重跑 / 清理 / 看日志），且**只在待处理与复盘报告页**出现：
 * 待审批页逐行就是批准/拒绝，已采纳与已处理页是档案（只给看 diff / 看日志），都不挂「重跑」——
 * 一个已采纳的 run 旁边放「重跑」按钮，只会让人以为它能重放整个采纳流程。
 *
 * 按钮只在 `writable` 且拿到 csrf 时渲染，绝不自己造一个「能点但写不动」的按钮；
 * 「看日志」是只读 GET，只读面板也照常给（它不写任何东西）。
 */
import type { AppliedItem, ApprovalItem, DoneItem, PendingItem, RunReport, WebView } from "./data.ts";
import { escapeHtml, formatStamp, shortRunId, withId } from "./text.ts";

/** 行内操作需要的上下文：csrf 与 canWrite 决定按钮渲不渲染，view 决定动作做完回哪一页 */
export interface RowContext {
  csrf: string;
  writable: boolean;
  view: WebView;
}

/**
 * 抬头里的 runId 做成链接（点进去看 run 详情页：diff / 评审 / 五闸）。
 *
 * 实现上**先整段转义、再把 shortRunId 那一段换成锚点**：抬头文本来自磁盘，
 * 绝不能先拼 HTML 再转义（会出现两次转义与注入两种毛病）。
 */
function linkRunId(text: string, runId: string): string {
  const short = escapeHtml(shortRunId(runId));
  const index = text.indexOf(short);
  if (index < 0) return text;
  const href = escapeHtml(`/?view=run&runId=${encodeURIComponent(runId)}`);
  const anchor = `<a class="run" href="${href}">${short}</a>`;
  return `${text.slice(0, index)}${anchor}${text.slice(index + short.length)}`;
}

/** 一行；detail 为空就不给 `<details>`（空折叠框比没有更烦）；给了 runId 就把抬头里的 runId 变链接 */
function row(head: string, detail: string, acts = "", runId?: string): string {
  const text = escapeHtml(head);
  const rendered = runId === undefined ? text : linkRunId(text, runId);
  const inner =
    detail.length === 0
      ? `<span class="head">${rendered}</span>`
      : `<details><summary class="head">${rendered}</summary><pre>${escapeHtml(detail)}</pre></details>`;
  return acts.length === 0 ? `<li class="row">${inner}</li>` : `<li class="row">${inner}\n${acts}</li>`;
}

/** 一个 `/action` 表单：csrf / name / runId / view 全走 hidden，按钮就是提交键 */
function runForm(name: "rerun" | "cleanup", runId: string, ctx: RowContext): string {
  const label = name === "rerun" ? "重跑" : "清理记录";
  const cls = name === "rerun" ? "" : ' class="danger"';
  const title = name === "rerun" ? "" : ' title="移到 runs/.trash/，不会删数据"';
  return `<form method="post" action="/action">
<input type="hidden" name="csrf" value="${escapeHtml(ctx.csrf)}">
<input type="hidden" name="name" value="${name}">
<input type="hidden" name="runId" value="${escapeHtml(runId)}">
<input type="hidden" name="view" value="${ctx.view}">
<button type="submit"${cls}${title}>${label}</button>
</form>`;
}

/**
 * 行内操作条。`stale` 才给「清理记录」：清理是把目录移走，非卡死的 run 还在写盘，
 * 移走等于把活进程的 cwd 抽掉（Linux 上不报错，但之后的写入全进孤儿 inode）。
 */
function rowActs(runId: string, ctx: RowContext, stale: boolean): string {
  const parts: string[] = [];
  if (ctx.writable) {
    parts.push(runForm("rerun", runId, ctx));
    if (stale) parts.push(runForm("cleanup", runId, ctx));
  }
  parts.push(`<a class="btn" href="/log?runId=${encodeURIComponent(runId)}">看日志</a>`);
  return `<div class="acts">\n${parts.join("\n")}\n</div>`;
}

/** 档案类行的操作：只有两个只读链接（看 diff / 看日志），不挂重跑 */
function archiveActs(runId: string): string {
  const id = encodeURIComponent(runId);
  return `<div class="acts">\n<a class="btn" href="${escapeHtml(`/?view=run&runId=${id}`)}">看 diff</a>\n<a class="btn" href="${escapeHtml(`/log?runId=${id}`)}">看日志</a>\n</div>`;
}

export function pendingRows(items: readonly PendingItem[], ctx: RowContext): string {
  const badge: Record<PendingItem["kind"], string> = { running: "进行中", approval: "待批", stale: "卡死", reviewed: "待入队" };
  return items
    .map((item) => {
      const skill = item.skill.length > 0 ? ` · ${item.skill}` : "";
      return row(
        `[${badge[item.kind]}] ${shortRunId(item.runId)}${skill} · ${formatStamp(item.at)}`,
        withId(item.runId, item.detail),
        rowActs(item.runId, ctx, item.kind === "stale"),
      );
    })
    .join("\n");
}

export function doneRows(items: readonly DoneItem[]): string {
  return items
    .map((item) => {
      const skill = item.skill.length > 0 ? ` · ${item.skill}` : "";
      const level = item.level === "-" ? "" : ` · ${item.level}`;
      return row(
        `[${item.status}] ${shortRunId(item.runId)}${skill}${level} · ${formatStamp(item.at)}`,
        withId(item.runId, item.detail),
        archiveActs(item.runId),
        item.runId,
      );
    })
    .join("\n");
}

/** 五闸一句话：没记录时写「无记录」而不是「失败」（判不了 ≠ 没过） */
function gateText(item: AppliedItem): string {
  if (item.gatesOk === null) return "五闸：无记录";
  const failed = item.gates.filter((gate) => !gate.ok).length;
  return failed === 0 ? "五闸：全 ok" : `五闸：${failed} 项失败`;
}

function appliedDetail(item: AppliedItem): string {
  const gates =
    item.gates.length === 0
      ? ["五闸：没有 06-verify.json（无法判定）"]
      : item.gates.map((gate) => `  ${gate.gate} ${gate.name} ${gate.ok ? "✓" : "✗"}`);
  return [
    `层级：${item.level}`,
    `采纳：${formatStamp(item.appliedAt)}`,
    `提案：${item.type} +${item.added}/-${item.removed} 行`,
    ...gates,
    item.gatesOk === false ? "注意：有闸没过却仍被采纳，先看 06-verify.json" : "",
    "完整 diff：点上方 runId 进详情页",
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

/** 已采纳：技能 · 提案类型 · +N/-M · 采纳时间 · 五闸结论（用户要的就是这五个字段） */
export function appliedRows(items: readonly AppliedItem[]): string {
  return items
    .map((item) => {
      const skill = item.skill.length > 0 ? ` · ${item.skill}` : "";
      const delta = ` · ${item.type} +${item.added}/-${item.removed}`;
      return row(
        `[applied] ${shortRunId(item.runId)}${skill}${delta} · ${formatStamp(item.appliedAt)} · ${gateText(item)}`,
        appliedDetail(item),
        archiveActs(item.runId),
        item.runId,
      );
    })
    .join("\n");
}

/** 待批条目的抬头：一眼看到「谁、改多少、评审怎么判」，详情留给 targets 与完整 runId */
function approvalHead(item: ApprovalItem): string {
  const proposal = item.proposal ? ` · ${item.proposal.type} +${item.proposal.added}/-${item.proposal.removed}` : " · 无提案";
  const verdict = item.review ? ` · ${item.review.verdict ?? "无 verdict"}/blocking ${item.review.blocking}` : "";
  return `[${item.level}] ${shortRunId(item.runId)} · ${item.skill}${proposal}${verdict} · ${formatStamp(item.createdAt)}`;
}

function approvalDetail(item: ApprovalItem): string {
  return [
    `层级：${item.level}（必须人批；auto 级不在这里）`,
    `目标：${item.targets.join("、") || "（未写 targets）"}`,
    `入队：${formatStamp(item.createdAt)}`,
    item.proposal
      ? `提案：${item.proposal.type} +${item.proposal.added}/-${item.proposal.removed} 行`
      : "提案：读不到 02-proposal.json",
    item.review ? `评审：verdict=${item.review.verdict ?? "（未写）"} · blocking ${item.review.blocking} 条` : "评审：读不到 03-review.json",
    item.detail ? `备注：${item.detail}` : "",
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

/** 一个审批动作表单：csrf 与 runId 都走 hidden，按钮就是提交键 */
function actionForm(action: "approve" | "reject", item: ApprovalItem, csrf: string): string {
  const label = action === "approve" ? "批准" : "拒绝";
  const cls = action === "approve" ? "" : ' class="reject"';
  return `<form method="post" action="/${action}">
<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
<input type="hidden" name="runId" value="${escapeHtml(item.runId)}">
<button type="submit"${cls}>${label}</button>
</form>`;
}

export function approvalRows(items: readonly ApprovalItem[], ctx: RowContext): string {
  return items
    .map((item) => {
      const detail = `<details><summary class="head">${escapeHtml(approvalHead(item))}</summary><pre>${escapeHtml(
        withId(item.runId, approvalDetail(item)),
      )}</pre></details>`;
      if (!ctx.writable) return `<li class="row">${detail}</li>`;
      const acts = `<div class="acts">\n${actionForm("approve", item, ctx.csrf)}\n${actionForm("reject", item, ctx.csrf)}\n</div>`;
      return `<li class="row">${detail}\n${acts}</li>`;
    })
    .join("\n");
}

function gateLine(report: RunReport): string {
  if (!report.verify) return "验证：还没跑过五闸（未采纳）";
  const marks = report.verify.gates.map((gate) => `${gate.gate}${gate.ok ? "✓" : "✗"}`).join(" ");
  return `验证：${report.verify.status} · ${formatStamp(report.verify.at)} · ${marks || "（未记录闸门）"}`;
}

/** 报告的展开内容：按「结论 → 依据 → 执行」的顺序排，最后才是数字，方便先看结论 */
function reportDetail(report: RunReport): string {
  const lines = [`状态：${report.status} · 触发：${report.trigger} · 开始：${formatStamp(report.startedAt)}`];
  // 失败留档先给原因与日志末行：先知道“为什么没有 findings”，再看其它字段
  if (report.failure) lines.push(report.failure);
  const rows = report.findings.rows.map((item) => `  · ${item.skill} · ${item.kind} · ${item.reason}`);
  lines.push(`findings：${report.findings.total} 条`);
  lines.push(...rows);
  if (report.findings.total > report.findings.rows.length) {
    lines.push(`  …另有 ${report.findings.total - report.findings.rows.length} 条（见 01-findings.json）`);
  }
  lines.push(
    report.proposal
      ? `提案：${report.proposal.type} ${report.proposal.skill} +${report.proposal.added}/-${report.proposal.removed}`
      : "提案：无",
  );
  lines.push(
    report.review
      ? `评审：${report.review.status}${report.review.verdict ? ` verdict=${report.review.verdict}` : ""} · blocking ${report.review.blocking} 条`
      : "评审：无",
  );
  lines.push(
    report.decision
      ? `决策：${report.decision.status} · ${report.decision.approver} · ${formatStamp(report.decision.at)}${report.decision.detail ? ` · ${report.decision.detail}` : ""}`
      : "决策：未采纳（没有 04-decision.json）",
  );
  lines.push(gateLine(report));
  return lines.join("\n");
}

export function reportRows(reports: readonly RunReport[], ctx: RowContext): string {
  return reports
    .map((report) => {
      // 行上就要能看出「有没有东西」：全部折叠成一行状态+时间，等于用户得逐个点开才知道
      const findings = report.findings.total > 0 ? ` · ${report.findings.total} 条发现` : " · 无发现";
      const proposal = report.proposal ? ` · ${report.proposal.type} ${report.proposal.skill}` : "";
      const verdict = report.review?.verdict ? ` · ${report.review.verdict}` : "";
      // 卡死的 run 与其它状态同样重要，但中文标签才有用：行首就是用户扫的关键词
      const label = report.status === "stale" ? "卡死" : report.status;
      return row(
        `[${label}] ${shortRunId(report.runId)}${findings}${proposal}${verdict} · ${formatStamp(report.startedAt)}`,
        withId(report.runId, reportDetail(report)),
        rowActs(report.runId, ctx, report.status === "stale"),
        report.runId,
      );
    })
    .join("\n");
}
