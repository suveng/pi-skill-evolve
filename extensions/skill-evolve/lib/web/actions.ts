/**
 * 写操作的唯一入口：参数校验 → 调注入的回调 → 记一条审计。
 *
 * 三条纪律：
 * 1. **不重写业务**：开关 / 派发 / 采纳 / 清理的实现都在 lib 与 index.ts 里，这里只做转发。
 *    网页自己再实现一遍，就会变成「网页点的派发不走去抖、TUI 点的走」这种两套语义；
 * 2. **成功与失败都留痕**：过了 csrf 的每次动作都写一条 actions.log，回调抛错也要写 ——
 *    只记成功的审计等于「出事的时候什么都没有」；
 * 3. **校验口径与 /approve 完全一致**：Content-Type / Host / Origin / 2KB / csrf 五道，
 *    任何一道不过都不执行动作（`/action` 与 `/toggle` 不因为「是新增路径」就少一道）。
 */
import * as fs from "node:fs";
import type * as http from "node:http";
import * as path from "node:path";
import { loadConfig, type ConfigFlag } from "../config.ts";
import { FLAG_FIELDS, parseFlag } from "../flags.ts";
import { appendAudit, type AuditAction, type AuditResult } from "./audit-log.ts";
import { parseRedirectView } from "./filter.ts";
import { parseSettingsForm, type SettingsPatch } from "../settings.ts";
import { FORM_TYPE, MAX_BODY_BYTES, readBody, sendBack, sendText, sourceDenied } from "./http.ts";
import { readJson } from "./json-read.ts";
import { resolveRunDir } from "./run-path.ts";
import { CHILD_LOG } from "../spawn-plan.ts";
import { SUPERVISOR_LOG } from "../review-spawn.ts";
import { readLogTail } from "../stale.ts";

/** `/action` 的 `name` 白名单：三个名字各自对应一个注入回调（开关走独立的 `/toggle?field=`） */
export const ACTION_NAMES = ["run", "rerun", "cleanup"] as const;
export type ActionName = (typeof ACTION_NAMES)[number];

/** 一个写动作：返回给人看的结论（首行进 303 的 msg / err） */
export type WebAction = (runId: string) => Promise<string>;
/** 单个开关：字段名 → /skill-evolve collect / dispatch / review / apply 各切一个；`next` 由这里取反后传入 */
export type ToggleHook = (field: ConfigFlag, next: boolean) => Promise<string>;
/** 立即复盘 / 重跑：都是「触发一次新的复盘」，由 index.ts 接 evo.runNow */
export type RunHook = () => Promise<string>;
/** 配置页保存：由 index.ts 接 evo.setSettings —— 与命令走同一份写入实现（含队列与归一化） */
export type SettingsHook = (patch: SettingsPatch) => Promise<string>;

export interface WriteHooks {
  /** 批准：由扩展注入 evo.apply.approve(runId, false)，与 TUI 同一条路 */
  onApprove?: WebAction;
  /** 拒绝：只改队列与 run.json 状态，不碰任何技能文件 */
  onReject?: WebAction;
  onToggle?: ToggleHook;
  onRunNow?: RunHook;
  /** 清理记录：只对 stale 放行，实现是把 run 目录移进 runs/.trash/ */
  onCleanup?: WebAction;
  /** 配置页保存：六项校验在 web 层，写盘与归一化走 evo.setSettings */
  onSettings?: SettingsHook;
  /** 换成这份：把被更早 pending 顶掉的条目换回来（只动队列，不碰技能文件） */
  onReplace?: WebAction;
}

export interface WriteContext extends WriteHooks {
  evolutionDir: string;
  csrf: string;
  /** 实际监听端口（port=0 时只有监听后才知道）：Host / Origin 校验不接受外部声明 */
  port(): number;
}

const POST_PATHS = new Set(["/approve", "/reject", "/replace", "/action", "/toggle", "/config"]);
/** 与 lib/report.ts 的 renderManualDispatch 首行对齐：能派发才是 ok，其余都是 partial */
const DISPATCHED_PREFIX = "已派生复盘：";
/** `child.log` 优先，其次 `supervisor.log`：前者是子进程自己的输出，会话细节都在里面 */
const LOG_TAIL_LINES = 200;

export function isPostPath(pathname: string): boolean {
  return POST_PATHS.has(pathname);
}

