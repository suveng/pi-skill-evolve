/**
 * 模型配置 + 必红自检的「动作层」：把 `model-config.ts`（读写配置）与 `selftest.ts`（跑自检）
 * 拼成 evolution 与命令能直接用的三件事——取评审模型、改模型、跑自检。
 *
 * 放这里而不是塞进 evolution.ts：那边已经贴着 300 行闸门，而这一层与采集/门禁无关。
 */
import { loadModelConfig, resolveModel, saveModelSpec, type ModelConfig, type ModelKind } from "./model-config.ts";
import { readSelftestReport, renderSelftestReport, runSelftest, type SelftestReport } from "./selftest.ts";
import type { ReviewSpawn } from "./review-run.ts";
import type { MutationQueue } from "./telemetry.ts";

export interface ModelToolsDeps {
  evolutionDir: string;
  cwd: string;
  queue: MutationQueue;
  log: (msg: string) => void;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
  /** 主会话当前模型：inherit 时用它（拿不到就仍返回 inherit，让 pi 自己挑默认模型） */
  hostModel?: () => { provider?: string; id?: string } | undefined;
  reviewSpawnFn?: ReviewSpawn;
  selftestTimeoutMs?: number;
}

export interface ModelTools {
  config(): ModelConfig;
  /** 评审该用哪个模型：`provider/id` 或 "inherit" */
  reviewModel(): string;
  setModel(kind: ModelKind, spec: string): Promise<string>;
  /** `/skill-evolve selftest`：跑三个坏样本并回显 */
  selftestText(): Promise<string>;
  /** 派发门禁用：最近一次自检明确没过 → true（没跑过不算没过） */
  selftestFailed(): boolean;
  lastSelftest(): SelftestReport | undefined;
}

export function createModelTools(deps: ModelToolsDeps): ModelTools {
  const log = deps.log;
  const config = (): ModelConfig => loadModelConfig(deps.evolutionDir);
  const reviewModel = (): string => resolveModel("review", config(), { model: deps.hostModel?.() });

  return {
    config,
    reviewModel,
    async setModel(kind: ModelKind, spec: string): Promise<string> {
      const next = await saveModelSpec(deps.evolutionDir, kind, spec, deps.queue);
      const label = kind === "propose" ? "提案" : "评审";
      const warn = next.propose === next.review && next.review !== "inherit" ? "（提案与评审是同一个模型，独立性天然有限）" : "";
      return `${label}模型已设为 ${next[kind]}${warn}（下次派发生效）`;
    },
    async selftestText(): Promise<string> {
      const model = reviewModel();
      const report = await runSelftest({
        evolutionDir: deps.evolutionDir,
        cwd: deps.cwd,
        ...(model !== "inherit" ? { model } : {}),
        ...(deps.env ? { env: deps.env } : {}),
        ...(deps.reviewSpawnFn ? { spawnFn: deps.reviewSpawnFn } : {}),
        ...(deps.now ? { now: deps.now } : {}),
        ...(deps.selftestTimeoutMs ? { timeoutMs: deps.selftestTimeoutMs } : {}),
        log,
      });
      return renderSelftestReport(report);
    },
    selftestFailed(): boolean {
      return readSelftestReport(deps.evolutionDir)?.passed === false;
    },
    lastSelftest(): SelftestReport | undefined {
      return readSelftestReport(deps.evolutionDir);
    },
  };
}
