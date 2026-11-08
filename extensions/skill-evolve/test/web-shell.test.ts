/**
 * 页面骨架与导航：六个 tab 的顺序与高亮、状态栏里的两个跳转、`?view=` 白名单。
 * 「已采纳」必须是独立 tab（用户原话：已采纳的 tab 单独出来），技能管理排最后。
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { WebState } from "../lib/web/data.ts";
import { parsePanelView, parseRedirectView, parseView } from "../lib/web/filter.ts";
import { TAB_ORDER, VIEW_LABEL, shellPage, statusBar, tabs } from "../lib/web/shell.ts";

function state(): WebState {
  return {
    pending: [],
    approvals: [],
    applied: [],
    done: [],
    reports: [],
    summary: { reviewing: 2, stale: 1, pendingApprovals: 3, appliedTotal: 4, rollbackRate: 0.26 },
  };
}

test("六个 tab：待处理 / 待审批 / 已采纳 / 已处理 / 复盘报告 / 技能管理", () => {
  assert.deepEqual([...TAB_ORDER], ["pending", "approvals", "applied", "done", "reports", "skills"]);
  assert.deepEqual(
    TAB_ORDER.map((item) => VIEW_LABEL[item]),
    ["待处理", "待审批", "已采纳", "已处理", "复盘报告", "技能管理"],
  );
  assert.equal(tabs("applied").split("\n").length, 6, "不能有第七个 tab 或漏掉一个");
});

test("高亮只落在当前 tab 上；详情页（active=null）一个都不高亮", () => {
  const applied = tabs("applied");
  assert.match(applied, /<a href="\/\?view=applied" class="active">已采纳<\/a>/);
  assert.equal(applied.match(/class="active"/g)?.length, 1);
  const skills = tabs("skills");
  assert.match(skills, /<a href="\/\?view=skills" class="active">技能管理<\/a>/);
  assert.equal(tabs(null).includes('class="active"'), false);
});

test("状态栏：「已采纳 N」自己就是一个链接，点数字落到已采纳页", () => {
  const html = statusBar(state());
  assert.match(html, /复盘中 2 · 卡死 1 · 待批 <a href="\/\?view=approvals">3<\/a> · 已采纳 <a href="\/\?view=applied">4<\/a> · 回滚率 26%/);
});

test("骨架：标题、状态栏、导航、正文、页脚各就各位", () => {
  const html = shellPage({ state: state(), title: "已采纳", active: "applied", body: "<main>正文</main>" });
  assert.match(html, /<title>技能进化 · 已采纳<\/title>/);
  assert.match(html, /<p class="bar">复盘中 2/);
  assert.match(html, /<nav>\n<a href="\/\?view=pending">待处理<\/a>/);
  assert.match(html, /<\/nav>\n<main>正文<\/main>\n<footer>/);
});

test("?view= 白名单：三个新视图认，乱值一律回落待处理", () => {
  assert.equal(parsePanelView("applied"), "applied");
  assert.equal(parsePanelView("skills"), "skills");
  assert.equal(parsePanelView("skill"), "skill");
  assert.equal(parsePanelView("run"), "run");
  for (const bad of [null, "", "done2", "../skills", "SKILLS"]) {
    assert.equal(parsePanelView(bad), "pending", `${String(bad)} 不该被当成视图名`);
  }
  // actions 的 303 回跳只有列表页能显示横幅，详情页归一成待处理
  assert.equal(parseRedirectView("applied"), "applied");
  assert.equal(parseRedirectView("skills"), "skills");
  assert.equal(parseRedirectView("run"), "pending");
  assert.equal(parseRedirectView("skill"), "pending");
  assert.equal(parseView("run"), "pending");
});
