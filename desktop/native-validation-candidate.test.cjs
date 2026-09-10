"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createHash } = require("node:crypto");
const { canonicalCatalogJson } = require("./native-builtin-catalog.cjs");
const { collectValidationMatrixIdentity, deriveValidationRulesSha256,
  collectPackagedWindowsValidationCandidate } = require("./native-validation-candidate.cjs");
const matrix = JSON.parse(fs.readFileSync(path.join(__dirname, "native-validation-matrix-v1.json")));

test("matrix fingerprint is derived from the entire fixed non-authorizing contract", () => {
  const identity = collectValidationMatrixIdentity();
  assert.equal(identity.matrixSha256, createHash("sha256").update(canonicalCatalogJson(matrix)).digest("hex"));
  assert.deepEqual(identity.requiredChecks, matrix.requiredChecks);
  assert.equal(identity.requiredChecks.length, 12);
  assert.ok(Object.isFrozen(identity)); assert.ok(Object.isFrozen(identity.requiredChecks));
});

test("rules identity binds complete Host, ASAR and content and changes on each input", () => {
  const program = { hostSha256: "a".repeat(64), asarSha256: "b".repeat(64) };
  const catalog = "c".repeat(64);
  const base = deriveValidationRulesSha256(program, catalog);
  assert.equal(base, createHash("sha256").update(canonicalCatalogJson({ schemaVersion: 1,
    kind: "native-executable-rules-v1", ...program, catalogSha256: catalog })).digest("hex"));
  assert.notEqual(base, deriveValidationRulesSha256({ ...program, hostSha256: catalog }, catalog));
  assert.notEqual(base, deriveValidationRulesSha256({ ...program, asarSha256: catalog }, catalog));
  assert.notEqual(base, deriveValidationRulesSha256(program, program.hostSha256));
  for (const value of ["", "F".repeat(64), "c".repeat(64) + "\n", null, {}]) {
    assert.throws(() => deriveValidationRulesSha256(program, value));
  }
});

test("workspace caller cannot forge an installed candidate by supplying arguments", async () => {
  await assert.rejects(collectPackagedWindowsValidationCandidate({ sourceSha: "a".repeat(40), resourcesPath: __dirname }));
});

const moduleCode = fs.readFileSync(path.join(__dirname, "native-validation-candidate.cjs"), "utf8");
test("candidate provider anchors to its own ASAR instead of the outer launcher's resources", async () => {
  const root = "C:\\Frozen\\resources";
  const program = { ...require("../native/fixtures/installed-program-v1.json").program,
    hostSha256: "a".repeat(64), asarSha256: "b".repeat(64) };
  const calls = [];
  const bytes = Buffer.from(JSON.stringify(matrix, null, 2) + "\n");
  const module = { exports: {} };
  vm.runInNewContext(moduleCode, { module, __dirname: root + "\\app.asar\\desktop", Buffer, TextDecoder,
    process: { resourcesPath: "C:\\UnrelatedLauncher\\resources" },
    require: name => name === "node:path" ? path.win32
      : name === "node:fs" ? { lstatSync: file => {
        assert.equal(file, root + "\\app.asar\\desktop\\native-validation-matrix-v1.json");
        return { isFile: () => true, isSymbolicLink: () => false, size: bytes.length };
      }, readFileSync: () => bytes }
      : name === "./native-installed-program.cjs" ? { collectPackagedWindowsProgramIdentity: async options => {
        calls.push(options.resourcesPath); return program;
      } } : require(name) });
  const candidate = await module.exports.collectPackagedWindowsValidationCandidate();
  assert.deepEqual(calls, [root]);
  assert.equal(Object.keys(candidate).length, 12); assert.ok(Object.isFrozen(candidate));
  assert.equal(candidate.sourceSha, program.sourceSha);
  assert.equal(candidate.rulesSha256, deriveValidationRulesSha256(program, candidate.catalogSha256));
});
function parseFixture(bytes) {
  const module = { exports: {} };
  const fakeFs = { lstatSync: () => ({ isFile: () => true, isSymbolicLink: () => false, size: bytes.length }),
    readFileSync: () => bytes };
  vm.runInNewContext(moduleCode, { module, __dirname, Buffer, TextDecoder,
    require: name => name === "node:fs" ? fakeFs : require(name) });
  return module.exports.collectValidationMatrixIdentity();
}
for (const [name, mutate] of [
  ["missing check", v => { v.requiredChecks.pop(); }],
  ["duplicate check", v => { v.requiredChecks[0] = v.requiredChecks[1]; }],
  ["skips", v => { v.resultPolicy.maximumSkipped = 1; }],
  ["flaky", v => { v.resultPolicy.maximumFlaky = 1; }],
  ["zero passes", v => { v.resultPolicy.minimumPassed = 0; }],
  ["player grant", v => { v.authorityEligible = true; }],
  ["release", v => { v.releaseAllowed = true; }],
  ["release evidence", v => { v.evidenceClass = "RELEASE"; }],
  ["scope", v => { v.scope = "windows-speedrun"; }],
  ["extra field", v => { v.unknownField = true; }],
]) test(`matrix rejects ${name}`, () => {
  const value = structuredClone(matrix); mutate(value);
  assert.throws(() => parseFixture(Buffer.from(JSON.stringify(value, null, 2) + "\n")));
});
test("matrix rejects duplicate fields, malformed UTF8 and excess bytes", () => {
  const raw = JSON.stringify(matrix, null, 2) + "\n";
  for (const bytes of [Buffer.from(raw.replace('"schemaVersion": 1', '"schemaVersion": 1, "schemaVersion": 1')),
    Buffer.from([0xff]), Buffer.alloc(16 * 1024 + 1)]) assert.throws(() => parseFixture(bytes));
});
