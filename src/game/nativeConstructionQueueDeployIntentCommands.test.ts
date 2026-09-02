import { describe, expect, it } from "vitest";

import {
  createNativeConstructionQueueDeployIntentCommand,
  prepareNativeConstructionQueueDeployIntentCommand,
} from "./nativeConstructionQueueDeployIntentCommands";
import {
  selectNativeConstructionQueueDeployBinding,
  type NativeBlueprintWorkspaceFrame,
} from "./nativeBlueprintWorkspaceStore";
import { SIMULATION_RUNTIME_PROTOCOL_VERSION } from "./simulationRuntimeProtocol";

function frame(overrides: Partial<NativeBlueprintWorkspaceFrame> = {}): NativeBlueprintWorkspaceFrame {
  const queue = Object.freeze([{
    id: "construction_7",
    blueprintId: "blueprint-a",
    blueprintVersionId: "blueprint-version-a",
    blueprintRevision: 3,
    blueprintName: "普通工厂",
    planetId: "planet-a",
    planetName: "行星 A",
    position: { x: 12, y: 18 },
    rotation: 0 as const,
    mirror: "none" as const,
    queuedAt: 100,
    status: "pending-materials" as const,
    counts: { entities: 2, belts: 1, resourceAnchors: 0, externalPorts: 0 },
    semanticStatus: "catalog-backed" as const,
    reservedConstructionTotal: 3,
    reservedFleetTotal: 0,
    placedEntityCount: 0,
    actionable: true,
  }]);
  return Object.freeze({
    sessionId: "session-a",
    runId: "run-a",
    revision: 47,
    registryFingerprint: "registry-a",
    source: "native-core" as const,
    readOnly: true as const,
    selectedBlueprintId: null,
    library: Object.freeze([]),
    libraryPage: Object.freeze({ cursor: 0, totalCount: 0, nextCursor: null }),
    libraryById: new Map(),
    detail: null,
    queue,
    queuePage: Object.freeze({ cursor: 0, totalCount: 1, nextCursor: null }),
    ...overrides,
  });
}

describe("native construction queue deploy intent", () => {
  it("emits one exact marker without blueprint, inventory, topology, or allocator data", () => {
    expect(createNativeConstructionQueueDeployIntentCommand(47, "construction_7")).toEqual({
      protocolVersion: SIMULATION_RUNTIME_PROTOCOL_VERSION,
      baseRevision: 47,
      topLevelChanges: [{
        path: ["constructionQueue", "intent"],
        operation: "set",
        value: { kind: "deploy", id: "construction_7", revision: 47 },
      }],
      changedEntities: [],
      addedEntities: [],
      removedEntityIds: [],
      changedBelts: [],
      addedBelts: [],
      removedBeltIds: [],
    });
  });

  it.each([
    [-1, "construction_7"],
    [Number.MAX_SAFE_INTEGER, "construction_7"],
    [47, ""],
    [47, "bad\nqueue"],
    [47, "x".repeat(513)],
    [47, "\ud800"],
  ])("rejects invalid revision or opaque queue identity", (revision, id) => {
    expect(() => createNativeConstructionQueueDeployIntentCommand(revision, id)).toThrow(TypeError);
  });

  it("prepares only an exact same-revision Rust-ready visible row", () => {
    const current = frame();
    const binding = selectNativeConstructionQueueDeployBinding(current, "construction_7")!;
    expect(binding).not.toBeNull();
    expect(prepareNativeConstructionQueueDeployIntentCommand(binding, current, {
      sessionId: "session-a",
      runId: "run-a",
      baseRevision: 47,
    })).toEqual(createNativeConstructionQueueDeployIntentCommand(47, "construction_7"));
    expect(prepareNativeConstructionQueueDeployIntentCommand(binding, {
      ...current,
      revision: 48,
    }, {
      sessionId: "session-a",
      runId: "run-a",
      baseRevision: 47,
    })).toBeNull();
    expect(prepareNativeConstructionQueueDeployIntentCommand(binding, {
      ...current,
      queuePage: { cursor: 32, totalCount: 33, nextCursor: null },
    }, {
      sessionId: "session-a",
      runId: "run-a",
      baseRevision: 47,
    })).toBeNull();
    expect(prepareNativeConstructionQueueDeployIntentCommand(binding, {
      ...current,
      queue: [{ ...current.queue[0], blueprintRevision: 4 }],
    }, {
      sessionId: "session-a",
      runId: "run-a",
      baseRevision: 47,
    })).toBeNull();
  });

  it.each([
    { actionable: false },
    { status: "waiting-fleet" as const },
    { semanticStatus: "unsupported" as const },
    { counts: null },
    { counts: { entities: 2, belts: 1, resourceAnchors: 1, externalPorts: 0 } },
    { counts: { entities: 0, belts: 1, resourceAnchors: 0, externalPorts: 0 } },
  ])("does not bind a row that Rust did not prove ordinary-deploy eligible", (rowOverride) => {
    const current = frame();
    const queue = Object.freeze([{ ...current.queue[0], ...rowOverride }]);
    expect(selectNativeConstructionQueueDeployBinding({ ...current, queue }, "construction_7")).toBeNull();
  });
});
