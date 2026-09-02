import { describe, expect, it, vi } from "vitest";
import type {
  DesktopNativeCoreStatisticsProjectionResult,
  DesktopNativePlayerAuthorityClockState,
} from "../desktop";
import type { NativePlayerAuthorityClockSnapshot } from "./nativePlayerAuthorityClock";
import type { ProductionHistorySample } from "./types";
import {
  NATIVE_STATISTICS_MAX_ELAPSED_SECONDS,
  NativeStatisticsWorkspaceStore,
  createNativePlayerAuthorityStatisticsWorkspaceSource,
  selectNativeStatisticsWorkspaceAuthorityFrames,
  selectNativeStatisticsWorkspaceFrame,
  type NativeStatisticsWorkspaceIdentity,
} from "./nativeStatisticsWorkspaceStore";

const IDENTITY: NativeStatisticsWorkspaceIdentity = Object.freeze({
  sessionId: "session-1",
  runId: "run-1",
  revision: 7,
  registryFingerprint: "registry-a",
});

function sample(elapsedSeconds: number, production = 60): ProductionHistorySample {
  return {
    elapsedSeconds,
    sampleDurationSeconds: 1,
    productionPerMinute: { iron_ore: production },
    consumptionPerMinute: { iron_ore: 10 },
    inventory: { iron_ore: 100 },
    generationKw: 500,
    demandKw: 450,
  };
}

function projection(
  revision: number,
  samples: readonly ProductionHistorySample[] = [sample(revision)],
): DesktopNativeCoreStatisticsProjectionResult {
  return {
    schemaVersion: 1,
    projectionType: "statistics-v1",
    revision,
    window: { minElapsedSeconds: 0, maxElapsedSeconds: NATIVE_STATISTICS_MAX_ELAPSED_SECONDS },
    filters: { planetId: null, itemId: null },
    samples: [...samples],
    nextCursor: null,
  };
}

function source(
  identity: NativeStatisticsWorkspaceIdentity,
  read: () => Promise<DesktopNativeCoreStatisticsProjectionResult>,
) {
  return createNativePlayerAuthorityStatisticsWorkspaceSource({
    getNativeCoreStatisticsProjection: vi.fn(async (request) => {
      expect(request).toEqual({
        sessionId: identity.sessionId,
        runId: identity.runId,
        expectedRevision: identity.revision,
        expectedRegistryFingerprint: identity.registryFingerprint,
        minElapsedSeconds: 0,
        maxElapsedSeconds: NATIVE_STATISTICS_MAX_ELAPSED_SECONDS,
        cursor: 0,
        limit: 512,
      });
      return read();
    }),
  }, identity)!;
}

