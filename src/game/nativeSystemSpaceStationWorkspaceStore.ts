export const NATIVE_SYSTEM_SPACE_STATION_PAGE_ROWS = 64 as const;
export const NATIVE_SYSTEM_SPACE_STATION_MAX_TOTAL_ROWS = 65_536 as const;

export interface NativeSystemSpaceStationWorkspaceIdentity {
  readonly sessionId: string;
  readonly runId: string;
  readonly revision: number;
  readonly registryFingerprint: string;
  readonly systemId: string;
}

export interface NativeSystemSpaceStationWorkspaceSelector {
  readonly requirementCursor: number;
  readonly requirementLimit: number;
  readonly inventoryCursor: number;
  readonly inventoryLimit: number;
  readonly trayCursor: number;
  readonly trayLimit: number;
  readonly stationCursor: number;
  readonly stationLimit: number;
}

export const DEFAULT_NATIVE_SYSTEM_SPACE_STATION_SELECTOR: NativeSystemSpaceStationWorkspaceSelector = Object.freeze({
  requirementCursor: 0,
  requirementLimit: NATIVE_SYSTEM_SPACE_STATION_PAGE_ROWS,
  inventoryCursor: 0,
  inventoryLimit: NATIVE_SYSTEM_SPACE_STATION_PAGE_ROWS,
  trayCursor: 0,
  trayLimit: NATIVE_SYSTEM_SPACE_STATION_PAGE_ROWS,
  stationCursor: 0,
  stationLimit: NATIVE_SYSTEM_SPACE_STATION_PAGE_ROWS,
});

export interface NativeSystemSpaceStationWorkspaceProjectionRequest extends NativeSystemSpaceStationWorkspaceSelector {
  readonly sessionId: string;
  readonly runId: string;
  readonly expectedRevision: number;
  readonly expectedRegistryFingerprint: string;
  readonly systemId: string;
}

export interface NativeSystemSpaceStationPage<Row> {
  readonly cursor: number;
  readonly limit: number;
  readonly totalCount: number;
  readonly nextCursor: number | null;
  readonly rows: readonly Row[];
}

export interface NativeSystemSpaceStationRequirementRow {
  readonly requirementIndex: number;
  readonly phaseName: string;
  readonly itemId: string;
  readonly itemName: string;
  readonly itemNameTruncated: boolean;
  readonly baseAmount: number;
  readonly requiredAmount: string;
  readonly deliveredAmount: string;
  readonly constructionBufferAmount: string;
  readonly complete: boolean;
  readonly current: boolean;
}

export interface NativeSystemSpaceStationInventoryPolicy {
  readonly interstellarEnabled: boolean;
  readonly reserve: string;
  readonly target: string;
}

export interface NativeSystemSpaceStationInventoryRow {
  readonly itemId: string;
  readonly itemName: string;
  readonly itemNameTruncated: boolean;
  readonly amount: string;
  readonly policy: NativeSystemSpaceStationInventoryPolicy | null;
}

export interface NativeSystemSpaceStationTrayRow {
  readonly planetId: string;
  readonly planetName: string;
  readonly planetNameTruncated: boolean;
  readonly activePlanet: boolean;
  readonly itemId: string;
  readonly itemName: string;
  readonly itemNameTruncated: boolean;
  readonly amount: number;
  readonly constructionMaterial: boolean;
}

export interface NativeSystemSpaceStationOutputTarget {
  readonly portIndex: number;
  readonly itemId: string | null;
  readonly itemName: string;
  readonly itemNameTruncated: boolean;
}

export interface NativeSystemSpaceStationInterstellarStationRow {
  readonly entityId: string;
  readonly planetId: string;
  readonly planetName: string;
  readonly planetNameTruncated: boolean;
  readonly machineCount: number;
  readonly stationTier: 1 | 2;
  readonly operationMode: "legacy" | "elevator";
  readonly modeTransition: "to-elevator" | "to-legacy" | null;
  readonly effectiveTargetMode: "legacy" | "elevator";
  readonly outputTargets: readonly NativeSystemSpaceStationOutputTarget[];
  readonly outputConfigurationEnabled: boolean;
}

