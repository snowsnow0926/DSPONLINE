import { gzipSync } from "node:zlib";
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * These are compressed transfer budgets, not uncompressed bundle limits. They
 * leave a small margin above the 1.0.40 split-build baseline while preventing
 * the factory runtime from quietly returning to the Chinese startup path.
 */
export const DEFAULT_STARTUP_BUDGET = Object.freeze({
  maxStartupGzipBytes: 200 * 1024,
  maxStartupJavaScriptGzipBytes: 100 * 1024,
  maxStartupCssGzipBytes: 105 * 1024,
  maxLargestStartupJavaScriptGzipBytes: 64 * 1024,
  // The real Web build retains the anonymous cloud-health/session transport
  // in the menu closure.  Keep a tight 1 KiB margin above the measured Web
  // baseline; the old 280 KiB value was accidentally measured from a native
  // build left in the shared dist directory.
  maxMenuGzipBytes: 281 * 1024,
});

const FORBIDDEN_STARTUP_MODULES = Object.freeze([
  {
    label: "game-core",
    matches: (value) => value.includes("game-core")
      || /src\/game\/(?:content|engine|recipegraph|statistics)\.ts/.test(value),
  },
  { label: "FactoryRuntime", matches: (value) => value.includes("factoryruntime") },
  { label: "flow-vendor", matches: (value) => value.includes("flow-vendor") || value.includes("@xyflow") },
  { label: "storage", matches: (value) => value.includes("src/game/storage.ts") || /(?:^|[_/.-])storage(?:[_/.-]|$)/.test(value) },
  { label: "legacyTranslations", matches: (value) => value.includes("legacytranslations") },
]);

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function normalizedFilePath(value) {
  if (typeof value !== "string" || value.length === 0) throw new Error("manifest output file is missing");
  return value.replaceAll("\\", "/");
}

function safeOutputPath(distRoot, file) {
  const absoluteRoot = path.resolve(distRoot);
  const absoluteFile = path.resolve(absoluteRoot, normalizedFilePath(file));
  if (absoluteFile !== absoluteRoot && !absoluteFile.startsWith(`${absoluteRoot}${path.sep}`)) {
    throw new Error(`manifest file escapes dist directory: ${file}`);
  }
  return absoluteFile;
}

function manifestEntry(manifest, key) {
  const entry = manifest[key];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error(`manifest entry is missing: ${key}`);
  }
  return entry;
}

/** Follow only static imports. Dynamic imports must not count as startup work. */
export function staticClosure(manifest, roots) {
  requireObject(manifest, "manifest");
  if (!Array.isArray(roots) || roots.length === 0) throw new Error("at least one manifest root is required");
  const visited = new Set();
  const visit = (key) => {
    if (visited.has(key)) return;
    const entry = manifestEntry(manifest, key);
    visited.add(key);
    if (entry.imports !== undefined && !Array.isArray(entry.imports)) {
      throw new Error(`manifest imports are invalid for ${key}`);
    }
    for (const imported of entry.imports ?? []) {
      if (typeof imported !== "string") throw new Error(`manifest import is invalid for ${key}`);
      visit(imported);
    }
  };
  for (const root of roots) visit(root);
  return visited;
}

export function manifestKeyForSource(manifest, source) {
  for (const [key, entry] of Object.entries(requireObject(manifest, "manifest"))) {
    if (entry && typeof entry === "object" && !Array.isArray(entry) && entry.src === source) return key;
  }
  throw new Error(`manifest has no entry for ${source}`);
}

function filesForClosure(manifest, closure) {
  const files = new Set();
  for (const key of closure) {
    const entry = manifestEntry(manifest, key);
    if (entry.file !== undefined) files.add(normalizedFilePath(entry.file));
    if (entry.css !== undefined && !Array.isArray(entry.css)) throw new Error(`manifest css is invalid for ${key}`);
    for (const css of entry.css ?? []) files.add(normalizedFilePath(css));
  }
  return [...files].sort();
}

async function measureClosure(manifest, closure, distRoot) {
  const files = filesForClosure(manifest, closure);
  const rows = await Promise.all(files.map(async (file) => {
    const bytes = await readFile(safeOutputPath(distRoot, file));
    return { file, gzipBytes: gzipSync(bytes).byteLength };
  }));
  const totals = { javaScriptGzipBytes: 0, cssGzipBytes: 0, otherGzipBytes: 0 };
  let largestJavaScriptGzipBytes = 0;
  for (const row of rows) {
    if (row.file.endsWith(".js")) {
      totals.javaScriptGzipBytes += row.gzipBytes;
      largestJavaScriptGzipBytes = Math.max(largestJavaScriptGzipBytes, row.gzipBytes);
    } else if (row.file.endsWith(".css")) {
      totals.cssGzipBytes += row.gzipBytes;
    } else {
      totals.otherGzipBytes += row.gzipBytes;
    }
  }
  return {
    files: rows.sort((left, right) => left.file.localeCompare(right.file)),
    ...totals,
    largestJavaScriptGzipBytes,
    totalGzipBytes: totals.javaScriptGzipBytes + totals.cssGzipBytes + totals.otherGzipBytes,
  };
}

