import type { ItemAmount, ItemId, RecipeDefinition, RecipeId, TechId } from "./types";

export type RecursiveCraftBlockerReason = "raw-shortage" | "technology" | "no-recipe" | "cycle";

export interface RecursiveCraftBlocker {
  itemId: ItemId;
  current: number;
  required: number;
  reason: RecursiveCraftBlockerReason;
  recipeId?: RecipeId;
  technologyId?: TechId;
}

export interface RecursiveCraftFallback {
  recipeId: RecipeId;
  blocker?: RecursiveCraftBlocker;
  reason: "technology" | "materials" | "conflict";
}

export interface RecursiveCraftDecision {
  itemId: ItemId;
  recipeId: RecipeId;
  fallbacks: RecursiveCraftFallback[];
}

export interface RecursiveCraftStep {
  recipeId: RecipeId;
  batches: number;
  outputItemId: ItemId;
  outputAmount: number;
}

export interface RecursiveCraftPlan {
  possible: boolean;
  inventory: Partial<Record<ItemId, number>>;
  steps: RecursiveCraftStep[];
  decisions: RecursiveCraftDecision[];
  blocker?: RecursiveCraftBlocker;
}

interface PlannerWork {
  inventory: Partial<Record<ItemId, number>>;
  steps: RecursiveCraftStep[];
  decisions: RecursiveCraftDecision[];
}

interface PlannerContext {
  recipesByOutput: ReadonlyMap<ItemId, readonly RecipeDefinition[]>;
  completedTechnologyIds: ReadonlySet<TechId>;
  optionLimit: number;
}

interface OptionResult {
  options: PlannerWork[];
  blockers: Array<RecursiveCraftBlocker & { depth: number }>;
}

const cloneWork = (work: PlannerWork): PlannerWork => ({
  inventory: { ...work.inventory },
  steps: work.steps.map((step) => ({ ...step })),
  decisions: work.decisions.map((decision) => ({
    ...decision,
    fallbacks: decision.fallbacks.map((fallback) => ({
      ...fallback,
      blocker: fallback.blocker ? { ...fallback.blocker } : undefined,
    })),
  })),
});

function normalizedInventory(source: Partial<Record<ItemId, number>>): Partial<Record<ItemId, number>> {
  return Object.fromEntries(Object.entries(source).map(([itemId, amount]) => [
    itemId,
    Math.max(0, Math.floor(Number.isFinite(amount) ? amount ?? 0 : 0)),
  ])) as Partial<Record<ItemId, number>>;
}

/**
 * Return the amount one batch actually adds to the requested item. Recipes
 * may consume and output the same item, so gross output is not sufficient for
 * recursive planning.
 */
export function getRecipeNetOutput(recipe: RecipeDefinition, itemId: ItemId): number {
  const output = recipe.outputs.reduce((sum, entry) =>
    entry.itemId === itemId ? sum + Math.max(0, entry.amount) : sum, 0);
  const input = recipe.inputs.reduce((sum, entry) =>
    entry.itemId === itemId ? sum + Math.max(0, entry.amount) : sum, 0);
  const net = output - input;
  return Number.isFinite(net) ? net : 0;
}

function producingRecipes(context: PlannerContext, itemId: ItemId): readonly RecipeDefinition[] {
  return context.recipesByOutput.get(itemId) ?? [];
}

function preferredBlocker(blockers: Array<RecursiveCraftBlocker & { depth: number }>): RecursiveCraftBlocker | undefined {
  const rank = (blocker: RecursiveCraftBlocker) => blocker.reason === "raw-shortage" ? 4
    : blocker.reason === "technology" ? 3
      : blocker.reason === "no-recipe" ? 2 : 1;
  const selected = [...blockers].sort((left, right) =>
    right.depth - left.depth || rank(right) - rank(left) ||
    right.required - right.current - (left.required - left.current) ||
    left.itemId.localeCompare(right.itemId))[0];
  if (!selected) return undefined;
  const { depth: _depth, ...blocker } = selected;
  return blocker;
}

