"use strict";

/*
 * Challenge/response transport for the main-owned player-authority handoff.
 *
 * The renderer receives only main-generated requests and can only answer a
 * request that is currently pending for its own WebContents.  There is no
 * renderer invoke/handle that starts a handoff or transfers a native owner.
 */

const REQUEST_CHANNEL = "desktop:native-player-authority-handoff-request";
const RESPONSE_CHANNEL = "desktop:native-player-authority-handoff-response";
const RENDERER_READY_CHANNEL = "desktop:native-player-authority-handoff-renderer-ready";
const RENDERER_READY_KIND = "native-player-authority-handoff-renderer-ready-v1";
const RESPONSE_KIND = "native-player-authority-handoff-renderer-response-v1";
const PREPARE_REQUEST_KIND = "native-player-authority-quiescence-prepare-v1";
const PREPARED_RESULT_KIND = "native-player-authority-quiescence-prepared-v1";
const COMMIT_REQUEST_KIND = "native-player-authority-quiescence-request-v1";
const COMMITTED_RESULT_KIND = "native-player-authority-browser-fenced-v1";
const CANCEL_REQUEST_KIND = "native-player-authority-quiescence-cancel-v1";
const CANCELLED_RESULT_KIND = "native-player-authority-quiescence-cancelled-v1";
const RELEASE_REQUEST_KIND = "native-player-authority-browser-fence-release-v1";
const RELEASED_RESULT_KIND = "native-player-authority-browser-fence-released-v1";
const COMPLETE_REQUEST_KIND = "native-player-authority-handoff-complete-v1";
const COMPLETED_RESULT_KIND = "native-player-authority-handoff-completed-v1";
const STARTUP_RECONCILE_REQUEST_KIND = "native-player-authority-startup-reconcile-v1";
const STARTUP_RECONCILED_RESULT_KIND = "native-player-authority-startup-reconciled-v1";
const TERMINAL_STARTUP_RECONCILE_ACTIONS = new Set([
  "resumed-native", "released-browser-fence", "no-browser-fence",
]);

const LOGICAL_ID_PATTERN = /^[A-Za-z0-9_.:-]+$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

