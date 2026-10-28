import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { execFileSync } from "node:child_process";
import { build } from "vite";
import { chromium } from "@playwright/test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const options = Object.fromEntries(process.argv.slice(2).map((entry) => entry.replace(/^--/, "").split(/=(.*)/s, 2)));
const output = resolve(options.output ?? resolve(root, "artifacts/web-construction-wasm"));
const entry = options.entry ?? "probe";
if (!["probe", "payload-checksum", "large-save", "save-profile", "save-projection-chunks", "macro-finalization", "save-responsiveness", "save-inspection", "save-inspection-runs", "save-inspection-stack", "save-inspection-local-hash", "quantum-runtime", "power-snapshot", "power-matrix", "terminal-parity", "terminal-decode", "terminal-decode-cooperative", "save-state-chunks", "terminal-owner", "terminal-owner-faults", "canonical-owner-parity", "persistence-retirement", "startup-idb", "read-models", "belt-flow", "power-copy"].includes(entry)) throw new Error("Unknown probe entry");
const fixtureMode = entry !== "probe";
const needsWasm = entry === "probe" || entry === "payload-checksum";
const callable = entry === "save-inspection-local-hash" ? "runSaveInspectionLocalHash" : entry === "save-inspection-stack" ? "runSaveInspectionStack" : entry === "save-inspection-runs" ? "runSaveInspectionRuns" : entry === "payload-checksum" ? "runPayloadChecksum" : entry === "macro-finalization" ? "runMacroFinalization" : entry === "save-projection-chunks" ? "runSaveProjectionChunks" : entry === "power-copy" ? "runPowerCopyProbe" : entry === "belt-flow" ? "runBeltFlowProbe" : entry === "power-matrix" ? "runPowerMatrixProbe" : entry === "read-models" ? "runReadModelsProbe" : entry === "large-save" ? "runLargeSaveProbe" : entry === "save-profile" ? "runSaveProfile"
  : entry === "save-responsiveness" ? "runSaveResponsiveness" : entry === "save-inspection" ? "runSaveInspection"
    : entry === "quantum-runtime" ? "runQuantumRuntimeProbe" : entry === "power-snapshot" ? "runPowerSnapshotProbe"
      : entry === "terminal-parity" ? "runTerminalParityProbe" : entry === "terminal-decode" ? "runTerminalDecodeProbe"
        : entry === "terminal-decode-cooperative" ? "runTerminalDecodeCooperativeProbe"
          : entry === "save-state-chunks" ? "runSaveStateChunksProbe"
            : entry === "terminal-owner" ? "runTerminalOwnerProbe"
              : entry === "terminal-owner-faults" ? "runTerminalOwnerFaults"
                : entry === "canonical-owner-parity" ? "runCanonicalOwnerParity"
                  : entry === "startup-idb" ? "runStartupIdbProbe"
                  : entry === "persistence-retirement" ? options["startup-owner-parity"] === "1" ? "runStartupSharedOwnerParity"
                    : options["startup-parity"] === "1" ? "runStartupCheckpointParity" : "runPersistenceRetirement" : "runConstructionWasmProbe";
const sourceRoot = resolve(options.source ?? root);
const inspectionFile = "src/game/canonicalSaveEnvelopeInspection.ts";
const inspectionReference = options["inspection-ref"] ? execFileSync("git", ["rev-parse", "--verify", `${options["inspection-ref"]}^{commit}`],
  { cwd: sourceRoot, encoding: "utf8" }).trim() : null;
if (inspectionReference && !entry.startsWith("save-inspection")) throw new Error("Inspection reference requires a save-inspection probe");
const macroWorkerReference = options["macro-worker-ref"] ? execFileSync("git", ["rev-parse", "--verify", `${options["macro-worker-ref"]}^{commit}`],
  { cwd: sourceRoot, encoding: "utf8" }).trim() : null;
if (macroWorkerReference && entry !== "macro-finalization") throw new Error("Macro Worker reference requires macro-finalization");
const decoderFiles = ["src/game/storage.ts", "src/game/saveTransferDecode.ts"];
const decoderReference = options["decoder-ref"] ? execFileSync("git", ["rev-parse", "--verify", `${options["decoder-ref"]}^{commit}`],
  { cwd: sourceRoot, encoding: "utf8" }).trim() : null;
