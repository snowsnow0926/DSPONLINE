import { describe, expect, it, vi } from "vitest";

import { sha256Text } from "./payloadDigest";
import {
  nativeBlueprintImportContextSupportsCommand,
  readVerifiedNativeBlueprintImportContext,
  type NativeBlueprintImportContextBridge,
} from "./nativeBlueprintImportContext";

const identity = {
  sessionId: "session-1",
  runId: "run-1",
  revision: 8,
  registryFingerprint: "registry-a",
} as const;
const raw = "{\"schemaVersion\":2,\"name\":\"蓝图\"}";

function preparedIntent(extraBlueprint: Record<string, unknown> = {}) {
  return {
    kind: "import",
    sourceName: "蓝图",
    blueprint: {
      id: "blueprint_41",
      name: "蓝图 09",
      revision: 1,
      entities: [{
        key: "entity-a",
        buildingId: "assembler_mk1",
        offset: { x: 0, y: 1 },
        machineCount: 2,
        recipeId: "gear",
      }],
      resourceAnchors: [],
      belts: [{
        key: "belt-a",
        sourceKey: "entity-a",
        targetKey: "entity-a",
        itemId: "gear",
        lanes: 1,
        tier: 1,
        priority: 0,
      }],
      externalPorts: [],
      rotation: 0,
      mirror: "none",
      recipeOverrides: {},
      ...extraBlueprint,
    },
    blueprintSha256: "a".repeat(64),
    revision: 8,
  };
}

async function result(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    projectionType: "blueprint-import-context-v1",
    source: "native-core",
    revision: 8,
    stateVersion: 47,
    registryFingerprint: "registry-a",
    request: {
      expectedRevision: 8,
      expectedRegistryFingerprint: "registry-a",
      rawBytes: new TextEncoder().encode(raw).byteLength,
      rawSha256: await sha256Text(raw),
    },
    activePlanetId: "planet-a",
    support: { supported: true, reason: null },
    preparedIntent: preparedIntent(),
    limits: {
      rawBytes: 1_048_576,
      projectionBytes: 1_048_576,
      commandBytes: 1_048_576,
      libraryRows: 64,
      blueprintEntities: 512,
      blueprintBelts: 1_024,
    },
    ...overrides,
  };
}

describe("native blueprint import context", () => {
  it("sends the raw exchange only to Rust and returns a frozen opaque prepared marker", async () => {
    const reader = vi.fn(async () => result());
    const context = await readVerifiedNativeBlueprintImportContext(
      { getNativeCoreBlueprintImportContext: reader },
      identity,
      raw,
    );
    expect(reader).toHaveBeenCalledWith({
      sessionId: "session-1",
      expectedRevision: 8,
      expectedRegistryFingerprint: "registry-a",
      raw,
    });
    expect(context?.request.rawSha256).toBe(await sha256Text(raw));
    expect(context?.preparedIntent?.blueprint.id).toBe("blueprint_41");
    expect(nativeBlueprintImportContextSupportsCommand(context)).toBe(true);
    expect(Object.isFrozen(context?.preparedIntent?.blueprint.entities[0])).toBe(true);
    expect(JSON.stringify(context)).not.toContain(raw);
  });

  it.each([
    "invalid-exchange",
    "unsupported-active-planet",
    "unsupported-blueprint-domain",
    "catalog-incomplete",
    "position-overlap",
    "library-full",
    "next-id-exhausted",
    "serialized-budget-exceeded",
  ] as const)("preserves unsupported reason %s without making it dispatchable", async (reason) => {
    const value = await result({
      support: { supported: false, reason },
      preparedIntent: null,
    });
    const context = await readVerifiedNativeBlueprintImportContext(
      { getNativeCoreBlueprintImportContext: async () => value },
      identity,
      raw,
    );
    expect(context?.support).toEqual({ supported: false, reason });
    expect(nativeBlueprintImportContextSupportsCommand(context)).toBe(false);
  });

  it("rejects digest drift, hidden marker fields, unknown reasons, and wrong limits", async () => {
    const values = [
      await result({ request: { ...(await result()).request, rawSha256: "b".repeat(64) } }),
      await result({ preparedIntent: { ...preparedIntent(), inventory: {} } }),
      await result({ preparedIntent: preparedIntent({ hidden: true }) }),
      await result({ support: { supported: false, reason: "surprise" }, preparedIntent: null }),
      await result({ limits: { ...(await result()).limits, blueprintEntities: 256 } }),
      { ...(await result()), extra: true },
    ];
    for (const value of values) {
      await expect(readVerifiedNativeBlueprintImportContext(
        { getNativeCoreBlueprintImportContext: async () => value },
        identity,
        raw,
      )).resolves.toBeNull();
    }
  });

  it("rejects missing capability, stale identity, lone surrogate and oversized raw before IPC", async () => {
    const reader = vi.fn(async () => result());
    await expect(readVerifiedNativeBlueprintImportContext(null, identity, raw)).resolves.toBeNull();
    await expect(readVerifiedNativeBlueprintImportContext(
      { getNativeCoreBlueprintImportContext: reader },
      { ...identity, revision: 9 },
      raw,
    )).resolves.toBeNull();
    expect(reader).toHaveBeenCalledTimes(1);
    reader.mockClear();
    await expect(readVerifiedNativeBlueprintImportContext(
      { getNativeCoreBlueprintImportContext: reader },
      identity,
      "{\"x\":\"\ud800\"}",
    )).resolves.toBeNull();
    await expect(readVerifiedNativeBlueprintImportContext(
      { getNativeCoreBlueprintImportContext: reader },
      identity,
      "x".repeat(1_048_577),
    )).resolves.toBeNull();
    expect(reader).not.toHaveBeenCalled();
  });

  it("fails closed when the bridge rejects", async () => {
    const bridge: NativeBlueprintImportContextBridge = {
      getNativeCoreBlueprintImportContext: async () => { throw new Error("missing"); },
    };
    await expect(readVerifiedNativeBlueprintImportContext(bridge, identity, raw)).resolves.toBeNull();
  });
});
