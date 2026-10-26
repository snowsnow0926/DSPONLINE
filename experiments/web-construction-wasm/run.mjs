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
if (!["probe", "large-save", "save-profile"].includes(entry)) throw new Error("Unknown probe entry");
const fixtureMode = entry !== "probe";
const callable = entry === "large-save" ? "runLargeSaveProbe" : entry === "save-profile" ? "runSaveProfile" : "runConstructionWasmProbe";
const sourceRoot = resolve(options.source ?? root);
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
  resolve: { alias: [{ find: /^\.\.\/\.\.\/src\/game\//, replacement: `${sourceRoot.replaceAll("\\", "/")}/src/game/` }] },
  define: { "process.env.NODE_ENV": '"production"' },
  build: { write: false, emptyOutDir: false, target: "chrome120", minify: false,
    lib: { entry: resolve(root, `experiments/web-construction-wasm/${entry}.ts`), name: "dspConstructionProbe", formats: ["iife"] } } });
const code = (Array.isArray(bundle) ? bundle : [bundle]).flatMap((entry) => entry.output)
  .find((entry) => entry.type === "chunk" && entry.isEntry)?.code;
if (!code) throw new Error("Missing browser probe bundle");
const wasm = fixtureMode ? null : await readFile(wasmPath);
const server = createServer((request, response) => {
  if (fixtureMode && request.url === "/prepared.json") {
    response.writeHead(200, { "Content-Type": "application/json" });
    createReadStream(options.prepared).on("error", () => response.destroy()).pipe(response);
    return;
  }
  const body = request.url === "/probe.js" ? code
    : request.url === "/kernel.wasm" ? wasm : request.url === "/" ? '<!doctype html><meta charset="utf-8"><script src="/probe.js"></script>' : null;
  response.writeHead(body ? 200 : 404, { "Content-Type": request.url === "/kernel.wasm" ? "application/wasm"
    : request.url === "/probe.js" ? "application/javascript" : "text/html" });
  response.end(body);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
let browser;
try {
  browser = await chromium.launch({ headless: true, channel: options.channel ?? "chrome" });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction((name) => typeof globalThis[name] === "function", callable);
  const result = await page.evaluate((name) => globalThis[name](), callable);
  if (pageErrors.length) throw new Error(pageErrors.join("\n"));
  if (fixtureMode && inputHash !== await fileHash(options.prepared)) throw new Error("Input fixture changed during the run");
  const evidence = { browser: await browser.version(), sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: sourceRoot, encoding: "utf8" }).trim(),
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
