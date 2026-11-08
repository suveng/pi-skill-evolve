/**
 * 四个开关（采集遥测 / 自动复盘 / 自动评审 / 自动采纳）的口径：字段名、标签、后果说明、状态文案只此一份。
 *
 * 四个字段在配置里本来就是独立的（`telemetry` 只写本地 jsonl；`enabled` 派生子进程复盘；
 * `autoReview` 再起一个督导子进程；`autoApply` 改仓库文件），命令文案、Web 控制条、
 * HTTP 的 `field` 校验都从这里取 —— 三处各写一份字符串，
 * 迟早出现「命令里叫评审、网页上叫审核、日志里又叫 autoReview」这种对不上的情况。
 */
import type { ConfigFlag, EvolutionConfig } from "./config.ts";

/** 字段顺序即界面顺序：先不花钱的（采集），再花钱的（复盘 → 评审），最后动文件的（采纳） */
export const FLAG_FIELDS: readonly ConfigFlag[] = ["telemetry", "enabled", "autoReview", "autoApply"];

export const FLAG_LABEL: Record<ConfigFlag, string> = {
  telemetry: "采集遥测",
  enabled: "自动复盘",
  autoReview: "自动评审",
  autoApply: "自动采纳",
};

/** 后果说明：四个开关长得一样，不写清各自花什么，人只会以为都是「开关插件」 */
export const FLAG_EFFECT: Record<ConfigFlag, string> = {
  telemetry: "只写本地日志，不花 token",
  enabled: "会派生子进程，花 token",
  autoReview: "提案后再起一个督导子进程，再花一份 token",
  autoApply: "改 .pi/skills/ 与 .cursor/ 文件，可回滚",
};

/** 命令名 → 字段（命令名与字段名故意不同，别在别处再映射一遍）：`dispatch` 是复盘、`review` 是评审 */
export const COMMAND_FLAG: Record<"collect" | "dispatch" | "review" | "apply", ConfigFlag> = {
  collect: "telemetry",
  dispatch: "enabled",
  review: "autoReview",
  apply: "autoApply",
};

/** 参数 → 字段：不认的值一律 null（调用方回用法提示或 400，不猜一个默认值） */
export function parseFlag(value: string | null | undefined): ConfigFlag | null {
  return value === "telemetry" || value === "enabled" || value === "autoReview" || value === "autoApply" ? value : null;
}

/** `status` 与命令回执共用的四段状态文案：四个字段各自一句话，合成一行 */
export function flagStateText(
  config: Pick<EvolutionConfig, "telemetry" | "enabled" | "autoReview" | "autoApply">,
): string {
  const collect = config.telemetry ? "采集：开（遥测写入 .pi/evolution/telemetry/）" : "采集：关（不写遥测）";
  const dispatch = config.enabled ? "复盘：开（会派生 agent）" : "复盘：关（不会派生 agent）";
  const review = config.autoReview ? "评审：开（提案后自动起督导）" : "评审：关（提案停在 proposed 等人工）";
  const apply = config.autoApply ? "采纳：开（auto 提案自动落盘）" : "采纳：关（auto 提案等人工批准）";
  return `${collect}｜${dispatch}｜${review}｜${apply}`;
}

/** 只开复盘却不采集时唯一的不一致组合：归因靠遥测，缺了就只能退到原始会话，加载率算不出来 */
export const TELEMETRY_OFF_WARNING = "复盘在跑但采集关着：归因只能靠原始会话，加载率不可得";

export function telemetryOffWhileEnabled(enabled: boolean, telemetry: boolean): boolean {
  return enabled && !telemetry;
}
