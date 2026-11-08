/**
 * 跨进程目录锁单测（零依赖，node --test）。
 *
 * 运行：
 *   cd .pi/extensions/skill-evolve
 *   node --experimental-strip-types --test test/lock.test.ts
 *
 * 覆盖三种回收判据（活 pid / 死 pid / 超时）+ 抢锁、忙等待、残锁回收。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { acquireLock, acquireLockSync, isPidAlive, lockDir, readOwnerSync, releaseLock, releaseLockSync, shouldReclaim, writeOwnerSync } from "../lib/lock.ts";

const MAX = 20 * 60_000;
const NOW = 1_760_000_000_000;

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "skill-evolve-lock-"));
}

test("shouldReclaim：没有 owner.json 视为残锁", () => {
  assert.equal(shouldReclaim(null, NOW, MAX), true);
});

test("shouldReclaim：pid 已死 → 立即回收，不看年龄（3 秒前才写的也回收）", () => {
  assert.equal(shouldReclaim({ pid: 4242, ts: NOW - 3000 }, NOW, MAX, () => false), true);
});

test("shouldReclaim：pid 活着 → 永不回收，ts 再老也不回收（宁可阻塞不可抢锁）", () => {
  assert.equal(shouldReclaim({ pid: 4242, ts: NOW - 1000 }, NOW, MAX, () => true), false);
  assert.equal(shouldReclaim({ pid: 4242, ts: NOW - 2 * MAX }, NOW, MAX, () => true), false);
  assert.equal(shouldReclaim({ pid: 4242, ts: NOW - 100 * MAX }, NOW, MAX, () => true), false);
});

test("shouldReclaim：owner 字段坏（pid 非法但 ts 可读）→ 才按年龄兜底", () => {
  assert.equal(shouldReclaim({ pid: Number.NaN, ts: NOW - 2 * MAX }, NOW, MAX, () => true), true);
  assert.equal(shouldReclaim({ pid: 0, ts: NOW - 2 * MAX }, NOW, MAX), true);
  assert.equal(shouldReclaim({ pid: Number.NaN, ts: NOW - 1000 }, NOW, MAX, () => true), false);
  assert.equal(shouldReclaim({ pid: Number.NaN, ts: Number.NaN }, NOW, MAX, () => true), true);
});

test("isPidAlive：当前进程活着，0 与负值直接判死", () => {
  assert.equal(isPidAlive(process.pid), true);
  assert.equal(isPidAlive(0), false);
  assert.equal(isPidAlive(-1), false);
});

test("acquireLock：抢到后写 owner.json，第二次抢返回 busy，释放后可再抢", async () => {
  const dir = tmpDir();
  const first = await acquireLock({ evolutionDir: dir, owner: { pid: process.pid, ts: NOW, sessionId: "s1" }, maxRuntimeMs: MAX, now: () => NOW });
  assert.equal(first.ok, true);
  const ownerFile = path.join(lockDir(dir), "owner.json");
  assert.deepEqual(JSON.parse(fs.readFileSync(ownerFile, "utf8")), { pid: process.pid, ts: NOW, sessionId: "s1" });

  const second = await acquireLock({ evolutionDir: dir, owner: { pid: process.pid, ts: NOW }, maxRuntimeMs: MAX, now: () => NOW });
  assert.equal(second.ok, false);
  assert.equal(second.why, "busy");
  assert.equal(second.owner?.sessionId, "s1");

  await releaseLock(dir);
  assert.equal(fs.existsSync(lockDir(dir)), false);
  const third = await acquireLock({ evolutionDir: dir, owner: { pid: process.pid, ts: NOW }, maxRuntimeMs: MAX, now: () => NOW });
  assert.equal(third.ok, true);
  await releaseLock(dir);
});

test("acquireLock：回收死 pid 残锁并成功抢到（不看年龄）", async () => {
  const dir = tmpDir();
  fs.mkdirSync(lockDir(dir), { recursive: true });
  // 真跑一个 node 子进程拿它的 pid，退出后这个 pid 必然已死：模拟 kill -9 后留下的残锁
  const deadPid = spawnSync(process.execPath, ["-e", ""]).pid ?? 0;
  assert.equal(isPidAlive(deadPid), false);
  // ts 就是 NOW（年龄为 0）也必须回收——这正是「派发后主进程立刻退出」的死锁场景
  fs.writeFileSync(path.join(lockDir(dir), "owner.json"), JSON.stringify({ pid: deadPid, ts: NOW, sessionId: "dead" }), "utf8");
  const logs: string[] = [];
  const result = await acquireLock({
    evolutionDir: dir,
    owner: { pid: process.pid, ts: NOW },
    maxRuntimeMs: MAX,
    now: () => NOW,
    log: (msg) => logs.push(msg),
  });
  assert.equal(result.ok, true);
  assert.equal(logs.some((line) => line.includes("回收孤儿锁")), true);
  await releaseLock(dir);
});

test("acquireLock：活 pid 的锁 ts 再老也不抢（宁可阻塞，不可抢正在跑的 run）", async () => {
  const dir = tmpDir();
  fs.mkdirSync(lockDir(dir), { recursive: true });
  fs.writeFileSync(path.join(lockDir(dir), "owner.json"), JSON.stringify({ pid: process.pid, ts: NOW - 3 * MAX }), "utf8");
  const result = await acquireLock({ evolutionDir: dir, owner: { pid: process.pid, ts: NOW }, maxRuntimeMs: MAX, now: () => NOW });
  assert.deepEqual([result.ok, result.why, result.owner?.pid], [false, "busy", process.pid]);
  await releaseLock(dir);
});

test("releaseLock：目录不存在也当成功（幂等）", async () => {
  const dir = tmpDir();
  await releaseLock(dir);
  assert.equal(fs.existsSync(lockDir(dir)), false);
});

test("acquireLockSync：同步抢锁、忙时让位、写 owner.json", () => {
  const dir = tmpDir();
  const first = acquireLockSync({ evolutionDir: dir, owner: { pid: process.pid, ts: NOW, sessionId: "s1" }, maxRuntimeMs: MAX, now: () => NOW });
  assert.equal(first.ok, true);
  assert.deepEqual(readOwnerSync(lockDir(dir)), { pid: process.pid, ts: NOW, sessionId: "s1" });

  const second = acquireLockSync({ evolutionDir: dir, owner: { pid: 999_999, ts: NOW, sessionId: "s2" }, maxRuntimeMs: MAX, now: () => NOW });
  assert.equal(second.ok, false);
  assert.equal(second.why, "busy");
  assert.equal(second.owner?.pid, process.pid);
  releaseLockSync(dir);
  assert.equal(fs.existsSync(lockDir(dir)), false);
});

test("acquireLockSync：死 pid 的残锁会被回收后抢到", () => {
  const dir = tmpDir();
  fs.mkdirSync(lockDir(dir), { recursive: true });
  fs.writeFileSync(path.join(lockDir(dir), "owner.json"), `${JSON.stringify({ pid: 999_999, ts: NOW, sessionId: "old" })}\n`);
  const result = acquireLockSync({ evolutionDir: dir, owner: { pid: process.pid, ts: NOW, sessionId: "s1" }, maxRuntimeMs: MAX, now: () => NOW });
  assert.equal(result.ok, true);
  assert.equal(readOwnerSync(lockDir(dir))?.sessionId, "s1");
  releaseLockSync(dir);
});

test("writeOwnerSync：把持有者换成子进程 pid，供 status 与孤儿判定使用", () => {
  const dir = tmpDir();
  acquireLockSync({ evolutionDir: dir, owner: { pid: process.pid, ts: NOW, sessionId: "s1" }, maxRuntimeMs: MAX, now: () => NOW });
  assert.equal(writeOwnerSync(dir, { pid: 4321, ts: NOW + 1, sessionId: "s1" }), true);
  assert.deepEqual(readOwnerSync(lockDir(dir)), { pid: 4321, ts: NOW + 1, sessionId: "s1" });
  releaseLockSync(dir);
});
