use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use anyhow::{anyhow, bail};
use serde_json::{Number, Value};

use crate::simulation::{CoreAdvanceMode, CoreAdvanceRequest, CoreAdvanceResult};
use crate::state::{CoreState, PURE_IDLE_SESSION_EXACT_CREDIT_SECONDS};

const ALGORITHM_VERSION: &str =
    "native-pure-idle-conservative-v4-session-bounded-30s-settlement-proof-v1";
const MAX_ADVANCE_SECONDS: f64 = 30.0 * 24.0 * 60.0 * 60.0;
const EPSILON: f64 = 0.000_001;
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;
const TERMINAL_ROCKET_ITEM_ID: &str = "small_carrier_rocket";
const TERMINAL_SAIL_ITEM_ID: &str = "solar_sail";

type MaterialTotals = BTreeMap<String, i128>;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct DysonTerminalSnapshot {
    rockets_launched: i128,
    structure_points: i128,
    structure_by_system: MaterialTotals,
    sails_launched: i128,
    sails_expired: i128,
    sails_in_orbit: i128,
    sails_absorbed: i128,
    shell_sails: i128,
    shell_by_system: MaterialTotals,
    orbit_sails_by_system: MaterialTotals,
    orbit_launched_by_system: MaterialTotals,
    orbit_expired_by_system: MaterialTotals,
}

