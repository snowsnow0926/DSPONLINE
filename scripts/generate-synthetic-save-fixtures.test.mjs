import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createServer } from "vite";
import { inspectDecodedCloudSaveUpload } from "../server/index.mjs";
import { inspectSavePayloadIntegrity } from "../server/save-integrity.mjs";
import {
  SYNTHETIC_FIXTURE_FORMAT_VERSION,
  SYNTHETIC_FIXTURE_GENERATOR_VERSION,
  SYNTHETIC_FIXTURE_MAX_BUFFER_BYTES,
  SYNTHETIC_FIXTURE_PROFILES,
  SYNTHETIC_FIXTURE_SAVED_AT,
  SYNTHETIC_FIXTURE_SCRIPT_PATH,
  SYNTHETIC_FIXTURE_SEED,
  SYNTHETIC_FIXTURE_STATE_VERSION,
  auditSyntheticFixtureContract,
  createSyntheticFixturePlan,
  generateSyntheticSaveFixture,
  syntheticFixtureFilename,
} from "./generate-synthetic-save-fixtures.mjs";

const manifestPath = new URL("../tests/fixtures/synthetic/manifest.json", import.meta.url);
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const profiles = ["1m", "8m", "20m", "29m"];
const modes = ["normal", "speedrun"];
const forbiddenIdentityKeys = new Set([
  "username",
  "email",
  "password",
  "token",
  "userId",
  "accountId",
  "displayName",
  "sessionId",
  "ipHash",
  "deviceHash",
]);

function directDescriptor(payloadBytes) {
  return {
    direct: true,
    expectedRevision: 0,
    requestId: "synthetic-fixture-contract",
    declaredOriginalBytes: payloadBytes,
    encoding: "",
    expandedLimit: 68 * 1024 * 1024,
    payloadLimit: 33_553_408,
  };
}

function findForbiddenIdentityPaths(value, path = "", matches = []) {
  if (!value || typeof value !== "object") return matches;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      findForbiddenIdentityPaths(value[index], `${path}[${index}]`, matches);
    }
    return matches;
  }
  for (const [key, child] of Object.entries(value)) {
    const childPath = path ? `${path}.${key}` : key;
    if (forbiddenIdentityKeys.has(key) && child !== null && child !== undefined && child !== "") matches.push(childPath);
    findForbiddenIdentityPaths(child, childPath, matches);
  }
  return matches;
}

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path, { highWaterMark: 64 * 1024 })) hash.update(chunk);
  return hash.digest("hex");
}

test("fixture description pins the current GameState/envelope-v2, exact sizes, and the full production coverage contract", () => {
  assert.equal(manifest.contractVersion, 1);
  assert.equal(manifest.generatorVersion, SYNTHETIC_FIXTURE_GENERATOR_VERSION);
  assert.equal(manifest.gameStateVersion, SYNTHETIC_FIXTURE_STATE_VERSION);
  assert.equal(manifest.envelopeVersion, SYNTHETIC_FIXTURE_FORMAT_VERSION);
  assert.equal(manifest.seed, SYNTHETIC_FIXTURE_SEED);
  assert.equal(manifest.savedAt, SYNTHETIC_FIXTURE_SAVED_AT);
  assert.deepEqual(Object.keys(manifest.profiles), profiles);
  assert.deepEqual(
    profiles.map((profile) => manifest.profiles[profile].targetBytes),
    [1, 8, 20, 29].map((mebibytes) => mebibytes * 1024 * 1024),
  );
  assert.deepEqual(new Set(manifest.coverage), new Set([
    "entities",
    "belts",
    "building-stacks",
    "power",
    "traditional-logistics",
    "quantum-logistics",
    "dyson",
    "research",
    "fluids",
    "byproducts",
    "recursive-manufacturing",
    "galactic-exports",
    "finite-veins",
    "infinite-veins",
    "cache-boundaries",
  ]));
  for (const profile of profiles) {
    assert.equal(SYNTHETIC_FIXTURE_PROFILES[profile].targetBytes, manifest.profiles[profile].targetBytes);
    for (const mode of modes) {
      const expected = manifest.profiles[profile][mode];
      assert.match(expected.sha256, /^[a-f0-9]{64}$/);
      assert.match(expected.stateChecksum, /^[a-f0-9]{8}$/);
      assert.ok(expected.entityCount > 0);
      assert.ok(expected.beltCount > 0);
      assert.ok(expected.paddingBytes >= 0 && expected.paddingBytes < 512);
    }
  }
});

