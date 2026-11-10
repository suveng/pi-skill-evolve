/**
 * 配置默认值：别人 clone 下来必须「什么都不做」—— 默认全关、无 config.json 也不生成。
 * on/off 只切 enabled + telemetry 两个键，其余（去抖 / 超时 / 上限）原样保留。
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { configFile, DEFAULT_CONFIG, loadConfig, normalizeConfig, saveConfigSwitch, saveFlag, saveWebConfig } from "../lib/config.ts";
import { TELEMETRY_OFF_WARNING } from "../lib/flags.ts";
import { switchLine } from "../lib/report.ts";
import { directQueue } from "../lib/telemetry.ts";

function workspace(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "skill-evolve-config-"));
  return path.join(cwd, ".pi", "evolution");
}

test("DEFAULT_CONFIG：四个开关默认全关", () => {
  // 四个默认全关：clone 下来不采集、不派生、不评审、不落盘（2026-11-08 用户定）
  assert.deepEqual(
    [DEFAULT_CONFIG.enabled, DEFAULT_CONFIG.telemetry, DEFAULT_CONFIG.autoReview, DEFAULT_CONFIG.autoApply],
    [false, false, false, false],
  );
});

test("loadConfig：没有 config.json 时只开自动评审，且不会顺手造文件", () => {
  const evolutionDir = workspace();
  const config = loadConfig(evolutionDir);
  assert.deepEqual(
    [config.enabled, config.telemetry, config.autoReview, config.autoApply],
    [false, false, false, false],
  );
  assert.equal(fs.existsSync(configFile(evolutionDir)), false, "读配置不能有副作用");
});

test("normalizeConfig：空对象与缺字段都回落到默认（评审开、其余关）", () => {
  const empty = normalizeConfig({});
  assert.deepEqual([empty.enabled, empty.telemetry, empty.autoReview, empty.autoApply], [false, false, false, false]);
  const onlyEnabled = normalizeConfig({ enabled: true });
  assert.deepEqual(
    [onlyEnabled.enabled, onlyEnabled.telemetry, onlyEnabled.autoApply],
    [true, false, false],
    "只写 enabled 不等于打开采集或自动采纳",
  );
});

test("normalizeConfig：autoReview / autoApply 写错类型回落到默认值", () => {
  // 手改配置写成字符串是常事：坏值只回退那一个字段，不能让整份配置失效
  const wrong = normalizeConfig({ autoReview: "off", autoApply: 1 });
  assert.deepEqual([wrong.autoReview, wrong.autoApply], [false, false]);
  const explicit = normalizeConfig({ autoReview: false, autoApply: true, enabled: true });
  assert.deepEqual([explicit.enabled, explicit.autoReview, explicit.autoApply], [true, false, true]);
});

test("saveConfigSwitch：on 只开复盘，采集 / 评审 / 采纳都保持原值", async () => {
  const evolutionDir = workspace();
  fs.mkdirSync(evolutionDir, { recursive: true });
  fs.writeFileSync(
    configFile(evolutionDir),
    JSON.stringify({ enabled: false, telemetry: true, autoReview: false, autoApply: false, idleMs: 1_234, perSessionCap: 3 }),
    "utf8",
  );
  const next = await saveConfigSwitch(evolutionDir, true, directQueue);
  assert.deepEqual(
    [next.enabled, next.autoReview, next.telemetry, next.autoApply, next.idleMs, next.perSessionCap],
    [true, false, true, false, 1_234, 3],
  );
  const raw = JSON.parse(fs.readFileSync(configFile(evolutionDir), "utf8"));
  assert.deepEqual(
    [raw.enabled, raw.autoReview, raw.telemetry, raw.autoApply, raw.idleMs, raw.perSessionCap],
    [true, false, true, false, 1_234, 3],
    "写盘内容必须与返回值一致：on 只开复盘，采集 / 评审 / 采纳都保持原值",
  );
});

test("saveConfigSwitch：off 四个键全关，去抖等其它字段原样保留", async () => {
  const evolutionDir = workspace();
  fs.mkdirSync(evolutionDir, { recursive: true });
  fs.writeFileSync(
    configFile(evolutionDir),
    JSON.stringify({ enabled: true, telemetry: true, autoReview: true, autoApply: true, idleMs: 5_000 }),
    "utf8",
  );
  await saveConfigSwitch(evolutionDir, false, directQueue);
  const raw = JSON.parse(fs.readFileSync(configFile(evolutionDir), "utf8"));
  assert.deepEqual([raw.enabled, raw.telemetry, raw.autoReview, raw.autoApply, raw.idleMs], [false, false, false, false, 5_000]);
});

test("normalizeConfig：web 默认开 + 7788（采集/派生仍关），端口边界 1/65535 合法、整块类型不对回退", () => {
  assert.deepEqual(normalizeConfig({}).web, { enabled: true, port: 7788 });
  assert.deepEqual([normalizeConfig({}).enabled, normalizeConfig({}).telemetry], [false, false], "面板默认开 ≠ 开始烧 token");
  assert.equal(normalizeConfig({ web: { port: 1 } }).web.port, 1, "1 是合法端口，不能当假值丢掉");
  assert.equal(normalizeConfig({ web: { port: 65_535 } }).web.port, 65_535);
  assert.equal(normalizeConfig({ web: { port: 65_536 } }).web.port, 7788);
  assert.equal(normalizeConfig({ web: { port: 7788.5 } }).web.port, 7788, "非整数端口回落");
  assert.deepEqual(normalizeConfig({ web: "on" }).web, { enabled: true, port: 7788 }, "整块类型不对就整块回退");
});

test("saveConfigSwitch：不碰 web 块（开关采集/派生不该顺手关掉面板）", async () => {
  const evolutionDir = workspace();
  fs.mkdirSync(evolutionDir, { recursive: true });
  fs.writeFileSync(
    configFile(evolutionDir),
    JSON.stringify({ enabled: false, telemetry: false, web: { enabled: true, port: 7799 } }),
    "utf8",
  );
  await saveConfigSwitch(evolutionDir, true, directQueue);
  const raw = JSON.parse(fs.readFileSync(configFile(evolutionDir), "utf8"));
  assert.deepEqual(raw.web, { enabled: true, port: 7799 });
});

test("saveWebConfig：只改 web，其余键原样保留", async () => {
  const evolutionDir = workspace();
  fs.mkdirSync(evolutionDir, { recursive: true });
  fs.writeFileSync(
    configFile(evolutionDir),
    JSON.stringify({ enabled: true, telemetry: true, idleMs: 1_234, web: { enabled: false, port: 7788 } }),
    "utf8",
  );
  const next = await saveWebConfig(evolutionDir, { enabled: true, port: 7799 }, directQueue);
  assert.deepEqual([next.enabled, next.telemetry, next.idleMs, next.web.port], [true, true, 1_234, 7799]);
  const raw = JSON.parse(fs.readFileSync(configFile(evolutionDir), "utf8"));
  assert.deepEqual([raw.enabled, raw.telemetry, raw.idleMs], [true, true, 1_234], "写 web 不能把开关或去抖改掉");
  assert.deepEqual(raw.web, { enabled: true, port: 7799 });
});

test("loadConfig：坏 JSON 回落默认值，并留一行日志", () => {
  const evolutionDir = workspace();
  fs.mkdirSync(evolutionDir, { recursive: true });
  fs.writeFileSync(configFile(evolutionDir), "{ 坏掉", "utf8");
  const logs: string[] = [];
  const config = loadConfig(evolutionDir, (msg) => logs.push(msg));
  assert.deepEqual([config.enabled, config.telemetry], [false, false]);
  assert.equal(logs.length, 1);
  assert.match(logs[0]!, /配置读取失败/);
});

test("saveFlag：只改目标字段，其余键（含 web 块）原样保留", async () => {
  const evolutionDir = workspace();
  fs.mkdirSync(evolutionDir, { recursive: true });
  fs.writeFileSync(
    configFile(evolutionDir),
    JSON.stringify({ enabled: false, telemetry: false, idleMs: 1_234, web: { enabled: true, port: 7799 } }),
    "utf8",
  );
  const next = await saveFlag(evolutionDir, "telemetry", true, directQueue);
  const raw = JSON.parse(fs.readFileSync(configFile(evolutionDir), "utf8"));
  // 返回值与盘上都要是「只翻采集」：复盘、去抖、web 端口一个都不许跟着动
  assert.deepEqual([next.enabled, next.telemetry, next.idleMs, next.web.port], [false, true, 1_234, 7799]);
  assert.deepEqual([raw.enabled, raw.telemetry, raw.idleMs, raw.web], [false, true, 1_234, { enabled: true, port: 7799 }]);
});

test("saveFlag：autoReview / autoApply 各自独立，翻一个不动其它三个", async () => {
  const evolutionDir = workspace();
  fs.mkdirSync(evolutionDir, { recursive: true });
  await saveFlag(evolutionDir, "enabled", true, directQueue);
  await saveFlag(evolutionDir, "telemetry", true, directQueue);
  await saveFlag(evolutionDir, "autoReview", false, directQueue);
  const raw = JSON.parse(fs.readFileSync(configFile(evolutionDir), "utf8"));
  assert.deepEqual(
    [raw.enabled, raw.telemetry, raw.autoReview, raw.autoApply],
    [true, true, false, false],
    "关评审不能动复盘/采集，也不能顺手打开自动采纳",
  );
  await saveFlag(evolutionDir, "autoApply", true, directQueue);
  const after = JSON.parse(fs.readFileSync(configFile(evolutionDir), "utf8"));
  assert.deepEqual([after.enabled, after.telemetry, after.autoReview, after.autoApply], [true, true, false, true]);
});

test("saveFlag：两个字段互不牵连（先开复盘再关采集）", async () => {
  const evolutionDir = workspace();
  fs.mkdirSync(evolutionDir, { recursive: true });
  await saveFlag(evolutionDir, "enabled", true, directQueue);
  const raw = JSON.parse(fs.readFileSync(configFile(evolutionDir), "utf8"));
  assert.deepEqual([raw.enabled, raw.telemetry], [true, false], "只开复盘时采集仍关");
  await saveFlag(evolutionDir, "telemetry", false, directQueue);
  const after = JSON.parse(fs.readFileSync(configFile(evolutionDir), "utf8"));
  assert.deepEqual([after.enabled, after.telemetry], [true, false], "关采集不动复盘");
});

test("switchLine：四个开关各写一段，只开复盘不采集时带警告", () => {
  const base = { idleMs: 1, maxRuntimeMs: 1, perSessionCap: 1, autoReview: true, autoApply: false };
  const hint = "（collect / dispatch / review / apply 单独控制；on / off 批量切）";
  const allOff = "采集：关（不写遥测）｜复盘：关（不会派生 agent）｜评审：关（提案停在 proposed 等人工）｜采纳：关（auto 提案等人工批准）";
  const collectOnly = "采集：开（遥测写入 .pi/evolution/telemetry/）｜复盘：关（不会派生 agent）｜评审：开（提案后自动起督导）｜采纳：关（auto 提案等人工批准）";
  const both = "采集：开（遥测写入 .pi/evolution/telemetry/）｜复盘：开（会派生 agent）｜评审：开（提案后自动起督导）｜采纳：开（auto 提案自动落盘）";
  assert.equal(
    switchLine({ ...base, enabled: false, telemetry: false, autoReview: false }),
    `${allOff}${hint}`,
  );
  assert.equal(switchLine({ ...base, enabled: false, telemetry: true }), `${collectOnly}${hint}`);
  assert.equal(switchLine({ ...base, enabled: true, telemetry: true, autoApply: true }), `${both}${hint}`);
  const warn = switchLine({ ...base, enabled: true, telemetry: false, autoReview: false });
  assert.equal(warn.startsWith("采集：关（不写遥测）｜复盘：开（会派生 agent）"), true);
  assert.equal(warn.includes(TELEMETRY_OFF_WARNING), true, "只开复盘不采集：必须带警告，不许静默");
});

test("normalizeConfig：ui 两个开关缺字段回退 false，显式打开才生效", () => {
  // 2026-11-08 用户「tui 的这些推送不看了」：默认零推送是硬默认，不许因为老配置没写 ui 就回到开
  assert.deepEqual(normalizeConfig({}).ui, { widget: false, entries: false });
  assert.deepEqual(normalizeConfig({ ui: { widget: true } }).ui, { widget: true, entries: false });
  assert.deepEqual(normalizeConfig({ ui: { widget: "yes", entries: 1 } }).ui, { widget: false, entries: false }, "非布尔值一律回退");
  assert.deepEqual(normalizeConfig({ ui: "on" }).ui, { widget: false, entries: false }, "整块类型不对就整块回退");
});

/**
 * 趋势窗口（2026-11-10 从写死 28 改成配置）：窗口是「四个整周」还是「一年」，结论完全不同，
 * 所以越界不许静默截断 —— 一律回落 28，并且能被写进顶层键。
 */
test("metricsWindowDays：默认 28，越界回落 28，合法值原样保留", () => {
  assert.equal(normalizeConfig({}).metricsWindowDays, 28);
  assert.equal(normalizeConfig({ metricsWindowDays: 90 }).metricsWindowDays, 90);
  assert.equal(normalizeConfig({ metricsWindowDays: 3 }).metricsWindowDays, 28, "不足一周的窗口看不出趋势");
  assert.equal(normalizeConfig({ metricsWindowDays: 400 }).metricsWindowDays, 28);
  assert.equal(normalizeConfig({ metricsWindowDays: "30" }).metricsWindowDays, 28, "字符串不是数字");
});