function moduleDescription(key, entry) {
  return [key, entry.src, entry.name, entry.file]
    .filter((value) => typeof value === "string")
    .join(" ")
    .toLowerCase();
}

function forbiddenStartupHits(manifest, closure) {
  const hits = [];
  for (const key of closure) {
    const entry = manifestEntry(manifest, key);
    const description = moduleDescription(key, entry);
    for (const forbidden of FORBIDDEN_STARTUP_MODULES) {
      if (forbidden.matches(description)) hits.push({ module: forbidden.label, key });
    }
  }
  return hits;
}

function budgetFailures(report, budget) {
  const failures = [];
  const checks = [
    ["startup total gzip", report.startup.totalGzipBytes, budget.maxStartupGzipBytes],
    ["startup JavaScript gzip", report.startup.javaScriptGzipBytes, budget.maxStartupJavaScriptGzipBytes],
    ["startup CSS gzip", report.startup.cssGzipBytes, budget.maxStartupCssGzipBytes],
    ["largest startup JavaScript chunk gzip", report.startup.largestJavaScriptGzipBytes, budget.maxLargestStartupJavaScriptGzipBytes],
    ["complete menu gzip", report.menu.totalGzipBytes, budget.maxMenuGzipBytes],
  ];
  for (const [label, actual, maximum] of checks) {
    if (!Number.isSafeInteger(maximum) || maximum < 1) throw new Error(`invalid ${label} budget`);
    if (actual > maximum) failures.push(`${label} is ${actual} B, over the ${maximum} B budget`);
  }
  for (const hit of report.forbiddenStartupModules) {
    failures.push(`Chinese startup statically includes forbidden ${hit.module} module (${hit.key})`);
  }
  return failures;
}

/**
 * Inspect Vite's authoritative static graph and return a serializable report.
 * The main menu is a dynamic entry from index.html, so its complete initial
 * render closure is measured separately from the HTML's synchronous closure.
 */
export async function verifyStartupBudget({ manifest, distRoot, budget = DEFAULT_STARTUP_BUDGET }) {
  const normalizedManifest = requireObject(manifest, "manifest");
  const normalizedBudget = { ...DEFAULT_STARTUP_BUDGET, ...requireObject(budget, "budget") };
  const startupClosure = staticClosure(normalizedManifest, ["index.html"]);
  const menuEntry = manifestKeyForSource(normalizedManifest, "src/GameLauncher.tsx");
  const menuClosure = staticClosure(normalizedManifest, ["index.html", menuEntry]);
  const report = {
    startup: await measureClosure(normalizedManifest, startupClosure, distRoot),
    menu: await measureClosure(normalizedManifest, menuClosure, distRoot),
    startupModuleKeys: [...startupClosure].sort(),
    menuModuleKeys: [...menuClosure].sort(),
    forbiddenStartupModules: forbiddenStartupHits(normalizedManifest, startupClosure),
    budget: normalizedBudget,
  };
  return { report, failures: budgetFailures(report, normalizedBudget) };
}

function argumentValue(argumentsList, name) {
  const index = argumentsList.indexOf(name);
  return index < 0 ? null : argumentsList[index + 1] ?? null;
}

async function main() {
  const argumentsList = process.argv.slice(2);
  const manifestPath = path.resolve(repositoryRoot, argumentValue(argumentsList, "--manifest") ?? "dist/.vite/manifest.json");
  const distRoot = path.resolve(repositoryRoot, argumentValue(argumentsList, "--dist") ?? "dist");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const { report, failures } = await verifyStartupBudget({ manifest, distRoot });
  const summary = {
    startup: {
      totalGzipBytes: report.startup.totalGzipBytes,
      javaScriptGzipBytes: report.startup.javaScriptGzipBytes,
      cssGzipBytes: report.startup.cssGzipBytes,
      largestJavaScriptGzipBytes: report.startup.largestJavaScriptGzipBytes,
    },
    menu: { totalGzipBytes: report.menu.totalGzipBytes },
    forbiddenStartupModules: report.forbiddenStartupModules,
  };
  if (failures.length > 0) {
    for (const failure of failures) console.error(`Startup budget failure: ${failure}`);
    console.error(JSON.stringify(summary, null, 2));
    process.exitCode = 1;
    return;
  }
  console.log(`Startup budget passed: ${JSON.stringify(summary)}`);
}

let isMain = false;
try { isMain = Boolean(process.argv[1]) && realpathSync(path.resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url)); }
catch { isMain = false; }
if (isMain) {
  await main();
}
