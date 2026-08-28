import { describe, expect, it, vi } from "vitest";

import type {
  DesktopBridge,
  DesktopNativePlayerAuthorityState,
} from "../desktop";
import {
  NativePlayerAuthorityClockController,
  createNativePlayerAuthorityProjectionSource,
  normalizeNativePlayerAuthorityClockFrame,
  selectActiveNativePlayerAuthorityFrame,
  selectBoundNativePlayerAuthorityFrame,
} from "./nativePlayerAuthorityClock";

function activeFrame(overrides: Partial<DesktopNativePlayerAuthorityState> = {}): DesktopNativePlayerAuthorityState {
  return {
    schemaVersion: 1,
    phase: "active",
    sessionId: "core-a",
    runId: "run-a",
    revision: 10,
    acknowledgedSequence: 4,
    nextSequence: 5,
    nextDeadlineMs: 10_000,
    inFlight: false,
    currentOperation: null,
    queuedCommands: 0,
    lastErrorCode: null,
    ...overrides,
  };
}

function clockFixture(initial = activeFrame()) {
  let pulled: unknown = initial;
  let listener: ((state: DesktopNativePlayerAuthorityState) => void) | null = null;
  const unsubscribe = vi.fn();
  const bridge = {
    getNativePlayerAuthorityState: vi.fn(async () => pulled as DesktopNativePlayerAuthorityState),
    onNativePlayerAuthorityState: vi.fn((next: (state: DesktopNativePlayerAuthorityState) => void) => {
      listener = next;
      return unsubscribe;
    }),
  };
  const controller = new NativePlayerAuthorityClockController(bridge);
  return {
    bridge,
    controller,
    unsubscribe,
    emit(value: unknown) { listener?.(value as DesktopNativePlayerAuthorityState); },
    setPulled(value: unknown) { pulled = value; },
  };
}

async function settlePromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("native player-authority clock validation", () => {
  it("accepts only the exact bounded schema and freezes the result", () => {
    const normalized = normalizeNativePlayerAuthorityClockFrame(activeFrame());
    expect(normalized).toEqual(activeFrame());
    expect(Object.isFrozen(normalized)).toBe(true);

    for (const malformed of [
      { ...activeFrame(), schemaVersion: 2 },
      { ...activeFrame(), ownerId: "main-player-authority" },
      { ...activeFrame(), runId: null },
      { ...activeFrame(), nextSequence: 9 },
      { ...activeFrame(), revision: Number.MAX_SAFE_INTEGER + 1 },
      { ...activeFrame(), phase: "active", lastErrorCode: "NATIVE_ERROR" },
      { ...activeFrame(), phase: "unknown" },
      { ...activeFrame(), queuedCommands: 65 },
      { ...activeFrame(), currentOperation: "save" },
      { ...activeFrame(), lastErrorCode: "not-public" },
    ]) {
      expect(() => normalizeNativePlayerAuthorityClockFrame(malformed)).toThrow(/native player-authority/i);
    }
  });

  it("accepts identity-free pre-authority and fault frames without manufacturing a session", () => {
    const identityFree = {
      ...activeFrame(),
      phase: "recovering" as const,
      sessionId: null,
      runId: null,
      revision: null,
      acknowledgedSequence: null,
      nextSequence: null,
      nextDeadlineMs: null,
      inFlight: true,
      currentOperation: "recovery" as const,
    };
    expect(normalizeNativePlayerAuthorityClockFrame(identityFree)).toEqual(identityFree);
    expect(normalizeNativePlayerAuthorityClockFrame({
      ...identityFree,
      phase: "faulted",
      inFlight: false,
      currentOperation: null,
      lastErrorCode: "NATIVE_PLAYER_AUTHORITY_RECOVERY_FAILED",
    }).sessionId).toBeNull();
  });
});

