import type {
  DesktopBridge,
  DesktopNativeCoreDysonFrameRow,
  DesktopNativeCoreDysonLayerRow,
  DesktopNativeCoreDysonNodeRow,
  DesktopNativeCoreDysonOrbitRow,
  DesktopNativeCoreDysonShellRow,
  DesktopNativeCoreDysonSystemRow,
  DesktopNativeCoreDysonWorkspaceProjectionRequest,
  DesktopNativeCoreDysonWorkspaceProjectionResult,
} from "../desktop";

// Dyson rows can contain several opaque 1 KiB MOD identifiers. Eight rows
// leave ample headroom under the fixed 1 MiB host/renderer transfer budget.
export const NATIVE_DYSON_WORKSPACE_PAGE_ROWS = 8 as const;
export const NATIVE_DYSON_WORKSPACE_MAX_ROWS = 65_536 as const;
export const NATIVE_DYSON_WORKSPACE_MAX_PAGES = 8_192 as const;

type PageRequest = Omit<
  DesktopNativeCoreDysonWorkspaceProjectionRequest,
  "sessionId" | "expectedRevision" | "expectedRegistryFingerprint" | "selectedSystemId"
>;

export interface NativeDysonWorkspaceIdentity {
  readonly sessionId: string;
  readonly revision: number;
  readonly registryFingerprint: string;
  readonly selectedSystemId: string;
}

export interface NativeDysonWorkspaceSource {
  readonly mode: "player-authority";
  readonly boundIdentity: NativeDysonWorkspaceIdentity;
  readVerifiedDysonWorkspaceProjection(
    request: PageRequest,
    expectedRevision: number,
  ): Promise<DesktopNativeCoreDysonWorkspaceProjectionResult | null>;
}

export interface NativeDysonWorkspaceFrame extends NativeDysonWorkspaceIdentity {
  readonly source: "native-core";
  readonly sourceMode: "player-authority";
  readonly projection: DesktopNativeCoreDysonWorkspaceProjectionResult;
  readonly systems: readonly DesktopNativeCoreDysonSystemRow[];
  readonly layers: readonly DesktopNativeCoreDysonLayerRow[];
  readonly orbits: readonly DesktopNativeCoreDysonOrbitRow[];
  readonly nodes: readonly DesktopNativeCoreDysonNodeRow[];
  readonly frames: readonly DesktopNativeCoreDysonFrameRow[];
  readonly shells: readonly DesktopNativeCoreDysonShellRow[];
  readonly systemsById: ReadonlyMap<string, DesktopNativeCoreDysonSystemRow>;
  readonly layersById: ReadonlyMap<string, DesktopNativeCoreDysonLayerRow>;
  readonly orbitsById: ReadonlyMap<string, DesktopNativeCoreDysonOrbitRow>;
  readonly nodesByLayerId: ReadonlyMap<string, readonly DesktopNativeCoreDysonNodeRow[]>;
  readonly framesByLayerId: ReadonlyMap<string, readonly DesktopNativeCoreDysonFrameRow[]>;
  readonly shellsByLayerId: ReadonlyMap<string, readonly DesktopNativeCoreDysonShellRow[]>;
}

export interface NativeDysonWorkspaceSnapshot {
  readonly status: "empty" | "loading" | "ready" | "unavailable";
  readonly requestedRevision: number | null;
  readonly frame: NativeDysonWorkspaceFrame | null;
}

export type NativeDysonWorkspaceRefreshResult = "committed" | "superseded" | "unavailable";

const LOGICAL_ID = /^[A-Za-z0-9_.:-]+$/;
const EMPTY_SNAPSHOT: NativeDysonWorkspaceSnapshot = Object.freeze({
  status: "empty",
  requestedRevision: null,
  frame: null,
});

function validOpaqueId(value: string, maximumBytes = 1_024): boolean {
  return value.length > 0 && new TextEncoder().encode(value).byteLength <= maximumBytes &&
    !/[\u0000-\u001f\u007f-\u009f]/u.test(value) &&
    !Array.from(value).some((character) => {
      const unit = character.charCodeAt(0);
      return character.length === 1 && unit >= 0xd800 && unit <= 0xdfff;
    });
}

