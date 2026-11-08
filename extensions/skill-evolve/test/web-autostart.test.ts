/**
 * 面板生命周期：跟着 pi 进程走（`/skill-evolve` 2026-11-08 需求「reload web 界面没了」）。
 *
 * 全部注入：`start` 是假实现，`sleep` 是记录器 —— 不起子进程、不占端口、不等真时长。
 * 判据口径：`locks/web.json` 里 pid == 本进程算 `/reload` 残影（可重试），别的活 pid 才算抢手。
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { configFile, DEFAULT_CONFIG, loadConfig, normalizeConfig } from "../lib/config.ts";
import { directQueue } from "../lib/telemetry.ts";
import { createWebLifecycle, maybeStartWeb, type WebLifecycle, type WebStartResult } from "../lib/web/autostart.ts";
import { writeWebPid } from "../lib/web/panel-pid.ts";
import type { WebPanelResult } from "../lib/web/server.ts";

/** 不存在的 pid：Linux 的 pid_max 远小于 INT32_MAX，这个号系统里不会有进程 */
const DEAD_PID = 2_147_483_646;
const URL_7788 = "http://127.0.0.1:7788";
const IN_USE: WebStartResult = { ok: false, code: "EADDRINUSE", message: "端口被占用" };

function workspace(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "skill-evolve-autostart-"));
  const evolutionDir = path.join(cwd, ".pi", "evolution");
  fs.mkdirSync(evolutionDir, { recursive: true });
  return evolutionDir;
}

function webConfig(enabled: boolean, port = 7788) {
  return normalizeConfig({ web: { enabled, port } });
}

/** 按顺序回放的启动器：超出长度就重复最后一条（「一直占着」用它），并记下每次请求的端口 */
function scripted(results: WebStartResult[]): { calls: number[]; start: (port: number) => Promise<WebStartResult> } {
  const calls: number[] = [];
  return {
    calls,
    start: async (port: number): Promise<WebStartResult> => {
      calls.push(port);
      const index = Math.min(calls.length - 1, results.length - 1);
      return results[index]!;
    },
  };
}

function sleepRecorder(): { delays: number[]; sleep: (ms: number) => Promise<void> } {
  const delays: number[] = [];
  return { delays, sleep: async (ms: number): Promise<void> => void delays.push(ms) };
}

/** 假面板：记下 start 请求的端口与 close 调用，close 异步一跳（不 await 就会看到 closed=false） */
function fakeServer(): { starts: number[]; closes: number[]; closed: () => boolean; start: (port?: number) => Promise<WebPanelResult> } {
  const starts: number[] = [];
  const closes: number[] = [];
  let closedYet = false;
  return {
    starts,
    closes,
    closed: () => closedYet,
    start: async (port?: number): Promise<WebPanelResult> => {
      const actual = port ?? 7788;
      starts.push(actual);
      return {
        ok: true,
        panel: {
          url: `http://127.0.0.1:${actual}`,
          host: "127.0.0.1",
          port: actual,
          csrf: "test-csrf",
          close: async (): Promise<void> => {
            await new Promise<void>((done) => setImmediate(done));
            closedYet = true;
            closes.push(actual);
          },
        },
      };
    },
  };
}

function lifecycleOf(evolutionDir: string, logs: string[] = []): WebLifecycle & { fake: ReturnType<typeof fakeServer> } {
  const fake = fakeServer();
  const lifecycle = createWebLifecycle({ evolutionDir: () => evolutionDir, start: fake.start, queue: directQueue, log: (msg) => void logs.push(msg) });
  return Object.assign(lifecycle, { fake });
}

test("旧配置没有 web 块：默认关闭 + 端口 7788，且不算无效配置", () => {
  const evolutionDir = workspace();
  // 2026-11-08 之前的 config.json 就长这样，没有 web 键
  fs.writeFileSync(configFile(evolutionDir), JSON.stringify({ enabled: false, telemetry: false, idleMs: 90_000 }), "utf8");
  const logs: string[] = [];
  const config = loadConfig(evolutionDir, (msg) => logs.push(msg));
  assert.deepEqual(config.web, { enabled: DEFAULT_CONFIG.web.enabled, port: DEFAULT_CONFIG.web.port });
  assert.deepEqual([config.web.enabled, config.web.port], [true, 7788], "面板默认随 pi 启动（采集/派生仍关）");
  assert.equal(config.idleMs, 90_000, "老字段照旧生效，缺 web 不等于配置坏了");
  assert.deepEqual(logs, [], "缺 web 块是正常情况，不该刷日志");
});

