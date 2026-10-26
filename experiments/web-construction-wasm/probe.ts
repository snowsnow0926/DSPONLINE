import { CONSTRUCTION, ITEMS, RECIPES, TECHNOLOGIES } from "../../src/game/content";
import { createContentPackRegistry, createContentPackRuntimeSnapshot } from "../../src/game/contentPacks";
import { createNativeCoreCatalog } from "../../src/game/nativeCoreCatalog";
import { createRecursiveCraftPlanner, type RecursiveCraftStep } from "../../src/game/recursiveCrafting";
import type { ItemAmount, ItemId, RecipeDefinition, RecipeId, TechId } from "../../src/game/types";

interface ProbeExports extends WebAssembly.Exports {
  memory: WebAssembly.Memory;
  reserve_input(length: number): number;
  initialize(): number;
  probe(): number;
  prepare(): number;
  measure_prepared(repetitions: number): number;
  output_pointer(): number;
}

interface Outcome {
  possible: boolean;
  steps?: RecursiveCraftStep[];
  decisions?: { itemId: ItemId; recipeId: RecipeId }[];
  blocker?: { itemId: ItemId; current: number; required: number; reason: string };
}

interface Fixture {
  name: string;
  requirements: ItemAmount[];
  inventory: Partial<Record<ItemId, number>>;
  completedTechnologyIds: TechId[];
}

const normalize = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(normalize).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${normalize(entry)}`).join(",")}}`;
  return JSON.stringify(value);
};

