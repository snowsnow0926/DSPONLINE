// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProductionHistorySample } from "../game/types";
import { NativeStatisticsWorkspace } from "./NativeStatisticsWorkspace";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function sample(elapsedSeconds: number, production: number, consumption: number): ProductionHistorySample {
  return {
    elapsedSeconds,
    sampleDurationSeconds: 1,
    productionPerMinute: { iron_ore: production, "模组:矿": production / 2 },
    consumptionPerMinute: { iron_ore: consumption },
    inventory: { iron_ore: 1234, "模组:矿": 9 },
    generationKw: 500,
    demandKw: 450,
  } as ProductionHistorySample;
}

describe("NativeStatisticsWorkspace", () => {
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

  it("renders bounded Rust samples, including opaque item ids, without GameState", () => {
    act(() => root.render(<NativeStatisticsWorkspace
      open
      revision={17}
      samples={[sample(1, 60, 10), sample(2, 120, 20)]}
      onClose={() => undefined}
    />));

    expect(host.querySelector("[data-native-statistics='history-v1']")?.textContent).toContain("revision 17");
    expect(host.textContent).toContain("铁矿");
    expect(host.textContent).toContain("模组:矿");
    expect(host.querySelectorAll(".production-history-line")).toHaveLength(2);
    expect(host.textContent).toContain("不会读取旧网页存档");
  });

  it("filters rows and closes through the workspace control", () => {
    const onClose = vi.fn();
    act(() => root.render(<NativeStatisticsWorkspace open revision={3} samples={[sample(1, 60, 10)]} onClose={onClose} />));
    const input = host.querySelector<HTMLInputElement>("input[aria-label='筛选原生统计物品']")!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "模组");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(host.textContent).toContain("模组:矿");
    expect(host.querySelectorAll(".statistics-row")).toHaveLength(1);
    act(() => host.querySelector<HTMLButtonElement>("button[aria-label='关闭生产统计']")!.click());
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
