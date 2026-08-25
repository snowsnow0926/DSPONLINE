import type { ContentPackRegistry } from "./contentPacks";
import type { AuthoritativeSaveCheckpointOverlay } from "./authoritativeSaveSerializationProtocol";
import { commitChunkedSaveJournal, prepareChunkedSaveJournalContext, type PersistChunkedSaveOptions, type PersistChunkedSaveResult } from "./chunkedSaveJournal";
import type { SimulationStateTransfer } from "./simulationRuntimeProtocol";
import type {
  ChunkedSaveJournalWorkerRequest,
  ChunkedSaveJournalWorkerResponse,
} from "./chunkedSaveJournal.worker";

export interface ChunkedSaveTransferFailure extends Error {
  sourceStateTransfer?: SimulationStateTransfer;
}

interface PendingChunkedSaveRequest {
  id: number;
  timeout: ReturnType<typeof setTimeout>;
  resolve: (result: PersistChunkedSaveResult) => void;
  reject: (error: Error) => void;
}

const CHUNKED_SAVE_WORKER_TIMEOUT_MS = 120_000;
const CHUNKED_SAVE_WORKER_IDLE_TIMEOUT_MS = 5 * 60_000;

let workerSequence = 0;
let persistentWorker: Worker | null = null;
let pendingRequest: PendingChunkedSaveRequest | null = null;
let idleWorkerTimer: ReturnType<typeof setTimeout> | null = null;

function clearIdleWorkerTimer(): void {
  if (idleWorkerTimer === null) return;
  clearTimeout(idleWorkerTimer);
  idleWorkerTimer = null;
}

function disposePersistentWorker(): void {
  clearIdleWorkerTimer();
  persistentWorker?.terminate();
  persistentWorker = null;
}

function scheduleIdleWorkerDisposal(): void {
  clearIdleWorkerTimer();
  idleWorkerTimer = setTimeout(() => {
    idleWorkerTimer = null;
    if (pendingRequest === null) disposePersistentWorker();
  }, CHUNKED_SAVE_WORKER_IDLE_TIMEOUT_MS);
}

async function settlePendingRequest(
  response: ChunkedSaveJournalWorkerResponse,
): Promise<void> {
  const pending = pendingRequest;
  if (!pending || response.id !== pending.id) return;
  clearTimeout(pending.timeout);
  try {
    if (response.commit) {
      pending.resolve(await commitChunkedSaveJournal(response.commit));
    } else {
      const failure = new Error(response.error ?? "分块增量存档 Worker 失败") as ChunkedSaveTransferFailure;
      failure.sourceStateTransfer = response.sourceStateTransfer;
      pending.reject(failure);
    }
  } catch (error) {
    pending.reject(error instanceof Error ? error : new Error("分块增量存档提交失败"));
  } finally {
    if (pendingRequest === pending) pendingRequest = null;
    // Reusing one Worker keeps Chromium from creating a fresh V8 isolate and
    // retaining another allocator arena after every 30-second autosave.
    scheduleIdleWorkerDisposal();
  }
}

function failPendingRequest(message: string): void {
  const pending = pendingRequest;
  pendingRequest = null;
  if (pending) {
    clearTimeout(pending.timeout);
    pending.reject(new Error(message));
  }
  disposePersistentWorker();
}

function getPersistentWorker(): Worker {
  if (persistentWorker) return persistentWorker;
  const worker = new Worker(new URL("./chunkedSaveJournal.worker.ts", import.meta.url), { type: "module" });
  worker.onmessage = (event: MessageEvent<ChunkedSaveJournalWorkerResponse>) => { void settlePendingRequest(event.data); };
  worker.onerror = (event) => failPendingRequest(event.message || "分块增量存档 Worker 崩溃");
  persistentWorker = worker;
  return worker;
}

/** Test-only lifecycle reset. Production callers never need to terminate the
 * shared worker explicitly; navigation tears it down with the page. */
export function resetChunkedSaveJournalWorkerForTest(): void {
  const pending = pendingRequest;
  pendingRequest = null;
  if (pending) {
    clearTimeout(pending.timeout);
    pending.reject(new Error("分块增量存档 Worker 已重置"));
  }
  disposePersistentWorker();
  workerSequence = 0;
}

export async function persistChunkedSaveJournalFromTransfer(
  stateTransfer: SimulationStateTransfer,
  checkpointOverlay: AuthoritativeSaveCheckpointOverlay | undefined,
  contentPackRegistry: ContentPackRegistry,
  options: PersistChunkedSaveOptions,
): Promise<PersistChunkedSaveResult> {
  if (typeof Worker === "undefined") throw new Error("当前环境不支持分块存档 Worker");
  // The App owns primary-save serialization as a single-flight resource. Keep
  // the lower-level client equally strict so an accidental second caller can
  // never retain another detached 77 MB checkpoint while the first is active.
  if (pendingRequest) throw new Error("已有分块增量存档任务正在运行");
  const context = await prepareChunkedSaveJournalContext(options.mode, options.basePrimaryChecksum);
  if (pendingRequest) throw new Error("已有分块增量存档任务正在运行");
  return new Promise((resolve, reject) => {
    clearIdleWorkerTimer();
    const worker = getPersistentWorker();
    const id = ++workerSequence;
    const timeout = setTimeout(() => {
      if (pendingRequest?.id !== id) return;
      failPendingRequest("分块增量存档 Worker 超时");
    }, CHUNKED_SAVE_WORKER_TIMEOUT_MS);
    pendingRequest = { id, timeout, resolve, reject };
    const request: ChunkedSaveJournalWorkerRequest = {
      id,
      stateTransfer,
      checkpointOverlay,
      contentPackRegistry,
      options,
      context,
    };
    worker.postMessage(request, [stateTransfer.buffer]);
  });
}
