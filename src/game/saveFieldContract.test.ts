import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import serverContract from "../../save-field-contract.json";
import {
  inspectSaveContractField as inspectServerSaveContractField,
  inspectSaveContractRecord as inspectServerSaveContractRecord,
} from "../../server/save-field-contract.mjs";
import {
  SAVE_FIELD_CONTRACT,
  getSaveFieldDefinition,
  inspectSaveContractField,
  inspectSaveContractRecord,
  listSaveContractFields,
  omitSaveContractDefaults,
  resolveSaveContractDefault,
} from "./saveFieldContract";

const ENTITY_PROJECTED_FIELDS = [
  "interactionLocked",
  "powerGridId",
  "powerPriority",
  "machineCount",
  "minerCount",
  "progress",
  "routingCursor",
  "powerInputKw",
  "powerOutputKw",
  "stationProgress",
  "stationTrips",
  "stationLastTransfer",
  "stationCongestion",
  "stationDispatchCursor",
  "proliferatorPoints",
  "resourceDepletionRemainder",
  "stationWarperAutoRefill",
  "stationHubEnabled",
  "quantumTarget",
  "stationWarpEnabled",
  "proliferatorBonusProgress",
  "inputs",
  "outputs",
  "stationLastSupplyPeerBySlot",
  "stationRoutes",
] as const;

const BELT_PROJECTED_FIELDS = [
  "lanes",
  "tier",
  "sorterTier",
  "progress",
  "priority",
  "stackSize",
  "monitorEnabled",
  "totalTransferred",
  "congestion",
  "lastFlow",
  "routeMode",
] as const;

const STATION_SLOT_PROJECTED_FIELDS = [
  "localMode",
  "remoteMode",
  "minimumLoad",
  "minStock",
  "maxStock",
  "priority",
  "routePolicy",
  "warperBudget",
] as const;

function denseEntity(): Record<string, unknown> {
  return {
    id: "station",
    kind: "station",
    buildingId: "interstellar_logistics_station",
    interactionLocked: false,
    powerGridId: "grid-a",
    powerPriority: 2,
    machineCount: 0,
    minerCount: 0,
    progress: 0,
    routingCursor: 0,
    powerInputKw: 0,
    powerOutputKw: 0,
    stationProgress: 0,
    stationTrips: 0,
    stationLastTransfer: 0,
    stationCongestion: 0,
    stationDispatchCursor: 0,
    proliferatorPoints: 0,
    resourceDepletionRemainder: 0,
    stationWarperAutoRefill: false,
    stationHubEnabled: false,
    quantumTarget: false,
    stationWarpEnabled: true,
    proliferatorBonusProgress: {},
    inputs: {},
    outputs: {},
    stationLastSupplyPeerBySlot: {},
    stationRoutes: [],
  };
}

function denseBelt(tier = 1): Record<string, unknown> {
  return {
    id: "belt",
    lanes: 1,
    tier,
    sorterTier: Math.min(3, tier),
    progress: 0,
    priority: 0,
    stackSize: 1,
    monitorEnabled: false,
    totalTransferred: 0,
    congestion: 0,
    lastFlow: 0,
    routeMode: "auto",
  };
}

function denseStationSlot(): Record<string, unknown> {
  return {
    localMode: "storage",
    remoteMode: "storage",
    minimumLoad: 1,
    minStock: 0,
    maxStock: 0,
    priority: 1,
    routePolicy: "relay-preferred",
    warperBudget: 2,
  };
}

