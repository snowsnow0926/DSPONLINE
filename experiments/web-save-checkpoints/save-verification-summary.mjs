import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

if (!process.argv[2]) throw new Error("Pass the directory containing save-verify runs");
const directory = resolve(process.argv[2]);
const read = async (name) => JSON.parse(await readFile(resolve(directory, `${name}.json`), "utf8"));
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const baselineVerification = (await read("save-verify-slot-baseline-1")).stateVerification;
const verified = [];
async function group(action, variant) {
  const samples = [];
  for (let index = 1; index <= 3; index++) {
    const name = `save-verify-${action}-${variant}-${index}`;
    const sample = await read(name);
    const processes = await read(`${name}-processes`);
    const memory = [processes.find((entry) => entry.stage === "save complete")?.memory].flat();
    const serialized = sample.phaseTimings.find((phase) => Number.isFinite(phase.durationMs));
    const persisted = sample.phaseTimings.find((phase) => phase.type === "result");
    if (sample.catalog?.integrity !== "valid" || sample.catalog.stateChecksum !== "f51ab707" ||
      sample.catalog.entityCount !== 110_042 || sample.catalog.beltCount !== 233_300 ||
      sample.primary.stateChecksum !== sample.seeded.checksum || !serialized || !persisted || !memory[0]) {
      throw new Error(`Invalid sample ${name}`);
    }
    if (sample.stateVerification) {
      if (sample.stateVerification.sha256 !== baselineVerification.sha256 ||
        sample.stateVerification.canonicalFieldsSha256 !== baselineVerification.canonicalFieldsSha256) {
        throw new Error(`Complete saved-state mismatch in ${name}`);
      }
      verified.push(name);
    }
    samples.push({ name, durationMs: sample.durationMs, maxFrameGapMs: sample.maxFrameGapMs,
      serializationMs: serialized.durationMs, compressionMs: serialized.compressionDurationMs,
      persistenceValidationMs: persisted.workerDecodeMs, idbAndReadbackMs: persisted.idbWriteMs,
      transferredBytes: serialized.transferredBytes, payloadBytes: serialized.rawBytes,
      rendererLifetimePeakWorkingSetBytes: Math.max(...memory.map((entry) => entry.PeakWorkingSet64)),
      rendererFinalPrivateBytes: Math.max(...memory.map((entry) => entry.PrivateMemorySize64)),
      appAssets: sample.appAssets });
  }
  return { samples, medians: Object.fromEntries(Object.keys(samples[0])
    .filter((key) => typeof samples[0][key] === "number")
    .map((key) => [key, median(samples.map((sample) => sample[key]))])) };
}
const evidence = { schemaVersion: 1, sampleCountPerVariantAndAction: 3,
  scope: "paused normal-mode factory; production Chrome UI; isolated IndexedDB; no API writes",
  input: { sha256: "6a6aa320dd9d5fd5e5b618b745fc864c2ccb2d96143e0b852d1f270358de9ebf",
    preparedBytes: 205_464_026, entities: 110_042, belts: 233_300 },
  verification: { stateBytes: baselineVerification.stateBytes, sha256: baselineVerification.sha256,
    canonicalFieldsSha256: baselineVerification.canonicalFieldsSha256, verifiedRuns: verified }, actions: {} };
for (const action of ["slot", "snapshot"]) {
  const baseline = await group(action, "baseline");
  const candidate = await group(action, "candidate");
  evidence.actions[action] = { baseline, candidate,
    percentChange: Object.fromEntries(Object.keys(baseline.medians).map((key) => [key,
      baseline.medians[key] ? 100 * (candidate.medians[key] - baseline.medians[key]) / baseline.medians[key] : null])) };
}
const inspection = await read("inspection-regex-collected");
evidence.scanner = { bytes: inspection.bytes, samples: inspection.samples,
  medians: Object.fromEntries(["baseline", "candidate", "regexp"].map((name) => [name,
    median(inspection.samples.filter((sample) => sample.name === name).map((sample) => sample.durationMs))])) };
await writeFile(resolve(directory, "save-verification-evidence.json"), JSON.stringify(evidence, null, 2) + "\n");
console.log(JSON.stringify(evidence, null, 2));