function validIdentity(identity: NativeDysonWorkspaceIdentity): boolean {
  return identity.sessionId.length > 0 && identity.sessionId.length <= 128 &&
    LOGICAL_ID.test(identity.sessionId) && Number.isSafeInteger(identity.revision) &&
    identity.revision >= 0 && identity.registryFingerprint.length > 0 &&
    identity.registryFingerprint.length <= 256 && LOGICAL_ID.test(identity.registryFingerprint) &&
    validOpaqueId(identity.selectedSystemId);
}

function identityKey(identity: NativeDysonWorkspaceIdentity): string {
  return `${identity.sessionId}\u0000${identity.revision}\u0000${identity.registryFingerprint}\u0000${identity.selectedSystemId}`;
}

function exactIdentity(left: NativeDysonWorkspaceIdentity, right: NativeDysonWorkspaceIdentity): boolean {
  return left.sessionId === right.sessionId && left.revision === right.revision &&
    left.registryFingerprint === right.registryFingerprint &&
    left.selectedSystemId === right.selectedSystemId;
}

const PAGE_FIELDS = ["system", "layer", "orbit", "node", "frame", "shell"] as const;

function validPageRequest(request: PageRequest): boolean {
  return PAGE_FIELDS.every((field) => {
    const cursor = request[`${field}Cursor`];
    const limit = request[`${field}Limit`];
    return Number.isSafeInteger(cursor) && cursor >= 0 && cursor <= 0xffff_ffff &&
      Number.isSafeInteger(limit) && limit >= 1 && limit <= 64;
  });
}

function exactProjectionRequest(
  projection: DesktopNativeCoreDysonWorkspaceProjectionResult,
  identity: NativeDysonWorkspaceIdentity,
  request: PageRequest,
): boolean {
  return projection.schemaVersion === 1 && projection.projectionType === "dyson-workspace-v1" &&
    projection.stateVersion === 47 && projection.revision === identity.revision &&
    projection.registryFingerprint === identity.registryFingerprint &&
    projection.selectedSystemId === identity.selectedSystemId &&
    projection.request.expectedRevision === identity.revision &&
    projection.request.expectedRegistryFingerprint === identity.registryFingerprint &&
    projection.request.selectedSystemId === identity.selectedSystemId &&
    PAGE_FIELDS.every((field) => projection.request[`${field}Cursor`] === request[`${field}Cursor`] &&
      projection.request[`${field}Limit`] === request[`${field}Limit`] &&
      projection[`${field}s`].cursor === request[`${field}Cursor`] &&
      projection[`${field}s`].limit === request[`${field}Limit`]);
}

function sameHeader(
  left: DesktopNativeCoreDysonWorkspaceProjectionResult,
  right: DesktopNativeCoreDysonWorkspaceProjectionResult,
): boolean {
  return left.revision === right.revision && left.registryFingerprint === right.registryFingerprint &&
    left.activePlanetId === right.activePlanetId && left.activeSystemId === right.activeSystemId &&
    left.selectedSystemId === right.selectedSystemId &&
    JSON.stringify(left.limits) === JSON.stringify(right.limits) &&
    JSON.stringify(left.technology) === JSON.stringify(right.technology) &&
    JSON.stringify(left.global) === JSON.stringify(right.global) &&
    JSON.stringify(left.summary) === JSON.stringify(right.summary) &&
    JSON.stringify(left.selectedSystem) === JSON.stringify(right.selectedSystem);
}

function groupedRows<T extends { layerId: string }>(rows: readonly T[]): Map<string, readonly T[]> {
  const mutable = new Map<string, T[]>();
  for (const row of rows) {
    const entries = mutable.get(row.layerId) ?? [];
    entries.push(row);
    mutable.set(row.layerId, entries);
  }
  return new Map([...mutable].map(([layerId, entries]) => [layerId, Object.freeze([...entries])]));
}

