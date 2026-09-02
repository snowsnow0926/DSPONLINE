// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FACTORY_READ_MODEL_LIMITS, type FactoryMultiSelectionSummaryReadModel } from "../game/factoryReadModels";
import { createInitialState } from "../game/engine";
import type { BeltConnection, FactoryEntity } from "../game/types";
import { createWebFactoryMultiSelectionSummaryReadModel } from "../game/webFactoryReadModelAdapter";
import { DesktopMultiSelectionLiveSummary } from "./GamePanels";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function fixture() {
  const game = createInitialState();
  const first: FactoryEntity = {
    ...game.entities[0],
    id: "multi-first",
    planetId: game.activePlanetId,
    kind: "machine",
    buildingId: "assembling_machine_mk1",
    resourceId: undefined,
    recipeId: "iron_ingot",
    machineCount: 2,
    minerCount: 0,
    progress: 0.25,
    utilization: 0.5,
    productionRate: 10,
    powerFactor: 0.8,
    inputs: { iron_ore: 2 },
    outputs: { iron_ingot: 1 },
  };
  const second: FactoryEntity = {
    ...game.entities[1],
    id: "multi-second",
    planetId: game.activePlanetId,
    kind: "machine",
    buildingId: "assembling_machine_mk1",
    resourceId: undefined,
    recipeId: "iron_ingot",
    machineCount: 1,
    minerCount: 0,
    progress: 0.75,
    utilization: 1,
    productionRate: 20,
    powerFactor: 0.5,
    inputs: { iron_ore: 5, copper_ore: 4 },
    outputs: { iron_ingot: 3 },
  };
  const belts: BeltConnection[] = [{
    id: "multi-belt-a",
    planetId: game.activePlanetId,
    source: first.id,
    target: second.id,
    itemId: "iron_ingot",
    lanes: 2,
    tier: 2,
    sorterTier: 2,
    stackSize: 2,
    priority: 1,
    progress: 0.25,
    lastFlow: 10,
    totalTransferred: 100,
    congestion: 0.2,
  }, {
    id: "multi-belt-b",
    planetId: game.activePlanetId,
    source: second.id,
    target: first.id,
    itemId: "iron_ingot",
    lanes: 4,
    tier: 3,
    sorterTier: 3,
    stackSize: 4,
    priority: 2,
    progress: 0.75,
    lastFlow: 20,
    totalTransferred: 300,
    congestion: 0.8,
  }];
  const entities = [first, second];
  game.entities = entities;
  game.belts = belts;
  const web = createWebFactoryMultiSelectionSummaryReadModel(
    game,
    entities,
    belts,
    { selectedEntityIds: entities.map((entity) => entity.id), selectedBeltIds: belts.map((belt) => belt.id) },
  );
  const native: FactoryMultiSelectionSummaryReadModel = { ...web, source: "native-core", revision: 33 };
  return { game, entities, belts, native, web };
}

describe("DesktopMultiSelectionLiveSummary", () => {
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

  it("aggregates complete native entity and belt rows without exposing commands", () => {
    const { game, entities, belts, native } = fixture();
    act(() => root.render(<DesktopMultiSelectionLiveSummary game={game} entities={entities} belts={belts} readModel={native} />));

    const summary = host.querySelector("[aria-label='选区实时动态摘要']");
    expect(summary?.getAttribute("data-factory-read-model-source")).toBe("native-core");
    expect(summary?.getAttribute("data-factory-read-model-revision")).toBe("33");
    expect(host.textContent).toContain("设备总数3");
    expect(host.textContent).toContain("平均周期进度42%");
    expect(host.textContent).toContain("平均利用率67%");
    expect(host.textContent).toContain("合计近期产出30.0/min");
    expect(host.textContent).toContain("平均供电系数70%");
    expect(host.textContent).toContain("输入合计 · 铁矿石7");
    expect(host.textContent).toContain("输入合计 · 铜矿石4");
    expect(host.textContent).toContain("输出合计 · 铁块4");
    expect(host.textContent).toContain("线路合计流量30.00/s");
    expect(host.textContent).toContain("平均线路拥堵50%");
    expect(host.textContent).toContain("最高线路拥堵80%");
    expect(host.textContent).toContain("平均在途进度50%");
    expect(host.textContent).toContain("平均货物堆叠×3.00");
    expect(host.textContent).toContain("线路累计运输400");
    expect(summary?.querySelector("button,select,input")).toBeNull();
  });

  it("falls back as one block when any native row drifts or has truncated I/O", () => {
    const { game, entities, belts, native } = fixture();
    const drifted: FactoryMultiSelectionSummaryReadModel = {
      ...native,
      entityRows: {
        ...native.entityRows,
        rows: native.entityRows.rows.map((row, index) => index === 0
          ? { ...row, productionRate: 999, inputItems: { ...row.inputItems, truncated: true } }
          : row),
      },
    };
    act(() => root.render(<DesktopMultiSelectionLiveSummary game={game} entities={entities} belts={belts} readModel={drifted} />));

    const summary = host.querySelector("[aria-label='选区实时动态摘要']");
    expect(summary?.getAttribute("data-factory-read-model-source")).toBe("web-game-state");
    expect(summary?.getAttribute("data-factory-read-model-revision")).toBe("web");
    expect(host.textContent).toContain("合计近期产出30.0/min");
    expect(host.textContent).not.toContain("1019.0/min");
  });

  it("uses all full-state records for the Web fallback when selection exceeds the 64-row limit", () => {
    const { game, entities, web } = fixture();
    const many = Array.from({ length: FACTORY_READ_MODEL_LIMITS.selectedEntityRows + 1 }, (_, index): FactoryEntity => ({
      ...entities[0],
      id: `over-limit-${index}`,
      machineCount: 1,
      productionRate: 1,
      inputs: {},
      outputs: {},
    }));
    const overLimit = createWebFactoryMultiSelectionSummaryReadModel(
      game,
      many,
      [],
      { selectedEntityIds: many.map((entity) => entity.id), selectedBeltIds: [] },
    );
    expect(overLimit.entityRows.truncated).toBe(true);
    act(() => root.render(<DesktopMultiSelectionLiveSummary game={game} entities={many} belts={[]} readModel={{ ...web, ...overLimit }} />));

    const summary = host.querySelector("[aria-label='选区实时动态摘要']");
    expect(summary?.getAttribute("data-factory-read-model-source")).toBe("web-game-state");
    expect(host.textContent).toContain("设备总数65");
    expect(host.textContent).toContain("合计近期产出65.0/min");
  });
});
