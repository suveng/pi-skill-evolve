/**
 * run 详情页（`?view=run&runId=...`）的数据：一次读全这一轮复盘留下的证据。
 *
 * 一个 run 目录里能看的东西固定为六类，正好对应页面上六块：
 * run.json（概要）· 02-proposal.diff（改了什么）· candidate/<技能>/SKILL.md（改后全文）
 * · 03-review.json（评审结论与 blocking）· 06-verify.json（五闸）· 01-findings.json（发现了什么）。
 *
 * 纪律：
 * 1. **只读**；2. **坏文件当空**（六块各自独立退化，缺一块不影响其它块）；
 * 3. **runId 必须过白名单**：走 resolveRunDir()（已有闸：解析后的父目录必须是 runs/），
 *    否则 `?view=run&runId=../../..` 就能把仓库外的文件读出来。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { ServerResponse } from "node:http";
import { readVerify } from "../apply.ts";
import { readProposalSummary } from "../proposal.ts";
import type { RunRecord } from "../runs.ts";
import { asNumber, asRecord, asText, readJson, reasonLabel } from "./json-read.ts";
import { sendText, TEXT_TYPE } from "./http.ts";
import { resolveRunDir } from "./run-path.ts";

/** findings 最多展示 20 条：一轮复盘可能列出几十个技能，页面只用来快速定位问题 */
export const FINDING_LIMIT = 20;

/** 技能名白名单：candidate 目录名来自 run.json 里的提案，绝不能让 `../` 参与拼路径 */
const SAFE_SKILL = /^[A-Za-z0-9._-]+$/;

export interface RunBlocking {
  issue: string;
  file: string;
  line: number | null;
  quote: string;
}

export interface RunGate {
  gate: string;
  name: string;
  ok: boolean;
  detail: string;
}

export interface RunFinding {
  skill: string;
  /** 已加载 / 未加载的原因（G 没触发 之类），搬 reports.ts 的同一套口径 */
  reason: string;
  confidence: string;
  /** evidence 里的行号（01-findings.json 只写 line，没有 file） */
  lines: number[];
}

export interface RunDetail {
  runId: string;
  status: string;
  trigger: string;
  /** 提案目标技能；没有提案时为空串 */
  skill: string;
  startedAt: number | null;
  /** 结束时间：run.json 不写 finishedAt，取 03/04/06 里最后一个时刻（没有就是 null） */
  endedAt: number | null;
  pid: number | null;
  /** 有没有 child.log（决定要不要给日志链接） */
  hasChildLog: boolean;
  /** 02-proposal.diff 原文；没有这个文件为 null */
  diff: string | null;
  /** candidate 目录里的技能名（与 skill 一致才读全文） */
  candidateSkill: string | null;
  candidateText: string | null;
  review: { status: string; verdict: string; action: string; reviewerModel: string } | null;
  blocking: RunBlocking[];
  gates: RunGate[];
  verifyStatus: string | null;
  findings: RunFinding[];
  findingsTotal: number;
  notes: string;
}