class NativePlayerAuthorityHandoffIpcError extends Error {
  constructor(message, code, cause) {
    super(message);
    this.name = "NativePlayerAuthorityHandoffIpcError";
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

function protocolError(message, code = "NATIVE_PLAYER_AUTHORITY_HANDOFF_IPC_INVALID", cause) {
  return new NativePlayerAuthorityHandoffIpcError(message, code, cause);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys, label) {
  if (!isRecord(value) || Reflect.ownKeys(value).some((key) =>
    typeof key !== "string" || !keys.includes(key)) || keys.some((key) => !Object.hasOwn(value, key))) {
    throw protocolError(`${label} is invalid`);
  }
  return value;
}

function logicalId(value, label, maximumLength = 128) {
  if (typeof value !== "string" || value.length < 1 || value.length > maximumLength ||
      !LOGICAL_ID_PATTERN.test(value)) throw protocolError(`${label} is invalid`);
  return value;
}

function validLogicalId(value, maximumLength = 128) {
  return typeof value === "string" && value.length >= 1 && value.length <= maximumLength &&
    LOGICAL_ID_PATTERN.test(value);
}

function safeInteger(value, minimum, label) {
  if (!Number.isSafeInteger(value) || value < minimum) throw protocolError(`${label} is invalid`);
  return value;
}

function checkpoint(value, label) {
  const source = exactKeys(value, ["generation", "rootHash", "revision"], label);
  if (typeof source.rootHash !== "string" || !SHA256_PATTERN.test(source.rootHash)) {
    throw protocolError(`${label}.rootHash is invalid`);
  }
  return Object.freeze({
    generation: safeInteger(source.generation, 1, `${label}.generation`),
    rootHash: source.rootHash,
    revision: safeInteger(source.revision, 0, `${label}.revision`),
  });
}

function writerFence(value, label) {
  const source = exactKeys(value, ["ownerId", "fencingToken"], label);
  return Object.freeze({
    ownerId: logicalId(source.ownerId, `${label}.ownerId`, 200),
    fencingToken: safeInteger(source.fencingToken, 1, `${label}.fencingToken`),
  });
}

function sameCheckpoint(left, right) {
  return left.generation === right.generation && left.rootHash === right.rootHash &&
    left.revision === right.revision;
}

function sameFence(left, right) {
  return left.ownerId === right.ownerId && left.fencingToken === right.fencingToken;
}

function normalizePreparedResult(value, request) {
  const source = exactKeys(value, [
    "kind", "publicWriterFence", "rendererInFlightCoreOperations",
    "workerInFlightCoreOperations", "settledDeadlineMs",
  ], "renderer quiescence prepared result");
  if (source.kind !== PREPARED_RESULT_KIND || source.rendererInFlightCoreOperations !== 0 ||
      source.workerInFlightCoreOperations !== 0) {
    throw protocolError("renderer did not reach the requested quiescence boundary");
  }
  return Object.freeze({
    kind: PREPARED_RESULT_KIND,
    handoffId: request.handoffId,
    publicWriterFence: writerFence(source.publicWriterFence, "prepared publicWriterFence"),
    rendererInFlightCoreOperations: 0,
    workerInFlightCoreOperations: 0,
    settledDeadlineMs: safeInteger(source.settledDeadlineMs, 0, "prepared settledDeadlineMs"),
  });
}

function normalizeLeaseReceipt(value, request, previousWriterFence) {
  const source = exactKeys(value, [
    "kind", "leaseId", "previousWriterFence", "nativeWriterFence",
  ], "browser-fence lease receipt");
  const previous = writerFence(source.previousWriterFence, "lease receipt previousWriterFence");
  const native = writerFence(source.nativeWriterFence, "lease receipt nativeWriterFence");
  if (source.kind !== "local-save-native-authority-lease-v1" || source.leaseId !== request.runId ||
      !sameFence(previous, previousWriterFence) ||
      native.ownerId !== `native_authority:${request.runId}` ||
      native.fencingToken !== previous.fencingToken + 1) {
    throw protocolError("browser-fence lease receipt is not bound to the handoff");
  }
  return Object.freeze({
    kind: source.kind,
    leaseId: source.leaseId,
    previousWriterFence: previous,
    nativeWriterFence: native,
  });
}

function normalizeBrowserFencedJournal(value, request, leaseReceipt) {
  const source = exactKeys(value, [
    "schemaVersion", "kind", "runId", "sessionId", "stateVersion", "mode", "checkpoint",
    "previousWriterFence", "nativeWriterFence", "phase", "createdAt",
  ], "browser-fence journal");
  const boundCheckpoint = checkpoint(source.checkpoint, "browser-fence journal checkpoint");
  const previous = writerFence(source.previousWriterFence, "browser-fence journal previousWriterFence");
  const native = writerFence(source.nativeWriterFence, "browser-fence journal nativeWriterFence");
  if (source.schemaVersion !== 1 || source.kind !== "local-save-native-authority-handoff-journal-v1" ||
      source.runId !== request.runId || source.sessionId !== request.sessionId ||
      source.stateVersion !== 47 || source.mode !== "normal" || source.phase !== "browser-fenced" ||
      !Number.isSafeInteger(source.createdAt) || source.createdAt < 0 ||
      !sameCheckpoint(boundCheckpoint, request.checkpoint) ||
      !sameFence(previous, leaseReceipt.previousWriterFence) ||
      !sameFence(native, leaseReceipt.nativeWriterFence)) {
    throw protocolError("browser-fence journal is not bound to the handoff");
  }
  return Object.freeze({
    schemaVersion: 1,
    kind: source.kind,
    runId: source.runId,
    sessionId: source.sessionId,
    stateVersion: 47,
    mode: "normal",
    checkpoint: boundCheckpoint,
    previousWriterFence: previous,
    nativeWriterFence: native,
    phase: "browser-fenced",
    createdAt: source.createdAt,
  });
}

function normalizeBrowserFencedResult(value, request) {
  const source = exactKeys(value, [
    "kind", "leaseReceipt", "journal", "rendererInFlightCoreOperations",
    "workerInFlightCoreOperations",
  ], "renderer browser-fenced result");
  if (source.kind !== COMMITTED_RESULT_KIND || source.rendererInFlightCoreOperations !== 0 ||
      source.workerInFlightCoreOperations !== 0) {
    throw protocolError("renderer browser fence was not committed at zero in-flight work");
  }
  const previousWriterFence = writerFence(request.publicWriterFence, "request publicWriterFence");
  const receipt = normalizeLeaseReceipt(source.leaseReceipt, request, previousWriterFence);
  const journal = normalizeBrowserFencedJournal(source.journal, request, receipt);
  return Object.freeze({
    kind: COMMITTED_RESULT_KIND,
    leaseReceipt: receipt,
    journal,
    rendererInFlightCoreOperations: 0,
    workerInFlightCoreOperations: 0,
  });
}

function normalizeCancelledResult(value) {
  const source = exactKeys(value, ["kind", "resumedJavaScript"], "renderer quiescence cancel result");
  if (source.kind !== CANCELLED_RESULT_KIND || source.resumedJavaScript !== true) {
    throw protocolError("renderer did not acknowledge JavaScript authority resumption");
  }
  return Object.freeze({ kind: CANCELLED_RESULT_KIND, resumedJavaScript: true });
}

function normalizeReleasedResult(value, request) {
  const source = exactKeys(value, ["kind", "released", "returnedWriterFence"], "browser-fence release result");
  if (source.kind !== RELEASED_RESULT_KIND || source.released !== true) {
    throw protocolError("renderer did not acknowledge browser-fence release");
  }
  const returnedWriterFence = writerFence(source.returnedWriterFence, "returnedWriterFence");
  const nativeWriterFence = writerFence(request.receipt?.nativeWriterFence, "release nativeWriterFence");
  const previousWriterFence = writerFence(request.receipt?.previousWriterFence, "release previousWriterFence");
  if (returnedWriterFence.ownerId !== previousWriterFence.ownerId ||
      returnedWriterFence.ownerId.startsWith("native_authority:") ||
      returnedWriterFence.fencingToken !== nativeWriterFence.fencingToken + 1) {
    throw protocolError("browser-fence release receipt does not advance the writer token");
  }
  return Object.freeze({ kind: RELEASED_RESULT_KIND, released: true, returnedWriterFence });
}

function normalizeCompletedResult(value, request) {
  const source = exactKeys(value, [
    "kind", "sessionId", "runId", "revision", "checkpoint", "nativeWriterFence",
    "rendererInFlightCoreOperations", "workerInFlightCoreOperations", "controllerPhase",
  ], "renderer authority completion result");
  const completedCheckpoint = checkpoint(source.checkpoint, "completed checkpoint");
  const completedFence = writerFence(source.nativeWriterFence, "completed nativeWriterFence");
  const requestedCheckpoint = checkpoint(request.checkpoint, "completion request checkpoint");
  const requestedFence = writerFence(request.nativeWriterFence, "completion request nativeWriterFence");
  if (source.kind !== COMPLETED_RESULT_KIND || source.sessionId !== request.sessionId ||
      source.runId !== request.runId || source.revision !== request.revision ||
      source.revision !== completedCheckpoint.revision ||
      !sameCheckpoint(completedCheckpoint, requestedCheckpoint) ||
      !sameFence(completedFence, requestedFence) ||
      source.rendererInFlightCoreOperations !== 0 || source.workerInFlightCoreOperations !== 0 ||
      source.controllerPhase !== "native-authoritative") {
    throw protocolError("renderer authority completion is not bound to the active Rust lease");
  }
  return Object.freeze({
    kind: COMPLETED_RESULT_KIND,
    sessionId: source.sessionId,
    runId: source.runId,
    revision: source.revision,
    checkpoint: completedCheckpoint,
    nativeWriterFence: completedFence,
    rendererInFlightCoreOperations: 0,
    workerInFlightCoreOperations: 0,
    controllerPhase: "native-authoritative",
  });
}

function normalizeStartupReconciledResult(value, request) {
  const source = exactKeys(value, [
    "kind", "action", "rendererInFlightCoreOperations", "workerInFlightCoreOperations",
  ], "renderer startup reconciliation result");
  const allowed = request.rustLease?.state === "active"
    ? new Set(["resumed-native", "fail-closed"])
    : request.rustLease?.state === "absent"
      ? new Set(["released-browser-fence", "no-browser-fence", "fail-closed"])
      : new Set(["fail-closed"]);
  if (source.kind !== STARTUP_RECONCILED_RESULT_KIND || !allowed.has(source.action) ||
      source.rendererInFlightCoreOperations !== 0 || source.workerInFlightCoreOperations !== 0) {
    throw protocolError("renderer startup reconciliation result conflicts with Rust observation");
  }
  return Object.freeze({
    kind: STARTUP_RECONCILED_RESULT_KIND,
    action: source.action,
    rendererInFlightCoreOperations: 0,
    workerInFlightCoreOperations: 0,
  });
}

function startupReconciliationIsTerminalResolved(result) {
  return isRecord(result) && result.kind === STARTUP_RECONCILED_RESULT_KIND &&
    TERMINAL_STARTUP_RECONCILE_ACTIONS.has(result.action);
}

const DEFAULT_RETRY_DELAYS_MS = Object.freeze([0, 25, 100, 250, 500, 1_000, 2_000]);

function boundedErrorCode(error, fallback) {
  return typeof error?.code === "string" && error.code.length <= 128 &&
    LOGICAL_ID_PATTERN.test(error.code) ? error.code : fallback;
}

/**
 * Main-process-only retry state machine for startup reconciliation and the
 * post-transfer completion ACK. A renderer-ready signal may start it, but the
 * renderer cannot select an authority identity or drive an individual retry.
 */
class NativePlayerAuthorityBoundedRetryCoordinator {
  constructor(options) {
    if (!isRecord(options) || typeof options.operation !== "function" ||
        typeof options.isTerminalResult !== "function" ||
        typeof options.isOwnerAvailable !== "function" ||
        options.shouldRetryError !== undefined && typeof options.shouldRetryError !== "function" ||
        options.schedule !== undefined && typeof options.schedule !== "function" ||
        options.cancel !== undefined && typeof options.cancel !== "function") {
      throw new TypeError("native player-authority retry coordinator options are invalid");
    }
    const retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    if (!Array.isArray(retryDelaysMs) || retryDelaysMs.length < 1 || retryDelaysMs.length > 16 ||
        retryDelaysMs.some((delay) => !Number.isSafeInteger(delay) || delay < 0 || delay > 60_000)) {
      throw new TypeError("native player-authority retry delays are invalid");
    }
    this.operation = options.operation;
    this.isTerminalResult = options.isTerminalResult;
    this.isOwnerAvailable = options.isOwnerAvailable;
    this.shouldRetryError = options.shouldRetryError ?? (() => true);
    this.schedule = options.schedule ?? setTimeout;
    this.cancel = options.cancel ?? clearTimeout;
    this.retryDelaysMs = Object.freeze([...retryDelaysMs]);
    this.generation = 0;
    this.timer = null;
    this.completion = null;
    this.resolveCompletion = null;
    this.rejectCompletion = null;
    this.result = null;
    this.state = Object.freeze({
      phase: "recovery-blocked",
      rendererOwnerId: null,
      attempt: 0,
      retryDelayMs: null,
      lastErrorCode: "NATIVE_PLAYER_AUTHORITY_RETRY_NOT_STARTED",
    });
  }

  snapshot() {
    return this.state;
  }

  start(rendererOwnerId) {
    if (!Number.isSafeInteger(rendererOwnerId) || rendererOwnerId < 1) {
      return Promise.reject(protocolError("native player-authority retry owner is invalid"));
    }
    if (this.state.rendererOwnerId === rendererOwnerId &&
        this.state.phase === "retry-pending" && this.completion) {
      return this.completion;
    }
    if (this.state.phase === "retry-pending" && this.state.rendererOwnerId !== rendererOwnerId) {
      return Promise.reject(protocolError(
        "native player-authority retry already belongs to another renderer",
        "NATIVE_PLAYER_AUTHORITY_RETRY_ALREADY_STARTED",
      ));
    }
    this.clearTimer();
    const generation = ++this.generation;
    this.result = null;
    this.completion = new Promise((resolve, reject) => {
      this.resolveCompletion = resolve;
      this.rejectCompletion = reject;
    });
    this.state = Object.freeze({
      phase: "retry-pending",
      rendererOwnerId,
      attempt: 0,
      retryDelayMs: 0,
      lastErrorCode: null,
    });
    this.scheduleAttempt(generation, 0);
    return this.completion;
  }

  cancelOwner(rendererOwnerId, reason = "renderer owner is unavailable") {
    if (this.state.rendererOwnerId !== rendererOwnerId || this.state.phase !== "retry-pending") return false;
    this.block(
      protocolError(reason, "NATIVE_PLAYER_AUTHORITY_HANDOFF_RENDERER_UNAVAILABLE"),
      ++this.generation,
      rendererOwnerId,
    );
    return true;
  }

  shutdown() {
    const ownerId = this.state.rendererOwnerId;
    if (this.state.phase !== "retry-pending" || ownerId === null) {
      this.clearTimer();
      return false;
    }
    this.block(
      protocolError("native player-authority retry stopped during process exit", "NATIVE_PLAYER_AUTHORITY_RETRY_SHUTDOWN"),
      ++this.generation,
      ownerId,
    );
    return true;
  }

  clearTimer() {
    if (this.timer !== null) this.cancel(this.timer);
    this.timer = null;
  }

  scheduleAttempt(generation, delayMs) {
    this.clearTimer();
    this.timer = this.schedule(() => {
      this.timer = null;
      void this.runAttempt(generation);
    }, delayMs);
  }

  scheduleRetry(generation, rendererOwnerId, attempt, errorCode) {
    if (generation !== this.generation || this.state.rendererOwnerId !== rendererOwnerId) return;
    const delayMs = this.retryDelaysMs[Math.min(attempt, this.retryDelaysMs.length - 1)];
    this.state = Object.freeze({
      phase: "retry-pending",
      rendererOwnerId,
      attempt,
      retryDelayMs: delayMs,
      lastErrorCode: errorCode,
    });
    this.scheduleAttempt(generation, delayMs);
  }

  block(error, generation, rendererOwnerId) {
    if (generation !== this.generation || this.state.rendererOwnerId !== rendererOwnerId) return;
    this.clearTimer();
    this.state = Object.freeze({
      phase: "recovery-blocked",
      rendererOwnerId,
      attempt: this.state.attempt,
      retryDelayMs: null,
      lastErrorCode: boundedErrorCode(error, "NATIVE_PLAYER_AUTHORITY_RETRY_BLOCKED"),
    });
    const reject = this.rejectCompletion;
    this.resolveCompletion = null;
    this.rejectCompletion = null;
    reject?.(error);
  }

  async runAttempt(generation) {
    const rendererOwnerId = this.state.rendererOwnerId;
    if (generation !== this.generation || this.state.phase !== "retry-pending" ||
        rendererOwnerId === null) return;
    if (!this.isOwnerAvailable(rendererOwnerId)) {
      this.block(protocolError(
        "renderer owner disappeared during native player-authority retry",
        "NATIVE_PLAYER_AUTHORITY_HANDOFF_RENDERER_UNAVAILABLE",
      ), generation, rendererOwnerId);
      return;
    }
    const attempt = this.state.attempt + 1;
    this.state = Object.freeze({
      phase: "retry-pending",
      rendererOwnerId,
      attempt,
      retryDelayMs: null,
      lastErrorCode: this.state.lastErrorCode,
    });
    try {
      const result = await this.operation(rendererOwnerId);
      if (generation !== this.generation || this.state.rendererOwnerId !== rendererOwnerId) return;
      if (!this.isTerminalResult(result)) {
        this.scheduleRetry(
          generation,
          rendererOwnerId,
          attempt,
          "NATIVE_PLAYER_AUTHORITY_RECONCILE_NON_TERMINAL",
        );
        return;
      }
      this.clearTimer();
      this.result = result;
      this.state = Object.freeze({
        phase: "terminal",
        rendererOwnerId,
        attempt,
        retryDelayMs: null,
        lastErrorCode: null,
      });
      const resolve = this.resolveCompletion;
      this.resolveCompletion = null;
      this.rejectCompletion = null;
      resolve?.(result);
    } catch (error) {
      if (generation !== this.generation || this.state.rendererOwnerId !== rendererOwnerId) return;
      if (!this.isOwnerAvailable(rendererOwnerId) || !this.shouldRetryError(error)) {
        this.block(error, generation, rendererOwnerId);
        return;
      }
      this.scheduleRetry(
        generation,
        rendererOwnerId,
        attempt,
        boundedErrorCode(error, "NATIVE_PLAYER_AUTHORITY_RETRY_FAILED"),
      );
    }
  }
}

function normalizeResultForRequest(value, request) {
  switch (request.kind) {
    case PREPARE_REQUEST_KIND: return normalizePreparedResult(value, request);
    case COMMIT_REQUEST_KIND: return normalizeBrowserFencedResult(value, request);
    case CANCEL_REQUEST_KIND: return normalizeCancelledResult(value);
    case RELEASE_REQUEST_KIND: return normalizeReleasedResult(value, request);
    case COMPLETE_REQUEST_KIND: return normalizeCompletedResult(value, request);
    case STARTUP_RECONCILE_REQUEST_KIND: return normalizeStartupReconciledResult(value, request);
    default: throw protocolError("native player-authority handoff request kind is invalid");
  }
}

class NativePlayerAuthorityHandoffIpcBridge {
  constructor(options) {
    if (!isRecord(options) || typeof options.getRenderer !== "function" ||
        options.schedule !== undefined && typeof options.schedule !== "function" ||
        options.cancel !== undefined && typeof options.cancel !== "function") {
      throw new TypeError("native player-authority handoff IPC bridge options are invalid");
    }
    this.getRenderer = options.getRenderer;
    this.schedule = options.schedule ?? setTimeout;
    this.cancel = options.cancel ?? clearTimeout;
    this.pending = null;
  }

  request(rendererOwnerId, request, timeoutMs) {
    if (this.pending) {
      return Promise.reject(protocolError(
        "another renderer handoff request is already pending",
        "NATIVE_PLAYER_AUTHORITY_HANDOFF_IPC_BUSY",
      ));
    }
    if ((!Number.isSafeInteger(rendererOwnerId) || rendererOwnerId < 1) ||
        !isRecord(request) || !validLogicalId(request.handoffId) ||
        !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      return Promise.reject(protocolError("renderer handoff request is invalid"));
    }
    const renderer = this.getRenderer(rendererOwnerId);
    if (!renderer || renderer.id !== rendererOwnerId ||
        typeof renderer.send !== "function" || renderer.isDestroyed?.() === true) {
      return Promise.reject(protocolError(
        "renderer handoff target is unavailable",
        "NATIVE_PLAYER_AUTHORITY_HANDOFF_RENDERER_UNAVAILABLE",
      ));
    }
    let resolveRequest;
    let rejectRequest;
    const promise = new Promise((resolve, reject) => {
      resolveRequest = resolve;
      rejectRequest = reject;
    });
    const timer = this.schedule(() => {
      if (!this.pending || this.pending.handoffId !== request.handoffId ||
          this.pending.requestKind !== request.kind) return;
      this.pending = null;
      rejectRequest(protocolError(
        "renderer handoff request timed out",
        "NATIVE_PLAYER_AUTHORITY_HANDOFF_IPC_TIMEOUT",
      ));
    }, timeoutMs);
    this.pending = {
      rendererOwnerId,
      handoffId: request.handoffId,
      requestKind: request.kind,
      request,
      timer,
      resolve: resolveRequest,
      reject: rejectRequest,
    };
    try {
      renderer.send(REQUEST_CHANNEL, Object.freeze({ ...request }));
    } catch (cause) {
      this.cancel(timer);
      this.pending = null;
      rejectRequest(protocolError(
        "renderer handoff request could not be sent",
        "NATIVE_PLAYER_AUTHORITY_HANDOFF_RENDERER_UNAVAILABLE",
        cause,
      ));
    }
    return promise;
  }

  accept(event, envelope) {
    const pending = this.pending;
    if (!pending || event?.sender?.id !== pending.rendererOwnerId || !isRecord(envelope) ||
        envelope.kind !== RESPONSE_KIND || envelope.handoffId !== pending.handoffId ||
        envelope.requestKind !== pending.requestKind) return false;
    this.cancel(pending.timer);
    this.pending = null;
    try {
      exactKeys(envelope, envelope.ok === true
        ? ["kind", "handoffId", "requestKind", "ok", "value"]
        : ["kind", "handoffId", "requestKind", "ok", "errorCode"],
      "renderer handoff response");
      if (envelope.ok !== true) {
        throw protocolError(
          "renderer rejected the handoff request",
          logicalId(envelope.errorCode, "renderer handoff error code", 128),
        );
      }
      pending.resolve(normalizeResultForRequest(envelope.value, pending.request));
    } catch (error) {
      pending.reject(error);
    }
    return true;
  }

  cancelOwner(rendererOwnerId, reason = "renderer closed during native player-authority handoff") {
    const pending = this.pending;
    if (!pending || pending.rendererOwnerId !== rendererOwnerId) return false;
    this.cancel(pending.timer);
    this.pending = null;
    pending.reject(protocolError(
      reason,
      "NATIVE_PLAYER_AUTHORITY_HANDOFF_RENDERER_UNAVAILABLE",
    ));
    return true;
  }
}

function subscribeRendererToNativePlayerAuthorityHandoff(ipcRenderer, listener) {
  if (!ipcRenderer || typeof ipcRenderer.on !== "function" || typeof ipcRenderer.send !== "function" ||
      typeof ipcRenderer.removeListener !== "function" || typeof listener !== "function") {
    throw new TypeError("native player-authority renderer subscription is invalid");
  }
  let active = true;
  const handler = (_event, request) => {
    if (!active || !isRecord(request) || !validLogicalId(request.handoffId)) return;
    Promise.resolve().then(() => listener(request)).then((value) => {
      if (!active) return;
      ipcRenderer.send(RESPONSE_CHANNEL, {
        kind: RESPONSE_KIND,
        handoffId: request.handoffId,
        requestKind: request.kind,
        ok: true,
        value,
      });
    }, (error) => {
      if (!active) return;
      const rawCode = typeof error?.code === "string" && LOGICAL_ID_PATTERN.test(error.code) &&
        error.code.length <= 128 ? error.code : "NATIVE_PLAYER_AUTHORITY_RENDERER_QUIESCENCE_FAILED";
      ipcRenderer.send(RESPONSE_CHANNEL, {
        kind: RESPONSE_KIND,
        handoffId: request.handoffId,
        requestKind: request.kind,
        ok: false,
        errorCode: rawCode,
      });
    });
  };
  ipcRenderer.on(REQUEST_CHANNEL, handler);
  // This carries no lease/session/owner identity and cannot start or approve a
  // transfer. It only tells main that a response listener now exists, so main
  // can generate the one-shot startup reconciliation challenge itself.
  ipcRenderer.send(RENDERER_READY_CHANNEL, Object.freeze({ kind: RENDERER_READY_KIND }));
  return () => {
    if (!active) return;
    active = false;
    ipcRenderer.removeListener(REQUEST_CHANNEL, handler);
  };
}

module.exports = {
  CANCELLED_RESULT_KIND,
  CANCEL_REQUEST_KIND,
  COMMITTED_RESULT_KIND,
  COMMIT_REQUEST_KIND,
  COMPLETE_REQUEST_KIND,
  COMPLETED_RESULT_KIND,
  NativePlayerAuthorityBoundedRetryCoordinator,
  NativePlayerAuthorityHandoffIpcBridge,
  NativePlayerAuthorityHandoffIpcError,
  PREPARED_RESULT_KIND,
  PREPARE_REQUEST_KIND,
  RELEASED_RESULT_KIND,
  RELEASE_REQUEST_KIND,
  RENDERER_READY_CHANNEL,
  RENDERER_READY_KIND,
  REQUEST_CHANNEL,
  RESPONSE_CHANNEL,
  STARTUP_RECONCILE_REQUEST_KIND,
  STARTUP_RECONCILED_RESULT_KIND,
  startupReconciliationIsTerminalResolved,
  subscribeRendererToNativePlayerAuthorityHandoff,
};
