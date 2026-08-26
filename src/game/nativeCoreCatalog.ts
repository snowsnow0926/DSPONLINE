import {
  BUILDINGS,
  ITEMS,
  RECIPES,
  getBeltSpeed,
  getBeltTiers,
} from "./content";
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
    items: byId(Object.values(ITEMS).map((item) => ({
      id: item.id,
      kind: item.kind,
    }))),
    buildings: byId(Object.values(BUILDINGS).map((building) => ({
      id: building.id,
      kind: building.kind,
      speed: building.speed,
      inputCapacity: building.inputCapacity,
      outputCapacity: building.outputCapacity,
      powerDemandKw: building.powerDemandKw ?? 0,
      powerGenerationKw: building.powerGenerationKw ?? 0,
      ...(building.family ? { family: building.family } : {}),
    }))),
    recipes: byId(Object.values(RECIPES).map((recipe) => ({
      id: recipe.id,
      buildingId: recipe.buildingId,
      duration: recipe.duration,
      ...(recipe.requiredTechId ? { requiredTechId: recipe.requiredTechId } : {}),
      inputs: recipe.inputs.map((input) => ({ ...input })),
      outputs: recipe.outputs.map((output) => ({ ...output })),
    }))),
    belts: getBeltTiers().map((tier) => ({ tier, speed: getBeltSpeed(tier) })),
  };
}

