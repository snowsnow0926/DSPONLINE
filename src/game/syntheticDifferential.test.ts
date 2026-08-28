/// <reference types="node" />

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import syntheticManifest from "../../tests/fixtures/synthetic/manifest.json";
import { hashGameState } from "./benchmark";
import { createContentPackRegistry } from "./contentPacks";
import {
  advancePersistentSimulationRuntime,
  advanceSimulation,
  advanceSimulationBudget,
  advanceSimulationSession,
  completeSimulationAdvanceSession,
  createPersistentSimulationRuntime,
  createSimulationAdvanceSession,
  getVeinConsumptionMultiplier,
} from "./engine";
import { validatePureIdleResourceAccounting } from "./offlineApproximation";
import { advanceOfflineSimulationChunk } from "./offlineSimulation";
import { advancePureIdleMacroSession, createPureIdleMacroSession } from "./pureIdleMacro";
import { finalizePureIdleMacroSession } from "./pureIdleMacroValidation";
import { computeSaveStateChecksum } from "./saveEnvelopeIntegrity";
import { importGame, inspectSave } from "./storage";
import type { FactoryEntity, GameState, ItemId, SaveMode } from "./types";

const MODES = ["normal", "speedrun"] as const satisfies readonly SaveMode[];
const CI_PROFILE = "1m";
const CI_SIMULATION_SECONDS = 4;
const SYNTHETIC_SEED = 1_040_406;
// offlineApproximation.ts deliberately keeps this player-approved ceiling at
// 100%. This suite compares deltas (not large accumulated totals) against the
// same contract while retaining structural and conservation checks as hard
// gates.
const EXISTING_TIME_WARP_CRITICAL_ERROR_LIMIT = 1;
// Existing finite-miner pure-idle regressions use a 20% production-delta
// tolerance while requiring exact reserve/output accounting.
const EXISTING_PURE_IDLE_RESOURCE_ERROR_LIMIT = 0.2;

interface GeneratedFixtureRecord {
  profile: string;
  mode: SaveMode;
  slot: "main" | 1 | 2 | 3;
  seed: number;
  bytes: number;
  sha256: string;
  stateChecksum: string;
  entityCount: number;
  beltCount: number;
  outputPath: string;
}

interface SyntheticEnvelope {
  formatVersion: number;
  kind: string;
  savedAt: number;
  mode: SaveMode;
  slot: "main" | 1 | 2 | 3;
  state: GameState & {
    syntheticFixture?: {
      profile?: string;
      seed?: number;
      mode?: SaveMode;
      slot?: "main" | 1 | 2 | 3;
      anonymous?: boolean;
    };
  };
  checksum: string;
}

interface GeneratedFixture {
  record: GeneratedFixtureRecord;
  raw: string;
  envelope: SyntheticEnvelope;
}

interface SegmentedSimulationResult {
  state: GameState;
  checkpointDigests: StateDigest[];
  steps: number[];
}

interface StateDigest {
  stateHash: string;
  envelopeChecksum: string;
}

interface CriticalSnapshot {
  whiteMatrixProduced: number;
  rocketsLaunched: number;
  structurePoints: number;
  shellSails: number;
  sailsAbsorbed: number;
  sailsLaunched: number;
  sphereGenerationKw: number;
  swarmGenerationKw: number;
}

let fixtureRoot: string | null = null;
let fixtures = new Map<SaveMode, GeneratedFixture>();
let repeatedNormal: GeneratedFixture | null = null;

