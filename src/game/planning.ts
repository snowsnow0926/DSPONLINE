import { getTechnologyMultiplier, isRecipeTechnologyAvailable } from "./contentRules";
import { ITEMS, PLANET_LIST, RECIPES, getBuilding, getExtractorBuildingId, getRecipe } from "./content";
import { getMiningSpeedMultiplier } from "./engine";
import { calculateFactoryStatistics } from "./statistics";
import type { BuildingId, GameState, ItemId, PlanetId, ProductionTargetPlan, RecipeDefinition, RecipeId } from "./types";

export interface ProductionPlanRequirement {
  itemId: ItemId;
  depth: number;
  requiredPerMinute: number;
  existingPerMinute: number;
  deficitPerMinute: number;
  inventory: number;
  coverageMinutes: number | null;
  source: "resource" | "recipe";
  recipeId?: RecipeId;
  buildingId: BuildingId;
  machinesRequired: number;
  additionalMachines: number;
  powerDemandKw: number;
  logisticsPerMinute: number;
}

export interface ProductionPlanResult {
  plan: ProductionTargetPlan;
  requirements: ProductionPlanRequirement[];
  totalMachines: number;
  additionalMachines: number;
  totalPowerDemandKw: number;
  totalLogisticsPerMinute: number;
  limitingItemId: ItemId | null;
}

const EXCLUDED_PLAN_RECIPES = new Set<RecipeId>([
  "matrix_research",
  "solar_sail_launch",
  "carrier_rocket_launch",
  "ray_power",
]);

function unlockedRecipe(state: GameState, recipe: RecipeDefinition): boolean {
  return isRecipeTechnologyAvailable(recipe, state.research.completedTechIds);
}

function netRecipeOutput(recipe: RecipeDefinition, itemId: ItemId): number {
  const produced = recipe.outputs.reduce((sum, output) => sum + (output.itemId === itemId ? output.amount : 0), 0);
  const consumed = recipe.inputs.reduce((sum, input) => sum + (input.itemId === itemId ? input.amount : 0), 0);
  return produced - consumed;
}

export function getProductionRecipeOptions(state: GameState, itemId: ItemId): RecipeDefinition[] {
  return Object.values(RECIPES).filter((recipe) => !EXCLUDED_PLAN_RECIPES.has(recipe.id) &&
    netRecipeOutput(recipe, itemId) > 0 && unlockedRecipe(state, recipe));
}

function isDirectResource(state: GameState, itemId: ItemId): boolean {
  return state.entities.some((entity) => entity.kind === "vein" && entity.resourceId === itemId) ||
    PLANET_LIST.some((planet) => (planet.orbitalYields?.[itemId] ?? 0) > 0);
}

function scopedStatistics(state: GameState, planetId: PlanetId | "all") {
  if (planetId === "all") return calculateFactoryStatistics(state);
  const scoped = {
    ...state,
    activePlanetId: planetId,
    entities: state.entities.filter((entity) => entity.planetId === planetId),
    belts: state.belts.filter((belt) => belt.planetId === planetId),
    tray: { ...state.planetTrays[planetId] },
  };
  return calculateFactoryStatistics(scoped);
}

interface AccumulatedRequirement {
  itemId: ItemId;
  depth: number;
  requiredPerMinute: number;
  recipe?: RecipeDefinition;
  source: "resource" | "recipe";
}

function selectedRecipe(state: GameState, plan: ProductionTargetPlan, itemId: ItemId): RecipeDefinition | undefined {
  const selected = getRecipe(plan.recipeSelections[itemId]);
  if (selected && netRecipeOutput(selected, itemId) > 0 && unlockedRecipe(state, selected)) return selected;
  if (isDirectResource(state, itemId)) return undefined;
  return getProductionRecipeOptions(state, itemId)[0];
}