/// Ephemeral proof input for one native candidate. It is never serialized into
/// public GameState v47, the save envelope, or a canonical hash. Each capture
/// owns only compact per-item counters; entity rows are decoded one at a time.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct SettlementProofSnapshot {
    owned: MaterialTotals,
    produced: MaterialTotals,
    consumed: MaterialTotals,
    granted: MaterialTotals,
    construction_outputs: MaterialTotals,
    construction_fleet_wip: MaterialTotals,
    portable_fleet: MaterialTotals,
    construction_crafted: i128,
    dyson: DysonTerminalSnapshot,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct ConstructionConversionLedger {
    transformations: MaterialTotals,
    available_inputs: MaterialTotals,
    produced: MaterialTotals,
    fleet_wip_consumed: MaterialTotals,
    crafted: i128,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct ConstructionRecipeReceipt {
    outputs: MaterialTotals,
    crafted: i128,
}

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

fn proof_counter(value: Option<&Value>, label: &str) -> anyhow::Result<i128> {
    let Some(value) = value else {
        return Ok(0);
    };
    if value.is_null() {
        return Ok(0);
    }
    if let Some(value) = value.as_u64() {
        if value as f64 > MAX_SAFE_INTEGER {
            bail!("{label} exceeds the safe integer range");
        }
        return Ok(i128::from(value));
    }
    if let Some(value) = value.as_i64() {
        if value < 0 {
            bail!("{label} is negative");
        }
        return Ok(i128::from(value));
    }
    if let Some(value) = value.as_f64() {
        if value.is_finite()
            && (0.0..=MAX_SAFE_INTEGER).contains(&value)
            && value.fract().abs() <= f64::EPSILON
        {
            return Ok(value as i128);
        }
        bail!("{label} is not a non-negative safe integer");
    }
    if let Some(value) = value.as_str() {
        if value.is_empty()
            || (value.len() > 1 && value.starts_with('0'))
            || !value.bytes().all(|byte| byte.is_ascii_digit())
        {
            bail!("{label} is not a canonical non-negative integer string");
        }
        return value
            .parse::<i128>()
            .map_err(|_| anyhow!("{label} integer string overflows the proof ledger"));
    }
    bail!("{label} is not an integer counter")
}

fn add_material_amount(
    totals: &mut MaterialTotals,
    item_id: &str,
    amount: i128,
    label: &str,
) -> anyhow::Result<()> {
    if item_id.is_empty() || amount < 0 {
        bail!("{label} contains an invalid material entry");
    }
    let total = totals.get(item_id).copied().unwrap_or(0);
    totals.insert(
        item_id.to_owned(),
        total
            .checked_add(amount)
            .ok_or_else(|| anyhow!("{label}.{item_id} overflows the proof ledger"))?,
    );
    Ok(())
}

fn add_material_store(
    totals: &mut MaterialTotals,
    value: Option<&Value>,
    label: &str,
) -> anyhow::Result<()> {
    let Some(value) = value else {
        return Ok(());
    };
    if value.is_null() {
        return Ok(());
    }
    let object = value
        .as_object()
        .ok_or_else(|| anyhow!("{label} is not an item store"))?;
    for (item_id, amount) in object {
        add_material_amount(
            totals,
            item_id,
            proof_counter(Some(amount), &format!("{label}.{item_id}"))?,
            label,
        )?;
    }
    Ok(())
}

fn add_nested_store(
    totals: &mut MaterialTotals,
    root: Option<&Value>,
    path: &[&str],
    label: &str,
) -> anyhow::Result<()> {
    let mut current = root;
    for key in path {
        current = current
            .and_then(Value::as_object)
            .and_then(|object| object.get(*key));
    }
    add_material_store(totals, current, label)
}

fn capture_cumulative_grants(state: &CoreState) -> anyhow::Result<MaterialTotals> {
    let mut totals = MaterialTotals::new();
    for (item_id, amount) in crate::campaign::cumulative_material_grants(state) {
        add_material_amount(&mut totals, &item_id, i128::from(amount), "campaignRewards")?;
    }

    let completed = state
        .base_value()
        .get("research")
        .and_then(Value::as_object)
        .and_then(|research| research.get("completedTechIds"))
        .and_then(Value::as_array);
    if let Some(completed) = completed {
        for technology_id in completed.iter().filter_map(Value::as_str) {
            let Some(technology) = state.catalog.technologies.get(technology_id) else {
                continue;
            };
            for construction_id in &technology.construction_rewards {
                add_material_amount(&mut totals, construction_id, 2, "technologyRewards")?;
            }
            if technology_id == "universe_matrix" {
                // The public TypeScript conservation gate treats this one-off
                // unlock as a cumulative grant as well. A pre-existing exporter
                // can only make this allowance conservative; it cannot create
                // a false rejection at the completion boundary.
                add_material_amount(
                    &mut totals,
                    "galactic_material_exporter",
                    1,
                    "technologyRewards",
                )?;
            }
        }
    }
    Ok(totals)
}

fn capture_dyson_terminal(
    base: &serde_json::Map<String, Value>,
) -> anyhow::Result<DysonTerminalSnapshot> {
    fn counter_at(root: Option<&Value>, key: &str, label: &str) -> anyhow::Result<i128> {
        proof_counter(
            root.and_then(Value::as_object)
                .and_then(|object| object.get(key)),
            label,
        )
    }

    let sphere = base.get("dysonSphere");
    let swarm = base.get("dysonSwarm");
    let mut snapshot = DysonTerminalSnapshot {
        rockets_launched: counter_at(
            sphere,
            "totalRocketsLaunched",
            "dysonSphere.totalRocketsLaunched",
        )?,
        structure_points: counter_at(sphere, "structurePoints", "dysonSphere.structurePoints")?,
        sails_launched: counter_at(swarm, "totalLaunched", "dysonSwarm.totalLaunched")?,
        sails_expired: counter_at(swarm, "totalExpired", "dysonSwarm.totalExpired")?,
        sails_in_orbit: counter_at(swarm, "sailsInOrbit", "dysonSwarm.sailsInOrbit")?,
        sails_absorbed: counter_at(
            sphere,
            "totalSailsAbsorbed",
            "dysonSphere.totalSailsAbsorbed",
        )?,
        shell_sails: counter_at(sphere, "shellSails", "dysonSphere.shellSails")?,
        ..DysonTerminalSnapshot::default()
    };

    if let Some(plans) = base.get("dysonPlans")
        && !plans.is_null()
    {
        let plans = plans
            .as_object()
            .ok_or_else(|| anyhow!("dysonPlans is not an object"))?;
        for (system_id, plan) in plans {
            let structure = counter_at(
                Some(plan),
                "structurePoints",
                &format!("dysonPlans.{system_id}.structurePoints"),
            )?;
            let shell = counter_at(
                Some(plan),
                "shellSails",
                &format!("dysonPlans.{system_id}.shellSails"),
            )?;
            snapshot
                .structure_by_system
                .insert(system_id.clone(), structure);
            snapshot.shell_by_system.insert(system_id.clone(), shell);
        }
    }

    if let Some(by_system) = base
        .get("dysonEngineering")
        .and_then(Value::as_object)
        .and_then(|engineering| engineering.get("orbitsBySystem"))
        && !by_system.is_null()
    {
        let by_system = by_system
            .as_object()
            .ok_or_else(|| anyhow!("dysonEngineering.orbitsBySystem is not an object"))?;
        for (system_id, orbits) in by_system {
            let orbits = orbits.as_array().ok_or_else(|| {
                anyhow!("dysonEngineering.orbitsBySystem.{system_id} is not an array")
            })?;
            let mut stock = 0_i128;
            let mut launched = 0_i128;
            let mut expired = 0_i128;
            for (orbit_index, orbit) in orbits.iter().enumerate() {
                stock = stock
                    .checked_add(counter_at(
                        Some(orbit),
                        "sailsInOrbit",
                        &format!(
                            "dysonEngineering.orbitsBySystem.{system_id}.{orbit_index}.sailsInOrbit"
                        ),
                    )?)
                    .ok_or_else(|| anyhow!("Dyson orbit stock proof ledger overflow"))?;
                launched = launched
                    .checked_add(counter_at(
                        Some(orbit),
                        "totalLaunched",
                        &format!(
                            "dysonEngineering.orbitsBySystem.{system_id}.{orbit_index}.totalLaunched"
                        ),
                    )?)
                    .ok_or_else(|| anyhow!("Dyson orbit launch proof ledger overflow"))?;
                expired = expired
                    .checked_add(counter_at(
                        Some(orbit),
                        "totalExpired",
                        &format!(
                            "dysonEngineering.orbitsBySystem.{system_id}.{orbit_index}.totalExpired"
                        ),
                    )?)
                    .ok_or_else(|| anyhow!("Dyson orbit expiry proof ledger overflow"))?;
            }
            snapshot
                .orbit_sails_by_system
                .insert(system_id.clone(), stock);
            snapshot
                .orbit_launched_by_system
                .insert(system_id.clone(), launched);
            snapshot
                .orbit_expired_by_system
                .insert(system_id.clone(), expired);
        }
    }
    Ok(snapshot)
}

fn add_consumption_entry(
    consumed: &mut MaterialTotals,
    item_id: &str,
    value: Option<&Value>,
    label: &str,
) -> anyhow::Result<()> {
    add_material_amount(consumed, item_id, proof_counter(value, label)?, label)
}

fn capture_settlement_snapshot(state: &CoreState) -> anyhow::Result<SettlementProofSnapshot> {
    let base = state.base_value();
    let mut snapshot = SettlementProofSnapshot {
        granted: capture_cumulative_grants(state)?,
        construction_crafted: proof_counter(
            base.get("constructionAutomation")
                .and_then(Value::as_object)
                .and_then(|automation| automation.get("totalCrafted")),
            "constructionAutomation.totalCrafted",
        )?,
        dyson: capture_dyson_terminal(base)?,
        ..SettlementProofSnapshot::default()
    };

    add_material_store(
        &mut snapshot.produced,
        base.get("totalProduced"),
        "totalProduced",
    )?;

    // The active tray is authoritative. Public JSON serializes a duplicate in
    // planetTrays, so counting both would turn every active-planet transfer
    // into apparent material creation.
    add_material_store(&mut snapshot.owned, base.get("tray"), "tray")?;
    let active_planet_id = base
        .get("activePlanetId")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if let Some(planet_trays) = base.get("planetTrays")
        && !planet_trays.is_null()
    {
        let planet_trays = planet_trays
            .as_object()
            .ok_or_else(|| anyhow!("planetTrays is not an object"))?;
        for (planet_id, tray) in planet_trays {
            if planet_id != active_planet_id {
                add_material_store(
                    &mut snapshot.owned,
                    Some(tray),
                    &format!("planetTrays.{planet_id}"),
                )?;
            }
        }
    }

    let mut seen_route_ids = HashSet::<String>::new();
    let mut route_reservations = HashMap::<String, MaterialTotals>::new();
    for entity_index in 0..state.entity_index.len() {
        let entity = state.parse_entity(entity_index)?;
        let entity = entity
            .as_object()
            .ok_or_else(|| anyhow!("native settlement proof entity is not an object"))?;
        let entity_id = entity
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        add_material_store(
            &mut snapshot.owned,
            entity.get("inputs"),
            &format!("entities.{entity_id}.inputs"),
        )?;
        add_material_store(
            &mut snapshot.owned,
            entity.get("outputs"),
            &format!("entities.{entity_id}.outputs"),
        )?;
        for (field, item_id) in [
            ("stationWarpers", "space_warper"),
            ("stationDrones", "logistics_drone"),
            ("stationVessels", "logistics_vessel"),
        ] {
            if entity.contains_key(field) {
                add_material_amount(
                    &mut snapshot.owned,
                    item_id,
                    proof_counter(entity.get(field), &format!("entities.{entity_id}.{field}"))?,
                    &format!("entities.{entity_id}.{field}"),
                )?;
            }
        }

        if let Some(routes) = entity.get("stationRoutes")
            && !routes.is_null()
        {
            let routes = routes
                .as_array()
                .ok_or_else(|| anyhow!("entities.{entity_id}.stationRoutes is not an array"))?;
            for route in routes {
                let route = route.as_object().ok_or_else(|| {
                    anyhow!("entities.{entity_id}.stationRoutes contains a non-object")
                })?;
                let route_id = route
                    .get("id")
                    .and_then(Value::as_str)
                    .ok_or_else(|| anyhow!("station route is missing an ID"))?;
                if !seen_route_ids.insert(route_id.to_owned()) {
                    continue;
                }
                let item_id = route
                    .get("itemId")
                    .and_then(Value::as_str)
                    .ok_or_else(|| anyhow!("stationRoutes.{route_id}.itemId is invalid"))?;
                let cargo = proof_counter(
                    route.get("cargo"),
                    &format!("stationRoutes.{route_id}.cargo"),
                )?;
                add_material_amount(
                    &mut snapshot.owned,
                    item_id,
                    cargo,
                    &format!("stationRoutes.{route_id}"),
                )?;
                if let Some(source_id) = route.get("peerId").and_then(Value::as_str) {
                    add_material_amount(
                        route_reservations.entry(source_id.to_owned()).or_default(),
                        item_id,
                        cargo,
                        &format!("stationRoutes.{route_id}.reservation"),
                    )?;
                }
            }
        }

        if let Some(ports) = entity.get("blackHolePorts")
            && !ports.is_null()
        {
            let ports = ports
                .as_array()
                .ok_or_else(|| anyhow!("entities.{entity_id}.blackHolePorts is not an array"))?;
            for (port_index, port) in ports.iter().enumerate() {
                let Some(port) = port.as_object() else {
                    bail!("entities.{entity_id}.blackHolePorts.{port_index} is not an object");
                };
                let Some(item_id) = port.get("currentItemId").and_then(Value::as_str) else {
                    continue;
                };
                if item_id.is_empty() {
                    continue;
                }
                add_consumption_entry(
                    &mut snapshot.consumed,
                    item_id,
                    port.get("totalDestroyed"),
                    &format!("entities.{entity_id}.blackHolePorts.{port_index}.totalDestroyed"),
                )?;
            }
        }
    }

    // Legacy station-route cargo stays reserved in the source output until
    // arrival. Replace that reserved portion with the explicit in-flight
    // amount so the same item is represented exactly once.
    for (source_id, by_item) in route_reservations {
        let Some(source_index) = state.entity_index.get(&source_id).copied() else {
            continue;
        };
        let source = state.parse_entity(source_index)?;
        let outputs = source
            .as_object()
            .and_then(|source| source.get("outputs"))
            .and_then(Value::as_object);
        for (item_id, reserved) in by_item {
            let output = proof_counter(
                outputs.and_then(|outputs| outputs.get(&item_id)),
                &format!("entities.{source_id}.outputs.{item_id}"),
            )?;
            let deduction = reserved.min(output);
            let current = snapshot.owned.get(&item_id).copied().unwrap_or(0);
            snapshot.owned.insert(
                item_id.clone(),
                current.checked_sub(deduction).ok_or_else(|| {
                    anyhow!("station route reservation underflows {item_id} ownership")
                })?,
            );
        }
    }

    add_material_store(
        &mut snapshot.owned,
        base.get("construction"),
        "construction",
    )?;
    add_material_store(
        &mut snapshot.construction_outputs,
        base.get("construction"),
        "constructionOutputs.construction",
    )?;
    if let Some(automation) = base.get("constructionAutomation") {
        if let Some(jobs) = automation
            .as_object()
            .and_then(|automation| automation.get("jobs"))
            && !jobs.is_null()
        {
            let jobs = jobs
                .as_object()
                .ok_or_else(|| anyhow!("constructionAutomation.jobs is not an object"))?;
            for (job_id, job) in jobs {
                add_nested_store(
                    &mut snapshot.owned,
                    Some(job),
                    &["inventory"],
                    &format!("constructionAutomation.jobs.{job_id}.inventory"),
                )?;
                add_nested_store(
                    &mut snapshot.construction_fleet_wip,
                    Some(job),
                    &["inventory"],
                    &format!("constructionAutomation.jobs.{job_id}.fleetWip"),
                )?;
            }
        }
        if let Some(buffers) = automation
            .as_object()
            .and_then(|automation| automation.get("quantumMaterialBuffer"))
            && !buffers.is_null()
        {
            let buffers = buffers.as_object().ok_or_else(|| {
                anyhow!("constructionAutomation.quantumMaterialBuffer is not an object")
            })?;
            for (entity_id, inventory) in buffers {
                add_material_store(
                    &mut snapshot.owned,
                    Some(inventory),
                    &format!("constructionAutomation.quantumMaterialBuffer.{entity_id}"),
                )?;
            }
        }
        add_nested_store(
            &mut snapshot.consumed,
            Some(automation),
            &["destroyedByproducts"],
            "constructionAutomation.destroyedByproducts",
        )?;
    }

    if let Some(queue) = base.get("constructionQueue")
        && !queue.is_null()
    {
        let queue = queue
            .as_array()
            .ok_or_else(|| anyhow!("constructionQueue is not an array"))?;
        for (index, entry) in queue.iter().enumerate() {
            add_nested_store(
                &mut snapshot.owned,
                Some(entry),
                &["reservedConstruction"],
                &format!("constructionQueue.{index}.reservedConstruction"),
            )?;
            add_nested_store(
                &mut snapshot.owned,
                Some(entry),
                &["reservedFleet"],
                &format!("constructionQueue.{index}.reservedFleet"),
            )?;
        }
    }
    add_material_store(
        &mut snapshot.owned,
        base.get("portableFleet"),
        "portableFleet",
    )?;
    add_material_store(
        &mut snapshot.portable_fleet,
        base.get("portableFleet"),
        "constructionStage.portableFleet",
    )?;
    add_material_store(
        &mut snapshot.construction_outputs,
        base.get("portableFleet"),
        "constructionOutputs.portableFleet",
    )?;
    if let Some(cargo) = base.get("cargo")
        && !cargo.is_null()
    {
        let cargo = cargo
            .as_object()
            .ok_or_else(|| anyhow!("cargo is not an object"))?;
        if let Some(item_id) = cargo.get("itemId").and_then(Value::as_str) {
            add_material_amount(
                &mut snapshot.owned,
                item_id,
                proof_counter(cargo.get("amount"), "cargo.amount")?,
                "cargo",
            )?;
        }
    }
    add_nested_store(
        &mut snapshot.owned,
        base.get("quantumLogisticsNetwork"),
        &["inventory"],
        "quantumLogisticsNetwork.inventory",
    )?;

    if let Some(stations) = base.get("systemSpaceStations")
        && !stations.is_null()
    {
        let stations = stations
            .as_object()
            .ok_or_else(|| anyhow!("systemSpaceStations is not an object"))?;
        for (system_id, station) in stations {
            if station.is_null() {
                continue;
            }
            add_nested_store(
                &mut snapshot.owned,
                Some(station),
                &["inventory"],
                &format!("systemSpaceStations.{system_id}.inventory"),
            )?;
            add_nested_store(
                &mut snapshot.owned,
                Some(station),
                &["constructionBuffer"],
                &format!("systemSpaceStations.{system_id}.constructionBuffer"),
            )?;
            add_nested_store(
                &mut snapshot.consumed,
                Some(station),
                &["delivered"],
                &format!("systemSpaceStations.{system_id}.delivered"),
            )?;
        }
    }
    if let Some(network) = base.get("galacticHubNetwork") {
        let warpers = network
            .as_object()
            .and_then(|network| network.get("warpers"));
        if warpers.is_some() {
            add_material_amount(
                &mut snapshot.owned,
                "space_warper",
                proof_counter(warpers, "galacticHubNetwork.warpers")?,
                "galacticHubNetwork.warpers",
            )?;
        }
    }

    if let Some(activity) = base
        .get("endgame")
        .and_then(Value::as_object)
        .and_then(|endgame| endgame.get("constructionActivity"))
    {
        add_nested_store(
            &mut snapshot.consumed,
            Some(activity),
            &["personalDelivered"],
            "endgame.constructionActivity.personalDelivered",
        )?;
        if let Some(batches) = activity
            .as_object()
            .and_then(|activity| activity.get("pendingBatches"))
            && !batches.is_null()
        {
            let batches = batches.as_object().ok_or_else(|| {
                anyhow!("endgame.constructionActivity.pendingBatches is not an object")
            })?;
            for (batch_id, batch) in batches {
                if batch.is_null() {
                    continue;
                }
                let batch = batch.as_object().ok_or_else(|| {
                    anyhow!("constructionActivity.pendingBatches.{batch_id} is not an object")
                })?;
                let item_id = batch
                    .get("itemId")
                    .and_then(Value::as_str)
                    .unwrap_or(batch_id);
                add_material_amount(
                    &mut snapshot.owned,
                    item_id,
                    proof_counter(
                        batch.get("amount"),
                        &format!("constructionActivity.pendingBatches.{batch_id}.amount"),
                    )?,
                    &format!("constructionActivity.pendingBatches.{batch_id}"),
                )?;
            }
        }
    }

    const GALACTIC_EXPORT_ITEMS: [(&str, &str); 4] = [
        ("universe_archive", "universe_matrix"),
        ("solar_sail_array", TERMINAL_SAIL_ITEM_ID),
        ("carrier_rocket_fleet", TERMINAL_ROCKET_ITEM_ID),
        ("antimatter_exchange", "antimatter_fuel_rod"),
    ];
    let export_projects = base
        .get("endgame")
        .and_then(Value::as_object)
        .and_then(|endgame| endgame.get("exportProjects"))
        .and_then(Value::as_object);
    for (project_id, item_id) in GALACTIC_EXPORT_ITEMS {
        let total = export_projects
            .and_then(|projects| projects.get(project_id))
            .and_then(Value::as_object)
            .and_then(|project| project.get("totalDelivered"));
        if total.is_some() {
            add_consumption_entry(
                &mut snapshot.consumed,
                item_id,
                total,
                &format!("endgame.exportProjects.{project_id}.totalDelivered"),
            )?;
        }
    }

    add_nested_store(
        &mut snapshot.consumed,
        base.get("orbitalStation"),
        &["totals", "exportedByItem"],
        "orbitalStation.totals.exportedByItem",
    )?;
    if let Some(requirements) = base
        .get("orbitalStation")
        .and_then(Value::as_object)
        .and_then(|station| station.get("construction"))
        .and_then(Value::as_object)
        .and_then(|construction| construction.get("stageRequirements"))
        && !requirements.is_null()
    {
        let requirements = requirements.as_array().ok_or_else(|| {
            anyhow!("orbitalStation.construction.stageRequirements is not an array")
        })?;
        for (index, stage) in requirements.iter().enumerate() {
            add_nested_store(
                &mut snapshot.consumed,
                Some(stage),
                &["delivered"],
                &format!("orbitalStation.construction.stageRequirements.{index}.delivered"),
            )?;
        }
    }

    Ok(snapshot)
}

fn material_delta(before: &MaterialTotals, after: &MaterialTotals, item_id: &str) -> i128 {
    after.get(item_id).copied().unwrap_or(0) - before.get(item_id).copied().unwrap_or(0)
}

fn material_ids<'a>(maps: impl IntoIterator<Item = &'a MaterialTotals>) -> BTreeSet<String> {
    maps.into_iter()
        .flat_map(|map| map.keys().cloned())
        .collect()
}

