/**
 * 主会话里的采集与门禁：曝光 / 加载 / 未命中 / 去抖派生 + 命令文本。
 *
 * 这一层刻意不 import pi 的任何东西：事件字段由 index.ts 拆成原始值再传进来，
 * 这样门禁逻辑能被 node --test 直接跑，不依赖 `@earendil-works/pi-coding-agent` 的可解析性。
 */
import * as path from "node:path";
import { configFile, loadConfig, saveConfigSwitch, saveFlag, saveSettings, type ConfigFlag, type EvolutionConfig } from "./config.ts";
import type { SettingsPatch } from "./settings.ts";
import type { Attribution } from "./attribution.ts";
import { baselinePath, createBaselineGate } from "./baseline.ts";
import { isChildProcess } from "./child-env.ts";
import type { ApplyDeps } from "./apply.ts";
import { createDispatcher } from "./dispatch.ts";
import { createApplyTools, type ApplyTools } from "./evolution-apply.ts";
import { createModelTools, type ModelTools } from "./evolution-model.ts";
import { createObserver, type Observer, type PanelDeps } from "./evolution-observe.ts";
import { recoverRuns, type RecoveryAction } from "./recover.ts";
import { createViews } from "./evolution-views.ts";
import { flagStateText, FLAG_LABEL } from "./flags.ts";
import type { GitRunner } from "./gate0.ts";
import { logLine } from "./logfile.ts";
import { createMechanicalReporter } from "./mechanical-report.ts";
import { createMechanical, type RawDiagnostic, type SnapshotSkill } from "./mechanical.ts";
import { createCommitRunner, createGitRunner, createMdCheckRunner } from "./proc.ts";
import { renderManualDispatch } from "./report.ts";
import type { SupervisorSpawn } from "./review-spawn.ts";
import type { QueueItem } from "./queue.ts";
import { createRoundTracker } from "./round.ts";
import type { SpawnLike } from "./spawn-plan.ts";
import { createTelemetry, type MutationQueue, type TelemetrySkill } from "./telemetry.ts";

/** 子进程门禁在这里再导出一次：历史调用方与测试都从 evolution 取它 */
export { isChildProcess };

export interface EvolutionDeps {
  cwd: string;
  promptTemplatePath: string;
  queue: MutationQueue;
  log?: (msg: string) => void;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
  spawnFn?: SpawnLike;
  /** 生产注入：() => loadSkillsFromDir({ dir: join(cwd, ".pi/skills"), source: "project" }) */
  loadSkills?: () => { skills: SnapshotSkill[]; diagnostics: RawDiagnostic[] };
  /** 默认 .pi/evolution/rules/hard-rules.json */
  rulesFile?: string;
  /** 主会话当前模型：模型配置写 inherit 时用它解析评审模型 */
  hostModel?: () => { provider?: string; id?: string } | undefined;
  /** 评审督导的 spawn（默认真起 node 进程；单测注入假实现，避免留 900s 的后台进程） */
  supervisorSpawnFn?: SupervisorSpawn;
  /** 闸0/闸3 的 git 摘要（单测注入假实现：真实 git 与本扩展无关） */
  git?: GitRunner;
  /** 闸3 的 md-check 子进程（单测注入假实现） */
  runMdCheck?: (absPath: string) => { code: number; output: string };
  /** auto 级成功后的单独 commit（单测注入假实现；不注入则用真 git） */
  commit?: ApplyDeps["commit"];
  /** 面板回调：widget / status / appendEntry 是 pi 的能力，由 index.ts 提供 */
  panel?: PanelDeps;
  /** pid 存活判定（全局单飞闸用；单测注入，测试里不起真子进程） */
  alive?: (pid: number) => boolean;
}