function ensureItemOptions(
  context: PlannerContext,
  work: PlannerWork,
  itemId: ItemId,
  requiredAmount: number,
  resolving: ReadonlySet<ItemId>,
  depth: number,
): OptionResult {
  const required = Math.max(0, Math.floor(requiredAmount));
  const current = Math.max(0, Math.floor(work.inventory[itemId] ?? 0));
  if (current >= required) return { options: [work], blockers: [] };
  if (resolving.has(itemId)) {
    return { options: [], blockers: [{ itemId, current, required, reason: "cycle", depth }] };
  }

  const recipes = producingRecipes(context, itemId);
  if (recipes.length === 0) {
    return {
      options: [],
      blockers: [{ itemId, current, required, reason: "raw-shortage", depth }],
    };
  }

  const nextResolving = new Set(resolving);
  nextResolving.add(itemId);
  const options: PlannerWork[] = [];
  const blockers: Array<RecursiveCraftBlocker & { depth: number }> = [];
  const earlierAttempts: Array<{ recipeId: RecipeId; viable: boolean; blocker?: RecursiveCraftBlocker }> = [];

  for (const recipe of recipes) {
    if (recipe.requiredTechId && !context.completedTechnologyIds.has(recipe.requiredTechId)) {
      const blocker = { itemId, current, required, reason: "technology" as const, recipeId: recipe.id, technologyId: recipe.requiredTechId };
      blockers.push({ ...blocker, depth });
      earlierAttempts.push({ recipeId: recipe.id, viable: false, blocker });
      continue;
    }

    const primary = recipe.outputs.find((output) => output.itemId === itemId && output.amount > 0)!;
    const netOutput = getRecipeNetOutput(recipe, itemId);
    const batches = Math.max(1, Math.ceil((required - current) / netOutput));
    let candidates: PlannerWork[] = [cloneWork(work)];
    const recipeBlockers: Array<RecursiveCraftBlocker & { depth: number }> = [];
    for (const input of recipe.inputs) {
      const requiredInput = input.amount * batches;
      const supplied: PlannerWork[] = [];
      for (const candidate of candidates) {
        const result = ensureItemOptions(context, candidate, input.itemId, requiredInput, nextResolving, depth + 1);
        recipeBlockers.push(...result.blockers);
        for (const option of result.options) {
          const next = cloneWork(option);
          next.inventory[input.itemId] = Math.max(0, Math.floor((next.inventory[input.itemId] ?? 0) - requiredInput));
          supplied.push(next);
          if (supplied.length >= context.optionLimit) break;
        }
        if (supplied.length >= context.optionLimit) break;
      }
      candidates = supplied;
      if (candidates.length === 0) break;
    }

    blockers.push(...recipeBlockers);
    if (candidates.length === 0) {
      earlierAttempts.push({ recipeId: recipe.id, viable: false, blocker: preferredBlocker(recipeBlockers) });
      continue;
    }

    for (const candidate of candidates) {
      for (const output of recipe.outputs) {
        candidate.inventory[output.itemId] = Math.floor((candidate.inventory[output.itemId] ?? 0) + output.amount * batches);
      }
      candidate.steps.push({
        recipeId: recipe.id,
        batches,
        outputItemId: itemId,
        outputAmount: primary.amount * batches,
      });
      candidate.decisions.push({
        itemId,
        recipeId: recipe.id,
        fallbacks: earlierAttempts.map((attempt) => ({
          recipeId: attempt.recipeId,
          blocker: attempt.blocker,
          reason: attempt.viable ? "conflict" : attempt.blocker?.reason === "technology" ? "technology" : "materials",
        })),
      });
      options.push(candidate);
      if (options.length >= context.optionLimit) break;
    }
    earlierAttempts.push({ recipeId: recipe.id, viable: true });
    if (options.length >= context.optionLimit) break;
  }

  return { options, blockers };
}

function planRequirementsFromWork(
  context: PlannerContext,
  works: PlannerWork[],
  requirements: ItemAmount[],
): { works: PlannerWork[]; blockers: Array<RecursiveCraftBlocker & { depth: number }> } {
  let candidates = works;
  const blockers: Array<RecursiveCraftBlocker & { depth: number }> = [];
  for (const requirement of requirements) {
    const paid: PlannerWork[] = [];
    for (const candidate of candidates) {
      const result = ensureItemOptions(context, candidate, requirement.itemId, requirement.amount, new Set(), 0);
      blockers.push(...result.blockers);
      for (const option of result.options) {
        const next = cloneWork(option);
        next.inventory[requirement.itemId] = Math.max(0, Math.floor((next.inventory[requirement.itemId] ?? 0) - requirement.amount));
        paid.push(next);
        if (paid.length >= context.optionLimit) break;
      }
      if (paid.length >= context.optionLimit) break;
    }
    candidates = paid;
    if (candidates.length === 0) break;
  }
  return { works: candidates, blockers };
}

