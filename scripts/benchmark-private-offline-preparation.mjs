import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { rolldown } from "rolldown";

// Private, read-only function-wall-time diagnostic. No save contents or player
// labels are emitted. This does not measure CPU usage, Electron or return-to-game.
const root = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const sourceHashes = { baseline: {}, candidate: {} };
let baselineSha, fixture, output, before, fixtureSha256, raw, outputAvailable = false;
let phase = "arguments", expectedStateSha256, expectedReportSha256, sourceStateSha256, metadata;
const report = {
  scope: "Node conservative settlement function wall time; includes the unchanged exact prefix and validation, excludes inspection/IO/Worker/UI; not a completed offline result",
  status: "FAILED", measuredAt: new Date().toISOString(), sourceHashes, pairs: [], warmups: [],
  method: { requestedPairs: 3, warmupPerVariant: 1, order: "alternating AB/BA", seconds: 600, wallSeconds: 600, explicitGcOutsideSamples: true, inspectionAndHashingOutsideSamples: true },
};

async function loadInspector(variant) {
  const bundle = await rolldown({
    input: path.join(root, "src/game/offlineApproximation.ts"),
    platform: "node",
    transform: { define: { "import.meta.env": '{DEV:false,PROD:true,MODE:"production",VITE_APP_PLATFORM:"desktop"}' } },
    plugins: [{
      name: "frozen-repository-sources",
      load(id) {
        const relative = path.relative(root, id).replaceAll("\\", "/");
        if (!relative.startsWith("src/") || !/\.(ts|tsx|json)$/.test(relative)) return null;
        const code = variant === "baseline"
          ? execFileSync("git", ["show", `${baselineSha}:${relative}`], { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 })
          : fs.readFileSync(id, "utf8");
        sourceHashes[variant][relative] = sha256(code);
        return relative === "src/game/offlineApproximation.ts"
          ? code + '\nexport { inspectSave as benchmarkInspectSave } from "./storage";\nexport { findInvalidFastNumber as benchmarkNumericValidation };\n'
          : code;
      },
    }],
  });
  try {
    const result = await bundle.generate({ format: "esm", codeSplitting: false });
    assert.equal(result.output.length, 1);
    return await import(`data:text/javascript;base64,${Buffer.from(result.output[0].code).toString("base64")}`);
  } finally { await bundle.close(); }
}

