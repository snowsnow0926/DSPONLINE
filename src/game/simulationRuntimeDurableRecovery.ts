import { validateContentPackRuntimeSnapshot, type ContentPackRuntimeSnapshot } from "./contentPacks";
import type { MulticoreSimulationOptions } from "./multicoreSimulation";
import type { SimulationRuntimeRecoveryBaseIdentity } from "./simulationRuntimeRecovery";
import { SIMULATION_RUNTIME_PROTOCOL_VERSION, type SimulationCommandPatch } from "./simulationRuntimeProtocol";

export const SIMULATION_RUNTIME_DURABLE_RECOVERY_SCHEMA_VERSION = 1 as const;
export const SIMULATION_RUNTIME_DURABLE_RECOVERY_MAX_ENTRIES = 96;
export const SIMULATION_RUNTIME_DURABLE_RECOVERY_MAX_COMMANDS = 64;
export const SIMULATION_RUNTIME_DURABLE_RECOVERY_MAX_JOURNAL_BYTES = 1024 * 1024;
export const SIMULATION_RUNTIME_DURABLE_RECOVERY_SOFT_COMMANDS = 4;
export const SIMULATION_RUNTIME_DURABLE_RECOVERY_SOFT_JOURNAL_BYTES = 256 * 1024;
export const SIMULATION_RUNTIME_DURABLE_RECOVERY_MAX_STAGED_INTENT_BYTES = 64 * 1024 * 1024;
export const SIMULATION_RUNTIME_DURABLE_RECOVERY_MIN_TRANSFER_INTERVAL_MS = 5 * 60_000;
export const SIMULATION_RUNTIME_DURABLE_RECOVERY_TRANSFER_WINDOW_MS = 60 * 60_000;
export const SIMULATION_RUNTIME_DURABLE_RECOVERY_GZIP_BYTES_PER_HOUR = 64 * 1024 * 1024;
export const SIMULATION_RUNTIME_DURABLE_RECOVERY_RAW_BYTES_PER_HOUR = 128 * 1024 * 1024;

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SESSION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const textEncoder = new TextEncoder();

interface SimulationRuntimeDurableCheckpointCommon {
  schemaVersion: typeof SIMULATION_RUNTIME_DURABLE_RECOVERY_SCHEMA_VERSION;
  sessionId: string;
  generation: number;
  lastSequence: number;
  stateRevision: number;
  registryFingerprint: string;
  registry: ContentPackRuntimeSnapshot;
  committedAtMs: number;
  baseIdentity: SimulationRuntimeRecoveryBaseIdentity;
}

export interface SimulationRuntimeDurablePrimaryCheckpoint extends SimulationRuntimeDurableCheckpointCommon {
  source: "primary";
  primaryStateChecksum: string;
  primaryRevision: number;
}

export interface SimulationRuntimeDurableTransferDescriptor {
  protocolVersion: typeof SIMULATION_RUNTIME_PROTOCOL_VERSION;
  encoding: "raw" | "gzip";
  buffer: ArrayBuffer;
  storedByteLength: number;
  originalByteLength: number;
  storedSha256: string;
  originalSha256: string;
}

export interface SimulationRuntimeDurableTransferCheckpoint extends SimulationRuntimeDurableCheckpointCommon {
  source: "transfer";
  transfer: SimulationRuntimeDurableTransferDescriptor;
}

export type SimulationRuntimeDurableCheckpoint =
  | SimulationRuntimeDurablePrimaryCheckpoint
  | SimulationRuntimeDurableTransferCheckpoint;

/**
 * Write-ahead intent persisted before the command/simulation request is sent
 * to the authoritative Worker. Result revision deliberately does not exist at
 * this phase; it is attached by a separate read-back-verified finalize CAS.
 */
