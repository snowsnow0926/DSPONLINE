import { describe, expect, it } from "vitest";
import { CONSTRUCTION, ITEMS, RECIPES, TECHNOLOGIES } from "./content";
import { createRecursiveCraftPlanner, planRecursiveRequirements, planSelectedRecipe } from "./recursiveCrafting";
import * as eager from "./recursiveCrafting.eager-reference";
import type { ItemId, RecipeDefinition, RecipeId } from "./types";

describe("lazy recursive planner matches the frozen eager planner", () => {
  it("owns its technology snapshot and keeps repeated plan results isolated", () => {
    const recipes = Object.values(RECIPES);
    const completedTechnologyIds = Object.keys(TECHNOLOGIES) as (keyof typeof TECHNOLOGIES)[];
    const options = { recipes, completedTechnologyIds };
    const planner = createRecursiveCraftPlanner(options);
    const inventory = Object.fromEntries(Object.keys(ITEMS).map((id) => [id, 1_000]));
    const requirements = [{ itemId: "steel" as const, amount: 1_001 }];
    const expected = eager.planRecursiveRequirements({ ...options, inventory, requirements });
    completedTechnologyIds.length = 0;
    const first = planner.requirements(inventory, requirements);
    expect(first).toEqual(expected);
    first.inventory.steel = -1;
    first.steps.length = 0;
    first.decisions.length = 0;
    expect(planner.requirements(inventory, requirements)).toEqual(expected);
    expect(inventory.steel).toBe(1_000);
  });
  it.each(Array.from({ length: 192 }, (_, index) => index))("preserves complete plans and blockers for catalog case %i", (index) => {
    let seed = index + 1;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
    const inventory = Object.fromEntries(Object.keys(ITEMS).map((id) => [id,
      index % 3 === 0 ? 50_000 : random() % 5 === 0 ? random() % 80 : 0,
    ]));
    const completedTechnologyIds = Object.values(TECHNOLOGIES)
      .filter(() => index % 4 !== 1 || random() % 4 > 0).map((technology) => technology.id);
    const recipes = Object.values(RECIPES);
    const optionLimit = [1, 2, 3, 8, 24, 64][index % 6];
    const original = structuredClone(inventory);
    const requirements = [...CONSTRUCTION[index % CONSTRUCTION.length].costs];
    if (index % 5 === 0) requirements.push(...CONSTRUCTION[(index + 1) % CONSTRUCTION.length].costs);
    const args = { inventory, requirements, recipes, completedTechnologyIds, optionLimit };
    expect(planRecursiveRequirements(args)).toEqual(eager.planRecursiveRequirements(args));
    const selectedArgs = { inventory, recipe: recipes[index % recipes.length], batches: 1 + index % 4,
      recipes, completedTechnologyIds, optionLimit };
    expect(planSelectedRecipe(selectedArgs)).toEqual(eager.planSelectedRecipe(selectedArgs));
    expect(inventory).toEqual(original);
  });

  it.each([1, 2, 3, 8, 24, 64])("preserves pruning and shared-input backtracking at limit %i", (optionLimit) => {
    const recipes: RecipeDefinition[] = Array.from({ length: 70 }, (_, index) => ({
      id: `lazy-test-${index}` as RecipeId, name: `route ${index}`, buildingId: "arc_smelter", duration: 1,
      recursivePriority: 70 - index,
      inputs: [{ itemId: (index % 2 ? "copper_ore" : "iron_ore") as ItemId, amount: 1 + index % 5 }],
      outputs: [{ itemId: "steel", amount: 1 }],
    }));
    const args = { recipes, inventory: { iron_ore: 1, copper_ore: 50 }, completedTechnologyIds: [], optionLimit,
      requirements: [{ itemId: "steel" as const, amount: 1 }, { itemId: "iron_ore" as const, amount: 1 }] };
    expect(planRecursiveRequirements(args)).toEqual(eager.planRecursiveRequirements(args));
  });

  it("does not expand an unused lower-priority route", () => {
    let lowerReads = 0;
    const high: RecipeDefinition = { id: "high" as RecipeId, name: "high", buildingId: "arc_smelter", duration: 1,
      recursivePriority: 100, inputs: [{ itemId: "iron_ore", amount: 1 }], outputs: [{ itemId: "steel", amount: 1 }] };
    const low: RecipeDefinition = { ...high, id: "low" as RecipeId, recursivePriority: 0,
      get inputs() { lowerReads += 1; return [{ itemId: "copper_ore" as const, amount: 1 }]; } };
    const args = { recipes: [high, low], inventory: { iron_ore: 20, copper_ore: 20 }, completedTechnologyIds: [],
      requirements: [{ itemId: "steel" as const, amount: 1 }] };
    const actual = planRecursiveRequirements(args);
    const lazyReads = lowerReads;
    lowerReads = 0;
    expect(actual).toEqual(eager.planRecursiveRequirements(args));
    expect(lazyReads).toBeLessThan(lowerReads);
  });
});
