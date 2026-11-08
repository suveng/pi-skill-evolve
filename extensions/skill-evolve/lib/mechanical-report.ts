/**
 * 把机械层（归因 A~E + 硬禁令扫描）的结论写进遥测。
 *
 * 单独成文件的原因有两个：
 * 1. evolution.ts 的 settle 只该负责「采集 + 门禁」，归因落盘的口径集中在一处更好查；
 * 2. 这里能在单测里直接喂假遥测，验证「同一冲突只记一次」「故障只报一次」这两条去重规则。
 */
import type { Attribution } from "./attribution.ts";
import { fingerprintOf } from "./baseline.ts";
import type { HardRuleHit } from "./hard-rules.ts";
import type { Mechanical } from "./mechanical.ts";
import type { TelemetryEvent, TelemetrySkill } from "./telemetry.ts";

export interface MechanicalReporterDeps {
  mechanical: Mechanical;
  /** 遥测 append（生产 = telemetry.append，测试 = 收集到数组） */
  append: (event: TelemetryEvent) => void;
  /** 命中是否属于存量债（设计稿 10.4）：周报要能分开统计，不能混成一个数 */
  stockOf?: (hit: HardRuleHit) => boolean;
  log?: (message: string) => void;
}

export interface MechanicalReportRequest {
  sessionId: string;
  /** 本轮真正曝光的技能（已剔除 disabled） */
  exposed: TelemetrySkill[];
  /** 其中没被读过的技能名 */
  missed: string[];
  activeTools: string[];
}

export interface MechanicalReporter {
  /** 发现失败只报一次，不要每轮重复撞同一面墙 */
  noteFailure(): void;
  /** 返回本轮归因结果（派发时带进 prompt，让复盘 agent 只做 F/G） */
  report(request: MechanicalReportRequest): Attribution[];
  /** 已上报过的冲突条数，仅用于测试与日志 */
  conflictCount(): number;
}

export function createMechanicalReporter(deps: MechanicalReporterDeps): MechanicalReporter {
  let failureReported = false;
  /** 硬禁令是「文件现状」不是「本轮事件」：同一条命中只记一次，避免每轮刷屏 */
  const reportedConflicts = new Set<string>();

  const noteFailure = (): void => {
    if (failureReported) return;
    const failed = deps.mechanical.snapshot().failed;
    if (failed === undefined) return;
    failureReported = true;
    deps.log?.(`[skill-evolve] 技能发现失败：${failed}`);
    deps.append({ kind: "handler_error", where: "mechanical", message: failed });
  };

  const report = (request: MechanicalReportRequest): Attribution[] => {
    noteFailure();
    const attributions = deps.mechanical.attribute({
      missed: request.missed,
      exposed: request.exposed.map((skill) => ({
        name: skill.name,
        filePath: skill.filePath,
        disabled: skill.disabled,
      })),
      activeTools: request.activeTools,
    });
    for (const item of attributions) {
      deps.append({
        kind: "attributed",
        sessionId: request.sessionId,
        skill: item.skill,
        category: item.category,
        reason: item.reason,
      });
    }
    for (const hit of deps.mechanical.conflicts().hits) {
      // 去重键用指纹（不含行号）：行号漂移是同一条存量问题，不应被当成新命中再记一次
      const key = fingerprintOf(hit);
      if (reportedConflicts.has(key)) continue;
      reportedConflicts.add(key);
      deps.append({
        kind: "conflict",
        sessionId: request.sessionId,
        ruleId: hit.ruleId,
        level: hit.level,
        skill: hit.skill,
        line: hit.line,
        quote: hit.quote,
        stock: deps.stockOf?.(hit) ?? false,
      });
    }
    return attributions;
  };

  return { noteFailure, report, conflictCount: () => reportedConflicts.size };
}
