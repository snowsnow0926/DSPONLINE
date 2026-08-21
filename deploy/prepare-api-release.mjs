import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import {
  access,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
} from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultRepositoryRoot = path.resolve(scriptDirectory, "..");

export const API_SERVER_RELEASE_FILES = Object.freeze([
  "server/activity.mjs",
  "server/activity.test.mjs",
  "server/account-security.mjs",
  "server/account-security.test.mjs",
  "server/analytics.mjs",
  "server/analytics.test.mjs",
  "server/account-archive.mjs",
  "server/account-archive-file.mjs",
  "server/account-archive-file.test.mjs",
  "server/account-archive-import.mjs",
  "server/account-archive-import-worker.mjs",
  "server/account-archive-import.test.mjs",
  "server/account-archive-import.integration.test.mjs",
  "server/account-archive-legacy-json.mjs",
  "server/account-archive-legacy-json.test.mjs",
  "server/account-archive-legacy-json.integration.test.mjs",
  "server/account-archive.test.mjs",
  "server/account-archive.integration.test.mjs",
  "server/cloud-governance.mjs",
  "server/cloud-governance.test.mjs",
  "server/cloud-payload-maintenance.mjs",
  "server/cloud-payload-maintenance.test.mjs",
  "server/cloud-payload-store.mjs",
  "server/cloud-payload-store.test.mjs",
  "server/cloud-quota.integration.test.mjs",
  "server/cloud-quota.mjs",
  "server/cloud-quota.test.mjs",
  "server/cloud-transfer-contract.json",
  "server/cloud-save-v46-sparse.test.mjs",
  "server/upload-inspection-scheduler.mjs",
  "server/upload-inspection-worker.mjs",
  "server/upload-inspection-benchmark.mjs",
  "server/upload-inspection.test.mjs",
  "server/web-session.mjs",
  "server/web-session.test.mjs",
  "server/web-session.integration.test.mjs",
  "server/index.mjs",
  "server/http-security.mjs",
  "server/http-security.test.mjs",
  "server/http-security.integration.test.mjs",
  "server/http-route-policy.mjs",
  "server/http-route-policy.test.mjs",
  "server/galactic-metrics.mjs",
  "server/leaderboard-integrity.mjs",
  "server/leaderboard-integrity.test.mjs",
  "server/leaderboard-review.mjs",
  "server/leaderboard-review.test.mjs",
  "server/leaderboard-review-report.mjs",
  "server/leaderboard-review-report.test.mjs",
  "server/leaderboard-review.integration.test.mjs",
  "server/leaderboard-revalidation.integration.test.mjs",
  "server/leaderboard-moderation.mjs",
  "server/leaderboard-moderation.test.mjs",
  "server/mail.mjs",
  "server/mail.test.mjs",
  "server/moderate-leaderboard.mjs",
  "server/package.json",
  "server/package-lock.json",
  "server/persistence-atomicity.integration.test.mjs",
  "server/runtime-indexes.mjs",
  "server/runtime-indexes.test.mjs",
  "server/runtime-indexes.integration.test.mjs",
  "server/runtime-indexes-benchmark.mjs",
  "server/runtime-state-persistence.mjs",
  "server/runtime-state-persistence.test.mjs",
  "server/runtime-state-persistence.integration.test.mjs",
  "server/runtime-state-persistence-benchmark.mjs",
  "server/save-integrity.mjs",
  "server/save-field-contract.mjs",
  "server/save-field-contract.test.mjs",
  "server/server.test.mjs",
  "server/security-governance.integration.test.mjs",
  "server/station-profile.mjs",
  "server/station-profile.test.mjs",
  "server/speedrun-recovery.mjs",
  "server/speedrun-recovery.test.mjs",
  "server/speedrun.test.mjs",
]);

