/**
 * Web 面板的 HTTP 外壳（`/skill-evolve web` 的落地实现）。
 *
 * 六条硬边界：
 * 1. **只绑 127.0.0.1 且不做鉴权**：面板能看到会话摘要与技能 diff，凭据换不来安全，绑地址才是；
 * 2. **写操作只有五个入口**：`POST /approve`、`POST /reject`、`POST /action`、`POST /toggle?field=`、`POST /config`，
 *    其余路径一律 405；
 *    GET 路由是白名单（`/`、`/api/state`、`/log`、`/diff`），绝不把 runs/ 当静态文件服务 ——
 *    那等于把 `.pi/evolution` 整个暴露成文件下载器（`/log` 只回两个日志文件的末 200 行、
 *    `/diff` 只回一个 run 的 02-proposal.diff，且 runId 都过了白名单 + 目录校验）；
 * 3. **写操作的会话保护**：启动时生成 csrf 嵌进表单，POST 必须带对；Host / Origin 只认本机当前端口。
 *    面板是「本机同一个浏览器点按钮」用的，任何跨站请求都该被拒在门外；
 * 4. **web 层不写盘**：开关 / 派发 / 采纳 / 清理都是 `index.ts` 注入的回调，走与 TUI 完全相同的路径；
 *    本层唯一自己做的写入是审计日志（见 ./audit-log.ts）—— 那是「谁点了什么」的旁证，不属于业务；
 * 5. **端口占用是常态不是异常**：`EADDRINUSE` 返回结构化结果让命令回一句人话，不把栈甩进会话；
 * 6. **不阻止进程退出**：`unref()` + 幂等 `close()`，面板是附属物，pi 退出时不能因为它挂住。
 */
import * as crypto from "node:crypto";
import * as http from "node:http";
import { handleLog, handlePost, type WriteContext, type WriteHooks } from "./actions.ts";
import { collectControls } from "./activity.ts";
import { readAudit } from "./audit-log.ts";
import { collectWebState } from "./data.ts";
import { parseListQuery, parsePanelView } from "./filter.ts";
import { parseListExtras } from "./list-query.ts";
import { HTML_TYPE, MAX_BODY_BYTES, TEXT_TYPE, sendText } from "./http.ts";
import { clearWebPid, isAlive, readWebPid, writeWebPid } from "./panel-pid.ts";
import { renderPage } from "./render.ts";
import { renderSettingsPage } from "./render-settings.ts";
import { readSettings } from "../settings.ts";
import { renderRunPage } from "./render-run.ts";
import { renderSessionPage } from "./render-session.ts";
import { renderSkillPage, renderSkillsPage } from "./render-skills.ts";
import { handleDiff, readRunDetail } from "./run-detail.ts";
import { readSessionSource } from "./session-file.ts";
import { parseDays, readSkillDetail, readSkills } from "./skills.ts";

/** 默认端口：7788 是面板约定值（TUI 提示与文档里都写这个），改它得同时改文档 */
export const DEFAULT_WEB_PORT = 7788;
export const DEFAULT_WEB_HOST = "127.0.0.1";

export { MAX_BODY_BYTES };
export type { WebAction, ToggleHook, RunHook } from "./actions.ts";

export interface WebPanelOptions extends WriteHooks {
  evolutionDir: string;
  port?: number;
  host?: string;
  /** CSRF 令牌：不给就启动时随机生成；单测注入固定值便于构造合法请求 */
  csrf?: string;
}

export interface WebPanel {
  url: string;
  host: string;
  port: number;
  /** 本实例的表单令牌：同一个面板单例复用同一个值（index.ts 单例打开） */
  csrf: string;
  /** 幂等：重复调用都返回同一已完成状态，不抛 ERR_SERVER_NOT_RUNNING */
  close(): Promise<void>;
}

export type WebPanelErrorCode = "EADDRINUSE" | "EACCES" | "UNKNOWN";

export type WebPanelResult =
  | { ok: true; panel: WebPanel }
  | { ok: false; code: WebPanelErrorCode; message: string };

/** 「最近操作」显示几条：10 条够看出刚才谁点了什么，再多就要翻日志了 */
const RECENT_ACTIONS = 10;

/** 路由层的上下文就是写操作上下文：读写共用一份（evolutionDir / csrf / 回调 / 端口） */
type RouteContext = WriteContext;

/** 一个 GET 的完整应答：详情页的 404 要带状态码，不能只用返回字符串 */
interface GetResult {
  status: number;
  body: string;
  type: string;
}

/**
 * 读盘渲染：控制条、最近操作、筛选都在这里一次性读好传给渲染层（渲染层不碰磁盘）。
 *
 * 四类页面：`?view=run&runId=`（run 详情）/ `?view=session&sessionId=`（会话详情）/ `?view=skills`（技能管理）/ `?view=skill&name=`（技能详情）/ 五个列表页。
 * 详情页的 runId 不合法或目录不存在一律 404 —— 靠 resolveRunDir 的目录校验，不靠字符串过滤。
 * 会话页不走 404：会话文件可能已不在本机，那种情况页面要说人话（见 render-session.ts）。
 */
