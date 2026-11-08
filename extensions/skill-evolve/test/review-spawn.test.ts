/**
 * 督导启动单测：这一层决定「用 execPath 而不是 pi」「带 --experimental-strip-types」
 * 「env 里去掉 SKILL_EVOLVE_CHILD」三件事，接错任何一条都会让评审永远不启动。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { SUPERVISOR_SCRIPT, spawnReviewSupervisor } from "../lib/review-spawn.ts";

function capture(): { calls: { command: string; args: string[]; options: Record<string, unknown> }[]; unrefs: number } {
  return { calls: [], unrefs: 0 };
}

test("督导用 node + --experimental-strip-types 起，参数里带 runDir", () => {
  const seen = capture();
  const pid = spawnReviewSupervisor({
    runDir: "/repo/.pi/evolution/runs/run-1",
    cwd: "/repo",
    env: {},
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
  spawnReviewSupervisor({ runDir: "/r", cwd: "/repo", env: {}, reviewModel: "inherit", spawnFn });
  spawnReviewSupervisor({ runDir: "/r", cwd: "/repo", env: {}, reviewModel: "deepseek/deepseek-v3.2", spawnFn });
  assert.deepEqual(inheritArgs[0], ["--experimental-strip-types", SUPERVISOR_SCRIPT, "/r"]);
  assert.deepEqual(explicitArgs[1], ["--experimental-strip-types", SUPERVISOR_SCRIPT, "/r", "deepseek/deepseek-v3.2"]);
});

test("env 里去掉 SKILL_EVOLVE_CHILD，其他变量照旧带走", () => {
  let env: NodeJS.ProcessEnv = {};
  spawnReviewSupervisor({
    runDir: "/r",
    cwd: "/repo",
    env: { SKILL_EVOLVE_CHILD: "1", PATH: "/usr/bin" },
    spawnFn: (_command, _args, options) => {
      env = options.env as NodeJS.ProcessEnv;
      return { pid: 1 };
    },
  });
  assert.equal(env.SKILL_EVOLVE_CHILD, undefined);
  assert.equal(env.PATH, "/usr/bin");
});

test("起不来只记日志返回 null，不抛", () => {
  const logs: string[] = [];
  const pid = spawnReviewSupervisor({
    runDir: "/r",
    cwd: "/repo",
    env: {},
    log: (msg) => logs.push(msg),
    spawnFn: () => {
      throw new Error("EMFILE");
    },
  });
  assert.equal(pid, null);
  assert.match(logs.join("\n"), /启动失败/);
});
