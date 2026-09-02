import { expect, test } from "@playwright/test";
import { createInitialState } from "../../src/game/engine";

test("statistics uses its narrow read model while Dyson requests deferred top-level authority", async ({ page }) => {
  const state = createInitialState(44_145);
  state.paused = true;
  const raw = JSON.stringify({ savedAt: Date.now(), state });
  await page.addInitScript(({ saveRaw }) => {
    sessionStorage.setItem("dsp-idle-network.test-bypass-menu", "1");
    localStorage.setItem("dsp-idle-network.release-notes.seen.v1", "2026-08-31-v1.2.6");
    localStorage.setItem("dsp-idle-network.onboarding.v1", "dismissed");
    localStorage.setItem("dsp-idle-network.save.v1", saveRaw);
    const tracker: {
      kinds: Record<number, string>;
      syncRequests: number;
      statisticsRequests: number;
      checkpointRequests: number;
      syncResponses: Array<{
        kind: string;
        hasState: boolean;
        hasCheckpoint: boolean;
        hasStatisticsReadModel: boolean;
        statisticsReadModelKind: string | null;
        topLevelKeys: string[];
        changedEntities: number;
      }>;
    } = { kinds: {}, syncRequests: 0, statisticsRequests: 0, checkpointRequests: 0, syncResponses: [] };
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
          if (kind === "sync-statistics") tracker.statisticsRequests += 1;
          if (kind === "checkpoint") tracker.checkpointRequests += 1;
          const post = () => {
            if (transferOrOptions === undefined) nativePostMessage(message);
            else nativePostMessage(message, transferOrOptions);
          };
          if (kind === "sync-projection") window.setTimeout(post, 300);
          else post();
        }) as typeof worker.postMessage;
        worker.addEventListener("message", (event: MessageEvent<Record<string, unknown>>) => {
          const kind = tracker.kinds[Number(event.data.id)];
          if (kind !== "sync-projection" && kind !== "sync-statistics") return;
          const projection = event.data.projection as { topLevel?: Record<string, unknown>; changedEntities?: unknown[] } | undefined;
          const statisticsReadModel = event.data.statisticsReadModel as { kind?: unknown } | undefined;
          tracker.syncResponses.push({
            kind,
            hasState: "state" in event.data,
            hasCheckpoint: "checkpoint" in event.data,
            hasStatisticsReadModel: Boolean(statisticsReadModel),
            statisticsReadModelKind: typeof statisticsReadModel?.kind === "string" ? statisticsReadModel.kind : null,
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
  await expect(page.locator(".workspace-loading", { hasText: "正在同步权威生产历史" })).toContainText("正在同步权威生产历史");
  const statistics = page.getByRole("dialog", { name: "生产统计" });
  await expect(statistics).toBeVisible({ timeout: 10_000 });
  await statistics.getByLabel("关闭生产统计").click();

  await page.getByTitle("打开戴森球规划").click();
  await expect(page.locator(".workspace-loading", { hasText: "正在同步权威戴森规划" })).toContainText("正在同步权威戴森规划");
  await expect(page.getByRole("dialog", { name: "戴森球规划" })).toBeVisible({ timeout: 10_000 });

  const tracker = await page.evaluate(() => (
    window as typeof window & {
      __v144WorkspaceAuthority?: {
        syncRequests: number;
        statisticsRequests: number;
        checkpointRequests: number;
        syncResponses: Array<{
          kind: string;
          hasState: boolean;
          hasCheckpoint: boolean;
          hasStatisticsReadModel: boolean;
          statisticsReadModelKind: string | null;
          topLevelKeys: string[];
          changedEntities: number;
        }>;
      };
    }
  ).__v144WorkspaceAuthority!);
  expect(tracker.syncRequests).toBe(1);
  expect(tracker.statisticsRequests).toBe(1);
  expect(tracker.checkpointRequests).toBe(0);
  expect(tracker.syncResponses).toHaveLength(2);
  expect(tracker.syncResponses.find((response) => response.kind === "sync-statistics")).toEqual({
    kind: "sync-statistics",
    hasState: false,
    hasCheckpoint: false,
    hasStatisticsReadModel: true,
    statisticsReadModelKind: "statistics-history-v1",
    topLevelKeys: [],
    changedEntities: -1,
  });
  expect(tracker.syncResponses.find((response) => response.kind === "sync-projection")).toEqual({
    kind: "sync-projection",
    hasState: false,
    hasCheckpoint: false,
    hasStatisticsReadModel: false,
    statisticsReadModelKind: null,
    topLevelKeys: ["dysonPlans", "productionHistory"],
    changedEntities: 0,
  });
});
