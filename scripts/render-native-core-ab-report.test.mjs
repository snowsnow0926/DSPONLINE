import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(root, "scripts", "render-native-core-ab-report.mjs");

function run(args) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  });
}

function fixtureReport() {
  const metric = { samples: [10, 12], median: 11, p95NearestRank: 12, minimum: 10, maximum: 12 };
  const candidateMetric = { samples: [5, 6], median: 5.5, p95NearestRank: 6, minimum: 5, maximum: 6 };
  return {
    schemaVersion: 1,
    generatedAt: "2026-08-27T00:00:00.000Z",
    benchmark: "native-core-real-save-interleaved-ab",
    command: { runsPerBinary: 2, threads: "8", order: ["baseline", "candidate", "candidate", "baseline"] },
    host: { platform: "win32", arch: "x64", node: "v24", cpuCount: 8, cpuModel: "fixture-cpu", totalMemoryBytes: 16 * 1024 ** 3 },
    binaries: {
      baseline: { sha256: "a".repeat(64), sizeBytes: 100 },
      candidate: { sha256: "b".repeat(64), sizeBytes: 110 },
    },
    fixture: {
      unchanged: true,
      before: { sha256: "c".repeat(64), sizeBytes: 1_234, mtimeMs: 1 },
      after: { sha256: "c".repeat(64), sizeBytes: 1_234, mtimeMs: 1 },
    },
    validation: {
      allProcessesExitedZero: true,
      allOpenRoundTripsExact: true,
      allNativeAdvancesMatchJavascript: true,
      allIntegratedProofsExact: true,
      allDurableAuthorityCommitsExactAndIdempotent: true,
      allIncrementalCheckpointsExact: true,
      allBackToBackNativeBurstsExact: true,
      allWindowsPrivatePeakSamplesValid: true,
    },
    summary: {
      baseline: { openDurationMs: metric },
      candidate: { openDurationMs: candidateMetric },
    },
    comparison: {
      openDurationMs: { baselineMedian: 11, candidateMedian: 5.5, baselineOverCandidate: 2, candidateReductionPercent: 50 },
    },
    samples: [],
  };
}

test("A/B report renderer refuses unverified input and renders verified identities atomically", () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dsp-native-ab-render-"));
  try {
    const input = path.join(temporaryRoot, "input.json");
    const output = path.join(temporaryRoot, "report.md");
    fs.writeFileSync(input, JSON.stringify(fixtureReport()));
    const rendered = run(["--input", input, "--output", output]);
    assert.equal(rendered.status, 0, rendered.stderr);
    const markdown = fs.readFileSync(output, "utf8");
    assert.match(markdown, /Windows 原生核心新旧版 A\/B 实测报告/);
    assert.match(markdown, new RegExp("a{64}"));
    assert.match(markdown, /\| 原生核心打开 \| 11\.00 ms \| 12\.00 ms \| 5\.50 ms \| 6\.00 ms \| 2\.000× \| \+50\.00% \|/);

    const overwrite = run(["--input", input, "--output", output]);
    assert.equal(overwrite.status, 1);
    assert.match(overwrite.stderr, /Output already exists/);

    const invalid = fixtureReport();
    invalid.fixture.unchanged = false;
    fs.writeFileSync(input, JSON.stringify(invalid));
    const rejected = run(["--input", input, "--output", path.join(temporaryRoot, "invalid.md")]);
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /fixture identity was not preserved/i);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
