import type { AuthoritativeSaveSerializationRequest } from "./authoritativeSaveSerializationProtocol";
import type { BeltConnection, FactoryEntity, GameState } from "./types";
import { yieldSaveTransferWork } from "./saveTransferDecode";

export const SAVE_STATE_ENTITY_CHUNK_RECORDS = 512;
export const SAVE_STATE_BELT_CHUNK_RECORDS = 2_048;
type StateRequest = Extract<AuthoritativeSaveSerializationRequest, { state: GameState }>;
type Collection = "entities" | "belts";

export type SaveStateChunkRequest =
  | { type: "state-begin"; id: number; metadata: Omit<StateRequest, "state">;
      topLevel: Omit<GameState, Collection> & { entities: undefined; belts: undefined };
      entityCount: number; beltCount: number }
  | { type: "state-records"; id: number; collection: Collection; offset: number;
      records: FactoryEntity[] | BeltConnection[] }
  | { type: "state-complete"; id: number };

export interface SaveStateChunkAck {
  type: "state-chunk-ack";
  id: number;
  collection: "begin" | Collection;
  nextOffset: number;
}

export class SaveStateChunkProtocolError extends Error {}

/** Each save owns a dedicated Worker. Never serialize a partly assembled state. */
export class SaveStateChunkAssembler {
  private sealed = false;
  private pending: { request: Omit<StateRequest, "state">; state: GameState;
    entityCount: number; beltCount: number; entities: number; belts: number } | null = null;

  accept(message: SaveStateChunkRequest): { ack: SaveStateChunkAck } | { request: StateRequest } {
    try { return this.receive(message); }
    catch (error) { this.sealed = true; this.pending = null; throw error; }
  }

  private receive(message: SaveStateChunkRequest): { ack: SaveStateChunkAck } | { request: StateRequest } {
    const fail: (reason: string) => never = (reason) => { throw new SaveStateChunkProtocolError(`存档分批传输无效：${reason}`); };
    if (this.sealed || !Number.isSafeInteger(message.id) || message.id < 1) fail("会话已结束或编号无效");
    if (message.type === "state-begin") {
      if (this.pending) fail("重复起始消息");
      const { metadata, topLevel, entityCount, beltCount } = message;
      if (!metadata || metadata.id !== message.id || metadata.kind !== "primary" || metadata.slot !== "main" ||
        metadata.includeAuthoritativeProof !== true || metadata.includeSourceStateTransfer !== false ||
        ["state", "stateTransfer", "envelopeTransfer", "snapshotSource"].some((key) => Object.hasOwn(metadata, key)) ||
        !topLevel || !Object.hasOwn(topLevel, "entities") || !Object.hasOwn(topLevel, "belts") ||
        topLevel.entities !== undefined || topLevel.belts !== undefined ||
        !Number.isSafeInteger(entityCount) || entityCount < 0 || entityCount >= 2 ** 32 ||
        !Number.isSafeInteger(beltCount) || beltCount < 0 || beltCount >= 2 ** 32) fail("起始身份或记录数量无效");
      // Keep the original key positions. Appending these properties at the end
      // would change the canonical JSON bytes and the state checksum.
      const state = { ...topLevel } as unknown as GameState;
      state.entities = new Array<FactoryEntity>(entityCount);
      state.belts = new Array<BeltConnection>(beltCount);
      this.pending = { request: metadata, state, entityCount, beltCount, entities: 0, belts: 0 };
      return { ack: { type: "state-chunk-ack", id: message.id, collection: "begin", nextOffset: 0 } };
    }
    const pending = this.pending;
    if (!pending || pending.request.id !== message.id) fail("没有匹配的起始会话");
    if (message.type === "state-complete") {
      if (pending.entities !== pending.entityCount || pending.belts !== pending.beltCount) fail("记录未完整接收");
      this.sealed = true;
      this.pending = null;
      return { request: { ...pending.request, state: pending.state } };
    }
    if (message.type !== "state-records" || (message.collection !== "entities" && message.collection !== "belts")) fail("未知消息");
    const collection = message.collection;
    const received = pending[collection];
    const total = collection === "entities" ? pending.entityCount : pending.beltCount;
    const limit = collection === "entities" ? SAVE_STATE_ENTITY_CHUNK_RECORDS : SAVE_STATE_BELT_CHUNK_RECORDS;
    if (!Array.isArray(message.records) || message.records.length < 1 || message.records.length > limit ||
      message.offset !== received || message.offset + message.records.length > total) fail("记录顺序或分批长度无效");
    const target = pending.state[collection] as Array<FactoryEntity | BeltConnection>;
    for (let index = 0; index < message.records.length; index += 1) {
      const record = message.records[index];
      if (!record || typeof record !== "object" || Array.isArray(record)) fail("记录不是完整对象");
      target[received + index] = record;
    }
    pending[collection] += message.records.length;
    return { ack: { type: "state-chunk-ack", id: message.id, collection, nextOffset: pending[collection] } };
  }
}

