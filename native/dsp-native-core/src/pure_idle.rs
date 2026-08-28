use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use anyhow::{anyhow, bail};
use serde_json::{Number, Value};

use crate::simulation::{CoreAdvanceMode, CoreAdvanceRequest, CoreAdvanceResult};
use crate::state::{CoreState, PURE_IDLE_SESSION_EXACT_CREDIT_SECONDS};

const ALGORITHM_VERSION: &str =
    "native-pure-idle-conservative-v4-session-bounded-30s-settlement-proof-v1";
const MACRO_V10_ALGORITHM_VERSION: &str =
    "native-pure-idle-macro-v10-three-window-closed-recipe-research-dyson-terminal-v8";
const MACRO_V10_CALIBRATION_WINDOW_SECONDS: f64 = 10.0;
const MICROS_PER_SECOND: i128 = 1_000_000;
const DYSON_ROCKET_LAUNCH_ENERGY_MICRO_MJ: i128 = 108_000_000;
const DEFAULT_QUANTUM_ITEM_CAPACITY: i128 = 10_000_000_000;
const MAX_ADVANCE_SECONDS: f64 = 30.0 * 24.0 * 60.0 * 60.0;
const EPSILON: f64 = 0.000_001;
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;
const TERMINAL_ROCKET_ITEM_ID: &str = "small_carrier_rocket";
const TERMINAL_SAIL_ITEM_ID: &str = "solar_sail";

