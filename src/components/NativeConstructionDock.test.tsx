// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NativeConstructionInventoryFrame } from "../game/nativeConstructionInventoryStore";
import { NativeConstructionDock } from "./NativeConstructionDock";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function frame(): NativeConstructionInventoryFrame {
  const rows = [
    { buildingId: "arc_smelter", amount: 2 },
    { buildingId: "conveyor_belt_mk3", amount: 3_000 },
    { buildingId: "MOD/quantum-factory", amount: 7 },
  ] as const;
  return {
    source: "native-core",
    readOnly: true,
    sessionId: "session-a",
    runId: "run-a",
    revision: 9,
    registryFingerprint: "builtin:test",
    rows,
    rowsByBuildingId: new Map(rows.map((row) => [row.buildingId, row])),
    totalAmount: 3_009,
  };
}

describe("NativeConstructionDock", () => {
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

  it("fails closed without a same-revision Rust frame", () => {
    act(() => root.render(<NativeConstructionDock
      frame={null}
      selectedBuildingId={null}
      selectedBeltTier={null}
      beltLanes={1}
      pending={false}
      onPlacementChange={() => undefined}
      onBeltPlacementChange={() => undefined}
      onBeltLanesChange={() => undefined}
    />));
    expect(host.querySelector("[data-native-authority-unavailable='construction-inventory-v1']")).not.toBeNull();
    expect(host.textContent).toContain("旧网页库存不会显示");
  });

  it("exposes explicit built-in belt tiers and opaque MOD placement candidates", () => {
    const onPlacementChange = vi.fn();
    const onBeltPlacementChange = vi.fn();
    act(() => root.render(<NativeConstructionDock
      frame={frame()}
      selectedBuildingId={null}
      selectedBeltTier={null}
      beltLanes={4}
      pending={false}
      onPlacementChange={onPlacementChange}
      onBeltPlacementChange={onBeltPlacementChange}
      onBeltLanesChange={() => undefined}
    />));
    expect(host.textContent).toContain("传送带 Mk.III");
    expect(host.textContent).toContain("MOD/quantum-factory");
    expect(host.textContent).toContain("3,009");
    const buttons = [...host.querySelectorAll<HTMLButtonElement>("button")];
    expect(buttons[0].disabled).toBe(false);
    expect(buttons[1].disabled).toBe(false);
    expect(buttons[2].disabled).toBe(false);
    act(() => buttons[1].click());
    expect(onBeltPlacementChange).toHaveBeenCalledWith(3);
    act(() => buttons[2].click());
    expect(onPlacementChange).toHaveBeenCalledWith("MOD/quantum-factory");
    expect(host.querySelector("[data-native-construction-placement='ordinary-single-v1']")).not.toBeNull();
  });

  it("marks the selected row and disables all placement while a command is pending", () => {
    act(() => root.render(<NativeConstructionDock
      frame={frame()}
      selectedBuildingId="MOD/quantum-factory"
      selectedBeltTier={null}
      beltLanes={1}
      pending
      onPlacementChange={() => undefined}
      onBeltPlacementChange={() => undefined}
      onBeltLanesChange={() => undefined}
    />));
    const buttons = [...host.querySelectorAll<HTMLButtonElement>("button")];
    expect(buttons.every((button) => button.disabled)).toBe(true);
    expect(buttons[2].getAttribute("aria-pressed")).toBe("true");
  });
});