function plannerContext({ recipes, completedTechnologyIds, allowRecipe, optionLimit }: {
  recipes: RecipeDefinition[];
  completedTechnologyIds: readonly TechId[];
  allowRecipe?: (recipe: RecipeDefinition) => boolean;
  optionLimit?: number;
}): PlannerContext {
  // A planning invocation owns its index: content-pack and recipe changes on
  // the next invocation are observed without retaining a global stale cache.
  const recipesByOutput = new Map<ItemId, RecipeDefinition[]>();
  for (const recipe of recipes) {
    if (allowRecipe && !allowRecipe(recipe)) continue;
    for (const itemId of new Set(recipe.outputs.map((output) => output.itemId))) {
      if (getRecipeNetOutput(recipe, itemId) <= 0) continue;
      const producing = recipesByOutput.get(itemId);
      if (producing) producing.push(recipe);
      else recipesByOutput.set(itemId, [recipe]);
    }
  }
  for (const producing of recipesByOutput.values()) {
    producing.sort((left, right) =>
      (right.recursivePriority ?? 0) - (left.recursivePriority ?? 0) ||
      left.id.localeCompare(right.id));
  }
  return {
    recipesByOutput,
    completedTechnologyIds: new Set(completedTechnologyIds),
    optionLimit: Math.max(1, Math.min(64, Math.floor(optionLimit ?? 24))),
  };
}

export function planRecursiveRequirements({ inventory, requirements, recipes, completedTechnologyIds, allowRecipe, optionLimit }: {
  inventory: Partial<Record<ItemId, number>>;
  requirements: ItemAmount[];
  recipes: RecipeDefinition[];
  completedTechnologyIds: readonly TechId[];
  allowRecipe?: (recipe: RecipeDefinition) => boolean;
  optionLimit?: number;
}): RecursiveCraftPlan {
  const initial: PlannerWork = { inventory: normalizedInventory(inventory), steps: [], decisions: [] };
  const result = planRequirementsFromWork(
    plannerContext({ recipes, completedTechnologyIds, allowRecipe, optionLimit }),
    [initial],
    requirements.map((requirement) => ({ ...requirement, amount: Math.max(0, Math.floor(requirement.amount)) })),
  );
  const selected = result.works[0];
  return selected
    ? { possible: true, inventory: selected.inventory, steps: selected.steps, decisions: selected.decisions }
    : { possible: false, inventory: initial.inventory, steps: [], decisions: [], blocker: preferredBlocker(result.blockers) };
}

export function planSelectedRecipe({ inventory, recipe, batches, recipes, completedTechnologyIds, allowRecipe, optionLimit }: {
  inventory: Partial<Record<ItemId, number>>;
  recipe: RecipeDefinition;
  batches: number;
  recipes: RecipeDefinition[];
  completedTechnologyIds: readonly TechId[];
  allowRecipe?: (candidate: RecipeDefinition) => boolean;
  optionLimit?: number;
}): RecursiveCraftPlan {
  const count = Math.max(1, Math.floor(batches));
  const context = plannerContext({ recipes, completedTechnologyIds, allowRecipe, optionLimit });
  const initial: PlannerWork = { inventory: normalizedInventory(inventory), steps: [], decisions: [] };
  if (recipe.requiredTechId && !context.completedTechnologyIds.has(recipe.requiredTechId)) {
    const output = recipe.outputs[0];
    return {
      possible: false,
      inventory: initial.inventory,
      steps: [],
      decisions: [],
      blocker: {
        itemId: output?.itemId ?? recipe.inputs[0]?.itemId ?? "iron_ore",
        current: 0,
        required: output?.amount ?? 1,
        reason: "technology",
        recipeId: recipe.id,
        technologyId: recipe.requiredTechId,
      },
    };
  }
  const result = planRequirementsFromWork(context, [initial], recipe.inputs.map((input) => ({
    itemId: input.itemId,
    amount: input.amount * count,
  })));
  const selected = result.works[0];
  if (!selected) return {
    possible: false,
    inventory: initial.inventory,
    steps: [],
    decisions: [],
    blocker: preferredBlocker(result.blockers),
  };
  for (const output of recipe.outputs) {
    selected.inventory[output.itemId] = Math.floor((selected.inventory[output.itemId] ?? 0) + output.amount * count);
  }
  const primary = recipe.outputs[0];
  if (primary) {
    selected.steps.push({ recipeId: recipe.id, batches: count, outputItemId: primary.itemId, outputAmount: primary.amount * count });
    selected.decisions.push({ itemId: primary.itemId, recipeId: recipe.id, fallbacks: [] });
  }
  return { possible: true, inventory: selected.inventory, steps: selected.steps, decisions: selected.decisions };
}
