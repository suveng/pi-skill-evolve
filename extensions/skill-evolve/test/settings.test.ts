/**
 * 配置页（`?view=settings` + `POST /config`）：写死在代码里的六项搬上网页之后，
 * 校验必须**整份拒绝**、写入必须**按块合并**、页面必须**能读又能存**。
 *
 * 这三条都不是「看起来对」就够：
 * - 整份拒绝：一项非法时另外五项也不能落盘，否则用户下一次改是based在这份半成品上；
 * - 按块合并：`propose.model` / `review.model` / `web.port` 是嵌套键，摊平写会写进读不到的位置；
 * - 页面：可写实例要渲染表单、只读实例不能给一个点了必然失败的按钮。
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG, configFile, loadConfig, saveSettings } from "../lib/config.ts";
import { loadModelConfig } from "../lib/model-config.ts";
import { directQueue } from "../lib/telemetry.ts";
import {
  FOLLOW_HOST_TEXT,
  SETTINGS_BOUNDS,
  parseSettingsForm,
  readSettings,
  settingsPatchText,
} from "../lib/settings.ts";
import { renderSettingsPage } from "../lib/web/render-settings.ts";
import { collectWebState } from "../lib/web/data.ts";

function workspace(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "skill-evolve-settings-"));
  const dir = path.join(cwd, ".pi", "evolution");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function form(patch: Record<string, string>): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(patch)) params.set(key, value);
  return params;
}

test("readSettings：没有 config.json 时读出来的是默认值", () => {
  const dir = workspace();
  const values = readSettings(dir);
  assert.equal(values.propose, "inherit");
  assert.equal(values.review, "inherit");
  assert.equal(values.idleMs, DEFAULT_CONFIG.idleMs);
  assert.equal(values.maxRuntimeMs, DEFAULT_CONFIG.maxRuntimeMs);
  assert.equal(values.perSessionCap, DEFAULT_CONFIG.perSessionCap);
  assert.equal(values.metricsWindowDays, 28);
  assert.equal(values.port, DEFAULT_CONFIG.web.port);
});

test("parseSettingsForm：六项都合法 → 全部进 patch", () => {
  const parsed = parseSettingsForm(
    form({
      propose: "deepseek/deepseek-chat",
      review: "anthropic/claude-sonnet-4:thinking",
      idleMs: "120000",
      maxRuntimeMs: "1800000",
      perSessionCap: "8",
      metricsWindowDays: "90",
      port: "7799",
    }),
  );
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.patch, {
    propose: "deepseek/deepseek-chat",
    review: "anthropic/claude-sonnet-4:thinking",
    idleMs: 120_000,
    maxRuntimeMs: 1_800_000,
    perSessionCap: 8,
    metricsWindowDays: 90,
    port: 7_799,
  });
});

test("parseSettingsForm：页面上的「跟随主会话」等价于 inherit", () => {
  const parsed = parseSettingsForm(form({ propose: FOLLOW_HOST_TEXT, review: "inherit" }));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.patch.propose, "inherit");
  assert.equal(parsed.patch.review, "inherit");
});

test("parseSettingsForm：一项非法 → 整份拒绝，错误里点名是哪一项", () => {
  const cases: readonly [Record<string, string>, string][] = [
    [{ port: String(SETTINGS_BOUNDS.port.min - 1) }, "端口"],
    [{ port: "70000" }, "端口"],
    [{ idleMs: "500" }, "去抖"],
    [{ maxRuntimeMs: String(SETTINGS_BOUNDS.maxRuntimeMs.max + 1) }, "单轮上限"],
    [{ perSessionCap: "0" }, "单会话次数"],
    [{ perSessionCap: "3.5" }, "单会话次数"],
    [{ metricsWindowDays: "3" }, "趋势窗口"],
    [{ metricsWindowDays: "400" }, "趋势窗口"],
    [{ propose: "deepseek" }, "提案模型"],
    [{ review: "inherit/extra/path" }, "评审模型"],
  ];
  for (const [patch, keyword] of cases) {
    const parsed = parseSettingsForm(form({ idleMs: "90000", ...patch }));
    assert.equal(parsed.ok, false, `${JSON.stringify(patch)} 应该被拒`);
    if (parsed.ok) continue;
    assert.ok(parsed.error.includes(keyword), `错误里要含「${keyword}」，实际：${parsed.error}`);
  }
});

test("parseSettingsForm：只提交一项 → 只改这一项（其余键不出现在 patch 里）", () => {
  const parsed = parseSettingsForm(form({ idleMs: "90000" }));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.patch, { idleMs: 90_000 });
});

test("saveSettings：按块合并 —— 模型写进 propose/review，端口写进 web，其余键保留", async () => {
  const dir = workspace();
  const queue = directQueue;
  await fs.promises.writeFile(
    configFile(dir),
    `${JSON.stringify({ enabled: true, telemetry: true, autoReview: true, autoApply: false, web: { enabled: true, port: 7788 } }, null, 2)}\n`,
    "utf8",
  );

  await saveSettings(dir, { propose: "deepseek/deepseek-chat", port: 7799, perSessionCap: 6, metricsWindowDays: 14 }, queue);
  const raw = JSON.parse(fs.readFileSync(configFile(dir), "utf8")) as Record<string, unknown>;
  assert.deepEqual((raw.propose as Record<string, unknown>).model, "deepseek/deepseek-chat");
  assert.deepEqual((raw.web as Record<string, unknown>).port, 7_799);
  assert.deepEqual((raw.web as Record<string, unknown>).enabled, true);
  assert.equal(raw.perSessionCap, 6);
  assert.equal(raw.enabled, true, "没传的开关不能被这次保存改掉");
  assert.equal(raw.autoApply, false);

  const config = loadConfig(dir);
  assert.equal(config.web.port, 7_799);
  assert.equal(config.perSessionCap, 6);
  assert.equal(config.metricsWindowDays, 14);
  assert.equal(raw.metricsWindowDays, 14, "趋势窗口是顶层键，不能写进别的块");
  assert.equal(loadModelConfig(dir).propose, "deepseek/deepseek-chat");
  assert.equal(loadModelConfig(dir).review, "inherit");
});

test("saveSettings：未知键不被这次保存抹掉", async () => {
  const dir = workspace();
  const queue = directQueue;
  await fs.promises.writeFile(configFile(dir), `${JSON.stringify({ idleMs: 90000, futureKey: [1, 2] })}\n`, "utf8");
  await saveSettings(dir, { perSessionCap: 7 }, queue);
  const raw = JSON.parse(fs.readFileSync(configFile(dir), "utf8")) as Record<string, unknown>;
  assert.deepEqual(raw.futureKey, [1, 2]);
  assert.equal(raw.perSessionCap, 7);
  assert.equal(raw.idleMs, 90_000);
});

test("settingsPatchText：报出改动了哪几项（303 横幅与审计用同一句）", () => {
  assert.equal(settingsPatchText({}), "没有改动");
  assert.equal(settingsPatchText({ port: 7799 }), "已保存：端口");
  assert.ok(settingsPatchText({ idleMs: 1, perSessionCap: 2 }).includes("空闲去抖"));
  assert.equal(settingsPatchText({ metricsWindowDays: 14 }), "已保存：趋势窗口");
});

test("renderSettingsPage：可写实例渲染表单与 csrf，只读实例不渲染表单", () => {
  const dir = workspace();
  const state = collectWebState({ evolutionDir: dir });
  const editable = renderSettingsPage(readSettings(dir), state, { csrf: "tok-1", canWrite: true });
  assert.ok(editable.includes('action="/config"'));
  assert.ok(editable.includes('value="tok-1"'), "表单必须带 csrf");
  assert.ok(editable.includes("14 天") === false, "可写实例不摊只读表");
  for (const field of ['name="propose"', 'name="review"', 'name="idleMs"', 'name="maxRuntimeMs"', 'name="perSessionCap"', 'name="metricsWindowDays"', 'name="port"']) {
    assert.ok(editable.includes(field), `缺少字段 ${field}`);
  }
  assert.ok(editable.includes("重启面板"), "端口改动要提示重启");

  const readonly = renderSettingsPage(readSettings(dir), state, {});
  assert.ok(!readonly.includes('action="/config"'), "只读实例不该有表单");
  assert.ok(readonly.includes("只读"));
});
