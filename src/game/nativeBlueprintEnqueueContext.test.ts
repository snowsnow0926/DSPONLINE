import { describe, expect, it, vi } from "vitest";

import type {
  DesktopNativeCoreBlueprintEnqueueContextResult,
  DesktopNativeCoreBlueprintEnqueueUnsupportedReason,
} from "../desktop";
import {
  nativeBlueprintEnqueueContextSupportsCommand,
  readVerifiedNativeBlueprintEnqueueContext,
} from "./nativeBlueprintEnqueueContext";
import type {
  NativeBlueprintEnqueueSelectionBinding,
  NativeBlueprintWorkspaceIdentity,
} from "./nativeBlueprintWorkspaceStore";

const IDENTITY: NativeBlueprintWorkspaceIdentity = Object.freeze({
  sessionId: "session-enqueue",
  runId: "run-enqueue",
  revision: 73,
  registryFingerprint: "builtin-v47",
});

// This binding may have been captured from an earlier workspace frame. It has
// no global revision by design; click-time authority comes from IDENTITY.
const EARLIER_SELECTION: NativeBlueprintEnqueueSelectionBinding = Object.freeze({
  sessionId: "session-enqueue",
  runId: "run-enqueue",
  registryFingerprint: "builtin-v47",
  blueprintId: "mod:opaque/rocket",
  blueprintName: "跨帧蓝图",
  currentRowRevision: 4,
});

function rawContext(
  overrides: Partial<DesktopNativeCoreBlueprintEnqueueContextResult> = {},
): DesktopNativeCoreBlueprintEnqueueContextResult {
  return {
    schemaVersion: 1,
    projectionType: "blueprint-enqueue-context-v1",
    source: "native-core",
    revision: IDENTITY.revision,
    stateVersion: 47,
    registryFingerprint: IDENTITY.registryFingerprint,
    request: {
      expectedRevision: IDENTITY.revision,
      expectedRegistryFingerprint: IDENTITY.registryFingerprint,
      blueprintId: EARLIER_SELECTION.blueprintId,
      blueprintRevision: EARLIER_SELECTION.currentRowRevision,
    },
    activePlanetId: "planet:mediterranean/primary",
    support: { supported: true, reason: null },
    expectedQueueId: "construction_314",
    limits: { projectionBytes: 1_048_576 },
    ...overrides,
  };
}

async function read(
  value: unknown,
  identity = IDENTITY,
  selection = EARLIER_SELECTION,
) {
  return readVerifiedNativeBlueprintEnqueueContext(
    { getNativeCoreBlueprintEnqueueContext: async () => value as never },
    identity,
    selection,
  );
}

