import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";

const require = createRequire(import.meta.url);
const { NativeHostClient, NativeSaveSessionRegistry } = require("../desktop/native-host.cjs");

const ENTITY_CHUNK_SIZE = 1_024;
const BELT_CHUNK_SIZE = 2_048;
const INTERNAL_PREFIX = "dsp-idle-network.internal.v1.chunked.v1.normal.";

function payloadIdentity(value) {
  let hash = 0x811c9dc5;
  let byteLength = 0;
  const mix = (byte) => {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
    byteLength += 1;
  };
  for (let index = 0; index < value.length; index += 1) {
    let code = value.charCodeAt(index);
    if (code <= 0x7f) mix(code);
    else if (code <= 0x7ff) {
      mix(0xc0 | code >> 6);
      mix(0x80 | code & 0x3f);
    } else {
      if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
        const low = value.charCodeAt(index + 1);
        if (low >= 0xdc00 && low <= 0xdfff) {
          code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
          index += 1;
          mix(0xf0 | code >> 18);
          mix(0x80 | code >> 12 & 0x3f);
          mix(0x80 | code >> 6 & 0x3f);
          mix(0x80 | code & 0x3f);
          continue;
        }
      }
      if (code >= 0xd800 && code <= 0xdfff) code = 0xfffd;
      mix(0xe0 | code >> 12);
      mix(0x80 | code >> 6 & 0x3f);
      mix(0x80 | code & 0x3f);
    }
  }
  return { checksum: (hash >>> 0).toString(16).padStart(8, "0"), byteLength };
}

function chunkRootChecksum(chunks) {
  return payloadIdentity(chunks.map((chunk) =>
    `${chunk.id}:${chunk.kind}:${chunk.offset}:${chunk.count}:${chunk.checksum}:${chunk.bytes};`).join("")).checksum;
}

async function writeSnapshot(sessions, ownerId, state, envelopeChecksum, revision, savedAtMs) {
  const startedAt = performance.now();
  const startedRss = process.memoryUsage().rss;
  const begin = await sessions.begin(ownerId, {
    slot: "normal-main",
    mode: "normal",
    stateVersion: 47,
    baseChecksum: envelopeChecksum,
    registryFingerprint: "00000000",
    revision,
    savedAtMs,
  });
  const chunks = [];
  let projectedBytes = 0;
  const put = async (id, kind, offset, value) => {
    const text = JSON.stringify(value);
    const identity = payloadIdentity(text);
    const count = Array.isArray(value) ? value.length : 1;
    chunks.push({ id, kind, offset, count, checksum: identity.checksum, bytes: identity.byteLength });
    projectedBytes += identity.byteLength;
    await sessions.write(ownerId, begin.transactionId, [{
      key: `${INTERNAL_PREFIX}chunk.${encodeURIComponent(id)}`,
      value: text,
    }]);
  };
  const { entities, belts, ...base } = state;
  await put("base", "base", 0, base);
  for (let offset = 0; offset < entities.length; offset += ENTITY_CHUNK_SIZE) {
    await put(`entities:${String(offset).padStart(8, "0")}`, "entities", offset, entities.slice(offset, offset + ENTITY_CHUNK_SIZE));
  }
  for (let offset = 0; offset < belts.length; offset += BELT_CHUNK_SIZE) {
    await put(`belts:${String(offset).padStart(8, "0")}`, "belts", offset, belts.slice(offset, offset + BELT_CHUNK_SIZE));
  }
  const manifest = {
    formatVersion: 1,
    envelopeFormatVersion: 2,
    mode: "normal",
    slot: "main",
    stateVersion: 47,
    savedAt: savedAtMs,
    basePrimaryChecksum: envelopeChecksum,
    chunkRootChecksum: chunkRootChecksum(chunks),
    totalBytes: projectedBytes,
    entityCount: entities.length,
    beltCount: belts.length,
    chunks,
  };
  await sessions.write(ownerId, begin.transactionId, [{ key: `${INTERNAL_PREFIX}manifest`, value: JSON.stringify(manifest) }]);
  const result = await sessions.commit(ownerId, begin.transactionId);
  return {
    ...result,
    durationMs: Number((performance.now() - startedAt).toFixed(2)),
    projectedBytes,
    rssDeltaBytes: process.memoryUsage().rss - startedRss,
  };
}

function mutateRuntimeFields(state) {
  state.elapsedSeconds += 1;
  for (const entity of state.entities) {
    if (typeof entity.progress === "number") entity.progress = Number((entity.progress + 0.000001).toFixed(6));
    if (typeof entity.productionRate === "number") entity.productionRate = Number((entity.productionRate + 0.01).toFixed(2));
  }
  for (const belt of state.belts) {
    if (typeof belt.lastFlow === "number") belt.lastFlow = Number((belt.lastFlow + 0.000001).toFixed(6));
    if (typeof belt.buffer === "number") belt.buffer = Number((belt.buffer + 0.000001).toFixed(6));
  }
}

