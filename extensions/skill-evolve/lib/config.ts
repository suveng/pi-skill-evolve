/**
 * 技能进化配置：唯一来源是 `.pi/evolution/config.json`。
 *
 * **四个开关默认全关**（采集 `telemetry` / 复盘 `enabled` / 评审 `autoReview` / 采纳 `autoApply` 都是 false，
 * 2026-11-08 用户定「autoReview 默认也关」）：别人 clone 下来不采集、不派生、不评审、不落盘，零 token 开销。
 * 要用就一条一条显式打开（`collect` / `dispatch` / `review` / `apply`），谁开谁负责。
 * 每一档花不花 token：
 * - 采集遥测：只写本地 jsonl，**不花 token**；
 * - 自动复盘：起子进程跑 agent，**花 token**；
 * - 自动评审：复盘出了提案再起一个督导子进程，**再花一份 token**；
 * - 自动采纳：改 `.pi/skills/` 与 `.cursor/` 文件，**不花 token，但会动仓库文件**（可回滚）。
 *
 * 只有显式 `/skill-evolve on` 才写这个文件（`config.json` 也是本机偏好，进 `.gitignore`，断然不能入库
 * —— 否则一个人开了，提交一推，整个团队都被打开）。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { MutationQueue } from "./telemetry.ts";
import type { SettingsPatch } from "./settings.ts";

/**
 * TUI 推送开关（用户 2026-11-08：「tui 的这些推送不看了，影响我」）：两个都默认 false。
 * 实时状态改由 `/skill-evolve status`、Web 面板与 `.pi/evolution/logs/extension.log` 承载。
 */
export interface UiConfig {
  /** false → 不调 ctx.ui.setWidget / setStatus（面板与状态栏都不出现） */
  widget: boolean;
  /** false → 不写 `/tree` 条目（registerEntryRenderer 留着，但没有条目可渲染） */
  entries: boolean;
}

/**
 * Web 面板开关（用户 2026-11-08：「期望是 pi 启动，他也启动，reload 就退出重启」）。
 * 面板是 pi 的附属物，所以开关与端口必须落盘 —— 否则每次启动都得手敲 `/skill-evolve web`。
 */
export interface WebConfig {
  /** true → 每个 `session_start`（含 `/reload` 后的新实例）自动起面板 */
  enabled: boolean;
  /** 监听端口；1..65535，非法值回落到 7788 并留一行日志 */
  port: number;
}

/**
 * 四个独立开关的字段名（用户 2026-11-08：「自动复盘后，还有自动评审、自动采纳的流程，开关也独立出来」）：
 * - `enabled`    = 派生复盘（起子进程跑 agent，**花 token**）
 * - `telemetry`  = 采集遥测（只写本地 jsonl，**不花 token**）
 * - `autoReview` = 提案后的自动评审（再起一个督导子进程，**再花一份 token**）
 * - `autoApply`  = auto 级提案自动落盘（改 `.pi/skills/` 与 `.cursor/`，**可回滚**）
 * 字段级分开之后，命令（collect / dispatch / review / apply）与 Web 控制条都只切其中一个。
 */
export type ConfigFlag = "enabled" | "telemetry" | "autoReview" | "autoApply";

