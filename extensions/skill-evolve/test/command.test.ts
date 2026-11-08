/**
 * /skill-evolve 子命令路由单测：只验证「参数 → 展示文本」，用假 Evolution 对象隔离 lib/evolution。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { matchSubcommand, parseWebPort, runCommand } from "../lib/command.ts";
import type { Evolution } from "../lib/evolution.ts";

const TARGET = { sessionId: "sess-1", sessionFile: "/tmp/session.jsonl" };

function fakeEvolution(calls: string[]): Evolution {
  const stub = {
    reportText: (days: number) => {
      calls.push(`report:${days}`);
      return `报告 ${days} 天`;
    },
    statusText: () => {
      calls.push("status");
      return "状态文本";
    },
    setEnabled: (enabled: boolean) => {
      calls.push(`enabled:${enabled}`);
      return `总开关：${enabled ? "开" : "关"}`;
    },
    setFlag: (field: string, value: boolean) => {
      calls.push(`flag:${field}=${value}`);
      return `开关：${field}=${value}`;
    },
    runNow: (target: { sessionId: string; sessionFile?: string }) => {
      calls.push(`run:${target.sessionId}`);
      return `已派生复盘：${target.sessionId}`;
    },
    acceptBaseline: (mode: "accept" | "reset") => {
      calls.push(`baseline:${mode}`);
      return `基线：${mode}`;
    },
    flush: async () => {},
    model: {
      config: () => ({ propose: "inherit", review: "inherit" }),
      reviewModel: () => "inherit",
      setModel: async (kind: string, spec: string) => {
        calls.push(`model:${kind}=${spec}`);
        return `已设 ${kind}=${spec}`;
      },
      selftestText: async () => {
        calls.push("selftest");
        return "自检：通过";
      },
      selftestFailed: () => false,
      lastSelftest: () => undefined,
    },
    apply: {
      sessionStart: () => {},
      settle: () => {},
      approve: async (runId: string, prune: boolean) => {
        calls.push(`approve:${runId}${prune ? ":prune" : ""}`);
        return `采纳 ${runId}`;
      },
      queueText: () => {
        calls.push("queue");
        return "队列文本";
      },
      autoApplyPending: async () => 0,
      enqueueReady: async () => 0,
    },
    observe: {
      refresh: () => ({ reviewing: 0, staleCount: 0, pendingApprovals: 0, lastAppliedAt: null, rollbackRate: 0, appliedSamples: 0 }),
      noteDispatched: () => {},
      weekReportText: async () => {
        calls.push("week");
        return "周报文本";
      },
    },
  };
  return stub as unknown as Evolution;
}

test("补全：空前缀给全量，命中前缀只给命中项，乱前缀也给全量", () => {
  assert.deepEqual(
    matchSubcommand("").map((item) => item.value),
    ["status", "report", "run", "baseline", "selftest", "approve", "queue", "web", "config", "collect", "review", "on", "off"],
  );
  assert.deepEqual(
    matchSubcommand("re").map((item) => item.value),
    ["report", "review"],
  );
  assert.deepEqual(
    matchSubcommand("co").map((item) => item.value),
    ["config", "collect"],
  );
  assert.deepEqual(
    matchSubcommand("qu").map((item) => item.value),
    ["queue"],
  );
  assert.deepEqual(
    matchSubcommand("ap").map((item) => item.value),
    ["approve"],
  );
  assert.deepEqual(
    matchSubcommand("o").map((item) => item.value),
    ["on", "off"],
  );
  assert.deepEqual(
    matchSubcommand("b").map((item) => item.value),
    ["baseline"],
  );
  assert.deepEqual(
    matchSubcommand("se").map((item) => item.value),
    ["selftest"],
  );
  assert.deepEqual(
    matchSubcommand("zzz").map((item) => item.value),
    ["status", "report", "run", "baseline", "selftest", "approve", "queue", "web", "config", "collect", "review", "on", "off"],
  );
  assert.deepEqual(
    matchSubcommand("w").map((item) => item.value),
    ["web"],
  );
});

test("空参数默认走 status", async () => {
  const calls: string[] = [];
  assert.equal(await runCommand("", fakeEvolution(calls), TARGET), "状态文本");
  assert.deepEqual(calls, ["status"]);
});

test("report 带天数用天数，非法天数回落 7 天", async () => {
  const calls: string[] = [];
  const evo = fakeEvolution(calls);
  assert.equal(await runCommand("report 3", evo, TARGET), "报告 3 天");
  assert.equal(await runCommand("report abc", evo, TARGET), "报告 7 天");
  assert.equal(await runCommand("report 0", evo, TARGET), "报告 7 天");
  assert.equal(await runCommand("report", evo, TARGET), "报告 7 天");
  assert.deepEqual(calls, ["report:3", "report:7", "report:7", "report:7"]);
});

test("on / off 透传布尔", async () => {
  const calls: string[] = [];
  const evo = fakeEvolution(calls);
  assert.equal(await runCommand("on", evo, TARGET), "总开关：开");
  assert.equal(await runCommand("off", evo, TARGET), "总开关：关");
  assert.deepEqual(calls, ["enabled:true", "enabled:false"]);
});

test("run 子命令把手机会话透传给 runNow", async () => {
  const calls: string[] = [];
  assert.equal(await runCommand("run", fakeEvolution(calls), TARGET), "已派生复盘：sess-1");
  assert.deepEqual(calls, ["run:sess-1"]);
});

test("baseline 子命令：默认接受，--reset 清空", async () => {
  const calls: string[] = [];
  const evo = fakeEvolution(calls);
  assert.equal(await runCommand("baseline", evo, TARGET), "基线：accept");
  assert.equal(await runCommand("baseline --reset", evo, TARGET), "基线：reset");
  assert.deepEqual(calls, ["baseline:accept", "baseline:reset"]);
});

test("selftest 走 model.selftestText", async () => {
  const calls: string[] = [];
  assert.equal(await runCommand("selftest", fakeEvolution(calls), TARGET), "自检：通过");
  assert.deepEqual(calls, ["selftest"]);
});

test("非 TUI 的 config 子命令打印当前值而不改配置", async () => {
  const calls: string[] = [];
  const text = await runCommand("config", fakeEvolution(calls), TARGET);
  assert.match(text, /无法交互选择/);
  assert.deepEqual(calls, []);
});

test("queue 子命令列采纳队列", async () => {
  const calls: string[] = [];
  assert.equal(await runCommand("queue", fakeEvolution(calls), TARGET), "队列文本");
  assert.deepEqual(calls, ["queue"]);
});

test("approve 传 runId；带 --prune 时标记 prune", async () => {
  const calls: string[] = [];
  const evo = fakeEvolution(calls);
  assert.equal(await runCommand("approve run-abc", evo, TARGET), "采纳 run-abc");
  assert.equal(await runCommand("approve run-abc --prune", evo, TARGET), "采纳 run-abc");
  assert.deepEqual(calls, ["approve:run-abc", "approve:run-abc:prune"]);
});

test("approve 缺 runId 时仍走 approve（由实现给用法串）", async () => {
  const calls: string[] = [];
  await runCommand("approve", fakeEvolution(calls), TARGET);
  assert.deepEqual(calls, ["approve:"]);
});

test("未知子命令返回用法串且不碰 Evolution", async () => {
  const calls: string[] = [];
  const text = await runCommand("propose", fakeEvolution(calls), TARGET);
  assert.match(text, /未知子命令：propose/);
  assert.match(text, /status\|report\|run\|baseline\|selftest\|approve\|queue\|web\|config\|collect\|review\|on\|off/);
  assert.deepEqual(calls, []);
});

test("collect on|off：只动采集（telemetry），不碰复盘", async () => {
  const calls: string[] = [];
  const evo = fakeEvolution(calls);
  assert.equal(await runCommand("collect on", evo, TARGET), "开关：telemetry=true");
  assert.equal(await runCommand("collect off", evo, TARGET), "开关：telemetry=false");
  assert.deepEqual(calls, ["flag:telemetry=true", "flag:telemetry=false"]);
});

test("review on|off：只动复盘（enabled），不碰采集", async () => {
  const calls: string[] = [];
  const evo = fakeEvolution(calls);
  assert.equal(await runCommand("review on", evo, TARGET), "开关：enabled=true");
  assert.equal(await runCommand("review off", evo, TARGET), "开关：enabled=false");
  assert.deepEqual(calls, ["flag:enabled=true", "flag:enabled=false"]);
});

test("collect / review 参数非法（缺失或写错）：给用法串且不改配置", async () => {
  const calls: string[] = [];
  const evo = fakeEvolution(calls);
  for (const args of ["collect", "collect yes", "review", "review 1"]) {
    const text = await runCommand(args, evo, TARGET);
    assert.match(text, /用法：\/skill-evolve (collect|review) on\|off/, args);
    assert.match(text, /配置未改动/, args);
  }
  assert.deepEqual(calls, [], "非法参数不该调 setFlag");
});

test("report --week 走周报，不把 --week 当天数", async () => {
  const calls: string[] = [];
  const evo = fakeEvolution(calls);
  assert.equal(await runCommand("report --week", evo, TARGET), "周报文本");
  assert.deepEqual(calls, ["week"]);
});

test("web：注入启动器时透传端口与 --once，没注入时给用法串", async () => {
  const calls: string[] = [];
  const evo = fakeEvolution(calls);
  const withoutLauncher = await runCommand("web", evo, TARGET);
  assert.match(withoutLauncher, /用法：\/skill-evolve web \[--port N\]/);
  assert.match(withoutLauncher, /没有注入面板启动器/);

  const requests: { port?: number; once: boolean }[] = [];
  const launcher = async (request: { port?: number; once: boolean }): Promise<string> => {
    requests.push(request);
    return `面板：${request.port ?? "默认"}${request.once ? "(once)" : ""}`;
  };
  const withLauncher = { ...TARGET, web: launcher };
  assert.equal(await runCommand("web", evo, withLauncher), "面板：默认");
  assert.equal(await runCommand("web --port 7799", evo, withLauncher), "面板：7799");
  assert.equal(await runCommand("web 7800", evo, withLauncher), "面板：7800");
  assert.equal(await runCommand("web --once", evo, withLauncher), "面板：默认(once)");
  assert.equal(await runCommand("web --port 7799 --once", evo, withLauncher), "面板：7799(once)");
  assert.deepEqual(requests, [
    { once: false },
    { once: false, port: 7799 },
    { once: false, port: 7800 },
    { once: true },
    { once: true, port: 7799 },
  ]);
});

test("parseWebPort：只认 1~65535 的整数", () => {
  assert.equal(parseWebPort(undefined), undefined);
  assert.equal(parseWebPort("7788"), 7788);
  assert.equal(parseWebPort("0"), undefined);
  assert.equal(parseWebPort("65536"), undefined);
  assert.equal(parseWebPort("abc"), undefined);
});
