import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { expect, it } from 'vitest';
import { rewrapAuthoritativePrimarySnapshot } from '../../src/game/authoritativeSnapshotRewrap';
import { computeAuthoritativeSaveProofBindingSha256 } from '../../src/game/authoritativeSaveProof';
import { sha256Bytes } from '../../src/game/payloadDigest';
import { decodeSavePayloadTransport, prepareSavePayloadTransport } from '../../src/game/savePayloadCompression';
import { serializeSaveEnvelopeToTransfer } from '../../src/game/saveTransfer';
import type { AuthoritativePrimarySnapshotSource } from '../../src/game/authoritativeSaveSerializationProtocol';

it('preserves every real-save snapshot byte through the actual proof/compression wrapper', async () => {
  const manifest = JSON.parse(readFileSync(process.env.DSP_SNAPSHOT_MANIFEST!, 'utf8'));
  const variant = process.env.DSP_SNAPSHOT_VARIANT!;
  const transport = process.env.DSP_SNAPSHOT_TRANSPORT!;
  const reason = '自动快照大档字节对照🚀';
  const loaded = (globalThis as typeof globalThis & { __DSP_SNAPSHOT_SOURCES?: Record<string, string> }).__DSP_SNAPSHOT_SOURCES;
  expect(loaded).toEqual(manifest.runtimes[variant].sourceHashes);
  const collect = (globalThis as typeof globalThis & { gc?: () => void }).gc;
  if (!collect) throw Error('Explicit diagnostic GC capability required');

  // Preparation owns the original laboratory copy read-only. Return no GameState
  // graph or full payload string into the measured operation.
  async function prepare() {
    const raw = readFileSync(manifest.fixture.path);
    expect(raw.byteLength).toBe(manifest.fixture.byteLength);
    expect(createHash('sha256').update(raw).digest('hex')).toBe(manifest.fixture.sha256);
    const state = JSON.parse(raw.toString('utf8')).state;
    expect(state.entities.length).toBe(110042);
    expect(state.belts.length).toBe(233300);
    const primary = serializeSaveEnvelopeToTransfer(state, {
      formatVersion: 2, savedAt: 10, mode: 'normal', kind: 'primary', slot: 'main',
    });
    const expected = serializeSaveEnvelopeToTransfer(state, {
      formatVersion: 2, savedAt: 11, mode: 'normal', kind: 'snapshot', slot: 'main', reason,
    });
    const payloadSha256 = await sha256Bytes(primary.bytes);
    const encoded = await prepareSavePayloadTransport(primary.bytes, payloadSha256, transport === 'gzip');
    expect(encoded.encoding).toBe(transport);
    const catalogSeed: AuthoritativePrimarySnapshotSource['catalogSeed'] = {
      mode: 'normal', kind: 'primary', slot: 'main', savedAt: 10, stateVersion: state.version,
      entityCount: state.entities.length, beltCount: state.belts.length, elapsedSeconds: 1234,
      completedTechCount: state.research.completedTechIds.length, activePlanetId: state.activePlanetId,
      structurePoints: 0, stateChecksum: primary.stateChecksum, modeExplicit: true, reason: null, settings: state.settings,
    };
    const proof = { integrity: 'valid' as const, byteLength: primary.byteLength,
      payloadChecksum: primary.payloadChecksum, stateChecksum: primary.stateChecksum, payloadSha256,
      transportEncoding: encoded.encoding, storedByteLength: encoded.storedByteLength, storedSha256: encoded.storedSha256 };
    const source: AuthoritativePrimarySnapshotSource = { bytes: encoded.buffer, catalogSeed,
      proof: { ...proof, bindingSha256: await computeAuthoritativeSaveProofBindingSha256(proof, catalogSeed) },
      summary: { ...catalogSeed, kind: 'primary', slot: 'main', uploadedWhiteMatrix: 0,
        integrity: 'valid', computedStateChecksum: primary.stateChecksum } };
    return { source, expected };
  }

  const { source, expected } = await prepare();
  collect(); // Diagnostic setup only; never an accepted natural Web peak measurement.
  const samples: { elapsedMs: number; rss: number; heapUsed: number; arrayBuffers: number; external: number }[] = [];
  const started = performance.now();
  const sample = () => { const m = process.memoryUsage(); samples.push({ elapsedMs: performance.now() - started,
    rss: m.rss, heapUsed: m.heapUsed, arrayBuffers: m.arrayBuffers, external: m.external }); };
  const cpuStart = process.cpuUsage();
  sample();
  const sampler = setInterval(sample, 10);
  let snapshot: Awaited<ReturnType<typeof rewrapAuthoritativePrimarySnapshot>>;
  try { snapshot = await rewrapAuthoritativePrimarySnapshot(source, 11, reason); }
  finally { clearInterval(sampler); sample(); }
  const wallMs = performance.now() - started;
  const cpu = process.cpuUsage(cpuStart);
  const decoded = await decodeSavePayloadTransport(snapshot.bytes, snapshot.proof.transportEncoding);
  expect(Buffer.compare(Buffer.from(decoded), Buffer.from(expected.bytes))).toBe(0);
  expect(snapshot.proof.stateChecksum).toBe(source.proof.stateChecksum);
  expect(snapshot.proof.payloadChecksum).toBe(expected.payloadChecksum);
  expect(snapshot.proof.payloadSha256).toBe(await sha256Bytes(expected.bytes));
  const { bindingSha256, ...proof } = snapshot.proof;
  expect(await computeAuthoritativeSaveProofBindingSha256(proof, snapshot.catalogSeed)).toBe(bindingSha256);
  expect(snapshot.catalogSeed).toEqual({ ...source.catalogSeed, kind: 'snapshot', savedAt: 11, reason });
  expect(source.bytes.byteLength).toBe(source.proof.storedByteLength);
  expect(await sha256Bytes(source.bytes)).toBe(source.proof.storedSha256);
  writeFileSync(process.env.DSP_SNAPSHOT_RESULT!, JSON.stringify({ schema: 1, variant, transport,
    diagnosticOnly: true, forcedGcBeforeOperation: true, naturalWebMeasurement: false,
    fixture: manifest.fixture, sourceHashes: loaded, entityCount: 110042, beltCount: 233300,
    primaryByteLength: source.proof.byteLength, primaryStoredByteLength: source.proof.storedByteLength,
    primaryPayloadSha256: source.proof.payloadSha256, primaryStateChecksum: source.proof.stateChecksum,
    snapshotByteLength: decoded.byteLength, snapshotPayloadSha256: snapshot.proof.payloadSha256,
    snapshotStateChecksum: snapshot.proof.stateChecksum, fullBytesExact: true, inputUnchanged: true,
    proofBindingValid: true, wallMs, cpuMs: (cpu.user + cpu.system) / 1000,
    memorySamples: samples, sampleCount: samples.length,
    sampledPeakRss: Math.max(...samples.map(m => m.rss)),
    sampledPeakHeap: Math.max(...samples.map(m => m.heapUsed)) }, null, 2));
});
