// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { FactoryInspectorSummaryReadModel } from "../../game/factoryReadModels";
import { createInitialState } from "../../game/engine";
import type { FactoryEntity } from "../../game/types";
import { createWebFactoryInspectorSummaryReadModel } from "../../game/webFactoryReadModelAdapter";
import { MobileInspectorSheet } from "./MobileFactoryPanels";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const noop = () => undefined;

function fixture() {
  const game = createInitialState();
  const entity: FactoryEntity = {
    ...game.entities[0],
    id: "entity-inspected",
    planetId: game.activePlanetId,
    kind: "machine",
    buildingId: "assembling_machine_mk1",
    resourceId: undefined,
    recipeId: "iron_ingot",
    machineCount: 1,
    minerCount: 0,
    progress: 0.4,
    utilization: 0.5,
    productionRate: 6,
    powerFactor: 0.8,
    interactionLocked: false,
    inputs: { iron_ore: 12 },
    outputs: { iron_ingot: 3 },
  };
  game.entities = [entity];
  const web = createWebFactoryInspectorSummaryReadModel(game, entity, null);
  const native: FactoryInspectorSummaryReadModel = {
    ...web,
    source: "native-core",
    revision: 41,
  };
  return { game, entity, native };
}

function renderInspector(root: Root, model: FactoryInspectorSummaryReadModel, onEntityLockChange = noop): void {
  const { game, entity } = fixture();
  act(() => root.render(<MobileInspectorSheet
    game={game}
    snap="half"
    entity={entity}
    belt={null}
    selectedCount={1}
    readModel={model}
    onSnap={noop}
    onClose={noop}
    onOpenAdvanced={noop}
    onFocus={noop}
    onAddEntity={noop}
    onRemoveEntity={noop}
    onUpgradeEntity={noop}
    onUpgradeInterstellarStation={noop}
    onQuantumAttachment={noop}
    onOrbitalCollectorQuantumMode={noop}
    onUpgradeBelt={noop}
    onBeltLaneCountChange={noop}
    onEntityLockChange={onEntityLockChange}
    onRemoveSprayCoater={noop}
    onOpenResourceSettings={noop}
    onMaterialDeliverySlotChange={noop}
    onEjectorOrbitChange={noop}
  />));
}

describe("MobileInspectorSheet bounded live summary", () => {
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

  it("renders live progress and I/O from the exact native-marked summary while keeping callbacks separate", () => {
    const { native } = fixture();
    const onEntityLockChange = vi.fn();
    renderInspector(root, native, onEntityLockChange);

    const status = host.querySelector(".mobile-inspector-status");
    expect(status?.getAttribute("data-factory-read-model-source")).toBe("native-core");
    expect(status?.getAttribute("data-factory-read-model-revision")).toBe("41");
    expect(host.textContent).toContain("6.0/min · 利用率 50%");
    expect(host.textContent).toContain("铁矿石");
    expect(host.textContent).toContain("铁块");

    const lockButton = [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("锁定"));
    act(() => lockButton?.click());
    expect(onEntityLockChange).toHaveBeenCalledWith("entity-inspected", true);
  });

  it("locally falls back when the supplied summary identity does not match the GameState command record", () => {
    const { native } = fixture();
    const mismatched: FactoryInspectorSummaryReadModel = {
      ...native,
      entity: { ...native.entity!, entityId: "other", productionRate: 999 },
    };
    renderInspector(root, mismatched);

    const status = host.querySelector(".mobile-inspector-status");
    expect(status?.getAttribute("data-factory-read-model-source")).toBe("web-game-state");
    expect(status?.getAttribute("data-factory-read-model-revision")).toBe("web");
    expect(host.textContent).toContain("6.0/min · 利用率 50%");
    expect(host.textContent).not.toContain("999.0/min");
  });
});
