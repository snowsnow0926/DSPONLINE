import type {
  DesktopBridge,
  DesktopNativeCoreStatisticsProjectionResult,
  DesktopNativePlayerAuthorityClockState,
} from "../desktop";
import {
  selectActiveNativePlayerAuthorityFrame,
  type NativePlayerAuthorityClockSnapshot,
} from "./nativePlayerAuthorityClock";
import type { ProductionHistorySample } from "./types";

export const NATIVE_STATISTICS_SAMPLE_LIMIT = 512 as const;
export const NATIVE_STATISTICS_MAX_ELAPSED_SECONDS = 30 * 24 * 60 * 60 * 10_000;

export interface NativeStatisticsWorkspaceIdentity {
  readonly sessionId: string;
  readonly runId: string;
  readonly revision: number;
  readonly registryFingerprint: string;
}

export interface NativeStatisticsWorkspaceSource {
  readonly boundIdentity: NativeStatisticsWorkspaceIdentity;
  readVerifiedProjection(): Promise<DesktopNativeCoreStatisticsProjectionResult | null>;
}

export interface NativeStatisticsWorkspaceAuthorityFrames {
  /** Stable read-only display lineage; it may be the last settled frame during one tick. */
  readonly displayFrame: DesktopNativePlayerAuthorityClockState | null;
  /** Exact settled frame that is safe to use for a new broker read. */
  readonly readFrame: DesktopNativePlayerAuthorityClockState | null;
}

export interface NativeStatisticsWorkspaceFrame extends NativeStatisticsWorkspaceIdentity {
  readonly source: "native-core";
  readonly samples: readonly ProductionHistorySample[];
}

export interface NativeStatisticsWorkspaceSnapshot {
  readonly status: "empty" | "loading" | "ready" | "unavailable";
  readonly requestedRevision: number | null;
  readonly frame: NativeStatisticsWorkspaceFrame | null;
}

export type NativeStatisticsWorkspaceRefreshResult = "committed" | "superseded" | "unavailable";

const EMPTY_SNAPSHOT: NativeStatisticsWorkspaceSnapshot = Object.freeze({
  status: "empty",
  requestedRevision: null,
  frame: null,
});
const EMPTY_AUTHORITY_FRAMES: NativeStatisticsWorkspaceAuthorityFrames = Object.freeze({
  displayFrame: null,
  readFrame: null,
});
const UTF8_ENCODER = new TextEncoder();

function boundedIdentityText(value: string, maximumBytes: number): boolean {
  return value.length > 0 && UTF8_ENCODER.encode(value).byteLength <= maximumBytes &&
    !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
}

function validIdentity(identity: NativeStatisticsWorkspaceIdentity): boolean {
  return boundedIdentityText(identity.sessionId, 128) && boundedIdentityText(identity.runId, 128) &&
    Number.isSafeInteger(identity.revision) && identity.revision >= 0 &&
    boundedIdentityText(identity.registryFingerprint, 256);
}

function sameScope(
  left: NativeStatisticsWorkspaceIdentity,
  right: NativeStatisticsWorkspaceIdentity,
): boolean {
  return left.sessionId === right.sessionId && left.runId === right.runId &&
    left.registryFingerprint === right.registryFingerprint;
}

function exactIdentity(
  left: NativeStatisticsWorkspaceIdentity,
  right: NativeStatisticsWorkspaceIdentity,
): boolean {
  return sameScope(left, right) && left.revision === right.revision;
}

function identityKey(identity: NativeStatisticsWorkspaceIdentity): string {
  return `${identity.sessionId}\u0000${identity.runId}\u0000${identity.revision}\u0000${identity.registryFingerprint}`;
}

/**
 * The authority clock publishes a successful tick before its operation promise
 * is cleared. Keep the last settled frame mounted across that narrow active
 * transient, but never issue a projection read until the new frame is settled.
 * Terminal phases, lineage changes, and revision rollback fail closed.
 */
export function selectNativeStatisticsWorkspaceAuthorityFrames(
  snapshot: NativePlayerAuthorityClockSnapshot,
  sessionId: string | null,
): NativeStatisticsWorkspaceAuthorityFrames {
  const settled = selectActiveNativePlayerAuthorityFrame(snapshot, sessionId);
  if (settled) return Object.freeze({ displayFrame: settled, readFrame: settled });
  if (sessionId === null || snapshot.expectedSessionId !== sessionId) return EMPTY_AUTHORITY_FRAMES;
  const current = snapshot.currentFrame;
  const confirmed = snapshot.lastConfirmedFrame;
  if (current?.schemaVersion !== 1 || current.phase !== "active" ||
      current.sessionId !== sessionId || current.lastErrorCode !== null ||
      (!current.inFlight && current.currentOperation === null) ||
      !confirmed || confirmed.sessionId !== current.sessionId || confirmed.runId !== current.runId ||
      current.revision === null || confirmed.revision === null || current.revision < confirmed.revision ||
      current.acknowledgedSequence === null || confirmed.acknowledgedSequence === null ||
      current.acknowledgedSequence < confirmed.acknowledgedSequence) {
    return EMPTY_AUTHORITY_FRAMES;
  }
  return Object.freeze({ displayFrame: confirmed, readFrame: null });
}

