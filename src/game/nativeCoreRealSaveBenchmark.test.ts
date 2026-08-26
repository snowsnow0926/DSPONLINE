import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { afterAll, describe, expect, it } from "vitest";
import { buildChunkedSaveJournal } from "./chunkedSaveJournal";
import { createContentPackRegistry, createContentPackRuntimeSnapshot } from "./contentPacks";
import { createNativeCoreCatalog } from "./nativeCoreCatalog";
import type { GameState } from "./types";

const runBenchmark = process.env.DSP_RUN_NATIVE_CORE_BENCHMARK === "1";
const fixturePath = process.env.DSP_NATIVE_CORE_FIXTURE ||
  "C:\\Users\\WINDOWS\\Downloads\\dsp-idle-save-2026-08-24 (1).json\\dsp-idle-save-2026-08-24 (1).json";
const require = createRequire(import.meta.url);
const { NativeHostClient, NativeSaveSessionRegistry } = require("../../desktop/native-host.cjs") as {
  NativeHostClient: new (options: { binaryPath: string; rootPath: string; requestTimeoutMs: number }) => {
    child?: { pid?: number };
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

describe.skipIf(!runBenchmark)("real-save Windows native core benchmark", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsp-native-core-benchmark-"));
  const binaryPath = path.resolve("native", "target", "release", process.platform === "win32" ? "dsp-native-host.exe" : "dsp-native-host");
  const client = new NativeHostClient({ binaryPath, rootPath: root, requestTimeoutMs: 120_000 });
  afterAll(async () => {
    await client.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("loads the 80k entity / 155k belt fixture with exact v47 hash and bounded native memory", { timeout: 120_000 }, async () => {
    expect(fs.existsSync(fixturePath)).toBe(true);
    expect(fs.existsSync(binaryPath)).toBe(true);
    const sourceBytes = fs.statSync(fixturePath).size;
    const envelope = JSON.parse(fs.readFileSync(fixturePath, "utf8")) as Envelope;
    expect(envelope.formatVersion).toBe(2);
    expect(envelope.state.version).toBe(47);
    const runtime = createContentPackRuntimeSnapshot(createContentPackRegistry());
    const journal = buildChunkedSaveJournal(envelope.state, {
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
    for (let offset = 0; offset < records.length; offset += 8) {
      await saves.write(1, transaction.transactionId, records.slice(offset, offset + 8));
    }
    const commit = await saves.commit(1, transaction.transactionId);
    const beforePrivateBytes = privateBytes(client.child?.pid);
    const openStartedAt = performance.now();
    const opened = await client.request({
      operation: "coreOpen",
      slot: envelope.mode === "speedrun" ? "speedrun-main" : "normal-main",
      generation: commit.generation,
      rootHash: commit.rootHash,
      revision: commit.revision,
      registryFingerprint: runtime.fingerprint,
      catalog: createNativeCoreCatalog(runtime),
    });
    const openDurationMs = performance.now() - openStartedAt;
    const afterPrivateBytes = privateBytes(client.child?.pid);
    const sourceSha256 = stableCanonicalSha256(envelope.state);
    const { entities: sourceEntities, belts: sourceBelts, ...sourceBase } = envelope.state;
    const sourceComponents = {
      base: stableCanonicalSha256(sourceBase),
      entities: stableCanonicalSha256(sourceEntities),
      belts: stableCanonicalSha256(sourceBelts),
    };
    expect(opened.summary.entityCount).toBe(envelope.state.entities.length);
    expect(opened.summary.beltCount).toBe(envelope.state.belts.length);
    expect(opened.summary.coverage.authorityEligible).toBe(false);
    expect(opened.summary.memory.estimatedRuntimeBytes).toBeLessThan(sourceBytes * 3);
    console.log(JSON.stringify({
      fixture: { sourceBytes, entities: envelope.state.entities.length, belts: envelope.state.belts.length },
      nativeCore: {
        openDurationMs: Number(openDurationMs.toFixed(2)),
        canonicalSha256: opened.summary.canonicalSha256,
        sourceSha256,
        canonicalComponents: opened.summary.canonicalComponents,
        sourceComponents,
        exactRoundTrip: opened.summary.canonicalSha256 === sourceSha256,
        estimatedRuntimeBytes: opened.summary.memory.estimatedRuntimeBytes,
        rawRecordBytes: opened.summary.memory.rawRecordBytes,
        processPrivateBytesBeforeOpen: beforePrivateBytes,
        processPrivateBytesAfterOpen: afterPrivateBytes,
        processPrivateBytesDelta: beforePrivateBytes !== null && afterPrivateBytes !== null ? afterPrivateBytes - beforePrivateBytes : null,
      },
    }, null, 2));
    expect(opened.summary.canonicalComponents).toEqual(sourceComponents);
    expect(opened.summary.canonicalSha256).toBe(sourceSha256);
    await client.request({ operation: "coreClose", sessionId: opened.sessionId });
  });
});