export interface NativeSystemSpaceStationWorkspaceProjection {
  readonly schemaVersion: 1;
  readonly projectionType: "system-space-station-workspace-v1";
  readonly source: "native-core";
  readonly sessionId: string;
  readonly runId: string;
  readonly revision: number;
  readonly registryFingerprint: string;
  readonly stateVersion: 47;
  readonly limits: {
    readonly requestBytes: 32_768;
    readonly projectionBytes: 1_048_576;
    readonly pageRows: 64;
    readonly totalRows: 65_536;
    readonly idBytes: 512;
    readonly labelBytes: 512;
    readonly decimalDigits: 256;
  };
  readonly request: NativeSystemSpaceStationWorkspaceProjectionRequest;
  readonly system: {
    readonly systemId: string;
    readonly displayName: string;
    readonly displayNameTruncated: boolean;
    readonly planetCount: number;
    readonly activePlanetId: string;
    readonly activePlanetInSystem: boolean;
    readonly unlocked: boolean;
  };
  readonly technology: {
    readonly constructionReady: boolean;
    readonly moduleAssemblyReady: boolean;
    readonly autonomousConstructionReady: boolean;
    readonly orbitalBusReady: boolean;
  };
  readonly station: {
    readonly persisted: boolean;
    readonly status: "not-started" | "building" | "operational";
    readonly costRevision: number;
    readonly costMultiplierBasisPoints: number;
    readonly phaseIndex: number;
    readonly canStartConstruction: boolean;
    readonly launcherPresent: boolean;
    readonly modules: {
      readonly backbone: number;
      readonly energy: number;
      readonly interstellar: number;
    };
    readonly progress: {
      readonly basisPoints: number;
      readonly deliveredAmount: string;
      readonly requiredAmount: string;
      readonly constructionBufferAmount: string;
    };
    readonly inventoryAmount: string;
  };
  readonly hubNetwork: {
    readonly fleetInstalled: number;
    readonly fleetBusy: number;
    readonly fleetReturnCount: number;
    readonly warpers: string;
    readonly warperTarget: string;
  };
  readonly summary: {
    readonly requirementCount: number;
    readonly inventoryItemCount: number;
    readonly trayMaterialCount: number;
    readonly trayAvailableAmount: string;
    readonly interstellarStationCount: number;
    readonly mk1StationCount: number;
    readonly mk2StationCount: number;
    readonly elevatorStationCount: number;
    readonly transitioningStationCount: number;
  };
  readonly requirements: NativeSystemSpaceStationPage<NativeSystemSpaceStationRequirementRow>;
  readonly sharedInventory: NativeSystemSpaceStationPage<NativeSystemSpaceStationInventoryRow>;
  readonly trayMaterials: NativeSystemSpaceStationPage<NativeSystemSpaceStationTrayRow>;
  readonly interstellarStations: NativeSystemSpaceStationPage<NativeSystemSpaceStationInterstellarStationRow>;
}

export type NativeSystemSpaceStationWorkspaceFetchProjection = (
  request: NativeSystemSpaceStationWorkspaceProjectionRequest,
  signal?: AbortSignal,
) => Promise<unknown>;

export interface NativeSystemSpaceStationWorkspaceSource {
  readonly mode: "player-authority";
  readonly boundIdentity: NativeSystemSpaceStationWorkspaceIdentity;
  readVerifiedProjection(
    selector: NativeSystemSpaceStationWorkspaceSelector,
    signal?: AbortSignal,
  ): Promise<NativeSystemSpaceStationWorkspaceProjection | null>;
}

