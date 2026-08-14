export type SaveFieldScope = "entity" | "station-slot" | "belt";
export type SaveFieldListingPurpose = "all" | "projection" | "missing-default";
export type SaveFieldInspectionStatus =
  | "explicit"
  | "defaulted"
  | "missing-optional"
  | "missing-required"
  | "invalid"
  | "invalid-version"
  | "unknown-field";

export interface SaveFieldInspection {
  valid: boolean;
  status: SaveFieldInspectionStatus;
  source: "explicit" | "default" | "missing" | "none";
  value: unknown;
  reason: string | null;
}

export interface SaveRecordInspection {
  valid: boolean;
  fields: Record<string, SaveFieldInspection>;
  errors: Array<{ field: string; status: SaveFieldInspectionStatus; reason: string | null }>;
}

export interface SaveFieldDefinition {
  default: Record<string, unknown>;
  validation: Record<string, unknown>;
  missing: { defaultVersions: number[]; requiredFromVersion?: number };
  projection: { omitDefaultVersions: number[] };
}

export interface SaveFieldContract {
  contractVersion: number;
  gameStateVersion: number;
  scopes: Record<SaveFieldScope, Record<string, SaveFieldDefinition>>;
}

export const SAVE_FIELD_CONTRACT: Readonly<SaveFieldContract>;
export function validateSaveContractValue(value: unknown, validation: Record<string, unknown>): boolean;
export function getSaveFieldDefinition(scope: SaveFieldScope, field: string): SaveFieldDefinition | null;
export function listSaveContractFields(scope: SaveFieldScope, gameStateVersion?: number, purpose?: SaveFieldListingPurpose): string[];
export function resolveSaveContractDefault(
  scope: SaveFieldScope,
  field: string,
  record: Record<string, unknown>,
  gameStateVersion: number,
): { applies: boolean; value: unknown };
export function inspectSaveContractField(
  scope: SaveFieldScope,
  field: string,
  record: Record<string, unknown>,
  gameStateVersion: number,
): SaveFieldInspection;
export function inspectSaveContractRecord(
  scope: SaveFieldScope,
  record: Record<string, unknown>,
  gameStateVersion: number,
): SaveRecordInspection;
export function omitSaveContractDefaults<T extends Record<string, unknown>>(
  record: T,
  scope: SaveFieldScope,
  gameStateVersion: number,
): T;