test("all normal/speedrun profiles reproduce the pinned SHA-256, checksum, counts, and exact byte size", async () => {
  for (const profile of profiles) {
    for (const mode of modes) {
      const result = await generateSyntheticSaveFixture({ profile, mode, slot: "main", seed: SYNTHETIC_FIXTURE_SEED });
      const expected = manifest.profiles[profile][mode];
      assert.equal(result.bytes, manifest.profiles[profile].targetBytes, `${profile}/${mode} exact bytes`);
      assert.equal(result.sha256, expected.sha256, `${profile}/${mode} SHA-256`);
      assert.equal(result.stateChecksum, expected.stateChecksum, `${profile}/${mode} v2 checksum`);
      assert.equal(result.entityCount, expected.entityCount, `${profile}/${mode} entity count`);
      assert.equal(result.beltCount, expected.beltCount, `${profile}/${mode} belt count`);
      assert.equal(result.paddingBytes, expected.paddingBytes, `${profile}/${mode} padding`);
      assert.ok(result.maxBufferedBytes <= SYNTHETIC_FIXTURE_MAX_BUFFER_BYTES, `${profile}/${mode} bounded output batch`);
      assert.ok(result.maxRecordBytes < SYNTHETIC_FIXTURE_MAX_BUFFER_BYTES, `${profile}/${mode} bounded record`);
      assert.ok(result.paddingBytes < result.maxRecordBytes, `${profile}/${mode} padding stays sub-record sized`);
    }
  }

  const repeated = await generateSyntheticSaveFixture({ profile: "1m", mode: "normal", slot: "main", seed: SYNTHETIC_FIXTURE_SEED });
  const anotherSeed = await generateSyntheticSaveFixture({ profile: "1m", mode: "normal", slot: "main", seed: SYNTHETIC_FIXTURE_SEED + 1 });
  assert.equal(repeated.sha256, manifest.profiles["1m"].normal.sha256);
  assert.notEqual(anotherSeed.sha256, repeated.sha256);
  assert.equal(anotherSeed.bytes, repeated.bytes);
  assert.equal(anotherSeed.entityCount, repeated.entityCount);
});

test("largest normal/speedrun plans are non-negative, anonymous, mode-isolated, and cover finite/infinite resources", () => {
  const normal = auditSyntheticFixtureContract({ profile: "29m", mode: "normal", slot: 1 });
  const speedrun = auditSyntheticFixtureContract({ profile: "29m", mode: "speedrun", slot: 2 });

  for (const audit of [normal, speedrun]) {
    assert.deepEqual(audit.negative, []);
    assert.deepEqual(audit.nonFinite, []);
    assert.deepEqual(audit.identityKeys, []);
    assert.deepEqual(audit.identityValues, []);
    assert.deepEqual(new Set(audit.coverage), new Set(manifest.coverage));
    assert.ok(audit.entityCount > 25_000);
    assert.ok(audit.beltCount > 50_000);
    assert.ok(audit.paddingBytes < audit.maxRecordBytes);
  }
  assert.equal(normal.mode, "normal");
  assert.equal(normal.slot, 1);
  assert.equal(normal.resourceMode, "infinite");
  assert.equal(speedrun.mode, "speedrun");
  assert.equal(speedrun.slot, 2);
  assert.equal(speedrun.resourceMode, "finite", "ranked fixtures never use infinite resources");

  const finitePlan = createSyntheticFixturePlan({ profile: "20m", mode: "normal", slot: 3 });
  const infinitePlan = createSyntheticFixturePlan({ profile: "8m", mode: "normal", slot: 3 });
  assert.equal(finitePlan.resourceMode, "finite");
  assert.equal(infinitePlan.resourceMode, "infinite");
  assert.equal(finitePlan.slot, 3);
  assert.equal(infinitePlan.slot, 3);
});

