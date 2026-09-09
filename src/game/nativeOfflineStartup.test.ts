import { describe, expect, it, vi } from "vitest";
import type {
  DesktopBridge,
  DesktopNativeCoreSummary,
  DesktopNativeOfflineStartupRequest,
  DesktopNativeOfflineStartupResult,
} from "../desktop";
import { createContentPackRegistry, createContentPackRuntimeSnapshot } from "./contentPacks";
import { createInitialState } from "./engine";
import { tryNativeOfflineStartupSettlement } from "./nativeOfflineStartup";
import { recoverOrphanedTimeWarpForOffline } from "./offlineTimeWarpRecovery";
import { createNativeCoreRevisionProof } from "./nativeCoreProof";
import { serializeSaveEnvelopeToTransfer } from "./saveTransfer";
import type { DeferredLoadedGame } from "./storage";
import type { GameState } from "./types";

const ROOT_HASH = "a".repeat(64);
const GENERATION = 3;
const REVISION = 9;
const SAVED_AT = 1_000;
const SETTLED_SECONDS = 30;

function summary(
  state: GameState,
  revision: number,
  registryFingerprint: string,
): DesktopNativeCoreSummary {
  const proof = createNativeCoreRevisionProof(state, revision, ROOT_HASH, registryFingerprint);
  return {
    revision,
    stateVersion: 47,
    mode: "normal",
    activePlanetId: state.activePlanetId,
    elapsedSeconds: state.elapsedSeconds,
    paused: state.paused,
    entityCount: state.entities.length,
    beltCount: state.belts.length,
    canonicalSha256: proof.canonicalSha256,
    canonicalComponents: { base: ROOT_HASH, entities: ROOT_HASH, belts: ROOT_HASH },
    canonicalFields: {},
    domainSha256: proof.domainSha256,
    catalogSha256: ROOT_HASH,
    registryFingerprint,
    memory: {
      rawRecordBytes: 0,
      indexedStringBytes: 0,
      inventoryEntryCount: 0,
      topologyIndexBytes: 0,
      estimatedRuntimeBytes: 0,
    },
    coverage: {} as DesktopNativeCoreSummary["coverage"],
  };
}

function fixture() {
  const runtime = createContentPackRuntimeSnapshot(createContentPackRegistry());
  const state = { ...createInitialState(), elapsedSeconds: 2, paused: false };
  const candidateState = { ...state, elapsedSeconds: state.elapsedSeconds + SETTLED_SECONDS };
  const sourceSummary = summary(state, REVISION, runtime.fingerprint);
  const candidateSummary = summary(candidateState, REVISION + 1, runtime.fingerprint);
  const transfer = serializeSaveEnvelopeToTransfer(candidateState, {
    formatVersion: 2,
    kind: "primary",
    savedAt: SAVED_AT + SETTLED_SECONDS * 1_000,
    mode: "normal",
    slot: "main",
  });
  const loaded: DeferredLoadedGame = {
    state,
    savedAt: SAVED_AT,
    offlineSeconds: SETTLED_SECONDS,
    offlineReport: null,
  };
  const closeNativeCore = vi.fn(async () => ({ closed: true }));
  const prepareNativeOfflineStartup = vi.fn(async (
    _request: DesktopNativeOfflineStartupRequest,
  ): Promise<DesktopNativeOfflineStartupResult> => ({
    prepared: true,
    strategy: "macro-v1",
    sourceSavedAtMs: SAVED_AT,
    settledAtMs: SAVED_AT + SETTLED_SECONDS * 1_000,
    settledSeconds: SETTLED_SECONDS,
    sourceSummary,
    candidateSummary,
    advance: {
      supported: true,
      exactScope: "offline-macro-v1",
      changed: true,
      previousRevision: REVISION,
      revision: REVISION + 1,
      algorithmVersion: "native-offline-macro-v1-closed-ledger-one-shot-v1",
      exactCalibrationSeconds: 30,
      approximatedSeconds: 0,
      summary: candidateSummary,
    },
    export: {
      exportId: "offlinecandidatefixed",
      mode: "normal",
      result: {
        revision: REVISION + 1,
        savedAtMs: SAVED_AT + SETTLED_SECONDS * 1_000,
        byteLength: transfer.byteLength,
        envelopeSha256: "b".repeat(64),
        stateChecksum: transfer.stateChecksum,
      },
      cancelled: false,
    },
    payloadBytes: transfer.bytes,
    payloadChecksum: transfer.payloadChecksum,
  }));
  const desktop = {
    getNativePerformanceStatus: vi.fn(async () => ({
      available: true,
      capabilities: ["native-core-offline-candidate-export-v1"],
    })),
    recoverNativeSave: vi.fn(async () => ({
      slot: "normal-main",
      generation: GENERATION,
      revision: REVISION,
      rootHash: ROOT_HASH,
      stateVersion: 47,
      mode: "normal",
      baseChecksum: "1234abcd",
      registryFingerprint: runtime.fingerprint,
      savedAtMs: SAVED_AT,
      recordKeys: ["base"],
      walEntryCount: 0,
    })),
    openNativeCore: vi.fn(async () => ({
      sessionId: "core-session-7",
      authority: "shadow",
      checkpointRevision: REVISION,
      replayedWalEntries: 0,
      replayedRevision: REVISION,
      summary: sourceSummary,
    })),
    prepareNativeOfflineStartup,
    closeNativeCore,
  } as unknown as DesktopBridge;
  return {
    runtime,
    state,
    candidateState,
    loaded,
    desktop,
    transfer,
    closeNativeCore,
    prepareNativeOfflineStartup,
  };
}

