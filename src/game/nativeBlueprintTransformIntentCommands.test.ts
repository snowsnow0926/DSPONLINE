import { describe, expect, it } from "vitest";

import {
  createNativeBlueprintTransformIntentCommand,
  prepareNativeBlueprintTransformIntentCommand,
} from "./nativeBlueprintTransformIntentCommands";
import type {
  NativeBlueprintTransformBinding,
  NativeBlueprintWorkspaceFrame,
} from "./nativeBlueprintWorkspaceStore";

const BINDING: NativeBlueprintTransformBinding = Object.freeze({
  sessionId: "session-a",
  runId: "run-a",
  revision: 48,
  registryFingerprint: "registry-a",
  blueprintId: "mod:opaque/rocket",
  currentRowRevision: 4,
  currentRotation: 90,
  currentMirror: "horizontal",
});

function frame(
  overrides: Partial<NativeBlueprintWorkspaceFrame> = {},
): NativeBlueprintWorkspaceFrame {
  const row = Object.freeze({
    id: BINDING.blueprintId,
    name: "不透明 MOD 蓝图",
    revision: BINDING.currentRowRevision,
    rotation: BINDING.currentRotation,
    mirror: BINDING.currentMirror,
    counts: { entities: 9_999, belts: 9_999, resourceAnchors: 0, externalPorts: 0 },
    detailStatus: "truncated" as const,
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
    detail: null,
    queue: [],
    queuePage: { cursor: 0, totalCount: 0, nextCursor: null },
    ...overrides,
  };
}

describe("native blueprint target-state transform intent", () => {
  it("emits one exact four-key marker and no blueprint body", () => {
    const command = createNativeBlueprintTransformIntentCommand(
      48,
      BINDING.blueprintId,
      270,
      "none",
    );
    expect(command).toEqual({
      protocolVersion: 1,
      baseRevision: 48,
      topLevelChanges: [{
        path: ["blueprints", "intent"],
        operation: "set",
        value: {
          kind: "transform",
          id: BINDING.blueprintId,
          rotation: 270,
          mirror: "none",
        },
      }],
      changedEntities: [],
      addedEntities: [],
      removedEntityIds: [],
      changedBelts: [],
      addedBelts: [],
      removedBeltIds: [],
    });
    expect(JSON.stringify(command)).not.toMatch(/entities":|belts":|blueprintVersions|constructionQueue/);
  });

  it("requires explicit finite target enums and an opaque bounded ID", () => {
    expect(() => createNativeBlueprintTransformIntentCommand(-1, "blueprint-a", 90, "none")).toThrow();
    expect(() => createNativeBlueprintTransformIntentCommand(
      Number.MAX_SAFE_INTEGER,
      "blueprint-a",
      90,
      "none",
    )).toThrow();
    expect(() => createNativeBlueprintTransformIntentCommand(0, "", 90, "none")).toThrow();
    expect(() => createNativeBlueprintTransformIntentCommand(0, "bad\u0001id", 90, "none")).toThrow();
    expect(() => createNativeBlueprintTransformIntentCommand(
      0,
      "x".repeat(513),
      90,
      "none",
    )).toThrow();
    expect(() => createNativeBlueprintTransformIntentCommand(
      0,
      "blueprint-a",
      45 as 90,
      "none",
    )).toThrow();
    expect(() => createNativeBlueprintTransformIntentCommand(
      0,
      "blueprint-a",
      90,
      "vertical" as "none",
    )).toThrow();
  });

  it("accepts a selected opaque/truncated row and binds the current command revision", () => {
    const current = frame();
    const command = prepareNativeBlueprintTransformIntentCommand(
      BINDING,
      180,
      "horizontal",
      current,
      { sessionId: "session-a", runId: "run-a", baseRevision: 48 },
    );
    expect(command?.baseRevision).toBe(48);
    expect(command?.topLevelChanges[0]).toEqual({
      path: ["blueprints", "intent"],
      operation: "set",
      value: {
        kind: "transform",
        id: BINDING.blueprintId,
        rotation: 180,
        mirror: "horizontal",
      },
    });
  });

  it("rejects no-op, selection, row, frame, registry and source drift", () => {
    const current = frame();
    const source = { sessionId: "session-a", runId: "run-a", baseRevision: 48 };
    expect(prepareNativeBlueprintTransformIntentCommand(
      BINDING,
      90,
      "horizontal",
      current,
      source,
    )).toBeNull();
    expect(prepareNativeBlueprintTransformIntentCommand(
      BINDING,
      180,
      "horizontal",
      frame({ selectedBlueprintId: null }),
      source,
    )).toBeNull();
    const changed = { ...current.library[0], revision: 5, rotation: 180 as const };
    expect(prepareNativeBlueprintTransformIntentCommand(
      BINDING,
      180,
      "horizontal",
      frame({ library: [changed], libraryById: new Map([[changed.id, changed]]) }),
      source,
    )).toBeNull();
    expect(prepareNativeBlueprintTransformIntentCommand(
      BINDING,
      180,
      "horizontal",
      frame({ revision: 49 }),
      source,
    )).toBeNull();
    expect(prepareNativeBlueprintTransformIntentCommand(
      BINDING,
      180,
      "horizontal",
      frame({ registryFingerprint: "registry-b" }),
      source,
    )).toBeNull();
    expect(prepareNativeBlueprintTransformIntentCommand(
      BINDING,
      180,
      "horizontal",
      current,
      { ...source, baseRevision: 49 },
    )).toBeNull();
  });
});
