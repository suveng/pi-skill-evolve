/**
 * `POST /action` 的三个动作：run / rerun / cleanup，以及开关入口 `POST /toggle?field=` ——
 * 参数校验、回调调用次数、以及「成功与失败都写一条审计」。真监听 127.0.0.1（port=0），不起子进程。
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { readAudit } from "../lib/web/audit-log.ts";
import { startWebPanel, type WebPanel, type WebPanelOptions } from "../lib/web/server.ts";
import { moveRunToTrash } from "../lib/web/trash.ts";

const FORM = "application/x-www-form-urlencoded";

function workspace(
  options: {
    enabled?: boolean;
    telemetry?: boolean;
    autoReview?: boolean;
    autoApply?: boolean;
    runs?: { runId: string; status: string }[];
  } = {},
): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "skill-evolve-webaction-"));
  const evolutionDir = path.join(cwd, ".pi", "evolution");
  fs.mkdirSync(path.join(evolutionDir, "runs"), { recursive: true });
  fs.writeFileSync(
    path.join(evolutionDir, "config.json"),
    JSON.stringify({
      enabled: options.enabled === true,
      telemetry: options.telemetry === true,
      autoReview: options.autoReview === true,
      autoApply: options.autoApply === true,
    }),
    "utf8",
  );
  for (const run of options.runs ?? []) {
    const runDir = path.join(evolutionDir, "runs", run.runId);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(
      path.join(runDir, "run.json"),
      JSON.stringify({ runId: run.runId, status: run.status, dispatchedAt: Date.now() - 60_000 }),
      "utf8",
    );
  }
  return evolutionDir;
}

async function open(evolutionDir: string, extra: Partial<WebPanelOptions> = {}): Promise<WebPanel> {
  const result = await startWebPanel({ evolutionDir, port: 0, ...extra });
  assert.equal(result.ok, true, `面板应该起来：${result.ok ? "" : result.message}`);
  if (!result.ok) throw new Error("unreachable");
  return result.panel;
}

async function post(panel: WebPanel, pathname: string, form: Record<string, string>): Promise<Response> {
  return fetch(`${panel.url}${pathname}`, {
    method: "POST",
    headers: { "content-type": FORM },
    body: new URLSearchParams(form).toString(),
    redirect: "manual",
  });
}

/** 记一次调用的假回调：断言「恰一次」比断言返回值更能发现重复执行 */
function spy<T>(result: T): { calls: unknown[]; fn: (...args: unknown[]) => Promise<T> } {
  const calls: unknown[] = [];
  return {
    calls,
    fn: async (...args: unknown[]) => {
      calls.push(args[0]);
      return result;
    },
  };
}

/** 两个参数的开关回调：采集与复盘是同一类型的钩子（field, next），要同时看两个参数 */
function spyToggle(result: string): { calls: [string, boolean][]; fn: (field: string, next: boolean) => Promise<string> } {
  const calls: [string, boolean][] = [];
  return { calls, fn: async (field: string, next: boolean) => (calls.push([field, next]), result) };
}

test("POST /toggle?field=enabled：只调 onToggle(\"enabled\", 取反)，审计记 field", async () => {
  const evolutionDir = workspace({ enabled: true });
  const toggle = spyToggle("自动复盘已关闭");
  const panel = await open(evolutionDir, { onToggle: toggle.fn });
  try {
    const response = await post(panel, "/toggle?field=enabled", { csrf: panel.csrf, view: "done" });
    assert.equal(response.status, 303);
    assert.deepEqual(toggle.calls, [["enabled", false]], "当前是开的 → 传 false（取反，不是传页面上的旧文字）");
    const location = new URL(response.headers.get("location") ?? "", panel.url);
    assert.equal(location.searchParams.get("view"), "done", "回跳到点按钮时那一页");
    assert.equal(location.searchParams.get("msg"), "自动复盘已关闭");
    const audit = readAudit(evolutionDir);
    assert.equal(audit.length, 1);
    assert.equal(audit[0]?.action, "toggle");
    assert.equal(audit[0]?.field, "enabled");
    assert.equal(audit[0]?.result, "ok");
    assert.equal(audit[0]?.via, "web");
  } finally {
    await panel.close();
  }
});

test("POST /toggle?field=telemetry：只动采集，不动复盘", async () => {
  const evolutionDir = workspace({ enabled: true, telemetry: false });
  const toggle = spyToggle("采集遥测已开启");
  const panel = await open(evolutionDir, { onToggle: toggle.fn });
  try {
    assert.equal((await post(panel, "/toggle?field=telemetry", { csrf: panel.csrf })).status, 303);
    assert.deepEqual(toggle.calls, [["telemetry", true]], "当前采集是关的 → 传 true，且 field 只能是 telemetry");
    assert.equal(readAudit(evolutionDir).at(-1)?.field, "telemetry");
  } finally {
    await panel.close();
  }
});

