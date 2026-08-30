import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { afterAll, describe, expect, it } from "vitest";
import { buildChunkedSaveJournal } from "./chunkedSaveJournal";
import { createContentPackRegistry, createContentPackRuntimeSnapshot } from "./contentPacks";
import { createNativeCoreCatalog } from "./nativeCoreCatalog";
import { advanceSimulationBudget, createSimulationLookupContext, createSimulationProfiler, getEntityOperatingStatus } from "./engine";
import {
  advanceExactSimulationForConservationDiagnostic,
  captureAggregateConservationBaseline,
} from "./offlineApproximation";
import { migrateGame } from "./storage";
import type { GameState } from "./types";

const runBenchmark = process.env.DSP_RUN_NATIVE_CORE_BENCHMARK === "1";
const benchmarkOpenOnly = process.env.DSP_NATIVE_CORE_BENCHMARK_OPEN_ONLY === "1";
const benchmarkExactOnly = process.env.DSP_NATIVE_CORE_BENCHMARK_EXACT_ONLY === "1";
const benchmarkProfileEquivalence = process.env.DSP_NATIVE_CORE_BENCHMARK_PROFILE_EQUIVALENCE === "1";
const benchmarkExactSeconds = Number(process.env.DSP_NATIVE_CORE_BENCHMARK_EXACT_SECONDS ?? "1");
if (![1, 5, 60].includes(benchmarkExactSeconds)) {
  throw new Error("DSP_NATIVE_CORE_BENCHMARK_EXACT_SECONDS must be 1, 5, or 60");
}
const fixturePath = process.env.DSP_NATIVE_CORE_FIXTURE ||
  "C:\\Users\\WINDOWS\\Downloads\\dsp-idle-save-2026-08-24 (1).json\\dsp-idle-save-2026-08-24 (1).json";
const require = createRequire(import.meta.url);
const { NativeHostClient, NativeSaveSessionRegistry } = require("../../desktop/native-host.cjs") as {
  NativeHostClient: new (options: { binaryPath: string; rootPath: string; requestTimeoutMs: number }) => {
    child?: { pid?: number };
    stderrTail?: string;
    start(version: string): Promise<{ capabilities: string[] }>;
    request(request: Record<string, unknown>): Promise<any>;
    stop(): Promise<void>;
  };
  NativeSaveSessionRegistry: new (client: any) => {
    begin(owner: number, request: Record<string, unknown>): Promise<{ transactionId: string }>;
    write(owner: number, transactionId: string, records: Array<{ key: string; value: string | null }>): Promise<void>;
    commit(owner: number, transactionId: string): Promise<any>;
  };
};

interface Envelope {
  formatVersion: number;
  mode: "normal" | "speedrun";
  checksum: string;
  state: GameState;
}

function stableCanonicalSha256(value: unknown): string {
  value = JSON.parse(JSON.stringify(value));
  const crypto = require("node:crypto") as typeof import("node:crypto");
  const hash = crypto.createHash("sha256");
  const visit = (current: unknown) => {
    if (current === null || typeof current !== "object") {
      hash.update(JSON.stringify(current));
      return;
    }
    if (Array.isArray(current)) {
      hash.update("[");
      current.forEach((entry, index) => {
        if (index > 0) hash.update(",");
        visit(entry);
      });
      hash.update("]");
      return;
    }
    hash.update("{");
    const record = current as Record<string, unknown>;
    Object.keys(record).sort().forEach((key, index) => {
      if (index > 0) hash.update(",");
      hash.update(JSON.stringify(key));
      hash.update(":");
      visit(record[key]);
    });
    hash.update("}");
  };
  visit(value);
  return hash.digest("hex");
}

function aggregateConservationSummary(state: GameState) {
  const captured = captureAggregateConservationBaseline(state);
  const orderedEntries = (values: Map<string, bigint>) => [...values.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([itemId, amount]) => [itemId, amount.toString()]);
  const material = {
    totals: orderedEntries(captured.totals),
    totalProduced: orderedEntries(captured.totalProduced),
    knownConsumed: orderedEntries(captured.knownConsumed),
    knownGranted: orderedEntries(captured.knownGranted),
    constructionOutputs: orderedEntries(captured.constructionOutputs),
    constructionCrafted: captured.constructionCrafted.toString(),
    failure: captured.failure ?? null,
  };
  return {
    sha256: stableCanonicalSha256(material),
    captureFailure: captured.failure ?? null,
    itemCounts: {
      totals: captured.totals.size,
      totalProduced: captured.totalProduced.size,
      knownConsumed: captured.knownConsumed.size,
      knownGranted: captured.knownGranted.size,
      constructionOutputs: captured.constructionOutputs.size,
    },
  };
}

function lastNativeProfileValue(stderr: string | undefined, label: string): number | null {
  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const values = [...String(stderr ?? "").matchAll(
    new RegExp(`DSP_NATIVE_CORE_PROFILE\\t${escapedLabel}\\t([^\\r\\n]+)`, "g"),
  )].map((match) => Number(match[1].trim())).filter(Number.isFinite);
  return values.length > 0 ? values[values.length - 1] : null;
}