describe("native blueprint enqueue context", () => {
  it("reads an exact click-time proof using the latest revision and an older stable row selection", async () => {
    const value = rawContext();
    const reader = vi.fn(async () => value);
    const result = await readVerifiedNativeBlueprintEnqueueContext(
      { getNativeCoreBlueprintEnqueueContext: reader },
      IDENTITY,
      EARLIER_SELECTION,
    );

    expect("revision" in EARLIER_SELECTION).toBe(false);
    expect(reader).toHaveBeenCalledOnce();
    expect(reader).toHaveBeenCalledWith({
      sessionId: IDENTITY.sessionId,
      expectedRevision: 73,
      expectedRegistryFingerprint: IDENTITY.registryFingerprint,
      blueprintId: EARLIER_SELECTION.blueprintId,
      blueprintRevision: EARLIER_SELECTION.currentRowRevision,
    });
    expect(result).toEqual({
      sessionId: IDENTITY.sessionId,
      runId: IDENTITY.runId,
      ...value,
    });
    expect(result).not.toBe(value);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result?.request)).toBe(true);
    expect(Object.isFrozen(result?.support)).toBe(true);
    expect(Object.isFrozen(result?.limits)).toBe(true);
    expect(nativeBlueprintEnqueueContextSupportsCommand(result)).toBe(true);
  });

  it.each([
    ["session", { ...EARLIER_SELECTION, sessionId: "session-other" }],
    ["run", { ...EARLIER_SELECTION, runId: "run-other" }],
    ["registry", { ...EARLIER_SELECTION, registryFingerprint: "registry-other" }],
  ] satisfies readonly (readonly [string, NativeBlueprintEnqueueSelectionBinding])[])(
    "rejects a selection with mismatched %s lineage before IPC",
    async (_label, selection) => {
      const reader = vi.fn(async () => rawContext());
      expect(await readVerifiedNativeBlueprintEnqueueContext(
        { getNativeCoreBlueprintEnqueueContext: reader },
        IDENTITY,
        selection,
      )).toBeNull();
      expect(reader).not.toHaveBeenCalled();
    },
  );

  it("fails closed when the bridge is absent, throws, or receives an invalid identity", async () => {
    expect(await readVerifiedNativeBlueprintEnqueueContext(
      null,
      IDENTITY,
      EARLIER_SELECTION,
    )).toBeNull();
    expect(await readVerifiedNativeBlueprintEnqueueContext(
      { getNativeCoreBlueprintEnqueueContext: async () => {
        throw new Error("transport lost");
      } },
      IDENTITY,
      EARLIER_SELECTION,
    )).toBeNull();
    const reader = vi.fn(async () => rawContext());
    expect(await readVerifiedNativeBlueprintEnqueueContext(
      { getNativeCoreBlueprintEnqueueContext: reader },
      { ...IDENTITY, registryFingerprint: "bad fingerprint" },
      EARLIER_SELECTION,
    )).toBeNull();
    expect(reader).not.toHaveBeenCalled();
  });

  it.each([
    ["stale projection revision", rawContext({ revision: 72 })],
    ["different projection registry", rawContext({ registryFingerprint: "builtin-v48" })],
    ["wrong echoed revision", rawContext({
      request: { ...rawContext().request, expectedRevision: 72 },
    })],
    ["wrong echoed registry", rawContext({
      request: { ...rawContext().request, expectedRegistryFingerprint: "builtin-v48" },
    })],
    ["wrong echoed blueprint", rawContext({
      request: { ...rawContext().request, blueprintId: "blueprint-other" },
    })],
    ["wrong echoed row revision", rawContext({
      request: { ...rawContext().request, blueprintRevision: 5 },
    })],
    ["extra raw field", { ...rawContext(), sessionId: IDENTITY.sessionId }],
    ["extra request field", {
      ...rawContext(),
      request: { ...rawContext().request, sessionId: IDENTITY.sessionId },
    }],
    ["extra support field", {
      ...rawContext(),
      support: { supported: true, reason: null, queueLength: 1 },
    }],
    ["extra limits field", {
      ...rawContext(),
      limits: { projectionBytes: 1_048_576, queueRows: 4_096 },
    }],
    ["missing exact field", (() => {
      const { limits: _limits, ...value } = rawContext();
      return value;
    })()],
    ["wrong projection type", { ...rawContext(), projectionType: "blueprint-workspace-v1" }],
    ["wrong state version", { ...rawContext(), stateVersion: 48 }],
    ["invalid active planet", { ...rawContext(), activePlanetId: "planet\u0000hidden" }],
  ] satisfies readonly (readonly [string, unknown])[])(
    "rejects %s instead of accepting a partially matching proof",
    async (_label, value) => {
      expect(await read(value)).toBeNull();
    },
  );

  it.each([
    "queue-full",
    "next-id-exhausted",
    "queue-id-collision",
    "unsupported-blueprint-domain",
    "unsupported-active-planet",
    "unsupported-existing-queue-domain",
    "version-conflict",
  ] satisfies readonly DesktopNativeCoreBlueprintEnqueueUnsupportedReason[])(
    "preserves the explicit unsupported reason %s but does not make it writable",
    async (reason) => {
      const result = await read(rawContext({
        support: { supported: false, reason },
        expectedQueueId: null,
      }));
      expect(result?.support).toEqual({ supported: false, reason });
      expect(result?.expectedQueueId).toBeNull();
      expect(nativeBlueprintEnqueueContextSupportsCommand(result)).toBe(false);
    },
  );

  it.each([
    ["supported proof with a reason", {
      support: { supported: true, reason: "queue-full" },
      expectedQueueId: "construction_314",
    }],
    ["unsupported proof without a reason", {
      support: { supported: false, reason: null },
      expectedQueueId: null,
    }],
    ["unsupported proof with a queue ID", {
      support: { supported: false, reason: "queue-full" },
      expectedQueueId: "construction_314",
    }],
    ["unknown unsupported reason", {
      support: { supported: false, reason: "renderer-decided" },
      expectedQueueId: null,
    }],
  ] satisfies readonly (readonly [string, {
    support: { supported: boolean; reason: unknown };
    expectedQueueId: string | null;
  }])[])("rejects an inconsistent support contract: %s", async (_label, overrides) => {
    expect(await read(rawContext(overrides as never))).toBeNull();
  });

  it.each([
    "construction_0",
    "construction_1",
    "construction_9007199254740990",
  ])("accepts the safe canonical expected queue ID %s", async (expectedQueueId) => {
    const result = await read(rawContext({ expectedQueueId }));
    expect(result?.expectedQueueId).toBe(expectedQueueId);
    expect(nativeBlueprintEnqueueContextSupportsCommand(result)).toBe(true);
  });

  it.each([
    "construction_",
    "construction_01",
    "construction_-1",
    "construction_1.0",
    "construction_1e2",
    "construction_9007199254740991",
    "construction_9007199254740992",
    "queue_314",
  ])("rejects the unsafe or non-canonical expected queue ID %s", async (expectedQueueId) => {
    expect(await read(rawContext({ expectedQueueId }))).toBeNull();
  });

  it("keeps a terminal authority revision readable but never command-capable", async () => {
    const identity = { ...IDENTITY, revision: Number.MAX_SAFE_INTEGER };
    const value = rawContext({
      revision: Number.MAX_SAFE_INTEGER,
      request: {
        ...rawContext().request,
        expectedRevision: Number.MAX_SAFE_INTEGER,
      },
    });
    const result = await read(value, identity);
    expect(result?.revision).toBe(Number.MAX_SAFE_INTEGER);
    expect(nativeBlueprintEnqueueContextSupportsCommand(result)).toBe(false);
  });
});
