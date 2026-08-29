import { describe, expect, it, vi } from "vitest";

import type {
  DesktopBridge,
  DesktopNativePlayerAuthorityClockState,
  DesktopNativePlayerAuthorityMacroBudgetRequest,
  DesktopNativePlayerAuthorityMacroReceipt,
  DesktopNativePlayerAuthorityMacroState,
} from "../desktop";
import type { FactoryTimeWarpReadModel } from "./factoryReadModels";
import type {
  NativePlayerAuthorityCommandReceipt,
  NativePlayerAuthorityCommandSource,
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
  it("builds exact enable and disable toggle command patches", () => {
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
        path: ["timeWarp", "enabled"],
        operation: "set",
        value: true,
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
      topLevelChanges: [
        { path: ["timeWarp", "enabled"], operation: "set", value: false },
        { path: ["timeWarp", "effectiveMultiplier"], operation: "set", value: 1 },
        { path: ["timeWarp", "requiredPowerKw"], operation: "set", value: 0 },
        { path: ["timeWarp", "allocatedPowerKw"], operation: "set", value: 0 },
      ],
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
    const start = vi.fn(async (budget: DesktopNativePlayerAuthorityMacroBudgetRequest) =>
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
    const start = vi.fn(async (budget: DesktopNativePlayerAuthorityMacroBudgetRequest) =>
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
    expect(controller.requestStart()).toBe(true);
    await flushPromises();
    expect(start).toHaveBeenCalledWith({
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

  it("retries start, advance, and finish after persistence BUSY without changing the cursor", async () => {
    const clock = clockHarness(100);
    const busy = () => Object.assign(new Error("persistence boundary busy"), {
      code: "NATIVE_PLAYER_AUTHORITY_PERSISTENCE_BUSY",
    });
    let startAttempts = 0;
    const start = vi.fn(async (budget: DesktopNativePlayerAuthorityMacroBudgetRequest) => {
      startAttempts += 1;
      if (startAttempts === 1) throw busy();
      return activeMacroReceipt(11, budget);
    });
    let advanceAttempts = 0;
    const advance = vi.fn(async (budget: DesktopNativePlayerAuthorityMacroBudgetRequest) => {
      advanceAttempts += 1;
      if (advanceAttempts === 1) throw busy();
      return activeMacroReceipt(12, budget);
    });
    let finishAttempts = 0;
    const finish = vi.fn(async () => {
      finishAttempts += 1;
      if (finishAttempts === 1) throw busy();
      return finishedMacroReceipt(12);
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

    expect(controller.requestStart()).toBe(true);
    await flushPromises();
    expect(controller.getSnapshot()).toMatchObject({
      phase: "starting",
      settledThroughMs: 0,
      lastErrorCode: "macro:NATIVE_PLAYER_AUTHORITY_PERSISTENCE_BUSY",
    });
    expect(clock.pending().map((timer) => timer.delayMs)).toStrictEqual([50]);
    expect(bridge.recoverNativePlayerAuthorityMacro).not.toHaveBeenCalled();
    clock.runNext(150);
    await flushPromises();
    expect(start).toHaveBeenNthCalledWith(1, {
      simulationMilliseconds: 1_500,
      wallMilliseconds: 100,
    });
    expect(start).toHaveBeenNthCalledWith(2, {
      simulationMilliseconds: 1_500,
      wallMilliseconds: 100,
    });
    expect(controller.getSnapshot()).toMatchObject({
      phase: "active",
      settledThroughMs: 100,
      lastErrorCode: null,
    });

    clock.runNext(1_100);
    await flushPromises();
    expect(controller.getSnapshot()).toMatchObject({
      phase: "advancing",
      settledThroughMs: 100,
      lastErrorCode: "macro:NATIVE_PLAYER_AUTHORITY_PERSISTENCE_BUSY",
    });
    expect(clock.pending().map((timer) => timer.delayMs)).toStrictEqual([50]);
    clock.runNext(1_150);
    await flushPromises();
    expect(advance).toHaveBeenNthCalledWith(1, {
      simulationMilliseconds: 15_000,
      wallMilliseconds: 1_000,
    });
    expect(advance).toHaveBeenNthCalledWith(2, {
      simulationMilliseconds: 15_000,
      wallMilliseconds: 1_000,
    });
    expect(controller.getSnapshot()).toMatchObject({ phase: "active", settledThroughMs: 1_100 });

    clock.setNow(1_100);
    expect(controller.requestStop()).toBe(true);
    await flushPromises();
    expect(controller.getSnapshot()).toMatchObject({
      phase: "finishing",
      settledThroughMs: 1_100,
      lastErrorCode: "macro:NATIVE_PLAYER_AUTHORITY_PERSISTENCE_BUSY",
    });
    expect(clock.pending().map((timer) => timer.delayMs)).toStrictEqual([50]);
    clock.runNext(1_150);
    await flushPromises();
    expect(finish).toHaveBeenCalledTimes(2);
    expect(controller.getSnapshot()).toMatchObject({
      phase: "waiting-disable-frame",
      settledThroughMs: 1_100,
      lastErrorCode: null,
    });
    expect(bridge.recoverNativePlayerAuthorityMacro).not.toHaveBeenCalled();
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
    expect(unpoweredController.requestStart()).toBe(true);
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
    expect(invalidReceiptController.requestStart()).toBe(true);
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
