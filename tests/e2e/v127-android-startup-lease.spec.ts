import { expect, test, type Page } from "@playwright/test";
import { LOCAL_SAVE_WRITER_LEASE_KEY, LOCAL_SAVE_WRITER_LOCK } from "../../src/game/localSaveCoordination";

// Run with VITE_APP_PLATFORM=android against Vite's test server. Ordinary Web
// matrices skip this file; the platform must also be verified in the page.
test.skip(process.env.VITE_APP_PLATFORM !== "android", "requires the Android test platform");

const SAVE_KEY = "dsp-idle-network.save.v1";
const BASE_TIME = Date.UTC(2026, 8, 8, 1);
const OWNER = "tab_synthetic_previous_android_document";
type Lease = { schemaVersion: 1; ownerId: string; fencingToken: number; heartbeatAt: number; expiresAt: number };

async function writeLease(page: Page, lease: Lease): Promise<void> {
  await page.evaluate(async ({ key, lease }) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("dsp-idle-network.local-saves");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("records", "readwrite");
        const value = JSON.stringify(lease);
        tx.objectStore("records").put({ key, value, bytes: value.length, updatedAt: Date.now() });
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error);
      });
    } finally { db.close(); }
  }, { key: LOCAL_SAVE_WRITER_LEASE_KEY, lease });
}

async function inspect(page: Page) {
  return page.evaluate(async ({ saveKey, leaseKey }) => {
    const store = await import("/src/game/localSaveStore.ts");
    // Public store reads await initializeLocalSaveStore themselves. Inspect IDB
    // directly so observing the pre-mount wait cannot wait on that same barrier.
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("dsp-idle-network.local-saves");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const read = (key: string) => new Promise<string>((resolve, reject) => {
        const request = db.transaction("records", "readonly").objectStore("records").get(key);
        request.onsuccess = () => resolve(request.result?.value);
        request.onerror = () => reject(request.error);
      });
      return { status: store.getLocalSaveWriterStatus(), primary: await read(saveKey), lease: JSON.parse(await read(leaseKey)), now: Date.now() };
    } finally { db.close(); }
  }, { saveKey: SAVE_KEY, leaseKey: LOCAL_SAVE_WRITER_LEASE_KEY });
}

async function seed(page: Page, expiresAt = BASE_TIME + 15_000) {
  await page.clock.install({ time: new Date(BASE_TIME - 1_000) });
  await page.clock.pauseAt(new Date(BASE_TIME));
  await page.addInitScript(() => {
    localStorage.setItem("dsp-idle-network.release-notes.seen.v1", "2026-09-08-v1.2.7");
    localStorage.setItem("dsp-idle-network.onboarding.v1", "dismissed");
  });
  await page.route("**/__android_lease_seed.html", (route) => route.fulfill({
    contentType: "text/html", body: "<!doctype html><html><body>Anonymous lease seed</body></html>",
  }));
  await page.goto("/__android_lease_seed.html");
  const original = await page.evaluate(async ({ saveKey, savedAt }) => {
    const engine = await import("/src/game/engine.ts");
    const storage = await import("/src/game/storage.ts");
    const state = engine.createInitialState();
    state.paused = true;
    state.tray.iron_ore = 17;
    const raw = storage.serializeEnvelope(state, savedAt);
    // No App mount, save-store initialization, writer claim or heartbeat in the
    // seed document. Only a synthetic primary is written directly to real IDB.
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("dsp-idle-network.local-saves", 2);
      request.onupgradeneeded = () => request.result.createObjectStore("records", { keyPath: "key" });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("records", "readwrite");
        tx.objectStore("records").put({ key: saveKey, value: raw, bytes: new TextEncoder().encode(raw).byteLength, updatedAt: savedAt });
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error);
      });
    } finally { db.close(); }
    return raw;
  }, { saveKey: SAVE_KEY, savedAt: BASE_TIME });
  const lease: Lease = { schemaVersion: 1, ownerId: OWNER, fencingToken: 7, heartbeatAt: BASE_TIME, expiresAt };
  await writeLease(page, lease);
  return { original, lease };
}

async function openWaitingMenu(page: Page): Promise<void> {
  await page.goto("/?menu=1&storageMigration=production");
  await expect(page.locator("html")).toHaveAttribute("data-app-platform", "android");
  await expect.poll(async () => (await inspect(page)).status.role).toBe("secondary");
  await expect(page.locator("#root")).toBeEmpty();
}

