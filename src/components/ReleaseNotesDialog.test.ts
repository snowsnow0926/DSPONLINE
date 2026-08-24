import { describe, expect, it } from "vitest";
import { CURRENT_RELEASE_NOTES, RELEASE_NOTES_HISTORY, getReleaseNotesPage, getReleaseNotesPageCount, getReleaseNotesPageForRelease } from "./ReleaseNotesDialog";
import { getCurrentReleaseNotes, getReleaseNotes1039, getReleaseNotes1041, getReleaseNotes1042, getReleaseNotes1043, getReleaseNotes1044, getReleaseNotes1046, getReleaseNotes114, getReleaseNotesUiCopy } from "../i18n/releaseNotes";

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
    expect(getReleaseNotesPage(0, 3).map((entry) => entry.version)).toEqual(["1.1.5", "1.0.46", "1.0.45"]);
    expect(getReleaseNotesPage(18, 2).map((entry) => entry.version)).toEqual(["1.0.11", "1.0.10"]);
    expect(getReleaseNotesPage(19, 2).map((entry) => entry.version)).toEqual(["1.0.9", "1.0.8"]);
    expect(getReleaseNotesPage(20, 2).map((entry) => entry.version)).toEqual(["1.0.7", "1.0.6"]);
    expect(getReleaseNotesPage(21, 2).map((entry) => entry.version)).toEqual(["1.0.5", "1.0.4"]);
  });

  it("maps direct page jumps and historical details to the same page", () => {
    expect(getReleaseNotesPageCount()).toBe(16);
    expect(getReleaseNotesPageForRelease("2026-08-14-v1.0.43")).toBe(1);
    expect(getReleaseNotesPageForRelease("2026-08-14-v1.0.42")).toBe(1);
    expect(getReleaseNotesPageForRelease("2026-08-13-v1.0.41")).toBe(2);
    expect(getReleaseNotesPageForRelease("2026-08-13-v1.0.40")).toBe(2);
    expect(getReleaseNotesPageForRelease("2026-08-11-v1.0.39")).toBe(2);
    expect(getReleaseNotesPageForRelease("2026-08-11-v1.0.38")).toBe(3);
    expect(getReleaseNotesPageForRelease("2026-08-10-v1.0.37")).toBe(3);
    expect(getReleaseNotesPageForRelease("2026-08-10-v1.0.36")).toBe(3);
    expect(getReleaseNotesPageForRelease("2026-08-09-v1.0.35")).toBe(4);
    expect(getReleaseNotesPageForRelease("2026-08-07-v1.0.33")).toBe(4);
    expect(getReleaseNotesPageForRelease("2026-08-07-v1.0.32")).toBe(5);
    expect(getReleaseNotesPageForRelease("2026-08-06-v1.0.31")).toBe(5);
    expect(getReleaseNotesPageForRelease("2026-08-03-v1.0.24")).toBe(7);
    expect(getReleaseNotesPageForRelease("missing-release")).toBeNull();
  });

  it("serves the current release from stable locale keys", () => {
    const chinese = getCurrentReleaseNotes("zh-CN");
    const english = getCurrentReleaseNotes("en");
    expect(chinese).toMatchObject({ id: CURRENT_RELEASE_NOTES.id, version: "1.1.5" });
    expect(english).toMatchObject({ id: CURRENT_RELEASE_NOTES.id, version: "1.1.5" });
    expect(chinese.items).toHaveLength(6);
    expect(chinese.items.map((item) => item.id)).toEqual(expect.arrayContaining([
      "compressed-worker-save-transport",
      "gzip-save-export",
      "v47-default-compaction",
      "large-save-pure-idle",
      "balanced-galaxy-score",
    ]));
    expect(english.items.map((item) => item.id)).toEqual(chinese.items.map((item) => item.id));
    expect(english.summary).toContain("GameState v47");
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
