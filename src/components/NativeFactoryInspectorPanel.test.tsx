// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  FactoryInspectorSummaryReadModel,
  FactoryMultiSelectionSummaryReadModel,
  NativeStationConfigurationReadModel,
  SelectedEntityReadModel,
} from "../game/factoryReadModels";
import type { NativeProjectedEntityConfigurationBinding } from "../game/nativeProjectedEntityConfigurationCommands";
import type { NativeProjectedEntityRecipeBinding } from "../game/nativeProjectedEntityRecipeCommands";
import type {
  NativeProjectedEjectorOrbitFrame,
  NativeProjectedTimeWarpControllerBinding,
} from "../game/nativeProjectedTimeWarpEjectorCommands";
import type { NativeProjectedStationConfigurationBinding } from "../game/nativeProjectedStationConfigurationCommands";
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
  stationConfiguration: null,
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

function recipeBinding(
  projected = projectedEntity(),
  overrides: Partial<NativeProjectedEntityRecipeBinding> = {},
): NativeProjectedEntityRecipeBinding {
  return {
    sessionId: "s",
    runId: "r",
    revision: 8,
    registryFingerprint: "7df8cf3a",
    activePlanetId: "home",
    entity: projected,
    ...overrides,
  };
}

function projectedSummary(projected = projectedEntity()): SelectedEntityReadModel {
  return {
    ...entity,
    entityId: projected.id,
    planetId: projected.planetId,
    kind: projected.kind,
    interactionLocked: projected.interactionLocked,
    buildingId: projected.buildingId ?? null,
    resourceId: projected.resourceId ?? null,
    recipeId: projected.recipeId ?? null,
    storedItemId: projected.storedItemId ?? null,
    fuelItemId: projected.fuelItemId ?? null,
    machineCount: projected.machineCount,
    minerCount: projected.minerCount,
  };
}

function stationConfigurationReadModel(
  overrides: Partial<NativeStationConfigurationReadModel> = {},
): NativeStationConfigurationReadModel {
  const stationType = overrides.stationType ?? "interstellar";
  const interstellar = stationType === "interstellar";
  return {
    schema: "station-configuration-v1",
    registryFingerprint: "7df8cf3a",
    stationType,
    itemOptions: {
      rows: [
        { itemId: "copper_ore", name: "铜矿", kind: "solid" },
        { itemId: "iron_ore", name: "铁矿", kind: "solid" },
      ],
      totalCount: 2,
      truncated: false,
      limit: 128,
    },
    stationDrones: 5,
    stationVessels: interstellar ? 2 : null,
    stationWarpers: interstellar ? 1 : null,
    slots: Array.from({ length: 5 }, (_, slotIndex) => ({
      slotIndex,
      itemId: slotIndex === 1 ? "iron_ore" : null,
      localMode: slotIndex === 1 ? "supply" as const : "storage" as const,
      remoteMode: slotIndex === 1 ? "demand" as const : "storage" as const,
      minimumLoad: slotIndex === 1 ? 0.5 as const : 1 as const,
      minStock: 0,
      maxStock: slotIndex === 1 ? 100 : 0,
      priority: 1 as const,
      ...(interstellar ? { routePolicy: "relay-preferred" as const, warperBudget: 2 as const } : {}),
    })),
    spaceWarpUnlocked: true,
    stationWarpEnabled: interstellar ? true : null,
    stationWarperAutoRefill: interstellar ? false : null,
    stationWarperTarget: interstellar ? 25 : null,
    stationHubEnabled: interstellar ? false : null,
    stationHubPriority: interstellar ? 1 : null,
    ...overrides,
  };
}

function stationEntityReadModel(
  stationConfiguration = stationConfigurationReadModel(),
  overrides: Partial<SelectedEntityReadModel> = {},
): SelectedEntityReadModel {
  return {
    ...entity,
    entityId: "station-ils",
    kind: "station",
    buildingId: stationConfiguration.stationType === "interstellar"
      ? "interstellar_logistics_station"
      : "planetary_logistics_station",
    recipeId: null,
    storedItemId: "iron_ore",
    machineCount: 1,
    stationConfiguration,
    ...overrides,
  };
}