/** 动作失败 / 校验失败时的统一收尾：一句人话 + 一条 error 审计（runId / field 原样入库） */
function reject(
  ctx: WriteContext,
  response: http.ServerResponse,
  action: AuditAction,
  message: string,
  extra: { runId?: string; field?: string } = {},
): void {
  console.error(`[skill-evolve] Web 面板 ${action} 被拒：${message}`);
  appendAudit(ctx.evolutionDir, { at: Date.now(), action, ...extra, result: `error: ${message}`, via: "web" });
  sendText(response, 400, `400：${message}\n`);
}

/** 本实例没注入回调 = 只读面板：403（路径合法，只是没有实现） */
function rejectReadOnly(response: http.ServerResponse): void {
  sendText(response, 403, "403：本实例只读（没注入写回调），不接受写操作\n");
}

function errorText(error: unknown): string {
  const first = String(error).split("\n")[0]!.trim();
  return first.length > 0 ? first.slice(0, 200) : "未知错误";
}

/**
 * 派发类动作的结论：`已派生复盘：<runId>` 才算 ok，其余（总开关关 / 已有复盘在跑 / 去抖窗口里）
 * 都是 partial。这不是抠字眼 —— 审计里 ok 与 partial 混在一起，回头就查不出「点了十次都没派发」。
 */
function dispatchResult(text: string): AuditResult {
  return text.startsWith(DISPATCHED_PREFIX) ? "ok" : "partial";
}

/** 执行 + 记审计 + 303 回跳；回调抛错也回 303（网页不该因为一次动作出错就变成 500 页） */
async function settle(
  ctx: WriteContext,
  response: http.ServerResponse,
  action: AuditAction,
  view: string,
  call: () => Promise<string>,
  extra: { runId?: string; field?: string } = {},
): Promise<void> {
  try {
    const text = await call();
    appendAudit(ctx.evolutionDir, {
      at: Date.now(),
      action,
      ...extra,
      result: action === "run" || action === "rerun" ? dispatchResult(text) : "ok",
      via: "web",
    });
    sendBack(response, "msg", text, view);
  } catch (error) {
    const message = errorText(error);
    console.error(`[skill-evolve] Web 面板 ${action} 失败：${message}`);
    appendAudit(ctx.evolutionDir, { at: Date.now(), action, ...extra, result: `error: ${message}`, via: "web" });
    sendBack(response, "err", message, view);
  }
}

/** run.json 的 status；读不到就是 null —— 当它不是 stale（宁可不让清理，也不误移一个活着的 run） */
function runStatusOf(runDir: string): string | null {
  const raw = readJson<Record<string, unknown>>(path.join(runDir, "run.json"));
  return typeof raw?.status === "string" ? raw.status : null;
}

/**
 * 取 runId 并验目录：白名单 → 必须仍在 runs/ 下 → 必须真实存在。
 * 三道都不过就在这里写一条 error 审计并回 400，调用方拿到 null 直接 return。
 */
function resolveTarget(
  ctx: WriteContext,
  response: http.ServerResponse,
  action: AuditAction,
  form: URLSearchParams,
): { runId: string; runDir: string } | null {
  const runId = (form.get("runId") ?? "").trim();
  if (runId.length === 0) {
    reject(ctx, response, action, "缺少 runId");
    return null;
  }
  const runDir = resolveRunDir(ctx.evolutionDir, runId);
  if (runDir === null) {
    reject(ctx, response, action, "runId 不合法（只允许字母数字与 . _ -）", { runId });
    return null;
  }
  if (!fs.existsSync(runDir)) {
    reject(ctx, response, action, `找不到这个 run：${runId}`, { runId });
    return null;
  }
  return { runId, runDir };
}

/** `POST /action`：三个名字各自校验参数，然后交给对应回调（开关另有 `/toggle`） */
async function handleNamedAction(
  ctx: WriteContext,
  response: http.ServerResponse,
  form: URLSearchParams,
  view: string,
): Promise<void> {
  const raw = (form.get("name") ?? "").trim();
  if (!(ACTION_NAMES as readonly string[]).includes(raw)) {
    sendText(response, 400, `400：name 只认 ${ACTION_NAMES.join(" / ")}\n`);
    return;
  }
  const action = raw as ActionName;
  if (action === "run") {
    const runNow = ctx.onRunNow;
    if (!runNow) return rejectReadOnly(response);
    await settle(ctx, response, action, view, () => runNow());
    return;
  }
  if (action === "rerun") {
    const runNow = ctx.onRunNow;
    if (!runNow) return rejectReadOnly(response);
    const target = resolveTarget(ctx, response, action, form);
    if (target === null) return;
    // 重跑不复用旧 runId：语义是「再派发一次复盘」，新旧两份结果都要留着对比
    await settle(ctx, response, action, view, () => runNow(), { runId: target.runId });
    return;
  }
  const cleanup = ctx.onCleanup;
  if (!cleanup) return rejectReadOnly(response);
  const target = resolveTarget(ctx, response, action, form);
  if (target === null) return;
  const status = runStatusOf(target.runDir);
  if (status !== "stale") {
    reject(ctx, response, action, `只有卡死（stale）的 run 能清理，当前状态：${status ?? "未知"}`, { runId: target.runId });
    return;
  }
  await settle(ctx, response, action, view, () => cleanup(target.runId), { runId: target.runId });
}