function readTextFile(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function exists(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** 03-review.json → verdict / action / reviewerModel + blocking（每条带 file:line 与原文引用） */
function readReview(runDir: string): Pick<RunDetail, "review" | "blocking"> {
  const raw = asRecord(readJson<unknown>(path.join(runDir, "03-review.json")));
  if (!raw) return { review: null, blocking: [] };
  const blocking: RunBlocking[] = [];
  for (const item of Array.isArray(raw.blocking) ? raw.blocking : []) {
    const record = asRecord(item);
    if (!record) continue;
    const evidence = asRecord(record.evidence);
    blocking.push({
      issue: asText(record.issue, "（未写问题描述）"),
      file: asText(evidence?.file),
      line: asNumber(evidence?.line),
      quote: asText(evidence?.quote),
    });
  }
  return {
    review: {
      status: asText(raw.status, "（未写状态）"),
      verdict: asText(raw.verdict, "（未写 verdict）"),
      action: asText(raw.action, "（未写 action）"),
      reviewerModel: asText(raw.reviewerModel, "（未写模型）"),
    },
    blocking,
  };
}

/** 五闸：06-verify.json 的 gates（apply.ts 写的唯一一处闸门记录） */
function readGates(runDir: string): Pick<RunDetail, "gates" | "verifyStatus"> {
  const verify = readVerify(runDir);
  if (!verify) return { gates: [], verifyStatus: null };
  const gates = (Array.isArray(verify.gates) ? verify.gates : []).map((gate) => ({
    gate: asText(gate.gate),
    name: asText(gate.name),
    ok: gate.ok === true,
    detail: asText(gate.detail),
  }));
  return { gates, verifyStatus: asText(verify.status, "（未写状态）") };
}

/** 01-findings.json：每条技能的归因 + evidence 行号，最多 20 条 */
function readFindings(runDir: string): Pick<RunDetail, "findings" | "findingsTotal" | "notes"> {
  const raw = asRecord(readJson<unknown>(path.join(runDir, "01-findings.json")));
  if (!raw) return { findings: [], findingsTotal: 0, notes: "" };
  const skills = Array.isArray(raw.skills) ? raw.skills : [];
  const rows: RunFinding[] = [];
  for (const item of skills.slice(0, FINDING_LIMIT)) {
    const record = asRecord(item);
    if (!record) continue;
    const loaded = record.loaded === true;
    const code = asText(record.whyNotLoaded);
    const lines: number[] = [];
    for (const evidence of Array.isArray(record.evidence) ? record.evidence : []) {
      const line = asNumber(asRecord(evidence)?.line);
      if (line !== null) lines.push(line);
    }
    rows.push({
      skill: asText(record.name, "（未写技能名）"),
      reason: loaded ? "已加载" : code.length > 0 ? reasonLabel(code) : "未写归因",
      confidence: asText(record.confidence, "—"),
      lines,
    });
  }
  return { findings: rows, findingsTotal: skills.length, notes: asText(raw.notes) };
}

/** 改后全文：candidate/<技能>/SKILL.md，技能名过白名单 + 解析后父目录必须是 candidate/ */
function readCandidate(runDir: string, skill: string): Pick<RunDetail, "candidateSkill" | "candidateText"> {
  if (!SAFE_SKILL.test(skill)) return { candidateSkill: null, candidateText: null };
  const candidateRoot = path.join(runDir, "candidate");
  const dir = path.join(candidateRoot, skill);
  if (path.dirname(path.resolve(dir)) !== path.resolve(candidateRoot)) {
    return { candidateSkill: null, candidateText: null };
  }
  const text = readTextFile(path.join(dir, "SKILL.md"));
  return text === null ? { candidateSkill: null, candidateText: null } : { candidateSkill: skill, candidateText: text };
}

/** 判目录是否存在：resolveRunDir 只管「不越界」，不保证目录真存在（由调用方按 404 处理） */
function isDir(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 读一个 run 的详情。runId 不合法（含 `../`、绕对路径）**或目录不存在**一律返回 null ——
 * 调用方据此回 404：不读盘越界，也不返回一个全是空值的假页。
 */
export function readRunDetail(evolutionDir: string, runId: string): RunDetail | null {
  const runDir = resolveRunDir(evolutionDir, runId);
  if (!runDir || !isDir(runDir)) return null;
  const record = readJson<RunRecord>(path.join(runDir, "run.json"));
  const review = readReview(runDir);
  const gates = readGates(runDir);
  const findings = readFindings(runDir);
  // 子进程常常只写 02-proposal.json 而没回写 run.json（真实 run 就是这样），两处都要看
  const skill = asText(record?.proposal?.skill ?? readProposalSummary(runDir)?.skill);
  const candidate = readCandidate(runDir, skill);
  const decision = asNumber(asRecord(readJson<unknown>(path.join(runDir, "04-decision.json")))?.at);
  const verifyAt = asNumber(asRecord(readJson<unknown>(path.join(runDir, "06-verify.json")))?.at);
  const reviewAt = asNumber(asRecord(readJson<unknown>(path.join(runDir, "03-review.json")))?.reviewedAt);
  const stamps = [decision, verifyAt, reviewAt].filter((value): value is number => value !== null);
  const hasChildLog = exists(path.join(runDir, "child.log"));
  return {
    runId,
    status: asText(record?.status, "（无 run.json）"),
    trigger: asText(record?.trigger, "—"),
    skill,
    startedAt: asNumber(record?.dispatchedAt),
    endedAt: stamps.length === 0 ? null : Math.max(...stamps),
    pid: asNumber(record?.pid),
    hasChildLog,
    diff: readTextFile(path.join(runDir, "02-proposal.diff")),
    ...candidate,
    ...review,
    ...gates,
    ...findings,
  };
}

/**
 * `GET /diff?runId=...`：返回 02-proposal.diff 原文（text/plain），给「完整 diff」链接用。
 * 不合法 / 不存在一律 404，文案与 /log 同一套口径（说清缺什么，别只说 not found）。
 */
export function handleDiff(evolutionDir: string, response: ServerResponse, url: URL): void {
  const runId = url.searchParams.get("runId") ?? "";
  const runDir = resolveRunDir(evolutionDir, runId);
  if (!runDir) {
    sendText(response, 404, `404：没有这个 run 的 diff（runId=${runId}）`, TEXT_TYPE);
    return;
  }
  const text = readTextFile(path.join(runDir, "02-proposal.diff"));
  if (text === null) {
    sendText(response, 404, `404：这个 run 没写 02-proposal.diff（runId=${runId}）`, TEXT_TYPE);
    return;
  }
  sendText(response, 200, text, TEXT_TYPE);
}
