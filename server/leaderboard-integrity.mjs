export const LEADERBOARD_INTEGRITY_VERSION = "leaderboard-integrity-v2";
export const LEADERBOARD_INTEGRITY_COMPATIBLE_GAME_STATE_VERSIONS = Object.freeze([46, 47]);

const COMPATIBLE_GAME_STATE_VERSIONS = new Set(LEADERBOARD_INTEGRITY_COMPATIBLE_GAME_STATE_VERSIONS);
const MATERIAL_SNAPSHOT_VERSION = 1;
const ROCKET = "small_carrier_rocket";
const SAIL = "solar_sail";
const MATERIAL_IDS = [ROCKET, SAIL];
const EXPORT_PROJECT_ITEM = Object.freeze({
  carrier_rocket_fleet: ROCKET,
  solar_sail_array: SAIL,
});

function finiteNonNegativeNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function exactNonNegativeInteger(value) {
  try {
    if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
    return typeof value === "string" && /^(0|[1-9]\d*)$/.test(value) ? BigInt(value) : null;
  } catch {
    return null;
  }
}

function productionRecord(state) {
  return state?.totalProduced && typeof state.totalProduced === "object" && !Array.isArray(state.totalProduced)
    ? state.totalProduced
    : {};
}

function elapsed(state) {
  return finiteNonNegativeNumber(state?.elapsedSeconds) ? state.elapsedSeconds : 0;
}

function addAmount(target, itemId, amount) {
  target[itemId] = (target[itemId] ?? 0n) + amount;
}

function addCriticalStore(target, value, label, issues, seen) {
  if (!value || typeof value !== "object" || Array.isArray(value) || seen.has(value)) return;
  seen.add(value);
  for (const itemId of MATERIAL_IDS) {
    if (!Object.hasOwn(value, itemId)) continue;
    const amount = exactNonNegativeInteger(value[itemId]);
    if (amount === null) issues.push(`${label}.${itemId}`);
    else addAmount(target, itemId, amount);
  }
}

function criticalCounter(value, label, issues) {
  const amount = exactNonNegativeInteger(value ?? 0);
  if (amount === null) {
    issues.push(label);
    return 0n;
  }
  return amount;
}

