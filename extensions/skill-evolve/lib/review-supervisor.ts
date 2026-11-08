/**
 * 评审督导（设计稿 12）——独立 node 进程，由派发方在起复盘子进程的同一次派发里拉起。
 *
 * 为什么必须是独立进程而不是复盘 agent 自己评：复盘 agent 刚写完提案，让它评审等于自评，
 * 而且它的上下文里全是自己的推理，评不出自己的错。这里只等产物落盘，再按固定模板另起评审子进程。
 *
 * 职责：
 *   1. 轮询 `02-proposal.json`（默认 900s 超时 → 写 skipped/proposal-timeout）
 *   2. 组装评审 prompt（只给硬约束 + diff + 改后全文 + 验收标准）
 *   3. 起评审子进程（默认 300s 超时），invalid 重评一次
 *   4. 代码后处理 + 机械复验（新增 P0 命中、candidate frontmatter 坏 → 一票 reject）
 *   5. 写 `03-review.json` / `03-review.md`，更新 `run.json`
 *
 * 本进程不做 git 操作、不写 `.pi/skills`、不写别的 run 目录（闸 0 / 闸 1 的边界）。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { loadHardRules, scanText, type CompiledRules, type HardRuleHit } from "./hard-rules.ts";
import { buildReviewPrompt } from "./review-prompt.ts";
import { classifyChange } from "./classify-action.ts";
import { renderReviewMarkdown, stageModel, type ReviewRecord, type SupervisorStatus } from "./review-record.ts";
import { reviewWithRetry, type ReviewSpawn } from "./review-run.ts";
import { patchRunRecordSync } from "./runs.ts";
import { applyUnifiedDiff } from "./diff-apply.ts";

export const PROPOSAL_TIMEOUT_MS = 900_000;
const PROPOSAL_POLL_MS = 2000;

export interface ReviewSupervisorDeps {
  runDir: string;
  evolutionDir?: string;
  env?: NodeJS.ProcessEnv;
  log?: (msg: string) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  spawnFn?: ReviewSpawn;
  /** 读文本；undefined = 文件不存在（单测注入） */
  readText?: (file: string) => string | undefined;
  writeText?: (file: string, text: string) => void;
  /** 评审模型："inherit" 或 provider/model */
  reviewModel?: string;
  rules?: CompiledRules;
  proposalTimeoutMs?: number;
  reviewTimeoutMs?: number;
  pollMs?: number;
}

export interface SupervisorOutcome {
  status: SupervisorStatus;
  record: ReviewRecord;
  ms: number;
}

function defaultReadText(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

/** 先写临时文件再 rename：督导被 SIGKILL 时不会留下半截 JSON */
function defaultWriteText(file: string, text: string): void {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text, "utf8");
  fs.renameSync(tmp, file);
}

interface ProposalMeta {
  type: string;
  skill: string;
  diffFile?: string;
  candidateFile?: string;
}

export function parseProposal(text: string | undefined): ProposalMeta | undefined {
  if (!text) return undefined;
  try {
    const raw = JSON.parse(text) as Record<string, unknown>;
    if (typeof raw.skill !== "string" || raw.skill.trim().length === 0) return undefined;
    return {
      type: typeof raw.type === "string" ? raw.type : "improve",
      skill: raw.skill.trim(),
      ...(typeof raw.diffFile === "string" ? { diffFile: raw.diffFile } : {}),
      ...(typeof raw.candidateFile === "string" ? { candidateFile: raw.candidateFile } : {}),
    };
  } catch {
    return undefined;
  }
}

/** 只查「新增」的 P0 命中：存量债不该拦住一次正当的文案改动 */
export function newHardRuleHits(before: string, after: string, rules: CompiledRules, skill: string): HardRuleHit[] {
  const key = (hit: HardRuleHit) => `${hit.ruleId}\u0000${hit.quote.trim()}`;
  const known = new Set(scanText(before, rules.compiled, skill).map(key));
  return scanText(after, rules.compiled, skill).filter((hit) => !known.has(key(hit)));
}

