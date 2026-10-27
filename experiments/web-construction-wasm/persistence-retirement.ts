import { parseTrustedWorkerEnvelope } from "../../src/game/storage";
import { serializeSaveEnvelopeToTransfer, decodeVerifiedSaveTransfer } from "../../src/game/saveTransfer";
import { serializeAuthoritativePrimarySaveInWorker } from "../../src/game/authoritativeSaveSerializationClient";
import { AuthoritativeSavePersistenceClient, type AuthoritativeSavePayloadCommitInput } from "../../src/game/authoritativeSavePersistenceClient";
import { initializeLocalSaveStore, flushLocalSaveWrites, getLocalSaveWriterStatus } from "../../src/game/localSaveStore";
import type { GameState } from "../../src/game/types";
import type { WorkerBinaryPayload } from "../../src/game/workerBinaryPayload";
import { refreshTimeWarpPowerSnapshot, setPaused, setTimeWarpEnabled } from "../../src/game/engine";
import { beginIdleRun } from "../../src/game/idleSettlement";

const hex = (buffer: ArrayBuffer) => [...new Uint8Array(buffer)].map(byte => byte.toString(16).padStart(2, "0")).join("");
const hash = async (bytes: Uint8Array) => hex(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
const stateHash = (state: GameState) => hash(new TextEncoder().encode(JSON.stringify(state)));
async function canonicalState(): Promise<GameState> {
  const state: GameState = (await (await fetch("/prepared.json")).json()).state;
  const source = serializeSaveEnvelopeToTransfer(state, {
    formatVersion: 2, savedAt: 1_800_000_000_000, kind: "primary", slot: "main", mode: state.mode,
  });
  const verification = { integrity: "valid" as const, stateChecksum: source.stateChecksum,
    payloadChecksum: source.payloadChecksum, byteLength: source.byteLength };
  return parseTrustedWorkerEnvelope(decodeVerifiedSaveTransfer(source.bytes, verification), verification);
}

async function readStored(key: string): Promise<string | null> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("dsp-idle-network.local-saves", 2);
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  try {
    const row = await new Promise<{ value?: unknown } | undefined>((resolve, reject) => {
      const request = db.transaction("records").objectStore("records").get(key);
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    return typeof row?.value === "string" ? row.value : null;
  } finally { db.close(); }
}

/** Two real IndexedDB commits of one fixed canonical payload across idle
 * generations. Timing is deliberately not a game performance measurement. */
export async function runPersistenceRetirement() {
  const state = await canonicalState();
  const before = await stateHash(state);
  const NativeWorker = globalThis.Worker;
  const counters = { starts: 0, terminations: 0 };
  function ObservedWorker(url: string | URL, options?: WorkerOptions): Worker {
    const worker = new NativeWorker(url, options);
    if (options?.name === "authoritative-save-persistence") {
      counters.starts += 1;
      const terminate = worker.terminate.bind(worker);
      worker.terminate = () => { counters.terminations += 1; terminate(); };
    }
    return worker;
  }
  Object.setPrototypeOf(ObservedWorker, NativeWorker);
  globalThis.Worker = ObservedWorker as unknown as typeof Worker;
  const client = new AuthoritativeSavePersistenceClient();
  try {
    await initializeLocalSaveStore();
    await flushLocalSaveWrites();
    const writer = getLocalSaveWriterStatus();
    if (writer.role !== "primary") throw new Error("Isolated writer lease unavailable");
    const serialized = await serializeAuthoritativePrimarySaveInWorker(state, {
      savedAt: 1_800_000_000_000, frozenStateIsCurrent: () => true,
    });
    const key = state.mode === "normal" ? "dsp-idle-network.save.v1" : "dsp-idle-network.save.v1.speedrun";
    const backupKey = state.mode === "normal" ? `${key}.backup` : "dsp-idle-network.save.v1.backup.speedrun";
    const input: AuthoritativeSavePayloadCommitInput<WorkerBinaryPayload> = {
      key, bytes: serialized.bytes, proof: serialized.proof, seed: serialized.catalogSeed,
      expectedRevision: 0, fence: { ownerId: writer.writerId, fencingToken: writer.fencingToken }, preserveBackup: false,
    };
    if (input.proof.byteLength < 16 * 1024 * 1024) throw new Error("Fixture does not reach production retirement threshold");
    const commits = [];
    for (let round = 0; round < 2; round += 1) {
      const result = await client.commit(input);
      if (!result.result.ok) throw new Error(result.result.message);
      const proof = result.result.proof;
      if (proof.revision !== round + 1) throw new Error("Actual primary revision did not advance once per commit");
      const raw = await readStored(key);
      if (!raw) throw new Error("Independent primary read missing");
      const bytes = new TextEncoder().encode(raw);
      const sha256 = await hash(bytes);
      if (bytes.byteLength !== proof.byteLength || sha256 !== serialized.proof.payloadSha256 || proof.backupSaved) {
        throw new Error("Stored full body or disabled-backup policy differs");
      }
      if (await readStored(backupKey) !== null) throw new Error("Disabled backup was written");
      input.expectedRevision = proof.revision;
      await new Promise(resolve => setTimeout(resolve, 2_250));
      if (counters.starts !== round + 1 || counters.terminations !== round + 1) throw new Error("Idle generation did not retire at actual defaults");
      commits.push({ revision: proof.revision, bytes: bytes.byteLength, sha256, backupSaved: proof.backupSaved,
        payloadReturned: input.bytes instanceof Blob ? input.bytes.size > 0 : input.bytes.byteLength > 0,
        starts: counters.starts, terminations: counters.terminations });
    }
    const after = await stateHash(state);
    if (before !== after) throw new Error("Canonical caller state mutated");
    return { scope: "Two actual large IndexedDB commits across default 16 MiB / 2 s retirements; full independent body SHA-256 and unchanged caller state. No performance claim.",
      stateSha256: before, callerUnchanged: true, entityCount: state.entities.length, beltCount: state.belts.length, commits };
  } finally { client.terminate(); globalThis.Worker = NativeWorker; }
}

Object.assign(globalThis, { runPersistenceRetirement });

/** Full bulk/chunk parity for the same startup-shaped private snapshot, with
 * two real commits and independent full-body readback. No timing qualification. */
export async function runStartupCheckpointParity() {
  const initial = await canonicalState();
  const controller = initial.entities.find(entity => entity.id === initial.timeWarp.controllerEntityId && entity.buildingId === "time_warp_device")
    ?? initial.entities.find(entity => entity.buildingId === "time_warp_device");
  if (!controller) throw new Error("Missing startup controller");
  initial.timeWarp.controllerEntityId = controller.id;
  initial.timeWarp.enabled = false; initial.timeWarp.requestedMultiplier = 8;
  const state = refreshTimeWarpPowerSnapshot(setTimeWarpEnabled(setPaused(initial, false), true));
  state.timeWarp = { ...state.timeWarp, pendingSimulationSeconds: 0, pendingWallSeconds: 0 };
  state.idleSettlement = beginIdleRun(state.idleSettlement, 1_800_000_000_000);
  const before = await stateHash(state);
  const client = new AuthoritativeSavePersistenceClient();
  try {
    await initializeLocalSaveStore(); await flushLocalSaveWrites();
    const writer = getLocalSaveWriterStatus();
    if (writer.role !== "primary" || state.mode !== "normal") throw new Error("Isolated normal writer required");
    const commits = [];
    for (const transport of ["bulk", "chunks"] as const) {
      const serialized = await serializeAuthoritativePrimarySaveInWorker(state, {
        savedAt: 1_800_000_000_000,
        ...(transport === "chunks" ? { frozenStateIsCurrent: () => true } : {}),
      });
      const input: AuthoritativeSavePayloadCommitInput<WorkerBinaryPayload> = {
        key: "dsp-idle-network.save.v1", bytes: serialized.bytes, proof: serialized.proof, seed: serialized.catalogSeed,
        expectedRevision: commits.length, fence: { ownerId: writer.writerId, fencingToken: writer.fencingToken }, preserveBackup: false,
      };
      const result = await client.commit(input);
      if (!result.result.ok) throw new Error(result.result.message);
      const raw = await readStored(input.key);
      if (!raw) throw new Error("Independent startup readback missing");
      const bytes = new TextEncoder().encode(raw); const sha256 = await hash(bytes);
      if (sha256 !== serialized.proof.payloadSha256 || bytes.byteLength !== serialized.proof.byteLength ||
          bytes.byteLength < 16 * 1024 * 1024 || result.result.proof.backupSaved ||
          result.result.proof.revision !== commits.length + 1 || await readStored(`${input.key}.backup`) !== null) {
        throw new Error("Startup commit full-body, revision or backup mismatch");
      }
      commits.push({ transport, sha256, bytes: bytes.byteLength, revision: result.result.proof.revision, backupSaved: false });
    }
    if (commits[0].sha256 !== commits[1].sha256 || commits[0].bytes !== commits[1].bytes || await stateHash(state) !== before) {
      throw new Error("Bulk/chunk startup sources or full persistent bodies differ");
    }
    return { scope: "Fixed complete startup snapshot, two actual bulk/chunk IndexedDB commits; no performance claim.",
      stateSha256: before, callerUnchanged: true, entityCount: state.entities.length, beltCount: state.belts.length, commits };
  } finally { client.terminate(); }
}

Object.assign(globalThis, { runStartupCheckpointParity });
