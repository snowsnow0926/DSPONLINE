import { describe, expect, it } from "vitest";

import type { DesktopNativeCoreProjectionTransferResult } from "../desktop";
import {
  advanceNativeCoreSegmented,
  decodeNativeCoreProjectionTransfer,
  partitionNativeAdvanceBudget,
} from "./nativeCore";

describe("Windows native core segmented advance", () => {
  it("preserves exact simulation and wall totals across cancellable boundaries", () => {
    const segments = partitionNativeAdvanceBudget(3_601, 901, 600);
    expect(segments).toHaveLength(7);
    expect(segments.slice(0, -1).every((segment) => segment.simulationSeconds === 600)).toBe(true);
    expect(segments.reduce((sum, segment) => sum + segment.simulationSeconds, 0)).toBe(3_601);
    expect(segments.reduce((sum, segment) => sum + segment.wallSeconds, 0)).toBe(901);
    expect(segments.at(-1)).toMatchObject({ simulationSeconds: 1 });
  });

  it("segments wall-only settlement and rejects unsafe budgets", () => {
    expect(partitionNativeAdvanceBudget(0, 1_201, 600)).toEqual([
      { simulationSeconds: 0, wallSeconds: 600 },
      { simulationSeconds: 0, wallSeconds: 600 },
      { simulationSeconds: 0, wallSeconds: 1 },
    ]);
    expect(() => partitionNativeAdvanceBudget(Number.NaN, 1)).toThrow(/预算无效/);
    expect(() => partitionNativeAdvanceBudget(1, 1, 0)).toThrow(/预算无效/);
  });

  it("cancels only after an acknowledged segment and reports the exact committed prefix", async () => {
    const controller = new AbortController();
    const requests: Array<{ baseRevision: number; simulationSeconds: number; wallSeconds: number }> = [];
    const result = await advanceNativeCoreSegmented(async (request) => {
      requests.push(request);
      return { supported: true, revision: request.baseRevision + 1 };
    }, {
      baseRevision: 7,
      simulationSeconds: 1_201,
      wallSeconds: 301,
      maxSegmentSeconds: 600,
      signal: controller.signal,
      onProgress: () => controller.abort(),
    });
    expect(requests).toHaveLength(1);
    expect(result).toEqual({
      supported: true,
      revision: 8,
      cancelled: true,
      advancedSimulationSeconds: 600,
      advancedWallSeconds: 301 * 600 / 1_201,
    });
  });

  it("stops at an unsupported boundary and rejects a non-advancing revision", async () => {
    let calls = 0;
    const unsupported = await advanceNativeCoreSegmented(async (request) => {
      calls += 1;
      return calls === 1
        ? { supported: true, revision: request.baseRevision + 1 }
        : { supported: false, revision: request.baseRevision, reason: "unsupported-test-domain" };
    }, { baseRevision: 3, simulationSeconds: 1_201, wallSeconds: 1_201, maxSegmentSeconds: 600 });
    expect(unsupported).toEqual({
      supported: false,
      revision: 4,
      cancelled: false,
      advancedSimulationSeconds: 600,
      advancedWallSeconds: 600,
      reason: "unsupported-test-domain",
    });
    await expect(advanceNativeCoreSegmented(async (request) => ({
      supported: true,
      revision: request.baseRevision,
    }), { baseRevision: 9, simulationSeconds: 1, wallSeconds: 1 })).rejects.toThrow(/不连续 revision/);
  });
});

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function transferFor(value: Record<string, unknown>): Promise<DesktopNativeCoreProjectionTransferResult> {
  const bodyBuffer = new TextEncoder().encode(JSON.stringify(value)).buffer;
  const sha256 = hex(new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bodyBuffer)));
  return {
    header: {
      schemaVersion: 1,
      sessionId: "core-1",
      revision: Number(value.revision),
      sequence: 9,
      projectionType: value.projectionType as "viewport-v1",
      payloadLength: bodyBuffer.byteLength,
      sha256,
    },
    bodyBuffer,
  };
}

describe("native core transferable projections", () => {
  it("verifies and decodes one bounded viewport block", async () => {
    const value = {
      schemaVersion: 1,
      projectionType: "viewport-v1",
      revision: 12,
      planetId: "home",
      bounds: { minX: 0, minY: 0, maxX: 10, maxY: 10 },
      base: {},
      entities: [],
      belts: [],
      nextEntityCursor: null,
      truncatedBelts: false,
    };
    await expect(decodeNativeCoreProjectionTransfer(await transferFor(value), {
      sessionId: "core-1",
      projectionType: "viewport-v1",
    })).resolves.toEqual(value);
  });

  it("rejects a corrupted payload before installing it", async () => {
    const transfer = await transferFor({
      schemaVersion: 1,
      projectionType: "viewport-v1",
      revision: 12,
    });
    new Uint8Array(transfer.bodyBuffer)[0] ^= 0xff;
    await expect(decodeNativeCoreProjectionTransfer(transfer, {
      sessionId: "core-1",
      projectionType: "viewport-v1",
    })).rejects.toThrow(/校验失败/);
  });

  it("rejects a mismatched session or revision identity", async () => {
    const transfer = await transferFor({
      schemaVersion: 1,
      projectionType: "viewport-v1",
      revision: 12,
    });
    await expect(decodeNativeCoreProjectionTransfer(transfer, {
      sessionId: "core-2",
      projectionType: "viewport-v1",
    })).rejects.toThrow(/边界无效/);
    transfer.header.revision = 13;
    await expect(decodeNativeCoreProjectionTransfer(transfer, {
      sessionId: "core-1",
      projectionType: "viewport-v1",
    })).rejects.toThrow(/正文身份无效/);
  });
});
