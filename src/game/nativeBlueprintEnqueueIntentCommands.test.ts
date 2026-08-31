import { describe, expect, it } from "vitest";

import type { NativeBlueprintEnqueueContext } from "./nativeBlueprintEnqueueContext";
import {
  createNativeBlueprintEnqueueIntentCommand,
  prepareNativeBlueprintEnqueueIntentCommand,
} from "./nativeBlueprintEnqueueIntentCommands";

const CONTEXT: NativeBlueprintEnqueueContext = Object.freeze({
  sessionId: "session-enqueue",
  runId: "run-enqueue",
  schemaVersion: 1,
  projectionType: "blueprint-enqueue-context-v1",
  source: "native-core",
  revision: 73,
  stateVersion: 47,
  registryFingerprint: "builtin-v47",
  request: Object.freeze({
    expectedRevision: 73,
    expectedRegistryFingerprint: "builtin-v47",
    blueprintId: "mod:opaque/rocket",
    blueprintRevision: 4,
  }),
  activePlanetId: "planet:mediterranean/primary",
  support: Object.freeze({ supported: true, reason: null }),
  expectedQueueId: "construction_314",
  limits: Object.freeze({ projectionBytes: 1_048_576 }),
});

describe("native blueprint enqueue intent", () => {
  it("emits one exact queue-only marker and strips every Rust-owned field", () => {
    const rendererPosition = {
      x: 480.5,
      y: -128.25,
      planetId: "renderer-planet",
      rotation: 270,
      mirror: "horizontal",
      allowOverlap: true,
    };
    const command = createNativeBlueprintEnqueueIntentCommand(
      CONTEXT,
      rendererPosition,
    );

    expect(command).toEqual({
      protocolVersion: 1,
      baseRevision: 73,
      topLevelChanges: [{
        path: ["constructionQueue", "intent"],
        operation: "set",
        value: {
          kind: "enqueue",
          blueprintId: CONTEXT.request.blueprintId,
          blueprintRevision: CONTEXT.request.blueprintRevision,
          position: { x: 480.5, y: -128.25 },
          revision: 73,
        },
      }],
      changedEntities: [],
      addedEntities: [],
      removedEntityIds: [],
      changedBelts: [],
      addedBelts: [],
      removedBeltIds: [],
    });
    expect(command.topLevelChanges).toHaveLength(1);
    expect(command.topLevelChanges[0]?.operation).toBe("set");
    expect(command.topLevelChanges[0]?.value).toHaveProperty("position", {
      x: 480.5,
      y: -128.25,
    });
    expect(command.topLevelChanges[0]?.value).not.toHaveProperty("planetId");
    expect(JSON.stringify(command)).not.toMatch(
      /activePlanetId|planetName|expectedQueueId|construction_314|rotation|mirror|versionId|blueprintVersions|body|materialLedger|allowOverlap|insertionIndex|registryFingerprint|sessionId|runId/,
    );
  });

  it.each([
    { x: Number.NaN, y: 0 },
    { x: 0, y: Number.POSITIVE_INFINITY },
    { x: Number.NEGATIVE_INFINITY, y: 0 },
  ])("rejects non-finite renderer coordinates: %j", (position) => {
    expect(() => createNativeBlueprintEnqueueIntentCommand(CONTEXT, position)).toThrow(TypeError);
    expect(prepareNativeBlueprintEnqueueIntentCommand(CONTEXT, position, {
      sessionId: CONTEXT.sessionId,
      runId: CONTEXT.runId,
      baseRevision: CONTEXT.revision,
    })).toBeNull();
  });

  it("prepares only when session, run, and base revision align with the click-time proof", () => {
    const source = {
      sessionId: CONTEXT.sessionId,
      runId: CONTEXT.runId,
      baseRevision: CONTEXT.revision,
    };
    expect(prepareNativeBlueprintEnqueueIntentCommand(
      CONTEXT,
      { x: 10, y: 20 },
      source,
    )).toEqual(createNativeBlueprintEnqueueIntentCommand(CONTEXT, { x: 10, y: 20 }));

    expect(prepareNativeBlueprintEnqueueIntentCommand(
      CONTEXT,
      { x: 10, y: 20 },
      null,
    )).toBeNull();
    expect(prepareNativeBlueprintEnqueueIntentCommand(
      CONTEXT,
      { x: 10, y: 20 },
      { ...source, sessionId: "session-other" },
    )).toBeNull();
    expect(prepareNativeBlueprintEnqueueIntentCommand(
      CONTEXT,
      { x: 10, y: 20 },
      { ...source, runId: "run-other" },
    )).toBeNull();
    expect(prepareNativeBlueprintEnqueueIntentCommand(
      CONTEXT,
      { x: 10, y: 20 },
      { ...source, baseRevision: CONTEXT.revision + 1 },
    )).toBeNull();
  });

  it.each([
    ["unsupported context", {
      ...CONTEXT,
      support: { supported: false, reason: "queue-full" },
      expectedQueueId: null,
    }],
    ["terminal global revision", {
      ...CONTEXT,
      revision: Number.MAX_SAFE_INTEGER,
      request: {
        ...CONTEXT.request,
        expectedRevision: Number.MAX_SAFE_INTEGER,
      },
    }],
    ["unsafe expected queue ID", {
      ...CONTEXT,
      expectedQueueId: "construction_9007199254740991",
    }],
    ["non-native source", { ...CONTEXT, source: "renderer" }],
    ["request revision drift", {
      ...CONTEXT,
      request: { ...CONTEXT.request, expectedRevision: CONTEXT.revision - 1 },
    }],
    ["extra authority field", { ...CONTEXT, planetId: CONTEXT.activePlanetId }],
  ] satisfies readonly (readonly [string, unknown])[])(
    "rejects a malformed or non-writable %s",
    (_label, value) => {
      const context = value as NativeBlueprintEnqueueContext;
      expect(() => createNativeBlueprintEnqueueIntentCommand(context, { x: 1, y: 2 }))
        .toThrow(TypeError);
      expect(prepareNativeBlueprintEnqueueIntentCommand(context, { x: 1, y: 2 }, {
        sessionId: CONTEXT.sessionId,
        runId: CONTEXT.runId,
        baseRevision: context.revision,
      })).toBeNull();
    },
  );
});
