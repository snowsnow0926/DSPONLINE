/// <reference lib="webworker" />
import "../../src/game/save.worker";
import { applyContentPackRegistry, type ContentPackRegistry } from "../../src/game/contentPacks";
import { parseTrustedWorkerEnvelope } from "../../src/game/storage";
import { decodeVerifiedSaveTransfer, type SaveTransferVerification } from "../../src/game/saveTransfer";
import { SaveStateChunkSender } from "../../src/game/saveStateChunkTransfer";
import type { AuthoritativeSaveSerializationRequest } from "../../src/game/authoritativeSaveSerializationProtocol";
import type { GameState } from "../../src/game/types";
import type { TerminalOwnerRequest } from "./terminal-owner-protocol";

const serialize = self.onmessage!;
let sender: SaveStateChunkSender | null = null;
let retained: GameState | null = null;
let registry: ContentPackRegistry | null = null;
let started = false;
let complete = false;
let serializing = false;
let failed = false;
const fail = (error: unknown) => {
  if (failed) return;
  failed = true; sender?.cancel(); retained = null;
  self.postMessage({ id: 1, error: error instanceof Error ? error.message : String(error) });
  self.close();
};

function canonical(payload: ArrayBuffer, verification: SaveTransferVerification, packs: ContentPackRegistry) {
  let start = performance.now();
  const raw = decodeVerifiedSaveTransfer(payload, verification);
  const verifyDecodeMs = performance.now() - start;
  start = performance.now();
  const state = parseTrustedWorkerEnvelope(raw, verification, packs);
  return { state, timings: { verifyDecodeMs, parseNormalizeMs: performance.now() - start } };
}

self.onmessage = async ({ data }: MessageEvent<TerminalOwnerRequest>) => {
  try {
    if (data.type === "owner-ack") {
      if (!sender) throw new Error("Owner acknowledgement before decoding");
      sender.acknowledge(data.ack);
      return;
    }
    if (data.type === "owner-serialize") {
      if (!complete || !retained || !registry || serializing || failed) throw new Error("Owner state is not available for serialization");
      serializing = true;
      // This is the unchanged production save handler, after full canonical
      // migration and after every record has already been cloned to the UI.
      await serialize.call(self, new MessageEvent("message", { data: {
        id: 1, state: retained, formatVersion: 2, savedAt: data.savedAt, kind: "primary", slot: "main",
        contentPackRegistry: registry, includePayloadSha256: true, includeAuthoritativeProof: true,
        includeSourceStateTransfer: false, expectedStateIdentity: data.expectedStateIdentity,
      } satisfies AuthoritativeSaveSerializationRequest }));
      retained = null; self.close();
      return;
    }
    if (started || !data.payload || failed) throw new Error("Owner decode cannot start twice");
    started = true; registry = data.registry;
    applyContentPackRegistry(registry);
    const readStart = performance.now();
    let bytes: ArrayBuffer | null = data.payload instanceof Blob ? await data.payload.arrayBuffer() : data.payload;
    const inputReadMs = performance.now() - readStart;
    const decoded = canonical(bytes, data.verification, registry);
    bytes = null;
    data.payload = null;
    retained = decoded.state;
    self.postMessage({ id: 1, type: "owner-timings", timings: { inputReadMs, ...decoded.timings } });
    sender = new SaveStateChunkSender({ postMessage: (message) => self.postMessage(message) }, async () => {});
    const deliveryStart = performance.now();
    // The experiment reuses the frozen canonical-state collector. Its header
    // describes the primary source; only owner-serialize may request a proof.
    await sender.send({ id: 1, state: retained, formatVersion: 2, savedAt: 1_800_000_000_000,
      kind: "primary", slot: "main", contentPackRegistry: registry,
      includeAuthoritativeProof: true, includeSourceStateTransfer: false });
    complete = true;
    self.postMessage({ id: 1, type: "owner-timings", timings: { deliveryMs: performance.now() - deliveryStart } });
    if (data.returnOnly) { retained = null; self.close(); }
  } catch (error) { fail(error); }
};