test("representative normal and speedrun payloads pass current client and server contracts without cross-mode markers", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "dsp-synthetic-contract-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const vite = await createServer({
    root: process.cwd(),
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  t.after(() => vite.close());
  const storage = await vite.ssrLoadModule("/src/game/storage.ts");

  for (const mode of modes) {
    const outputPath = join(directory, syntheticFixtureFilename({ profile: "1m", mode, slot: "main" }));
    const generated = await generateSyntheticSaveFixture({
      profile: "1m",
      mode,
      slot: "main",
      outputPath,
    });
    const raw = await readFile(outputPath, "utf8");
    const parsed = JSON.parse(raw);
    const integrity = inspectSavePayloadIntegrity(raw);
    const serverInspection = inspectDecodedCloudSaveUpload(Buffer.from(raw), directDescriptor(Buffer.byteLength(raw)));
    const clientInspection = storage.inspectSave(raw);

    assert.equal(Buffer.byteLength(raw), 1024 * 1024);
    assert.equal(createHash("sha256").update(raw).digest("hex"), generated.sha256);
    assert.equal(parsed.formatVersion, 2);
    assert.equal(parsed.savedAt, SYNTHETIC_FIXTURE_SAVED_AT);
    assert.equal(parsed.slot, "main");
    assert.equal(parsed.mode, mode);
    assert.equal(parsed.state.version, SYNTHETIC_FIXTURE_STATE_VERSION);
    assert.equal(parsed.state.mode, mode);
    assert.equal(parsed.checksum, generated.stateChecksum);
    assert.equal(integrity.valid, true);
    assert.equal(integrity.computedChecksum, generated.stateChecksum);
    assert.equal(serverInspection.validPayload, true);
    assert.equal(serverInspection.integrity.valid, true);
    assert.equal(serverInspection.payloadMode, mode);
    assert.equal(serverInspection.summary.stateVersion, SYNTHETIC_FIXTURE_STATE_VERSION);
    assert.equal(serverInspection.summary.entityCount, generated.entityCount);
    assert.equal(serverInspection.payloadSize, 1024 * 1024);
    assert.equal(clientInspection.valid, true);
    assert.equal(clientInspection.checksum, "valid");
    assert.equal(clientInspection.integrity, "valid");
    assert.equal(clientInspection.mode, mode);
    assert.equal(clientInspection.slot, "main");
    assert.equal(clientInspection.state.version, SYNTHETIC_FIXTURE_STATE_VERSION);
    assert.equal(clientInspection.state.mode, mode);
    assert.deepEqual(findForbiddenIdentityPaths(parsed), []);
    assert.equal(parsed.state.orbitalStation.stateVersion, 1);
    assert.equal(parsed.state.orbitalStation.status, mode === "normal" ? "eligible" : "locked");
    assert.equal(clientInspection.state.orbitalStation.stateVersion, 1);
    assert.equal(clientInspection.state.orbitalStation.status, mode === "normal" ? "eligible" : "locked");

    if (mode === "normal") {
      assert.equal(Object.hasOwn(parsed.state, "speedrun"), false);
    } else {
      assert.equal(parsed.state.settings.resourceMode, "finite");
      assert.equal(parsed.state.speedrun.enabled, true);
      assert.equal(parsed.state.speedrun.mode, "speedrun");
      assert.equal(parsed.state.speedrun.eligible, true);
      assert.match(parsed.state.speedrun.factoryId, /^synthetic_fixture_/);
      assert.equal(clientInspection.state.speedrun?.eligible, true);
    }

    const byId = new Map(parsed.state.entities.map((entity) => [entity.id, entity]));
    assert.equal(byId.get("syn_power_wind_stack").machineCount, 100_000_000);
    assert.equal(byId.get("syn_power_thermal_low_fuel").powerFactor, 0.25);
    assert.equal(byId.get("syn_station_planetary_demand").stationRoutes[0].scope, "local");
    assert.equal(byId.get("syn_station_interstellar_demand").stationRoutes[0].scope, "remote");
    assert.equal(byId.get("syn_quantum_supply").quantumMode, "quantum");
    assert.equal(byId.get("syn_machine_refinery_byproduct").outputs.hydrogen, 1_000_000);
    assert.equal(byId.get("syn_machine_fractionator_fluid").inputs.hydrogen, 1_000_000);
    assert.equal(byId.get("syn_storage_empty").outputs.iron_ingot, 0);
    assert.equal(byId.get("syn_storage_near_full").outputs.iron_ingot, 999_999);
    assert.equal(byId.get("syn_storage_full").outputs.iron_ingot, 1_000_000);
    assert.equal(byId.get("syn_vein_iron_finite").resourceRemaining, 4_500_000_000);
    assert.equal(Object.hasOwn(byId.get("syn_vein_water_infinite"), "resourceRemaining"), false);
    assert.ok(parsed.state.constructionAutomation.jobs.syn_construction_recursive_center.steps.length >= 3);
    assert.ok(parsed.state.dysonPlans.helios.layers[0].shells.length > 0);
    assert.equal(parsed.state.research.selectedTechId, "universe_matrix");
    assert.equal(parsed.state.quantumLogisticsNetwork.inventory.hydrogen, "10000000000");
    assert.deepEqual(
      Object.values(parsed.state.endgame.exportProjects).map((project) => project.priority),
      [1, 2, 3, 1],
    );
  }
});

