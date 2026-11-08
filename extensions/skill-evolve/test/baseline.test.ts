/**
 * 存量债基线单测（设计稿 10.4）：指纹不含行号、首次审计 bootstrap、新命中算新增、--reset 清空。
 *
 * 全部用临时目录 + directQueue（直写）跑真实 IO —— 这段逻辑的坑在「文件在不在、指纹对不对」，
 * 只测纯函数测不出 bootstrap 到底有没有落盘。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildBaseline,
  createBaselineGate,
  fingerprintOf,
  fingerprintsOf,
  readBaseline,
  saveBaseline,
  splitHits,
} from "../lib/baseline.ts";
import type { HardRuleHit } from "../lib/hard-rules.ts";
import { directQueue } from "../lib/telemetry.ts";

const NOW = 1_760_000_000_000;

function hit(over: Partial<HardRuleHit> = {}): HardRuleHit {
  return {
    ruleId: "rg-over-find",
    level: "P0",
    skill: "deploy-test",
    line: 129,
    quote: "grep -rho 'env::var(\"[A-Z_]*\"' rust_server/src",
    ...over,
  };
}

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "skill-evolve-baseline-"));
}

function gateFor(dir: string, hits: HardRuleHit[]) {
  const file = path.join(dir, "baseline.json");
  return {
    file,
    gate: createBaselineGate({ file, hits: () => hits, now: () => NOW, queue: directQueue, log: () => {} }),
  };
}

test("fingerprintOf：行号不进指纹，quote 只算前 120 字", () => {
  const base = hit();
  assert.equal(fingerprintOf(base), fingerprintOf(hit({ line: 999 })));
  const longQuote = "长".repeat(200);
  assert.equal(fingerprintOf(hit({ quote: longQuote })), fingerprintOf(hit({ quote: `${longQuote}追加字符` })));
  assert.notEqual(fingerprintOf(base), fingerprintOf(hit({ skill: "other" })));
  assert.notEqual(fingerprintOf(base), fingerprintOf(hit({ ruleId: "file-size-limit" })));
});

test("首次审计：文件不存在时 bootstrap，把当时全部命中都当存量并落盘", async () => {
  const dir = tempDir();
  const { file, gate } = gateFor(dir, [hit(), hit({ line: 196, quote: "ssh x \"grep -rl '文案' dist\"" })]);

  const first = gate.baseline();
  assert.equal(first.bootstrap, true);
  assert.equal(first.violations.length, 2);
  await gate.settled();

  const onDisk = readBaseline(file);
  assert.ok(onDisk);
  assert.equal(onDisk?.bootstrap, true);
  assert.equal(onDisk?.violations.length, 2);

  // 第一次审计后：两条全是存量，新增 0
  const { stock, added } = splitHits(
    [hit(), hit({ line: 196, quote: "ssh x \"grep -rl '文案' dist\"" })],
    fingerprintsOf(first),
  );
  assert.equal(stock.length, 2);
  assert.equal(added.length, 0);
});

test("新命中算新增：基线里已有的算存量，多出来的一条算新增", async () => {
  const dir = tempDir();
  const { file, gate } = gateFor(dir, [hit()]);
  const baseline = buildBaseline([hit()], NOW, false);
  await saveBaseline(file, baseline, directQueue);

  const current = [hit(), hit({ ruleId: "file-size-limit", quote: "12.3K 行" })];
  const { stock, added } = splitHits(current, fingerprintsOf(gate.baseline()));
  assert.deepEqual(stock.map((item) => item.ruleId), ["rg-over-find"]);
  assert.deepEqual(added.map((item) => item.ruleId), ["file-size-limit"]);
});

test("行号漂移不算新增：同一条问题从 129 行挪到 140 行仍是存量", async () => {
  const dir = tempDir();
  const { gate, file } = gateFor(dir, [hit({ line: 140 })]);
  await saveBaseline(file, buildBaseline([hit({ line: 129 })], NOW, false), directQueue);

  assert.equal(gate.isStock(hit({ line: 140 })), true);
  assert.equal(splitHits([hit({ line: 140 })], fingerprintsOf(gate.baseline())).added.length, 0);
});

test("acceptAll：把当前全部命中写进基线，bootstrap 标 false", async () => {
  const dir = tempDir();
  const { gate, file } = gateFor(dir, [hit(), hit({ quote: "新增的一条" })]);

  const message = await gate.acceptAll();
  assert.match(message, /已接受 2 条/);
  const onDisk = readBaseline(file);
  assert.equal(onDisk?.bootstrap, false);
  assert.equal(onDisk?.violations.length, 2);
});

test("reset：清空清单但不删文件（删了下次审计又会自动 bootstrap 回存量）", async () => {
  const dir = tempDir();
  const { gate, file } = gateFor(dir, [hit()]);
  await saveBaseline(file, buildBaseline([hit()], NOW, false), directQueue);

  const message = await gate.reset();
  assert.match(message, /已清空存量基线/);
  const onDisk = readBaseline(file);
  assert.ok(onDisk, "reset 之后文件仍在");
  assert.deepEqual(onDisk?.violations, []);
  assert.equal(splitHits([hit()], fingerprintsOf(gate.baseline())).added.length, 1);
});

test("基线文件坏了当不存在处理，不抛", () => {
  const dir = tempDir();
  const file = path.join(dir, "baseline.json");
  fs.writeFileSync(file, "{ 坏 json", "utf8");
  const { gate } = gateFor(dir, [hit()]);
  assert.equal(gate.baseline().bootstrap, true);
});
