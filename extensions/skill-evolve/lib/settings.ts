/**
 * 面板配置页的「读 / 校验」层（写盘在 lib/config.ts 的 saveSettings）。
 *
 * 为什么单独立一层：这些字段以前只能靠命令（`/skill-evolve config`）或手改 config.json，
 * 面板上看不见也改不了；现在要把它们搬上网页，就必须先有一份**与命令共用**的校验口径 ——
 * 网页自己判一遍、命令再判一遍，迟早出现「网页能存、命令不认」的两套语义。
 *
 * 纪律：
 * 1. 校验失败**报错不回落**（与 `normalizeModelSpec` 的静默回落相反）：网页表单是人看着填的，
 *    填错要当场告诉他哪一项、允许什么范围；静默存成默认值等于「他以为改了，其实没改」。
 * 2. 只读 config.json，不读运行态；端口改了要重启面板才生效，这句话由渲染层写进页面。
 */
import { loadConfig } from "./config.ts";
import { INHERIT, isModelSpec, loadModelConfig } from "./model-config.ts";

/** 面板配置页能改的八项；顺序与页面上的字段顺序一致 */
export interface SettingsValues {
  /** 提案模型（`inherit` = 跟随主会话） */
  propose: string;
  /** 评审模型（`inherit` = 跟随主会话） */
  review: string;
  /** 会话空闲多久算「可以派发复盘」（去抖） */
  idleMs: number;
  /** 单轮复盘子进程最长跑多久（超时判卡死） */
  maxRuntimeMs: number;
  /** 单会话最多自动复盘几次 */
  perSessionCap: number;
  /** 趋势统计回看多少天（report --week 的指标窗口） */
  metricsWindowDays: number;
  /** 采纳前备份保留多少天（超期在会话起点清理） */
  backupRetentionDays: number;
  /** Web 面板端口（改了要重启面板） */
  port: number;
}

/** 只带改动的字段：命令与网页都往这里塞，未出现的键一律保持原值 */
export type SettingsPatch = Partial<SettingsValues>;

export type SettingsField = keyof SettingsValues;

/**
 * 数值字段的取值范围。上下界都按「小到不会自我伤害、大到不至于把本机拖垮」定：
 * - idleMs：1 秒以下等于没有去抖（每个回合都触发），10 分钟以上等于永远不触发；
 * - maxRuntimeMs：1 分钟会把正常复盘判成卡死，2 小时以上等于卡死判定失效；
 * - perSessionCap：0 会让自动复盘永远不跑，200 次以上单会话的 token 账单不可控；
 * - port：<1024 需要 root，>65535 不存在。
 */
export const SETTINGS_BOUNDS = {
  idleMs: { min: 1_000, max: 600_000 },
  maxRuntimeMs: { min: 60_000, max: 7_200_000 },
  perSessionCap: { min: 1, max: 200 },
  metricsWindowDays: { min: 7, max: 365 },
  backupRetentionDays: { min: 1, max: 365 },
  port: { min: 1_024, max: 65_535 },
} as const;

export type SettingsParse = { ok: true; patch: SettingsPatch } | { ok: false; error: string };

/** 读当前值：模型来自 config.json 的 `propose.model` / `review.model`，其余来自顶层与 web 块 */
export function readSettings(evolutionDir: string): SettingsValues {
  const config = loadConfig(evolutionDir);
  const models = loadModelConfig(evolutionDir);
  return {
    propose: models.propose,
    review: models.review,
    idleMs: config.idleMs,
    maxRuntimeMs: config.maxRuntimeMs,
    perSessionCap: config.perSessionCap,
    metricsWindowDays: config.metricsWindowDays,
    backupRetentionDays: config.backupRetentionDays,
    port: config.web.port,
  };
}

