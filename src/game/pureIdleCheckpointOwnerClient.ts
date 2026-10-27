import { loadContentPackRegistry, type ContentPackRegistry } from "./contentPacks";
import { discardCanonicalTerminalOwner, registerCanonicalTerminalOwner,
  type AuthoritativeSaveWorkerChannel, type CanonicalTerminalSerializationOwner } from "./canonicalTerminalOwnerRegistry";
import { SaveStateChunkSender } from "./saveStateChunkTransfer";
import type { AuthoritativeSaveSerializationRequest, AuthoritativeSaveSerializationResponse } from "./authoritativeSaveSerializationProtocol";
import type { PureIdleRecoveryCheckpointTicket } from "./pureIdleRecovery";
import type { PureIdleCheckpointOwnerRequest } from "./pureIdleCheckpointOwner.worker";
import type { GameState } from "./types";

type StateRequest = Extract<AuthoritativeSaveSerializationRequest, { state: GameState }>;
export interface PureIdleCheckpointOwnerOptions {
  isCurrent: () => boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** One bounded upload writes the recovery journal, then supplies the existing
 * primary serializer. The caller must exclusively own this frozen state. */
export class PureIdleCheckpointOwner implements CanonicalTerminalSerializationOwner {
  readonly ready: Promise<void>;
  private readonly worker: Worker;
  private readonly sender: SaveStateChunkSender;
  private readonly registryJson: string;
  private readonly abort: () => void;
  private readonly poll: ReturnType<typeof setInterval>;
  private deadline: ReturnType<typeof setTimeout> | null;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  private closed = false;
  private delivered = false;
  private claimed = false;
  private dispatched = false;
  private channel: AuthoritativeSaveWorkerChannel | null = null;
  private sourceIsCurrent: (() => boolean) | null = null;
  private source: GameState | null;

  constructor(state: GameState, private readonly ticket: PureIdleRecoveryCheckpointTicket,
    private readonly options: PureIdleCheckpointOwnerOptions) {
    this.source = state;
    this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    const registry = loadContentPackRegistry();
    this.registryJson = JSON.stringify(registry);
    this.worker = new Worker(new URL("./pureIdleCheckpointOwner.worker.ts", import.meta.url),
      { type: "module", name: "pure-idle-checkpoint-owner" });
    // ACKs already return through separate Worker tasks; only one batch can be
    // outstanding. No boosted continuation chain or unbounded upload queue.
    this.sender = new SaveStateChunkSender(this.worker, async () => {});
    this.abort = () => this.fail(new DOMException("纯挂机检查点已取消", "AbortError"));
    this.worker.onerror = event => this.fail(new Error(event.message || "纯挂机检查点后台崩溃"));
    this.worker.onmessageerror = () => this.fail(new Error("纯挂机检查点后台响应无法复制"));
    this.worker.onmessage = event => this.receive(event);
    this.poll = setInterval(() => { if (!this.current()) this.abort(); }, 100);
    this.deadline = setTimeout(() => this.fail(new Error("纯挂机检查点后台超时")), options.timeoutMs ?? 120_000);
    options.signal?.addEventListener("abort", this.abort, { once: true });
    try {
      if (options.signal?.aborted || !this.current()) throw new DOMException("纯挂机检查点来源失效", "AbortError");
      this.worker.postMessage({ type: "prepare-recovery", ticket } satisfies PureIdleCheckpointOwnerRequest);
      void this.sender.send({ id: 1, formatVersion: 2, savedAt: ticket.checkpoint.createdAtMs, kind: "primary", slot: "main",
        state, contentPackRegistry: registry, includeAuthoritativeProof: true, includeSourceStateTransfer: false },
      () => this.current()).catch(error => this.fail(error instanceof Error ? error : new Error(String(error))));
    } catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); }
  }

  private current(): boolean {
    try { return !this.closed && this.options.isCurrent() && (this.sourceIsCurrent?.() ?? true); }
    catch { return false; }
  }

  supports(registry: ContentPackRegistry): boolean {
    return !this.closed && this.delivered && !this.claimed && this.registryJson === JSON.stringify(registry);
  }

  claim(sourceIsCurrent: () => boolean): AuthoritativeSaveWorkerChannel {
    if (this.claimed || !this.delivered || !this.source) throw new Error("纯挂机后台来源已被消费或未就绪");
    this.sourceIsCurrent = sourceIsCurrent;
    if (!this.current()) throw new DOMException("纯挂机保存来源已失效", "AbortError");
    this.claimed = true;
    if (this.deadline !== null) clearTimeout(this.deadline);
    this.deadline = null;
    this.channel = {
      onmessage: null, onerror: null, onmessageerror: null,
      postMessage: (message, transfer = []) => {
        const request = message as StateRequest;
        if (this.dispatched || !this.current() || request.state !== this.source || transfer.length ||
          request.kind !== "primary" || request.slot !== "main" || request.includeSourceStateTransfer !== false ||
          this.registryJson !== JSON.stringify(request.contentPackRegistry)) throw new Error("纯挂机后台保存请求不匹配");
        this.dispatched = true;
        const { state: _state, ...metadata } = request;
        this.worker.postMessage({ type: "recovery-serialize", request: metadata } satisfies PureIdleCheckpointOwnerRequest);
      },
      terminate: () => this.close(),
    };
    return this.channel;
  }

  private receive(event: MessageEvent): void {
    if (this.closed) return;
    try {
      if (!this.current()) throw new DOMException("纯挂机检查点来源失效", "AbortError");
      const data = event.data;
      if (!data || data.id !== 1) throw new Error("纯挂机检查点响应编号无效");
      if (data.error) throw new Error(data.error);
      if (data.stateChunkAck) {
        if (this.delivered) throw new Error("纯挂机检查点收到迟到批次确认");
        this.sender.acknowledge(data.stateChunkAck);
        return;
      }
      if (data.recoveryCheckpointReady) {
        if (this.delivered || !this.sender.readyForResult || data.sessionId !== this.ticket.checkpoint.sessionId || !this.source) {
          throw new Error("纯挂机检查点尚未完整写入");
        }
        this.delivered = true;
        registerCanonicalTerminalOwner(this.source, this);
        this.resolveReady();
        return;
      }
      if (!this.dispatched || !this.channel) throw new Error("纯挂机后台提前返回保存证明");
      this.channel.onmessage?.(event as MessageEvent<AuthoritativeSaveSerializationResponse>);
    } catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); }
  }

  private fail(error: Error): void {
    const channel = this.channel;
    this.close(error);
    channel?.onerror?.({ message: error.message } as ErrorEvent);
  }

  close(error: Error = new DOMException("纯挂机检查点后台已关闭", "AbortError")): void {
    if (this.closed) return;
    this.closed = true;
    if (this.deadline !== null) clearTimeout(this.deadline);
    clearInterval(this.poll);
    this.options.signal?.removeEventListener("abort", this.abort);
    this.sender.cancel(error);
    this.worker.onmessage = null; this.worker.onerror = null; this.worker.onmessageerror = null;
    this.worker.terminate();
    const source = this.source; this.source = null;
    if (source) discardCanonicalTerminalOwner(source, this);
    this.rejectReady(error);
    this.channel = null; this.sourceIsCurrent = null;
  }
}
