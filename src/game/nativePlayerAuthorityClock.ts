import type {
  DesktopBridge,
  DesktopNativeCoreFactoryReadModelRequest,
  DesktopNativeCoreViewportProjectionV2Request,
  DesktopNativePlayerAuthorityOperation,
  DesktopNativePlayerAuthorityPhase,
  DesktopNativePlayerAuthorityState,
} from "../desktop";
import type { NativeFactoryThinViewSource } from "./nativeFactoryThinViewStore";

const LOGICAL_ID_PATTERN = /^[A-Za-z0-9_.:-]+$/;
const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/;
const STATE_KEYS = Object.freeze([
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
const PHASES = new Set<DesktopNativePlayerAuthorityPhase>([
  "idle",
  "activating",
  "recovering",
  "active",
  "uncertain",
  "faulted",
  "shutdown",
]);
const OPERATIONS = new Set<DesktopNativePlayerAuthorityOperation | null>([
  null,
  "activation",
  "recovery",
  "tick",
  "command",
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
  readonly lastConfirmedFrame: DesktopNativePlayerAuthorityState | null;
}

const EMPTY_CLOCK_SNAPSHOT: NativePlayerAuthorityClockSnapshot = Object.freeze({
  availability: "unsupported",
  expectedSessionId: null,
  currentFrame: null,
  lastConfirmedFrame: null,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactStateKeys(value: Record<string, unknown>): boolean {
  const keys = Reflect.ownKeys(value);
  return keys.length === STATE_KEYS.length && keys.every(
    (key) => typeof key === "string" && (STATE_KEYS as readonly string[]).includes(key),
  ) && STATE_KEYS.every((key) => Object.hasOwn(value, key));
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

function hasCompleteIdentity(state: DesktopNativePlayerAuthorityState): state is DesktopNativePlayerAuthorityState & {
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

function isSettledActiveFrame(state: DesktopNativePlayerAuthorityState): boolean {
  return state.phase === "active" && hasCompleteIdentity(state) && !state.inFlight &&
    state.currentOperation === null && state.lastErrorCode === null;
}

/**
 * Re-validates both pull replies and pushed events inside the renderer.
 * Main-process normalization is a separate defense and is never trusted as a
 * substitute for this exact schema check.
 */
export function normalizeNativePlayerAuthorityClockFrame(
  value: unknown,
): DesktopNativePlayerAuthorityState {
  if (!isRecord(value) || !hasExactStateKeys(value) || value.schemaVersion !== 1 ||
    typeof value.phase !== "string" || !PHASES.has(value.phase as DesktopNativePlayerAuthorityPhase) ||
    typeof value.inFlight !== "boolean" || !OPERATIONS.has(value.currentOperation as DesktopNativePlayerAuthorityOperation | null) ||
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
  if (value.phase === "active" && (!completeIdentity || lastErrorCode !== null)) {
    throw new TypeError("active native player-authority clock frame is incomplete");
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
  });
}

function identityFrameIsOrderedAfter(
  previous: DesktopNativePlayerAuthorityState,
  candidate: DesktopNativePlayerAuthorityState,
): boolean {
  if (!hasCompleteIdentity(previous) || !hasCompleteIdentity(candidate) ||
    candidate.sessionId !== previous.sessionId || candidate.runId !== previous.runId) return false;
  const sequenceDelta = candidate.acknowledgedSequence - previous.acknowledgedSequence;
  const revisionDelta = candidate.revision - previous.revision;
  return sequenceDelta >= 0 && revisionDelta >= 0 && sequenceDelta === revisionDelta &&
    candidate.nextDeadlineMs >= previous.nextDeadlineMs;
}

/**
 * External store for the read-only main-owned authority clock.
 *
 * A session must be explicitly bound from the renderer's already-open native
 * controller before any identity-bearing frame is accepted. Pushes cannot
 * switch sessions or runs, and a malformed/stale frame cannot erase the last
 * settled receipt. An in-flight active transition triggers a pull after the
 * main microtask settles so the renderer observes the durable frame, not the
 * transitional callback snapshot.
 */
export class NativePlayerAuthorityClockController {
  private snapshot: NativePlayerAuthorityClockSnapshot = EMPTY_CLOCK_SNAPSHOT;
  private readonly listeners = new Set<() => void>();
  private expectedSessionId: string | null = null;
  private currentFrame: DesktopNativePlayerAuthorityState | null = null;
  private lastIdentityFrame: DesktopNativePlayerAuthorityState | null = null;
  private lastConfirmedFrame: DesktopNativePlayerAuthorityState | null = null;
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
    this.lastConfirmedFrame = null;
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
      const unsubscribe = subscribe((value) => this.ingest(value));
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
      const accepted = this.ingest(value);
      if (!accepted && this.snapshot.availability === "loading") this.publish("ready");
    } catch {
      if (this.started && generation === this.requestGeneration && this.snapshot.availability === "loading") {
        this.publish("ready");
      }
    }
  }

  private ingest(value: unknown): boolean {
    let candidate: DesktopNativePlayerAuthorityState;
    try {
      candidate = normalizeNativePlayerAuthorityClockFrame(value);
    } catch {
      return false;
    }
    if (!hasCompleteIdentity(candidate)) {
      // Identity-free transitions cannot prove that they belong to an already
      // bound player session. They are accepted only before a session exists.
      if (this.expectedSessionId !== null) return false;
    } else {
      if (candidate.sessionId !== this.expectedSessionId) return false;
      if (this.lastIdentityFrame && !identityFrameIsOrderedAfter(this.lastIdentityFrame, candidate)) return false;
      this.lastIdentityFrame = candidate;
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
): DesktopNativePlayerAuthorityState | null {
  if (sessionId === null || snapshot.expectedSessionId !== sessionId) return null;
  const current = snapshot.currentFrame;
  if (current?.sessionId === sessionId) return current;
  const confirmed = snapshot.lastConfirmedFrame;
  return confirmed?.sessionId === sessionId ? confirmed : null;
}

export function selectActiveNativePlayerAuthorityFrame(
  snapshot: NativePlayerAuthorityClockSnapshot,
  sessionId: string | null,
): DesktopNativePlayerAuthorityState | null {
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
