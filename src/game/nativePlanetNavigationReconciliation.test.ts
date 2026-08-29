import { describe, expect, it } from "vitest";

import {
  evaluateNativePlanetTransition,
  nativePlanetRouteRequiresBootstrap,
  retainNativePlanetRouteIdentity,
  type NativePlanetCanvasProof,
  type NativePlanetTransitionIntent,
  type NativePlanetWorkspaceProof,
} from "./nativePlanetNavigationReconciliation";

const INTENT: NativePlanetTransitionIntent = {
  sessionId: "authority-1",
  acceptedRevision: 12,
  planetId: "frost",
};
const WORKSPACE: NativePlanetWorkspaceProof = {
  sessionId: "authority-1",
  revision: 12,
  activePlanetId: "frost",
  targetRowActive: true,
};
const CANVAS: NativePlanetCanvasProof = {
  sessionId: "authority-1",
  revision: 12,
  planetId: "frost",
};

describe("native planet navigation reconciliation", () => {
  it("retains a confirmed route through an exact-revision read gap without crossing sessions", () => {
    const home = { sessionId: "authority-1", planetId: "home" };
    const frost = { sessionId: "authority-1", planetId: "frost" };

    expect(retainNativePlanetRouteIdentity("authority-1", null, home)).toEqual(home);
    expect(nativePlanetRouteRequiresBootstrap(true, home,
      retainNativePlanetRouteIdentity("authority-1", null, home))).toBe(false);
    expect(retainNativePlanetRouteIdentity("authority-1", frost, home)).toEqual(frost);
    expect(nativePlanetRouteRequiresBootstrap(true, home,
      retainNativePlanetRouteIdentity("authority-1", frost, home))).toBe(true);
    expect(retainNativePlanetRouteIdentity("authority-2", null, home)).toBeNull();
    expect(retainNativePlanetRouteIdentity(null, frost, home)).toBeNull();
  });

  it("settles identically whether the durable receipt or projection arrives first", () => {
    // Receipt first: no Q frame yet, then both proofs arrive.
    expect(evaluateNativePlanetTransition(INTENT, null, null)).toBe("waiting");
    expect(evaluateNativePlanetTransition(INTENT, WORKSPACE, CANVAS)).toBe("ready");

    // Projection first: no intent means no travel side effect; the later
    // receipt triggers a fresh evaluation against the already present Q frame.
    expect(evaluateNativePlanetTransition(null, WORKSPACE, CANVAS)).toBe("idle");
    expect(evaluateNativePlanetTransition(INTENT, WORKSPACE, CANVAS)).toBe("ready");
  });

  it("waits through a paused old revision and rejects mismatched recovered proofs", () => {
    expect(evaluateNativePlanetTransition(INTENT, { ...WORKSPACE, revision: 11 }, {
      ...CANVAS,
      revision: 11,
    })).toBe("waiting");
    expect(evaluateNativePlanetTransition(INTENT, {
      ...WORKSPACE,
      sessionId: "authority-2",
      revision: 1,
    }, CANVAS))
      .toBe("session-mismatch");
    expect(evaluateNativePlanetTransition(INTENT, WORKSPACE, { ...CANVAS, revision: 13 }))
      .toBe("projection-mismatch");
    expect(evaluateNativePlanetTransition(INTENT, { ...WORKSPACE, activePlanetId: "home" }, CANVAS))
      .toBe("target-mismatch");
    expect(evaluateNativePlanetTransition(INTENT, { ...WORKSPACE, targetRowActive: false }, CANVAS))
      .toBe("target-inactive");
  });

  it("forces an unpinned reset for travel, uncertain commits, and session rebound", () => {
    expect(nativePlanetRouteRequiresBootstrap(true, null, {
      sessionId: "authority-1",
      planetId: "home",
    })).toBe(true);
    expect(nativePlanetRouteRequiresBootstrap(true, {
      sessionId: "authority-1",
      planetId: "home",
    }, {
      sessionId: "authority-1",
      planetId: "frost",
    })).toBe(true);
    expect(nativePlanetRouteRequiresBootstrap(true, {
      sessionId: "authority-1",
      planetId: "frost",
    }, {
      sessionId: "authority-2",
      planetId: "frost",
    })).toBe(true);
    expect(nativePlanetRouteRequiresBootstrap(true, {
      sessionId: "authority-1",
      planetId: "frost",
    }, {
      sessionId: "authority-1",
      planetId: "frost",
    })).toBe(false);
    expect(nativePlanetRouteRequiresBootstrap(false, null, null)).toBe(false);
  });
});
