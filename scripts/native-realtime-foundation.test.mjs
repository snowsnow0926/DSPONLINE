import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { FOUNDATION_TESTS, parseFoundationTestResult, selectFoundationTestBinary } from "./native-realtime-foundation.mjs";

const NAME = FOUNDATION_TESTS[0];
const output = (name = NAME, summary = "1 passed; 0 failed; 0 ignored; 0 measured; 251 filtered out") =>
  `\nrunning 1 test\ntest ${name} ... ok\n\ntest result: ok. ${summary}; finished in 0.12s\n`;
const artifact = () => ({ reason: "compiler-artifact", target: { name: "dsp_native_host", kind: ["lib"] },
  executable: "native/target/release/deps/dsp_native_host-example.exe",
  profile: { test: true, opt_level: "3", debug_assertions: false } });
const cargoOutput = (...artifacts) => [...artifacts, { reason: "build-finished", success: true }].map(JSON.stringify).join("\n");

test("only one actual named Rust test and one successful accounting record are accepted", () => {
  for (const name of FOUNDATION_TESTS) {
    assert.deepEqual(parseFoundationTestResult(output(name), name, 0), { test: name, passed: 1, failed: 0, ignored: 0 });
    assert.deepEqual(parseFoundationTestResult(output(name).replaceAll("\n", "\r\n"), name, 0),
      { test: name, passed: 1, failed: 0, ignored: 0 });
  }
});

for (const [label, text, code] of [
  ["zero tests", "test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 252 filtered out; finished in 0.00s\n", "test-not-executed-exactly-once"],
  ["wrong named test", output(FOUNDATION_TESTS[1]), "test-not-executed-exactly-once"],
  ["duplicate execution", `test ${NAME} ... ok\n${output()}`, "test-not-executed-exactly-once"],
  ["ignored test", output().replace("... ok", "... ignored"), "test-not-executed-exactly-once"],
  ["no accounting", `test ${NAME} ... ok\n`, "test-summary-invalid"],
  ["ignored accounting", output(NAME, "1 passed; 0 failed; 1 ignored; 0 measured; 250 filtered out"), "test-summary-invalid"],
  ["failed accounting", output(NAME, "1 passed; 1 failed; 0 ignored; 0 measured; 250 filtered out"), "test-summary-invalid"],
  ["larger unreviewed selection", output(NAME, "2 passed; 0 failed; 0 ignored; 0 measured; 250 filtered out"), "test-summary-invalid"],
  ["duplicate accounting", output() + "test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 251 filtered out; finished in 0.01s\n", "test-summary-invalid"],
]) {
  test(`foundation evidence rejects ${label}`, () => assert.throws(() => parseFoundationTestResult(text, NAME, 0), { code }));
}

test("a test failure, killed process or unknown test name cannot look successful", () => {
  for (const exitCode of [1, 101, null, undefined]) {
    assert.throws(() => parseFoundationTestResult(output(), NAME, exitCode), { code: "test-process-failed" });
  }
  assert.throws(() => parseFoundationTestResult(output(), "renderer_mock::everything_passed", 0), { code: "unknown-test" });
});

test("Cargo identifies the actual optimized Host library test executable", () => {
  const selected = artifact();
  const dependency = { reason: "compiler-artifact", target: { name: "dsp_native_core", kind: ["lib"] }, executable: null };
  assert.deepEqual(selectFoundationTestBinary(cargoOutput(dependency, selected)),
    { executable: selected.executable, profile: selected.profile });
});

for (const [label, mutate] of [
  ["a normal production binary", (item) => { item.profile.test = false; }],
  ["debug optimization", (item) => { item.profile.opt_level = "0"; }],
  ["size optimization override", (item) => { item.profile.opt_level = "s"; }],
  ["enabled debug assertions", (item) => { item.profile.debug_assertions = true; }],
  ["missing profile", (item) => { delete item.profile; }],
]) {
  test(`Cargo evidence rejects ${label}`, () => {
    const selected = artifact();
    mutate(selected);
    assert.throws(() => selectFoundationTestBinary(cargoOutput(selected)), { code: "test-build-profile" });
  });
}

test("a successful Cargo exit without exactly one finished test artifact is insufficient", () => {
  assert.throws(() => selectFoundationTestBinary("{}\n"), { code: "cargo-build-not-finished" });
  assert.throws(() => selectFoundationTestBinary(cargoOutput()), { code: "test-binary-ambiguous" });
  assert.throws(() => selectFoundationTestBinary(cargoOutput(artifact(), artifact())), { code: "test-binary-ambiguous" });
  assert.throws(() => selectFoundationTestBinary(cargoOutput(artifact()).replace('"success":true', '"success":false')), { code: "cargo-build-not-finished" });
  assert.throws(() => selectFoundationTestBinary(`${cargoOutput(artifact())}\n${JSON.stringify({ reason: "build-finished", success: true })}`), { code: "cargo-build-not-finished" });
  const dispatcher = artifact();
  dispatcher.target = { name: "dsp-native-host", kind: ["bin"] };
  assert.throws(() => selectFoundationTestBinary(cargoOutput(dispatcher)), { code: "test-binary-ambiguous" });
  assert.throws(() => selectFoundationTestBinary("cargo compiler warning without JSON"), { code: "cargo-json-invalid" });
});

for (const [script, status, field, code] of [
  ["native-qualification-evidence.mjs", "REJECTED", "code", "usage-candidate-json-evidence-directory"],
  ["native-realtime-foundation.mjs", "FAIL", "failureCode", "usage-output-directory"],
]) {
  test(`${script} runs through a linked scripts directory and remains inert on import`, (t) => {
    const parent = path.resolve(os.tmpdir());
    const directory = fs.mkdtempSync(path.join(parent, "dsp-foundation-cli-"));
    t.after(() => {
      const resolved = path.resolve(directory);
      if (path.dirname(resolved) !== parent || !path.basename(resolved).startsWith("dsp-foundation-cli-")) {
        throw new Error("Test cleanup escaped its owned temporary directory");
      }
      fs.rmSync(resolved, { recursive: true, force: true });
    });
    const scripts = path.dirname(fileURLToPath(import.meta.url));
    const linked = path.join(directory, "linked-scripts");
    fs.symlinkSync(scripts, linked, process.platform === "win32" ? "junction" : "dir");
    const direct = spawnSync(process.execPath, [path.join(linked, script)], { encoding: "utf8", windowsHide: true });
    assert.equal(direct.error, undefined);
    assert.equal(direct.status, 1);
    assert.equal(direct.stdout, "");
    const failure = JSON.parse(direct.stderr);
    assert.equal(failure.status, status);
    assert.equal(failure[field], code);
    assert.equal(failure.authorityEligible, false);
    const importer = path.join(directory, "import-only.mjs");
    fs.writeFileSync(importer, `import ${JSON.stringify(new URL(script, import.meta.url).href)};\n`, { flag: "wx" });
    const imported = spawnSync(process.execPath, [importer], { encoding: "utf8", windowsHide: true });
    assert.equal(imported.error, undefined);
    assert.equal(imported.status, 0);
    assert.equal(imported.stdout, "");
    assert.equal(imported.stderr, "");
  });
}
