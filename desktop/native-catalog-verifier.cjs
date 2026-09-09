"use strict";

// Main-process foundation only; no renderer IPC and no gameplay activation.
// The installation directory and executable digest must come from trusted
// program identity, independently of the qualification file being verified.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");
const { createHash, randomBytes } = require("node:crypto");

const MAX_MEMBER_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = MAX_MEMBER_BYTES * 2 + 1024;
const DIGEST = /^[a-f0-9]{64}$/;
const ERROR_CODES = new Set([
  "unsupported-platform", "invalid-publisher-policy", "unsafe-path", "invalid-file-size",
  "carrier-io", "trust-api-unavailable", "catalog-operation-failed", "trust-rejected",
  "missing-publisher", "weak-signature-digest", "publisher-mismatch",
]);
const snapshots = new WeakMap();
const fail = (code) => Object.assign(new Error(code), { code });
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sameFile = (left, right) => left.dev === right.dev && left.ino === right.ino
  && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;

function validateExecutable(root, expectedDigest) {
  // The program installation is a trusted boundary. These checks detect
  // redirects/replacements, but Node cannot lock an executable against a
  // privileged OS attacker racing CreateProcess. Do not claim that protection.
  const directories = [];
  let current = path.parse(root).root;
  for (const part of [...root.slice(current.length).split(path.sep).filter(Boolean), "native"]) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail("helper-identity-rejected");
    directories.push([current, stat]);
  }
  const executable = path.join(root, "native", "dsp-catalog-verifier.exe");
  const before = fs.lstatSync(executable);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1
      || before.size < 1 || before.size > 32 * 1024 * 1024) throw fail("helper-identity-rejected");
  const handle = fs.openSync(executable, "r");
  try {
    const opened = fs.fstatSync(handle);
    if (!sameFile(before, opened) || opened.nlink !== 1) throw fail("helper-identity-rejected");
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let total = 0;
    while (total < opened.size) {
      const count = fs.readSync(handle, buffer, 0, Math.min(buffer.length, opened.size - total), total);
      if (count === 0) throw fail("helper-identity-rejected");
      hash.update(buffer.subarray(0, count));
      total += count;
    }
    if (hash.digest("hex") !== expectedDigest || !sameFile(opened, fs.fstatSync(handle))
        || !sameFile(opened, fs.lstatSync(executable))) throw fail("helper-identity-rejected");
    for (const [directory, identity] of directories) {
      const after = fs.lstatSync(directory);
      if (!after.isDirectory() || after.isSymbolicLink() || identity.ino !== after.ino
          || identity.dev !== after.dev) throw fail("helper-identity-rejected");
    }
  } finally { fs.closeSync(handle); }
  return executable;
}

function acceptResponse(bytes, requestId, publishers) {
  const text = bytes.toString("utf8");
  let result;
  try { result = JSON.parse(text); } catch { throw fail("helper-response-rejected"); }
  // The fixed helper writes compact JSON plus exactly one newline. Reject
  // duplicates, extra output, lossy UTF-8 and alternative number encodings.
  if (JSON.stringify(result) + "\n" !== text || result?.schemaVersion !== 1
      || result.requestId !== requestId) throw fail("helper-response-rejected");
  const keys = Object.keys(result).sort().join(",");
  if (result.status === "rejected") {
    if (keys !== "errorCode,requestId,schemaVersion,status" || !ERROR_CODES.has(result.errorCode)) {
      throw fail("helper-response-rejected");
    }
    throw fail(result.errorCode);
  }
  if (result.status !== "authenticated"
      || keys !== "catalogSha256,memberHex,memberSha256,publisherCertificateSha256,requestId,schemaVersion,status"
      || typeof result.memberHex !== "string" || result.memberHex.length < 2
      || result.memberHex.length > MAX_MEMBER_BYTES * 2 || result.memberHex.length % 2 !== 0
      || !/^[a-f0-9]+$/.test(result.memberHex)
      || !DIGEST.test(result.memberSha256) || !DIGEST.test(result.catalogSha256)
      || !publishers.includes(result.publisherCertificateSha256)) throw fail("helper-response-rejected");
  const memberBytes = Buffer.from(result.memberHex, "hex");
  if (digest(memberBytes) !== result.memberSha256) throw fail("helper-response-rejected");
  const token = Object.freeze(Object.create(null));
  snapshots.set(token, Object.freeze({
    memberBytes, memberSha256: result.memberSha256, catalogSha256: result.catalogSha256,
    publisherCertificateSha256: result.publisherCertificateSha256,
  }));
  return token;
}

