import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { rolldown } from "rolldown";

// CPU microbenchmark only: synthetic serialization payloads, no game loading,
// simulation, Worker transfer, renderer responsiveness or process-tree memory.
// node --expose-gc scripts/benchmark-save-transfer.mjs --baseline <full SHA> --output artifacts/<new-report>.json
const root = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
assert.equal(args.length, 4, "Expected --baseline <full SHA> --output <new JSON path>");
assert.equal(args[0], "--baseline");
assert.match(args[1], /^[a-f0-9]{40}$/i);
assert.equal(args[2], "--output");
assert.equal(typeof globalThis.gc, "function", "Run with --expose-gc; collection is outside every timed sample");
const baselineSha = args[1];
const output = path.resolve(root, args[3]);
assert.equal(fs.existsSync(output), false, "Refusing to overwrite benchmark evidence");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const sourcePaths = ["src/game/saveTransfer.ts", "src/game/saveEnvelopeIntegrity.ts", "src/game/payloadTextChecksum.ts"];
const readBaseline = (file) => execFileSync("git", ["show", `${baselineSha}:${file}`], { cwd: root, encoding: "utf8" });

async function loadSerializer(baseline) {
  const sources = new Map(sourcePaths.map((file) => [
    `/benchmark/${path.basename(file)}`,
    baseline ? readBaseline(file) : fs.readFileSync(path.join(root, file), "utf8"),
  ]));
  const sourceHashes = Object.fromEntries([...sources].map(([file, source]) => [path.basename(file), sha256(source)]));
  const entry = "/benchmark/saveTransfer.ts";
  // Expose the baseline's actual private length pass for the phase comparison.
  // All baseline serializer/helper implementations come from the pinned commit.
  sources.set(entry, sources.get(entry) + (baseline
    ? "\nexport function benchmarkMeasure(formatVersion, stateJson) { return { stateChecksum: computeSaveStateChecksumFromJson(formatVersion, stateJson), byteLength: utf8Length(stateJson) }; }\n"
    : "\nexport { measureSaveStateJson as benchmarkMeasure } from './saveEnvelopeIntegrity';\n"));
  const bundle = await rolldown({
    input: entry,
    platform: "browser",
    plugins: [{
      name: "pinned-save-transfer-sources",
      resolveId(source, importer) {
        const resolved = source.startsWith(".") ? path.posix.resolve(path.posix.dirname(importer), source) : source;
        const id = resolved.endsWith(".ts") ? resolved : `${resolved}.ts`;
        if (sources.has(id)) return id;
        throw new Error(`Unpinned benchmark dependency: ${source}`);
      },
      load(id) { return sources.get(id); },
    }],
  });
  try {
    const generated = await bundle.generate({ format: "esm", codeSplitting: false });
    assert.equal(generated.output.length, 1);
    const module = await import(`data:text/javascript;base64,${Buffer.from(generated.output[0].code).toString("base64")}`);
    return { module, sourceHashes };
  } finally {
    await bundle.close();
  }
}

const baseline = await loadSerializer(true);
const candidate = await loadSerializer(false);
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const samples = 9;
const options = { formatVersion: 2, kind: "primary", savedAt: 1800000000000, mode: "normal", slot: "main", reason: "synthetic CPU fixture" };
const results = [];
for (const count of [4096, 32768]) {
  for (const charset of ["ascii", "unicode"]) {
    const state = {
      version: 47,
      mode: "normal",
      label: "synthetic-save-transfer-v1",
      entities: Array.from({ length: count }, (_, index) => ({
        id: `synthetic-${index}`,
        kind: "storage",
        planetId: "home",
        name: charset === "ascii" ? "iron-storage" : "磁石🚀工厂\ud800边界",
        position: { x: index * 4, y: index % 97 },
        inputs: { iron_ore: index % 1000 },
        outputs: { iron_ingot: index % 500 },
        progress: 0.125,
        nested: { text: "\n\t\"\\", enabled: true },
      })),
      belts: [],
    };
    const stateJson = JSON.stringify(state);
    const expected = baseline.module.serializeSaveEnvelopeToTransfer(state, options);
    const expectedMeasure = baseline.module.benchmarkMeasure(2, stateJson);
    const expectedBytes = new Uint8Array(expected.bytes);
    const fixture = { id: `synthetic-save-transfer-v1-${charset}-${count}`, entityCount: count, stateUtf8Bytes: Buffer.byteLength(stateJson), stateJsonSha256: sha256(stateJson), envelopeSha256: sha256(expectedBytes), phases: {} };
    for (const phase of ["checksum-and-utf8-length", "complete-serialization"]) {
      const run = (variant) => phase === "checksum-and-utf8-length"
        ? variant.module.benchmarkMeasure(2, stateJson)
        : variant.module.serializeSaveEnvelopeToTransfer(state, options);
      const verify = (result) => {
        if (phase === "checksum-and-utf8-length") assert.deepEqual(result, expectedMeasure);
        else {
          assert.deepEqual(new Uint8Array(result.bytes), expectedBytes);
          assert.equal(result.stateChecksum, expected.stateChecksum);
          assert.equal(result.payloadChecksum, expected.payloadChecksum);
          assert.equal(result.byteLength, expected.byteLength);
          assert.equal(result.integrity, "valid");
        }
      };
      for (let warmup = 0; warmup < 2; warmup += 1) {
        verify(run(baseline));
        verify(run(candidate));
      }
      const pairs = [];
      for (let sample = 0; sample < samples; sample += 1) {
        const order = sample % 2 === 0 ? ["baseline", "candidate"] : ["candidate", "baseline"];
        const pair = { sample, order };
        for (const name of order) {
          globalThis.gc();
          const started = performance.now();
          const result = run(name === "baseline" ? baseline : candidate);
          pair[`${name}Ms`] = performance.now() - started;
          verify(result);
        }
        pairs.push(pair);
      }
      const baselineMedianMs = median(pairs.map((pair) => pair.baselineMs));
      const candidateMedianMs = median(pairs.map((pair) => pair.candidateMs));
      fixture.phases[phase] = { baselineMedianMs, candidateMedianMs, medianReductionPercent: 100 * (baselineMedianMs - candidateMedianMs) / baselineMedianMs, pairs, verified: true };
      process.stdout.write(`${fixture.id} ${phase}: ${baselineMedianMs.toFixed(2)} -> ${candidateMedianMs.toFixed(2)} ms\n`);
    }
    results.push(fixture);
  }
}
const report = {
  kind: "synthetic-save-transfer-cpu-microbenchmark-not-application-speedup",
  measuredAt: new Date().toISOString(),
  baselineSha,
  baselineSourceHashes: baseline.sourceHashes,
  candidateSourceHashes: candidate.sourceHashes,
  driverSha256: sha256(fs.readFileSync(fileURLToPath(import.meta.url))),
  environment: { node: process.version, platform: process.platform, arch: process.arch, cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length, processPriority: os.getPriority(), explicitGcOutsideSamples: true },
  method: { samples, warmupPerVariant: 2, pairing: "alternating AB/BA", independentProcesses: 1, scope: "CPU stage only; synthetic objects, no player state or app timings", options },
  results,
};
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
process.stdout.write(`Report: ${output}\n`);
