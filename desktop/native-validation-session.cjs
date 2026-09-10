"use strict";
// Main-owned synthetic fixture preparation and independent platform inspection.
// No renderer IPC, qualification grant, Electron profile switch or cloud call.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { createHash, randomBytes } = require("node:crypto");
const { spawn } = require("node:child_process");
const { validateCatalogVerifierExecutable } = require("./native-catalog-verifier.cjs");
const PREFIX = "dspidle-rust-validation-";
const ID = /^[a-f0-9]{32}$/;
const SHA = /^[a-f0-9]{64}$/;
const isId = (value) => typeof value === "string" && value.length === 32 && ID.test(value);
const isSha = (value) => typeof value === "string" && value.length === 64 && SHA.test(value);
const fail = (code) => Object.assign(new Error(code), { code });
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

function fixtureBytes() {
  const file = path.join(__dirname, "native-validation-fixture-v1.json");
  const size = fs.statSync(file).size;
  if (size < 1 || size > 1024 * 1024) throw fail("validation-fixture-rejected");
  const bytes = fs.readFileSync(file);
  if (bytes.length !== size) throw fail("validation-fixture-rejected");
  return bytes;
}

function directDirectories(directory) {
  if (!path.isAbsolute(directory)) throw fail("validation-session-path-rejected");
  let current = path.parse(directory).root;
  for (const part of directory.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw fail("validation-session-path-rejected");
  }
}

function createValidationSessionDirectory() {
  if (process.platform !== "win32") throw fail("unsupported-platform");
  const temporaryRoot = path.resolve(os.tmpdir());
  directDirectories(temporaryRoot);
  const sessionId = randomBytes(16).toString("hex");
  const directory = path.join(temporaryRoot, PREFIX + sessionId);
  // No recursive mkdir or reuse of an existing directory. Failed preparation
  // never imports data, switches a profile, or removes an uncertain path.
  fs.mkdirSync(directory);
  directDirectories(directory);
  const userDataPath = path.join(directory, "profile");
  fs.mkdirSync(userDataPath);
  fs.writeFileSync(path.join(directory, "fixture-v47.json"), fixtureBytes(), { flag: "wx" });
  directDirectories(userDataPath);
  return Object.freeze({ sessionId, directory, userDataPath });
}

function acceptSnapshot(bytes, sessionId) {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  let value;
  try { value = JSON.parse(text); } catch { throw fail("validation-session-response-rejected"); }
  if (JSON.stringify(value) + "\n" !== text
      || Object.keys(value).sort().join(",") !== "authorityEligible,kind,releaseAllowed,schemaVersion,session,sessionId"
      || value.schemaVersion !== 1 || value.kind !== "windows-validation-session-snapshot-v1"
      || value.sessionId !== sessionId || value.authorityEligible !== false || value.releaseAllowed !== false
      || !value.session || Object.keys(value.session).sort().join(",") !== "cloudWrites,fixtureSha256,profileId"
      || !isId(value.session.profileId) || value.session.fixtureSha256 !== sha(fixtureBytes())
      || value.session.cloudWrites !== false) throw fail("validation-session-response-rejected");
  return Object.freeze({ ...value, session: Object.freeze({ ...value.session }) });
}

function createWindowsValidationSessionInspector({ installationRoot, executableSha256 } = {}) {
  if (process.platform !== "win32") throw fail("unsupported-platform");
  if (typeof installationRoot !== "string" || !/^[a-z]:\\/i.test(installationRoot)
      || path.resolve(installationRoot) !== installationRoot || installationRoot.length > 4096
      || installationRoot.slice(3).split(path.sep).some((part) => /[.:\s]$|[:\0]/.test(part))
      || !isSha(executableSha256)) throw fail("validation-session-policy-rejected");
  let pending = false, poisoned = false;
  return Object.freeze({
    async inspect(sessionId) {
      if (poisoned) throw fail("validation-session-helper-unavailable");
      if (pending) throw fail("validation-session-helper-busy");
      if (!isId(sessionId)) throw fail("validation-session-id-rejected");
      pending = true;
      try {
        const executable = validateCatalogVerifierExecutable(installationRoot, executableSha256);
        return await new Promise((resolve, reject) => {
          const child = spawn(executable, ["inspect-validation-session", sessionId], {
            cwd: installationRoot, windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"],
            // Pass only OS lookup inputs. No Rust/qualification/fixture overrides.
            env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
              TEMP: os.tmpdir(), TMP: os.tmpdir() },
          });
          let length = 0, failure, terminationTimer;
          const chunks = [];
          const timer = setTimeout(() => stop("validation-session-helper-timeout"), 15_000);
          function stop(code) {
            if (failure) return;
            failure = fail(code);
            terminationTimer = setTimeout(() => { poisoned = true; reject(fail("validation-session-termination-unconfirmed")); }, 2_000);
            child.kill();
          }
          child.once("spawn", () => {
            try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); }
            catch { stop("validation-session-priority-failed"); }
          });
          child.once("error", () => { failure ??= fail("validation-session-helper-failed"); });
          child.stdout.on("error", () => stop("validation-session-helper-failed"));
          child.stderr.on("error", () => stop("validation-session-helper-failed"));
          child.stdout.on("data", (chunk) => {
            length += chunk.length;
            if (length > 2048) stop("validation-session-output-limit");
            else if (!failure) chunks.push(chunk);
          });
          child.stderr.on("data", () => stop("validation-session-helper-rejected"));
          child.once("close", (code, signal) => {
            clearTimeout(timer); clearTimeout(terminationTimer);
            if (failure) return reject(failure);
            if (code !== 0 || signal) return reject(fail("validation-session-helper-failed"));
            try { resolve(acceptSnapshot(Buffer.concat(chunks, length), sessionId)); }
            catch { reject(fail("validation-session-response-rejected")); }
          });
        });
      } finally { pending = false; }
    },
  });
}

function createPackagedWindowsValidationSessionInspector() {
  const archive = path.resolve(__dirname, "..");
  if (path.basename(archive) !== "app.asar") throw fail("validation-session-requires-package");
  return createWindowsValidationSessionInspector({ installationRoot: path.dirname(archive),
    executableSha256: require("../package.json").nativeCatalogVerifierSha256 });
}

module.exports = { createValidationSessionDirectory, createWindowsValidationSessionInspector,
  createPackagedWindowsValidationSessionInspector };
