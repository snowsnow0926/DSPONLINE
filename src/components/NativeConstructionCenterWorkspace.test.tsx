// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  NativeConstructionCenterBatchBuildingTargetStockSubmission,
  NativeConstructionCenterFrameIdentity,
  NativeConstructionCenterPendingIdentity,
  NativeConstructionCenterTargetStockSubmission,
} from "../game/nativeConstructionCenterIntent";
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
      writeAvailable: true,
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

  type Callbacks = {
    onClose: ReturnType<typeof vi.fn<() => void>>;
    onSubmitEnabledIntent: ReturnType<typeof vi.fn<(identity: NativeConstructionCenterFrameIdentity, enabled: boolean) => void>>;
    onSubmitQuantumSupplyIntent: ReturnType<typeof vi.fn<(identity: NativeConstructionCenterFrameIdentity, enabled: boolean) => void>>;
    onSubmitBatchBuildingTargetStockIntent: ReturnType<typeof vi.fn<(submission: NativeConstructionCenterBatchBuildingTargetStockSubmission) => void>>;
    onSubmitTargetStockIntent: ReturnType<typeof vi.fn<(submission: NativeConstructionCenterTargetStockSubmission) => void>>;
  };

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  function render(
    value: NativeConstructionCenterWorkspaceFrame | null,
    readStatus: "loading" | "ready" | "unavailable" = "ready",
    pendingIdentity: NativeConstructionCenterPendingIdentity | null = null,
    callbacks: Callbacks = {
      onClose: vi.fn<() => void>(),
      onSubmitEnabledIntent: vi.fn<(identity: NativeConstructionCenterFrameIdentity, enabled: boolean) => void>(),
      onSubmitQuantumSupplyIntent: vi.fn<(identity: NativeConstructionCenterFrameIdentity, enabled: boolean) => void>(),
      onSubmitBatchBuildingTargetStockIntent: vi.fn<(submission: NativeConstructionCenterBatchBuildingTargetStockSubmission) => void>(),
      onSubmitTargetStockIntent: vi.fn<(submission: NativeConstructionCenterTargetStockSubmission) => void>(),
    },
    open = true,
    latestIdentity: NativeConstructionCenterFrameIdentity | null | undefined = undefined,
  ) {
    act(() => root.render(<NativeConstructionCenterWorkspace
      open={open}
      frame={value}
      latestIdentity={latestIdentity}
      readStatus={readStatus}
      pendingIdentity={pendingIdentity}
      onClose={callbacks.onClose}
      onSubmitEnabledIntent={callbacks.onSubmitEnabledIntent}
      onSubmitQuantumSupplyIntent={callbacks.onSubmitQuantumSupplyIntent}
      onSubmitBatchBuildingTargetStockIntent={callbacks.onSubmitBatchBuildingTargetStockIntent}
      onSubmitTargetStockIntent={callbacks.onSubmitTargetStockIntent}
    />));
    return callbacks;
  }

  function setInput(input: HTMLInputElement, value: string) {
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new InputEvent("input", { bubbles: true, data: value, inputType: "insertText" }));
    });
  }

  function blur(input: HTMLInputElement) {
    act(() => input.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
  }

  function dialogButton(label: string) {
    return [...host.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')]
      .find((button) => button.textContent === label)!;
  }

  it("submits toggle intents without optimistically changing projected values", () => {
    const callbacks = render(frame());
    const toggles = host.querySelectorAll<HTMLInputElement>(".construction-center-toggle input");
    expect(toggles[0]?.disabled).toBe(false);
    expect(toggles[1]?.disabled).toBe(false);
    act(() => toggles[0]!.click());
    expect(callbacks.onSubmitEnabledIntent).toHaveBeenCalledWith({
      sessionId: "session-a",
      runId: "run-a",
      revision: 19,
      activePlanetId: "home",
    }, false);
    expect(toggles[0]?.checked).toBe(true);
    act(() => toggles[1]!.click());
    expect(callbacks.onSubmitQuantumSupplyIntent).toHaveBeenCalledWith({
      sessionId: "session-a",
      runId: "run-a",
      revision: 19,
      activePlanetId: "home",
    }, false);
    expect(toggles[1]?.checked).toBe(true);
  });

  it("renders only the identity-bound Rust catalog and exposes one atomic batch write", () => {
    render(frame());
    const header = host.querySelector("[data-native-authority-session='session-a']");
    expect(header?.getAttribute("data-native-authority-run")).toBe("run-a");
    expect(header?.getAttribute("data-native-authority-revision")).toBe("19");
    expect(header?.getAttribute("data-native-authority-planet")).toBe("home");
    expect(host.textContent).toContain("全部已解锁建筑目标");
    expect(host.textContent).toContain("不循环命令、不取消任务或退料");
    expect(host.textContent).toContain("风力涡轮机");
    expect(host.textContent).toContain("物流运输机");
    expect(host.textContent).toContain("铁矿石");
    expect(host.textContent).toContain("处理器");
    const batchControls = host.querySelectorAll<HTMLInputElement | HTMLButtonElement>("[aria-label='原生建筑制造批量写入'] button, [aria-label='原生建筑制造批量写入'] input");
    expect(batchControls).toHaveLength(5);
    expect(batchControls[0]?.disabled).toBe(false);
    expect(batchControls[1]?.disabled).toBe(true);
    expect(batchControls[2]?.disabled).toBe(true);
    expect(batchControls[3]?.disabled).toBe(false);
    expect(batchControls[4]?.disabled).toBe(false);
    expect(host.querySelector<HTMLInputElement>("input[type='checkbox']")?.disabled).toBe(false);
    expect(host.querySelector<HTMLInputElement>("[aria-label='风力涡轮机目标库存']")?.disabled).toBe(false);
    expect(host.querySelector<HTMLInputElement>("[aria-label='搜索原生自动制造目标']")?.disabled).toBe(false);
  });

  it("requires a revision-bound confirmation and submits one ID-free batch intent without optimistic changes", () => {
    const callbacks = render(frame());
    const batchInput = host.querySelector<HTMLInputElement>("[aria-label='全部已解锁建筑目标数量']")!;
    expect(batchInput.value).toBe("100");
    act(() => host.querySelector<HTMLButtonElement>("[aria-label='原生建筑制造批量写入'] button")!.click());
    const dialog = host.querySelector('[role="alertdialog"][aria-label="确认批量设置全部已解锁建筑目标"]');
    expect(dialog?.textContent).toContain("检查 1 种建筑");
    expect(dialog?.textContent).toContain("不会取消或退款现有任务");
    expect(callbacks.onSubmitBatchBuildingTargetStockIntent).not.toHaveBeenCalled();
    expect(host.querySelector<HTMLInputElement>("[aria-label='风力涡轮机目标库存']")?.value).toBe("50");

    act(() => dialogButton("确认并提交单条 Rust 意图").click());
    expect(callbacks.onSubmitBatchBuildingTargetStockIntent).toHaveBeenCalledWith({
      sessionId: "session-a",
      runId: "run-a",
      revision: 19,
      activePlanetId: "home",
      target: 100,
      confirmedAffectedCount: 1,
      confirmedChangedCount: 1,
      confirmedLoweredCount: 0,
    });
    expect(host.querySelector<HTMLInputElement>("[aria-label='风力涡轮机目标库存']")?.value).toBe("50");
  });

  it("rejects zero/no-change batch drafts and describes lowering as policy-only", () => {
    const callbacks = render(frame());
    const batchInput = host.querySelector<HTMLInputElement>("[aria-label='全部已解锁建筑目标数量']")!;
    setInput(batchInput, "0");
    act(() => [...host.querySelectorAll<HTMLButtonElement>("[aria-label='原生建筑制造批量写入'] button")].at(-1)!.click());
    expect(host.textContent).toContain("全部建筑目标必须是正安全整数");

    setInput(batchInput, "50");
    act(() => [...host.querySelectorAll<HTMLButtonElement>("[aria-label='原生建筑制造批量写入'] button")].at(-1)!.click());
    expect(host.textContent).toContain("目标策略没有变化");

    setInput(batchInput, "25");
    act(() => [...host.querySelectorAll<HTMLButtonElement>("[aria-label='原生建筑制造批量写入'] button")].at(-1)!.click());
    expect(host.querySelector('[role="alertdialog"]')?.textContent).toContain("其中 1 种会降低目标");
    expect(host.querySelector('[role="alertdialog"]')?.textContent).toContain("不会取消或退款现有任务");
    expect(callbacks.onSubmitBatchBuildingTargetStockIntent).not.toHaveBeenCalled();
  });

  it("supports step, preset, and strict projected increases without optimistic changes", () => {
    const callbacks = render(frame());
    const input = host.querySelector<HTMLInputElement>("[aria-label='风力涡轮机目标库存']")!;
    act(() => host.querySelector<HTMLButtonElement>("[aria-label='增加风力涡轮机目标库存']")!.click());
    expect(callbacks.onSubmitTargetStockIntent).toHaveBeenLastCalledWith(expect.objectContaining({
      targetId: "wind_turbine",
      target: 51,
      confirmedDecreaseFrom: null,
    }));
    callbacks.onSubmitTargetStockIntent.mockClear();

    const preset = host.querySelector<HTMLSelectElement>("[aria-label='风力涡轮机常用目标库存']")!;
    act(() => {
      preset.value = "100";
      preset.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(callbacks.onSubmitTargetStockIntent).toHaveBeenLastCalledWith(expect.objectContaining({
      targetId: "wind_turbine",
      target: 100,
      confirmedDecreaseFrom: null,
    }));
    callbacks.onSubmitTargetStockIntent.mockClear();

    setInput(input, "51");
    blur(input);
    expect(callbacks.onSubmitTargetStockIntent).toHaveBeenCalledWith({
      sessionId: "session-a",
      runId: "run-a",
      revision: 19,
      activePlanetId: "home",
      targetId: "wind_turbine",
      target: 51,
      confirmedDecreaseFrom: null,
    });
    expect(input.value).toBe("50");

    callbacks.onSubmitTargetStockIntent.mockClear();
    setInput(input, "050");
    blur(input);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(host.textContent).toContain("不带符号、小数或前导零");
    expect(callbacks.onSubmitTargetStockIntent).not.toHaveBeenCalled();
  });

  it("requires confirmation for every decrease and identifies cancellation/refund risk", () => {
    const callbacks = render(frame());
    const input = host.querySelector<HTMLInputElement>("[aria-label='风力涡轮机目标库存']")!;
    setInput(input, "49");
    blur(input);
    expect(callbacks.onSubmitTargetStockIntent).not.toHaveBeenCalled();
    expect(host.querySelector('[role="alertdialog"]')?.textContent).toContain("降低目标可能改变后续补货与在途任务");
    act(() => dialogButton("取消").click());

    setInput(input, "41");
    blur(input);
    expect(host.querySelector('[role="alertdialog"]')?.textContent).toContain("取消同目标在途任务并按守恒规则退款");
    act(() => dialogButton("确认降低并提交 Rust").click());
    expect(callbacks.onSubmitTargetStockIntent).toHaveBeenCalledWith({
      sessionId: "session-a",
      runId: "run-a",
      revision: 19,
      activePlanetId: "home",
      targetId: "wind_turbine",
      target: 41,
      confirmedDecreaseFrom: 50,
    });
    expect(input.value).toBe("50");
  });

  it("keeps an Enter-created decrease confirmation through blur and same-value Enter", () => {
    const callbacks = render(frame());
    const input = host.querySelector<HTMLInputElement>("[aria-label='风力涡轮机目标库存']")!;
    setInput(input, "41");
    act(() => input.focus());
    expect(document.activeElement).toBe(input);
    act(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
    expect(document.activeElement).not.toBe(input);
    expect(host.querySelector('[role="alertdialog"]')?.textContent).toContain("取消同目标在途任务并按守恒规则退款");

    act(() => input.focus());
    act(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
    expect(document.activeElement).not.toBe(input);
    expect(host.querySelector('[role="alertdialog"]')).not.toBeNull();

    act(() => dialogButton("确认降低并提交 Rust").click());
    expect(callbacks.onSubmitTargetStockIntent).toHaveBeenCalledTimes(1);
    expect(callbacks.onSubmitTargetStockIntent).toHaveBeenCalledWith(expect.objectContaining({
      targetId: "wind_turbine",
      target: 41,
      confirmedDecreaseFrom: 50,
    }));
  });

  it("cancels a decrease confirmation when identity, filtering, open, or pending changes", () => {
    const callbacks = render(frame());
    const openConfirmation = () => {
      const input = host.querySelector<HTMLInputElement>("[aria-label='风力涡轮机目标库存']")!;
      setInput(input, "49");
      blur(input);
      expect(host.querySelector('[role="alertdialog"]')).not.toBeNull();
    };
    openConfirmation();
    const next = { ...frame(), runId: "run-b" };
    render(next, "ready", null, callbacks);
    expect(host.querySelector('[role="alertdialog"]')).toBeNull();

    openConfirmation();
    act(() => host.querySelector<HTMLButtonElement>(".construction-center-categories button:nth-child(2)")!.click());
    expect(host.querySelector('[role="alertdialog"]')).toBeNull();

    openConfirmation();
    render(next, "ready", {
      sessionId: "session-a",
      runId: "run-b",
      revision: 19,
      activePlanetId: "home",
      kind: "targetStock",
      targetId: "wind_turbine",
      expectedRevision: null,
    }, callbacks);
    expect(host.querySelector('[role="alertdialog"]')).toBeNull();
    expect(host.querySelector<HTMLInputElement>("[aria-label='风力涡轮机目标库存']")?.disabled).toBe(true);

    render(next, "ready", null, callbacks, false);
    expect(host.textContent).toBe("");
    expect(callbacks.onSubmitTargetStockIntent).not.toHaveBeenCalled();
  });

  it("locks all native writes through durable ACK and the awaited projected revision", () => {
    const current = frame();
    const pending: NativeConstructionCenterPendingIdentity = {
      sessionId: "session-a",
      runId: "run-a",
      revision: 19,
      activePlanetId: "home",
      kind: "enabled",
      targetId: null,
      expectedRevision: null,
    };
    render(current, "ready", pending);
    expect(host.textContent).toContain("等待 main-owned durable ACK");
    expect(host.textContent).toContain("界面不会乐观改写");
    expect([...host.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>(
      ".construction-center-toggle input, .construction-center-target input, .construction-center-target button, .construction-center-target select, [aria-label='原生建筑制造批量写入'] input, [aria-label='原生建筑制造批量写入'] button",
    )]
      .every((control) => control.disabled)).toBe(true);
    expect(host.querySelector<HTMLInputElement>("[aria-label='搜索原生自动制造目标']")?.disabled).toBe(false);

    render(current, "ready", { ...pending, expectedRevision: 20 });
    expect(host.textContent).toContain("等待 revision 20");
    expect(host.querySelector<HTMLInputElement>("input[type='checkbox']")?.checked).toBe(true);
    expect(host.querySelector<HTMLInputElement>("[aria-label='风力涡轮机目标库存']")?.value).toBe("50");
  });

  it("locks all native writes when Rust cannot prove construction automation availability", () => {
    const current = frame();
    const unavailable = { ...current, workspace: { ...current.workspace, writeAvailable: false } };
    const callbacks = render(unavailable);
    expect(host.textContent).toContain("Rust 尚未证明制造协议科技与可用制造中心");
    expect([...host.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>(
      ".construction-center-toggle input, .construction-center-target input, .construction-center-target button, .construction-center-target select, [aria-label='原生建筑制造批量写入'] input, [aria-label='原生建筑制造批量写入'] button",
    )].every((control) => control.disabled)).toBe(true);
    act(() => host.querySelector<HTMLInputElement>("input[type='checkbox']")!.click());
    expect(callbacks.onSubmitEnabledIntent).not.toHaveBeenCalled();
    expect(callbacks.onSubmitQuantumSupplyIntent).not.toHaveBeenCalled();
    expect(callbacks.onSubmitBatchBuildingTargetStockIntent).not.toHaveBeenCalled();
    expect(callbacks.onSubmitTargetStockIntent).not.toHaveBeenCalled();
    expect(host.querySelector<HTMLInputElement>("[aria-label='搜索原生自动制造目标']")?.disabled).toBe(false);
    expect(host.querySelector<HTMLButtonElement>(".construction-center-categories button")?.disabled).toBe(false);
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

  it("keeps the verified same-scope workspace and local drafts mounted while a newer revision loads", () => {
    const callbacks = render(frame());
    const search = host.querySelector<HTMLInputElement>("[aria-label='搜索原生自动制造目标']")!;
    setInput(search, "");
    const targetDraft = host.querySelector<HTMLInputElement>("[aria-label='风力涡轮机目标库存']")!;
    const batchDraft = host.querySelector<HTMLInputElement>("[aria-label='全部已解锁建筑目标数量']")!;
    expect(targetDraft).toBeInstanceOf(HTMLInputElement);
    expect(batchDraft).toBeInstanceOf(HTMLInputElement);
    setInput(targetDraft, "77");
    setInput(batchDraft, "123");
    setInput(search, "风力");
    act(() => search.focus());

    const revision20: NativeConstructionCenterFrameIdentity = {
      sessionId: "session-a",
      runId: "run-a",
      revision: 20,
      activePlanetId: "home",
    };
    render(null, "loading", null, callbacks, true, revision20);

    expect(host.querySelector<HTMLInputElement>("[aria-label='搜索原生自动制造目标']")).toBe(search);
    expect(document.activeElement).toBe(search);
    expect(search.value).toBe("风力");
    expect(host.querySelector<HTMLInputElement>("[aria-label='风力涡轮机目标库存']")).toBe(targetDraft);
    expect(targetDraft.value).toBe("77");
    expect(targetDraft.disabled).toBe(false);
    expect(host.querySelector<HTMLInputElement>("[aria-label='全部已解锁建筑目标数量']")).toBe(batchDraft);
    expect(batchDraft.value).toBe("123");
    expect(batchDraft.disabled).toBe(false);
    expect(host.textContent).toContain("正在读取 Rust revision 20");
    expect(host.textContent).toContain("revision 19；全部权威写入已锁定");
    expect([...host.querySelectorAll<HTMLInputElement>(".construction-center-toggle input")].every((control) => control.disabled)).toBe(true);
    expect(host.querySelector<HTMLButtonElement>("[aria-label='增加风力涡轮机目标库存']")?.disabled).toBe(true);
    expect(host.querySelector<HTMLSelectElement>("[aria-label='风力涡轮机常用目标库存']")?.disabled).toBe(true);
    act(() => {
      targetDraft.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      targetDraft.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    expect(callbacks.onSubmitTargetStockIntent).not.toHaveBeenCalled();
    expect(targetDraft.value).toBe("77");

    render({ ...frame(), revision: 20 }, "ready", null, callbacks, true, revision20);
    expect(host.querySelector<HTMLInputElement>("[aria-label='搜索原生自动制造目标']")).toBe(search);
    expect(document.activeElement).toBe(search);
    expect(search.value).toBe("风力");
    expect(targetDraft.value).toBe("77");
    expect(batchDraft.value).toBe("123");
    expect(host.querySelector("[data-native-authority-revision='20']")).not.toBeNull();
    expect(host.querySelector<HTMLButtonElement>("[aria-label='增加风力涡轮机目标库存']")?.disabled).toBe(false);

    render(null, "loading", null, callbacks, true, { ...revision20, runId: "run-b", revision: 1 });
    expect(host.querySelector("[data-native-construction-target-id]")).toBeNull();
    expect(host.textContent).toContain("等待同版本原生投影");

    render({ ...frame(), revision: 20 }, "ready", null, callbacks, true, revision20);
    render(null, "unavailable", null, callbacks, true, revision20);
    expect(host.querySelector("[data-native-construction-target-id]")).toBeNull();
    expect(host.textContent).toContain("目录不受支持，已安全关闭展示与写入");
  });

  it("fails closed without a complete built-in frame and has no legacy state dependency", () => {
    render(null, "unavailable");
    expect(host.textContent).toContain("目录不受支持，已安全关闭展示与写入");
    expect(host.textContent).toContain("不会回退读取或写入旧渲染器状态");
    expect(host.querySelector("[data-native-construction-target-id]")).toBeNull();

    const source = readFileSync(resolve("src/components/NativeConstructionCenterWorkspace.tsx"), "utf8");
    expect(source).not.toMatch(/from\s+["']\.\.\/game\/(?:engine|content|types)["']/);
    expect(source).not.toMatch(/\bGameState\b|\bgame\.|getConstructionAutomationStatus|getStatus\s*\(/);
    expect(source).not.toMatch(/nativeConstructionAutomationIntentCommands/);
    expect(source).not.toMatch(/on(?:Enabled|QuantumSource|Target|BatchTarget|Cancel|Refund|Move|Discard|Fund)\b/);
    expect(source).toMatch(/onSubmitEnabledIntent[\s\S]*?onSubmitQuantumSupplyIntent[\s\S]*?onSubmitBatchBuildingTargetStockIntent[\s\S]*?onSubmitTargetStockIntent/);
    expect(source).toMatch(/一条原子 Rust 意图统一修改/);
  });
});
