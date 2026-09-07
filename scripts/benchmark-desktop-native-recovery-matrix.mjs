import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { verifyDesktopBuildEvidence } = require("../desktop/desktop-artifact-evidence.cjs");
const { PERFORMANCE_EDITION_IDENTITY: identity } = require("../desktop/performance-edition-identity.cjs");

const [baselineRoot, baselineSha, candidateRoot, candidateSha, fixtureRoot, outputArg] = process.argv.slice(2);
if (!outputArg || ![baselineSha, candidateSha].every(sha => /^[a-f0-9]{40}$/.test(sha))) throw new Error("Usage: <baseline-root> <baseline-sha> <candidate-root> <candidate-sha> <fixed-fixture-root> <new-output-root>");
const output = path.resolve(outputArg);
fs.mkdirSync(output, { recursive: false });
const sha = file => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const driver = path.resolve("scripts/benchmark-desktop-native-recovery.mjs");
const closure = [driver, path.resolve("scripts/sample-desktop-private-bytes.ps1"), path.resolve("scripts/benchmark-desktop-native-recovery-matrix.mjs"), path.resolve("tests/fixtures/rust-offline-performance.ts")];
const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", windowsHide: true }).trim();
if (execFileSync("git", ["status", "--porcelain"], { encoding: "utf8", windowsHide: true }).trim()) throw new Error("Freeze driver and runtime sources before measuring");
const cases = [
  { fixture: "large-dense-v1.json", scenario: "obsolete", pairs: 5 },
  { fixture: "large-dense-v1.json", scenario: "matching", pairs: 5 },
  { fixture: "extreme-dense-v1.json", scenario: "obsolete", pairs: 5 },
  { fixture: "medium-dense-v1.json", scenario: "obsolete", pairs: 3 },
  { fixture: "large-sparse-v1.json", scenario: "obsolete", pairs: 3 },
];
const manifest = { schemaVersion: 1, scope: "Packaged native sidecar recovery only; not complete startup or offline production", sourceSha, baselineRoot: path.resolve(baselineRoot), baselineSha, candidateRoot: path.resolve(candidateRoot), candidateSha,
  criteria: { gain: "median reduction >=20%, all paired directions positive, all results equivalent", regressionReview: "matching-state median slower by >10% requires investigation", memory: "sampled complete process set; not a proven absolute high-water mark", quantiles: "median and range only" },
  closure: closure.map(file => ({ file, sha256: sha(file) })), fixtures: cases.map(row => ({ ...row, path: path.resolve(fixtureRoot, row.fixture), sha256: sha(path.resolve(fixtureRoot, row.fixture)) })),
};
fs.writeFileSync(path.join(output, "frozen-matrix.json"), JSON.stringify(manifest, null, 2), { flag: "wx" });
const samples = [];
measurements: for (const row of manifest.fixtures) for (let pair = 0; pair < row.pairs; pair++) {
  for (const variant of pair % 2 === 0 ? ["baseline", "candidate"] : ["candidate", "baseline"]) {
    const directory = path.join(output, `${path.basename(row.fixture, ".json")}-${row.scenario}-${pair + 1}-${variant}`);
    const logPath = `${directory}.log`, fd = fs.openSync(logPath, "wx");
    console.log(`Measuring ${path.basename(directory)}`);
    const result = spawnSync(process.execPath, [driver, manifest[`${variant}Root`], manifest[`${variant}Sha`], row.path, row.scenario, directory], { stdio: ["ignore", fd, fd], windowsHide: true, timeout: 180_000 });
    fs.closeSync(fd);
    let report = null;
    if (fs.existsSync(path.join(directory, "report.json"))) report = JSON.parse(fs.readFileSync(path.join(directory, "report.json"), "utf8"));
    const expectedReadCount = variant === "candidate" && row.scenario === "obsolete" ? 1 : report?.recordCount;
    const expectedTrace = report?.reads?.length === expectedReadCount && (expectedReadCount !== 1 || report.reads[0].key === "dsp-idle-network.internal.v1.chunked.v1.normal.manifest");
    const valid = result.status === 0 && !result.error && report?.equality === true && report.checkpointUnchanged === true && report.sameFixtureBytes === true && report.normalClose === true && report.residualProcesses?.length === 0 && report.fixtureSha === row.sha256 && report.rpcErrors?.length === 0 && expectedTrace && report.memoryStatus === "SAMPLED_COMPLETE_PROCESS_SET" && report.memorySamples > 0;
    samples.push({ fixture: row.fixture, scenario: row.scenario, pair: pair + 1, variant, directory, exitCode: result.status, error: result.error?.message ?? report?.error, valid, durationMs: report?.durationMs, privateBytesPeak: report?.privateBytesPeak, memoryStatus: report?.memoryStatus, readCount: report?.reads?.length, resultStateHash: report?.resultStateHash });
    fs.writeFileSync(path.join(output, "samples.json"), JSON.stringify(samples, null, 2));
    console.log(JSON.stringify(samples.at(-1)));
    if (!valid) { process.exitCode = 1; console.error("Stopped: a measurement failed; preserve the evidence and resolve it before continuing."); break measurements; }
  }
}
const median = values => { const sorted = values.slice().sort((a, b) => a - b); return sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2; };
const summarize = values => ({ n: values.length, median: median(values), minimum: Math.min(...values), maximum: Math.max(...values) });
const groups = manifest.fixtures.map(row => {
  const group = samples.filter(sample => sample.fixture === row.fixture && sample.scenario === row.scenario);
  if (group.length !== row.pairs * 2 || group.some(sample => !sample.valid)) return { fixture: row.fixture, scenario: row.scenario, status: "INCONCLUSIVE" };
  const baseline = group.filter(sample => sample.variant === "baseline"), candidate = group.filter(sample => sample.variant === "candidate");
  const baselineTime = summarize(baseline.map(sample => sample.durationMs)), candidateTime = summarize(candidate.map(sample => sample.durationMs));
  const pairedReductions = baseline.map(b => 1 - candidate.find(c => c.pair === b.pair).durationMs / b.durationMs);
  const reduction = 1 - candidateTime.median / baselineTime.median;
  return { fixture: row.fixture, scenario: row.scenario, status: reduction >= 0.2 && pairedReductions.every(value => value > 0) ? "VERIFIED_GAIN" : reduction < -0.1 ? "REGRESSION_REVIEW" : "NO_MATERIAL_GAIN", baselineTime, candidateTime, reduction, pairedReductions,
    baselineMemory: baseline.every(sample => sample.privateBytesPeak !== null && sample.privateBytesPeak !== undefined) ? summarize(baseline.map(sample => sample.privateBytesPeak)) : null,
    candidateMemory: candidate.every(sample => sample.privateBytesPeak !== null && sample.privateBytesPeak !== undefined) ? summarize(candidate.map(sample => sample.privateBytesPeak)) : null,
    baselineReadCounts: baseline.map(sample => sample.readCount), candidateReadCounts: candidate.map(sample => sample.readCount) };
});
let packagesUnchanged = true;
for (const variant of ["baseline", "candidate"]) {
  try {
    const checkedSha = manifest[`${variant}Sha`];
    verifyDesktopBuildEvidence(manifest[`${variant}Root`], { expected: { version: "1.2.7", sourceSha: checkedSha, buildId: `1.2.7+${checkedSha.slice(0, 12)}`, editionId: identity.editionId, channel: "beta" }, identity, requireOffline: true });
  } catch (error) { packagesUnchanged = false; console.error(String(error)); }
}
const gitUnchanged = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", windowsHide: true }).trim() === sourceSha && !execFileSync("git", ["status", "--porcelain"], { encoding: "utf8", windowsHide: true }).trim();
const unchanged = packagesUnchanged && gitUnchanged && manifest.closure.every(entry => sha(entry.file) === entry.sha256) && manifest.fixtures.every(entry => sha(entry.path) === entry.sha256);
fs.writeFileSync(path.join(output, "summary.json"), JSON.stringify({ ...manifest, unchanged, groups }, null, 2));
if (!unchanged || groups.some(group => group.status === "INCONCLUSIVE" || group.status === "REGRESSION_REVIEW")) process.exitCode = 1;
console.log(JSON.stringify({ output, unchanged, groups }, null, 2));
