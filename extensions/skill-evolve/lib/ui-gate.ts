/**
 * 界面推送闸：TUI 默认**零推送**（用户 2026-11-08：「tui 的这些推送不看了，影响我」）。
 *
 * 开关来自配置 `ui.widget` / `ui.entries`，默认全关；显式打开才调宿主的 setWidget / setStatus /
 * appendEntry。实时状态另有出口，不需要占着对话区：
 * `/skill-evolve status`、Web 面板（`/skill-evolve web`）、`.pi/evolution/logs/extension.log`。
 *
 * 为什么闸放在 lib 而不是 index.ts：index.ts 依赖 pi 包，`node --test` 里 import 不进来
 * （找不到 `@earendil-works/pi-coding-agent`），只有下沉到 lib 才能被单测覆盖。
 */
import type { UiConfig } from "./config.ts";
import { panelWidget, statusLine, type PanelState } from "./panel.ts";

/** 宿主 TUI 的最小形状（pi 的 ctx.ui 结构兼容）：只声明本文件要用的两个方法 */
export interface UiPanelHost {
  setWidget(id: string, content: string[] | undefined): void;
  setStatus(id: string, content: string | undefined): void;
}

export const PANEL_ID = "skill-evolve";

/** widget 开关关着就一次都不调（连「清空」都不做）：默认零推送 */
export function renderPanel(host: UiPanelHost, flags: UiConfig, state: PanelState): void {
  if (!flags.widget) return;
  host.setWidget(PANEL_ID, panelWidget(state) ?? undefined);
  host.setStatus(PANEL_ID, statusLine(state) ?? undefined);
}

/** entries 开关关着就不写 `/tree` 条目；写入成功返回 true（单测按返回值断言） */
export function writeEntry<T>(flags: UiConfig, write: (entry: T) => void, entry: T): boolean {
  if (!flags.entries) return false;
  write(entry);
  return true;
}
