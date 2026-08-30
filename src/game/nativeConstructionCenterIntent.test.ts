import { describe, expect, it } from "vitest";
import type { NativeConstructionCenterWorkspaceFrame } from "./nativeConstructionCenterWorkspace";
import {
  confirmNativeConstructionCenterTargetStock,
  evaluateNativeConstructionCenterTargetStock,
  nativeConstructionCenterFrameIdentity,
  nativeConstructionCenterIdentityMatchesFrame,
  nativeConstructionCenterTargetPresets,
  parseNativeConstructionCenterTargetDraft,
  type NativeConstructionCenterPendingIdentity,
} from "./nativeConstructionCenterIntent";

function frame(): NativeConstructionCenterWorkspaceFrame {
  return {
    source: "native-authoritative",
    sessionId: "session-a",
    runId: "run-a",
    revision: 19,
    activePlanetId: "home",
    workspace: {
      schema: "construction-center-workspace-v1",
      registryFingerprint: "7df8cf3a",
      readOnly: true,
      writeAvailable: true,
      activePlanetId: "home",
      activePlanetName: "家园星",
      paused: false,
      enabled: true,
      quantumSourceEnabled: false,
      quantumNetworkEnabled: true,
      totalCrafted: 0,
      lastCraftedId: null,
      lastCraftedName: null,
      stockLimit: 500,
      cycleSeconds: 2.5,
      materialSeconds: 0.05,
      targets: {
        rows: [{
          targetId: "wind_turbine",
          name: "风力涡轮机",
          kind: "building",
          category: "power",
          target: 100,
          currentStock: 80,
          unlocked: true,
          requiredTechId: "electromagnetism",
          requiredTechName: "电磁学",
          outputAmount: 1,
          costs: { rows: [], totalCount: 0, truncated: false },
        }],
        totalCount: 1,
        truncated: false,
      },
      centers: { rows: [], totalCount: 0, truncated: false },
      jobs: { rows: [], totalCount: 0, truncated: false },
      materials: { rows: [], totalCount: 0, totalAmount: 0, truncated: false },
      quantumBuffer: { rows: [], totalCount: 0, totalAmount: 0, truncated: false },
      destroyedByproducts: { rows: [], totalCount: 0, totalAmount: 0, truncated: false },
      limits: {
        targetRows: 128,
        centerRows: 64,
        jobRows: 64,
        materialRows: 256,
        quantumBufferRows: 256,
        destroyedByproductRows: 256,
        costRowsPerTarget: 32,
        projectionBytes: 1048576,
      },
    },
  };
}

describe("native construction-center intent guards", () => {
  it("parses only strict in-range decimal integers and derives bounded presets", () => {
    expect(parseNativeConstructionCenterTargetDraft("200", 500)).toEqual({ ok: true, value: 200 });
    for (const invalid of ["", "01", "+1", "-1", "1.0", "1e2", "501"]) {
      expect(parseNativeConstructionCenterTargetDraft(invalid, 500).ok).toBe(false);
    }
    expect(nativeConstructionCenterTargetPresets(500)).toEqual([0, 100, 500]);
    expect(nativeConstructionCenterTargetPresets(Number.NaN)).toEqual([]);
  });

  it("allows increases but requires an identity-bound confirmation for every decrease", () => {
    const current = frame();
    expect(evaluateNativeConstructionCenterTargetStock(current, null, "wind_turbine", 101))
      .toMatchObject({ status: "ready", submission: { revision: 19, target: 101, confirmedDecreaseFrom: null } });
    const lower = evaluateNativeConstructionCenterTargetStock(current, null, "wind_turbine", 90);
    expect(lower).toMatchObject({
      status: "confirmation-required",
      confirmation: { previousTarget: 100, target: 90, cancelsJobsAndRefunds: false },
    });
    const refund = evaluateNativeConstructionCenterTargetStock(current, null, "wind_turbine", 80);
    expect(refund).toMatchObject({
      status: "confirmation-required",
      confirmation: { currentStock: 80, cancelsJobsAndRefunds: true },
    });
    if (refund.status !== "confirmation-required") throw new Error("confirmation expected");
    expect(confirmNativeConstructionCenterTargetStock(current, null, refund.confirmation))
      .toMatchObject({ targetId: "wind_turbine", target: 80, confirmedDecreaseFrom: 100 });
  });

  it("fails closed for pending commands, stale identity, locked targets and forged confirmation", () => {
    const current = frame();
    const pending: NativeConstructionCenterPendingIdentity = {
      ...nativeConstructionCenterFrameIdentity(current),
      kind: "otherNativeCommand",
      targetId: null,
      expectedRevision: null,
    };
    expect(evaluateNativeConstructionCenterTargetStock(current, pending, "wind_turbine", 101).status).toBe("rejected");
    expect(evaluateNativeConstructionCenterTargetStock(current, null, "unknown", 1).status).toBe("rejected");
    const locked = {
      ...current,
      workspace: {
        ...current.workspace,
        targets: {
          ...current.workspace.targets,
          rows: current.workspace.targets.rows.map((row) => ({ ...row, unlocked: false })),
        },
      },
    };
    expect(evaluateNativeConstructionCenterTargetStock(locked, null, "wind_turbine", 101).status).toBe("rejected");
    const lower = evaluateNativeConstructionCenterTargetStock(current, null, "wind_turbine", 50);
    if (lower.status !== "confirmation-required") throw new Error("confirmation expected");
    const unavailable = { ...current, workspace: { ...current.workspace, writeAvailable: false } };
    expect(evaluateNativeConstructionCenterTargetStock(unavailable, null, "wind_turbine", 101).status).toBe("rejected");
    expect(confirmNativeConstructionCenterTargetStock(unavailable, null, lower.confirmation)).toBeNull();
    expect(confirmNativeConstructionCenterTargetStock(
      { ...current, revision: 20 },
      null,
      lower.confirmation,
    )).toBeNull();
    expect(confirmNativeConstructionCenterTargetStock(current, null, {
      ...lower.confirmation,
      previousTarget: 99,
    })).toBeNull();
    expect(nativeConstructionCenterIdentityMatchesFrame(lower.confirmation.identity, current)).toBe(true);
    expect(nativeConstructionCenterIdentityMatchesFrame(lower.confirmation.identity, { ...current, runId: "run-b" })).toBe(false);
  });
});
