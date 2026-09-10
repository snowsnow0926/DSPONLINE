import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { Transform } from "node:stream";
import { expect, it } from "vitest";
import { catalog, runtime as content, createPublicCatalogOfflineQualificationFixture } from "../../tests/fixtures/rust-offline-performance";
import { buildChunkedSaveJournal } from "./chunkedSaveJournal";
import { advanceSimulationBudget, placeBuilding, connectBeltWithResult, setEntityRecipe, setLogisticsItem,
  selectTechnology, pauseCurrentResearch, resumePausedResearch, moveTrayItemToEntity } from "./engine";
import { createNativeProjectedOrdinaryBuildingPlacementCommand } from "./nativeConstructionPlacement";
import { createNativeProjectedOrdinaryBeltPlacementCommand } from "./nativeConstructionBeltPlacement";
import { createNativeProjectedEntityRecipeCommand } from "./nativeProjectedEntityRecipeCommands";
import { createNativeProjectedLogisticsItemCommand } from "./nativeProjectedLogisticsItemCommands";
import { createNativeProjectedSelectTechnologyCommand, createNativeProjectedPauseResearchCommand,
  createNativeProjectedResumeResearchCommand } from "./nativeProjectedTechnologyCommands";
import { createNativeProjectedTrayToEntityInputCommand } from "./nativeProjectedFactoryInventoryCommands";
import type { BuildingId, GameState, ItemId, RecipeId } from "./types";
import type { SimulationCommandPatch } from "./simulationRuntimeProtocol";
import { canonicalNativeCoreSha256 } from "./nativeCoreProof";
import { createSimulationCommandPatch } from "./simulationRuntimeProtocol";

const require = createRequire(import.meta.url);
const { NativeHostClient, NativeSaveSessionRegistry, NativeCoreSessionRegistry } = require("../../desktop/native-host.cjs");
const { NativePlayerAuthorityRuntime } = require("../../desktop/native-player-authority-runtime.cjs");
const binary = process.env.DSP_NATIVE_AUTHORITY_RPC_TEST_BINARY;
const owner = "main-player-authority";

