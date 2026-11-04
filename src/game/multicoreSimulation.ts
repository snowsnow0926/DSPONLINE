import {
  runPlanetSimulationPhase,
  type SimulationPlanetPhaseExecutor,
  type SimulationPlanetPhaseResult,
  type SimulationStepPrepared,
} from "./engine";
import type { GameState, PlanetId } from "./types";
import type { ContentPackRuntimeSnapshot } from "./contentPacks";

export interface MulticoreSimulationPlan {
  requestedWorkers: number;
  workerCount: number;
  enabled: boolean;
  reason: "disabled" | "insufficient-work" | "transfer-cost" | "unsafe-boundary" | "approved";
  mode: "single" | "planet-phase";
}

export interface MulticoreSimulationOptions {
  requestedWorkers?: number;
  benchmarkSpeedup?: number;
  enabled?: boolean;
  /** Explicitly supplied only by the local development experiment. */
  completeSimulationProof?: boolean;
}

const MULTICORE_FLAG = "dsp-idle-network.experimental-multicore-simulation.v1";

/**
 * P6 gate. The production default remains one authoritative Worker. Planet
 * phase parallelism is only planned when the caller has a complete-simulation
 * benchmark and an explicit opt-in; the engine still falls back on any
 * boundary, revision, or worker error.
 */
export function planMulticoreSimulation(
  state: Pick<GameState, "entities" | "belts" | "paused" | "timeWarp" | "research" | "constructionAutomation" | "endgame">,
  options: MulticoreSimulationOptions = {},
): MulticoreSimulationPlan {
  const requestedWorkers = Math.max(1, Math.floor(options.requestedWorkers ?? 1));
  const workUnits = state.entities.length + state.belts.length;
  const unsafe = state.paused || state.timeWarp.enabled ||
    (state.constructionAutomation.enabled && state.entities.some((entity) => entity.buildingId === "construction_center")) ||
    (Boolean(state.research.selectedTechId || state.endgame.activeInfiniteResearchId) && state.entities.some((entity) => entity.recipeId === "matrix_research")) ||
    state.entities.some((entity) => entity.recipeId === "solar_sail_launch" || entity.recipeId === "carrier_rocket_launch");
  const base = (reason: MulticoreSimulationPlan["reason"]): MulticoreSimulationPlan => ({
    requestedWorkers,
    workerCount: 1,
    enabled: false,
    reason,
    mode: "single",
  });
  if (!options.enabled) return base("disabled");
  if (workUnits < 512 || requestedWorkers < 2) return base("insufficient-work");
  if (unsafe) return base("unsafe-boundary");
  if (!options.completeSimulationProof || (options.benchmarkSpeedup ?? 0) <= 1.15) return base("transfer-cost");
  return {
    requestedWorkers,
    workerCount: Math.min(requestedWorkers, 4),
    enabled: true,
    reason: "approved",
    mode: "planet-phase",
  };
}

export function readMulticoreSimulationOptions(): MulticoreSimulationOptions {
  if (typeof window === "undefined" || !import.meta.env.DEV) return {};
  try {
    const storage = window.localStorage;
    const enabled = storage.getItem(MULTICORE_FLAG) === "true";
    const requestedWorkers = Number.parseInt(storage.getItem(`${MULTICORE_FLAG}.workers`) ?? "4", 10);
    const benchmarkSpeedup = Number.parseFloat(storage.getItem(`${MULTICORE_FLAG}.speedup`) ?? "0");
    const completeSimulationProof = storage.getItem(`${MULTICORE_FLAG}.proof`) === "true";
    return { enabled, requestedWorkers, benchmarkSpeedup, completeSimulationProof };
  } catch {
    return {};
  }
}

export interface PlanetPhaseWorkerRequest {
  id: number;
  planetIds: PlanetId[];
  state: GameState;
  seconds: number;
  reception: {
    efficiency: number;
    receiverLoadKw: number;
    allocationByEntity: Array<[string, number]>;
    efficiencyByEntity: Array<[string, number]>;
    rayPowerByPlanet: Array<[PlanetId, number]>;
  };
  outputCredits: Array<[string, number]>;
  batchPowerStorage: boolean;
  batchConstructionAutomation: boolean;
  registryFingerprint: string;
  registry?: ContentPackRuntimeSnapshot;
}

