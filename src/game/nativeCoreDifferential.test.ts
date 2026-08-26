import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildChunkedSaveJournal } from "./chunkedSaveJournal";
import { createContentPackRegistry, createContentPackRuntimeSnapshot } from "./contentPacks";
import { advanceSimulationBudget, createInitialState, placeBuilding } from "./engine";
import { CAMPAIGN_TASKS } from "./campaign";
import { createNativeCoreCatalog } from "./nativeCoreCatalog";
import type { GameState } from "./types";

const require = createRequire(import.meta.url);
const { NativeHostClient, NativeSaveSessionRegistry } = require("../../desktop/native-host.cjs") as {
  NativeHostClient: new (options: { binaryPath: string; rootPath: string; requestTimeoutMs: number }) => {
    start(version: string): Promise<{ capabilities: string[] }>;
    request(request: Record<string, unknown>): Promise<any>;
    stop(): Promise<void>;
  };
  NativeSaveSessionRegistry: new (client: any) => {
    begin(owner: number, request: Record<string, unknown>): Promise<{ transactionId: string }>;
    write(owner: number, transactionId: string, records: Array<{ key: string; value: string | null }>): Promise<void>;
    commit(owner: number, transactionId: string): Promise<any>;
  };
};

const binaryPath = path.resolve("native", "target", "release", process.platform === "win32" ? "dsp-native-host.exe" : "dsp-native-host");

function canonicalSha256(value: unknown): string {
  value = JSON.parse(JSON.stringify(value));
  const hash = createHash("sha256");
  const visit = (current: unknown) => {
    if (current === null || typeof current !== "object") {
      hash.update(JSON.stringify(current));
      return;
    }
    if (Array.isArray(current)) {
      hash.update("[");
      current.forEach((entry, index) => {
        if (index > 0) hash.update(",");
        visit(entry);
      });
      hash.update("]");
      return;
    }
    hash.update("{");
    const record = current as Record<string, unknown>;
    Object.keys(record).sort().forEach((key, index) => {
      if (index > 0) hash.update(",");
      hash.update(JSON.stringify(key));
      hash.update(":");
      visit(record[key]);
    });
    hash.update("}");
  };
  visit(value);
  return hash.digest("hex");
}

function canonicalFields(value: GameState): Record<string, string> {
  const persisted = JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  return Object.fromEntries(Object.entries(persisted).map(([key, field]) => [key, canonicalSha256(field)]));
}

function quiescentState(): GameState {
  const state = createInitialState(0x1a2b3c4d);
  state.entities = [];
  state.belts = [];
  state.handcraftQueue = [];
  state.constructionQueue = [];
  state.constructionAutomation.enabled = false;
  state.constructionAutomation.jobs = {};
  state.constructionAutomation.targetStock = {};
  state.exploration.missions = [];
  state.dysonSwarm.totalLaunched = 0;
  state.dysonSphere.totalRocketsLaunched = 0;
  state.systemSpaceStations = {};
  state.quantumLogisticsNetwork.inventory = {};
  state.timeWarp.enabled = false;
  state.timeWarp.controllerEntityId = null;
  state.timeWarp.pendingSimulationSeconds = 0;
  state.timeWarp.pendingWallSeconds = 0;
  state.endgame.activeInfiniteResearchId = null;
  state.endgame.constructionActivity.activityId = null;
  for (const project of Object.values(state.endgame.exportProjects)) project.enabled = false;
  return state;
}

