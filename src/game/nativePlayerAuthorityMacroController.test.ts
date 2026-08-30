import { describe, expect, it, vi } from "vitest";

import type {
  DesktopBridge,
  DesktopNativePlayerAuthorityClockState,
  DesktopNativePlayerAuthorityMacroBudgetRequest,
  DesktopNativePlayerAuthorityMacroReceipt,
  DesktopNativePlayerAuthorityMacroStartRequest,
  DesktopNativePlayerAuthorityMacroState,
} from "../desktop";
import type { FactoryTimeWarpReadModel } from "./factoryReadModels";
import {
  createNativePlayerAuthorityCommandSource,
  type NativePlayerAuthorityCommandReceipt,
  type NativePlayerAuthorityCommandSource,
} from "./nativePlayerAuthorityCommandSource";
import {
  NativePlayerAuthorityMacroController,
  createNativePlayerAuthorityMacroController,
  createNativeTimeWarpToggleCommand,
  type NativePlayerAuthorityMacroControllerBinding,
  type NativePlayerAuthorityMacroControllerOptions,
} from "./nativePlayerAuthorityMacroController";

type MacroBridgeMethod =
  | "startNativePlayerAuthorityMacro"
  | "advanceNativePlayerAuthorityMacro"
  | "finishNativePlayerAuthorityMacro"
  | "recoverNativePlayerAuthorityMacro";

type MacroBridge = {
  [Key in MacroBridgeMethod]-?: NonNullable<DesktopBridge[Key]>;
};

interface Deferred<Value> {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
  readonly reject: (reason: unknown) => void;
}