export interface PlanetPhaseWorkerResponse {
  id: number;
  ok: boolean;
  results?: SimulationPlanetPhaseResult[];
  error?: string;
}

function copyForPlanetPhase(state: GameState, planetIds?: readonly PlanetId[]): GameState {
  // The mutable phase is planet-local. Remote stations remain as read-only
  // route-readiness context, while belts have already been settled and
  // reserved by the coordinator barrier.
  const localPlanets = planetIds ? new Set(planetIds) : null;
  const snapshot = {
    ...state,
    // A planet phase only mutates its assigned planets. Remote logistics
    // stations remain as read-only routing context for station power demand;
    // belts are already settled/reserved by the coordinator barrier.
    entities: localPlanets
      ? state.entities.filter((entity) => localPlanets.has(entity.planetId) || entity.kind === "station")
      : [...state.entities],
    belts: localPlanets ? [] : [...state.belts],
    productionHistory: [],
    blueprints: [],
    blueprintVersions: [],
    constructionQueue: [],
    handcraftQueue: [],
    productionPlans: [],
    canvasBookmarks: [],
    canvasRegions: [],
    planetViewports: {},
    tray: { ...state.tray },
    totalProduced: { ...state.totalProduced },
  } as unknown as GameState;
  return snapshot;
}

function serialisePrepared(prepared: SimulationStepPrepared): PlanetPhaseWorkerRequest["reception"] {
  return {
    efficiency: prepared.reception.efficiency,
    receiverLoadKw: prepared.reception.receiverLoadKw,
    allocationByEntity: [...prepared.reception.allocationByEntity.entries()],
    efficiencyByEntity: [...prepared.reception.efficiencyByEntity.entries()],
    rayPowerByPlanet: [...prepared.reception.rayPowerByPlanet.entries()],
  };
}

function makeRequest(
  id: number,
  state: GameState,
  seconds: number,
  prepared: SimulationStepPrepared,
  planetIds: PlanetId[],
  options: { batchPowerStorage: boolean; batchConstructionAutomation: boolean },
): PlanetPhaseWorkerRequest {
  return {
    id,
    planetIds,
    state: copyForPlanetPhase(state, planetIds),
    seconds,
    reception: serialisePrepared(prepared),
    outputCredits: [...prepared.beltStepReservation.outputCredits.entries()],
    batchPowerStorage: options.batchPowerStorage,
    batchConstructionAutomation: options.batchConstructionAutomation,
    registryFingerprint: "core",
  };
}

/** Synchronous implementation used by deterministic unit tests and fallback. */
export const runPlanetPhaseSynchronously: SimulationPlanetPhaseExecutor = {
  run: async (state, seconds, prepared, planetIds, options) => planetIds.map((planetId) => {
    const local = structuredClone(copyForPlanetPhase(state));
    return runPlanetSimulationPhase(
      local,
      seconds,
      planetId,
      prepared.reception,
      prepared.beltStepReservation,
      undefined,
      undefined,
      options.batchPowerStorage,
      options.batchConstructionAutomation,
    );
  }),
};