export const API_DEPLOY_RELEASE_FILES = Object.freeze([
  "deploy/active-api-environment.mjs",
  "deploy/api-active-entry.sh",
  "deploy/api-handoff-proxy.mjs",
  "deploy/api-writer-lock.sh",
  "deploy/dsp-idle-api-active.service",
  "deploy/dsp-idle-api-handoff-proxy.service",
  "deploy/dsp-idle-api-preflight.service",
  "deploy/dsp-idle-healthcheck.service",
  "deploy/dsp-idle-runtime.env.example",
  "deploy/dsp-idle-leaderboard-review-report.service",
  "deploy/dsp-idle-leaderboard-review-report.timer",
  "deploy/mail-templates/account-verification.html",
  "deploy/mail-templates/password-reset.html",
  "deploy/backup-crypto.mjs",
  "deploy/backup-sqlite.mjs",
  "deploy/create-offsite-backup.mjs",
  "deploy/probe-node-health.mjs",
  "deploy/probe-api-readiness.mjs",
  "deploy/release-backup-evidence.mjs",
  "deploy/release-switch.mjs",
  "deploy/restore-drill.mjs",
  "deploy/sqlite-snapshot.mjs",
  "deploy/switch-release.sh",
]);

export const API_ARCHIVE_SOURCE_FILES = Object.freeze([
  "cloud-transfer-contract.json",
  "save-field-contract.json",
  "save-field-contract.mjs",
  ...API_DEPLOY_RELEASE_FILES,
  ...API_SERVER_RELEASE_FILES,
].sort());

function normalizeRelativePath(value) {
  return value.replaceAll("\\", "/");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function expectedExpandedFiles() {
  return [...new Set([
    ...API_ARCHIVE_SOURCE_FILES,
    ...API_SERVER_RELEASE_FILES.map((file) => path.posix.basename(normalizeRelativePath(file))),
  ])].sort();
}

function flattenedServerSource(sourceFile) {
  // The source-tree wrapper imports the root contract through `../`. The
  // flattened systemd runtime must receive the root implementation itself;
  // copying the wrapper over it would leave an invalid parent-directory import.
  return sourceFile === "server/save-field-contract.mjs"
    ? "save-field-contract.mjs"
    : sourceFile;
}

async function listFiles(directory, prefix = "") {
  const children = await readdir(path.join(directory, prefix), { withFileTypes: true });
  const files = [];
  for (const child of children.sort((left, right) => left.name.localeCompare(right.name))) {
    const relativePath = path.join(prefix, child.name);
    if (child.isDirectory()) files.push(...await listFiles(directory, relativePath));
    else if (child.isFile()) files.push(normalizeRelativePath(relativePath));
    else throw new Error(`API release contains unsupported filesystem entry: ${normalizeRelativePath(relativePath)}`);
  }
  return files;
}

function assertExactFileSet(actualFiles, expectedFiles, label) {
  const actual = [...actualFiles].sort();
  const expected = [...expectedFiles].sort();
  const missing = expected.filter((file) => !actual.includes(file));
  const unexpected = actual.filter((file) => !expected.includes(file));
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(`${label} file set mismatch (missing: ${missing.join(", ") || "none"}; unexpected: ${unexpected.join(", ") || "none"})`);
  }
}

function assertNoForbiddenReleasePath(files) {
  const forbiddenFilePattern = /(^|\/)(?:\.env(?:\..*)?|data(?:\/|$)|node_modules(?:\/|$))|\.(?:db|key|p12|pem|pfx|sqlite)(?:-|$|\.)/i;
  const forbidden = files.find((file) => forbiddenFilePattern.test(file));
  if (forbidden) throw new Error(`API release contains forbidden path: ${forbidden}`);
}

function checkedOutputDirectory(repositoryRoot, outputDirectory) {
  const sourceRoot = path.resolve(repositoryRoot);
  const outputRoot = path.resolve(outputDirectory);
  if (outputRoot === sourceRoot || outputRoot === path.parse(outputRoot).root) {
    throw new Error("API release output must be a dedicated directory");
  }
  return outputRoot;
}

