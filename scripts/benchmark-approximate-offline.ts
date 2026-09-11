import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { hashGameState } from "../src/game/benchmark";
import {
  inspectApproximateOfflineEligibility,
  runApproximateOfflineSettlement,
  runExactOfflineSettlement,
} from "../src/game/approximateOfflineSimulation";
import {
  advanceSimulationSession,
  completeSimulationAdvanceSession,
  createInitialState,
  createSimulationAdvanceSession,
} from "../src/game/engine";
import { inspectSave } from "../src/game/storage";
import type { GameState, ItemId } from "../src/game/types";

const DURATIONS = [10, 60, 600, 3_600, 86_400, 30 * 86_400] as const;

interface FixtureSpec {
  label: string;
  path: string;
}

interface RuntimeMeasurement {
  elapsedMs: number;
  cpuUserMs: number;
  cpuSystemMs: number;
  heapBeforeBytes: number;
  heapAfterBytes: number;
  heapPeakBytes: number;
  progressMessages: number;
}

interface MeasuredState {
  state: GameState;
  runtime: RuntimeMeasurement;
  diagnostics?: Awaited<ReturnType<typeof runApproximateOfflineSettlement>>["diagnostics"];
}

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

function defaultFixtures(): FixtureSpec[] {
  return [
    { label: "terminal-5.5mb", path: "C:/Users/WINDOWS/Downloads/dsp-idle-save-2026-08-01 (2) (1).json" },
    { label: "terminal-7.3mb", path: "C:/Users/WINDOWS/Downloads/dsp-idle-save-2026-08-02 (1).json" },
  ];
}

function parseFixtures(): FixtureSpec[] {
  const configured = process.argv.filter((value) => value.startsWith("--fixture="));
  if (configured.length === 0) return defaultFixtures();
  return configured.map((value, index) => {
    const raw = value.slice("--fixture=".length);
    const separator = raw.indexOf("|");
    return separator >= 0
      ? { label: raw.slice(0, separator), path: raw.slice(separator + 1) }
      : { label: `fixture-${index + 1}`, path: raw };
  });
}

function round(value: number, digits = 3): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

async function measure(run: (sampleMemory: () => void, onProgress: () => void) => Promise<GameState | { state: GameState; diagnostics: MeasuredState["diagnostics"] }>): Promise<MeasuredState> {
  (globalThis as typeof globalThis & { gc?: () => void }).gc?.();
  const heapBeforeBytes = process.memoryUsage().heapUsed;
  let heapPeakBytes = heapBeforeBytes;
  let progressMessages = 0;
  const sampleMemory = () => { heapPeakBytes = Math.max(heapPeakBytes, process.memoryUsage().heapUsed); };
  const cpuStarted = process.cpuUsage();
  const startedAt = performance.now();
  const raw = await run(sampleMemory, () => { progressMessages += 1; sampleMemory(); });
  sampleMemory();
  const cpu = process.cpuUsage(cpuStarted);
  const state = "state" in raw ? raw.state : raw;
  const diagnostics = "state" in raw ? raw.diagnostics : undefined;
  return {
    state,
    diagnostics,
    runtime: {
      elapsedMs: round(performance.now() - startedAt),
      cpuUserMs: round(cpu.user / 1_000),
      cpuSystemMs: round(cpu.system / 1_000),
      heapBeforeBytes,
      heapAfterBytes: process.memoryUsage().heapUsed,
      heapPeakBytes,
      progressMessages,
    },
  };
}

function createStableControlState(): GameState {
  const state = createInitialState();
  state.entities = [];
  state.belts = [];
  state.paused = false;
  state.contentPacks = [];
  state.research.selectedTechId = null;
  state.research.queuedTechIds = [];
  state.research.progressByTech = {};
  state.exploration.missions = [];
  state.handcraftQueue = [];
  state.constructionQueue = [];
  state.constructionAutomation.enabled = false;
  state.constructionAutomation.jobs = {};
  state.timeWarp.enabled = false;
  state.timeWarp.pendingSimulationSeconds = 0;
  state.timeWarp.pendingWallSeconds = 0;
  state.endgame.activeInfiniteResearchId = null;
  state.endgame.autoResearch = false;
  state.endgame.autoDispatch = false;
  Object.values(state.endgame.exportProjects).forEach((project) => { project.enabled = false; });
  state.endgame.constructionActivity.activityId = null;
  state.endgame.constructionActivity.pendingBatches = {};
  state.dysonSwarm = { sailsInOrbit: 0, totalLaunched: 0, totalExpired: 0, decayProgress: 0, generationKw: 0, receiverLoadKw: 0 };
  state.dysonSphere = { structurePoints: 0, totalRocketsLaunched: 0, shellSails: 0, totalSailsAbsorbed: 0, absorptionProgress: 0, generationKw: 0 };
  state.dysonEngineering.launchEnabled = false;
  state.galacticHubNetwork.fleetBusy = 0;
  state.galacticHubNetwork.fleetReturns = [];
  state.galacticHubNetwork.warpers = "0";
  state.quantumLogisticsNetwork.enabled = false;
  state.quantumLogisticsNetwork.inventory = {};
  state.quantumLogisticsNetwork.runtimeFlow = undefined;
  state.systemSpaceStations = {};
  return state;
}

