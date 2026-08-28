// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { FactoryInspectorSummaryReadModel } from "../game/factoryReadModels";
import { createInitialState } from "../game/engine";
import type { BeltConnection, FactoryEntity } from "../game/types";
import { createWebFactoryInspectorSummaryReadModel } from "../game/webFactoryReadModelAdapter";
import { DesktopInspectorLiveSummary } from "./GamePanels";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function entityFixture() {
  const game = createInitialState();
  const entity: FactoryEntity = {
    ...game.entities[0],
    id: "desktop-entity",
    planetId: game.activePlanetId,
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

function beltFixture() {
  const game = createInitialState();
  const belt: BeltConnection = {
    id: "desktop-belt",
    planetId: game.activePlanetId,
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
  game.belts = [belt];
  const web = createWebFactoryInspectorSummaryReadModel(game, null, belt);
  const native: FactoryInspectorSummaryReadModel = {
    ...web,
    source: "native-core",
    revision: 52,
  };
  return { game, belt, native };
}

describe("DesktopInspectorLiveSummary bounded projection", () => {
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

  it("renders exact native entity progress, utilization, production, power and complete I/O", () => {
    const { game, entity, native } = entityFixture();
    act(() => root.render(<DesktopInspectorLiveSummary game={game} entity={entity} belt={null} readModel={native} />));

    const summary = host.querySelector("[aria-label='实时运行摘要']");
    expect(summary?.getAttribute("data-factory-read-model-source")).toBe("native-core");
    expect(summary?.getAttribute("data-factory-read-model-revision")).toBe("41");
    expect(host.textContent).toContain("周期进度42%");
    expect(host.textContent).toContain("当前利用率73%");
    expect(host.textContent).toContain("近期产出18.5/min");
    expect(host.textContent).toContain("供电系数81%");
    expect(host.textContent).toContain("输入 · 铁矿石12");
    expect(host.textContent).toContain("输出 · 铁块3");
    expect(summary?.querySelector("button")).toBeNull();
  });

  it("falls back atomically when a native entity row drifts or its item ledger is truncated", () => {
    const { game, entity, native } = entityFixture();
    const mismatched: FactoryInspectorSummaryReadModel = {
      ...native,
      entity: {
        ...native.entity!,
        productionRate: 999,
        inputItems: { ...native.entity!.inputItems, truncated: true },
      },
    };
    act(() => root.render(<DesktopInspectorLiveSummary game={game} entity={entity} belt={null} readModel={mismatched} />));

    const summary = host.querySelector("[aria-label='实时运行摘要']");
    expect(summary?.getAttribute("data-factory-read-model-source")).toBe("web-game-state");
    expect(summary?.getAttribute("data-factory-read-model-revision")).toBe("web");
    expect(host.textContent).toContain("近期产出18.5/min");
    expect(host.textContent).toContain("输入 · 铁矿石12");
    expect(host.textContent).not.toContain("999.0/min");
  });

  it("does not adopt a native-marked row without a valid committed revision", () => {
    const { game, entity, native } = entityFixture();
    const missingRevision: FactoryInspectorSummaryReadModel = { ...native, revision: null };
    act(() => root.render(<DesktopInspectorLiveSummary game={game} entity={entity} belt={null} readModel={missingRevision} />));

    const summary = host.querySelector("[aria-label='实时运行摘要']");
    expect(summary?.getAttribute("data-factory-read-model-source")).toBe("web-game-state");
    expect(summary?.getAttribute("data-factory-read-model-revision")).toBe("web");
    expect(host.textContent).toContain("近期产出18.5/min");
  });

  it("renders exact native belt flow, stack, progress, priority, congestion and total", () => {
    const { game, belt, native } = beltFixture();
    act(() => root.render(<DesktopInspectorLiveSummary game={game} entity={null} belt={belt} readModel={native} />));

    const summary = host.querySelector("[aria-label='实时线路摘要']");
    expect(summary?.getAttribute("data-factory-read-model-source")).toBe("native-core");
    expect(summary?.getAttribute("data-factory-read-model-revision")).toBe("52");
    expect(host.textContent).toContain("传送带等级Mk.III");
    expect(host.textContent).toContain("并行线路×4");
    expect(host.textContent).toContain("近期流量123.50/s");
    expect(host.textContent).toContain("货物堆叠×4");
    expect(host.textContent).toContain("线路优先级高");
    expect(host.textContent).toContain("在途进度25%");
    expect(host.textContent).toContain("拥堵指数75%");
    expect(host.textContent).toContain("累计运输9,876");
    expect(summary?.querySelector("button")).toBeNull();
  });

  it("falls back when native belt selection, planet or semantics do not exactly match", () => {
    const { game, belt, native } = beltFixture();
    const mismatched: FactoryInspectorSummaryReadModel = {
      ...native,
      activePlanetId: "mars",
      belt: { ...native.belt!, beltId: "other-belt", lastFlow: 999 },
    };
    act(() => root.render(<DesktopInspectorLiveSummary game={game} entity={null} belt={belt} readModel={mismatched} />));

    const summary = host.querySelector("[aria-label='实时线路摘要']");
    expect(summary?.getAttribute("data-factory-read-model-source")).toBe("web-game-state");
    expect(summary?.getAttribute("data-factory-read-model-revision")).toBe("web");
    expect(host.textContent).toContain("近期流量123.50/s");
    expect(host.textContent).not.toContain("999.00/s");
  });
});