async function assertEmptyOrMissing(directory) {
  try {
    const metadata = await stat(directory);
    if (!metadata.isDirectory()) throw new Error("API release output exists and is not a directory");
    if ((await readdir(directory)).length > 0) throw new Error("API release output directory must be empty");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function copyRelativeFile(sourceRoot, destinationRoot, relativePath) {
  const destination = path.resolve(destinationRoot, relativePath);
  if (!destination.startsWith(`${path.resolve(destinationRoot)}${path.sep}`)) {
    throw new Error(`API release path escapes output: ${relativePath}`);
  }
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(path.resolve(sourceRoot, relativePath), destination);
}

async function assertByteEqual(leftPath, rightPath, message) {
  const left = await readFile(leftPath);
  const right = await readFile(rightPath);
  if (!left.equals(right)) throw new Error(message);
}

async function aggregateSha256(directory, files) {
  const lines = [];
  for (const file of files) {
    const bytes = await readFile(path.join(directory, file));
    lines.push(`${sha256(bytes)} ${bytes.byteLength} ${file}\n`);
  }
  return sha256(Buffer.from(lines.join("")));
}

export async function verifyApiArchiveLayout({
  repositoryRoot = defaultRepositoryRoot,
  archiveRoot,
} = {}) {
  if (!archiveRoot) throw new Error("API archive root is required");
  const sourceRoot = path.resolve(repositoryRoot);
  const candidateRoot = path.resolve(archiveRoot);
  const files = await listFiles(candidateRoot);
  assertNoForbiddenReleasePath(files);
  assertExactFileSet(files, API_ARCHIVE_SOURCE_FILES, "API archive");

  for (const file of API_ARCHIVE_SOURCE_FILES) {
    await assertByteEqual(
      path.join(sourceRoot, file),
      path.join(candidateRoot, file),
      `API archive source byte mismatch: ${file}`,
    );
  }
  await assertByteEqual(
    path.join(candidateRoot, "cloud-transfer-contract.json"),
    path.join(candidateRoot, "server", "cloud-transfer-contract.json"),
    "API archive transfer contract copies differ",
  );

  return {
    fileCount: files.length,
    aggregateSha256: await aggregateSha256(candidateRoot, files),
  };
}

export async function stageApiArchiveLayout({
  repositoryRoot = defaultRepositoryRoot,
  archiveRoot,
} = {}) {
  if (!archiveRoot) throw new Error("API archive output is required");
  const sourceRoot = path.resolve(repositoryRoot);
  const outputRoot = checkedOutputDirectory(sourceRoot, archiveRoot);
  await assertEmptyOrMissing(outputRoot);
  await mkdir(outputRoot, { recursive: true });
  for (const file of API_ARCHIVE_SOURCE_FILES) await copyRelativeFile(sourceRoot, outputRoot, file);
  return verifyApiArchiveLayout({ repositoryRoot: sourceRoot, archiveRoot: outputRoot });
}

export async function verifyExpandedApiReleaseLayout({
  repositoryRoot = defaultRepositoryRoot,
  releaseRoot,
} = {}) {
  if (!releaseRoot) throw new Error("API release root is required");
  const sourceRoot = path.resolve(repositoryRoot);
  const candidateRoot = path.resolve(releaseRoot);
  const files = await listFiles(candidateRoot);
  assertNoForbiddenReleasePath(files);
  assertExactFileSet(files, expectedExpandedFiles(), "expanded API release");

  for (const sourceFile of API_SERVER_RELEASE_FILES) {
    const entryName = path.posix.basename(normalizeRelativePath(sourceFile));
    await assertByteEqual(
      path.join(candidateRoot, flattenedServerSource(sourceFile)),
      path.join(candidateRoot, entryName),
      `expanded API entry differs from packaged server source: ${entryName}`,
    );
  }
  await assertByteEqual(
    path.join(sourceRoot, "cloud-transfer-contract.json"),
    path.join(candidateRoot, "cloud-transfer-contract.json"),
    "expanded API transfer contract differs from the shared source contract",
  );
  await assertByteEqual(
    path.join(sourceRoot, "save-field-contract.mjs"),
    path.join(candidateRoot, "save-field-contract.mjs"),
    "expanded API save-field contract differs from the shared source implementation",
  );
  await assertByteEqual(
    path.join(sourceRoot, "save-field-contract.json"),
    path.join(candidateRoot, "save-field-contract.json"),
    "expanded API save-field declaration differs from the shared source contract",
  );

  return {
    fileCount: files.length,
    archiveFileCount: API_ARCHIVE_SOURCE_FILES.length,
    aggregateSha256: await aggregateSha256(candidateRoot, files),
  };
}

export async function expandApiReleaseLayout({
  repositoryRoot = defaultRepositoryRoot,
  releaseRoot,
} = {}) {
  if (!releaseRoot) throw new Error("API release root is required");
  const sourceRoot = path.resolve(repositoryRoot);
  const candidateRoot = path.resolve(releaseRoot);
  await verifyApiArchiveLayout({ repositoryRoot: sourceRoot, archiveRoot: candidateRoot });

  for (const sourceFile of API_SERVER_RELEASE_FILES) {
    const entryName = path.basename(sourceFile);
    const source = path.join(candidateRoot, flattenedServerSource(sourceFile));
    const destination = path.join(candidateRoot, entryName);
    if (source === destination) {
      await assertByteEqual(source, destination, `cannot flatten missing shared API source: ${entryName}`);
      continue;
    }
    if (entryName === "cloud-transfer-contract.json") {
      await assertByteEqual(source, destination, "cannot flatten mismatched API transfer contracts");
    }
    await copyFile(source, destination);
  }
  return verifyExpandedApiReleaseLayout({ repositoryRoot: sourceRoot, releaseRoot: candidateRoot });
}

export async function stageExpandedApiRelease({
  repositoryRoot = defaultRepositoryRoot,
  releaseRoot,
} = {}) {
  await stageApiArchiveLayout({ repositoryRoot, archiveRoot: releaseRoot });
  return expandApiReleaseLayout({ repositoryRoot, releaseRoot });
}

async function locateNpmCli() {
  const candidates = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    path.resolve(path.dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    path.resolve(path.dirname(process.execPath), "..", "lib64", "node_modules", "npm", "bin", "npm-cli.js"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return path.resolve(candidate);
    } catch {
      // Try the next deterministic npm installation path.
    }
  }
  return null;
}

export async function installApiProductionDependencies(releaseRoot) {
  const npmCli = await locateNpmCli();
  const environment = {
    ...process.env,
    npm_config_audit: "false",
    npm_config_fund: "false",
  };
  const args = ["ci", "--omit=dev", "--no-audit", "--no-fund"];
  const command = npmCli ? process.execPath : "npm";
  const commandArgs = npmCli ? [npmCli, ...args] : args;
  const result = await execFileAsync(command, commandArgs, {
    cwd: path.resolve(releaseRoot),
    env: environment,
    timeout: 120_000,
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  });
  return { stdout: result.stdout, stderr: result.stderr };
}

async function reserveLocalPort() {
  const probe = createNetServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  const port = typeof address === "object" && address ? address.port : null;
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  if (!Number.isInteger(port)) throw new Error("unable to reserve an API smoke-test port");
  return port;
}

function isolatedApiEnvironment(databaseFile, port) {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => (
    !key.startsWith("DSP_") && !["HOST", "NODE_ENV", "NODE_OPTIONS", "PORT"].includes(key)
  )));
  return {
    ...clean,
    NODE_ENV: "production",
    HOST: "127.0.0.1",
    PORT: String(port),
    DSP_CLOUD_DATABASE_FILE: databaseFile,
    DSP_CLOUD_DATA_FILE: "",
    DSP_CLOUD_BACKUP_DIRECTORY: "",
    DSP_CLOUD_PRUNE_INTERVAL_MS: "0",
  };
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const exited = await Promise.race([
    new Promise((resolve) => child.once("exit", () => resolve(true))),
    new Promise((resolve) => setTimeout(() => resolve(false), 5_000)),
  ]);
  if (!exited && child.exitCode === null) child.kill("SIGKILL");
}

