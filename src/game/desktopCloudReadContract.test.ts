import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopBridge } from "../desktop";
import { downloadCloudSave } from "./cloud";
import { computeSaveStateChecksum } from "./saveEnvelopeIntegrity";

const require = createRequire(import.meta.url);
const { normalizeTransferRequestHeaders } = require("../../desktop/cloud-transport.cjs");
const { inspectHttpRequest } = require("../../server/http-security.mjs");
const { bodyCapabilityForRoute } = require("../../server/http-route-policy.mjs");

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("Windows cloud download through renderer and main-process header policy", () => {
  for (const scenario of [
    { slot: "main", mode: "normal", revision: undefined },
    { slot: "main", mode: "normal", revision: 7 },
    { slot: "1", mode: "normal", revision: undefined },
    { slot: "2", mode: "speedrun", revision: 3 },
  ] as const) {
    it(`downloads ${scenario.mode}/${scenario.slot}/${scenario.revision ?? "current"} with a local-only IPC ID`, async () => {
      const requests: Array<{ method: string; path: string; requestId: string; rendererHeaders: Record<string, string>; headers: Record<string, string> }> = [];
      const state = { version: 47, mode: scenario.mode, entities: [], research: { completedTechIds: [] } };
      const payload = JSON.stringify({
        formatVersion: 2, kind: scenario.slot === "main" ? "primary" : "slot", slot: scenario.slot,
        mode: scenario.mode, savedAt: 1, state, checksum: computeSaveStateChecksum(2, state),
      });
      const requestApiTransfer: DesktopBridge["requestApiTransfer"] = async request => {
        const headers = normalizeTransferRequestHeaders(request);
        requests.push({ method: request.method ?? "GET", path: request.path, requestId: request.requestId, rendererHeaders: request.headers ?? {}, headers });
        const capability = bodyCapabilityForRoute(request.method, `/api${request.path.split("?")[0]}`);
        try {
          inspectHttpRequest({ method: request.method, headers }, { bodyCapability: capability });
        } catch (error) {
          const failure = error as { code: string; message: string };
          return {
            ok: false, status: 400, headers: { "content-type": "application/json" },
            bodyBuffer: new TextEncoder().encode(JSON.stringify({ code: failure.code, error: failure.message })).buffer,
          };
        }
        return {
          ok: true, status: 200, headers: { "content-type": "application/json" },
          bodyBuffer: new TextEncoder().encode(JSON.stringify({ cloudSave: {
            slot: scenario.slot, mode: scenario.mode, revision: scenario.revision ?? 8,
            updatedAt: 1, size: payload.length, checksum: "isolated-fixture", summary: null, payload,
          } })).buffer,
        };
      };
      vi.stubEnv("VITE_API_BASE_URL", "https://cloud-test.invalid/api");
      vi.stubGlobal("window", {
        localStorage: { getItem: () => "isolated-fixture-token" },
        setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout,
        dspDesktop: { isDesktop: true, requestApiTransfer, cancelApiRequest: vi.fn() },
      });

      await expect(downloadCloudSave(scenario.revision, scenario.slot, scenario.mode)).resolves.toMatchObject({ payload });
      expect(requests).toHaveLength(1);
      expect(requests[0].method).toBe("GET");
      expect(requests[0].requestId).toMatch(/^cloud_/);
      expect(requests[0].rendererHeaders).not.toHaveProperty("x-dsp-request-id");
      expect(requests[0].headers).not.toHaveProperty("x-dsp-request-id");
      expect(requests[0].headers.authorization).toBe("Bearer isolated-fixture-token");
    });
  }
});
