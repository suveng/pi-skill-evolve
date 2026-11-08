/**
 * 评审子进程的假实现（只给测试用，文件名不匹配 *.test.ts 所以不会被当用例跑）。
 *
 * 真起 `pi` 一次要几十秒且要花额度；这里用 EventEmitter 复刻 runReviewChild 需要的
 * 三个口子：stdout 收到文本、exit 结束、kill 可被调用。
 */
import { EventEmitter } from "node:events";
import type { ReviewChild, ReviewSpawn } from "../lib/review-run.ts";
import type { SupervisorSpawn } from "../lib/review-spawn.ts";

export class FakeReviewChild extends EventEmitter implements ReviewChild {
  pid = 4242;
  stdout = new EventEmitter();
  killed = false;
  kill(): void {
    this.killed = true;
    this.emit("exit", 0);
  }
}

/** 每次 spawn 依次取出 replies 里的一条（取完循环用最后一条）；1ms 后输出并退出 */
export function fakeReviewSpawn(replies: readonly string[], delayMs = 1): ReviewSpawn {
  let index = 0;
  return () => {
    const child = new FakeReviewChild();
    const reply = replies[Math.min(index, replies.length - 1)];
    index += 1;
    setTimeout(() => {
      child.stdout.emit("data", reply);
      child.emit("exit", 0);
    }, delayMs);
    return child;
  };
}

/** 永不退出的子进程：用来验超时路径（配假时钟，不真等） */
export function hangingReviewSpawn(): ReviewSpawn {
  return () => new FakeReviewChild();
}

/** 假时钟：sleep 推进 now，让 900s / 300s 超时在毫秒内跑完 */
export function fakeClock(): { now: () => number; sleep: (ms: number) => Promise<void>; elapsed: () => number } {
  let t = 1_700_000_000_000;
  const start = t;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
    elapsed: () => t - start,
  };
}

/** 假督导 spawn：只记下参数，绝不真起 node 进程（真督导会轮询 900 秒） */
export function fakeSupervisorSpawn(calls: { args: string[]; options: Record<string, unknown> }[] = []): SupervisorSpawn {
  return (_command, args, options) => {
    calls.push({ args, options });
    return { pid: 7777 };
  };
}
