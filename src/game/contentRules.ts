import "../compat/structuredClone";
import type { FactoryEntity, GameState, ItemId, PlanetId, RecipeDefinition, TechId } from "./types";

export const EFFECT_KEYS = ["productionSpeed", "powerConsumption", "miningSpeed", "storageCapacity"] as const;
export type EffectKey = typeof EFFECT_KEYS[number];
export interface TechnologyEffect {
  technologyId: string;
  productionSpeed?: number;
  powerConsumption?: number;
  miningSpeed?: number;
  storageCapacity?: number;
}
export interface RecipeGroup { id: string; name: string; requiredTechId: string; recipeIds: string[] }
export interface RecipePolicy { buildingId: string; recipeIds: string[] }
export interface FuelRule { itemId: string; energyMj: number }
export interface GeneratorRule { buildingId: string; fuelItemIds: string[]; efficiency: number }
export interface ResourceRule { itemId: string; extractorBuildingId: string; planetIds: string[]; reserve: number }
export interface IdMigration { kind: "items" | "buildings" | "recipes" | "technologies" | "belts"; from: string; to: string }
export interface ContentCategory { id: string; name: string }
export interface ContentRules {
  technologyEffects?: TechnologyEffect[];
  recipeGroups?: RecipeGroup[];
  recipePolicies?: RecipePolicy[];
  fuels?: FuelRule[];
  generators?: GeneratorRule[];
  resources?: ResourceRule[];
  idMigrations?: IdMigration[];
  categories?: ContentCategory[];
}

let rules: ContentRules = {};
let groupTechs = new Map<string, string[]>();
let recipePolicies = new Map<string, Set<string>>();
let resourceExtractors = new Map<string, string>();
let generators = new Map<string, GeneratorRule>();
let generation = 0;
let multiplierCache = new WeakMap<readonly string[], { generation: number; values: Record<EffectKey, number> }>();
export function setContentRules(next: ContentRules): void {
  rules = structuredClone(next);
  groupTechs = new Map();
  for (const group of rules.recipeGroups ?? []) for (const recipeId of group.recipeIds) groupTechs.set(recipeId, [...(groupTechs.get(recipeId) ?? []), group.requiredTechId]);
  recipePolicies = new Map((rules.recipePolicies ?? []).map((rule) => [rule.buildingId, new Set(rule.recipeIds)]));
  resourceExtractors = new Map((rules.resources ?? []).map((rule) => [rule.itemId, rule.extractorBuildingId]));
  generators = new Map((rules.generators ?? []).map((rule) => [rule.buildingId, rule]));
  generation++;
  multiplierCache = new WeakMap();
}
export function getContentRules(): ContentRules { return structuredClone(rules); }
export function getTechnologyMultiplier(completed: readonly string[], key: EffectKey): number {
  if (!rules.technologyEffects?.length) return 1;
  // Research completion appends in place in the simulation. The length is part
  // of the cache generation so completing a technology takes effect this tick.
  const stamp = generation * 1_000_000 + completed.length;
  let cached = multiplierCache.get(completed);
  if (!cached || cached.generation !== stamp) {
    const ids = new Set(completed);
    const values = Object.fromEntries(EFFECT_KEYS.map((field) => [field, 1])) as Record<EffectKey, number>;
    for (const effect of rules.technologyEffects ?? []) if (ids.has(effect.technologyId)) {
      for (const field of EFFECT_KEYS) values[field] = Math.max(0.01, Math.min(100, values[field] * (effect[field] ?? 1)));
    }
    cached = { generation: stamp, values };
    multiplierCache.set(completed, cached);
  }
  return cached.values[key];
}
export function isRecipeTechnologyAvailable(recipe: RecipeDefinition, completed: readonly string[]): boolean {
  return !getRecipeMissingTechnology(recipe, completed);
}
export function getRecipeMissingTechnology(recipe: RecipeDefinition, completed: Iterable<string>): TechId | undefined {
  const groups = groupTechs.get(recipe.id);
  if (!recipe.requiredTechId && !groups) return undefined;
  const ids = Array.isArray(completed) || completed instanceof Set ? completed : new Set(completed);
  const has = (id: string) => Array.isArray(ids) ? ids.includes(id) : (ids as ReadonlySet<string>).has(id);
  if (recipe.requiredTechId && !has(recipe.requiredTechId)) return recipe.requiredTechId;
  return groups?.find((id) => !has(id)) as TechId | undefined;
}
export function recipePolicyAllows(buildingId: string, recipeId: string): boolean | undefined {
  return recipePolicies.get(buildingId)?.has(recipeId);
}
export function getResourceExtractor(itemId: string): string | undefined {
  return resourceExtractors.get(itemId);
}
export function getGeneratorRule(buildingId: string): GeneratorRule | undefined {
  return generators.get(buildingId);
}
export function getCategoryName(id: string | undefined): string | undefined {
  return rules.categories?.find((entry) => entry.id === id)?.name;
}

/** Add a resource once; loading/updating never refills an existing vein. */
export function addContentPackResources(state: GameState): GameState {
  const entities = [...state.entities];
  let changed = false;
  for (const resource of rules.resources ?? []) for (const planetId of resource.planetIds) {
    if (entities.some((entity) => entity.kind === "vein" && entity.planetId === planetId && entity.resourceId === resource.itemId)) continue;
    const index = entities.filter((entity) => entity.kind === "vein" && entity.planetId === planetId).length;
    const entity: FactoryEntity = {
      id: `content_vein_${planetId}_${resource.itemId}`, kind: "vein", planetId: planetId as PlanetId,
      resourceId: resource.itemId as ItemId, position: { x: -470 + (index % 4) * 320, y: -250 + Math.floor(index / 4) * 285 },
      interactionLocked: false, powerGridId: "grid-a", powerPriority: 2, machineCount: 0, minerCount: 0,
      inputs: {}, outputs: {}, progress: 0, routingCursor: 0, utilization: 0, productionRate: 0,
      resourceRemaining: resource.reserve, resourceCapacity: resource.reserve, resourceDepletionRemainder: 0,
    };
    entities.push(entity); changed = true;
  }
  const profiles = { ...state.galaxy.profiles };
  for (const resource of rules.resources ?? []) for (const planetId of resource.planetIds) {
    const profile = profiles[planetId as PlanetId];
    if (profile && !profile.resourceIds.includes(resource.itemId as ItemId)) {
      profiles[planetId as PlanetId] = { ...profile, resourceIds: [...profile.resourceIds, resource.itemId as ItemId] };
      changed = true;
    }
  }
  return changed ? { ...state, entities, galaxy: { ...state.galaxy, profiles } } : state;
}
