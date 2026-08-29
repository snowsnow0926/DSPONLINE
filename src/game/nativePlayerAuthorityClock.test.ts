import { describe, expect, it, vi } from "vitest";

import type {
  DesktopBridge,
  DesktopNativePlayerAuthorityClockState,
  DesktopNativePlayerAuthorityMacroState,
  DesktopNativePlayerAuthorityState,
} from "../desktop";
import {
  NativePlayerAuthorityClockController,
  createNativePlayerAuthorityProjectionSource,
  normalizeNativePlayerAuthorityClockFrame,
  selectActiveNativePlayerAuthorityFrame,
  selectBoundNativePlayerAuthorityFrame,
  selectNativePlayerAuthorityMacroStatus,
} from "./nativePlayerAuthorityClock";

function activeFrame(
  overrides: Partial<DesktopNativePlayerAuthorityClockState> = {},
): DesktopNativePlayerAuthorityClockState {
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

function macroFrame(
  overrides: Partial<DesktopNativePlayerAuthorityMacroState> = {},
): DesktopNativePlayerAuthorityMacroState {
  return {
    schemaVersion: 2,
    statusKind: "macro",
    phase: "macro-active",
    revision: 12,
    acknowledgedSequence: 6,
    nextSequence: 7,
    nextDeadlineMs: 12_000,
    inFlight: false,
    currentOperation: null,
    simulationBudgetMilliseconds: 60_000,
    wallBudgetMilliseconds: 4_000,
    simulationProgressMilliseconds: 60_000,
    wallProgressMilliseconds: 4_000,
    pausedReason: "macro-window-active",
    ...overrides,
  };
}

function clockFixture(initial: DesktopNativePlayerAuthorityState = activeFrame()) {
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

  it("accepts only an active, bounded finish recovery hint and preserves it through pull", async () => {
    const hinted = activeFrame({
      revision: 12,
      acknowledgedSequence: 6,
      nextSequence: 7,
      nextDeadlineMs: 12_000,
      macroRecoveryHint: { kind: "finished-pending-disable", revision: 10 },
    });
    const normalized = normalizeNativePlayerAuthorityClockFrame(hinted);
    expect(normalized).toEqual(hinted);
    expect(Object.isFrozen(normalized)).toBe(true);
    expect(Object.isFrozen((normalized as DesktopNativePlayerAuthorityClockState).macroRecoveryHint))
      .toBe(true);

    for (const malformed of [
      { ...hinted, macroRecoveryHint: { kind: "unknown", revision: 10 } },
      { ...hinted, macroRecoveryHint: { kind: "finished-pending-disable", revision: 13 } },
      { ...hinted, macroRecoveryHint: { kind: "finished-pending-disable", revision: -1 } },
      { ...hinted, macroRecoveryHint: {
        kind: "finished-pending-disable", revision: 10, macroSessionId: "forged",
      } },
      { ...hinted, phase: "uncertain" as const },
    ]) {
      expect(() => normalizeNativePlayerAuthorityClockFrame(malformed))
        .toThrow(/macro recovery hint/i);
    }

    const value = clockFixture(hinted);
    value.controller.start();
    await settlePromises();
    expect(value.controller.getSnapshot().currentFrame).toEqual(hinted);
    expect(value.controller.getSnapshot().lastConfirmedFrame?.macroRecoveryHint)
      .toEqual({ kind: "finished-pending-disable", revision: 10 });
  });

  it("accepts bounded pause lifecycle frames and rejects impossible phase shapes", () => {
    for (const frame of [
      activeFrame({ phase: "pausing", inFlight: true, currentOperation: "pause" }),
      activeFrame({ phase: "paused" }),
      activeFrame({ phase: "resuming", inFlight: true, currentOperation: "resume" }),
      activeFrame({ phase: "pause-uncertain",
        lastErrorCode: "NATIVE_PLAYER_AUTHORITY_PAUSE_UNCERTAIN" }),
      activeFrame({ phase: "resume-uncertain", inFlight: true, currentOperation: "resume",
        lastErrorCode: "NATIVE_PLAYER_AUTHORITY_RESUME_UNCERTAIN" }),
    ]) {
      expect(normalizeNativePlayerAuthorityClockFrame(frame)).toEqual(frame);
    }
    for (const malformed of [
      activeFrame({ phase: "paused", inFlight: true }),
      activeFrame({ phase: "paused", currentOperation: "pause" }),
      activeFrame({ phase: "pausing", currentOperation: "resume" }),
      activeFrame({ phase: "pause-uncertain", lastErrorCode: null }),
    ]) {
      expect(() => normalizeNativePlayerAuthorityClockFrame(malformed))
        .toThrow(/native player-authority/i);
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

  it("accepts only the exact macro scalar schema and rejects every identity or malformed budget", () => {
    const normalized = normalizeNativePlayerAuthorityClockFrame(macroFrame());
    expect(normalized).toEqual(macroFrame());
    expect(Object.isFrozen(normalized)).toBe(true);
    expect(JSON.stringify(normalized)).not.toMatch(/session|runId|operationId|algorithm|error/i);

    for (const valid of [
      macroFrame({
        phase: "macro-committing",
        inFlight: true,
        currentOperation: "advance",
        simulationProgressMilliseconds: 0,
        wallProgressMilliseconds: 0,
        pausedReason: "macro-advance-committing",
      }),
      macroFrame({
        phase: "macro-finishing",
        inFlight: true,
        currentOperation: "finish",
        pausedReason: "macro-finish-committing",
      }),
      macroFrame({
        phase: "faulted",
        currentOperation: "advance",
        pausedReason: "macro-runtime-faulted",
      }),
      macroFrame({
        phase: "shutdown",
        currentOperation: "finish",
        pausedReason: "macro-runtime-shutdown",
      }),
    ]) {
      expect(normalizeNativePlayerAuthorityClockFrame(valid)).toEqual(valid);
    }

    for (const malformed of [
      { ...macroFrame(), sessionId: "core-secret" },
      { ...macroFrame(), runId: "run-secret" },
      { ...macroFrame(), macroSessionId: "macro-secret" },
      { ...macroFrame(), operationId: "operation-secret" },
      { ...macroFrame(), algorithmVersion: "algorithm-secret" },
      { ...macroFrame(), lastErrorCode: "NATIVE_PRIVATE_ERROR" },
      { ...macroFrame(), nextSequence: 9 },
      { ...macroFrame(), phase: "macro-unknown" },
      { ...macroFrame(), simulationBudgetMilliseconds: null },
      { ...macroFrame(), wallBudgetMilliseconds: 30 * 24 * 60 * 60 * 1_000 + 1 },
      { ...macroFrame(), simulationProgressMilliseconds: 60_001 },
      { ...macroFrame(), wallProgressMilliseconds: null },
      {
        ...macroFrame(),
        phase: "macro-committing",
        currentOperation: null,
        pausedReason: "macro-advance-committing",
      },
      {
        ...macroFrame(),
        phase: "macro-uncertain",
        inFlight: true,
        currentOperation: null,
        pausedReason: "macro-advance-uncertain",
      },
    ]) {
      expect(() => normalizeNativePlayerAuthorityClockFrame(malformed)).toThrow(/native player-authority/i);
    }
  });
});

describe("NativePlayerAuthorityClockController", () => {
  it("adopts a startup-recovered v1 session only from the first trusted pull", async () => {
    const value = clockFixture();
    value.controller.start();
    await settlePromises();

    const snapshot = value.controller.getSnapshot();
    expect(snapshot).toMatchObject({
      availability: "ready",
      expectedSessionId: "core-a",
      currentFrame: { schemaVersion: 1, phase: "active", sessionId: "core-a", revision: 10 },
      lastConfirmedFrame: { sessionId: "core-a", revision: 10 },
    });
    expect(selectBoundNativePlayerAuthorityFrame(snapshot, snapshot.expectedSessionId)?.revision).toBe(10);
    expect(selectActiveNativePlayerAuthorityFrame(snapshot, snapshot.expectedSessionId)?.runId).toBe("run-a");
  });

  it("keeps a startup-recovered paused session bound but not mutation-active", async () => {
    const value = clockFixture(activeFrame({ phase: "paused" }));
    value.controller.start();
    await settlePromises();

    const snapshot = value.controller.getSnapshot();
    expect(selectBoundNativePlayerAuthorityFrame(snapshot, "core-a")?.phase).toBe("paused");
    expect(selectActiveNativePlayerAuthorityFrame(snapshot, "core-a")).toBeNull();
    expect(snapshot.lastConfirmedFrame).toBeNull();
  });

  it("treats an unbound v1 push only as a pull wake-up and never binds from the event payload", async () => {
    let resolvePull!: (frame: DesktopNativePlayerAuthorityState) => void;
    const pull = new Promise<DesktopNativePlayerAuthorityState>((resolve) => { resolvePull = resolve; });
    const listeners: Array<(state: DesktopNativePlayerAuthorityState) => void> = [];
    const bridge = {
      getNativePlayerAuthorityState: vi.fn(() => pull),
      onNativePlayerAuthorityState: vi.fn((next: (state: DesktopNativePlayerAuthorityState) => void) => {
        listeners.push(next);
        return () => undefined;
      }),
    };
    const controller = new NativePlayerAuthorityClockController(bridge);
    controller.start();

    listeners[0]!(activeFrame({ sessionId: "event-only", runId: "event-run" }));
    expect(controller.getSnapshot()).toMatchObject({
      availability: "loading",
      expectedSessionId: null,
      currentFrame: null,
    });

    await Promise.resolve();
    expect(bridge.getNativePlayerAuthorityState).toHaveBeenCalledTimes(2);
    resolvePull(activeFrame());
    await settlePromises();
    expect(controller.getSnapshot()).toMatchObject({
      availability: "ready",
      expectedSessionId: "core-a",
      currentFrame: { sessionId: "core-a", runId: "run-a" },
    });
  });

  it("recognizes a startup macro from pull, orders later pushes, then discovers its v1 session by pull", async () => {
    const value = clockFixture(macroFrame());
    value.controller.start();
    await settlePromises();

    let snapshot = value.controller.getSnapshot();
    expect(snapshot.expectedSessionId).toBeNull();
    expect(selectNativePlayerAuthorityMacroStatus(snapshot, null)).toMatchObject({
      schemaVersion: 2,
      phase: "macro-active",
      revision: 12,
    });
    expect(JSON.stringify(snapshot.currentFrame)).not.toMatch(/session|runId|operationId|algorithm|error/i);

    value.emit(macroFrame({
      revision: 13,
      acknowledgedSequence: 7,
      nextSequence: 8,
      nextDeadlineMs: 13_000,
      simulationBudgetMilliseconds: 75_000,
      wallBudgetMilliseconds: 5_000,
      simulationProgressMilliseconds: 75_000,
      wallProgressMilliseconds: 5_000,
    }));
    snapshot = value.controller.getSnapshot();
    expect(selectNativePlayerAuthorityMacroStatus(snapshot, null)?.revision).toBe(13);
    expect(selectNativePlayerAuthorityMacroStatus(snapshot, "guessed-session")).toBeNull();

    const settled = activeFrame({
      revision: 13,
      acknowledgedSequence: 7,
      nextSequence: 8,
      nextDeadlineMs: 13_000,
    });
    value.setPulled(settled);
    value.emit(settled);
    expect(value.controller.getSnapshot().expectedSessionId).toBeNull();
    expect(value.controller.getSnapshot().currentFrame?.schemaVersion).toBe(2);

    await settlePromises();
    snapshot = value.controller.getSnapshot();
    expect(snapshot.expectedSessionId).toBe("core-a");
    expect(selectNativePlayerAuthorityMacroStatus(snapshot, "core-a")).toBeNull();
    expect(selectActiveNativePlayerAuthorityFrame(snapshot, "core-a")).toMatchObject({
      sessionId: "core-a",
      runId: "run-a",
      revision: 13,
    });
  });

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

  it("preserves legacy v1 pull reconciliation when startup observes an in-flight tick", async () => {
    const value = clockFixture(activeFrame({ inFlight: true, currentOperation: "tick" }));
    value.controller.bindSession("core-a");
    value.controller.start();
    value.setPulled(activeFrame());
    await settlePromises();

    expect(value.bridge.getNativePlayerAuthorityState).toHaveBeenCalledTimes(2);
    expect(selectActiveNativePlayerAuthorityFrame(value.controller.getSnapshot(), "core-a")?.revision).toBe(10);
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

  it("rejects macro v2 until the bound session has supplied one validated v1 identity", async () => {
    const value = clockFixture(macroFrame());
    value.controller.bindSession("core-a");
    value.controller.start();
    await settlePromises();

    expect(value.controller.getSnapshot().currentFrame).toBeNull();
    expect(value.controller.getSnapshot().lastConfirmedFrame).toBeNull();
    expect(selectNativePlayerAuthorityMacroStatus(value.controller.getSnapshot(), "core-a")).toBeNull();

    value.emit(activeFrame());
    value.emit(macroFrame());
    expect(selectNativePlayerAuthorityMacroStatus(value.controller.getSnapshot(), "core-a")?.phase)
      .toBe("macro-active");
  });

  it("accepts macro push/pull progress but makes every active projection selector null", async () => {
    const value = clockFixture();
    value.controller.bindSession("core-a");
    value.controller.start();
    await settlePromises();
    value.setPulled(macroFrame());

    value.emit(macroFrame({
      phase: "macro-committing",
      revision: 10,
      acknowledgedSequence: 4,
      nextSequence: 5,
      nextDeadlineMs: 10_000,
      inFlight: false,
      currentOperation: "advance",
      simulationBudgetMilliseconds: null,
      wallBudgetMilliseconds: null,
      simulationProgressMilliseconds: null,
      wallProgressMilliseconds: null,
      pausedReason: "macro-advance-committing",
    }));
    expect(selectActiveNativePlayerAuthorityFrame(value.controller.getSnapshot(), "core-a")).toBeNull();
    expect(selectBoundNativePlayerAuthorityFrame(value.controller.getSnapshot(), "core-a")?.revision).toBe(10);
    expect(selectNativePlayerAuthorityMacroStatus(value.controller.getSnapshot(), "core-a"))
      .toMatchObject({ phase: "macro-committing", revision: 10 });

    await settlePromises();
    expect(value.bridge.getNativePlayerAuthorityState).toHaveBeenCalledTimes(2);
    const status = selectNativePlayerAuthorityMacroStatus(value.controller.getSnapshot(), "core-a");
    expect(status).toMatchObject({
      phase: "macro-active",
      revision: 12,
      simulationBudgetMilliseconds: 60_000,
      simulationProgressMilliseconds: 60_000,
    });
    expect(selectActiveNativePlayerAuthorityFrame(value.controller.getSnapshot(), "core-a")).toBeNull();
    expect(selectBoundNativePlayerAuthorityFrame(value.controller.getSnapshot(), "core-a")?.revision).toBe(10);
  });

  it("drops stale macro revisions, discontinuous sequences, deadline regressions, and identity leaks", async () => {
    const value = clockFixture();
    value.controller.bindSession("core-a");
    value.controller.start();
    await settlePromises();
    value.emit(macroFrame());
    const accepted = value.controller.getSnapshot().currentFrame;

    for (const rejected of [
      macroFrame({ revision: 11, acknowledgedSequence: 5, nextSequence: 6, nextDeadlineMs: 11_000 }),
      macroFrame({ revision: 13, acknowledgedSequence: 6, nextSequence: 7, nextDeadlineMs: 13_000 }),
      macroFrame({ revision: 12, acknowledgedSequence: 6, nextSequence: 7, nextDeadlineMs: 9_000 }),
      { ...macroFrame(), sessionId: "core-a" },
      { ...macroFrame(), operationId: "operation-secret" },
    ]) value.emit(rejected);

    expect(value.controller.getSnapshot().currentFrame).toBe(accepted);
    expect(selectActiveNativePlayerAuthorityFrame(value.controller.getSnapshot(), "core-a")).toBeNull();
  });

  it("keeps macro uncertainty paused and resumes v1 only for the original session and run", async () => {
    const value = clockFixture();
    value.controller.bindSession("core-a");
    value.controller.start();
    await settlePromises();
    value.emit(macroFrame());
    value.emit(macroFrame({
      phase: "macro-uncertain",
      inFlight: false,
      currentOperation: null,
      simulationProgressMilliseconds: null,
      wallProgressMilliseconds: null,
      pausedReason: "macro-finish-uncertain",
    }));
    expect(selectNativePlayerAuthorityMacroStatus(value.controller.getSnapshot(), "core-a")?.pausedReason)
      .toBe("macro-finish-uncertain");
    expect(selectActiveNativePlayerAuthorityFrame(value.controller.getSnapshot(), "core-a")).toBeNull();

    value.emit(activeFrame({
      sessionId: "core-a",
      runId: "run-other",
      revision: 12,
      acknowledgedSequence: 6,
      nextSequence: 7,
      nextDeadlineMs: 12_000,
    }));
    expect(value.controller.getSnapshot().currentFrame?.schemaVersion).toBe(2);

    value.emit(activeFrame({
      revision: 12,
      acknowledgedSequence: 6,
      nextSequence: 7,
      nextDeadlineMs: 12_000,
    }));
    expect(selectNativePlayerAuthorityMacroStatus(value.controller.getSnapshot(), "core-a")).toBeNull();
    expect(selectActiveNativePlayerAuthorityFrame(value.controller.getSnapshot(), "core-a")?.revision).toBe(12);
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
