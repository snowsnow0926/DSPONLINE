import type {
  DesktopBridge,
  DesktopNativeCoreFactoryReadModelRequest,
  DesktopNativeCoreViewportProjectionV2Request,
  DesktopNativePlayerAuthorityClockState,
  DesktopNativePlayerAuthorityMacroOperation,
  DesktopNativePlayerAuthorityMacroPausedReason,
  DesktopNativePlayerAuthorityMacroPhase,
  DesktopNativePlayerAuthorityMacroState,
  DesktopNativePlayerAuthorityOperation,
  DesktopNativePlayerAuthorityPhase,
  DesktopNativePlayerAuthorityState,
} from "../desktop";
import type { NativeFactoryThinViewSource } from "./nativeFactoryThinViewStore";

const LOGICAL_ID_PATTERN = /^[A-Za-z0-9_.:-]+$/;
const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/;
const MAX_MACRO_BUDGET_MILLISECONDS = 30 * 24 * 60 * 60 * 1_000;
const CLOCK_STATE_KEYS = Object.freeze([
  "schemaVersion",
  "phase",
  "sessionId",
  "runId",
  "revision",
  "acknowledgedSequence",
  "nextSequence",
  "nextDeadlineMs",
  "inFlight",
  "currentOperation",
  "queuedCommands",
  "lastErrorCode",
] as const);
const MACRO_STATE_KEYS = Object.freeze([
  "schemaVersion",
  "statusKind",
  "phase",
  "revision",
  "acknowledgedSequence",
  "nextSequence",
  "nextDeadlineMs",
  "inFlight",
  "currentOperation",
  "simulationBudgetMilliseconds",
  "wallBudgetMilliseconds",
  "simulationProgressMilliseconds",
  "wallProgressMilliseconds",
  "pausedReason",
] as const);
const CLOCK_PHASES = new Set<DesktopNativePlayerAuthorityPhase>([
  "idle",
  "activating",
  "recovering",
  "active",
  "pausing",
  "paused",
  "resuming",
  "pause-uncertain",
  "resume-uncertain",
  "uncertain",
  "faulted",
  "shutdown",
]);
const CLOCK_OPERATIONS = new Set<DesktopNativePlayerAuthorityOperation | null>([
  null,
  "activation",
  "recovery",
  "tick",
  "command",
  "pause",
  "resume",
]);
const MACRO_PHASES = new Set<DesktopNativePlayerAuthorityMacroPhase>([
  "macro-active",
  "macro-committing",
  "macro-finishing",
  "macro-uncertain",
  "faulted",
  "shutdown",
]);
const MACRO_OPERATIONS = new Set<DesktopNativePlayerAuthorityMacroOperation | null>([
  null,
  "advance",
  "finish",
]);
const MACRO_PAUSED_REASONS = new Set<DesktopNativePlayerAuthorityMacroPausedReason>([
  "macro-window-active",
  "macro-advance-committing",
  "macro-finish-committing",
  "macro-advance-uncertain",
  "macro-finish-uncertain",
  "macro-runtime-faulted",
  "macro-runtime-shutdown",
]);

type NativePlayerAuthorityStateSource = Pick<
  DesktopBridge,
  "getNativePlayerAuthorityState" | "onNativePlayerAuthorityState"
>;

export interface NativePlayerAuthorityClockSnapshot {
  readonly availability: "unsupported" | "loading" | "ready";
  readonly expectedSessionId: string | null;
  /** Latest accepted phase transition for the explicitly bound session. */
  readonly currentFrame: DesktopNativePlayerAuthorityState | null;
  /** Last settled active receipt; terminal phases deliberately retain it. */
  readonly lastConfirmedFrame: DesktopNativePlayerAuthorityClockState | null;
}

export interface NativePlayerAuthorityWorkspaceFrames {
  /** Last verified player-authority frame that may remain mounted read-only. */
  readonly displayFrame: DesktopNativePlayerAuthorityClockState | null;
  /** Exact settled frame that is eligible to start a new projection read. */
  readonly readFrame: DesktopNativePlayerAuthorityClockState | null;
}

const EMPTY_WORKSPACE_FRAMES: NativePlayerAuthorityWorkspaceFrames = Object.freeze({
  displayFrame: null,
  readFrame: null,
});

