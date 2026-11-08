/**
 * 一轮（一条用户消息）内的曝光 / 加载状态机：曝光 → 待确认 → 回填 → 结算。
 *
 * 单独成文件是因为它只有内存状态、不碰派发与文件：演进层把「什么时候动手」留在自己那儿，
 * 这里只负责把 pi 的事件流变成「本轮曝光了几个、真加载了几个、谁没被加载」。
 */
import { createHash } from "node:crypto";
import { detectFromBash, detectFromRead, type SkillHit } from "./detect.ts";
import type { TelemetryInput, TelemetrySkill } from "./telemetry.ts";

export interface RoundAdvertisedInput {
  sessionId: string;
  cwd: string;
  prompt: string;
  skills: TelemetrySkill[];
  activeTools: string[];
}

export interface RoundResult {
  /** 真被曝光（disabled 的不算，它们没进 prompt）的技能 */
  exposed: TelemetrySkill[];
  missed: string[];
  activeTools: string[];
}

export interface RoundTracker {
  recordAdvertised(input: RoundAdvertisedInput): void;
  noteToolCall(input: { sessionId: string; toolCallId: string; toolName: string; input: Record<string, unknown> }): void;
  resolveToolResult(input: { sessionId: string; toolCallId: string; isError: boolean }): void;
  /** 结算并清空本轮；没有本轮 / 会话不匹配 / 零曝光时返回 null（零曝光既不记未命中也不派生） */
  settle(sessionId: string): RoundResult | null;
}

interface RoundState {
  sessionId: string;
  skills: TelemetrySkill[];
  loaded: Set<string>;
  /** toolCallId → 该次调用碰到的技能，等 tool_result 回填 ok/failed */
  pending: Map<string, SkillHit[]>;
  activeTools: string[];
}

function hashOf(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

export function createRoundTracker(options: {
  cwd: string;
  append: (event: TelemetryInput) => void;
}): RoundTracker {
  let round: RoundState | null = null;

  const recordAdvertised: RoundTracker["recordAdvertised"] = (input) => {
    round = { sessionId: input.sessionId, skills: input.skills, loaded: new Set(), pending: new Map(), activeTools: input.activeTools };
    options.append({
      kind: "advertised",
      sessionId: input.sessionId,
      cwd: input.cwd,
      promptHash: hashOf(input.prompt),
      promptExcerpt: input.prompt.slice(0, 200),
      skills: input.skills,
      activeTools: input.activeTools,
    });
  };

  const noteToolCall: RoundTracker["noteToolCall"] = (input) => {
    if (!round || round.sessionId !== input.sessionId) return;
    const hits: SkillHit[] = [];
    if (input.toolName === "read") {
      const hit = detectFromRead(String(input.input.path ?? ""), options.cwd);
      if (hit) hits.push(hit);
    } else if (input.toolName === "bash") {
      hits.push(...detectFromBash(String(input.input.command ?? "")));
    }
    // 路径规则只能判定「这看起来像技能文件」；只有本轮真被曝光的技能才算加载证据，
    // 否则仓库里任何一个 <目录>/SKILL.md 都会被错记成一次加载。
    const advertised = new Set(round.skills.map((skill) => skill.name));
    const owned = hits.filter((hit) => advertised.has(hit.skill));
    if (owned.length > 0) round.pending.set(input.toolCallId, owned);
  };

  const resolveToolResult: RoundTracker["resolveToolResult"] = (input) => {
    if (!round || round.sessionId !== input.sessionId) return;
    const hits = round.pending.get(input.toolCallId);
    if (!hits) return;
    round.pending.delete(input.toolCallId);
    for (const hit of hits) {
      options.append({
        kind: input.isError ? "failed" : "loaded",
        sessionId: input.sessionId,
        skill: hit.skill,
        how: hit.how,
        ok: !input.isError,
        raw: hit.raw,
      });
      if (!input.isError) round.loaded.add(hit.skill);
    }
  };

  const settle: RoundTracker["settle"] = (sessionId) => {
    const current = round;
    round = null; // 一轮只结算一次，杜绝同一个 round 被重复记未命中
    if (!current || current.sessionId !== sessionId) return null;
    // 门禁①：本轮没有任何技能曝光（没走到技能系统），既不算未命中也不派生
    if (current.skills.length === 0) return null;

    // disabled 的技能根本没进 prompt，不算「曝光未命中」，留待归因阶段按 A 类处理
    const exposed = current.skills.filter((skill) => !skill.disabled);
    const missed = exposed.filter((skill) => !current.loaded.has(skill.name)).map((skill) => skill.name);
    options.append({ kind: "pending", sessionId, exposed: exposed.length, missed: missed.length });
    for (const name of missed) options.append({ kind: "missed", sessionId, skill: name });
    return { exposed, missed, activeTools: current.activeTools };
  };

  return { recordAdvertised, noteToolCall, resolveToolResult, settle };
}