export interface NativeSystemSpaceStationWorkspaceFrame extends NativeSystemSpaceStationWorkspaceIdentity {
  readonly source: "native-core";
  readonly sourceMode: "player-authority";
  readonly selector: NativeSystemSpaceStationWorkspaceSelector;
  readonly projection: NativeSystemSpaceStationWorkspaceProjection;
}

export interface NativeSystemSpaceStationWorkspaceSnapshot {
  readonly status: "empty" | "loading" | "ready" | "unavailable";
  readonly requestedRevision: number | null;
  readonly requestedSelector: NativeSystemSpaceStationWorkspaceSelector | null;
  readonly frame: NativeSystemSpaceStationWorkspaceFrame | null;
  readonly error: "projection-unavailable" | null;
}

export type NativeSystemSpaceStationWorkspaceRefreshResult = "committed" | "superseded" | "unavailable";
export type NativeSystemSpaceStationPageLane = "requirement" | "inventory" | "tray" | "station";

const EMPTY_SNAPSHOT: NativeSystemSpaceStationWorkspaceSnapshot = Object.freeze({
  status: "empty",
  requestedRevision: null,
  requestedSelector: null,
  frame: null,
  error: null,
});
const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;
const textEncoder = new TextEncoder();

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Reflect.ownKeys(value);
  return actual.length === keys.length && actual.every((key) => typeof key === "string") &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function boundedText(value: unknown, maximumBytes: number, allowEmpty = false): value is string {
  return typeof value === "string" && (allowEmpty || value.length > 0) &&
    textEncoder.encode(value).byteLength <= maximumBytes && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
}

function safeInteger(value: unknown, maximum = MAX_SAFE_INTEGER): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= maximum;
}

function canonicalDecimal(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 256 && /^(?:0|[1-9][0-9]*)$/.test(value);
}

function validIdentity(identity: NativeSystemSpaceStationWorkspaceIdentity): boolean {
  return boundedText(identity.sessionId, 128) && boundedText(identity.runId, 128) &&
    safeInteger(identity.revision) && boundedText(identity.registryFingerprint, 256) &&
    boundedText(identity.systemId, 512);
}

function exactIdentity(
  left: NativeSystemSpaceStationWorkspaceIdentity,
  right: NativeSystemSpaceStationWorkspaceIdentity,
): boolean {
  return left.sessionId === right.sessionId && left.runId === right.runId &&
    left.revision === right.revision && left.registryFingerprint === right.registryFingerprint &&
    left.systemId === right.systemId;
}

function identityKey(identity: NativeSystemSpaceStationWorkspaceIdentity): string {
  return `${identity.sessionId}\u0000${identity.runId}\u0000${identity.revision}\u0000${identity.registryFingerprint}\u0000${identity.systemId}`;
}

export function validNativeSystemSpaceStationSelector(
  selector: NativeSystemSpaceStationWorkspaceSelector,
): boolean {
  return (["requirement", "inventory", "tray", "station"] as const).every((lane) => {
    const cursor = selector[`${lane}Cursor`];
    const limit = selector[`${lane}Limit`];
    return safeInteger(cursor, 0xffff_ffff) && safeInteger(limit, NATIVE_SYSTEM_SPACE_STATION_PAGE_ROWS) && limit >= 1;
  });
}

export function nativeSystemSpaceStationSelectorWithCursor(
  selector: NativeSystemSpaceStationWorkspaceSelector,
  lane: NativeSystemSpaceStationPageLane,
  cursor: number,
): NativeSystemSpaceStationWorkspaceSelector | null {
  if (!safeInteger(cursor, 0xffff_ffff)) return null;
  return Object.freeze({ ...selector, [`${lane}Cursor`]: cursor });
}

function sameSelector(
  left: NativeSystemSpaceStationWorkspaceSelector,
  right: NativeSystemSpaceStationWorkspaceSelector,
): boolean {
  return left.requirementCursor === right.requirementCursor && left.requirementLimit === right.requirementLimit &&
    left.inventoryCursor === right.inventoryCursor && left.inventoryLimit === right.inventoryLimit &&
    left.trayCursor === right.trayCursor && left.trayLimit === right.trayLimit &&
    left.stationCursor === right.stationCursor && left.stationLimit === right.stationLimit;
}

