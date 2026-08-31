import { describe, expect, it } from "vitest";

import type { NativeBlueprintDirectDeployContext } from "./nativeBlueprintDirectDeployContext";
import {
  createNativeBlueprintDirectDeployIntentCommand,
  prepareNativeBlueprintDirectDeployIntentCommand,
} from "./nativeBlueprintDirectDeployIntentCommands";
import { SIMULATION_RUNTIME_PROTOCOL_VERSION } from "./simulationRuntimeProtocol";

const CONTEXT: NativeBlueprintDirectDeployContext = Object.freeze({
  sessionId: "session-a",
  runId: "run-a",
  schemaVersion: 1,
  projectionType: "blueprint-direct-deploy-context-v1",
  source: "native-core",
  revision: 47,
  stateVersion: 47,
  registryFingerprint: "builtin:test",
  request: Object.freeze({
    expectedRevision: 47,
    expectedRegistryFingerprint: "builtin:test",
    blueprintId: "ordinary-alpha",
    blueprintRevision: 3,
    position: Object.freeze({ x: 20.25, y: -30.5 }),
  }),
  activePlanetId: "planet-home",
  support: Object.freeze({ supported: true, reason: null }),
  limits: Object.freeze({ projectionBytes: 1_048_576 }),
});

describe("native blueprint direct deploy intent", () => {
  it("emits only one exact durable semantic marker", () => {
    expect(createNativeBlueprintDirectDeployIntentCommand(CONTEXT)).toEqual({
      protocolVersion: SIMULATION_RUNTIME_PROTOCOL_VERSION,
      baseRevision: 47,
      topLevelChanges: [{
        path: ["constructionQueue", "intent"],
        operation: "set",
        value: {
          kind: "direct-deploy",
          blueprintId: "ordinary-alpha",
          blueprintRevision: 3,
          position: { x: 20.25, y: -30.5 },
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
    const body = JSON.stringify(createNativeBlueprintDirectDeployIntentCommand(CONTEXT));
    for (const forbidden of ["planetId", "activePlanetId", "inventory", "entities", "belts", "nextId", "rotation", "mirror"]) {
      expect(body).not.toContain(`\"${forbidden}\"`);
    }
  });

  it("requires exact session/run/revision source binding", () => {
    expect(prepareNativeBlueprintDirectDeployIntentCommand(CONTEXT, {
      sessionId: "session-a",
      runId: "run-a",
      baseRevision: 47,
    })).toEqual(createNativeBlueprintDirectDeployIntentCommand(CONTEXT));
    expect(prepareNativeBlueprintDirectDeployIntentCommand(CONTEXT, null)).toBeNull();
    expect(prepareNativeBlueprintDirectDeployIntentCommand(CONTEXT, {
      sessionId: "other", runId: "run-a", baseRevision: 47,
    })).toBeNull();
    expect(prepareNativeBlueprintDirectDeployIntentCommand(CONTEXT, {
      sessionId: "session-a", runId: "other", baseRevision: 47,
    })).toBeNull();
    expect(prepareNativeBlueprintDirectDeployIntentCommand(CONTEXT, {
      sessionId: "session-a", runId: "run-a", baseRevision: 48,
    })).toBeNull();
  });

  it("fails closed for unsupported or forged position context", () => {
    expect(() => createNativeBlueprintDirectDeployIntentCommand({
      ...CONTEXT,
      support: { supported: false, reason: "position-overlap" },
    })).toThrow(TypeError);
    expect(() => createNativeBlueprintDirectDeployIntentCommand({
      ...CONTEXT,
      request: { ...CONTEXT.request, position: { x: Number.NaN, y: 2 } },
    })).toThrow(TypeError);
    expect(() => createNativeBlueprintDirectDeployIntentCommand({
      ...CONTEXT,
      request: { ...CONTEXT.request, position: { x: 1, y: 2 }, planetId: "forged" } as never,
    })).toThrow(TypeError);
  });
});
