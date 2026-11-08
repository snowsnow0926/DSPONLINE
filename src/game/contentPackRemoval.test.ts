import { afterEach, describe, expect, it } from "vitest";
import { createExampleContentPack } from "../components/ContentPackAuthor";
import { createInitialState } from "./engine";
import { addContentPackResources } from "./contentRules";
import { prepareContentPackRemoval } from "./contentPackRemoval";
import { applyContentPackRegistry, createContentPackRegistry, getContentPackUsage, registerContentPack } from "./contentPacks";
import { validateContentPack } from "./mods";
import type { GameState, ItemId, TechId } from "./types";

afterEach(() => applyContentPackRegistry(createContentPackRegistry()));
function fixture() {
  const manifest = createExampleContentPack();
  const registry = registerContentPack(createContentPackRegistry(), validateContentPack(manifest)).registry;
  expect(applyContentPackRegistry(registry).catalogValid).toBe(true);
  return { manifest, state: addContentPackResources(createInitialState()) };
}
describe("content-pack metadata removal", () => {
  it("can clear seeded resources, research and historical production while preserving the original and every real inventory", () => {
    const { state, manifest } = fixture();
    const techId = "crystal_efficiency" as TechId;
    const itemId = "crystal_ore" as ItemId;
    state.research.completedTechIds.push(techId);
    state.research.progressByTech[techId] = { electromagnetic_matrix: 3 };
    state.totalProduced[itemId] = 42;
    state.productionHistory.push({ elapsedSeconds: 0, productionPerMinute: { [itemId]: 2 }, consumptionPerMinute: {}, inventory: { [itemId]: 0 }, generationKw: 0, demandKw: 0 });
    state.tray.iron_ingot = 17;
    const before = JSON.stringify(state);
    expect(getContentPackUsage(state, manifest).total).toBeGreaterThan(0);
    const plan = prepareContentPackRemoval(state, manifest);
    expect(plan.blockers).toEqual({ total: 0, entries: [] });
    expect(plan.cleanup.join("、")).toContain("科技记录");
    expect(plan.cleanup.join("、")).toContain("资源点");
    expect(plan.state.entities.some(entity => entity.resourceId === itemId)).toBe(false);
    expect(plan.state.research.completedTechIds).not.toContain(techId);
    expect(plan.state.tray).toBe(state.tray);
    expect(plan.state.tray.iron_ingot).toBe(17);
    expect(JSON.stringify(state)).toBe(before);
  });

  it.each(["tray", "machine", "quantum", "miner"])("blocks cleanup when %s still contains real pack content", location => {
    const { state, manifest } = fixture();
    if (location === "tray") state.tray["crystal_ore" as ItemId] = 7;
    if (location === "machine") state.entities[0].outputs["crystal_ore" as ItemId] = 8;
    if (location === "quantum") state.quantumLogisticsNetwork.inventory["crystal_ore" as ItemId] = "9007199254740993";
    if (location === "miner") state.entities.find(entity => entity.resourceId === "crystal_ore" as ItemId)!.minerCount = 1;
    const before = JSON.stringify(state);
    const plan = prepareContentPackRemoval(state, manifest);
    expect(plan.blockers.total).toBeGreaterThan(0);
    expect(JSON.stringify(state)).toBe(before);
  });

  it("removes only zero-quantity indexes left after consuming pack stock", () => {
    const { state, manifest } = fixture();
    const itemId = "crystal_ore" as ItemId;
    state.tray[itemId] = 0;
    state.tray.iron_ingot = 17;
    state.planetTrays.home[itemId] = 0;
    state.entities[0].inputs[itemId] = 0;
    state.entities[0].outputs[itemId] = 0;
    state.quantumLogisticsNetwork.inventory[itemId] = "0";
    state.construction["crystal_drill" as keyof GameState["construction"]] = 0;
    const original = JSON.stringify(state);
    const plan = prepareContentPackRemoval(state, manifest);
    expect(plan.blockers.total).toBe(0);
    expect(plan.cleanup.join("、")).toContain("零库存索引");
    expect(plan.state.tray[itemId]).toBeUndefined();
    expect(plan.state.planetTrays.home[itemId]).toBeUndefined();
    expect(plan.state.entities[0].inputs[itemId]).toBeUndefined();
    expect(plan.state.entities[0].outputs[itemId]).toBeUndefined();
    expect(plan.state.quantumLogisticsNetwork.inventory[itemId]).toBeUndefined();
    expect(plan.state.construction["crystal_drill" as keyof GameState["construction"]]).toBeUndefined();
    expect(plan.state.tray.iron_ingot).toBe(17);
    expect(JSON.stringify(state)).toBe(original);
    state.entities[0].inputs[itemId] = 1;
    const occupied = prepareContentPackRemoval(state, manifest);
    expect(occupied.blockers.total).toBeGreaterThan(0);
    expect(occupied.state.entities[0].inputs[itemId]).toBe(1);
  });

  it("recognizes a custom belt's numeric tier even when it transports only core items", () => {
    const manifest = { formatVersion: 5, id: "belt_pack", name: "线路包", version: "1.0.0", belts: [{ id: "custom_belt", name: "线路", tier: 4, speed: 60, costs: [{ itemId: "iron_ingot", amount: 1 }] }] };
    const state = createInitialState();
    state.belts = [{ id: "line", planetId: "home", tier: 4, itemId: "iron_ore", source: "source", target: "target", lanes: 1, sorterTier: 1, progress: 0, priority: 2, lastFlow: 0 }];
    expect(getContentPackUsage(state, manifest).entries.join("、")).toContain("自定义传送带");
    expect(prepareContentPackRemoval(state, manifest).blockers.total).toBeGreaterThan(0);
  });
});
