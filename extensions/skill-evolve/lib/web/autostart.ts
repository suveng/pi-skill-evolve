/**
 * Web 面板的生命周期：跟着 pi 进程走（用户 2026-11-08：「期望是 pi 启动，他也启动，reload 就退出重启」）。
 *
 * 四条边界：
 * 1. **面板是附属物**：自动启动失败只记日志，绝不阻塞会话启动，也不抛给事件回调；
 * 2. **端口占用要分清主人**：`locks/web.json` 里是别的活 pid 就不抢（那是另一个 pi 窗口的面板）；
 *    是本进程 pid 才允许重试 —— `/reload` 不换 pid，旧实例的残影只能这样认出来；
 * 3. **关停要真释放**：`/reload` 先给旧实例发 `session_shutdown`、再给新实例发 `session_start`，
 *    旧实例必须等监听真的关闭，否则新实例第一次 listen 必吃 EADDRINUSE（重试就是兜这一手）；
 * 4. **本文件不 import node:http**：真启动由 index.ts 注入（`startWebPanel`），单测喂假 start 即可，
 *    所以这里一个端口都不占。
 */
import { loadConfig, saveWebConfig, type EvolutionConfig } from "../config.ts";
import type { MutationQueue } from "../telemetry.ts";
import { isAlive, readWebPid } from "./panel-pid.ts";
import type { WebPanel, WebPanelErrorCode, WebPanelResult } from "./server.ts";

/** 首次之外最多重试 3 次；间隔按 reload 实测节奏放大（旧实例关 socket 基本在第一次重试前完成） */
const RETRY_DELAYS_MS: readonly number[] = [300, 600, 900];

/** 自动启动只关心「成没成 + 地址 / 失败码」，面板对象由 WebLifecycle 自己持有 */
export type WebStartResult =
  | { ok: true; url: string }
  | { ok: false; code: WebPanelErrorCode; message: string };

export type WebAutostartResult =
  | { started: true; url: string }
  | {
      started: false;
      /** disabled：配置没开；owned-elsewhere：别的活实例占着；failed：重试到底仍失败 */
      reason: "disabled" | "owned-elsewhere" | "failed";
      /** owned-elsewhere 时是抢手面板的地址 */
      url?: string;
      message?: string;
    };

export interface WebAutostartDeps {
  config: EvolutionConfig;
  evolutionDir: string;
  /** 起监听；端口来自配置（已校验过 1..65535） */
  start(port: number): Promise<WebStartResult>;
  /** 注入 sleep 便于断言重试节奏（真实现是 setTimeout） */
  sleep?(ms: number): Promise<void>;
  log?(msg: string): void;
}

/**
 * 会话启动时的自动起面板。
 *
 * 计时口径：第一次失败后重试 3 次，间隔 300 / 600 / 900ms（即总共最多 4 次 start 调用）。
 * 只有端口占用值得重试：没权限（EACCES）与未知错误重试还是同一个结果，直接判失败。
 */
export async function maybeStartWeb(deps: WebAutostartDeps): Promise<WebAutostartResult> {
  if (deps.config.web.enabled !== true) return { started: false, reason: "disabled" };
  const log = deps.log ?? (() => {});
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const port = deps.config.web.port;
  let message = "";
  for (let retry = 0; ; retry += 1) {
    const result = await deps.start(port);
    if (result.ok) {
      log(`[skill-evolve] web 面板随会话启动：${result.url}`);
      return { started: true, url: result.url };
    }
    message = result.message;
    if (result.code !== "EADDRINUSE") break;
    const owner = readWebPid(deps.evolutionDir);
    // pid 等于本进程 = /reload 后旧实例的残影（进程没换），可以抢；别人的活面板不许抢
    if (owner && owner.pid !== process.pid && isAlive(owner.pid)) {
      log(`[skill-evolve] web 面板由 pid ${owner.pid} 持有（${owner.url}），本实例不抢`);
      return { started: false, reason: "owned-elsewhere", url: owner.url };
    }
    const delay = RETRY_DELAYS_MS[retry];
    if (delay === undefined) break;
    log(`[skill-evolve] web 面板重试 ${retry + 1}/3：端口 ${port} 仍被占用`);
    await sleep(delay);
  }
  log(`[skill-evolve] web 面板未启动（端口 ${port}）：${message}`);
  return { started: false, reason: "failed", message };
}

