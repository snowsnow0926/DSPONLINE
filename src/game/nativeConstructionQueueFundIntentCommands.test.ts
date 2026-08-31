import { describe, expect, it } from "vitest";

import {
  createNativeConstructionQueueFundIntentCommand,
  prepareNativeConstructionQueueFundIntentCommand,
} from "./nativeConstructionQueueFundIntentCommands";
import type {
  NativeBlueprintWorkspaceFrame,
  NativeConstructionQueueFundBinding,
} from "./nativeBlueprintWorkspaceStore";

const BINDING: NativeConstructionQueueFundBinding = Object.freeze({
  sessionId: "session-1",
  runId: "run-1",
  revision: 48,
  registryFingerprint: "registry-a",
  queueEntryId: "queue:opaque/1",
  queueTotalCount: 2,
  queuePageCursor: 0,
  initialStatus: "pending-materials",
  initialReservedConstructionTotal: 3,
  initialReservedFleetTotal: 2,
});

function frame(): NativeBlueprintWorkspaceFrame {
  const row = {
    id: BINDING.queueEntryId,
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
    sessionId: BINDING.sessionId,
    runId: BINDING.runId,
    revision: BINDING.revision,
    registryFingerprint: BINDING.registryFingerprint,
    selectedBlueprintId: null,
    library: [],
    libraryById: new Map(),
    libraryPage: { cursor: 0, totalCount: 0, nextCursor: null },
    detail: null,
    queue: [row],
    queuePage: { cursor: 0, totalCount: BINDING.queueTotalCount, nextCursor: null },
  };
}

describe("native construction queue fund intent", () => {
  it("emits one exact marker without renderer-derived inventories", () => {
    const command = createNativeConstructionQueueFundIntentCommand(48, BINDING.queueEntryId, "all");
    expect(command).toEqual({
      protocolVersion: 1,
      baseRevision: 48,
      topLevelChanges: [{
        path: ["constructionQueue", "intent"],
        operation: "set",
        value: { kind: "fund", id: BINDING.queueEntryId, scope: "all", revision: 48 },
      }],
      changedEntities: [],
      addedEntities: [],
      removedEntityIds: [],
      changedBelts: [],
      addedBelts: [],
      removedBeltIds: [],
    });
    expect(JSON.stringify(command)).not.toMatch(/reservedConstruction|reservedFleet|construction":|portableFleet/);
  });

  it("fails closed for stale visible rows, sources, and invalid scopes", () => {
    const source = { sessionId: "session-1", runId: "run-1", baseRevision: 48 };
    expect(prepareNativeConstructionQueueFundIntentCommand(BINDING, "construction", frame(), source))
      .toEqual(createNativeConstructionQueueFundIntentCommand(48, BINDING.queueEntryId, "construction"));
    expect(prepareNativeConstructionQueueFundIntentCommand(
      { ...BINDING, initialReservedConstructionTotal: 4 }, "all", frame(), source,
    )).toBeNull();
    expect(prepareNativeConstructionQueueFundIntentCommand(
      BINDING, "all", { ...frame(), queuePage: { cursor: 32, totalCount: 2, nextCursor: null } }, source,
    )).toBeNull();
    expect(prepareNativeConstructionQueueFundIntentCommand(
      BINDING, "all", frame(), { ...source, baseRevision: 49 },
    )).toBeNull();
    expect(() => createNativeConstructionQueueFundIntentCommand(48, BINDING.queueEntryId, "bad" as "all"))
      .toThrow();
  });
});