const EMPTY_CLOCK_SNAPSHOT: NativePlayerAuthorityClockSnapshot = Object.freeze({
  availability: "unsupported",
  expectedSessionId: null,
  currentFrame: null,
  lastConfirmedFrame: null,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Reflect.ownKeys(value);
  return keys.length === expected.length && keys.every(
    (key) => typeof key === "string" && expected.includes(key),
  ) && expected.every((key) => Object.hasOwn(value, key));
}

function nullableLogicalId(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length < 1 || value.length > 128 ||
    !LOGICAL_ID_PATTERN.test(value)) throw new TypeError("native player-authority identity is invalid");
  return value;
}

function nullableSafeInteger(value: unknown, minimum: number): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new TypeError("native player-authority integer is invalid");
  }
  return value as number;
}

function hasCompleteIdentity(state: DesktopNativePlayerAuthorityClockState): state is DesktopNativePlayerAuthorityClockState & {
  sessionId: string;
  runId: string;
  revision: number;
  acknowledgedSequence: number;
  nextSequence: number;
  nextDeadlineMs: number;
} {
  return state.sessionId !== null && state.runId !== null && state.revision !== null &&
    state.acknowledgedSequence !== null && state.nextSequence !== null && state.nextDeadlineMs !== null;
}

function isSettledActiveFrame(state: DesktopNativePlayerAuthorityClockState): boolean {
  return state.phase === "active" && hasCompleteIdentity(state) && !state.inFlight &&
    state.currentOperation === null && state.lastErrorCode === null;
}

/**
 * Re-validates both pull replies and pushed events inside the renderer.
 * Main-process normalization is a separate defense and is never trusted as a
 * substitute for this exact schema check.
 */
function normalizeClockState(value: Record<string, unknown>): DesktopNativePlayerAuthorityClockState {
  const clockStateKeys = Object.hasOwn(value, "macroRecoveryHint")
    ? [...CLOCK_STATE_KEYS, "macroRecoveryHint"]
    : CLOCK_STATE_KEYS;
  if (!hasExactKeys(value, clockStateKeys) || value.schemaVersion !== 1 ||
    typeof value.phase !== "string" || !CLOCK_PHASES.has(value.phase as DesktopNativePlayerAuthorityPhase) ||
    typeof value.inFlight !== "boolean" ||
    !CLOCK_OPERATIONS.has(value.currentOperation as DesktopNativePlayerAuthorityOperation | null) ||
    !Number.isSafeInteger(value.queuedCommands) || (value.queuedCommands as number) < 0 ||
    (value.queuedCommands as number) > 64) {
    throw new TypeError("native player-authority clock frame is invalid");
  }
  const sessionId = nullableLogicalId(value.sessionId);
  const runId = nullableLogicalId(value.runId);
  const revision = nullableSafeInteger(value.revision, 0);
  const acknowledgedSequence = nullableSafeInteger(value.acknowledgedSequence, 0);
  const nextSequence = nullableSafeInteger(value.nextSequence, 1);
  const nextDeadlineMs = nullableSafeInteger(value.nextDeadlineMs, 0);
  const lastErrorCode = value.lastErrorCode === null
    ? null
    : typeof value.lastErrorCode === "string" && ERROR_CODE_PATTERN.test(value.lastErrorCode)
      ? value.lastErrorCode
      : (() => { throw new TypeError("native player-authority error code is invalid"); })();
  const identity = [sessionId, runId, revision, acknowledgedSequence, nextSequence, nextDeadlineMs];
  const completeIdentity = identity.every((entry) => entry !== null);
  const emptyIdentity = identity.every((entry) => entry === null);
  if (!completeIdentity && !emptyIdentity) {
    throw new TypeError("native player-authority clock identity is partial");
  }
  if (completeIdentity && (acknowledgedSequence as number) + 1 !== nextSequence) {
    throw new TypeError("native player-authority clock sequence is discontinuous");
  }
  if (["idle", "activating", "recovering"].includes(value.phase) && !emptyIdentity) {
    throw new TypeError("pre-authority clock frame exposes an identity");
  }
  if (["active", "pausing", "paused", "resuming", "pause-uncertain", "resume-uncertain"]
    .includes(value.phase) && !completeIdentity) {
    throw new TypeError("native player-authority lifecycle clock frame is incomplete");
  }
  if (value.phase === "active" && lastErrorCode !== null) {
    throw new TypeError("active native player-authority clock frame is incomplete");
  }
  if (value.phase === "paused" &&
      (value.inFlight || value.currentOperation !== null || lastErrorCode !== null ||
        value.queuedCommands !== 0)) {
    throw new TypeError("paused native player-authority clock frame is not settled");
  }
  if (value.phase === "pausing" &&
      (value.currentOperation !== "pause" || lastErrorCode !== null) ||
      value.phase === "resuming" &&
      (value.currentOperation !== "resume" || lastErrorCode !== null)) {
    throw new TypeError("native player-authority pause transition is invalid");
  }
  if (value.phase === "pause-uncertain" &&
      (lastErrorCode === null || ![null, "pause"].includes(value.currentOperation as null | "pause")) ||
      value.phase === "resume-uncertain" &&
      (lastErrorCode === null || ![null, "resume"].includes(value.currentOperation as null | "resume"))) {
    throw new TypeError("native player-authority pause transition is uncertain");
  }
  let macroRecoveryHint: DesktopNativePlayerAuthorityClockState["macroRecoveryHint"];
  if (Object.hasOwn(value, "macroRecoveryHint")) {
    const hint = value.macroRecoveryHint;
    if (!isRecord(hint) || !hasExactKeys(hint, ["kind", "revision"]) ||
      hint.kind !== "finished-pending-disable" || value.phase !== "active" ||
      !Number.isSafeInteger(hint.revision) || (hint.revision as number) < 0 ||
      revision === null || (hint.revision as number) > revision) {
      throw new TypeError("native player-authority macro recovery hint is invalid");
    }
    macroRecoveryHint = Object.freeze({
      kind: "finished-pending-disable",
      revision: hint.revision as number,
    });
  }
  return Object.freeze({
    schemaVersion: 1,
    phase: value.phase as DesktopNativePlayerAuthorityPhase,
    sessionId,
    runId,
    revision,
    acknowledgedSequence,
    nextSequence,
    nextDeadlineMs,
    inFlight: value.inFlight,
    currentOperation: value.currentOperation as DesktopNativePlayerAuthorityOperation | null,
    queuedCommands: value.queuedCommands as number,
    lastErrorCode,
    ...(macroRecoveryHint ? { macroRecoveryHint } : {}),
  });
}