const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
function run(inspector) {
  let inspection;
  try { inspection = inspector.benchmarkInspectSave(raw); }
  catch { throw new Error("Private inspection threw; payload suppressed"); }
  assert.equal(inspection.valid, true, "Private inspection rejected; issues suppressed");
  assert.equal(inspection.checksum, "valid", "A verified source envelope is required");
  const inputHash = sha256(JSON.stringify(inspection.state));
  if (sourceStateSha256) assert.equal(inputHash, sourceStateSha256, "Input normalization differs; payload suppressed");
  else sourceStateSha256 = inputHash;
  globalThis.gc();
  const started = performance.now();
  const result = inspector.runConservativeOfflineSettlement(inspection.state, 600, 600, "fixed private benchmark", undefined, 0, undefined, true);
  const elapsedMs = performance.now() - started;
  assert.equal(result.status, "conservative", "Unexpected settlement status; payload suppressed");
  assert.equal(sha256(JSON.stringify(inspection.state)), inputHash, "Settlement mutated its source");
  const stateSha256 = sha256(JSON.stringify(result.state));
  const resultReportSha256 = sha256(JSON.stringify(result.report));
  if (expectedStateSha256) assert.equal(stateSha256, expectedStateSha256, "Complete candidate state mismatch; payload suppressed");
  else expectedStateSha256 = stateSha256;
  if (expectedReportSha256) assert.equal(resultReportSha256, expectedReportSha256, "Settlement report mismatch; details suppressed");
  else expectedReportSha256 = resultReportSha256;
  metadata = { formatVersion: inspection.formatVersion, stateVersion: inspection.stateVersion, entityCount: inspection.state.entities.length, beltCount: inspection.state.belts.length };
  return elapsedMs;
}
try {
  assert.equal(args.length, 6);
  assert.equal(args[0], "--baseline"); assert.match(args[1], /^[a-f0-9]{40}$/i);
  assert.equal(args[2], "--fixture"); assert.equal(args[4], "--output");
  baselineSha = args[1]; fixture = path.resolve(args[3]); output = path.resolve(args[5]);
  assert.equal(fs.existsSync(output), false); assert.notEqual(output, fixture);
  outputAvailable = true;
  assert.equal(typeof globalThis.gc, "function");
  phase = "environment";
  report.baselineSha = baselineSha;
  report.driverSha256 = sha256(fs.readFileSync(fileURLToPath(import.meta.url)));
  report.environment = {
    node: process.version, platform: process.platform, cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length,
    packageLockSha256: sha256(fs.readFileSync(path.join(root, "package-lock.json"))),
    rolldown: JSON.parse(fs.readFileSync(path.join(root, "node_modules/rolldown/package.json"), "utf8")).version,
    dependencies: "Both source variants use the same current installed dependencies and resolver",
  };
  phase = "read-source";
  before = fs.statSync(fixture);
  const bytes = fs.readFileSync(fixture);
  fixtureSha256 = sha256(bytes); raw = bytes.toString("utf8");
  phase = "bundle-baseline"; const baseline = await loadInspector("baseline");
  phase = "bundle-candidate"; const candidate = await loadInspector("candidate");
  phase = "synthetic-validator-differential";
  let seed = 0x7f10a54b;
  const random = maximum => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % maximum; };
  const names = ['field', 'inventory', 'stationRoutes', 'cargo', 'remainingCargo', 'warpers', 'derivedKw', 'totalDestroyed'];
  const values = [0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, 1e30, Infinity, -Infinity, NaN, '0', '12', '1.5', '-1', null];
  const verifyNumeric = value => assert.equal(candidate.benchmarkNumericValidation(value), baseline.benchmarkNumericValidation(value), 'Synthetic numeric validation differs');
  for (let index = 0; index < 1024; index++) {
    let value = values[random(values.length)];
    for (let depth = 0; depth < 1 + random(8); depth++) value = random(3) === 0 ? [0, value, 'ordinary'] : { derivedKw: 1e20, [names[random(names.length)]]: value, tail: '0' };
    verifyNumeric(value);
  }
  const shared = { unsafe: Number.MAX_SAFE_INTEGER + 1 };
  verifyNumeric({ derivedKw: shared, inventory: shared });
  const cyclic = { safe: 1 }; cyclic.self = cyclic; verifyNumeric(cyclic);
  report.syntheticNumericDifferentialCases = 1026;
  for (const variant of ["baseline", "candidate"]) {
    phase = `warmup-${variant}`;
    report.warmups.push({ variant, wallMs: run(variant === "baseline" ? baseline : candidate) });
  }
  for (let index = 0; index < report.method.requestedPairs; index += 1) {
    const order = index % 2 === 0 ? ["baseline", "candidate"] : ["candidate", "baseline"];
    const pair = { index, order };
    report.pairs.push(pair); // Preserve a first sample even if its paired run fails.
    for (const variant of order) {
      phase = `pair-${index}-${variant}`;
      pair[`${variant}Ms`] = run(variant === "baseline" ? baseline : candidate);
      console.log(JSON.stringify({ stage: 'sample', index, variant, wallMs: pair[`${variant}Ms`] }));
    }
  }
  report.baselineMedianMs = median(report.pairs.map(pair => pair.baselineMs));
  report.candidateMedianMs = median(report.pairs.map(pair => pair.candidateMs));
  report.medianReductionPercent = 100 * (report.baselineMedianMs - report.candidateMedianMs) / report.baselineMedianMs;
  report.equalInAllSamples = true;
  report.status = "PASS";
} catch {
  report.failureStage = phase;
  process.exitCode = 1; // Never print the original exception, inspected state or issues.
} finally {
  let sourceUnchanged = null;
  if (before && fixtureSha256) {
    try {
      const after = fs.statSync(fixture);
      sourceUnchanged = after.size === before.size && after.mtimeMs === before.mtimeMs && sha256(fs.readFileSync(fixture)) === fixtureSha256;
    } catch { sourceUnchanged = false; }
    report.fixture = { sha256: fixtureSha256, byteLength: before.size, sourceUnchanged, ...metadata };
  }
  if (sourceUnchanged !== true && report.status === "PASS") { report.status = "FAILED"; report.failureStage = "source-integrity"; process.exitCode = 1; }
  report.completedPairs = report.pairs.filter(pair => Number.isFinite(pair.baselineMs) && Number.isFinite(pair.candidateMs)).length;
  if (expectedStateSha256) report.candidateStateSha256 = expectedStateSha256;
  if (expectedReportSha256) report.settlementReportSha256 = expectedReportSha256;
  if (sourceStateSha256) report.sourceStateSha256 = sourceStateSha256;
  if (outputAvailable) {
    try { fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" }); }
    catch { report.status = "FAILED"; report.failureStage = "evidence-write"; process.exitCode = 1; }
  }
  console.log(JSON.stringify({ status: report.status, failureStage: report.failureStage, completedPairs: report.completedPairs, baselineMedianMs: report.baselineMedianMs, candidateMedianMs: report.candidateMedianMs, medianReductionPercent: report.medianReductionPercent, equalInAllSamples: report.equalInAllSamples ?? false, sourceUnchanged }));
}
