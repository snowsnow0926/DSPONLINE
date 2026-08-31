import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildFixedAffinityChildEnvironment,
  computeV47StateChecksum,
  evaluateFixedMeasured,
  evaluateFixedPreflight,
  generateAndPersistFixedV47Fixture,
  normalizeAffinity,
  readFixedV47Fixture,
  sha256Bytes,
} from "./native-fixed-v47-fixture.mjs";

function envelopeBytes(marker = "fixed-input", checksumOverride = null) {
  const state = { version: 47, mode: "normal", entities: [], belts: [], marker };
  return Buffer.from(JSON.stringify({
    formatVersion: 2,
    kind: "snapshot",
    savedAt: 1,
    mode: "normal",
    slot: "main",
    state,
    checksum: checksumOverride ?? computeV47StateChecksum(state),
  }), "utf8");
}

function processPolicy(overrides = {}) {
  const nodeBefore = { Id: 101, PriorityClass: "High", ProcessorAffinity: "0xFFFF" };
  const nativeBefore = { Id: 202, PriorityClass: "Normal", ProcessorAffinity: "0xFFFF" };
  return {
    requested: { affinity: "0XFFFF", nodePriority: "High", nativePriority: "Normal" },
    before: { node: nodeBefore, nativeHost: nativeBefore },
    after: { node: { ...nodeBefore }, nativeHost: { ...nativeBefore } },
    ...overrides,
  };
}

function preflight(overrides = {}) {
  return {
    fixtureSha256: "a".repeat(64),
    openCanonicalSha256: "b".repeat(64),
    preStepCanonicalSha256: "c".repeat(64),
    preStepDomainSha256: "d".repeat(64),
    measuredCanonicalSha256: "e".repeat(64),
    measuredDomainSha256: "f".repeat(64),
    nodePriority: "High",
    nodeAffinity: "0xFFFF",
    nativePriority: "Normal",
    nativeAffinity: "0xFFFF",
    requestedThreads: "8",
    profileEnabled: true,
    effectiveWorkerLimit: 8,
    observedWorkerCount: 8,
    writeBackWorkers: 4,
    processPolicy: processPolicy(),
    durationMs: 10,
    ...overrides,
  };
}

const evaluationOptions = {
  fixtureSha256: "a".repeat(64),
  affinity: "FFFF",
  threads: 8,
  nodePriority: "High",
  nativePriority: "Normal",
};

test("fixed-affinity children inherit only operating-system essentials plus managed evidence settings", () => {
  const environment = buildFixedAffinityChildEnvironment({
    Path: "C:\\Windows",
    TEMP: "C:\\Temp",
    NODE_OPTIONS: "--inspect",
    DSP_NATIVE_CORE_THREADS: "1",
    SECRET_EXAMPLE: "do-not-copy",
  }, {
    DSP_NATIVE_CORE_THREADS: "8",
    DSP_NATIVE_CORE_PROFILE: "1",
  }, "win32");
  assert.deepEqual(environment, {
    Path: "C:\\Windows",
    TEMP: "C:\\Temp",
    DSP_NATIVE_CORE_THREADS: "8",
    DSP_NATIVE_CORE_PROFILE: "1",
  });
});

