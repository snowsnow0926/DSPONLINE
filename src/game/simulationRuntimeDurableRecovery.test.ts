import { describe, expect, it } from "vitest";
import { createContentPackRegistry, createContentPackRuntimeSnapshot } from "./contentPacks";
import {
  SIMULATION_RUNTIME_DURABLE_RECOVERY_GZIP_BYTES_PER_HOUR,
  SIMULATION_RUNTIME_DURABLE_RECOVERY_RAW_BYTES_PER_HOUR,
  advanceSimulationRuntimeDurableCheckpointCadence,
  computeSimulationRuntimeDurableBytesSha256,
  computeSimulationRuntimeDurableIntentSha256,
  finalizeSimulationRuntimeDurableRecoveryIntent,
  getSimulationRuntimeDurableCheckpointRecommendation,
  getSimulationRuntimeDurableJournalStats,
  iterateSimulationRuntimeDurablePassiveReplay,
  validateSimulationRuntimeDurableCheckpointCadence,
  validateSimulationRuntimeDurableJournalEntryDigests,
  validateSimulationRuntimeDurableRecoveryRecord,
  type SimulationRuntimeDurableCheckpoint,
  type SimulationRuntimeDurableOperationIntent,
  type SimulationRuntimeDurableRecoveryRecord,
} from "./simulationRuntimeDurableRecovery";

const registry = createContentPackRuntimeSnapshot(createContentPackRegistry());
const baseIdentity = { mode: "normal" as const, savedAt: 1_786_377_600_000, checksum: "state-checksum", revision: 7 };

function primaryCheckpoint(overrides: Partial<SimulationRuntimeDurableCheckpoint> = {}): SimulationRuntimeDurableCheckpoint {
  return {
    schemaVersion: 1,
    sessionId: "durable-session",
    generation: 1,
    lastSequence: 0,
    stateRevision: 0,
    registryFingerprint: registry.fingerprint,
    registry,
    committedAtMs: 1_786_377_600_100,
    baseIdentity,
    source: "primary",
    primaryStateChecksum: baseIdentity.checksum,
    primaryRevision: baseIdentity.revision,
    ...overrides,
  } as SimulationRuntimeDurableCheckpoint;
}

async function intent(
  sequence: number,
  options: { command?: boolean; simulationSeconds?: number; wallSeconds?: number; generation?: number } = {},
): Promise<SimulationRuntimeDurableOperationIntent> {
  const unsigned = {
    schemaVersion: 1 as const,
    sessionId: "durable-session",
    generation: options.generation ?? 1,
    sequence,
    baseStateRevision: sequence - 1,
    command: options.command ? {
      protocolVersion: 1 as const,
      baseRevision: sequence - 1,
      topLevelChanges: [],
      changedEntities: [],
      addedEntities: [],
      removedEntityIds: [],
      changedBelts: [],
      addedBelts: [],
      removedBeltIds: [],
    } : null,
    simulationSeconds: options.simulationSeconds ?? 8,
    wallSeconds: options.wallSeconds ?? 8,
    multicore: undefined,
    approximate: false,
    registry,
    committedAtMs: 1_786_377_600_100 + sequence,
  };
  return {
    ...unsigned,
    intentSha256: await computeSimulationRuntimeDurableIntentSha256(unsigned),
  };
}