test("POST /toggle?field=autoReview：只动评审，复盘 / 采集 / 采纳一个都不动", async () => {
  const evolutionDir = workspace({ enabled: true, telemetry: true, autoReview: true });
  const toggle = spyToggle("自动评审已关闭");
  const panel = await open(evolutionDir, { onToggle: toggle.fn });
  try {
    assert.equal((await post(panel, "/toggle?field=autoReview", { csrf: panel.csrf })).status, 303);
    assert.deepEqual(toggle.calls, [["autoReview", false]], "当前评审是开的 → 传 false，且 field 只能是 autoReview");
    assert.equal(readAudit(evolutionDir).at(-1)?.field, "autoReview");
  } finally {
    await panel.close();
  }
});

test("POST /toggle?field=autoApply：关着的采纳能被单独打开，且不动其它三个", async () => {
  const evolutionDir = workspace({ enabled: true, telemetry: true, autoReview: true, autoApply: false });
  const toggle = spyToggle("自动采纳已开启");
  const panel = await open(evolutionDir, { onToggle: toggle.fn });
  try {
    assert.equal((await post(panel, "/toggle?field=autoApply", { csrf: panel.csrf })).status, 303);
    assert.deepEqual(toggle.calls, [["autoApply", true]]);
    assert.equal(readAudit(evolutionDir).at(-1)?.field, "autoApply");
  } finally {
    await panel.close();
  }
});

test("POST /toggle 的 field 越界 / 缺失：400，不调回调，写一条带原值的 error 审计", async () => {
  const evolutionDir = workspace({ enabled: true, telemetry: true });
  const toggle = spyToggle("不该被调用");
  const panel = await open(evolutionDir, { onToggle: toggle.fn });
  try {
    const wrong = await post(panel, "/toggle?field=propose", { csrf: panel.csrf });
    assert.equal(wrong.status, 400);
    assert.match(await wrong.text(), /field 只认 telemetry \/ enabled \/ autoReview \/ autoApply/);
    const missing = await post(panel, "/toggle", { csrf: panel.csrf });
    assert.equal(missing.status, 400, "缺 field 不能猜一个默认值");
    assert.deepEqual(toggle.calls, [], "越界不放行到回调");
    const audit = readAudit(evolutionDir);
    assert.deepEqual(
      audit.map((entry) => [entry.action, entry.field, entry.result.startsWith("error: ")]),
      [["toggle", "propose", true], ["toggle", undefined, true]],
    );
  } finally {
    await panel.close();
  }
});

test("POST /action name=run：onRunNow 恰一次；派发了记 ok、没派发记 partial", async () => {
  const evolutionDir = workspace();
  const runNow = spy("已派生复盘：run-new（pid 4242）");
  const panel = await open(evolutionDir, { onRunNow: runNow.fn as () => Promise<string> });
  try {
    assert.equal((await post(panel, "/action", { csrf: panel.csrf, name: "run" })).status, 303);
    assert.equal(runNow.calls.length, 1, "点一次只能派发一次");
    assert.equal(readAudit(evolutionDir).at(-1)?.result, "ok");
  } finally {
    await panel.close();
  }
  const skipped = spy("技能进化总开关是关的：不改配置就只读历史");
  const second = await open(evolutionDir, { onRunNow: skipped.fn as () => Promise<string> });
  try {
    assert.equal((await post(second, "/action", { csrf: second.csrf, name: "run" })).status, 303);
    const audit = readAudit(evolutionDir).at(-1);
    assert.equal(audit?.action, "run");
    assert.equal(audit?.result, "partial", "没派发就是 partial：否则「点了十次都没跑」查不出来");
  } finally {
    await second.close();
  }
});

test("POST /action name=rerun：不带旧 runId 派发（不复用），审计记下点的是哪一条", async () => {
  const evolutionDir = workspace({ runs: [{ runId: "run-a", status: "reviewed" }] });
  const runNow = spy("已派生复盘：run-b（pid 7）");
  const panel = await open(evolutionDir, { onRunNow: runNow.fn as () => Promise<string> });
  try {
    assert.equal((await post(panel, "/action", { csrf: panel.csrf, name: "rerun", runId: "run-a" })).status, 303);
    assert.equal(runNow.calls.length, 1);
    const audit = readAudit(evolutionDir).at(-1);
    assert.equal(audit?.action, "rerun");
    assert.equal(audit?.runId, "run-a");
    assert.equal(audit?.result, "ok");
  } finally {
    await panel.close();
  }
});

