import type {
  DesktopBridge,
  DesktopNativePlayerAuthorityClockState,
  DesktopNativePlayerAuthorityMacroReceipt,
  DesktopNativePlayerAuthorityMacroState,
} from "../desktop";
import type { FactoryTimeWarpReadModel } from "./factoryReadModels";
import type { NativePlayerAuthorityCommandSource } from "./nativePlayerAuthorityCommandSource";
import type { SimulationCommandPatch, SimulationValuePatch } from "./simulationRuntimeProtocol";

const MAX_MACRO_BUDGET_MILLISECONDS = 30 * 24 * 60 * 60 * 1_000;
const PERIODIC_WINDOW_MILLISECONDS = 1_000;
const MINIMUM_TIMER_DELAY_MILLISECONDS = 16;
const PERSISTENCE_BUSY_ERROR_CODE = "NATIVE_PLAYER_AUTHORITY_PERSISTENCE_BUSY";
const PERSISTENCE_BUSY_RETRY_BASE_MILLISECONDS = 50;
const PERSISTENCE_BUSY_RETRY_MAX_MILLISECONDS = 1_000;

interface MacroBudget {
  readonly simulationMilliseconds: number;
  readonly wallMilliseconds: number;
}

interface PendingMacroRecovery {
  readonly kind: "startup-active" | "advance" | "finish";
  readonly baseRevision: number;
  readonly multiplier: number | null;
  readonly settledThroughMs: number;
  readonly budget: MacroBudget | null;
}

type PendingPersistenceBusyRetry = Readonly<
  | {
      kind: "advance";
      start: boolean;
      budget: MacroBudget;
      phase: "starting" | "advancing" | "stopping";
    }
  | {
      kind: "finish";
      phase: "finishing";
    }
>;

type MacroBridge = Pick<
  DesktopBridge,
  | "startNativePlayerAuthorityMacro"
  | "advanceNativePlayerAuthorityMacro"
  | "finishNativePlayerAuthorityMacro"
  | "recoverNativePlayerAuthorityMacro"
>;

export type NativePlayerAuthorityMacroControllerPhase =
  | "idle"
  | "enabling"
  | "waiting-powered-frame"
  | "starting"
  | "active"
  | "advancing"
  | "stopping"
  | "finishing"
  | "recovering"
  | "waiting-disable-frame"
  | "disabling"
  | "uncertain"
  | "faulted";

export interface NativePlayerAuthorityMacroControllerSnapshot {
  readonly phase: NativePlayerAuthorityMacroControllerPhase;
  readonly requested: boolean;
  readonly effectiveMultiplier: number | null;
  readonly settledThroughMs: number | null;
  readonly lastErrorCode: string | null;
}

export interface NativePlayerAuthorityMacroControllerBinding {
  readonly activeFrame: DesktopNativePlayerAuthorityClockState | null;
  readonly macroStatus: DesktopNativePlayerAuthorityMacroState | null;
  readonly paused: boolean | null;
  readonly simulationSpeed: number | null;
  readonly timeWarp: FactoryTimeWarpReadModel | null;
  readonly commandSource: NativePlayerAuthorityCommandSource | null;
}

export interface NativePlayerAuthorityMacroControllerOptions {
  readonly now?: () => number;
  readonly schedule?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  readonly cancel?: (timer: ReturnType<typeof setTimeout>) => void;
}

const EMPTY_BINDING: NativePlayerAuthorityMacroControllerBinding = Object.freeze({
  activeFrame: null,
  macroStatus: null,
  paused: null,
  simulationSpeed: null,
  timeWarp: null,
  commandSource: null,
});

const EMPTY_SNAPSHOT: NativePlayerAuthorityMacroControllerSnapshot = Object.freeze({
  phase: "idle",
  requested: false,
  effectiveMultiplier: null,
  settledThroughMs: null,
  lastErrorCode: null,
});

function errorCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : "NATIVE_PLAYER_AUTHORITY_MACRO_FAILED";
}