function renderGet(ctx: RouteContext, url: URL): GetResult {
  const err = url.searchParams.get("err");
  const msg = url.searchParams.get("msg");
  const notice = err !== null ? { kind: "err" as const, text: err } : msg !== null ? { kind: "msg" as const, text: msg } : null;
  const controls = collectControls(ctx.evolutionDir);
  const state = collectWebState({ evolutionDir: ctx.evolutionDir });
  const view = parsePanelView(url.searchParams.get("view"));
  const days = parseDays(url.searchParams.get("days"));
  if (view === "session") {
    const sessionId = url.searchParams.get("sessionId") ?? "";
    const source = readSessionSource({
      evolutionDir: ctx.evolutionDir,
      sessionId,
      ...(url.searchParams.get("file") !== null ? { file: url.searchParams.get("file") } : {}),
    });
    // `only=user` 在服务端过滤（面板零 JS）：列表只渲染用户消息与助手纯文本，工具调用压成一行
    return {
      status: 200,
      body: renderSessionPage(source, { state, onlyUser: url.searchParams.get("only") === "user" }),
      type: HTML_TYPE,
    };
  }
  if (view === "run") {
    const runId = url.searchParams.get("runId") ?? "";
    const detail = readRunDetail(ctx.evolutionDir, runId);
    if (!detail) return { status: 404, body: `404：没有这个 run（runId=${runId}）\n`, type: TEXT_TYPE };
    return {
      status: 200,
      body: renderRunPage(detail, {
        state,
        // 「等面板批准」的 run 在详情页就能点批准：判据与按钮都在 render-run.ts 里
        ...(writable(ctx) ? { write: { csrf: ctx.csrf } } : {}),
      }),
      type: HTML_TYPE,
    };
  }
  if (view === "settings") {
    return {
      status: 200,
      body: renderSettingsPage(readSettings(ctx.evolutionDir), state, {
        csrf: ctx.csrf,
        canWrite: writable(ctx) && Boolean(ctx.onSettings),
        notice,
      }),
      type: HTML_TYPE,
    };
  }
  if (view === "skills") {
    const skills = readSkills(ctx.evolutionDir, { days, telemetryOn: controls.telemetry });
    return {
      status: 200,
      body: renderSkillsPage(skills, state, { csrf: ctx.csrf, canWrite: writable(ctx), controls }),
      type: HTML_TYPE,
    };
  }
  if (view === "skill") {
    const name = url.searchParams.get("name") ?? "";
    // 没给技能名就当点了「技能管理」：一个空名字的详情页没有任何信息可看
    if (name.length === 0) {
      const skills = readSkills(ctx.evolutionDir, { days, telemetryOn: controls.telemetry });
      return {
        status: 200,
        body: renderSkillsPage(skills, state, { csrf: ctx.csrf, canWrite: writable(ctx), controls }),
        type: HTML_TYPE,
      };
    }
    const detail = readSkillDetail(ctx.evolutionDir, name, { days, telemetryOn: controls.telemetry });
    return { status: 200, body: renderSkillPage(detail, state), type: HTML_TYPE };
  }
  return {
    status: 200,
    body: renderPage(state, view, {
      csrf: ctx.csrf,
      // 一对审批动作要么都能点、要么都不显示：只显示一个会让人以为另一半也能用
      canWrite: writable(ctx),
      notice,
      controls,
      audit: readAudit(ctx.evolutionDir, RECENT_ACTIONS),
      filter: parseListQuery(url.searchParams),
      // 三个显式开关（自动刷新 / 分组展开 / 只看对话的前两个）：`live` 按页面白名单放行，仅待处理页生效
      extras: parseListExtras(url.searchParams, view),
    }),
    type: HTML_TYPE,
  };
}

/** 面板是否可写：审批回调成对注入才算（历史口径，保持这一条，别按单个动作判断） */
function writable(ctx: RouteContext): boolean {
  return Boolean(ctx.onApprove && ctx.onReject);
}

/** 路由白名单：任何不在表里的路径都是 404，不拼磁盘路径 */
function route(ctx: RouteContext, request: http.IncomingMessage, response: http.ServerResponse): void {
  const method = (request.method ?? "GET").toUpperCase();
  // 用固定 base 解析：req.url 是相对路径，直接 new URL 会抛
  let url: URL;
  try {
    url = new URL(request.url ?? "/", `http://${DEFAULT_WEB_HOST}`);
  } catch {
    sendText(response, 400, "400：请求路径解析失败\n");
    return;
  }
  if (method === "POST") {
    // 405 / 415 / 403 等各道校验都在 handlePost 里，这里只负责别把拒绝变成未捕获异常
    void handlePost(ctx, request, response, url).catch((error: unknown) => {
      console.error(`[skill-evolve] Web 面板写操作处理失败：${String(error)}`);
      if (!response.headersSent) sendText(response, 500, "500：写操作处理失败，详见 pi 日志\n");
      else response.end();
    });
    return;
  }
  if (method !== "GET") {
    response.setHeader("allow", "GET");
    sendText(response, 405, "405：面板只接受 GET 与 /approve、/reject、/action、/toggle 的 POST\n");
    return;
  }
  if (url.pathname === "/") {
    const result = renderGet(ctx, url);
    sendText(response, result.status, result.body, result.type);
    return;
  }
  if (url.pathname === "/api/state") {
    sendText(response, 200, `${JSON.stringify(collectWebState({ evolutionDir: ctx.evolutionDir }), null, 2)}\n`, "application/json; charset=utf-8");
    return;
  }
  if (url.pathname === "/log") {
    handleLog(ctx.evolutionDir, response, url);
    return;
  }
  if (url.pathname === "/diff") {
    handleDiff(ctx.evolutionDir, response, url);
    return;
  }
  sendText(response, 404, `404：没有 ${url.pathname}（只提供 /、/api/state、/log 与 /diff）\n`);
}