export interface EvolutionConfig {
  /** 派生总开关：false 时一律不派生（`/skill-evolve on` 与自动评审一起开、`off` 全关；`dispatch` 只切它） */
  enabled: boolean;
  /** 去抖窗口（毫秒）：窗口内再次 settled 只记 superseded，不叠加派生 */
  idleMs: number;
  /** 单次 run 最长存活（毫秒）：孤儿锁按 2 倍判死 */
  maxRuntimeMs: number;
  /** 单会话派生次数上限（进程内计数）；跨会话的总量由 lib/single-flight.ts 的全局闸兜底 */
  perSessionCap: number;
  /** 评审不通过时给提案 Agent 的重写机会（默认 0：2026-11-13 用户定「不用评审 Agent，也不用三次重写」） */
  maxRewrites: number;
  /** 触发复盘的会话轮次门槛：用户消息必须 **大于** 这个数（默认 5 = 第 6 条起才值得花 token） */
  minUserMessages: number;
  /** 趋势统计的回看天数（`/skill-evolve report --week` 的指标窗口）：默认 28 天 */
  metricsWindowDays: number;
  /** 采纳前备份保留天数（`backups/<runId>/`）：默认 3 天，超期在 session_start 清掉 */
  backupRetentionDays: number;
  /** L0 遥测采集开关（默认关：采集会在 `.pi/evolution/telemetry/` 落盘；`collect` 只切它） */
  telemetry: boolean;
  /** 自动评审开关（默认开：复盘出了提案就起评审督导；关掉后 run 停在 proposed 等人工批准） */
  autoReview: boolean;
  /** 自动采纳开关（默认关：只有 description / `.cursor` stub / AGENTS.md 索引行这三类 auto 提案会落盘，且须人工先开） */
  autoApply: boolean;
  /** 界面推送开关：默认全关（想回 TUI 面板就显式打开） */
  ui: UiConfig;
  /** Web 面板：默认不起（谁也没要过就不该占端口），端口按约定值 7788 */
  web: WebConfig;
}

export const DEFAULT_CONFIG: Readonly<EvolutionConfig> = Object.freeze({
  enabled: false,
  // 2026-11-13 用户定：会话结束 10 分钟后再复盘（原来 90 秒，太急着起子进程，一次会话能被拆成好几轮）
  idleMs: 10 * 60_000,
  maxRuntimeMs: 20 * 60_000,
  perSessionCap: 20,
  // 2026-11-13 用户定：不设评审 Agent，故也没有「重写」这一步（0 = 不重写）
  maxRewrites: 0,
  // 2026-11-13 用户定：用户消息 > 5 条才触发复盘
  minUserMessages: 5,
  // 28 天 = 四个整周，既够看出「这周比上周」又不至于把两个月前的旧账算进趋势（2026-11-10 搬上配置页）
  metricsWindowDays: 28,
  // 3 天（2026-11-10 用户定）：回滚窗口靠 git 兜底，备份只留最近的
  backupRetentionDays: 3,
  telemetry: false,
  // 自动评审默认关（2026-11-08 用户定）：评审本身也要起子进程再花一份 token，
  // 不能让「打开复盘」顺手把 token 翻倍。要评审就显式 `/skill-evolve review on`。
  autoReview: false,
  // 自动采纳默认关：它改的是仓库文件，必须人工先开一次；默认开等于替用户做决定。
  autoApply: false,
  ui: Object.freeze({ widget: false, entries: false }),
  // Web 面板是「管理界面」，默认随 pi 启动；它与采集/派生（enabled / telemetry）是两回事，
  // 后者默认关闭——面板起来不等于开始花 token。2026-11-08 用户定。
  web: Object.freeze({ enabled: true, port: 7788 }),
});

export function configFile(evolutionDir: string): string {
  return path.join(evolutionDir, "config.json");
}

/** 0 是合法值（= 不重写），负数与小数一律回落到默认 */
function nonNegativeInt(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return fallback;
  return Math.floor(value);
}

function positiveInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

/** 带上下界的整数：越界或非整数一律回落默认值（配置是给人手改的，写错不该改变语义） */
function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const next = Math.floor(value);
  return next >= min && next <= max ? next : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/**
 * 端口校验：必须是 1..65535 的整数。非法值回落 7788 并留一行 warn ——
 * 写错一个端口号不该让面板整个起不来，也不该牵连其它配置项。
 */
function webPort(value: unknown, log: (msg: string) => void): number {
  const fallback = DEFAULT_CONFIG.web.port;
  if (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65535) return value;
  // 只有「写了但写错」才告警：老配置里根本没有 web 块属于正常情况，不该刷日志
  if (value !== undefined) log(`[skill-evolve] 配置里的 web.port 非法（${JSON.stringify(value)}），已回落到 ${fallback}`);
  return fallback;
}