export interface Evolution {
  recordAdvertised(input: {
    sessionId: string;
    cwd: string;
    prompt: string;
    skills: TelemetrySkill[];
    /** 本轮声明的工具名（pi.getActiveTools()）：类 E 判定的唯一依据 */
    activeTools?: string[];
  }): void;
  noteToolCall(input: { sessionId: string; toolCallId: string; toolName: string; input: Record<string, unknown> }): void;
  resolveToolResult(input: { sessionId: string; toolCallId: string; isError: boolean }): void;
  settle(input: { sessionId: string; sessionFile?: string }): void;
  recordHandlerError(where: string, error: unknown): void;
  /** 手动兜底：立即派发一次（跳过去抖与上限，仍守全局锁） */
  runNow(input: { sessionId: string; sessionFile?: string }): Promise<string>;
  /** 退出前把还没派发的轮次补发一次；同步完成，不抛 */
  shutdown(): void;
  flush(): Promise<void>;
  statusText(): Promise<string>;
  reportText(days?: number): string;
  /** 机械审计：类别汇总 + 硬禁令两段（存量 / 新增）+ 加载率注解 */
  auditText(days?: number): Promise<string>;
  /** `/skill-evolve baseline`：把当前命中全部接受为存量；reset 清空清单 */
  acceptBaseline(mode: "accept" | "reset"): Promise<string>;
  setEnabled(enabled: boolean): Promise<string>;
  /** `/skill-evolve collect|dispatch|review|apply` 与 Web 控制条：只切一个开关（其余三个保持原值） */
  setFlag(field: ConfigFlag, value: boolean): Promise<string>;
  /** 模型配置 + 必红自检（`/skill-evolve config|selftest`） */
  model: ModelTools;
  /** 分级采纳：闸0 快照 / 队列扫描 / 自动应用 / approve 与 queue 命令 */
  apply: ApplyTools;
  /** M6：面板刷新（状态变迁转 /tree 条目）与周报 + 指标落盘 */
  observe: Observer;
  /**
   * 重启 / `/reload` 后的接手：补状态、重挂督导师（详见 lib/recover.ts）。
   * 返回本次做了什么，面板与日志都靠它告诉用户「后台任务没丢」。
   */
  recover(sessionId?: string): Promise<RecoveryAction[]>;
  /** 最近一次恢复的结果（面板可视化用；本进程内有效） */
  lastRecovery(): RecoveryAction[];
}

