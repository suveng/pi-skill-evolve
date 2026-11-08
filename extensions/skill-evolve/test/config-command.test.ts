/**
 * `/skill-evolve config` 单测：TUI 用 select，非 TUI 只打印当前值。
 * tools 用假实现，验证的是「选了哪一项 → 写成什么值」以及取消行为。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { runConfigCommand } from "../lib/config-command.ts";
import type { ModelTools } from "../lib/evolution-model.ts";
import { INHERIT, modelChoices } from "../lib/model-config.ts";

function fakeTools(calls: string[]): ModelTools {
  let config = { propose: INHERIT, review: INHERIT };
  return {
    config: () => config,
    reviewModel: () => config.review,
    setModel: async (kind, spec) => {
      calls.push(`${kind}=${spec}`);
      config = { ...config, [kind]: spec };
      return `${kind} 已设为 ${spec}`;
    },
    selftestText: async () => "自检：通过",
    selftestFailed: () => false,
    lastSelftest: () => undefined,
  };
}

const MODELS = [{ provider: "deepseek", id: "deepseek-v3.2" }, { provider: "openai", id: "gpt-5" }];

test("非 TUI：不提问，只打印当前值与手改入口", async () => {
  const calls: string[] = [];
  const text = await runConfigCommand(null, fakeTools(calls));
  assert.match(text, /无法交互选择/);
  assert.match(text, /propose\.model/);
  assert.deepEqual(calls, []);
});

test("TUI：选『跟随主会话』写 inherit，两个键都会问", async () => {
  const calls: string[] = [];
  const asked: string[] = [];
  const text = await runConfigCommand(
    {
      models: MODELS,
      select: async (title: string, options: string[]) => {
        asked.push(`${title}|${options.join(",")}`);
        return options[0];
      },
    },
    fakeTools(calls),
  );
  assert.deepEqual(calls, [`propose=${INHERIT}`, `review=${INHERIT}`]);
  assert.equal(asked.length, 2);
  assert.ok(asked[0].includes(MODELS[0].provider));
  assert.match(text, /当前配置/);
});

test("TUI：选具体模型写 provider/id；只问 review 时只改 review", async () => {
  const calls: string[] = [];
  const choices = modelChoices(MODELS);
  const text = await runConfigCommand(
    { models: MODELS, select: async (_title: string, options: string[]) => options[2] ?? choices[1] },
    fakeTools(calls),
    "review",
  );
  assert.deepEqual(calls, ["review=openai/gpt-5"]);
  assert.match(text, /review/);
});

test("取消选择：写回中止，配置不动", async () => {
  const calls: string[] = [];
  const text = await runConfigCommand({ models: MODELS, select: async () => undefined }, fakeTools(calls));
  assert.deepEqual(calls, []);
  assert.match(text, /已取消/);
});