/** 逐字段校验：坏值与缺字段各自回退默认，不让配置错误中断采集 */
export function normalizeConfig(raw: unknown, log: (msg: string) => void = () => {}): EvolutionConfig {
  const input = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  // ui / web 是嵌套对象：整块缺 / 类型不对时整块回退，个别字段坏只回退那个字段
  const ui = (input.ui && typeof input.ui === "object" ? input.ui : {}) as Record<string, unknown>;
  const web = (input.web && typeof input.web === "object" ? input.web : {}) as Record<string, unknown>;
  return {
    enabled: bool(input.enabled, DEFAULT_CONFIG.enabled),
    idleMs: positiveInt(input.idleMs, DEFAULT_CONFIG.idleMs),
    maxRuntimeMs: positiveInt(input.maxRuntimeMs, DEFAULT_CONFIG.maxRuntimeMs),
    perSessionCap: positiveInt(input.perSessionCap, DEFAULT_CONFIG.perSessionCap),
    maxRewrites: nonNegativeInt(input.maxRewrites, DEFAULT_CONFIG.maxRewrites),
    // 0 = 不设门槛（每条会话都复盘）；上限 1000 防止手写成天文数字等于永久静默
    minUserMessages: clampInt(input.minUserMessages, DEFAULT_CONFIG.minUserMessages, 0, 1000),
    // 窗口太短看不出趋势（<7 天不足一周对比）、太长等于把历史全算进来：越界回落默认值而不是静默截断
    metricsWindowDays: clampInt(input.metricsWindowDays, DEFAULT_CONFIG.metricsWindowDays, 7, 365),
    // 0 天等于「刚备份就删」，365 以上等于不清理：两头都越界回落 3 天
    backupRetentionDays: clampInt(input.backupRetentionDays, DEFAULT_CONFIG.backupRetentionDays, 1, 365),
    telemetry: bool(input.telemetry, DEFAULT_CONFIG.telemetry),
    autoReview: bool(input.autoReview, DEFAULT_CONFIG.autoReview),
    autoApply: bool(input.autoApply, DEFAULT_CONFIG.autoApply),
    ui: {
      widget: bool(ui.widget, DEFAULT_CONFIG.ui.widget),
      entries: bool(ui.entries, DEFAULT_CONFIG.ui.entries),
    },
    web: {
      enabled: bool(web.enabled, DEFAULT_CONFIG.web.enabled),
      port: webPort(web.port, log),
    },
  };
}

/** 读原始字段（保留后续阶段可能追加的键）；解析失败返回空对象 */
export function readRawConfig(evolutionDir: string): Record<string, unknown> {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(configFile(evolutionDir), "utf8"));
    return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** 读配置：文件不存在 → 默认值（静默）；文件坏 → 默认值 + 一行日志 */
export function loadConfig(evolutionDir: string, log: (msg: string) => void = () => {}): EvolutionConfig {
  const file = configFile(evolutionDir);
  try {
    return normalizeConfig(JSON.parse(fs.readFileSync(file, "utf8")), log);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
      log(`[skill-evolve] 配置读取失败，改用默认值：${String(error)}`);
    }
    return { ...DEFAULT_CONFIG };
  }
}

/**
 * 只写一个开关（`/skill-evolve collect|dispatch|review|apply`、Web 控制条的单个开关）：
 * 目标字段按传入值写，其余键（其它三个开关、去抖 / 上限、ui / web 块）原样保留。
 * 返回归一化后的新配置，调用方用 Object.assign 原地更新正在用的那份。
 */
export async function saveFlag(
  evolutionDir: string,
  field: ConfigFlag,
  value: boolean,
  queue: MutationQueue,
): Promise<EvolutionConfig> {
  const raw = readRawConfig(evolutionDir);
  const next = normalizeConfig({ ...raw, [field]: value });
  const file = configFile(evolutionDir);
  await queue(file, async () => {
    await fs.promises.mkdir(evolutionDir, { recursive: true });
    await fs.promises.writeFile(file, `${JSON.stringify({ ...raw, ...next }, null, 2)}\n`, "utf8");
  });
  return next;
}