interface WorkerLike {
  postMessage(message: PlanetPhaseWorkerRequest): void;
  terminate(): void;
  onmessage: ((event: MessageEvent<PlanetPhaseWorkerResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
}

/**
 * Browser Worker pool. It owns no GameState and can only return local phase
 * deltas; the coordinator remains the sole authority for global state.
 */
export class BrowserMulticoreExecutor implements SimulationPlanetPhaseExecutor {
  private readonly workers: WorkerLike[];
  private readonly pending = new Map<number, { resolve: (results: SimulationPlanetPhaseResult[]) => void; reject: (error: Error) => void }>();
  private nextId = 1;
  private registry?: ContentPackRuntimeSnapshot;
  private registryFingerprint = "core";

  constructor(workerCount: number, factory: () => WorkerLike = () => new Worker(
    new URL("./multicoreSimulation.worker.ts", import.meta.url),
    { type: "module", name: "factory-simulation-planet" },
  ) as unknown as WorkerLike, registry?: ContentPackRuntimeSnapshot) {
    this.registry = registry;
    this.registryFingerprint = registry?.fingerprint ?? "core";
    const count = Math.max(1, Math.min(4, Math.floor(workerCount)));
    this.workers = Array.from({ length: count }, () => factory());
    for (const worker of this.workers) {
      worker.onmessage = (event) => {
        const pending = this.pending.get(event.data.id);
        if (!pending) return;
        this.pending.delete(event.data.id);
        if (event.data.ok && event.data.results) pending.resolve(event.data.results);
        else pending.reject(new Error(event.data.error ?? "星球分区 Worker 失败"));
      };
      worker.onerror = () => {
        for (const [id, pending] of this.pending) {
          this.pending.delete(id);
          pending.reject(new Error("星球分区 Worker 异常退出"));
        }
      };
    }
  }

  setRegistry(registry?: ContentPackRuntimeSnapshot): void {
    this.registry = registry;
    this.registryFingerprint = registry?.fingerprint ?? "core";
  }

  get workerCount(): number {
    return this.workers.length;
  }

  run(
    state: GameState,
    seconds: number,
    prepared: SimulationStepPrepared,
    planetIds: readonly PlanetId[],
    options: { batchPowerStorage: boolean; batchConstructionAutomation: boolean },
  ): Promise<SimulationPlanetPhaseResult[]> {
    const partitions = partitionPlanetPhaseWork(state, planetIds, this.workers.length);
    const jobs = partitions.map((partition, index) => new Promise<SimulationPlanetPhaseResult[]>((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      try {
        const request = makeRequest(id, state, seconds, prepared, partition, options);
        request.registryFingerprint = this.registryFingerprint;
        request.registry = this.registry;
        this.workers[index % this.workers.length].postMessage(request);
      } catch (error) {
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    }));
    return Promise.all(jobs).then((results) => results.flat());
  }

  terminate(): void {
    for (const worker of this.workers) worker.terminate();
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      pending.reject(new Error("星球分区 Worker 已终止"));
    }
  }
}

export function partitionPlanetPhaseWork(
  state: Pick<GameState, "entities">,
  planetIds: readonly PlanetId[],
  workerCount: number,
): PlanetId[][] {
  const count = Math.max(1, Math.min(Math.floor(workerCount), planetIds.length));
  const weights = new Map<PlanetId, number>(planetIds.map((planetId) => [planetId, 0]));
  for (const entity of state.entities) {
    if (!weights.has(entity.planetId)) continue;
    const phaseWeight = entity.kind === "machine" || entity.kind === "vein" || entity.kind === "power" ? 3 : 1;
    weights.set(entity.planetId, (weights.get(entity.planetId) ?? 0) + phaseWeight);
  }
  const partitions = Array.from({ length: count }, () => ({ planetIds: [] as PlanetId[], weight: 0 }));
  const ordered = [...planetIds].sort((left, right) =>
    (weights.get(right) ?? 0) - (weights.get(left) ?? 0) || left.localeCompare(right));
  for (const planetId of ordered) {
    partitions.sort((left, right) => left.weight - right.weight || left.planetIds.join("|").localeCompare(right.planetIds.join("|")));
    partitions[0].planetIds.push(planetId);
    partitions[0].weight += weights.get(planetId) ?? 0;
  }
  return partitions.map((partition) => partition.planetIds);
}

export function canRunPlanetPhaseParallel(state: Pick<GameState, "paused" | "timeWarp" | "entities" | "research" | "constructionAutomation" | "endgame">): boolean {
  return !state.paused && !state.timeWarp.enabled &&
    !(state.constructionAutomation.enabled && state.entities.some((entity) => entity.buildingId === "construction_center")) &&
    !(Boolean(state.research.selectedTechId || state.endgame.activeInfiniteResearchId) && state.entities.some((entity) => entity.recipeId === "matrix_research")) &&
    !state.entities.some((entity) => entity.recipeId === "solar_sail_launch" || entity.recipeId === "carrier_rocket_launch");
}