if (entry === "terminal-decode-cooperative" && decoderReference) throw new Error("Use terminal-decode/sync for a frozen decoder reference");
const migrationPhases = entry === "terminal-decode" && options["migration-phases"] === "1";
const macroProfile = entry === "large-save" && options["macro-profile"] === "1";
const constructionPhaseCacheLimit = Number(options["construction-phases"] ?? 4);
if (![4, 8, 16, 32].includes(constructionPhaseCacheLimit)) throw new Error("Invalid construction phase cache limit");
if (constructionPhaseCacheLimit !== 4 && entry !== "large-save") throw new Error("Construction phase experiment requires large-save");
const macroProfileFunctions = {
  "src/game/engine.ts": ["advanceConstructionAutomationMacroInPlace", "runConstructionCenters", "resolveConstructionAutomationPlan", "tryRunConstructionAutomationBatch", "constructionAutomationPlanCacheKey", "constructionAutomationCachedPlanValid", "constructionAutomationInventorySnapshot", "buildConstructionAutomationPlan", "retainConstructionPlanPhases", "analyzeRepeatableConstructionAutomationPlan", "tryBuildStableConstructionAutomationCycle", "constructionAutomationBatchSignature"],
  "src/game/offlineApproximation.ts": ["advancePureIdleConstructionDomainInPlace", "captureConstructionRecipeStageSnapshot", "createConstructionRecipeReceipt", "createConstructionPowerAllocation"],
  "src/game/pureIdleReplication.ts": ["advancePureIdleReplicationInPlace"],
};
const runtimeFiles = entry === "belt-flow" ? ["src/game/beltFlow.ts"] : entry === "read-models"
  ? ["src/game/nativeFactoryInteractionFrame.ts", "src/game/webFactoryReadModelAdapter.ts"]
  : ["src/game/engine.ts", "src/game/quantumLogisticsNetwork.ts"];
const runtimeReference = options["runtime-ref"] ? execFileSync("git", ["rev-parse", "--verify", `${options["runtime-ref"]}^{commit}`],
  { cwd: sourceRoot, encoding: "utf8" }).trim() : null;
const label = options.name ?? (fixtureMode ? `browser-${entry}` : "browser-wasm-probe");
if (!/^[a-z0-9-]+$/i.test(label)) throw new Error("Invalid artifact name");
const fileHash = async (path) => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
};
const inspectionSourceHash = async (file) => inspectionReference && file === inspectionFile
  ? createHash("sha256").update(execFileSync("git", ["show", `${inspectionReference}:${file}`], { cwd: sourceRoot })).digest("hex")
  : fileHash(resolve(sourceRoot, file));
