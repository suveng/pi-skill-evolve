/**
 * 模型配置（设计稿 12.5）：`propose.model` / `review.model` 两个键，值 `"inherit"` 或 `provider/model`。
 *
 * `inherit` = 跟随主会话当前模型（`ctx.model`）。默认两边都是 inherit —— 用户不配置也能跑，
 * 但同模型自评的独立性天然有限，所以评审产物里必须写清 `sameModel`。
 */
import * as fs from "node:fs";
import { configFile, readRawConfig } from "./config.ts";
import type { MutationQueue } from "./telemetry.ts";

export const INHERIT = "inherit";
export type ModelKind = "propose" | "review";

export interface ModelConfig {
  propose: string;
  review: string;
}

export const DEFAULT_MODEL_CONFIG: Readonly<ModelConfig> = Object.freeze({ propose: INHERIT, review: INHERIT });

/** provider/id，id 允许带 `:thinking` 后缀（pi 的 --model 语法） */
const SPEC = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:-]*$/;

/** 是不是合法的 `provider/id`（`inherit` 不算 —— 它是「不指定」，由调用方自己判） */
export function isModelSpec(value: unknown): boolean {
  return typeof value === "string" && SPEC.test(value.trim());
}

/** 非法值一律退回 inherit：配置错误不该让整条流水线停摆 */
export function normalizeModelSpec(value: unknown): string {
  return isModelSpec(value) ? String(value).trim() : INHERIT;
}

/** 从 config.json 的原始对象里取模型配置（`{propose:{model},review:{model}}`） */
export function readModelConfig(raw: unknown): ModelConfig {
  const input = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const pick = (key: ModelKind): string => {
    const node = input[key];
    if (!node || typeof node !== "object") return INHERIT;
    return normalizeModelSpec((node as Record<string, unknown>).model);
  };
  return { propose: pick("propose"), review: pick("review") };
}

export function loadModelConfig(evolutionDir: string): ModelConfig {
  return readModelConfig(readRawConfig(evolutionDir));
}

export interface ModelHost {
  model?: { provider?: string; id?: string };
}

/** inherit → 主会话当前的 `provider/id`；主会话没有模型时仍返回 inherit（调用方不传 --model） */
export function resolveModel(kind: ModelKind, config: ModelConfig, host: ModelHost): string {
  const spec = config[kind] ?? INHERIT;
  if (spec !== INHERIT) return spec;
  const provider = host.model?.provider;
  const id = host.model?.id;
  return provider && id ? `${provider}/${id}` : INHERIT;
}

/** `/skill-evolve config` 的选择项：第一项固定是「跟随主会话」 */
export function modelChoices(models: readonly { provider?: string; id?: string }[]): string[] {
  const choices = [`跟随主会话（${INHERIT}）`];
  for (const model of models) {
    if (model.provider && model.id) choices.push(`${model.provider}/${model.id}`);
  }
  return choices;
}

/** 把选择项还原成配置值 */
export function specFromChoice(choice: string): string {
  return choice.startsWith("跟随主会话") ? INHERIT : normalizeModelSpec(choice);
}

/** 写回一个键：只改 `propose.model` / `review.model`，其余字段原样保留 */
export async function saveModelSpec(
  evolutionDir: string,
  kind: ModelKind,
  spec: string,
  queue: MutationQueue,
): Promise<ModelConfig> {
  const raw = readRawConfig(evolutionDir);
  const next = readModelConfig({ ...raw, [kind]: { ...(raw[kind] as object | undefined), model: normalizeModelSpec(spec) } });
  const merged = {
    ...raw,
    propose: { ...(raw.propose as object | undefined), model: next.propose },
    review: { ...(raw.review as object | undefined), model: next.review },
  };
  const file = configFile(evolutionDir);
  await queue(file, async () => {
    await fs.promises.mkdir(evolutionDir, { recursive: true });
    await fs.promises.writeFile(file, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  });
  return next;
}

export function describeModelConfig(config: ModelConfig): string {
  return `提案模型 ${config.propose} · 评审模型 ${config.review}（${INHERIT} = 跟随主会话）`;
}