function normalizeMacroState(value: Record<string, unknown>): DesktopNativePlayerAuthorityMacroState {
  if (!hasExactKeys(value, MACRO_STATE_KEYS) || value.schemaVersion !== 2 || value.statusKind !== "macro" ||
    typeof value.phase !== "string" || !MACRO_PHASES.has(value.phase as DesktopNativePlayerAuthorityMacroPhase) ||
    typeof value.inFlight !== "boolean" ||
    !MACRO_OPERATIONS.has(value.currentOperation as DesktopNativePlayerAuthorityMacroOperation | null) ||
    typeof value.pausedReason !== "string" ||
    !MACRO_PAUSED_REASONS.has(value.pausedReason as DesktopNativePlayerAuthorityMacroPausedReason)) {
    throw new TypeError("native player-authority macro frame is invalid");
  }
  const revision = nullableSafeInteger(value.revision, 0);
  const acknowledgedSequence = nullableSafeInteger(value.acknowledgedSequence, 0);
  const nextSequence = nullableSafeInteger(value.nextSequence, 1);
  const nextDeadlineMs = nullableSafeInteger(value.nextDeadlineMs, 0);
  if (revision === null || acknowledgedSequence === null || nextSequence === null || nextDeadlineMs === null ||
    acknowledgedSequence + 1 !== nextSequence) {
    throw new TypeError("native player-authority macro clock is invalid");
  }
  const nullableBudget = (entry: unknown): number | null => {
    const result = nullableSafeInteger(entry, 1);
    if (result !== null && result > MAX_MACRO_BUDGET_MILLISECONDS) {
      throw new TypeError("native player-authority macro budget is invalid");
    }
    return result;
  };
  const simulationBudgetMilliseconds = nullableBudget(value.simulationBudgetMilliseconds);
  const wallBudgetMilliseconds = nullableBudget(value.wallBudgetMilliseconds);
  if ((simulationBudgetMilliseconds === null) !== (wallBudgetMilliseconds === null)) {
    throw new TypeError("native player-authority macro budget group is partial");
  }
  const nullableProgress = (entry: unknown, maximum: number | null): number | null => {
    const result = nullableSafeInteger(entry, 0);
    if (result !== null && (maximum === null || result > maximum)) {
      throw new TypeError("native player-authority macro progress is invalid");
    }
    return result;
  };
  const simulationProgressMilliseconds = nullableProgress(
    value.simulationProgressMilliseconds,
    simulationBudgetMilliseconds,
  );
  const wallProgressMilliseconds = nullableProgress(
    value.wallProgressMilliseconds,
    wallBudgetMilliseconds,
  );
  if ((simulationProgressMilliseconds === null) !== (wallProgressMilliseconds === null)) {
    throw new TypeError("native player-authority macro progress group is partial");
  }
  const phase = value.phase as DesktopNativePlayerAuthorityMacroPhase;
  const currentOperation = value.currentOperation as DesktopNativePlayerAuthorityMacroOperation | null;
  const pausedReason = value.pausedReason as DesktopNativePlayerAuthorityMacroPausedReason;
  const phaseShapeIsValid = phase === "macro-active"
    ? !value.inFlight && currentOperation === null && pausedReason === "macro-window-active"
    : phase === "macro-committing"
      ? currentOperation === "advance" && pausedReason === "macro-advance-committing"
      : phase === "macro-finishing"
        ? currentOperation === "finish" && pausedReason === "macro-finish-committing"
        : phase === "macro-uncertain"
          ? value.inFlight === (currentOperation !== null) &&
            (pausedReason === "macro-advance-uncertain"
              ? currentOperation === null || currentOperation === "advance"
              : pausedReason === "macro-finish-uncertain" &&
                (currentOperation === null || currentOperation === "finish"))
          : phase === "faulted"
            ? pausedReason === "macro-runtime-faulted"
            : pausedReason === "macro-runtime-shutdown";
  if (!phaseShapeIsValid) throw new TypeError("native player-authority macro phase status is invalid");
  return Object.freeze({
    schemaVersion: 2,
    statusKind: "macro",
    phase,
    revision,
    acknowledgedSequence,
    nextSequence,
    nextDeadlineMs,
    inFlight: value.inFlight,
    currentOperation,
    simulationBudgetMilliseconds,
    wallBudgetMilliseconds,
    simulationProgressMilliseconds,
    wallProgressMilliseconds,
    pausedReason,
  });
}