function deferred<Value>(): Deferred<Value> {
  let resolve!: (value: Value) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushPromises(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

function activeFrame(
  revision = 10,
  overrides: Partial<DesktopNativePlayerAuthorityClockState> = {},
): DesktopNativePlayerAuthorityClockState {
  return {
    schemaVersion: 1,
    phase: "active",
    sessionId: "macro-controller-session",
    runId: "macro-controller-run",
    revision,
    acknowledgedSequence: revision + 20,
    nextSequence: revision + 21,
    nextDeadlineMs: 1_000,
    inFlight: false,
    currentOperation: null,
    queuedCommands: 0,
    lastErrorCode: null,
    ...overrides,
  };
}

function timeWarp(
  overrides: Partial<FactoryTimeWarpReadModel> = {},
): FactoryTimeWarpReadModel {
  return {
    controllerEntityId: "time-warp-controller",
    enabled: true,
    requestedMultiplier: 15,
    effectiveMultiplier: 15,
    requiredPowerKw: 100,
    allocatedPowerKw: 100,
    ...overrides,
  };
}

function commandReceipt(previousRevision: number): NativePlayerAuthorityCommandReceipt {
  return {
    commandId: `macro-controller-command-${previousRevision}`,
    previousRevision,
    revision: previousRevision + 1,
    changedEntityIds: [],
    changedBeltIds: [],
    topologyDirty: false,
  };
}

function commandSource(
  baseRevision: number,
  applyCommand: NativePlayerAuthorityCommandSource["applyCommand"] = vi.fn(
    async () => commandReceipt(baseRevision),
  ),
): NativePlayerAuthorityCommandSource {
  return {
    sessionId: "macro-controller-session",
    runId: "macro-controller-run",
    baseRevision,
    applyCommand,
  };
}

function binding(
  overrides: Partial<NativePlayerAuthorityMacroControllerBinding> = {},
): NativePlayerAuthorityMacroControllerBinding {
  const frame = activeFrame();
  return {
    activeFrame: frame,
    macroStatus: null,
    paused: false,
    simulationSpeed: 1,
    timeWarp: timeWarp(),
    commandSource: commandSource(frame.revision!),
    ...overrides,
  };
}

function macroState(
  overrides: Partial<DesktopNativePlayerAuthorityMacroState> = {},
): DesktopNativePlayerAuthorityMacroState {
  return {
    schemaVersion: 2,
    statusKind: "macro",
    phase: "macro-active",
    revision: 30,
    acknowledgedSequence: 50,
    nextSequence: 51,
    nextDeadlineMs: 11_000,
    inFlight: false,
    currentOperation: null,
    simulationBudgetMilliseconds: 15_000,
    wallBudgetMilliseconds: 1_000,
    simulationProgressMilliseconds: 0,
    wallProgressMilliseconds: 0,
    pausedReason: "macro-window-active",
    ...overrides,
  };
}

function activeMacroReceipt(
  revision: number,
  budget: DesktopNativePlayerAuthorityMacroBudgetRequest,
  recovered = false,
): DesktopNativePlayerAuthorityMacroReceipt {
  return {
    schemaVersion: 1,
    state: "macro-active",
    revision,
    previousRevision: revision - 1,
    simulationMilliseconds: budget.simulationMilliseconds,
    wallMilliseconds: budget.wallMilliseconds,
    recovered,
  };
}

function finishedMacroReceipt(
  revision: number,
  recovered = false,
): DesktopNativePlayerAuthorityMacroReceipt {
  return {
    schemaVersion: 1,
    state: "finished",
    revision,
    previousRevision: revision - 1,
    simulationMilliseconds: null,
    wallMilliseconds: null,
    recovered,
  };
}

function startupRecoveryReceipt(revision: number): DesktopNativePlayerAuthorityMacroReceipt {
  return {
    schemaVersion: 1,
    state: "macro-active",
    revision,
    previousRevision: null,
    simulationMilliseconds: null,
    wallMilliseconds: null,
    recovered: true,
  };
}

function macroBridge(overrides: Partial<MacroBridge> = {}): MacroBridge {
  return {
    startNativePlayerAuthorityMacro: vi.fn(async (budget) => activeMacroReceipt(11, budget)),
    advanceNativePlayerAuthorityMacro: vi.fn(async (budget) => activeMacroReceipt(12, budget)),
    finishNativePlayerAuthorityMacro: vi.fn(async () => finishedMacroReceipt(13)),
    recoverNativePlayerAuthorityMacro: vi.fn(async () => startupRecoveryReceipt(30)),
    ...overrides,
  };
}

interface ScheduledCallback {
  readonly callback: () => void;
  readonly delayMs: number;
  cancelled: boolean;
}

function clockHarness(initialNow: number): {
  readonly now: () => number;
  readonly schedule: NonNullable<NativePlayerAuthorityMacroControllerOptions["schedule"]>;
  readonly cancel: NonNullable<NativePlayerAuthorityMacroControllerOptions["cancel"]>;
  readonly pending: () => readonly ScheduledCallback[];
  readonly runNext: (now: number) => void;
  readonly setNow: (now: number) => void;
} {
  let currentNow = initialNow;
  const callbacks: ScheduledCallback[] = [];
  const schedule: NonNullable<NativePlayerAuthorityMacroControllerOptions["schedule"]> = vi.fn(
    (callback, delayMs) => {
      const scheduled: ScheduledCallback = { callback, delayMs, cancelled: false };
      callbacks.push(scheduled);
      return scheduled as unknown as ReturnType<typeof setTimeout>;
    },
  );
  const cancel: NonNullable<NativePlayerAuthorityMacroControllerOptions["cancel"]> = vi.fn(
    (timer) => {
      (timer as unknown as ScheduledCallback).cancelled = true;
    },
  );
  return {
    now: () => currentNow,
    schedule,
    cancel,
    pending: () => callbacks.filter((callback) => !callback.cancelled),
    runNext(now) {
      currentNow = now;
      const index = callbacks.findIndex((callback) => !callback.cancelled);
      if (index < 0) throw new Error("没有待运行的宏观控制定时器");
      const [scheduled] = callbacks.splice(index, 1);
      scheduled.callback();
    },
    setNow(now) {
      currentNow = now;
    },
  };
}

function controllerWithClock(bridge: MacroBridge, clock: ReturnType<typeof clockHarness>) {
  return new NativePlayerAuthorityMacroController(bridge, {
    now: clock.now,
    schedule: clock.schedule,
    cancel: clock.cancel,
  });
}

describe("native player authority macro controller", () => {
  it("builds minimal semantic enable and disable intents without predicting derived fields", () => {
    const disabled = timeWarp({
      enabled: false,
      effectiveMultiplier: 1,
      requiredPowerKw: 0,
      allocatedPowerKw: 0,
    });
    expect(createNativeTimeWarpToggleCommand(7, 1, disabled, true)).toStrictEqual({
      protocolVersion: 1,
      baseRevision: 7,
      topLevelChanges: [{
        path: ["timeWarp", "intent"],
        operation: "set",
        value: { controllerEntityId: "time-warp-controller", enabled: true },
      }],
      changedEntities: [],
      addedEntities: [],
      removedEntityIds: [],
      changedBelts: [],
      addedBelts: [],
      removedBeltIds: [],
    });

    expect(createNativeTimeWarpToggleCommand(8, 1, timeWarp(), false)).toStrictEqual({
      protocolVersion: 1,
      baseRevision: 8,
      topLevelChanges: [{
        path: ["timeWarp", "intent"],
        operation: "set",
        value: { controllerEntityId: "time-warp-controller", enabled: false },
      }],
      changedEntities: [],
      addedEntities: [],
      removedEntityIds: [],
      changedBelts: [],
      addedBelts: [],
      removedBeltIds: [],
    });

    expect(createNativeTimeWarpToggleCommand(8, 1, disabled, false)).toBeNull();
    expect(createNativeTimeWarpToggleCommand(-1, 1, disabled, true)).toBeNull();
  });

  it("enables a disabled controller, waits for a newer powered frame, and starts only with elapsed wall time", async () => {
    const clock = clockHarness(10_000);
    const start = vi.fn(async (budget: DesktopNativePlayerAuthorityMacroStartRequest) =>
      activeMacroReceipt(13, budget));
    const bridge = macroBridge({ startNativePlayerAuthorityMacro: start });
    const applyEnable = vi.fn(async () => commandReceipt(10));
    const controller = controllerWithClock(bridge, clock);
    const disabled = timeWarp({
      enabled: false,
      effectiveMultiplier: 1,
      requiredPowerKw: 0,
      allocatedPowerKw: 0,
    });

    controller.bind(binding({
      activeFrame: activeFrame(10, { nextDeadlineMs: 10_000 }),
      timeWarp: disabled,
      commandSource: commandSource(10, applyEnable),
    }));
    expect(controller.requestStart()).toBe(true);
    expect(applyEnable).toHaveBeenCalledWith(createNativeTimeWarpToggleCommand(10, 1, disabled, true));
    expect(start).not.toHaveBeenCalled();

    await flushPromises();
    expect(controller.getSnapshot().phase).toBe("waiting-powered-frame");

    const powered = timeWarp();
    controller.bind(binding({
      activeFrame: activeFrame(11, { nextDeadlineMs: 10_875 }),
      timeWarp: powered,
      commandSource: commandSource(11),
    }));
    expect(start).not.toHaveBeenCalled();

    controller.bind(binding({
      activeFrame: activeFrame(12, { nextDeadlineMs: 10_875 }),
      timeWarp: powered,
      commandSource: commandSource(12),
    }));
    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith({
      expectedRevision: 12,
      simulationMilliseconds: 1_875,
      wallMilliseconds: 125,
    });

    await flushPromises();
    expect(controller.getSnapshot()).toStrictEqual({
      phase: "active",
      requested: true,
      effectiveMultiplier: 15,
      settledThroughMs: 10_000,
      lastErrorCode: null,
    });
    expect(bridge.advanceNativePlayerAuthorityMacro).not.toHaveBeenCalled();
  });

  it("recovers an existing startup macro exactly once", async () => {
    const clock = clockHarness(50_000);
    const status = macroState({ nextDeadlineMs: 51_000 });
    const recover = vi.fn(async () => startupRecoveryReceipt(30));
    const bridge = macroBridge({ recoverNativePlayerAuthorityMacro: recover });
    const controller = controllerWithClock(bridge, clock);
    const startupBinding = binding({
      activeFrame: null,
      macroStatus: status,
      paused: null,
      simulationSpeed: null,
      timeWarp: null,
      commandSource: null,
    });

    controller.bind(startupBinding);
    controller.bind(startupBinding);
    expect(recover).toHaveBeenCalledTimes(1);

    await flushPromises();
    controller.bind(startupBinding);
    await flushPromises();
    expect(recover).toHaveBeenCalledTimes(1);
    expect(bridge.startNativePlayerAuthorityMacro).not.toHaveBeenCalled();
    expect(bridge.advanceNativePlayerAuthorityMacro).not.toHaveBeenCalled();
    expect(controller.getSnapshot()).toStrictEqual({
      phase: "active",
      requested: true,
      effectiveMultiplier: 15,
      settledThroughMs: 50_000,
      lastErrorCode: null,
    });
  });

  it("accepts an idempotently replayed recovered advance already reflected by startup status", async () => {
    const clock = clockHarness(50_000);
    const recover = vi.fn(async () => activeMacroReceipt(30, {
      simulationMilliseconds: 15_000,
      wallMilliseconds: 1_000,
    }, true));
    const controller = controllerWithClock(
      macroBridge({ recoverNativePlayerAuthorityMacro: recover }),
      clock,
    );
    controller.bind(binding({
      activeFrame: null,
      macroStatus: macroState({ revision: 30, nextDeadlineMs: 51_000 }),
      paused: null,
      simulationSpeed: null,
      timeWarp: null,
      commandSource: null,
    }));
    await flushPromises();
    expect(controller.getSnapshot()).toMatchObject({
      phase: "active",
      settledThroughMs: 50_000,
      lastErrorCode: null,
    });
  });

  it("keeps an in-flight startup recovery attached across a StrictMode dispose", async () => {
    const clock = clockHarness(50_000);
    const status = macroState({ nextDeadlineMs: 51_000 });
    const firstRecovery = deferred<DesktopNativePlayerAuthorityMacroReceipt>();
    const recover = vi.fn(() => firstRecovery.promise);
    const controller = controllerWithClock(
      macroBridge({ recoverNativePlayerAuthorityMacro: recover }),
      clock,
    );
    const startupBinding = binding({
      activeFrame: null,
      macroStatus: status,
      paused: null,
      simulationSpeed: null,
      timeWarp: null,
      commandSource: null,
    });

    controller.bind(startupBinding);
    expect(recover).toHaveBeenCalledTimes(1);
    controller.dispose();
    controller.bind(startupBinding);
    expect(recover).toHaveBeenCalledTimes(1);

    firstRecovery.resolve(startupRecoveryReceipt(30));
    await flushPromises();
    expect(recover).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot()).toMatchObject({
      phase: "active",
      effectiveMultiplier: 15,
      settledThroughMs: 50_000,
      lastErrorCode: null,
    });
  });

  it("backs off a fresh recovery while the main-process broker is busy", async () => {
    const clock = clockHarness(50_000);
    let attempts = 0;
    const recover = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error("main recovery busy"), {
        code: "NATIVE_PLAYER_AUTHORITY_MACRO_BUSY",
      });
      return startupRecoveryReceipt(30);
    });
    const controller = controllerWithClock(
      macroBridge({ recoverNativePlayerAuthorityMacro: recover }),
      clock,
    );
    controller.bind(binding({
      activeFrame: null,
      macroStatus: macroState({ nextDeadlineMs: 51_000 }),
      paused: null,
      simulationSpeed: null,
      timeWarp: null,
      commandSource: null,
    }));
    await flushPromises();
    expect(controller.getSnapshot()).toMatchObject({
      phase: "recovering",
      lastErrorCode: "macro:NATIVE_PLAYER_AUTHORITY_MACRO_BUSY",
    });
    expect(clock.pending().map((timer) => timer.delayMs)).toStrictEqual([50]);
    clock.runNext(50_050);
    await flushPromises();
    expect(recover).toHaveBeenCalledTimes(2);
    expect(controller.getSnapshot().phase).toBe("active");
  });

  it("advances an active macro on each elapsed periodic wall-time window", async () => {
    const clock = clockHarness(10_000);
    const status = macroState({ nextDeadlineMs: 11_000 });
    const advance = vi.fn(async (budget: DesktopNativePlayerAuthorityMacroBudgetRequest) =>
      activeMacroReceipt(31, budget));
    const bridge = macroBridge({ advanceNativePlayerAuthorityMacro: advance });
    const controller = controllerWithClock(bridge, clock);

    controller.bind(binding({ activeFrame: null, macroStatus: status, commandSource: null }));
    await flushPromises();
    expect(clock.pending().map((timer) => timer.delayMs)).toStrictEqual([1_000]);

    clock.runNext(11_000);
    expect(advance).toHaveBeenCalledTimes(1);
    expect(advance).toHaveBeenCalledWith({
      simulationMilliseconds: 15_000,
      wallMilliseconds: 1_000,
    });

    await flushPromises();
    expect(controller.getSnapshot().phase).toBe("active");
    expect(controller.getSnapshot().settledThroughMs).toBe(11_000);
    expect(clock.pending().map((timer) => timer.delayMs)).toStrictEqual([1_000]);
  });

  it("settles elapsed wall time before finish and disables only on the exact finished revision frame", async () => {
    const clock = clockHarness(10_550);
    const status = macroState({ nextDeadlineMs: 11_000 });
    const advanceResult = deferred<DesktopNativePlayerAuthorityMacroReceipt>();
    const finishResult = deferred<DesktopNativePlayerAuthorityMacroReceipt>();
    const advance = vi.fn(() => advanceResult.promise);
    const finish = vi.fn(() => finishResult.promise);
    const bridge = macroBridge({
      advanceNativePlayerAuthorityMacro: advance,
      finishNativePlayerAuthorityMacro: finish,
    });
    const controller = controllerWithClock(bridge, clock);

    controller.bind(binding({ activeFrame: null, macroStatus: status, commandSource: null }));
    await flushPromises();
    expect(controller.requestStop()).toBe(true);
    expect(advance).toHaveBeenCalledWith({
      simulationMilliseconds: 8_250,
      wallMilliseconds: 550,
    });
    expect(finish).not.toHaveBeenCalled();

    advanceResult.resolve(activeMacroReceipt(31, {
      simulationMilliseconds: 8_250,
      wallMilliseconds: 550,
    }));
    await flushPromises();
    expect(finish).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().phase).toBe("finishing");

    finishResult.resolve(finishedMacroReceipt(31));
    await flushPromises();
    expect(controller.getSnapshot().phase).toBe("waiting-disable-frame");

    const earlyDisable = vi.fn(async () => commandReceipt(30));
    controller.bind(binding({
      activeFrame: activeFrame(30, { nextDeadlineMs: 11_550 }),
      macroStatus: null,
      commandSource: commandSource(30, earlyDisable),
    }));
    expect(earlyDisable).not.toHaveBeenCalled();

    const exactDisable = vi.fn(async () => commandReceipt(31));
    controller.bind(binding({
      activeFrame: activeFrame(31, { nextDeadlineMs: 11_550 }),
      macroStatus: null,
      commandSource: commandSource(31, exactDisable),
    }));
    expect(exactDisable).toHaveBeenCalledTimes(1);
    expect(exactDisable).toHaveBeenCalledWith(createNativeTimeWarpToggleCommand(31, 1, timeWarp(), false));

    await flushPromises();
    expect(controller.getSnapshot().phase).toBe("disabling");
    controller.bind(binding({
      activeFrame: activeFrame(32, { nextDeadlineMs: 11_550 }),
      macroStatus: null,
      timeWarp: timeWarp({
        enabled: false,
        effectiveMultiplier: 1,
        requiredPowerKw: 0,
        allocatedPowerKw: 0,
      }),
      commandSource: commandSource(32),
    }));
    expect(controller.getSnapshot()).toStrictEqual({
      phase: "idle",
      requested: false,
      effectiveMultiplier: null,
      settledThroughMs: null,
      lastErrorCode: null,
    });
  });

  it("recovers an uncertain advance without ever issuing the advance twice", async () => {
    const clock = clockHarness(100);
    const advanceResult = deferred<DesktopNativePlayerAuthorityMacroReceipt>();
    const recoveryResult = deferred<DesktopNativePlayerAuthorityMacroReceipt>();
    const start = vi.fn(async (budget: DesktopNativePlayerAuthorityMacroStartRequest) =>
      activeMacroReceipt(11, budget));
    const advance = vi.fn(() => advanceResult.promise);
    const recover = vi.fn(() => recoveryResult.promise);
    const bridge = macroBridge({
      startNativePlayerAuthorityMacro: start,
      advanceNativePlayerAuthorityMacro: advance,
      recoverNativePlayerAuthorityMacro: recover,
    });
    const controller = controllerWithClock(bridge, clock);

    controller.bind(binding({
      activeFrame: activeFrame(10, { nextDeadlineMs: 1_000 }),
      macroStatus: null,
      timeWarp: timeWarp(),
      commandSource: commandSource(10),
    }));
    await flushPromises();
    expect(start).toHaveBeenCalledWith({
      expectedRevision: 10,
      simulationMilliseconds: 1_500,
      wallMilliseconds: 100,
    });
    expect(clock.pending().map((timer) => timer.delayMs)).toStrictEqual([1_000]);

    clock.runNext(1_100);
    expect(advance).toHaveBeenCalledTimes(1);
    expect(advance).toHaveBeenCalledWith({
      simulationMilliseconds: 15_000,
      wallMilliseconds: 1_000,
    });

    const uncertainStatus = macroState({
      phase: "macro-uncertain",
      revision: 12,
      acknowledgedSequence: 32,
      nextSequence: 33,
      nextDeadlineMs: 2_100,
      inFlight: false,
      currentOperation: "advance",
      pausedReason: "macro-advance-uncertain",
    });
    controller.bind(binding({
      activeFrame: activeFrame(12, { nextDeadlineMs: 2_100 }),
      macroStatus: uncertainStatus,
      commandSource: commandSource(12),
    }));
    const uncertainError = Object.assign(new Error("advance acknowledgement uncertain"), {
      code: "NATIVE_PLAYER_AUTHORITY_MACRO_ADVANCE_UNCERTAIN",
    });
    advanceResult.reject(uncertainError);
    await flushPromises();

    expect(recover).toHaveBeenCalledTimes(1);
    expect(advance).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().phase).toBe("recovering");

    controller.dispose();
    controller.bind(binding({
      activeFrame: null,
      macroStatus: uncertainStatus,
      commandSource: null,
    }));
    expect(recover).toHaveBeenCalledTimes(1);

    recoveryResult.resolve(activeMacroReceipt(12, {
      simulationMilliseconds: 15_000,
      wallMilliseconds: 1_000,
    }, true));
    await flushPromises();
    expect(recover).toHaveBeenCalledTimes(1);
    expect(advance).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().phase).toBe("active");
    expect(controller.getSnapshot().settledThroughMs).toBe(1_100);
  });

  it("keeps an uncertain finish recovery attached across a StrictMode dispose", async () => {
    const clock = clockHarness(50_000);
    const recoveryResult = deferred<DesktopNativePlayerAuthorityMacroReceipt>();
    const recover = vi.fn(() => recoveryResult.promise);
    const controller = controllerWithClock(
      macroBridge({ recoverNativePlayerAuthorityMacro: recover }),
      clock,
    );
    const uncertainFinish = macroState({
      phase: "macro-uncertain",
      revision: 30,
      nextDeadlineMs: 51_000,
      currentOperation: "finish",
      pausedReason: "macro-finish-uncertain",
    });
    const uncertainBinding = binding({
      activeFrame: null,
      macroStatus: uncertainFinish,
      paused: null,
      simulationSpeed: null,
      timeWarp: null,
      commandSource: null,
    });

    controller.bind(uncertainBinding);
    expect(recover).toHaveBeenCalledTimes(1);
    controller.dispose();
    controller.bind(uncertainBinding);
    expect(recover).toHaveBeenCalledTimes(1);

    recoveryResult.resolve(finishedMacroReceipt(30, true));
    await flushPromises();
    expect(recover).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot()).toMatchObject({
      phase: "waiting-disable-frame",
      requested: false,
      settledThroughMs: 50_000,
      lastErrorCode: null,
    });
  });

  it("discovers a recovered finish after reload and catch-up ticks, then disables time warp", async () => {
    const clock = clockHarness(13_000);
    const recover = vi.fn(async () => finishedMacroReceipt(10, true));
    const applyDisable = vi.fn(async () => commandReceipt(12));
    const controller = controllerWithClock(
      macroBridge({ recoverNativePlayerAuthorityMacro: recover }),
      clock,
    );
    controller.bind(binding({
      activeFrame: null,
      macroStatus: macroState({
        phase: "macro-finishing",
        revision: 10,
        nextDeadlineMs: 11_000,
        inFlight: true,
        currentOperation: "finish",
        pausedReason: "macro-finish-committing",
      }),
      paused: null,
      simulationSpeed: null,
      timeWarp: null,
      commandSource: null,
    }));
    expect(controller.getSnapshot().phase).toBe("recovering");
    expect(recover).not.toHaveBeenCalled();

    controller.bind(binding({
      activeFrame: activeFrame(12, {
        nextDeadlineMs: 13_000,
        macroRecoveryHint: { kind: "finished-pending-disable", revision: 10 },
      }),
      macroStatus: null,
      timeWarp: timeWarp(),
      commandSource: commandSource(12, applyDisable),
    }));
    await flushPromises();

    expect(recover).toHaveBeenCalledTimes(1);
    expect(applyDisable).toHaveBeenCalledWith(createNativeTimeWarpToggleCommand(
      12,
      1,
      timeWarp(),
      false,
    ));
    expect(controller.getSnapshot()).toMatchObject({
      phase: "disabling",
      requested: false,
      settledThroughMs: 12_000,
      lastErrorCode: null,
    });

    controller.bind(binding({
      activeFrame: activeFrame(13, { nextDeadlineMs: 14_000 }),
      macroStatus: null,
      timeWarp: timeWarp({
        enabled: false,
        effectiveMultiplier: 1,
        requiredPowerKw: 0,
        allocatedPowerKw: 0,
      }),
      commandSource: commandSource(13),
    }));
    expect(controller.getSnapshot().phase).toBe("idle");
  });

  it("reconstructs a durable enabled-before-start intent after reload and keeps paused Stop available", async () => {
    const poweredClock = clockHarness(1_000);
    const start = vi.fn(async (budget: DesktopNativePlayerAuthorityMacroStartRequest) =>
      activeMacroReceipt(12, budget));
    const powered = controllerWithClock(
      macroBridge({ startNativePlayerAuthorityMacro: start }),
      poweredClock,
    );
    powered.bind(binding({
      activeFrame: activeFrame(11, { nextDeadlineMs: 1_000 }),
      paused: false,
      timeWarp: timeWarp(),
      commandSource: commandSource(11),
    }));
    await flushPromises();
    expect(start).toHaveBeenCalledWith({
      expectedRevision: 11,
      simulationMilliseconds: 15_000,
      wallMilliseconds: 1_000,
    });
    expect(powered.getSnapshot()).toMatchObject({ phase: "active", requested: true });

    const pausedClock = clockHarness(1_000);
    const applyDisable = vi.fn(async () => commandReceipt(20));
    const pausedBridge = macroBridge();
    const paused = controllerWithClock(pausedBridge, pausedClock);
    paused.bind(binding({
      activeFrame: activeFrame(20, { nextDeadlineMs: 1_000 }),
      paused: true,
      timeWarp: timeWarp({ allocatedPowerKw: 0 }),
      commandSource: commandSource(20, applyDisable),
    }));
    expect(paused.getSnapshot()).toMatchObject({
      phase: "waiting-powered-frame",
      requested: true,
    });
    expect(pausedBridge.startNativePlayerAuthorityMacro).not.toHaveBeenCalled();
    expect(paused.requestStop()).toBe(true);
    await flushPromises();
    expect(pausedBridge.startNativePlayerAuthorityMacro).not.toHaveBeenCalled();
    expect(applyDisable).toHaveBeenCalledWith(createNativeTimeWarpToggleCommand(
      20,
      1,
      timeWarp({ allocatedPowerKw: 0 }),
      false,
    ));

    const strictClock = clockHarness(1_000);
    const strictResult = deferred<DesktopNativePlayerAuthorityMacroReceipt>();
    const strictStart = vi.fn(() => strictResult.promise);
    const strictController = controllerWithClock(
      macroBridge({ startNativePlayerAuthorityMacro: strictStart }),
      strictClock,
    );
    const strictBinding = binding({
      activeFrame: activeFrame(11, { nextDeadlineMs: 1_000 }),
      paused: false,
      timeWarp: timeWarp(),
      commandSource: commandSource(11),
    });
    strictController.bind(strictBinding);
    expect(strictStart).toHaveBeenCalledTimes(1);
    strictController.dispose();
    strictController.bind(strictBinding);
    expect(strictStart).toHaveBeenCalledTimes(1);
    strictResult.resolve(activeMacroReceipt(12, {
      simulationMilliseconds: 15_000,
      wallMilliseconds: 1_000,
    }));
    await flushPromises();
    expect(strictStart).toHaveBeenCalledTimes(1);
    expect(strictController.getSnapshot()).toMatchObject({ phase: "active", requested: true });
  });

  it("lets a main-owned finished hint recover a prior renderer transport fault", async () => {
    const clock = clockHarness(13_000);
    const recover = vi.fn(async () => finishedMacroReceipt(10, true));
    const applyDisable = vi.fn(async () => commandReceipt(12));
    const controller = controllerWithClock(
      macroBridge({ recoverNativePlayerAuthorityMacro: recover }),
      clock,
    );
    controller.bind(binding({
      activeFrame: null,
      macroStatus: macroState({
        simulationBudgetMilliseconds: 1_000,
        wallBudgetMilliseconds: 1_000,
      }),
      paused: null,
      simulationSpeed: null,
      timeWarp: null,
      commandSource: null,
    }));
    expect(controller.getSnapshot().phase).toBe("faulted");

    controller.bind(binding({
      activeFrame: activeFrame(12, {
        nextDeadlineMs: 13_000,
        macroRecoveryHint: { kind: "finished-pending-disable", revision: 10 },
      }),
      macroStatus: null,
      timeWarp: timeWarp(),
      commandSource: commandSource(12, applyDisable),
    }));
    await flushPromises();
    expect(recover).toHaveBeenCalledTimes(1);
    expect(applyDisable).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().phase).toBe("disabling");
  });

  it("never carries an in-flight result or BUSY retry into a different authority lineage", async () => {
    const nextFrame = activeFrame(20, {
      sessionId: "macro-controller-session-b",
      runId: "macro-controller-run-b",
      nextDeadlineMs: 2_000,
    });
    const nextSource: NativePlayerAuthorityCommandSource = {
      ...commandSource(20),
      sessionId: "macro-controller-session-b",
      runId: "macro-controller-run-b",
    };

    const inFlightClock = clockHarness(1_000);
    const oldStart = deferred<DesktopNativePlayerAuthorityMacroReceipt>();
    const start = vi.fn(() => oldStart.promise);
    const controller = controllerWithClock(
      macroBridge({ startNativePlayerAuthorityMacro: start }),
      inFlightClock,
    );
    controller.bind(binding({
      activeFrame: activeFrame(10, { nextDeadlineMs: 1_000 }),
      timeWarp: timeWarp(),
      commandSource: commandSource(10),
    }));
    expect(start).toHaveBeenCalledTimes(1);
    controller.bind(binding({
      activeFrame: nextFrame,
      timeWarp: timeWarp({ enabled: false }),
      commandSource: nextSource,
    }));
    expect(controller.getSnapshot().phase).toBe("idle");
    oldStart.resolve(activeMacroReceipt(11, {
      simulationMilliseconds: 15_000,
      wallMilliseconds: 1_000,
    }));
    await flushPromises();
    expect(controller.getSnapshot()).toMatchObject({ phase: "idle", requested: false });

    const retryClock = clockHarness(1_100);
    const busy = Object.assign(new Error("old authority tick is busy"), {
      code: "NATIVE_PLAYER_AUTHORITY_MACRO_BUSY",
    });
    const retryStart = vi.fn(async () => { throw busy; });
    const retryController = controllerWithClock(
      macroBridge({ startNativePlayerAuthorityMacro: retryStart }),
      retryClock,
    );
    retryController.bind(binding({
      activeFrame: activeFrame(10, { nextDeadlineMs: 1_000 }),
      timeWarp: timeWarp(),
      commandSource: commandSource(10),
    }));
    await flushPromises();
    expect(retryClock.pending().map((timer) => timer.delayMs)).toStrictEqual([50]);
    retryController.bind(binding({
      activeFrame: nextFrame,
      timeWarp: timeWarp({ enabled: false }),
      commandSource: nextSource,
    }));
    expect(retryClock.pending()).toStrictEqual([]);
    expect(retryController.getSnapshot().phase).toBe("idle");
    expect(retryStart).toHaveBeenCalledTimes(1);
  });

  it("takes over a durable enable after its renderer reply is lost and still permits Stop", async () => {
    const clock = clockHarness(1_000);
    const transport = Object.assign(new Error("enable reply lost"), {
      code: "NATIVE_PLAYER_AUTHORITY_COMMAND_TRANSPORT_UNCERTAIN",
    });
    const applyEnable = vi.fn(async () => { throw transport; });
    const start = vi.fn(async (budget: DesktopNativePlayerAuthorityMacroStartRequest) =>
      activeMacroReceipt(12, budget));
    const controller = controllerWithClock(
      macroBridge({ startNativePlayerAuthorityMacro: start }),
      clock,
    );
    controller.bind(binding({
      activeFrame: activeFrame(10, { nextDeadlineMs: 1_000 }),
      timeWarp: timeWarp({ enabled: false }),
      commandSource: commandSource(10, applyEnable),
    }));
    expect(controller.requestStart()).toBe(true);
    await flushPromises();
    expect(controller.getSnapshot().phase).toBe("uncertain");

    controller.bind(binding({
      activeFrame: activeFrame(11, { nextDeadlineMs: 1_000 }),
      paused: false,
      timeWarp: timeWarp(),
      commandSource: commandSource(11),
    }));
    await flushPromises();
    expect(start).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().phase).toBe("active");

    const stopClock = clockHarness(1_000);
    const stopApplyEnable = vi.fn(async () => { throw transport; });
    const applyDisable = vi.fn(async () => commandReceipt(11));
    const stopBridge = macroBridge();
    const stopController = controllerWithClock(stopBridge, stopClock);
    stopController.bind(binding({
      activeFrame: activeFrame(10, { nextDeadlineMs: 1_000 }),
      timeWarp: timeWarp({ enabled: false }),
      commandSource: commandSource(10, stopApplyEnable),
    }));
    expect(stopController.requestStart()).toBe(true);
    expect(stopController.requestStop()).toBe(true);
    await flushPromises();
    stopController.bind(binding({
      activeFrame: activeFrame(11, { nextDeadlineMs: 1_000 }),
      paused: true,
      timeWarp: timeWarp({ allocatedPowerKw: 0 }),
      commandSource: commandSource(11, applyDisable),
    }));
    await flushPromises();
    expect(stopBridge.startNativePlayerAuthorityMacro).not.toHaveBeenCalled();
    expect(applyDisable).toHaveBeenCalledTimes(1);

    const noopController = controllerWithClock(macroBridge(), clockHarness(1_000));
    const noopEnable = vi.fn(async () => { throw transport; });
    noopController.bind(binding({
      activeFrame: activeFrame(10, { nextDeadlineMs: 1_000 }),
      timeWarp: timeWarp({ enabled: false }),
      commandSource: commandSource(10, noopEnable),
    }));
    expect(noopController.requestStart()).toBe(true);
    expect(noopController.requestStop()).toBe(true);
    await flushPromises();
    expect(noopController.getSnapshot().phase).toBe("uncertain");
    noopController.bind(binding({
      activeFrame: activeFrame(10, { nextDeadlineMs: 1_000 }),
      timeWarp: timeWarp({ enabled: false }),
      commandSource: commandSource(10),
    }));
    expect(noopController.getSnapshot().phase).toBe("uncertain");
    noopController.bind(binding({
      activeFrame: activeFrame(11, { nextDeadlineMs: 2_000 }),
      timeWarp: timeWarp({ enabled: false }),
      commandSource: commandSource(11),
    }));
    expect(noopController.getSnapshot()).toMatchObject({
      phase: "idle",
      requested: false,
      lastErrorCode: null,
    });
  });

  it("retries a transient finished-hint recovery and trusts a settled durable disable", async () => {
    const clock = clockHarness(13_000);
    const transient = Object.assign(new Error("recover reply uncertain"), {
      code: "NATIVE_PLAYER_AUTHORITY_MACRO_UNCERTAIN",
    });
    let recoverAttempts = 0;
    const recover = vi.fn(async () => {
      recoverAttempts += 1;
      if (recoverAttempts === 1) throw transient;
      return finishedMacroReceipt(10, true);
    });
    const disableTransport = Object.assign(new Error("disable reply lost"), {
      code: "NATIVE_PLAYER_AUTHORITY_COMMAND_TRANSPORT_UNCERTAIN",
    });
    const applyDisable = vi.fn(async () => { throw disableTransport; });
    const controller = controllerWithClock(
      macroBridge({ recoverNativePlayerAuthorityMacro: recover }),
      clock,
    );
    const hinted = binding({
      activeFrame: activeFrame(12, {
        nextDeadlineMs: 13_000,
        macroRecoveryHint: { kind: "finished-pending-disable", revision: 10 },
      }),
      macroStatus: null,
      timeWarp: timeWarp(),
      commandSource: commandSource(12, applyDisable),
    });
    controller.bind(hinted);
    await flushPromises();
    expect(recover).toHaveBeenCalledTimes(1);
    expect(clock.pending().map((timer) => timer.delayMs)).toStrictEqual([50]);
    controller.bind(hinted);
    expect(recover).toHaveBeenCalledTimes(1);
    clock.runNext(13_050);
    await flushPromises();
    expect(recover).toHaveBeenCalledTimes(2);
    expect(applyDisable).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().phase).toBe("uncertain");

    controller.bind(binding({
      activeFrame: activeFrame(13, { nextDeadlineMs: 14_000 }),
      macroStatus: null,
      timeWarp: timeWarp({
        enabled: false,
        effectiveMultiplier: 1,
        requiredPowerKw: 0,
        allocatedPowerKw: 0,
      }),
      commandSource: commandSource(13),
    }));
    expect(controller.getSnapshot().phase).toBe("idle");
  });

  it("waits for a fresh command source after an uncertain finished-hint disable", async () => {
    const clock = clockHarness(13_000);
    const recover = vi.fn(async () => finishedMacroReceipt(10, true));
    let authoritativeFrame = activeFrame(12, {
      nextDeadlineMs: 13_000,
      macroRecoveryHint: { kind: "finished-pending-disable", revision: 10 },
    });
    let hostAttempts = 0;
    const commandBridge: Pick<
      DesktopBridge,
      "getNativePlayerAuthorityState" | "applyNativeCoreCommand"
    > = {
      getNativePlayerAuthorityState: vi.fn(async () => authoritativeFrame),
      applyNativeCoreCommand: vi.fn(async (request) => {
        hostAttempts += 1;
        if (hostAttempts === 1) throw new Error("disable did not reach the host");
        const baseRevision = request.command.baseRevision as number;
        authoritativeFrame = activeFrame(baseRevision + 1, {
          nextDeadlineMs: authoritativeFrame.nextDeadlineMs!,
        });
        return {
          previousRevision: baseRevision,
          revision: baseRevision + 1,
          changedEntityIds: [],
          changedBeltIds: [],
          topologyDirty: false,
        };
      }),
    };
    const firstSource = createNativePlayerAuthorityCommandSource(
      commandBridge,
      authoritativeFrame,
    );
    if (!firstSource) throw new Error("expected first native command source");
    const controller = controllerWithClock(
      macroBridge({ recoverNativePlayerAuthorityMacro: recover }),
      clock,
    );
    const hinted = binding({
      activeFrame: authoritativeFrame,
      macroStatus: null,
      timeWarp: timeWarp(),
      commandSource: firstSource,
    });

    controller.bind(hinted);
    await flushPromises();
    expect(recover).toHaveBeenCalledTimes(1);
    expect(commandBridge.applyNativeCoreCommand).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().phase).toBe("uncertain");

    // A real command source is permanently consumed after a transport-uncertain
    // attempt. The same immutable finish hint may be recovered again, but it
    // must not turn the same frame into a second Host mutation.
    controller.bind(hinted);
    await flushPromises();
    expect(recover).toHaveBeenCalledTimes(2);
    expect(commandBridge.applyNativeCoreCommand).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().phase).toBe("faulted");

    // A later exact tick publishes a new revision and therefore a fresh,
    // independently fenced source. Only that source may retry the durable
    // disable while the same main-owned cleanup marker remains outstanding.
    authoritativeFrame = activeFrame(13, {
      nextDeadlineMs: 14_000,
      macroRecoveryHint: { kind: "finished-pending-disable", revision: 10 },
    });
    const freshSource = createNativePlayerAuthorityCommandSource(
      commandBridge,
      authoritativeFrame,
    );
    if (!freshSource) throw new Error("expected fresh native command source");
    controller.bind(binding({
      activeFrame: authoritativeFrame,
      macroStatus: null,
      timeWarp: timeWarp(),
      commandSource: freshSource,
    }));
    await flushPromises();
    expect(recover).toHaveBeenCalledTimes(3);
    expect(commandBridge.applyNativeCoreCommand).toHaveBeenCalledTimes(2);
    expect(controller.getSnapshot().phase).toBe("disabling");

    const disabledSource = createNativePlayerAuthorityCommandSource(
      commandBridge,
      authoritativeFrame,
    );
    if (!disabledSource) throw new Error("expected disabled-frame command source");
    controller.bind(binding({
      activeFrame: authoritativeFrame,
      macroStatus: null,
      timeWarp: timeWarp({
        enabled: false,
        effectiveMultiplier: 1,
        requiredPowerKw: 0,
        allocatedPowerKw: 0,
      }),
      commandSource: disabledSource,
    }));
    expect(controller.getSnapshot()).toMatchObject({
      phase: "idle",
      requested: false,
      lastErrorCode: null,
    });
  });

  it("rebases a contended start while exact ticks move, but retries active budgets exactly", async () => {
    const clock = clockHarness(100);
    const busy = () => Object.assign(new Error("persistence boundary busy"), {
      code: "NATIVE_PLAYER_AUTHORITY_PERSISTENCE_BUSY",
    });
    const rebase = () => Object.assign(new Error("start revision moved"), {
      code: "NATIVE_PLAYER_AUTHORITY_MACRO_START_REBASE_REQUIRED",
    });
    let startAttempts = 0;
    const start = vi.fn(async (budget: DesktopNativePlayerAuthorityMacroStartRequest) => {
      startAttempts += 1;
      if (startAttempts === 1) throw busy();
      if (startAttempts === 2) throw rebase();
      return activeMacroReceipt(13, budget);
    });
    let advanceAttempts = 0;
    const advance = vi.fn(async (budget: DesktopNativePlayerAuthorityMacroBudgetRequest) => {
      advanceAttempts += 1;
      if (advanceAttempts === 1) throw busy();
      return activeMacroReceipt(14, budget);
    });
    let finishAttempts = 0;
    const finish = vi.fn(async () => {
      finishAttempts += 1;
      if (finishAttempts === 1) throw busy();
      return finishedMacroReceipt(14);
    });
    const bridge = macroBridge({
      startNativePlayerAuthorityMacro: start,
      advanceNativePlayerAuthorityMacro: advance,
      finishNativePlayerAuthorityMacro: finish,
    });
    const controller = controllerWithClock(bridge, clock);
    controller.bind(binding({
      activeFrame: activeFrame(10, { nextDeadlineMs: 1_000 }),
      timeWarp: timeWarp(),
      commandSource: commandSource(10),
    }));

    await flushPromises();
    expect(controller.getSnapshot()).toMatchObject({
      phase: "starting",
      settledThroughMs: 0,
      lastErrorCode: "macro:NATIVE_PLAYER_AUTHORITY_PERSISTENCE_BUSY",
    });
    expect(clock.pending().map((timer) => timer.delayMs)).toStrictEqual([50]);
    expect(bridge.recoverNativePlayerAuthorityMacro).not.toHaveBeenCalled();

    // Persistence releases and the exact runtime advances first. A start retry
    // must use the newly observed cursor and recompute its budget.
    controller.dispose();
    expect(clock.pending()).toStrictEqual([]);
    controller.bind(binding({
      activeFrame: activeFrame(11, { nextDeadlineMs: 2_000 }),
      timeWarp: timeWarp(),
      commandSource: commandSource(11),
    }));
    expect(clock.pending().map((timer) => timer.delayMs)).toStrictEqual([50]);
    clock.runNext(1_150);
    await flushPromises();
    expect(start).toHaveBeenNthCalledWith(1, {
      expectedRevision: 10,
      simulationMilliseconds: 1_500,
      wallMilliseconds: 100,
    });
    expect(start).toHaveBeenNthCalledWith(2, {
      expectedRevision: 11,
      simulationMilliseconds: 2_250,
      wallMilliseconds: 150,
    });
    expect(controller.getSnapshot()).toMatchObject({
      phase: "starting",
      settledThroughMs: 1_000,
      lastErrorCode: "macro:NATIVE_PLAYER_AUTHORITY_MACRO_START_REBASE_REQUIRED",
    });
    expect(clock.pending().map((timer) => timer.delayMs)).toStrictEqual([100]);

    controller.bind(binding({
      activeFrame: activeFrame(12, { nextDeadlineMs: 3_000 }),
      timeWarp: timeWarp(),
      commandSource: commandSource(12),
    }));
    clock.runNext(2_150);
    await flushPromises();
    expect(start).toHaveBeenNthCalledWith(3, {
      expectedRevision: 12,
      simulationMilliseconds: 2_250,
      wallMilliseconds: 150,
    });
    expect(controller.getSnapshot()).toMatchObject({
      phase: "active",
      settledThroughMs: 2_150,
      lastErrorCode: null,
    });

    clock.runNext(3_150);
    await flushPromises();
    expect(controller.getSnapshot()).toMatchObject({
      phase: "advancing",
      settledThroughMs: 2_150,
      lastErrorCode: "macro:NATIVE_PLAYER_AUTHORITY_PERSISTENCE_BUSY",
    });
    expect(clock.pending().map((timer) => timer.delayMs)).toStrictEqual([50]);

    // Stop must not cancel the contention timer or force an immediate retry.
    controller.dispose();
    expect(clock.pending()).toStrictEqual([]);
    controller.bind(binding({
      activeFrame: activeFrame(12, { nextDeadlineMs: 3_000 }),
      timeWarp: timeWarp(),
      commandSource: commandSource(12),
    }));
    expect(clock.pending().map((timer) => timer.delayMs)).toStrictEqual([50]);
    expect(controller.requestStop()).toBe(true);
    expect(advance).toHaveBeenCalledTimes(1);
    expect(clock.pending().map((timer) => timer.delayMs)).toStrictEqual([50]);
    clock.runNext(3_150);
    await flushPromises();
    expect(advance).toHaveBeenNthCalledWith(1, {
      simulationMilliseconds: 15_000,
      wallMilliseconds: 1_000,
    });
    expect(advance).toHaveBeenNthCalledWith(2, {
      simulationMilliseconds: 15_000,
      wallMilliseconds: 1_000,
    });
    expect(controller.getSnapshot()).toMatchObject({
      phase: "finishing",
      settledThroughMs: 3_150,
      lastErrorCode: "macro:NATIVE_PLAYER_AUTHORITY_PERSISTENCE_BUSY",
    });
    expect(clock.pending().map((timer) => timer.delayMs)).toStrictEqual([50]);
    controller.dispose();
    expect(clock.pending()).toStrictEqual([]);
    controller.bind(binding({
      activeFrame: activeFrame(12, { nextDeadlineMs: 3_000 }),
      timeWarp: timeWarp(),
      commandSource: commandSource(12),
    }));
    expect(clock.pending().map((timer) => timer.delayMs)).toStrictEqual([50]);
    clock.runNext(3_200);
    await flushPromises();
    expect(finish).toHaveBeenCalledTimes(2);
    expect(controller.getSnapshot()).toMatchObject({
      phase: "waiting-disable-frame",
      settledThroughMs: 3_150,
      lastErrorCode: null,
    });
    expect(bridge.recoverNativePlayerAuthorityMacro).not.toHaveBeenCalled();
  });

  it("keeps a BUSY start pending while paused and starts once a powered frame resumes", async () => {
    const clock = clockHarness(1_100);
    const busy = Object.assign(new Error("exact tick entered before macro start"), {
      code: "NATIVE_PLAYER_AUTHORITY_MACRO_BUSY",
    });
    let attempts = 0;
    const start = vi.fn(async (budget: DesktopNativePlayerAuthorityMacroStartRequest) => {
      attempts += 1;
      if (attempts === 1) throw busy;
      return activeMacroReceipt(12, budget);
    });
    const controller = controllerWithClock(
      macroBridge({ startNativePlayerAuthorityMacro: start }),
      clock,
    );
    controller.bind(binding({
      activeFrame: activeFrame(10, { nextDeadlineMs: 1_000 }),
      paused: false,
      timeWarp: timeWarp(),
      commandSource: commandSource(10),
    }));
    await flushPromises();
    expect(start).toHaveBeenCalledTimes(1);
    expect(clock.pending().map((timer) => timer.delayMs)).toStrictEqual([50]);

    controller.bind(binding({
      activeFrame: activeFrame(11, { nextDeadlineMs: 2_000 }),
      paused: true,
      timeWarp: timeWarp(),
      commandSource: commandSource(11),
    }));
    clock.runNext(1_150);
    await flushPromises();
    expect(start).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().phase).toBe("starting");
    expect(clock.pending().map((timer) => timer.delayMs)).toStrictEqual([100]);

    controller.bind(binding({
      activeFrame: activeFrame(11, { nextDeadlineMs: 2_000 }),
      paused: false,
      timeWarp: timeWarp(),
      commandSource: commandSource(11),
    }));
    clock.runNext(1_250);
    await flushPromises();
    expect(start).toHaveBeenCalledTimes(2);
    expect(start).toHaveBeenLastCalledWith({
      expectedRevision: 11,
      simulationMilliseconds: 3_750,
      wallMilliseconds: 250,
    });
    expect(controller.getSnapshot()).toMatchObject({
      phase: "active",
      settledThroughMs: 1_250,
      lastErrorCode: null,
    });
  });

  it("re-arms a BUSY recovery backoff after StrictMode dispose without probing immediately", async () => {
    const clock = clockHarness(13_000);
    const busy = Object.assign(new Error("macro broker busy"), {
      code: "NATIVE_PLAYER_AUTHORITY_MACRO_BUSY",
    });
    let attempts = 0;
    const recover = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) throw busy;
      return finishedMacroReceipt(30, true);
    });
    const controller = controllerWithClock(
      macroBridge({ recoverNativePlayerAuthorityMacro: recover }),
      clock,
    );
    const uncertain = binding({
      activeFrame: null,
      macroStatus: macroState({
        phase: "macro-uncertain",
        revision: 30,
        nextDeadlineMs: 51_000,
        inFlight: false,
        currentOperation: null,
        pausedReason: "macro-finish-uncertain",
      }),
      paused: null,
      simulationSpeed: null,
      timeWarp: null,
      commandSource: null,
    });
    controller.bind(uncertain);
    await flushPromises();
    expect(recover).toHaveBeenCalledTimes(1);
    expect(clock.pending().map((timer) => timer.delayMs)).toStrictEqual([50]);

    controller.dispose();
    expect(clock.pending()).toStrictEqual([]);
    controller.bind(uncertain);
    expect(recover).toHaveBeenCalledTimes(1);
    expect(clock.pending().map((timer) => timer.delayMs)).toStrictEqual([50]);
    clock.runNext(13_050);
    await flushPromises();
    expect(recover).toHaveBeenCalledTimes(2);
    expect(controller.getSnapshot()).toMatchObject({
      phase: "waiting-disable-frame",
      requested: false,
      settledThroughMs: 50_000,
      lastErrorCode: null,
    });
  });

  it("fails closed for invalid startup state, unpowered frames, and invalid native receipts", async () => {
    const invalidBridge = macroBridge();
    const invalidController = controllerWithClock(invalidBridge, clockHarness(10_000));
    invalidController.bind(binding({
      activeFrame: null,
      macroStatus: macroState({
        simulationBudgetMilliseconds: 1_000,
        wallBudgetMilliseconds: 1_000,
      }),
      commandSource: null,
    }));
    expect(invalidController.getSnapshot().phase).toBe("faulted");
    expect(invalidController.getSnapshot().lastErrorCode)
      .toBe("NATIVE_PLAYER_AUTHORITY_MACRO_STATUS_INVALID");
    expect(invalidBridge.recoverNativePlayerAuthorityMacro).not.toHaveBeenCalled();
    expect(invalidBridge.startNativePlayerAuthorityMacro).not.toHaveBeenCalled();
    expect(invalidBridge.advanceNativePlayerAuthorityMacro).not.toHaveBeenCalled();

    const unpoweredBridge = macroBridge();
    const unpoweredController = controllerWithClock(unpoweredBridge, clockHarness(10_000));
    const unpowered = timeWarp({ allocatedPowerKw: 99 });
    unpoweredController.bind(binding({
      activeFrame: activeFrame(10, { nextDeadlineMs: 10_500 }),
      timeWarp: unpowered,
      commandSource: commandSource(10),
    }));
    unpoweredController.bind(binding({
      activeFrame: activeFrame(11, { nextDeadlineMs: 10_500 }),
      timeWarp: unpowered,
      commandSource: commandSource(11),
    }));
    expect(unpoweredBridge.startNativePlayerAuthorityMacro).not.toHaveBeenCalled();
    expect(unpoweredBridge.advanceNativePlayerAuthorityMacro).not.toHaveBeenCalled();
    expect(unpoweredController.getSnapshot().phase).toBe("waiting-powered-frame");

    const invalidReceiptBridge = macroBridge({
      startNativePlayerAuthorityMacro: vi.fn(async () => activeMacroReceipt(11, {
        simulationMilliseconds: 15_000,
        wallMilliseconds: 1_000,
      })),
    });
    const invalidReceiptController = controllerWithClock(invalidReceiptBridge, clockHarness(100));
    invalidReceiptController.bind(binding({
      activeFrame: activeFrame(10, { nextDeadlineMs: 1_000 }),
      timeWarp: timeWarp(),
      commandSource: commandSource(10),
    }));
    await flushPromises();
    expect(invalidReceiptController.getSnapshot().phase).toBe("faulted");
    expect(invalidReceiptController.getSnapshot().lastErrorCode)
      .toBe("NATIVE_PLAYER_AUTHORITY_MACRO_RECEIPT_INVALID");
    expect(invalidReceiptBridge.advanceNativePlayerAuthorityMacro).not.toHaveBeenCalled();
    expect(invalidReceiptBridge.recoverNativePlayerAuthorityMacro).not.toHaveBeenCalled();

    expect(createNativePlayerAuthorityMacroController({
      startNativePlayerAuthorityMacro: invalidReceiptBridge.startNativePlayerAuthorityMacro,
    } as never)).toBeNull();
  });
});
