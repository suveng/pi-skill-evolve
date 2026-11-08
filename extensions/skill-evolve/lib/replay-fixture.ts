/**
 * 端到端复演的固定数据：假技能前后文、提案 diff、假会话 JSONL、假评审结论。
 *
 * 单独一个文件是为了让 `replay.ts` 只留流程（300 行闸门），也方便测试直接引用这些常量。
 */

/** 复演用技能：改动前 */
export const REPLAY_BEFORE = [
  "---",
  "name: replay-demo",
  "description: 复演流水线时使用的临时技能，别在真实会话里用",
  "---",
  "",
  "# replay-demo",
  "",
  "- 只给 scripts/replay.ts 用。",
  "",
].join("\n");

/** 复演用技能：改动后（只加正文条款 → approval 级，正好走「人批」这一段） */
export const REPLAY_AFTER = [
  "---",
  "name: replay-demo",
  "description: 复演流水线时使用的临时技能，别在真实会话里用",
  "---",
  "",
  "# replay-demo",
  "",
  "- 只给 scripts/replay.ts 用。",
  "- 复演时必须先看 00-session/index.json 再读会话原文。",
  "",
].join("\n");

/**
 * 复演用的提案 diff：**带上下文行**的真实形状（提案由复盘子 agent 写，不是整文件重渲染）。
 * 整文件重渲染那种 diff 里 frontmatter 会变成增删行，分级会误判 forbidden —— 那不是真实提案的样子。
 */
export const REPLAY_DIFF = [
  "--- a/.pi/skills/replay-demo/SKILL.md",
  "+++ b/.pi/skills/replay-demo/SKILL.md",
  "@@ -5,4 +5,5 @@",
  " ",
  " # replay-demo",
  " ",
  " - 只给 scripts/replay.ts 用。",
  "+- 复演时必须先看 00-session/index.json 再读会话原文。",
  "",
].join("\n");

/** 假评审结论：形状必须过 postProcessReview 的字段校验（summary 必填 + 证据三件套齐全 + pass 必须有 passed） */
export const FAKE_REVIEW_TEXT = JSON.stringify({
  verdict: "pass",
  summary: "新增条款只补了复演前的读取顺序，没有删改原有约束",
  blocking: [],
  passed: [
    { point: "没有删原有禁令", evidence: { file: ".pi/skills/replay-demo/SKILL.md", line: 9, quote: "复演时必须先看 00-session/index.json" } },
  ],
  notes: ["复演用假评审：只验证流水线，不代表真实评审质量"],
});

/** 假会话 JSONL：只要够 buildSessionIndex 抽出结构，不复制真实会话 */
export function fakeSessionText(cwd: string, at: number): string {
  const iso = new Date(at).toISOString();
  return [
    JSON.stringify({ type: "session", version: 3, id: "replay-session", timestamp: iso, cwd }),
    JSON.stringify({
      type: "message",
      id: "r1",
      parentId: null,
      timestamp: iso,
      message: { role: "user", content: [{ type: "text", text: "帮我看看 replay-demo 这个技能该怎么改" }] },
    }),
    JSON.stringify({
      type: "message",
      id: "r2",
      parentId: "r1",
      timestamp: iso,
      message: { role: "assistant", content: [{ type: "text", text: "先按索引抽查，再给提案。" }] },
    }),
    "",
  ].join("\n");
}