function canonicalStateSha256(value) {
  const hash = createHash("sha256");
  const visit = (current) => {
    if (current === null || typeof current !== "object") {
      hash.update(JSON.stringify(current));
      return;
    }
    if (Array.isArray(current)) {
      hash.update("[");
      for (let index = 0; index < current.length; index += 1) {
        if (index > 0) hash.update(",");
        visit(current[index]);
      }
      hash.update("]");
      return;
    }
    hash.update("{");
    const keys = Object.keys(current).sort();
    for (let index = 0; index < keys.length; index += 1) {
      if (index > 0) hash.update(",");
      hash.update(JSON.stringify(keys[index]));
      hash.update(":");
      visit(current[keys[index]]);
    }
    hash.update("}");
  };
  visit(value);
  return hash.digest("hex");
}

async function verifyNativeRoundTrip(client, sourceState) {
  const recovery = await client.request({ operation: "saveRecover", slot: "normal-main" });
  const records = new Map();
  for (const key of recovery.recordKeys) {
    const read = await client.request({
      operation: "saveRead",
      slot: "normal-main",
      key,
      generation: recovery.generation,
      rootHash: recovery.rootHash,
    });
    records.set(key, read.value);
  }
  const manifest = JSON.parse(records.get(`${INTERNAL_PREFIX}manifest`));
  const values = new Map(manifest.chunks.map((chunk) => [
    chunk.id,
    records.get(`${INTERNAL_PREFIX}chunk.${encodeURIComponent(chunk.id)}`),
  ]));
  const base = JSON.parse(values.get("base"));
  const entities = new Array(manifest.entityCount);
  const belts = new Array(manifest.beltCount);
  for (const chunk of manifest.chunks) {
    if (chunk.kind === "base") continue;
    const target = chunk.kind === "entities" ? entities : belts;
    const parsed = JSON.parse(values.get(chunk.id));
    for (let index = 0; index < parsed.length; index += 1) target[chunk.offset + index] = parsed[index];
  }
  const roundTrip = { ...base, entities, belts };
  const sourceSha256 = canonicalStateSha256(sourceState);
  const roundTripSha256 = canonicalStateSha256(roundTrip);
  return {
    sourceSha256,
    roundTripSha256,
    matches: sourceSha256 === roundTripSha256,
    generation: recovery.generation,
    recordCount: recovery.recordKeys.length,
  };
}

async function main() {
  const fixture = path.resolve(process.argv[2] || "");
  if (!process.argv[2] || !fs.existsSync(fixture)) throw new Error("Usage: node scripts/benchmark-native-save.mjs <v47-envelope.json>");
  const binaryPath = path.resolve("native", "target", "release", process.platform === "win32" ? "dsp-native-host.exe" : "dsp-native-host");
  if (!fs.existsSync(binaryPath)) throw new Error("Build the release native host before benchmarking");
  const sourceBytes = fs.statSync(fixture).size;
  const envelope = JSON.parse(fs.readFileSync(fixture, "utf8"));
  if (envelope?.formatVersion !== 2 || envelope?.state?.version !== 47 || !Array.isArray(envelope.state.entities) || !Array.isArray(envelope.state.belts)) {
    throw new Error("Benchmark fixture is not a v47 / envelope v2 save");
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsp-native-save-benchmark-"));
  const client = new NativeHostClient({ binaryPath, rootPath: root, requestTimeoutMs: 300_000 });
  try {
    await client.start("native-save-benchmark");
    const sessions = new NativeSaveSessionRegistry(client);
    const first = await writeSnapshot(sessions, 1, envelope.state, envelope.checksum, 1, 1_000);
    const unchanged = await writeSnapshot(sessions, 1, envelope.state, envelope.checksum, 2, 2_000);
    const roundTrip = await verifyNativeRoundTrip(client, envelope.state);
    if (!roundTrip.matches) throw new Error("native v47 round-trip canonical SHA-256 mismatch");
    mutateRuntimeFields(envelope.state);
    const runtimeChurn = await writeSnapshot(sessions, 1, envelope.state, envelope.checksum, 3, 3_000);
    const report = {
      fixture: { path: fixture, sourceBytes, entityCount: envelope.state.entities.length, beltCount: envelope.state.belts.length },
      first,
      unchanged,
      roundTrip,
      runtimeChurn,
      reductions: {
        firstWriteVsSourcePercent: Number(((1 - first.changedBytes / sourceBytes) * 100).toFixed(2)),
        unchangedWriteVsSourcePercent: Number(((1 - unchanged.changedBytes / sourceBytes) * 100).toFixed(2)),
        runtimeChurnWriteVsSourcePercent: Number(((1 - runtimeChurn.changedBytes / sourceBytes) * 100).toFixed(2)),
      },
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    await client.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

await main();