export interface SimulationRuntimeDurableOperationIntent {
  schemaVersion: typeof SIMULATION_RUNTIME_DURABLE_RECOVERY_SCHEMA_VERSION;
  sessionId: string;
  generation: number;
  sequence: number;
  intentSha256: string;
  baseStateRevision: number;
  command: SimulationCommandPatch | null;
  simulationSeconds: number;
  wallSeconds: number;
  multicore: MulticoreSimulationOptions | undefined;
  approximate: boolean;
  registry: ContentPackRuntimeSnapshot;
  committedAtMs: number;
}

export interface SimulationRuntimeDurableAtomicEntry {
  kind: "atomic";
  intent: SimulationRuntimeDurableOperationIntent;
  resultStateRevision: number;
}

export interface SimulationRuntimeDurableReplayStep {
  simulationSeconds: number;
  wallSeconds: number;
  count: number;
}

export interface SimulationRuntimeDurablePassiveReplay {
  // Retain every advance boundary. Equal adjacent steps may be run-length
  // encoded, but recovery still invokes the engine once per count. Schema 1
  // deliberately rejects aggregate replay until a separate exact proof exists.
  kind: "rle";
  steps: SimulationRuntimeDurableReplayStep[];
}

export interface SimulationRuntimeDurablePassiveSegment {
  kind: "passive-segment";
  schemaVersion: typeof SIMULATION_RUNTIME_DURABLE_RECOVERY_SCHEMA_VERSION;
  sessionId: string;
  generation: number;
  firstSequence: number;
  lastSequence: number;
  baseStateRevision: number;
  nextStateRevision: number;
  operationCount: number;
  replay: SimulationRuntimeDurablePassiveReplay;
  multicore: MulticoreSimulationOptions | undefined;
  approximate: boolean;
  registry: ContentPackRuntimeSnapshot;
  digestChainSha256: string;
  tailIntentSha256: string;
  committedAtMs: number;
  /** SHA-256 of every canonical segment field except this digest itself. */
  segmentSha256: string;
}

export type SimulationRuntimeDurableJournalEntry =
  | SimulationRuntimeDurableAtomicEntry
  | SimulationRuntimeDurablePassiveSegment;

export interface SimulationRuntimeDurableRecoveryRecord {
  checkpoint: SimulationRuntimeDurableCheckpoint;
  entries: SimulationRuntimeDurableJournalEntry[];
}

export interface SimulationRuntimeDurableRecoveryReadRecord extends SimulationRuntimeDurableRecoveryRecord {
  pendingIntent: SimulationRuntimeDurableOperationIntent | null;
}

export interface SimulationRuntimeDurableJournalStats {
  entryCount: number;
  commandCount: number;
  operationCount: number;
  serializedBytes: number;
  lastSequence: number;
  lastStateRevision: number;
  tailIntentSha256: string | null;
}

export interface SimulationRuntimeDurableCheckpointCadence {
  windowStartedAtMs: number;
  lastTransferAtMs: number;
  transferEvents: Array<{ committedAtMs: number; encoding: "raw" | "gzip"; bytes: number }>;
  primaryRebaseEventsMs: number[];
  transferCountInWindow: number;
  primaryRebaseCountInWindow: number;
  gzipBytesInWindow: number;
  rawBytesInWindow: number;
  lastCheckpointSource: "primary" | "transfer" | null;
  lastTransferEncoding: "raw" | "gzip" | null;
}

export interface SimulationRuntimeDurableCheckpointRecommendation {
  recommended: boolean;
  reason: "commands" | "journal-bytes" | null;
  stats: SimulationRuntimeDurableJournalStats;
}

function finiteNonNegative(value: number): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function validBaseIdentity(value: SimulationRuntimeRecoveryBaseIdentity): boolean {
  return (value.mode === "normal" || value.mode === "speedrun") && finiteNonNegative(value.savedAt) &&
    typeof value.checksum === "string" && value.checksum.length > 0 && value.checksum.length <= 256 &&
    Number.isSafeInteger(value.revision) && value.revision >= 0;
}

