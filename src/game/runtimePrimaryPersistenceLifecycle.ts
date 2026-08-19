/**
 * One UI tab can receive autosave, manual, return and lifecycle intents at
 * nearly the same time. Their preparation mechanisms may differ, but their
 * primary CAS transactions must share one ordered admission boundary.
 */
export class RuntimePrimaryPersistenceLifecycle {
  private tail: Promise<void> = Promise.resolve();
  private queued = 0;
  private active = false;

  enqueue<Result>(operation: () => Promise<Result>): Promise<Result> {
    this.queued += 1;
    const run = async () => {
      this.queued = Math.max(0, this.queued - 1);
      this.active = true;
      try {
        return await operation();
      } finally {
        this.active = false;
      }
    };
    const result = this.tail.then(run, run);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  getSnapshot(): { active: boolean; queued: number } {
    return { active: this.active, queued: this.queued };
  }
}