async function runExact(state: GameState, seconds: number): Promise<MeasuredState> {
  return measure(async (sampleMemory, onProgress) => {
    const result = await runExactOfflineSettlement(state, seconds, {
      onProgress,
      yieldControl: async () => { sampleMemory(); },
    });
    return result;
  });
}

async function runApproximate(state: GameState, seconds: number): Promise<MeasuredState> {
  return measure(async (sampleMemory, onProgress) => {
    const result = await runApproximateOfflineSettlement(state, seconds, {
      onProgress,
      yieldControl: async () => { sampleMemory(); },
    });
    return result;
  });
}

async function runSegmentedExact(state: GameState, seconds: number): Promise<MeasuredState> {
  return measure(async (sampleMemory, onProgress) => {
    const session = createSimulationAdvanceSession(state, seconds);
    while (session.remainingSeconds > 1e-9 || session.remainingWallSeconds > 1e-9) {
      advanceSimulationSession(session, 1);
      onProgress();
      if (Math.floor(session.remainingSeconds) % 64 === 0) sampleMemory();
    }
    return completeSimulationAdvanceSession(session);
  });
}

function addInventory(target: Map<ItemId, number>, record: Partial<Record<ItemId, number>>): void {
  for (const [itemId, amount] of Object.entries(record)) {
    target.set(itemId as ItemId, (target.get(itemId as ItemId) ?? 0) + Number(amount ?? 0));
  }
}

function inventoryTotals(state: GameState): Map<ItemId, number> {
  const totals = new Map<ItemId, number>();
  addInventory(totals, state.tray);
  for (const [planetId, tray] of Object.entries(state.planetTrays)) {
    if (planetId !== state.activePlanetId) addInventory(totals, tray);
  }
  for (const entity of state.entities) {
    addInventory(totals, entity.inputs);
    addInventory(totals, entity.outputs);
  }
  for (const [itemId, amount] of Object.entries(state.quantumLogisticsNetwork.inventory)) {
    totals.set(itemId as ItemId, (totals.get(itemId as ItemId) ?? 0) + Number(amount ?? "0"));
  }
  return totals;
}

function compareStates(expected: GameState, actual: GameState) {
  const expectedInventory = inventoryTotals(expected);
  const actualInventory = inventoryTotals(actual);
  let maximumRelativeItemError = 0;
  let maximumAbsoluteItemError = 0;
  let mismatchedItems = 0;
  for (const itemId of new Set([...expectedInventory.keys(), ...actualInventory.keys()])) {
    const expectedAmount = expectedInventory.get(itemId) ?? 0;
    const actualAmount = actualInventory.get(itemId) ?? 0;
    const absolute = Math.abs(actualAmount - expectedAmount);
    const relative = absolute / Math.max(100, Math.abs(expectedAmount));
    maximumAbsoluteItemError = Math.max(maximumAbsoluteItemError, absolute);
    maximumRelativeItemError = Math.max(maximumRelativeItemError, relative);
    if (absolute > 0) mismatchedItems += 1;
  }
  const routeCargo = (state: GameState) => state.entities.reduce((sum, entity) =>
    sum + (entity.stationRoutes ?? []).reduce((routeSum, route) => routeSum + route.cargo, 0), 0);
  const fleet = (state: GameState) => state.entities.reduce((sum, entity) =>
    sum + (entity.stationDrones ?? 0) + (entity.stationVessels ?? 0) + (entity.stationWarpers ?? 0), 0);
  return {
    stateHashMatch: hashGameState(expected) === hashGameState(actual),
    maximumRelativeItemError: round(maximumRelativeItemError, 6),
    maximumAbsoluteItemError,
    mismatchedItems,
    routeCargoDelta: routeCargo(actual) - routeCargo(expected),
    fleetDelta: fleet(actual) - fleet(expected),
    entityCountDelta: actual.entities.length - expected.entities.length,
    beltCountDelta: actual.belts.length - expected.belts.length,
    elapsedSecondsDelta: round(actual.elapsedSeconds - expected.elapsedSeconds, 6),
    researchMatches: JSON.stringify(actual.research) === JSON.stringify(expected.research),
    dysonMatches: JSON.stringify([actual.dysonSwarm, actual.dysonSphere, actual.dysonEngineering]) ===
      JSON.stringify([expected.dysonSwarm, expected.dysonSphere, expected.dysonEngineering]),
    powerMatches: JSON.stringify(actual.powerGridMetrics) === JSON.stringify(expected.powerGridMetrics),
    constructionMatches: JSON.stringify([actual.constructionQueue, actual.handcraftQueue, actual.constructionAutomation]) ===
      JSON.stringify([expected.constructionQueue, expected.handcraftQueue, expected.constructionAutomation]),
  };
}

