/**
 * 存量债基线（设计稿 10.4）：机械扫描命中的 P0 里，「已经认账」的那部分不算失败信号。
 *
 * 为什么要有它：`.pi/skills` 里本来就存在历史违规（例如 deploy-test 里的 grep 写法）。
 * 新插件如果天天把它们报成红，等于宣布自己不可用 —— 所以命中分两段：存量（baseline）/ 新增。
 * 只有「新增」才是本次要处理的问题。
 *
 * 指纹口径：ruleId + skill + sha256(quote 前 120 字)，**不含行号**。
 * 行号会随正文增删上下漂移，带上行号就会把同一个老问题反复报成「新增」。
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { HardRuleHit } from "./hard-rules.ts";
import { logLine } from "./logfile.ts";
import type { MutationQueue } from "./telemetry.ts";

/** 与 hard-rules.ts 的 QUOTE_MAX 同口径：quote 只留前 120 字，指纹也只算这 120 字 */
export const FINGERPRINT_QUOTE_MAX = 120;
export const BASELINE_VERSION = 1;

export interface BaselineViolation {
  ruleId: string;
  level: string;
  skill: string;
  /** 行号只作参考，不进指纹：行号漂移不算新增 */
  line: number;
  quote: string;
  fingerprint: string;
}

export interface Baseline {
  version: number;
  generatedAt: number;
  /** true = 首次审计自动生成（把当时全部命中都当存量）；false = 人工 /skill-evolve baseline 接受 */
  bootstrap: boolean;
  violations: BaselineViolation[];
}

type HitLike = Pick<HardRuleHit, "ruleId" | "skill" | "quote">;

export function fingerprintOf(hit: HitLike): string {
  const quote = hit.quote.trim().slice(0, FINGERPRINT_QUOTE_MAX);
  return createHash("sha256").update(`${hit.ruleId}\u0000${hit.skill}\u0000${quote}`).digest("hex").slice(0, 16);
}

export function toViolation(hit: HardRuleHit): BaselineViolation {
  return {
    ruleId: hit.ruleId,
    level: hit.level,
    skill: hit.skill,
    line: hit.line,
    quote: hit.quote,
    fingerprint: fingerprintOf(hit),
  };
}

/** bootstrap=true 供首次审计自动生成；false 供人工「接受当前全部命中」 */
export function buildBaseline(hits: readonly HardRuleHit[], now: number, bootstrap: boolean): Baseline {
  return {
    version: BASELINE_VERSION,
    generatedAt: now,
    bootstrap,
    violations: hits.map(toViolation),
  };
}

export function baselinePath(evolutionDir: string): string {
  return path.join(evolutionDir, "baseline.json");
}

/** 读基线：文件不存在是正常状态（返回 null），内容坏了也只当不存在，绝不抛 */
export function readBaseline(file: string, log?: (msg: string) => void): Baseline | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Baseline;
    if (!Array.isArray(parsed.violations)) return null;
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      log?.(`[skill-evolve] 存量基线读取失败，按不存在处理：${String(error)}`);
    }
    return null;
  }
}

export async function saveBaseline(file: string, baseline: Baseline, queue: MutationQueue): Promise<void> {
  await queue(path.resolve(file), async () => {
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(file, `${JSON.stringify(baseline, null, 2)}\n`, "utf8");
  });
}

export function fingerprintsOf(baseline: Baseline | null): Set<string> {
  return new Set((baseline?.violations ?? []).map((item) => item.fingerprint));
}

/** 按指纹切两段：known 里的算存量，其余算新增（同一条命中不会同时落两边） */
export function splitHits(
  hits: readonly HardRuleHit[],
  known: ReadonlySet<string>,
): { stock: HardRuleHit[]; added: HardRuleHit[] } {
  const stock: HardRuleHit[] = [];
  const added: HardRuleHit[] = [];
  for (const hit of hits) {
    if (known.has(fingerprintOf(hit))) stock.push(hit);
    else added.push(hit);
  }
  return { stock, added };
}

export interface BaselineGateDeps {
  file: string;
  /** 当前命中：懒到第一次要用时才算，避免 factory 里读盘 */
  hits: () => readonly HardRuleHit[];
  now: () => number;
  queue: MutationQueue;
  log?: (msg: string) => void;
}

export interface BaselineGate {
  /** 同步取：缺文件时按当前命中 bootstrap 并 fire-and-forget 写盘（settle 是同步的，不能 await） */
  baseline(): Baseline;
  isStock(hit: HardRuleHit): boolean;
  /** `/skill-evolve baseline`：把当前全部命中写进基线，返回给人看的一句话 */
  acceptAll(): Promise<string>;
  /** `/skill-evolve baseline --reset`：清空清单（不是删文件 —— 删了下次审计又会自动 bootstrap 回存量） */
  reset(): Promise<string>;
  /** 等最后一次写盘落地（命令里要确认文件真的写了） */
  settled(): Promise<void>;
}

export function createBaselineGate(deps: BaselineGateDeps): BaselineGate {
  // 默认只落盘：基线文件就在 `.pi/evolution/` 下，日志走同一个目录的 logs/extension.log
  const log = deps.log ?? ((msg: string) => logLine(path.dirname(deps.file), msg));
  let cached: Baseline | null = null;
  let pending: Promise<void> = Promise.resolve();

  const persist = (baseline: Baseline): void => {
    cached = baseline;
    pending = saveBaseline(deps.file, baseline, deps.queue).catch((error: unknown) => {
      log(`[skill-evolve] 存量基线写盘失败：${String(error)}`);
    });
  };

  const baseline = (): Baseline => {
    if (cached) return cached;
    const onDisk = readBaseline(deps.file, log);
    if (onDisk) {
      cached = onDisk;
      return cached;
    }
    // 首次审计：把此刻扫到的全部命中当存量接受，否则第一次运行就是一屏红
    const created = buildBaseline(deps.hits(), deps.now(), true);
    log(`[skill-evolve] 首次审计自动生成存量基线：${created.violations.length} 条（${deps.file}）`);
    persist(created);
    return created;
  };

  return {
    baseline,
    isStock: (hit) => fingerprintsOf(baseline()).has(fingerprintOf(hit)),
    acceptAll: async () => {
      const accepted = buildBaseline(deps.hits(), deps.now(), false);
      persist(accepted);
      await pending;
      return `已接受 ${accepted.violations.length} 条存量 P0：${deps.file}`;
    },
    reset: async () => {
      const empty = buildBaseline([], deps.now(), false);
      persist(empty);
      await pending;
      return `已清空存量基线：${deps.file}（下次审计把所有命中都算新增）`;
    },
    settled: () => pending,
  };
}