function describeFailure(
  code: WebPanelErrorCode,
  host: string,
  port: number,
  detail: string,
  evolutionDir: string,
): string {
  if (code === "EADDRINUSE") {
    // 先判读「占端口的是不是本机面板」：命中就给地址与 pid；看不出来才提醒别乱 kill
    const record = readWebPid(evolutionDir);
    if (record && isAlive(record.pid)) {
      return `Web 面板已在 ${record.url} 运行（pid ${record.pid}，起于 ${new Date(record.startedAt).toISOString()}）。要换端口：/skill-evolve web --port 7799`;
    }
    return `Web 面板没起来：${host}:${port} 已被占用（多半是已经有一个面板在跑）。换端口：/skill-evolve web --port 7799（不是本机面板记录的 pid，可能是别的服务；不要直接 kill，先 lsof -nP -iTCP:${port} -sTCP:LISTEN 看 COMMAND）`;
  }
  if (code === "EACCES") return `Web 面板没起来：没有权限监听 ${host}:${port}（换一个 >1024 的端口）`;
  return `Web 面板没起来：${detail}`;
}

export function startWebPanel(options: WebPanelOptions): Promise<WebPanelResult> {
  const port = options.port ?? DEFAULT_WEB_PORT;
  const host = options.host ?? DEFAULT_WEB_HOST;
  // 每次启动新令牌：面板重启后旧页面的表单立刻失效（旧页面本来就点不动了）
  const csrf = options.csrf ?? crypto.randomUUID();
  let actualPort = port;
  const ctx: RouteContext = {
    evolutionDir: options.evolutionDir,
    csrf,
    ...(options.onApprove ? { onApprove: options.onApprove } : {}),
    ...(options.onReject ? { onReject: options.onReject } : {}),
    ...(options.onToggle ? { onToggle: options.onToggle } : {}),
    ...(options.onRunNow ? { onRunNow: options.onRunNow } : {}),
    ...(options.onCleanup ? { onCleanup: options.onCleanup } : {}),
    ...(options.onSettings ? { onSettings: options.onSettings } : {}),
    port: () => actualPort,
  };
  const server = http.createServer((request, response) => {
    try {
      route(ctx, request, response);
    } catch (error) {
      // 读盘炸了也只回一句：网页永远不该把栈吐给用户，日志里有原文
      console.error(`[skill-evolve] Web 面板渲染失败：${String(error)}`);
      if (!response.headersSent) sendText(response, 500, "500：读 .pi/evolution 出错，详见 pi 日志\n");
      else response.end();
    }
  });

  return new Promise<WebPanelResult>((resolve) => {
    let settled = false;
    const onError = (error: NodeJS.ErrnoException): void => {
      if (settled) return;
      settled = true;
      server.removeListener("listening", onListening);
      const code: WebPanelErrorCode =
        error.code === "EADDRINUSE" ? "EADDRINUSE" : error.code === "EACCES" ? "EACCES" : "UNKNOWN";
      resolve({ ok: false, code, message: describeFailure(code, host, port, error.message, options.evolutionDir) });
    };
    const onListening = (): void => {
      if (settled) return;
      settled = true;
      server.removeListener("error", onError);
      // 起监听之后再出错（客户端重置等）只记日志：不能让它变成未捕获异常
      server.on("error", (error) => console.error(`[skill-evolve] Web 面板运行时错误：${String(error)}`));
      // 面板是附属物：pi 退出时不该被它挂着
      server.unref();
      const address = server.address();
      actualPort = address && typeof address === "object" ? address.port : port;
      const url = `http://${host}:${actualPort}`;
      // 落盘「谁持有面板」：端口被占时命令能分清是本机面板还是别的服务（见 ./panel-pid.ts）
      writeWebPid(options.evolutionDir, { pid: process.pid, host, port: actualPort, url, startedAt: Date.now() });
      let closed = false;
      const close = async (): Promise<void> => {
        if (closed) return;
        closed = true;
        server.closeAllConnections();
        await new Promise<void>((done) => server.close(() => done()));
        // 只删自己写的记录：文件里是别的 pid 就留着，别替另一个实例抹掉活面板
        clearWebPid(options.evolutionDir, process.pid);
      };
      resolve({ ok: true, panel: { url, host, port: actualPort, csrf, close } });
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}
