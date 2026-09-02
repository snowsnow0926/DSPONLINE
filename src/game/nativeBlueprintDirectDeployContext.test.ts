import { describe, expect, it, vi } from "vitest";

import type { DesktopNativeCoreBlueprintDirectDeployContextResult } from "../desktop";
import {
  nativeBlueprintDirectDeployContextSupportsCommand,
  readVerifiedNativeBlueprintDirectDeployContext,
} from "./nativeBlueprintDirectDeployContext";
import type {
  NativeBlueprintDirectDeploySelectionBinding,
  NativeBlueprintWorkspaceIdentity,
} from "./nativeBlueprintWorkspaceStore";

const IDENTITY: NativeBlueprintWorkspaceIdentity = Object.freeze({
  sessionId: "session-a",
  runId: "run-a",
  revision: 47,
  registryFingerprint: "builtin:test",
});
const SELECTION: NativeBlueprintDirectDeploySelectionBinding = Object.freeze({
  sessionId: "session-a",
  runId: "run-a",
  registryFingerprint: "builtin:test",
  blueprintId: "ordinary-alpha",
  blueprintName: "普通蓝图",
  currentRowRevision: 3,
});
const POSITION = Object.freeze({ x: 20.25, y: -30.5 });

function projection(
  overrides: Partial<DesktopNativeCoreBlueprintDirectDeployContextResult> = {},
): DesktopNativeCoreBlueprintDirectDeployContextResult {
  return {
    schemaVersion: 1,
    projectionType: "blueprint-direct-deploy-context-v1",
    source: "native-core",
    revision: 47,
    stateVersion: 47,
    registryFingerprint: "builtin:test",
    request: {
      expectedRevision: 47,
      expectedRegistryFingerprint: "builtin:test",
      blueprintId: "ordinary-alpha",
      blueprintRevision: 3,
      position: { x: 20.25, y: -30.5 },
    },
    activePlanetId: "planet-home",
    support: { supported: true, reason: null },
    limits: { projectionBytes: 1_048_576 },
    ...overrides,
  };
}

async function read(value: unknown) {
  return readVerifiedNativeBlueprintDirectDeployContext(
    { getNativeCoreBlueprintDirectDeployContext: async () => value },
    IDENTITY,
    SELECTION,
    POSITION,
  );
}

describe("native blueprint direct deploy context", () => {
  it("sends only session, exact row identity, revision, registry and finite click position", async () => {
    const reader = vi.fn().mockResolvedValue(projection());
    const result = await readVerifiedNativeBlueprintDirectDeployContext(
      { getNativeCoreBlueprintDirectDeployContext: reader },
      IDENTITY,
      SELECTION,
      POSITION,
    );
    expect(reader).toHaveBeenCalledOnce();
    expect(reader).toHaveBeenCalledWith({
      sessionId: "session-a",
      expectedRevision: 47,
      expectedRegistryFingerprint: "builtin:test",
      blueprintId: "ordinary-alpha",
      blueprintRevision: 3,
      position: { x: 20.25, y: -30.5 },
    });
    expect(result).toEqual({
      sessionId: "session-a",
      runId: "run-a",
      ...projection(),
    });
    expect(nativeBlueprintDirectDeployContextSupportsCommand(result)).toBe(true);
  });

  it.each([
    ["missing bridge", null, IDENTITY, SELECTION, POSITION],
    ["session drift", projection(), IDENTITY, { ...SELECTION, sessionId: "other" }, POSITION],
    ["run drift", projection(), IDENTITY, { ...SELECTION, runId: "other" }, POSITION],
    ["registry drift", projection(), IDENTITY, { ...SELECTION, registryFingerprint: "other" }, POSITION],
    ["bad row revision", projection(), IDENTITY, { ...SELECTION, currentRowRevision: 0 }, POSITION],
    ["non-finite x", projection(), IDENTITY, SELECTION, { x: Number.NaN, y: 2 }],
  ] as const)("rejects %s before accepting a proof", async (_label, value, identity, selection, position) => {
    const bridge = value === null ? null : { getNativeCoreBlueprintDirectDeployContext: async () => value };
    expect(await readVerifiedNativeBlueprintDirectDeployContext(
      bridge,
      identity as NativeBlueprintWorkspaceIdentity,
      selection as NativeBlueprintDirectDeploySelectionBinding,
      position,
    )).toBeNull();
  });

  it.each([
    ["revision", { revision: 48 }],
    ["registry", { registryFingerprint: "builtin:other" }],
    ["request revision", { request: { ...projection().request, expectedRevision: 46 } }],
    ["request row", { request: { ...projection().request, blueprintId: "other" } }],
    ["request position", { request: { ...projection().request, position: { x: 20, y: -30.5 } } }],
    ["position extra key", { request: { ...projection().request, position: { x: 20.25, y: -30.5, z: 1 } } }],
    ["extra derived state", { entities: [] }],
    ["wrong byte limit", { limits: { projectionBytes: 1_048_575 } }],
  ] as const)("rejects echoed %s drift or extra data", async (_label, override) => {
    expect(await read({ ...projection(), ...override })).toBeNull();
  });

  it.each([
    "next-id-exhausted",
    "unsupported-blueprint-domain",
    "unsupported-active-planet",
    "insufficient-construction-materials",
    "position-overlap",
    "version-conflict",
    "catalog-incomplete",
  ] as const)("preserves structured unsupported reason %s without making it dispatchable", async (reason) => {
    const result = await read(projection({ support: { supported: false, reason } }));
    expect(result?.support).toEqual({ supported: false, reason });
    expect(nativeBlueprintDirectDeployContextSupportsCommand(result)).toBe(false);
  });

  it("rejects unknown reason, invalid support binding, bridge rejection and over-budget body", async () => {
    expect(await read(projection({ support: { supported: false, reason: "queue-full" as never } })))
      .toBeNull();
    expect(await read(projection({ support: { supported: true, reason: "position-overlap" } })))
      .toBeNull();
    expect(await readVerifiedNativeBlueprintDirectDeployContext(
      { getNativeCoreBlueprintDirectDeployContext: async () => { throw new Error("offline"); } },
      IDENTITY,
      SELECTION,
      POSITION,
    )).toBeNull();
    expect(await read({
      ...projection(),
      activePlanetId: "x".repeat(1_048_576),
    })).toBeNull();
  });
});
