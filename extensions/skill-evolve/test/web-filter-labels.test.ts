/**
 * 筛选栏文案的验收测试（用户 2026-11-08：「这里的下拉应该是中文, 但是这个搜索框是干嘛的?」）。
 *
 * 两条口径：
 * 1. 状态下拉的 **value 仍是状态机原文**（URL / 过滤逻辑一个字符都不改），只把给人看的一侧换中文；
 *    中文名与列表徽章必须同一套词，同一个概念全站只能有一个名字。
 * 2. 技能那个输入框是**筛选条件**，不是搜索框也不是下拉：placeholder 必须写成「技能名包含…」，
 *    让人一眼知道「填一部分就够」。
 *
 * 纪律：纯字符串断言，不碰文件系统、不起服务。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { parseListQuery, STATUS_LABEL, STATUS_OPTIONS } from "../lib/web/filter.ts";
import { renderFilterForm } from "../lib/web/render-controls.ts";

const FILTER = parseListQuery(new URLSearchParams(""));
const EXTRAS = { live: false, open: "all", only: false } as never;

function form(): string {
  return renderFilterForm("pending", FILTER, EXTRAS);
}

test("状态下拉每一项都显示中文，value 保持状态机原文", () => {
  const html = form();
  for (const status of STATUS_OPTIONS) {
    assert.ok(html.includes(`value="${status}"`), `value 必须是 ${status}`);
    assert.ok(html.includes(`>${STATUS_LABEL[status]}<`), `${status} 要显示成 ${STATUS_LABEL[status]}`);
  }
});

test("状态下拉里不出现英文状态词", () => {
  const html = form();
  const select = html.slice(html.indexOf('name="status"'), html.indexOf("</select>", html.indexOf('name="status"')));
  for (const status of STATUS_OPTIONS) {
    assert.ok(!select.includes(`>${status}<`), `不应再出现英文项 >${status}<`);
  }
});

test("中文标签覆盖七个可选状态，且没有空值", () => {
  assert.equal(Object.keys(STATUS_LABEL).length, STATUS_OPTIONS.length);
  for (const label of Object.values(STATUS_LABEL)) assert.ok(label.trim().length > 0);
});

test("技能输入框的 placeholder 说明它是筛选条件", () => {
  const html = form();
  assert.ok(html.includes('name="skill"'));
  assert.ok(html.includes('placeholder="技能名包含…"'), "要告诉人这里填的是「技能名的一部分」");
  assert.ok(!html.includes('placeholder="全部技能"'), "旧 placeholder 让人误以为是静态字段");
});

test("筛选表单仍然是 GET + 保留 view", () => {
  const html = form();
  assert.ok(html.includes('method="get"'));
  assert.ok(html.includes('<input type="hidden" name="view" value="pending">'));
});