function stableComparableValue(value: unknown, key: string, arrayElement: boolean): string | undefined {
  if (value && typeof value === "object" && typeof (value as { toJSON?: unknown }).toJSON === "function") {
    value = ((value as { toJSON: (key: string) => unknown }).toJSON)(key);
  }
  if (value === undefined || typeof value === "function" || typeof value === "symbol") {
    return arrayElement ? "null" : undefined;
  }
  if (typeof value === "number" && !Number.isFinite(value)) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${Array.from({ length: value.length }, (_, index) =>
      stableComparableValue(value[index], String(index), true) ?? "null").join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const properties: string[] = [];
  for (const propertyKey of Object.keys(record).sort()) {
    const comparable = stableComparableValue(record[propertyKey], propertyKey, false);
    if (comparable !== undefined) properties.push(`${JSON.stringify(propertyKey)}:${comparable}`);
  }
  return `{${properties.join(",")}}`;
}

function stableComparable(value: unknown): string {
  return stableComparableValue(value, "", true) ?? "null";
}

function bytesToHex(bytes: Uint8Array): string {
  let result = "";
  for (const value of bytes) result += value.toString(16).padStart(2, "0");
  return result;
}

export async function computeSimulationRuntimeDurableBytesSha256(buffer: ArrayBuffer): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("当前环境不支持 durable recovery SHA-256 校验");
  return bytesToHex(new Uint8Array(await subtle.digest("SHA-256", buffer)));
}

export async function computeSimulationRuntimeDurableIntentSha256(
  intent: Omit<SimulationRuntimeDurableOperationIntent, "intentSha256">,
): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("当前环境不支持 durable recovery intent SHA-256 校验");
  const payload = textEncoder.encode(stableComparable(intent));
  return bytesToHex(new Uint8Array(await subtle.digest("SHA-256", payload)));
}

export async function extendSimulationRuntimeDurableDigestChain(
  previousDigestChain: string | null,
  intentSha256: string,
): Promise<string> {
  if (previousDigestChain !== null && !SHA256_PATTERN.test(previousDigestChain)) throw new Error("durable digest chain 无效");
  if (!SHA256_PATTERN.test(intentSha256)) throw new Error("durable intent digest 无效");
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("当前环境不支持 durable recovery SHA-256 校验");
  const payload = textEncoder.encode(`${previousDigestChain ?? ""}:${intentSha256}`);
  return bytesToHex(new Uint8Array(await subtle.digest("SHA-256", payload)));
}

export async function computeSimulationRuntimeDurablePassiveSegmentSha256(
  segment: Omit<SimulationRuntimeDurablePassiveSegment, "segmentSha256">,
): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("当前环境不支持 durable recovery SHA-256 校验");
  return bytesToHex(new Uint8Array(await subtle.digest("SHA-256", textEncoder.encode(stableComparable(segment)))));
}

export async function verifySimulationRuntimeDurablePassiveSegmentSha256(
  segment: SimulationRuntimeDurablePassiveSegment,
): Promise<boolean> {
  if (!SHA256_PATTERN.test(segment.segmentSha256)) return false;
  const { segmentSha256: _segmentSha256, ...unsigned } = segment;
  return await computeSimulationRuntimeDurablePassiveSegmentSha256(unsigned) === segment.segmentSha256;
}

/**
 * Cryptographically validate journal entries after transport/storage and
 * before replay. The synchronous schema validator intentionally cannot
 * substitute for this digest pass.
 */
export async function validateSimulationRuntimeDurableJournalEntryDigests(
  entries: readonly SimulationRuntimeDurableJournalEntry[],
): Promise<string | null> {
  for (const entry of entries) {
    if (entry.kind === "atomic") {
      const { intentSha256: _intentSha256, ...unsigned } = entry.intent;
      if (validateSimulationRuntimeDurableOperationIntent(entry.intent) !== null ||
        await computeSimulationRuntimeDurableIntentSha256(unsigned) !== entry.intent.intentSha256) {
        return "atomic-intent-digest-mismatch";
      }
    } else if (!await verifySimulationRuntimeDurablePassiveSegmentSha256(entry)) {
      return "passive-segment-digest-mismatch";
    }
  }
  return null;
}