export function normalizeNativePlayerAuthorityClockFrame(
  value: unknown,
): DesktopNativePlayerAuthorityState {
  if (!isRecord(value)) throw new TypeError("native player-authority clock frame is invalid");
  if (value.schemaVersion === 1) return normalizeClockState(value);
  if (value.schemaVersion === 2) return normalizeMacroState(value);
  throw new TypeError("native player-authority clock frame schema is invalid");
}

function clockFrameIsOrderedAfter(
  previous: DesktopNativePlayerAuthorityState,
  candidate: DesktopNativePlayerAuthorityState,
): boolean {
  if (previous.revision === null || previous.acknowledgedSequence === null ||
    previous.nextDeadlineMs === null || candidate.revision === null ||
    candidate.acknowledgedSequence === null || candidate.nextDeadlineMs === null) return false;
  const sequenceDelta = candidate.acknowledgedSequence - previous.acknowledgedSequence;
  const revisionDelta = candidate.revision - previous.revision;
  return sequenceDelta >= 0 && revisionDelta >= 0 && sequenceDelta === revisionDelta &&
    candidate.nextDeadlineMs >= previous.nextDeadlineMs;
}

function identityFrameMatches(
  previous: DesktopNativePlayerAuthorityClockState,
  candidate: DesktopNativePlayerAuthorityClockState,
): boolean {
  return hasCompleteIdentity(previous) && hasCompleteIdentity(candidate) &&
    candidate.sessionId === previous.sessionId && candidate.runId === previous.runId;
}