function completeFrame(
  identity: NativeDysonWorkspaceIdentity,
  first: DesktopNativeCoreDysonWorkspaceProjectionResult,
  systems: DesktopNativeCoreDysonSystemRow[],
  layers: DesktopNativeCoreDysonLayerRow[],
  orbits: DesktopNativeCoreDysonOrbitRow[],
  nodes: DesktopNativeCoreDysonNodeRow[],
  frames: DesktopNativeCoreDysonFrameRow[],
  shells: DesktopNativeCoreDysonShellRow[],
): NativeDysonWorkspaceFrame | null {
  if ([systems, layers, orbits, nodes, frames, shells].some((rows) => rows.length > NATIVE_DYSON_WORKSPACE_MAX_ROWS) ||
      systems.length !== first.summary.systemCount || layers.length !== first.selectedSystem.totals.layerCount ||
      orbits.length !== first.selectedSystem.orbitCount || nodes.length !== first.selectedSystem.totals.nodeCount ||
      frames.length !== first.selectedSystem.totals.frameCount || shells.length !== first.selectedSystem.totals.shellCount) {
    return null;
  }
  const systemsById = new Map<string, DesktopNativeCoreDysonSystemRow>();
  let activeSystems = 0;
  let unlockedSystems = 0;
  for (const system of systems) {
    if (systemsById.has(system.systemId)) return null;
    systemsById.set(system.systemId, system);
    if (system.active) {
      activeSystems += 1;
      if (system.systemId !== first.activeSystemId) return null;
    }
    if (system.unlocked) unlockedSystems += 1;
  }
  const selected = systemsById.get(identity.selectedSystemId);
  if (activeSystems !== 1 || unlockedSystems !== first.summary.unlockedSystemCount || !selected ||
      JSON.stringify(selected) !== JSON.stringify(first.selectedSystem)) return null;

  const layersById = new Map<string, DesktopNativeCoreDysonLayerRow>();
  for (const layer of layers) {
    if (layersById.has(layer.layerId)) return null;
    layersById.set(layer.layerId, layer);
  }
  if (selected.activeLayerId !== null && !layersById.has(selected.activeLayerId)) return null;
  const orbitsById = new Map<string, DesktopNativeCoreDysonOrbitRow>();
  let orbitSails = 0;
  for (const orbit of orbits) {
    if (orbitsById.has(orbit.orbitId)) return null;
    orbitsById.set(orbit.orbitId, orbit);
    orbitSails += orbit.sailsInOrbit;
  }
  if (selected.activeOrbitId !== null && !orbitsById.has(selected.activeOrbitId) ||
      orbitSails !== selected.orbitSails) return null;

  const nodesByLayerId = groupedRows(nodes);
  const framesByLayerId = groupedRows(frames);
  const shellsByLayerId = groupedRows(shells);
  for (const row of [...nodes, ...frames, ...shells]) if (!layersById.has(row.layerId)) return null;
  for (const layer of layers) {
    const layerNodes = nodesByLayerId.get(layer.layerId) ?? [];
    const layerFrames = framesByLayerId.get(layer.layerId) ?? [];
    const layerShells = shellsByLayerId.get(layer.layerId) ?? [];
    if (layerNodes.length !== layer.nodeCount || layerFrames.length !== layer.frameCount ||
        layerShells.length !== layer.shellCount) return null;
    const nodeIds = new Set(layerNodes.map((node) => node.nodeId));
    const frameIds = new Set<string>();
    for (const frame of layerFrames) {
      if (frameIds.has(frame.frameId) || !nodeIds.has(frame.sourceNodeId) ||
          !nodeIds.has(frame.targetNodeId)) return null;
      frameIds.add(frame.frameId);
    }
    const shellIds = new Set<string>();
    for (const shell of layerShells) {
      if (shellIds.has(shell.shellId) || !nodeIds.has(shell.sourceNodeId) ||
          !nodeIds.has(shell.targetNodeId)) return null;
      shellIds.add(shell.shellId);
    }
  }
  const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);
  const derivedCapacity = layers.length === 0
    ? selected.structurePoints * 40
    : sum(layers.map((layer) => layer.sailCapacity));
  if (sum(layers.map((layer) => layer.plannedStructurePoints)) !== selected.totals.plannedStructurePoints ||
      sum(layers.map((layer) => layer.completedStructurePoints)) !== selected.totals.completedStructurePoints ||
      derivedCapacity !== selected.totals.sailCapacity ||
      selected.totals.absorbedSails !== selected.shellSails ||
      sum(systems.map((system) => system.structurePoints)) !== first.global.sphere.structurePoints ||
      sum(systems.map((system) => system.shellSails)) !== first.global.sphere.shellSails ||
      sum(systems.map((system) => system.totals.layerCount)) !== first.summary.layerCount ||
      sum(systems.map((system) => system.totals.nodeCount)) !== first.summary.nodeCount ||
      sum(systems.map((system) => system.totals.frameCount)) !== first.summary.frameCount ||
      sum(systems.map((system) => system.totals.shellCount)) !== first.summary.shellCount ||
      sum(systems.map((system) => system.orbitCount)) !== first.summary.orbitCount) return null;

  return Object.freeze({
    source: "native-core" as const,
    sourceMode: "player-authority" as const,
    ...identity,
    projection: first,
    systems: Object.freeze([...systems]),
    layers: Object.freeze([...layers]),
    orbits: Object.freeze([...orbits]),
    nodes: Object.freeze([...nodes]),
    frames: Object.freeze([...frames]),
    shells: Object.freeze([...shells]),
    systemsById,
    layersById,
    orbitsById,
    nodesByLayerId,
    framesByLayerId,
    shellsByLayerId,
  });
}