export async function smokeExpandedApiRelease({ releaseRoot, timeoutMs = 30_000 } = {}) {
  if (!releaseRoot) throw new Error("API release root is required");
  const candidateRoot = path.resolve(releaseRoot);
  const databaseDirectory = await mkdtemp(path.join(tmpdir(), "dsp-api-layout-db-"));
  const databaseFile = path.join(databaseDirectory, "cloud.sqlite");
  const port = await reserveLocalPort();
  const child = execFile(process.execPath, [path.join(candidateRoot, "index.mjs")], {
    cwd: candidateRoot,
    env: isolatedApiEnvironment(databaseFile, port),
    windowsHide: true,
  });
  let processError = null;
  let output = "";
  child.once("error", (error) => { processError = error; });
  child.stdout?.on("data", (chunk) => { output = `${output}${chunk}`.slice(-20_000); });
  child.stderr?.on("data", (chunk) => { output = `${output}${chunk}`.slice(-20_000); });

  try {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (processError) throw processError;
      if (child.exitCode !== null) {
        throw new Error(`API release entry exited with code ${child.exitCode}${output.trim() ? `\n${output.trim()}` : ""}`);
      }
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1_000) });
        if (response.ok) {
          const health = await response.json();
          if (health?.ok !== true || health?.service !== "dsp-idle-cloud" || health?.storage !== "sqlite") {
            throw new Error("API release health response has an unexpected contract");
          }
          await access(databaseFile);
          return { status: response.status, health };
        }
      } catch (error) {
        if (error?.message === "API release health response has an unexpected contract") throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`API release health check timed out after ${timeoutMs} ms${output.trim() ? `\n${output.trim()}` : ""}`);
  } finally {
    await stopChild(child);
    const resolvedTemporary = path.resolve(databaseDirectory);
    if (path.dirname(resolvedTemporary) !== path.resolve(tmpdir()) || !path.basename(resolvedTemporary).startsWith("dsp-api-layout-db-")) {
      throw new Error("refusing to remove an unexpected API smoke-test directory");
    }
    await rm(resolvedTemporary, { recursive: true, force: true });
  }
}

