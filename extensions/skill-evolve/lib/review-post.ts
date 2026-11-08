/**
 * 评审后处理（设计稿 12.3）：结构、证据、一致性由代码判，机械复验再独立跑一遍。
 *
 * 原则是「不信 LLM 自觉」：verdict 只要有一个字段不合规就判 invalid（重评一次仍 invalid 就转人工），
 * pass 但带 blocking 是自相矛盾，直接 invalid；机械复验失败则一票 reject，覆盖 LLM 的 pass。
 */

export type ReviewVerdict = "pass" | "reject" | "revise";

export interface ReviewEvidence {
  file: string;
  line: number;
  quote: string;
}

export interface ReviewBlocking {
  issue: string;
  evidence: ReviewEvidence;
}

export type ReviewStatus = "ok" | "invalid" | "reject";

export interface ReviewResult {
  status: ReviewStatus;
  verdict?: ReviewVerdict;
  blocking: ReviewBlocking[];
  notes?: string;
  /** invalid / reject 的具体原因（机器可读前缀 + 人话） */
  detail?: string;
}

const VERDICTS: readonly ReviewVerdict[] = ["pass", "reject", "revise"];

/** 从模型输出里抠 JSON：容忍 ```json 围栏与前后废话，抠不出就当解析失败 */
export function parseReviewJson(text: string): { json?: Record<string, unknown>; error?: string } {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = (fenced ? fenced[1] : text).trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return { error: `bad-json: 输出里没有 JSON 对象（${body.slice(0, 80)}）` };
  try {
    const parsed: unknown = JSON.parse(body.slice(start, end + 1));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { error: "bad-json: 顶层不是对象" };
    return { json: parsed as Record<string, unknown> };
  } catch (error) {
    return { error: `bad-json: ${(error as Error).message}` };
  }
}

function checkEvidence(raw: unknown): ReviewEvidence | string {
  if (typeof raw !== "object" || raw === null) return "evidence 不是对象";
  const item = raw as Record<string, unknown>;
  const file = typeof item.file === "string" ? item.file.trim() : "";
  if (file.length === 0) return "evidence.file 为空";
  // 行号必须是正整数：字符串 "42"、0、-1、"第 42 行" 一律不算可定位证据
  if (typeof item.line !== "number" || !Number.isInteger(item.line) || item.line <= 0) return "evidence.line 不是正整数";
  const quote = typeof item.quote === "string" ? item.quote.trim() : "";
  if (quote.length === 0) return "evidence.quote 为空";
  return { file, line: item.line, quote };
}

/**
 * 12.3 四步里的前三步（结构 / 证据 / 一致性）+ 可选的机械复验。
 * `recheck` 由调用方注入（读盘 + loadSkillsFromDir），返回错误字符串表示复验失败。
 */
export function postProcessReview(text: string, opts: { recheck?: () => string | null } = {}): ReviewResult {
  const parsed = parseReviewJson(text);
  if (!parsed.json) return { status: "invalid", blocking: [], detail: parsed.error ?? "bad-json" };

  const verdict = parsed.json.verdict;
  if (typeof verdict !== "string" || !(VERDICTS as readonly string[]).includes(verdict)) {
    return { status: "invalid", blocking: [], detail: `bad-verdict: ${String(verdict)}` };
  }

  const rawBlocking = parsed.json.blocking;
  if (rawBlocking !== undefined && !Array.isArray(rawBlocking)) {
    return { status: "invalid", blocking: [], verdict: verdict as ReviewVerdict, detail: "bad-blocking: blocking 不是数组" };
  }
  const blocked: ReviewBlocking[] = [];
  for (const item of (rawBlocking ?? []) as unknown[]) {
    if (typeof item !== "object" || item === null) {
      return { status: "invalid", blocking: [], verdict: verdict as ReviewVerdict, detail: "missing-evidence: blocking 项不是对象" };
    }
    const evidence = checkEvidence((item as Record<string, unknown>).evidence);
    if (typeof evidence === "string") {
      return { status: "invalid", blocking: [], verdict: verdict as ReviewVerdict, detail: `missing-evidence: ${evidence}` };
    }
    const issue = typeof (item as Record<string, unknown>).issue === "string" ? String((item as Record<string, unknown>).issue) : "";
    blocked.push({ issue: issue.length > 0 ? issue : "（未写 issue）", evidence });
  }

  const notes = typeof parsed.json.notes === "string" ? parsed.json.notes : undefined;
  if (verdict === "pass" && blocked.length > 0) {
    return { status: "invalid", blocking: blocked, verdict: "pass", detail: "contradiction: pass 却有 blocking" };
  }

  const failure = opts.recheck?.() ?? null;
  if (failure) return { status: "reject", blocking: blocked, verdict: "reject", notes, detail: `frontmatter-invalid: ${failure}` };

  return { status: "ok", blocking: blocked, verdict: verdict as ReviewVerdict, ...(notes ? { notes } : {}) };
}
