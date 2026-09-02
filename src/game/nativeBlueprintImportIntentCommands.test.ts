import { describe, expect, it } from "vitest";

import type { NativeBlueprintImportContext } from "./nativeBlueprintImportContext";
import {
  createNativeBlueprintImportIntentCommand,
  prepareNativeBlueprintImportIntentCommand,
} from "./nativeBlueprintImportIntentCommands";
import { SIMULATION_RUNTIME_PROTOCOL_VERSION } from "./simulationRuntimeProtocol";

function context(): NativeBlueprintImportContext {
  return {
    sessionId: "session-1",
    runId: "run-1",
    schemaVersion: 1,
    projectionType: "blueprint-import-context-v1",
    source: "native-core",
    revision: 8,
    stateVersion: 47,
    registryFingerprint: "registry-a",
    request: {
      expectedRevision: 8,
      expectedRegistryFingerprint: "registry-a",
      rawBytes: 2,
      rawSha256: "b".repeat(64),
    },
    activePlanetId: "planet-a",
    support: { supported: true, reason: null },
    preparedIntent: {
      kind: "import",
      sourceName: "蓝图",
      blueprint: {
        id: "blueprint_41",
        name: "蓝图 09",
        revision: 1,
        entities: [],
        resourceAnchors: [],
        belts: [],
        externalPorts: [],
        rotation: 0,
        mirror: "none",
        recipeOverrides: {},
      },
      blueprintSha256: "a".repeat(64),
      revision: 8,
    },
    limits: {
      rawBytes: 1_048_576,
      projectionBytes: 1_048_576,
      commandBytes: 1_048_576,
      libraryRows: 64,
      blueprintEntities: 512,
      blueprintBelts: 1_024,
    },
  };
}

describe("native blueprint import intent", () => {
  it("writes one Rust-prepared marker without raw text or renderer-derived state", () => {
    const command = createNativeBlueprintImportIntentCommand(context());
    expect(command).toEqual({
      protocolVersion: SIMULATION_RUNTIME_PROTOCOL_VERSION,
      baseRevision: 8,
      topLevelChanges: [{
        path: ["blueprints", "intent"],
        operation: "set",
        value: context().preparedIntent,
      }],
      changedEntities: [],
      addedEntities: [],
      removedEntityIds: [],
      changedBelts: [],
      addedBelts: [],
      removedBeltIds: [],
    });
    const serialized = JSON.stringify(command);
    expect(serialized).not.toContain("rawSha256");
    expect(serialized).not.toContain("rawBytes");
    expect(serialized).not.toContain("inventory");
    expect(serialized).not.toContain("nextId");
  });

  it("requires exact source lineage and revision", () => {
    expect(prepareNativeBlueprintImportIntentCommand(context(), {
      sessionId: "session-1",
      runId: "run-1",
      baseRevision: 8,
    })).not.toBeNull();
    expect(prepareNativeBlueprintImportIntentCommand(context(), {
      sessionId: "session-1",
      runId: "run-2",
      baseRevision: 8,
    })).toBeNull();
    expect(prepareNativeBlueprintImportIntentCommand(context(), {
      sessionId: "session-1",
      runId: "run-1",
      baseRevision: 9,
    })).toBeNull();
  });

  it("rejects unsupported and forged prepared markers", () => {
    expect(() => createNativeBlueprintImportIntentCommand({
      ...context(),
      support: { supported: false, reason: "invalid-exchange" },
      preparedIntent: null,
    })).toThrow();
    expect(() => createNativeBlueprintImportIntentCommand({
      ...context(),
      preparedIntent: { ...context().preparedIntent!, inventory: {} } as never,
    })).toThrow();
  });
});
