export type KeyedViewStoreListener = () => void;

/**
 * Tiny external store for independently rendered UI records. It deliberately
 * owns no gameplay state and has no persistence path: publishers replace one
 * key at a time, while subscribers only wake for their own key.
 */
export class KeyedViewStore<T> {
  private readonly values = new Map<string, T>();
  private readonly listeners = new Map<string, Set<KeyedViewStoreListener>>();

  get(key: string): T | undefined {
    return this.values.get(key);
  }

  publish(key: string, value: T): boolean {
    if (Object.is(this.values.get(key), value)) return false;
    this.values.set(key, value);
    for (const listener of this.listeners.get(key) ?? []) listener();
    return true;
  }

  subscribe(key: string, listener: KeyedViewStoreListener): () => void {
    let keyed = this.listeners.get(key);
    if (!keyed) {
      keyed = new Set();
      this.listeners.set(key, keyed);
    }
    keyed.add(listener);
    return () => {
      keyed!.delete(listener);
      if (keyed!.size === 0 && this.listeners.get(key) === keyed) this.listeners.delete(key);
    };
  }

  retain(keys: ReadonlySet<string>): void {
    for (const key of this.values.keys()) {
      if (!keys.has(key)) this.values.delete(key);
    }
    for (const key of this.listeners.keys()) {
      if (!keys.has(key)) this.listeners.delete(key);
    }
  }

  get size(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
    this.listeners.clear();
  }
}
