/**
 * 模型配置单测（设计稿 12.5）：值只有两种形态——`provider/model` 或 `inherit`。
 * 非法值一律退 inherit 而不是让派发失败，这条兜底要有用例钉住。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  DEFAULT_MODEL_CONFIG,
  INHERIT,
  describeModelConfig,
  loadModelConfig,
  modelChoices,
  normalizeModelSpec,
  readModelConfig,
  resolveModel,
  saveModelSpec,
  specFromChoice,
} from "../lib/model-config.ts";
import { directQueue } from "../lib/telemetry.ts";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sk-model-"));
}

test("合法 provider/model 原样保留，非法值退 inherit", () => {
  assert.equal(normalizeModelSpec("deepseek/deepseek-v3.2"), "deepseek/deepseek-v3.2");
  assert.equal(normalizeModelSpec(" openai/gpt-5:high "), "openai/gpt-5:high");
  for (const bad of ["", "inherit", "no-slash", "/missing-provider", "provider/", 42, null, undefined]) {
    assert.equal(normalizeModelSpec(bad), INHERIT, `非法值 ${String(bad)} 应退 inherit`);
  }
});

test("readModelConfig 缺字段 / 坏结构都当 inherit", () => {
  assert.deepEqual(readModelConfig(undefined), DEFAULT_MODEL_CONFIG);
  assert.deepEqual(readModelConfig({ propose: "not-an-object", review: { model: 3 } }), { propose: INHERIT, review: INHERIT });
  assert.deepEqual(readModelConfig({ propose: { model: "a/b" }, review: { model: "c/d" } }), { propose: "a/b", review: "c/d" });
});

test("loadModelConfig：配置文件不存在时不报错也不建文件", () => {
  const dir = tmpDir();
  assert.deepEqual(loadModelConfig(dir), DEFAULT_MODEL_CONFIG);
  assert.equal(fs.existsSync(path.join(dir, "config.json")), false);
});

test("resolveModel：inherit 取主会话模型，显式值优先于主会话", () => {
  const host = { model: { provider: "deepseek", id: "deepseek-v3.2" } };
  assert.equal(resolveModel("review", DEFAULT_MODEL_CONFIG, host), "deepseek/deepseek-v3.2");
  assert.equal(resolveModel("review", { propose: INHERIT, review: "openai/gpt-5" }, host), "openai/gpt-5");
});

test("resolveModel：主会话没模型时仍返回 inherit，不伪造成空串", () => {
  assert.equal(resolveModel("propose", DEFAULT_MODEL_CONFIG, {}), INHERIT);
  assert.equal(resolveModel("propose", DEFAULT_MODEL_CONFIG, { model: { provider: "x" } }), INHERIT);
});

test("选择项第一项是跟随主会话，回读能还原成 inherit", () => {
  const choices = modelChoices([{ provider: "deepseek", id: "deepseek-v3.2" }, { provider: "only-provider" }]);
  assert.equal(choices.length, 2, "缺 id 的模型不进候选");
  assert.match(choices[0], /跟随主会话/);
  assert.equal(specFromChoice(choices[0]), INHERIT);
  assert.equal(specFromChoice(choices[1]), "deepseek/deepseek-v3.2");
});

test("saveModelSpec 只改目标键，其余配置原样保留", async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ enabled: false, idleMs: 1000, review: { model: "old/x" } }), "utf8");
  const next = await saveModelSpec(dir, "propose", "deepseek/deepseek-v3.2", directQueue);
  assert.equal(next.propose, "deepseek/deepseek-v3.2");
  assert.equal(next.review, "old/x");
  const saved = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8")) as Record<string, unknown>;
  assert.equal(saved.enabled, false, "其他键不得被覆盖");
  assert.equal(saved.idleMs, 1000);
  assert.deepEqual(saved.propose, { model: "deepseek/deepseek-v3.2" });
});

test("saveModelSpec 写入非法值时落 inherit 而不是坏字符串", async () => {
  const dir = tmpDir();
  const next = await saveModelSpec(dir, "review", "随便写点什么", directQueue);
  assert.equal(next.review, INHERIT);
  assert.match(describeModelConfig(next), /跟随主会话/);
});
