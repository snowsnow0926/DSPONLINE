import { describe, expect, it, vi } from "vitest";
import { RuntimePersistenceViewStore } from "./runtimePersistenceViewStore";

describe("RuntimePersistenceViewStore", () => {
  it("publishes lifecycle presentation independently and supports guarded cleanup", () => {
    const store = new RuntimePersistenceViewStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    store.publish({ id: 1, kind: "autosave", phase: "checkpoint", startedAt: 5, message: "checkpoint" });
    store.publish((current) => current?.id === 1 ? { ...current, phase: "complete", message: "complete" } : current);
    store.publish((current) => current?.id === 2 ? null : current);
    expect(store.getSnapshot()).toMatchObject({ id: 1, phase: "complete" });
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    store.publish(null);
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