const inputHash = fixtureMode ? await fileHash(options.prepared) : null;
const wasmPath = options.wasm ?? resolve(output, "target/wasm32-unknown-unknown/release/dsp_web_construction_probe.wasm");
await mkdir(output, { recursive: true });
const referenceSourceLoads = [];
const frozenRuntimePlugins = () => decoderReference || runtimeReference || macroWorkerReference || inspectionReference || migrationPhases || macroProfile || constructionPhaseCacheLimit !== 4 ? [{ name: "frozen-runtime-reference", enforce: "pre", async load(id) {
    const relative = id.replaceAll("\\", "/").replace(`${sourceRoot.replaceAll("\\", "/")}/`, "").split("?")[0];
    const reference = relative === inspectionFile && inspectionReference ? inspectionReference
      : relative === "src/game/pureIdleMacro.worker.ts" && macroWorkerReference ? macroWorkerReference
      : runtimeFiles.includes(relative) ? runtimeReference : decoderFiles.includes(relative) ? decoderReference : null;
    const profileFunctions = macroProfile ? macroProfileFunctions[relative] : undefined;
    const overridePhaseCache = constructionPhaseCacheLimit !== 4 && relative === "src/game/engine.ts";
    if (!reference && !(migrationPhases && relative === "src/game/storage.ts") && !profileFunctions && !overridePhaseCache) return;
    let code = reference ? execFileSync("git", ["show", `${reference}:${relative}`],
      { cwd: sourceRoot, encoding: "utf8" }) : await readFile(resolve(sourceRoot, relative), "utf8");
    if (reference) referenceSourceLoads.push({ file: relative, reference, sha256: createHash("sha256").update(code).digest("hex") });
    if (overridePhaseCache) {
      const anchor = "const alternatives = previous.filter((plan) => plan !== selected).slice(0, 3);";
      if (code.split(anchor).length !== 2) throw new Error("Construction phase cache anchor changed");
      code = code.replace(anchor, `const alternatives = previous.filter((plan) => plan !== selected).slice(0, ${constructionPhaseCacheLimit - 1});`);
    }
    if (migrationPhases && relative === "src/game/storage.ts") {
      for (const [anchor, phase] of [
        [code.includes("  const entities = saved.entities.filter") ? "  const entities = saved.entities.filter" : "  const normalizeEntity =", "setup"],
        ["  const terminalByPlanet = new Map<PlanetId, FactoryEntity>();", "entity-normalization"],
        ["  for (const resource of initial.entities.filter", "terminal-deduplication"],
        ["  const construction = Object.fromEntries(Object.keys(initial.construction)", "resource-restoration"],
        [code.includes("  const migratedBelts: BeltConnection[]") ? "  const migratedBelts: BeltConnection[]" : "  const normalizeBelt =", "construction-and-entity-index"],
        ["  for (const belt of migratedBelts) {", "belt-normalization"],
        ["  const completedTechIds = Array.isArray(saved.research", "belt-repair-and-validation"],
      ]) {
        if (!code.includes(anchor)) throw new Error(`Migration phase anchor changed: ${phase}`);
        code = code.replace(anchor, `  globalThis.__terminalMigrationPhases?.push({ phase: ${JSON.stringify(phase)}, at: performance.now() });\n${anchor}`);
      }
    }
    for (const name of profileFunctions ?? []) {
      const pattern = new RegExp(`(^|\\n)(export )?function ${name}\\(`, "g");
      const matches = [...code.matchAll(pattern)];
      if (matches.length !== 1) throw new Error(`Macro profile function changed: ${relative}:${name}`);
      const exported = Boolean(matches[0][2]);
      const original = `__macroProbe_${name}`;
      code = code.replace(pattern, (_match, lead) => `${lead}function ${original}(`);
      code += `\n${exported ? "export " : ""}function ${name}(...args: Parameters<typeof ${original}>): ReturnType<typeof ${original}> {
        const start = performance.now();
        try { return ${original}(...args); }
        finally {
          const bag = (globalThis as any).__dspMacroProbeProfile ??= {};
          const row = bag[${JSON.stringify(name)}] ??= { calls: 0, milliseconds: 0 };
          row.calls += 1; row.milliseconds += performance.now() - start;
        }
      }\n`;
    }
    return code;
  } }] : [];
