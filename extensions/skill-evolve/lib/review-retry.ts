/**
 * 「重试评审」：督导进程可能中途崩掉（例如 0.1.27–0.1.33 的 archiveAttempt ENOENT），
 * 留下一个已经写出提案、却永远停在 proposed 的 run。面板与命令都从这里补一刀，
 * 复用同一条 spawnReviewSupervisor，不另写一套评审逻辑。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnReviewSupervisor, type SupervisorSpawn } from "./review-spawn.ts";

export interface ReviewRetryDeps {
  evolutionDir: string;
  cwd: string;
  /** "inherit" / provider/model */
  reviewModel: string;
  maxRewrites: number;
  autoReview: boolean;
  spawnFn?: SupervisorSpawn;
  env?: NodeJS.ProcessEnv;
  log?: (msg: string) => void;
}

/** 返回给人看的一句话；参数不对就不起进程（避免空跑一条督导去抢锁） */
export function retryReview(deps: ReviewRetryDeps, runId: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(runId)) return `runId 不合法：${runId}`;
  const runDir = path.join(deps.evolutionDir, "runs", runId);
  if (!fs.existsSync(runDir)) return `找不到这个 run：${runId}`;
  if (!fs.existsSync(path.join(runDir, "02-proposal.json"))) {
    return `${runId} 还没有提案（02-proposal.json），重试评审没有意义 —— 用「重跑」重新派发`;
  }
  if (!deps.autoReview) return "自动评审关着：先在面板打开「自动评审」，或改用 /skill-evolve review on";
  const pid = spawnReviewSupervisor({
    runDir,
    cwd: deps.cwd,
    autoReview: deps.autoReview,
    reviewModel: deps.reviewModel,
    maxRewrites: deps.maxRewrites,
    ...(deps.spawnFn ? { spawnFn: deps.spawnFn } : {}),
    ...(deps.env ? { env: deps.env } : {}),
    ...(deps.log ? { log: deps.log } : {}),
    sessionId: runId,
  });
  if (pid === null) return `没能起督导（可能已有会话在复盘，或运行目录准备失败）：看 .pi/evolution/logs/extension.log`;
  return `已重试评审 ${runId}（督导 pid ${pid}）：等它写完 03-review.json，面板 30 秒内会更新`;
}
