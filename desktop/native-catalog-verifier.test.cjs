"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { createHash } = require("node:crypto");
const digest = (value) => createHash("sha256").update(value).digest("hex");
const pin = "cd".repeat(32);
const body = Buffer.from('{"kind":"TEST_ONLY"}');

function harness(t, behavior, { neverClose = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsp-catalog-main-test-"));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(root, "native"));
  const executable = path.join(root, "native", "dsp-catalog-verifier.exe");
  fs.writeFileSync(executable, "TEST_ONLY dummy executable; never executed");
  const trace = { spawns: 0, killed: 0, priorities: [] };
  const module = { exports: {} };
  const spawn = (program, args, options) => {
    trace.spawns++;
    assert.equal(program, executable);
    assert.deepEqual(Array.from(args), []);
    assert.equal(options.windowsHide, true);
    assert.equal(options.shell, false);
    assert.equal(options.cwd, root);
    assert.deepEqual(Object.keys(options.env).sort(), ["SystemRoot", "WINDIR"]);
    const child = new EventEmitter();
    child.pid = 123;
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    let closed = false;
    const close = (code = 0) => { if (!closed) { closed = true; child.emit("close", code, null); } };
    child.kill = () => { trace.killed++; if (!neverClose) queueMicrotask(() => close(1)); return !neverClose; };
    let input = "";
    child.stdin.on("data", (chunk) => { input += chunk; });
    child.stdin.on("finish", () => queueMicrotask(() => behavior({ child, request: JSON.parse(input), close })));
    queueMicrotask(() => child.emit("spawn"));
    return child;
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "native-catalog-verifier.cjs"), "utf8"), {
    module, Buffer, process, setTimeout: (fn, delay) => setTimeout(fn, Math.min(delay, 40)), clearTimeout,
    require(name) {
      if (name === "node:child_process") return { spawn };
      if (name === "node:os") return { ...os, setPriority: (...args) => trace.priorities.push(args) };
      return require(name);
    },
  });
  const policy = { installationRoot: root, executableSha256: digest(fs.readFileSync(executable)), publisherCertificateSha256: [pin] };
  return { ...module.exports, root, executable, trace, policy };
}

function response(request, changes = {}) {
  return { schemaVersion: 1, requestId: request.requestId, status: "authenticated",
    memberHex: body.toString("hex"), memberSha256: digest(body), catalogSha256: "ab".repeat(32),
    publisherCertificateSha256: pin, ...changes };
}
function write(child, value) { child.stdout.end(JSON.stringify(value) + "\n"); }
const windows = { skip: process.platform !== "win32" };

test("main requires independent policy and verifies fixed helper identity before starting", windows, async (t) => {
  const h = harness(t, () => assert.fail("untrusted helper must not start"));
  for (const change of [{ publisherCertificateSha256: [] }, { publisherCertificateSha256: [pin, pin] },
    { installationRoot: "relative" }, { executableSha256: "bad" }]) {
    assert.throws(() => h.createWindowsCatalogVerifier({ ...h.policy, ...change }), /invalid-verifier-policy/);
  }
  const verifier = h.createWindowsCatalogVerifier(h.policy);
  fs.appendFileSync(h.executable, "changed");
  await assert.rejects(verifier.authenticate(), /helper-identity-rejected/);
  assert.equal(h.trace.spawns, 0);
});

test("authenticated member is opaque, nonce-bound and copied independently on every read", windows, async (t) => {
  const h = harness(t, ({ child, request, close }) => { write(child, response(request)); close(); });
  const verifier = h.createWindowsCatalogVerifier(h.policy);
  h.policy.publisherCertificateSha256[0] = "ef".repeat(32);
  const token = await verifier.authenticate();
  const first = h.readAuthenticatedCatalogMember(token);
  assert.deepEqual(first.memberBytes, body);
  first.memberBytes.fill(0);
  assert.deepEqual(h.readAuthenticatedCatalogMember(token).memberBytes, body);
  assert.throws(() => h.readAuthenticatedCatalogMember(JSON.parse(JSON.stringify(token))), /unauthenticated/);
  assert.equal(Object.hasOwn(first, "authorityEligible"), false);
  assert.deepEqual(h.trace.priorities, [[123, os.constants.priority.PRIORITY_BELOW_NORMAL]]);
});

test("main rejects forged nonce, digest, publisher, unknown fields and invalid hex", windows, async (t) => {
  for (const changes of [{ requestId: "00".repeat(32) }, { memberSha256: "00".repeat(32) },
    { publisherCertificateSha256: "00".repeat(32) }, { authorityEligible: true }, { memberHex: "ABC" },
    { memberHex: "" }]) {
    const h = harness(t, ({ child, request, close }) => { write(child, response(request, changes)); close(); });
    await assert.rejects(h.createWindowsCatalogVerifier(h.policy).authenticate(), /helper-response-rejected/);
  }
});

test("duplicate response fields and valid response with failing exit cannot authenticate", windows, async (t) => {
  for (const duplicate of [true, false]) {
    const h = harness(t, ({ child, request, close }) => {
      const text = JSON.stringify(response(request));
      child.stdout.end((duplicate ? '{"schemaVersion":1,' + text.slice(1) : text) + "\n");
      close(duplicate ? 0 : 1);
    });
    await assert.rejects(h.createWindowsCatalogVerifier(h.policy).authenticate(), /helper-(response-rejected|process-failed)/);
  }
});

test("controlled Windows trust rejection reaches main without a manufactured snapshot", windows, async (t) => {
  const h = harness(t, ({ child, request, close }) => {
    write(child, { schemaVersion: 1, requestId: request.requestId, status: "rejected", errorCode: "trust-rejected" }); close();
  });
  await assert.rejects(h.createWindowsCatalogVerifier(h.policy).authenticate(), /trust-rejected/);
});

test("oversized output and unexpected diagnostics terminate only the owned helper", windows, async (t) => {
  for (const stderr of [false, true]) {
    const h = harness(t, ({ child }) => {
      if (stderr) child.stderr.write("unexpected diagnostic");
      else child.stdout.write(Buffer.alloc(256 * 1024 * 2 + 1025, 97));
    });
    await assert.rejects(h.createWindowsCatalogVerifier(h.policy).authenticate(), /helper-(output-limit|unexpected-diagnostics)/);
    assert.equal(h.trace.killed, 1);
  }
});

test("deadline rejects concurrent starts and requires confirmed helper termination", windows, async (t) => {
  const h = harness(t, () => {}, { neverClose: true });
  const verifier = h.createWindowsCatalogVerifier(h.policy);
  const pending = verifier.authenticate();
  await assert.rejects(verifier.authenticate(), /helper-busy/);
  await assert.rejects(pending, /helper-termination-unconfirmed/);
  await assert.rejects(verifier.authenticate(), /helper-unavailable/);
  assert.equal(h.trace.spawns, 1);
  assert.equal(h.trace.killed, 1);
});

test("maximum member response remains within bounds and preserves every byte", windows, async (t) => {
  const bytes = Buffer.alloc(256 * 1024, 0xff);
  const h = harness(t, ({ child, request, close }) => {
    write(child, response(request, { memberHex: bytes.toString("hex"), memberSha256: digest(bytes) })); close();
  });
  const token = await h.createWindowsCatalogVerifier(h.policy).authenticate();
  assert.deepEqual(h.readAuthenticatedCatalogMember(token).memberBytes, bytes);
});
