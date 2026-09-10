import { expect, test } from "@playwright/test";
import { createInitialState, createSpeedrunInitialState } from "../../src/game/engine";
import { serializeEnvelope } from "../../src/game/storage";

const fixtures = {
  normal: createInitialState(144_982, false),
  speedrun: createSpeedrunInitialState(1_700_000_000_000, "emergency-cleanup-fixture"),
};

test.beforeEach(async ({ page }) => {
  await page.route("**/api/**", (route) => route.fulfill({
    status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }),
  }));
  await page.goto("/?storageMigration=production");
  await expect(page.locator(".start-menu")).toBeVisible();
  expect(await page.evaluate(async () => {
    const store = await import("/src/game/localSaveStore.ts");
    await store.initializeLocalSaveStore();
    return store.getLocalSaveBackend();
  })).toBe("indexeddb");
});

test("empty emergency cleanup never reparses either committed factory", async ({ page }) => {
  const raws = Object.values(fixtures).map((state) => serializeEnvelope(state, 100));
  const result = await page.evaluate(async (raws) => {
    const store = await import("/src/game/localSaveStore.ts");
    const before = { ...localStorage };
    const original = JSON.parse;
    let fullPayloadParses = 0;
    JSON.parse = (text, reviver) => {
      if (raws.includes(text)) fullPayloadParses += 1;
      return original(text, reviver);
    };
    try {
      for (const raw of raws) store.clearPrimarySaveEmergencyMirror(raw);
      return { fullPayloadParses, storageUnchanged: JSON.stringify({ ...localStorage }) === JSON.stringify(before) };
    } finally { JSON.parse = original; }
  }, raws);
  expect(result).toEqual({ fullPayloadParses: 0, storageUnchanged: true });
});

for (const mode of ["normal", "speedrun"] as const) {
  test(`${mode} cleanup preserves newer and foreign mirrors and retires exact or orphaned entries`, async ({ page }) => {
    const raw = serializeEnvelope(fixtures[mode], 100);
    const newer = serializeEnvelope(fixtures[mode], 200);
    const otherMode = mode === "normal" ? "speedrun" : "normal";
    const other = serializeEnvelope(fixtures[otherMode], 100);
    const result = await page.evaluate(async ({ mode, raw, newer, otherMode, other }) => {
      const store = await import("/src/game/localSaveStore.ts");
      const { localSaveEmergencyMirrorKeys } = await import("/src/game/localSaveCoordination.ts");
      const keys = localSaveEmergencyMirrorKeys(mode);
      const otherKeys = localSaveEmergencyMirrorKeys(otherMode);
      if (!store.writePrimarySaveEmergencyMirror(other) || !store.writePrimarySaveEmergencyMirror(newer)) {
        throw new Error("isolated writer did not seed emergency mirrors");
      }
      store.clearPrimarySaveEmergencyMirror(raw);
      const newerPreserved = localStorage.getItem(keys.payload) === newer;
      if (!store.writePrimarySaveEmergencyMirror(raw)) throw new Error("old mirror seed failed");
      const metadata = JSON.parse(localStorage.getItem(keys.metadata)!);
      localStorage.setItem(keys.metadata, JSON.stringify({ ...metadata, writerId: "another-test-writer" }));
      store.clearPrimarySaveEmergencyMirror(newer);
      const foreignPreserved = localStorage.getItem(keys.payload) === raw;
      store.clearPrimarySaveEmergencyMirror(raw);
      const exactCleared = localStorage.getItem(keys.payload) === null && localStorage.getItem(keys.metadata) === null;
      localStorage.setItem(keys.metadata, JSON.stringify(metadata));
      store.clearPrimarySaveEmergencyMirror(raw);
      const orphanMetadataCleared = localStorage.getItem(keys.metadata) === null;
      localStorage.setItem(keys.payload, newer);
      store.clearPrimarySaveEmergencyMirror(raw);
      return {
        newerPreserved, foreignPreserved, exactCleared, orphanMetadataCleared,
        missingMetadataPreserved: localStorage.getItem(keys.payload) === newer,
        otherModePreserved: localStorage.getItem(otherKeys.payload) === other && localStorage.getItem(otherKeys.metadata) !== null,
      };
    }, { mode, raw, newer, otherMode, other });
    expect(result).toEqual({
      newerPreserved: true, foreignPreserved: true, exactCleared: true,
      orphanMetadataCleared: true, missingMetadataPreserved: true, otherModePreserved: true,
    });
  });
}

test("metadata-only records are reconciled when neither mode has a payload", async ({ page }) => {
  const raws = Object.values(fixtures).map((state) => serializeEnvelope(state, 100));
  const result = await page.evaluate(async (raws) => {
    const store = await import("/src/game/localSaveStore.ts");
    const { localSaveEmergencyMirrorKeys } = await import("/src/game/localSaveCoordination.ts");
    const cleared: boolean[] = [];
    for (const [index, mode] of (["normal", "speedrun"] as const).entries()) {
      const keys = localSaveEmergencyMirrorKeys(mode);
      if (!store.writePrimarySaveEmergencyMirror(raws[index])) throw new Error("mirror seed failed");
      localStorage.removeItem(keys.payload);
      store.clearPrimarySaveEmergencyMirror(raws[index]);
      cleared.push(localStorage.getItem(keys.metadata) === null);
    }
    return cleared;
  }, raws);
  expect(result).toEqual([true, true]);
});

test("legacy speedrun emergency keys retain their original age-based cleanup", async ({ page }) => {
  const raw = serializeEnvelope(fixtures.speedrun, 100);
  const newer = serializeEnvelope(fixtures.speedrun, 200);
  const result = await page.evaluate(async ({ raw, newer }) => {
    const store = await import("/src/game/localSaveStore.ts");
    const key = "dsp-idle-network.save.v1.speedrun.emergency";
    store.setLocalSaveValue(key, newer);
    await store.flushLocalSaveWrites();
    store.clearPrimarySaveEmergencyMirror(raw);
    const newerPreserved = store.getLocalSaveValue(key) === newer;
    store.clearPrimarySaveEmergencyMirror(newer);
    await store.flushLocalSaveWrites();
    return { newerPreserved, cleared: await store.readPersistedLocalSaveValue(key) === null };
  }, { raw, newer });
  expect(result).toEqual({ newerPreserved: true, cleared: true });
});