function simpleMiningState(): GameState {
  let state = createInitialState(0x5e71cafe);
  state.entities = state.entities.filter((entity) =>
    ["vein_iron", "vein_water", "vein_oil"].includes(entity.id));
  const configureExtractor = (
    entityId: string,
    extractorBuildingId: "mining_machine" | "water_pump" | "oil_extractor",
    minerCount: number,
  ) => {
    const vein = state.entities.find((entity) => entity.id === entityId)!;
    vein.minerCount = minerCount;
    vein.extractorBuildingId = extractorBuildingId;
    vein.outputs[vein.resourceId!] = 0;
    vein.progress = 0;
    vein.utilization = 0;
    vein.productionRate = 0;
  };
  configureExtractor("vein_iron", "mining_machine", 4);
  configureExtractor("vein_water", "water_pump", 2);
  configureExtractor("vein_oil", "oil_extractor", 1);
  state.belts = [];
  state.settings.resourceMode = "infinite";
  state.constructionAutomation.enabled = false;
  state.constructionAutomation.jobs = {};
  state.constructionAutomation.targetStock = {};
  state.exploration.missions = [];
  state.systemSpaceStations = {};
  state.quantumLogisticsNetwork.enabled = false;
  state.quantumLogisticsNetwork.inventory = {};
  state.timeWarp.enabled = false;
  state.timeWarp.controllerEntityId = null;
  state.timeWarp.pendingSimulationSeconds = 0;
  state.timeWarp.pendingWallSeconds = 0;
  state.endgame.activeInfiniteResearchId = null;
  state.endgame.infiniteResearch.vein_utilization.level = 3;
  state.endgame.constructionActivity.activityId = null;
  for (const project of Object.values(state.endgame.exportProjects)) project.enabled = false;
  state.research.completedTechIds = ["mining_speed_2"];
  const completedCampaign = CAMPAIGN_TASKS.map((task) => task.id);
  state.campaign = {
    activeChapterId: "galactic_endgame",
    activeTaskId: null,
    completedTaskIds: [...completedCampaign],
    rewardedTaskIds: [...completedCampaign],
  };
  state.construction.wind_turbine = 2;
  state = placeBuilding(state, "wind_turbine", { x: 0, y: -180 }, 2);
  const wind = state.entities.find((entity) => entity.buildingId === "wind_turbine")!;
  state.entities.push(
    {
      ...wind,
      id: "native_solar_fixture",
      buildingId: "solar_panel",
      machineCount: 3,
      position: { x: 160, y: -180 },
      inputs: {},
      outputs: {},
    },
    {
      ...wind,
      id: "native_geothermal_fixture",
      buildingId: "geothermal_power_station",
      planetId: "ashen",
      machineCount: 1,
      position: { x: 0, y: 0 },
      inputs: {},
      outputs: {},
    },
  );
  state.construction.arc_smelter = 2;
  state = placeBuilding(state, "arc_smelter", { x: 320, y: -180 }, 2);
  const smelter = state.entities.find((entity) => entity.buildingId === "arc_smelter")!;
  smelter.recipeId = "iron_ingot";
  smelter.inputs.iron_ore = 2_000;
  smelter.outputs.iron_ingot = 0;
  return state;
}

function finiteMiningState(): GameState {
  const state = simpleMiningState();
  state.settings.resourceMode = "finite";
  for (const entityId of ["vein_iron", "vein_oil"]) {
    const vein = state.entities.find((entity) => entity.id === entityId)!;
    vein.resourceRemaining = 3;
    vein.resourceCapacity = 3;
    vein.resourceDepletionRemainder = 0;
    vein.outputs[vein.resourceId!] = 0;
  }
  return state;
}

