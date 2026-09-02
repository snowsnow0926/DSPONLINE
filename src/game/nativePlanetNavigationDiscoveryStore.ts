import type { DesktopNativeCoreFactoryReadModelResult } from "../desktop";
import {
  FACTORY_READ_MODEL_LIMITS,
  FACTORY_READ_MODEL_SCHEMA,
  type PlanetNavigationReadModel,
  type PlanetNavigationRowReadModel,
} from "./factoryReadModels";
import type { NativeFactoryThinViewSource } from "./nativeFactoryThinViewStore";

const LOGICAL_SESSION_ID = /^[A-Za-z0-9_.:-]+$/;
const MAX_SESSION_ID_BYTES = 128;
const MAX_OPAQUE_ID_BYTES = 160;
const MAX_DISPLAY_TEXT_BYTES = 2_048;
const textEncoder = new TextEncoder();

type FactoryNavigationSource = Pick<NativeFactoryThinViewSource, "readVerifiedFactoryReadModel">;

export interface NativePlanetNavigationDiscoveryBinding {
  readonly enabled: boolean;
  readonly sessionId: string | null;
  readonly expectedRevision: number;
}

/**
 * A deliberately small recovery atom. It contains no tray, inventory,
 * entities, belts, metrics, command source, or mutable native state.
 */
export interface NativePlanetNavigationDiscoveryFrame {
  readonly sessionId: string;
  readonly revision: number;
  readonly navigation: PlanetNavigationReadModel;
  readonly currentPlanetId: string;
}

export interface NativePlanetNavigationDiscoverySnapshot {
  readonly status: "empty" | "loading" | "ready" | "unsupported";
  readonly requestedSessionId: string | null;
  readonly requestedRevision: number | null;
  readonly frame: NativePlanetNavigationDiscoveryFrame | null;
}

export type NativePlanetNavigationDiscoveryRefreshResult =
  | { readonly status: "committed"; readonly frame: NativePlanetNavigationDiscoveryFrame }
  | { readonly status: "superseded" | "unsupported" };

