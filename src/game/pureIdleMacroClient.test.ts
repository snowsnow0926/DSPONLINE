import { afterEach, describe, expect, it, vi } from "vitest";
import { createContentPackRegistry, createContentPackRuntimeSnapshot } from "./contentPacks";
import { hashGameState } from "./benchmark";
import { createInitialState } from "./engine";
import {
  PureIdleMacroClient,
  type PureIdleMacroClientError,
} from "./pureIdleMacroClient";
import { PURE_IDLE_MACRO_ALGORITHM_VERSION, type PureIdleMacroSummary } from "./pureIdleMacro";
import type {
  PureIdleMacroFinalEnvelopeTransfer,
  PureIdleMacroWorkerRequest,
  PureIdleMacroWorkerResponse,
} from "./pureIdleMacroProtocol";
import { decodeVerifiedSaveTransfer, serializeSaveEnvelopeToTransfer } from "./saveTransfer";
import type { GameState } from "./types";
import type { WorkerBinaryPayload } from "./workerBinaryPayload";

function arrayBufferPayload(payload: WorkerBinaryPayload): ArrayBuffer {
  if (!(payload instanceof ArrayBuffer)) throw new Error("test fixture expected ArrayBuffer transport");
  return payload;
}

class FakeWorker {
  onmessage: ((event: MessageEvent<PureIdleMacroWorkerResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  request: PureIdleMacroWorkerRequest | null = null;
  terminateCount = 0;

  postMessage(message: PureIdleMacroWorkerRequest, transfer: Transferable[] = []): void {
    this.request = structuredClone(message, { transfer }) as PureIdleMacroWorkerRequest;
  }

  respond(response: PureIdleMacroWorkerResponse): void {
    this.onmessage?.({ data: response } as MessageEvent<PureIdleMacroWorkerResponse>);
  }

  crash(): void {
    this.onerror?.({ message: "synthetic Worker crash" } as ErrorEvent);
  }

  terminate(): void {
    this.terminateCount += 1;
  }
}

function installWorker(worker: FakeWorker): void {
  vi.stubGlobal("Worker", class {
    constructor() { return worker; }
  });
  vi.stubGlobal("window", globalThis);
}

function summary(settledWallSeconds = 60): PureIdleMacroSummary {
  return {
    algorithmVersion: PURE_IDLE_MACRO_ALGORITHM_VERSION,
    settledWallSeconds,
    settledSimulationSeconds: settledWallSeconds * 2,
  } as PureIdleMacroSummary;
}

const testRegistry = createContentPackRuntimeSnapshot(createContentPackRegistry());

function finalEnvelope(
  state: GameState,
  resultSummary: PureIdleMacroSummary,
  registryFingerprint = testRegistry.fingerprint,
): PureIdleMacroFinalEnvelopeTransfer {
  const mode = state.mode === "speedrun" ? "speedrun" : "normal";
  const serialized = serializeSaveEnvelopeToTransfer(state, {
    formatVersion: 2,
    kind: "primary",
    mode,
    slot: "main",
    savedAt: 1_786_377_600_000,
  });
  return {
    payloadBytes: serialized.bytes,
    verification: {
      integrity: "valid",
      stateChecksum: serialized.stateChecksum,
      payloadChecksum: serialized.payloadChecksum,
      byteLength: serialized.byteLength,
    },
    identity: {
      stateChecksum: serialized.stateChecksum,
      stateVersion: state.version,
      mode,
      activePlanetId: state.activePlanetId,
      entityCount: state.entities.length,
      beltCount: state.belts.length,
      elapsedSeconds: state.elapsedSeconds,
      algorithmVersion: resultSummary.algorithmVersion,
      settledWallSeconds: resultSummary.settledWallSeconds,
      settledSimulationSeconds: resultSummary.settledSimulationSeconds,
      registryFingerprint,
    },
  };
}

function finalizedResponse(
  state: GameState,
  overrides: Partial<PureIdleMacroFinalEnvelopeTransfer> = {},
  id = 2,
  registryFingerprint = testRegistry.fingerprint,
): Extract<PureIdleMacroWorkerResponse, { type: "finalized" }> {
  const resultSummary = summary();
  return {
    id,
    type: "finalized",
    summary: resultSummary,
    finalEnvelope: { ...finalEnvelope(state, resultSummary, registryFingerprint), ...overrides },
    durationMs: 12,
  };
}

async function initializeClient(
  client: PureIdleMacroClient,
  worker: FakeWorker,
  state: GameState,
  terminalState?: {
    startedPaused: boolean;
    baselineIdleSettlement: GameState["idleSettlement"];
    baselineTotalProduced: GameState["totalProduced"];
  },
): Promise<void> {
  const pending = client.initialize(state, "stable", testRegistry, terminalState ? {
    startedPaused: terminalState.startedPaused,
    baselineIdleSettlement: terminalState.baselineIdleSettlement,
    baselineTotalProduced: terminalState.baselineTotalProduced,
  } : {});
  expect(worker.request).toMatchObject({
    type: "initialize",
    registry: testRegistry,
    ...(terminalState ? {
      startedPaused: terminalState.startedPaused,
      baselineIdleSettlement: terminalState.baselineIdleSettlement,
      baselineTotalProduced: terminalState.baselineTotalProduced,
    } : {}),
  });
  worker.respond({ id: 1, type: "ready", summary: summary(0), durationMs: 1 });
  await pending;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("pure idle final envelope ownership", () => {
  it("keeps the source checkpoint hash unchanged across a Worker crash and clean restart", async () => {
    const source = createInitialState(43, false);
    const sourceHash = hashGameState(source);
    const worker = new FakeWorker();
    installWorker(worker);
    const client = new PureIdleMacroClient();
    await initializeClient(client, worker, source);
    const pending = client.advance(60);
    worker.crash();
    await expect(pending).rejects.toMatchObject({ code: "worker-crash", recoverable: true });
    expect(hashGameState(source)).toBe(sourceHash);
    client.close();

    const restartedWorker = new FakeWorker();
    installWorker(restartedWorker);
    const restarted = new PureIdleMacroClient();
    await initializeClient(restarted, restartedWorker, source);
    expect(hashGameState(source)).toBe(sourceHash);
    restarted.close();
  });

  it("returns the original verified payload buffer with proof and finalized identity", async () => {
    const worker = new FakeWorker();
    installWorker(worker);
    const state = createInitialState(44, false);
    const response = finalizedResponse(state);
    const originalPayloadBytes = arrayBufferPayload(response.finalEnvelope.payloadBytes);
    const terminalState = {
      startedPaused: true,
      baselineIdleSettlement: structuredClone(state.idleSettlement),
      baselineTotalProduced: structuredClone(state.totalProduced),
    };
    const client = new PureIdleMacroClient();
    await initializeClient(client, worker, state, terminalState);
    const pending = client.finalize(60);
    expect(worker.request).toMatchObject({ type: "finalize", targetWallSeconds: 60 });
    expect(worker.request).not.toHaveProperty("finalState");
    expect(worker.request).not.toHaveProperty("startedPaused");
    expect(worker.request).not.toHaveProperty("baselineIdleSettlement");
    expect(worker.request).not.toHaveProperty("baselineTotalProduced");
    worker.respond(response);

    const result = await pending;
    expect(result.finalEnvelope.payloadBytes).toBe(originalPayloadBytes);
    expect(result.rawBytes).toBe(originalPayloadBytes.byteLength);
    expect(result.finalEnvelope.verification).toMatchObject({
      integrity: "valid",
      byteLength: originalPayloadBytes.byteLength,
      stateChecksum: result.finalEnvelope.identity.stateChecksum,
    });
    expect(result.finalEnvelope.identity).toMatchObject({
      stateVersion: result.state.version,
      mode: result.state.mode,
      entityCount: result.state.entities.length,
      beltCount: result.state.belts.length,
      elapsedSeconds: result.state.elapsedSeconds,
    });
    expect(decodeVerifiedSaveTransfer(arrayBufferPayload(result.finalEnvelope.payloadBytes), result.finalEnvelope.verification))
      .toContain(`"checksum":"${result.finalEnvelope.verification.stateChecksum}"`);
    client.close();
  });

  it("returns a terminal envelope without decoding or parsing it on the UI", async () => {
    const worker = new FakeWorker();
    installWorker(worker);
    const state = createInitialState(44, false);
    const client = new PureIdleMacroClient();
    await initializeClient(client, worker, state, {
      startedPaused: true,
      baselineIdleSettlement: structuredClone(state.idleSettlement),
      baselineTotalProduced: structuredClone(state.totalProduced),
    });
    const malformedState = { ...state, research: undefined } as unknown as GameState;
    const response = finalizedResponse(malformedState);
    new Uint8Array(arrayBufferPayload(response.finalEnvelope.payloadBytes))[0] ^= 1;
    const pending = client.finalizeEnvelope(60, { terminal: true });
    expect(worker.request).toMatchObject({ type: "finalize", targetWallSeconds: 60, terminal: true });
    worker.respond(response);
    const result = await pending;
    expect(result.finalEnvelope.payloadBytes).toBe(response.finalEnvelope.payloadBytes);
    expect(result.summary).toBe(response.summary);
    client.close();
  });

  it("accepts an immutable Blob terminal carrier without adopting its backing bytes", async () => {
    const worker = new FakeWorker();
    installWorker(worker);
    const state = createInitialState(144, false);
    const client = new PureIdleMacroClient();
    await initializeClient(client, worker, state, {
      startedPaused: false,
      baselineIdleSettlement: structuredClone(state.idleSettlement),
      baselineTotalProduced: structuredClone(state.totalProduced),
    });
    const arrayResponse = finalizedResponse(state);
    const sourceBytes = arrayBufferPayload(arrayResponse.finalEnvelope.payloadBytes);
    const payloadBlob = new Blob([sourceBytes], { type: "application/json" });
    const response: Extract<PureIdleMacroWorkerResponse, { type: "finalized" }> = {
      ...arrayResponse,
      finalEnvelope: { ...arrayResponse.finalEnvelope, payloadBytes: payloadBlob },
    };
    const pending = client.finalizeEnvelope(60, {
      terminal: true,
      binaryTransport: "blob",
    });
    expect(worker.request).toMatchObject({
      type: "finalize",
      targetWallSeconds: 60,
      terminal: true,
      binaryTransport: "blob",
    });
    worker.respond(response);
    const result = await pending;
    expect(result.finalEnvelope.payloadBytes).toBe(payloadBlob);
    expect(payloadBlob.size).toBe(sourceBytes.byteLength);
    expect(result.rawBytes).toBe(sourceBytes.byteLength);
    client.close();
  });

  it("keeps verified envelope ownership on recoverable parse and identity failures", async () => {
    const malformedWorker = new FakeWorker();
    installWorker(malformedWorker);
    const malformedState = {
      ...createInitialState(45, false),
      version: 999,
    } as unknown as GameState;
    const malformedResponse = finalizedResponse(malformedState);
    const malformedBytes = arrayBufferPayload(malformedResponse.finalEnvelope.payloadBytes);
    const malformedClient = new PureIdleMacroClient();
    await initializeClient(malformedClient, malformedWorker, createInitialState(145, false));
    const malformedPending = malformedClient.finalize(60);
    malformedWorker.respond(malformedResponse);
    const parseError = await malformedPending.catch((error: unknown) => error as PureIdleMacroClientError);
    expect(parseError).toMatchObject({ code: "operation", recoverable: true });
    expect(parseError.finalEnvelope?.payloadBytes).toBe(malformedBytes);
    expect(decodeVerifiedSaveTransfer(
      arrayBufferPayload(parseError.finalEnvelope!.payloadBytes),
      parseError.finalEnvelope!.verification,
    )).toContain(`"checksum":"${parseError.finalEnvelope!.verification.stateChecksum}"`);
    malformedClient.close();

    const identityWorker = new FakeWorker();
    installWorker(identityWorker);
    const state = createInitialState(46, false);
    const validEnvelope = finalEnvelope(state, summary());
    const identityResponse = finalizedResponse(state, {
      identity: { ...validEnvelope.identity, entityCount: validEnvelope.identity.entityCount + 1 },
    });
    const identityBytes = arrayBufferPayload(identityResponse.finalEnvelope.payloadBytes);
    const identityClient = new PureIdleMacroClient();
    await initializeClient(identityClient, identityWorker, state);
    const identityPending = identityClient.finalize(60);
    identityWorker.respond(identityResponse);
    const identityError = await identityPending.catch((error: unknown) => error as PureIdleMacroClientError);
    expect(identityError).toMatchObject({ code: "operation", recoverable: true });
    expect(identityError.finalEnvelope?.payloadBytes).toBe(identityBytes);
    identityClient.close();

    const registryWorker = new FakeWorker();
    installWorker(registryWorker);
    const registryState = createInitialState(48, false);
    const registryClient = new PureIdleMacroClient();
    await initializeClient(registryClient, registryWorker, registryState);
    const registryPending = registryClient.finalizeEnvelope(60);
    registryWorker.respond(finalizedResponse(registryState, {}, 2, "different-registry"));
    await expect(registryPending).rejects.toMatchObject({ code: "operation", recoverable: false });
    registryClient.close();
  });

  it("rejects mismatched byte proof without exposing it as a verified recoverable envelope", async () => {
    const worker = new FakeWorker();
    installWorker(worker);
    const state = createInitialState(47, false);
    const validEnvelope = finalEnvelope(state, summary());
    const response = finalizedResponse(state, {
      verification: { ...validEnvelope.verification, payloadChecksum: "00000000" },
    });
    const client = new PureIdleMacroClient();
    await initializeClient(client, worker, state);
    const pending = client.finalize(60);
    worker.respond(response);
    const error = await pending.catch((reason: unknown) => reason as PureIdleMacroClientError);
    expect(error).toMatchObject({ code: "operation", recoverable: false });
    expect(error.finalEnvelope).toBeUndefined();
    client.close();
  });
});
