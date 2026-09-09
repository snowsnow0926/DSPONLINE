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
    productionBufferLimit: 1_000_000,
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

  function renderLimits(value: NativeFactoryInventoryFrame | null, callbacks: {
    onSetTrayItemLimit: (value: number) => void;
    onSetProductionBufferLimit: (value: number) => void;
  }, pending = false) {
    act(() => root.render(<NativeResourceRail frame={value} pending={pending}
      entityDepositEnabled={false} onPickTray={vi.fn()} onDropCargo={vi.fn()}
      onStowEntityInventory={vi.fn()} {...callbacks} />));
  }

  function typeLimit(input: HTMLInputElement, value: string) {
    act(() => {
      input.focus();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  const editableLimits = [
    { selector: ".tray-limit-control input", callback: "onSetTrayItemLimit", field: "trayItemLimit", otherField: "productionBufferLimit" },
    { selector: ".production-buffer-limit-control input", callback: "onSetProductionBufferLimit", field: "productionBufferLimit", otherField: "trayItemLimit" },
  ] as const;

  it.each(editableLimits)("preserves $field drafts and errors while unrelated Rust projections advance", ({ selector, callback, otherField }) => {
    const callbacks = { onSetTrayItemLimit: vi.fn(), onSetProductionBufferLimit: vi.fn() };
    const initial = frame();
    renderLimits(initial, callbacks);
    const input = host.querySelector<HTMLInputElement>(selector)!;
    typeLimit(input, "2500");
    renderLimits({ ...initial, revision: 10 }, callbacks);
    expect(input.value).toBe("2500");
    renderLimits({ ...initial, revision: 11, [otherField]: 5000 }, callbacks);
    expect(input.value).toBe("2500");
    act(() => input.blur());
    expect(callbacks[callback]).toHaveBeenCalledExactlyOnceWith(2500);

    typeLimit(input, "1e3");
    act(() => input.blur());
    expect(host.textContent).toContain("不支持小数、负数或指数格式");
    renderLimits({ ...initial, revision: 12, [otherField]: 5000 }, callbacks);
    expect(input.value).toBe("1e3");
    expect(host.textContent).toContain("不支持小数、负数或指数格式");
    expect(callbacks[callback]).toHaveBeenCalledTimes(1);
  });

  it.each(editableLimits)("Escape cancels the $field draft without submitting a native command", ({ selector, field, callback }) => {
    const callbacks = { onSetTrayItemLimit: vi.fn(), onSetProductionBufferLimit: vi.fn() };
    const initial = frame();
    renderLimits(initial, callbacks);
    const input = host.querySelector<HTMLInputElement>(selector)!;
    typeLimit(input, "2500");
    act(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(input.value).toBe(String(initial[field]));
    expect(callbacks[callback]).not.toHaveBeenCalled();
  });

  it.each(editableLimits)("invalidates $field drafts when the native owner or authoritative value changes", ({ selector, field, callback }) => {
    const callbacks = { onSetTrayItemLimit: vi.fn(), onSetProductionBufferLimit: vi.fn() };
    const initial = frame();
    const replacements: Array<NativeFactoryInventoryFrame | null> = [
      { ...initial, sessionId: "session-b" },
      { ...initial, runId: "run-b" },
      { ...initial, registryFingerprint: "builtin:other" },
      { ...initial, activePlanetId: "ashen" },
      { ...initial, [field]: 7000 },
      null,
    ];
    for (const replacement of replacements) {
      renderLimits(initial, callbacks);
      const input = host.querySelector<HTMLInputElement>(selector)!;
      typeLimit(input, "2500");
      renderLimits(replacement, callbacks);
      act(() => input.blur());
      expect(callbacks[callback]).not.toHaveBeenCalled();
      const visible = host.querySelector<HTMLInputElement>(selector);
      if (replacement) expect(visible?.value).toBe(String(replacement[field]));
      else expect(visible).toBeNull();
    }
  });

  it.each(editableLimits)("retains an unsubmitted $field draft while another native command is pending", ({ selector, callback }) => {
    const callbacks = { onSetTrayItemLimit: vi.fn(), onSetProductionBufferLimit: vi.fn() };
    const initial = frame();
    renderLimits(initial, callbacks);
    const input = host.querySelector<HTMLInputElement>(selector)!;
    typeLimit(input, "2500");
    renderLimits({ ...initial, revision: 10 }, callbacks, true);
    expect(input.disabled).toBe(true);
    act(() => input.blur());
    expect(callbacks[callback]).not.toHaveBeenCalled();
    renderLimits({ ...initial, revision: 11 }, callbacks);
    expect(input.value).toBe("2500");
    act(() => { input.focus(); input.blur(); });
    expect(callbacks[callback]).toHaveBeenCalledExactlyOnceWith(2500);
  });

  it("fails closed without a same-revision frame", () => {
    act(() => root.render(<NativeResourceRail
      frame={null}
      pending={false}
      entityDepositEnabled={false}
      onPickTray={vi.fn()}
      onDropCargo={vi.fn()}
      onStowEntityInventory={vi.fn()}
      onSetTrayItemLimit={vi.fn()}
      onSetProductionBufferLimit={vi.fn()}
    />));
    expect(host.querySelector("[data-native-authority-unavailable='tray-cargo-v1']")).not.toBeNull();
    expect(host.textContent).toContain("旧网页库存不会显示");
  });

  it("shows oversized historical cargo without truncating it and returns through the native callback", () => {
    const onDropCargo = vi.fn();
    act(() => root.render(<NativeResourceRail
      frame={frame()}
      pending={false}
      entityDepositEnabled={false}
      onPickTray={vi.fn()}
      onDropCargo={onDropCargo}
      onStowEntityInventory={vi.fn()}
      onSetTrayItemLimit={vi.fn()}
      onSetProductionBufferLimit={vi.fn()}
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
      entityDepositEnabled={false}
      onPickTray={vi.fn()}
      onDropCargo={vi.fn()}
      onStowEntityInventory={vi.fn()}
      onSetTrayItemLimit={vi.fn()}
      onSetProductionBufferLimit={vi.fn()}
    />));
    expect([...host.querySelectorAll<HTMLButtonElement>("button")].every((button) => button.disabled)).toBe(true);
    expect([...host.querySelectorAll<HTMLInputElement>(".tray-limit-control input")]
      .every((input) => input.disabled)).toBe(true);
    expect(host.textContent).toContain("命令确认中");
  });

  it("validates and submits the global production-building buffer limit", () => {
    const onSetProductionBufferLimit = vi.fn();
    act(() => root.render(<NativeResourceRail
      frame={{ ...frame(), cargo: null }}
      pending={false}
      entityDepositEnabled={false}
      onPickTray={vi.fn()}
      onDropCargo={vi.fn()}
      onStowEntityInventory={vi.fn()}
      onSetTrayItemLimit={vi.fn()}
      onSetProductionBufferLimit={onSetProductionBufferLimit}
    />));
    const input = host.querySelector<HTMLInputElement>("[aria-label='生产建筑缓存上限']")!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      input.focus();
      setValue.call(input, "250000");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.blur();
    });
    expect(onSetProductionBufferLimit).toHaveBeenCalledWith(250_000);

    act(() => {
      input.focus();
      setValue.call(input, "1e3");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.blur();
    });
    expect(onSetProductionBufferLimit).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain("不支持小数、负数或指数格式");
  });

  it("keeps mixed cargo picks disabled and warns about over-limit rows", () => {
    act(() => root.render(<NativeResourceRail
      frame={frame()}
      pending={false}
      entityDepositEnabled={false}
      onPickTray={vi.fn()}
      onDropCargo={vi.fn()}
      onStowEntityInventory={vi.fn()}
      onSetTrayItemLimit={vi.fn()}
      onSetProductionBufferLimit={vi.fn()}
    />));
    const rows = [...host.querySelectorAll<HTMLButtonElement>(".tray-row")];
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.disabled)).toBe(true);
    expect(rows[1].title).toContain("超过当前自动写入上限");
  });

  it("routes permanent discard as an exact row request without mutating the projection", () => {
    const onDiscardTrayItem = vi.fn();
    const source = { ...frame(), cargo: null };
    act(() => root.render(<NativeResourceRail
      frame={source}
      pending={false}
      entityDepositEnabled={false}
      onPickTray={vi.fn()}
      onDropCargo={vi.fn()}
      onStowEntityInventory={vi.fn()}
      onSetTrayItemLimit={vi.fn()}
      onSetProductionBufferLimit={vi.fn()}
      onDiscardTrayItem={onDiscardTrayItem}
    />));
    const discard = host.querySelector<HTMLButtonElement>("[aria-label='永久丢弃全部铁矿石']")!;
    act(() => discard.click());
    expect(onDiscardTrayItem).toHaveBeenCalledWith("iron_ore", 75);
    expect(source.rowsByItemId.get("iron_ore")?.amount).toBe(75);
  });

  it("accepts only entity input/output drags while the exact frame is ready", () => {
    const onStowEntityInventory = vi.fn();
    act(() => root.render(<NativeResourceRail
      frame={{ ...frame(), cargo: null }}
      pending={false}
      entityDepositEnabled={false}
      onPickTray={vi.fn()}
      onDropCargo={vi.fn()}
      onStowEntityInventory={onStowEntityInventory}
      onSetTrayItemLimit={vi.fn()}
      onSetProductionBufferLimit={vi.fn()}
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

  it("originates only same-revision tray drags when ordinary entity deposit is enabled", () => {
    const onPickTray = vi.fn();
    act(() => root.render(<NativeResourceRail
      frame={frame()}
      pending={false}
      entityDepositEnabled
      onPickTray={onPickTray}
      onDropCargo={vi.fn()}
      onStowEntityInventory={vi.fn()}
      onSetTrayItemLimit={vi.fn()}
      onSetProductionBufferLimit={vi.fn()}
    />));
    const row = host.querySelector<HTMLButtonElement>(".tray-row")!;
    expect(row.disabled).toBe(false);
    expect(row.draggable).toBe(true);
    act(() => row.click());
    expect(onPickTray).not.toHaveBeenCalled();
    const payload: Record<string, string> = {};
    const drag = new Event("dragstart", { bubbles: true, cancelable: true });
    Object.defineProperty(drag, "dataTransfer", { value: {
      setData: (type: string, value: string) => { payload[type] = value; },
      effectAllowed: "none",
    } });
    act(() => row.dispatchEvent(drag));
    expect(payload).toEqual({
      "application/factory-item": "iron_ore",
      "application/factory-source-kind": "tray",
    });
  });
});
