import { describe, expect, it } from "vitest";
import { advanceSimulation, createInitialState } from "./engine";
import { cloneOrbitalStationState } from "./orbitalStation";
import {
  STATION_TASK_DAY_MS,
  STATION_TASK_TIME_ZONE_OFFSET_MS,
  acceptStationContract,
  abandonStationContract,
  claimStationContract,
  deliverStationContractMutable,
  getStationContractCompletionBasisPoints,
  getStationContractRemaining,
  normalizeStationContractBoard,
  stationTaskDayIndex,
  synchronizeStationContracts,
} from "./stationContracts";
import { stationInteger } from "./stationMath";
import type { GameState, StationContract } from "./types";

function atTaskDay(day: number): number {
  return day * STATION_TASK_DAY_MS - STATION_TASK_TIME_ZONE_OFFSET_MS + 1_000;
}

function contractReadyState(seed = 12345, day = 20): GameState {
  const state = createInitialState(seed, false);
  state.totalProduced = {
    titanium_alloy: 1,
    processor: 1,
    particle_container: 1,
    titanium_glass: 1,
    particle_broadband: 1,
    plastic: 1,
    space_warper: 1,
    frame_material: 1,
    solar_sail: 1,
    small_carrier_rocket: 1,
    quantum_chip: 1,
    antimatter_fuel_rod: 1,
    universe_matrix: 1,
  };
  state.orbitalStation.status = "showcase-building";
  state.orbitalStation.contractBoard.taskDay = day;
  state.orbitalStation.contractBoard.lastConfirmedWallClockMs = atTaskDay(day);
  state.orbitalStation = synchronizeStationContracts(state, atTaskDay(day));
  return state;
}

function deliverContract(station: GameState["orbitalStation"], contract: StationContract, fraction = 1): void {
  for (const requirement of contract.requirements) {
    const amount = stationInteger(requirement.amount) * BigInt(Math.floor(fraction * 1_000)) / 1_000n;
    const channel = requirement.channel === "quantum" ? "quantum" : "terminal";
    deliverStationContractMutable(
      station,
      contract.id,
      requirement.itemId,
      amount,
      channel,
      requirement.sourcePlanetIds?.[0] ?? "home",
    );
  }
}