/**
 * External store for the read-only main-owned authority clock.
 *
 * A session must be explicitly bound from the renderer's already-open native
 * controller before any identity-bearing push is accepted. A trusted pull may
 * discover a main-owned startup-recovery session when no renderer session was
 * available to bind: the pull is served by the main-process broker after it
 * independently proves Rust ownership. Pushes remain wake-up signals only and
 * can never establish or switch that binding.
 *
 * Startup-recovered macro v2 frames deliberately contain no session identity.
 * The first such frame is therefore accepted only from a trusted pull while
 * the binding is deferred. Later macro pushes are ordered against that pulled
 * clock. When the macro finishes, an identity-bearing push again causes a pull;
 * only that pull may reveal and bind the real v1 session. A malformed/stale
 * frame cannot erase the last settled receipt. The legacy v1 clock retains its
 * existing reconciliation behavior, including a repeated pull while an exact
 * tick is still reported in flight.
 */
export class NativePlayerAuthorityClockController {
  private snapshot: NativePlayerAuthorityClockSnapshot = EMPTY_CLOCK_SNAPSHOT;
  private readonly listeners = new Set<() => void>();
  private expectedSessionId: string | null = null;
  private currentFrame: DesktopNativePlayerAuthorityState | null = null;
  private lastIdentityFrame: DesktopNativePlayerAuthorityClockState | null = null;
  private lastOrderedFrame: DesktopNativePlayerAuthorityState | null = null;
  private lastConfirmedFrame: DesktopNativePlayerAuthorityClockState | null = null;
  private deferredMacroAccepted = false;
  private unsubscribe: (() => void) | null = null;
  private started = false;
  private requestGeneration = 0;
  private reconcileScheduled = false;

  constructor(private readonly source: NativePlayerAuthorityStateSource | null) {}

  getSnapshot = (): NativePlayerAuthorityClockSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  bindSession(sessionId: string | null): void {
    if (sessionId !== null && (sessionId.length > 128 || !LOGICAL_ID_PATTERN.test(sessionId))) {
      throw new TypeError("native player-authority bound session is invalid");
    }
    if (this.expectedSessionId === sessionId) return;
    this.expectedSessionId = sessionId;
    this.currentFrame = null;
    this.lastIdentityFrame = null;
    this.lastOrderedFrame = null;
    this.lastConfirmedFrame = null;
    this.deferredMacroAccepted = false;
    this.requestGeneration += 1;
    this.publish(this.started ? "loading" : this.source ? "ready" : "unsupported");
    if (this.started) void this.refresh();
  }

  start(): void {
    if (this.started) return;
    const getState = this.source?.getNativePlayerAuthorityState;
    const subscribe = this.source?.onNativePlayerAuthorityState;
    if (typeof getState !== "function" || typeof subscribe !== "function") {
      this.publish("unsupported");
      return;
    }
    this.started = true;
    this.requestGeneration += 1;
    this.publish("loading");
    try {
      const unsubscribe = subscribe((value) => this.ingest(value, true));
      if (typeof unsubscribe !== "function") throw new TypeError("native authority unsubscribe is invalid");
      this.unsubscribe = unsubscribe;
    } catch {
      this.started = false;
      this.publish("unsupported");
      return;
    }
    void this.refresh();
  }

  stop(): void {
    if (!this.started && !this.unsubscribe) return;
    this.started = false;
    this.requestGeneration += 1;
    const unsubscribe = this.unsubscribe;
    this.unsubscribe = null;
    unsubscribe?.();
  }

  async refresh(): Promise<void> {
    const getState = this.source?.getNativePlayerAuthorityState;
    if (!this.started || typeof getState !== "function") return;
    const generation = this.requestGeneration;
    try {
      const value: unknown = await getState();
      if (!this.started || generation !== this.requestGeneration) return;
      const accepted = this.ingest(value, false);
      if (!accepted && this.snapshot.availability === "loading") this.publish("ready");
    } catch {
      if (this.started && generation === this.requestGeneration && this.snapshot.availability === "loading") {
        this.publish("ready");
      }
    }
  }