/** `/skill-evolve web [--port N] [--once]` 的参数：端口由命令层校验，这里只管语义 */
export interface WebLaunchRequest {
  /** 显式端口；不给就用配置里的值 */
  port?: number;
  /** true → 只本次会话有效，不写回配置 */
  once: boolean;
}

export interface WebLifecycleDeps {
  /** 演化目录随会话工作区变（换工作区后配置要读新的那份），所以给 getter */
  evolutionDir(): string;
  /** 真正的启动实现（index.ts 注入 startWebPanel；单测注入假实现，零端口） */
  start(port?: number): Promise<WebPanelResult>;
  queue: MutationQueue;
  log(msg: string): void;
}

export interface WebLifecycle {
  /** `session_start`：配置开着就起，任何失败只记日志 */
  startForSession(): Promise<void>;
  /** 命令路径：起面板，非 `--once` 时把 web.enabled 写回配置 */
  command(request: WebLaunchRequest): Promise<string>;
  /** `session_shutdown`：等监听真的关闭（reason 只进日志，用于自证是哪条路走的） */
  shutdown(reason: string): Promise<void>;
  /** `/skill-evolve off`：关面板 + 写 web.enabled=false */
  disable(): Promise<string>;
  /** 当前面板地址；没跑就是 undefined（命令与 status 用） */
  url(): string | undefined;
}

/** 面板单例 + 起停 + 配置写回：一个会话（一个扩展实例）只该有一个面板 */
export function createWebLifecycle(deps: WebLifecycleDeps): WebLifecycle {
  let panel: WebPanel | null = null;

  /** 自动启动的入口：成功时顺手把面板记成单例，shutdown 才有东西可关 */
  const launch = async (port: number): Promise<WebStartResult> => {
    const result = await deps.start(port);
    if (!result.ok) return result;
    panel = result.panel;
    return { ok: true, url: result.panel.url };
  };

  const startForSession = async (): Promise<void> => {
    // 单例：同一实例重复 session_start（new / resume / fork）不重复起
    if (panel) return;
    try {
      const evolutionDir = deps.evolutionDir();
      await maybeStartWeb({ config: loadConfig(evolutionDir, deps.log), evolutionDir, start: launch, log: deps.log });
    } catch (error) {
      // 自动起是锦上添花：异常只记日志，绝不冒到会话启动
      deps.log(`[skill-evolve] web 面板自动启动异常：${String(error)}`);
    }
  };

  const command = async (request: WebLaunchRequest): Promise<string> => {
    if (panel) return `面板已在 ${panel.url} 运行`;
    const result = await deps.start(request.port);
    if (!result.ok) return result.message;
    panel = result.panel;
    const url = panel.url;
    const boundary = "只绑 127.0.0.1（无鉴权，别转发到公网）；待审批页 ?view=approvals 可直接批；机器可读副本 /api/state";
    if (request.once) return `面板已起：${url}（--once：只本次会话有效，没写进配置）\n${boundary}`;
    try {
      // 端口一起写：下次自动起必须落在同一个地址，否则「pi 启动时会自动起」就是句空话
      await saveWebConfig(deps.evolutionDir(), { enabled: true, port: panel.port }, deps.queue);
    } catch (error) {
      return `面板已起：${url}（写配置失败，下次 pi 启动不会自动起：${String(error)}）\n${boundary}`;
    }
    return `面板已起：${url}（已在配置里开启，pi 启动时会自动起；换端口 --port 7799）\n${boundary}`;
  };

  const shutdown = async (reason: string): Promise<void> => {
    const current = panel;
    panel = null;
    if (!current) return;
    try {
      // close() 内含 server.closeAsync 语义：回调返回时监听已释放，端口可被立刻重新 listen
      await current.close();
      deps.log(`[skill-evolve] web 面板关闭（reason=${reason}）`);
    } catch (error) {
      deps.log(`[skill-evolve] web 面板关闭失败（reason=${reason}）：${String(error)}`);
    }
  };

  const disable = async (): Promise<string> => {
    await shutdown("off");
    try {
      await saveWebConfig(deps.evolutionDir(), { enabled: false }, deps.queue);
    } catch (error) {
      return `Web 面板已关，但写 web.enabled=false 失败：${String(error)}`;
    }
    return "Web 面板已关，配置已写 web.enabled=false（下次 pi 启动不再自动起；重开：/skill-evolve web）";
  };

  return { startForSession, command, shutdown, disable, url: () => panel?.url };
}
