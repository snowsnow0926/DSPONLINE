import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const APP_SOURCE = readFileSync(resolve("src/App.tsx"), "utf8");
const DESKTOP_TYPES_SOURCE = readFileSync(resolve("src/desktop.ts"), "utf8");

function sourceBlock(start: string, end: string): string {
  const startIndex = APP_SOURCE.indexOf(start);
  const endIndex = APP_SOURCE.indexOf(end, startIndex + start.length);
  expect(startIndex, `missing source start marker: ${start}`).toBeGreaterThanOrEqual(0);
  expect(endIndex, `missing source end marker: ${end}`).toBeGreaterThan(startIndex);
  return APP_SOURCE.slice(startIndex, endIndex);
}

describe("renderer side of the native player-authority handoff", () => {
  const handoffEffect = sourceBlock(
    "if (!desktopBridge?.onNativePlayerAuthorityHandoffRequest) return;",
    "const cancelPureIdleSettlement = useCallback",
  );

  it("is a response-only main challenge and exposes no renderer-owned start or transfer method", () => {
    expect(DESKTOP_TYPES_SOURCE).toContain("onNativePlayerAuthorityHandoffRequest?:");
    expect(DESKTOP_TYPES_SOURCE).not.toMatch(/startNativePlayerAuthorityHandoff|transferNativePlayerAuthorityOwner/);
    expect(handoffEffect).toContain("desktopBridge.onNativePlayerAuthorityHandoffRequest(handleRequest)");
    expect(APP_SOURCE).toMatch(/if \(nativeAuthorityHandoffRef\.current\) \{[\s\S]*reason: "native-authority-handoff-quiescing"/);
  });

  it("admits prepare only from a quiet exact boundary before invalidating legacy continuations", () => {
    const busyCheck = handoffEffect.indexOf("const initialCounts = inFlightCounts();");
    const fenceChange = handoffEffect.indexOf('reconcileLegacyAuthorityAsyncLeaseFence(\n          legacyAuthorityAsyncLeaseFenceRef.current,\n          "native"');
    const workerStop = handoffEffect.indexOf("stopLegacySimulationWorker();");
    const drain = handoffEffect.indexOf("await waitUntilDrained(request.timeoutMs, shadowQueue)");
    expect(busyCheck).toBeGreaterThanOrEqual(0);
    expect(fenceChange).toBeGreaterThan(busyCheck);
    expect(workerStop).toBeGreaterThan(fenceChange);
    expect(drain).toBeGreaterThan(workerStop);
    expect(handoffEffect).toMatch(/initialCounts\.renderer !== 0 \|\| initialCounts\.worker !== 0/);
    expect(handoffEffect).toMatch(/renderer: Number\(verifiedPrimarySaveInFlightDepthRef\.current > 0\)[\s\S]*cloudAutoSyncInFlightRef\.current/);
    expect(handoffEffect).toMatch(/worker: Number\(Boolean\(simulationSubmissionRef\.current\)\)[\s\S]*simulationAuthorityReplacementRef\.current/);
  });

  it("never abandons pure idle and binds prepare to the current v47 normal shadow", () => {
    expect(handoffEffect).toMatch(/pureIdleMacroActiveRef\.current \|\| pureIdleStoppingRef\.current[\s\S]*gameRef\.current\.timeWarp\.enabled/);
    expect(handoffEffect).toMatch(/nativeSnapshot\.summary\?\.revision !== request\.initialRevision/);
    expect(handoffEffect).toContain('["shadow", "native-ready"].includes(nativeSnapshot.authority.phase)');
  });

  it("persists lease and journal before ACK and binds the final checkpoint/fences/deadline", () => {
    const acquire = handoffEffect.indexOf("await acquireLocalSaveNativeAuthorityHandoff({");
    const browserFenced = handoffEffect.indexOf('latest.phase = "browser-fenced";');
    const ack = handoffEffect.indexOf('kind: "native-player-authority-browser-fenced-v1"');
    expect(acquire).toBeGreaterThanOrEqual(0);
    expect(browserFenced).toBeGreaterThan(acquire);
    expect(ack).toBeGreaterThan(browserFenced);
    expect(handoffEffect).toMatch(/request\.settledDeadlineMs !== current\.settledDeadlineMs/);
    expect(handoffEffect).toMatch(/nativeSnapshot\.summary\?\.revision !== request\.revision/);
    expect(handoffEffect).toMatch(/nativeSnapshot\.summary\.coverage\.authorityEligible !== true/);
    expect(handoffEffect).toMatch(/afterAcquire\.renderer !== 0 \|\| afterAcquire\.worker !== 0/);
  });

  it("hands the browser fence back only for an exact explicit pre-transfer release", () => {
    const releaseBranch = handoffEffect.slice(handoffEffect.indexOf(
      'request.kind === "native-player-authority-browser-fence-release-v1"',
    ));
    expect(releaseBranch).toMatch(/current\.phase !== "browser-fenced" \|\| request\.releaseAuthorized !== true/);
    expect(releaseBranch).toContain("sameCheckpoint(request.checkpoint, current.checkpoint)");
    expect(releaseBranch).toContain("await releaseLocalSaveNativeAuthorityHandoff({");
    expect(releaseBranch.indexOf("resumeJavaScriptAfterPreTransferBlock();")).toBeGreaterThan(
      releaseBranch.indexOf("await releaseLocalSaveNativeAuthorityHandoff({"),
    );
  });
});
