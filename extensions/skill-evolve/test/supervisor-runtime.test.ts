/**
 * 督导运行目录单测：npm 包装形态下督导脚本在 node_modules 里，Node 的 --experimental-strip-types
 * 会拒绝它（ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING）。这一层唯一的职责就是「先搬家再跑」，
 * 所以测试只盯三件事：**该搬的搬**、**搬家后内容完整**、**搬不了就退回原路径**。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  ensureSupervisorRuntime,
  needsCopy,
  packageVersionOf,
  RUNTIME_DIRNAME,
  runtimeDirOf,
  runtimeKey,
} from "../lib/supervisor-runtime.ts";

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "skill-evolve-runtime-"));
}

/** 造一份「装在 node_modules 里」的包：lib/ 两个文件 + 一个测试文件（不该被拷） */
function fakePackage(): { root: string; script: string } {
  const root = path.join(tmpRoot(), "node_modules", "pi-skill-evolve");
  const lib = path.join(root, "extensions", "skill-evolve", "lib");
  fs.mkdirSync(lib, { recursive: true });
  fs.writeFileSync(path.join(lib, "review-supervisor.ts"), "export const a = 1;\n");
  fs.writeFileSync(path.join(lib, "runs.ts"), "export const b = 2;\n");
  fs.writeFileSync(path.join(lib, "runs.test.ts"), "test('x', () => {});\n");
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "pi-skill-evolve", version: "0.1.12" }));
  return { root, script: path.join(lib, "review-supervisor.ts") };
}

test("只有 node_modules 里的脚本需要搬家", () => {
  assert.equal(needsCopy("/repo/.pi/npm/node_modules/pi-skill-evolve/extensions/skill-evolve/lib/review-supervisor.ts"), true);
  assert.equal(needsCopy("C:\\repo\\node_modules\\pkg\\lib\\review-supervisor.ts"), true);
  assert.equal(needsCopy("/repo/.pi/extensions/skill-evolve/lib/review-supervisor.ts"), false);
});

test("本地扩展原路径直接用，一个文件都不拷", () => {
  const evolutionDir = tmpRoot();
  const script = "/repo/.pi/extensions/skill-evolve/lib/review-supervisor.ts";
  assert.equal(ensureSupervisorRuntime({ evolutionDir, scriptPath: script }), script);
  assert.equal(fs.existsSync(path.join(evolutionDir, "runtime")), false);
});

test("node_modules 里的督导搬到 runtime 下，内容齐全且跳过测试文件", () => {
  const { script } = fakePackage();
  const evolutionDir = tmpRoot();
  const entry = ensureSupervisorRuntime({ evolutionDir, scriptPath: script });
  assert.notEqual(entry, script, "必须换成副本路径");
  const key = runtimeKey(script, "0.1.12");
  assert.equal(entry, path.join(runtimeDirOf(evolutionDir, key), "review-supervisor.ts"));
  assert.equal(fs.readFileSync(entry, "utf8"), "export const a = 1;\n");
  assert.equal(fs.existsSync(path.join(path.dirname(entry), "runs.ts")), true, "同目录的相对 import 必须一起搬");
  assert.equal(fs.existsSync(path.join(path.dirname(entry), "runs.test.ts")), false);
  assert.equal(fs.existsSync(path.join(path.dirname(entry), ".ready")), true);
});

test("重复调用复用同一份副本，不重复拷贝", () => {
  const { script } = fakePackage();
  const evolutionDir = tmpRoot();
  const first = ensureSupervisorRuntime({ evolutionDir, scriptPath: script });
  const stamp = fs.statSync(first).mtimeMs;
  const second = ensureSupervisorRuntime({ evolutionDir, scriptPath: script });
  assert.equal(second, first);
  assert.equal(fs.statSync(second).mtimeMs, stamp, "第二次不该重写文件");
});

test("内容变了（size/mtime 变）就换新目录，旧目录被清掉", () => {
  const { script } = fakePackage();
  const evolutionDir = tmpRoot();
  const first = ensureSupervisorRuntime({ evolutionDir, scriptPath: script });
  fs.writeFileSync(script, "export const a = 123456;\n");
  const future = new Date(Date.now() + 5000);
  fs.utimesSync(script, future, future);
  const second = ensureSupervisorRuntime({ evolutionDir, scriptPath: script });
  assert.notEqual(second, first);
  assert.equal(fs.existsSync(first), false, "旧版本副本要清掉");
  assert.equal(fs.readFileSync(second, "utf8"), "export const a = 123456;\n");
});

test("搬不了（目标目录建不出来）就退回原路径，只记日志不抛", () => {
  const { script } = fakePackage();
  const blocked = path.join(tmpRoot(), "file-not-dir");
  fs.writeFileSync(blocked, "x");
  const logs: string[] = [];
  const entry = ensureSupervisorRuntime({
    evolutionDir: path.join(blocked, "sub"),
    scriptPath: script,
    log: (msg) => logs.push(msg),
  });
  assert.equal(entry, script);
  assert.match(logs.join("\n"), /督导运行目录准备失败/);
});

test("缓存键带版本与入口文件指纹，包版本读得到就直接用", () => {
  const { script } = fakePackage();
  assert.equal(packageVersionOf(script), "0.1.12");
  const key = runtimeKey(script, "0.1.12");
  assert.match(key, /^lib-0\.1\.12-\d+-\d+$/);
  assert.equal(runtimeKey(script), key, "不传版本时从最近的 package.json 取");
  assert.equal(RUNTIME_DIRNAME, "supervisor");
  assert.equal(packageVersionOf(path.join(tmpRoot(), "lonely", "x.ts")), "", "找不到 package.json 就是空串");
});
