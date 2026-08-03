import { describe, expect, it } from "vitest";
import { CURRENT_RELEASE_NOTES, RELEASE_NOTES_HISTORY, getReleaseNotesPage } from "./ReleaseNotesDialog";

describe("release notes history", () => {
  it("keeps the newest release first and exposes bounded pages", () => {
    expect(RELEASE_NOTES_HISTORY[0].id).toBe(CURRENT_RELEASE_NOTES.id);
    expect(RELEASE_NOTES_HISTORY.map((entry) => Number(entry.version.split(".")[2]))).toEqual(Array.from({ length: 28 }, (_, index) => 27 - index));
    expect(getReleaseNotesPage(0)).toHaveLength(3);
    expect(getReleaseNotesPage(1)).toHaveLength(3);
    expect(getReleaseNotesPage(99)).toEqual([]);
  });

  it("supports a small fixed page size without rendering the complete history", () => {
    expect(getReleaseNotesPage(0, 2).map((entry) => entry.version)).toEqual(["1.0.27", "1.0.26"]);
    expect(getReleaseNotesPage(12, 2).map((entry) => entry.version)).toEqual(["1.0.3", "1.0.2"]);
    expect(getReleaseNotesPage(13, 2).map((entry) => entry.version)).toEqual(["1.0.1", "1.0.0"]);
  });
});
