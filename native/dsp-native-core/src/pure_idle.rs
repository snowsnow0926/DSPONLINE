use anyhow::{anyhow, bail};
use serde_json::{Number, Value};

use crate::simulation::{CoreAdvanceMode, CoreAdvanceRequest, CoreAdvanceResult};
use crate::state::{CoreState, PURE_IDLE_SESSION_EXACT_CREDIT_SECONDS};

const ALGORITHM_VERSION: &str = "native-pure-idle-conservative-v4-session-bounded-30s";
const MAX_ADVANCE_SECONDS: f64 = 30.0 * 24.0 * 60.0 * 60.0;
const EPSILON: f64 = 0.000_001;

fn number_at(value: Option<&Value>, path: &[&str]) -> f64 {
    let mut current = value;
    for key in path {
        current = current
            .and_then(Value::as_object)
            .and_then(|object| object.get(*key));
    }
    current.and_then(Value::as_f64).unwrap_or(0.0)
}

fn finite_number_at(value: Option<&Value>, path: &[&str]) -> Option<f64> {
    let mut current = value;
    for key in path {
        current = current
            .and_then(Value::as_object)
            .and_then(|object| object.get(*key));
    }
    current
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
}

fn admission_reason(state: &CoreState, _request: &CoreAdvanceRequest) -> Option<&'static str> {
    let base = state.base_value();
    if base.get("mode").and_then(Value::as_str) != Some("normal") {
        return Some("pure-idle-speedrun-unsupported");
    }
    if base.get("paused").and_then(Value::as_bool).unwrap_or(false) {
        return Some("pure-idle-state-paused");
    }
    if !base
        .get("timeWarp")
        .and_then(Value::as_object)
        .and_then(|time_warp| time_warp.get("enabled"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return Some("pure-idle-time-warp-disabled");
    }
    if number_at(base.get("timeWarp"), &["pendingSimulationSeconds"]).abs() > EPSILON
        || number_at(base.get("timeWarp"), &["pendingWallSeconds"]).abs() > EPSILON
    {
        return Some("pure-idle-pending-budget-not-empty");
    }
    None
}

/// Attests that a positive pure-idle slice came from the powered time-warp
/// snapshot represented by the checkpoint. This must run before cloning or
/// debiting the session's exact credit: an exact-prefix-only request is still
/// a time-warp request and must not bypass its wall-time and power contract.
fn budget_attestation_reason(
    state: &CoreState,
    request: &CoreAdvanceRequest,
) -> Option<&'static str> {
    let has_positive_budget = request.simulation_seconds > 0.0 || request.wall_seconds > 0.0;
    if !has_positive_budget {
        return None;
    }
    if request.simulation_seconds <= 0.0 {
        return Some("pure-idle-simulation-budget-empty");
    }
    if request.wall_seconds <= 0.0 {
        return Some("pure-idle-wall-budget-empty");
    }

    let base = state.base_value();
    let time_warp = base.get("timeWarp");
    let Some(effective_multiplier) =
        finite_number_at(time_warp, &["effectiveMultiplier"]).filter(|value| *value > 0.0)
    else {
        return Some("pure-idle-power-multiplier-invalid");
    };
    let base_multiplier = finite_number_at(base.get("settings"), &["simulationSpeed"])
        .filter(|value| *value > 0.0)
        .unwrap_or(1.0);
    let Some(required_power_kw) =
        finite_number_at(time_warp, &["requiredPowerKw"]).filter(|value| *value > 0.0)
    else {
        return Some("pure-idle-power-snapshot-invalid");
    };
    let Some(allocated_power_kw) =
        finite_number_at(time_warp, &["allocatedPowerKw"]).filter(|value| *value > 0.0)
    else {
        return Some("pure-idle-power-snapshot-invalid");
    };
    let power_tolerance = EPSILON * required_power_kw.max(allocated_power_kw).max(1.0);
    if effective_multiplier <= base_multiplier + EPSILON
        || allocated_power_kw + power_tolerance < required_power_kw
    {
        return Some("pure-idle-time-warp-not-powered");
    }

    let requested_multiplier = request.simulation_seconds / request.wall_seconds;
    let multiplier_tolerance = EPSILON
        * effective_multiplier
            .max(requested_multiplier.abs())
            .max(1.0);
    if !requested_multiplier.is_finite()
        || requested_multiplier <= 0.0
        || (effective_multiplier - requested_multiplier).abs() > multiplier_tolerance
    {
        return Some("pure-idle-power-multiplier-changed");
    }
    None
}

fn unsupported(
    state: &CoreState,
    request: &CoreAdvanceRequest,
    reason: impl Into<String>,
) -> anyhow::Result<CoreAdvanceResult> {
    Ok(CoreAdvanceResult {
        supported: false,
        exact_scope: "unsupported-domain",
        changed: false,
        previous_revision: state.revision,
        revision: state.revision,
        reason: Some(reason.into()),
        algorithm_version: Some(ALGORITHM_VERSION),
        exact_calibration_seconds: Some(0.0),
        approximated_seconds: Some(0.0),
        belt_scheduler: None,
        summary: request
            .include_diagnostics
            .then(|| state.summary())
            .transpose()?,
    })
}

