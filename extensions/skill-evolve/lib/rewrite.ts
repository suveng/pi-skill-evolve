/**
 * 提案重写：评审没通过（verdict=reject 或 revise）时，让提案 Agent 按评审意见重写，最多 `MAX_REWRITES` 次。
 *
 * 为什么要有这一步（2026-11-11 用户原话）：「分析完成之后，应该立马去复盘。复盘不通过的时候，
 * 应该有 3 次重写这个提案的机会。」—— 原来的行为是评审一次不通过就直接判 rejected 终态，
 * 提案 Agent 的第一次措辞就是最终措辞，评审意见写了也没人接。
 *
 * 三条纪律：
 * 1. **每一版都留档**：重写前把上一版 `02-proposal.*` 与 `03-review.*` 复制到 `attempts/attempt-0N/`，
 *    最终定论时能看到「第一版为什么被否、第二版改了什么」，而不是只剩最后一版。
 * 2. **重写只按评审意见改**：prompt 里给 blocking 清单与上一版提案，禁止顺手改别的、禁止自造新结论。
 * 3. **重写也要能在没有 pi 的环境里测**：spawnFn/now/sleep 全部可注入，单测不真起进程、不真等 5 分钟。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn as nodeSpawn } from "node:child_process";
import { agentSessionFlags, resolvePiBin } from "./spawn-plan.ts";
import type { ReviewSpawn } from "./review-run.ts";

/** 默认给 3 次重写机会（= 最多 4 次评审：首发一次 + 每次重写各一次） */
export const MAX_REWRITES = 3;

/** 单次重写上限：与复盘 Agent 同量级（重写要读 findings、评审意见、原提案，再改写） */
export const REWRITE_TIMEOUT_MS = 600_000;

/** 重写产物落盘轮询间隔 */
export const REWRITE_POLL_MS = 2000;

export const PROPOSAL_JSON = "02-proposal.json";
export const REVIEW_JSON = "03-review.json";

/** 第 N 次重写对应的留档目录名（attempt-01 起算，与「首发」区分） */
export function attemptDirName(attempt: number): string {
  return `attempt-${String(attempt).padStart(2, "0")}`;
}

/** 第 N 次重写的 Agent 输出文件名（与提案 Agent 的 child.log、评审 Agent 的 agent-review.log 并列） */
export function rewriteLogName(attempt: number): string {
  return `agent-rewrite-${attempt}.log`;
}

export interface RewritePromptInput {
  runDir: string;
  skill: string;
  attempt: number;
  maxRewrites: number;
  /** 03-review.json 的 blocking 数组（原样给，别改写成「一些意见」） */
  blocking: readonly unknown[];
  /** 上一版提案原文，让 Agent 在原文上改，而不是从零重写 */
  proposalJson: string | undefined;
  proposalDiff: string | undefined;
  candidateText: string | undefined;
}

/**
 * 重写 prompt：只给「上一版 + 评审意见 + 硬约束」，不给 Findings 的推理过程 ——
 * 理由与 review-prompt 同源：让 Agent 按意见改，不让它重新论证自己。
 */
