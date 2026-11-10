/**
 * 跑一次评审子进程：`pi -p --no-session -ns <prompt>`，带超时与「invalid 重评一次」。
 *
 * 这里是评审流水线唯一会起外部进程的地方，评审督导（review-supervisor）与必红自检
 * （selftest）共用，避免两处各写一套超时/重试导致行为不一致。
 * spawnFn / now / sleep 全部可注入：单测不真起 pi、不真等 300 秒。
 */
import * as fs from "node:fs";
import { spawn as nodeSpawn } from "node:child_process";
import { resolvePiBin } from "./spawn-plan.ts";
import { postProcessReview, type ReviewResult } from "./review-post.ts";

export interface ReviewChild {
  pid?: number;
  stdout?: { on(event: "data", cb: (chunk: unknown) => void): void } | null;
  once(event: "exit" | "error", cb: (arg?: unknown) => void): void;
  unref?: () => void;
  kill?: (signal?: NodeJS.Signals) => void;
}

/** 评审 Agent 会话留档文件名：与提案 Agent 的 child.log 并列，详情页从这里点进去看 */
export const AGENT_REVIEW_LOG = "agent-review.log";

export type ReviewSpawn = (command: string, args: string[], options: Record<string, unknown>) => ReviewChild;

export interface ReviewChildOptions {
  prompt: string;
  cwd: string;
  /** "inherit" 或空 → 不传 --model，让子进程用默认模型 */
  model?: string;
  env?: NodeJS.ProcessEnv;
  spawnFn?: ReviewSpawn;
  timeoutMs?: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (msg: string) => void;
}

export interface ReviewChildOutcome {
  status: "text" | "timeout" | "spawn-error";
  text: string;
  ms: number;
  detail?: string;
}

export const DEFAULT_REVIEW_TIMEOUT_MS = 300_000;
const DEFAULT_POLL_MS = 250;

export function reviewArgs(prompt: string, model?: string): string[] {
  const args = ["-p", "--no-session", "-ns", prompt];
  if (model && model !== "inherit") args.push("--model", model);
  return args;
}

export async function runReviewChild(options: ReviewChildOptions): Promise<ReviewChildOutcome> {
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const spawnFn = options.spawnFn ?? (nodeSpawn as unknown as ReviewSpawn);
  const timeoutMs = options.timeoutMs ?? DEFAULT_REVIEW_TIMEOUT_MS;
  const pollMs = Math.max(1, options.pollMs ?? DEFAULT_POLL_MS);
  const started = now();
  let text = "";
  let settled = false;
  let failure: string | undefined;
  const child = spawnFn(resolvePiBin(env), reviewArgs(options.prompt, options.model), {
    cwd: options.cwd,
    detached: true,
    stdio: ["ignore", "pipe", "ignore"],
    // 评审进程也是子代理进程：带上标记，避免它自己被扩展的采集钩子挂上去
    env: { ...env, SKILL_EVOLVE_CHILD: "1" },
  });
  child.stdout?.on("data", (chunk) => {
    text += String(chunk);
  });
  child.once("exit", () => {
    settled = true;
  });
  child.once("error", (error) => {
    failure = (error as Error | undefined)?.message ?? "spawn 失败";
    settled = true;
  });
  const deadline = started + timeoutMs;
  while (!settled && now() < deadline) await sleep(pollMs);
  const ms = now() - started;
  if (!settled) {
    try {
      child.kill?.("SIGKILL");
    } catch {
      // 已经退出或权限不足：超时结论不变，不必再喊
    }
    options.log?.(`[skill-evolve] 评审子进程超时（${timeoutMs}ms），已放弃`);
    return { status: "timeout", text, ms, detail: `review-timeout: 超过 ${timeoutMs}ms` };
  }
  if (failure) return { status: "spawn-error", text, ms, detail: `spawn-error: ${failure}` };
  return { status: "text", text, ms };
}

export interface ReviewWithRetryOptions extends ReviewChildOptions {
  /** 机械复验：返回非空字符串表示候选文件不合法（frontmatter 坏） */
  recheck?: () => string | null;
  /** 评审 Agent 原始输出的留档路径（每轮追加一段）：给人从详情页点进去看它到底说了什么 */
  rawLogPath?: string;
}

/** 追加一轮评审输出：两轮重试都留，别只留最后一轮（无效那轮才是排查线索） */
function appendRawLog(rawLogPath: string | undefined, round: number, outcome: ReviewChildOutcome): void {
  if (!rawLogPath || outcome.text.length === 0) return;
  try {
    const head = `\n### 第 ${round} 次尝试（${outcome.status}${outcome.detail ? ` · ${outcome.detail}` : ""} · ${outcome.ms}ms）\n`;
    fs.appendFileSync(rawLogPath, `${head}${outcome.text}\n`, "utf8");
  } catch {
    // 留档失败不影响评审结论：这只是给人看的旁证
  }
}

export interface ReviewWithRetryOutcome {
  result: ReviewResult;
  attempts: number;
  ms: number;
  /** 每次尝试的结论摘要，写进 03-review.md 便于人工复盘 */
  attemptsLog: string[];
}

/**
 * 12.3 后处理 + 重试规则：结构不合格（invalid）重评一次，仍不合格就是 review_failed；
 * 超时与 spawn 失败不重试（再来一次只是再赔 300 秒）。
 */
export async function reviewWithRetry(options: ReviewWithRetryOptions): Promise<ReviewWithRetryOutcome> {
  const started = (options.now ?? Date.now)();
  const attemptsLog: string[] = [];
  let last: ReviewResult = { status: "invalid", blocking: [], detail: "not-run" };
  let attempts = 0;
  for (let round = 1; round <= 2; round += 1) {
    attempts = round;
    const outcome = await runReviewChild(options);
    appendRawLog(options.rawLogPath, round, outcome);
    if (outcome.status !== "text") {
      last = { status: "invalid", blocking: [], detail: outcome.detail ?? outcome.status };
      attemptsLog.push(`第 ${round} 次：${last.detail}`);
      break;
    }
    last = postProcessReview(outcome.text, { ...(options.recheck ? { recheck: options.recheck } : {}) });
    attemptsLog.push(`第 ${round} 次：${last.status}${last.verdict ? `/${last.verdict}` : ""}${last.detail ? `（${last.detail}）` : ""}`);
    if (last.status !== "invalid") break;
  }
  return { result: last, attempts, ms: (options.now ?? Date.now)() - started, attemptsLog };
}
