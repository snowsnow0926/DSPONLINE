import {
  getDesktopBridge,
  type DesktopBridge,
  type DesktopNativeCoreSummary,
  type DesktopNativeOfflineStartupResult,
} from "../desktop";
import { getOfflineSimulationLimitSeconds } from "./endgame";
import { createNativeCoreCatalog } from "./nativeCoreCatalog";
import { createNativeCoreRevisionProof, canonicalNativeCoreSha256, nativeCoreDomainSha256 } from "./nativeCoreProof";
import { streamNativeOfflineSourceEnvelope } from "./nativeOfflineSource";
import { decodeVerifiedSaveTransfer, type SaveTransferVerification } from "./saveTransfer";
import {
  parseTrustedWorkerEnvelope,
  type DeferredLoadedGame,
} from "./storage";
import type { ContentPackRuntimeSnapshot } from "./contentPacks";
import type { OfflineApproximationReport } from "./offlineApproximation";
import type { GameState } from "./types";

const NATIVE_OFFLINE_CANDIDATE_CAPABILITY =
  "native-core-offline-candidate-export-v1";
const COMPLETE_CANDIDATE_CAPABILITY = "native-core-offline-complete-candidate-v1";
const COMPLETE_OFFLINE_ALGORITHM = "native-offline-macro-v1-closed-ledger-one-shot-v3-state-parity";
const MAX_LONG_OFFLINE_SECONDS = 8 * 60 * 60;
const MAX_LONG_OFFLINE_RECORDS = 2_000;

type NativeOfflineDesktopBridge = Pick<DesktopBridge,
  | "getNativePerformanceStatus"
  | "recoverNativeSave"
  | "openNativeCore"
  | "prepareNativeOfflineStartup"
  | "startNativeOfflineSourceStartup"
  | "closeNativeCore"
>;

export type NativeOfflineStartupProgressPhase =
  | "checking"
  | "calculating"
  | "verifying";

export type NativeOfflineStartupAttempt =
  | {
    status: "complete";
    state: GameState;
    loaded: DeferredLoadedGame;
    approximation: OfflineApproximationReport;
  }
  | {
    status: "fallback";
    reason: string;
  };

export interface NativeOfflineStartupDependencies {
  desktop?: NativeOfflineDesktopBridge | null;
  monotonicNow?: () => number;
}

function fallback(reason: string): NativeOfflineStartupAttempt {
  return { status: "fallback", reason };
}

function validSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function sourceSummaryMatches(
  summary: DesktopNativeCoreSummary,
  input: {
    revision: number;
    registryFingerprint: string;
    canonicalSha256: string;
    domainSha256: string;
    state: GameState;
  },
): boolean {
  return summary.revision === input.revision && summary.stateVersion === 47 &&
    summary.mode === "normal" && summary.paused === false &&
    summary.registryFingerprint === input.registryFingerprint &&
    summary.canonicalSha256 === input.canonicalSha256 &&
    summary.domainSha256 === input.domainSha256 &&
    summary.activePlanetId === input.state.activePlanetId &&
    summary.entityCount === input.state.entities.length &&
    summary.beltCount === input.state.belts.length &&
    Math.abs(summary.elapsedSeconds - input.state.elapsedSeconds) <= 0.000001;
}

function nativeOfflineApproximationReport(
  settledSeconds: number,
  exactCalibrationSeconds: number | undefined,
  approximatedSeconds: number | undefined,
  algorithmVersion: string | undefined,
  wallClockMs: number,
  fullStateProven: boolean,
): OfflineApproximationReport {
  const calibration = Math.max(
    0,
    Math.min(settledSeconds, exactCalibrationSeconds ?? Math.min(30, settledSeconds)),
  );
  const approximated = Math.max(
    0,
    Math.min(settledSeconds - calibration, approximatedSeconds ?? settledSeconds - calibration),
  );
  const exact = approximated === 0;
  return {
    mode: exact ? "exact" : "approximate",
    calibrationWindowSeconds: calibration,
    approximatedSeconds: approximated,
    // Macro time remains distinct from one-second calibration. Only the
    // complete physical/history proof closes every state field in this tail.
    maxEstimatedError: exact || fullStateProven ? 0 : 1,
    maxNonCriticalError: exact || fullStateProven ? 0 : 1,
    fellBack: false,
    ...(algorithmVersion ? { algorithmVersion } : {}),
    validationScope: fullStateProven ? "all-state" : "leaderboard-critical",
    settlementStatus: exact ? "bounded-exact" : "approximate",
    wallClockMs,
  };
}