function stationProjectionBinding(
  stationConfiguration = stationConfigurationReadModel(),
  overrides: Partial<NativeProjectedStationConfigurationBinding> = {},
): NativeProjectedStationConfigurationBinding {
  const projectedEntity = stationEntityReadModel(stationConfiguration);
  return {
    sessionId: "s",
    runId: "r",
    revision: 8,
    activePlanetId: "home",
    entity: projectedEntity,
    configuration: stationConfiguration,
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
    act(() => root.render(<NativeFactoryInspectorPanel inspector={inspector()} multiSelection={multi()} entityConfiguration={null} pending={false} onEntityLockChange={lock} onRemoveEntity={remove} onStackCountChange={stack} onEntityPowerPriorityChange={vi.fn()} onSplitterDistributionModeChange={vi.fn()} onEnergyExchangerModeChange={vi.fn()} onFuelItemChange={vi.fn()} onBlackHolePausedChange={vi.fn()} onBeltLaneCountChange={vi.fn()} onBeltPriorityChange={vi.fn()} onRemoveBelt={vi.fn()} />));
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
    expect(host.querySelector("[data-native-entity-recipe]")).toBeNull();
  });

  it("requires explicit confirmation before switching one exact-lineage built-in recipe", () => {
    const onRecipeChange = vi.fn();
    const render = (
      projected: FactoryEntity,
      recipe: NativeProjectedEntityRecipeBinding | null,
      pending = false,
      revision = 8,
    ) => {
      const summary = projectedSummary(projected);
      act(() => root.render(<NativeFactoryInspectorPanel
        inspector={inspector({ revision, entity: summary })}
        multiSelection={multi({
          revision,
          projectionIdentity: { sessionId: "s", runId: "r", revision, planetId: "home" },
          entityRows: { rows: [summary], totalCount: 1, truncated: false },
        })}
        entityConfiguration={configuration(projected, { revision })}
        entityRecipeBinding={recipe}
        pending={pending}
        onEntityLockChange={vi.fn()}
        onRemoveEntity={vi.fn()}
        onStackCountChange={vi.fn()}
        onEntityPowerPriorityChange={vi.fn()}
        onSplitterDistributionModeChange={vi.fn()}
        onEnergyExchangerModeChange={vi.fn()}
        onFuelItemChange={vi.fn()}
        onEntityRecipeChange={onRecipeChange}
        onBlackHolePausedChange={vi.fn()}
        onBeltLaneCountChange={vi.fn()}
        onBeltPriorityChange={vi.fn()}
        onRemoveBelt={vi.fn()}
      />));
    };

    const smelter = projectedEntity();
    render(smelter, recipeBinding(smelter));
    const select = host.querySelector<HTMLSelectElement>('[aria-label="Windows 原生生产配方"]')!;
    expect(select.disabled).toBe(false);
    expect(select.value).toBe("iron_ingot");
    expect(select.querySelector('option[value="copper_ingot"]')?.textContent).toContain("铜块");
    act(() => {
      select.value = "copper_ingot";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(onRecipeChange).not.toHaveBeenCalled();
    expect(select.value).toBe("iron_ingot");
    expect(document.querySelector('[role="alertdialog"]')?.textContent)
      .toContain("拆除所有相邻传送带");
    const dialogButton = (label: string) => [...document.querySelectorAll<HTMLButtonElement>(
      '[role="alertdialog"] button',
    )].find((button) => button.textContent === label)!;
    act(() => dialogButton("取消").click());
    expect(onRecipeChange).not.toHaveBeenCalled();

    act(() => {
      select.value = "copper_ingot";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const confirm = dialogButton("确认更换配方");
    act(() => {
      confirm.click();
      confirm.click();
    });
    expect(onRecipeChange).toHaveBeenCalledTimes(1);
    expect(onRecipeChange).toHaveBeenCalledWith("smelter-a", "copper_ingot");
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(select.value).toBe("iron_ingot");

    render(smelter, recipeBinding(smelter), true);
    expect(host.querySelector<HTMLSelectElement>('[aria-label="Windows 原生生产配方"]')?.disabled).toBe(true);
    expect(host.querySelector<HTMLSelectElement>('[aria-label="Windows 原生生产配方"]')?.value).toBe("iron_ingot");

    const acknowledged = projectedEntity({ recipeId: "copper_ingot" });
    render(acknowledged, recipeBinding(acknowledged, { revision: 9 }), false, 9);
    expect(host.querySelector<HTMLSelectElement>('[aria-label="Windows 原生生产配方"]')?.value)
      .toBe("copper_ingot");
  });

  it("cancels a recipe draft on pending or projection drift and keeps non-built-in rows fail-closed", () => {
    const smelter = projectedEntity();
    const onRecipeChange = vi.fn();
    const render = (
      recipe: NativeProjectedEntityRecipeBinding | null,
      pending = false,
      projected: FactoryEntity = smelter,
    ) => act(() => root.render(
      <NativeFactoryInspectorPanel
        inspector={inspector({ entity: projectedSummary(projected) })}
        multiSelection={multi({
          entityRows: { rows: [projectedSummary(projected)], totalCount: 1, truncated: false },
        })}
        entityConfiguration={configuration(projected)}
        entityRecipeBinding={recipe}
        pending={pending}
        onEntityLockChange={vi.fn()}
        onRemoveEntity={vi.fn()}
        onStackCountChange={vi.fn()}
        onEntityPowerPriorityChange={vi.fn()}
        onSplitterDistributionModeChange={vi.fn()}
        onEnergyExchangerModeChange={vi.fn()}
        onFuelItemChange={vi.fn()}
        onEntityRecipeChange={onRecipeChange}
        onBlackHolePausedChange={vi.fn()}
        onBeltLaneCountChange={vi.fn()}
        onBeltPriorityChange={vi.fn()}
        onRemoveBelt={vi.fn()}
      />));

    const openDraft = () => {
      const select = host.querySelector<HTMLSelectElement>('[aria-label="Windows 原生生产配方"]')!;
      act(() => {
        select.value = "copper_ingot";
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
      expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
    };
    render(recipeBinding(smelter));
    openDraft();
    render(recipeBinding(smelter), true);
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(onRecipeChange).not.toHaveBeenCalled();

    render(recipeBinding(smelter));
    openDraft();
    render(recipeBinding(smelter, { revision: 7 }));
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(onRecipeChange).not.toHaveBeenCalled();

    render(recipeBinding(smelter));
    openDraft();
    const replacement = projectedEntity({ id: "smelter-b" });
    render(recipeBinding(replacement), false, replacement);
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(onRecipeChange).not.toHaveBeenCalled();

    render(recipeBinding(smelter));
    openDraft();
    render(recipeBinding(smelter, { registryFingerprint: "MOD/forged" }));
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    render(recipeBinding(smelter));
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(onRecipeChange).not.toHaveBeenCalled();

    for (const unavailable of [
      null,
      recipeBinding(smelter, { revision: 7 }),
      recipeBinding(smelter, { registryFingerprint: "MOD/forged" }),
    ]) {
      render(unavailable);
      const select = host.querySelector<HTMLSelectElement>('[aria-label="Windows 原生生产配方"]')!;
      expect(select.disabled).toBe(true);
      expect(host.textContent).toContain("旧 JavaScript 存档不会作为候选来源");
    }
  });

  it("fails closed for a mismatched revision and never exposes the removal action", () => {
    act(() => root.render(<NativeFactoryInspectorPanel inspector={inspector()} multiSelection={multi({ revision: 9 })} entityConfiguration={null} pending={false} onEntityLockChange={vi.fn()} onRemoveEntity={vi.fn()} onStackCountChange={vi.fn()} onEntityPowerPriorityChange={vi.fn()} onSplitterDistributionModeChange={vi.fn()} onEnergyExchangerModeChange={vi.fn()} onFuelItemChange={vi.fn()} onBlackHolePausedChange={vi.fn()} onBeltLaneCountChange={vi.fn()} onBeltPriorityChange={vi.fn()} onRemoveBelt={vi.fn()} />));
    expect(host.textContent).toContain("正在核对原生检查摘要");
    expect(host.querySelector("[data-native-construction-removal]")).toBeNull();
  });

  it("routes micro black-hole start and pause only from the pinned native entity", () => {
    const toggle = vi.fn();
    const blackHoleEntity = {
      ...entity,
      entityId: "black-hole-a",
      buildingId: "micro_black_hole_connector",
      recipeId: null,
    };
    const renderBlackHole = (paused: boolean, confirmed: boolean, pending = false) => root.render(
      <NativeFactoryInspectorPanel
        inspector={inspector({ entity: blackHoleEntity })}
        multiSelection={multi({ entityRows: { rows: [blackHoleEntity], totalCount: 1, truncated: false } })}
        entityConfiguration={configuration(projectedEntity({
          id: "black-hole-a",
          buildingId: "micro_black_hole_connector",
          recipeId: undefined,
          blackHolePaused: paused,
          blackHoleActivationConfirmed: confirmed,
        }))}
        pending={pending}
        onEntityLockChange={vi.fn()}
        onRemoveEntity={vi.fn()}
        onStackCountChange={vi.fn()}
        onEntityPowerPriorityChange={vi.fn()}
        onSplitterDistributionModeChange={vi.fn()}
        onEnergyExchangerModeChange={vi.fn()}
        onFuelItemChange={vi.fn()}
        onBlackHolePausedChange={toggle}
        onBeltLaneCountChange={vi.fn()}
        onBeltPriorityChange={vi.fn()}
        onRemoveBelt={vi.fn()}
      />,
    );

    act(() => renderBlackHole(true, false));
    let button = host.querySelector<HTMLButtonElement>('[data-native-black-hole-paused] button')!;
    expect(button.textContent).toContain("启动微型黑洞");
    expect(host.textContent).toContain("尚未确认");
    act(() => button.click());
    expect(toggle).toHaveBeenLastCalledWith("black-hole-a", false);

    act(() => renderBlackHole(false, true));
    button = host.querySelector<HTMLButtonElement>('[data-native-black-hole-paused] button')!;
    expect(button.textContent).toContain("暂停销毁");
    act(() => button.click());
    expect(toggle).toHaveBeenLastCalledWith("black-hole-a", true);

    act(() => renderBlackHole(false, true, true));
    expect(host.querySelector<HTMLButtonElement>('[data-native-black-hole-paused] button')!.disabled)
      .toBe(true);
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
      onFuelItemChange={vi.fn()}
      onBlackHolePausedChange={vi.fn()}
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
      onFuelItemChange={vi.fn()}
      onBlackHolePausedChange={vi.fn()}
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
        onFuelItemChange={vi.fn()}
        onBlackHolePausedChange={vi.fn()}
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
        onFuelItemChange={vi.fn()}
        onBlackHolePausedChange={vi.fn()}
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

  it("routes one built-in fuel intent, stays projected, and blocks pending or MOD rows", () => {
    const fuel = vi.fn();
    const thermal = projectedEntity({
      id: "thermal-a",
      kind: "power",
      buildingId: "thermal_power_plant",
      recipeId: undefined,
      powerPriority: undefined,
      fuelItemId: "coal",
      fuelRemainingMj: 3.25,
      inputs: { coal: 4 },
      powerOutputKw: 2_100,
    });
    const thermalSummary = {
      ...entity,
      entityId: thermal.id,
      kind: thermal.kind,
      buildingId: thermal.buildingId ?? null,
      recipeId: null,
      fuelItemId: thermal.fuelItemId ?? null,
      machineCount: 1,
      inputItems: { rows: [{ itemId: "coal", amount: 4 }], totalCount: 1, truncated: false },
    };
    const render = (projected: FactoryEntity, pending = false) => act(() => root.render(
      <NativeFactoryInspectorPanel
        inspector={inspector({ entity: thermalSummary })}
        multiSelection={multi({ entityRows: { rows: [thermalSummary], totalCount: 1, truncated: false } })}
        entityConfiguration={configuration(projected)}
        pending={pending}
        onEntityLockChange={vi.fn()}
        onRemoveEntity={vi.fn()}
        onStackCountChange={vi.fn()}
        onEntityPowerPriorityChange={vi.fn()}
        onSplitterDistributionModeChange={vi.fn()}
        onEnergyExchangerModeChange={vi.fn()}
        onFuelItemChange={fuel}
        onBlackHolePausedChange={vi.fn()}
        onBeltLaneCountChange={vi.fn()}
        onBeltPriorityChange={vi.fn()}
        onRemoveBelt={vi.fn()}
      />,
    ));

    render(thermal);
    let select = host.querySelector<HTMLSelectElement>("[data-native-fuel-item] select")!;
    expect(select.value).toBe("coal");
    expect([...select.options].map((option) => option.value)).toEqual([
      "",
      "coal",
      "fire_ice",
      "crude_oil",
      "energetic_graphite",
      "refined_oil",
      "hydrogen",
      "hydrogen_fuel_rod",
      "deuteron_fuel_rod",
      "antimatter_fuel_rod",
    ]);
    act(() => {
      select.value = "fire_ice";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(fuel).toHaveBeenCalledWith("thermal-a", "fire_ice");
    expect(thermal.fuelItemId).toBe("coal");

    render(thermal, true);
    select = host.querySelector<HTMLSelectElement>("[data-native-fuel-item] select")!;
    expect(select.disabled).toBe(true);

    render({ ...thermal, fuelItemId: "fire_ice" });
    expect(host.querySelector("[data-native-fuel-item]")).toBeNull();

    render({
      ...thermal,
      buildingId: "MOD/fuel-generator" as FactoryEntity["buildingId"],
    });
    expect(host.querySelector("[data-native-fuel-item]")).toBeNull();
  });

  it("routes time-warp controls only from the same-revision Rust controller projection", () => {
    const enabled = vi.fn();
    const multiplier = vi.fn();
    const controller = projectedEntity({
      id: "controller-a",
      buildingId: "time_warp_device",
      recipeId: undefined,
      powerPriority: undefined,
    });
    const controllerSummary = {
      ...entity,
      entityId: controller.id,
      buildingId: controller.buildingId ?? null,
      recipeId: null,
      machineCount: 1,
      inputItems: { rows: [], totalCount: 0, truncated: false },
    };
    const controllerConfiguration = configuration(controller);
    const controllerProjection: NativeProjectedTimeWarpControllerBinding = {
      ...controllerConfiguration,
      registryFingerprint: "7df8cf3a",
      simulationSpeed: 4,
      timeWarp: {
        controllerEntityId: "controller-a",
        enabled: false,
        requestedMultiplier: 15,
        effectiveMultiplier: 4,
        requiredPowerKw: 0,
        allocatedPowerKw: 0,
      },
    };
    const render = (timeWarpController: NativeProjectedTimeWarpControllerBinding | null) => act(() => root.render(
      <NativeFactoryInspectorPanel
        inspector={inspector({ entity: controllerSummary })}
        multiSelection={multi({ entityRows: { rows: [controllerSummary], totalCount: 1, truncated: false } })}
        entityConfiguration={controllerConfiguration}
        timeWarpController={timeWarpController}
        pending={false}
        onEntityLockChange={vi.fn()}
        onRemoveEntity={vi.fn()}
        onStackCountChange={vi.fn()}
        onEntityPowerPriorityChange={vi.fn()}
        onSplitterDistributionModeChange={vi.fn()}
        onEnergyExchangerModeChange={vi.fn()}
        onFuelItemChange={vi.fn()}
        onBlackHolePausedChange={vi.fn()}
        onTimeWarpEnabledChange={enabled}
        onTimeWarpRequestedMultiplierChange={multiplier}
        onBeltLaneCountChange={vi.fn()}
        onBeltPriorityChange={vi.fn()}
        onRemoveBelt={vi.fn()}
      />,
    ));

    render(controllerProjection);
    expect(host.textContent).toContain("请求倍率15x");
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="原生倍率加一"]')!.click());
    expect(multiplier).toHaveBeenCalledWith("controller-a", 16);
    const start = [...host.querySelectorAll<HTMLButtonElement>("[data-native-time-warp-controller] button")]
      .find((button) => button.textContent?.includes("开始原生纯挂机"))!;
    act(() => start.click());
    expect(enabled).toHaveBeenCalledWith("controller-a", true);

    render({ ...controllerProjection, revision: 9 });
    expect(host.querySelector('[aria-label="Windows 原生时间扭曲请求倍率"]')).toBeNull();
    expect(host.textContent).toContain("控制保持关闭");
  });

  it("routes one ejector target from the same-revision bounded orbit page", () => {
    const changeOrbit = vi.fn();
    const ejector = projectedEntity({
      id: "ejector-a",
      buildingId: "em_rail_ejector",
      recipeId: "solar_sail_launch",
      powerPriority: undefined,
      targetDysonOrbitId: "orbit-old",
    });
    const ejectorSummary = {
      ...entity,
      entityId: ejector.id,
      buildingId: ejector.buildingId ?? null,
      recipeId: ejector.recipeId ?? null,
      machineCount: 1,
      inputItems: { rows: [], totalCount: 0, truncated: false },
    };
    const ejectorConfiguration = configuration(ejector);
    const oldOrbit = {
      orbitId: "orbit-old", name: "旧轨道", nameTruncated: false,
      radius: 12_000, inclination: 0, longitude: 0, sailsInOrbit: 0,
      totalLaunched: 0, totalExpired: 0, decayProgress: 0, generationKw: 0,
    } as const;
    const newOrbit = { ...oldOrbit, orbitId: "orbit-new", name: "新轨道", radius: 18_000 };
    const orbitFrame: NativeProjectedEjectorOrbitFrame = {
      ...ejectorConfiguration,
      registryFingerprint: "7df8cf3a",
      activeSystemId: "helios",
      source: "native-core",
      orbits: [oldOrbit, newOrbit],
      orbitsById: new Map([[oldOrbit.orbitId, oldOrbit], [newOrbit.orbitId, newOrbit]]),
    };
    const render = (frame: NativeProjectedEjectorOrbitFrame | null) => act(() => root.render(
      <NativeFactoryInspectorPanel
        inspector={inspector({ entity: ejectorSummary })}
        multiSelection={multi({ entityRows: { rows: [ejectorSummary], totalCount: 1, truncated: false } })}
        entityConfiguration={ejectorConfiguration}
        ejectorOrbitFrame={frame}
        pending={false}
        onEntityLockChange={vi.fn()}
        onRemoveEntity={vi.fn()}
        onStackCountChange={vi.fn()}
        onEntityPowerPriorityChange={vi.fn()}
        onSplitterDistributionModeChange={vi.fn()}
        onEnergyExchangerModeChange={vi.fn()}
        onFuelItemChange={vi.fn()}
        onBlackHolePausedChange={vi.fn()}
        onEjectorOrbitChange={changeOrbit}
        onBeltLaneCountChange={vi.fn()}
        onBeltPriorityChange={vi.fn()}
        onRemoveBelt={vi.fn()}
      />,
    ));

    render(orbitFrame);
    const select = host.querySelector<HTMLSelectElement>('[aria-label="Windows 原生太阳帆目标轨道"]')!;
    expect(select.value).toBe("orbit-old");
    act(() => {
      select.value = "orbit-new";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(changeOrbit).toHaveBeenCalledWith("ejector-a", "orbit-new");

    render({ ...orbitFrame, revision: 9 });
    expect(host.querySelector('[aria-label="Windows 原生太阳帆目标轨道"]')).toBeNull();
    expect(host.textContent).toContain("旧网页存档不会作为备用来源");
  });

  it("renders five Rust station slots and converges fleet controls only after ACK projection", () => {
    const onChange = vi.fn();
    const stationConfiguration = stationConfigurationReadModel();
    const stationSummary = stationEntityReadModel(stationConfiguration);
    const binding = stationProjectionBinding(stationConfiguration, { entity: stationSummary });
    const render = (
      projected: NativeProjectedStationConfigurationBinding | null,
      pending = false,
      projectionRevision = 8,
      projectedEntity: SelectedEntityReadModel = stationSummary,
    ) => act(() => root.render(
      <NativeFactoryInspectorPanel
        inspector={inspector({ revision: projectionRevision, entity: projectedEntity })}
        multiSelection={multi({
          revision: projectionRevision,
          projectionIdentity: { sessionId: "s", runId: "r", revision: projectionRevision, planetId: "home" },
          entityRows: { rows: [projectedEntity], totalCount: 1, truncated: false },
        })}
        entityConfiguration={null}
        stationConfiguration={projected}
        pending={pending}
        onEntityLockChange={vi.fn()}
        onRemoveEntity={vi.fn()}
        onStackCountChange={vi.fn()}
        onEntityPowerPriorityChange={vi.fn()}
        onSplitterDistributionModeChange={vi.fn()}
        onEnergyExchangerModeChange={vi.fn()}
        onFuelItemChange={vi.fn()}
        onBlackHolePausedChange={vi.fn()}
        onStationConfigurationChange={onChange}
        onBeltLaneCountChange={vi.fn()}
        onBeltPriorityChange={vi.fn()}
        onRemoveBelt={vi.fn()}
      />,
    ));

    render(binding);
    expect(host.querySelectorAll("[data-native-station-configuration] fieldset")).toHaveLength(5);
    expect(host.querySelector<HTMLSelectElement>('[aria-label="物流站槽位 2 物品"]')?.disabled).toBe(false);
    expect(host.querySelector<HTMLSelectElement>('[aria-label="物流站槽位 2 本地模式"]')?.disabled).toBe(false);
    expect(host.querySelector<HTMLSelectElement>('[aria-label="物流站槽位 2 星际模式"]')?.disabled).toBe(false);
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="物流无人机+10"]')!.click());
    expect(onChange).toHaveBeenLastCalledWith("station-ils", {
      kind: "station-fleet-adjust",
      fleetKind: "drone",
      adjustment: 10,
    });
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="物流运输船归零"]')!.click());
    expect(onChange).toHaveBeenLastCalledWith("station-ils", {
      kind: "station-fleet-adjust",
      fleetKind: "vessel",
      adjustment: "zero",
    });
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="站内翘曲器填满"]')!.click());
    expect(onChange).toHaveBeenLastCalledWith("station-ils", {
      kind: "station-warper-inventory-adjust",
      adjustment: "capacity",
    });
    expect(host.textContent).toContain("物流无人机 5 / 50");
    const priorityButtons = [...host.querySelectorAll<HTMLButtonElement>('[aria-label="物流站槽位 2 优先级"] button')];
    act(() => priorityButtons[2].click());
    expect(onChange).toHaveBeenLastCalledWith("station-ils", { kind: "slot-priority", slotIndex: 1, target: 2 });
    const localMode = host.querySelector<HTMLSelectElement>('[aria-label="物流站槽位 2 本地模式"]')!;
    act(() => {
      localMode.value = "demand";
      localMode.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(onChange).toHaveBeenLastCalledWith("station-ils", {
      kind: "slot-mode",
      slotIndex: 1,
      scope: "local",
      target: "demand",
    });
    expect(localMode.value).toBe("supply");

    render(binding, true);
    expect([...host.querySelectorAll<HTMLButtonElement>('[aria-label^="物流无人机"]')]
      .every((button) => button.disabled)).toBe(true);
    expect([...host.querySelectorAll<HTMLButtonElement>('[aria-label^="物流运输船"]')]
      .every((button) => button.disabled)).toBe(true);
    expect([...host.querySelectorAll<HTMLButtonElement>('[aria-label^="站内翘曲器"]')]
      .every((button) => button.disabled)).toBe(true);
    expect(host.textContent).toContain("物流无人机 5 / 50");
    expect([...host.querySelectorAll<HTMLButtonElement>('[aria-label="物流站槽位 2 优先级"] button')]
      .every((button) => button.disabled)).toBe(true);
    expect([...host.querySelectorAll<HTMLSelectElement>('[data-native-station-configuration] select')]
      .every((select) => select.disabled)).toBe(true);

    const acknowledgedConfiguration = { ...stationConfiguration, stationDrones: 7, stationWarpers: 3 } as const;
    const acknowledgedSummary = {
      ...stationSummary,
      stationConfiguration: acknowledgedConfiguration,
    } as const;
    const acknowledgedBinding: NativeProjectedStationConfigurationBinding = {
      ...binding,
      revision: 9,
      entity: acknowledgedSummary,
      configuration: acknowledgedConfiguration,
    };
    render(acknowledgedBinding, false, 9, acknowledgedSummary);
    expect(host.textContent).toContain("物流无人机 7 / 50");
    expect(host.textContent).toContain("站内翘曲器 3 / 50");

    render({ ...binding, revision: 7 });
    expect([...host.querySelectorAll<HTMLButtonElement>('[aria-label^="物流无人机"]')]
      .every((button) => button.disabled)).toBe(true);
    expect([...host.querySelectorAll<HTMLButtonElement>('[aria-label="物流站槽位 2 优先级"] button')]
      .every((button) => button.disabled)).toBe(true);

    const planetaryConfiguration = stationConfigurationReadModel({
      stationType: "planetary",
      spaceWarpUnlocked: false,
    });
    const planetarySummary = stationEntityReadModel(planetaryConfiguration, { entityId: "station-pls" });
    const planetaryBinding: NativeProjectedStationConfigurationBinding = {
      ...binding,
      revision: 10,
      entity: planetarySummary,
      configuration: planetaryConfiguration,
    };
    render(planetaryBinding, false, 10, planetarySummary);
    expect(host.querySelector('[aria-label="Windows 原生物流无人机数量"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="Windows 原生物流运输船数量"]')).toBeNull();
    expect(host.querySelector('[aria-label="Windows 原生站内翘曲器数量"]')).toBeNull();
  });

  it("requires explicit item confirmation, allows a rejected submission retry, and converges only after ACK", () => {
    const onChange = vi.fn();
    const initialConfiguration = stationConfigurationReadModel();
    const initialSummary = stationEntityReadModel(initialConfiguration);
    const initialBinding = stationProjectionBinding(initialConfiguration, { entity: initialSummary });
    const render = (
      projected: NativeProjectedStationConfigurationBinding | null,
      options: {
        pending?: boolean;
        revision?: number;
        summary?: SelectedEntityReadModel;
        sessionId?: string;
        runId?: string;
      } = {},
    ) => {
      const revision = options.revision ?? 8;
      const summary = options.summary ?? initialSummary;
      act(() => root.render(<NativeFactoryInspectorPanel
        inspector={inspector({ revision, entity: summary })}
        multiSelection={multi({
          revision,
          projectionIdentity: {
            sessionId: options.sessionId ?? "s",
            runId: options.runId ?? "r",
            revision,
            planetId: "home",
          },
          entityRows: { rows: [summary], totalCount: 1, truncated: false },
        })}
        entityConfiguration={null}
        stationConfiguration={projected}
        pending={options.pending ?? false}
        onEntityLockChange={vi.fn()}
        onRemoveEntity={vi.fn()}
        onStackCountChange={vi.fn()}
        onEntityPowerPriorityChange={vi.fn()}
        onSplitterDistributionModeChange={vi.fn()}
        onEnergyExchangerModeChange={vi.fn()}
        onFuelItemChange={vi.fn()}
        onBlackHolePausedChange={vi.fn()}
        onStationConfigurationChange={onChange}
        onBeltLaneCountChange={vi.fn()}
        onBeltPriorityChange={vi.fn()}
        onRemoveBelt={vi.fn()}
      />));
    };
    const chooseCopper = () => {
      const select = host.querySelector<HTMLSelectElement>('[aria-label="物流站槽位 2 物品"]')!;
      act(() => {
        select.value = "copper_ore";
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
      return select;
    };
    const dialogButton = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')]
      .find((button) => button.textContent === label)!;

    render(initialBinding);
    const firstSelect = chooseCopper();
    expect(firstSelect.value).toBe("iron_ore");
    expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain("取消相关物流路线");
    act(() => dialogButton("取消").click());
    expect(onChange).not.toHaveBeenCalled();

    chooseCopper();
    act(() => dialogButton("确认更换").click());
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith("station-ils", {
      kind: "slot-item",
      slotIndex: 1,
      target: "copper_ore",
    });
    expect(host.querySelector<HTMLSelectElement>('[aria-label="物流站槽位 2 物品"]')?.value).toBe("iron_ore");

    // The first synchronous submission can be rejected by App without a
    // pending transition. A fresh explicit confirmation must remain usable.
    chooseCopper();
    act(() => dialogButton("确认更换").click());
    expect(onChange).toHaveBeenCalledTimes(2);

    render(initialBinding, { pending: true });
    const pendingItem = host.querySelector<HTMLSelectElement>('[aria-label="物流站槽位 2 物品"]')!;
    expect(pendingItem.disabled).toBe(true);
    expect(pendingItem.value).toBe("iron_ore");

    const acknowledgedConfiguration = stationConfigurationReadModel({
      slots: initialConfiguration.slots.map((slot) => slot.slotIndex === 1
        ? { ...slot, itemId: "copper_ore" }
        : slot),
    });
    const acknowledgedSummary = stationEntityReadModel(acknowledgedConfiguration);
    const acknowledgedBinding = stationProjectionBinding(acknowledgedConfiguration, {
      revision: 9,
      entity: acknowledgedSummary,
    });
    render(acknowledgedBinding, { revision: 9, summary: acknowledgedSummary });
    expect(host.querySelector<HTMLSelectElement>('[aria-label="物流站槽位 2 物品"]')?.value).toBe("copper_ore");
  });

  it("cancels item confirmation on stale identity and keeps pending, locked, MOD, and truncated rows fail-closed", () => {
    const onChange = vi.fn();
    const initialConfiguration = stationConfigurationReadModel();
    const initialSummary = stationEntityReadModel(initialConfiguration);
    const initialBinding = stationProjectionBinding(initialConfiguration, { entity: initialSummary });
    const render = (
      projected: NativeProjectedStationConfigurationBinding | null,
      summary: SelectedEntityReadModel = initialSummary,
      pending = false,
      revision = 8,
    ) => act(() => root.render(<NativeFactoryInspectorPanel
      inspector={inspector({ revision, entity: summary })}
      multiSelection={multi({
        revision,
        projectionIdentity: { sessionId: "s", runId: "r", revision, planetId: "home" },
        entityRows: { rows: [summary], totalCount: 1, truncated: false },
      })}
      entityConfiguration={null}
      stationConfiguration={projected}
      pending={pending}
      onEntityLockChange={vi.fn()}
      onRemoveEntity={vi.fn()}
      onStackCountChange={vi.fn()}
      onEntityPowerPriorityChange={vi.fn()}
      onSplitterDistributionModeChange={vi.fn()}
      onEnergyExchangerModeChange={vi.fn()}
      onFuelItemChange={vi.fn()}
      onBlackHolePausedChange={vi.fn()}
      onStationConfigurationChange={onChange}
      onBeltLaneCountChange={vi.fn()}
      onBeltPriorityChange={vi.fn()}
      onRemoveBelt={vi.fn()}
    />));
    const openChange = () => {
      const select = host.querySelector<HTMLSelectElement>('[aria-label="物流站槽位 2 物品"]')!;
      act(() => {
        select.value = "copper_ore";
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
      expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
    };

    render(initialBinding);
    openChange();
    render(null);
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(onChange).not.toHaveBeenCalled();

    render(initialBinding);
    openChange();
    render({ ...initialBinding, revision: 7 });
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect([...host.querySelectorAll<HTMLSelectElement>('[data-native-station-configuration] select')]
      .every((select) => select.disabled)).toBe(true);

    const lockedSummary = stationEntityReadModel(initialConfiguration, { interactionLocked: true });
    const lockedBinding = stationProjectionBinding(initialConfiguration, { entity: lockedSummary });
    render(lockedBinding, lockedSummary);
    expect([...host.querySelectorAll<HTMLSelectElement>('[data-native-station-configuration] select')]
      .every((select) => select.disabled)).toBe(true);

    const forgedModConfiguration = {
      ...initialConfiguration,
      registryFingerprint: "MOD/forged",
    } as unknown as NativeStationConfigurationReadModel;
    const forgedSummary = stationEntityReadModel(forgedModConfiguration);
    render(null, forgedSummary);
    expect([...host.querySelectorAll<HTMLSelectElement>('[data-native-station-configuration] select')]
      .every((select) => select.disabled)).toBe(true);

    const truncatedRows = Array.from({ length: 128 }, (_, index) => ({
      itemId: `item_${String(index).padStart(3, "0")}`,
      name: `物品 ${index}`,
      kind: "solid" as const,
    }));
    const truncatedConfiguration = stationConfigurationReadModel({
      itemOptions: { rows: truncatedRows, totalCount: 129, truncated: true, limit: 128 },
      slots: initialConfiguration.slots.map((slot) => slot.slotIndex === 1
        ? { ...slot, itemId: "zz_current" }
        : slot),
    });
    const truncatedSummary = stationEntityReadModel(truncatedConfiguration);
    const truncatedBinding = stationProjectionBinding(truncatedConfiguration, { entity: truncatedSummary });
    render(truncatedBinding, truncatedSummary);
    const currentSelect = host.querySelector<HTMLSelectElement>('[aria-label="物流站槽位 2 物品"]')!;
    expect(currentSelect.value).toBe("zz_current");
    expect(currentSelect.querySelector<HTMLOptionElement>('option[value="zz_current"]')?.textContent)
      .toContain("（当前）");
    expect(host.querySelector<HTMLSelectElement>('[aria-label="物流站槽位 1 物品"] option[value="zz_current"]'))
      .toBeNull();
    act(() => {
      currentSelect.value = "";
      currentSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const confirm = [...document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')]
      .find((button) => button.textContent === "确认更换")!;
    act(() => confirm.click());
    expect(onChange).toHaveBeenLastCalledWith("station-ils", {
      kind: "slot-item",
      slotIndex: 1,
      target: null,
    });
  });
});
