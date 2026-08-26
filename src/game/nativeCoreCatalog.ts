import {
  BUILDINGS,
  CONSTRUCTION,
  FUEL_ENERGY_MJ,
  ITEMS,
  PLANET_LIST,
  PROLIFERATORS,
  RECIPES,
  TECHNOLOGIES,
  getBeltSpeed,
  getBeltTiers,
  getFuelEfficiency,
  getFuelItemIdsForBuilding,
} from "./content";
import { isRecursiveManufacturingRecipe } from "./engine";
import type { ContentPackRuntimeSnapshot } from "./contentPacks";
import type { DesktopNativeCoreCatalog } from "../desktop";

/**
 * Freeze the exact active JS catalog into the bounded schema understood by
 * Rust. Core definitions and enabled content-pack definitions are both read
 * after applyContentPackRuntimeSnapshot(), so one fingerprint never silently
 * receives a different recipe/building directory.
 */
export function createNativeCoreCatalog(
  runtime: ContentPackRuntimeSnapshot,
): DesktopNativeCoreCatalog {
  const byId = <T extends { id: string }>(values: T[]) => values.sort((left, right) => left.id.localeCompare(right.id));
  return {
    protocolVersion: 1,
    registryFingerprint: runtime.fingerprint,
    planets: byId(PLANET_LIST.map((planet, simulationOrder) => ({
      id: planet.id,
      name: planet.name,
      systemId: planet.systemId,
      kind: planet.kind,
      orbitIndex: planet.orbitIndex,
      simulationOrder,
      orbitalYields: { ...planet.orbitalYields },
    }))),
    items: byId(Object.values(ITEMS).map((item) => ({
      id: item.id,
      name: item.name,
      kind: item.kind,
      fuelEnergyMj: FUEL_ENERGY_MJ[item.id] ?? 0,
    }))),
    buildings: byId(Object.values(BUILDINGS).map((building) => ({
      id: building.id,
      kind: building.kind,
      speed: building.speed,
      inputCapacity: building.inputCapacity,
      outputCapacity: building.outputCapacity,
      powerDemandKw: building.powerDemandKw ?? 0,
      powerGenerationKw: building.powerGenerationKw ?? 0,
      powerChargeKw: building.powerChargeKw ?? 0,
      energyCapacityMj: building.energyCapacityMj ?? 0,
      fuelItemIds: getFuelItemIdsForBuilding(building.id),
      fuelEfficiency: getFuelEfficiency(building.id),
      ...(building.family ? { family: building.family } : {}),
      ...(building.accepts ? { accepts: building.accepts } : {}),
    }))),
    recipes: byId(Object.values(RECIPES).map((recipe) => ({
      id: recipe.id,
      name: recipe.name,
      buildingId: recipe.buildingId,
      duration: recipe.duration,
      ...(recipe.requiredTechId ? { requiredTechId: recipe.requiredTechId } : {}),
      recursivePriority: recipe.recursivePriority ?? 0,
      recursiveManufacturing: isRecursiveManufacturingRecipe(recipe.id),
      inputs: recipe.inputs.map((input) => ({ ...input })),
      outputs: recipe.outputs.map((output) => ({ ...output })),
    }))),
    constructions: byId(CONSTRUCTION.map((definition, automationOrder) => ({
      id: definition.buildingId,
      outputAmount: definition.outputAmount,
      automationOrder,
      ...(definition.requiredTechId ? { requiredTechId: definition.requiredTechId } : {}),
      costs: definition.costs.map((cost) => ({ ...cost })),
    }))),
    belts: getBeltTiers().map((tier) => ({ tier, speed: getBeltSpeed(tier) })),
    proliferators: Object.values(PROLIFERATORS).map((definition) => ({ ...definition })),
    technologies: byId(Object.values(TECHNOLOGIES).map((technology) => ({
      id: technology.id,
      name: technology.name,
      costs: technology.costs.map((cost) => ({ ...cost })),
      prerequisites: [...technology.prerequisites],
      constructionRewards: CONSTRUCTION
        .filter((definition) => definition.requiredTechId === technology.id)
        .filter((definition) => !(definition.buildingId in BUILDINGS) ||
          !BUILDINGS[definition.buildingId as keyof typeof BUILDINGS].megastructure)
        .map((definition) => definition.buildingId),
    }))),
  };
}
