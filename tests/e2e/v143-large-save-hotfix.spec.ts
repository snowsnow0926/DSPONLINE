import { expect, test, type Page } from "@playwright/test";

const SAVE_KEY = "dsp-idle-network.save.v1";
const BACKUP_KEY = `${SAVE_KEY}.backup`;
const RELEASE_NOTE_ID = "2026-08-30-v1.2.5";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(({ releaseNoteId }) => {
    window.sessionStorage.setItem("dsp-idle-network.test-bypass-menu", "1");
    window.localStorage.setItem("dsp-idle-network.release-notes.seen.v1", releaseNoteId);
    window.localStorage.setItem("dsp-idle-network.onboarding.v1", "dismissed");
  }, { releaseNoteId: RELEASE_NOTE_ID });
});

async function openFactory(page: Page) {
  await page.goto("/");
  await expect(page.locator(".game-shell")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(".vein-node").filter({ hasText: "铁矿石" })).toBeVisible({ timeout: 15_000 });
}

async function saveBaselineWhilePaused(page: Page) {
  await page.getByLabel("打开设置").click();
  const operations = page.getByRole("dialog", { name: "运营中心" });
  await operations.locator(".operations-tabs").getByRole("tab", { name: "存档" }).click();
  await operations.getByRole("button", { name: "立即保存" }).click();
  await expect(page.locator(".game-notice")).toContainText("主存档已保存");
  await operations.getByLabel("关闭运营中心").click();
  await expect(operations).toBeHidden();
  // Make the state different from the verified baseline, then keep it stable
  // during the return save. This prevents the intentional unchanged-state
  // fast path from turning the test into a no-op.
  await page.getByLabel("暂停模拟").click();
  await expect(page.getByLabel("继续模拟")).toBeVisible();
  return page.evaluate(async ({ saveKey }) => {
    const store = await import("/src/game/localSaveStore.ts");
    await store.flushLocalSaveWrites();
    const raw = await store.readPersistedLocalSaveValue(saveKey);
    if (!raw) throw new Error("baseline primary save is missing");
    return { raw, revision: store.getPrimaryLocalSaveRevision() };
  }, { saveKey: SAVE_KEY });
}

test("paused double-click return commits one revision and keeps the true previous primary as backup", async ({ page }) => {
  await openFactory(page);
  const before = await saveBaselineWhilePaused(page);

  await page.evaluate(() => {
    const button = document.querySelector<HTMLButtonElement>('[title="保存并返回主菜单"]');
    if (!button) throw new Error("return button is missing");
    button.click();
    button.click();
  });
  await expect(page.locator(".start-menu")).toBeVisible({ timeout: 15_000 });

  const after = await page.evaluate(async ({ saveKey, backupKey }) => {
    const store = await import("/src/game/localSaveStore.ts");
    await store.flushLocalSaveWrites();
    return {
      raw: await store.readPersistedLocalSaveValue(saveKey),
      backup: await store.readPersistedLocalSaveValue(backupKey),
      revision: store.getPrimaryLocalSaveRevision(),
    };
  }, { saveKey: SAVE_KEY, backupKey: BACKUP_KEY });
  expect(after.raw).not.toBeNull();
  expect(after.revision).toBe(before.revision + 1);
  expect(after.backup).toBe(before.raw);
});

test("running simulation that advances during return receives one final cleanup save", async ({ page }) => {
  await openFactory(page);
  const before = await saveBaselineWhilePaused(page);
  await page.getByLabel("继续模拟").click();
  await expect(page.getByLabel("暂停模拟")).toBeVisible();

  await page.evaluate(() => {
    const NativeWorker = window.Worker;
    const delayedWorkers = new WeakSet<Worker>();
    const NativePostMessage = NativeWorker.prototype.postMessage;
    const WrappedWorker = new Proxy(NativeWorker, {
      construct(target, args) {
        const worker = Reflect.construct(target, args) as Worker;
        if (String(args[0]).includes("save.worker")) delayedWorkers.add(worker);
        return worker;
      },
    });
    NativeWorker.prototype.postMessage = function (message: unknown, transferOrOptions?: Transferable[] | StructuredSerializeOptions) {
      const post = () => NativePostMessage.call(this, message, transferOrOptions as Transferable[]);
      if (delayedWorkers.has(this)) {
        window.setTimeout(post, 700);
        return;
      }
      post();
    } as typeof Worker.prototype.postMessage;
    Object.defineProperty(window, "Worker", { configurable: true, writable: true, value: WrappedWorker });
  });

  await page.getByTitle("保存并返回主菜单").click();
  await expect(page.locator(".start-menu")).toBeVisible({ timeout: 15_000 });
  const after = await page.evaluate(async ({ saveKey, backupKey }) => {
    const store = await import("/src/game/localSaveStore.ts");
    await store.flushLocalSaveWrites();
    const raw = await store.readPersistedLocalSaveValue(saveKey);
    const backup = await store.readPersistedLocalSaveValue(backupKey);
    if (!raw || !backup) throw new Error("return saves are missing");
    return {
      revision: store.getPrimaryLocalSaveRevision(),
      primaryElapsed: JSON.parse(raw).state.elapsedSeconds as number,
      backupElapsed: JSON.parse(backup).state.elapsedSeconds as number,
      primaryPending: JSON.parse(raw).state.timeWarp.pendingSimulationSeconds as number,
      backupPending: JSON.parse(backup).state.timeWarp.pendingSimulationSeconds as number,
    };
  }, { saveKey: SAVE_KEY, backupKey: BACKUP_KEY });

  // 1.0.45 may commit one or two revisions depending on how the larger v47
  // payload is coalesced behind the delayed save Worker. The important
  // invariant is that at least one final cleanup save lands and the return
  // save contains the wall time accumulated behind the barrier.
  expect(after.revision).toBeGreaterThan(before.revision);
  expect(after.revision).toBeLessThanOrEqual(before.revision + 2);
  // 1.0.44 holds a Worker checkpoint barrier during the verified write.
  // Wall time accumulated behind that barrier is persisted as exact scheduler
  // debt instead of synchronously advancing a large state on the main thread.
  expect(after.primaryElapsed + after.primaryPending).toBeGreaterThan(after.backupElapsed + after.backupPending);
});

