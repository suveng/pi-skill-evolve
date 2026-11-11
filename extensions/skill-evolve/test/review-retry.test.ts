/**
 * 「重试评审」：督导崩掉后 run 停在 proposed 的补救路径。
 * 只测「什么情况拒绝」与「什么情况真的起进程」，评审逻辑本身在 review-supervisor.test.ts。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { retryReview } from "../lib/review-retry.ts";

function workspace(runId: string, files: readonly string[]): { evolutionDir: string; cwd: string } {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "skill-evolve-retry-"));
  const evolutionDir = path.join(cwd, ".pi", "evolution");
  const runDir = path.join(evolutionDir, "runs", runId);
  fs.mkdirSync(runDir, { recursive: true });
  for (const name of files) fs.writeFileSync(path.join(runDir, name), "{}", "utf8");
  return { evolutionDir, cwd };
}

function deps(cwd: string, evolutionDir: string, over: Record<string, unknown> = {}) {
  return {
    evolutionDir,
    cwd,
    reviewModel: "inherit",
    maxRewrites: 3,
    autoReview: true,
    log: () => undefined,
    ...over,
  } as Parameters<typeof retryReview>[0];
}

test("runId 非法 / run 不存在 / 没有提案：一律不起进程，各给一句人话", () => {
  const { cwd, evolutionDir } = workspace("run-ok", ["02-proposal.json"]);
  assert.match(retryReview(deps(cwd, evolutionDir), "../etc/passwd"), /runId 不合法/);
  assert.match(retryReview(deps(cwd, evolutionDir), "run-404"), /找不到这个 run/);

  const bare = workspace("run-bare", ["run.json"]);
  assert.match(retryReview(deps(bare.cwd, bare.evolutionDir), "run-bare"), /还没有提案/);
});

test("自动评审关着：不硬起督导，提示先把开关打开", () => {
  const { cwd, evolutionDir } = workspace("run-ok", ["02-proposal.json"]);
  assert.match(retryReview(deps(cwd, evolutionDir, { autoReview: false }), "run-ok"), /自动评审关着/);
});

test("有提案 + 开关打开：起一次督导并把 pid 说给用户", () => {
  const { cwd, evolutionDir } = workspace("run-ok", ["02-proposal.json"]);
  const calls: { args: string[] }[] = [];
  const message = retryReview(
    deps(cwd, evolutionDir, {
      spawnFn: (_command: string, args: string[]) => {
        calls.push({ args });
        return { pid: 4242, unref: () => undefined, on: () => undefined };
      },
    }),
    "run-ok",
  );
  assert.equal(calls.length, 1, "回调用正好起一次督导");
  assert.equal(calls[0]!.args.at(-1), path.join(evolutionDir, "runs", "run-ok"), "runDir 原样交给督导");
  assert.match(message, /已重试评审 run-ok（督导 pid 4242）/);
});
