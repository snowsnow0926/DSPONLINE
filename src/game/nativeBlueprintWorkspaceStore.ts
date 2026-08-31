import type {
  DesktopBridge,
  DesktopNativeCoreBlueprintDetail,
  DesktopNativeCoreBlueprintQueueMembershipRow,
  DesktopNativeCoreBlueprintQueueRow,
  DesktopNativeCoreBlueprintSummary,
  DesktopNativeCoreBlueprintWorkspaceResult,
  DesktopNativeCoreBlueprintWorkspaceSection,
} from "../desktop";

export const NATIVE_BLUEPRINT_PAGE_ROWS = 32 as const;
export const NATIVE_BLUEPRINT_MAX_SOURCE_ROWS = 4_096 as const;
const LOGICAL_ID = /^[A-Za-z0-9_.:-]+$/;
const UTF8_ENCODER = new TextEncoder();

export interface NativeBlueprintWorkspaceIdentity {
  readonly sessionId: string;
  readonly runId: string;
  readonly revision: number;
  readonly registryFingerprint: string;
}

export interface NativeBlueprintRenameIdentity {
  readonly sessionId: string;
  readonly runId: string;
  readonly registryFingerprint: string;
  readonly blueprintId: string;
  readonly currentName: string;
  readonly currentRevision: number;
}

export type NativeBlueprintRotation = 0 | 90 | 180 | 270;
export type NativeBlueprintMirror = "none" | "horizontal";

/**
 * Exact selected-row binding for one target-state metadata transform. This is
 * intentionally separate from the rename editor identity so neither parser
 * can accidentally accept the other intent's fields.
 */
export interface NativeBlueprintTransformBinding {
  readonly sessionId: string;
  readonly runId: string;
  readonly revision: number;
  readonly registryFingerprint: string;
  readonly blueprintId: string;
  readonly currentRowRevision: number;
  readonly currentRotation: NativeBlueprintRotation;
  readonly currentMirror: NativeBlueprintMirror;
}

/** Exact selected detail group bound to one Rust-derived recipe target state. */
export interface NativeBlueprintRecipeOverrideBinding {
  readonly sessionId: string;
  readonly runId: string;
  readonly revision: number;
  readonly registryFingerprint: string;
  readonly blueprintId: string;
  readonly currentRowRevision: number;
  readonly sourceRecipeId: string;
  readonly currentTargetRecipeId: string;
}

/**
 * Position-independent selection handed from the workspace to native canvas
 * placement. The authority revision is intentionally not captured: a later
 * canvas click must read a fresh Rust enqueue context for the same row.
 */
export interface NativeBlueprintEnqueueSelectionBinding {
  readonly sessionId: string;
  readonly runId: string;
  readonly registryFingerprint: string;
  readonly blueprintId: string;
  readonly blueprintName: string;
  readonly currentRowRevision: number;
}

/** Exact selected-row compare-and-delete binding for one library entry. */
export interface NativeBlueprintDeleteBinding {
  readonly sessionId: string;
  readonly runId: string;
  readonly revision: number;
  readonly registryFingerprint: string;
  readonly blueprintId: string;
  readonly currentRowRevision: number;
  readonly libraryTotalCount: number;
}

/** Exact visible-row binding for one Rust-owned construction queue cancel. */
export interface NativeConstructionQueueCancelBinding {
  readonly sessionId: string;
  readonly runId: string;
  readonly revision: number;
  readonly registryFingerprint: string;
  readonly queueEntryId: string;
  readonly queueTotalCount: number;
}

export type NativeConstructionQueueFundScope = "construction" | "fleet" | "all";

/**
 * Exact visible pending row used by one Rust-owned material reservation. The
 * two starting totals are part of the binding so renderer confirmation can
 * prove that the R+1 projection changed this row without inspecting inventory.
 */
export interface NativeConstructionQueueFundBinding {
  readonly sessionId: string;
  readonly runId: string;
  readonly revision: number;
  readonly registryFingerprint: string;
  readonly queueEntryId: string;
  readonly queueTotalCount: number;
  readonly queuePageCursor: number;
  readonly initialStatus: "pending-materials";
  readonly initialReservedConstructionTotal: number;
  readonly initialReservedFleetTotal: number;
}

/** Rust-derived whole-queue membership proof pinned to one authority revision. */
export interface NativeConstructionQueueMembershipProof extends NativeBlueprintWorkspaceIdentity {
  readonly queueEntryId: string;
  readonly present: boolean;
}

export interface NativeBlueprintWorkspaceSource {
  readonly boundIdentity: NativeBlueprintWorkspaceIdentity;
  readVerifiedBlueprintPage(
    section: DesktopNativeCoreBlueprintWorkspaceSection,
    blueprintId: string | null,
    cursor: number,
  ): Promise<DesktopNativeCoreBlueprintWorkspaceResult | null>;
  readVerifiedQueueMembership(
    queueEntryId: string,
  ): Promise<NativeConstructionQueueMembershipProof | null>;
}