describe("orbital station contracts", () => {
  it("does not write wall-clock calibration into saves before contracts unlock", () => {
    const state = createInitialState(12345, false);
    const initialClock = state.orbitalStation.contractBoard.lastConfirmedWallClockMs;
    const synchronized = synchronizeStationContracts(state, initialClock + STATION_TASK_DAY_MS * 10, 999_999);
    expect(synchronized).toBe(state.orbitalStation);
    expect(synchronized.contractBoard.lastConfirmedWallClockMs).toBe(initialClock);
  });

  it("generates a stable 3+1 board from seed, task day and rules version", () => {
    const first = contractReadyState(55123, 42);
    const second = contractReadyState(55123, 42);
    expect(first.orbitalStation.contractBoard.offers).toEqual(second.orbitalStation.contractBoard.offers);
    expect(first.orbitalStation.contractBoard.offers).toHaveLength(4);
    expect(first.orbitalStation.contractBoard.offers.filter((contract) => contract.special)).toHaveLength(1);
    expect(first.orbitalStation.contractBoard.offers.slice(0, 3).every((contract) => !contract.special)).toBe(true);
  });

  it("enforces three accepted slots and keeps accepted contracts across refresh", () => {
    let station = contractReadyState().orbitalStation;
    const ids = station.contractBoard.offers.map((offer) => offer.id);
    station = acceptStationContract(station, ids[0]);
    station = acceptStationContract(station, ids[1]);
    station = acceptStationContract(station, ids[2]);
    const unchanged = acceptStationContract(station, ids[3]);
    expect(unchanged).toBe(station);
    expect(station.contractBoard.accepted).toHaveLength(3);
    const game = contractReadyState();
    game.orbitalStation = station;
    const advanced = synchronizeStationContracts(game, atTaskDay(station.contractBoard.taskDay + 1));
    expect(advanced.contractBoard.accepted.map((contract) => contract.id)).toEqual(ids.slice(0, 3));
    expect(advanced.contractBoard.offers).toHaveLength(4);
  });

  it("claims completion rewards exactly once", () => {
    const game = contractReadyState();
    const offer = game.orbitalStation.contractBoard.offers[0];
    let station = acceptStationContract(game.orbitalStation, offer.id);
    station = cloneOrbitalStationState(station);
    const accepted = station.contractBoard.accepted[0];
    deliverContract(station, accepted);
    expect(accepted.status).toBe("claimable");
    expect(getStationContractCompletionBasisPoints(accepted)).toBe(10_000);
    const claimed = claimStationContract(station, accepted.id);
    const marks = claimed.economy.orbitalMarks;
    const reputation = claimed.economy.stationReputation;
    const duplicate = claimStationContract(claimed, accepted.id);
    expect(duplicate).toBe(claimed);
    expect(duplicate.economy.orbitalMarks).toBe(marks);
    expect(duplicate.economy.stationReputation).toBe(reputation);
    expect(duplicate.totals.completedContracts).toBe(1);
    expect(duplicate.contractBoard.settledIds).toContain(accepted.id);
  });

  it("does not regenerate settled deterministic offers on the same task day", () => {
    const game = contractReadyState(31415, 77);
    const generatedOffers = structuredClone(game.orbitalStation.contractBoard.offers);
    let station = game.orbitalStation;
    for (const offer of generatedOffers) {
      station = cloneOrbitalStationState(acceptStationContract(station, offer.id));
      const accepted = station.contractBoard.accepted.find((contract) => contract.id === offer.id)!;
      deliverContract(station, accepted);
      station = claimStationContract(station, offer.id);
    }
    expect(station.contractBoard.offers).toHaveLength(0);
    expect(station.contractBoard.history).toHaveLength(4);
    expect(station.contractBoard.settledIds).toHaveLength(4);

    const sameDay = synchronizeStationContracts(
      { ...game, orbitalStation: station },
      atTaskDay(station.contractBoard.taskDay) + 2_000,
    );
    expect(sameDay.contractBoard.offers).toHaveLength(0);
    expect(sameDay.contractBoard.history.map((contract) => contract.id)).toEqual(
      station.contractBoard.history.map((contract) => contract.id),
    );

    const nextDay = synchronizeStationContracts(
      { ...game, orbitalStation: sameDay },
      atTaskDay(station.contractBoard.taskDay + 1),
    );
    expect(nextDay.contractBoard.offers).toHaveLength(4);
    expect(nextDay.contractBoard.offers.every((offer) => !nextDay.contractBoard.settledIds.includes(offer.id))).toBe(true);
  });

  it("repairs a legacy same-day re-offer without losing history or reward fences", () => {
    const game = contractReadyState(27182, 88);
    const generatedOffers = structuredClone(game.orbitalStation.contractBoard.offers);
    let station = game.orbitalStation;
    for (const offer of generatedOffers) {
      station = cloneOrbitalStationState(acceptStationContract(station, offer.id));
      const accepted = station.contractBoard.accepted.find((contract) => contract.id === offer.id)!;
      deliverContract(station, accepted);
      station = claimStationContract(station, offer.id);
    }
    const legacyBoard = structuredClone(station.contractBoard);
    legacyBoard.offers = generatedOffers;
    // This mirrors the affected 1.1.5 save shape: the first offer was left
    // in the board while the same contract was still present as accepted.
    legacyBoard.accepted = [{
      ...structuredClone(generatedOffers[0]),
      status: "accepted",
      acceptedAtTaskDay: legacyBoard.taskDay,
    }];

    const normalized = normalizeStationContractBoard(legacyBoard, atTaskDay(legacyBoard.taskDay));
    expect(normalized.offers).toHaveLength(0);
    expect(normalized.accepted).toHaveLength(0);
    expect(normalized.history).toEqual(station.contractBoard.history);
    expect(normalized.settledIds).toEqual(station.contractBoard.settledIds);
    expect(normalized.featuredContractId).toBe(station.contractBoard.featuredContractId);
  });

  it("settles an expired partial contract proportionally without completion bonus", () => {
    const game = contractReadyState(9988, 10);
    const offer = game.orbitalStation.contractBoard.offers[0];
    game.orbitalStation = cloneOrbitalStationState(acceptStationContract(game.orbitalStation, offer.id));
    const accepted = game.orbitalStation.contractBoard.accepted[0];
    deliverContract(game.orbitalStation, accepted, 0.5);
    const basisPoints = getStationContractCompletionBasisPoints(accepted);
    expect(basisPoints).toBeGreaterThan(0);
    expect(basisPoints).toBeLessThan(10_000);
    const expired = synchronizeStationContracts(game, atTaskDay(accepted.expiresAtTaskDay));
    const history = expired.contractBoard.history.find((contract) => contract.id === accepted.id)!;
    expect(history.settlementReason).toBe("expired");
    expect(history.completionBasisPoints).toBe(basisPoints);
    expect(stationInteger(expired.economy.orbitalMarks)).toBeGreaterThan(0n);
    expect(expired.totals.completedContracts).toBe(0);
  });

  it("clears a featured completed contract only when the 48-row archive truncates it", () => {
    for (const [historyLength, expectedFeatured] of [[47, true], [48, false]] as const) {
      const game = contractReadyState(8912, 100);
      const offer = game.orbitalStation.contractBoard.offers[0];
      const station = cloneOrbitalStationState(acceptStationContract(game.orbitalStation, offer.id));
      const template = structuredClone(offer);
      station.contractBoard.history = Array.from({ length: historyLength }, (_, index): StationContract => ({
        ...structuredClone(template),
        id: `completed-history-${index}`,
        status: "settled",
        acceptedAtTaskDay: 90 - index,
        settlementId: `station-settlement:completed-history-${index}:completed`,
        settlementReason: "completed",
        settledAtTaskDay: 91 - index,
        completionBasisPoints: 10_000,
        requirements: template.requirements.map((requirement) => ({
          ...structuredClone(requirement),
          delivered: requirement.amount,
        })),
      }));
      station.contractBoard.settledIds = station.contractBoard.history.map((contract) => contract.id);
      const featuredId = station.contractBoard.history.at(-1)!.id;
      station.contractBoard.featuredContractId = featuredId;

      const archived = abandonStationContract(station, offer.id);
      expect(archived.contractBoard.history).toHaveLength(48);
      expect(archived.contractBoard.featuredContractId === featuredId).toBe(expectedFeatured);
      expect(archived.contractBoard.history.some((contract) => contract.id === featuredId)).toBe(expectedFeatured);
    }
  });

  it("uses a monotonic wall-clock task day and ignores simulation/time-warp seconds", () => {
    const state = contractReadyState(7654, 50);
    expect(stationTaskDayIndex(atTaskDay(50))).toBe(50);
    const backwards = synchronizeStationContracts(state, atTaskDay(49));
    expect(backwards.contractBoard.taskDay).toBe(50);
    const simulated = advanceSimulation(state, 24 * 60 * 60);
    expect(simulated.orbitalStation.contractBoard.taskDay).toBe(50);
    expect(simulated.orbitalStation.contractBoard.offers).toEqual(state.orbitalStation.contractBoard.offers);
  });

  it("accepts an online server task-day calibration only in the forward direction", () => {
    const state = contractReadyState(7654, 50);
    const calibrated = synchronizeStationContracts(state, atTaskDay(49), 52);
    expect(calibrated.contractBoard.taskDay).toBe(52);
    const staleServer = synchronizeStationContracts({ ...state, orbitalStation: calibrated }, atTaskDay(48), 40);
    expect(staleServer.contractBoard.taskDay).toBe(52);
  });

  it("keeps terminal source restrictions while allowing confirmed quantum fallback", () => {
    const game = contractReadyState();
    game.orbitalStation.contractBoard.offers = [{
      id: "origin-contract",
      templateId: "origin",
      slot: 0,
      title: "原产订单",
      summary: "来源限制测试",
      taskDay: game.orbitalStation.contractBoard.taskDay,
      expiresAtTaskDay: game.orbitalStation.contractBoard.taskDay + 3,
      special: false,
      difficulty: "P2",
      status: "offered",
      requirements: [{ itemId: "processor", amount: "100", delivered: "0", sourcePlanetIds: ["home"], channel: "terminal", weight: 3 }],
      rewards: { baseMarks: "10", baseReputation: "10", completionMarks: "5", completionReputation: "5" },
    }];
    const accepted = acceptStationContract(game.orbitalStation, "origin-contract");
    const terminalStation = cloneOrbitalStationState(accepted);
    expect(deliverStationContractMutable(terminalStation, "origin-contract", "processor", 100n, "terminal", "verdant").reason).toBe("invalid-channel");
    expect(terminalStation.contractBoard.accepted[0].requirements[0].delivered).toBe("0");
    expect(deliverStationContractMutable(terminalStation, "origin-contract", "processor", 100n, "terminal", "home").accepted).toBe("100");
    expect(terminalStation.contractBoard.accepted[0].status).toBe("claimable");

    const quantumStation = cloneOrbitalStationState(accepted);
    const quantumContract = quantumStation.contractBoard.accepted[0];
    expect(getStationContractRemaining(quantumContract, "processor", "quantum")).toBe(100n);
    expect(deliverStationContractMutable(quantumStation, "origin-contract", "processor", 100n, "quantum")).toMatchObject({
      accepted: "100",
      reason: "delivered",
    });
    expect(quantumContract.status).toBe("claimable");
  });

  it("does not let a cargo terminal satisfy a quantum-only requirement", () => {
    const game = contractReadyState();
    const contract: StationContract = {
      id: "quantum-only-contract",
      templateId: "quantum",
      slot: 3,
      title: "量子专属订单",
      summary: "渠道限制测试",
      taskDay: game.orbitalStation.contractBoard.taskDay,
      expiresAtTaskDay: game.orbitalStation.contractBoard.taskDay + 1,
      special: true,
      difficulty: "P3",
      status: "accepted",
      requirements: [{ itemId: "processor", amount: "100", delivered: "0", channel: "quantum", weight: 3 }],
      rewards: { baseMarks: "10", baseReputation: "10", completionMarks: "5", completionReputation: "5" },
    };
    const station = cloneOrbitalStationState(game.orbitalStation);
    station.contractBoard.accepted = [contract];
    expect(deliverStationContractMutable(station, contract.id, "processor", 100n, "terminal", "home").reason).toBe("invalid-channel");
    expect(contract.requirements[0].delivered).toBe("0");
  });

  it("settles an abandoned partial contract once and never grants the completion bonus", () => {
    const game = contractReadyState(4433, 15);
    const offer = game.orbitalStation.contractBoard.offers[0];
    let station = cloneOrbitalStationState(acceptStationContract(game.orbitalStation, offer.id));
    deliverContract(station, station.contractBoard.accepted[0], 0.25);
    const settled = abandonStationContract(station, offer.id);
    expect(settled.contractBoard.history[0].settlementReason).toBe("abandoned");
    expect(settled.totals.completedContracts).toBe(0);
    const marks = settled.economy.orbitalMarks;
    expect(abandonStationContract(settled, offer.id)).toBe(settled);
    expect(settled.economy.orbitalMarks).toBe(marks);
  });
});
