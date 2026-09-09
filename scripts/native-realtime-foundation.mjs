import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { digestFile, requireDirect } = require("../desktop/desktop-artifact-evidence.cjs");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PREFIX = "core_runtime::tests::";
export const FOUNDATION_TESTS = Object.freeze([
  "player_authority_tick_derives_the_full_durable_chain_and_is_idempotent",
  "player_authority_commands_are_idempotent_and_share_order_with_ticks",
  "player_authority_pause_resume_is_durable_idempotent_and_clock_stopping",
  "player_authority_pause_resume_recovers_after_every_durable_boundary",
  "acknowledged_player_authority_session_resumes_after_clean_or_lost_hello_restart",
  "startup_resume_revalidates_current_domain_coverage_before_rebinding",
  "player_authority_command_checkpoint_failure_keeps_pending_wal_recoverable",
].map((name) => `${PREFIX}${name}`));
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

function fail(code) { throw Object.assign(new Error(`Native foundation evidence rejected: ${code}`), { code }); }
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function parseFoundationTestResult(stdout, expectedTest, exitCode) {
  if (!FOUNDATION_TESTS.includes(expectedTest)) fail("unknown-test");
  if (exitCode !== 0) fail("test-process-failed");
  const lines = stdout.split(/\r?\n/);
  const expectedLine = `test ${expectedTest} ... ok`;
  const testLines = lines.filter((line) => line.startsWith("test ") && !line.startsWith("test result:"));
  if (testLines.length !== 1 || testLines[0] !== expectedLine) fail("test-not-executed-exactly-once");
  const summaries = lines.filter((line) => line.startsWith("test result:"));
  if (summaries.length !== 1 ||
      !/^test result: ok\. 1 passed; 0 failed; 0 ignored; 0 measured; \d+ filtered out; finished in \d+(?:\.\d+)?s$/.test(summaries[0])) {
    fail("test-summary-invalid");
  }
  return { test: expectedTest, passed: 1, failed: 0, ignored: 0 };
}

export function selectFoundationTestBinary(cargoOutput) {
  let messages;
  try { messages = cargoOutput.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)); }
  catch { fail("cargo-json-invalid"); }
  const finished = messages.filter((message) => message.reason === "build-finished");
  if (finished.length !== 1 || finished[0].success !== true) fail("cargo-build-not-finished");
  const artifacts = messages.filter((message) => message.reason === "compiler-artifact" &&
    message.target?.name === "dsp_native_host" && message.target?.kind?.includes("lib") && message.executable);
  if (artifacts.length !== 1) fail("test-binary-ambiguous");
  const artifact = artifacts[0];
  if (typeof artifact.executable !== "string" || artifact.profile?.test !== true ||
      artifact.profile?.opt_level !== "3" || artifact.profile?.debug_assertions !== false) fail("test-build-profile");
  return { executable: artifact.executable, profile: artifact.profile };
}

function git(args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", windowsHide: true });
}

function snapshotSources() {
  const inputs = ["native", "scripts/native-realtime-foundation.mjs", "desktop/desktop-artifact-evidence.cjs",
    ".cargo", "rust-toolchain.toml", "rust-toolchain"];
  const tracked = git(["ls-files", "-z", "--", ...inputs]).split("\0").filter(Boolean);
  const untracked = git(["ls-files", "--others", "--exclude-standard", "-z", "--", ...inputs]).split("\0").filter(Boolean);
  const files = [...new Set([...tracked, ...untracked])].sort().map((relative) => {
    const file = requireDirect(ROOT, relative);
    return { path: relative, size: fs.statSync(file).size, sha256: digestFile(file) };
  });
  if (!files.some((file) => file.path === "native/dsp-native-host/src/core_runtime.rs")) fail("native-source-missing");
  return { baseSourceSha: git(["rev-parse", "HEAD"]).trim(),
    dirty: Boolean(git(["status", "--porcelain", "--untracked-files=normal", "--", ...inputs]).trim()),
    inputSha256: sha256(JSON.stringify(files)), files };
}