function selectorKey(selector: NativeSystemSpaceStationWorkspaceSelector): string {
  return [
    selector.requirementCursor, selector.requirementLimit,
    selector.inventoryCursor, selector.inventoryLimit,
    selector.trayCursor, selector.trayLimit,
    selector.stationCursor, selector.stationLimit,
  ].join(":");
}

function validPage<Row>(
  page: unknown,
  cursor: number,
  limit: number,
  validateRow: (row: unknown) => row is Row,
  rowIdentity: (row: Row) => string,
): page is NativeSystemSpaceStationPage<Row> {
  if (!isRecord(page) || !exactKeys(page, ["cursor", "limit", "totalCount", "nextCursor", "rows"]) ||
      page.cursor !== cursor || page.limit !== limit || !safeInteger(page.totalCount, NATIVE_SYSTEM_SPACE_STATION_MAX_TOTAL_ROWS) ||
      cursor > page.totalCount || !Array.isArray(page.rows)) return false;
  const expectedCount = Math.min(limit, page.totalCount - cursor);
  if (page.rows.length !== expectedCount || !page.rows.every(validateRow)) return false;
  const consumed = cursor + page.rows.length;
  if (page.nextCursor !== (consumed < page.totalCount ? consumed : null)) return false;
  const identities = new Set<string>();
  return (page.rows as Row[]).every((row) => {
    const key = rowIdentity(row);
    return !identities.has(key) && Boolean(identities.add(key));
  });
}

function validRequirement(row: unknown): row is NativeSystemSpaceStationRequirementRow {
  return isRecord(row) && exactKeys(row, [
    "requirementIndex", "phaseName", "itemId", "itemName", "itemNameTruncated", "baseAmount",
    "requiredAmount", "deliveredAmount", "constructionBufferAmount", "complete", "current",
  ]) && safeInteger(row.requirementIndex, NATIVE_SYSTEM_SPACE_STATION_MAX_TOTAL_ROWS) &&
    boundedText(row.phaseName, 512) && boundedText(row.itemId, 512) && boundedText(row.itemName, 512) &&
    typeof row.itemNameTruncated === "boolean" && safeInteger(row.baseAmount) &&
    canonicalDecimal(row.requiredAmount) && canonicalDecimal(row.deliveredAmount) &&
    canonicalDecimal(row.constructionBufferAmount) && typeof row.complete === "boolean" && typeof row.current === "boolean";
}

function validInventory(row: unknown): row is NativeSystemSpaceStationInventoryRow {
  if (!isRecord(row) || !exactKeys(row, ["itemId", "itemName", "itemNameTruncated", "amount", "policy"]) ||
      !boundedText(row.itemId, 512) || !boundedText(row.itemName, 512) ||
      typeof row.itemNameTruncated !== "boolean" || !canonicalDecimal(row.amount)) return false;
  return row.policy === null || isRecord(row.policy) && exactKeys(row.policy, ["interstellarEnabled", "reserve", "target"]) &&
    typeof row.policy.interstellarEnabled === "boolean" && canonicalDecimal(row.policy.reserve) && canonicalDecimal(row.policy.target);
}

function validTray(row: unknown): row is NativeSystemSpaceStationTrayRow {
  return isRecord(row) && exactKeys(row, [
    "planetId", "planetName", "planetNameTruncated", "activePlanet", "itemId", "itemName",
    "itemNameTruncated", "amount", "constructionMaterial",
  ]) && boundedText(row.planetId, 512) && boundedText(row.planetName, 512) &&
    typeof row.planetNameTruncated === "boolean" && typeof row.activePlanet === "boolean" &&
    boundedText(row.itemId, 512) && boundedText(row.itemName, 512) &&
    typeof row.itemNameTruncated === "boolean" && safeInteger(row.amount) && typeof row.constructionMaterial === "boolean";
}

