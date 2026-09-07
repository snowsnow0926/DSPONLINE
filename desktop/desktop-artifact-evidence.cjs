"use strict";

// Internal build evidence. This is not an update protocol or a signature.
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const yaml = require("js-yaml");
const { extractFile, uncache } = require("@electron/asar");
const { validateDesktopPackageIdentity } = require("./performance-edition-identity.cjs");

const EVIDENCE_FILE = "desktop-build-evidence.json";
const ASAR = "win-unpacked/resources/app.asar";
const HOST = "win-unpacked/resources/native/dsp-native-host.exe";
const CONTEXT_FIELDS = ["version", "sourceSha", "buildId", "editionId", "channel"];

function requireDirect(root, relative, directory = false) {
  if (typeof relative !== "string" || !relative || relative.includes("\\") || relative.includes(":")
    || relative.split("/").some((part) => !part || part === "." || part === "..") || path.isAbsolute(relative)) {
    throw new Error("Unsafe desktop artifact path");
  }
  let current = path.resolve(root);
  const rootStat = fs.lstatSync(current);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("Artifact root must be a direct directory");
  const parts = relative.split("/");
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error("Desktop artifact cannot contain symlinks or reparse points");
    const isDirectory = index < parts.length - 1 || directory;
    if (isDirectory ? !stat.isDirectory() : !stat.isFile()) throw new Error("Desktop artifact has the wrong file type");
  }
  return current;
}

function digestFile(file, algorithm = "sha256", encoding = "hex") {
  const digest = createHash(algorithm);
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const descriptor = fs.openSync(file, "r");
  try {
    let length;
    while ((length = fs.readSync(descriptor, buffer, 0, buffer.length, null)) !== 0) digest.update(buffer.subarray(0, length));
  } finally { fs.closeSync(descriptor); }
  return digest.digest(encoding);
}