const bundle = await build({ root, configFile: false, publicDir: false, logLevel: "error",
  plugins: frozenRuntimePlugins(), worker: { plugins: frozenRuntimePlugins },
  resolve: { alias: [{ find: /^\.\.\/\.\.\/src\/game\//, replacement: `${sourceRoot.replaceAll("\\", "/")}/src/game/` }] },
  define: { "process.env.NODE_ENV": '"production"',
    ...(["persistence-retirement", "startup-idb", "macro-finalization"].includes(entry) ? { __APP_PLATFORM__: '"web"' } : {}),
  },
  build: { write: false, emptyOutDir: false, target: "chrome120", minify: false,
    lib: { entry: resolve(root, `experiments/web-construction-wasm/${entry}.ts`), name: "dspConstructionProbe", formats: ["es"] } } });
const code = (Array.isArray(bundle) ? bundle : [bundle]).flatMap((entry) => entry.output)
  .find((entry) => entry.type === "chunk" && entry.isEntry)?.code;
if (!code) throw new Error("Missing browser probe bundle");
if (inspectionReference && !referenceSourceLoads.some((row) => row.file === inspectionFile && row.reference === inspectionReference)) {
  throw new Error("Requested inspector reference was not actually loaded by the compiler");
}
if (macroWorkerReference && !referenceSourceLoads.some((row) => row.file === "src/game/pureIdleMacro.worker.ts" && row.reference === macroWorkerReference)) {
  throw new Error("Requested macro Worker source reference was not actually loaded by the Worker compiler");
}
const workerAssetHashes = Object.fromEntries((Array.isArray(bundle) ? bundle : [bundle]).flatMap((entry) => entry.output)
  .filter((entry) => entry.fileName.includes(".worker-") && entry.fileName.endsWith(".js"))
  .map((entry) => [entry.fileName, createHash("sha256").update(entry.type === "asset" ? entry.source : entry.code).digest("hex")]));
const assets = new Map((Array.isArray(bundle) ? bundle : [bundle]).flatMap((entry) => entry.output)
  .map((entry) => [`/${entry.fileName}`, entry.type === "asset" ? entry.source : entry.code]));
const wasm = needsWasm ? await readFile(wasmPath) : null;
const server = createServer((request, response) => {
  if (fixtureMode && request.url === "/prepared.json") {
    response.writeHead(200, { "Content-Type": "application/json" });
    createReadStream(options.prepared).on("error", () => response.destroy()).pipe(response);
    return;
  }
  const asset = assets.get(new URL(request.url, "http://localhost").pathname);
  const body = request.url === "/probe.js" ? code
    : asset ?? (request.url === "/kernel.wasm" ? wasm : request.url === "/" ? '<!doctype html><meta charset="utf-8"><script type="module" src="/probe.js"></script>' : null);
  response.writeHead(body ? 200 : 404, { "Content-Type": request.url === "/kernel.wasm" ? "application/wasm"
    : request.url === "/probe.js" || asset !== undefined && request.url.includes(".js") ? "application/javascript" : "text/html" });
  response.end(body);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
let browser;
try {
  browser = await chromium.launch({ headless: true, channel: options.channel ?? "chrome",
    args: options.memory ? ["--enable-precise-memory-info"] : [] });
  const page = await browser.newPage();
  if (options.memory) await page.addInitScript(() => { globalThis.recordHeapMeasurements = true; });
  if (options["persisted-proof"]) await page.addInitScript(() => { globalThis.recordTerminalPersistedProof = true; });
  if (options["collect-memory"]) {
    const pageCdp = await page.context().newCDPSession(page);
    await page.exposeFunction("collectSaveProbeGarbage", () => pageCdp.send("HeapProfiler.collectGarbage"));
  }
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  if (entry === "save-responsiveness" || entry.startsWith("terminal-decode") || entry === "save-state-chunks" || entry === "terminal-owner") await page.exposeFunction("requestSaveInputProbe", () => page.mouse.click(20, 20));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction((name) => typeof globalThis[name] === "function", callable);
  const result = entry === "large-save"
    ? await page.evaluate(({ name, supply }) => globalThis[name](supply), { name: callable, supply: options.supply ?? "tray" })
    : entry === "terminal-parity"
    ? await page.evaluate(({ name, path, scenario }) => globalThis[name](path, scenario),
      { name: callable, path: options["terminal-path"] ?? "legacy", scenario: options["research-case"] ?? "natural" })
    : entry === "terminal-decode" || entry === "save-state-chunks" || entry === "terminal-owner" || entry === "startup-idb"
      ? await page.evaluate(({ name, mode }) => globalThis[name](mode), { name: callable,
        mode: entry === "terminal-owner" ? options["owner-mode"] ?? "ui"
          : entry === "startup-idb" ? options["transport-mode"] ?? "main"
          : entry === "save-state-chunks" ? options["transport-mode"] ?? "clone" : options["decode-mode"] ?? "profile" })
      : entry === "power-copy"
        ? await page.evaluate(({ name, mode }) => globalThis[name](mode), { name: callable, mode: options["copy-mode"] ?? "chunked" })
        : await page.evaluate((name) => globalThis[name](), callable);
  let rendererMemory;
  if (options.memory && process.platform === "win32") {
    const cdp = await browser.newBrowserCDPSession();
    const info = await cdp.send("SystemInfo.getProcessInfo");
    const ids = info.processInfo.filter((item) => item.type === "renderer" && Number.isSafeInteger(item.id)).map((item) => item.id);
    if (ids.length) rendererMemory = JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-Command",
      `Get-Process -Id ${ids.join(",")} | Select-Object Id,WorkingSet64,PeakWorkingSet64,PrivateMemorySize64 | ConvertTo-Json -Compress`], { encoding: "utf8" }));
    await cdp.detach();
  }
  if (pageErrors.length) throw new Error(pageErrors.join("\n"));
  if (fixtureMode && inputHash !== await fileHash(options.prepared)) throw new Error("Input fixture changed during the run");
  const evidence = { browser: await browser.version(), sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: sourceRoot, encoding: "utf8" }).trim(),
    ...(entry === "large-save" ? { macroProfile, constructionPhaseCacheLimit, macroSourceHashes: Object.fromEntries(await Promise.all([
      ...Object.keys(macroProfileFunctions), "src/game/pureIdleMacro.ts", "experiments/web-construction-wasm/large-save.ts",
    ].map(async file => [file, runtimeReference && runtimeFiles.includes(file)
      ? createHash("sha256").update(execFileSync("git", ["show", `${runtimeReference}:${file}`], { cwd: sourceRoot })).digest("hex")
      : await fileHash(resolve(sourceRoot, file))]))) } : {}),
    sourceDirty: Boolean(execFileSync("git", ["status", "--porcelain"], { cwd: sourceRoot, encoding: "utf8" }).trim()),
    bundleSha256: createHash("sha256").update(code).digest("hex"), referenceSourceLoads, workerAssetHashes,
    ...(entry.startsWith("save-inspection") ? { inspectionReference } : {}),
    ...(rendererMemory ? { rendererMemory } : {}),
    ...(decoderReference ? { decoderReference, decoderFiles } : {}),
    ...(entry === "macro-finalization" ? { macroWorkerReference, macroSourceHashes: Object.fromEntries(await Promise.all([
      "src/game/pureIdleMacro.worker.ts", "src/game/pureIdleMacro.ts", "src/game/pureIdleMacroClient.ts",
      "src/game/saveTransfer.ts", "src/game/saveProjection.ts", "src/game/storage.ts", "src/game/save.worker.ts", "src/game/engine.ts",
      "experiments/web-construction-wasm/macro-finalization.ts", "experiments/web-construction-wasm/macro-finalization-clock.worker.ts",
    ].map(async file => [file, macroWorkerReference && file === "src/game/pureIdleMacro.worker.ts"
      ? createHash("sha256").update(execFileSync("git", ["show", `${macroWorkerReference}:${file}`], { cwd: sourceRoot })).digest("hex")
      : await fileHash(resolve(sourceRoot, file))]))) } : {}),
    ...(entry.startsWith("terminal-decode") ? { migrationPhases, decoderSourceHashes: Object.fromEntries(await Promise.all(decoderFiles.map(async (file) => [file,
      decoderReference ? createHash("sha256").update(execFileSync("git", ["show", `${decoderReference}:${file}`], { cwd: sourceRoot })).digest("hex")
        : await fileHash(resolve(sourceRoot, file)),
    ]))) } : {}),
    ...(entry === "terminal-parity" || entry === "save-state-chunks" || entry === "terminal-owner" || entry === "canonical-owner-parity" || entry === "persistence-retirement" ? { saveSourceFiles: Object.fromEntries(await Promise.all([
      "src/game/authoritativeSaveSerializationClient.ts", "src/game/save.worker.ts", "src/game/storage.ts",
      "src/game/pureIdleMacroClient.ts", "src/App.tsx", "src/game/saveProjection.ts", "src/game/saveTransfer.ts", "src/game/saveEnvelopeIntegrity.ts",
      ...(entry === "persistence-retirement" ? ["src/game/authoritativeSavePersistenceClient.ts", "src/game/authoritativeSavePersistence.worker.ts", "src/game/localSaveStore.ts"] : []),
      ...(entry === "persistence-retirement" && options["startup-parity"] === "1" ? ["src/game/pureIdleRecovery.ts", "src/game/saveStateChunkTransfer.ts"] : []),
      ...(entry === "persistence-retirement" && options["startup-owner-parity"] === "1" ? ["src/game/pureIdleRecovery.ts", "src/game/saveStateChunkTransfer.ts",
        "src/game/pureIdleCheckpointOwnerClient.ts", "src/game/pureIdleCheckpointOwner.worker.ts", "src/game/pureIdlePrimaryWriterFence.ts"] : []),
      ...(entry === "terminal-owner" || entry === "canonical-owner-parity" ? ["src/game/canonicalTerminalOwnerClient.ts", "src/game/canonicalTerminalOwnerRegistry.ts",
        "src/game/canonicalTerminalOwnerProtocol.ts", "src/game/canonicalTerminalOwner.worker.ts", "src/game/saveStateChunkTransfer.ts", "src/game/saveTransferDecode.ts"] : []),
    ].map(async (file) => [file, await fileHash(resolve(sourceRoot, file))]))) } : {}),
    ...(entry === "startup-idb" ? { probeSourceHashes: Object.fromEntries(await Promise.all([
      "experiments/web-construction-wasm/startup-idb.ts", "experiments/web-construction-wasm/startup-idb.worker.ts",
      "src/game/pureIdleRecovery.ts", "src/game/storage.ts", "src/game/saveTransferDecode.ts", "src/game/engine.ts",
    ].map(async file => [file, await fileHash(resolve(sourceRoot, file))]))) } : {}),
    ...(entry === "save-state-chunks" ? { chunkTransportSourceSha256: await fileHash(resolve(sourceRoot, "src/game/saveStateChunkTransfer.ts")) } : {}),
    ...(entry === "power-matrix" ? { probeSourceSha256: await fileHash(resolve(root, "experiments/web-construction-wasm/power-matrix.ts")) } : {}),
    ...(entry === "save-projection-chunks" ? { projectionSourceHashes: Object.fromEntries(await Promise.all([
      "experiments/web-construction-wasm/terminal-projection-prototype.ts", "src/game/saveProjection.ts", "src/game/saveTransfer.ts", "src/game/saveEnvelopeIntegrity.ts",
      "experiments/web-construction-wasm/save-projection-chunks.ts",
    ].map(async file => [file, await fileHash(resolve(sourceRoot, file))]))) } : {}),
    ...(entry === "payload-checksum" ? { checksumSourceHashes: Object.fromEntries(await Promise.all([
      "experiments/web-construction-wasm/src/lib.rs", "experiments/web-construction-wasm/payload-checksum.ts",
      "native/dsp-native-core/src/canonical.rs", "src/game/saveTransfer.ts", "src/game/saveProjection.ts",
    ].map(async file => [file, await fileHash(resolve(sourceRoot, file))]))) } : {}),
    ...(entry === "save-inspection-runs" ? { inspectionSourceHashes: Object.fromEntries(await Promise.all([
      "src/game/canonicalSaveEnvelopeInspection.ts", "experiments/web-save-checkpoints/inspection-run-skip.ts",
      "experiments/web-save-checkpoints/inspection-token-skip.ts", "experiments/web-construction-wasm/save-inspection-runs.ts",
    ].map(async file => [file, await inspectionSourceHash(file)]))) } : {}),
    ...(entry === "save-inspection-stack" ? { inspectionSourceHashes: Object.fromEntries(await Promise.all([
      "src/game/canonicalSaveEnvelopeInspection.ts", "experiments/web-save-checkpoints/inspection-stack-reuse.ts",
      "experiments/web-construction-wasm/save-inspection-stack.ts",
    ].map(async file => [file, await inspectionSourceHash(file)]))) } : {}),
    ...(entry === "save-inspection-local-hash" ? { inspectionSourceHashes: Object.fromEntries(await Promise.all([
      "src/game/canonicalSaveEnvelopeInspection.ts", "experiments/web-save-checkpoints/inspection-local-hash.ts",
      "experiments/web-construction-wasm/save-inspection-stack.ts", "experiments/web-construction-wasm/save-inspection-local-hash.ts",
    ].map(async file => [file, await inspectionSourceHash(file)]))) } : {}),
    ...(runtimeReference || ["quantum-runtime", "power-snapshot", "power-matrix", "read-models", "belt-flow", "power-copy"].includes(entry) ? { runtimeReference, runtimeFiles,
      runtimeSourceHashes: Object.fromEntries(await Promise.all(runtimeFiles.map(async (file) => [file,
        runtimeReference
          ? createHash("sha256").update(execFileSync("git", ["show", `${runtimeReference}:${file}`], { cwd: sourceRoot })).digest("hex")
          : await fileHash(resolve(sourceRoot, file)),
      ]))) } : {}),
    ...(fixtureMode ? { inputHash } : {}),
    ...(wasm ? { wasmBytes: wasm.length, wasmSha256: createHash("sha256").update(wasm).digest("hex") } : {}), ...result };
  await writeFile(resolve(output, `${label}.json`), `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify(fixtureMode ? evidence : { browser: evidence.browser, wasmBytes: evidence.wasmBytes,
    results: evidence.reports.map(({ name, fixtures, mismatches, benchmarks }) => ({
      name, fixtures, mismatches: mismatches.length, benchmarks: benchmarks.map(({ name, medianJsMs, medianRustMs }) => ({ name, medianJsMs, medianRustMs })),
    })) }, null, 2));
  if (!fixtureMode && evidence.reports.some((report) => report.mismatches.length)) process.exitCode = 1;
  if (entry === "belt-flow" && !evidence.passed) process.exitCode = 1;
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