export function getSimulationRuntimeDurableJournalSerializedBytes(
  entries: readonly SimulationRuntimeDurableJournalEntry[],
): number {
  return textEncoder.encode(JSON.stringify(entries)).byteLength;
}

function operationCount(entry: SimulationRuntimeDurableJournalEntry): number {
  return entry.kind === "atomic" ? 1 : entry.operationCount;
}

function entryLastSequence(entry: SimulationRuntimeDurableJournalEntry): number {
  return entry.kind === "atomic" ? entry.intent.sequence : entry.lastSequence;
}

function entryNextRevision(entry: SimulationRuntimeDurableJournalEntry): number {
  return entry.kind === "atomic" ? entry.resultStateRevision : entry.nextStateRevision;
}

function entryTailIntentSha256(entry: SimulationRuntimeDurableJournalEntry): string {
  return entry.kind === "atomic" ? entry.intent.intentSha256 : entry.tailIntentSha256;
}

export function getSimulationRuntimeDurableJournalStats(
  checkpoint: Pick<SimulationRuntimeDurableCheckpoint, "lastSequence" | "stateRevision">,
  entries: readonly SimulationRuntimeDurableJournalEntry[],
): SimulationRuntimeDurableJournalStats {
  const last = entries.at(-1);
  return {
    entryCount: entries.length,
    commandCount: entries.reduce((count, entry) => count + (entry.kind === "atomic" ? 1 : 0), 0),
    operationCount: entries.reduce((count, entry) => count + operationCount(entry), 0),
    serializedBytes: getSimulationRuntimeDurableJournalSerializedBytes(entries),
    lastSequence: last ? entryLastSequence(last) : checkpoint.lastSequence,
    lastStateRevision: last ? entryNextRevision(last) : checkpoint.stateRevision,
    tailIntentSha256: last ? entryTailIntentSha256(last) : null,
  };
}

export function getSimulationRuntimeDurableCheckpointRecommendation(
  checkpoint: Pick<SimulationRuntimeDurableCheckpoint, "lastSequence" | "stateRevision">,
  entries: readonly SimulationRuntimeDurableJournalEntry[],
): SimulationRuntimeDurableCheckpointRecommendation {
  const stats = getSimulationRuntimeDurableJournalStats(checkpoint, entries);
  const reason = stats.commandCount >= SIMULATION_RUNTIME_DURABLE_RECOVERY_SOFT_COMMANDS
    ? "commands"
    : stats.serializedBytes >= SIMULATION_RUNTIME_DURABLE_RECOVERY_SOFT_JOURNAL_BYTES
      ? "journal-bytes"
      : null;
  return { recommended: reason !== null, reason, stats };
}

function validReplayStep(value: SimulationRuntimeDurableReplayStep): boolean {
  return finiteNonNegative(value.simulationSeconds) && finiteNonNegative(value.wallSeconds) &&
    Number.isSafeInteger(value.count) && value.count >= 1;
}

function replayOperationCount(replay: SimulationRuntimeDurablePassiveReplay, declaredCount: number): boolean {
  return replay.kind === "rle" && replay.steps.length > 0 && replay.steps.every(validReplayStep) &&
    replay.steps.reduce((count, step) => count + step.count, 0) === declaredCount;
}

