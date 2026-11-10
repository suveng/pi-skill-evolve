/**
 * 列表筛选 + 分页：query 语义、三页各用哪个字段、翻页链接保留筛选参数。
 * 纯函数测试，不读盘、不起服务。
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { ApprovalItem, DoneItem, PendingItem, WebState } from "../lib/web/data.ts";
import {
  NO_FILTER,
  PAGE_SIZE,
  buildViewPage,
  isDefaultFilter,
  pageHref,
  paginate,
  parseListQuery,
  parseView,
  rangeStart,
  type ListFilter,
} from "../lib/web/filter.ts";

const NOW = Date.UTC(2026, 10, 8, 12);
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function filter(overrides: Partial<ListFilter> = {}): ListFilter {
  return { ...NO_FILTER, ...overrides };
}

function pending(runId: string, kind: PendingItem["kind"], skill: string, at: number | null): PendingItem {
  return { runId, kind, skill, at, detail: `${runId} 的详情` };
}

function done(runId: string, status: string, skill: string, at: number | null): DoneItem {
  return { runId, status, source: "run", level: "auto", skill, at, detail: `${runId} 的详情` };
}

function approval(runId: string, skill: string): ApprovalItem {
  return { runId, skill, level: "approval", targets: [], createdAt: NOW, proposal: null, review: null, detail: "" };
}

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

test("parseListQuery：缺省 → 全部技能 / 全部状态 / 7d / 第 1 页", () => {
  assert.deepEqual(parseListQuery(new URLSearchParams()), { skill: "", status: "", range: "7d", page: 1 });
  assert.equal(parseListQuery(new URLSearchParams("skill=%20demo%20")).skill, "demo", "技能名去空格");
});

test("parseListQuery：未知 range 与非法 page 一律回落默认（筛选不报错）", () => {
  assert.equal(parseListQuery(new URLSearchParams("range=nope")).range, "7d");
  assert.equal(parseListQuery(new URLSearchParams("range=all")).range, "all");
  for (const page of ["0", "-3", "abc", ""]) {
    assert.equal(parseListQuery(new URLSearchParams(`page=${page}`)).page, 1, `page=${page} 归 1`);
  }
  assert.equal(parseListQuery(new URLSearchParams("page=2")).page, 2);
});

test("paginate：25 条时 page=2 取第 21-25 条，越界夹到最后一页", () => {
  const rows = Array.from({ length: 25 }, (_, index) => index + 1);
  const second = paginate(rows, 2);
  assert.equal(second.rows[0], 21);
  assert.equal(second.rows.at(-1), 25);
  assert.equal(second.page, 2);
  assert.equal(second.pages, 2);
  assert.equal(second.total, 25);
  assert.equal(paginate(rows, 99).page, 2, "页码越界夹到最后一页而不是空列表");
  assert.equal(paginate(rows, 0).page, 1);
  const empty = paginate([], 1);
  assert.deepEqual([empty.page, empty.pages, empty.total], [1, 1, 0], "空列表也要有 1 页，否则页脚消失");
  assert.equal(PAGE_SIZE, 20);
});

test("buildViewPage(pending)：skill 精确匹配 + kind→status 映射 + range 过滤", () => {
  const sample = state({
    pending: [
      pending("run-1", "stale", "demo", NOW - HOUR),
      pending("run-2", "approval", "demo", NOW - 2 * HOUR),
      pending("run-3", "stale", "demo2", NOW - HOUR),
      pending("run-4", "stale", "demo", NOW - 8 * DAY),
      pending("run-5", "stale", "demo", null),
    ],
  });
  const bySkill = buildViewPage(sample, "pending", filter({ skill: "demo", range: "all" }), NOW);
  assert.deepEqual(
    bySkill.rows.map((item) => item.runId),
    ["run-1", "run-2", "run-4", "run-5"],
    "skill=demo 不能把 demo2 带进来",
  );
  const byStatus = buildViewPage(sample, "pending", filter({ status: "approval", range: "all" }), NOW);
  assert.deepEqual(
    byStatus.rows.map((item) => item.runId),
    ["run-2"],
    "待批的 status 就是 approval",
  );
  const recent = buildViewPage(sample, "pending", filter({ range: "24h" }), NOW);
  assert.deepEqual(
    recent.rows.map((item) => item.runId),
    ["run-1", "run-2", "run-3"],
    "at 为 null 的（run-5）不冒充「最近 24 小时」，8 天前的（run-4）也被挡掉",
  );
});

test("buildViewPage(done)：status / skill / range 三个条件叠加", () => {
  // 已采纳已经单独成 tab，所以 done 里只会有回滚 / 失败 / 否决 / 被顶替这四种终态
  const sample = state({
    done: [
      done("run-a", "rolled-back", "demo", NOW - HOUR),
      done("run-b", "rejected", "demo", NOW - HOUR),
      done("run-c", "rolled-back", "other", NOW - HOUR),
      done("run-d", "rolled-back", "demo", NOW - 10 * DAY),
    ],
  });
  const rolledBack = buildViewPage(sample, "done", filter({ status: "rolled-back", skill: "demo", range: "7d" }), NOW);
  assert.deepEqual(
    rolledBack.rows.map((item) => item.runId),
    ["run-a"],
  );
  const all = buildViewPage(sample, "done", filter(), NOW);
  assert.equal(all.total, 4);
});

test("buildViewPage(approvals)：不分页，rows 原样（待批本身很短）", () => {
  const sample = state({ approvals: [approval("run-x", "demo"), approval("run-y", "other")] });
  const page = buildViewPage(sample, "approvals", filter({ skill: "demo" }), NOW);
  assert.equal(page.page, 1);
  assert.equal(page.pages, 1);
  assert.equal(page.total, 2, "待批页不受筛选影响（筛选表单只在三个列表页渲染）");
});

test("buildViewPage(done)：45 条时 page=2 拿到第 21-40 条", () => {
  const rows = Array.from({ length: 45 }, (_, index) => done(`run-${index + 1}`, "failed", "demo", NOW - HOUR));
  const page = buildViewPage(state({ done: rows }), "done", filter({ page: 2 }), NOW);
  assert.equal(page.page, 2);
  assert.equal(page.pages, 3);
  assert.equal(page.total, 45);
  assert.equal(page.rows.length, PAGE_SIZE);
  assert.equal(page.rows[0]?.runId, "run-21");
  assert.equal(page.rows.at(-1)?.runId, "run-40");
});

test("pageHref：保留 skill / status / range，空的不写进链接", () => {
  const href = pageHref("done", filter({ skill: "demo", status: "applied", range: "30d", page: 2 }), 3);
  const url = new URL(`http://x${href}`);
  assert.equal(url.searchParams.get("view"), "done");
  assert.equal(url.searchParams.get("skill"), "demo");
  assert.equal(url.searchParams.get("status"), "applied");
  assert.equal(url.searchParams.get("range"), "30d");
  assert.equal(url.searchParams.get("page"), "3");
  const bare = new URL(`http://x${pageHref("pending", filter(), 2)}`);
  assert.equal(bare.searchParams.get("skill"), null);
  assert.equal(bare.searchParams.get("status"), null);
  assert.equal(bare.searchParams.get("page"), "2");
});

test("parseView 白名单 / isDefaultFilter / rangeStart", () => {
  assert.equal(parseView("reports"), "pending", "复盘报告页已下线，旧链接回落待处理");
  assert.equal(parseView("done"), "done");
  for (const bad of [null, "", "nope", "../x"]) assert.equal(parseView(bad), "pending", `parseView(${bad})`);
  assert.equal(isDefaultFilter(filter({ range: "7d" })), true);
  assert.equal(isDefaultFilter(filter({ range: "7d", page: 2 })), false);
  assert.equal(isDefaultFilter(filter({ range: "7d", skill: "demo" })), false);
  assert.equal(rangeStart("all", NOW), null);
  assert.equal(rangeStart("24h", NOW), NOW - DAY);
  assert.equal(rangeStart("7d", NOW), NOW - 7 * DAY);
  assert.equal(rangeStart("30d", NOW), NOW - 30 * DAY);
});
