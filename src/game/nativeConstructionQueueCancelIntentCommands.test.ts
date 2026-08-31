import { describe, expect, it } from "vitest";

import {
  createNativeConstructionQueueCancelIntentCommand,
  prepareNativeConstructionQueueCancelIntentCommand,
} from "./nativeConstructionQueueCancelIntentCommands";
import type {
  NativeBlueprintWorkspaceFrame,
  NativeConstructionQueueCancelBinding,
} from "./nativeBlueprintWorkspaceStore";

const BINDING: NativeConstructionQueueCancelBinding = Object.freeze({
  sessionId: "session-1",
  runId: "run-1",
  revision: 48,
  registryFingerprint: "registry-a",
  queueEntryId: "queue:opaque/1",
  queueTotalCount: 2,
});

function frame(binding = BINDING): NativeBlueprintWorkspaceFrame {
  const row = {
    id: binding.queueEntryId,
    blueprintId: "blueprint-a",
    blueprintVersionId: "version-a",
    blueprintRevision: 1,
    blueprintName: "测试蓝图",
    planetId: "planet-a",
    planetName: "母星",
    position: { x: 1, y: 2 },
    rotation: 0 as const,
    mirror: "none" as const,
    queuedAt: 10,
    status: "pending-materials" as const,
    counts: { entities: 1, belts: 0, resourceAnchors: 0, externalPorts: 0 },
    semanticStatus: "catalog-backed" as const,
    reservedConstructionTotal: 3,
    reservedFleetTotal: 2,
    placedEntityCount: 0,
    actionable: false as const,
  };
  return {
    source: "native-core",
    readOnly: true,
    sessionId: binding.sessionId,
    runId: binding.runId,
    revision: binding.revision,
    registryFingerprint: binding.registryFingerprint,
    selectedBlueprintId: null,
    library: [],
    libraryById: new Map(),
    libraryPage: { cursor: 0, totalCount: 0, nextCursor: null },
    detail: null,
    queue: [row],
    queuePage: { cursor: 0, totalCount: binding.queueTotalCount, nextCursor: null },
  };
}

describe("native construction queue cancel intent", () => {
  it("emits only stable queue ID plus expected authority revision", () => {
    const command = createNativeConstructionQueueCancelIntentCommand(48, BINDING.queueEntryId);
    expect(command).toEqual({
      protocolVersion: 1,
      baseRevision: 48,
      topLevelChanges: [{
        path: ["constructionQueue", "intent"],
        operation: "set",
        value: { kind: "cancel", id: BINDING.queueEntryId, revision: 48 },
      }],
      changedEntities: [],
      addedEntities: [],
      removedEntityIds: [],
      changedBelts: [],
      addedBelts: [],
      removedBeltIds: [],
    });
    expect(JSON.stringify(command)).not.toMatch(
      /reservedConstruction|reservedFleet|portableFleet|blueprintVersions|entities":|belts":/,
    );
  });

  it("fails closed at revision, ID, frame row, count, and source boundaries", () => {
    expect(() => createNativeConstructionQueueCancelIntentCommand(
      Number.MAX_SAFE_INTEGER,
      "queue-a",
    )).toThrow();
    expect(() => createNativeConstructionQueueCancelIntentCommand(0, "")).toThrow();
    expect(() => createNativeConstructionQueueCancelIntentCommand(0, "bad\u0001id")).toThrow();
    expect(() => createNativeConstructionQueueCancelIntentCommand(0, "x".repeat(513))).toThrow();
    expect(() => createNativeConstructionQueueCancelIntentCommand(0, "\ud800")).toThrow();

    const source = { sessionId: "session-1", runId: "run-1", baseRevision: 48 };
    expect(prepareNativeConstructionQueueCancelIntentCommand(BINDING, frame(), source))
      .toEqual(createNativeConstructionQueueCancelIntentCommand(48, BINDING.queueEntryId));
    expect(prepareNativeConstructionQueueCancelIntentCommand(
      { ...BINDING, queueEntryId: "missing" }, frame(), source,
    )).toBeNull();
    expect(prepareNativeConstructionQueueCancelIntentCommand(
      { ...BINDING, queueTotalCount: 3 }, frame(), source,
    )).toBeNull();
    expect(prepareNativeConstructionQueueCancelIntentCommand(
      BINDING, frame(), { ...source, baseRevision: 49 },
    )).toBeNull();
    expect(prepareNativeConstructionQueueCancelIntentCommand(BINDING, {
      ...frame(),
      runId: "run-2",
    }, source)).toBeNull();
  });
});