/** Only use while the caller exclusively owns an immutable snapshot. */
export class SaveStateChunkSender {
  private stopped = false;
  private started = false;
  private completed = false;
  private waiting: { expected: SaveStateChunkAck; resolve: () => void; reject: (error: Error) => void } | null = null;

  constructor(private readonly worker: { postMessage(message: unknown): void },
    private readonly yieldControl: () => Promise<void> = yieldSaveTransferWork) {}

  get readyForResult(): boolean { return this.completed; }

  cancel(error = new Error("存档分批传输已结束")): void {
    this.stopped = true;
    const waiting = this.waiting;
    this.waiting = null;
    waiting?.reject(error);
  }

  acknowledge(ack: SaveStateChunkAck): void {
    const waiting = this.waiting;
    if (!waiting || ack.type !== "state-chunk-ack" || ack.id !== waiting.expected.id ||
      ack.collection !== waiting.expected.collection || ack.nextOffset !== waiting.expected.nextOffset) {
      const error = new SaveStateChunkProtocolError("存档分批确认顺序或身份无效");
      this.cancel(error);
      throw error;
    }
    this.waiting = null;
    waiting.resolve();
  }

  private postWithAck(message: SaveStateChunkRequest, expected: SaveStateChunkAck): Promise<void> {
    if (this.stopped) return Promise.reject(new Error("存档分批传输已取消"));
    return new Promise((resolve, reject) => {
      this.waiting = { expected, resolve, reject };
      try { this.worker.postMessage(message); }
      catch (error) { const failure = error instanceof Error ? error : new Error(String(error)); this.cancel(failure); reject(failure); }
    });
  }

  async send(request: StateRequest, sourceIsCurrent?: () => boolean): Promise<void> {
    if (this.started) throw new SaveStateChunkProtocolError("存档分批发送会话不能重复使用");
    this.started = true;
    const state = request.state;
    const entities = state.entities;
    const belts = state.belts;
    const entityCount = entities.length;
    const beltCount = belts.length;
    const checkSource = () => {
      if (this.stopped || sourceIsCurrent?.() === false || state.entities !== entities || state.belts !== belts ||
        entities.length !== entityCount || belts.length !== beltCount) throw new SaveStateChunkProtocolError("存档快照在传输期间已失效");
    };
    checkSource();
    const { state: _state, ...metadata } = request;
    await this.postWithAck({ type: "state-begin", id: request.id, metadata,
      topLevel: { ...state, entities: undefined, belts: undefined }, entityCount, beltCount },
    { type: "state-chunk-ack", id: request.id, collection: "begin", nextOffset: 0 });
    for (const collection of ["entities", "belts"] as const) {
      const source = collection === "entities" ? entities : belts;
      const size = collection === "entities" ? SAVE_STATE_ENTITY_CHUNK_RECORDS : SAVE_STATE_BELT_CHUNK_RECORDS;
      for (let offset = 0; offset < source.length; offset += size) {
        checkSource();
        const records = source.slice(offset, offset + size);
        await this.postWithAck({ type: "state-records", id: request.id, collection, offset, records },
          { type: "state-chunk-ack", id: request.id, collection, nextOffset: offset + records.length });
        await this.yieldControl();
      }
    }
    checkSource();
    this.completed = true;
    this.worker.postMessage({ type: "state-complete", id: request.id } satisfies SaveStateChunkRequest);
  }
}