test("web.port 非法：0 / 70000 / \"8080\" 都回落 7788 并各留一行 warn", () => {
  for (const bad of [0, 70_000, "8080"]) {
    const logs: string[] = [];
    const config = normalizeConfig({ web: { enabled: true, port: bad } }, (msg) => logs.push(msg));
    assert.equal(config.web.port, 7788, `非法端口 ${String(bad)} 应回落 7788`);
    assert.equal(config.web.enabled, true, "端口写错不该牵连 enabled");
    assert.equal(logs.length, 1);
    assert.match(logs[0]!, /web\.port 非法/);
  }
});

test("web.enabled=false：一次 start 都不调", async () => {
  const launcher = scripted([{ ok: true, url: URL_7788 }]);
  const result = await maybeStartWeb({ config: webConfig(false), evolutionDir: workspace(), start: launcher.start });
  assert.deepEqual(result, { started: false, reason: "disabled" });
  assert.deepEqual(launcher.calls, []);
});

test("web.enabled=true：起一次就成，日志写「随会话启动」", async () => {
  const launcher = scripted([{ ok: true, url: URL_7788 }]);
  const logs: string[] = [];
  const result = await maybeStartWeb({
    config: webConfig(true, 7788),
    evolutionDir: workspace(),
    start: launcher.start,
    log: (msg) => void logs.push(msg),
  });
  assert.deepEqual(result, { started: true, url: URL_7788 });
  assert.deepEqual(launcher.calls, [7788]);
  assert.match(logs[0]!, /web 面板随会话启动：http:\/\/127\.0\.0\.1:7788/);
});

test("端口占用但记录里是别的活进程：不重试、不抢", async () => {
  const evolutionDir = workspace();
  // 父进程一定活着且不是本进程：真实活 pid，不用起子进程也不用真占端口
  writeWebPid(evolutionDir, { pid: process.ppid, host: "127.0.0.1", port: 7788, url: URL_7788, startedAt: Date.now() });
  const launcher = scripted([IN_USE]);
  const sleeps = sleepRecorder();
  const logs: string[] = [];
  const result = await maybeStartWeb({
    config: webConfig(true),
    evolutionDir,
    start: launcher.start,
    sleep: sleeps.sleep,
    log: (msg) => void logs.push(msg),
  });
  assert.deepEqual(result, { started: false, reason: "owned-elsewhere", url: URL_7788 });
  assert.equal(launcher.calls.length, 1, "别人的活面板：一次都不该重试");
  assert.deepEqual(sleeps.delays, []);
  assert.match(logs[0]!, new RegExp(`由 pid ${process.ppid} 持有`));
});

test("端口占用但记录里的 pid 已死：重试一次就成功，间隔 300ms", async () => {
  const evolutionDir = workspace();
  writeWebPid(evolutionDir, { pid: DEAD_PID, host: "127.0.0.1", port: 7788, url: URL_7788, startedAt: Date.now() });
  const launcher = scripted([IN_USE, { ok: true, url: URL_7788 }]);
  const sleeps = sleepRecorder();
  const result = await maybeStartWeb({ config: webConfig(true), evolutionDir, start: launcher.start, sleep: sleeps.sleep });
  assert.deepEqual(result, { started: true, url: URL_7788 });
  assert.equal(launcher.calls.length, 2);
  assert.deepEqual(sleeps.delays, [300]);
});

test("记录 pid 就是本进程（/reload 残影）：允许重试，不当成别的实例", async () => {
  const evolutionDir = workspace();
  // /reload 不换 pid：旧实例留下的记录 pid 与当前进程相同，只能靠这个判据区分
  writeWebPid(evolutionDir, { pid: process.pid, host: "127.0.0.1", port: 7788, url: URL_7788, startedAt: Date.now() });
  const launcher = scripted([IN_USE, { ok: true, url: URL_7788 }]);
  const sleeps = sleepRecorder();
  const logs: string[] = [];
  const result = await maybeStartWeb({
    config: webConfig(true),
    evolutionDir,
    start: launcher.start,
    sleep: sleeps.sleep,
    log: (msg) => void logs.push(msg),
  });
  assert.deepEqual(result, { started: true, url: URL_7788 });
  assert.equal(launcher.calls.length, 2);
  assert.deepEqual(sleeps.delays, [300]);
  assert.match(logs.join("\n"), /重试 1\/3：端口 7788 仍被占用/);
});

test("一直 EADDRINUSE：重试 3 次（间隔 300/600/900）后判 failed", async () => {
  const launcher = scripted([IN_USE]);
  const sleeps = sleepRecorder();
  const logs: string[] = [];
  const result = await maybeStartWeb({
    config: webConfig(true),
    evolutionDir: workspace(),
    start: launcher.start,
    sleep: sleeps.sleep,
    log: (msg) => void logs.push(msg),
  });
  assert.equal(result.started, false);
  assert.equal(result.started === false ? result.reason : "", "failed");
  assert.equal(launcher.calls.length, 4, "首次 + 3 次重试");
  assert.deepEqual(sleeps.delays, [300, 600, 900]);
  assert.match(logs.at(-1)!, /web 面板未启动（端口 7788）/);
});

