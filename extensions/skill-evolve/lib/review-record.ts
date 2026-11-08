/**
 * 评审结果的落盘形态（`03-review.json` / `03-review.md`）与从 run.json 取宿主模型名。
 *
 * 单独一个文件是因为评审督导已经接近 300 行闸门；这里全是纯函数，单测可直接调。
 */
import type { ActionLevel } from "./classify-action.ts";
import type { ReviewBlocking, ReviewVerdict } from "./review-post.ts";

export type SupervisorStatus = "reviewed" | "rejected" | "review_failed" | "skipped";

export interface ReviewRecord {
  status: SupervisorStatus;
  reason?: string;
  verdict?: ReviewVerdict;
  blocking: ReviewBlocking[];
  notes?: string;
  action?: ActionLevel;
  reviewerModel: string;
  proposerModel: string;
  sameModel: boolean;
  attempts?: number;
  detail?: string;
  reviewedAt: number;
  reviewedAtIso: string;
}

/** 提案者的实际模型：取 run.json 里最后一个带 model 的 stage（复盘子进程收尾会写 analyze） */
export function stageModel(runRaw: string | undefined): string {
  if (!runRaw) return "";
  try {
    const stages = (JSON.parse(runRaw) as Record<string, unknown>).stages;
    if (!Array.isArray(stages)) return "";
    for (let index = stages.length - 1; index >= 0; index -= 1) {
      const stage = stages[index] as Record<string, unknown>;
      if (typeof stage.model === "string" && stage.model.length > 0) return stage.model;
    }
  } catch {
    return "";
  }
  return "";
}

export function renderReviewMarkdown(record: ReviewRecord, skill: string): string {
  const lines: string[] = [];
  // 首行就要立警告：同模型自评的独立性天然有限，人一眼得看见
  if (record.sameModel) lines.push("> 同模型自评，独立性有限（proposer 与 reviewer 是同一个模型，请人工复核）", "");
  lines.push(`# 评审结论：${record.verdict ?? record.status}`, "");
  lines.push(`- 技能：${skill}`);
  lines.push(`- status：${record.status}${record.detail ? `（${record.detail}）` : ""}`);
  lines.push(`- 建议动作：${record.action ?? "无"}（本版一律不写 .pi/skills）`);
  lines.push(`- 模型：reviewer=${record.reviewerModel} / proposer=${record.proposerModel}`);
  if (record.blocking.length === 0) {
    lines.push("", "blocking：无");
  } else {
    lines.push("", "## blocking", "");
    for (const item of record.blocking) {
      lines.push(`- ${item.issue}`, `  - 证据：${item.evidence.file}:${item.evidence.line} 「${item.evidence.quote}」`);
    }
  }
  if (record.notes) lines.push("", "## notes", "", record.notes);
  lines.push("");
  return lines.join("\n");
}