async function main(): Promise<void> {
  const maximumActualSeconds = Math.max(10, Number(argument("max-actual-seconds") ?? 60));
  const outputPath = resolve(argument("output") ?? "artifacts/performance/approximate-offline-2026-08-03.json");
  const report = {
    generatedAt: new Date().toISOString(),
    platform: { node: process.version, platform: process.platform, arch: process.arch },
    maximumActualSeconds,
    fixtures: [] as Array<Record<string, unknown>>,
    stableControl: [] as Array<Record<string, unknown>>,
  };

  for (const fixture of parseFixtures()) {
    const raw = readFileSync(fixture.path, "utf8");
    const inspection = inspectSave(raw);
    if (!inspection.valid || !inspection.state) throw new Error(`${fixture.label} 无法通过只读存档校验：${inspection.issues[0] ?? "未知错误"}`);
    const persistedState = inspection.state;
    const persistedHash = hashGameState(persistedState);
    const state = structuredClone(persistedState);
    const persistedPaused = state.paused;
    // A paused save intentionally receives zero offline time in production.
    // For a like-for-like simulation benchmark, only the isolated memory copy
    // is unpaused; the attachment and its parsed source remain untouched.
    if (state.paused) state.paused = false;
    const originalHash = hashGameState(state);
    const eligibility = inspectApproximateOfflineEligibility(state);
    const durations: Array<Record<string, unknown>> = [];
    let longestExact: { seconds: number; elapsedMs: number } | null = null;

    for (const seconds of DURATIONS) {
      if (seconds > maximumActualSeconds) {
        const projectedExactMs = longestExact ? longestExact.elapsedMs * seconds / longestExact.seconds : null;
        durations.push({
          seconds,
          executed: false,
          reason: `超过本次 ${maximumActualSeconds} 秒只读实跑上限`,
          projectedExactMs: projectedExactMs === null ? null : round(projectedExactMs),
          projectedApproximateMs: eligibility.eligible ? null : projectedExactMs === null ? null : round(projectedExactMs),
          approximateWouldFallback: !eligibility.eligible,
        });
        continue;
      }
      const exact = await runExact(state, seconds);
      const segmented = await runSegmentedExact(state, seconds);
      const approximate = await runApproximate(state, seconds);
      longestExact = { seconds, elapsedMs: exact.runtime.elapsedMs };
      durations.push({
        seconds,
        executed: true,
        exact: exact.runtime,
        segmentedExact: segmented.runtime,
        approximate: approximate.runtime,
        approximateDiagnostics: approximate.diagnostics,
        segmentedComparison: compareStates(exact.state, segmented.state),
        approximateComparison: compareStates(exact.state, approximate.state),
        speedup: exact.runtime.elapsedMs / Math.max(0.001, approximate.runtime.elapsedMs),
      });
      if (hashGameState(state) !== originalHash) throw new Error(`${fixture.label} 的原始内存状态被测试修改`);
    }

    report.fixtures.push({
      label: fixture.label,
      bytes: statSync(fixture.path).size,
      stateVersion: state.version,
      entities: state.entities.length,
      belts: state.belts.length,
      routes: state.entities.reduce((sum, entity) => sum + (entity.stationRoutes?.length ?? 0), 0),
      quantumEndpoints: state.entities.filter((entity) => entity.quantumMode === "quantum").length,
      persistedPaused,
      benchmarkCopyUnpaused: persistedPaused,
      eligibility,
      sourceStateUnchanged: hashGameState(state) === originalHash,
      parsedAttachmentUnchanged: hashGameState(persistedState) === persistedHash,
      durations,
    });
  }

  const stableControlState = createStableControlState();
  const stableControlHash = hashGameState(stableControlState);
  for (const seconds of DURATIONS) {
    const exact = await runExact(stableControlState, seconds);
    const segmented = await runSegmentedExact(stableControlState, seconds);
    const approximate = await runApproximate(stableControlState, seconds);
    report.stableControl.push({
      seconds,
      exact: exact.runtime,
      segmentedExact: segmented.runtime,
      approximate: approximate.runtime,
      approximateDiagnostics: approximate.diagnostics,
      segmentedComparison: compareStates(exact.state, segmented.state),
      approximateComparison: compareStates(exact.state, approximate.state),
      speedup: round(exact.runtime.elapsedMs / Math.max(0.001, approximate.runtime.elapsedMs), 3),
    });
    if (hashGameState(stableControlState) !== stableControlHash) throw new Error("稳定对照状态被测试修改");
  }

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ outputPath, fixtures: report.fixtures.length, maximumActualSeconds }, null, 2));
}

await main();
