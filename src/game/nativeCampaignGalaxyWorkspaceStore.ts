import type {
  DesktopBridge,
  DesktopNativeCoreCampaignWorkspaceProjectionResult,
  DesktopNativeCoreGalaxyAccountWorkspaceProjectionResult,
  DesktopNativePlayerAuthorityClockState,
} from "../desktop";
import { CAMPAIGN_CHAPTERS, CAMPAIGN_TASKS } from "./campaign";
import {
  selectActiveNativePlayerAuthorityFrame,
  type NativePlayerAuthorityClockSnapshot,
} from "./nativePlayerAuthorityClock";

export interface NativeCampaignGalaxyWorkspaceIdentity {
  readonly sessionId: string;
  readonly runId: string;
  readonly revision: number;
  readonly registryFingerprint: string;
}

export interface NativeCampaignGalaxyWorkspaceAuthorityFrames {
  /** Stable read-only lineage that may remain mounted during one active tick. */
  readonly displayFrame: DesktopNativePlayerAuthorityClockState | null;
  /** Settled lineage that is eligible to start a new broker read. */
  readonly readFrame: DesktopNativePlayerAuthorityClockState | null;
}

export interface NativeCampaignWorkspaceFrame extends NativeCampaignGalaxyWorkspaceIdentity {
  readonly source: "native-core";
  readonly projection: DesktopNativeCoreCampaignWorkspaceProjectionResult;
}

export interface NativeGalaxyWorkspaceFrame extends NativeCampaignGalaxyWorkspaceIdentity {
  readonly source: "native-core";
  readonly projection: DesktopNativeCoreGalaxyAccountWorkspaceProjectionResult;
}

export type NativeCampaignGalaxyWorkspaceReadStatus = "empty" | "loading" | "ready" | "unavailable";
export type NativeCampaignGalaxyWorkspaceRefreshResult = "committed" | "superseded" | "unavailable";

interface NativeWorkspaceSnapshot<Frame> {
  readonly status: NativeCampaignGalaxyWorkspaceReadStatus;
  readonly requestedRevision: number | null;
  readonly frame: Frame | null;
}

export type NativeCampaignWorkspaceSnapshot = NativeWorkspaceSnapshot<NativeCampaignWorkspaceFrame>;
export type NativeGalaxyWorkspaceSnapshot = NativeWorkspaceSnapshot<NativeGalaxyWorkspaceFrame>;

interface NativeWorkspaceSource<Projection> {
  readonly boundIdentity: NativeCampaignGalaxyWorkspaceIdentity;
  readVerifiedProjection(): Promise<Projection | null>;
}

export type NativeCampaignWorkspaceSource =
  NativeWorkspaceSource<DesktopNativeCoreCampaignWorkspaceProjectionResult>;
export type NativeGalaxyWorkspaceSource =
  NativeWorkspaceSource<DesktopNativeCoreGalaxyAccountWorkspaceProjectionResult>;

const EMPTY_AUTHORITY_FRAMES: NativeCampaignGalaxyWorkspaceAuthorityFrames = Object.freeze({
  displayFrame: null,
  readFrame: null,
});
const LOGICAL_ID_PATTERN = /^[A-Za-z0-9_.:-]+$/;
const DECIMAL_256_PATTERN = /^(?:0|[1-9][0-9]{0,255})$/;
const GALACTIC_EXPORT_ITEMS = new Map([
  ["universe_archive", "universe_matrix"],
  ["solar_sail_array", "solar_sail"],
  ["carrier_rocket_fleet", "small_carrier_rocket"],
  ["antimatter_exchange", "antimatter_fuel_rod"],
] as const);
const CHAPTER_BY_ID = new Map(CAMPAIGN_CHAPTERS.map((chapter) => [chapter.id, chapter]));
const TASK_BY_ID = new Map(CAMPAIGN_TASKS.map((task) => [task.id, task]));

function validDecimal256(value: unknown): value is string {
  return typeof value === "string" && DECIMAL_256_PATTERN.test(value);
}

function validLogicalId(value: string, maximumLength = 128): boolean {
  return value.length > 0 && value.length <= maximumLength && LOGICAL_ID_PATTERN.test(value);
}