describe("shared save-field contract", () => {
  it("keeps saveProjection default omission routed through the shared contract", () => {
    const sourcePath = decodeURIComponent(new URL("./saveProjection.ts", import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, "$1");
    const source = readFileSync(sourcePath, "utf8");
    expect(source).not.toContain("omitDefault(");
    expect([...source.matchAll(/delete\s+compact\.([A-Za-z0-9_]+)/g)].map((match) => match[1])).toEqual(["quantumTarget"]);
    expect(source.match(/omitSaveContractDefaults\(compact,\s*"entity",\s*state\.version\)/g)).toHaveLength(1);
    expect(source.match(/omitSaveContractDefaults\(compact,\s*"belt",\s*state\.version\)/g)).toHaveLength(1);
  });

  it("exposes the exact same declarative contract to client and server consumers", () => {
    expect(SAVE_FIELD_CONTRACT).toEqual(serverContract);
    expect(Object.isFrozen(SAVE_FIELD_CONTRACT)).toBe(true);
    expect(Object.isFrozen(SAVE_FIELD_CONTRACT.scopes.entity)).toBe(true);
    expect(listSaveContractFields("entity", 46, "projection")).toEqual(ENTITY_PROJECTED_FIELDS);
    expect(listSaveContractFields("station-slot", 46, "projection")).toEqual(STATION_SLOT_PROJECTED_FIELDS);
    expect(listSaveContractFields("belt", 46, "projection")).toEqual(BELT_PROJECTED_FIELDS);
    expect(listSaveContractFields("entity", 45, "projection")).toEqual([]);
    expect(listSaveContractFields("station-slot", 45, "projection")).toEqual([]);
    expect(listSaveContractFields("belt", 45, "projection")).toEqual([]);
  });

  it("omits all and only declared v46 defaults without mutating the source", () => {
    const sourceEntity = denseEntity();
    const sourceBelt = denseBelt(4);
    const sourceSlot = denseStationSlot();
    const compactEntity = { ...sourceEntity };
    const compactBelt = { ...sourceBelt };
    const compactSlot = { ...sourceSlot };
    omitSaveContractDefaults(compactEntity, "entity", 46);
    omitSaveContractDefaults(compactBelt, "belt", 46);
    omitSaveContractDefaults(compactSlot, "station-slot", 46);
    expect(compactEntity).toEqual({ id: "station", kind: "station", buildingId: "interstellar_logistics_station" });
    expect(compactBelt).toEqual({ id: "belt", tier: 4 });
    expect(compactSlot).toEqual({});
    expect(sourceEntity).toEqual(denseEntity());
    expect(sourceBelt).toEqual(denseBelt(4));
    expect(sourceSlot).toEqual(denseStationSlot());
  });

  it("preserves dense v45 fields because sparse defaults apply only to v46", () => {
    const entity = denseEntity();
    const belt = denseBelt();
    const slot = denseStationSlot();
    expect(omitSaveContractDefaults(entity, "entity", 45)).toEqual(denseEntity());
    expect(omitSaveContractDefaults(belt, "belt", 45)).toEqual(denseBelt());
    expect(omitSaveContractDefaults(slot, "station-slot", 45)).toEqual(denseStationSlot());
    expect(inspectSaveContractField("entity", "interactionLocked", {}, 45)).toMatchObject({
      valid: false,
      status: "missing-required",
    });
    expect(inspectSaveContractField("belt", "lanes", {}, 45)).toMatchObject({
      valid: false,
      status: "missing-required",
    });
    expect(inspectSaveContractField("belt", "tier", {}, 39)).toMatchObject({
      valid: true,
      status: "missing-optional",
    });
  });

  it("resolves literal, empty-container and sibling-derived defaults without writing the record", () => {
    const belt = { tier: 4 };
    expect(resolveSaveContractDefault("belt", "lanes", belt, 46)).toEqual({ applies: true, value: 1 });
    expect(resolveSaveContractDefault("belt", "sorterTier", belt, 46)).toEqual({ applies: true, value: 3 });
    expect(resolveSaveContractDefault("entity", "inputs", {}, 46)).toEqual({ applies: true, value: {} });
    expect(resolveSaveContractDefault("entity", "stationRoutes", {}, 46)).toEqual({ applies: true, value: [] });
    expect(resolveSaveContractDefault("station-slot", "routePolicy", {}, 46)).toEqual({ applies: true, value: "relay-preferred" });
    expect(belt).toEqual({ tier: 4 });
  });

  it("distinguishes a missing field from explicit null and undefined accessors", () => {
    expect(inspectSaveContractField("belt", "lanes", {}, 46)).toMatchObject({
      valid: true,
      status: "defaulted",
      source: "default",
      value: 1,
    });
    expect(inspectSaveContractField("belt", "lanes", { lanes: undefined }, 46)).toMatchObject({
      valid: true,
      status: "defaulted",
      value: 1,
    });
    const projectedUndefined = { lanes: undefined };
    omitSaveContractDefaults(projectedUndefined, "belt", 46);
    expect(projectedUndefined).not.toHaveProperty("lanes");
    expect(inspectSaveContractField("belt", "lanes", { lanes: null }, 46)).toMatchObject({
      valid: false,
      status: "invalid",
      source: "explicit",
    });
    const accessor: Record<string, unknown> = {};
    let getterReads = 0;
    Object.defineProperty(accessor, "lanes", { get: () => { getterReads += 1; return 1; }, enumerable: true });
    expect(inspectSaveContractField("belt", "lanes", accessor, 46)).toMatchObject({
      valid: false,
      reason: "accessor",
    });
    omitSaveContractDefaults(accessor, "belt", 46);
    expect(getterReads).toBe(0);
  });

  it.each([
    ["lanes", 1, 4096, [null, "1", 0, -1, 4097, 1.5, Number.NaN, Number.POSITIVE_INFINITY]],
    ["tier", 1, 32, [null, "1", 0, -1, 33, 1.5, Number.NaN, Number.POSITIVE_INFINITY]],
    ["progress", 0, 100_000_000, [null, "0", -1, 100_000_001, Number.NaN, Number.POSITIVE_INFINITY]],
  ])("validates belt.%s boundaries and rejects explicit invalid values", (field, minimum, maximum, invalidValues) => {
    expect(inspectSaveContractField("belt", field, { [field]: minimum }, 46).valid).toBe(true);
    expect(inspectSaveContractField("belt", field, { [field]: maximum }, 46).valid).toBe(true);
    for (const value of invalidValues) {
      expect(inspectSaveContractField("belt", field, { [field]: value }, 46), `${field}=${String(value)}`).toMatchObject({
        valid: false,
        status: "invalid",
      });
    }
  });

  it.each([
    ["interactionLocked", true, [null, "false", 0]],
    ["powerPriority", 3, [null, "2", 0, 4]],
    ["machineCount", Number.MAX_SAFE_INTEGER, [null, "0", -1, 0.5, Number.MAX_SAFE_INTEGER + 1]],
    ["resourceDepletionRemainder", 9, [null, "0", -1, 10, 0.5]],
    ["stationCongestion", 1, [null, "0", -1, 1.01, Number.NaN]],
  ])("validates entity.%s boundaries and rejects null/string/negative/overflow", (field, accepted, invalidValues) => {
    expect(inspectSaveContractField("entity", field, { [field]: accepted }, 46).valid).toBe(true);
    for (const value of invalidValues) {
      expect(inspectSaveContractField("entity", field, { [field]: value }, 46), `${field}=${String(value)}`).toMatchObject({
        valid: false,
        status: "invalid",
      });
    }
  });

  it.each([
    ["localMode", "demand", [null, "auto", 0]],
    ["remoteMode", "supply", [null, "auto", 0]],
    ["minimumLoad", 0.1, [null, "1", 0, 0.2, 2]],
    ["minStock", 100_000_000, [null, "0", -1, 0.5, 100_000_001]],
    ["maxStock", 100_000_000, [null, "0", -1, 0.5, 100_000_001]],
    ["priority", 2, [null, "1", -1, 3]],
    ["routePolicy", "relay-required", [null, "auto", 0]],
    ["warperBudget", 4, [null, "2", 0, 5, 1.5]],
  ])("validates station-slot.%s and preserves explicit invalid/null decisions", (field, accepted, invalidValues) => {
    expect(inspectSaveContractField("station-slot", field, { [field]: accepted }, 46).valid).toBe(true);
    for (const value of invalidValues) {
      expect(inspectSaveContractField("station-slot", field, { [field]: value }, 46), `${field}=${String(value)}`).toMatchObject({
        valid: false,
        status: "invalid",
        source: "explicit",
      });
    }
  });

  it("validates empty-container fields instead of treating malformed values as defaults", () => {
    expect(inspectSaveContractField("entity", "inputs", { inputs: {} }, 46).valid).toBe(true);
    expect(inspectSaveContractField("entity", "inputs", { inputs: { iron_ore: 0 } }, 46).valid).toBe(true);
    for (const value of [null, [], "", { iron_ore: -1 }, { iron_ore: 0.5 }, { iron_ore: Number.NaN }]) {
      expect(inspectSaveContractField("entity", "inputs", { inputs: value }, 46).valid).toBe(false);
    }
    expect(inspectSaveContractField("entity", "stationRoutes", { stationRoutes: [] }, 46).valid).toBe(true);
    expect(inspectSaveContractField("entity", "stationRoutes", { stationRoutes: null }, 46).valid).toBe(false);
  });

  it("audits complete sparse records from the same definitions", () => {
    expect(inspectSaveContractRecord("entity", {}, 46)).toMatchObject({ valid: true, errors: [] });
    expect(inspectSaveContractRecord("belt", {}, 46)).toMatchObject({ valid: true, errors: [] });
    expect(inspectSaveContractRecord("entity", { interactionLocked: null }, 46)).toMatchObject({
      valid: false,
      errors: [{ field: "interactionLocked", status: "invalid", reason: "invalid-value" }],
    });
    expect(getSaveFieldDefinition("belt", "lanes")).toMatchObject({
      default: { kind: "literal", value: 1 },
      missing: { defaultVersions: [46], requiredFromVersion: 38 },
    });
  });

  it("keeps client and server field decisions identical across dense, sparse and invalid matrices", () => {
    const records = [
      ["entity", denseEntity(), 46],
      ["entity", {}, 46],
      ["entity", { interactionLocked: null, machineCount: -1 }, 46],
      ["entity", { interactionLocked: false, machineCount: 0 }, 45],
      ["station-slot", denseStationSlot(), 46],
      ["station-slot", {}, 46],
      ["station-slot", { localMode: null, minStock: -1, warperBudget: 5 }, 46],
      ["station-slot", denseStationSlot(), 45],
      ["belt", denseBelt(1), 46],
      ["belt", {}, 46],
      ["belt", { lanes: null, tier: "1", progress: -1 }, 46],
      ["belt", denseBelt(3), 45],
    ] as const;
    for (const [scope, record, version] of records) {
      expect(inspectSaveContractRecord(scope, record, version)).toEqual(
        inspectServerSaveContractRecord(scope, record, version),
      );
      for (const field of listSaveContractFields(scope)) {
        expect(inspectSaveContractField(scope, field, record, version)).toEqual(
          inspectServerSaveContractField(scope, field, record, version),
        );
      }
    }
  });

  it("covers every declared field with explicit, missing, null, string, zero, negative and range decisions", () => {
    const scopes = [
      ["entity", denseEntity()],
      ["station-slot", denseStationSlot()],
      ["belt", denseBelt(4)],
    ] as const;
    for (const [scope, dense] of scopes) {
      for (const field of listSaveContractFields(scope)) {
        const definition = getSaveFieldDefinition(scope, field)!;
        const validation = definition.validation as {
          type?: string;
          enum?: unknown[];
          minimum?: number;
          maximum?: number;
        };
        expect(inspectSaveContractField(scope, field, dense, 46), `${scope}.${field} dense`).toMatchObject({
          valid: true,
          status: "explicit",
        });
        expect(inspectSaveContractField(scope, field, {}, 46), `${scope}.${field} missing`).toMatchObject({
          valid: true,
          status: "defaulted",
        });
        expect(inspectSaveContractField(scope, field, { [field]: null }, 46), `${scope}.${field} null`).toMatchObject({
          valid: false,
          status: "invalid",
        });

        if (validation.type === "number") {
          expect(inspectSaveContractField(scope, field, { [field]: "0" }, 46).valid, `${scope}.${field} string`).toBe(false);
          expect(inspectSaveContractField(scope, field, { [field]: -1 }, 46).valid, `${scope}.${field} negative`).toBe(false);
          expect(inspectSaveContractField(scope, field, { [field]: Number.NaN }, 46).valid, `${scope}.${field} NaN`).toBe(false);
          expect(inspectSaveContractField(scope, field, { [field]: Number.POSITIVE_INFINITY }, 46).valid, `${scope}.${field} infinity`).toBe(false);
          const zeroExpected = validation.enum
            ? validation.enum.some((entry) => Object.is(entry, 0))
            : (validation.minimum ?? Number.NEGATIVE_INFINITY) <= 0;
          expect(inspectSaveContractField(scope, field, { [field]: 0 }, 46).valid, `${scope}.${field} zero`).toBe(zeroExpected);
          if (typeof validation.maximum === "number") {
            expect(
              inspectSaveContractField(scope, field, { [field]: validation.maximum + 1 }, 46).valid,
              `${scope}.${field} overflow`,
            ).toBe(false);
          }
        } else if (validation.type === "boolean") {
          expect(inspectSaveContractField(scope, field, { [field]: "false" }, 46).valid, `${scope}.${field} string`).toBe(false);
          expect(inspectSaveContractField(scope, field, { [field]: 0 }, 46).valid, `${scope}.${field} zero`).toBe(false);
        } else if (validation.type === "string") {
          expect(inspectSaveContractField(scope, field, { [field]: 0 }, 46).valid, `${scope}.${field} zero`).toBe(false);
          expect(inspectSaveContractField(scope, field, { [field]: -1 }, 46).valid, `${scope}.${field} negative`).toBe(false);
        } else {
          expect(inspectSaveContractField(scope, field, { [field]: "invalid" }, 46).valid, `${scope}.${field} string`).toBe(false);
          expect(inspectSaveContractField(scope, field, { [field]: 0 }, 46).valid, `${scope}.${field} zero`).toBe(false);
          expect(inspectSaveContractField(scope, field, { [field]: -1 }, 46).valid, `${scope}.${field} negative`).toBe(false);
        }
      }
    }
  });
});
