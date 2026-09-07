import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const checkOnly = process.argv.includes("--check");
const shippedDevelopmentPackages = new Set(["@capacitor/android", "@noble/hashes", "electron"]);

function packageNameFromLockPath(lockPath) {
  return lockPath.split("node_modules/").at(-1);
}

function repositoryUrl(value) {
  const raw = typeof value === "string" ? value : value?.url;
  if (typeof raw !== "string" || !raw.trim()) return null;
  return raw.trim()
    .replace(/^git\+/, "")
    .replace(/^git:\/\//, "https://")
    .replace(/^git@github\.com:/, "https://github.com/")
    .replace(/\.git$/, "");
}

async function loadProject(relativeRoot, label) {
  const projectRoot = path.join(root, relativeRoot);
  const manifest = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
  const lock = JSON.parse(await readFile(path.join(projectRoot, "package-lock.json"), "utf8"));
  const directNames = new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...(relativeRoot === "." ? shippedDevelopmentPackages : []),
  ]);
  const packages = [];
  for (const [lockPath, metadata] of Object.entries(lock.packages ?? {})) {
    if (!lockPath) continue;
    const name = packageNameFromLockPath(lockPath);
    if (metadata.dev === true && !directNames.has(name)) continue;
    const packageDirectory = path.join(projectRoot, ...lockPath.split("/"));
    let packageManifest = {};
    try { packageManifest = JSON.parse(await readFile(path.join(packageDirectory, "package.json"), "utf8")); } catch { /* optional package may not be installed on this platform */ }
    packages.push({
      label,
      direct: directNames.has(name),
      name,
      version: metadata.version || packageManifest.version || "unknown",
      license: metadata.license || packageManifest.license || "UNKNOWN",
      repository: repositoryUrl(packageManifest.repository),
      packageDirectory,
    });
  }
  return packages;
}

async function licenseFiles(packageDirectory) {
  let names;
  try { names = await readdir(packageDirectory); } catch { return []; }
  const candidates = names
    .filter((name) => /^(?:licen[cs]e|copying|notice)(?:\..*)?$/i.test(name))
    .sort((left, right) => left.localeCompare(right));
  const files = [];
  for (const name of candidates) {
    try {
      const contents = await readFile(path.join(packageDirectory, name), "utf8");
      if (contents.trim()) files.push({ name, contents: contents.trim().replace(/[ \t]+$/gm, "") });
    } catch {
      // A package can expose a directory or non-text notice with this name.
    }
  }
  return files;
}

const combined = [
  ...await loadProject(".", "client/runtime"),
  ...await loadProject("server", "cloud service"),
];
const packages = [...new Map(combined.map((entry) => [`${entry.name}@${entry.version}`, entry])).values()]
  .sort((left, right) => left.name.localeCompare(right.name) || left.version.localeCompare(right.version));
const unknown = packages.filter((entry) => entry.license === "UNKNOWN");
if (unknown.length) throw new Error(`Runtime packages with unknown licenses: ${unknown.map((entry) => `${entry.name}@${entry.version}`).join(", ")}`);
const inventoryHash = createHash("sha256")
  .update(JSON.stringify(packages.map(({ name, version, license }) => ({ name, version, license }))))
  .digest("hex");

const direct = packages.filter((entry) => combined.some((candidate) => candidate.direct && candidate.name === entry.name && candidate.version === entry.version));
const licenseCounts = new Map();
for (const entry of packages) licenseCounts.set(entry.license, (licenseCounts.get(entry.license) ?? 0) + 1);

