/**
 * 生产环境的子进程封装：git 摘要、md-check 复验、auto 级的单独 commit、候选技能的引用面扫描。
 *
 * 全部同步（spawnSync）：采纳是人触发的短路径，阻塞一两百毫秒可以接受；
 * 用异步反而会拉宽「写盘成功但 commit 还没跑」的窗口。
 * 单测不 import 本文件 —— 闸门里的 git / md-check / commit 都是注入点。
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { GitRunner } from "./gate0.ts";
import type { QueueItem } from "./queue.ts";
import type { ReferenceScan } from "./weekly.ts";

export function createGitRunner(): GitRunner {
  return (args, cwd) => {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    return { code: result.status ?? 1, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
  };
}

export function createMdCheckRunner(cwd: string): (absPath: string) => { code: number; output: string } {
  const script = path.join(cwd, ".pi", "skills", "md-check", "scripts", "check_md.py");
  return (absPath) => {
    const result = spawnSync("python3", [script, absPath], { cwd, encoding: "utf8" });
    return { code: result.status ?? 1, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
  };
}

/** auto 级成功后单独一条 `docs(skill): ...`；失败由调用方回滚该条 */
export function createCommitRunner(cwd: string): (item: QueueItem) => { ok: boolean; hash?: string; detail?: string } {
  return (item) => {
    const add = spawnSync("git", ["add", "--", ...item.targets], { cwd, encoding: "utf8" });
    if ((add.status ?? 1) !== 0) return { ok: false, detail: `git add 失败：${(add.stderr ?? "").trim()}` };
    const message = `docs(skill): ${item.skill} ${item.proposalType ?? "improve"}（${item.runId}）`;
    const commit = spawnSync("git", ["commit", "-m", message, "--", ...item.targets], { cwd, encoding: "utf8" });
    if ((commit.status ?? 1) !== 0) return { ok: false, detail: `git commit 失败：${(commit.stderr ?? "").trim()}` };
    const head = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd, encoding: "utf8" });
    return { ok: true, hash: (head.stdout ?? "").trim() };
  };
}

/**
 * 零加载候选的引用面清单（设计稿 10.4 的五处收口里能自动查的三处）：
 * `.cursor` stub、`AGENTS.md` 索引行、其它技能里的提及。`rg` 不在 PATH 时按 0 处理并记日志。
 */
export function createReferenceScan(cwd: string): (skill: string) => ReferenceScan {
  return (skill) => {
    const cursorStub = fs.existsSync(path.join(cwd, ".cursor", "skills", skill, "SKILL.md"));
    let agentsIndex = false;
    for (const file of [path.join(cwd, "AGENTS.md"), path.join(cwd, ".pi", "AGENTS.md")]) {
      try {
        const rows = fs.readFileSync(file, "utf8").split("\n");
        if (rows.some((row) => row.includes(`\`${skill}\``) && row.trimStart().startsWith("-"))) agentsIndex = true;
      } catch {
        // 索引文件不存在是正常情况（AGENTS.md 只在部分仓里）
      }
    }
    const result = spawnSync("rg", ["-l", "-F", skill, path.join(cwd, ".pi", "skills")], { cwd, encoding: "utf8" });
    const hits = (result.stdout ?? "").split("\n").filter((line) => line.trim().length > 0);
    const ownDir = `${path.join(cwd, ".pi", "skills", skill)}${path.sep}`;
    const mentions = hits.filter((file) => !file.startsWith(ownDir)).length;
    return { cursorStub, agentsIndex, mentions };
  };
}