function validOutputTarget(row: unknown, portIndex: number): row is NativeSystemSpaceStationOutputTarget {
  if (!isRecord(row) || !exactKeys(row, ["portIndex", "itemId", "itemName", "itemNameTruncated"]) ||
      row.portIndex !== portIndex || !(row.itemId === null || boundedText(row.itemId, 512)) ||
      !boundedText(row.itemName, 512, row.itemId === null) || typeof row.itemNameTruncated !== "boolean") return false;
  return row.itemId === null ? row.itemName === "" : row.itemName.length > 0;
}

function validStation(row: unknown): row is NativeSystemSpaceStationInterstellarStationRow {
  if (!isRecord(row) || !exactKeys(row, [
    "entityId", "planetId", "planetName", "planetNameTruncated", "machineCount", "stationTier",
    "operationMode", "modeTransition", "effectiveTargetMode", "outputTargets", "outputConfigurationEnabled",
  ]) || !boundedText(row.entityId, 512) || !boundedText(row.planetId, 512) || !boundedText(row.planetName, 512) ||
      typeof row.planetNameTruncated !== "boolean" || !safeInteger(row.machineCount) || row.machineCount < 1 ||
      ![1, 2].includes(row.stationTier as number) || !["legacy", "elevator"].includes(row.operationMode as string) ||
      !(row.modeTransition === null || ["to-elevator", "to-legacy"].includes(row.modeTransition as string)) ||
      !["legacy", "elevator"].includes(row.effectiveTargetMode as string) || !Array.isArray(row.outputTargets) ||
      row.outputTargets.length !== 5 || typeof row.outputConfigurationEnabled !== "boolean") return false;
  if (row.stationTier === 1 && (row.operationMode !== "legacy" || row.modeTransition !== null)) return false;
  const expectedMode = row.modeTransition === "to-elevator" ? "elevator" :
    row.modeTransition === "to-legacy" ? "legacy" : row.operationMode;
  if (row.effectiveTargetMode !== expectedMode || row.outputConfigurationEnabled !==
      (row.stationTier === 2 && row.operationMode === "elevator" && row.modeTransition === null)) return false;
  const seen = new Set<string>();
  return row.outputTargets.every((target, index) => {
    if (!validOutputTarget(target, index)) return false;
    if (target.itemId === null) return true;
    return !seen.has(target.itemId) && Boolean(seen.add(target.itemId));
  });
}