fn checked_terminal_delta(after: i128, before: i128, label: &str) -> Result<i128, String> {
    let delta = after - before;
    if delta < 0 {
        return Err(format!("{label} cumulative counter regressed"));
    }
    Ok(delta)
}

fn system_delta_sum(
    before: &MaterialTotals,
    after: &MaterialTotals,
    label: &str,
    require_monotonic: bool,
) -> Result<i128, String> {
    let mut total = 0_i128;
    for system_id in material_ids([before, after]) {
        let delta = material_delta(before, after, &system_id);
        if require_monotonic && delta < 0 {
            return Err(format!("{label}.{system_id} cumulative counter regressed"));
        }
        total = total
            .checked_add(delta)
            .ok_or_else(|| format!("{label} delta sum overflowed"))?;
    }
    Ok(total)
}

fn construction_catalog_integer(value: f64, label: &str) -> Result<i128, String> {
    if !value.is_finite()
        || !(1.0..=MAX_SAFE_INTEGER).contains(&value)
        || value.fract().abs() > f64::EPSILON
    {
        return Err(format!("{label} is not a positive safe integer"));
    }
    Ok(value as i128)
}

fn add_construction_recipe_cost(
    required: &mut MaterialTotals,
    item_id: &str,
    unit_cost: f64,
    batches: i128,
    label: &str,
) -> Result<(), String> {
    let unit_cost = construction_catalog_integer(unit_cost, label)?;
    let amount = unit_cost
        .checked_mul(batches)
        .ok_or_else(|| format!("{label} cost overflows the construction proof ledger"))?;
    let current = required.get(item_id).copied().unwrap_or(0);
    required.insert(
        item_id.to_owned(),
        current
            .checked_add(amount)
            .ok_or_else(|| format!("{label} total cost overflows the construction proof ledger"))?,
    );
    Ok(())
}

