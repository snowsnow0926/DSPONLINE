import { afterEach, describe, expect, it, vi } from "vitest";
import { CanonicalTerminalDecoder } from "./canonicalTerminalOwnerClient";
import { claimCanonicalTerminalOwner } from "./canonicalTerminalOwnerRegistry";
import { serializeAuthoritativePrimarySaveInWorker } from "./authoritativeSaveSerializationClient";
import { createInitialState } from "./engine";
import { loadContentPackRegistry } from "./contentPacks";
import { SaveStateChunkAssembler, SaveStateChunkSender, type SaveStateChunkRequest } from "./saveStateChunkTransfer";
import { serializeSaveEnvelopeToTransfer } from "./saveTransfer";
import { projectPersistentSaveStateInPlaceOwned } from "./saveProjection";
import { sha256Bytes } from "./payloadDigest";
import { computeAuthoritativeSaveProofBindingSha256 } from "./authoritativeSaveProof";
import type { CanonicalTerminalOwnerRequest } from "./canonicalTerminalOwnerProtocol";
import type { GameState } from "./types";
import type { AuthoritativeSaveSerializationRequest, AuthoritativeSaveSerializationResponse } from "./authoritativeSaveSerializationProtocol";
import type { AuthoritativeSaveCatalogSeed, AuthoritativeSavePayloadProof } from "./authoritativeSavePersistenceProtocol";

class FakeWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  messages: unknown[] = [];
  terminateCount = 0;
  privateState: GameState | null = null;
  request: AuthoritativeSaveSerializationRequest | null = null;
  producer: SaveStateChunkSender | null = null;
  readonly saveCollector = new SaveStateChunkAssembler();

  postMessage(message: unknown, transfer: Transferable[] = []): void {
    const copy = structuredClone(message, { transfer }) as CanonicalTerminalOwnerRequest | SaveStateChunkRequest;
    this.messages.push(copy);
    if (copy.type === "canonical-ack") this.producer?.acknowledge(copy.ack);
    if (copy.type === "canonical-serialize") this.request = { ...copy.request, state: this.privateState! };
    if (["state-begin", "state-records", "state-complete"].includes(copy.type)) {
      const received = this.saveCollector.accept(copy as SaveStateChunkRequest);
      if ("ack" in received) queueMicrotask(() => this.respond({ id: 1, stateChunkAck: received.ack }));
      else { this.request = received.request; this.privateState = received.request.state; }
    }
  }

  deliver(state: GameState): void {
    this.privateState = state;
    this.producer = new SaveStateChunkSender({ postMessage: (message) => this.respond(structuredClone(message)) }, async () => {});
    void this.producer.send({ id: 1, state, formatVersion: 2, savedAt: 1_800_000_000_000, kind: "primary", slot: "main",
      contentPackRegistry: loadContentPackRegistry(), includeAuthoritativeProof: true, includeSourceStateTransfer: false }).catch(() => {});
  }

  respond(data: unknown): void { this.onmessage?.({ data } as MessageEvent); }
  terminate(): void { this.terminateCount += 1; this.producer?.cancel(); }

  async succeed(): Promise<void> {
    const request = this.request!;
    const state = projectPersistentSaveStateInPlaceOwned(this.privateState!, request.contentPackRegistry);
    const frame = serializeSaveEnvelopeToTransfer(state, { formatVersion: 2, savedAt: request.savedAt, kind: "primary", slot: "main", mode: state.mode });
    const sha = await sha256Bytes(frame.bytes);
    const catalogSeed: AuthoritativeSaveCatalogSeed = { mode: state.mode, kind: "primary", slot: "main", savedAt: request.savedAt,
      stateVersion: state.version, entityCount: state.entities.length, beltCount: state.belts.length, elapsedSeconds: state.elapsedSeconds,
      completedTechCount: state.research.completedTechIds.length, activePlanetId: state.activePlanetId,
      structurePoints: 0, stateChecksum: frame.stateChecksum, modeExplicit: true, reason: null, settings: null };
    const proof: AuthoritativeSavePayloadProof = { integrity: "valid", payloadChecksum: frame.payloadChecksum, payloadSha256: sha,
      byteLength: frame.byteLength, stateChecksum: frame.stateChecksum, transportEncoding: "raw", storedByteLength: frame.byteLength,
      storedSha256: sha, bindingSha256: "" };
    proof.bindingSha256 = await computeAuthoritativeSaveProofBindingSha256(proof, catalogSeed);
    const response: AuthoritativeSaveSerializationResponse = { id: 1, bytes: frame.bytes, proof, catalogSeed,
      summary: { stateVersion: state.version, savedAt: request.savedAt, mode: state.mode, kind: "primary", slot: "main", reason: null,
        elapsedSeconds: state.elapsedSeconds, activePlanetId: state.activePlanetId, entityCount: state.entities.length,
        beltCount: state.belts.length, completedTechCount: state.research.completedTechIds.length, structurePoints: 0,
        uploadedWhiteMatrix: 0, stateChecksum: frame.stateChecksum, computedStateChecksum: frame.stateChecksum, integrity: "valid" } };
    this.respond(structuredClone(response, { transfer: [frame.bytes] }));
  }
}

