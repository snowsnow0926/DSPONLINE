"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createHash } = require("node:crypto");
const fixture = require("../native/fixtures/qualification-binding-v1.json");
const real = require("./native-qualification-binding.cjs");

// TEST_ONLY token issuer in the VM. Actual signed-token integration runs in
// the existing disposable Windows certificate lifecycle, never locally.
function harness() {
  const members = new WeakMap();
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "native-qualification-binding.cjs"), "utf8"), {
    module, Buffer, structuredClone,
    require(name) {
      assert.equal(name, "./native-catalog-verifier.cjs");
      return { readAuthenticatedCatalogMember(token) {
        const member = members.get(token);
        if (!member) throw Object.assign(new Error("unauthenticated-catalog-member"), { code: "unauthenticated-catalog-member" });
        return { ...member, memberBytes: Buffer.from(member.memberBytes) };
      } };
    },
  });
  function token(bytes = Buffer.from(fixture.body)) {
    const token = Object.freeze({});
    members.set(token, { memberBytes: bytes, memberSha256: createHash("sha256").update(bytes).digest("hex"),
      catalogSha256: "e".repeat(64), publisherCertificateSha256: fixture.context.publisherCertificateSha256 });
    return token;
  }
  return { ...module.exports, token };
}

for (const vector of fixture.cases) {
  test(`shared validation-body vector: ${vector.name}`, () => {
    const h = harness();
    const context = structuredClone(fixture.context);
    for (const { path: keys, value } of vector.contextPatch) {
      let target = context;
      for (const key of keys.slice(0, -1)) target = target[key];
      target[keys.at(-1)] = value;
    }
    const run = () => h.bindAuthenticatedValidationQualification(h.token(Buffer.from(vector.body)), context);
    if (vector.expected !== "PASS") assert.throws(run, (error) => error.code === vector.expected);
    else {
      const receipt = h.readBoundValidationQualification(run());
      assert.equal(receipt.authorityEligible, false);
      assert.equal(receipt.producerAuthenticated, false);
      assert.equal(receipt.releaseAllowed, false);
      assert.deepEqual(receipt.qualification.candidate, fixture.context.candidate);
      assert.equal(receipt.checkedAtMs, context.nowMs);
    }
  });
}

test("actual module rejects fabricated catalog and binding receipts", () => {
  for (const token of [{}, null, { memberBytes: Buffer.from(fixture.body), authorityEligible: true }]) {
    assert.throws(() => real.bindAuthenticatedValidationQualification(token, fixture.context), /unauthenticated-catalog-member/);
    assert.throws(() => real.readBoundValidationQualification(token), /unbound-validation-qualification/);
  }
});

test("binding snapshot is isolated from caller changes, readable receipts and token copies", () => {
  const h = harness();
  const context = structuredClone(fixture.context);
  const bytes = Buffer.from(fixture.body);
  const token = h.bindAuthenticatedValidationQualification(h.token(bytes), context);
  const receipt = h.readBoundValidationQualification(token);
  bytes.fill(0);
  context.candidate.hostSha256 = "0".repeat(64);
  context.session.profileId = "0".repeat(32);
  receipt.qualification.session.cloudWrites = true;
  receipt.authorityEligible = true;
  const next = h.readBoundValidationQualification(token);
  assert.deepEqual(next.qualification.session, fixture.context.session);
  assert.deepEqual(next.qualification.candidate, fixture.context.candidate);
  assert.equal(next.authorityEligible, false);
  assert.equal(next.carrierCatalogSha256, "e".repeat(64));
  assert.notEqual(next.carrierCatalogSha256, next.qualification.candidate.catalogSha256);
  for (const forged of [receipt, structuredClone(token), JSON.parse(JSON.stringify(token))]) {
    assert.throws(() => h.readBoundValidationQualification(forged), /unbound-validation-qualification/);
  }
});

test("invalid UTF-8 is rejected without replacement decoding accepting an identity", () => {
  const h = harness();
  const bytes = Buffer.from(fixture.body.replace("public-synthetic-validation-1", "x"));
  bytes[bytes.indexOf('"qualificationId":"x"') + '"qualificationId":"'.length] = 0xff;
  assert.throws(() => h.bindAuthenticatedValidationQualification(h.token(bytes), fixture.context), /qualification-format/);
});
