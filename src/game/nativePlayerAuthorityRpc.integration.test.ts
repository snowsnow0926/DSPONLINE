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
import { advanceSimulationBudget, placeBuilding } from "./engine";
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
it.skipIf(!binary)("TEST_ONLY admission: actual desktop runtime and Rust RPC preserve gameplay across pause, save and two process restarts", async () => {
  if (!binary || !path.isAbsolute(binary) || !fs.statSync(binary).isFile()) throw new Error("test binary missing");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsp-native-authority-rpc-test-"));
  fs.writeFileSync(path.join(root, "TEST_ONLY"), "rpc-integration-v1");
  const children: ReturnType<typeof spawn>[] = [];
  let client: any, registry: any, authority: any;
  let now = 10_000;
  let exportNumber = 0;
  let loseNextCommandReply = false;
  let expected = createPublicCatalogOfflineQualificationFixture("finite-reserve");
  // The offline fixture prebuilds its factory; interactive placement must also
  // satisfy the public construction technology gate.
  expected.research.completedTechIds.push("electromagnetic_matrix", "electromagnetism");
  expected.construction.wind_turbine = 5;
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
    expect(summary.canonicalSha256).toBe(canonicalNativeCoreSha256(expected));
    const exported = await authority.withSettledPersistenceBoundary(async (boundary: any) => {
      const exportId = `rpc-chain-${++exportNumber}`;
      await client.request({ operation: "coreExportV47", sessionId: boundary.sessionId, exportId, savedAtMs: now });
      return JSON.parse(fs.readFileSync(path.join(root, "exports", `${exportId}.json`), "utf8")).state;
    });
    expect(canonicalNativeCoreSha256(exported)).toBe(canonicalNativeCoreSha256(expected));
    expect(exported).toEqual(JSON.parse(JSON.stringify(expected)));
    expect(summary.revision).toBe(snapshot.revision);
  }

  function simulate(seconds: number) {
    for (let i = 0; i < seconds; i++) expected = advanceSimulationBudget(expected, 1, 1);
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
    await stop();
  } catch (error) {
    const chain: string[] = [];
    for (let cause: any = error; cause && chain.length < 8; cause = cause.cause) {
      chain.push(`${cause.code ?? cause.name}: ${cause.message}`);
    }
    throw new Error(chain.join("\n"), { cause: error });
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
