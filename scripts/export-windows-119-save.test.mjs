import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { access, cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { chromium } from "@playwright/test";
import { exportWindows119Save } from "./export-windows-119-save.mjs";
import {
  chunkedManifestKey,
  chunkedRecordKey,
  computeChunkRootChecksum,
  computePayloadTextIdentity,
  computeSaveStateChecksumFromJson,
  inspectWindows119Envelope,
  joinMaterializedSave,
  materializeWindows119Save,
  primaryKeyForMode,
  writeMaterializedSave,
} from "./windows-119-save-export-lib.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const readerPageUrl = pathToFileURL(join(scriptDirectory, "windows-119-save-reader.html")).href;

function sampleState(overrides = {}) {
  return {
    version: 47,
    mode: "normal",
    activePlanetId: "planet_home",
    elapsedSeconds: 119,
    research: { completedTechIds: ["automation"] },
    dysonSphere: { structurePoints: 17 },
    entities: [{ id: "entity-1", label: "测试🚀" }],
    belts: [{ id: "belt-1", fromId: "entity-1", toId: "entity-2" }],
    ...overrides,
  };
}

function envelopeForState(state, savedAt) {
  const stateJson = JSON.stringify(state);
  const checksum = computeSaveStateChecksumFromJson(2, stateJson);
  return JSON.stringify({
    formatVersion: 2,
    kind: "primary",
    mode: state.mode,
    slot: "main",
    savedAt,
    state,
    checksum,
  });
}

function sidecarForState(state, basePrimaryChecksum, savedAt) {
  const { entities, belts, ...base } = state;
  const values = [{ id: "base", kind: "base", offset: 0, value: base }];
  const addCollection = (kind, collection, chunkSize) => {
    if (collection.length === 0) {
      values.push({ id: `${kind}:00000000`, kind, offset: 0, value: [] });
      return;
    }
    for (let offset = 0; offset < collection.length; offset += chunkSize) {
      values.push({
        id: `${kind}:${String(offset).padStart(8, "0")}`,
        kind,
        offset,
        value: collection.slice(offset, offset + chunkSize),
      });
    }
  };
  addCollection("entities", entities, 1_024);
  addCollection("belts", belts, 2_048);
  const chunks = values.map((part) => {
    const text = JSON.stringify(part.value);
    const identity = computePayloadTextIdentity(text);
    return {
      text,
      metadata: {
        id: part.id,
        kind: part.kind,
        offset: part.offset,
        count: Array.isArray(part.value) ? part.value.length : 1,
        checksum: identity.checksum,
        bytes: identity.byteLength,
      },
    };
  });
  const metadata = chunks.map((chunk) => chunk.metadata);
  const manifest = {
    formatVersion: 1,
    envelopeFormatVersion: 2,
    mode: state.mode,
    slot: "main",
    stateVersion: 47,
    savedAt,
    basePrimaryChecksum,
    chunkRootChecksum: computeChunkRootChecksum(metadata),
    totalBytes: metadata.reduce((sum, chunk) => sum + chunk.bytes, 0),
    entityCount: entities.length,
    beltCount: belts.length,
    chunks: metadata,
  };
  const records = new Map([[chunkedManifestKey(state.mode), JSON.stringify(manifest)]]);
  for (const chunk of chunks) records.set(chunkedRecordKey(state.mode, chunk.metadata.id), chunk.text);
  return { manifest, records };
}

async function hashTree(rootPath) {
  const hash = createHash("sha256");
  let files = 0;
  const walk = async (path) => {
    const metadata = await lstat(path);
    const name = relative(rootPath, path).replaceAll("\\", "/");
    if (metadata.isDirectory()) {
      hash.update(`d:${name}\n`);
      const children = await readdir(path);
      children.sort();
      for (const child of children) await walk(join(path, child));
      return;
    }
    assert.equal(metadata.isFile(), true);
    hash.update(`f:${name}:${metadata.size}\n`);
    hash.update(await readFile(path));
    files += 1;
  };
  await walk(rootPath);
  return { sha256: hash.digest("hex"), files };
}

async function seedIndexedDb(userDataPath, records, seedPageUrl = readerPageUrl) {
  const context = await chromium.launchPersistentContext(userDataPath, { headless: true });
  try {
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(seedPageUrl, { waitUntil: "load" });
    await page.evaluate(async (input) => {
      const database = await new Promise((resolve, reject) => {
        const request = indexedDB.open("dsp-idle-network.local-saves", 2);
        request.onupgradeneeded = () => {
          if (!request.result.objectStoreNames.contains("records")) {
            request.result.createObjectStore("records", { keyPath: "key" });
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      await new Promise((resolve, reject) => {
        const transaction = database.transaction("records", "readwrite");
        const store = transaction.objectStore("records");
        for (const record of input) store.put(record);
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
      database.close();
    }, records);
  } finally {
    await context.close();
  }
}

test("validates a 1.1.9 primary and writes a verified gzip without overwriting", async () => {
  const state = sampleState();
  const raw = envelopeForState(state, 1_700_000_000_000);
  const inspection = inspectWindows119Envelope(raw);
  assert.equal(inspection.state.version, 47);
  assert.equal(inspection.state.entityCount, 1);
  assert.equal(inspection.state.beltCount, 1);

  const materialized = await materializeWindows119Save({ baseRaw: raw, readInternalRecord: async () => null });
  assert.equal(materialized.source, "primary");
  assert.equal(joinMaterializedSave(materialized), raw);

  const temporaryRoot = await mkdtemp(join(tmpdir(), "dspidle119-unit-"));
  const outputPath = join(temporaryRoot, "save.json.gz");
  try {
    const result = await writeMaterializedSave(materialized, outputPath);
    assert.equal(gunzipSync(await readFile(outputPath)).toString("utf8"), raw);
    assert.equal(result.uncompressedByteLength, Buffer.byteLength(raw));
    await assert.rejects(() => writeMaterializedSave(materialized, outputPath), /已存在，未覆盖/);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("exports the newer valid sidecar and safely falls back when a chunk is corrupt", async () => {
  const oldState = sampleState({ elapsedSeconds: 119 });
  const oldRaw = envelopeForState(oldState, 1_700_000_000_000);
  const oldChecksum = inspectWindows119Envelope(oldRaw).recordedChecksum;
  const latestState = sampleState({
    elapsedSeconds: 219,
    entities: [...oldState.entities, { id: "entity-2", label: "new" }],
  });
  const sidecar = sidecarForState(latestState, oldChecksum, 1_700_000_100_000);
  const readRecord = async (key) => sidecar.records.get(key) ?? null;

  const latest = await materializeWindows119Save({ baseRaw: oldRaw, readInternalRecord: readRecord });
  assert.equal(latest.source, "chunked-sidecar");
  assert.deepEqual(JSON.parse(joinMaterializedSave(latest)).state, latestState);
  assert.equal(latest.inspection.state.elapsedSeconds, 219);

  sidecar.records.set(chunkedRecordKey("normal", "entities:00000000"), "[]");
  const fallback = await materializeWindows119Save({ baseRaw: oldRaw, readInternalRecord: readRecord });
  assert.equal(fallback.source, "primary");
  assert.equal(joinMaterializedSave(fallback), oldRaw);
  assert.match(fallback.warnings[0], /已导出较旧的完整主档/);
});

test("joins multiple 1.1.9 entity and belt chunks without building a second full object graph", async () => {
  const oldRaw = envelopeForState(sampleState(), 1_700_000_000_000);
  const oldChecksum = inspectWindows119Envelope(oldRaw).recordedChecksum;
  const latestState = sampleState({
    elapsedSeconds: 519,
    entities: Array.from({ length: 1_025 }, (_, index) => ({ id: `entity-${index}`, value: index })),
    belts: Array.from({ length: 2_049 }, (_, index) => ({ id: `belt-${index}`, fromId: "a", toId: "b" })),
  });
  const sidecar = sidecarForState(latestState, oldChecksum, 1_700_000_500_000);
  const materialized = await materializeWindows119Save({
    baseRaw: oldRaw,
    readInternalRecord: async (key) => sidecar.records.get(key) ?? null,
  });
  const restoredRaw = joinMaterializedSave(materialized);
  const restored = JSON.parse(restoredRaw);
  const inspection = inspectWindows119Envelope(restoredRaw);

  assert.equal(materialized.source, "chunked-sidecar");
  assert.equal(sidecar.manifest.chunks.filter((chunk) => chunk.kind === "entities").length, 2);
  assert.equal(sidecar.manifest.chunks.filter((chunk) => chunk.kind === "belts").length, 2);
  assert.equal(restored.state.entities.length, 1_025);
  assert.equal(restored.state.entities.at(-1).id, "entity-1024");
  assert.equal(restored.state.belts.length, 2_049);
  assert.equal(restored.state.belts.at(-1).id, "belt-2048");
  assert.equal(inspection.state.entityCount, 1_025);
  assert.equal(inspection.state.beltCount, 2_049);
});

let chromiumAvailable = false;
try {
  await access(chromium.executablePath());
  chromiumAvailable = true;
} catch { /* Playwright browser is optional in minimal CI images. */ }

test("copies an Electron-shaped IndexedDB profile, exports it, and leaves every source byte unchanged", {
  skip: chromiumAvailable ? false : "Playwright Chromium 未安装",
}, async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "dspidle119-integration-"));
  const seedUserData = join(temporaryRoot, "seed-browser");
  const sourceProfile = join(temporaryRoot, "electron-profile");
  const outputPath = join(temporaryRoot, "export.json.gz");
  try {
    const oldState = sampleState({ elapsedSeconds: 319 });
    const oldRaw = envelopeForState(oldState, 1_700_000_200_000);
    const oldChecksum = inspectWindows119Envelope(oldRaw).recordedChecksum;
    const latestState = sampleState({ elapsedSeconds: 419, belts: [] });
    const sidecar = sidecarForState(latestState, oldChecksum, 1_700_000_300_000);
    const values = new Map([[primaryKeyForMode("normal"), oldRaw], ...sidecar.records]);
    const now = Date.now();
    const storedRecords = [...values].map(([key, value]) => ({
      key,
      value,
      updatedAt: now,
      bytes: new TextEncoder().encode(value).byteLength,
    }));
    const installedGamePage = join(temporaryRoot, "installed-game", "dist", "index.html");
    await mkdir(dirname(installedGamePage), { recursive: true });
    await writeFile(installedGamePage, "<!doctype html><meta charset=\"utf-8\"><title>synthetic installed game</title>", "utf8");
    await seedIndexedDb(seedUserData, storedRecords, pathToFileURL(installedGamePage).href);
    await mkdir(sourceProfile, { recursive: true });
    await cp(join(seedUserData, "Default", "IndexedDB"), join(sourceProfile, "IndexedDB"), {
      recursive: true,
      force: false,
      errorOnExist: true,
      preserveTimestamps: true,
    });
    const before = await hashTree(sourceProfile);

    const result = await exportWindows119Save({
      profilePath: sourceProfile,
      outputPath,
      mode: "normal",
      chromium,
      skipProcessCheck: true,
    });
    const after = await hashTree(sourceProfile);
    assert.deepEqual(after, before);
    assert.equal(result.saveSource, "chunked-sidecar");
    assert.equal(result.inspection.state.elapsedSeconds, 419);
    const exported = JSON.parse(gunzipSync(await readFile(outputPath)).toString("utf8"));
    assert.deepEqual(exported.state, latestState);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
