/**
 * 端到端复演脚本（M6 验收）：临时目录 + 假技能 + 假会话，走完 发现 → 提案 → 评审 → 人批 → 采纳 → 复验。
 *
 * 用法：
 *   node --experimental-strip-types scripts/replay.ts            # 假评审，省 token（默认）
 *   node --experimental-strip-types scripts/replay.ts --real     # 真起 `pi -p` 做评审
 *   node --experimental-strip-types scripts/replay.ts --dir /tmp/xxx --keep
 *
 * 绝不写本仓：所有产物都在 `--dir` 指定的临时目录（默认 `mkdtemp`）。
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { REPLAY_BEFORE } from "../lib/replay-fixture.ts";
import { runReplay } from "../lib/replay.ts";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const REPO_ROOT = path.resolve(HERE, "..", "..", "..", "..");

interface Args {
  real: boolean;
  keep: boolean;
  dir: string | null;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { real: false, keep: false, dir: null };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index] as string;
    if (item === "--real") args.real = true;
    else if (item === "--fake") args.real = false;
    else if (item === "--keep") args.keep = true;
    else if (item === "--dir") {
      args.dir = argv[index + 1] ?? null;
      index += 1;
    }
  }
  return args;
}

/** 造一个干净的临时工作区：技能已提交，闸0 的基线才是「干净」 */
function prepareWorkdir(dir: string): void {
  const skillFile = path.join(dir, ".pi", "skills", "replay-demo", "SKILL.md");
  fs.mkdirSync(path.dirname(skillFile), { recursive: true });
  fs.writeFileSync(skillFile, REPLAY_BEFORE, "utf8");
  const git = (args: string[]): void => {
    const result = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")} 失败：${result.stderr || result.stdout}`);
  };
  git(["init", "-q"]);
  git(["add", "-A"]);
  git(["-c", "user.email=replay@example.com", "-c", "user.name=replay", "commit", "-qm", "复演初始状态"]);

  // 硬规则用真仓那一份：复演要验的正是真实评审规则
  const rulesSrc = path.join(REPO_ROOT, ".pi", "evolution", "rules", "hard-rules.json");
  if (fs.existsSync(rulesSrc)) {
    const rulesDst = path.join(dir, ".pi", "evolution", "rules", "hard-rules.json");
    fs.mkdirSync(path.dirname(rulesDst), { recursive: true });
    fs.copyFileSync(rulesSrc, rulesDst);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const dir = args.dir ?? fs.mkdtempSync(path.join(os.tmpdir(), "skill-evolve-replay-"));
  fs.mkdirSync(dir, { recursive: true });
  prepareWorkdir(dir);
  console.log(`[复演] 工作区：${dir}`);
  console.log(`[复演] 评审：${args.real ? "真跑 pi -p" : "假评审（--real 可切真跑）"}`);

  const outcome = await runReplay({
    cwd: dir,
    evolutionDir: path.join(dir, ".pi", "evolution"),
    fakeReview: !args.real,
    log: (msg) => console.log(msg),
  });

  console.log("");
  for (const line of outcome.lines) console.log(line);
  console.log("");
  console.log(`[复演] run.json status 序列：${outcome.statuses.join(" → ")}`);
  for (const failure of outcome.failures) console.log(`[复演] 失败：${failure}`);
  console.log(`[复演] 结论：${outcome.ok ? "六段全通" : "存在失败段"}`);
  if (!args.keep) {
    // 保留在 /tmp 也没意义，失败时留证据
    if (outcome.ok) fs.rmSync(dir, { recursive: true, force: true });
    else console.log(`[复演] 失败现场保留：${dir}`);
  }
  process.exitCode = outcome.ok ? 0 : 1;
}

await main();
