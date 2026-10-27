import { createInitialState } from "../../src/game/engine";
import { createContentPackRegistry } from "../../src/game/contentPacks";
import { serializeSaveEnvelopeToTransfer } from "../../src/game/saveTransfer";
import { SaveStateChunkAssembler, type SaveStateChunkRequest } from "../../src/game/saveStateChunkTransfer";
import { serializeAuthoritativePrimarySaveInWorker } from "../../src/game/authoritativeSaveSerializationClient";
import type { GameState } from "../../src/game/types";
import type { TerminalOwnerRequest } from "./terminal-owner-protocol";

const labels = ["payload-corruption", "envelope-identity", "early-serialize", "bad-ack", "duplicate-start", "missing-pack", "wrong-counts"] as const;
type Fault = typeof labels[number];

async function exercise(label: Fault) {
  const source = createInitialState(44_247);
  if (label === "missing-pack") source.contentPacks = [{ id: "missing.transport.test", version: "1.0.0" }];
  const frame = serializeSaveEnvelopeToTransfer(source, { formatVersion: 2, savedAt: 1_800_000_000_000, kind: "primary", mode: source.mode, slot: "main" });
  const verification = { integrity: "valid" as const, stateChecksum: label === "envelope-identity" ? "00000000" : frame.stateChecksum,
    payloadChecksum: frame.payloadChecksum, byteLength: frame.byteLength };
  const registry = createContentPackRegistry();
  const worker = new Worker(new URL("./terminal-owner.worker.ts", import.meta.url), { type: "module", name: "terminal-owner-fault-probe" });
  const collector = new SaveStateChunkAssembler();
  let state: GameState | null = null; let before = ""; let proofCount = 0;
  try {
    return await new Promise<{ label: string; rejected: boolean; decoded: boolean; proofCount: number; fallbackVerified: boolean }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Fault probe timeout: ${label}`)), 10_000);
      const fail = (error: unknown) => { clearTimeout(timer); reject(error); };
      worker.onerror = (event) => fail(new Error(event.message));
      worker.onmessageerror = () => fail(new Error("Fault response could not be cloned"));
      worker.onmessage = async ({ data }) => {
        try {
          if (data.type === "owner-timings") return;
          if (data.error) {
            if (label === "wrong-counts") {
              if (!state || JSON.stringify(state) !== before) throw new Error("Failed owner mutated the UI's complete source");
              const fallback = await serializeAuthoritativePrimarySaveInWorker(state,
                { savedAt: 1_800_000_000_000, frozenStateIsCurrent: () => true });
              const body = fallback.proof.transportEncoding === "gzip"
                ? await new Response(new Blob([fallback.bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer() : fallback.bytes;
              const sha = [...new Uint8Array(await crypto.subtle.digest("SHA-256", body))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
              if (sha !== fallback.proof.payloadSha256 || JSON.stringify(state) !== before) throw new Error("Fallback payload or original source changed");
            } else if (state) throw new Error("An invalid input published a full state");
            clearTimeout(timer);
            resolve({ label, rejected: true, decoded: state !== null, proofCount, fallbackVerified: label === "wrong-counts" });
            return;
          }
          if (["state-begin", "state-records", "state-complete"].includes(data.type)) {
            const received = collector.accept(data as SaveStateChunkRequest);
            if ("ack" in received) {
              if (label === "duplicate-start") {
                const duplicate = frame.bytes.slice(0);
                worker.postMessage({ type: "owner-start", payload: duplicate, registry, verification, returnOnly: false } satisfies TerminalOwnerRequest, [duplicate]);
              } else {
                worker.postMessage({ type: "owner-ack", ack: label === "bad-ack" ? { ...received.ack, id: 2 } : received.ack } satisfies TerminalOwnerRequest);
              }
            } else {
              state = received.request.state; before = JSON.stringify(state);
              if (label !== "wrong-counts") throw new Error(`Invalid source completed: ${label}`);
              worker.postMessage({ type: "owner-serialize", savedAt: 1_800_000_000_000, expectedStateIdentity: {
                mode: state.mode, version: state.version, activePlanetId: state.activePlanetId, elapsedSeconds: state.elapsedSeconds,
                entityCount: state.entities.length + 1, beltCount: state.belts.length,
              } } satisfies TerminalOwnerRequest);
            }
            return;
          }
          if (data.bytes) proofCount += 1;
          throw new Error(`Invalid owner produced a proof: ${label}`);
        } catch (error) { fail(error); }
      };
      if (label === "early-serialize") worker.postMessage({ type: "owner-serialize", savedAt: 1_800_000_000_000, expectedStateIdentity: {
        mode: source.mode, version: source.version, activePlanetId: source.activePlanetId, elapsedSeconds: source.elapsedSeconds,
        entityCount: source.entities.length, beltCount: source.belts.length,
      } } satisfies TerminalOwnerRequest);
      else {
        const payload = frame.bytes.slice(0);
        if (label === "payload-corruption") new Uint8Array(payload)[0] ^= 1;
        worker.postMessage({ type: "owner-start", payload, verification, registry, returnOnly: false } satisfies TerminalOwnerRequest, [payload]);
      }
    });
  } finally { worker.terminate(); }
}

export async function runTerminalOwnerFaults() {
  const beforeStorage = JSON.stringify(Object.entries(localStorage));
  const results = [];
  for (const label of labels) results.push(await exercise(label));
  if (JSON.stringify(Object.entries(localStorage)) !== beforeStorage) throw new Error("Fault probe modified local storage");
  return { scope: "7 real Worker failures on a public synthetic factory; no application persistence or private save payload", results,
    passed: results.length, failed: 0, storageUnchanged: true };
}
Object.assign(globalThis, { runTerminalOwnerFaults });