function emptyCommand(baseRevision: number, topLevelChanges: SimulationValuePatch[]): SimulationCommandPatch {
  return {
    protocolVersion: 1,
    baseRevision,
    topLevelChanges,
    changedEntities: [],
    addedEntities: [],
    removedEntityIds: [],
    changedBelts: [],
    addedBelts: [],
    removedBeltIds: [],
  };
}

export function createNativeTimeWarpToggleCommand(
  baseRevision: number,
  simulationSpeed: number,
  timeWarp: FactoryTimeWarpReadModel,
  enabled: boolean,
): SimulationCommandPatch | null {
  if (!Number.isSafeInteger(baseRevision) || baseRevision < 0 ||
      !Number.isSafeInteger(simulationSpeed) || simulationSpeed < 1 ||
      typeof timeWarp.enabled !== "boolean" || timeWarp.enabled === enabled) return null;
  const changes: SimulationValuePatch[] = [{
    path: ["timeWarp", "enabled"],
    operation: "set",
    value: enabled,
  }];
  if (!enabled) {
    if (timeWarp.effectiveMultiplier !== simulationSpeed) changes.push({
      path: ["timeWarp", "effectiveMultiplier"], operation: "set", value: simulationSpeed,
    });
    if (timeWarp.requiredPowerKw !== 0) changes.push({
      path: ["timeWarp", "requiredPowerKw"], operation: "set", value: 0,
    });
    if (timeWarp.allocatedPowerKw !== 0) changes.push({
      path: ["timeWarp", "allocatedPowerKw"], operation: "set", value: 0,
    });
  }
  return emptyCommand(baseRevision, changes);
}

function poweredMultiplier(
  simulationSpeed: number | null,
  timeWarp: FactoryTimeWarpReadModel | null,
): number | null {
  if (!Number.isSafeInteger(simulationSpeed) || simulationSpeed! < 1 || !timeWarp?.enabled ||
      !Number.isSafeInteger(timeWarp.effectiveMultiplier) ||
      timeWarp.effectiveMultiplier <= simulationSpeed! ||
      !Number.isFinite(timeWarp.requiredPowerKw) || timeWarp.requiredPowerKw <= 0 ||
      !Number.isFinite(timeWarp.allocatedPowerKw) ||
      timeWarp.allocatedPowerKw < timeWarp.requiredPowerKw) return null;
  return timeWarp.effectiveMultiplier;
}

function multiplierFromMacroStatus(status: DesktopNativePlayerAuthorityMacroState): number | null {
  const simulation = status.simulationBudgetMilliseconds;
  const wall = status.wallBudgetMilliseconds;
  if (!Number.isSafeInteger(simulation) || !Number.isSafeInteger(wall) || wall! < 1 ||
      simulation! < 1 || simulation! % wall! !== 0) return null;
  const multiplier = simulation! / wall!;
  return Number.isSafeInteger(multiplier) && multiplier > 1 ? multiplier : null;
}

