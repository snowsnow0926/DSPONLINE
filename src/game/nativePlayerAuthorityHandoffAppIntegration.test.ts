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

function effectContaining(marker: string): string {
  const markerIndex = APP_SOURCE.indexOf(marker);
  const startIndex = APP_SOURCE.lastIndexOf("  useEffect(() => {", markerIndex);
  const endIndex = APP_SOURCE.indexOf("\n  },", markerIndex);
  expect(markerIndex, `missing effect marker: ${marker}`).toBeGreaterThanOrEqual(0);
  expect(startIndex, `missing effect start: ${marker}`).toBeGreaterThanOrEqual(0);
  expect(endIndex, `missing effect end: ${marker}`).toBeGreaterThan(markerIndex);
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
    expect(APP_SOURCE).toMatch(/nativeAuthorityHandoffRef\.current\.phase !== "native-active"[\s\S]*reason: "native-authority-handoff-quiescing"/);
    expect(DESKTOP_TYPES_SOURCE).toMatch(/checkpointNativePlayerAuthority\?: \(\) =>/);
    expect(DESKTOP_TYPES_SOURCE).toMatch(/sessionId\?: never;[\s\S]*runId\?: never;/);
  });

  it("admits prepare only from a quiet exact boundary before invalidating legacy continuations", () => {
    const prepare = handoffEffect.slice(handoffEffect.indexOf(
      'request.kind === "native-player-authority-quiescence-prepare-v1"',
    ));
    const busyCheck = prepare.indexOf("const initialCounts = inFlightCounts();");
    const fenceChange = prepare.indexOf('reconcileLegacyAuthorityAsyncLeaseFence(\n          legacyAuthorityAsyncLeaseFenceRef.current,\n          "native"');
    const workerStop = prepare.indexOf("stopLegacySimulationWorker();");
    const drain = prepare.indexOf("await waitUntilDrained(request.timeoutMs, shadowQueue)");
    expect(busyCheck).toBeGreaterThanOrEqual(0);
    expect(fenceChange).toBeGreaterThan(busyCheck);
    expect(workerStop).toBeGreaterThan(fenceChange);
    expect(drain).toBeGreaterThan(workerStop);
    expect(prepare).toMatch(/initialCounts\.renderer !== 0 \|\| initialCounts\.worker !== 0/);
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

  it("formally completes only after the trusted clock, fence, revision, coverage, and controller all match", () => {
    const completion = handoffEffect.slice(handoffEffect.indexOf(
      'request.kind === "native-player-authority-handoff-complete-v1"',
    ));
    const refresh = completion.indexOf("await nativePlayerAuthorityClock.refresh()");
    const active = completion.indexOf("selectActiveNativePlayerAuthorityFrame(");
    const counts = completion.indexOf("const counts = inFlightCounts();");
    const bind = completion.indexOf("controller.bindMainOwnedPlayerAuthority({");
    const nativeActive = completion.indexOf('current.phase = "native-active";');
    expect(refresh).toBeGreaterThanOrEqual(0);
    expect(active).toBeGreaterThan(refresh);
    expect(counts).toBeGreaterThan(active);
    expect(bind).toBeGreaterThan(counts);
    expect(nativeActive).toBeGreaterThan(bind);
    expect(completion).toMatch(/sameCheckpoint\(request\.checkpoint, current\.checkpoint\)/);
    expect(completion).toMatch(/sameFence\(request\.nativeWriterFence, current\.receipt\.nativeWriterFence\)/);
    expect(completion).toMatch(/request\.summary\.coverage\.authorityEligible !== true/);
    expect(completion).toMatch(/counts\.renderer !== 0 \|\| counts\.worker !== 0/);
  });

  it("reconciles startup active/absent/unknown only after stopping and draining legacy work", () => {
    const startup = handoffEffect.slice(
      handoffEffect.indexOf('request.kind === "native-player-authority-startup-reconcile-v1"'),
      handoffEffect.indexOf('request.kind === "native-player-authority-quiescence-prepare-v1"'),
    );
    const invalidate = startup.indexOf("legacyAuthorityAsyncLeaseFenceRef.current = reconcileLegacyAuthorityAsyncLeaseFence(");
    const workerStop = startup.indexOf("stopLegacySimulationWorker();");
    const drain = startup.indexOf("await waitUntilDrained(request.timeoutMs, shadowQueue)");
    const inspect = startup.indexOf("await inspectLocalSaveNativeAuthorityHandoff()");
    expect(invalidate).toBeGreaterThanOrEqual(0);
    expect(workerStop).toBeGreaterThan(invalidate);
    expect(drain).toBeGreaterThan(workerStop);
    expect(inspect).toBeGreaterThan(drain);
    expect(startup).toContain("checkpoint: request.rustLease.entryCheckpoint");
    expect(startup).toContain("reconcileLocalSaveNativeAuthorityHandoff({");
    expect(startup).toContain('decision.action === "release-browser-fence"');
    expect(startup).toContain('action: "fail-closed"');
    expect(startup).toContain('source: "startup-recovery"');
  });

  it("makes prepare and pre-transfer cancel idempotent without making post-transfer release implicit", () => {
    expect(handoffEffect).toMatch(/sameIdentity\(request, existing\) && existing\.phase === "prepared"/);
    expect(handoffEffect).toContain("lastCancelledNativeAuthorityHandoffRef.current");
    expect(handoffEffect).toContain("classifyNativePlayerAuthorityPreTransferCancel({");
    expect(handoffEffect).toContain('disposition === "already-cancelled"');
    expect(handoffEffect).toContain('disposition === "reject"');
  });

  it("never derives legacy achievement or campaign commands from the inert native renderer shell", () => {
    const achievement = effectContaining('measureRuntimeTransitionPhase("achievement-progress-sync"');
    const campaign = effectContaining('measureRuntimeTransitionPhase("campaign-progress-sync"');
    for (const effect of [achievement, campaign]) {
      expect(effect).toContain("if (nativePlayerAuthorityOwnsRuntimeRef.current) return;");
      expect(effect.indexOf("nativePlayerAuthorityOwnsRuntimeRef.current")).toBeLessThan(
        effect.indexOf("measureRuntimeTransitionPhase"),
      );
    }
  });
});
