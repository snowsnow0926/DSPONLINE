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
      selectedCount: 2,
      selectedBeltCount: 3,
      canLock: true,
      canUnlock: false,
    });

    expect(host.textContent).toContain("2 节点 · 3 线路");
    expect((host.querySelector("[aria-label='锁定所选建筑']") as HTMLButtonElement).disabled).toBe(false);
    expect((host.querySelector("[aria-label='解锁所选建筑']") as HTMLButtonElement).disabled).toBe(true);
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
});
