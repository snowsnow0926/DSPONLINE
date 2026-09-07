import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  catalog, runtime, createPublicCatalogOfflineQualificationFixture,
  type PublicCatalogOfflineVariant,
} from "../../tests/fixtures/rust-offline-performance";
import { buildChunkedSaveJournal } from "./chunkedSaveJournal";
import { advanceSimulationBudget } from "./engine";
import { canonicalNativeCoreSha256 } from "./nativeCoreProof";
import type { GameState } from "./types";

const require = createRequire(import.meta.url);
const { NativeHostClient, NativeSaveSessionRegistry } = require("../../desktop/native-host.cjs");
const binaryPath = path.resolve(process.env.DSP_NATIVE_CORE_HOST_BINARY ??
  path.join("native", "target", "release", process.platform === "win32" ? "dsp-native-host.exe" : "dsp-native-host"));
const longTests = process.env.DSP_RUN_NATIVE_CORE_LONG_DIFFERENTIAL === "1";
const benchmarkTests = process.env.DSP_RUN_NATIVE_OFFLINE_PARITY_BENCHMARK === "1";
const reportDirectory = process.env.DSP_NATIVE_PUBLIC_CATALOG_REPORT_DIR;
const writePublicStates = process.env.DSP_NATIVE_PUBLIC_CATALOG_WRITE_STATES === "1";
const expectedHostSha256 = process.env.DSP_NATIVE_PUBLIC_CATALOG_EXPECTED_HOST_SHA256;
const variants: PublicCatalogOfflineVariant[] = ["infinite", "finite-reserve", "quantum-capacity"];
const materialIds = ["iron_ore", "iron_ingot"] as const;
const progressionFields = ["endgame", "research", "campaign", "achievements", "construction", "orbitalStation"] as const;
const readBytes = fs.readFileSync as unknown as (file: string) => Uint8Array;

interface PublicValueDifference {
  path: string;
  nativePresent: boolean;
  javascriptPresent: boolean;
  native: unknown;
  javascript: unknown;
}

/** Lossless leaf locations for these public fixtures, including missing keys. */
function differingPublicValues(native: unknown, javascript: unknown, location: string): PublicValueDifference[] {
  if (Object.is(native, javascript)) return [];
  if ((native !== null && typeof native === "object") ||
    (javascript !== null && typeof javascript === "object")) {
    const nativeRecord = native !== null && typeof native === "object" ? native as Record<string, unknown> : {};
    const jsRecord = javascript !== null && typeof javascript === "object" ? javascript as Record<string, unknown> : {};
    const keys = [...new Set([...Object.keys(nativeRecord), ...Object.keys(jsRecord)])].sort();
    const differences = keys.flatMap(key => differingPublicValues(
      nativeRecord[key], jsRecord[key], `${location}[${JSON.stringify(key)}]`));
    if (differences.length || (native !== null && javascript !== null &&
      typeof native === "object" && typeof javascript === "object" && Array.isArray(native) === Array.isArray(javascript))) {
      return differences;
    }
  }
  return [{ path: location, nativePresent: native !== undefined, javascriptPresent: javascript !== undefined,
    native: native ?? null, javascript: javascript ?? null }];
}

/** This oracle is deliberately limited to the isolated, public 1:1 iron chain. */
function materialLedger(state: GameState) {
  const owned = { iron_ore: 0, iron_ingot: 0 };
  const add = (store: unknown) => {
    for (const id of materialIds) {
      const value = Number((store as Record<string, unknown> | undefined)?.[id] ?? 0);
      expect(Number.isSafeInteger(value) && value >= 0, `owned ${id}`).toBe(true);
      owned[id] += value;
    }
  };
  add(state.tray);
  for (const [planetId, tray] of Object.entries(state.planetTrays)) {
    if (planetId !== state.activePlanetId) add(tray);
  }
  add(state.quantumLogisticsNetwork.inventory);
  add(state.construction);
  for (const entity of state.entities) { add(entity.inputs); add(entity.outputs); }
  return {
    owned,
    produced: Object.fromEntries(materialIds.map(id => [id, state.totalProduced[id] ?? 0])) as typeof owned,
    reserve: state.entities.filter(entity => entity.kind === "vein" && (entity.minerCount ?? 0) > 0)
      .map(entity => ({ id: entity.id, remaining: entity.resourceRemaining, remainder: entity.resourceDepletionRemainder })),
  };
}