  private ingest(value: unknown, pushed: boolean): boolean {
    let candidate: DesktopNativePlayerAuthorityState;
    try {
      candidate = normalizeNativePlayerAuthorityClockFrame(value);
    } catch {
      return false;
    }
    if (candidate.schemaVersion === 2) {
      if (this.expectedSessionId === null) {
        if (!this.deferredMacroAccepted) {
          // An identity-free push cannot prove that Rust already owned the
          // player save when this renderer started. Use it only to wake a
          // brokered pull; the pull result is the first trusted observation.
          if (pushed) {
            this.scheduleSettledPull();
            return false;
          }
          this.deferredMacroAccepted = true;
        } else if (!this.lastOrderedFrame ||
          !clockFrameIsOrderedAfter(this.lastOrderedFrame, candidate)) return false;
      } else if (!this.lastIdentityFrame ||
        !hasCompleteIdentity(this.lastIdentityFrame) ||
        this.lastIdentityFrame.sessionId !== this.expectedSessionId ||
        !this.lastOrderedFrame || !clockFrameIsOrderedAfter(this.lastOrderedFrame, candidate)) return false;
      this.lastOrderedFrame = candidate;
      this.currentFrame = candidate;
      this.publish("ready");
      if (pushed && (candidate.inFlight ||
        ["macro-committing", "macro-finishing"].includes(candidate.phase))) {
        this.scheduleSettledPull();
      }
      return true;
    }
    if (!hasCompleteIdentity(candidate)) {
      // Identity-free transitions cannot prove that they belong to an already
      // bound player session. Macro v2 uses the separately guarded branch.
      if (this.expectedSessionId !== null || this.deferredMacroAccepted) return false;
      this.lastIdentityFrame = null;
      this.lastOrderedFrame = null;
    } else {
      if (this.expectedSessionId === null) {
        // The renderer may start after Rust recovered a durable authority
        // lease, so its shadow controller has no session to bind. Never trust
        // the pushed identity directly: make the push trigger a brokered pull,
        // and establish the binding only from that pull reply.
        if (pushed) {
          this.scheduleSettledPull();
          return false;
        }
        if (this.lastOrderedFrame &&
          !clockFrameIsOrderedAfter(this.lastOrderedFrame, candidate)) return false;
        this.expectedSessionId = candidate.sessionId;
        this.deferredMacroAccepted = false;
      } else if (candidate.sessionId !== this.expectedSessionId) return false;
      if (this.lastIdentityFrame && !identityFrameMatches(this.lastIdentityFrame, candidate)) return false;
      if (this.lastOrderedFrame && !clockFrameIsOrderedAfter(this.lastOrderedFrame, candidate)) return false;
      this.lastIdentityFrame = candidate;
      this.lastOrderedFrame = candidate;
    }
    this.currentFrame = candidate;
    if (isSettledActiveFrame(candidate)) this.lastConfirmedFrame = candidate;
    this.publish("ready");
    if (candidate.phase === "active" && candidate.inFlight) this.scheduleSettledPull();
    return true;
  }

  private scheduleSettledPull(): void {
    if (this.reconcileScheduled) return;
    this.reconcileScheduled = true;
    queueMicrotask(() => {
      this.reconcileScheduled = false;
      void this.refresh();
    });
  }

