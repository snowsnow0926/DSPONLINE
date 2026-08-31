import { describe, expect, it, vi } from "vitest";

import type { DesktopNativeCoreBlueprintCaptureContextResult } from "../desktop";
import {
  nativeBlueprintCaptureContextSupportsCommand,
  readVerifiedNativeBlueprintCaptureContext,
  type NativeBlueprintCaptureSelectionBinding,
} from "./nativeBlueprintCaptureContext";
import type { NativeBlueprintWorkspaceIdentity } from "./nativeBlueprintWorkspaceStore";

const IDENTITY: NativeBlueprintWorkspaceIdentity = Object.freeze({
  sessionId: "session-a",
  runId: "run-a",
  revision: 47,
  registryFingerprint: "builtin:test",
});
const SELECTION: NativeBlueprintCaptureSelectionBinding = Object.freeze({
  ...IDENTITY,
  activePlanetId: "planet-home",
  entityIds: Object.freeze(["entity-z", "实体-β", "entity-a"]),
});

function projection(
  overrides: Partial<DesktopNativeCoreBlueprintCaptureContextResult> = {},
): DesktopNativeCoreBlueprintCaptureContextResult {
  return {
    schemaVersion: 1,
    projectionType: "blueprint-capture-context-v1",
    source: "native-core",
    revision: 47,
    stateVersion: 47,
    registryFingerprint: "builtin:test",
    request: {
      expectedRevision: 47,
      expectedRegistryFingerprint: "builtin:test",
      entityIds: ["entity-z", "实体-β", "entity-a"],
    },
    activePlanetId: "planet-home",
    support: { supported: true, reason: null },
    expectedBlueprintId: "blueprint_17",
    expectedBlueprintName: "蓝图 08",
    expectedBlueprintRevision: 1,
    limits: {
      selectionEntityIds: 512,
      blueprintEntities: 512,
      blueprintBelts: 1_024,
      opaqueIdBytes: 512,
      projectionBytes: 1_048_576,
    },
    ...overrides,
  };
}

async function read(value: unknown) {
  return readVerifiedNativeBlueprintCaptureContext(
    { getNativeCoreBlueprintCaptureContext: async () => value },
    IDENTITY,
    SELECTION,
  );
}

describe("native blueprint capture context", () => {
  it("sends only same-revision identity and preserves ordered entity IDs", async () => {
    const reader = vi.fn().mockResolvedValue(projection());
    const result = await readVerifiedNativeBlueprintCaptureContext(
      { getNativeCoreBlueprintCaptureContext: reader },
      IDENTITY,
      SELECTION,
    );
    expect(reader).toHaveBeenCalledWith({
      sessionId: "session-a",
      expectedRevision: 47,
      expectedRegistryFingerprint: "builtin:test",
      entityIds: ["entity-z", "实体-β", "entity-a"],
    });
    expect(result).toEqual({ sessionId: "session-a", runId: "run-a", ...projection() });
    expect(nativeBlueprintCaptureContextSupportsCommand(result)).toBe(true);
    expect(Object.isFrozen(result?.request.entityIds)).toBe(true);
  });

  it.each([
    ["missing bridge", null, SELECTION],
    ["session drift", projection(), { ...SELECTION, sessionId: "other" }],
    ["run drift", projection(), { ...SELECTION, runId: "other" }],
    ["revision drift", projection(), { ...SELECTION, revision: 48 }],
    ["planet invalid", projection(), { ...SELECTION, activePlanetId: "bad\nplanet" }],
    ["duplicate selection", projection(), { ...SELECTION, entityIds: ["entity-a", "entity-a"] }],
  ] as const)("rejects %s before accepting a proof", async (_label, value, selection) => {
    const bridge = value === null ? null : { getNativeCoreBlueprintCaptureContext: async () => value };
    expect(await readVerifiedNativeBlueprintCaptureContext(
      bridge,
      IDENTITY,
      selection as NativeBlueprintCaptureSelectionBinding,
    )).toBeNull();
  });

  it.each([
    ["revision", { revision: 48 }],
    ["planet", { activePlanetId: "planet-other" }],
    ["reordered IDs", { request: { ...projection().request, entityIds: ["entity-a", "实体-β", "entity-z"] } }],
    ["extra entity body", { entities: [] }],
    ["bad expected ID", { expectedBlueprintId: "blueprint_017" }],
    ["bad name", { expectedBlueprintName: "Blueprint 08" }],
    ["bad row revision", { expectedBlueprintRevision: 2 }],
    ["wrong limit", { limits: { ...projection().limits, blueprintBelts: 1_023 } }],
  ] as const)("rejects %s drift or derived state", async (_label, overrides) => {
    expect(await read({ ...projection(), ...overrides })).toBeNull();
  });

  it.each([
    "selection-conflict",
    "unsupported-active-planet",
    "unsupported-blueprint-domain",
    "catalog-incomplete",
    "position-overlap",
    "library-full",
    "next-id-exhausted",
  ] as const)("preserves structured unsupported reason %s without dispatchability", async (reason) => {
    const result = await read(projection({
      support: { supported: false, reason },
      expectedBlueprintId: null,
      expectedBlueprintName: null,
      expectedBlueprintRevision: null,
    }));
    expect(result?.support).toEqual({ supported: false, reason });
    expect(nativeBlueprintCaptureContextSupportsCommand(result)).toBe(false);
  });

  it("rejects unknown reason, partial expected identity, bridge errors and over-budget body", async () => {
    expect(await read(projection({
      support: { supported: false, reason: "version-conflict" as never },
      expectedBlueprintId: null,
      expectedBlueprintName: null,
      expectedBlueprintRevision: null,
    }))).toBeNull();
    expect(await read(projection({
      support: { supported: false, reason: "library-full" },
      expectedBlueprintName: null,
      expectedBlueprintRevision: null,
    }))).toBeNull();
    expect(await readVerifiedNativeBlueprintCaptureContext(
      { getNativeCoreBlueprintCaptureContext: async () => { throw new Error("offline"); } },
      IDENTITY,
      SELECTION,
    )).toBeNull();
    expect(await read({ ...projection(), activePlanetId: "x".repeat(1_048_576) })).toBeNull();
  });
});
