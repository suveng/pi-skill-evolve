/**
 * 面板的**独立进程**入口：由 `lib/web/spawn-panel.ts` 拉起，自己监听端口、自己干活。
 *
 * 为什么要有这一层（2026-11-11）：
 * 面板原来跑在 pi 主进程里，于是「换个版本看新界面」只能重启整个 pi 会话 ——
 * 用户在终端里、agent 在飞书里，谁都没法替对方按那个重启键。
 * 拆成独立进程后，重启面板 = 杀掉这个进程再拉起，pi 会话一条都不受影响。
 *
 * 三条边界：
 * 1. 本文件**不许 import pi 的任何包**（`@earendil-works/pi-coding-agent`）：它是裸 node 跑的，
 *    一旦引了 pi 就起不来（pi 的能力全在 index.ts 那层胶水里，这里只用 lib 的磁盘实现）；
 * 2. 写操作与 TUI 走同一份实现（`evo.apply.approve` / `evo.setFlag` / `evo.setSettings`），
 *    绝不在 web 层再写一遍「第二套语义」；
 * 3. 生命周期归 `locks/web.json`：写自己的 pid，收到 SIGTERM / SIGINT 就关监听再退出，
 *    这样「换了版本重启」不会留下抢端口的残影。
 */
import * as path from "node:path";
import { createEvolution } from "../evolution.ts";
import { logLine } from "../logfile.ts";
import type { MutationQueue } from "../telemetry.ts";
import { writeWebPid } from "./panel-pid.ts";
import { startWebPanel } from "./server.ts";
import { moveRunToTrash } from "./trash.ts";

/** 父进程通过这个环境变量传参：不写命令行参数，免得 ps 里能看到一堆路径 */
export const WEB_CHILD_ENV = "SKILL_EVOLVE_WEB_CHILD";

export interface WebChildConfig {
  /** 工作区根目录 */
  cwd: string;
  /** 面板端口（父进程已按配置校验过） */
  port: number;
  /** 扩展版本：写进 locks/web.json，父进程据此判断要不要换新 */
  version: string;
  /** 复盘提示词模板的绝对路径 */
  promptTemplate: string;
}

/**
 * 进程内按文件串行化。
 *
 * pi 侧的 `withFileMutationQueue` 也是这个口径（进程内互斥）：两个 pi 窗口同时写 queue.json
 * 本来就没有跨进程锁，这里保持一致，不额外发明一套锁。
 */
function serialQueue(): MutationQueue {
  const chains = new Map<string, Promise<unknown>>();
  return <T>(filePath: string, fn: () => Promise<T>): Promise<T> => {
    const prev = chains.get(filePath) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    chains.set(
      filePath,
      next.catch(() => undefined),
    );
    return next;
  };
}

/** 解析父进程给的环境变量；缺字段时抛出，调用方会把这一行写进 extension.log */
export function parseChildConfig(raw: string | undefined): WebChildConfig {
  if (!raw) throw new Error(`缺少环境变量 ${WEB_CHILD_ENV}`);
  const parsed = JSON.parse(raw) as Partial<WebChildConfig>;
  const { cwd, port, version, promptTemplate } = parsed;
  if (typeof cwd !== "string" || cwd.length === 0) throw new Error("cwd 必须是非空字符串");
  if (!Number.isInteger(port) || (port as number) <= 0) throw new Error(`port 非法：${String(port)}`);
  if (typeof version !== "string" || version.length === 0) throw new Error("version 必须是非空字符串");
  if (typeof promptTemplate !== "string" || promptTemplate.length === 0) throw new Error("promptTemplate 必须是路径");
  return { cwd, port: port as number, version, promptTemplate };
}

/** 起面板并挂好六个写操作；返回关闭函数，供信号处理用 */
export async function runChild(config: WebChildConfig): Promise<{ url: string; close: () => Promise<void> }> {
  const evolutionDir = path.join(config.cwd, ".pi", "evolution");
  const log = (msg: string): void => logLine(evolutionDir, msg);
  const evo = createEvolution({
    cwd: config.cwd,
    promptTemplatePath: config.promptTemplate,
    queue: serialQueue(),
    log,
  });
  const result = await startWebPanel({
    evolutionDir,
    port: config.port,
    keepAlive: true, // 独立进程自己撑住监听：少了这一行 runChild 返回即退出（实测端口只活 100ms）
    onApprove: (runId) => evo.apply.approve(runId, false),
    onReject: (runId) => evo.apply.reject(runId),
    onToggle: (field, next) => evo.setFlag(field, next),
    onRunNow: () => evo.runNow({ sessionId: "web-panel" }),
    onCleanup: (runId) => moveRunToTrash(evolutionDir, runId),
    onSettings: (patch) => evo.setSettings(patch),
  });
  if (!result.ok) throw new Error(`${result.code}：${result.message}`);
  const panel = result.panel;
  writeWebPid(
    evolutionDir,
    { pid: process.pid, host: panel.host, port: panel.port, url: panel.url, startedAt: Date.now(), version: config.version },
    log,
  );
  log(`[skill-evolve] 面板独立进程已起：${panel.url}（pid ${process.pid}，v${config.version}）`);
  return { url: panel.url, close: () => panel.close() };
}

// 直接跑（`node lib/web/child-main.ts`）时才进入进程体；被单测 import 时什么都不做
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const config = parseChildConfig(process.env[WEB_CHILD_ENV]);
  const running = await runChild(config);
  const shutdown = (signal: string): void => {
    void running
      .close()
      .catch(() => undefined)
      .finally(() => {
        logLine(path.join(config.cwd, ".pi", "evolution"), `[skill-evolve] 面板独立进程收到 ${signal}，已退出`);
        process.exit(0);
      });
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}