export function validateSimulationRuntimeDurableOperationIntent(
  intent: SimulationRuntimeDurableOperationIntent,
): string | null {
  if (intent.schemaVersion !== SIMULATION_RUNTIME_DURABLE_RECOVERY_SCHEMA_VERSION ||
    !SESSION_ID_PATTERN.test(intent.sessionId) || !Number.isSafeInteger(intent.generation) || intent.generation < 1 ||
    !Number.isSafeInteger(intent.sequence) || intent.sequence < 1 ||
    !Number.isSafeInteger(intent.baseStateRevision) || intent.baseStateRevision < 0 ||
    !SHA256_PATTERN.test(intent.intentSha256) || !finiteNonNegative(intent.simulationSeconds) ||
    !finiteNonNegative(intent.wallSeconds) || !finiteNonNegative(intent.committedAtMs) ||
    !validateContentPackRuntimeSnapshot(intent.registry)) return "invalid-intent";
  if (intent.command && intent.command.baseRevision !== intent.baseStateRevision) return "intent-command-revision-mismatch";
  return null;
}

export function validateSimulationRuntimeDurableRecoveryRecord(
  value: SimulationRuntimeDurableRecoveryRecord,
  expectedBase?: SimulationRuntimeRecoveryBaseIdentity,
): string | null {
  const { checkpoint, entries } = value;
  if (!checkpoint || checkpoint.schemaVersion !== SIMULATION_RUNTIME_DURABLE_RECOVERY_SCHEMA_VERSION ||
    !SESSION_ID_PATTERN.test(checkpoint.sessionId) || !Number.isSafeInteger(checkpoint.generation) || checkpoint.generation < 1) {
    return "invalid-checkpoint-identity";
  }
  if (!Number.isSafeInteger(checkpoint.lastSequence) || checkpoint.lastSequence < 0 ||
    !Number.isSafeInteger(checkpoint.stateRevision) || checkpoint.stateRevision < 0 ||
    !finiteNonNegative(checkpoint.committedAtMs) || !validBaseIdentity(checkpoint.baseIdentity) ||
    !validateContentPackRuntimeSnapshot(checkpoint.registry) || checkpoint.registryFingerprint !== checkpoint.registry.fingerprint) {
    return "invalid-checkpoint-metadata";
  }
  if (expectedBase && stableComparable(checkpoint.baseIdentity) !== stableComparable(expectedBase)) return "base-identity-mismatch";
  if (checkpoint.source === "primary") {
    if (checkpoint.primaryStateChecksum !== checkpoint.baseIdentity.checksum ||
      checkpoint.primaryRevision !== checkpoint.baseIdentity.revision) return "invalid-primary-checkpoint";
  } else if (checkpoint.source === "transfer") {
    const transfer = checkpoint.transfer;
    if (transfer.protocolVersion !== SIMULATION_RUNTIME_PROTOCOL_VERSION ||
      (transfer.encoding !== "raw" && transfer.encoding !== "gzip") ||
      transfer.buffer.byteLength !== transfer.storedByteLength || transfer.storedByteLength <= 0 || transfer.originalByteLength <= 0 ||
      !SHA256_PATTERN.test(transfer.storedSha256) || !SHA256_PATTERN.test(transfer.originalSha256) ||
      transfer.encoding === "raw" && (transfer.storedByteLength !== transfer.originalByteLength ||
        transfer.storedSha256 !== transfer.originalSha256)) return "invalid-transfer-checkpoint";
  } else return "invalid-checkpoint-source";
  if (!Array.isArray(entries) || entries.length > SIMULATION_RUNTIME_DURABLE_RECOVERY_MAX_ENTRIES) return "journal-entry-bound-exceeded";

  let sequence = checkpoint.lastSequence;
  let revision = checkpoint.stateRevision;
  let commandCount = 0;
  for (const entry of entries) {
    if (entry.kind === "atomic") {
      const intent = entry.intent;
      commandCount += 1;
      if (!intent.command || intent.schemaVersion !== 1 || intent.sessionId !== checkpoint.sessionId ||
        intent.generation !== checkpoint.generation || intent.sequence !== sequence + 1 ||
        intent.baseStateRevision !== revision || intent.command.baseRevision !== revision ||
        !Number.isSafeInteger(entry.resultStateRevision) || entry.resultStateRevision < revision ||
        !SHA256_PATTERN.test(intent.intentSha256) || !validateContentPackRuntimeSnapshot(intent.registry) ||
        !finiteNonNegative(intent.simulationSeconds) || !finiteNonNegative(intent.wallSeconds) || !finiteNonNegative(intent.committedAtMs)) {
        return "invalid-atomic-entry";
      }
      sequence = intent.sequence;
      revision = entry.resultStateRevision;
      continue;
    }
    if (entry.kind !== "passive-segment" || entry.schemaVersion !== 1 || entry.sessionId !== checkpoint.sessionId ||
      entry.generation !== checkpoint.generation || entry.firstSequence !== sequence + 1 ||
      !Number.isSafeInteger(entry.lastSequence) || entry.lastSequence < entry.firstSequence ||
      entry.baseStateRevision !== revision || !Number.isSafeInteger(entry.nextStateRevision) ||
      entry.nextStateRevision < revision || !Number.isSafeInteger(entry.operationCount) || entry.operationCount < 1 ||
      entry.lastSequence - entry.firstSequence + 1 !== entry.operationCount ||
      !replayOperationCount(entry.replay, entry.operationCount) || !validateContentPackRuntimeSnapshot(entry.registry) ||
      !SHA256_PATTERN.test(entry.digestChainSha256) || !SHA256_PATTERN.test(entry.tailIntentSha256) ||
      !SHA256_PATTERN.test(entry.segmentSha256) || !finiteNonNegative(entry.committedAtMs)) return "invalid-passive-segment";
    sequence = entry.lastSequence;
    revision = entry.nextStateRevision;
  }
  if (commandCount > SIMULATION_RUNTIME_DURABLE_RECOVERY_MAX_COMMANDS) return "journal-command-bound-exceeded";
  if (getSimulationRuntimeDurableJournalSerializedBytes(entries) > SIMULATION_RUNTIME_DURABLE_RECOVERY_MAX_JOURNAL_BYTES) {
    return "journal-byte-bound-exceeded";
  }
  return null;
}

