// @vitest-environment jsdom

import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  FactoryInspectorSummaryReadModel,
  FactoryMultiSelectionSummaryReadModel,
} from "../game/factoryReadModels";
import { createInitialState } from "../game/engine";
import type { BeltConnection, FactoryEntity, GameState, PlanetId } from "../game/types";
import {
  createWebFactoryInspectorSummaryReadModel,
  createWebFactoryMultiSelectionSummaryReadModel,
} from "../game/webFactoryReadModelAdapter";
import { InspectorPanel } from "./GamePanels";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Props = ComponentProps<typeof InspectorPanel>;

function machineFixture(planetId: PlanetId = "home"): FactoryEntity {
  const initial = createInitialState();
  return {
    ...initial.entities[0],
    id: `inspector-machine-${planetId}`,
    planetId,
    kind: "machine",
    buildingId: "assembling_machine_mk1",
    resourceId: undefined,
    recipeId: "iron_ingot",
    storedItemId: undefined,
    fuelItemId: undefined,
    machineCount: 4,
    minerCount: 0,
    progress: 0.42,
    utilization: 0.73,
    productionRate: 18.5,
    powerFactor: 0.81,
    interactionLocked: true,
    inputs: { iron_ore: 12 },
    outputs: { iron_ingot: 3 },
  };
}

function beltFixture(game: GameState, planetId: PlanetId = game.activePlanetId): BeltConnection {
  return {
    id: `inspector-belt-${planetId}`,
    planetId,
    source: game.entities[0].id,
    target: game.entities[1].id,
    itemId: "iron_ingot",
    lanes: 4,
    tier: 3,
    sorterTier: 2,
    stackSize: 4,
    priority: 2,
    progress: 0.25,
    lastFlow: 123.5,
    totalTransferred: 9_876,
    congestion: 0.75,
  };
}

function nativeInspectorModel(
  game: GameState,
  entity: FactoryEntity | null,
  belt: BeltConnection | null,
  revision = 41,
): FactoryInspectorSummaryReadModel {
  return {
    ...createWebFactoryInspectorSummaryReadModel(game, entity, belt),
    source: "native-core",
    revision,
  };
}

function nativeMultiSelectionModel(
  game: GameState,
  entities: readonly FactoryEntity[],
  belts: readonly BeltConnection[],
  revision = 41,
): FactoryMultiSelectionSummaryReadModel {
  return {
    ...createWebFactoryMultiSelectionSummaryReadModel(game, entities, belts, {
      selectedEntityIds: entities.map((entity) => entity.id),
      selectedBeltIds: belts.map((belt) => belt.id),
    }),
    source: "native-core",
    revision,
  };
}

function panelProps(overrides: Partial<Props> = {}): Props {
  const game = overrides.game ?? createInitialState();
  const selectedEntities = overrides.selectedEntities ?? [];
  const multiSelectedBelts = overrides.multiSelectedBelts ?? [];
  return {
    readOnly: true,
    game,
    inspectorReadModel: nativeInspectorModel(
      game,
      overrides.selectedEntity ?? null,
      overrides.selectedBelt ?? null,
    ),
    multiSelectionReadModel: nativeMultiSelectionModel(game, selectedEntities, multiSelectedBelts),
    multiSelectedBelts,
    selectedEntities,
    selectedEntity: null,
    selectedBelt: null,
    tab: "fabricate",
    onTabChange: vi.fn(),
    ...overrides,
  } as Props;
}

