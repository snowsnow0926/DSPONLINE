import { describe, expect, it, vi } from "vitest";
import { KeyedViewStore } from "./keyedViewStore";

describe("KeyedViewStore", () => {
  it("notifies only the changed key and preserves snapshot identity", () => {
    const store = new KeyedViewStore<{ revision: number }>();
    const first = vi.fn();
    const second = vi.fn();
    const unsubscribe = store.subscribe("first", first);
    store.subscribe("second", second);
    const snapshot = { revision: 1 };

    expect(store.publish("first", snapshot)).toBe(true);
    expect(store.publish("first", snapshot)).toBe(false);
    expect(store.get("first")).toBe(snapshot);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();

    unsubscribe();
    store.publish("first", { revision: 2 });
    expect(first).toHaveBeenCalledTimes(1);
  });

  it("drops records and subscriptions outside the retained key set", () => {
    const store = new KeyedViewStore<number>();
    const removed = vi.fn();
    store.publish("keep", 1);
    store.publish("remove", 2);
    store.subscribe("remove", removed);

    store.retain(new Set(["keep"]));
    expect(store.size).toBe(1);
    expect(store.get("keep")).toBe(1);
    expect(store.get("remove")).toBeUndefined();
    store.publish("remove", 3);
    expect(removed).not.toHaveBeenCalled();
  });

  it("does not let a retired subscription remove a replacement for the same key", () => {
    const store = new KeyedViewStore<number>();
    const retired = vi.fn();
    const replacement = vi.fn();
    const unsubscribeRetired = store.subscribe("reused", retired);

    store.retain(new Set());
    store.subscribe("reused", replacement);
    unsubscribeRetired();
    store.publish("reused", 1);

    expect(retired).not.toHaveBeenCalled();
    expect(replacement).toHaveBeenCalledTimes(1);
  });
});
