/**
 * 面板进程的**启动器**（pi 侧）：把面板从「pi 进程里的一段监听」变成「一个能单独重启的子进程」。
 *
 * 为什么（2026-11-11 用户原话「做成你也可以重启的吧」）：
 * 面板原先跟着 pi 主进程走，换版本看新界面只能重启 pi 会话 —— 用户人在终端里、agent 在飞书里，
 * 谁都没法替对方按那个键。改成子进程之后：
 * - 版本变了 → 杀旧子进程、起新的，pi 会话不受影响；
 * - 子进程挂了 → 下次 session_start 自动拉起；
 * - 手动重启 → `kill <pid>` 再跑一次这个模块的 CLI（见 README「面板」节）。
 *
 * 三条边界：
 * 1. **启动失败不许拖垮会话**：任何异常都只记日志并返回 `{ok:false}`，调用方（autostart）照旧降级；
 * 2. **端口主人要分清**：`locks/web.json` 里是别的活进程（另一个工作区 / 另一个 pi 窗口）就不抢；
 * 3. **代码要搬出 node_modules**：node 拒绝对 node_modules 里的 `.ts` 做类型剥离，
 *    所以启动前把扩展目录复制到 `.pi/evolution/runtime/panel-<版本>/` 再跑，复制按版本缓存。
 */
import { spawn as nodeSpawn, type SpawnOptions } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { isAlive, readWebPid } from "./panel-pid.ts";
import type { WebPanelErrorCode, WebPanelResult } from "./server.ts";
import { WEB_CHILD_ENV, type WebChildConfig } from "./child-main.ts";

/** 复制扩展目录时跳过的东西：测试与临时产物不进运行态 */
const COPY_SKIP = new Set(["test", "node_modules", ".tmp"]);

export type PanelAction = "reuse" | "restart-version" | "restart-dead" | "start" | "owned-elsewhere";

export interface PanelDecisionInput {
  /** locks/web.json 里的持有者（没有就是 null） */
  owner: { pid: number; url: string; version?: string } | null;
  /** 持有者是否还活着 */
  alive: boolean;
  /** 期望版本（当前安装的扩展版本） */
  version: string;
  /** 期望端口 */
  port: number;
  /** 持有者当时监听的端口 */
  ownerPort?: number;
}

/**
 * 纯判定：这次该复用、该换版本、该救活，还是让给别人。
 *
 * 单独抽出来是为了能被单测逐个钉死 —— 这里判错一个分支，用户就会看到
 * 「明明装了新版，面板还是旧的」或者「两个面板抢同一个端口」。
 */
export function decidePanel(input: PanelDecisionInput): PanelAction {
  const { owner, alive, version } = input;
  if (!owner) return "start";
  if (!alive) return "restart-dead";
  if (owner.pid === process.pid) return "reuse"; // 理论上不该出现：面板不再跑在 pi 进程里
  if (input.ownerPort !== undefined && input.ownerPort !== input.port) return "restart-version";
  if (owner.version !== version) return "restart-version";
  return "owned-elsewhere";
}

/** 递归复制扩展目录到运行态缓存；已存在同版本就直接复用（内容由版本号唯一决定） */
export function materializeExtension(options: {
  source: string;
  runtimeRoot: string;
  version: string;
}): string {
  const target = path.join(options.runtimeRoot, `panel-v${options.version}`);
  const entry = path.join(target, "lib", "web", "child-main.ts");
  if (fs.existsSync(entry)) return target;
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });
  fs.cpSync(options.source, target, {
    recursive: true,
    filter: (src) => !COPY_SKIP.has(path.basename(src)),
  });
  return target;
}

export interface EnsurePanelDeps {
  evolutionDir: string;
  cwd: string;
  /** 扩展源码目录（含 lib/ 与 prompts/） */
  extensionDir: string;
  version: string;
  port: number;
  log?(msg: string): void;
  /** 单测注入 */
  spawnFn?(command: string, args: string[], options: SpawnOptions): { pid?: number; unref?(): void };
  alive?(pid: number): boolean;
  /** 等待子进程写 locks/web.json 的轮询间隔与上限 */
  waitMs?: number;
}

/** 等子进程把自己写进 locks/web.json：写到了才算「起成功了」 */
async function waitForPid(options: {
  evolutionDir: string;
  pid: number;
  waitMs: number;
  sleep: (ms: number) => Promise<void>;
}): Promise<string | null> {
  const deadline = Date.now() + options.waitMs;
  while (Date.now() < deadline) {
    const info = readWebPid(options.evolutionDir);
    if (info && info.pid === options.pid) return info.url;
    await options.sleep(50);
  }
  return null;
}

