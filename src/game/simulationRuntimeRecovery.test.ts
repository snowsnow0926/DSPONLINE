import { describe, expect, it } from "vitest";
import { createContentPackRegistry, createContentPackRuntimeSnapshot } from "./contentPacks";
import { createInitialState } from "./engine";
import { createSimulationCommandPatch, serializeSimulationStateForTransfer } from "./simulationRuntimeProtocol";
import {
  SIMULATION_RUNTIME_RECOVERY_MAX_OPERATIONS,
  SIMULATION_RUNTIME_RECOVERY_MAX_COMMANDS,
  computeSimulationRuntimeRecoveryOperationSha256,
  computeSimulationStateTransferSha256,
  getSimulationRuntimeRecoveryJournalStats,
  shouldRollSimulationRuntimeRecoveryCheckpoint,
  validateSimulationRuntimeRecoveryRecord,
  type SimulationRuntimeRecoveryCheckpoint,
  type SimulationRuntimeRecoveryOperation,
} from "./simulationRuntimeRecovery";

async function fixture() {
  const state = createInitialState(44_104);
  const transfer = serializeSimulationStateForTransfer(state);
  const registry = createContentPackRuntimeSnapshot(createContentPackRegistry());
  const checkpoint: SimulationRuntimeRecoveryCheckpoint = {
    schemaVersion: 1,
    sessionId: "runtime-recovery-test",
    generation: 1,
    lastSequence: 0,
    stateRevision: 1,
    registryFingerprint: registry.fingerprint,
    registry,
    committedAtMs: 1_700_000_000_000,
    baseIdentity: { mode: "normal", savedAt: 1_700_000_000_000, checksum: "base-checksum", revision: 7 },
    transfer,
    transferSha256: await computeSimulationStateTransferSha256(transfer),
  };
  return { state, registry, checkpoint };
}

async function operation(
  checkpoint: SimulationRuntimeRecoveryCheckpoint,
  sequence: number,
  baseStateRevision: number,
  options: { command?: SimulationRuntimeRecoveryOperation["command"]; simulationSeconds?: number } = {},
): Promise<SimulationRuntimeRecoveryOperation> {
  const unsigned: Omit<SimulationRuntimeRecoveryOperation, "operationSha256"> = {
    schemaVersion: 1,
    sessionId: checkpoint.sessionId,
    generation: checkpoint.generation,
    sequence,
    baseStateRevision,
    nextStateRevision: baseStateRevision + 1,
    command: options.command ?? null,
    simulationSeconds: options.simulationSeconds ?? 1,
    wallSeconds: options.simulationSeconds ?? 1,
    multicore: undefined,
    approximate: false,
    registry: checkpoint.registry,
    committedAtMs: checkpoint.committedAtMs + sequence * 1_000,
  };
  return { ...unsigned, operationSha256: await computeSimulationRuntimeRecoveryOperationSha256(unsigned) };
}

