import { describe, expect, it } from "vitest";
import {
  canResumeLegacyInteractionAfterAwait,
  createNativeAuthorityInteractionEpoch,
  reconcileNativeAuthorityInteractionEpoch,
} from "./nativeAuthorityInteractionEpoch";

describe("native authority interaction epoch", () => {
  it("allows a legacy continuation only while Web authority remains unchanged", () => {
    const web = createNativeAuthorityInteractionEpoch(false);
    expect(canResumeLegacyInteractionAfterAwait(web.epoch, web)).toBe(true);
    expect(reconcileNativeAuthorityInteractionEpoch(web, false)).toBe(web);
  });

  it("invalidates an awaited Web continuation when Rust takes ownership", () => {
    const web = createNativeAuthorityInteractionEpoch(false);
    const native = reconcileNativeAuthorityInteractionEpoch(web, true);
    expect(native).toEqual({ ownsRuntime: true, epoch: 1 });
    expect(canResumeLegacyInteractionAfterAwait(web.epoch, native)).toBe(false);
  });

  it("keeps the old continuation invalid after ownership returns to Web", () => {
    const web = createNativeAuthorityInteractionEpoch(false);
    const native = reconcileNativeAuthorityInteractionEpoch(web, true);
    const returned = reconcileNativeAuthorityInteractionEpoch(native, false);
    expect(returned).toEqual({ ownsRuntime: false, epoch: 2 });
    expect(canResumeLegacyInteractionAfterAwait(web.epoch, returned)).toBe(false);
  });
});
