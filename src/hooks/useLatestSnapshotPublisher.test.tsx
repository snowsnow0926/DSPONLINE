// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { useRef, useState } from "react";
import { useLatestSnapshotPublisher } from "./useLatestSnapshotPublisher";

interface LargeSnapshot {
  revision: number;
  records: readonly number[];
}

describe("useLatestSnapshotPublisher", () => {
  let root: Root | null = null;
  let host: HTMLDivElement | null = null;

  afterEach(() => {
    if (root) act(() => root!.unmount());
    host?.remove();
    root = null;
    host = null;
  });

  it("coalesces a burst and commits only the latest ref-backed snapshot", async () => {
    const committed: number[] = [];
    let publish: ((next: LargeSnapshot) => void) | null = null;

    function Harness() {
      const initialRef = useRef<LargeSnapshot>({ revision: 0, records: [] });
      const [snapshot, setSnapshot] = useState(initialRef.current);
      const latestRef = useRef(snapshot);
      const publishLatest = useLatestSnapshotPublisher(snapshot, latestRef, setSnapshot);
      publish = (next) => {
        latestRef.current = next;
        publishLatest();
      };
      committed.push(snapshot.revision);
      return <output data-revision={snapshot.revision}>{snapshot.records.length}</output>;
    }

    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root!.render(<Harness />));

    const snapshots = Array.from({ length: 25 }, (_, index) => ({
      revision: index + 1,
      records: Array.from({ length: 1_000 }, () => index + 1),
    }));
    await act(async () => {
      for (const snapshot of snapshots) publish!(snapshot);
    });

    expect(host.querySelector("output")?.getAttribute("data-revision")).toBe("25");
    expect(host.querySelector("output")?.textContent).toBe("1000");
    expect(committed.at(-1)).toBe(25);
    expect(committed.filter((revision) => revision > 0).length).toBeLessThanOrEqual(4);
  });
});