function expectClosedIronChain(before: ReturnType<typeof materialLedger>, after: ReturnType<typeof materialLedger>) {
  const mined = after.produced.iron_ore - before.produced.iron_ore;
  const smelted = after.produced.iron_ingot - before.produced.iron_ingot;
  expect(after.owned.iron_ingot - before.owned.iron_ingot).toBe(smelted);
  expect(after.owned.iron_ore - before.owned.iron_ore).toBe(mined - smelted);
}

function differingProgressionValues(native: unknown, javascript: unknown, field: string): unknown[] {
  if (Object.is(native, javascript)) return [];
  if (native && javascript && typeof native === "object" && typeof javascript === "object") {
    const nativeRecord = native as Record<string, unknown>;
    const jsRecord = javascript as Record<string, unknown>;
    return [...new Set([...Object.keys(nativeRecord), ...Object.keys(jsRecord)])].flatMap(key =>
      differingProgressionValues(nativeRecord[key], jsRecord[key], `${field}.${key}`));
  }
  return [{ field, native: native ?? null, javascript: javascript ?? null }];
}

describe.skipIf(!fs.existsSync(binaryPath))("public-catalog native offline qualification (shadow only)", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsp-native-public-offline-"));
  const client = new NativeHostClient({ binaryPath, rootPath: root,
    requestTimeoutMs: longTests || benchmarkTests ? 300_000 : 60_000 });
  let saves: InstanceType<typeof NativeSaveSessionRegistry>;
  let exportSequence = 0;

  beforeAll(async () => {
    if (expectedHostSha256) {
      expect(createHash("sha256").update(readBytes(binaryPath)).digest("hex")).toBe(expectedHostSha256);
    }
    await client.start("public-catalog-offline-qualification");
    saves = new NativeSaveSessionRegistry(client);
    // These are the real public costs and capacities, not the earlier
    // custom Rust unit catalog's zero-power station/smelter definitions.
    expect(catalog.buildings.find(building => building.id === "arc_smelter")?.powerDemandKw).toBe(360);
    expect(catalog.buildings.find(building => building.id === "interstellar_logistics_station")?.powerDemandKw).toBe(1200);
    expect(catalog.buildings.find(building => building.id === "mining_machine")?.powerDemandKw).toBe(420);
    expect(catalog.buildings.find(building => building.id === "wind_turbine")?.powerGenerationKw).toBe(300);
    expect(catalog.recipes.find(recipe => recipe.id === "iron_ingot")?.inputs).toEqual([{ itemId: "iron_ore", amount: 1 }]);
    expect(catalog.recipes.find(recipe => recipe.id === "iron_ingot")?.outputs).toEqual([{ itemId: "iron_ingot", amount: 1 }]);
  });

  afterAll(async () => {
    await client.stop();
    const resolvedRoot = path.resolve(root);
    if (path.dirname(resolvedRoot) !== path.resolve(os.tmpdir()) ||
      !path.basename(resolvedRoot).startsWith("dsp-native-public-offline-")) {
      throw new Error("Refusing to remove a directory outside this test's temporary profile");
    }
    fs.rmSync(resolvedRoot, { recursive: true, force: true });
    if (expectedHostSha256) {
      expect(createHash("sha256").update(readBytes(binaryPath)).digest("hex")).toBe(expectedHostSha256);
    }
  });

  async function seed(state: GameState) {
    const journal = buildChunkedSaveJournal(state, {
      mode: "normal", basePrimaryChecksum: "01234567", savedAt: 1, retainAllChunks: true,
    });
    const prefix = "dsp-idle-network.internal.v1.chunked.v1.normal.";
    const records = [
      ...[...journal.chunks].map(([id, value]) => ({ key: `${prefix}chunk.${encodeURIComponent(id)}`, value })),
      { key: `${prefix}manifest`, value: JSON.stringify(journal.manifest) },
    ];
    const transaction = await saves.begin(1, {
      slot: "normal-main", mode: "normal", stateVersion: 47, baseChecksum: "01234567",
      registryFingerprint: runtime.fingerprint, revision: 1, savedAtMs: 1,
    });
    for (let index = 0; index < records.length; index += 8) {
      await saves.write(1, transaction.transactionId, records.slice(index, index + 8));
    }
    return saves.commit(1, transaction.transactionId);
  }

  async function advance(state: GameState, checkpoint: any, seconds: number,
    advanceMode: "exact" | "offline-macro-v1", continuationSeconds = 0) {
    const started = performance.now();
    const opened = await client.request({
      operation: "coreOpen", slot: "normal-main", generation: checkpoint.generation,
      rootHash: checkpoint.rootHash, revision: 1, registryFingerprint: runtime.fingerprint, catalog,
    });
    const timings = { sessionOpenMs: performance.now() - started, sourceProofMs: 0,
      advanceRequestMs: 0, projectionReadMs: 0, publicExportRequestMs: 0, publicExportReadVerifyMs: 0,
      sessionCloseMs: 0, sessionRoundTripMs: 0 };
    try {
      const sourceProofStarted = performance.now();
      expect(opened.summary.canonicalSha256).toBe(canonicalNativeCoreSha256(state));
      timings.sourceProofMs = performance.now() - sourceProofStarted;
      const advanceStarted = performance.now();
      const result = await client.request({
        operation: "coreAdvance", sessionId: opened.sessionId,
        request: { baseRevision: 1, simulationSeconds: seconds, wallSeconds: seconds, advanceMode },
      });
      timings.advanceRequestMs = performance.now() - advanceStarted;
      expect(result.supported, result.reason).toBe(true);
      const projectionStarted = performance.now();
      const projected: Record<string, unknown> = { entities: [], belts: [] };
      const fields = Object.keys(state).filter(field => !["entities", "belts"].includes(field));
      for (let index = 0; index < fields.length; index += 64) {
        const page = await client.request({ operation: "coreProjection", sessionId: opened.sessionId,
          baseFields: fields.slice(index, index + 64), entityIds: [], beltIds: [] });
        Object.assign(projected, page.base);
      }
      for (let index = 0; index < state.entities.length; index += 32) {
        const page = await client.request({ operation: "coreProjection", sessionId: opened.sessionId,
          baseFields: [], entityIds: state.entities.slice(index, index + 32).map(entity => entity.id), beltIds: [] });
        (projected.entities as unknown[]).push(...page.entities);
      }
      const page = await client.request({ operation: "coreProjection", sessionId: opened.sessionId,
        baseFields: [], entityIds: [], beltIds: state.belts.map(belt => belt.id) });
      projected.belts = page.belts;
      timings.projectionReadMs = performance.now() - projectionStarted;
      // Renderer projections intentionally omit stationRoutes. Read the real
      // public export for a complete diff instead of inventing empty routes
      // or reporting omitted projection fields as gameplay mismatches.
      const exportId = `public-diagnostic-${++exportSequence}`;
      const exportStarted = performance.now();
      const exported = await client.request({ operation: "coreExportV47", sessionId: opened.sessionId,
        exportId, savedAtMs: 1 + seconds * 1000 });
      timings.publicExportRequestMs = performance.now() - exportStarted;
      const readStarted = performance.now();
      const exportedBytes = readBytes(path.join(root, "exports", `${exportId}.json`));
      const envelope = JSON.parse(new TextDecoder().decode(exportedBytes)) as { state: GameState };
      expect(createHash("sha256").update(exportedBytes).digest("hex")).toBe(exported.result.envelopeSha256);
      expect(canonicalNativeCoreSha256(envelope.state)).toBe(result.summary.canonicalSha256);
      timings.publicExportReadVerifyMs = performance.now() - readStarted;
      let continuationSha256: string | null = null;
      if (continuationSeconds > 0) {
        const continued = await client.request({ operation: "coreAdvance", sessionId: opened.sessionId,
          request: { baseRevision: result.summary.revision, simulationSeconds: continuationSeconds,
            wallSeconds: continuationSeconds, advanceMode: "exact" } });
        expect(continued.supported, continued.reason).toBe(true);
        continuationSha256 = continued.summary.canonicalSha256;
      }
      return { result, state: envelope.state, timings, continuationSha256 };
    } finally {
      const closeStarted = performance.now();
      await client.request({ operation: "coreClose", sessionId: opened.sessionId });
      timings.sessionCloseMs = performance.now() - closeStarted;
      timings.sessionRoundTripMs = performance.now() - started;
    }
  }

  async function qualify(variant: PublicCatalogOfflineVariant, seconds: number, options: {
    name?: string; phase?: number; warmupSeconds?: number; emptyHistory?: boolean;
    nativeOrder?: "macro-first" | "exact-first"; verifyContinuation?: boolean;
  } = {}) {
    const fixtureStarted = performance.now();
    let initial = createPublicCatalogOfflineQualificationFixture(variant);
    for (let step = 0; step < (options.warmupSeconds ?? 0); step += 1) {
      initial = advanceSimulationBudget(initial, 1, 1);
    }
    if (options.emptyHistory) initial.productionHistory = [];
    if (options.phase) {
      const shift = (value: number) => Math.round((value + options.phase!) * 10_000) / 10_000;
      initial.elapsedSeconds = shift(initial.elapsedSeconds);
      initial.historyRecordedAt = shift(initial.historyRecordedAt);
      initial.productionHistory = initial.productionHistory.map(sample => ({ ...sample,
        elapsedSeconds: shift(sample.elapsedSeconds) }));
    }
    const reportName = `${variant}-${seconds}${options.name ? `-${options.name}` : ""}`;
    const fixtureBuildMs = performance.now() - fixtureStarted;
    expect(initial.handcraftQueue).toHaveLength(0);
    expect(initial.constructionQueue).toHaveLength(0);
    expect(initial.constructionAutomation.enabled).toBe(false);
    expect(initial.constructionAutomation.jobs).toEqual({});
    expect(initial.entities.every(entity => (entity.stationRoutes?.length ?? 0) === 0)).toBe(true);
    const initialHash = canonicalNativeCoreSha256(initial);
    const before = materialLedger(initial);
    const seedStarted = performance.now();
    const checkpoint = await seed(initial);
    const seedCheckpointMs = performance.now() - seedStarted;
    const directExact = seconds <= 601;
    const earlyExact = directExact && options.nativeOrder === "exact-first"
      ? await advance(initial, checkpoint, seconds, "exact") : null;
    const macro = await advance(initial, checkpoint, seconds, "offline-macro-v1", options.verifyContinuation ? 11 : 0);
    let expected = initial;
    const jsStarted = performance.now();
    for (let second = 0; second < seconds; second += 1) expected = advanceSimulationBudget(expected, 1, 1);
    const javascriptExactAdvanceMs = performance.now() - jsStarted;
    const expectedHash = canonicalNativeCoreSha256(expected);
    const expectedLedger = materialLedger(expected);
    const macroLedger = materialLedger(macro.state);
    expectClosedIronChain(before, expectedLedger);
    expectClosedIronChain(before, macroLedger);
    const exact = earlyExact ?? (directExact ? await advance(initial, checkpoint, seconds, "exact") : null);
    expect(canonicalNativeCoreSha256(initial)).toBe(initialHash);
    const publicExpected = JSON.parse(JSON.stringify(expected)) as Record<string, unknown>;
    const differingFields = Object.keys(publicExpected).filter(field =>
      canonicalNativeCoreSha256(publicExpected[field]) !== macro.result.summary.canonicalFields[field]);
    const publicNative = JSON.parse(JSON.stringify(macro.state)) as Record<string, unknown>;
    const valueDifferences = Object.fromEntries(differingFields.map(field => [field,
      differingPublicValues(publicNative[field], publicExpected[field], field)]));
    const materialMatch = JSON.stringify(macroLedger) === JSON.stringify(expectedLedger);
    const report = {
      scope: "public-catalog-shadow-qualification-not-player-speedup", variant, seconds,
      scenario: options.name ?? "baseline-public", sourcePhase: options.phase ?? 0,
      nativeOrder: options.nativeOrder ?? "macro-first",
      inputSha256: initialHash,
      hostSha256: createHash("sha256").update(readBytes(binaryPath)).digest("hex"),
      catalogSha256: canonicalNativeCoreSha256(catalog),
      before, javascriptExact: expectedLedger, nativeMacro: macroLedger,
      timingScope: "diagnostic RPC timings; excludes app startup, player UI, save adoption and packaging; no speedup claim",
      timings: { fixtureBuildMs, seedCheckpointMs, nativeMacro: macro.timings,
        nativeExact: exact?.timings ?? null, javascriptExactAdvanceMs },
      macroReason: macro.result.reason,
      macroExecution: {
        algorithmVersion: macro.result.algorithmVersion ?? null,
        exactScope: macro.result.exactScope,
        exactCalibrationSeconds: macro.result.exactCalibrationSeconds ?? null,
        approximatedSeconds: macro.result.approximatedSeconds ?? null,
        classification: macro.result.approximatedSeconds === 0 && macro.result.exactCalibrationSeconds === seconds
          ? "EXACT_ONLY_NO_MACRO_SPEEDUP_CLAIM"
          : (macro.result.approximatedSeconds > 0 ? "MIXED_EXACT_AND_APPROXIMATION" : "UNCLASSIFIED"),
      },
      nativeExactCanonicalMatch: exact ? exact.result.summary.canonicalSha256 === expectedHash : "NOT_RUN_long_exact_budget",
      materialMatch, fullStateMatch: macro.result.summary.canonicalSha256 === expectedHash, differingFields,
      differenceCounts: Object.fromEntries(Object.entries(valueDifferences).map(([field, differences]) => [field, differences.length])),
      valueDifferences,
      materialParity: materialMatch ? "PASS" : "FAIL_MATERIAL_DIFFERENCE_REQUIRES_FOLLOW_UP",
      fullStateParity: macro.result.summary.canonicalSha256 === expectedHash ? "PASS" : "FAIL_NOT_QUALIFIED",
      progressionDifferences: progressionFields
        .flatMap(field => differingProgressionValues(
          (macro.state as unknown as Record<string, unknown>)[field], publicExpected[field], field)),
      automaticAdoption: "NOT_QUALIFIED_30_SECOND_GUARD_UNCHANGED",
    };
    if (reportDirectory) {
      fs.mkdirSync(reportDirectory, { recursive: true });
      fs.writeFileSync(path.join(reportDirectory, `${reportName}.json`), JSON.stringify(report, null, 2), { flag: "wx" });
      if (writePublicStates) {
        for (const [label, value] of [["input", initial], ["native-macro", macro.state],
          ["javascript-exact", expected], ["native-exact", exact?.state]] as const) {
          if (value) fs.writeFileSync(path.join(reportDirectory, `${reportName}.${label}.json`),
            JSON.stringify(value), { flag: "wx" });
        }
      }
    }
    // Write public diagnostic evidence before differential assertions, so a
    // regression remains inspectable instead of disappearing with a red test.
    if (exact) expect(exact.result.summary.canonicalSha256).toBe(expectedHash);
    expect(macroLedger, `${variant} ${seconds}s complete material parity`).toEqual(expectedLedger);
    for (const field of progressionFields) {
      expect(publicNative[field], `${variant} ${seconds}s ${field} parity`).toEqual(publicExpected[field]);
    }
    expect(macro.result.summary.canonicalSha256, `${reportName} complete state parity`).toBe(expectedHash);
    expect(macro.result.algorithmVersion).toContain("v3-state-parity");
    if (variant === "finite-reserve") {
      const mined = macroLedger.produced.iron_ore - before.produced.iron_ore;
      expect(before.reserve[0].remaining! - macroLedger.reserve[0].remaining!).toBe(mined);
      expect(macroLedger.reserve[0].remaining).toBeGreaterThanOrEqual(0);
    }
    if (variant === "quantum-capacity") {
      expect(Number(macro.state.quantumLogisticsNetwork.inventory.iron_ingot)).toBeLessThanOrEqual(10000);
    }
    if (options.verifyContinuation) {
      let continuedExpected = expected;
      for (let second = 0; second < 11; second += 1) continuedExpected = advanceSimulationBudget(continuedExpected, 1, 1);
      const continuedHash = canonicalNativeCoreSha256(continuedExpected);
      expect(macro.continuationSha256, "hot Exact continuation after macro").toBe(continuedHash);
      const resumed = await advance(macro.state, await seed(macro.state), 11, "exact");
      expect(resumed.result.summary.canonicalSha256, "checkpoint Exact continuation after macro").toBe(continuedHash);
      if (reportDirectory) fs.writeFileSync(path.join(reportDirectory, `${reportName}.continuation.json`), JSON.stringify({
        seconds: 11, expectedSha256: continuedHash, hotSha256: macro.continuationSha256,
        reopenedCheckpointSha256: resumed.result.summary.canonicalSha256,
      }, null, 2), { flag: "wx" });
    }
  }

  it.each(variants)("matches the public %s chain's complete 10-minute state", async variant => {
    await qualify(variant, 600);
  }, 30_000);

  it.skipIf(!longTests).each(variants)("matches the public %s chain's complete 8-hour state", async variant => {
    await qualify(variant, 8 * 60 * 60);
  }, 360_000);

  it.skipIf(!longTests)("matches the complete fractional-clock public state over 8 hours", async () => {
    await qualify("infinite", 28_800, { name: "phase-0043-long", phase: 0.0043 });
  }, 360_000);

  it.each([
    { name: "phase-0043-tail-remainder", phase: 0.0043, seconds: 601, verifyContinuation: true },
    { name: "phase-quarter-tail-remainder", phase: 0.25, seconds: 599 },
    { name: "phase-near-second", phase: 0.9999, seconds: 571 },
    { name: "empty-history", emptyHistory: true, seconds: 601 },
    { name: "aged-history", warmupSeconds: 900, seconds: 601 },
  ])("matches the complete public state for $name", async scenario => {
    await qualify("infinite", scenario.seconds, scenario);
  }, 60_000);

  it.skipIf(!benchmarkTests).each([600, 3_600])("measures isolated same-output native performance at %i seconds", async seconds => {
    const initial = createPublicCatalogOfflineQualificationFixture("infinite");
    const inputSha256 = canonicalNativeCoreSha256(initial);
    let expected = initial;
    for (let second = 0; second < seconds; second += 1) expected = advanceSimulationBudget(expected, 1, 1);
    const outputSha256 = canonicalNativeCoreSha256(expected);
    const checkpoint = await seed(initial);
    // Both paths use the same binary/catalog/checkpoint, fresh sessions and
    // identical public output. Keep fixture/JS/export work outside the timer.
    for (const mode of ["exact", "offline-macro-v1"] as const) {
      await advance(initial, checkpoint, 600, mode);
    }
    const samples = [];
    for (let pair = 0; pair < 3; pair += 1) {
      const javascriptStarted = performance.now();
      let javascriptState = initial;
      for (let second = 0; second < seconds; second += 1) javascriptState = advanceSimulationBudget(javascriptState, 1, 1);
      const javascriptAdvanceMs = performance.now() - javascriptStarted;
      expect(canonicalNativeCoreSha256(javascriptState)).toBe(outputSha256);
      const javascriptAdvanceAndProofMs = performance.now() - javascriptStarted;
      const modes = pair % 2 === 0
        ? ["exact", "offline-macro-v1"] as const
        : ["offline-macro-v1", "exact"] as const;
      const values = {} as Record<"exact" | "offline-macro-v1", { advanceRequestMs: number; outputSha256: string }>;
      for (const mode of modes) {
        const result = await advance(initial, checkpoint, seconds, mode);
        expect(result.result.summary.canonicalSha256).toBe(outputSha256);
        if (mode === "offline-macro-v1") expect(result.result.approximatedSeconds).toBe(seconds - 30);
        values[mode] = { advanceRequestMs: result.timings.advanceRequestMs,
          outputSha256: result.result.summary.canonicalSha256 };
      }
      samples.push({ pair: pair + 1, order: ["javascript-exact", ...modes],
        javascriptAdvanceMs, javascriptAdvanceAndProofMs, ...values });
    }
    expect(canonicalNativeCoreSha256(initial)).toBe(inputSha256);
    const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
    const exactMedianMs = median(samples.map(sample => sample.exact.advanceRequestMs));
    const macroMedianMs = median(samples.map(sample => sample["offline-macro-v1"].advanceRequestMs));
    const javascriptMedianMs = median(samples.map(sample => sample.javascriptAdvanceMs));
    const javascriptWithProofMedianMs = median(samples.map(sample => sample.javascriptAdvanceAndProofMs));
    const report = {
      scope: "isolated-public-iron-chain-native-coreAdvance-RPC-only-not-player-wait",
      seconds, inputSha256, outputSha256,
      hostSha256: createHash("sha256").update(readBytes(binaryPath)).digest("hex"),
      catalogSha256: canonicalNativeCoreSha256(catalog),
      exactMedianMs, macroMedianMs, reductionPercent: (1 - macroMedianMs / exactMedianMs) * 100,
      javascriptMedianMs, javascriptWithProofMedianMs,
      macroVersusJavascriptWithProofPercent: (1 - macroMedianMs / javascriptWithProofMedianMs) * 100,
      ratio: exactMedianMs / macroMedianMs, samples,
      javascriptScope: "one-second JS oracle loop with optional canonical proof; not the app's current offline strategy or full UI wait",
      automaticAdoption: "NOT_QUALIFIED_30_SECOND_GUARD_UNCHANGED",
    };
    if (reportDirectory) {
      fs.mkdirSync(reportDirectory, { recursive: true });
      fs.writeFileSync(path.join(reportDirectory, `performance-${seconds}.json`), JSON.stringify(report, null, 2), { flag: "wx" });
    }
  }, 360_000);

  it("rejects cumulative transfer overflow without changing the source", async () => {
    const initial = createPublicCatalogOfflineQualificationFixture("infinite");
    for (const belt of initial.belts) belt.totalTransferred = Number.MAX_SAFE_INTEGER - 50;
    const checkpoint = await seed(initial);
    const opened = await client.request({ operation: "coreOpen", slot: "normal-main",
      generation: checkpoint.generation, rootHash: checkpoint.rootHash, revision: 1,
      registryFingerprint: runtime.fingerprint, catalog });
    try {
      const result = await client.request({ operation: "coreAdvance", sessionId: opened.sessionId,
        request: { baseRevision: 1, simulationSeconds: 600, wallSeconds: 600,
          advanceMode: "offline-macro-v1" } });
      expect(result.supported).toBe(false);
      const current = await client.request({ operation: "coreStatus", sessionId: opened.sessionId });
      expect(current.canonicalSha256).toBe(opened.summary.canonicalSha256);
      expect(current.revision).toBe(opened.summary.revision);
    } finally {
      await client.request({ operation: "coreClose", sessionId: opened.sessionId });
    }
  });

  it("keeps automatic adoption closed beyond 30 seconds despite shadow macro support", async () => {
    const initial = createPublicCatalogOfflineQualificationFixture("infinite");
    const checkpoint = await seed(initial);
    const opened = await client.request({
      operation: "coreOpen", slot: "normal-main", generation: checkpoint.generation,
      rootHash: checkpoint.rootHash, revision: 1, registryFingerprint: runtime.fingerprint, catalog,
    });
    try {
      for (const seconds of [31, 600, 28800]) {
        const candidate = await client.request({ operation: "corePrepareOfflineSettlementExport", sessionId: opened.sessionId,
          request: { expectedGeneration: checkpoint.generation, expectedRootHash: checkpoint.rootHash,
            expectedRevision: 1, expectedRegistryFingerprint: runtime.fingerprint,
            expectedCanonicalSha256: opened.summary.canonicalSha256, expectedDomainSha256: opened.summary.domainSha256,
            observedNowMs: 1 + seconds * 1000, strategy: "macro-v1", exportId: `public-qualification-${seconds}` } });
        expect(candidate.prepared).toBe(false);
        expect(candidate.reason).toContain("exact interval of 1 to 30 seconds");
        expect(candidate.sourceSummary.canonicalSha256).toBe(opened.summary.canonicalSha256);
        expect(candidate.candidateSummary).toBeUndefined();
      }
    } finally {
      await client.request({ operation: "coreClose", sessionId: opened.sessionId });
    }
  });
});
