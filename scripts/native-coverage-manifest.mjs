import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STATE_PATH = path.join(ROOT, "native/dsp-native-core/src/state.rs");
const HOST_PATH = path.join(ROOT, "native/dsp-native-host/src/main.rs");
const HOST_RUNTIME_PATH = path.join(ROOT, "native/dsp-native-host/src/core_runtime.rs");
const HOST_LEASE_PATH = path.join(ROOT, "native/dsp-native-host/src/exact_realtime_lease.rs");
const APP_PATH = path.join(ROOT, "src/App.tsx");
const REGISTRY_PATH = path.join(ROOT, "native/native-surface-registry.json");
const MANIFEST_PATH = path.join(ROOT, "native/native-coverage-manifest.json");

function lineNumber(source, offset) {
  return source.slice(0, offset).split("\n").length;
}

function parseCoverage(source) {
  const struct = source.match(/pub struct DomainCoverage \{(?<body>[\s\S]*?)\n\}/)?.groups?.body;
  const initializer = source.match(/pub fn implemented_beta_scope\(\) -> Self \{[\s\S]*?Self \{(?<body>[\s\S]*?)\n\s*\}\n\s*\}/)?.groups?.body;
  if (!struct || !initializer) throw new Error("cannot parse DomainCoverage");

  const fields = [...struct.matchAll(/^\s*pub ([a-z0-9_]+): bool,/gm)].map((match) => match[1]);
  const values = new Map([...initializer.matchAll(/^\s*([a-z0-9_]+): (true|false),/gm)]
    .map((match) => [match[1], match[2] === "true"]));
  if (fields.length === 0 || values.size !== fields.length || fields.some((field) => !values.has(field))) {
    throw new Error("DomainCoverage fields and initializer differ");
  }
  return Object.fromEntries(fields.map((field) => [field, values.get(field)]));
}

function parseCapabilities(source, dependencySources) {
  const body = source.match(/capabilities: vec!\[(?<body>[\s\S]*?)\n\s*\],/)?.groups?.body;
  if (!body) throw new Error("cannot parse Host capability vector");
  const constants = new Map();
  for (const dependency of [source, ...dependencySources]) {
    for (const match of dependency.matchAll(/(?:pub(?:\(crate\))?\s+)?const\s+([A-Z0-9_]*CAPABILITY):\s*&str\s*=\s*"(native-[a-z0-9-]+)";/g)) {
      constants.set(match[1], match[2]);
    }
  }
  const capabilities = [...body.matchAll(/"(native-[a-z0-9-]+)"|\b([A-Z0-9_]*CAPABILITY)\b/g)]
    .map((match) => match[1] ?? constants.get(match[2]))
    .filter(Boolean);
  const unresolved = [...body.matchAll(/\b([A-Z0-9_]*CAPABILITY)\b/g)]
    .map((match) => match[1])
    .filter((name) => !constants.has(name));
  if (unresolved.length) throw new Error(`unresolved Host capabilities: ${unresolved.join(",")}`);
  return [...new Set(capabilities)].sort();
}

function parseLegacyWriteGuards(source) {
  const entries = new Map();
  for (const match of source.matchAll(/rejectLegacyFactoryInteractionWhileNative\("([^"]+)"\)/g)) {
    const label = match[1];
    const entry = entries.get(label) ?? { label, occurrences: 0, lines: [] };
    entry.occurrences += 1;
    entry.lines.push(lineNumber(source, match.index));
    entries.set(label, entry);
  }
  return [...entries.values()].sort((left, right) => left.label.localeCompare(right.label, "zh-CN"));
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function validateRegistry(registry, legacyWriteGuards) {
  if (registry.schemaVersion !== 1 || !Array.isArray(registry.surfaces)) {
    throw new Error("native surface registry schema is invalid");
  }
  const allowedKinds = new Set(["read", "intent", "durable", "local-preference", "deliberately-unsupported"]);
  const labels = new Set();
  for (const surface of registry.surfaces) {
    if (!surface || typeof surface !== "object" || typeof surface.label !== "string" ||
        typeof surface.kind !== "string" || !allowedKinds.has(surface.kind) ||
        typeof surface.owner !== "string" || typeof surface.status !== "string" ||
        typeof surface.reason !== "string") {
      throw new Error("native surface registry entry is invalid");
    }
    if (labels.has(surface.label)) throw new Error(`duplicate native surface registry label: ${surface.label}`);
    labels.add(surface.label);
  }
  const guarded = new Set(legacyWriteGuards.map((entry) => entry.label));
  const missing = [...guarded].filter((label) => !labels.has(label)).sort();
  const stale = [...labels].filter((label) => !guarded.has(label)).sort();
  if (missing.length || stale.length) {
    throw new Error(`native surface registry drifted (missing=${missing.join(",") || "none"}; stale=${stale.join(",") || "none"})`);
  }
}

export async function buildNativeCoverageManifest() {
  const [stateSource, hostSource, hostRuntimeSource, hostLeaseSource, appSource, registryText] = await Promise.all([
    readFile(STATE_PATH, "utf8"),
    readFile(HOST_PATH, "utf8"),
    readFile(HOST_RUNTIME_PATH, "utf8"),
    readFile(HOST_LEASE_PATH, "utf8"),
    readFile(APP_PATH, "utf8"),
    readFile(REGISTRY_PATH, "utf8"),
  ]);
  const legacyWriteGuards = parseLegacyWriteGuards(appSource);
  const registry = JSON.parse(registryText);
  validateRegistry(registry, legacyWriteGuards);
  const classifications = new Map(registry.surfaces.map((surface) => [surface.label, surface]));
  return {
    schemaVersion: 1,
    generatedFrom: [
      "native/dsp-native-core/src/state.rs",
      "native/dsp-native-host/src/main.rs",
      "native/dsp-native-host/src/core_runtime.rs",
      "native/dsp-native-host/src/exact_realtime_lease.rs",
      "src/App.tsx",
      "native/native-surface-registry.json",
    ],
    domainCoverage: parseCoverage(stateSource),
    hostCapabilities: parseCapabilities(hostSource, [hostRuntimeSource, hostLeaseSource]),
    playerWriteSurfaces: legacyWriteGuards.map((guard) => ({
      ...guard,
      ...classifications.get(guard.label),
    })),
  };
}

export async function writeNativeCoverageManifest() {
  const manifest = await buildNativeCoverageManifest();
  await writeFile(MANIFEST_PATH, stableJson(manifest), "utf8");
  return manifest;
}

export async function verifyNativeCoverageManifest() {
  const expected = stableJson(await buildNativeCoverageManifest());
  const actual = await readFile(MANIFEST_PATH, "utf8");
  if (actual !== expected) throw new Error("native coverage manifest is stale; run npm run native:coverage:generate");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2] ?? "--verify";
  if (mode === "--write") {
    const manifest = await writeNativeCoverageManifest();
    console.log(`wrote ${path.relative(ROOT, MANIFEST_PATH)} (${manifest.playerWriteSurfaces.length} write surfaces)`);
  } else if (mode === "--verify") {
    await verifyNativeCoverageManifest();
    console.log("native coverage manifest is current");
  } else {
    throw new Error(`unsupported native coverage manifest mode: ${mode}`);
  }
}