function validIdentity(identity: NativeCampaignGalaxyWorkspaceIdentity): boolean {
  return validLogicalId(identity.sessionId) && validLogicalId(identity.runId) &&
    Number.isSafeInteger(identity.revision) && identity.revision >= 0 &&
    validLogicalId(identity.registryFingerprint, 256);
}

function sameScope(
  left: NativeCampaignGalaxyWorkspaceIdentity,
  right: NativeCampaignGalaxyWorkspaceIdentity,
): boolean {
  return left.sessionId === right.sessionId && left.runId === right.runId &&
    left.registryFingerprint === right.registryFingerprint;
}

function exactIdentity(
  left: NativeCampaignGalaxyWorkspaceIdentity,
  right: NativeCampaignGalaxyWorkspaceIdentity,
): boolean {
  return sameScope(left, right) && left.revision === right.revision;
}

function identityKey(identity: NativeCampaignGalaxyWorkspaceIdentity): string {
  return `${identity.sessionId}\u0000${identity.runId}\u0000${identity.revision}\u0000${identity.registryFingerprint}`;
}

function campaignCatalogMatches(
  projection: DesktopNativeCoreCampaignWorkspaceProjectionResult,
): boolean {
  if (projection.counts.chapters !== CAMPAIGN_CHAPTERS.length ||
      projection.counts.tasks !== CAMPAIGN_TASKS.length ||
      projection.chapters.length !== CAMPAIGN_CHAPTERS.length) return false;
  const taskIds = new Set<string>();
  for (const chapter of projection.chapters) {
    const definition = CHAPTER_BY_ID.get(chapter.id as never);
    if (!definition || chapter.totalCount !== definition.taskIds.length ||
        chapter.tasks.length !== definition.taskIds.length) return false;
    for (const task of chapter.tasks) {
      if (!definition.taskIds.includes(task.id as never) || !TASK_BY_ID.has(task.id as never) ||
          taskIds.has(task.id)) return false;
      taskIds.add(task.id);
    }
  }
  return taskIds.size === CAMPAIGN_TASKS.length;
}

function validCampaignProjection(
  projection: DesktopNativeCoreCampaignWorkspaceProjectionResult,
  identity: NativeCampaignGalaxyWorkspaceIdentity,
): boolean {
  return projection.schemaVersion === 1 && projection.projectionType === "campaign-workspace-v1" &&
    projection.source === "native-core" && projection.stateVersion === 47 &&
    projection.truncated === false && projection.sessionId === identity.sessionId &&
    projection.runId === identity.runId && projection.revision === identity.revision &&
    projection.registryFingerprint === identity.registryFingerprint &&
    projection.limits.chapters === 16 && projection.limits.tasks === 64 &&
    projection.limits.payloadBytes === 262_144 && campaignCatalogMatches(projection);
}

function validGalaxyProjection(
  projection: DesktopNativeCoreGalaxyAccountWorkspaceProjectionResult,
  identity: NativeCampaignGalaxyWorkspaceIdentity,
): boolean {
  const exports = projection.galacticExports;
  const exporters = exports?.exporters;
  const validProjects = Boolean(exports && Array.isArray(exports.projects) && exports.projects.length === 4 &&
    exports.projects.every((row) => Boolean(row && typeof row === "object")) &&
    new Set(exports.projects.map((row) => row.id)).size === 4 && exports.projects.every((row) =>
      GALACTIC_EXPORT_ITEMS.get(row.id) === row.itemId && typeof row.enabled === "boolean" &&
      [1, 2, 3].includes(row.priority) && [
        row.level, row.delivered, row.totalDelivered, row.dispatchProgress, row.target, row.reserve,
      ].every(validDecimal256)));
  const validExports = Boolean(exports && typeof exports.unlocked === "boolean" &&
    ["building", "legacy-network"].includes(exports.inputMode) &&
    typeof exports.autoDispatch === "boolean" && [0.25, 0.5, 1].includes(exports.dispatchThrottle) &&
    [exports.galacticCredits, exports.galacticScore, exports.totalExported, exports.exportedLastMinute]
      .every(validDecimal256) && exporters &&
    Number.isSafeInteger(exporters.total) && exporters.total >= 0 &&
    Number.isSafeInteger(exporters.paused) && exporters.paused >= 0 &&
    Number.isSafeInteger(exporters.running) && exporters.running >= 0 &&
    exporters.paused + exporters.running === exporters.total && validProjects);
  return projection.schemaVersion === 1 && projection.projectionType === "galaxy-account-workspace-v1" &&
    projection.source === "native-core" && projection.stateVersion === 47 &&
    projection.truncated === false && projection.sessionId === identity.sessionId &&
    projection.runId === identity.runId && projection.revision === identity.revision &&
    projection.registryFingerprint === identity.registryFingerprint &&
    projection.limits.payloadBytes === 65_536 && projection.limits.decimalDigits === 256 && validExports &&
    projection.cloudCompatibility.gameStateVersion === 47 &&
    projection.cloudCompatibility.envelopeVersion === 2 &&
    projection.cloudCompatibility.cloudSchemaVersion === 8 &&
    projection.cloudCompatibility.exportSupported === true &&
    projection.cloudCompatibility.restoreIntoActiveAuthority === false &&
    projection.cloudCompatibility.importIntoActiveAuthority === false &&
    projection.cloudCompatibility.overwriteActiveAuthority === false;
}

