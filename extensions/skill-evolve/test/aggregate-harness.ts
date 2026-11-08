/**
 * 聚合检测的测试夹具：假子进程 + 假派发器 + 临时工作区。
 *
 * 为什么不放在 .test.ts 里：聚合有两条入口（自动派发与退出前补发），
 * 各自一个测试文件，夹具共用一份才不会两边算出不同的场景。
 *
 * 纪律：pid 用合成号段（90001 起）而不是本进程 pid —— 「子进程是死是活」由用例通过 setAlive 控制，
 * 否则测试进程自己活着就会被判成「有在途复盘」。全程不起真子进程。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_CONFIG } from "../lib/config.ts";
import { createDispatcher } from "../lib/dispatch.ts";
import { type SpawnedChild, type SpawnLike } from "../lib/spawn-plan.ts";
import { directQueue, type TelemetryEvent, type TelemetryInput, type TelemetryWriter } from "../lib/telemetry.ts";
import { fakeSupervisorSpawn } from "./fake-review-spawn.ts";

export const TEMPLATE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "prompts", "复盘.md");
/** 固定时钟：判据里的「派发时刻 / 未来时刻」都按它算，用例才可复现 */
export const NOW = 1_760_000_000_000;

/**
 * 假子进程：pid 用**合成的号段**（不是本进程 pid）。
 *
 * 这样「子进程是死是活」完全由用例通过 setAlive 控制 —— 聚合与单飞闸都读注入的 alive，
 * 不会因为测试进程自己活着就被判成「有在途复盘」。
 * 合成 pid 对真 kill(pid,0) 来说是死的，于是残锁会被当作孤儿回收：正好符合「子进程已退出」的场景。
 */
export class FakeChild {
  readonly pid: number;
  constructor(pid: number) {
    this.pid = pid;
  }
  private listeners = new Map<string, (arg: unknown) => void>();
  unref(): void {}
  once(event: string, listener: (arg: unknown) => void): this {
    this.listeners.set(event, listener);
    return this;
  }
  emit(event: string, arg: unknown): void {
    this.listeners.get(event)?.(arg);
  }
}

export interface Harness {
  evolutionDir: string;
  calls: { command: string; args: string[]; options: Record<string, unknown> }[];
  children: FakeChild[];
  events: TelemetryEvent[];
  logs: string[];
  tick: (ms: number) => void;
  /** 「子进程还活着吗」：聚合与单飞闸共用这个注入，用例按需翻转 */
  setAlive: (value: boolean) => void;
  dispatch: ReturnType<typeof createDispatcher>["dispatch"];
}

export function harness(tag: string): Harness {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `skill-evolve-agg-${tag}-`));
  const evolutionDir = path.join(dir, ".pi", "evolution");
  const calls: Harness["calls"] = [];
  const children: FakeChild[] = [];
  const events: TelemetryEvent[] = [];
  const logs: string[] = [];
  const pushEvent = (event: TelemetryInput): void => {
    events.push({ ...event, ts: NOW, iso: "" } as TelemetryEvent);
  };
  const writer: TelemetryWriter = { append: pushEvent, appendSync: pushEvent, flush: async () => undefined };
  const spawnFn: SpawnLike = (command, args, options) => {
    calls.push({ command, args, options });
    // pid 从 90001 起编号：每个用例一个独立工作区，不会和本机真实进程号撞上也无关（judged by alive）
    const child = new FakeChild(90_001 + children.length);
    children.push(child);
    return child as unknown as SpawnedChild;
  };
  let alive = true;
  let clock = NOW;
  const dispatcher = createDispatcher({
    evolutionDir,
    cwd: dir,
    config: { ...DEFAULT_CONFIG, enabled: true, telemetry: true },
    telemetry: writer,
    queue: directQueue,
    promptTemplatePath: TEMPLATE,
    log: (msg) => logs.push(msg),
    now: () => clock,
    env: {},
    spawnFn,
    alive: () => alive,
    supervisorSpawnFn: fakeSupervisorSpawn([]),
  });
  return {
    evolutionDir,
    calls,
    children,
    events,
    logs,
    tick: (ms) => {
      clock += ms;
    },
    setAlive: (value) => {
      alive = value;
    },
    dispatch: dispatcher.dispatch,
  };
}
export function readRun(h: Harness, runId: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(h.evolutionDir, "runs", runId, "run.json"), "utf8")) as Record<string, unknown>;
}

export const settleAsync = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 50));