export function buildRewritePrompt(input: RewritePromptInput): string {
  const { runDir, skill, attempt, maxRewrites } = input;
  const lines: string[] = [];
  lines.push("# 技能进化 · 提案重写任务");
  lines.push("");
  lines.push(
    `上一版提案被评审否了。这是第 ${attempt}/${maxRewrites} 次重写：只按下面的评审意见改，改完仍然只写文件、不改任何技能文件。`,
  );
  lines.push("");
  lines.push("## 一、你要改的东西");
  lines.push("");
  lines.push(`- run 目录：\`${runDir}\``);
  lines.push(`- 目标技能：\`${skill}\``);
  lines.push("- 产物与格式**完全不变**：`02-proposal.json` + `02-proposal.diff`（新建技能用 `candidate/<名>/SKILL.md`）");
  lines.push("- diff 仍然是 unified diff、文件头只能指向 `.pi/skills/...`、增删合计不超过 200 行");
  lines.push("");
  lines.push("## 二、评审意见（每条都要有对应的改动或明确回应）");
  lines.push("");
  if (input.blocking.length === 0) {
    lines.push("- （评审没给 blocking 条目，但结论不是 pass：说明整体不合格，按下面的上一版自行收紧，改不出更小的改动就保持原样并说明理由）");
  } else {
    for (const [index, item] of input.blocking.entries()) {
      lines.push(`${index + 1}. ${typeof item === "string" ? item : JSON.stringify(item)}`);
    }
  }
  lines.push("");
  lines.push("## 三、上一版提案（在它基础上改）");
  lines.push("");
  lines.push("```json");
  lines.push(input.proposalJson?.trim() || "（上一版没有 02-proposal.json，只有 diff / candidate）");
  lines.push("```");
  if (input.proposalDiff && input.proposalDiff.trim().length > 0) {
    lines.push("");
    lines.push("```diff");
    lines.push(input.proposalDiff.trim());
    lines.push("```");
  }
  if (input.candidateText && input.candidateText.trim().length > 0) {
    lines.push("");
    lines.push("上一版候选全文（`candidate/<名>/SKILL.md`）：");
    lines.push("");
    lines.push("```markdown");
    lines.push(input.candidateText.trim());
    lines.push("```");
  }
  lines.push("");
  lines.push("## 四、红线");
  lines.push("");
  lines.push("1. **不许改 `.pi/skills/`**、不许改 `.pi/settings.json`、不许改 `.pi/evolution/config.json`、不许动别的 run 目录。");
  lines.push("2. 不许把评审意见「回应」成一句说明就算完 —— 意见指哪里就改哪里；确实不该改的，缩小改动范围并在 `02-proposal.json` 的 `notes` 里写清为什么。");
  lines.push("3. 改完自己复核一遍：diff 能应用到当前技能文件、frontmatter 合法、路径都在 `.pi/skills/` 下。");
  lines.push("4. 重写完成把 `run.json` 的 `status` 写回 `proposed`，并在 `artifacts` 里更新提案路径。");
  lines.push("");
  return lines.join("\n");
}

export interface RewriteSpawnDeps {
  cwd: string;
  /** "inherit" 或不传 → 用子进程默认模型 */
  model?: string;
  env?: NodeJS.ProcessEnv;
  spawnFn?: ReviewSpawn;
  timeoutMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (msg: string) => void;
}

export interface RewriteOutcome {
  ok: boolean;
  ms: number;
  detail?: string;
}

/**
 * 写重写日志：日志写不进去（目录不存在 / 磁盘满）不能把整条流水线带走 ——
 * 单测用虚拟文件系统时这里必然失败，生产上也不该因为一句日志就丢掉一次评审。
 */
function appendLog(file: string, text: string): void {
  try {
    fs.appendFileSync(file, text, "utf8");
  } catch {
    // 忽略：日志只是旁证，不是产物
  }
}

