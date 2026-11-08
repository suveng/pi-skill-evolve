/**
 * 必红自检（设计稿 12.4）：拿三个**已知该被拦住**的坏样本去考评审器。
 *
 * 这是整条流水线唯一的「评审器自己可信吗」证据：如果评审器把「可以用 find」判成 pass，
 * 后面所有真提案的 pass 都没有意义，所以这里任何一条 expected 没命中就拿 `passed: false`
 * 并在报告里打红字，派发也随之停摆。
 *
 * 注意：这里**故意不跑机械 P0 复验** —— 那几个坏样本里有两条本身就违反硬规则，
 * 用规则引擎拒掉只能证明规则还活着，证明不了评审器会判断内容。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { loadHardRules, type CompiledRules } from "./hard-rules.ts";
import { buildReviewPrompt } from "./review-prompt.ts";
import { reviewWithRetry, type ReviewSpawn } from "./review-run.ts";

export type SelftestExpectation = "pass" | "reject" | "revise";

export interface SelftestFixture {
  name: string;
  skill: string;
  expected: SelftestExpectation;
  why: string;
  dir: string;
  diff: string;
  after: string;
}

export interface SelftestCase {
  name: string;
  expected: SelftestExpectation;
  actual: string;
  ok: boolean;
  detail?: string;
  attempts: number;
  ms: number;
}

export interface SelftestReport {
  at: number;
  atIso: string;
  passed: boolean;
  results: SelftestCase[];
}

export const SELFTEST_FILE = "selftest.json";
/** 报告与命令里共用的红字提示 */
export const UNTRUSTED_NOTE = "评审器不可信，流水线停用：先修评审 prompt / 换更大的评审模型，再跑 /skill-evolve selftest";

const EXPECTATIONS: readonly SelftestExpectation[] = ["pass", "reject", "revise"];

export function selftestFile(evolutionDir: string): string {
  return path.join(evolutionDir, SELFTEST_FILE);
}

function readText(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

/** 读三个 fixture；缺文件 / 坏 JSON 的目录直接跳过（不猜、不补） */
export function loadFixtures(dir: string, log: (msg: string) => void = () => {}): SelftestFixture[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir).sort();
  } catch (error) {
    log(`[skill-evolve] 自检样本目录读不到：${String(error)}`);
    return [];
  }
  const fixtures: SelftestFixture[] = [];
  for (const entry of entries) {
    const fixtureDir = path.join(dir, entry);
    const meta = readText(path.join(fixtureDir, "fixture.json"));
    if (!meta) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(meta) as Record<string, unknown>;
    } catch {
      log(`[skill-evolve] 自检样本坏 JSON，跳过：${entry}`);
      continue;
    }
    const name = typeof parsed.name === "string" ? parsed.name : entry;
    const skill = typeof parsed.skill === "string" ? parsed.skill : name;
    const expected = parsed.expected as SelftestExpectation | undefined;
    if (!expected || !EXPECTATIONS.includes(expected)) {
      log(`[skill-evolve] 自检样本 expected 非法，跳过：${entry}`);
      continue;
    }
    const diff = readText(path.join(fixtureDir, "change.diff"));
    const after = readText(path.join(fixtureDir, "after.md"));
    if (diff === undefined || after === undefined) {
      log(`[skill-evolve] 自检样本缺 change.diff / after.md，跳过：${entry}`);
      continue;
    }
    fixtures.push({
      name,
      skill,
      expected,
      why: typeof parsed.why === "string" ? parsed.why : "",
      dir: fixtureDir,
      diff,
      after,
    });
  }
  return fixtures;
}

export function readSelftestReport(evolutionDir: string): SelftestReport | undefined {
  const text = readText(selftestFile(evolutionDir));
  if (!text) return undefined;
  try {
    const raw = JSON.parse(text) as Record<string, unknown>;
    return typeof raw.passed === "boolean" ? (raw as unknown as SelftestReport) : undefined;
  } catch {
    return undefined;
  }
}

export interface SelftestOptions {
  evolutionDir: string;
  cwd: string;
  fixturesDir?: string;
  rules?: CompiledRules;
  model?: string;
  env?: NodeJS.ProcessEnv;
  spawnFn?: ReviewSpawn;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  log?: (msg: string) => void;
}

/** 依次跑完三个坏样本；返回报告并写 `selftest.json`（写失败只记日志） */
export async function runSelftest(options: SelftestOptions): Promise<SelftestReport> {
  const log = options.log ?? (() => {});
  const now = options.now ?? Date.now;
  const fixturesDir = options.fixturesDir ?? fileURLToPath(new URL("../fixtures/selftest", import.meta.url));
  const rules = options.rules ?? loadHardRules(path.join(options.evolutionDir, "rules", "hard-rules.json"));
  const fixtures = loadFixtures(fixturesDir, log);
  const results: SelftestCase[] = [];
  for (const fixture of fixtures) {
    const prompt = buildReviewPrompt({
      skillName: fixture.skill,
      skillText: fixture.after,
      diffApplied: true,
      diff: fixture.diff,
      hardRules: rules.compiled,
    });
    const outcome = await reviewWithRetry({
      prompt,
      cwd: options.cwd,
      ...(options.model ? { model: options.model } : {}),
      ...(options.env ? { env: options.env } : {}),
      ...(options.spawnFn ? { spawnFn: options.spawnFn } : {}),
      ...(options.sleep ? { sleep: options.sleep } : {}),
      ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
      now,
      log,
    });
    const actual = outcome.result.verdict ?? outcome.result.status;
    const ok = outcome.result.status === "ok" && outcome.result.verdict === fixture.expected;
    results.push({
      name: fixture.name,
      expected: fixture.expected,
      actual,
      ok,
      ...(outcome.result.detail ? { detail: outcome.result.detail } : {}),
      attempts: outcome.attempts,
      ms: outcome.ms,
    });
    log(
      `[skill-evolve] 自检 ${fixture.name}：期望 ${fixture.expected}，实际 ${actual}${ok ? "" : " ← 不合格"}`,
    );
  }
  const at = now();
  const report: SelftestReport = { at, atIso: new Date(at).toISOString(), passed: results.length > 0 && results.every((item) => item.ok), results };
  try {
    fs.mkdirSync(options.evolutionDir, { recursive: true });
    fs.writeFileSync(selftestFile(options.evolutionDir), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  } catch (error) {
    log(`[skill-evolve] 自检报告写失败：${String(error)}`);
  }
  log(`[skill-evolve] 自检${report.passed ? "通过" : "未通过"}：${results.filter((item) => item.ok).length}/${results.length}`);
  return report;
}

/** 命令侧文案：任一不合格就把红字顶到第一行 */
export function renderSelftestReport(report: SelftestReport | undefined): string {
  if (!report) return "自检：还没跑过（/skill-evolve selftest）";
  const lines: string[] = [];
  if (!report.passed) lines.push(`【红】${UNTRUSTED_NOTE}`, "");
  lines.push(`自检（${report.atIso}）：${report.passed ? "通过" : "未通过"}`);
  for (const item of report.results) {
    lines.push(`  ${item.ok ? "✓" : "✗"} ${item.name}  期望 ${item.expected}  实际 ${item.actual}${item.detail ? `（${item.detail}）` : ""}`);
  }
  return lines.join("\n");
}