async function expectReadOnly(page: Page, original: string, expectedLease: Lease): Promise<void> {
  await expect(page.locator(".start-menu")).toBeVisible();
  await expect(page.locator(".local-save-writer-banner--secondary")).toBeVisible();
  const result = await inspect(page);
  expect(result.status.role).toBe("secondary");
  expect(result.primary).toBe(original);
  expect(result.lease).toEqual(expectedLease);
  // Initialization has ended: expiry later must not create a mounted-page
  // automatic takeover or accept any state captured by this read-only page.
  await page.clock.runFor(30_000);
  const later = await inspect(page);
  expect(later.status.role).toBe("secondary");
  expect(later.primary).toBe(original);
  expect(later.lease).toEqual(expectedLease);
}

test("expired Android document lease is claimed before React mounts without rewriting the primary", async ({ page }) => {
  const { original, lease } = await seed(page);
  await openWaitingMenu(page);
  await page.clock.runFor(14_900);
  await expect(page.locator("#root")).toBeEmpty();
  expect((await inspect(page)).lease).toEqual(lease);
  await page.clock.runFor(200);
  await expect(page.locator(".start-menu")).toBeVisible();
  const result = await inspect(page);
  expect(result.status.role).toBe("primary");
  expect(result.lease.ownerId).toBe(result.status.writerId);
  expect(result.lease.fencingToken).toBe(lease.fencingToken + 1);
  expect(result.lease.heartbeatAt).toBeGreaterThanOrEqual(lease.expiresAt);
  expect(result.primary).toBe(original);
  await expect(page.locator(".local-save-writer-banner--secondary")).toHaveCount(0);
});

test("a live owner renewal ends startup waiting and stays read-only after later expiry", async ({ page }) => {
  const { original, lease } = await seed(page);
  await openWaitingMenu(page);
  const renewed = { ...lease, heartbeatAt: BASE_TIME + 100, expiresAt: lease.expiresAt + 100 };
  await writeLease(page, renewed);
  await page.clock.runFor(200);
  await expectReadOnly(page, original, renewed);
});

test("a third owner and fence during startup are never automatically taken over", async ({ page }) => {
  const { original, lease } = await seed(page);
  await openWaitingMenu(page);
  const takeover = { ...lease, ownerId: "tab_synthetic_third_owner", fencingToken: 8 };
  await writeLease(page, takeover);
  await page.clock.runFor(200);
  await expectReadOnly(page, original, takeover);
});

test("a page hidden during startup stops waiting and cannot claim on becoming visible", async ({ page }) => {
  const { original, lease } = await seed(page);
  await openWaitingMenu(page);
  // Only browser visibility is controlled; all lease reads and writes remain
  // real IDB transactions, with no substitution for claim/renew logic.
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.clock.runFor(200);
  await expect(page.locator(".start-menu")).toBeVisible();
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expectReadOnly(page, original, lease);
});

test("an infinite native reservation reaches read-only immediately without an overflowing timer", async ({ page }) => {
  const { original, lease } = await seed(page, Number.MAX_SAFE_INTEGER);
  await page.goto("/?menu=1&storageMigration=production");
  await expect(page.locator("html")).toHaveAttribute("data-app-platform", "android");
  await expect(page.locator(".start-menu")).toBeVisible();
  expect((await inspect(page)).now).toBe(BASE_TIME);
  await expectReadOnly(page, original, lease);
});

test("temporary Web Lock contention after expiry retries only the initial owner", async ({ page, context }) => {
  const { original, lease } = await seed(page);
  const holder = await context.newPage();
  await holder.route("**/__android_lock_holder.html", (route) => route.fulfill({ contentType: "text/html", body: "<!doctype html><body>Lock holder</body>" }));
  await holder.goto("/__android_lock_holder.html");
  await holder.evaluate(async (name) => {
    const control = window as typeof window & { releaseLeaseTestLock?: () => void };
    await new Promise<void>((resolve) => {
      void navigator.locks.request(name, async () => {
        await new Promise<void>((release) => { control.releaseLeaseTestLock = release; resolve(); });
      });
    });
  }, LOCAL_SAVE_WRITER_LOCK);
  await openWaitingMenu(page);
  await page.clock.runFor(15_100);
  await expect(page.locator("#root")).toBeEmpty();
  expect((await inspect(page)).lease).toEqual(lease);
  await holder.evaluate(() => (window as typeof window & { releaseLeaseTestLock?: () => void }).releaseLeaseTestLock?.());
  await holder.close();
  await page.clock.runFor(200);
  await expect(page.locator(".start-menu")).toBeVisible();
  const result = await inspect(page);
  expect(result.status.role).toBe("primary");
  expect(result.lease.fencingToken).toBe(8);
  expect(result.primary).toBe(original);
});