function validProjection(
  value: unknown,
  identity: NativeSystemSpaceStationWorkspaceIdentity,
  selector: NativeSystemSpaceStationWorkspaceSelector,
): value is NativeSystemSpaceStationWorkspaceProjection {
  if (!isRecord(value) || !exactKeys(value, [
    "schemaVersion", "projectionType", "source", "sessionId", "runId", "revision", "registryFingerprint",
    "stateVersion", "limits", "request", "system", "technology", "station", "hubNetwork", "summary",
    "requirements", "sharedInventory", "trayMaterials", "interstellarStations",
  ]) || value.schemaVersion !== 1 || value.projectionType !== "system-space-station-workspace-v1" ||
      value.source !== "native-core" || value.sessionId !== identity.sessionId || value.runId !== identity.runId ||
      value.revision !== identity.revision || value.registryFingerprint !== identity.registryFingerprint || value.stateVersion !== 47 ||
      !isRecord(value.limits) || !exactKeys(value.limits, [
        "requestBytes", "projectionBytes", "pageRows", "totalRows", "idBytes", "labelBytes", "decimalDigits",
      ]) || value.limits.requestBytes !== 32_768 || value.limits.projectionBytes !== 1_048_576 ||
      value.limits.pageRows !== 64 || value.limits.totalRows !== 65_536 || value.limits.idBytes !== 512 ||
      value.limits.labelBytes !== 512 || value.limits.decimalDigits !== 256 || !isRecord(value.request) ||
      !exactKeys(value.request, [
        "sessionId", "runId", "expectedRevision", "expectedRegistryFingerprint", "systemId",
        "requirementCursor", "requirementLimit", "inventoryCursor", "inventoryLimit", "trayCursor", "trayLimit",
        "stationCursor", "stationLimit",
      ]) || value.request.sessionId !== identity.sessionId || value.request.runId !== identity.runId ||
      value.request.expectedRevision !== identity.revision ||
      value.request.expectedRegistryFingerprint !== identity.registryFingerprint || value.request.systemId !== identity.systemId ||
      !sameSelector(value.request as unknown as NativeSystemSpaceStationWorkspaceSelector, selector)) return false;

  if (!isRecord(value.system) || !exactKeys(value.system, [
    "systemId", "displayName", "displayNameTruncated", "planetCount", "activePlanetId", "activePlanetInSystem", "unlocked",
  ]) || value.system.systemId !== identity.systemId || !boundedText(value.system.displayName, 512) ||
      typeof value.system.displayNameTruncated !== "boolean" || !safeInteger(value.system.planetCount, NATIVE_SYSTEM_SPACE_STATION_MAX_TOTAL_ROWS) ||
      value.system.planetCount < 1 || !boundedText(value.system.activePlanetId, 512) ||
      typeof value.system.activePlanetInSystem !== "boolean" || typeof value.system.unlocked !== "boolean" ||
      !isRecord(value.technology) || !exactKeys(value.technology, [
        "constructionReady", "moduleAssemblyReady", "autonomousConstructionReady", "orbitalBusReady",
      ]) || !Object.values(value.technology).every((entry) => typeof entry === "boolean")) return false;

  if (!isRecord(value.station) || !exactKeys(value.station, [
    "persisted", "status", "costRevision", "costMultiplierBasisPoints", "phaseIndex", "canStartConstruction",
    "launcherPresent", "modules", "progress", "inventoryAmount",
  ]) || typeof value.station.persisted !== "boolean" ||
      !["not-started", "building", "operational"].includes(value.station.status as string) ||
      !safeInteger(value.station.costRevision) || !safeInteger(value.station.costMultiplierBasisPoints, 10_000) ||
      (value.station.costMultiplierBasisPoints as number) < 8_000 || !safeInteger(value.station.phaseIndex, 16) ||
      typeof value.station.canStartConstruction !== "boolean" || typeof value.station.launcherPresent !== "boolean" ||
      !isRecord(value.station.modules) || !exactKeys(value.station.modules, ["backbone", "energy", "interstellar"]) ||
      !Object.values(value.station.modules).every((entry) => safeInteger(entry, 1_000_000)) ||
      !isRecord(value.station.progress) || !exactKeys(value.station.progress, [
        "basisPoints", "deliveredAmount", "requiredAmount", "constructionBufferAmount",
      ]) || !safeInteger(value.station.progress.basisPoints, 10_000) ||
      !canonicalDecimal(value.station.progress.deliveredAmount) || !canonicalDecimal(value.station.progress.requiredAmount) ||
      !canonicalDecimal(value.station.progress.constructionBufferAmount) || !canonicalDecimal(value.station.inventoryAmount)) return false;
  const canStart = value.station.status === "not-started" && value.system.unlocked === true &&
    value.technology.constructionReady === true && value.station.launcherPresent === true;
  if (value.station.canStartConstruction !== canStart) return false;

  if (!isRecord(value.hubNetwork) || !exactKeys(value.hubNetwork, [
    "fleetInstalled", "fleetBusy", "fleetReturnCount", "warpers", "warperTarget",
  ]) || !safeInteger(value.hubNetwork.fleetInstalled) || !safeInteger(value.hubNetwork.fleetBusy) ||
      (value.hubNetwork.fleetBusy as number) > (value.hubNetwork.fleetInstalled as number) ||
      !safeInteger(value.hubNetwork.fleetReturnCount, NATIVE_SYSTEM_SPACE_STATION_MAX_TOTAL_ROWS) ||
      !canonicalDecimal(value.hubNetwork.warpers) || !canonicalDecimal(value.hubNetwork.warperTarget) ||
      !isRecord(value.summary) || !exactKeys(value.summary, [
        "requirementCount", "inventoryItemCount", "trayMaterialCount", "trayAvailableAmount",
        "interstellarStationCount", "mk1StationCount", "mk2StationCount", "elevatorStationCount", "transitioningStationCount",
      ])) return false;
  for (const key of [
    "requirementCount", "inventoryItemCount", "trayMaterialCount", "interstellarStationCount", "mk1StationCount",
    "mk2StationCount", "elevatorStationCount", "transitioningStationCount",
  ] as const) if (!safeInteger(value.summary[key], NATIVE_SYSTEM_SPACE_STATION_MAX_TOTAL_ROWS)) return false;
  const stationCount = value.summary.interstellarStationCount as number;
  const mk1Count = value.summary.mk1StationCount as number;
  const mk2Count = value.summary.mk2StationCount as number;
  const elevatorCount = value.summary.elevatorStationCount as number;
  const transitioningCount = value.summary.transitioningStationCount as number;
  if (!canonicalDecimal(value.summary.trayAvailableAmount) ||
      mk1Count + mk2Count !== stationCount || elevatorCount > mk2Count || transitioningCount > mk2Count) return false;

  return validPage(value.requirements, selector.requirementCursor, selector.requirementLimit, validRequirement,
    (row) => String(row.requirementIndex)) &&
    validPage(value.sharedInventory, selector.inventoryCursor, selector.inventoryLimit, validInventory, (row) => row.itemId) &&
    validPage(value.trayMaterials, selector.trayCursor, selector.trayLimit, validTray,
      (row) => `${row.planetId}\u0000${row.itemId}`) &&
    validPage(value.interstellarStations, selector.stationCursor, selector.stationLimit, validStation, (row) => row.entityId) &&
    value.requirements.totalCount === value.summary.requirementCount &&
    value.sharedInventory.totalCount === value.summary.inventoryItemCount &&
    value.trayMaterials.totalCount === value.summary.trayMaterialCount &&
    value.interstellarStations.totalCount === value.summary.interstellarStationCount;
}

