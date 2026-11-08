/**
 * 端到端复演（设计稿 15 章 M6 验收硬指标）：一条假技能从发现走到复验，六段状态可断言。
 *
 * 只允许在临时工作区跑（调用方负责建目录），因为这条链路会真的写 `.pi/skills/` 下的技能文件。
 * 评审可用 `fakeReview` 注入假结论（省 token）；真跑走 `reviewSpawn`，其余环节一律真写盘。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createApplyTools } from "./evolution-apply.ts";
import { captureGate0, saveGate0, type GitRunner } from "./gate0.ts";
import { loadHardRules, type CompiledRule } from "./hard-rules.ts";
import { createGitRunner } from "./proc.ts";
import { validateProposal } from "./proposal.ts";
import { postProcessReview } from "./review-post.ts";
import { buildReviewPrompt } from "./review-prompt.ts";
import { runReviewChild, type ReviewSpawn } from "./review-run.ts";
import { updateRunStatus, writeRunRecord, type RunStatus } from "./runs.ts";
import { buildSessionIndex } from "./session-index.ts";
import { directQueue, type MutationQueue } from "./telemetry.ts";
import { FAKE_REVIEW_TEXT, REPLAY_AFTER, REPLAY_BEFORE, REPLAY_DIFF, fakeSessionText } from "./replay-fixture.ts";

export const REPLAY_STAGES = ["discover", "propose", "review", "approve", "apply", "verify"] as const;
export type ReplayStage = (typeof REPLAY_STAGES)[number];

const STAGE_LABEL: Record<ReplayStage, string> = {
  discover: "发现",
  propose: "提案",
  review: "评审",
  approve: "人批",
  apply: "采纳",
  verify: "复验",
};

export interface ReplayOptions {
  cwd: string;
  evolutionDir: string;
  /** true = 用内置假评审结论（不烧 token）；false = 真起 `pi -p` */
  fakeReview: boolean;
  skillName?: string;
  now?: () => number;
  log?: (msg: string) => void;
  queue?: MutationQueue;
  git?: GitRunner;
  reviewSpawn?: ReviewSpawn;
  reviewModel?: string;
  reviewTimeoutMs?: number;
  fakeReviewText?: string;
  rulesFile?: string;
}

export interface ReplayOutcome {
  ok: boolean;
  runId: string;
  /** 六段各自的结果（人话） */
  stages: Record<ReplayStage, string>;
  /** run.json 的 status 变迁序列 */
  statuses: string[];
  failures: string[];
  lines: string[];
}

function fakeGit(): GitRunner {
  return () => ({ code: 0, out: "" });
}

