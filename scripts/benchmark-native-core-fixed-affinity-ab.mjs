#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  buildFixedAffinityChildEnvironment,
  evaluateFixedMeasured,
  evaluateFixedPreflight,
  normalizeAffinity,
  readFixedV47Fixture,
} from "./native-fixed-v47-fixture.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");
const WORKLOAD_RELATIVE_PATH = path.join("scripts", "native-fixed-affinity-workload.mjs");
const DEFAULT_HARNESS_SNAPSHOT_PATHS = Object.freeze([
  "scripts",
  "src",
  "desktop",
  "node_modules",
  "package.json",
  "package-lock.json",
  "vitest.config.ts",
  "vite.config.ts",
  "tsconfig.json",
  "tsconfig.app.json",
  "tsconfig.node.json",
]);
const SAMPLE_MARKER = /DSP_NATIVE_FIXED_AFFINITY_SAMPLE\t(\{[^\r\n]+\})/g;
const LOCAL_DISPATCH_STAGE_SHARE_MIN_PPM = 35_000;
const PRIORITY_FLAGS = new Map([
  ["Idle", "/low"],
  ["BelowNormal", "/belownormal"],
  ["Normal", "/normal"],
  ["AboveNormal", "/abovenormal"],
  ["High", "/high"],
  ["RealTime", "/realtime"],
]);
const FAILURE_CODES = new Set([
  "child-timeout", "child-output-limit", "child-launch-failed", "child-exit-nonzero",
  "child-record-invalid", "child-process-failed", "fixture-invalid", "runner-source-invalid",
  "staging-failed", "stage-cleanup-failed", "stage-final-verification-failed", "runner-error",
]);
const SYSTEM_CODES = new Set([
  "ETIMEDOUT", "ENOBUFS", "ENOENT", "EACCES", "EPERM", "EBUSY", "ENOTEMPTY",
  "EEXIST", "EINVAL", "UNKNOWN", "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
]);
const PROCESS_SIGNALS = new Set(["SIGTERM", "SIGKILL"]);
const WINDOWS_KILL_ON_CLOSE_JOB_SOURCE = String.raw`
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;

public static class DspFixedAffinityKillOnCloseJob
{
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private const int JobObjectExtendedLimitInformation = 9;
    private static IntPtr jobHandle = IntPtr.Zero;

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr jobAttributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(
        IntPtr job,
        int informationClass,
        ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION information,
        uint informationLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    public static void AttachCurrentProcess()
    {
        if (jobHandle != IntPtr.Zero)
            throw new InvalidOperationException("fixed-affinity job is already attached");

        IntPtr created = CreateJobObject(IntPtr.Zero, null);
        if (created == IntPtr.Zero)
            throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateJobObject failed");

        try
        {
            var information = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            information.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            uint length = (uint)Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
            if (!SetInformationJobObject(created, JobObjectExtendedLimitInformation, ref information, length))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "SetInformationJobObject failed");
            using (Process current = Process.GetCurrentProcess())
            {
                if (!AssignProcessToJobObject(created, current.Handle))
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "AssignProcessToJobObject failed");
            }
            jobHandle = created;
            created = IntPtr.Zero;
        }
        finally
        {
            if (created != IntPtr.Zero)
                CloseHandle(created);
        }
    }
}
`;

function fixedAffinityFailure(code, details = {}) {
  const error = new Error(code);
  error.fixedAffinityFailureCode = code;
  error.fixedAffinityFailureDetails = details;
  return error;
}

function safeIntegerOrNull(value) {
  return Number.isSafeInteger(value) ? value : null;
}

function redactedFailureDiagnostic(error, fallbackCode, category) {
  const requestedCode = error?.fixedAffinityFailureCode;
  const code = typeof requestedCode === "string" && FAILURE_CODES.has(requestedCode)
    ? requestedCode
    : fallbackCode;
  const details = error?.fixedAffinityFailureDetails;
  const systemCode = typeof details?.systemCode === "string" && SYSTEM_CODES.has(details.systemCode)
    ? details.systemCode
    : typeof error?.code === "string" && SYSTEM_CODES.has(error.code)
      ? error.code
      : null;
  const signal = typeof details?.signal === "string" && PROCESS_SIGNALS.has(details.signal)
    ? details.signal
    : null;
  return {
    category,
    code,
    systemCode,
    exitStatus: safeIntegerOrNull(details?.exitStatus),
    signal,
    timedOut: code === "child-timeout" || systemCode === "ETIMEDOUT",
    redacted: true,
  };
}

function usage() {
  return [
    "Usage:",
    "  node scripts/benchmark-native-core-fixed-affinity-ab.mjs \\",
    "    --baseline <absolute-host-path> --candidate <absolute-host-path> \\",
    "    --fixture <absolute-v47-envelope> --output <absolute-json-path> [options]",
    "",
    "Options:",
    "  --runs <n>                 Interleaved rounds (default 3 = six measured samples)",
    "  --threads <n>              Exact native worker count (default 8)",
    "  --affinity <hex-mask>      Fixed Windows affinity mask (default FFFF)",
    "  --node-priority <class>    Expected/pinned Node class (default High)",
    "  --native-priority <class>  Expected Native Host class (default Normal)",
    "  --timeout-ms <n>           Per-child timeout (default 600000)",
    "",
    "This runner proves only fixed affinity. It does not claim the mask selects P-cores.",
    "The fixture must already exist; the runner never generates or rewrites it.",
  ].join("\n");
}

