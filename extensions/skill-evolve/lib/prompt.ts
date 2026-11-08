/**
 * 复盘提示词拼装：模板正文 + 本轮输入（会话原文路径、索引、run 目录、覆盖轮数）。
 *
 * 单独成文件是为了让 dispatch.ts（常规派发）与 shutdown-dispatch.ts（退出前补发）
 * 共用同一份拼装逻辑，同时不把两者卷进循环 import。
 */
import * as fs from "node:fs";
import type { Attribution } from "./attribution.ts";

/** 被去抖合并掉的轮次范围：起点 + 合并了几轮 */
export interface PromptCoverage {
  rounds: number;
  since: number;
}

export interface PromptInput {
  template: string;
  sessionFile?: string;
  /** 缺省表示没有会话索引（telemetry-only）：prompt 里要明说索引不可用，别让子进程去读不存在的文件 */
  indexFile?: string;
  runDir: string;
  sessionId: string;
  skills: string[];
  dispatchedAt: number;
  /** 缺省表示机械层没给结论（发现失败 / 无归因），全部交给复盘 agent 判 */
  attributions?: Attribution[];
  /** 缺省表示只覆盖刚刚结束的那一轮 */
  coverage?: PromptCoverage;
}

/** 模板缺失时的最小指令：宁可少说，也不能因为读不到模板就不派生 */
export const FALLBACK_TEMPLATE = [
  "你在复盘上一轮会话里技能为什么没被加载。",
  "只按索引抽查，禁止整文件读会话原文。",
  "只写本 run 目录下的 01-findings.json，禁止改 .pi/skills/。",
].join("\n");

export function buildPrompt(input: PromptInput): string {
  const evidence = input.sessionFile
    ? `会话原文：${input.sessionFile}`
    : "会话原文：不可用（evidenceMode=telemetry-only，只按遥测做保守结论）";
  const index = input.indexFile
    ? `索引：${input.indexFile}`
    : "索引：不可用（evidenceMode=telemetry-only，只按遥测事件下保守结论，evidence 一律留空）";
  const coverage = input.coverage
    ? `覆盖轮数：合并了 ${input.coverage.rounds} 轮待复盘区间（起点 ts=${new Date(input.coverage.since).toISOString()}），结论要覆盖整段，不要只看最后一轮`
    : "覆盖轮数：1 轮（刚刚结束的这一轮）";
  // 机械层已经定死的结论不要让复盘 agent 重判：它重判只会把「frontmatter 坏」改成「改写 description」
  const mechanical = (input.attributions ?? []).length === 0
    ? ["机械归因：无（本轮全部技能需要你判 F/G）"]
    : [
        `已机械归因（${(input.attributions ?? []).length} 条，结论直接沿用，不要重判）：`,
        ...(input.attributions ?? []).map((item) => `  ${item.category} ${item.skill} —— ${item.reason}`),
        "你只对上面没出现的技能做 F/G 判定；已归因为 A~E 的不要重复判，也不要在 findings 里改它的 category。",
      ];
  return [
    input.template.trimEnd(),
    "",
    "---",
    `会话ID：${input.sessionId}`,
    evidence,
    `技能清单（逐个判定，不许遗漏也不许新增）：${input.skills.length > 0 ? input.skills.join("、") : "（本轮无曝光技能）"}`,
    coverage,
    ...mechanical,
    index,
    `run 目录：${input.runDir}`,
    `派生时间：${new Date(input.dispatchedAt).toISOString()}`,
    "",
  ].join("\n");
}

/** 同步读模板：派发时读一次就够，模板很小；读不到回退最小指令而不是放弃派发 */
export function readPromptTemplateSync(file: string, log: (msg: string) => void): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    log(`[skill-evolve] 复盘模板读取失败，改用内置最小指令：${String(error)}`);
    return FALLBACK_TEMPLATE;
  }
}