async function writeText(queue: MutationQueue, file: string, text: string): Promise<void> {
  await queue(file, async () => {
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(file, text, "utf8");
  });
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

export async function runReplay(options: ReplayOptions): Promise<ReplayOutcome> {
  const now = options.now ?? (() => Date.now());
  const log = options.log ?? (() => {});
  const queue = options.queue ?? directQueue;
  const git = options.git ?? createGitRunner();
  const skill = options.skillName ?? "replay-demo";
  const started = now();
  const runId = `replay-${started.toString(36)}`;
  const evolutionDir = options.evolutionDir;
  const runDir = path.join(evolutionDir, "runs", runId);
  const skillFile = path.join(options.cwd, ".pi", "skills", skill, "SKILL.md");

  const stages = Object.fromEntries(REPLAY_STAGES.map((stage) => [stage, "未执行"])) as Record<ReplayStage, string>;
  const statuses: string[] = [];
  const failures: string[] = [];

  const recordStatus = (): void => {
    const record = readJson<{ status?: string }>(path.join(runDir, "run.json"));
    if (record?.status) statuses.push(record.status);
  };
  const fail = (stage: ReplayStage, why: string): void => {
    stages[stage] = `失败：${why}`;
    failures.push(`${stage}：${why}`);
  };

  // ── 1. 发现：技能在盘上 + 会话索引 + run.json（dispatched → analyzed）
  await writeText(queue, skillFile, REPLAY_BEFORE);
  const sessionFile = path.join(evolutionDir, "session", "session.jsonl");
  await writeText(queue, sessionFile, fakeSessionText(options.cwd, started));
  const index = buildSessionIndex(fs.readFileSync(sessionFile, "utf8"));

  await writeRunRecord(
    runDir,
    {
      runId,
      status: "dispatched" as RunStatus,
      trigger: "manual",
      sessionId: "replay-session",
      sessionHash: "replay",
      sessionFile,
      evidenceMode: "session+telemetry",
      dispatchedAt: started,
      dispatchedAtIso: new Date(started).toISOString(),
      pid: process.pid,
      cwd: options.cwd,
      skills: [skill],
      stages: [],
      artifacts: {},
    },
    queue,
  );
  recordStatus();
  await writeText(queue, path.join(runDir, "00-session", "index.json"), `${JSON.stringify(index, null, 2)}\n`);
  await updateRunStatus(evolutionDir, runId, "analyzed", queue);
  recordStatus();
  stages.discover = `技能 ${skill} · 会话索引 ${index.stats.lines} 行 · run ${runId}`;

  // ── 2. 提案：写 02-proposal.{json,diff}
  const diff = REPLAY_DIFF;
  await writeText(
    queue,
    path.join(runDir, "02-proposal.json"),
    `${JSON.stringify({ type: "improve", skill, diffFile: "02-proposal.diff", rationale: "复演：补一条索引优先" }, null, 2)}\n`,
  );
  await writeText(queue, path.join(runDir, "02-proposal.diff"), diff);
  const proposal = validateProposal(runDir);
  if (proposal.status !== "ok") fail("propose", `提案校验 ${proposal.status}（${proposal.detail ?? "无详情"}）`);
  else {
    await updateRunStatus(evolutionDir, runId, "proposed", queue, { proposal });
    recordStatus();
    stages.propose = `improve ${skill}（diff ${diff.split("\n").length} 行）`;
  }

  // ── 3. 评审
  if (failures.length === 0) {
    let text: string;
    if (options.fakeReview) text = options.fakeReviewText ?? FAKE_REVIEW_TEXT;
    else {
      const compiled = loadHardRules(options.rulesFile ?? path.join(evolutionDir, "rules", "hard-rules.json"));
      for (const invalid of compiled.invalid) log(`[复演] 硬规则不可用：${invalid}`);
      const rules: readonly CompiledRule[] = compiled.compiled;
      const prompt = buildReviewPrompt({ skillName: skill, skillText: REPLAY_AFTER, diffApplied: true, diff, hardRules: rules });
      const outcome = await runReviewChild({
        prompt,
        cwd: options.cwd,
        ...(options.reviewModel ? { model: options.reviewModel } : {}),
        ...(options.reviewSpawn ? { spawnFn: options.reviewSpawn } : {}),
        ...(options.reviewTimeoutMs ? { timeoutMs: options.reviewTimeoutMs } : {}),
        log,
      });
      if (outcome.status !== "text") {
        fail("review", `评审子进程 ${outcome.status}：${outcome.detail ?? "无详情"}`);
        text = "";
      } else text = outcome.text;
    }
    if (failures.length === 0) {
      const reviewed = postProcessReview(text);
      const verdict = (reviewed.detail && reviewed.status === "invalid") ? `invalid（${reviewed.detail}）` : String(reviewed.verdict ?? "unknown");
      const reviewRecord = {
        status: reviewed.status === "ok" && reviewed.verdict === "pass" ? "reviewed" : "rejected",
        verdict: reviewed.verdict ?? null,
        blocking: reviewed.blocking ?? [],
        notes: reviewed.notes ?? [],
        reviewerModel: options.reviewModel ?? "inherit",
        proposerModel: "inherit",
        sameModel: (options.reviewModel ?? "inherit") === "inherit",
        at: now(),
      };
      await writeText(queue, path.join(runDir, "03-review.json"), `${JSON.stringify(reviewRecord, null, 2)}\n`);
      if (reviewRecord.status !== "reviewed") fail("review", `评审未通过：${verdict}`);
      else {
        await updateRunStatus(evolutionDir, runId, "reviewed", queue, { review: reviewRecord });
        recordStatus();
        stages.review = `verdict=${verdict}（${options.fakeReview ? "假评审" : "真评审"}）`;
      }
    }
  }

  // ── 4. 人批：闸0 快照 → 入队 → approve
  if (failures.length === 0) {
    await saveGate0(evolutionDir, captureGate0(git, options.cwd, now()), queue);
    const tools = createApplyTools({
      evolutionDir,
      cwd: options.cwd,
      queue,
      // 复演不做开关判定：它本来就是人手动触发的全链路
      flags: () => ({ autoReview: true, autoApply: true }),
      now,
      log,
      git,
      loadDiagnostics: () => [],
      runMdCheck: () => ({ code: 0, output: "复演跳过 md-check（临时目录没有仓库脚本）" }),
    });
    await tools.enqueueReady();
    const text = await tools.approve(runId, false);
    const item = readJson<unknown>(path.join(evolutionDir, "queue.json"));
    const queueText = JSON.stringify(item ?? {});
    if (!queueText.includes('"applied"')) fail("approve", `approve 未落实：${text.split("\n")[0] ?? ""}`);
    else stages.approve = `approve ${runId} → applied（${text.split("\n")[0] ?? ""}）`;
  }

  // ── 5. 采纳：05-applied.diff + 技能文件真的变了
  if (failures.length === 0) {
    const applied = fs.existsSync(path.join(runDir, "05-applied.diff"));
    const text = fs.existsSync(skillFile) ? fs.readFileSync(skillFile, "utf8") : "";
    if (!applied) fail("apply", "05-applied.diff 缺失");
    else if (!text.includes("index.json 再读会话原文")) fail("apply", "技能文件未按提案改动");
    else {
      recordStatus();
      stages.apply = `05-applied.diff 已写，技能文件已更新（${text.length} 字节）`;
    }
  }

  // ── 6. 复验：06-verify.json 里每道闸都要 ok
  if (failures.length === 0) {
    const verify = readJson<{ status?: string; gates?: { id: string; ok: boolean }[] }>(path.join(runDir, "06-verify.json"));
    if (!verify) fail("verify", "06-verify.json 缺失");
    else {
      const bad = (verify.gates ?? []).filter((gate) => !gate.ok);
      if (verify.status !== "applied") fail("verify", `06-verify.json status=${verify.status ?? "?"}`);
      else if (bad.length > 0) fail("verify", `闸未过：${bad.map((gate) => gate.id).join("、")}`);
      else stages.verify = `${verify.gates?.length ?? 0} 道闸全 ok`;
    }
  }

  const lines = REPLAY_STAGES.map((stage) => `${STAGE_LABEL[stage]}（${stage}）：${stages[stage]}`);
  return { ok: failures.length === 0, runId, stages, statuses, failures, lines };
}
