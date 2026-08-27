import { describe, expect, it } from "vitest";
import { CURRENT_RELEASE_NOTES, RELEASE_NOTES_HISTORY, getReleaseNotesPage, getReleaseNotesPageCount, getReleaseNotesPageForRelease } from "./ReleaseNotesDialog";
import { getCurrentReleaseNotes, getReleaseNotes1039, getReleaseNotes1041, getReleaseNotes1042, getReleaseNotes1043, getReleaseNotes1044, getReleaseNotes1046, getReleaseNotes114, getReleaseNotes115, getReleaseNotes116, getReleaseNotes117, getReleaseNotes118, getReleaseNotes119, getReleaseNotes120, getReleaseNotes121, getReleaseNotes122, getReleaseNotesUiCopy } from "../i18n/releaseNotes";
import { getCurrentReleaseNotes as getEagerCurrentReleaseNotes } from "../i18n/currentReleaseNotes";

describe("release notes history", () => {
  it("keeps the newest release first and exposes bounded pages", () => {
    expect(RELEASE_NOTES_HISTORY[0].id).toBe(CURRENT_RELEASE_NOTES.id);
    expect(RELEASE_NOTES_HISTORY.filter((entry) => entry.version.startsWith("1.0."))
      .map((entry) => Number(entry.version.split(".")[2]))).toEqual(Array.from({ length: 47 }, (_, index) => 46 - index));
    expect(getReleaseNotesPage(0)).toHaveLength(3);
    expect(getReleaseNotesPage(1)).toHaveLength(3);
    expect(getReleaseNotesPage(99)).toEqual([]);
  });

  it("supports a small fixed page size without rendering the complete history", () => {
    expect(getReleaseNotesPage(0, 3).map((entry) => entry.version)).toEqual(["1.2.3", "1.2.2", "1.2.1"]);
    expect(getReleaseNotesPage(18, 2).map((entry) => entry.version)).toEqual(["1.0.19", "1.0.18"]);
    expect(getReleaseNotesPage(19, 2).map((entry) => entry.version)).toEqual(["1.0.17", "1.0.16"]);
    expect(getReleaseNotesPage(20, 2).map((entry) => entry.version)).toEqual(["1.0.15", "1.0.14"]);
    expect(getReleaseNotesPage(21, 2).map((entry) => entry.version)).toEqual(["1.0.13", "1.0.12"]);
    expect(getReleaseNotesPage(22, 2).map((entry) => entry.version)).toEqual(["1.0.11", "1.0.10"]);
  });

  it("maps direct page jumps and historical details to the same page", () => {
    expect(getReleaseNotesPageCount()).toBe(19);
    expect(getReleaseNotesPageForRelease("2026-08-14-v1.0.43")).toBe(4);
    expect(getReleaseNotesPageForRelease("2026-08-14-v1.0.42")).toBe(4);
    expect(getReleaseNotesPageForRelease("2026-08-13-v1.0.41")).toBe(4);
    expect(getReleaseNotesPageForRelease("2026-08-13-v1.0.40")).toBe(5);
    expect(getReleaseNotesPageForRelease("2026-08-11-v1.0.39")).toBe(5);
    expect(getReleaseNotesPageForRelease("2026-08-11-v1.0.38")).toBe(5);
    expect(getReleaseNotesPageForRelease("2026-08-10-v1.0.37")).toBe(6);
    expect(getReleaseNotesPageForRelease("2026-08-10-v1.0.36")).toBe(6);
    expect(getReleaseNotesPageForRelease("2026-08-09-v1.0.35")).toBe(6);
    expect(getReleaseNotesPageForRelease("2026-08-07-v1.0.33")).toBe(7);
    expect(getReleaseNotesPageForRelease("2026-08-07-v1.0.32")).toBe(7);
    expect(getReleaseNotesPageForRelease("2026-08-06-v1.0.31")).toBe(8);
    expect(getReleaseNotesPageForRelease("2026-08-03-v1.0.24")).toBe(10);
    expect(getReleaseNotesPageForRelease("missing-release")).toBeNull();
  });

  it("serves the current release from stable locale keys", () => {
    const chinese = getCurrentReleaseNotes("zh-CN");
    const english = getCurrentReleaseNotes("en");
    expect(chinese).toMatchObject({ id: CURRENT_RELEASE_NOTES.id, version: "1.2.3" });
    expect(english).toMatchObject({ id: CURRENT_RELEASE_NOTES.id, version: "1.2.3" });
    expect(chinese.items).toHaveLength(5);
    expect(chinese.items.map((item) => item.id)).toEqual(expect.arrayContaining([
      "native-active-dirty-pages",
      "native-event-driven-belts",
      "native-bounded-projections",
      "native-streaming-v47-export",
      "native-authority-gate",
    ]));
    expect(english.items.map((item) => item.id)).toEqual(chinese.items.map((item) => item.id));
    expect(getEagerCurrentReleaseNotes("zh-CN").items.map((item) => item.id)).toEqual(chinese.items.map((item) => item.id));
    expect(english.summary).toContain("GameState v47");
    expect(getReleaseNotes122("en")).toMatchObject({ id: "2026-08-27-v1.2.2", version: "1.2.2" });
    expect(getReleaseNotes121("en")).toMatchObject({ id: "2026-08-27-v1.2.1", version: "1.2.1" });
    expect(getReleaseNotes120("en")).toMatchObject({ id: "2026-08-27-v1.2.0", version: "1.2.0" });
    expect(getReleaseNotes119("en")).toMatchObject({ id: "2026-08-26-v1.1.9", version: "1.1.9" });
    expect(getReleaseNotes118("en")).toMatchObject({ id: "2026-08-25-v1.1.8", version: "1.1.8" });
    expect(getReleaseNotes117("en")).toMatchObject({ id: "2026-08-24-v1.1.7", version: "1.1.7" });
    expect(getReleaseNotes116("en")).toMatchObject({ id: "2026-08-24-v1.1.6", version: "1.1.6" });
    expect(getReleaseNotes115("en")).toMatchObject({ id: "2026-08-24-v1.1.5", version: "1.1.5" });
    expect(getReleaseNotes114("en")).toMatchObject({ id: "2026-08-23-v1.1.4", version: "1.1.4" });
    expect(getReleaseNotes1046("en")).toMatchObject({ id: "2026-08-17-v1.0.46", version: "1.0.46" });
    expect(getReleaseNotes1044("en")).toMatchObject({ id: "2026-08-15-v1.0.44", version: "1.0.44" });
    expect(getReleaseNotes1043("en")).toMatchObject({ id: "2026-08-14-v1.0.43", version: "1.0.43" });
    expect(getReleaseNotes1042("en")).toMatchObject({ id: "2026-08-14-v1.0.42", version: "1.0.42" });
    expect(getReleaseNotes1041("en")).toMatchObject({ id: "2026-08-13-v1.0.41", version: "1.0.41" });
    expect(getReleaseNotes1039("en")).toMatchObject({ id: "2026-08-11-v1.0.39", version: "1.0.39" });
    expect(getReleaseNotesUiCopy("en").page(1, 15)).toBe("Page 1 of 15");
    expect(getReleaseNotesUiCopy("zh-CN").acknowledge).toBe("我知道了");
  });

  it("keeps the recent release records complete instead of one-line placeholders", () => {
    for (const version of ["1.0.30", "1.0.29", "1.0.28", "1.0.27", "1.0.26", "1.0.25", "1.0.24"]) {
      expect(RELEASE_NOTES_HISTORY.find((entry) => entry.version === version)?.items.length).toBeGreaterThan(1);
    }
  });
});
