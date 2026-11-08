/**
 * TUI 闸（用户 2026-11-08：「tui 的这些推送不看了，影响我」）：
 * `ui.widget` / `ui.entries` 为 false 时一次都不碰宿主 UI；显式打开才各写一次。
 *
 * 宿主用记录型假对象，不依赖 pi 运行时。
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { UiConfig } from "../lib/config.ts";
import type { PanelEntry, PanelState } from "../lib/panel.ts";
import { PANEL_ID, renderPanel, writeEntry, type UiPanelHost } from "../lib/ui-gate.ts";

const OFF: UiConfig = { widget: false, entries: false };
const ON: UiConfig = { widget: true, entries: true };

function busyState(): PanelState {
  return { reviewing: 1, staleCount: 1, pendingApprovals: 2, lastAppliedAt: null, rollbackRate: 0, appliedSamples: 0 };
}

interface Calls {
  host: UiPanelHost;
  widgets: (string[] | undefined)[];
  statuses: (string | undefined)[];
}

function fakeHost(): Calls {
  const widgets: (string[] | undefined)[] = [];
  const statuses: (string | undefined)[] = [];
  return {
    widgets,
    statuses,
    host: {
      setWidget: (id, content) => {
        assert.equal(id, PANEL_ID);
        widgets.push(content);
      },
      setStatus: (id, content) => {
        assert.equal(id, PANEL_ID);
        statuses.push(content);
      },
    },
  };
}

test("renderPanel：ui.widget=false 时一次都不调 setWidget / setStatus", () => {
  const calls = fakeHost();
  renderPanel(calls.host, OFF, busyState());
  assert.deepEqual(calls.widgets, []);
  assert.deepEqual(calls.statuses, []);
});

test("renderPanel：ui.widget=true 时面板与状态栏各写一次", () => {
  const calls = fakeHost();
  renderPanel(calls.host, ON, busyState());
  assert.equal(calls.widgets.length, 1);
  assert.equal(calls.statuses.length, 1);
  assert.ok((calls.widgets[0] ?? []).length > 0, "有数据时面板不该是空的");
  assert.equal(typeof calls.statuses[0], "string");
});

test("writeEntry：ui.entries=false 时不写 /tree 条目，返回 false", () => {
  const written: PanelEntry[] = [];
  const ok = writeEntry<PanelEntry>(OFF, (entry) => written.push(entry), {
    kind: "reviewed",
    runId: "r1",
    at: 1,
  });
  assert.equal(ok, false);
  assert.deepEqual(written, []);
});

test("writeEntry：ui.entries=true 时写一次并返回 true", () => {
  const written: PanelEntry[] = [];
  const entry: PanelEntry = { kind: "dispatched", runId: "r1", at: 1 };
  assert.equal(writeEntry<PanelEntry>(ON, (item) => written.push(item), entry), true);
  assert.deepEqual(written, [entry]);
});