function readJson(root, relative) {
  const file = requireDirect(root, relative);
  const size = fs.statSync(file).size;
  if (!size || size > 8 * 1024 * 1024) throw new Error("Desktop manifest is empty or too large");
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function expectedDesktopBuild(repositoryRoot, identity, channel, { requireClean = true } = {}) {
  const git = (args) => execFileSync("git", args, { cwd: repositoryRoot, encoding: "utf8", windowsHide: true }).trim();
  const sourceSha = git(["rev-parse", "HEAD"]);
  const dirty = Boolean(git(["status", "--porcelain"]));
  if (requireClean && dirty) throw new Error("Desktop verification requires a frozen clean source commit");
  const version = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf8")).version;
  return { version, sourceSha, buildId: `${version}+${sourceSha.slice(0, 12)}${dirty ? ".dirty" : ""}`, editionId: identity.editionId, channel };
}

function validateExpected(expected, identity, channel) {
  if (!expected || !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(expected.version)
    || !/^[a-f0-9]{40}$/.test(expected.sourceSha)
    || expected.buildId !== `${expected.version}+${expected.sourceSha.slice(0, 12)}${expected.buildId.endsWith(".dirty") ? ".dirty" : ""}`
    || expected.editionId !== identity.editionId || expected.channel !== channel) {
    throw new Error("Missing or inconsistent trusted desktop build context");
  }
}

function packageIdentity(root, expected, identity, { requireOffline = false } = {}) {
  const asar = requireDirect(root, ASAR);
  uncache(asar);
  const metadata = JSON.parse(extractFile(asar, "package.json").toString("utf8"));
  const actual = validateDesktopPackageIdentity(metadata, { requireOfflineDefaults: requireOffline });
  if (actual.editionId !== identity.editionId || metadata.version !== expected.version || metadata.releaseChannel !== expected.channel) {
    throw new Error("Packaged metadata differs from expected version, edition or channel");
  }
  const version = JSON.parse(extractFile(asar, "dist/version.json").toString("utf8"));
  if (version.version !== expected.version || version.buildId !== expected.buildId || version.platform !== "desktop") {
    throw new Error("Packaged dist differs from the expected source Build ID");
  }
  requireDirect(root, `win-unpacked/${identity.executableName}.exe`);
  requireDirect(root, HOST);
  // A real packaged renderer entry must be present as well as its version label.
  if (!extractFile(asar, "dist/index.html").length) throw new Error("Packaged renderer entry is empty");
  return metadata;
}

function listFiles(root, relative) {
  const directory = requireDirect(root, relative, true);
  return fs.readdirSync(directory).sort().flatMap((name) => {
    const child = `${relative}/${name}`;
    const stat = fs.lstatSync(path.join(directory, name));
    if (stat.isSymbolicLink()) throw new Error("Artifact tree contains a symlink or reparse point");
    return stat.isDirectory() ? listFiles(root, child) : [child];
  });
}

function fileRecord(root, relative) {
  const file = requireDirect(root, relative);
  return { path: relative, size: fs.statSync(file).size, sha256: digestFile(file) };
}

function verifyRecord(root, record) {
  if (!record || !Number.isSafeInteger(record.size) || record.size < 1 || !/^[a-f0-9]{64}$/.test(record.sha256)) throw new Error("Invalid desktop artifact record");
  const actual = fileRecord(root, record.path);
  if (actual.size !== record.size || actual.sha256 !== record.sha256) throw new Error(`Desktop artifact digest or size mismatch: ${record.path}`);
}

function releaseFiles(root, expected, identity) {
  const latestPath = requireDirect(root, "latest.yml");
  if (fs.statSync(latestPath).size > 1024 * 1024) throw new Error("latest.yml is too large");
  const latest = yaml.load(fs.readFileSync(latestPath, "utf8"), { schema: yaml.JSON_SCHEMA });
  const expectedName = identity.installerArtifactName.replace("${version}", expected.version).replace("${arch}", "x64").replace("${ext}", "exe");
  if (!latest || latest.version !== expected.version || latest.path !== expectedName || !Array.isArray(latest.files) || latest.files.length !== 1) {
    throw new Error("Desktop latest.yml has an unexpected version or installer identity");
  }
  const installer = requireDirect(root, expectedName);
  const installerStat = fs.statSync(installer);
  const sha512 = digestFile(installer, "sha512", "base64");
  if (!installerStat.size || latest.sha512 !== sha512 || latest.files[0].url !== expectedName
    || latest.files[0].sha512 !== sha512 || latest.files[0].size !== installerStat.size) throw new Error("Desktop latest.yml installer checksum or size mismatch");
  const prefix = `update-feed/desktop/${expected.channel}`;
  const feed = readJson(root, `${prefix}/release.json`);
  if (feed.schemaVersion !== 1 || feed.version !== expected.version || feed.channel !== expected.channel || !Array.isArray(feed.files)) {
    throw new Error("Desktop release feed version or channel mismatch");
  }
  const names = feed.files.map((entry) => entry.name);
  const required = ["latest.yml", expectedName];
  const optional = `${expectedName}.blockmap`;
  if (new Set(names).size !== names.length || required.some((name) => !names.includes(name))
    || names.some((name) => ![...required, optional].includes(name))) throw new Error("Desktop release feed has missing or unexpected files");
  for (const entry of feed.files) {
    verifyRecord(root, { path: `${prefix}/${entry.name}`, size: entry.size, sha256: entry.sha256 });
    verifyRecord(root, { path: entry.name, size: entry.size, sha256: entry.sha256 });
  }
  const actualFeedFiles = listFiles(root, prefix);
  const allowedFeedFiles = [...names.map((name) => `${prefix}/${name}`), `${prefix}/release.json`].sort();
  if (JSON.stringify(actualFeedFiles.sort()) !== JSON.stringify(allowedFeedFiles)) throw new Error("Unexpected file in desktop feed");
  // The workflow uploads root *.exe/*.blockmap; reject stale extra installers.
  if (fs.readdirSync(root).some((name) => /\.(?:exe|blockmap)$/i.test(name) && !names.includes(name))) throw new Error("Unexpected installer in desktop output");
  return [...names, ...actualFeedFiles];
}

function writeDesktopBuildEvidence(root, { expected, identity, release = false, repositoryRoot } = {}) {
  validateExpected(expected, identity, expected?.channel);
  packageIdentity(root, expected, identity);
  if (repositoryRoot) {
    const builtHost = path.join(repositoryRoot, "native/target/release/dsp-native-host.exe");
    if (digestFile(builtHost) !== digestFile(requireDirect(root, HOST))) throw new Error("Packaged Host does not match this build's Host");
  }
  const paths = [...listFiles(root, "win-unpacked"), ...(release ? releaseFiles(root, expected, identity) : [])].sort();
  const manifest = { schemaVersion: 1, ...expected, kind: release ? "release" : "directory", files: paths.map((relative) => fileRecord(root, relative)) };
  // Only the verified packer writes this internal file, after all build steps.
  if (fs.existsSync(path.join(root, EVIDENCE_FILE))) requireDirect(root, EVIDENCE_FILE);
  fs.writeFileSync(path.join(root, EVIDENCE_FILE), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "w" });
  return manifest;
}

function verifyDesktopBuildEvidence(root, { expected, identity, release = false, requireOffline = false } = {}) {
  validateExpected(expected, identity, expected?.channel);
  const evidence = readJson(root, EVIDENCE_FILE);
  if (evidence.schemaVersion !== 1 || evidence.kind !== (release ? "release" : "directory")
    || CONTEXT_FIELDS.some((key) => evidence[key] !== expected[key]) || !Array.isArray(evidence.files)) throw new Error("Desktop build evidence differs from trusted build context");
  const paths = evidence.files.map((entry) => entry.path);
  if (new Set(paths).size !== paths.length) throw new Error("Duplicate desktop evidence path");
  const required = [...listFiles(root, "win-unpacked"), ...(release ? releaseFiles(root, expected, identity) : [])].sort();
  if (JSON.stringify([...paths].sort()) !== JSON.stringify(required)) throw new Error("Desktop evidence file inventory mismatch");
  for (const record of evidence.files) verifyRecord(root, record);
  const metadata = packageIdentity(root, expected, identity, { requireOffline });
  return { evidence, metadata };
}

module.exports = { EVIDENCE_FILE, ASAR, HOST, digestFile, requireDirect, expectedDesktopBuild, writeDesktopBuildEvidence, verifyDesktopBuildEvidence };
