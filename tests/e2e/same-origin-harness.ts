import type { Page } from "@playwright/test";

const HARNESS_PATH = "/__dspidle_same_origin_harness__.html";
const HARNESS_ROUTE = `**${HARNESS_PATH}`;

/**
 * Opens an inert document on the application origin so a test can seed
 * browser-owned storage before the product boot sequence starts.
 *
 * Do not use a missing public asset for this job: Vite serves index.html for
 * unknown paths, which starts the application and races its IndexedDB
 * initialization against the fixture write.
 */
export async function openSameOriginStorageHarness(page: Page): Promise<void> {
  await page.route(HARNESS_ROUTE, (route) => route.fulfill({
    status: 200,
    contentType: "text/html; charset=utf-8",
    body: "<!doctype html><html><head><meta charset=\"utf-8\"></head><body data-e2e-storage-harness=\"true\"></body></html>",
  }));
  try {
    await page.goto(HARNESS_PATH);
  } finally {
    await page.unroute(HARNESS_ROUTE);
  }
}
