// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FactoryInspectorSummaryReadModel, FactoryMultiSelectionSummaryReadModel } from "../game/factoryReadModels";
import type { NativeProjectedEntityConfigurationBinding } from "../game/nativeProjectedEntityConfigurationCommands";
import type { FactoryEntity } from "../game/types";
import { NativeFactoryInspectorPanel } from "./NativeFactoryInspectorPanel";

const entity = {
  entityId: "MOD/设备-一",
  planetId: "home",
  kind: "machine",
  position: { x: 1, y: 2 },
  interactionLocked: false,
  buildingId: "MOD/建筑-一",
  resourceId: null,
  recipeId: "MOD/配方-一",
  storedItemId: null,
  fuelItemId: null,
  machineCount: 3,
  minerCount: 0,
  progress: 0.25,
  utilization: 0.5,
  productionRate: 12,
  powerFactor: 0.8,
  inputItems: { rows: [{ itemId: "MOD/输入", amount: 7 }], totalCount: 1, truncated: false },
  outputItems: { rows: [], totalCount: 0, truncated: false },
} as const;

function inspector(overrides: Partial<FactoryInspectorSummaryReadModel> = {}): FactoryInspectorSummaryReadModel {
  return { schema: "factory-read-model-v1", source: "native-core", revision: 8, activePlanetId: "home", entity, belt: null, ...overrides };
}

function multi(overrides: Partial<FactoryMultiSelectionSummaryReadModel> = {}): FactoryMultiSelectionSummaryReadModel {
  return {
    schema: "factory-read-model-v1", source: "native-core", revision: 8, activePlanetId: "home",
    projectionIdentity: { sessionId: "s", runId: "r", revision: 8, planetId: "home" },
    requestedEntityCount: 1, requestedBeltCount: 0,
    entityRows: { rows: [entity], totalCount: 1, truncated: false },
    beltRows: { rows: [], totalCount: 0, truncated: false },
    ...overrides,
  };
}

function projectedEntity(overrides: Partial<FactoryEntity> = {}): FactoryEntity {
  return {
    id: "smelter-a",
    planetId: "home",
    kind: "machine",
    position: { x: 1, y: 2 },
    interactionLocked: false,
    buildingId: "arc_smelter",
    recipeId: "iron_ingot",
    powerPriority: 2,
    routingCursor: 0,
    machineCount: 1,
    minerCount: 0,
    inputs: {},
    outputs: {},
    progress: 0,
    utilization: 0,
    productionRate: 0,
    ...overrides,
  };
}

function configuration(
  projected = projectedEntity(),
  overrides: Partial<NativeProjectedEntityConfigurationBinding> = {},
): NativeProjectedEntityConfigurationBinding {
  return {
    sessionId: "s",
    runId: "r",
    revision: 8,
    activePlanetId: "home",
    entity: projected,
    ...overrides,
  };
}

