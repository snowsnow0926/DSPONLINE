// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NativeConstructionCenterWorkspaceFrame } from "../game/nativeConstructionCenterWorkspace";
import { NativeConstructionCenterWorkspace } from "./NativeConstructionCenterWorkspace";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const rows = <Row,>(values: Row[]) => ({ rows: values, totalCount: values.length, truncated: false });
const quantities = <Row extends { amount: number },>(values: Row[]) => ({
  ...rows(values),
  totalAmount: values.reduce((sum, row) => sum + row.amount, 0),
});

function frame(): NativeConstructionCenterWorkspaceFrame {
  return {
    source: "native-authoritative",
    sessionId: "session-a",
    runId: "run-a",
    revision: 19,
    activePlanetId: "home",
    workspace: {
      schema: "construction-center-workspace-v1",
      registryFingerprint: "7df8cf3a",
      readOnly: true,
      activePlanetId: "home",
      activePlanetName: "家园星",
      paused: false,
      enabled: true,
      quantumSourceEnabled: true,
      quantumNetworkEnabled: true,
      totalCrafted: 3,
      lastCraftedId: "wind_turbine",
      lastCraftedName: "风力涡轮机",
      stockLimit: 500,
      cycleSeconds: 2.5,
      materialSeconds: 0.05,
      targets: rows([{
        targetId: "wind_turbine",
        name: "风力涡轮机",
        kind: "building",
        category: "power",
        target: 50,
        currentStock: 41,
        unlocked: true,
        requiredTechId: "electromagnetism",
        requiredTechName: "电磁学",
        outputAmount: 1,
        costs: rows([{ itemId: "iron_ore", name: "铁矿石", amount: 6 }]),
      }, {
        targetId: "logistics_drone",
        name: "物流运输机",
        kind: "fleet",
        category: "logistics",
        target: 10,
        currentStock: 7,
        unlocked: true,
        requiredTechId: "planetary_logistics",
        requiredTechName: "行星物流",
        outputAmount: 1,
        costs: rows([{ itemId: "processor", name: "处理器", amount: 2 }]),
      }]),
      centers: rows([{
        entityId: "center-a",
        planetId: "home",
        planetName: "家园星",
        machineCount: 2,
        status: "working",
      }]),
      jobs: rows([{
        entityId: "center-a",
        targetId: "wind_turbine",
        targetName: "风力涡轮机",
        stepIndex: 1,
        stepCount: 2,
        elapsedSeconds: 0.5,
        inventory: quantities([{ itemId: "iron_ore", name: "铁矿石", amount: 2 }]),
      }]),
      materials: quantities([{ itemId: "iron_ore", name: "铁矿石", amount: 123 }]),
      quantumBuffer: quantities([{ entityId: "center-a", itemId: "processor", name: "处理器", amount: 4 }]),
      destroyedByproducts: quantities([{ itemId: "iron_ore", name: "铁矿石", amount: 3 }]),
      limits: {
        targetRows: 128,
        centerRows: 64,
        jobRows: 64,
        materialRows: 256,
        quantumBufferRows: 256,
        destroyedByproductRows: 256,
        costRowsPerTarget: 32,
        projectionBytes: 1048576,
      },
    },
  };
}

describe("NativeConstructionCenterWorkspace", () => {
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

  function render(value: NativeConstructionCenterWorkspaceFrame | null, readStatus: "loading" | "ready" | "unavailable" = "ready") {
    const onClose = vi.fn();
    act(() => root.render(<NativeConstructionCenterWorkspace open frame={value} readStatus={readStatus} onClose={onClose} />));
    return onClose;
  }

  it("renders only the identity-bound Rust catalog and keeps every write control disabled", () => {
    render(frame());
    const header = host.querySelector("[data-native-authority-session='session-a']");
    expect(header?.getAttribute("data-native-authority-run")).toBe("run-a");
    expect(header?.getAttribute("data-native-authority-revision")).toBe("19");
    expect(header?.getAttribute("data-native-authority-planet")).toBe("home");
    expect(host.textContent).toContain("原生写入尚未开放");
    expect(host.textContent).toContain("风力涡轮机");
    expect(host.textContent).toContain("物流运输机");
    expect(host.textContent).toContain("铁矿石");
    expect(host.textContent).toContain("处理器");
    for (const control of host.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>("button[title='原生写入尚未开放'], input[aria-label*='只读'], input[aria-label*='尚未开放'], select[aria-label*='尚未开放']")) {
      expect(control.disabled).toBe(true);
    }
    expect(host.querySelector<HTMLInputElement>("input[type='checkbox']")?.disabled).toBe(true);
    expect(host.querySelector<HTMLInputElement>("[aria-label='搜索原生自动制造目标']")?.disabled).toBe(false);
  });

  it("uses enabled controls only for local search and category filtering", () => {
    render(frame());
    const search = host.querySelector<HTMLInputElement>("[aria-label='搜索原生自动制造目标']")!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "处理器");
      search.dispatchEvent(new InputEvent("input", { bubbles: true, data: "处理器", inputType: "insertText" }));
    });
    expect(host.querySelector("[data-native-construction-target-id='wind_turbine']")).toBeNull();
    expect(host.querySelector("[data-native-construction-target-id='logistics_drone']")).not.toBeNull();
    act(() => host.querySelector<HTMLButtonElement>(".construction-center-categories button:nth-child(5)")!.click());
    expect(host.querySelector("[data-native-construction-target-id]")).toBeNull();
  });

  it("fails closed without a complete built-in frame and has no legacy state dependency", () => {
    render(null, "unavailable");
    expect(host.textContent).toContain("目录不受支持，已安全关闭展示");
    expect(host.textContent).toContain("不会回退读取旧渲染器状态");
    expect(host.querySelector("[data-native-construction-target-id]")).toBeNull();

    const source = readFileSync(resolve("src/components/NativeConstructionCenterWorkspace.tsx"), "utf8");
    expect(source).not.toMatch(/from\s+["']\.\.\/game\/(?:engine|content|types)["']/);
    expect(source).not.toMatch(/\bGameState\b|\bgame\.|getConstructionAutomationStatus|getStatus\s*\(/);
    expect(source).not.toMatch(/on(?:Enabled|QuantumSource|Target|BatchTarget|Cancel|Refund|Move|Discard|Fund)\b/);
  });
});