function passiveCompatible(
  segment: SimulationRuntimeDurablePassiveSegment,
  intent: SimulationRuntimeDurableOperationIntent,
): boolean {
  return segment.sessionId === intent.sessionId && segment.generation === intent.generation &&
    segment.lastSequence + 1 === intent.sequence && segment.nextStateRevision === intent.baseStateRevision &&
    segment.approximate === intent.approximate && stableComparable(segment.multicore) === stableComparable(intent.multicore) &&
    segment.registry.fingerprint === intent.registry.fingerprint &&
    stableComparable(segment.registry) === stableComparable(intent.registry) && segment.replay.kind === "rle";
}

function appendReplayStep(
  steps: readonly SimulationRuntimeDurableReplayStep[],
  intent: SimulationRuntimeDurableOperationIntent,
): SimulationRuntimeDurableReplayStep[] {
  const next = [...steps];
  const last = next.at(-1);
  if (last && last.simulationSeconds === intent.simulationSeconds && last.wallSeconds === intent.wallSeconds) {
    next[next.length - 1] = { ...last, count: last.count + 1 };
  } else {
    next.push({ simulationSeconds: intent.simulationSeconds, wallSeconds: intent.wallSeconds, count: 1 });
  }
  return next;
}

/** Replay RLE using the original advance-call boundaries. */
export function* iterateSimulationRuntimeDurablePassiveReplay(
  replay: SimulationRuntimeDurablePassiveReplay,
): Iterable<{ simulationSeconds: number; wallSeconds: number }> {
  for (const step of replay.steps) {
    for (let index = 0; index < step.count; index += 1) {
      yield { simulationSeconds: step.simulationSeconds, wallSeconds: step.wallSeconds };
    }
  }
}

