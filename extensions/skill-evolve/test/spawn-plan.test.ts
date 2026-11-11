/**
 * 复盘子进程的环境变量（2026-11-11 实测：父进程带着 PI_FEISHU_DAEMON=1，子 pi 加载桥接扩展后
 * 读到别的 daemon 已持有网关锁就 process.exit，整个复盘被判「子进程已退出」）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { childEnvOf, stripDaemonFlags } from "../lib/spawn-plan.ts";

test("childEnvOf：摘掉抢守护进程的开关，其它变量原样保留", () => {
  const env = childEnvOf({ PATH: "/bin", PI_FEISHU_DAEMON: "1", FEISHU_APP_ID: "cli_x" });
  assert.equal(env.PI_FEISHU_DAEMON, undefined);
  assert.equal(env.SKILL_EVOLVE_CHILD, "1");
  assert.equal(env.FEISHU_APP_ID, "cli_x");
  assert.equal(env.PATH, "/bin");
});

test("stripDaemonFlags：只摘开关，不写 SKILL_EVOLVE_CHILD（督导要把它删掉，评审 Agent 不能被当成复盘进程）", () => {
  const env = stripDaemonFlags({ PATH: "/bin", PI_FEISHU_DAEMON: "1", SKILL_EVOLVE_CHILD: "1" });
  assert.equal(env.PI_FEISHU_DAEMON, undefined);
  assert.equal(env.SKILL_EVOLVE_CHILD, "1");
});
