import { describe, expect, it } from "vitest";

import {
  createNativeBlueprintRecipeOverrideIntentCommand,
  prepareNativeBlueprintRecipeOverrideIntentCommand,
} from "./nativeBlueprintRecipeOverrideIntentCommands";
import type {
  NativeBlueprintRecipeOverrideBinding,
  NativeBlueprintWorkspaceFrame,
} from "./nativeBlueprintWorkspaceStore";

const TARGET_RECIPE_ID = "recipe:steel";
const BINDING: NativeBlueprintRecipeOverrideBinding = Object.freeze({
  sessionId: "session-a",
  runId: "run-a",
  revision: 48,
  registryFingerprint: "registry-a",
  blueprintId: "mod:opaque/rocket",
  currentRowRevision: 4,
  sourceRecipeId: "recipe:iron-ingot",
  currentTargetRecipeId: "recipe:iron-ingot",
});

function frame(
  overrides: Partial<NativeBlueprintWorkspaceFrame> = {},
): NativeBlueprintWorkspaceFrame {
  const row = Object.freeze({
    id: BINDING.blueprintId,
    name: "目录蓝图",
    revision: BINDING.currentRowRevision,
    rotation: 90 as const,
    mirror: "horizontal" as const,
    counts: { entities: 1, belts: 0, resourceAnchors: 0, externalPorts: 0 },
    detailStatus: "candidate" as const,
  });
  const detail = Object.freeze({
    summary: row,
    status: "supported" as const,
    unsupportedReason: null,
    entities: [{
      key: "entity-1",
      buildingId: "assembler",
      buildingLabel: "制造台",
      offset: { x: 0, y: 0 },
      machineCount: 1,
      recipeId: BINDING.sourceRecipeId,
      operationEnabledOnDeploy: true,
    }],
    belts: [],
    resourceAnchors: [],
    externalPorts: [],
    recipeOverrideGroups: [{
      sourceRecipeId: BINDING.sourceRecipeId,
      targetRecipeId: BINDING.currentTargetRecipeId,
      options: [
        { id: BINDING.currentTargetRecipeId, name: "铁块" },
        { id: TARGET_RECIPE_ID, name: "钢材" },
      ],
    }],
  });
  return {
    source: "native-core",
    readOnly: true,
    sessionId: BINDING.sessionId,
    runId: BINDING.runId,
    revision: BINDING.revision,
    registryFingerprint: BINDING.registryFingerprint,
    selectedBlueprintId: row.id,
    library: [row],
    libraryById: new Map([[row.id, row]]),
    libraryPage: { cursor: 0, totalCount: 1, nextCursor: null },
    detail,
    queue: [],
    queuePage: { cursor: 0, totalCount: 0, nextCursor: null },
    ...overrides,
  };
}

describe("native blueprint recipe override intent", () => {
  it("emits one exact four-key marker and no blueprint or catalog body", () => {
    const command = createNativeBlueprintRecipeOverrideIntentCommand(
      48,
      BINDING.blueprintId,
      BINDING.sourceRecipeId,
      TARGET_RECIPE_ID,
    );
    expect(command).toEqual({
      protocolVersion: 1,
      baseRevision: 48,
      topLevelChanges: [{
        path: ["blueprints", "intent"],
        operation: "set",
        value: {
          kind: "recipe-override",
          id: BINDING.blueprintId,
          sourceRecipeId: BINDING.sourceRecipeId,
          targetRecipeId: TARGET_RECIPE_ID,
        },
      }],
      changedEntities: [],
      addedEntities: [],
      removedEntityIds: [],
      changedBelts: [],
      addedBelts: [],
      removedBeltIds: [],
    });
    expect(JSON.stringify(command)).not.toMatch(
      /recipeOverrides|recipeOverrideGroups|blueprintVersions|constructionQueue|buildingId/,
    );
  });

  it("requires a writable safe revision and bounded opaque IDs", () => {
    expect(() => createNativeBlueprintRecipeOverrideIntentCommand(
      -1,
      "blueprint-a",
      "recipe-a",
      "recipe-b",
    )).toThrow();
    expect(() => createNativeBlueprintRecipeOverrideIntentCommand(
      Number.MAX_SAFE_INTEGER,
      "blueprint-a",
      "recipe-a",
      "recipe-b",
    )).toThrow();
    for (const [blueprintId, sourceRecipeId, targetRecipeId] of [
      ["", "recipe-a", "recipe-b"],
      ["blueprint-a", "bad\u0001recipe", "recipe-b"],
      ["blueprint-a", "recipe-a", "x".repeat(513)],
      ["blueprint-a", "recipe-a", "\ud800"],
    ]) {
      expect(() => createNativeBlueprintRecipeOverrideIntentCommand(
        0,
        blueprintId,
        sourceRecipeId,
        targetRecipeId,
      )).toThrow();
    }
  });

  it("rechecks the selected supported group and current command revision before dispatch", () => {
    const command = prepareNativeBlueprintRecipeOverrideIntentCommand(
      BINDING,
      TARGET_RECIPE_ID,
      frame(),
      { sessionId: "session-a", runId: "run-a", baseRevision: 48 },
    );
    expect(command?.baseRevision).toBe(48);
    expect(command?.topLevelChanges).toEqual([{
      path: ["blueprints", "intent"],
      operation: "set",
      value: {
        kind: "recipe-override",
        id: BINDING.blueprintId,
        sourceRecipeId: BINDING.sourceRecipeId,
        targetRecipeId: TARGET_RECIPE_ID,
      },
    }]);
  });

  it("rejects no-op, unlisted targets and lineage, registry, row or group drift", () => {
    const current = frame();
    const source = { sessionId: "session-a", runId: "run-a", baseRevision: 48 };
    expect(prepareNativeBlueprintRecipeOverrideIntentCommand(
      BINDING,
      BINDING.currentTargetRecipeId,
      current,
      source,
    )).toBeNull();
    expect(prepareNativeBlueprintRecipeOverrideIntentCommand(
      BINDING,
      "recipe:unlisted",
      current,
      source,
    )).toBeNull();
    expect(prepareNativeBlueprintRecipeOverrideIntentCommand(
      BINDING,
      TARGET_RECIPE_ID,
      frame({ selectedBlueprintId: null }),
      source,
    )).toBeNull();
    const changedRow = { ...current.library[0], revision: 5 };
    expect(prepareNativeBlueprintRecipeOverrideIntentCommand(
      BINDING,
      TARGET_RECIPE_ID,
      frame({ library: [changedRow], libraryById: new Map([[changedRow.id, changedRow]]) }),
      source,
    )).toBeNull();
    expect(prepareNativeBlueprintRecipeOverrideIntentCommand(
      BINDING,
      TARGET_RECIPE_ID,
      frame({ registryFingerprint: "registry-b" }),
      source,
    )).toBeNull();
    expect(prepareNativeBlueprintRecipeOverrideIntentCommand(
      BINDING,
      TARGET_RECIPE_ID,
      current,
      { ...source, runId: "run-b" },
    )).toBeNull();
    expect(prepareNativeBlueprintRecipeOverrideIntentCommand(
      BINDING,
      TARGET_RECIPE_ID,
      frame({ detail: null }),
      source,
    )).toBeNull();
  });
});