/**
 * 一键切换（`/skill-evolve on|off`）：
 * - `on`  = 复盘 + 评审两开（**不动采集，也不动自动采纳**）：这两项才是「花 token 的那条流水线」；
 * - `off` = 四个全关（连采集与自动采纳一起停），因为「先全关再走」比连点四个开关更不容易漏。
 * 一次读 + 一次写，四个键落在同一个事务里，不会出现「写了一半」的中间态。
 */
export async function saveConfigSwitch(
  evolutionDir: string,
  on: boolean,
  queue: MutationQueue,
): Promise<EvolutionConfig> {
  const raw = readRawConfig(evolutionDir);
  const patch = on
    ? { enabled: true }
    : { enabled: false, telemetry: false, autoReview: false, autoApply: false };
  const next = normalizeConfig({ ...raw, ...patch });
  const file = configFile(evolutionDir);
  await queue(file, async () => {
    await fs.promises.mkdir(evolutionDir, { recursive: true });
    await fs.promises.writeFile(file, `${JSON.stringify({ ...raw, ...next }, null, 2)}\n`, "utf8");
  });
  return next;
}

/**
 * 配置页一次保存八项（模型 / 去抖 / 上限 / 次数 / 窗口 / 备份保留 / 端口）：**只写传进来的键**，其余键原样保留。
 *
 * 嵌套键不能直接摊平写：`propose.model` 与 `review.model` 在 config.json 里是对象，
 * `web.port` 在 web 块里 —— 直接 `{...raw, port: x}` 会写出一个顶层 port，读的时候根本读不到。
 * 所以先按块合并，再交给 `normalizeConfig` 归一化，最后把归一化结果盖回原始对象上（未知键保留）。
 */
export async function saveSettings(
  evolutionDir: string,
  patch: SettingsPatch,
  queue: MutationQueue,
): Promise<EvolutionConfig> {
  const raw = readRawConfig(evolutionDir);
  const nextRaw: Record<string, unknown> = { ...raw };
  if (patch.idleMs !== undefined) nextRaw.idleMs = patch.idleMs;
  if (patch.maxRuntimeMs !== undefined) nextRaw.maxRuntimeMs = patch.maxRuntimeMs;
  if (patch.perSessionCap !== undefined) nextRaw.perSessionCap = patch.perSessionCap;
  if (patch.metricsWindowDays !== undefined) nextRaw.metricsWindowDays = patch.metricsWindowDays;
  if (patch.backupRetentionDays !== undefined) nextRaw.backupRetentionDays = patch.backupRetentionDays;
  const block = (key: string): Record<string, unknown> => {
    const node = raw[key];
    return node && typeof node === "object" ? (node as Record<string, unknown>) : {};
  };
  if (patch.propose !== undefined) nextRaw.propose = { ...block("propose"), model: patch.propose };
  if (patch.review !== undefined) nextRaw.review = { ...block("review"), model: patch.review };
  if (patch.port !== undefined) nextRaw.web = { ...block("web"), port: patch.port };
  const next = normalizeConfig(nextRaw);
  const file = configFile(evolutionDir);
  await queue(file, async () => {
    await fs.promises.mkdir(evolutionDir, { recursive: true });
    await fs.promises.writeFile(file, `${JSON.stringify({ ...nextRaw, ...next }, null, 2)}\n`, "utf8");
  });
  return next;
}

/**
 * 只改 web 块（`/skill-evolve web` 写 enabled=true、`off` 写 enabled=false）：
 * 与 `saveConfigSwitch` 一样保留其余键 —— 开关面板不该顺手改掉去抖、上限或模型配置。
 */
export async function saveWebConfig(
  evolutionDir: string,
  patch: { enabled?: boolean; port?: number },
  queue: MutationQueue,
): Promise<EvolutionConfig> {
  const raw = readRawConfig(evolutionDir);
  const web = (raw.web && typeof raw.web === "object" ? raw.web : {}) as Record<string, unknown>;
  const next = normalizeConfig({ ...raw, web: { ...web, ...patch } });
  const file = configFile(evolutionDir);
  await queue(file, async () => {
    await fs.promises.mkdir(evolutionDir, { recursive: true });
    await fs.promises.writeFile(file, `${JSON.stringify({ ...raw, ...next }, null, 2)}\n`, "utf8");
  });
  return next;
}
