import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RELEASE_ID_PATTERN = /^\d+\.\d+\.\d+-[0-9a-f]{12}$/;

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function gitText(args, cwd) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

function insideRoot(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function resolveManifestPath(workspaceRoot, relativePath) {
  const normalized = String(relativePath ?? "").replaceAll("\\", "/");
  if (!normalized || path.posix.isAbsolute(normalized) || normalized.split("/").includes("..")) {
    throw new Error(`manifest path is unsafe: ${normalized || "<empty>"}`);
  }
  const resolved = path.resolve(workspaceRoot, normalized);
  if (!insideRoot(workspaceRoot, resolved)) throw new Error(`manifest path escapes workspace: ${normalized}`);
  return resolved;
}

export function aggregateManifestHash(files) {
  return sha256(Buffer.from(files.map((file) => `${file.sha256} ${file.size} ${file.path}\n`).join("")));
}

export function parseSha256Sums(text) {
  const records = [];
  for (const line of String(text).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([a-f0-9]{64})\s+(?:\*?)(.+)$/i);
    if (!match) throw new Error(`invalid SHA256SUMS line: ${trimmed.slice(0, 80)}`);
    records.push({ sha256: match[1].toLowerCase(), path: match[2].replaceAll("\\", "/") });
  }
  return records;
}

async function verifyFile(workspaceRoot, descriptor) {
  const resolved = resolveManifestPath(workspaceRoot, descriptor.path);
  const linkInfo = await lstat(resolved);
  if (!linkInfo.isFile() || linkInfo.isSymbolicLink()) throw new Error(`artifact is not a regular file: ${descriptor.path}`);
  const bytes = await readFile(resolved);
  const metadata = linkInfo;
  const actual = { path: descriptor.path.replaceAll("\\", "/"), size: metadata.size, sha256: sha256(bytes) };
  if (actual.size !== descriptor.size || actual.sha256 !== descriptor.sha256) {
    throw new Error(`artifact hash mismatch: ${actual.path}`);
  }
  return actual;
}