fn floor_i128_ratio(numerator: i128, denominator: i128) -> Result<i128, String> {
    if denominator <= 0 {
        return Err("construction proof ratio denominator is not positive".to_owned());
    }
    if numerator >= 0 {
        return Ok(numerator / denominator);
    }
    numerator
        .checked_neg()
        .and_then(|positive| positive.checked_add(denominator - 1))
        .and_then(|rounded| rounded.checked_div(denominator))
        .and_then(i128::checked_neg)
        .ok_or_else(|| "construction proof ratio overflowed".to_owned())
}

fn ceil_i128_ratio(numerator: i128, denominator: i128) -> Result<i128, String> {
    floor_i128_ratio(
        numerator
            .checked_neg()
            .ok_or_else(|| "construction proof ratio overflowed".to_owned())?,
        denominator,
    )?
    .checked_neg()
    .ok_or_else(|| "construction proof ratio overflowed".to_owned())
}

fn capture_construction_conversion_ledger(
    before: &SettlementProofSnapshot,
    after: &SettlementProofSnapshot,
) -> Result<ConstructionConversionLedger, String> {
    let crafted = checked_terminal_delta(
        after.construction_crafted,
        before.construction_crafted,
        "constructionAutomation.totalCrafted",
    )?;
    let construction_item_ids =
        material_ids([&before.construction_outputs, &after.construction_outputs]);
    let mut ledger = ConstructionConversionLedger {
        crafted,
        ..ConstructionConversionLedger::default()
    };
    for item_id in ["logistics_drone", "logistics_vessel"] {
        let consumed = material_delta(
            &before.construction_fleet_wip,
            &after.construction_fleet_wip,
            item_id,
        )
        .checked_neg()
        .ok_or_else(|| format!("{item_id} construction WIP delta overflowed"))?;
        let portable_increase =
            material_delta(&before.portable_fleet, &after.portable_fleet, item_id);
        let receipted_transfer = consumed.min(portable_increase);
        if receipted_transfer > 0 {
            ledger
                .fleet_wip_consumed
                .insert(item_id.to_owned(), receipted_transfer);
        }
    }
    let mut transformation_total = 0_i128;

    for item_id in material_ids([
        &before.owned,
        &after.owned,
        &before.produced,
        &after.produced,
        &before.consumed,
        &after.consumed,
        &before.granted,
        &after.granted,
    ]) {
        let stock_delta = material_delta(&before.owned, &after.owned, &item_id);
        let produced_delta = material_delta(&before.produced, &after.produced, &item_id);
        let consumed_delta = material_delta(&before.consumed, &after.consumed, &item_id);
        let granted_delta = material_delta(&before.granted, &after.granted, &item_id);
        if produced_delta < 0 {
            return Err(format!("{item_id} cumulative production regressed"));
        }
        if consumed_delta < 0 {
            return Err(format!(
                "{item_id} cumulative export/destroy/delivery regressed"
            ));
        }
        if granted_delta < 0 {
            return Err(format!("{item_id} cumulative audited grant regressed"));
        }
        ledger.produced.insert(item_id.clone(), produced_delta);
        let base_sources = produced_delta
            .checked_add(granted_delta)
            .ok_or_else(|| format!("{item_id} source delta overflowed"))?;
        let accounted = stock_delta
            .checked_add(consumed_delta)
            .ok_or_else(|| format!("{item_id} accounted delta overflowed"))?;
        if base_sources > accounted {
            ledger.available_inputs.insert(
                item_id.clone(),
                base_sources
                    .checked_sub(accounted)
                    .ok_or_else(|| format!("{item_id} construction input delta overflowed"))?,
            );
        }

        // Construction/fleet stores are ordinary ownership locations too. A
        // refund or WIP transfer can raise one local store while the same item
        // leaves another owned store. Only the unexplained aggregate deficit
        // is a manufacturing conversion, after audited grants are deducted.
        let transformation = if construction_item_ids.contains(&item_id) && accounted > base_sources
        {
            accounted
                .checked_sub(base_sources)
                .ok_or_else(|| format!("{item_id} construction transformation delta overflowed"))?
        } else {
            0
        };
        if transformation > 0 {
            ledger.transformations.insert(item_id, transformation);
        }
        transformation_total = transformation_total
            .checked_add(transformation)
            .ok_or_else(|| "construction transformation total overflowed".to_owned())?;
        if transformation_total > crafted {
            return Err(format!(
                "construction/fleet transformation {transformation_total} exceeds totalCrafted delta {crafted}"
            ));
        }
    }
    Ok(ledger)
}

fn fleet_recipe_proof<'a>(
    catalog: &'a crate::catalog::RuntimeCatalog,
    item_id: &'static str,
    produced: &MaterialTotals,
) -> Result<(&'a crate::catalog::RecipeDefinition, i128), String> {
    let recipe = catalog
        .recipes
        .get(item_id)
        .ok_or_else(|| format!("construction recipe input cannot prove {item_id} fleet output"))?;
    let output = recipe
        .outputs
        .iter()
        .find(|output| output.item_id == item_id)
        .ok_or_else(|| format!("construction recipe input cannot prove {item_id} fleet output"))?;
    let output_amount = construction_catalog_integer(
        output.amount,
        &format!("recipes.{item_id}.outputs.{item_id}"),
    )?;
    if output_amount != 1 {
        return Err(format!(
            "construction recipe input cannot prove {item_id} fleet output amount {output_amount}"
        ));
    }
    Ok((recipe, produced.get(item_id).copied().unwrap_or(0)))
}