export async function verifyApiReleaseCandidate({
  repositoryRoot = defaultRepositoryRoot,
  releaseRoot,
} = {}) {
  await verifyExpandedApiReleaseLayout({ repositoryRoot, releaseRoot });
  const verificationRoot = await mkdtemp(path.join(tmpdir(), "dsp-api-layout-verify-"));
  const candidateRoot = path.join(verificationRoot, "release");
  try {
    await cp(path.resolve(releaseRoot), candidateRoot, { recursive: true, errorOnExist: true, force: false });
    await installApiProductionDependencies(candidateRoot);
    return await smokeExpandedApiRelease({ releaseRoot: candidateRoot });
  } finally {
    const resolvedTemporary = path.resolve(verificationRoot);
    if (path.dirname(resolvedTemporary) !== path.resolve(tmpdir()) || !path.basename(resolvedTemporary).startsWith("dsp-api-layout-verify-")) {
      throw new Error("refusing to remove an unexpected API verification directory");
    }
    await rm(resolvedTemporary, { recursive: true, force: true });
  }
}

function parseArguments(values) {
  const outputIndex = values.indexOf("--output");
  if (outputIndex < 0 || !values[outputIndex + 1] || values[outputIndex + 1].startsWith("--")) {
    throw new Error("Usage: node deploy/prepare-api-release.mjs --output <empty-directory> [--source <repository>] [--skip-smoke]");
  }
  const sourceIndex = values.indexOf("--source");
  return {
    output: values[outputIndex + 1],
    source: sourceIndex >= 0 ? values[sourceIndex + 1] : defaultRepositoryRoot,
    verify: !values.includes("--skip-smoke"),
  };
}

async function startFromCli() {
  const options = parseArguments(process.argv.slice(2));
  const repositoryRoot = path.resolve(options.source);
  const releaseRoot = path.resolve(options.output);
  const staged = await stageExpandedApiRelease({ repositoryRoot, releaseRoot });
  const smoke = options.verify ? await verifyApiReleaseCandidate({ repositoryRoot, releaseRoot }) : null;
  console.log(JSON.stringify({ releaseRoot, ...staged, smoke }));
}

function isDirectInvocation() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(path.resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectInvocation()) {
  startFromCli().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
