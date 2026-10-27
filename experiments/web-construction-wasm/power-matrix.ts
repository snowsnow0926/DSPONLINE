import { BUILDINGS, RECIPES, TECHNOLOGY_LIST } from "../../src/game/content";
import { createInitialState, getTimeWarpRequiredPowerKw, refreshTimeWarpPowerSnapshot } from "../../src/game/engine";
import { getPlanetIndustrialProfile } from "../../src/game/galaxy";
import { createOrbitalStationState } from "../../src/game/orbitalStation";
import type { BuildingId, FactoryEntity, GameState, PlanetId, ProliferatorMode, StationSlot } from "../../src/game/types";

function entity(id: string, kind: FactoryEntity["kind"], buildingId: BuildingId, planetId: PlanetId = "home"): FactoryEntity {
  return { id, kind, buildingId, planetId, position: { x: 0, y: 0 }, inputs: {}, outputs: {},
    progress: 0.37, utilization: 0, productionRate: 0, machineCount: 1, minerCount: 0,
    routingCursor: 0, interactionLocked: false, powerFactor: 1, powerGridId: "grid-a" };
}

function baseState(request: number, marginKw: number): GameState {
  const state = createInitialState(271828, false);
  state.orbitalStation = createOrbitalStationState({ mode: state.mode, nowMs: 1_800_000_000_000 });
  state.research.completedTechIds = TECHNOLOGY_LIST.map((technology) => technology.id);
  state.endgame.activeInfiniteResearchId = "matrix_compression";
  state.settings.simulationSpeed = 1;
  state.constructionAutomation.enabled = false;
  const wind = entity("matrix-wind", "power", "wind_turbine");
  const perMachineKw = BUILDINGS.wind_turbine.powerGenerationKw! * getPlanetIndustrialProfile(state, "home").windMultiplier;
  wind.machineCount = Math.max(0, Math.ceil((getTimeWarpRequiredPowerKw(request)! + marginKw) / perMachineKw));
  state.entities = [wind, entity("matrix-clock", "machine", "time_warp_device")];
  state.belts = [];
  state.timeWarp = { ...state.timeWarp, enabled: true, controllerEntityId: "matrix-clock", requestedMultiplier: request };
  return state;
}

function recipeCase(request: number, marginKw: number, mode: ProliferatorMode, supply: "ready" | "missing" | "blocked"): GameState {
  const state = baseState(request, marginKw);
  for (const [index, recipe] of Object.values(RECIPES).entries()) {
    if (BUILDINGS[recipe.buildingId].kind !== "machine") continue;
    const machine = entity(`recipe-${recipe.id}`, "machine", recipe.buildingId);
    machine.recipeId = recipe.id;
    machine.machineCount = 1 + index % 7;
    machine.powerPriority = (1 + index % 3) as 1 | 2 | 3;
    machine.sprayCoaterInstalled = mode !== "normal";
    machine.proliferatorTier = 3;
    machine.proliferatorMode = mode;
    machine.proliferatorPoints = 1_000_000;
    for (const cost of recipe.inputs) machine.inputs[cost.itemId] = supply === "missing" ? 0 : 1_000_000;
    if (supply === "blocked") for (const output of recipe.outputs) machine.outputs[output.itemId] = 1_000_000_000;
    state.entities.push(machine);
  }
  return state;
}

function slot(localMode: StationSlot["localMode"], remoteMode: StationSlot["remoteMode"]): StationSlot {
  return { itemId: "iron_ore", localMode, remoteMode, minimumLoad: 0.1, minStock: 0, maxStock: 0,
    priority: 2, routePolicy: "direct", warperBudget: 2 };
}

function stationCase(kind: "local" | "remote" | "quantum-only" | "mixed", marginKw: number): GameState {
  const state = baseState(8, marginKw);
  const remote = kind === "remote";
  const demand = entity("demand", "station", remote ? "interstellar_logistics_station" : "planetary_logistics_station");
  const supply = entity("supply", "station", remote ? "interstellar_logistics_station" : "planetary_logistics_station", remote ? "ashen" : "home");
  demand.stationDrones = supply.stationDrones = 10;
  demand.stationVessels = supply.stationVessels = 10;
  demand.stationWarpEnabled = supply.stationWarpEnabled = true;
  demand.stationWarpers = supply.stationWarpers = 100;
  demand.stationSlots = [slot(remote ? "storage" : "demand", remote ? "demand" : "storage")];
  supply.stationSlots = [slot(remote ? "storage" : "supply", remote ? "supply" : "storage")];
  supply.outputs.iron_ore = 1_000_000_000;
  const peerWind = entity("peer-wind", "power", "wind_turbine", supply.planetId);
  peerWind.powerGridId = supply.powerGridId = "grid-b";
  peerWind.machineCount = 1_000_000_000;
  state.exploration.colonizedPlanetIds = ["home", "ashen"];
  state.entities.push(demand, supply, peerWind);
  if (kind === "quantum-only" || kind === "mixed") {
    demand.buildingId = "interstellar_logistics_station";
    demand.quantumMode = "quantum";
    if (kind === "mixed") state.entities.push({ ...structuredClone(demand), id: "legacy-demand", quantumMode: "legacy" });
  }
  return state;
}

async function fingerprint(state: GameState) {
  const bytes = new TextEncoder().encode(JSON.stringify(state));
  return { bytes: bytes.length, sha256: [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0")).join("") };
}

async function runPowerMatrixProbe() {
  const reports = [];
  const cases: [string, () => GameState][] = [];
  for (const mode of ["normal", "extra", "speed"] as const) for (const supply of ["ready", "missing", "blocked"] as const) {
    for (const margin of [-1_000_000_000, 0, 1_000_000, 100_000_000]) {
      cases.push([`recipes-8-${mode}-${supply}-${margin}`, () => recipeCase(8, margin, mode, supply)]);
    }
  }
  for (const request of [4, 12]) for (const margin of [0, 1_000_000]) {
    cases.push([`recipes-${request}-speed-ready-${margin}`, () => recipeCase(request, margin, "speed", "ready")]);
  }
  for (const kind of ["local", "remote", "quantum-only", "mixed"] as const) for (const margin of [0, 100_000, 1_000_000]) {
    cases.push([`station-${kind}-${margin}`, () => stationCase(kind, margin)]);
  }
  for (const kind of ["local", "remote"] as const) {
    cases.push([`station-${kind}-empty-supply`, () => {
      const state = stationCase(kind, 0);
      state.entities.find((row) => row.id === "supply")!.outputs.iron_ore = 0;
      return state;
    }]);
    cases.push([`station-${kind}-peer-source-removed`, () => {
      const state = stationCase(kind, 0);
      state.entities = state.entities.filter((row) => row.id !== "peer-wind");
      return state;
    }]);
  }
  for (const [name, make] of cases) {
    const state = make();
    const input = await fingerprint(state);
    const output = refreshTimeWarpPowerSnapshot(state);
    if ((await fingerprint(state)).sha256 !== input.sha256) throw Error(`Source mutated: ${name}`);
    reports.push({ name, input, output: await fingerprint(output), timeWarp: output.timeWarp });
  }
  return { scope: "Complete-state differential correctness matrix, not performance timing", caseCount: reports.length, reports };
}

Object.assign(globalThis, { runPowerMatrixProbe });
