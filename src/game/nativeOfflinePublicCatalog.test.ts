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
  const client = new NativeHostClient({ binaryPath, rootPath: root, requestTimeoutMs: longTests ? 300_000 : 60_000 });
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

  async function advance(state: GameState, checkpoint: any, seconds: number, advanceMode: "exact" | "offline-macro-v1") {
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
      return { result, state: envelope.state, timings };
    } finally {
      const closeStarted = performance.now();
      await client.request({ operation: "coreClose", sessionId: opened.sessionId });
      timings.sessionCloseMs = performance.now() - closeStarted;
      timings.sessionRoundTripMs = performance.now() - started;
    }
  }

  async function qualify(variant: PublicCatalogOfflineVariant, seconds: number) {
    const fixtureStarted = performance.now();
    const initial = createPublicCatalogOfflineQualificationFixture(variant);
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
    const macro = await advance(initial, checkpoint, seconds, "offline-macro-v1");
    let expected = initial;
    const jsStarted = performance.now();
    for (let second = 0; second < seconds; second += 1) expected = advanceSimulationBudget(expected, 1, 1);
    const javascriptExactAdvanceMs = performance.now() - jsStarted;
    const expectedHash = canonicalNativeCoreSha256(expected);
    const expectedLedger = materialLedger(expected);
    const macroLedger = materialLedger(macro.state);
    expectClosedIronChain(before, expectedLedger);
    expectClosedIronChain(before, macroLedger);
    const exact = seconds === 600 ? await advance(initial, checkpoint, seconds, "exact") : null;
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
      fs.writeFileSync(path.join(reportDirectory, `${variant}-${seconds}.json`), JSON.stringify(report, null, 2), { flag: "wx" });
      if (writePublicStates) {
        for (const [label, value] of [["input", initial], ["native-macro", macro.state],
          ["javascript-exact", expected], ["native-exact", exact?.state]] as const) {
          if (value) fs.writeFileSync(path.join(reportDirectory, `${variant}-${seconds}.${label}.json`),
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
    if (macro.result.approximatedSeconds === 0 && macro.result.exactCalibrationSeconds === seconds) {
      // A full exact fallback must earn the same complete-state requirement
      // as the direct Exact oracle. Calling it through a macro request does
      // not excuse different physical buffers, counters, histories or clocks.
      expect(macro.result.summary.canonicalSha256, `${variant} ${seconds}s full exact fallback parity`).toBe(expectedHash);
    }
    if (variant === "finite-reserve") {
      const mined = macroLedger.produced.iron_ore - before.produced.iron_ore;
      expect(before.reserve[0].remaining! - macroLedger.reserve[0].remaining!).toBe(mined);
      expect(macroLedger.reserve[0].remaining).toBeGreaterThanOrEqual(0);
    }
    if (variant === "quantum-capacity") {
      expect(Number(macro.state.quantumLogisticsNetwork.inventory.iron_ingot)).toBeLessThanOrEqual(10000);
    }
  }

  it.each(variants)("checks conservation and records the public %s chain's 10-minute parity gaps", async variant => {
    await qualify(variant, 600);
  }, 30_000);

  it.skipIf(!longTests).each(variants)("records the public %s chain's 8-hour material and qualification boundary", async variant => {
    await qualify(variant, 8 * 60 * 60);
  }, 360_000);

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
