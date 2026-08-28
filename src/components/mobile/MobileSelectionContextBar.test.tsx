// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { FactorySelectionToolbarReadModel } from "../../game/factoryReadModels";
import { MobileSelectionContextBar } from "./MobileFactoryPanels";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const noop = () => undefined;

function renderBar(root: Root, model: FactorySelectionToolbarReadModel, onLock = noop): void {
  act(() => root.render(<MobileSelectionContextBar
    model={model}
    canUpgrade
    canUpgradeBelts
    onFocus={noop}
    onCopy={noop}
    onUpgrade={noop}
    onUpgradeBelts={noop}
    onBatchIncrease={noop}
    onLock={onLock}
    onUnlock={noop}
    onRemove={noop}
    onClear={noop}
  />));
}

describe("MobileSelectionContextBar bounded read model", () => {
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

  it("renders native counts and lock availability from one atomic model", () => {
    renderBar(root, {
      schema: "factory-read-model-v1",
      source: "native-core",
      revision: 47,
      activePlanetId: "home",
      selectedCount: 4,
      selectedBeltCount: 6,
      canLock: false,
      canUnlock: true,
    });

    expect(host.textContent).toContain("4 节点 · 6 线路");
    const buttons = [...host.querySelectorAll("button")];
    expect((buttons.find((button) => button.textContent?.includes("锁定")) as HTMLButtonElement).disabled).toBe(true);
    expect((buttons.find((button) => button.textContent?.includes("解锁")) as HTMLButtonElement).disabled).toBe(false);
    expect(host.firstElementChild?.getAttribute("data-factory-read-model-source")).toBe("native-core");
    expect(host.firstElementChild?.getAttribute("data-factory-read-model-revision")).toBe("47");
  });

  it("keeps mutations outside the read-only model", () => {
    const onLock = vi.fn();
    renderBar(root, {
      schema: "factory-read-model-v1",
      source: "web-game-state",
      revision: null,
      activePlanetId: "home",
      selectedCount: 1,
      selectedBeltCount: 0,
      canLock: true,
      canUnlock: false,
    }, onLock);

    const lock = [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("锁定"));
    act(() => (lock as HTMLButtonElement).click());
    expect(onLock).toHaveBeenCalledTimes(1);
    expect(host.firstElementChild?.getAttribute("data-factory-read-model-revision")).toBe("web");
  });
});