test("mode and slot markers are independently content-addressed", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "dsp-synthetic-mode-slot-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const variants = [
    { mode: "normal", slot: 1 },
    { mode: "normal", slot: 2 },
    { mode: "speedrun", slot: 1 },
  ];
  const seenHashes = new Set();
  for (const variant of variants) {
    const outputPath = join(directory, syntheticFixtureFilename({ profile: "1m", ...variant }));
    const generated = await generateSyntheticSaveFixture({ profile: "1m", ...variant, outputPath });
    const parsed = JSON.parse(await readFile(outputPath, "utf8"));
    assert.equal(parsed.mode, variant.mode);
    assert.equal(parsed.state.mode, variant.mode);
    assert.equal(parsed.slot, variant.slot);
    assert.equal(parsed.state.syntheticFixture.slot, variant.slot);
    assert.equal(Object.hasOwn(parsed.state, "speedrun"), variant.mode === "speedrun");
    assert.equal(seenHashes.has(generated.sha256), false);
    seenHashes.add(generated.sha256);
  }
  assert.equal(seenHashes.size, variants.length);
});

test("29 MiB output completes under a 48 MiB V8 heap and hashes from disk without whole-file reads", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "dsp-synthetic-memory-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const child = spawnSync(process.execPath, [
    "--max-old-space-size=48",
    SYNTHETIC_FIXTURE_SCRIPT_PATH,
    "--profile=29m",
    "--mode=normal",
    `--output-dir=${directory}`,
    "--json",
  ], {
    cwd: process.cwd(),
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    timeout: 120_000,
  });
  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.status, 0, child.stderr);
  const generated = JSON.parse(child.stdout.trim());
  const outputPath = join(directory, syntheticFixtureFilename({ profile: "29m", mode: "normal", slot: "main" }));
  assert.equal((await stat(outputPath)).size, 29 * 1024 * 1024);
  assert.equal(generated.bytes, 29 * 1024 * 1024);
  assert.equal(generated.sha256, manifest.profiles["29m"].normal.sha256);
  assert.equal(generated.stateChecksum, manifest.profiles["29m"].normal.stateChecksum);
  assert.ok(generated.maxBufferedBytes <= 64 * 1024);
  assert.ok(generated.maxRecordBytes < 64 * 1024);
  assert.equal(await sha256File(outputPath), generated.sha256);
});

test("file generation refuses accidental replacement and explicit overwrite stays deterministic", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "dsp-synthetic-overwrite-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const outputPath = join(directory, syntheticFixtureFilename({ profile: "1m", mode: "normal", slot: "main" }));
  const first = await generateSyntheticSaveFixture({ profile: "1m", mode: "normal", outputPath });
  await assert.rejects(
    generateSyntheticSaveFixture({ profile: "1m", mode: "normal", outputPath }),
    (error) => error?.code === "EEXIST",
  );
  assert.equal(await sha256File(outputPath), first.sha256);
  const replaced = await generateSyntheticSaveFixture({ profile: "1m", mode: "normal", outputPath, overwrite: true });
  assert.equal(replaced.sha256, first.sha256);
  assert.equal(await sha256File(outputPath), first.sha256);
});
