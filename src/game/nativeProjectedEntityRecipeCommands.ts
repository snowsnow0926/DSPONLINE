import { RECIPES, getRecipesForBuilding } from "./content";
import {
  SIMULATION_RUNTIME_PROTOCOL_VERSION,
  type SimulationCommandPatch,
} from "./simulationRuntimeProtocol";
import type { BuildingId, FactoryEntity, PlanetId, RecipeId } from "./types";

const BUILTIN_REGISTRY_FINGERPRINT = "7df8cf3a";
const LOGICAL_ID_PATTERN = /^[A-Za-z0-9_.:-]+$/;
const MAX_LOGICAL_ID_BYTES = 256;
const MAX_OPAQUE_ID_BYTES = 512;
const TEXT_ENCODER = new TextEncoder();

const BUILTIN_ORDINARY_RECIPE_BUILDINGS = Object.freeze([
  "arc_smelter",
  "assembling_machine_mk1",
  "assembling_machine_mk2",
  "assembling_machine_mk3",
  "chemical_plant",
  "em_rail_ejector",
  "fractionator",
  "matrix_lab",
  "miniature_particle_collider",
  "oil_refinery",
  "plane_smelter",
  "quantum_chemical_plant",
  "vertical_launching_silo",
] satisfies BuildingId[]);

export interface NativeProjectedEntityRecipeBinding {
  readonly sessionId: string;
  readonly runId: string;
  readonly revision: number;
  readonly registryFingerprint: string;
  readonly activePlanetId: PlanetId;
  readonly entity: FactoryEntity;
}

export interface NativeProjectedEntityRecipeOption {
  readonly recipeId: RecipeId;
  readonly name: string;
}

export interface NativeProjectedEntityRecipeConfiguration {
  readonly currentRecipeId: RecipeId | null;
  readonly options: readonly NativeProjectedEntityRecipeOption[];
}

function validLogicalId(value: unknown): value is string {
  return typeof value === "string" && LOGICAL_ID_PATTERN.test(value) &&
    TEXT_ENCODER.encode(value).byteLength <= MAX_LOGICAL_ID_BYTES;
}

function validOpaqueId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 &&
    TEXT_ENCODER.encode(value).byteLength <= MAX_OPAQUE_ID_BYTES &&
    !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
}

export function isNativeProjectedOrdinaryRecipeBuilding(
  value: unknown,
): value is (typeof BUILTIN_ORDINARY_RECIPE_BUILDINGS)[number] {
  return typeof value === "string" &&
    BUILTIN_ORDINARY_RECIPE_BUILDINGS.some((buildingId) => buildingId === value);
}

/**
 * Returns only the static built-in recipe family for one exact pinned entity.
 * Technology eligibility is deliberately not inferred in the renderer; Rust
 * rechecks it against the authoritative completed-tech directory on commit.
 */
export function getNativeProjectedEntityRecipeConfiguration(
  binding: NativeProjectedEntityRecipeBinding | null,
): NativeProjectedEntityRecipeConfiguration | null {
  if (!binding || binding.registryFingerprint !== BUILTIN_REGISTRY_FINGERPRINT ||
      !validLogicalId(binding.sessionId) || !validLogicalId(binding.runId) ||
      !Number.isSafeInteger(binding.revision) || binding.revision < 0 ||
      !validOpaqueId(binding.activePlanetId) || !validOpaqueId(binding.entity.id) ||
      binding.entity.planetId !== binding.activePlanetId || binding.entity.kind !== "machine" ||
      binding.entity.interactionLocked ||
      !isNativeProjectedOrdinaryRecipeBuilding(binding.entity.buildingId)) return null;

  const recipes = getRecipesForBuilding(binding.entity.buildingId);
  if (recipes.length === 0 || recipes.some((recipe) => RECIPES[recipe.id] !== recipe) ||
      new Set(recipes.map((recipe) => recipe.id)).size !== recipes.length) return null;
  const currentRecipeId = binding.entity.recipeId ?? null;
  if (currentRecipeId !== null && !recipes.some((recipe) => recipe.id === currentRecipeId)) return null;
  return Object.freeze({
    currentRecipeId,
    options: Object.freeze(recipes.map((recipe) => Object.freeze({
      recipeId: recipe.id,
      name: recipe.name,
    }))),
  });
}

/** Emits one ID-only semantic marker; refunds, belts and progress remain Rust-derived. */
export function createNativeProjectedEntityRecipeCommand(
  binding: NativeProjectedEntityRecipeBinding,
  targetRecipeId: RecipeId,
): SimulationCommandPatch | null {
  const configuration = getNativeProjectedEntityRecipeConfiguration(binding);
  if (!configuration || !configuration.options.some((option) => option.recipeId === targetRecipeId)) {
    throw new TypeError("原生建筑配方投影无效或目标配方不受支持");
  }
  if (configuration.currentRecipeId === targetRecipeId) return null;
  return {
    protocolVersion: SIMULATION_RUNTIME_PROTOCOL_VERSION,
    baseRevision: binding.revision,
    topLevelChanges: [{
      path: ["entityRecipe", "intent"],
      operation: "set",
      value: { entityId: binding.entity.id, targetRecipeId },
    }],
    changedEntities: [],
    addedEntities: [],
    removedEntityIds: [],
    changedBelts: [],
    addedBelts: [],
    removedBeltIds: [],
  };
}