function materialStockSnapshot(state, issues) {
  const stock = { [ROCKET]: 0n, [SAIL]: 0n };
  const seen = new Set();
  addCriticalStore(stock, state?.tray, "tray", issues, seen);
  for (const [planetId, tray] of Object.entries(state?.planetTrays ?? {})) {
    if (planetId !== state?.activePlanetId) addCriticalStore(stock, tray, `planetTrays.${planetId}`, issues, seen);
  }

  const entities = Array.isArray(state?.entities) ? state.entities : [];
  const entityById = new Map(entities.flatMap((entity) => typeof entity?.id === "string" ? [[entity.id, entity]] : []));
  const routeReservations = new Map();
  const seenRouteIds = new Set();
  for (const entity of entities) {
    addCriticalStore(stock, entity?.inputs, `entities.${entity?.id ?? "?"}.inputs`, issues, seen);
    addCriticalStore(stock, entity?.outputs, `entities.${entity?.id ?? "?"}.outputs`, issues, seen);
    for (const route of Array.isArray(entity?.stationRoutes) ? entity.stationRoutes : []) {
      if (!MATERIAL_IDS.includes(route?.itemId) || typeof route?.id !== "string" || seenRouteIds.has(route.id)) continue;
      seenRouteIds.add(route.id);
      const cargo = exactNonNegativeInteger(route.cargo);
      if (cargo === null) {
        issues.push(`stationRoutes.${route.id}.cargo`);
        continue;
      }
      addAmount(stock, route.itemId, cargo);
      let byItem = routeReservations.get(route.peerId);
      if (!byItem) routeReservations.set(route.peerId, byItem = new Map());
      byItem.set(route.itemId, (byItem.get(route.itemId) ?? 0n) + cargo);
    }
  }
  // Route cargo is still reserved in source.outputs. Replace that reservation
  // with the explicit route amount so in-flight material is counted once.
  for (const [sourceId, byItem] of routeReservations) {
    const source = entityById.get(sourceId);
    for (const [itemId, reserved] of byItem) {
      const sourceAmount = exactNonNegativeInteger(source?.outputs?.[itemId]) ?? 0n;
      addAmount(stock, itemId, -(reserved < sourceAmount ? reserved : sourceAmount));
    }
  }

  addCriticalStore(stock, state?.construction, "construction", issues, seen);
  for (const [jobId, job] of Object.entries(state?.constructionAutomation?.jobs ?? {})) {
    addCriticalStore(stock, job?.inventory, `constructionAutomation.jobs.${jobId}.inventory`, issues, seen);
  }
  for (const [entityId, inventory] of Object.entries(state?.constructionAutomation?.quantumMaterialBuffer ?? {})) {
    addCriticalStore(stock, inventory, `constructionAutomation.quantumMaterialBuffer.${entityId}`, issues, seen);
  }
  for (const entry of Array.isArray(state?.constructionQueue) ? state.constructionQueue : []) {
    addCriticalStore(stock, entry?.reservedConstruction, `constructionQueue.${entry?.id ?? "?"}.reservedConstruction`, issues, seen);
    addCriticalStore(stock, entry?.reservedFleet, `constructionQueue.${entry?.id ?? "?"}.reservedFleet`, issues, seen);
  }
  addCriticalStore(stock, state?.portableFleet, "portableFleet", issues, seen);
  if (MATERIAL_IDS.includes(state?.cargo?.itemId)) {
    const amount = exactNonNegativeInteger(state.cargo.amount);
    if (amount === null) issues.push("cargo.amount");
    else addAmount(stock, state.cargo.itemId, amount);
  }
  addCriticalStore(stock, state?.quantumLogisticsNetwork?.inventory, "quantumLogisticsNetwork.inventory", issues, seen);
  for (const [systemId, station] of Object.entries(state?.systemSpaceStations ?? {})) {
    addCriticalStore(stock, station?.inventory, `systemSpaceStations.${systemId}.inventory`, issues, seen);
    addCriticalStore(stock, station?.constructionBuffer, `systemSpaceStations.${systemId}.constructionBuffer`, issues, seen);
  }
  for (const [batchId, batch] of Object.entries(state?.endgame?.constructionActivity?.pendingBatches ?? {})) {
    if (!MATERIAL_IDS.includes(batch?.itemId)) continue;
    const amount = exactNonNegativeInteger(batch.amount);
    if (amount === null) issues.push(`constructionActivity.pendingBatches.${batchId}.amount`);
    else addAmount(stock, batch.itemId, amount);
  }
  return stock;
}