/** 跑一次重写子进程：输出落 `agent-rewrite-<n>.log`，超时先 SIGTERM 再 SIGKILL */
export async function runRewritePass(prompt: string, runDir: string, attempt: number, deps: RewriteSpawnDeps): Promise<RewriteOutcome> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const spawnFn = deps.spawnFn ?? (nodeSpawn as unknown as ReviewSpawn);
  const logFile = path.join(runDir, rewriteLogName(attempt));
  const started = now();
  const args = ["-p", ...agentSessionFlags(runDir, `rewrite-${attempt}`), "-ns", prompt];
  if (deps.model && deps.model !== "inherit") args.push("--model", deps.model);

  let stdout = "";
  let stderr = "";
  const child = spawnFn(resolvePiBin(deps.env), args, {
    cwd: deps.cwd,
    env: deps.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk) => {
    stdout += String(chunk);
  });
  const sink = (chunk: unknown): void => {
    stderr += String(chunk);
  };
  // 重写失败要能复查原因：stderr 也收进日志，而不是只留 stdout
  (child as unknown as { stderr?: { on(event: "data", cb: (chunk: unknown) => void): void } }).stderr?.on("data", sink);

  const exited = new Promise<number | null>((resolve) => {
    child.once("exit", (code) => resolve(typeof code === "number" ? code : null));
    child.once("error", () => resolve(-1));
  });
  const timeoutMs = deps.timeoutMs ?? REWRITE_TIMEOUT_MS;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  const raced = await Promise.race([exited, timeout]);
  if (timer) clearTimeout(timer);
  if (raced === "timeout") {
    child.kill?.("SIGTERM");
    await sleep(2000);
    child.kill?.("SIGKILL");
    appendLog(logFile, `${stdout}\n[重写超时：${timeoutMs}ms 未完成，已终止]\n${stderr}`);
    deps.log?.(`[skill-evolve] 第 ${attempt} 次重写超时（${timeoutMs}ms）`);
    return { ok: false, ms: now() - started, detail: `rewrite-timeout:${timeoutMs}ms` };
  }
  appendLog(logFile, `${stdout}\n${stderr}`);
  if (raced !== 0) {
    deps.log?.(`[skill-evolve] 第 ${attempt} 次重写子进程异常退出（exit=${raced ?? "null"}）`);
    return { ok: false, ms: now() - started, detail: `rewrite-exit:${raced ?? "null"}` };
  }
  return { ok: true, ms: now() - started };
}

/**
 * 等重写后的提案落盘：内容与上一版不同才算数（Agent 可能什么都没写就退出，
 * 光看文件存在会拿旧提案再评一遍，白烧一次评审）。
 */
export async function waitForNewProposal(
  file: string,
  previous: string | undefined,
  deps: { read: (file: string) => string | undefined; now?: () => number; sleep?: (ms: number) => Promise<void>; timeoutMs?: number; pollMs?: number },
): Promise<string | undefined> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + (deps.timeoutMs ?? 30_000);
  while (now() < deadline) {
    const text = deps.read(file);
    if (text !== undefined && text !== previous) return text;
    await sleep(deps.pollMs ?? REWRITE_POLL_MS);
  }
  const last = deps.read(file);
  return last !== undefined && last !== previous ? last : undefined;
}

/**
 * 把第 N 版的提案与评审结论整份复制到 `attempts/attempt-0N/`，重写不动原件。
 * 传了 read/write 就走它们（单测的虚拟文件系统），否则直接读盘写盘。
 */
export function archiveAttempt(
  runDir: string,
  attempt: number,
  io?: {
    read: (file: string) => string | undefined;
    write: (file: string, text: string) => void;
    /** 写临时文件+改名的实现不会替你建目录：少了它会 ENOENT，整条督导链当场崩 */
    mkdir?: (dir: string) => void;
  },
): void {
  const to = path.join(runDir, "attempts", attemptDirName(attempt));
  if (io) {
    io.mkdir?.(to);
    for (const name of [PROPOSAL_JSON, "02-proposal.diff", REVIEW_JSON, "03-review.md"]) {
      const text = io.read(path.join(runDir, name));
      if (text === undefined) continue;
      io.write(path.join(to, name), text);
    }
    return;
  }
  fs.mkdirSync(to, { recursive: true });
  const files = [PROPOSAL_JSON, "02-proposal.diff", REVIEW_JSON, "03-review.md"];
  for (const name of files) {
    const src = path.join(runDir, name);
    if (!fs.existsSync(src)) continue;
    fs.copyFileSync(src, path.join(to, name));
  }
  // 新建技能的候选全文也要留：不然只看 diff 无法复核 frontmatter
  const candidateRoot = path.join(runDir, "candidate");
  if (fs.existsSync(candidateRoot)) {
    fs.cpSync(candidateRoot, path.join(to, "candidate"), { recursive: true });
  }
}
