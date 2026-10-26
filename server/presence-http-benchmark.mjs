// Synthetic, local-only HTTP workload. Never reads a production database.
// node --expose-gc server/presence-http-benchmark.mjs --duration-ms 90000
// Optional --module <local server/index.mjs> allows an unchanged baseline run.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { computeSaveStateChecksum } from "./save-integrity.mjs";

const args = process.argv.slice(2);
const option = (key, fallback) => { const i = args.indexOf(key); return i < 0 ? fallback : args[i + 1]; };
const durationMs = Number(option("--duration-ms", 90_000));
assert.ok(Number.isFinite(durationMs) && durationMs >= 1000 && durationMs <= 600_000);
const modulePath = path.resolve(option("--module", fileURLToPath(new URL("./index.mjs", import.meta.url))));
const { createCloudServer } = await import(pathToFileURL(modulePath).href);
const root = path.resolve(fileURLToPath(new URL("../artifacts/presence-benchmark/", import.meta.url)));
await mkdir(root, { recursive: true });
const directory = await mkdtemp(path.join(root, "run-"));
const sha = (value) => createHash("sha256").update(value).digest("hex");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const id = (i) => `synthetic_bench_player_${String(i).padStart(20, "0")}`;
const server = await createCloudServer({ databaseFile: path.join(directory, "cloud.sqlite"), backupDirectory: "", backupIntervalMs: 0, historyPruneIntervalMs: 0, logger: { error() {} } });
let fullMutations = 0, cleanupCommits = 0;
const originalCreate = server.store.createStandaloneMutation.bind(server.store);
server.store.createStandaloneMutation = (...values) => { fullMutations += 1; return originalCreate(...values); };
const unsubscribe = server.store.onCommitted(({ context }) => { if (context.operation === "periodic.cleanup") cleanupCommits += 1; });
try {
  const state = { version: 24, elapsedSeconds: 600, entities: [], totalProduced: {}, metrics: { generationKw: 0, totalItemsPerMinute: 0, rayGenerationKw: 0 }, exploration: { unlockedSystemIds: ["helios"], colonizedPlanetIds: ["home"] } };
  const payload = JSON.stringify({ formatVersion: 2, savedAt: 1, state, checksum: computeSaveStateChecksum(2, state) });
  const checksum = sha(payload);
  const now = Date.now(), today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  await server.store.mutate((store) => {
    for (let i = 0; i < 2000; i += 1) {
      const userId = `synthetic-user-${i}`;
      store.data.users[userId] = { id: userId, username: `bench_${i}`, displayName: `Synthetic ${i}`, createdAt: now, email: "", emailVerified: false };
      const history = [];
      for (let revision = 1; revision <= 20; revision += 1) {
        history.push(store.stageCloudSavePayload(userId, "main", {
          revision, payload, checksum, size: Buffer.byteLength(payload), updatedAt: now, savedAt: 1, stateVersion: 24,
          summary: { elapsedSeconds: 600, entityCount: 0, beltCount: 0, technologyCount: 0, syntheticDescription: "metadata".repeat(20) },
        }));
      }
      store.data.cloudSaves[userId] = history.at(-1);
      store.data.cloudSaveHistory[userId] = history;
    }
    for (let i = 0; i < 16_000; i += 1) store.data.players[sha(`player:${id(i)}`)] = { firstSeenAt: now - 3600_000, lastSeenAt: now - 3600_000, lastActiveDay: today };
    store.recordRuntimeIndexEvent({ type: "rebuild" });
  }, { operation: "benchmark.seed" });
  const metadataBytes = Buffer.byteLength(JSON.stringify(server.store._data));
  const savedDigest = () => sha(JSON.stringify([server.store._data.cloudSaves, server.store._data.cloudSaveHistory]));
  const beforeDigest = savedDigest(), beforeMutations = fullMutations;
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const requestTimes = [], probeTimes = [], samples = [];
  let accepted = 0, failed = 0, probeFailures = 0, sequence = 0;
  const started = performance.now(), deadline = started + durationMs;
  console.log(JSON.stringify({ phase: "started", syntheticOnly: true, metadataBytes, accounts: 2000, revisions: 40000, players: 16000, durationMs, concurrency: 8, targetRequestsPerSecond: 20 }));
  const workers = Array.from({ length: 8 }, async () => {
    while (performance.now() < deadline) {
      const index = sequence++, at = performance.now();
      try {
        const response = await fetch(base + "/api/presence", {
          method: "POST", signal: AbortSignal.timeout(5000),
          headers: { "content-type": "application/json", "x-forwarded-for": `198.18.${Math.floor(index / 250) % 250}.${index % 250 + 1}` },
          body: JSON.stringify({ playerId: id(index % 2000) }),
        });
        await response.arrayBuffer();
        if (response.status === 202) accepted += 1; else failed += 1;
      } catch { failed += 1; }
      requestTimes.push(performance.now() - at);
      await sleep(Math.max(0, 400 - (performance.now() - at)));
    }
  });
  const probes = (async () => {
    while (performance.now() < deadline) {
      for (const route of ["health", "ready"]) {
        const at = performance.now();
        try {
          const response = await fetch(base + `/api/${route}`, { signal: AbortSignal.timeout(2000) });
          await response.arrayBuffer(); if (response.status !== 200) probeFailures += 1;
        } catch { probeFailures += 1; }
        probeTimes.push(performance.now() - at);
      }
      if (!samples.length || performance.now() - samples.at(-1).elapsedMs - started >= 10_000) {
        global.gc?.();
        samples.push({ elapsedMs: Math.round(performance.now() - started), ...process.memoryUsage(), pendingWrites: server.store.pendingWriteOperations });
        console.log(JSON.stringify({ phase: "sample", ...samples.at(-1), accepted, failed, cleanupCommits }));
      }
      await sleep(300);
    }
  })();
  await Promise.all([...workers, probes]);
  await server.store.drain();
  global.gc?.();
  const percentile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * fraction))];
  const result = {
    syntheticOnly: true, modulePath, durationMs: performance.now() - started, metadataBytes,
    accepted, failed, probeFailures, probes: probeTimes.length,
    requestP95Ms: percentile(requestTimes, 0.95), probeP95Ms: percentile(probeTimes, 0.95),
    fullMutations: fullMutations - beforeMutations, cleanupCommits,
    savesPreserved: savedDigest() === beforeDigest, payloadRows: server.store.database.prepare("SELECT count(*) AS n FROM cloud_save_payloads").get().n,
    pendingWrites: server.store.pendingWriteOperations, finalMemory: process.memoryUsage(), samples,
  };
  assert.equal(result.savesPreserved, true);
  assert.equal(result.payloadRows, 40000);
  await writeFile(path.join(directory, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ phase: "complete", resultPath: path.join(directory, "result.json"), ...result }));
} finally {
  unsubscribe(); await server.shutdown();
  // Delete only this run's generated SQLite files; keep the result evidence.
  for (const suffix of ["", "-wal", "-shm"]) await rm(path.join(directory, `cloud.sqlite${suffix}`), { force: true });
}
