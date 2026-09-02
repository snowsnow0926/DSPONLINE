import { describe, expect, it } from "vitest";
import {
  canonicalizeNativeBlueprintName,
  createNativeBlueprintRenameIntentCommand,
  prepareNativeBlueprintRenameIntentCommand,
} from "./nativeBlueprintRenameIntentCommands";
import type {
  NativeBlueprintRenameIdentity,
  NativeBlueprintWorkspaceFrame,
  NativeBlueprintWorkspaceIdentity,
} from "./nativeBlueprintWorkspaceStore";

const RENAME_IDENTITY: NativeBlueprintRenameIdentity = Object.freeze({
  sessionId: "session-a",
  runId: "run-a",
  registryFingerprint: "registry-a",
  blueprintId: "mod:opaque/rocket",
  currentName: "原名",
  currentRevision: 4,
});

function renameFrame(overrides: Partial<NativeBlueprintWorkspaceFrame> = {}): NativeBlueprintWorkspaceFrame {
  const row = Object.freeze({
    id: RENAME_IDENTITY.blueprintId,
    name: RENAME_IDENTITY.currentName,
    revision: RENAME_IDENTITY.currentRevision,
    rotation: 0 as const,
    mirror: "none" as const,
    counts: { entities: 0, belts: 0, resourceAnchors: 0, externalPorts: 0 },
    detailStatus: "candidate" as const,
  });
  return {
    source: "native-core",
    readOnly: true,
    sessionId: RENAME_IDENTITY.sessionId,
    runId: RENAME_IDENTITY.runId,
    revision: 48,
    registryFingerprint: RENAME_IDENTITY.registryFingerprint,
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

describe("native blueprint rename semantic intent", () => {
  it("emits one canonical kind/id/name marker and no blueprint body", () => {
    const command = createNativeBlueprintRenameIntentCommand(
      47,
      "mod:opaque/rocket",
      "新模组蓝图🚀",
    );
    expect(command).toEqual({
      protocolVersion: 1,
      baseRevision: 47,
      topLevelChanges: [{
        path: ["blueprints", "intent"],
        operation: "set",
        value: { kind: "rename", id: "mod:opaque/rocket", name: "新模组蓝图🚀" },
      }],
      changedEntities: [],
      addedEntities: [],
      removedEntityIds: [],
      changedBelts: [],
      addedBelts: [],
      removedBeltIds: [],
    });
    const encoded = JSON.stringify(command);
    expect(encoded).not.toContain('"entities":');
    expect(encoded).not.toContain('"belts":');
    expect(encoded).not.toMatch(/blueprintVersions|constructionQueue|patch/i);
  });

  it("canonicalizes Unicode whitespace and FEFF without splitting a surrogate pair", () => {
    expect(canonicalizeNativeBlueprintName(" \uFEFF  蓝图名  \uFEFF ")).toBe("蓝图名");
    expect(canonicalizeNativeBlueprintName(`${"a".repeat(30)}🚀`)).toBe(`${"a".repeat(30)}🚀`);
    expect(canonicalizeNativeBlueprintName(`${"a".repeat(31)}🚀`)).toBe("a".repeat(31));
    expect(canonicalizeNativeBlueprintName("🚀".repeat(17))).toBe("🚀".repeat(16));
    expect(canonicalizeNativeBlueprintName(`${"a".repeat(31)} x`)).toBe("a".repeat(31));
  });

  it("rejects malformed IDs, controls, empty names and noncanonical payloads", () => {
    expect(canonicalizeNativeBlueprintName("   \uFEFF ")).toBeNull();
    expect(canonicalizeNativeBlueprintName("控制\u0001字符")).toBeNull();
    expect(canonicalizeNativeBlueprintName("\ud800broken")).toBeNull();
    expect(() => createNativeBlueprintRenameIntentCommand(-1, "blueprint-a", "名字")).toThrow();
    expect(() => createNativeBlueprintRenameIntentCommand(0, "", "名字")).toThrow();
    expect(() => createNativeBlueprintRenameIntentCommand(0, "bad\u0001id", "名字")).toThrow();
    expect(() => createNativeBlueprintRenameIntentCommand(0, "x".repeat(513), "名字")).toThrow();
    expect(() => createNativeBlueprintRenameIntentCommand(0, "blueprint-a", " 名字")).toThrow();
    expect(() => createNativeBlueprintRenameIntentCommand(0, "blueprint-a", `${"a".repeat(31)}🚀`)).toThrow();
  });

  it("rebinds an editor opened at N to the exact current N+1 command revision", () => {
    const frame = renameFrame();
    const route: NativeBlueprintWorkspaceIdentity = Object.freeze({
      sessionId: frame.sessionId,
      runId: frame.runId,
      revision: frame.revision,
      registryFingerprint: frame.registryFingerprint,
    });
    const command = prepareNativeBlueprintRenameIntentCommand(
      RENAME_IDENTITY,
      "新名",
      frame,
      route,
      { sessionId: frame.sessionId, runId: frame.runId, baseRevision: frame.revision },
    );
    expect(command?.baseRevision).toBe(48);
    expect(command?.topLevelChanges).toEqual([{
      path: ["blueprints", "intent"],
      operation: "set",
      value: { kind: "rename", id: RENAME_IDENTITY.blueprintId, name: "新名" },
    }]);
  });

  it("rejects lineage, target-row, route, source, and name drift at the current-frame gate", () => {
    const frame = renameFrame();
    const route: NativeBlueprintWorkspaceIdentity = Object.freeze({
      sessionId: frame.sessionId,
      runId: frame.runId,
      revision: frame.revision,
      registryFingerprint: frame.registryFingerprint,
    });
    const source = { sessionId: frame.sessionId, runId: frame.runId, baseRevision: frame.revision };
    const changedRow = { ...frame.library[0], name: "他处已改名", revision: 5 };
    const rowDriftFrame = renameFrame({
      library: [changedRow],
      libraryById: new Map([[changedRow.id, changedRow]]),
    });
    expect(prepareNativeBlueprintRenameIntentCommand(
      { ...RENAME_IDENTITY, runId: "other-run" }, "新名", frame, route, source,
    )).toBeNull();
    expect(prepareNativeBlueprintRenameIntentCommand(
      RENAME_IDENTITY, "新名", rowDriftFrame, route, source,
    )).toBeNull();
    expect(prepareNativeBlueprintRenameIntentCommand(
      RENAME_IDENTITY, "新名", frame, { ...route, revision: 49 }, source,
    )).toBeNull();
    expect(prepareNativeBlueprintRenameIntentCommand(
      RENAME_IDENTITY, "新名", frame, route, { ...source, baseRevision: 49 },
    )).toBeNull();
    expect(prepareNativeBlueprintRenameIntentCommand(
      RENAME_IDENTITY, " 新名", frame, route, source,
    )).toBeNull();
  });
});