/** 整数解析：空串、小数、非数字、越界都返回 null，由调用方拼一句人话 */
function intInRange(raw: string, min: number, max: number): number | null {
  const text = raw.trim();
  if (!/^\d+$/.test(text)) return null;
  const value = Number(text);
  return value >= min && value <= max ? value : null;
}

/** 模型字段：允许 `inherit`（含页面上的「跟随主会话」原文），其余必须是 provider/id */
function parseModel(raw: string): string | null {
  const text = raw.trim();
  if (text.length === 0) return null;
  if (text === INHERIT || text === FOLLOW_HOST_TEXT) return INHERIT;
  return isModelSpec(text) ? text : null;
}

/** 页面下拉框里「跟随主会话」那一项的显示文案；提交时它等价于 `inherit` */
export const FOLLOW_HOST_TEXT = `跟随主会话（${INHERIT}）`;

/**
 * 校验八项。**任何一项不合法就整体拒绝**（不存半份配置）：
 * 半份生效会让人分不清「我改的那个到底进没进」，而下一次再改时又是基于这份半成品。
 */
export function parseSettingsForm(form: URLSearchParams): SettingsParse {
  const errors: string[] = [];
  const patch: SettingsPatch = {};

  const proposeRaw = form.get("propose");
  if (proposeRaw !== null) {
    const value = parseModel(proposeRaw);
    if (value === null) errors.push(`提案模型要写成 provider/model（或「${FOLLOW_HOST_TEXT}」），收到「${proposeRaw.trim()}」`);
    else patch.propose = value;
  }
  const reviewRaw = form.get("review");
  if (reviewRaw !== null) {
    const value = parseModel(reviewRaw);
    if (value === null) errors.push(`评审模型要写成 provider/model（或「${FOLLOW_HOST_TEXT}」），收到「${reviewRaw.trim()}」`);
    else patch.review = value;
  }

  const numeric: readonly [keyof typeof SETTINGS_BOUNDS, string, string][] = [
    ["idleMs", "idleMs", "空闲去抖（毫秒）"],
    ["maxRuntimeMs", "maxRuntimeMs", "单轮上限（毫秒）"],
    ["perSessionCap", "perSessionCap", "单会话次数"],
    ["metricsWindowDays", "metricsWindowDays", "趋势窗口（天）"],
    ["backupRetentionDays", "backupRetentionDays", "备份保留（天）"],
    ["port", "port", "端口"],
  ];
  for (const [field, key, label] of numeric) {
    const raw = form.get(key);
    if (raw === null) continue;
    const bounds = SETTINGS_BOUNDS[field];
    const value = intInRange(raw, bounds.min, bounds.max);
    if (value === null) errors.push(`${label}要填 ${bounds.min}–${bounds.max} 之间的整数，收到「${raw.trim()}」`);
    else if (field === "port") patch.port = value;
    else if (field === "idleMs") patch.idleMs = value;
    else if (field === "maxRuntimeMs") patch.maxRuntimeMs = value;
    else if (field === "perSessionCap") patch.perSessionCap = value;
    else if (field === "metricsWindowDays") patch.metricsWindowDays = value;
    else if (field === "backupRetentionDays") patch.backupRetentionDays = value;
    else patch.perSessionCap = value;
  }

  if (errors.length > 0) return { ok: false, error: errors.join("；") };
  return { ok: true, patch };
}

/** 页面顶部的一句话结论：改了哪些项（审计与 303 横幅都用它） */
export function settingsPatchText(patch: SettingsPatch): string {
  const names: Record<SettingsField, string> = {
    propose: "提案模型",
    review: "评审模型",
    idleMs: "空闲去抖",
    maxRuntimeMs: "单轮上限",
    perSessionCap: "单会话次数",
    metricsWindowDays: "趋势窗口",
    backupRetentionDays: "备份保留",
    port: "端口",
  };
  const changed = (Object.keys(patch) as SettingsField[]).map((key) => names[key]);
  return changed.length === 0 ? "没有改动" : `已保存：${changed.join(" / ")}`;
}
