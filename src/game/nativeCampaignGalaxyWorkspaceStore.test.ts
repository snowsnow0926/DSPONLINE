import { describe, expect, it, vi } from "vitest";
import type {
  DesktopNativeCoreCampaignWorkspaceProjectionResult,
  DesktopNativeCoreGalaxyAccountWorkspaceProjectionResult,
  DesktopNativePlayerAuthorityClockState,
} from "../desktop";
import { CAMPAIGN_CHAPTERS, CAMPAIGN_TASKS } from "./campaign";
import type { NativePlayerAuthorityClockSnapshot } from "./nativePlayerAuthorityClock";
import {
  NativeCampaignWorkspaceStore,
  NativeGalaxyWorkspaceStore,
  createNativePlayerAuthorityCampaignWorkspaceSource,
  createNativePlayerAuthorityGalaxyWorkspaceSource,
  selectNativeCampaignGalaxyWorkspaceAuthorityFrames,
  selectNativeCampaignWorkspaceFrame,
  selectNativeGalaxyWorkspaceFrame,
  type NativeCampaignGalaxyWorkspaceIdentity,
} from "./nativeCampaignGalaxyWorkspaceStore";

const IDENTITY: NativeCampaignGalaxyWorkspaceIdentity = Object.freeze({
  sessionId: "core-main",
  runId: "run-1",
  revision: 12,
  registryFingerprint: "builtin:test",
});

function campaignProjection(
  identity: NativeCampaignGalaxyWorkspaceIdentity = IDENTITY,
): DesktopNativeCoreCampaignWorkspaceProjectionResult {
  return {
    schemaVersion: 1,
    projectionType: "campaign-workspace-v1",
    source: "native-core",
    stateVersion: 47,
    sessionId: identity.sessionId,
    runId: identity.runId,
    revision: identity.revision,
    registryFingerprint: identity.registryFingerprint,
    truncated: false,
    limits: { chapters: 16, tasks: 64, payloadBytes: 262144 },
    counts: {
      chapters: CAMPAIGN_CHAPTERS.length,
      tasks: CAMPAIGN_TASKS.length,
      completedTasks: 0,
    },
    activeChapterId: "foundation",
    activeTaskId: "mine_first_ore",
    chapters: CAMPAIGN_CHAPTERS.map((chapter) => ({
      id: chapter.id,
      completedCount: 0,
      totalCount: chapter.taskIds.length,
      complete: false,
      tasks: chapter.taskIds.map((taskId) => {
        const definition = CAMPAIGN_TASKS.find((task) => task.id === taskId)!;
        return {
          id: taskId,
          track: definition.track,
          status: taskId === "mine_first_ore" ? "active" as const : "available" as const,
          progress: {
            current: 0,
            target: "target" in definition.metric ? definition.metric.target : 1,
          },
          locator: taskId === "mine_first_ore"
            ? { kind: "item" as const, targetId: "iron_ore" }
            : null,
        };
      }),
    })),
  };
}

function galaxyProjection(
  identity: NativeCampaignGalaxyWorkspaceIdentity = IDENTITY,
): DesktopNativeCoreGalaxyAccountWorkspaceProjectionResult {
  return {
    schemaVersion: 1,
    projectionType: "galaxy-account-workspace-v1",
    source: "native-core",
    stateVersion: 47,
    sessionId: identity.sessionId,
    runId: identity.runId,
    revision: identity.revision,
    registryFingerprint: identity.registryFingerprint,
    truncated: false,
    limits: { payloadBytes: 65536, decimalDigits: 256 },
    game: { mode: "normal", elapsedSeconds: "3600", difficulty: "standard" },
    production: {
      totalProduced: "1000000",
      universeMatrixProduced: "5",
      generationKw: "100",
      throughputPerMinute: "200",
    },
    progress: {
      campaignCompleted: 1,
      campaignTotal: CAMPAIGN_TASKS.length,
      researchCompleted: 2,
      exploredSystems: 1,
      colonizedPlanets: 1,
      galacticScore: "3",
    },
    dyson: { powerKw: "4", structurePoints: "5", rocketsLaunched: "6", sailsLaunched: "7" },
    galacticExports: {
      unlocked: true,
      inputMode: "legacy-network",
      autoDispatch: true,
      dispatchThrottle: 1,
      galacticCredits: "1200",
      galacticScore: "1200",
      totalExported: "100",
      exportedLastMinute: "60",
      exporters: { total: 2, paused: 1, running: 1 },
      projects: [
        { id: "universe_archive", itemId: "universe_matrix", enabled: true, priority: 3, level: "1", delivered: "20", totalDelivered: "1020", dispatchProgress: "0", target: "1550", reserve: "129" },
        { id: "solar_sail_array", itemId: "solar_sail", enabled: true, priority: 2, level: "0", delivered: "30", totalDelivered: "30", dispatchProgress: "1", target: "5000", reserve: "240" },
        { id: "carrier_rocket_fleet", itemId: "small_carrier_rocket", enabled: false, priority: 1, level: "0", delivered: "0", totalDelivered: "0", dispatchProgress: "0", target: "1000", reserve: "60" },
        { id: "antimatter_exchange", itemId: "antimatter_fuel_rod", enabled: false, priority: 1, level: "0", delivered: "0", totalDelivered: "0", dispatchProgress: "0", target: "500", reserve: "24" },
      ],
    },
    cloudCompatibility: {
      gameStateVersion: 47,
      envelopeVersion: 2,
      cloudSchemaVersion: 8,
      exportSupported: true,
      restoreIntoActiveAuthority: false,
      importIntoActiveAuthority: false,
      overwriteActiveAuthority: false,
    },
  };
}

