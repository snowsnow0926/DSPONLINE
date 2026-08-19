import { describe, expect, it } from "vitest";
import { RuntimePrimaryPersistenceLifecycle } from "./runtimePrimaryPersistenceLifecycle";

describe("runtime primary persistence lifecycle", () => {
  it("serializes unlike primary-save preparation paths without losing results", async () => {
    const lifecycle = new RuntimePrimaryPersistenceLifecycle();
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const first = lifecycle.enqueue(async () => {
      events.push("prepared:start");
      await firstGate;
      events.push("prepared:end");
      return 1;
    });
    const second = lifecycle.enqueue(async () => {
      events.push("legacy:start");
      events.push("legacy:end");
      return 2;
    });

    await Promise.resolve();
    expect(events).toEqual(["prepared:start"]);
    expect(lifecycle.getSnapshot()).toEqual({ active: true, queued: 1 });
    releaseFirst();
    await expect(Promise.all([first, second])).resolves.toEqual([1, 2]);
    expect(events).toEqual(["prepared:start", "prepared:end", "legacy:start", "legacy:end"]);
    expect(lifecycle.getSnapshot()).toEqual({ active: false, queued: 0 });
  });

  it("keeps the admission chain live after a failed save", async () => {
    const lifecycle = new RuntimePrimaryPersistenceLifecycle();
    const failed = lifecycle.enqueue(async () => { throw new Error("save failed"); });
    const recovered = lifecycle.enqueue(async () => "recovered");
    await expect(failed).rejects.toThrow("save failed");
    await expect(recovered).resolves.toBe("recovered");
    expect(lifecycle.getSnapshot()).toEqual({ active: false, queued: 0 });
  });
});
