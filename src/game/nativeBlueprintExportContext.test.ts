import { describe, expect, it, vi } from "vitest";

import { sha256Text } from "./payloadDigest";
import {
  readVerifiedNativeBlueprintExportContext,
  type NativeBlueprintExportBinding,
} from "./nativeBlueprintExportContext";

const rawExchange = "{\"type\":\"dsp-idle-blueprint\",\"formatVersion\":2,\"blueprint\":{}}";

function binding(overrides: Partial<NativeBlueprintExportBinding> = {}): NativeBlueprintExportBinding {
  return {
    sessionId: "session-1",
    runId: "run-1",
    revision: 8,
    registryFingerprint: "registry-a",
    blueprintId: "blueprint_41",
    blueprintName: "蓝图 09",
    blueprintRevision: 1,
    ...overrides,
  };
}

async function result(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    projectionType: "blueprint-export-context-v1",
    source: "native-core",
    revision: 8,
    stateVersion: 47,
    registryFingerprint: "registry-a",
    request: {
      expectedRevision: 8,
      expectedRegistryFingerprint: "registry-a",
      blueprintId: "blueprint_41",
      blueprintRevision: 1,
    },
    activePlanetId: "planet-a",
    support: { supported: true, reason: null },
    rawExchange,
    rawBytes: new TextEncoder().encode(rawExchange).byteLength,
    rawSha256: await sha256Text(rawExchange),
    blueprintName: "蓝图 09",
    fileNameStem: "蓝图 09",
    limits: {
      exchangeBytes: 1_048_576,
      projectionBytes: 1_048_576,
      blueprintEntities: 512,
      blueprintBelts: 1_024,
    },
    ...overrides,
  };
}

describe("native blueprint export context", () => {
  it("performs one bound read and returns the exact verified Rust exchange", async () => {
    const reader = vi.fn(async () => result());
    const context = await readVerifiedNativeBlueprintExportContext(
      { getNativeCoreBlueprintExportContext: reader },
      binding(),
    );
    expect(reader).toHaveBeenCalledOnce();
    expect(reader).toHaveBeenCalledWith({
      sessionId: "session-1",
      expectedRevision: 8,
      expectedRegistryFingerprint: "registry-a",
      blueprintId: "blueprint_41",
      blueprintRevision: 1,
    });
    expect(context?.rawExchange).toBe(rawExchange);
    expect(context?.rawSha256).toBe(await sha256Text(rawExchange));
    expect(Object.isFrozen(context)).toBe(true);
  });

  it("accepts max-safe read identities without attempting R+1 mutation", async () => {
    const maximum = Number.MAX_SAFE_INTEGER;
    const value = await result({
      revision: maximum,
      request: {
        expectedRevision: maximum,
        expectedRegistryFingerprint: "registry-a",
        blueprintId: "blueprint_41",
        blueprintRevision: maximum,
      },
    });
    const reader = vi.fn(async () => value);
    await expect(readVerifiedNativeBlueprintExportContext(
      { getNativeCoreBlueprintExportContext: reader },
      binding({ revision: maximum, blueprintRevision: maximum }),
    )).resolves.toMatchObject({ revision: maximum });
    expect(reader).toHaveBeenCalledOnce();
  });

  it.each([
    "version-conflict",
    "unsupported-active-planet",
    "unsupported-blueprint-domain",
    "catalog-incomplete",
    "position-overlap",
    "serialized-budget-exceeded",
  ] as const)("preserves unsupported reason %s and requires all payload fields null", async (reason) => {
    const value = await result({
      support: { supported: false, reason },
      rawExchange: null,
      rawBytes: null,
      rawSha256: null,
      blueprintName: null,
      fileNameStem: null,
    });
    await expect(readVerifiedNativeBlueprintExportContext(
      { getNativeCoreBlueprintExportContext: async () => value },
      binding(),
    )).resolves.toMatchObject({ support: { supported: false, reason } });
  });

  it("rejects digest, row, extra-field, reserved-name and unsupported payload drift", async () => {
    const base = await result();
    const invalid = [
      { ...base, rawSha256: "b".repeat(64) },
      { ...base, rawBytes: 1 },
      { ...base, request: { ...base.request, blueprintRevision: 2 } },
      { ...base, fileNameStem: "CON.txt" },
      { ...base, hidden: true },
      { ...base, support: { supported: false, reason: "catalog-incomplete" } },
    ];
    for (const value of invalid) {
      await expect(readVerifiedNativeBlueprintExportContext(
        { getNativeCoreBlueprintExportContext: async () => value },
        binding(),
      )).resolves.toBeNull();
    }
  });

  it("rejects every Win32 ASCII and superscript device alias before export", async () => {
    const reserved = [
      "CON", "PRN.json", "AUX.backup.json", "NUL",
      "COM1", "com9.json", "LPT1", "lpt9.json",
      "COM¹", "com².json", "COM³.backup.json",
      "LPT¹", "lpt².json", "LPT³.backup.json",
      "COM1 .json", "LPT¹ .json",
    ];
    for (const fileNameStem of reserved) {
      await expect(readVerifiedNativeBlueprintExportContext(
        { getNativeCoreBlueprintExportContext: async () => result({ fileNameStem }) },
        binding(),
      ), fileNameStem).resolves.toBeNull();
    }
  });

  it("fails closed on missing capability or rejected bridge", async () => {
    await expect(readVerifiedNativeBlueprintExportContext(null, binding())).resolves.toBeNull();
    await expect(readVerifiedNativeBlueprintExportContext(
      { getNativeCoreBlueprintExportContext: async () => { throw new Error("offline"); } },
      binding(),
    )).resolves.toBeNull();
  });
});
