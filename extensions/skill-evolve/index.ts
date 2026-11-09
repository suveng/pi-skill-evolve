/**
 * 技能进化扩展（M1：采集曝光/加载 → 派生复盘 → 报告）
 *
 * 这一层只做胶水：把 pi 事件拆成原始值交给 lib/，逻辑与门禁都在 lib/ 里（`node --test` 能直接跑 lib）。
 * 命令：/skill-evolve status | report [天数] | run | baseline | approve <runId> | queue | selftest | config | on | off；
 *       /skill-audit [天数]（机械审计）
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType, loadSkillsFromDir, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { matchSubcommand, runCommand } from "./lib/command.js";
import { loadConfig } from "./lib/config.js";
import { runConfigCommand } from "./lib/config-command.js";
import { createEvolution, type Evolution } from "./lib/evolution.js";
import { logLine } from "./lib/logfile.js";
import { deliverNotifications } from "./lib/notify.js";
import { entryLines, type PanelEntry, type PanelState } from "./lib/panel.js";
import { renderRecovery } from "./lib/recover.js";
import { renderPanel, writeEntry, type UiPanelHost } from "./lib/ui-gate.js";
import { startWebPanel } from "./lib/web/server.js";
import { createWebLifecycle } from "./lib/web/autostart.js";
import { moveRunToTrash } from "./lib/web/trash.js";

const PROMPT_TEMPLATE = path.join(path.dirname(fileURLToPath(import.meta.url)), "prompts", "复盘.md");
export default function skillEvolve(pi: ExtensionAPI): void {
  // 递归防护，必须第一行生效：复盘子进程（SKILL_EVOLVE_CHILD=1）会加载同一套扩展，少了它就「复盘里再派生复盘」
  if (process.env.SKILL_EVOLVE_CHILD) return;

  // 主会话当前模型：模型配置写 inherit 时评审沿用它。每个 handler 开头刷新，取不到就留 undefined
  let hostModel: { provider?: string; id?: string } | undefined;
  const rememberModel = (ctx: ExtensionContext): void => {
    try {
      const model = ctx.model;
      hostModel = model ? { provider: model.provider, id: model.id } : undefined;
    } catch {
      hostModel = undefined;
    }
  };

  /** 面板最后一格用到 ctx（setWidget / setStatus），事件回调没有 ctx 就靠这份引用 */
  let lastCtx: ExtensionContext | null = null;
  /** 当前工作区：诊断日志要落到这个工作区的 `.pi/evolution/logs/` 下 */
  let lastCwd = "";

  /** 演化目录：配置、日志、runs 都在这儿，路径解析只此一处 */
  const evolutionDirOf = (cwd: string): string => path.join(cwd, ".pi", "evolution");

  /** 诊断输出一律落盘；`PI_SKILL_EVOLVE_DEBUG=1` 才回显终端（TUI 默认零推送） */
  const note = (msg: string): void => logLine(evolutionDirOf(lastCwd), msg);

  /** TUI 开关每次现读 config.json：手改或 on/off 立刻生效，且不在扩展装载期做 I/O */
  const uiFlags = () => loadConfig(evolutionDirOf(lastCwd)).ui;

  /** 面板刷新：widget 只有有数据时才挂，状态栏只放最紧急的一件；无 UI / 开关关着都直接跳过 */
  const paint = (state: PanelState): void => {
    const ctx = lastCtx;
    if (!ctx || !ctx.hasUI) return;
    try {
      renderPanel(ctx.ui as unknown as UiPanelHost, uiFlags(), state);
    } catch (error) {
      note(`[skill-evolve] 面板刷新失败：${String(error)}`);
    }
  };

  let evolution: Evolution | null = null;
  const instance = (cwd: string): Evolution =>
    (evolution ??= createEvolution({
      cwd,
      promptTemplatePath: PROMPT_TEMPLATE,
      queue: withFileMutationQueue,
      // 技能发现交给 pi：它是唯一知道「哪些技能真被系统看见」的来源；失败时 mechanical 会降级而不是抛
      loadSkills: () => loadSkillsFromDir({ dir: path.join(cwd, ".pi", "skills"), source: "project" }),
      hostModel: () => hostModel,
      // /tree 条目：custom entry 不参与 LLM 上下文，只是会话回看用的可追溯记录
      panel: {
        onEntry: (entry) => {
          try {
            // `/tree` 条目受 ui.entries 开关控制：默认一律不写，会话区不留碎片
            writeEntry(uiFlags(), (item: PanelEntry) => pi.appendEntry<PanelEntry>("skill-evolve", item), entry);
          } catch (error) {
            note(`[skill-evolve] 写会话条目失败：${String(error)}`);
          }
        },
        onState: paint,
      },
    }));

  /** Web 面板的生命周期（单例 / 随会话起停 / 配置写回）都在 lib/web/autostart.ts 里 */
  const web = createWebLifecycle({
    evolutionDir: () => evolutionDirOf(lastCwd),
    log: note,
    queue: withFileMutationQueue,
    // 所有写操作都调与 TUI 完全相同的实现，web 层只做校验与转发（自己再写一遍就有两套语义）
    start: (port) => {
      const cwd = lastCwd;
      const evo = instance(cwd);
      return startWebPanel({
        evolutionDir: evolutionDirOf(cwd),
        ...(port === undefined ? {} : { port }),
        onApprove: (runId) => evo.apply.approve(runId, false),
        onReject: (runId) => evo.apply.reject(runId),
        onToggle: (field, next) => evo.setFlag(field, next), // 四个开关各自一个入口，网页点哪个只切哪个
        // 会话文件为空是允许的：派发时按「没有索引」处理，不会因为从网页点就少走一道
        onRunNow: () => evo.runNow({ sessionId: "web-panel" }),
        onCleanup: async (runId) => moveRunToTrash(evolutionDirOf(cwd), runId),
      });
    },
  });

  /** 三类事件（卡死 / 待批 / 自动采纳）写进会话：飞书进来的用户没有 TUI，只有会话消息看得见；
   * 同一 run 的同一类只发一次（判据 runs/<runId>/notified.json），发不出去也只写日志 */
  const notifyEvents = (cwd: string): void => {
    try {
      const send =
        typeof pi.sendMessage === "function"
          ? (text: string): void => {
              // CustomMessage 不触发新回合：通知不能换来一整轮 agent 运行
              pi.sendMessage({ customType: "skill-evolve-notice", content: text, display: true });
            }
          : undefined;
      deliverNotifications({
        evolutionDir: path.join(cwd, ".pi", "evolution"),
        ...(send ? { send } : {}),
        // 日志同样只落盘：送达失败不该在对话区刷红字
        log: (message) => logLine(evolutionDirOf(cwd), message),
      });
    } catch (error) {
      logLine(path.join(cwd, ".pi", "evolution"), `[skill-evolve] 会话送达失败：${String(error)}`);
    }
  };

  /** 本轮声明的工具名：类 E（没有读工具）的唯一判据，取不到就返回空（空 = 不知道，不判 E） */
  const activeTools = (): string[] => {
    try {
      return pi.getActiveTools();
    } catch {
      return [];
    }
  };

  /** 会话 ID 拿不到时退化成进程标识：遥测里宁可少一个维度，也不能让整条链路断掉 */
  const sessionId = (ctx: ExtensionContext): string => {
    try {
      return ctx.sessionManager.getSessionId();
    } catch {
      return `pid-${process.pid}`;
    }
  };

  /** 缺会话文件时降级为 telemetry-only，而不是让派发整条失败 */
  const sessionFileOf = (ctx: ExtensionContext): string | undefined => {
    try {
      return ctx.sessionManager.getSessionFile();
    } catch {
      return undefined;
    }
  };

  /** 事件处理器的唯一入口：任何异常都吞在这里，绝不 rethrow 到用户正在跑的回合 */
  const guarded = (ctx: ExtensionContext, where: string, run: (evo: Evolution) => void): void => {
    let current: Evolution | null = null;
    try {
      rememberModel(ctx);
      lastCtx = ctx;
      lastCwd = ctx.cwd;
      current = instance(ctx.cwd);
      run(current);
    } catch (error) {
      note(`[skill-evolve] ${where} 处理失败：${String(error)}`);
      try {
        current?.recordHandlerError(where, error);
      } catch {
        // 连采集器都写不进去：到此为止
      }
    }
  };

  pi.on("before_agent_start", (event, ctx) => {
    guarded(ctx, "before_agent_start", (evo) => {
      // prompt 只在 messageType==="user" 的变体上存在；自定义消息没有正文，记空串即可
      const prompt = event.messageType === "user" && typeof event.prompt === "string" ? event.prompt : "";
      evo.recordAdvertised({
        sessionId: sessionId(ctx),
        cwd: ctx.cwd,
        prompt,
        activeTools: activeTools(),
        skills: (event.systemPromptOptions.skills ?? []).map((skill) => ({
          name: skill.name,
          // 嵌入式/自定义来源可能没有 filePath，用空串占位而不是让整条记录丢掉
          filePath: skill.filePath ?? "",
          disabled: Boolean(skill.disableModelInvocation),
          source: skill.sourceInfo?.source ?? "unknown",
        })),
      });
    });
  });

  pi.on("tool_call", (event, ctx) => {
    guarded(ctx, "tool_call", (evo) => {
      const id = sessionId(ctx);
      if (isToolCallEventType("read", event)) {
        evo.noteToolCall({ sessionId: id, toolCallId: event.toolCallId, toolName: "read", input: { path: event.input.path } });
      } else if (isToolCallEventType("bash", event)) {
        evo.noteToolCall({ sessionId: id, toolCallId: event.toolCallId, toolName: "bash", input: { command: event.input.command } });
      }
    });
  });

  pi.on("tool_result", (event, ctx) => {
    guarded(ctx, "tool_result", (evo) => {
      evo.resolveToolResult({ sessionId: sessionId(ctx), toolCallId: event.toolCallId, isError: event.isError });
    });
  });

  pi.on("agent_settled", (_event, ctx) => {
    guarded(ctx, "agent_settled", (evo) => {
      evo.settle({ sessionId: sessionId(ctx), sessionFile: sessionFileOf(ctx) });
      // 评审督导可能刚写完结论：这里刷新一次，面板与 /tree 条目都跟上
      evo.observe.refresh();
      // 卡死 / 待批 / 自动采纳要主动送到会话里：没有 TUI 的用户只有会话消息看得见
      notifyEvents(ctx.cwd);
    });
  });

  // 退出前补发 + 遥测刷盘都在 shutdown() 里同步做完；Web 面板必须先关并等监听真正释放 ——
  // `/reload` 走的也是这条：旧实例不放开端口，新实例的 session_start 就起不来
  pi.on("session_shutdown", async (event, ctx) => {
    await web.shutdown(event.reason);
    guarded(ctx, "session_shutdown", (evo) => evo.shutdown());
  });

  // 会话起点：闸0 快照（.pi/skills 的 git 摘要）+ 备份清理 + 扫「待采纳」队列（上次没应用完的接着来）
  pi.on("session_start", async (_event, ctx) => {
    guarded(ctx, "session_start", (evo) => {
      evo.apply.sessionStart();
      // `/reload` 与重启会丢掉内存里的收尸逻辑：这里补状态、重挂被带走的督导（不重跑复盘）
      void evo.recover().then((actions) => {
        if (actions.length > 0) {
          // 通知只有一行：把多行恢复报告压成 ` / ` 分隔
          const brief = renderRecovery(actions).replace(/\n\s*/g, " / ");
          ctx.ui.notify(brief, "info");
        }
        evo.observe.refresh();
      });
      evo.observe.refresh();
      // 上一轮没送出去的失败/待批，这里补发（notified.json 保证不重复）
      notifyEvents(ctx.cwd);
    });
    // 面板随会话起（配置里 web.enabled 才起）：必须放在 guarded 之后 —— lastCwd 由它置位
    await web.startForSession();
  });

  // /tree 里渲染本扩展的条目：Component 只要求 render(width) => string[]，不引 pi-tui 包
  pi.registerEntryRenderer<PanelEntry>("skill-evolve", (entry) => ({ render: () => entryLines(entry.data) }));

  pi.registerCommand("skill-evolve", {
    description:
      "技能进化：status 状态 / report 近 7 天报告（--week 周报） / run 立即复盘 / baseline 接受存量 P0 / audit 机械审计 / approve 采纳某条 run / queue 采纳队列 / web 网页面板（--port N 换端口，--once 不写配置） / selftest 评审必红自检 / config 选模型 / collect 只开采集遥测（不花 token） / dispatch 只开自动复盘（花 token） / review 只开自动评审（提案后再起督导，再花一份 token） / apply 只开自动采纳（auto 提案自动落盘） / on 复盘+评审两开（不动采集与采纳） / off 四个全关",
    getArgumentCompletions: (prefix) => matchSubcommand(prefix),
    handler: async (args, ctx) => {
      try {
        // 命令路径不走 guarded，也要把 ctx 交给面板：approve 之后要刷 widget / status
        lastCtx = ctx;
        lastCwd = ctx.cwd;
        const target = {
          sessionId: sessionId(ctx),
          sessionFile: sessionFileOf(ctx),
          // 面板单例由 lib/web/autostart.ts 持有：重复执行只回一句「已在 … 运行」
          web: (request) => web.command(request),
        };
        const evo = instance(ctx.cwd);
        const [name, arg] = args.trim().split(/\s+/);
        if (name === "config") {
          // 非 TUI 模式没有 select：把 host 传 null，runConfigCommand 会退化成打印当前值
          const models = ctx.hasUI ? ctx.modelRegistry.getAvailable().map((m) => ({ provider: m.provider, id: m.id })) : [];
          const host = ctx.hasUI ? { models, select: (title: string, options: string[]) => ctx.ui.select(title, options) } : null;
          ctx.ui.notify(await runConfigCommand(host, evo.model, arg), "info");
          return;
        }
        const text = await runCommand(args, evo, target);
        // `off` 连面板一起关，并把 web.enabled 写回 false（与「两键同关」同一口径；on 不管面板）
        const merged = name === "off" ? `${text}\n${await web.disable()}` : text;
        // 采纳 / 回滚会改队列与 run 状态：命令类操作之后立刻刷新面板
        if (name === "approve") {
          evo.observe.refresh();
          notifyEvents(ctx.cwd);
        }
        ctx.ui.notify(merged, "info");
      } catch (error) {
        note(`[skill-evolve] 命令执行失败：${String(error)}`);
        ctx.ui.notify(`技能进化命令失败：${String(error)}`, "error");
      }
    },
  });

  // 机械审计与 /skill-evolve report 分开口：report 讲「发生了什么」，audit 讲「归到了哪一类」
  pi.registerCommand("skill-audit", {
    description: "技能机械审计：A~E 类别汇总 / 未命中 top / 硬禁令 P0（默认近 7 天）",
    handler: async (args, ctx) => {
      try {
        const days = Number.parseInt(args.trim(), 10);
        ctx.ui.notify(await instance(ctx.cwd).auditText(Number.isFinite(days) && days > 0 ? days : 7), "info");
      } catch (error) {
        note(`[skill-evolve] 审计命令失败：${String(error)}`);
        ctx.ui.notify(`技能审计失败：${String(error)}`, "error");
      }
    },
  });
}
