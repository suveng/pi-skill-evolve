/**
 * run 详情页的数据读取：六块证据各自退化、runId 越界一律 404、/diff 只回 text/plain。
 * 全部喂临时目录 + 假 res 对象，不起子进程、不占端口。
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ServerResponse } from "node:http";
import test from "node:test";
import { handleDiff, readRunDetail } from "../lib/web/run-detail.ts";

const NOW = Date.UTC(2026, 10, 8, 12);
const RUN_ID = "354df7db-1794133942";

const DIFF_TEXT = [
  "--- a/.pi/skills/demo/SKILL.md",
  "+++ b/.pi/skills/demo/SKILL.md",
  "@@ -1,2 +1,2 @@",
  " ---",
  "-description: 旧",
  "+description: 新",
].join("\n") + "\n";

function workspace(): { evolutionDir: string; runDir: string; cwd: string } {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "skill-evolve-rundetail-"));
  const evolutionDir = path.join(cwd, ".pi", "evolution");
  const runDir = path.join(evolutionDir, "runs", RUN_ID);
  fs.mkdirSync(runDir, { recursive: true });
  return { evolutionDir, runDir, cwd };
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value), "utf8");
}

function writeText(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, "utf8");
}

/** 造一个「证据齐全」的 run：run.json + diff + candidate + 评审 + 决策 + 五闸 + 发现 + child.log */
function fullRun(): { evolutionDir: string; runDir: string } {
  const { evolutionDir, runDir } = workspace();
  writeJson(path.join(runDir, "run.json"), {
    runId: RUN_ID,
    status: "rejected",
    trigger: "auto",
    dispatchedAt: NOW,
    pid: 65757,
    sessionId: "s",
    proposal: { type: "improve", skill: "demo", status: "ok", added: 1, removed: 1, file: "02-proposal.diff" },
  });
  writeText(path.join(runDir, "02-proposal.diff"), DIFF_TEXT);
  writeText(path.join(runDir, "child.log"), "启动复盘子进程\nmcp timeout\n");
  writeText(path.join(runDir, "candidate", "demo", "SKILL.md"), "---\nname: demo\n---\n# 改后\n");
  writeJson(path.join(runDir, "03-review.json"), {
    status: "rejected",
    verdict: "revise",
    action: "forbidden",
    reviewerModel: "deepseek/deepseek-flash",
    reviewedAt: NOW + 5_000,
    notes: "证据不足",
    blocking: [
      {
        issue: "描述承诺大于正文能力",
        evidence: { file: ".pi/skills/demo/SKILL.md", line: 3, quote: "含 <script> 的引用" },
      },
      { issue: "缺少证据", evidence: {} },
    ],
  });
  writeJson(path.join(runDir, "04-decision.json"), { status: "rejected", approver: "auto", at: NOW + 6_000 });
  writeJson(path.join(runDir, "06-verify.json"), {
    runId: RUN_ID,
    status: "applied",
    at: NOW + 7_000,
    ms: 12,
    wrote: [],
    gates: [
      { gate: "gate0", name: "授权核对", ok: true, ms: 1 },
      { gate: "gate3", name: "复验", ok: false, ms: 2, detail: "复验失败" },
    ],
  });
  writeJson(path.join(runDir, "01-findings.json"), {
    skills: [
      { name: "demo", advertised: true, loaded: false, whyNotLoaded: "G", confidence: "high", evidence: [{ line: 578 }, { line: 622 }] },
      { name: "other", advertised: true, loaded: true, confidence: "medium" },
    ],
    notes: "只差两处",
  });
  return { evolutionDir, runDir };
}

interface FakeResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

function fakeResponse(): { res: ServerResponse; out: FakeResponse } {
  const out: FakeResponse = { status: 0, headers: {}, body: "" };
  const res = {
    writeHead(status: number, headers: Record<string, string>) {
      out.status = status;
      out.headers = headers;
      return res;
    },
    end(text: string) {
      out.body = text;
      return res;
    },
  } as unknown as ServerResponse;
  return { res, out };
}