/**
 * 保证面板在跑：按 `decidePanel` 的结论复用 / 换版本 / 救活 / 新起。
 *
 * 换版本与救活都要先杀旧进程：SIGTERM 让它自己关监听（child-main 里挂了信号处理），
 * 等端口真的空出来再起，避免 EADDRINUSE。
 */
export async function ensurePanel(deps: EnsurePanelDeps): Promise<WebPanelResult> {
  const log = deps.log ?? (() => undefined);
  const alive = deps.alive ?? isAlive;
  const spawnFn = deps.spawnFn ?? nodeSpawn;
  const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));
  const owner = readWebPid(deps.evolutionDir);
  const decision = decidePanel({
    owner: owner ? { pid: owner.pid, url: owner.url, ...(owner.version === undefined ? {} : { version: owner.version }) } : null,
    alive: owner ? alive(owner.pid) : false,
    version: deps.version,
    port: deps.port,
    ...(owner === null ? {} : { ownerPort: owner.port }),
  });
  if (decision === "reuse" && owner) {
    log(`[skill-evolve] 面板已在跑（pid ${owner.pid} v${owner.version ?? "?"}）：${owner.url}`);
    return panelFromRecord(owner.url, owner.host, owner.port);
  }
  if (decision === "owned-elsewhere" && owner) {
    log(`[skill-evolve] 面板由别的进程持有（pid ${owner.pid} v${owner.version ?? "?"}）：${owner.url}，本实例不抢`);
    return panelFromRecord(owner.url, owner.host, owner.port);
  }
  if (owner && alive(owner.pid) && (decision === "restart-version" || decision === "restart-dead")) {
    log(`[skill-evolve] 换面板进程：pid ${owner.pid} v${owner.version ?? "?"} → v${deps.version}`);
    try {
      process.kill(owner.pid, "SIGTERM");
    } catch (error) {
      log(`[skill-evolve] 结束旧面板进程失败（继续尝试启动）：${String(error)}`);
    }
    // 等它自己关掉监听：最多 2 秒，超时也照样起（真占着就报 EADDRINUSE，由调用方降级）
    for (let i = 0; i < 20 && alive(owner.pid); i += 1) await sleep(100);
  }
  let entry: string;
  try {
    entry = path.join(
      materializeExtension({
        source: deps.extensionDir,
        runtimeRoot: path.join(deps.evolutionDir, "runtime"),
        version: deps.version,
      }),
      "lib",
      "web",
      "child-main.ts",
    );
  } catch (error) {
    log(`[skill-evolve] 面板代码复制失败：${String(error)}`);
    return fail("UNKNOWN", `面板代码复制失败：${String(error)}`);
  }
  const config: WebChildConfig = {
    cwd: deps.cwd,
    port: deps.port,
    version: deps.version,
    promptTemplate: path.join(path.dirname(entry), "..", "..", "prompts", "复盘.md"),
  };
  let child: { pid?: number; unref?(): void };
  try {
    child = spawnFn(process.execPath, [entry], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, [WEB_CHILD_ENV]: JSON.stringify(config) },
    });
    child.unref?.();
  } catch (error) {
    log(`[skill-evolve] 启动面板子进程失败：${String(error)}`);
    return fail("UNKNOWN", `启动面板子进程失败：${String(error)}`);
  }
  const pid = typeof child.pid === "number" ? child.pid : 0;
  if (pid <= 0) return fail("UNKNOWN", "面板子进程没有 pid");
  const url = await waitForPid({ evolutionDir: deps.evolutionDir, pid, waitMs: deps.waitMs ?? 5_000, sleep });
  if (url === null) {
    log(`[skill-evolve] 面板子进程 pid ${pid} 没能写回 locks/web.json（查看 .pi/evolution/logs/extension.log）`);
    return fail("UNKNOWN", "面板子进程起来了但没写回监听地址");
  }
  log(`[skill-evolve] 面板独立进程已起：${url}（pid ${pid} v${deps.version}）`);
  const info = readWebPid(deps.evolutionDir);
  return {
    ok: true,
    panel: {
      url,
      host: info?.host ?? "127.0.0.1",
      port: info?.port ?? deps.port,
      csrf: "",
      close: async () => {
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          // 已经退出：close 是幂等的，不当作错误
        }
      },
    },
  };
}

function fail(code: WebPanelErrorCode, message: string): WebPanelResult {
  return { ok: false, code, message };
}

/** 复用别人监听着的面板：本进程不再持有监听，close 变成空操作 */
function panelFromRecord(url: string, host: string, port: number): WebPanelResult {
  return { ok: true, panel: { url, host, port, csrf: "", close: async () => undefined } };
}
