/**
 * 评审后处理（设计稿 12.3）：结构、证据、一致性由代码判，机械复验再独立跑一遍。
 *
 * 原则是「不信 LLM 自觉」：verdict 只要有一个字段不合规就判 invalid（重评一次仍 invalid 就转人工），
 * pass 但带 blocking 是自相矛盾，直接 invalid；机械复验失败则一票 reject，覆盖 LLM 的 pass。
 *
 * 结论必须写「为什么」：`summary` 一句话说明因为什么（面板上人看的就是这一句），
 * `passed` 是「没问题的地方 + 证据」，verdict=pass 时至少 1 条 —— 只写 blocking 的评审
 * 在 pass/revise 时等于什么都没说，用户只能看到「通过」两个字。
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

/** 通过理由：哪一点没问题（point）+ 支撑它的原文证据 */
export interface ReviewPassing {
  point: string;
  evidence: ReviewEvidence;
}

export type ReviewStatus = "ok" | "invalid" | "reject";

export interface ReviewResult {
  status: ReviewStatus;
  verdict?: ReviewVerdict;
  blocking: ReviewBlocking[];
  passed: ReviewPassing[];
  /** 一句话结论（≤80 字，必须写「因为什么」）；旧版评审输出没有这一项 */
  summary?: string;
  notes?: string;
  /** invalid / reject 的具体原因（机器可读前缀 + 人话） */
  detail?: string;
}

const VERDICTS: readonly ReviewVerdict[] = ["pass", "reject", "revise"];

/** summary 上限：一句话结论，超了截断（80 字是面板上一行能读完的长度） */
export const SUMMARY_MAX = 80;

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
/** summary 归一：去首尾空白、压掉换行；空串 = 没写，超长按 80 字截断（含省略号本身不超过 80） */
function normalizeSummary(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const text = raw.replace(/\s+/g, " ").trim();
  if (text.length === 0) return null;
  return text.length > SUMMARY_MAX ? `${text.slice(0, SUMMARY_MAX - 1)}…` : text;
}

/**
 * 逐条读带证据的理由数组（blocking / passed 共用）：结构不对、证据不全一律返回错误字符串。
 * 顺序：先查 block 的证据，再查 passed 的证据 —— 两边共用同一个 checkEvidence，报错前缀区分来源。
 */
function readReasons<T>(
  raw: unknown,
  label: "blocking" | "passed",
  build: (text: string, evidence: ReviewEvidence) => T,
): T[] | string {
  if (raw !== undefined && !Array.isArray(raw)) return `bad-${label}: ${label} 不是数组`;
  const items: T[] = [];
  for (const item of (raw ?? []) as unknown[]) {
    if (typeof item !== "object" || item === null) return `missing-evidence: ${label} 项不是对象`;
    const evidence = checkEvidence((item as Record<string, unknown>).evidence);
    if (typeof evidence === "string") return `missing-evidence: ${label} · ${evidence}`;
    const key = label === "blocking" ? "issue" : "point";
    const rawText = (item as Record<string, unknown>)[key];
    const text = typeof rawText === "string" ? rawText.trim() : "";
    items.push(build(text.length > 0 ? text : `（未写 ${key}）`, evidence));
  }
  return items;
}

/**
 * 校验顺序 = 从「根本读不出结论」到「结论缺理由」：
 * JSON → verdict 白名单 → blocking 结构与证据 → passed 结构与证据 → pass 却带 blocking 的自相矛盾
 * → summary 必填 → pass 必须给 passed → reject/revise 必须给 blocking → 机械复验。
 * 越靠前的错误越致命，也让单测能一条一条钉住具体坏法。
 */
export function postProcessReview(text: string, opts: { recheck?: () => string | null } = {}): ReviewResult {
  const parsed = parseReviewJson(text);
  if (!parsed.json) return { status: "invalid", blocking: [], passed: [], detail: parsed.error ?? "bad-json" };

  const verdict = parsed.json.verdict;
  if (typeof verdict !== "string" || !(VERDICTS as readonly string[]).includes(verdict)) {
    return { status: "invalid", blocking: [], passed: [], detail: `bad-verdict: ${String(verdict)}` };
  }
  const typed = verdict as ReviewVerdict;

  const blocked = readReasons(parsed.json.blocking, "blocking", (issue, evidence) => ({ issue, evidence }));
  if (typeof blocked === "string") return { status: "invalid", blocking: [], passed: [], verdict: typed, detail: blocked };

  const passed = readReasons(parsed.json.passed, "passed", (point, evidence) => ({ point, evidence }));
  if (typeof passed === "string") return { status: "invalid", blocking: blocked, passed: [], verdict: typed, detail: passed };

  if (verdict === "pass" && blocked.length > 0) {
    return { status: "invalid", blocking: blocked, passed, verdict: "pass", detail: "contradiction: pass 却有 blocking" };
  }

  const summary = normalizeSummary(parsed.json.summary);
  if (summary === null) {
    return { status: "invalid", blocking: blocked, passed, verdict: typed, detail: "bad-summary: 没写 summary（一句话结论）" };
  }

  if (verdict === "pass" && passed.length === 0) {
    return {
      status: "invalid",
      blocking: blocked,
      passed,
      verdict: typed,
      summary,
      detail: "missing-passed: verdict=pass 但没给 passed（通过理由）",
    };
  }
  if (verdict !== "pass" && blocked.length === 0) {
    return {
      status: "invalid",
      blocking: blocked,
      passed,
      verdict: typed,
      summary,
      detail: `missing-blocking: verdict=${verdict} 但没给 blocking`,
    };
  }

  const notes = typeof parsed.json.notes === "string" ? parsed.json.notes : undefined;
  const failure = opts.recheck?.() ?? null;
  if (failure) {
    return { status: "reject", blocking: blocked, passed, verdict: "reject", summary, notes, detail: `frontmatter-invalid: ${failure}` };
  }

  return { status: "ok", blocking: blocked, passed, verdict: typed, summary, ...(notes ? { notes } : {}) };
}