test("POST /action name=rerun：runId 不存在 → 400、不派发、写一条 error 审计", async () => {
  const evolutionDir = workspace();
  const runNow = spy("已派生复盘：run-b");
  const panel = await open(evolutionDir, { onRunNow: runNow.fn as () => Promise<string> });
  try {
    const response = await post(panel, "/action", { csrf: panel.csrf, name: "rerun", runId: "run-missing" });
    assert.equal(response.status, 400);
    assert.match(await response.text(), /找不到这个 run/);
    assert.deepEqual(runNow.calls, [], "目标不存在时一次都不能派发");
    const audit = readAudit(evolutionDir).at(-1);
    assert.equal(audit?.action, "rerun");
    assert.match(audit?.result ?? "", /^error: 找不到这个 run/);
  } finally {
    await panel.close();
  }
});

test("POST /action name=cleanup：stale 的 run 被移进 runs/.trash/，审计 ok", async () => {
  const evolutionDir = workspace({ runs: [{ runId: "run-dead", status: "stale" }] });
  const cleanup = spy("");
  const panel = await open(evolutionDir, {
    onCleanup: (runId: string) => {
      cleanup.calls.push(runId);
      return Promise.resolve(moveRunToTrash(evolutionDir, runId));
    },
  });
  try {
    const response = await post(panel, "/action", { csrf: panel.csrf, name: "cleanup", runId: "run-dead" });
    assert.equal(response.status, 303);
    assert.deepEqual(cleanup.calls, ["run-dead"]);
    assert.equal(fs.existsSync(path.join(evolutionDir, "runs", "run-dead")), false, "原目录不该还在");
    const trash = fs.readdirSync(path.join(evolutionDir, "runs", ".trash"));
    assert.equal(trash.length, 1);
    assert.match(trash[0]!, /^run-dead-\d{8}-\d{6}$/);
    assert.equal(fs.existsSync(path.join(evolutionDir, "runs", ".trash", trash[0]!, "run.json")), true, "是移动不是删除");
    const audit = readAudit(evolutionDir).at(-1);
    assert.equal(audit?.action, "cleanup");
    assert.equal(audit?.runId, "run-dead");
    assert.equal(audit?.result, "ok");
  } finally {
    await panel.close();
  }
});

test("POST /action name=cleanup：非 stale 一律拒绝（不移动、写 error 审计）", async () => {
  const evolutionDir = workspace({ runs: [{ runId: "run-live", status: "applied" }] });
  const cleanup = spy("");
  const panel = await open(evolutionDir, { onCleanup: cleanup.fn as (runId: string) => Promise<string> });
  try {
    const response = await post(panel, "/action", { csrf: panel.csrf, name: "cleanup", runId: "run-live" });
    assert.equal(response.status, 400);
    assert.match(await response.text(), /只有卡死（stale）的 run 能清理，当前状态：applied/);
    assert.deepEqual(cleanup.calls, [], "非 stale 不能调清理");
    assert.equal(fs.existsSync(path.join(evolutionDir, "runs", "run-live")), true, "目录还在");
    const audit = readAudit(evolutionDir).at(-1);
    assert.equal(audit?.action, "cleanup");
    assert.match(audit?.result ?? "", /^error: 只有卡死/);
  } finally {
    await panel.close();
  }
});

test("回调抛错：303 带 err 而不是 500，同时写一条 error 审计", async () => {
  const evolutionDir = workspace({ enabled: false });
  const panel = await open(evolutionDir, {
    onToggle: () => Promise.reject(new Error("config.json 不可写：EACCES")),
  });
  try {
    const response = await post(panel, "/toggle?field=telemetry", { csrf: panel.csrf });
    assert.equal(response.status, 303);
    const location = new URL(response.headers.get("location") ?? "", panel.url);
    assert.equal(location.searchParams.get("err"), "Error: config.json 不可写：EACCES");
    assert.equal((await fetch(panel.url)).status, 200, "面板本身照常工作");
    const audit = readAudit(evolutionDir).at(-1);
    assert.equal(audit?.action, "toggle");
    assert.equal(audit?.field, "telemetry", "失败审计也要能看出点的是哪个开关");
    assert.equal(audit?.result, "error: Error: config.json 不可写：EACCES");
  } finally {
    await panel.close();
  }
});

test("未注入写回调：/action 与 /toggle 一律 403「本实例只读」，且不写审计（什么都没发生）", async () => {
  const evolutionDir = workspace();
  const panel = await open(evolutionDir);
  try {
    const response = await post(panel, "/action", { csrf: panel.csrf, name: "run" });
    assert.equal(response.status, 403);
    assert.match(await response.text(), /本实例只读/);
    const toggle = await post(panel, "/toggle?field=enabled", { csrf: panel.csrf });
    assert.equal(toggle.status, 403);
    assert.match(await toggle.text(), /本实例只读/);
    assert.deepEqual(readAudit(evolutionDir), []);
  } finally {
    await panel.close();
  }
});
