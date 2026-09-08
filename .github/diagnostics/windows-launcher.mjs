import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

// Observe the original integration case without changing its deadlines,
// assertions, staged executable, or real spawnSync implementation.
const root = process.cwd();
const originalPath = path.join(root, "scripts/benchmark-native-core-fixed-affinity-ab.test.mjs");
const original = fs.readFileSync(originalPath, "utf8");
const normalized = original.replace(/\r\n/g, "\n");
const marker = 'test("Windows timeout closes the Job Object tree and removes its private stage"';
const offset = normalized.indexOf(marker);
if (offset < 0 || normalized.indexOf(marker, offset + 1) >= 0) throw new Error("unexpected integration case");
const hook = '        timeoutGraceMs: 250,\n';
const tail = normalized.slice(offset);
if (tail.split(hook).length !== 2) throw new Error("unexpected original timeout override");
const observed = tail.replace(hook, hook + `        spawnSync: (...args) => {
          const started = Date.now();
          const result = diagnosticSpawnSync(...args);
          context.diagnostic(JSON.stringify({ event: "actual-launcher-return",
            elapsedMs: Date.now() - started, configuredTimeoutMs: args[2].timeout,
            fixtureReady: existsSync(pidFile), exitStatus: result.status,
            signal: result.signal, errorCode: result.error?.code,
            stdoutTail: String(result.stdout ?? "").slice(-1600),
            stderrTail: String(result.stderr ?? "").slice(-1600),
          }));
          return result;
        },
`);
const instrumented = 'import { spawnSync as diagnosticSpawnSync } from "node:child_process";\n' +
  normalized.slice(0, offset) + observed;
const probe = path.join(root, `scripts/benchmark-native-core-fixed-affinity-ab.ci-probe-${process.pid}.test.mjs`);
const sha = value => createHash("sha256").update(value).digest("hex");
fs.writeFileSync(probe, instrumented, { flag: "wx" });
try {
  console.log(JSON.stringify({ scope: "original cleanup assertions with observation-only spawn wrapper",
    originalSha256: sha(original), instrumentedSha256: sha(instrumented) }));
  const result = spawnSync(process.execPath, ["--test", "--test-reporter=tap",
    "--test-name-pattern=^Windows timeout closes", probe], { stdio: "inherit", windowsHide: true });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  fs.unlinkSync(probe);
}