  private publish(availability: NativePlayerAuthorityClockSnapshot["availability"]): void {
    const next = Object.freeze({
      availability,
      expectedSessionId: this.expectedSessionId,
      currentFrame: this.currentFrame,
      lastConfirmedFrame: this.lastConfirmedFrame,
    });
    if (this.snapshot.availability === next.availability &&
      this.snapshot.expectedSessionId === next.expectedSessionId &&
      this.snapshot.currentFrame === next.currentFrame &&
      this.snapshot.lastConfirmedFrame === next.lastConfirmedFrame) return;
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
}

export function selectBoundNativePlayerAuthorityFrame(
  snapshot: NativePlayerAuthorityClockSnapshot,
  sessionId: string | null,
): DesktopNativePlayerAuthorityClockState | null {
  if (sessionId === null || snapshot.expectedSessionId !== sessionId) return null;
  const current = snapshot.currentFrame;
  if (current?.schemaVersion === 1 && current.sessionId === sessionId) return current;
  const confirmed = snapshot.lastConfirmedFrame;
  return confirmed?.sessionId === sessionId ? confirmed : null;
}

export function selectActiveNativePlayerAuthorityFrame(
  snapshot: NativePlayerAuthorityClockSnapshot,
  sessionId: string | null,
): DesktopNativePlayerAuthorityClockState | null {
  if (snapshot.currentFrame?.schemaVersion === 2) return null;
  const current = selectBoundNativePlayerAuthorityFrame(snapshot, sessionId);
  if (!current || !isSettledActiveFrame(current)) return null;
  const confirmed = snapshot.lastConfirmedFrame;
  return confirmed?.sessionId === current.sessionId && confirmed.runId === current.runId &&
    confirmed.revision === current.revision &&
    confirmed.acknowledgedSequence === current.acknowledgedSequence
    ? confirmed
    : null;
}

/**
 * A successful tick is published before main clears the in-flight operation.
 * Keep the last settled frame mounted during that narrow transition, but do
 * not allow a projection read until main exposes the new settled frame. A run
 * switch, revision rollback, terminal phase, or sequence rollback fails closed.
 */
export function selectNativePlayerAuthorityWorkspaceFrames(
  snapshot: NativePlayerAuthorityClockSnapshot,
  sessionId: string | null,
): NativePlayerAuthorityWorkspaceFrames {
  const settled = selectActiveNativePlayerAuthorityFrame(snapshot, sessionId);
  if (settled) return Object.freeze({ displayFrame: settled, readFrame: settled });
  if (sessionId === null || snapshot.expectedSessionId !== sessionId) return EMPTY_WORKSPACE_FRAMES;
  const current = snapshot.currentFrame;
  const confirmed = snapshot.lastConfirmedFrame;
  if (current?.schemaVersion !== 1 || current.phase !== "active" ||
      current.sessionId !== sessionId || current.lastErrorCode !== null ||
      (!current.inFlight && current.currentOperation === null) ||
      !confirmed || confirmed.sessionId !== current.sessionId || confirmed.runId !== current.runId ||
      current.revision === null || confirmed.revision === null || current.revision < confirmed.revision ||
      current.acknowledgedSequence === null || confirmed.acknowledgedSequence === null ||
      current.acknowledgedSequence < confirmed.acknowledgedSequence) {
    return EMPTY_WORKSPACE_FRAMES;
  }
  return Object.freeze({ displayFrame: confirmed, readFrame: null });
}

export function selectNativePlayerAuthorityMacroStatus(
  snapshot: NativePlayerAuthorityClockSnapshot,
  sessionId: string | null,
): DesktopNativePlayerAuthorityMacroState | null {
  const current = snapshot.currentFrame;
  if (current?.schemaVersion !== 2) return null;
  // A startup-recovered macro intentionally redacts its session identity. It
  // is still an authoritative read-only ownership signal after the controller
  // accepted it from a trusted pull. Once a v1 identity is known, callers must
  // provide that exact binding as before.
  if (snapshot.expectedSessionId === null) return sessionId === null ? current : null;
  return sessionId === snapshot.expectedSessionId ? current : null;
}

/**
 * Read-only source for an already main-owned player-authority session. The
 * main projection broker independently checks phase/session/revision before
 * and after every read. This adapter exposes no authority mutation method.
 */
export function createNativePlayerAuthorityProjectionSource(
  bridge: Pick<DesktopBridge, "getNativeCoreFactoryReadModel" | "getNativeCoreViewportProjectionV2"> | null,
  sessionId: string,
): NativeFactoryThinViewSource | null {
  if (!bridge || sessionId.length < 1 || sessionId.length > 128 || !LOGICAL_ID_PATTERN.test(sessionId) ||
    typeof bridge.getNativeCoreFactoryReadModel !== "function" ||
    typeof bridge.getNativeCoreViewportProjectionV2 !== "function") return null;
  return Object.freeze({
    async readVerifiedFactoryReadModel(
      request: Omit<DesktopNativeCoreFactoryReadModelRequest, "sessionId" | "expectedRevision">,
      expectedRevision: number,
    ) {
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) return null;
      try {
        const result = await bridge.getNativeCoreFactoryReadModel({ ...request, sessionId, expectedRevision });
        return result.revision === expectedRevision ? result : null;
      } catch {
        return null;
      }
    },
    async readVerifiedViewportProjectionV2(
      request: Omit<DesktopNativeCoreViewportProjectionV2Request, "sessionId" | "expectedRevision">,
      expectedRevision: number,
    ) {
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) return null;
      try {
        const result = await bridge.getNativeCoreViewportProjectionV2({ ...request, sessionId, expectedRevision });
        return result.revision === expectedRevision ? result : null;
      } catch {
        return null;
      }
    },
  });
}
