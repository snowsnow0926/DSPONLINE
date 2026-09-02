// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  DesktopBridge,
  DesktopNativeCoreProjectionTransferResult,
  DesktopNativeCoreSummary,
  DesktopNativeSaveCommitResult,
} from "../desktop";
import type { ContentPackRuntimeSnapshot } from "./contentPacks";
import { openWindowsNativeCoreShadow } from "./nativeCore";

const FINGERPRINT = "builtin:stellar-v2-test";

const checkpoint: DesktopNativeSaveCommitResult = {
  slot: "normal-main",
  generation: 1,
  revision: 7,
  rootHash: "a".repeat(64),
  recordCount: 1,
  changedRecords: 1,
  changedBytes: 1,
  totalUncompressedBytes: 1,
};

const runtime = {
  protocolVersion: 1,
  fingerprint: FINGERPRINT,
  registry: { version: 1, packs: {} },
} as ContentPackRuntimeSnapshot;

const summary = {
  revision: checkpoint.revision,
  stateVersion: 47,
  mode: "normal",
  activePlanetId: "home",
  elapsedSeconds: 0,
  paused: true,
  entityCount: 0,
  beltCount: 0,
  canonicalSha256: "b".repeat(64),
  canonicalComponents: { base: "b".repeat(64), entities: "b".repeat(64), belts: "b".repeat(64) },
  canonicalFields: {},
  domainSha256: "c".repeat(64),
  catalogSha256: "d".repeat(64),
  registryFingerprint: FINGERPRINT,
  memory: {
    rawRecordBytes: 0,
    indexedStringBytes: 0,
    inventoryEntryCount: 0,
    topologyIndexBytes: 0,
    estimatedRuntimeBytes: 0,
  },
  coverage: { authorityEligible: false },
} as DesktopNativeCoreSummary;

const request = {
  expectedRevision: checkpoint.revision,
  expectedRegistryFingerprint: FINGERPRINT,
  systemId: "helios",
  planetId: "home",
  planetCursor: 0,
  planetLimit: 16,
  stationCursor: 0,
  stationLimit: 16,
  routeCursor: 0,
  routeLimit: 16,
  routeFilter: "all" as const,
  query: "",
};

async function projectionTransfer(): Promise<DesktopNativeCoreProjectionTransferResult> {
  const value = {
    schemaVersion: 2,
    projectionType: "stellar-industry-v2",
    revision: checkpoint.revision,
    registryFingerprint: FINGERPRINT,
    stateVersion: 47,
  };
  const encoded = new TextEncoder().encode(JSON.stringify(value));
  const bodyBuffer = new ArrayBuffer(encoded.byteLength);
  new Uint8Array(bodyBuffer).set(encoded);
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bodyBuffer));
  const sha256 = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return {
    header: {
      schemaVersion: 1,
      sessionId: "core-stellar-v2",
      revision: checkpoint.revision,
      sequence: 1,
      projectionType: "stellar-industry-v2",
      payloadLength: bodyBuffer.byteLength,
      sha256,
    },
    bodyBuffer,
  };
}

function bridge(overrides: Partial<DesktopBridge> = {}): DesktopBridge {
  return {
    getNativePerformanceStatus: vi.fn(async () => ({
      available: true,
      state: "ready" as const,
      message: "ready",
      capabilities: ["native-core-shadow-v1"],
    })),
    openNativeCore: vi.fn(async () => ({
      sessionId: "core-stellar-v2",
      authority: "shadow" as const,
      checkpointRevision: checkpoint.revision,
      replayedWalEntries: 0,
      replayedRevision: checkpoint.revision,
      summary,
    })),
    closeNativeCore: vi.fn(async () => ({ closed: true })),
    ...overrides,
  } as unknown as DesktopBridge;
}

async function openWithBridge(desktop: DesktopBridge) {
  Object.defineProperty(window, "dspDesktop", { configurable: true, value: desktop });
  const session = await openWindowsNativeCoreShadow("normal", checkpoint, runtime);
  if (!session) throw new Error("expected native core session");
  return session;
}

afterEach(() => {
  Reflect.deleteProperty(window, "dspDesktop");
});

describe("stellar industry v2 native core bridge", () => {
  it("prefers the bounded binary transfer over the direct bridge", async () => {
    const transfer = vi.fn(async () => projectionTransfer());
    const direct = vi.fn(async () => {
      throw new Error("direct bridge must not run");
    });
    const session = await openWithBridge(bridge({
      requestNativeCoreProjectionTransfer: transfer,
      getNativeCoreStellarIndustryV2Projection: direct,
    }));

    await expect(session.stellarIndustryV2Projection(request)).resolves.toMatchObject({
      schemaVersion: 2,
      projectionType: "stellar-industry-v2",
      revision: checkpoint.revision,
    });
    expect(transfer).toHaveBeenCalledWith({
      sessionId: "core-stellar-v2",
      projectionType: "stellar-industry-v2",
      payload: request,
    });
    expect(direct).not.toHaveBeenCalled();
  });

  it("fails closed when an older desktop shell exposes neither v2 transport", async () => {
    const legacyV1 = vi.fn(async () => {
      throw new Error("v1 must not substitute for v2");
    });
    const session = await openWithBridge(bridge({ getNativeCoreStellarIndustryProjection: legacyV1 }));
    await expect(session.stellarIndustryV2Projection(request)).rejects.toThrow(/v2 投影不可用/);
    expect(legacyV1).not.toHaveBeenCalled();
  });
});
