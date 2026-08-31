// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopNativeCoreOperationsWorkspaceProjectionResult } from "../desktop";
import { NativeOperationsWorkspace, type NativeOperationsWorkspaceProps } from "./NativeOperationsWorkspace";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function projection(overrides: Partial<DesktopNativeCoreOperationsWorkspaceProjectionResult> = {}): DesktopNativeCoreOperationsWorkspaceProjectionResult {
  return {
    schemaVersion: 1, projectionType: "operations-workspace-v1", source: "native-core",
    stateVersion: 47, sessionId: "session-1", runId: "run-1", revision: 7,
    registryFingerprint: "7df8cf3a", truncated: false,
    settings: {
      simulationSpeed: 1, technologyLayout: "standard", defaultBeltRouteMode: "auto",
      productionBufferLimit: 1000, logisticsBufferLimit: 1000,
      beltBufferLimit: 1000, proliferatorBufferLimit: 1,
    },
    summary: {
      paused: false, elapsedSeconds: 10, entityCount: 1, beltCount: 0,
      activePlanetId: "home", activePlanetEntityCount: 1,
      activePlanetBeltCount: 0, constructionQueueCount: 0,
    },
    alerts: {
      status: "complete", totalCount: 1, criticalCount: 1, warningCount: 0,
      rows: [{ entityId: "entity-1", planetId: "home", buildingId: "arc_smelter", recipeId: null, resourceId: null, severity: "critical", code: "no-power", label: "无供电" }],
    },
    limits: { alertRows: 1024, projectionBytes: 524288 }, ...overrides,
  };
}

function props(overrides: Partial<NativeOperationsWorkspaceProps> = {}): NativeOperationsWorkspaceProps {
  return {
    open: true,
    identity: { sessionId: "session-1", runId: "run-1", expectedRevision: 7, expectedRegistryFingerprint: "7df8cf3a" },
    fetchProjection: vi.fn(async () => projection()), commitSetting: vi.fn(async () => ({})),
    theme: "dark", fontScale: 1, factoryAlertsEnabled: true,
    canvasDetailPreference: "auto", connectionPointSize: "default",
    connectionHitArea: "auto", defaultBeltLanes: 1,
    locale: "zh-CN",
    onThemeChange: vi.fn(), onFontScaleChange: vi.fn(), onFactoryAlertsEnabledChange: vi.fn(),
    onCanvasDetailPreferenceChange: vi.fn(), onConnectionPointSizeChange: vi.fn(),
    onConnectionHitAreaChange: vi.fn(), onDefaultBeltLanesChange: vi.fn(),
    onLocaleChange: vi.fn(),
    onManualCheckpoint: vi.fn(), onExportV47: vi.fn(), onAlertSelect: vi.fn(),
    onOpenTutorial: vi.fn(), onOpenReleaseNotes: vi.fn(), onClose: vi.fn(), ...overrides,
  };
}

function button(host: HTMLElement, text: string): HTMLButtonElement {
  const value = [...host.querySelectorAll("button")].find((entry) => entry.textContent?.includes(text));
  if (!(value instanceof HTMLButtonElement)) throw new Error(`missing button ${text}`);
  return value;
}

function selectInLabel(host: HTMLElement, text: string): HTMLSelectElement {
  const value = [...host.querySelectorAll("label")].find((label) => label.textContent?.includes(text))?.querySelector("select");
  if (!(value instanceof HTMLSelectElement)) throw new Error(`missing select ${text}`);
  return value;
}

function inputInLabel(host: HTMLElement, text: string): HTMLInputElement {
  const value = [...host.querySelectorAll("label")].find((label) => label.textContent?.includes(text))?.querySelector("input");
  if (!(value instanceof HTMLInputElement)) throw new Error(`missing input ${text}`);
  return value;
}

