import { isAutomaticSnapshotDue, savePreparedAutomaticSnapshot } from "./storage";
import type { VerifiedPrimaryLocalSaveIdentity } from "./localSaveStore";
import type { PreparedAuthoritativeSaveCheckpoint } from "./simulationPreparedSaveLifecycle";
import type { SimulationStateIdentity } from "./simulationRuntimeProtocol";

export interface PreparedAutomaticSnapshotSchedule {
  primaryIdentity: VerifiedPrimaryLocalSaveIdentity;
  stateIdentity: SimulationStateIdentity;
  request: () => Promise<PreparedAuthoritativeSaveCheckpoint | null>;
  isExiting: () => boolean;
  delayMs?: number;
}

export interface PreparedAutomaticSnapshotLifecycleDependencies {
  isDue: typeof isAutomaticSnapshotDue;
  commit: typeof savePreparedAutomaticSnapshot;
  setTimer: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer: (timer: ReturnType<typeof setTimeout>) => void;
}

const defaultDependencies: PreparedAutomaticSnapshotLifecycleDependencies = {
  isDue: isAutomaticSnapshotDue,
  commit: savePreparedAutomaticSnapshot,
  setTimer: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimer: (timer) => globalThis.clearTimeout(timer),
};

/** Owns the best-effort post-primary snapshot timer independently from React
 * rendering. Newer primaries supersede older jobs before and after Worker
 * preparation; the commit function repeats exact primary-identity admission. */
export class PreparedAutomaticSnapshotLifecycle {
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly dependencies: PreparedAutomaticSnapshotLifecycleDependencies = defaultDependencies) {}

  schedule(schedule: PreparedAutomaticSnapshotSchedule): boolean {
    if (!this.dependencies.isDue(schedule.stateIdentity.mode, schedule.stateIdentity.elapsedSeconds)) return false;
    const generation = ++this.generation;
    if (this.timer !== null) this.dependencies.clearTimer(this.timer);
    this.timer = this.dependencies.setTimer(() => {
      this.timer = null;
      void this.run(generation, schedule);
    }, schedule.delayMs ?? 5_000);
    return true;
  }

  cancel(): void {
    this.generation += 1;
    if (this.timer !== null) this.dependencies.clearTimer(this.timer);
    this.timer = null;
  }

  private async run(generation: number, schedule: PreparedAutomaticSnapshotSchedule): Promise<void> {
    try {
      if (generation !== this.generation || schedule.isExiting() ||
        !this.dependencies.isDue(schedule.stateIdentity.mode, schedule.stateIdentity.elapsedSeconds)) return;
      const checkpoint = await schedule.request();
      if (!checkpoint || generation !== this.generation || schedule.isExiting()) return;
      await this.dependencies.commit(checkpoint.prepared, checkpoint.identity, schedule.primaryIdentity);
    } catch {
      // Recovery snapshots are independent of the already-verified primary.
    }
  }
}
