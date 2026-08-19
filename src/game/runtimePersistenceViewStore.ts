export type RuntimePersistenceKind = "autosave" | "manual" | "pure-idle-stop" | "return" | "lifecycle" | "other";
export type RuntimePersistencePhase = "checkpoint" | "serialize-write-readback" | "complete" | "failed";

export interface RuntimePersistenceProgress {
  id: number;
  kind: RuntimePersistenceKind;
  phase: RuntimePersistencePhase;
  startedAt: number;
  message: string;
}

export type RuntimePersistenceProgressUpdate = RuntimePersistenceProgress | null |
  ((current: RuntimePersistenceProgress | null) => RuntimePersistenceProgress | null);

/** Presentation-only save lifecycle store. Persistence authority, payloads and
 * gameplay state never enter this object, so a status message cannot rerender
 * the full FactoryGame projection. */
export class RuntimePersistenceViewStore {
  private progress: RuntimePersistenceProgress | null = null;
  private readonly listeners = new Set<() => void>();

  getSnapshot = (): RuntimePersistenceProgress | null => this.progress;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  publish(update: RuntimePersistenceProgressUpdate): void {
    const next = typeof update === "function" ? update(this.progress) : update;
    if (Object.is(next, this.progress)) return;
    this.progress = next;
    for (const listener of this.listeners) listener();
  }

  clear(): void {
    this.publish(null);
    this.listeners.clear();
  }
}