/** candidate 的最小 frontmatter 校验：独立进程里拿不到 loadSkillsFromDir，这是兜底 */
export function checkCandidateFrontmatter(text: string): string | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) return "缺 frontmatter";
  const front = match[1];
  if (!/^name:\s*\S/m.test(front)) return "frontmatter 缺 name";
  if (!/^description:\s*\S/m.test(front)) return "frontmatter 缺 description";
  return null;
}

function cwdOf(runRaw: string | undefined): string {
  if (runRaw) {
    try {
      const raw = JSON.parse(runRaw) as Record<string, unknown>;
      if (typeof raw.cwd === "string" && raw.cwd.length > 0) return raw.cwd;
    } catch {
      // run.json 坏掉就退回当前工作目录，后面读不到原文会走「只有 diff 可信」的降级
    }
  }
  return process.cwd();
}

/** 等提案文件出现；超时也再读一次（可能刚好落盘） */
async function waitForProposal(
  file: string,
  deps: ReviewSupervisorDeps,
  read: (file: string) => string | undefined,
): Promise<string | undefined> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + (deps.proposalTimeoutMs ?? PROPOSAL_TIMEOUT_MS);
  while (now() < deadline) {
    const text = read(file);
    if (text !== undefined) return text;
    await sleep(deps.pollMs ?? PROPOSAL_POLL_MS);
  }
  return read(file);
}

function stamp(ts: number): { reviewedAt: number; reviewedAtIso: string } {
  return { reviewedAt: ts, reviewedAtIso: new Date(ts).toISOString() };
}

