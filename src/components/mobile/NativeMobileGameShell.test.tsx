// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NativeMobileGameShell } from "./NativeMobileGameShell";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const noop = () => undefined;

function props(overrides: Partial<ComponentProps<typeof NativeMobileGameShell>> = {}) {
  return {
    enabled: true,
    layout: { mode: "compact-portrait" as const, width: 390, height: 844, isMobileShell: true, isPortrait: true },
    frame: null,
    inventoryFrame: null,
    constructionFrame: null,
    pending: false,
    alertCount: 0,
    route: { kind: "factory" as const },
    overlay: null,
    tools: {
      mode: "browse" as const,
      blueprintCount: 2,
      beltCount: 7,
      regionCount: 3,
      canUndo: false,
      canRedo: false,
      canUndoAutoLayout: false,
      minimapOpen: false,
      batchConnectionMode: false,
    },
    toolActions: {
      onBrowse: noop,
      onSelect: noop,
      onRegion: noop,
      onLayout: noop,
      onOpenBlueprints: noop,
      onOpenNetworks: noop,
      onBatchConnectionModeChange: noop,
      onAutoLayout: noop,
      onUndoAutoLayout: noop,
      onUndo: noop,
      onRedo: noop,
      onZoomIn: noop,
      onZoomOut: noop,
      onFitView: noop,
      onToggleMinimap: noop,
    },
    selectedBuildingId: null,
    selectedBeltTier: null,
    beltLanes: 1,
    hasConstructionCenter: false,
    onPlacementChange: noop,
    onBeltPlacementChange: noop,
    onBeltLanesChange: noop,
    onDeleteConstruction: noop,
    onOpenFabricator: noop,
    onPickTray: noop,
    onDropCargo: noop,
    onStowEntityInventory: noop,
    entityDepositEnabled: false,
    onSetTrayItemLimit: noop,
    onSetProductionBufferLimit: noop,
    onDiscardTrayItem: noop,
    onFactory: noop,
    onOpenHub: noop,
    onOpenSheet: noop,
    onSheetSnap: noop,
    onOpenWorkspace: noop,
    onOpenOrbitalStation: noop,
    onOpenStatistics: noop,
    onOpenOperations: noop,
    onOpenGalaxy: noop,
    onOpenCommandPalette: noop,
    onBack: noop,
    onTogglePause: noop,
    onPlanetChange: () => true,
    onConfirmExit: noop,
    onDismissExit: noop,
    onRequestExit: noop,
    onSwitchLegacy: noop,
    ...overrides,
  } satisfies ComponentProps<typeof NativeMobileGameShell>;
}

describe("NativeMobileGameShell", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("fails closed while native projections load and never falls back to a legacy state", () => {
    act(() => root.render(<NativeMobileGameShell {...props()} />));
    const shell = host.querySelector("[data-native-mobile-shell='thin-v1']");
    expect(shell).not.toBeNull();
    expect(shell?.getAttribute("data-native-revision")).toBe("loading");
    expect(host.textContent).toContain("同步中");
    expect(host.textContent).not.toContain("Windows 原生权威正在使用桌面薄界面");
  });

  it("routes tool mutations through callbacks and keeps unavailable history disabled", () => {
    const onRegion = vi.fn();
    act(() => root.render(<NativeMobileGameShell {...props({
      overlay: { kind: "sheet", id: "tools", snap: "half" },
      toolActions: { ...props().toolActions, onRegion },
    })} />));
    const region = [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("生产区域"));
    act(() => region?.click());
    expect(onRegion).toHaveBeenCalledTimes(1);
    const undo = [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("撤销"));
    expect((undo as HTMLButtonElement).disabled).toBe(true);
    expect(host.textContent).toContain("7");
  });

  it("has no GameState dependency in the thin mobile source", () => {
    const source = readFileSync(resolve(process.cwd(), "src/components/mobile/NativeMobileGameShell.tsx"), "utf8");
    expect(source).not.toMatch(/\bGameState\b/u);
    expect(source).toContain("data-native-mobile-shell=\"thin-v1\"");
  });
});
