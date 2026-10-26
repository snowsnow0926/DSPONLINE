import { expect, test } from "@playwright/test";

test("macro Worker reads the exact owned checkpoint and reports cooperative calibration", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { createInitialState } = await import("/src/game/engine.ts");
    const { createPureIdleRecovery, readPureIdleRecovery, clearPureIdleRecovery } = await import("/src/game/pureIdleRecovery.ts");
    const { PureIdleMacroClient } = await import("/src/game/pureIdleMacroClient.ts");
    const { createContentPackRegistry, createContentPackRuntimeSnapshot } = await import("/src/game/contentPacks.ts");
    const { hashGameState } = await import("/src/game/benchmark.ts");
    const state = createInitialState(20261026, false);
    state.entities = []; state.belts = []; state.paused = false; state.timeWarp.enabled = true;
    state.constructionAutomation.enabled = false;
    const claim = await createPureIdleRecovery(state, "stable", Date.now(), "worker-checkpoint-owner");
    if (!claim.ok) throw new Error(claim.message);
    const sourceHash = hashGameState(claim.record.state);
    const progress: number[] = [];
    const client = new PureIdleMacroClient({ onProgress: (event) => {
      if (event.completedSimulationSeconds !== undefined) progress.push(event.completedSimulationSeconds);
    } });
    try {
      const summary = await client.initializeFromRecovery(claim.record, createContentPackRuntimeSnapshot(createContentPackRegistry()), {
        forceConservativeReason: "cooperative browser test",
      });
      await client.advance(35);
      const unchanged = await readPureIdleRecovery();
      return { progress, windows: summary.calibrationWindowsCompleted,
        unchanged: !!unchanged && hashGameState(unchanged.state) === sourceHash && unchanged.settledWallSeconds === 0 };
    } finally {
      client.close();
      await clearPureIdleRecovery(claim.record.sessionId, claim.record.ownerToken);
    }
  });
  expect(result).toEqual({ progress: [10, 20, 30], windows: 3, unchanged: true });
});

test("macro Worker rejects a changed checkpoint identity without changing recovery data", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { createInitialState } = await import("/src/game/engine.ts");
    const { createPureIdleRecovery, readPureIdleRecovery, clearPureIdleRecovery } = await import("/src/game/pureIdleRecovery.ts");
    const { PureIdleMacroClient } = await import("/src/game/pureIdleMacroClient.ts");
    const { createContentPackRegistry, createContentPackRuntimeSnapshot } = await import("/src/game/contentPacks.ts");
    const state = createInitialState(20261026, false);
    state.paused = false; state.timeWarp.enabled = true;
    const claim = await createPureIdleRecovery(state, "stable", Date.now(), "owner-identity");
    if (!claim.ok) throw new Error(claim.message);
    const rejected: boolean[] = [];
    try {
      for (const patch of [{ ownerToken: "another-owner" }, { sessionId: "another-session" }, { checkpointHash: "checkpoint-wrong" }]) {
        const client = new PureIdleMacroClient();
        try {
          await client.initializeFromRecovery({ ...claim.record, ...patch }, createContentPackRuntimeSnapshot(createContentPackRegistry()));
          rejected.push(false);
        } catch (error) { rejected.push(String(error).includes("检查点")); }
        finally { client.close(); }
      }
      return { rejected, retained: (await readPureIdleRecovery())?.sessionId === claim.record.sessionId };
    } finally { await clearPureIdleRecovery(claim.record.sessionId, claim.record.ownerToken); }
  });
  expect(result).toEqual({ rejected: [true, true, true], retained: true });
});

test("cancelling calibration preserves the checkpoint and uncommitted settlement time", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { createInitialState } = await import("/src/game/engine.ts");
    const { createPureIdleRecovery, readPureIdleRecovery, clearPureIdleRecovery } = await import("/src/game/pureIdleRecovery.ts");
    const { PureIdleMacroClient } = await import("/src/game/pureIdleMacroClient.ts");
    const { createContentPackRegistry, createContentPackRuntimeSnapshot } = await import("/src/game/contentPacks.ts");
    const { hashGameState } = await import("/src/game/benchmark.ts");
    const state = createInitialState(20261026, false);
    state.entities = []; state.belts = []; state.paused = false; state.timeWarp.enabled = true;
    const claim = await createPureIdleRecovery(state, "stable", Date.now(), "cancel-checkpoint-owner");
    if (!claim.ok) throw new Error(claim.message);
    const sourceHash = hashGameState(claim.record.state);
    const client = new PureIdleMacroClient({ onProgress: (event) => {
      if (event.completedSimulationSeconds === 10) client.cancel("cancel calibration test");
    } });
    try {
      let aborted = false;
      try {
        await client.initializeFromRecovery(claim.record, createContentPackRuntimeSnapshot(createContentPackRegistry()), {
          forceConservativeReason: "cancellation browser test",
        });
      } catch (error) { aborted = error instanceof Error && error.name === "AbortError"; }
      const retained = await readPureIdleRecovery();
      return { aborted, unchanged: !!retained && hashGameState(retained.state) === sourceHash && retained.settledWallSeconds === 0 };
    } finally {
      client.close();
      await clearPureIdleRecovery(claim.record.sessionId, claim.record.ownerToken);
    }
  });
  expect(result).toEqual({ aborted: true, unchanged: true });
});
