import { describe, expect, it } from "vitest";

import type { NativeBlueprintCaptureContext } from "./nativeBlueprintCaptureContext";
import {
  createNativeBlueprintCaptureIntentCommand,
  prepareNativeBlueprintCaptureIntentCommand,
} from "./nativeBlueprintCaptureIntentCommands";
import { SIMULATION_RUNTIME_PROTOCOL_VERSION } from "./simulationRuntimeProtocol";

const CONTEXT: NativeBlueprintCaptureContext = Object.freeze({
  sessionId: "session-a",
  runId: "run-a",
  schemaVersion: 1,
  projectionType: "blueprint-capture-context-v1",
  source: "native-core",
  revision: 47,
  stateVersion: 47,
  registryFingerprint: "builtin:test",
  request: Object.freeze({
    expectedRevision: 47,
    expectedRegistryFingerprint: "builtin:test",
    entityIds: Object.freeze(["entity-z", "实体-β", "entity-a"]),
  }),
  activePlanetId: "planet-home",
  support: Object.freeze({ supported: true, reason: null }),
  expectedBlueprintId: "blueprint_17",
  expectedBlueprintName: "蓝图 08",
  expectedBlueprintRevision: 1,
  limits: Object.freeze({
    selectionEntityIds: 512,
    blueprintEntities: 512,
    blueprintBelts: 1_024,
    opaqueIdBytes: 512,
    projectionBytes: 1_048_576,
  }),
});

describe("native blueprint capture intent", () => {
  it("emits one exact durable marker with no entity or inventory body", () => {
    const command = createNativeBlueprintCaptureIntentCommand(CONTEXT);
    expect(command).toEqual({
      protocolVersion: SIMULATION_RUNTIME_PROTOCOL_VERSION,
      baseRevision: 47,
      topLevelChanges: [{
        path: ["blueprints", "intent"],
        operation: "set",
        value: {
          kind: "capture",
          entityIds: ["entity-z", "实体-β", "entity-a"],
          revision: 47,
        },
      }],
      changedEntities: [],
      addedEntities: [],
      removedEntityIds: [],
      changedBelts: [],
      addedBelts: [],
      removedBeltIds: [],
    });
    const body = JSON.stringify(command);
    for (const forbidden of ["planetId", "inventory", "entities", "belts", "nextId", "blueprintId"]) {
      expect(body).not.toContain(`"${forbidden}"`);
    }
  });

  it("requires exact source lineage and revision", () => {
    expect(prepareNativeBlueprintCaptureIntentCommand(CONTEXT, {
      sessionId: "session-a", runId: "run-a", baseRevision: 47,
    })).toEqual(createNativeBlueprintCaptureIntentCommand(CONTEXT));
    expect(prepareNativeBlueprintCaptureIntentCommand(CONTEXT, null)).toBeNull();
    expect(prepareNativeBlueprintCaptureIntentCommand(CONTEXT, {
      sessionId: "other", runId: "run-a", baseRevision: 47,
    })).toBeNull();
    expect(prepareNativeBlueprintCaptureIntentCommand(CONTEXT, {
      sessionId: "session-a", runId: "run-a", baseRevision: 48,
    })).toBeNull();
  });

  it("rejects unsupported or forged context", () => {
    expect(() => createNativeBlueprintCaptureIntentCommand({
      ...CONTEXT,
      support: { supported: false, reason: "library-full" },
      expectedBlueprintId: null,
      expectedBlueprintName: null,
      expectedBlueprintRevision: null,
    })).toThrow(TypeError);
    expect(() => createNativeBlueprintCaptureIntentCommand({
      ...CONTEXT,
      request: { ...CONTEXT.request, entityIds: ["entity-a", "entity-a"] },
    })).toThrow(TypeError);
    expect(() => createNativeBlueprintCaptureIntentCommand({
      ...CONTEXT,
      request: { ...CONTEXT.request, entityIds: ["entity-a"], inventory: {} } as never,
    })).toThrow(TypeError);
  });
});
