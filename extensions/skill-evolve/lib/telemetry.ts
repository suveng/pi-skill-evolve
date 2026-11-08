/**
 * L0 遥测：append-only JSONL，按天分片 `.pi/evolution/telemetry/YYYY-MM-DD.jsonl`。
 *
 * 三条硬约定：
 * 1. 写失败只记日志，绝不抛到主会话（采集器坏了不能影响用户干活）；
 * 2. 每行同时存毫秒戳与 ISO 串（人读 ISO，机器算差值用毫秒）；
 * 3. 这里只写事实，不做归因。
 */
import * as fs from "node:fs";
import * as path from "node:path";

/** 写入串行化：生产注入 pi 的 withFileMutationQueue，单测注入直写 */
export type MutationQueue = <T>(filePath: string, fn: () => Promise<T>) => Promise<T>;

export const directQueue: MutationQueue = async (_filePath, fn) => fn();

export type TelemetryKind =
  | "advertised"
  | "loaded"
  | "failed"
  | "missed"
  | "pending"
  | "dispatched"
  /** 同会话聚合：{kind:"merged", runId, sessionId, rounds} —— 这一轮并进了已有的在途 run */
  | "merged"
  | "skipped"
  | "superseded"
  | "handler_error"
  /** 机械归因结果：{kind:"attributed", skill, category, reason} */
  | "attributed"
  /** 硬禁令命中：{kind:"conflict", ruleId, level, skill, line} */
  | "conflict";

/** 曝光快照里的一条技能（filePath 可能为空：嵌入式调用缺该字段时要能兜底） */
export interface TelemetrySkill {
  name: string;
  filePath: string;
  disabled: boolean;
  source: string;
}

export interface TelemetryEvent {
  ts: number;
  iso: string;
  kind: TelemetryKind;
  sessionId?: string;
  [key: string]: unknown;
}

export type TelemetryInput = { kind: TelemetryKind; ts?: number; [key: string]: unknown };

export interface MissedStat {
  skill: string;
  count: number;
}

export interface TelemetrySummary {
  /** 跑了多少轮（advertised 事件数） */
  rounds: number;
  /** 曝光了多少个技能条目（各轮 skills 长度之和） */
  advertised: number;
  loaded: number;
  failed: number;
  missed: number;
  /** 加载事件数 / 曝光条目数；重复加载会让它大于 1，读数时注意 */
  loadRate: number;
  missedTop: MissedStat[];
}

export interface TelemetryWriter {
  append(event: TelemetryInput): void;
  /** 同步追加：只给 `session_shutdown` 用（主进程马上退出，异步队列可能来不及落盘） */
  appendSync(event: TelemetryInput): void;
  flush(): Promise<void>;
}

/** 本地日期（YYYY-MM-DD）：报告按人看的「今天」对齐，不按 UTC */
export function dayOf(ts: number): string {
  const date = new Date(ts);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function shardFile(dir: string, ts: number): string {
  return path.join(dir, `${dayOf(ts)}.jsonl`);
}

/** 除零返回 0，不返回 NaN/Infinity：报告里出现 NaN 比没数更糟 */
export function ratio(part: number, total: number): number {
  return Number.isFinite(part) && Number.isFinite(total) && total > 0 ? part / total : 0;
}

export function summarize(events: readonly TelemetryEvent[]): TelemetrySummary {
  let rounds = 0;
  let advertised = 0;
  let loaded = 0;
  let failed = 0;
  let missed = 0;
  const misses = new Map<string, number>();

  for (const event of events) {
    if (event.kind === "advertised") {
      rounds += 1;
      const skills = Array.isArray(event.skills) ? (event.skills as TelemetrySkill[]) : [];
      // disableModelInvocation 的技能压根没进 prompt，不算曝光（它们属于归因 A 类，单独处理）
      advertised += skills.filter((skill) => skill?.disabled !== true).length;
    } else if (event.kind === "loaded") {
      loaded += 1;
    } else if (event.kind === "failed") {
      failed += 1;
    } else if (event.kind === "missed") {
      missed += 1;
      const skill = typeof event.skill === "string" ? event.skill : "(未知)";
      misses.set(skill, (misses.get(skill) ?? 0) + 1);
    }
  }

  const missedTop = [...misses.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 10)
    .map(([skill, count]) => ({ skill, count }));

  return { rounds, advertised, loaded, failed, missed, loadRate: ratio(loaded, advertised), missedTop };
}

export function createTelemetry(options: {
  dir: string;
  queue: MutationQueue;
  /** 可传 getter：`/skill-evolve on|off` 当场改配置后采集要立刻跟着变，不能靠重启会话 */
  enabled: boolean | (() => boolean);
  log?: (msg: string) => void;
  now?: () => number;
}): TelemetryWriter {
  const log = options.log ?? (() => {});
  const pending = new Set<Promise<void>>();
  const enabledNow = (): boolean => (typeof options.enabled === "function" ? options.enabled() : options.enabled);

  const recordOf = (event: TelemetryInput): { record: TelemetryEvent; file: string; line: string } => {
    const ts = typeof event.ts === "number" && Number.isFinite(event.ts) ? event.ts : (options.now?.() ?? Date.now());
    const record: TelemetryEvent = { ...event, ts, iso: new Date(ts).toISOString() };
    const file = shardFile(options.dir, ts);
    return { record, file, line: `${JSON.stringify(record)}\n` };
  };

  const append = (event: TelemetryInput): void => {
    if (!enabledNow()) return;
    const { file, line } = recordOf(event);
    const write = options.queue(file, async () => {
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      await fs.promises.appendFile(file, line, "utf8");
    });
    const settled = write.then(
      () => undefined,
      (error: unknown) => {
        log(`[skill-evolve] 遥测写入失败（${file}）：${String(error)}`);
      },
    );
    pending.add(settled);
    void settled.then(() => pending.delete(settled));
  };

  const appendSync = (event: TelemetryInput): void => {
    if (!enabledNow()) return;
    const { file, line } = recordOf(event);
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, line, "utf8");
    } catch (error) {
      log(`[skill-evolve] 遥测写入失败（${file}）：${String(error)}`);
    }
  };

  const flush = async (): Promise<void> => {
    await Promise.all([...pending]);
  };

  return { append, appendSync, flush };
}

/** 读最近 days 天的事件（跨天分片按日期倒推，坏行跳过） */
export function readEvents(dir: string, days: number, now: number = Date.now()): TelemetryEvent[] {
  const span = Number.isFinite(days) && days > 0 ? Math.floor(days) : 7;
  const events: TelemetryEvent[] = [];
  for (let offset = span - 1; offset >= 0; offset -= 1) {
    const day = new Date(now);
    day.setDate(day.getDate() - offset);
    const file = shardFile(dir, day.getTime());
    let text: string;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (line.trim().length === 0) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (parsed && typeof (parsed as TelemetryEvent).kind === "string") {
          events.push(parsed as TelemetryEvent);
        }
      } catch {
        // 坏行是旁路数据的常态，跳过即可，不影响报告结论
      }
    }
  }
  return events;
}