function cloneCampaignProjection(
  projection: DesktopNativeCoreCampaignWorkspaceProjectionResult,
): DesktopNativeCoreCampaignWorkspaceProjectionResult {
  const chapters = projection.chapters.map((chapter) => {
    const tasks = chapter.tasks.map((task) => ({
      ...task,
      progress: Object.freeze({ ...task.progress }),
      locator: task.locator ? Object.freeze({ ...task.locator }) : null,
    }));
    for (const task of tasks) Object.freeze(task);
    Object.freeze(tasks);
    return Object.freeze({ ...chapter, tasks });
  });
  Object.freeze(chapters);
  return Object.freeze({
    ...projection,
    limits: Object.freeze({ ...projection.limits }),
    counts: Object.freeze({ ...projection.counts }),
    chapters,
  });
}

function cloneGalaxyProjection(
  projection: DesktopNativeCoreGalaxyAccountWorkspaceProjectionResult,
): DesktopNativeCoreGalaxyAccountWorkspaceProjectionResult {
  const projects = projection.galacticExports.projects.map((row) => Object.freeze({ ...row }));
  Object.freeze(projects);
  return Object.freeze({
    ...projection,
    limits: Object.freeze({ ...projection.limits }),
    game: Object.freeze({ ...projection.game }),
    production: Object.freeze({ ...projection.production }),
    progress: Object.freeze({ ...projection.progress }),
    dyson: Object.freeze({ ...projection.dyson }),
    galacticExports: Object.freeze({
      ...projection.galacticExports,
      exporters: Object.freeze({ ...projection.galacticExports.exporters }),
      projects,
    }),
    cloudCompatibility: Object.freeze({ ...projection.cloudCompatibility }),
  });
}

/**
 * The authority clock publishes the successful tick revision before clearing
 * its operation marker. Preserve only the last confirmed frame through that
 * narrow active transient, and never start a broker read until it settles.
 * Terminal phases, scope changes and revision rollback fail closed.
 */
export function selectNativeCampaignGalaxyWorkspaceAuthorityFrames(
  snapshot: NativePlayerAuthorityClockSnapshot,
  sessionId: string | null,
): NativeCampaignGalaxyWorkspaceAuthorityFrames {
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

export function createNativePlayerAuthorityCampaignWorkspaceSource(
  bridge: Pick<DesktopBridge, "getNativeCoreCampaignWorkspaceProjection"> | null,
  identity: NativeCampaignGalaxyWorkspaceIdentity,
): NativeCampaignWorkspaceSource | null {
  const readProjection = bridge?.getNativeCoreCampaignWorkspaceProjection;
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
        });
        return validCampaignProjection(projection, boundIdentity) ? projection : null;
      } catch {
        return null;
      }
    },
  });
}

export function createNativePlayerAuthorityGalaxyWorkspaceSource(
  bridge: Pick<DesktopBridge, "getNativeCoreGalaxyAccountWorkspaceProjection"> | null,
  identity: NativeCampaignGalaxyWorkspaceIdentity,
): NativeGalaxyWorkspaceSource | null {
  const readProjection = bridge?.getNativeCoreGalaxyAccountWorkspaceProjection;
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
        });
        return validGalaxyProjection(projection, boundIdentity) ? projection : null;
      } catch {
        return null;
      }
    },
  });
}