const EMPTY_SNAPSHOT: NativePlanetNavigationDiscoverySnapshot = Object.freeze({
  status: "empty",
  requestedSessionId: null,
  requestedRevision: null,
  frame: null,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function validBoundedText(value: unknown, maximumBytes: number, allowEmpty = false): value is string {
  return typeof value === "string" && (allowEmpty || value.length > 0) &&
    !value.includes("\0") && hasWellFormedUnicode(value) &&
    textEncoder.encode(value).byteLength <= maximumBytes;
}

function validOpaqueId(value: unknown): value is string {
  return validBoundedText(value, MAX_OPAQUE_ID_BYTES);
}

function validSessionId(value: unknown): value is string {
  return validBoundedText(value, MAX_SESSION_ID_BYTES) && LOGICAL_SESSION_ID.test(value);
}

function validCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function validBinding(
  binding: NativePlanetNavigationDiscoveryBinding,
): binding is NativePlanetNavigationDiscoveryBinding & { readonly sessionId: string } {
  return binding?.enabled === true && validSessionId(binding.sessionId) &&
    Number.isSafeInteger(binding.expectedRevision) && binding.expectedRevision >= 0;
}

function normalizePlanetRow(value: unknown): PlanetNavigationRowReadModel | null {
  if (!isRecord(value) || !validOpaqueId(value.planetId) ||
    value.systemId !== null && !validOpaqueId(value.systemId) ||
    !validBoundedText(value.displayName, MAX_DISPLAY_TEXT_BYTES) ||
    !validBoundedText(value.code, MAX_DISPLAY_TEXT_BYTES) ||
    typeof value.active !== "boolean" || typeof value.discovered !== "boolean" ||
    typeof value.colonized !== "boolean" ||
    value.role !== null && !validOpaqueId(value.role) ||
    !validCount(value.entityCount) || !validCount(value.deviceCount) ||
    !validCount(value.beltCount) || !validCount(value.constructionQueueCount) ||
    typeof value.powerFactor !== "number" || !Number.isFinite(value.powerFactor) ||
    value.powerFactor < 0) return null;

  return Object.freeze({
    planetId: value.planetId,
    systemId: value.systemId,
    displayName: value.displayName,
    code: value.code,
    active: value.active,
    discovered: value.discovered,
    colonized: value.colonized,
    role: value.role,
    entityCount: value.entityCount,
    deviceCount: value.deviceCount,
    beltCount: value.beltCount,
    constructionQueueCount: value.constructionQueueCount,
    powerFactor: value.powerFactor,
  });
}

function normalizeNavigation(
  rawFactory: unknown,
  binding: NativePlanetNavigationDiscoveryBinding & { readonly sessionId: string },
): NativePlanetNavigationDiscoveryFrame | null {
  if (!isRecord(rawFactory) || rawFactory.schemaVersion !== 1 ||
    rawFactory.projectionType !== "factory-read-model-v1" ||
    rawFactory.revision !== binding.expectedRevision ||
    !isRecord(rawFactory.shell) || rawFactory.shell.schema !== FACTORY_READ_MODEL_SCHEMA ||
    rawFactory.shell.source !== "native-core" || !validOpaqueId(rawFactory.shell.activePlanetId) ||
    !isRecord(rawFactory.planetNavigation) ||
    rawFactory.planetNavigation.schema !== FACTORY_READ_MODEL_SCHEMA ||
    !validOpaqueId(rawFactory.planetNavigation.activePlanetId) ||
    rawFactory.shell.activePlanetId !== rawFactory.planetNavigation.activePlanetId ||
    !isRecord(rawFactory.planetNavigation.planets) ||
    !Array.isArray(rawFactory.planetNavigation.planets.rows) ||
    rawFactory.planetNavigation.planets.truncated !== false ||
    !validCount(rawFactory.planetNavigation.planets.totalCount) ||
    rawFactory.planetNavigation.planets.totalCount !== rawFactory.planetNavigation.planets.rows.length ||
    rawFactory.planetNavigation.planets.rows.length > FACTORY_READ_MODEL_LIMITS.planetRows) return null;

  const rows: PlanetNavigationRowReadModel[] = [];
  const planetIds = new Set<string>();
  let activeRows = 0;
  for (const rawRow of rawFactory.planetNavigation.planets.rows) {
    const row = normalizePlanetRow(rawRow);
    if (!row || planetIds.has(row.planetId)) return null;
    planetIds.add(row.planetId);
    if (row.active) {
      activeRows += 1;
      if (row.planetId !== rawFactory.planetNavigation.activePlanetId) return null;
    }
    rows.push(row);
  }
  if (activeRows !== 1 || !planetIds.has(rawFactory.planetNavigation.activePlanetId)) return null;

  const navigation: PlanetNavigationReadModel = Object.freeze({
    schema: FACTORY_READ_MODEL_SCHEMA,
    activePlanetId: rawFactory.planetNavigation.activePlanetId,
    planets: Object.freeze({
      rows: Object.freeze(rows),
      totalCount: rows.length,
      truncated: false,
    }),
  });
  return Object.freeze({
    sessionId: binding.sessionId,
    revision: binding.expectedRevision,
    navigation,
    currentPlanetId: navigation.activePlanetId,
  });
}

/**
 * Latest-request-wins store for recovering the active native planet without a
 * viewport hint. The source is read-only and already session-bound by the
 * player-authority projection adapter; this store never imports a command API.
 */
export class NativePlanetNavigationDiscoveryStore {
  private snapshot: NativePlanetNavigationDiscoverySnapshot = EMPTY_SNAPSHOT;
  private requestToken = 0;
  private readonly listeners = new Set<() => void>();

  getSnapshot = (): NativePlanetNavigationDiscoverySnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  clear(): void {
    this.requestToken += 1;
    this.publish(EMPTY_SNAPSHOT);
  }

  async refresh(
    source: FactoryNavigationSource | null,
    binding: NativePlanetNavigationDiscoveryBinding,
  ): Promise<NativePlanetNavigationDiscoveryRefreshResult> {
    const token = ++this.requestToken;
    if (!validBinding(binding) || !source ||
      typeof source.readVerifiedFactoryReadModel !== "function") {
      this.publish(Object.freeze({
        status: "unsupported",
        requestedSessionId: null,
        requestedRevision: null,
        frame: null,
      }));
      return { status: "unsupported" };
    }

    this.publish(Object.freeze({
      status: "loading",
      requestedSessionId: binding.sessionId,
      requestedRevision: binding.expectedRevision,
      frame: null,
    }));

    let rawFactory: DesktopNativeCoreFactoryReadModelResult | null = null;
    try {
      rawFactory = await source.readVerifiedFactoryReadModel({
        selectedEntityIds: [],
        selectedBeltIds: [],
      }, binding.expectedRevision);
    } catch {
      rawFactory = null;
    }

    if (token !== this.requestToken) return { status: "superseded" };
    const frame = normalizeNavigation(rawFactory, binding);
    if (!frame) {
      this.publish(Object.freeze({
        status: "unsupported",
        requestedSessionId: binding.sessionId,
        requestedRevision: binding.expectedRevision,
        frame: null,
      }));
      return { status: "unsupported" };
    }

    this.publish(Object.freeze({
      status: "ready",
      requestedSessionId: binding.sessionId,
      requestedRevision: binding.expectedRevision,
      frame,
    }));
    return { status: "committed", frame };
  }

  private publish(next: NativePlanetNavigationDiscoverySnapshot): void {
    if (this.snapshot === next) return;
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
}
