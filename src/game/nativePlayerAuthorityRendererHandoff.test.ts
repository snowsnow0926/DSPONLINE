import { describe, expect, it } from "vitest";

import {
  classifyNativePlayerAuthorityPreTransferCancel,
  type NativePlayerAuthorityHandoffIdentity,
} from "./nativePlayerAuthorityRendererHandoff";

const identity: NativePlayerAuthorityHandoffIdentity = {
  handoffId: "handoff-1",
  sessionId: "core-1",
  runId: "player-run-1",
};

describe("renderer native player-authority pre-transfer cancellation", () => {
  it("ACKs the same prepared cancellation again after the first response is lost", () => {
    const request = { ...identity, releaseAuthorized: true, browserFenceAcquired: false };
    expect(classifyNativePlayerAuthorityPreTransferCancel({
      request,
      current: { ...identity, phase: "prepared" },
      lastCancelled: null,
    })).toBe("cancel-current-prepare");

    expect(classifyNativePlayerAuthorityPreTransferCancel({
      request,
      current: null,
      lastCancelled: identity,
    })).toBe("already-cancelled");
  });

  it("never treats a browser-fenced/native-active or unapproved request as reversible", () => {
    for (const phase of ["browser-fenced", "native-active"] as const) {
      expect(classifyNativePlayerAuthorityPreTransferCancel({
        request: { ...identity, releaseAuthorized: true, browserFenceAcquired: false },
        current: { ...identity, phase },
        lastCancelled: null,
      })).toBe("reject");
    }
    expect(classifyNativePlayerAuthorityPreTransferCancel({
      request: { ...identity, releaseAuthorized: false, browserFenceAcquired: false },
      current: { ...identity, phase: "prepared" },
      lastCancelled: null,
    })).toBe("reject");
    expect(classifyNativePlayerAuthorityPreTransferCancel({
      request: { ...identity, releaseAuthorized: true, browserFenceAcquired: true },
      current: { ...identity, phase: "prepared" },
      lastCancelled: null,
    })).toBe("reject");
  });

  it("does not let a stale identity reuse another handoff's tombstone", () => {
    expect(classifyNativePlayerAuthorityPreTransferCancel({
      request: { ...identity, handoffId: "handoff-2", releaseAuthorized: true, browserFenceAcquired: false },
      current: null,
      lastCancelled: identity,
    })).toBe("reject");
  });
});