test("readRunDetail：六块证据（概要 / diff / 候选全文 / 评审 / 五闸 / 发现）一次读全", () => {
  const { evolutionDir } = fullRun();
  const detail = readRunDetail(evolutionDir, RUN_ID)!;
  assert.equal(detail.runId, RUN_ID);
  assert.equal(detail.status, "rejected");
  assert.equal(detail.trigger, "auto");
  assert.equal(detail.skill, "demo");
  assert.equal(detail.pid, 65757);
  assert.equal(detail.startedAt, NOW);
  assert.equal(detail.endedAt, NOW + 7_000, "结束时间取最后一个产出时刻");
  assert.equal(detail.hasChildLog, true);
  assert.equal(detail.diff, DIFF_TEXT);
  assert.equal(detail.candidateSkill, "demo");
  assert.match(detail.candidateText ?? "", /# 改后/);
  assert.deepEqual(detail.review, {
    status: "rejected",
    verdict: "revise",
    action: "forbidden",
    reviewerModel: "deepseek/deepseek-flash",
  });
  assert.equal(detail.blocking.length, 2);
  assert.equal(detail.blocking[0]!.line, 3, "证据行号要能直接跳过去");
  assert.match(detail.blocking[1]!.issue, /缺少证据/);
  assert.equal(detail.blocking[1]!.file, "", "缺 evidence 的文件位置不能编一个");
  assert.deepEqual(
    detail.gates.map((gate) => `${gate.gate}:${gate.ok}`),
    ["gate0:true", "gate3:false"],
  );
  assert.equal(detail.gates[1]!.detail, "复验失败");
  assert.equal(detail.verifyStatus, "applied");
  assert.equal(detail.findingsTotal, 2);
  assert.deepEqual(
    detail.findings[0],
    // F / G 是复盘 agent 自己判的码，DISPOSITIONS 里没有（那里只有 A-E + semantic），原样显示
    { skill: "demo", reason: "G", confidence: "high", lines: [578, 622] },
  );
  assert.equal(detail.findings[1]!.reason, "已加载");
  assert.equal(detail.notes, "只差两处");
});

test("readRunDetail：runId 不合法（../、绝对路径、子路径）一律 null，不读盘越界", () => {
  const { evolutionDir } = fullRun();
  for (const runId of ["../x", "../../etc", "/etc/passwd", "a/b", "", "."]) {
    assert.equal(readRunDetail(evolutionDir, runId), null, `runId=${JSON.stringify(runId)} 必须被挡住`);
  }
});

test("readRunDetail：目录不存在 → null（不抛异常）", () => {
  const { evolutionDir } = fullRun();
  assert.equal(readRunDetail(evolutionDir, "00000000-0"), null);
});

test("readRunDetail：只剩 run.json 时六块各自空着，不是抛错也不是编数字", () => {
  const { evolutionDir, runDir } = workspace();
  writeJson(path.join(runDir, "run.json"), { runId: RUN_ID, status: "dispatched", trigger: "manual", dispatchedAt: NOW });
  const detail = readRunDetail(evolutionDir, RUN_ID)!;
  assert.equal(detail.diff, null);
  assert.equal(detail.review, null);
  assert.deepEqual(detail.blocking, []);
  assert.deepEqual(detail.gates, []);
  assert.equal(detail.verifyStatus, null);
  assert.equal(detail.findingsTotal, 0);
  assert.equal(detail.hasChildLog, false);
  assert.equal(detail.candidateText, null);
  assert.equal(detail.endedAt, null);
  assert.equal(detail.pid, null);
});

test("readRunDetail：提案技能名含 ../ 时不读 candidate（拼路径越界）", () => {
  const { evolutionDir, runDir } = workspace();
  writeJson(path.join(runDir, "run.json"), {
    runId: RUN_ID,
    status: "reviewed",
    trigger: "auto",
    dispatchedAt: NOW,
    proposal: { type: "improve", skill: "../../secret" },
  });
  writeText(path.join(evolutionDir, "secret", "SKILL.md"), "SECRET\n");
  const detail = readRunDetail(evolutionDir, RUN_ID)!;
  assert.equal(detail.skill, "../../secret", "展示原值即可，但不去读那个文件");
  assert.equal(detail.candidateText, null);
});

test("readRunDetail：发现超过 20 条只收 20 条，总数照实报", () => {
  const { evolutionDir, runDir } = workspace();
  writeJson(path.join(runDir, "run.json"), { runId: RUN_ID, status: "analyzed", trigger: "auto", dispatchedAt: NOW });
  const skills = Array.from({ length: 25 }, (_unused, index) => ({
    name: `skill-${index + 1}`,
    advertised: true,
    loaded: false,
    whyNotLoaded: "G",
    confidence: "low",
    evidence: [{ line: index + 1 }],
  }));
  writeJson(path.join(runDir, "01-findings.json"), { skills, notes: [] });
  const detail = readRunDetail(evolutionDir, RUN_ID)!;
  assert.equal(detail.findings.length, 20);
  assert.equal(detail.findingsTotal, 25);
  assert.equal(detail.findings[19]!.skill, "skill-20");
});

test("readRunDetail：run.json 没写 proposal 时用 02-proposal.json 的技能名（真实 run 就是这种）", () => {
  const { evolutionDir } = workspace();
  const runDir = path.join(evolutionDir, "runs", "run-real");
  fs.mkdirSync(path.join(runDir, "candidate", "demo"), { recursive: true });
  fs.writeFileSync(path.join(runDir, "run.json"), JSON.stringify({ runId: "run-real", status: "rejected" }), "utf8");
  fs.writeFileSync(
    path.join(runDir, "02-proposal.json"),
    JSON.stringify({ type: "improve", skill: "demo", rationale: "", evidence: [], diffFile: "02-proposal.diff" }),
    "utf8",
  );
  fs.writeFileSync(path.join(runDir, "candidate", "demo", "SKILL.md"), "改后全文\n", "utf8");
  const detail = readRunDetail(evolutionDir, "run-real");
  assert.equal(detail?.skill, "demo");
  assert.equal(detail?.candidateSkill, "demo");
  assert.equal(detail?.candidateText, "改后全文\n");
});

test("handleDiff：命中时回 200 + text/plain + diff 原文", () => {
  const { evolutionDir } = fullRun();
  const { res, out } = fakeResponse();
  handleDiff(evolutionDir, res, new URL(`http://x/diff?runId=${RUN_ID}`));
  assert.equal(out.status, 200);
  assert.equal(out.headers["content-type"], "text/plain; charset=utf-8");
  assert.equal(out.body, DIFF_TEXT);
});

test("handleDiff：没有 02-proposal.diff 与 runId 越界都是 404，文案说清缺什么", () => {
  const { evolutionDir, runDir } = workspace();
  writeJson(path.join(runDir, "run.json"), { runId: RUN_ID, status: "dispatched" });
  const noDiff = fakeResponse();
  handleDiff(evolutionDir, noDiff.res, new URL(`http://x/diff?runId=${RUN_ID}`));
  assert.equal(noDiff.out.status, 404);
  assert.match(noDiff.out.body, /404：这个 run 没写 02-proposal\.diff/);

  const bad = fakeResponse();
  handleDiff(evolutionDir, bad.res, new URL("http://x/diff?runId=../x"));
  assert.equal(bad.out.status, 404);
  assert.match(bad.out.body, /404：没有这个 run 的 diff/);
});
