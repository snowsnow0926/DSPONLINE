import type { CanvasViewport } from "./types";
import type { NativeFactoryProjectionIdentity } from "./factoryReadModels";
import type { NativeFactoryThinViewSnapshot } from "./nativeFactoryThinViewStore";
import {
  SIMULATION_RUNTIME_PROTOCOL_VERSION,
  type SimulationCommandPatch,
  type SimulationValuePatch,
} from "./simulationRuntimeProtocol";

export const PLANET_VIEWPORT_NATIVE_BASE_FIELDS = Object.freeze(["planetViewports"] as const);

export interface NativePlanetViewportReadModel {
  readonly schema: "planet-viewport-read-model-v1";
  readonly source: "native-core";
  readonly identity: NativeFactoryProjectionIdentity;
  readonly viewports: ReadonlyMap<string, CanvasViewport>;
}

export interface NativePlanetViewportBinding {
  readonly enabled: boolean;
  readonly sessionId: string | null;
  readonly runId: string | null;
  readonly expectedRevision: number;
  readonly activePlanetId: string;
}

const TEXT_ENCODER = new TextEncoder();

function validLogicalId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_.:-]+$/.test(value) &&
    TEXT_ENCODER.encode(value).byteLength <= 256;
}

function validOpaqueId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 &&
    TEXT_ENCODER.encode(value).byteLength <= 512 &&
    !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
}

function exactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function validViewport(value: unknown): value is CanvasViewport {
  if (!exactObject(value, ["x", "y", "zoom"])) return false;
  return typeof value.x === "number" && Number.isFinite(value.x) &&
    typeof value.y === "number" && Number.isFinite(value.y) &&
    typeof value.zoom === "number" && Number.isFinite(value.zoom) &&
    value.zoom >= 0.25 && value.zoom <= 1.8;
}

/** Selects the bounded persisted camera directory from the same viewport atom. */
export function selectNativePlanetViewportReadModel(
  snapshot: NativeFactoryThinViewSnapshot,
  binding: NativePlanetViewportBinding,
): NativePlanetViewportReadModel | null {
  if (!binding.enabled || !validLogicalId(binding.sessionId) || !validLogicalId(binding.runId) ||
      !validOpaqueId(binding.activePlanetId) || !Number.isSafeInteger(binding.expectedRevision) ||
      binding.expectedRevision < 0 || snapshot.status !== "ready" ||
      snapshot.requestedRevision !== binding.expectedRevision) return null;
  const frame = snapshot.frame;
  const viewport = frame?.viewport;
  if (!frame || frame.authoritySessionId !== binding.sessionId ||
      frame.authorityRunId !== binding.runId || frame.revision !== binding.expectedRevision ||
      frame.planetId !== binding.activePlanetId || !viewport ||
      viewport.schemaVersion !== 2 || viewport.projectionType !== "viewport-v2" ||
      viewport.revision !== binding.expectedRevision || viewport.planetId !== binding.activePlanetId) return null;
  const directory = viewport.base.planetViewports;
  if (!directory || typeof directory !== "object" || Array.isArray(directory)) return null;
  const rows = Object.entries(directory);
  if (rows.length < 1 || rows.length > 256) return null;
  const viewports = new Map<string, CanvasViewport>();
  for (const [planetId, value] of rows) {
    if (!validOpaqueId(planetId) || !validViewport(value) || viewports.has(planetId)) return null;
    viewports.set(planetId, Object.freeze({ x: value.x, y: value.y, zoom: value.zoom }));
  }
  if (!viewports.has(binding.activePlanetId)) return null;
  return Object.freeze({
    schema: "planet-viewport-read-model-v1",
    source: "native-core",
    identity: Object.freeze({
      sessionId: binding.sessionId,
      runId: binding.runId,
      revision: binding.expectedRevision,
      planetId: binding.activePlanetId,
    }),
    viewports,
  });
}

export function createNativeProjectedPlanetViewportCommand(
  model: NativePlanetViewportReadModel,
  planetId: string,
  target: CanvasViewport,
): SimulationCommandPatch | null {
  if (model.schema !== "planet-viewport-read-model-v1" || model.source !== "native-core" ||
      !validLogicalId(model.identity.sessionId) || !validLogicalId(model.identity.runId) ||
      !Number.isSafeInteger(model.identity.revision) || model.identity.revision < 0 ||
      !validOpaqueId(model.identity.planetId) || !validOpaqueId(planetId) ||
      !validViewport(target)) {
    throw new TypeError("原生行星视角投影或目标无效");
  }
  const current = model.viewports.get(planetId);
  if (!current || !validViewport(current)) throw new TypeError("原生行星视角目标不在完整目录中");
  const changes: SimulationValuePatch[] = [];
  if (!Object.is(target.x, current.x)) changes.push({
    path: ["planetViewports", planetId, "x"], operation: "set", value: target.x,
  });
  if (!Object.is(target.y, current.y)) changes.push({
    path: ["planetViewports", planetId, "y"], operation: "set", value: target.y,
  });
  if (!Object.is(target.zoom, current.zoom)) changes.push({
    path: ["planetViewports", planetId, "zoom"], operation: "set", value: target.zoom,
  });
  if (changes.length === 0) return null;
  return {
    protocolVersion: SIMULATION_RUNTIME_PROTOCOL_VERSION,
    baseRevision: model.identity.revision,
    topLevelChanges: changes,
    changedEntities: [],
    addedEntities: [],
    removedEntityIds: [],
    changedBelts: [],
    addedBelts: [],
    removedBeltIds: [],
  };
}
