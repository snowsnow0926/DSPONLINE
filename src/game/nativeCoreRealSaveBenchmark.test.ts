import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { afterAll, describe, expect, it } from "vitest";
import { buildChunkedSaveJournal } from "./chunkedSaveJournal";
import { createContentPackRegistry, createContentPackRuntimeSnapshot } from "./contentPacks";
import { createNativeCoreCatalog } from "./nativeCoreCatalog";
import { advanceSimulationBudget } from "./engine";
import { migrateGame } from "./storage";
import type { GameState } from "./types";

const runBenchmark = process.env.DSP_RUN_NATIVE_CORE_BENCHMARK === "1";
const fixturePath = process.env.DSP_NATIVE_CORE_FIXTURE ||
  "C:\\Users\\WINDOWS\\Downloads\\dsp-idle-save-2026-08-24 (1).json\\dsp-idle-save-2026-08-24 (1).json";
const require = createRequire(import.meta.url);
const { NativeHostClient, NativeSaveSessionRegistry } = require("../../desktop/native-host.cjs") as {
  NativeHostClient: new (options: { binaryPath: string; rootPath: string; requestTimeoutMs: number }) => {
    child?: { pid?: number };
    stderrTail?: string;
    start(version: string): Promise<{ capabilities: string[] }>;
    request(request: Record<string, unknown>): Promise<any>;
    stop(): Promise<void>;
  };
  NativeSaveSessionRegistry: new (client: any) => {
    begin(owner: number, request: Record<string, unknown>): Promise<{ transactionId: string }>;
    write(owner: number, transactionId: string, records: Array<{ key: string; value: string | null }>): Promise<void>;
    commit(owner: number, transactionId: string): Promise<any>;
  };
};

interface Envelope {
  formatVersion: number;
  mode: "normal" | "speedrun";
  checksum: string;
  state: GameState;
}

function stableCanonicalSha256(value: unknown): string {
  value = JSON.parse(JSON.stringify(value));
  const crypto = require("node:crypto") as typeof import("node:crypto");
  const hash = crypto.createHash("sha256");
  const visit = (current: unknown) => {
    if (current === null || typeof current !== "object") {
      hash.update(JSON.stringify(current));
      return;
    }
    if (Array.isArray(current)) {
      hash.update("[");
      current.forEach((entry, index) => {
        if (index > 0) hash.update(",");
        visit(entry);
      });
      hash.update("]");
      return;
    }
    hash.update("{");
    const record = current as Record<string, unknown>;
    Object.keys(record).sort().forEach((key, index) => {
      if (index > 0) hash.update(",");
      hash.update(JSON.stringify(key));
      hash.update(":");
      visit(record[key]);
    });
    hash.update("}");
  };
  visit(value);
  return hash.digest("hex");
}

