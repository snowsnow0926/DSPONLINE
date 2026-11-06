import { getContentRules, type IdMigration } from "./contentRules";

type Kind = IdMigration["kind"];
const scalarKinds: Record<string, Kind> = {
  itemId: "items", resourceId: "items", fuelItemId: "items", storedItemId: "items", proliferatorItemId: "items",
  currentItemId: "items", outputItemId: "items",
  buildingId: "buildings", extractorBuildingId: "buildings", targetBuildingId: "buildings", upgradeTargetId: "buildings",
  recipeId: "recipes", sourceRecipeId: "recipes", targetRecipeId: "recipes",
  selectedTechId: "technologies", pausedTechId: "technologies", requiredTechId: "technologies", technologyId: "technologies",
  constructionId: "buildings", lastCraftedId: "buildings",
};
const arrayKinds: Record<string, Kind> = {
  completedTechIds: "technologies", queuedTechIds: "technologies", prerequisites: "technologies",
  deliveryItemIds: "items", orbitalCargoPortItems: "items", resourceIds: "items", rareResourceIds: "items", itemIds: "items",
};
const mapKinds: Record<string, Kind> = {
  inputs: "items", outputs: "items", tray: "items", totalProduced: "items", inventory: "items", itemCapacities: "items",
  delivered: "items", exportedByItem: "items", uploaded: "items", downloaded: "items", needed: "items", requested: "items",
  constructionBuffer: "items", itemPolicies: "items", currentRunProduction: "items", totalProduction: "items",
  proliferatorBonusProgress: "items", productionPerMinute: "items", consumptionPerMinute: "items",
  researchInvestmentByItem: "items", destroyedByproducts: "items", completedItems: "items", orbitalYields: "items",
  routingCursors: "items", uploadRoutingCursors: "items",
  construction: "buildings", reservedConstruction: "buildings", targetStock: "buildings", jobs: "buildings",
  progressByTech: "technologies", recipeSelections: "items", recipeOverrides: "recipes",
};
const nestedItemMaps = new Set(["planetTrays", "planetProductionPerMinute", "planetConsumptionPerMinute", "quantumMaterialBuffer"]);

/** Rewrite typed content references, never entity IDs, names, timestamps or positions.
 * Inventory collisions sum integers (including decimal bigint strings). Research
 * collisions retain the furthest progress. Unknown save properties are retained. */
export function migrateContentPackIds<T>(source: T, migrations = getContentRules().idMigrations ?? []): T {
  if (!migrations.length) return source;
  const maps = Object.fromEntries(["items", "buildings", "recipes", "technologies", "belts"].map((kind) => [kind, new Map(migrations.filter((entry) => entry.kind === kind).map((entry) => [entry.from, entry.to]))])) as Record<Kind, Map<string, string>>;
  const remap = (value: string, kind: Kind) => maps[kind].get(value) ?? (kind === "buildings" ? maps.belts.get(value) : undefined) ?? value;
  const merge = (left: any, right: any, maximum = false): any => {
    if (typeof left === "number" && typeof right === "number") {
      const value = maximum ? Math.max(left, right) : left + right;
      if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) throw new Error("旧 ID 合并后的库存超过安全整数范围");
      return value;
    }
    if (typeof left === "string" && typeof right === "string" && /^\d+$/.test(left) && /^\d+$/.test(right)) return (maximum ? (BigInt(left) > BigInt(right) ? BigInt(left) : BigInt(right)) : BigInt(left) + BigInt(right)).toString();
    if (left && right && typeof left === "object" && typeof right === "object" && !Array.isArray(left) && !Array.isArray(right)) {
      const result = { ...left };
      for (const [key, value] of Object.entries(right)) result[key] = key in result ? merge(result[key], value, maximum) : value;
      return result;
    }
    if (Array.isArray(left) && Array.isArray(right)) return [...left, ...right];
    // Two policy/job records cannot be discarded silently. The author must use
    // distinct target IDs when a nonnumeric scalar would conflict.
    if (JSON.stringify(left) !== JSON.stringify(right)) throw new Error("旧 ID 合并存在冲突，请为这些内容设置不同的新 ID");
    return left;
  };
  const walk = (value: any, key = ""): any => {
    if (typeof value === "string" && scalarKinds[key]) return remap(value, scalarKinds[key]);
    if (Array.isArray(value)) {
      const result = value.map((entry) => typeof entry === "string" && arrayKinds[key] ? remap(entry, arrayKinds[key]) : walk(entry));
      return key === "completedTechIds" || key === "queuedTechIds" ? [...new Set(result)] : result;
    }
    if (!value || typeof value !== "object") return value;
    const result: Record<string, any> = {};
    const entries = Object.entries(value);
    // Match native's ordered maps when several aliases contain fractional
    // progress. Floating-point addition must not depend on JSON key order.
    if (mapKinds[key]) entries.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    for (const [id, entry] of entries) {
      const nextId = mapKinds[key] ? remap(id, mapKinds[key]) : id;
      const next = nestedItemMaps.has(key) || key === "progressByTech"
        ? walk(entry, "inventory")
        : key === "recipeSelections" || key === "recipeOverrides"
          ? typeof entry === "string" ? remap(entry, "recipes") : walk(entry, id)
          : walk(entry, id);
      result[nextId] = nextId in result ? merge(result[nextId], next, key === "progressByTech") : next;
    }
    return result;
  };
  return walk(source) as T;
}

/** Conservative removal guard for typed references outside the main inventory. */
export function hasContentIdReference(source: unknown, ids: ReadonlySet<string>): boolean {
  if (ids.size === 0) return false;
  const visit = (value: unknown, key = ""): boolean => {
    if (typeof value === "string") return Boolean(scalarKinds[key] && ids.has(value));
    if (Array.isArray(value)) return value.some((entry) => typeof entry === "string" && arrayKinds[key] ? ids.has(entry) : visit(entry));
    if (!value || typeof value !== "object") return false;
    for (const [id, entry] of Object.entries(value)) {
      if (mapKinds[key] && ids.has(id) && (typeof entry === "number" ? entry > 0 : typeof entry === "string" ? entry !== "0" : Boolean(entry))) return true;
      if ((key === "recipeSelections" || key === "recipeOverrides") && typeof entry === "string" && ids.has(entry)) return true;
      if (visit(entry, nestedItemMaps.has(key) || key === "progressByTech" ? "inventory" : id)) return true;
    }
    return false;
  };
  return visit(source);
}
