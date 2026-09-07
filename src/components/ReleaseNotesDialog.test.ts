import { describe, expect, it, vi } from "vitest";
import { CURRENT_RELEASE_NOTES, RELEASE_NOTES_HISTORY, getReleaseNotesPage, getReleaseNotesPageCount, getReleaseNotesPageForRelease } from "./ReleaseNotesDialog";
import { getCurrentReleaseNotes, getReleaseNotes1039, getReleaseNotes1041, getReleaseNotes1042, getReleaseNotes1043, getReleaseNotes1044, getReleaseNotes1046, getReleaseNotes114, getReleaseNotes115, getReleaseNotes116, getReleaseNotes117, getReleaseNotes118, getReleaseNotes119, getReleaseNotes120, getReleaseNotes121, getReleaseNotes122, getReleaseNotes123, getReleaseNotes124, getReleaseNotes125, getReleaseNotes126, getReleaseNotesUiCopy } from "../i18n/releaseNotes";
import { CURRENT_RELEASE_ID, getCurrentReleaseNotes as getEagerCurrentReleaseNotes } from "../i18n/currentReleaseNotes";
import { hasSeenCurrentReleaseNotes, markCurrentReleaseNotesSeen, RELEASE_NOTES_SEEN_KEY } from "./releaseNotesSeen";

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
    expect(getReleaseNotesPage(0, 3).map((entry) => entry.version)).toEqual(["1.2.7", "1.2.6", "1.2.5"]);
    expect(getReleaseNotesPage(18, 2).map((entry) => entry.version)).toEqual(["1.0.23", "1.0.22"]);
    expect(getReleaseNotesPage(19, 2).map((entry) => entry.version)).toEqual(["1.0.21", "1.0.20"]);
    expect(getReleaseNotesPage(20, 2).map((entry) => entry.version)).toEqual(["1.0.19", "1.0.18"]);
    expect(getReleaseNotesPage(21, 2).map((entry) => entry.version)).toEqual(["1.0.17", "1.0.16"]);
    expect(getReleaseNotesPage(22, 2).map((entry) => entry.version)).toEqual(["1.0.15", "1.0.14"]);
  });

  it("maps direct page jumps and historical details to the same page", () => {
    expect(getReleaseNotesPageCount()).toBe(20);
    expect(getReleaseNotesPageForRelease("2026-08-14-v1.0.43")).toBe(5);
    expect(getReleaseNotesPageForRelease("2026-08-14-v1.0.42")).toBe(5);
    expect(getReleaseNotesPageForRelease("2026-08-13-v1.0.41")).toBe(6);
    expect(getReleaseNotesPageForRelease("2026-08-13-v1.0.40")).toBe(6);
    expect(getReleaseNotesPageForRelease("2026-08-11-v1.0.39")).toBe(6);
    expect(getReleaseNotesPageForRelease("2026-08-11-v1.0.38")).toBe(7);
    expect(getReleaseNotesPageForRelease("2026-08-10-v1.0.37")).toBe(7);
    expect(getReleaseNotesPageForRelease("2026-08-10-v1.0.36")).toBe(7);
    expect(getReleaseNotesPageForRelease("2026-08-09-v1.0.35")).toBe(8);
    expect(getReleaseNotesPageForRelease("2026-08-07-v1.0.33")).toBe(8);
    expect(getReleaseNotesPageForRelease("2026-08-07-v1.0.32")).toBe(9);
    expect(getReleaseNotesPageForRelease("2026-08-06-v1.0.31")).toBe(9);
    expect(getReleaseNotesPageForRelease("2026-08-03-v1.0.24")).toBe(11);
    expect(getReleaseNotesPageForRelease("missing-release")).toBeNull();
  });

  it("serves the current release from stable locale keys", () => {
    const chinese = getCurrentReleaseNotes("zh-CN");
    const english = getCurrentReleaseNotes("en");
    expect(chinese).toMatchObject({ id: "2026-09-08-v1.2.7", date: "2026年9月8日", version: "1.2.7" });
    expect(english).toMatchObject({ id: CURRENT_RELEASE_ID, date: "September 8, 2026", version: "1.2.7" });
    expect(chinese.items).toHaveLength(6);
    expect(chinese.items.map((item) => item.id)).toEqual(expect.arrayContaining([
      "v127-save-import",
      "v127-automatic-snapshots",
      "v127-offline-preparation",
      "v127-idle-recovery",
      "v127-gameplay-compatibility",
      "v127-release-scope",
    ]));
    expect(english.items.map((item) => item.id)).toEqual(chinese.items.map((item) => item.id));
    expect(getEagerCurrentReleaseNotes("zh-CN")).toEqual(chinese);
    expect(getEagerCurrentReleaseNotes("en")).toEqual(english);
    expect(chinese.summary).toContain("网页版和安卓版");
    expect(english.summary).toContain("Web and Android");
    expect(chinese.items.find((item) => item.id === "v127-release-scope")?.description).toContain("Rust 核心的跨端接入将继续开发");
    expect(english.items.find((item) => item.id === "v127-release-scope")?.description).toContain("remains future work");
    expect(chinese.summary).toContain("Windows 下载版本维持现状");
    expect(english.summary).toContain("The Windows download stays at its current version");
    expect(chinese.items.find((item) => item.id === "v127-idle-recovery")?.description).toContain("同一页面内重试会复用本次结果");
    expect(english.items.find((item) => item.id === "v127-idle-recovery")?.description).toContain("never uploaded automatically");
    expect(JSON.stringify([chinese, english])).not.toMatch(/\d+(?:\.\d+)?\s*%/);
    expect(getReleaseNotes126("en")).toMatchObject({ id: "2026-08-31-v1.2.6", version: "1.2.6" });
    expect(getReleaseNotes125("en")).toMatchObject({ id: "2026-08-30-v1.2.5", version: "1.2.5" });
    expect(getReleaseNotes124("en")).toMatchObject({ id: "2026-08-28-v1.2.4", version: "1.2.4" });
    expect(getReleaseNotes123("en")).toMatchObject({ id: "2026-08-28-v1.2.3", version: "1.2.3" });
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

  it("shows the formal announcement after the development notice and remembers only the new ID", () => {
    const records = new Map([[RELEASE_NOTES_SEEN_KEY, "2026-09-02-v1.2.7"]]);
    vi.stubGlobal("window", {
      location: { search: "" },
      localStorage: {
        getItem: (key: string) => records.get(key) ?? null,
        setItem: (key: string, value: string) => records.set(key, value),
      },
      sessionStorage: { getItem: () => null },
    });
    try {
      expect(hasSeenCurrentReleaseNotes()).toBe(false);
      markCurrentReleaseNotesSeen();
      expect(records.get(RELEASE_NOTES_SEEN_KEY)).toBe(CURRENT_RELEASE_ID);
      expect(hasSeenCurrentReleaseNotes()).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps the recent release records complete instead of one-line placeholders", () => {
    for (const version of ["1.0.30", "1.0.29", "1.0.28", "1.0.27", "1.0.26", "1.0.25", "1.0.24"]) {
      expect(RELEASE_NOTES_HISTORY.find((entry) => entry.version === version)?.items.length).toBeGreaterThan(1);
    }
  });
});
