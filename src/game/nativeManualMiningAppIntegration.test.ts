import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("native manual-mining App boundary", () => {
  const app = readFileSync(resolve("src/App.tsx"), "utf8");
  const nodes = readFileSync(resolve("src/components/FactoryNodes.tsx"), "utf8");

  it("submits only an exact current native canvas intent", () => {
    const start = app.indexOf("const submitNativeManualMine = useCallback");
    const block = app.slice(start, app.indexOf("const onMiningStart = useCallback", start));

    expect(start).toBeGreaterThanOrEqual(0);
    expect(block).toMatch(/nativePlayerAuthorityOwnsRuntimeRef\.current/);
    expect(block).toMatch(/nativePlayerAuthorityCommandInFlightRef\.current/);
    expect(block).toMatch(/nativeAuthoritativeFactoryCanvasFrameRef\.current/);
    expect(block).toMatch(/nativePlayerAuthorityCommandBindingRef\.current/);
    expect(block).toMatch(/frame\.sessionId !== binding\.source\.sessionId/);
    expect(block).toMatch(/frame\.runId !== binding\.source\.runId/);
    expect(block).toMatch(/frame\.revision !== binding\.source\.baseRevision/);
    expect(block).toMatch(/entity\.kind !== "vein"/);
    expect(block).toMatch(/entity\.planetId !== frame\.planetId/);
    expect(block).toMatch(/resource\?\.kind !== "solid"/);
    expect(block).toMatch(/commitNativeProjectedCommand\(frame\.revision/);
    expect(block).toMatch(/createNativeProjectedManualMineCommand\(\{ baseRevision, entityId \}\)/);
    expect(block).not.toMatch(/gameRef\.current|commitGame|manualMine\(|publishRuntimeGame|createSimulationCommandPatch/);
  });

  it("tries each authority frame once and waits for a new ACK projection while held", () => {
    const start = app.indexOf("const submitNativeManualMine = useCallback");
    const submit = app.slice(start, app.indexOf("const onMiningStart = useCallback", start));
    const miningStart = app.slice(
      app.indexOf("const onMiningStart = useCallback"),
      app.indexOf("useEffect(() => {", app.indexOf("const onMiningStart = useCallback")),
    );

    expect(submit).toMatch(/JSON\.stringify\(\[frame\.sessionId, frame\.runId, frame\.revision\]\)/);
    expect(submit).toMatch(/nativeManualMiningLastAttemptedFrameKeyRef\.current === frameKey/);
    expect(submit.indexOf("nativeManualMiningLastAttemptedFrameKeyRef.current = frameKey"))
      .toBeLessThan(submit.indexOf("commitNativeProjectedCommand(frame.revision"));
    expect(miningStart).toMatch(/nativePlayerAuthorityOwnsRuntimeRef\.current[\s\S]*?submitNativeManualMine\(entityId\)/);
    expect(miningStart).toMatch(/window\.setInterval\(\(\) => \{[\s\S]*?submitNativeManualMine\(entityId\)[\s\S]*?320/);
    expect(miningStart.indexOf("nativePlayerAuthorityOwnsRuntimeRef.current"))
      .toBeLessThan(miningStart.indexOf("rejectLegacyFactoryInteractionWhileNative"));
    expect(miningStart).toMatch(/commitGame\(\(current\) => manualMine\(current, entityId, 1\)\)/);
  });

  it("opens only the memo-safe manual-mining capability on read-only vein cards", () => {
    expect(app).toMatch(/manualMiningEnabled: nativeManualMiningEnabled/);
    expect(app).toMatch(/commonNodeData\.manualMiningEnabled/);
    expect(app).toMatch(/previous\.data\.manualMiningEnabled === commonNodeData\.manualMiningEnabled/);
    expect(nodes).toMatch(/manualMiningEnabled\?: boolean/);
    expect(nodes).toMatch(/const manualMiningEnabled = !data\.readOnly \|\| Boolean\(data\.manualMiningEnabled\)/);
    expect(nodes).toMatch(/disabled=\{!manualMiningEnabled\}/);
    expect(nodes).toMatch(/previous\.data\.manualMiningEnabled === next\.data\.manualMiningEnabled/);
  });
});