export function createNativeSystemSpaceStationWorkspaceSource(
  fetchProjection: NativeSystemSpaceStationWorkspaceFetchProjection | null,
  identity: NativeSystemSpaceStationWorkspaceIdentity,
): NativeSystemSpaceStationWorkspaceSource | null {
  if (typeof fetchProjection !== "function" || !validIdentity(identity)) return null;
  const boundIdentity = Object.freeze({ ...identity });
  return Object.freeze({
    mode: "player-authority" as const,
    boundIdentity,
    async readVerifiedProjection(selector: NativeSystemSpaceStationWorkspaceSelector, signal?: AbortSignal) {
      if (!validNativeSystemSpaceStationSelector(selector) || signal?.aborted) return null;
      try {
        const value = await fetchProjection({
          sessionId: boundIdentity.sessionId,
          runId: boundIdentity.runId,
          expectedRevision: boundIdentity.revision,
          expectedRegistryFingerprint: boundIdentity.registryFingerprint,
          systemId: boundIdentity.systemId,
          ...selector,
        }, signal);
        return signal?.aborted || !validProjection(value, boundIdentity, selector) ? null : value;
      } catch {
        return null;
      }
    },
  });
}

export function selectNativeSystemSpaceStationWorkspaceFrame(
  snapshot: NativeSystemSpaceStationWorkspaceSnapshot,
  identity: NativeSystemSpaceStationWorkspaceIdentity,
  selector: NativeSystemSpaceStationWorkspaceSelector,
): NativeSystemSpaceStationWorkspaceFrame | null {
  return snapshot.status === "ready" && snapshot.frame && exactIdentity(snapshot.frame, identity) &&
    sameSelector(snapshot.frame.selector, selector) ? snapshot.frame : null;
}

