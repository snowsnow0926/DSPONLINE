import type { ContentPackRegistry } from "./contentPacks";
import type { GameState } from "./types";
import type { SaveTransferVerification } from "./saveTransfer";
import type { WorkerBinaryPayload } from "./workerBinaryPayload";
import { workerBinaryPayloadTransferables } from "./workerBinaryPayload";
import { SaveStateChunkAssembler, type SaveStateChunkRequest } from "./saveStateChunkTransfer";
import type { CanonicalTerminalOwnerRequest, CanonicalTerminalStateRequest } from "./canonicalTerminalOwnerProtocol";
import { discardCanonicalTerminalOwner, registerCanonicalTerminalOwner,
  type AuthoritativeSaveWorkerChannel, type CanonicalTerminalSerializationOwner } from "./canonicalTerminalOwnerRegistry";
import type { AuthoritativeSaveSerializationResponse } from "./authoritativeSaveSerializationProtocol";

export interface CanonicalTerminalDecoderOptions {
  isCurrent: () => boolean;
  validateState?: (state: GameState) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
  idleTimeoutMs?: number;
}

export class CanonicalTerminalDecoder implements CanonicalTerminalSerializationOwner {
  readonly state: Promise<GameState>;
  private readonly worker: Worker;
  private collector: SaveStateChunkAssembler | null = new SaveStateChunkAssembler();
  private delivered: GameState | null = null;
  private closed = false;
  private claimed = false;
  private dispatched = false;
  private channel: AuthoritativeSaveWorkerChannel | null = null;
  private sourceIsCurrent: (() => boolean) | null = null;
  private resolveState!: (state: GameState) => void;
  private rejectState!: (error: Error) => void;
  private deadline: ReturnType<typeof setTimeout> | null = null;
  private readonly poll: ReturnType<typeof setInterval>;
  private readonly registryJson: string;
  private readonly abort: () => void;
  private readonly options: CanonicalTerminalDecoderOptions;

  constructor(payload: WorkerBinaryPayload, verification: SaveTransferVerification,
    registry: ContentPackRegistry, options: CanonicalTerminalDecoderOptions) {
    this.options = { ...options };
    this.registryJson = JSON.stringify(registry);
    this.worker = new Worker(new URL("./canonicalTerminalOwner.worker.ts", import.meta.url),
      { type: "module", name: "canonical-terminal-decoder" });
    this.state = new Promise((resolve, reject) => { this.resolveState = resolve; this.rejectState = reject; });
    this.abort = () => this.fail(new DOMException("终态解码已取消", "AbortError"));
    this.worker.onerror = (event) => this.fail(new Error(event.message || "终态后台崩溃"));
    this.worker.onmessageerror = () => this.fail(new Error("终态后台响应无法复制"));
    this.worker.onmessage = (event) => this.receive(event);
    this.poll = setInterval(() => { if (!this.current()) this.fail(new DOMException("终态来源已失效", "AbortError")); }, 100);
    this.deadline = setTimeout(() => this.fail(new Error("终态后台解码超时")), options.timeoutMs ?? 120_000);
    options.signal?.addEventListener("abort", this.abort, { once: true });
    try {
      if (options.signal?.aborted || !this.current()) throw new DOMException("终态来源已取消", "AbortError");
      this.worker.postMessage({ type: "canonical-start", payload, verification, registry } satisfies CanonicalTerminalOwnerRequest,
        workerBinaryPayloadTransferables(payload));
    } catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); }
  }

  private current(): boolean {
    try { return !this.closed && this.options.isCurrent() && (this.sourceIsCurrent?.() ?? true); }
    catch { return false; }
  }

  supports(registry: ContentPackRegistry): boolean {
    return !this.closed && !this.claimed && this.delivered !== null && this.registryJson === JSON.stringify(registry);
  }

  claim(sourceIsCurrent: () => boolean): AuthoritativeSaveWorkerChannel {
    if (this.closed || this.claimed || !this.delivered) throw new Error("终态后台来源已被消费或关闭");
    this.sourceIsCurrent = sourceIsCurrent;
    if (!this.current()) throw new DOMException("终态保存来源已失效", "AbortError");
    this.claimed = true;
    if (this.deadline !== null) clearTimeout(this.deadline);
    this.deadline = null;
    const channel: AuthoritativeSaveWorkerChannel = {
      onmessage: null, onerror: null, onmessageerror: null,
      postMessage: (message, transfer = []) => {
        const request = message as CanonicalTerminalStateRequest;
        if (this.dispatched || !this.current() || request.state !== this.delivered || transfer.length ||
          request.includeSourceStateTransfer !== false || request.kind !== "primary" || request.slot !== "main" ||
          this.registryJson !== JSON.stringify(request.contentPackRegistry)) throw new Error("终态保存请求与独占来源不匹配");
        this.dispatched = true;
        const { state: _state, ...metadata } = request;
        this.worker.postMessage({ type: "canonical-serialize", request: metadata } satisfies CanonicalTerminalOwnerRequest);
      },
      terminate: () => this.close(),
    };
    this.channel = channel;
    return channel;
  }

  private receive(event: MessageEvent): void {
    if (this.closed) return;
    try {
      if (!this.current()) throw new DOMException("终态来源已失效", "AbortError");
      const data = event.data;
      if (!data || data.id !== 1) throw new Error("终态后台响应编号不匹配");
      if (data.error) throw new Error(data.error);
      if (["state-begin", "state-records", "state-complete"].includes(data.type)) {
        if (!this.collector || this.delivered) throw new Error("终态后台重复交付状态");
        const received = this.collector.accept(data as SaveStateChunkRequest);
        if ("ack" in received) this.worker.postMessage({ type: "canonical-ack", ack: received.ack } satisfies CanonicalTerminalOwnerRequest);
        else {
          const state = received.request.state;
          this.options.validateState?.(state);
          if (!this.current()) throw new DOMException("终态交接已取消", "AbortError");
          this.options.validateState = undefined;
          this.delivered = state; this.collector = null;
          if (this.deadline !== null) clearTimeout(this.deadline);
          this.deadline = setTimeout(() => this.close(), this.options.idleTimeoutMs ?? 120_000);
          registerCanonicalTerminalOwner(state, this);
          this.resolveState(state);
        }
        return;
      }
      if (!this.dispatched || !this.channel || data.id !== 1) throw new Error("终态后台提前返回保存证明");
      // Proof validation and ownership cleanup remain in the ordinary client.
      this.channel.onmessage?.(event as MessageEvent<AuthoritativeSaveSerializationResponse>);
    } catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); }
  }

  private fail(error: Error): void {
    const channel = this.channel;
    this.close(error);
    channel?.onerror?.({ message: error.message } as ErrorEvent);
  }

  close(error: Error = new DOMException("终态后台已关闭", "AbortError")): void {
    if (this.closed) return;
    this.closed = true;
    if (this.deadline !== null) clearTimeout(this.deadline);
    clearInterval(this.poll);
    this.options.signal?.removeEventListener("abort", this.abort);
    this.worker.onmessage = null; this.worker.onerror = null; this.worker.onmessageerror = null;
    this.worker.terminate(); this.collector = null;
    if (this.delivered) {
      const state = this.delivered; this.delivered = null;
      discardCanonicalTerminalOwner(state, this);
    } else this.rejectState(error);
    this.sourceIsCurrent = null;
    this.channel = null;
  }
}
