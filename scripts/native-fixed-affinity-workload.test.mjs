import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";

import {
  fixedAffinityRecordFromBenchmark,
  parseBenchmarkRecords,
  runFixedAffinityWorkload,
} from "./native-fixed-affinity-workload.mjs";

function processPolicy() {
  const snapshot = (Id, PriorityClass) => ({ Id, PriorityClass, ProcessorAffinity: "0xFFFF" });
  return {
    requested: { affinity: "0XFFFF", nodePriority: "High", nativePriority: "Normal" },
    before: { node: snapshot(101, "High"), nativeHost: snapshot(202, "Normal") },
    after: { node: snapshot(101, "High"), nativeHost: snapshot(202, "Normal") },
  };
}

function benchmarkOutput(evidence = {}, hostBinarySha256 = "b".repeat(64)) {
  const fixtureSha256 = "a".repeat(64);
  const open = {
    nativeCore: {
      hostBinarySha256,
      exactRoundTrip: true,
    },
  };
  const exact = {
    nativeCoreExactRealSaveAdvance: {
      exactState: true,
      nativeAdvanceDurationMs: 12.5,
      fixedAffinityEvidence: {
        fixtureSha256,
        openCanonicalSha256: "c".repeat(64),
        preStepCanonicalSha256: "d".repeat(64),
        preStepDomainSha256: "e".repeat(64),
        measuredCanonicalSha256: "f".repeat(64),
        measuredDomainSha256: "1".repeat(64),
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
        ...evidence,
      },
    },
  };
  return {
    fixtureSha256,
    output: [
      `DSP_NATIVE_CORE_BENCHMARK\topen\t${JSON.stringify(open)}`,
      `DSP_NATIVE_CORE_BENCHMARK\texact\t${JSON.stringify(exact)}`,
    ].join("\n"),
  };
}

test("workload extracts the exact child fixture and fixed-affinity evidence", () => {
  const fixture = benchmarkOutput();
  const record = fixedAffinityRecordFromBenchmark(parseBenchmarkRecords(fixture.output), fixture.fixtureSha256);
  assert.equal(record.fixtureSha256, fixture.fixtureSha256);
  assert.equal(record.hostBinarySha256, "b".repeat(64));
  assert.equal(record.durationMs, 12.5);
  assert.equal(record.observedWorkerCount, 8);
});

test("workload passes the complete process policy to the real Vitest benchmark command", () => {
  const root = mkdtempSync(path.join(tmpdir(), "dsp-fixed-affinity-workload-"));
  try {
    const binary = path.join(root, "dsp-native-host.exe");
    const fixture = path.join(root, "fixed.json");
    const scratchRoot = path.join(root, "scratch");
    const binaryBytes = Buffer.from("native-host-snapshot", "utf8");
    const fixtureBytes = Buffer.from("immutable-fixture", "utf8");
    const fixtureSha256 = "a".repeat(64);
    const binarySha256 = createHash("sha256").update(binaryBytes).digest("hex");
    writeFileSync(binary, binaryBytes);
    writeFileSync(fixture, fixtureBytes);
    mkdirSync(scratchRoot);
    const calls = [];
    const result = runFixedAffinityWorkload({
      binary,
      fixture,
      fixtureSha256,
      threads: 8,
      affinity: "0000ffff",
      nodePriority: "High",
      nativePriority: "Normal",
      scratchRoot,
      timeoutMs: 60_000,
    }, {
      readFixture(receivedPath, expectedSha256) {
        assert.equal(receivedPath, fixture);
        if (expectedSha256 !== undefined) assert.equal(expectedSha256, fixtureSha256);
        return { path: fixture, sha256: fixtureSha256, sizeBytes: fixtureBytes.length, bytes: Buffer.from(fixtureBytes) };
      },
      spawnSync(executable, args, options) {
        calls.push({ executable, args, options });
        return { status: 0, stdout: benchmarkOutput({}, binarySha256).output, stderr: "" };
      },
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].executable, process.execPath);
    assert.ok(calls[0].args.some((argument) => argument.endsWith("nativeCoreRealSaveBenchmark.test.ts")));
    assert.ok(calls[0].args.includes("--no-cache"));
    assert.equal(calls[0].options.env.DSP_NATIVE_CORE_BENCHMARK_AFFINITY, "0XFFFF");
    assert.equal(calls[0].options.env.DSP_NATIVE_CORE_BENCHMARK_NODE_PRIORITY, "High");
    assert.equal(calls[0].options.env.DSP_NATIVE_CORE_BENCHMARK_NATIVE_PRIORITY, "Normal");
    assert.equal(calls[0].options.env.DSP_NATIVE_CORE_BENCHMARK_SCRATCH_ROOT, scratchRoot);
    assert.equal(calls[0].options.env.DSP_NATIVE_CORE_THREADS, "8");
    assert.equal(result.binarySha256, binarySha256);
    assert.deepEqual(result.processPolicy.before, processPolicy().before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("workload refuses to launch when Native Host priority is absent", () => {
  assert.throws(() => runFixedAffinityWorkload({
    binary: "unused",
    fixture: "unused",
    fixtureSha256: "a".repeat(64),
    threads: 8,
    affinity: "FFFF",
    nodePriority: "High",
    nativePriority: undefined,
  }), /Native Host priority is unsupported/);
});

test("workload rejects duplicate records, semantic failure, and wrong child fixture", () => {
  const fixture = benchmarkOutput();
  assert.throws(
    () => parseBenchmarkRecords(`${fixture.output}\n${fixture.output.split("\n")[0]}`),
    /duplicate native benchmark record/,
  );
  assert.throws(
    () => fixedAffinityRecordFromBenchmark(parseBenchmarkRecords(fixture.output), "0".repeat(64)),
    /workload fixture SHA-256 mismatch/,
  );
  const failed = fixture.output.replace('"exactState":true', '"exactState":false');
  assert.throws(
    () => fixedAffinityRecordFromBenchmark(parseBenchmarkRecords(failed), fixture.fixtureSha256),
    /semantic proof failed/,
  );
  const missingDuration = fixture.output.replace('"nativeAdvanceDurationMs":12.5', '"nativeAdvanceDurationMs":null');
  assert.throws(
    () => fixedAffinityRecordFromBenchmark(parseBenchmarkRecords(missingDuration), fixture.fixtureSha256),
    /positive measured duration/,
  );
  const missingPolicy = fixture.output.replace(`,"processPolicy":${JSON.stringify(processPolicy())}`, "");
  assert.throws(
    () => fixedAffinityRecordFromBenchmark(parseBenchmarkRecords(missingPolicy), fixture.fixtureSha256),
    /process-policy evidence/,
  );
});