function privateBytes(pid: number | undefined): number | null {
  if (!Number.isSafeInteger(pid) || !pid) return null;
  try {
    const output = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${pid}).PrivateMemorySize64`], { encoding: "utf8" }).trim();
    const value = Number(output);
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

interface PrivatePeakSample {
  phase: "open" | "exact-advance" | "exact-burst-3x1";
  pid: number | null;
  samplerPid: number | null;
  intervalMs: number;
  baselineBytes: number | null;
  finalBytes: number | null;
  peakBytes: number | null;
  sampleCount: number;
  readErrors: number;
  lastReadSucceeded: boolean;
  intervalSampleCount: number;
  intervalMinMs: number | null;
  intervalMeanMs: number | null;
  intervalP50Ms: number | null;
  intervalP95Ms: number | null;
  intervalMaxMs: number | null;
  samplingCadenceValid: boolean;
  error: string | null;
}

async function startPrivatePeakSampler(
  pid: number | undefined,
  phase: PrivatePeakSample["phase"],
  intervalMs = 50,
): Promise<{ stop: () => Promise<PrivatePeakSample> }> {
  const baselineBytes = privateBytes(pid);
  if (process.platform !== "win32" || !Number.isSafeInteger(pid) || !pid) {
    return {
      stop: async () => ({
        phase,
        pid: Number.isSafeInteger(pid) && pid ? pid : null,
        samplerPid: null,
        intervalMs,
        baselineBytes,
        finalBytes: baselineBytes,
        peakBytes: baselineBytes,
        sampleCount: baselineBytes === null ? 0 : 1,
        readErrors: baselineBytes === null ? 1 : 0,
        lastReadSucceeded: baselineBytes !== null,
        intervalSampleCount: 0,
        intervalMinMs: null,
        intervalMeanMs: null,
        intervalP50Ms: null,
        intervalP95Ms: null,
        intervalMaxMs: null,
        samplingCadenceValid: false,
        error: process.platform === "win32" ? "native-host-pid-unavailable" : "windows-only",
      }),
    };
  }

  const stopPath = path.join(os.tmpdir(), `dsp-native-private-peak-${process.pid}-${pid}-${crypto.randomUUID()}.stop`);
  const quotedStopPath = stopPath.replaceAll("'", "''");
  const script = [
    "$ErrorActionPreference='Stop'",
    `$targetPid=${pid}`,
    `$stopPath='${quotedStopPath}'`,
    `$intervalMs=${intervalMs}`,
    "$samplerProcess=[System.Diagnostics.Process]::GetCurrentProcess()",
    "try { $samplerProcess.PriorityClass=[System.Diagnostics.ProcessPriorityClass]::High } catch { }",
    "$targetProcess=[System.Diagnostics.Process]::GetProcessById($targetPid)",
    "$peak=0L",
    "$samples=0L",
    "$readErrors=0L",
    "$lastReadSucceeded=$false",
    "$lastSampleAt=0L",
    "$clockFrequency=[double][System.Diagnostics.Stopwatch]::Frequency",
    "$intervals=[System.Collections.Generic.List[long]]::new()",
    "$sample={ param([bool]$recordInterval); $sampleAt=[System.Diagnostics.Stopwatch]::GetTimestamp(); if ($recordInterval -and $lastSampleAt -gt 0) { $elapsedMs=[long][Math]::Round((($sampleAt-$lastSampleAt)*1000.0)/$clockFrequency); [void]$intervals.Add($elapsedMs) }; $lastSampleAt=$sampleAt; try { $targetProcess.Refresh(); $value=$targetProcess.PrivateMemorySize64; if ($value -gt $peak) { $peak=$value }; $samples++; $lastReadSucceeded=$true } catch { $readErrors++; $lastReadSucceeded=$false } }",
    ". $sample $false",
    "[Console]::Out.WriteLine('READY')",
    "[Console]::Out.Flush()",
    "while (-not [System.IO.File]::Exists($stopPath)) { [System.Threading.Thread]::Sleep($intervalMs); . $sample $true }",
    ". $sample $false",
    "$sorted=@($intervals | Sort-Object)",
    "$intervalCount=$sorted.Count",
    "$intervalMin=if ($intervalCount -gt 0) { [long]$sorted[0] } else { 0L }",
    "$intervalMax=if ($intervalCount -gt 0) { [long]$sorted[$intervalCount-1] } else { 0L }",
    "$intervalMean=if ($intervalCount -gt 0) { [long][Math]::Round((($sorted | Measure-Object -Sum).Sum)/$intervalCount) } else { 0L }",
    "$p50Index=[int][Math]::Max(0,[Math]::Ceiling($intervalCount*0.50)-1)",
    "$p95Index=[int][Math]::Max(0,[Math]::Ceiling($intervalCount*0.95)-1)",
    "$intervalP50=if ($intervalCount -gt 0) { [long]$sorted[$p50Index] } else { 0L }",
    "$intervalP95=if ($intervalCount -gt 0) { [long]$sorted[$p95Index] } else { 0L }",
    "[Console]::Out.WriteLine((\"RESULT`t{0}`t{1}`t{2}`t{3}`t{4}`t{5}`t{6}`t{7}`t{8}`t{9}\" -f $peak,$samples,$readErrors,$lastReadSucceeded,$intervalCount,$intervalMin,$intervalMean,$intervalP50,$intervalP95,$intervalMax))",
    "[Console]::Out.Flush()",
  ].join("; ");
  const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  let stopped = false;
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  const closePromise = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("private peak sampler did not become ready within 10 seconds")), 10_000);
    const inspect = () => {
      if (!stdout.includes("READY")) return;
      clearTimeout(timeout);
      child.stdout.off("data", inspect);
      resolve();
    };
    child.stdout.on("data", inspect);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      if (stdout.includes("READY")) return;
      clearTimeout(timeout);
      reject(new Error(`private peak sampler exited before ready (${code}): ${stderr.trim()}`));
    });
    inspect();
  }).catch((error) => {
    if (!child.killed) child.kill();
    fs.rmSync(stopPath, { force: true });
    void closePromise.catch(() => undefined);
    throw error;
  });

  return {
    stop: async () => {
      if (stopped) throw new Error("private peak sampler was stopped twice");
      stopped = true;
      let closed = false;
      try {
        fs.writeFileSync(stopPath, "stop", { encoding: "utf8", flag: "wx" });
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const exitCode = await Promise.race([
          closePromise,
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => reject(new Error("private peak sampler did not stop within 10 seconds")), 10_000);
          }),
        ]).finally(() => {
          if (timeout) clearTimeout(timeout);
        });
        closed = true;
        const match = stdout.match(/RESULT\t(\d+)\t(\d+)\t(\d+)\t(True|False)\t(\d+)\t(\d+)\t(\d+)\t(\d+)\t(\d+)\t(\d+)/i);
        const peakBytes = match ? Number(match[1]) : null;
        const sampleCount = match ? Number(match[2]) : 0;
        const readErrors = match ? Number(match[3]) : 0;
        const lastReadSucceeded = match?.[4]?.toLowerCase() === "true";
        const intervalSampleCount = match ? Number(match[5]) : 0;
        const intervalMinMs = match ? Number(match[6]) : null;
        const intervalMeanMs = match ? Number(match[7]) : null;
        const intervalP50Ms = match ? Number(match[8]) : null;
        const intervalP95Ms = match ? Number(match[9]) : null;
        const intervalMaxMs = match ? Number(match[10]) : null;
        const samplingCadenceValid = intervalSampleCount >= 1
          && intervalP95Ms !== null && intervalP95Ms <= intervalMs * 2
          && intervalMaxMs !== null && intervalMaxMs <= intervalMs * 5;
        const samplerFailures = [
          exitCode === 0 ? null : `exit=${exitCode}`,
          peakBytes !== null && sampleCount > 0 ? null : "missing-result",
          readErrors === 0 ? null : `read-errors=${readErrors}`,
          lastReadSucceeded ? null : "final-read-failed",
          samplingCadenceValid ? null : `cadence-invalid(p95=${intervalP95Ms},max=${intervalMaxMs},target=${intervalMs})`,
          stderr.trim() || null,
        ].filter((value): value is string => Boolean(value));
        const error = samplerFailures.length === 0 ? null : samplerFailures.join("; ");
        return {
          phase,
          pid,
          samplerPid: Number.isSafeInteger(child.pid) ? child.pid ?? null : null,
          intervalMs,
          baselineBytes,
          finalBytes: privateBytes(pid),
          peakBytes,
          sampleCount,
          readErrors,
          lastReadSucceeded,
          intervalSampleCount,
          intervalMinMs,
          intervalMeanMs,
          intervalP50Ms,
          intervalP95Ms,
          intervalMaxMs,
          samplingCadenceValid,
          error,
        };
      } finally {
        fs.rmSync(stopPath, { force: true });
        if (!closed && child.exitCode === null && !child.killed) {
          child.kill();
          await Promise.race([
            closePromise.catch(() => null),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), 2_000)),
          ]);
        }
      }
    },
  };
}

function firstDifferences(left: unknown, right: unknown, limit = 40): Array<{ path: string; native: unknown; js: unknown }> {
  const differences: Array<{ path: string; native: unknown; js: unknown }> = [];
  const visit = (native: unknown, js: unknown, path: string) => {
    if (differences.length >= limit) return;
    if (Object.is(native, js)) return;
    if (native === null || js === null || typeof native !== "object" || typeof js !== "object") {
      differences.push({ path, native, js });
      return;
    }
    if (Array.isArray(native) || Array.isArray(js)) {
      if (!Array.isArray(native) || !Array.isArray(js)) {
        differences.push({ path, native, js });
        return;
      }
      if (native.length !== js.length) differences.push({ path: `${path}.length`, native: native.length, js: js.length });
      for (let index = 0; index < Math.min(native.length, js.length) && differences.length < limit; index += 1) {
        visit(native[index], js[index], `${path}[${index}]`);
      }
      return;
    }
    const nativeRecord = native as Record<string, unknown>;
    const jsRecord = js as Record<string, unknown>;
    for (const key of [...new Set([...Object.keys(nativeRecord), ...Object.keys(jsRecord)])].sort()) {
      visit(nativeRecord[key], jsRecord[key], path ? `${path}.${key}` : key);
      if (differences.length >= limit) break;
    }
  };
  visit(JSON.parse(JSON.stringify(left)), JSON.parse(JSON.stringify(right)), "");
  return differences;
}

function logBenchmarkRecord(label: string, value: Record<string, unknown>): void {
  console.log(JSON.stringify(value, null, 2));
  // The compact line is consumed by the interleaved A/B harness. Keeping the
  // human-readable block above makes one-off diagnosis pleasant while this
  // stable prefix avoids scraping Vitest formatting or nested pretty JSON.
  console.log(`DSP_NATIVE_CORE_BENCHMARK\t${label}\t${JSON.stringify(value)}`);
}

describe.skipIf(!runBenchmark)("real-save Windows native core benchmark", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsp-native-core-benchmark-"));
  const binaryPath = process.env.DSP_NATIVE_CORE_HOST_BINARY
    ? path.resolve(process.env.DSP_NATIVE_CORE_HOST_BINARY)
    : path.resolve("native", "target", "release", process.platform === "win32" ? "dsp-native-host.exe" : "dsp-native-host");
  const client = new NativeHostClient({ binaryPath, rootPath: root, requestTimeoutMs: 300_000 });
  afterAll(async () => {
    await client.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("loads the 80k entity / 155k belt fixture with exact v47 hash and bounded native memory", { timeout: 600_000 }, async () => {
    expect(fs.existsSync(fixturePath)).toBe(true);
    expect(fs.existsSync(binaryPath)).toBe(true);
    const hostBinaryBytes = (require("node:fs") as { readFileSync(path: string): Uint8Array })
      .readFileSync(binaryPath);
    const hostBinarySha256 = (require("node:crypto") as typeof import("node:crypto"))
      .createHash("sha256")
      .update(hostBinaryBytes)
      .digest("hex");
    const sourceBytes = fs.statSync(fixturePath).size;
    const envelope = JSON.parse(fs.readFileSync(fixturePath, "utf8")) as Envelope;
    expect(envelope.formatVersion).toBe(2);
    expect(envelope.state.version).toBe(47);
    const registry = createContentPackRegistry();
    const state = migrateGame(envelope.state, registry);
    expect(state).not.toBeNull();
    // Match the exact representation persisted by the browser save path:
    // JSON serialization removes migration-only `undefined` properties.
    const migratedState = JSON.parse(JSON.stringify(state!)) as GameState;
    const runtime = createContentPackRuntimeSnapshot(registry);
    const journal = buildChunkedSaveJournal(migratedState, {
      mode: envelope.mode,
      basePrimaryChecksum: envelope.checksum,
      savedAt: 1,
      retainAllChunks: true,
    });
    const prefix = `dsp-idle-network.internal.v1.chunked.v1.${envelope.mode}.`;
    const records = [
      ...[...journal.chunks.entries()].map(([id, value]) => ({ key: `${prefix}chunk.${encodeURIComponent(id)}`, value })),
      { key: `${prefix}manifest`, value: JSON.stringify(journal.manifest) },
    ];
    const hello = await client.start("native-core-benchmark");
    expect(hello.capabilities).toContain("native-core-shadow-v1");
    const saves = new NativeSaveSessionRegistry(client);
    const transaction = await saves.begin(1, {
      slot: envelope.mode === "speedrun" ? "speedrun-main" : "normal-main",
      mode: envelope.mode,
      stateVersion: 47,
      baseChecksum: envelope.checksum,
      registryFingerprint: runtime.fingerprint,
      revision: 1,
      savedAtMs: 1,
    });
    // Runtime-migrated v47 saves can contain a few very large logical chunks.
    // Keep every control frame independently below the native host's fixed
    // 8 MiB IPC budget instead of assuming that eight chunks always fit.
    for (const record of records) {
      await saves.write(1, transaction.transactionId, [record]);
    }
    const commit = await saves.commit(1, transaction.transactionId);
    const beforePrivateBytes = privateBytes(client.child?.pid);
    const openPeakSampler = await startPrivatePeakSampler(client.child?.pid, "open");
    const openStartedAt = performance.now();
    let openFinishedAt = openStartedAt;
    let opened: any;
    let openPeakSample: PrivatePeakSample;
    try {
      opened = await client.request({
        operation: "coreOpen",
        slot: envelope.mode === "speedrun" ? "speedrun-main" : "normal-main",
        generation: commit.generation,
        rootHash: commit.rootHash,
        revision: commit.revision,
        registryFingerprint: runtime.fingerprint,
        catalog: createNativeCoreCatalog(runtime),
      });
      openFinishedAt = performance.now();
    } finally {
      openPeakSample = await openPeakSampler.stop();
    }
    const openDurationMs = openFinishedAt - openStartedAt;
    const afterPrivateBytes = privateBytes(client.child?.pid);
    const sourceSha256 = stableCanonicalSha256(migratedState);
    const { entities: sourceEntities, belts: sourceBelts, ...sourceBase } = migratedState;
    const sourceComponents = {
      base: stableCanonicalSha256(sourceBase),
      entities: stableCanonicalSha256(sourceEntities),
      belts: stableCanonicalSha256(sourceBelts),
    };
    expect(opened.summary.entityCount).toBe(migratedState.entities.length);
    expect(opened.summary.beltCount).toBe(migratedState.belts.length);
    expect(opened.summary.coverage.authorityEligible).toBe(false);
    logBenchmarkRecord("open", {
      fixture: { sourceBytes, entities: migratedState.entities.length, belts: migratedState.belts.length },
      nativeCore: {
        hostBinarySha256,
        openDurationMs: Number(openDurationMs.toFixed(2)),
        canonicalSha256: opened.summary.canonicalSha256,
        sourceSha256,
        canonicalComponents: opened.summary.canonicalComponents,
        sourceComponents,
        exactRoundTrip: opened.summary.canonicalSha256 === sourceSha256,
        estimatedRuntimeBytes: opened.summary.memory.estimatedRuntimeBytes,
        rawRecordBytes: opened.summary.memory.rawRecordBytes,
        indexedStringBytes: opened.summary.memory.indexedStringBytes,
        inventoryEntryCount: opened.summary.memory.inventoryEntryCount,
        topologyIndexBytes: opened.summary.memory.topologyIndexBytes,
        processPrivateBytesBeforeOpen: beforePrivateBytes,
        processPrivateBytesAfterOpen: afterPrivateBytes,
        processPrivateBytesDelta: beforePrivateBytes !== null && afterPrivateBytes !== null ? afterPrivateBytes - beforePrivateBytes : null,
        processPrivateBytesPeakDuringOpen: openPeakSample.peakBytes,
        processPrivateBytesPeakDeltaDuringOpen: openPeakSample.peakBytes !== null && openPeakSample.baselineBytes !== null
          ? openPeakSample.peakBytes - openPeakSample.baselineBytes
          : null,
        privatePeakSampler: openPeakSample,
      },
    });
    // Emit the complete immutable open evidence before enforcing the memory
    // budget so a regression report retains the component breakdown needed to
    // diagnose the excess without weakening the fail-closed gate.
    expect(opened.summary.memory.estimatedRuntimeBytes).toBeLessThan(sourceBytes * 3);
    expect(opened.summary.canonicalComponents).toEqual(sourceComponents);
    expect(opened.summary.canonicalSha256).toBe(sourceSha256);
    if (benchmarkOpenOnly) {
      await client.request({ operation: "coreClose", sessionId: opened.sessionId });
      return;
    }
    const commandPrivateBytesBefore = privateBytes(client.child?.pid);
    const commandStartedAt = performance.now();
    const resumed = await client.request({
      operation: "coreApplyCommand",
      sessionId: opened.sessionId,
      command: {
        protocolVersion: 1,
        baseRevision: commit.revision,
        topLevelChanges: [{ path: ["paused"], operation: "set", value: false }],
        changedEntities: [], addedEntities: [], removedEntityIds: [],
        changedBelts: [], addedBelts: [], removedBeltIds: [],
      },
    });
    const commandDurationMs = performance.now() - commandStartedAt;
    const commandPrivateBytesAfter = privateBytes(client.child?.pid);
    const exactPeakSampler = await startPrivatePeakSampler(client.child?.pid, "exact-advance");
    const coreAdvanceStartedAt = performance.now();
    let coreAdvanceFinishedAt = coreAdvanceStartedAt;
    let admission: any;
    let exactPeakSample: PrivatePeakSample;
    try {
      admission = await client.request({
        operation: "coreAdvance",
        sessionId: opened.sessionId,
        request: {
          baseRevision: resumed.revision,
          simulationSeconds: benchmarkExactSeconds,
          wallSeconds: benchmarkExactSeconds,
          includeDiagnostics: false,
        },
      });
      coreAdvanceFinishedAt = performance.now();
    } finally {
      exactPeakSample = await exactPeakSampler.stop();
    }
    const coreAdvanceDurationMs = coreAdvanceFinishedAt - coreAdvanceStartedAt;
    const diagnosticsStartedAt = performance.now();
    const advancedSummary = await client.request({
      operation: "coreStatus",
      sessionId: opened.sessionId,
    });
    const diagnosticsDurationMs = performance.now() - diagnosticsStartedAt;
    const cachedDiagnosticsStartedAt = performance.now();
    const cachedAdvancedSummary = await client.request({
      operation: "coreStatus",
      sessionId: opened.sessionId,
    });
    const cachedDiagnosticsDurationMs = performance.now() - cachedDiagnosticsStartedAt;
    expect(cachedAdvancedSummary).toEqual(advancedSummary);
    logBenchmarkRecord("admission", {
      nativeCoreAdmission: {
        supported: admission.supported,
        exactScope: admission.exactScope,
        reason: admission.reason ?? null,
        commandDurationMs: Number(commandDurationMs.toFixed(2)),
        commandPrivateBytesDelta: commandPrivateBytesBefore !== null && commandPrivateBytesAfter !== null
          ? commandPrivateBytesAfter - commandPrivateBytesBefore
          : null,
      },
    });
    if (admission.supported) {
      const expectedInitial = structuredClone(migratedState);
      expectedInitial.paused = false;
      const jsProfiler = createSimulationProfiler();
      const jsDiagnosticStartedAt = performance.now();
      const {
        state: expected,
        conservationFailure: conservationValidationFailure,
        exactAdvanceDurationMs: jsAdvanceDurationMs,
      } = advanceExactSimulationForConservationDiagnostic(
        expectedInitial,
        benchmarkExactSeconds,
        benchmarkExactSeconds,
        jsProfiler,
      );
      const jsAdvanceAndConservationDurationMs = performance.now() - jsDiagnosticStartedAt;
      const conservationSummary = aggregateConservationSummary(expected);
      const expectedFields = Object.fromEntries(Object.entries(JSON.parse(JSON.stringify(expected)) as Record<string, unknown>)
        .map(([key, value]) => [key, stableCanonicalSha256(value)]));
      const fieldMismatches = Object.keys(expectedFields).filter((key) =>
        advancedSummary.canonicalFields?.[key] !== expectedFields[key]);
      const mismatchProjection = fieldMismatches.length > 0
        ? await client.request({
          operation: "coreProjection",
          sessionId: opened.sessionId,
          entityIds: [], beltIds: [], baseFields: fieldMismatches,
        })
        : { base: {} };
      const mismatchDetails = fieldMismatches.flatMap((key) => firstDifferences(
        mismatchProjection.base?.[key],
        (expected as unknown as Record<string, unknown>)[key],
        20,
      ).map((difference) => ({ ...difference, path: `${key}${difference.path ? `.${difference.path}` : ""}` }))).slice(0, 40);
      const blockedMachineGroups = fieldMismatches.includes("productionHistory")
        ? (() => {
          const lookup = createSimulationLookupContext(expected);
          const groups = new Map<string, { units: number; blocked: number }>();
          for (const entity of expected.entities) {
            if (entity.kind !== "machine" && !(entity.kind === "vein" && entity.minerCount > 0)) continue;
            const key = `${entity.kind}:${entity.buildingId ?? entity.resourceId ?? "unknown"}:${entity.recipeId ?? "none"}`;
            const units = entity.kind === "vein" ? entity.minerCount : entity.machineCount;
            const group = groups.get(key) ?? { units: 0, blocked: 0 };
            group.units += units;
            if (getEntityOperatingStatus(expected, entity, lookup).tone === "blocked") group.blocked += units;
            groups.set(key, group);
          }
          return [...groups].map(([key, value]) => ({ key, ...value }))
            .filter((group) => group.blocked > 0)
            .sort((left, right) => right.blocked - left.blocked)
            .slice(0, 30);
        })()
        : [];
      logBenchmarkRecord("exact", {
        nativeCoreExactRealSaveAdvance: {
          exactState: advancedSummary.canonicalSha256 === stableCanonicalSha256(expected),
          simulationSeconds: benchmarkExactSeconds,
          revision: advancedSummary.revision,
          expectedRevision: resumed.revision + 1,
          canonicalSha256: advancedSummary.canonicalSha256,
          expectedCanonicalSha256: stableCanonicalSha256(expected),
          domainSha256: advancedSummary.domainSha256,
          canonicalComponents: advancedSummary.canonicalComponents,
          conservationSummarySha256: conservationSummary.sha256,
          conservationCaptureFailure: conservationSummary.captureFailure,
          conservationValidationFailure,
          conservationItemCounts: conservationSummary.itemCounts,
          requestedThreadSetting: process.env.DSP_NATIVE_CORE_THREADS ?? null,
          effectiveWorkerLimit: lastNativeProfileValue(client.stderrTail, "runtime-worker-limit"),
          observedWorkerCount: lastNativeProfileValue(client.stderrTail, "runtime-observed-workers"),
          fieldMismatches,
          mismatchDetails,
          blockedMachineGroups,
          nativeAdvanceDurationMs: Number(coreAdvanceDurationMs.toFixed(2)),
          jsAdvanceDurationMs: Number(jsAdvanceDurationMs.toFixed(2)),
          jsAdvanceAndConservationDurationMs: Number(jsAdvanceAndConservationDurationMs.toFixed(2)),
          nativeToJsRatio: Number((coreAdvanceDurationMs / jsAdvanceDurationMs).toFixed(3)),
          processPrivateBytesPeakDuringAdvance: exactPeakSample.peakBytes,
          processPrivateBytesPeakDeltaDuringAdvance: exactPeakSample.peakBytes !== null && exactPeakSample.baselineBytes !== null
            ? exactPeakSample.peakBytes - exactPeakSample.baselineBytes
            : null,
          privatePeakSampler: exactPeakSample,
          deferredDiagnosticsDurationMs: Number(diagnosticsDurationMs.toFixed(2)),
          cachedDiagnosticsDurationMs: Number(cachedDiagnosticsDurationMs.toFixed(2)),
          nativeBeltScheduler: admission.beltScheduler ?? null,
          javascriptBeltScheduler: {
            routeChecks: jsProfiler.beltRouteChecks,
            stableRoutesSkipped: jsProfiler.beltStableRoutesSkipped,
          },
        },
      });
      if (client.stderrTail?.trim()) console.log(client.stderrTail.trim());
      if (!benchmarkProfileEquivalence) {
        expect(advancedSummary.canonicalFields).toEqual(expectedFields);
      }
      expect(advancedSummary.revision).toBe(resumed.revision + 1);
      expect(conservationSummary.captureFailure).toBeNull();
      expect(conservationValidationFailure).toBeNull();
      if (!benchmarkProfileEquivalence) {
        expect(advancedSummary.canonicalSha256).toBe(stableCanonicalSha256(expected));
      }
      if (benchmarkExactOnly) {
        await client.request({ operation: "coreClose", sessionId: opened.sessionId });
        return;
      }
      const integratedDiagnosticsStartedAt = performance.now();
      const integratedDiagnostics = await client.request({
        operation: "coreAdvance",
        sessionId: opened.sessionId,
        request: {
          baseRevision: admission.revision,
          simulationSeconds: 1,
          wallSeconds: 1,
          includeDiagnostics: true,
        },
      });
      const integratedDiagnosticsDurationMs = performance.now() - integratedDiagnosticsStartedAt;
      const expectedSecond = advanceSimulationBudget(expected, 1, 1);
      const integratedCachedStartedAt = performance.now();
      const integratedCached = await client.request({ operation: "coreStatus", sessionId: opened.sessionId });
      const integratedCachedDurationMs = performance.now() - integratedCachedStartedAt;
      logBenchmarkRecord("integrated", {
        nativeCoreIntegratedDiagnostics: {
          exactState: integratedDiagnostics.summary?.canonicalSha256 === stableCanonicalSha256(expectedSecond),
          advanceAndProofDurationMs: Number(integratedDiagnosticsDurationMs.toFixed(2)),
          previousAdvanceThenProofDurationMs: Number((coreAdvanceDurationMs + diagnosticsDurationMs).toFixed(2)),
          cachedStatusDurationMs: Number(integratedCachedDurationMs.toFixed(2)),
        },
      });
      expect(integratedDiagnostics.summary?.canonicalSha256).toBe(stableCanonicalSha256(expectedSecond));
      expect(integratedCached).toEqual(integratedDiagnostics.summary);
      // The previous two advances intentionally exercise the non-durable
      // shadow endpoint. Authority WAL cannot start at that later in-memory
      // revision because it must continue the durable checkpoint exactly.
      // Reopen the immutable revision-1 checkpoint and make the resume command
      // plus first exact second one durable operation instead.
      await client.request({ operation: "coreClose", sessionId: opened.sessionId });
      opened = await client.request({
        operation: "coreOpen",
        slot: envelope.mode === "speedrun" ? "speedrun-main" : "normal-main",
        generation: commit.generation,
        rootHash: commit.rootHash,
        revision: commit.revision,
        registryFingerprint: runtime.fingerprint,
        catalog: createNativeCoreCatalog(runtime),
      });
      const durablePrivateBytesBefore = privateBytes(client.child?.pid);
      const durableStartedAt = performance.now();
      const durable = await client.request({
        operation: "coreCommitOperation",
        sessionId: opened.sessionId,
        request: {
          commandId: "native-core-real-save-benchmark-durable",
          baseRevision: commit.revision,
          command: {
            protocolVersion: 1,
            baseRevision: commit.revision,
            topLevelChanges: [{ path: ["paused"], operation: "set", value: false }],
            changedEntities: [], addedEntities: [], removedEntityIds: [],
            changedBelts: [], addedBelts: [], removedBeltIds: [],
          },
          simulationSeconds: 1,
          wallSeconds: 1,
          includeDiagnostics: true,
        },
      });
      const durableDurationMs = performance.now() - durableStartedAt;
      const durablePrivateBytesAfter = privateBytes(client.child?.pid);
      const expectedDurable = expected;
      const durableRetryStartedAt = performance.now();
      const durableRetry = await client.request({
        operation: "coreCommitOperation",
        sessionId: opened.sessionId,
        request: {
          commandId: "native-core-real-save-benchmark-durable",
          baseRevision: commit.revision,
          command: {
            protocolVersion: 1,
            baseRevision: commit.revision,
            topLevelChanges: [{ path: ["paused"], operation: "set", value: false }],
            changedEntities: [], addedEntities: [], removedEntityIds: [],
            changedBelts: [], addedBelts: [], removedBeltIds: [],
          },
          simulationSeconds: 1,
          wallSeconds: 1,
          includeDiagnostics: false,
        },
      });
      const durableRetryDurationMs = performance.now() - durableRetryStartedAt;
      const checkpointStartedAt = performance.now();
      const checkpoint = await client.request({
        operation: "coreCheckpoint",
        sessionId: opened.sessionId,
        savedAtMs: 2,
      });
      const checkpointDurationMs = performance.now() - checkpointStartedAt;
      logBenchmarkRecord("durable", {
        nativeCoreDurableAuthority: {
          exactState: durable.summary?.canonicalSha256 === stableCanonicalSha256(expectedDurable),
          durationMs: Number(durableDurationMs.toFixed(2)),
          privateBytesDelta: durablePrivateBytesBefore !== null && durablePrivateBytesAfter !== null
            ? durablePrivateBytesAfter - durablePrivateBytesBefore
            : null,
          duplicateRetry: durableRetry.duplicate === true,
          duplicateRetryDurationMs: Number(durableRetryDurationMs.toFixed(2)),
          walBytes: durable.walBytes ?? null,
        },
      });
      logBenchmarkRecord("checkpoint", {
        nativeCoreIncrementalCheckpoint: {
          exactState: checkpoint.summary?.canonicalSha256 === stableCanonicalSha256(expectedDurable),
          durationMs: Number(checkpointDurationMs.toFixed(2)),
          changedRecords: checkpoint.checkpoint?.changedRecords ?? null,
          changedBytes: checkpoint.checkpoint?.changedBytes ?? null,
          encodedRecords: checkpoint.encodedRecords ?? null,
          reusedRecords: checkpoint.reusedRecords ?? null,
        },
      });
      expect(durable.duplicate).toBe(false);
      expect(durable.summary?.canonicalSha256).toBe(stableCanonicalSha256(expectedDurable));
      expect(durableRetry.duplicate).toBe(true);
      expect(durableRetry.revision).toBe(durable.revision);
      expect(checkpoint.summary?.canonicalSha256).toBe(stableCanonicalSha256(expectedDurable));

      // A single operation followed by JavaScript oracle work gives the
      // deferred Rust record reclaimer ample time to finish. Measure a real
      // back-to-back burst separately so a second transient Value graph cannot
      // hide behind the one-step peak number.
      const burstPeakSampler = await startPrivatePeakSampler(client.child?.pid, "exact-burst-3x1");
      const burstStartedAt = performance.now();
      let burstFinishedAt = burstStartedAt;
      let burstRevision = durable.revision;
      const burstStepDurationsMs: number[] = [];
      let burstPeakSample: PrivatePeakSample;
      try {
        for (let step = 0; step < 3; step += 1) {
          const stepStartedAt = performance.now();
          const advanced = await client.request({
            operation: "coreAdvance",
            sessionId: opened.sessionId,
            request: {
              baseRevision: burstRevision,
              simulationSeconds: 1,
              wallSeconds: 1,
              includeDiagnostics: false,
            },
          });
          if (advanced.supported !== true || advanced.revision !== burstRevision + 1) {
            throw new Error(`native burst step ${step + 1} was not an exact contiguous advance`);
          }
          burstRevision = advanced.revision;
          burstStepDurationsMs.push(Number((performance.now() - stepStartedAt).toFixed(2)));
        }
        burstFinishedAt = performance.now();
      } finally {
        burstPeakSample = await burstPeakSampler.stop();
      }
      let expectedBurst = expectedDurable;
      for (let step = 0; step < 3; step += 1) expectedBurst = advanceSimulationBudget(expectedBurst, 1, 1);
      const burstSummary = await client.request({ operation: "coreStatus", sessionId: opened.sessionId });
      logBenchmarkRecord("burst", {
        nativeCoreExactBurst: {
          exactState: burstSummary.canonicalSha256 === stableCanonicalSha256(expectedBurst),
          canonicalSha256: burstSummary.canonicalSha256,
          expectedCanonicalSha256: stableCanonicalSha256(expectedBurst),
          canonicalComponents: burstSummary.canonicalComponents,
          steps: 3,
          durationMs: Number((burstFinishedAt - burstStartedAt).toFixed(2)),
          stepDurationsMs: burstStepDurationsMs,
          processPrivateBytesPeakDuringBurst: burstPeakSample.peakBytes,
          processPrivateBytesPeakDeltaDuringBurst: burstPeakSample.peakBytes !== null && burstPeakSample.baselineBytes !== null
            ? burstPeakSample.peakBytes - burstPeakSample.baselineBytes
            : null,
          processPrivateBytesPeakAcrossMeasuredPhases: [
            openPeakSample.peakBytes,
            exactPeakSample.peakBytes,
            burstPeakSample.peakBytes,
          ].filter((value): value is number => value !== null).reduce((peak, value) => Math.max(peak, value), 0),
          privatePeakSampler: burstPeakSample,
        },
      });
      expect(burstSummary.canonicalSha256).toBe(stableCanonicalSha256(expectedBurst));
    }
    if (!admission.supported && String(admission.reason ?? "").startsWith("construction-")) {
      const constructionMasked = await client.request({
        operation: "coreApplyCommand",
        sessionId: opened.sessionId,
        command: {
          protocolVersion: 1,
          baseRevision: resumed.revision,
          topLevelChanges: [{
            path: ["constructionAutomation"],
            operation: "set",
            value: {
              ...migratedState.constructionAutomation,
              enabled: false,
              targetStock: {},
              jobs: {},
            },
          }],
          changedEntities: [], addedEntities: [], removedEntityIds: [],
          changedBelts: [], addedBelts: [], removedBeltIds: [],
        },
      });
      let reportedProfile = "";
      const profileTimer = setInterval(() => {
        const current = client.stderrTail?.trim() ?? "";
        if (current && current !== reportedProfile) {
          reportedProfile = current;
          console.log(current);
        }
      }, 5_000);
      const nextDomain = await client.request({
        operation: "coreAdvance",
        sessionId: opened.sessionId,
        request: { baseRevision: constructionMasked.revision, simulationSeconds: 1, wallSeconds: 1 },
      }).finally(() => clearInterval(profileTimer));
      const expectedDiagnosticInitial = structuredClone(migratedState);
      expectedDiagnosticInitial.paused = false;
      expectedDiagnosticInitial.constructionAutomation = {
        ...expectedDiagnosticInitial.constructionAutomation,
        enabled: false,
        targetStock: {},
        jobs: {},
      };
      const expectedDiagnostic = advanceSimulationBudget(expectedDiagnosticInitial, 1, 1);
      const expectedDiagnosticFields = Object.fromEntries(Object.entries(JSON.parse(JSON.stringify(expectedDiagnostic)) as Record<string, unknown>)
        .map(([key, value]) => [key, stableCanonicalSha256(value)]));
      const fieldMismatches = Object.keys(expectedDiagnosticFields).filter((key) =>
        nextDomain.summary.canonicalFields?.[key] !== expectedDiagnosticFields[key]);
      const baseProjection = await client.request({
        operation: "coreProjection",
        sessionId: opened.sessionId,
        entityIds: [], beltIds: [],
        baseFields: ["constructionAutomation", "productionHistory", "endgame", "dysonSwarm", "planetMetrics"],
      });
      const detailDifferences = firstDifferences(baseProjection.base, {
        constructionAutomation: expectedDiagnostic.constructionAutomation,
        productionHistory: expectedDiagnostic.productionHistory,
        endgame: expectedDiagnostic.endgame,
        dysonSwarm: expectedDiagnostic.dysonSwarm,
        planetMetrics: expectedDiagnostic.planetMetrics,
      });
      const entityDifferences: ReturnType<typeof firstDifferences> = [];
      for (let offset = 0; offset < expectedDiagnostic.entities.length && entityDifferences.length < 40; offset += 32) {
        const expectedEntities = expectedDiagnostic.entities.slice(offset, offset + 32);
        const projection = await client.request({
          operation: "coreProjection",
          sessionId: opened.sessionId,
          entityIds: expectedEntities.map((entity) => entity.id),
          beltIds: [], baseFields: [],
        });
        entityDifferences.push(...firstDifferences(projection.entities, expectedEntities, 40 - entityDifferences.length)
          .map((difference) => ({ ...difference, path: `entities[${offset}]${difference.path ? `.${difference.path}` : ""}` })));
      }
      logBenchmarkRecord("construction-mask", {
        nativeCoreDiagnosticAfterConstructionMask: {
          supported: nextDomain.supported,
          exactScope: nextDomain.exactScope,
          reason: nextDomain.reason ?? null,
          exactState: nextDomain.summary.canonicalSha256 === stableCanonicalSha256(expectedDiagnostic),
          fieldMismatches,
          detailDifferences,
          entityDifferences,
        },
      });
      expect(nextDomain.summary.canonicalFields).toEqual(expectedDiagnosticFields);
      expect(nextDomain.summary.canonicalSha256).toBe(stableCanonicalSha256(expectedDiagnostic));
      if (client.stderrTail?.trim()) console.log(client.stderrTail.trim());
    }
    await client.request({ operation: "coreClose", sessionId: opened.sessionId });
  });
});
