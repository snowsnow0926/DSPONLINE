import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

if (!process.argv[2]) throw new Error("Pass the directory containing completed checkpoint-save runs");
const directory = resolve(process.argv[2]);
const read = async (name) => JSON.parse(await readFile(resolve(directory, `${name}.json`), "utf8"));
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const aggregate = async (action, variant) => {
  const samples = [];
  for (let run = 1; run <= 3; run++) {
    const name = `app-${action}-${variant}-${run}`;
    const result = await read(name);
    const processes = await read(`${name}-processes`);
    const afterSave = processes.find((sample) => sample.stage === "save complete");
    if (!afterSave || !result.catalog || result.catalog.integrity !== "valid" ||
      result.catalog.entityCount !== 110_042 || result.catalog.beltCount !== 233_300 ||
      result.primary.stateChecksum !== result.seeded.checksum || result.shell.worker !== "active") {
      throw new Error(`Invalid evidence: ${name}`);
    }
    const memory = [afterSave.memory].flat();
    samples.push({ name, durationMs: result.durationMs, maxFrameGapMs: result.maxFrameGapMs,
      longTaskTotalMs: result.longTasks.reduce((sum, value) => sum + value, 0),
      largestStateCopyMs: Math.max(0, ...result.workerCalls.filter((call) => call.entities).map((call) => call.duration)),
      rendererLifetimePeakWorkingSetBytes: Math.max(...memory.map((row) => row.PeakWorkingSet64)),
      rendererFinalPrivateBytes: Math.max(...memory.map((row) => row.PrivateMemorySize64)),
      stateChecksum: result.catalog.stateChecksum, appAssets: result.appAssets });
  }
  return { samples, medians: Object.fromEntries([
    "durationMs", "maxFrameGapMs", "longTaskTotalMs", "largestStateCopyMs",
    "rendererLifetimePeakWorkingSetBytes", "rendererFinalPrivateBytes",
  ].map((key) => [key, median(samples.map((sample) => sample[key]))])) };
};
const baselineProof = (await read("app-slot-baseline-canonical")).stateVerification;
const proofs = ["app-slot-checkpoint-canonical", "app-snapshot-checkpoint-canonical"];
const verifiedCandidates = [];
for (const name of proofs) {
  const proof = (await read(name)).stateVerification;
  const changedFields = Object.keys({ ...baselineProof.fields, ...proof.fields })
    .filter((key) => baselineProof.fields[key] !== proof.fields[key]);
  if (changedFields.length || baselineProof.canonicalFieldsSha256 !== proof.canonicalFieldsSha256) {
    throw new Error(`State values differ in ${name}: ${changedFields.join(", ")}`);
  }
  verifiedCandidates.push({ name, stateBytes: proof.stateBytes, originalOrderSha256: proof.sha256,
    canonicalFieldsSha256: proof.canonicalFieldsSha256, changedFields });
}
const evidence = { schemaVersion: 1, sampleCountPerVariantAndAction: 3,
  input: { bytes: 205_464_026, sha256: "6a6aa320dd9d5fd5e5b618b745fc864c2ccb2d96143e0b852d1f270358de9ebf",
    entities: 110_042, belts: 233_300, paused: true, timeWarpEnabled: false, autosaveIntervalSeconds: 0 },
  verification: { canonicalFieldsSha256: baselineProof.canonicalFieldsSha256,
    comparedTopLevelFields: Object.keys(baselineProof.fields).length, stateBytes: baselineProof.stateBytes,
    originalOrderSha256: baselineProof.sha256, candidates: verifiedCandidates },
  actions: {} };
for (const action of ["slot", "snapshot"]) {
  const baseline = await aggregate(action, "baseline");
  const checkpoint = await aggregate(action, "checkpoint");
  const changePercent = Object.fromEntries(Object.keys(baseline.medians).map((key) => [key,
    100 * (checkpoint.medians[key] - baseline.medians[key]) / baseline.medians[key],
  ]));
  evidence.actions[action] = { baseline, checkpoint, changePercent };
}
await writeFile(resolve(directory, "auxiliary-checkpoint-evidence.json"), JSON.stringify(evidence, null, 2) + "\n");
console.log(JSON.stringify(evidence, null, 2));
