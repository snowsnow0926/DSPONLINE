import { describe, expect, it, vi } from "vitest";
import { PreparedAutomaticSnapshotLifecycle } from "./preparedAutomaticSnapshotLifecycle";
import type { PreparedAuthoritativeSaveCheckpoint } from "./simulationPreparedSaveLifecycle";
import type { SimulationStateIdentity } from "./simulationRuntimeProtocol";
import type { VerifiedPrimaryLocalSaveIdentity } from "./localSaveStore";

const primaryIdentity: VerifiedPrimaryLocalSaveIdentity = {
  key: "primary",
  mode: "normal",
  revision: 1,
  savedAt: 10,
  stateChecksum: "12345678",
  payloadChecksum: "12345678",
  byteLength: 100,
};
const stateIdentity: SimulationStateIdentity = {
  mode: "normal",
  version: 47,
  activePlanetId: "home",
  entityCount: 1,
  beltCount: 0,
  elapsedSeconds: 600,
  paused: false,
};

describe("prepared automatic snapshot lifecycle", () => {
  it("does not schedule a recovery write when the elapsed boundary is not due", () => {
    const setTimer = vi.fn();
    const lifecycle = new PreparedAutomaticSnapshotLifecycle({
      isDue: () => false,
      commit: vi.fn(),
      setTimer,
      clearTimer: vi.fn(),
    });
    expect(lifecycle.schedule({ primaryIdentity, stateIdentity, request: vi.fn(), isExiting: () => false })).toBe(false);
    expect(setTimer).not.toHaveBeenCalled();
  });

  it("lets a newer primary supersede the older timer and commits only the latest exact identity", async () => {
    const timers: Array<() => void> = [];
    const commit = vi.fn().mockResolvedValue(null);
    const checkpoint = { prepared: {}, identity: stateIdentity } as PreparedAuthoritativeSaveCheckpoint;
    const firstRequest = vi.fn().mockResolvedValue(checkpoint);
    const secondRequest = vi.fn().mockResolvedValue(checkpoint);
    const lifecycle = new PreparedAutomaticSnapshotLifecycle({
      isDue: () => true,
      commit,
      setTimer: (callback) => { timers.push(callback); return timers.length as unknown as ReturnType<typeof setTimeout>; },
      clearTimer: vi.fn(),
    });
    lifecycle.schedule({ primaryIdentity, stateIdentity, request: firstRequest, isExiting: () => false });
    const newerIdentity = { ...primaryIdentity, revision: 2 };
    lifecycle.schedule({ primaryIdentity: newerIdentity, stateIdentity, request: secondRequest, isExiting: () => false });
    timers[0]();
    timers[1]();
    await Promise.resolve();
    await Promise.resolve();
    expect(firstRequest).not.toHaveBeenCalled();
    expect(secondRequest).toHaveBeenCalledOnce();
    expect(commit).toHaveBeenCalledWith(checkpoint.prepared, checkpoint.identity, newerIdentity);
  });

  it("cancels a prepared result if page exit begins while the Worker is running", async () => {
    let fire!: () => void;
    let exiting = false;
    let resolveRequest!: (value: PreparedAuthoritativeSaveCheckpoint | null) => void;
    const request = vi.fn(() => new Promise<PreparedAuthoritativeSaveCheckpoint | null>((resolve) => { resolveRequest = resolve; }));
    const commit = vi.fn();
    const lifecycle = new PreparedAutomaticSnapshotLifecycle({
      isDue: () => true,
      commit,
      setTimer: (callback) => { fire = callback; return 1 as unknown as ReturnType<typeof setTimeout>; },
      clearTimer: vi.fn(),
    });
    lifecycle.schedule({ primaryIdentity, stateIdentity, request, isExiting: () => exiting });
    fire();
    await Promise.resolve();
    exiting = true;
    resolveRequest({ prepared: {}, identity: stateIdentity } as PreparedAuthoritativeSaveCheckpoint);
    await Promise.resolve();
    await Promise.resolve();
    expect(commit).not.toHaveBeenCalled();
  });
});
