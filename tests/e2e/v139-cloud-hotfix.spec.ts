import { expect, test } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCloudServer } from "../../server/index.mjs";
import { computeSaveStateChecksum } from "../../server/save-integrity.mjs";

const webPort = Number(process.env.DSP_E2E_PORT ?? 4319);
let directory = "";
let apiBaseUrl = "";
let cloudServer: Awaited<ReturnType<typeof createCloudServer>>;

function v46State(mode: "normal" | "speedrun") {
  return {
    version: 46,
    mode,
    elapsedSeconds: 600,
    entities: [{ id: "storage", kind: "storage", buildingId: "storage_mk1" }],
    belts: [{ id: "belt", source: "storage", target: "storage", itemId: "iron_ore" }],
    settings: {
      productionBufferLimit: 1_000_000,
      logisticsBufferLimit: 1_000_000,
      beltBufferLimit: 100_000_000,
      proliferatorBufferLimit: 600,
    },
    contentPacks: [],
    galaxy: { planetMetadata: {}, systemMetadata: {} },
    quantumLogisticsNetwork: {
      enabled: false,
      inventory: {},
      routingCursors: {},
      itemCapacities: {},
      uploadRoutingCursors: {},
    },
    constructionAutomation: { destroyedByproducts: {} },
    blueprints: [],
    blueprintVersions: [],
    constructionQueue: [],
    dysonPlans: {},
    timeWarp: {
      controllerEntityId: null,
      enabled: false,
      requestedMultiplier: 5,
      effectiveMultiplier: 1,
      pendingSimulationSeconds: 0,
      pendingWallSeconds: 0,
      requiredPowerKw: 0,
      allocatedPowerKw: 0,
    },
    endgame: {
      infiniteResearch: Object.fromEntries([
        "matrix_compression",
        "vein_utilization",
        "galactic_logistics",
        "stellar_harnessing",
        "continuum_simulation",
      ].map((id) => [id, { level: 0, progress: "0" }])),
    },
    totalProduced: {},
    metrics: { generationKw: 0, totalItemsPerMinute: 0, rayGenerationKw: 0 },
    exploration: { unlockedSystemIds: ["helios"], colonizedPlanetIds: ["home"] },
  };
}

function payloadFor(state: ReturnType<typeof v46State>, savedAt: number) {
  const envelope = { formatVersion: 2, savedAt, mode: state.mode, state };
  return JSON.stringify({
    ...envelope,
    checksum: computeSaveStateChecksum(envelope.formatVersion, state),
  });
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "dsp-v139-playwright-"));
  cloudServer = await createCloudServer({
    databaseFile: path.join(directory, "cloud.sqlite"),
    allowedOrigin: `http://127.0.0.1:${webPort}`,
    registrationLimit: 100,
    historyPruneIntervalMs: 0,
    logger: { error() {} },
  });
  await new Promise<void>((resolve) => cloudServer.listen(0, "127.0.0.1", resolve));
  apiBaseUrl = `http://127.0.0.1:${(cloudServer.address() as { port: number }).port}`;
});

test.afterAll(async () => {
  if (cloudServer?.listening) await new Promise<void>((resolve) => cloudServer.close(() => resolve()));
  if (directory) await rm(directory, { recursive: true, force: true });
});

test("reports the 1.2.7 native candidate version and a unique build id", async ({ page }) => {
  await page.goto("/?menu=1");
  const application = process.env.DSP_E2E_USE_PREVIEW === "1"
    ? await page.evaluate(async () => {
        const response = await fetch("/version.json", { cache: "no-store" });
        if (!response.ok) throw new Error(`version.json returned ${response.status}`);
        const payload = await response.json() as { version: string; buildId: string };
        return { version: payload.version, build: payload.buildId };
      })
    : await page.evaluate(async () => {
        const { collectClientDiagnostics } = await import("/src/game/diagnostics.ts");
        return collectClientDiagnostics().application as { version: string; build: string };
      });
  expect(application.version).toBe("1.2.7");
  expect(application.build).toMatch(/^1\.2\.7\+[0-9a-f]{12}(?:\.dirty)?$/);
});

test("browser protocol uploads sparse v46 normal and speedrun saves without rewriting them", async ({ page }) => {
  await page.goto("/?menu=1");
  const normalPayload = payloadFor(v46State("normal"), 101);
  const speedrunPayload = payloadFor(v46State("speedrun"), 102);
  const denseV45State = v46State("normal");
  denseV45State.version = 45;
  Object.assign(denseV45State.entities[0], { interactionLocked: false });
  Object.assign(denseV45State.belts[0], { lanes: 1, tier: 1, progress: 0 });
  const denseV45Payload = payloadFor(denseV45State, 103);

  const result = await page.evaluate(async ({ apiBaseUrl, normalPayload, speedrunPayload, denseV45Payload }) => {
    const request = async (route: string, options: RequestInit = {}) => {
      const response = await fetch(`${apiBaseUrl}${route}`, {
        ...options,
        headers: { "content-type": "application/json", ...(options.headers ?? {}) },
      });
      return { status: response.status, body: await response.json() };
    };
    const registered = await request("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({ username: "v139_browser", password: "synthetic-pass-123", displayName: "浏览器合成账号" }),
    });
    const headers = { authorization: `Bearer ${registered.body.token}` };
    const normal = await request("/api/cloud-save", {
      method: "PUT", headers, body: JSON.stringify({ payload: normalPayload, expectedRevision: 0 }),
    });
    const speedrun = await request("/api/cloud-save?mode=speedrun&slot=1", {
      method: "PUT", headers, body: JSON.stringify({ payload: speedrunPayload, expectedRevision: 0 }),
    });
    const denseV45 = await request("/api/cloud-save?slot=2", {
      method: "PUT", headers, body: JSON.stringify({ payload: denseV45Payload, expectedRevision: 0 }),
    });
    const normalDownload = await request("/api/cloud-save", { headers });
    const speedrunDownload = await request("/api/cloud-save?mode=speedrun&slot=1", { headers });
    const denseV45Download = await request("/api/cloud-save?slot=2", { headers });
    return {
      registered: registered.status,
      statuses: [normal.status, speedrun.status, denseV45.status],
      revisions: [normal.body.cloudSave?.revision, speedrun.body.cloudSave?.revision, denseV45.body.cloudSave?.revision],
      payloads: [normalDownload.body.cloudSave?.payload, speedrunDownload.body.cloudSave?.payload, denseV45Download.body.cloudSave?.payload],
    };
  }, { apiBaseUrl, normalPayload, speedrunPayload, denseV45Payload });

  expect(result.registered).toBe(201);
  expect(result.statuses).toEqual([200, 200, 200]);
  expect(result.revisions).toEqual([1, 1, 1]);
  expect(result.payloads).toEqual([normalPayload, speedrunPayload, denseV45Payload]);
});
