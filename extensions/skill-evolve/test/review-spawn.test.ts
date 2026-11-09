/**
 * 督导启动单测：这一层决定「用 execPath 而不是 pi」「带 --experimental-strip-types」
 * 「env 里去掉 SKILL_EVOLVE_CHILD」三件事，接错任何一条都会让评审永远不启动。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { SUPERVISOR_SCRIPT, spawnReviewSupervisor } from "../lib/review-spawn.ts";

/** 测试里不搬家：直接返回包内入口（搬家用 supervisor-runtime.test.ts 单独覆盖） */
const direct = ({ scriptPath }: { scriptPath: string }): string => scriptPath;

function capture(): { calls: { command: string; args: string[]; options: Record<string, unknown> }[]; unrefs: number } {
  return { calls: [], unrefs: 0 };
}

test("督导用 node + --experimental-strip-types 起，参数里带 runDir", () => {
  const seen = capture();
  const pid = spawnReviewSupervisor({
    runDir: "/repo/.pi/evolution/runs/run-1",
    cwd: "/repo",
    env: {},
    autoReview: true,
    resolveScript: direct,
    spawnFn: (command, args, options) => {
      seen.calls.push({ command, args, options });
      return {
        pid: 4321,
        unref: () => {
          seen.unrefs += 1;
        },
      };
    },
  });
  assert.equal(pid, 4321);
  assert.equal(seen.calls[0].command, process.execPath);
  assert.deepEqual(seen.calls[0].args, ["--experimental-strip-types", SUPERVISOR_SCRIPT, "/repo/.pi/evolution/runs/run-1"]);
  assert.equal(seen.calls[0].options.detached, true);
  assert.equal(seen.calls[0].options.stdio, "ignore");
  assert.equal(seen.unrefs, 1, "必须 unref，否则主进程退出被拖住");
  assert.equal(path.basename(SUPERVISOR_SCRIPT), "review-supervisor.ts");
});

test("inherit 不追加 --model，显式模型追加在 runDir 之后", () => {
  const inheritArgs: string[][] = [];
  const explicitArgs: string[][] = [];
  const spawnFn = (command: string, args: string[], options: Record<string, unknown>) => {
    inheritArgs.push(args);
    explicitArgs.push(args);
    return { pid: 1 };
  };
  spawnReviewSupervisor({ runDir: "/r", cwd: "/repo", env: {}, autoReview: true, reviewModel: "inherit", spawnFn, resolveScript: direct });
  spawnReviewSupervisor({ runDir: "/r", cwd: "/repo", env: {}, autoReview: true, reviewModel: "deepseek/deepseek-v3.2", spawnFn, resolveScript: direct });
  assert.deepEqual(inheritArgs[0], ["--experimental-strip-types", SUPERVISOR_SCRIPT, "/r"]);
  assert.deepEqual(explicitArgs[1], ["--experimental-strip-types", SUPERVISOR_SCRIPT, "/r", "deepseek/deepseek-v3.2"]);
});

test("env 里去掉 SKILL_EVOLVE_CHILD，其他变量照旧带走", () => {
  let env: NodeJS.ProcessEnv = {};
  spawnReviewSupervisor({
    runDir: "/r",
    cwd: "/repo",
    env: { SKILL_EVOLVE_CHILD: "1", PATH: "/usr/bin" },
    autoReview: true,
    resolveScript: direct,
    spawnFn: (_command, _args, options) => {
      env = options.env as NodeJS.ProcessEnv;
      return { pid: 1 };
    },
  });
  assert.equal(env.SKILL_EVOLVE_CHILD, undefined);
  assert.equal(env.PATH, "/usr/bin");
});

test("督导入口解析拿到 evolutionDir（node_modules 里要搬到工作区 runtime 下再跑）", () => {
  const seen: { evolutionDir?: string; scriptPath?: string }[] = [];
  spawnReviewSupervisor({
    runDir: "/repo/.pi/evolution/runs/run-9",
    cwd: "/repo",
    env: {},
    autoReview: true,
    resolveScript: (options) => {
      seen.push(options);
      return "/tmp/copied/review-supervisor.ts";
    },
    spawnFn: (_c, args) => {
      assert.equal(args[1], "/tmp/copied/review-supervisor.ts", "spawn 用的必须是解析后的路径");
      return { pid: 7 };
    },
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.evolutionDir, "/repo/.pi/evolution");
  assert.equal(seen[0]!.scriptPath, SUPERVISOR_SCRIPT);
});

test("自动评审关着：一个进程都不起，只留一句「停在 proposed」日志", () => {
  const logs: string[] = [];
  let spawned = 0;
  const pid = spawnReviewSupervisor({
    runDir: "/repo/.pi/evolution/runs/run-7",
    cwd: "/repo",
    env: {},
    autoReview: false,
    resolveScript: direct,
    log: (msg) => logs.push(msg),
    spawnFn: () => {
      spawned += 1;
      return { pid: 1 };
    },
  });
  assert.equal(pid, null);
  assert.equal(spawned, 0, "评审关着就不许起子进程（每份子进程都是 token）");
  assert.equal(logs.length, 1);
  assert.match(logs[0]!, /自动评审已关，run run-7 停在 proposed 待人工 \/skill-evolve approve/);
});

test("起不来只记日志返回 null，不抛", () => {
  const logs: string[] = [];
  const pid = spawnReviewSupervisor({
    runDir: "/r",
    cwd: "/repo",
    env: {},
    autoReview: true,
    resolveScript: direct,
    log: (msg) => logs.push(msg),
    spawnFn: () => {
      throw new Error("EMFILE");
    },
  });
  assert.equal(pid, null);
  assert.match(logs.join("\n"), /启动失败/);
});
