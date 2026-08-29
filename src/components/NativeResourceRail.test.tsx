// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NativeFactoryInventoryFrame } from "../game/nativeFactoryInventoryStore";
import { NativeResourceRail } from "./NativeResourceRail";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function frame(): NativeFactoryInventoryFrame {
  const rows = [
    { itemId: "iron_ore", amount: 75, freeCapacity: 925, overLimit: false },
    { itemId: "copper_ore", amount: 1_250, freeCapacity: 0, overLimit: true },
  ] as const;
  return {
    source: "native-core",
    sessionId: "session-a",
    runId: "run-a",
    revision: 9,
    registryFingerprint: "builtin:test",
    activePlanetId: "home",
    cargo: { itemId: "iron_ore", amount: 125, origin: { kind: "tray", id: null } },
    pickupTargetAmount: 100,
    portableFleet: { logistics_drone: 2, logistics_vessel: 3 },
    trayItemLimit: 1_000,
    trayItemLimitBounds: { minimum: 1_000, default: 1_000_000, maximum: 100_000_000 },
    rows,
    rowsByItemId: new Map(rows.map((row) => [row.itemId, row])),
  };
}

describe("NativeResourceRail", () => {
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

  it("fails closed without a same-revision frame", () => {
    act(() => root.render(<NativeResourceRail
      frame={null}
      pending={false}
      onPickTray={vi.fn()}
      onDropCargo={vi.fn()}
      onStowEntityInventory={vi.fn()}
      onSetTrayItemLimit={vi.fn()}
    />));
    expect(host.querySelector("[data-native-authority-unavailable='tray-cargo-v1']")).not.toBeNull();
    expect(host.textContent).toContain("旧网页库存不会显示");
  });

  it("shows oversized historical cargo without truncating it and returns through the native callback", () => {
    const onDropCargo = vi.fn();
    act(() => root.render(<NativeResourceRail
      frame={frame()}
      pending={false}
      onPickTray={vi.fn()}
      onDropCargo={onDropCargo}
      onStowEntityInventory={vi.fn()}
      onSetTrayItemLimit={vi.fn()}
    />));
    expect(host.textContent).toContain("125");
    expect(host.textContent).toContain("会原样保留并可整栈放回");
    const cargoButton = host.querySelector<HTMLButtonElement>(".cargo-slot")!;
    act(() => cargoButton.click());
    expect(onDropCargo).toHaveBeenCalledTimes(1);
  });

  it("disables every mutation while another native command is unsettled", () => {
    act(() => root.render(<NativeResourceRail
      frame={{ ...frame(), cargo: null }}
      pending
      onPickTray={vi.fn()}
      onDropCargo={vi.fn()}
      onStowEntityInventory={vi.fn()}
      onSetTrayItemLimit={vi.fn()}
    />));
    expect([...host.querySelectorAll<HTMLButtonElement>("button")].every((button) => button.disabled)).toBe(true);
    expect(host.querySelector<HTMLInputElement>(".tray-limit-control input")?.disabled).toBe(true);
    expect(host.textContent).toContain("命令确认中");
  });

  it("keeps mixed cargo picks disabled and warns about over-limit rows", () => {
    act(() => root.render(<NativeResourceRail
      frame={frame()}
      pending={false}
      onPickTray={vi.fn()}
      onDropCargo={vi.fn()}
      onStowEntityInventory={vi.fn()}
      onSetTrayItemLimit={vi.fn()}
    />));
    const rows = [...host.querySelectorAll<HTMLButtonElement>(".tray-row")];
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.disabled)).toBe(true);
    expect(rows[1].title).toContain("超过当前自动写入上限");
  });

  it("accepts only entity input/output drags while the exact frame is ready", () => {
    const onStowEntityInventory = vi.fn();
    act(() => root.render(<NativeResourceRail
      frame={{ ...frame(), cargo: null }}
      pending={false}
      onPickTray={vi.fn()}
      onDropCargo={vi.fn()}
      onStowEntityInventory={onStowEntityInventory}
      onSetTrayItemLimit={vi.fn()}
    />));
    const tray = host.querySelector<HTMLElement>("[data-native-entity-stow='same-revision-v1']")!;
    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", { value: {
      types: ["application/factory-item"],
      getData: (type: string) => ({
        "application/factory-item": "iron_ore",
        "application/factory-source-kind": "node-output",
        "application/factory-source-id": "machine-a",
      } as Record<string, string>)[type] ?? "",
    } });
    act(() => tray.dispatchEvent(drop));
    expect(onStowEntityInventory).not.toHaveBeenCalled();

    const accepted = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(accepted, "dataTransfer", { value: {
      types: ["application/factory-item"],
      getData: (type: string) => ({
        "application/factory-item": "iron_ore",
        "application/factory-source-kind": "node",
        "application/factory-source-id": "machine-a",
      } as Record<string, string>)[type] ?? "",
    } });
    act(() => tray.dispatchEvent(accepted));
    expect(onStowEntityInventory).toHaveBeenCalledWith("iron_ore", "node", "machine-a");
  });
});