function selectFrame<Frame extends NativeCampaignGalaxyWorkspaceIdentity>(
  snapshot: NativeWorkspaceSnapshot<Frame>,
  identity: NativeCampaignGalaxyWorkspaceIdentity,
): Frame | null {
  const frame = snapshot.frame;
  if (!frame || !sameScope(frame, identity) || frame.revision > identity.revision ||
      snapshot.requestedRevision !== null && identity.revision < snapshot.requestedRevision) return null;
  if (snapshot.status === "ready" && frame.revision === identity.revision) return frame;
  return snapshot.status === "ready" || snapshot.status === "loading" ||
    snapshot.status === "unavailable" ? frame : null;
}

export function selectNativeCampaignWorkspaceFrame(
  snapshot: NativeCampaignWorkspaceSnapshot,
  identity: NativeCampaignGalaxyWorkspaceIdentity,
): NativeCampaignWorkspaceFrame | null {
  return selectFrame(snapshot, identity);
}

export function selectNativeGalaxyWorkspaceFrame(
  snapshot: NativeGalaxyWorkspaceSnapshot,
  identity: NativeCampaignGalaxyWorkspaceIdentity,
): NativeGalaxyWorkspaceFrame | null {
  return selectFrame(snapshot, identity);
}

class NativeExactWorkspaceStore<Projection, Frame extends NativeCampaignGalaxyWorkspaceIdentity> {
  private snapshot: NativeWorkspaceSnapshot<Frame> = Object.freeze({
    status: "empty",
    requestedRevision: null,
    frame: null,
  });
  private token = 0;
  private currentKey: string | null = null;
  private flight: {
    readonly key: string;
    readonly promise: Promise<NativeCampaignGalaxyWorkspaceRefreshResult>;
  } | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly validProjection: (
      projection: Projection,
      identity: NativeCampaignGalaxyWorkspaceIdentity,
    ) => boolean,
    private readonly createFrame: (
      projection: Projection,
      identity: NativeCampaignGalaxyWorkspaceIdentity,
    ) => Frame,
  ) {}

  getSnapshot = (): NativeWorkspaceSnapshot<Frame> => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  close(): void {
    this.token += 1;
    this.currentKey = null;
    this.flight = null;
    if (this.snapshot.status === "empty" && this.snapshot.requestedRevision === null &&
        this.snapshot.frame === null) return;
    this.publish(Object.freeze({ status: "empty", requestedRevision: null, frame: null }));
  }

  refresh(
    source: NativeWorkspaceSource<Projection>,
    identity: NativeCampaignGalaxyWorkspaceIdentity,
  ): Promise<NativeCampaignGalaxyWorkspaceRefreshResult> {
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
      status: "loading",
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
    source: NativeWorkspaceSource<Projection>,
    identity: NativeCampaignGalaxyWorkspaceIdentity,
    key: string,
    token: number,
  ): Promise<NativeCampaignGalaxyWorkspaceRefreshResult> {
    const projection = await source.readVerifiedProjection();
    if (token !== this.token || key !== this.currentKey) return "superseded";
    if (!projection || !this.validProjection(projection, identity)) {
      this.publish(Object.freeze({
        status: "unavailable",
        requestedRevision: identity.revision,
        frame: this.snapshot.frame,
      }));
      return "unavailable";
    }
    const frame = this.createFrame(projection, identity);
    this.publish(Object.freeze({ status: "ready", requestedRevision: identity.revision, frame }));
    return "committed";
  }

  private publish(snapshot: NativeWorkspaceSnapshot<Frame>): void {
    if (this.snapshot === snapshot) return;
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }
}

export class NativeCampaignWorkspaceStore extends NativeExactWorkspaceStore<
  DesktopNativeCoreCampaignWorkspaceProjectionResult,
  NativeCampaignWorkspaceFrame
> {
  constructor() {
    super(validCampaignProjection, (projection, identity) => Object.freeze({
      source: "native-core",
      ...identity,
      projection: cloneCampaignProjection(projection),
    }));
  }
}

export class NativeGalaxyWorkspaceStore extends NativeExactWorkspaceStore<
  DesktopNativeCoreGalaxyAccountWorkspaceProjectionResult,
  NativeGalaxyWorkspaceFrame
> {
  constructor() {
    super(validGalaxyProjection, (projection, identity) => Object.freeze({
      source: "native-core",
      ...identity,
      projection: cloneGalaxyProjection(projection),
    }));
  }
}