export function parseFixedAffinityArgs(argv) {
  const options = {
    runs: 3,
    threads: 8,
    affinity: "FFFF",
    nodePriority: "High",
    nativePriority: "Normal",
    timeoutMs: 600_000,
  };
  const values = new Map([
    ["--baseline", "baseline"],
    ["--candidate", "candidate"],
    ["--fixture", "fixture"],
    ["--output", "output"],
    ["--runs", "runs"],
    ["--threads", "threads"],
    ["--affinity", "affinity"],
    ["--node-priority", "nodePriority"],
    ["--native-priority", "nativePriority"],
    ["--timeout-ms", "timeoutMs"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") return { help: true };
    const key = values.get(argument);
    if (!key) throw new Error(`unknown argument: ${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`missing value for ${argument}`);
    options[key] = value;
    index += 1;
  }
  for (const key of ["baseline", "candidate", "fixture", "output"]) {
    if (!options[key] || !path.isAbsolute(options[key])) throw new Error(`--${key} must be an absolute path`);
    options[key] = path.normalize(options[key]);
  }
  options.runs = Number(options.runs);
  options.threads = Number(options.threads);
  options.timeoutMs = Number(options.timeoutMs);
  if (!Number.isSafeInteger(options.runs) || options.runs < 1 || options.runs > 20) {
    throw new Error("--runs must be a safe integer from 1 to 20");
  }
  if (!Number.isSafeInteger(options.threads) || options.threads <= 0) {
    throw new Error("--threads must be a positive safe integer");
  }
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 60_000) {
    throw new Error("--timeout-ms must be a safe integer of at least 60000");
  }
  options.affinity = normalizeAffinity(options.affinity);
  if (!PRIORITY_FLAGS.has(options.nodePriority)) throw new Error("--node-priority is not a supported Windows priority class");
  if (!PRIORITY_FLAGS.has(options.nativePriority)) throw new Error("--native-priority is not a supported Windows priority class");
  return options;
}

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function sameOpenedFile(left, right) {
  if (!Number.isSafeInteger(left?.dev) || !Number.isSafeInteger(left?.ino) ||
      !Number.isSafeInteger(right?.dev) || !Number.isSafeInteger(right?.ino)) {
    return true;
  }
  // Some Windows filesystems expose zero for both values. In that case the
  // descriptor snapshot and the immediate path re-read below remain the gate.
  if ((left.dev === 0 && left.ino === 0) || (right.dev === 0 && right.ino === 0)) return true;
  return left.dev === right.dev && left.ino === right.ino;
}

function readRegularFileSnapshot(filePath, label = "snapshot source") {
  const resolved = path.resolve(filePath);
  const pathStat = fs.lstatSync(resolved);
  if (pathStat.isSymbolicLink() || !pathStat.isFile()) {
    throw new Error(`${label} must be a regular non-symbolic-link file: ${resolved}`);
  }
  const descriptor = fs.openSync(resolved, "r");
  try {
    const openedStat = fs.fstatSync(descriptor);
    if (!openedStat.isFile() || !sameOpenedFile(pathStat, openedStat)) {
      throw new Error(`${label} changed between path inspection and open: ${resolved}`);
    }
    const bytes = fs.readFileSync(descriptor);
    const finalOpenedStat = fs.fstatSync(descriptor);
    if (!sameOpenedFile(openedStat, finalOpenedStat) || finalOpenedStat.size !== bytes.length) {
      throw new Error(`${label} changed while its descriptor snapshot was read: ${resolved}`);
    }
    return {
      path: resolved,
      bytes,
      sizeBytes: bytes.length,
      sha256: sha256Bytes(bytes),
      mode: openedStat.mode,
    };
  } finally {
    fs.closeSync(descriptor);
  }
}

function publicFileIdentity(snapshot, identity) {
  if (!snapshot) return null;
  return { identity, sizeBytes: snapshot.sizeBytes, sha256: snapshot.sha256 };
}

function writeExclusiveSnapshot(filePath, snapshot) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  let descriptor = null;
  try {
    descriptor = fs.openSync(filePath, "wx", snapshot.mode & 0o777 || 0o600);
    fs.writeFileSync(descriptor, snapshot.bytes);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    try {
      fs.chmodSync(filePath, snapshot.mode & 0o777);
    } catch {
      // Windows may ignore POSIX mode changes; byte identity is independently checked.
    }
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
  const persisted = readRegularFileSnapshot(filePath, "staged snapshot");
  if (persisted.sha256 !== snapshot.sha256 || persisted.sizeBytes !== snapshot.sizeBytes ||
      !persisted.bytes.equals(snapshot.bytes)) {
    throw new Error(`staged snapshot bytes differ from the opened source bytes: ${filePath}`);
  }
  return persisted;
}

function safeRelativeSnapshotPath(value) {
  if (typeof value !== "string" || value.trim().length === 0 || path.isAbsolute(value)) {
    throw new Error("harness snapshot paths must be non-empty relative paths");
  }
  const normalized = path.normalize(value);
  if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
    throw new Error(`harness snapshot path escapes its root: ${value}`);
  }
  return normalized;
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function assertRegularDirectory(directoryPath, label) {
  const resolved = path.resolve(directoryPath);
  const stat = fs.lstatSync(resolved);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${label} must be a non-symbolic-link directory: ${resolved}`);
  }
  return resolved;
}

function captureHarnessManifest({ sourceRoot, relativePaths, destinationRoot = null }) {
  const resolvedSourceRoot = assertRegularDirectory(sourceRoot, "harness source root");
  const roots = [...new Set(relativePaths.map(safeRelativeSnapshotPath))].sort(compareUtf8);
  const entries = [];

  const visit = (absoluteSource, relativePath) => {
    const sourceStat = fs.lstatSync(absoluteSource);
    if (sourceStat.isSymbolicLink()) {
      throw new Error(`harness snapshots reject symbolic links and reparse aliases: ${absoluteSource}`);
    }
    if (sourceStat.isDirectory()) {
      if (destinationRoot) fs.mkdirSync(path.join(destinationRoot, relativePath), { recursive: true, mode: 0o700 });
      const names = fs.readdirSync(absoluteSource).sort(compareUtf8);
      for (const name of names) visit(path.join(absoluteSource, name), path.join(relativePath, name));
      return;
    }
    if (!sourceStat.isFile()) throw new Error(`harness snapshot contains a non-regular entry: ${absoluteSource}`);
    const snapshot = readRegularFileSnapshot(absoluteSource, "harness source");
    if (destinationRoot) writeExclusiveSnapshot(path.join(destinationRoot, relativePath), snapshot);
    entries.push({
      path: relativePath.split(path.sep).join("/"),
      sizeBytes: snapshot.sizeBytes,
      sha256: snapshot.sha256,
    });
  };

  for (const relativePath of roots) {
    visit(path.join(resolvedSourceRoot, relativePath), relativePath);
  }
  entries.sort((left, right) => compareUtf8(left.path, right.path));
  const manifestBytes = Buffer.from(JSON.stringify({ schemaVersion: 1, roots, entries }), "utf8");
  return {
    schemaVersion: 1,
    sourceRoot: resolvedSourceRoot,
    roots: roots.map((entry) => entry.split(path.sep).join("/")),
    fileCount: entries.length,
    totalBytes: entries.reduce((total, entry) => total + entry.sizeBytes, 0),
    sha256: sha256Bytes(manifestBytes),
    entries,
  };
}

function publicHarnessManifest(manifest, identity, includeEntries = false) {
  if (!manifest) return null;
  return {
    schemaVersion: manifest.schemaVersion,
    identity,
    roots: manifest.roots,
    fileCount: manifest.fileCount,
    totalBytes: manifest.totalBytes,
    sha256: manifest.sha256,
    algorithm: "sha256(JSON({schemaVersion,roots,sorted[{path,sizeBytes,sha256}]}))",
    ...(includeEntries ? { entries: manifest.entries } : {}),
  };
}

function manifestMatches(left, right) {
  return Boolean(left && right && left.sha256 === right.sha256 &&
    left.fileCount === right.fileCount && left.totalBytes === right.totalBytes);
}

function bindOuterRunnerToStage(stage, runnerSnapshot) {
  const relative = path.relative(stage.harness.sourceRoot, runnerSnapshot.path);
  if (!relative || path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) {
    throw new Error("outer runner source is outside the frozen harness root");
  }
  const manifestPath = relative.split(path.sep).join("/");
  const manifestEntry = stage.harness.source.entries.find((entry) => entry.path === manifestPath);
  if (!manifestEntry || manifestEntry.sha256 !== runnerSnapshot.sha256 ||
      manifestEntry.sizeBytes !== runnerSnapshot.sizeBytes) {
    throw new Error("outer runner source does not match its frozen harness manifest entry");
  }
  const staged = readRegularFileSnapshot(
    path.join(stage.harness.stagedRoot, relative),
    "staged outer runner",
  );
  if (staged.sha256 !== runnerSnapshot.sha256 || staged.sizeBytes !== runnerSnapshot.sizeBytes) {
    throw new Error("staged outer runner does not match the loaded source identity");
  }
  return { manifestPath, staged };
}

function stageFixedAffinityInputs(options, dependencies) {
  const stageParent = path.resolve(dependencies.stageParent ?? os.tmpdir());
  fs.mkdirSync(stageParent, { recursive: true });
  const stageRoot = fs.mkdtempSync(path.join(stageParent, "dsp-native-fixed-affinity-"));
  try {
    const sourceHarnessRoot = path.resolve(dependencies.harnessRoot ?? ROOT);
    const harnessPaths = dependencies.harnessSnapshotPaths ?? DEFAULT_HARNESS_SNAPSHOT_PATHS;
    const sourceBinarySnapshots = {
      baseline: readRegularFileSnapshot(options.baseline, "baseline Host source"),
      candidate: readRegularFileSnapshot(options.candidate, "candidate Host source"),
    };
    const sourceNodeSnapshot = readRegularFileSnapshot(
      dependencies.nodeExecutable ?? process.execPath,
      "Node executable source",
    );
    const stagedBinarySnapshots = {
      baseline: writeExclusiveSnapshot(path.join(stageRoot, "hosts", "baseline.exe"), sourceBinarySnapshots.baseline),
      candidate: writeExclusiveSnapshot(path.join(stageRoot, "hosts", "candidate.exe"), sourceBinarySnapshots.candidate),
    };
    const stagedNodeSnapshot = writeExclusiveSnapshot(
      path.join(stageRoot, "node", process.platform === "win32" ? "node.exe" : "node"),
      sourceNodeSnapshot,
    );
    const stagedHarnessRoot = path.join(stageRoot, "harness");
    fs.mkdirSync(stagedHarnessRoot, { recursive: true, mode: 0o700 });
    const scratchRoot = path.join(stageRoot, "scratch");
    fs.mkdirSync(scratchRoot, { recursive: false, mode: 0o700 });
    const sourceHarnessManifest = captureHarnessManifest({
      sourceRoot: sourceHarnessRoot,
      relativePaths: harnessPaths,
      destinationRoot: stagedHarnessRoot,
    });
    const immediateSourceBinaries = {
      baseline: readRegularFileSnapshot(options.baseline, "baseline Host source post-stage"),
      candidate: readRegularFileSnapshot(options.candidate, "candidate Host source post-stage"),
    };
    const immediateSourceNode = readRegularFileSnapshot(
      dependencies.nodeExecutable ?? process.execPath,
      "Node executable source post-stage",
    );
    const immediateSourceHarnessManifest = captureHarnessManifest({
      sourceRoot: sourceHarnessRoot,
      relativePaths: harnessPaths,
    });
    const immediateStagedHarnessManifest = captureHarnessManifest({
      sourceRoot: stagedHarnessRoot,
      relativePaths: harnessPaths,
    });
    const reasonCodes = [];
    for (const label of ["baseline", "candidate"]) {
      if (sourceBinarySnapshots[label].sha256 !== immediateSourceBinaries[label].sha256 ||
          sourceBinarySnapshots[label].sizeBytes !== immediateSourceBinaries[label].sizeBytes) {
        reasonCodes.push("binary-post-stage-sha-mismatch");
      }
    }
    if (sourceNodeSnapshot.sha256 !== immediateSourceNode.sha256 ||
        sourceNodeSnapshot.sizeBytes !== immediateSourceNode.sizeBytes) {
      reasonCodes.push("node-post-stage-sha-mismatch");
    }
    if (!manifestMatches(sourceHarnessManifest, immediateSourceHarnessManifest)) {
      reasonCodes.push("harness-post-stage-manifest-mismatch");
    }
    if (!manifestMatches(sourceHarnessManifest, immediateStagedHarnessManifest)) {
      reasonCodes.push("harness-staged-post-stage-manifest-mismatch");
    }
    const stage = {
      root: stageRoot,
      binaries: {
        baseline: {
          source: sourceBinarySnapshots.baseline,
          staged: stagedBinarySnapshots.baseline,
          immediateSource: immediateSourceBinaries.baseline,
          sha256: stagedBinarySnapshots.baseline.sha256,
        },
        candidate: {
          source: sourceBinarySnapshots.candidate,
          staged: stagedBinarySnapshots.candidate,
          immediateSource: immediateSourceBinaries.candidate,
          sha256: stagedBinarySnapshots.candidate.sha256,
        },
      },
      node: {
        source: sourceNodeSnapshot,
        staged: stagedNodeSnapshot,
        immediateSource: immediateSourceNode,
        sha256: stagedNodeSnapshot.sha256,
      },
      harness: {
        sourceRoot: sourceHarnessRoot,
        stagedRoot: stagedHarnessRoot,
        relativePaths: harnessPaths,
        source: sourceHarnessManifest,
        immediateSource: immediateSourceHarnessManifest,
        immediateStaged: immediateStagedHarnessManifest,
      },
      scratchRoot,
      reasonCodes,
    };
    dependencies.onStageReady?.(stage);
    return stage;
  } catch (error) {
    fs.rmSync(stageRoot, { recursive: true, force: true });
    throw error;
  }
}

function verifyFixedAffinityStage(stage, options, dependencies) {
  const reasonCodes = [];
  const finalBinaries = {};
  for (const label of ["baseline", "candidate"]) {
    let source = null;
    let staged = null;
    try {
      source = readRegularFileSnapshot(options[label], `${label} Host source final`);
      if (source.sha256 !== stage.binaries[label].sha256 || source.sizeBytes !== stage.binaries[label].staged.sizeBytes) {
        reasonCodes.push("binary-final-sha-mismatch");
      }
    } catch {
      reasonCodes.push("binary-final-sha-mismatch");
    }
    try {
      staged = readRegularFileSnapshot(stage.binaries[label].staged.path, `${label} staged Host final`);
      if (staged.sha256 !== stage.binaries[label].sha256 || staged.sizeBytes !== stage.binaries[label].staged.sizeBytes) {
        reasonCodes.push("binary-staged-final-sha-mismatch");
      }
    } catch {
      reasonCodes.push("binary-staged-final-sha-mismatch");
    }
    finalBinaries[label] = { source, staged };
  }
  const finalNode = { source: null, staged: null };
  try {
    finalNode.source = readRegularFileSnapshot(
      dependencies.nodeExecutable ?? process.execPath,
      "Node executable source final",
    );
    if (finalNode.source.sha256 !== stage.node.sha256 || finalNode.source.sizeBytes !== stage.node.staged.sizeBytes) {
      reasonCodes.push("node-final-sha-mismatch");
    }
  } catch {
    reasonCodes.push("node-final-sha-mismatch");
  }
  try {
    finalNode.staged = readRegularFileSnapshot(stage.node.staged.path, "Node executable staged final");
    if (finalNode.staged.sha256 !== stage.node.sha256 || finalNode.staged.sizeBytes !== stage.node.staged.sizeBytes) {
      reasonCodes.push("node-staged-final-sha-mismatch");
    }
  } catch {
    reasonCodes.push("node-staged-final-sha-mismatch");
  }
  const finalHarness = { source: null, staged: null };
  try {
    finalHarness.source = captureHarnessManifest({
      sourceRoot: stage.harness.sourceRoot,
      relativePaths: stage.harness.relativePaths,
    });
    if (!manifestMatches(stage.harness.source, finalHarness.source)) {
      reasonCodes.push("harness-final-manifest-mismatch");
    }
  } catch {
    reasonCodes.push("harness-final-manifest-mismatch");
  }
  try {
    finalHarness.staged = captureHarnessManifest({
      sourceRoot: stage.harness.stagedRoot,
      relativePaths: stage.harness.relativePaths,
    });
    if (!manifestMatches(stage.harness.source, finalHarness.staged)) {
      reasonCodes.push("harness-staged-final-manifest-mismatch");
    }
  } catch {
    reasonCodes.push("harness-staged-final-manifest-mismatch");
  }
  return { reasonCodes, finalBinaries, finalNode, finalHarness };
}

function cleanupFixedAffinityStage(stageRoot) {
  try {
    fs.rmSync(stageRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    return { attempted: true, succeeded: !fs.existsSync(stageRoot), error: null };
  } catch (error) {
    return {
      attempted: true,
      succeeded: false,
      error: redactedFailureDiagnostic(error, "stage-cleanup-failed", "cleanup"),
    };
  }
}

function publicCleanupEvidence(value) {
  const succeeded = value?.succeeded === true;
  return {
    attempted: value?.attempted === true,
    succeeded,
    error: succeeded || value?.error === null
      ? null
      : value?.error?.redacted === true
        ? value.error
        : redactedFailureDiagnostic(value?.error, "stage-cleanup-failed", "cleanup"),
  };
}

function quoteCmd(value) {
  if (/['"\r\n]/.test(value)) throw new Error("fixed-affinity executable paths may not contain quotes or newlines");
  return `"${value}"`;
}

function parseSample(output) {
  const matches = [...String(output).matchAll(SAMPLE_MARKER)];
  if (matches.length !== 1) throw new Error(`expected one fixed-affinity sample record, found ${matches.length}`);
  return JSON.parse(matches[0][1]);
}

export function runPinnedFixedAffinitySample(options, dependencies = {}) {
  const {
    binary,
    fixture,
    fixtureSha256,
    harnessRoot,
    workloadPath,
    nodeExecutable,
    scratchRoot,
    threads,
    affinity,
    nodePriority,
    nativePriority,
    timeoutMs,
  } = options;
  if ((dependencies.platform ?? process.platform) !== "win32") {
    throw new Error("fixed-affinity process pinning requires Windows");
  }
  const normalizedAffinity = normalizeAffinity(affinity);
  const affinityMask = normalizedAffinity.slice(2);
  const priorityFlag = PRIORITY_FLAGS.get(nodePriority);
  if (!priorityFlag) throw new Error(`unsupported Node priority: ${nodePriority}`);
  if (!PRIORITY_FLAGS.has(nativePriority)) throw new Error(`unsupported Native Host priority: ${nativePriority}`);
  for (const [label, value] of [
    ["staged harness root", harnessRoot],
    ["staged workload", workloadPath],
    ["staged Node executable", nodeExecutable],
    ["stage-owned scratch root", scratchRoot],
  ]) {
    if (!value || !path.isAbsolute(value)) throw new Error(`${label} must be an absolute path`);
  }
  const expectedScratchRoot = path.join(path.dirname(path.resolve(harnessRoot)), "scratch");
  if (path.resolve(scratchRoot) !== expectedScratchRoot) {
    throw new Error("fixed-affinity scratch root must be the private stage sibling of the harness");
  }
  assertRegularDirectory(scratchRoot, "fixed-affinity stage scratch root");
  const command = [
    "start", '""', "/b", "/wait", priorityFlag, "/affinity", affinityMask,
    quoteCmd(nodeExecutable), quoteCmd(workloadPath),
  ].join(" ");
  const commandBase64 = Buffer.from(command, "utf8").toString("base64");
  const jobSourceBase64 = Buffer.from(WINDOWS_KILL_ON_CLOSE_JOB_SOURCE, "utf8").toString("base64");
  const powershell = [
    "$ErrorActionPreference='Stop'",
    `$jobSource=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${jobSourceBase64}'))`,
    "Add-Type -TypeDefinition $jobSource -Language CSharp",
    "[DspFixedAffinityKillOnCloseJob]::AttachCurrentProcess()",
    "$env:DSP_FIXED_AFFINITY_JOB_ROOT_PID=[string]$PID",
    `$command=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${commandBase64}'))`,
    "& cmd.exe /d /c $command",
    "exit $LASTEXITCODE",
  ].join("; ");
  const encoded = Buffer.from(powershell, "utf16le").toString("base64");
  const now = dependencies.now ?? Date.now;
  const timeoutGraceMs = Number.isSafeInteger(dependencies.timeoutGraceMs) && dependencies.timeoutGraceMs >= 0
    ? Math.min(dependencies.timeoutGraceMs, 30_000)
    : 30_000;
  const startedAt = now();
  const result = (dependencies.spawnSync ?? spawnSync)(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
      cwd: harnessRoot,
      env: buildFixedAffinityChildEnvironment(process.env, {
        DSP_FIXED_AFFINITY_BINARY: binary,
        DSP_FIXED_AFFINITY_FIXTURE: fixture,
        DSP_FIXED_AFFINITY_FIXTURE_SHA256: fixtureSha256,
        DSP_FIXED_AFFINITY_THREADS: String(threads),
        DSP_FIXED_AFFINITY_AFFINITY: normalizedAffinity,
        DSP_FIXED_AFFINITY_NODE_PRIORITY: nodePriority,
        DSP_FIXED_AFFINITY_NATIVE_PRIORITY: nativePriority,
        DSP_FIXED_AFFINITY_TIMEOUT_MS: String(timeoutMs),
        DSP_FIXED_AFFINITY_STAGE_SCRATCH_ROOT: scratchRoot,
        NO_COLOR: "1",
        FORCE_COLOR: "0",
      }),
      encoding: "utf8",
      windowsHide: true,
      timeout: timeoutMs + timeoutGraceMs,
      killSignal: "SIGKILL",
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (result.error) {
    const systemCode = typeof result.error.code === "string" ? result.error.code : null;
    throw fixedAffinityFailure(systemCode === "ETIMEDOUT" ? "child-timeout" :
      systemCode === "ENOBUFS" ? "child-output-limit" : "child-launch-failed", {
      systemCode,
      signal: result.signal,
      exitStatus: result.status,
    });
  }
  if (result.status !== 0) {
    throw fixedAffinityFailure("child-exit-nonzero", {
      exitStatus: result.status,
      signal: result.signal,
    });
  }
  let sample;
  try {
    sample = parseSample(output);
  } catch {
    throw fixedAffinityFailure("child-record-invalid");
  }
  return { ...sample, elapsedWallMs: Math.max(0, now() - startedAt) };
}

function interleavedSchedule(runs) {
  const schedule = [];
  for (let round = 1; round <= runs; round += 1) {
    const labels = round % 2 === 1 ? ["baseline", "candidate"] : ["candidate", "baseline"];
    for (const label of labels) schedule.push({ round, label, sequence: schedule.length + 1 });
  }
  return schedule;
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function uniqueReasons(reasons) {
  return [...new Set(reasons)];
}

function binaryEvidenceMatches(samples, binaries) {
  return samples.every((sample) => !sample.ok || (
    sample.record.binarySha256 === binaries[sample.label].sha256 &&
    sample.record.hostBinarySha256 === binaries[sample.label].sha256
  ));
}

function publicStagedBinary(entry, label) {
  if (!entry) return null;
  return {
    source: publicFileIdentity(entry.source, `input/${label}-host`),
    staged: publicFileIdentity(entry.staged, `stage/hosts/${label}.exe`),
    immediateSource: publicFileIdentity(entry.immediateSource, `input/${label}-host/post-stage`),
    sha256: entry.sha256,
  };
}

function publicFinalBinary(entry, label) {
  if (!entry) return null;
  return {
    source: publicFileIdentity(entry.source, `input/${label}-host/final`),
    staged: publicFileIdentity(entry.staged, `stage/hosts/${label}.exe/final`),
  };
}

function publicFixtureEvidence(fixture) {
  if (!fixture) return null;
  if (fixture.failure) return { identity: "input/fixed-v47-fixture", failure: fixture.failure };
  return {
    identity: "input/fixed-v47-fixture",
    sha256: fixture.sha256,
    sizeBytes: fixture.sizeBytes,
    envelopeFormatVersion: fixture.envelopeFormatVersion,
    stateVersion: fixture.stateVersion,
    stateChecksum: fixture.stateChecksum,
    entityCount: fixture.entityCount,
    beltCount: fixture.beltCount,
  };
}

function publicProcessSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return null;
  let processorAffinity = null;
  try {
    processorAffinity = normalizeAffinity(snapshot.ProcessorAffinity);
  } catch {
    // Invalid child strings are not copied into public evidence.
  }
  return {
    Id: safeIntegerOrNull(snapshot.Id),
    PriorityClass: PRIORITY_FLAGS.has(snapshot.PriorityClass) ? snapshot.PriorityClass : null,
    ProcessorAffinity: processorAffinity,
  };
}

function publicProcessPolicy(policy) {
  if (!policy || typeof policy !== "object") return null;
  let requestedAffinity = null;
  try {
    requestedAffinity = normalizeAffinity(policy.requested?.affinity);
  } catch {
    // Invalid child strings are not copied into public evidence.
  }
  return {
    requested: policy.requested ? {
      affinity: requestedAffinity,
      nodePriority: PRIORITY_FLAGS.has(policy.requested.nodePriority) ? policy.requested.nodePriority : null,
      nativePriority: PRIORITY_FLAGS.has(policy.requested.nativePriority) ? policy.requested.nativePriority : null,
    } : null,
    before: policy.before ? {
      node: publicProcessSnapshot(policy.before.node),
      nativeHost: publicProcessSnapshot(policy.before.nativeHost),
    } : null,
    after: policy.after ? {
      node: publicProcessSnapshot(policy.after.node),
      nativeHost: publicProcessSnapshot(policy.after.nativeHost),
    } : null,
  };
}

function publicLocalDispatchProfile(profile) {
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) return null;
  const result = {};
  for (const key of [
    "schemaVersion", "stageDurationNs", "stageDurationMicros", "fullAdvanceDurationNs", "stageSharePpm",
    "parallelBenefitUpperBoundPpm",
    "selectedDemands", "totalDemands", "planetShards", "demandSlots", "peerEdges",
    "sortWorkUnits", "totalWorkUnits", "largestShardWorkUnits", "largestShardRatioPpm",
    "parallelizableWorkUnits", "parallelizableRatioPpm", "routeEvents",
  ]) {
    result[key] = Number.isSafeInteger(profile[key]) && profile[key] >= 0 ? profile[key] : null;
  }
  for (const key of ["shardWorkSha256", "shapeSha256"]) {
    result[key] = typeof profile[key] === "string" && /^[a-f0-9]{64}$/.test(profile[key])
      ? profile[key]
      : null;
  }
  for (const key of [
    "instrumentationVersion", "workScope", "productGate", "scanFallback", "parallelFallback",
    "gateStatus", "parallelBenefitUpperBoundScope",
  ]) {
    result[key] = typeof profile[key] === "string" && profile[key].length <= 128 ? profile[key] : null;
  }
  result.planetIdentityProven = profile.planetIdentityProven === true;
  result.gateReasonCodes = Array.isArray(profile.gateReasonCodes)
    ? profile.gateReasonCodes.filter((reason) => typeof reason === "string" && reason.length <= 128).slice(0, 16)
    : [];
  return result;
}

function publicFixedAffinityRecord(record) {
  if (!record || typeof record !== "object") return null;
  const publicRecord = {};
  for (const key of [
    "fixtureSha256", "openCanonicalSha256", "preStepCanonicalSha256", "preStepDomainSha256",
    "measuredCanonicalSha256", "measuredDomainSha256", "binarySha256", "hostBinarySha256",
  ]) {
    publicRecord[key] = typeof record[key] === "string" && /^[a-f0-9]{64}$/.test(record[key])
      ? record[key]
      : null;
  }
  publicRecord.nodePriority = PRIORITY_FLAGS.has(record.nodePriority) ? record.nodePriority : null;
  publicRecord.nativePriority = PRIORITY_FLAGS.has(record.nativePriority) ? record.nativePriority : null;
  for (const key of ["nodeAffinity", "nativeAffinity"]) {
    try {
      publicRecord[key] = normalizeAffinity(record[key]);
    } catch {
      publicRecord[key] = null;
    }
  }
  publicRecord.requestedThreads = typeof record.requestedThreads === "string" && /^[1-9]\d{0,8}$/.test(record.requestedThreads)
    ? record.requestedThreads
    : null;
  for (const key of [
    "durationMs", "elapsedWallMs", "fixtureBytes", "effectiveWorkerLimit",
    "observedWorkerCount", "writeBackWorkers",
  ]) {
    publicRecord[key] = typeof record[key] === "number" && Number.isFinite(record[key]) ? record[key] : null;
  }
  publicRecord.profileEnabled = record.profileEnabled === true;
  publicRecord.processPolicy = publicProcessPolicy(record.processPolicy);
  publicRecord.evidenceStatus = record.evidenceStatus === "RESULT" ? "RESULT" : "NO_RESULT";
  publicRecord.profileGate = record.profileGate && typeof record.profileGate === "object" ? {
    status: ["ELIGIBLE_FOR_FIXED_AB", "NO_GO"].includes(record.profileGate.status)
      ? record.profileGate.status
      : "NO_RESULT",
    thresholdPpm: safeIntegerOrNull(record.profileGate.thresholdPpm),
    theoreticalUpperBoundPpm: safeIntegerOrNull(record.profileGate.theoreticalUpperBoundPpm),
    reasonCodes: Array.isArray(record.profileGate.reasonCodes)
      ? record.profileGate.reasonCodes.filter((reason) => typeof reason === "string" && reason.length <= 128).slice(0, 16)
      : [],
  } : { status: "NO_RESULT", thresholdPpm: null, reasonCodes: ["profile-gate-missing"] };
  publicRecord.performanceDecision = record.performanceDecision?.status === "NOT_EVALUATED" ? {
    status: "NOT_EVALUATED",
    reasonCode: typeof record.performanceDecision.reasonCode === "string"
      ? record.performanceDecision.reasonCode.slice(0, 128)
      : null,
  } : { status: "NOT_EVALUATED", reasonCode: "performance-decision-evidence-invalid" };
  publicRecord.localDispatchProfile = publicLocalDispatchProfile(record.localDispatchProfile);
  return publicRecord;
}

function aggregateLocalDispatchProfileGate(status, samples, evidenceReasonCodes = []) {
  if (status !== "RESULT") {
    const profileReasons = evidenceReasonCodes.filter((reason) =>
      typeof reason === "string" && reason.startsWith("local-dispatch-profile-"));
    return {
      status: "NO_RESULT",
      thresholdPpm: LOCAL_DISPATCH_STAGE_SHARE_MIN_PPM,
      reasonCodes: profileReasons.length > 0 ? uniqueReasons(profileReasons) : ["fixed-affinity-evidence-invalid"],
      baselineStageSharePpm: null,
      candidateStageSharePpm: null,
      baselineParallelBenefitUpperBoundPpm: null,
      candidateParallelBenefitUpperBoundPpm: null,
    };
  }
  const completed = samples.filter((sample) => sample.ok === true);
  const profiles = completed.map((sample) => sample.record.localDispatchProfile);
  const reasonCodes = uniqueReasons(completed.flatMap((sample) => sample.record.profileGate.reasonCodes));
  const baselineShares = completed.filter((sample) => sample.label === "baseline")
    .map((sample) => sample.record.localDispatchProfile.stageSharePpm);
  const candidateShares = completed.filter((sample) => sample.label === "candidate")
    .map((sample) => sample.record.localDispatchProfile.stageSharePpm);
  const baselineUpperBounds = completed.filter((sample) => sample.label === "baseline")
    .map((sample) => sample.record.localDispatchProfile.parallelBenefitUpperBoundPpm);
  const candidateUpperBounds = completed.filter((sample) => sample.label === "candidate")
    .map((sample) => sample.record.localDispatchProfile.parallelBenefitUpperBoundPpm);
  if (profiles.length === 0 || baselineShares.length === 0 || candidateShares.length === 0) {
    return {
      status: "NO_RESULT",
      thresholdPpm: LOCAL_DISPATCH_STAGE_SHARE_MIN_PPM,
      reasonCodes: ["local-dispatch-profile-evidence-missing"],
      baselineStageSharePpm: null,
      candidateStageSharePpm: null,
      baselineParallelBenefitUpperBoundPpm: null,
      candidateParallelBenefitUpperBoundPpm: null,
    };
  }
  return {
    status: reasonCodes.length === 0 ? "ELIGIBLE_FOR_FIXED_AB" : "NO_GO",
    thresholdPpm: LOCAL_DISPATCH_STAGE_SHARE_MIN_PPM,
    reasonCodes,
    baselineStageSharePpm: {
      minimum: Math.min(...baselineShares),
      median: median(baselineShares),
      maximum: Math.max(...baselineShares),
    },
    candidateStageSharePpm: {
      minimum: Math.min(...candidateShares),
      median: median(candidateShares),
      maximum: Math.max(...candidateShares),
    },
    baselineParallelBenefitUpperBoundPpm: {
      minimum: Math.min(...baselineUpperBounds),
      median: median(baselineUpperBounds),
      maximum: Math.max(...baselineUpperBounds),
    },
    candidateParallelBenefitUpperBoundPpm: {
      minimum: Math.min(...candidateUpperBounds),
      median: median(candidateUpperBounds),
      maximum: Math.max(...candidateUpperBounds),
    },
  };
}

function publicSampleEvidence(sample) {
  const common = {
    ok: sample?.ok === true,
    label: sample?.label ?? null,
    phase: sample?.phase ?? null,
    round: safeIntegerOrNull(sample?.round),
    sequence: safeIntegerOrNull(sample?.sequence),
  };
  return sample?.ok === true
    ? { ...common, record: publicFixedAffinityRecord(sample.record) }
    : { ...common, failure: sample?.failure ?? null };
}

export function runFixedAffinityAb(options, dependencies = {}) {
  const platform = dependencies.platform ?? process.platform;
  const logicalProcessorCount = dependencies.logicalProcessorCount ?? os.cpus().length;
  const readFixture = dependencies.readFixture ?? readFixedV47Fixture;
  const runSample = dependencies.runSample ?? runPinnedFixedAffinitySample;
  const now = dependencies.now ?? Date.now;
  const startedAt = now();
  const reasonCodes = [];
  const samples = [];
  const preflight = [];
  let fixture = null;
  let outerRunner = null;
  let finalOuterRunner = null;
  let stage = null;
  let stagingError = null;
  let stagingDurationMs = null;
  let finalStage = null;
  let cleanup = { attempted: false, succeeded: false, error: null };
  let finalBinaries = null;
  let preflightEvaluation = null;

  if (platform !== "win32") reasonCodes.push("unsupported-platform");
  if (logicalProcessorCount > 64) reasonCodes.push("unsupported-processor-groups");
  try {
    fixture = readFixture(options.fixture);
  } catch (error) {
    reasonCodes.push("fixture-invalid");
    fixture = {
      path: options.fixture,
      failure: redactedFailureDiagnostic(error, "fixture-invalid", "fixture"),
    };
  }
  if (reasonCodes.length === 0) {
    try {
      outerRunner = readRegularFileSnapshot(
        dependencies.runnerPath ?? SCRIPT_PATH,
        "outer fixed-affinity runner source",
      );
    } catch (error) {
      reasonCodes.push("runner-source-invalid");
      stagingError = redactedFailureDiagnostic(error, "runner-source-invalid", "staging");
    }
  }
  if (reasonCodes.length === 0) {
    const stagingStartedAt = now();
    try {
      stage = (dependencies.stageInputs ?? stageFixedAffinityInputs)(options, dependencies);
      stage.outerRunner = bindOuterRunnerToStage(stage, outerRunner);
      reasonCodes.push(...stage.reasonCodes);
      if (stage.binaries.baseline.sha256 === stage.binaries.candidate.sha256) reasonCodes.push("binary-sha-identical");
    } catch (error) {
      reasonCodes.push("staging-failed");
      stagingError = redactedFailureDiagnostic(error, "staging-failed", "staging");
    } finally {
      stagingDurationMs = Math.max(0, now() - stagingStartedAt);
    }
  }

  const runOne = (label, phase, round, sequence) => {
    try {
      const record = runSample({
        binary: stage.binaries[label].staged.path,
        fixture: fixture.path,
        fixtureSha256: fixture.sha256,
        harnessRoot: stage.harness.stagedRoot,
        workloadPath: path.join(stage.harness.stagedRoot, WORKLOAD_RELATIVE_PATH),
        nodeExecutable: stage.node.staged.path,
        scratchRoot: stage.scratchRoot,
        threads: options.threads,
        affinity: options.affinity,
        nodePriority: options.nodePriority,
        nativePriority: options.nativePriority,
        timeoutMs: options.timeoutMs,
      });
      return { ok: true, label, phase, round, sequence, record };
    } catch (error) {
      return {
        ok: false,
        label,
        phase,
        round,
        sequence,
        failure: redactedFailureDiagnostic(error, "child-process-failed", "child-process"),
      };
    }
  };

  if (reasonCodes.length === 0) {
    for (const [index, label] of ["baseline", "candidate"].entries()) {
      preflight.push(runOne(label, "preflight", 0, index + 1));
    }
    if (!binaryEvidenceMatches(preflight, stage.binaries)) reasonCodes.push("binary-sha-mismatch");
    if (reasonCodes.length === 0 && preflight.every((sample) => sample.ok)) {
      preflightEvaluation = evaluateFixedPreflight({
        records: preflight.map((sample) => sample.record),
        fixtureSha256: fixture.sha256,
        affinity: options.affinity,
        threads: options.threads,
        nodePriority: options.nodePriority,
        nativePriority: options.nativePriority,
      });
      reasonCodes.push(...preflightEvaluation.reasonCodes);
    } else if (preflight.some((sample) => !sample.ok)) {
      reasonCodes.push("preflight-process-failed");
    }
  }

  const schedule = interleavedSchedule(options.runs);
  if (reasonCodes.length === 0) {
    for (const entry of schedule) {
      const sample = runOne(entry.label, "measure", entry.round, entry.sequence);
      samples.push(sample);
      if (!sample.ok) break;
    }
    if (samples.length === schedule.length && samples.every((sample) => sample.ok)) {
      if (!binaryEvidenceMatches(samples, stage.binaries)) reasonCodes.push("binary-sha-mismatch");
    }
    if (reasonCodes.length === 0 && samples.length === schedule.length && samples.every((sample) => sample.ok)) {
      const evaluation = evaluateFixedMeasured({
        records: samples.map((sample) => sample.record),
        expectedCount: schedule.length,
        fixtureSha256: fixture.sha256,
        affinity: options.affinity,
        threads: options.threads,
        nodePriority: options.nodePriority,
        nativePriority: options.nativePriority,
        preflightExpected: preflightEvaluation.expected,
      });
      reasonCodes.push(...evaluation.reasonCodes);
    } else if (samples.length !== schedule.length || samples.some((sample) => !sample.ok)) {
      reasonCodes.push("measured-process-failed");
    }
  }

  if (fixture?.sha256) {
    try {
      const finalFixture = readFixture(options.fixture, fixture.sha256);
      if (!fixture.bytes.equals(finalFixture.bytes)) reasonCodes.push("fixture-final-bytes-mismatch");
    } catch {
      reasonCodes.push("fixture-final-sha-mismatch");
    }
  }
  if (stage) {
    try {
      finalStage = (dependencies.verifyStage ?? verifyFixedAffinityStage)(stage, options, dependencies);
      reasonCodes.push(...finalStage.reasonCodes);
      finalBinaries = {
        baseline: publicFinalBinary(finalStage.finalBinaries.baseline, "baseline"),
        candidate: publicFinalBinary(finalStage.finalBinaries.candidate, "candidate"),
      };
      try {
        finalOuterRunner = readRegularFileSnapshot(
          dependencies.runnerPath ?? SCRIPT_PATH,
          "outer fixed-affinity runner source final",
        );
        if (finalOuterRunner.sha256 !== outerRunner.sha256 ||
            finalOuterRunner.sizeBytes !== outerRunner.sizeBytes) {
          reasonCodes.push("runner-final-sha-mismatch");
        }
      } catch {
        reasonCodes.push("runner-final-sha-mismatch");
      }
    } catch (error) {
      reasonCodes.push("stage-final-verification-failed");
      finalStage = {
        failure: redactedFailureDiagnostic(error, "stage-final-verification-failed", "staging"),
      };
    } finally {
      cleanup = (dependencies.cleanupStage ?? cleanupFixedAffinityStage)(stage.root);
      if (!cleanup.succeeded) reasonCodes.push("stage-cleanup-failed");
    }
  }
  const finalReasons = uniqueReasons(reasonCodes);
  const evidenceStatus = finalReasons.length === 0 ? "RESULT" : "NO_RESULT";
  const completedSamples = samples.filter((sample) => sample.ok);
  const baselineDurations = completedSamples.filter((sample) => sample.label === "baseline")
    .map((sample) => sample.record.durationMs);
  const candidateDurations = completedSamples.filter((sample) => sample.label === "candidate")
    .map((sample) => sample.record.durationMs);
  const profileGate = aggregateLocalDispatchProfileGate(evidenceStatus, samples, finalReasons);
  const status = evidenceStatus === "NO_RESULT"
    ? "NO_RESULT"
    : profileGate.status === "NO_GO"
      ? "NO_GO"
      : "RESULT";
  const baselineMedianMs = status === "RESULT" ? median(baselineDurations) : null;
  const candidateMedianMs = status === "RESULT" ? median(candidateDurations) : null;
  return {
    schemaVersion: 1,
    benchmark: "native-core-fixed-affinity-ab",
    claimBoundary: "fixed-affinity with private staged snapshots against non-malicious concurrent replacement; processor class is not attested as P-core; active same-user tampering is outside this evidence boundary",
    status,
    evidenceStatus,
    profileGate,
    performanceDecision: {
      status: "NOT_EVALUATED",
      reasonCode: "profile-eligibility-and-observed-timings-do-not-accept-a-product-candidate",
    },
    reasonCodes: status === "NO_GO" ? profileGate.reasonCodes : finalReasons,
    generatedAt: new Date(now()).toISOString(),
    durationMs: Math.max(0, now() - startedAt),
    host: {
      platform,
      arch: process.arch,
      node: process.version,
      cpu: os.cpus()[0]?.model ?? null,
      logicalProcessorCount,
      processorGroupPolicy: logicalProcessorCount <= 64 ? "single-group-required" : "unsupported",
    },
    configuration: {
      runs: options.runs,
      measuredSamples: schedule.length,
      affinity: options.affinity,
      threads: options.threads,
      nodePriority: options.nodePriority,
      nativePriority: options.nativePriority,
      profileEnabled: true,
      localDispatchProfileGate: {
        stageShareMinimumPpm: LOCAL_DISPATCH_STAGE_SHARE_MIN_PPM,
        requiredPlanetShards: 2,
        proxyCountsAsPerformanceBenefit: false,
        allMeasuredSamplesMustPass: true,
      },
      timeoutMs: options.timeoutMs,
      order: schedule.map((entry) => entry.label),
      stagingExcludedFromMeasuredDurations: true,
      fixtureSource: "pre-existing-persisted-read-only",
      childFixtureGeneration: false,
      childFixtureBinding: "exact-lowercase-sha256",
      executionBinding: "all samples launch only the staged Node, workload, JS/TS/Vitest closure, lockfile, and Host snapshots",
    },
    fixture: publicFixtureEvidence(fixture),
    binaries: stage ? {
      baseline: publicStagedBinary(stage.binaries.baseline, "baseline"),
      candidate: publicStagedBinary(stage.binaries.candidate, "candidate"),
    } : null,
    finalBinaries,
    staging: stage ? {
      identity: "private-stage",
      policy: "private-mkdtemp; exclusive create; fsync; all samples use staged paths; final digest verification; recursive cleanup",
      threatBoundary: "closes ordinary concurrent build/rename/overwrite drift; not a security boundary against an active same-user attacker",
      node: {
        source: publicFileIdentity(stage.node.source, "input/node-runtime"),
        staged: publicFileIdentity(stage.node.staged, "stage/node/node.exe"),
        immediateSource: publicFileIdentity(stage.node.immediateSource, "input/node-runtime/post-stage"),
        finalSource: publicFileIdentity(finalStage?.finalNode?.source, "input/node-runtime/final"),
        finalStaged: publicFileIdentity(finalStage?.finalNode?.staged, "stage/node/node.exe/final"),
      },
      outerRunner: {
        role: "already-loaded orchestration only; every timed child executes the staged workload and import closure",
        source: publicFileIdentity(outerRunner, "harness-source/scripts/fixed-affinity-runner"),
        staged: publicFileIdentity(stage.outerRunner?.staged, "stage/harness/scripts/fixed-affinity-runner"),
        manifestPath: stage.outerRunner?.manifestPath ?? null,
        finalSource: publicFileIdentity(finalOuterRunner, "harness-source/scripts/fixed-affinity-runner/final"),
      },
      harness: {
        source: publicHarnessManifest(stage.harness.source, "harness-source", status === "RESULT"),
        immediateSource: publicHarnessManifest(stage.harness.immediateSource, "harness-source/post-stage"),
        immediateStaged: publicHarnessManifest(stage.harness.immediateStaged, "stage/harness/post-stage"),
        finalSource: publicHarnessManifest(finalStage?.finalHarness?.source, "harness-source/final"),
        finalStaged: publicHarnessManifest(finalStage?.finalHarness?.staged, "stage/harness/final"),
      },
      durationMs: stagingDurationMs,
      cleanup: publicCleanupEvidence(cleanup),
    } : { error: stagingError, cleanup: publicCleanupEvidence(cleanup) },
    preflightExpected: publicFixedAffinityRecord(preflightEvaluation?.expected),
    preflight: preflight.map(publicSampleEvidence),
    samples: samples.map(publicSampleEvidence),
    summary: status === "RESULT" ? {
      baselineMedianMs,
      candidateMedianMs,
      candidateReductionPercent: baselineMedianMs && candidateMedianMs
        ? (1 - candidateMedianMs / baselineMedianMs) * 100
        : null,
      observedOnly: true,
      performanceDecisionApplied: false,
    } : null,
  };
}

function writeJsonNoOverwrite(outputPath, report) {
  const resolved = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  if (fs.existsSync(resolved)) throw new Error(`output already exists: ${resolved}`);
  const temporary = path.join(path.dirname(resolved), `.${path.basename(resolved)}.${process.pid}.${randomUUID()}.tmp`);
  let descriptor = null;
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.linkSync(temporary, resolved);
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
  }
}

function outputArgument(argv) {
  const index = argv.indexOf("--output");
  const value = index >= 0 ? argv[index + 1] : null;
  return value && path.isAbsolute(value) ? path.normalize(value) : null;
}

export function main(argv = process.argv.slice(2), dependencies = {}) {
  let options;
  const output = outputArgument(argv);
  const logger = dependencies.logger ?? console;
  try {
    options = parseFixedAffinityArgs(argv);
    if (options.help) {
      logger.log(usage());
      return 0;
    }
    if (fs.existsSync(options.output)) throw new Error(`output already exists: ${options.output}`);
    const report = runFixedAffinityAb(options, dependencies);
    (dependencies.writeReport ?? writeJsonNoOverwrite)(options.output, report);
    logger.log(JSON.stringify({ output: options.output, status: report.status, reasonCodes: report.reasonCodes }, null, 2));
    return report.status === "RESULT" ? 0 : 1;
  } catch (error) {
    const failure = redactedFailureDiagnostic(error, "runner-error", "runner");
    logger.error(`fixed-affinity runner failed (${failure.code})`);
    if (output && !fs.existsSync(output)) {
      try {
        (dependencies.writeReport ?? writeJsonNoOverwrite)(output, {
          schemaVersion: 1,
          benchmark: "native-core-fixed-affinity-ab",
          claimBoundary: "fixed-affinity; processor class is not attested as P-core; no claim against active same-user tampering",
          status: "NO_RESULT",
          evidenceStatus: "NO_RESULT",
          profileGate: {
            status: "NO_RESULT",
            thresholdPpm: LOCAL_DISPATCH_STAGE_SHARE_MIN_PPM,
            reasonCodes: ["runner-error"],
          },
          performanceDecision: {
            status: "NOT_EVALUATED",
            reasonCode: "runner-did-not-produce-valid-performance-evidence",
          },
          reasonCodes: ["runner-error"],
          generatedAt: new Date().toISOString(),
          failure,
        });
      } catch (reportError) {
        logger.error(`unable to persist NO_RESULT report: ${String(reportError?.message ?? reportError)}`);
      }
    }
    logger.error(usage());
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === SCRIPT_PATH.toLowerCase()) {
  process.exitCode = main();
}