export interface NativeBlueprintWorkspaceFrame extends NativeBlueprintWorkspaceIdentity {
  readonly source: "native-core";
  readonly readOnly: true;
  readonly selectedBlueprintId: string | null;
  readonly library: readonly DesktopNativeCoreBlueprintSummary[];
  readonly libraryPage: NativeBlueprintWorkspacePage;
  readonly libraryById: ReadonlyMap<string, DesktopNativeCoreBlueprintSummary>;
  readonly detail: DesktopNativeCoreBlueprintDetail | null;
  readonly queue: readonly DesktopNativeCoreBlueprintQueueRow[];
  readonly queuePage: NativeBlueprintWorkspacePage;
}

export interface NativeBlueprintWorkspacePage {
  readonly cursor: number;
  readonly totalCount: number;
  readonly nextCursor: number | null;
}

export interface NativeBlueprintWorkspaceSnapshot {
  readonly status: "empty" | "loading" | "ready" | "unavailable";
  readonly requestedRevision: number | null;
  readonly frame: NativeBlueprintWorkspaceFrame | null;
}

export type NativeBlueprintWorkspaceRefreshResult = "committed" | "superseded" | "unavailable";

const EMPTY_SNAPSHOT: NativeBlueprintWorkspaceSnapshot = Object.freeze({
  status: "empty",
  requestedRevision: null,
  frame: null,
});

function validLogicalId(value: string, maximumLength = 256): boolean {
  return value.length > 0 && value.length <= maximumLength && LOGICAL_ID.test(value);
}

