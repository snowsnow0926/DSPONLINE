/// <reference lib="webworker" />
import "../compat/runtime";

import { createSimulationPlanetPhaseLookup, runPlanetSimulationPhase } from "./engine";
import type { PlanetPhaseWorkerRequest, PlanetPhaseWorkerResponse } from "./multicoreSimulation";
import { applyContentPackRuntimeSnapshot } from "./contentPacks";

let activeRegistryFingerprint = "core";

self.onmessage = (event: MessageEvent<PlanetPhaseWorkerRequest>) => {
  const request = event.data;
  try {
    if (request.registryFingerprint !== activeRegistryFingerprint) {
      if (!request.registry || request.registry.fingerprint !== request.registryFingerprint) {
        throw new Error("星球分区 Worker 缺少匹配的内容包注册表");
      }
      applyContentPackRuntimeSnapshot(request.registry);
      activeRegistryFingerprint = request.registryFingerprint;
    }
    const reception = {
      efficiency: request.reception.efficiency,
      receiverLoadKw: request.reception.receiverLoadKw,
      allocationByEntity: new Map(request.reception.allocationByEntity),
      efficiencyByEntity: new Map(request.reception.efficiencyByEntity),
      rayPowerByPlanet: new Map(request.reception.rayPowerByPlanet),
    };
    const lookup = createSimulationPlanetPhaseLookup(request.state);
    const beltStepReservation = { allowanceByBelt: new Map<string, number>(), outputCredits: new Map(request.outputCredits) };
    const results = request.planetIds.map((planetId) => runPlanetSimulationPhase(
      request.state,
      request.seconds,
      planetId,
      reception,
      beltStepReservation,
      lookup,
      undefined,
      request.batchPowerStorage,
      request.batchConstructionAutomation,
    ));
    self.postMessage({ id: request.id, ok: true, results } satisfies PlanetPhaseWorkerResponse);
  } catch (error) {
    self.postMessage({
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    } satisfies PlanetPhaseWorkerResponse);
  }
};

export {};
