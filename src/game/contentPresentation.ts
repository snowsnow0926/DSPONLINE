import { BUILDINGS, ITEMS, RECIPES } from "./content";
import type { BuildingDefinition, BuildingId, ItemDefinition, ItemId, RecipeId } from "./types";

// React Flow may keep one committed node frame while a catalog and its game
// state are replaced. Retain only the previous directory for rendering; these
// definitions never enter simulation, validation or catalog enumeration.
let previousItems = new Map<string, ItemDefinition>();
let previousBuildings = new Map<string, BuildingDefinition>();
let previousRecipes = new Map(Object.entries(RECIPES));
export function retainPreviousContentPresentation(): void {
  previousItems = new Map(Object.entries(ITEMS));
  previousBuildings = new Map(Object.entries(BUILDINGS));
  previousRecipes = new Map(Object.entries(RECIPES));
}
export function getItemPresentation(id: ItemId): ItemDefinition {
  return ITEMS[id] ?? previousItems.get(id) ?? { id, name: String(id), symbol: "?", color: "#607a73", kind: "solid", description: "未找到此物品定义" };
}
export function getBuildingPresentation(id: BuildingId): BuildingDefinition {
  return BUILDINGS[id] ?? previousBuildings.get(id) ?? { id, name: String(id), shortName: "?", kind: "machine", speed: 1, inputCapacity: 0, outputCapacity: 0, accepts: "any", description: "未找到此建筑定义" };
}
export function getRecipePresentation(id: RecipeId | undefined) { return id ? RECIPES[id] ?? previousRecipes.get(id) : undefined; }
export const ITEM_PRESENTATIONS = new Proxy(ITEMS, {
  get(target, key, receiver) {
    return typeof key === "string" && !Reflect.has(target, key) ? getItemPresentation(key as ItemId) : Reflect.get(target, key, receiver);
  },
  set() { throw new TypeError("物品展示目录只读"); },
});
