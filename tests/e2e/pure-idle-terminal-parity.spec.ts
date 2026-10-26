import { expect, test } from "@playwright/test";

test("worker terminal finalization matches the legacy complete settlement state", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { createInitialState } = await import("/src/game/engine.ts");
    const { PureIdleMacroClient } = await import("/src/game/pureIdleMacroClient.ts");
    const { applyPureIdleMacroFinalState } = await import("/src/game/pureIdleMacro.ts");
    const { createContentPackRegistry, createContentPackRuntimeSnapshot } = await import("/src/game/contentPacks.ts");
    const { projectPersistentSaveState } = await import("/src/game/saveProjection.ts");
    const state = createInitialState(20261029, false);
    state.belts = []; state.paused = false; state.timeWarp.enabled = true;
    state.constructionAutomation.enabled = false;
    state.tray.iron_ore = 317;
    const terminalState = { startedPaused: true, baselineIdleSettlement: structuredClone(state.idleSettlement),
      baselineTotalProduced: { ...state.totalProduced } };
    const results: string[] = [];
    const registry = createContentPackRegistry();
    for (const terminal of [false, true]) {
      const client = new PureIdleMacroClient();
      try {
        await client.initialize(structuredClone(state), "stable", createContentPackRuntimeSnapshot(registry), {
          forceConservativeReason: "terminal equivalence test", ...terminalState,
        });
        const final = await client.finalize(35, { terminal, closeBeforeDecode: true });
        const settled = terminal ? final.state : applyPureIdleMacroFinalState(final.state, 35, terminalState);
        results.push(JSON.stringify(projectPersistentSaveState(settled, registry)));
      } finally { client.close(); }
    }
    return { equal: results[0] === results[1], unchangedInventory: state.tray.iron_ore };
  });
  expect(result).toEqual({ equal: true, unchangedInventory: 317 });
});
