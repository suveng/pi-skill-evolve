/**
 * 「谁持有 Web 面板」的记录文件（`.pi/evolution/locks/web.json`）：
 * 坏数据当没有、写失败不抛、删记录要比 pid。只碰临时目录，不起任何子进程。
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { clearWebPid, isAlive, readWebPid, WEB_PID_FILE, webPidFile, writeWebPid } from "../lib/web/panel-pid.ts";

function workspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "skill-evolve-panelpid-"));
}

/** 不存在的 pid：Linux 的 pid_max 远小于 INT32_MAX，这个号系统里不会有进程 */
const DEAD_PID = 2_147_483_646;

function record(pid: number): { pid: number; host: string; port: number; url: string; startedAt: number } {
  return { pid, host: "127.0.0.1", port: 7788, url: "http://127.0.0.1:7788", startedAt: 1_760_000_000_000 };
}

test("记录落在 locks/web.json：writeWebPid 建目录、原子写、能原样读回", () => {
  const dir = workspace();
  const info = record(process.pid);
  writeWebPid(dir, info);
  assert.equal(WEB_PID_FILE, path.join("locks", "web.json"));
  assert.deepEqual(readWebPid(dir), info);
  // 原子写的临时文件不能留在目录里
  assert.deepEqual(fs.readdirSync(path.join(dir, "locks")), ["web.json"]);
  assert.equal(fs.existsSync(`${webPidFile(dir)}.tmp`), false);
});

test("坏 JSON / 字段不全 / 不是对象 → readWebPid 一律 null", () => {
  const dir = workspace();
  const file = webPidFile(dir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const good = record(process.pid);
  const bad = [
    "{ 不是 JSON",
    "",
    "[]",
    "null",
    JSON.stringify({ ...good, pid: 0 }),
    JSON.stringify({ ...good, port: "7788" }),
    JSON.stringify({ ...good, url: "" }),
    JSON.stringify({ ...good, startedAt: "昨天" }),
    JSON.stringify({ pid: good.pid, host: good.host }),
  ];
  for (const raw of bad) {
    fs.writeFileSync(file, raw, "utf8");
    assert.equal(readWebPid(dir), null, `坏数据必须当没有：${raw}`);
  }
  fs.unlinkSync(file);
  assert.equal(readWebPid(dir), null, "文件不存在同样是 null");
});

test("isAlive：本进程算活，不存在的 pid / 非法 pid 算死", () => {
  assert.equal(isAlive(process.pid), true);
  assert.equal(isAlive(DEAD_PID), false);
  assert.equal(isAlive(0), false);
  assert.equal(isAlive(-1), false);
});

test("写记录失败只记日志不抛：locks 位置被文件占住时面板照常运行", () => {
  const dir = workspace();
  fs.writeFileSync(path.join(dir, "locks"), "占位", "utf8");
  const logs: string[] = [];
  assert.doesNotThrow(() => writeWebPid(dir, record(process.pid), (msg) => logs.push(msg)));
  assert.equal(logs.length, 1);
  assert.match(logs[0]!, /写 Web 面板记录失败/);
});

test("clearWebPid：pid 对上才删，别人的记录与读不出来的坏记录都留着", () => {
  const dir = workspace();
  writeWebPid(dir, record(4321));
  clearWebPid(dir, process.pid);
  assert.equal(readWebPid(dir)?.pid, 4321, "不是自己写的记录不能删");
  clearWebPid(dir, 4321);
  assert.equal(fs.existsSync(webPidFile(dir)), false);
  fs.writeFileSync(webPidFile(dir), "{坏", "utf8");
  clearWebPid(dir, process.pid);
  assert.equal(fs.existsSync(webPidFile(dir)), true, "坏记录无法证明归属，也不清");
});