function readAuthenticatedCatalogMember(token) {
  const value = snapshots.get(token);
  if (!value) throw fail("unauthenticated-catalog-member");
  return Object.freeze({ ...value, memberBytes: Buffer.from(value.memberBytes) });
}

function createWindowsCatalogVerifier({ installationRoot, executableSha256, publisherCertificateSha256 } = {}) {
  if (process.platform !== "win32") throw fail("unsupported-platform");
  if (typeof installationRoot !== "string" || Buffer.byteLength(installationRoot) > 4096
      || !/^[a-z]:\\/i.test(installationRoot) || path.resolve(installationRoot) !== installationRoot
      || installationRoot.slice(3).split(path.sep).some((part) => /[.:\s]$|[:\0]/.test(part))
      || !DIGEST.test(executableSha256)
      || !Array.isArray(publisherCertificateSha256) || publisherCertificateSha256.length < 1
      || publisherCertificateSha256.length > 8 || publisherCertificateSha256.some((pin) => !DIGEST.test(pin))
      || new Set(publisherCertificateSha256).size !== publisherCertificateSha256.length) {
    throw fail("invalid-verifier-policy");
  }
  const publishers = [...publisherCertificateSha256];
  let pending = false;
  let poisoned = false;
  return Object.freeze({
    async authenticate() {
      if (poisoned) throw fail("helper-unavailable");
      if (pending) throw fail("helper-busy");
      pending = true;
      try {
        const executable = validateExecutable(installationRoot, executableSha256);
        const requestId = randomBytes(32).toString("hex");
        return await new Promise((resolve, reject) => {
          const child = spawn(executable, [], {
            cwd: installationRoot, windowsHide: true, shell: false, stdio: ["pipe", "pipe", "pipe"],
            // There is no test policy or executable override in the child environment.
            env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR },
          });
          const chunks = [];
          let length = 0;
          let failure;
          let killTimer;
          const timer = setTimeout(() => stop("helper-timeout"), 15_000);
          function stop(code) {
            if (failure) return;
            failure ??= fail(code);
            // A failed termination must never leave the caller waiting forever
            // or allow this verifier to launch overlapping replacement children.
            killTimer = setTimeout(() => {
              poisoned = true;
              reject(fail("helper-termination-unconfirmed"));
            }, 2_000);
            child.kill();
          }
          child.once("spawn", () => {
            try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); }
            catch { stop("helper-priority-failed"); }
          });
          child.once("error", () => { failure ??= fail("helper-process-failed"); });
          child.stdin.on("error", () => stop("helper-input-failed"));
          child.stdout.on("error", () => stop("helper-output-failed"));
          child.stderr.on("error", () => stop("helper-output-failed"));
          child.stdout.on("data", (chunk) => {
            length += chunk.length;
            if (length > MAX_RESPONSE_BYTES) stop("helper-output-limit");
            else if (!failure) chunks.push(chunk);
          });
          child.stderr.on("data", () => stop("helper-unexpected-diagnostics"));
          child.once("close", (code, signal) => {
            clearTimeout(timer);
            clearTimeout(killTimer);
            if (failure) return reject(failure);
            if (code !== 0 || signal) return reject(fail("helper-process-failed"));
            try { resolve(acceptResponse(Buffer.concat(chunks, length), requestId, publishers)); }
            catch (error) { reject(error); }
          });
          try {
            child.stdin.end(JSON.stringify({ schemaVersion: 1, requestId, installationRoot,
              publisherCertificateSha256: publishers }));
          } catch { stop("helper-input-failed"); }
        });
      } finally { pending = false; }
    },
  });
}

function createPackagedWindowsCatalogVerifier({ resourcesPath = process.resourcesPath, publisherCertificateSha256 } = {}) {
  // Only trusted main code calls this factory. The executable identity comes
  // from this module's own app.asar, never an external manifest or renderer.
  if (typeof resourcesPath !== "string" || !path.isAbsolute(resourcesPath)
      || path.resolve(__dirname, "..") !== path.join(resourcesPath, "app.asar")) {
    throw fail("catalog-verifier-requires-package");
  }
  const metadata = require("../package.json");
  return createWindowsCatalogVerifier({ installationRoot: resourcesPath,
    executableSha256: metadata.nativeCatalogVerifierSha256, publisherCertificateSha256 });
}

module.exports = { createWindowsCatalogVerifier, createPackagedWindowsCatalogVerifier, readAuthenticatedCatalogMember };
