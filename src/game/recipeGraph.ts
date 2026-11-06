import { PLANET_LIST, RECIPES, TECHNOLOGY_LIST, getBuilding } from "./content";
import { getContentRules } from "./contentRules";
import { PLANET_TEMPLATE_POOLS, PLANET_TEMPLATES } from "./galaxyCatalog";
import type { BuildingId, ItemId, PlanetId, RecipeDefinition, TechnologyDefinition } from "./types";

export interface ResourceSourceDefinition {
  label: string;
  planetIds: PlanetId[];
  extractorBuildingId: BuildingId;
  manual: boolean;
}

export interface RecipeRateSummary {
  cyclesPerMinute: number;
  inputPerMinute: Partial<Record<ItemId, number>>;
  outputPerMinute: Partial<Record<ItemId, number>>;
}

export function getRecipeRates(recipe: RecipeDefinition, speed = getBuilding(recipe.buildingId).speed): RecipeRateSummary {
  const cyclesPerMinute = 60 * Math.max(0, speed) / Math.max(0.001, recipe.duration);
  const scale = (entries: RecipeDefinition["inputs"]) => Object.fromEntries(entries.map((entry) => [entry.itemId, Math.round(entry.amount * cyclesPerMinute * 100) / 100])) as Partial<Record<ItemId, number>>;
  return { cyclesPerMinute, inputPerMinute: scale(recipe.inputs), outputPerMinute: scale(recipe.outputs) };
}

const SOLID_VEIN_SOURCE = (planetIds: PlanetId[]): ResourceSourceDefinition => ({
  label: "矿脉开采",
  planetIds,
  extractorBuildingId: "mining_machine",
  manual: true,
});

const POTENTIAL_VEIN_PLANETS = (itemId: ItemId): PlanetId[] => PLANET_LIST.flatMap((planet) =>
  PLANET_TEMPLATE_POOLS[planet.id].some((templateId) => {
    const template = PLANET_TEMPLATES[templateId];
    return template.resourceIds.includes(itemId) || template.rareResourcePool.includes(itemId);
  }) ? [planet.id] : []);

const POTENTIAL_ORBIT_PLANETS = (itemId: ItemId): PlanetId[] => PLANET_LIST.flatMap((planet) =>
  PLANET_TEMPLATE_POOLS[planet.id].some((templateId) => (PLANET_TEMPLATES[templateId].orbitalYields[itemId] ?? 0) > 0)
    ? [planet.id]
    : []);

export const RESOURCE_SOURCES: Partial<Record<ItemId, ResourceSourceDefinition[]>> = {
  iron_ore: [SOLID_VEIN_SOURCE(POTENTIAL_VEIN_PLANETS("iron_ore"))],
  copper_ore: [SOLID_VEIN_SOURCE(POTENTIAL_VEIN_PLANETS("copper_ore"))],
  coal: [SOLID_VEIN_SOURCE(POTENTIAL_VEIN_PLANETS("coal"))],
  stone: [SOLID_VEIN_SOURCE(POTENTIAL_VEIN_PLANETS("stone"))],
  silicon_ore: [SOLID_VEIN_SOURCE(POTENTIAL_VEIN_PLANETS("silicon_ore"))],
  titanium_ore: [SOLID_VEIN_SOURCE(POTENTIAL_VEIN_PLANETS("titanium_ore"))],
  kimberlite_ore: [SOLID_VEIN_SOURCE(POTENTIAL_VEIN_PLANETS("kimberlite_ore"))],
  fractal_silicon: [SOLID_VEIN_SOURCE(POTENTIAL_VEIN_PLANETS("fractal_silicon"))],
  optical_grating_crystal: [SOLID_VEIN_SOURCE(POTENTIAL_VEIN_PLANETS("optical_grating_crystal"))],
  spiniform_stalagmite_crystal: [SOLID_VEIN_SOURCE(POTENTIAL_VEIN_PLANETS("spiniform_stalagmite_crystal"))],
  unipolar_magnet: [SOLID_VEIN_SOURCE(POTENTIAL_VEIN_PLANETS("unipolar_magnet"))],
  organic_crystal: [SOLID_VEIN_SOURCE(POTENTIAL_VEIN_PLANETS("organic_crystal"))],
  crude_oil: [{
    label: "原油涌泉萃取",
    planetIds: POTENTIAL_VEIN_PLANETS("crude_oil"),
    extractorBuildingId: "oil_extractor",
    manual: false,
  }],
  water: [{
    label: "海洋抽取",
    planetIds: POTENTIAL_VEIN_PLANETS("water"),
    extractorBuildingId: "water_pump",
    manual: false,
  }],
  sulfuric_acid: [{
    label: "硫酸海洋抽取",
    planetIds: POTENTIAL_VEIN_PLANETS("sulfuric_acid"),
    extractorBuildingId: "water_pump",
    manual: false,
  }],
  hydrogen: [{
    label: "气态巨星轨道采集",
    planetIds: POTENTIAL_ORBIT_PLANETS("hydrogen"),
    extractorBuildingId: "orbital_collector",
    manual: false,
  }],
  deuterium: [{
    label: "气态巨星轨道采集",
    planetIds: POTENTIAL_ORBIT_PLANETS("deuterium"),
    extractorBuildingId: "orbital_collector",
    manual: false,
  }],
  fire_ice: [
    {
      label: "气态巨星轨道采集",
      planetIds: POTENTIAL_ORBIT_PLANETS("fire_ice"),
      extractorBuildingId: "orbital_collector",
      manual: false,
    },
    SOLID_VEIN_SOURCE(POTENTIAL_VEIN_PLANETS("fire_ice")),
  ],
};

export function getProducingRecipes(itemId: ItemId): RecipeDefinition[] {
  return Object.values(RECIPES).filter((recipe) => recipe.outputs.some((output) => output.itemId === itemId));
}

export function getConsumingRecipes(itemId: ItemId): RecipeDefinition[] {
  return Object.values(RECIPES).filter((recipe) => recipe.inputs.some((input) => input.itemId === itemId));
}

export function getResearchUses(itemId: ItemId): TechnologyDefinition[] {
  return TECHNOLOGY_LIST.filter((technology) => technology.costs.some((cost) => cost.itemId === itemId));
}

export function getResourceSource(itemId: ItemId): ResourceSourceDefinition | undefined {
  return RESOURCE_SOURCES[itemId]?.[0];
}

export function getResourceSources(itemId: ItemId): ResourceSourceDefinition[] {
  const rule = getContentRules().resources?.find((entry) => entry.itemId === itemId);
  return rule ? [{ label: "内容包资源采集", planetIds: rule.planetIds as PlanetId[], extractorBuildingId: rule.extractorBuildingId as BuildingId, manual: true }] : RESOURCE_SOURCES[itemId] ?? [];
}

export function getVirtualRecipeResult(recipe: RecipeDefinition): string | null {
  if (recipe.id === "solar_sail_launch") return "戴森云轨道太阳帆";
  if (recipe.id === "carrier_rocket_launch") return "戴森球永久结构点";
  if (recipe.id === "ray_power") return "行星电网电力";
  if (recipe.id === "matrix_research") return "科技研究进度";
  return null;
}
