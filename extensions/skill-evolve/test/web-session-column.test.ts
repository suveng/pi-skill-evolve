/**
 * 列表页的「会话」列：五个视图（待处理 / 待审批 / 已采纳 / 已处理 / 复盘报告）都必须带，
 * 且文案一致 —— 只显示 sessionId 前 8 位，完整 id 放 title，点进 `?view=session`。
 *
 * 为什么必须每页都有（用户 2026-11-08）：「面板展示的也应该是 pi sessionId 否则我都不知道怎么看对应会话」。
 * 同一个渲染函数 `sessionCell` 供五处复用，本文件就是把这条约定钉住：
 * 少一页就说明有人另写了一份行渲染。
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { AppliedItem } from "../lib/web/applied.ts";
import type { ApprovalItem } from "../lib/web/approvals.ts";
import type { QueueItem } from "../lib/queue.ts";
import type { DoneItem, PendingItem, WebState } from "../lib/web/data.ts";
import type { RunReport } from "../lib/web/reports.ts";
import { renderPage } from "../lib/web/render.ts";
import { pendingRows } from "../lib/web/render-rows.ts";
import type { SessionRef } from "../lib/web/run-session.ts";

const NOW = new Date(2026, 10, 8, 12).getTime();
const SESSION_ID = "01a1b90f-08c3-722c-871d-d024b083770a";
const SESSION: SessionRef = { sessionId: SESSION_ID, sessionFile: `/tmp/${SESSION_ID}.jsonl` };
const NO_SESSION: SessionRef = { sessionId: null, sessionFile: null };
const CTX = { csrf: "c", writable: true, view: "pending" as const };

function state(parts: Partial<WebState> = {}): WebState {
  return {
    pending: [],
    approvals: [],
    applied: [],
    done: [],
    reports: [],
    summary: { reviewing: 0, stale: 0, pendingApprovals: 0, appliedTotal: 0, rollbackRate: 0 },
    ...parts,
  };
}

function pendingItem(session: SessionRef): PendingItem {
  return { runId: "run-p-1794133942", kind: "reviewed", skill: "demo", at: NOW, detail: "", session };
}

function approvalItem(session: SessionRef): ApprovalItem {
  return {
    runId: "run-b-1794133942",
    session,
    skill: "demo",
    level: "approval",
    targets: [".pi/skills/demo/SKILL.md"],
    createdAt: NOW,
    proposal: { type: "improve", added: 3, removed: 1 },
    review: { verdict: "pass", blocking: 0 },
    detail: "",
  };
}

function appliedItem(session: SessionRef): AppliedItem {
  return {
    runId: "run-a-1794133942",
    session,
    level: "approval",
    skill: "demo",
    type: "improve",
    added: 3,
    removed: 1,
    appliedAt: NOW,
    gates: [],
    gatesOk: null,
  };
}

function doneItem(session: SessionRef): DoneItem {
  return { runId: "run-d-1794133942", status: "rejected", source: "run", level: "-", skill: "demo", at: NOW, detail: "", session };
}

function reportItem(session: SessionRef): RunReport {
  return {
    runId: "run-r-1794133942",
    status: "reviewed",
    trigger: "auto",
    session,
    startedAt: NOW,
    findings: { total: 0, rows: [] },
    proposal: null,
    review: null,
    decision: null,
    verify: null,
  };
}

/** 五个视图各塞一条带会话的行，返回整页 HTML */
function pageWithSession(): Record<string, string> {
  const base: Partial<WebState> = {
    pending: [pendingItem(SESSION)],
    approvals: [approvalItem(SESSION)],
    applied: [appliedItem(SESSION)],
    done: [doneItem(SESSION)],
    reports: [reportItem(SESSION)],
  };
  const current = state(base);
  return {
    pending: renderPage(current, "pending"),
    approvals: renderPage(current, "approvals"),
    applied: renderPage(current, "applied"),
    done: renderPage(current, "done"),
    reports: renderPage(current, "reports"),
  };
}

test("五个视图都有会话列：链接指向 ?view=session，文案是 sessionId 前 8 位，title 是完整 id", () => {
  const pages = pageWithSession();
  for (const [view, html] of Object.entries(pages)) {
    const href = `/?view=session&amp;sessionId=${SESSION_ID}`;
    assert.equal(html.includes(href), true, `${view} 页缺会话链接`);
    assert.match(html, /会话 01a1b90f/, `${view} 页会话列要显示前 8 位`);
    assert.equal(html.includes(`title="${SESSION_ID}"`), true, `${view} 页 title 要放完整 sessionId`);
  }
});

test("待处理行：会话列跟在 runId 后面，同一行里两者都在", () => {
  const html = pendingRows([pendingItem(SESSION)], CTX);
  const runIdIndex = html.indexOf("run-p-1794133942");
  const sessIndex = html.indexOf('class="sess"');
  assert.equal(runIdIndex >= 0 && sessIndex > runIdIndex, true, "会话列应在 runId 之后");
  assert.match(html, / · <a class="sess"/, "会话列与行头之间用 · 分隔");
});

test("待审批行：summary 里同样带会话列（它是自己拼的 details，最容易漏）", () => {
  const html = renderPage(state({ approvals: [approvalItem(SESSION)] }), "approvals");
  assert.match(html, /<summary class="head">[^<]*<a class="sess" href="\/\?view=session&amp;sessionId=/);
});

test("没有 sessionId 的老 run：写「会话 —」占位，不造空链接、不报错", () => {
  const html = renderPage(state({ pending: [pendingItem(NO_SESSION)], done: [doneItem(NO_SESSION)] }), "pending");
  assert.match(html, /<span class="hint">会话 —<\/span>/);
  assert.equal(html.includes("view=session"), false, "缺 id 时不许出现会话链接");
});

test("会话链接带 file 参数：页面可直接打开声明过的会话文件，不必再反查", () => {
  const html = pendingRows([pendingItem(SESSION)], CTX);
  assert.match(html, new RegExp(`file=%2Ftmp%2F${SESSION_ID}\\.jsonl`));
});