export function createEvolution(deps: EvolutionDeps): Evolution {
  const evolutionDir = path.join(deps.cwd, ".pi", "evolution");
  // 默认只落盘（`.pi/evolution/logs/extension.log`）：TUI 默认零推送，PI_SKILL_EVOLVE_DEBUG=1 才回显
  const log = deps.log ?? ((msg: string) => logLine(evolutionDir, msg));
  const env = deps.env ?? process.env;
  const now = deps.now ?? (() => Date.now());
  const telemetryDir = path.join(evolutionDir, "telemetry");
  // 配置对象全生命周期只此一份：setEnabled 用 Object.assign 原地改，派发器看到的是同一份
  const config: EvolutionConfig = loadConfig(evolutionDir, log);
  // 传 getter 而不是快照：on/off 当场改 config 后，采集与写入立刻跟着变
  const telemetry = createTelemetry({ dir: telemetryDir, queue: deps.queue, enabled: () => config.telemetry, log, now });
  // 机械层：发现结果与硬禁令扫描都按进程缓存，第一次用到才干活（factory 里不读盘）
  const mechanical = createMechanical({
    cwd: deps.cwd,
    rulesFile: deps.rulesFile ?? path.join(evolutionDir, "rules", "hard-rules.json"),
    loadSkills: deps.loadSkills ?? (() => {
      throw new Error("未注入 loadSkillsFromDir，机械归因降级");
    }),
    log,
  });
  const modelTools = createModelTools({
    evolutionDir,
    cwd: deps.cwd,
    queue: deps.queue,
    log,
    now,
    env,
    ...(deps.hostModel ? { hostModel: deps.hostModel } : {}),
  });
  const dispatcher = createDispatcher({
    evolutionDir,
    cwd: deps.cwd,
    config,
    telemetry,
    queue: deps.queue,
    promptTemplatePath: deps.promptTemplatePath,
    log,
    now,
    env,
    spawnFn: deps.spawnFn,
    reviewModel: modelTools.reviewModel,
    selftestFailed: modelTools.selftestFailed,
    ...(deps.alive ? { alive: deps.alive } : {}),
    ...(deps.supervisorSpawnFn ? { supervisorSpawnFn: deps.supervisorSpawnFn } : {}),
  });

  const applyTools = createApplyTools({
    evolutionDir,
    cwd: deps.cwd,
    queue: deps.queue,
    // 传 getter：review / apply 中途开关后，下一轮扫描立刻按新值走
    flags: () => ({ autoReview: config.autoReview, autoApply: config.autoApply }),
    // 备份保留天数同样走 getter：与 on/off 一样是「改了立刻生效」
    retentionDays: () => config.backupRetentionDays,
    log,
    now,
    git: deps.git ?? createGitRunner(),
    // 闸3 的技能诊断直接复用 mechanical 的发现结果，避免第二次 readdir 出不一致的结论
    loadDiagnostics: () => (deps.loadSkills ? deps.loadSkills().diagnostics : []),
    runMdCheck: deps.runMdCheck ?? createMdCheckRunner(deps.cwd),
    ...(deps.commit ? { commit: deps.commit } : { commit: (item: QueueItem) => createCommitRunner(deps.cwd)(item) }),
  });

  const observer = createObserver({
    cwd: deps.cwd,
    evolutionDir,
    telemetryDir,
    queue: deps.queue,
    now,
    maxRuntimeMs: config.maxRuntimeMs,
    metricsWindowDays: config.metricsWindowDays,
    ...(deps.panel ? { panel: deps.panel } : {}),
  });

  /** 最近一轮的技能集 / 会话文件 / 归因：服务手动 `/skill-evolve run`，它可能发生在 settle 之后 */
  const lastRound = new Map<string, { skills: string[]; sessionFile?: string; activeTools: string[]; attributions: Attribution[] }>();
  // 存量债基线（设计稿 10.4）：懒加载，首次审计时把当时全部命中当存量
  const baselineGate = createBaselineGate({ file: baselinePath(evolutionDir), hits: () => mechanical.conflicts().hits, now, queue: deps.queue, log });
  const mechanicalReporter = createMechanicalReporter({ mechanical, append: (event) => telemetry.append(event), log, stockOf: baselineGate.isStock });
  // 一轮内的曝光/加载状态机（内存态）：本层只关心结算结果与派发时机
  const rounds = createRoundTracker({ cwd: deps.cwd, append: (event) => telemetry.append(event) });

  const recordAdvertised: Evolution["recordAdvertised"] = (input) => {
    const activeTools = input.activeTools ?? [];
    rounds.recordAdvertised({ ...input, activeTools });
    lastRound.set(input.sessionId, {
      skills: input.skills.filter((skill) => !skill.disabled).map((skill) => skill.name),
      sessionFile: lastRound.get(input.sessionId)?.sessionFile,
      activeTools,
      attributions: [],
    });
  };

  const noteToolCall: Evolution["noteToolCall"] = (input) => rounds.noteToolCall(input);
  const resolveToolResult: Evolution["resolveToolResult"] = (input) => rounds.resolveToolResult(input);

  const settle: Evolution["settle"] = (input) => {
    // 评审督导是独立进程、可能刚写完 03-review.json：每轮都扫一次队列，auto 条自动落盘
    if (!isChildProcess(env)) applyTools.settle();
    const result = rounds.settle(input.sessionId);
    if (!result) return;

    // 机械归因（A~E）+ 硬禁令扫描：只记事实，判不动的标 semantic 交给复盘 agent 做 F/G
    const attributions = mechanicalReporter.report({
      sessionId: input.sessionId,
      exposed: result.exposed,
      missed: result.missed,
      activeTools: result.activeTools,
    });

    if (isChildProcess(env)) return; // 门禁⓪
    lastRound.set(input.sessionId, {
      skills: result.exposed.map((skill) => skill.name),
      sessionFile: input.sessionFile,
      activeTools: result.activeTools,
      attributions,
    });
    // 门禁②③（全局锁 / 总开关）与去抖在派发器里；这里必须同步返回，不 await
    void dispatcher
      .dispatch({
        sessionId: input.sessionId,
        skills: result.exposed.map((skill) => skill.name),
        sessionFile: input.sessionFile,
        attributions,
      })
      .then((outcome) => {
        if (outcome.status === "skipped") log(`[skill-evolve] 本轮未派生：${outcome.why}`);
        // merged：并入在途 run 的日志由派发器打（那里能看到轮数），这里不重复
        else if (outcome.status === "dispatched") observer.noteDispatched(outcome.run.runId);
      })
      .catch((error: unknown) => recordHandlerError("dispatch", error));
  };

  const recordHandlerError: Evolution["recordHandlerError"] = (where, error) => {
    telemetry.append({ kind: "handler_error", where, message: String(error) });
  };

  const runNow: Evolution["runNow"] = async (input) => {
    const remembered = lastRound.get(input.sessionId);
    const outcome = await dispatcher.dispatch(
      {
        sessionId: input.sessionId,
        skills: remembered?.skills ?? [],
        sessionFile: input.sessionFile ?? remembered?.sessionFile,
        attributions: remembered?.attributions,
      },
      { bypassThrottle: true, trigger: "manual" },
    );
    return renderManualDispatch(outcome);
  };

  const shutdown: Evolution["shutdown"] = () => {
    try {
      // 同步补发：主进程马上退出，await 很可能到此为止就没了
      const dispatched = dispatcher.flushPending();
      if (dispatched > 0) log(`[skill-evolve] 退出前补发 ${dispatched} 次复盘`);
    } catch (error) {
      log(`[skill-evolve] 退出补发失败：${String(error)}`);
    }
    void telemetry.flush().catch((error: unknown) => log(`[skill-evolve] 遥测刷盘失败：${String(error)}`));
  };

  const views = createViews({ evolutionDir, telemetryDir, config, now, mechanical, mechanicalReporter, baselineGate, modelTools });

  const acceptBaseline = (mode: "accept" | "reset"): Promise<string> => (mode === "reset" ? baselineGate.reset() : baselineGate.acceptAll());

  const setEnabled = async (on: boolean): Promise<string> => {
    Object.assign(config, await saveConfigSwitch(evolutionDir, on, deps.queue));
    return on
      ? `技能进化已打开（自动复盘 + 自动评审；采集与自动采纳未改）：${configFile(evolutionDir)}（当前会话立即生效）`
      : `技能进化已全部关闭（采集 / 复盘 / 评审 / 采纳）：${configFile(evolutionDir)}（当前会话立即生效）`;
  };

  /** 只切一个开关：其余三个保持原值（`collect` = telemetry、`dispatch` = enabled、`review` = autoReview、`apply` = autoApply） */
  const setFlag = async (field: ConfigFlag, value: boolean): Promise<string> => {
    Object.assign(config, await saveFlag(evolutionDir, field, value, deps.queue));
    return `${FLAG_LABEL[field]}已${value ? "开启" : "关闭"}：${configFile(evolutionDir)}（当前会话立即生效）\n${flagStateText(config)}`;
  };

  /**
   * 配置页保存六项：与命令共用同一份写入（`saveSettings` 负责按块合并与归一化），
   * 这里只负责把结果并回正在用的那份配置，让「保存完立刻生效」对当前会话也成立。
   */
  const setSettings = async (patch: SettingsPatch): Promise<string> => {
    Object.assign(config, await saveSettings(evolutionDir, patch, deps.queue));
    return `配置已保存：${configFile(evolutionDir)}（当前会话立即生效；改端口要重启面板）`;
  };

  /**
   * 重启 / 重载后的接手：只补状态与重挂督导师，绝不重跑复盘。
   * 同步抛错也在这里吞：会话起点不能被恢复流程搞挂。
   */
  let lastActions: RecoveryAction[] = [];
  const recover = async (sessionId?: string): Promise<RecoveryAction[]> => {
    try {
      lastActions = await recoverRuns({
        evolutionDir,
        cwd: deps.cwd,
        queue: deps.queue,
        now,
        env,
        autoReview: () => config.autoReview,
        reviewModel: modelTools.reviewModel,
        ...(deps.alive ? { alive: deps.alive } : {}),
        ...(deps.supervisorSpawnFn ? { spawnSupervisor: deps.supervisorSpawnFn } : {}),
        ...(sessionId ? { sessionId } : {}),
        log,
      });
    } catch (error) {
      log(`[skill-evolve] 重启恢复失败：${String(error)}`);
      lastActions = [];
    }
    return lastActions;
  };

  return {
    recordAdvertised,
    noteToolCall,
    resolveToolResult,
    settle,
    recordHandlerError,
    runNow,
    shutdown,
    flush: () => telemetry.flush(),
    statusText: views.statusText,
    reportText: views.reportText,
    auditText: views.auditText,
    acceptBaseline,
    setEnabled,
    setFlag,
    setSettings,
    model: modelTools,
    apply: applyTools,
    observe: observer,
    recover,
    lastRecovery: () => lastActions,
  };
}