function validProjection(
  projection: DesktopNativeCoreStatisticsProjectionResult,
  identity: NativeStatisticsWorkspaceIdentity,
): boolean {
  return projection.schemaVersion === 1 && projection.projectionType === "statistics-v1" &&
    projection.revision === identity.revision && projection.window.minElapsedSeconds === 0 &&
    projection.window.maxElapsedSeconds === NATIVE_STATISTICS_MAX_ELAPSED_SECONDS &&
    projection.filters.planetId === null && projection.filters.itemId === null &&
    Array.isArray(projection.samples) && projection.samples.length <= NATIVE_STATISTICS_SAMPLE_LIMIT &&
    projection.nextCursor === null;
}

export function createNativePlayerAuthorityStatisticsWorkspaceSource(
  bridge: Pick<DesktopBridge, "getNativeCoreStatisticsProjection"> | null,
  identity: NativeStatisticsWorkspaceIdentity,
): NativeStatisticsWorkspaceSource | null {
  const readProjection = bridge?.getNativeCoreStatisticsProjection;
  if (typeof readProjection !== "function" || !validIdentity(identity)) return null;
  const boundIdentity = Object.freeze({ ...identity });
  return Object.freeze({
    boundIdentity,
    async readVerifiedProjection() {
      try {
        const projection = await readProjection({
          sessionId: boundIdentity.sessionId,
          runId: boundIdentity.runId,
          expectedRevision: boundIdentity.revision,
          expectedRegistryFingerprint: boundIdentity.registryFingerprint,
          minElapsedSeconds: 0,
          maxElapsedSeconds: NATIVE_STATISTICS_MAX_ELAPSED_SECONDS,
          cursor: 0,
          limit: NATIVE_STATISTICS_SAMPLE_LIMIT,
        });
        return validProjection(projection, boundIdentity) ? projection : null;
      } catch {
        return null;
      }
    },
  });
}

/**
 * A verified older frame may remain visible only while a newer revision in the
 * exact same authority scope is loading. Scope changes and revision rollback
 * synchronously hide it, before the refresh effect has a chance to run.
 */
export function selectNativeStatisticsWorkspaceFrame(
  snapshot: NativeStatisticsWorkspaceSnapshot,
  identity: NativeStatisticsWorkspaceIdentity,
): NativeStatisticsWorkspaceFrame | null {
  const frame = snapshot.frame;
  if (!frame || !sameScope(frame, identity) || frame.revision > identity.revision ||
      snapshot.requestedRevision !== null && identity.revision < snapshot.requestedRevision) return null;
  if (snapshot.status === "ready" && frame.revision === identity.revision) return frame;
  return snapshot.status === "ready" || snapshot.status === "loading" ||
    snapshot.status === "unavailable" ? frame : null;
}

export class NativeStatisticsWorkspaceStore {
  private snapshot: NativeStatisticsWorkspaceSnapshot = EMPTY_SNAPSHOT;
  private token = 0;
  private currentKey: string | null = null;
  private flight: {
    readonly key: string;
    readonly promise: Promise<NativeStatisticsWorkspaceRefreshResult>;
  } | null = null;
  private readonly listeners = new Set<() => void>();

  getSnapshot = (): NativeStatisticsWorkspaceSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  close(): void {
    this.token += 1;
    this.currentKey = null;
    this.flight = null;
    this.publish(EMPTY_SNAPSHOT);
  }

  refresh(
    source: NativeStatisticsWorkspaceSource,
    identity: NativeStatisticsWorkspaceIdentity,
  ): Promise<NativeStatisticsWorkspaceRefreshResult> {
    if (!validIdentity(identity) || !exactIdentity(source.boundIdentity, identity)) {
      this.close();
      return Promise.resolve("unavailable");
    }
    const key = identityKey(identity);
    if (this.flight?.key === key) return this.flight.promise;
    if (this.snapshot.status === "ready" && this.snapshot.frame &&
        exactIdentity(this.snapshot.frame, identity)) return Promise.resolve("committed");

    const token = ++this.token;
    this.currentKey = key;
    const previous = this.snapshot.frame && sameScope(this.snapshot.frame, identity) &&
        this.snapshot.frame.revision <= identity.revision &&
        identity.revision >= (this.snapshot.requestedRevision ?? this.snapshot.frame.revision)
      ? this.snapshot.frame
      : null;
    this.publish(Object.freeze({
      status: "loading" as const,
      requestedRevision: identity.revision,
      frame: previous,
    }));
    const promise = this.performRefresh(source, identity, key, token);
    this.flight = { key, promise };
    void promise.finally(() => {
      if (this.flight?.promise === promise) this.flight = null;
    });
    return promise;
  }

  private async performRefresh(
    source: NativeStatisticsWorkspaceSource,
    identity: NativeStatisticsWorkspaceIdentity,
    key: string,
    token: number,
  ): Promise<NativeStatisticsWorkspaceRefreshResult> {
    const projection = await source.readVerifiedProjection();
    if (token !== this.token || key !== this.currentKey) return "superseded";
    if (!projection || !validProjection(projection, identity)) {
      this.publish(Object.freeze({
        status: "unavailable" as const,
        requestedRevision: identity.revision,
        frame: this.snapshot.frame,
      }));
      return "unavailable";
    }
    const frame: NativeStatisticsWorkspaceFrame = Object.freeze({
      source: "native-core" as const,
      ...identity,
      samples: Object.freeze([...projection.samples]),
    });
    this.publish(Object.freeze({
      status: "ready" as const,
      requestedRevision: identity.revision,
      frame,
    }));
    return "committed";
  }

  private publish(snapshot: NativeStatisticsWorkspaceSnapshot): void {
    if (this.snapshot === snapshot) return;
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }
}