const workers: FakeWorker[] = [];
const decoders: CanonicalTerminalDecoder[] = [];
function install() {
  vi.stubGlobal("Worker", class { constructor() { const worker = new FakeWorker(); workers.push(worker); return worker; } });
}
function begin(options: Partial<ConstructorParameters<typeof CanonicalTerminalDecoder>[3]> = {}) {
  const source = createInitialState(44_247);
  source.entities[0].inputs.iron_ore = 137;
  const frame = serializeSaveEnvelopeToTransfer(source, { formatVersion: 2, savedAt: 1_800_000_000_000, kind: "primary", slot: "main", mode: source.mode });
  const blob = new Blob([frame.bytes]);
  const decoder = new CanonicalTerminalDecoder(blob, { integrity: "valid", stateChecksum: frame.stateChecksum,
    payloadChecksum: frame.payloadChecksum, byteLength: frame.byteLength }, loadContentPackRegistry(), { isCurrent: () => true, ...options });
  decoders.push(decoder);
  return { decoder, source, blob, worker: workers.at(-1)! };
}

afterEach(() => {
  for (const decoder of decoders) decoder.close();
  decoders.length = 0; workers.length = 0;
  vi.useRealTimers(); vi.unstubAllGlobals();
});

describe("canonical terminal owner lifecycle", () => {
  it("delivers the complete value copy then reuses the same Worker and existing proof validator", async () => {
    install();
    const { decoder, source, blob, worker } = begin();
    const before = JSON.stringify(source);
    worker.deliver(source);
    const state = await decoder.state;
    expect(JSON.stringify(state)).toBe(before);
    const pending = serializeAuthoritativePrimarySaveInWorker(state, { savedAt: 1_800_000_001_234, frozenStateIsCurrent: () => true });
    expect(workers).toHaveLength(1);
    expect(worker.request?.savedAt).toBe(1_800_000_001_234);
    const wire = worker.messages.find((message) => (message as { type: string }).type === "canonical-serialize") as { request: Record<string, unknown> };
    expect(wire.request).not.toHaveProperty("state");
    expect(wire.request).toMatchObject({ kind: "primary", slot: "main", includeSourceStateTransfer: false });
    await worker.succeed();
    const saved = await pending;
    expect(saved.proof.integrity).toBe("valid");
    expect(JSON.stringify(state)).toBe(before);
    expect(worker.terminateCount).toBe(1);
    expect(blob.size).toBeGreaterThan(0);
    expect((await blob.arrayBuffer()).byteLength).toBe(blob.size);
  });

  it("keeps the complete canonical source for ordinary chunked retry after proof failure", async () => {
    install(); const { decoder, source, worker } = begin(); worker.deliver(source);
    const state = await decoder.state; const before = JSON.stringify(state);
    const failed = serializeAuthoritativePrimarySaveInWorker(state, { frozenStateIsCurrent: () => true });
    worker.respond({ id: 1, error: "injected owner proof failure" });
    await expect(failed).rejects.toMatchObject({ ownershipLost: false, code: "worker-crash" });
    expect(JSON.stringify(state)).toBe(before);
    const retry = serializeAuthoritativePrimarySaveInWorker(state, { frozenStateIsCurrent: () => true });
    const second = workers.at(-1)!;
    expect(second).not.toBe(worker);
    await vi.waitFor(() => expect(second.request?.state).toBeDefined());
    expect(JSON.stringify(second.privateState)).toBe(before);
    await second.succeed(); await expect(retry).resolves.toHaveProperty("proof.integrity", "valid");
    expect(JSON.stringify(state)).toBe(before);
  });

  it("reclaims an unclaimed Worker when its timeline expires after delivery", async () => {
    vi.useFakeTimers(); install(); let current = true;
    const { decoder, source, worker } = begin({ isCurrent: () => current }); worker.deliver(source);
    const state = await decoder.state; current = false;
    await vi.advanceTimersByTimeAsync(101);
    expect(worker.terminateCount).toBe(1);
    expect(claimCanonicalTerminalOwner(state, loadContentPackRegistry(), () => true)).toBeNull();
  });

  it("closes the retained source when a caller chooses an ordinary atomic snapshot", async () => {
    install(); const { decoder, source, worker } = begin(); worker.deliver(source);
    const state = await decoder.state;
    const pending = serializeAuthoritativePrimarySaveInWorker(state);
    expect(workers).toHaveLength(2); expect(worker.terminateCount).toBe(1);
    const ordinary = workers.at(-1)!;
    expect(ordinary.messages[0]).toHaveProperty("state");
    ordinary.onerror?.({ message: "finish ordinary fixture" } as ErrorEvent);
    await expect(pending).rejects.toMatchObject({ code: "worker-crash", ownershipLost: false });
  });

  it("expires an unused delivered source without discarding the UI state", async () => {
    vi.useFakeTimers(); install();
    const { decoder, source, worker } = begin({ idleTimeoutMs: 10 }); worker.deliver(source);
    const state = await decoder.state; const before = JSON.stringify(state);
    await vi.advanceTimersByTimeAsync(11);
    expect(worker.terminateCount).toBe(1); expect(JSON.stringify(state)).toBe(before);
  });

  it.each(["abort", "timeout", "crash", "early-proof"] as const)("releases partial decoding on %s", async (failure) => {
    vi.useFakeTimers(); install(); const controller = new AbortController();
    const { decoder, blob, worker } = begin({ signal: controller.signal, timeoutMs: 10 });
    const rejected = expect(decoder.state).rejects.toBeInstanceOf(Error);
    if (failure === "abort") controller.abort();
    else if (failure === "timeout") await vi.advanceTimersByTimeAsync(11);
    else if (failure === "crash") worker.onerror?.({ message: "injected decoder crash" } as ErrorEvent);
    else worker.respond({ id: 1, bytes: new ArrayBuffer(1) });
    await rejected; expect(worker.terminateCount).toBe(1);
    expect((await blob.arrayBuffer()).byteLength).toBe(blob.size);
  });

  it("refuses to publish a state rejected by the original identity validator", async () => {
    install(); const { decoder, source, worker } = begin({ validateState: () => { throw new Error("identity drift"); } });
    const rejected = expect(decoder.state).rejects.toThrow("identity drift"); worker.deliver(source); await rejected;
    expect(worker.terminateCount).toBe(1);
  });

  it("does not register a state when validation cancels its timeline", async () => {
    install(); const controller = new AbortController();
    const { decoder, source, worker } = begin({ signal: controller.signal, validateState: () => controller.abort() });
    const rejected = expect(decoder.state).rejects.toMatchObject({ name: "AbortError" }); worker.deliver(source); await rejected;
    expect(worker.terminateCount).toBe(1);
  });

  it("rejects an incomplete batch before exposing any state", async () => {
    install(); const { decoder, source, worker } = begin();
    const rejected = expect(decoder.state).rejects.toThrow(/未完整/);
    worker.respond({ type: "state-begin", id: 1, entityCount: source.entities.length, beltCount: source.belts.length,
      metadata: { id: 1, kind: "primary", slot: "main", includeAuthoritativeProof: true, includeSourceStateTransfer: false },
      topLevel: { ...source, entities: undefined, belts: undefined } });
    worker.respond({ type: "state-complete", id: 1 }); await rejected;
    expect(worker.terminateCount).toBe(1);
  });

  it("rejects a foreign operation before accepting its state header", async () => {
    install(); const { decoder, worker } = begin();
    const rejected = expect(decoder.state).rejects.toThrow(/编号/);
    worker.respond({ type: "state-begin", id: 2 }); await rejected;
    expect(worker.terminateCount).toBe(1);
  });
});