function privateBytes(pid: number | undefined): number | null {
  if (!Number.isSafeInteger(pid) || !pid) return null;
  try {
    const output = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${pid}).PrivateMemorySize64`], { encoding: "utf8" }).trim();
    const value = Number(output);
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

function firstDifferences(left: unknown, right: unknown, limit = 40): Array<{ path: string; native: unknown; js: unknown }> {
  const differences: Array<{ path: string; native: unknown; js: unknown }> = [];
  const visit = (native: unknown, js: unknown, path: string) => {
    if (differences.length >= limit) return;
    if (Object.is(native, js)) return;
    if (native === null || js === null || typeof native !== "object" || typeof js !== "object") {
      differences.push({ path, native, js });
      return;
    }
    if (Array.isArray(native) || Array.isArray(js)) {
      if (!Array.isArray(native) || !Array.isArray(js)) {
        differences.push({ path, native, js });
        return;
      }
      if (native.length !== js.length) differences.push({ path: `${path}.length`, native: native.length, js: js.length });
      for (let index = 0; index < Math.min(native.length, js.length) && differences.length < limit; index += 1) {
        visit(native[index], js[index], `${path}[${index}]`);
      }
      return;
    }
    const nativeRecord = native as Record<string, unknown>;
    const jsRecord = js as Record<string, unknown>;
    for (const key of [...new Set([...Object.keys(nativeRecord), ...Object.keys(jsRecord)])].sort()) {
      visit(nativeRecord[key], jsRecord[key], path ? `${path}.${key}` : key);
      if (differences.length >= limit) break;
    }
  };
  visit(JSON.parse(JSON.stringify(left)), JSON.parse(JSON.stringify(right)), "");
  return differences;
}

describe.skipIf(!runBenchmark)("real-save Windows native core benchmark", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsp-native-core-benchmark-"));
  const binaryPath = path.resolve("native", "target", "release", process.platform === "win32" ? "dsp-native-host.exe" : "dsp-native-host");
  const client = new NativeHostClient({ binaryPath, rootPath: root, requestTimeoutMs: 300_000 });
  afterAll(async () => {
    await client.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("loads the 80k entity / 155k belt fixture with exact v47 hash and bounded native memory", { timeout: 300_000 }, async () => {
    expect(fs.existsSync(fixturePath)).toBe(true);
    expect(fs.existsSync(binaryPath)).toBe(true);
    const sourceBytes = fs.statSync(fixturePath).size;
    const envelope = JSON.parse(fs.readFileSync(fixturePath, "utf8")) as Envelope;
    expect(envelope.formatVersion).toBe(2);
    expect(envelope.state.version).toBe(47);
    const registry = createContentPackRegistry();
    const state = migrateGame(envelope.state, registry);
    expect(state).not.toBeNull();
    // Match the exact representation persisted by the browser save path:
    // JSON serialization removes migration-only `undefined` properties.
    const migratedState = JSON.parse(JSON.stringify(state!)) as GameState;
    const runtime = createContentPackRuntimeSnapshot(registry);
    const journal = buildChunkedSaveJournal(migratedState, {
      mode: envelope.mode,
      basePrimaryChecksum: envelope.checksum,
      savedAt: 1,
      retainAllChunks: true,
    });
    const prefix = `dsp-idle-network.internal.v1.chunked.v1.${envelope.mode}.`;
    const records = [
      ...[...journal.chunks.entries()].map(([id, value]) => ({ key: `${prefix}chunk.${encodeURIComponent(id)}`, value })),
      { key: `${prefix}manifest`, value: JSON.stringify(journal.manifest) },
    ];
    const hello = await client.start("native-core-benchmark");
    expect(hello.capabilities).toContain("native-core-shadow-v1");
    const saves = new NativeSaveSessionRegistry(client);
    const transaction = await saves.begin(1, {
      slot: envelope.mode === "speedrun" ? "speedrun-main" : "normal-main",
      mode: envelope.mode,
      stateVersion: 47,
      baseChecksum: envelope.checksum,
      registryFingerprint: runtime.fingerprint,
      revision: 1,
      savedAtMs: 1,
    });
    // Runtime-migrated v47 saves can contain a few very large logical chunks.
    // Keep every control frame independently below the native host's fixed
    // 8 MiB IPC budget instead of assuming that eight chunks always fit.
    for (const record of records) {
      await saves.write(1, transaction.transactionId, [record]);
    }
    const commit = await saves.commit(1, transaction.transactionId);
    const beforePrivateBytes = privateBytes(client.child?.pid);
    const openStartedAt = performance.now();
    const opened = await client.request({
      operation: "coreOpen",
      slot: envelope.mode === "speedrun" ? "speedrun-main" : "normal-main",
      generation: commit.generation,
      rootHash: commit.rootHash,
      revision: commit.revision,
      registryFingerprint: runtime.fingerprint,
      catalog: createNativeCoreCatalog(runtime),
    });
    const openDurationMs = performance.now() - openStartedAt;
    const afterPrivateBytes = privateBytes(client.child?.pid);
    const sourceSha256 = stableCanonicalSha256(migratedState);
    const { entities: sourceEntities, belts: sourceBelts, ...sourceBase } = migratedState;
    const sourceComponents = {
      base: stableCanonicalSha256(sourceBase),
      entities: stableCanonicalSha256(sourceEntities),
      belts: stableCanonicalSha256(sourceBelts),
    };
    expect(opened.summary.entityCount).toBe(migratedState.entities.length);
    expect(opened.summary.beltCount).toBe(migratedState.belts.length);
    expect(opened.summary.coverage.authorityEligible).toBe(false);
    expect(opened.summary.memory.estimatedRuntimeBytes).toBeLessThan(sourceBytes * 3);
    console.log(JSON.stringify({
      fixture: { sourceBytes, entities: migratedState.entities.length, belts: migratedState.belts.length },
      nativeCore: {
        openDurationMs: Number(openDurationMs.toFixed(2)),
        canonicalSha256: opened.summary.canonicalSha256,
        sourceSha256,
        canonicalComponents: opened.summary.canonicalComponents,
        sourceComponents,
        exactRoundTrip: opened.summary.canonicalSha256 === sourceSha256,
        estimatedRuntimeBytes: opened.summary.memory.estimatedRuntimeBytes,
        rawRecordBytes: opened.summary.memory.rawRecordBytes,
        processPrivateBytesBeforeOpen: beforePrivateBytes,
        processPrivateBytesAfterOpen: afterPrivateBytes,
        processPrivateBytesDelta: beforePrivateBytes !== null && afterPrivateBytes !== null ? afterPrivateBytes - beforePrivateBytes : null,
      },
    }, null, 2));
    expect(opened.summary.canonicalComponents).toEqual(sourceComponents);
    expect(opened.summary.canonicalSha256).toBe(sourceSha256);
    const resumed = await client.request({
      operation: "coreApplyCommand",
      sessionId: opened.sessionId,
      command: {
        protocolVersion: 1,
        baseRevision: commit.revision,
        topLevelChanges: [{ path: ["paused"], operation: "set", value: false }],
        changedEntities: [], addedEntities: [], removedEntityIds: [],
        changedBelts: [], addedBelts: [], removedBeltIds: [],
      },
    });
    const admission = await client.request({
      operation: "coreAdvance",
      sessionId: opened.sessionId,
      request: { baseRevision: resumed.revision, simulationSeconds: 1, wallSeconds: 1 },
    });
    console.log(JSON.stringify({
      nativeCoreAdmission: {
        supported: admission.supported,
        exactScope: admission.exactScope,
        reason: admission.reason ?? null,
      },
    }, null, 2));
    if (admission.supported) {
      const expectedInitial = structuredClone(migratedState);
      expectedInitial.paused = false;
      const expected = advanceSimulationBudget(expectedInitial, 1, 1);
      const expectedFields = Object.fromEntries(Object.entries(JSON.parse(JSON.stringify(expected)) as Record<string, unknown>)
        .map(([key, value]) => [key, stableCanonicalSha256(value)]));
      const fieldMismatches = Object.keys(expectedFields).filter((key) =>
        admission.summary.canonicalFields?.[key] !== expectedFields[key]);
      console.log(JSON.stringify({
        nativeCoreExactRealSaveAdvance: {
          exactState: admission.summary.canonicalSha256 === stableCanonicalSha256(expected),
          fieldMismatches,
        },
      }, null, 2));
      expect(admission.summary.canonicalFields).toEqual(expectedFields);
      expect(admission.summary.canonicalSha256).toBe(stableCanonicalSha256(expected));
    }
    if (!admission.supported && String(admission.reason ?? "").startsWith("construction-")) {
      const constructionMasked = await client.request({
        operation: "coreApplyCommand",
        sessionId: opened.sessionId,
        command: {
          protocolVersion: 1,
          baseRevision: resumed.revision,
          topLevelChanges: [{
            path: ["constructionAutomation"],
            operation: "set",
            value: {
              ...migratedState.constructionAutomation,
              enabled: false,
              targetStock: {},
              jobs: {},
            },
          }],
          changedEntities: [], addedEntities: [], removedEntityIds: [],
          changedBelts: [], addedBelts: [], removedBeltIds: [],
        },
      });
      let reportedProfile = "";
      const profileTimer = setInterval(() => {
        const current = client.stderrTail?.trim() ?? "";
        if (current && current !== reportedProfile) {
          reportedProfile = current;
          console.log(current);
        }
      }, 5_000);
      const nextDomain = await client.request({
        operation: "coreAdvance",
        sessionId: opened.sessionId,
        request: { baseRevision: constructionMasked.revision, simulationSeconds: 1, wallSeconds: 1 },
      }).finally(() => clearInterval(profileTimer));
      const expectedDiagnosticInitial = structuredClone(migratedState);
      expectedDiagnosticInitial.paused = false;
      expectedDiagnosticInitial.constructionAutomation = {
        ...expectedDiagnosticInitial.constructionAutomation,
        enabled: false,
        targetStock: {},
        jobs: {},
      };
      const expectedDiagnostic = advanceSimulationBudget(expectedDiagnosticInitial, 1, 1);
      const expectedDiagnosticFields = Object.fromEntries(Object.entries(JSON.parse(JSON.stringify(expectedDiagnostic)) as Record<string, unknown>)
        .map(([key, value]) => [key, stableCanonicalSha256(value)]));
      const fieldMismatches = Object.keys(expectedDiagnosticFields).filter((key) =>
        nextDomain.summary.canonicalFields?.[key] !== expectedDiagnosticFields[key]);
      const baseProjection = await client.request({
        operation: "coreProjection",
        sessionId: opened.sessionId,
        entityIds: [], beltIds: [],
        baseFields: ["constructionAutomation", "productionHistory", "endgame", "dysonSwarm", "planetMetrics"],
      });
      const detailDifferences = firstDifferences(baseProjection.base, {
        constructionAutomation: expectedDiagnostic.constructionAutomation,
        productionHistory: expectedDiagnostic.productionHistory,
        endgame: expectedDiagnostic.endgame,
        dysonSwarm: expectedDiagnostic.dysonSwarm,
        planetMetrics: expectedDiagnostic.planetMetrics,
      });
      const entityDifferences: ReturnType<typeof firstDifferences> = [];
      for (let offset = 0; offset < expectedDiagnostic.entities.length && entityDifferences.length < 40; offset += 32) {
        const expectedEntities = expectedDiagnostic.entities.slice(offset, offset + 32);
        const projection = await client.request({
          operation: "coreProjection",
          sessionId: opened.sessionId,
          entityIds: expectedEntities.map((entity) => entity.id),
          beltIds: [], baseFields: [],
        });
        entityDifferences.push(...firstDifferences(projection.entities, expectedEntities, 40 - entityDifferences.length)
          .map((difference) => ({ ...difference, path: `entities[${offset}]${difference.path ? `.${difference.path}` : ""}` })));
      }
      console.log(JSON.stringify({
        nativeCoreDiagnosticAfterConstructionMask: {
          supported: nextDomain.supported,
          exactScope: nextDomain.exactScope,
          reason: nextDomain.reason ?? null,
          exactState: nextDomain.summary.canonicalSha256 === stableCanonicalSha256(expectedDiagnostic),
          fieldMismatches,
          detailDifferences,
          entityDifferences,
        },
      }, null, 2));
      expect(nextDomain.summary.canonicalFields).toEqual(expectedDiagnosticFields);
      expect(nextDomain.summary.canonicalSha256).toBe(stableCanonicalSha256(expectedDiagnostic));
      if (client.stderrTail?.trim()) console.log(client.stderrTail.trim());
    }
    await client.request({ operation: "coreClose", sessionId: opened.sessionId });
  });
});