test("EACCES 不重试：没权限换端口才有用", async () => {
  const launcher = scripted([{ ok: false, code: "EACCES", message: "没有权限监听" }]);
  const sleeps = sleepRecorder();
  const result = await maybeStartWeb({ config: webConfig(true), evolutionDir: workspace(), start: launcher.start, sleep: sleeps.sleep });
  assert.equal(result.started === false ? result.reason : "", "failed");
  assert.equal(launcher.calls.length, 1);
  assert.deepEqual(sleeps.delays, []);
});

test("session_start 时配置没开：一个 start 都不发", async () => {
  const evolutionDir = workspace();
  fs.mkdirSync(evolutionDir, { recursive: true });
  fs.writeFileSync(path.join(evolutionDir, "config.json"), JSON.stringify({ web: { enabled: false } }), "utf8");
  const lifecycle = lifecycleOf(evolutionDir);
  await lifecycle.startForSession();
  assert.equal(lifecycle.url(), undefined);
  assert.deepEqual(lifecycle.fake.starts, []);
});

test("web 命令成功：把 web.enabled=true 与端口写回配置，重复执行只回「已在」", async () => {
  const evolutionDir = workspace();
  const logs: string[] = [];
  const lifecycle = lifecycleOf(evolutionDir, logs);
  const text = await lifecycle.command({ once: false, port: 7799 });
  assert.match(text, /面板已起：http:\/\/127\.0\.0\.1:7799（已在配置里开启，pi 启动时会自动起；换端口 --port 7799）/);
  const raw = JSON.parse(fs.readFileSync(configFile(evolutionDir), "utf8"));
  assert.deepEqual([raw.web.enabled, raw.web.port], [true, 7799], "端口一起记，下次自动起才落同一地址");
  assert.equal(lifecycle.url(), "http://127.0.0.1:7799");
  assert.match(await lifecycle.command({ once: false }), /面板已在 http:\/\/127\.0\.0\.1:7799 运行/);
  assert.deepEqual(lifecycle.fake.starts, [7799], "单例：第二次不该再起");
});

test("web --once：起来了但不写进配置", async () => {
  const evolutionDir = workspace();
  fs.writeFileSync(configFile(evolutionDir), JSON.stringify({ enabled: false, telemetry: false }), "utf8");
  const lifecycle = lifecycleOf(evolutionDir);
  const text = await lifecycle.command({ once: true });
  assert.match(text, /面板已起：http:\/\/127\.0\.0\.1:7788（--once：只本次会话有效，没写进配置）/);
  const raw = JSON.parse(fs.readFileSync(configFile(evolutionDir), "utf8"));
  assert.notEqual(raw.web?.enabled, true, "--once 不能把下次启动也带上");
  assert.equal(lifecycle.url(), URL_7788);
});

test("off / disable：关面板（等 close 完成）并把 web.enabled 写回 false", async () => {
  const evolutionDir = workspace();
  fs.writeFileSync(configFile(evolutionDir), JSON.stringify({ enabled: false, telemetry: false, web: { enabled: true, port: 7900 } }), "utf8");
  const lifecycle = lifecycleOf(evolutionDir);
  await lifecycle.startForSession();
  assert.equal(lifecycle.url(), "http://127.0.0.1:7900", "配置开着就在会话启动时自动起");
  const text = await lifecycle.disable();
  assert.deepEqual(lifecycle.fake.closes, [7900]);
  assert.equal(lifecycle.url(), undefined);
  const raw = JSON.parse(fs.readFileSync(configFile(evolutionDir), "utf8"));
  assert.deepEqual([raw.web.enabled, raw.web.port], [false, 7900], "只关开关，端口原样保留");
  assert.match(text, /web\.enabled=false/);
});

test("session_shutdown：等面板 close 完成再返回（/reload 后新实例才能复用同一端口）", async () => {
  const evolutionDir = workspace();
  fs.writeFileSync(configFile(evolutionDir), JSON.stringify({ web: { enabled: true, port: 7788 } }), "utf8");
  const logs: string[] = [];
  const lifecycle = lifecycleOf(evolutionDir, logs);
  await lifecycle.startForSession();
  await lifecycle.shutdown("reload");
  assert.equal(lifecycle.fake.closed(), true, "shutdown 返回时必须已经关完");
  assert.deepEqual(lifecycle.fake.closes, [7788]);
  assert.match(logs.join("\n"), /web 面板关闭（reason=reload）/);
});