/**
 * `POST /toggle?field=telemetry|enabled|autoReview|autoApply`：只翻一个字段。五道校验与 /action 共用，
 * 查询串只决定「翻哪一个」，不影响任何一道校验；四个开关互不联动（要批量切只有命令 on|off）。
 */
async function handleToggleField(
  ctx: WriteContext,
  response: http.ServerResponse,
  form: URLSearchParams,
  url: URL,
): Promise<void> {
  const raw = url.searchParams.get("field");
  const field = parseFlag(raw);
  if (field === null) {
    // 不猜：写错一个字段名绝不能静默改到另一个开关（把复盘当成采集翻，本意完全被丢掉）
    const shown = raw === null ? "空" : raw;
    reject(ctx, response, "toggle", `field 只认 ${FLAG_FIELDS.join(" / ")}（收到 ${shown}）`, raw === null ? {} : { field: raw });
    return;
  }
  const toggle = ctx.onToggle;
  if (!toggle) return rejectReadOnly(response);
  // 取反用的是「读配置」而不是页面上的旧文字：两个标签页开着同一个面板时，页面显示的状态可能已经过期
  const next = !loadConfig(ctx.evolutionDir)[field];
  await settle(ctx, response, "toggle", parseRedirectView(form.get("view")), () => toggle(field, next), { field });
}

/**
 * `POST /config`：配置页一次保存六项。**任何一项不合法就整份拒绝**（见 lib/settings.ts）：
 * 半份生效会让人分不清「我改的那个到底进没进」，下一次再改又是基于这份半成品。
 */
async function handleConfig(
  ctx: WriteContext,
  response: http.ServerResponse,
  form: URLSearchParams,
  view: ReturnType<typeof parseRedirectView>,
): Promise<void> {
  const parsed = parseSettingsForm(form);
  if (!parsed.ok) {
    reject(ctx, response, "config", parsed.error);
    return;
  }
  if (Object.keys(parsed.patch).length === 0) {
    reject(ctx, response, "config", "六项都没有变化（表单是空的）");
    return;
  }
  const save = ctx.onSettings;
  if (!save) return rejectReadOnly(response);
  await settle(ctx, response, "config", view, () => save(parsed.patch));
}

/**
 * POST 总入口。校验顺序与历史一致：路径白名单 → Content-Type → Host/Origin → 体积 → csrf，
 * 之后才看「这个动作有没有实现」。顺序本身就是信息：csrf 不对的请求连 runId 都不该被读。
 */
