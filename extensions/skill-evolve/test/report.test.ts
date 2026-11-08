/**
 * status / report 文本单测：提案摘要只显示不应用，且没提案的 run 不该多出空行。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderReport, renderStatus } from "../lib/report.ts";
import type { EvolutionConfig } from "../lib/config.ts";
import { summarize } from "../lib/telemetry.ts";

const CONFIG: EvolutionConfig = {
  enabled: true,
  idleMs: 90_000,
  maxRuntimeMs: 1_200_000,
  perSessionCap: 2,
  telemetry: true,
};

const NOW = 1_760_000_000_000;

test("status：run 列表带提案摘要（只显示，不应用）", () => {
  const text = renderStatus({
    config: CONFIG,
    configPath: "/repo/.pi/evolution/config.json",
    telemetryDir: "/repo/.pi/evolution/telemetry",
    lockPid: undefined,
    runs: [
      {
        runId: "abc12345-1",
        status: "proposed",
        dispatchedAt: NOW,
        sessionId: "s1",
        proposal: { type: "improve", skill: "deploy-test", status: "ok", added: 2, removed: 1, file: "02-proposal.diff" },
      },
      { runId: "abc12345-0", status: "analyzed", dispatchedAt: NOW - 1000, sessionId: "s1" },
    ],
  });
  assert.match(text, /abc12345-1\s+proposed\s+.*提案 improve deploy-test \[ok\] \+2\/-1/);
  assert.match(text, /abc12345-0\s+analyzed/);
});

test("report：有提案时多一句「不应用」说明，没提案时不出现", () => {
  const summary = summarize([]);
  const withProposal = renderReport({
    days: 7,
    summary,
    runs: [
      {
        runId: "abc12345-1",
        status: "proposed",
        dispatchedAt: NOW,
        sessionId: "s1",
        proposal: { type: "create", skill: "deploy-check", status: "ok", added: 0, removed: 0, file: "candidate/deploy-check/SKILL.md" },
      },
    ],
  });
  assert.match(withProposal, /提案 create deploy-check \[ok\]/);
  assert.match(withProposal, /提案只生成不应用/);

  const withoutProposal = renderReport({
    days: 7,
    summary,
    runs: [{ runId: "abc12345-0", status: "analyzed", dispatchedAt: NOW, sessionId: "s1" }],
  });
  assert.doesNotMatch(withoutProposal, /提案只生成不应用/);
  assert.match(withoutProposal, /加载率：无曝光数据/);
});