// Admission alone uses the cfg(test) override. Every gameplay reply is produced
// by a separate Rust process through the same dispatcher as the normal Host.
// This opt-in test cannot qualify or enable an installed player build.
it.skipIf(!binary)("TEST_ONLY admission: actual desktop runtime and Rust RPC preserve factory production, research and refunds across three process restarts", async () => {
  if (!binary || !path.isAbsolute(binary) || !fs.statSync(binary).isFile()) throw new Error("test binary missing");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsp-native-authority-rpc-test-"));
  fs.writeFileSync(path.join(root, "TEST_ONLY"), "rpc-integration-v1");
  const children: ReturnType<typeof spawn>[] = [];
  let client: any, registry: any, authority: any;
  let now = 10_000;
  let exportNumber = 0;
  let stage = "initial";
  let loseNextCommandReply = false;
  let expected = createPublicCatalogOfflineQualificationFixture("finite-reserve");
  // The offline fixture prebuilds its factory; interactive placement must also
  // satisfy the public construction technology gate.
  expected.research.completedTechIds.push("electromagnetic_matrix", "electromagnetism", "basic_logistics");
  expected.construction.wind_turbine = 5;
  expected.construction.arc_smelter = 1;
  expected.construction.storage_mk1 = 1;
  expected.construction.matrix_lab = 1;
  expected.construction.conveyor_belt_mk1 = 40;
  expected.tray.electromagnetic_matrix = 20;
  const initialElapsed = expected.elapsedSeconds;
  const requests: string[] = [];

  function launch(executable: string, args: string[], options: any) {
    expect(executable).toBe(binary);
    expect(args).toEqual(["serve", "--root", root]);
    expect(options.windowsHide).toBe(true);
    expect(options.shell).toBe(false);
    const child = spawn(executable, ["--exact", "rpc::tests::player_authority_rpc_child", "--ignored", "--nocapture", "--quiet"], {
      ...options, env: { ...options.env, DSP_NATIVE_RPC_TEST_ROOT: root },
    });
    if (child.pid) os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
    children.push(child);
    // Strip only libtest's bounded startup line, never alter a framed response.
    let preamble = Buffer.alloc(0), framed = false;
    const stream = new Transform({ transform(chunk, _encoding, callback) {
      if (framed) { callback(null, chunk); return; }
      preamble = Buffer.concat([preamble, chunk]);
      const at = preamble.indexOf(Buffer.from("DSPNATV1"));
      if (at < 0) {
        if (preamble.length > 512) callback(new Error("unexpected test transport preamble"));
        else callback();
        return;
      }
      if (!/^\s*running 1 test\s*$/.test(preamble.subarray(0, at).toString("utf8"))) {
        callback(new Error("invalid libtest startup")); return;
      }
      framed = true;
      callback(null, preamble.subarray(at));
      preamble = Buffer.alloc(0);
    } });
    stream.on("error", () => child.kill());
    child.stdout!.pipe(stream);
    Object.defineProperty(child, "stdout", { value: stream });
    return child;
  }

  async function start() {
    client = new NativeHostClient({ binaryPath: binary, rootPath: root, spawnProcess: launch });
    const request = client.request.bind(client);
    client.request = (value: any, timeout?: number) => {
      requests.push(value.operation);
      return request(value, timeout).then(async (reply: any) => {
        if (loseNextCommandReply && value.operation === "coreCommitPlayerAuthorityCommand") {
          loseNextCommandReply = false;
          // Rust has really committed. Drop the ACK before the registry/runtime
          // observes it, then terminate that owned process and recover its disk.
          const child = children.at(-1)!;
          const closed = once(child, "close");
          child.kill();
          await closed;
          throw new Error("TEST_ONLY dropped committed command ACK");
        }
        return reply;
      });
    };
    await client.start("TEST_ONLY-realtime-rpc-chain");
    registry = new NativeCoreSessionRegistry(client);
    authority = new NativePlayerAuthorityRuntime({ registry, ownerId: owner, now: () => now,
      schedule: () => ({}), cancel: () => {} });
  }

  async function stop(abrupt = false) {
    authority?.shutdownForProcessExit();
    const child = children.at(-1)!;
    const closed = once(child, "close");
    if (abrupt) child.kill();
    else await client.stop();
    const [code, signal] = await closed;
    if (!abrupt) { expect(code).toBe(0); expect(signal).toBeNull(); }
  }

  async function assertCompleteState() {
    const snapshot = authority.snapshot();
    const summary = await registry.status(owner, snapshot.sessionId);
    const exported = await authority.withSettledPersistenceBoundary(async (boundary: any) => {
      const exportId = `rpc-chain-${++exportNumber}`;
      await client.request({ operation: "coreExportV47", sessionId: boundary.sessionId, exportId, savedAtMs: now });
      return JSON.parse(fs.readFileSync(path.join(root, "exports", `${exportId}.json`), "utf8")).state;
    });
    const oracle = JSON.parse(JSON.stringify(expected));
    const differences: string[] = [];
    function compare(actual: any, wanted: any, at: string) {
      if (differences.length >= 12 || Object.is(actual, wanted)) return;
      if (actual && wanted && typeof actual === "object" && typeof wanted === "object") {
        for (const key of new Set([...Object.keys(actual), ...Object.keys(wanted)])) compare(actual[key], wanted[key], `${at}.${key}`);
      } else differences.push(`${at}: Rust=${JSON.stringify(actual)} JS=${JSON.stringify(wanted)}`);
    }
    compare(exported, oracle, "state");
    expect(differences, `${stage}: ${differences.join("; ")}`).toEqual([]);
    expect(exported).toEqual(oracle);
    expect(canonicalNativeCoreSha256(exported), stage).toBe(canonicalNativeCoreSha256(expected));
    expect(summary.canonicalSha256, stage).toBe(canonicalNativeCoreSha256(expected));
    expect(summary.revision).toBe(snapshot.revision);
  }

  function simulate(seconds: number) {
    for (let i = 0; i < seconds; i++) expected = advanceSimulationBudget(expected, 1, 1);
  }

  async function commitProjected(command: SimulationCommandPatch | null, next: GameState, label: string) {
    stage = label;
    expect(command, label).not.toBeNull();
    await authority.commitCommand({ commandId: `rpc-${label}`, baseRevision: authority.snapshot().revision, command });
    expected = next;
    await assertCompleteState();
  }

  async function entityBinding(entityId: string) {
    const identity = authority.snapshot();
    const projection = await registry.projection(owner, { sessionId: identity.sessionId,
      baseFields: ["activePlanetId"], entityIds: [entityId], beltIds: [] });
    expect(projection.revision).toBe(identity.revision);
    expect(projection.entities).toHaveLength(1);
    return { ...identity, registryFingerprint: content.fingerprint,
      activePlanetId: projection.base.activePlanetId, entity: projection.entities[0] };
  }

  async function build(buildingId: BuildingId, position: { x: number; y: number }) {
    const identity = authority.snapshot();
    const context = await registry.constructionPlacementContext(owner, { sessionId: identity.sessionId,
      expectedRevision: identity.revision, expectedRegistryFingerprint: content.fingerprint, buildingId });
    const next = placeBuilding(expected, buildingId, position);
    expect(next.entities.length).toBe(expected.entities.length + 1);
    await commitProjected(createNativeProjectedOrdinaryBuildingPlacementCommand(context, position), next, `place-${buildingId}`);
    return next.entities.at(-1)!.id;
  }

  async function recipe(entityId: string, recipeId: RecipeId) {
    await commitProjected(createNativeProjectedEntityRecipeCommand(await entityBinding(entityId), recipeId),
      setEntityRecipe(expected, entityId, recipeId), `recipe-${recipeId}`);
  }

  async function logistics(entityId: string, itemId: ItemId) {
    await commitProjected(createNativeProjectedLogisticsItemCommand(await entityBinding(entityId), itemId),
      setLogisticsItem(expected, entityId, itemId), `logistics-${itemId}`);
  }

  async function connect(sourceId: string, targetId: string, itemId: ItemId, label: string) {
    const identity = authority.snapshot();
    const context = await registry.constructionBeltPlacementContext(owner, { sessionId: identity.sessionId,
      expectedRevision: identity.revision, expectedRegistryFingerprint: content.fingerprint,
      sourceId, targetId, itemId, tier: 1, lanes: 1 });
    expect(context.support, label).toMatchObject({ supported: true });
    const next = connectBeltWithResult(expected, sourceId, targetId, itemId).state;
    expect(next.belts.length).toBe(expected.belts.length + 1);
    await commitProjected(createNativeProjectedOrdinaryBeltPlacementCommand(context), next, label);
  }

  async function runSeconds(seconds: number) {
    stage = `run-${seconds}-after-${stage}`;
    now += seconds * 1_000;
    await authority.settleDue();
    simulate(seconds);
    await assertCompleteState();
  }

  async function researchProjection() {
    const identity = authority.snapshot();
    return { baseRevision: identity.revision, projection: await registry.technologyProjection(owner,
      { sessionId: identity.sessionId, expectedRevision: identity.revision }) };
  }

  try {
    await start();
    const saves = new NativeSaveSessionRegistry(client);
    const journal = buildChunkedSaveJournal(expected, { mode: "normal", basePrimaryChecksum: "01234567", savedAt: 1, retainAllChunks: true });
    const prefix = "dsp-idle-network.internal.v1.chunked.v1.normal.";
    const records = [...[...journal.chunks].map(([id, value]) => ({ key: `${prefix}chunk.${encodeURIComponent(id)}`, value })),
      { key: `${prefix}manifest`, value: JSON.stringify(journal.manifest) }];
    const transaction = await saves.begin(1, { slot: "normal-main", mode: "normal", stateVersion: 47,
      baseChecksum: "01234567", registryFingerprint: content.fingerprint, revision: 1, savedAtMs: 1 });
    for (let index = 0; index < records.length; index += 8) await saves.write(1, transaction.transactionId, records.slice(index, index + 8));
    const saved = await saves.commit(1, transaction.transactionId);
    const opened = await registry.open(owner, { slot: "normal-main", generation: saved.generation,
      rootHash: saved.rootHash, revision: 1, registryFingerprint: content.fingerprint, catalog });
    await authority.activate({ sessionId: opened.sessionId, runId: "rpc-chain", settledDeadlineMs: now,
      expectedCheckpoint: { generation: saved.generation, rootHash: saved.rootHash, revision: 1 } });
    await assertCompleteState();

    const built = placeBuilding(expected, "wind_turbine", { x: 4_000, y: 4_000 });
    expect(built.entities.length).toBe(expected.entities.length + 1);
    const baseRevision = authority.snapshot().revision;
    const command = createSimulationCommandPatch(expected, built, baseRevision);
    expect(command).not.toBeNull();
    const placement = await registry.constructionPlacementContext(owner, {
      sessionId: authority.snapshot().sessionId, expectedRevision: baseRevision,
      expectedRegistryFingerprint: content.fingerprint, buildingId: "wind_turbine",
    });
    expect({ ...placement.placement.entityTemplate, position: { x: 4_000, y: 4_000 } })
      .toEqual(JSON.parse(JSON.stringify(built.entities.at(-1))));
    const action = { commandId: "rpc-build-wind", baseRevision, command };
    await authority.commitCommand(action);
    const committed = authority.snapshot().revision;
    await authority.commitCommand(action); // Lost reply retry must not build twice.
    expect(authority.snapshot().revision).toBe(committed);
    expected = built;
    await assertCompleteState();

    now += 2_500;
    await authority.setPaused(true); // Drains the two due simulation seconds.
    simulate(2);
    expected = { ...expected, paused: true };
    await assertCompleteState();
    now += 3_600_000;
    await authority.settleDue();
    await assertCompleteState();
    await authority.setPaused(false);
    expected = { ...expected, paused: false };
    now += 3_000;
    await authority.settleDue();
    simulate(3);
    await assertCompleteState();

    for (const abrupt of [false, true]) {
      const before = authority.snapshot();
      let expectedRevision = before.revision;
      if (abrupt) {
        const builtAfterRestart = placeBuilding(expected, "wind_turbine", { x: 4_000.25, y: -4_000 });
        expect(builtAfterRestart.entities.length).toBe(expected.entities.length + 1);
        loseNextCommandReply = true;
        await expect(authority.commitCommand({ commandId: "rpc-build-lost-ack", baseRevision: before.revision,
          command: createSimulationCommandPatch(expected, builtAfterRestart, before.revision) }))
          .rejects.toHaveProperty("code", "NATIVE_PLAYER_AUTHORITY_COMMAND_UNCERTAIN");
        expect(authority.snapshot().phase).toBe("uncertain");
        expected = builtAfterRestart;
        expectedRevision++;
        authority.shutdownForProcessExit();
      } else await stop();
      await start();
      const recovery = registry.takePlayerAuthorityStartupRecovery(owner);
      expect(recovery).not.toBeNull();
      authority.resumeFromStartupRecovery(recovery);
      expect(authority.snapshot().revision).toBe(expectedRevision);
      await assertCompleteState();
      now += 1_000;
      await authority.settleDue();
      simulate(1);
      await assertCompleteState();
    }
    expect(expected.elapsedSeconds - initialElapsed).toBe(7);
    for (const operation of ["corePreparePlayerAuthority", "coreActivatePlayerAuthority", "coreCommitPlayerAuthorityCommand",
      "coreCommitPlayerAuthorityTick", "coreCommitPlayerAuthorityPause", "coreExportV47"]) expect(requests).toContain(operation);
    expect(children).toHaveLength(3);
    expect(expected.construction.wind_turbine).toBe(3);

    // Continue the same durable game using the command builders used by the UI.
    const smelterId = await build("arc_smelter", { x: 4_400, y: 4_000 });
    const storageId = await build("storage_mk1", { x: 4_800, y: 4_000 });
    const labId = await build("matrix_lab", { x: 5_200, y: 4_000 });
    await logistics(storageId, "iron_ingot");
    const veinId = expected.entities.find(entity => entity.kind === "vein" && (entity.minerCount ?? 0) > 0)!.id;
    await connect(veinId, smelterId, "iron_ore", "ore-belt");
    await connect(smelterId, storageId, "iron_ingot", "ingot-belt");
    await runSeconds(12);
    const storage = expected.entities.find(entity => entity.id === storageId)!;
    expect((storage.inputs.iron_ingot ?? 0) + (storage.outputs.iron_ingot ?? 0)).toBeGreaterThan(0);
    const constructionBeforeSwitch = expected.construction.conveyor_belt_mk1!;
    const trayBeforeSwitch = expected.tray.iron_ingot ?? 0;
    const buffered = (storage.inputs.iron_ingot ?? 0) + (storage.outputs.iron_ingot ?? 0);
    await logistics(storageId, "magnet");
    expect(expected.construction.conveyor_belt_mk1).toBe(constructionBeforeSwitch + 1);
    expect(expected.tray.iron_ingot).toBe(trayBeforeSwitch + buffered);
    await recipe(smelterId, "magnet");
    await connect(veinId, smelterId, "iron_ore", "replacement-ore-belt");
    await connect(smelterId, storageId, "magnet", "magnet-belt");
    await runSeconds(12);
    const magnetStorage = expected.entities.find(entity => entity.id === storageId)!;
    expect((magnetStorage.inputs.magnet ?? 0) + (magnetStorage.outputs.magnet ?? 0)).toBeGreaterThan(0);

    await recipe(labId, "matrix_research");
    await commitProjected(createNativeProjectedSelectTechnologyCommand({ ...await researchProjection(), techId: "thermal_power" }),
      selectTechnology(expected, "thermal_power"), "research-select");
    const labBinding = await entityBinding(labId);
    const inventory = await registry.factoryInventoryProjection(owner, { sessionId: labBinding.sessionId,
      expectedRevision: labBinding.revision, cursor: 0, limit: 256 });
    expect(inventory.truncated).toBe(false);
    const frame = { ...inventory, sessionId: labBinding.sessionId, runId: labBinding.runId,
      rowsByItemId: new Map(inventory.rows.map((row: any) => [row.itemId, row])) };
    await commitProjected(createNativeProjectedTrayToEntityInputCommand(frame, labBinding.entity, "electromagnetic_matrix"),
      moveTrayItemToEntity(expected, labId, "electromagnetic_matrix"), "research-feed");
    await runSeconds(3);
    expect(expected.research.progressByTech.thermal_power?.electromagnetic_matrix).toBeGreaterThan(0);
    await commitProjected(createNativeProjectedPauseResearchCommand(await researchProjection()), pauseCurrentResearch(expected), "research-pause");
    const researchBeforePause = structuredClone(expected.research.progressByTech);
    await runSeconds(3);
    expect(expected.research.progressByTech).toEqual(researchBeforePause);
    await commitProjected(createNativeProjectedResumeResearchCommand(await researchProjection()), resumePausedResearch(expected), "research-resume");
    await runSeconds(24);
    expect(expected.research.completedTechIds).toContain("thermal_power");
    const finalRevision = authority.snapshot().revision;
    await stop();
    await start();
    const factoryRecovery = registry.takePlayerAuthorityStartupRecovery(owner);
    expect(factoryRecovery).not.toBeNull();
    authority.resumeFromStartupRecovery(factoryRecovery);
    expect(authority.snapshot().revision).toBe(finalRevision);
    await assertCompleteState();
    await runSeconds(1);
    expect(expected.elapsedSeconds - initialElapsed).toBe(62);
    expect(children).toHaveLength(4);
    await stop();
  } catch (error) {
    const chain: string[] = [];
    for (let cause: any = error; cause && chain.length < 8; cause = cause.cause) {
      chain.push(`${cause.code ?? cause.name}: ${cause.message}`);
    }
    throw new Error([stage, ...chain].join("\n"), { cause: error });
  } finally {
    authority?.shutdownForProcessExit();
    const live = children.filter(child => child.exitCode === null && child.signalCode === null);
    for (const child of live) {
      const closed = once(child, "close");
      child.kill();
      await closed;
    }
    const resolved = path.resolve(root);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith("dsp-native-authority-rpc-test-")) {
      throw new Error("unsafe test cleanup path");
    }
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}, 60_000);