/**
 * Attempts the Windows-only read-only startup path. Every mismatch returns a
 * fallback result so the existing JavaScript Worker can run from the original
 * DeferredLoadedGame. No error path publishes or mutates the Rust checkpoint.
 */
export async function tryNativeOfflineStartupSettlement(input: {
  loaded: DeferredLoadedGame;
  runtime: ContentPackRuntimeSnapshot;
  signal?: AbortSignal;
  onProgress?: (phase: NativeOfflineStartupProgressPhase) => void;
}, dependencies: NativeOfflineStartupDependencies = {}): Promise<NativeOfflineStartupAttempt> {
  const { loaded, runtime } = input;
  // Match the existing 30-step/60,000-record-step probe admission. Host also
  // independently checks raw/runtime memory before any long calibration.
  if (loaded.offlineSeconds > 30 && (loaded.offlineSeconds > MAX_LONG_OFFLINE_SECONDS ||
      loaded.state.entities.length + loaded.state.belts.length > MAX_LONG_OFFLINE_RECORDS)) {
    return fallback("当前长时存档超出原生完整结算预算，使用现有结算流程");
  }
  if (loaded.offlineSeconds < 1 || loaded.state.version !== 47 ||
      loaded.state.mode !== "normal" || loaded.state.speedrun?.enabled ||
      loaded.state.paused || !Number.isSafeInteger(loaded.savedAt) ||
      loaded.savedAt < 0 || !runtime.fingerprint) {
    return fallback("当前存档不符合 Windows 原生离线候选条件");
  }
  const desktop = Object.hasOwn(dependencies, "desktop")
    ? dependencies.desktop
    : getDesktopBridge();
  if (!desktop || (!desktop.prepareNativeOfflineStartup && !desktop.startNativeOfflineSourceStartup)) {
    return fallback("当前 Windows 外壳未提供原生离线候选能力");
  }
  const startedAt = dependencies.monotonicNow?.() ?? performance.now();
  let sessionId: string | null = null;
  let outcome: NativeOfflineStartupAttempt;
  input.onProgress?.("checking");
  try {
    const status = await desktop.getNativePerformanceStatus();
    const useRuntimeSource = desktop.startNativeOfflineSourceStartup &&
      status.capabilities.includes("native-core-offline-runtime-source-export-v1");
    if (!status.available || (!useRuntimeSource && !status.capabilities.includes(NATIVE_OFFLINE_CANDIDATE_CAPABILITY))) {
      return fallback("Windows 原生 Host 不支持本次离线候选");
    }
    const hasCompleteCandidate = status.capabilities.includes(COMPLETE_CANDIDATE_CAPABILITY);
    if (loaded.offlineSeconds > 30 && !hasCompleteCandidate) {
      return fallback("当前原生 Host 未提供长时产出一致性证明，使用现有结算流程");
    }
    input.signal?.throwIfAborted();
    let sourceRevision = 0;
    let sourceProof: { canonicalSha256: string; domainSha256: string };
    let result: DesktopNativeOfflineStartupResult;
    if (useRuntimeSource) {
      // Main anchors the clock before encoding or the full-state proof. The
      // temporary revision has no relationship to a persistent Native slot.
      const transfer = desktop.startNativeOfflineSourceStartup!({
        registryFingerprint: runtime.fingerprint,
        catalog: createNativeCoreCatalog(runtime),
        sourceSavedAtMs: loaded.savedAt,
      });
      const cancel = () => transfer.cancel();
      input.signal?.addEventListener("abort", cancel, { once: true });
      try {
        for (const chunk of streamNativeOfflineSourceEnvelope(loaded.state, loaded.savedAt)) {
          input.signal?.throwIfAborted();
          await transfer.write(chunk);
        }
        input.signal?.throwIfAborted();
        sourceProof = {
          canonicalSha256: canonicalNativeCoreSha256(loaded.state),
          domainSha256: nativeCoreDomainSha256(loaded.state, 0),
        };
        input.signal?.throwIfAborted();
        input.onProgress?.("calculating");
        result = await transfer.finish({
          expectedCanonicalSha256: sourceProof.canonicalSha256,
          expectedDomainSha256: sourceProof.domainSha256,
        });
      } finally {
        input.signal?.removeEventListener("abort", cancel);
        transfer.cancel();
      }
    } else {
      if (!desktop.prepareNativeOfflineStartup) return fallback("当前外壳缺少原生离线检查点接口");
      const recovery = await desktop.recoverNativeSave({ slot: "normal-main" });
      if (!recovery || recovery.slot !== "normal-main" || recovery.mode !== "normal" ||
          recovery.stateVersion !== 47 || recovery.generation < 1 || recovery.revision < 0 ||
          !validSha256(recovery.rootHash) || recovery.registryFingerprint !== runtime.fingerprint ||
          recovery.savedAtMs !== loaded.savedAt || recovery.walEntryCount !== 0) {
        return fallback("原生检查点与当前普通主存档不完全一致");
      }
      sourceRevision = recovery.revision;
      sourceProof = createNativeCoreRevisionProof(
        loaded.state,
        recovery.revision,
        recovery.rootHash,
        runtime.fingerprint,
      );
      const opened = await desktop.openNativeCore({
        slot: "normal-main",
        generation: recovery.generation,
        rootHash: recovery.rootHash,
        revision: recovery.revision,
        registryFingerprint: runtime.fingerprint,
        catalog: createNativeCoreCatalog(runtime),
      });
      sessionId = opened.sessionId;
      if (opened.authority !== "shadow" || opened.checkpointRevision !== recovery.revision ||
          opened.replayedWalEntries !== 0 || opened.replayedRevision !== recovery.revision ||
          !sourceSummaryMatches(opened.summary, {
            revision: recovery.revision,
            registryFingerprint: runtime.fingerprint,
            canonicalSha256: sourceProof.canonicalSha256,
            domainSha256: sourceProof.domainSha256,
            state: loaded.state,
          })) {
        throw new Error("native source proof changed while opening");
      }

      input.onProgress?.("calculating");
      result = await desktop.prepareNativeOfflineStartup({
        sessionId,
        expectedGeneration: recovery.generation,
        expectedRootHash: recovery.rootHash,
        expectedRevision: recovery.revision,
        expectedRegistryFingerprint: runtime.fingerprint,
        expectedCanonicalSha256: sourceProof.canonicalSha256,
        expectedDomainSha256: sourceProof.domainSha256,
        strategy: "macro-v1",
      });
    }
    input.signal?.throwIfAborted();
    if (!result.prepared) {
      outcome = fallback(result.reason || "Rust 无法为当前存档证明守恒尾段");
    } else {
      input.onProgress?.("verifying");
      const maximumOfflineSeconds = getOfflineSimulationLimitSeconds(loaded.state);
      const boundedExact = result.settledSeconds <= 30 && result.advance.exactScope === "pure-idle-bounded-exact" &&
        result.advance.approximatedSeconds === 0 && result.advance.exactCalibrationSeconds === result.settledSeconds;
      const longVersion = hasCompleteCandidate && result.settledSeconds > 30 && result.settledSeconds <= MAX_LONG_OFFLINE_SECONDS &&
        result.advance.algorithmVersion === COMPLETE_OFFLINE_ALGORITHM;
      const completeTail = longVersion && (
        result.advance.exactScope === "offline-state-proven" && result.advance.exactCalibrationSeconds === 30 &&
          result.advance.approximatedSeconds === result.settledSeconds - 30 ||
        result.advance.exactScope === "offline-boundary-exact" && result.advance.exactCalibrationSeconds === result.settledSeconds &&
          result.advance.approximatedSeconds === 0);
      if (!result.advance.supported || (!boundedExact && !completeTail) ||
          result.sourceSavedAtMs !== loaded.savedAt || result.settledSeconds < 1 ||
          result.settledSeconds > maximumOfflineSeconds ||
          result.settledAtMs !== result.sourceSavedAtMs + result.settledSeconds * 1_000 ||
          !sourceSummaryMatches(result.sourceSummary, {
            revision: sourceRevision,
            registryFingerprint: runtime.fingerprint,
            canonicalSha256: sourceProof.canonicalSha256,
            domainSha256: sourceProof.domainSha256,
            state: loaded.state,
          }) || !(result.payloadBytes instanceof ArrayBuffer) ||
          result.payloadBytes.byteLength !== result.export.result.byteLength ||
          typeof result.payloadChecksum !== "string" || !/^[a-f0-9]{8}$/.test(result.payloadChecksum)) {
        throw new Error("native offline result source binding changed");
      }
      const verification: SaveTransferVerification = {
        integrity: "valid",
        stateChecksum: result.export.result.stateChecksum,
        payloadChecksum: result.payloadChecksum,
        byteLength: result.export.result.byteLength,
      };
      const raw = decodeVerifiedSaveTransfer(result.payloadBytes, verification);
      const state = parseTrustedWorkerEnvelope(raw, verification, runtime.registry, {
        persistentProjection: false,
      });
      const candidateProof = {
        canonicalSha256: canonicalNativeCoreSha256(state),
        domainSha256: nativeCoreDomainSha256(state, result.candidateSummary.revision),
      };
      const expectedElapsedSeconds = loaded.state.elapsedSeconds + result.settledSeconds;
      if (!sourceSummaryMatches(result.candidateSummary, {
        revision: result.candidateSummary.revision,
        registryFingerprint: runtime.fingerprint,
        canonicalSha256: candidateProof.canonicalSha256,
        domainSha256: candidateProof.domainSha256,
        state,
      }) || result.advance.revision !== result.candidateSummary.revision ||
          result.advance.previousRevision !== sourceRevision ||
          result.export.result.revision !== result.candidateSummary.revision ||
          result.export.result.savedAtMs !== result.settledAtMs ||
          Math.abs(state.elapsedSeconds - expectedElapsedSeconds) > 0.000001) {
        throw new Error("native offline candidate state proof changed after transfer");
      }
      const endedAt = dependencies.monotonicNow?.() ?? performance.now();
      outcome = {
        status: "complete",
        state,
        loaded: {
          ...loaded,
          savedAt: result.sourceSavedAtMs,
          offlineSeconds: result.settledSeconds,
        },
        approximation: nativeOfflineApproximationReport(
          result.settledSeconds,
          result.advance.exactCalibrationSeconds,
          result.advance.approximatedSeconds,
          result.advance.algorithmVersion,
          Math.max(0, endedAt - startedAt),
          result.advance.exactScope === "offline-state-proven",
        ),
      };
    }
  } catch {
    outcome = fallback("Windows 原生离线候选未通过完整性门禁");
  }
  if (sessionId !== null) {
    try {
      const closed = await desktop.closeNativeCore({ sessionId });
      if (!closed.closed) return fallback("Windows 原生离线会话未能安全关闭");
    } catch {
      return fallback("Windows 原生离线会话关闭状态不确定");
    }
  }
  return outcome;
}