describe("NativeFactoryInspectorPanel", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
  afterEach(() => { act(() => root.unmount()); host.remove(); });

  it("renders opaque MOD rows and routes the guarded whole-building action", () => {
    const remove = vi.fn();
    const stack = vi.fn();
    const lock = vi.fn();
    act(() => root.render(<NativeFactoryInspectorPanel inspector={inspector()} multiSelection={multi()} entityConfiguration={null} pending={false} onEntityLockChange={lock} onRemoveEntity={remove} onStackCountChange={stack} onEntityPowerPriorityChange={vi.fn()} onSplitterDistributionModeChange={vi.fn()} onEnergyExchangerModeChange={vi.fn()} onBeltLaneCountChange={vi.fn()} onBeltPriorityChange={vi.fn()} onRemoveBelt={vi.fn()} />));
    expect(host.textContent).toContain("MOD/建筑-一");
    expect(host.textContent).toContain("MOD/输入");
    const button = host.querySelector<HTMLButtonElement>('[data-native-construction-removal] button')!;
    act(() => button.click());
    expect(remove).toHaveBeenCalledWith("MOD/设备-一");
    const stackButtons = [...host.querySelectorAll<HTMLButtonElement>('[data-native-construction-stack] button')];
    act(() => stackButtons[0].click());
    act(() => stackButtons[1].click());
    expect(stack).toHaveBeenNthCalledWith(1, "MOD/设备-一", 2);
    expect(stack).toHaveBeenNthCalledWith(2, "MOD/设备-一", 4);
    act(() => host.querySelector<HTMLButtonElement>('[data-native-entity-lock] button')!.click());
    expect(lock).toHaveBeenCalledWith("MOD/设备-一", true);
  });

  it("fails closed for a mismatched revision and never exposes the removal action", () => {
    act(() => root.render(<NativeFactoryInspectorPanel inspector={inspector()} multiSelection={multi({ revision: 9 })} entityConfiguration={null} pending={false} onEntityLockChange={vi.fn()} onRemoveEntity={vi.fn()} onStackCountChange={vi.fn()} onEntityPowerPriorityChange={vi.fn()} onSplitterDistributionModeChange={vi.fn()} onEnergyExchangerModeChange={vi.fn()} onBeltLaneCountChange={vi.fn()} onBeltPriorityChange={vi.fn()} onRemoveBelt={vi.fn()} />));
    expect(host.textContent).toContain("正在核对原生检查摘要");
    expect(host.querySelector("[data-native-construction-removal]")).toBeNull();
  });

  it("routes one ordinary belt priority action and disables the current value", () => {
    const priority = vi.fn();
    const lanes = vi.fn();
    const removeBelt = vi.fn();
    const selectedBelt = {
      beltId: "MOD-线路/β",
      planetId: "home",
      sourceEntityId: "source-a",
      targetEntityId: "target-a",
      itemId: "MOD/输入",
      lanes: 2,
      tier: 1,
      sorterTier: 1,
      stackSize: 1,
      priority: 1,
      progress: 0,
      lastFlow: 0,
      totalTransferred: 0,
      congestion: 0,
    } as const;
    act(() => root.render(<NativeFactoryInspectorPanel
      inspector={inspector({ entity: null, belt: selectedBelt })}
      multiSelection={multi({
        requestedEntityCount: 0,
        requestedBeltCount: 1,
        entityRows: { rows: [], totalCount: 0, truncated: false },
        beltRows: { rows: [selectedBelt], totalCount: 1, truncated: false },
      })}
      entityConfiguration={null}
      pending={false}
      onEntityLockChange={vi.fn()}
      onRemoveEntity={vi.fn()}
      onStackCountChange={vi.fn()}
      onEntityPowerPriorityChange={vi.fn()}
      onSplitterDistributionModeChange={vi.fn()}
      onEnergyExchangerModeChange={vi.fn()}
      onBeltLaneCountChange={lanes}
      onBeltPriorityChange={priority}
      onRemoveBelt={removeBelt}
    />));
    const buttons = [...host.querySelectorAll<HTMLButtonElement>("[data-native-belt-priority] button")];
    expect(buttons).toHaveLength(3);
    expect(buttons[1].disabled).toBe(true);
    act(() => buttons[2].click());
    expect(priority).toHaveBeenCalledWith("MOD-线路/β", 2);
    const laneButtons = [...host.querySelectorAll<HTMLButtonElement>("[data-native-belt-lanes] button")];
    expect(laneButtons).toHaveLength(2);
    act(() => laneButtons[0].click());
    act(() => laneButtons[1].click());
    expect(lanes).toHaveBeenNthCalledWith(1, "MOD-线路/β", 1);
    expect(lanes).toHaveBeenNthCalledWith(2, "MOD-线路/β", 3);
    const remove = host.querySelector<HTMLButtonElement>("[data-native-belt-removal] button")!;
    act(() => remove.click());
    expect(removeBelt).toHaveBeenCalledWith("MOD-线路/β");
  });

  it("routes a same-revision built-in machine power priority without renderer prediction", () => {
    const priority = vi.fn();
    const projected = projectedEntity();
    const ordinary = {
      ...entity,
      entityId: projected.id,
      buildingId: projected.buildingId ?? null,
      recipeId: projected.recipeId ?? null,
      machineCount: projected.machineCount,
      inputItems: { rows: [], totalCount: 0, truncated: false },
    };
    act(() => root.render(<NativeFactoryInspectorPanel
      inspector={inspector({ entity: ordinary })}
      multiSelection={multi({
        entityRows: { rows: [ordinary], totalCount: 1, truncated: false },
      })}
      entityConfiguration={configuration(projected)}
      pending={false}
      onEntityLockChange={vi.fn()}
      onRemoveEntity={vi.fn()}
      onStackCountChange={vi.fn()}
      onEntityPowerPriorityChange={priority}
      onSplitterDistributionModeChange={vi.fn()}
      onEnergyExchangerModeChange={vi.fn()}
      onBeltLaneCountChange={vi.fn()}
      onBeltPriorityChange={vi.fn()}
      onRemoveBelt={vi.fn()}
    />));
    const buttons = [...host.querySelectorAll<HTMLButtonElement>("[data-native-entity-power-priority] button")];
    expect(buttons).toHaveLength(3);
    expect(buttons[1].textContent).toBe("中");
    expect(buttons[1].disabled).toBe(true);
    act(() => buttons[0].click());
    expect(priority).toHaveBeenCalledWith("smelter-a", 3);
    expect(host.querySelector("[data-native-splitter-mode]")).toBeNull();
  });

  it("routes built-in splitter mode and fails closed for stale or opaque configuration rows", () => {
    const mode = vi.fn();
    const splitter = projectedEntity({
      id: "splitter-a",
      kind: "splitter",
      buildingId: "splitter_4way",
      recipeId: undefined,
      powerPriority: undefined,
      distributionMode: "balanced",
    });
    const splitterSummary = {
      ...entity,
      entityId: splitter.id,
      kind: splitter.kind,
      buildingId: splitter.buildingId ?? null,
      recipeId: null,
      machineCount: 1,
      inputItems: { rows: [], totalCount: 0, truncated: false },
    };
    const render = (entityConfiguration: NativeProjectedEntityConfigurationBinding | null, pending = false) => act(() => root.render(
      <NativeFactoryInspectorPanel
        inspector={inspector({ entity: splitterSummary })}
        multiSelection={multi({ entityRows: { rows: [splitterSummary], totalCount: 1, truncated: false } })}
        entityConfiguration={entityConfiguration}
        pending={pending}
        onEntityLockChange={vi.fn()}
        onRemoveEntity={vi.fn()}
        onStackCountChange={vi.fn()}
        onEntityPowerPriorityChange={vi.fn()}
        onSplitterDistributionModeChange={mode}
        onEnergyExchangerModeChange={vi.fn()}
        onBeltLaneCountChange={vi.fn()}
        onBeltPriorityChange={vi.fn()}
        onRemoveBelt={vi.fn()}
      />,
    ));
    render(configuration(splitter), true);
    let buttons = [...host.querySelectorAll<HTMLButtonElement>("[data-native-splitter-mode] button")];
    expect(buttons).toHaveLength(2);
    expect(buttons.every((button) => button.disabled)).toBe(true);

    render(configuration(splitter), false);
    buttons = [...host.querySelectorAll<HTMLButtonElement>("[data-native-splitter-mode] button")];
    act(() => buttons[1].click());
    expect(mode).toHaveBeenCalledWith("splitter-a", "priority");

    render(configuration(splitter, { revision: 7 }));
    expect(host.querySelector("[data-native-splitter-mode]")).toBeNull();
    render(configuration(projectedEntity({
      id: "splitter-a",
      kind: "splitter",
      buildingId: "MOD/custom-splitter" as FactoryEntity["buildingId"],
    })));
    expect(host.querySelector("[data-native-splitter-mode]")).toBeNull();
  });

  it("routes an empty built-in energy exchanger and blocks stored or pending rows", () => {
    const mode = vi.fn();
    const exchanger = projectedEntity({
      id: "exchanger-a",
      kind: "power",
      buildingId: "energy_exchanger",
      recipeId: "accumulator_charge",
      powerPriority: undefined,
      energyMode: "charge",
      storedEnergyMj: 0.0001,
      powerInputKw: 0,
      powerOutputKw: 0,
    });
    const exchangerSummary = {
      ...entity,
      entityId: exchanger.id,
      kind: exchanger.kind,
      buildingId: exchanger.buildingId ?? null,
      recipeId: exchanger.recipeId ?? null,
      machineCount: 1,
      inputItems: { rows: [], totalCount: 0, truncated: false },
    };
    const render = (projected: FactoryEntity, pending = false) => act(() => root.render(
      <NativeFactoryInspectorPanel
        inspector={inspector({ entity: exchangerSummary })}
        multiSelection={multi({ entityRows: { rows: [exchangerSummary], totalCount: 1, truncated: false } })}
        entityConfiguration={configuration(projected)}
        pending={pending}
        onEntityLockChange={vi.fn()}
        onRemoveEntity={vi.fn()}
        onStackCountChange={vi.fn()}
        onEntityPowerPriorityChange={vi.fn()}
        onSplitterDistributionModeChange={vi.fn()}
        onEnergyExchangerModeChange={mode}
        onBeltLaneCountChange={vi.fn()}
        onBeltPriorityChange={vi.fn()}
        onRemoveBelt={vi.fn()}
      />,
    ));

    render(exchanger);
    let buttons = [...host.querySelectorAll<HTMLButtonElement>("[data-native-energy-exchanger-mode] button")];
    expect(buttons).toHaveLength(2);
    expect(buttons[0].disabled).toBe(true);
    expect(buttons[1].disabled).toBe(false);
    act(() => buttons[1].click());
    expect(mode).toHaveBeenCalledWith("exchanger-a", "discharge");

    render(exchanger, true);
    buttons = [...host.querySelectorAll<HTMLButtonElement>("[data-native-energy-exchanger-mode] button")];
    expect(buttons.every((button) => button.disabled)).toBe(true);

    render({ ...exchanger, storedEnergyMj: 0.01 });
    buttons = [...host.querySelectorAll<HTMLButtonElement>("[data-native-energy-exchanger-mode] button")];
    expect(buttons.every((button) => button.disabled)).toBe(true);
    expect(host.textContent).toContain("必须先放空");
  });
});