export async function runReviewSupervisor(deps: ReviewSupervisorDeps): Promise<SupervisorOutcome> {
  const now = deps.now ?? Date.now;
  const started = now();
  const read = deps.readText ?? defaultReadText;
  const write = deps.writeText ?? defaultWriteText;
  const log = deps.log ?? (() => {});
  const runDir = path.resolve(deps.runDir);
  const evolutionDir = deps.evolutionDir ?? path.resolve(runDir, "..", "..");
  const runFile = path.join(runDir, "run.json");
  const runRaw = read(runFile);
  const proposerModel = stageModel(runRaw);
  const reviewerModel = deps.reviewModel ?? "inherit";
  const sameModel = proposerModel.length > 0 && proposerModel === reviewerModel;
  const base = { reviewerModel, proposerModel, sameModel };

  const proposalText = await waitForProposal(path.join(runDir, "02-proposal.json"), deps, read);
  const proposal = parseProposal(proposalText);
  if (!proposal) {
    const record: ReviewRecord = {
      ...base,
      status: "skipped",
      reason: proposalText === undefined ? "proposal-timeout" : "proposal-unreadable",
      blocking: [],
      ...stamp(now()),
    };
    write(path.join(runDir, "03-review.json"), `${JSON.stringify(record, null, 2)}\n`);
    log(`[skill-evolve] 评审跳过：${record.reason}（${path.basename(runDir)}）`);
    return { status: "skipped", record, ms: now() - started };
  }

  const cwd = cwdOf(runRaw);
  const rules = deps.rules ?? loadHardRules(path.join(evolutionDir, "rules", "hard-rules.json"));
  const target = path.join(cwd, ".pi", "skills", proposal.skill, "SKILL.md");
  const candidateFile = path.join(runDir, proposal.candidateFile ?? path.posix.join("candidate", proposal.skill, "SKILL.md"));
  const diffFile = proposal.diffFile ?? "02-proposal.diff";
  const diffText = read(path.join(runDir, diffFile)) ?? "";
  // 改动前全文：优先 candidate（新建技能没有基线文件），其次工作区里当前的技能
  const beforeText = read(candidateFile) ?? read(target) ?? "";
  const applied = diffText.length > 0 ? applyUnifiedDiff(beforeText, diffText) : null;
  const afterText = applied !== null && applied.ok ? applied.text : beforeText;
  const recheck = (): string | null => {
    if (proposal.type === "create") return checkCandidateFrontmatter(read(candidateFile) ?? "");
    const hits = newHardRuleHits(beforeText, afterText, rules, proposal.skill);
    return hits.length > 0 ? `新增 P0 命中 ${hits[0].ruleId}（${hits[0].skill}:${hits[0].line}）` : null;
  };

  const prompt = buildReviewPrompt({
    skillName: proposal.skill,
    skillText: afterText,
    diffApplied: applied !== null && applied.ok,
    diff: diffText,
    hardRules: rules.compiled,
  });
  const outcome = await reviewWithRetry({
    prompt,
    cwd,
    model: reviewerModel,
    ...(deps.env ? { env: deps.env } : {}),
    ...(deps.spawnFn ? { spawnFn: deps.spawnFn } : {}),
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
    ...(deps.reviewTimeoutMs ? { timeoutMs: deps.reviewTimeoutMs } : {}),
    ...(deps.log ? { log: deps.log } : {}),
    recheck,
  });

  const verdict = outcome.result.verdict;
  // invalid = 评审输出不可用（重评也没救）；reject 是机械复验的定论，按「被否决」记，不算失败
  const status: SupervisorStatus =
    outcome.result.status === "invalid" ? "review_failed" : verdict === "pass" ? "reviewed" : "rejected";
  const record: ReviewRecord = {
    ...base,
    status,
    ...(verdict ? { verdict } : {}),
    blocking: outcome.result.blocking,
    passed: outcome.result.passed,
    ...(outcome.result.summary ? { summary: outcome.result.summary } : {}),
    ...(outcome.result.notes ? { notes: outcome.result.notes } : {}),
    action: classifyChange({ diffText, proposalType: proposal.type, skill: proposal.skill }).level,
    attempts: outcome.attempts,
    ...(outcome.result.detail ? { detail: outcome.result.detail } : {}),
    ...stamp(now()),
  };
  write(path.join(runDir, "03-review.json"), `${JSON.stringify(record, null, 2)}\n`);
  write(path.join(runDir, "03-review.md"), renderReviewMarkdown(record, proposal.skill));

  if (runRaw) {
    try {
      const runJson = JSON.parse(runRaw) as Record<string, unknown>;
      runJson.status = status === "reviewed" ? "reviewed" : status === "rejected" ? "rejected" : "review_failed";
      runJson.review = {
        status,
        verdict: verdict ?? null,
        action: record.action,
        reviewerModel,
        proposerModel,
        sameModel,
        // 摘要写回 run.json：列表与详情页共用一存，不用为一句结论另开文件
        summary: outcome.result.summary ?? null,
        passed: outcome.result.passed.length,
      };
      write(runFile, `${JSON.stringify(runJson, null, 2)}\n`);
    } catch (error) {
      log(`[skill-evolve] 评审结论写不回 run.json：${(error as Error).message}`);
    }
  }
  log(`[skill-evolve] 评审完成：${status}${verdict ? `/${verdict}` : ""}（${path.basename(runDir)}，${outcome.attempts} 次）`);
  return { status, record, ms: now() - started };
}

async function main(): Promise<void> {
  const runDir = process.argv[2];
  if (!runDir) {
    console.error("[skill-evolve] 用法：review-supervisor.ts <runDir> [reviewModel]");
    process.exitCode = 2;
    return;
  }
  try {
    const outcome = await runReviewSupervisor({
      runDir,
      ...(process.argv[3] ? { reviewModel: process.argv[3] } : {}),
      log: (msg) => console.error(msg),
    });
    process.exitCode = outcome.status === "review_failed" ? 1 : 0;
  } finally {
    // 退出即释放单飞占用位：留着旧 pid 会被系统复用的 pid 假挡住后续派发
    patchRunRecordSync(runDir, { supervisorPid: null });
  }
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  void main().catch((error: Error) => {
    console.error(`[skill-evolve] 评审督导异常：${error.message}`);
    process.exitCode = 1;
  });
}
