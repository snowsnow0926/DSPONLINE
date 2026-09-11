import { expect, test } from "@playwright/test";

declare global {
  interface Window {
    __dspPausedPerf?: { frames: number; peakFrameMs: number; previous: number };
  }
}

function seedPausedFactory() {
  return () => {
    const entities = Array.from({ length: 60 }, (_, index) => ({
      id: `perf-machine-${index}`,
      kind: "machine",
      planetId: "home",
      position: { x: (index % 10) * 320, y: Math.floor(index / 10) * 240 },
      interactionLocked: false,
      buildingId: "arc_smelter",
      recipeId: index < 30 ? "iron_ingot" : "steel",
      machineCount: 1,
      minerCount: 0,
      inputs: { iron_ore: 60 },
      outputs: { iron_ingot: 60 },
      progress: 0.4,
      utilization: 1,
      productionRate: 60,
    }));
    const belts = Array.from({ length: 600 }, (_, index) => ({
      id: `perf-belt-${index}`,
      planetId: "home",
      source: `perf-machine-${index % 30}`,
      target: `perf-machine-${30 + ((index * 7 + 1) % 30)}`,
      itemId: "iron_ingot",
      lanes: 2,
      tier: 1,
      sorterTier: 1,
      progress: (index % 10) / 10,
      priority: 1,
      lastFlow: index % 3 === 0 ? 12 : 0,
      congestion: 0,
    }));
    const state = {
      version: 44,
      nextId: 1,
      activePlanetId: "home",
      entities,
      belts,
      construction: {},
      tray: {},
      planetTrays: { home: {} },
      planetTrayItemLimits: { home: 1_000_000 },
      totalProduced: {},
      exploration: { unlockedSystemIds: ["helios"], colonizedPlanetIds: ["home"], surveyProgressBySystem: { helios: 1 }, missions: [] },
      research: { selectedTechId: null, pausedTechId: null, queuedTechIds: [], progressByTech: {}, completedTechIds: [] },
      settings: { theme: "dark", fontScale: 1, simulationSpeed: 1, autosaveIntervalSeconds: 30 },
      paused: true,
    };
    window.sessionStorage.setItem("dsp-idle-network.test-bypass-menu", "1");
    window.localStorage.setItem("dsp-idle-network.release-notes.seen.v1", "2026-08-17-v1.0.46");
    window.localStorage.setItem("dsp-idle-network.basic-onboarding.v1", JSON.stringify({ version: 1, skipped: true, stepIndex: 5 }));
    window.localStorage.setItem("dsp-idle-network.save.v1", JSON.stringify({ savedAt: Date.now(), state }));
    window.__dspPausedPerf = { frames: 0, peakFrameMs: 0, previous: performance.now() };
    const sample = (now) => {
      const perf = window.__dspPausedPerf;
      if (perf) {
        perf.frames += 1;
        perf.peakFrameMs = Math.max(perf.peakFrameMs, now - perf.previous);
        perf.previous = now;
      }
      window.requestAnimationFrame(sample);
    };
    window.requestAnimationFrame(sample);
  };
}

test("paused canvas enters quiet mode without removing the editor surface", async ({ page }) => {
  await page.addInitScript(seedPausedFactory());
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto("/");
  const shell = page.locator(".game-shell");
  await expect(shell).toHaveAttribute("data-simulation-paused", "true");
  await expect(page.locator(".factory-canvas")).toBeVisible();
  await expect(page.locator(".react-flow__pane")).toBeVisible();
  const topology = await page.evaluate(() => ({
    nodes: document.querySelectorAll(".react-flow__node").length,
    edges: document.querySelectorAll(".react-flow__edge").length,
  }));
  expect(topology.nodes).toBeGreaterThan(0);
  expect(topology.edges).toBeGreaterThan(0);
  await page.waitForTimeout(1_500);
  const pausedPerf = await page.evaluate(() => ({ ...(window.__dspPausedPerf ?? { frames: 0, peakFrameMs: 9999 }) }));
  expect(pausedPerf.frames).toBeGreaterThan(30);
  // Initial React Flow layout may briefly exceed a frame on CI; a paused
  // canvas must still avoid the multi-second freezes seen before P1-P5.
  expect(pausedPerf.peakFrameMs).toBeLessThan(800);
});