/// Bind each unexplained construction output to its exact catalog cost vector.
/// `totalCrafted` is only a monotonic cross-check and never a material source.
/// An untrusted settlement must carry the private receipt issued only after an
/// engine-owned exact transition closes this vector; arbitrary serialized
/// candidates and coincidental material deltas cannot mint that receipt.
///
/// Unlike the TypeScript construction-only macro, today's native exact prefix
/// interleaves ordinary factory work and construction. Its internal proof can
/// therefore close the interval's item vector but cannot attribute a same-item
/// loss to one particular construction center. That residual trust is bounded
/// to `CoreState::advance_exact`: until `construction::run_centers` emits its
/// own receipt, the untrusted candidate path below must remain receipt-free.
fn validate_construction_recipe_conversion(
    ledger: &ConstructionConversionLedger,
    catalog: &crate::catalog::RuntimeCatalog,
    receipt: Option<&ConstructionRecipeReceipt>,
    trusted_internal_stage: bool,
) -> Result<(), String> {
    let mut required_inputs = MaterialTotals::new();
    let mut building_output_total = 0_i128;

    for (construction_id, output_delta) in &ledger.transformations {
        if *output_delta < 1 {
            continue;
        }
        let definition = catalog.constructions.get(construction_id).ok_or_else(|| {
            format!(
                "construction recipe input cannot prove unknown construction {construction_id} delta {output_delta}"
            )
        })?;
        let output_amount = construction_catalog_integer(
            definition.output_amount,
            &format!("constructions.{construction_id}.outputAmount"),
        )?;
        if output_delta % output_amount != 0 {
            return Err(format!(
                "construction {construction_id} delta {output_delta} is not divisible by recipe output {output_amount}"
            ));
        }
        let batches = output_delta / output_amount;
        building_output_total = building_output_total
            .checked_add(*output_delta)
            .ok_or_else(|| "construction output proof total overflowed".to_owned())?;
        for cost in &definition.costs {
            add_construction_recipe_cost(
                &mut required_inputs,
                &cost.item_id,
                cost.amount,
                batches,
                &format!("constructions.{construction_id}.costs.{}", cost.item_id),
            )?;
        }
    }

    if building_output_total > ledger.crafted {
        return Err(format!(
            "construction recipe output {building_output_total} exceeds totalCrafted delta {}",
            ledger.crafted
        ));
    }

    if !trusted_internal_stage {
        if building_output_total > 0 || ledger.crafted > 0 {
            let receipt = receipt.ok_or_else(|| {
                "construction recipe input receipt is missing; totalCrafted cannot prove itself"
                    .to_owned()
            })?;
            if receipt.crafted != ledger.crafted {
                return Err(format!(
                    "construction totalCrafted delta {} does not match stage receipt {}",
                    ledger.crafted, receipt.crafted
                ));
            }
            for construction_id in material_ids([&ledger.transformations, &receipt.outputs]) {
                let observed = ledger
                    .transformations
                    .get(&construction_id)
                    .copied()
                    .unwrap_or(0);
                let receipted = receipt.outputs.get(&construction_id).copied().unwrap_or(0);
                if observed != receipted {
                    return Err(format!(
                        "construction {construction_id} delta {observed} does not match stage receipt {receipted}"
                    ));
                }
            }
        }
        return Ok(());
    }

    // Fleet completion consumes the recipe output and returns the same item to
    // portableFleet, so it has no aggregate transformation. Prove the residual
    // completion counter through the two exact fleet recipe vectors instead.
    let fleet_crafted = ledger
        .crafted
        .checked_sub(building_output_total)
        .ok_or_else(|| "construction fleet completion underflowed".to_owned())?;
    let carried_fleet_wip = ["logistics_drone", "logistics_vessel"]
        .into_iter()
        .try_fold(0_i128, |total, item_id| {
            total
                .checked_add(ledger.fleet_wip_consumed.get(item_id).copied().unwrap_or(0))
                .ok_or_else(|| "construction fleet WIP credit overflowed".to_owned())
        })?;
    // A recipe step may finish in one exact bucket and its fleet-install step
    // in the next. Only the completion count not backed by an actual decrease
    // in already-owned job WIP must pay a same-window recipe vector.
    let newly_produced_fleet_crafted = fleet_crafted.saturating_sub(carried_fleet_wip);
    if newly_produced_fleet_crafted > 0 {
        let (drone_recipe, drone_capacity) =
            fleet_recipe_proof(catalog, "logistics_drone", &ledger.produced)?;
        let (vessel_recipe, vessel_capacity) =
            fleet_recipe_proof(catalog, "logistics_vessel", &ledger.produced)?;
        let total_capacity = drone_capacity
            .checked_add(vessel_capacity)
            .ok_or_else(|| "construction fleet production capacity overflowed".to_owned())?;
        if newly_produced_fleet_crafted > total_capacity {
            return Err(format!(
                "construction fleet completion {newly_produced_fleet_crafted} has no matching cumulative production or existing WIP"
            ));
        }

        // Let x be drones and (fleet_crafted - x) be vessels. Every material
        // inequality narrows one exact integer interval; any point in the
        // surviving interval is a closed recipe allocation.
        let mut lower = newly_produced_fleet_crafted
            .saturating_sub(vessel_capacity)
            .max(0);
        let mut upper = newly_produced_fleet_crafted.min(drone_capacity);
        let cost_items = drone_recipe
            .inputs
            .iter()
            .chain(&vessel_recipe.inputs)
            .map(|cost| cost.item_id.clone())
            .collect::<BTreeSet<_>>();
        for item_id in cost_items {
            let drone_cost = drone_recipe
                .inputs
                .iter()
                .find(|cost| cost.item_id == item_id)
                .map(|cost| {
                    construction_catalog_integer(
                        cost.amount,
                        &format!("recipes.logistics_drone.inputs.{item_id}"),
                    )
                })
                .transpose()?
                .unwrap_or(0);
            let vessel_cost = vessel_recipe
                .inputs
                .iter()
                .find(|cost| cost.item_id == item_id)
                .map(|cost| {
                    construction_catalog_integer(
                        cost.amount,
                        &format!("recipes.logistics_vessel.inputs.{item_id}"),
                    )
                })
                .transpose()?
                .unwrap_or(0);
            let already_required = required_inputs.get(&item_id).copied().unwrap_or(0);
            let available = ledger
                .available_inputs
                .get(&item_id)
                .copied()
                .unwrap_or(0)
                .checked_sub(already_required)
                .ok_or_else(|| {
                    format!("construction recipe input {item_id} is already overdrawn")
                })?;
            let difference = drone_cost
                .checked_sub(vessel_cost)
                .ok_or_else(|| "construction fleet cost difference overflowed".to_owned())?;
            let right = available
                .checked_sub(
                    vessel_cost
                        .checked_mul(newly_produced_fleet_crafted)
                        .ok_or_else(|| "construction fleet cost overflowed".to_owned())?,
                )
                .ok_or_else(|| "construction fleet available input overflowed".to_owned())?;
            if difference > 0 {
                upper = upper.min(floor_i128_ratio(right, difference)?);
            } else if difference < 0 {
                lower = lower.max(ceil_i128_ratio(
                    right
                        .checked_neg()
                        .ok_or_else(|| "construction fleet ratio overflowed".to_owned())?,
                    difference
                        .checked_neg()
                        .ok_or_else(|| "construction fleet ratio overflowed".to_owned())?,
                )?);
            } else if right < 0 {
                lower = upper.saturating_add(1);
            }
        }
        if lower > upper {
            return Err(format!(
                "construction recipe input cannot support {newly_produced_fleet_crafted} same-window fleet units"
            ));
        }
        let drone_count = lower;
        let vessel_count = newly_produced_fleet_crafted
            .checked_sub(drone_count)
            .ok_or_else(|| "construction fleet allocation underflowed".to_owned())?;
        for (recipe, count, label) in [
            (drone_recipe, drone_count, "logistics_drone"),
            (vessel_recipe, vessel_count, "logistics_vessel"),
        ] {
            for cost in &recipe.inputs {
                add_construction_recipe_cost(
                    &mut required_inputs,
                    &cost.item_id,
                    cost.amount,
                    count,
                    &format!("recipes.{label}.inputs.{}", cost.item_id),
                )?;
            }
        }
    }

    for (item_id, required) in required_inputs {
        let available = ledger.available_inputs.get(&item_id).copied().unwrap_or(0);
        if available < required {
            return Err(format!(
                "construction recipe input {item_id} requires {required}, proven consumption is only {available}"
            ));
        }
    }
    Ok(())
}

fn validate_settlement_proof(
    before: &SettlementProofSnapshot,
    after: &SettlementProofSnapshot,
    catalog: &crate::catalog::RuntimeCatalog,
    construction_receipt: Option<&ConstructionRecipeReceipt>,
) -> Result<(), String> {
    let construction = capture_construction_conversion_ledger(before, after)?;

    for item_id in material_ids([
        &before.owned,
        &after.owned,
        &before.produced,
        &after.produced,
        &before.consumed,
        &after.consumed,
        &before.granted,
        &after.granted,
    ]) {
        let stock_delta = material_delta(&before.owned, &after.owned, &item_id);
        let produced_delta = material_delta(&before.produced, &after.produced, &item_id);
        let consumed_delta = material_delta(&before.consumed, &after.consumed, &item_id);
        let granted_delta = material_delta(&before.granted, &after.granted, &item_id);
        if produced_delta < 0 {
            return Err(format!("{item_id} cumulative production regressed"));
        }
        if consumed_delta < 0 {
            return Err(format!(
                "{item_id} cumulative export/destroy/delivery regressed"
            ));
        }
        if granted_delta < 0 {
            return Err(format!("{item_id} cumulative audited grant regressed"));
        }
        let base_sources = produced_delta
            .checked_add(granted_delta)
            .ok_or_else(|| format!("{item_id} source delta overflowed"))?;
        let accounted = stock_delta
            .checked_add(consumed_delta)
            .ok_or_else(|| format!("{item_id} accounted delta overflowed"))?;

        // Construction/fleet stores are ordinary ownership locations too. A
        // refund or WIP transfer can raise one of these local stores while the
        // same item leaves another owned store. Treat only the unexplained
        // aggregate deficit as a manufacturing transformation, and only for
        // item IDs represented by the construction/fleet output domain.
        let construction_transformation = construction
            .transformations
            .get(&item_id)
            .copied()
            .unwrap_or(0);
        let sources = base_sources
            .checked_add(construction_transformation)
            .ok_or_else(|| format!("{item_id} source delta overflowed"))?;
        if accounted > sources {
            return Err(format!(
                "{item_id} stock plus known consumption delta {accounted} exceeds production, audited grants and bounded construction conversion {sources}"
            ));
        }
    }

    validate_construction_recipe_conversion(&construction, catalog, construction_receipt, false)?;

    let rockets_launched = checked_terminal_delta(
        after.dyson.rockets_launched,
        before.dyson.rockets_launched,
        "Dyson rocket launch",
    )?;
    let structure_points = checked_terminal_delta(
        after.dyson.structure_points,
        before.dyson.structure_points,
        "Dyson structure point",
    )?;
    if rockets_launched != structure_points {
        return Err(format!(
            "Dyson structure delta {structure_points} does not equal rocket launch delta {rockets_launched}"
        ));
    }
    let system_structure = system_delta_sum(
        &before.dyson.structure_by_system,
        &after.dyson.structure_by_system,
        "dysonPlans.structurePoints",
        true,
    )?;
    if system_structure != structure_points {
        return Err(format!(
            "per-system structure delta {system_structure} does not equal global structure delta {structure_points}"
        ));
    }

    let sails_launched = checked_terminal_delta(
        after.dyson.sails_launched,
        before.dyson.sails_launched,
        "solar sail launch",
    )?;
    let sails_expired = checked_terminal_delta(
        after.dyson.sails_expired,
        before.dyson.sails_expired,
        "solar sail expiry",
    )?;
    let sails_absorbed = checked_terminal_delta(
        after.dyson.sails_absorbed,
        before.dyson.sails_absorbed,
        "solar sail absorption",
    )?;
    let shell_sails = checked_terminal_delta(
        after.dyson.shell_sails,
        before.dyson.shell_sails,
        "Dyson shell sail",
    )?;
    if sails_absorbed != shell_sails {
        return Err(format!(
            "Dyson shell delta {shell_sails} does not equal absorbed sail delta {sails_absorbed}"
        ));
    }
    let orbit_stock_delta = after.dyson.sails_in_orbit - before.dyson.sails_in_orbit;
    let closed_sail_flow = orbit_stock_delta
        .checked_add(sails_expired)
        .and_then(|value| value.checked_add(sails_absorbed))
        .ok_or_else(|| "solar sail terminal flow overflowed".to_owned())?;
    if sails_launched != closed_sail_flow {
        return Err(format!(
            "solar sail launch delta {sails_launched} does not close against orbit/expiry/absorption delta {closed_sail_flow}"
        ));
    }
    let system_shell = system_delta_sum(
        &before.dyson.shell_by_system,
        &after.dyson.shell_by_system,
        "dysonPlans.shellSails",
        true,
    )?;
    if system_shell != shell_sails {
        return Err(format!(
            "per-system shell delta {system_shell} does not equal global shell delta {shell_sails}"
        ));
    }
    for (label, before_map, after_map, global_delta, monotonic) in [
        (
            "orbitsBySystem.sailsInOrbit",
            &before.dyson.orbit_sails_by_system,
            &after.dyson.orbit_sails_by_system,
            orbit_stock_delta,
            false,
        ),
        (
            "orbitsBySystem.totalLaunched",
            &before.dyson.orbit_launched_by_system,
            &after.dyson.orbit_launched_by_system,
            sails_launched,
            true,
        ),
        (
            "orbitsBySystem.totalExpired",
            &before.dyson.orbit_expired_by_system,
            &after.dyson.orbit_expired_by_system,
            sails_expired,
            true,
        ),
    ] {
        let system_delta = system_delta_sum(before_map, after_map, label, monotonic)?;
        if system_delta != global_delta {
            return Err(format!(
                "{label} delta {system_delta} does not equal its global delta {global_delta}"
            ));
        }
    }

    for (item_id, terminal_delta) in [
        (TERMINAL_ROCKET_ITEM_ID, rockets_launched),
        (TERMINAL_SAIL_ITEM_ID, sails_launched),
    ] {
        let produced_delta = material_delta(&before.produced, &after.produced, item_id);
        let grant_delta = material_delta(&before.granted, &after.granted, item_id);
        let consumed_delta = material_delta(&before.consumed, &after.consumed, item_id);
        let stock_source = before.owned.get(item_id).copied().unwrap_or(0)
            - after.owned.get(item_id).copied().unwrap_or(0);
        let available = produced_delta
            .checked_add(grant_delta)
            .and_then(|value| value.checked_add(stock_source))
            .ok_or_else(|| format!("{item_id} terminal source delta overflowed"))?;
        let used = terminal_delta
            .checked_add(consumed_delta)
            .ok_or_else(|| format!("{item_id} terminal use delta overflowed"))?;
        if used > available {
            return Err(format!(
                "{item_id} launch plus known consumption {used} exceeds produced/granted/inventory source {available}"
            ));
        }
    }
    Ok(())
}