describe("NativeOperationsWorkspace", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

  it("renders same-revision alerts and routes only the selected row", async () => {
    const value = props();
    await act(async () => { root.render(<NativeOperationsWorkspace {...value} />); });
    expect(host.textContent).toContain("无供电");
    await act(async () => button(host, "无供电").click());
    expect(value.onAlertSelect).toHaveBeenCalledWith(expect.objectContaining({ entityId: "entity-1" }));
  });

  it("retires an old projection when authority identity switches", async () => {
    let resolveOld!: (value: DesktopNativeCoreOperationsWorkspaceProjectionResult) => void;
    const old = new Promise<DesktopNativeCoreOperationsWorkspaceProjectionResult>((resolve) => { resolveOld = resolve; });
    const value = props({ fetchProjection: vi.fn(() => old) });
    await act(async () => { root.render(<NativeOperationsWorkspace {...value} />); });
    await act(async () => { root.render(<NativeOperationsWorkspace {...value}
      identity={{ sessionId: "session-2", runId: "run-2", expectedRevision: 9, expectedRegistryFingerprint: "7df8cf3a" }}
      fetchProjection={vi.fn(async () => projection({ sessionId: "session-2", runId: "run-2", revision: 9 }))} />); });
    expect(host.textContent).toContain("REV 9");
    await act(async () => resolveOld(projection()));
    expect(host.textContent).not.toContain("REV 7");
  });

  it("shows no partial rows on overflow and keeps dangerous actions disabled", async () => {
    const overflow = projection({ alerts: { status: "overflow", totalCount: 1025, criticalCount: 1025, warningCount: 0, rows: [] } });
    await act(async () => { root.render(<NativeOperationsWorkspace {...props({ fetchProjection: vi.fn(async () => overflow) })} />); });
    expect(host.textContent).toContain("不会显示任何行");
    await act(async () => button(host, "存档").click());
    expect(button(host, "导入 / 确认导入").disabled).toBe(true);
    expect(button(host, "恢复 / 覆盖").disabled).toBe(true);
    expect(host.textContent).not.toContain("无供电");
  });

  it("submits one semantic leaf intent without a patch", async () => {
    const commitSetting = vi.fn(async (_request: unknown) => ({}));
    await act(async () => { root.render(<NativeOperationsWorkspace {...props({ commitSetting })} />); });
    await act(async () => button(host, "设置").click());
    const select = selectInLabel(host, "模拟速度");
    await act(async () => { select.value = "2"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(commitSetting).toHaveBeenCalledWith({
      expectedSessionId: "session-1", expectedRunId: "run-1", expectedRevision: 7,
      expectedRegistryFingerprint: "7df8cf3a", intent: { type: "set-simulation-speed", value: 2 },
    });
    expect(JSON.stringify(commitSetting.mock.calls[0][0])).not.toContain("topLevelChanges");
  });

  it("keeps a durable ACK locked until a newer projection and rejects consecutive intents", async () => {
    let resolveCommit!: (value: unknown) => void;
    const commitSetting = vi.fn(() => new Promise((resolve) => { resolveCommit = resolve; }));
    const value = props({ commitSetting });
    await act(async () => { root.render(<NativeOperationsWorkspace {...value} />); });
    await act(async () => button(host, "设置").click());
    const speed = selectInLabel(host, "模拟速度");
    await act(async () => {
      speed.value = "2";
      speed.dispatchEvent(new Event("change", { bubbles: true }));
      speed.value = "4";
      speed.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(commitSetting).toHaveBeenCalledTimes(1);
    expect(selectInLabel(host, "模拟速度").disabled).toBe(true);

    await act(async () => resolveCommit({}));
    expect(host.textContent).toContain("等待新 authority revision");
    expect(selectInLabel(host, "模拟速度").disabled).toBe(true);

    await act(async () => { root.render(<NativeOperationsWorkspace {...value}
      identity={{ sessionId: "session-1", runId: "run-1", expectedRevision: 8, expectedRegistryFingerprint: "7df8cf3a" }}
      fetchProjection={vi.fn(async () => projection({ revision: 8, settings: { ...projection().settings, simulationSpeed: 2 } }))} />); });
    expect(host.textContent).toContain("REV 8");
    expect(selectInLabel(host, "模拟速度").disabled).toBe(false);
    expect(selectInLabel(host, "模拟速度").value).toBe("2");
  });

  it("resets controlled drafts on projection identity and ignores a stale commit completion", async () => {
    let resolveCommit!: (value: unknown) => void;
    const commitSetting = vi.fn(() => new Promise((resolve) => { resolveCommit = resolve; }));
    const value = props({ commitSetting });
    await act(async () => { root.render(<NativeOperationsWorkspace {...value} />); });
    await act(async () => button(host, "设置").click());
    const buffer = inputInLabel(host, "生产缓冲");
    await act(async () => {
      buffer.value = "4321";
      buffer.dispatchEvent(new Event("input", { bubbles: true }));
      buffer.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(inputInLabel(host, "生产缓冲").value).toBe("4321");
    const speed = selectInLabel(host, "模拟速度");
    await act(async () => {
      speed.value = "2";
      speed.dispatchEvent(new Event("change", { bubbles: true }));
    });

    await act(async () => { root.render(<NativeOperationsWorkspace {...value}
      identity={{ sessionId: "session-2", runId: "run-2", expectedRevision: 9, expectedRegistryFingerprint: "7df8cf3a" }}
      fetchProjection={vi.fn(async () => projection({
        sessionId: "session-2", runId: "run-2", revision: 9,
        settings: { ...projection().settings, productionBufferLimit: 9000 },
      }))} />); });
    expect(inputInLabel(host, "生产缓冲").value).toBe("9000");
    expect(selectInLabel(host, "模拟速度").disabled).toBe(false);

    await act(async () => resolveCommit({}));
    expect(host.textContent).not.toContain("等待新 authority revision");
    expect(inputInLabel(host, "生产缓冲").value).toBe("9000");
  });
});