fn exact_request(
    base_revision: u64,
    simulation_seconds: f64,
    wall_seconds: f64,
) -> CoreAdvanceRequest {
    CoreAdvanceRequest {
        base_revision,
        simulation_seconds,
        wall_seconds,
        advance_mode: CoreAdvanceMode::Exact,
        include_diagnostics: false,
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct PrefixBudget {
    exact_simulation_seconds: f64,
    exact_wall_seconds: f64,
    frozen_tail_seconds: f64,
}

fn prefix_budget(
    simulation_seconds: f64,
    wall_seconds: f64,
    exact_seconds_remaining: f64,
) -> PrefixBudget {
    let exact_simulation_seconds = simulation_seconds.min(exact_seconds_remaining.max(0.0));
    let exact_wall_seconds = if simulation_seconds <= EPSILON {
        wall_seconds.min(exact_seconds_remaining.max(0.0))
    } else {
        wall_seconds * exact_simulation_seconds / simulation_seconds
    };
    PrefixBudget {
        exact_simulation_seconds,
        exact_wall_seconds,
        frozen_tail_seconds: (simulation_seconds - exact_simulation_seconds).max(0.0),
    }
}

fn checked_elapsed_after_prefix(current: f64, tail_seconds: f64) -> anyhow::Result<f64> {
    let projected = current + tail_seconds;
    if !current.is_finite()
        || !tail_seconds.is_finite()
        || tail_seconds < 0.0
        || !projected.is_finite()
    {
        bail!("native pure-idle elapsed time overflow");
    }
    Ok(projected)
}

/// Conservative native pure-idle settlement.
///
/// Only the bounded prefix is simulated. The unproven tail advances the
/// authoritative clock and deliberately freezes every factory, inventory,
/// research, export, contract and Dyson counter. This is intentionally an
/// under-production policy: without a closed material ledger, extrapolating a
/// terminal result could duplicate prefilled rockets or sails.
///
/// A productive tail cannot be proven inside this module alone:
///
/// - `totalProduced` has no matching authoritative per-item consumption
///   counter;
/// - ownership is split between entity inputs/outputs, the active tray and its
///   serialized planet duplicate, station slots and route cargo, construction
///   reservations, belts and the quantum inventory;
/// - an observed entity-store delta can be production, consumption or merely
///   logistics movement; and
/// - research and finite-resource boundaries require remainders that survive
///   segmented calls.
///
/// Copying only the visible production counters or entity stores would
/// therefore reopen the exact conservation bug this mode exists to prevent.
/// Until the native resident state exposes one complete item-flow ledger, the
/// larger exact prefix is the only non-zero settlement committed here.
pub(crate) fn advance(
    state: &mut CoreState,
    request: &CoreAdvanceRequest,
) -> anyhow::Result<CoreAdvanceResult> {
    if request.base_revision != state.revision {
        bail!("native pure-idle advance base revision is not current");
    }
    if !request.simulation_seconds.is_finite()
        || !request.wall_seconds.is_finite()
        || request.simulation_seconds < 0.0
        || request.wall_seconds < 0.0
        || request.simulation_seconds > MAX_ADVANCE_SECONDS
        || request.wall_seconds > MAX_ADVANCE_SECONDS
    {
        bail!("native pure-idle advance budget is invalid");
    }
    if let Some(reason) = admission_reason(state, request) {
        return unsupported(state, request, reason);
    }
    if let Some(reason) = budget_attestation_reason(state, request) {
        return unsupported(state, request, reason);
    }

    let exact_seconds_used_before = state.pure_idle_exact_seconds_used();
    let exact_seconds_remaining =
        (PURE_IDLE_SESSION_EXACT_CREDIT_SECONDS - exact_seconds_used_before).max(0.0);
    let budget = prefix_budget(
        request.simulation_seconds,
        request.wall_seconds,
        exact_seconds_remaining,
    );
    let exact_seconds = budget.exact_simulation_seconds;
    let exact_wall_seconds = budget.exact_wall_seconds;
    let mut candidate = state.clone();
    let mut exact_changed = false;
    let mut belt_scheduler = None;
    if exact_seconds > 0.0 || exact_wall_seconds > EPSILON {
        let mut exact = candidate.advance_exact(&exact_request(
            candidate.revision,
            exact_seconds,
            exact_wall_seconds,
        ))?;
        if !exact.supported {
            return unsupported(
                state,
                request,
                exact
                    .reason
                    .take()
                    .unwrap_or_else(|| "pure-idle-exact-prefix-unsupported".to_owned()),
            );
        }
        exact_changed = exact.changed;
        belt_scheduler = exact.belt_scheduler.take();
    }
    if let Some(reason) = budget_attestation_reason(&candidate, request) {
        // Exact settlement may have exhausted fuel or otherwise changed the
        // controller's powered multiplier. The disposable prefix and its
        // session-credit debit must not commit under the stale admission
        // snapshot, even when this request has no frozen tail.
        return unsupported(state, request, reason);
    }

    let tail_seconds = budget.frozen_tail_seconds;
    if tail_seconds > EPSILON {
        let current_elapsed = candidate
            .base_value()
            .get("elapsedSeconds")
            .and_then(Value::as_f64)
            .unwrap_or(0.0);
        let elapsed = checked_elapsed_after_prefix(current_elapsed, tail_seconds)?;
        candidate.base_value_mut().insert(
            "elapsedSeconds".to_owned(),
            Value::Number(
                Number::from_f64(elapsed)
                    .ok_or_else(|| anyhow!("native pure-idle elapsed time encode failed"))?,
            ),
        );
    }

    let changed = exact_changed || tail_seconds > EPSILON;
    if tail_seconds > EPSILON && candidate.revision == state.revision {
        candidate.revision = candidate
            .revision
            .checked_add(1)
            .ok_or_else(|| anyhow!("native core revision exhausted"))?;
    }
    if changed {
        // The exact debit and its new revision live only on this disposable
        // candidate. Every possible failure below leaves the source session
        // and its full/remaining credit untouched.
        candidate.install_pure_idle_session_progress(
            (exact_seconds_used_before + exact_seconds).min(PURE_IDLE_SESSION_EXACT_CREDIT_SECONDS),
        )?;
    }

    let previous_revision = state.revision;
    let revision = candidate.revision;
    let summary = request
        .include_diagnostics
        .then(|| candidate.summary())
        .transpose()?;
    *state = candidate;
    Ok(CoreAdvanceResult {
        supported: true,
        exact_scope: if tail_seconds > EPSILON {
            // Wire-compatible scope; `algorithm_version` distinguishes the
            // new 30-second bounded implementation without widening the
            // desktop protocol in this single-file change.
            "pure-idle-conservative-v2"
        } else {
            "pure-idle-bounded-exact"
        },
        changed,
        previous_revision,
        revision,
        reason: (tail_seconds > EPSILON).then(|| {
            "unproven pure-idle tail froze material-bearing systems after the session's bounded 30-second exact credit".to_owned()
        }),
        algorithm_version: Some(ALGORITHM_VERSION),
        exact_calibration_seconds: Some(exact_seconds),
        approximated_seconds: Some(tail_seconds),
        belt_scheduler,
        summary,
    })
}

#[cfg(test)]
mod tests {
    use std::collections::{BTreeMap, HashMap};

    use serde_json::{Map, json};

    use super::*;
    use crate::canonical::fnv1a_utf8;
    use crate::catalog::{
        BeltDefinition, BuildingDefinition, CatalogSnapshot, ItemDefinition, PlanetDefinition,
        RuntimeCatalog,
    };
    use crate::state::CoreCheckpointIdentity;

    fn fixture_catalog() -> RuntimeCatalog {
        RuntimeCatalog::validate(
            CatalogSnapshot {
                protocol_version: 1,
                registry_fingerprint: "pure-idle-test".into(),
                planets: vec![PlanetDefinition {
                    id: "home".into(),
                    name: "home".into(),
                    system_id: "helios".into(),
                    kind: "terrestrial".into(),
                    orbit_index: 1,
                    simulation_order: 0,
                    orbital_yields: HashMap::new(),
                }],
                items: vec![ItemDefinition {
                    id: "iron_ore".into(),
                    name: "iron_ore".into(),
                    kind: "solid".into(),
                    fuel_energy_mj: 0.0,
                }],
                buildings: vec![
                    BuildingDefinition {
                        id: "mining_machine".into(),
                        kind: "miner".into(),
                        speed: 1.0,
                        input_capacity: 0.0,
                        output_capacity: 1_000_000.0,
                        power_demand_kw: 1.0,
                        power_generation_kw: 0.0,
                        power_charge_kw: 0.0,
                        energy_capacity_mj: 0.0,
                        fuel_item_ids: Vec::new(),
                        fuel_efficiency: 1.0,
                        family: None,
                        accepts: None,
                    },
                    BuildingDefinition {
                        id: "wind_turbine".into(),
                        kind: "power".into(),
                        speed: 1.0,
                        input_capacity: 0.0,
                        output_capacity: 0.0,
                        power_demand_kw: 0.0,
                        power_generation_kw: 1.0e18,
                        power_charge_kw: 0.0,
                        energy_capacity_mj: 0.0,
                        fuel_item_ids: Vec::new(),
                        fuel_efficiency: 1.0,
                        family: None,
                        accepts: None,
                    },
                    BuildingDefinition {
                        id: "time_warp_device".into(),
                        kind: "machine".into(),
                        speed: 1.0,
                        input_capacity: 0.0,
                        output_capacity: 0.0,
                        power_demand_kw: 0.0,
                        power_generation_kw: 0.0,
                        power_charge_kw: 0.0,
                        energy_capacity_mj: 0.0,
                        fuel_item_ids: Vec::new(),
                        fuel_efficiency: 1.0,
                        family: None,
                        accepts: None,
                    },
                ],
                recipes: Vec::new(),
                constructions: Vec::new(),
                belts: vec![BeltDefinition {
                    tier: 1,
                    speed: 6.0,
                }],
                proliferators: Vec::new(),
                technologies: Vec::new(),
            },
            "pure-idle-test",
        )
        .unwrap()
    }

    fn powered_fixture_base(multiplier: f64, resource_mode: &str) -> Value {
        const SYSTEMS: [&str; 8] = [
            "helios",
            "borealis",
            "aurora",
            "ember",
            "sirius",
            "white_dwarf",
            "neutron",
            "blue_giant",
        ];
        let mut plans = Map::new();
        let mut active_orbits = Map::new();
        let mut orbits = Map::new();
        let mut absorption = Map::new();
        let mut system_profiles = Map::new();
        for system in SYSTEMS {
            let orbit_id = format!("test-orbit-{system}");
            plans.insert(
                system.to_owned(),
                json!({
                    "systemId": system,
                    "activeLayerId": null,
                    "structurePoints": 0,
                    "shellSails": 0,
                    "layers": []
                }),
            );
            active_orbits.insert(system.to_owned(), Value::from(orbit_id.clone()));
            orbits.insert(
                system.to_owned(),
                json!([{
                    "id": orbit_id,
                    "name": "test",
                    "radius": 12000,
                    "inclination": 0,
                    "longitude": 0,
                    "sailsInOrbit": 0,
                    "totalLaunched": 0,
                    "totalExpired": 0,
                    "decayProgress": 0,
                    "generationKw": 0
                }]),
            );
            absorption.insert(system.to_owned(), Value::from(0));
            system_profiles.insert(system.to_owned(), json!({ "luminosity": 1 }));
        }
        let power_kw = 10_f64.powf(multiplier + 1.0);
        let mut base = Map::new();
        for (key, value) in [
            ("version", json!(47)),
            ("mode", json!("normal")),
            ("activePlanetId", json!("home")),
            ("elapsedSeconds", json!(0)),
            ("historyRecordedAt", json!(0)),
            ("productionHistory", json!([])),
            ("paused", json!(false)),
            ("tray", json!({})),
            ("planetTrays", json!({ "home": {} })),
            ("planetTrayItemLimits", json!({ "home": 1000000 })),
            (
                "portableFleet",
                json!({ "logistics_drone": 0, "logistics_vessel": 0 }),
            ),
            ("manualMined", json!(0)),
            ("totalProduced", json!({})),
            ("blueprints", json!([])),
            ("handcraftQueue", json!([])),
            ("constructionQueue", json!([])),
            ("planetMetrics", json!({ "home": {} })),
            ("powerGridMetrics", json!({ "home": {} })),
            ("systemSpaceStations", json!({})),
        ] {
            base.insert(key.to_owned(), value);
        }
        base.insert(
            "settings".to_owned(),
            json!({
                "simulationSpeed": 1,
                "resourceMode": resource_mode,
                "difficulty": "standard",
                "productionBufferLimit": 1000000,
                "logisticsBufferLimit": 1000000,
                "beltBufferLimit": 100000000,
                "proliferatorBufferLimit": 600
            }),
        );
        base.insert(
            "research".to_owned(),
            json!({
                "selectedTechId": null,
                "pausedTechId": null,
                "queuedTechIds": [],
                "progressByTech": {},
                "completedTechIds": []
            }),
        );
        base.insert(
            "campaign".to_owned(),
            json!({
                "completedTaskIds": [],
                "rewardedTaskIds": [],
                "activeTaskId": "mine_first_ore",
                "activeChapterId": "foundation"
            }),
        );
        base.insert(
            "constructionAutomation".to_owned(),
            json!({
                "enabled": false,
                "targetStock": {},
                "cursor": 0,
                "totalCrafted": 0,
                "lastCraftedId": null,
                "destroyedByproducts": {},
                "jobs": {}
            }),
        );
        base.insert(
            "exploration".to_owned(),
            json!({
                "missions": [],
                "unlockedSystemIds": ["helios"],
                "colonizedPlanetIds": ["home"],
                "surveyProgressBySystem": { "helios": 1 }
            }),
        );
        base.insert(
            "galaxy".to_owned(),
            json!({
                "profiles": {
                    "home": {
                        "windMultiplier": 1,
                        "solarMultiplier": 1,
                        "geothermalMultiplier": 1,
                        "miningMultiplier": 1,
                        "productionSpeedMultiplier": 1,
                        "specialization": "balanced",
                        "oceanType": "none"
                    }
                },
                "systemProfiles": Value::Object(system_profiles)
            }),
        );
        base.insert(
            "timeWarp".to_owned(),
            json!({
                "controllerEntityId": "controller",
                "enabled": true,
                "requestedMultiplier": multiplier,
                "effectiveMultiplier": multiplier,
                "pendingSimulationSeconds": 0,
                "pendingWallSeconds": 0,
                "requiredPowerKw": power_kw,
                "allocatedPowerKw": power_kw
            }),
        );
        base.insert(
            "dysonSwarm".to_owned(),
            json!({
                "sailsInOrbit": 0,
                "totalLaunched": 0,
                "totalExpired": 0,
                "decayProgress": 0,
                "generationKw": 0,
                "receiverLoadKw": 0
            }),
        );
        base.insert(
            "dysonSphere".to_owned(),
            json!({
                "structurePoints": 0,
                "totalRocketsLaunched": 0,
                "shellSails": 0,
                "totalSailsAbsorbed": 0,
                "absorptionProgress": 0,
                "generationKw": 0
            }),
        );
        base.insert(
            "dysonEngineering".to_owned(),
            json!({
                "launchMode": "balanced",
                "launchThrottle": 1,
                "launchEnabled": true,
                "activeOrbitBySystem": Value::Object(active_orbits),
                "orbitsBySystem": Value::Object(orbits),
                "absorptionProgressBySystem": Value::Object(absorption),
                "launchEnergySpentMj": 0
            }),
        );
        base.insert("dysonPlans".to_owned(), Value::Object(plans));
        base.insert(
            "galacticHubNetwork".to_owned(),
            json!({
                "fleetInstalled": 0,
                "fleetBusy": 0,
                "fleetReturns": [],
                "warpers": "0",
                "warperTarget": "0",
                "routingCursors": {}
            }),
        );
        base.insert(
            "quantumLogisticsNetwork".to_owned(),
            json!({
                "enabled": false,
                "inventory": {},
                "itemCapacities": {},
                "routingCursors": {},
                "uploadRoutingCursors": {}
            }),
        );
        base.insert(
            "endgame".to_owned(),
            json!({
                "activeInfiniteResearchId": null,
                "autoResearch": false,
                "autoDispatch": false,
                "dispatchThrottle": 1,
                "exportInputMode": "building",
                "exportProjects": {
                    "universe_archive": { "enabled": false, "priority": 1, "level": 0, "delivered": 0, "totalDelivered": 0, "dispatchProgress": 0 },
                    "solar_sail_array": { "enabled": false, "priority": 1, "level": 0, "delivered": 0, "totalDelivered": 0, "dispatchProgress": 0 },
                    "carrier_rocket_fleet": { "enabled": false, "priority": 1, "level": 0, "delivered": 0, "totalDelivered": 0, "dispatchProgress": 0 },
                    "antimatter_exchange": { "enabled": false, "priority": 1, "level": 0, "delivered": 0, "totalDelivered": 0, "dispatchProgress": 0 }
                },
                "galacticCredits": 0,
                "galacticScore": 0,
                "totalExported": 0,
                "exportedLastMinute": 0,
                "exportWindowAmount": 0,
                "exportWindowStartedAt": 0,
                "infiniteResearch": {
                    "matrix_compression": { "level": 0, "progress": "0" },
                    "vein_utilization": { "level": 0, "progress": "0" },
                    "galactic_logistics": { "level": 0, "progress": "0" },
                    "stellar_harnessing": { "level": 0, "progress": "0" },
                    "continuum_simulation": { "level": 0, "progress": "0" }
                },
                "constructionActivity": { "activityId": null, "activityClockMs": 0 }
            }),
        );
        Value::Object(base)
    }

    fn fixture_state_from_parts(base: Value, entities: Vec<Value>) -> CoreState {
        let base = serde_json::to_vec(&base).unwrap();
        let entity_count = entities.len();
        let entities = serde_json::to_vec(&entities).unwrap();
        let belts = serde_json::to_vec(&Vec::<Value>::new()).unwrap();
        let chunks = [
            ("base", "base", &base, 0, 1),
            ("entities:00000000", "entities", &entities, 0, entity_count),
            ("belts:00000000", "belts", &belts, 0, 0),
        ]
        .into_iter()
        .map(|(id, kind, bytes, offset, count)| {
            json!({
                "id": id,
                "kind": kind,
                "offset": offset,
                "count": count,
                "checksum": fnv1a_utf8(bytes),
                "bytes": bytes.len()
            })
        })
        .collect::<Vec<_>>();
        let manifest = serde_json::to_vec(&json!({
            "formatVersion": 1,
            "envelopeFormatVersion": 2,
            "mode": "normal",
            "slot": "main",
            "stateVersion": 47,
            "savedAt": 1,
            "basePrimaryChecksum": "12345678",
            "chunkRootChecksum": "12345678",
            "totalBytes": base.len() + entities.len() + belts.len(),
            "entityCount": entity_count,
            "beltCount": 0,
            "chunks": chunks
        }))
        .unwrap();
        let records = BTreeMap::from([
            (
                "dsp-idle-network.internal.v1.chunked.v1.normal.manifest".into(),
                manifest,
            ),
            (
                "dsp-idle-network.internal.v1.chunked.v1.normal.chunk.base".into(),
                base,
            ),
            (
                "dsp-idle-network.internal.v1.chunked.v1.normal.chunk.entities%3A00000000".into(),
                entities,
            ),
            (
                "dsp-idle-network.internal.v1.chunked.v1.normal.chunk.belts%3A00000000".into(),
                belts,
            ),
        ]);
        CoreState::from_internal_records(
            CoreCheckpointIdentity {
                slot: "normal-main".into(),
                generation: 1,
                root_hash: "a".repeat(64),
                revision: 7,
                state_version: 47,
                mode: "normal".into(),
                registry_fingerprint: "pure-idle-test".into(),
                base_primary_checksum: "12345678".into(),
            },
            &records,
            fixture_catalog(),
        )
        .unwrap()
    }

    fn productive_powered_fixture(multiplier: f64, resource_mode: &str) -> CoreState {
        fixture_state_from_parts(
            powered_fixture_base(multiplier, resource_mode),
            vec![
                json!({
                    "id": "wind",
                    "kind": "power",
                    "planetId": "home",
                    "powerGridId": "grid-a",
                    "buildingId": "wind_turbine",
                    "machineCount": 1,
                    "minerCount": 0,
                    "inputs": {},
                    "outputs": {},
                    "progress": 0,
                    "routingCursor": 0,
                    "utilization": 0,
                    "productionRate": 0
                }),
                json!({
                    "id": "controller",
                    "kind": "machine",
                    "planetId": "home",
                    "powerGridId": "grid-a",
                    "buildingId": "time_warp_device",
                    "machineCount": 1,
                    "minerCount": 0,
                    "inputs": {},
                    "outputs": {},
                    "progress": 0,
                    "routingCursor": 0,
                    "utilization": 1,
                    "productionRate": 0
                }),
                json!({
                    "id": "vein",
                    "kind": "vein",
                    "planetId": "home",
                    "powerGridId": "grid-a",
                    "resourceId": "iron_ore",
                    "extractorBuildingId": "mining_machine",
                    "minerCount": 2,
                    "inputs": {},
                    "outputs": { "iron_ore": 0 },
                    "resourceCapacity": 1000000,
                    "resourceRemaining": 1000000,
                    "resourceDepletionRemainder": 0,
                    "progress": 0,
                    "routingCursor": 0,
                    "utilization": 0,
                    "productionRate": 0
                }),
            ],
        )
    }

    fn pure_idle_request(
        revision: u64,
        simulation_seconds: f64,
        wall_seconds: f64,
    ) -> CoreAdvanceRequest {
        CoreAdvanceRequest {
            base_revision: revision,
            simulation_seconds,
            wall_seconds,
            advance_mode: CoreAdvanceMode::PureIdleConservativeV2,
            include_diagnostics: false,
        }
    }

    fn assert_rejected_atomically(
        state: &mut CoreState,
        request: CoreAdvanceRequest,
        reason: &str,
    ) {
        let before_revision = state.revision;
        let before_credit = state.pure_idle_exact_seconds_used();
        let before = state.materialize().unwrap();
        let before_hash = state.summary().unwrap().canonical_sha256;
        let result = advance(state, &request).unwrap();
        assert!(!result.supported);
        assert_eq!(result.reason.as_deref(), Some(reason));
        assert_eq!(state.revision, before_revision);
        assert_eq!(state.pure_idle_exact_seconds_used(), before_credit);
        assert_eq!(state.materialize().unwrap(), before);
        assert_eq!(state.summary().unwrap().canonical_sha256, before_hash);
    }

    #[test]
    fn productive_powered_prefix_matches_exact_for_modes_and_multiplier_matrix() {
        for resource_mode in ["finite", "infinite"] {
            for multiplier in [8.0, 12.0, 15.0, 16.0] {
                let initial = productive_powered_fixture(multiplier, resource_mode);
                let mut exact = initial.clone();
                let mut pure_idle = initial;
                let simulation_seconds = 24.0;
                let wall_seconds = simulation_seconds / multiplier;
                let exact_revision = exact.revision;
                let exact_result = exact
                    .advance(&exact_request(
                        exact_revision,
                        simulation_seconds,
                        wall_seconds,
                    ))
                    .unwrap();
                assert!(
                    exact_result.supported,
                    "mode={resource_mode} multiplier={multiplier} reason={:?}",
                    exact_result.reason
                );
                let pure_revision = pure_idle.revision;
                let pure_result = advance(
                    &mut pure_idle,
                    &pure_idle_request(pure_revision, simulation_seconds, wall_seconds),
                )
                .unwrap();
                assert!(
                    pure_result.supported,
                    "mode={resource_mode} multiplier={multiplier} reason={:?}",
                    pure_result.reason
                );
                assert_eq!(pure_result.exact_calibration_seconds, Some(24.0));
                assert_eq!(pure_result.approximated_seconds, Some(0.0));
                assert_eq!(
                    pure_idle.materialize().unwrap(),
                    exact.materialize().unwrap()
                );
                assert!(
                    number_at(
                        pure_idle.materialize().unwrap().get("totalProduced"),
                        &["iron_ore"]
                    ) > 0.0
                );
            }
        }
    }

    #[test]
    fn positive_budget_attestation_failures_are_atomic_before_and_after_prefix() {
        let mut zero_wall = productive_powered_fixture(15.0, "infinite");
        zero_wall.install_pure_idle_session_progress(7.0).unwrap();
        let revision = zero_wall.revision;
        assert_rejected_atomically(
            &mut zero_wall,
            pure_idle_request(revision, 15.0, 0.0),
            "pure-idle-wall-budget-empty",
        );

        let mut wrong_ratio = productive_powered_fixture(15.0, "infinite");
        wrong_ratio.install_pure_idle_session_progress(7.0).unwrap();
        let revision = wrong_ratio.revision;
        assert_rejected_atomically(
            &mut wrong_ratio,
            pure_idle_request(revision, 12.0, 1.0),
            "pure-idle-power-multiplier-changed",
        );

        let mut disabled = productive_powered_fixture(15.0, "infinite");
        disabled.base_value_mut()["timeWarp"]["enabled"] = json!(false);
        disabled.install_pure_idle_session_progress(7.0).unwrap();
        let revision = disabled.revision;
        assert_rejected_atomically(
            &mut disabled,
            pure_idle_request(revision, 15.0, 1.0),
            "pure-idle-time-warp-disabled",
        );

        let mut loses_power = productive_powered_fixture(15.0, "infinite");
        let mut wind = loses_power.parse_entity(0).unwrap();
        wind["machineCount"] = json!(0);
        loses_power.replace_entity_raw(0, serde_json::to_string(&wind).unwrap().into());
        loses_power.rebuild_indexes().unwrap();
        loses_power.install_pure_idle_session_progress(7.0).unwrap();
        let revision = loses_power.revision;
        assert_rejected_atomically(
            &mut loses_power,
            pure_idle_request(revision, 15.0, 1.0),
            "pure-idle-power-snapshot-invalid",
        );
    }

    #[test]
    fn productive_prefix_is_segment_invariant_and_frozen_tail_preserves_domains() {
        for resource_mode in ["finite", "infinite"] {
            let initial = productive_powered_fixture(15.0, resource_mode);
            let mut prefix_only = initial.clone();
            let prefix_revision = prefix_only.revision;
            advance(
                &mut prefix_only,
                &pure_idle_request(prefix_revision, 30.0, 2.0),
            )
            .unwrap();

            let mut one_shot = initial.clone();
            let one_revision = one_shot.revision;
            let one_result =
                advance(&mut one_shot, &pure_idle_request(one_revision, 60.0, 4.0)).unwrap();
            assert!(one_result.supported);
            assert_eq!(one_result.exact_calibration_seconds, Some(30.0));
            assert_eq!(one_result.approximated_seconds, Some(30.0));

            let mut segmented = initial;
            for simulation_seconds in [10.0, 20.0, 30.0] {
                let revision = segmented.revision;
                let result = advance(
                    &mut segmented,
                    &pure_idle_request(revision, simulation_seconds, simulation_seconds / 15.0),
                )
                .unwrap();
                assert!(result.supported, "reason={:?}", result.reason);
            }

            let prefix = prefix_only.materialize().unwrap();
            let long = one_shot.materialize().unwrap();
            let split = segmented.materialize().unwrap();
            for field in [
                "totalProduced",
                "research",
                "dysonSwarm",
                "dysonSphere",
                "dysonPlans",
            ] {
                assert_eq!(
                    long[field], prefix[field],
                    "mode={resource_mode} field={field}"
                );
                assert_eq!(
                    split[field], long[field],
                    "mode={resource_mode} field={field}"
                );
            }
            assert_eq!(long["entities"], prefix["entities"]);
            assert_eq!(split["entities"], long["entities"]);
            assert_eq!(long["elapsedSeconds"], json!(60.0));
            assert_eq!(split["elapsedSeconds"], long["elapsedSeconds"]);
            assert_eq!(segmented.pure_idle_exact_seconds_used(), 30.0);
        }
    }

    fn unsupported_prefix_fixture() -> CoreState {
        let base = serde_json::to_vec(&json!({
            "version": 47,
            "mode": "normal",
            "activePlanetId": "home",
            "elapsedSeconds": 0,
            "historyRecordedAt": 0,
            "productionHistory": [],
            "paused": false,
            "settings": { "simulationSpeed": 1, "resourceMode": "infinite" },
            "manualMined": 0,
            "totalProduced": {},
            "blueprints": [],
            "handcraftQueue": [],
            "constructionQueue": [],
            "research": { "selectedTechId": null },
            "campaign": {
                "completedTaskIds": [],
                "rewardedTaskIds": [],
                "activeTaskId": "mine_first_ore",
                "activeChapterId": "foundation"
            },
            "constructionAutomation": { "enabled": false, "jobs": {}, "targetStock": {} },
            "exploration": {
                "missions": [],
                "unlockedSystemIds": [],
                "colonizedPlanetIds": [],
                "surveyProgressBySystem": {}
            },
            "timeWarp": {
                "enabled": true,
                "pendingSimulationSeconds": 0,
                "pendingWallSeconds": 0,
                "effectiveMultiplier": 15,
                "requiredPowerKw": 10000000000000000.0,
                "allocatedPowerKw": 10000000000000000.0
            },
            "dysonSwarm": { "totalLaunched": 0 },
            "dysonSphere": { "totalRocketsLaunched": 0 },
            "systemSpaceStations": {},
            "quantumLogisticsNetwork": { "inventory": {} },
            "endgame": {
                "activeInfiniteResearchId": null,
                "constructionActivity": { "activityId": null },
                "exportProjects": {}
            }
        }))
        .unwrap();
        let chunks = vec![json!({
            "id": "base",
            "kind": "base",
            "offset": 0,
            "count": 1,
            "checksum": fnv1a_utf8(&base),
            "bytes": base.len()
        })];
        let manifest = serde_json::to_vec(&json!({
            "formatVersion": 1,
            "envelopeFormatVersion": 2,
            "mode": "normal",
            "slot": "main",
            "stateVersion": 47,
            "savedAt": 1,
            "basePrimaryChecksum": "12345678",
            "chunkRootChecksum": "12345678",
            "totalBytes": base.len(),
            "entityCount": 0,
            "beltCount": 0,
            "chunks": chunks
        }))
        .unwrap();
        let records = BTreeMap::from([
            (
                "dsp-idle-network.internal.v1.chunked.v1.normal.manifest".into(),
                manifest,
            ),
            (
                "dsp-idle-network.internal.v1.chunked.v1.normal.chunk.base".into(),
                base,
            ),
        ]);
        CoreState::from_internal_records(
            CoreCheckpointIdentity {
                slot: "normal-main".into(),
                generation: 1,
                root_hash: "a".repeat(64),
                revision: 7,
                state_version: 47,
                mode: "normal".into(),
                registry_fingerprint: "pure-idle-test".into(),
                base_primary_checksum: "12345678".into(),
            },
            &records,
            fixture_catalog(),
        )
        .unwrap()
    }

    #[test]
    fn frozen_tail_clock_is_checked_without_touching_material_counters() {
        assert_eq!(checked_elapsed_after_prefix(10.25, 120.0).unwrap(), 130.25);
        assert!(checked_elapsed_after_prefix(f64::MAX, f64::MAX).is_err());
        assert!(checked_elapsed_after_prefix(1.0, -1.0).is_err());
    }

    #[test]
    fn thirty_second_prefix_uses_proportional_wall_time_at_supported_multipliers() {
        for multiplier in [8.0, 12.0, 15.0, 16.0] {
            let wall_seconds = 30.0;
            let simulation_seconds = wall_seconds * multiplier;
            let budget = prefix_budget(
                simulation_seconds,
                wall_seconds,
                PURE_IDLE_SESSION_EXACT_CREDIT_SECONDS,
            );
            assert_eq!(budget.exact_simulation_seconds, 30.0);
            assert!((budget.exact_wall_seconds - 30.0 / multiplier).abs() <= EPSILON);
            assert_eq!(
                budget.frozen_tail_seconds,
                simulation_seconds - PURE_IDLE_SESSION_EXACT_CREDIT_SECONDS
            );
        }
    }

    #[test]
    fn requests_inside_the_prefix_remain_fully_exact() {
        let budget = prefix_budget(20.0, 2.0, PURE_IDLE_SESSION_EXACT_CREDIT_SECONDS);
        assert_eq!(
            budget,
            PrefixBudget {
                exact_simulation_seconds: 20.0,
                exact_wall_seconds: 2.0,
                frozen_tail_seconds: 0.0,
            }
        );
    }

    #[test]
    fn segmented_multiplier_matrix_shares_one_thirty_second_credit() {
        for multiplier in [8.0, 12.0, 15.0, 16.0] {
            let total_wall_seconds = 30.0;
            let total_simulation_seconds = total_wall_seconds * multiplier;
            let long = prefix_budget(
                total_simulation_seconds,
                total_wall_seconds,
                PURE_IDLE_SESSION_EXACT_CREDIT_SECONDS,
            );

            let mut remaining_credit = PURE_IDLE_SESSION_EXACT_CREDIT_SECONDS;
            let mut segmented_exact = 0.0;
            let mut segmented_tail = 0.0;
            for wall_seconds in [3.0, 7.0, 11.0, 9.0] {
                let simulation_seconds = wall_seconds * multiplier;
                let budget = prefix_budget(simulation_seconds, wall_seconds, remaining_credit);
                segmented_exact += budget.exact_simulation_seconds;
                segmented_tail += budget.frozen_tail_seconds;
                remaining_credit = (remaining_credit - budget.exact_simulation_seconds).max(0.0);
            }

            assert!((segmented_exact - long.exact_simulation_seconds).abs() <= EPSILON);
            assert!((segmented_tail - long.frozen_tail_seconds).abs() <= EPSILON);
            assert!(remaining_credit <= EPSILON);
        }
    }

    #[test]
    fn exhausted_session_tail_is_canonically_segment_invariant() {
        for multiplier in [8.0, 12.0, 15.0, 16.0] {
            let mut initial = unsupported_prefix_fixture();
            initial.base_value_mut()["timeWarp"]["effectiveMultiplier"] = json!(multiplier);
            initial
                .install_pure_idle_session_progress(PURE_IDLE_SESSION_EXACT_CREDIT_SECONDS)
                .unwrap();
            let mut long = initial.clone();
            let mut segmented = initial.clone();
            let wall_seconds = 30.0;
            let simulation_seconds = wall_seconds * multiplier;
            let long_revision = long.revision;

            let long_result = advance(
                &mut long,
                &CoreAdvanceRequest {
                    base_revision: long_revision,
                    simulation_seconds,
                    wall_seconds,
                    advance_mode: CoreAdvanceMode::PureIdleConservativeV2,
                    include_diagnostics: false,
                },
            )
            .unwrap();
            assert!(long_result.supported);
            assert_eq!(long_result.exact_calibration_seconds, Some(0.0));

            for segment_wall_seconds in [3.0, 7.0, 11.0, 9.0] {
                let segmented_revision = segmented.revision;
                let result = advance(
                    &mut segmented,
                    &CoreAdvanceRequest {
                        base_revision: segmented_revision,
                        simulation_seconds: segment_wall_seconds * multiplier,
                        wall_seconds: segment_wall_seconds,
                        advance_mode: CoreAdvanceMode::PureIdleConservativeV2,
                        include_diagnostics: false,
                    },
                )
                .unwrap();
                assert!(result.supported);
                assert_eq!(result.exact_calibration_seconds, Some(0.0));
            }

            assert_eq!(
                segmented.summary().unwrap().canonical_sha256,
                long.summary().unwrap().canonical_sha256
            );
            assert_eq!(
                segmented.pure_idle_exact_seconds_used(),
                PURE_IDLE_SESSION_EXACT_CREDIT_SECONDS
            );
        }
    }

    #[test]
    fn unsupported_exact_prefix_never_commits_the_candidate() {
        let mut state = unsupported_prefix_fixture();
        state.install_pure_idle_session_progress(12.5).unwrap();
        let before_revision = state.revision;
        let before = state.materialize().unwrap();
        let before_hash = state.summary().unwrap().canonical_sha256;
        let result = advance(
            &mut state,
            &CoreAdvanceRequest {
                base_revision: before_revision,
                simulation_seconds: 450.0,
                wall_seconds: 30.0,
                advance_mode: CoreAdvanceMode::PureIdleConservativeV2,
                include_diagnostics: false,
            },
        )
        .unwrap();

        assert!(!result.supported);
        assert_eq!(state.revision, before_revision);
        assert_eq!(state.materialize().unwrap(), before);
        assert_eq!(state.summary().unwrap().canonical_sha256, before_hash);
        assert_eq!(state.pure_idle_exact_seconds_used(), 12.5);
    }

    #[test]
    fn multiplier_failure_preserves_hash_revision_and_credit() {
        let mut state = unsupported_prefix_fixture();
        state
            .install_pure_idle_session_progress(PURE_IDLE_SESSION_EXACT_CREDIT_SECONDS)
            .unwrap();
        let before_revision = state.revision;
        let before_hash = state.summary().unwrap().canonical_sha256;

        let result = advance(
            &mut state,
            &CoreAdvanceRequest {
                base_revision: before_revision,
                simulation_seconds: 450.0,
                wall_seconds: 20.0,
                advance_mode: CoreAdvanceMode::PureIdleConservativeV2,
                include_diagnostics: true,
            },
        )
        .unwrap();
        assert!(!result.supported);
        assert_eq!(
            result.reason.as_deref(),
            Some("pure-idle-power-multiplier-changed")
        );
        assert_eq!(state.revision, before_revision);
        assert_eq!(state.summary().unwrap().canonical_sha256, before_hash);
        assert_eq!(
            state.pure_idle_exact_seconds_used(),
            PURE_IDLE_SESSION_EXACT_CREDIT_SECONDS
        );
    }

    #[test]
    fn successful_exact_realtime_advance_starts_a_new_session() {
        let mut state = unsupported_prefix_fixture();
        state.base_value_mut()["timeWarp"]["enabled"] = json!(false);
        state
            .install_pure_idle_session_progress(PURE_IDLE_SESSION_EXACT_CREDIT_SECONDS)
            .unwrap();
        let base_revision = state.revision;
        let result = state
            .advance(&CoreAdvanceRequest {
                base_revision,
                simulation_seconds: 1.0,
                wall_seconds: 1.0,
                advance_mode: CoreAdvanceMode::Exact,
                include_diagnostics: false,
            })
            .unwrap();
        assert!(result.supported, "unexpected reason: {:?}", result.reason);
        assert_eq!(state.pure_idle_exact_seconds_used(), 0.0);
    }

    #[test]
    fn durable_replay_preserves_session_credit_and_is_atomic_on_mismatch() {
        let mut initial = unsupported_prefix_fixture();
        initial
            .install_pure_idle_session_progress(PURE_IDLE_SESSION_EXACT_CREDIT_SECONDS)
            .unwrap();
        let mut expected = initial.clone();
        advance(
            &mut expected,
            &CoreAdvanceRequest {
                base_revision: 7,
                simulation_seconds: 450.0,
                wall_seconds: 30.0,
                advance_mode: CoreAdvanceMode::PureIdleConservativeV2,
                include_diagnostics: false,
            },
        )
        .unwrap();

        let mut replayed = initial.clone();
        replayed
            .replay_operation(
                7,
                8,
                None,
                450.0,
                30.0,
                CoreAdvanceMode::PureIdleConservativeV2,
            )
            .unwrap();
        assert_eq!(
            replayed.summary().unwrap().canonical_sha256,
            expected.summary().unwrap().canonical_sha256
        );
        assert_eq!(
            replayed.pure_idle_exact_seconds_used(),
            PURE_IDLE_SESSION_EXACT_CREDIT_SECONDS
        );

        let before_hash = initial.summary().unwrap().canonical_sha256;
        assert!(
            initial
                .replay_operation(
                    7,
                    9,
                    None,
                    450.0,
                    30.0,
                    CoreAdvanceMode::PureIdleConservativeV2,
                )
                .is_err()
        );
        assert_eq!(initial.revision, 7);
        assert_eq!(initial.summary().unwrap().canonical_sha256, before_hash);
        assert_eq!(
            initial.pure_idle_exact_seconds_used(),
            PURE_IDLE_SESSION_EXACT_CREDIT_SECONDS
        );
    }
}