export async function finalizeSimulationRuntimeDurableRecoveryIntent(
  entries: readonly SimulationRuntimeDurableJournalEntry[],
  intent: SimulationRuntimeDurableOperationIntent,
  resultStateRevision: number,
): Promise<SimulationRuntimeDurableJournalEntry[]> {
  const { intentSha256: _intentSha256, ...unsignedIntent } = intent;
  if (validateSimulationRuntimeDurableOperationIntent(intent) !== null ||
    await computeSimulationRuntimeDurableIntentSha256(unsignedIntent) !== intent.intentSha256) throw new Error("durable intent digest mismatch");
  const previous = entries.at(-1);
  const expectedSequence = previous ? entryLastSequence(previous) + 1 : intent.sequence;
  const expectedRevision = previous ? entryNextRevision(previous) : intent.baseStateRevision;
  if (intent.sequence !== expectedSequence || intent.baseStateRevision !== expectedRevision ||
    !Number.isSafeInteger(resultStateRevision) || resultStateRevision < intent.baseStateRevision) {
    throw new Error("durable intent finalize CAS mismatch");
  }
  if (await validateSimulationRuntimeDurableJournalEntryDigests(entries) !== null) {
    throw new Error("durable journal digest mismatch");
  }
  if (intent.command) return [...entries, { kind: "atomic", intent: structuredClone(intent), resultStateRevision }];
  if (previous?.kind === "passive-segment" && passiveCompatible(previous, intent)) {
    const { segmentSha256: _previousSegmentSha256, ...previousUnsigned } = previous;
    const unsignedSegment: Omit<SimulationRuntimeDurablePassiveSegment, "segmentSha256"> = {
      ...previousUnsigned,
      lastSequence: intent.sequence,
      nextStateRevision: resultStateRevision,
      operationCount: previous.operationCount + 1,
      replay: {
        kind: "rle",
        steps: appendReplayStep(previous.replay.steps, intent),
      },
      digestChainSha256: await extendSimulationRuntimeDurableDigestChain(previous.digestChainSha256, intent.intentSha256),
      tailIntentSha256: intent.intentSha256,
      committedAtMs: intent.committedAtMs,
    };
    return [
      ...entries.slice(0, -1),
      {
        ...unsignedSegment,
        segmentSha256: await computeSimulationRuntimeDurablePassiveSegmentSha256(unsignedSegment),
      },
    ];
  }
  const digestChainSha256 = await extendSimulationRuntimeDurableDigestChain(null, intent.intentSha256);
  const unsignedSegment: Omit<SimulationRuntimeDurablePassiveSegment, "segmentSha256"> = {
    kind: "passive-segment",
    schemaVersion: 1,
    sessionId: intent.sessionId,
    generation: intent.generation,
    firstSequence: intent.sequence,
    lastSequence: intent.sequence,
    baseStateRevision: intent.baseStateRevision,
    nextStateRevision: resultStateRevision,
    operationCount: 1,
    replay: {
      kind: "rle",
      steps: [{ simulationSeconds: intent.simulationSeconds, wallSeconds: intent.wallSeconds, count: 1 }],
    },
    multicore: intent.multicore,
    approximate: intent.approximate,
    registry: structuredClone(intent.registry),
    digestChainSha256,
    tailIntentSha256: intent.intentSha256,
    committedAtMs: intent.committedAtMs,
  };
  return [
    ...entries,
    {
      ...unsignedSegment,
      segmentSha256: await computeSimulationRuntimeDurablePassiveSegmentSha256(unsignedSegment),
    },
  ];
}

