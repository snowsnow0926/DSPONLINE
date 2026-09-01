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
import { createNativeCoreRevisionProof } from "./nativeCoreProof";
import { serializeSaveEnvelopeToTransfer } from "./saveTransfer";
import type { DeferredLoadedGame } from "./storage";
import type { GameState } from "./types";

const ROOT_HASH = "a".repeat(64);
const GENERATION = 3;
const REVISION = 9;
const SAVED_AT = 1_000;
const SETTLED_SECONDS = 60;

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
      approximatedSeconds: 30,
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
      mode: "approximate",
      calibrationWindowSeconds: 30,
      approximatedSeconds: 30,
      maxEstimatedError: 1,
      settlementStatus: "approximate",
    });
    expect(progress).toEqual(["checking", "calculating", "verifying"]);
    expect(current.closeNativeCore).toHaveBeenCalledWith({ sessionId: "core-session-7" });
    const request = current.prepareNativeOfflineStartup.mock.calls[0][0];
    expect(request).not.toHaveProperty("observedNowMs");
    expect(request).not.toHaveProperty("exportId");
    expect(request.expectedRevision).toBe(REVISION);
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