export function calculateProductionPlan(state: GameState, plan: ProductionTargetPlan): ProductionPlanResult {
  const accumulated = new Map<ItemId, AccumulatedRequirement>();
  const walk = (itemId: ItemId, requiredPerMinute: number, depth: number, path: Set<ItemId>) => {
    if (requiredPerMinute <= 0.0001 || depth > 18) return;
    const cycle = path.has(itemId);
    const recipe = cycle ? undefined : selectedRecipe(state, plan, itemId);
    const source: AccumulatedRequirement["source"] = recipe ? "recipe" : "resource";
    const current = accumulated.get(itemId);
    accumulated.set(itemId, {
      itemId,
      depth: Math.min(current?.depth ?? depth, depth),
      requiredPerMinute: (current?.requiredPerMinute ?? 0) + requiredPerMinute,
      recipe: current?.recipe ?? recipe,
      source: current?.source === "recipe" || source === "recipe" ? "recipe" : "resource",
    });
    if (!recipe || cycle) return;
    const outputAmount = Math.max(0.0001, netRecipeOutput(recipe, itemId));
    const cyclesPerMinute = requiredPerMinute / outputAmount;
    const nextPath = new Set(path).add(itemId);
    for (const input of recipe.inputs) {
      if (input.itemId === itemId) continue;
      walk(input.itemId, cyclesPerMinute * input.amount, depth + 1, nextPath);
    }
  };
  walk(plan.itemId, Math.max(0.01, plan.targetPerMinute), 0, new Set());

  const statistics = scopedStatistics(state, plan.planetId);
  const statisticsByItem = new Map(statistics.items.map((item) => [item.itemId, item]));
  const requirements: ProductionPlanRequirement[] = [...accumulated.values()].map((entry) => {
    const itemStats = statisticsByItem.get(entry.itemId);
    const existingPerMinute = itemStats?.productionPerMinute ?? 0;
    const inventory = itemStats?.inventory ?? 0;
    const deficitPerMinute = Math.max(0, entry.requiredPerMinute - existingPerMinute);
    const recipe = entry.recipe;
    const buildingId = recipe?.buildingId ?? getExtractorBuildingId(entry.itemId);
    const building = getBuilding(buildingId);
    const outputAmount = recipe ? Math.max(0.0001, netRecipeOutput(recipe, entry.itemId)) : 1;
    const perMachinePerMinute = recipe
      ? building.speed * 60 / recipe.duration * outputAmount * getTechnologyMultiplier(state.research.completedTechIds, "productionSpeed")
      : building.speed * (ITEMS[entry.itemId].kind === "solid" ? getMiningSpeedMultiplier(state) : getTechnologyMultiplier(state.research.completedTechIds, "miningSpeed")) * 60;
    const machinesRequired = entry.requiredPerMinute / Math.max(0.0001, perMachinePerMinute);
    const additionalMachines = Math.ceil(deficitPerMinute / Math.max(0.0001, perMachinePerMinute));
    const logisticsPerMinute = recipe
      ? recipe.inputs.reduce((sum, input) => sum + entry.requiredPerMinute / outputAmount * input.amount, 0)
      : entry.requiredPerMinute;
    return {
      itemId: entry.itemId,
      depth: entry.depth,
      requiredPerMinute: entry.requiredPerMinute,
      existingPerMinute,
      deficitPerMinute,
      inventory,
      coverageMinutes: deficitPerMinute > 0.0001 ? inventory / deficitPerMinute : null,
      source: entry.source,
      recipeId: recipe?.id,
      buildingId,
      machinesRequired,
      additionalMachines,
      powerDemandKw: additionalMachines * (building.powerDemandKw ?? 0) * getTechnologyMultiplier(state.research.completedTechIds, "powerConsumption"),
      logisticsPerMinute,
    };
  }).sort((a, b) => a.depth - b.depth || b.deficitPerMinute - a.deficitPerMinute);
  const limiting = [...requirements].sort((a, b) => {
    const aCoverage = a.coverageMinutes ?? Number.POSITIVE_INFINITY;
    const bCoverage = b.coverageMinutes ?? Number.POSITIVE_INFINITY;
    return aCoverage - bCoverage || b.deficitPerMinute - a.deficitPerMinute;
  })[0];
  return {
    plan,
    requirements,
    totalMachines: requirements.reduce((sum, requirement) => sum + Math.ceil(requirement.machinesRequired), 0),
    additionalMachines: requirements.reduce((sum, requirement) => sum + requirement.additionalMachines, 0),
    totalPowerDemandKw: requirements.reduce((sum, requirement) => sum + requirement.powerDemandKw, 0),
    totalLogisticsPerMinute: requirements.reduce((sum, requirement) => sum + requirement.logisticsPerMinute, 0),
    limitingItemId: limiting?.itemId ?? null,
  };
}

export function createProductionPlan(
  state: GameState,
  itemId: ItemId,
  targetPerMinute = 60,
  planetId: PlanetId | "all" = "all",
): GameState {
  const plan: ProductionTargetPlan = {
    id: `plan_${state.nextId}`,
    name: `${ITEMS[itemId].name} ${Math.max(1, Math.round(targetPerMinute))}/min`,
    itemId,
    targetPerMinute: Math.max(0.01, targetPerMinute),
    planetId,
    recipeSelections: {},
    createdAt: state.elapsedSeconds,
  };
  return { ...state, nextId: state.nextId + 1, productionPlans: [...state.productionPlans, plan] };
}

export function updateProductionPlan(
  state: GameState,
  planId: string,
  changes: Partial<Pick<ProductionTargetPlan, "name" | "itemId" | "targetPerMinute" | "planetId">>,
): GameState {
  if (!state.productionPlans.some((plan) => plan.id === planId)) return state;
  return {
    ...state,
    productionPlans: state.productionPlans.map((plan) => plan.id === planId ? {
      ...plan,
      ...changes,
      name: changes.name?.trim().slice(0, 40) || plan.name,
      targetPerMinute: changes.targetPerMinute === undefined ? plan.targetPerMinute : Math.max(0.01, changes.targetPerMinute),
      recipeSelections: changes.itemId && changes.itemId !== plan.itemId ? {} : plan.recipeSelections,
    } : plan),
  };
}

export function setProductionPlanRecipe(state: GameState, planId: string, itemId: ItemId, recipeId: RecipeId): GameState {
  const plan = state.productionPlans.find((candidate) => candidate.id === planId);
  const recipe = getRecipe(recipeId);
  if (!plan || !recipe || netRecipeOutput(recipe, itemId) <= 0 || !unlockedRecipe(state, recipe)) return state;
  return {
    ...state,
    productionPlans: state.productionPlans.map((candidate) => candidate.id === planId ? {
      ...candidate,
      recipeSelections: { ...candidate.recipeSelections, [itemId]: recipeId },
    } : candidate),
  };
}

export function removeProductionPlan(state: GameState, planId: string): GameState {
  if (!state.productionPlans.some((plan) => plan.id === planId)) return state;
  return { ...state, productionPlans: state.productionPlans.filter((plan) => plan.id !== planId) };
}
