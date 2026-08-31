// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { FactorySelectionToolbarReadModel } from "../game/factoryReadModels";
import { SelectionToolbar } from "./BlueprintWorkspace";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const noop = () => undefined;

function renderToolbar(root: Root, model: FactorySelectionToolbarReadModel): void {
  act(() => root.render(<SelectionToolbar
    model={model}
    eligibleCount={2}
    canUpgrade
    canUpgradeBelts
    onFocus={noop}
    onAutoLayout={noop}
    onCopy={noop}
    onUpgrade={noop}
    onUpgradeBelts={noop}
    onBatchIncrease={noop}
    onLock={noop}
    onUnlock={noop}
    onRemove={noop}
    onClear={noop}
    onDone={noop}
  />));
}

describe("SelectionToolbar bounded read model", () => {
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

  it("renders counts and lock availability only from the supplied model", () => {
    renderToolbar(root, {
      schema: "factory-read-model-v1",
      source: "native-core",
      revision: 31,
      activePlanetId: "home",
      projectionIdentity: { sessionId: "session-a", runId: "run-a", revision: 31, planetId: "home" },
      selectedCount: 2,
      selectedBeltCount: 3,
      canLock: true,
      canUnlock: false,
    });

    expect(host.textContent).toContain("2 节点 · 3 线路");
    expect((host.querySelector("[aria-label='锁定所选建筑']") as HTMLButtonElement).disabled).toBe(false);
    expect((host.querySelector("[aria-label='解锁所选建筑']") as HTMLButtonElement).disabled).toBe(true);
    expect((host.querySelector("[aria-label='自动整理所选设备']") as HTMLButtonElement).disabled).toBe(false);
    expect((host.querySelector("[aria-label='复制所选为蓝图']") as HTMLButtonElement).disabled).toBe(false);
    expect((host.querySelector("[aria-label='批量升级所选设备']") as HTMLButtonElement).disabled).toBe(false);
    expect((host.querySelector("[aria-label='一键升级所选传送带']") as HTMLButtonElement).disabled).toBe(false);
    expect((host.querySelector("[title='批量增加 1']") as HTMLButtonElement).disabled).toBe(false);
    expect((host.querySelector("[aria-label='批量回收所选设备与线路']") as HTMLButtonElement).disabled).toBe(false);
    expect(host.firstElementChild?.getAttribute("data-factory-read-model-source")).toBe("native-core");
    expect(host.firstElementChild?.getAttribute("data-factory-read-model-revision")).toBe("31");
  });

  it("keeps action callbacks separate from the read-only model", () => {
    const onLock = vi.fn();
    act(() => root.render(<SelectionToolbar
      model={{
        schema: "factory-read-model-v1",
        source: "web-game-state",
        revision: null,
        activePlanetId: "home",
        projectionIdentity: null,
        selectedCount: 1,
        selectedBeltCount: 0,
        canLock: true,
        canUnlock: false,
      }}
      eligibleCount={0}
      canUpgrade={false}
      canUpgradeBelts={false}
      onFocus={noop}
      onAutoLayout={noop}
      onCopy={noop}
      onUpgrade={noop}
      onUpgradeBelts={noop}
      onBatchIncrease={noop}
      onLock={onLock}
      onUnlock={noop}
      onRemove={noop}
      onClear={noop}
      onDone={noop}
    />));

    act(() => (host.querySelector("[aria-label='锁定所选建筑']") as HTMLButtonElement).click());
    expect(onLock).toHaveBeenCalledTimes(1);
    expect((host.querySelector("[aria-label='复制所选为蓝图']") as HTMLButtonElement).disabled).toBe(true);
    expect(host.firstElementChild?.getAttribute("data-factory-read-model-source")).toBe("web-game-state");
  });

  it("can disable unsafe mutation controls while retaining interaction locks and local actions", () => {
    const onAutoLayout = vi.fn();
    const onCopy = vi.fn();
    const onUpgrade = vi.fn();
    const onUpgradeBelts = vi.fn();
    const onBatchIncrease = vi.fn();
    const onLock = vi.fn();
    const onRemove = vi.fn();
    act(() => root.render(<SelectionToolbar
      model={{
        schema: "factory-read-model-v1",
        source: "native-core",
        revision: 32,
        activePlanetId: "home",
        projectionIdentity: { sessionId: "session-a", runId: "run-a", revision: 32, planetId: "home" },
        selectedCount: 2,
        selectedBeltCount: 1,
        canLock: true,
        canUnlock: false,
      }}
      eligibleCount={2}
      canUpgrade
      canUpgradeBelts
      unsafeActionsEnabled={false}
      onFocus={noop}
      onAutoLayout={onAutoLayout}
      onCopy={onCopy}
      onUpgrade={onUpgrade}
      onUpgradeBelts={onUpgradeBelts}
      onBatchIncrease={onBatchIncrease}
      onLock={onLock}
      onUnlock={noop}
      onRemove={onRemove}
      onClear={noop}
      onDone={noop}
    />));

    const disabledControls = [
      "[aria-label='自动整理所选设备']",
      "[aria-label='复制所选为蓝图']",
      "[aria-label='批量升级所选设备']",
      "[aria-label='一键升级所选传送带']",
      "[title='批量增加 1']",
      "[aria-label='自定义批量增加量']",
      "[aria-label='应用自定义增加量']",
      "[aria-label='批量回收所选设备与线路']",
    ];
    for (const selector of disabledControls) {
      expect((host.querySelector(selector) as HTMLButtonElement | HTMLInputElement).disabled).toBe(true);
      act(() => (host.querySelector(selector) as HTMLButtonElement | HTMLInputElement).click());
    }
    expect(onAutoLayout).not.toHaveBeenCalled();
    expect(onCopy).not.toHaveBeenCalled();
    expect(onUpgrade).not.toHaveBeenCalled();
    expect(onUpgradeBelts).not.toHaveBeenCalled();
    expect(onBatchIncrease).not.toHaveBeenCalled();
    expect(onRemove).not.toHaveBeenCalled();

    const lock = host.querySelector("[aria-label='锁定所选建筑']") as HTMLButtonElement;
    expect(lock.disabled).toBe(false);
    act(() => lock.click());
    expect(onLock).toHaveBeenCalledTimes(1);
    expect((host.querySelector("[aria-label='定位到所选设备']") as HTMLButtonElement).disabled).toBe(false);
    expect((host.querySelector("[aria-label='清空选择']") as HTMLButtonElement).disabled).toBe(false);
    expect((host.querySelector("[aria-label='完成多选']") as HTMLButtonElement).disabled).toBe(false);
  });

  it("can enable only the Rust-backed native copy action", () => {
    const onCopy = vi.fn();
    act(() => root.render(<SelectionToolbar
      model={{
        schema: "factory-read-model-v1",
        source: "native-core",
        revision: 33,
        activePlanetId: "home",
        projectionIdentity: { sessionId: "session-a", runId: "run-a", revision: 33, planetId: "home" },
        selectedCount: 2,
        selectedBeltCount: 0,
        canLock: false,
        canUnlock: false,
      }}
      eligibleCount={2}
      canUpgrade
      canUpgradeBelts
      unsafeActionsEnabled={false}
      copyActionEnabled
      onFocus={noop}
      onAutoLayout={noop}
      onCopy={onCopy}
      onUpgrade={noop}
      onUpgradeBelts={noop}
      onBatchIncrease={noop}
      onLock={noop}
      onUnlock={noop}
      onRemove={noop}
      onClear={noop}
      onDone={noop}
    />));

    const copy = host.querySelector("[aria-label='复制所选为蓝图']") as HTMLButtonElement;
    expect(copy.disabled).toBe(false);
    act(() => copy.click());
    expect(onCopy).toHaveBeenCalledTimes(1);
    for (const selector of [
      "[aria-label='自动整理所选设备']",
      "[aria-label='批量升级所选设备']",
      "[aria-label='一键升级所选传送带']",
      "[title='批量增加 1']",
      "[aria-label='批量回收所选设备与线路']",
    ]) {
      expect((host.querySelector(selector) as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it.each([
    { copyActionEnabled: false, eligibleCount: 2, label: "explicitly unavailable" },
    { copyActionEnabled: true, eligibleCount: 0, label: "empty selection" },
  ])("keeps native copy disabled when $label", ({ copyActionEnabled, eligibleCount }) => {
    const onCopy = vi.fn();
    act(() => root.render(<SelectionToolbar
      model={{
        schema: "factory-read-model-v1",
        source: "native-core",
        revision: 34,
        activePlanetId: "home",
        projectionIdentity: { sessionId: "session-a", runId: "run-a", revision: 34, planetId: "home" },
        selectedCount: 2,
        selectedBeltCount: 0,
        canLock: false,
        canUnlock: false,
      }}
      eligibleCount={eligibleCount}
      canUpgrade
      canUpgradeBelts
      unsafeActionsEnabled={false}
      copyActionEnabled={copyActionEnabled}
      onFocus={noop}
      onAutoLayout={noop}
      onCopy={onCopy}
      onUpgrade={noop}
      onUpgradeBelts={noop}
      onBatchIncrease={noop}
      onLock={noop}
      onUnlock={noop}
      onRemove={noop}
      onClear={noop}
      onDone={noop}
    />));

    const copy = host.querySelector("[aria-label='复制所选为蓝图']") as HTMLButtonElement;
    expect(copy.disabled).toBe(true);
    act(() => copy.click());
    expect(onCopy).not.toHaveBeenCalled();
  });
});