export function createNativePlayerAuthorityDysonWorkspaceSource(
  bridge: Pick<DesktopBridge, "getNativeCoreDysonWorkspaceProjection"> | null,
  identity: NativeDysonWorkspaceIdentity,
): NativeDysonWorkspaceSource | null {
  const reader = bridge?.getNativeCoreDysonWorkspaceProjection;
  if (typeof reader !== "function" || !validIdentity(identity)) return null;
  const boundIdentity = Object.freeze({ ...identity });
  return Object.freeze({
    mode: "player-authority" as const,
    boundIdentity,
    async readVerifiedDysonWorkspaceProjection(request: PageRequest, expectedRevision: number) {
      if (expectedRevision !== boundIdentity.revision || !validPageRequest(request)) return null;
      try {
        const projection = await reader({
          sessionId: boundIdentity.sessionId,
          expectedRevision,
          expectedRegistryFingerprint: boundIdentity.registryFingerprint,
          selectedSystemId: boundIdentity.selectedSystemId,
          ...request,
        });
        return exactProjectionRequest(projection, boundIdentity, request) ? projection : null;
      } catch {
        return null;
      }
    },
  });
}

export function selectNativeDysonWorkspaceFrame(
  snapshot: NativeDysonWorkspaceSnapshot,
  identity: NativeDysonWorkspaceIdentity,
): NativeDysonWorkspaceFrame | null {
  return snapshot.status === "ready" && snapshot.frame && exactIdentity(snapshot.frame, identity)
    ? snapshot.frame
    : null;
}

export class NativeDysonWorkspaceStore {
  private snapshot: NativeDysonWorkspaceSnapshot = EMPTY_SNAPSHOT;
  private token = 0;
  private currentIdentityKey: string | null = null;
  private flight: { key: string; promise: Promise<NativeDysonWorkspaceRefreshResult> } | null = null;
  private readonly listeners = new Set<() => void>();

  getSnapshot = (): NativeDysonWorkspaceSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  clear(): void {
    this.token += 1;
    this.currentIdentityKey = null;
    this.flight = null;
    this.publish(EMPTY_SNAPSHOT);
  }

