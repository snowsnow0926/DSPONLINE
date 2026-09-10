import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { selectFoundationTestBinary } from "./native-realtime-foundation.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const directory = path.resolve(process.argv[2] ?? "");
const relative = path.relative(root, directory).split(path.sep).join("/");
if (!relative.startsWith("artifacts/") || relative.split("/").some(part => !part || part === "." || part === "..")) {
  throw new Error("RPC evidence requires a fresh directory below artifacts/");
}
let current = root;
for (const part of relative.split("/")) {
  current = path.join(current, part);
  if (fs.existsSync(current)) {
    if (!fs.lstatSync(current).isDirectory() || fs.lstatSync(current).isSymbolicLink() || current === directory) {
      throw new Error("RPC evidence directory is not fresh and direct");
    }
  } else fs.mkdirSync(current);
}
os.setPriority(0, os.constants.priority.PRIORITY_BELOW_NORMAL);
const env = { ...process.env, CARGO_BUILD_JOBS: "1" };
for (const key of Object.keys(env)) if (key.startsWith("CARGO_PROFILE_RELEASE_") ||
  ["RUSTFLAGS", "CARGO_ENCODED_RUSTFLAGS", "CARGO_TARGET_DIR", "RUSTC", "RUSTC_WRAPPER", "RUSTC_WORKSPACE_WRAPPER", "NODE_OPTIONS"].includes(key)) delete env[key];

async function run(label, executable, args, environment = env) {
  const child = spawn(executable, args, { cwd: root, env: environment, windowsHide: true, shell: false,
    stdio: ["ignore", "pipe", "pipe"] });
  if (child.pid) os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
  const chunks = { stdout: [], stderr: [] };
  let bytes = 0, overflow = false;
  for (const channel of ["stdout", "stderr"]) child[channel].on("data", chunk => {
    bytes += chunk.length;
    if (bytes > 16 * 1024 * 1024) { overflow = true; return; }
    chunks[channel].push(chunk);
  });
  const outcome = await new Promise(resolve => {
    child.once("error", error => resolve({ error: error.message, code: null }));
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  for (const channel of ["stdout", "stderr"]) fs.writeFileSync(path.join(directory, `${label}.${channel}.log`), Buffer.concat(chunks[channel]), { flag: "wx" });
  if (outcome.code !== 0 || outcome.signal || outcome.error || overflow) throw new Error(`${label} failed; see preserved logs`);
  return Buffer.concat(chunks.stdout).toString("utf8");
}

const report = { schemaVersion: 1, kind: "native-player-authority-rpc-integration-v1", status: "RUNNING",
  evidenceClass: "TEST_ONLY", admission: "Rust cfg(test) override; no installed-build qualification",
  execution: "desktop-runtime-with-separate-rust-rpc-processes", qualificationScope: null,
  authorityEligible: false, releaseAllowed: false, startedAtMs: Date.now() };
try {
  report.sourceSha = (await run("source", "git", ["rev-parse", "HEAD"])).trim();
  report.sourceDirty = Boolean((await run("source-status", "git", ["status", "--porcelain"])).trim());
  const build = await run("build", "cargo", ["test", "--manifest-path", "native/Cargo.toml", "-p", "dsp-native-host",
    "--lib", "--release", "--locked", "--no-run", "--message-format=json"]);
  const binary = selectFoundationTestBinary(build);
  report.testBinarySha256 = createHash("sha256").update(fs.readFileSync(binary.executable)).digest("hex");
  report.profile = binary.profile;
  const resultPath = path.join(directory, "vitest.json");
  await run("integration", process.execPath, ["node_modules/vitest/vitest.mjs", "run",
    "src/game/nativePlayerAuthorityRpc.integration.test.ts", "--maxWorkers=1", "--reporter=json", `--outputFile=${resultPath}`],
  { ...env, DSP_NATIVE_AUTHORITY_RPC_TEST_BINARY: binary.executable });
  const result = JSON.parse(fs.readFileSync(resultPath, "utf8"));
  if (result.success !== true || result.numTotalTests !== 1 || result.numPassedTests !== 1 ||
      result.numFailedTests !== 0 || result.numPendingTests !== 0) throw new Error("RPC chain did not execute exactly once without skips");
  report.checks = { passed: 1, failed: 0, skipped: 0 };
  report.status = "PASS";
} catch (error) {
  report.status = "FAIL";
  report.error = error.message;
  process.exitCode = 1;
} finally {
  report.finishedAtMs = Date.now();
  fs.writeFileSync(path.join(directory, "report.json"), JSON.stringify(report, null, 2), { flag: "wx" });
  console.log(JSON.stringify(report));
}
