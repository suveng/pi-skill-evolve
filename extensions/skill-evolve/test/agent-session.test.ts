/**
 * Agent 会话上 web：分析 / 评审 / 重写三个子进程原来只留 stdout 日志，现在同时落会话文件，
 * 面板用「会话页」渲染它们（角色过滤、工具折叠都用得上）。
 * 这里只测两件容易错的事：文件定位（白名单防越界）与详情页是否真的给出入口。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readAgentSessionSource } from "../lib/web/session-file.ts";
import { readRunDetail } from "../lib/web/run-detail.ts";
import { renderRunPage } from "../lib/web/render-run.ts";
import type { WebState } from "../lib/web/data.ts";

const RUN = "260928fa-1794400136";

/** pi 的会话行格式：type=message + message{role, content}，否则解析出 0 条 */
function sessionLine(role: string, text: string): string {
  return `${JSON.stringify({ type: "message", timestamp: "2026-11-11T12:00:00.000Z", message: { role, content: text } })}\n`;
}

function emptyState(): WebState {
  return {
    pending: [],
    approvals: [],
    applied: [],
    done: [],
    summary: { reviewing: 0, stale: 0, pendingApprovals: 0, appliedTotal: 0, rollbackRate: 0 },
  };
}

function workspace(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "skill-evolve-agent-session-"));
  const evolutionDir = path.join(cwd, ".pi", "evolution");
  const agents = path.join(evolutionDir, "runs", RUN, "agents");
  fs.mkdirSync(agents, { recursive: true });
  fs.writeFileSync(path.join(evolutionDir, "runs", RUN, "run.json"), JSON.stringify({ runId: RUN, status: "reviewed" }), "utf8");
  fs.writeFileSync(path.join(agents, `2026-11-11T12-00-00-000Z_se-review.jsonl`), sessionLine("user", "请评审这份提案") + sessionLine("assistant", "结论：通过"), "utf8");
  return evolutionDir;
}

test("readAgentSessionSource：按 se-<role>.jsonl 找到会话并解析出轮次", () => {
  const evolutionDir = workspace();
  const source = readAgentSessionSource({ evolutionDir, runId: RUN, role: "review" });
  assert.ok(source.file?.endsWith("_se-review.jsonl"), "要命中评审 Agent 那份");
  assert.equal(source.agent?.role, "review");
  assert.equal(source.transcript?.entries.length, 2);
});

test("readAgentSessionSource：角色不在白名单 / runId 带 .. / 目录不存在，一律当没有", () => {
  const evolutionDir = workspace();
  assert.equal(readAgentSessionSource({ evolutionDir, runId: RUN, role: "../etc" }).file, null);
  assert.equal(readAgentSessionSource({ evolutionDir, runId: "../../etc", role: "review" }).file, null);
  assert.equal(readAgentSessionSource({ evolutionDir, runId: "no-such-run", role: "review" }).file, null);
  assert.equal(readAgentSessionSource({ evolutionDir, runId: RUN, role: "analyze" }).file, null, "没落盘就是没有");
});

test("详情页：Agent 会话给出「会话」入口（带 runId+agent），日志仍可点", () => {
  const evolutionDir = workspace();
  const runDir = path.join(evolutionDir, "runs", RUN);
  fs.writeFileSync(path.join(runDir, "02-proposal.json"), JSON.stringify({ type: "improve", skill: "demo" }), "utf8");
  fs.writeFileSync(path.join(runDir, "agent-review.log"), "原始输出\n", "utf8");
  const detail = readRunDetail(evolutionDir, RUN);
  assert.ok(detail !== null);
  assert.deepEqual(detail.agentSessions.map((item) => item.role), ["review"], "要在详情数据里列出会话文件");

  const html = renderRunPage(detail, { state: emptyState() });
  assert.match(html, /view=session&amp;runId=260928fa-1794400136&amp;agent=review/);
  assert.match(html, /agent-review\.log/, "原始日志入口要保留");
  assert.match(html, /提案 Agent/);
  assert.match(html, /重写 Agent/);
});
