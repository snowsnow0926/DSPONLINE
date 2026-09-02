"use strict";

/*
 * Main-process-only, fail-closed owner handoff coordinator.
 *
 * This module deliberately has no Electron dependency. The main-process IPC
 * bridge supplies requestQuiescence and an explicit pre-transfer hand-back;
 * neither callback is exposed as a renderer-owned transfer capability.
 */

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const LOGICAL_ID_PATTERN = /^[A-Za-z0-9_.:-]+$/;
const QUIESCENCE_ACK_KIND = "native-player-authority-quiescence-ack-v1";
const OWNER_STATE_KIND = "native-core-session-owner-state-v1";
const OWNER_TRANSFER_KIND = "native-core-session-owner-transfer-v1";
const SAFE_PRE_TRANSFER_CODES = new Set([
  "NATIVE_CORE_SESSION_BUSY",
  "NATIVE_CORE_SESSION_INVALID",
  "NATIVE_CORE_SESSION_TRANSFER_INVALID",
]);

class NativePlayerAuthorityHandoffError extends Error {
  constructor(message, code, cause) {
    super(message);
    this.name = "NativePlayerAuthorityHandoffError";
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

function handoffError(message, code, cause) {
  return new NativePlayerAuthorityHandoffError(message, code, cause);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactObjectKeys(value, keys, label) {
  if (!isRecord(value) || Reflect.ownKeys(value).some((key) => typeof key !== "string" || !keys.includes(key)) ||
      keys.some((key) => !Object.hasOwn(value, key))) {
    throw handoffError(`${label} is invalid`, "NATIVE_PLAYER_AUTHORITY_HANDOFF_INVALID");
  }
}

function requireLogicalId(value, label, maximumLength = 128) {
  if (typeof value !== "string" || value.length < 1 || value.length > maximumLength ||
      !LOGICAL_ID_PATTERN.test(value)) {
    throw handoffError(`${label} is invalid`, "NATIVE_PLAYER_AUTHORITY_HANDOFF_INVALID");
  }
  return value;
}

function requireOwnerId(value, label) {
  if (Number.isSafeInteger(value) && value >= 1) return value;
  return requireLogicalId(value, label);
}

function requireSafeInteger(value, minimum, label) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw handoffError(`${label} is invalid`, "NATIVE_PLAYER_AUTHORITY_HANDOFF_INVALID");
  }
  return value;
}

function normalizeCheckpoint(value, label) {
  exactObjectKeys(value, ["generation", "rootHash", "revision"], label);
  if (typeof value.rootHash !== "string" || !SHA256_PATTERN.test(value.rootHash)) {
    throw handoffError(`${label}.rootHash is invalid`, "NATIVE_PLAYER_AUTHORITY_HANDOFF_INVALID");
  }
  return Object.freeze({
    generation: requireSafeInteger(value.generation, 1, `${label}.generation`),
    rootHash: value.rootHash,
    revision: requireSafeInteger(value.revision, 0, `${label}.revision`),
  });
}

function normalizeWriterFence(value, label) {
  exactObjectKeys(value, ["ownerId", "fencingToken"], label);
  return Object.freeze({
    ownerId: requireLogicalId(value.ownerId, `${label}.ownerId`, 200),
    fencingToken: requireSafeInteger(value.fencingToken, 1, `${label}.fencingToken`),
  });
}

function sameCheckpoint(left, right) {
  return left.generation === right.generation && left.rootHash === right.rootHash &&
    left.revision === right.revision;
}

function sameWriterFence(left, right) {
  return left.ownerId === right.ownerId && left.fencingToken === right.fencingToken;
}

function normalizeRequest(value) {
  exactObjectKeys(value, [
    "handoffId", "sessionId", "runId", "rendererOwnerId", "expectedRevision",
    "expectedCheckpoint", "publicWriterFence", "settledDeadlineMs", "timeoutMs",
  ], "native player-authority handoff request");
  const expectedCheckpoint = normalizeCheckpoint(value.expectedCheckpoint, "expectedCheckpoint");
  const expectedRevision = requireSafeInteger(value.expectedRevision, 0, "expectedRevision");
  if (expectedCheckpoint.revision !== expectedRevision) {
    throw handoffError(
      "expected checkpoint and revision do not identify the same public state",
      "NATIVE_PLAYER_AUTHORITY_HANDOFF_INVALID",
    );
  }
  return Object.freeze({
    handoffId: requireLogicalId(value.handoffId, "handoffId"),
    sessionId: requireLogicalId(value.sessionId, "sessionId"),
    runId: requireLogicalId(value.runId, "runId"),
    rendererOwnerId: requireOwnerId(value.rendererOwnerId, "rendererOwnerId"),
    expectedRevision,
    expectedCheckpoint,
    publicWriterFence: normalizeWriterFence(value.publicWriterFence, "publicWriterFence"),
    settledDeadlineMs: requireSafeInteger(value.settledDeadlineMs, 0, "settledDeadlineMs"),
    timeoutMs: requireSafeInteger(value.timeoutMs, 1, "timeoutMs"),
  });
}

function validateQuiescenceAck(value, request) {
  exactObjectKeys(value, [
    "kind", "handoffId", "sessionId", "runId", "ownerId", "revision", "checkpoint",
    "publicWriterFence", "settledDeadlineMs", "rendererInFlightCoreOperations",
    "workerInFlightCoreOperations",
  ], "native player-authority quiescence ACK");
  const checkpoint = normalizeCheckpoint(value.checkpoint, "quiescence ACK checkpoint");
  const publicWriterFence = normalizeWriterFence(value.publicWriterFence, "quiescence ACK publicWriterFence");
  if (value.kind !== QUIESCENCE_ACK_KIND || value.handoffId !== request.handoffId || value.runId !== request.runId ||
      value.sessionId !== request.sessionId || value.ownerId !== request.rendererOwnerId ||
      value.revision !== request.expectedRevision || !sameCheckpoint(checkpoint, request.expectedCheckpoint) ||
      !sameWriterFence(publicWriterFence, request.publicWriterFence) ||
      value.settledDeadlineMs !== request.settledDeadlineMs ||
      value.rendererInFlightCoreOperations !== 0 || value.workerInFlightCoreOperations !== 0) {
    throw handoffError(
      "renderer/Worker quiescence ACK is stale or does not bind the requested public state",
      "NATIVE_PLAYER_AUTHORITY_HANDOFF_STALE_ACK",
    );
  }
}

function validateOwnerState(value, request) {
  if (!isRecord(value) || value.kind !== OWNER_STATE_KIND || value.sessionId !== request.sessionId ||
      value.ownerId !== request.rendererOwnerId || value.slot !== "normal-main" ||
      !Number.isSafeInteger(value.ownerEpoch) || value.ownerEpoch < 1 ||
      value.state !== "owned" || value.inFlight !== 0) {
    throw handoffError(
      "native session owner is not quiescent at the requested handoff boundary",
      "NATIVE_PLAYER_AUTHORITY_HANDOFF_OWNER_NOT_QUIESCENT",
    );
  }
  return value.ownerEpoch;
}

function validatePreTransferStatus(value, request) {
  if (!isRecord(value) || value.revision !== request.expectedRevision) {
    throw handoffError(
      "native session revision drifted after renderer/Worker quiescence",
      "NATIVE_PLAYER_AUTHORITY_HANDOFF_REVISION_DRIFT",
    );
  }
  if (value.stateVersion !== 47 || value.mode !== "normal" || value.paused !== false ||
      !isRecord(value.coverage) || value.coverage.authorityEligible !== true) {
    throw handoffError(
      "native session does not have complete player-authority coverage",
      "NATIVE_PLAYER_AUTHORITY_HANDOFF_COVERAGE_INCOMPLETE",
    );
  }
}

function validateTransferReceipt(value, request, mainOwnerId, previousOwnerEpoch) {
  if (!isRecord(value) || value.kind !== OWNER_TRANSFER_KIND || value.sessionId !== request.sessionId ||
      value.previousOwnerId !== request.rendererOwnerId || value.ownerId !== mainOwnerId ||
      value.slot !== "normal-main" || value.previousOwnerEpoch !== previousOwnerEpoch ||
      value.ownerEpoch !== previousOwnerEpoch + 1 || value.inFlight !== 0) {
    throw handoffError(
      "native session owner transfer receipt is uncertain",
      "NATIVE_PLAYER_AUTHORITY_HANDOFF_TRANSFER_UNCERTAIN",
    );
  }
  return value.ownerEpoch;
}

function validateActiveSnapshot(value, request) {
  if (!isRecord(value) || value.phase !== "active" || value.sessionId !== request.sessionId ||
      value.runId !== request.runId || value.revision !== request.expectedRevision || value.inFlight !== false) {
    throw handoffError(
      "native player-authority activation result is uncertain",
      "NATIVE_PLAYER_AUTHORITY_HANDOFF_ACTIVATION_UNCERTAIN",
    );
  }
}

function frozenSnapshot(coordinator) {
  return Object.freeze({
    phase: coordinator.phase,
    sessionId: coordinator.context?.sessionId ?? null,
    runId: coordinator.context?.runId ?? null,
    revision: coordinator.context?.expectedRevision ?? null,
    ownerEpoch: coordinator.ownerEpoch,
    inFlight: coordinator.operation !== null,
    lastErrorCode: coordinator.lastError?.code ?? null,
  });
}

class NativePlayerAuthorityHandoffCoordinator {
  constructor(options) {
    if (!isRecord(options) || !options.registry ||
        typeof options.registry.status !== "function" ||
        typeof options.registry.inspectSession !== "function" ||
        typeof options.registry.transferOwner !== "function" ||
        !options.runtime || typeof options.runtime.activate !== "function" ||
        typeof options.requestQuiescence !== "function" ||
        options.releaseQuiescence !== undefined && typeof options.releaseQuiescence !== "function" ||
        options.schedule !== undefined && typeof options.schedule !== "function" ||
        options.cancel !== undefined && typeof options.cancel !== "function" ||
        options.onTransition !== undefined && typeof options.onTransition !== "function") {
      throw new TypeError("native player-authority handoff coordinator options are invalid");
    }
    this.registry = options.registry;
    this.runtime = options.runtime;
    this.requestQuiescence = options.requestQuiescence;
    this.releaseQuiescence = options.releaseQuiescence ?? null;
    this.mainOwnerId = requireLogicalId(options.mainOwnerId ?? "main-player-authority", "mainOwnerId");
    if (options.runtime.ownerId !== undefined && options.runtime.ownerId !== this.mainOwnerId) {
      throw new TypeError("native player-authority handoff runtime owner is invalid");
    }
    this.schedule = options.schedule ?? setTimeout;
    this.cancel = options.cancel ?? clearTimeout;
    this.onTransition = options.onTransition ?? (() => undefined);
    this.phase = "idle";
    this.context = null;
    this.ownerEpoch = null;
    this.operation = null;
    this.lastError = null;
  }

