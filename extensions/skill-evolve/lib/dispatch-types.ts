/**
 * 派发层的类型：输入 / 依赖 / 结果。
 *
 * 为什么单独一个文件：dispatch.ts 已经贴着 300 行闸门，而这几块是**纯声明**（没有一行逻辑），
 * 搬出来不改变任何行为；dispatch.ts 仍然把它们原样再导出，调用方按老路径取类型不受影响。
 */
import type { Attribution } from "./attribution.ts";
import type { EvolutionConfig } from "./config.ts";
import type { RunRecord } from "./runs.ts";
import type { SpawnLike } from "./spawn-plan.ts";
import type { SupervisorSpawn } from "./review-spawn.ts";
import type { MutationQueue, TelemetryWriter } from "./telemetry.ts";

export interface DispatchInput {
  sessionId: string;
  skills: string[];
  sessionFile?: string;
  /** 已经机械归因过的技能（A~E）：写进 prompt，复盘 agent 不必重判 */
  attributions?: Attribution[];
}

export interface DispatchDeps {
  evolutionDir: string;
  cwd: string;
  config: EvolutionConfig;
  telemetry: TelemetryWriter;
  queue: MutationQueue;
  promptTemplatePath: string;
  log?: (msg: string) => void;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
  spawnFn?: SpawnLike;
  /** 评审模型（"inherit" 或 provider/model）：每次派生现取，配置改动立即生效 */
  reviewModel?: () => string;
  /** 必红自检没过 → 整条流水线停用（设计稿 12.4） */
  selftestFailed?: () => boolean;
  /** 评审督导的 spawn（默认 node spawn；单测注入假实现） */
  supervisorSpawnFn?: SupervisorSpawn;
  /** pid 存活判定（全局单飞闸用；单测注入，测试里不起真子进程） */
  alive?: (pid: number) => boolean;
}

export interface DispatchedRun {
  runId: string;
  runDir: string;
  pid: number | null;
}

/** 派发结果：调用方（命令 / 事件）要据此出文案，所以不能再只用 null 表示「没派」 */
export type DispatchOutcome =
  | { status: "dispatched"; run: DispatchedRun }
  | {
      status: "skipped";
      why:
        | "disabled"
        | "cap"
        | "lock"
        | "lock-error"
        | "selftest-failed"
        | "busy"
        | "pi-not-found"
        /** 会话里用户消息没超过 minUserMessages：不值得花一次复盘 token（2026-11-13） */
        | "too-few-turns";
      ownerPid: number | null;
    }
  | { status: "superseded"; rounds: number }
  /** 已有复盘子进程在跑：这一轮排进派发队列，跑完自动接上（不再丢轮次，见 lib/dispatch-queue.ts） */
  | { status: "queued"; sessionId: string; depth: number }
  /** 同一会话已有在途复盘：这一轮并进去了，既没建新 run 也没起进程（见 lib/aggregate.ts） */
  | { status: "merged"; runId: string; rounds: number };

export interface DispatchOptions {
  /** 手动 `/skill-evolve run`：跳过去抖与单会话上限，但**仍必须守全局锁** */
  bypassThrottle?: boolean;
  trigger?: RunRecord["trigger"];
}