function activeFrame(
  revision: number,
  overrides: Partial<DesktopNativePlayerAuthorityClockState> = {},
): DesktopNativePlayerAuthorityClockState {
  return {
    schemaVersion: 1,
    phase: "active",
    sessionId: IDENTITY.sessionId,
    runId: IDENTITY.runId,
    revision,
    acknowledgedSequence: revision,
    nextSequence: revision + 1,
    nextDeadlineMs: revision * 1_000,
    inFlight: false,
    currentOperation: null,
    queuedCommands: 0,
    lastErrorCode: null,
    ...overrides,
  };
}

function clockSnapshot(
  currentFrame: DesktopNativePlayerAuthorityClockState,
  lastConfirmedFrame: DesktopNativePlayerAuthorityClockState | null,
): NativePlayerAuthorityClockSnapshot {
  return {
    availability: "ready",
    expectedSessionId: IDENTITY.sessionId,
    currentFrame,
    lastConfirmedFrame,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

describe("native Campaign and Galaxy workspace stores", () => {
  it("keeps display lineage but withholds reads during the authority tick publication transient", () => {
    const confirmed12 = activeFrame(12);
    expect(selectNativeCampaignGalaxyWorkspaceAuthorityFrames(
      clockSnapshot(confirmed12, confirmed12),
      IDENTITY.sessionId,
    )).toEqual({ displayFrame: confirmed12, readFrame: confirmed12 });

    const inFlight13 = activeFrame(13, { inFlight: true, currentOperation: "tick" });
    expect(selectNativeCampaignGalaxyWorkspaceAuthorityFrames(
      clockSnapshot(inFlight13, confirmed12),
      IDENTITY.sessionId,
    )).toEqual({ displayFrame: confirmed12, readFrame: null });

    expect(selectNativeCampaignGalaxyWorkspaceAuthorityFrames(
      clockSnapshot(activeFrame(11, { inFlight: true, currentOperation: "tick" }), confirmed12),
      IDENTITY.sessionId,
    )).toEqual({ displayFrame: null, readFrame: null });
    expect(selectNativeCampaignGalaxyWorkspaceAuthorityFrames(
      clockSnapshot(activeFrame(13, { phase: "uncertain", lastErrorCode: "TICK_UNCERTAIN" }), confirmed12),
      IDENTITY.sessionId,
    )).toEqual({ displayFrame: null, readFrame: null });
    expect(selectNativeCampaignGalaxyWorkspaceAuthorityFrames(
      clockSnapshot(activeFrame(13, { runId: "run-2", inFlight: true, currentOperation: "tick" }), confirmed12),
      IDENTITY.sessionId,
    )).toEqual({ displayFrame: null, readFrame: null });
  });

  it("binds Campaign reads to the exact request and publishes an isolated verified frame", async () => {
    const wire = campaignProjection();
    const read = vi.fn(async () => wire);
    const source = createNativePlayerAuthorityCampaignWorkspaceSource({
      getNativeCoreCampaignWorkspaceProjection: read,
    }, IDENTITY)!;
    const store = new NativeCampaignWorkspaceStore();
    await expect(store.refresh(source, IDENTITY)).resolves.toBe("committed");
    expect(read).toHaveBeenCalledWith({
      sessionId: IDENTITY.sessionId,
      runId: IDENTITY.runId,
      expectedRevision: IDENTITY.revision,
      expectedRegistryFingerprint: IDENTITY.registryFingerprint,
    });
    const frame = selectNativeCampaignWorkspaceFrame(store.getSnapshot(), IDENTITY)!;
    expect(frame).toMatchObject({ ...IDENTITY, source: "native-core" });
    expect(frame.projection).not.toBe(wire);
    expect(frame.projection.chapters).not.toBe(wire.chapters);
    expect(Object.isFrozen(frame.projection.chapters)).toBe(true);
  });

  it("binds Galaxy reads to the exact request and preserves v47/v2/cloud-v8 boundaries", async () => {
    const read = vi.fn(async () => galaxyProjection());
    const source = createNativePlayerAuthorityGalaxyWorkspaceSource({
      getNativeCoreGalaxyAccountWorkspaceProjection: read,
    }, IDENTITY)!;
    const store = new NativeGalaxyWorkspaceStore();
    await expect(store.refresh(source, IDENTITY)).resolves.toBe("committed");
    expect(read).toHaveBeenCalledWith({
      sessionId: IDENTITY.sessionId,
      runId: IDENTITY.runId,
      expectedRevision: IDENTITY.revision,
      expectedRegistryFingerprint: IDENTITY.registryFingerprint,
    });
    expect(selectNativeGalaxyWorkspaceFrame(store.getSnapshot(), IDENTITY)?.projection.cloudCompatibility)
      .toEqual(expect.objectContaining({ gameStateVersion: 47, envelopeVersion: 2, cloudSchemaVersion: 8 }));
  });

  it("deduplicates one exact read and keeps an older verified frame while the next revision loads", async () => {
    const store = new NativeCampaignWorkspaceStore();
    const firstSource = createNativePlayerAuthorityCampaignWorkspaceSource({
      getNativeCoreCampaignWorkspaceProjection: async () => campaignProjection(),
    }, IDENTITY)!;
    await store.refresh(firstSource, IDENTITY);

    const nextIdentity = { ...IDENTITY, revision: 13 };
    const pending = deferred<DesktopNativeCoreCampaignWorkspaceProjectionResult>();
    const read = vi.fn(() => pending.promise);
    const nextSource = createNativePlayerAuthorityCampaignWorkspaceSource({
      getNativeCoreCampaignWorkspaceProjection: read,
    }, nextIdentity)!;
    const first = store.refresh(nextSource, nextIdentity);
    const duplicate = store.refresh(nextSource, nextIdentity);
    expect(read).toHaveBeenCalledTimes(1);
    expect(selectNativeCampaignWorkspaceFrame(store.getSnapshot(), nextIdentity)?.revision).toBe(12);
    pending.resolve(campaignProjection(nextIdentity));
    await expect(Promise.all([first, duplicate])).resolves.toEqual(["committed", "committed"]);
    expect(selectNativeCampaignWorkspaceFrame(store.getSnapshot(), nextIdentity)?.revision).toBe(13);
  });

  it("keeps only the older verified same-scope frame when a newer read is unavailable", async () => {
    const store = new NativeGalaxyWorkspaceStore();
    const initial = createNativePlayerAuthorityGalaxyWorkspaceSource({
      getNativeCoreGalaxyAccountWorkspaceProjection: async () => galaxyProjection(),
    }, IDENTITY)!;
    await store.refresh(initial, IDENTITY);
    const nextIdentity = { ...IDENTITY, revision: 13 };
    const unavailable = createNativePlayerAuthorityGalaxyWorkspaceSource({
      getNativeCoreGalaxyAccountWorkspaceProjection: async () => ({
        ...galaxyProjection(nextIdentity),
        runId: "old-run",
      }),
    }, nextIdentity)!;
    await expect(store.refresh(unavailable, nextIdentity)).resolves.toBe("unavailable");
    expect(store.getSnapshot()).toMatchObject({ status: "unavailable", requestedRevision: 13 });
    expect(selectNativeGalaxyWorkspaceFrame(store.getSnapshot(), nextIdentity)?.revision).toBe(12);
  });

  it("synchronously hides old frames on run, registry or revision rollback", async () => {
    const store = new NativeGalaxyWorkspaceStore();
    const initial = createNativePlayerAuthorityGalaxyWorkspaceSource({
      getNativeCoreGalaxyAccountWorkspaceProjection: async () => galaxyProjection(),
    }, IDENTITY)!;
    await store.refresh(initial, IDENTITY);
    expect(selectNativeGalaxyWorkspaceFrame(store.getSnapshot(), { ...IDENTITY, runId: "run-2" })).toBeNull();
    expect(selectNativeGalaxyWorkspaceFrame(store.getSnapshot(), {
      ...IDENTITY,
      registryFingerprint: "builtin:other",
    })).toBeNull();

    const revision20 = { ...IDENTITY, revision: 20 };
    const pending = deferred<DesktopNativeCoreGalaxyAccountWorkspaceProjectionResult>();
    const lateSource = createNativePlayerAuthorityGalaxyWorkspaceSource({
      getNativeCoreGalaxyAccountWorkspaceProjection: () => pending.promise,
    }, revision20)!;
    const late = store.refresh(lateSource, revision20);
    const rollback19 = { ...IDENTITY, revision: 19 };
    expect(selectNativeGalaxyWorkspaceFrame(store.getSnapshot(), rollback19)).toBeNull();
    const recovery = createNativePlayerAuthorityGalaxyWorkspaceSource({
      getNativeCoreGalaxyAccountWorkspaceProjection: async () => galaxyProjection(rollback19),
    }, rollback19)!;
    await expect(store.refresh(recovery, rollback19)).resolves.toBe("committed");
    pending.resolve(galaxyProjection(revision20));
    await expect(late).resolves.toBe("superseded");
    expect(selectNativeGalaxyWorkspaceFrame(store.getSnapshot(), rollback19)?.revision).toBe(19);
  });

  it("close supersedes a late read and clears every cached frame", async () => {
    const store = new NativeCampaignWorkspaceStore();
    const pending = deferred<DesktopNativeCoreCampaignWorkspaceProjectionResult>();
    const source = createNativePlayerAuthorityCampaignWorkspaceSource({
      getNativeCoreCampaignWorkspaceProjection: () => pending.promise,
    }, IDENTITY)!;
    const read = store.refresh(source, IDENTITY);
    store.close();
    pending.resolve(campaignProjection());
    await expect(read).resolves.toBe("superseded");
    expect(store.getSnapshot()).toEqual({ status: "empty", requestedRevision: null, frame: null });
  });

  it("rejects truncated, catalog-drifted and compatibility-drifted projections", async () => {
    const campaignStore = new NativeCampaignWorkspaceStore();
    const truncatedCampaign = {
      ...campaignProjection(),
      truncated: true,
    } as unknown as DesktopNativeCoreCampaignWorkspaceProjectionResult;
    const campaignSource = createNativePlayerAuthorityCampaignWorkspaceSource({
      getNativeCoreCampaignWorkspaceProjection: async () => truncatedCampaign,
    }, IDENTITY)!;
    await expect(campaignStore.refresh(campaignSource, IDENTITY)).resolves.toBe("unavailable");

    const driftedCampaign = campaignProjection();
    driftedCampaign.counts = { ...driftedCampaign.counts, tasks: driftedCampaign.counts.tasks - 1 };
    const driftedSource = createNativePlayerAuthorityCampaignWorkspaceSource({
      getNativeCoreCampaignWorkspaceProjection: async () => driftedCampaign,
    }, IDENTITY)!;
    await expect(campaignStore.refresh(driftedSource, IDENTITY)).resolves.toBe("unavailable");

    const galaxyStore = new NativeGalaxyWorkspaceStore();
    const driftedGalaxy = galaxyProjection();
    driftedGalaxy.cloudCompatibility = {
      ...driftedGalaxy.cloudCompatibility,
      cloudSchemaVersion: 7,
    } as unknown as typeof driftedGalaxy.cloudCompatibility;
    const galaxySource = createNativePlayerAuthorityGalaxyWorkspaceSource({
      getNativeCoreGalaxyAccountWorkspaceProjection: async () => driftedGalaxy,
    }, IDENTITY)!;
    await expect(galaxyStore.refresh(galaxySource, IDENTITY)).resolves.toBe("unavailable");

    const exportDriftStore = new NativeGalaxyWorkspaceStore();
    const exportDrift = galaxyProjection();
    exportDrift.galacticExports.projects[0] = {
      ...exportDrift.galacticExports.projects[0],
      itemId: "solar_sail",
    } as typeof exportDrift.galacticExports.projects[number];
    const exportDriftSource = createNativePlayerAuthorityGalaxyWorkspaceSource({
      getNativeCoreGalaxyAccountWorkspaceProjection: async () => exportDrift,
    }, IDENTITY)!;
    await expect(exportDriftStore.refresh(exportDriftSource, IDENTITY)).resolves.toBe("unavailable");
  });

  it("rejects invalid source identities before calling the desktop bridge", () => {
    const campaignRead = vi.fn();
    const galaxyRead = vi.fn();
    const invalidIdentity = { ...IDENTITY, runId: "run with spaces" };
    expect(createNativePlayerAuthorityCampaignWorkspaceSource({
      getNativeCoreCampaignWorkspaceProjection: campaignRead,
    }, invalidIdentity)).toBeNull();
    expect(createNativePlayerAuthorityGalaxyWorkspaceSource({
      getNativeCoreGalaxyAccountWorkspaceProjection: galaxyRead,
    }, invalidIdentity)).toBeNull();
    expect(campaignRead).not.toHaveBeenCalled();
    expect(galaxyRead).not.toHaveBeenCalled();
  });
});
