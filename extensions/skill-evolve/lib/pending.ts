/**
 * 去抖期间把新一轮并进「待复盘区间」：轮数累加、技能去重、起点保留第一次被挡下的时刻。
 *
 * 纯函数，单独放一个文件让 dispatch.ts 守住 300 行闸门，也便于直接单测合并语义。
 */
import { mergeAttributions, type Attribution } from "./attribution.ts";
import type { PendingRounds } from "./shutdown-dispatch.ts";

export interface PendingInput {
  sessionId: string;
  skills: string[];
  sessionFile?: string;
  attributions?: Attribution[];
}

export function mergePendingRounds(carried: PendingRounds | undefined, input: PendingInput, at: number): PendingRounds {
  if (!carried) {
    return {
      sessionId: input.sessionId,
      since: at,
      rounds: 1,
      skills: [...input.skills],
      sessionFile: input.sessionFile,
      attributions: mergeAttributions(undefined, input.attributions),
    };
  }
  return {
    ...carried,
    rounds: carried.rounds + 1,
    skills: [...carried.skills, ...input.skills.filter((name) => !carried.skills.includes(name))],
    sessionFile: input.sessionFile ?? carried.sessionFile,
    attributions: mergeAttributions(carried.attributions, input.attributions),
  };
}
