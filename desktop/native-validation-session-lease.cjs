"use strict";
// Main-only process/lifetime ownership. These opaque tokens prove continuously
// pinned synthetic directories, never gameplay permission or a writer fence.
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");
const { randomBytes } = require("node:crypto");
const { validateCatalogVerifierExecutable } = require("./native-catalog-verifier.cjs");
const { validateValidationSessionSnapshot } = require("./native-validation-session.cjs");
const fail = code => Object.assign(new Error(code), { code });
const hex = (value, length) => typeof value === "string" && value.length === length && /^[a-f0-9]+$/.test(value);
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

function createWindowsValidationSessionLeaseBroker({ installationRoot, executableSha256 } = {}) {
  if (process.platform !== "win32") throw fail("unsupported-platform");
  if (typeof installationRoot !== "string" || !/^[a-z]:\\/i.test(installationRoot)
      || path.resolve(installationRoot) !== installationRoot || installationRoot.length > 4096
      || installationRoot.slice(3).split(path.sep).some(part => /[.:\s]$|[:\0]/.test(part))
      || !hex(executableSha256, 64)) throw fail("validation-lease-policy-rejected");
  const tokens = new WeakMap();
  let active, poisoned = false;

  function requireToken(token) {
    const state = tokens.get(token);
    if (!state) throw fail("validation-lease-token-rejected");
    return state;
  }
  function clearTimers(state) {
    clearTimeout(state.deadline); clearTimeout(state.heartbeat); clearTimeout(state.termination);
  }
  function stop(state, code) {
    if (state.failure || state.phase === "closed") return;
    state.failure = fail(code); state.phase = "stopping";
    clearTimeout(state.deadline); clearTimeout(state.heartbeat);
    // A failed acquisition has no token with which to observe closed(). Do not
    // return its failure until close is confirmed or explicitly unconfirmed.
    state.pending?.reject(state.failure);
    state.pending = undefined;
    state.termination = setTimeout(() => {
      poisoned = true;
      state.ready.reject(fail("validation-lease-termination-unconfirmed"));
      state.closed.resolve(Object.freeze({ released: false, errorCode: "validation-lease-termination-unconfirmed" }));
    }, 2000);
    try { state.child.kill(); } catch { /* The termination deadline remains authoritative. */ }
  }
  function send(state, command) {
    if (state.phase !== "live" || state.failure) return Promise.reject(fail("validation-lease-not-live"));
    if (state.pending) return command === "probe" && state.pending.command === "probe"
      ? state.pending.promise : Promise.reject(fail("validation-lease-request-busy"));
    clearTimeout(state.heartbeat);
    const sequence = state.sequence + 1;
    if (!Number.isSafeInteger(sequence)) { stop(state, "validation-lease-sequence-exhausted"); return Promise.reject(state.failure); }
    const pending = { ...deferred(), sequence, challenge: randomBytes(32).toString("hex"), command };
    state.sequence = sequence; state.pending = pending;
    state.deadline = setTimeout(() => stop(state, "validation-lease-response-timeout"), 5000);
    try {
      state.child.stdin.write(JSON.stringify({ schemaVersion: 1, sequence, challenge: pending.challenge, command }) + "\n");
    } catch { stop(state, "validation-lease-input-failed"); }
    return pending.promise;
  }
  function schedule(state) {
    state.heartbeat = setTimeout(() => { void send(state, "probe").catch(error => stop(state, error.code)); }, 5000);
  }
  function accept(state, bytes) {
    if (state.failure) return;
    let response, snapshot;
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      response = JSON.parse(text);
      if (JSON.stringify(response) + "\n" !== text || Object.keys(response).sort().join(",") !== "challenge,event,kind,schemaVersion,sequence,snapshot"
          || response.schemaVersion !== 1 || response.kind !== "windows-validation-session-lease-v1") throw Error();
      snapshot = validateValidationSessionSnapshot(Buffer.from(JSON.stringify(response.snapshot) + "\n"), state.sessionId);
      if (state.phase === "starting") {
        if (response.event !== "ready" || response.sequence !== 0 || response.challenge !== state.challenge) throw Error();
      } else {
        const pending = state.pending;
        if (state.phase !== "live" || !pending || response.sequence !== pending.sequence || response.challenge !== pending.challenge
            || response.event !== (pending.command === "probe" ? "live" : "released")
            || JSON.stringify(snapshot) !== JSON.stringify(state.snapshot)) throw Error();
      }
    } catch { stop(state, "validation-lease-response-rejected"); return; }
    clearTimeout(state.deadline);
    if (state.phase === "starting") {
      state.snapshot = snapshot; state.phase = "live";
      state.ready.resolve(state.token); schedule(state); return;
    }
    const pending = state.pending; state.pending = undefined;
    if (pending.command === "release") {
      state.phase = "releasing";
      state.releaseAcknowledged = true;
      // An ACK is insufficient: callers wait for a confirmed process close.
      state.deadline = setTimeout(() => stop(state, "validation-lease-close-timeout"), 5000);
      try { state.child.stdin.end(); } catch { stop(state, "validation-lease-input-failed"); }
    } else { schedule(state); }
    pending.resolve(snapshot);
  }

  return Object.freeze({
    async acquire(sessionId) {
      if (poisoned) throw fail("validation-lease-helper-unavailable");
      if (active) throw fail("validation-lease-helper-busy");
      if (!hex(sessionId, 32)) throw fail("validation-lease-id-rejected");
      const executable = validateCatalogVerifierExecutable(installationRoot, executableSha256);
      const token = Object.freeze(Object.create(null));
      const state = { token, sessionId, challenge: randomBytes(32).toString("hex"), sequence: 0,
        phase: "starting", ready: deferred(), closed: deferred(), buffer: Buffer.alloc(0) };
      tokens.set(token, state); active = state;
      try {
        state.child = spawn(executable, ["hold-validation-session", sessionId, state.challenge], {
          cwd: installationRoot, windowsHide: true, shell: false, stdio: ["pipe", "pipe", "pipe"],
          env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, TEMP: os.tmpdir(), TMP: os.tmpdir() },
        });
      } catch { active = undefined; state.phase = "closed"; throw fail("validation-lease-process-failed"); }
      const child = state.child;
      state.deadline = setTimeout(() => stop(state, "validation-lease-start-timeout"), 15000);
      child.once("spawn", () => { try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { stop(state, "validation-lease-priority-failed"); } });
      child.once("error", () => stop(state, "validation-lease-process-failed"));
      child.stdin.on("error", () => stop(state, "validation-lease-input-failed"));
      child.stdout.on("error", () => stop(state, "validation-lease-output-failed"));
      child.stderr.on("error", () => stop(state, "validation-lease-output-failed"));
      child.stderr.on("data", () => stop(state, "validation-lease-helper-rejected"));
      child.stdout.on("data", chunk => {
        if (state.failure || state.phase === "closed") return;
        if (state.buffer.length + chunk.length > 2048) { stop(state, "validation-lease-output-limit"); return; }
        state.buffer = Buffer.concat([state.buffer, chunk]);
        for (let newline; (newline = state.buffer.indexOf(10)) !== -1;) {
          const bytes = state.buffer.subarray(0, newline + 1); state.buffer = state.buffer.subarray(newline + 1);
          accept(state, bytes);
          if (state.failure) break;
        }
        if (state.buffer.length && state.phase !== "starting" && !state.pending) stop(state, "validation-lease-response-rejected");
      });
      child.once("close", (code, signal) => {
        clearTimers(state);
        const released = state.releaseAcknowledged === true && !state.failure && code === 0 && signal === null && state.buffer.length === 0;
        state.failure ??= released ? undefined : fail("validation-lease-lost");
        state.phase = "closed"; if (active === state) active = undefined;
        state.ready.reject(state.failure ?? fail("validation-lease-closed"));
        state.pending?.reject(state.failure ?? fail("validation-lease-closed")); state.pending = undefined;
        state.closed.resolve(Object.freeze(released ? { released: true } : { released: false, errorCode: state.failure.code }));
      });
      const acquired = await state.ready.promise;
      if (state.failure || state.phase !== "live" || active !== state) {
        const result = await state.closed.promise;
        throw fail(result.errorCode ?? "validation-lease-not-live");
      }
      return acquired;
    },
    async probe(token) {
      const state = requireToken(token), snapshot = await send(state, "probe");
      if (state.failure || state.phase !== "live" || active !== state) throw state.failure ?? fail("validation-lease-not-live");
      return snapshot;
    },
    closed(token) { return requireToken(token).closed.promise; },
    async release(token) {
      const state = requireToken(token);
      if (state.releasePromise) return state.releasePromise;
      state.releasePromise = (async () => {
        if (state.pending) await state.pending.promise;
        await send(state, "release");
        const result = await state.closed.promise;
        if (!result.released) throw fail(result.errorCode);
        return result;
      })();
      return state.releasePromise;
    },
  });
}

function createPackagedWindowsValidationSessionLeaseBroker() {
  const archive = path.resolve(__dirname, "..");
  if (path.basename(archive) !== "app.asar") throw fail("validation-lease-requires-package");
  return createWindowsValidationSessionLeaseBroker({ installationRoot: path.dirname(archive),
    executableSha256: require("../package.json").nativeCatalogVerifierSha256 });
}
module.exports = { createWindowsValidationSessionLeaseBroker, createPackagedWindowsValidationSessionLeaseBroker };