  snapshot() {
    return frozenSnapshot(this);
  }

  transition(phase, error = null) {
    this.phase = phase;
    this.lastError = error;
    const snapshot = this.snapshot();
    this.onTransition(snapshot);
    return snapshot;
  }

  handoff(rawRequest) {
    if (this.phase !== "idle" || this.operation !== null) {
      return Promise.reject(handoffError(
        "native player-authority handoff is single-use and has already started",
        "NATIVE_PLAYER_AUTHORITY_HANDOFF_ALREADY_STARTED",
      ));
    }
    let request;
    try {
      request = normalizeRequest(rawRequest);
    } catch (error) {
      return Promise.reject(error);
    }
    this.context = request;
    this.transition("quiescing");
    let operation;
    operation = this.performHandoff(request).finally(() => {
      if (this.operation === operation) this.operation = null;
    }).then(() => this.snapshot());
    this.operation = operation;
    return operation;
  }

  waitForQuiescence(request) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = this.schedule(() => {
        if (settled) return;
        settled = true;
        reject(handoffError(
          "renderer/Worker quiescence timed out",
          "NATIVE_PLAYER_AUTHORITY_HANDOFF_QUIESCENCE_TIMEOUT",
        ));
      }, request.timeoutMs);
      let requested;
      try {
        requested = this.requestQuiescence(Object.freeze({
          kind: "native-player-authority-quiescence-request-v1",
          handoffId: request.handoffId,
          sessionId: request.sessionId,
          runId: request.runId,
          ownerId: request.rendererOwnerId,
          revision: request.expectedRevision,
          checkpoint: request.expectedCheckpoint,
          publicWriterFence: request.publicWriterFence,
          settledDeadlineMs: request.settledDeadlineMs,
        }));
      } catch (error) {
        settled = true;
        this.cancel(timer);
        reject(error);
        return;
      }
      Promise.resolve(requested).then((value) => {
        if (settled) return;
        settled = true;
        this.cancel(timer);
        resolve(value);
      }, (error) => {
        if (settled) return;
        settled = true;
        this.cancel(timer);
        reject(error);
      });
    });
  }

  async performHandoff(request) {
    let ownershipTransferred = false;
    let transferOutcomeUncertain = false;
    let quiescenceAcknowledged = false;
    try {
      const ack = await this.waitForQuiescence(request);
      validateQuiescenceAck(ack, request);
      quiescenceAcknowledged = true;

      const status = await this.registry.status(request.rendererOwnerId, request.sessionId);
      // Coverage is checked while the renderer still owns the session.  A
      // disabled/incomplete native ruleset therefore cannot strand the public
      // state under main ownership merely by reaching Runtime.activate().
      validatePreTransferStatus(status, request);
      const previousOwnerEpoch = validateOwnerState(
        this.registry.inspectSession(request.rendererOwnerId, request.sessionId),
        request,
      );

      this.transition("transferring");
      let transferReceipt;
      try {
        transferReceipt = this.registry.transferOwner(request.rendererOwnerId, this.mainOwnerId, {
          sessionId: request.sessionId,
          expectedSlot: "normal-main",
          expectedOwnerEpoch: previousOwnerEpoch,
        });
      } catch (error) {
        if (SAFE_PRE_TRANSFER_CODES.has(error?.code)) throw error;
        transferOutcomeUncertain = true;
        throw error;
      }
      ownershipTransferred = true;
      this.ownerEpoch = validateTransferReceipt(
        transferReceipt,
        request,
        this.mainOwnerId,
        previousOwnerEpoch,
      );

      this.transition("activating");
      const active = await this.runtime.activate({
        sessionId: request.sessionId,
        runId: request.runId,
        expectedCheckpoint: request.expectedCheckpoint,
        settledDeadlineMs: request.settledDeadlineMs,
      });
      validateActiveSnapshot(active, request);
      this.transition("active");
    } catch (cause) {
      let releaseFailure = null;
      if (!ownershipTransferred && !transferOutcomeUncertain && quiescenceAcknowledged) {
        if (!this.releaseQuiescence) {
          releaseFailure = handoffError(
            "browser-fence release callback is unavailable",
            "NATIVE_PLAYER_AUTHORITY_HANDOFF_RELEASE_UNCERTAIN",
          );
        } else {
          try {
            await this.releaseQuiescence(Object.freeze({
              kind: "native-player-authority-browser-fence-release-v1",
              handoffId: request.handoffId,
              sessionId: request.sessionId,
              runId: request.runId,
              checkpoint: request.expectedCheckpoint,
              releaseAuthorized: true,
            }));
          } catch (error) {
            // A missing/uncertain hand-back ACK must retain the browser fence.
            // It is never safe to assume that the IndexedDB CAS did not commit.
            releaseFailure = error;
          }
        }
      }
      // Before a validated ACK, main cannot distinguish a rejected request
      // from "IndexedDB committed but the renderer response was lost". Keep
      // the old Rust owner and browser state fenced instead of claiming a
      // reversible block. Only a validated browser-fence ACK plus an explicit
      // releaseAuthorized hand-back can return to the blocked state.
      const faulted = ownershipTransferred || transferOutcomeUncertain ||
        !quiescenceAcknowledged || releaseFailure !== null;
      const error = handoffError(
        faulted
          ? ownershipTransferred || transferOutcomeUncertain
            ? "native player-authority handoff failed after owner transfer; main ownership is retained"
            : !quiescenceAcknowledged
              ? "native player-authority quiescence outcome is uncertain; browser state remains fenced"
              : "native player-authority handoff was blocked but the browser-fence release is uncertain"
          : "native player-authority handoff was blocked before owner transfer",
        faulted ? "NATIVE_PLAYER_AUTHORITY_HANDOFF_FAULTED" : "NATIVE_PLAYER_AUTHORITY_HANDOFF_BLOCKED",
        releaseFailure ?? cause,
      );
      this.transition(faulted ? "faulted" : "blocked", error);
      throw error;
    }
  }
}

module.exports = {
  NativePlayerAuthorityHandoffCoordinator,
  NativePlayerAuthorityHandoffError,
  QUIESCENCE_ACK_KIND,
};