export class NativeSystemSpaceStationWorkspaceStore {
  private snapshot: NativeSystemSpaceStationWorkspaceSnapshot = EMPTY_SNAPSHOT;
  private token = 0;
  private currentKey: string | null = null;
  private flight: { key: string; promise: Promise<NativeSystemSpaceStationWorkspaceRefreshResult>; controller: AbortController } | null = null;
  private readonly listeners = new Set<() => void>();

  getSnapshot = (): NativeSystemSpaceStationWorkspaceSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  close(): void {
    this.token += 1;
    this.flight?.controller.abort();
    this.flight = null;
    this.currentKey = null;
    this.publish(EMPTY_SNAPSHOT);
  }

  refresh(
    source: NativeSystemSpaceStationWorkspaceSource,
    identity: NativeSystemSpaceStationWorkspaceIdentity,
    selector: NativeSystemSpaceStationWorkspaceSelector = DEFAULT_NATIVE_SYSTEM_SPACE_STATION_SELECTOR,
    force = false,
  ): Promise<NativeSystemSpaceStationWorkspaceRefreshResult> {
    if (!validIdentity(identity) || !exactIdentity(source.boundIdentity, identity) ||
        !validNativeSystemSpaceStationSelector(selector)) {
      this.close();
      return Promise.resolve("unavailable");
    }
    const key = `${identityKey(identity)}\u0000${selectorKey(selector)}`;
    if (this.flight?.key === key && !force) return this.flight.promise;
    if (!force && this.snapshot.status === "ready" && this.snapshot.frame &&
        exactIdentity(this.snapshot.frame, identity) && sameSelector(this.snapshot.frame.selector, selector)) {
      return Promise.resolve("committed");
    }
    this.flight?.controller.abort();
    const token = ++this.token;
    this.currentKey = key;
    const previous = this.snapshot.frame && exactIdentity(this.snapshot.frame, identity) ? this.snapshot.frame : null;
    const frozenSelector = Object.freeze({ ...selector });
    this.publish(Object.freeze({
      status: "loading" as const,
      requestedRevision: identity.revision,
      requestedSelector: frozenSelector,
      frame: previous,
      error: null,
    }));
    const controller = new AbortController();
    const promise = this.performRefresh(source, identity, frozenSelector, key, token, controller.signal);
    this.flight = { key, promise, controller };
    void promise.finally(() => {
      if (this.flight?.promise === promise) this.flight = null;
    });
    return promise;
  }

  private async performRefresh(
    source: NativeSystemSpaceStationWorkspaceSource,
    identity: NativeSystemSpaceStationWorkspaceIdentity,
    selector: NativeSystemSpaceStationWorkspaceSelector,
    key: string,
    token: number,
    signal: AbortSignal,
  ): Promise<NativeSystemSpaceStationWorkspaceRefreshResult> {
    const projection = await source.readVerifiedProjection(selector, signal);
    if (signal.aborted || token !== this.token || key !== this.currentKey) return "superseded";
    if (!projection) {
      this.publish(Object.freeze({
        status: "unavailable" as const,
        requestedRevision: identity.revision,
        requestedSelector: selector,
        frame: null,
        error: "projection-unavailable" as const,
      }));
      return "unavailable";
    }
    const frame: NativeSystemSpaceStationWorkspaceFrame = Object.freeze({
      source: "native-core" as const,
      sourceMode: "player-authority" as const,
      ...identity,
      selector,
      projection,
    });
    this.publish(Object.freeze({
      status: "ready" as const,
      requestedRevision: identity.revision,
      requestedSelector: selector,
      frame,
      error: null,
    }));
    return "committed";
  }

  private publish(snapshot: NativeSystemSpaceStationWorkspaceSnapshot): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }
}