function settledThroughFromDeadline(nextDeadlineMs: number): number | null {
  const value = nextDeadlineMs - PERIODIC_WINDOW_MILLISECONDS;
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export class NativePlayerAuthorityMacroController {
  private readonly bridge: Required<MacroBridge>;
  private readonly now: () => number;
  private readonly schedule: NonNullable<NativePlayerAuthorityMacroControllerOptions["schedule"]>;
  private readonly cancel: NonNullable<NativePlayerAuthorityMacroControllerOptions["cancel"]>;
  private readonly listeners = new Set<() => void>();
  private binding = EMPTY_BINDING;
  private snapshotValue = EMPTY_SNAPSHOT;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private operationInFlight = false;
  private stopRequested = false;
  private enableRevision: number | null = null;
  private finishRevision: number | null = null;
  private disableRevision: number | null = null;
  private macroRevision: number | null = null;
  private pendingRecovery: PendingMacroRecovery | null = null;
  private pendingPersistenceBusyRetry: PendingPersistenceBusyRetry | null = null;
  private persistenceBusyRetryAttempt = 0;
  private recoveryKey: string | null = null;
  private generation = 0;

  constructor(bridge: MacroBridge, options: NativePlayerAuthorityMacroControllerOptions = {}) {
    if (typeof bridge.startNativePlayerAuthorityMacro !== "function" ||
        typeof bridge.advanceNativePlayerAuthorityMacro !== "function" ||
        typeof bridge.finishNativePlayerAuthorityMacro !== "function" ||
        typeof bridge.recoverNativePlayerAuthorityMacro !== "function") {
      throw new TypeError("Windows 原生纯挂机控制接口不完整");
    }
    this.bridge = bridge as Required<MacroBridge>;
    this.now = options.now ?? Date.now;
    this.schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.cancel = options.cancel ?? ((timer) => clearTimeout(timer));
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = (): NativePlayerAuthorityMacroControllerSnapshot => this.snapshotValue;

  bind(binding: NativePlayerAuthorityMacroControllerBinding): void {
    this.binding = binding;
    const macro = binding.macroStatus;
    if (macro) {
      if (this.snapshotValue.phase === "idle") {
        this.beginStartupRecovery(macro);
        return;
      }
      if (this.snapshotValue.phase === "recovering" && this.pendingRecovery === null) {
        this.beginStartupRecovery(macro);
        return;
      }
      if (this.snapshotValue.effectiveMultiplier !== null) {
        const observed = multiplierFromMacroStatus(macro);
        if (observed !== null && observed !== this.snapshotValue.effectiveMultiplier) {
          this.fail("uncertain", "NATIVE_PLAYER_AUTHORITY_MACRO_MULTIPLIER_CHANGED");
          return;
        }
      }
    }
    this.pump();
  }

  requestStart(): boolean {
    if (this.snapshotValue.phase !== "idle" || this.operationInFlight) return false;
    const { activeFrame, paused, simulationSpeed, timeWarp, commandSource } = this.binding;
    if (!activeFrame || activeFrame.schemaVersion !== 1 || activeFrame.phase !== "active" ||
        activeFrame.inFlight || activeFrame.currentOperation !== null || paused !== false ||
        !Number.isSafeInteger(simulationSpeed) || simulationSpeed! < 1 || !timeWarp ||
        !timeWarp.controllerEntityId || !commandSource ||
        commandSource.baseRevision !== activeFrame.revision) return false;
    if (this.snapshotValue.phase === "idle") this.stopRequested = false;
    this.generation += 1;
    this.macroRevision = activeFrame.revision;
    if (timeWarp.enabled) {
      this.enableRevision = activeFrame.revision - 1;
      const multiplier = poweredMultiplier(simulationSpeed, timeWarp);
      this.publish("waiting-powered-frame", true, multiplier, null, null);
      this.pump();
      return true;
    }
    const command = createNativeTimeWarpToggleCommand(
      activeFrame.revision!,
      simulationSpeed!,
      timeWarp,
      true,
    );
    if (!command) return false;
    const generation = this.generation;
    this.operationInFlight = true;
    this.publish("enabling", true, null, null, null);
    void commandSource.applyCommand(command).then((receipt) => {
      if (generation !== this.generation) return;
      this.enableRevision = receipt.revision;
      this.macroRevision = receipt.revision;
      this.publish(this.stopRequested ? "stopping" : "waiting-powered-frame",
        !this.stopRequested, null, null, null);
    }).catch((error: unknown) => {
      if (generation === this.generation) this.failForError(error, "command");
    }).finally(() => {
      if (generation !== this.generation) return;
      this.operationInFlight = false;
      this.pump();
    });
    return true;
  }

  requestStop(): boolean {
    if (this.snapshotValue.phase === "idle" || this.snapshotValue.phase === "faulted" ||
        this.snapshotValue.phase === "uncertain") return false;
    this.stopRequested = true;
    this.clearTimer();
    this.publish(
      this.snapshotValue.phase === "enabling" || this.snapshotValue.phase === "recovering"
        ? this.snapshotValue.phase
        : "stopping",
      false,
      this.snapshotValue.effectiveMultiplier,
      this.snapshotValue.settledThroughMs,
      null,
    );
    this.pump();
    return true;
  }

  dispose(): void {
    this.generation += 1;
    this.clearTimer();
    this.pendingPersistenceBusyRetry = null;
    this.listeners.clear();
  }

  private publish(
    phase: NativePlayerAuthorityMacroControllerPhase,
    requested: boolean,
    effectiveMultiplier: number | null,
    settledThroughMs: number | null,
    lastErrorCode: string | null,
  ): void {
    const next = Object.freeze({ phase, requested, effectiveMultiplier, settledThroughMs, lastErrorCode });
    if (JSON.stringify(next) === JSON.stringify(this.snapshotValue)) return;
    this.snapshotValue = next;
    for (const listener of this.listeners) listener();
  }

  private clearTimer(): void {
    if (this.timer !== null) this.cancel(this.timer);
    this.timer = null;
  }

  private arm(delayMs: number): void {
    if (this.timer !== null || this.operationInFlight) return;
    this.timer = this.schedule(() => {
      this.timer = null;
      this.pump();
    }, Math.max(MINIMUM_TIMER_DELAY_MILLISECONDS, Math.ceil(delayMs)));
  }

  private fail(phase: "uncertain" | "faulted", code: string): void {
    this.clearTimer();
    this.pendingPersistenceBusyRetry = null;
    this.persistenceBusyRetryAttempt = 0;
    this.publish(
      phase,
      this.stopRequested ? false : this.snapshotValue.requested,
      this.snapshotValue.effectiveMultiplier,
      this.snapshotValue.settledThroughMs,
      code,
    );
  }

  private failForError(error: unknown, kind: "command" | "macro"): void {
    const code = errorCode(error);
    const uncertain = code.includes("UNCERTAIN") || code.includes("TRANSPORT");
    this.fail(uncertain ? "uncertain" : "faulted", `${kind}:${code}`);
  }

  private queuePersistenceBusyRetry(retry: PendingPersistenceBusyRetry): void {
    this.pendingPersistenceBusyRetry = retry;
    this.persistenceBusyRetryAttempt = Math.min(this.persistenceBusyRetryAttempt + 1, 16);
    this.publish(
      retry.phase,
      this.stopRequested ? false : this.snapshotValue.requested,
      this.snapshotValue.effectiveMultiplier,
      this.snapshotValue.settledThroughMs,
      `macro:${PERSISTENCE_BUSY_ERROR_CODE}`,
    );
  }

  private armPersistenceBusyRetry(): void {
    const exponent = Math.min(5, Math.max(0, this.persistenceBusyRetryAttempt - 1));
    const delayMs = Math.min(
      PERSISTENCE_BUSY_RETRY_MAX_MILLISECONDS,
      PERSISTENCE_BUSY_RETRY_BASE_MILLISECONDS * (2 ** exponent),
    );
    this.arm(delayMs);
  }

  private beginStartupRecovery(status: DesktopNativePlayerAuthorityMacroState): void {
    if (status.phase === "faulted" || status.phase === "shutdown") {
      this.fail("faulted", "NATIVE_PLAYER_AUTHORITY_MACRO_RUNTIME_UNAVAILABLE");
      return;
    }
    const settled = settledThroughFromDeadline(status.nextDeadlineMs);
    const multiplier = multiplierFromMacroStatus(status);
    if (settled === null || multiplier === null) {
      if (status.inFlight || status.phase === "macro-committing" || status.phase === "macro-finishing") {
        this.publish("recovering", !this.stopRequested, null, null, null);
        return;
      }
      this.fail("faulted", "NATIVE_PLAYER_AUTHORITY_MACRO_STATUS_INVALID");
      return;
    }
    if (this.snapshotValue.phase === "idle") this.stopRequested = false;
    this.macroRevision = status.revision;
    if (status.phase === "macro-active") {
      this.pendingRecovery = Object.freeze({
        kind: "startup-active",
        baseRevision: status.revision,
        multiplier,
        settledThroughMs: settled,
        budget: null,
      });
    } else if (status.phase === "macro-uncertain" &&
        status.pausedReason === "macro-advance-uncertain" &&
        status.simulationBudgetMilliseconds !== null && status.wallBudgetMilliseconds !== null) {
      this.pendingRecovery = Object.freeze({
        kind: "advance",
        baseRevision: status.revision,
        multiplier,
        settledThroughMs: settled,
        budget: Object.freeze({
          simulationMilliseconds: status.simulationBudgetMilliseconds,
          wallMilliseconds: status.wallBudgetMilliseconds,
        }),
      });
    } else if (status.phase === "macro-uncertain" &&
        status.pausedReason === "macro-finish-uncertain") {
      this.pendingRecovery = Object.freeze({
        kind: "finish",
        baseRevision: status.revision,
        multiplier,
        settledThroughMs: settled,
        budget: null,
      });
    } else {
      this.publish("recovering", !this.stopRequested, multiplier, settled, null);
      return;
    }
    this.publish("recovering", !this.stopRequested, multiplier, settled, null);
    this.pump();
  }

  private recoverOnce(pending: PendingMacroRecovery): void {
    const key = `${pending.kind}:${pending.baseRevision}:${pending.budget?.wallMilliseconds ?? "none"}`;
    if (this.operationInFlight || this.recoveryKey === key) return;
    this.recoveryKey = key;
    const generation = this.generation;
    this.operationInFlight = true;
    void this.bridge.recoverNativePlayerAuthorityMacro().then((receipt) => {
      if (generation !== this.generation) return;
      this.acceptRecoveryReceipt(receipt, pending);
    }).catch((error: unknown) => {
      if (generation === this.generation) this.failForError(error, "macro");
    }).finally(() => {
      if (generation !== this.generation) return;
      this.operationInFlight = false;
      this.pump();
    });
  }

  private acceptRecoveryReceipt(
    receipt: DesktopNativePlayerAuthorityMacroReceipt,
    pending: PendingMacroRecovery,
  ): void {
    if (receipt.state === "finished") {
      if (pending.kind === "advance" || !receipt.recovered ||
          receipt.revision !== pending.baseRevision) {
        this.fail("faulted", "NATIVE_PLAYER_AUTHORITY_MACRO_RECOVERY_INVALID");
        return;
      }
      this.pendingRecovery = null;
      this.macroRevision = receipt.revision;
      this.finishRevision = receipt.revision;
      this.publish("waiting-disable-frame", false, pending.multiplier,
        pending.settledThroughMs, null);
      return;
    }
    if (pending.kind === "finish" || receipt.state !== "macro-active" ||
        pending.multiplier === null) {
      this.fail("faulted", "NATIVE_PLAYER_AUTHORITY_MACRO_RECOVERY_INVALID");
      return;
    }
    let settled = pending.settledThroughMs;
    if (pending.kind === "startup-active") {
      if (!receipt.recovered || receipt.revision !== pending.baseRevision ||
          receipt.previousRevision !== null ||
          receipt.simulationMilliseconds !== null || receipt.wallMilliseconds !== null) {
        this.fail("faulted", "NATIVE_PLAYER_AUTHORITY_MACRO_RECOVERY_INVALID");
        return;
      }
    } else {
      const budget = pending.budget;
      if (!budget || !receipt.recovered || receipt.previousRevision !== pending.baseRevision ||
          receipt.revision <= pending.baseRevision ||
          receipt.simulationMilliseconds !== budget.simulationMilliseconds ||
          receipt.wallMilliseconds !== budget.wallMilliseconds) {
        this.fail("faulted", "NATIVE_PLAYER_AUTHORITY_MACRO_RECOVERY_INVALID");
        return;
      }
      settled += budget.wallMilliseconds;
    }
    this.pendingRecovery = null;
    this.macroRevision = receipt.revision;
    this.publish(this.stopRequested ? "stopping" : "active", !this.stopRequested,
      pending.multiplier, settled, null);
  }

  private pump(): void {
    if (this.operationInFlight) return;
    if (this.pendingPersistenceBusyRetry) {
      if (this.timer !== null) return;
      const retry = this.pendingPersistenceBusyRetry;
      this.pendingPersistenceBusyRetry = null;
      if (retry.kind === "advance") {
        this.commitAdvanceBudget(retry.start, retry.budget);
      } else {
        this.finish();
      }
      return;
    }
    const phase = this.snapshotValue.phase;
    if (phase === "recovering" && this.pendingRecovery) {
      this.recoverOnce(this.pendingRecovery);
      return;
    }
    if (phase === "waiting-powered-frame" || (phase === "stopping" && this.enableRevision !== null &&
        this.snapshotValue.effectiveMultiplier === null)) {
      this.pumpPoweredFrame();
      return;
    }
    if (["active", "advancing", "stopping"].includes(phase) &&
        this.snapshotValue.effectiveMultiplier !== null &&
        this.snapshotValue.settledThroughMs !== null) {
      this.pumpActiveMacro();
      return;
    }
    if (phase === "waiting-disable-frame" || phase === "disabling" ||
        (phase === "stopping" && this.finishRevision !== null)) {
      this.pumpDisable();
    }
  }

  private pumpPoweredFrame(): void {
    const { activeFrame, simulationSpeed, timeWarp } = this.binding;
    if (!activeFrame || activeFrame.schemaVersion !== 1 || activeFrame.phase !== "active" ||
        activeFrame.inFlight || activeFrame.currentOperation !== null ||
        this.enableRevision === null || activeFrame.revision === null ||
        activeFrame.revision < this.enableRevision || !timeWarp?.enabled) return;
    if (this.stopRequested) {
      this.finishRevision = activeFrame.revision;
      this.publish("waiting-disable-frame", false, null, null, null);
      this.pumpDisable();
      return;
    }
    if (activeFrame.revision <= this.enableRevision) return;
    const multiplier = poweredMultiplier(simulationSpeed, timeWarp);
    const settled = activeFrame.nextDeadlineMs === null
      ? null
      : settledThroughFromDeadline(activeFrame.nextDeadlineMs);
    if (multiplier === null || settled === null) return;
    this.macroRevision = activeFrame.revision;
    this.publish("starting", true, multiplier, settled, null);
    this.commitAdvance(true);
  }

  private budget(minimumWallMilliseconds: number): MacroBudget | null {
    const multiplier = this.snapshotValue.effectiveMultiplier;
    const settled = this.snapshotValue.settledThroughMs;
    const now = this.now();
    if (!Number.isSafeInteger(multiplier) || multiplier! < 2 || settled === null ||
        !Number.isFinite(now)) return null;
    const available = Math.floor(now - settled);
    const maximumWall = Math.floor(MAX_MACRO_BUDGET_MILLISECONDS / multiplier!);
    if (available < minimumWallMilliseconds || maximumWall < 1) return null;
    const wallMilliseconds = Math.min(available, maximumWall);
    const simulationMilliseconds = wallMilliseconds * multiplier!;
    if (!Number.isSafeInteger(simulationMilliseconds) || simulationMilliseconds < 1) return null;
    return { simulationMilliseconds, wallMilliseconds };
  }

  private commitAdvance(start: boolean): void {
    const budget = this.budget(1);
    if (!budget) {
      const settled = this.snapshotValue.settledThroughMs;
      this.arm(settled === null ? PERIODIC_WINDOW_MILLISECONDS : Math.max(1, settled + 1 - this.now()));
      return;
    }
    this.commitAdvanceBudget(start, budget);
  }

  private commitAdvanceBudget(start: boolean, budget: MacroBudget): void {
    const generation = this.generation;
    this.operationInFlight = true;
    this.publish(start ? "starting" : this.stopRequested ? "stopping" : "advancing",
      !this.stopRequested, this.snapshotValue.effectiveMultiplier,
      this.snapshotValue.settledThroughMs, null);
    const operation = start
      ? this.bridge.startNativePlayerAuthorityMacro(budget)
      : this.bridge.advanceNativePlayerAuthorityMacro(budget);
    void operation.then((receipt) => {
      if (generation !== this.generation) return;
      if (receipt.state !== "macro-active" || receipt.recovered ||
          receipt.simulationMilliseconds !== budget.simulationMilliseconds ||
          receipt.wallMilliseconds !== budget.wallMilliseconds ||
          this.macroRevision === null || receipt.previousRevision !== this.macroRevision ||
          receipt.revision <= this.macroRevision) {
        this.fail("faulted", "NATIVE_PLAYER_AUTHORITY_MACRO_RECEIPT_INVALID");
        return;
      }
      const settled = this.snapshotValue.settledThroughMs! + budget.wallMilliseconds;
      this.macroRevision = receipt.revision;
      this.persistenceBusyRetryAttempt = 0;
      this.publish(this.stopRequested ? "stopping" : "active", !this.stopRequested,
        this.snapshotValue.effectiveMultiplier, settled, null);
    }).catch((error: unknown) => {
      if (generation !== this.generation) return;
      if (errorCode(error) === PERSISTENCE_BUSY_ERROR_CODE) {
        this.queuePersistenceBusyRetry(Object.freeze({
          kind: "advance",
          start,
          budget: Object.freeze({ ...budget }),
          phase: start ? "starting" : this.stopRequested ? "stopping" : "advancing",
        }));
        return;
      }
      this.persistenceBusyRetryAttempt = 0;
      this.recoverAfterUncertain(error, budget);
    }).finally(() => {
      if (generation !== this.generation) return;
      this.operationInFlight = false;
      if (this.pendingPersistenceBusyRetry) {
        this.armPersistenceBusyRetry();
        return;
      }
      this.pump();
    });
  }

  private recoverAfterUncertain(error: unknown, budget: MacroBudget): void {
    const code = errorCode(error);
    if (!code.includes("UNCERTAIN")) {
      this.failForError(error, "macro");
      return;
    }
    if (this.macroRevision === null || this.snapshotValue.effectiveMultiplier === null ||
        this.snapshotValue.settledThroughMs === null) {
      this.fail("uncertain", `macro:${code}`);
      return;
    }
    this.pendingRecovery = Object.freeze({
      kind: "advance",
      baseRevision: this.macroRevision,
      multiplier: this.snapshotValue.effectiveMultiplier,
      settledThroughMs: this.snapshotValue.settledThroughMs,
      budget: Object.freeze({ ...budget }),
    });
    this.publish("recovering", !this.stopRequested, this.snapshotValue.effectiveMultiplier,
      this.snapshotValue.settledThroughMs, `macro:${code}`);
  }

  private pumpActiveMacro(): void {
    const available = Math.floor(this.now() - this.snapshotValue.settledThroughMs!);
    if (this.stopRequested) {
      if (available >= 1) {
        this.commitAdvance(false);
        return;
      }
      this.finish();
      return;
    }
    if (available < PERIODIC_WINDOW_MILLISECONDS) {
      this.arm(PERIODIC_WINDOW_MILLISECONDS - available);
      return;
    }
    this.commitAdvance(false);
  }

  private finish(): void {
    const generation = this.generation;
    this.operationInFlight = true;
    this.publish("finishing", false, this.snapshotValue.effectiveMultiplier,
      this.snapshotValue.settledThroughMs, null);
    void this.bridge.finishNativePlayerAuthorityMacro().then((receipt) => {
      if (generation !== this.generation) return;
      if (receipt.state !== "finished" || receipt.recovered || this.macroRevision === null ||
          receipt.revision !== this.macroRevision) {
        this.fail("faulted", "NATIVE_PLAYER_AUTHORITY_MACRO_FINISH_INVALID");
        return;
      }
      this.finishRevision = receipt.revision;
      this.persistenceBusyRetryAttempt = 0;
      this.publish("waiting-disable-frame", false, this.snapshotValue.effectiveMultiplier,
        this.snapshotValue.settledThroughMs, null);
    }).catch((error: unknown) => {
      if (generation !== this.generation) return;
      const code = errorCode(error);
      if (code === PERSISTENCE_BUSY_ERROR_CODE) {
        this.queuePersistenceBusyRetry(Object.freeze({ kind: "finish", phase: "finishing" }));
        return;
      }
      this.persistenceBusyRetryAttempt = 0;
      if (!code.includes("UNCERTAIN") || this.macroRevision === null ||
          this.snapshotValue.settledThroughMs === null) {
        this.failForError(error, "macro");
        return;
      }
      this.pendingRecovery = Object.freeze({
        kind: "finish",
        baseRevision: this.macroRevision,
        multiplier: this.snapshotValue.effectiveMultiplier,
        settledThroughMs: this.snapshotValue.settledThroughMs,
        budget: null,
      });
      this.publish("recovering", false, this.snapshotValue.effectiveMultiplier,
        this.snapshotValue.settledThroughMs, `macro:${code}`);
    }).finally(() => {
      if (generation !== this.generation) return;
      this.operationInFlight = false;
      if (this.pendingPersistenceBusyRetry) {
        this.armPersistenceBusyRetry();
        return;
      }
      this.pump();
    });
  }

  private pumpDisable(): void {
    const { activeFrame, simulationSpeed, timeWarp, commandSource } = this.binding;
    if (!activeFrame || activeFrame.schemaVersion !== 1 || activeFrame.phase !== "active" ||
        activeFrame.inFlight || activeFrame.currentOperation !== null ||
        activeFrame.revision === null || this.finishRevision === null ||
        !timeWarp) return;
    if (this.disableRevision !== null) {
      if (activeFrame.revision < this.disableRevision) return;
      if (timeWarp.enabled) {
        this.fail("faulted", "NATIVE_PLAYER_AUTHORITY_MACRO_DISABLE_CONFIRMATION_INVALID");
        return;
      }
      this.resetIdle();
      return;
    }
    if (activeFrame.revision < this.finishRevision) return;
    if (!timeWarp.enabled) {
      this.resetIdle();
      return;
    }
    if (!commandSource || commandSource.baseRevision !== activeFrame.revision ||
        !Number.isSafeInteger(simulationSpeed) || simulationSpeed! < 1) return;
    const command = createNativeTimeWarpToggleCommand(
      activeFrame.revision,
      simulationSpeed!,
      timeWarp,
      false,
    );
    if (!command) return;
    const generation = this.generation;
    this.operationInFlight = true;
    this.publish("disabling", false, this.snapshotValue.effectiveMultiplier,
      this.snapshotValue.settledThroughMs, null);
    void commandSource.applyCommand(command).then((receipt) => {
      if (generation !== this.generation) return;
      this.disableRevision = receipt.revision;
      this.publish("disabling", false, this.snapshotValue.effectiveMultiplier,
        this.snapshotValue.settledThroughMs, null);
    }).catch((error: unknown) => {
      if (generation === this.generation) this.failForError(error, "command");
    }).finally(() => {
      if (generation !== this.generation) return;
      this.operationInFlight = false;
      this.pump();
    });
  }

  private resetIdle(): void {
    this.generation += 1;
    this.clearTimer();
    this.operationInFlight = false;
    this.stopRequested = false;
    this.enableRevision = null;
    this.finishRevision = null;
    this.disableRevision = null;
    this.macroRevision = null;
    this.pendingRecovery = null;
    this.pendingPersistenceBusyRetry = null;
    this.persistenceBusyRetryAttempt = 0;
    this.recoveryKey = null;
    this.publish("idle", false, null, null, null);
  }
}

export function createNativePlayerAuthorityMacroController(
  bridge: MacroBridge | null,
  options?: NativePlayerAuthorityMacroControllerOptions,
): NativePlayerAuthorityMacroController | null {
  if (!bridge || typeof bridge.startNativePlayerAuthorityMacro !== "function" ||
      typeof bridge.advanceNativePlayerAuthorityMacro !== "function" ||
      typeof bridge.finishNativePlayerAuthorityMacro !== "function" ||
      typeof bridge.recoverNativePlayerAuthorityMacro !== "function") return null;
  return new NativePlayerAuthorityMacroController(bridge, options);
}
