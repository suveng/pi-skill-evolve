/**
 * 「采集遥测」与「自动复盘」两个开关的口径：字段名、标签、后果说明、状态文案只此一份。
 *
 * 两个字段在配置里本来就是独立的（`telemetry` 只写本地 jsonl，不花 token；`enabled` 派生子进程复盘，花 token），
 * 命令文案、Web 控制条、HTTP 的 `field` 校验都从这里取 —— 三处各写一份字符串，
 * 迟早出现「命令里叫遥测、网页上叫采集、日志里又叫 telemetry」这种对不上的情况。
 */
import type { ConfigFlag } from "./config.ts";

/** 字段顺序即界面顺序：先采集（不花钱的），再复盘（花钱的） */
export const FLAG_FIELDS: readonly ConfigFlag[] = ["telemetry", "enabled"];

export const FLAG_LABEL: Record<ConfigFlag, string> = { telemetry: "采集遥测", enabled: "自动复盘" };

/** 后果说明：两个开关长得一样，不写清各自花什么，人只会以为都是「开关插件」 */
export const FLAG_EFFECT: Record<ConfigFlag, string> = {
  telemetry: "只写本地日志，不花 token",
  enabled: "会派生子进程，花 token",
};

/** 命令名 → 字段：`collect` 管采集，`review` 管复盘（命令名与字段名故意不同，别在别处再映射一遍） */
export const COMMAND_FLAG: Record<"collect" | "review", ConfigFlag> = {
  collect: "telemetry",
  review: "enabled",
};

/** 参数 → 字段：不认的值一律 null（调用方回用法提示或 400，不猜一个默认值） */
export function parseFlag(value: string | null | undefined): ConfigFlag | null {
  return value === "telemetry" || value === "enabled" ? value : null;
}

/** 一行两段的状态文案：`status` 与命令回执共用，免得同一句话在两处写法不同 */
export function flagStateText(enabled: boolean, telemetry: boolean): string {
  const collect = telemetry ? "采集：开（遥测写入 .pi/evolution/telemetry/）" : "采集：关（不写遥测）";
  const review = enabled ? "复盘：开（会派生 agent）" : "复盘：关（不会派生 agent）";
  return `${collect}｜${review}`;
}

/** 只开复盘却不采集时唯一的不一致组合：归因靠遥测，缺了就只能退到原始会话，加载率算不出来 */
export const TELEMETRY_OFF_WARNING = "复盘在跑但采集关着：归因只能靠原始会话，加载率不可得";

export function telemetryOffWhileEnabled(enabled: boolean, telemetry: boolean): boolean {
  return enabled && !telemetry;
}