export async function handlePost(
  ctx: WriteContext,
  request: http.IncomingMessage,
  response: http.ServerResponse,
  url: URL,
): Promise<void> {
  if (!POST_PATHS.has(url.pathname)) {
    response.setHeader("allow", "GET");
    sendText(
      response,
      405,
      "405：面板只提供 GET，写操作只有 /approve、/reject、/replace、/action、/toggle?field= 与 /config\n",
    );
    return;
  }
  const type = String(request.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
  if (type !== FORM_TYPE) {
    sendText(response, 415, `415：Content-Type 必须是 ${FORM_TYPE}\n`);
    return;
  }
  const denied = sourceDenied(request, ctx.port());
  if (denied) {
    sendText(response, 403, `403：${denied}\n`);
    return;
  }
  const body = await readBody(request, MAX_BODY_BYTES);
  if (body === null) {
    sendText(response, 413, `413：请求体超过 ${MAX_BODY_BYTES} 字节\n`);
    return;
  }
  const form = new URLSearchParams(body);
  // csrf 先比：令牌不对就什么都不做，连 name / runId 都不看
  if (form.get("csrf") !== ctx.csrf) {
    sendText(response, 403, "403：csrf 校验失败，本次请求未执行任何动作\n");
    return;
  }
  if (url.pathname === "/toggle") {
    await handleToggleField(ctx, response, form, url);
    return;
  }
  if (url.pathname === "/config") {
    // 保存后回设置页：保存成功/失败的横幅只在这一页有意义
    await handleConfig(ctx, response, form, parseRedirectView(form.get("view")));
    return;
  }
  if (url.pathname === "/action") {
    // 回跳页由表单里的 view 决定：控制条动作用户在哪一页点的，就回哪一页
    await handleNamedAction(ctx, response, form, parseRedirectView(form.get("view")));
    return;
  }
  if (url.pathname === "/replace") {
    const replace = ctx.onReplace;
    if (!replace) return rejectReadOnly(response);
    const runId = (form.get("runId") ?? "").trim();
    if (runId.length === 0) {
      reject(ctx, response, "replace", "缺少 runId");
      return;
    }
    await settle(ctx, response, "replace", "done", () => replace(runId), { runId });
    return;
  }
  const action: AuditAction = url.pathname === "/approve" ? "approve" : "reject";
  const run = action === "approve" ? ctx.onApprove : ctx.onReject;
  if (!run) return rejectReadOnly(response);
  const runId = (form.get("runId") ?? "").trim();
  if (runId.length === 0) {
    // 与 /action 的校验失败同一种收尾：失败也要在审计里留一条
    reject(ctx, response, action, "缺少 runId");
    return;
  }
  await settle(ctx, response, action, "approvals", () => run(runId), { runId });
}

/**
 * `GET /log?runId=`：只读，不做 csrf（没有副作用，也不会改任何状态）。
 * 内容只可能是 run 目录下的两个日志文件之一，且 runId 过了白名单 + 目录归属校验，否则一律 404 ——
 * 404 而不是 403，是因为「这个 run 不存在」与「你想读别人的文件」不该给出可区分的回答。
 */
/** 允许通过 `?file=` 指定读哪份日志：白名单，绝不让外部拼路径 */
export const LOG_FILES = [CHILD_LOG, SUPERVISOR_LOG, "agent-review.log"] as const;

/** 重写日志是动态命名的（agent-rewrite-1.log …），用模式放行，避免把 N 个文件写死进白名单 */
const REWRITE_LOG_PATTERN = /^agent-rewrite-\d+\.log$/;

export function handleLog(evolutionDir: string, response: http.ServerResponse, url: URL): void {
  const runId = (url.searchParams.get("runId") ?? "").trim();
  const runDir = resolveRunDir(evolutionDir, runId);
  if (runDir === null || !fs.existsSync(runDir)) {
    sendText(response, 404, `404：没有这个 run 的日志（runId=${runId}）\n`);
    return;
  }
  // 显式指定 file 时只认白名单里的三份；没指定就沿用旧行为（child.log 优先，退回 supervisor.log）
  const wanted = (url.searchParams.get("file") ?? "").trim();
  const allowed = (LOG_FILES as readonly string[]).includes(wanted) || REWRITE_LOG_PATTERN.test(wanted);
  const named = allowed ? wanted : null;
  if (named !== null) {
    const tail = readLogTail(path.join(runDir, named), LOG_TAIL_LINES);
    if (tail.length === 0) {
      sendText(response, 404, `404：${runId} 的 ${named} 不存在或为空\n`);
      return;
    }
    sendText(response, 200, `# ${runId} · ${named}（末 ${tail.length} 行）\n${tail.join("\n")}\n`);
    return;
  }
  const lines = readLogTail(path.join(runDir, CHILD_LOG), LOG_TAIL_LINES);
  const source = lines.length > 0 ? CHILD_LOG : SUPERVISOR_LOG;
  const tail = lines.length > 0 ? lines : readLogTail(path.join(runDir, SUPERVISOR_LOG), LOG_TAIL_LINES);
  if (tail.length === 0) {
    sendText(response, 404, `404：${runId} 还没有日志（${CHILD_LOG} 与 ${SUPERVISOR_LOG} 都不存在或为空）\n`);
    return;
  }
  // 首行写清这是谁的哪份日志：面板上点「看日志」看到的是纯文本，没有它分不清是子进程还是监督进程
  sendText(response, 200, `# ${runId} · ${source}（末 ${tail.length} 行）\n${tail.join("\n")}\n`);
}
