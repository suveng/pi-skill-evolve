/**
 * 复盘提示词的归因表自检：`J`（该用没用）必须在表里，
 * 且 `G`/`J` 的 high 判据必须是「证据至少两条、每条指名具体动作」—— 否则这类漏判
 * 又会像 2026-11-11 那次一样被压成 low 丢掉（git-workflow 明明落在领域内，却没出提案）。
 *
 * 运行：node --test "test/*.test.ts"
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { ATTRIBUTION_KEYS } from "../lib/metrics.ts";

const TEMPLATE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "prompts", "复盘.md");

function template(): string {
  return fs.readFileSync(TEMPLATE, "utf8");
}

test("归因表含 J：该用没用（规则在场、动作没照做）", () => {
  const text = template();
  assert.match(text, /\|\s*`J`\s*\|/, "归因表缺 J 行");
  assert.match(text, /该用没用/, "J 行没写清是「该用没用」");
  assert.match(text, /规则原文/, "J 行要求给出规则原文位置");
});

test("G/J 的 high 判据写明证据条数，不再靠印象", () => {
  const text = template();
  assert.match(text, /`evidence` 至少两条/, "缺「证据至少两条」这条硬判据");
  assert.match(text, /`G`\+`high`、`J`\+`high` 都必须出提案/, "缺「G/J + high 必须出提案」");
});

test("字母表与归因表对得上：A..J 十个", () => {
  const text = template();
  assert.match(text, /只许用这十个字母/);
  assert.deepEqual([...ATTRIBUTION_KEYS], ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"]);
});
