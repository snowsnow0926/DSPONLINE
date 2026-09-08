import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

// The default observes the unchanged integration case. Explicit diagnostic
// modes trace launcher phases; production-grace also uses the real launcher's
// default startup grace. No mode changes the cleanup assertions or workload.
const root = process.cwd();
const mode = process.argv[2] ?? "original";
if (!["original", "trace", "production-grace"].includes(mode)) throw new Error("unknown diagnostic mode");
const originalPath = path.join(root, "scripts/benchmark-native-core-fixed-affinity-ab.test.mjs");
const original = fs.readFileSync(originalPath, "utf8");
const normalized = original.replace(/\r\n/g, "\n");
const marker = 'test("Windows timeout closes the Job Object tree and removes its private stage"';
const offset = normalized.indexOf(marker);
if (offset < 0 || normalized.indexOf(marker, offset + 1) >= 0) throw new Error("unexpected integration case");
const hook = '        timeoutGraceMs: 250,\n';
const tail = normalized.slice(offset);
if (tail.split(hook).length !== 2) throw new Error("unexpected original timeout override");
const observed = tail.replace(hook, (mode === "production-grace" ? "" : hook) + `        spawnSync: (...args) => {
          if (${JSON.stringify(mode)} !== "original") {
            const commandIndex = args[1].indexOf("-EncodedCommand") + 1;
            if (commandIndex === 0) throw new Error("encoded command missing");
            let command = Buffer.from(args[1][commandIndex], "base64").toString("utf16le");
            const phase = name => "[Console]::Out.WriteLine('DSP_LAUNCH_PHASE " + name + " ' + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()); ";
            command = phase("powershell-ready") + command;
            for (const [marker, name] of [
              ["[DspFixedAffinityKillOnCloseJob]::AttachCurrentProcess()", "add-type-complete"],
              ["& cmd.exe /d /c $command", "job-attached-before-cmd"],
            ]) {
              if (command.split(marker).length !== 2) throw new Error("unexpected launcher phase");
              command = command.replace(marker, phase(name) + marker);
            }
            args[1] = [...args[1]];
            args[1][commandIndex] = Buffer.from(command, "utf16le").toString("base64");
          }
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
const body = mode === "production-grace"
  ? observed.replace('{ timeout: 20_000 }', '{ timeout: 100_000 }')
  : observed;
if (mode === "production-grace" && body === observed) throw new Error("original test envelope missing");
const instrumented = 'import { spawnSync as diagnosticSpawnSync } from "node:child_process";\n' +
  normalized.slice(0, offset) + body;
const probe = path.join(root, `scripts/benchmark-native-core-fixed-affinity-ab.ci-probe-${process.pid}.test.mjs`);
const sha = value => createHash("sha256").update(value).digest("hex");
fs.writeFileSync(probe, instrumented, { flag: "wx" });
try {
  console.log(JSON.stringify({ mode, scope: mode === "original"
    ? "original cleanup assertions with observation-only spawn wrapper"
    : "diagnostic launcher phase tracing; unchanged cleanup assertions and workload",
    originalSha256: sha(original), instrumentedSha256: sha(instrumented) }));
  const result = spawnSync(process.execPath, ["--test", "--test-reporter=tap",
    "--test-name-pattern=^Windows timeout closes", probe], { stdio: "inherit", windowsHide: true });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  fs.unlinkSync(probe);
}
