#!/usr/bin/env node
/**
 * 面板独立进程的运维入口（人用、agent 用，都不需要动 pi 会话）。
 *
 *   node scripts/panel.mjs status            看现在是谁在跑、什么版本
 *   node scripts/panel.mjs start  [--port n] 没跑就起一个（已在跑则原样复用）
 *   node scripts/panel.mjs stop              停掉（SIGTERM，等它自己关监听）
 *   node scripts/panel.mjs restart [--port n] 重启（换版本后就是这条）
 *
 * 为什么要有脚本而不是只在 index.ts 里 spawn：
 * 面板曾经跑在 pi 主进程里，于是「换个版本」只能重启整个 pi 会话 —— 用户在终端里、
 * agent 在飞书里，谁都不能替对方按那个键。拆出来之后，重启面板就是 restart 一条命令。
 *
 * 两个必要动作都在这里做，缺一个就起不来：
 * 1. 复制扩展目录到 `.pi/evolution/runtime/panel-v<版本>/`：node 拒绝对 node_modules 里的 .ts 做类型剥离；
 * 2. 通过环境变量把配置传进去：命令行参数在 ps 里全都看得见。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXT_DIR = path.join(PKG_ROOT, "extensions", "skill-evolve");
const SKIP = new Set(["test", "node_modules", ".tmp"]);

/** 解析 `--port 7799` / `--cwd /x` 这类参数 */
function argOf(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  return value === undefined ? fallback : value;
}

const cwd = path.resolve(argOf("cwd", process.cwd()));
const evolutionDir = path.join(cwd, ".pi", "evolution");
const lockFile = path.join(evolutionDir, "locks", "web.json");
const version = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, "package.json"), "utf8")).version;

function readLock() {
  try {
    const raw = JSON.parse(fs.readFileSync(lockFile, "utf8"));
    if (!Number.isInteger(raw?.pid) || raw.pid <= 0) return null;
    return raw;
  } catch {
    return null;
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** 没显式给 --port 时，用工作区配置里的端口 */
function readConfigPort() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(evolutionDir, "config.json"), "utf8"));
    const port = raw?.web?.port;
    return Number.isInteger(port) && port > 0 ? port : 7788;
  } catch {
    return 7788;
  }
}

/** 复制扩展目录（按版本缓存）；返回 child-main.ts 的绝对路径 */
function materialize() {
  const target = path.join(evolutionDir, "runtime", `panel-v${version}`);
  const entry = path.join(target, "lib", "web", "child-main.ts");
  if (!fs.existsSync(entry)) {
    fs.rmSync(target, { recursive: true, force: true });
    fs.mkdirSync(target, { recursive: true });
    fs.cpSync(EXT_DIR, target, { recursive: true, filter: (src) => !SKIP.has(path.basename(src)) });
  }
  return entry;
}

async function status() {
  const lock = readLock();
  if (!lock) {
    console.log("面板没在跑（没有 locks/web.json）");
    return 1;
  }
  const isAlive = alive(lock.pid);
  console.log(`pid=${lock.pid} 存活=${isAlive ? "是" : "否"} 版本=${lock.version ?? "?"} 地址=${lock.url}`);
  return isAlive ? 0 : 1;
}

async function stop() {
  const lock = readLock();
  if (!lock) {
    console.log("没有在跑的面板，什么也没做");
    return 0;
  }
  if (!alive(lock.pid)) {
    fs.rmSync(lockFile, { force: true });
    console.log(`记录的 pid ${lock.pid} 已不在，清掉 locks/web.json`);
    return 0;
  }
  process.kill(lock.pid, "SIGTERM");
  for (let i = 0; i < 30 && alive(lock.pid); i += 1) await sleep(100);
  console.log(alive(lock.pid) ? `pid ${lock.pid} 3 秒内没退出，请查 .pi/evolution/logs/extension.log` : `已停 pid ${lock.pid}`);
  return alive(lock.pid) ? 1 : 0;
}

async function start() {
  const lock = readLock();
  const wanted = Number(argOf("port", readConfigPort()));
  // 端口被明确指定、且和现有面板不一样 → 先停再按新端口起（否则用户以为换了端口，实际还是老的）
  if (lock && alive(lock.pid) && lock.port === wanted) {
    console.log(`面板已在跑：${lock.url}（pid ${lock.pid} v${lock.version ?? "?"}）`);
    return 0;
  }
  if (lock && alive(lock.pid)) {
    console.log(`现有面板在 ${lock.url}，与要求的端口 ${wanted} 不同，先停掉`);
    if ((await stop()) !== 0) return 1;
  }
  const port = wanted;
  const entry = materialize();
  const env = {
    ...process.env,
    SKILL_EVOLVE_WEB_CHILD: JSON.stringify({
      cwd,
      port,
      version,
      promptTemplate: path.join(path.dirname(entry), "prompts", "复盘.md"),
    }),
  };
  const child = spawn(process.execPath, [entry], { detached: true, stdio: "ignore", env });
  child.unref();
  for (let i = 0; i < 60; i += 1) {
    const now = readLock();
    if (now && now.pid === child.pid) {
      console.log(`面板已起：${now.url}（pid ${now.pid} v${version}）`);
      return 0;
    }
    await sleep(100);
  }
  console.log(`子进程 pid ${child.pid} 没能写回 locks/web.json（看 .pi/evolution/logs/extension.log；端口 ${port} 被占也会这样）`);
  return 1;
}

const action = process.argv[2] ?? "status";
const handlers = { status, start, stop, restart: async () => (await stop()) === 0 && (await start()) === 0 ? 0 : 1 };
const handler = handlers[action];
if (!handler) {
  console.log(`用法：node scripts/panel.mjs <status|start|stop|restart> [--port 7788] [--cwd <工作区>]`);
  process.exit(2);
}
process.exit(await handler());
