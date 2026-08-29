// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { NativeConstructionInventoryFrame } from "../game/nativeConstructionInventoryStore";
import { NativeConstructionDock } from "./NativeConstructionDock";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function frame(): NativeConstructionInventoryFrame {
  const rows = [
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
    totalAmount: 3_007,
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
    act(() => root.render(<NativeConstructionDock frame={null} />));
    expect(host.querySelector("[data-native-authority-unavailable='construction-inventory-v1']")).not.toBeNull();
    expect(host.textContent).toContain("旧网页库存不会显示");
  });

  it("renders core and MOD rows without importing GameState interactions", () => {
    act(() => root.render(<NativeConstructionDock frame={frame()} />));
    expect(host.textContent).toContain("传送带 Mk.III");
    expect(host.textContent).toContain("MOD/quantum-factory");
    expect(host.textContent).toContain("3,007");
    expect([...host.querySelectorAll<HTMLButtonElement>("button")].every((button) => button.disabled)).toBe(true);
    expect(host.querySelector("[data-native-construction-read-only='true']")).not.toBeNull();
  });
});
