import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(root, "scripts", "benchmark-native-core-ab.mjs");

function run(args) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  });
}

test("A/B benchmark CLI documents its required immutable identities", () => {
  const result = run(["--help"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /--baseline <absolute-host-path>/);
  assert.match(result.stderr, /--fixture <absolute-save-path>/);
  assert.match(result.stderr, /Interleaved samples per binary/);
  assert.match(result.stderr, /--baseline-sync-record-drop/);
  assert.match(result.stderr, /--candidate-sync-record-drop/);
});

test("A/B benchmark CLI rejects missing and relative identity paths before running", () => {
  const missing = run([]);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /Missing required --baseline/);

  const relative = run([
    "--baseline", "old.exe",
    "--candidate", "new.exe",
    "--fixture", "save.json",
    "--output", "report.json",
  ]);
  assert.equal(relative.status, 2);
  assert.match(relative.stderr, /--baseline must be an absolute path/);
});

test("A/B benchmark CLI rejects invalid run and timeout bounds", () => {
  const base = process.platform === "win32" ? "C:\\old.exe" : "/old";
  const candidate = process.platform === "win32" ? "C:\\new.exe" : "/new";
  const fixture = process.platform === "win32" ? "C:\\save.json" : "/save.json";
  const output = process.platform === "win32" ? "C:\\report.json" : "/report.json";
  const runs = run([
    "--baseline", base, "--candidate", candidate, "--fixture", fixture, "--output", output,
    "--runs", "0",
  ]);
  assert.equal(runs.status, 2);
  assert.match(runs.stderr, /--runs must be an integer/);

  const timeout = run([
    "--baseline", base, "--candidate", candidate, "--fixture", fixture, "--output", output,
    "--timeout-ms", "999",
  ]);
  assert.equal(timeout.status, 2);
  assert.match(timeout.stderr, /--timeout-ms must be an integer/);

  const threads = run([
    "--baseline", base, "--candidate", candidate, "--fixture", fixture, "--output", output,
    "--threads", "3",
  ]);
  assert.equal(threads.status, 2);
  assert.match(threads.stderr, /--threads must be one of: auto, 1, 2, 4, 8/);

  const scenario = run([
    "--baseline", base, "--candidate", candidate, "--fixture", fixture, "--output", output,
    "--scenario", "partial",
  ]);
  assert.equal(scenario.status, 2);
  assert.match(scenario.stderr, /--scenario must be one of: open, exact, full/);
});

test("A/B benchmark refuses an existing evidence path before starting expensive runs", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dsp-native-ab-cli-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const baseline = path.join(directory, "baseline.bin");
  const candidate = path.join(directory, "candidate.bin");
  const fixture = path.join(directory, "fixture.json");
  const output = path.join(directory, "report.json");
  fs.writeFileSync(baseline, "baseline");
  fs.writeFileSync(candidate, "candidate");
  fs.writeFileSync(fixture, "{}");
  fs.writeFileSync(output, "keep-existing-evidence");
  const result = run([
    "--baseline", baseline,
    "--candidate", candidate,
    "--fixture", fixture,
    "--output", output,
    "--runs", "1",
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Output already exists/);
  assert.equal(fs.readFileSync(output, "utf8"), "keep-existing-evidence");
});