describe("durable simulation runtime recovery contract", () => {
  it("keeps 450 eight-second boundaries as one RLE segment without a durable eight-second rollover", async () => {
    const checkpoint = primaryCheckpoint();
    let entries: SimulationRuntimeDurableRecoveryRecord["entries"] = [];
    for (let sequence = 1; sequence <= 450; sequence += 1) {
      entries = await finalizeSimulationRuntimeDurableRecoveryIntent(entries, await intent(sequence), sequence);
    }
    const record = { checkpoint, entries };
    const stats = getSimulationRuntimeDurableJournalStats(checkpoint, entries);
    expect(validateSimulationRuntimeDurableRecoveryRecord(record, baseIdentity)).toBeNull();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: "passive-segment",
      firstSequence: 1,
      lastSequence: 450,
      operationCount: 450,
      baseStateRevision: 0,
      nextStateRevision: 450,
      replay: { kind: "rle", steps: [{ simulationSeconds: 8, wallSeconds: 8, count: 450 }] },
    });
    expect(stats).toMatchObject({ entryCount: 1, commandCount: 0, operationCount: 450, lastSequence: 450, lastStateRevision: 450 });
    expect(stats.serializedBytes).toBeLessThan(4 * 1024);
    expect(entries[0].kind === "passive-segment" ? [...iterateSimulationRuntimeDurablePassiveReplay(entries[0].replay)] : [])
      .toHaveLength(450);
    expect(getSimulationRuntimeDurableCheckpointRecommendation(checkpoint, entries)).toMatchObject({ recommended: false, reason: null });
  });

  it("starts a new RLE step when a passive boundary changes and never generates aggregate replay", async () => {
    let entries: SimulationRuntimeDurableRecoveryRecord["entries"] = [];
    entries = await finalizeSimulationRuntimeDurableRecoveryIntent(entries, await intent(1), 1);
    entries = await finalizeSimulationRuntimeDurableRecoveryIntent(entries, await intent(2, { simulationSeconds: 4, wallSeconds: 4 }), 2);
    entries = await finalizeSimulationRuntimeDurableRecoveryIntent(entries, await intent(3, { simulationSeconds: 4, wallSeconds: 4 }), 3);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: "passive-segment",
      replay: {
        kind: "rle",
        steps: [
          { simulationSeconds: 8, wallSeconds: 8, count: 1 },
          { simulationSeconds: 4, wallSeconds: 4, count: 2 },
        ],
      },
    });
    expect(await validateSimulationRuntimeDurableJournalEntryDigests(entries)).toBeNull();

    const aggregate = structuredClone(entries) as unknown as SimulationRuntimeDurableRecoveryRecord["entries"];
    if (aggregate[0]?.kind === "passive-segment") {
      aggregate[0].replay = { kind: "aggregate", simulationSeconds: 16, wallSeconds: 16 } as never;
    }
    expect(validateSimulationRuntimeDurableRecoveryRecord({ checkpoint: primaryCheckpoint(), entries: aggregate }))
      .toBe("invalid-passive-segment");
  });

  it("cryptographically rejects a one-field RLE segment mutation", async () => {
    const entries = await finalizeSimulationRuntimeDurableRecoveryIntent([], await intent(1), 1);
    expect(await validateSimulationRuntimeDurableJournalEntryDigests(entries)).toBeNull();
    const corrupted = structuredClone(entries);
    if (corrupted[0]?.kind === "passive-segment") corrupted[0].replay.steps[0].wallSeconds += 0.001;
    expect(validateSimulationRuntimeDurableRecoveryRecord({ checkpoint: primaryCheckpoint(), entries: corrupted })).toBeNull();
    expect(await validateSimulationRuntimeDurableJournalEntryDigests(corrupted)).toBe("passive-segment-digest-mismatch");
  });

  it("keeps intent digests stable across the exact JSON side-record roundtrip", async () => {
    const original = await intent(1);
    const roundTripped = JSON.parse(JSON.stringify(original)) as SimulationRuntimeDurableOperationIntent;
    const { intentSha256: _intentSha256, ...unsigned } = roundTripped;
    expect(await computeSimulationRuntimeDurableIntentSha256(unsigned)).toBe(original.intentSha256);
  });

  it("matches JSON omission/null semantics for malformed object and array edges", async () => {
    const original = await intent(1, { command: true });
    const { intentSha256: _intentSha256, ...unsigned } = original;
    const edgeArray = [undefined, () => "ignored", Symbol("ignored"), Number.NaN, Infinity, -Infinity] as unknown[];
    edgeArray.length = 7; // The trailing sparse slot serializes as null too.
    (unsigned.command!.topLevelChanges[0] as any) = {
      path: ["edge"],
      operation: "set",
      value: {
        omittedUndefined: undefined,
        omittedFunction: () => "ignored",
        omittedSymbol: Symbol("ignored"),
        edgeArray,
      },
    };
    const before = await computeSimulationRuntimeDurableIntentSha256(unsigned);
    const roundTripped = JSON.parse(JSON.stringify(unsigned)) as typeof unsigned;
    const after = await computeSimulationRuntimeDurableIntentSha256(roundTripped);
    expect(after).toBe(before);
    expect((roundTripped.command!.topLevelChanges[0] as any).value).toEqual({
      edgeArray: [null, null, null, null, null, null, null],
    });

    const malformed = { ...unsigned, simulationSeconds: 1n } as unknown as typeof unsigned;
    await expect(computeSimulationRuntimeDurableIntentSha256(malformed)).rejects.toBeInstanceOf(TypeError);
  });

  it("keeps commands atomic, exposes the soft barrier, and enforces the hard entry bound", async () => {
    const checkpoint = primaryCheckpoint();
    let entries: SimulationRuntimeDurableRecoveryRecord["entries"] = [];
    for (let sequence = 1; sequence <= 4; sequence += 1) {
      entries = await finalizeSimulationRuntimeDurableRecoveryIntent(entries, await intent(sequence, { command: true }), sequence);
    }
    expect(validateSimulationRuntimeDurableRecoveryRecord({ checkpoint, entries })).toBeNull();
    expect(getSimulationRuntimeDurableCheckpointRecommendation(checkpoint, entries)).toMatchObject({
      recommended: true,
      reason: "commands",
      stats: { commandCount: 4 },
    });
    for (let sequence = 5; sequence <= 65; sequence += 1) {
      entries = await finalizeSimulationRuntimeDurableRecoveryIntent(entries, await intent(sequence, { command: true }), sequence);
    }
    expect(validateSimulationRuntimeDurableRecoveryRecord({ checkpoint, entries })).toBe("journal-command-bound-exceeded");
    for (let sequence = 66; sequence <= 97; sequence += 1) {
      entries = await finalizeSimulationRuntimeDurableRecoveryIntent(entries, await intent(sequence, { command: true }), sequence);
    }
    expect(validateSimulationRuntimeDurableRecoveryRecord({ checkpoint, entries })).toBe("journal-entry-bound-exceeded");
  });

  it("validates primary-backed and raw transfer checkpoints with exact source metadata", async () => {
    const primary = primaryCheckpoint();
    expect(validateSimulationRuntimeDurableRecoveryRecord({ checkpoint: primary, entries: [] }, baseIdentity)).toBeNull();
    expect(validateSimulationRuntimeDurableRecoveryRecord({
      checkpoint: { ...primary, primaryStateChecksum: "wrong" },
      entries: [],
    } as SimulationRuntimeDurableRecoveryRecord, baseIdentity)).toBe("invalid-primary-checkpoint");

    const buffer = new TextEncoder().encode("authoritative-transfer").buffer;
    const sha256 = await computeSimulationRuntimeDurableBytesSha256(buffer);
    const transfer = primaryCheckpoint({
      source: "transfer",
      transfer: {
        protocolVersion: 1,
        encoding: "raw",
        buffer,
        storedByteLength: buffer.byteLength,
        originalByteLength: buffer.byteLength,
        storedSha256: sha256,
        originalSha256: sha256,
      },
    });
    expect(validateSimulationRuntimeDurableRecoveryRecord({ checkpoint: transfer, entries: [] }, baseIdentity)).toBeNull();
  });

  it("enforces wall-clock spacing and separate gzip/raw rolling-byte budgets", () => {
    const metadataCheckpoint = (encoding: "raw" | "gzip", storedByteLength: number): SimulationRuntimeDurableCheckpoint => primaryCheckpoint({
      source: "transfer",
      transfer: {
        protocolVersion: 1,
        encoding,
        buffer: new ArrayBuffer(1),
        storedByteLength,
        originalByteLength: storedByteLength,
        storedSha256: "a".repeat(64),
        originalSha256: "a".repeat(64),
      },
    });
    const startedAt = 1_786_377_600_000;
    const first = metadataCheckpoint("gzip", 32 * 1024 * 1024);
    const cadence = advanceSimulationRuntimeDurableCheckpointCadence(null, first, startedAt);
    expect(cadence).toMatchObject({
      transferCountInWindow: 1,
      primaryRebaseCountInWindow: 0,
      lastCheckpointSource: "transfer",
      lastTransferEncoding: "gzip",
    });
    expect(validateSimulationRuntimeDurableCheckpointCadence(cadence, first, startedAt + 60_000)).toBe("transfer-checkpoint-too-frequent");
    expect(validateSimulationRuntimeDurableCheckpointCadence(cadence, first, startedAt + 29 * 60_000 + 59_000))
      .toBe("transfer-checkpoint-too-frequent");
    const secondCadence = advanceSimulationRuntimeDurableCheckpointCadence(cadence, first, startedAt + 30 * 60_000);
    expect(secondCadence.gzipBytesInWindow).toBe(SIMULATION_RUNTIME_DURABLE_RECOVERY_GZIP_BYTES_PER_HOUR);
    expect(validateSimulationRuntimeDurableCheckpointCadence(secondCadence, metadataCheckpoint("gzip", 1), startedAt + 35 * 60_000))
      .toBe("gzip-hourly-byte-budget-exceeded");

    const raw = metadataCheckpoint("raw", SIMULATION_RUNTIME_DURABLE_RECOVERY_RAW_BYTES_PER_HOUR);
    const rawCadence = advanceSimulationRuntimeDurableCheckpointCadence(null, raw, startedAt);
    expect(validateSimulationRuntimeDurableCheckpointCadence(rawCadence, metadataCheckpoint("raw", 1), startedAt + 5 * 60_000))
      .toBe("raw-hourly-byte-budget-exceeded");

    const boundaryStart = startedAt + 59 * 60_000 + 59_000;
    const boundaryCadence = advanceSimulationRuntimeDurableCheckpointCadence(null,
      metadataCheckpoint("gzip", SIMULATION_RUNTIME_DURABLE_RECOVERY_GZIP_BYTES_PER_HOUR), boundaryStart);
    expect(validateSimulationRuntimeDurableCheckpointCadence(
      boundaryCadence,
      metadataCheckpoint("gzip", SIMULATION_RUNTIME_DURABLE_RECOVERY_GZIP_BYTES_PER_HOUR),
      boundaryStart + 2_000,
    )).toBe("transfer-checkpoint-too-frequent");

    const afterPrimaryRebase = advanceSimulationRuntimeDurableCheckpointCadence(
      boundaryCadence,
      primaryCheckpoint(),
      boundaryStart + 1_000,
    );
    expect(afterPrimaryRebase.lastTransferAtMs).toBe(boundaryStart);
    expect(validateSimulationRuntimeDurableCheckpointCadence(
      afterPrimaryRebase,
      metadataCheckpoint("gzip", SIMULATION_RUNTIME_DURABLE_RECOVERY_GZIP_BYTES_PER_HOUR),
      boundaryStart + 2_000,
    )).toBe("transfer-checkpoint-too-frequent");
  });
});
