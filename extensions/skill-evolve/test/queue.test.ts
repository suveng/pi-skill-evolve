/**
 * 采纳队列单测：幂等、superseded 去重、并发入队不丢条目、坏文件容错。
 *
 * 用临时目录 + directQueue 跑真实 IO：这段逻辑的坑全在「文件里到底写了什么」。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { enqueue, findItem, markDone, queueFile, readQueue, takePending } from "../lib/queue.ts";
import { directQueue } from "../lib/telemetry.ts";

const NOW = 1_760_000_000_000;

function tempEvolutionDir(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "skill-evolve-queue-")), ".pi", "evolution");
}

function deps(dir: string, at = NOW) {
  return { evolutionDir: dir, queue: directQueue, now: () => at };
}

function input(runId: string, over: Partial<Parameters<typeof enqueue>[1]> = {}) {
  return { runId, level: "approval" as const, skill: "deploy-test", targets: [".pi/skills/deploy-test/SKILL.md"], ...over };
}

test("首次入队是 pending，createdAt 用注入时间", async () => {
  const dir = tempEvolutionDir();
  const result = await enqueue(deps(dir), input("run-1"));
  assert.equal(result.item.status, "pending");
  assert.equal(result.item.createdAt, NOW);
  assert.equal(result.supersededBy, undefined);
  assert.equal(readQueue(dir).length, 1);
});

test("同一个 runId 重复入队幂等：条数不变、不刷 createdAt", async () => {
  const dir = tempEvolutionDir();
  await enqueue(deps(dir), input("run-1"));
  const again = await enqueue(deps(dir, NOW + 5000), input("run-1"));
  assert.equal(readQueue(dir).length, 1);
  assert.equal(again.item.createdAt, NOW);
});

test("同一技能已有 pending 时，新条目直接 superseded 并指出被谁顶掉", async () => {
  const dir = tempEvolutionDir();
  await enqueue(deps(dir), input("run-1"));
  const second = await enqueue(deps(dir, NOW + 1000), input("run-2"));
  assert.equal(second.item.status, "superseded");
  assert.equal(second.supersededBy, "run-1");
  assert.match(second.item.detail ?? "", /run-1/);
  // 前一条仍是 pending，takePending 只给它
  assert.deepEqual(takePending(readQueue(dir)).map((item) => item.runId), ["run-1"]);
});

test("同一技能的前一条已 applied 后，新条目可以再成为 pending", async () => {
  const dir = tempEvolutionDir();
  await enqueue(deps(dir), input("run-1"));
  await markDone(deps(dir), "run-1", "applied");
  const second = await enqueue(deps(dir, NOW + 1000), input("run-2"));
  assert.equal(second.item.status, "pending");
});

test("不同技能互不影响，takePending 按入队时间升序且可按级别过滤", async () => {
  const dir = tempEvolutionDir();
  await enqueue(deps(dir, NOW + 2000), input("run-late", { skill: "hard-rules" }));
  await enqueue(deps(dir, NOW), input("run-early", { skill: "deploy-test", level: "auto" }));
  assert.deepEqual(takePending(readQueue(dir)).map((item) => item.runId), ["run-early", "run-late"]);
  assert.deepEqual(takePending(readQueue(dir), "auto").map((item) => item.runId), ["run-early"]);
});

test("并发入队不丢条目：两个 runId 同时写，队列里两条都在", async () => {
  const dir = tempEvolutionDir();
  await Promise.all([
    enqueue(deps(dir), input("run-a", { skill: "skill-a" })),
    enqueue(deps(dir), input("run-b", { skill: "skill-b" })),
  ]);
  assert.deepEqual(readQueue(dir).map((item) => item.runId).sort(), ["run-a", "run-b"]);
});

test("markDone 改状态并写 detail；找不到 runId 时返回 false 且不改文件", async () => {
  const dir = tempEvolutionDir();
  await enqueue(deps(dir), input("run-1"));
  assert.equal(await markDone(deps(dir), "run-1", "applied", "五道闸全绿"), true);
  const item = findItem(readQueue(dir), "run-1");
  assert.equal(item?.status, "applied");
  assert.equal(item?.detail, "五道闸全绿");
  assert.equal(await markDone(deps(dir), "run-404", "failed"), false);
  assert.equal(readQueue(dir).length, 1);
});

test("损坏文件容错：坏 JSON 当空队列，单条非法字段只丢那一条", async () => {
  const dir = tempEvolutionDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(queueFile(dir), "{不是 JSON", "utf8");
  assert.deepEqual(readQueue(dir), []);
  fs.writeFileSync(
    queueFile(dir),
    JSON.stringify([
      { runId: "ok", level: "auto", skill: "s", targets: [], createdAt: NOW, status: "pending" },
      { runId: "bad", level: "whatever", skill: "s", targets: [], createdAt: NOW, status: "pending" },
    ]),
    "utf8",
  );
  assert.deepEqual(readQueue(dir).map((item) => item.runId), ["ok"]);
  // 坏文件之后仍能继续入队（不会被坏内容卡死）
  const result = await enqueue(deps(dir), input("run-new", { skill: "other" }));
  assert.equal(result.item.status, "pending");
  assert.deepEqual(readQueue(dir).map((item) => item.runId).sort(), ["ok", "run-new"]);
});
