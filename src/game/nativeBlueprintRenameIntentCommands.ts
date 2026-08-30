import {
  SIMULATION_RUNTIME_PROTOCOL_VERSION,
  type SimulationCommandPatch,
} from "./simulationRuntimeProtocol";
import {
  nativeBlueprintRenameIdentityMatchesFrame,
  nativeBlueprintRenameLineageMatchesIdentity,
  type NativeBlueprintRenameIdentity,
  type NativeBlueprintWorkspaceFrame,
  type NativeBlueprintWorkspaceIdentity,
} from "./nativeBlueprintWorkspaceStore";

const UTF8_ENCODER = new TextEncoder();
const MAX_BLUEPRINT_ID_BYTES = 512;
const MAX_BLUEPRINT_NAME_UTF16_UNITS = 32;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/u;
const EDGE_WHITESPACE = /^[\s\uFEFF]+|[\s\uFEFF]+$/gu;
const TRAILING_EDGE_WHITESPACE = /[\s\uFEFF]+$/gu;

function wellFormedUnicode(value: string): boolean {
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

function validOpaqueBlueprintId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && wellFormedUnicode(value) &&
    UTF8_ENCODER.encode(value).byteLength <= MAX_BLUEPRINT_ID_BYTES &&
    !CONTROL_CHARACTER.test(value);
}

/**
 * Canonical v47 rename label shared with Rust. The truncation loop iterates
 * Unicode scalar values, so a UTF-16 surrogate pair is accepted or omitted as
 * one unit and can never be split at the 32-code-unit boundary.
 */
export function canonicalizeNativeBlueprintName(value: unknown): string | null {
  if (typeof value !== "string" || !wellFormedUnicode(value)) return null;
  const trimmed = value.replace(EDGE_WHITESPACE, "");
  if (trimmed.length === 0 || CONTROL_CHARACTER.test(trimmed)) return null;
  let units = 0;
  let canonical = "";
  for (const character of trimmed) {
    if (units + character.length > MAX_BLUEPRINT_NAME_UTF16_UNITS) break;
    units += character.length;
    canonical += character;
  }
  canonical = canonical.replace(TRAILING_EDGE_WHITESPACE, "");
  return canonical.length > 0 && !CONTROL_CHARACTER.test(canonical) ? canonical : null;
}

/**
 * Emits one semantic marker. Rust re-reads the full blueprint directory and
 * derives the row index and next revision; renderer data never includes a
 * blueprint body, version, construction queue, entity, belt, or material.
 */
export function createNativeBlueprintRenameIntentCommand(
  baseRevision: number,
  id: string,
  name: string,
): SimulationCommandPatch {
  const canonicalName = canonicalizeNativeBlueprintName(name);
  if (!Number.isSafeInteger(baseRevision) || baseRevision < 0 ||
      !validOpaqueBlueprintId(id) || canonicalName === null || canonicalName !== name) {
    throw new TypeError("原生蓝图重命名意图无效");
  }
  return {
    protocolVersion: SIMULATION_RUNTIME_PROTOCOL_VERSION,
    baseRevision,
    topLevelChanges: [{
      path: ["blueprints", "intent"],
      operation: "set",
      value: { kind: "rename", id, name },
    }],
    changedEntities: [],
    addedEntities: [],
    removedEntityIds: [],
    changedBelts: [],
    addedBelts: [],
    removedBeltIds: [],
  };
}

/**
 * Rebinds a stable editor identity to the newest exact authority frame. The
 * row identity is deliberately independent of the global frame revision, but
 * the emitted command always uses the current route/source revision.
 */
export function prepareNativeBlueprintRenameIntentCommand(
  identity: NativeBlueprintRenameIdentity,
  name: string,
  frame: NativeBlueprintWorkspaceFrame | null,
  routeIdentity: NativeBlueprintWorkspaceIdentity | null,
  commandSource: Readonly<{
    sessionId: string;
    runId: string;
    baseRevision: number;
  }> | null,
): SimulationCommandPatch | null {
  const canonicalName = canonicalizeNativeBlueprintName(name);
  if (!frame || !routeIdentity || !commandSource ||
      !nativeBlueprintRenameIdentityMatchesFrame(identity, frame) ||
      !nativeBlueprintRenameLineageMatchesIdentity(identity, routeIdentity) ||
      frame.revision !== routeIdentity.revision ||
      commandSource.sessionId !== identity.sessionId ||
      commandSource.runId !== identity.runId ||
      commandSource.baseRevision !== frame.revision ||
      canonicalName === null || canonicalName !== name || name === identity.currentName) {
    return null;
  }
  return createNativeBlueprintRenameIntentCommand(frame.revision, identity.blueprintId, name);
}