function validOpaqueText(value: unknown, maximumBytes: number): value is string {
  if (typeof value !== "string" || value.length === 0 ||
      UTF8_ENCODER.encode(value).byteLength > maximumBytes ||
      /[\u0000-\u001f\u007f-\u009f]/u.test(value)) return false;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function safeNonnegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function validIdentity(identity: NativeBlueprintWorkspaceIdentity): boolean {
  return validLogicalId(identity.sessionId, 128) && validLogicalId(identity.runId, 128) &&
    safeNonnegativeInteger(identity.revision) && validLogicalId(identity.registryFingerprint, 256);
}

function sameIdentity(
  left: NativeBlueprintWorkspaceIdentity,
  right: NativeBlueprintWorkspaceIdentity,
): boolean {
  return left.sessionId === right.sessionId && left.runId === right.runId &&
    left.revision === right.revision && left.registryFingerprint === right.registryFingerprint;
}

function identityKey(
  identity: NativeBlueprintWorkspaceIdentity,
  selectedBlueprintId: string | null,
  libraryCursor: number,
  queueCursor: number,
): string {
  return `${identity.sessionId}\0${identity.runId}\0${identity.revision}\0${identity.registryFingerprint}\0${selectedBlueprintId ?? ""}\0${libraryCursor}\0${queueCursor}`;
}

function validCounts(value: DesktopNativeCoreBlueprintSummary["counts"]): boolean {
  return safeNonnegativeInteger(value.entities) && safeNonnegativeInteger(value.belts) &&
    safeNonnegativeInteger(value.resourceAnchors) && safeNonnegativeInteger(value.externalPorts);
}

function validSummary(value: DesktopNativeCoreBlueprintSummary): boolean {
  if (!validOpaqueText(value.id, 512) || !validOpaqueText(value.name, 256) ||
      !Number.isSafeInteger(value.revision) || value.revision < 1 ||
      ![0, 90, 180, 270].includes(value.rotation) ||
      !["none", "horizontal"].includes(value.mirror) || !validCounts(value.counts)) return false;
  const overLimit = value.counts.entities > 512 || value.counts.belts > 1_024 ||
    value.counts.resourceAnchors > 256 || value.counts.externalPorts > 256;
  return value.detailStatus === (overLimit ? "truncated" : "candidate");
}

function validRecipeOverrideGroups(value: DesktopNativeCoreBlueprintDetail): boolean {
  if (!Array.isArray(value.recipeOverrideGroups) ||
      value.recipeOverrideGroups.length > value.entities.length) return false;
  const sources = new Set<string>();
  let totalOptionCount = 0;
  const entityRecipes = new Set(value.entities.flatMap((entity) =>
    entity.recipeId === null ? [] : [entity.recipeId]));
  for (const group of value.recipeOverrideGroups) {
    if (!validOpaqueText(group.sourceRecipeId, 512) ||
        !validOpaqueText(group.targetRecipeId, 512) ||
        !entityRecipes.has(group.sourceRecipeId) || sources.has(group.sourceRecipeId) ||
        !Array.isArray(group.options) || group.options.length === 0 ||
        group.options.length > NATIVE_BLUEPRINT_MAX_SOURCE_ROWS) return false;
    totalOptionCount += group.options.length;
    if (!Number.isSafeInteger(totalOptionCount) ||
        totalOptionCount > NATIVE_BLUEPRINT_MAX_SOURCE_ROWS) return false;
    sources.add(group.sourceRecipeId);
    const optionIds = new Set<string>();
    for (const option of group.options) {
      if (!validOpaqueText(option.id, 512) || !validOpaqueText(option.name, 256) ||
          optionIds.has(option.id)) return false;
      optionIds.add(option.id);
    }
    if (!optionIds.has(group.targetRecipeId)) return false;
  }
  return true;
}

function validDetail(value: DesktopNativeCoreBlueprintDetail, selectedBlueprintId: string): boolean {
  if (!validSummary(value.summary) || value.summary.id !== selectedBlueprintId ||
      !["supported", "truncated", "unsupported"].includes(value.status)) return false;
  const expectedReason = value.status === "supported" ? null
    : value.status === "truncated" ? value.summary.detailStatus === "truncated"
      ? "detail-limits-exceeded"
      : "projection-byte-budget-exceeded"
      : "unproven-catalog-semantics";
  if (value.unsupportedReason !== expectedReason || !Array.isArray(value.entities) ||
      !Array.isArray(value.belts) || !Array.isArray(value.resourceAnchors) ||
      !Array.isArray(value.externalPorts) || !Array.isArray(value.recipeOverrideGroups)) return false;
  if (value.status !== "supported") {
    return value.entities.length === 0 && value.belts.length === 0 &&
      value.resourceAnchors.length === 0 && value.externalPorts.length === 0 &&
      value.recipeOverrideGroups.length === 0 &&
      (value.status === "truncated" || value.summary.detailStatus === "candidate");
  }
  return value.summary.detailStatus === "candidate" &&
    value.entities.length === value.summary.counts.entities &&
    value.belts.length === value.summary.counts.belts &&
    value.resourceAnchors.length === value.summary.counts.resourceAnchors &&
    value.externalPorts.length === value.summary.counts.externalPorts &&
    validRecipeOverrideGroups(value);
}

function validQueueRow(value: DesktopNativeCoreBlueprintQueueRow): boolean {
  if (!validOpaqueText(value.id, 512) || !validOpaqueText(value.blueprintId, 512) ||
    !(value.blueprintVersionId === null || validOpaqueText(value.blueprintVersionId, 512)) ||
    !Number.isSafeInteger(value.blueprintRevision) || value.blueprintRevision < 1 ||
    !validOpaqueText(value.blueprintName, 256) || !validOpaqueText(value.planetId, 512) ||
    !(value.planetName === null || validOpaqueText(value.planetName, 256)) ||
    !Number.isFinite(value.position.x) || !Number.isFinite(value.position.y) ||
    ![0, 90, 180, 270].includes(value.rotation) || !["none", "horizontal"].includes(value.mirror) ||
    !Number.isFinite(value.queuedAt) || value.queuedAt < 0 ||
    !["pending-materials", "waiting-fleet"].includes(value.status) ||
    value.counts !== null && !validCounts(value.counts) ||
    !["catalog-backed", "truncated", "unsupported"].includes(value.semanticStatus) ||
    !safeNonnegativeInteger(value.reservedConstructionTotal) ||
    !safeNonnegativeInteger(value.reservedFleetTotal) || !safeNonnegativeInteger(value.placedEntityCount) ||
    value.actionable !== false) return false;
  const overDetailLimit = value.counts !== null && (value.counts.entities > 512 ||
    value.counts.belts > 1_024 || value.counts.resourceAnchors > 256 || value.counts.externalPorts > 256);
  if (value.semanticStatus === "catalog-backed" && (value.counts === null || overDetailLimit) ||
      value.semanticStatus === "truncated" && (value.counts === null || !overDetailLimit) ||
      value.semanticStatus === "unsupported" && overDetailLimit) return false;
  return value.counts === null || value.placedEntityCount <= value.counts.entities + value.counts.resourceAnchors;
}

function sameSummary(
  left: DesktopNativeCoreBlueprintSummary,
  right: DesktopNativeCoreBlueprintSummary,
): boolean {
  return left.id === right.id && left.name === right.name && left.revision === right.revision &&
    left.rotation === right.rotation && left.mirror === right.mirror &&
    left.detailStatus === right.detailStatus && left.counts.entities === right.counts.entities &&
    left.counts.belts === right.counts.belts &&
    left.counts.resourceAnchors === right.counts.resourceAnchors &&
    left.counts.externalPorts === right.counts.externalPorts;
}

function validProjection(
  value: DesktopNativeCoreBlueprintWorkspaceResult,
  identity: NativeBlueprintWorkspaceIdentity,
  section: DesktopNativeCoreBlueprintWorkspaceSection,
  blueprintId: string | null,
  cursor: number,
  queueEntryId: string | null = null,
): boolean {
  if (value.schemaVersion !== 1 || value.projectionType !== "blueprint-workspace-v1" ||
      value.source !== "native-core" || value.stateVersion !== 47 || value.readOnly !== true ||
      value.revision !== identity.revision || value.registryFingerprint !== identity.registryFingerprint ||
      value.request.expectedRevision !== identity.revision ||
      value.request.expectedRegistryFingerprint !== identity.registryFingerprint ||
      value.request.section !== section || value.request.blueprintId !== blueprintId ||
      value.request.queueEntryId !== queueEntryId ||
      value.request.cursor !== cursor || value.request.limit !== NATIVE_BLUEPRINT_PAGE_ROWS ||
      value.limits.pageRows !== NATIVE_BLUEPRINT_PAGE_ROWS ||
      value.limits.sourceRows !== NATIVE_BLUEPRINT_MAX_SOURCE_ROWS ||
      value.limits.detailEntities !== 512 || value.limits.detailBelts !== 1_024 ||
      value.limits.detailResourceAnchors !== 256 || value.limits.detailExternalPorts !== 256 ||
      value.limits.projectionBytes !== 1_048_576 || value.limits.opaqueIdBytes !== 512 ||
      value.limits.nameBytes !== 256 || !safeNonnegativeInteger(value.counts.library) ||
      value.counts.library > NATIVE_BLUEPRINT_MAX_SOURCE_ROWS ||
      !safeNonnegativeInteger(value.counts.queue) || value.counts.queue > NATIVE_BLUEPRINT_MAX_SOURCE_ROWS ||
      value.page.limit !== NATIVE_BLUEPRINT_PAGE_ROWS ||
      !safeNonnegativeInteger(value.page.totalCount) || !Array.isArray(value.page.rows)) return false;
  const expectedTotal = section === "library" ? value.counts.library
    : section === "queue" ? value.counts.queue : value.page.totalCount;
  const expectedPageCursor = expectedTotal === 0 ? 0
    : cursor < expectedTotal ? cursor
      : Math.floor((expectedTotal - 1) / NATIVE_BLUEPRINT_PAGE_ROWS) * NATIVE_BLUEPRINT_PAGE_ROWS;
  if (value.page.totalCount !== expectedTotal || value.page.cursor !== expectedPageCursor ||
      (section === "detail" || section === "queue-membership") && expectedTotal > 1 ||
      value.page.rows.length !== Math.min(NATIVE_BLUEPRINT_PAGE_ROWS, expectedTotal - expectedPageCursor)) return false;
  const consumed = expectedPageCursor + value.page.rows.length;
  const expectedNext = consumed < expectedTotal ? consumed : null;
  if (value.page.nextCursor !== expectedNext || value.page.truncated !== (expectedNext !== null)) return false;
  return value.page.rows.every((row) => section === "library"
    ? validSummary(row as DesktopNativeCoreBlueprintSummary)
    : section === "detail"
      ? blueprintId !== null && validDetail(row as DesktopNativeCoreBlueprintDetail, blueprintId)
      : section === "queue-membership"
        ? queueEntryId !== null && validOpaqueText(
          (row as DesktopNativeCoreBlueprintQueueMembershipRow).id,
          512,
        ) && (row as DesktopNativeCoreBlueprintQueueMembershipRow).id === queueEntryId &&
          Object.keys(row as object).length === 1
        : validQueueRow(row as DesktopNativeCoreBlueprintQueueRow));
}

function sameHeader(
  left: DesktopNativeCoreBlueprintWorkspaceResult,
  right: DesktopNativeCoreBlueprintWorkspaceResult,
): boolean {
  return left.revision === right.revision && left.registryFingerprint === right.registryFingerprint &&
    left.counts.library === right.counts.library && left.counts.queue === right.counts.queue &&
    JSON.stringify(left.limits) === JSON.stringify(right.limits);
}

export function createNativePlayerAuthorityBlueprintWorkspaceSource(
  bridge: Pick<DesktopBridge, "getNativeCoreBlueprintWorkspace"> | null,
  identity: NativeBlueprintWorkspaceIdentity,
): NativeBlueprintWorkspaceSource | null {
  const reader = bridge?.getNativeCoreBlueprintWorkspace;
  if (typeof reader !== "function" || !validIdentity(identity)) return null;
  const boundIdentity = Object.freeze({ ...identity });
  return Object.freeze({
    boundIdentity,
    async readVerifiedBlueprintPage(
      section: DesktopNativeCoreBlueprintWorkspaceSection,
      blueprintId: string | null,
      cursor: number,
    ) {
      if (section === "queue-membership" || (section === "detail") !== (blueprintId !== null) ||
          blueprintId !== null && !validOpaqueText(blueprintId, 512) ||
          !Number.isSafeInteger(cursor) || cursor < 0 || cursor > NATIVE_BLUEPRINT_MAX_SOURCE_ROWS ||
          section === "detail" && cursor !== 0) return null;
      try {
        const page = await reader({
          sessionId: boundIdentity.sessionId,
          expectedRevision: boundIdentity.revision,
          expectedRegistryFingerprint: boundIdentity.registryFingerprint,
          section,
          blueprintId,
          queueEntryId: null,
          cursor,
          limit: NATIVE_BLUEPRINT_PAGE_ROWS,
        });
        return validProjection(page, boundIdentity, section, blueprintId, cursor) ? page : null;
      } catch {
        return null;
      }
    },
    async readVerifiedQueueMembership(queueEntryId: string) {
      if (!validOpaqueText(queueEntryId, 512)) return null;
      try {
        const page = await reader({
          sessionId: boundIdentity.sessionId,
          expectedRevision: boundIdentity.revision,
          expectedRegistryFingerprint: boundIdentity.registryFingerprint,
          section: "queue-membership",
          blueprintId: null,
          queueEntryId,
          cursor: 0,
          limit: NATIVE_BLUEPRINT_PAGE_ROWS,
        });
        if (!validProjection(
          page,
          boundIdentity,
          "queue-membership",
          null,
          0,
          queueEntryId,
        )) return null;
        return Object.freeze({
          ...boundIdentity,
          queueEntryId,
          present: page.page.totalCount === 1,
        });
      } catch {
        return null;
      }
    },
  });
}

export function selectNativeBlueprintWorkspaceFrame(
  snapshot: NativeBlueprintWorkspaceSnapshot,
  identity: NativeBlueprintWorkspaceIdentity,
): NativeBlueprintWorkspaceFrame | null {
  return snapshot.status === "ready" && snapshot.frame && sameIdentity(snapshot.frame, identity)
    ? snapshot.frame
    : null;
}

export function nativeBlueprintRenameIdentityMatchesFrame(
  identity: NativeBlueprintRenameIdentity,
  frame: NativeBlueprintWorkspaceFrame | null,
): boolean {
  if (!frame || !nativeBlueprintRenameLineageMatchesIdentity(identity, frame) ||
      !validOpaqueText(identity.blueprintId, 512) || !validOpaqueText(identity.currentName, 256) ||
      !Number.isSafeInteger(identity.currentRevision) || identity.currentRevision < 1 ||
      frame.selectedBlueprintId !== identity.blueprintId) return false;
  const row = frame.libraryById.get(identity.blueprintId);
  return row?.name === identity.currentName && row.revision === identity.currentRevision;
}

export function nativeBlueprintRenameLineageMatchesIdentity(
  identity: NativeBlueprintRenameIdentity,
  candidate: Pick<NativeBlueprintWorkspaceIdentity, "sessionId" | "runId" | "registryFingerprint">,
): boolean {
  return validLogicalId(identity.sessionId, 128) && validLogicalId(identity.runId, 128) &&
    validLogicalId(identity.registryFingerprint, 256) &&
    identity.sessionId === candidate.sessionId && identity.runId === candidate.runId &&
    identity.registryFingerprint === candidate.registryFingerprint;
}

export function nativeBlueprintTransformBindingMatchesFrame(
  binding: NativeBlueprintTransformBinding,
  frame: NativeBlueprintWorkspaceFrame | null,
): boolean {
  if (!frame || frame.sessionId !== binding.sessionId || frame.runId !== binding.runId ||
      frame.revision !== binding.revision ||
      frame.registryFingerprint !== binding.registryFingerprint ||
      !validOpaqueText(binding.blueprintId, 512) ||
      !Number.isSafeInteger(binding.currentRowRevision) || binding.currentRowRevision < 1 ||
      binding.currentRowRevision >= Number.MAX_SAFE_INTEGER ||
      ![0, 90, 180, 270].includes(binding.currentRotation) ||
      !["none", "horizontal"].includes(binding.currentMirror) ||
      frame.selectedBlueprintId !== binding.blueprintId) return false;
  const row = frame.libraryById.get(binding.blueprintId);
  return row?.revision === binding.currentRowRevision &&
    row.rotation === binding.currentRotation && row.mirror === binding.currentMirror;
}

export function selectNativeBlueprintTransformBinding(
  frame: NativeBlueprintWorkspaceFrame | null,
): NativeBlueprintTransformBinding | null {
  if (!frame || frame.selectedBlueprintId === null) return null;
  const row = frame.libraryById.get(frame.selectedBlueprintId);
  if (!row) return null;
  const binding: NativeBlueprintTransformBinding = Object.freeze({
    sessionId: frame.sessionId,
    runId: frame.runId,
    revision: frame.revision,
    registryFingerprint: frame.registryFingerprint,
    blueprintId: row.id,
    currentRowRevision: row.revision,
    currentRotation: row.rotation as NativeBlueprintRotation,
    currentMirror: row.mirror as NativeBlueprintMirror,
  });
  return nativeBlueprintTransformBindingMatchesFrame(binding, frame) ? binding : null;
}

export function nativeBlueprintRecipeOverrideBindingMatchesFrame(
  binding: NativeBlueprintRecipeOverrideBinding,
  frame: NativeBlueprintWorkspaceFrame | null,
): boolean {
  if (!frame || frame.sessionId !== binding.sessionId || frame.runId !== binding.runId ||
      frame.revision !== binding.revision ||
      frame.registryFingerprint !== binding.registryFingerprint ||
      !validOpaqueText(binding.blueprintId, 512) ||
      !validOpaqueText(binding.sourceRecipeId, 512) ||
      !validOpaqueText(binding.currentTargetRecipeId, 512) ||
      !Number.isSafeInteger(binding.currentRowRevision) || binding.currentRowRevision < 1 ||
      frame.selectedBlueprintId !== binding.blueprintId ||
      frame.detail?.status !== "supported" ||
      frame.detail.summary.id !== binding.blueprintId) return false;
  const row = frame.libraryById.get(binding.blueprintId);
  const group = frame.detail.recipeOverrideGroups.find((candidate) =>
    candidate.sourceRecipeId === binding.sourceRecipeId);
  return row?.revision === binding.currentRowRevision &&
    frame.detail.summary.revision === binding.currentRowRevision &&
    group?.targetRecipeId === binding.currentTargetRecipeId &&
    group.options.some((option) => option.id === binding.currentTargetRecipeId);
}

function selectNativeBlueprintRecipeOverrideBindingInternal(
  frame: NativeBlueprintWorkspaceFrame | null,
  sourceRecipeId: string,
  writable: boolean,
): NativeBlueprintRecipeOverrideBinding | null {
  if (!frame || frame.selectedBlueprintId === null || !validOpaqueText(sourceRecipeId, 512) ||
      frame.detail?.status !== "supported") return null;
  const row = frame.libraryById.get(frame.selectedBlueprintId);
  const group = frame.detail.recipeOverrideGroups.find((candidate) =>
    candidate.sourceRecipeId === sourceRecipeId);
  if (!row || !group || (writable && row.revision >= Number.MAX_SAFE_INTEGER)) return null;
  const binding: NativeBlueprintRecipeOverrideBinding = Object.freeze({
    sessionId: frame.sessionId,
    runId: frame.runId,
    revision: frame.revision,
    registryFingerprint: frame.registryFingerprint,
    blueprintId: row.id,
    currentRowRevision: row.revision,
    sourceRecipeId: group.sourceRecipeId,
    currentTargetRecipeId: group.targetRecipeId,
  });
  return nativeBlueprintRecipeOverrideBindingMatchesFrame(binding, frame) ? binding : null;
}

/** Selects a writable group; a terminal row revision remains readable but cannot increment again. */
export function selectNativeBlueprintRecipeOverrideBinding(
  frame: NativeBlueprintWorkspaceFrame | null,
  sourceRecipeId: string,
): NativeBlueprintRecipeOverrideBinding | null {
  return selectNativeBlueprintRecipeOverrideBindingInternal(frame, sourceRecipeId, true);
}

/** Read-only target projection used only to confirm the final safe revision after durable ACK. */
export function selectNativeBlueprintRecipeOverrideProjectionBinding(
  frame: NativeBlueprintWorkspaceFrame | null,
  sourceRecipeId: string,
): NativeBlueprintRecipeOverrideBinding | null {
  return selectNativeBlueprintRecipeOverrideBindingInternal(frame, sourceRecipeId, false);
}

export function nativeBlueprintEnqueueSelectionBindingMatchesFrame(
  binding: NativeBlueprintEnqueueSelectionBinding,
  frame: NativeBlueprintWorkspaceFrame | null,
): boolean {
  if (!frame || frame.sessionId !== binding.sessionId || frame.runId !== binding.runId ||
      frame.registryFingerprint !== binding.registryFingerprint ||
      !validOpaqueText(binding.blueprintId, 512) ||
      !validOpaqueText(binding.blueprintName, 256) ||
      !Number.isSafeInteger(binding.currentRowRevision) || binding.currentRowRevision < 1 ||
      binding.currentRowRevision > Number.MAX_SAFE_INTEGER ||
      frame.selectedBlueprintId !== binding.blueprintId ||
      frame.detail?.status !== "supported" ||
      frame.detail.summary.id !== binding.blueprintId) return false;
  const row = frame.libraryById.get(binding.blueprintId);
  return row?.name === binding.blueprintName &&
    row.revision === binding.currentRowRevision &&
    frame.detail.summary.name === binding.blueprintName &&
    frame.detail.summary.revision === binding.currentRowRevision;
}

export function selectNativeBlueprintEnqueueSelectionBinding(
  frame: NativeBlueprintWorkspaceFrame | null,
): NativeBlueprintEnqueueSelectionBinding | null {
  if (!frame || frame.selectedBlueprintId === null || frame.detail?.status !== "supported") {
    return null;
  }
  const row = frame.libraryById.get(frame.selectedBlueprintId);
  if (!row) return null;
  const binding: NativeBlueprintEnqueueSelectionBinding = Object.freeze({
    sessionId: frame.sessionId,
    runId: frame.runId,
    registryFingerprint: frame.registryFingerprint,
    blueprintId: row.id,
    blueprintName: row.name,
    currentRowRevision: row.revision,
  });
  return nativeBlueprintEnqueueSelectionBindingMatchesFrame(binding, frame) ? binding : null;
}

export function nativeBlueprintDeleteBindingMatchesFrame(
  binding: NativeBlueprintDeleteBinding,
  frame: NativeBlueprintWorkspaceFrame | null,
): boolean {
  if (!frame || frame.sessionId !== binding.sessionId || frame.runId !== binding.runId ||
      frame.revision !== binding.revision ||
      frame.registryFingerprint !== binding.registryFingerprint ||
      !validOpaqueText(binding.blueprintId, 512) ||
      !Number.isSafeInteger(binding.currentRowRevision) || binding.currentRowRevision < 1 ||
      binding.currentRowRevision > Number.MAX_SAFE_INTEGER ||
      !Number.isSafeInteger(binding.libraryTotalCount) || binding.libraryTotalCount < 1 ||
      frame.libraryPage.totalCount !== binding.libraryTotalCount ||
      frame.selectedBlueprintId !== binding.blueprintId) return false;
  return frame.libraryById.get(binding.blueprintId)?.revision === binding.currentRowRevision;
}

export function selectNativeBlueprintDeleteBinding(
  frame: NativeBlueprintWorkspaceFrame | null,
): NativeBlueprintDeleteBinding | null {
  if (!frame || frame.selectedBlueprintId === null) return null;
  const row = frame.libraryById.get(frame.selectedBlueprintId);
  if (!row) return null;
  const binding: NativeBlueprintDeleteBinding = Object.freeze({
    sessionId: frame.sessionId,
    runId: frame.runId,
    revision: frame.revision,
    registryFingerprint: frame.registryFingerprint,
    blueprintId: row.id,
    currentRowRevision: row.revision,
    libraryTotalCount: frame.libraryPage.totalCount,
  });
  return nativeBlueprintDeleteBindingMatchesFrame(binding, frame) ? binding : null;
}

export function nativeConstructionQueueCancelBindingMatchesFrame(
  binding: NativeConstructionQueueCancelBinding,
  frame: NativeBlueprintWorkspaceFrame | null,
): boolean {
  return Boolean(frame && frame.sessionId === binding.sessionId && frame.runId === binding.runId &&
    frame.revision === binding.revision &&
    frame.registryFingerprint === binding.registryFingerprint &&
    validOpaqueText(binding.queueEntryId, 512) &&
    Number.isSafeInteger(binding.queueTotalCount) && binding.queueTotalCount >= 1 &&
    frame.queuePage.totalCount === binding.queueTotalCount &&
    frame.queue.some((row) => row.id === binding.queueEntryId));
}

export function selectNativeConstructionQueueCancelBinding(
  frame: NativeBlueprintWorkspaceFrame | null,
  queueEntryId: string,
): NativeConstructionQueueCancelBinding | null {
  if (!frame) return null;
  const binding: NativeConstructionQueueCancelBinding = Object.freeze({
    sessionId: frame.sessionId,
    runId: frame.runId,
    revision: frame.revision,
    registryFingerprint: frame.registryFingerprint,
    queueEntryId,
    queueTotalCount: frame.queuePage.totalCount,
  });
  return nativeConstructionQueueCancelBindingMatchesFrame(binding, frame) ? binding : null;
}

export function nativeConstructionQueueFundBindingMatchesFrame(
  binding: NativeConstructionQueueFundBinding,
  frame: NativeBlueprintWorkspaceFrame | null,
): boolean {
  if (!frame || frame.sessionId !== binding.sessionId || frame.runId !== binding.runId ||
      frame.revision !== binding.revision ||
      frame.registryFingerprint !== binding.registryFingerprint ||
      !validOpaqueText(binding.queueEntryId, 512) ||
      !Number.isSafeInteger(binding.queueTotalCount) || binding.queueTotalCount < 1 ||
      !Number.isSafeInteger(binding.queuePageCursor) || binding.queuePageCursor < 0 ||
      binding.initialStatus !== "pending-materials" ||
      !safeNonnegativeInteger(binding.initialReservedConstructionTotal) ||
      !safeNonnegativeInteger(binding.initialReservedFleetTotal) ||
      frame.queuePage.totalCount !== binding.queueTotalCount ||
      frame.queuePage.cursor !== binding.queuePageCursor) return false;
  const row = frame.queue.find((candidate) => candidate.id === binding.queueEntryId);
  return row?.semanticStatus === "catalog-backed" && row.status === binding.initialStatus &&
    row.reservedConstructionTotal === binding.initialReservedConstructionTotal &&
    row.reservedFleetTotal === binding.initialReservedFleetTotal;
}

export function selectNativeConstructionQueueFundBinding(
  frame: NativeBlueprintWorkspaceFrame | null,
  queueEntryId: string,
): NativeConstructionQueueFundBinding | null {
  if (!frame) return null;
  const row = frame.queue.find((candidate) => candidate.id === queueEntryId);
  if (!row || row.semanticStatus !== "catalog-backed" || row.status !== "pending-materials") {
    return null;
  }
  const binding: NativeConstructionQueueFundBinding = Object.freeze({
    sessionId: frame.sessionId,
    runId: frame.runId,
    revision: frame.revision,
    registryFingerprint: frame.registryFingerprint,
    queueEntryId: row.id,
    queueTotalCount: frame.queuePage.totalCount,
    queuePageCursor: frame.queuePage.cursor,
    initialStatus: "pending-materials" as const,
    initialReservedConstructionTotal: row.reservedConstructionTotal,
    initialReservedFleetTotal: row.reservedFleetTotal,
  });
  return nativeConstructionQueueFundBindingMatchesFrame(binding, frame) ? binding : null;
}

export class NativeBlueprintWorkspaceStore {
  private snapshot: NativeBlueprintWorkspaceSnapshot = EMPTY_SNAPSHOT;
  private token = 0;
  private currentKey: string | null = null;
  private flight: { key: string; promise: Promise<NativeBlueprintWorkspaceRefreshResult> } | null = null;
  private readonly listeners = new Set<() => void>();

  getSnapshot = (): NativeBlueprintWorkspaceSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  clear(): void {
    this.token += 1;
    this.currentKey = null;
    this.flight = null;
    this.publish(EMPTY_SNAPSHOT);
  }

  refresh(
    source: NativeBlueprintWorkspaceSource,
    identity: NativeBlueprintWorkspaceIdentity,
    selectedBlueprintId: string | null,
    libraryCursor = 0,
    queueCursor = 0,
  ): Promise<NativeBlueprintWorkspaceRefreshResult> {
    if (!validIdentity(identity) || !sameIdentity(source.boundIdentity, identity) ||
        selectedBlueprintId !== null && !validOpaqueText(selectedBlueprintId, 512) ||
        !safeNonnegativeInteger(libraryCursor) || libraryCursor > NATIVE_BLUEPRINT_MAX_SOURCE_ROWS ||
        !safeNonnegativeInteger(queueCursor) || queueCursor > NATIVE_BLUEPRINT_MAX_SOURCE_ROWS) {
      this.invalidate();
      return Promise.resolve("unavailable");
    }
    const key = identityKey(identity, selectedBlueprintId, libraryCursor, queueCursor);
    const keyChanged = this.currentKey !== key;
    if (keyChanged) {
      this.token += 1;
      this.flight = null;
      this.currentKey = key;
    }
    if (this.flight?.key === key) return this.flight.promise;
    if (!keyChanged && this.snapshot.status === "ready" && this.snapshot.frame &&
        sameIdentity(this.snapshot.frame, identity)) return Promise.resolve("committed");
    const token = ++this.token;
    const previous = this.snapshot.frame;
    this.publish(Object.freeze({ status: "loading", requestedRevision: identity.revision, frame: previous }));
    const promise = this.performRefresh(
      source,
      identity,
      selectedBlueprintId,
      libraryCursor,
      queueCursor,
      token,
      previous,
    );
    this.flight = { key, promise };
    const clearFlight = () => {
      if (this.flight?.promise === promise) this.flight = null;
    };
    void promise.then(clearFlight, clearFlight);
    return promise;
  }

  private async performRefresh(
    source: NativeBlueprintWorkspaceSource,
    identity: NativeBlueprintWorkspaceIdentity,
    requestedSelection: string | null,
    libraryCursor: number,
    queueCursor: number,
    token: number,
    previous: NativeBlueprintWorkspaceFrame | null,
  ): Promise<NativeBlueprintWorkspaceRefreshResult> {
    let libraryPage: DesktopNativeCoreBlueprintWorkspaceResult | null;
    let queuePage: DesktopNativeCoreBlueprintWorkspaceResult | null;
    try {
      [libraryPage, queuePage] = await Promise.all([
        source.readVerifiedBlueprintPage("library", null, libraryCursor),
        source.readVerifiedBlueprintPage("queue", null, queueCursor),
      ]);
    } catch {
      return this.fail(identity, token, previous);
    }
    if (token !== this.token) return "superseded";
    if (!libraryPage || !queuePage ||
        !validProjection(libraryPage, identity, "library", null, libraryCursor) ||
        !validProjection(queuePage, identity, "queue", null, queueCursor) ||
        !sameHeader(libraryPage, queuePage)) return this.fail(identity, token, previous);

    const library = libraryPage.page.rows as DesktopNativeCoreBlueprintSummary[];
    const queue = queuePage.page.rows as DesktopNativeCoreBlueprintQueueRow[];
    if (new Set(library.map((row) => row.id)).size !== library.length ||
        new Set(queue.map((row) => row.id)).size !== queue.length) {
      return this.fail(identity, token, previous);
    }
    const libraryById = new Map(library.map((row) => [row.id, row]));
    const selectedBlueprintId = requestedSelection && libraryById.has(requestedSelection)
      ? requestedSelection
      : null;
    let detail: DesktopNativeCoreBlueprintDetail | null = null;
    if (selectedBlueprintId) {
      let detailPage: DesktopNativeCoreBlueprintWorkspaceResult | null;
      try {
        detailPage = await source.readVerifiedBlueprintPage("detail", selectedBlueprintId, 0);
      } catch {
        return this.fail(identity, token, previous);
      }
      if (token !== this.token) return "superseded";
      if (!detailPage || !validProjection(detailPage, identity, "detail", selectedBlueprintId, 0) ||
          !sameHeader(libraryPage, detailPage) || detailPage.page.totalCount !== 1 ||
          !sameSummary(
            (detailPage.page.rows[0] as DesktopNativeCoreBlueprintDetail).summary,
            libraryById.get(selectedBlueprintId)!,
          )) {
        return this.fail(identity, token, previous);
      }
      detail = detailPage.page.rows[0] as DesktopNativeCoreBlueprintDetail;
    }
    if (token !== this.token) return "superseded";
    const frame: NativeBlueprintWorkspaceFrame = Object.freeze({
      source: "native-core" as const,
      readOnly: true as const,
      ...identity,
      selectedBlueprintId,
      library: Object.freeze([...library]),
      libraryPage: Object.freeze({
        cursor: libraryPage.page.cursor,
        totalCount: libraryPage.page.totalCount,
        nextCursor: libraryPage.page.nextCursor,
      }),
      libraryById,
      detail,
      queue: Object.freeze([...queue]),
      queuePage: Object.freeze({
        cursor: queuePage.page.cursor,
        totalCount: queuePage.page.totalCount,
        nextCursor: queuePage.page.nextCursor,
      }),
    });
    this.publish(Object.freeze({ status: "ready", requestedRevision: identity.revision, frame }));
    return "committed";
  }

  private fail(
    identity: NativeBlueprintWorkspaceIdentity,
    token: number,
    previous: NativeBlueprintWorkspaceFrame | null,
  ): NativeBlueprintWorkspaceRefreshResult {
    if (token !== this.token) return "superseded";
    this.publish(Object.freeze({ status: "unavailable", requestedRevision: identity.revision, frame: previous }));
    return "unavailable";
  }

  private invalidate(): void {
    this.token += 1;
    this.flight = null;
    this.currentKey = null;
    this.publish(Object.freeze({ status: "unavailable", requestedRevision: null, frame: this.snapshot.frame }));
  }

  private publish(next: NativeBlueprintWorkspaceSnapshot): void {
    if (this.snapshot === next) return;
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
}