describe("NativePlayerAuthorityClockController", () => {
  it("subscribes before pulling and publishes one settled active frame for the bound session", async () => {
    const value = clockFixture();
    const notifications: number[] = [];
    value.controller.bindSession("core-a");
    value.controller.subscribe(() => notifications.push(notifications.length));
    value.controller.start();
    await settlePromises();

    expect(value.bridge.onNativePlayerAuthorityState).toHaveBeenCalledTimes(1);
    expect(value.bridge.getNativePlayerAuthorityState).toHaveBeenCalledTimes(1);
    expect(value.controller.getSnapshot()).toMatchObject({
      availability: "ready",
      expectedSessionId: "core-a",
      currentFrame: { phase: "active", sessionId: "core-a", revision: 10 },
      lastConfirmedFrame: { phase: "active", sessionId: "core-a", revision: 10 },
    });
    expect(selectActiveNativePlayerAuthorityFrame(value.controller.getSnapshot(), "core-a")?.revision).toBe(10);
    expect(notifications.length).toBeGreaterThan(0);
  });

  it("uses an active tick event to pull the settled next revision", async () => {
    const value = clockFixture();
    value.controller.bindSession("core-a");
    value.controller.start();
    await settlePromises();
    value.setPulled(activeFrame({
      revision: 11,
      acknowledgedSequence: 5,
      nextSequence: 6,
      nextDeadlineMs: 11_000,
    }));

    value.emit(activeFrame({
      revision: 11,
      acknowledgedSequence: 5,
      nextSequence: 6,
      nextDeadlineMs: 11_000,
      inFlight: true,
      currentOperation: "tick",
    }));
    expect(value.controller.getSnapshot().currentFrame).toMatchObject({ revision: 11, inFlight: true });
    expect(value.controller.getSnapshot().lastConfirmedFrame?.revision).toBe(10);
    expect(selectActiveNativePlayerAuthorityFrame(value.controller.getSnapshot(), "core-a")).toBeNull();

    await settlePromises();
    expect(value.bridge.getNativePlayerAuthorityState).toHaveBeenCalledTimes(2);
    expect(value.controller.getSnapshot().lastConfirmedFrame?.revision).toBe(11);
    expect(selectActiveNativePlayerAuthorityFrame(value.controller.getSnapshot(), "core-a")?.revision).toBe(11);
  });

  it("drops malformed, stale, regressing, cross-run and cross-session pushes", async () => {
    const value = clockFixture();
    value.controller.bindSession("core-a");
    value.controller.start();
    await settlePromises();
    const confirmed = value.controller.getSnapshot().lastConfirmedFrame;

    for (const rejected of [
      { ...activeFrame(), ownerId: "forbidden" },
      activeFrame({ revision: 9, acknowledgedSequence: 3, nextSequence: 4, nextDeadlineMs: 9_000 }),
      activeFrame({ revision: 12, acknowledgedSequence: 5, nextSequence: 6, nextDeadlineMs: 11_000 }),
      activeFrame({ sessionId: "core-b" }),
      activeFrame({ runId: "run-b" }),
    ]) value.emit(rejected);

    expect(value.controller.getSnapshot().currentFrame).toBe(confirmed);
    expect(value.controller.getSnapshot().lastConfirmedFrame).toBe(confirmed);
  });

  it("retains the last confirmed frame but stops projection on uncertain and faulted phases", async () => {
    for (const phase of ["uncertain", "faulted"] as const) {
      const value = clockFixture();
      value.controller.bindSession("core-a");
      value.controller.start();
      await settlePromises();
      value.emit(activeFrame({
        phase,
        lastErrorCode: phase === "uncertain"
          ? "NATIVE_PLAYER_AUTHORITY_TICK_UNCERTAIN"
          : "NATIVE_PLAYER_AUTHORITY_CLOCK_FAULTED",
      }));

      const snapshot = value.controller.getSnapshot();
      expect(snapshot.currentFrame?.phase).toBe(phase);
      expect(snapshot.lastConfirmedFrame?.revision).toBe(10);
      expect(selectBoundNativePlayerAuthorityFrame(snapshot, "core-a")?.phase).toBe(phase);
      expect(selectActiveNativePlayerAuthorityFrame(snapshot, "core-a")).toBeNull();
    }
  });

  it("requires an explicit rebind before another session can replace the frame", async () => {
    const value = clockFixture();
    value.controller.bindSession("core-a");
    value.controller.start();
    await settlePromises();
    value.emit(activeFrame({ sessionId: "core-b", runId: "run-b" }));
    expect(value.controller.getSnapshot().lastConfirmedFrame?.sessionId).toBe("core-a");

    value.setPulled(activeFrame({ sessionId: "core-b", runId: "run-b" }));
    value.controller.bindSession("core-b");
    await settlePromises();
    expect(value.controller.getSnapshot().lastConfirmedFrame?.sessionId).toBe("core-b");
  });

  it("feature-detects rollback hosts and invokes only its own unsubscribe", async () => {
    const unsupported = new NativePlayerAuthorityClockController({});
    unsupported.start();
    expect(unsupported.getSnapshot().availability).toBe("unsupported");

    const value = clockFixture();
    value.controller.bindSession("core-a");
    value.controller.start();
    await settlePromises();
    value.controller.stop();
    value.controller.stop();
    expect(value.unsubscribe).toHaveBeenCalledTimes(1);
  });
});

