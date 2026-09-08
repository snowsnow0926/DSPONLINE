import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { catalog, runtime, createQuantumProductionFixture } from "../../tests/fixtures/rust-offline-performance";
import { buildChunkedSaveJournal } from "./chunkedSaveJournal";
import { canonicalNativeCoreSha256 } from "./nativeCoreProof";
import { advanceSimulationBudget } from "./engine";

const enabled = process.env.DSP_RUN_NATIVE_OFFLINE_SCALE_PROBE === "1";
const binaryPath = path.resolve(process.env.DSP_NATIVE_CORE_HOST_BINARY ??
  path.join("native", "target", "release", process.platform === "win32" ? "dsp-native-host.exe" : "dsp-native-host"));
const expectedHostSha256 = process.env.DSP_NATIVE_SCALE_EXPECTED_HOST_SHA256;
const reportDirectory = process.env.DSP_NATIVE_SCALE_REPORT_DIR;
const require = createRequire(import.meta.url);
const { NativeHostClient, NativeSaveSessionRegistry } = require("../../desktop/native-host.cjs");
const readBytes = fs.readFileSync as unknown as (file: string) => Uint8Array;

/** Explicit diagnostic run, public fixtures only; no player-authority changes. */
describe.skipIf(!enabled || !fs.existsSync(binaryPath))("native offline scale and atomic rejection probe", () => {
  let root: string;
  let client: InstanceType<typeof NativeHostClient>;
  let saves: InstanceType<typeof NativeSaveSessionRegistry>;
  let hostSha256: string;

  beforeAll(async () => {
    hostSha256 = createHash("sha256").update(readBytes(binaryPath)).digest("hex");
    if (expectedHostSha256) expect(hostSha256).toBe(expectedHostSha256);
    root = fs.mkdtempSync(path.join(os.tmpdir(), "dsp-native-scale-probe-"));
    client = new NativeHostClient({ binaryPath, rootPath: root, requestTimeoutMs: 300_000 });
    await client.start("native-offline-scale-probe");
    saves = new NativeSaveSessionRegistry(client);
  });

  afterAll(async () => {
    await client?.stop();
    if (root) {
      const resolved = path.resolve(root);
      if (path.dirname(resolved) !== path.resolve(os.tmpdir()) ||
        !path.basename(resolved).startsWith("dsp-native-scale-probe-")) {
        throw new Error("Refusing cleanup outside the scale probe's own profile");
      }
      fs.rmSync(resolved, { recursive: true, force: true });
    }
    if (hostSha256) {
      expect(createHash("sha256").update(readBytes(binaryPath)).digest("hex")).toBe(hostSha256);
    }
  });

  it.each([1, 128, 512, 2048])("proves full output or preserves the source for %i production chains", { timeout: 300_000 }, async tiles => {
    const seconds = 600;
    const source = createQuantumProductionFixture(tiles);
    source.settings.resourceMode = "infinite";
    const sourceHash = canonicalNativeCoreSha256(source);
    const seedStarted = performance.now();
    const journal = buildChunkedSaveJournal(source, {
      mode: "normal", basePrimaryChecksum: "01234567", savedAt: 1, retainAllChunks: true,
    });
    const prefix = "dsp-idle-network.internal.v1.chunked.v1.normal.";
    const transaction = await saves.begin(1, {
      slot: "normal-main", mode: "normal", stateVersion: 47, baseChecksum: "01234567",
      registryFingerprint: runtime.fingerprint, revision: 1, savedAtMs: 1,
    });
    for (const [id, value] of journal.chunks) {
      await saves.write(1, transaction.transactionId, [{ key: `${prefix}chunk.${encodeURIComponent(id)}`, value }]);
    }
    await saves.write(1, transaction.transactionId, [{ key: `${prefix}manifest`, value: JSON.stringify(journal.manifest) }]);
    const checkpoint = await saves.commit(1, transaction.transactionId);
    const seedMs = performance.now() - seedStarted;
    const openStarted = performance.now();
    const opened = await client.request({ operation: "coreOpen", slot: "normal-main",
      generation: checkpoint.generation, rootHash: checkpoint.rootHash, revision: 1,
      registryFingerprint: runtime.fingerprint, catalog });
    const openMs = performance.now() - openStarted;
    try {
      expect(opened.summary.canonicalSha256).toBe(sourceHash);
      const advanceStarted = performance.now();
      const result = await client.request({ operation: "coreAdvance", sessionId: opened.sessionId,
        request: { baseRevision: 1, simulationSeconds: seconds, wallSeconds: seconds, advanceMode: "offline-macro-v1" } });
      const advanceMs = performance.now() - advanceStarted;
      const status = await client.request({ operation: "coreStatus", sessionId: opened.sessionId });
      let expectedHash = sourceHash;
      if (result.supported) {
        let expected = source;
        for (let second = 0; second < seconds; second++) {
          expected = advanceSimulationBudget(expected, 1, 1);
        }
        expectedHash = canonicalNativeCoreSha256(expected);
        expect(status.revision).toBe(result.summary.revision);
      } else {
        expect(status.revision).toBe(opened.summary.revision);
      }
      const report = { hostSha256, tiles, seconds, entities: source.entities.length, belts: source.belts.length,
        sourceHash, expectedHash, actualHash: status.canonicalSha256, memory: opened.summary.memory,
        supported: result.supported, reason: result.reason, approximatedSeconds: result.approximatedSeconds,
        seedMs, openMs, advanceMs, fullStateMatch: status.canonicalSha256 === expectedHash,
        sourceUnchanged: canonicalNativeCoreSha256(source) === sourceHash,
        scope: "public fixture admission diagnostic; seed/open/advance only; no user entry or publication qualification" };
      if (reportDirectory) {
        fs.mkdirSync(reportDirectory, { recursive: true });
        fs.writeFileSync(path.join(reportDirectory, `scale-${tiles}.json`), `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
      }
      console.log(`DSP_NATIVE_OFFLINE_SCALE\t${JSON.stringify(report)}`);
      expect(report.sourceUnchanged).toBe(true);
      expect(report.fullStateMatch).toBe(true);
      if (tiles === 1) expect(result.supported, result.reason).toBe(true);
    } finally {
      await client.request({ operation: "coreClose", sessionId: opened.sessionId });
    }
  });
});