export async function verifyReleasePreflight({
  manifestPath,
  shaSumsPath = null,
  workspaceRoot = repositoryRoot,
  expectedGitSha = null,
  requireClean = true,
  requiredArtifacts = ["web", "api"],
} = {}) {
  if (!manifestPath) throw new Error("--manifest is required");
  const root = path.resolve(workspaceRoot);
  const manifestAbsolute = path.resolve(manifestPath);
  if (!insideRoot(root, manifestAbsolute)) throw new Error("manifest must be inside the workspace");
  const manifestInfo = await lstat(manifestAbsolute);
  if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink()) throw new Error("manifest must be a regular file");
  const manifest = JSON.parse(await readFile(manifestAbsolute, "utf8"));
  if (!RELEASE_ID_PATTERN.test(String(manifest.releaseId ?? ""))) throw new Error("manifest releaseId is invalid");
  if (manifest.releaseId !== `${manifest.appVersion}-${manifest.releaseId.split("-").at(-1)}`) throw new Error("manifest appVersion/releaseId are inconsistent");
  if (!manifest.git || manifest.git.clean !== true) throw new Error("manifest is not marked clean");
  if (!/^[0-9a-f]{40}$/.test(String(manifest.git.sha ?? ""))) throw new Error("manifest git SHA is invalid");
  const actualGitSha = gitText(["rev-parse", "HEAD"], root);
  if (!actualGitSha || actualGitSha !== manifest.git.sha || (expectedGitSha && expectedGitSha !== actualGitSha)) {
    throw new Error("checked-out Git SHA does not match manifest");
  }
  const dirty = Boolean(gitText(["status", "--porcelain"], root));
  if (requireClean && dirty) throw new Error("working tree is dirty");
  if (manifest.buildId !== `${manifest.appVersion}+${manifest.releaseId.split("-").at(-1)}`) {
    throw new Error("manifest buildId/releaseId are inconsistent");
  }
  if (!Array.isArray(manifest.files) || manifest.files.length !== manifest.fileCount) throw new Error("manifest file list is invalid");
  if (!/^[0-9a-f]{64}$/i.test(String(manifest.aggregateSha256 ?? ""))) throw new Error("manifest aggregate SHA-256 is invalid");
  const descriptorPaths = new Set();
  for (const descriptor of manifest.files) {
    if (!descriptor || typeof descriptor !== "object" || typeof descriptor.path !== "string" ||
      !Number.isSafeInteger(descriptor.size) || descriptor.size < 0 || !/^[0-9a-f]{64}$/i.test(String(descriptor.sha256 ?? ""))) {
      throw new Error("manifest file descriptor is invalid");
    }
    const normalizedPath = descriptor.path.replaceAll("\\", "/");
    const pathKey = normalizedPath.toLowerCase();
    if (descriptorPaths.has(pathKey)) throw new Error(`duplicate manifest path: ${normalizedPath}`);
    descriptorPaths.add(pathKey);
  }
  const files = [];
  for (const descriptor of manifest.files) files.push(await verifyFile(root, descriptor));
  if (aggregateManifestHash(files) !== manifest.aggregateSha256) throw new Error("manifest aggregate SHA-256 mismatch");

  let shaSumsVerified = null;
  if (shaSumsPath) {
    const sumsAbsolute = resolveManifestPath(root, path.relative(root, path.resolve(shaSumsPath)));
    const sumsInfo = await lstat(sumsAbsolute);
    if (!sumsInfo.isFile() || sumsInfo.isSymbolicLink()) throw new Error("SHA256SUMS must be a regular file");
    const records = parseSha256Sums(await readFile(sumsAbsolute, "utf8"));
    const seen = new Set();
    for (const record of records) {
      if (seen.has(record.path)) throw new Error(`duplicate SHA256SUMS path: ${record.path}`);
      seen.add(record.path);
    }
    const expectedByPath = new Map(files.map((file) => [file.path, file.sha256]));
    for (const file of files) {
      const record = records.find((entry) => entry.path === file.path);
      if (!record || record.sha256 !== file.sha256) throw new Error(`SHA256SUMS missing manifest file: ${file.path}`);
    }
    for (const record of records) {
      const expected = expectedByPath.get(record.path);
      if (!expected || expected !== record.sha256) {
        // SHA lists may include handoff metadata in addition to manifest files;
        // verify those entries independently rather than silently ignoring them.
        const actual = await verifyFile(root, { path: record.path, size: (await stat(resolveManifestPath(root, record.path))).size, sha256: record.sha256 });
        if (actual.sha256 !== record.sha256) throw new Error(`SHA256SUMS mismatch: ${record.path}`);
      }
    }
    shaSumsVerified = records.length;
  }

  const artifacts = {};
  for (const kind of requiredArtifacts) {
    const matches = files.filter((file) => path.posix.basename(file.path).endsWith(`-${kind}.tar.gz`));
    if (matches.length !== 1) throw new Error(`required ${kind} archive is missing or ambiguous`);
    artifacts[kind] = matches[0];
  }
  return {
    ok: true,
    releaseId: manifest.releaseId,
    appVersion: manifest.appVersion,
    buildId: manifest.buildId,
    gitSha: actualGitSha,
    clean: !dirty,
    fileCount: files.length,
    aggregateSha256: manifest.aggregateSha256,
    shaSumsVerified,
    artifacts,
  };
}

function usage() {
  return "Usage: node scripts/release-preflight.mjs --manifest <candidate.json> [--sha-sums <SHA256SUMS.txt>] [--workspace <root>] [--require-artifacts web,api] [--allow-dirty]";
}

async function main() {
  const values = process.argv.slice(2);
  const value = (flag) => { const index = values.indexOf(flag); return index >= 0 ? values[index + 1] : null; };
  if (values.includes("--help") || values.includes("-h")) { console.log(usage()); return; }
  const workspaceRoot = path.resolve(value("--workspace") || repositoryRoot);
  const resolveCliPath = (candidate) => candidate ? (path.isAbsolute(candidate) ? candidate : path.resolve(workspaceRoot, candidate)) : null;
  const required = (value("--require-artifacts") || "web,api").split(",").map((entry) => entry.trim()).filter(Boolean);
  const report = await verifyReleasePreflight({
    manifestPath: resolveCliPath(value("--manifest")) || "",
    shaSumsPath: resolveCliPath(value("--sha-sums")),
    workspaceRoot,
    expectedGitSha: value("--expected-sha"),
    requireClean: !values.includes("--allow-dirty"),
    requiredArtifacts: required,
  });
  console.log(JSON.stringify(report));
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    process.exitCode = 1;
  });
}
