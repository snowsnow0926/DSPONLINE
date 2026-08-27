import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

import { buildChunkedSaveJournal } from "./chunkedSaveJournal";
import {
  createContentPackRegistry,
  createContentPackRuntimeSnapshot,
} from "./contentPacks";
import { CAMPAIGN_TASKS } from "./campaign";
import { createInitialState } from "./engine";
import { createNativeCoreCatalog } from "./nativeCoreCatalog";
import type { GameState } from "./types";

const require = createRequire(import.meta.url);
const { NativeHostClient, NativeSaveSessionRegistry } = require("../../desktop/native-host.cjs") as {
  NativeHostClient: new (options: {
    binaryPath: string;
    rootPath: string;
    requestTimeoutMs: number;
    spawnEnvironment?: {
      DSP_NATIVE_CORE_THREADS: string;
      DSP_NATIVE_CORE_SYNC_RECORD_DROP?: string;
    };
  }) => {
    child: import("node:child_process").ChildProcess | null;
    start(version: string): Promise<{ capabilities: string[] }>;
    request(request: Record<string, unknown>): Promise<any>;
    stop(): Promise<void>;
  };
  NativeSaveSessionRegistry: new (client: any) => {
    begin(owner: number, request: Record<string, unknown>): Promise<{ transactionId: string }>;
    write(owner: number, transactionId: string, records: Array<{ key: string; value: string | null }>): Promise<void>;
    commit(owner: number, transactionId: string): Promise<{
      generation: number;
      revision: number;
      rootHash: string;
    }>;
  };
};

const binaryPath = process.env.DSP_NATIVE_CORE_HOST_BINARY
  ? path.resolve(process.env.DSP_NATIVE_CORE_HOST_BINARY)
  : path.resolve(
    "native",
    "target",
    "release",
    process.platform === "win32" ? "dsp-native-host.exe" : "dsp-native-host",
  );

function exactMiningState(entityCount = 1): GameState {
  const state = createInitialState(0x51f0_0d5a);
  const vein = state.entities.find((entity) => entity.id === "vein_iron")!;
  vein.minerCount = 4;
  vein.extractorBuildingId = "mining_machine";
  vein.outputs.iron_ore = 0;
  vein.progress = 0;
  vein.utilization = 0;
  vein.productionRate = 0;
  state.entities = Array.from({ length: entityCount }, (_, index) => ({
    ...structuredClone(vein),
    id: `vein_record_drop_${index}`,
    position: {
      x: index % 128,
      y: Math.floor(index / 128),
    },
  }));
  state.belts = [];
  state.paused = false;
  state.settings.resourceMode = "infinite";
  state.handcraftQueue = [];
  state.constructionQueue = [];
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
  state.endgame.constructionActivity.activityId = null;
  for (const project of Object.values(state.endgame.exportProjects)) project.enabled = false;
  const completedCampaign = CAMPAIGN_TASKS.map((task) => task.id);
  state.campaign = {
    activeChapterId: "galactic_endgame",
    activeTaskId: null,
    completedTaskIds: completedCampaign,
    rewardedTaskIds: completedCampaign,
  };
  return state;
}

function waitForExit(
  child: import("node:child_process").ChildProcess,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("native host did not exit after shutdown")), 5_000);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

it.skipIf(!fs.existsSync(binaryPath))(
  "survives immediate close and shutdown with deferred and joined record drop at 1/2/4/8 workers",
  async () => {
    const runtime = createContentPackRuntimeSnapshot(createContentPackRegistry());
    const state = exactMiningState(4_353);
    const journal = buildChunkedSaveJournal(state, {
      mode: state.mode,
      basePrimaryChecksum: "01234567",
      savedAt: 1,
      retainAllChunks: true,
    });
    const prefix = `dsp-idle-network.internal.v1.chunked.v1.${state.mode}.`;
    const records = [
      ...[...journal.chunks.entries()].map(([id, value]) => ({
        key: `${prefix}chunk.${encodeURIComponent(id)}`,
        value,
      })),
      { key: `${prefix}manifest`, value: JSON.stringify(journal.manifest) },
    ];

    let expectedCanonicalSha256: string | null = null;
    for (const workerLimit of [1, 2, 4, 8]) {
      for (const syncRecordDrop of [false, true]) {
        for (let processIteration = 0; processIteration < 2; processIteration += 1) {
          const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsp-native-record-drop-lifecycle-"));
          const client = new NativeHostClient({
            binaryPath,
            rootPath: root,
            requestTimeoutMs: 60_000,
            spawnEnvironment: {
              DSP_NATIVE_CORE_THREADS: String(workerLimit),
              ...(syncRecordDrop ? { DSP_NATIVE_CORE_SYNC_RECORD_DROP: "1" } : {}),
            },
          });
          let exited = false;
          try {
          const hello = await client.start("record-drop-lifecycle");
          expect(hello.capabilities).toContain("native-core-shadow-v1");
          const saves = new NativeSaveSessionRegistry(client);
          const transaction = await saves.begin(1, {
            slot: "normal-main",
            mode: state.mode,
            stateVersion: 47,
            baseChecksum: "01234567",
            registryFingerprint: runtime.fingerprint,
            revision: 1,
            savedAtMs: workerLimit * 100 + Number(syncRecordDrop) * 10 + processIteration,
          });
          for (let index = 0; index < records.length; index += 8) {
            await saves.write(1, transaction.transactionId, records.slice(index, index + 8));
          }
          const checkpoint = await saves.commit(1, transaction.transactionId);
          const opened = await client.request({
            operation: "coreOpen",
            slot: "normal-main",
            generation: checkpoint.generation,
            rootHash: checkpoint.rootHash,
            revision: checkpoint.revision,
            registryFingerprint: runtime.fingerprint,
            catalog: createNativeCoreCatalog(runtime),
          });
          const advanced = await client.request({
            operation: "coreAdvance",
            sessionId: opened.sessionId,
            request: {
              baseRevision: checkpoint.revision,
              simulationSeconds: 1,
              wallSeconds: 1,
              includeDiagnostics: true,
            },
          });
          expect(
            advanced.supported,
            advanced.reason ?? `workers ${workerLimit}, process ${processIteration}`,
          ).toBe(true);
          expect(advanced.changed).toBe(true);
          expect(advanced.summary).toBeTruthy();
          expectedCanonicalSha256 ??= advanced.summary.canonicalSha256;
          expect(advanced.summary.canonicalSha256).toBe(expectedCanonicalSha256);
          expect((await client.request({
            operation: "coreStatus",
            sessionId: opened.sessionId,
          })).canonicalSha256).toBe(expectedCanonicalSha256);

          // Exercise both explicit session destruction and shutdown's close-all
          // path immediately after the exact-advance ACK in fresh processes.
          if (processIteration === 0) {
            expect(await client.request({ operation: "coreClose", sessionId: opened.sessionId }))
              .toEqual({ closed: true });
          }
          const child = client.child!;
          const exit = waitForExit(child);
          expect(await client.request({ operation: "shutdown" })).toEqual({ accepted: true });
          expect(await exit).toEqual({ code: 0, signal: null });
          exited = true;
          } finally {
            if (!exited) await client.stop();
            fs.rmSync(root, { recursive: true, force: true });
          }
        }
      }
    }
  },
  360_000,
);