/// Consumes a disposable candidate only after every material and terminal
/// identity closes. On failure the candidate is dropped and the caller's live
/// state remains byte-for-byte untouched.
#[cfg(test)]
fn prove_settlement_candidate(
    before: &SettlementProofSnapshot,
    candidate: CoreState,
) -> Result<CoreState, String> {
    let after = capture_settlement_snapshot(&candidate)
        .map_err(|error| format!("candidate snapshot invalid: {error:#}"))?;
    // This is the public/untrusted candidate boundary. A coincidental decrease
    // of the right materials is not proof that construction consumed them, so
    // this path deliberately has no authority to mint a stage receipt.
    validate_settlement_proof(before, &after, &candidate.catalog, None)?;
    Ok(candidate)
}

fn prove_internal_exact_settlement_candidate(
    before: &SettlementProofSnapshot,
    candidate: CoreState,
) -> Result<CoreState, String> {
    let after = capture_settlement_snapshot(&candidate)
        .map_err(|error| format!("candidate snapshot invalid: {error:#}"))?;
    let construction = capture_construction_conversion_ledger(before, &after)?;
    validate_construction_recipe_conversion(&construction, &candidate.catalog, None, true)?;
    let receipt = ConstructionRecipeReceipt {
        outputs: construction.transformations.clone(),
        crafted: construction.crafted,
    };
    validate_settlement_proof(before, &after, &candidate.catalog, Some(&receipt))?;
    Ok(candidate)
}

