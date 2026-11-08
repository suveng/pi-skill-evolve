/**
 * `/skill-evolve status|report` 与 `/skill-audit` 的读盘 + 渲染（从 evolution.ts 拆出）。
 *
 * 拆出来的原因很实际：evolution.ts 要守 300 行闸门，而这一组只做「读状态 → 出文本」，
 * 与采集/门禁/派发没有任何耦合，放一起反而让门禁逻辑难读。
 */
import * as fs from "node:fs";
import { auditText as renderAuditText, buildAuditModel, activeToolsFromEvents, exposedFromEvents } from "./audit.ts";
import { fingerprintsOf, type BaselineGate } from "./baseline.ts";
import { configFile, type EvolutionConfig } from "./config.ts";
import type { ModelTools } from "./evolution-model.ts";
import { lockDir, readOwner } from "./lock.ts";
import type { Mechanical } from "./mechanical.ts";
import type { MechanicalReporter } from "./mechanical-report.ts";
import { renderReport, renderStatus } from "./report.ts";
import { listRuns } from "./runs.ts";
import { listStaleRuns, scanStaleRuns } from "./stale.ts";
import { readEvents, summarize } from "./telemetry.ts";
import { isAlive, readWebPid } from "./web/panel-pid.ts";

export interface ViewsDeps {
  evolutionDir: string;
  telemetryDir: string;
  config: EvolutionConfig;
  now: () => number;
  mechanical: Mechanical;
  mechanicalReporter: MechanicalReporter;
  baselineGate: BaselineGate;
  modelTools: ModelTools;
}

export interface Views {
  statusText(): Promise<string>;
  reportText(days?: number): string;
  auditText(days?: number): Promise<string>;
}

export function createViews(deps: ViewsDeps): Views {
  const statusText = async (): Promise<string> => {
    const dir = lockDir(deps.evolutionDir);
    const held = fs.existsSync(dir);
    const owner = held ? await readOwner(dir) : null;
    // 先扫一遍再报：子进程死掉的 run 要在这里被标成 stale，否则 status 会永远漏报失败
    scanStaleRuns(deps.evolutionDir, deps.now(), { maxRuntimeMs: deps.config.maxRuntimeMs });
    // Web 面板记录只在 pid 还活着时显示：残记录（kill -9 之后）不该出现在状态里
    const web = readWebPid(deps.evolutionDir);
    return renderStatus({
      config: deps.config,
      configPath: configFile(deps.evolutionDir),
      telemetryDir: deps.telemetryDir,
      lockPid: held ? (owner?.pid ?? null) : undefined,
      webPanel: web && isAlive(web.pid) ? { url: web.url, pid: web.pid } : null,
      runs: listRuns(deps.evolutionDir, 5),
      staleRuns: listStaleRuns(deps.evolutionDir, 5),
      selftest: deps.modelTools.lastSelftest(),
    });
  };

  const reportText = (days = 7): string =>
    renderReport({
      days,
      summary: summarize(readEvents(deps.telemetryDir, days, deps.now())),
      runs: listRuns(deps.evolutionDir, 10),
      selftest: deps.modelTools.lastSelftest(),
    });

  /** 机械审计：类别汇总来自遥测 attributed；历史 missed 用当前快照现算（可能是旧数据，标注清楚） */
  const auditText = async (days = 7): Promise<string> => {
    const events = readEvents(deps.telemetryDir, days, deps.now());
    deps.mechanicalReporter.noteFailure();
    const { hits, invalid } = deps.mechanical.conflicts();
    // 先取（缺文件时在这里 bootstrap），再等写盘落地：顺序反了文件可能还在写就返回了
    const knownFingerprints = fingerprintsOf(deps.baselineGate.baseline());
    await deps.baselineGate.settled();
    const exposed = exposedFromEvents(events);
    const activeTools = activeToolsFromEvents(events);
    const model = buildAuditModel({
      days,
      events,
      conflicts: hits,
      knownFingerprints,
      invalidRules: invalid,
      classify: (skill) => deps.mechanical.attribute({ missed: [skill], exposed, activeTools })[0].category,
    });
    return renderAuditText(model);
  };

  return { statusText, reportText, auditText };
}