  refresh(
    source: NativeDysonWorkspaceSource,
    identity: NativeDysonWorkspaceIdentity,
  ): Promise<NativeDysonWorkspaceRefreshResult> {
    if (!validIdentity(identity) || !exactIdentity(source.boundIdentity, identity)) {
      this.invalidate();
      return Promise.resolve("unavailable");
    }
    const key = identityKey(identity);
    if (this.currentIdentityKey !== key) {
      this.token += 1;
      this.flight = null;
      this.currentIdentityKey = key;
      this.publish(EMPTY_SNAPSHOT);
    }
    if (this.flight?.key === key) return this.flight.promise;
    if (this.snapshot.status === "ready" && this.snapshot.frame &&
        exactIdentity(this.snapshot.frame, identity)) return Promise.resolve("committed");
    const token = ++this.token;
    const previous = this.snapshot.frame;
    this.publish(Object.freeze({ status: "loading", requestedRevision: identity.revision, frame: previous }));
    const promise = this.performRefresh(source, identity, token, previous);
    this.flight = { key, promise };
    void promise.finally(() => {
      if (this.flight?.promise === promise) this.flight = null;
    });
    return promise;
  }

  private async performRefresh(
    source: NativeDysonWorkspaceSource,
    identity: NativeDysonWorkspaceIdentity,
    token: number,
    previous: NativeDysonWorkspaceFrame | null,
  ): Promise<NativeDysonWorkspaceRefreshResult> {
    const cursors: Record<(typeof PAGE_FIELDS)[number], number> = {
      system: 0, layer: 0, orbit: 0, node: 0, frame: 0, shell: 0,
    };
    let first: DesktopNativeCoreDysonWorkspaceProjectionResult | null = null;
    const systems: DesktopNativeCoreDysonSystemRow[] = [];
    const layers: DesktopNativeCoreDysonLayerRow[] = [];
    const orbits: DesktopNativeCoreDysonOrbitRow[] = [];
    const nodes: DesktopNativeCoreDysonNodeRow[] = [];
    const frames: DesktopNativeCoreDysonFrameRow[] = [];
    const shells: DesktopNativeCoreDysonShellRow[] = [];
    const accumulators = { systems, layers, orbits, nodes, frames, shells };
    for (let pageIndex = 0; pageIndex < NATIVE_DYSON_WORKSPACE_MAX_PAGES; pageIndex += 1) {
      const request = Object.fromEntries(PAGE_FIELDS.flatMap((field) => [
        [`${field}Cursor`, cursors[field]],
        [`${field}Limit`, NATIVE_DYSON_WORKSPACE_PAGE_ROWS],
      ])) as unknown as PageRequest;
      const projection = await source.readVerifiedDysonWorkspaceProjection(request, identity.revision);
      if (token !== this.token) return "superseded";
      if (!projection || !exactProjectionRequest(projection, identity, request) ||
          first && !sameHeader(first, projection)) return this.fail(identity, token, previous);
      first ??= projection;
      for (const field of PAGE_FIELDS) {
        accumulators[`${field}s`].push(...projection[`${field}s`].rows as never[]);
        if (accumulators[`${field}s`].length > NATIVE_DYSON_WORKSPACE_MAX_ROWS) {
          return this.fail(identity, token, previous);
        }
      }
      if (PAGE_FIELDS.every((field) => projection[`${field}s`].nextCursor === null)) {
        const frame = completeFrame(identity, first, systems, layers, orbits, nodes, frames, shells);
        if (!frame) return this.fail(identity, token, previous);
        if (token !== this.token) return "superseded";
        this.publish(Object.freeze({ status: "ready", requestedRevision: identity.revision, frame }));
        return "committed";
      }
      let advanced = false;
      for (const field of PAGE_FIELDS) {
        const page = projection[`${field}s`];
        const next = page.nextCursor ?? page.totalCount;
        advanced ||= next !== cursors[field];
        cursors[field] = next;
      }
      if (!advanced) return this.fail(identity, token, previous);
    }
    return this.fail(identity, token, previous);
  }

  private fail(
    identity: NativeDysonWorkspaceIdentity,
    token: number,
    previous: NativeDysonWorkspaceFrame | null,
  ): NativeDysonWorkspaceRefreshResult {
    if (token !== this.token) return "superseded";
    this.publish(Object.freeze({ status: "unavailable", requestedRevision: identity.revision, frame: previous }));
    return "unavailable";
  }

  private invalidate(): void {
    this.token += 1;
    this.flight = null;
    this.currentIdentityKey = null;
    this.publish(EMPTY_SNAPSHOT);
  }

  private publish(snapshot: NativeDysonWorkspaceSnapshot): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }
}
