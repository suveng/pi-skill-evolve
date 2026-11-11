/**
 * 起评审督导进程：与复盘子进程同一次派发里、同一条「detached + unref」纪律。
 *
 * 为什么用 `process.execPath` 而不是 `pi`：督导本身是普通 node 脚本（只读产物、写 03-review.*），
 * 评审才需要 pi。这样即使 `pi` 不可见也不影响督导先把 900 秒超时落成一条记录。
 *
 * 全局单飞闸在这里也拦一次：督导算第二个子进程，已有别的复盘在跑就不叠（用户 2026-11-08：
 * 「每次最多一个复盘agent」）。与**自己**那条 run 的复盘子进程不冲突，靠 ignoreRunId 排除。
 */
import { spawn as nodeSpawn } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { patchRunRecordSync } from "./runs.ts";
import { guardBusy } from "./single-flight.ts";
import { spawnDetached, stripDaemonFlags } from "./spawn-plan.ts";
import { ensureSupervisorRuntime, type RuntimeOptions } from "./supervisor-runtime.ts";
import type { TelemetryWriter } from "./telemetry.ts";

/** 督导脚本绝对路径：dispatch 与 shutdown-dispatch 两条路径共用 */
export const SUPERVISOR_SCRIPT = fileURLToPath(new URL("./review-supervisor.ts", import.meta.url));

/** 督导日志文件名：督导自己也可能静默死掉，日志跟子进程一样落到 run 目录 */
export const SUPERVISOR_LOG = "supervisor.log";

export interface SupervisorChild {
  pid?: number;
  unref?: () => void;
}

export type SupervisorSpawn = (command: string, args: string[], options: Record<string, unknown>) => SupervisorChild;

export interface SpawnSupervisorOptions {
  runDir: string;
  /**
   * 自动评审开关（`/skill-evolve review on|off`）：关着就不起督导，只留一句日志。
   *
   * 门禁放在这里而不是两个调用点各写一遍 —— dispatch 与退出补发是同一条语义，
   * 分开写迟早有一边忘改。调用方必须在**真正下手前**现读配置（用户可能中途切换）。
   */
  autoReview: boolean;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** "inherit" / 空 → 不传参，督导按默认模型评审 */
  reviewModel?: string;
  spawnFn?: SupervisorSpawn;
  log?: (msg: string) => void;
  /** 同一条 run 的会话 ID：busy 遥测要带它（缺省退化到 runId，事件不能丢） */
  sessionId?: string;
  telemetry?: TelemetryWriter;
  /** pid 存活判定（单测注入；生产用默认 kill(pid,0)） */
  alive?: (pid: number) => boolean;
  /** 退出补发路径：主进程马上退，遥测只能同步写 */
  sync?: boolean;
  /**
   * 督导入口解析：默认走 supervisor-runtime 的「node_modules 里先搬家」逻辑。
   * 单测注入它，避免真去拷源码目录。
   */
  resolveScript?: (options: RuntimeOptions) => string;
  /** 包版本：参与运行目录的缓存键 */
  version?: string;
}

/** 返回 pid；被单飞闸挡住或起不来返回 null（只记日志，绝不抛到主会话） */
export function spawnReviewSupervisor(options: SpawnSupervisorOptions): number | null {
  const runId = path.basename(options.runDir);
  if (!options.autoReview) {
    options.log?.(`[skill-evolve] 自动评审已关，run ${runId} 停在 proposed 待人工 /skill-evolve approve`);
    return null;
  }
  const occupant = guardBusy({
    evolutionDir: path.dirname(path.dirname(options.runDir)),
    sessionId: options.sessionId ?? runId,
    // 自己这条 run 的复盘子进程本来就该在跑，不能把自己当占用者
    ignoreRunId: runId,
    ...(options.telemetry ? { telemetry: options.telemetry } : {}),
    ...(options.alive ? { alive: options.alive } : {}),
    ...(options.sync === true ? { sync: true } : {}),
    ...(options.log ? { log: options.log } : {}),
  });
  if (occupant) return null;

  // 督导自己不是复盘子进程，同一个 env 还要传给评审 Agent：摘掉「抢守护进程」的开关，
  // 否则评审用的 pi 一加载桥接扩展就被 process.exit 带走（子进程模式下同样会死）
  const env = stripDaemonFlags(options.env ?? process.env);
  // 督导自己不是 pi 子代理：把「别再采集」的标记去掉，避免它起评审子进程时语义混乱
  delete env.SKILL_EVOLVE_CHILD;
  // node_modules 里的 .ts 不能直接跑（ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING）：先搬到工作区的
  // runtime 目录再起进程，否则按 npm 包安装时督导**每次**都崩在 import 阶段（2026-11-09 事故）
  const resolveScript = options.resolveScript ?? ensureSupervisorRuntime;
  const script = resolveScript({
    evolutionDir: path.dirname(path.dirname(options.runDir)),
    scriptPath: SUPERVISOR_SCRIPT,
    ...(options.version ? { version: options.version } : {}),
    ...(options.log ? { log: options.log } : {}),
  });
  const args = ["--experimental-strip-types", script, options.runDir];
  if (options.reviewModel && options.reviewModel !== "inherit") args.push(options.reviewModel);
  const spawnFn = options.spawnFn ?? (nodeSpawn as unknown as SupervisorSpawn);
  try {
    const child = spawnDetached(spawnFn, process.execPath, args, {
      cwd: options.cwd,
      env,
      logFile: path.join(options.runDir, SUPERVISOR_LOG),
    });
    // 占用登记：督导 pid 写进同一条 run.json；它退出 / 失败时清成 null
    if (child.pid) patchRunRecordSync(options.runDir, { supervisorPid: child.pid });
    options.log?.(`[skill-evolve] 已起评审督导 pid ${child.pid ?? "未知"}（${runId}）`);
    return child.pid ?? null;
  } catch (error) {
    options.log?.(`[skill-evolve] 评审督导启动失败：${String(error)}`);
    return null;
  }
}
