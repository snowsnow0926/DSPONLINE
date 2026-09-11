import { describe, expect, it } from "vitest";
import { CURRENT_RELEASE_NOTES, RELEASE_NOTES_HISTORY, getReleaseNotesPage, getReleaseNotesPageCount, getReleaseNotesPageForRelease } from "./ReleaseNotesDialog";

describe("release notes history", () => {
  it("keeps the newest release first and exposes bounded pages", () => {
    expect(RELEASE_NOTES_HISTORY[0].id).toBe(CURRENT_RELEASE_NOTES.id);
    expect(RELEASE_NOTES_HISTORY.map((entry) => Number(entry.version.split(".")[2]))).toEqual(Array.from({ length: 39 }, (_, index) => 38 - index));
    expect(getReleaseNotesPage(0)).toHaveLength(3);
    expect(getReleaseNotesPage(1)).toHaveLength(3);
    expect(getReleaseNotesPage(99)).toEqual([]);
  });

  it("supports a small fixed page size without rendering the complete history", () => {
    expect(getReleaseNotesPage(0, 2).map((entry) => entry.version)).toEqual(["1.0.38", "1.0.37"]);
    expect(getReleaseNotesPage(16, 2).map((entry) => entry.version)).toEqual(["1.0.6", "1.0.5"]);
    expect(getReleaseNotesPage(17, 2).map((entry) => entry.version)).toEqual(["1.0.4", "1.0.3"]);
    expect(getReleaseNotesPage(18, 2).map((entry) => entry.version)).toEqual(["1.0.2", "1.0.1"]);
    expect(getReleaseNotesPage(19, 2).map((entry) => entry.version)).toEqual(["1.0.0"]);
  });

  it("maps direct page jumps and historical details to the same page", () => {
    expect(getReleaseNotesPageCount()).toBe(13);
    expect(getReleaseNotesPageForRelease("2026-08-11-v1.0.38")).toBe(0);
    expect(getReleaseNotesPageForRelease("2026-08-10-v1.0.37")).toBe(0);
    expect(getReleaseNotesPageForRelease("2026-08-10-v1.0.36")).toBe(0);
    expect(getReleaseNotesPageForRelease("2026-08-09-v1.0.35")).toBe(1);
    expect(getReleaseNotesPageForRelease("2026-08-07-v1.0.33")).toBe(1);
    expect(getReleaseNotesPageForRelease("2026-08-07-v1.0.32")).toBe(2);
    expect(getReleaseNotesPageForRelease("2026-08-06-v1.0.31")).toBe(2);
    expect(getReleaseNotesPageForRelease("2026-08-03-v1.0.24")).toBe(4);
    expect(getReleaseNotesPageForRelease("missing-release")).toBeNull();
  });

  it("keeps the recent release records complete instead of one-line placeholders", () => {
    for (const version of ["1.0.30", "1.0.29", "1.0.28", "1.0.27", "1.0.26", "1.0.25", "1.0.24"]) {
      expect(RELEASE_NOTES_HISTORY.find((entry) => entry.version === version)?.items.length).toBeGreaterThan(1);
    }
  });
});
