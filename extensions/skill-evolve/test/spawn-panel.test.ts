/**
 * 面板独立进程的调度判据（2026-11-11）。
 *
 * 为什么值得单测：`decidePanel` 判错一个分支，用户看到的是「装了新版还是旧界面」或者
 * 「两个面板抢同一个端口」；`materializeExtension` 漏了复制，子进程直接起不来。
 * 这两条都不需要真开端口就能钉死。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { decidePanel, ensurePanel, materializeExtension } from "../lib/web/spawn-panel.ts";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "se-spawn-"));
}

test("decidePanel：没有记录就新起", () => {
  assert.equal(decidePanel({ owner: null, alive: false, version: "1.0.0", port: 7788 }), "start");
});

test("decidePanel：记录的进程已经死了 → 救活", () => {
  const owner = { pid: 4242, url: "http://127.0.0.1:7788", version: "1.0.0" };
  assert.equal(decidePanel({ owner, alive: false, version: "1.0.0", port: 7788, ownerPort: 7788 }), "restart-dead");
});

test("decidePanel：版本变了 → 换进程（这正是「装上新版就该看到新界面」）", () => {
  const owner = { pid: 4242, url: "http://127.0.0.1:7788", version: "0.1.20" };
  assert.equal(decidePanel({ owner, alive: true, version: "0.1.21", port: 7788, ownerPort: 7788 }), "restart-version");
});

test("decidePanel：老记录没有 version 字段 → 按版本未知处理，主动换新", () => {
  const owner = { pid: 4242, url: "http://127.0.0.1:7788" };
  assert.equal(decidePanel({ owner, alive: true, version: "0.1.21", port: 7788, ownerPort: 7788 }), "restart-version");
});

test("decidePanel：端口改了 → 换进程", () => {
  const owner = { pid: 4242, url: "http://127.0.0.1:7788", version: "0.1.21" };
  assert.equal(decidePanel({ owner, alive: true, version: "0.1.21", port: 7799, ownerPort: 7788 }), "restart-version");
});

test("decidePanel：同版本同端口且活着 → 复用，不抢", () => {
  const owner = { pid: 4242, url: "http://127.0.0.1:7788", version: "0.1.21" };
  assert.equal(decidePanel({ owner, alive: true, version: "0.1.21", port: 7788, ownerPort: 7788 }), "owned-elsewhere");
});

test("materializeExtension：按版本复制、跳过 test 目录，重复调用复用同一份", () => {
  const root = tempDir();
  const source = path.join(root, "src-ext");
  fs.mkdirSync(path.join(source, "lib", "web"), { recursive: true });
  fs.mkdirSync(path.join(source, "test"), { recursive: true });
  fs.writeFileSync(path.join(source, "lib", "web", "child-main.ts"), "export {};\n");
  fs.writeFileSync(path.join(source, "test", "x.test.ts"), "// 不该被复制\n");
  const runtimeRoot = path.join(root, "runtime");

  const target = materializeExtension({ source, runtimeRoot, version: "0.1.22" });
  assert.equal(target, path.join(runtimeRoot, "panel-v0.1.22"));
  assert.ok(fs.existsSync(path.join(target, "lib", "web", "child-main.ts")));
  assert.equal(fs.existsSync(path.join(target, "test")), false);

  // 第二次调用不再复制：把源删掉也必须照样能返回
  fs.rmSync(source, { recursive: true, force: true });
  assert.equal(materializeExtension({ source, runtimeRoot, version: "0.1.22" }), target);
});

test("ensurePanel：已有同版本活进程 → 直接复用地址，不 spawn", async () => {
  const root = tempDir();
  const evolutionDir = path.join(root, ".pi", "evolution");
  fs.mkdirSync(path.join(evolutionDir, "locks"), { recursive: true });
  fs.writeFileSync(
    path.join(evolutionDir, "locks", "web.json"),
    JSON.stringify({ pid: 4321, host: "127.0.0.1", port: 7788, url: "http://127.0.0.1:7788", startedAt: 1, version: "9.9.9" }),
  );
  let spawned = 0;
  const result = await ensurePanel({
    evolutionDir,
    cwd: root,
    extensionDir: path.join(root, "ext"),
    version: "9.9.9",
    port: 7788,
    alive: () => true,
    spawnFn: () => {
      spawned += 1;
      return { pid: 1 };
    },
  });
  assert.equal(spawned, 0);
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.panel.url, "http://127.0.0.1:7788");
});

test("ensurePanel：子进程起不来（没写回 locks/web.json）→ 返回失败，不抛异常", async () => {
  const root = tempDir();
  const evolutionDir = path.join(root, ".pi", "evolution");
  const extensionDir = path.join(root, "ext");
  fs.mkdirSync(path.join(extensionDir, "lib", "web"), { recursive: true });
  fs.writeFileSync(path.join(extensionDir, "lib", "web", "child-main.ts"), "export {};\n");
  const result = await ensurePanel({
    evolutionDir,
    cwd: root,
    extensionDir,
    version: "0.1.22",
    port: 7799,
    waitMs: 120,
    alive: () => false,
    spawnFn: () => ({ pid: 999_999, unref: () => undefined }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.code, "UNKNOWN");
});