function generatorRecords(outputDirectory: string, mode: "all" | SaveMode): GeneratedFixtureRecord[] {
  const result = spawnSync(process.execPath, [
    resolve("scripts/generate-synthetic-save-fixtures.mjs"),
    `--profile=${CI_PROFILE}`,
    `--mode=${mode}`,
    "--slot=main",
    `--seed=${SYNTHETIC_SEED}`,
    `--output-dir=${outputDirectory}`,
    "--json",
  ], {
    cwd: process.cwd(),
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    timeout: 60_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Synthetic fixture generator failed (${result.status}): ${result.stderr.trim()}`);
  }
  return result.stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as GeneratedFixtureRecord);
}

async function loadGeneratedFixture(record: GeneratedFixtureRecord): Promise<GeneratedFixture> {
  const raw = await readFile(record.outputPath, "utf8");
  return { record, raw, envelope: JSON.parse(raw) as SyntheticEnvelope };
}

function fixture(mode: SaveMode): GeneratedFixture {
  const selected = fixtures.get(mode);
  if (!selected) throw new Error(`Synthetic ${mode} fixture was not generated`);
  return selected;
}

function migratedFixtureState(mode: SaveMode): GameState {
  const inspection = inspectSave(fixture(mode).raw);
  if (!inspection.valid || !inspection.state) {
    throw new Error(`Synthetic ${mode} fixture failed migration: ${inspection.issues.join("; ")}`);
  }
  return inspection.state;
}

function persistedState(state: GameState): GameState {
  return JSON.parse(JSON.stringify(state)) as GameState;
}

function stateDigest(state: GameState): StateDigest {
  const persisted = persistedState(state);
  return {
    stateHash: hashGameState(persisted),
    envelopeChecksum: computeSaveStateChecksum(2, persisted),
  };
}

function simulationSource(mode: SaveMode): GameState {
  const source = structuredClone(migratedFixtureState(mode));
  source.paused = false;
  source.timeWarp.enabled = false;
  source.timeWarp.pendingSimulationSeconds = 0;
  source.timeWarp.pendingWallSeconds = 0;
  // Persistent runtime normalization is part of the live 1.0.38+ path. Do it
  // once before branching so every oracle starts from byte-identical state.
  return persistedState(createPersistentSimulationRuntime(source).state);
}

function runSegmentedExact(source: GameState): SegmentedSimulationResult {
  const session = createSimulationAdvanceSession(structuredClone(source), CI_SIMULATION_SECONDS);
  const checkpointDigests: StateDigest[] = [];
  const steps: number[] = [];
  for (const maximumWindowSeconds of [1, 2, 1]) {
    steps.push(advanceOfflineSimulationChunk(session, { maximumWindowSeconds, scanCriticalEvents: false }));
    checkpointDigests.push(stateDigest(session.state));
  }
  if (session.remainingSeconds > 1e-9) {
    throw new Error(`Segmented exact session left ${session.remainingSeconds} simulation seconds unsettled`);
  }
  return { state: persistedState(completeSimulationAdvanceSession(session)), checkpointDigests, steps };
}

function runUnindexedOracle(source: GameState): GameState {
  const session = createSimulationAdvanceSession(structuredClone(source), CI_SIMULATION_SECONDS, {
    indexedLogistics: false,
  });
  advanceSimulationSession(session, Number.MAX_SAFE_INTEGER);
  return persistedState(completeSimulationAdvanceSession(session));
}

function runPersistentRuntime(source: GameState): GameState {
  const runtime = createPersistentSimulationRuntime(structuredClone(source));
  advancePersistentSimulationRuntime(runtime, CI_SIMULATION_SECONDS, CI_SIMULATION_SECONDS);
  return persistedState(runtime.state);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function collectNonFiniteNumbers(value: unknown, path = "state", violations: string[] = []): string[] {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) violations.push(`${path}=${String(value)}`);
    return violations;
  }
  if (!value || typeof value !== "object") return violations;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => collectNonFiniteNumbers(entry, `${path}[${index}]`, violations));
    return violations;
  }
  for (const [key, entry] of Object.entries(value)) {
    collectNonFiniteNumbers(entry, `${path}.${key}`, violations);
  }
  return violations;
}

function collectQuantityRecordViolations(
  record: Record<string, unknown> | undefined,
  path: string,
  violations: string[],
): void {
  for (const [key, value] of Object.entries(record ?? {})) {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
      violations.push(`${path}.${key}=${String(value)}`);
    }
  }
}

function collectDecimalRecordViolations(
  record: Record<string, unknown> | undefined,
  path: string,
  violations: string[],
): void {
  for (const [key, value] of Object.entries(record ?? {})) {
    if (typeof value !== "string" || !/^\d+$/.test(value)) {
      violations.push(`${path}.${key}=${String(value)}`);
    }
  }
}

function collectMaterialQuantityViolations(state: GameState): string[] {
  const violations: string[] = [];
  collectQuantityRecordViolations(state.tray as Record<string, unknown>, "tray", violations);
  for (const [planetId, tray] of Object.entries(state.planetTrays)) {
    collectQuantityRecordViolations(tray as Record<string, unknown>, `planetTrays.${planetId}`, violations);
  }
  collectQuantityRecordViolations(state.construction as Record<string, unknown>, "construction", violations);
  collectQuantityRecordViolations(state.portableFleet as unknown as Record<string, unknown>, "portableFleet", violations);
  collectQuantityRecordViolations(state.totalProduced as Record<string, unknown>, "totalProduced", violations);
  collectQuantityRecordViolations(
    state.constructionAutomation.destroyedByproducts as Record<string, unknown>,
    "constructionAutomation.destroyedByproducts",
    violations,
  );
  for (const [jobId, job] of Object.entries(state.constructionAutomation.jobs)) {
    collectQuantityRecordViolations(job.inventory as Record<string, unknown>, `constructionAutomation.jobs.${jobId}.inventory`, violations);
  }
  for (const entity of state.entities) {
    collectQuantityRecordViolations(entity.inputs as Record<string, unknown>, `entities.${entity.id}.inputs`, violations);
    collectQuantityRecordViolations(entity.outputs as Record<string, unknown>, `entities.${entity.id}.outputs`, violations);
    for (const [field, value] of Object.entries({
      machineCount: entity.machineCount,
      minerCount: entity.minerCount,
      resourceRemaining: entity.resourceRemaining,
      resourceCapacity: entity.resourceCapacity,
      stationDrones: entity.stationDrones,
      stationVessels: entity.stationVessels,
      stationWarpers: entity.stationWarpers,
    })) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
        violations.push(`entities.${entity.id}.${field}=${String(value)}`);
      }
    }
    for (const route of entity.stationRoutes ?? []) {
      if (!Number.isSafeInteger(route.cargo) || route.cargo < 0) {
        violations.push(`entities.${entity.id}.routes.${route.id}.cargo=${String(route.cargo)}`);
      }
      if (!Number.isSafeInteger(route.vehicleCount) || route.vehicleCount < 0) {
        violations.push(`entities.${entity.id}.routes.${route.id}.vehicleCount=${String(route.vehicleCount)}`);
      }
    }
  }
  collectDecimalRecordViolations(
    state.quantumLogisticsNetwork.inventory as Record<string, unknown>,
    "quantumLogisticsNetwork.inventory",
    violations,
  );
  collectDecimalRecordViolations(
    state.quantumLogisticsNetwork.itemCapacities as Record<string, unknown>,
    "quantumLogisticsNetwork.itemCapacities",
    violations,
  );
  return violations;
}

function finiteVein(state: GameState, id: string): FactoryEntity {
  const entity = state.entities.find((candidate) => candidate.id === id);
  if (!entity || entity.kind !== "vein" || entity.resourceRemaining === undefined) {
    throw new Error(`Expected finite synthetic vein ${id}`);
  }
  return entity;
}

function reserveTenths(entity: FactoryEntity): number {
  return Math.max(0, Math.floor(entity.resourceRemaining ?? 0)) * 10 -
    Math.max(0, Math.min(9, Math.floor(entity.resourceDepletionRemainder ?? 0)));
}

function transferredFromVein(state: GameState, entityId: string, itemId: ItemId): number {
  return state.belts.reduce((total, belt) => belt.source === entityId && belt.itemId === itemId
    ? total + Math.max(0, Math.floor(belt.totalTransferred ?? 0))
    : total, 0);
}

function criticalSnapshot(state: GameState): CriticalSnapshot {
  return {
    whiteMatrixProduced: Math.max(0, state.totalProduced.universe_matrix ?? 0),
    rocketsLaunched: Math.max(0, state.dysonSphere.totalRocketsLaunched),
    structurePoints: Math.max(0, state.dysonSphere.structurePoints),
    shellSails: Math.max(0, state.dysonSphere.shellSails),
    sailsAbsorbed: Math.max(0, state.dysonSphere.totalSailsAbsorbed),
    sailsLaunched: Math.max(0, state.dysonSwarm.totalLaunched),
    // Compare independently derived domains separately. Summing a growing
    // sphere and an expiring swarm can make a small component error look
    // greater than 100% when the oracle deltas nearly cancel each other.
    sphereGenerationKw: Math.max(0, state.dysonSphere.generationKw),
    swarmGenerationKw: Math.max(0, state.dysonSwarm.generationKw),
  };
}

function maximumDeltaError(before: CriticalSnapshot, candidate: CriticalSnapshot, oracle: CriticalSnapshot): number {
  let maximum = 0;
  for (const key of Object.keys(before) as Array<keyof CriticalSnapshot>) {
    const candidateDelta = candidate[key] - before[key];
    const oracleDelta = oracle[key] - before[key];
    maximum = Math.max(maximum, Math.abs(candidateDelta - oracleDelta) /
      Math.max(1, Math.abs(candidateDelta), Math.abs(oracleDelta)));
  }
  return maximum;
}

function relativeDeltaError(before: number, candidate: number, oracle: number): number {
  const candidateDelta = candidate - before;
  const oracleDelta = oracle - before;
  return Math.abs(candidateDelta - oracleDelta) / Math.max(1, Math.abs(candidateDelta), Math.abs(oracleDelta));
}

function pureIdleSource(): GameState {
  const source = simulationSource("normal");
  source.timeWarp.enabled = true;
  source.timeWarp.requestedMultiplier = 5;
  source.timeWarp.effectiveMultiplier = 1;
  source.timeWarp.pendingSimulationSeconds = 0;
  source.timeWarp.pendingWallSeconds = 0;

  // The production-shaped fixture intentionally models a heavily starved
  // shared grid. Isolate the time-warp controller on grid C with a dedicated
  // synthetic wind stack so this test verifies an actual 5x session rather
  // than silently exercising the 1x no-power fallback.
  for (const entity of source.entities) {
    if (entity.powerGridId === "grid-c") entity.powerGridId = "grid-a";
  }
  const controller = source.entities.find((entity) => entity.id === source.timeWarp.controllerEntityId);
  const wind = source.entities.find((entity) => entity.id === "syn_power_wind_stack");
  if (!controller || !wind) throw new Error("Synthetic pure-idle controller or wind stack is missing");
  controller.powerGridId = "grid-c";
  controller.powerPriority = 1;
  source.entities.push({
    ...structuredClone(wind),
    id: "syn_differential_time_warp_power",
    powerGridId: "grid-c",
    position: { x: -200, y: -200 },
    machineCount: 100_000_000,
  });
  return persistedState(createPersistentSimulationRuntime(source).state);
}

beforeAll(async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "dsp-synthetic-differential-"));
  const primaryRecords = generatorRecords(join(fixtureRoot, "primary"), "all");
  fixtures = new Map(await Promise.all(primaryRecords.map(async (record) => [
    record.mode,
    await loadGeneratedFixture(record),
  ] as const)));
  const repeatedRecord = generatorRecords(join(fixtureRoot, "repeat"), "normal")[0];
  repeatedNormal = await loadGeneratedFixture(repeatedRecord);
}, 60_000);

afterAll(async () => {
  if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true });
  fixtureRoot = null;
  fixtures.clear();
  repeatedNormal = null;
});

describe("deterministic synthetic fixture differential contracts", () => {
  it("reproduces the pinned same-seed payload and state hashes without retaining generated bodies", () => {
    expect(repeatedNormal).not.toBeNull();
    for (const mode of MODES) {
      const generated = fixture(mode);
      const expected = syntheticManifest.profiles[CI_PROFILE][mode];
      expect(generated.record).toMatchObject({
        profile: CI_PROFILE,
        mode,
        slot: "main",
        seed: syntheticManifest.seed,
        bytes: syntheticManifest.profiles[CI_PROFILE].targetBytes,
        sha256: expected.sha256,
        stateChecksum: expected.stateChecksum,
        entityCount: expected.entityCount,
        beltCount: expected.beltCount,
      });
      expect(Buffer.byteLength(generated.raw, "utf8")).toBe(1024 * 1024);
      expect(sha256(generated.raw)).toBe(expected.sha256);
      expect(computeSaveStateChecksum(generated.envelope.formatVersion, generated.envelope.state)).toBe(expected.stateChecksum);
      expect(generated.envelope.checksum).toBe(expected.stateChecksum);
    }
    expect(repeatedNormal!.record.sha256).toBe(fixture("normal").record.sha256);
    expect(repeatedNormal!.record.stateChecksum).toBe(fixture("normal").record.stateChecksum);
    expect(repeatedNormal!.raw).toBe(fixture("normal").raw);
    expect(fixture("normal").record.sha256).not.toBe(fixture("speedrun").record.sha256);
  });

  it.each(MODES)("keeps %s whole, segmented-offline, persistent, and unindexed authoritative paths hash-identical", (mode) => {
    const source = simulationSource(mode);
    const sourceDigest = stateDigest(source);
    const whole = persistedState(advanceSimulation(structuredClone(source), CI_SIMULATION_SECONDS));
    const segmented = runSegmentedExact(source);
    const replay = runSegmentedExact(source);
    const persistent = runPersistentRuntime(source);
    const unindexed = runUnindexedOracle(source);
    const expectedDigest = stateDigest(whole);

    expect(segmented.steps).toEqual([1, 2, 1]);
    expect(segmented.checkpointDigests).toEqual(replay.checkpointDigests);
    expect(stateDigest(segmented.state)).toEqual(expectedDigest);
    expect(stateDigest(replay.state)).toEqual(expectedDigest);
    expect(stateDigest(persistent)).toEqual(expectedDigest);
    expect(stateDigest(unindexed)).toEqual(expectedDigest);
    expect(stateDigest(source)).toEqual(sourceDigest);
    expect(whole.mode).toBe(mode);
    if (mode === "speedrun") {
      expect(whole.speedrun?.enabled).toBe(true);
      expect(whole.speedrun?.elapsedActiveSeconds).toBeCloseTo(
        (source.speedrun?.elapsedActiveSeconds ?? 0) + CI_SIMULATION_SECONDS,
        6,
      );
    } else {
      expect(whole.speedrun).toBeUndefined();
    }
  }, 30_000);

  it.each(MODES)("keeps %s quantities finite/non-negative and finite-vein depletion attributable to production", (mode) => {
    const source = simulationSource(mode);
    const advanced = persistedState(advanceSimulation(structuredClone(source), CI_SIMULATION_SECONDS));

    expect(collectNonFiniteNumbers(advanced)).toEqual([]);
    expect(collectMaterialQuantityViolations(advanced)).toEqual([]);
    expect(validatePureIdleResourceAccounting(source, advanced)).toBeNull();

    const finiteBefore = source.entities.filter((entity) => entity.kind === "vein" && entity.resourceRemaining !== undefined);
    expect(finiteBefore.length).toBeGreaterThan(0);
    for (const before of finiteBefore) {
      const after = finiteVein(advanced, before.id);
      expect(after.resourceRemaining, before.id).toBeGreaterThanOrEqual(0);
      expect(after.resourceRemaining, before.id).toBeLessThanOrEqual(before.resourceRemaining ?? 0);
      expect(after.resourceDepletionRemainder ?? 0, before.id).toBeGreaterThanOrEqual(0);
      expect(after.resourceDepletionRemainder ?? 0, before.id).toBeLessThanOrEqual(9);
    }

    const ironBefore = finiteVein(source, "syn_vein_iron_finite");
    const ironAfter = finiteVein(advanced, "syn_vein_iron_finite");
    const depletedTenths = reserveTenths(ironBefore) - reserveTenths(ironAfter);
    const producedDelta = Math.floor(advanced.totalProduced.iron_ore ?? 0) - Math.floor(source.totalProduced.iron_ore ?? 0);
    const outputDelta = Math.floor(ironAfter.outputs.iron_ore ?? 0) - Math.floor(ironBefore.outputs.iron_ore ?? 0);
    const transferredDelta = transferredFromVein(advanced, ironBefore.id, "iron_ore") -
      transferredFromVein(source, ironBefore.id, "iron_ore");
    const consumptionTenths = Math.max(1, Math.round(getVeinConsumptionMultiplier(source) * 10));
    expect(depletedTenths).toBeGreaterThan(0);
    expect(producedDelta).toBeGreaterThan(0);
    expect(depletedTenths).toBe(producedDelta * consumptionTenths);
    expect(outputDelta + transferredDelta).toBe(producedDelta);
  }, 30_000);

  it("produces in infinite-resource mode without reducing the persisted synthetic reserve", () => {
    const source = simulationSource("normal");
    source.settings.resourceMode = "infinite";
    const before = finiteVein(source, "syn_vein_iron_finite");
    const beforeRemaining = before.resourceRemaining;
    const beforeProduced = source.totalProduced.iron_ore ?? 0;

    const advanced = persistedState(advanceSimulation(structuredClone(source), CI_SIMULATION_SECONDS));
    const after = finiteVein(advanced, before.id);

    expect(after.resourceRemaining).toBe(beforeRemaining);
    expect(advanced.totalProduced.iron_ore ?? 0).toBeGreaterThan(beforeProduced);
    expect(collectNonFiniteNumbers(advanced)).toEqual([]);
    expect(collectMaterialQuantityViolations(advanced)).toEqual([]);
  });

  it("keeps normal and speedrun envelopes, imports, clocks, and pure-idle eligibility isolated", () => {
    const normal = fixture("normal").envelope;
    const speedrun = fixture("speedrun").envelope;

    expect(normal).toMatchObject({ formatVersion: 2, mode: "normal", slot: "main" });
    expect(normal.state.mode).toBe("normal");
    expect(Object.hasOwn(normal.state, "speedrun")).toBe(false);
    expect(normal.state.syntheticFixture).toMatchObject({
      profile: CI_PROFILE,
      seed: SYNTHETIC_SEED,
      mode: "normal",
      slot: "main",
      anonymous: true,
    });

    expect(speedrun).toMatchObject({ formatVersion: 2, mode: "speedrun", slot: "main" });
    expect(speedrun.state).toMatchObject({
      mode: "speedrun",
      settings: { resourceMode: "finite" },
      speedrun: { enabled: true, mode: "speedrun", eligible: true },
      syntheticFixture: {
        profile: CI_PROFILE,
        seed: SYNTHETIC_SEED,
        mode: "speedrun",
        slot: "main",
        anonymous: true,
      },
    });

    expect(importGame(fixture("normal").raw, "normal", "main")?.mode).toBe("normal");
    expect(importGame(fixture("speedrun").raw, "speedrun", "main")?.mode).toBe("speedrun");
    expect(importGame(fixture("normal").raw, "speedrun", "main")).toBeNull();
    expect(importGame(fixture("speedrun").raw, "normal", "main")).toBeNull();
    expect(importGame(fixture("normal").raw, "normal", 1)).toBeNull();
    expect(importGame(fixture("speedrun").raw, "speedrun", 1)).toBeNull();

    const speedrunPureIdle = simulationSource("speedrun");
    speedrunPureIdle.timeWarp.enabled = true;
    speedrunPureIdle.timeWarp.pendingSimulationSeconds = 0;
    speedrunPureIdle.timeWarp.pendingWallSeconds = 0;
    expect(() => createPureIdleMacroSession(speedrunPureIdle, "extreme")).toThrow(/速通工厂/);
  });

  it("reuses the pure-idle macro API under its existing error contract and formal reload gate", () => {
    const source = pureIdleSource();
    const sourceDigest = stateDigest(source);
    const session = createPureIdleMacroSession(structuredClone(source), "extreme");

    advancePureIdleMacroSession(session, 30);
    const summary = advancePureIdleMacroSession(session, 60);
    const settledDigest = stateDigest(session.candidate);
    const duplicate = advancePureIdleMacroSession(session, 60);
    const exact = persistedState(advanceSimulationBudget(
      structuredClone(source),
      summary.settledSimulationSeconds,
      summary.settledWallSeconds,
    ));

    expect(summary).toMatchObject({
      settledWallSeconds: 60,
      settledSimulationSeconds: 300,
      requestedMultiplier: 5,
      actualMultiplier: 5,
    });
    expect(summary.degradedReason).toBeUndefined();
    expect(duplicate.settledSimulationSeconds).toBe(summary.settledSimulationSeconds);
    expect(stateDigest(session.candidate)).toEqual(settledDigest);
    expect(validatePureIdleResourceAccounting(source, session.candidate)).toBeNull();
    expect(collectNonFiniteNumbers(session.candidate)).toEqual([]);
    expect(collectMaterialQuantityViolations(session.candidate)).toEqual([]);
    expect(maximumDeltaError(
      criticalSnapshot(source),
      criticalSnapshot(session.candidate),
      criticalSnapshot(exact),
    )).toBeLessThanOrEqual(EXISTING_TIME_WARP_CRITICAL_ERROR_LIMIT);
    expect(relativeDeltaError(
      source.totalProduced.iron_ore ?? 0,
      session.candidate.totalProduced.iron_ore ?? 0,
      exact.totalProduced.iron_ore ?? 0,
    )).toBeLessThanOrEqual(EXISTING_PURE_IDLE_RESOURCE_ERROR_LIMIT);
    expect(stateDigest(source)).toEqual(sourceDigest);

    const finalized = finalizePureIdleMacroSession(session, 60, createContentPackRegistry());
    expect(finalized.rawBytes).toBeGreaterThan(0);
    expect(finalized.state.mode).toBe("normal");
    expect(finalized.state.speedrun).toBeUndefined();
    expect(finalized.state.timeWarp.enabled).toBe(false);
    expect(finalized.state.timeWarp.pendingSimulationSeconds).toBe(0);
    expect(finalized.state.timeWarp.pendingWallSeconds).toBe(0);
    expect(validatePureIdleResourceAccounting(source, finalized.state)).toBeNull();
    expect(collectNonFiniteNumbers(finalized.state)).toEqual([]);
    expect(collectMaterialQuantityViolations(finalized.state)).toEqual([]);
  }, 30_000);
});
