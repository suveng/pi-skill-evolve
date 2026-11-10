/**
 * 筛选栏的验收测试（用户 2026-11-08：「这个搜索框的技能和状态不用了吧, 技能不知道用来搜索什么,
 * 状态应该在顶部 tab 包含了吧」）。
 *
 * 口径：
 * 1. 表单**只剩「时间」**一个条件——技能看不出该填什么、状态与顶部 tab 重复，两个都撤掉；
 * 2. 撤掉的是**输入控件**，不是参数：`?skill=` / `?status=` 仍由 `parseListQuery` 解析，
 *    技能页点进来、旧书签、代码内部跳转都不会断；
 * 3. 表单仍是 GET + 保留 `view`，否则一提交就跳出当前页。
 *
 * 纪律：纯字符串断言，不碰文件系统、不起服务。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { parseListQuery } from "../lib/web/filter.ts";
import { renderFilterForm } from "../lib/web/render-controls.ts";

const FILTER = parseListQuery(new URLSearchParams(""));
const EXTRAS = { live: false, open: "all", only: false } as never;

function form(): string {
  return renderFilterForm("pending", FILTER, EXTRAS);
}

test("筛选栏不再有技能输入框与状态下拉", () => {
  const html = form();
  assert.ok(!html.includes('name="skill"'), "技能搜索框已撤掉");
  assert.ok(!html.includes('name="status"'), "状态下拉已撤掉（顶部 tab 就是状态）");
  assert.ok(!html.includes("全部状态"));
  assert.ok(!html.includes("全部技能"));
});

test("时间筛选还在，且三个档位齐全", () => {
  const html = form();
  assert.ok(html.includes('name="range"'));
  for (const label of ["最近 7 天", "最近 30 天", "全部时间"]) {
    assert.ok(html.includes(`>${label}<`), `缺时间档位：${label}`);
  }
});

test("表单仍是 GET，且保留 view", () => {
  const html = form();
  assert.ok(html.includes('method="get"'));
  assert.ok(html.includes('<input type="hidden" name="view" value="pending">'));
});

test("参数没被删：URL 里的 skill / status 仍然生效", () => {
  const parsed = parseListQuery(new URLSearchParams("skill=deploy-test&status=stale&range=30d"));
  assert.equal(parsed.skill, "deploy-test");
  assert.equal(parsed.status, "stale");
  assert.equal(parsed.range, "30d");
});

test("技能页跳过来的链接照旧能带 skill 参数（只是不再有输入框）", () => {
  const parsed = parseListQuery(new URLSearchParams("skill=ui-verify"));
  const html = renderFilterForm("done", parsed, EXTRAS);
  assert.ok(!html.includes('name="skill"'));
  assert.equal(parsed.skill, "ui-verify", "筛选逻辑要能吃到链接里的技能");
});
