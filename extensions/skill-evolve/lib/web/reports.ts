/**
 * 复盘报告视图的数据：每个跑过 `01-findings.json` 的 run 一行，另加「卡死且没产出」的 run（标 stale）。
 * 判据仍然是 findings 能读；例外是 status=stale 的失败 run —— 它们也要在档案里有一行。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { readVerify } from "../apply.ts";
import type { RunSummary } from "../runs.ts";
import { readRunError } from "../stale.ts";
import { asNumber, asRecord, asText, readJson, reasonLabel } from "./json-read.ts";
import { sessionFromRecord, type SessionRef } from "./run-session.ts";

/** 单条报告里最多列几个技能：全量列会把 details 撑成第二份 findings */
export const MAX_FINDING_ROWS = 5;

export interface FindingRow {
  skill: string;
  kind: string;
  reason: string;
}

export interface RunReport {
  runId: string;
  status: string;
  trigger: string;
  /** 这条 run 是哪个会话跑出来的：行上「会话」列要用（缺 = NO_SESSION） */
  session: SessionRef;
  startedAt: number | null;
  findings: { total: number; rows: FindingRow[] };
  proposal: { type: string; skill: string; added: number; removed: number } | null;
  review: { status: string; verdict: string | null; blocking: number } | null;
  decision: { status: string; approver: string; at: number | null; detail: string } | null;
  verify: { status: string; at: number | null; gates: { gate: string; name: string; ok: boolean }[] } | null;
  /** 失败留档：卡死原因 + 日志末行（有它说明这份报告是「没跑完」而不是「没发现」） */
  failure?: string;
}

/** findings 读不出来（缺文件 / 坏 JSON）返回 null：报告页不能拿「0 条」冒充「解析失败」 */
function readFindings(runDir: string): RunReport["findings"] | null {
  const raw = readJson<Record<string, unknown>>(path.join(runDir, "01-findings.json"));
  if (!raw) return null;
  const skills = Array.isArray(raw.skills) ? raw.skills : [];
  const rows: FindingRow[] = [];
  for (const entry of skills) {
    const skill = asRecord(entry);
    if (!skill) continue;
    const loaded = skill.loaded === true;
    const code = asText(skill.whyNotLoaded);
    rows.push({
      skill: asText(skill.name, "(未命名)"),
      kind: loaded ? "已加载" : skill.advertised === false ? "未曝光" : "未加载",
      reason: loaded ? "—" : code.length > 0 ? reasonLabel(code) : "未写归因",
    });
  }
  return { total: rows.length, rows: rows.slice(0, MAX_FINDING_ROWS) };
}

function readReview(runDir: string): RunReport["review"] {
  const raw = readJson<Record<string, unknown>>(path.join(runDir, "03-review.json"));
  if (!raw) return null;
  return {
    status: asText(raw.status, "unknown"),
    verdict: typeof raw.verdict === "string" ? raw.verdict : null,
    blocking: Array.isArray(raw.blocking) ? raw.blocking.length : 0,
  };
}

function readDecision(runDir: string): RunReport["decision"] {
  const raw = readJson<Record<string, unknown>>(path.join(runDir, "04-decision.json"));
  if (!raw) return null;
  return {
    status: asText(raw.status, "unknown"),
    approver: asText(raw.approver, "?"),
    at: asNumber(raw.at),
    detail: asText(raw.detail),
  };
}

function readVerifyGates(runDir: string): RunReport["verify"] {
  const record = readVerify(runDir);
  if (!record) return null;
  const gates = Array.isArray(record.gates) ? record.gates : [];
  return {
    status: asText(record.status, "unknown"),
    at: asNumber(record.at),
    gates: gates.map((gate) => ({ gate: asText(gate.gate), name: asText(gate.name), ok: gate.ok === true })),
  };
}

/** 触发者与会话只在 run.json 里（listRuns 的摘要不带 trigger）：一次读出两样，坏记录当 unknown / 空 */
function readRunMeta(runDir: string): { trigger: string; session: SessionRef } {
  const raw = readJson<Record<string, unknown>>(path.join(runDir, "run.json"));
  return { trigger: asText(raw?.trigger, "unknown"), session: sessionFromRecord(raw) };
}

/** runs/ 下的目录名（不看 run.json，坏掉的目录也要能被 reports 的真实判据「有没有 01-findings」筛） */
function runDirs(evolutionDir: string): { runId: string; runDir: string }[] {
  const root = path.join(evolutionDir, "runs");
  let names: string[];
  try {
    names = fs.readdirSync(root);
  } catch {
    return [];
  }
  const found: { runId: string; runDir: string }[] = [];
  for (const name of names) {
    if (name.startsWith(".")) continue;
    const runDir = path.join(root, name);
    try {
      if (!fs.statSync(runDir).isDirectory()) continue;
    } catch {
      continue;
    }
    found.push({ runId: name, runDir });
  }
  return found;
}

export function buildReports(evolutionDir: string, runs: readonly RunSummary[]): RunReport[] {
  const summaries = new Map(runs.map((run) => [run.runId, run]));
  const reports: RunReport[] = [];
  for (const { runId, runDir } of runDirs(evolutionDir)) {
    const meta = readRunMeta(runDir);
    const findings = readFindings(runDir);
    if (!findings) {
      // 失败也要有一行档案：每条 run 都能在报告里找到，不能因为没产出就从历史里消失
      const summary = summaries.get(runId);
      const raw = readJson<Record<string, unknown>>(path.join(runDir, "run.json"));
      if ((summary?.status ?? asText(raw?.status)) !== "stale") continue;
      const error = readRunError(runDir);
      const tail = error?.childLogTail ?? [];
      const lastLine = tail.length > 0 ? tail[tail.length - 1]!.trim() : "";
      reports.push({
        runId,
        status: "stale",
        trigger: meta.trigger,
        session: meta.session,
        startedAt: summary?.dispatchedAt ?? asNumber(raw?.dispatchedAt),
        findings: { total: 0, rows: [] },
        proposal: null,
        review: readReview(runDir),
        decision: readDecision(runDir),
        verify: readVerifyGates(runDir),
        failure: [
          `原因：${error?.reason === "timeout" ? "超时（子进程还活着但超过单 run 上限）" : "子进程已退出"}`,
          `日志末行：${lastLine.length > 0 ? lastLine : "（子进程没留下任何输出）"}`,
        ].join("\n"),
      });
      continue;
    }
    const proposal = summaries.get(runId)?.proposal;
    reports.push({
      runId,
      status: summaries.get(runId)?.status ?? "unknown",
      trigger: meta.trigger,
      session: meta.session,
      startedAt: summaries.get(runId)?.dispatchedAt ?? null,
      findings,
      proposal: proposal ? { type: proposal.type, skill: proposal.skill, added: proposal.added, removed: proposal.removed } : null,
      review: readReview(runDir),
      decision: readDecision(runDir),
      verify: readVerifyGates(runDir),
    });
  }
  return reports.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
}