function knownConsumptionSnapshot(state, issues) {
  const consumed = { [ROCKET]: 0n, [SAIL]: 0n };
  const orbitalConstructionStages = Array.isArray(state?.orbitalStation?.construction?.stageRequirements)
    ? state.orbitalStation.construction.stageRequirements
    : [];
  for (const [projectId, itemId] of Object.entries(EXPORT_PROJECT_ITEM)) {
    consumed[itemId] += criticalCounter(state?.endgame?.exportProjects?.[projectId]?.totalDelivered,
      `endgame.exportProjects.${projectId}.totalDelivered`, issues);
  }
  for (const itemId of MATERIAL_IDS) {
    consumed[itemId] += criticalCounter(state?.orbitalStation?.totals?.exportedByItem?.[itemId],
      `orbitalStation.totals.exportedByItem.${itemId}`, issues);
    for (const stage of orbitalConstructionStages) {
      consumed[itemId] += criticalCounter(stage?.delivered?.[itemId],
        `orbitalStation.construction.${stage?.stageId ?? "?"}.delivered.${itemId}`, issues);
    }
    consumed[itemId] += criticalCounter(state?.endgame?.constructionActivity?.personalDelivered?.[itemId],
      `endgame.constructionActivity.personalDelivered.${itemId}`, issues);
    consumed[itemId] += criticalCounter(state?.constructionAutomation?.destroyedByproducts?.[itemId],
      `constructionAutomation.destroyedByproducts.${itemId}`, issues);
  }
  for (const [systemId, station] of Object.entries(state?.systemSpaceStations ?? {})) {
    for (const itemId of MATERIAL_IDS) {
      consumed[itemId] += criticalCounter(station?.delivered?.[itemId], `systemSpaceStations.${systemId}.delivered.${itemId}`, issues);
    }
  }
  const blackHolePorts = [];
  for (const entity of Array.isArray(state?.entities) ? state.entities : []) {
    for (const port of Array.isArray(entity?.blackHolePorts) ? entity.blackHolePorts : []) {
      const total = exactNonNegativeInteger(port?.totalDestroyed);
      if (total === null) issues.push(`entities.${entity?.id ?? "?"}.blackHolePorts.${port?.index ?? "?"}.totalDestroyed`);
      blackHolePorts.push({
        key: `${entity?.id ?? "?"}:${port?.index ?? "?"}`,
        itemId: MATERIAL_IDS.includes(port?.currentItemId) ? port.currentItemId : null,
        total: (total ?? 0n).toString(),
      });
    }
  }
  return { consumed, blackHolePorts };
}

function dysonCounterSnapshot(state, issues) {
  const dyson = {
    rocketsLaunched: criticalCounter(state?.dysonSphere?.totalRocketsLaunched, "dysonSphere.totalRocketsLaunched", issues),
    structurePoints: criticalCounter(state?.dysonSphere?.structurePoints, "dysonSphere.structurePoints", issues),
    shellSails: criticalCounter(state?.dysonSphere?.shellSails, "dysonSphere.shellSails", issues),
    sailsAbsorbed: criticalCounter(state?.dysonSphere?.totalSailsAbsorbed, "dysonSphere.totalSailsAbsorbed", issues),
    sailsInOrbit: criticalCounter(state?.dysonSwarm?.sailsInOrbit, "dysonSwarm.sailsInOrbit", issues),
    sailsLaunched: criticalCounter(state?.dysonSwarm?.totalLaunched, "dysonSwarm.totalLaunched", issues),
    sailsExpired: criticalCounter(state?.dysonSwarm?.totalExpired, "dysonSwarm.totalExpired", issues),
    planStructurePoints: 0n,
    planShellSails: 0n,
    orbitSailsInOrbit: 0n,
    orbitSailsLaunched: 0n,
    orbitSailsExpired: 0n,
  };
  if (!state?.dysonPlans || typeof state.dysonPlans !== "object" || Array.isArray(state.dysonPlans)) issues.push("dysonPlans");
  for (const [systemId, plan] of Object.entries(state?.dysonPlans ?? {})) {
    dyson.planStructurePoints += criticalCounter(plan?.structurePoints, `dysonPlans.${systemId}.structurePoints`, issues);
    dyson.planShellSails += criticalCounter(plan?.shellSails, `dysonPlans.${systemId}.shellSails`, issues);
  }
  if (!state?.dysonEngineering?.orbitsBySystem || typeof state.dysonEngineering.orbitsBySystem !== "object" ||
    Array.isArray(state.dysonEngineering.orbitsBySystem)) issues.push("dysonEngineering.orbitsBySystem");
  for (const [systemId, orbits] of Object.entries(state?.dysonEngineering?.orbitsBySystem ?? {})) {
    if (!Array.isArray(orbits)) {
      issues.push(`dysonEngineering.orbitsBySystem.${systemId}`);
      continue;
    }
    for (const orbit of orbits) {
      dyson.orbitSailsInOrbit += criticalCounter(orbit?.sailsInOrbit, `orbits.${systemId}.sailsInOrbit`, issues);
      dyson.orbitSailsLaunched += criticalCounter(orbit?.totalLaunched, `orbits.${systemId}.totalLaunched`, issues);
      dyson.orbitSailsExpired += criticalCounter(orbit?.totalExpired, `orbits.${systemId}.totalExpired`, issues);
    }
  }
  return dyson;
}