describe("native player-authority projection source", () => {
  it("injects only the bound session/revision into existing read-only projection calls", async () => {
    const getFactory = vi.fn(async (request) => ({
      revision: request.expectedRevision,
    }));
    const getViewport = vi.fn(async (request) => ({
      revision: request.expectedRevision,
    }));
    const source = createNativePlayerAuthorityProjectionSource({
      getNativeCoreFactoryReadModel: getFactory as unknown as DesktopBridge["getNativeCoreFactoryReadModel"],
      getNativeCoreViewportProjectionV2: getViewport as unknown as DesktopBridge["getNativeCoreViewportProjectionV2"],
    }, "core-a");
    expect(source).not.toBeNull();

    await source!.readVerifiedFactoryReadModel({ selectedEntityIds: ["entity-1"] }, 17);
    await source!.readVerifiedViewportProjectionV2({
      planetId: "planet-a",
      bounds: { minX: 0, minY: 0, maxX: 1, maxY: 1 },
      entityLimit: 1,
      beltLimit: 1,
    }, 17);

    expect(getFactory).toHaveBeenCalledWith({
      selectedEntityIds: ["entity-1"],
      sessionId: "core-a",
      expectedRevision: 17,
    });
    expect(getViewport).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "core-a",
      expectedRevision: 17,
      planetId: "planet-a",
    }));
    expect(Object.keys(source!)).toEqual([
      "readVerifiedFactoryReadModel",
      "readVerifiedViewportProjectionV2",
    ]);
  });

  it("fails closed for invalid sessions, revisions, transport failures and mismatched replies", async () => {
    expect(createNativePlayerAuthorityProjectionSource({
      getNativeCoreFactoryReadModel: vi.fn() as never,
      getNativeCoreViewportProjectionV2: vi.fn() as never,
    }, "bad/session")).toBeNull();

    const source = createNativePlayerAuthorityProjectionSource({
      getNativeCoreFactoryReadModel: vi.fn().mockResolvedValue({ revision: 19 }) as never,
      getNativeCoreViewportProjectionV2: vi.fn().mockRejectedValue(new Error("closed")) as never,
    }, "core-a")!;
    await expect(source.readVerifiedFactoryReadModel({}, 18)).resolves.toBeNull();
    await expect(source.readVerifiedViewportProjectionV2({
      planetId: "planet-a",
      bounds: { minX: 0, minY: 0, maxX: 1, maxY: 1 },
      entityLimit: 1,
      beltLimit: 1,
    }, 18)).resolves.toBeNull();
    await expect(source.readVerifiedFactoryReadModel({}, -1)).resolves.toBeNull();
  });
});
