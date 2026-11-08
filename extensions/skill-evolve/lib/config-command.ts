/**
 * `/skill-evolve config`：交互选模型（TUI）或打印当前值（非 TUI / RPC / print 模式）。
 *
 * 选择项列表来自 `ctx.modelRegistry.getAvailable()` —— 只有 pi 知道当前真能用的模型，
 * 本模块只拿到「选项数组 + select 函数」，所以可以在 node --test 里直接喂假 host。
 */
import { describeModelConfig, modelChoices, specFromChoice, type ModelKind } from "./model-config.ts";
import type { ModelTools } from "./evolution-model.ts";

export interface ConfigHost {
  models: readonly { provider?: string; id?: string }[];
  select(title: string, options: string[]): Promise<string | undefined>;
}

const LABELS: Record<ModelKind, string> = { propose: "提案", review: "评审" };

/** which：propose / review / both，默认 both */
export async function runConfigCommand(
  host: ConfigHost | null,
  tools: ModelTools,
  which: string = "both",
): Promise<string> {
  const kinds: ModelKind[] = which === "propose" ? ["propose"] : which === "review" ? ["review"] : ["propose", "review"];
  const current = describeModelConfig(tools.config());
  if (!host) {
    return [
      `技能进化 · 模型配置：${current}`,
      "当前模式无法交互选择（非 TUI）：直接改 .pi/evolution/config.json 的 propose.model / review.model，值写 provider/model 或 inherit。",
    ].join("\n");
  }
  const messages: string[] = [];
  for (const kind of kinds) {
    const choice = await host.select(`技能进化：${LABELS[kind]}模型`, modelChoices(host.models));
    if (choice === undefined) return [...messages, "已取消，配置未改动"].join("\n");
    messages.push(await tools.setModel(kind, specFromChoice(choice)));
  }
  return [...messages, `当前配置：${describeModelConfig(tools.config())}`].join("\n");
}