/**
 * Produce the compact O(entities + routes + stores) ledger used by upload
 * inspection. It avoids retaining or cloning another tens-of-megabytes state.
 */
export function createLeaderboardMaterialSnapshot(state) {
  const issues = [];
  const stock = materialStockSnapshot(state, issues);
  const known = knownConsumptionSnapshot(state, issues);
  const dyson = dysonCounterSnapshot(state, issues);
  const produced = Object.fromEntries(MATERIAL_IDS.map((itemId) => [itemId,
    criticalCounter(state?.totalProduced?.[itemId], `totalProduced.${itemId}`, issues).toString(),
  ]));
  return {
    version: MATERIAL_SNAPSHOT_VERSION,
    complete: issues.length === 0,
    issues: [...new Set(issues)].slice(0, 32),
    stock: Object.fromEntries(MATERIAL_IDS.map((itemId) => [itemId, stock[itemId].toString()])),
    produced,
    knownConsumed: Object.fromEntries(MATERIAL_IDS.map((itemId) => [itemId, known.consumed[itemId].toString()])),
    blackHolePorts: known.blackHolePorts,
    dyson: Object.fromEntries(Object.entries(dyson).map(([key, value]) => [key, value.toString()])),
  };
}

function validatedSnapshot(state, trustEmbeddedSnapshot = false) {
  const snapshot = trustEmbeddedSnapshot && state?.leaderboardMaterialSnapshot?.version === MATERIAL_SNAPSHOT_VERSION
    ? state.leaderboardMaterialSnapshot
    : createLeaderboardMaterialSnapshot(state);
  if (!snapshot?.complete || snapshot.version !== MATERIAL_SNAPSHOT_VERSION) return null;
  const parsed = { stock: {}, produced: {}, knownConsumed: {}, dyson: {}, blackHolePorts: new Map() };
  for (const itemId of MATERIAL_IDS) {
    parsed.stock[itemId] = exactNonNegativeInteger(snapshot.stock?.[itemId]);
    parsed.produced[itemId] = exactNonNegativeInteger(snapshot.produced?.[itemId]);
    parsed.knownConsumed[itemId] = exactNonNegativeInteger(snapshot.knownConsumed?.[itemId]);
    if ([parsed.stock[itemId], parsed.produced[itemId], parsed.knownConsumed[itemId]].some((value) => value === null)) return null;
  }
  for (const key of ["rocketsLaunched", "structurePoints", "shellSails", "sailsAbsorbed", "sailsInOrbit", "sailsLaunched",
    "sailsExpired", "planStructurePoints", "planShellSails", "orbitSailsInOrbit", "orbitSailsLaunched", "orbitSailsExpired"]) {
    parsed.dyson[key] = exactNonNegativeInteger(snapshot.dyson?.[key]);
    if (parsed.dyson[key] === null) return null;
  }
  for (const port of Array.isArray(snapshot.blackHolePorts) ? snapshot.blackHolePorts : []) {
    const total = exactNonNegativeInteger(port?.total);
    if (typeof port?.key !== "string" || total === null) return null;
    parsed.blackHolePorts.set(port.key, { itemId: MATERIAL_IDS.includes(port.itemId) ? port.itemId : null, total });
  }
  return parsed;
}

