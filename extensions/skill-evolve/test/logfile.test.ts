/**
 * 扩展日志落盘（用户 2026-11-08：「tui 的这些推送不看了，影响我」）：
 * 默认只写 `.pi/evolution/logs/extension.log`，`PI_SKILL_EVOLVE_DEBUG=1` 才回显终端，超 1MB 轮转成 `.1`。
 *
 * 全部喂临时目录；console.log 用临时替换的假函数断言，不起任何子进程。
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { LOG_MAX_BYTES, logFile, logLine } from "../lib/logfile.ts";

function workspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "skill-evolve-logfile-"));
}

/** 临时接管 console.log：返回调用记录与还原函数（测试之间不许互相污染） */
function spyConsole(): { calls: string[]; restore: () => void } {
  const original = console.log;
  const calls: string[] = [];
  console.log = (...args: unknown[]) => {
    calls.push(args.map((arg) => String(arg)).join(" "));
  };
  return { calls, restore: () => (console.log = original) };
}

/** 环境变量按需设 / 删，并在 finally 里还原成测试前的样子 */
function withDebugEnv(value: string | undefined, run: () => void): void {
  const before = process.env.PI_SKILL_EVOLVE_DEBUG;
  if (value === undefined) delete process.env.PI_SKILL_EVOLVE_DEBUG;
  else process.env.PI_SKILL_EVOLVE_DEBUG = value;
  try {
    run();
  } finally {
    if (before === undefined) delete process.env.PI_SKILL_EVOLVE_DEBUG;
    else process.env.PI_SKILL_EVOLVE_DEBUG = before;
  }
}

test("logLine：自动建 logs/ 目录，一行一条带 ISO 时间戳", () => {
  const dir = workspace();
  withDebugEnv(undefined, () => logLine(dir, "[skill-evolve] 已派生复盘 pid 1", false));
  const file = logFile(dir);
  assert.equal(file, path.join(dir, "logs", "extension.log"));
  const text = fs.readFileSync(file, "utf8");
  assert.match(text, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \[skill-evolve\] 已派生复盘 pid 1\n$/);
});

test("logLine：DEBUG 未设时一次都不调 console.log，但文件照写", () => {
  const dir = workspace();
  const spy = spyConsole();
  try {
    withDebugEnv(undefined, () => logLine(dir, "静默一行"));
  } finally {
    spy.restore();
  }
  assert.deepEqual(spy.calls, [], "默认零推送：终端不该出现任何一行");
  assert.match(fs.readFileSync(logFile(dir), "utf8"), /静默一行/);
});

test("logLine：PI_SKILL_EVOLVE_DEBUG=1 时同时回显终端", () => {
  const dir = workspace();
  const spy = spyConsole();
  try {
    withDebugEnv("1", () => logLine(dir, "可见一行"));
  } finally {
    spy.restore();
  }
  assert.deepEqual(spy.calls, ["可见一行"]);
  assert.match(fs.readFileSync(logFile(dir), "utf8"), /可见一行/);
});

test("logLine：单文件超 1MB 轮转成 .1，新文件只留新的一行", () => {
  const dir = workspace();
  const file = logFile(dir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // 刚好等于阈值不轮转，超一个字节才轮转：这里直接写 MAX+1
  fs.writeFileSync(file, "x".repeat(LOG_MAX_BYTES + 1), "utf8");
  withDebugEnv(undefined, () => logLine(dir, "轮转后的一行", false));
  assert.equal(fs.statSync(`${file}.1`).size, LOG_MAX_BYTES + 1, "旧内容整体挪到 .1");
  const current = fs.readFileSync(file, "utf8");
  assert.equal(current.includes("xxxx"), false, "新文件里没有旧内容");
  assert.match(current, /轮转后的一行/);
});