describe("NativeStatisticsWorkspaceStore", () => {
  it("keeps display lineage but withholds reads across the authority tick publication transient", () => {
    const activeFrame = (
      revision: number,
      overrides: Partial<DesktopNativePlayerAuthorityClockState> = {},
    ): DesktopNativePlayerAuthorityClockState => ({
      schemaVersion: 1,
      phase: "active",
      sessionId: "session-1",
      runId: "run-1",
      revision,
      acknowledgedSequence: revision,
      nextSequence: revision + 1,
      nextDeadlineMs: revision * 1_000,
      inFlight: false,
      currentOperation: null,
      queuedCommands: 0,
      lastErrorCode: null,
      ...overrides,
    });
    const confirmed17 = activeFrame(17);
    const snapshot = (
      currentFrame: DesktopNativePlayerAuthorityClockState,
      lastConfirmedFrame: DesktopNativePlayerAuthorityClockState | null = confirmed17,
    ): NativePlayerAuthorityClockSnapshot => ({
      availability: "ready",
      expectedSessionId: "session-1",
      currentFrame,
      lastConfirmedFrame,
    });

    expect(selectNativeStatisticsWorkspaceAuthorityFrames(snapshot(confirmed17), "session-1"))
      .toEqual({ displayFrame: confirmed17, readFrame: confirmed17 });
    const inFlight18 = activeFrame(18, { inFlight: true, currentOperation: "tick" });
    expect(selectNativeStatisticsWorkspaceAuthorityFrames(snapshot(inFlight18), "session-1"))
      .toEqual({ displayFrame: confirmed17, readFrame: null });
    const confirmed18 = activeFrame(18);
    expect(selectNativeStatisticsWorkspaceAuthorityFrames(snapshot(confirmed18, confirmed18), "session-1"))
      .toEqual({ displayFrame: confirmed18, readFrame: confirmed18 });

    expect(selectNativeStatisticsWorkspaceAuthorityFrames(
      snapshot(activeFrame(16, { inFlight: true, currentOperation: "tick" })),
      "session-1",
    )).toEqual({ displayFrame: null, readFrame: null });
    expect(selectNativeStatisticsWorkspaceAuthorityFrames(
      snapshot(activeFrame(18, { phase: "uncertain", lastErrorCode: "TICK_UNCERTAIN" })),
      "session-1",
    )).toEqual({ displayFrame: null, readFrame: null });
    expect(selectNativeStatisticsWorkspaceAuthorityFrames(
      snapshot(activeFrame(18, { runId: "run-2", inFlight: true, currentOperation: "tick" })),
      "session-1",
    )).toEqual({ displayFrame: null, readFrame: null });
  });

  it("publishes an exact identity-bound native history frame", async () => {
    const store = new NativeStatisticsWorkspaceStore();
    await expect(store.refresh(source(IDENTITY, async () => projection(7)), IDENTITY))
      .resolves.toBe("committed");

    expect(store.getSnapshot()).toMatchObject({ status: "ready", requestedRevision: 7 });
    expect(selectNativeStatisticsWorkspaceFrame(store.getSnapshot(), IDENTITY)).toMatchObject({
      sessionId: "session-1",
      runId: "run-1",
      revision: 7,
      registryFingerprint: "registry-a",
      source: "native-core",
    });
  });

  it("keeps an older verified frame only while a newer same-scope revision loads", async () => {
    const store = new NativeStatisticsWorkspaceStore();
    await store.refresh(source(IDENTITY, async () => projection(7)), IDENTITY);
    const nextIdentity = { ...IDENTITY, revision: 8 };
    expect(selectNativeStatisticsWorkspaceFrame(store.getSnapshot(), nextIdentity)?.revision).toBe(7);
    let resolveNext!: (value: DesktopNativeCoreStatisticsProjectionResult) => void;
    const pending = store.refresh(source(nextIdentity, () => new Promise((resolve) => {
      resolveNext = resolve;
    })), nextIdentity);

    expect(store.getSnapshot()).toMatchObject({ status: "loading", requestedRevision: 8 });
    expect(selectNativeStatisticsWorkspaceFrame(store.getSnapshot(), nextIdentity)?.revision).toBe(7);
    resolveNext(projection(8));
    await expect(pending).resolves.toBe("committed");
    expect(selectNativeStatisticsWorkspaceFrame(store.getSnapshot(), nextIdentity)?.revision).toBe(8);
  });

  it("synchronously rejects an old frame on run or registry changes", async () => {
    const store = new NativeStatisticsWorkspaceStore();
    await store.refresh(source(IDENTITY, async () => projection(7)), IDENTITY);

    const nextRun = { ...IDENTITY, runId: "run-2", revision: 8 };
    expect(selectNativeStatisticsWorkspaceFrame(store.getSnapshot(), nextRun)).toBeNull();
    const runRefresh = store.refresh(source(nextRun, async () => projection(8)), nextRun);
    expect(store.getSnapshot().frame).toBeNull();
    await runRefresh;

    const nextRegistry = { ...nextRun, registryFingerprint: "registry-b", revision: 9 };
    expect(selectNativeStatisticsWorkspaceFrame(store.getSnapshot(), nextRegistry)).toBeNull();
    const registryRefresh = store.refresh(source(nextRegistry, async () => projection(9)), nextRegistry);
    expect(store.getSnapshot().frame).toBeNull();
    await registryRefresh;
  });

  it("hides and clears a higher cached revision on rollback", async () => {
    const store = new NativeStatisticsWorkspaceStore();
    const revision9 = { ...IDENTITY, revision: 9 };
    await store.refresh(source(revision9, async () => projection(9)), revision9);
    const rollback = { ...IDENTITY, revision: 8 };

    expect(selectNativeStatisticsWorkspaceFrame(store.getSnapshot(), rollback)).toBeNull();
    const refresh = store.refresh(source(rollback, async () => projection(8)), rollback);
    expect(store.getSnapshot()).toMatchObject({ status: "loading", requestedRevision: 8, frame: null });
    await refresh;
  });

  it("invalidates a cached frame when an in-flight target revision rolls back", async () => {
    const store = new NativeStatisticsWorkspaceStore();
    await store.refresh(source(IDENTITY, async () => projection(7)), IDENTITY);
    const revision20 = { ...IDENTITY, revision: 20 };
    let resolveTwenty!: (value: DesktopNativeCoreStatisticsProjectionResult) => void;
    const lateTwenty = store.refresh(source(revision20, () => new Promise((resolve) => {
      resolveTwenty = resolve;
    })), revision20);
    expect(store.getSnapshot()).toMatchObject({ status: "loading", requestedRevision: 20 });

    const rollback19 = { ...IDENTITY, revision: 19 };
    expect(selectNativeStatisticsWorkspaceFrame(store.getSnapshot(), rollback19)).toBeNull();
    const recovery19 = store.refresh(source(rollback19, async () => projection(19)), rollback19);
    expect(store.getSnapshot()).toMatchObject({ status: "loading", requestedRevision: 19, frame: null });
    await expect(recovery19).resolves.toBe("committed");
    resolveTwenty(projection(20));
    await expect(lateTwenty).resolves.toBe("superseded");
    expect(selectNativeStatisticsWorkspaceFrame(store.getSnapshot(), rollback19)?.revision).toBe(19);
  });

  it("does not let a late older response replace a newer revision", async () => {
    const store = new NativeStatisticsWorkspaceStore();
    await store.refresh(source(IDENTITY, async () => projection(7)), IDENTITY);
    const revision8 = { ...IDENTITY, revision: 8 };
    let resolveEight!: (value: DesktopNativeCoreStatisticsProjectionResult) => void;
    const oldFlight = store.refresh(source(revision8, () => new Promise((resolve) => {
      resolveEight = resolve;
    })), revision8);
    const revision9 = { ...IDENTITY, revision: 9 };
    await expect(store.refresh(source(revision9, async () => projection(9)), revision9))
      .resolves.toBe("committed");

    resolveEight(projection(8));
    await expect(oldFlight).resolves.toBe("superseded");
    expect(selectNativeStatisticsWorkspaceFrame(store.getSnapshot(), revision9)?.revision).toBe(9);
  });

  it("keeps only the verified same-scope frame after a failed refresh and clears it on close", async () => {
    const store = new NativeStatisticsWorkspaceStore();
    await store.refresh(source(IDENTITY, async () => projection(7)), IDENTITY);
    const revision8 = { ...IDENTITY, revision: 8 };
    const invalid = projection(8);
    invalid.nextCursor = 1;
    await expect(store.refresh(source(revision8, async () => invalid), revision8))
      .resolves.toBe("unavailable");
    expect(store.getSnapshot()).toMatchObject({ status: "unavailable", frame: { revision: 7 } });
    expect(selectNativeStatisticsWorkspaceFrame(store.getSnapshot(), revision8)?.revision).toBe(7);

    store.close();
    expect(store.getSnapshot()).toMatchObject({ status: "empty", requestedRevision: null, frame: null });
  });
});
