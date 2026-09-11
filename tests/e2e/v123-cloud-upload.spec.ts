import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { expect, test } from "@playwright/test";
import { createSyntheticCloudSave } from "./fixtures/syntheticCloudSave";

const FIXTURE = process.env.DSP_CLOUD_UPLOAD_FIXTURE;
const OFFLINE_SECONDS = Math.max(0, Number(process.env.DSP_CLOUD_UPLOAD_OFFLINE_SECONDS ?? 164));

test.use({ serviceWorkers: "block" });

test("cloud upload preparation keeps a large save off the main thread", async ({ page }) => {
  test.setTimeout(Math.max(180_000, OFFLINE_SECONDS * 250));
  await page.addInitScript(() => window.localStorage.setItem("dsp-idle-network.release-notes.seen.v1", "2026-08-17-v1.0.46"));
  await page.goto("/?menu=1");
  const raw = FIXTURE ? readFileSync(FIXTURE, "utf8") : createSyntheticCloudSave({ targetBytes: 8 * 1024 * 1024 });
  const fixtureSavedAt = (JSON.parse(raw) as { savedAt?: number }).savedAt ?? Date.now();
  const result = await page.evaluate(async ({ raw, fixtureSavedAt, offlineSeconds }) => {
    const longTasks: number[] = [];
    const observer = typeof PerformanceObserver !== "undefined"
      ? new PerformanceObserver((list) => list.getEntries().forEach((entry) => longTasks.push(entry.duration)))
      : null;
    observer?.observe({ type: "longtask", buffered: true });
    const { prepareCloudUploadInWorker } = await import("/src/game/offlineSimulation.ts");
    const startedAt = performance.now();
    const prepared = await prepareCloudUploadInWorker(raw, { now: fixtureSavedAt + offlineSeconds * 1_000 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    observer?.disconnect();
    return {
      elapsedMs: performance.now() - startedAt,
      rawBytes: new TextEncoder().encode(raw).byteLength,
      payloadBytes: new TextEncoder().encode(prepared.payload).byteLength,
      offlineSeconds: prepared.offlineSeconds,
      summary: prepared.summary,
      maxLongTaskMs: Math.max(0, ...longTasks),
    };
  }, { raw, fixtureSavedAt, offlineSeconds: OFFLINE_SECONDS });

  expect(result.rawBytes).toBeGreaterThan(1_000_000);
  expect(result.payloadBytes).toBeGreaterThan(1_000_000);
  expect(result.summary.integrity).toBe("valid");
  expect(result.summary.stateVersion).toBe(47);
  expect(result.summary.entityCount).toBeGreaterThan(0);
  expect(result.maxLongTaskMs).toBeLessThan(200);
  console.info("cloud-upload-large-save-metrics", JSON.stringify(result));
});

test("cloud upload preparation can skip offline settlement without changing the saved factory", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/?menu=1");
  const raw = FIXTURE ? readFileSync(FIXTURE, "utf8") : createSyntheticCloudSave({ targetBytes: 8 * 1024 * 1024 });
  const fixture = JSON.parse(raw) as { savedAt?: number };
  const result = await page.evaluate(async ({ raw, savedAt }) => {
    const { prepareCloudUploadInWorker } = await import("/src/game/offlineSimulation.ts");
    const baseline = await prepareCloudUploadInWorker(raw, { now: savedAt ?? Date.now(), skipOffline: true });
    const prepared = await prepareCloudUploadInWorker(raw, { now: (savedAt ?? Date.now()) + 7 * 24 * 60 * 60 * 1_000, skipOffline: true });
    const baselineEnvelope = JSON.parse(baseline.payload) as { state?: { elapsedSeconds?: number; totalProduced?: Record<string, number>; entities?: unknown[] } };
    const envelope = JSON.parse(prepared.payload) as { state?: { elapsedSeconds?: number; totalProduced?: Record<string, number>; entities?: unknown[] } };
    return {
      offlineSeconds: prepared.offlineSeconds,
      baseline: {
        elapsedSeconds: baselineEnvelope.state?.elapsedSeconds ?? 0,
        totalProduced: baselineEnvelope.state?.totalProduced ?? {},
        entityCount: baselineEnvelope.state?.entities?.length ?? 0,
      },
      state: {
        elapsedSeconds: envelope.state?.elapsedSeconds ?? 0,
        totalProduced: envelope.state?.totalProduced ?? {},
        entityCount: envelope.state?.entities?.length ?? 0,
      },
      integrity: prepared.summary.integrity,
    };
  }, { raw, savedAt: fixture.savedAt });

  expect(result.offlineSeconds).toBe(0);
  expect(result.state).toEqual(result.baseline);
  expect(result.integrity).toBe("valid");
});

test("browser upload sends real gzip bodies for 1 MB, 2 MB and 7 MB saves", async ({ page }) => {
  test.setTimeout(120_000);
  const raw = FIXTURE ? readFileSync(FIXTURE, "utf8") : createSyntheticCloudSave({ targetBytes: 7 * 1024 * 1024 });
  const fixture = JSON.parse(raw) as { formatVersion: number; savedAt?: number; state: Record<string, unknown> };
  const checksum = (formatVersion: number, state: unknown) => {
    const source = JSON.stringify({ formatVersion, state });
    let hash = 0x811c9dc5;
    for (let index = 0; index < source.length; index += 1) {
      hash ^= source.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  };
  const compactFixture = {
    ...fixture,
    state: {
      ...fixture.state,
      entities: [],
      belts: [],
      padding: "",
    },
  };
  const makePayload = (targetBytes: number) => {
    const state = { ...compactFixture.state, padding: "x".repeat(targetBytes) };
    const envelope = { ...compactFixture, state, checksum: checksum(compactFixture.formatVersion, state) };
    return JSON.stringify(envelope);
  };
  const payloads = [makePayload(1_000_000), makePayload(2_000_000), raw];
  const revisions = [7, 8, 9];
  const requests: Array<{ compressed: boolean; payload: string; expectedRevision: number }> = [];
  await page.route("**/api/cloud-save*", async (route) => {
    const request = route.request();
    const compressed = request.headers()["content-encoding"] === "gzip";
    const body = request.postDataBuffer() ?? Buffer.alloc(0);
    const decoded = compressed ? gunzipSync(body) : body;
    const payload = decoded.toString("utf8");
    const expectedRevision = Number(request.headers()["x-dsp-expected-revision"]);
    expect(compressed).toBe(true);
    expect(request.headers()["content-type"]).toContain("application/vnd.dspidle.save+json");
    requests.push({ compressed, payload, expectedRevision });
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ cloudSave: { revision: expectedRevision + 1, updatedAt: Date.now(), size: new TextEncoder().encode(payload).byteLength, checksum: "server-checksum", summary: null } }),
    });
  });
  await page.goto("/?menu=1");
  const result = await page.evaluate(async ({ payloads, revisions }) => {
    const { uploadCloudSaveWithOptions } = await import("/src/game/cloud.ts");
    const results = [];
    for (let index = 0; index < payloads.length; index += 1) {
      results.push(await uploadCloudSaveWithOptions(payloads[index], revisions[index], "main", { verified: true }));
    }
    return results.map((result) => result.revision);
  }, { payloads, revisions });
  expect(requests).toHaveLength(3);
  expect(requests.map((request) => request.payload)).toEqual(payloads);
  expect(requests.map((request) => request.expectedRevision)).toEqual(revisions);
  expect(result).toEqual([8, 9, 10]);
});