export function advanceSimulationRuntimeDurableCheckpointCadence(
  previous: SimulationRuntimeDurableCheckpointCadence | null,
  checkpoint: SimulationRuntimeDurableCheckpoint,
  now = Date.now(),
): SimulationRuntimeDurableCheckpointCadence {
  const cutoff = now - SIMULATION_RUNTIME_DURABLE_RECOVERY_TRANSFER_WINDOW_MS;
  const transferEvents = (previous?.transferEvents ?? []).filter((event) => event.committedAtMs > cutoff && event.committedAtMs <= now);
  const primaryRebaseEventsMs = (previous?.primaryRebaseEventsMs ?? []).filter((committedAtMs) => committedAtMs > cutoff && committedAtMs <= now);
  const base = {
    windowStartedAtMs: Math.max(0, cutoff),
    lastTransferAtMs: previous?.lastTransferAtMs ?? 0,
    transferEvents,
    primaryRebaseEventsMs,
    transferCountInWindow: transferEvents.length,
    primaryRebaseCountInWindow: primaryRebaseEventsMs.length,
    gzipBytesInWindow: transferEvents.reduce((bytes, event) => bytes + (event.encoding === "gzip" ? event.bytes : 0), 0),
    rawBytesInWindow: transferEvents.reduce((bytes, event) => bytes + (event.encoding === "raw" ? event.bytes : 0), 0),
    lastCheckpointSource: previous?.lastCheckpointSource ?? null,
    lastTransferEncoding: previous?.lastTransferEncoding ?? null,
  } satisfies SimulationRuntimeDurableCheckpointCadence;
  if (checkpoint.source === "primary") return {
    ...base,
    primaryRebaseEventsMs: [...base.primaryRebaseEventsMs, now],
    primaryRebaseCountInWindow: base.primaryRebaseCountInWindow + 1,
    lastCheckpointSource: "primary",
  };
  const nextTransferEvents = [...base.transferEvents, {
    committedAtMs: now,
    encoding: checkpoint.transfer.encoding,
    bytes: checkpoint.transfer.storedByteLength,
  }];
  return {
    ...base,
    lastTransferAtMs: now,
    transferEvents: nextTransferEvents,
    transferCountInWindow: base.transferCountInWindow + 1,
    gzipBytesInWindow: base.gzipBytesInWindow + (checkpoint.transfer.encoding === "gzip" ? checkpoint.transfer.storedByteLength : 0),
    rawBytesInWindow: base.rawBytesInWindow + (checkpoint.transfer.encoding === "raw" ? checkpoint.transfer.storedByteLength : 0),
    lastCheckpointSource: "transfer",
    lastTransferEncoding: checkpoint.transfer.encoding,
  };
}

export function validateSimulationRuntimeDurableCheckpointCadence(
  previous: SimulationRuntimeDurableCheckpointCadence | null,
  checkpoint: SimulationRuntimeDurableCheckpoint,
  now = Date.now(),
): string | null {
  if (checkpoint.source === "primary") return null;
  const hourlyBudget = checkpoint.transfer.encoding === "gzip"
    ? SIMULATION_RUNTIME_DURABLE_RECOVERY_GZIP_BYTES_PER_HOUR
    : SIMULATION_RUNTIME_DURABLE_RECOVERY_RAW_BYTES_PER_HOUR;
  const proportionalInterval = Math.ceil(
    SIMULATION_RUNTIME_DURABLE_RECOVERY_TRANSFER_WINDOW_MS * checkpoint.transfer.storedByteLength / hourlyBudget,
  );
  const minimumInterval = Math.max(SIMULATION_RUNTIME_DURABLE_RECOVERY_MIN_TRANSFER_INTERVAL_MS, proportionalInterval);
  if (previous?.lastTransferAtMs && now - previous.lastTransferAtMs < minimumInterval) {
    return "transfer-checkpoint-too-frequent";
  }
  const next = advanceSimulationRuntimeDurableCheckpointCadence(previous, checkpoint, now);
  if (next.gzipBytesInWindow > SIMULATION_RUNTIME_DURABLE_RECOVERY_GZIP_BYTES_PER_HOUR) return "gzip-hourly-byte-budget-exceeded";
  if (next.rawBytesInWindow > SIMULATION_RUNTIME_DURABLE_RECOVERY_RAW_BYTES_PER_HOUR) return "raw-hourly-byte-budget-exceeded";
  return null;
}