describe("Windows native offline startup", () => {
  async function sourceFixture() {
    const current = fixture();
    const status = await current.desktop.getNativePerformanceStatus();
    current.desktop.getNativePerformanceStatus = vi.fn(async () => ({ ...status,
      capabilities: [...status.capabilities, "native-core-offline-runtime-source-export-v1"],
    }));
    const original = await current.prepareNativeOfflineStartup({} as DesktopNativeOfflineStartupRequest);
    if (!original.prepared) throw new Error("fixture must contain a candidate");
    current.prepareNativeOfflineStartup.mockClear();
    const sourceSummary = summary(current.state, 0, current.runtime.fingerprint);
    const candidateSummary = summary(current.candidateState, 1, current.runtime.fingerprint);
    const candidate = { ...original, sourceSummary, candidateSummary,
      advance: { ...original.advance, previousRevision: 0, revision: 1, summary: candidateSummary },
      export: { ...original.export, result: { ...original.export.result, revision: 1 } },
    };
    const chunks: Uint8Array[] = [];
    const write = vi.fn(async (chunk: ArrayBuffer) => { chunks.push(new Uint8Array(chunk)); });
    const finish = vi.fn(async (_proof: { expectedCanonicalSha256: string; expectedDomainSha256: string }) => candidate);
    const cancel = vi.fn();
    const start = vi.fn(() => ({ write, finish, cancel }));
    current.desktop.startNativeOfflineSourceStartup = start;
    return { ...current, chunks, write, finish, cancel, start, candidate };
  }

  it("uses the verified loaded runtime without reading or adopting any native checkpoint", async () => {
    const current = await sourceFixture();
    const result = await tryNativeOfflineStartupSettlement({ loaded: current.loaded, runtime: current.runtime }, { desktop: current.desktop });
    expect(result.status).toBe("complete");
    if (result.status !== "complete") throw new Error("expected a candidate");
    expect(result.state).toEqual(JSON.parse(JSON.stringify(current.candidateState)));
    expect(current.desktop.recoverNativeSave).not.toHaveBeenCalled();
    expect(current.desktop.openNativeCore).not.toHaveBeenCalled();
    expect(current.prepareNativeOfflineStartup).not.toHaveBeenCalled();
    expect(current.closeNativeCore).not.toHaveBeenCalled();
    expect(current.cancel).toHaveBeenCalled();
    const bytes = new Uint8Array(current.chunks.reduce((sum, chunk) => sum + chunk.length, 0));
    let offset = 0;
    for (const chunk of current.chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const source = JSON.parse(new TextDecoder().decode(bytes));
    expect(source.state).toEqual(JSON.parse(JSON.stringify(current.loaded.state)));
    expect(source.savedAt).toBe(current.loaded.savedAt);
    expect(current.finish).toHaveBeenCalledWith({
      expectedCanonicalSha256: current.candidate.sourceSummary.canonicalSha256,
      expectedDomainSha256: current.candidate.sourceSummary.domainSha256,
    });
  });

  it("binds an orphan-recovered source to its earlier checkpoint and combined wall interval once", async () => {
    const current = await sourceFixture();
    const orphan: DeferredLoadedGame = {
      ...current.loaded,
      savedAt: SAVED_AT + 5_000,
      offlineSeconds: SETTLED_SECONDS - 5,
      state: {
        ...current.state,
        timeWarp: { ...current.state.timeWarp, enabled: true, pendingWallSeconds: 5, pendingSimulationSeconds: 40 },
        idleSettlement: { ...current.state.idleSettlement, currentRunStartedAt: SAVED_AT },
      },
    };
    const original = JSON.stringify(orphan);
    // StartMenu performs this only after excluding a matching live journal.
    const recovered = recoverOrphanedTimeWarpForOffline(orphan);
    if (!recovered.ok) throw new Error("expected orphan recovery");
    expect(recovered.loaded).toEqual(current.loaded);
    expect(recovered.summary).toMatchObject({
      recoveredPendingWallSeconds: 5,
      discardedPendingSimulationSeconds: 40,
      submittedOfflineSeconds: SETTLED_SECONDS,
    });
    const repeated = recoverOrphanedTimeWarpForOffline(recovered.loaded);
    if (!repeated.ok) throw new Error("expected idempotent recovery");
    expect(repeated.loaded).toBe(recovered.loaded);
    const result = await tryNativeOfflineStartupSettlement({ loaded: repeated.loaded, runtime: current.runtime }, { desktop: current.desktop });
    if (result.status !== "complete") throw new Error("expected recovered candidate");
    expect(result.state).toEqual(JSON.parse(JSON.stringify(current.candidateState)));
    expect(result.loaded.savedAt).toBe(SAVED_AT);
    expect(result.loaded.offlineSeconds).toBe(SETTLED_SECONDS);
    expect(current.start).toHaveBeenCalledOnce();
    expect(current.start).toHaveBeenCalledWith(expect.objectContaining({ sourceSavedAtMs: SAVED_AT }));
    const source = JSON.parse(new TextDecoder().decode(Buffer.concat(current.chunks)));
    expect(source.savedAt).toBe(SAVED_AT);
    expect(source.state).toEqual(JSON.parse(JSON.stringify(current.state)));
    expect(current.finish).toHaveBeenCalledWith({
      expectedCanonicalSha256: current.candidate.sourceSummary.canonicalSha256,
      expectedDomainSha256: current.candidate.sourceSummary.domainSha256,
    });
    expect(JSON.stringify(orphan)).toBe(original);
  });

  it("retains the complete recovered interval when pending wall time crosses the native limit", async () => {
    const current = await sourceFixture();
    const orphan: DeferredLoadedGame = {
      ...current.loaded,
      savedAt: SAVED_AT + 6_000,
      offlineSeconds: SETTLED_SECONDS - 5,
      state: { ...current.state, timeWarp: { ...current.state.timeWarp, enabled: true, pendingWallSeconds: 6, pendingSimulationSeconds: 48 } },
    };
    const original = JSON.stringify(orphan);
    const recovered = recoverOrphanedTimeWarpForOffline(orphan);
    if (!recovered.ok) throw new Error("expected orphan recovery");
    const prepared = JSON.stringify(recovered.loaded);
    expect(recovered.loaded.offlineSeconds).toBe(31);
    expect(recovered.loaded.savedAt).toBe(SAVED_AT);
    const result = await tryNativeOfflineStartupSettlement({ loaded: recovered.loaded, runtime: current.runtime }, { desktop: current.desktop });
    expect(result.status).toBe("fallback");
    expect(current.start).not.toHaveBeenCalled();
    expect(current.prepareNativeOfflineStartup).not.toHaveBeenCalled();
    expect(current.desktop.recoverNativeSave).not.toHaveBeenCalled();
    expect(JSON.stringify(recovered.loaded)).toBe(prepared);
    expect(JSON.stringify(orphan)).toBe(original);
  });

  it("cancels source upload without calculating or mutating the original loaded state", async () => {
    const current = await sourceFixture();
    const original = JSON.stringify(current.loaded);
    const controller = new AbortController();
    current.write.mockImplementationOnce(async () => { controller.abort(); });
    const result = await tryNativeOfflineStartupSettlement({ loaded: current.loaded, runtime: current.runtime, signal: controller.signal }, { desktop: current.desktop });
    expect(result.status).toBe("fallback");
    expect(current.finish).not.toHaveBeenCalled();
    expect(current.cancel).toHaveBeenCalled();
    expect(JSON.stringify(current.loaded)).toBe(original);
  });

  it("discards a temporary candidate with a changed full source proof", async () => {
    const current = await sourceFixture();
    current.candidate.sourceSummary.canonicalSha256 = "0".repeat(64);
    const result = await tryNativeOfflineStartupSettlement({ loaded: current.loaded, runtime: current.runtime }, { desktop: current.desktop });
    expect(result.status).toBe("fallback");
    expect(current.cancel).toHaveBeenCalled();
    expect(current.closeNativeCore).not.toHaveBeenCalled();
  });

  it("retains the original loaded state when temporary Host or cleanup fails", async () => {
    const current = await sourceFixture();
    const original = JSON.stringify(current.loaded);
    current.finish.mockRejectedValueOnce(new Error("temporary Host cleanup failed"));
    expect(await tryNativeOfflineStartupSettlement({ loaded: current.loaded, runtime: current.runtime }, { desktop: current.desktop })).toMatchObject({ status: "fallback" });
    expect(current.cancel).toHaveBeenCalled();
    expect(JSON.stringify(current.loaded)).toBe(original);
  });

  it("keeps productive long intervals on the JS decision path without opening a native candidate", async () => {
    const current = fixture();
    current.loaded.offlineSeconds = 600;
    const original = structuredClone(current.loaded.state);
    const result = await tryNativeOfflineStartupSettlement({ loaded: current.loaded, runtime: current.runtime }, { desktop: current.desktop });
    expect(result).toMatchObject({ status: "fallback", reason: expect.stringContaining("产出一致性") });
    expect(current.desktop.openNativeCore).not.toHaveBeenCalled();
    expect(current.prepareNativeOfflineStartup).not.toHaveBeenCalled();
    expect(current.loaded.state).toEqual(original);
  });
  it("adopts a verified read-only candidate and closes the source session", async () => {
    const current = fixture();
    let now = 10;
    const progress: string[] = [];
    const result = await tryNativeOfflineStartupSettlement({
      loaded: current.loaded,
      runtime: current.runtime,
      onProgress: (phase) => progress.push(phase),
    }, {
      desktop: current.desktop,
      monotonicNow: () => now += 5,
    });

    expect(result.status).toBe("complete");
    if (result.status !== "complete") return;
    expect(result.state).toEqual(current.candidateState);
    expect(result.loaded.offlineSeconds).toBe(SETTLED_SECONDS);
    expect(result.approximation).toMatchObject({
      mode: "exact",
      calibrationWindowSeconds: 30,
      approximatedSeconds: 0,
      maxEstimatedError: 0,
      settlementStatus: "bounded-exact",
    });
    expect(progress).toEqual(["checking", "calculating", "verifying"]);
    expect(current.closeNativeCore).toHaveBeenCalledWith({ sessionId: "core-session-7" });
    const request = current.prepareNativeOfflineStartup.mock.calls[0][0];
    expect(request).not.toHaveProperty("observedNowMs");
    expect(request).not.toHaveProperty("exportId");
    expect(request.expectedRevision).toBe(REVISION);
  });

  it("rejects a supported but frozen tail from an older Host", async () => {
    const current = fixture();
    const result = await current.prepareNativeOfflineStartup({} as DesktopNativeOfflineStartupRequest);
    if (!result.prepared) throw new Error("missing test candidate");
    result.advance.approximatedSeconds = 1;
    current.prepareNativeOfflineStartup.mockResolvedValueOnce(result);
    expect(await tryNativeOfflineStartupSettlement({ loaded: current.loaded, runtime: current.runtime }, { desktop: current.desktop })).toMatchObject({ status: "fallback" });
    expect(current.closeNativeCore).toHaveBeenCalledOnce();
  });

  it("falls back before opening when the native savedAt differs", async () => {
    const current = fixture();
    vi.mocked(current.desktop.recoverNativeSave).mockResolvedValueOnce({
      ...(await current.desktop.recoverNativeSave({ slot: "normal-main" }))!,
      savedAtMs: SAVED_AT + 1,
    });
    const result = await tryNativeOfflineStartupSettlement({
      loaded: current.loaded,
      runtime: current.runtime,
    }, { desktop: current.desktop, monotonicNow: () => 1 });
    expect(result).toMatchObject({ status: "fallback" });
    expect(current.desktop.openNativeCore).not.toHaveBeenCalled();
    expect(current.prepareNativeOfflineStartup).not.toHaveBeenCalled();
  });

  it("discards a corrupted candidate and still closes the source session", async () => {
    const current = fixture();
    current.prepareNativeOfflineStartup.mockImplementationOnce(async () => {
      const valid = await fixture().prepareNativeOfflineStartup({} as DesktopNativeOfflineStartupRequest);
      if (!valid.prepared) return valid;
      return { ...valid, payloadChecksum: "00000000" };
    });
    const result = await tryNativeOfflineStartupSettlement({
      loaded: current.loaded,
      runtime: current.runtime,
    }, { desktop: current.desktop, monotonicNow: () => 1 });
    expect(result).toMatchObject({ status: "fallback" });
    expect(current.closeNativeCore).toHaveBeenCalledTimes(1);
  });

  it("does not enter native settlement for paused, speedrun, or non-v47 states", async () => {
    const invalidStates: GameState[] = [
      { ...fixture().state, paused: true },
      { ...fixture().state, mode: "speedrun" as const },
      { ...fixture().state, version: 46 as const },
    ];
    for (const state of invalidStates) {
      const current = fixture();
      const result = await tryNativeOfflineStartupSettlement({
        loaded: { ...current.loaded, state },
        runtime: current.runtime,
      }, { desktop: current.desktop, monotonicNow: () => 1 });
      expect(result.status).toBe("fallback");
      expect(current.desktop.getNativePerformanceStatus).not.toHaveBeenCalled();
    }
  });
});
