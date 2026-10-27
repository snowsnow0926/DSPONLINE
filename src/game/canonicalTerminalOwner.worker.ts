/// <reference lib="webworker" />
import "./save.worker";
import { applyContentPackRegistry } from "./contentPacks";
import { parseTrustedWorkerEnvelope } from "./storage";
import { decodeVerifiedSaveTransfer } from "./saveTransfer";
import { SaveStateChunkSender } from "./saveStateChunkTransfer";
import { workerBinaryPayloadToArrayBuffer } from "./workerBinaryPayload";
import type { CanonicalTerminalOwnerRequest } from "./canonicalTerminalOwnerProtocol";
import type { GameState } from "./types";

const serialize = self.onmessage!;
let sender: SaveStateChunkSender | null = null;
let retained: GameState | null = null;
let started = false;
let complete = false;
let serializing = false;
let failed = false;

const fail = (error: unknown) => {
  if (failed) return;
  failed = true;
  sender?.cancel(); retained = null;
  self.postMessage({ id: 1, error: error instanceof Error ? error.message : "终态后台交接失败" });
  self.close();
};

async function canonical(data: Extract<CanonicalTerminalOwnerRequest, { type: "canonical-start" }>): Promise<GameState> {
  if (!data.payload) throw new Error("终态后台缺少完整源数据");
  const bytes = await workerBinaryPayloadToArrayBuffer(data.payload);
  const raw = decodeVerifiedSaveTransfer(bytes, data.verification);
  return parseTrustedWorkerEnvelope(raw, data.verification, data.registry);
}

self.onmessage = async ({ data }: MessageEvent<CanonicalTerminalOwnerRequest>) => {
  try {
    if (data.type === "canonical-ack") {
      if (!sender) throw new Error("终态确认早于后台解码");
      sender.acknowledge(data.ack);
      return;
    }
    if (data.type === "canonical-serialize") {
      if (!complete || !retained || serializing || failed || data.request.id !== 1 ||
        data.request.kind !== "primary" || data.request.slot !== "main" ||
        data.request.includeAuthoritativeProof !== true || data.request.includeSourceStateTransfer !== false ||
        ["state", "stateTransfer", "envelopeTransfer", "snapshotSource"].some((key) => Object.hasOwn(data.request, key))) {
        throw new Error("终态后台尚未完成交接或保存来源不匹配");
      }
      serializing = true;
      // The original save handler receives the exact canonical state whose
      // complete value copy was already delivered. Projection stays owned here.
      await serialize.call(self, new MessageEvent("message", { data: { ...data.request, state: retained } }));
      retained = null; self.close();
      return;
    }
    if (started || !data.payload || failed) throw new Error("终态后台不能重复解码");
    started = true;
    applyContentPackRegistry(data.registry);
    retained = await canonical(data);
    data.payload = null;
    sender = new SaveStateChunkSender({ postMessage: (message) => self.postMessage(message) }, async () => {});
    // This header describes an intended primary source, not a persistence ACK.
    // A separate canonical-serialize request supplies the actual save metadata.
    await sender.send({ id: 1, state: retained, formatVersion: 2, savedAt: Date.now(),
      kind: "primary", slot: "main", contentPackRegistry: data.registry,
      includeAuthoritativeProof: true, includeSourceStateTransfer: false });
    complete = true;
  } catch (error) { fail(error); }
};
