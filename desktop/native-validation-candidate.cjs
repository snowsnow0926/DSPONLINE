"use strict";

// Independent installed candidate facts. No path, identity, report, body or
// environment argument can supply the expected candidate. This is not a grant.
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { collectPackagedWindowsProgramIdentity } = require("./native-installed-program.cjs");
const { collectBuiltinCatalogIdentity, canonicalCatalogJson } = require("./native-builtin-catalog.cjs");
const CHECKS = Object.freeze([
  "single-owner", "first-tick", "command-material-conservation", "pause-resume",
  "persist-reopen", "exit-inflight", "lost-ack-retry", "host-restart",
  "threaded-determinism", "compatibility-roundtrip", "realtime-throughput", "process-tree-memory",
]);
const SHA = /^[a-f0-9]{64}$/;
const fullMatch = (v, re) => typeof v === "string" && re.exec(v)?.[0] === v;
const digest = v => createHash("sha256").update(canonicalCatalogJson(v)).digest("hex");
let matrixIdentity;

function collectValidationMatrixIdentity() {
  if (!matrixIdentity) {
    const file = path.join(__dirname, "native-validation-matrix-v1.json");
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > 16 * 1024) {
      throw new Error("validation-matrix-invalid");
    }
    const bytes = fs.readFileSync(file);
    const body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    const expected = { schemaVersion: 1, kind: "native-foundation-evidence-matrix-v1",
      scope: "windows-normal-main-1x-builtin-v1", evidenceClass: "TEST_ONLY",
      reportKind: "native-qualification-check-v1", requiredChecks: CHECKS,
      resultPolicy: { minimumPassed: 1, maximumFailed: 0, maximumSkipped: 0, maximumFlaky: 0 },
      authorityEligible: false, releaseAllowed: false };
    if (bytes.length !== stat.size || !Buffer.from(JSON.stringify(body, null, 2) + "\n").equals(bytes)
        || canonicalCatalogJson(body) !== canonicalCatalogJson(expected)) throw new Error("validation-matrix-invalid");
    matrixIdentity = Object.freeze({ scope: body.scope, matrixSha256: digest(body), requiredChecks: CHECKS });
  }
  return matrixIdentity;
}

// Conservative implementation identity, not semantic equivalence: any changed
// Host/ASAR/catalog invalidates it, including UI-only changes. Compute only
// after the package is frozen, avoiding a hash inside its own input bytes.
function deriveValidationRulesSha256(program, catalogSha256) {
  const fields = [program?.hostSha256, program?.asarSha256, catalogSha256];
  if (!fields.every(value => fullMatch(value, SHA))) throw new Error("validation-rules-invalid");
  return digest({ schemaVersion: 1, kind: "native-executable-rules-v1",
    hostSha256: fields[0], asarSha256: fields[1], catalogSha256: fields[2] });
}

async function collectPackagedWindowsValidationCandidate() {
  // These modules are loaded from this installation; the program provider
  // independently verifies that it is executing within its own ASAR.
  const content = collectBuiltinCatalogIdentity();
  const matrix = collectValidationMatrixIdentity();
  // Anchor to this module's own ASAR, including when the verified readonly
  // package probe loads it through an external Electron launcher. The sibling
  // program provider still independently checks its own ASAR location.
  const resourcesPath = path.dirname(path.resolve(__dirname, ".."));
  const program = await collectPackagedWindowsProgramIdentity({ resourcesPath });
  return Object.freeze({ ...program, catalogSha256: content.catalogSha256,
    rulesSha256: deriveValidationRulesSha256(program, content.catalogSha256), matrixSha256: matrix.matrixSha256 });
}

module.exports = { collectValidationMatrixIdentity, deriveValidationRulesSha256, collectPackagedWindowsValidationCandidate };