type MaterialTotals = BTreeMap<String, i128>;
type OrbitMaterialTotals = BTreeMap<String, MaterialTotals>;

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
    orbit_sails_by_orbit: OrbitMaterialTotals,
    orbit_launched_by_orbit: OrbitMaterialTotals,
    orbit_expired_by_orbit: OrbitMaterialTotals,
    launch_energy_micro_mj: i128,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct InfiniteResearchProgressSnapshot {
    level: u32,
    progress: i128,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct ResearchLabProofSnapshot {
    entity_id: String,
    planet_id: String,
    power_grid_id: String,
    building_id: String,
    machine_count: i128,
    progress_micros: i128,
    input_item_ids: Vec<String>,
    output_item_ids: Vec<String>,
    spray_coater_installed: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct ResearchProofSnapshot {
    selected_technology_id: Option<String>,
    queued_technology_ids: Vec<String>,
    completed_technology_ids: Vec<String>,
    finite_progress: BTreeMap<String, MaterialTotals>,
    active_infinite_research_id: Option<String>,
    auto_research: bool,
    infinite_progress: BTreeMap<String, InfiniteResearchProgressSnapshot>,
    galactic_score: i128,
    labs: Vec<ResearchLabProofSnapshot>,
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
    research: ResearchProofSnapshot,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum ResearchSinkKind {
    Finite {
        technology_id: String,
        costs: MaterialTotals,
    },
    Infinite {
        research_id: String,
        level: u32,
        level_cost: i128,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ResearchSinkCertificate {
    kind: ResearchSinkKind,
    consumed_units_per_second: MaterialTotals,
    expected: ResearchProofSnapshot,
}

/// A material-funded rocket terminal receipt. Each rate is a whole rocket per
/// simulated second and is observed identically in three adjacent exact
/// windows. Rocket and sail terminals remain mutually exclusive certificates.
#[derive(Debug, Clone, PartialEq, Eq)]
struct DysonRocketSinkCertificate {
    launches_per_second: i128,
    launches_per_second_by_system: MaterialTotals,
    expected: DysonTerminalSnapshot,
}

/// A same-window-funded solar-sail launch schedule. Unlike the old scalar
/// extrapolation this certificate contains only whole launch rates observed
/// identically in three adjacent exact windows. The Dyson helper advances
/// absorption and decay from the current orbit state for every scheduled
/// second, so no prefilled ejector cache is replayed and no sail lifecycle
/// counter is copied from a probe.
#[derive(Debug, Clone, PartialEq, Eq)]
struct DysonSailSinkCertificate {
    launches_per_second: i128,
    launches_per_second_by_orbit: OrbitMaterialTotals,
    expected: DysonTerminalSnapshot,
}

/// A deliberately narrow productive contract. Every admitted item is an
/// exclusive infinite-vein output whose aggregate owned-stock increase equals
/// its cumulative production increase in each of three adjacent ten-second
/// exact windows. Rates are whole units per simulated second, so applying them
/// over the absolute microsecond clock is deterministic across request splits
/// without a persisted fractional remainder.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct OrdinaryFlowCertificate {
    /// Persisted ownership delta. Kept as the primary write vector so the
    /// source-only v2 path remains a strict subset of the closed recipe path.
    units_per_second: MaterialTotals,
    /// Gross cumulative production credited per simulated second.
    produced_units_per_second: MaterialTotals,
    /// Inferred internal recipe consumption per simulated second. GameState
    /// v47 has no persisted totalConsumed map; this remains runtime proof.
    consumed_units_per_second: MaterialTotals,
    /// Active ordinary recipes in first-seen entity order. An empty vector is
    /// the legacy source-only proof; non-empty means the complete acyclic
    /// recipe domain was closed without reordering any persisted entity.
    recipe_ids: Vec<String>,
    /// Optional material-consuming terminal. It may advance only the exact
    /// current finite technology or infinite-research level and never crosses
    /// the completion/reward/switch boundary represented by this certificate.
    research: Option<ResearchSinkCertificate>,
    /// Optional closed rocket terminal. Its launch rate is charged as
    /// ordinary consumption of `small_carrier_rocket`; no starting inventory
    /// or launcher cache is credited as a renewable tail source.
    dyson_rocket: Option<DysonRocketSinkCertificate>,
    /// Optional closed solar-sail terminal. Only the calibrated launch vector
    /// is extrapolated; orbit decay and shell absorption are advanced by the
    /// native Dyson lifecycle from the committed endpoint.
    dyson_sail: Option<DysonSailSinkCertificate>,
}

/// Runtime acceleration for a continuous macro-v10 session. This cache never
/// enters GameState v47, the private checkpoint manifest, or canonical hashes.
/// A missing cache is safe: the tail rebuilds the same certificate with a
/// disposable three-window probe before authorizing material changes.
#[derive(Debug, Clone, Default)]
pub(crate) struct PureIdleMacroRuntimeCache {
    last_committed_revision: u64,
    calibration_snapshots: Vec<SettlementProofSnapshot>,
    certificate: Option<OrdinaryFlowCertificate>,
    rejection_reason: Option<String>,
}

impl PureIdleMacroRuntimeCache {
    fn starts_at(revision: u64, snapshot: SettlementProofSnapshot) -> Self {
        Self {
            last_committed_revision: revision,
            calibration_snapshots: vec![snapshot],
            certificate: None,
            rejection_reason: None,
        }
    }

    fn missing_prefix(revision: u64) -> Self {
        Self {
            last_committed_revision: revision,
            calibration_snapshots: Vec::new(),
            certificate: None,
            rejection_reason: Some(
                "runtime calibration cache was unavailable; a disposable three-window probe is required"
                    .to_owned(),
            ),
        }
    }
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
        algorithm_version: Some(algorithm_version(request.advance_mode)),
        exact_calibration_seconds: Some(0.0),
        approximated_seconds: Some(0.0),
        belt_scheduler: None,
        summary: request
            .include_diagnostics
            .then(|| state.summary())
            .transpose()?,
    })
}

fn algorithm_version(mode: CoreAdvanceMode) -> &'static str {
    match mode {
        CoreAdvanceMode::PureIdleMacroV10 => MACRO_V10_ALGORITHM_VERSION,
        CoreAdvanceMode::Exact | CoreAdvanceMode::PureIdleConservativeV2 => ALGORITHM_VERSION,
    }
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
    let engineering = base.get("dysonEngineering");
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
        launch_energy_micro_mj: proof_fixed_micros(
            engineering
                .and_then(Value::as_object)
                .and_then(|object| object.get("launchEnergySpentMj")),
            "dysonEngineering.launchEnergySpentMj",
        )?,
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
            let mut stock_by_orbit = MaterialTotals::new();
            let mut launched_by_orbit = MaterialTotals::new();
            let mut expired_by_orbit = MaterialTotals::new();
            for (orbit_index, orbit) in orbits.iter().enumerate() {
                let orbit_id = orbit
                    .get("id")
                    .and_then(Value::as_str)
                    .filter(|id| !id.is_empty())
                    .ok_or_else(|| {
                        anyhow!(
                            "dysonEngineering.orbitsBySystem.{system_id}.{orbit_index}.id is missing"
                        )
                    })?;
                if stock_by_orbit.contains_key(orbit_id) {
                    bail!("dysonEngineering.orbitsBySystem.{system_id} repeats orbit {orbit_id}");
                }
                let orbit_stock = counter_at(
                    Some(orbit),
                    "sailsInOrbit",
                    &format!(
                        "dysonEngineering.orbitsBySystem.{system_id}.{orbit_index}.sailsInOrbit"
                    ),
                )?;
                let orbit_launched = counter_at(
                    Some(orbit),
                    "totalLaunched",
                    &format!(
                        "dysonEngineering.orbitsBySystem.{system_id}.{orbit_index}.totalLaunched"
                    ),
                )?;
                let orbit_expired = counter_at(
                    Some(orbit),
                    "totalExpired",
                    &format!(
                        "dysonEngineering.orbitsBySystem.{system_id}.{orbit_index}.totalExpired"
                    ),
                )?;
                stock = stock
                    .checked_add(orbit_stock)
                    .ok_or_else(|| anyhow!("Dyson orbit stock proof ledger overflow"))?;
                launched = launched
                    .checked_add(orbit_launched)
                    .ok_or_else(|| anyhow!("Dyson orbit launch proof ledger overflow"))?;
                expired = expired
                    .checked_add(orbit_expired)
                    .ok_or_else(|| anyhow!("Dyson orbit expiry proof ledger overflow"))?;
                stock_by_orbit.insert(orbit_id.to_owned(), orbit_stock);
                launched_by_orbit.insert(orbit_id.to_owned(), orbit_launched);
                expired_by_orbit.insert(orbit_id.to_owned(), orbit_expired);
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
            snapshot
                .orbit_sails_by_orbit
                .insert(system_id.clone(), stock_by_orbit);
            snapshot
                .orbit_launched_by_orbit
                .insert(system_id.clone(), launched_by_orbit);
            snapshot
                .orbit_expired_by_orbit
                .insert(system_id.clone(), expired_by_orbit);
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

fn proof_optional_string(value: Option<&Value>, label: &str) -> anyhow::Result<Option<String>> {
    let Some(value) = value else {
        return Ok(None);
    };
    if value.is_null() {
        return Ok(None);
    }
    let value = value
        .as_str()
        .ok_or_else(|| anyhow!("{label} is not a string or null"))?;
    if value.is_empty() {
        bail!("{label} is an empty identifier");
    }
    Ok(Some(value.to_owned()))
}

fn proof_string_array(value: Option<&Value>, label: &str) -> anyhow::Result<Vec<String>> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    if value.is_null() {
        return Ok(Vec::new());
    }
    value
        .as_array()
        .ok_or_else(|| anyhow!("{label} is not an array"))?
        .iter()
        .enumerate()
        .map(|(index, value)| {
            value
                .as_str()
                .filter(|value| !value.is_empty())
                .map(str::to_owned)
                .ok_or_else(|| anyhow!("{label}.{index} is not a non-empty identifier"))
        })
        .collect()
}

fn proof_fixed_micros(value: Option<&Value>, label: &str) -> anyhow::Result<i128> {
    let value = value.and_then(Value::as_f64).unwrap_or(0.0);
    if !value.is_finite() || !(0.0..=MAX_SAFE_INTEGER).contains(&value) {
        bail!("{label} is not a finite non-negative number");
    }
    let scaled = value * MICROS_PER_SECOND as f64;
    let rounded = scaled.round();
    if !scaled.is_finite() || (scaled - rounded).abs() > EPSILON * scaled.abs().max(1.0) {
        bail!("{label} is not representable at microsecond precision");
    }
    Ok(rounded as i128)
}

fn capture_research_proof_snapshot(state: &CoreState) -> anyhow::Result<ResearchProofSnapshot> {
    let base = state.base_value();
    let research = base
        .get("research")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("research is not an object"))?;
    let endgame = base
        .get("endgame")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("endgame is not an object"))?;

    let mut finite_progress = BTreeMap::new();
    if let Some(progress) = research.get("progressByTech")
        && !progress.is_null()
    {
        for (technology_id, by_item) in progress
            .as_object()
            .ok_or_else(|| anyhow!("research.progressByTech is not an object"))?
        {
            let by_item = by_item.as_object().ok_or_else(|| {
                anyhow!("research.progressByTech.{technology_id} is not an object")
            })?;
            let mut captured = MaterialTotals::new();
            for (item_id, amount) in by_item {
                captured.insert(
                    item_id.clone(),
                    proof_counter(
                        Some(amount),
                        &format!("research.progressByTech.{technology_id}.{item_id}"),
                    )?,
                );
            }
            finite_progress.insert(technology_id.clone(), captured);
        }
    }

    let mut infinite_progress = BTreeMap::new();
    if let Some(progress) = endgame.get("infiniteResearch")
        && !progress.is_null()
    {
        for (research_id, entry) in progress
            .as_object()
            .ok_or_else(|| anyhow!("endgame.infiniteResearch is not an object"))?
        {
            let entry = entry.as_object().ok_or_else(|| {
                anyhow!("endgame.infiniteResearch.{research_id} is not an object")
            })?;
            let level = proof_counter(
                entry.get("level"),
                &format!("endgame.infiniteResearch.{research_id}.level"),
            )?;
            infinite_progress.insert(
                research_id.clone(),
                InfiniteResearchProgressSnapshot {
                    level: u32::try_from(level).map_err(|_| {
                        anyhow!("endgame.infiniteResearch.{research_id}.level exceeds u32")
                    })?,
                    progress: proof_counter(
                        entry.get("progress"),
                        &format!("endgame.infiniteResearch.{research_id}.progress"),
                    )?,
                },
            );
        }
    }

    let mut labs = Vec::new();
    for entity_index in 0..state.entity_index.len() {
        let entity = state.parse_entity(entity_index)?;
        if entity.get("recipeId").and_then(Value::as_str) != Some("matrix_research")
            || number_at(Some(&entity), &["machineCount"]) <= EPSILON
        {
            continue;
        }
        let required_id = |key: &str| -> anyhow::Result<String> {
            entity
                .get(key)
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .map(str::to_owned)
                .ok_or_else(|| anyhow!("active research lab is missing {key}"))
        };
        let item_ids = |key: &str| -> anyhow::Result<Vec<String>> {
            let values = entity
                .get(key)
                .and_then(Value::as_object)
                .ok_or_else(|| anyhow!("active research lab {key} is not an object"))?;
            Ok(values.keys().cloned().collect())
        };
        labs.push(ResearchLabProofSnapshot {
            entity_id: required_id("id")?,
            planet_id: required_id("planetId")?,
            power_grid_id: required_id("powerGridId")?,
            building_id: required_id("buildingId")?,
            machine_count: proof_counter(entity.get("machineCount"), "researchLab.machineCount")?,
            progress_micros: proof_fixed_micros(entity.get("progress"), "researchLab.progress")?,
            input_item_ids: item_ids("inputs")?,
            output_item_ids: item_ids("outputs")?,
            spray_coater_installed: entity
                .get("sprayCoaterInstalled")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        });
    }

    Ok(ResearchProofSnapshot {
        selected_technology_id: proof_optional_string(
            research.get("selectedTechId"),
            "research.selectedTechId",
        )?,
        queued_technology_ids: proof_string_array(
            research.get("queuedTechIds"),
            "research.queuedTechIds",
        )?,
        completed_technology_ids: proof_string_array(
            research.get("completedTechIds"),
            "research.completedTechIds",
        )?,
        finite_progress,
        active_infinite_research_id: proof_optional_string(
            endgame.get("activeInfiniteResearchId"),
            "endgame.activeInfiniteResearchId",
        )?,
        auto_research: endgame
            .get("autoResearch")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        infinite_progress,
        galactic_score: proof_counter(endgame.get("galacticScore"), "endgame.galacticScore")?,
        labs,
    })
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
        research: capture_research_proof_snapshot(state)?,
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

fn validate_internal_exact_snapshots(
    before: &SettlementProofSnapshot,
    after: &SettlementProofSnapshot,
    catalog: &crate::catalog::RuntimeCatalog,
) -> Result<(), String> {
    let construction = capture_construction_conversion_ledger(before, after)?;
    validate_construction_recipe_conversion(&construction, catalog, None, true)?;
    let receipt = ConstructionRecipeReceipt {
        outputs: construction.transformations.clone(),
        crafted: construction.crafted,
    };
    validate_settlement_proof(before, after, catalog, Some(&receipt))
}

fn checked_material_delta(
    before: &MaterialTotals,
    after: &MaterialTotals,
    item_id: &str,
    label: &str,
) -> Result<i128, String> {
    after
        .get(item_id)
        .copied()
        .unwrap_or(0)
        .checked_sub(before.get(item_id).copied().unwrap_or(0))
        .ok_or_else(|| format!("{label}.{item_id} delta overflowed"))
}

fn exclusive_infinite_vein_sources(state: &CoreState) -> Result<BTreeSet<String>, String> {
    if state
        .base_value()
        .get("settings")
        .and_then(Value::as_object)
        .and_then(|settings| settings.get("resourceMode"))
        .and_then(Value::as_str)
        != Some("infinite")
    {
        return Err(
            "finite resources have no native depletion horizon certificate; ordinary-flow tail is frozen"
                .to_owned(),
        );
    }

    // Material-fuel generators and charge/discharge stores can make a short
    // window productive by spending a finite cache. Their energy budget is not
    // represented in the material snapshot, so none may back this certificate.
    for &entity_index in &state.factory_topology.power_source_indices {
        let entity = state
            .parse_entity(entity_index)
            .map_err(|error| format!("power source decode failed: {error:#}"))?;
        let building_id = entity
            .get("buildingId")
            .and_then(Value::as_str)
            .ok_or_else(|| "power source has no building ID".to_owned())?;
        let building = state
            .catalog
            .buildings
            .get(building_id)
            .ok_or_else(|| format!("power source {building_id} is absent from the catalog"))?;
        if !building.fuel_item_ids.is_empty()
            || building.energy_capacity_mj > EPSILON
            || building.power_charge_kw > EPSILON
        {
            return Err(format!(
                "power source {building_id} depends on fuel or stored energy without a closed tail ledger"
            ));
        }
    }

    let vein_indices = state
        .factory_topology
        .vein_indices
        .iter()
        .copied()
        .collect::<HashSet<_>>();
    let mut sources = BTreeSet::new();
    for &entity_index in &state.factory_topology.vein_indices {
        let entity = state
            .parse_entity(entity_index)
            .map_err(|error| format!("vein decode failed: {error:#}"))?;
        if number_at(Some(&entity), &["minerCount"]) <= EPSILON {
            continue;
        }
        let item_id = entity
            .get("resourceId")
            .and_then(Value::as_str)
            .ok_or_else(|| "active vein has no resource ID".to_owned())?;
        if item_id != TERMINAL_ROCKET_ITEM_ID && item_id != TERMINAL_SAIL_ITEM_ID {
            sources.insert(item_id.to_owned());
        }
    }

    // A source ID must be exclusive to veins. If a machine can also emit the
    // same ID, aggregate totalProduced cannot distinguish mined material from
    // a recipe transformation and is not a sufficient source receipt.
    for entity_index in 0..state.entity_index.len() {
        if vein_indices.contains(&entity_index) {
            continue;
        }
        let entity = state
            .parse_entity(entity_index)
            .map_err(|error| format!("ordinary entity decode failed: {error:#}"))?;
        if let Some(outputs) = entity.get("outputs").and_then(Value::as_object) {
            for item_id in outputs.keys() {
                sources.remove(item_id);
            }
        }
    }
    if sources.is_empty() {
        return Err("no exclusive active infinite-vein source is available".to_owned());
    }
    Ok(sources)
}

fn collection_has_entries(value: Option<&Value>) -> bool {
    value.is_some_and(|value| match value {
        Value::Array(values) => !values.is_empty(),
        Value::Object(values) => !values.is_empty(),
        _ => false,
    })
}

fn active_recipe_tail_exclusion_reason(state: &CoreState) -> Option<String> {
    let base = state.base_value();
    let endgame = base.get("endgame").and_then(Value::as_object);
    if collection_has_entries(base.get("handcraftQueue"))
        || collection_has_entries(base.get("constructionQueue"))
    {
        return Some("handcraft or construction work is active".to_owned());
    }
    let construction = base
        .get("constructionAutomation")
        .and_then(Value::as_object);
    if construction
        .and_then(|construction| construction.get("enabled"))
        .and_then(Value::as_bool)
        == Some(true)
        || collection_has_entries(construction.and_then(|construction| construction.get("jobs")))
        || collection_has_entries(
            construction.and_then(|construction| construction.get("quantumMaterialBuffer")),
        )
    {
        return Some("construction automation is active".to_owned());
    }

    if endgame
        .and_then(|endgame| endgame.get("autoDispatch"))
        .and_then(Value::as_bool)
        == Some(true)
        || endgame
            .and_then(|endgame| endgame.get("exportProjects"))
            .and_then(Value::as_object)
            .is_some_and(|projects| {
                projects.values().any(|project| {
                    project
                        .get("enabled")
                        .and_then(Value::as_bool)
                        .unwrap_or(false)
                })
            })
    {
        return Some("galactic export is active".to_owned());
    }
    if let Some(activity) = endgame
        .and_then(|endgame| endgame.get("constructionActivity"))
        .and_then(Value::as_object)
        && (activity
            .get("activityId")
            .and_then(Value::as_str)
            .is_some_and(|id| !id.is_empty())
            || collection_has_entries(activity.get("pendingBatches")))
    {
        return Some("galactic construction delivery is active".to_owned());
    }
    if collection_has_entries(
        base.get("orbitalStation")
            .and_then(Value::as_object)
            .and_then(|station| station.get("contractBoard"))
            .and_then(Value::as_object)
            .and_then(|board| board.get("accepted")),
    ) {
        return Some("orbital station contract delivery is active".to_owned());
    }
    None
}

fn active_ordinary_recipe_ids(
    state: &CoreState,
    allow_certified_rocket_terminal: bool,
    allow_certified_sail_terminal: bool,
) -> Result<Vec<String>, String> {
    if let Some(reason) = active_recipe_tail_exclusion_reason(state) {
        return Err(format!("ordinary recipe tail is excluded while {reason}"));
    }
    let mut recipe_ids = Vec::new();
    let mut seen_recipe_ids = HashSet::new();
    for entity_index in 0..state.entity_index.len() {
        let entity = state
            .parse_entity(entity_index)
            .map_err(|error| format!("ordinary recipe entity decode failed: {error:#}"))?;
        if number_at(Some(&entity), &["machineCount"]) <= EPSILON {
            continue;
        }
        let entity_output_ids = entity
            .get("outputs")
            .and_then(Value::as_object)
            .map(|outputs| outputs.keys().cloned().collect::<BTreeSet<_>>())
            .unwrap_or_default();
        let Some(recipe_id) = entity.get("recipeId").and_then(Value::as_str) else {
            if !entity_output_ids.is_empty() {
                return Err(format!(
                    "active entity {} is an alternate unmodelled producer for {}",
                    entity
                        .get("id")
                        .and_then(Value::as_str)
                        .unwrap_or("<unknown>"),
                    entity_output_ids.into_iter().collect::<Vec<_>>().join(",")
                ));
            }
            continue;
        };
        if recipe_id.is_empty() {
            if !entity_output_ids.is_empty() {
                return Err(format!(
                    "active entity {} has an empty recipe ID but declares produced materials",
                    entity
                        .get("id")
                        .and_then(Value::as_str)
                        .unwrap_or("<unknown>")
                ));
            }
            continue;
        }
        let recipe = state
            .catalog
            .recipes
            .get(recipe_id)
            .ok_or_else(|| format!("active recipe {recipe_id} is absent from the catalog"))?;
        let building_id = entity
            .get("buildingId")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if building_id != recipe.building_id {
            return Err(format!(
                "active recipe {recipe_id} is installed in incompatible building {building_id}"
            ));
        }
        if recipe_id == "matrix_research" {
            if !recipe.inputs.is_empty() || !recipe.outputs.is_empty() {
                return Err(
                    "matrix_research catalog entry unexpectedly carries a material recipe"
                        .to_owned(),
                );
            }
            if !entity_output_ids.is_empty() {
                return Err("active research lab declares material outputs".to_owned());
            }
            if entity.get("sprayCoaterInstalled").and_then(Value::as_bool) == Some(true) {
                return Err(
                    "active research lab uses proliferator without a closed bonus ledger"
                        .to_owned(),
                );
            }
            continue;
        }
        if recipe_id == "carrier_rocket_launch" {
            if allow_certified_rocket_terminal {
                // The launcher is validated as a terminal event domain by
                // `build_dyson_rocket_sink_certificate`; it is deliberately
                // not inserted into the ordinary recipe DAG because it has no
                // material output.
                continue;
            }
            return Err(
                "active carrier_rocket_launch has no certified Dyson rocket sink".to_owned(),
            );
        }
        if recipe_id == "solar_sail_launch" {
            if allow_certified_sail_terminal {
                // The ejector is validated by the solar-sail terminal
                // certificate and has no ordinary material output.
                continue;
            }
            return Err("active solar_sail_launch has no certified Dyson sail sink".to_owned());
        }
        if recipe.inputs.is_empty() || recipe.outputs.is_empty() {
            return Err(format!(
                "active recipe {recipe_id} is a research or terminal recipe"
            ));
        }
        // A solar sail manufactured as the final output of an ordinary recipe
        // is just owned material until an ejector consumes it. It is therefore
        // safe for the closed DAG to deposit the same-window surplus into the
        // quantum inventory. Any recipe that consumes a sail (including an
        // active launch terminal) remains excluded unless a separate Dyson
        // terminal certificate accounts for that consumption.
        let consumes_sail = recipe
            .inputs
            .iter()
            .any(|input| input.item_id == TERMINAL_SAIL_ITEM_ID);
        let touches_uncertified_rocket =
            recipe.inputs.iter().chain(&recipe.outputs).any(|amount| {
                amount.item_id == TERMINAL_ROCKET_ITEM_ID
                    && (!allow_certified_rocket_terminal
                        || recipe
                            .inputs
                            .iter()
                            .any(|input| input.item_id == TERMINAL_ROCKET_ITEM_ID))
            });
        if consumes_sail || touches_uncertified_rocket {
            return Err(format!(
                "active recipe {recipe_id} touches a Dyson terminal material"
            ));
        }
        if entity.get("sprayCoaterInstalled").and_then(Value::as_bool) == Some(true) {
            return Err(format!(
                "active recipe {recipe_id} uses proliferator without a closed bonus ledger"
            ));
        }
        let recipe_input_ids = recipe
            .inputs
            .iter()
            .map(|input| input.item_id.clone())
            .collect::<BTreeSet<_>>();
        let recipe_output_ids = recipe
            .outputs
            .iter()
            .map(|output| output.item_id.clone())
            .collect::<BTreeSet<_>>();
        let entity_input_ids = entity
            .get("inputs")
            .and_then(Value::as_object)
            .map(|inputs| inputs.keys().cloned().collect::<BTreeSet<_>>())
            .unwrap_or_default();
        if entity_input_ids != recipe_input_ids || entity_output_ids != recipe_output_ids {
            return Err(format!(
                "active recipe {recipe_id} entity slots do not exactly match its catalog material ledger"
            ));
        }
        if seen_recipe_ids.insert(recipe_id.to_owned()) {
            recipe_ids.push(recipe_id.to_owned());
        }
    }
    Ok(recipe_ids)
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct OrdinaryWindowFlow {
    produced_per_second: MaterialTotals,
    consumed_per_second: MaterialTotals,
    net_owned_per_second: MaterialTotals,
}

fn capture_ordinary_window_flow(
    before: &SettlementProofSnapshot,
    after: &SettlementProofSnapshot,
    allow_certified_dyson_terminal: bool,
) -> Result<OrdinaryWindowFlow, String> {
    if !allow_certified_dyson_terminal && before.dyson != after.dyson {
        return Err("Dyson rocket, sail or structure state changed during calibration".to_owned());
    }
    if before.construction_outputs != after.construction_outputs
        || before.construction_fleet_wip != after.construction_fleet_wip
        || before.portable_fleet != after.portable_fleet
        || before.construction_crafted != after.construction_crafted
    {
        return Err("construction or portable-fleet state changed during calibration".to_owned());
    }

    let mut flow = OrdinaryWindowFlow::default();
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
        let produced =
            checked_material_delta(&before.produced, &after.produced, &item_id, "produced")?;
        let net_owned = checked_material_delta(&before.owned, &after.owned, &item_id, "owned")?;
        let terminal_consumed = checked_material_delta(
            &before.consumed,
            &after.consumed,
            &item_id,
            "terminalConsumed",
        )?;
        let granted = checked_material_delta(&before.granted, &after.granted, &item_id, "granted")?;
        if produced < 0 || terminal_consumed < 0 || granted < 0 {
            return Err(format!(
                "{item_id} cumulative calibration counter regressed"
            ));
        }
        if terminal_consumed != 0 {
            return Err(format!(
                "{item_id} had terminal export, destruction or delivery consumption"
            ));
        }
        if granted != 0 {
            return Err(format!(
                "{item_id} received an audited reward during calibration"
            ));
        }
        if net_owned < 0 {
            return Err(format!(
                "{item_id} depleted owned inventory by {} units in a calibration window",
                -net_owned
            ));
        }
        let ordinary_consumed = produced
            .checked_sub(net_owned)
            .ok_or_else(|| format!("{item_id} ordinary consumption overflowed"))?;
        if ordinary_consumed < 0 {
            return Err(format!(
                "{item_id} owned growth {net_owned} exceeds production {produced}"
            ));
        }
        let window_seconds = MACRO_V10_CALIBRATION_WINDOW_SECONDS as i128;
        for (label, value) in [
            ("produced", produced),
            ("consumed", ordinary_consumed),
            ("owned", net_owned),
        ] {
            if value % window_seconds != 0 {
                return Err(format!(
                    "{item_id} {label} flow {value} is not an integer per simulated second"
                ));
            }
        }
        let produced = produced / window_seconds;
        let ordinary_consumed = ordinary_consumed / window_seconds;
        let net_owned = net_owned / window_seconds;
        if produced > 0 {
            flow.produced_per_second.insert(item_id.clone(), produced);
        }
        if ordinary_consumed > 0 {
            flow.consumed_per_second
                .insert(item_id.clone(), ordinary_consumed);
        }
        if net_owned > 0 {
            flow.net_owned_per_second.insert(item_id, net_owned);
        }
    }
    Ok(flow)
}

fn add_catalog_flow_amount(
    totals: &mut MaterialTotals,
    item_id: &str,
    amount: f64,
    label: &str,
) -> Result<(), String> {
    if !amount.is_finite()
        || !(1.0..=MAX_SAFE_INTEGER).contains(&amount)
        || amount.fract().abs() > f64::EPSILON
    {
        return Err(format!("{label} is not a positive safe integer"));
    }
    let current = totals.get(item_id).copied().unwrap_or(0);
    totals.insert(
        item_id.to_owned(),
        current
            .checked_add(amount as i128)
            .ok_or_else(|| format!("{label} aggregate amount overflowed"))?,
    );
    Ok(())
}

fn research_static_state_matches(
    before: &ResearchProofSnapshot,
    after: &ResearchProofSnapshot,
    selected_finite: Option<&str>,
    selected_infinite: Option<&str>,
) -> bool {
    if before.selected_technology_id != after.selected_technology_id
        || before.queued_technology_ids != after.queued_technology_ids
        || before.completed_technology_ids != after.completed_technology_ids
        || before.active_infinite_research_id != after.active_infinite_research_id
        || before.auto_research != after.auto_research
        || before.galactic_score != after.galactic_score
        || before.labs != after.labs
    {
        return false;
    }
    if before
        .finite_progress
        .iter()
        .filter(|(id, _)| Some(id.as_str()) != selected_finite)
        .ne(after
            .finite_progress
            .iter()
            .filter(|(id, _)| Some(id.as_str()) != selected_finite))
    {
        return false;
    }
    before
        .infinite_progress
        .iter()
        .filter(|(id, _)| Some(id.as_str()) != selected_infinite)
        .eq(after
            .infinite_progress
            .iter()
            .filter(|(id, _)| Some(id.as_str()) != selected_infinite))
}

fn validate_research_labs(
    state: &CoreState,
    research: &ResearchProofSnapshot,
    allowed_inputs: &BTreeSet<String>,
) -> Result<(), String> {
    if research.labs.is_empty() {
        return Err("active research has no powered matrix lab".to_owned());
    }
    let recipe = state
        .catalog
        .recipes
        .get("matrix_research")
        .ok_or_else(|| "matrix_research recipe is absent from the catalog".to_owned())?;
    if !recipe.inputs.is_empty() || !recipe.outputs.is_empty() {
        return Err("matrix_research catalog entry is not a terminal sink".to_owned());
    }
    for lab in &research.labs {
        if lab.building_id != recipe.building_id {
            return Err(format!(
                "research lab {} uses incompatible building {}",
                lab.entity_id, lab.building_id
            ));
        }
        if lab.machine_count <= 0 || lab.spray_coater_installed {
            return Err(format!(
                "research lab {} has an uncertified machine or spray configuration",
                lab.entity_id
            ));
        }
        if !lab.output_item_ids.is_empty()
            || lab
                .input_item_ids
                .iter()
                .any(|item_id| !allowed_inputs.contains(item_id))
        {
            return Err(format!(
                "research lab {} exposes material slots outside the current research ledger",
                lab.entity_id
            ));
        }
    }
    Ok(())
}

fn stable_window_rate(deltas: &[i128], label: &str) -> Result<i128, String> {
    if deltas.len() != 3 || deltas.iter().any(|delta| *delta < 0) {
        return Err(format!("{label} regressed during three-window calibration"));
    }
    if deltas.iter().skip(1).any(|delta| delta != &deltas[0]) {
        return Err(format!(
            "{label} was unstable across three calibration windows"
        ));
    }
    let window_seconds = MACRO_V10_CALIBRATION_WINDOW_SECONDS as i128;
    if deltas[0] % window_seconds != 0 {
        return Err(format!(
            "{label} is not an integer rate over the ten-second window"
        ));
    }
    Ok(deltas[0] / window_seconds)
}

fn dyson_sail_state_unchanged(
    before: &DysonTerminalSnapshot,
    after: &DysonTerminalSnapshot,
) -> bool {
    before.sails_launched == after.sails_launched
        && before.sails_expired == after.sails_expired
        && before.sails_in_orbit == after.sails_in_orbit
        && before.sails_absorbed == after.sails_absorbed
        && before.shell_sails == after.shell_sails
        && before.shell_by_system == after.shell_by_system
        && before.orbit_sails_by_system == after.orbit_sails_by_system
        && before.orbit_launched_by_system == after.orbit_launched_by_system
        && before.orbit_expired_by_system == after.orbit_expired_by_system
}

fn validate_certified_rocket_launcher_domain(state: &CoreState) -> Result<(), String> {
    let recipe = state
        .catalog
        .recipes
        .get("carrier_rocket_launch")
        .ok_or_else(|| "carrier_rocket_launch recipe is absent from the catalog".to_owned())?;
    if recipe.building_id != "vertical_launching_silo"
        || !recipe.outputs.is_empty()
        || recipe.inputs.len() != 1
        || recipe.inputs[0].item_id != TERMINAL_ROCKET_ITEM_ID
        || recipe.inputs[0].amount != 1.0
    {
        return Err(
            "carrier_rocket_launch is not the canonical one-rocket terminal sink".to_owned(),
        );
    }
    if crate::dyson::launch_factor(state.base_value(), "carrier_rocket_launch") <= EPSILON {
        return Err("Dyson rocket launch is disabled or throttled to zero".to_owned());
    }

    let mut active_launchers = 0_usize;
    for entity_index in 0..state.entity_index.len() {
        let entity = state
            .parse_entity(entity_index)
            .map_err(|error| format!("Dyson launcher decode failed: {error:#}"))?;
        if number_at(Some(&entity), &["machineCount"]) <= EPSILON {
            continue;
        }
        match entity.get("recipeId").and_then(Value::as_str) {
            Some("solar_sail_launch") => {
                return Err(
                    "solar-sail launch is active; the native rocket certificate freezes every sail domain"
                        .to_owned(),
                );
            }
            Some("carrier_rocket_launch") => {}
            _ => continue,
        }
        if entity.get("buildingId").and_then(Value::as_str) != Some("vertical_launching_silo") {
            return Err(
                "carrier_rocket_launch is installed in an incompatible building".to_owned(),
            );
        }
        if entity.get("sprayCoaterInstalled").and_then(Value::as_bool) == Some(true) {
            return Err(
                "rocket launcher uses proliferator without a closed launch-bonus ledger".to_owned(),
            );
        }
        let inputs = entity
            .get("inputs")
            .and_then(Value::as_object)
            .map(|inputs| inputs.keys().map(String::as_str).collect::<BTreeSet<_>>())
            .unwrap_or_default();
        let outputs = entity
            .get("outputs")
            .and_then(Value::as_object)
            .map(|outputs| outputs.keys().map(String::as_str).collect::<BTreeSet<_>>())
            .unwrap_or_default();
        if inputs != BTreeSet::from([TERMINAL_ROCKET_ITEM_ID]) || !outputs.is_empty() {
            return Err(
                "rocket launcher slots do not match the canonical terminal ledger".to_owned(),
            );
        }
        let planet_id = entity
            .get("planetId")
            .and_then(Value::as_str)
            .ok_or_else(|| "rocket launcher has no planet".to_owned())?;
        let system_id = state
            .catalog
            .planets
            .iter()
            .find(|planet| planet.id == planet_id)
            .map(|planet| planet.system_id.as_str())
            .ok_or_else(|| format!("rocket launcher planet {planet_id} is absent from catalog"))?;
        if state
            .base_value()
            .get("dysonPlans")
            .and_then(Value::as_object)
            .is_none_or(|plans| plans.get(system_id).and_then(Value::as_object).is_none())
        {
            return Err(format!(
                "rocket launcher target system {system_id} has no Dyson plan"
            ));
        }
        active_launchers = active_launchers
            .checked_add(1)
            .ok_or_else(|| "rocket launcher count overflowed".to_owned())?;
    }
    if active_launchers == 0 {
        return Err("calibrated rocket launches have no active vertical silo".to_owned());
    }
    Ok(())
}

fn build_dyson_rocket_sink_certificate(
    state: &CoreState,
    snapshots: &[SettlementProofSnapshot],
) -> Result<Option<DysonRocketSinkCertificate>, String> {
    if snapshots.len() != 4 {
        return Err("Dyson rocket calibration requires four snapshots".to_owned());
    }
    if snapshots
        .windows(2)
        .all(|window| window[0].dyson == window[1].dyson)
    {
        return Ok(None);
    }
    let current = capture_dyson_terminal(state.base_value())
        .map_err(|error| format!("current Dyson terminal state is invalid: {error:#}"))?;
    if current != snapshots[0].dyson && current != snapshots[3].dyson {
        return Err("current Dyson state is not a calibration endpoint".to_owned());
    }

    let mut launch_deltas = Vec::with_capacity(3);
    let mut structure_deltas = Vec::with_capacity(3);
    let mut system_deltas = BTreeMap::<String, Vec<i128>>::new();
    let system_ids = snapshots
        .iter()
        .flat_map(|snapshot| snapshot.dyson.structure_by_system.keys().cloned())
        .collect::<BTreeSet<_>>();
    for window in snapshots.windows(2) {
        let before = &window[0].dyson;
        let after = &window[1].dyson;
        if !dyson_sail_state_unchanged(before, after) {
            return Err(
                "solar-sail launch, orbit, expiry, absorption or shell state changed during rocket calibration"
                    .to_owned(),
            );
        }
        let launched = checked_terminal_delta(
            after.rockets_launched,
            before.rockets_launched,
            "Dyson rocket launch",
        )?;
        let structure = checked_terminal_delta(
            after.structure_points,
            before.structure_points,
            "Dyson structure point",
        )?;
        if launched != structure {
            return Err(format!(
                "Dyson rocket delta {launched} does not equal structure delta {structure}"
            ));
        }
        let energy = checked_terminal_delta(
            after.launch_energy_micro_mj,
            before.launch_energy_micro_mj,
            "Dyson launch-energy",
        )?;
        let expected_energy = launched
            .checked_mul(DYSON_ROCKET_LAUNCH_ENERGY_MICRO_MJ)
            .ok_or_else(|| "Dyson rocket energy calibration overflowed".to_owned())?;
        if energy != expected_energy {
            return Err(format!(
                "Dyson rocket energy delta {energy} does not match {launched} launch event(s)"
            ));
        }

        let mut system_sum = 0_i128;
        for system_id in &system_ids {
            let delta = checked_material_delta(
                &before.structure_by_system,
                &after.structure_by_system,
                system_id,
                "dysonPlans.structurePoints",
            )?;
            if delta < 0 {
                return Err(format!(
                    "dysonPlans.{system_id}.structurePoints regressed during calibration"
                ));
            }
            system_sum = system_sum
                .checked_add(delta)
                .ok_or_else(|| "per-system Dyson structure calibration overflowed".to_owned())?;
            system_deltas
                .entry(system_id.clone())
                .or_default()
                .push(delta);
        }
        if system_sum != structure {
            return Err(format!(
                "per-system structure delta {system_sum} does not equal global structure delta {structure}"
            ));
        }
        launch_deltas.push(launched);
        structure_deltas.push(structure);
    }

    let launches_per_second = stable_window_rate(&launch_deltas, "Dyson rocket launch")?;
    let structure_per_second = stable_window_rate(&structure_deltas, "Dyson structure point")?;
    if launches_per_second != structure_per_second {
        return Err("stable rocket and structure rates diverged".to_owned());
    }
    if launches_per_second == 0 {
        if snapshots
            .windows(2)
            .any(|window| window[0].dyson != window[1].dyson)
        {
            return Err("Dyson state changed without a rocket launch".to_owned());
        }
        return Ok(None);
    }

    validate_certified_rocket_launcher_domain(state)?;
    let mut launches_per_second_by_system = MaterialTotals::new();
    let mut system_rate_sum = 0_i128;
    for (system_id, deltas) in system_deltas {
        let rate = stable_window_rate(&deltas, &format!("dysonPlans.{system_id}.structurePoints"))?;
        if rate > 0 {
            launches_per_second_by_system.insert(system_id, rate);
            system_rate_sum = system_rate_sum
                .checked_add(rate)
                .ok_or_else(|| "per-system rocket rate sum overflowed".to_owned())?;
        }
    }
    if launches_per_second_by_system.is_empty() || system_rate_sum != launches_per_second {
        return Err(format!(
            "per-system rocket rate {system_rate_sum}/s does not close to global rate {launches_per_second}/s"
        ));
    }
    Ok(Some(DysonRocketSinkCertificate {
        launches_per_second,
        launches_per_second_by_system,
        expected: current,
    }))
}

fn orbit_window_delta(
    before: &OrbitMaterialTotals,
    after: &OrbitMaterialTotals,
    label: &str,
    monotonic: bool,
) -> Result<OrbitMaterialTotals, String> {
    if before.keys().ne(after.keys()) {
        return Err(format!(
            "{label} system topology changed during calibration"
        ));
    }
    let mut deltas = OrbitMaterialTotals::new();
    for (system_id, before_orbits) in before {
        let after_orbits = after
            .get(system_id)
            .ok_or_else(|| format!("{label}.{system_id} disappeared"))?;
        if before_orbits.keys().ne(after_orbits.keys()) {
            return Err(format!(
                "{label}.{system_id} orbit topology changed during calibration"
            ));
        }
        let mut system_deltas = MaterialTotals::new();
        for (orbit_id, before_value) in before_orbits {
            let delta = after_orbits
                .get(orbit_id)
                .copied()
                .unwrap_or(0)
                .checked_sub(*before_value)
                .ok_or_else(|| format!("{label}.{system_id}.{orbit_id} delta overflowed"))?;
            if monotonic && delta < 0 {
                return Err(format!(
                    "{label}.{system_id}.{orbit_id} regressed during calibration"
                ));
            }
            system_deltas.insert(orbit_id.clone(), delta);
        }
        deltas.insert(system_id.clone(), system_deltas);
    }
    Ok(deltas)
}

fn validate_certified_sail_launcher_domain(state: &CoreState) -> Result<(), String> {
    let recipe = state
        .catalog
        .recipes
        .get("solar_sail_launch")
        .ok_or_else(|| "solar_sail_launch recipe is absent from the catalog".to_owned())?;
    if recipe.building_id != "em_rail_ejector"
        || !recipe.outputs.is_empty()
        || recipe.inputs.len() != 1
        || recipe.inputs[0].item_id != TERMINAL_SAIL_ITEM_ID
        || recipe.inputs[0].amount != 1.0
    {
        return Err("solar_sail_launch is not the canonical one-sail terminal sink".to_owned());
    }
    if crate::dyson::launch_factor(state.base_value(), "solar_sail_launch") <= EPSILON {
        return Err("Dyson solar-sail launch is disabled or throttled to zero".to_owned());
    }

    let mut active_launchers = 0_usize;
    for entity_index in 0..state.entity_index.len() {
        let entity = state
            .parse_entity(entity_index)
            .map_err(|error| format!("Dyson sail launcher decode failed: {error:#}"))?;
        if number_at(Some(&entity), &["machineCount"]) <= EPSILON {
            continue;
        }
        match entity.get("recipeId").and_then(Value::as_str) {
            Some("carrier_rocket_launch") => {
                return Err(
                    "carrier-rocket launch is active beside the certified solar-sail terminal"
                        .to_owned(),
                );
            }
            Some("solar_sail_launch") => {}
            _ => continue,
        }
        if entity.get("buildingId").and_then(Value::as_str) != Some("em_rail_ejector") {
            return Err("solar_sail_launch is installed in an incompatible building".to_owned());
        }
        if entity.get("sprayCoaterInstalled").and_then(Value::as_bool) == Some(true) {
            return Err(
                "solar-sail launcher uses proliferator without a closed launch-bonus ledger"
                    .to_owned(),
            );
        }
        let inputs = entity
            .get("inputs")
            .and_then(Value::as_object)
            .map(|inputs| inputs.keys().map(String::as_str).collect::<BTreeSet<_>>())
            .unwrap_or_default();
        let outputs = entity
            .get("outputs")
            .and_then(Value::as_object)
            .map(|outputs| outputs.keys().map(String::as_str).collect::<BTreeSet<_>>())
            .unwrap_or_default();
        if inputs != BTreeSet::from([TERMINAL_SAIL_ITEM_ID]) || !outputs.is_empty() {
            return Err(
                "solar-sail launcher slots do not match the canonical terminal ledger".to_owned(),
            );
        }
        let planet_id = entity
            .get("planetId")
            .and_then(Value::as_str)
            .ok_or_else(|| "solar-sail launcher has no planet".to_owned())?;
        let system_id = state
            .catalog
            .planets
            .iter()
            .find(|planet| planet.id == planet_id)
            .map(|planet| planet.system_id.as_str())
            .ok_or_else(|| {
                format!("solar-sail launcher planet {planet_id} is absent from catalog")
            })?;
        let target_id = entity
            .get("targetDysonOrbitId")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .ok_or_else(|| "solar-sail launcher has no target orbit".to_owned())?;
        let target_exists = state
            .base_value()
            .get("dysonEngineering")
            .and_then(Value::as_object)
            .and_then(|engineering| engineering.get("orbitsBySystem"))
            .and_then(Value::as_object)
            .and_then(|systems| systems.get(system_id))
            .and_then(Value::as_array)
            .is_some_and(|orbits| {
                orbits
                    .iter()
                    .any(|orbit| orbit.get("id").and_then(Value::as_str) == Some(target_id))
            });
        if !target_exists {
            return Err(format!(
                "solar-sail launcher target {system_id}.{target_id} is absent"
            ));
        }
        active_launchers = active_launchers
            .checked_add(1)
            .ok_or_else(|| "solar-sail launcher count overflowed".to_owned())?;
    }
    if active_launchers == 0 {
        return Err("calibrated solar-sail launches have no active ejector".to_owned());
    }
    Ok(())
}

fn build_dyson_sail_sink_certificate(
    state: &CoreState,
    snapshots: &[SettlementProofSnapshot],
) -> Result<Option<DysonSailSinkCertificate>, String> {
    if snapshots.len() != 4 {
        return Err("Dyson solar-sail calibration requires four snapshots".to_owned());
    }
    let sail_changed = snapshots.windows(2).any(|window| {
        window[0].dyson.sails_launched != window[1].dyson.sails_launched
            || window[0].dyson.sails_expired != window[1].dyson.sails_expired
            || window[0].dyson.sails_in_orbit != window[1].dyson.sails_in_orbit
            || window[0].dyson.sails_absorbed != window[1].dyson.sails_absorbed
            || window[0].dyson.shell_sails != window[1].dyson.shell_sails
    });
    if !sail_changed {
        return Ok(None);
    }
    let current = capture_dyson_terminal(state.base_value())
        .map_err(|error| format!("current Dyson terminal state is invalid: {error:#}"))?;
    if current != snapshots[0].dyson && current != snapshots[3].dyson {
        return Err("current Dyson state is not a solar-sail calibration endpoint".to_owned());
    }

    let mut launch_deltas = Vec::with_capacity(3);
    let mut orbit_launch_deltas = BTreeMap::<String, BTreeMap<String, Vec<i128>>>::new();
    for window in snapshots.windows(2) {
        let before = &window[0].dyson;
        let after = &window[1].dyson;
        if before.rockets_launched != after.rockets_launched
            || before.structure_points != after.structure_points
            || before.structure_by_system != after.structure_by_system
        {
            return Err(
                "carrier-rocket or structure state changed during solar-sail calibration"
                    .to_owned(),
            );
        }
        let launched = checked_terminal_delta(
            after.sails_launched,
            before.sails_launched,
            "solar sail launch",
        )?;
        let energy = checked_terminal_delta(
            after.launch_energy_micro_mj,
            before.launch_energy_micro_mj,
            "Dyson launch-energy",
        )?;
        let expected_energy = launched
            .checked_mul(21_600_000)
            .ok_or_else(|| "solar-sail launch-energy calibration overflowed".to_owned())?;
        if energy != expected_energy {
            return Err(format!(
                "Dyson launch-energy delta {energy} does not match {launched} solar-sail launch event(s)"
            ));
        }
        let deltas = orbit_window_delta(
            &before.orbit_launched_by_orbit,
            &after.orbit_launched_by_orbit,
            "dysonEngineering.orbitsBySystem.totalLaunched",
            true,
        )?;
        let mut orbit_sum = 0_i128;
        for (system_id, orbits) in deltas {
            for (orbit_id, delta) in orbits {
                orbit_sum = orbit_sum
                    .checked_add(delta)
                    .ok_or_else(|| "per-orbit solar-sail launch total overflowed".to_owned())?;
                orbit_launch_deltas
                    .entry(system_id.clone())
                    .or_default()
                    .entry(orbit_id)
                    .or_default()
                    .push(delta);
            }
        }
        if orbit_sum != launched {
            return Err(format!(
                "per-orbit solar-sail launch delta {orbit_sum} does not equal global delta {launched}"
            ));
        }
        launch_deltas.push(launched);
    }

    let launches_per_second = stable_window_rate(&launch_deltas, "solar sail launch")?;
    if launches_per_second <= 0 {
        return Err(
            "solar-sail lifecycle changed without a stable positive launch rate".to_owned(),
        );
    }
    validate_certified_sail_launcher_domain(state)?;
    let mut launches_per_second_by_orbit = OrbitMaterialTotals::new();
    let mut orbit_rate_sum = 0_i128;
    for (system_id, orbits) in orbit_launch_deltas {
        let mut rates = MaterialTotals::new();
        for (orbit_id, deltas) in orbits {
            let rate = stable_window_rate(
                &deltas,
                &format!("dysonEngineering.orbitsBySystem.{system_id}.{orbit_id}.totalLaunched"),
            )?;
            if rate > 0 {
                rates.insert(orbit_id, rate);
                orbit_rate_sum = orbit_rate_sum
                    .checked_add(rate)
                    .ok_or_else(|| "per-orbit solar-sail rate sum overflowed".to_owned())?;
            }
        }
        if !rates.is_empty() {
            launches_per_second_by_orbit.insert(system_id, rates);
        }
    }
    if launches_per_second_by_orbit.is_empty() || orbit_rate_sum != launches_per_second {
        return Err(format!(
            "per-orbit solar-sail rate {orbit_rate_sum}/s does not close to global rate {launches_per_second}/s"
        ));
    }
    Ok(Some(DysonSailSinkCertificate {
        launches_per_second,
        launches_per_second_by_orbit,
        expected: current,
    }))
}

fn build_research_sink_certificate(
    state: &CoreState,
    snapshots: &[SettlementProofSnapshot],
) -> Result<Option<ResearchSinkCertificate>, String> {
    let current = capture_research_proof_snapshot(state)
        .map_err(|error| format!("current research state is invalid: {error:#}"))?;
    let selected = current.selected_technology_id.as_deref();
    let active_infinite = current.active_infinite_research_id.as_deref();
    if selected.is_none() && active_infinite.is_none() {
        if !current.labs.is_empty() {
            return Err("matrix labs are active without a selected research sink".to_owned());
        }
        return Ok(None);
    }
    if selected.is_some() && active_infinite.is_some() {
        return Err("finite and infinite research are active simultaneously".to_owned());
    }
    if current != snapshots[0].research && current != snapshots[3].research {
        return Err("current research state is not a calibration endpoint".to_owned());
    }

    if let Some(technology_id) = selected {
        let technology = state
            .catalog
            .technologies
            .get(technology_id)
            .ok_or_else(|| format!("selected technology {technology_id} is absent from catalog"))?;
        if technology.costs.is_empty()
            || current
                .completed_technology_ids
                .iter()
                .any(|id| id == technology_id)
        {
            return Err(format!(
                "selected technology {technology_id} is empty or already completed"
            ));
        }
        let mut costs = MaterialTotals::new();
        for cost in &technology.costs {
            add_catalog_flow_amount(
                &mut costs,
                &cost.item_id,
                cost.amount,
                &format!("technologies.{technology_id}.costs.{}", cost.item_id),
            )?;
        }
        let allowed_inputs = costs.keys().cloned().collect::<BTreeSet<_>>();
        validate_research_labs(state, &current, &allowed_inputs)?;
        let mut consumed = MaterialTotals::new();
        for window in snapshots.windows(2) {
            if !research_static_state_matches(
                &window[0].research,
                &window[1].research,
                Some(technology_id),
                None,
            ) {
                return Err("finite research configuration changed during calibration".to_owned());
            }
        }
        let empty = MaterialTotals::new();
        for item_id in &allowed_inputs {
            let mut deltas = Vec::with_capacity(3);
            for window in snapshots.windows(2) {
                let before = window[0]
                    .research
                    .finite_progress
                    .get(technology_id)
                    .unwrap_or(&empty)
                    .get(item_id)
                    .copied()
                    .unwrap_or(0);
                let after = window[1]
                    .research
                    .finite_progress
                    .get(technology_id)
                    .unwrap_or(&empty)
                    .get(item_id)
                    .copied()
                    .unwrap_or(0);
                deltas.push(
                    after
                        .checked_sub(before)
                        .ok_or_else(|| format!("research {item_id} progress overflowed"))?,
                );
            }
            let rate = stable_window_rate(
                &deltas,
                &format!("research.progressByTech.{technology_id}.{item_id}"),
            )?;
            let progress = current
                .finite_progress
                .get(technology_id)
                .and_then(|progress| progress.get(item_id))
                .copied()
                .unwrap_or(0);
            let cost = costs[item_id];
            if progress > cost {
                return Err(format!(
                    "research {item_id} progress exceeds its technology cost"
                ));
            }
            if rate > 0 {
                if !current
                    .labs
                    .iter()
                    .any(|lab| lab.input_item_ids.contains(item_id))
                {
                    return Err(format!(
                        "research {item_id} consumption has no matching matrix-lab slot"
                    ));
                }
                consumed.insert(item_id.clone(), rate);
            }
        }
        let selected_progress = current
            .finite_progress
            .get(technology_id)
            .cloned()
            .unwrap_or_default();
        if selected_progress
            .keys()
            .any(|item_id| !costs.contains_key(item_id))
        {
            return Err("selected technology progress has an unknown matrix item".to_owned());
        }
        if consumed.is_empty() {
            return Err("finite research made no stable integer progress".to_owned());
        }
        return Ok(Some(ResearchSinkCertificate {
            kind: ResearchSinkKind::Finite {
                technology_id: technology_id.to_owned(),
                costs,
            },
            consumed_units_per_second: consumed,
            expected: current,
        }));
    }

    let research_id = active_infinite.expect("one research mode was selected");
    if !current
        .completed_technology_ids
        .iter()
        .any(|id| id == "universe_matrix")
    {
        return Err("infinite research is active before universe_matrix unlock".to_owned());
    }
    if !crate::infinite_research::valid_id(research_id) {
        return Err(format!("unknown infinite research ID {research_id}"));
    }
    let allowed_inputs = BTreeSet::from(["universe_matrix".to_owned()]);
    validate_research_labs(state, &current, &allowed_inputs)?;
    for window in snapshots.windows(2) {
        if !research_static_state_matches(
            &window[0].research,
            &window[1].research,
            None,
            Some(research_id),
        ) {
            return Err("infinite research configuration changed during calibration".to_owned());
        }
    }
    let mut deltas = Vec::with_capacity(3);
    let mut stable_level = None;
    for window in snapshots.windows(2) {
        let before = window[0]
            .research
            .infinite_progress
            .get(research_id)
            .ok_or_else(|| format!("infinite research {research_id} progress is missing"))?;
        let after = window[1]
            .research
            .infinite_progress
            .get(research_id)
            .ok_or_else(|| format!("infinite research {research_id} progress is missing"))?;
        if before.level != after.level {
            return Err("infinite research crossed a level during calibration".to_owned());
        }
        match stable_level {
            None => stable_level = Some(before.level),
            Some(level) if level == before.level => {}
            Some(_) => return Err("infinite research level changed between windows".to_owned()),
        }
        deltas.push(
            after
                .progress
                .checked_sub(before.progress)
                .ok_or_else(|| "infinite research progress overflowed".to_owned())?,
        );
    }
    let rate = stable_window_rate(&deltas, "infinite research progress")?;
    if rate <= 0 {
        return Err("infinite research made no stable integer progress".to_owned());
    }
    if !current
        .labs
        .iter()
        .any(|lab| lab.input_item_ids.iter().any(|id| id == "universe_matrix"))
    {
        return Err("infinite research has no universe-matrix lab slot".to_owned());
    }
    let level = stable_level.unwrap_or(0);
    if current
        .infinite_progress
        .get(research_id)
        .is_none_or(|progress| progress.level != level)
    {
        return Err("current infinite research level is not the calibrated level".to_owned());
    }
    if crate::infinite_research::maximum_level(research_id).is_some_and(|maximum| level >= maximum)
    {
        return Err("infinite research is already at maximum level".to_owned());
    }
    let level_cost = i128::try_from(
        crate::infinite_research::cost(research_id, level)
            .map_err(|error| format!("infinite research cost is invalid: {error:#}"))?,
    )
    .map_err(|_| "infinite research cost exceeds the proof ledger".to_owned())?;
    let progress = current.infinite_progress[research_id].progress;
    if progress > level_cost {
        return Err("infinite research progress exceeds the current level cost".to_owned());
    }
    Ok(Some(ResearchSinkCertificate {
        kind: ResearchSinkKind::Infinite {
            research_id: research_id.to_owned(),
            level,
            level_cost,
        },
        consumed_units_per_second: BTreeMap::from([("universe_matrix".to_owned(), rate)]),
        expected: current,
    }))
}

fn build_closed_recipe_certificate(
    state: &CoreState,
    sources: &BTreeSet<String>,
    flow: &OrdinaryWindowFlow,
    research: Option<ResearchSinkCertificate>,
    dyson_rocket: Option<DysonRocketSinkCertificate>,
    dyson_sail: Option<DysonSailSinkCertificate>,
) -> Result<OrdinaryFlowCertificate, String> {
    let recipe_ids =
        active_ordinary_recipe_ids(state, dyson_rocket.is_some(), dyson_sail.is_some())?;
    if recipe_ids.is_empty() && research.is_none() && dyson_rocket.is_none() && dyson_sail.is_none()
    {
        return Err(
            "no active ordinary recipe, research sink or Dyson terminal sink is available"
                .to_owned(),
        );
    }

    // Recipe IDs are retained in first-seen entity order. The topological
    // traversal below proves acyclicity only; it never rewrites entity order or
    // uses map iteration order as a scheduling input.
    let mut recipe_inputs = Vec::with_capacity(recipe_ids.len());
    let mut recipe_outputs = Vec::with_capacity(recipe_ids.len());
    let mut output_producer = BTreeMap::<String, usize>::new();
    for (recipe_index, recipe_id) in recipe_ids.iter().enumerate() {
        let recipe = state
            .catalog
            .recipes
            .get(recipe_id)
            .ok_or_else(|| format!("active recipe {recipe_id} disappeared"))?;
        let mut inputs = MaterialTotals::new();
        let mut outputs = MaterialTotals::new();
        for input in &recipe.inputs {
            add_catalog_flow_amount(
                &mut inputs,
                &input.item_id,
                input.amount,
                &format!("recipes.{recipe_id}.inputs.{}", input.item_id),
            )?;
        }
        for output in &recipe.outputs {
            add_catalog_flow_amount(
                &mut outputs,
                &output.item_id,
                output.amount,
                &format!("recipes.{recipe_id}.outputs.{}", output.item_id),
            )?;
        }
        if inputs.keys().any(|item_id| outputs.contains_key(item_id)) {
            return Err(format!(
                "active recipe {recipe_id} has an input/output feedback item"
            ));
        }
        for item_id in outputs.keys() {
            if sources.contains(item_id) {
                return Err(format!(
                    "recipe {recipe_id} output {item_id} overlaps an infinite-vein source"
                ));
            }
            if let Some(previous_index) = output_producer.insert(item_id.clone(), recipe_index) {
                return Err(format!(
                    "item {item_id} has alternate active producers {} and {recipe_id}",
                    recipe_ids[previous_index]
                ));
            }
        }
        recipe_inputs.push(inputs);
        recipe_outputs.push(outputs);
    }

    // Every non-source input must have exactly one active upstream producer.
    // Edges are de-duplicated per recipe pair so a multi-item dependency does
    // not inflate the consumer's indegree.
    let mut outgoing = vec![BTreeSet::<usize>::new(); recipe_ids.len()];
    let mut indegree = vec![0_usize; recipe_ids.len()];
    for (consumer_index, inputs) in recipe_inputs.iter().enumerate() {
        for item_id in inputs.keys() {
            let Some(&producer_index) = output_producer.get(item_id) else {
                if sources.contains(item_id) {
                    continue;
                }
                return Err(format!(
                    "recipe {} input {item_id} has no certified infinite source or active producer",
                    recipe_ids[consumer_index]
                ));
            };
            if outgoing[producer_index].insert(consumer_index) {
                indegree[consumer_index] = indegree[consumer_index]
                    .checked_add(1)
                    .ok_or_else(|| "ordinary recipe DAG indegree overflowed".to_owned())?;
            }
        }
    }
    let mut ready = indegree
        .iter()
        .enumerate()
        .filter_map(|(index, degree)| (*degree == 0).then_some(index))
        .collect::<BTreeSet<_>>();
    let mut topological_order = Vec::with_capacity(recipe_ids.len());
    while let Some(index) = ready.iter().next().copied() {
        ready.remove(&index);
        topological_order.push(index);
        for &consumer_index in &outgoing[index] {
            indegree[consumer_index] = indegree[consumer_index]
                .checked_sub(1)
                .ok_or_else(|| "ordinary recipe DAG indegree regressed".to_owned())?;
            if indegree[consumer_index] == 0 {
                ready.insert(consumer_index);
            }
        }
    }
    if topological_order.len() != recipe_ids.len() {
        return Err("active ordinary recipes contain a material dependency cycle".to_owned());
    }

    let allowed_production = sources
        .iter()
        .chain(output_producer.keys())
        .cloned()
        .collect::<BTreeSet<_>>();
    let mut allowed_consumption = recipe_inputs
        .iter()
        .flat_map(|inputs| inputs.keys().cloned())
        .collect::<BTreeSet<_>>();
    if let Some(research) = &research {
        for item_id in research.consumed_units_per_second.keys() {
            if !sources.contains(item_id) && !output_producer.contains_key(item_id) {
                return Err(format!(
                    "research input {item_id} has no certified infinite source or active producer"
                ));
            }
            allowed_consumption.insert(item_id.clone());
        }
    }
    if let Some(rocket) = &dyson_rocket {
        if !output_producer.contains_key(TERMINAL_ROCKET_ITEM_ID) {
            return Err(
                "Dyson rocket sink has no active certified small-carrier-rocket producer"
                    .to_owned(),
            );
        }
        allowed_consumption.insert(TERMINAL_ROCKET_ITEM_ID.to_owned());
        if rocket.launches_per_second <= 0 {
            return Err("Dyson rocket sink has a non-positive launch rate".to_owned());
        }
    }
    if let Some(sail) = &dyson_sail {
        if !output_producer.contains_key(TERMINAL_SAIL_ITEM_ID) {
            return Err(
                "Dyson solar-sail sink has no active certified solar-sail producer".to_owned(),
            );
        }
        allowed_consumption.insert(TERMINAL_SAIL_ITEM_ID.to_owned());
        if sail.launches_per_second <= 0 {
            return Err("Dyson solar-sail sink has a non-positive launch rate".to_owned());
        }
    }
    for item_id in flow.produced_per_second.keys() {
        if !allowed_production.contains(item_id) {
            return Err(format!(
                "unmodelled item {item_id} was produced beside the ordinary recipe DAG"
            ));
        }
    }
    for item_id in flow.consumed_per_second.keys() {
        if !allowed_consumption.contains(item_id) {
            return Err(format!(
                "unmodelled item {item_id} was consumed beside the ordinary recipe DAG"
            ));
        }
    }

    // Gross output fixes an integer batch rate for every active recipe. This
    // avoids deriving downstream flow from inventory deltas alone.
    let mut batches_per_second = vec![0_i128; recipe_ids.len()];
    for &recipe_index in &topological_order {
        let recipe_id = &recipe_ids[recipe_index];
        let mut recipe_batches = None;
        for (item_id, output_amount) in &recipe_outputs[recipe_index] {
            let produced = flow.produced_per_second.get(item_id).copied().unwrap_or(0);
            if produced <= 0 || produced % output_amount != 0 {
                return Err(format!(
                    "recipe {recipe_id} output {item_id} does not prove whole stable batches"
                ));
            }
            let batches = produced / output_amount;
            match recipe_batches {
                None => recipe_batches = Some(batches),
                Some(expected) if expected == batches => {}
                Some(expected) => {
                    return Err(format!(
                        "recipe {recipe_id} output batch rates disagree ({expected} versus {batches})"
                    ));
                }
            }
        }
        let recipe_batches = recipe_batches.unwrap_or(0);
        if recipe_batches <= 0 {
            return Err(format!("recipe {recipe_id} produced no stable batches"));
        }
        batches_per_second[recipe_index] = recipe_batches;
    }

    // Sum every consumer before comparing against the inferred aggregate.
    // This is the shared-intermediate fan-out receipt: an intermediate can be
    // consumed by several recipes, but each unit is charged exactly once.
    let mut expected_consumption = research
        .as_ref()
        .map(|research| research.consumed_units_per_second.clone())
        .unwrap_or_default();
    if let Some(rocket) = &dyson_rocket {
        let current = expected_consumption
            .get(TERMINAL_ROCKET_ITEM_ID)
            .copied()
            .unwrap_or(0);
        expected_consumption.insert(
            TERMINAL_ROCKET_ITEM_ID.to_owned(),
            current
                .checked_add(rocket.launches_per_second)
                .ok_or_else(|| "Dyson rocket consumption rate overflowed".to_owned())?,
        );
    }
    if let Some(sail) = &dyson_sail {
        let current = expected_consumption
            .get(TERMINAL_SAIL_ITEM_ID)
            .copied()
            .unwrap_or(0);
        expected_consumption.insert(
            TERMINAL_SAIL_ITEM_ID.to_owned(),
            current
                .checked_add(sail.launches_per_second)
                .ok_or_else(|| "Dyson solar-sail consumption rate overflowed".to_owned())?,
        );
    }
    for (recipe_index, inputs) in recipe_inputs.iter().enumerate() {
        for (item_id, input_amount) in inputs {
            let consumed = input_amount
                .checked_mul(batches_per_second[recipe_index])
                .ok_or_else(|| {
                    format!(
                        "recipe {} input {item_id} rate overflowed",
                        recipe_ids[recipe_index]
                    )
                })?;
            let current = expected_consumption.get(item_id).copied().unwrap_or(0);
            expected_consumption.insert(
                item_id.clone(),
                current
                    .checked_add(consumed)
                    .ok_or_else(|| format!("{item_id} aggregate consumption overflowed"))?,
            );
        }
    }

    let ledger_items = material_ids([
        &flow.produced_per_second,
        &flow.consumed_per_second,
        &flow.net_owned_per_second,
        &expected_consumption,
    ]);
    let mut has_terminal_product =
        research.is_some() || dyson_rocket.is_some() || dyson_sail.is_some();
    for item_id in ledger_items {
        if !allowed_production.contains(&item_id) && !allowed_consumption.contains(&item_id) {
            return Err(format!(
                "unmodelled item {item_id} changed ownership beside the ordinary recipe DAG"
            ));
        }
        let produced = flow.produced_per_second.get(&item_id).copied().unwrap_or(0);
        let consumed = flow.consumed_per_second.get(&item_id).copied().unwrap_or(0);
        let expected = expected_consumption.get(&item_id).copied().unwrap_or(0);
        let net_owned = flow
            .net_owned_per_second
            .get(&item_id)
            .copied()
            .unwrap_or(0);
        if consumed != expected {
            return Err(format!(
                "ordinary recipe DAG item {item_id} consumed {consumed}/s instead of {expected}/s"
            ));
        }
        if produced < consumed || produced - consumed != net_owned {
            return Err(format!(
                "ordinary recipe DAG item {item_id} is not funded by same-window certified production"
            ));
        }
        if output_producer.contains_key(&item_id) && expected == 0 && net_owned > 0 {
            has_terminal_product = true;
        }
    }
    if !has_terminal_product {
        return Err("ordinary recipe DAG has no stable final product or research sink".to_owned());
    }

    Ok(OrdinaryFlowCertificate {
        units_per_second: flow.net_owned_per_second.clone(),
        produced_units_per_second: flow.produced_per_second.clone(),
        consumed_units_per_second: flow.consumed_per_second.clone(),
        recipe_ids,
        research,
        dyson_rocket,
        dyson_sail,
    })
}

fn build_ordinary_flow_certificate(
    state: &CoreState,
    snapshots: &[SettlementProofSnapshot],
) -> Result<OrdinaryFlowCertificate, String> {
    if snapshots.len() != 4 {
        return Err(format!(
            "three-window calibration requires four snapshots, observed {}",
            snapshots.len()
        ));
    }
    for window in snapshots.windows(2) {
        validate_internal_exact_snapshots(&window[0], &window[1], &state.catalog)
            .map_err(|reason| format!("calibration window settlement proof rejected: {reason}"))?;
    }
    let quantum = state
        .base_value()
        .get("quantumLogisticsNetwork")
        .and_then(Value::as_object)
        .ok_or_else(|| "quantum logistics network is missing".to_owned())?;
    if quantum.get("enabled").and_then(Value::as_bool) != Some(true) {
        return Err("quantum logistics network is disabled".to_owned());
    }
    if quantum
        .get("inventory")
        .and_then(Value::as_object)
        .is_none()
        || quantum
            .get("itemCapacities")
            .and_then(Value::as_object)
            .is_none()
    {
        return Err("quantum inventory or capacity ledger is malformed".to_owned());
    }

    let sources = exclusive_infinite_vein_sources(state)?;
    let research = build_research_sink_certificate(state, snapshots)?;
    let dyson_sail = build_dyson_sail_sink_certificate(state, snapshots)?;
    let dyson_rocket = if dyson_sail.is_none() {
        build_dyson_rocket_sink_certificate(state, snapshots)?
    } else {
        None
    };
    let recipe_rejection = (|| {
        let mut windows = Vec::with_capacity(3);
        for window in snapshots.windows(2) {
            windows.push(capture_ordinary_window_flow(
                &window[0],
                &window[1],
                dyson_rocket.is_some() || dyson_sail.is_some(),
            )?);
        }
        let flow = windows
            .first()
            .cloned()
            .ok_or_else(|| "three-window calibration produced no flow snapshots".to_owned())?;
        if windows.iter().skip(1).any(|window| window != &flow) {
            return Err("ordinary production/consumption/ownership rates were unstable across the three calibration windows".to_owned());
        }
        build_closed_recipe_certificate(
            state,
            &sources,
            &flow,
            research.clone(),
            dyson_rocket.clone(),
            dyson_sail.clone(),
        )
    })();
    if let Ok(certificate) = recipe_rejection {
        return Ok(certificate);
    }
    let recipe_rejection = recipe_rejection.unwrap_err();

    // Source-only is a strict subset, not a recovery path for a malformed or
    // unclosed active recipe domain. Otherwise a blocked/cyclic factory could
    // still receive extrapolated mining while its material consumers freeze.
    if !active_ordinary_recipe_ids(state, dyson_rocket.is_some(), dyson_sail.is_some())?.is_empty()
        || research.is_some()
        || dyson_rocket.is_some()
        || dyson_sail.is_some()
    {
        return Err(recipe_rejection);
    }

    let mut rates = MaterialTotals::new();
    let mut first_rejection = None;
    for item_id in sources {
        let mut stable_production = None;
        let mut rejected = None;
        for window in snapshots.windows(2) {
            let owned =
                checked_material_delta(&window[0].owned, &window[1].owned, &item_id, "owned")?;
            let produced = checked_material_delta(
                &window[0].produced,
                &window[1].produced,
                &item_id,
                "produced",
            )?;
            let consumed = checked_material_delta(
                &window[0].consumed,
                &window[1].consumed,
                &item_id,
                "consumed",
            )?;
            let granted = checked_material_delta(
                &window[0].granted,
                &window[1].granted,
                &item_id,
                "granted",
            )?;
            if produced <= 0 {
                rejected = Some("did not produce in every calibration window".to_owned());
                break;
            }
            if owned != produced || consumed != 0 || granted != 0 {
                rejected = Some(format!(
                    "is not a source-only closed flow (owned={owned}, produced={produced}, consumed={consumed}, granted={granted})"
                ));
                break;
            }
            if produced % (MACRO_V10_CALIBRATION_WINDOW_SECONDS as i128) != 0 {
                rejected = Some(format!(
                    "has a fractional per-second rate over the ten-second window ({produced})"
                ));
                break;
            }
            match stable_production {
                None => stable_production = Some(produced),
                Some(expected) if expected == produced => {}
                Some(expected) => {
                    rejected = Some(format!(
                        "is unstable across calibration windows ({expected} versus {produced})"
                    ));
                    break;
                }
            }
        }
        if let Some(reason) = rejected {
            first_rejection.get_or_insert_with(|| format!("{item_id} {reason}"));
            continue;
        }
        let produced = stable_production.unwrap_or(0);
        let rate = produced / (MACRO_V10_CALIBRATION_WINDOW_SECONDS as i128);
        if rate > 0 {
            rates.insert(item_id, rate);
        }
    }
    if rates.is_empty() {
        return Err(first_rejection.unwrap_or(recipe_rejection));
    }
    Ok(OrdinaryFlowCertificate {
        units_per_second: rates.clone(),
        produced_units_per_second: rates,
        consumed_units_per_second: MaterialTotals::new(),
        recipe_ids: Vec::new(),
        research: None,
        dyson_rocket: None,
        dyson_sail: None,
    })
}

fn exact_three_window_probe(
    state: &CoreState,
    request: &CoreAdvanceRequest,
) -> Result<Vec<SettlementProofSnapshot>, String> {
    let multiplier = finite_number_at(state.base_value().get("timeWarp"), &["effectiveMultiplier"])
        .filter(|value| *value > 0.0)
        .ok_or_else(|| "probe multiplier is invalid".to_owned())?;
    let mut probe = state.clone();
    // The probe is disposable and must not inherit a stale runtime proof as an
    // input to the exact engine. Clearing it also keeps the clone compact.
    probe.pure_idle_macro_runtime = None;
    let mut snapshots = vec![
        capture_settlement_snapshot(&probe)
            .map_err(|error| format!("probe baseline snapshot failed: {error:#}"))?,
    ];
    for _ in 0..3 {
        let mut result = probe
            .advance_exact(&exact_request(
                probe.revision,
                MACRO_V10_CALIBRATION_WINDOW_SECONDS,
                MACRO_V10_CALIBRATION_WINDOW_SECONDS / multiplier,
            ))
            .map_err(|error| format!("probe exact window failed: {error:#}"))?;
        if !result.supported {
            return Err(result
                .reason
                .take()
                .unwrap_or_else(|| "probe exact window is unsupported".to_owned()));
        }
        let after = capture_settlement_snapshot(&probe)
            .map_err(|error| format!("probe settlement snapshot failed: {error:#}"))?;
        validate_internal_exact_snapshots(
            snapshots.last().expect("probe always has a baseline"),
            &after,
            &probe.catalog,
        )
        .map_err(|reason| format!("probe settlement proof rejected: {reason}"))?;
        snapshots.push(after);
    }
    if let Some(reason) = budget_attestation_reason(&probe, request) {
        return Err(format!("probe power boundary changed: {reason}"));
    }
    Ok(snapshots)
}

fn elapsed_micros(value: f64) -> Result<i128, String> {
    if !value.is_finite() || value < 0.0 {
        return Err("elapsed clock is not a finite non-negative number".to_owned());
    }
    let scaled = value * MICROS_PER_SECOND as f64;
    if !scaled.is_finite() || scaled > i128::MAX as f64 {
        return Err("elapsed microsecond clock overflowed".to_owned());
    }
    let rounded = scaled.round();
    let tolerance = EPSILON * scaled.abs().max(1.0);
    if (scaled - rounded).abs() > tolerance {
        return Err("elapsed clock is not representable at microsecond precision".to_owned());
    }
    Ok(rounded as i128)
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct OrdinaryFlowApplication {
    certified_items: usize,
    deposited_units: i128,
    produced_units: i128,
    consumed_units: i128,
    recipe_certified: bool,
    research_certified: bool,
    rocket_certified: bool,
    sail_certified: bool,
    rockets_launched: i128,
    sails_launched: i128,
    sails_expired: i128,
    sails_absorbed: i128,
    capacity_limited: bool,
}

fn apply_source_only_flow_certificate(
    state: &mut CoreState,
    certificate: &OrdinaryFlowCertificate,
    elapsed_before: f64,
    elapsed_after: f64,
) -> Result<OrdinaryFlowApplication, String> {
    if certificate.produced_units_per_second != certificate.units_per_second
        || !certificate.consumed_units_per_second.is_empty()
        || certificate.dyson_rocket.is_some()
        || certificate.dyson_sail.is_some()
    {
        return Err("source-only certificate has an invalid closed-flow identity".to_owned());
    }
    let before_micros = elapsed_micros(elapsed_before)?;
    let after_micros = elapsed_micros(elapsed_after)?;
    if after_micros < before_micros {
        return Err("elapsed clock regressed during source-only settlement".to_owned());
    }
    let base = state.base_value();
    let quantum = base
        .get("quantumLogisticsNetwork")
        .and_then(Value::as_object)
        .ok_or_else(|| "quantum logistics network is missing".to_owned())?;
    if quantum.get("enabled").and_then(Value::as_bool) != Some(true) {
        return Err("quantum logistics network became disabled".to_owned());
    }
    let inventory = quantum
        .get("inventory")
        .and_then(Value::as_object)
        .ok_or_else(|| "quantum inventory is malformed".to_owned())?;
    let capacities = quantum
        .get("itemCapacities")
        .and_then(Value::as_object)
        .ok_or_else(|| "quantum capacity ledger is malformed".to_owned())?;
    let produced = base
        .get("totalProduced")
        .and_then(Value::as_object)
        .ok_or_else(|| "totalProduced is malformed".to_owned())?;

    let mut updates = Vec::with_capacity(certificate.units_per_second.len());
    let mut application = OrdinaryFlowApplication {
        certified_items: certificate.units_per_second.len(),
        ..OrdinaryFlowApplication::default()
    };
    for (item_id, rate) in &certificate.units_per_second {
        let target_before = rate
            .checked_mul(before_micros)
            .and_then(|value| value.checked_div(MICROS_PER_SECOND))
            .ok_or_else(|| format!("{item_id} source schedule overflowed"))?;
        let target_after = rate
            .checked_mul(after_micros)
            .and_then(|value| value.checked_div(MICROS_PER_SECOND))
            .ok_or_else(|| format!("{item_id} source schedule overflowed"))?;
        let scheduled = target_after
            .checked_sub(target_before)
            .ok_or_else(|| format!("{item_id} source schedule regressed"))?;
        let current_inventory = proof_counter(
            inventory.get(item_id),
            &format!("quantumLogisticsNetwork.inventory.{item_id}"),
        )
        .map_err(|error| error.to_string())?;
        let capacity = match capacities.get(item_id) {
            Some(value) => proof_counter(
                Some(value),
                &format!("quantumLogisticsNetwork.itemCapacities.{item_id}"),
            )
            .map_err(|error| error.to_string())?,
            None => DEFAULT_QUANTUM_ITEM_CAPACITY,
        };
        if !(10_000..=DEFAULT_QUANTUM_ITEM_CAPACITY).contains(&capacity) {
            return Err(format!(
                "{item_id} quantum capacity is outside the supported range"
            ));
        }
        let current_produced =
            proof_counter(produced.get(item_id), &format!("totalProduced.{item_id}"))
                .map_err(|error| error.to_string())?;
        if current_produced > MAX_SAFE_INTEGER as i128 {
            return Err(format!(
                "totalProduced.{item_id} exceeds the safe integer range"
            ));
        }
        let inventory_room = capacity.saturating_sub(current_inventory);
        let production_room = (MAX_SAFE_INTEGER as i128).saturating_sub(current_produced);
        let accepted = scheduled.min(inventory_room).min(production_room).max(0);
        application.capacity_limited |= accepted < scheduled;
        application.deposited_units = application
            .deposited_units
            .checked_add(accepted)
            .ok_or_else(|| "ordinary-flow deposited-unit total overflowed".to_owned())?;
        application.produced_units = application
            .produced_units
            .checked_add(accepted)
            .ok_or_else(|| "ordinary-flow produced-unit total overflowed".to_owned())?;
        updates.push((
            item_id.clone(),
            current_inventory
                .checked_add(accepted)
                .ok_or_else(|| format!("{item_id} quantum inventory overflowed"))?,
            current_produced
                .checked_add(accepted)
                .ok_or_else(|| format!("totalProduced.{item_id} overflowed"))?,
        ));
    }

    let base = state.base_value_mut();
    let inventory = base
        .get_mut("quantumLogisticsNetwork")
        .and_then(Value::as_object_mut)
        .and_then(|network| network.get_mut("inventory"))
        .and_then(Value::as_object_mut)
        .ok_or_else(|| "quantum inventory disappeared before commit".to_owned())?;
    for (item_id, next_inventory, _) in &updates {
        inventory.insert(item_id.clone(), Value::String(next_inventory.to_string()));
    }
    let produced = base
        .get_mut("totalProduced")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| "totalProduced disappeared before commit".to_owned())?;
    for (item_id, _, next_produced) in updates {
        let next_produced = i64::try_from(next_produced)
            .map_err(|_| format!("totalProduced.{item_id} cannot be encoded"))?;
        produced.insert(item_id, Value::Number(Number::from(next_produced)));
    }
    Ok(application)
}

fn apply_ordinary_flow_certificate(
    state: &mut CoreState,
    certificate: &mut OrdinaryFlowCertificate,
    elapsed_before: f64,
    elapsed_after: f64,
) -> Result<OrdinaryFlowApplication, String> {
    if certificate.recipe_ids.is_empty()
        && certificate.research.is_none()
        && certificate.dyson_rocket.is_none()
        && certificate.dyson_sail.is_none()
    {
        return apply_source_only_flow_certificate(
            state,
            certificate,
            elapsed_before,
            elapsed_after,
        );
    }
    let before_micros = elapsed_micros(elapsed_before)?;
    let after_micros = elapsed_micros(elapsed_after)?;
    if after_micros < before_micros {
        return Err("elapsed clock regressed during ordinary-flow settlement".to_owned());
    }
    // Whole-second settlement keeps the three integer vectors exactly closed:
    // produced - consumed == net owned. Absolute floor boundaries make a long
    // call and any ordered segmentation choose the same number of seconds
    // without a persisted fractional remainder.
    let scheduled_seconds = after_micros
        .checked_div(MICROS_PER_SECOND)
        .and_then(|after| {
            before_micros
                .checked_div(MICROS_PER_SECOND)
                .and_then(|before| after.checked_sub(before))
        })
        .ok_or_else(|| "ordinary-flow schedule overflowed".to_owned())?;

    let certified_ids = material_ids([
        &certificate.produced_units_per_second,
        &certificate.consumed_units_per_second,
        &certificate.units_per_second,
    ]);
    for item_id in &certified_ids {
        let produced = certificate
            .produced_units_per_second
            .get(item_id)
            .copied()
            .unwrap_or(0);
        let consumed = certificate
            .consumed_units_per_second
            .get(item_id)
            .copied()
            .unwrap_or(0);
        let net_owned = certificate
            .units_per_second
            .get(item_id)
            .copied()
            .unwrap_or(0);
        if produced < 0
            || consumed < 0
            || net_owned < 0
            || produced > MAX_SAFE_INTEGER as i128
            || consumed > MAX_SAFE_INTEGER as i128
            || net_owned > MAX_SAFE_INTEGER as i128
        {
            return Err(format!("{item_id} source schedule overflowed"));
        }
        if produced
            .checked_sub(consumed)
            .filter(|delta| *delta == net_owned)
            .is_none()
        {
            return Err(format!(
                "{item_id} closed-flow identity is invalid ({produced} - {consumed} != {net_owned})"
            ));
        }
    }

    let base = state.base_value();
    let quantum = base
        .get("quantumLogisticsNetwork")
        .and_then(Value::as_object)
        .ok_or_else(|| "quantum logistics network is missing".to_owned())?;
    if quantum.get("enabled").and_then(Value::as_bool) != Some(true) {
        return Err("quantum logistics network became disabled".to_owned());
    }
    let inventory = quantum
        .get("inventory")
        .and_then(Value::as_object)
        .ok_or_else(|| "quantum inventory is malformed".to_owned())?;
    let capacities = quantum
        .get("itemCapacities")
        .and_then(Value::as_object)
        .ok_or_else(|| "quantum capacity ledger is malformed".to_owned())?;
    let produced = base
        .get("totalProduced")
        .and_then(Value::as_object)
        .ok_or_else(|| "totalProduced is malformed".to_owned())?;

    let research = certificate.research.clone();
    let dyson_rocket = certificate.dyson_rocket.clone();
    let dyson_sail = certificate.dyson_sail.clone();
    if let Some(research) = &research {
        let current = capture_research_proof_snapshot(state)
            .map_err(|error| format!("research sink state is invalid: {error:#}"))?;
        if current != research.expected {
            return Err("research sink state diverged from its certified endpoint".to_owned());
        }
    }
    if let Some(rocket) = &dyson_rocket {
        let current = capture_dyson_terminal(state.base_value())
            .map_err(|error| format!("Dyson rocket sink state is invalid: {error:#}"))?;
        if current != rocket.expected {
            return Err("Dyson rocket sink state diverged from its certified endpoint".to_owned());
        }
        let material_consumption = certificate
            .consumed_units_per_second
            .get(TERMINAL_ROCKET_ITEM_ID)
            .copied()
            .unwrap_or(0);
        let material_production = certificate
            .produced_units_per_second
            .get(TERMINAL_ROCKET_ITEM_ID)
            .copied()
            .unwrap_or(0);
        if material_consumption != rocket.launches_per_second
            || material_production < rocket.launches_per_second
        {
            return Err(
                "Dyson rocket sink is no longer funded by the closed ordinary-flow ledger"
                    .to_owned(),
            );
        }
    }
    if let Some(sail) = &dyson_sail {
        let current = capture_dyson_terminal(state.base_value())
            .map_err(|error| format!("Dyson solar-sail sink state is invalid: {error:#}"))?;
        if current != sail.expected {
            return Err(
                "Dyson solar-sail sink state diverged from its certified endpoint".to_owned(),
            );
        }
        let material_consumption = certificate
            .consumed_units_per_second
            .get(TERMINAL_SAIL_ITEM_ID)
            .copied()
            .unwrap_or(0);
        let material_production = certificate
            .produced_units_per_second
            .get(TERMINAL_SAIL_ITEM_ID)
            .copied()
            .unwrap_or(0);
        if material_consumption != sail.launches_per_second
            || material_production < sail.launches_per_second
        {
            return Err(
                "Dyson solar-sail sink is no longer funded by the closed ordinary-flow ledger"
                    .to_owned(),
            );
        }
    }

    let mut accepted_seconds = scheduled_seconds;
    if let Some(research) = &research {
        match &research.kind {
            ResearchSinkKind::Finite {
                technology_id,
                costs,
            } => {
                for (item_id, rate) in &research.consumed_units_per_second {
                    if *rate <= 0 {
                        return Err(format!("research {item_id} has a non-positive rate"));
                    }
                    let progress = research
                        .expected
                        .finite_progress
                        .get(technology_id)
                        .and_then(|progress| progress.get(item_id))
                        .copied()
                        .unwrap_or(0);
                    let cost = costs.get(item_id).copied().ok_or_else(|| {
                        format!("research {item_id} is absent from the certified technology cost")
                    })?;
                    accepted_seconds = accepted_seconds.min(cost.saturating_sub(progress) / rate);
                }
            }
            ResearchSinkKind::Infinite {
                research_id,
                level,
                level_cost,
            } => {
                let progress = research
                    .expected
                    .infinite_progress
                    .get(research_id)
                    .ok_or_else(|| "certified infinite research progress disappeared".to_owned())?;
                if progress.level != *level {
                    return Err("certified infinite research level diverged".to_owned());
                }
                let rate = research
                    .consumed_units_per_second
                    .get("universe_matrix")
                    .copied()
                    .filter(|rate| *rate > 0)
                    .ok_or_else(|| "infinite research has no positive matrix rate".to_owned())?;
                accepted_seconds =
                    accepted_seconds.min(level_cost.saturating_sub(progress.progress) / rate);
            }
        }
    }
    if let Some(rocket) = &dyson_rocket {
        let dyson_horizon = crate::dyson::certified_rocket_launch_capacity_seconds(
            state.base_value(),
            &rocket.launches_per_second_by_system,
        )
        .map_err(|error| format!("Dyson rocket capacity proof failed: {error:#}"))?;
        accepted_seconds = accepted_seconds.min(dyson_horizon);
    }
    if let Some(sail) = &dyson_sail {
        let dyson_horizon = crate::dyson::certified_sail_launch_capacity_seconds(
            state.base_value(),
            &sail.launches_per_second_by_orbit,
        )
        .map_err(|error| format!("Dyson solar-sail capacity proof failed: {error:#}"))?;
        accepted_seconds = accepted_seconds.min(dyson_horizon);
    }
    let mut inventory_baselines = MaterialTotals::new();
    for (item_id, rate) in &certificate.units_per_second {
        if *rate <= 0 {
            continue;
        }
        let current_inventory = proof_counter(
            inventory.get(item_id),
            &format!("quantumLogisticsNetwork.inventory.{item_id}"),
        )
        .map_err(|error| error.to_string())?;
        let capacity = match capacities.get(item_id) {
            Some(value) => proof_counter(
                Some(value),
                &format!("quantumLogisticsNetwork.itemCapacities.{item_id}"),
            )
            .map_err(|error| error.to_string())?,
            None => DEFAULT_QUANTUM_ITEM_CAPACITY,
        };
        if !(10_000..=DEFAULT_QUANTUM_ITEM_CAPACITY).contains(&capacity) {
            return Err(format!(
                "{item_id} quantum capacity is outside the supported range"
            ));
        }
        let room = capacity.saturating_sub(current_inventory);
        accepted_seconds = accepted_seconds.min(room / rate);
        inventory_baselines.insert(item_id.clone(), current_inventory);
    }
    let mut produced_baselines = MaterialTotals::new();
    for (item_id, rate) in &certificate.produced_units_per_second {
        if *rate <= 0 {
            continue;
        }
        let current = proof_counter(produced.get(item_id), &format!("totalProduced.{item_id}"))
            .map_err(|error| error.to_string())?;
        if current > MAX_SAFE_INTEGER as i128 {
            return Err(format!(
                "totalProduced.{item_id} exceeds the safe integer range"
            ));
        }
        accepted_seconds =
            accepted_seconds.min((MAX_SAFE_INTEGER as i128).saturating_sub(current) / rate);
        produced_baselines.insert(item_id.clone(), current);
    }
    accepted_seconds = accepted_seconds.max(0);

    let mut inventory_updates = Vec::with_capacity(certificate.units_per_second.len());
    let mut produced_updates = Vec::with_capacity(certificate.produced_units_per_second.len());
    let mut application = OrdinaryFlowApplication {
        certified_items: certified_ids.len(),
        recipe_certified: !certificate.recipe_ids.is_empty(),
        research_certified: research.is_some(),
        rocket_certified: dyson_rocket.is_some(),
        sail_certified: dyson_sail.is_some(),
        capacity_limited: accepted_seconds < scheduled_seconds,
        ..OrdinaryFlowApplication::default()
    };
    for (item_id, rate) in &certificate.units_per_second {
        let accepted = rate
            .checked_mul(accepted_seconds)
            .ok_or_else(|| format!("{item_id} source schedule overflowed"))?;
        application.deposited_units = application
            .deposited_units
            .checked_add(accepted)
            .ok_or_else(|| "ordinary-flow deposited-unit total overflowed".to_owned())?;
        inventory_updates.push((
            item_id.clone(),
            inventory_baselines
                .get(item_id)
                .copied()
                .unwrap_or(0)
                .checked_add(accepted)
                .ok_or_else(|| format!("{item_id} quantum inventory overflowed"))?,
        ));
    }
    for (item_id, rate) in &certificate.produced_units_per_second {
        let credited = rate
            .checked_mul(accepted_seconds)
            .ok_or_else(|| format!("{item_id} production schedule overflowed"))?;
        application.produced_units = application
            .produced_units
            .checked_add(credited)
            .ok_or_else(|| "ordinary-flow produced-unit total overflowed".to_owned())?;
        produced_updates.push((
            item_id.clone(),
            produced_baselines
                .get(item_id)
                .copied()
                .unwrap_or(0)
                .checked_add(credited)
                .ok_or_else(|| format!("totalProduced.{item_id} overflowed"))?,
        ));
    }
    for (item_id, rate) in &certificate.consumed_units_per_second {
        let consumed = rate
            .checked_mul(accepted_seconds)
            .ok_or_else(|| format!("{item_id} consumption schedule overflowed"))?;
        application.consumed_units = application
            .consumed_units
            .checked_add(consumed)
            .ok_or_else(|| "ordinary-flow consumed-unit total overflowed".to_owned())?;
    }

    let base = state.base_value_mut();
    let inventory = base
        .get_mut("quantumLogisticsNetwork")
        .and_then(Value::as_object_mut)
        .and_then(|network| network.get_mut("inventory"))
        .and_then(Value::as_object_mut)
        .ok_or_else(|| "quantum inventory disappeared before commit".to_owned())?;
    for (item_id, next_inventory) in &inventory_updates {
        inventory.insert(item_id.clone(), Value::String(next_inventory.to_string()));
    }
    let produced = base
        .get_mut("totalProduced")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| "totalProduced disappeared before commit".to_owned())?;
    for (item_id, next_produced) in produced_updates {
        let next_produced = i64::try_from(next_produced)
            .map_err(|_| format!("totalProduced.{item_id} cannot be encoded"))?;
        produced.insert(item_id, Value::Number(Number::from(next_produced)));
    }
    if let Some(research) = research {
        match research.kind {
            ResearchSinkKind::Finite { technology_id, .. } => {
                let progress = base
                    .get_mut("research")
                    .and_then(Value::as_object_mut)
                    .and_then(|research| research.get_mut("progressByTech"))
                    .and_then(Value::as_object_mut)
                    .ok_or_else(|| "finite research progress directory disappeared".to_owned())?
                    .entry(technology_id.clone())
                    .or_insert_with(|| Value::Object(serde_json::Map::new()))
                    .as_object_mut()
                    .ok_or_else(|| "finite research progress entry is malformed".to_owned())?;
                for (item_id, rate) in &research.consumed_units_per_second {
                    let current = research
                        .expected
                        .finite_progress
                        .get(&technology_id)
                        .and_then(|progress| progress.get(item_id))
                        .copied()
                        .unwrap_or(0);
                    let invested = rate
                        .checked_mul(accepted_seconds)
                        .ok_or_else(|| format!("research {item_id} schedule overflowed"))?;
                    let next = current
                        .checked_add(invested)
                        .ok_or_else(|| format!("research {item_id} progress overflowed"))?;
                    progress.insert(
                        item_id.clone(),
                        Value::Number(Number::from(i64::try_from(next).map_err(|_| {
                            format!("research {item_id} progress cannot be encoded")
                        })?)),
                    );
                }
            }
            ResearchSinkKind::Infinite { research_id, .. } => {
                let rate = research.consumed_units_per_second["universe_matrix"];
                let current = research.expected.infinite_progress[&research_id].progress;
                let next = current
                    .checked_add(
                        rate.checked_mul(accepted_seconds)
                            .ok_or_else(|| "infinite research schedule overflowed".to_owned())?,
                    )
                    .ok_or_else(|| "infinite research progress overflowed".to_owned())?;
                base.get_mut("endgame")
                    .and_then(Value::as_object_mut)
                    .and_then(|endgame| endgame.get_mut("infiniteResearch"))
                    .and_then(Value::as_object_mut)
                    .and_then(|progress| progress.get_mut(&research_id))
                    .and_then(Value::as_object_mut)
                    .ok_or_else(|| "infinite research progress entry disappeared".to_owned())?
                    .insert("progress".to_owned(), Value::String(next.to_string()));
            }
        }
        let next = capture_research_proof_snapshot(state)
            .map_err(|error| format!("committed research state is invalid: {error:#}"))?;
        certificate
            .research
            .as_mut()
            .expect("cloned research certificate remains installed")
            .expected = next;
    }
    if let Some(rocket) = dyson_rocket {
        let mut launches_by_system = MaterialTotals::new();
        for (system_id, rate) in &rocket.launches_per_second_by_system {
            let launched = rate
                .checked_mul(accepted_seconds)
                .ok_or_else(|| format!("dysonPlans.{system_id} rocket schedule overflowed"))?;
            if launched > 0 {
                launches_by_system.insert(system_id.clone(), launched);
            }
        }
        let launched = crate::dyson::apply_certified_rocket_launches(
            state.base_value_mut(),
            &launches_by_system,
        )
        .map_err(|error| format!("Dyson rocket commit failed: {error:#}"))?;
        let expected_launches = rocket
            .launches_per_second
            .checked_mul(accepted_seconds)
            .ok_or_else(|| "Dyson rocket schedule overflowed".to_owned())?;
        if launched != expected_launches {
            return Err(format!(
                "Dyson rocket commit launched {launched} instead of {expected_launches}"
            ));
        }
        application.rockets_launched = launched;
        let next = capture_dyson_terminal(state.base_value())
            .map_err(|error| format!("committed Dyson rocket state is invalid: {error:#}"))?;
        certificate
            .dyson_rocket
            .as_mut()
            .expect("cloned Dyson rocket certificate remains installed")
            .expected = next;
    }
    if let Some(sail) = dyson_sail {
        let before = capture_dyson_terminal(state.base_value())
            .map_err(|error| format!("Dyson solar-sail pre-commit state is invalid: {error:#}"))?;
        let launched = crate::dyson::apply_certified_sail_launch_schedule(
            state.base_value_mut(),
            &sail.launches_per_second_by_orbit,
            accepted_seconds,
        )
        .map_err(|error| format!("Dyson solar-sail commit failed: {error:#}"))?;
        let expected_launches = sail
            .launches_per_second
            .checked_mul(accepted_seconds)
            .ok_or_else(|| "Dyson solar-sail schedule overflowed".to_owned())?;
        if launched != expected_launches {
            return Err(format!(
                "Dyson solar-sail commit launched {launched} instead of {expected_launches}"
            ));
        }
        let next = capture_dyson_terminal(state.base_value())
            .map_err(|error| format!("committed Dyson solar-sail state is invalid: {error:#}"))?;
        application.sails_launched = launched;
        application.sails_expired = next
            .sails_expired
            .checked_sub(before.sails_expired)
            .ok_or_else(|| "Dyson solar-sail expiry schedule overflowed".to_owned())?;
        application.sails_absorbed = next
            .sails_absorbed
            .checked_sub(before.sails_absorbed)
            .ok_or_else(|| "Dyson solar-sail absorption schedule overflowed".to_owned())?;
        certificate
            .dyson_sail
            .as_mut()
            .expect("cloned Dyson solar-sail certificate remains installed")
            .expected = next;
    }
    Ok(application)
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
    validate_internal_exact_snapshots(before, &after, &candidate.catalog)?;
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
/// The compact settlement proof closes aggregate ownership, production,
/// audited grants/consumption and Dyson terminal deltas before any candidate
/// commits. Macro-v10 additionally admits a narrow three-window certificate
/// for exclusive infinite-vein source flow backed only by non-fuel power. A
/// stricter slice may also close an acyclic ordinary-recipe DAG whose root
/// inputs are funded by those sources and whose shared intermediates balance
/// exactly. Its tail writes only non-negative net ownership into bounded
/// quantum inventory while crediting gross `totalProduced` from the runtime
/// produced/consumed ledger. A separately proven matrix-lab sink may advance
/// only the currently selected finite technology or infinite-research level,
/// clipped before completion, rewards or switching. A separately proven
/// carrier-rocket sink may launch only same-window manufactured whole rockets,
/// update matching per-system plans and rederive Dyson power. Alternatively a
/// solar-sail sink may consume only same-window manufactured whole sails and
/// feed a stable per-orbit launch schedule into the native decay/absorption
/// lifecycle. Starting launcher inventories are never renewable sources.
/// Finite resources, stored/fuel energy, construction and every other terminal
/// remain frozen.
pub(crate) fn advance(
    state: &mut CoreState,
    request: &CoreAdvanceRequest,
) -> anyhow::Result<CoreAdvanceResult> {
    advance_bounded(state, request, false)
}

/// New wire-distinct macro mode. It retains the deterministic 3x10-second
/// calibration boundary and can settle only the source or closed recipe-DAG
/// ordinary flow plus its explicitly closed research/rocket sinks authorized
/// by `OrdinaryFlowCertificate`; all other tail domains freeze.
pub(crate) fn advance_macro_v10(
    state: &mut CoreState,
    request: &CoreAdvanceRequest,
) -> anyhow::Result<CoreAdvanceResult> {
    advance_bounded(state, request, true)
}

fn advance_bounded(
    state: &mut CoreState,
    request: &CoreAdvanceRequest,
    macro_v10: bool,
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

    let exact_seconds_used_before = if macro_v10 {
        state.pure_idle_macro_exact_seconds_used()
    } else {
        state.pure_idle_exact_seconds_used()
    };
    let mut macro_runtime = macro_v10.then(|| {
        state
            .pure_idle_macro_runtime
            .as_ref()
            .filter(|runtime| runtime.last_committed_revision == state.revision)
            .cloned()
            .unwrap_or_else(|| {
                if exact_seconds_used_before <= EPSILON {
                    PureIdleMacroRuntimeCache::starts_at(state.revision, settlement_before.clone())
                } else {
                    PureIdleMacroRuntimeCache::missing_prefix(state.revision)
                }
            })
    });
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
        let mut remaining_exact = exact_seconds;
        let mut calibrated_before = exact_seconds_used_before;
        while remaining_exact > EPSILON {
            let slice_seconds = if macro_v10 {
                let in_window = calibrated_before % MACRO_V10_CALIBRATION_WINDOW_SECONDS;
                let window_remaining = if in_window <= EPSILON {
                    MACRO_V10_CALIBRATION_WINDOW_SECONDS
                } else {
                    MACRO_V10_CALIBRATION_WINDOW_SECONDS - in_window
                };
                remaining_exact.min(window_remaining)
            } else {
                remaining_exact
            };
            let slice_wall_seconds = if exact_seconds > EPSILON {
                exact_wall_seconds * slice_seconds / exact_seconds
            } else {
                exact_wall_seconds
            };
            let mut exact = candidate.advance_exact(&exact_request(
                candidate.revision,
                slice_seconds,
                slice_wall_seconds,
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
            exact_changed |= exact.changed;
            if exact.belt_scheduler.is_some() {
                belt_scheduler = exact.belt_scheduler.take();
            }
            remaining_exact = (remaining_exact - slice_seconds).max(0.0);
            calibrated_before += slice_seconds;
            if macro_v10 {
                let boundary = (calibrated_before / MACRO_V10_CALIBRATION_WINDOW_SECONDS).round();
                let at_boundary =
                    (calibrated_before - boundary * MACRO_V10_CALIBRATION_WINDOW_SECONDS).abs()
                        <= EPSILON;
                let boundary = boundary.max(0.0) as usize;
                if at_boundary && (1..=3).contains(&boundary) {
                    let snapshot = match capture_settlement_snapshot(&candidate) {
                        Ok(snapshot) => snapshot,
                        Err(error) => {
                            return unsupported(
                                state,
                                request,
                                format!("pure-idle-calibration-snapshot-invalid: {error:#}"),
                            );
                        }
                    };
                    if let Some(runtime) = macro_runtime.as_mut() {
                        if runtime.calibration_snapshots.len() == boundary {
                            runtime.calibration_snapshots.push(snapshot);
                        } else if runtime.calibration_snapshots.len() != boundary + 1 {
                            runtime.calibration_snapshots.clear();
                            runtime.rejection_reason = Some(
                                "calibration snapshot sequence was interrupted; a disposable probe is required"
                                    .to_owned(),
                            );
                        }
                    }
                }
            }
        }
    }
    if let Some(reason) = budget_attestation_reason(&candidate, request) {
        // Exact settlement may have exhausted fuel or otherwise changed the
        // controller's powered multiplier. The disposable prefix and its
        // session-credit debit must not commit under the stale admission
        // snapshot, even when this request has no frozen tail.
        return unsupported(state, request, reason);
    }

    let exact_progress =
        (exact_seconds_used_before + exact_seconds).min(PURE_IDLE_SESSION_EXACT_CREDIT_SECONDS);
    if let Some(runtime) = macro_runtime.as_mut()
        && exact_progress + EPSILON >= PURE_IDLE_SESSION_EXACT_CREDIT_SECONDS
        && runtime.certificate.is_none()
    {
        let snapshots = if runtime.calibration_snapshots.len() == 4 {
            Ok(runtime.calibration_snapshots.clone())
        } else {
            exact_three_window_probe(&candidate, request)
        };
        match snapshots
            .and_then(|snapshots| build_ordinary_flow_certificate(&candidate, &snapshots))
        {
            Ok(certificate) => {
                runtime.certificate = Some(certificate);
                runtime.rejection_reason = None;
            }
            Err(reason) => {
                runtime.certificate = None;
                runtime.rejection_reason = Some(reason);
            }
        }
    }

    let tail_seconds = budget.frozen_tail_seconds;
    let mut tail_reason = None;
    if tail_seconds > EPSILON {
        let current_elapsed = candidate
            .base_value()
            .get("elapsedSeconds")
            .and_then(Value::as_f64)
            .unwrap_or(0.0);
        let elapsed = checked_elapsed_after_prefix(current_elapsed, tail_seconds)?;
        if let Some(runtime) = macro_runtime.as_mut() {
            if let Some(certificate) = runtime.certificate.as_mut() {
                let ordinary_application = match apply_ordinary_flow_certificate(
                    &mut candidate,
                    certificate,
                    current_elapsed,
                    elapsed,
                ) {
                    Ok(application) => application,
                    Err(reason) => {
                        return unsupported(
                            state,
                            request,
                            format!("pure-idle-ordinary-flow-rejected: {reason}"),
                        );
                    }
                };
                tail_reason = Some(
                    if ordinary_application.deposited_units > 0
                        || ordinary_application.rockets_launched > 0
                        || ordinary_application.sails_launched > 0
                    {
                        let scope = if ordinary_application.recipe_certified {
                            "acyclic closed ordinary recipe"
                        } else {
                            "source-only ordinary"
                        };
                        let research_scope = if ordinary_application.research_certified {
                            " the certified current-level research sink advanced without crossing its reward/switch boundary;"
                        } else {
                            " research remained frozen;"
                        };
                        let dyson_scope = if ordinary_application.rocket_certified {
                            format!(
                                " {} material-funded rocket(s) launched into certified per-system Dyson plans;",
                                ordinary_application.rockets_launched
                            )
                        } else if ordinary_application.sail_certified {
                            format!(
                                " {} material-funded solar sail(s) launched while the native lifecycle expired {} and absorbed {};",
                                ordinary_application.sails_launched,
                                ordinary_application.sails_expired,
                                ordinary_application.sails_absorbed,
                            )
                        } else {
                            " Dyson rocket and sail terminals remained frozen;".to_owned()
                        };
                        format!(
                            "certified {} {scope} item(s) deposited {} net unit(s) into bounded quantum inventory from {} gross production and {} internal consumption;{dyson_scope}{research_scope} construction and other terminal tails remained frozen{}",
                            ordinary_application.certified_items,
                            ordinary_application.deposited_units,
                            ordinary_application.produced_units,
                            ordinary_application.consumed_units,
                            if ordinary_application.capacity_limited {
                                " at the proven capacity horizon"
                            } else {
                                ""
                            }
                        )
                    } else if ordinary_application.research_certified
                        && ordinary_application.produced_units > 0
                    {
                        format!(
                            "certified current-level research sink consumed closed ordinary production without net quantum deposit; it stopped before completion, rewards or switching{}",
                            if ordinary_application.capacity_limited {
                                " at the proven research/capacity horizon"
                            } else {
                                ""
                            }
                        )
                    } else {
                        "certified ordinary flow reached its closed quantum/production capacity horizon; every material-bearing tail remained frozen".to_owned()
                    },
                );
            } else {
                tail_reason = Some(format!(
                    "ordinary-flow tail froze because no closed three-window certificate was available: {}",
                    runtime
                        .rejection_reason
                        .as_deref()
                        .unwrap_or("calibration was incomplete")
                ));
            }
        }
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
        if macro_v10 {
            candidate.install_pure_idle_macro_session_progress(exact_progress)?;
        } else {
            candidate.install_pure_idle_session_progress(exact_progress)?;
        }
    }

    if let Some(mut runtime) = macro_runtime {
        runtime.last_committed_revision = candidate.revision;
        candidate.pure_idle_macro_runtime = Some(runtime);
    } else if !macro_v10 {
        candidate.pure_idle_macro_runtime = None;
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
        exact_scope: if tail_seconds > EPSILON && macro_v10 {
            "pure-idle-macro-v10"
        } else if tail_seconds > EPSILON {
            "pure-idle-conservative-v2"
        } else {
            "pure-idle-bounded-exact"
        },
        changed,
        previous_revision,
        revision,
        reason: (tail_seconds > EPSILON).then(|| {
            tail_reason.unwrap_or_else(|| {
                "unproven pure-idle tail froze material-bearing systems after the session's bounded 30-second exact credit".to_owned()
            })
        }),
        algorithm_version: Some(algorithm_version(request.advance_mode)),
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
        ItemDefinition, PlanetDefinition, RecipeDefinition, RuntimeCatalog, TechnologyDefinition,
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
                items: [
                    "iron_ore",
                    "iron_ingot",
                    "iron_gear",
                    "magnet",
                    "electromagnetic_matrix",
                    "energy_matrix",
                    "universe_matrix",
                    "solar_sail",
                    "small_carrier_rocket",
                ]
                .into_iter()
                .map(|id| ItemDefinition {
                    id: id.into(),
                    name: id.into(),
                    kind: "solid".into(),
                    fuel_energy_mj: 0.0,
                })
                .collect(),
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
                    BuildingDefinition {
                        id: "arc_smelter".into(),
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
                        family: Some("smelter".into()),
                        accepts: None,
                    },
                    BuildingDefinition {
                        id: "matrix_lab".into(),
                        kind: "machine".into(),
                        speed: 1.0,
                        input_capacity: 1_000_000.0,
                        output_capacity: 0.0,
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
                        id: "assembling_machine_mk1".into(),
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
                        family: Some("assembler".into()),
                        accepts: None,
                    },
                    BuildingDefinition {
                        id: "em_rail_ejector".into(),
                        kind: "machine".into(),
                        speed: 1.0,
                        input_capacity: 1_000_000.0,
                        output_capacity: 0.0,
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
                        id: "vertical_launching_silo".into(),
                        kind: "machine".into(),
                        speed: 1.0,
                        input_capacity: 1_000_000.0,
                        output_capacity: 0.0,
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
                recipes: vec![
                    RecipeDefinition {
                        id: "iron_ingot".into(),
                        name: "iron_ingot".into(),
                        building_id: "arc_smelter".into(),
                        duration: 1.0,
                        required_tech_id: None,
                        recursive_priority: 0.0,
                        recursive_manufacturing: false,
                        inputs: vec![ItemAmount {
                            item_id: "iron_ore".into(),
                            amount: 1.0,
                        }],
                        outputs: vec![ItemAmount {
                            item_id: "iron_ingot".into(),
                            amount: 1.0,
                        }],
                    },
                    RecipeDefinition {
                        id: "iron_gear".into(),
                        name: "iron_gear".into(),
                        building_id: "arc_smelter".into(),
                        duration: 1.0,
                        required_tech_id: None,
                        recursive_priority: 0.0,
                        recursive_manufacturing: false,
                        inputs: vec![ItemAmount {
                            item_id: "iron_ingot".into(),
                            amount: 1.0,
                        }],
                        outputs: vec![ItemAmount {
                            item_id: "iron_gear".into(),
                            amount: 1.0,
                        }],
                    },
                    RecipeDefinition {
                        id: "magnet".into(),
                        name: "magnet".into(),
                        building_id: "arc_smelter".into(),
                        duration: 1.0,
                        required_tech_id: None,
                        recursive_priority: 0.0,
                        recursive_manufacturing: false,
                        inputs: vec![ItemAmount {
                            item_id: "iron_ingot".into(),
                            amount: 1.0,
                        }],
                        outputs: vec![ItemAmount {
                            item_id: "magnet".into(),
                            amount: 1.0,
                        }],
                    },
                    RecipeDefinition {
                        id: "electromagnetic_matrix".into(),
                        name: "electromagnetic_matrix".into(),
                        building_id: "arc_smelter".into(),
                        duration: 1.0,
                        required_tech_id: None,
                        recursive_priority: 0.0,
                        recursive_manufacturing: false,
                        inputs: vec![ItemAmount {
                            item_id: "iron_ore".into(),
                            amount: 1.0,
                        }],
                        outputs: vec![ItemAmount {
                            item_id: "electromagnetic_matrix".into(),
                            amount: 1.0,
                        }],
                    },
                    RecipeDefinition {
                        id: "energy_matrix".into(),
                        name: "energy_matrix".into(),
                        building_id: "arc_smelter".into(),
                        duration: 1.0,
                        required_tech_id: None,
                        recursive_priority: 0.0,
                        recursive_manufacturing: false,
                        inputs: vec![ItemAmount {
                            item_id: "iron_ore".into(),
                            amount: 1.0,
                        }],
                        outputs: vec![ItemAmount {
                            item_id: "energy_matrix".into(),
                            amount: 1.0,
                        }],
                    },
                    RecipeDefinition {
                        id: "universe_matrix".into(),
                        name: "universe_matrix".into(),
                        building_id: "arc_smelter".into(),
                        duration: 1.0,
                        required_tech_id: None,
                        recursive_priority: 0.0,
                        recursive_manufacturing: false,
                        inputs: vec![ItemAmount {
                            item_id: "iron_ore".into(),
                            amount: 1.0,
                        }],
                        outputs: vec![ItemAmount {
                            item_id: "universe_matrix".into(),
                            amount: 1.0,
                        }],
                    },
                    RecipeDefinition {
                        id: "matrix_research".into(),
                        name: "matrix_research".into(),
                        building_id: "matrix_lab".into(),
                        duration: 1.0,
                        required_tech_id: None,
                        recursive_priority: 0.0,
                        recursive_manufacturing: false,
                        inputs: Vec::new(),
                        outputs: Vec::new(),
                    },
                    RecipeDefinition {
                        id: "solar_sail".into(),
                        name: "solar_sail".into(),
                        building_id: "assembling_machine_mk1".into(),
                        duration: 1.0,
                        required_tech_id: None,
                        recursive_priority: 0.0,
                        recursive_manufacturing: false,
                        inputs: vec![ItemAmount {
                            item_id: "iron_ore".into(),
                            amount: 1.0,
                        }],
                        outputs: vec![ItemAmount {
                            item_id: "solar_sail".into(),
                            amount: 1.0,
                        }],
                    },
                    RecipeDefinition {
                        id: "small_carrier_rocket".into(),
                        name: "small_carrier_rocket".into(),
                        building_id: "assembling_machine_mk1".into(),
                        duration: 1.0,
                        required_tech_id: None,
                        recursive_priority: 0.0,
                        recursive_manufacturing: false,
                        inputs: vec![ItemAmount {
                            item_id: "iron_ore".into(),
                            amount: 1.0,
                        }],
                        outputs: vec![ItemAmount {
                            item_id: "small_carrier_rocket".into(),
                            amount: 1.0,
                        }],
                    },
                    RecipeDefinition {
                        id: "solar_sail_launch".into(),
                        name: "solar_sail_launch".into(),
                        building_id: "em_rail_ejector".into(),
                        duration: 1.0,
                        required_tech_id: None,
                        recursive_priority: 0.0,
                        recursive_manufacturing: false,
                        inputs: vec![ItemAmount {
                            item_id: "solar_sail".into(),
                            amount: 1.0,
                        }],
                        outputs: Vec::new(),
                    },
                    RecipeDefinition {
                        id: "carrier_rocket_launch".into(),
                        name: "carrier_rocket_launch".into(),
                        building_id: "vertical_launching_silo".into(),
                        duration: 1.0,
                        required_tech_id: None,
                        recursive_priority: 0.0,
                        recursive_manufacturing: false,
                        inputs: vec![ItemAmount {
                            item_id: "small_carrier_rocket".into(),
                            amount: 1.0,
                        }],
                        outputs: Vec::new(),
                    },
                ],
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
                technologies: vec![
                    TechnologyDefinition {
                        id: "test_matrix_research".into(),
                        name: "test_matrix_research".into(),
                        costs: vec![ItemAmount {
                            item_id: "electromagnetic_matrix".into(),
                            amount: 1_000.0,
                        }],
                        prerequisites: Vec::new(),
                        construction_rewards: vec!["test_building".into()],
                    },
                    TechnologyDefinition {
                        id: "test_multi_matrix_research".into(),
                        name: "test_multi_matrix_research".into(),
                        costs: vec![
                            ItemAmount {
                                item_id: "electromagnetic_matrix".into(),
                                amount: 40.0,
                            },
                            ItemAmount {
                                item_id: "energy_matrix".into(),
                                amount: 1_000.0,
                            },
                        ],
                        prerequisites: Vec::new(),
                        construction_rewards: Vec::new(),
                    },
                    TechnologyDefinition {
                        id: "universe_matrix".into(),
                        name: "universe_matrix".into(),
                        costs: vec![ItemAmount {
                            item_id: "universe_matrix".into(),
                            amount: 1.0,
                        }],
                        prerequisites: Vec::new(),
                        construction_rewards: Vec::new(),
                    },
                ],
            },
            "pure-idle-test",
        )
        .unwrap()
    }

    fn fixture_catalog_with_outpost() -> RuntimeCatalog {
        let mut snapshot = fixture_catalog().snapshot;
        snapshot.planets.push(PlanetDefinition {
            id: "outpost".into(),
            name: "outpost".into(),
            system_id: "borealis".into(),
            kind: "terrestrial".into(),
            orbit_index: 1,
            simulation_order: 1,
            orbital_yields: HashMap::new(),
        });
        RuntimeCatalog::validate(snapshot, "pure-idle-test").unwrap()
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

    fn fixture_state_from_parts_with_belts(
        base: Value,
        entities: Vec<Value>,
        belts: Vec<Value>,
    ) -> CoreState {
        fixture_state_from_parts_with_belts_and_catalog(base, entities, belts, fixture_catalog())
    }

    fn fixture_state_from_parts_with_belts_and_catalog(
        base: Value,
        entities: Vec<Value>,
        belts: Vec<Value>,
        catalog: RuntimeCatalog,
    ) -> CoreState {
        let base = serde_json::to_vec(&base).unwrap();
        let entity_count = entities.len();
        let entities = serde_json::to_vec(&entities).unwrap();
        let belt_count = belts.len();
        let belts = serde_json::to_vec(&belts).unwrap();
        let chunks = [
            ("base", "base", &base, 0, 1),
            ("entities:00000000", "entities", &entities, 0, entity_count),
            ("belts:00000000", "belts", &belts, 0, belt_count),
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
            "beltCount": belt_count,
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
            catalog,
        )
        .unwrap()
    }

    fn fixture_state_from_parts(base: Value, entities: Vec<Value>) -> CoreState {
        fixture_state_from_parts_with_belts(base, entities, Vec::new())
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

    fn productive_quantum_macro_fixture(multiplier: f64, resource_mode: &str) -> CoreState {
        let mut state = productive_powered_fixture(multiplier, resource_mode);
        state.base_value_mut()["quantumLogisticsNetwork"]["enabled"] = json!(true);
        state.base_value_mut()["quantumLogisticsNetwork"]["itemCapacities"] =
            json!({ "iron_ore": "10000000000" });
        state
    }

    fn productive_single_recipe_macro_fixture(
        multiplier: f64,
        recipe_id: &str,
        output_item_id: &str,
        include_sail_launcher: bool,
    ) -> CoreState {
        let mut base = powered_fixture_base(multiplier, "infinite");
        base["campaign"]["completedTaskIds"] = json!([
            "mine_first_ore",
            "smelt_iron",
            "deploy_miner",
            "lay_first_belt"
        ]);
        base["campaign"]["rewardedTaskIds"] = json!([
            "mine_first_ore",
            "smelt_iron",
            "deploy_miner",
            "lay_first_belt"
        ]);
        base["quantumLogisticsNetwork"]["enabled"] = json!(true);
        base["quantumLogisticsNetwork"]["itemCapacities"] = json!({
            "iron_ore": "10000000000",
            output_item_id: "10000000000"
        });
        let mut entities = vec![
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
            json!({
                "id": "smelter",
                "kind": "machine",
                "planetId": "home",
                "powerGridId": "grid-a",
                "buildingId": if recipe_id == "solar_sail" {
                    "assembling_machine_mk1"
                } else {
                    "arc_smelter"
                },
                "recipeId": recipe_id,
                "machineCount": 1,
                "minerCount": 0,
                "inputs": { "iron_ore": 20 },
                "outputs": { output_item_id: 0 },
                "progress": 0,
                "routingCursor": 0,
                "utilization": 0,
                "productionRate": 0
            }),
        ];
        if include_sail_launcher {
            entities.push(json!({
                "id": "sail-ejector",
                "kind": "machine",
                "planetId": "home",
                "powerGridId": "grid-a",
                "buildingId": "em_rail_ejector",
                "recipeId": "solar_sail_launch",
                "targetDysonOrbitId": "test-orbit-helios",
                "machineCount": 1,
                "minerCount": 0,
                "inputs": { "solar_sail": 10_000 },
                "outputs": {},
                "progress": 0,
                "routingCursor": 0,
                "utilization": 0,
                "productionRate": 0,
                "sprayCoaterInstalled": false
            }));
        }
        fixture_state_from_parts_with_belts(
            base,
            entities,
            vec![json!({
                "id": "ore-feed",
                "planetId": "home",
                "source": "vein",
                "target": "smelter",
                "itemId": "iron_ore",
                "lanes": 1,
                "tier": 1,
                "priority": 1,
                "progress": 0,
                "lastFlow": 0,
                "totalTransferred": 0
            })],
        )
    }

    fn productive_closed_recipe_macro_fixture(multiplier: f64) -> CoreState {
        productive_single_recipe_macro_fixture(multiplier, "iron_ingot", "iron_ingot", false)
    }

    fn productive_solar_sail_product_macro_fixture(multiplier: f64) -> CoreState {
        productive_single_recipe_macro_fixture(multiplier, "solar_sail", "solar_sail", false)
    }

    fn productive_solar_sail_launch_macro_fixture(multiplier: f64) -> CoreState {
        productive_single_recipe_macro_fixture(multiplier, "solar_sail", "solar_sail", true)
    }

    fn productive_rocket_macro_fixture(
        multiplier: f64,
        resource_mode: &str,
        systems: usize,
        rocket_producer_count: i64,
        prefilled_rockets_per_silo: i64,
    ) -> CoreState {
        assert!((1..=2).contains(&systems));
        let mut base = powered_fixture_base(multiplier, resource_mode);
        base["campaign"]["completedTaskIds"] = json!([
            "mine_first_ore",
            "smelt_iron",
            "deploy_miner",
            "lay_first_belt"
        ]);
        base["campaign"]["rewardedTaskIds"] = json!([
            "mine_first_ore",
            "smelt_iron",
            "deploy_miner",
            "lay_first_belt"
        ]);
        base["quantumLogisticsNetwork"]["enabled"] = json!(true);
        base["quantumLogisticsNetwork"]["itemCapacities"] = json!({
            "iron_ore": "10000000000",
            "small_carrier_rocket": "10000000000"
        });
        if systems == 2 {
            base["planetTrays"]["outpost"] = json!({});
            base["planetTrayItemLimits"]["outpost"] = json!(1_000_000);
            base["planetMetrics"]["outpost"] = json!({});
            base["powerGridMetrics"]["outpost"] = json!({});
            base["exploration"]["colonizedPlanetIds"] = json!(["home", "outpost"]);
            base["exploration"]["unlockedSystemIds"] = json!(["helios", "borealis"]);
            base["exploration"]["surveyProgressBySystem"]["borealis"] = json!(1);
            base["galaxy"]["profiles"]["outpost"] = json!({
                "windMultiplier": 1,
                "solarMultiplier": 1,
                "geothermalMultiplier": 1,
                "miningMultiplier": 1,
                "productionSpeedMultiplier": 1,
                "specialization": "balanced",
                "oceanType": "none"
            });
        }

        let mut entities = vec![
            json!({
                "id": "wind", "kind": "power", "planetId": "home",
                "powerGridId": "grid-a", "buildingId": "wind_turbine",
                "machineCount": 1, "minerCount": 0, "inputs": {}, "outputs": {},
                "progress": 0, "routingCursor": 0, "utilization": 0,
                "productionRate": 0
            }),
            json!({
                "id": "controller", "kind": "machine", "planetId": "home",
                "powerGridId": "grid-a", "buildingId": "time_warp_device",
                "machineCount": 1, "minerCount": 0, "inputs": {}, "outputs": {},
                "progress": 0, "routingCursor": 0, "utilization": 1,
                "productionRate": 0
            }),
            json!({
                "id": "vein", "kind": "vein", "planetId": "home",
                "powerGridId": "grid-a", "resourceId": "iron_ore",
                "extractorBuildingId": "mining_machine",
                "minerCount": rocket_producer_count * 2,
                "inputs": {}, "outputs": { "iron_ore": 0 },
                "resourceCapacity": 1_000_000, "resourceRemaining": 1_000_000,
                "resourceDepletionRemainder": 0, "progress": 0,
                "routingCursor": 0, "utilization": 0, "productionRate": 0
            }),
            json!({
                "id": "rocket-assembler", "kind": "machine", "planetId": "home",
                "powerGridId": "grid-a", "buildingId": "assembling_machine_mk1",
                "recipeId": "small_carrier_rocket",
                "machineCount": rocket_producer_count, "minerCount": 0,
                "inputs": { "iron_ore": 100_000 },
                "outputs": { "small_carrier_rocket": 0 },
                "progress": 0, "routingCursor": 0, "utilization": 0,
                "productionRate": 0, "sprayCoaterInstalled": false
            }),
            json!({
                "id": "helios-silo", "kind": "machine", "planetId": "home",
                "powerGridId": "grid-a", "buildingId": "vertical_launching_silo",
                "recipeId": "carrier_rocket_launch", "machineCount": 1,
                "minerCount": 0,
                "inputs": { "small_carrier_rocket": prefilled_rockets_per_silo },
                "outputs": {}, "progress": 0, "routingCursor": 0,
                "utilization": 0, "productionRate": 0,
                "sprayCoaterInstalled": false
            }),
        ];
        if systems == 2 {
            entities.extend([
                json!({
                    "id": "outpost-wind", "kind": "power", "planetId": "outpost",
                    "powerGridId": "grid-b", "buildingId": "wind_turbine",
                    "machineCount": 1, "minerCount": 0, "inputs": {}, "outputs": {},
                    "progress": 0, "routingCursor": 0, "utilization": 0,
                    "productionRate": 0
                }),
                json!({
                    "id": "borealis-silo", "kind": "machine", "planetId": "outpost",
                    "powerGridId": "grid-b", "buildingId": "vertical_launching_silo",
                    "recipeId": "carrier_rocket_launch", "machineCount": 1,
                    "minerCount": 0,
                    "inputs": { "small_carrier_rocket": prefilled_rockets_per_silo },
                    "outputs": {}, "progress": 0, "routingCursor": 0,
                    "utilization": 0, "productionRate": 0,
                    "sprayCoaterInstalled": false
                }),
            ]);
        }
        if systems == 2 {
            fixture_state_from_parts_with_belts_and_catalog(
                base,
                entities,
                Vec::new(),
                fixture_catalog_with_outpost(),
            )
        } else {
            fixture_state_from_parts(base, entities)
        }
    }

    #[derive(Clone, Copy)]
    enum ResearchFixtureMode {
        Finite,
        MultiInput,
        Infinite,
    }

    fn productive_research_macro_fixture(multiplier: f64, mode: ResearchFixtureMode) -> CoreState {
        let mut base = powered_fixture_base(multiplier, "infinite");
        base["campaign"]["completedTaskIds"] = json!([
            "mine_first_ore",
            "smelt_iron",
            "deploy_miner",
            "lay_first_belt"
        ]);
        base["campaign"]["rewardedTaskIds"] = json!([
            "mine_first_ore",
            "smelt_iron",
            "deploy_miner",
            "lay_first_belt"
        ]);
        base["quantumLogisticsNetwork"]["enabled"] = json!(true);
        base["quantumLogisticsNetwork"]["itemCapacities"] = json!({
            "iron_ore": "10000000000",
            "electromagnetic_matrix": "10000000000",
            "energy_matrix": "10000000000",
            "universe_matrix": "10000000000"
        });
        let (technology_id, matrix_recipe_id, matrix_inputs, miner_count) = match mode {
            ResearchFixtureMode::Finite => {
                base["research"]["selectedTechId"] = json!("test_matrix_research");
                (
                    Some("test_matrix_research"),
                    "electromagnetic_matrix",
                    json!({ "electromagnetic_matrix": 10_000 }),
                    2,
                )
            }
            ResearchFixtureMode::MultiInput => {
                base["research"]["selectedTechId"] = json!("test_multi_matrix_research");
                base["research"]["progressByTech"] = json!({
                    "test_multi_matrix_research": { "electromagnetic_matrix": 40 }
                });
                (
                    Some("test_multi_matrix_research"),
                    "energy_matrix",
                    json!({ "electromagnetic_matrix": 0, "energy_matrix": 10_000 }),
                    2,
                )
            }
            ResearchFixtureMode::Infinite => {
                base["research"]["completedTechIds"] = json!(["universe_matrix"]);
                base["endgame"]["activeInfiniteResearchId"] = json!("matrix_compression");
                base["orbitalStation"] = json!({
                    "status": "locked",
                    "construction": { "stageRequirements": [] },
                    "contractBoard": {
                        "taskDay": 0,
                        "lastConfirmedWallClockMs": 0,
                        "offers": [],
                        "accepted": [],
                        "history": [],
                        "settledIds": []
                    },
                    "totals": { "exportedByItem": {} }
                });
                (
                    None,
                    "universe_matrix",
                    json!({ "universe_matrix": 10_000 }),
                    2,
                )
            }
        };
        let _ = technology_id;
        fixture_state_from_parts(
            base,
            vec![
                json!({
                    "id": "wind", "kind": "power", "planetId": "home",
                    "powerGridId": "grid-a", "buildingId": "wind_turbine",
                    "machineCount": 1, "minerCount": 0, "inputs": {}, "outputs": {},
                    "progress": 0, "routingCursor": 0, "utilization": 0,
                    "productionRate": 0
                }),
                json!({
                    "id": "controller", "kind": "machine", "planetId": "home",
                    "powerGridId": "grid-a", "buildingId": "time_warp_device",
                    "machineCount": 1, "minerCount": 0, "inputs": {}, "outputs": {},
                    "progress": 0, "routingCursor": 0, "utilization": 1,
                    "productionRate": 0
                }),
                json!({
                    "id": "vein", "kind": "vein", "planetId": "home",
                    "powerGridId": "grid-a", "resourceId": "iron_ore",
                    "extractorBuildingId": "mining_machine", "minerCount": miner_count,
                    "inputs": {}, "outputs": { "iron_ore": 0 },
                    "resourceCapacity": 1_000_000, "resourceRemaining": 1_000_000,
                    "resourceDepletionRemainder": 0, "progress": 0,
                    "routingCursor": 0, "utilization": 0, "productionRate": 0
                }),
                json!({
                    "id": "matrix-producer", "kind": "machine", "planetId": "home",
                    "powerGridId": "grid-a", "buildingId": "arc_smelter",
                    "recipeId": matrix_recipe_id, "machineCount": 1, "minerCount": 0,
                    "inputs": { "iron_ore": 10_000 },
                    "outputs": { matrix_recipe_id: 0 }, "progress": 0,
                    "routingCursor": 0, "utilization": 0, "productionRate": 0
                }),
                json!({
                    "id": "research-lab", "kind": "machine", "planetId": "home",
                    "powerGridId": "grid-a", "buildingId": "matrix_lab",
                    "recipeId": "matrix_research", "machineCount": 1, "minerCount": 0,
                    "inputs": matrix_inputs, "outputs": {}, "progress": 0,
                    "routingCursor": 0, "utilization": 0, "productionRate": 0,
                    "sprayCoaterInstalled": false
                }),
            ],
        )
    }

    fn productive_closed_recipe_dag_macro_fixture(multiplier: f64) -> CoreState {
        let mut base = powered_fixture_base(multiplier, "infinite");
        base["campaign"]["completedTaskIds"] = json!([
            "mine_first_ore",
            "smelt_iron",
            "deploy_miner",
            "lay_first_belt"
        ]);
        base["campaign"]["rewardedTaskIds"] = json!([
            "mine_first_ore",
            "smelt_iron",
            "deploy_miner",
            "lay_first_belt"
        ]);
        base["quantumLogisticsNetwork"]["enabled"] = json!(true);
        base["quantumLogisticsNetwork"]["itemCapacities"] = json!({
            "iron_ore": "10000000000",
            "iron_ingot": "10000000000",
            "iron_gear": "10000000000",
            "magnet": "10000000000"
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
                    "id": "vein",
                    "kind": "vein",
                    "planetId": "home",
                    "powerGridId": "grid-a",
                    "resourceId": "iron_ore",
                    "extractorBuildingId": "mining_machine",
                    "minerCount": 4,
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
                // Consumers deliberately precede their producer. The proof
                // must retain this persisted order while using a separate
                // stable topological traversal for certification.
                json!({
                    "id": "magnet-smelter",
                    "kind": "machine",
                    "planetId": "home",
                    "powerGridId": "grid-a",
                    "buildingId": "arc_smelter",
                    "recipeId": "magnet",
                    "machineCount": 1,
                    "minerCount": 0,
                    "inputs": { "iron_ingot": 1000 },
                    "outputs": { "magnet": 0 },
                    "progress": 0,
                    "routingCursor": 0,
                    "utilization": 0,
                    "productionRate": 0
                }),
                json!({
                    "id": "ingot-smelter",
                    "kind": "machine",
                    "planetId": "home",
                    "powerGridId": "grid-a",
                    "buildingId": "arc_smelter",
                    "recipeId": "iron_ingot",
                    "machineCount": 2,
                    "minerCount": 0,
                    "inputs": { "iron_ore": 1000 },
                    "outputs": { "iron_ingot": 0 },
                    "progress": 0,
                    "routingCursor": 0,
                    "utilization": 0,
                    "productionRate": 0
                }),
                json!({
                    "id": "gear-smelter",
                    "kind": "machine",
                    "planetId": "home",
                    "powerGridId": "grid-a",
                    "buildingId": "arc_smelter",
                    "recipeId": "iron_gear",
                    "machineCount": 1,
                    "minerCount": 0,
                    "inputs": { "iron_ingot": 1000 },
                    "outputs": { "iron_gear": 0 },
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

    fn pure_idle_macro_request(
        revision: u64,
        simulation_seconds: f64,
        wall_seconds: f64,
    ) -> CoreAdvanceRequest {
        CoreAdvanceRequest {
            base_revision: revision,
            simulation_seconds,
            wall_seconds,
            advance_mode: CoreAdvanceMode::PureIdleMacroV10,
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

    #[test]
    fn macro_v10_uses_three_ten_second_windows_and_freezes_the_unproved_tail() {
        for multiplier in [8.0, 12.0, 15.0, 16.0] {
            let initial = productive_powered_fixture(multiplier, "infinite");
            let mut prefix = initial.clone();
            let prefix_revision = prefix.revision;
            let prefix_result = advance_macro_v10(
                &mut prefix,
                &pure_idle_macro_request(prefix_revision, 30.0, 30.0 / multiplier),
            )
            .unwrap();
            assert!(prefix_result.supported, "reason={:?}", prefix_result.reason);
            assert_eq!(prefix_result.revision, prefix_revision + 3);
            assert_eq!(prefix_result.exact_calibration_seconds, Some(30.0));
            assert_eq!(prefix.pure_idle_macro_exact_seconds_used(), 30.0);
            assert_eq!(prefix.pure_idle_exact_seconds_used(), 0.0);

            let mut long = initial.clone();
            let long_revision = long.revision;
            let long_result = advance_macro_v10(
                &mut long,
                &pure_idle_macro_request(long_revision, 60.0, 60.0 / multiplier),
            )
            .unwrap();
            assert!(long_result.supported, "reason={:?}", long_result.reason);
            assert_eq!(long_result.exact_scope, "pure-idle-macro-v10");
            assert_eq!(
                long_result.algorithm_version,
                Some(MACRO_V10_ALGORITHM_VERSION)
            );
            assert_eq!(long_result.approximated_seconds, Some(30.0));

            let mut segmented = initial;
            for seconds in [10.0, 20.0, 30.0] {
                let revision = segmented.revision;
                let result = advance_macro_v10(
                    &mut segmented,
                    &pure_idle_macro_request(revision, seconds, seconds / multiplier),
                )
                .unwrap();
                assert!(result.supported, "reason={:?}", result.reason);
            }

            let prefix_state = prefix.materialize().unwrap();
            let long_state = long.materialize().unwrap();
            assert_eq!(long_state["totalProduced"], prefix_state["totalProduced"]);
            assert_eq!(long_state["entities"], prefix_state["entities"]);
            assert_eq!(long_state["elapsedSeconds"], json!(60.0));
            assert_eq!(
                segmented.summary().unwrap().canonical_sha256,
                long.summary().unwrap().canonical_sha256
            );
            assert_eq!(segmented.pure_idle_macro_exact_seconds_used(), 30.0);
        }
    }

    #[test]
    fn macro_v10_certifies_infinite_renewable_source_flow_into_quantum() {
        for multiplier in [8.0, 12.0, 15.0, 16.0] {
            let initial = productive_quantum_macro_fixture(multiplier, "infinite");
            let mut prefix = initial.clone();
            let prefix_revision = prefix.revision;
            let prefix_result = advance_macro_v10(
                &mut prefix,
                &pure_idle_macro_request(prefix_revision, 30.0, 30.0 / multiplier),
            )
            .unwrap();
            assert!(prefix_result.supported, "reason={:?}", prefix_result.reason);
            let prefix_state = prefix.materialize().unwrap();
            let prefix_produced = proof_counter(
                prefix_state["totalProduced"].get("iron_ore"),
                "prefix.totalProduced.iron_ore",
            )
            .unwrap();

            let mut long = initial.clone();
            let long_revision = long.revision;
            let long_result = advance_macro_v10(
                &mut long,
                &pure_idle_macro_request(long_revision, 60.0, 60.0 / multiplier),
            )
            .unwrap();
            assert!(long_result.supported, "reason={:?}", long_result.reason);
            assert!(
                long_result
                    .reason
                    .as_deref()
                    .is_some_and(|reason| reason.contains("source-only ordinary")),
                "reason={:?}",
                long_result.reason
            );
            let long_state = long.materialize().unwrap();
            let deposited = proof_counter(
                long_state["quantumLogisticsNetwork"]["inventory"].get("iron_ore"),
                "long.quantum.iron_ore",
            )
            .unwrap();
            let long_produced = proof_counter(
                long_state["totalProduced"].get("iron_ore"),
                "long.totalProduced.iron_ore",
            )
            .unwrap();
            assert!(deposited > 0, "multiplier={multiplier}");
            assert_eq!(long_produced - prefix_produced, deposited);
            assert_eq!(long_state["entities"], prefix_state["entities"]);
            for frozen in [
                "research",
                "construction",
                "constructionAutomation",
                "dysonSwarm",
                "dysonSphere",
                "dysonEngineering",
                "dysonPlans",
                "endgame",
            ] {
                assert_eq!(
                    long_state[frozen], prefix_state[frozen],
                    "multiplier={multiplier} field={frozen}"
                );
            }

            let mut segmented = initial;
            for seconds in [10.0, 20.0, 30.0] {
                let revision = segmented.revision;
                let result = advance_macro_v10(
                    &mut segmented,
                    &pure_idle_macro_request(revision, seconds, seconds / multiplier),
                )
                .unwrap();
                assert!(result.supported, "reason={:?}", result.reason);
            }
            assert_eq!(
                segmented.summary().unwrap().canonical_sha256,
                long.summary().unwrap().canonical_sha256,
                "multiplier={multiplier}"
            );
        }
    }

    #[test]
    fn macro_v10_certifies_finite_research_sink_at_supported_multipliers() {
        for multiplier in [8.0, 12.0, 15.0, 16.0] {
            let initial =
                productive_research_macro_fixture(multiplier, ResearchFixtureMode::Finite);
            let request = pure_idle_macro_request(initial.revision, 600.0, 600.0 / multiplier);
            let snapshots = exact_three_window_probe(&initial, &request).unwrap();
            let certificate = build_ordinary_flow_certificate(&initial, &snapshots).unwrap();
            let research = certificate.research.as_ref().expect("finite research sink");
            assert_eq!(
                research.consumed_units_per_second,
                BTreeMap::from([("electromagnetic_matrix".to_owned(), 1)])
            );

            let mut prefix = initial.clone();
            let revision = prefix.revision;
            let result = advance_macro_v10(
                &mut prefix,
                &pure_idle_macro_request(revision, 30.0, 30.0 / multiplier),
            )
            .unwrap();
            assert!(result.supported, "reason={:?}", result.reason);
            let prefix_state = prefix.materialize().unwrap();

            let mut long = initial.clone();
            let result = advance_macro_v10(&mut long, &request).unwrap();
            assert!(result.supported, "reason={:?}", result.reason);
            let long_state = long.materialize().unwrap();
            assert_eq!(
                proof_counter(
                    long_state["research"]["progressByTech"]["test_matrix_research"]
                        .get("electromagnetic_matrix"),
                    "finite research progress",
                )
                .unwrap(),
                600
            );
            assert_eq!(long_state["entities"], prefix_state["entities"]);
            assert_eq!(long_state["research"]["completedTechIds"], json!([]));
            assert_eq!(
                long_state["research"]["selectedTechId"],
                json!("test_matrix_research")
            );
            assert_eq!(long_state["construction"], prefix_state["construction"]);

            let mut segmented = initial;
            for seconds in [10.0, 20.0, 190.0, 190.0, 190.0] {
                let revision = segmented.revision;
                let result = advance_macro_v10(
                    &mut segmented,
                    &pure_idle_macro_request(revision, seconds, seconds / multiplier),
                )
                .unwrap();
                assert!(result.supported, "reason={:?}", result.reason);
            }
            assert_eq!(
                segmented.summary().unwrap().canonical_sha256,
                long.summary().unwrap().canonical_sha256,
                "multiplier={multiplier}"
            );
        }
    }

    #[test]
    fn macro_v10_research_sink_stops_at_finite_or_infinite_boundary_without_rewards() {
        for (mode, expected_path, expected_value) in [
            (ResearchFixtureMode::Finite, "finite", 1_000_i128),
            (
                ResearchFixtureMode::Infinite,
                "infinite",
                i128::try_from(crate::infinite_research::cost("matrix_compression", 0).unwrap())
                    .unwrap(),
            ),
        ] {
            let initial = productive_research_macro_fixture(15.0, mode);
            let mut long = initial.clone();
            let revision = long.revision;
            let result = advance_macro_v10(
                &mut long,
                &pure_idle_macro_request(revision, 5_000.0, 5_000.0 / 15.0),
            )
            .unwrap();
            assert!(
                result.supported,
                "mode={expected_path} reason={:?}",
                result.reason
            );
            let state = long.materialize().unwrap();
            let progress = if expected_path == "finite" {
                proof_counter(
                    state["research"]["progressByTech"]["test_matrix_research"]
                        .get("electromagnetic_matrix"),
                    "finite boundary",
                )
                .unwrap()
            } else {
                proof_counter(
                    state["endgame"]["infiniteResearch"]["matrix_compression"].get("progress"),
                    "infinite boundary",
                )
                .unwrap()
            };
            assert_eq!(progress, expected_value, "mode={expected_path}");
            if expected_path == "finite" {
                assert_eq!(state["research"]["completedTechIds"], json!([]));
                assert_eq!(state["construction"]["test_building"], json!(0));
                assert_eq!(
                    state["research"]["selectedTechId"],
                    json!("test_matrix_research")
                );
            } else {
                assert_eq!(
                    state["endgame"]["infiniteResearch"]["matrix_compression"]["level"],
                    json!(0)
                );
                assert_eq!(state["endgame"]["galacticScore"], json!(0));
                assert_eq!(
                    state["endgame"]["activeInfiniteResearchId"],
                    json!("matrix_compression")
                );
            }

            let mut segmented = initial;
            for seconds in [30.0, 1000.0, 1000.0, 1000.0, 1000.0, 970.0] {
                let revision = segmented.revision;
                let result = advance_macro_v10(
                    &mut segmented,
                    &pure_idle_macro_request(revision, seconds, seconds / 15.0),
                )
                .unwrap();
                assert!(
                    result.supported,
                    "mode={expected_path} reason={:?}",
                    result.reason
                );
            }
            assert_eq!(
                segmented.summary().unwrap().canonical_sha256,
                long.summary().unwrap().canonical_sha256,
                "mode={expected_path}"
            );
        }
    }

    #[test]
    fn macro_v10_certifies_remaining_item_of_multi_input_research() {
        let initial = productive_research_macro_fixture(15.0, ResearchFixtureMode::MultiInput);
        let snapshots = exact_three_window_probe(
            &initial,
            &pure_idle_macro_request(initial.revision, 600.0, 40.0),
        )
        .unwrap();
        let certificate = build_ordinary_flow_certificate(&initial, &snapshots).unwrap();
        let research = certificate.research.unwrap();
        assert_eq!(
            research.consumed_units_per_second,
            BTreeMap::from([("energy_matrix".to_owned(), 1)])
        );

        let mut long = initial;
        let revision = long.revision;
        let result =
            advance_macro_v10(&mut long, &pure_idle_macro_request(revision, 600.0, 40.0)).unwrap();
        assert!(result.supported, "reason={:?}", result.reason);
        let state = long.materialize().unwrap();
        assert_eq!(
            state["research"]["progressByTech"]["test_multi_matrix_research"]["electromagnetic_matrix"],
            json!(40)
        );
        assert_eq!(
            state["research"]["progressByTech"]["test_multi_matrix_research"]["energy_matrix"],
            json!(600)
        );
    }

    #[test]
    fn macro_v10_research_sink_rejects_prefill_spray_and_unstable_progress() {
        let initial = productive_research_macro_fixture(15.0, ResearchFixtureMode::Finite);
        let request = pure_idle_macro_request(initial.revision, 600.0, 40.0);

        let mut prefilled = initial.clone();
        let mut producer = prefilled.parse_entity(3).unwrap();
        producer["machineCount"] = json!(0);
        prefilled.replace_entity_raw(3, serde_json::to_string(&producer).unwrap().into());
        prefilled.rebuild_indexes().unwrap();
        let snapshots = exact_three_window_probe(&prefilled, &request).unwrap();
        let rejection = build_ordinary_flow_certificate(&prefilled, &snapshots).unwrap_err();
        assert!(
            rejection.contains("depleted owned inventory")
                || rejection.contains("no certified infinite source or active producer"),
            "{rejection}"
        );

        let mut sprayed = initial.clone();
        let mut lab = sprayed.parse_entity(4).unwrap();
        lab["sprayCoaterInstalled"] = json!(true);
        sprayed.replace_entity_raw(4, serde_json::to_string(&lab).unwrap().into());
        sprayed.rebuild_indexes().unwrap();
        let snapshots = exact_three_window_probe(&sprayed, &request).unwrap();
        let rejection = build_ordinary_flow_certificate(&sprayed, &snapshots).unwrap_err();
        assert!(
            rejection.contains("spray") || rejection.contains("made no stable"),
            "{rejection}"
        );

        let snapshots = exact_three_window_probe(&initial, &request).unwrap();
        let mut unstable = snapshots.clone();
        *unstable[2]
            .research
            .finite_progress
            .get_mut("test_matrix_research")
            .unwrap()
            .get_mut("electromagnetic_matrix")
            .unwrap() += 1;
        let rejection = build_ordinary_flow_certificate(&initial, &unstable).unwrap_err();
        assert!(rejection.contains("unstable"), "{rejection}");
    }

    #[test]
    fn macro_v10_research_certificate_failure_is_atomic_and_checkpoint_reload_is_deterministic() {
        let mut calibrated = productive_research_macro_fixture(15.0, ResearchFixtureMode::Finite);
        let revision = calibrated.revision;
        let result = advance_macro_v10(
            &mut calibrated,
            &pure_idle_macro_request(revision, 30.0, 2.0),
        )
        .unwrap();
        assert!(result.supported, "reason={:?}", result.reason);

        let mut corrupted = calibrated.clone();
        corrupted
            .pure_idle_macro_runtime
            .as_mut()
            .and_then(|runtime| runtime.certificate.as_mut())
            .and_then(|certificate| certificate.research.as_mut())
            .expect("research certificate")
            .expected
            .galactic_score += 1;
        let before_hash = corrupted.summary().unwrap().canonical_sha256;
        let before_revision = corrupted.revision;
        let before_credit = corrupted.pure_idle_macro_exact_seconds_used();
        let result = advance_macro_v10(
            &mut corrupted,
            &pure_idle_macro_request(before_revision, 60.0, 4.0),
        )
        .unwrap();
        assert!(!result.supported);
        assert_eq!(corrupted.summary().unwrap().canonical_sha256, before_hash);
        assert_eq!(corrupted.revision, before_revision);
        assert_eq!(
            corrupted.pure_idle_macro_exact_seconds_used(),
            before_credit
        );

        let mut records = BTreeMap::<String, Vec<u8>>::new();
        calibrated
            .visit_internal_checkpoint_records(42, |key, value| {
                records.insert(key.to_owned(), value.as_bytes().to_vec());
                Ok(())
            })
            .unwrap();
        let mut identity = calibrated.identity.clone();
        identity.revision = calibrated.revision;
        let mut restored =
            CoreState::from_internal_records(identity, &records, (*calibrated.catalog).clone())
                .unwrap();
        assert!(restored.pure_idle_macro_runtime.is_none());
        for state in [&mut calibrated, &mut restored] {
            let revision = state.revision;
            let result =
                advance_macro_v10(state, &pure_idle_macro_request(revision, 570.0, 38.0)).unwrap();
            assert!(result.supported, "reason={:?}", result.reason);
        }
        assert_eq!(
            restored.summary().unwrap().canonical_sha256,
            calibrated.summary().unwrap().canonical_sha256
        );
    }

    #[test]
    fn macro_v10_certifies_material_funded_single_and_multi_system_rocket_sinks() {
        for (systems, producer_count, expected_rate) in [(1, 1, 1_i64), (2, 2, 2_i64)] {
            let mut state =
                productive_rocket_macro_fixture(15.0, "infinite", systems, producer_count, 1_000);
            let revision = state.revision;
            let result =
                advance_macro_v10(&mut state, &pure_idle_macro_request(revision, 600.0, 40.0))
                    .unwrap();
            assert!(result.supported, "reason={:?}", result.reason);
            assert_eq!(
                state.base_value()["totalProduced"]["small_carrier_rocket"],
                json!(expected_rate * 600)
            );
            assert_eq!(
                proof_counter(
                    state.base_value()["dysonSphere"].get("totalRocketsLaunched"),
                    "rockets",
                )
                .unwrap(),
                i128::from(expected_rate * 600)
            );
            assert_eq!(
                proof_counter(
                    state.base_value()["dysonSphere"].get("structurePoints"),
                    "structure",
                )
                .unwrap(),
                i128::from(expected_rate * 600)
            );
            assert_eq!(
                number_at(
                    state.base_value().get("dysonEngineering"),
                    &["launchEnergySpentMj"],
                ),
                (expected_rate * 600 * 108) as f64
            );
            assert_eq!(
                proof_counter(
                    state.base_value()["dysonPlans"]["helios"].get("structurePoints"),
                    "helios structure",
                )
                .unwrap(),
                600
            );
            assert_eq!(
                proof_counter(
                    state.base_value()["dysonPlans"]["borealis"].get("structurePoints"),
                    "borealis structure",
                )
                .unwrap(),
                if systems == 2 { 600 } else { 0 }
            );
            assert_eq!(
                proof_counter(
                    state.base_value()["dysonSwarm"].get("totalLaunched"),
                    "sails launched",
                )
                .unwrap(),
                0
            );
            assert_eq!(
                proof_counter(
                    state.base_value()["dysonSphere"].get("shellSails"),
                    "shell sails",
                )
                .unwrap(),
                0
            );
            let after = capture_settlement_snapshot(&state).unwrap();
            let before_state =
                productive_rocket_macro_fixture(15.0, "infinite", systems, producer_count, 1_000);
            let before = capture_settlement_snapshot(&before_state).unwrap();
            assert!(dyson_sail_state_unchanged(&before.dyson, &after.dyson));
            validate_settlement_proof(&before, &after, &state.catalog, None).unwrap();
        }
    }

    #[test]
    fn macro_v10_rocket_sink_never_replays_prefilled_launcher_inventory() {
        let mut underfunded = productive_rocket_macro_fixture(15.0, "infinite", 2, 1, 10_000);
        let revision = underfunded.revision;
        let result = advance_macro_v10(
            &mut underfunded,
            &pure_idle_macro_request(revision, 600.0, 40.0),
        )
        .unwrap();
        assert!(result.supported, "reason={:?}", result.reason);
        // The exact prefix may spend old silo inventory. The 570-second tail
        // is frozen because manufacturing covered only half the launch rate.
        assert_eq!(
            proof_counter(
                underfunded.base_value()["totalProduced"].get("small_carrier_rocket"),
                "underfunded rocket production",
            )
            .unwrap(),
            30
        );
        assert_eq!(
            capture_dyson_terminal(underfunded.base_value())
                .unwrap()
                .rockets_launched,
            60
        );
        assert!(
            result.reason.as_deref().is_some_and(|reason| {
                reason.contains("depleted owned inventory")
                    || reason.contains("same-window certified production")
            }),
            "reason={:?}",
            result.reason
        );

        let mut no_production = productive_rocket_macro_fixture(15.0, "infinite", 1, 0, 10_000);
        let revision = no_production.revision;
        let result = advance_macro_v10(
            &mut no_production,
            &pure_idle_macro_request(revision, 600.0, 40.0),
        )
        .unwrap();
        assert!(result.supported, "reason={:?}", result.reason);
        assert_eq!(
            capture_dyson_terminal(no_production.base_value())
                .unwrap()
                .rockets_launched,
            30
        );
        assert_eq!(
            proof_counter(
                no_production.base_value()["totalProduced"].get("small_carrier_rocket"),
                "stopped rocket production",
            )
            .unwrap(),
            0
        );

        let mut blocked = productive_rocket_macro_fixture(15.0, "infinite", 1, 1, 10_000);
        let mut assembler = blocked.parse_entity(3).unwrap();
        assembler["outputs"]["small_carrier_rocket"] = json!(1_000_000);
        blocked.replace_entity_raw(3, serde_json::to_string(&assembler).unwrap().into());
        blocked.rebuild_indexes().unwrap();
        let revision = blocked.revision;
        let result = advance_macro_v10(
            &mut blocked,
            &pure_idle_macro_request(revision, 600.0, 40.0),
        )
        .unwrap();
        assert!(result.supported, "reason={:?}", result.reason);
        assert_eq!(
            capture_dyson_terminal(blocked.base_value())
                .unwrap()
                .rockets_launched,
            30
        );
        assert_eq!(
            proof_counter(
                blocked.base_value()["totalProduced"].get("small_carrier_rocket"),
                "blocked rocket production",
            )
            .unwrap(),
            0
        );
    }

    #[test]
    fn macro_v10_rocket_sink_is_segment_invariant_at_supported_multipliers() {
        for multiplier in [8.0, 12.0, 15.0, 16.0] {
            let initial = productive_rocket_macro_fixture(multiplier, "infinite", 2, 2, 2_000);
            let mut long = initial.clone();
            let revision = long.revision;
            let result = advance_macro_v10(
                &mut long,
                &pure_idle_macro_request(revision, 600.0, 600.0 / multiplier),
            )
            .unwrap();
            assert!(
                result.supported,
                "multiplier={multiplier} reason={:?}",
                result.reason
            );

            let mut segmented = initial;
            for seconds in [30.0, 111.0, 59.0, 400.0] {
                let revision = segmented.revision;
                let result = advance_macro_v10(
                    &mut segmented,
                    &pure_idle_macro_request(revision, seconds, seconds / multiplier),
                )
                .unwrap();
                assert!(
                    result.supported,
                    "multiplier={multiplier} seconds={seconds} reason={:?}",
                    result.reason
                );
            }
            assert_eq!(
                segmented.summary().unwrap().canonical_sha256,
                long.summary().unwrap().canonical_sha256,
                "multiplier={multiplier}"
            );
        }
    }

    #[test]
    fn macro_v10_rocket_sink_freezes_finite_exhausted_unpowered_and_stopped_domains() {
        let mut finite = productive_rocket_macro_fixture(15.0, "finite", 1, 1, 1_000);
        let revision = finite.revision;
        let result =
            advance_macro_v10(&mut finite, &pure_idle_macro_request(revision, 600.0, 40.0))
                .unwrap();
        assert!(result.supported, "reason={:?}", result.reason);
        assert_eq!(
            capture_dyson_terminal(finite.base_value())
                .unwrap()
                .rockets_launched,
            30
        );
        assert!(
            result
                .reason
                .as_deref()
                .is_some_and(|reason| reason.contains("finite"))
        );

        let mut exhausted = productive_rocket_macro_fixture(15.0, "infinite", 1, 1, 15);
        let revision = exhausted.revision;
        let result = advance_macro_v10(
            &mut exhausted,
            &pure_idle_macro_request(revision, 600.0, 40.0),
        )
        .unwrap();
        assert!(result.supported, "reason={:?}", result.reason);
        assert_eq!(
            capture_dyson_terminal(exhausted.base_value())
                .unwrap()
                .rockets_launched,
            15
        );

        for stopped_by_power in [false, true] {
            let mut stopped = productive_rocket_macro_fixture(15.0, "infinite", 1, 1, 1_000);
            if stopped_by_power {
                stopped.base_value_mut()["dysonEngineering"]["launchEnabled"] = json!(false);
            } else {
                let mut silo = stopped.parse_entity(4).unwrap();
                silo["machineCount"] = json!(0);
                stopped.replace_entity_raw(4, serde_json::to_string(&silo).unwrap().into());
                stopped.rebuild_indexes().unwrap();
            }
            let revision = stopped.revision;
            let result = advance_macro_v10(
                &mut stopped,
                &pure_idle_macro_request(revision, 600.0, 40.0),
            )
            .unwrap();
            assert!(result.supported, "reason={:?}", result.reason);
            assert_eq!(
                capture_dyson_terminal(stopped.base_value())
                    .unwrap()
                    .rockets_launched,
                0
            );
        }

        let mut unpowered = productive_rocket_macro_fixture(15.0, "infinite", 1, 1, 1_000);
        let mut wind = unpowered.parse_entity(0).unwrap();
        wind["machineCount"] = json!(0);
        unpowered.replace_entity_raw(0, serde_json::to_string(&wind).unwrap().into());
        unpowered.rebuild_indexes().unwrap();
        let before_hash = unpowered.summary().unwrap().canonical_sha256;
        let before_revision = unpowered.revision;
        let result = advance_macro_v10(
            &mut unpowered,
            &pure_idle_macro_request(before_revision, 600.0, 40.0),
        )
        .unwrap();
        assert!(!result.supported);
        assert_eq!(unpowered.summary().unwrap().canonical_sha256, before_hash);
        assert_eq!(unpowered.revision, before_revision);
    }

    #[test]
    fn macro_v10_rocket_sink_failure_is_atomic_and_checkpoint_reload_is_deterministic() {
        let mut calibrated = productive_rocket_macro_fixture(15.0, "infinite", 2, 2, 2_000);
        let revision = calibrated.revision;
        let result = advance_macro_v10(
            &mut calibrated,
            &pure_idle_macro_request(revision, 30.0, 2.0),
        )
        .unwrap();
        assert!(result.supported, "reason={:?}", result.reason);

        let mut corrupted = calibrated.clone();
        corrupted
            .pure_idle_macro_runtime
            .as_mut()
            .and_then(|runtime| runtime.certificate.as_mut())
            .and_then(|certificate| certificate.dyson_rocket.as_mut())
            .expect("rocket certificate")
            .expected
            .rockets_launched += 1;
        let before_hash = corrupted.summary().unwrap().canonical_sha256;
        let before_revision = corrupted.revision;
        let before_credit = corrupted.pure_idle_macro_exact_seconds_used();
        let result = advance_macro_v10(
            &mut corrupted,
            &pure_idle_macro_request(before_revision, 60.0, 4.0),
        )
        .unwrap();
        assert!(!result.supported);
        assert_eq!(corrupted.summary().unwrap().canonical_sha256, before_hash);
        assert_eq!(corrupted.revision, before_revision);
        assert_eq!(
            corrupted.pure_idle_macro_exact_seconds_used(),
            before_credit
        );

        let mut records = BTreeMap::<String, Vec<u8>>::new();
        calibrated
            .visit_internal_checkpoint_records(42, |key, value| {
                records.insert(key.to_owned(), value.as_bytes().to_vec());
                Ok(())
            })
            .unwrap();
        let mut identity = calibrated.identity.clone();
        identity.revision = calibrated.revision;
        let mut restored =
            CoreState::from_internal_records(identity, &records, (*calibrated.catalog).clone())
                .unwrap();
        assert!(restored.pure_idle_macro_runtime.is_none());
        for state in [&mut calibrated, &mut restored] {
            let revision = state.revision;
            let result =
                advance_macro_v10(state, &pure_idle_macro_request(revision, 570.0, 38.0)).unwrap();
            assert!(result.supported, "reason={:?}", result.reason);
        }
        assert_eq!(
            restored.summary().unwrap().canonical_sha256,
            calibrated.summary().unwrap().canonical_sha256
        );
    }

    #[test]
    fn certified_rocket_helper_stops_at_the_safe_generation_horizon_atomically() {
        let mut value = powered_fixture_base(15.0, "infinite");
        let base = value.as_object_mut().unwrap();
        let near_generation_limit = MAX_SAFE_INTEGER as i128 / 960 - 2;
        base.get_mut("dysonPlans")
            .and_then(Value::as_object_mut)
            .and_then(|plans| plans.get_mut("helios"))
            .and_then(Value::as_object_mut)
            .unwrap()
            .insert(
                "structurePoints".to_owned(),
                json!(near_generation_limit as f64),
            );
        base.get_mut("dysonSphere")
            .and_then(Value::as_object_mut)
            .unwrap()
            .insert(
                "structurePoints".to_owned(),
                json!(near_generation_limit as f64),
            );
        base.get_mut("dysonSphere")
            .and_then(Value::as_object_mut)
            .unwrap()
            .insert(
                "totalRocketsLaunched".to_owned(),
                json!(near_generation_limit as f64),
            );
        base.get_mut("dysonEngineering")
            .and_then(Value::as_object_mut)
            .unwrap()
            .insert(
                "launchEnergySpentMj".to_owned(),
                json!((near_generation_limit * 108) as f64),
            );
        crate::dyson::finalize(base).unwrap();

        let one_per_second = BTreeMap::from([("helios".to_owned(), 1_i128)]);
        assert_eq!(
            crate::dyson::certified_rocket_launch_capacity_seconds(base, &one_per_second).unwrap(),
            2
        );
        assert_eq!(
            crate::dyson::apply_certified_rocket_launches(
                base,
                &BTreeMap::from([("helios".to_owned(), 2_i128)]),
            )
            .unwrap(),
            2
        );
        assert!(
            number_at(
                Some(&Value::Object(base.clone())),
                &["dysonSphere", "generationKw"]
            ) <= MAX_SAFE_INTEGER
        );
        assert_eq!(
            crate::dyson::certified_rocket_launch_capacity_seconds(base, &one_per_second).unwrap(),
            0
        );
        let before = serde_json::to_vec(base).unwrap();
        assert!(crate::dyson::apply_certified_rocket_launches(base, &one_per_second).is_err());
        assert_eq!(serde_json::to_vec(base).unwrap(), before);
    }

    #[test]
    fn certified_rocket_helper_accepts_exact_safe_boundary_then_rejects_one_more_atomically() {
        let mut value = powered_fixture_base(15.0, "infinite");
        let base = value.as_object_mut().unwrap();
        base.get_mut("dysonSphere")
            .and_then(Value::as_object_mut)
            .unwrap()
            .insert(
                "totalRocketsLaunched".to_owned(),
                json!(MAX_SAFE_INTEGER - 1.0),
            );
        base.get_mut("dysonEngineering")
            .and_then(Value::as_object_mut)
            .unwrap()
            .insert(
                "launchEnergySpentMj".to_owned(),
                json!(MAX_SAFE_INTEGER - 108.0),
            );
        crate::dyson::finalize(base).unwrap();

        let one = BTreeMap::from([("helios".to_owned(), 1_i128)]);
        assert_eq!(
            crate::dyson::certified_rocket_launch_capacity_seconds(base, &one).unwrap(),
            1
        );
        assert_eq!(
            crate::dyson::apply_certified_rocket_launches(base, &one).unwrap(),
            1
        );
        assert_eq!(
            number_at(
                Some(&Value::Object(base.clone())),
                &["dysonSphere", "totalRocketsLaunched"]
            ),
            MAX_SAFE_INTEGER
        );
        assert_eq!(
            number_at(
                Some(&Value::Object(base.clone())),
                &["dysonEngineering", "launchEnergySpentMj"]
            ),
            MAX_SAFE_INTEGER
        );

        let before = serde_json::to_vec(base).unwrap();
        assert_eq!(
            crate::dyson::certified_rocket_launch_capacity_seconds(base, &one).unwrap(),
            0
        );
        assert!(crate::dyson::apply_certified_rocket_launches(base, &one).is_err());
        assert_eq!(serde_json::to_vec(base).unwrap(), before);
    }

    #[test]
    fn macro_v10_rocket_exact_prefix_is_unchanged() {
        let initial = productive_rocket_macro_fixture(15.0, "infinite", 2, 2, 1_000);
        let mut exact = initial.clone();
        let exact_revision = exact.revision;
        let result = exact
            .advance_exact(&exact_request(exact_revision, 20.0, 20.0 / 15.0))
            .unwrap();
        assert!(result.supported, "reason={:?}", result.reason);

        let mut macro_prefix = initial;
        let macro_revision = macro_prefix.revision;
        let result = advance_macro_v10(
            &mut macro_prefix,
            &pure_idle_macro_request(macro_revision, 20.0, 20.0 / 15.0),
        )
        .unwrap();
        assert!(result.supported, "reason={:?}", result.reason);
        assert_eq!(
            capture_settlement_snapshot(&macro_prefix).unwrap(),
            capture_settlement_snapshot(&exact).unwrap()
        );
        let macro_state = macro_prefix.materialize().unwrap();
        let exact_state = exact.materialize().unwrap();
        for field in [
            "entities",
            "totalProduced",
            "dysonSphere",
            "dysonEngineering",
            "dysonPlans",
        ] {
            assert_eq!(macro_state[field], exact_state[field], "field={field}");
        }
    }

    #[test]
    fn macro_v10_certifies_one_closed_recipe_at_supported_multipliers() {
        for multiplier in [8.0, 12.0, 15.0, 16.0] {
            let initial = productive_closed_recipe_macro_fixture(multiplier);
            let mut prefix = initial.clone();
            let prefix_revision = prefix.revision;
            let prefix_result = advance_macro_v10(
                &mut prefix,
                &pure_idle_macro_request(prefix_revision, 30.0, 30.0 / multiplier),
            )
            .unwrap();
            assert!(prefix_result.supported, "reason={:?}", prefix_result.reason);
            let prefix_state = prefix.materialize().unwrap();

            let mut long = initial.clone();
            let long_revision = long.revision;
            let long_result = advance_macro_v10(
                &mut long,
                &pure_idle_macro_request(long_revision, 60.0, 60.0 / multiplier),
            )
            .unwrap();
            assert!(long_result.supported, "reason={:?}", long_result.reason);
            assert!(
                long_result
                    .reason
                    .as_deref()
                    .is_some_and(|reason| reason.contains("acyclic closed ordinary recipe")),
                "reason={:?}",
                long_result.reason
            );
            let long_state = long.materialize().unwrap();
            let iron_produced = proof_counter(
                long_state["totalProduced"].get("iron_ore"),
                "long.totalProduced.iron_ore",
            )
            .unwrap()
                - proof_counter(
                    prefix_state["totalProduced"].get("iron_ore"),
                    "prefix.totalProduced.iron_ore",
                )
                .unwrap();
            let ingot_produced = proof_counter(
                long_state["totalProduced"].get("iron_ingot"),
                "long.totalProduced.iron_ingot",
            )
            .unwrap()
                - proof_counter(
                    prefix_state["totalProduced"].get("iron_ingot"),
                    "prefix.totalProduced.iron_ingot",
                )
                .unwrap();
            let quantum_ore = proof_counter(
                long_state["quantumLogisticsNetwork"]["inventory"].get("iron_ore"),
                "long.quantum.iron_ore",
            )
            .unwrap();
            let quantum_ingot = proof_counter(
                long_state["quantumLogisticsNetwork"]["inventory"].get("iron_ingot"),
                "long.quantum.iron_ingot",
            )
            .unwrap();
            assert!(ingot_produced > 0, "multiplier={multiplier}");
            assert!(iron_produced >= ingot_produced, "multiplier={multiplier}");
            assert_eq!(quantum_ore, iron_produced - ingot_produced);
            assert_eq!(quantum_ingot, ingot_produced);
            assert_eq!(long_state["entities"], prefix_state["entities"]);
            assert_eq!(long_state["belts"], prefix_state["belts"]);
            for frozen in [
                "research",
                "construction",
                "constructionAutomation",
                "dysonSwarm",
                "dysonSphere",
                "dysonEngineering",
                "dysonPlans",
                "endgame",
            ] {
                assert_eq!(
                    long_state[frozen], prefix_state[frozen],
                    "multiplier={multiplier} field={frozen}"
                );
            }

            let mut segmented = initial;
            for seconds in [10.0, 20.0, 30.0] {
                let revision = segmented.revision;
                let result = advance_macro_v10(
                    &mut segmented,
                    &pure_idle_macro_request(revision, seconds, seconds / multiplier),
                )
                .unwrap();
                assert!(result.supported, "reason={:?}", result.reason);
            }
            assert_eq!(
                segmented.summary().unwrap().canonical_sha256,
                long.summary().unwrap().canonical_sha256,
                "multiplier={multiplier}"
            );
        }
    }

    #[test]
    fn macro_v10_certifies_unlaunched_solar_sails_as_owned_terminal_material() {
        for multiplier in [8.0, 12.0, 15.0, 16.0] {
            let initial = productive_solar_sail_product_macro_fixture(multiplier);
            let mut prefix = initial.clone();
            let prefix_revision = prefix.revision;
            let prefix_result = advance_macro_v10(
                &mut prefix,
                &pure_idle_macro_request(prefix_revision, 30.0, 30.0 / multiplier),
            )
            .unwrap();
            assert!(prefix_result.supported, "reason={:?}", prefix_result.reason);
            let prefix_state = prefix.materialize().unwrap();

            let mut long = initial.clone();
            let long_revision = long.revision;
            let long_result = advance_macro_v10(
                &mut long,
                &pure_idle_macro_request(long_revision, 60.0, 60.0 / multiplier),
            )
            .unwrap();
            assert!(long_result.supported, "reason={:?}", long_result.reason);
            assert!(
                long_result
                    .reason
                    .as_deref()
                    .is_some_and(|reason| reason.contains("acyclic closed ordinary recipe")),
                "reason={:?}",
                long_result.reason
            );
            let long_state = long.materialize().unwrap();
            let prefix_sails = proof_counter(
                prefix_state["totalProduced"].get(TERMINAL_SAIL_ITEM_ID),
                "prefix.totalProduced.solar_sail",
            )
            .unwrap();
            let long_sails = proof_counter(
                long_state["totalProduced"].get(TERMINAL_SAIL_ITEM_ID),
                "long.totalProduced.solar_sail",
            )
            .unwrap();
            let quantum_sails = proof_counter(
                long_state["quantumLogisticsNetwork"]["inventory"].get(TERMINAL_SAIL_ITEM_ID),
                "long.quantum.solar_sail",
            )
            .unwrap();
            assert!(long_sails > prefix_sails, "multiplier={multiplier}");
            assert_eq!(quantum_sails, long_sails - prefix_sails);
            assert_eq!(long_state["entities"], prefix_state["entities"]);
            assert_eq!(long_state["belts"], prefix_state["belts"]);
            for frozen in [
                "dysonSwarm",
                "dysonSphere",
                "dysonEngineering",
                "dysonPlans",
            ] {
                assert_eq!(
                    long_state[frozen], prefix_state[frozen],
                    "multiplier={multiplier} field={frozen}"
                );
            }

            let mut segmented = initial;
            for seconds in [10.0, 20.0, 30.0] {
                let revision = segmented.revision;
                let result = advance_macro_v10(
                    &mut segmented,
                    &pure_idle_macro_request(revision, seconds, seconds / multiplier),
                )
                .unwrap();
                assert!(result.supported, "reason={:?}", result.reason);
            }
            assert_eq!(
                segmented.summary().unwrap().canonical_sha256,
                long.summary().unwrap().canonical_sha256,
                "multiplier={multiplier}"
            );
        }
    }

    #[test]
    fn macro_v10_certifies_same_window_funded_solar_sail_launch_and_lifecycle() {
        for multiplier in [8.0, 12.0, 15.0, 16.0] {
            let initial = productive_solar_sail_launch_macro_fixture(multiplier);
            let mut prefix = initial.clone();
            let prefix_revision = prefix.revision;
            let prefix_result = advance_macro_v10(
                &mut prefix,
                &pure_idle_macro_request(prefix_revision, 30.0, 30.0 / multiplier),
            )
            .unwrap();
            assert!(prefix_result.supported, "reason={:?}", prefix_result.reason);
            let prefix_state = prefix.materialize().unwrap();
            assert!(
                proof_counter(
                    prefix_state["dysonSwarm"].get("totalLaunched"),
                    "prefix.dysonSwarm.totalLaunched",
                )
                .unwrap()
                    > 0,
                "the exact prefix must exercise the sail terminal"
            );

            let mut long = initial.clone();
            let long_revision = long.revision;
            let long_result = advance_macro_v10(
                &mut long,
                &pure_idle_macro_request(long_revision, 600.0, 600.0 / multiplier),
            )
            .unwrap();
            assert!(long_result.supported, "reason={:?}", long_result.reason);
            assert!(
                long_result
                    .reason
                    .as_deref()
                    .is_some_and(|reason| reason.contains("material-funded solar sail")),
                "reason={:?}",
                long_result.reason
            );
            let long_state = long.materialize().unwrap();
            for frozen in ["entities", "belts"] {
                assert_eq!(
                    long_state[frozen], prefix_state[frozen],
                    "multiplier={multiplier} field={frozen}"
                );
            }
            let prefix_terminal =
                capture_dyson_terminal(prefix_state.as_object().unwrap()).unwrap();
            let long_terminal = capture_dyson_terminal(long_state.as_object().unwrap()).unwrap();
            assert_eq!(
                long_terminal.sails_launched - prefix_terminal.sails_launched,
                570
            );
            assert!(long_terminal.sails_expired > prefix_terminal.sails_expired);
            assert_eq!(long_terminal.sails_absorbed, prefix_terminal.sails_absorbed);
            let before = capture_settlement_snapshot(&initial).unwrap();
            let after = capture_settlement_snapshot(&long).unwrap();
            validate_settlement_proof(&before, &after, &long.catalog, None).unwrap();
            assert_eq!(number_at(Some(&long_state), &["elapsedSeconds"]), 600.0);

            let mut segmented = initial;
            for seconds in [30.0, 111.0, 59.0, 400.0] {
                let revision = segmented.revision;
                let result = advance_macro_v10(
                    &mut segmented,
                    &pure_idle_macro_request(revision, seconds, seconds / multiplier),
                )
                .unwrap();
                assert!(result.supported, "reason={:?}", result.reason);
            }
            assert_eq!(
                segmented.summary().unwrap().canonical_sha256,
                long.summary().unwrap().canonical_sha256,
                "multiplier={multiplier}"
            );
        }
    }

    #[test]
    fn macro_v10_advances_certified_sail_absorption_without_copying_shell_results() {
        let mut initial = productive_solar_sail_launch_macro_fixture(15.0);
        initial.base_value_mut()["research"]["completedTechIds"] = json!(["dyson_shell"]);
        initial.base_value_mut()["dysonPlans"]["helios"]["structurePoints"] = json!(10);
        initial.base_value_mut()["dysonSphere"]["structurePoints"] = json!(10);
        crate::dyson::finalize(initial.base_value_mut()).unwrap();

        let mut prefix = initial.clone();
        let revision = prefix.revision;
        let result =
            advance_macro_v10(&mut prefix, &pure_idle_macro_request(revision, 30.0, 2.0)).unwrap();
        assert!(result.supported, "reason={:?}", result.reason);
        let prefix_terminal = capture_dyson_terminal(prefix.base_value()).unwrap();
        assert!(prefix_terminal.sails_absorbed > 0);

        let mut long = initial.clone();
        let revision = long.revision;
        let result =
            advance_macro_v10(&mut long, &pure_idle_macro_request(revision, 600.0, 40.0)).unwrap();
        assert!(result.supported, "reason={:?}", result.reason);
        let long_terminal = capture_dyson_terminal(long.base_value()).unwrap();
        assert_eq!(
            long_terminal.sails_launched - prefix_terminal.sails_launched,
            570
        );
        assert!(long_terminal.sails_absorbed > prefix_terminal.sails_absorbed);
        assert_eq!(
            long_terminal.shell_sails - prefix_terminal.shell_sails,
            long_terminal.sails_absorbed - prefix_terminal.sails_absorbed
        );
        let before = capture_settlement_snapshot(&initial).unwrap();
        let after = capture_settlement_snapshot(&long).unwrap();
        validate_settlement_proof(&before, &after, &long.catalog, None).unwrap();

        let mut segmented = initial;
        for seconds in [30.0, 111.0, 59.0, 400.0] {
            let revision = segmented.revision;
            let result = advance_macro_v10(
                &mut segmented,
                &pure_idle_macro_request(revision, seconds, seconds / 15.0),
            )
            .unwrap();
            assert!(result.supported, "reason={:?}", result.reason);
        }
        assert_eq!(
            segmented.summary().unwrap().canonical_sha256,
            long.summary().unwrap().canonical_sha256
        );
    }

    #[test]
    fn macro_v10_batches_thirty_day_sail_lifecycle_deterministically() {
        let initial = productive_solar_sail_launch_macro_fixture(15.0);
        let mut long = initial.clone();
        let revision = long.revision;
        let result = advance_macro_v10(
            &mut long,
            &pure_idle_macro_request(revision, 2_592_000.0, 172_800.0),
        )
        .unwrap();
        assert!(result.supported, "reason={:?}", result.reason);
        assert_eq!(
            capture_dyson_terminal(long.base_value())
                .unwrap()
                .sails_launched,
            2_592_000
        );

        let mut segmented = initial;
        for seconds in [30.0, 86_370.0, 2_505_600.0] {
            let revision = segmented.revision;
            let result = advance_macro_v10(
                &mut segmented,
                &pure_idle_macro_request(revision, seconds, seconds / 15.0),
            )
            .unwrap();
            assert!(result.supported, "reason={:?}", result.reason);
        }
        assert_eq!(
            segmented.summary().unwrap().canonical_sha256,
            long.summary().unwrap().canonical_sha256
        );
    }

    #[test]
    fn macro_v10_sail_sink_failure_is_atomic_and_checkpoint_reload_is_deterministic() {
        let mut calibrated = productive_solar_sail_launch_macro_fixture(15.0);
        let revision = calibrated.revision;
        let result = advance_macro_v10(
            &mut calibrated,
            &pure_idle_macro_request(revision, 30.0, 2.0),
        )
        .unwrap();
        assert!(result.supported, "reason={:?}", result.reason);

        let mut corrupted = calibrated.clone();
        corrupted
            .pure_idle_macro_runtime
            .as_mut()
            .and_then(|runtime| runtime.certificate.as_mut())
            .and_then(|certificate| certificate.dyson_sail.as_mut())
            .expect("solar-sail certificate")
            .expected
            .sails_launched += 1;
        let before_hash = corrupted.summary().unwrap().canonical_sha256;
        let before_revision = corrupted.revision;
        let before_credit = corrupted.pure_idle_macro_exact_seconds_used();
        let result = advance_macro_v10(
            &mut corrupted,
            &pure_idle_macro_request(before_revision, 60.0, 4.0),
        )
        .unwrap();
        assert!(!result.supported);
        assert_eq!(corrupted.summary().unwrap().canonical_sha256, before_hash);
        assert_eq!(corrupted.revision, before_revision);
        assert_eq!(
            corrupted.pure_idle_macro_exact_seconds_used(),
            before_credit
        );

        let mut records = BTreeMap::<String, Vec<u8>>::new();
        calibrated
            .visit_internal_checkpoint_records(42, |key, value| {
                records.insert(key.to_owned(), value.as_bytes().to_vec());
                Ok(())
            })
            .unwrap();
        let mut identity = calibrated.identity.clone();
        identity.revision = calibrated.revision;
        let mut restored =
            CoreState::from_internal_records(identity, &records, (*calibrated.catalog).clone())
                .unwrap();
        assert!(restored.pure_idle_macro_runtime.is_none());
        for state in [&mut calibrated, &mut restored] {
            let revision = state.revision;
            let result =
                advance_macro_v10(state, &pure_idle_macro_request(revision, 570.0, 38.0)).unwrap();
            assert!(result.supported, "reason={:?}", result.reason);
        }
        assert_eq!(
            restored.summary().unwrap().canonical_sha256,
            calibrated.summary().unwrap().canonical_sha256
        );
    }

    #[test]
    fn certified_sail_helper_reserves_existing_orbit_stock_for_expiry_counters() {
        let mut value = powered_fixture_base(15.0, "infinite");
        let base = value.as_object_mut().unwrap();
        let orbit = base["dysonEngineering"]["orbitsBySystem"]["helios"]
            .as_array_mut()
            .unwrap()[0]
            .as_object_mut()
            .unwrap();
        orbit.insert("sailsInOrbit".to_owned(), json!(2));
        orbit.insert("totalLaunched".to_owned(), json!(2));
        orbit.insert("totalExpired".to_owned(), json!(MAX_SAFE_INTEGER - 3.0));
        base["dysonSwarm"]["sailsInOrbit"] = json!(2);
        base["dysonSwarm"]["totalLaunched"] = json!(2);
        base["dysonSwarm"]["totalExpired"] = json!(MAX_SAFE_INTEGER - 3.0);
        crate::dyson::finalize(base).unwrap();

        let one = BTreeMap::from([(
            "helios".to_owned(),
            BTreeMap::from([("test-orbit-helios".to_owned(), 1_i128)]),
        )]);
        assert_eq!(
            crate::dyson::certified_sail_launch_capacity_seconds(base, &one).unwrap(),
            1
        );
        assert_eq!(
            crate::dyson::apply_certified_sail_launch_schedule(base, &one, 1).unwrap(),
            1
        );
        assert_eq!(
            crate::dyson::certified_sail_launch_capacity_seconds(base, &one).unwrap(),
            0
        );
        let before = serde_json::to_vec(base).unwrap();
        assert!(crate::dyson::apply_certified_sail_launch_schedule(base, &one, 1).is_err());
        assert_eq!(serde_json::to_vec(base).unwrap(), before);
    }

    #[test]
    fn macro_v10_solar_sail_sink_never_replays_prefilled_ejector_inventory() {
        let initial = productive_solar_sail_launch_macro_fixture(15.0);
        let mut underfunded = initial.clone();
        let mut assembler = underfunded.parse_entity(3).unwrap();
        assembler["machineCount"] = json!(0);
        underfunded.replace_entity_raw(3, serde_json::to_string(&assembler).unwrap().into());
        underfunded.rebuild_indexes().unwrap();

        let mut prefix = underfunded.clone();
        let revision = prefix.revision;
        let result =
            advance_macro_v10(&mut prefix, &pure_idle_macro_request(revision, 30.0, 2.0)).unwrap();
        assert!(result.supported, "reason={:?}", result.reason);
        let prefix_state = prefix.materialize().unwrap();
        assert_eq!(
            proof_counter(
                prefix_state["totalProduced"].get(TERMINAL_SAIL_ITEM_ID),
                "underfunded solar-sail production",
            )
            .unwrap(),
            0,
        );
        assert!(
            proof_counter(
                prefix_state["dysonSwarm"].get("totalLaunched"),
                "underfunded exact launch",
            )
            .unwrap()
                > 0,
        );

        let mut long = underfunded;
        let revision = long.revision;
        let result =
            advance_macro_v10(&mut long, &pure_idle_macro_request(revision, 600.0, 40.0)).unwrap();
        assert!(result.supported, "reason={:?}", result.reason);
        assert!(
            result.reason.as_deref().is_some_and(|reason| {
                reason.contains("depleted owned inventory")
                    || reason.contains("same-window certified production")
            }),
            "reason={:?}",
            result.reason,
        );
        let long_state = long.materialize().unwrap();
        for frozen in [
            "entities",
            "belts",
            "totalProduced",
            "quantumLogisticsNetwork",
            "dysonSwarm",
            "dysonSphere",
            "dysonEngineering",
            "dysonPlans",
        ] {
            assert_eq!(long_state[frozen], prefix_state[frozen], "field={frozen}");
        }
        assert_eq!(number_at(Some(&long_state), &["elapsedSeconds"]), 600.0);
    }

    #[test]
    fn macro_v10_certifies_acyclic_recipe_dag_with_shared_intermediate() {
        for multiplier in [8.0, 12.0, 15.0, 16.0] {
            let initial = productive_closed_recipe_dag_macro_fixture(multiplier);
            let request = pure_idle_macro_request(initial.revision, 600.0, 600.0 / multiplier);
            let snapshots = exact_three_window_probe(&initial, &request).unwrap();
            let certificate = build_ordinary_flow_certificate(&initial, &snapshots).unwrap();
            assert_eq!(
                certificate.recipe_ids,
                ["magnet", "iron_ingot", "iron_gear"],
                "the certificate must retain first-seen entity order"
            );
            assert_eq!(
                certificate.produced_units_per_second,
                BTreeMap::from([
                    ("iron_gear".to_owned(), 1),
                    ("iron_ingot".to_owned(), 2),
                    ("iron_ore".to_owned(), 4),
                    ("magnet".to_owned(), 1),
                ])
            );
            assert_eq!(
                certificate.consumed_units_per_second,
                BTreeMap::from([("iron_ingot".to_owned(), 2), ("iron_ore".to_owned(), 2),])
            );
            assert_eq!(
                certificate.units_per_second,
                BTreeMap::from([
                    ("iron_gear".to_owned(), 1),
                    ("iron_ore".to_owned(), 2),
                    ("magnet".to_owned(), 1),
                ])
            );

            let mut prefix = initial.clone();
            let prefix_revision = prefix.revision;
            let prefix_result = advance_macro_v10(
                &mut prefix,
                &pure_idle_macro_request(prefix_revision, 30.0, 30.0 / multiplier),
            )
            .unwrap();
            assert!(prefix_result.supported, "reason={:?}", prefix_result.reason);
            let prefix_state = prefix.materialize().unwrap();

            let mut long = initial.clone();
            let long_revision = long.revision;
            let long_result = advance_macro_v10(
                &mut long,
                &pure_idle_macro_request(long_revision, 600.0, 600.0 / multiplier),
            )
            .unwrap();
            assert!(long_result.supported, "reason={:?}", long_result.reason);
            assert!(
                long_result
                    .reason
                    .as_deref()
                    .is_some_and(|reason| reason.contains("acyclic closed ordinary recipe")),
                "reason={:?}",
                long_result.reason
            );
            let long_state = long.materialize().unwrap();
            let tail_seconds = 570_i128;
            for (item_id, rate) in [
                ("iron_ore", 4_i128),
                ("iron_ingot", 2),
                ("iron_gear", 1),
                ("magnet", 1),
            ] {
                let delta = proof_counter(
                    long_state["totalProduced"].get(item_id),
                    &format!("long.totalProduced.{item_id}"),
                )
                .unwrap()
                    - proof_counter(
                        prefix_state["totalProduced"].get(item_id),
                        &format!("prefix.totalProduced.{item_id}"),
                    )
                    .unwrap();
                assert_eq!(delta, rate * tail_seconds, "item={item_id}");
            }
            for (item_id, rate) in [("iron_ore", 2_i128), ("iron_gear", 1), ("magnet", 1)] {
                assert_eq!(
                    proof_counter(
                        long_state["quantumLogisticsNetwork"]["inventory"].get(item_id),
                        &format!("long.quantum.{item_id}"),
                    )
                    .unwrap(),
                    rate * tail_seconds,
                    "item={item_id}"
                );
            }
            assert!(
                long_state["quantumLogisticsNetwork"]["inventory"]
                    .get("iron_ingot")
                    .is_none(),
                "zero-net shared intermediates must not be deposited"
            );
            assert_eq!(long_state["entities"], prefix_state["entities"]);
            assert_eq!(long_state["belts"], prefix_state["belts"]);

            let mut segmented = initial;
            for seconds in [10.0, 20.0, 190.0, 190.0, 190.0] {
                let revision = segmented.revision;
                let result = advance_macro_v10(
                    &mut segmented,
                    &pure_idle_macro_request(revision, seconds, seconds / multiplier),
                )
                .unwrap();
                assert!(result.supported, "reason={:?}", result.reason);
            }
            assert_eq!(
                segmented.summary().unwrap().canonical_sha256,
                long.summary().unwrap().canonical_sha256,
                "multiplier={multiplier}"
            );
        }
    }

    #[test]
    fn macro_v10_recipe_dag_capacity_horizon_scales_the_complete_ledger() {
        let mut initial = productive_closed_recipe_dag_macro_fixture(15.0);
        initial.base_value_mut()["quantumLogisticsNetwork"]["itemCapacities"] = json!({
            "iron_ore": "10000",
            "iron_ingot": "10000",
            "iron_gear": "10000",
            "magnet": "10000"
        });
        initial.base_value_mut()["quantumLogisticsNetwork"]["inventory"] = json!({
            "iron_ore": "9000",
            "iron_gear": "9997",
            "magnet": "9000"
        });

        let mut prefix = initial.clone();
        let prefix_revision = prefix.revision;
        advance_macro_v10(
            &mut prefix,
            &pure_idle_macro_request(prefix_revision, 30.0, 2.0),
        )
        .unwrap();
        let prefix_state = prefix.materialize().unwrap();

        let mut long = initial.clone();
        let long_revision = long.revision;
        let result = advance_macro_v10(
            &mut long,
            &pure_idle_macro_request(long_revision, 600.0, 40.0),
        )
        .unwrap();
        assert!(result.supported, "reason={:?}", result.reason);
        assert!(
            result
                .reason
                .as_deref()
                .is_some_and(|reason| reason.contains("capacity horizon")),
            "reason={:?}",
            result.reason
        );
        let long_state = long.materialize().unwrap();
        assert_eq!(
            long_state["quantumLogisticsNetwork"]["inventory"]["iron_gear"],
            json!("10000")
        );
        assert_eq!(
            long_state["quantumLogisticsNetwork"]["inventory"]["iron_ore"],
            json!("9006")
        );
        assert_eq!(
            long_state["quantumLogisticsNetwork"]["inventory"]["magnet"],
            json!("9003")
        );
        for (item_id, expected_delta) in [
            ("iron_ore", 12_i128),
            ("iron_ingot", 6),
            ("iron_gear", 3),
            ("magnet", 3),
        ] {
            let delta = proof_counter(
                long_state["totalProduced"].get(item_id),
                &format!("long.totalProduced.{item_id}"),
            )
            .unwrap()
                - proof_counter(
                    prefix_state["totalProduced"].get(item_id),
                    &format!("prefix.totalProduced.{item_id}"),
                )
                .unwrap();
            assert_eq!(delta, expected_delta, "item={item_id}");
        }

        let mut segmented = initial;
        for seconds in [30.0, 190.0, 190.0, 190.0] {
            let revision = segmented.revision;
            let result = advance_macro_v10(
                &mut segmented,
                &pure_idle_macro_request(revision, seconds, seconds / 15.0),
            )
            .unwrap();
            assert!(result.supported, "reason={:?}", result.reason);
        }
        assert_eq!(
            segmented.summary().unwrap().canonical_sha256,
            long.summary().unwrap().canonical_sha256
        );
    }

    #[test]
    fn closed_recipe_dag_rejects_cycles_alternate_producers_and_spray_without_mutation() {
        let state = productive_closed_recipe_dag_macro_fixture(15.0);
        let request = pure_idle_macro_request(state.revision, 600.0, 40.0);
        let snapshots = exact_three_window_probe(&state, &request).unwrap();
        let flows = snapshots
            .windows(2)
            .map(|window| capture_ordinary_window_flow(&window[0], &window[1], false).unwrap())
            .collect::<Vec<_>>();
        assert!(flows.iter().skip(1).all(|flow| flow == &flows[0]));
        let mut cycle = state.clone();
        std::sync::Arc::make_mut(&mut cycle.catalog)
            .recipes
            .get_mut("iron_ingot")
            .unwrap()
            .inputs = vec![ItemAmount {
            item_id: "magnet".to_owned(),
            amount: 1.0,
        }];
        let mut ingot_entity = cycle.parse_entity(4).unwrap();
        ingot_entity["inputs"] = json!({ "magnet": 1000 });
        cycle.replace_entity_raw(4, serde_json::to_string(&ingot_entity).unwrap().into());
        cycle.rebuild_indexes().unwrap();
        let cycle_hash = cycle.summary().unwrap().canonical_sha256;
        let cycle_sources = exclusive_infinite_vein_sources(&cycle).unwrap();
        let rejection =
            build_closed_recipe_certificate(&cycle, &cycle_sources, &flows[0], None, None, None)
                .unwrap_err();
        assert!(rejection.contains("dependency cycle"), "{rejection}");
        assert_eq!(cycle.summary().unwrap().canonical_sha256, cycle_hash);

        let mut alternate = state.clone();
        std::sync::Arc::make_mut(&mut alternate.catalog)
            .recipes
            .get_mut("magnet")
            .unwrap()
            .outputs = vec![ItemAmount {
            item_id: "iron_gear".to_owned(),
            amount: 1.0,
        }];
        let mut magnet_entity = alternate.parse_entity(3).unwrap();
        magnet_entity["outputs"] = json!({ "iron_gear": 0 });
        alternate.replace_entity_raw(3, serde_json::to_string(&magnet_entity).unwrap().into());
        alternate.rebuild_indexes().unwrap();
        let alternate_hash = alternate.summary().unwrap().canonical_sha256;
        let alternate_sources = exclusive_infinite_vein_sources(&alternate).unwrap();
        let rejection = build_closed_recipe_certificate(
            &alternate,
            &alternate_sources,
            &flows[0],
            None,
            None,
            None,
        )
        .unwrap_err();
        assert!(
            rejection.contains("alternate active producers"),
            "{rejection}"
        );
        assert_eq!(
            alternate.summary().unwrap().canonical_sha256,
            alternate_hash
        );

        let mut hidden_producer = state.clone();
        let mut controller = hidden_producer.parse_entity(1).unwrap();
        controller["outputs"] = json!({ "iron_gear": 0 });
        hidden_producer.replace_entity_raw(1, serde_json::to_string(&controller).unwrap().into());
        hidden_producer.rebuild_indexes().unwrap();
        let hidden_hash = hidden_producer.summary().unwrap().canonical_sha256;
        let hidden_sources = exclusive_infinite_vein_sources(&hidden_producer).unwrap();
        let rejection = build_closed_recipe_certificate(
            &hidden_producer,
            &hidden_sources,
            &flows[0],
            None,
            None,
            None,
        )
        .unwrap_err();
        assert!(
            rejection.contains("alternate unmodelled producer"),
            "{rejection}"
        );
        assert_eq!(
            hidden_producer.summary().unwrap().canonical_sha256,
            hidden_hash
        );

        let mut sprayed = state;
        let mut entity = sprayed.parse_entity(3).unwrap();
        entity["sprayCoaterInstalled"] = json!(true);
        sprayed.replace_entity_raw(3, serde_json::to_string(&entity).unwrap().into());
        sprayed.rebuild_indexes().unwrap();
        let sprayed_sources = exclusive_infinite_vein_sources(&sprayed).unwrap();
        let rejection = build_closed_recipe_certificate(
            &sprayed,
            &sprayed_sources,
            &flows[0],
            None,
            None,
            None,
        )
        .unwrap_err();
        assert!(rejection.contains("proliferator"), "{rejection}");
    }

    #[test]
    fn macro_v10_recipe_cycle_never_falls_back_to_source_only_mining() {
        let mut initial = productive_closed_recipe_dag_macro_fixture(15.0);
        std::sync::Arc::make_mut(&mut initial.catalog)
            .recipes
            .get_mut("iron_ingot")
            .unwrap()
            .inputs = vec![ItemAmount {
            item_id: "magnet".to_owned(),
            amount: 1.0,
        }];
        let mut ingot = initial.parse_entity(4).unwrap();
        ingot["machineCount"] = json!(1);
        ingot["inputs"] = json!({ "magnet": 1000 });
        initial.replace_entity_raw(4, serde_json::to_string(&ingot).unwrap().into());
        let mut gear = initial.parse_entity(5).unwrap();
        gear["machineCount"] = json!(0);
        initial.replace_entity_raw(5, serde_json::to_string(&gear).unwrap().into());
        initial.rebuild_indexes().unwrap();

        let mut prefix = initial.clone();
        let prefix_revision = prefix.revision;
        let result = advance_macro_v10(
            &mut prefix,
            &pure_idle_macro_request(prefix_revision, 30.0, 2.0),
        )
        .unwrap();
        assert!(result.supported, "reason={:?}", result.reason);
        let prefix_state = prefix.materialize().unwrap();

        let mut long = initial;
        let long_revision = long.revision;
        let result = advance_macro_v10(
            &mut long,
            &pure_idle_macro_request(long_revision, 600.0, 40.0),
        )
        .unwrap();
        assert!(result.supported, "reason={:?}", result.reason);
        assert!(
            result
                .reason
                .as_deref()
                .is_some_and(|reason| reason.contains("dependency cycle")),
            "reason={:?}",
            result.reason
        );
        let long_state = long.materialize().unwrap();
        assert_eq!(long_state["totalProduced"], prefix_state["totalProduced"]);
        assert_eq!(long_state["entities"], prefix_state["entities"]);
        assert!(
            long_state["quantumLogisticsNetwork"]["inventory"]
                .as_object()
                .unwrap()
                .is_empty(),
            "the infinite source must freeze with the rejected cyclic domain"
        );
    }

    #[test]
    fn macro_v10_recipe_dag_does_not_replay_prefilled_only_inputs() {
        let mut initial = productive_closed_recipe_dag_macro_fixture(15.0);
        let mut vein = initial.parse_entity(2).unwrap();
        vein["minerCount"] = json!(0);
        initial.replace_entity_raw(2, serde_json::to_string(&vein).unwrap().into());
        initial.rebuild_indexes().unwrap();

        let mut prefix = initial.clone();
        let prefix_revision = prefix.revision;
        let result = advance_macro_v10(
            &mut prefix,
            &pure_idle_macro_request(prefix_revision, 30.0, 2.0),
        )
        .unwrap();
        assert!(result.supported, "reason={:?}", result.reason);
        let prefix_state = prefix.materialize().unwrap();
        assert!(
            proof_counter(
                prefix_state["totalProduced"].get("iron_gear"),
                "prefix.totalProduced.iron_gear",
            )
            .unwrap()
                > 0
        );

        let mut long = initial;
        let long_revision = long.revision;
        let result = advance_macro_v10(
            &mut long,
            &pure_idle_macro_request(long_revision, 600.0, 40.0),
        )
        .unwrap();
        assert!(result.supported, "reason={:?}", result.reason);
        assert!(
            result
                .reason
                .as_deref()
                .is_some_and(|reason| reason.contains("no exclusive active infinite-vein source")),
            "reason={:?}",
            result.reason
        );
        let long_state = long.materialize().unwrap();
        assert_eq!(long_state["totalProduced"], prefix_state["totalProduced"]);
        assert_eq!(long_state["entities"], prefix_state["entities"]);
        assert!(
            long_state["quantumLogisticsNetwork"]["inventory"]
                .as_object()
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn macro_v10_recipe_dag_ledger_failure_is_atomic() {
        let mut state = productive_closed_recipe_dag_macro_fixture(15.0);
        let revision = state.revision;
        let result =
            advance_macro_v10(&mut state, &pure_idle_macro_request(revision, 30.0, 2.0)).unwrap();
        assert!(result.supported, "reason={:?}", result.reason);
        let certificate = state
            .pure_idle_macro_runtime
            .as_mut()
            .and_then(|runtime| runtime.certificate.as_mut())
            .expect("closed recipe DAG certificate");
        assert_eq!(
            certificate.recipe_ids,
            ["magnet", "iron_ingot", "iron_gear"]
        );
        certificate
            .consumed_units_per_second
            .insert("iron_ingot".to_owned(), 1);
        let before_revision = state.revision;
        let before_hash = state.summary().unwrap().canonical_sha256;
        let before_credit = state.pure_idle_macro_exact_seconds_used();
        let result = advance_macro_v10(
            &mut state,
            &pure_idle_macro_request(before_revision, 15.0, 1.0),
        )
        .unwrap();
        assert!(!result.supported);
        assert!(
            result
                .reason
                .as_deref()
                .is_some_and(|reason| reason.contains("closed-flow identity is invalid")),
            "reason={:?}",
            result.reason
        );
        assert_eq!(state.revision, before_revision);
        assert_eq!(state.summary().unwrap().canonical_sha256, before_hash);
        assert_eq!(state.pure_idle_macro_exact_seconds_used(), before_credit);
    }

    #[test]
    fn macro_v10_recipe_dag_has_a_fixed_cross_thread_hash() {
        let mut state = productive_closed_recipe_dag_macro_fixture(15.0);
        let revision = state.revision;
        let result =
            advance_macro_v10(&mut state, &pure_idle_macro_request(revision, 600.0, 40.0)).unwrap();
        assert!(result.supported, "reason={:?}", result.reason);
        assert_eq!(
            state.summary().unwrap().canonical_sha256,
            "568a15dba5cb059a34a2d6e40263b1a2ab134ebe9d011fc96446e82982d7bc9b"
        );
    }

    #[test]
    fn macro_v10_closed_recipe_capacity_horizon_recomputes_the_whole_ledger() {
        let mut initial = productive_closed_recipe_macro_fixture(15.0);
        initial.base_value_mut()["quantumLogisticsNetwork"]["itemCapacities"] =
            json!({ "iron_ore": "10000", "iron_ingot": "10000" });
        initial.base_value_mut()["quantumLogisticsNetwork"]["inventory"] =
            json!({ "iron_ore": "9990", "iron_ingot": "9995" });

        let mut prefix = initial.clone();
        let prefix_revision = prefix.revision;
        advance_macro_v10(
            &mut prefix,
            &pure_idle_macro_request(prefix_revision, 30.0, 2.0),
        )
        .unwrap();
        let prefix_state = prefix.materialize().unwrap();

        let mut long = initial.clone();
        let long_revision = long.revision;
        let result = advance_macro_v10(
            &mut long,
            &pure_idle_macro_request(long_revision, 600.0, 40.0),
        )
        .unwrap();
        assert!(result.supported, "reason={:?}", result.reason);
        assert!(
            result
                .reason
                .as_deref()
                .is_some_and(|reason| reason.contains("capacity horizon")),
            "reason={:?}",
            result.reason
        );
        let long_state = long.materialize().unwrap();
        let ore_produced = proof_counter(
            long_state["totalProduced"].get("iron_ore"),
            "long.totalProduced.iron_ore",
        )
        .unwrap()
            - proof_counter(
                prefix_state["totalProduced"].get("iron_ore"),
                "prefix.totalProduced.iron_ore",
            )
            .unwrap();
        let ingot_produced = proof_counter(
            long_state["totalProduced"].get("iron_ingot"),
            "long.totalProduced.iron_ingot",
        )
        .unwrap()
            - proof_counter(
                prefix_state["totalProduced"].get("iron_ingot"),
                "prefix.totalProduced.iron_ingot",
            )
            .unwrap();
        assert!(ingot_produced > 0);
        assert_eq!(
            proof_counter(
                long_state["quantumLogisticsNetwork"]["inventory"].get("iron_ingot"),
                "long.quantum.iron_ingot",
            )
            .unwrap(),
            10_000
        );
        assert_eq!(
            proof_counter(
                long_state["quantumLogisticsNetwork"]["inventory"].get("iron_ore"),
                "long.quantum.iron_ore",
            )
            .unwrap()
                - 9_990,
            ore_produced - ingot_produced
        );

        let mut segmented = initial;
        for seconds in [30.0, 190.0, 190.0, 190.0] {
            let revision = segmented.revision;
            let result = advance_macro_v10(
                &mut segmented,
                &pure_idle_macro_request(revision, seconds, seconds / 15.0),
            )
            .unwrap();
            assert!(result.supported, "reason={:?}", result.reason);
        }
        assert_eq!(
            segmented.summary().unwrap().canonical_sha256,
            long.summary().unwrap().canonical_sha256
        );
    }

    #[test]
    fn macro_v10_closed_recipe_ledger_corruption_is_atomic() {
        let mut state = productive_closed_recipe_macro_fixture(15.0);
        let revision = state.revision;
        advance_macro_v10(&mut state, &pure_idle_macro_request(revision, 30.0, 2.0)).unwrap();
        let certificate = state
            .pure_idle_macro_runtime
            .as_mut()
            .and_then(|runtime| runtime.certificate.as_mut())
            .expect("closed recipe certificate");
        assert_eq!(certificate.recipe_ids, ["iron_ingot"]);
        certificate
            .consumed_units_per_second
            .insert("iron_ore".to_owned(), 0);
        let before_revision = state.revision;
        let before_hash = state.summary().unwrap().canonical_sha256;
        let before_credit = state.pure_idle_macro_exact_seconds_used();
        let result = advance_macro_v10(
            &mut state,
            &pure_idle_macro_request(before_revision, 15.0, 1.0),
        )
        .unwrap();
        assert!(!result.supported);
        assert!(
            result
                .reason
                .as_deref()
                .is_some_and(|reason| reason.contains("closed-flow identity is invalid")),
            "reason={:?}",
            result.reason
        );
        assert_eq!(state.revision, before_revision);
        assert_eq!(state.summary().unwrap().canonical_sha256, before_hash);
        assert_eq!(state.pure_idle_macro_exact_seconds_used(), before_credit);
    }

    #[test]
    fn macro_v10_closed_recipe_has_a_fixed_cross_thread_hash() {
        let mut state = productive_closed_recipe_macro_fixture(15.0);
        let revision = state.revision;
        let result =
            advance_macro_v10(&mut state, &pure_idle_macro_request(revision, 600.0, 40.0)).unwrap();
        assert!(result.supported, "reason={:?}", result.reason);
        assert_eq!(
            state.summary().unwrap().canonical_sha256,
            "9b46a6889b8636fee6555037219168c40041064091a20f50062c6b40aee789aa"
        );
    }

    #[test]
    fn closed_recipe_certificate_rejects_every_unclosed_tail_domain() {
        let state = productive_closed_recipe_macro_fixture(15.0);
        let request = pure_idle_macro_request(state.revision, 60.0, 4.0);
        let snapshots = exact_three_window_probe(&state, &request).unwrap();
        let certificate = build_ordinary_flow_certificate(&state, &snapshots).unwrap();
        assert_eq!(certificate.recipe_ids, ["iron_ingot"]);

        let assert_domain_rejected = |label: &str, excluded: CoreState| {
            let rejection = build_ordinary_flow_certificate(&excluded, &snapshots).unwrap_err();
            assert!(
                rejection.contains("not a source-only closed flow")
                    || rejection.contains("did not produce")
                    || rejection.contains("ordinary recipe tail is excluded while")
                    || rejection.contains("current research state is not a calibration endpoint"),
                "domain={label} rejection={rejection}"
            );
        };
        let mut research = state.clone();
        research.base_value_mut()["research"]["selectedTechId"] = json!("active-tech");
        assert_domain_rejected("research", research);
        let mut construction = state.clone();
        construction.base_value_mut()["constructionAutomation"]["enabled"] = json!(true);
        assert_domain_rejected("construction", construction);
        let mut export = state.clone();
        export.base_value_mut()["endgame"]["autoDispatch"] = json!(true);
        assert_domain_rejected("export", export);

        let mut terminal = snapshots.clone();
        terminal[1].dyson.rockets_launched += 1;
        terminal[1].dyson.structure_points += 1;
        terminal[1]
            .dyson
            .structure_by_system
            .insert("helios".to_owned(), 1);
        let rejection = build_ordinary_flow_certificate(&state, &terminal).unwrap_err();
        assert!(
            rejection.contains("Dyson rocket, sail or structure state changed")
                || rejection.contains("small_carrier_rocket launch plus known consumption"),
            "{rejection}"
        );
    }

    #[test]
    fn macro_v10_does_not_replay_a_prefilled_recipe_without_live_sources() {
        let mut initial = productive_closed_recipe_macro_fixture(15.0);
        let mut vein = initial.parse_entity(2).unwrap();
        vein["minerCount"] = json!(0);
        initial.replace_entity_raw(2, serde_json::to_string(&vein).unwrap().into());
        initial.rebuild_indexes().unwrap();

        let mut prefix = initial.clone();
        let prefix_revision = prefix.revision;
        advance_macro_v10(
            &mut prefix,
            &pure_idle_macro_request(prefix_revision, 30.0, 2.0),
        )
        .unwrap();
        let prefix_state = prefix.materialize().unwrap();
        assert!(
            proof_counter(
                prefix_state["totalProduced"].get("iron_ingot"),
                "prefix.totalProduced.iron_ingot",
            )
            .unwrap()
                > 0
        );

        let mut long = initial;
        let long_revision = long.revision;
        let result = advance_macro_v10(
            &mut long,
            &pure_idle_macro_request(long_revision, 600.0, 40.0),
        )
        .unwrap();
        assert!(result.supported, "reason={:?}", result.reason);
        let long_state = long.materialize().unwrap();
        assert_eq!(long_state["totalProduced"], prefix_state["totalProduced"]);
        assert_eq!(long_state["entities"], prefix_state["entities"]);
        assert!(
            long_state["quantumLogisticsNetwork"]["inventory"]
                .as_object()
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn macro_v10_rejects_finite_source_and_fuel_backed_power_certificates() {
        let mut finite = productive_quantum_macro_fixture(15.0, "finite");
        let finite_revision = finite.revision;
        let finite_result = advance_macro_v10(
            &mut finite,
            &pure_idle_macro_request(finite_revision, 60.0, 4.0),
        )
        .unwrap();
        assert!(finite_result.supported);
        assert!(
            finite_result
                .reason
                .as_deref()
                .is_some_and(|reason| reason.contains("finite resources")),
            "reason={:?}",
            finite_result.reason
        );
        assert!(
            finite.base_value()["quantumLogisticsNetwork"]["inventory"]
                .as_object()
                .unwrap()
                .is_empty()
        );

        let mut fuel_backed = productive_quantum_macro_fixture(15.0, "infinite");
        std::sync::Arc::make_mut(&mut fuel_backed.catalog)
            .buildings
            .get_mut("wind_turbine")
            .unwrap()
            .fuel_item_ids = vec!["iron_ore".to_owned()];
        let fuel_revision = fuel_backed.revision;
        let fuel_result = advance_macro_v10(
            &mut fuel_backed,
            &pure_idle_macro_request(fuel_revision, 60.0, 4.0),
        )
        .unwrap();
        assert!(fuel_result.supported);
        assert!(
            fuel_result
                .reason
                .as_deref()
                .is_some_and(|reason| reason.contains("fuel or stored energy")),
            "reason={:?}",
            fuel_result.reason
        );
        assert!(
            fuel_backed.base_value()["quantumLogisticsNetwork"]["inventory"]
                .as_object()
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn macro_v10_certificate_rejects_negative_or_unstable_source_vectors() {
        let state = productive_quantum_macro_fixture(15.0, "infinite");
        let negative = (0..4)
            .map(|window| SettlementProofSnapshot {
                owned: BTreeMap::from([("iron_ore".to_owned(), 100 - window * 10)]),
                produced: BTreeMap::from([("iron_ore".to_owned(), window * 20)]),
                ..SettlementProofSnapshot::default()
            })
            .collect::<Vec<_>>();
        let rejection = build_ordinary_flow_certificate(&state, &negative).unwrap_err();
        assert!(rejection.contains("source-only closed flow"), "{rejection}");

        let mut produced = 0_i128;
        let unstable = [0_i128, 20, 30, 20]
            .into_iter()
            .map(|delta| {
                produced += delta;
                SettlementProofSnapshot {
                    owned: BTreeMap::from([("iron_ore".to_owned(), produced)]),
                    produced: BTreeMap::from([("iron_ore".to_owned(), produced)]),
                    ..SettlementProofSnapshot::default()
                }
            })
            .collect::<Vec<_>>();
        let rejection = build_ordinary_flow_certificate(&state, &unstable).unwrap_err();
        assert!(rejection.contains("unstable"), "{rejection}");
    }

    #[test]
    fn macro_v10_rebuilds_missing_runtime_certificate_deterministically() {
        let mut calibrated = productive_quantum_macro_fixture(15.0, "infinite");
        let revision = calibrated.revision;
        let result = advance_macro_v10(
            &mut calibrated,
            &pure_idle_macro_request(revision, 30.0, 2.0),
        )
        .unwrap();
        assert!(result.supported, "reason={:?}", result.reason);

        let mut cached = calibrated.clone();
        let mut rebuilt = calibrated;
        rebuilt.pure_idle_macro_runtime = None;
        for state in [&mut cached, &mut rebuilt] {
            let revision = state.revision;
            let result =
                advance_macro_v10(state, &pure_idle_macro_request(revision, 30.0, 2.0)).unwrap();
            assert!(result.supported, "reason={:?}", result.reason);
        }
        assert_eq!(
            rebuilt.summary().unwrap().canonical_sha256,
            cached.summary().unwrap().canonical_sha256
        );
    }

    #[test]
    fn macro_v10_quantum_capacity_horizon_is_segment_invariant() {
        let mut initial = productive_quantum_macro_fixture(15.0, "infinite");
        initial.base_value_mut()["quantumLogisticsNetwork"]["itemCapacities"]["iron_ore"] =
            json!("10000");
        let mut long = initial.clone();
        let long_revision = long.revision;
        let long_result = advance_macro_v10(
            &mut long,
            &pure_idle_macro_request(long_revision, 6030.0, 402.0),
        )
        .unwrap();
        assert!(long_result.supported, "reason={:?}", long_result.reason);
        assert!(
            long_result
                .reason
                .as_deref()
                .is_some_and(|reason| reason.contains("capacity horizon")),
            "reason={:?}",
            long_result.reason
        );
        assert_eq!(
            long.base_value()["quantumLogisticsNetwork"]["inventory"]["iron_ore"],
            json!("10000")
        );

        let mut segmented = initial;
        for seconds in [30.0, 2000.0, 2000.0, 2000.0] {
            let revision = segmented.revision;
            let result = advance_macro_v10(
                &mut segmented,
                &pure_idle_macro_request(revision, seconds, seconds / 15.0),
            )
            .unwrap();
            assert!(result.supported, "reason={:?}", result.reason);
        }
        assert_eq!(
            segmented.summary().unwrap().canonical_sha256,
            long.summary().unwrap().canonical_sha256
        );
    }

    #[test]
    fn macro_v10_application_failure_preserves_source_hash_revision_and_credit() {
        let mut state = productive_quantum_macro_fixture(15.0, "infinite");
        let revision = state.revision;
        let result =
            advance_macro_v10(&mut state, &pure_idle_macro_request(revision, 30.0, 2.0)).unwrap();
        assert!(result.supported, "reason={:?}", result.reason);
        state.pure_idle_macro_runtime.as_mut().unwrap().certificate =
            Some(OrdinaryFlowCertificate {
                units_per_second: BTreeMap::from([("iron_ore".to_owned(), i128::MAX)]),
                produced_units_per_second: BTreeMap::from([("iron_ore".to_owned(), i128::MAX)]),
                consumed_units_per_second: MaterialTotals::new(),
                recipe_ids: Vec::new(),
                research: None,
                dyson_rocket: None,
                dyson_sail: None,
            });
        let before_revision = state.revision;
        let before_hash = state.summary().unwrap().canonical_sha256;
        let before_credit = state.pure_idle_macro_exact_seconds_used();
        let result = advance_macro_v10(
            &mut state,
            &pure_idle_macro_request(before_revision, 15.0, 1.0),
        )
        .unwrap();
        assert!(!result.supported);
        assert!(
            result
                .reason
                .as_deref()
                .is_some_and(|reason| reason.contains("source schedule overflowed")),
            "reason={:?}",
            result.reason
        );
        assert_eq!(state.revision, before_revision);
        assert_eq!(state.summary().unwrap().canonical_sha256, before_hash);
        assert_eq!(state.pure_idle_macro_exact_seconds_used(), before_credit);
    }

    #[test]
    fn macro_v10_rejection_preserves_source_hash_revision_and_mode_credit() {
        let mut state = productive_powered_fixture(15.0, "infinite");
        state
            .install_pure_idle_macro_session_progress(10.0)
            .unwrap();
        let before_revision = state.revision;
        let before_hash = state.summary().unwrap().canonical_sha256;
        let result = advance_macro_v10(
            &mut state,
            &pure_idle_macro_request(before_revision, 30.0, 1.0),
        )
        .unwrap();
        assert!(!result.supported);
        assert_eq!(
            result.reason.as_deref(),
            Some("pure-idle-power-multiplier-changed")
        );
        assert_eq!(state.revision, before_revision);
        assert_eq!(state.summary().unwrap().canonical_sha256, before_hash);
        assert_eq!(state.pure_idle_macro_exact_seconds_used(), 10.0);
        assert_eq!(state.pure_idle_exact_seconds_used(), 0.0);
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

    #[test]
    fn durable_replay_preserves_macro_v10_mode_and_three_window_credit() {
        let initial = productive_powered_fixture(15.0, "infinite");
        let mut expected = initial.clone();
        let result =
            advance_macro_v10(&mut expected, &pure_idle_macro_request(7, 60.0, 4.0)).unwrap();
        assert!(result.supported, "reason={:?}", result.reason);
        assert_eq!(result.revision, 10);

        let mut replayed = initial;
        replayed
            .replay_operation(7, 10, None, 60.0, 4.0, CoreAdvanceMode::PureIdleMacroV10)
            .unwrap();
        assert_eq!(
            replayed.summary().unwrap().canonical_sha256,
            expected.summary().unwrap().canonical_sha256
        );
        assert_eq!(replayed.pure_idle_macro_exact_seconds_used(), 30.0);
        assert_eq!(replayed.pure_idle_exact_seconds_used(), 0.0);
    }
}