function blackHoleConsumptionDelta(current, previous) {
  const deltas = { [ROCKET]: 0n, [SAIL]: 0n };
  for (const [key, after] of current.blackHolePorts) {
    const before = previous.blackHolePorts.get(key);
    if (!before) {
      if (after.total > 0n) return null;
      continue;
    }
    if (after.total < before.total) return null;
    const delta = after.total - before.total;
    if (delta > 0n && after.itemId) deltas[after.itemId] += delta;
  }
  for (const [key, before] of previous.blackHolePorts) {
    if (!current.blackHolePorts.has(key) && before.total > 0n) return null;
  }
  return deltas;
}

function finding(code, field, severity = "freeze") {
  return { code, ...(field ? { field } : {}), severity };
}

function evaluateMaterialDelta(currentState, previousState, { trustCurrentMaterialSnapshot = false } = {}) {
  // An embedded snapshot is trusted only when the caller proves it came from
  // leaderboardProjectionFromState(). Unknown save fields are player input
  // and must never be allowed to replace the server's own O(n) scan.
  const current = validatedSnapshot(currentState, trustCurrentMaterialSnapshot);
  const previous = validatedSnapshot(previousState, false);
  if (!current || !previous) {
    return { verified: false, findings: [finding("MATERIAL_LEDGER_UNAVAILABLE", null, "info")] };
  }
  const blackHoleDelta = blackHoleConsumptionDelta(current, previous);
  if (!blackHoleDelta) {
    return { verified: false, findings: [finding("MATERIAL_LEDGER_DISCONTINUITY", "blackHolePorts", "info")] };
  }
  const findings = [];
  const delta = (group, key) => current[group][key] - previous[group][key];
  const rocketLaunchDelta = delta("dyson", "rocketsLaunched");
  const structureDelta = delta("dyson", "structurePoints");
  const sailLaunchDelta = delta("dyson", "sailsLaunched");
  const sailExpiredDelta = delta("dyson", "sailsExpired");
  const sailAbsorbedDelta = delta("dyson", "sailsAbsorbed");
  const shellDelta = delta("dyson", "shellSails");
  const orbitStockDelta = delta("dyson", "sailsInOrbit");

  for (const [code, field, value] of [
    ["DYSON_ROCKET_COUNTER_ROLLBACK", "totalRocketsLaunched", rocketLaunchDelta],
    ["DYSON_STRUCTURE_COUNTER_ROLLBACK", "structurePoints", structureDelta],
    ["SOLAR_SAIL_LAUNCH_COUNTER_ROLLBACK", "totalLaunched", sailLaunchDelta],
    ["SOLAR_SAIL_EXPIRY_COUNTER_ROLLBACK", "totalExpired", sailExpiredDelta],
    ["SOLAR_SAIL_ABSORPTION_COUNTER_ROLLBACK", "totalSailsAbsorbed", sailAbsorbedDelta],
    ["DYSON_SHELL_COUNTER_ROLLBACK", "shellSails", shellDelta],
  ]) {
    if (value < 0n) findings.push(finding(code, field));
  }
  if (rocketLaunchDelta !== structureDelta) findings.push(finding("DYSON_STRUCTURE_ROCKET_MISMATCH", "structurePoints"));
  if (sailAbsorbedDelta !== shellDelta) findings.push(finding("DYSON_SHELL_ABSORPTION_MISMATCH", "shellSails"));
  if (sailLaunchDelta !== orbitStockDelta + sailExpiredDelta + sailAbsorbedDelta) {
    findings.push(finding("SOLAR_SAIL_FLOW_MISMATCH", "dysonSwarm"));
  }
  if (delta("dyson", "planStructurePoints") !== structureDelta) findings.push(finding("DYSON_PLAN_STRUCTURE_MISMATCH", "dysonPlans"));
  if (delta("dyson", "planShellSails") !== shellDelta) findings.push(finding("DYSON_PLAN_SHELL_MISMATCH", "dysonPlans"));
  if (delta("dyson", "orbitSailsInOrbit") !== orbitStockDelta ||
    delta("dyson", "orbitSailsLaunched") !== sailLaunchDelta ||
    delta("dyson", "orbitSailsExpired") !== sailExpiredDelta) {
    findings.push(finding("DYSON_ORBIT_AGGREGATE_MISMATCH", "orbitsBySystem"));
  }

  for (const itemId of MATERIAL_IDS) {
    const producedDelta = current.produced[itemId] - previous.produced[itemId];
    const knownDelta = current.knownConsumed[itemId] - previous.knownConsumed[itemId] + blackHoleDelta[itemId];
    if (producedDelta < 0n || knownDelta < 0n) {
      findings.push(finding("MATERIAL_LEDGER_COUNTER_ROLLBACK", itemId));
      continue;
    }
    const available = producedDelta + previous.stock[itemId] - current.stock[itemId];
    const terminalUse = (itemId === ROCKET ? rocketLaunchDelta : sailLaunchDelta) + knownDelta;
    if (terminalUse > available) {
      findings.push(finding(itemId === ROCKET ? "ROCKET_MATERIAL_SOURCE_EXCEEDED" : "SOLAR_SAIL_MATERIAL_SOURCE_EXCEEDED", itemId));
    }
  }
  return { verified: true, findings };
}

