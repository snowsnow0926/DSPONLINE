/// <reference lib="webworker" />
import "./save.worker";
import { writePureIdleRecoveryCheckpoint, type PureIdleRecoveryCheckpointTicket } from "./pureIdleRecovery";
import { SaveStateChunkAssembler, type SaveStateChunkRequest } from "./saveStateChunkTransfer";
import type { AuthoritativeSaveSerializationRequest } from "./authoritativeSaveSerializationProtocol";
import type { GameState } from "./types";

type StateRequest = Extract<AuthoritativeSaveSerializationRequest, { state: GameState }>;
export type PureIdleCheckpointOwnerRequest =
  | { type: "prepare-recovery"; ticket: PureIdleRecoveryCheckpointTicket }
  | SaveStateChunkRequest
  | { type: "recovery-serialize"; request: Omit<StateRequest, "state"> };

const serialize = self.onmessage!;
const assembler = new SaveStateChunkAssembler();
let ticket: PureIdleRecoveryCheckpointTicket | null = null;
let retained: GameState | null = null;
let registryJson: string | null = null;
let ready = false;
let serializing = false;
let failed = false;

self.onmessage = async ({ data }: MessageEvent<PureIdleCheckpointOwnerRequest>) => {
  try {
    if (failed) return;
    if (data.type === "prepare-recovery") {
      if (ticket || retained) throw new Error("纯挂机检查点不能重复准备");
      ticket = data.ticket;
      return;
    }
    if (data.type === "recovery-serialize") {
      if (!ready || !retained || serializing || data.request.id !== 1 ||
        data.request.kind !== "primary" || data.request.slot !== "main" ||
        data.request.includeAuthoritativeProof !== true || data.request.includeSourceStateTransfer !== false ||
        registryJson !== JSON.stringify(data.request.contentPackRegistry) ||
        ["state", "stateTransfer", "envelopeTransfer", "snapshotSource"].some(key => Object.hasOwn(data.request, key))) {
        throw new Error("纯挂机后台保存来源不匹配");
      }
      serializing = true;
      await serialize.call(self, new MessageEvent("message", { data: { ...data.request, state: retained } }));
      retained = null;
      self.close();
      return;
    }
    if (!ticket || retained || serializing) throw new Error("纯挂机检查点传输阶段无效");
    const received = assembler.accept(data);
    if ("ack" in received) {
      self.postMessage({ id: 1, stateChunkAck: received.ack });
      return;
    }
    retained = received.request.state;
    registryJson = JSON.stringify(received.request.contentPackRegistry);
    await writePureIdleRecoveryCheckpoint(retained, ticket);
    ready = true;
    self.postMessage({ id: 1, recoveryCheckpointReady: true, sessionId: ticket.checkpoint.sessionId });
  } catch (error) {
    failed = true; retained = null;
    self.postMessage({ id: 1, error: error instanceof Error ? error.message : "纯挂机后台写入失败" });
    self.close();
  }
};