describe.skipIf(!fs.existsSync(binaryPath))("native core differential oracle", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsp-native-core-differential-"));
  const client = new NativeHostClient({ binaryPath, rootPath: root, requestTimeoutMs: 30_000 });
  const runtime = createContentPackRuntimeSnapshot(createContentPackRegistry());
  let saves: InstanceType<typeof NativeSaveSessionRegistry>;

  beforeAll(async () => {
    const hello = await client.start("native-core-differential");
    expect(hello.capabilities).toContain("native-core-shadow-v1");
    saves = new NativeSaveSessionRegistry(client);
  });

  afterAll(async () => {
    await client.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function seed(state: GameState, revision = 1): Promise<{ generation: number; rootHash: string; revision: number }> {
    const journal = buildChunkedSaveJournal(state, {
      mode: state.mode,
      basePrimaryChecksum: "01234567",
      savedAt: 1,
      retainAllChunks: true,
    });
    const prefix = `dsp-idle-network.internal.v1.chunked.v1.${state.mode}.`;
    const records = [
      ...[...journal.chunks.entries()].map(([id, value]) => ({ key: `${prefix}chunk.${encodeURIComponent(id)}`, value })),
      { key: `${prefix}manifest`, value: JSON.stringify(journal.manifest) },
    ];
    const transaction = await saves.begin(1, {
      slot: "normal-main", mode: state.mode, stateVersion: 47, baseChecksum: "01234567",
      registryFingerprint: runtime.fingerprint, revision, savedAtMs: 1,
    });
    for (let index = 0; index < records.length; index += 8) {
      await saves.write(1, transaction.transactionId, records.slice(index, index + 8));
    }
    return saves.commit(1, transaction.transactionId);
  }

  async function open(checkpoint: { generation: number; rootHash: string; revision: number }): Promise<any> {
    return client.request({
      operation: "coreOpen", slot: "normal-main", generation: checkpoint.generation,
      rootHash: checkpoint.rootHash, revision: checkpoint.revision, registryFingerprint: runtime.fingerprint,
      catalog: createNativeCoreCatalog(runtime),
    });
  }

  it("matches the JS authority at quiescent 1s/60s/600s/8h/30d boundaries", async () => {
    const initial = quiescentState();
    const checkpoint = await seed(initial);
    for (const seconds of [1, 60, 600, 8 * 60 * 60, 30 * 24 * 60 * 60]) {
      const opened = await open(checkpoint);
      const expected = advanceSimulationBudget(initial, seconds, seconds);
      const advanced = await client.request({
        operation: "coreAdvance", sessionId: opened.sessionId,
        request: { baseRevision: checkpoint.revision, simulationSeconds: seconds, wallSeconds: seconds },
      });
      expect(advanced.supported, `${seconds} 秒 native support`).toBe(true);
      expect(advanced.summary.canonicalFields, `${seconds} 秒顶层字段`).toEqual(canonicalFields(expected));
      expect(advanced.summary.canonicalSha256, `${seconds} 秒完整哈希`).toBe(canonicalSha256(expected));
      await client.request({ operation: "coreClose", sessionId: opened.sessionId });
    }
    const sequences = [
      { label: "60x1s", steps: Array.from({ length: 60 }, () => 1) },
      { label: "10x60s", steps: Array.from({ length: 10 }, () => 60) },
      { label: "8x1h", steps: Array.from({ length: 8 }, () => 60 * 60) },
      { label: "30x1d", steps: Array.from({ length: 30 }, () => 24 * 60 * 60) },
    ];
    for (const sequence of sequences) {
      const opened = await open(checkpoint);
      let expected = initial;
      let revision = checkpoint.revision;
      let advanced: any = null;
      for (const seconds of sequence.steps) {
        expected = advanceSimulationBudget(expected, seconds, seconds);
        advanced = await client.request({
          operation: "coreAdvance", sessionId: opened.sessionId,
          request: { baseRevision: revision, simulationSeconds: seconds, wallSeconds: seconds },
        });
        expect(advanced.supported, `${sequence.label} native support`).toBe(true);
        revision += 1;
      }
      expect(advanced.summary.canonicalFields, `${sequence.label} 顶层字段`).toEqual(canonicalFields(expected));
      expect(advanced.summary.canonicalSha256, `${sequence.label} 完整哈希`).toBe(canonicalSha256(expected));
      await client.request({ operation: "coreClose", sessionId: opened.sessionId });
    }
  }, 30_000);

  it("matches infinite mining, ordinary production, and renewable allocation at an exact boundary", async () => {
    const initial = simpleMiningState();
    const checkpoint = await seed(initial, 100);
    for (const seconds of [1, 10, 60, 600]) {
      const opened = await open(checkpoint);
      const expected = advanceSimulationBudget(initial, seconds, seconds);
      const advanced = await client.request({
        operation: "coreAdvance", sessionId: opened.sessionId,
        request: { baseRevision: checkpoint.revision, simulationSeconds: seconds, wallSeconds: seconds },
      });
      expect(advanced.supported, `${seconds} 秒 native support: ${advanced.reason ?? ""}`).toBe(true);
      const projection = await client.request({
        operation: "coreProjection",
        sessionId: opened.sessionId,
        entityIds: expected.entities.map((entity) => entity.id),
        baseFields: [],
      });
      expect(projection.entities, `${seconds} 秒实体投影`).toEqual(JSON.parse(JSON.stringify(expected.entities)));
      expect(advanced.summary.canonicalFields, `${seconds} 秒顶层字段`).toEqual(canonicalFields(expected));
      expect(advanced.summary.canonicalSha256, `${seconds} 秒完整哈希`).toBe(canonicalSha256(expected));
      await client.request({ operation: "coreClose", sessionId: opened.sessionId });
    }
    for (const sequence of [
      { label: "simple-factory-60x1s", steps: Array.from({ length: 60 }, () => 1) },
      { label: "simple-factory-10x60s", steps: Array.from({ length: 10 }, () => 60) },
    ]) {
      const opened = await open(checkpoint);
      let expected = initial;
      let revision = checkpoint.revision;
      let advanced: any = null;
      for (const seconds of sequence.steps) {
        expected = advanceSimulationBudget(expected, seconds, seconds);
        advanced = await client.request({
          operation: "coreAdvance", sessionId: opened.sessionId,
          request: { baseRevision: revision, simulationSeconds: seconds, wallSeconds: seconds },
        });
        expect(advanced.supported, `${sequence.label} native support: ${advanced.reason ?? ""}`).toBe(true);
        revision += 1;
      }
      expect(advanced.summary.canonicalFields, `${sequence.label} 顶层字段`).toEqual(canonicalFields(expected));
      expect(advanced.summary.canonicalSha256, `${sequence.label} 完整哈希`).toBe(canonicalSha256(expected));
      await client.request({ operation: "coreClose", sessionId: opened.sessionId });
    }
  }, 120_000);

  it("matches finite reserve depletion and the exhausted boundary", async () => {
    const initial = finiteMiningState();
    const checkpoint = await seed(initial, 150);
    for (const seconds of [1, 10, 60]) {
      const opened = await open(checkpoint);
      const expected = advanceSimulationBudget(initial, seconds, seconds);
      const advanced = await client.request({
        operation: "coreAdvance", sessionId: opened.sessionId,
        request: { baseRevision: checkpoint.revision, simulationSeconds: seconds, wallSeconds: seconds },
      });
      expect(advanced.supported, `finite-${seconds} native support: ${advanced.reason ?? ""}`).toBe(true);
      const projection = await client.request({
        operation: "coreProjection", sessionId: opened.sessionId,
        entityIds: expected.entities.map((entity) => entity.id), baseFields: [],
      });
      expect(projection.entities, `finite-${seconds} 实体投影`).toEqual(JSON.parse(JSON.stringify(expected.entities)));
      expect(advanced.summary.canonicalFields, `finite-${seconds} 顶层字段`).toEqual(canonicalFields(expected));
      expect(advanced.summary.canonicalSha256, `finite-${seconds} 完整哈希`).toBe(canonicalSha256(expected));
      await client.request({ operation: "coreClose", sessionId: opened.sessionId });
    }
  }, 30_000);

  it.skipIf(process.env.DSP_RUN_NATIVE_CORE_LONG_DIFFERENTIAL !== "1")(
    "matches long mining boundaries and segmented offline settlement",
    async () => {
      const initial = simpleMiningState();
      const checkpoint = await seed(initial, 200);
      for (const seconds of [60, 600, 8 * 60 * 60, 30 * 24 * 60 * 60]) {
        const opened = await open(checkpoint);
        const expected = advanceSimulationBudget(initial, seconds, seconds);
        const advanced = await client.request({
          operation: "coreAdvance", sessionId: opened.sessionId,
          request: { baseRevision: checkpoint.revision, simulationSeconds: seconds, wallSeconds: seconds },
        });
        expect(advanced.supported, `long-${seconds} native support: ${advanced.reason ?? ""}`).toBe(true);
        expect(advanced.summary.canonicalFields, `long-${seconds} 顶层字段`).toEqual(canonicalFields(expected));
        expect(advanced.summary.canonicalSha256, `long-${seconds} 完整哈希`).toBe(canonicalSha256(expected));
        await client.request({ operation: "coreClose", sessionId: opened.sessionId });
      }
      for (const sequence of [
        { label: "mining-8x1h", steps: Array.from({ length: 8 }, () => 60 * 60) },
        { label: "mining-30x1d", steps: Array.from({ length: 30 }, () => 24 * 60 * 60) },
      ]) {
        const opened = await open(checkpoint);
        let expected = initial;
        let revision = checkpoint.revision;
        let advanced: any = null;
        for (const seconds of sequence.steps) {
          expected = advanceSimulationBudget(expected, seconds, seconds);
          advanced = await client.request({
            operation: "coreAdvance", sessionId: opened.sessionId,
            request: { baseRevision: revision, simulationSeconds: seconds, wallSeconds: seconds },
          });
          expect(advanced.supported, `${sequence.label} native support: ${advanced.reason ?? ""}`).toBe(true);
          revision += 1;
        }
        expect(advanced.summary.canonicalFields, `${sequence.label} 顶层字段`).toEqual(canonicalFields(expected));
        expect(advanced.summary.canonicalSha256, `${sequence.label} 完整哈希`).toBe(canonicalSha256(expected));
        await client.request({ operation: "coreClose", sessionId: opened.sessionId });
      }
    },
    240_000,
  );
});