test("persists one immutable callback snapshot and refuses checksum errors or overwrite", () => {
  const root = mkdtempSync(path.join(tmpdir(), "dsp-fixed-v47-contract-"));
  try {
    const fixturePath = path.join(root, "fixed.v47.json");
    const source = envelopeBytes();
    let generationCalls = 0;
    const generated = generateAndPersistFixedV47Fixture({
      outputPath: fixturePath,
      generate: () => {
        generationCalls += 1;
        return source;
      },
    });
    assert.equal(generationCalls, 1);
    assert.equal(generated.generatorCallbackCalls, 1);
    assert.equal(generated.envelopeFormatVersion, 2);
    assert.equal(generated.stateVersion, 47);
    assert.equal(generated.sha256, sha256Bytes(source));
    source.fill(0);
    assert.equal(readFixedV47Fixture(fixturePath, generated.sha256).sha256, generated.sha256);
    assert.notDeepEqual(readFileSync(fixturePath), source);

    assert.throws(
      () => generateAndPersistFixedV47Fixture({ outputPath: fixturePath, generate: envelopeBytes }),
      /already exists/,
    );
    assert.throws(
      () => generateAndPersistFixedV47Fixture({ outputPath: fixturePath, generate: envelopeBytes, overwrite: true }),
      /never overwrites/,
    );
    assert.throws(
      () => generateAndPersistFixedV47Fixture({
        outputPath: path.join(root, "bad-checksum.json"),
        generate: () => envelopeBytes("bad", "01234567"),
      }),
      /state checksum mismatch/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("preflight requires strict digests, explicit priorities, affinity, and identical worker evidence", () => {
  assert.throws(() => normalizeAffinity("0x0000"), /select at least one processor/);
  assert.throws(() => normalizeAffinity("1".repeat(17)), /1-to-16-digit/);
  const accepted = evaluateFixedPreflight({ records: [preflight(), preflight()], ...evaluationOptions });
  assert.equal(accepted.status, "RESULT");
  assert.deepEqual(accepted.reasonCodes, []);
  assert.equal(accepted.expected.nodeAffinity, "0XFFFF");
  assert.equal(accepted.expected.writeBackWorkers, 4);

  const cases = [
    ["fixture-sha-mismatch", { fixtureSha256: "f".repeat(64) }],
    ["open-canonical-hash-mismatch", { openCanonicalSha256: "e".repeat(64) }],
    ["pre-step-canonical-hash-mismatch", { preStepCanonicalSha256: "e".repeat(64) }],
    ["pre-step-domain-hash-mismatch", { preStepDomainSha256: "e".repeat(64) }],
    ["measured-canonical-hash-mismatch", { measuredCanonicalSha256: "1".repeat(64) }],
    ["measured-domain-hash-mismatch", { measuredDomainSha256: "1".repeat(64) }],
    ["process-affinity-mismatch", { nativeAffinity: "00FF" }],
    ["process-affinity-mismatch", { nativeAffinity: "0000" }],
    ["process-priority-mismatch", { nativePriority: "BelowNormal" }],
    ["process-priority-mismatch", { nodePriority: "Normal" }],
    ["process-policy-evidence-mismatch", { processPolicy: null }],
    ["process-identity-mismatch", { processPolicy: processPolicy({
      after: {
        node: { Id: 102, PriorityClass: "High", ProcessorAffinity: "0xFFFF" },
        nativeHost: { Id: 202, PriorityClass: "Normal", ProcessorAffinity: "0xFFFF" },
      },
    }) }],
    ["process-affinity-mismatch", { processPolicy: processPolicy({
      after: {
        node: { Id: 101, PriorityClass: "High", ProcessorAffinity: "0xFF" },
        nativeHost: { Id: 202, PriorityClass: "Normal", ProcessorAffinity: "0xFFFF" },
      },
    }) }],
    ["process-priority-mismatch", { processPolicy: processPolicy({
      after: {
        node: { Id: 101, PriorityClass: "Normal", ProcessorAffinity: "0xFFFF" },
        nativeHost: { Id: 202, PriorityClass: "Normal", ProcessorAffinity: "0xFFFF" },
      },
    }) }],
    ["worker-metadata-mismatch", { requestedThreads: "4" }],
    ["worker-metadata-mismatch", { profileEnabled: false }],
    ["worker-metadata-mismatch", { effectiveWorkerLimit: 4 }],
    ["worker-metadata-mismatch", { observedWorkerCount: 4 }],
    ["worker-metadata-mismatch", { writeBackWorkers: 2 }],
  ];
  for (const [reason, drift] of cases) {
    const rejected = evaluateFixedPreflight({ records: [preflight(), preflight(drift)], ...evaluationOptions });
    assert.equal(rejected.status, "NO_RESULT", reason);
    assert.ok(rejected.reasonCodes.includes(reason), JSON.stringify(rejected));
    assert.equal(rejected.expected, null);
  }
});

test("preflight rejects empty, short, non-hex, uppercase digests and invalid thread configuration", () => {
  for (const invalid of ["", "a".repeat(63), "g".repeat(64), "A".repeat(64)]) {
    const fixtureRejected = evaluateFixedPreflight({
      records: [preflight(), preflight()],
      ...evaluationOptions,
      fixtureSha256: invalid,
    });
    assert.deepEqual(fixtureRejected.reasonCodes, ["preflight-configuration-invalid"]);
    const recordRejected = evaluateFixedPreflight({
      records: [preflight(), preflight({ openCanonicalSha256: invalid })],
      ...evaluationOptions,
    });
    assert.ok(recordRejected.reasonCodes.includes("open-canonical-hash-mismatch"));
  }
  for (const threads of [0, Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
    const rejected = evaluateFixedPreflight({ records: [preflight(), preflight()], ...evaluationOptions, threads });
    assert.deepEqual(rejected.reasonCodes, ["preflight-configuration-invalid"]);
  }
  assert.deepEqual(evaluateFixedPreflight({
    records: [preflight(), preflight()],
    ...evaluationOptions,
    nativePriority: "",
  }).reasonCodes, ["preflight-configuration-invalid"]);
});

test("measured records must retain every preflight condition and deterministic result hash", () => {
  const preflightResult = evaluateFixedPreflight({ records: [preflight(), preflight()], ...evaluationOptions });
  assert.equal(preflightResult.status, "RESULT");
  const records = Array.from({ length: 6 }, () => preflight());
  const accepted = evaluateFixedMeasured({
    records,
    expectedCount: 6,
    preflightExpected: preflightResult.expected,
    ...evaluationOptions,
  });
  assert.equal(accepted.status, "RESULT");

  for (const [reason, drift] of [
    ["open-canonical-hash-mismatch", { openCanonicalSha256: "1".repeat(64) }],
    ["pre-step-domain-hash-mismatch", { preStepDomainSha256: "1".repeat(64) }],
    ["measured-canonical-hash-mismatch", { measuredCanonicalSha256: "1".repeat(64) }],
    ["measured-domain-hash-mismatch", { measuredDomainSha256: "1".repeat(64) }],
    ["process-priority-mismatch", { nativePriority: "High" }],
    ["process-affinity-mismatch", { nodeAffinity: "FF" }],
    ["worker-metadata-mismatch", { profileEnabled: false }],
    ["worker-metadata-mismatch", { effectiveWorkerLimit: 4 }],
    ["worker-metadata-mismatch", { observedWorkerCount: 4 }],
    ["worker-metadata-mismatch", { writeBackWorkers: 3 }],
    ["measured-duration-invalid", { durationMs: Number.NaN }],
  ]) {
    const rejected = evaluateFixedMeasured({
      records: [...records.slice(0, -1), preflight(drift)],
      expectedCount: 6,
      preflightExpected: preflightResult.expected,
      ...evaluationOptions,
    });
    assert.ok(rejected.reasonCodes.includes(reason), `${reason}: ${JSON.stringify(rejected)}`);
  }
});