export function evaluateLeaderboardIntegrity(currentState, previousState = null, options = {}) {
  const findings = [];
  const currentProduced = productionRecord(currentState);
  for (const [itemId, amount] of Object.entries(currentProduced)) {
    if (!finiteNonNegativeNumber(amount)) findings.push(finding("CUMULATIVE_VALUE_INVALID", itemId));
  }

  const currentCompatible = COMPATIBLE_GAME_STATE_VERSIONS.has(currentState?.version);
  const previousCompatible = COMPATIBLE_GAME_STATE_VERSIONS.has(previousState?.version);
  let verification = "unverifiable";
  if (!currentCompatible) {
    findings.push(finding("STATE_VERSION_UNSUPPORTED", String(currentState?.version ?? "missing"), "info"));
  } else if (!previousState) {
    findings.push(finding("ADJACENT_REVISION_UNAVAILABLE", null, "info"));
  } else if (!previousCompatible) {
    findings.push(finding("ADJACENT_REVISION_VERSION_UNSUPPORTED", String(previousState?.version ?? "missing"), "info"));
  } else {
    verification = "verified";
    if (elapsed(currentState) + 0.000001 < elapsed(previousState)) findings.push(finding("SIMULATION_TIME_ROLLBACK"));
    const previousProduced = productionRecord(previousState);
    for (const [itemId, before] of Object.entries(previousProduced)) {
      const after = currentProduced[itemId];
      if (finiteNonNegativeNumber(before) && finiteNonNegativeNumber(after) && after + 0.000001 < before) {
        findings.push(finding("CUMULATIVE_PRODUCTION_ROLLBACK", itemId));
      }
    }
    const material = evaluateMaterialDelta(currentState, previousState, options);
    findings.push(...material.findings);
    if (!material.verified) verification = "unverifiable";
  }

  if (currentCompatible && Array.isArray(currentState.entities) && currentState.entities.length === 0) {
    const cumulative = Object.values(currentProduced).reduce((sum, amount) => finiteNonNegativeNumber(amount) ? Math.min(Number.MAX_VALUE, sum + amount) : sum, 0);
    if (cumulative >= 1_000_000_000_000) findings.push(finding("EXTREME_PRODUCTION_WITHOUT_ENTITIES"));
  }
  const unique = [...new Map(findings.map((entry) => [`${entry.code}:${entry.field ?? ""}`, entry])).values()];
  return {
    version: LEADERBOARD_INTEGRITY_VERSION,
    verification,
    freeze: unique.some((entry) => entry.severity === "freeze"),
    findings: unique,
  };
}