describe("InspectorPanel native-authority read-only boundary", () => {
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

  function render(props: Props): void {
    act(() => root.render(<InspectorPanel {...props} />));
  }

  function expectOnlyDisabledInspectorTab(): void {
    const controls = [...host.querySelectorAll<HTMLButtonElement>("button")];
    expect(controls).toHaveLength(1);
    expect(controls[0].disabled).toBe(true);
    expect(controls[0].textContent).toContain("检查器");
    expect(host.textContent).not.toContain("基础制造");
    expect(host.querySelector(".fabricator-workspace,.inspector-entity-shell,.multi-selection-inspector,.inspector-empty")).toBeNull();
    expect(host.querySelector("select,input,textarea")).toBeNull();
  }

  it("keeps an exact native entity summary while the legacy GameState route is stale", () => {
    const legacyGame = createInitialState();
    const entity = machineFixture("ashen");
    const projectionGame: GameState = { ...legacyGame, activePlanetId: "ashen", entities: [entity], belts: [] };
    const onTabChange = vi.fn();
    const inspectorReadModel = nativeInspectorModel(projectionGame, entity, null, 57);

    render(panelProps({
      game: legacyGame,
      inspectorReadModel,
      selectedEntities: [entity],
      selectedEntity: entity,
      tab: "fabricate",
      onTabChange,
    }));

    const summary = host.querySelector("[aria-label='实时运行摘要']");
    expect(host.querySelector("[data-native-authority-read-only='true']")).not.toBeNull();
    expect(summary?.getAttribute("data-factory-read-model-source")).toBe("native-core");
    expect(summary?.getAttribute("data-factory-read-model-revision")).toBe("57");
    expect(host.textContent).toContain("近期产出18.5/min");
    expect(host.textContent).not.toContain("建筑已锁定");
    expectOnlyDisabledInspectorTab();

    host.querySelector<HTMLButtonElement>("button")?.click();
    expect(onTabChange).not.toHaveBeenCalled();
  });

  it("keeps an exact native belt summary without mounting belt controls", () => {
    const game = createInitialState();
    const belt = beltFixture(game);
    const inspectorReadModel = nativeInspectorModel(game, null, belt, 58);

    render(panelProps({
      game,
      inspectorReadModel,
      multiSelectedBelts: [belt],
      selectedBelt: belt,
    }));

    const summary = host.querySelector("[aria-label='实时线路摘要']");
    expect(summary?.getAttribute("data-factory-read-model-source")).toBe("native-core");
    expect(summary?.getAttribute("data-factory-read-model-revision")).toBe("58");
    expect(host.textContent).toContain("近期流量123.50/s");
    expect(host.textContent).not.toContain("移除整网");
    expectOnlyDisabledInspectorTab();
  });

  it("shows only verified counts for a mixed multi-selection", () => {
    const game = createInitialState();
    const entity = machineFixture(game.activePlanetId);
    const belt = beltFixture(game);
    const projectionGame: GameState = { ...game, entities: [entity], belts: [belt] };
    const multiSelectionReadModel = nativeMultiSelectionModel(projectionGame, [entity], [belt], 59);

    render(panelProps({
      game: projectionGame,
      inspectorReadModel: nativeInspectorModel(projectionGame, entity, null, 59),
      multiSelectionReadModel,
      selectedEntities: [entity],
      selectedEntity: entity,
      multiSelectedBelts: [belt],
      selectedBelt: belt,
    }));

    const summary = host.querySelector("[aria-label='Windows 原生只读多选摘要']");
    expect(summary?.getAttribute("data-factory-read-model-source")).toBe("native-core");
    expect(summary?.getAttribute("data-factory-read-model-revision")).toBe("59");
    expect(host.textContent).toContain("1 个建筑 · 1 条线路");
    expect(host.textContent).toContain("当前只显示数量");
    expectOnlyDisabledInspectorTab();
  });

  it.each([
    ["drifted entity row", (model: FactoryInspectorSummaryReadModel) => ({
      ...model,
      entity: model.entity ? { ...model.entity, productionRate: 999 } : null,
    })],
    ["wrong schema", (model: FactoryInspectorSummaryReadModel) => ({
      ...model,
      schema: "wrong-schema" as FactoryInspectorSummaryReadModel["schema"],
    })],
    ["wrong planet", (model: FactoryInspectorSummaryReadModel) => ({
      ...model,
      activePlanetId: "ashen" as PlanetId,
    })],
    ["wrong selected row", (model: FactoryInspectorSummaryReadModel) => ({
      ...model,
      entity: model.entity ? { ...model.entity, entityId: "another-entity" } : null,
    })],
    ["missing committed revision", (model: FactoryInspectorSummaryReadModel) => ({ ...model, revision: null })],
  ])("fails closed instead of exposing Web/raw state for a %s", (_label, mutate) => {
    const game = createInitialState();
    const entity = machineFixture(game.activePlanetId);
    const valid = nativeInspectorModel({ ...game, entities: [entity] }, entity, null, 60);

    render(panelProps({
      game,
      inspectorReadModel: mutate(valid),
      selectedEntities: [entity],
      selectedEntity: entity,
    }));

    expect(host.querySelector("[aria-label='Windows 原生只读检查器'][role='status']")?.textContent).toContain("正在核对原生检查摘要");
    expect(host.querySelector("[data-factory-read-model-source='web-game-state']")).toBeNull();
    expect(host.textContent).not.toContain("999.0/min");
    expectOnlyDisabledInspectorTab();
  });

  it("fails closed for a truncated or mismatched native multi-selection", () => {
    const game = createInitialState();
    const first = machineFixture(game.activePlanetId);
    const second: FactoryEntity = { ...first, id: "inspector-machine-second", interactionLocked: false };
    const projectionGame: GameState = { ...game, entities: [first, second], belts: [] };
    const valid = nativeMultiSelectionModel(projectionGame, [first, second], [], 61);
    const invalid: FactoryMultiSelectionSummaryReadModel = {
      ...valid,
      entityRows: { ...valid.entityRows, truncated: true },
    };

    render(panelProps({
      game: projectionGame,
      inspectorReadModel: nativeInspectorModel(projectionGame, first, null, 61),
      multiSelectionReadModel: invalid,
      selectedEntities: [first, second],
      selectedEntity: first,
    }));

    expect(host.querySelector("[aria-label='Windows 原生检查器等待同步']")?.textContent).toContain("正在核对原生多选摘要");
    expect(host.textContent).not.toContain("2 个建筑 · 0 条线路");
    expect(host.querySelector("[data-factory-read-model-source='web-game-state']")).toBeNull();
    expectOnlyDisabledInspectorTab();
  });

  it("renders an inert empty state instead of the legacy InspectorEmpty actions", () => {
    const game = createInitialState();
    const onOpenTutorial = vi.fn();

    render(panelProps({ game, selectedEntities: [], multiSelectedBelts: [], onOpenTutorial }));

    expect(host.querySelector("[aria-label='Windows 原生只读检查器'][role='status']")?.textContent).toContain("请选择一个建筑或传送带");
    expect(host.querySelector(".inspector-empty")).toBeNull();
    expect(host.textContent).not.toContain("查看常见故障排查教程");
    expect(onOpenTutorial).not.toHaveBeenCalled();
    expectOnlyDisabledInspectorTab();
  });

  it("preserves the editable fabricator when native read-only mode is not requested", () => {
    const game = createInitialState();

    render(panelProps({ game, readOnly: false, tab: "fabricate" }));

    expect(host.querySelector("[data-native-authority-read-only='true']")).toBeNull();
    expect(host.querySelectorAll("[role='tab']")).toHaveLength(2);
    expect(host.querySelector(".fabricator-workspace")).not.toBeNull();
    expect(host.textContent).toContain("基础制造");
  });

  it("keeps projected live summaries exclusive to native read-only ownership", () => {
    const game = createInitialState();
    const belt = beltFixture(game);
    const projectionGame: GameState = { ...game, belts: [belt] };

    render(panelProps({
      game: projectionGame,
      readOnly: false,
      tab: "inspect",
      selectedEntities: [],
      selectedEntity: null,
      multiSelectedBelts: [belt],
      selectedBelt: belt,
      inspectorReadModel: nativeInspectorModel(projectionGame, null, belt, 62),
    }));

    expect(host.querySelector(".belt-lane-control")).not.toBeNull();
    expect(host.querySelector(".desktop-inspector-live-summary")).toBeNull();
    expect(host.querySelector("[data-native-authority-read-only='true']")).toBeNull();
  });
});
