import { describe, expect, it } from "vitest";
import type { NativeConstructionCenterWorkspaceFrame } from "./nativeConstructionCenterWorkspace";
import {
  confirmNativeConstructionCenterBatchBuildingTargetStock,
  confirmNativeConstructionCenterTargetStock,
  evaluateNativeConstructionCenterBatchBuildingTargetStock,
  evaluateNativeConstructionCenterTargetStock,
  nativeConstructionCenterFrameIdentity,
  nativeConstructionCenterIdentityKey,
  nativeConstructionCenterIdentityMatchesFrame,
  nativeConstructionCenterPendingKey,
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

function batchFrame(revision = 19): NativeConstructionCenterWorkspaceFrame {
  const current = frame();
  const building = current.workspace.targets.rows[0];
  return {
    ...current,
    revision,
    workspace: {
      ...current.workspace,
      targets: {
        rows: [
          building,
          {
            ...building,
            targetId: "arc_smelter",
            name: "电弧熔炉",
            category: "production",
            target: 25,
            currentStock: 12,
          },
          {
            ...building,
            targetId: "planetary_logistics_station",
            name: "行星物流运输站",
            category: "logistics",
            target: 300,
            unlocked: false,
          },
          {
            ...building,
            targetId: "logistics_vessel",
            name: "星际物流运输船",
            kind: "fleet",
            category: "logistics",
            target: 400,
          },
        ],
        totalCount: 4,
        truncated: false,
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

  it("requires an explicit ID-free confirmation for every batch building target update", () => {
    const current = batchFrame();
    const evaluated = evaluateNativeConstructionCenterBatchBuildingTargetStock(current, null, 50);
    expect(evaluated).toMatchObject({
      status: "confirmation-required",
      confirmation: {
        identity: {
          sessionId: "session-a",
          runId: "run-a",
          revision: 19,
          activePlanetId: "home",
        },
        target: 50,
        affectedCount: 2,
        changedCount: 2,
        loweredCount: 1,
        cancelsJobsAndRefunds: false,
      },
    });
    if (evaluated.status !== "confirmation-required") throw new Error("confirmation expected");
    expect(Object.isFrozen(evaluated.confirmation)).toBe(true);
    const submission = confirmNativeConstructionCenterBatchBuildingTargetStock(
      current,
      null,
      evaluated.confirmation,
    );
    expect(submission).toEqual({
      sessionId: "session-a",
      runId: "run-a",
      revision: 19,
      activePlanetId: "home",
      target: 50,
      confirmedAffectedCount: 2,
      confirmedChangedCount: 2,
      confirmedLoweredCount: 1,
    });
    expect(Object.isFrozen(submission)).toBe(true);
    expect(JSON.stringify(submission)).not.toMatch(/wind_turbine|arc_smelter|targetId|jobs|inventory/);
  });

  it("keeps batch identity retry-stable while fencing pending work and revision drift", () => {
    const current = batchFrame();
    const evaluated = evaluateNativeConstructionCenterBatchBuildingTargetStock(current, null, 50);
    if (evaluated.status !== "confirmation-required") throw new Error("confirmation expected");
    const pending: NativeConstructionCenterPendingIdentity = {
      ...evaluated.confirmation.identity,
      kind: "batchBuildingTargetStock",
      targetId: null,
      expectedRevision: null,
    };
    expect(nativeConstructionCenterIdentityKey(evaluated.confirmation.identity)).toBe(
      '["session-a","run-a",19,"home"]',
    );
    expect(nativeConstructionCenterPendingKey(pending)).toBe(
      '["session-a","run-a",19,"home","batchBuildingTargetStock",null,null]',
    );
    expect(nativeConstructionCenterPendingKey({ ...pending, expectedRevision: 20 }))
      .not.toBe(nativeConstructionCenterPendingKey(pending));
    expect(evaluateNativeConstructionCenterBatchBuildingTargetStock(current, pending, 50).status)
      .toBe("rejected");
    expect(confirmNativeConstructionCenterBatchBuildingTargetStock(
      current,
      pending,
      evaluated.confirmation,
    )).toBeNull();

    const first = confirmNativeConstructionCenterBatchBuildingTargetStock(current, null, evaluated.confirmation);
    const retry = confirmNativeConstructionCenterBatchBuildingTargetStock(current, null, evaluated.confirmation);
    expect(retry).toEqual(first);
    expect(retry).not.toBe(first);
    expect(confirmNativeConstructionCenterBatchBuildingTargetStock(
      batchFrame(20),
      null,
      evaluated.confirmation,
    )).toBeNull();
    const refreshed = evaluateNativeConstructionCenterBatchBuildingTargetStock(batchFrame(20), null, 50);
    expect(refreshed).toMatchObject({
      status: "confirmation-required",
      confirmation: { identity: { revision: 20 } },
    });
  });

  it("rejects invalid, incomplete, unchanged or forged batch confirmations", () => {
    const current = batchFrame();
    for (const invalid of [0, -1, 1.5, 501, 100_000_001, Number.MAX_SAFE_INTEGER + 1]) {
      expect(evaluateNativeConstructionCenterBatchBuildingTargetStock(current, null, invalid).status)
        .toBe("rejected");
    }
    const noBuildings = {
      ...current,
      workspace: {
        ...current.workspace,
        targets: {
          ...current.workspace.targets,
          rows: current.workspace.targets.rows.map((row) => ({ ...row, unlocked: false })),
        },
      },
    };
    expect(evaluateNativeConstructionCenterBatchBuildingTargetStock(noBuildings, null, 50).status)
      .toBe("rejected");
    const unchanged = {
      ...current,
      workspace: {
        ...current.workspace,
        targets: {
          ...current.workspace.targets,
          rows: current.workspace.targets.rows.map((row) => row.kind === "building" && row.unlocked
            ? { ...row, target: 50 }
            : row),
        },
      },
    };
    expect(evaluateNativeConstructionCenterBatchBuildingTargetStock(unchanged, null, 50).status)
      .toBe("rejected");
    const truncated = {
      ...current,
      workspace: {
        ...current.workspace,
        targets: { ...current.workspace.targets, truncated: true },
      },
    };
    expect(evaluateNativeConstructionCenterBatchBuildingTargetStock(truncated, null, 50))
      .toMatchObject({ status: "rejected", message: expect.stringContaining("不完整") });
    const incomplete = {
      ...current,
      workspace: {
        ...current.workspace,
        targets: { ...current.workspace.targets, totalCount: current.workspace.targets.rows.length + 1 },
      },
    };
    expect(evaluateNativeConstructionCenterBatchBuildingTargetStock(incomplete, null, 50))
      .toMatchObject({ status: "rejected", message: expect.stringContaining("不完整") });

    const evaluated = evaluateNativeConstructionCenterBatchBuildingTargetStock(current, null, 50);
    if (evaluated.status !== "confirmation-required") throw new Error("confirmation expected");
    expect(confirmNativeConstructionCenterBatchBuildingTargetStock(current, null, {
      ...evaluated.confirmation,
      affectedCount: 99,
    })).toBeNull();
    expect(confirmNativeConstructionCenterBatchBuildingTargetStock(current, null, {
      ...evaluated.confirmation,
      cancelsJobsAndRefunds: true,
    } as unknown as typeof evaluated.confirmation)).toBeNull();
    const rowDrifted = {
      ...current,
      workspace: {
        ...current.workspace,
        targets: {
          ...current.workspace.targets,
          rows: current.workspace.targets.rows.map((row) => row.targetId === "wind_turbine"
            ? { ...row, target: 40 }
            : row),
        },
      },
    };
    expect(confirmNativeConstructionCenterBatchBuildingTargetStock(
      rowDrifted,
      null,
      evaluated.confirmation,
    )).toBeNull();

    const historicalAboveCurrentLimit = {
      ...current,
      workspace: {
        ...current.workspace,
        targets: {
          ...current.workspace.targets,
          rows: current.workspace.targets.rows.map((row) => row.targetId === "wind_turbine"
            ? { ...row, target: 100_000_000 }
            : row),
        },
      },
    };
    const historicalEvaluation = evaluateNativeConstructionCenterBatchBuildingTargetStock(
      historicalAboveCurrentLimit,
      null,
      50,
    );
    expect(historicalEvaluation).toMatchObject({
      status: "confirmation-required",
      confirmation: { loweredCount: 1 },
    });
  });
});
