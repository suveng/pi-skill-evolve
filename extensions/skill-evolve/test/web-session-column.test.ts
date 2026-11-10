/**
 * 列表页的「会话」标识：五个视图（待处理 / 待审批 / 已采纳 / 已处理 / 复盘报告）都必须能看出这条 run 属于哪段对话，
 * 且文案一致 —— 显示 sessionId 前 8 位，完整 id 放 title，点进 `?view=session`。
 *
 * 为什么必须每页都有（用户 2026-11-08）：「面板展示的也应该是 pi sessionId 否则我都不知道怎么看对应会话」。
 * 重做列表页后会话不再是一列：同一会话的多条 run 归到组标题（`<details>` 的 summary）里，
 * 单条会话的 run 把会话名写在状态格的小字里 —— 两处都由 render-rows.ts 产出，本文件把这条约定钉住。
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { AppliedItem } from "../lib/web/applied.ts";
import type { ApprovalItem } from "../lib/web/approvals.ts";
import type { DoneItem, PendingItem, WebState } from "../lib/web/data.ts";
import { renderPage } from "../lib/web/render.ts";
import type { SessionRef } from "../lib/web/run-session.ts";

const NOW = new Date(2026, 10, 8, 12).getTime();
const SESSION_ID = "01a1b90f-08c3-722c-871d-d024b083770a";
const SESSION: SessionRef = { sessionId: SESSION_ID, sessionFile: `/tmp/${SESSION_ID}.jsonl` };
const NO_SESSION: SessionRef = { sessionId: null, sessionFile: null };

function state(parts: Partial<WebState> = {}): WebState {
  return {
    pending: [],
    approvals: [],
    applied: [],
    done: [],
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

function pageWithSession(): Record<string, string> {
  const current = state({
    pending: [pendingItem(SESSION)],
    approvals: [approvalItem(SESSION)],
    applied: [appliedItem(SESSION)],
    done: [doneItem(SESSION)],
  });
  return {
    pending: renderPage(current, "pending", { now: NOW }),
    approvals: renderPage(current, "approvals", { now: NOW }),
    applied: renderPage(current, "applied", { now: NOW }),
    done: renderPage(current, "done", { now: NOW }),
  };
}

test("四个视图都能看到会话：链接指向 ?view=session，文案是 sessionId 前 8 位，title 是完整 id", () => {
  const pages = pageWithSession();
  const href = `/?view=session&amp;sessionId=${SESSION_ID}`;
  for (const [view, html] of Object.entries(pages)) {
    assert.equal(html.includes(href), true, `${view} 页缺会话链接`);
    assert.match(html, /会话 01a1b90f/, `${view} 页要显示会话前 8 位`);
    assert.equal(html.includes(`title="${SESSION_ID}"`), true, `${view} 页 title 要放完整 sessionId`);
  }
});

test("单条会话的 run 不进组：会话名写在状态格的小字里，runId 只出现在操作列", () => {
  const html = renderPage(state({ pending: [pendingItem(SESSION)] }), "pending", { now: NOW });
  assert.match(html, /<span class="sk-sess"><a class="sess"/, "会话名应在状态格的小字里");
  assert.equal(html.includes('<details class="grp"'), false, "只有一条 run 时不该出现会话分组");
  // runId 不再是主标识：只在操作列，显示末 8 位，title 放完整值
  assert.match(html, /<td class="ops">.*title="run-p-1794133942"/);
});

test("没有 sessionId 的老 run：写「会话 —」占位，不造空链接、不报错", () => {
  const html = renderPage(state({ pending: [pendingItem(NO_SESSION)], done: [doneItem(NO_SESSION)] }), "pending", {
    now: NOW,
  });
  assert.match(html, /<span class="sk-sess">会话 —<\/span>/);
  assert.equal(html.includes("view=session"), false, "缺 id 时不许出现会话链接");
});

test("会话链接带 file 参数：页面可直接打开声明过的会话文件，不必再反查", () => {
  const html = renderPage(state({ pending: [pendingItem(SESSION)] }), "pending", { now: NOW });
  assert.match(html, new RegExp(`file=%2Ftmp%2F${SESSION_ID}\\.jsonl`));
});

test("同一会话的多条 run 归到组标题：会话名出现在 details 的 summary 里", () => {
  const html = renderPage(state({ pending: [pendingItem(SESSION), pendingItem(SESSION)] }), "pending", { now: NOW });
  assert.match(html, /<details class="grp" open>\n<summary><a class="sess" href="\/\?view=session&amp;sessionId=/);
});
