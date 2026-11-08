/**
 * 三个新地址的 HTTP 接线：`?view=skills`、`?view=run&runId=`、`/diff?runId=`。
 * 用 port 0 由内核分配随机端口（与 web-server.test.ts 同一手法），不起任何子进程、不抢固定端口。
 * 渲染与读盘的细节在各自单测里，这一层只验证「路由接对了、状态码与 content-type 对了」。
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { startWebPanel, type WebPanel } from "../lib/web/server.ts";

const DIFF = [
  "--- a/.pi/skills/demo/SKILL.md",
  "+++ b/.pi/skills/demo/SKILL.md",
  "@@ -1,1 +1,1 @@",
  "-description: 旧",
  "+description: 新",
].join("\n");

/** 工作区里放一个技能与一个带 diff 的 run，够三个地址都点得动 */
function workspace(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "skill-evolve-views-"));
  const evolutionDir = path.join(cwd, ".pi", "evolution");
  const skillDir = path.join(cwd, ".pi", "skills", "demo");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), "---\nname: demo\n---\n# demo\n", "utf8");
  const runDir = path.join(evolutionDir, "runs", "run-diff");
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(
    path.join(runDir, "run.json"),
    JSON.stringify({
      runId: "run-diff",
      status: "reviewed",
      trigger: "auto",
      pid: 1234,
      dispatchedAt: Date.UTC(2026, 10, 8, 10),
      skills: ["demo"],
      proposal: { type: "improve", skill: "demo", status: "ok", added: 1, removed: 1, file: "02-proposal.diff" },
    }),
    "utf8",
  );
  fs.writeFileSync(path.join(runDir, "02-proposal.diff"), DIFF, "utf8");
  return evolutionDir;
}

async function open(evolutionDir: string): Promise<WebPanel> {
  const result = await startWebPanel({ evolutionDir, port: 0 });
  assert.equal(result.ok, true, `面板应该起来：${result.ok ? "" : result.message}`);
  if (!result.ok) throw new Error("unreachable");
  return result.panel;
}

test("GET /?view=skills：技能管理页显式可访问，表格里有 .pi/skills 下的技能", async () => {
  const panel = await open(workspace());
  try {
    const response = await fetch(`${panel.url}/?view=skills`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/html/);
    const html = await response.text();
    assert.match(html, /<title>技能进化 · 技能管理<\/title>/);
    assert.match(html, /<a href="\/\?view=skill&amp;name=demo&amp;days=30">demo<\/a>/);
  } finally {
    await panel.close();
  }
});

test("GET /?view=skill&name=：带名字进详情，不带名字回技能管理（不让 ?view=skill 空页）", async () => {
  const panel = await open(workspace());
  try {
    const detail = await (await fetch(`${panel.url}/?view=skill&name=demo`)).text();
    assert.match(detail, /<title>技能进化 · 技能 demo<\/title>/);
    assert.match(detail, /<a href="\/\?view=run&amp;runId=run-diff">run-diff<\/a>/);
    const noName = await (await fetch(`${panel.url}/?view=skill`)).text();
    assert.match(noName, /<title>技能进化 · 技能管理<\/title>/);
  } finally {
    await panel.close();
  }
});

test("GET /?view=run&runId=：真 run 出 diff 视图，不存在的 run 是 404 text/plain", async () => {
  const panel = await open(workspace());
  try {
    const response = await fetch(`${panel.url}/?view=run&runId=run-diff`);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /<title>技能进化 · run run-diff<\/title>/);
    assert.match(html, /<pre class="diff">/);
    assert.match(html, /<span class="dl add">/);
    for (const bad of ["run-nope", "../../etc/passwd", "a/b"]) {
      const missing = await fetch(`${panel.url}/?view=run&runId=${encodeURIComponent(bad)}`);
      assert.equal(missing.status, 404, `runId=${bad} 必须 404`);
      assert.match(missing.headers.get("content-type") ?? "", /text\/plain/);
      assert.equal((await missing.text()).includes("description"), false, "404 页不能带出 diff 内容");
    }
  } finally {
    await panel.close();
  }
});

test("GET /diff：完整 diff 是 text/plain 原文；越界与没有 diff 的 run 都 404", async () => {
  const panel = await open(workspace());
  try {
    const response = await fetch(`${panel.url}/diff?runId=run-diff`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/plain; charset=utf-8/);
    assert.equal(await response.text(), DIFF);
    assert.equal((await fetch(`${panel.url}/diff?runId=../queue.json`)).status, 404);
    assert.equal((await fetch(`${panel.url}/diff?runId=run-nope`)).status, 404);
  } finally {
    await panel.close();
  }
});