async function runProbe() {
  const start = performance.now();
  const { instance } = await WebAssembly.instantiateStreaming(fetch("/kernel.wasm"));
  const wasm = instance.exports as ProbeExports;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const call = (method: "initialize" | "probe" | "prepare", request: unknown) => {
    const input = encoder.encode(JSON.stringify(request));
    const pointer = wasm.reserve_input(input.byteLength);
    if (!pointer) throw new Error("WASM input exceeded experiment limit");
    new Uint8Array(wasm.memory.buffer, pointer, input.byteLength).set(input);
    const length = wasm[method]();
    const result = JSON.parse(decoder.decode(new Uint8Array(wasm.memory.buffer, wasm.output_pointer(), length)));
    if (result.error) throw new Error(result.error);
    return result;
  };
  const instantiateMs = performance.now() - start;
  const catalog = createNativeCoreCatalog(createContentPackRuntimeSnapshot(createContentPackRegistry()));
  const allTech = Object.keys(TECHNOLOGIES) as TechId[];
  const fullStock = Object.fromEntries(Object.keys(ITEMS).map((id) => [id, 50_000]));
  const manufactured = new Set(catalog.recipes.filter((recipe) => recipe.recursiveManufacturing)
    .flatMap((recipe) => recipe.outputs.map((output) => output.itemId)));
  const rawStock = Object.fromEntries(Object.entries(fullStock).filter(([id]) => !manufactured.has(id as ItemId)));
  const fixtures: Fixture[] = [
    { name: "ore-to-steel", inventory: { iron_ore: 6 }, requirements: [{ itemId: "steel", amount: 2 }], completedTechnologyIds: allTech },
    { name: "advanced-first", inventory: { fractal_silicon: 1, silicon_ore: 20 }, requirements: [{ itemId: "crystal_silicon", amount: 2 }], completedTechnologyIds: allTech },
    { name: "lower-tier-fallback", inventory: { silicon_ore: 2 }, requirements: [{ itemId: "crystal_silicon", amount: 1 }], completedTechnologyIds: allTech },
    { name: "advanced-locked", inventory: { fractal_silicon: 1, silicon_ore: 2 }, requirements: [{ itemId: "crystal_silicon", amount: 1 }], completedTechnologyIds: allTech.filter((id) => id !== "rare_resource_utilization") },
    { name: "multi-output", inventory: { gravity_matrix: 1, graviton_lens: 1 }, requirements: [{ itemId: "space_warper", amount: 8 }], completedTechnologyIds: allTech },
    { name: "shared-material", inventory: { iron_ore: 9 }, requirements: [{ itemId: "steel", amount: 2 }, { itemId: "iron_ingot", amount: 3 }], completedTechnologyIds: allTech },
    { name: "missing-raw", inventory: { iron_ore: 5 }, requirements: [{ itemId: "steel", amount: 2 }], completedTechnologyIds: allTech },
  ];
  for (let index = 0; index < 192; index++) {
    let seed = index + 1;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
    const inventory = Object.fromEntries(Object.keys(ITEMS).map((id) => [id,
      index % 3 === 0 ? 50_000 : random() % 5 === 0 ? random() % 80 : 0,
    ]));
    const technologies = allTech.filter(() => index % 4 !== 1 || random() % 4 > 0);
    const requirements = [...CONSTRUCTION[index % CONSTRUCTION.length].costs];
    if (index % 5 === 0) requirements.push(...CONSTRUCTION[(index + 1) % CONSTRUCTION.length].costs);
    fixtures.push({ name: `catalog-${index}`, inventory, requirements, completedTechnologyIds: technologies });
  }
  for (const definition of CONSTRUCTION) {
    fixtures.push({ name: `stock-${definition.buildingId}`, inventory: fullStock, requirements: definition.costs, completedTechnologyIds: allTech });
    fixtures.push({ name: `raw-stock-${definition.buildingId}`, inventory: rawStock, requirements: definition.costs, completedTechnologyIds: allTech });
  }
  const syntheticRecipe: RecipeDefinition = {
    id: "probe-byproduct" as RecipeId, name: "probe byproduct", buildingId: "arc_smelter", duration: 1,
    recursivePriority: 200, inputs: [{ itemId: "copper_ore", amount: 1 }],
    outputs: [{ itemId: "steel", amount: 1 }, { itemId: "copper_ingot", amount: 1 }],
  };
  const synthetic = [syntheticRecipe, ...Array.from({ length: 30 }, (_, index): RecipeDefinition => ({
    id: `probe-route-${index}` as RecipeId, name: `route ${index}`, buildingId: "arc_smelter", duration: 1,
    recursivePriority: 100 - index, inputs: [{ itemId: "iron_ore", amount: 1 }], outputs: [{ itemId: "steel", amount: 1 }],
  }))];
  const reports: unknown[] = [];
  const groups: { name: string; fixtures: Fixture[]; recipes: RecipeDefinition[]; nativeRecipes: typeof catalog.recipes }[] = [
    { name: "catalog", fixtures, recipes: Object.values(RECIPES), nativeRecipes: catalog.recipes },
    { name: "alternatives", fixtures: [
      { name: "byproduct-and-shared-input", inventory: { copper_ore: 1, iron_ore: 1 },
        requirements: [{ itemId: "steel", amount: 1 }, { itemId: "copper_ingot", amount: 1 }], completedTechnologyIds: allTech },
      { name: "backtrack-shared-raw", inventory: { copper_ore: 1, iron_ore: 1 },
        requirements: [{ itemId: "steel", amount: 1 }, { itemId: "copper_ore", amount: 1 }], completedTechnologyIds: allTech },
    ],
      recipes: synthetic, nativeRecipes: synthetic.map((recipe) => ({ ...recipe,
        recursivePriority: recipe.recursivePriority ?? 0, recursiveManufacturing: true })) },
  ];
  for (const group of groups) {
    const rows = group.fixtures.map((fixture, index) => {
      const targetId = `probe-target-${index}`;
      const enabled = new Set(group.nativeRecipes.filter((recipe) => recipe.recursiveManufacturing).map((recipe) => recipe.id));
      const planner = createRecursiveCraftPlanner({ recipes: group.recipes,
        completedTechnologyIds: fixture.completedTechnologyIds, allowRecipe: (recipe) => enabled.has(recipe.id) });
      const dependencies = planner.inventoryDependencies(fixture.requirements);
      const inventory = Object.fromEntries(Object.entries(fixture.inventory).filter(([id]) => dependencies.has(id as ItemId)));
      const js = () => planner.requirements(inventory, fixture.requirements);
      const request = { targetId, inventory, completedTechnologyIds: fixture.completedTechnologyIds };
      const rust = () => call("probe", request) as Outcome;
      const recipesById = new Map(group.recipes.map((recipe) => [recipe.id, recipe]));
      const materialResult = (outcome: Outcome) => {
        const inventoryResult = { ...inventory };
        if (outcome.possible) {
          for (const step of outcome.steps ?? []) {
            const recipe = recipesById.get(step.recipeId)!;
            for (const input of recipe.inputs) {
              const current = inventoryResult[input.itemId] ?? 0;
              if (current < input.amount * step.batches) throw new Error(`Unfunded step: ${fixture.name}`);
              inventoryResult[input.itemId] = Math.floor(current - input.amount * step.batches);
            }
            for (const output of recipe.outputs) inventoryResult[output.itemId] = Math.floor((inventoryResult[output.itemId] ?? 0) + output.amount * step.batches);
          }
          for (const requirement of fixture.requirements) {
            const current = inventoryResult[requirement.itemId] ?? 0;
            if (current < requirement.amount) throw new Error(`Unfunded target: ${fixture.name}`);
            inventoryResult[requirement.itemId] = Math.floor(current - requirement.amount);
          }
        }
        return inventoryResult;
      };
      const comparable = (outcome: Outcome) => ({ possible: outcome.possible,
        steps: outcome.steps ?? [], decisions: outcome.decisions?.map(({ itemId, recipeId }) => ({ itemId, recipeId })) ?? [],
        inventory: materialResult(outcome) });
      const expected = js();
      if (normalize(materialResult(expected)) !== normalize(expected.inventory)) throw new Error(`JS replay failed: ${fixture.name}`);
      return { fixture, targetId, inventory, request, js, rust, comparable, expected };
    });
    const initStart = performance.now();
    const inputCatalog = { ...catalog, recipes: group.nativeRecipes,
      constructions: rows.map(({ fixture, targetId }, index) => ({ id: targetId, outputAmount: 1,
        automationOrder: index, costs: fixture.requirements })) };
    call("initialize", inputCatalog);
    const initializeMs = performance.now() - initStart;
    const mismatches = [];
    let rawBlockerChecks = 0;
    for (const row of rows) {
      const actual = row.rust();
      const jsComparable = row.comparable(row.expected);
      const rustComparable = row.comparable(actual);
      if (normalize(jsComparable) !== normalize(rustComparable)) mismatches.push({ name: row.fixture.name, expected: jsComparable, actual: rustComparable });
      if (actual.blocker) {
        const { itemId, current, required, reason } = row.expected.blocker!;
        if (normalize(actual.blocker) !== normalize({ itemId, current, required, reason })) throw new Error(`Raw blocker differs: ${row.fixture.name}`);
        rawBlockerChecks++;
      }
    }
    const benchmarks = [];
    for (const [name, candidates] of [
      ["stock", rows.filter((row) => row.expected.possible && row.expected.steps.length === 0)],
      ["recursive", rows.filter((row) => row.expected.possible && row.expected.steps.length > 0)],
      ["blocked", rows.filter((row) => !row.expected.possible)],
    ] as const) {
      const batch = candidates.slice(0, 16);
      if (batch.length === 0) continue;
      const measure = (backend: "js" | "rust", repetitions: number) => {
        let checksum = 0;
        const start = performance.now();
        for (let index = 0; index < repetitions; index++) for (const row of batch) {
          const result = row[backend]();
          // Both paths include compact result validation/replay. WASM includes
          // JSON stringify, encoding, transfers, decode and JSON parse as well.
          const comparable = row.comparable(result);
          checksum += comparable.steps.length + Number(comparable.possible);
        }
        return { milliseconds: performance.now() - start, checksum };
      };
      const warmJs = measure("js", 2), warmRust = measure("rust", 2);
      const count = Math.max(32, Math.min(8192, Math.ceil(120 * 2 / Math.max(0.1, warmJs.milliseconds, warmRust.milliseconds))));
      const samples: { js: number; rust: number }[] = [];
      for (let index = 0; index < 5; index++) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        const first = index % 2 ? "rust" : "js";
        const second = first === "js" ? "rust" : "js";
        const a = measure(first, count), b = measure(second, count);
        if (a.checksum !== b.checksum) throw new Error("Timing results differ");
        samples.push({ [first]: a.milliseconds, [second]: b.milliseconds } as { js: number; rust: number });
      }
      const median = (backend: "js" | "rust") => samples.map((sample) => sample[backend]).sort((a, b) => a - b)[2];
      call("prepare", batch.map((row) => row.request));
      const compute = (backend: "js" | "rust") => {
        const start = performance.now();
        let checksum = 0;
        if (backend === "rust") checksum = wasm.measure_prepared(count);
        else for (let index = 0; index < count; index++) for (const row of batch) {
          const plan = row.js();
          checksum += plan.steps.length + Number(plan.possible);
        }
        return { milliseconds: performance.now() - start, checksum };
      };
      compute("js"); compute("rust");
      const computeSamples = [];
      for (let index = 0; index < 5; index++) {
        const first = index % 2 ? "rust" : "js", second = first === "js" ? "rust" : "js";
        const a = compute(first), b = compute(second);
        if (a.checksum !== b.checksum) throw new Error("Core computation results differ");
        computeSamples.push({ [first]: a.milliseconds, [second]: b.milliseconds });
      }
      benchmarks.push({ name, batchSize: batch.length, callsPerSample: batch.length * count,
        medianJsMs: median("js"), medianRustMs: median("rust"), samples,
        coreOnly: { medianJsMs: computeSamples.map((sample) => sample.js!).sort((a, b) => a - b)[2],
          medianRustMs: computeSamples.map((sample) => sample.rust!).sort((a, b) => a - b)[2], samples: computeSamples } });
    }
    reports.push({ name: group.name, fixtures: rows.length, rawBlockerChecks, mismatches,
      initializeMs, catalogBytes: encoder.encode(JSON.stringify(inputCatalog)).length, benchmarks });
  }
  return { scope: "isolated Chromium planner; not whole-save or frame-rate measurement",
    instantiateMs, wasmMemoryBytes: wasm.memory.buffer.byteLength, reports };
}

Object.assign(globalThis, { runConstructionWasmProbe: runProbe });