describe("simulation runtime durable recovery semantics", () => {
  it("hashes the exact transferable checkpoint bytes", async () => {
    const { checkpoint } = await fixture();
    expect(checkpoint.transferSha256).toMatch(/^[0-9a-f]{64}$/);
    const changed = checkpoint.transfer.buffer.slice(0);
    new Uint8Array(changed)[0] ^= 1;
    expect(await computeSimulationStateTransferSha256({ ...checkpoint.transfer, buffer: changed })).not.toBe(checkpoint.transferSha256);
  });

  it("accepts only a contiguous session, sequence and revision chain", async () => {
    const { checkpoint } = await fixture();
    const operations = [await operation(checkpoint, 1, 1), await operation(checkpoint, 2, 2)];
    expect(validateSimulationRuntimeRecoveryRecord({ checkpoint, operations }, checkpoint.baseIdentity)).toBeNull();
    expect(getSimulationRuntimeRecoveryJournalStats(checkpoint, operations)).toMatchObject({
      operationCount: 2,
      commandCount: 0,
      simulationSeconds: 2,
      lastSequence: 2,
      lastStateRevision: 3,
    });
    expect(validateSimulationRuntimeRecoveryRecord({ checkpoint, operations: [operations[1]] })).toBe("operation-order-mismatch");
    expect(validateSimulationRuntimeRecoveryRecord({ checkpoint, operations }, { ...checkpoint.baseIdentity, checksum: "other" })).toBe("base-identity-mismatch");
  });

  it("rolls at the passive, elapsed-time and command-heavy hard bounds", async () => {
    const { state, checkpoint } = await fixture();
    const passive = await Promise.all(Array.from({ length: SIMULATION_RUNTIME_RECOVERY_MAX_OPERATIONS }, (_, index) =>
      operation(checkpoint, index + 1, index + 1, { simulationSeconds: 0.5 })));
    expect(shouldRollSimulationRuntimeRecoveryCheckpoint(checkpoint, passive.slice(0, -1))).toBe(false);
    expect(shouldRollSimulationRuntimeRecoveryCheckpoint(checkpoint, passive)).toBe(true);
    expect(shouldRollSimulationRuntimeRecoveryCheckpoint(checkpoint, [await operation(checkpoint, 1, 1, { simulationSeconds: 8 })])).toBe(true);

    const edited = { ...structuredClone(state), paused: !state.paused };
    const command = createSimulationCommandPatch(state, edited, 1)!;
    const commandHeavy = await Promise.all(Array.from({ length: 4 }, (_, index) => operation(checkpoint, index + 1, index + 1, {
      command: { ...command, baseRevision: index + 1 },
      simulationSeconds: 0,
    })));
    expect(shouldRollSimulationRuntimeRecoveryCheckpoint(checkpoint, commandHeavy.slice(0, -1))).toBe(false);
    expect(shouldRollSimulationRuntimeRecoveryCheckpoint(checkpoint, commandHeavy)).toBe(true);
  });

  it("rejects journals beyond the crash-replay bound", async () => {
    const { state, checkpoint } = await fixture();
    const operations = await Promise.all(Array.from({ length: SIMULATION_RUNTIME_RECOVERY_MAX_OPERATIONS + 1 }, (_, index) =>
      operation(checkpoint, index + 1, index + 1, { simulationSeconds: 0.5 })));
    expect(validateSimulationRuntimeRecoveryRecord({ checkpoint, operations })).toBe("journal-bound-exceeded");

    const edited = { ...structuredClone(state), paused: !state.paused };
    const command = createSimulationCommandPatch(state, edited, 1)!;
    const commandOverflow = await Promise.all(Array.from({ length: SIMULATION_RUNTIME_RECOVERY_MAX_COMMANDS + 1 }, (_, index) =>
      operation(checkpoint, index + 1, index + 1, {
        command: { ...command, baseRevision: index + 1 },
        simulationSeconds: 0,
      })));
    expect(validateSimulationRuntimeRecoveryRecord({ checkpoint, operations: commandOverflow })).toBe("journal-bound-exceeded");
  });

  it("binds retries to one canonical operation digest", async () => {
    const { checkpoint } = await fixture();
    const original = await operation(checkpoint, 1, 1);
    const reordered = {
      committedAtMs: original.committedAtMs,
      registry: original.registry,
      approximate: original.approximate,
      multicore: original.multicore,
      wallSeconds: original.wallSeconds,
      simulationSeconds: original.simulationSeconds,
      command: original.command,
      nextStateRevision: original.nextStateRevision,
      baseStateRevision: original.baseStateRevision,
      sequence: original.sequence,
      generation: original.generation,
      sessionId: original.sessionId,
      schemaVersion: original.schemaVersion,
    } satisfies Omit<SimulationRuntimeRecoveryOperation, "operationSha256">;
    expect(await computeSimulationRuntimeRecoveryOperationSha256(reordered)).toBe(original.operationSha256);
    expect(await computeSimulationRuntimeRecoveryOperationSha256({ ...reordered, wallSeconds: reordered.wallSeconds + 1 })).not.toBe(original.operationSha256);
    expect(validateSimulationRuntimeRecoveryRecord({ checkpoint, operations: [{ ...original, operationSha256: "bad" }] })).toBe("invalid-operation-digest");
  });
});