/// Conservative native pure-idle settlement.
///
/// Only the bounded prefix is simulated. The unproven tail advances the
/// authoritative clock and deliberately freezes every factory, inventory,
/// research, export, contract and Dyson counter. This is intentionally an
/// under-production policy: without a closed material ledger, extrapolating a
/// terminal result could duplicate prefilled rockets or sails.
///
/// The compact settlement proof below now closes aggregate ownership,
/// production, audited grants/consumption and Dyson terminal deltas before an
/// exact candidate commits. That is a rejection gate, not yet a productive
/// affine certificate. A productive tail still cannot be authorized here:
///
/// - two adjacent snapshots do not prove a stable rate across three windows;
/// - recipe dependencies, material-fuel power, finite veins and topology
///   boundaries are not yet represented as a native steady-flow certificate;
/// - research, integer terminal allocation and per-item fractional remainders
///   do not yet survive segmented native macro calls; and
/// - construction needs a separately accounted consumable flow budget before
///   certified production can fund a long macro tail.
///
/// Copying only the visible production counters or entity stores would
/// therefore reopen the exact conservation bug this mode exists to prevent.
/// Until those rate and remainder proofs exist, the larger exact prefix is the
/// only non-zero settlement committed here.
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
    let settlement_before = match capture_settlement_snapshot(state) {
        Ok(snapshot) => snapshot,
        Err(error) => {
            return unsupported(
                state,
                request,
                format!("pure-idle-settlement-proof-baseline-invalid: {error:#}"),
            );
        }
    };

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
    let mut candidate =
        match prove_internal_exact_settlement_candidate(&settlement_before, candidate) {
            Ok(candidate) => candidate,
            Err(reason) => {
                return unsupported(
                    state,
                    request,
                    format!("pure-idle-settlement-proof-rejected: {reason}"),
                );
            }
        };
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
        BeltDefinition, BuildingDefinition, CatalogSnapshot, ConstructionDefinition, ItemAmount,
        ItemDefinition, PlanetDefinition, RuntimeCatalog,
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
                    BuildingDefinition {
                        id: "construction_center".into(),
                        kind: "machine".into(),
                        speed: 1.0,
                        input_capacity: 1_000_000.0,
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
                ],
                recipes: Vec::new(),
                constructions: vec![
                    ConstructionDefinition {
                        id: "test_building".into(),
                        output_amount: 1.0,
                        automation_order: 0,
                        required_tech_id: None,
                        costs: vec![ItemAmount {
                            item_id: "iron_ore".into(),
                            amount: 1.0,
                        }],
                    },
                    ConstructionDefinition {
                        id: "conveyor_belt_mk1".into(),
                        output_amount: 1.0,
                        automation_order: 1,
                        required_tech_id: None,
                        costs: vec![ItemAmount {
                            item_id: "iron_ore".into(),
                            amount: 1.0,
                        }],
                    },
                ],
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
            (
                "construction",
                json!({ "test_building": 0, "conveyor_belt_mk1": 0 }),
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

    fn construction_powered_fixture() -> CoreState {
        let mut base = powered_fixture_base(15.0, "infinite");
        base["tray"] = json!({ "iron_ore": 10 });
        base["planetTrays"]["home"] = json!({ "iron_ore": 10 });
        base["construction"] = json!({ "test_building": 0 });
        base["constructionAutomation"] = json!({
            "enabled": true,
            "targetStock": { "test_building": 1 },
            "cursor": 0,
            "totalCrafted": 0,
            "lastCraftedId": null,
            "destroyedByproducts": {},
            "jobs": {},
            "quantumSourceEnabled": false,
            "quantumMaterialBuffer": {}
        });
        fixture_state_from_parts(
            base,
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
                    "id": "construction-center",
                    "kind": "machine",
                    "planetId": "home",
                    "powerGridId": "grid-a",
                    "buildingId": "construction_center",
                    "machineCount": 1,
                    "minerCount": 0,
                    "inputs": {},
                    "outputs": {},
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

    #[test]
    fn settlement_snapshot_counts_owned_stores_once_and_replaces_route_reservations() {
        let mut base = powered_fixture_base(15.0, "infinite");
        base["tray"] = json!({ "iron_ore": 10 });
        base["planetTrays"] = json!({
            "home": { "iron_ore": 10 },
            "other": { "iron_ore": 20 }
        });
        base["construction"] = json!({ "iron_ore": 3 });
        base["portableFleet"] = json!({ "iron_ore": 4 });
        base["cargo"] = json!({ "itemId": "iron_ore", "amount": 14 });
        base["quantumLogisticsNetwork"]["inventory"] = json!({ "iron_ore": 5 });
        base["constructionAutomation"]["jobs"] = json!({
            "job": { "inventory": { "iron_ore": 6 } }
        });
        base["constructionAutomation"]["quantumMaterialBuffer"] = json!({
            "controller": { "iron_ore": 7 }
        });
        base["constructionQueue"] = json!([{
            "id": "queue",
            "reservedConstruction": { "iron_ore": 8 },
            "reservedFleet": { "iron_ore": 9 }
        }]);
        base["systemSpaceStations"] = json!({
            "helios": {
                "inventory": { "iron_ore": 11 },
                "constructionBuffer": { "iron_ore": 12 },
                "delivered": {}
            }
        });
        base["endgame"]["constructionActivity"]["pendingBatches"] = json!({
            "iron_ore": { "id": "batch", "itemId": "iron_ore", "amount": 13 }
        });
        base["endgame"]["constructionActivity"]["personalDelivered"] = json!({});

        let state = fixture_state_from_parts(
            base,
            vec![
                json!({
                    "id": "vein",
                    "kind": "vein",
                    "planetId": "home",
                    "resourceId": "iron_ore",
                    "extractorBuildingId": "mining_machine",
                    "minerCount": 1,
                    "inputs": {},
                    "outputs": { "iron_ore": 100 }
                }),
                json!({
                    "id": "controller",
                    "kind": "machine",
                    "planetId": "home",
                    "buildingId": "time_warp_device",
                    "machineCount": 1,
                    "inputs": { "iron_ore": 2 },
                    "outputs": {},
                    "stationRoutes": [{
                        "id": "route",
                        "peerId": "vein",
                        "itemId": "iron_ore",
                        "cargo": 30
                    }]
                }),
            ],
        );
        let snapshot = capture_settlement_snapshot(&state).unwrap();

        // 10 active tray + 20 other planet + 3 construction + 4 portable +
        // 14 cargo + 5 quantum + 6 job WIP + 7 direct quantum + 8/9 queue +
        // 11/12 system station + 13 activity + 100 source output + 2 input.
        // The active planet duplicate is skipped and route cargo replaces its
        // source reservation, so neither adds another 10/30.
        assert_eq!(snapshot.owned.get("iron_ore"), Some(&224));
    }

    #[test]
    fn exact_pure_idle_prefix_commits_legitimate_construction_output() {
        let mut state = construction_powered_fixture();
        let revision = state.revision;
        let result = advance(&mut state, &pure_idle_request(revision, 6.0, 0.4)).unwrap();

        assert!(result.supported, "unexpected reason: {:?}", result.reason);
        assert_eq!(
            state.base_value()["construction"]["test_building"],
            json!(1.0)
        );
        assert_eq!(
            state.base_value()["constructionAutomation"]["totalCrafted"],
            json!(1.0)
        );
        assert_eq!(state.base_value()["tray"]["iron_ore"], json!(9.0));
    }

    #[test]
    fn construction_conversion_credit_is_per_item_bounded_and_excludes_grants() {
        let live = construction_powered_fixture();
        let before = capture_settlement_snapshot(&live).unwrap();

        let mut stock_only = live.clone();
        stock_only.base_value_mut()["construction"]["test_building"] = json!(1);
        let failure = prove_settlement_candidate(&before, stock_only).unwrap_err();
        assert!(
            failure.contains("construction/fleet transformation 1 exceeds totalCrafted delta 0")
        );

        let mut over_credit = live.clone();
        over_credit.base_value_mut()["construction"]["test_building"] = json!(2);
        over_credit.base_value_mut()["constructionAutomation"]["totalCrafted"] = json!(1);
        let failure = prove_settlement_candidate(&before, over_credit).unwrap_err();
        assert!(
            failure.contains("construction/fleet transformation 2 exceeds totalCrafted delta 1")
        );

        // A forged totalCrafted counter is not a fungible source for ordinary
        // tray material; credit is derived only from an aggregate deficit for
        // an item represented in the construction or portable-fleet domain.
        let mut forged_counter = live.clone();
        forged_counter.base_value_mut()["constructionAutomation"]["totalCrafted"] = json!(100);
        forged_counter.base_value_mut()["tray"]["iron_ore"] = json!(11);
        forged_counter.base_value_mut()["planetTrays"]["home"]["iron_ore"] = json!(11);
        let failure = prove_settlement_candidate(&before, forged_counter).unwrap_err();
        assert!(failure.contains("iron_ore stock plus known consumption"));

        // Audited campaign rewards explain construction stock without
        // consuming the construction completion budget.
        let mut rewarded = live;
        rewarded.base_value_mut()["campaign"]["rewardedTaskIds"] = json!(["mine_first_ore"]);
        rewarded.base_value_mut()["construction"]["conveyor_belt_mk1"] = json!(2);
        assert!(prove_settlement_candidate(&before, rewarded).is_ok());
    }

    #[test]
    fn construction_conversion_requires_recipe_input_consumption() {
        let live = construction_powered_fixture();
        let before = capture_settlement_snapshot(&live).unwrap();
        let mut forged = live.clone();
        forged.base_value_mut()["construction"]["test_building"] = json!(1);
        forged.base_value_mut()["constructionAutomation"]["totalCrafted"] = json!(1);

        let failure = prove_settlement_candidate(&before, forged).unwrap_err();
        assert!(failure.contains("construction recipe input"));

        // Even an exact decrease of the catalog cost vector is not sufficient
        // at the untrusted aggregate boundary: an unrelated ordinary machine
        // could have consumed the same item during the window. Only the
        // private receipt issued by the native exact stage can bind that loss
        // to construction.
        let mut coincidental_consumption = live;
        coincidental_consumption.base_value_mut()["tray"]["iron_ore"] = json!(9);
        coincidental_consumption.base_value_mut()["planetTrays"]["home"]["iron_ore"] = json!(9);
        coincidental_consumption.base_value_mut()["construction"]["test_building"] = json!(1);
        coincidental_consumption.base_value_mut()["constructionAutomation"]["totalCrafted"] =
            json!(1);
        let failure = prove_settlement_candidate(&before, coincidental_consumption).unwrap_err();
        assert!(failure.contains("construction recipe input receipt is missing"));
    }

    #[test]
    fn internal_construction_receipt_deducts_audited_same_window_rewards() {
        let live = construction_powered_fixture();
        let before = capture_settlement_snapshot(&live).unwrap();
        let mut candidate = live;
        candidate.base_value_mut()["tray"]["iron_ore"] = json!(9);
        candidate.base_value_mut()["planetTrays"]["home"]["iron_ore"] = json!(9);
        candidate.base_value_mut()["construction"]["test_building"] = json!(1);
        candidate.base_value_mut()["construction"]["conveyor_belt_mk1"] = json!(2);
        candidate.base_value_mut()["constructionAutomation"]["totalCrafted"] = json!(1);
        candidate.base_value_mut()["campaign"]["rewardedTaskIds"] = json!(["mine_first_ore"]);

        let candidate = prove_internal_exact_settlement_candidate(&before, candidate).unwrap();
        assert_eq!(
            candidate.base_value()["construction"]["test_building"],
            json!(1)
        );
        assert_eq!(
            candidate.base_value()["construction"]["conveyor_belt_mk1"],
            json!(2)
        );
        assert_eq!(
            candidate.base_value()["constructionAutomation"]["totalCrafted"],
            json!(1)
        );
    }

    #[test]
    fn internal_construction_receipt_credits_quantum_final_material_consumption() {
        let mut live = construction_powered_fixture();
        live.base_value_mut()["tray"]["iron_ore"] = json!(0);
        live.base_value_mut()["planetTrays"]["home"]["iron_ore"] = json!(0);
        live.base_value_mut()["quantumLogisticsNetwork"]["inventory"] = json!({ "iron_ore": "1" });
        let before = capture_settlement_snapshot(&live).unwrap();
        let mut candidate = live;
        candidate.base_value_mut()["quantumLogisticsNetwork"]["inventory"]["iron_ore"] = json!("0");
        candidate.base_value_mut()["construction"]["test_building"] = json!(1);
        candidate.base_value_mut()["constructionAutomation"]["totalCrafted"] = json!(1);

        assert!(prove_internal_exact_settlement_candidate(&before, candidate).is_ok());
    }

    #[test]
    fn internal_construction_receipt_accepts_consumed_cross_bucket_fleet_wip() {
        let mut live = construction_powered_fixture();
        live.base_value_mut()["constructionAutomation"]["jobs"]["center"] = json!({
            "constructionId": "logistics_vessel",
            "steps": [{ "kind": "fleet", "itemId": "logistics_vessel", "amount": 1 }],
            "stepIndex": 0,
            "elapsedSeconds": 0,
            "inventory": { "logistics_vessel": 1 }
        });
        let before = capture_settlement_snapshot(&live).unwrap();

        let mut candidate = live.clone();
        candidate.base_value_mut()["constructionAutomation"]["jobs"] = json!({});
        candidate.base_value_mut()["portableFleet"]["logistics_vessel"] = json!(1);
        candidate.base_value_mut()["constructionAutomation"]["totalCrafted"] = json!(1);
        assert!(prove_internal_exact_settlement_candidate(&before, candidate).is_ok());

        // WIP disappearing without the corresponding portable-fleet receipt
        // is not a construction completion source, even on the trusted exact
        // candidate path.
        let mut vanished = live.clone();
        vanished.base_value_mut()["constructionAutomation"]["jobs"] = json!({});
        vanished.base_value_mut()["constructionAutomation"]["totalCrafted"] = json!(1);
        let failure = prove_internal_exact_settlement_candidate(&before, vanished).unwrap_err();
        assert!(failure.contains("construction recipe input cannot prove"));

        // The same serialized before/after transfer remains untrusted without
        // the module-private receipt, even though its stores look exactly like
        // a legal completion.
        let mut forged = live;
        forged.base_value_mut()["constructionAutomation"]["jobs"] = json!({});
        forged.base_value_mut()["portableFleet"]["logistics_vessel"] = json!(1);
        forged.base_value_mut()["constructionAutomation"]["totalCrafted"] = json!(1);
        let failure = prove_settlement_candidate(&before, forged).unwrap_err();
        assert!(failure.contains("construction recipe input receipt is missing"));
    }

    #[test]
    fn construction_wip_refund_is_an_owned_inventory_transfer_not_manufacturing() {
        let mut live = construction_powered_fixture();
        live.base_value_mut()["constructionAutomation"]["jobs"]["transfer"] = json!({
            "constructionId": "test_building",
            "steps": [],
            "stepIndex": 0,
            "elapsedSeconds": 0,
            "inventory": { "logistics_drone": 5 }
        });
        let before = capture_settlement_snapshot(&live).unwrap();

        // This is the same semantic fixture as the TypeScript gate: refunding
        // already-owned WIP into portableFleet changes the local output store,
        // but aggregate ownership is unchanged and totalCrafted stays at zero.
        let mut transferred = live;
        transferred.base_value_mut()["constructionAutomation"]["jobs"]["transfer"]["inventory"] =
            json!({});
        transferred.base_value_mut()["portableFleet"]["logistics_drone"] = json!(5);

        assert!(prove_settlement_candidate(&before, transferred).is_ok());
    }

    #[test]
    fn settlement_proof_accepts_rocket_launch_backed_by_old_inventory() {
        let mut live = productive_powered_fixture(15.0, "infinite");
        live.base_value_mut()["tray"] = json!({ "small_carrier_rocket": 100 });
        live.base_value_mut()["planetTrays"]["home"] = json!({ "small_carrier_rocket": 100 });
        // Historical absolute values are never rewritten or required to be
        // equal. Only the adjacent candidate delta must close.
        live.base_value_mut()["dysonSphere"]["totalRocketsLaunched"] = json!(1000);
        live.base_value_mut()["dysonSphere"]["structurePoints"] = json!(800);
        live.base_value_mut()["dysonPlans"]["helios"]["structurePoints"] = json!(800);
        let before = capture_settlement_snapshot(&live).unwrap();
        let mut candidate = live.clone();
        candidate.base_value_mut()["tray"][TERMINAL_ROCKET_ITEM_ID] = json!(60);
        candidate.base_value_mut()["planetTrays"]["home"][TERMINAL_ROCKET_ITEM_ID] = json!(60);
        candidate.base_value_mut()["dysonSphere"]["totalRocketsLaunched"] = json!(1040);
        candidate.base_value_mut()["dysonSphere"]["structurePoints"] = json!(840);
        candidate.base_value_mut()["dysonPlans"]["helios"]["structurePoints"] = json!(840);

        let candidate = prove_settlement_candidate(&before, candidate).unwrap();
        assert_eq!(
            candidate.base_value()["dysonSphere"]["totalRocketsLaunched"],
            json!(1040)
        );
        assert_eq!(
            live.base_value()["dysonSphere"]["totalRocketsLaunched"],
            json!(1000)
        );
    }

    #[test]
    fn settlement_proof_closes_sail_flow_and_prevents_terminal_double_spend() {
        let mut live = productive_powered_fixture(15.0, "infinite");
        live.base_value_mut()["tray"] = json!({ "solar_sail": 20 });
        live.base_value_mut()["planetTrays"]["home"] = json!({ "solar_sail": 20 });
        let before = capture_settlement_snapshot(&live).unwrap();
        let mut sail_candidate = live.clone();
        sail_candidate.base_value_mut()["tray"][TERMINAL_SAIL_ITEM_ID] = json!(10);
        sail_candidate.base_value_mut()["planetTrays"]["home"][TERMINAL_SAIL_ITEM_ID] = json!(10);
        sail_candidate.base_value_mut()["dysonSwarm"]["totalLaunched"] = json!(10);
        sail_candidate.base_value_mut()["dysonSwarm"]["sailsInOrbit"] = json!(6);
        sail_candidate.base_value_mut()["dysonSwarm"]["totalExpired"] = json!(2);
        sail_candidate.base_value_mut()["dysonSphere"]["totalSailsAbsorbed"] = json!(2);
        sail_candidate.base_value_mut()["dysonSphere"]["shellSails"] = json!(2);
        sail_candidate.base_value_mut()["dysonPlans"]["helios"]["shellSails"] = json!(2);
        sail_candidate.base_value_mut()["dysonEngineering"]["orbitsBySystem"]["helios"][0]["sailsInOrbit"] =
            json!(6);
        sail_candidate.base_value_mut()["dysonEngineering"]["orbitsBySystem"]["helios"][0]["totalLaunched"] =
            json!(10);
        sail_candidate.base_value_mut()["dysonEngineering"]["orbitsBySystem"]["helios"][0]["totalExpired"] =
            json!(2);
        assert!(prove_settlement_candidate(&before, sail_candidate).is_ok());

        let mut rocket_live = productive_powered_fixture(15.0, "infinite");
        rocket_live.base_value_mut()["tray"] = json!({ "small_carrier_rocket": 100 });
        rocket_live.base_value_mut()["planetTrays"]["home"] =
            json!({ "small_carrier_rocket": 100 });
        let before = capture_settlement_snapshot(&rocket_live).unwrap();
        let mut double_spend = rocket_live;
        double_spend.base_value_mut()["tray"][TERMINAL_ROCKET_ITEM_ID] = json!(0);
        double_spend.base_value_mut()["planetTrays"]["home"][TERMINAL_ROCKET_ITEM_ID] = json!(0);
        double_spend.base_value_mut()["dysonSphere"]["totalRocketsLaunched"] = json!(80);
        double_spend.base_value_mut()["dysonSphere"]["structurePoints"] = json!(80);
        double_spend.base_value_mut()["dysonPlans"]["helios"]["structurePoints"] = json!(80);
        double_spend.base_value_mut()["endgame"]["exportProjects"]["carrier_rocket_fleet"]["totalDelivered"] =
            json!(30);
        let failure = prove_settlement_candidate(&before, double_spend).unwrap_err();
        assert!(failure.contains(
            "small_carrier_rocket launch plus known consumption 110 exceeds produced/granted/inventory source 100"
        ));
    }

    #[test]
    fn settlement_proof_rejects_material_creation_and_phantom_rockets_atomically() {
        let live = productive_powered_fixture(15.0, "infinite");
        let before_hash = live.summary().unwrap().canonical_sha256;
        let before_revision = live.revision;
        let before = capture_settlement_snapshot(&live).unwrap();

        let mut invented_stock = live.clone();
        invented_stock.base_value_mut()["tray"] = json!({ "iron_ore": 1 });
        let failure = prove_settlement_candidate(&before, invented_stock).unwrap_err();
        assert!(failure.contains("iron_ore stock plus known consumption"));

        let mut phantom_rocket = live.clone();
        phantom_rocket.base_value_mut()["dysonSphere"]["totalRocketsLaunched"] = json!(100);
        phantom_rocket.base_value_mut()["dysonSphere"]["structurePoints"] = json!(100);
        phantom_rocket.base_value_mut()["dysonPlans"]["helios"]["structurePoints"] = json!(100);
        let failure = prove_settlement_candidate(&before, phantom_rocket).unwrap_err();
        assert!(failure.contains("small_carrier_rocket launch plus known consumption"));

        assert_eq!(live.revision, before_revision);
        assert_eq!(live.summary().unwrap().canonical_sha256, before_hash);
        assert_eq!(
            live.base_value()["dysonSphere"]["totalRocketsLaunched"],
            json!(0)
        );
    }

    #[test]
    fn settlement_proof_rejects_cross_system_structure_mismatch() {
        let live = productive_powered_fixture(15.0, "infinite");
        let before = capture_settlement_snapshot(&live).unwrap();
        let mut candidate = live;
        candidate.base_value_mut()["totalProduced"][TERMINAL_ROCKET_ITEM_ID] = json!(10);
        candidate.base_value_mut()["dysonSphere"]["totalRocketsLaunched"] = json!(10);
        candidate.base_value_mut()["dysonSphere"]["structurePoints"] = json!(10);
        candidate.base_value_mut()["dysonPlans"]["helios"]["structurePoints"] = json!(9);

        let failure = prove_settlement_candidate(&before, candidate).unwrap_err();
        assert!(
            failure
                .contains("per-system structure delta 9 does not equal global structure delta 10")
        );
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
