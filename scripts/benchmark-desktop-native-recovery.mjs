/** Actual packaged renderer -> sandbox preload -> main -> release Rust Host.
 * Measures the recovery stage, not whole startup, FPS or offline production.
 * Explicit synthetic fixture, trusted source SHA and fresh isolated profile only.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { _electron as electron } from "@playwright/test";
import { rolldown } from "rolldown";

const require = createRequire(import.meta.url);
const { verifyDesktopBuildEvidence } = require("../desktop/desktop-artifact-evidence.cjs");
const { PERFORMANCE_EDITION_IDENTITY: identity } = require("../desktop/performance-edition-identity.cjs");
const { packageProcesses } = require("./desktop-process-audit.cjs");
const { listPackage } = require("@electron/asar");
const [packageRootArg, sourceSha, fixtureArg, scenario, outputArg] = process.argv.slice(2);
if (!outputArg || !/^[a-f0-9]{40}$/.test(sourceSha) || !["matching", "obsolete"].includes(scenario)) {
  throw new Error("Usage: node scripts/benchmark-desktop-native-recovery.mjs <package-root> <trusted-source-sha> <synthetic-v47.json> <matching|obsolete> <new-output-directory>");
}
const packageRoot = path.resolve(packageRootArg), fixturePath = path.resolve(fixtureArg), output = path.resolve(outputArg);
fs.mkdirSync(output, { recursive: false });
const expected = { version: "1.2.7", sourceSha, buildId: `1.2.7+${sourceSha.slice(0, 12)}`, editionId: identity.editionId, channel: "beta" };
const verified = verifyDesktopBuildEvidence(packageRoot, { expected, identity, requireOffline: true });
const packageDirectory = path.join(packageRoot, "win-unpacked");
if (packageProcesses(packageDirectory).length) throw new Error("Close this package's previous isolated run first");
const hash = value => createHash("sha256").update(value).digest("hex");
const raw = fs.readFileSync(fixturePath, "utf8");
const fixtureSha = hash(raw);
const envelope = JSON.parse(raw);
if (envelope.state.version !== 47 || envelope.formatVersion !== 2 || !envelope.state.paused) throw new Error("Expected a fixed paused synthetic v47 fixture");
const bundle = await rolldown({ input: "tests/fixtures/rust-offline-performance.ts", platform: "node", transform: { define: { "import.meta.env": '{DEV:false,PROD:true,MODE:"production",VITE_APP_PLATFORM:"desktop"}' } } });
await bundle.write({ file: path.join(output, "fixture-tools.mjs"), format: "esm", codeSplitting: false }); await bundle.close();
const fixtureTools = await import(pathToFileURL(path.join(output, "fixture-tools.mjs")));
const state = fixtureTools.migrateGame(envelope.state);
const journal = fixtureTools.buildChunkedSaveJournal(state, { mode: "normal", basePrimaryChecksum: envelope.checksum, savedAt: envelope.savedAt, retainAllChunks: true });
const prefix = "dsp-idle-network.internal.v1.chunked.v1.normal.";
const records = [...journal.chunks].map(([key, value]) => ({ key: prefix + "chunk." + encodeURIComponent(key), value }));
records.push({ key: prefix + "manifest", value: JSON.stringify(journal.manifest) });
const newerState = structuredClone(state); newerState.elapsedSeconds += 1;
const inputRaw = scenario === "matching" ? raw : fixtureTools.serializeEnvelope(newerState, envelope.savedAt + 1000);
// Compare the complete state, independent of envelope field ordering/metadata.
const canonical = value => value === null || typeof value !== "object" ? JSON.stringify(value)
  : Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
  : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
const expectedWireState = JSON.parse(JSON.stringify(journal.projectedState));
const expectedStateHash = hash(canonical(expectedWireState));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "dspidle-performance-smoke-"));
const env = {};
for (const key of ["SystemRoot", "SYSTEMROOT", "WINDIR", "PATH", "Path", "PATHEXT", "TEMP", "TMP", "LOCALAPPDATA", "APPDATA", "USERPROFILE", "COMSPEC", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE"]) if (process.env[key] !== undefined) env[key] = process.env[key];
env.DSP_PERFORMANCE_SMOKE_ISOLATION = "1"; env.DSP_PERFORMANCE_SMOKE_APP_DATA_ROOT = profile;
let app, sampler, report = { kind: "packaged-native-recovery-stage", scope: "Not whole startup or offline computation", scenario, expected, fixturePath, fixtureSha, inputSha256: hash(inputRaw), fixtureBytes: Buffer.byteLength(raw), entities: state.entities.length, belts: state.belts.length, recordCount: records.length, profile, evidence: verified.evidence, driverSha256: hash(fs.readFileSync(new URL(import.meta.url))) };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let appChild;
try {
  console.log("launch");
  app = await electron.launch({ executablePath: path.join(packageDirectory, "dsp-idle-performance-edition.exe"), cwd: packageDirectory, env, timeout: 60000 });
  appChild = app.process();
  const page = await app.firstWindow();
  page.setDefaultTimeout(30000);
  console.log("window");
  const assets = listPackage(path.join(packageDirectory, "resources/app.asar")).filter(name => /[/\\]dist[/\\]assets[/\\]nativeSaveRecovery-[^/\\]*\.js$/.test(name));
  if (assets.length !== 1) throw new Error("Expected one packaged native recovery module");
  const asset = path.basename(assets[0]);
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]; win.show(); win.focus();
  });
  await page.bringToFront();
  console.log("asset", asset);
  await page.waitForFunction(() => Boolean(window.dspDesktop));
  const status = await page.evaluate(() => window.dspDesktop.getNativePerformanceStatus());
  console.log("host", status.available);
  if (!status.available || status.nativeFormatVersion !== 1) throw new Error("Actual native Host unavailable");
  const tx = await page.evaluate(request => window.dspDesktop.beginNativeSave(request), { slot: "normal-main", mode: "normal", stateVersion: 47, baseChecksum: envelope.checksum, registryFingerprint: fixtureTools.runtime.fingerprint, revision: 1, savedAtMs: envelope.savedAt });
  for (let index = 0; index < records.length; index += 8) await page.evaluate(request => window.dspDesktop.writeNativeSave(request), { transactionId: tx.transactionId, records: records.slice(index, index + 8) });
  const checkpoint = await page.evaluate(transactionId => window.dspDesktop.commitNativeSave({ transactionId }), tx.transactionId);
  console.log("seeded", records.length);
  await page.evaluate(value => { window.__recoveryBenchmarkRaw = value; }, inputRaw);
  await app.evaluate(({ app }) => {
    const nativeRequire = process.getBuiltinModule("module").createRequire(app.getAppPath() + "/package.json");
    const { NativeHostClient } = nativeRequire(app.getAppPath() + "/desktop/native-host.cjs");
    const original = NativeHostClient.prototype.request;
    global.__recoveryReads = [];
    NativeHostClient.prototype.request = function(request, ...args) {
      if (request.operation === "saveRead") global.__recoveryReads.push({ key: request.key, generation: request.generation, rootHash: request.rootHash });
      return original.call(this, request, ...args);
    };
  });
  const processTree = packageProcesses(packageDirectory);
  if (!processTree.some(p => p.Name === "dsp-native-host.exe")) throw new Error("Native Host missing from package process inventory");
  report.processTree = processTree;
  const ready = path.join(output, "sampler.ready"), stop = path.join(output, "sampler.stop"), memoryFile = path.join(output, "private-bytes.json");
  sampler = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-File", path.resolve("scripts/sample-desktop-private-bytes.ps1"), "-ProcessIds", processTree.map(p => p.ProcessId).join(","), "-OutputPath", memoryFile, "-ReadyPath", ready, "-StopPath", stop], { windowsHide: true, stdio: "ignore" });
  for (let i = 0; i < 100 && !fs.existsSync(ready); i++) await delay(50);
  if (!fs.existsSync(ready)) throw new Error("Memory sampler did not start");
  const measured = await page.evaluate(async asset => {
    const startedAtMs = Date.now(), start = performance.now();
    const module = await import(new URL(`./assets/${asset}`, location.href).href);
    const exports = Object.values(module);
    if (exports.length !== 1 || typeof exports[0] !== "function") throw new Error("Unexpected recovery module exports");
    const result = await exports[0](window.__recoveryBenchmarkRaw, "normal");
    const durationMs = performance.now() - start, endedAtMs = Date.now();
    return { durationMs, startedAtMs, endedAtMs, raw: result?.raw ?? null, manifest: result?.manifest ?? null };
  }, asset);
  fs.writeFileSync(stop, "stop");
  await new Promise((resolve, reject) => { sampler.once("exit", code => code === 0 ? resolve() : reject(new Error(`Sampler exited ${code}`))); }); sampler = null;
  const memory = JSON.parse(fs.readFileSync(memoryFile, "utf8").replace(/^\uFEFF/, ""));
  const samples = (Array.isArray(memory) ? memory : [memory]).filter(row => row.timestampMs >= measured.startedAtMs && row.timestampMs <= measured.endedAtMs);
  const resultStateHash = measured.raw === null ? null : hash(canonical(JSON.parse(measured.raw).state));
  const equality = scenario === "obsolete" ? measured.raw === null : resultStateHash === expectedStateHash;
  if (!equality && measured.raw) {
    const actualState = JSON.parse(measured.raw).state;
    report.differentFields = Object.keys(expectedWireState).filter(key => canonical(expectedWireState[key]) !== canonical(actualState[key]));
    fs.writeFileSync(path.join(output, "mismatched-result.json"), measured.raw);
  }
  const after = await page.evaluate(() => window.dspDesktop.recoverNativeSave({ slot: "normal-main" }));
  if (after.rootHash !== checkpoint.rootHash || after.generation !== checkpoint.generation || after.revision !== checkpoint.revision) throw new Error("Read-only recovery changed the checkpoint");
  const reads = await app.evaluate(() => global.__recoveryReads);
  const { raw: _resultRaw, ...timing } = measured;
  report = { ...report, ...timing, asset, reads, resultStateHash, expectedStateHash: scenario === "matching" ? expectedStateHash : null, equality, checkpointUnchanged: true, privateBytesPeak: samples.length ? Math.max(...samples.map(s => s.privateBytes)) : null, memorySamples: samples.length, sameFixtureBytes: hash(fs.readFileSync(fixturePath)) === fixtureSha };
  if (!equality || !report.sameFixtureBytes) throw new Error("Recovery is not equivalent to the fixed input");
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  for (let i = 0; i < 250 && appChild.exitCode === null; i++) await delay(100);
  if (appChild.exitCode !== 0) throw new Error("Normal close did not complete successfully");
  report.normalClose = true; app = null;
  report.residualProcesses = packageProcesses(packageDirectory);
  if (report.residualProcesses.length) throw new Error("Package processes remain after normal close");
} catch (error) { report.error = String(error); console.error(error); fs.writeFileSync(path.join(output, "failure.json"), JSON.stringify(report, null, 2)); process.exitCode = 1; }
finally {
  if (sampler) { fs.writeFileSync(path.join(output, "sampler.stop"), "stop"); await new Promise(resolve => sampler.once("exit", resolve)); }
  if (app && appChild.exitCode === null) { await Promise.race([app.evaluate(({ app }) => app.exit(1)).catch(() => {}), delay(5000)]); if (appChild.exitCode === null) appChild.kill(); }
  fs.writeFileSync(path.join(output, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ output, durationMs: report.durationMs, equality: report.equality, reads: report.reads?.length, privateBytesPeak: report.privateBytesPeak, error: report.error }));
}
