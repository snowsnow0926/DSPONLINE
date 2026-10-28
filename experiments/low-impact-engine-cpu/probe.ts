/** Explicit small CPU diagnostic; its filename is excluded from default unit discovery. */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ITEMS, TECHNOLOGIES } from "../../src/game/content";
import { advancePersistentSimulationRuntime, createInitialState, createPersistentSimulationRuntime } from "../../src/game/engine";
import type { FactoryEntity, GameState, ItemId, PlanetId } from "../../src/game/types";

if (process.env.DSP_SMALL_CPU_PROBE !== "1") throw new Error("Explicit low-impact runner required");
const output = process.env.DSP_SMALL_CPU_OUTPUT!;
const manifest = JSON.parse(readFileSync(process.env.DSP_SMALL_CPU_MANIFEST!, "utf8"));
const variant = process.env.DSP_SMALL_CPU_VARIANT!;
const expectedSources = manifest.runtimes[variant].sourceHashes;
const loadedSources = (globalThis as typeof globalThis & { __DSP_SMALL_CPU_SOURCES?: Record<string, string> }).__DSP_SMALL_CPU_SOURCES;
expect(loadedSources).toEqual(expectedSources);
const allCases = ["idle", "stocked", "recursive", "quantum"] as const;
type Scenario = typeof allCases[number];
const cases: readonly Scenario[] = manifest.cases ?? allCases;
if (cases.length < 1 || new Set(cases).size !== cases.length || cases.some((name) => !allCases.includes(name))) {
  throw new Error("Unknown or duplicate diagnostic cases");
}
const WARM_STEPS = 40;
const MEASURED_STEPS: number = manifest.measuredSteps;
if (![120, 960, 7680].includes(MEASURED_STEPS) ||
  (MEASURED_STEPS === 7680 && (cases.length !== 1 || cases[0] !== "idle"))) {
  throw new Error("Only bounded declared probe windows are supported");
}
const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const rawItems: ItemId[] = ["iron_ore", "copper_ore", "stone", "coal", "silicon_ore", "titanium_ore",
  "crude_oil", "water", "hydrogen", "refined_oil", "sulfuric_acid", "organic_crystal", "fire_ice",
  "spiniform_stalagmite_crystal", "fractal_silicon", "optical_grating_crystal", "unipolar_magnet", "kimberlite_ore"];

function fixture(name: Scenario): GameState {
  const state = createInitialState(20_261_101, false);
  state.research.completedTechIds = Object.keys(TECHNOLOGIES) as GameState["research"]["completedTechIds"];
  state.exploration.colonizedPlanetIds = ["home", "ashen"];
  const planets: readonly PlanetId[] = ["home", "ashen"];
  const entity = (id: string, planetId: PlanetId): FactoryEntity => ({ id, planetId, kind: "machine", buildingId: "arc_smelter",
    recipeId: "iron_ingot", position: { x: 0, y: 0 }, interactionLocked: false, inputs: {}, outputs: {},
    progress: 0, utilization: 0, productionRate: 0, routingCursor: 0, machineCount: 0, minerCount: 0 });
  state.entities = [];
  for (let index = 0; index < (name === "idle" ? 80 : 20); index++) for (const planetId of planets) {
    state.entities.push(entity(`background-${planetId}-${index}`, planetId));
  }
  for (const planetId of planets) state.entities.push({ ...entity(`power-${planetId}`, planetId), kind: "power",
    buildingId: "wind_turbine", recipeId: undefined, machineCount: 1_000_000 });
  state.belts = [];
  state.tray = name === "recursive"
    ? { ...Object.fromEntries(rawItems.map((itemId) => [itemId, 1_000_000])), gear: 5000, circuit_board: 5000, processor: 1000 }
    : { iron_ingot: 1_000_000_000, stone_brick: 1_000_000_000, gear: 1_000_000_000,
      circuit_board: 1_000_000_000, magnetic_coil: 1_000_000_000 };
  state.planetTrays.home = state.tray;
  state.planetTrays.ashen = { ...state.tray };
  state.construction.arc_smelter = state.construction.wind_turbine = state.construction.ray_receiver = 0;
  state.constructionAutomation = { enabled: name !== "idle", targetStock: name === "recursive"
    ? { ray_receiver: 1_000_000 } : { arc_smelter: 1_000_000, wind_turbine: 1_000_000 },
    jobs: {}, cursor: 0, totalCrafted: 0, lastCraftedId: null, destroyedByproducts: {} };
  if (name !== "idle") for (let index = 0; index < (name === "quantum" ? 3 : 1); index++) {
    state.entities.push({ ...entity(`center-${index}`, "home"), buildingId: "construction_center", recipeId: undefined,
      machineCount: name === "stocked" ? 300 : 60 });
  }
  if (name === "quantum") {
    state.tray = {};
    state.planetTrays.home = state.tray;
    state.constructionAutomation.quantumSourceEnabled = true;
    state.quantumLogisticsNetwork.enabled = true;
    state.quantumLogisticsNetwork.inventory = Object.fromEntries(Object.keys(ITEMS).map((itemId) => [itemId, "1000000000"]));
    state.entities.push({ ...entity("tower", "home"), kind: "station", buildingId: "interstellar_logistics_station",
      recipeId: undefined, stationTier: 2, quantumMode: "quantum", stationSlots: [], stationRoutes: [], machineCount: 1000 });
  }
  return state;
}

function warm(input: GameState): string {
  const runtime = createPersistentSimulationRuntime(structuredClone(input));
  for (let step = 0; step < WARM_STEPS; step++) advancePersistentSimulationRuntime(runtime, 1, 1);
  return sha(runtime.state);
}

beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(1_800_000_000_000); });
afterEach(() => vi.useRealTimers());

it.each(cases)("bounded uninstrumented CPU: %s", (name) => {
  const input = fixture(name);
  expect(input.entities.length).toBeLessThanOrEqual(200);
  expect(input.belts.length).toBe(0);
  const inputHash = sha(input);
  const warmStateHash = warm(input);
  const runtime = createPersistentSimulationRuntime(structuredClone(input));
  const wallStart = performance.now();
  const cpuStart = process.cpuUsage();
  for (let step = 0; step < MEASURED_STEPS; step++) advancePersistentSimulationRuntime(runtime, 1, 1);
  const cpu = process.cpuUsage(cpuStart);
  const wallMs = performance.now() - wallStart;
  const finalStateHash = sha(runtime.state);
  expect(sha(input)).toBe(inputHash);
  expect(runtime.state.elapsedSeconds - input.elapsedSeconds).toBe(MEASURED_STEPS);
  if (name !== "idle") expect(runtime.state.constructionAutomation.totalCrafted).toBeGreaterThan(0);
  const record = { variant, scenario: name, sourceCommit: manifest.runtimes[variant].commit, loadedSources,
    inputHash, inputUnchanged: true, warmStateHash, finalStateHash, entityCount: input.entities.length,
    beltCount: input.belts.length, warmSteps: WARM_STEPS, measuredSteps: MEASURED_STEPS,
    cpuUserUs: cpu.user, cpuSystemUs: cpu.system, cpuMs: (cpu.user + cpu.system) / 1000, wallMs,
    nodeVersion: process.version, platform: process.platform, arch: process.arch,
    processId: process.pid, rssAfterMeasurement: process.memoryUsage().rss };
  writeFileSync(join(output, `${name}.json`), `${JSON.stringify(record, null, 2)}\n`, { flag: "wx" });
  console.info(JSON.stringify({ scenario: name, variant, cpuMs: record.cpuMs, wallMs }));
}, 60_000);