async function runOwned(executable, args, env, directory, label) {
  const stdoutPath = path.join(directory, `${label}.stdout.log`);
  const stderrPath = path.join(directory, `${label}.stderr.log`);
  const startedAtMs = Date.now();
  const began = performance.now();
  const child = spawn(executable, args, { cwd: ROOT, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  if (child.pid) {
    try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); }
    catch (error) { if (error.code !== "ESRCH") throw error; }
  }
  const buffers = { stdout: [], stderr: [] };
  let bytes = 0;
  let overflow = false;
  for (const key of ["stdout", "stderr"]) child[key].on("data", (chunk) => {
    bytes += chunk.length;
    if (bytes > MAX_OUTPUT_BYTES) overflow = true;
    if (!overflow) buffers[key].push(chunk);
  });
  // The caller's CI deadline or local process-tree/memory guard owns stopping
  // the entire build tree. Reaching the output bound never grows these buffers.
  const outcome = await new Promise((resolve) => {
    child.once("error", () => resolve({ code: null, signal: null, spawnFailed: true }));
    child.once("close", (code, signal) => resolve({ code, signal, spawnFailed: false }));
  });
  const stdout = Buffer.concat(buffers.stdout);
  const stderr = Buffer.concat(buffers.stderr);
  fs.writeFileSync(stdoutPath, stdout, { flag: "wx" });
  fs.writeFileSync(stderrPath, stderr, { flag: "wx" });
  const receipt = { ...outcome, startedAtMs, finishedAtMs: Date.now(), durationMs: performance.now() - began,
    stdout: { path: path.basename(stdoutPath), size: stdout.length, sha256: sha256(stdout) },
    stderr: { path: path.basename(stderrPath), size: stderr.length, sha256: sha256(stderr) }, overflow };
  return { receipt, stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8") };
}

function freshOutputDirectory(directory) {
  const relative = path.relative(ROOT, path.resolve(directory)).split(path.sep).join("/");
  if (!relative.startsWith("artifacts/") || relative.split("/").some((part) => !part || part === "." || part === "..")) fail("output-path");
  let current = ROOT;
  for (const part of relative.split("/")) {
    current = path.join(current, part);
    if (fs.existsSync(current)) {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) fail("output-path");
      if (current === path.resolve(directory)) fail("output-already-exists");
    } else fs.mkdirSync(current);
  }
  return current;
}

export async function collectNativeRealtimeFoundation(directory) {
  if (process.platform !== "win32") fail("windows-runner-required");
  os.setPriority(0, os.constants.priority.PRIORITY_BELOW_NORMAL);
  const output = freshOutputDirectory(directory);
  const report = { schemaVersion: 1, kind: "native-realtime-foundation-v1", evidenceClass: "TEST_ONLY",
    status: "RUNNING", platform: process.platform, arch: process.arch, nodeVersion: process.version,
    qualificationScope: null, packagedHostSha256: null, asarSha256: null,
    authorityEligible: false, releaseAllowed: false, checks: [] };
  try {
    report.sources = snapshotSources();
    const env = { ...process.env, CARGO_BUILD_JOBS: "1" };
    for (const key of Object.keys(env)) if (["RUSTFLAGS", "CARGO_ENCODED_RUSTFLAGS", "CARGO_TARGET_DIR",
      "RUSTC", "RUSTC_WRAPPER", "RUSTC_WORKSPACE_WRAPPER"].includes(key) || key.startsWith("CARGO_PROFILE_RELEASE_")) delete env[key];
    const compiler = await runOwned("rustc", ["--version", "--verbose"], env, output, "compiler");
    if (compiler.receipt.code !== 0 || compiler.receipt.overflow) fail("compiler-query-failed");
    report.compiler = compiler.receipt;
    const build = await runOwned("cargo", ["test", "--manifest-path", "native/Cargo.toml", "--locked",
      "--release", "-p", "dsp-native-host", "--lib", "--no-run", "--message-format=json"], env, output, "build");
    report.build = build.receipt;
    if (build.receipt.code !== 0 || build.receipt.overflow) fail("build-failed");
    const artifact = selectFoundationTestBinary(build.stdout);
    const relative = path.relative(ROOT, path.resolve(artifact.executable)).split(path.sep).join("/");
    if (!relative.startsWith("native/target/release/deps/") || !path.basename(relative).startsWith("dsp_native_host-")) fail("test-binary-path");
    const binary = requireDirect(ROOT, relative);
    report.testBinary = { path: relative, sha256: digestFile(binary), size: fs.statSync(binary).size, profile: artifact.profile };
    for (const [index, name] of FOUNDATION_TESTS.entries()) {
      const result = await runOwned(binary, [name, "--exact", "--test-threads=1", "--color", "never"], env, output, `check-${index + 1}`);
      const check = { test: name, execution: "rust-host-library-test", recoveryIsolation: "registry-reopen-in-test-process", ...result.receipt };
      report.checks.push(check);
      if (result.receipt.overflow) fail("test-output-overflow");
      check.result = parseFoundationTestResult(result.stdout, name, result.receipt.code);
    }
    const after = snapshotSources();
    if (after.baseSourceSha !== report.sources.baseSourceSha || after.inputSha256 !== report.sources.inputSha256 ||
        after.dirty !== report.sources.dirty || digestFile(binary) !== report.testBinary.sha256) fail("inputs-changed-during-run");
    report.status = "PASS";
  } catch (error) {
    report.status = "FAIL";
    report.failureCode = error.code ?? "foundation-operation-failed";
  }
  report.finishedAtMs = Date.now();
  fs.writeFileSync(path.join(output, "foundation-report.json"), `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  return report;
}

function isDirectInvocation() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectInvocation()) {
  try {
    if (process.argv.length !== 3) fail("usage-output-directory");
    const report = await collectNativeRealtimeFoundation(process.argv[2]);
    console.log(JSON.stringify({ status: report.status, evidenceClass: report.evidenceClass,
      executedChecks: report.checks.length, failureCode: report.failureCode, authorityEligible: false, releaseAllowed: false }));
    if (report.status !== "PASS") process.exitCode = 1;
  } catch (error) {
    console.error(JSON.stringify({ status: "FAIL", failureCode: error.code ?? "foundation-start-failed", authorityEligible: false }));
    process.exitCode = 1;
  }
}