const noticeLines = [
  "# Third-Party Notices",
  "",
  "This inventory is generated from the locked npm runtime dependency trees. Third-party components remain under their own licenses; the project's PolyForm Noncommercial terms do not replace them.",
  "",
  `Inventory SHA-256: \`${inventoryHash}\``,
  "",
  "## Direct Runtime Dependencies",
  "",
  "| Package | Version | License | Runtime |",
  "| --- | --- | --- | --- |",
  ...direct.map((entry) => {
    const runtimes = [...new Set(combined.filter((candidate) => candidate.name === entry.name && candidate.version === entry.version).map((candidate) => candidate.label))].join(", ");
    return `| \`${entry.name}\` | \`${entry.version}\` | \`${entry.license}\` | ${runtimes} |`;
  }),
  "",
  "## Runtime License Summary",
  "",
  "| License expression | Packages |",
  "| --- | ---: |",
  ...[...licenseCounts].sort(([left], [right]) => left.localeCompare(right)).map(([license, count]) => `| \`${license}\` | ${count} |`),
  "",
  "Complete npm runtime license and notice texts are in [`public/THIRD_PARTY_LICENSES.txt`](./public/THIRD_PARTY_LICENSES.txt), which is copied into Web, desktop, and Android builds.",
  "",
  "Electron packages must also retain the generated `LICENSE.electron.txt` and `LICENSES.chromium.html`. Android/Gradle artifacts remain governed by the notices embedded in their source packages and generated application; do not strip those notices from binary distributions.",
  "",
  "Regenerate this inventory after dependency changes with `npm run licenses:generate` and verify it in CI with `npm run licenses:check`.",
  "",
].join("\n");

const fullLicenseSections = [];
for (const entry of packages) {
  const files = await licenseFiles(entry.packageDirectory);
  const source = entry.repository ? `\nSource: ${entry.repository}` : "";
  const body = files.length
    ? files.map((file) => `--- ${file.name} ---\n${file.contents}`).join("\n\n")
    : `License identifier from package metadata: ${entry.license}\nNo plain-text license file was present in the installed package directory.`;
  fullLicenseSections.push(`================================================================================\n${entry.name}@${entry.version}\nLicense: ${entry.license}${source}\n================================================================================\n${body}`);
}
const fullLicenses = [
  "DSP Idle Network - Third-Party Runtime License Texts",
  "",
  "Generated from package-lock.json and server/package-lock.json.",
  `Inventory SHA-256: ${inventoryHash}`,
  "The original package license and notice text controls each component.",
  "",
  ...fullLicenseSections,
  "",
].join("\n");

const publicLegalFiles = await Promise.all([
  ["LICENSE", "LICENSE.txt"],
  ["NOTICE", "NOTICE.txt"],
  ["COMMERCIAL_USE.md", "COMMERCIAL_USE.md"],
  ["PRIVACY.md", "PRIVACY.md"],
  ["TERMS.md", "TERMS.md"],
  ["TRADEMARKS.md", "TRADEMARKS.md"],
].map(async ([source, target]) => [
  path.join(root, "public", target),
  (await readFile(path.join(root, source), "utf8")).replaceAll("(./LICENSE)", "(./LICENSE.txt)"),
]));

const deterministicOutputs = [
  [path.join(root, "THIRD_PARTY_NOTICES.md"), noticeLines],
  ...publicLegalFiles,
];
const fullLicensesTarget = path.join(root, "public", "THIRD_PARTY_LICENSES.txt");

if (checkOnly) {
  const stale = [];
  for (const [target, expected] of deterministicOutputs) {
    let current = null;
    try { current = await readFile(target, "utf8"); } catch { /* missing output */ }
    if (current !== expected) stale.push(path.relative(root, target));
  }
  let currentFullLicenses = null;
  try { currentFullLicenses = await readFile(fullLicensesTarget, "utf8"); } catch { /* missing output */ }
  if (!currentFullLicenses?.includes(`Inventory SHA-256: ${inventoryHash}`)) {
    stale.push(path.relative(root, fullLicensesTarget));
  }
  if (stale.length) throw new Error(`Third-party notice files are missing or stale: ${stale.join(", ")}`);
  console.log(`Third-party notices are current for ${packages.length} runtime packages`);
} else {
  await Promise.all([
    ...deterministicOutputs.map(([target, contents]) => writeFile(target, contents, "utf8")),
    writeFile(fullLicensesTarget, fullLicenses, "utf8"),
  ]);
  console.log(`Generated third-party notices for ${packages.length} runtime packages`);
}
