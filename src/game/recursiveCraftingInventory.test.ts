import { describe, expect, it } from "vitest";
import { CONSTRUCTION, ITEMS, RECIPES, TECHNOLOGIES } from "./content";
import { createRecursiveCraftPlanner, type RecursiveCraftPlan } from "./recursiveCrafting";
import type { ItemId, RecipeDefinition, RecipeId } from "./types";

const decisions = ({ inventory: _inventory, ...plan }: RecursiveCraftPlan) => plan;
const changes = (before: Partial<Record<ItemId, number>>, after: Partial<Record<ItemId, number>>) =>
  Object.fromEntries([...new Set([...Object.keys(before), ...Object.keys(after)])].sort()
    .map((itemId) => [itemId, (after[itemId as ItemId] ?? 0) - (before[itemId as ItemId] ?? 0)] as const)
    .filter(([, amount]) => amount !== 0));

describe("recursive construction input projection", () => {
  it("includes alternate, locked and cyclic routes without collecting unrelated outputs", () => {
    const recipe = (id: string, input: ItemId, output: ItemId): RecipeDefinition => ({
      id: id as RecipeId, name: id, buildingId: "arc_smelter", duration: 1,
      inputs: [{ itemId: input, amount: 1 }], outputs: [{ itemId: output, amount: 1 }],
    });
    const planner = createRecursiveCraftPlanner({ completedTechnologyIds: [], recipes: [
      recipe("first", "iron_ingot", "steel"),
      { ...recipe("locked", "copper_ingot", "steel"), requiredTechId: "electromagnetism" },
      recipe("cycle", "steel", "iron_ingot"),
      recipe("unrelated", "stone", "stone_brick"),
    ] });
    expect([...planner.inventoryDependencies([{ itemId: "steel", amount: 1 }])].sort())
      .toEqual(["copper_ingot", "iron_ingot", "steel"]);
  });

  it.each(Array.from({ length: 64 }, (_, i) => i))("keeps route decisions and all material changes for catalog case %i", (index) => {
    let seed = index + 7;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
    const full = Object.fromEntries(Object.keys(ITEMS).map((id) => [id,
      index % 3 === 0 ? 50_000 : random() % 3 === 0 ? random() % 100 : 0,
    ]));
    const planner = createRecursiveCraftPlanner({ recipes: Object.values(RECIPES),
      completedTechnologyIds: Object.values(TECHNOLOGIES).filter(() => index % 4 !== 1 || random() % 4 > 0).map((t) => t.id),
    });
    const requirements = [...CONSTRUCTION[index % CONSTRUCTION.length].costs];
    if (index % 5 === 0) requirements.push(...CONSTRUCTION[(index + 1) % CONSTRUCTION.length].costs);
    const relevant = planner.inventoryDependencies(requirements);
    const projected = Object.fromEntries(Object.entries(full).filter(([id]) => relevant.has(id as ItemId)));
    const reference = planner.requirements(full, requirements);
    const actual = planner.requirements(projected, requirements);
    expect(decisions(actual)).toEqual(decisions(reference));
    expect(changes(projected, actual.inventory)).toEqual(changes(full, reference.inventory));
  });
});
