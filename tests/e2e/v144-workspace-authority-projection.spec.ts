import { expect, test } from "@playwright/test";
import { createInitialState } from "../../src/game/engine";

test("statistics and Dyson workspaces open a loading shell and request only deferred top-level authority", async ({ page }) => {
  const state = createInitialState(44_145);
  state.paused = true;
  const raw = JSON.stringify({ savedAt: Date.now(), state });
  await page.addInitScript(({ saveRaw }) => {
    sessionStorage.setItem("dsp-idle-network.test-bypass-menu", "1");
    localStorage.setItem("dsp-idle-network.release-notes.seen.v1", "2026-08-17-v1.0.46");
    localStorage.setItem("dsp-idle-network.onboarding.v1", "dismissed");
    localStorage.setItem("dsp-idle-network.save.v1", saveRaw);
    const tracker: {
      kinds: Record<number, string>;
      syncRequests: number;
      checkpointRequests: number;
      syncResponses: Array<{ hasState: boolean; hasCheckpoint: boolean; topLevelKeys: string[]; changedEntities: number }>;
    } = { kinds: {}, syncRequests: 0, checkpointRequests: 0, syncResponses: [] };
    (window as typeof window & { __v144WorkspaceAuthority?: typeof tracker }).__v144WorkspaceAuthority = tracker;
    const NativeWorker = window.Worker;
    const WrappedWorker = new Proxy(NativeWorker, {
      construct(target, args) {
        const worker = Reflect.construct(target, args) as Worker;
        const simulation = String(args[0]).includes("simulation.worker") && (args[1] as WorkerOptions | undefined)?.name === "factory-simulation";
        if (!simulation) return worker;
        const nativePostMessage = worker.postMessage.bind(worker);
        worker.postMessage = ((message: Record<string, unknown>, transferOrOptions?: Transferable[] | StructuredSerializeOptions) => {
          const id = Number(message.id);
          const kind = String(message.kind ?? "advance");
          tracker.kinds[id] = kind;
          if (kind === "sync-projection") tracker.syncRequests += 1;
          if (kind === "checkpoint") tracker.checkpointRequests += 1;
          const post = () => {
            if (transferOrOptions === undefined) nativePostMessage(message);
            else nativePostMessage(message, transferOrOptions);
          };
          if (kind === "sync-projection") window.setTimeout(post, 300);
          else post();
        }) as typeof worker.postMessage;
        worker.addEventListener("message", (event: MessageEvent<Record<string, unknown>>) => {
          if (tracker.kinds[Number(event.data.id)] !== "sync-projection") return;
          const projection = event.data.projection as { topLevel?: Record<string, unknown>; changedEntities?: unknown[] } | undefined;
          tracker.syncResponses.push({
            hasState: "state" in event.data,
            hasCheckpoint: "checkpoint" in event.data,
            topLevelKeys: Object.keys(projection?.topLevel ?? {}).sort(),
            changedEntities: projection?.changedEntities?.length ?? -1,
          });
        });
        return worker;
      },
    });
    Object.defineProperty(window, "Worker", { configurable: true, writable: true, value: WrappedWorker });
  }, { saveRaw: raw });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(page.locator(".game-shell")).toHaveAttribute("data-simulation-worker", "active");

  await page.getByTitle("打开生产统计").click();
  await expect(page.locator(".workspace-loading")).toContainText("正在同步权威生产历史");
  const statistics = page.getByRole("dialog", { name: "生产统计" });
  await expect(statistics).toBeVisible({ timeout: 10_000 });
  await statistics.getByLabel("关闭生产统计").click();

  await page.getByTitle("打开戴森球规划").click();
  await expect(page.locator(".workspace-loading")).toContainText("正在同步权威戴森规划");
  await expect(page.getByRole("dialog", { name: "戴森球规划" })).toBeVisible({ timeout: 10_000 });

  const tracker = await page.evaluate(() => (
    window as typeof window & {
      __v144WorkspaceAuthority?: {
        syncRequests: number;
        checkpointRequests: number;
        syncResponses: Array<{ hasState: boolean; hasCheckpoint: boolean; topLevelKeys: string[]; changedEntities: number }>;
      };
    }
  ).__v144WorkspaceAuthority!);
  expect(tracker.syncRequests).toBe(2);
  expect(tracker.checkpointRequests).toBe(0);
  expect(tracker.syncResponses).toHaveLength(2);
  for (const response of tracker.syncResponses) {
    expect(response).toEqual({
      hasState: false,
      hasCheckpoint: false,
      topLevelKeys: ["dysonPlans", "productionHistory"],
      changedEntities: 0,
    });
  }
});

