"use strict";

// Authenticated validation-body binding only. No renderer API, producer
// authentication, trusted clock/revocation acquisition or runtime grant.
const { readAuthenticatedCatalogMember } = require("./native-catalog-verifier.cjs");
const bound = new WeakMap();
const SHA = /^[a-f0-9]{64}$/;
const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SCOPE = "windows-normal-main-1x-builtin-v1";
const MAX_BYTES = 16 * 1024;
const DAY_MS = 86_400_000;
const CANDIDATE_KEYS = ["version", "sourceSha", "buildId", "editionId", "channel", "platform", "arch",
  "hostSha256", "asarSha256", "catalogSha256", "rulesSha256", "matrixSha256"];
const SESSION_KEYS = ["profileId", "fixtureSha256", "cloudWrites"];
const BODY_KEYS = ["schemaVersion", "kind", "qualificationId", "publisherKeyVersion", "candidate",
  "scope", "session", "producerSetSha256", "proofSetSha256", "issuedAtMs", "expiresAtMs", "revocationGeneration"];
const CONTEXT_KEYS = ["candidate", "session", "scope", "publisherCertificateSha256", "publisherKeyVersion",
  "nowMs", "revocationGeneration", "revokedQualificationIds", "revokedProofSetSha256"];
const fail = (code) => { throw Object.assign(new Error(code), { code }); };
const integer = (v) => Number.isSafeInteger(v) && v > 0;
// JavaScript's $ also matches before a trailing LF. Require the complete
// string so ASCII identity rules agree with Rust's byte/length validation.
const matches = (v, expression) => typeof v === "string" && expression.exec(v)?.[0] === v;
const keys = (v, expected) => v !== null && typeof v === "object" && !Array.isArray(v)
  && Reflect.ownKeys(v).length === expected.length && expected.every((k) => Object.hasOwn(v, k));
const ordered = (v, fields) => Object.fromEntries(fields.map((k) => [k, v[k]]));
const equal = (a, b, fields) => fields.every((k) => a[k] === b[k]);
const validSession = (v) => keys(v, SESSION_KEYS) && matches(v.profileId, /^[a-f0-9]{32}$/)
  && matches(v.fixtureSha256, SHA) && v.cloudWrites === false;
const validCandidate = (v) => keys(v, CANDIDATE_KEYS)
  && matches(v.version, /^[0-9]{1,5}\.[0-9]{1,5}\.[0-9]{1,5}$/) && matches(v.sourceSha, /^[a-f0-9]{40}$/)
  && v.buildId === `${v.version}+${v.sourceSha.slice(0, 12)}`
  && v.editionId === "windows-performance-development-v1" && v.channel === "beta"
  && v.platform === "win32" && v.arch === "x64"
  && CANDIDATE_KEYS.filter((k) => k.endsWith("Sha256")).every((k) => matches(v[k], SHA));
const validList = (v, pattern) => Array.isArray(v) && v.length <= 128
  && v.every((entry) => matches(entry, pattern)) && new Set(v).size === v.length;

function bindAuthenticatedValidationQualification(token, context) {
  // Read the opaque credential before inspecting any caller-supplied fields.
  const member = readAuthenticatedCatalogMember(token);
  if (!keys(context, CONTEXT_KEYS) || !validCandidate(context.candidate) || !validSession(context.session)
      || context.scope !== SCOPE || !matches(context.publisherCertificateSha256, SHA)
      || !integer(context.publisherKeyVersion) || context.publisherKeyVersion > 0xffffffff
      || !integer(context.nowMs) || !integer(context.revocationGeneration)
      || !validList(context.revokedQualificationIds, ID) || !validList(context.revokedProofSetSha256, SHA)) {
    fail("qualification-context");
  }
  const bytes = member.memberBytes;
  if (bytes.length < 1 || bytes.length > MAX_BYTES) fail("qualification-format");
  let body;
  try { body = JSON.parse(bytes.toString("utf8")); } catch { fail("qualification-format"); }
  if (!keys(body, BODY_KEYS) || !keys(body.candidate, CANDIDATE_KEYS) || !keys(body.session, SESSION_KEYS)
      || !Number.isInteger(body.schemaVersion) || body.schemaVersion < 0 || body.schemaVersion > 0xffffffff
      || !Number.isInteger(body.publisherKeyVersion) || body.publisherKeyVersion < 0 || body.publisherKeyVersion > 0xffffffff
      || ["issuedAtMs", "expiresAtMs", "revocationGeneration"].some((k) =>
        !Number.isInteger(body[k]) || body[k] < 0)
      || typeof body.session.cloudWrites !== "boolean"
      || CANDIDATE_KEYS.some((k) => typeof body.candidate[k] !== "string")
      || ["kind", "qualificationId", "scope", "producerSetSha256", "proofSetSha256"].some((k) => typeof body[k] !== "string")
      || ["profileId", "fixtureSha256"].some((k) => typeof body.session[k] !== "string")) fail("qualification-format");
  const canonical = ordered(body, BODY_KEYS);
  canonical.candidate = ordered(body.candidate, CANDIDATE_KEYS);
  canonical.session = ordered(body.session, SESSION_KEYS);
  // Fixed schema-order compact UTF-8 plus one LF, not arbitrary JSON or JCS.
  // Re-encoding rejects duplicate keys, lossy UTF-8 and alternative encodings.
  if (!Buffer.from(JSON.stringify(canonical) + "\n").equals(bytes)) fail("qualification-format");
  if (body.schemaVersion !== 1 || body.kind !== "dsp-windows-validation-qualification-v1" || body.scope !== SCOPE) {
    fail("qualification-contract");
  }
  if (!matches(body.qualificationId, ID) || !matches(body.producerSetSha256, SHA)
      || !matches(body.proofSetSha256, SHA)) fail("qualification-identity");
  if (member.publisherCertificateSha256 !== context.publisherCertificateSha256
      || body.publisherKeyVersion !== context.publisherKeyVersion) fail("qualification-publisher");
  if (!validCandidate(body.candidate) || !equal(body.candidate, context.candidate, CANDIDATE_KEYS)) fail("qualification-candidate");
  if (!validSession(body.session) || !equal(body.session, context.session, SESSION_KEYS)) fail("qualification-session");
  if (!integer(body.issuedAtMs) || !integer(body.expiresAtMs) || body.issuedAtMs > context.nowMs
      || body.expiresAtMs <= context.nowMs || body.expiresAtMs <= body.issuedAtMs
      || body.expiresAtMs - body.issuedAtMs > DAY_MS) fail("qualification-time");
  if (!integer(body.revocationGeneration) || body.revocationGeneration !== context.revocationGeneration
      || context.revokedQualificationIds.includes(body.qualificationId)
      || context.revokedProofSetSha256.includes(body.proofSetSha256)) fail("qualification-revoked");
  const result = Object.freeze(Object.create(null));
  bound.set(result, { qualification: canonical, memberSha256: member.memberSha256,
    carrierCatalogSha256: member.catalogSha256, publisherCertificateSha256: member.publisherCertificateSha256,
    checkedAtMs: context.nowMs, producerAuthenticated: false, authorityEligible: false, releaseAllowed: false });
  return result;
}

function readBoundValidationQualification(token) {
  const value = bound.get(token);
  if (!value) fail("unbound-validation-qualification");
  // The readable receipt cannot be submitted back as an authenticated token.
  return structuredClone(value);
}

module.exports = { bindAuthenticatedValidationQualification, readBoundValidationQualification };
