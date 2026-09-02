import { describe, expect, it } from "vitest";

import {
  createNativeBlueprintDeleteIntentCommand,
  prepareNativeBlueprintDeleteIntentCommand,
} from "./nativeBlueprintDeleteIntentCommands";
import type {
  NativeBlueprintDeleteBinding,
  NativeBlueprintWorkspaceFrame,
} from "./nativeBlueprintWorkspaceStore";

const BINDING: NativeBlueprintDeleteBinding = Object.freeze({
  sessionId: "session-1",
  runId: "run-1",
  revision: 48,
  registryFingerprint: "registry-a",
  blueprintId: "mod:opaque/rocket",
  currentRowRevision: 7,
  libraryTotalCount: 2,
});

function frame(binding = BINDING): NativeBlueprintWorkspaceFrame {
  const row = {
    id: binding.blueprintId,
    name: "不透明蓝图",
    revision: binding.currentRowRevision,
    rotation: 90 as const,
    mirror: "horizontal" as const,
    counts: { entities: 513, belts: 0, resourceAnchors: 0, externalPorts: 0 },
    detailStatus: "truncated" as const,
  };
  return {
    source: "native-core",
    readOnly: true,
    sessionId: binding.sessionId,
    runId: binding.runId,
    revision: binding.revision,
    registryFingerprint: binding.registryFingerprint,
    selectedBlueprintId: binding.blueprintId,
    library: [row],
    libraryById: new Map([[row.id, row]]),
    libraryPage: { cursor: 0, totalCount: binding.libraryTotalCount, nextCursor: null },
    detail: null,
    queue: [],
    queuePage: { cursor: 0, totalCount: 1, nextCursor: null },
  };
}

describe("native blueprint compare-and-delete intent", () => {
  it("emits only the exact current-row marker", () => {
    const command = createNativeBlueprintDeleteIntentCommand(48, BINDING.blueprintId, 7);
    expect(command).toEqual({
      protocolVersion: 1,
      baseRevision: 48,
      topLevelChanges: [{
        path: ["blueprints", "intent"],
        operation: "set",
        value: { kind: "delete", id: BINDING.blueprintId, revision: 7 },
      }],
      changedEntities: [],
      addedEntities: [],
      removedEntityIds: [],
      changedBelts: [],
      addedBelts: [],
      removedBeltIds: [],
    });
    expect(JSON.stringify(command)).not.toMatch(/blueprintVersions|constructionQueue|entities":|belts":/);
  });

  it("fails closed at global revision, row revision, ID, and Unicode boundaries", () => {
    expect(() => createNativeBlueprintDeleteIntentCommand(Number.MAX_SAFE_INTEGER, "blueprint-a", 1))
      .toThrow();
    expect(() => createNativeBlueprintDeleteIntentCommand(0, "blueprint-a", 0)).toThrow();
    expect(() => createNativeBlueprintDeleteIntentCommand(0, "blueprint-a", Number.MAX_SAFE_INTEGER))
      .not.toThrow();
    expect(() => createNativeBlueprintDeleteIntentCommand(0, "", 1)).toThrow();
    expect(() => createNativeBlueprintDeleteIntentCommand(0, "bad\u0001id", 1)).toThrow();
    expect(() => createNativeBlueprintDeleteIntentCommand(0, "x".repeat(513), 1)).toThrow();
    expect(() => createNativeBlueprintDeleteIntentCommand(0, "\ud800", 1)).toThrow();
  });

  it("prepares only from the exact selected row and command source", () => {
    expect(prepareNativeBlueprintDeleteIntentCommand(BINDING, frame(), {
      sessionId: BINDING.sessionId,
      runId: BINDING.runId,
      baseRevision: BINDING.revision,
    })).toEqual(createNativeBlueprintDeleteIntentCommand(48, BINDING.blueprintId, 7));

    expect(prepareNativeBlueprintDeleteIntentCommand(
      { ...BINDING, currentRowRevision: 8 },
      frame(),
      { sessionId: BINDING.sessionId, runId: BINDING.runId, baseRevision: BINDING.revision },
    )).toBeNull();
    expect(prepareNativeBlueprintDeleteIntentCommand(
      { ...BINDING, libraryTotalCount: 3 },
      frame(),
      { sessionId: BINDING.sessionId, runId: BINDING.runId, baseRevision: BINDING.revision },
    )).toBeNull();
    expect(prepareNativeBlueprintDeleteIntentCommand(BINDING, {
      ...frame(),
      selectedBlueprintId: null,
      detail: null,
    }, { sessionId: BINDING.sessionId, runId: BINDING.runId, baseRevision: BINDING.revision }))
      .toBeNull();
    expect(prepareNativeBlueprintDeleteIntentCommand(BINDING, frame(), {
      sessionId: BINDING.sessionId,
      runId: BINDING.runId,
      baseRevision: BINDING.revision + 1,
    })).toBeNull();
  });
});
