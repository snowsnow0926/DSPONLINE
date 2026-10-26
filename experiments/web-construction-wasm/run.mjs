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
if (!["probe", "large-save", "save-profile", "save-responsiveness", "save-inspection", "quantum-runtime", "power-snapshot", "terminal-parity"].includes(entry)) throw new Error("Unknown probe entry");
const fixtureMode = entry !== "probe";
const callable = entry === "large-save" ? "runLargeSaveProbe" : entry === "save-profile" ? "runSaveProfile"
  : entry === "save-responsiveness" ? "runSaveResponsiveness" : entry === "save-inspection" ? "runSaveInspection"
    : entry === "quantum-runtime" ? "runQuantumRuntimeProbe" : entry === "power-snapshot" ? "runPowerSnapshotProbe"
      : entry === "terminal-parity" ? "runTerminalParityProbe" : "runConstructionWasmProbe";
const sourceRoot = resolve(options.source ?? root);
const decoderFiles = ["src/game/storage.ts", "src/game/saveTransferDecode.ts"];
const decoderReference = options["decoder-ref"] ? execFileSync("git", ["rev-parse", "--verify", `${options["decoder-ref"]}^{commit}`],
  { cwd: sourceRoot, encoding: "utf8" }).trim() : null;
const runtimeFiles = ["src/game/engine.ts", "src/game/quantumLogisticsNetwork.ts"];
const runtimeReference = options["runtime-ref"] ? execFileSync("git", ["rev-parse", "--verify", `${options["runtime-ref"]}^{commit}`],
  { cwd: sourceRoot, encoding: "utf8" }).trim() : null;
const label = options.name ?? (fixtureMode ? `browser-${entry}` : "browser-wasm-probe");
if (!/^[a-z0-9-]+$/i.test(label)) throw new Error("Invalid artifact name");
const fileHash = async (path) => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
};
const inputHash = fixtureMode ? await fileHash(options.prepared) : null;
const wasmPath = options.wasm ?? resolve(output, "target/wasm32-unknown-unknown/release/dsp_web_construction_probe.wasm");
await mkdir(output, { recursive: true });
const bundle = await build({ root, configFile: false, publicDir: false, logLevel: "error",
  plugins: decoderReference || runtimeReference ? [{ name: "frozen-runtime-reference", enforce: "pre", load(id) {
    const relative = id.replaceAll("\\", "/").replace(`${sourceRoot.replaceAll("\\", "/")}/`, "").split("?")[0];
    const reference = runtimeFiles.includes(relative) ? runtimeReference : decoderFiles.includes(relative) ? decoderReference : null;
    if (reference) return execFileSync("git", ["show", `${reference}:${relative}`],
      { cwd: sourceRoot, encoding: "utf8" });
  } }] : [],
  resolve: { alias: [{ find: /^\.\.\/\.\.\/src\/game\//, replacement: `${sourceRoot.replaceAll("\\", "/")}/src/game/` }] },
  define: { "process.env.NODE_ENV": '"production"' },
  build: { write: false, emptyOutDir: false, target: "chrome120", minify: false,
    lib: { entry: resolve(root, `experiments/web-construction-wasm/${entry}.ts`), name: "dspConstructionProbe", formats: ["es"] } } });
const code = (Array.isArray(bundle) ? bundle : [bundle]).flatMap((entry) => entry.output)
  .find((entry) => entry.type === "chunk" && entry.isEntry)?.code;
if (!code) throw new Error("Missing browser probe bundle");
const assets = new Map((Array.isArray(bundle) ? bundle : [bundle]).flatMap((entry) => entry.output)
  .map((entry) => [`/${entry.fileName}`, entry.type === "asset" ? entry.source : entry.code]));
const wasm = fixtureMode ? null : await readFile(wasmPath);
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
  if (options["collect-memory"]) {
    const pageCdp = await page.context().newCDPSession(page);
    await page.exposeFunction("collectSaveProbeGarbage", () => pageCdp.send("HeapProfiler.collectGarbage"));
  }
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  if (entry === "save-responsiveness") await page.exposeFunction("requestSaveInputProbe", () => page.mouse.click(20, 20));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction((name) => typeof globalThis[name] === "function", callable);
  const result = entry === "terminal-parity"
    ? await page.evaluate(({ name, path, scenario }) => globalThis[name](path, scenario),
      { name: callable, path: options["terminal-path"] ?? "legacy", scenario: options["research-case"] ?? "natural" })
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
    sourceDirty: Boolean(execFileSync("git", ["status", "--porcelain"], { cwd: sourceRoot, encoding: "utf8" }).trim()),
    bundleSha256: createHash("sha256").update(code).digest("hex"),
    ...(rendererMemory ? { rendererMemory } : {}),
    ...(decoderReference ? { decoderReference, decoderFiles } : {}),
    ...(entry === "terminal-parity" ? { saveSourceFiles: Object.fromEntries(await Promise.all([
      "src/game/authoritativeSaveSerializationClient.ts", "src/game/save.worker.ts", "src/game/storage.ts",
      "src/game/pureIdleMacroClient.ts", "src/App.tsx",
    ].map(async (file) => [file, await fileHash(resolve(sourceRoot, file))]))) } : {}),
    ...(runtimeReference || ["quantum-runtime", "power-snapshot"].includes(entry) ? { runtimeReference, runtimeFiles,
      runtimeSourceHashes: Object.fromEntries(await Promise.all(runtimeFiles.map(async (file) => [file,
        runtimeReference
          ? createHash("sha256").update(execFileSync("git", ["show", `${runtimeReference}:${file}`], { cwd: sourceRoot })).digest("hex")
          : await fileHash(resolve(sourceRoot, file)),
      ]))) } : {}),
    ...(fixtureMode ? { inputHash } : { wasmBytes: wasm.length, wasmSha256: createHash("sha256").update(wasm).digest("hex") }), ...result };
  await writeFile(resolve(output, `${label}.json`), `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify(fixtureMode ? evidence : { browser: evidence.browser, wasmBytes: evidence.wasmBytes,
    results: evidence.reports.map(({ name, fixtures, mismatches, benchmarks }) => ({
      name, fixtures, mismatches: mismatches.length, benchmarks: benchmarks.map(({ name, medianJsMs, medianRustMs }) => ({ name, medianJsMs, medianRustMs })),
    })) }, null, 2));
  if (!fixtureMode && evidence.reports.some((report) => report.mismatches.length)) process.exitCode = 1;
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
