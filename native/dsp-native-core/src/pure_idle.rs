use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::ops::Range;
use std::sync::Arc;
#[cfg(test)]
use std::sync::{Mutex, MutexGuard, OnceLock};

use anyhow::{anyhow, bail};
use num_bigint::BigUint;
use num_traits::ToPrimitive;
use serde_json::{Map, Number, Value};

use crate::construction::ConstructionRunReceipt;
use crate::deterministic_runtime::{
    DeterministicRuntime, IndexedPrepareDiagnostics, PartitionedPrepareDiagnostics,
    runtime as deterministic_runtime,
};
use crate::simulation::{CoreAdvanceMode, CoreAdvanceRequest, CoreAdvanceResult};
use crate::state::{
    CoreState, PURE_IDLE_MACRO_CONSTRUCTION_BLOCK_SECONDS,
    PURE_IDLE_MACRO_CONSTRUCTION_QUANTUM_REPLAY_SECONDS, PURE_IDLE_SESSION_EXACT_CREDIT_SECONDS,
};

const ALGORITHM_VERSION: &str =
    "native-pure-idle-conservative-v4-session-bounded-30s-settlement-proof-v1";
const MACRO_V10_ALGORITHM_VERSION: &str =
    "native-pure-idle-macro-v10-closed-ledger-construction-quantum-v15";
pub(crate) const OFFLINE_MACRO_V1_ALGORITHM_VERSION: &str =
    "native-offline-macro-v1-closed-ledger-one-shot-v2-boundary-exact";
const MACRO_V10_CALIBRATION_WINDOW_SECONDS: f64 = 10.0;
const MICROS_PER_SECOND: i128 = 1_000_000;
const DYSON_ROCKET_LAUNCH_ENERGY_MICRO_MJ: i128 = 108_000_000;
const DEFAULT_QUANTUM_ITEM_CAPACITY: i128 = 10_000_000_000;
const MAX_ADVANCE_SECONDS: f64 = 30.0 * 24.0 * 60.0 * 60.0;
const EPSILON: f64 = 0.000_001;
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;
const TERMINAL_ROCKET_ITEM_ID: &str = "small_carrier_rocket";
const TERMINAL_SAIL_ITEM_ID: &str = "solar_sail";
const SETTLEMENT_ENTITY_ROWS_PER_CHUNK: usize = 256;
const MAX_BOUNDED_HANDCRAFT_TAIL_BATCHES: i128 = 4_096;
const HANDCRAFT_PROGRESS_EPSILON: f64 = 0.0001;
const OFFLINE_BOUNDARY_EXACT_MAX_SECONDS: f64 = 8.0 * 60.0 * 60.0;
const OFFLINE_BOUNDARY_EXACT_MAX_WORK: u128 = 4_000_000;

/// The product authority runs one pure-idle settlement at a time. The Rust
/// test harness normally overlaps dozens of large synthetic macro settlements,
/// multiplying deep JSON/Rayon frames in one Windows process. Keep that
/// artificial overlap out of test builds while leaving exact-mode tests and
/// every production build untouched.
#[cfg(test)]
fn macro_v10_test_guard() -> MutexGuard<'static, ()> {
    static GATE: OnceLock<Mutex<()>> = OnceLock::new();
    GATE.get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|error| error.into_inner())
}

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

/// Compact persisted-resource identity captured at a settlement boundary.
/// Infinite-mode veins and naturally infinite oceans are deliberately absent:
/// only a finite reserve can fund a finite-tail certificate.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct FiniteVeinProofSnapshot {
    entity_index: usize,
    entity_id: String,
    planet_id: String,
    resource_id: String,
    miner_count: i128,
    consumption_tenths: i128,
    tracks_depletion_remainder: bool,
    remaining: i128,
    depletion_remainder: i128,
}

/// Bit-exact, non-negative finite power reading. Power metrics are rounded
/// diagnostics rather than material counters, so retaining their IEEE-754
/// identity avoids inventing integer precision above JavaScript's safe range
/// while still making adjacent exact-window comparisons deterministic.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct PowerProofScalar(u64);

impl PowerProofScalar {
    fn from_f64(value: f64, label: &str) -> anyhow::Result<Self> {
        if !value.is_finite() || value < 0.0 {
            bail!("{label} is not a finite non-negative power value");
        }
        Ok(Self(if value == 0.0 { 0 } else { value.to_bits() }))
    }

    fn from_value(value: Option<&Value>, label: &str) -> anyhow::Result<Self> {
        let value = value
            .and_then(Value::as_f64)
            .ok_or_else(|| anyhow!("{label} is missing or not numeric"))?;
        Self::from_f64(value, label)
    }

    fn from_optional_value(value: Option<&Value>, label: &str) -> anyhow::Result<Self> {
        match value {
            None | Some(Value::Null) => Ok(Self::default()),
            value => Self::from_value(value, label),
        }
    }

    fn get(self) -> f64 {
        f64::from_bits(self.0)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct PowerGridKey {
    planet_id: String,
    grid_id: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct RenewablePowerGridProofSnapshot {
    complete: bool,
    connected_entities: i128,
    disconnected_entities: i128,
    demand_kw: PowerProofScalar,
    wind_generation_kw: PowerProofScalar,
    solar_generation_kw: PowerProofScalar,
    geothermal_generation_kw: PowerProofScalar,
    thermal_generation_kw: PowerProofScalar,
    fusion_generation_kw: PowerProofScalar,
    artificial_star_generation_kw: PowerProofScalar,
    ray_generation_kw: PowerProofScalar,
    storage_discharge_kw: PowerProofScalar,
    storage_charge_kw: PowerProofScalar,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct RenewablePowerProofSnapshot {
    time_warp_complete: bool,
    controller_entity_id: String,
    requested_multiplier: PowerProofScalar,
    effective_multiplier: PowerProofScalar,
    required_power_kw: PowerProofScalar,
    allocated_power_kw: PowerProofScalar,
    grids: BTreeMap<PowerGridKey, RenewablePowerGridProofSnapshot>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RenewablePowerGridGrant {
    demand_ceiling_kw: PowerProofScalar,
    static_generation_floor_kw: PowerProofScalar,
    ray_generation_floor_kw: PowerProofScalar,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RenewablePowerTailCertificate {
    /// Offline settlement has no powered time-warp controller. Keeping this
    /// authority bit inside the runtime-only certificate prevents a disabled
    /// controller from being mistaken for a reusable live time-warp grant.
    offline_authority: bool,
    controller_entity_id: String,
    controller_grid: PowerGridKey,
    requested_multiplier: PowerProofScalar,
    effective_multiplier: PowerProofScalar,
    required_power_kw: PowerProofScalar,
    allocated_power_kw: PowerProofScalar,
    grids: BTreeMap<PowerGridKey, RenewablePowerGridGrant>,
    structure_floor_by_system: BTreeMap<String, i128>,
    shell_floor_by_system: BTreeMap<String, i128>,
}

/// Runtime-only authority for a construction-only macro tail. This certificate
/// never grants arbitrary logistics delivery, research, Dyson or terminal
/// work. A narrow optional quantum grant lets construction consume ordinary
/// production that was first credited by the closed material ledger, using at
/// most thirty seconds of the exact five-second download allocator.
/// Every admitted center belongs to a grid whose complete calibrated demand
/// is covered by a permanent renewable lower bound, so the tail never burns
/// fuel or storage owned by another subsystem.
#[derive(Debug, Clone, PartialEq, Eq)]
struct ConstructionTailCertificate {
    renewable_power: RenewablePowerTailCertificate,
    center_entity_ids: Vec<String>,
    quantum: Option<ConstructionQuantumTailGrant>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ConstructionQuantumTailGrant {
    fingerprint: String,
    download_per_boundary: u64,
}

/// Ephemeral proof input for one native candidate. It is never serialized into
/// public GameState v47, the save envelope, or a canonical hash. Each capture
/// owns only compact per-item counters; entity rows are decoded one at a time.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct SettlementProofSnapshot {
    revision: u64,
    owned: MaterialTotals,
    produced: MaterialTotals,
    consumed: MaterialTotals,
    granted: MaterialTotals,
    construction_outputs: MaterialTotals,
    construction_fleet_wip: MaterialTotals,
    portable_fleet: MaterialTotals,
    construction_crafted: i128,
    /// Private proof for the exact revision interval ending at `revision`.
    /// Baselines and serialized/reloaded states deliberately carry `None`.
    construction_receipt: Option<ConstructionRunReceipt>,
    dyson: DysonTerminalSnapshot,
    renewable_power: RenewablePowerProofSnapshot,
    research: ResearchProofSnapshot,
    finite_veins: BTreeMap<String, FiniteVeinProofSnapshot>,
    /// Runtime-only terminal endpoints. Malformed or older optional terminal
    /// state does not make an otherwise loadable v47 save invalid; it simply
    /// cannot earn a productive macro-tail certificate.
    galactic_export: Option<crate::galactic_exports::CertifiedPureIdleExportEndpoint>,
    orbital_contracts: Option<crate::orbital_station::PureIdleContractEndpoint>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct SettlementRouteContribution {
    route_id: String,
    route: Map<String, Value>,
}

/// Private output of one fixed settlement-proof row chunk. Workers may only
/// parse immutable entity rows and write their own chunk. The authoritative
/// fold below consumes chunks and routes in ascending persisted order, so
/// duplicate route IDs retain the frozen first-match behavior at every worker
/// count.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct SettlementEntityChunk {
    owned: MaterialTotals,
    consumed: MaterialTotals,
    routes: Vec<SettlementRouteContribution>,
    parsed_entity_count: usize,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct SettlementEntityTotals {
    owned: MaterialTotals,
    consumed: MaterialTotals,
    route_reservations: HashMap<String, MaterialTotals>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct SettlementEntityScanDiagnostics {
    entity_count: usize,
    parsed_entity_count: usize,
    chunk_count: usize,
    selected_worker_count: usize,
    parallel_path: bool,
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

/// A physical Galactic export sink funded exclusively by production observed
/// inside the same exact calibration windows. Construction-activity personal
/// totals and pending batches are mirrors/outbox state, never a second sink or
/// an owned inventory source.
#[derive(Debug, Clone, PartialEq, Eq)]
struct GalacticExportSinkCertificate {
    consumed_units_per_second: MaterialTotals,
    expected: crate::galactic_exports::CertifiedPureIdleExportEndpoint,
}

/// An accepted orbital-contract sink. The endpoint binds accepted-array and
/// requirement order; its helper rejects source-restricted/quantum channels
/// and clips one unit before the first claimable/reward boundary.
#[derive(Debug, Clone, PartialEq, Eq)]
struct OrbitalContractSinkCertificate {
    consumed_units_per_second: MaterialTotals,
    requirement_rates: Vec<OrbitalContractRequirementRate>,
    expected: crate::orbital_station::PureIdleContractEndpoint,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct OrbitalContractRequirementRate {
    contract_index: usize,
    contract_id: String,
    requirement_index: usize,
    item_id: String,
    units_per_second: i128,
}

/// Per-vein depletion receipt for a stable finite source. The current public
/// v47 fields remain the ledger: no new persisted format or hidden material
/// balance is introduced.
#[derive(Debug, Clone, PartialEq, Eq)]
struct FiniteVeinCertificate {
    units_per_second: i128,
    expected: FiniteVeinProofSnapshot,
}

/// A deliberately narrow productive contract. Every admitted item is an
/// exclusive vein output whose aggregate owned-stock increase equals
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
    /// Stable finite source rows whose public reserve fields must be debited
    /// before the corresponding gross production can be committed.
    finite_veins: Vec<FiniteVeinCertificate>,
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
    /// Optional activity-bounded building export terminal. Its activity
    /// reporting rows are non-material mirrors of this physical sink.
    galactic_export: Option<GalacticExportSinkCertificate>,
    /// Optional accepted-contract terminal funded by the same closed gross
    /// production vector as every other ordinary sink.
    orbital_contracts: Option<OrbitalContractSinkCertificate>,
    /// Runtime-only, per-grid lower-bound proof. It is present only when a
    /// solar-sail lifecycle shares power authority with dynamic ray receivers.
    renewable_power: Option<RenewablePowerTailCertificate>,
}

#[derive(Debug, Clone, Default)]
struct OrdinaryTerminalCertificates {
    research: Option<ResearchSinkCertificate>,
    dyson_rocket: Option<DysonRocketSinkCertificate>,
    dyson_sail: Option<DysonSailSinkCertificate>,
    galactic_export: Option<GalacticExportSinkCertificate>,
    orbital_contracts: Option<OrbitalContractSinkCertificate>,
    renewable_power: Option<RenewablePowerTailCertificate>,
}

#[derive(Debug)]
#[cfg_attr(not(test), allow(dead_code))]
struct OrdinaryCertificatePrepareOutcome {
    result: Result<OrdinaryFlowCertificate, String>,
    entity_parse: Option<IndexedPrepareDiagnostics>,
    wave_one: Option<PartitionedPrepareDiagnostics>,
    wave_two: Option<PartitionedPrepareDiagnostics>,
}

#[derive(Debug)]
#[cfg_attr(not(test), allow(dead_code))]
struct ConstructionCertificatePrepareOutcome {
    result: Result<Option<ConstructionTailCertificate>, String>,
    entity_parse: Option<IndexedPrepareDiagnostics>,
    wave: Option<PartitionedPrepareDiagnostics>,
}

fn pure_idle_certificate_prepare_work_items(state: &CoreState) -> usize {
    state
        .entities
        .ids
        .len()
        .saturating_add(state.belts.ids.len())
}

fn profile_certificate_prepare(
    label: &str,
    diagnostics: PartitionedPrepareDiagnostics,
    elapsed: std::time::Duration,
) {
    if std::env::var_os("DSP_NATIVE_CORE_PROFILE").is_none() {
        return;
    }
    eprintln!(
        "DSP_NATIVE_CORE_PROFILE\t{label}\twallMs={:.3},activePartitions={},workItems={},selectedWorkers={},observedWorkers={},parallel={}",
        elapsed.as_secs_f64() * 1_000.0,
        diagnostics.active_partitions,
        diagnostics.work_items,
        diagnostics.selected_worker_count,
        diagnostics.observed_worker_count,
        u8::from(diagnostics.parallel),
    );
}

fn profile_certificate_entity_parse(
    label: &str,
    diagnostics: IndexedPrepareDiagnostics,
    elapsed: std::time::Duration,
) {
    if std::env::var_os("DSP_NATIVE_CORE_PROFILE").is_none() {
        return;
    }
    eprintln!(
        "DSP_NATIVE_CORE_PROFILE\t{label}\twallMs={:.3},items={},selectedWorkers={},observedWorkers={},parallel={}",
        elapsed.as_secs_f64() * 1_000.0,
        diagnostics.item_count,
        diagnostics.selected_worker_count,
        diagnostics.observed_worker_count,
        u8::from(diagnostics.parallel),
    );
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
    construction_certificate: Option<ConstructionTailCertificate>,
    construction_rejection_reason: Option<String>,
}

impl PureIdleMacroRuntimeCache {
    fn starts_at(revision: u64, snapshot: SettlementProofSnapshot) -> Self {
        Self {
            last_committed_revision: revision,
            calibration_snapshots: vec![snapshot],
            certificate: None,
            rejection_reason: None,
            construction_certificate: None,
            construction_rejection_reason: None,
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
            construction_certificate: None,
            construction_rejection_reason: Some(
                "runtime calibration cache was unavailable; a disposable construction probe is required"
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
    let time_warp_enabled = base
        .get("timeWarp")
        .and_then(Value::as_object)
        .and_then(|time_warp| time_warp.get("enabled"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if _request.advance_mode == CoreAdvanceMode::OfflineMacroV1 {
        if time_warp_enabled {
            return Some("offline-macro-time-warp-active");
        }
    } else if !time_warp_enabled {
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

    if request.advance_mode == CoreAdvanceMode::OfflineMacroV1 {
        let tolerance = EPSILON
            * request
                .simulation_seconds
                .max(request.wall_seconds)
                .max(1.0);
        if (request.simulation_seconds - request.wall_seconds).abs() > tolerance {
            return Some("offline-macro-budget-must-match-wall-time");
        }
        return None;
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
        CoreAdvanceMode::OfflineMacroV1 => OFFLINE_MACRO_V1_ALGORITHM_VERSION,
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
    /// Wall-clock share paired with the frozen simulated tail. Material
    /// terminals normally ignore wall time, but an activity-scoped export
    /// certificate must stop at its persisted half-open start/end boundary.
    /// Keeping the remainder explicit also makes one long request and any
    /// ordered segmentation advance that boundary by the same total amount.
    frozen_tail_wall_seconds: f64,
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
        frozen_tail_wall_seconds: (wall_seconds - exact_wall_seconds).max(0.0),
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

fn capture_renewable_power_proof_snapshot(
    state: &CoreState,
) -> anyhow::Result<RenewablePowerProofSnapshot> {
    let base = state.base_value();
    let time_warp = base.get("timeWarp").and_then(Value::as_object);
    let controller_entity_id = time_warp
        .and_then(|time_warp| time_warp.get("controllerEntityId"))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .unwrap_or_default()
        .to_owned();
    let time_warp_fields = [
        "requestedMultiplier",
        "effectiveMultiplier",
        "requiredPowerKw",
        "allocatedPowerKw",
    ];
    let mut snapshot = RenewablePowerProofSnapshot {
        time_warp_complete: !controller_entity_id.is_empty()
            && time_warp_fields.iter().all(|field| {
                time_warp
                    .and_then(|time_warp| time_warp.get(*field))
                    .is_some_and(Value::is_number)
            }),
        controller_entity_id,
        requested_multiplier: PowerProofScalar::from_optional_value(
            time_warp.and_then(|time_warp| time_warp.get("requestedMultiplier")),
            "timeWarp.requestedMultiplier",
        )?,
        effective_multiplier: PowerProofScalar::from_optional_value(
            time_warp.and_then(|time_warp| time_warp.get("effectiveMultiplier")),
            "timeWarp.effectiveMultiplier",
        )?,
        required_power_kw: PowerProofScalar::from_optional_value(
            time_warp.and_then(|time_warp| time_warp.get("requiredPowerKw")),
            "timeWarp.requiredPowerKw",
        )?,
        allocated_power_kw: PowerProofScalar::from_optional_value(
            time_warp.and_then(|time_warp| time_warp.get("allocatedPowerKw")),
            "timeWarp.allocatedPowerKw",
        )?,
        grids: BTreeMap::new(),
    };
    let Some(power_metrics) = base.get("powerGridMetrics").and_then(Value::as_object) else {
        return Ok(snapshot);
    };
    for (planet_id, grids) in power_metrics {
        if !state
            .catalog
            .planets
            .iter()
            .any(|planet| planet.id == *planet_id)
        {
            bail!("powerGridMetrics contains unknown planet {planet_id}");
        }
        let grids = grids
            .as_object()
            .ok_or_else(|| anyhow!("powerGridMetrics.{planet_id} is not an object"))?;
        for (grid_id, metric) in grids {
            if !matches!(grid_id.as_str(), "grid-a" | "grid-b" | "grid-c") {
                bail!("powerGridMetrics.{planet_id} contains unknown grid {grid_id}");
            }
            let metric = metric.as_object().ok_or_else(|| {
                anyhow!("powerGridMetrics.{planet_id}.{grid_id} is not an object")
            })?;
            let required_fields = [
                "demandKw",
                "windGenerationKw",
                "solarGenerationKw",
                "geothermalGenerationKw",
                "thermalGenerationKw",
                "fusionGenerationKw",
                "artificialStarGenerationKw",
                "rayGenerationKw",
                "storageDischargeKw",
                "storageChargeKw",
                "connectedEntities",
                "disconnectedEntities",
            ];
            let read = |field: &str| {
                PowerProofScalar::from_optional_value(
                    metric.get(field),
                    &format!("powerGridMetrics.{planet_id}.{grid_id}.{field}"),
                )
            };
            snapshot.grids.insert(
                PowerGridKey {
                    planet_id: planet_id.clone(),
                    grid_id: grid_id.clone(),
                },
                RenewablePowerGridProofSnapshot {
                    complete: required_fields
                        .iter()
                        .all(|field| metric.get(*field).is_some_and(Value::is_number)),
                    connected_entities: proof_counter(
                        metric.get("connectedEntities"),
                        &format!("powerGridMetrics.{planet_id}.{grid_id}.connectedEntities"),
                    )?,
                    disconnected_entities: proof_counter(
                        metric.get("disconnectedEntities"),
                        &format!("powerGridMetrics.{planet_id}.{grid_id}.disconnectedEntities"),
                    )?,
                    demand_kw: read("demandKw")?,
                    wind_generation_kw: read("windGenerationKw")?,
                    solar_generation_kw: read("solarGenerationKw")?,
                    geothermal_generation_kw: read("geothermalGenerationKw")?,
                    thermal_generation_kw: read("thermalGenerationKw")?,
                    fusion_generation_kw: read("fusionGenerationKw")?,
                    artificial_star_generation_kw: read("artificialStarGenerationKw")?,
                    ray_generation_kw: read("rayGenerationKw")?,
                    storage_discharge_kw: read("storageDischargeKw")?,
                    storage_charge_kw: read("storageChargeKw")?,
                },
            );
        }
    }
    Ok(snapshot)
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

fn finite_vein_snapshot_at(
    state: &CoreState,
    entity_index: usize,
) -> anyhow::Result<Option<FiniteVeinProofSnapshot>> {
    let base = state.base_value();
    let resource_mode = base
        .get("settings")
        .and_then(Value::as_object)
        .and_then(|settings| settings.get("resourceMode"))
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("settings.resourceMode is missing"))?;
    if resource_mode == "infinite" {
        return Ok(None);
    }
    if resource_mode != "finite" {
        bail!("settings.resourceMode is invalid");
    }

    let entity = state.parse_entity(entity_index)?;
    let entity = entity
        .as_object()
        .ok_or_else(|| anyhow!("finite vein entity is not an object"))?;
    if entity.get("kind").and_then(Value::as_str) != Some("vein") {
        bail!("finite vein topology points at a non-vein entity");
    }
    let required_id = |key: &str| -> anyhow::Result<String> {
        entity
            .get(key)
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
            .ok_or_else(|| anyhow!("finite vein is missing {key}"))
    };
    let entity_id = required_id("id")?;
    let planet_id = required_id("planetId")?;
    let resource_id = required_id("resourceId")?;
    let item_kind = state
        .catalog
        .items
        .get(&resource_id)
        .map(|item| item.kind.as_str())
        .ok_or_else(|| anyhow!("finite vein resource {resource_id} is absent from the catalog"))?;
    if !matches!(item_kind, "solid" | "fluid") {
        bail!("finite vein resource {resource_id} is not mineable");
    }

    let vein_level = proof_counter(
        base.get("endgame")
            .and_then(Value::as_object)
            .and_then(|endgame| endgame.get("infiniteResearch"))
            .and_then(Value::as_object)
            .and_then(|research| research.get("vein_utilization"))
            .and_then(Value::as_object)
            .and_then(|progress| progress.get("level")),
        "endgame.infiniteResearch.vein_utilization.level",
    )?;
    let consumption_tenths = if item_kind == "solid" {
        10_i128.saturating_sub(vein_level.min(10))
    } else {
        10
    };
    let ocean_type = base
        .get("galaxy")
        .and_then(Value::as_object)
        .and_then(|galaxy| galaxy.get("profiles"))
        .and_then(Value::as_object)
        .and_then(|profiles| profiles.get(&planet_id))
        .and_then(Value::as_object)
        .and_then(|profile| profile.get("oceanType"))
        .and_then(Value::as_str)
        .unwrap_or("none");
    let naturally_infinite = consumption_tenths == 0
        || resource_id == "water" && ocean_type == "water"
        || resource_id == "sulfuric_acid" && ocean_type == "sulfuric-acid";
    if naturally_infinite {
        return Ok(None);
    }

    let remaining_value = entity
        .get("resourceRemaining")
        .ok_or_else(|| anyhow!("finite vein {entity_id} has no resourceRemaining"))?;
    let remaining = proof_counter(
        Some(remaining_value),
        &format!("entities.{entity_id}.resourceRemaining"),
    )?;
    let tracks_depletion_remainder = item_kind == "solid";
    let depletion_remainder = if tracks_depletion_remainder {
        let remainder_value = entity.get("resourceDepletionRemainder").ok_or_else(|| {
            anyhow!("finite solid vein {entity_id} has no resourceDepletionRemainder")
        })?;
        proof_counter(
            Some(remainder_value),
            &format!("entities.{entity_id}.resourceDepletionRemainder"),
        )?
    } else {
        0
    };
    if depletion_remainder >= 10 {
        bail!("finite vein {entity_id} depletion remainder is outside 0..9");
    }
    Ok(Some(FiniteVeinProofSnapshot {
        entity_index,
        entity_id,
        planet_id,
        resource_id,
        miner_count: proof_counter(entity.get("minerCount"), "finiteVein.minerCount")?,
        consumption_tenths,
        tracks_depletion_remainder,
        remaining,
        depletion_remainder,
    }))
}

fn capture_finite_veins(
    state: &CoreState,
) -> anyhow::Result<BTreeMap<String, FiniteVeinProofSnapshot>> {
    let mut veins = BTreeMap::new();
    for &entity_index in &state.factory_topology.vein_indices {
        let Some(snapshot) = finite_vein_snapshot_at(state, entity_index)? else {
            continue;
        };
        let entity_id = snapshot.entity_id.clone();
        if veins.insert(entity_id.clone(), snapshot).is_some() {
            bail!("finite vein proof repeats entity ID {entity_id}");
        }
    }
    Ok(veins)
}

fn merge_material_totals(
    target: &mut MaterialTotals,
    source: &MaterialTotals,
    label: &str,
) -> anyhow::Result<()> {
    for (item_id, amount) in source {
        add_material_amount(target, item_id, *amount, label)?;
    }
    Ok(())
}

fn capture_settlement_entity_chunk(
    state: &CoreState,
    range: Range<usize>,
) -> anyhow::Result<SettlementEntityChunk> {
    let mut chunk = SettlementEntityChunk::default();
    for entity_index in range {
        let entity = state.parse_entity(entity_index)?;
        let entity = entity
            .as_object()
            .ok_or_else(|| anyhow!("native settlement proof entity is not an object"))?;
        let entity_id = entity
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        add_material_store(
            &mut chunk.owned,
            entity.get("inputs"),
            &format!("entities.{entity_id}.inputs"),
        )?;
        add_material_store(
            &mut chunk.owned,
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
                    &mut chunk.owned,
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
                chunk.routes.push(SettlementRouteContribution {
                    route_id: route_id.to_owned(),
                    route: route.clone(),
                });
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
                    &mut chunk.consumed,
                    item_id,
                    port.get("totalDestroyed"),
                    &format!("entities.{entity_id}.blackHolePorts.{port_index}.totalDestroyed"),
                )?;
            }
        }
        chunk.parsed_entity_count += 1;
    }
    Ok(chunk)
}

fn fold_settlement_entity_chunks(
    chunks: Vec<anyhow::Result<SettlementEntityChunk>>,
    entity_count: usize,
    selected_worker_count: usize,
) -> anyhow::Result<(SettlementEntityTotals, SettlementEntityScanDiagnostics)> {
    let chunk_count = chunks.len();
    let mut totals = SettlementEntityTotals::default();
    let mut seen_route_ids = HashSet::<String>::new();
    let mut parsed_entity_count = 0_usize;
    for chunk in chunks {
        let chunk = chunk?;
        parsed_entity_count = parsed_entity_count
            .checked_add(chunk.parsed_entity_count)
            .ok_or_else(|| anyhow!("settlement proof parsed entity count overflow"))?;
        merge_material_totals(&mut totals.owned, &chunk.owned, "entities")?;
        merge_material_totals(&mut totals.consumed, &chunk.consumed, "entities.consumed")?;
        for route in chunk.routes {
            if !seen_route_ids.insert(route.route_id.clone()) {
                continue;
            }
            let item_id = route
                .route
                .get("itemId")
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow!("stationRoutes.{}.itemId is invalid", route.route_id))?;
            let cargo = proof_counter(
                route.route.get("cargo"),
                &format!("stationRoutes.{}.cargo", route.route_id),
            )?;
            add_material_amount(
                &mut totals.owned,
                item_id,
                cargo,
                &format!("stationRoutes.{}", route.route_id),
            )?;
            if let Some(source_id) = route.route.get("peerId").and_then(Value::as_str) {
                add_material_amount(
                    totals
                        .route_reservations
                        .entry(source_id.to_owned())
                        .or_default(),
                    item_id,
                    cargo,
                    &format!("stationRoutes.{}.reservation", route.route_id),
                )?;
            }
        }
    }
    if parsed_entity_count != entity_count {
        bail!("settlement proof parsed {parsed_entity_count} of {entity_count} entity rows");
    }
    Ok((
        totals,
        SettlementEntityScanDiagnostics {
            entity_count,
            parsed_entity_count,
            chunk_count,
            selected_worker_count,
            parallel_path: selected_worker_count > 1 && chunk_count > 1,
        },
    ))
}

fn capture_entity_settlement_with_runtime(
    state: &CoreState,
    runtime: &DeterministicRuntime,
) -> anyhow::Result<(SettlementEntityTotals, SettlementEntityScanDiagnostics)> {
    let entity_count = state.entity_index.len();
    let selected_worker_count = runtime.worker_count_for_items(entity_count);
    let chunks = runtime.ordered_chunk_map(
        entity_count,
        SETTLEMENT_ENTITY_ROWS_PER_CHUNK,
        |_, range| capture_settlement_entity_chunk(state, range),
    );
    fold_settlement_entity_chunks(chunks, entity_count, selected_worker_count)
}

#[cfg(test)]
fn capture_entity_settlement_serial_oracle(
    state: &CoreState,
) -> anyhow::Result<SettlementEntityTotals> {
    let entity_count = state.entity_index.len();
    let chunk = capture_settlement_entity_chunk(state, 0..entity_count)?;
    fold_settlement_entity_chunks(vec![Ok(chunk)], entity_count, 1).map(|(totals, _)| totals)
}

fn capture_settlement_snapshot(state: &CoreState) -> anyhow::Result<SettlementProofSnapshot> {
    capture_settlement_snapshot_with_runtime(state, deterministic_runtime())
}

fn capture_settlement_snapshot_with_runtime(
    state: &CoreState,
    runtime: &DeterministicRuntime,
) -> anyhow::Result<SettlementProofSnapshot> {
    let base = state.base_value();
    let mut snapshot = SettlementProofSnapshot {
        revision: state.revision,
        granted: capture_cumulative_grants(state)?,
        construction_crafted: proof_counter(
            base.get("constructionAutomation")
                .and_then(Value::as_object)
                .and_then(|automation| automation.get("totalCrafted")),
            "constructionAutomation.totalCrafted",
        )?,
        dyson: capture_dyson_terminal(base)?,
        renewable_power: capture_renewable_power_proof_snapshot(state)?,
        research: capture_research_proof_snapshot(state)?,
        finite_veins: capture_finite_veins(state)?,
        galactic_export: crate::galactic_exports::capture_certified_pure_idle_export_endpoint(base)
            .ok(),
        orbital_contracts: crate::orbital_station::capture_pure_idle_contract_endpoint(state).ok(),
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

    let entity_scan_started = std::time::Instant::now();
    let (entity_totals, entity_scan) = capture_entity_settlement_with_runtime(state, runtime)?;
    if std::env::var_os("DSP_NATIVE_CORE_PROFILE").is_some() {
        eprintln!(
            "DSP_NATIVE_CORE_PROFILE\tpure-idle-settlement-entity-scan\t{:.3}",
            entity_scan_started.elapsed().as_secs_f64() * 1_000.0
        );
        eprintln!(
            "DSP_NATIVE_CORE_PROFILE\tpure-idle-settlement-entity-count\t{}",
            entity_scan.entity_count
        );
        eprintln!(
            "DSP_NATIVE_CORE_PROFILE\tpure-idle-settlement-entity-chunks\t{}",
            entity_scan.chunk_count
        );
        eprintln!(
            "DSP_NATIVE_CORE_PROFILE\tpure-idle-settlement-selected-workers\t{}",
            entity_scan.selected_worker_count
        );
        eprintln!(
            "DSP_NATIVE_CORE_PROFILE\tpure-idle-settlement-parallel-path\t{}",
            u8::from(entity_scan.parallel_path)
        );
    }
    merge_material_totals(&mut snapshot.owned, &entity_totals.owned, "entities")?;
    merge_material_totals(
        &mut snapshot.consumed,
        &entity_totals.consumed,
        "entities.consumed",
    )?;
    let route_reservations = entity_totals.route_reservations;

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

    // constructionActivity.personalDelivered and pendingBatches are two
    // reporting views of the same physical Galactic delivery represented by
    // exportProjects.*.totalDelivered below. Counting either as material would
    // double-consume or re-mint an outbox row as owned stock.

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

/// Capture a boundary reached only through native exact advancement and bind
/// it to the construction stage's private revision receipts. A normal save,
/// reload, or caller-created candidate has no way to synthesize this field.
fn capture_exact_settlement_snapshot(
    state: &CoreState,
    base_revision: u64,
) -> anyhow::Result<SettlementProofSnapshot> {
    capture_exact_settlement_snapshot_with_runtime(state, base_revision, deterministic_runtime())
}

fn capture_exact_settlement_snapshot_with_runtime(
    state: &CoreState,
    base_revision: u64,
    runtime: &DeterministicRuntime,
) -> anyhow::Result<SettlementProofSnapshot> {
    let mut snapshot = capture_settlement_snapshot_with_runtime(state, runtime)?;
    snapshot.construction_receipt = state
        .prepared_construction_runtime()
        .and_then(|runtime| runtime.receipt_between(base_revision, state.revision));
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

fn finite_vein_static_state_matches(
    before: &FiniteVeinProofSnapshot,
    after: &FiniteVeinProofSnapshot,
) -> bool {
    before.entity_index == after.entity_index
        && before.entity_id == after.entity_id
        && before.planet_id == after.planet_id
        && before.resource_id == after.resource_id
        && before.miner_count == after.miner_count
        && before.consumption_tenths == after.consumption_tenths
        && before.tracks_depletion_remainder == after.tracks_depletion_remainder
}

fn finite_vein_extracted_units(
    before: &FiniteVeinProofSnapshot,
    after: &FiniteVeinProofSnapshot,
) -> Result<i128, String> {
    if !finite_vein_static_state_matches(before, after) {
        return Err(format!(
            "finite vein {} configuration changed during settlement",
            before.entity_id
        ));
    }
    if before.consumption_tenths <= 0
        || before.consumption_tenths > 10
        || !(0..10).contains(&before.depletion_remainder)
        || !(0..10).contains(&after.depletion_remainder)
    {
        return Err(format!(
            "finite vein {} depletion parameters are invalid",
            before.entity_id
        ));
    }
    let depleted = before
        .remaining
        .checked_sub(after.remaining)
        .ok_or_else(|| format!("finite vein {} reserve delta overflowed", before.entity_id))?;
    if depleted < 0 {
        return Err(format!(
            "finite vein {} reserve increased without an audited source",
            before.entity_id
        ));
    }
    let consumed_tenths = depleted
        .checked_mul(10)
        .and_then(|value| value.checked_add(after.depletion_remainder))
        .and_then(|value| value.checked_sub(before.depletion_remainder))
        .ok_or_else(|| {
            format!(
                "finite vein {} depletion ledger overflowed",
                before.entity_id
            )
        })?;
    if consumed_tenths < 0 || consumed_tenths % before.consumption_tenths != 0 {
        return Err(format!(
            "finite vein {} reserve/remainder delta is not a whole mined-unit receipt",
            before.entity_id
        ));
    }
    Ok(consumed_tenths / before.consumption_tenths)
}

fn validate_finite_vein_depletion(
    before: &SettlementProofSnapshot,
    after: &SettlementProofSnapshot,
) -> Result<MaterialTotals, String> {
    if before.finite_veins.keys().ne(after.finite_veins.keys()) {
        return Err("finite vein topology changed during settlement".to_owned());
    }
    let mut extracted_by_item = MaterialTotals::new();
    for (entity_id, before_vein) in &before.finite_veins {
        let after_vein = after
            .finite_veins
            .get(entity_id)
            .ok_or_else(|| format!("finite vein {entity_id} disappeared"))?;
        let extracted = finite_vein_extracted_units(before_vein, after_vein)?;
        let current = extracted_by_item
            .get(&before_vein.resource_id)
            .copied()
            .unwrap_or(0);
        extracted_by_item.insert(
            before_vein.resource_id.clone(),
            current.checked_add(extracted).ok_or_else(|| {
                format!("{} finite extraction overflowed", before_vein.resource_id)
            })?,
        );
    }
    Ok(extracted_by_item)
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
/// The native exact prefix interleaves ordinary factory work and construction,
/// so aggregate deltas alone cannot attribute a same-item loss to a particular
/// center. `construction::run_centers` now emits a runtime-only receipt for the
/// exact revision interval; serialized candidates remain receipt-free.
fn validate_construction_recipe_conversion(
    ledger: &ConstructionConversionLedger,
    catalog: &crate::catalog::RuntimeCatalog,
    receipt: Option<&ConstructionRunReceipt>,
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
    construction_receipt: Option<&ConstructionRunReceipt>,
) -> Result<(), String> {
    let construction = capture_construction_conversion_ledger(before, after)?;
    let finite_extraction = validate_finite_vein_depletion(before, after)?;

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
        let finite_mined = finite_extraction.get(&item_id).copied().unwrap_or(0);
        if finite_mined > produced_delta {
            return Err(format!(
                "{item_id} finite reserve funded {finite_mined} mined unit(s), but cumulative production increased by only {produced_delta}"
            ));
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
    // Keep the catalog/input-vector check as defense in depth, but do not mint
    // authority from the observed delta. The second gate accepts construction
    // output only when run_centers supplied the private revision receipt.
    validate_construction_recipe_conversion(&construction, catalog, None, true)?;
    validate_settlement_proof(before, after, catalog, after.construction_receipt.as_ref())
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

/// A closed upload-only tower moves already-owned material; its output slots
/// are buffers, not recipe production declarations. This classification grants
/// no material rate: the three exact windows must still close all production,
/// consumption, owned stock, recipe dependencies and finite reserve debits.
/// Keep mixed demand/local routes and transitions outside this narrow case.
fn is_ordinary_quantum_upload_endpoint(state: &CoreState, entity: &Value) -> bool {
    if entity.get("kind").and_then(Value::as_str) != Some("station")
        || entity.get("buildingId").and_then(Value::as_str)
            != Some("interstellar_logistics_station")
        || entity.get("quantumMode").and_then(Value::as_str) != Some("quantum")
        || number_at(Some(entity), &["stationTier"]) < 2.0
        || entity
            .get("recipeId")
            .is_some_and(|id| !id.is_null() && id.as_str() != Some(""))
        || entity
            .get("stationModeTransition")
            .is_some_and(|transition| !transition.is_null())
        || entity
            .get("stationRoutes")
            .is_some_and(|routes| routes.as_array().is_none_or(|routes| !routes.is_empty()))
        || number_at(Some(entity), &["stationDrones"]) != 0.0
        || number_at(Some(entity), &["stationVessels"]) != 0.0
        || state
            .catalog
            .buildings
            .get("interstellar_logistics_station")
            .is_none_or(|building| building.kind != "station")
    {
        return false;
    }
    let Some(slots) = entity.get("stationSlots").and_then(Value::as_array) else {
        return false;
    };
    let mut upload_items = BTreeSet::new();
    for slot in slots {
        if !slot.is_object()
            || slot
                .get("localMode")
                .and_then(Value::as_str)
                .unwrap_or("storage")
                != "storage"
        {
            return false;
        }
        let Some(item_id) = slot.get("itemId").and_then(Value::as_str) else {
            if slot.get("itemId").is_some_and(|item_id| !item_id.is_null())
                || slot
                    .get("remoteMode")
                    .and_then(Value::as_str)
                    .unwrap_or("storage")
                    != "storage"
            {
                return false;
            }
            continue;
        };
        if slot.get("remoteMode").and_then(Value::as_str) != Some("supply") {
            return false;
        }
        upload_items.insert(item_id);
    }
    !upload_items.is_empty()
        && ["inputs", "outputs"].into_iter().all(|field| {
            entity
                .get(field)
                .and_then(Value::as_object)
                .is_some_and(|buffers| {
                    buffers
                        .keys()
                        .all(|item_id| upload_items.contains(item_id.as_str()))
                })
        })
}

fn exclusive_vein_sources(state: &CoreState) -> Result<BTreeSet<String>, String> {
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
        if is_ordinary_quantum_upload_endpoint(state, &entity) {
            continue;
        }
        if let Some(outputs) = entity.get("outputs").and_then(Value::as_object) {
            for item_id in outputs.keys() {
                sources.remove(item_id);
            }
        }
    }
    if sources.is_empty() {
        return Err("no exclusive active vein source is available".to_owned());
    }
    Ok(sources)
}

/// Ray-power receivers are unlike wind, solar and geothermal facilities: their
/// available generation is derived from the live Dyson swarm/sphere state.
/// A certified solar-sail tail advances decay and absorption, so the exact
/// prefix's persisted time-warp power snapshot is not itself a lower bound for
/// that tail. This detector routes the mixed domain through the stricter
/// per-grid permanent-renewable certificate below; an unprovable combination
/// still fails closed instead of continuing with a stale powered multiplier.
fn has_dynamic_ray_power_source(state: &CoreState) -> Result<bool, String> {
    for &entity_index in &state.factory_topology.power_source_indices {
        let entity = state
            .parse_entity(entity_index)
            .map_err(|error| format!("power source decode failed: {error:#}"))?;
        if entity.get("kind").and_then(Value::as_str) == Some("machine")
            && entity.get("buildingId").and_then(Value::as_str) == Some("ray_receiver")
            && entity.get("recipeId").and_then(Value::as_str) == Some("ray_power")
        {
            return Ok(true);
        }
    }
    Ok(false)
}

const POWER_PROOF_ABSOLUTE_MARGIN_KW: f64 = 0.006;
const POWER_PROOF_RELATIVE_MARGIN: f64 = 1e-12;

fn conservative_power_floor(value: f64) -> Result<f64, String> {
    if !value.is_finite() || value < 0.0 {
        return Err("power lower-bound input is invalid".to_owned());
    }
    if value == 0.0 {
        return Ok(0.0);
    }
    let margin = POWER_PROOF_ABSOLUTE_MARGIN_KW.max(value.abs() * POWER_PROOF_RELATIVE_MARGIN);
    Ok((value - margin).max(0.0))
}

fn conservative_power_ceiling(value: f64, exact_empty_grid: bool) -> Result<f64, String> {
    if !value.is_finite() || value < 0.0 {
        return Err("power upper-bound input is invalid".to_owned());
    }
    // An empty grid has an exact zero demand, not a positive epsilon-sized
    // consumer. Keeping zero exact lets a topology that declares grid-b/c but
    // has no machines there remain certifiable without inventing generation.
    if value == 0.0 && exact_empty_grid {
        return Ok(0.0);
    }
    let margin = POWER_PROOF_ABSOLUTE_MARGIN_KW.max(value.abs() * POWER_PROOF_RELATIVE_MARGIN);
    let value = value + margin;
    if !value.is_finite() {
        return Err("power upper bound overflowed".to_owned());
    }
    Ok(value)
}

fn stable_renewable_power_grid(
    left: &RenewablePowerGridProofSnapshot,
    right: &RenewablePowerGridProofSnapshot,
) -> bool {
    left.complete
        && right.complete
        && left.connected_entities == right.connected_entities
        && left.disconnected_entities == right.disconnected_entities
        && left.demand_kw == right.demand_kw
        && left.wind_generation_kw == right.wind_generation_kw
        && left.solar_generation_kw == right.solar_generation_kw
        && left.geothermal_generation_kw == right.geothermal_generation_kw
        && left.thermal_generation_kw == right.thermal_generation_kw
        && left.fusion_generation_kw == right.fusion_generation_kw
        && left.artificial_star_generation_kw == right.artificial_star_generation_kw
        && left.storage_discharge_kw == right.storage_discharge_kw
        && left.storage_charge_kw == right.storage_charge_kw
}

fn controller_power_grid(
    state: &CoreState,
    controller_entity_id: &str,
) -> Result<PowerGridKey, String> {
    let entity_index = state
        .entity_index
        .get(controller_entity_id)
        .copied()
        .ok_or_else(|| "time-warp controller is absent from the entity directory".to_owned())?;
    let entity = state
        .parse_entity(entity_index)
        .map_err(|error| format!("time-warp controller decode failed: {error:#}"))?;
    if entity.get("buildingId").and_then(Value::as_str) != Some("time_warp_device") {
        return Err("time-warp controller entity has the wrong building".to_owned());
    }
    let planet_id = entity
        .get("planetId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "time-warp controller has no planet".to_owned())?;
    let grid_id = entity
        .get("powerGridId")
        .and_then(Value::as_str)
        .unwrap_or("grid-a");
    if !matches!(grid_id, "grid-a" | "grid-b" | "grid-c") {
        return Err("time-warp controller has an unknown grid".to_owned());
    }
    Ok(PowerGridKey {
        planet_id: planet_id.to_owned(),
        grid_id: grid_id.to_owned(),
    })
}

/// Computes a permanent lower bound for dynamic ray power without duplicating
/// Dyson formulas. The existing native reception allocator runs on a private
/// base where every in-orbit sail and its generation are zeroed. Structure and
/// shell counters remain, and neither can decrease in a certified sail tail,
/// so every returned per-grid allocation is sustainable for any window size.
fn conservative_ray_generation_by_grid(
    state: &CoreState,
    entities: &[Value],
) -> Result<BTreeMap<PowerGridKey, f64>, String> {
    let mut lower_base = state.base_value().clone();
    let systems = lower_base
        .get_mut("dysonEngineering")
        .and_then(Value::as_object_mut)
        .and_then(|engineering| engineering.get_mut("orbitsBySystem"))
        .and_then(Value::as_object_mut)
        .ok_or_else(|| "Dyson orbit directory is missing from the power proof".to_owned())?;
    for (system_id, orbits) in systems {
        let orbits = orbits
            .as_array_mut()
            .ok_or_else(|| format!("Dyson orbit directory {system_id} is malformed"))?;
        for (orbit_index, orbit) in orbits.iter_mut().enumerate() {
            let orbit = orbit
                .as_object_mut()
                .ok_or_else(|| format!("Dyson orbit {system_id}.{orbit_index} is malformed"))?;
            orbit.insert("sailsInOrbit".to_owned(), Value::from(0));
            orbit.insert("generationKw".to_owned(), Value::from(0));
        }
    }
    if let Some(swarm) = lower_base
        .get_mut("dysonSwarm")
        .and_then(Value::as_object_mut)
    {
        swarm.insert("sailsInOrbit".to_owned(), Value::from(0));
        swarm.insert("generationKw".to_owned(), Value::from(0));
    }
    let reception = crate::dyson::calculate_reception(state, &mut lower_base, entities)
        .map_err(|error| format!("Dyson ray-power lower-bound allocation failed: {error:#}"))?;
    let mut by_grid = BTreeMap::<PowerGridKey, f64>::new();
    for &entity_index in &state.factory_topology.power_source_indices {
        let entity = entities
            .get(entity_index)
            .and_then(Value::as_object)
            .ok_or_else(|| "ray-power source disappeared from its topology row".to_owned())?;
        if entity.get("buildingId").and_then(Value::as_str) != Some("ray_receiver")
            || entity.get("recipeId").and_then(Value::as_str) != Some("ray_power")
        {
            continue;
        }
        let entity_id = entity
            .get("id")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "ray-power source has no entity ID".to_owned())?;
        let planet_id = entity
            .get("planetId")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| format!("ray-power source {entity_id} has no planet"))?;
        let grid_id = entity
            .get("powerGridId")
            .and_then(Value::as_str)
            .unwrap_or("grid-a");
        if !matches!(grid_id, "grid-a" | "grid-b" | "grid-c") {
            return Err(format!("ray-power source {entity_id} has an unknown grid"));
        }
        let allocation = reception
            .ray_power_by_entity
            .get(entity_id)
            .copied()
            .unwrap_or(0.0);
        if !allocation.is_finite() || allocation < 0.0 {
            return Err(format!(
                "ray-power source {entity_id} has an invalid lower-bound allocation"
            ));
        }
        let key = PowerGridKey {
            planet_id: planet_id.to_owned(),
            grid_id: grid_id.to_owned(),
        };
        let next = by_grid.get(&key).copied().unwrap_or(0.0) + allocation;
        if !next.is_finite() {
            return Err(format!(
                "ray-power lower-bound allocation overflowed for {}.{}",
                key.planet_id, key.grid_id
            ));
        }
        by_grid.insert(key, next);
    }
    Ok(by_grid)
}

fn build_renewable_power_tail_certificate(
    state: &CoreState,
    snapshots: &[SettlementProofSnapshot],
    entity_snapshot: Result<&[Value], String>,
) -> Result<RenewablePowerTailCertificate, String> {
    if snapshots.len() != 4 {
        return Err("renewable power proof requires three exact windows".to_owned());
    }
    // Snapshot zero may be a restored checkpoint whose metrics predate this
    // disposable probe. The three post-exact endpoints are authoritative.
    let observed = &snapshots[1..];
    let reference = &observed[0].renewable_power;
    let offline_authority = !state
        .base_value()
        .get("timeWarp")
        .and_then(Value::as_object)
        .and_then(|time_warp| time_warp.get("enabled"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if (!offline_authority && !reference.time_warp_complete) || reference.grids.is_empty() {
        return Err("renewable power calibration is incomplete".to_owned());
    }
    for candidate in observed
        .iter()
        .skip(1)
        .map(|snapshot| &snapshot.renewable_power)
    {
        if (!offline_authority
            && (!candidate.time_warp_complete
                || candidate.controller_entity_id != reference.controller_entity_id
                || candidate.requested_multiplier != reference.requested_multiplier
                || candidate.effective_multiplier != reference.effective_multiplier
                || candidate.required_power_kw != reference.required_power_kw
                || candidate.allocated_power_kw != reference.allocated_power_kw))
            || candidate.grids.len() != reference.grids.len()
            || reference.grids.iter().any(|(key, grid)| {
                candidate
                    .grids
                    .get(key)
                    .is_none_or(|other| !stable_renewable_power_grid(grid, other))
            })
        {
            return Err(
                "per-grid renewable power demand or topology changed across calibration windows"
                    .to_owned(),
            );
        }
    }
    let current = capture_renewable_power_proof_snapshot(state)
        .map_err(|error| format!("current renewable power snapshot failed: {error:#}"))?;
    if !offline_authority
        && (!current.time_warp_complete
            || current.controller_entity_id != reference.controller_entity_id
            || current.requested_multiplier != reference.requested_multiplier
            || current.effective_multiplier != reference.effective_multiplier
            || current.required_power_kw != reference.required_power_kw
            || current.allocated_power_kw != reference.allocated_power_kw)
    {
        return Err("current renewable power identity diverged from calibration".to_owned());
    }
    let controller_grid = if offline_authority {
        PowerGridKey {
            planet_id: String::new(),
            grid_id: String::new(),
        }
    } else {
        controller_power_grid(state, &reference.controller_entity_id)?
    };
    let entities = entity_snapshot?;
    let lower_ray_by_grid = conservative_ray_generation_by_grid(state, entities)?;
    let mut grants = BTreeMap::new();
    for (key, grid) in &reference.grids {
        if !grid.complete {
            return Err(format!(
                "power grid {}.{} has an incomplete calibration metric",
                key.planet_id, key.grid_id
            ));
        }
        if grid.thermal_generation_kw.get() > EPSILON
            || grid.fusion_generation_kw.get() > EPSILON
            || grid.artificial_star_generation_kw.get() > EPSILON
            || grid.storage_discharge_kw.get() > EPSILON
            || grid.storage_charge_kw.get() > EPSILON
        {
            return Err(format!(
                "power grid {}.{} used finite generation or storage during calibration",
                key.planet_id, key.grid_id
            ));
        }
        let static_generation_floor_kw = [
            grid.wind_generation_kw.get(),
            grid.solar_generation_kw.get(),
            grid.geothermal_generation_kw.get(),
        ]
        .into_iter()
        .try_fold(0.0, |total, value| {
            conservative_power_floor(value).and_then(|value| {
                let next = total + value;
                next.is_finite()
                    .then_some(next)
                    .ok_or_else(|| "static renewable power lower bound overflowed".to_owned())
            })
        })?;
        let ray_generation_floor_kw =
            conservative_power_floor(lower_ray_by_grid.get(key).copied().unwrap_or(0.0))?;
        let demand_ceiling_kw = conservative_power_ceiling(
            grid.demand_kw.get(),
            grid.connected_entities == 0 && grid.disconnected_entities == 0,
        )?;
        let renewable_supply_kw = static_generation_floor_kw + ray_generation_floor_kw;
        if !renewable_supply_kw.is_finite() {
            return Err(format!(
                "power grid {}.{} renewable lower-bound supply overflowed",
                key.planet_id, key.grid_id
            ));
        }
        if renewable_supply_kw < demand_ceiling_kw {
            return Err(format!(
                "power grid {}.{} has only {:.3} kW renewable lower-bound supply for {:.3} kW demand",
                key.planet_id, key.grid_id, renewable_supply_kw, demand_ceiling_kw,
            ));
        }
        grants.insert(
            key.clone(),
            RenewablePowerGridGrant {
                demand_ceiling_kw: PowerProofScalar::from_f64(
                    demand_ceiling_kw,
                    "renewable demand ceiling",
                )
                .map_err(|error| error.to_string())?,
                static_generation_floor_kw: PowerProofScalar::from_f64(
                    static_generation_floor_kw,
                    "static renewable generation floor",
                )
                .map_err(|error| error.to_string())?,
                ray_generation_floor_kw: PowerProofScalar::from_f64(
                    ray_generation_floor_kw,
                    "ray generation floor",
                )
                .map_err(|error| error.to_string())?,
            },
        );
    }
    if !offline_authority && !grants.contains_key(&controller_grid) {
        return Err("time-warp controller grid has no renewable power grant".to_owned());
    }
    let dyson = capture_dyson_terminal(state.base_value())
        .map_err(|error| format!("Dyson power floor snapshot failed: {error:#}"))?;
    Ok(RenewablePowerTailCertificate {
        offline_authority,
        controller_entity_id: reference.controller_entity_id.clone(),
        controller_grid,
        requested_multiplier: reference.requested_multiplier,
        effective_multiplier: reference.effective_multiplier,
        required_power_kw: reference.required_power_kw,
        allocated_power_kw: reference.allocated_power_kw,
        grids: grants,
        structure_floor_by_system: dyson.structure_by_system,
        shell_floor_by_system: dyson.shell_by_system,
    })
}

#[cfg(test)]
fn build_renewable_power_tail_certificate_for_test(
    state: &CoreState,
    snapshots: &[SettlementProofSnapshot],
) -> Result<RenewablePowerTailCertificate, String> {
    let (entities, _) = state.parse_entities_with_runtime_diagnostics(deterministic_runtime());
    build_renewable_power_tail_certificate(
        state,
        snapshots,
        entities
            .as_deref()
            .map_err(|error| format!("ray-power entity snapshot failed: {error:#}")),
    )
}

fn validate_renewable_power_tail_certificate(
    state: &CoreState,
    certificate: &RenewablePowerTailCertificate,
) -> Result<(), String> {
    let current = capture_renewable_power_proof_snapshot(state)
        .map_err(|error| format!("current renewable power snapshot failed: {error:#}"))?;
    if certificate.offline_authority {
        let time_warp = state.base_value().get("timeWarp");
        if time_warp
            .and_then(Value::as_object)
            .and_then(|time_warp| time_warp.get("enabled"))
            .and_then(Value::as_bool)
            .unwrap_or(false)
            || number_at(time_warp, &["pendingSimulationSeconds"]).abs() > EPSILON
            || number_at(time_warp, &["pendingWallSeconds"]).abs() > EPSILON
        {
            return Err(
                "offline renewable power certificate crossed into time-warp authority".to_owned(),
            );
        }
    } else {
        if !current.time_warp_complete
            || current.controller_entity_id != certificate.controller_entity_id
            || current.requested_multiplier != certificate.requested_multiplier
            || current.effective_multiplier != certificate.effective_multiplier
            || current.required_power_kw != certificate.required_power_kw
            || current.allocated_power_kw != certificate.allocated_power_kw
            || controller_power_grid(state, &current.controller_entity_id)?
                != certificate.controller_grid
        {
            return Err(
                "renewable power certificate no longer matches time-warp authority".to_owned(),
            );
        }
        if !certificate.grids.contains_key(&certificate.controller_grid) {
            return Err("renewable power certificate lost its controller-grid grant".to_owned());
        }
    }
    for (key, grant) in &certificate.grids {
        let supply = grant.static_generation_floor_kw.get() + grant.ray_generation_floor_kw.get();
        if !supply.is_finite() || supply < grant.demand_ceiling_kw.get() {
            return Err(format!(
                "renewable power grant for {}.{} is no longer closed",
                key.planet_id, key.grid_id
            ));
        }
    }
    let dyson = capture_dyson_terminal(state.base_value())
        .map_err(|error| format!("current Dyson power floor snapshot failed: {error:#}"))?;
    for (system_id, floor) in &certificate.structure_floor_by_system {
        if dyson
            .structure_by_system
            .get(system_id)
            .copied()
            .unwrap_or(0)
            < *floor
        {
            return Err(format!(
                "Dyson structure power floor regressed for {system_id}"
            ));
        }
    }
    for (system_id, floor) in &certificate.shell_floor_by_system {
        if dyson.shell_by_system.get(system_id).copied().unwrap_or(0) < *floor {
            return Err(format!("Dyson shell power floor regressed for {system_id}"));
        }
    }
    Ok(())
}

fn construction_tail_requested(state: &CoreState) -> bool {
    let automation = state
        .base_value()
        .get("constructionAutomation")
        .and_then(Value::as_object);
    automation
        .and_then(|automation| automation.get("enabled"))
        .and_then(Value::as_bool)
        == Some(true)
        && !state
            .factory_topology
            .construction_center_indices
            .is_empty()
        && (collection_has_entries(automation.and_then(|value| value.get("jobs")))
            || collection_has_entries(automation.and_then(|value| value.get("targetStock")))
            || collection_has_entries(
                automation.and_then(|value| value.get("quantumMaterialBuffer")),
            ))
}

fn construction_center_identity(
    state: &CoreState,
    entity_index: usize,
) -> Result<(String, PowerGridKey), String> {
    let entity = state
        .parse_entity(entity_index)
        .map_err(|error| format!("construction center decode failed: {error:#}"))?;
    if entity.get("buildingId").and_then(Value::as_str) != Some("construction_center") {
        return Err("construction center topology points at another building".to_owned());
    }
    let entity_id = entity
        .get("id")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "construction center has no entity ID".to_owned())?
        .to_owned();
    let planet_id = entity
        .get("planetId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("construction center {entity_id} has no planet"))?
        .to_owned();
    let grid_id = entity
        .get("powerGridId")
        .and_then(Value::as_str)
        .unwrap_or("grid-a");
    if !matches!(grid_id, "grid-a" | "grid-b" | "grid-c") {
        return Err(format!(
            "construction center {entity_id} has an unknown power grid"
        ));
    }
    Ok((
        entity_id,
        PowerGridKey {
            planet_id,
            grid_id: grid_id.to_owned(),
        },
    ))
}

fn construction_quantum_fingerprint_counter(
    value: Option<&Value>,
    default: i128,
    label: &str,
) -> Result<i128, String> {
    let Some(value) = value else {
        return Ok(default);
    };
    let value = value
        .as_f64()
        .filter(|value| value.is_finite())
        .ok_or_else(|| format!("{label} is not finite"))?;
    let value = value.floor().max(0.0);
    if value > MAX_SAFE_INTEGER {
        return Err(format!("{label} exceeds the safe integer range"));
    }
    Ok(value as i128)
}

fn construction_quantum_fingerprint_integer(value: i128) -> Value {
    // Certificate identity is private to the native runtime. Encoding proof
    // counters as canonical decimal strings retains every safe-integer bit
    // and avoids an architecture-dependent i128 -> JSON-number conversion.
    Value::String(value.to_string())
}

/// Captures only the configuration that makes construction the exclusive
/// quantum download sink. Inventory is deliberately absent: ordinary macro
/// production may credit that inventory before construction spends it.
fn construction_quantum_macro_fingerprint_requested(state: &CoreState) -> bool {
    let base = state.base_value();
    let automation_enabled = base
        .get("constructionAutomation")
        .and_then(Value::as_object)
        .is_some_and(|automation| {
            automation.get("enabled").and_then(Value::as_bool) == Some(true)
                && automation
                    .get("quantumSourceEnabled")
                    .and_then(Value::as_bool)
                    == Some(true)
        });
    automation_enabled
        && base
            .get("quantumLogisticsNetwork")
            .and_then(Value::as_object)
            .and_then(|network| network.get("enabled"))
            .and_then(Value::as_bool)
            == Some(true)
}

fn construction_quantum_macro_fingerprint_from_entities(
    state: &CoreState,
    entities: &[Value],
) -> Result<Option<String>, String> {
    if !construction_quantum_macro_fingerprint_requested(state) {
        return Ok(None);
    }
    let base = state.base_value();
    let automation = base
        .get("constructionAutomation")
        .and_then(Value::as_object)
        .expect("requested construction quantum fingerprint has automation");
    let mut centers = Vec::<Value>::new();
    let mut quantum_towers = Vec::<Value>::new();
    for (entity_index, entity) in entities.iter().enumerate() {
        let entity = entity
            .as_object()
            .ok_or_else(|| format!("construction quantum entity {entity_index} is malformed"))?;
        if entity.get("buildingId").and_then(Value::as_str) == Some("construction_center") {
            let id = entity
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
                .ok_or_else(|| "construction quantum center has no ID".to_owned())?;
            let planet_id = entity
                .get("planetId")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
                .ok_or_else(|| format!("construction quantum center {id} has no planet"))?;
            let machine_count = construction_quantum_fingerprint_counter(
                entity.get("machineCount"),
                0,
                &format!("construction quantum center {id} machineCount"),
            )?;
            let priority = construction_quantum_fingerprint_counter(
                entity.get("powerPriority"),
                2,
                &format!("construction quantum center {id} powerPriority"),
            )?;
            centers.push(serde_json::json!({
                "id": id,
                "planetId": planet_id,
                "machineCount": construction_quantum_fingerprint_integer(machine_count),
                "gridId": entity
                    .get("powerGridId")
                    .and_then(Value::as_str)
                    .unwrap_or("grid-a"),
                "priority": construction_quantum_fingerprint_integer(priority),
            }));
        }
        if entity.get("kind").and_then(Value::as_str) != Some("station")
            || entity.get("buildingId").and_then(Value::as_str)
                != Some("interstellar_logistics_station")
            || entity.get("quantumMode").and_then(Value::as_str) != Some("quantum")
        {
            continue;
        }
        let id = entity
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .ok_or_else(|| "construction quantum tower has no ID".to_owned())?;
        let machine_count = construction_quantum_fingerprint_counter(
            entity.get("machineCount"),
            0,
            &format!("construction quantum tower {id} machineCount"),
        )?;
        let raw_slots = entity
            .get("stationSlots")
            .and_then(Value::as_array)
            .ok_or_else(|| format!("construction quantum tower {id} has no station slots"))?;
        let mut slots = Vec::new();
        for (slot_index, raw_slot) in raw_slots.iter().enumerate() {
            let slot = raw_slot.as_object().ok_or_else(|| {
                format!("construction quantum tower {id} slot {slot_index} is malformed")
            })?;
            let Some(item_id) = slot
                .get("itemId")
                .and_then(Value::as_str)
                .filter(|item_id| !item_id.is_empty())
            else {
                continue;
            };
            let remote_mode = slot
                .get("remoteMode")
                .and_then(Value::as_str)
                .unwrap_or("storage");
            if !matches!(remote_mode, "supply" | "demand" | "storage") {
                return Err(format!(
                    "construction quantum tower {id} slot {slot_index} has an invalid remote mode"
                ));
            }
            if remote_mode == "demand" {
                return Ok(None);
            }
            let priority = construction_quantum_fingerprint_counter(
                slot.get("priority"),
                1,
                &format!("construction quantum tower {id} slot {slot_index} priority"),
            )?;
            slots.push(serde_json::json!({
                "itemId": item_id,
                "remoteMode": remote_mode,
                "priority": construction_quantum_fingerprint_integer(priority),
            }));
        }
        quantum_towers.push(serde_json::json!({
            "id": id,
            "machineCount": construction_quantum_fingerprint_integer(machine_count),
            "slots": slots,
        }));
    }
    centers.sort_by(|left, right| {
        left.get("id")
            .and_then(Value::as_str)
            .cmp(&right.get("id").and_then(Value::as_str))
    });
    quantum_towers.sort_by(|left, right| {
        left.get("id")
            .and_then(Value::as_str)
            .cmp(&right.get("id").and_then(Value::as_str))
    });
    if centers.is_empty() || quantum_towers.is_empty() {
        return Ok(None);
    }

    let target_stock = automation
        .get("targetStock")
        .and_then(Value::as_object)
        .ok_or_else(|| "construction quantum targetStock is malformed".to_owned())?;
    let portable_fleet = base
        .get("portableFleet")
        .and_then(Value::as_object)
        .ok_or_else(|| "construction quantum portableFleet is malformed".to_owned())?;
    let construction = base
        .get("construction")
        .and_then(Value::as_object)
        .ok_or_else(|| "construction quantum construction inventory is malformed".to_owned())?;
    let mut normalized_targets = Vec::with_capacity(target_stock.len());
    let mut active_targets = Vec::new();
    for (target_id, raw_target) in target_stock {
        let target = proof_counter(
            Some(raw_target),
            &format!("constructionAutomation.targetStock.{target_id}"),
        )
        .map_err(|error| error.to_string())?;
        let current = if portable_fleet.contains_key(target_id) {
            proof_counter(
                portable_fleet.get(target_id),
                &format!("portableFleet.{target_id}"),
            )
        } else {
            proof_counter(
                construction.get(target_id),
                &format!("construction.{target_id}"),
            )
        }
        .map_err(|error| error.to_string())?;
        let normalized = Value::Array(vec![
            Value::String(target_id.clone()),
            construction_quantum_fingerprint_integer(target),
        ]);
        normalized_targets.push(normalized.clone());
        if target > current {
            active_targets.push(normalized);
        }
    }
    normalized_targets.sort_by(|left, right| left[0].as_str().cmp(&right[0].as_str()));
    active_targets.sort_by(|left, right| left[0].as_str().cmp(&right[0].as_str()));
    if active_targets.len() != 1 {
        return Ok(None);
    }
    let active_target_id = active_targets[0][0]
        .as_str()
        .expect("normalized construction target IDs are strings");
    if let Some(jobs) = automation.get("jobs") {
        let jobs = jobs
            .as_object()
            .ok_or_else(|| "construction quantum jobs are malformed".to_owned())?;
        for (job_id, job) in jobs {
            let job = job
                .as_object()
                .ok_or_else(|| format!("construction quantum job {job_id} is malformed"))?;
            if job.get("constructionId").and_then(Value::as_str) != Some(active_target_id) {
                return Ok(None);
            }
        }
    }
    let logistics_level = proof_counter(
        base.get("endgame")
            .and_then(Value::as_object)
            .and_then(|endgame| endgame.get("infiniteResearch"))
            .and_then(Value::as_object)
            .and_then(|research| research.get("galactic_logistics"))
            .and_then(Value::as_object)
            .and_then(|research| research.get("level")),
        "endgame.infiniteResearch.galactic_logistics.level",
    )
    .map_err(|error| error.to_string())?;
    serde_json::to_string(&serde_json::json!({
        "centers": centers,
        "activeTargets": active_targets,
        "quantumTowers": quantum_towers,
        "targetStock": normalized_targets,
        "galacticLogisticsLevel": construction_quantum_fingerprint_integer(logistics_level),
    }))
    .map(Some)
    .map_err(|error| format!("construction quantum fingerprint encode failed: {error}"))
}

fn build_construction_quantum_tail_grant_from_entities(
    state: &CoreState,
    entities: &[Value],
) -> Result<Option<ConstructionQuantumTailGrant>, String> {
    if !construction_quantum_macro_fingerprint_requested(state) {
        return Ok(None);
    }
    let Some(fingerprint) = construction_quantum_macro_fingerprint_from_entities(state, entities)?
    else {
        return Ok(None);
    };
    let Some(download_per_boundary) =
        crate::quantum_logistics::construction_macro_download_per_boundary(
            state.base_value(),
            entities,
        )
        .map_err(|error| format!("construction quantum grant calculation failed: {error:#}"))?
    else {
        return Ok(None);
    };
    Ok(Some(ConstructionQuantumTailGrant {
        fingerprint,
        download_per_boundary,
    }))
}

fn prepare_construction_tail_certificate_with_runtime(
    state: &CoreState,
    snapshots: &[SettlementProofSnapshot],
    runtime: &DeterministicRuntime,
) -> ConstructionCertificatePrepareOutcome {
    if !construction_tail_requested(state) {
        return ConstructionCertificatePrepareOutcome {
            result: Ok(None),
            entity_parse: None,
            wave: None,
        };
    }
    if collection_has_entries(state.base_value().get("handcraftQueue"))
        || collection_has_entries(state.base_value().get("constructionQueue"))
    {
        return ConstructionCertificatePrepareOutcome {
            result: Err(
                "construction automation cannot share a macro tail with handcraft or placement work"
                    .to_owned(),
            ),
            entity_parse: None,
            wave: None,
        };
    }
    // Parse the immutable entity directory exactly once on the injected
    // runtime before any heterogeneous certificate partition starts. The
    // resulting private Vec is shared read-only by renewable and quantum
    // preparation, so neither partition can recursively enter Rayon or fall
    // back to the process-global runtime.
    let entity_parse_started = std::time::Instant::now();
    let (entity_snapshot, entity_parse) = state.parse_entities_with_runtime_diagnostics(runtime);
    profile_certificate_entity_parse(
        "pure-idle-construction-certificate-entities",
        entity_parse,
        entity_parse_started.elapsed(),
    );
    let started = std::time::Instant::now();
    let ((renewable_power, center_identities, quantum, ()), wave) = runtime.partitioned_prepare4(
        0b0000_0111,
        pure_idle_certificate_prepare_work_items(state),
        || {
            build_renewable_power_tail_certificate(
                state,
                snapshots,
                entity_snapshot
                    .as_deref()
                    .map_err(|error| format!("ray-power entity snapshot failed: {error:#}")),
            )
        },
        || {
            state
                .factory_topology
                .construction_center_indices
                .iter()
                .copied()
                .map(|entity_index| construction_center_identity(state, entity_index))
                .collect::<Vec<_>>()
        },
        || {
            let entities = entity_snapshot.as_deref().map_err(|error| {
                format!("construction quantum grant entity snapshot failed: {error:#}")
            })?;
            build_construction_quantum_tail_grant_from_entities(state, entities)
        },
        || (),
    );
    profile_certificate_prepare(
        "pure-idle-construction-certificate-prepare",
        wave,
        started.elapsed(),
    );
    let result = (|| {
        // Every partition has joined. Preserve the historical failure order:
        // renewable proof, persisted center order, then quantum fingerprint
        // and bandwidth calculation.
        let renewable_power = renewable_power?;
        let center_identities = center_identities;
        let mut center_entity_ids = Vec::with_capacity(center_identities.len());
        for center_identity in center_identities {
            let (entity_id, grid) = center_identity?;
            if !renewable_power.grids.contains_key(&grid) {
                return Err(format!(
                    "construction center {entity_id} has no permanent renewable grid grant"
                ));
            }
            center_entity_ids.push(entity_id);
        }
        Ok(Some(ConstructionTailCertificate {
            renewable_power,
            center_entity_ids,
            quantum: quantum?,
        }))
    })();
    ConstructionCertificatePrepareOutcome {
        result,
        entity_parse: Some(entity_parse),
        wave: Some(wave),
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct ConstructionTailApplication {
    crafted: i128,
    carry_seconds: u8,
    quantum_replay_remaining_seconds: u8,
    quantum_downloaded: u64,
    quantum_pending_credits: MaterialTotals,
}

fn capture_construction_quantum_inventory(
    base: &Map<String, Value>,
) -> Result<MaterialTotals, String> {
    let inventory = base
        .get("quantumLogisticsNetwork")
        .and_then(Value::as_object)
        .and_then(|network| network.get("inventory"))
        .and_then(Value::as_object)
        .ok_or_else(|| "construction quantum inventory is malformed".to_owned())?;
    let mut totals = MaterialTotals::new();
    for (item_id, amount) in inventory {
        totals.insert(
            item_id.clone(),
            proof_counter(
                Some(amount),
                &format!("quantumLogisticsNetwork.inventory.{item_id}"),
            )
            .map_err(|error| error.to_string())?,
        );
    }
    Ok(totals)
}

fn merge_construction_quantum_pending_credits(
    pending: &mut MaterialTotals,
    before: &MaterialTotals,
    after: &MaterialTotals,
) -> Result<(), String> {
    for item_id in material_ids([before, after]) {
        let credited = after
            .get(&item_id)
            .copied()
            .unwrap_or(0)
            .checked_sub(before.get(&item_id).copied().unwrap_or(0))
            .ok_or_else(|| format!("construction quantum {item_id} credit delta overflowed"))?;
        if credited <= 0 {
            continue;
        }
        let accumulated = pending
            .get(&item_id)
            .copied()
            .unwrap_or(0)
            .checked_add(credited)
            .ok_or_else(|| format!("construction quantum {item_id} pending credit overflowed"))?;
        pending.insert(item_id, accumulated);
    }
    Ok(())
}

fn adjust_construction_quantum_pending_credits(
    base: &mut Map<String, Value>,
    pending: &MaterialTotals,
    restore: bool,
) -> Result<(), String> {
    if pending.is_empty() {
        return Ok(());
    }
    let inventory = base
        .get_mut("quantumLogisticsNetwork")
        .and_then(Value::as_object_mut)
        .and_then(|network| network.get_mut("inventory"))
        .and_then(Value::as_object_mut)
        .ok_or_else(|| "construction quantum inventory disappeared".to_owned())?;
    for (item_id, amount) in pending {
        let current = proof_counter(
            inventory.get(item_id),
            &format!("quantumLogisticsNetwork.inventory.{item_id}"),
        )
        .map_err(|error| error.to_string())?;
        let next = if restore {
            current
                .checked_add(*amount)
                .ok_or_else(|| format!("construction quantum {item_id} restore overflowed"))?
        } else {
            current.checked_sub(*amount).ok_or_else(|| {
                format!("construction quantum {item_id} holdback exceeds credited inventory")
            })?
        };
        if next < 0 {
            return Err(format!(
                "construction quantum {item_id} holdback underflowed inventory"
            ));
        }
        inventory.insert(item_id.clone(), Value::String(next.to_string()));
    }
    Ok(())
}

fn release_construction_quantum_pending_credits(
    base: &mut Map<String, Value>,
    pending: &mut MaterialTotals,
    units_per_second: &MaterialTotals,
    seconds: u8,
) -> Result<i128, String> {
    if pending.is_empty() || seconds == 0 {
        return Ok(0);
    }
    let inventory = base
        .get_mut("quantumLogisticsNetwork")
        .and_then(Value::as_object_mut)
        .and_then(|network| network.get_mut("inventory"))
        .and_then(Value::as_object_mut)
        .ok_or_else(|| "construction quantum inventory disappeared".to_owned())?;
    let mut released_total = 0_i128;
    let item_ids = pending.keys().cloned().collect::<Vec<_>>();
    for item_id in item_ids {
        let available = pending.get(&item_id).copied().unwrap_or(0);
        let rate = units_per_second.get(&item_id).copied().unwrap_or(0).max(0);
        let release =
            available.min(rate.checked_mul(i128::from(seconds)).ok_or_else(|| {
                format!("construction quantum {item_id} boundary credit overflowed")
            })?);
        if release <= 0 {
            continue;
        }
        let current = proof_counter(
            inventory.get(&item_id),
            &format!("quantumLogisticsNetwork.inventory.{item_id}"),
        )
        .map_err(|error| error.to_string())?;
        let next = current
            .checked_add(release)
            .ok_or_else(|| format!("construction quantum {item_id} release overflowed"))?;
        inventory.insert(item_id.clone(), Value::String(next.to_string()));
        if release == available {
            pending.remove(&item_id);
        } else {
            pending.insert(item_id, available - release);
        }
        released_total = released_total
            .checked_add(release)
            .ok_or_else(|| "construction quantum boundary release total overflowed".to_owned())?;
    }
    Ok(released_total)
}

fn run_construction_tail_segment(
    state: &CoreState,
    base: &mut Map<String, Value>,
    entities: &mut [Value],
    seconds: u8,
    power_factors: &HashMap<usize, f64>,
    runtime: &mut crate::construction::ConstructionRuntime,
) -> Result<(i128, usize), String> {
    if seconds == 0 {
        return Ok((0, 0));
    }
    let outcome = crate::construction::run_centers(
        state,
        base,
        entities,
        f64::from(seconds),
        power_factors,
        &state.factory_topology.construction_center_indices,
        runtime,
    )
    .map_err(|error| format!("construction-tail settlement failed: {error:#}"))?;
    Ok((outcome.receipt.crafted, outcome.scan.selected_rows))
}

struct ConstructionTailApplicationRequest<'a> {
    elapsed_before: f64,
    elapsed_after: f64,
    isolated_receipt_base_revision: u64,
    carry_seconds: u8,
    quantum_replay_remaining_seconds: u8,
    quantum_pending_credits: MaterialTotals,
    quantum_credit_rates: &'a MaterialTotals,
    allow_quantum_replay: bool,
}

fn apply_construction_tail_certificate(
    state: &mut CoreState,
    certificate: &ConstructionTailCertificate,
    request: ConstructionTailApplicationRequest<'_>,
    runtime: &DeterministicRuntime,
) -> Result<ConstructionTailApplication, String> {
    let ConstructionTailApplicationRequest {
        elapsed_before,
        elapsed_after,
        isolated_receipt_base_revision,
        carry_seconds,
        quantum_replay_remaining_seconds,
        mut quantum_pending_credits,
        quantum_credit_rates,
        allow_quantum_replay,
    } = request;
    validate_renewable_power_tail_certificate(state, &certificate.renewable_power)?;
    if quantum_replay_remaining_seconds > PURE_IDLE_MACRO_CONSTRUCTION_QUANTUM_REPLAY_SECONDS {
        return Err("construction-tail quantum replay cursor is invalid".to_owned());
    }
    if !construction_tail_requested(state) {
        return Ok(ConstructionTailApplication {
            quantum_replay_remaining_seconds,
            quantum_pending_credits,
            ..ConstructionTailApplication::default()
        });
    }
    let before_micros = elapsed_micros(elapsed_before)?;
    let after_micros = elapsed_micros(elapsed_after)?;
    if after_micros < before_micros {
        return Err("construction-tail clock regressed".to_owned());
    }
    if before_micros % MICROS_PER_SECOND != 0 || after_micros % MICROS_PER_SECOND != 0 {
        return Err(
            "construction-tail requires whole-second clock boundaries; fractional work remains exact-only"
                .to_owned(),
        );
    }
    let scheduled_seconds = after_micros
        .checked_sub(before_micros)
        .and_then(|duration| duration.checked_div(MICROS_PER_SECOND))
        .ok_or_else(|| "construction-tail schedule overflowed".to_owned())?;
    let block_seconds = i128::from(PURE_IDLE_MACRO_CONSTRUCTION_BLOCK_SECONDS);
    let total_pending_seconds = scheduled_seconds
        .checked_add(i128::from(carry_seconds))
        .ok_or_else(|| "construction-tail canonical block cursor overflowed".to_owned())?;
    let canonical_blocks = total_pending_seconds / block_seconds;
    let carry_seconds = u8::try_from(total_pending_seconds % block_seconds)
        .map_err(|_| "construction-tail canonical block cursor is invalid".to_owned())?;
    if canonical_blocks == 0 {
        return Ok(ConstructionTailApplication {
            crafted: 0,
            carry_seconds,
            quantum_replay_remaining_seconds,
            quantum_downloaded: 0,
            quantum_pending_credits,
        });
    }

    let mut current_ids =
        Vec::with_capacity(state.factory_topology.construction_center_indices.len());
    let mut power_factors = HashMap::<usize, f64>::new();
    for &entity_index in &state.factory_topology.construction_center_indices {
        let (entity_id, grid) = construction_center_identity(state, entity_index)?;
        if !certificate.renewable_power.grids.contains_key(&grid) {
            return Err(format!(
                "construction center {entity_id} left its certified renewable grid"
            ));
        }
        current_ids.push(entity_id);
        power_factors.insert(entity_index, 1.0);
    }
    if current_ids != certificate.center_entity_ids {
        return Err("construction center identity changed after calibration".to_owned());
    }

    let mut base = state.base_value().clone();
    let entity_parse_started = std::time::Instant::now();
    let (entities, entity_parse) = state.parse_entities_with_runtime_diagnostics(runtime);
    profile_certificate_entity_parse(
        "pure-idle-construction-tail-entities",
        entity_parse,
        entity_parse_started.elapsed(),
    );
    let mut entities =
        entities.map_err(|error| format!("construction-tail entity snapshot failed: {error:#}"))?;
    let active_quantum_grant = allow_quantum_replay
        .then_some(certificate.quantum.as_ref())
        .flatten();
    if let Some(grant) = active_quantum_grant {
        let current_fingerprint =
            construction_quantum_macro_fingerprint_from_entities(state, &entities)?
                .ok_or_else(|| "construction quantum grant is no longer eligible".to_owned())?;
        if current_fingerprint != grant.fingerprint {
            return Err("construction quantum grant identity changed after calibration".to_owned());
        }
        let current_download_per_boundary =
            crate::quantum_logistics::construction_macro_download_per_boundary(&base, &entities)
                .map_err(|error| {
                    format!("construction quantum grant validation failed: {error:#}")
                })?
                .ok_or_else(|| "construction quantum grant is no longer exclusive".to_owned())?;
        if current_download_per_boundary != grant.download_per_boundary {
            return Err("construction quantum bandwidth changed after calibration".to_owned());
        }
    } else if !quantum_pending_credits.is_empty() {
        return Err("construction quantum pending credits have no active grant".to_owned());
    }
    for (item_id, amount) in &quantum_pending_credits {
        if *amount <= 0 {
            return Err(format!(
                "construction quantum {item_id} pending credit is not positive"
            ));
        }
        let rate = quantum_credit_rates.get(item_id).copied().unwrap_or(0);
        if rate <= 0 {
            return Err(format!(
                "construction quantum {item_id} pending credit has no current ordinary release rate"
            ));
        }
    }
    adjust_construction_quantum_pending_credits(&mut base, &quantum_pending_credits, false)?;
    let mut runtime = state.prepared_construction_runtime().unwrap_or_else(|| {
        Arc::new(crate::construction::ConstructionRuntime::build(
            state, &base, &entities,
        ))
    });
    Arc::make_mut(&mut runtime)
        .record_isolated_noop_receipts(isolated_receipt_base_revision, state.revision)
        .map_err(|error| format!("construction-tail isolated receipt bridge failed: {error:#}"))?;
    // Construction centers share target cursors, per-planet material and a
    // guarded fair-work budget. Feeding an arbitrary request-sized duration to
    // `run_centers` makes target ownership depend on how the caller sliced the
    // same interval. Execute only fixed 30-second canonical blocks and retain
    // the sub-block remainder in the private checkpoint. Thus F^(a+b) observes
    // exactly the same block sequence as F^a followed by F^b, while long
    // offline windows need 1/30th as many engine invocations as a literal
    // per-second oracle. The one bounded quantum replay is split at exact
    // absolute five-second boundaries; pending ordinary credit is revealed at
    // its certified per-second rate and each real delivery explicitly wakes
    // the active directory. After that replay, an empty active directory has
    // no remaining production, delivery or power event that could wake it.
    let after_whole_seconds = after_micros / MICROS_PER_SECOND;
    let block_end_seconds = after_whole_seconds
        .checked_sub(i128::from(carry_seconds))
        .ok_or_else(|| "construction-tail canonical block endpoint underflowed".to_owned())?;
    let block_span_seconds = canonical_blocks
        .checked_mul(block_seconds)
        .ok_or_else(|| "construction-tail canonical block span overflowed".to_owned())?;
    let mut block_start_seconds = block_end_seconds
        .checked_sub(block_span_seconds)
        .ok_or_else(|| "construction-tail canonical block start underflowed".to_owned())?;
    if block_start_seconds < 0 {
        return Err("construction-tail canonical block starts before zero".to_owned());
    }

    let mut crafted = 0_i128;
    let mut quantum_downloaded = 0_u64;
    let mut quantum_replay_remaining_seconds = quantum_replay_remaining_seconds;
    let mut quantum_replay_attempted = false;
    let mut remaining_blocks = canonical_blocks;
    while remaining_blocks > 0 {
        let mut selected_rows = 0_usize;
        let mut block_quantum_downloaded = 0_u64;
        let replay_seconds = if active_quantum_grant.is_some() {
            quantum_replay_remaining_seconds.min(PURE_IDLE_MACRO_CONSTRUCTION_BLOCK_SECONDS)
        } else {
            0
        };
        if replay_seconds > 0 {
            quantum_replay_attempted = true;
            let replay_end_seconds = block_start_seconds
                .checked_add(i128::from(replay_seconds))
                .ok_or_else(|| "construction quantum replay endpoint overflowed".to_owned())?;
            let mut cursor_seconds = block_start_seconds;
            while cursor_seconds < replay_end_seconds {
                let next_boundary_seconds = cursor_seconds
                    .checked_div(5)
                    .and_then(|bucket| bucket.checked_add(1))
                    .and_then(|bucket| bucket.checked_mul(5))
                    .ok_or_else(|| "construction quantum boundary overflowed".to_owned())?;
                let work_end_seconds = replay_end_seconds.min(next_boundary_seconds);
                let work_seconds = u8::try_from(work_end_seconds - cursor_seconds)
                    .map_err(|_| "construction quantum replay segment is invalid".to_owned())?;
                let (segment_crafted, segment_selected_rows) = run_construction_tail_segment(
                    state,
                    &mut base,
                    &mut entities,
                    work_seconds,
                    &power_factors,
                    Arc::make_mut(&mut runtime),
                )?;
                crafted = crafted
                    .checked_add(segment_crafted)
                    .ok_or_else(|| "construction-tail crafted receipt overflowed".to_owned())?;
                selected_rows = selected_rows
                    .checked_add(segment_selected_rows)
                    .ok_or_else(|| "construction-tail selected row count overflowed".to_owned())?;
                cursor_seconds = work_end_seconds;
                if cursor_seconds != next_boundary_seconds {
                    continue;
                }
                release_construction_quantum_pending_credits(
                    &mut base,
                    &mut quantum_pending_credits,
                    quantum_credit_rates,
                    work_seconds,
                )?;
                let boundary_second = if cursor_seconds <= MAX_SAFE_INTEGER as i128 {
                    cursor_seconds as f64
                } else {
                    return Err(
                        "construction quantum boundary exceeds the safe timeline range".to_owned(),
                    );
                };
                let downloaded =
                    crate::quantum_logistics::settle_construction_macro_download_boundary(
                        state,
                        &mut base,
                        &mut entities,
                        boundary_second,
                        active_quantum_grant
                            .expect("replay requires a construction quantum grant")
                            .download_per_boundary,
                    )
                    .map_err(|error| {
                        format!("construction quantum boundary settlement failed: {error:#}")
                    })?;
                quantum_downloaded = quantum_downloaded
                    .checked_add(downloaded)
                    .ok_or_else(|| "construction quantum download receipt overflowed".to_owned())?;
                block_quantum_downloaded = block_quantum_downloaded
                    .checked_add(downloaded)
                    .ok_or_else(|| "construction quantum block receipt overflowed".to_owned())?;
                if downloaded > 0 {
                    // A direct quantum-buffer credit is a real wake event.
                    // Preserve the private exact/isolated receipt history and
                    // wake the compact directory in place instead of
                    // rebuilding it and breaking the revision proof chain.
                    Arc::make_mut(&mut runtime).wake_all();
                }
            }
            quantum_replay_remaining_seconds -= replay_seconds;
        }
        let trailing_seconds = PURE_IDLE_MACRO_CONSTRUCTION_BLOCK_SECONDS - replay_seconds;
        let (segment_crafted, segment_selected_rows) = run_construction_tail_segment(
            state,
            &mut base,
            &mut entities,
            trailing_seconds,
            &power_factors,
            Arc::make_mut(&mut runtime),
        )?;
        crafted = crafted
            .checked_add(segment_crafted)
            .ok_or_else(|| "construction-tail crafted receipt overflowed".to_owned())?;
        selected_rows = selected_rows
            .checked_add(segment_selected_rows)
            .ok_or_else(|| "construction-tail selected row count overflowed".to_owned())?;
        remaining_blocks -= 1;
        block_start_seconds = block_start_seconds
            .checked_add(block_seconds)
            .ok_or_else(|| "construction-tail canonical block cursor overflowed".to_owned())?;
        if selected_rows == 0
            && block_quantum_downloaded == 0
            && (active_quantum_grant.is_none() || quantum_replay_remaining_seconds == 0)
        {
            break;
        }
    }

    // Bucket-average diagnostics are not gameplay authority and vary with the
    // caller's segmentation. Preserve work progress, but keep these two
    // presentation fields out of the canonical split boundary just like the
    // JavaScript construction-only macro.
    for &entity_index in &state.factory_topology.construction_center_indices {
        let center = entities
            .get_mut(entity_index)
            .and_then(Value::as_object_mut)
            .ok_or_else(|| "construction center disappeared before commit".to_owned())?;
        center.insert("utilization".to_owned(), Value::from(0));
        center.insert("productionRate".to_owned(), Value::from(0));
    }
    adjust_construction_quantum_pending_credits(&mut base, &quantum_pending_credits, true)?;
    quantum_pending_credits.clear();

    let next_revision = state
        .revision
        .checked_add(1)
        .ok_or_else(|| "construction-tail revision exhausted".to_owned())?;
    let belt_commit = crate::belts::BeltCommitBatch::unchanged(state)
        .map_err(|error| format!("construction-tail belt seal failed: {error:#}"))?;
    state
        .commit_simulated_state(base, entities, belt_commit, next_revision, false)
        .map_err(|error| format!("construction-tail commit failed: {error:#}"))?;
    state.invalidate_prepared_planet_metrics_runtime();
    if quantum_replay_attempted {
        state.invalidate_prepared_quantum_logistics_directory();
    }
    state.install_prepared_construction_runtime(runtime);
    Ok(ConstructionTailApplication {
        crafted,
        carry_seconds,
        quantum_replay_remaining_seconds,
        quantum_downloaded,
        quantum_pending_credits,
    })
}

fn source_has_unbounded_vein(state: &CoreState, item_id: &str) -> Result<bool, String> {
    for &entity_index in &state.factory_topology.vein_indices {
        let entity = state
            .parse_entity(entity_index)
            .map_err(|error| format!("vein decode failed: {error:#}"))?;
        if number_at(Some(&entity), &["minerCount"]) <= EPSILON
            || entity.get("resourceId").and_then(Value::as_str) != Some(item_id)
        {
            continue;
        }
        if finite_vein_snapshot_at(state, entity_index)
            .map_err(|error| format!("finite vein proof failed: {error:#}"))?
            .is_none()
        {
            return Ok(true);
        }
    }
    Ok(false)
}

fn build_finite_vein_certificates(
    state: &CoreState,
    snapshots: &[SettlementProofSnapshot],
    sources: &BTreeSet<String>,
) -> Result<Vec<FiniteVeinCertificate>, String> {
    let current = capture_finite_veins(state)
        .map_err(|error| format!("current finite vein state is invalid: {error:#}"))?;
    if current != snapshots[0].finite_veins && current != snapshots[3].finite_veins {
        return Err("current finite vein state is not a calibration endpoint".to_owned());
    }
    let mut certificates = Vec::new();
    for (entity_id, expected) in current {
        if expected.miner_count <= 0 || !sources.contains(&expected.resource_id) {
            continue;
        }
        let mut deltas = Vec::with_capacity(3);
        for window in snapshots.windows(2) {
            let before = window[0]
                .finite_veins
                .get(&entity_id)
                .ok_or_else(|| format!("finite vein {entity_id} is missing before a window"))?;
            let after = window[1]
                .finite_veins
                .get(&entity_id)
                .ok_or_else(|| format!("finite vein {entity_id} is missing after a window"))?;
            deltas.push(finite_vein_extracted_units(before, after)?);
        }
        let rate = stable_window_rate(&deltas, &format!("finite vein {entity_id} extraction"))?;
        if rate > 0 {
            certificates.push(FiniteVeinCertificate {
                units_per_second: rate,
                expected,
            });
        }
    }
    Ok(certificates)
}

fn validate_finite_source_rates(
    state: &CoreState,
    sources: &BTreeSet<String>,
    produced_units_per_second: &MaterialTotals,
    finite_veins: &[FiniteVeinCertificate],
) -> Result<(), String> {
    let mut finite_rates = MaterialTotals::new();
    for certificate in finite_veins {
        let current = finite_rates
            .get(&certificate.expected.resource_id)
            .copied()
            .unwrap_or(0);
        finite_rates.insert(
            certificate.expected.resource_id.clone(),
            current
                .checked_add(certificate.units_per_second)
                .ok_or_else(|| {
                    format!(
                        "{} finite source rate overflowed",
                        certificate.expected.resource_id
                    )
                })?,
        );
    }
    for item_id in sources {
        let produced = produced_units_per_second.get(item_id).copied().unwrap_or(0);
        let finite = finite_rates.get(item_id).copied().unwrap_or(0);
        let has_unbounded = source_has_unbounded_vein(state, item_id)?;
        if finite > produced || !has_unbounded && finite != produced {
            return Err(format!(
                "{item_id} source production {produced}/s does not close against finite reserve debit {finite}/s{}",
                if has_unbounded {
                    " plus the certified unbounded vein remainder"
                } else {
                    ""
                }
            ));
        }
    }
    Ok(())
}

fn collection_has_entries(value: Option<&Value>) -> bool {
    value.is_some_and(|value| match value {
        Value::Array(values) => !values.is_empty(),
        Value::Object(values) => !values.is_empty(),
        _ => false,
    })
}

fn active_recipe_tail_exclusion_reason(
    state: &CoreState,
    allow_certified_galactic_export: bool,
    allow_certified_orbital_contracts: bool,
) -> Option<String> {
    let base = state.base_value();
    let endgame = base.get("endgame").and_then(Value::as_object);
    if collection_has_entries(base.get("handcraftQueue"))
        || collection_has_entries(base.get("constructionQueue"))
    {
        return Some("handcraft or construction work is active".to_owned());
    }
    if !allow_certified_galactic_export {
        let input_mode = endgame
            .and_then(|endgame| endgame.get("exportInputMode"))
            .and_then(Value::as_str);
        let enabled_project = endgame
            .and_then(|endgame| endgame.get("exportProjects"))
            .and_then(Value::as_object)
            .is_some_and(|projects| {
                projects.values().any(|project| {
                    project
                        .get("enabled")
                        .and_then(Value::as_bool)
                        .unwrap_or(false)
                })
            });
        let legacy_dispatch_can_consume = input_mode == Some("legacy-network")
            && enabled_project
            && endgame
                .and_then(|endgame| endgame.get("autoDispatch"))
                .and_then(Value::as_bool)
                == Some(true);
        let activity_can_consume = input_mode == Some("building")
            && endgame
                .and_then(|endgame| endgame.get("constructionActivity"))
                .and_then(Value::as_object)
                .is_some_and(|activity| {
                    let counter = |key: &str| {
                        activity
                            .get(key)
                            .and_then(Value::as_f64)
                            .filter(|value| value.is_finite())
                            .unwrap_or(0.0)
                    };
                    activity
                        .get("activityId")
                        .and_then(Value::as_str)
                        .is_some_and(|id| !id.is_empty())
                        && counter("activityClockMs") < counter("endsAtMs")
                });
        if legacy_dispatch_can_consume || activity_can_consume {
            return Some("galactic export can consume material".to_owned());
        }
    }
    if !allow_certified_orbital_contracts
        && base
            .get("orbitalStation")
            .and_then(Value::as_object)
            .and_then(|station| station.get("contractBoard"))
            .and_then(Value::as_object)
            .and_then(|board| board.get("accepted"))
            .and_then(Value::as_array)
            .is_some_and(|accepted| {
                accepted.iter().any(|contract| {
                    contract.get("status").and_then(Value::as_str) == Some("accepted")
                })
            })
    {
        return Some("orbital station contract delivery is active".to_owned());
    }
    None
}

fn active_ordinary_recipe_ids(
    state: &CoreState,
    allow_certified_rocket_terminal: bool,
    allow_certified_sail_terminal: bool,
    allow_certified_ray_power_terminal: bool,
    allow_certified_galactic_export: bool,
    allow_certified_orbital_contracts: bool,
) -> Result<Vec<String>, String> {
    if let Some(reason) = active_recipe_tail_exclusion_reason(
        state,
        allow_certified_galactic_export,
        allow_certified_orbital_contracts,
    ) {
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
        if is_ordinary_quantum_upload_endpoint(state, &entity) {
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
        if recipe_id == "ray_power" {
            if allow_certified_ray_power_terminal {
                // Ray receivers are an energy terminal, not a material recipe.
                // They may be absent from the ordinary material DAG only when
                // the per-grid renewable certificate has independently closed
                // their permanent generation floor and the powered demand.
                if entity
                    .get("inputs")
                    .and_then(Value::as_object)
                    .is_some_and(|inputs| !inputs.is_empty())
                    || !entity_output_ids.is_empty()
                {
                    return Err("active ray_power declares material slots".to_owned());
                }
                continue;
            }
            return Err("active ray_power has no certified renewable power floor".to_owned());
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
    certified_physical_terminal_consumed: &MaterialTotals,
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
        certified_physical_terminal_consumed,
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
        let certified_terminal_consumed = certified_physical_terminal_consumed
            .get(&item_id)
            .copied()
            .unwrap_or(0);
        if terminal_consumed != certified_terminal_consumed {
            return Err(format!(
                "{item_id} terminal consumption {terminal_consumed} does not match certified physical delivery {certified_terminal_consumed}"
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
        // `produced - net owned` is the total item sink: ordinary recipe use
        // plus the certified physical terminal exactly once. The certificate
        // builder independently reconstructs those components and compares
        // their sum with this observed total, so mirrors/outboxes cannot be
        // charged twice and an unmodelled sink cannot hide inside the delta.
        let ordinary_consumed = produced
            .checked_sub(net_owned)
            .ok_or_else(|| format!("{item_id} ordinary consumption overflowed"))?;
        if ordinary_consumed < 0 {
            return Err(format!(
                "{item_id} owned growth {net_owned} exceeds production {produced}"
            ));
        }
        if ordinary_consumed < certified_terminal_consumed {
            return Err(format!(
                "{item_id} total consumption {ordinary_consumed} is below certified physical terminal consumption {certified_terminal_consumed}"
            ));
        }
        let internal_consumed = ordinary_consumed - certified_terminal_consumed;
        let window_seconds = MACRO_V10_CALIBRATION_WINDOW_SECONDS as i128;
        for (label, value) in [
            ("produced", produced),
            ("consumed", ordinary_consumed),
            ("internalConsumed", internal_consumed),
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

fn stable_window_material_rates(
    windows: &[MaterialTotals],
    label: &str,
) -> Result<MaterialTotals, String> {
    if windows.len() != 3 {
        return Err(format!(
            "{label} requires three calibration windows, observed {}",
            windows.len()
        ));
    }
    let mut rates = MaterialTotals::new();
    for item_id in material_ids(windows.iter()) {
        let deltas = windows
            .iter()
            .map(|window| window.get(&item_id).copied().unwrap_or(0))
            .collect::<Vec<_>>();
        let rate = stable_window_rate(&deltas, &format!("{label} {item_id}"))?;
        if rate > 0 {
            rates.insert(item_id, rate);
        }
    }
    Ok(rates)
}

fn biguint_material_totals(
    values: &BTreeMap<String, BigUint>,
    label: &str,
) -> Result<MaterialTotals, String> {
    values
        .iter()
        .map(|(item_id, amount)| {
            amount
                .to_i128()
                .filter(|amount| *amount <= MAX_SAFE_INTEGER as i128)
                .map(|amount| (item_id.clone(), amount))
                .ok_or_else(|| format!("{label} {item_id} exceeds the proof ledger"))
        })
        .collect()
}

fn build_galactic_export_sink_certificate(
    state: &CoreState,
    snapshots: &[SettlementProofSnapshot],
) -> Result<Option<GalacticExportSinkCertificate>, String> {
    let endpoints = snapshots
        .iter()
        .map(|snapshot| snapshot.galactic_export.as_ref())
        .collect::<Option<Vec<_>>>();
    let Some(endpoints) = endpoints else {
        if snapshots
            .iter()
            .all(|snapshot| snapshot.galactic_export.is_none())
        {
            return Ok(None);
        }
        return Err(
            "Galactic export endpoint was malformed or disappeared during calibration".to_owned(),
        );
    };
    let mut windows = Vec::with_capacity(3);
    for pair in endpoints.windows(2) {
        let delta =
            crate::galactic_exports::delta_certified_pure_idle_export_endpoints(pair[0], pair[1])
                .map_err(|error| format!("Galactic export calibration rejected: {error:#}"))?;
        if delta.pending_activity_batches_are_owned_inventory {
            return Err("Galactic activity outbox was misclassified as owned inventory".to_owned());
        }
        if delta
            .level_boundaries
            .values()
            .any(|boundary| boundary.level_before != boundary.level_after)
        {
            return Err(
                "Galactic export crossed a level/reward boundary during calibration".to_owned(),
            );
        }
        windows.push(delta.physical_consumed_by_item);
    }
    let consumed_units_per_second = stable_window_material_rates(&windows, "Galactic export")?;
    if consumed_units_per_second.is_empty() {
        return Ok(None);
    }
    let current =
        crate::galactic_exports::capture_certified_pure_idle_export_endpoint(state.base_value())
            .map_err(|error| format!("current Galactic export endpoint is invalid: {error:#}"))?;
    if current != *endpoints[0]
        && current
            != **endpoints
                .last()
                .expect("four terminal snapshots own a final endpoint")
    {
        return Err(
            "Galactic export endpoint is neither the probe start nor committed endpoint".to_owned(),
        );
    }
    let expected = current;
    if expected.input_mode != crate::galactic_exports::CertifiedPureIdleExportInputMode::Building
        || expected.auto_dispatch
        || expected.activity.phase
            != crate::galactic_exports::CertifiedPureIdleExportActivityPhase::Active
    {
        return Err("Galactic export is not an activity-bounded building terminal".to_owned());
    }
    Ok(Some(GalacticExportSinkCertificate {
        consumed_units_per_second,
        expected,
    }))
}

fn build_orbital_contract_sink_certificate(
    state: &CoreState,
    snapshots: &[SettlementProofSnapshot],
) -> Result<Option<OrbitalContractSinkCertificate>, String> {
    let endpoints = snapshots
        .iter()
        .map(|snapshot| snapshot.orbital_contracts.as_ref())
        .collect::<Option<Vec<_>>>();
    let Some(endpoints) = endpoints else {
        if snapshots
            .iter()
            .all(|snapshot| snapshot.orbital_contracts.is_none())
        {
            return Ok(None);
        }
        return Err(
            "orbital contract endpoint was malformed or disappeared during calibration".to_owned(),
        );
    };
    let mut receipts = Vec::with_capacity(3);
    for pair in endpoints.windows(2) {
        let receipt =
            crate::orbital_station::pure_idle_contract_consumption_between(pair[0], pair[1])
                .map_err(|error| format!("orbital contract calibration rejected: {error:#}"))?;
        if !receipt.claimable_contract_ids.is_empty() {
            return Err(
                "orbital contract crossed a claimable/reward boundary during calibration"
                    .to_owned(),
            );
        }
        receipts.push(receipt);
    }
    let first_rows = receipts
        .first()
        .map(|receipt| receipt.requirement_deltas.as_slice())
        .ok_or_else(|| "orbital contract produced no interval receipts".to_owned())?;
    if receipts
        .iter()
        .any(|receipt| receipt.requirement_deltas.len() != first_rows.len())
    {
        return Err("orbital contract requirement shape changed between windows".to_owned());
    }
    let mut consumed_units_per_second = MaterialTotals::new();
    let mut requirement_rates = Vec::new();
    for (row_index, first) in first_rows.iter().enumerate() {
        let rows = receipts
            .iter()
            .map(|receipt| &receipt.requirement_deltas[row_index])
            .collect::<Vec<_>>();
        if rows.iter().any(|row| {
            row.contract_index != first.contract_index
                || row.contract_id != first.contract_id
                || row.requirement_index != first.requirement_index
                || row.item_id != first.item_id
        }) {
            return Err(format!(
                "orbital contract requirement row {row_index} changed identity between windows"
            ));
        }
        let deltas = rows
            .iter()
            .map(|row| {
                row.delivered.to_i128().ok_or_else(|| {
                    format!(
                        "orbital contract requirement {}/{} exceeds the proof ledger",
                        row.contract_id, row.requirement_index
                    )
                })
            })
            .collect::<Result<Vec<_>, _>>()?;
        let rate = stable_window_rate(
            &deltas,
            &format!(
                "orbital contract requirement {}/{}",
                first.contract_id, first.requirement_index
            ),
        )?;
        if rate > 0 {
            let current = consumed_units_per_second
                .get(&first.item_id)
                .copied()
                .unwrap_or(0);
            consumed_units_per_second.insert(
                first.item_id.clone(),
                current
                    .checked_add(rate)
                    .ok_or_else(|| format!("orbital contract {} rate overflowed", first.item_id))?,
            );
            requirement_rates.push(OrbitalContractRequirementRate {
                contract_index: first.contract_index,
                contract_id: first.contract_id.clone(),
                requirement_index: first.requirement_index,
                item_id: first.item_id.clone(),
                units_per_second: rate,
            });
        }
    }
    let aggregate_windows = receipts
        .iter()
        .map(|receipt| {
            biguint_material_totals(
                &receipt.consumed_by_item,
                "orbital contract aggregate consumption",
            )
        })
        .collect::<Result<Vec<_>, _>>()?;
    if stable_window_material_rates(&aggregate_windows, "orbital contract aggregate")?
        != consumed_units_per_second
    {
        return Err("orbital contract requirement and aggregate rates disagree".to_owned());
    }
    if consumed_units_per_second.is_empty() {
        return Ok(None);
    }
    let current = crate::orbital_station::capture_pure_idle_contract_endpoint(state)
        .map_err(|error| format!("current orbital contract endpoint is invalid: {error:#}"))?;
    if current != *endpoints[0]
        && current
            != **endpoints
                .last()
                .expect("four terminal snapshots own a final endpoint")
    {
        return Err(
            "orbital contract endpoint is neither the probe start nor committed endpoint"
                .to_owned(),
        );
    }
    let expected = current;
    let (one_second_budget, one_second_steps) =
        orbital_contract_schedule(&expected, &requirement_rates, 1)?;
    let plan = crate::orbital_station::plan_certified_pure_idle_contract_delivery_steps(
        &expected,
        &one_second_budget,
        &one_second_steps,
    )
    .map_err(|error| format!("orbital contract terminal is not certifiable: {error:#}"))?;
    if plan.planned_consumed_by_item != one_second_budget {
        return Err(
            "orbital contract has less than one whole certified second before its boundary"
                .to_owned(),
        );
    }
    Ok(Some(OrbitalContractSinkCertificate {
        consumed_units_per_second,
        requirement_rates,
        expected,
    }))
}

fn orbital_contract_schedule(
    endpoint: &crate::orbital_station::PureIdleContractEndpoint,
    rates: &[OrbitalContractRequirementRate],
    seconds: i128,
) -> Result<
    (
        BTreeMap<String, BigUint>,
        Vec<crate::orbital_station::PureIdleContractDeliveryStep>,
    ),
    String,
> {
    if seconds < 0 {
        return Err("orbital contract schedule regressed".to_owned());
    }
    let mut budget = BTreeMap::<String, BigUint>::new();
    let mut steps = Vec::new();
    for rate in rates {
        if rate.units_per_second <= 0 {
            return Err(format!(
                "orbital contract {}/{} has a non-positive rate",
                rate.contract_id, rate.requirement_index
            ));
        }
        let contract = endpoint
            .accepted
            .get(rate.contract_index)
            .filter(|contract| contract.config.id == rate.contract_id)
            .ok_or_else(|| {
                format!(
                    "orbital contract target {} disappeared from persisted index {}",
                    rate.contract_id, rate.contract_index
                )
            })?;
        let requirement = contract
            .requirements
            .get(rate.requirement_index)
            .filter(|requirement| requirement.config.item_id == rate.item_id)
            .ok_or_else(|| {
                format!(
                    "orbital contract target {}/{} changed item identity",
                    rate.contract_id, rate.requirement_index
                )
            })?;
        let amount = rate
            .units_per_second
            .checked_mul(seconds)
            .ok_or_else(|| "orbital contract schedule overflowed".to_owned())?;
        if amount == 0 {
            continue;
        }
        let amount = BigUint::from(amount as u128);
        *budget.entry(rate.item_id.clone()).or_default() += &amount;
        steps.push(crate::orbital_station::PureIdleContractDeliveryStep {
            contract_index: rate.contract_index,
            contract_id: rate.contract_id.clone(),
            requirement_index: rate.requirement_index,
            item_id: rate.item_id.clone(),
            expected_delivered: requirement.delivered.clone(),
            amount,
        });
    }
    Ok((budget, steps))
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
    finite_veins: Vec<FiniteVeinCertificate>,
    terminals: OrdinaryTerminalCertificates,
) -> Result<OrdinaryFlowCertificate, String> {
    let OrdinaryTerminalCertificates {
        research,
        dyson_rocket,
        dyson_sail,
        galactic_export,
        orbital_contracts,
        renewable_power,
    } = terminals;
    let recipe_ids = active_ordinary_recipe_ids(
        state,
        dyson_rocket.is_some(),
        dyson_sail.is_some(),
        renewable_power.is_some(),
        galactic_export.is_some(),
        orbital_contracts.is_some(),
    )?;
    if recipe_ids.is_empty()
        && research.is_none()
        && dyson_rocket.is_none()
        && dyson_sail.is_none()
        && galactic_export.is_none()
        && orbital_contracts.is_none()
    {
        return Err(
            "no active ordinary recipe, research, Dyson, export or contract sink is available"
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
                    "recipe {recipe_id} output {item_id} overlaps a certified vein source"
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
                    "recipe {} input {item_id} has no certified vein source or active producer",
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
    // v15 keeps terminal routing deliberately unambiguous. A material may
    // feed ordinary recipe inputs and one terminal, but it may not be split
    // between two independently stateful terminals until a persisted,
    // deterministic per-sink allocator exists.
    let mut terminal_owner = BTreeMap::<String, &'static str>::new();
    let mut claim_terminal_items =
        |owner: &'static str, rates: &MaterialTotals| -> Result<(), String> {
            for item_id in rates.keys() {
                if let Some(previous) = terminal_owner.insert(item_id.clone(), owner) {
                    return Err(format!(
                        "terminal material {item_id} is shared by {previous} and {owner}"
                    ));
                }
            }
            Ok(())
        };
    if let Some(research) = &research {
        claim_terminal_items("research", &research.consumed_units_per_second)?;
    }
    if let Some(rocket) = &dyson_rocket {
        claim_terminal_items(
            "Dyson rocket",
            &MaterialTotals::from([(
                TERMINAL_ROCKET_ITEM_ID.to_owned(),
                rocket.launches_per_second,
            )]),
        )?;
    }
    if let Some(sail) = &dyson_sail {
        claim_terminal_items(
            "Dyson sail",
            &MaterialTotals::from([(TERMINAL_SAIL_ITEM_ID.to_owned(), sail.launches_per_second)]),
        )?;
    }
    if let Some(export) = &galactic_export {
        claim_terminal_items("Galactic export", &export.consumed_units_per_second)?;
    }
    if let Some(contracts) = &orbital_contracts {
        claim_terminal_items("orbital contract", &contracts.consumed_units_per_second)?;
    }
    if let Some(research) = &research {
        for item_id in research.consumed_units_per_second.keys() {
            if !sources.contains(item_id) && !output_producer.contains_key(item_id) {
                return Err(format!(
                    "research input {item_id} has no certified vein source or active producer"
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
    for (terminal, label) in [
        (
            galactic_export
                .as_ref()
                .map(|terminal| &terminal.consumed_units_per_second),
            "Galactic export",
        ),
        (
            orbital_contracts
                .as_ref()
                .map(|terminal| &terminal.consumed_units_per_second),
            "orbital contract",
        ),
    ] {
        let Some(terminal) = terminal else {
            continue;
        };
        for (item_id, rate) in terminal {
            if *rate <= 0 {
                return Err(format!("{label} {item_id} has a non-positive rate"));
            }
            if !sources.contains(item_id) && !output_producer.contains_key(item_id) {
                return Err(format!(
                    "{label} input {item_id} has no certified vein source or active producer"
                ));
            }
            allowed_consumption.insert(item_id.clone());
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
    for (terminal, label) in [
        (
            galactic_export
                .as_ref()
                .map(|terminal| &terminal.consumed_units_per_second),
            "Galactic export",
        ),
        (
            orbital_contracts
                .as_ref()
                .map(|terminal| &terminal.consumed_units_per_second),
            "orbital contract",
        ),
    ] {
        let Some(terminal) = terminal else {
            continue;
        };
        for (item_id, rate) in terminal {
            let current = expected_consumption.get(item_id).copied().unwrap_or(0);
            expected_consumption.insert(
                item_id.clone(),
                current
                    .checked_add(*rate)
                    .ok_or_else(|| format!("{label} {item_id} consumption rate overflowed"))?,
            );
        }
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
    let mut has_terminal_product = research.is_some()
        || dyson_rocket.is_some()
        || dyson_sail.is_some()
        || galactic_export.is_some()
        || orbital_contracts.is_some();
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
        finite_veins,
        recipe_ids,
        research,
        dyson_rocket,
        dyson_sail,
        galactic_export,
        orbital_contracts,
        renewable_power,
    })
}

fn capture_stable_ordinary_window_flow(
    snapshots: &[SettlementProofSnapshot],
    allow_certified_dyson_terminal: bool,
    certified_terminal_windows: &[MaterialTotals],
) -> Result<OrdinaryWindowFlow, String> {
    if certified_terminal_windows.len() != 3 {
        return Err(format!(
            "terminal ledger requires three calibration windows, observed {}",
            certified_terminal_windows.len()
        ));
    }
    let mut windows = Vec::with_capacity(3);
    for (window, certified_terminal) in snapshots.windows(2).zip(certified_terminal_windows.iter())
    {
        windows.push(capture_ordinary_window_flow(
            &window[0],
            &window[1],
            allow_certified_dyson_terminal,
            certified_terminal,
        )?);
    }
    let flow = windows
        .first()
        .cloned()
        .ok_or_else(|| "three-window calibration produced no flow snapshots".to_owned())?;
    if windows.iter().skip(1).any(|window| window != &flow) {
        return Err("ordinary production/consumption/ownership rates were unstable across the three calibration windows".to_owned());
    }
    Ok(flow)
}

fn prepare_ordinary_flow_certificate_with_runtime(
    state: &CoreState,
    snapshots: &[SettlementProofSnapshot],
    runtime: &DeterministicRuntime,
) -> OrdinaryCertificatePrepareOutcome {
    if snapshots.len() != 4 {
        return OrdinaryCertificatePrepareOutcome {
            result: Err(format!(
                "three-window calibration requires four snapshots, observed {}",
                snapshots.len()
            )),
            entity_parse: None,
            wave_one: None,
            wave_two: None,
        };
    }
    for window in snapshots.windows(2) {
        if let Err(reason) =
            validate_internal_exact_snapshots(&window[0], &window[1], &state.catalog)
        {
            return OrdinaryCertificatePrepareOutcome {
                result: Err(format!(
                    "calibration window settlement proof rejected: {reason}"
                )),
                entity_parse: None,
                wave_one: None,
                wave_two: None,
            };
        }
    }
    let Some(quantum) = state
        .base_value()
        .get("quantumLogisticsNetwork")
        .and_then(Value::as_object)
    else {
        return OrdinaryCertificatePrepareOutcome {
            result: Err("quantum logistics network is missing".to_owned()),
            entity_parse: None,
            wave_one: None,
            wave_two: None,
        };
    };
    if quantum.get("enabled").and_then(Value::as_bool) != Some(true) {
        return OrdinaryCertificatePrepareOutcome {
            result: Err("quantum logistics network is disabled".to_owned()),
            entity_parse: None,
            wave_one: None,
            wave_two: None,
        };
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
        return OrdinaryCertificatePrepareOutcome {
            result: Err("quantum inventory or capacity ledger is malformed".to_owned()),
            entity_parse: None,
            wave_one: None,
            wave_two: None,
        };
    }

    let work_items = pure_idle_certificate_prepare_work_items(state);
    let wave_one_started = std::time::Instant::now();
    let ((sources, research, dyson_sail, dyson_rocket), wave_one) = runtime.partitioned_prepare4(
        0b0000_1111,
        work_items,
        || exclusive_vein_sources(state),
        || build_research_sink_certificate(state, snapshots),
        || build_dyson_sail_sink_certificate(state, snapshots),
        || build_dyson_rocket_sink_certificate(state, snapshots),
    );
    profile_certificate_prepare(
        "pure-idle-ordinary-certificate-wave1",
        wave_one,
        wave_one_started.elapsed(),
    );

    // Terminal endpoint proofs are compact (four projects / at most three
    // accepted contracts) and intentionally run after every exact worker has
    // joined. They never scan entities or stock and therefore cannot turn a
    // prefilled terminal buffer into a renewable production source.
    let galactic_export = build_galactic_export_sink_certificate(state, snapshots);
    let orbital_contracts = build_orbital_contract_sink_certificate(state, snapshots);
    let allow_certified_dyson_terminal = matches!(&dyson_sail, Ok(Some(_)))
        || matches!((&dyson_sail, &dyson_rocket), (Ok(None), Ok(Some(_))));
    let mut certified_terminal_rate = MaterialTotals::new();
    for terminal in [
        galactic_export
            .as_ref()
            .ok()
            .and_then(Option::as_ref)
            .map(|terminal| &terminal.consumed_units_per_second),
        orbital_contracts
            .as_ref()
            .ok()
            .and_then(Option::as_ref)
            .map(|terminal| &terminal.consumed_units_per_second),
    ]
    .into_iter()
    .flatten()
    {
        for (item_id, rate) in terminal {
            let current = certified_terminal_rate.get(item_id).copied().unwrap_or(0);
            certified_terminal_rate.insert(
                item_id.clone(),
                current.checked_add(*rate).unwrap_or(i128::MAX),
            );
        }
    }
    let certified_terminal_window = certified_terminal_rate
        .iter()
        .map(|(item_id, rate)| {
            rate.checked_mul(MACRO_V10_CALIBRATION_WINDOW_SECONDS as i128)
                .map(|amount| (item_id.clone(), amount))
                .ok_or_else(|| format!("{item_id} terminal calibration rate overflowed"))
        })
        .collect::<Result<MaterialTotals, _>>();
    let certified_terminal_windows =
        certified_terminal_window.map(|window| vec![window.clone(), window.clone(), window]);
    let dynamic_ray_power = match &dyson_sail {
        Ok(Some(_)) => has_dynamic_ray_power_source(state),
        Ok(None) => Ok(false),
        Err(reason) => Err(reason.clone()),
    };
    let (renewable_entity_snapshot, entity_parse) = if matches!(&dynamic_ray_power, Ok(true)) {
        let started = std::time::Instant::now();
        let (snapshot, diagnostics) = state.parse_entities_with_runtime_diagnostics(runtime);
        profile_certificate_entity_parse(
            "pure-idle-ordinary-renewable-entities",
            diagnostics,
            started.elapsed(),
        );
        (Some(snapshot), Some(diagnostics))
    } else {
        (None, None)
    };
    let wave_two_active_mask = 0b0000_0101
        | if matches!(&dyson_sail, Ok(Some(_))) {
            0b0000_0010
        } else {
            0
        };
    let wave_two_started = std::time::Instant::now();
    let ((finite_veins, renewable_power, flow, ()), wave_two) = runtime.partitioned_prepare4(
        wave_two_active_mask,
        work_items,
        || match &sources {
            Ok(sources) => build_finite_vein_certificates(state, snapshots, sources),
            Err(reason) => Err(reason.clone()),
        },
        || match &dynamic_ray_power {
            Ok(true) => build_renewable_power_tail_certificate(
                state,
                snapshots,
                renewable_entity_snapshot
                    .as_ref()
                    .expect("dynamic ray preparation owns an entity snapshot")
                    .as_deref()
                    .map_err(|error| format!("ray-power entity snapshot failed: {error:#}")),
            )
            .map(Some),
            Ok(false) => Ok(None),
            Err(reason) => Err(reason.clone()),
        },
        || match &certified_terminal_windows {
            Ok(windows) => capture_stable_ordinary_window_flow(
                snapshots,
                allow_certified_dyson_terminal,
                windows,
            ),
            Err(reason) => Err(reason.clone()),
        },
        || (),
    );
    profile_certificate_prepare(
        "pure-idle-ordinary-certificate-wave2",
        wave_two,
        wave_two_started.elapsed(),
    );

    // Every worker has joined. Only this serial fold can select a failure or
    // assemble a certificate, and it retains the historical domain order.
    let result = (|| {
        let sources = sources?;
        let finite_veins = finite_veins?;
        let research = research?;
        let dyson_sail = dyson_sail?;
        let renewable_power = renewable_power?;
        let dyson_rocket = if dyson_sail.is_none() {
            dyson_rocket?
        } else {
            None
        };
        let galactic_export = galactic_export?;
        let orbital_contracts = orbital_contracts?;
        let recipe_rejection = (|| {
            let flow = flow?;
            validate_finite_source_rates(
                state,
                &sources,
                &flow.produced_per_second,
                &finite_veins,
            )?;
            build_closed_recipe_certificate(
                state,
                &sources,
                &flow,
                finite_veins.clone(),
                OrdinaryTerminalCertificates {
                    research: research.clone(),
                    dyson_rocket: dyson_rocket.clone(),
                    dyson_sail: dyson_sail.clone(),
                    galactic_export: galactic_export.clone(),
                    orbital_contracts: orbital_contracts.clone(),
                    renewable_power: renewable_power.clone(),
                },
            )
        })();
        if let Ok(certificate) = recipe_rejection {
            return Ok(certificate);
        }
        let recipe_rejection = recipe_rejection.unwrap_err();

        // Source-only is a strict subset, not a recovery path for a malformed
        // or unclosed active recipe domain.
        if !active_ordinary_recipe_ids(
            state,
            dyson_rocket.is_some(),
            dyson_sail.is_some(),
            renewable_power.is_some(),
            galactic_export.is_some(),
            orbital_contracts.is_some(),
        )?
        .is_empty()
            || research.is_some()
            || dyson_rocket.is_some()
            || dyson_sail.is_some()
            || galactic_export.is_some()
            || orbital_contracts.is_some()
        {
            return Err(recipe_rejection);
        }

        let mut rates = MaterialTotals::new();
        let mut first_rejection = None;
        for item_id in &sources {
            let mut stable_production = None;
            let mut rejected = None;
            for window in snapshots.windows(2) {
                let owned =
                    checked_material_delta(&window[0].owned, &window[1].owned, item_id, "owned")?;
                let produced = checked_material_delta(
                    &window[0].produced,
                    &window[1].produced,
                    item_id,
                    "produced",
                )?;
                let consumed = checked_material_delta(
                    &window[0].consumed,
                    &window[1].consumed,
                    item_id,
                    "consumed",
                )?;
                let granted = checked_material_delta(
                    &window[0].granted,
                    &window[1].granted,
                    item_id,
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
                rates.insert(item_id.clone(), rate);
            }
        }
        if rates.is_empty() {
            return Err(first_rejection.unwrap_or(recipe_rejection));
        }
        validate_finite_source_rates(state, &sources, &rates, &finite_veins)?;
        Ok(OrdinaryFlowCertificate {
            units_per_second: rates.clone(),
            produced_units_per_second: rates,
            consumed_units_per_second: MaterialTotals::new(),
            finite_veins,
            recipe_ids: Vec::new(),
            research: None,
            dyson_rocket: None,
            dyson_sail: None,
            galactic_export: None,
            orbital_contracts: None,
            renewable_power: None,
        })
    })();
    OrdinaryCertificatePrepareOutcome {
        result,
        entity_parse,
        wave_one: Some(wave_one),
        wave_two: Some(wave_two),
    }
}

#[cfg(test)]
fn build_ordinary_flow_certificate(
    state: &CoreState,
    snapshots: &[SettlementProofSnapshot],
) -> Result<OrdinaryFlowCertificate, String> {
    prepare_ordinary_flow_certificate_with_runtime(state, snapshots, deterministic_runtime()).result
}

fn exact_three_window_probe(
    state: &CoreState,
    request: &CoreAdvanceRequest,
) -> Result<Vec<SettlementProofSnapshot>, String> {
    exact_three_window_probe_with_construction_policy(state, request, false)
}

fn exact_three_window_probe_isolating_construction(
    state: &CoreState,
    request: &CoreAdvanceRequest,
) -> Result<Vec<SettlementProofSnapshot>, String> {
    exact_three_window_probe_with_construction_policy(state, request, true)
}

fn exact_three_window_probe_with_construction_policy(
    state: &CoreState,
    request: &CoreAdvanceRequest,
    isolate_construction_automation: bool,
) -> Result<Vec<SettlementProofSnapshot>, String> {
    let multiplier = if request.advance_mode == CoreAdvanceMode::OfflineMacroV1 {
        1.0
    } else {
        finite_number_at(state.base_value().get("timeWarp"), &["effectiveMultiplier"])
            .filter(|value| *value > 0.0)
            .ok_or_else(|| "probe multiplier is invalid".to_owned())?
    };
    let mut probe = state.clone();
    // The probe is disposable and must not inherit a stale runtime proof as an
    // input to the exact engine. Clearing it also keeps the clone compact.
    probe.pure_idle_macro_runtime = None;
    let mut snapshots = vec![
        capture_settlement_snapshot(&probe)
            .map_err(|error| format!("probe baseline snapshot failed: {error:#}"))?,
    ];
    for _ in 0..3 {
        let exact_base_revision = probe.revision;
        let probe_request = exact_request(
            probe.revision,
            MACRO_V10_CALIBRATION_WINDOW_SECONDS,
            MACRO_V10_CALIBRATION_WINDOW_SECONDS / multiplier,
        );
        let mut result = if isolate_construction_automation {
            probe.advance_exact_isolating_construction(&probe_request)
        } else {
            probe.advance_exact(&probe_request)
        }
        .map_err(|error| format!("probe exact window failed: {error:#}"))?;
        if !result.supported {
            return Err(result
                .reason
                .take()
                .unwrap_or_else(|| "probe exact window is unsupported".to_owned()));
        }
        let after = capture_exact_settlement_snapshot(&probe, exact_base_revision)
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
    galactic_export_certified: bool,
    orbital_contract_certified: bool,
    galactic_exported: i128,
    orbital_contract_delivered: i128,
    terminal_boundary_limited: bool,
    rockets_launched: i128,
    sails_launched: i128,
    sails_expired: i128,
    sails_absorbed: i128,
    capacity_limited: bool,
}

#[derive(Debug, Clone)]
struct BoundedHandcraftEntryPlan {
    recipe_id: String,
    planet_id: String,
    duration_micros: i128,
    inputs: MaterialTotals,
    outputs: MaterialTotals,
}

#[derive(Debug, Clone)]
struct BoundedHandcraftTailPlan {
    active_planet_id: String,
    tray_limit: i128,
    initial_remaining_batches: i128,
    entries: BTreeMap<String, BoundedHandcraftEntryPlan>,
}

#[derive(Debug, Clone, PartialEq)]
struct BoundedHandcraftWorkingSet {
    queue: Vec<Value>,
    tray: Map<String, Value>,
    portable_fleet: Map<String, Value>,
    total_produced: Map<String, Value>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct BoundedHandcraftApplication {
    changed: bool,
    input_units_debited: i128,
    output_units_produced: i128,
    completed_batches: i128,
    remaining_batches: i128,
    stopped_at_horizon: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum BoundedHandcraftTailOutcome {
    Inactive,
    Frozen(String),
    Applied(BoundedHandcraftApplication),
}

fn bounded_handcraft_catalog_totals(
    amounts: &[crate::catalog::ItemAmount],
    label: &str,
) -> Result<MaterialTotals, String> {
    let mut totals = MaterialTotals::new();
    for amount in amounts {
        let unit_amount =
            construction_catalog_integer(amount.amount, &format!("{label}.{}", amount.item_id))?;
        let current = totals.get(&amount.item_id).copied().unwrap_or(0);
        totals.insert(
            amount.item_id.clone(),
            current
                .checked_add(unit_amount)
                .ok_or_else(|| format!("{label}.{} aggregate overflowed", amount.item_id))?,
        );
    }
    Ok(totals)
}

fn bounded_handcraft_duration_micros(duration: f64, label: &str) -> Result<i128, String> {
    let duration = duration.max(0.05);
    if !duration.is_finite() || duration <= 0.0 {
        return Err(format!("{label} duration is not finite and positive"));
    }
    let scaled = duration * MICROS_PER_SECOND as f64;
    let rounded = scaled.round();
    if !scaled.is_finite()
        || !(1.0..=MAX_SAFE_INTEGER).contains(&rounded)
        || (scaled - rounded).abs() > EPSILON * scaled.abs().max(1.0)
    {
        return Err(format!(
            "{label} duration is not representable at microsecond precision"
        ));
    }
    Ok(rounded as i128)
}

fn bounded_handcraft_progress_micros(
    progress: f64,
    duration_micros: i128,
    label: &str,
) -> Result<i128, String> {
    if !progress.is_finite() || !(0.0..=1.0).contains(&progress) {
        return Err(format!("{label} progress is outside the supported range"));
    }
    if progress <= HANDCRAFT_PROGRESS_EPSILON {
        return Ok(0);
    }
    let scaled = progress * duration_micros as f64;
    let rounded = scaled.round();
    if !scaled.is_finite()
        || rounded < 0.0
        || rounded > duration_micros as f64
        || (scaled - rounded).abs() > EPSILON * scaled.abs().max(1.0)
    {
        return Err(format!(
            "{label} progress is not representable at microsecond precision"
        ));
    }
    Ok(rounded as i128)
}

fn bounded_handcraft_plan(state: &CoreState) -> Result<Option<BoundedHandcraftTailPlan>, String> {
    let base = state.base_value();
    let queue = base
        .get("handcraftQueue")
        .and_then(Value::as_array)
        .ok_or_else(|| "handcraft queue is malformed".to_owned())?;
    if queue.is_empty() {
        return Ok(None);
    }
    let active_planet_id = base
        .get("activePlanetId")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .ok_or_else(|| "handcraft active planet is missing".to_owned())?
        .to_owned();
    for (field, label) in [
        (base.get("tray"), "active tray"),
        (base.get("portableFleet"), "portable fleet"),
        (base.get("totalProduced"), "totalProduced"),
        (base.get("planetTrays"), "planet trays"),
    ] {
        if field.and_then(Value::as_object).is_none() {
            return Err(format!("{label} is malformed"));
        }
    }
    let tray_limit = base
        .get("planetTrayItemLimits")
        .and_then(Value::as_object)
        .and_then(|limits| limits.get(&active_planet_id))
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
        .map(|value| value.floor().clamp(1_000.0, 100_000_000.0))
        .unwrap_or(1_000_000.0) as i128;

    let mut seen_ids = HashSet::new();
    let mut initial_remaining_batches = 0_i128;
    let mut entries = BTreeMap::new();
    for (index, entry) in queue.iter().enumerate() {
        let entry = entry
            .as_object()
            .ok_or_else(|| format!("handcraft queue entry {index} is not an object"))?;
        let id = entry
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .ok_or_else(|| format!("handcraft queue entry {index} has no ID"))?;
        if !seen_ids.insert(id.to_owned()) {
            return Err(format!("handcraft queue repeats ID {id}"));
        }
        let recipe_id = entry
            .get("recipeId")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .ok_or_else(|| format!("handcraft queue entry {id} has no recipe ID"))?;
        let planet_id = entry
            .get("planetId")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .ok_or_else(|| format!("handcraft queue entry {id} has no planet ID"))?;
        let remaining = proof_counter(
            entry.get("batchesRemaining"),
            &format!("handcraftQueue.{id}.batchesRemaining"),
        )
        .map_err(|error| error.to_string())?;
        let total = proof_counter(
            entry.get("batchesTotal"),
            &format!("handcraftQueue.{id}.batchesTotal"),
        )
        .map_err(|error| error.to_string())?;
        if remaining <= 0 || total < remaining {
            return Err(format!(
                "handcraft queue entry {id} has an invalid batch count"
            ));
        }
        initial_remaining_batches = initial_remaining_batches
            .checked_add(remaining)
            .ok_or_else(|| "handcraft queue batch total overflowed".to_owned())?;
        if initial_remaining_batches > MAX_BOUNDED_HANDCRAFT_TAIL_BATCHES {
            return Err(format!(
                "handcraft queue has {initial_remaining_batches} remaining batches; bounded tail limit is {MAX_BOUNDED_HANDCRAFT_TAIL_BATCHES}"
            ));
        }
        let queued_at = entry
            .get("queuedAt")
            .and_then(Value::as_f64)
            .filter(|value| value.is_finite())
            .ok_or_else(|| format!("handcraft queue entry {id} queuedAt is invalid"))?;
        let _ = queued_at;
        let progress = entry
            .get("progress")
            .and_then(Value::as_f64)
            .ok_or_else(|| format!("handcraft queue entry {id} progress is invalid"))?;
        let recipe =
            state.catalog.recipes.get(recipe_id).ok_or_else(|| {
                format!("handcraft recipe {recipe_id} is absent from the catalog")
            })?;
        if recipe.outputs.is_empty() {
            return Err(format!(
                "handcraft recipe {recipe_id} has no material output"
            ));
        }
        let duration_micros = bounded_handcraft_duration_micros(
            recipe.duration,
            &format!("handcraft recipe {recipe_id}"),
        )?;
        bounded_handcraft_progress_micros(
            progress,
            duration_micros,
            &format!("handcraftQueue.{id}"),
        )?;
        entries.insert(
            id.to_owned(),
            BoundedHandcraftEntryPlan {
                recipe_id: recipe_id.to_owned(),
                planet_id: planet_id.to_owned(),
                duration_micros,
                inputs: bounded_handcraft_catalog_totals(
                    &recipe.inputs,
                    &format!("recipes.{recipe_id}.inputs"),
                )?,
                outputs: bounded_handcraft_catalog_totals(
                    &recipe.outputs,
                    &format!("recipes.{recipe_id}.outputs"),
                )?,
            },
        );
    }
    Ok(Some(BoundedHandcraftTailPlan {
        active_planet_id,
        tray_limit,
        initial_remaining_batches,
        entries,
    }))
}

fn bounded_handcraft_working_set(state: &CoreState) -> Result<BoundedHandcraftWorkingSet, String> {
    let base = state.base_value();
    Ok(BoundedHandcraftWorkingSet {
        queue: base
            .get("handcraftQueue")
            .and_then(Value::as_array)
            .cloned()
            .ok_or_else(|| "handcraft queue disappeared before settlement".to_owned())?,
        tray: base
            .get("tray")
            .and_then(Value::as_object)
            .cloned()
            .ok_or_else(|| "active tray disappeared before handcraft settlement".to_owned())?,
        portable_fleet: base
            .get("portableFleet")
            .and_then(Value::as_object)
            .cloned()
            .ok_or_else(|| "portable fleet disappeared before handcraft settlement".to_owned())?,
        total_produced: base
            .get("totalProduced")
            .and_then(Value::as_object)
            .cloned()
            .ok_or_else(|| "totalProduced disappeared before handcraft settlement".to_owned())?,
    })
}

fn bounded_handcraft_map_counter(
    map: &Map<String, Value>,
    item_id: &str,
    label: &str,
) -> Result<i128, String> {
    proof_counter(map.get(item_id), &format!("{label}.{item_id}"))
        .map_err(|error| error.to_string())
}

fn bounded_handcraft_set_counter(
    map: &mut Map<String, Value>,
    item_id: &str,
    amount: i128,
    label: &str,
) -> Result<(), String> {
    if !(0..=MAX_SAFE_INTEGER as i128).contains(&amount) {
        return Err(format!("{label}.{item_id} exceeds the safe integer range"));
    }
    map.insert(
        item_id.to_owned(),
        Value::Number(Number::from(
            i64::try_from(amount).map_err(|_| format!("{label}.{item_id} cannot be encoded"))?,
        )),
    );
    Ok(())
}

fn bounded_handcraft_can_store_outputs(
    working: &BoundedHandcraftWorkingSet,
    plan: &BoundedHandcraftTailPlan,
    outputs: &MaterialTotals,
) -> Result<bool, String> {
    for (item_id, amount) in outputs {
        if matches!(item_id.as_str(), "logistics_drone" | "logistics_vessel") {
            continue;
        }
        let current = bounded_handcraft_map_counter(&working.tray, item_id, "tray")?;
        if current
            .checked_add(*amount)
            .is_none_or(|next| next > plan.tray_limit)
        {
            return Ok(false);
        }
    }
    Ok(true)
}

fn bounded_handcraft_has_inputs(
    working: &BoundedHandcraftWorkingSet,
    inputs: &MaterialTotals,
) -> Result<bool, String> {
    for (item_id, amount) in inputs {
        if bounded_handcraft_map_counter(&working.tray, item_id, "tray")? < *amount {
            return Ok(false);
        }
    }
    Ok(true)
}

fn bounded_handcraft_debit_inputs(
    working: &mut BoundedHandcraftWorkingSet,
    inputs: &MaterialTotals,
    debited: &mut MaterialTotals,
) -> Result<(), String> {
    for (item_id, amount) in inputs {
        let current = bounded_handcraft_map_counter(&working.tray, item_id, "tray")?;
        let next = current
            .checked_sub(*amount)
            .filter(|next| *next >= 0)
            .ok_or_else(|| format!("handcraft input {item_id} underflowed"))?;
        bounded_handcraft_set_counter(&mut working.tray, item_id, next, "tray")?;
        let previous = debited.get(item_id).copied().unwrap_or(0);
        debited.insert(
            item_id.clone(),
            previous
                .checked_add(*amount)
                .ok_or_else(|| format!("handcraft input {item_id} receipt overflowed"))?,
        );
    }
    Ok(())
}

fn bounded_handcraft_credit_outputs(
    working: &mut BoundedHandcraftWorkingSet,
    outputs: &MaterialTotals,
    credited: &mut MaterialTotals,
) -> Result<(), String> {
    for (item_id, amount) in outputs {
        let target = if matches!(item_id.as_str(), "logistics_drone" | "logistics_vessel") {
            &mut working.portable_fleet
        } else {
            &mut working.tray
        };
        let current = bounded_handcraft_map_counter(target, item_id, "handcraft output")?;
        let next = current
            .checked_add(*amount)
            .ok_or_else(|| format!("handcraft output {item_id} overflowed"))?;
        bounded_handcraft_set_counter(target, item_id, next, "handcraft output")?;

        let current_produced =
            bounded_handcraft_map_counter(&working.total_produced, item_id, "totalProduced")?;
        let next_produced = current_produced
            .checked_add(*amount)
            .ok_or_else(|| format!("totalProduced.{item_id} overflowed"))?;
        bounded_handcraft_set_counter(
            &mut working.total_produced,
            item_id,
            next_produced,
            "totalProduced",
        )?;
        let previous = credited.get(item_id).copied().unwrap_or(0);
        credited.insert(
            item_id.clone(),
            previous
                .checked_add(*amount)
                .ok_or_else(|| format!("handcraft output {item_id} receipt overflowed"))?,
        );
    }
    Ok(())
}

fn bounded_handcraft_remaining_batches(queue: &[Value]) -> Result<i128, String> {
    let mut total = 0_i128;
    for (index, entry) in queue.iter().enumerate() {
        let entry = entry
            .as_object()
            .ok_or_else(|| format!("handcraft queue entry {index} is not an object"))?;
        let remaining = proof_counter(
            entry.get("batchesRemaining"),
            &format!("handcraftQueue.{index}.batchesRemaining"),
        )
        .map_err(|error| error.to_string())?;
        total = total
            .checked_add(remaining)
            .ok_or_else(|| "handcraft remaining batch total overflowed".to_owned())?;
    }
    Ok(total)
}

fn validate_bounded_handcraft_receipt(
    before: &BoundedHandcraftWorkingSet,
    after: &BoundedHandcraftWorkingSet,
    plan: &BoundedHandcraftTailPlan,
    input_debits: &MaterialTotals,
    output_credits: &MaterialTotals,
    completed_batches: i128,
) -> Result<(), String> {
    let remaining = bounded_handcraft_remaining_batches(&after.queue)?;
    if plan
        .initial_remaining_batches
        .checked_sub(remaining)
        .filter(|delta| *delta == completed_batches)
        .is_none()
    {
        return Err("handcraft completed-batch receipt does not match the queue delta".to_owned());
    }
    for item_id in material_ids([input_debits, output_credits]) {
        let before_owned = bounded_handcraft_map_counter(&before.tray, &item_id, "before.tray")?
            .checked_add(bounded_handcraft_map_counter(
                &before.portable_fleet,
                &item_id,
                "before.portableFleet",
            )?)
            .ok_or_else(|| format!("handcraft before ownership {item_id} overflowed"))?;
        let after_owned = bounded_handcraft_map_counter(&after.tray, &item_id, "after.tray")?
            .checked_add(bounded_handcraft_map_counter(
                &after.portable_fleet,
                &item_id,
                "after.portableFleet",
            )?)
            .ok_or_else(|| format!("handcraft after ownership {item_id} overflowed"))?;
        let expected_stock_delta = output_credits
            .get(&item_id)
            .copied()
            .unwrap_or(0)
            .checked_sub(input_debits.get(&item_id).copied().unwrap_or(0))
            .ok_or_else(|| format!("handcraft stock receipt {item_id} overflowed"))?;
        if after_owned - before_owned != expected_stock_delta {
            return Err(format!(
                "handcraft {item_id} stock delta {} does not match recipe receipt {expected_stock_delta}",
                after_owned - before_owned
            ));
        }
        let produced_delta =
            bounded_handcraft_map_counter(&after.total_produced, &item_id, "after.totalProduced")?
                - bounded_handcraft_map_counter(
                    &before.total_produced,
                    &item_id,
                    "before.totalProduced",
                )?;
        let expected_produced = output_credits.get(&item_id).copied().unwrap_or(0);
        if produced_delta != expected_produced {
            return Err(format!(
                "handcraft {item_id} cumulative production delta {produced_delta} does not match recipe output {expected_produced}"
            ));
        }
    }
    Ok(())
}

fn apply_bounded_handcraft_tail(
    state: &mut CoreState,
    tail_seconds: f64,
) -> Result<BoundedHandcraftTailOutcome, String> {
    let Some(plan) = (match bounded_handcraft_plan(state) {
        Ok(plan) => plan,
        Err(reason) => return Ok(BoundedHandcraftTailOutcome::Frozen(reason)),
    }) else {
        return Ok(BoundedHandcraftTailOutcome::Inactive);
    };
    let mut working = bounded_handcraft_working_set(state)?;
    let before = working.clone();
    let mut remaining_micros = elapsed_micros(tail_seconds)?;
    let mut input_debits = MaterialTotals::new();
    let mut output_credits = MaterialTotals::new();
    let mut completed_batches = 0_i128;
    let mut stopped_at_horizon = false;

    while remaining_micros > 0 && !working.queue.is_empty() {
        let entry = working.queue[0]
            .as_object()
            .ok_or_else(|| "handcraft head entry became malformed".to_owned())?;
        let entry_id = entry
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| "handcraft head entry lost its ID".to_owned())?
            .to_owned();
        let entry_plan = plan
            .entries
            .get(&entry_id)
            .ok_or_else(|| format!("handcraft head entry {entry_id} left the certified queue"))?;
        if entry_plan.planet_id != plan.active_planet_id {
            stopped_at_horizon = true;
            break;
        }
        let progress = entry
            .get("progress")
            .and_then(Value::as_f64)
            .ok_or_else(|| format!("handcraft queue entry {entry_id} progress disappeared"))?;
        let mut progress_micros = bounded_handcraft_progress_micros(
            progress,
            entry_plan.duration_micros,
            &format!("handcraftQueue.{entry_id}"),
        )?;
        if progress <= HANDCRAFT_PROGRESS_EPSILON {
            if !bounded_handcraft_can_store_outputs(&working, &plan, &entry_plan.outputs)?
                || !bounded_handcraft_has_inputs(&working, &entry_plan.inputs)?
            {
                stopped_at_horizon = true;
                break;
            }
            bounded_handcraft_debit_inputs(&mut working, &entry_plan.inputs, &mut input_debits)?;
            progress_micros = 0;
        }

        let cycle_remaining = entry_plan
            .duration_micros
            .checked_sub(progress_micros)
            .ok_or_else(|| {
                format!(
                    "handcraft recipe {} progress overflowed",
                    entry_plan.recipe_id
                )
            })?;
        let elapsed = remaining_micros.min(cycle_remaining);
        let next_progress_micros = progress_micros.checked_add(elapsed).ok_or_else(|| {
            format!(
                "handcraft recipe {} progress overflowed",
                entry_plan.recipe_id
            )
        })?;
        remaining_micros -= elapsed;
        let next_progress = next_progress_micros as f64 / entry_plan.duration_micros as f64;
        working.queue[0]
            .as_object_mut()
            .ok_or_else(|| "handcraft head entry became malformed".to_owned())?
            .insert(
                "progress".to_owned(),
                Number::from_f64(next_progress)
                    .map(Value::Number)
                    .ok_or_else(|| "handcraft progress encode failed".to_owned())?,
            );
        if next_progress < 1.0 - HANDCRAFT_PROGRESS_EPSILON {
            break;
        }
        if !bounded_handcraft_can_store_outputs(&working, &plan, &entry_plan.outputs)? {
            stopped_at_horizon = true;
            break;
        }
        bounded_handcraft_credit_outputs(&mut working, &entry_plan.outputs, &mut output_credits)?;
        completed_batches = completed_batches
            .checked_add(1)
            .ok_or_else(|| "handcraft completed batch count overflowed".to_owned())?;
        let remaining = proof_counter(
            working.queue[0]
                .as_object()
                .and_then(|entry| entry.get("batchesRemaining")),
            &format!("handcraftQueue.{entry_id}.batchesRemaining"),
        )
        .map_err(|error| error.to_string())?
        .checked_sub(1)
        .ok_or_else(|| format!("handcraft queue entry {entry_id} batch count underflowed"))?;
        if remaining == 0 {
            working.queue.remove(0);
        } else {
            let entry = working.queue[0]
                .as_object_mut()
                .ok_or_else(|| "handcraft head entry became malformed".to_owned())?;
            entry.insert(
                "batchesRemaining".to_owned(),
                Value::Number(Number::from(i64::try_from(remaining).map_err(|_| {
                    format!("handcraft queue entry {entry_id} cannot encode batch count")
                })?)),
            );
            entry.insert("progress".to_owned(), Value::from(0));
        }
    }

    validate_bounded_handcraft_receipt(
        &before,
        &working,
        &plan,
        &input_debits,
        &output_credits,
        completed_batches,
    )?;
    let input_units_debited = input_debits.values().try_fold(0_i128, |total, amount| {
        total
            .checked_add(*amount)
            .ok_or_else(|| "handcraft input receipt total overflowed".to_owned())
    })?;
    let output_units_produced = output_credits.values().try_fold(0_i128, |total, amount| {
        total
            .checked_add(*amount)
            .ok_or_else(|| "handcraft output receipt total overflowed".to_owned())
    })?;
    let remaining_batches = bounded_handcraft_remaining_batches(&working.queue)?;
    let changed = working != before;
    if changed {
        let base = state.base_value_mut();
        base.insert("handcraftQueue".to_owned(), Value::Array(working.queue));
        base.insert("tray".to_owned(), Value::Object(working.tray.clone()));
        base.insert(
            "portableFleet".to_owned(),
            Value::Object(working.portable_fleet),
        );
        base.insert(
            "totalProduced".to_owned(),
            Value::Object(working.total_produced),
        );
        base.get_mut("planetTrays")
            .and_then(Value::as_object_mut)
            .ok_or_else(|| "planet trays disappeared before handcraft commit".to_owned())?
            .insert(plan.active_planet_id, Value::Object(working.tray));
    }
    Ok(BoundedHandcraftTailOutcome::Applied(
        BoundedHandcraftApplication {
            changed,
            input_units_debited,
            output_units_produced,
            completed_batches,
            remaining_batches,
            stopped_at_horizon,
        },
    ))
}

fn finite_vein_available_units(vein: &FiniteVeinProofSnapshot) -> Result<i128, String> {
    if vein.consumption_tenths <= 0 || vein.consumption_tenths > 10 {
        return Err(format!(
            "finite vein {} has an invalid consumption rate",
            vein.entity_id
        ));
    }
    vein.remaining
        .checked_mul(10)
        .and_then(|value| value.checked_sub(vein.depletion_remainder))
        .map(|value| value.max(0))
        .and_then(|value| value.checked_div(vein.consumption_tenths))
        .ok_or_else(|| format!("finite vein {} reserve horizon overflowed", vein.entity_id))
}

fn finite_vein_capacity_seconds(
    state: &CoreState,
    certificate: &OrdinaryFlowCertificate,
) -> Result<i128, String> {
    let sources = exclusive_vein_sources(state)?;
    validate_finite_source_rates(
        state,
        &sources,
        &certificate.produced_units_per_second,
        &certificate.finite_veins,
    )?;
    let mut horizon = i128::MAX;
    let mut seen = HashSet::new();
    for vein in &certificate.finite_veins {
        if vein.units_per_second <= 0 {
            return Err(format!(
                "finite vein {} has a non-positive certified rate",
                vein.expected.entity_id
            ));
        }
        if !seen.insert(vein.expected.entity_id.clone()) {
            return Err(format!(
                "finite vein certificate repeats {}",
                vein.expected.entity_id
            ));
        }
        let current = finite_vein_snapshot_at(state, vein.expected.entity_index)
            .map_err(|error| {
                format!(
                    "finite vein {} current state is invalid: {error:#}",
                    vein.expected.entity_id
                )
            })?
            .ok_or_else(|| {
                format!(
                    "finite vein {} is no longer a finite source",
                    vein.expected.entity_id
                )
            })?;
        if current != vein.expected {
            return Err(format!(
                "finite vein {} state diverged from its certified endpoint",
                vein.expected.entity_id
            ));
        }
        horizon = horizon.min(finite_vein_available_units(&current)? / vein.units_per_second);
    }
    Ok(horizon)
}

fn galactic_export_capacity_seconds(
    terminal: &GalacticExportSinkCertificate,
) -> Result<i128, String> {
    for (item_id, rate) in &terminal.consumed_units_per_second {
        if *rate <= 0 {
            return Err(format!(
                "Galactic export {item_id} has a non-positive certified rate"
            ));
        }
    }
    crate::galactic_exports::certified_pure_idle_export_capacity_seconds(
        &terminal.expected,
        &terminal.consumed_units_per_second,
    )
    .map_err(|error| format!("Galactic export capacity failed: {error:#}"))
}

fn galactic_multiplier_microunits(state: &CoreState) -> Result<i128, String> {
    let time_warp_enabled = state
        .base_value()
        .get("timeWarp")
        .and_then(Value::as_object)
        .and_then(|time_warp| time_warp.get("enabled"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let multiplier = if time_warp_enabled {
        finite_number_at(state.base_value().get("timeWarp"), &["effectiveMultiplier"])
            .filter(|value| *value > 0.0)
            .ok_or_else(|| "Galactic activity multiplier is invalid".to_owned())?
    } else {
        1.0
    };
    let scaled = multiplier * MICROS_PER_SECOND as f64;
    let rounded = scaled.round();
    if !scaled.is_finite()
        || rounded < 1.0
        || rounded > i128::MAX as f64
        || (scaled - rounded).abs() > 1e-6
    {
        return Err("Galactic activity multiplier is not exactly representable".to_owned());
    }
    Ok(rounded as i128)
}

/// Map the public absolute simulation clock onto an integer wall-millisecond
/// coordinate. Subtracting two absolute coordinates retains the fractional
/// phase across calls without adding a public save field: long, segmented and
/// cold-reloaded macro settlement therefore choose the same millisecond delta.
fn galactic_wall_millis_at(
    elapsed_micros: i128,
    multiplier_microunits: i128,
) -> Result<i128, String> {
    if elapsed_micros < 0 || multiplier_microunits <= 0 {
        return Err("Galactic activity wall coordinate is invalid".to_owned());
    }
    elapsed_micros
        .checked_mul(1_000)
        .and_then(|scaled| scaled.checked_div(multiplier_microunits))
        .ok_or_else(|| "Galactic activity wall coordinate overflowed".to_owned())
}

fn galactic_wall_millis_between(
    elapsed_before_micros: i128,
    elapsed_after_micros: i128,
    multiplier_microunits: i128,
) -> Result<i128, String> {
    if elapsed_after_micros < elapsed_before_micros {
        return Err("Galactic activity simulation clock regressed".to_owned());
    }
    galactic_wall_millis_at(elapsed_after_micros, multiplier_microunits)?
        .checked_sub(galactic_wall_millis_at(
            elapsed_before_micros,
            multiplier_microunits,
        )?)
        .ok_or_else(|| "Galactic activity wall delta overflowed".to_owned())
}

fn galactic_activity_capacity_seconds(
    terminal: &GalacticExportSinkCertificate,
    elapsed_before_micros: i128,
    scheduled_seconds: i128,
    multiplier_microunits: i128,
) -> Result<i128, String> {
    if scheduled_seconds <= 0 {
        return Ok(0);
    }
    let activity = &terminal.expected.activity;
    if activity.phase != crate::galactic_exports::CertifiedPureIdleExportActivityPhase::Active
        || activity.ends_at_ms <= activity.activity_clock_ms
    {
        return Ok(0);
    }
    let mut low = 0_i128;
    let mut high = scheduled_seconds;
    while low < high {
        let midpoint = low + (high - low + 1) / 2;
        let elapsed_after_micros = midpoint
            .checked_mul(MICROS_PER_SECOND)
            .and_then(|delta| elapsed_before_micros.checked_add(delta))
            .ok_or_else(|| "Galactic activity simulation horizon overflowed".to_owned())?;
        let wall_millis = galactic_wall_millis_between(
            elapsed_before_micros,
            elapsed_after_micros,
            multiplier_microunits,
        )?;
        let delivery_clock = activity.activity_clock_ms.saturating_add(wall_millis);
        if delivery_clock < activity.ends_at_ms {
            low = midpoint;
        } else {
            high = midpoint - 1;
        }
    }
    Ok(low)
}

fn galactic_activity_commit_clocks(
    terminal: &GalacticExportSinkCertificate,
    accepted_seconds: i128,
    elapsed_before_micros: i128,
    elapsed_after_micros: i128,
    multiplier_microunits: i128,
) -> Result<(i128, i128), String> {
    let activity = &terminal.expected.activity;
    if accepted_seconds < 0 {
        return Err("Galactic activity commit budget is invalid".to_owned());
    }
    let advanced_millis = galactic_wall_millis_between(
        elapsed_before_micros,
        elapsed_after_micros,
        multiplier_microunits,
    )?;
    let clock_after = activity
        .activity_clock_ms
        .saturating_add(advanced_millis)
        .min(activity.ends_at_ms)
        .max(activity.activity_clock_ms);
    let delivery_after_micros = accepted_seconds
        .checked_mul(MICROS_PER_SECOND)
        .and_then(|delta| elapsed_before_micros.checked_add(delta))
        .ok_or_else(|| "Galactic activity delivery clock overflowed".to_owned())?;
    let delivery_millis = galactic_wall_millis_between(
        elapsed_before_micros,
        delivery_after_micros,
        multiplier_microunits,
    )?;
    let last_delivery_at_ms = if accepted_seconds == 0 {
        activity.activity_clock_ms
    } else {
        activity
            .activity_clock_ms
            .saturating_add(delivery_millis)
            .min(clock_after)
            .min(activity.ends_at_ms.saturating_sub(1))
            .max(activity.activity_clock_ms)
    };
    Ok((clock_after, last_delivery_at_ms))
}

fn orbital_contract_capacity_seconds(
    terminal: &OrbitalContractSinkCertificate,
    scheduled_seconds: i128,
) -> Result<i128, String> {
    if scheduled_seconds <= 0 {
        return Ok(0);
    }
    let mut low = 0_i128;
    let mut high = scheduled_seconds;
    while low < high {
        let midpoint = low + (high - low + 1) / 2;
        let (budget, steps) =
            orbital_contract_schedule(&terminal.expected, &terminal.requirement_rates, midpoint)?;
        let plan = crate::orbital_station::plan_certified_pure_idle_contract_delivery_steps(
            &terminal.expected,
            &budget,
            &steps,
        )
        .map_err(|error| format!("orbital contract horizon rejected: {error:#}"))?;
        let fully_consumed = plan.planned_consumed_by_item == budget;
        if fully_consumed {
            low = midpoint;
        } else {
            high = midpoint - 1;
        }
    }
    Ok(low)
}

fn apply_finite_vein_debits(
    state: &mut CoreState,
    certificates: &mut [FiniteVeinCertificate],
    accepted_seconds: i128,
) -> Result<(), String> {
    if accepted_seconds < 0 {
        return Err("finite vein schedule regressed".to_owned());
    }
    for certificate in certificates {
        let units = certificate
            .units_per_second
            .checked_mul(accepted_seconds)
            .ok_or_else(|| {
                format!(
                    "finite vein {} extraction schedule overflowed",
                    certificate.expected.entity_id
                )
            })?;
        if units == 0 {
            continue;
        }
        let current = finite_vein_snapshot_at(state, certificate.expected.entity_index)
            .map_err(|error| {
                format!(
                    "finite vein {} current state is invalid: {error:#}",
                    certificate.expected.entity_id
                )
            })?
            .ok_or_else(|| {
                format!(
                    "finite vein {} is no longer a finite source",
                    certificate.expected.entity_id
                )
            })?;
        if current != certificate.expected {
            return Err(format!(
                "finite vein {} state diverged before debit",
                certificate.expected.entity_id
            ));
        }
        if units > finite_vein_available_units(&current)? {
            return Err(format!(
                "finite vein {} extraction exceeds its remaining reserve",
                current.entity_id
            ));
        }
        let accrued_tenths = current
            .depletion_remainder
            .checked_add(
                units
                    .checked_mul(current.consumption_tenths)
                    .ok_or_else(|| format!("finite vein {} debit overflowed", current.entity_id))?,
            )
            .ok_or_else(|| format!("finite vein {} debit overflowed", current.entity_id))?;
        let depleted = accrued_tenths / 10;
        let next_remaining = current
            .remaining
            .checked_sub(depleted)
            .ok_or_else(|| format!("finite vein {} reserve underflowed", current.entity_id))?;
        let next_remainder = accrued_tenths % 10;
        let mut entity = state.parse_entity(current.entity_index).map_err(|error| {
            format!("finite vein {} decode failed: {error:#}", current.entity_id)
        })?;
        let entity = entity
            .as_object_mut()
            .ok_or_else(|| format!("finite vein {} is not an object", current.entity_id))?;
        entity.insert(
            "resourceRemaining".to_owned(),
            Value::Number(Number::from(i64::try_from(next_remaining).map_err(
                |_| {
                    format!(
                        "finite vein {} reserve cannot be encoded",
                        current.entity_id
                    )
                },
            )?)),
        );
        if current.tracks_depletion_remainder {
            entity.insert(
                "resourceDepletionRemainder".to_owned(),
                Value::Number(Number::from(i64::try_from(next_remainder).map_err(
                    |_| {
                        format!(
                            "finite vein {} remainder cannot be encoded",
                            current.entity_id
                        )
                    },
                )?)),
            );
        } else if next_remainder != 0 {
            return Err(format!(
                "finite fluid vein {} produced a fractional reserve debit",
                current.entity_id
            ));
        }
        state.replace_entity_raw(
            current.entity_index,
            Arc::<str>::from(
                serde_json::to_string(&Value::Object(entity.clone()))
                    .map_err(|error| format!("finite vein encode failed: {error:#}"))?,
            ),
        );
        certificate.expected.remaining = next_remaining;
        certificate.expected.depletion_remainder = next_remainder;
    }
    Ok(())
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
        || certificate.galactic_export.is_some()
        || certificate.orbital_contracts.is_some()
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

#[cfg_attr(not(test), allow(dead_code))]
fn apply_ordinary_flow_certificate(
    state: &mut CoreState,
    certificate: &mut OrdinaryFlowCertificate,
    elapsed_before: f64,
    elapsed_after: f64,
) -> Result<OrdinaryFlowApplication, String> {
    apply_ordinary_flow_certificate_with_wall(
        state,
        certificate,
        elapsed_before,
        elapsed_after,
        0.0,
    )
}

fn apply_ordinary_flow_certificate_with_wall(
    state: &mut CoreState,
    certificate: &mut OrdinaryFlowCertificate,
    elapsed_before: f64,
    elapsed_after: f64,
    wall_tail_seconds: f64,
) -> Result<OrdinaryFlowApplication, String> {
    if certificate.recipe_ids.is_empty()
        && certificate.research.is_none()
        && certificate.dyson_rocket.is_none()
        && certificate.dyson_sail.is_none()
        && certificate.galactic_export.is_none()
        && certificate.orbital_contracts.is_none()
        && certificate.finite_veins.is_empty()
    {
        return apply_source_only_flow_certificate(
            state,
            certificate,
            elapsed_before,
            elapsed_after,
        );
    }
    if let Some(power) = &certificate.renewable_power {
        validate_renewable_power_tail_certificate(state, power)?;
    }
    let before_micros = elapsed_micros(elapsed_before)?;
    let after_micros = elapsed_micros(elapsed_after)?;
    if after_micros < before_micros {
        return Err("elapsed clock regressed during ordinary-flow settlement".to_owned());
    }
    if !wall_tail_seconds.is_finite() || wall_tail_seconds < 0.0 {
        return Err("ordinary-flow wall-clock budget is invalid".to_owned());
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
    let galactic_export = certificate.galactic_export.clone();
    let orbital_contracts = certificate.orbital_contracts.clone();
    let galactic_multiplier_microunits = galactic_export
        .as_ref()
        .map(|_| galactic_multiplier_microunits(state))
        .transpose()?;
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
    if let Some(export) = &galactic_export {
        let current = crate::galactic_exports::capture_certified_pure_idle_export_endpoint(
            state.base_value(),
        )
        .map_err(|error| format!("Galactic export sink state is invalid: {error:#}"))?;
        if current != export.expected {
            return Err(
                "Galactic export sink state diverged from its certified endpoint".to_owned(),
            );
        }
    }
    if let Some(contracts) = &orbital_contracts {
        let current = crate::orbital_station::capture_pure_idle_contract_endpoint(state)
            .map_err(|error| format!("orbital contract sink state is invalid: {error:#}"))?;
        if current != contracts.expected {
            return Err(
                "orbital contract sink state diverged from its certified endpoint".to_owned(),
            );
        }
    }

    let mut accepted_seconds = scheduled_seconds;
    accepted_seconds = accepted_seconds.min(finite_vein_capacity_seconds(state, certificate)?);
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
    if let Some(export) = &galactic_export {
        accepted_seconds = accepted_seconds.min(galactic_export_capacity_seconds(export)?);
        accepted_seconds = accepted_seconds.min(galactic_activity_capacity_seconds(
            export,
            before_micros,
            scheduled_seconds,
            galactic_multiplier_microunits.expect("Galactic terminal owns a validated multiplier"),
        )?);
    }
    if let Some(contracts) = &orbital_contracts {
        accepted_seconds = accepted_seconds.min(orbital_contract_capacity_seconds(
            contracts,
            scheduled_seconds,
        )?);
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
        galactic_export_certified: galactic_export.is_some(),
        orbital_contract_certified: orbital_contracts.is_some(),
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

    // Stateful material terminals consume their fixed shares before the
    // ordinary ledger is written. Every helper operates on an isolated clone
    // and the caller itself owns a disposable CoreState candidate, so any
    // mismatch below discards the whole settlement without advancing cache,
    // revision, production, inventory, or terminal counters.
    if accepted_seconds > 0
        && let Some(contracts) = orbital_contracts
    {
        let (budget, steps) = orbital_contract_schedule(
            &contracts.expected,
            &contracts.requirement_rates,
            accepted_seconds,
        )?;
        let plan = crate::orbital_station::plan_certified_pure_idle_contract_delivery_steps(
            &contracts.expected,
            &budget,
            &steps,
        )
        .map_err(|error| format!("orbital contract plan failed: {error:#}"))?;
        if plan.planned_consumed_by_item != budget
            || !plan.unused_budget_by_item.is_empty()
            || !plan.export_limited_by_item.is_empty()
        {
            return Err(
                "orbital contract plan did not consume its complete whole-second budget".to_owned(),
            );
        }
        let receipt =
            crate::orbital_station::apply_certified_pure_idle_contract_delivery(state, &plan)
                .map_err(|error| format!("orbital contract commit failed: {error:#}"))?;
        if receipt.consumed_by_item != budget
            || !receipt.unused_budget_by_item.is_empty()
            || !receipt.export_limited_by_item.is_empty()
        {
            return Err(
                "orbital contract commit did not consume its complete whole-second budget"
                    .to_owned(),
            );
        }
        application.orbital_contract_delivered = receipt
            .consumed_by_item
            .values()
            .try_fold(0_i128, |total, amount| {
                amount
                    .to_i128()
                    .and_then(|amount| total.checked_add(amount))
            })
            .ok_or_else(|| "orbital contract receipt total overflowed".to_owned())?;
        application.terminal_boundary_limited |= receipt.boundary_limited;
        certificate
            .orbital_contracts
            .as_mut()
            .expect("cloned orbital contract certificate remains installed")
            .expected = receipt.endpoint_after;
    }
    if let Some(export) = galactic_export {
        let budgets = export
            .consumed_units_per_second
            .iter()
            .map(|(item_id, rate)| {
                rate.checked_mul(accepted_seconds)
                    .map(|amount| (item_id.clone(), amount))
                    .ok_or_else(|| format!("Galactic export {item_id} budget overflowed"))
            })
            .collect::<Result<MaterialTotals, _>>()?;
        let (activity_clock_after_ms, last_delivery_at_ms) = galactic_activity_commit_clocks(
            &export,
            accepted_seconds,
            before_micros,
            after_micros,
            galactic_multiplier_microunits.expect("Galactic terminal owns a validated multiplier"),
        )?;
        let receipt = crate::galactic_exports::apply_certified_pure_idle_export_budget(
            state.base_value_mut(),
            &export.expected,
            &budgets,
            activity_clock_after_ms,
            last_delivery_at_ms,
        )
        .map_err(|error| format!("Galactic export commit failed: {error:#}"))?;
        let requested = budgets
            .iter()
            .filter(|(_, amount)| **amount > 0)
            .map(|(item_id, amount)| (item_id.clone(), *amount))
            .collect::<MaterialTotals>();
        if receipt.consumed_by_item != requested || receipt.clipped {
            return Err(
                "Galactic export commit did not consume its complete whole-second budget"
                    .to_owned(),
            );
        }
        application.galactic_exported = receipt
            .consumed_by_item
            .values()
            .try_fold(0_i128, |total, amount| total.checked_add(*amount))
            .ok_or_else(|| "Galactic export receipt total overflowed".to_owned())?;
        application.terminal_boundary_limited |= receipt.boundary_limited;
        certificate
            .galactic_export
            .as_mut()
            .expect("cloned Galactic export certificate remains installed")
            .expected = receipt.endpoint_after;
    }

    {
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
    }
    apply_finite_vein_debits(state, &mut certificate.finite_veins, accepted_seconds)?;
    if let Some(research) = research {
        let base = state.base_value_mut();
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

#[cfg(test)]
fn prove_internal_exact_settlement_candidate(
    before: &SettlementProofSnapshot,
    candidate: CoreState,
) -> Result<CoreState, String> {
    prove_internal_exact_settlement_candidate_with_runtime(
        before,
        candidate,
        deterministic_runtime(),
    )
}

fn prove_internal_exact_settlement_candidate_with_runtime(
    before: &SettlementProofSnapshot,
    candidate: CoreState,
    runtime: &DeterministicRuntime,
) -> Result<CoreState, String> {
    let after =
        capture_exact_settlement_snapshot_with_runtime(&candidate, before.revision, runtime)
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
/// for exclusive vein-source flow backed only by non-fuel power. Infinite and
/// naturally renewable sources require no debit; finite sources carry a
/// per-vein reserve/remainder receipt and stop at the first depletion horizon. A
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
/// Dynamic ray power is admitted only when a runtime-private per-grid proof
/// removes transient orbit sails and still covers the calibrated demand from
/// permanent sphere plus static renewable generation. Stored/fuel energy,
/// incomplete grids and cross-grid pooling are never accepted. A separate
/// bounded handcraft tail may consume only the active tray's real
/// starting stock. It carries an exact per-recipe input/output/queue receipt,
/// never treats cumulative production as inventory, and stops after at most
/// 4,096 remaining batches. A construction-only tail may reuse the exact
/// native construction engine in fixed 30-second blocks, carrying an
/// incomplete block only in the private native checkpoint. It is admitted only
/// for centers on certified permanent-renewable grids and only against real
/// tray or already-reserved quantum-buffer stock. It cannot download new
/// quantum material or extrapolate an ordinary source; every unclosed terminal
/// remains frozen.
pub(crate) fn advance(
    state: &mut CoreState,
    request: &CoreAdvanceRequest,
) -> anyhow::Result<CoreAdvanceResult> {
    advance_bounded_with_runtime(state, request, false, deterministic_runtime())
}

fn offline_ordinary_boundary_requires_exact(
    state: &CoreState,
    certificate: &OrdinaryFlowCertificate,
    elapsed_before: f64,
    elapsed_after: f64,
) -> Result<bool, String> {
    // This correction owns only the ordinary physical factory. Stateful
    // terminals/construction retain their separate certificates and horizons.
    if construction_tail_requested(state)
        || certificate.research.is_some()
        || certificate.dyson_rocket.is_some()
        || certificate.dyson_sail.is_some()
        || certificate.galactic_export.is_some()
        || certificate.orbital_contracts.is_some()
    {
        return Ok(false);
    }
    let before_micros = elapsed_micros(elapsed_before)?;
    let after_micros = elapsed_micros(elapsed_after)?;
    let scheduled_seconds = after_micros / MICROS_PER_SECOND - before_micros / MICROS_PER_SECOND;
    if scheduled_seconds < 0 {
        return Err("offline ordinary boundary clock regressed".to_owned());
    }
    if finite_vein_capacity_seconds(state, certificate)? < scheduled_seconds {
        return Ok(true);
    }
    let quantum = state
        .base_value()
        .get("quantumLogisticsNetwork")
        .and_then(Value::as_object)
        .ok_or_else(|| "quantum logistics network is missing".to_owned())?;
    let inventory = quantum
        .get("inventory")
        .and_then(Value::as_object)
        .ok_or_else(|| "quantum inventory is malformed".to_owned())?;
    let capacities = quantum
        .get("itemCapacities")
        .and_then(Value::as_object)
        .ok_or_else(|| "quantum capacity ledger is malformed".to_owned())?;
    let source_only = certificate.recipe_ids.is_empty() && certificate.finite_veins.is_empty();
    for (item_id, rate) in &certificate.units_per_second {
        if *rate <= 0 {
            continue;
        }
        let amount = if source_only {
            let before = rate
                .checked_mul(before_micros)
                .and_then(|amount| amount.checked_div(MICROS_PER_SECOND))
                .ok_or_else(|| "offline source boundary overflowed".to_owned())?;
            rate.checked_mul(after_micros)
                .and_then(|amount| amount.checked_div(MICROS_PER_SECOND))
                .and_then(|after| after.checked_sub(before))
                .ok_or_else(|| "offline source boundary overflowed".to_owned())?
        } else {
            rate.checked_mul(scheduled_seconds)
                .ok_or_else(|| "offline recipe boundary overflowed".to_owned())?
        };
        let current = proof_counter(
            inventory.get(item_id),
            &format!("quantum inventory.{item_id}"),
        )
        .map_err(|error| error.to_string())?;
        let capacity = capacities
            .get(item_id)
            .map(|value| proof_counter(Some(value), &format!("quantum capacity.{item_id}")))
            .transpose()
            .map_err(|error| error.to_string())?
            .unwrap_or(DEFAULT_QUANTUM_ITEM_CAPACITY);
        if !(10_000..=DEFAULT_QUANTUM_ITEM_CAPACITY).contains(&capacity) {
            return Err(format!(
                "{item_id} quantum capacity is outside the supported range"
            ));
        }
        if amount > capacity.saturating_sub(current) {
            return Ok(true);
        }
    }
    Ok(false)
}

fn offline_boundary_exact_budget(seconds: f64, entity_count: usize, belt_count: usize) -> bool {
    seconds.is_finite()
        && (0.0..=OFFLINE_BOUNDARY_EXACT_MAX_SECONDS).contains(&seconds)
        && (seconds.ceil() as u128)
            .saturating_mul(entity_count.saturating_add(belt_count).max(1) as u128)
            <= OFFLINE_BOUNDARY_EXACT_MAX_WORK
}

/// New wire-distinct macro mode. It retains the deterministic 3x10-second
/// calibration boundary and settles only independently certified domains:
/// source/closed-recipe ordinary flow and its research/Dyson sinks, bounded
/// handcraft, or construction on permanent-renewable grids. Ordinary and
/// construction ledgers may compose only through a private, at-most-thirty-
/// second quantum replay whose five-second releases are checkpointed and
/// material-conservative. Every domain without its own closed receipt freezes.
pub(crate) fn advance_macro_v10(
    state: &mut CoreState,
    request: &CoreAdvanceRequest,
) -> anyhow::Result<CoreAdvanceResult> {
    advance_bounded_with_runtime(state, request, true, deterministic_runtime())
}

/// One-shot desktop offline settlement. It shares MacroV10's closed material
/// ledger and bounded 3x10-second exact calibration, but it runs at 1x wall
/// time with time warp disabled and deliberately persists no time-warp session
/// credit or runtime certificate.
pub(crate) fn advance_offline_macro_v1(
    state: &mut CoreState,
    request: &CoreAdvanceRequest,
) -> anyhow::Result<CoreAdvanceResult> {
    advance_bounded_with_runtime(state, request, true, deterministic_runtime())
}

fn advance_bounded_with_runtime(
    state: &mut CoreState,
    request: &CoreAdvanceRequest,
    macro_v10: bool,
    deterministic_runtime: &DeterministicRuntime,
) -> anyhow::Result<CoreAdvanceResult> {
    let offline_macro = request.advance_mode == CoreAdvanceMode::OfflineMacroV1;
    let sessioned_macro = macro_v10 && !offline_macro;
    #[cfg(test)]
    let _macro_v10_test_guard = macro_v10.then(macro_v10_test_guard);

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
    let settlement_before =
        match capture_settlement_snapshot_with_runtime(state, deterministic_runtime) {
            Ok(snapshot) => snapshot,
            Err(error) => {
                return unsupported(
                    state,
                    request,
                    format!("pure-idle-settlement-proof-baseline-invalid: {error:#}"),
                );
            }
        };

    let exact_seconds_used_before = if sessioned_macro {
        state.pure_idle_macro_exact_seconds_used()
    } else if offline_macro {
        0.0
    } else {
        state.pure_idle_exact_seconds_used()
    };
    let mut construction_carry_seconds = if sessioned_macro {
        state.pure_idle_macro_construction_carry_seconds()
    } else {
        0
    };
    let mut construction_quantum_replay_remaining_seconds = if sessioned_macro {
        state.pure_idle_macro_construction_quantum_replay_remaining_seconds()
    } else if offline_macro {
        PURE_IDLE_MACRO_CONSTRUCTION_QUANTUM_REPLAY_SECONDS
    } else {
        0
    };
    let mut construction_quantum_pending_credits = if sessioned_macro {
        state
            .pure_idle_macro_construction_quantum_pending_credits()
            .into_iter()
            .map(|(item_id, amount)| (item_id, i128::from(amount)))
            .collect::<MaterialTotals>()
    } else {
        MaterialTotals::new()
    };
    let mut macro_runtime = macro_v10.then(|| {
        if offline_macro {
            PureIdleMacroRuntimeCache::starts_at(state.revision, settlement_before.clone())
        } else {
            state
                .pure_idle_macro_runtime
                .as_ref()
                .filter(|runtime| runtime.last_committed_revision == state.revision)
                .cloned()
                .unwrap_or_else(|| {
                    if exact_seconds_used_before <= EPSILON {
                        PureIdleMacroRuntimeCache::starts_at(
                            state.revision,
                            settlement_before.clone(),
                        )
                    } else {
                        PureIdleMacroRuntimeCache::missing_prefix(state.revision)
                    }
                })
        }
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
            let exact_base_revision = candidate.revision;
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
                    let receipt_base_revision = macro_runtime
                        .as_ref()
                        .and_then(|runtime| runtime.calibration_snapshots.last())
                        .map(|snapshot| snapshot.revision)
                        .unwrap_or(exact_base_revision);
                    let snapshot = match capture_exact_settlement_snapshot_with_runtime(
                        &candidate,
                        receipt_base_revision,
                        deterministic_runtime,
                    ) {
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
        && (runtime.certificate.is_none()
            || construction_tail_requested(&candidate)
                && runtime.construction_certificate.is_none())
    {
        let construction_requested = construction_tail_requested(&candidate);
        let construction_snapshots = if runtime.calibration_snapshots.len() == 4 {
            Ok(runtime.calibration_snapshots.clone())
        } else {
            exact_three_window_probe(&candidate, request)
        };
        // Construction is an independent material consumer. Its exact
        // calibration still competes for power, but its mutable inventory,
        // jobs and outputs must not suppress or contaminate the ordinary
        // production certificate. A disposable isolated probe keeps the
        // center power demand in the grid plan while skipping only the
        // construction mutation.
        let ordinary_snapshots = if construction_requested {
            exact_three_window_probe_isolating_construction(&candidate, request)
        } else {
            construction_snapshots.clone()
        };
        if runtime.certificate.is_none() {
            match ordinary_snapshots {
                Ok(snapshots) => match prepare_ordinary_flow_certificate_with_runtime(
                    &candidate,
                    &snapshots,
                    deterministic_runtime,
                )
                .result
                {
                    Ok(certificate) => {
                        runtime.certificate = Some(certificate);
                        runtime.rejection_reason = None;
                    }
                    Err(reason) => {
                        runtime.certificate = None;
                        runtime.rejection_reason = Some(reason);
                    }
                },
                Err(reason) => {
                    runtime.certificate = None;
                    runtime.rejection_reason = Some(reason);
                }
            }
        }
        if construction_requested && runtime.construction_certificate.is_none() {
            match construction_snapshots {
                Ok(snapshots) => {
                    match prepare_construction_tail_certificate_with_runtime(
                        &candidate,
                        &snapshots,
                        deterministic_runtime,
                    )
                    .result
                    {
                        Ok(certificate) => {
                            runtime.construction_certificate = certificate;
                            runtime.construction_rejection_reason = None;
                        }
                        Err(reason) => {
                            runtime.construction_certificate = None;
                            runtime.construction_rejection_reason = Some(reason);
                        }
                    }
                }
                Err(reason) => {
                    runtime.construction_certificate = None;
                    runtime.construction_rejection_reason = Some(reason);
                }
            }
        }
    }

    let tail_seconds = budget.frozen_tail_seconds;
    let mut boundary_exact_seconds = 0.0;
    let mut tail_reason = None;
    if tail_seconds > EPSILON {
        let current_elapsed = candidate
            .base_value()
            .get("elapsedSeconds")
            .and_then(Value::as_f64)
            .unwrap_or(0.0);
        let elapsed = checked_elapsed_after_prefix(current_elapsed, tail_seconds)?;
        let mut offline_export_progress = None;
        let construction_isolated_receipt_base_revision = candidate.revision;
        let mut handcraft_handled_tail = false;
        if macro_v10 && collection_has_entries(candidate.base_value().get("handcraftQueue")) {
            handcraft_handled_tail = true;
            match apply_bounded_handcraft_tail(&mut candidate, tail_seconds) {
                Ok(BoundedHandcraftTailOutcome::Inactive) => {
                    handcraft_handled_tail = false;
                }
                Ok(BoundedHandcraftTailOutcome::Frozen(reason)) => {
                    tail_reason = Some(format!(
                        "bounded handcraft tail froze before touching material: {reason}; ordinary production, construction, export, contract and Dyson tails remained frozen"
                    ));
                }
                Ok(BoundedHandcraftTailOutcome::Applied(application)) => {
                    tail_reason = Some(if application.changed {
                        format!(
                            "bounded handcraft tail completed {} certified batch(es), debited {} real input unit(s), produced {} catalog output unit(s), and left {} queued batch(es); ordinary production, construction, export, contract and Dyson tails remained frozen{}",
                            application.completed_batches,
                            application.input_units_debited,
                            application.output_units_produced,
                            application.remaining_batches,
                            if application.stopped_at_horizon {
                                " at the proven inventory/output/planet horizon"
                            } else {
                                ""
                            }
                        )
                    } else {
                        format!(
                            "bounded handcraft tail reached its proven inventory/output/planet horizon with {} queued batch(es); no material changed and every other material-bearing tail remained frozen",
                            application.remaining_batches
                        )
                    });
                }
                Err(reason) => {
                    return unsupported(
                        state,
                        request,
                        format!("pure-idle-bounded-handcraft-rejected: {reason}"),
                    );
                }
            }
        }
        if !handcraft_handled_tail && let Some(runtime) = macro_runtime.as_mut() {
            let construction_quantum_granted = runtime
                .construction_certificate
                .as_ref()
                .and_then(|certificate| certificate.quantum.as_ref())
                .is_some();
            let mut allow_construction_quantum_replay =
                construction_quantum_granted && construction_quantum_replay_remaining_seconds > 0;
            let mut construction_quantum_credit_rates = MaterialTotals::new();
            let boundary_exact = if offline_macro && runtime.construction_certificate.is_none() {
                match runtime
                    .certificate
                    .as_ref()
                    .map(|certificate| {
                        offline_ordinary_boundary_requires_exact(
                            &candidate,
                            certificate,
                            current_elapsed,
                            elapsed,
                        )
                    })
                    .transpose()
                {
                    Ok(required) => required.unwrap_or(false),
                    Err(reason) => {
                        return unsupported(
                            state,
                            request,
                            format!("offline-boundary-proof-rejected: {reason}"),
                        );
                    }
                }
            } else {
                false
            };
            if boundary_exact {
                if !offline_boundary_exact_budget(
                    request.simulation_seconds,
                    candidate.entity_index.len(),
                    candidate.belt_index.len(),
                ) {
                    return unsupported(
                        state,
                        request,
                        "offline-boundary-exact-work-budget-exceeded",
                    );
                }
                // No macro material write has occurred. Continue from the real
                // prefix with Exact, so existing machine/station buffers and
                // in-flight recipe progress are consumed once at their actual
                // boundaries. Never append exact steps to an extrapolated phase.
                let mut exact = candidate.advance_exact(&exact_request(
                    candidate.revision,
                    tail_seconds,
                    budget.frozen_tail_wall_seconds,
                ))?;
                if !exact.supported {
                    return unsupported(
                        state,
                        request,
                        exact
                            .reason
                            .take()
                            .unwrap_or_else(|| "offline-boundary-exact-unsupported".to_owned()),
                    );
                }
                exact_changed |= exact.changed;
                if exact.belt_scheduler.is_some() {
                    belt_scheduler = exact.belt_scheduler.take();
                }
                boundary_exact_seconds = tail_seconds;
                tail_reason = Some("ordinary capacity or finite-reserve horizon required bounded exact fallback from the real prefix; physical buffers and in-progress production settled without macro extrapolation".to_owned());
            } else if let Some(certificate) = runtime.certificate.as_mut() {
                if offline_macro && current_elapsed.fract() != 0.0 {
                    return unsupported(
                        state,
                        request,
                        "offline-ordinary-macro-source-clock-unsupported",
                    );
                }
                if offline_macro && certificate.galactic_export.is_none() {
                    offline_export_progress = Some(
                        match crate::simulation::capture_offline_no_export_progress(&candidate) {
                            Ok(progress) => progress,
                            Err(reason) => {
                                return unsupported(
                                    state,
                                    request,
                                    format!("offline-export-window-proof-rejected: {reason}"),
                                );
                            }
                        },
                    );
                }
                let quantum_inventory_before = if allow_construction_quantum_replay {
                    match capture_construction_quantum_inventory(candidate.base_value()) {
                        Ok(inventory) => Some(inventory),
                        Err(reason) => {
                            return unsupported(
                                state,
                                request,
                                format!("pure-idle-construction-quantum-credit-rejected: {reason}"),
                            );
                        }
                    }
                } else {
                    None
                };
                let ordinary_application = match apply_ordinary_flow_certificate_with_wall(
                    &mut candidate,
                    certificate,
                    current_elapsed,
                    elapsed,
                    budget.frozen_tail_wall_seconds,
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
                if let Some(quantum_inventory_before) = quantum_inventory_before {
                    let quantum_inventory_after =
                        match capture_construction_quantum_inventory(candidate.base_value()) {
                            Ok(inventory) => inventory,
                            Err(reason) => {
                                return unsupported(
                                    state,
                                    request,
                                    format!(
                                        "pure-idle-construction-quantum-credit-rejected: {reason}"
                                    ),
                                );
                            }
                        };
                    if ordinary_application.capacity_limited {
                        // A construction download can reopen quantum capacity.
                        // Crediting an entire long ordinary tail before that
                        // download would make one-shot and segmented calls see
                        // different production horizons. Fail closed for the
                        // bounded replay while keeping the already-proven
                        // ordinary credit and all local construction stock.
                        allow_construction_quantum_replay = false;
                        construction_quantum_replay_remaining_seconds = 0;
                        construction_quantum_pending_credits.clear();
                    } else if let Err(reason) = merge_construction_quantum_pending_credits(
                        &mut construction_quantum_pending_credits,
                        &quantum_inventory_before,
                        &quantum_inventory_after,
                    ) {
                        return unsupported(
                            state,
                            request,
                            format!("pure-idle-construction-quantum-credit-rejected: {reason}"),
                        );
                    }
                    construction_quantum_credit_rates = certificate.units_per_second.clone();
                }
                tail_reason = Some(
                    if ordinary_application.deposited_units > 0
                        || ordinary_application.rockets_launched > 0
                        || ordinary_application.sails_launched > 0
                        || ordinary_application.galactic_exported > 0
                        || ordinary_application.orbital_contract_delivered > 0
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
                        let terminal_scope = match (
                            ordinary_application.galactic_export_certified,
                            ordinary_application.orbital_contract_certified,
                        ) {
                            (true, true) => format!(
                                " {} unit(s) entered the certified galactic export and {} unit(s) entered fixed orbital contract requirements;",
                                ordinary_application.galactic_exported,
                                ordinary_application.orbital_contract_delivered,
                            ),
                            (true, false) => format!(
                                " {} unit(s) entered the certified galactic export; orbital contract delivery remained frozen;",
                                ordinary_application.galactic_exported,
                            ),
                            (false, true) => format!(
                                " {} unit(s) entered fixed certified orbital contract requirements; galactic export remained frozen;",
                                ordinary_application.orbital_contract_delivered,
                            ),
                            (false, false) => {
                                " galactic export and orbital contract delivery remained frozen;"
                                    .to_owned()
                            }
                        };
                        format!(
                            "certified {} {scope} item(s) deposited {} net unit(s) into bounded quantum inventory from {} gross production and {} internal consumption;{dyson_scope}{research_scope}{terminal_scope} construction remained frozen{}{}",
                            ordinary_application.certified_items,
                            ordinary_application.deposited_units,
                            ordinary_application.produced_units,
                            ordinary_application.consumed_units,
                            if ordinary_application.capacity_limited {
                                " at the proven capacity horizon"
                            } else {
                                ""
                            },
                            if ordinary_application.terminal_boundary_limited {
                                " before the certified terminal boundary"
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
                if offline_macro && runtime.construction_certificate.is_none() {
                    return unsupported(
                        state,
                        request,
                        format!(
                            "offline-ordinary-tail-uncertified: {}",
                            runtime
                                .rejection_reason
                                .as_deref()
                                .unwrap_or("calibration was incomplete"),
                        ),
                    );
                }
                tail_reason = Some(format!(
                    "ordinary-flow tail froze because no closed three-window certificate was available: {}",
                    runtime
                        .rejection_reason
                        .as_deref()
                        .unwrap_or("calibration was incomplete")
                ));
            }

            if let Some(certificate) = runtime.construction_certificate.as_ref() {
                let construction_application = match apply_construction_tail_certificate(
                    &mut candidate,
                    certificate,
                    ConstructionTailApplicationRequest {
                        elapsed_before: current_elapsed,
                        elapsed_after: elapsed,
                        isolated_receipt_base_revision: construction_isolated_receipt_base_revision,
                        carry_seconds: construction_carry_seconds,
                        quantum_replay_remaining_seconds:
                            construction_quantum_replay_remaining_seconds,
                        quantum_pending_credits: construction_quantum_pending_credits.clone(),
                        quantum_credit_rates: &construction_quantum_credit_rates,
                        allow_quantum_replay: allow_construction_quantum_replay,
                    },
                    deterministic_runtime,
                ) {
                    Ok(application) => application,
                    Err(reason) => {
                        return unsupported(
                            state,
                            request,
                            format!("pure-idle-construction-tail-rejected: {reason}"),
                        );
                    }
                };
                construction_carry_seconds = construction_application.carry_seconds;
                construction_quantum_replay_remaining_seconds =
                    construction_application.quantum_replay_remaining_seconds;
                construction_quantum_pending_credits =
                    construction_application.quantum_pending_credits;
                let construction_reason = if construction_application.crafted > 0 {
                    format!(
                        "construction-only tail spent real owned inventory and completed {} item(s) in canonical 30-second block(s); {} second(s) remain below the next block, {} real quantum-network unit(s) were downloaded within the bounded replay, {} replay second(s) remain, and no material source was extrapolated",
                        construction_application.crafted,
                        construction_application.carry_seconds,
                        construction_application.quantum_downloaded,
                        construction_application.quantum_replay_remaining_seconds,
                    )
                } else if construction_application.carry_seconds > 0 {
                    format!(
                        "construction-only tail retained {} second(s) below the next canonical 30-second block; it neither debited material nor minted output",
                        construction_application.carry_seconds,
                    )
                } else {
                    "construction-only tail reached its real inventory/target horizon at a canonical 30-second boundary without manufacturing an item"
                        .to_owned()
                };
                tail_reason = Some(match tail_reason.take() {
                    Some(reason) => format!("{reason}; {construction_reason}"),
                    None => construction_reason,
                });
            } else if construction_tail_requested(&candidate) {
                let construction_reason = format!(
                    "construction tail froze because no renewable power certificate was available: {}",
                    runtime
                        .construction_rejection_reason
                        .as_deref()
                        .unwrap_or("calibration was incomplete"),
                );
                tail_reason = Some(match tail_reason.take() {
                    Some(reason) => format!("{reason}; {construction_reason}"),
                    None => construction_reason,
                });
            }
        }
        if let Some(progress) = offline_export_progress
            && let Err(reason) = crate::simulation::advance_offline_no_export_progress(
                &mut candidate,
                &progress,
                tail_seconds,
                request.simulation_seconds,
            )
        {
            return unsupported(
                state,
                request,
                format!("offline-export-window-proof-rejected: {reason}"),
            );
        }
        if boundary_exact_seconds <= EPSILON {
            candidate.base_value_mut().insert(
                "elapsedSeconds".to_owned(),
                Value::Number(
                    Number::from_f64(elapsed)
                        .ok_or_else(|| anyhow!("native pure-idle elapsed time encode failed"))?,
                ),
            );
        }
    }

    let changed = exact_changed || tail_seconds > EPSILON;
    if tail_seconds > EPSILON && candidate.revision == state.revision {
        candidate.revision = candidate
            .revision
            .checked_add(1)
            .ok_or_else(|| anyhow!("native core revision exhausted"))?;
    }
    let mut candidate = match prove_internal_exact_settlement_candidate_with_runtime(
        &settlement_before,
        candidate,
        deterministic_runtime,
    ) {
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
        if sessioned_macro {
            let construction_quantum_pending_credits = construction_quantum_pending_credits
                .into_iter()
                .map(|(item_id, amount)| {
                    u64::try_from(amount)
                        .map(|amount| (item_id.clone(), amount))
                        .map_err(|_| {
                            anyhow!(
                                "construction quantum pending credit for {item_id} cannot be checkpointed"
                            )
                        })
                })
                .collect::<anyhow::Result<BTreeMap<_, _>>>()?;
            candidate.install_pure_idle_macro_session_progress_with_construction_state(
                exact_progress,
                construction_carry_seconds,
                construction_quantum_replay_remaining_seconds,
                construction_quantum_pending_credits,
            )?;
        } else if !offline_macro {
            candidate.install_pure_idle_session_progress(exact_progress)?;
        }
    }

    if offline_macro {
        candidate.clear_pure_idle_private_session();
    } else if sessioned_macro && let Some(mut runtime) = macro_runtime {
        runtime.last_committed_revision = candidate.revision;
        candidate.pure_idle_macro_runtime = Some(runtime);
    } else {
        candidate.pure_idle_macro_runtime = None;
    }

    if tail_seconds > EPSILON {
        // Macro/tail settlement writes entity runtime fields outside the exact
        // simple-factory writer protocol. Keep the disposable candidate
        // fail-closed and publish a cold planet-metric cache state.
        candidate.invalidate_prepared_planet_metrics_runtime();
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
        exact_scope: if boundary_exact_seconds > EPSILON {
            "offline-boundary-exact"
        } else if tail_seconds > EPSILON && offline_macro {
            "offline-macro-v1"
        } else if tail_seconds > EPSILON && macro_v10 {
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
        exact_calibration_seconds: Some(exact_seconds + boundary_exact_seconds),
        approximated_seconds: Some((tail_seconds - boundary_exact_seconds).max(0.0)),
        belt_scheduler,
        summary,
    })
}

#[cfg(test)]
mod tests {
    use std::collections::{BTreeMap, HashMap};

    use serde_json::{Map, json};
    use sha2::{Digest, Sha256};

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
                    BuildingDefinition {
                        id: "ray_receiver".into(),
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
                        id: "galactic_material_exporter".into(),
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
                        id: "orbital_cargo_terminal".into(),
                        kind: "storage".into(),
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
                    RecipeDefinition {
                        id: "ray_power".into(),
                        name: "ray_power".into(),
                        building_id: "ray_receiver".into(),
                        duration: 1.0,
                        required_tech_id: None,
                        recursive_priority: 0.0,
                        recursive_manufacturing: false,
                        inputs: Vec::new(),
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

    fn bounded_handcraft_macro_fixture(
        multiplier: f64,
        batches: i64,
        iron_ore_stock: i64,
    ) -> CoreState {
        let mut state = productive_powered_fixture(multiplier, "infinite");
        state.base_value_mut()["tray"] = json!({ "iron_ore": iron_ore_stock });
        state.base_value_mut()["planetTrays"]["home"] = json!({ "iron_ore": iron_ore_stock });
        state.base_value_mut()["handcraftQueue"] = json!([{
            "id": "handcraft-iron-ingot",
            "recipeId": "iron_ingot",
            "batchesTotal": batches,
            "batchesRemaining": batches,
            "progress": 0,
            "queuedAt": 1,
            "planetId": "home"
        }]);
        state
    }

    fn productive_single_recipe_macro_fixture(
        multiplier: f64,
        recipe_id: &str,
        output_item_id: &str,
        include_sail_launcher: bool,
        include_ray_power: bool,
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
        if include_ray_power {
            entities.push(json!({
                "id": "ray-power",
                "kind": "machine",
                "planetId": "home",
                "powerGridId": "grid-a",
                "buildingId": "ray_receiver",
                "recipeId": "ray_power",
                "machineCount": 1,
                "minerCount": 0,
                "inputs": {},
                "outputs": {},
                "progress": 0,
                "routingCursor": 0,
                "utilization": 0,
                "productionRate": 0,
                "powerOutputKw": 0
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
        productive_single_recipe_macro_fixture(multiplier, "iron_ingot", "iron_ingot", false, false)
    }

    fn with_quantum_upload_station(source: CoreState, item_id: &str, source_id: &str) -> CoreState {
        let mut entities = source.parse_entities_parallel().unwrap();
        entities.push(json!({
            "id": "quantum-upload", "kind": "station", "planetId": "home",
            "powerGridId": "grid-a", "buildingId": "interstellar_logistics_station",
            "stationTier": 2, "quantumMode": "quantum", "machineCount": 1,
            "stationSlots": [{
                "itemId": item_id, "localMode": "storage", "remoteMode": "supply",
                "minimumLoad": 0.1, "minStock": 0, "maxStock": 1000000,
                "priority": 1, "routePolicy": "direct", "warperBudget": 0
            }],
            "stationRoutes": [], "stationDrones": 0, "stationVessels": 0,
            "stationWarpEnabled": false, "stationWarpers": 0,
            "stationDispatchCursor": 0, "stationLastSupplyPeerBySlot": {},
            "stationProgress": 0, "stationCongestion": 0, "stationTrips": 0,
            "stationLastTransfer": 0, "inputs": { item_id: 0 }, "outputs": { item_id: 0 },
            "progress": 0, "routingCursor": 0, "utilization": 0, "productionRate": 0
        }));
        entities.last_mut().unwrap()["stationSlots"]
            .as_array_mut()
            .unwrap()
            .extend((0..4).map(|_| {
                json!({
                    "itemId": null, "localMode": "storage", "remoteMode": "storage",
                    "minimumLoad": 0.1, "minStock": 0, "maxStock": 1000000,
                    "priority": 1, "routePolicy": "direct", "warperBudget": 0
                })
            }));
        let mut belts = source.parse_belts_parallel().unwrap();
        belts.push(json!({
            "id": "quantum-upload-feed", "planetId": "home", "source": source_id,
            "target": "quantum-upload", "itemId": item_id, "lanes": 1, "tier": 1,
            "priority": 1, "progress": 0, "lastFlow": 0, "totalTransferred": 0
        }));
        let mut catalog = source.catalog.snapshot.clone();
        catalog.buildings.push(BuildingDefinition {
            id: "interstellar_logistics_station".to_owned(),
            kind: "station".to_owned(),
            speed: 1.0,
            input_capacity: 1_000_000.0,
            output_capacity: 1_000_000.0,
            power_demand_kw: 0.0,
            power_generation_kw: 0.0,
            power_charge_kw: 0.0,
            energy_capacity_mj: 0.0,
            fuel_item_ids: Vec::new(),
            fuel_efficiency: 1.0,
            family: None,
            accepts: None,
        });
        let catalog = RuntimeCatalog::validate(catalog, "pure-idle-test").unwrap();
        fixture_state_from_parts_with_belts_and_catalog(
            Value::Object(source.base_value().clone()),
            entities,
            belts,
            catalog,
        )
    }

    #[test]
    fn quantum_upload_is_a_transfer_endpoint_for_source_and_recipe_certificates() {
        for (item_id, source_id, source) in [
            (
                "iron_ore",
                "vein",
                productive_quantum_macro_fixture(1.0, "infinite"),
            ),
            (
                "iron_ingot",
                "smelter",
                productive_closed_recipe_macro_fixture(1.0),
            ),
        ] {
            let mut state = with_quantum_upload_station(source, item_id, source_id);
            let revision = state.revision;
            let warmup = state
                .advance_exact(&exact_request(revision, 30.0, 30.0))
                .unwrap();
            assert!(warmup.supported, "{:?}", warmup.reason);
            let request = offline_macro_request(state.revision, 600.0);
            let snapshots = exact_three_window_probe(&state, &request).unwrap();
            let certificate = build_ordinary_flow_certificate(&state, &snapshots)
                .unwrap_or_else(|reason| panic!("{item_id}: {reason}"));
            assert!(
                certificate
                    .produced_units_per_second
                    .get(item_id)
                    .copied()
                    .unwrap_or(0)
                    > 0
            );
        }
    }

    #[test]
    fn offline_macro_quantum_upload_matches_exact_materials_and_repeated_hash() {
        for resource_mode in ["infinite", "finite"] {
            for prefilled in [0, 250] {
                let mut initial = with_quantum_upload_station(
                    as_offline_fixture(productive_closed_recipe_macro_fixture(1.0)),
                    "iron_ingot",
                    "smelter",
                );
                initial.base_value_mut()["settings"]["resourceMode"] = json!(resource_mode);
                let mut tower = initial.parse_entity(4).unwrap();
                tower["outputs"]["iron_ingot"] = json!(prefilled);
                initial.replace_entity_raw(4, serde_json::to_string(&tower).unwrap().into());
                initial.rebuild_indexes().unwrap();
                let revision = initial.revision;
                let warmup = initial
                    .advance_exact(&exact_request(revision, 30.0, 30.0))
                    .unwrap();
                assert!(warmup.supported, "{:?}", warmup.reason);

                let mut exact = initial.clone();
                for _ in 0..60 {
                    let revision = exact.revision;
                    let result = exact
                        .advance_exact(&exact_request(revision, 10.0, 10.0))
                        .unwrap();
                    assert!(result.supported, "{:?}", result.reason);
                }
                let mut long = initial.clone();
                let revision = long.revision;
                let result =
                    advance_macro_v10(&mut long, &offline_macro_request(revision, 600.0)).unwrap();
                assert!(result.supported, "{:?}", result.reason);
                assert!(
                    !result
                        .reason
                        .as_deref()
                        .is_some_and(|reason| reason.contains("ordinary-flow tail froze")),
                    "{:?}",
                    result.reason
                );
                let exact_materials = capture_settlement_snapshot(&exact).unwrap();
                let long_materials = capture_settlement_snapshot(&long).unwrap();
                assert_eq!(
                    long_materials.produced, exact_materials.produced,
                    "{resource_mode} prefill={prefilled}"
                );
                assert_eq!(
                    long_materials.owned, exact_materials.owned,
                    "{resource_mode} prefill={prefilled}"
                );
                assert_eq!(long_materials.consumed, exact_materials.consumed);
                assert_eq!(long_materials.granted, exact_materials.granted);
                assert_eq!(long_materials.finite_veins, exact_materials.finite_veins);

                // OfflineMacroV1 is deliberately one-shot: each call owns a
                // fresh exact prefix. Repeat the same call for deterministic
                // state identity; sessioned macro split identity is separate.
                let mut repeated = initial;
                let revision = repeated.revision;
                assert!(
                    advance_macro_v10(&mut repeated, &offline_macro_request(revision, 600.0))
                        .unwrap()
                        .supported
                );
                assert_eq!(
                    repeated.summary().unwrap().canonical_sha256,
                    long.summary().unwrap().canonical_sha256,
                    "{resource_mode} prefill={prefilled}"
                );
            }
        }
    }

    #[test]
    fn quantum_upload_recognition_preserves_unknown_producer_and_mixed_route_rejections() {
        let state = with_quantum_upload_station(
            productive_closed_recipe_macro_fixture(1.0),
            "iron_ingot",
            "smelter",
        );
        let tower = state.parse_entity(4).unwrap();
        assert!(is_ordinary_quantum_upload_endpoint(&state, &tower));
        for (field, value) in [
            ("kind", json!("machine")),
            ("buildingId", json!("storage_mk1")),
            ("quantumMode", json!("legacy")),
            ("stationTier", json!(1)),
            ("recipeId", json!("iron_ingot")),
            (
                "stationRoutes",
                json!([{ "itemId": "iron_ingot", "amount": 100 }]),
            ),
            ("stationDrones", json!(1)),
            ("stationVessels", json!(1)),
            ("stationModeTransition", json!({ "target": "quantum" })),
            ("outputs", json!({ "iron_ingot": 0, "magnet": 0 })),
        ] {
            let mut changed = state.clone();
            let mut entity = tower.clone();
            entity[field] = value;
            assert!(
                !is_ordinary_quantum_upload_endpoint(&changed, &entity),
                "{field}"
            );
            changed.replace_entity_raw(4, serde_json::to_string(&entity).unwrap().into());
            changed.rebuild_indexes().unwrap();
            let hash = changed.summary().unwrap().canonical_sha256;
            assert!(
                active_ordinary_recipe_ids(&changed, false, false, false, false, false).is_err(),
                "{field}"
            );
            assert_eq!(changed.summary().unwrap().canonical_sha256, hash);
        }
        for (field, mode) in [("remoteMode", "demand"), ("localMode", "supply")] {
            let mut mixed = tower.clone();
            mixed["stationSlots"][0][field] = json!(mode);
            assert!(
                !is_ordinary_quantum_upload_endpoint(&state, &mixed),
                "{field}"
            );
        }
        let ore_state = with_quantum_upload_station(
            productive_quantum_macro_fixture(1.0, "infinite"),
            "iron_ore",
            "vein",
        );
        assert!(
            exclusive_vein_sources(&ore_state)
                .unwrap()
                .contains("iron_ore")
        );
        let mut alternate = ore_state;
        let mut entity = alternate.parse_entity(3).unwrap();
        entity["kind"] = json!("machine");
        alternate.replace_entity_raw(3, serde_json::to_string(&entity).unwrap().into());
        alternate.rebuild_indexes().unwrap();
        assert!(exclusive_vein_sources(&alternate).is_err());
    }

    #[test]
    fn offline_macro_quantum_upload_does_not_replay_prefilled_material_without_live_sources() {
        let mut initial = with_quantum_upload_station(
            as_offline_fixture(productive_closed_recipe_macro_fixture(1.0)),
            "iron_ingot",
            "smelter",
        );
        for index in [2, 3, 4] {
            let mut entity = initial.parse_entity(index).unwrap();
            if index == 2 {
                entity["minerCount"] = json!(0);
            }
            if index == 3 {
                entity["inputs"]["iron_ore"] = json!(10000);
            }
            if index == 4 {
                entity["outputs"]["iron_ingot"] = json!(10000);
            }
            initial.replace_entity_raw(index, serde_json::to_string(&entity).unwrap().into());
        }
        initial.rebuild_indexes().unwrap();
        let before = initial.summary().unwrap().canonical_sha256;
        let mut long = initial;
        let revision = long.revision;
        let result = advance_macro_v10(&mut long, &offline_macro_request(revision, 600.0)).unwrap();
        assert!(!result.supported);
        assert!(
            result
                .reason
                .as_deref()
                .is_some_and(|reason| reason.contains("offline-ordinary-tail-uncertified")),
            "{:?}",
            result.reason
        );
        assert_eq!(long.summary().unwrap().canonical_sha256, before);
    }

    #[test]
    fn offline_macro_quantum_upload_preserves_capacity_and_finite_reserve_horizons() {
        for bounded_inventory in [true, false] {
            let mut initial = with_quantum_upload_station(
                as_offline_fixture(productive_closed_recipe_macro_fixture(1.0)),
                "iron_ingot",
                "smelter",
            );
            let revision = initial.revision;
            assert!(
                initial
                    .advance_exact(&exact_request(revision, 30.0, 30.0))
                    .unwrap()
                    .supported
            );
            if bounded_inventory {
                initial.base_value_mut()["quantumLogisticsNetwork"]["inventory"]["iron_ingot"] =
                    json!("9967");
                initial.base_value_mut()["quantumLogisticsNetwork"]["itemCapacities"]["iron_ingot"] =
                    json!("10000");
            } else {
                initial.base_value_mut()["settings"]["resourceMode"] = json!("finite");
                let mut vein = initial.parse_entity(2).unwrap();
                vein["resourceRemaining"] = json!(120);
                vein["resourceDepletionRemainder"] = json!(0);
                initial.replace_entity_raw(2, serde_json::to_string(&vein).unwrap().into());
                initial.rebuild_indexes().unwrap();
            }
            let before = capture_settlement_snapshot(&initial).unwrap();
            let mut oracle = initial.clone();
            let revision = oracle.revision;
            assert!(
                oracle
                    .advance_exact(&exact_request(revision, 600.0, 600.0))
                    .unwrap()
                    .supported
            );
            let mut prefix = initial.clone();
            let revision = prefix.revision;
            assert!(
                advance_macro_v10(&mut prefix, &offline_macro_request(revision, 30.0))
                    .unwrap()
                    .supported
            );
            let mut long = initial.clone();
            let revision = long.revision;
            let result =
                advance_macro_v10(&mut long, &offline_macro_request(revision, 600.0)).unwrap();
            assert!(result.supported, "{:?}", result.reason);
            assert!(
                result
                    .reason
                    .as_deref()
                    .is_some_and(|reason| reason.contains("horizon")),
                "{:?}",
                result.reason
            );
            let long_snapshot = capture_settlement_snapshot(&long).unwrap();
            assert_eq!(result.exact_scope, "offline-boundary-exact");
            assert_eq!(result.exact_calibration_seconds, Some(600.0));
            assert_eq!(result.approximated_seconds, Some(0.0));
            assert_eq!(
                result.algorithm_version,
                Some(OFFLINE_MACRO_V1_ALGORITHM_VERSION)
            );
            assert_eq!(
                long.summary().unwrap().canonical_sha256,
                oracle.summary().unwrap().canonical_sha256
            );
            let mut repeated = initial;
            let revision = repeated.revision;
            assert!(
                advance_macro_v10(&mut repeated, &offline_macro_request(revision, 600.0))
                    .unwrap()
                    .supported
            );
            assert_eq!(
                long.summary().unwrap().canonical_sha256,
                repeated.summary().unwrap().canonical_sha256
            );
            if bounded_inventory {
                assert_eq!(
                    long.base_value()["quantumLogisticsNetwork"]["inventory"]["iron_ingot"],
                    long.base_value()["quantumLogisticsNetwork"]["itemCapacities"]["iron_ingot"]
                );
                assert!(
                    long_snapshot.produced["iron_ingot"]
                        > capture_settlement_snapshot(&prefix).unwrap().produced["iron_ingot"] + 3
                );
            } else {
                assert_eq!(
                    long_snapshot.produced["iron_ore"] - before.produced["iron_ore"],
                    120
                );
                assert_eq!(
                    number_at(Some(&long.parse_entity(2).unwrap()), &["resourceRemaining"]),
                    0.0
                );
            }
        }
    }

    #[test]
    fn offline_noninteger_ordinary_macro_source_is_rejected_atomically() {
        let mut state = with_quantum_upload_station(
            as_offline_fixture(productive_closed_recipe_macro_fixture(1.0)),
            "iron_ingot",
            "smelter",
        );
        state.base_value_mut()["elapsedSeconds"] = json!(0.0043);
        state.base_value_mut()["historyRecordedAt"] = json!(0.0043);
        let before = state.summary().unwrap().canonical_sha256;
        let revision = state.revision;
        let result =
            advance_macro_v10(&mut state, &offline_macro_request(revision, 600.0)).unwrap();
        assert!(!result.supported);
        assert_eq!(
            result.reason.as_deref(),
            Some("offline-ordinary-macro-source-clock-unsupported")
        );
        assert_eq!(state.revision, revision);
        assert_eq!(state.summary().unwrap().canonical_sha256, before);
    }

    #[test]
    fn offline_boundary_exact_keeps_the_exact_fractional_source_clock() {
        let mut source = with_quantum_upload_station(
            as_offline_fixture(productive_closed_recipe_macro_fixture(1.0)),
            "iron_ingot",
            "smelter",
        );
        source.base_value_mut()["elapsedSeconds"] = json!(0.0043);
        source.base_value_mut()["historyRecordedAt"] = json!(0.0043);
        source.base_value_mut()["quantumLogisticsNetwork"]["inventory"]["iron_ingot"] =
            json!("9950");
        source.base_value_mut()["quantumLogisticsNetwork"]["itemCapacities"]["iron_ingot"] =
            json!("10000");
        let mut exact = source.clone();
        let revision = exact.revision;
        assert!(
            exact
                .advance_exact(&exact_request(revision, 600.0, 600.0))
                .unwrap()
                .supported
        );
        let mut boundary = source;
        let revision = boundary.revision;
        let result =
            advance_macro_v10(&mut boundary, &offline_macro_request(revision, 600.0)).unwrap();
        assert!(result.supported, "{:?}", result.reason);
        assert_eq!(result.exact_scope, "offline-boundary-exact");
        assert_eq!(
            number_at(boundary.base_value().get("elapsedSeconds"), &[]),
            600.0043
        );
        assert_eq!(
            boundary.summary().unwrap().canonical_sha256,
            exact.summary().unwrap().canonical_sha256
        );
    }

    #[test]
    fn offline_boundary_exact_budget_is_finite_and_rejection_is_atomic() {
        assert!(offline_boundary_exact_budget(28_800.0, 110, 2));
        assert!(!offline_boundary_exact_budget(28_801.0, 110, 2));
        assert!(!offline_boundary_exact_budget(600.0, 7_000, 1));
        for seconds in [f64::NAN, f64::INFINITY, -1.0] {
            assert!(!offline_boundary_exact_budget(seconds, 1, 0));
        }
        let mut state = with_quantum_upload_station(
            as_offline_fixture(productive_closed_recipe_macro_fixture(1.0)),
            "iron_ingot",
            "smelter",
        );
        let revision = state.revision;
        assert!(
            state
                .advance_exact(&exact_request(revision, 30.0, 30.0))
                .unwrap()
                .supported
        );
        state.base_value_mut()["quantumLogisticsNetwork"]["inventory"]["iron_ingot"] =
            json!("9967");
        state.base_value_mut()["quantumLogisticsNetwork"]["itemCapacities"]["iron_ingot"] =
            json!("10000");
        let before = state.summary().unwrap().canonical_sha256;
        let revision = state.revision;
        let result =
            advance_macro_v10(&mut state, &offline_macro_request(revision, 28_801.0)).unwrap();
        assert!(!result.supported);
        assert_eq!(
            result.reason.as_deref(),
            Some("offline-boundary-exact-work-budget-exceeded")
        );
        assert_eq!(state.revision, revision);
        assert_eq!(state.summary().unwrap().canonical_sha256, before);
    }

    #[test]
    fn offline_ordinary_without_a_boundary_keeps_its_certified_macro_path() {
        let initial = with_quantum_upload_station(
            as_offline_fixture(productive_closed_recipe_macro_fixture(1.0)),
            "iron_ingot",
            "smelter",
        );
        let mut macro_state = initial.clone();
        let revision = macro_state.revision;
        let result =
            advance_macro_v10(&mut macro_state, &offline_macro_request(revision, 600.0)).unwrap();
        assert!(result.supported, "{:?}", result.reason);
        assert_eq!(result.exact_scope, "offline-macro-v1");
        assert_eq!(result.exact_calibration_seconds, Some(30.0));
        assert_eq!(result.approximated_seconds, Some(570.0));
        let mut exact = initial;
        let revision = exact.revision;
        assert!(
            exact
                .advance_exact(&exact_request(revision, 600.0, 600.0))
                .unwrap()
                .supported
        );
        assert_eq!(
            capture_settlement_snapshot(&macro_state).unwrap().produced,
            capture_settlement_snapshot(&exact).unwrap().produced
        );
    }

    #[test]
    fn offline_depleted_factory_with_no_buffers_never_creates_remaining_material() {
        let mut state = with_quantum_upload_station(
            as_offline_fixture(productive_closed_recipe_macro_fixture(1.0)),
            "iron_ingot",
            "smelter",
        );
        state.base_value_mut()["settings"]["resourceMode"] = json!("finite");
        for index in 2..=4 {
            let mut entity = state.parse_entity(index).unwrap();
            if index == 2 {
                entity["resourceRemaining"] = json!(0);
                entity["resourceDepletionRemainder"] = json!(0);
            }
            for field in ["inputs", "outputs"] {
                for amount in entity[field].as_object_mut().unwrap().values_mut() {
                    *amount = json!(0);
                }
            }
            entity["progress"] = json!(0);
            state.replace_entity_raw(index, serde_json::to_string(&entity).unwrap().into());
        }
        state.rebuild_indexes().unwrap();
        let before_hash = state.summary().unwrap().canonical_sha256;
        let before = capture_settlement_snapshot(&state).unwrap();
        let revision = state.revision;
        let result =
            advance_macro_v10(&mut state, &offline_macro_request(revision, 600.0)).unwrap();
        assert!(!result.supported, "{:?}", result.reason);
        assert!(
            result
                .reason
                .as_deref()
                .is_some_and(|reason| reason.contains("offline-ordinary-tail-uncertified"))
        );
        assert_eq!(state.summary().unwrap().canonical_sha256, before_hash);
        let after = capture_settlement_snapshot(&state).unwrap();
        assert_eq!(before.produced, after.produced);
        assert_eq!(before.owned, after.owned);
        assert_eq!(before.finite_veins, after.finite_veins);
    }

    #[test]
    fn offline_initial_or_calibration_capacity_boundary_without_certificate_is_rejected() {
        for room in [0, 5] {
            let mut state = with_quantum_upload_station(
                as_offline_fixture(productive_closed_recipe_macro_fixture(1.0)),
                "iron_ingot",
                "smelter",
            );
            state.base_value_mut()["quantumLogisticsNetwork"]["inventory"]["iron_ingot"] =
                json!("10000");
            state.base_value_mut()["quantumLogisticsNetwork"]["itemCapacities"]["iron_ingot"] =
                json!("10000");
            // These are real existing buffers at their catalog limits. With
            // five free slots the line fills during calibration; with zero it
            // starts blocked. Neither case proves a sustainable material rate.
            for index in 2..=4 {
                let mut entity = state.parse_entity(index).unwrap();
                if index == 2 {
                    entity["outputs"]["iron_ore"] = json!(1_000_000 - room);
                }
                if index == 3 {
                    entity["inputs"]["iron_ore"] = json!(1_000_000 - room);
                    entity["outputs"]["iron_ingot"] = json!(1_000_000 - room);
                }
                if index == 4 {
                    entity["outputs"]["iron_ingot"] = json!(1_000_000 - room);
                }
                state.replace_entity_raw(index, serde_json::to_string(&entity).unwrap().into());
            }
            state.rebuild_indexes().unwrap();
            let before = state.summary().unwrap().canonical_sha256;
            let revision = state.revision;
            let result =
                advance_macro_v10(&mut state, &offline_macro_request(revision, 600.0)).unwrap();
            assert!(!result.supported, "room={room}: {:?}", result.reason);
            assert!(
                result
                    .reason
                    .as_deref()
                    .is_some_and(|reason| reason.contains("offline-ordinary-tail-uncertified")),
                "room={room}: {:?}",
                result.reason
            );
            assert_eq!(state.revision, revision);
            assert_eq!(state.summary().unwrap().canonical_sha256, before);
        }
    }

    #[test]
    fn macro_v10_quantum_upload_is_segment_invariant_with_capacity_and_finite_bounds() {
        for bound in ["none", "capacity", "finite"] {
            let mut initial = with_quantum_upload_station(
                productive_closed_recipe_macro_fixture(15.0),
                "iron_ingot",
                "smelter",
            );
            let revision = initial.revision;
            let warmup = initial
                .advance_exact(&exact_request(revision, 30.0, 2.0))
                .unwrap();
            assert!(warmup.supported, "{:?}", warmup.reason);
            if bound == "capacity" {
                initial.base_value_mut()["quantumLogisticsNetwork"]["inventory"]["iron_ingot"] =
                    json!("9967");
                initial.base_value_mut()["quantumLogisticsNetwork"]["itemCapacities"]["iron_ingot"] =
                    json!("10000");
            } else if bound == "finite" {
                initial.base_value_mut()["settings"]["resourceMode"] = json!("finite");
                let mut vein = initial.parse_entity(2).unwrap();
                vein["resourceRemaining"] = json!(120);
                vein["resourceDepletionRemainder"] = json!(0);
                initial.replace_entity_raw(2, serde_json::to_string(&vein).unwrap().into());
                initial.rebuild_indexes().unwrap();
            }
            let mut long = initial.clone();
            let revision = long.revision;
            let result =
                advance_macro_v10(&mut long, &pure_idle_macro_request(revision, 600.0, 40.0))
                    .unwrap();
            assert!(result.supported, "{bound}: {:?}", result.reason);
            assert!(
                !result
                    .reason
                    .as_deref()
                    .is_some_and(|reason| reason.contains("ordinary-flow tail froze")),
                "{bound}: {:?}",
                result.reason
            );
            let mut segmented = initial;
            for seconds in [10.0, 20.0, 190.0, 190.0, 190.0] {
                let revision = segmented.revision;
                let result = advance_macro_v10(
                    &mut segmented,
                    &pure_idle_macro_request(revision, seconds, seconds / 15.0),
                )
                .unwrap();
                assert!(result.supported, "{bound}: {:?}", result.reason);
            }
            assert_eq!(
                segmented.summary().unwrap().canonical_sha256,
                long.summary().unwrap().canonical_sha256,
                "{bound}"
            );
        }
    }

    #[test]
    fn quantum_upload_does_not_mask_recipe_cycles_or_alternate_producers() {
        let state = with_quantum_upload_station(
            productive_closed_recipe_dag_macro_fixture(15.0),
            "iron_gear",
            "gear-smelter",
        );
        let request = pure_idle_macro_request(state.revision, 600.0, 40.0);
        let snapshots = exact_three_window_probe(&state, &request).unwrap();
        let flow = capture_ordinary_window_flow(
            &snapshots[0],
            &snapshots[1],
            false,
            &MaterialTotals::new(),
        )
        .unwrap();
        for cycle in [true, false] {
            let mut changed = state.clone();
            let index = if cycle { 4 } else { 3 };
            let mut entity = changed.parse_entity(index).unwrap();
            if cycle {
                Arc::make_mut(&mut changed.catalog)
                    .recipes
                    .get_mut("iron_ingot")
                    .unwrap()
                    .inputs = vec![ItemAmount {
                    item_id: "magnet".to_owned(),
                    amount: 1.0,
                }];
                entity["inputs"] = json!({ "magnet": 1000 });
            } else {
                Arc::make_mut(&mut changed.catalog)
                    .recipes
                    .get_mut("magnet")
                    .unwrap()
                    .outputs = vec![ItemAmount {
                    item_id: "iron_gear".to_owned(),
                    amount: 1.0,
                }];
                entity["outputs"] = json!({ "iron_gear": 0 });
            }
            changed.replace_entity_raw(index, serde_json::to_string(&entity).unwrap().into());
            changed.rebuild_indexes().unwrap();
            let hash = changed.summary().unwrap().canonical_sha256;
            let sources = exclusive_vein_sources(&changed).unwrap();
            let reason = build_closed_recipe_certificate(
                &changed,
                &sources,
                &flow,
                Vec::new(),
                OrdinaryTerminalCertificates::default(),
            )
            .unwrap_err();
            assert!(
                reason.contains(if cycle {
                    "dependency cycle"
                } else {
                    "alternate active producers"
                }),
                "{reason}"
            );
            assert_eq!(changed.summary().unwrap().canonical_sha256, hash);
        }
    }

    fn rebuild_fixture_with_terminal(
        state: CoreState,
        terminal: Value,
        terminal_belt: Value,
    ) -> CoreState {
        let mut public = state.materialize().unwrap();
        let public = public.as_object_mut().unwrap();
        let mut entities = public
            .remove("entities")
            .and_then(|value| value.as_array().cloned())
            .unwrap();
        let mut belts = public
            .remove("belts")
            .and_then(|value| value.as_array().cloned())
            .unwrap();
        entities.push(terminal);
        belts.push(terminal_belt);
        fixture_state_from_parts_with_belts(Value::Object(public.clone()), entities, belts)
    }

    fn checkpoint_reload_fixture(state: &CoreState) -> CoreState {
        let mut records = BTreeMap::<String, Vec<u8>>::new();
        state
            .visit_internal_checkpoint_records(42, |key, value| {
                records.insert(key.to_owned(), value.as_bytes().to_vec());
                Ok(())
            })
            .unwrap();
        let mut identity = state.identity.clone();
        identity.revision = state.revision;
        CoreState::from_internal_records(identity, &records, (*state.catalog).clone()).unwrap()
    }

    fn install_certified_galactic_activity(base: &mut Map<String, Value>) {
        base.get_mut("research")
            .and_then(Value::as_object_mut)
            .unwrap()
            .insert("completedTechIds".to_owned(), json!(["universe_matrix"]));
        let endgame = base
            .get_mut("endgame")
            .and_then(Value::as_object_mut)
            .unwrap();
        for (project_id, project) in endgame
            .get_mut("exportProjects")
            .and_then(Value::as_object_mut)
            .unwrap()
        {
            project
                .as_object_mut()
                .unwrap()
                .insert("id".to_owned(), Value::from(project_id.clone()));
        }
        endgame.insert("exportInputMode".to_owned(), json!("building"));
        endgame.insert("autoDispatch".to_owned(), json!(false));
        endgame.insert(
            "constructionActivity".to_owned(),
            json!({
                "activityId": "macro-certified-activity",
                "participantId": "macro-certified-participant",
                "configRevision": "macro-certified-config",
                "startsAtMs": 0,
                "endsAtMs": 1_000_000_000,
                "serverTimeAnchorMs": 0,
                "activityClockMs": 0,
                "personalTargets": {
                    "universe_matrix": 1_000_000_000,
                    "solar_sail": 1_000_000_000,
                    "small_carrier_rocket": 1_000_000_000,
                    "antimatter_fuel_rod": 1_000_000_000
                },
                "globalTargets": {
                    "universe_matrix": 1_000_000_000,
                    "solar_sail": 1_000_000_000,
                    "small_carrier_rocket": 1_000_000_000,
                    "antimatter_fuel_rod": 1_000_000_000
                },
                "personalDelivered": {
                    "universe_matrix": 0,
                    "solar_sail": 0,
                    "small_carrier_rocket": 0,
                    "antimatter_fuel_rod": 0
                },
                "pendingBatches": {},
                "nextBatchSequence": 0
            }),
        );
    }

    fn productive_galactic_export_macro_fixture(multiplier: f64, prefilled: i64) -> CoreState {
        let mut state = productive_solar_sail_product_macro_fixture(multiplier);
        install_certified_galactic_activity(state.base_value_mut());
        rebuild_fixture_with_terminal(
            state,
            json!({
                "id": "galactic-exporter",
                "kind": "machine",
                "planetId": "home",
                "powerGridId": "grid-a",
                "buildingId": "galactic_material_exporter",
                "machineCount": 1,
                "minerCount": 0,
                "inputs": { "solar_sail": prefilled },
                "outputs": {},
                "galacticExporterPaused": false,
                "progress": 0,
                "routingCursor": 0,
                "utilization": 0,
                "productionRate": 0
            }),
            json!({
                "id": "sail-export-feed",
                "planetId": "home",
                "source": "smelter",
                "target": "galactic-exporter",
                "itemId": "solar_sail",
                "lanes": 1,
                "tier": 1,
                "priority": 1,
                "progress": 0,
                "lastFlow": 0,
                "totalTransferred": 0
            }),
        )
    }

    fn prime_galactic_sail_level_boundary(state: &mut CoreState, delivered: i64) {
        let endgame = state.base_value_mut()["endgame"].as_object_mut().unwrap();
        let project = endgame["exportProjects"]["solar_sail_array"]
            .as_object_mut()
            .unwrap();
        project.insert("delivered".to_owned(), Value::from(delivered));
        project.insert("totalDelivered".to_owned(), Value::from(delivered));
        endgame.insert("totalExported".to_owned(), Value::from(delivered));
        endgame.insert(
            "galacticCredits".to_owned(),
            Value::from(delivered.saturating_mul(3)),
        );
        endgame.insert(
            "galacticScore".to_owned(),
            Value::from(delivered.saturating_mul(3)),
        );
        endgame["constructionActivity"]["personalDelivered"]["solar_sail"] = Value::from(delivered);
    }

    fn orbital_contract_fixture(slot: u64, amount: i64, delivered: i64) -> Value {
        json!({
            "id": format!("station-contract-v1-7-100-{slot}-single"),
            "templateId": "single",
            "slot": slot,
            "title": format!("contract {slot}"),
            "summary": "pure idle terminal fixture",
            "taskDay": 100,
            "expiresAtTaskDay": 103,
            "special": false,
            "difficulty": "P1",
            "status": "accepted",
            "requirements": [{
                "itemId": "solar_sail",
                "amount": amount.to_string(),
                "delivered": delivered.to_string(),
                "channel": "any",
                "weight": 1
            }],
            "rewards": {
                "baseMarks": "45",
                "baseReputation": "30",
                "completionMarks": "20",
                "completionReputation": "15"
            },
            "acceptedAtTaskDay": 100
        })
    }

    fn productive_orbital_contract_macro_fixture(
        multiplier: f64,
        prefilled: i64,
        contracts: Vec<Value>,
        bound_slot: u64,
    ) -> CoreState {
        let mut state = productive_solar_sail_product_macro_fixture(multiplier);
        state.base_value_mut()["galaxy"]["seed"] = json!(7);
        state.base_value_mut().insert(
            "orbitalStation".to_owned(),
            json!({
                "status": "operational",
                "construction": { "stageRequirements": [] },
                "contractBoard": {
                    "rulesVersion": 1,
                    "taskDay": 100,
                    "lastConfirmedWallClockMs": 8_640_000_000_u64,
                    "offers": [],
                    "accepted": contracts,
                    "history": [],
                    "settledIds": [],
                    "featuredContractId": null
                },
                "totals": { "completedContracts": 0, "exportedByItem": {} },
                "economy": { "orbitalMarks": "0", "stationReputation": "0" }
            }),
        );
        let contract_id = format!("station-contract-v1-7-100-{bound_slot}-single");
        rebuild_fixture_with_terminal(
            state,
            json!({
                "id": "orbital-terminal",
                "kind": "storage",
                "planetId": "home",
                "powerGridId": "grid-a",
                "buildingId": "orbital_cargo_terminal",
                "machineCount": 1,
                "minerCount": 0,
                "inputs": { "solar_sail": prefilled },
                "outputs": {},
                "powerFactor": 1,
                "orbitalCargoBinding": {
                    "kind": "contract",
                    "contractId": contract_id
                },
                "orbitalCargoPortItems": ["solar_sail", null, null, null],
                "orbitalCargoProgress": 0,
                "orbitalCargoTotalUploaded": "0",
                "progress": 0,
                "routingCursor": 0,
                "utilization": 0,
                "productionRate": 0
            }),
            json!({
                "id": "sail-contract-feed",
                "planetId": "home",
                "source": "smelter",
                "target": "orbital-terminal",
                "itemId": "solar_sail",
                "lanes": 1,
                "tier": 1,
                "priority": 1,
                "progress": 0,
                "lastFlow": 0,
                "totalTransferred": 0
            }),
        )
    }

    fn productive_solar_sail_product_macro_fixture(multiplier: f64) -> CoreState {
        productive_single_recipe_macro_fixture(multiplier, "solar_sail", "solar_sail", false, false)
    }

    fn productive_solar_sail_launch_macro_fixture(multiplier: f64) -> CoreState {
        productive_single_recipe_macro_fixture(multiplier, "solar_sail", "solar_sail", true, false)
    }

    fn productive_solar_sail_launch_with_ray_power_fixture(multiplier: f64) -> CoreState {
        productive_single_recipe_macro_fixture(multiplier, "solar_sail", "solar_sail", true, true)
    }

    fn dynamic_ray_power_fixture(
        multiplier: f64,
        structure_points: i64,
        transient_orbit_sails: i64,
    ) -> CoreState {
        let mut state = productive_solar_sail_launch_with_ray_power_fixture(multiplier);
        let wind_index = state.entity_index.get("wind").copied().unwrap();
        let mut wind = state.parse_entity(wind_index).unwrap();
        wind["machineCount"] = json!(0);
        state.replace_entity_raw(wind_index, serde_json::to_string(&wind).unwrap().into());

        let receiver_index = state.entity_index.get("ray-power").copied().unwrap();
        let mut receiver = state.parse_entity(receiver_index).unwrap();
        // 2e11 receivers expose a 1.2e15 kW reception ceiling in the test
        // catalog, enough to power a 14x controller without relying on wind.
        receiver["machineCount"] = json!(200_000_000_000_i64);
        state.replace_entity_raw(
            receiver_index,
            serde_json::to_string(&receiver).unwrap().into(),
        );

        let base = state.base_value_mut();
        base["dysonPlans"]["helios"]["structurePoints"] = json!(structure_points);
        base["dysonSphere"]["structurePoints"] = json!(structure_points);
        base["dysonSphere"]["totalRocketsLaunched"] = json!(structure_points);
        base["dysonEngineering"]["orbitsBySystem"]["helios"][0]["sailsInOrbit"] =
            json!(transient_orbit_sails);
        base["dysonEngineering"]["orbitsBySystem"]["helios"][0]["totalLaunched"] =
            json!(transient_orbit_sails);
        base["dysonSwarm"]["sailsInOrbit"] = json!(transient_orbit_sails);
        base["dysonSwarm"]["totalLaunched"] = json!(transient_orbit_sails);
        crate::dyson::finalize(base).unwrap();
        state.rebuild_indexes().unwrap();
        state
    }

    fn sustainable_dynamic_ray_power_fixture(multiplier: f64) -> CoreState {
        // Structure power is permanent across a certified solar-sail tail.
        dynamic_ray_power_fixture(multiplier, 2_000_000_000_000, 0)
    }

    fn transient_dynamic_ray_power_fixture(multiplier: f64) -> CoreState {
        // These old sails power the exact prefix, but can decay. They are
        // deliberately removed from the permanent lower-bound proof.
        dynamic_ray_power_fixture(multiplier, 0, 15_000_000_000_000)
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

    fn productive_construction_macro_fixture(multiplier: f64, target: u64) -> CoreState {
        let mut state = construction_powered_fixture();
        state.base_value_mut()["timeWarp"]["requestedMultiplier"] = json!(multiplier);
        state.base_value_mut()["timeWarp"]["effectiveMultiplier"] = json!(multiplier);
        state.base_value_mut()["timeWarp"]["requiredPowerKw"] =
            json!(10_f64.powf(multiplier + 1.0));
        state.base_value_mut()["timeWarp"]["allocatedPowerKw"] =
            json!(10_f64.powf(multiplier + 1.0));
        state.base_value_mut()["tray"]["iron_ore"] = json!(target);
        state.base_value_mut()["planetTrays"]["home"]["iron_ore"] = json!(target);
        state.base_value_mut()["constructionAutomation"]["targetStock"]["test_building"] =
            json!(target);
        state
    }

    fn productive_recipe_construction_quantum_macro_fixture(
        multiplier: f64,
        target: u64,
    ) -> CoreState {
        let source = productive_closed_recipe_macro_fixture(multiplier);
        let mut base = source.base_value().clone();
        base.insert(
            "constructionAutomation".to_owned(),
            json!({
                "enabled": true,
                "targetStock": { "test_building": target },
                "cursor": 0,
                "totalCrafted": 0,
                "lastCraftedId": null,
                "destroyedByproducts": {},
                "jobs": {},
                "quantumSourceEnabled": true,
                "quantumMaterialBuffer": {}
            }),
        );
        base.insert(
            "construction".to_owned(),
            json!({ "test_building": 0, "conveyor_belt_mk1": 0 }),
        );
        base["quantumLogisticsNetwork"]["enabled"] = json!(true);
        base["quantumLogisticsNetwork"]["inventory"] = json!({});
        base["quantumLogisticsNetwork"]["itemCapacities"] = json!({
            "iron_ore": "10000000000",
            "iron_ingot": "10000000000"
        });
        let mut entities = source.parse_entities_parallel().unwrap();
        entities.push(json!({
            "id": "construction-center",
            "kind": "machine",
            "planetId": "home",
            "powerGridId": "grid-a",
            "buildingId": "construction_center",
            "machineCount": 100,
            "minerCount": 0,
            "inputs": {},
            "outputs": {},
            "progress": 0,
            "routingCursor": 0,
            "utilization": 0,
            "productionRate": 0
        }));
        entities.push(json!({
            "id": "quantum-supply-tower",
            "kind": "station",
            "planetId": "home",
            "powerGridId": "grid-a",
            "buildingId": "interstellar_logistics_station",
            "stationTier": 2,
            "stationOperationMode": "legacy",
            "stationModeTransition": null,
            "quantumMode": "quantum",
            "machineCount": 1,
            "stationSlots": [
                { "itemId": null, "localMode": "storage", "remoteMode": "storage", "minimumLoad": 0.1, "minStock": 0, "maxStock": 1000000, "priority": 1, "routePolicy": "direct", "warperBudget": 0 },
                { "itemId": null, "localMode": "storage", "remoteMode": "storage", "minimumLoad": 0.1, "minStock": 0, "maxStock": 1000000, "priority": 1, "routePolicy": "direct", "warperBudget": 0 },
                { "itemId": null, "localMode": "storage", "remoteMode": "storage", "minimumLoad": 0.1, "minStock": 0, "maxStock": 1000000, "priority": 1, "routePolicy": "direct", "warperBudget": 0 },
                { "itemId": null, "localMode": "storage", "remoteMode": "storage", "minimumLoad": 0.1, "minStock": 0, "maxStock": 1000000, "priority": 1, "routePolicy": "direct", "warperBudget": 0 },
                { "itemId": null, "localMode": "storage", "remoteMode": "storage", "minimumLoad": 0.1, "minStock": 0, "maxStock": 1000000, "priority": 1, "routePolicy": "direct", "warperBudget": 0 }
            ],
            "stationRoutes": [],
            "stationDrones": 0,
            "stationVessels": 0,
            "stationWarpEnabled": false,
            "stationWarpers": 0,
            "stationDispatchCursor": 0,
            "stationLastSupplyPeerBySlot": {},
            "stationProgress": 0,
            "stationCongestion": 0,
            "stationTrips": 0,
            "stationLastTransfer": 0,
            "inputs": {},
            "outputs": {},
            "progress": 0,
            "routingCursor": 0,
            "utilization": 0,
            "productionRate": 0
        }));
        let mut catalog = fixture_catalog().snapshot;
        catalog.buildings.push(BuildingDefinition {
            id: "interstellar_logistics_station".to_owned(),
            kind: "station".to_owned(),
            speed: 1.0,
            input_capacity: 1_000_000.0,
            output_capacity: 1_000_000.0,
            power_demand_kw: 0.0,
            power_generation_kw: 0.0,
            power_charge_kw: 0.0,
            energy_capacity_mj: 0.0,
            fuel_item_ids: Vec::new(),
            fuel_efficiency: 1.0,
            family: None,
            accepts: None,
        });
        let catalog = RuntimeCatalog::validate(catalog, "pure-idle-test").unwrap();
        fixture_state_from_parts_with_belts_and_catalog(
            Value::Object(base),
            entities,
            source.parse_belts_parallel().unwrap(),
            catalog,
        )
    }

    fn productive_multi_center_construction_macro_fixture(
        multiplier: f64,
        center_count: usize,
        prebuilt_job_steps: usize,
    ) -> CoreState {
        let mut base = powered_fixture_base(multiplier, "infinite");
        base["tray"] = json!({ "iron_ore": 75_000 });
        base["planetTrays"]["home"] = json!({ "iron_ore": 75_000 });
        base["construction"] = json!({ "test_building": 0, "conveyor_belt_mk1": 0 });
        let mut jobs = Map::new();
        if prebuilt_job_steps > 0 {
            for index in 0..center_count {
                let construction_id = if index % 2 == 0 {
                    "test_building"
                } else {
                    "conveyor_belt_mk1"
                };
                jobs.insert(
                    format!("construction-center-{index:05}"),
                    json!({
                        "constructionId": construction_id,
                        "steps": (0..prebuilt_job_steps)
                            .map(|_| json!({
                                "kind": "building",
                                "constructionId": construction_id
                            }))
                            .collect::<Vec<_>>(),
                        "stepIndex": 0,
                        "elapsedSeconds": 0,
                        "inventory": {}
                    }),
                );
            }
        }
        base["constructionAutomation"] = json!({
            "enabled": true,
            "targetStock": {
                "test_building": 100_000,
                "conveyor_belt_mk1": 100_000
            },
            "cursor": 0,
            "totalCrafted": 0,
            "lastCraftedId": null,
            "destroyedByproducts": {},
            "jobs": jobs,
            "quantumSourceEnabled": false,
            "quantumMaterialBuffer": {}
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
        ];
        for index in 0..center_count {
            entities.push(json!({
                "id": format!("construction-center-{index:05}"),
                "kind": "machine",
                "planetId": "home",
                "powerGridId": "grid-a",
                "buildingId": "construction_center",
                "machineCount": 1_000,
                "minerCount": 0,
                "inputs": {},
                "outputs": {},
                "progress": 0,
                "routingCursor": 0,
                "utilization": 0,
                "productionRate": 0
            }));
        }
        fixture_state_from_parts(base, entities)
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

    fn offline_macro_request(revision: u64, seconds: f64) -> CoreAdvanceRequest {
        CoreAdvanceRequest {
            base_revision: revision,
            simulation_seconds: seconds,
            wall_seconds: seconds,
            advance_mode: CoreAdvanceMode::OfflineMacroV1,
            include_diagnostics: false,
        }
    }

    fn as_offline_fixture(mut state: CoreState) -> CoreState {
        let time_warp = state.base_value_mut()["timeWarp"]
            .as_object_mut()
            .expect("fixture timeWarp object");
        time_warp.insert("enabled".to_owned(), json!(false));
        time_warp.insert("requestedMultiplier".to_owned(), json!(1));
        time_warp.insert("effectiveMultiplier".to_owned(), json!(1));
        time_warp.insert("requiredPowerKw".to_owned(), json!(0));
        time_warp.insert("allocatedPowerKw".to_owned(), json!(0));
        let endgame = state.base_value_mut()["endgame"]
            .as_object_mut()
            .expect("fixture endgame object");
        endgame
            .entry("exportInputMode")
            .or_insert(json!("building"));
        endgame.entry("exportWindowStartedAt").or_insert(json!(0));
        endgame.entry("exportWindowAmount").or_insert(json!(0));
        endgame.entry("exportedLastMinute").or_insert(json!(0));
        endgame.entry("totalExported").or_insert(json!(0));
        state
    }

    fn settlement_parallel_entities(entity_count: usize) -> Vec<Value> {
        (0..entity_count)
            .map(|index| {
                let mut entity = json!({
                    "id": format!("settlement-scan-{index:05}"),
                    "kind": "power",
                    "planetId": "home",
                    "powerGridId": "grid-a",
                    "buildingId": "wind_turbine",
                    "machineCount": 1,
                    "minerCount": 0,
                    "inputs": { "iron_ore": index % 7 },
                    "outputs": { "iron_ingot": index % 11 },
                    "progress": 0,
                    "routingCursor": 0,
                    "utilization": 0,
                    "productionRate": 0
                });
                if index.is_multiple_of(521) {
                    entity["blackHolePorts"] = json!([{
                        "currentItemId": "iron_ore",
                        "totalDestroyed": index / 521
                    }]);
                }
                if index == 0 {
                    entity["stationRoutes"] = json!([{
                        "id": "first-route-wins",
                        "peerId": "settlement-scan-00000",
                        "itemId": "iron_ingot",
                        "cargo": 3
                    }]);
                } else if index == 1 {
                    // Frozen v47 semantics ignore every field after the first
                    // occurrence of a station-route ID. Keeping this duplicate
                    // malformed proves the parallel fold does not validate or
                    // count a later copy first.
                    entity["stationRoutes"] = json!([{
                        "id": "first-route-wins",
                        "cargo": "not-a-counter"
                    }]);
                } else if index == 2 {
                    entity["stationRoutes"] = json!([{
                        "id": "second-route",
                        "peerId": "settlement-scan-00000",
                        "itemId": "iron_ore",
                        "cargo": 5
                    }]);
                }
                entity
            })
            .collect()
    }

    fn settlement_parallel_fixture(entity_count: usize) -> CoreState {
        fixture_state_from_parts(
            powered_fixture_base(15.0, "infinite"),
            settlement_parallel_entities(entity_count),
        )
    }

    fn settlement_totals_hash(totals: &SettlementEntityTotals) -> String {
        let route_reservations = totals
            .route_reservations
            .iter()
            .map(|(source_id, by_item)| (source_id.clone(), by_item.clone()))
            .collect::<BTreeMap<_, _>>();
        let bytes = serde_json::to_vec(&json!({
            "owned": totals.owned,
            "consumed": totals.consumed,
            "routeReservations": route_reservations
        }))
        .unwrap();
        hex::encode(Sha256::digest(bytes))
    }

    fn settlement_snapshot_hash(snapshot: &SettlementProofSnapshot) -> String {
        // Every collection in the persisted proof snapshot is ordered. Debug
        // encoding stays private to this regression and avoids adding a wire
        // representation for an ephemeral certificate input.
        hex::encode(Sha256::digest(format!("{snapshot:?}").as_bytes()))
    }

    #[test]
    fn settlement_entity_scan_matches_serial_oracle_and_hash_at_one_two_four_eight_workers() {
        let entity_count = crate::deterministic_runtime::PARALLEL_MIN_ITEMS + 257;
        let state = settlement_parallel_fixture(entity_count);
        let oracle = capture_entity_settlement_serial_oracle(&state).unwrap();
        let oracle_hash = settlement_totals_hash(&oracle);
        assert_eq!(
            oracle
                .route_reservations
                .get("settlement-scan-00000")
                .and_then(|by_item| by_item.get("iron_ingot")),
            Some(&3)
        );

        for workers in [1, 2, 4, 8] {
            let (actual, diagnostics) = capture_entity_settlement_with_runtime(
                &state,
                &DeterministicRuntime::for_test(workers),
            )
            .unwrap();
            assert_eq!(actual, oracle, "worker count {workers}");
            assert_eq!(settlement_totals_hash(&actual), oracle_hash);
            assert_eq!(diagnostics.entity_count, entity_count);
            assert_eq!(diagnostics.parsed_entity_count, entity_count);
            assert_eq!(
                diagnostics.chunk_count,
                entity_count.div_ceil(SETTLEMENT_ENTITY_ROWS_PER_CHUNK)
            );
            assert_eq!(diagnostics.selected_worker_count, workers);
            assert_eq!(diagnostics.parallel_path, workers > 1);
        }
    }

    #[test]
    fn settlement_entity_scan_keeps_small_batches_serial() {
        let state = settlement_parallel_fixture(3);
        let oracle = capture_entity_settlement_serial_oracle(&state).unwrap();
        let (actual, diagnostics) =
            capture_entity_settlement_with_runtime(&state, &DeterministicRuntime::for_test(8))
                .unwrap();
        assert_eq!(actual, oracle);
        assert_eq!(diagnostics.entity_count, 3);
        assert_eq!(diagnostics.parsed_entity_count, 3);
        assert_eq!(diagnostics.chunk_count, 1);
        assert_eq!(diagnostics.selected_worker_count, 1);
        assert!(!diagnostics.parallel_path);
    }

    #[test]
    fn settlement_snapshot_hash_is_identical_at_one_two_four_eight_workers() {
        let entity_count = crate::deterministic_runtime::PARALLEL_MIN_ITEMS + 257;
        let state = settlement_parallel_fixture(entity_count);
        let expected =
            capture_settlement_snapshot_with_runtime(&state, &DeterministicRuntime::for_test(1))
                .unwrap();
        let expected_hash = settlement_snapshot_hash(&expected);

        for workers in [1, 2, 4, 8] {
            let actual = capture_settlement_snapshot_with_runtime(
                &state,
                &DeterministicRuntime::for_test(workers),
            )
            .unwrap();
            assert_eq!(actual, expected, "worker count {workers}");
            assert_eq!(settlement_snapshot_hash(&actual), expected_hash);
        }
    }

    #[test]
    fn settlement_entity_scan_failure_is_ordered_and_never_mutates_the_source() {
        let entity_count = crate::deterministic_runtime::PARALLEL_MIN_ITEMS + 257;
        let mut entities = settlement_parallel_entities(entity_count);
        entities[17]["blackHolePorts"] = json!([0]);
        entities[crate::deterministic_runtime::PARALLEL_MIN_ITEMS + 13]["blackHolePorts"] =
            json!([0]);
        let state = fixture_state_from_parts(powered_fixture_base(15.0, "infinite"), entities);
        let source_hash = state.summary().unwrap().canonical_sha256;

        for workers in [1, 2, 4, 8] {
            let error = capture_entity_settlement_with_runtime(
                &state,
                &DeterministicRuntime::for_test(workers),
            )
            .unwrap_err();
            assert_eq!(
                error.to_string(),
                "entities.settlement-scan-00017.blackHolePorts.0 is not an object"
            );
            assert_eq!(state.summary().unwrap().canonical_sha256, source_hash);
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
        // 11/12 system station + 100 source output + 2 input. The 13-unit
        // activity pending batch is a non-owned submission outbox mirror.
        // The active planet duplicate is skipped and route cargo replaces its
        // source reservation, so neither adds another 10/30.
        assert_eq!(snapshot.owned.get("iron_ore"), Some(&211));
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

        let receipt = state
            .prepared_construction_runtime()
            .and_then(|runtime| runtime.receipt_between(revision, state.revision))
            .expect("exact construction prefix emits a private receipt");
        assert_eq!(receipt.crafted, 1);
        assert_eq!(
            receipt.outputs,
            BTreeMap::from([("test_building".to_owned(), 1)])
        );

        let canonical_with_receipt = state.canonical_sha256().unwrap();
        let materialized_with_receipt = state.materialize().unwrap();
        let entities = state.parse_entities_parallel().unwrap();
        let rebuilt =
            crate::construction::ConstructionRuntime::build(&state, state.base_value(), &entities);
        state.install_prepared_construction_runtime(Arc::new(rebuilt));
        assert_eq!(state.canonical_sha256().unwrap(), canonical_with_receipt);
        assert_eq!(state.materialize().unwrap(), materialized_with_receipt);
        assert_eq!(
            state
                .prepared_construction_runtime()
                .and_then(|runtime| runtime.receipt_between(revision, state.revision)),
            None,
            "rebuilding private runtime deliberately discards receipt history",
        );
    }

    #[test]
    fn construction_receipt_is_deterministic_for_one_five_and_sixty_second_segments() {
        fn run_exact_segments(segments: &[f64]) -> (CoreState, ConstructionRunReceipt) {
            let mut state = construction_powered_fixture();
            let base_revision = state.revision;
            for &seconds in segments {
                let revision = state.revision;
                let result = state
                    .advance_exact(&exact_request(revision, seconds, seconds / 15.0))
                    .unwrap();
                assert!(result.supported, "unexpected reason: {:?}", result.reason);
            }
            let receipt = state
                .prepared_construction_runtime()
                .and_then(|runtime| runtime.receipt_between(base_revision, state.revision))
                .expect("segmented exact construction receipt remains contiguous");
            (state, receipt)
        }

        let (one_window, one_receipt) = run_exact_segments(&[60.0]);
        let (five_second_windows, five_receipt) = run_exact_segments(&[5.0; 12]);
        let (one_second_windows, one_second_receipt) = run_exact_segments(&[1.0; 60]);
        let (one_window_again, one_receipt_again) = run_exact_segments(&[60.0]);
        let (five_second_windows_again, five_receipt_again) = run_exact_segments(&[5.0; 12]);
        let (one_second_windows_again, one_second_receipt_again) = run_exact_segments(&[1.0; 60]);

        // Construction's proof evidence is an interval aggregate, so it is
        // identical whether exact advancement arrives in one, five, or sixty
        // second calls. Each established exact call shape is also byte- and
        // hash-deterministic when replayed with the same segmentation.
        assert_eq!(five_receipt, one_receipt);
        assert_eq!(one_second_receipt, one_receipt);
        assert_eq!(one_receipt_again, one_receipt);
        assert_eq!(five_receipt_again, five_receipt);
        assert_eq!(one_second_receipt_again, one_second_receipt);
        assert_eq!(
            one_window_again.materialize().unwrap(),
            one_window.materialize().unwrap(),
        );
        assert_eq!(
            five_second_windows_again.materialize().unwrap(),
            five_second_windows.materialize().unwrap(),
        );
        assert_eq!(
            one_second_windows_again.materialize().unwrap(),
            one_second_windows.materialize().unwrap(),
        );
        assert_eq!(
            one_window_again.canonical_sha256().unwrap(),
            one_window.canonical_sha256().unwrap(),
        );
        assert_eq!(
            five_second_windows_again.canonical_sha256().unwrap(),
            five_second_windows.canonical_sha256().unwrap(),
        );
        assert_eq!(
            one_second_windows_again.canonical_sha256().unwrap(),
            one_second_windows.canonical_sha256().unwrap(),
        );
    }

    #[test]
    fn macro_v10_construction_tail_spends_real_stock_and_is_split_invariant() {
        for multiplier in [8.0, 12.0, 15.0, 16.0] {
            let mut initial = productive_construction_macro_fixture(multiplier, 100);
            let entities = initial.parse_entities_parallel().unwrap();
            let metric_runtime =
                crate::simple_factory::PlanetMetricsRuntime::build(&initial, &entities);
            initial.install_prepared_planet_metrics_runtime(Arc::new(metric_runtime));
            assert!(initial.prepared_planet_metrics_runtime().is_some());
            let mut prefix = initial.clone();
            let prefix_revision = prefix.revision;
            let prefix_result = advance_macro_v10(
                &mut prefix,
                &pure_idle_macro_request(prefix_revision, 30.0, 30.0 / multiplier),
            )
            .unwrap();
            assert!(prefix_result.supported, "reason={:?}", prefix_result.reason);
            let prefix_crafted = proof_counter(
                prefix.base_value()["constructionAutomation"].get("totalCrafted"),
                "prefix construction totalCrafted",
            )
            .unwrap();
            assert!(prefix_crafted > 0 && prefix_crafted < 100);

            let mut long = initial.clone();
            let revision = long.revision;
            let result = advance_macro_v10(
                &mut long,
                &pure_idle_macro_request(revision, 600.0, 600.0 / multiplier),
            )
            .unwrap();
            assert!(result.supported, "reason={:?}", result.reason);
            assert_eq!(result.exact_scope, "pure-idle-macro-v10");
            assert!(long.prepared_planet_metrics_runtime().is_none());
            assert_eq!(
                proof_counter(
                    long.base_value()["constructionAutomation"].get("totalCrafted"),
                    "long construction totalCrafted",
                )
                .unwrap(),
                100,
            );
            assert_eq!(
                long.base_value()["construction"]["test_building"],
                json!(100.0)
            );
            assert_eq!(long.base_value()["tray"]["iron_ore"], json!(0.0));
            assert_eq!(
                long.base_value()["planetTrays"]["home"]["iron_ore"],
                prefix.base_value()["planetTrays"]["home"]["iron_ore"],
                "the inactive mirror is not a second inventory and remains at the exact-prefix boundary",
            );

            let mut segmented = initial;
            for seconds in [30.0, 190.0, 190.0, 190.0] {
                let revision = segmented.revision;
                let result = advance_macro_v10(
                    &mut segmented,
                    &pure_idle_macro_request(revision, seconds, seconds / multiplier),
                )
                .unwrap();
                assert!(result.supported, "reason={:?}", result.reason);
                if result.exact_scope == "pure-idle-macro-v10" {
                    assert!(segmented.prepared_planet_metrics_runtime().is_none());
                }
            }
            assert_eq!(
                segmented.summary().unwrap().canonical_sha256,
                long.summary().unwrap().canonical_sha256,
            );
        }
    }

    #[test]
    fn macro_v10_multi_center_shared_stock_is_split_invariant() {
        for multiplier in [8.0, 12.0, 15.0, 16.0] {
            for center_count in [2, 3, 5] {
                for prebuilt_job_steps in [0, 1_000] {
                    let initial = productive_multi_center_construction_macro_fixture(
                        multiplier,
                        center_count,
                        prebuilt_job_steps,
                    );
                    let mut one_shot = initial.clone();
                    let revision = one_shot.revision;
                    let result = advance_macro_v10(
                        &mut one_shot,
                        &pure_idle_macro_request(revision, 600.0, 600.0 / multiplier),
                    )
                    .unwrap();
                    assert!(
                        result.supported,
                        "{multiplier}x/{center_count} center/{prebuilt_job_steps} WIP one-shot: {:?}",
                        result.reason,
                    );

                    let mut segmented = initial;
                    // Deliberately cross canonical block boundaries at awkward
                    // points. The private carry must make this sequence
                    // equivalent to the single 600-second request.
                    for seconds in [31.0, 7.0, 22.0, 113.0, 5.0, 211.0, 211.0] {
                        let revision = segmented.revision;
                        let result = advance_macro_v10(
                            &mut segmented,
                            &pure_idle_macro_request(revision, seconds, seconds / multiplier),
                        )
                        .unwrap();
                        assert!(
                            result.supported,
                            "{multiplier}x/{center_count} center/{prebuilt_job_steps} WIP segment: {:?}",
                            result.reason,
                        );
                    }

                    assert_eq!(
                        segmented.summary().unwrap().canonical_sha256,
                        one_shot.summary().unwrap().canonical_sha256,
                        "{multiplier}x/{center_count} centers/{prebuilt_job_steps} WIP changed ownership when the same tail was segmented",
                    );
                    assert_eq!(
                        proof_counter(
                            one_shot.base_value()["constructionAutomation"].get("totalCrafted"),
                            "multi-center construction totalCrafted",
                        )
                        .unwrap(),
                        75_000,
                    );
                    assert_eq!(one_shot.base_value()["tray"]["iron_ore"], json!(0.0));
                }
            }
        }
    }

    #[test]
    fn macro_v10_construction_block_carry_survives_private_checkpoint_reload() {
        let initial = productive_construction_macro_fixture(15.0, 1_000);
        let mut exact_boundary = initial.clone();
        let revision = exact_boundary.revision;
        let result = advance_macro_v10(
            &mut exact_boundary,
            &pure_idle_macro_request(revision, 30.0, 2.0),
        )
        .unwrap();
        assert!(result.supported, "reason={:?}", result.reason);

        let mut calibrated = initial;
        let revision = calibrated.revision;
        let result = advance_macro_v10(
            &mut calibrated,
            &pure_idle_macro_request(revision, 31.0, 31.0 / 15.0),
        )
        .unwrap();
        assert!(result.supported, "reason={:?}", result.reason);
        assert_eq!(calibrated.pure_idle_macro_construction_carry_seconds(), 1);
        assert_eq!(
            calibrated.base_value()["construction"],
            exact_boundary.base_value()["construction"],
            "a partial canonical block must not mint construction output",
        );
        assert_eq!(
            calibrated.base_value()["tray"],
            exact_boundary.base_value()["tray"],
            "a partial canonical block must not debit construction material",
        );

        let mut records = BTreeMap::<String, Vec<u8>>::new();
        calibrated
            .visit_internal_checkpoint_records(42, |key, value| {
                records.insert(key.to_owned(), value.as_bytes().to_vec());
                Ok(())
            })
            .unwrap();
        let manifest: Value = serde_json::from_slice(
            &records["dsp-idle-network.internal.v1.chunked.v1.normal.manifest"],
        )
        .unwrap();
        assert_eq!(manifest["pureIdleMacroConstructionCarrySeconds"], 1);

        let mut identity = calibrated.identity.clone();
        identity.revision = calibrated.revision;
        let mut reloaded =
            CoreState::from_internal_records(identity, &records, (*calibrated.catalog).clone())
                .unwrap();
        assert_eq!(reloaded.pure_idle_macro_construction_carry_seconds(), 1);
        assert!(reloaded.pure_idle_macro_runtime.is_none());

        let mut continuous = calibrated;
        for state in [&mut continuous, &mut reloaded] {
            let revision = state.revision;
            let result =
                advance_macro_v10(state, &pure_idle_macro_request(revision, 29.0, 29.0 / 15.0))
                    .unwrap();
            assert!(result.supported, "reason={:?}", result.reason);
            assert_eq!(state.pure_idle_macro_construction_carry_seconds(), 0);
        }
        assert_eq!(
            reloaded.summary().unwrap().canonical_sha256,
            continuous.summary().unwrap().canonical_sha256,
        );
    }

    #[test]
    fn macro_v10_joint_recipe_quantum_construction_is_split_and_reload_invariant() {
        for multiplier in [8.0, 12.0, 15.0, 16.0] {
            let initial = productive_recipe_construction_quantum_macro_fixture(multiplier, 10_000);
            let mut exact_prefix = initial.clone();
            let revision = exact_prefix.revision;
            let exact = advance_macro_v10(
                &mut exact_prefix,
                &pure_idle_macro_request(revision, 30.0, 30.0 / multiplier),
            )
            .unwrap();
            assert!(exact.supported, "{multiplier}x exact: {:?}", exact.reason);
            let exact_crafted = proof_counter(
                exact_prefix.base_value()["constructionAutomation"].get("totalCrafted"),
                "joint exact totalCrafted",
            )
            .unwrap();

            let mut one_shot = initial.clone();
            let revision = one_shot.revision;
            let result = advance_macro_v10(
                &mut one_shot,
                &pure_idle_macro_request(revision, 600.0, 600.0 / multiplier),
            )
            .unwrap();
            assert!(
                result.supported,
                "{multiplier}x one-shot: {:?}",
                result.reason
            );
            let one_shot_crafted = proof_counter(
                one_shot.base_value()["constructionAutomation"].get("totalCrafted"),
                "joint one-shot totalCrafted",
            )
            .unwrap();
            assert!(
                one_shot_crafted > exact_crafted,
                "{multiplier}x macro construction did not spend ordinary macro production: exact={exact_crafted} one-shot={one_shot_crafted} reason={:?} construction={:?} inventory={:?} ordinary_rejection={:?} construction_rejection={:?}",
                result.reason,
                one_shot.base_value().get("construction"),
                one_shot.base_value()["quantumLogisticsNetwork"].get("inventory"),
                one_shot
                    .pure_idle_macro_runtime
                    .as_ref()
                    .and_then(|runtime| runtime.rejection_reason.as_deref()),
                one_shot
                    .pure_idle_macro_runtime
                    .as_ref()
                    .and_then(|runtime| runtime.construction_rejection_reason.as_deref()),
            );
            assert_eq!(
                one_shot.pure_idle_macro_construction_quantum_replay_remaining_seconds(),
                0,
            );

            let mut segmented = initial.clone();
            for seconds in [30.0, 570.0] {
                let revision = segmented.revision;
                let result = advance_macro_v10(
                    &mut segmented,
                    &pure_idle_macro_request(revision, seconds, seconds / multiplier),
                )
                .unwrap();
                assert!(
                    result.supported,
                    "{multiplier}x segmented {seconds}s: {:?}",
                    result.reason
                );
            }
            assert_eq!(
                segmented.summary().unwrap().canonical_sha256,
                one_shot.summary().unwrap().canonical_sha256,
                "{multiplier}x joint settlement changed when segmented",
            );

            if multiplier != 15.0 {
                continue;
            }
            let mut fine_segmented = exact_prefix.clone();
            for seconds in [10.0, 20.0] {
                let revision = fine_segmented.revision;
                let result = advance_macro_v10(
                    &mut fine_segmented,
                    &pure_idle_macro_request(revision, seconds, seconds / multiplier),
                )
                .unwrap();
                assert!(
                    result.supported,
                    "fine segmented {seconds}s: {:?}",
                    result.reason
                );
                let mut records = BTreeMap::<String, Vec<u8>>::new();
                fine_segmented
                    .visit_internal_checkpoint_records(42, |key, value| {
                        records.insert(key.to_owned(), value.as_bytes().to_vec());
                        Ok(())
                    })
                    .unwrap();
                let mut identity = fine_segmented.identity.clone();
                identity.revision = fine_segmented.revision;
                fine_segmented = CoreState::from_internal_records(
                    identity,
                    &records,
                    (*fine_segmented.catalog).clone(),
                )
                .unwrap();
            }
            let revision = fine_segmented.revision;
            let result = advance_macro_v10(
                &mut fine_segmented,
                &pure_idle_macro_request(revision, 540.0, 36.0),
            )
            .unwrap();
            assert!(result.supported, "fine remainder: {:?}", result.reason);
            assert_eq!(
                fine_segmented.summary().unwrap().canonical_sha256,
                one_shot.summary().unwrap().canonical_sha256,
                "sub-block ordinary credits were treated as untracked old quantum inventory",
            );

            let mut checkpointed = initial;
            let revision = checkpointed.revision;
            let first = advance_macro_v10(
                &mut checkpointed,
                &pure_idle_macro_request(revision, 60.0, 4.0),
            )
            .unwrap();
            assert!(first.supported, "checkpoint prefix: {:?}", first.reason);
            assert_eq!(
                checkpointed.pure_idle_macro_construction_quantum_replay_remaining_seconds(),
                0,
            );
            let mut records = BTreeMap::<String, Vec<u8>>::new();
            checkpointed
                .visit_internal_checkpoint_records(42, |key, value| {
                    records.insert(key.to_owned(), value.as_bytes().to_vec());
                    Ok(())
                })
                .unwrap();
            let mut identity = checkpointed.identity.clone();
            identity.revision = checkpointed.revision;
            let mut reloaded = CoreState::from_internal_records(
                identity,
                &records,
                (*checkpointed.catalog).clone(),
            )
            .unwrap();
            assert_eq!(
                reloaded.pure_idle_macro_construction_quantum_replay_remaining_seconds(),
                0,
            );
            let revision = reloaded.revision;
            let remainder = advance_macro_v10(
                &mut reloaded,
                &pure_idle_macro_request(revision, 540.0, 36.0),
            )
            .unwrap();
            assert!(
                remainder.supported,
                "reload remainder: {:?}",
                remainder.reason
            );
            assert_eq!(
                reloaded.summary().unwrap().canonical_sha256,
                one_shot.summary().unwrap().canonical_sha256,
                "consumed quantum replay budget reset after checkpoint reload",
            );
        }
    }

    #[test]
    fn macro_v10_joint_quantum_capacity_horizon_fails_closed_and_is_split_invariant() {
        let mut calibrated = productive_recipe_construction_quantum_macro_fixture(15.0, 10_000);
        let revision = calibrated.revision;
        let result = advance_macro_v10(
            &mut calibrated,
            &pure_idle_macro_request(revision, 30.0, 2.0),
        )
        .unwrap();
        assert!(result.supported, "calibration: {:?}", result.reason);
        calibrated.base_value_mut()["quantumLogisticsNetwork"]["inventory"]["iron_ore"] =
            json!("9990");
        calibrated.base_value_mut()["quantumLogisticsNetwork"]["itemCapacities"]["iron_ore"] =
            json!("10000");
        calibrated.invalidate_prepared_quantum_logistics_directory();

        let mut one_shot = calibrated.clone();
        let revision = one_shot.revision;
        let result = advance_macro_v10(
            &mut one_shot,
            &pure_idle_macro_request(revision, 570.0, 38.0),
        )
        .unwrap();
        assert!(result.supported, "one-shot: {:?}", result.reason);
        assert_eq!(
            one_shot.pure_idle_macro_construction_quantum_replay_remaining_seconds(),
            0,
            "capacity-limited joint flow must permanently forfeit bounded replay",
        );
        assert_eq!(
            one_shot.base_value()["quantumLogisticsNetwork"]["inventory"]["iron_ore"],
            json!("10000"),
        );

        let mut segmented = calibrated;
        let revision = segmented.revision;
        let first = advance_macro_v10(
            &mut segmented,
            &pure_idle_macro_request(revision, 30.0, 2.0),
        )
        .unwrap();
        assert!(first.supported, "first segment: {:?}", first.reason);
        let mut records = BTreeMap::<String, Vec<u8>>::new();
        segmented
            .visit_internal_checkpoint_records(42, |key, value| {
                records.insert(key.to_owned(), value.as_bytes().to_vec());
                Ok(())
            })
            .unwrap();
        let mut identity = segmented.identity.clone();
        identity.revision = segmented.revision;
        let mut reloaded =
            CoreState::from_internal_records(identity, &records, (*segmented.catalog).clone())
                .unwrap();
        let revision = reloaded.revision;
        let remainder = advance_macro_v10(
            &mut reloaded,
            &pure_idle_macro_request(revision, 540.0, 36.0),
        )
        .unwrap();
        assert!(remainder.supported, "remainder: {:?}", remainder.reason);
        assert_eq!(
            reloaded.summary().unwrap().canonical_sha256,
            one_shot.summary().unwrap().canonical_sha256,
            "capacity reopened by construction changed ordinary production after segmentation",
        );
        assert_eq!(
            reloaded.base_value()["totalProduced"],
            one_shot.base_value()["totalProduced"],
        );
        assert_eq!(
            reloaded.base_value()["constructionAutomation"],
            one_shot.base_value()["constructionAutomation"],
        );
    }

    #[test]
    fn macro_v10_joint_quantum_credit_is_released_at_exact_five_second_boundaries() {
        let mut state = productive_recipe_construction_quantum_macro_fixture(15.0, 10_000);
        let revision = state.revision;
        let exact =
            advance_macro_v10(&mut state, &pure_idle_macro_request(revision, 30.0, 2.0)).unwrap();
        assert!(exact.supported, "exact: {:?}", exact.reason);
        let exact_crafted = proof_counter(
            state.base_value()["constructionAutomation"].get("totalCrafted"),
            "boundary exact totalCrafted",
        )
        .unwrap();
        let revision = state.revision;
        let tail =
            advance_macro_v10(&mut state, &pure_idle_macro_request(revision, 30.0, 2.0)).unwrap();
        assert!(tail.supported, "tail: {:?}", tail.reason);
        let crafted = proof_counter(
            state.base_value()["constructionAutomation"].get("totalCrafted"),
            "boundary tail totalCrafted",
        )
        .unwrap()
            - exact_crafted;
        let buffered = state.base_value()["constructionAutomation"]["quantumMaterialBuffer"]
            .as_object()
            .and_then(|buffers| buffers.get("construction-center"))
            .and_then(Value::as_object)
            .and_then(|inventory| inventory.get("iron_ore"))
            .map(|amount| proof_counter(Some(amount), "boundary buffered iron_ore").unwrap())
            .unwrap_or(0);
        assert_eq!(crafted + buffered, 30);
        assert!(
            crafted < 30 && buffered > 0,
            "all thirty seconds of ordinary credit became usable at the first five-second boundary: crafted={crafted} buffered={buffered} reason={:?}",
            tail.reason,
        );
    }

    #[test]
    fn macro_v10_pending_quantum_credit_requires_current_release_rates_atomically() {
        let mut state = productive_recipe_construction_quantum_macro_fixture(15.0, 10_000);
        let revision = state.revision;
        let exact =
            advance_macro_v10(&mut state, &pure_idle_macro_request(revision, 30.0, 2.0)).unwrap();
        assert!(exact.supported, "exact: {:?}", exact.reason);
        let certificate = state
            .pure_idle_macro_runtime
            .as_ref()
            .and_then(|runtime| runtime.construction_certificate.clone())
            .expect("joint fixture has a construction certificate");
        assert!(certificate.quantum.is_some());
        let source_revision = state.revision;
        let source_hash = state.canonical_sha256().unwrap();
        let elapsed = state.base_value()["elapsedSeconds"]
            .as_f64()
            .expect("fixture elapsed clock");

        let error = apply_construction_tail_certificate(
            &mut state,
            &certificate,
            ConstructionTailApplicationRequest {
                elapsed_before: elapsed,
                elapsed_after: elapsed + 30.0,
                isolated_receipt_base_revision: source_revision,
                carry_seconds: 0,
                quantum_replay_remaining_seconds:
                    PURE_IDLE_MACRO_CONSTRUCTION_QUANTUM_REPLAY_SECONDS,
                quantum_pending_credits: BTreeMap::from([("iron_ore".to_owned(), 1)]),
                quantum_credit_rates: &MaterialTotals::new(),
                allow_quantum_replay: true,
            },
            deterministic_runtime(),
        )
        .unwrap_err();
        assert!(
            error.contains("has no current ordinary release rate"),
            "unexpected error: {error}",
        );
        assert_eq!(state.revision, source_revision);
        assert_eq!(state.canonical_sha256().unwrap(), source_hash);
    }

    #[test]
    fn macro_v10_fractional_construction_tail_fails_closed_without_rounding_up() {
        let mut state = productive_recipe_construction_quantum_macro_fixture(15.0, 10_000);
        state.base_value_mut()["elapsedSeconds"] = json!(0.25);
        let source_revision = state.revision;
        let source_hash = state.canonical_sha256().unwrap();

        let result = advance_macro_v10(
            &mut state,
            &pure_idle_macro_request(source_revision, 59.8, 59.8 / 15.0),
        )
        .unwrap();
        assert!(!result.supported);
        assert!(
            result
                .reason
                .as_deref()
                .is_some_and(|reason| reason.contains("whole-second clock boundaries")),
            "unexpected reason: {:?}",
            result.reason,
        );
        assert_eq!(state.revision, source_revision);
        assert_eq!(state.canonical_sha256().unwrap(), source_hash);
    }

    #[test]
    fn macro_v10_construction_tail_stops_at_owned_stock_and_rebuilds_after_reload() {
        let mut stock_limited = productive_construction_macro_fixture(15.0, 100);
        stock_limited.base_value_mut()["tray"]["iron_ore"] = json!(12);
        stock_limited.base_value_mut()["planetTrays"]["home"]["iron_ore"] = json!(12);
        let revision = stock_limited.revision;
        let result = advance_macro_v10(
            &mut stock_limited,
            &pure_idle_macro_request(revision, 600.0, 40.0),
        )
        .unwrap();
        assert!(result.supported, "reason={:?}", result.reason);
        assert_eq!(
            proof_counter(
                stock_limited.base_value()["constructionAutomation"].get("totalCrafted"),
                "stock-limited construction totalCrafted",
            )
            .unwrap(),
            12,
        );
        assert_eq!(stock_limited.base_value()["tray"]["iron_ore"], json!(0.0));
        assert_eq!(
            stock_limited.base_value()["construction"]["test_building"],
            json!(12.0),
        );

        let initial = productive_construction_macro_fixture(15.0, 100);
        let mut continuous = initial.clone();
        let revision = continuous.revision;
        advance_macro_v10(
            &mut continuous,
            &pure_idle_macro_request(revision, 600.0, 40.0),
        )
        .unwrap();

        let mut calibrated = initial;
        let revision = calibrated.revision;
        advance_macro_v10(
            &mut calibrated,
            &pure_idle_macro_request(revision, 30.0, 2.0),
        )
        .unwrap();
        let mut records = BTreeMap::<String, Vec<u8>>::new();
        calibrated
            .visit_internal_checkpoint_records(42, |key, value| {
                records.insert(key.to_owned(), value.as_bytes().to_vec());
                Ok(())
            })
            .unwrap();
        let mut identity = calibrated.identity.clone();
        identity.revision = calibrated.revision;
        let mut reloaded =
            CoreState::from_internal_records(identity, &records, (*calibrated.catalog).clone())
                .unwrap();
        assert!(reloaded.pure_idle_macro_runtime.is_none());
        let revision = reloaded.revision;
        let result = advance_macro_v10(
            &mut reloaded,
            &pure_idle_macro_request(revision, 570.0, 38.0),
        )
        .unwrap();
        assert!(result.supported, "reason={:?}", result.reason);
        assert_eq!(
            reloaded.summary().unwrap().canonical_sha256,
            continuous.summary().unwrap().canonical_sha256,
        );
    }

    #[test]
    fn macro_v10_construction_tail_freezes_without_permanent_renewable_power() {
        let mut initial = productive_construction_macro_fixture(15.0, 100);
        let wind_definition = initial.catalog.buildings["wind_turbine"].clone();
        let mut accumulator_definition = wind_definition;
        accumulator_definition.id = "accumulator".to_owned();
        accumulator_definition.energy_capacity_mj = 1.0e18;
        std::sync::Arc::make_mut(&mut initial.catalog)
            .buildings
            .insert("accumulator".to_owned(), accumulator_definition);
        let wind_index = initial.entity_index.get("wind").copied().unwrap();
        let mut accumulator = initial.parse_entity(wind_index).unwrap();
        accumulator["buildingId"] = json!("accumulator");
        accumulator["storedEnergyMj"] = json!(1.0e18);
        initial.replace_entity_raw(
            wind_index,
            serde_json::to_string(&accumulator).unwrap().into(),
        );

        let mut prefix = initial.clone();
        let revision = prefix.revision;
        let prefix_result =
            advance_macro_v10(&mut prefix, &pure_idle_macro_request(revision, 30.0, 2.0)).unwrap();
        assert!(prefix_result.supported, "reason={:?}", prefix_result.reason);

        let mut long = initial;
        let revision = long.revision;
        let result =
            advance_macro_v10(&mut long, &pure_idle_macro_request(revision, 600.0, 40.0)).unwrap();
        assert!(result.supported, "reason={:?}", result.reason);
        assert!(
            result.reason.as_deref().is_some_and(|reason| {
                reason.contains("construction tail froze")
                    && reason.contains("finite generation or storage")
            }),
            "reason={:?}",
            result.reason,
        );
        assert_eq!(
            long.base_value()["construction"],
            prefix.base_value()["construction"],
            "the uncertified tail must not repeat construction work",
        );
        assert_eq!(
            long.base_value()["constructionAutomation"]["totalCrafted"],
            prefix.base_value()["constructionAutomation"]["totalCrafted"],
        );
        assert_eq!(
            long.base_value()["tray"],
            prefix.base_value()["tray"],
            "the uncertified tail must not spend another material unit",
        );
    }

    #[test]
    fn macro_v10_construction_tail_never_downloads_new_quantum_material() {
        let mut initial = productive_construction_macro_fixture(15.0, 100);
        initial.base_value_mut()["tray"]["iron_ore"] = json!(0);
        initial.base_value_mut()["planetTrays"]["home"]["iron_ore"] = json!(0);
        initial.base_value_mut()["constructionAutomation"]["quantumSourceEnabled"] = json!(true);
        initial.base_value_mut()["quantumLogisticsNetwork"]["enabled"] = json!(true);
        initial.base_value_mut()["quantumLogisticsNetwork"]["inventory"]["iron_ore"] = json!(100);
        initial.base_value_mut()["quantumLogisticsNetwork"]["itemCapacities"]["iron_ore"] =
            json!("1000");

        let mut prefix = initial.clone();
        let revision = prefix.revision;
        let prefix_result =
            advance_macro_v10(&mut prefix, &pure_idle_macro_request(revision, 30.0, 2.0)).unwrap();
        assert!(prefix_result.supported, "reason={:?}", prefix_result.reason);
        let network_after_prefix =
            prefix.base_value()["quantumLogisticsNetwork"]["inventory"].clone();
        let crafted_after_prefix = proof_counter(
            prefix.base_value()["constructionAutomation"].get("totalCrafted"),
            "prefix construction totalCrafted",
        )
        .unwrap();

        let mut long = initial;
        let revision = long.revision;
        let result =
            advance_macro_v10(&mut long, &pure_idle_macro_request(revision, 600.0, 40.0)).unwrap();
        assert!(result.supported, "reason={:?}", result.reason);
        assert_eq!(
            long.base_value()["quantumLogisticsNetwork"]["inventory"],
            network_after_prefix,
            "only the bounded exact prefix may download from global quantum inventory",
        );
        let crafted_after_long = proof_counter(
            long.base_value()["constructionAutomation"].get("totalCrafted"),
            "long construction totalCrafted",
        )
        .unwrap();
        assert!(crafted_after_long >= crafted_after_prefix);
        assert!(crafted_after_long <= 100);
    }

    #[test]
    fn macro_v10_construction_certificate_failure_is_atomic() {
        let mut state = productive_construction_macro_fixture(15.0, 100);
        let revision = state.revision;
        let result =
            advance_macro_v10(&mut state, &pure_idle_macro_request(revision, 30.0, 2.0)).unwrap();
        assert!(result.supported, "reason={:?}", result.reason);
        let certificate = state
            .pure_idle_macro_runtime
            .as_mut()
            .and_then(|runtime| runtime.construction_certificate.as_mut())
            .expect("construction certificate");
        certificate.center_entity_ids[0] = "forged-center".to_owned();

        let before_revision = state.revision;
        let before_hash = state.summary().unwrap().canonical_sha256;
        let before_credit = state.pure_idle_macro_exact_seconds_used();
        let before_state = state.materialize().unwrap();
        let result = advance_macro_v10(
            &mut state,
            &pure_idle_macro_request(before_revision, 570.0, 38.0),
        )
        .unwrap();
        assert!(!result.supported);
        assert!(
            result
                .reason
                .as_deref()
                .is_some_and(|reason| reason.contains("construction center identity changed")),
            "reason={:?}",
            result.reason,
        );
        assert_eq!(state.revision, before_revision);
        assert_eq!(state.summary().unwrap().canonical_sha256, before_hash);
        assert_eq!(state.pure_idle_macro_exact_seconds_used(), before_credit);
        assert_eq!(state.materialize().unwrap(), before_state);
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
    fn forged_internal_construction_candidate_is_rejected_without_mutating_source() {
        let live = construction_powered_fixture();
        let before = capture_settlement_snapshot(&live).unwrap();
        let source_revision = live.revision;
        let source_hash = live.canonical_sha256().unwrap();
        let source_bytes = live.materialize().unwrap();

        let mut forged = live.clone();
        forged.base_value_mut()["tray"]["iron_ore"] = json!(9);
        forged.base_value_mut()["planetTrays"]["home"]["iron_ore"] = json!(9);
        forged.base_value_mut()["construction"]["test_building"] = json!(1);
        forged.base_value_mut()["constructionAutomation"]["totalCrafted"] = json!(1);
        let failure = prove_internal_exact_settlement_candidate(&before, forged).unwrap_err();
        assert!(
            failure.contains("stage receipt"),
            "unexpected failure: {failure}"
        );

        assert_eq!(live.revision, source_revision);
        assert_eq!(live.canonical_sha256().unwrap(), source_hash);
        assert_eq!(live.materialize().unwrap(), source_bytes);
    }

    #[test]
    fn cancelled_exact_candidate_receipt_is_cow_isolated_from_source() {
        let source = construction_powered_fixture();
        let before = capture_settlement_snapshot(&source).unwrap();
        let source_revision = source.revision;
        let source_hash = source.canonical_sha256().unwrap();
        let source_bytes = source.materialize().unwrap();

        let mut cancelled = source.clone();
        let result = cancelled
            .advance_exact(&exact_request(source_revision, 6.0, 0.4))
            .unwrap();
        assert!(result.supported, "unexpected reason: {:?}", result.reason);
        assert!(
            cancelled
                .prepared_construction_runtime()
                .and_then(|runtime| runtime.receipt_between(source_revision, cancelled.revision))
                .is_some(),
            "the disposable candidate itself owns its exact receipt",
        );
        assert_eq!(
            source
                .prepared_construction_runtime()
                .and_then(|runtime| runtime.receipt_between(source_revision, cancelled.revision)),
            None,
            "Arc::make_mut must not publish a cancelled candidate's receipt",
        );

        // Matching the cancelled candidate's revision is insufficient: a new
        // candidate cloned from the unchanged source has no private interval
        // receipt and therefore cannot borrow the discarded authority.
        let mut forged_same_revision = source.clone();
        forged_same_revision.revision = cancelled.revision;
        forged_same_revision.base_value_mut()["tray"]["iron_ore"] = json!(9);
        forged_same_revision.base_value_mut()["planetTrays"]["home"]["iron_ore"] = json!(9);
        forged_same_revision.base_value_mut()["construction"]["test_building"] = json!(1);
        forged_same_revision.base_value_mut()["constructionAutomation"]["totalCrafted"] = json!(1);
        let failure =
            prove_internal_exact_settlement_candidate(&before, forged_same_revision).unwrap_err();
        assert!(
            failure.contains("construction recipe input receipt is missing"),
            "unexpected failure: {failure}",
        );

        assert_eq!(source.revision, source_revision);
        assert_eq!(source.canonical_sha256().unwrap(), source_hash);
        assert_eq!(source.materialize().unwrap(), source_bytes);
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

        let mut after = capture_settlement_snapshot(&candidate).unwrap();
        after.construction_receipt = Some(ConstructionRunReceipt::for_test(
            BTreeMap::from([("test_building".to_owned(), 1)]),
            1,
        ));
        validate_internal_exact_snapshots(&before, &after, &candidate.catalog).unwrap();
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

        let mut after = capture_settlement_snapshot(&candidate).unwrap();
        after.construction_receipt = Some(ConstructionRunReceipt::for_test(
            BTreeMap::from([("test_building".to_owned(), 1)]),
            1,
        ));
        assert!(validate_internal_exact_snapshots(&before, &after, &candidate.catalog).is_ok());
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
        let mut after = capture_settlement_snapshot(&candidate).unwrap();
        after.construction_receipt = Some(ConstructionRunReceipt::for_test(BTreeMap::new(), 1));
        assert!(validate_internal_exact_snapshots(&before, &after, &candidate.catalog).is_ok());

        // WIP disappearing without the corresponding portable-fleet receipt
        // is not a construction completion source, even on the trusted exact
        // candidate path.
        let mut vanished = live.clone();
        vanished.base_value_mut()["constructionAutomation"]["jobs"] = json!({});
        vanished.base_value_mut()["constructionAutomation"]["totalCrafted"] = json!(1);
        let mut after = capture_settlement_snapshot(&vanished).unwrap();
        after.construction_receipt = Some(ConstructionRunReceipt::for_test(BTreeMap::new(), 1));
        let failure =
            validate_internal_exact_snapshots(&before, &after, &vanished.catalog).unwrap_err();
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
    fn offline_macro_v1_is_productive_at_one_x_without_persisting_time_warp_credit() {
        for resource_mode in ["finite", "infinite"] {
            let initial = as_offline_fixture(productive_quantum_macro_fixture(15.0, resource_mode));
            let before = capture_settlement_snapshot(&initial).unwrap();

            let mut prefix = initial.clone();
            let revision = prefix.revision;
            let prefix_result =
                advance_offline_macro_v1(&mut prefix, &offline_macro_request(revision, 30.0))
                    .unwrap();
            assert!(prefix_result.supported, "reason={:?}", prefix_result.reason);
            assert_eq!(prefix_result.exact_calibration_seconds, Some(30.0));
            assert_eq!(prefix_result.approximated_seconds, Some(0.0));

            let mut long = initial;
            let revision = long.revision;
            let result =
                advance_offline_macro_v1(&mut long, &offline_macro_request(revision, 600.0))
                    .unwrap();
            assert!(result.supported, "reason={:?}", result.reason);
            assert_eq!(result.exact_scope, "offline-macro-v1");
            assert_eq!(result.exact_calibration_seconds, Some(30.0));
            assert_eq!(result.approximated_seconds, Some(570.0));
            assert!(
                number_at(long.base_value().get("totalProduced"), &["iron_ore"])
                    > number_at(prefix.base_value().get("totalProduced"), &["iron_ore"]),
                "offline tail should credit certified live production"
            );
            assert_eq!(long.pure_idle_macro_exact_seconds_used(), 0.0);
            assert!(long.pure_idle_macro_runtime.is_none());
            let after = capture_settlement_snapshot(&long).unwrap();
            validate_settlement_proof(&before, &after, &long.catalog, None).unwrap();
        }
    }

    #[test]
    fn offline_macro_v1_budget_and_clock_authority_fail_atomically() {
        let mut active_time_warp = productive_quantum_macro_fixture(15.0, "infinite");
        let source_hash = active_time_warp.summary().unwrap().canonical_sha256;
        let source_revision = active_time_warp.revision;
        let result = advance_offline_macro_v1(
            &mut active_time_warp,
            &offline_macro_request(source_revision, 600.0),
        )
        .unwrap();
        assert!(!result.supported);
        assert_eq!(
            result.reason.as_deref(),
            Some("offline-macro-time-warp-active")
        );
        assert_eq!(active_time_warp.revision, source_revision);
        assert_eq!(
            active_time_warp.summary().unwrap().canonical_sha256,
            source_hash
        );

        let mut wrong_ratio =
            as_offline_fixture(productive_quantum_macro_fixture(15.0, "infinite"));
        let source_hash = wrong_ratio.summary().unwrap().canonical_sha256;
        let source_revision = wrong_ratio.revision;
        let request = CoreAdvanceRequest {
            base_revision: source_revision,
            simulation_seconds: 600.0,
            wall_seconds: 40.0,
            advance_mode: CoreAdvanceMode::OfflineMacroV1,
            include_diagnostics: false,
        };
        let result = advance_offline_macro_v1(&mut wrong_ratio, &request).unwrap();
        assert!(!result.supported);
        assert_eq!(
            result.reason.as_deref(),
            Some("offline-macro-budget-must-match-wall-time")
        );
        assert_eq!(wrong_ratio.revision, source_revision);
        assert_eq!(wrong_ratio.summary().unwrap().canonical_sha256, source_hash);
    }

    #[test]
    fn offline_macro_v1_prefilled_rockets_require_a_closed_long_tail() {
        let initial = as_offline_fixture(productive_rocket_macro_fixture(
            15.0, "infinite", 2, 1, 10_000,
        ));
        let before = capture_settlement_snapshot(&initial).unwrap();
        let before_hash = initial.summary().unwrap().canonical_sha256;
        let mut prefix = initial.clone();
        let revision = prefix.revision;
        assert!(
            advance_offline_macro_v1(&mut prefix, &offline_macro_request(revision, 30.0))
                .unwrap()
                .supported
        );
        let mut settled = initial;
        let revision = settled.revision;
        let result =
            advance_offline_macro_v1(&mut settled, &offline_macro_request(revision, 600.0))
                .unwrap();
        assert!(!result.supported, "reason={:?}", result.reason);
        assert!(
            result
                .reason
                .as_deref()
                .is_some_and(|reason| reason.contains("offline-ordinary-tail-uncertified"))
        );
        assert_eq!(settled.revision, revision);
        assert_eq!(settled.summary().unwrap().canonical_sha256, before_hash);
        let after = capture_settlement_snapshot(&prefix).unwrap();
        validate_settlement_proof(&before, &after, &settled.catalog, None).unwrap();
        let launches = after.dyson.rockets_launched - before.dyson.rockets_launched;
        assert!(launches > 0);
        let produced = material_delta(&before.produced, &after.produced, TERMINAL_ROCKET_ITEM_ID);
        let stock_spent = before
            .owned
            .get(TERMINAL_ROCKET_ITEM_ID)
            .copied()
            .unwrap_or(0)
            - after
                .owned
                .get(TERMINAL_ROCKET_ITEM_ID)
                .copied()
                .unwrap_or(0);
        assert!(launches <= produced + stock_spent);
        assert_eq!(
            after.dyson.structure_points - before.dyson.structure_points,
            launches
        );
    }

    #[test]
    fn offline_macro_v1_construction_uses_real_stock_on_stable_renewable_power() {
        let initial = as_offline_fixture(productive_construction_macro_fixture(15.0, 1_000));
        let before = capture_settlement_snapshot(&initial).unwrap();
        let mut settled = initial;
        let revision = settled.revision;
        let result =
            advance_offline_macro_v1(&mut settled, &offline_macro_request(revision, 600.0))
                .unwrap();
        assert!(result.supported, "reason={:?}", result.reason);
        let crafted = number_at(
            settled.base_value().get("constructionAutomation"),
            &["totalCrafted"],
        );
        assert!(crafted > 0.0);
        assert_eq!(
            number_at(settled.base_value().get("construction"), &["test_building"]),
            crafted
        );
        let after = capture_settlement_snapshot(&settled).unwrap();
        assert!(
            after.owned.get("iron_ore").copied().unwrap_or(0)
                < before.owned.get("iron_ore").copied().unwrap_or(0)
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
        assert!(
            MACRO_V10_ALGORITHM_VERSION.encode_utf16().count() <= 128,
            "desktop authority boundary accepts at most 128 UTF-16 units",
        );
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
    fn macro_v10_bounded_handcraft_tail_is_split_invariant_at_supported_multipliers() {
        for multiplier in [8.0, 12.0, 15.0, 16.0] {
            let mut calibrated = bounded_handcraft_macro_fixture(multiplier, 1_200, 1_200);
            let revision = calibrated.revision;
            let result = advance_macro_v10(
                &mut calibrated,
                &pure_idle_macro_request(revision, 30.0, 30.0 / multiplier),
            )
            .unwrap();
            assert!(result.supported, "reason={:?}", result.reason);
            assert_eq!(
                proof_counter(
                    calibrated.base_value()["totalProduced"].get("iron_ingot"),
                    "calibrated handcraft iron ingot",
                )
                .unwrap(),
                30
            );
            assert_eq!(calibrated.pure_idle_macro_exact_seconds_used(), 30.0);
            let calibrated_state = calibrated.materialize().unwrap();

            let mut long = calibrated.clone();
            let revision = long.revision;
            let result = advance_macro_v10(
                &mut long,
                &pure_idle_macro_request(revision, 570.0, 570.0 / multiplier),
            )
            .unwrap();
            assert!(result.supported, "reason={:?}", result.reason);
            assert!(
                result
                    .reason
                    .as_deref()
                    .is_some_and(|reason| reason.contains("bounded handcraft tail completed 570")),
                "reason={:?}",
                result.reason
            );

            let mut segmented = calibrated;
            for seconds in std::iter::repeat_n(1.0, 5)
                .chain(std::iter::repeat_n(5.0, 5))
                .chain(std::iter::repeat_n(60.0, 9))
            {
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
            let state = long.materialize().unwrap();
            assert_eq!(state["totalProduced"]["iron_ingot"], json!(600));
            assert_eq!(state["tray"]["iron_ore"], json!(600));
            assert_eq!(state["planetTrays"]["home"], state["tray"]);
            assert_eq!(state["handcraftQueue"][0]["batchesRemaining"], json!(600));
            for frozen in [
                "entities",
                "research",
                "construction",
                "constructionAutomation",
                "dysonSwarm",
                "dysonSphere",
                "dysonEngineering",
                "dysonPlans",
                "endgame",
            ] {
                assert_eq!(state[frozen], calibrated_state[frozen], "field={frozen}");
            }
        }
    }

    #[test]
    fn macro_v10_bounded_handcraft_uses_only_real_stock_and_freezes_oversized_queues() {
        let mut finite_stock = bounded_handcraft_macro_fixture(15.0, 100, 12);
        finite_stock.base_value_mut()["settings"]["resourceMode"] = json!("finite");
        finite_stock.base_value_mut()["totalProduced"]["iron_ore"] = json!(1_000_000);
        finite_stock
            .install_pure_idle_macro_session_progress(30.0)
            .unwrap();
        let revision = finite_stock.revision;
        let result = advance_macro_v10(
            &mut finite_stock,
            &pure_idle_macro_request(revision, 60.0, 4.0),
        )
        .unwrap();
        assert!(result.supported, "reason={:?}", result.reason);
        assert!(
            result
                .reason
                .as_deref()
                .is_some_and(|reason| reason.contains("proven inventory/output/planet horizon")),
            "reason={:?}",
            result.reason
        );
        let state = finite_stock.materialize().unwrap();
        assert_eq!(state["tray"]["iron_ore"], json!(0));
        assert_eq!(state["totalProduced"]["iron_ore"], json!(1_000_000));
        assert_eq!(state["totalProduced"]["iron_ingot"], json!(12));
        assert_eq!(state["handcraftQueue"][0]["batchesRemaining"], json!(88));

        let mut oversized = bounded_handcraft_macro_fixture(15.0, 4_097, 4_097);
        oversized
            .install_pure_idle_macro_session_progress(30.0)
            .unwrap();
        let before = oversized.materialize().unwrap();
        let revision = oversized.revision;
        let result = advance_macro_v10(
            &mut oversized,
            &pure_idle_macro_request(revision, 60.0, 4.0),
        )
        .unwrap();
        assert!(result.supported, "reason={:?}", result.reason);
        assert!(
            result
                .reason
                .as_deref()
                .is_some_and(|reason| reason.contains("bounded tail limit is 4096")),
            "reason={:?}",
            result.reason
        );
        let after = oversized.materialize().unwrap();
        for field in [
            "tray",
            "planetTrays",
            "portableFleet",
            "totalProduced",
            "handcraftQueue",
        ] {
            assert_eq!(after[field], before[field], "field={field}");
        }
        assert_eq!(after["elapsedSeconds"], json!(60.0));
    }

    #[test]
    fn macro_v10_bounded_handcraft_reload_discard_and_failure_are_atomic() {
        let mut calibrated = bounded_handcraft_macro_fixture(15.0, 1_200, 1_200);
        let revision = calibrated.revision;
        let result = advance_macro_v10(
            &mut calibrated,
            &pure_idle_macro_request(revision, 30.0, 2.0),
        )
        .unwrap();
        assert!(result.supported, "reason={:?}", result.reason);

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

        let source = bounded_handcraft_macro_fixture(15.0, 100, 100);
        let source_hash = source.summary().unwrap().canonical_sha256;
        let mut discarded_candidate = source.clone();
        discarded_candidate
            .install_pure_idle_macro_session_progress(30.0)
            .unwrap();
        let revision = discarded_candidate.revision;
        let result = advance_macro_v10(
            &mut discarded_candidate,
            &pure_idle_macro_request(revision, 60.0, 4.0),
        )
        .unwrap();
        assert!(result.supported, "reason={:?}", result.reason);
        assert_eq!(source.summary().unwrap().canonical_sha256, source_hash);

        let mut overflow = bounded_handcraft_macro_fixture(15.0, 1, 1);
        overflow.base_value_mut()["totalProduced"]["iron_ingot"] = json!(9_007_199_254_740_991_i64);
        overflow
            .install_pure_idle_macro_session_progress(30.0)
            .unwrap();
        let before_hash = overflow.summary().unwrap().canonical_sha256;
        let before_revision = overflow.revision;
        let before_credit = overflow.pure_idle_macro_exact_seconds_used();
        let result = advance_macro_v10(
            &mut overflow,
            &pure_idle_macro_request(before_revision, 1.0, 1.0 / 15.0),
        )
        .unwrap();
        assert!(!result.supported);
        assert!(
            result
                .reason
                .as_deref()
                .is_some_and(|reason| reason.contains("pure-idle-bounded-handcraft-rejected")),
            "reason={:?}",
            result.reason
        );
        assert_eq!(overflow.summary().unwrap().canonical_sha256, before_hash);
        assert_eq!(overflow.revision, before_revision);
        assert_eq!(overflow.pure_idle_macro_exact_seconds_used(), before_credit);
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
    fn discarded_three_window_probe_keeps_live_belt_workspace_reusable() {
        let multiplier = 8.0;
        let mut live = productive_closed_recipe_macro_fixture(multiplier);
        let first = live
            .advance_exact(&CoreAdvanceRequest {
                include_diagnostics: true,
                ..exact_request(live.revision, 1.0, 1.0 / multiplier)
            })
            .unwrap();
        assert!(first.supported, "reason={:?}", first.reason);
        let first_activity = live.prepared_belt_activity().unwrap();
        let resident_bytes = first_activity.estimated_bytes();
        assert!(resident_bytes > 0);

        let probe_request = pure_idle_macro_request(live.revision, 600.0, 600.0 / multiplier);
        let snapshots = exact_three_window_probe(&live, &probe_request).unwrap();
        assert_eq!(snapshots.len(), 4);
        assert!(
            live.prepared_belt_activity().unwrap().estimated_bytes() >= resident_bytes,
            "a disposable probe must return the shared factory-sized scratch pool"
        );

        let revision = live.revision;
        let second = live
            .advance_exact(&CoreAdvanceRequest {
                include_diagnostics: true,
                ..exact_request(revision, 1.0, 1.0 / multiplier)
            })
            .unwrap();
        assert!(second.supported, "reason={:?}", second.reason);
        let scheduler = second.belt_scheduler.expect("belt diagnostics");
        assert!(scheduler.runtime_workspace_reused);
        assert_eq!(scheduler.runtime_workspace_initialized_route_rows, 0);
        assert_eq!(scheduler.runtime_workspace_initialized_group_rows, 0);
        assert_eq!(scheduler.runtime_workspace_initialized_target_rows, 0);
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
                || rejection.contains("no certified vein source or active producer"),
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
    fn macro_v10_rocket_sink_supports_finite_sources_and_freezes_unfunded_domains() {
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
            600
        );
        assert!(
            result
                .reason
                .as_deref()
                .is_some_and(|reason| reason.contains("material-funded rocket")),
            "reason={:?}",
            result.reason
        );
        assert!(
            proof_counter(
                finite.parse_entity(2).unwrap().get("resourceRemaining"),
                "finite.resourceRemaining",
            )
            .unwrap()
                < 1_000_000
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
        let mut macro_snapshot = capture_settlement_snapshot(&macro_prefix).unwrap();
        let mut exact_snapshot = capture_settlement_snapshot(&exact).unwrap();
        // Revision and the private receipt are execution evidence, not part of
        // the persisted material equivalence asserted by this regression.
        macro_snapshot.revision = 0;
        exact_snapshot.revision = 0;
        macro_snapshot.construction_receipt = None;
        exact_snapshot.construction_receipt = None;
        assert_eq!(macro_snapshot, exact_snapshot);
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
    fn macro_v10_dynamic_ray_sail_tail_with_permanent_headroom_is_productive_and_split_invariant() {
        let initial = sustainable_dynamic_ray_power_fixture(14.0);
        assert!(has_dynamic_ray_power_source(&initial).unwrap());
        let request = pure_idle_macro_request(initial.revision, 600.0, 600.0 / 14.0);
        let snapshots = exact_three_window_probe(&initial, &request).unwrap();
        let certificate = build_ordinary_flow_certificate(&initial, &snapshots).unwrap();
        let power = certificate
            .renewable_power
            .as_ref()
            .expect("dynamic ray-powered sail tail has a renewable proof");
        assert_eq!(power.controller_entity_id, "controller");
        let controller_grant = &power.grids[&power.controller_grid];
        assert_eq!(controller_grant.static_generation_floor_kw.get(), 0.0);
        assert!(controller_grant.ray_generation_floor_kw.get() > 0.0);
        assert!(
            controller_grant.ray_generation_floor_kw.get()
                >= controller_grant.demand_ceiling_kw.get()
        );

        let mut prefix = initial.clone();
        let revision = prefix.revision;
        let result = advance_macro_v10(
            &mut prefix,
            &pure_idle_macro_request(revision, 30.0, 30.0 / 14.0),
        )
        .unwrap();
        assert!(result.supported, "reason={:?}", result.reason);
        let prefix_terminal = capture_dyson_terminal(prefix.base_value()).unwrap();

        let mut long = initial.clone();
        let revision = long.revision;
        let result = advance_macro_v10(
            &mut long,
            &pure_idle_macro_request(revision, 600.0, 600.0 / 14.0),
        )
        .unwrap();
        assert!(result.supported, "reason={:?}", result.reason);
        let long_terminal = capture_dyson_terminal(long.base_value()).unwrap();
        assert_eq!(
            long_terminal.sails_launched - prefix_terminal.sails_launched,
            570
        );
        assert_eq!(
            long_terminal.rockets_launched,
            prefix_terminal.rockets_launched
        );
        assert_eq!(
            long_terminal.structure_points,
            prefix_terminal.structure_points
        );
        assert!(long_terminal.sails_absorbed >= prefix_terminal.sails_absorbed);
        assert!(long_terminal.shell_sails >= prefix_terminal.shell_sails);
        let before = capture_settlement_snapshot(&initial).unwrap();
        let after = capture_settlement_snapshot(&long).unwrap();
        validate_settlement_proof(&before, &after, &long.catalog, None).unwrap();

        // The certificate is permanent rather than a finite energy coupon.
        // Consequently an arbitrary 1/5/60 boundary shape cannot recalibrate
        // or reissue extra exact power credit.
        let mut segmented = initial.clone();
        for seconds in [30.0, 1.0, 5.0, 60.0, 504.0] {
            let revision = segmented.revision;
            let result = advance_macro_v10(
                &mut segmented,
                &pure_idle_macro_request(revision, seconds, seconds / 14.0),
            )
            .unwrap();
            assert!(result.supported, "reason={:?}", result.reason);
        }
        assert_eq!(
            segmented.summary().unwrap().canonical_sha256,
            long.summary().unwrap().canonical_sha256,
        );

        let mut reloaded = prefix.clone();
        reloaded.pure_idle_macro_runtime = None;
        let revision = reloaded.revision;
        let result = advance_macro_v10(
            &mut reloaded,
            &pure_idle_macro_request(revision, 570.0, 570.0 / 14.0),
        )
        .unwrap();
        assert!(result.supported, "reason={:?}", result.reason);
        assert_eq!(
            reloaded.summary().unwrap().canonical_sha256,
            long.summary().unwrap().canonical_sha256,
        );

        // A private certificate that overstates its monotonic Dyson floor is
        // rejected before any candidate mutation; the source's canonical
        // state, revision and exact-credit runtime remain untouched.
        let source_hash = initial.summary().unwrap().canonical_sha256;
        let source_revision = initial.revision;
        let source_exact_credit = initial.pure_idle_macro_exact_seconds_used();
        let mut wrong_controller = certificate.clone();
        wrong_controller
            .renewable_power
            .as_mut()
            .unwrap()
            .controller_entity_id = "same-grid-impostor".to_owned();
        let mut disposable = initial.clone();
        let rejection =
            apply_ordinary_flow_certificate(&mut disposable, &mut wrong_controller, 0.0, 570.0)
                .unwrap_err();
        assert!(
            rejection.contains("no longer matches time-warp authority"),
            "{rejection}"
        );
        assert_eq!(disposable.summary().unwrap().canonical_sha256, source_hash);
        assert_eq!(disposable.revision, source_revision);

        let mut corrupted = certificate;
        *corrupted
            .renewable_power
            .as_mut()
            .unwrap()
            .structure_floor_by_system
            .get_mut("helios")
            .unwrap() += 1;
        let mut disposable = initial.clone();
        let rejection =
            apply_ordinary_flow_certificate(&mut disposable, &mut corrupted, 0.0, 570.0)
                .unwrap_err();
        assert!(
            rejection.contains("structure power floor regressed"),
            "{rejection}"
        );
        assert_eq!(disposable.summary().unwrap().canonical_sha256, source_hash);
        assert_eq!(disposable.revision, source_revision);
        assert_eq!(
            disposable.pure_idle_macro_exact_seconds_used(),
            source_exact_credit
        );
        assert_eq!(initial.summary().unwrap().canonical_sha256, source_hash);
        assert_eq!(initial.revision, source_revision);
        assert_eq!(
            initial.pure_idle_macro_exact_seconds_used(),
            source_exact_credit
        );
    }

    #[test]
    fn macro_v10_transient_ray_power_sail_tail_fails_closed_and_is_split_invariant() {
        let initial = transient_dynamic_ray_power_fixture(14.0);
        assert!(has_dynamic_ray_power_source(&initial).unwrap());

        // Certificate construction is a disposable read-only probe. Rejecting
        // the unsafe energy combination must not spend revision, exact credit
        // or alter the player's canonical source state.
        let source_hash = initial.summary().unwrap().canonical_sha256;
        let source_revision = initial.revision;
        let request = pure_idle_macro_request(source_revision, 600.0, 600.0 / 14.0);
        let snapshots = exact_three_window_probe(&initial, &request).unwrap();
        let rejection = build_ordinary_flow_certificate(&initial, &snapshots).unwrap_err();
        assert!(
            rejection.contains("renewable lower-bound supply"),
            "{rejection}"
        );
        assert_eq!(initial.summary().unwrap().canonical_sha256, source_hash);
        assert_eq!(initial.revision, source_revision);
        assert_eq!(initial.pure_idle_macro_exact_seconds_used(), 0.0);

        let mut exact_prefix = initial.clone();
        let revision = exact_prefix.revision;
        let result = advance_macro_v10(
            &mut exact_prefix,
            &pure_idle_macro_request(revision, 30.0, 30.0 / 14.0),
        )
        .unwrap();
        assert!(result.supported, "reason={:?}", result.reason);
        let prefix_state = exact_prefix.materialize().unwrap();

        let mut long = initial.clone();
        let revision = long.revision;
        let result = advance_macro_v10(
            &mut long,
            &pure_idle_macro_request(revision, 600.0, 600.0 / 14.0),
        )
        .unwrap();
        assert!(result.supported, "reason={:?}", result.reason);
        assert!(
            result
                .reason
                .as_deref()
                .is_some_and(|reason| reason.contains("renewable lower-bound supply")),
            "reason={:?}",
            result.reason,
        );
        let long_state = long.materialize().unwrap();
        for frozen in [
            "entities",
            "belts",
            "totalProduced",
            "quantumLogisticsNetwork",
            "research",
            "construction",
            "constructionAutomation",
            "dysonSwarm",
            "dysonSphere",
            "dysonEngineering",
            "dysonPlans",
            "endgame",
        ] {
            assert_eq!(long_state[frozen], prefix_state[frozen], "field={frozen}");
        }
        assert_eq!(number_at(Some(&long_state), &["elapsedSeconds"]), 600.0);

        // One long window and 1/5/60-second boundary shapes retain identical
        // public bytes even though every unsafe productive tail freezes.
        let mut segmented = initial;
        for seconds in [30.0, 1.0, 5.0, 60.0, 504.0] {
            let revision = segmented.revision;
            let result = advance_macro_v10(
                &mut segmented,
                &pure_idle_macro_request(revision, seconds, seconds / 14.0),
            )
            .unwrap();
            assert!(result.supported, "reason={:?}", result.reason);
        }
        assert_eq!(
            segmented.summary().unwrap().canonical_sha256,
            long.summary().unwrap().canonical_sha256,
        );

        // Independent static renewable generation keeps the established sail
        // certificate and productive path; the new gate is narrowly scoped.
        let static_renewable = productive_solar_sail_launch_macro_fixture(15.0);
        assert!(!has_dynamic_ray_power_source(&static_renewable).unwrap());
        let static_request = pure_idle_macro_request(static_renewable.revision, 600.0, 40.0);
        let static_snapshots =
            exact_three_window_probe(&static_renewable, &static_request).unwrap();
        let static_certificate =
            build_ordinary_flow_certificate(&static_renewable, &static_snapshots).unwrap();
        assert!(static_certificate.dyson_sail.is_some());
        assert!(static_certificate.renewable_power.is_none());
    }

    #[test]
    fn renewable_power_proof_rejects_finite_energy_and_unpowered_peer_grids() {
        let initial = sustainable_dynamic_ray_power_fixture(14.0);
        let request = pure_idle_macro_request(initial.revision, 600.0, 600.0 / 14.0);
        let snapshots = exact_three_window_probe(&initial, &request).unwrap();
        build_renewable_power_tail_certificate_for_test(&initial, &snapshots).unwrap();

        for finite_field in ["thermal", "storage-discharge", "storage-charge"] {
            let mut finite = snapshots.clone();
            for snapshot in finite.iter_mut().skip(1) {
                let grid = snapshot
                    .renewable_power
                    .grids
                    .get_mut(&PowerGridKey {
                        planet_id: "home".to_owned(),
                        grid_id: "grid-a".to_owned(),
                    })
                    .unwrap();
                let value = PowerProofScalar::from_f64(1.0, finite_field).unwrap();
                match finite_field {
                    "thermal" => grid.thermal_generation_kw = value,
                    "storage-discharge" => grid.storage_discharge_kw = value,
                    "storage-charge" => grid.storage_charge_kw = value,
                    _ => unreachable!(),
                }
            }
            let rejection =
                build_renewable_power_tail_certificate_for_test(&initial, &finite).unwrap_err();
            assert!(
                rejection.contains("finite generation or storage"),
                "field={finite_field} rejection={rejection}"
            );
        }

        let mut isolated_grid = snapshots.clone();
        for snapshot in isolated_grid.iter_mut().skip(1) {
            let grid = snapshot
                .renewable_power
                .grids
                .get_mut(&PowerGridKey {
                    planet_id: "home".to_owned(),
                    grid_id: "grid-b".to_owned(),
                })
                .unwrap();
            grid.demand_kw = PowerProofScalar::from_f64(1.0, "isolated demand").unwrap();
        }
        let rejection =
            build_renewable_power_tail_certificate_for_test(&initial, &isolated_grid).unwrap_err();
        assert!(
            rejection.contains("renewable lower-bound supply"),
            "{rejection}"
        );

        let mut rounded_tiny_demand = snapshots.clone();
        for snapshot in rounded_tiny_demand.iter_mut().skip(1) {
            snapshot
                .renewable_power
                .grids
                .get_mut(&PowerGridKey {
                    planet_id: "home".to_owned(),
                    grid_id: "grid-b".to_owned(),
                })
                .unwrap()
                .connected_entities = 1;
        }
        let rejection =
            build_renewable_power_tail_certificate_for_test(&initial, &rounded_tiny_demand)
                .unwrap_err();
        assert!(
            rejection.contains("renewable lower-bound supply"),
            "{rejection}"
        );

        let mut unstable = snapshots;
        unstable[3]
            .renewable_power
            .grids
            .get_mut(&PowerGridKey {
                planet_id: "home".to_owned(),
                grid_id: "grid-a".to_owned(),
            })
            .unwrap()
            .demand_kw = PowerProofScalar::from_f64(2.0, "unstable demand").unwrap();
        let rejection =
            build_renewable_power_tail_certificate_for_test(&initial, &unstable).unwrap_err();
        assert!(
            rejection.contains("changed across calibration"),
            "{rejection}"
        );
    }

    #[test]
    fn renewable_power_proof_closes_active_grids_without_cross_grid_pooling() {
        let mut initial = sustainable_dynamic_ray_power_fixture(14.0);
        let wind_index = initial.entity_index.get("wind").copied().unwrap();
        let mut wind = initial.parse_entity(wind_index).unwrap();
        wind["machineCount"] = json!(1);
        wind["powerGridId"] = json!("grid-b");
        initial.replace_entity_raw(wind_index, serde_json::to_string(&wind).unwrap().into());
        let vein_index = initial.entity_index.get("vein").copied().unwrap();
        let mut vein = initial.parse_entity(vein_index).unwrap();
        vein["powerGridId"] = json!("grid-b");
        initial.replace_entity_raw(vein_index, serde_json::to_string(&vein).unwrap().into());
        initial.rebuild_indexes().unwrap();

        let request = pure_idle_macro_request(initial.revision, 600.0, 600.0 / 14.0);
        let snapshots = exact_three_window_probe(&initial, &request).unwrap();
        let power = build_renewable_power_tail_certificate_for_test(&initial, &snapshots).unwrap();
        let controller = &power.grids[&PowerGridKey {
            planet_id: "home".to_owned(),
            grid_id: "grid-a".to_owned(),
        }];
        let peer = &power.grids[&PowerGridKey {
            planet_id: "home".to_owned(),
            grid_id: "grid-b".to_owned(),
        }];
        assert_eq!(controller.static_generation_floor_kw.get(), 0.0);
        assert!(controller.ray_generation_floor_kw.get() > controller.demand_ceiling_kw.get());
        assert_eq!(peer.ray_generation_floor_kw.get(), 0.0);
        assert!(peer.static_generation_floor_kw.get() > peer.demand_ceiling_kw.get());
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
            .map(|window| {
                capture_ordinary_window_flow(&window[0], &window[1], false, &MaterialTotals::new())
                    .unwrap()
            })
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
        let cycle_sources = exclusive_vein_sources(&cycle).unwrap();
        let rejection = build_closed_recipe_certificate(
            &cycle,
            &cycle_sources,
            &flows[0],
            Vec::new(),
            OrdinaryTerminalCertificates::default(),
        )
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
        let alternate_sources = exclusive_vein_sources(&alternate).unwrap();
        let rejection = build_closed_recipe_certificate(
            &alternate,
            &alternate_sources,
            &flows[0],
            Vec::new(),
            OrdinaryTerminalCertificates::default(),
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
        let hidden_sources = exclusive_vein_sources(&hidden_producer).unwrap();
        let rejection = build_closed_recipe_certificate(
            &hidden_producer,
            &hidden_sources,
            &flows[0],
            Vec::new(),
            OrdinaryTerminalCertificates::default(),
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
        let sprayed_sources = exclusive_vein_sources(&sprayed).unwrap();
        let rejection = build_closed_recipe_certificate(
            &sprayed,
            &sprayed_sources,
            &flows[0],
            Vec::new(),
            OrdinaryTerminalCertificates::default(),
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
                .is_some_and(|reason| reason.contains("no exclusive active vein source")),
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

    #[derive(Debug, Clone, PartialEq, Eq)]
    struct FixedMacroHashRun {
        public_bytes: Vec<u8>,
        canonical: String,
        domain: String,
        conservation: String,
        public_without_history: String,
        production_history: String,
        report: Vec<u8>,
    }

    fn run_fixed_macro_hash_fixture(
        fixture: fn(f64) -> CoreState,
        worker_count: usize,
        exercise_parallel_threshold: bool,
    ) -> FixedMacroHashRun {
        let runtime = DeterministicRuntime::for_test(worker_count);
        let mut state = fixture(15.0);
        if exercise_parallel_threshold {
            state = pad_parallel_certificate_fixture(state);
            assert_eq!(
                runtime.worker_count_for_items(state.parse_entities_parallel().unwrap().len()),
                worker_count,
                "padded fixed fixture must exercise the requested worker count"
            );
        }
        let revision = state.revision;
        let result = advance_bounded_with_runtime(
            &mut state,
            &pure_idle_macro_request(revision, 600.0, 40.0),
            true,
            &runtime,
        )
        .unwrap();
        assert!(result.supported, "reason={:?}", result.reason);

        let public = state.materialize().unwrap();
        assert_eq!(public["historyRecordedAt"].as_f64(), Some(30.0));
        let history = public["productionHistory"].as_array().unwrap();
        assert_eq!(history.len(), 30);
        assert!(history.iter().enumerate().all(|(index, sample)| {
            sample["elapsedSeconds"].as_f64() == Some((index + 1) as f64)
                && sample["sampleDurationSeconds"].as_f64() == Some(1.0)
        }));

        let mut public_without_history = public.clone();
        public_without_history
            .as_object_mut()
            .unwrap()
            .remove("productionHistory");
        FixedMacroHashRun {
            public_bytes: serde_json::to_vec(&public).unwrap(),
            canonical: state.canonical_sha256().unwrap(),
            domain: state.domain_sha256().unwrap(),
            conservation: parallel_certificate_conservation_sha256(&state),
            public_without_history: crate::canonical::canonical_sha256(&public_without_history),
            production_history: crate::canonical::canonical_sha256(&public["productionHistory"]),
            report: serde_json::to_vec(&result).unwrap(),
        }
    }

    fn assert_fixed_macro_hash_at_one_two_four_eight_workers(
        fixture: fn(f64) -> CoreState,
        expected_canonical: &str,
        expected_domain: &str,
        expected_conservation: &str,
        expected_public_without_history: &str,
        expected_production_history: &str,
    ) {
        let expected = run_fixed_macro_hash_fixture(fixture, 1, false);
        assert_eq!(expected.canonical, expected_canonical);
        assert_eq!(expected.domain, expected_domain);
        assert_eq!(expected.conservation, expected_conservation);
        assert_eq!(
            expected.public_without_history,
            expected_public_without_history
        );
        assert_eq!(expected.production_history, expected_production_history);
        for worker_count in [2, 4, 8, 8] {
            assert_eq!(
                run_fixed_macro_hash_fixture(fixture, worker_count, false),
                expected,
                "fixed macro fixture diverged at {worker_count} workers"
            );
        }

        // The compact fixture alone is below the scheduler threshold. Repeat
        // the complete state/report/conservation comparison with inert rows so
        // 1/2/4/8 are real selected worker counts rather than configuration
        // labels that all silently take the serial path.
        let parallel_expected = run_fixed_macro_hash_fixture(fixture, 1, true);
        for worker_count in [2, 4, 8, 8] {
            assert_eq!(
                run_fixed_macro_hash_fixture(fixture, worker_count, true),
                parallel_expected,
                "padded fixed macro fixture diverged at {worker_count} workers"
            );
        }
    }

    #[test]
    fn macro_v10_recipe_dag_has_a_fixed_cross_thread_hash() {
        // `06dc1651` intentionally replaced three 10-second history buckets
        // with the same thirty one-second public boundaries produced by
        // 30x1s Exact calls. Bisection proved that the complete public state
        // excluding only `productionHistory`, the simulation-domain hash and
        // the material-conservation projection all retained their pre-change
        // hashes. Keep those proofs beside the new canonical baseline so a
        // future unexplained gameplay drift cannot be accepted as "history".
        assert_fixed_macro_hash_at_one_two_four_eight_workers(
            productive_closed_recipe_dag_macro_fixture,
            "e6095295aa7aaae1e84a4c96b8b7335acffdd051da931aad80c37918f64e3736",
            "0e225ed562017b92c73b53c83c8191d42c95c67064835a123d0df81bf456b918",
            "6a42519ebeb092f4580ce9eaefccc26e5f6456bf387051199eb3dbc60462daf6",
            "aae0e08fc018ea32ff5df9a9fa31e01946c859e4aac9ed8944d407c19567fcac",
            "029721bf9652279c30e8850b1b5c0701b46bdeb98b3b2868234e418e00bd2ed5",
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
    fn macro_v10_galactic_export_certifies_the_exact_prefix_and_productive_tail() {
        let initial = productive_galactic_export_macro_fixture(15.0, 0);
        let mut prefix = initial.clone();
        let revision = prefix.revision;
        let prefix_result =
            advance_macro_v10(&mut prefix, &pure_idle_macro_request(revision, 30.0, 2.0)).unwrap();
        assert!(prefix_result.supported, "reason={:?}", prefix_result.reason);
        let prefix_delivery = proof_counter(
            prefix.base_value()["endgame"]["exportProjects"]["solar_sail_array"]
                .get("totalDelivered"),
            "prefix galactic delivery",
        )
        .unwrap();
        assert!(prefix_delivery > 0);

        let mut long = initial;
        let revision = long.revision;
        let result =
            advance_macro_v10(&mut long, &pure_idle_macro_request(revision, 600.0, 40.0)).unwrap();
        assert!(result.supported, "reason={:?}", result.reason);
        let delivered = proof_counter(
            long.base_value()["endgame"]["exportProjects"]["solar_sail_array"]
                .get("totalDelivered"),
            "long galactic delivery",
        )
        .unwrap();
        assert!(delivered > prefix_delivery, "reason={:?}", result.reason);
        assert!(
            result
                .reason
                .as_deref()
                .is_some_and(|reason| reason.contains("galactic export")),
            "reason={:?}",
            result.reason
        );
        assert_eq!(
            proof_counter(
                long.base_value()["endgame"]["constructionActivity"]["personalDelivered"]
                    .get("solar_sail"),
                "long activity delivery mirror",
            )
            .unwrap(),
            delivered
        );
        assert_eq!(
            proof_counter(
                long.base_value()["totalProduced"].get("solar_sail"),
                "long produced sails",
            )
            .unwrap(),
            delivered
                + proof_counter(
                    long.base_value()["quantumLogisticsNetwork"]["inventory"].get("solar_sail"),
                    "long retained sails",
                )
                .unwrap()
        );
    }

    #[test]
    fn macro_v10_orbital_contract_keeps_the_certified_requirement_target() {
        let first = orbital_contract_fixture(0, 10_000, 0);
        let second = orbital_contract_fixture(1, 10_000, 0);
        // One unit primes the exact terminal/belt ordering. The certificate
        // still spends only same-window production in the macro tail; a
        // separate regression below covers a genuinely prefilled buffer.
        let initial =
            productive_orbital_contract_macro_fixture(15.0, 1, vec![first.clone(), second], 1);
        let mut long = initial;
        let revision = long.revision;
        let result =
            advance_macro_v10(&mut long, &pure_idle_macro_request(revision, 600.0, 40.0)).unwrap();
        assert!(result.supported, "reason={:?}", result.reason);
        assert!(
            result
                .reason
                .as_deref()
                .is_some_and(|reason| reason.contains("orbital contract")),
            "reason={:?}",
            result.reason
        );
        assert_eq!(
            long.base_value()["orbitalStation"]["contractBoard"]["accepted"][0],
            first,
            "the earlier same-item contract must remain byte-for-byte unchanged"
        );
        let delivered = proof_counter(
            long.base_value()["orbitalStation"]["contractBoard"]["accepted"][1]["requirements"][0]
                .get("delivered"),
            "orbital delivered",
        )
        .unwrap();
        assert!(delivered > 30, "reason={:?}", result.reason);
        assert_eq!(
            proof_counter(
                long.base_value()["orbitalStation"]["totals"]["exportedByItem"].get("solar_sail"),
                "orbital exported total",
            )
            .unwrap(),
            delivered
        );
    }

    #[test]
    fn macro_v10_galactic_boundary_is_segment_and_empty_tail_invariant() {
        let mut initial = productive_galactic_export_macro_fixture(15.0, 0);
        prime_galactic_sail_level_boundary(&mut initial, 4_900);

        let mut long = initial.clone();
        let revision = long.revision;
        let result =
            advance_macro_v10(&mut long, &pure_idle_macro_request(revision, 600.0, 40.0)).unwrap();
        assert!(result.supported, "reason={:?}", result.reason);
        assert_eq!(
            proof_counter(
                long.base_value()["endgame"]["exportProjects"]["solar_sail_array"].get("delivered"),
                "long boundary delivery",
            )
            .unwrap(),
            4_999,
        );

        let mut segmented = initial;
        for seconds in [30.0, 100.0, 100.0, 100.0, 100.0, 100.0, 70.0] {
            let revision = segmented.revision;
            let result = advance_macro_v10(
                &mut segmented,
                &pure_idle_macro_request(revision, seconds, seconds / 15.0),
            )
            .unwrap();
            assert!(
                result.supported,
                "segment={seconds} reason={:?}",
                result.reason
            );
        }
        assert_eq!(
            segmented.summary().unwrap().canonical_sha256,
            long.summary().unwrap().canonical_sha256,
        );
        assert_eq!(
            crate::galactic_exports::capture_certified_pure_idle_export_endpoint(
                segmented.base_value(),
            )
            .unwrap(),
            crate::galactic_exports::capture_certified_pure_idle_export_endpoint(
                long.base_value(),
            )
            .unwrap(),
        );

        let delivered_before = proof_counter(
            segmented.base_value()["endgame"]["exportProjects"]["solar_sail_array"]
                .get("totalDelivered"),
            "exhausted delivery",
        )
        .unwrap();
        let clock_before = proof_counter(
            segmented.base_value()["endgame"]["constructionActivity"].get("activityClockMs"),
            "activity clock before empty tail",
        )
        .unwrap();
        let revision = segmented.revision;
        let result = advance_macro_v10(
            &mut segmented,
            &pure_idle_macro_request(revision, 15.0, 1.0),
        )
        .unwrap();
        assert!(result.supported, "reason={:?}", result.reason);
        assert_eq!(
            proof_counter(
                segmented.base_value()["endgame"]["exportProjects"]["solar_sail_array"]
                    .get("totalDelivered"),
                "empty-tail delivery",
            )
            .unwrap(),
            delivered_before,
        );
        assert_eq!(
            proof_counter(
                segmented.base_value()["endgame"]["constructionActivity"].get("activityClockMs"),
                "activity clock after empty tail",
            )
            .unwrap(),
            clock_before + 1_000,
        );
    }

    #[test]
    fn macro_v10_terminal_prefill_is_consumed_only_by_the_exact_prefix() {
        let mut galactic_prefix = productive_galactic_export_macro_fixture(15.0, 1_000);
        let revision = galactic_prefix.revision;
        advance_macro_v10(
            &mut galactic_prefix,
            &pure_idle_macro_request(revision, 30.0, 2.0),
        )
        .unwrap();
        let galactic_prefix_delivery = proof_counter(
            galactic_prefix.base_value()["endgame"]["exportProjects"]["solar_sail_array"]
                .get("totalDelivered"),
            "prefilled galactic prefix",
        )
        .unwrap();
        assert!(galactic_prefix_delivery > 1_000);
        let mut galactic_long = productive_galactic_export_macro_fixture(15.0, 1_000);
        let revision = galactic_long.revision;
        let result = advance_macro_v10(
            &mut galactic_long,
            &pure_idle_macro_request(revision, 600.0, 40.0),
        )
        .unwrap();
        assert!(result.supported, "reason={:?}", result.reason);
        assert_eq!(
            proof_counter(
                galactic_long.base_value()["endgame"]["exportProjects"]["solar_sail_array"]
                    .get("totalDelivered"),
                "prefilled galactic long",
            )
            .unwrap(),
            galactic_prefix_delivery,
            "old exporter input must not become a renewable tail budget",
        );

        let contracts = vec![orbital_contract_fixture(0, 100_000, 0)];
        let mut orbital_prefix =
            productive_orbital_contract_macro_fixture(15.0, 1_000, contracts.clone(), 0);
        let revision = orbital_prefix.revision;
        advance_macro_v10(
            &mut orbital_prefix,
            &pure_idle_macro_request(revision, 30.0, 2.0),
        )
        .unwrap();
        let orbital_prefix_delivery = proof_counter(
            orbital_prefix.base_value()["orbitalStation"]["contractBoard"]["accepted"][0]
                ["requirements"][0]
                .get("delivered"),
            "prefilled orbital prefix",
        )
        .unwrap();
        assert!(orbital_prefix_delivery > 30);
        let mut orbital_long = productive_orbital_contract_macro_fixture(15.0, 1_000, contracts, 0);
        let revision = orbital_long.revision;
        let result = advance_macro_v10(
            &mut orbital_long,
            &pure_idle_macro_request(revision, 600.0, 40.0),
        )
        .unwrap();
        assert!(result.supported, "reason={:?}", result.reason);
        assert_eq!(
            proof_counter(
                orbital_long.base_value()["orbitalStation"]["contractBoard"]["accepted"][0]
                    ["requirements"][0]
                    .get("delivered"),
                "prefilled orbital long",
            )
            .unwrap(),
            orbital_prefix_delivery,
            "old cargo-terminal input must not become a renewable tail budget",
        );
    }

    #[test]
    fn macro_v10_terminal_certificates_rebuild_after_private_checkpoint_reload() {
        let fixtures = [
            productive_galactic_export_macro_fixture(15.0, 0),
            productive_orbital_contract_macro_fixture(
                15.0,
                1,
                vec![orbital_contract_fixture(0, 10_000, 0)],
                0,
            ),
        ];
        for initial in fixtures {
            let mut calibrated = initial;
            let revision = calibrated.revision;
            let result = advance_macro_v10(
                &mut calibrated,
                &pure_idle_macro_request(revision, 30.0, 2.0),
            )
            .unwrap();
            assert!(result.supported, "calibration reason={:?}", result.reason);

            let mut continuous = calibrated.clone();
            let mut reloaded = checkpoint_reload_fixture(&calibrated);
            assert!(reloaded.pure_idle_macro_runtime.is_none());
            for state in [&mut continuous, &mut reloaded] {
                let revision = state.revision;
                let result =
                    advance_macro_v10(state, &pure_idle_macro_request(revision, 570.0, 38.0))
                        .unwrap();
                assert!(result.supported, "reload reason={:?}", result.reason);
            }
            assert_eq!(
                reloaded.summary().unwrap().canonical_sha256,
                continuous.summary().unwrap().canonical_sha256,
            );
        }
    }

    #[test]
    fn macro_v10_terminal_tails_are_segment_invariant_at_supported_multipliers() {
        for multiplier in [8.0, 12.0, 15.0, 16.0] {
            let fixtures = [
                productive_galactic_export_macro_fixture(multiplier, 0),
                productive_orbital_contract_macro_fixture(
                    multiplier,
                    1,
                    vec![orbital_contract_fixture(0, 10_000, 0)],
                    0,
                ),
            ];
            for (terminal_index, initial) in fixtures.into_iter().enumerate() {
                let mut long = initial.clone();
                let revision = long.revision;
                let result = advance_macro_v10(
                    &mut long,
                    &pure_idle_macro_request(revision, 600.0, 600.0 / multiplier),
                )
                .unwrap();
                assert!(
                    result.supported,
                    "{multiplier}x terminal={terminal_index} long: {:?}",
                    result.reason
                );

                let mut segmented = initial;
                for seconds in [30.0, 190.0, 190.0, 190.0] {
                    let revision = segmented.revision;
                    let result = advance_macro_v10(
                        &mut segmented,
                        &pure_idle_macro_request(revision, seconds, seconds / multiplier),
                    )
                    .unwrap();
                    assert!(
                        result.supported,
                        "{multiplier}x terminal={terminal_index} segment={seconds}: {:?}",
                        result.reason
                    );
                }
                assert_eq!(
                    segmented.summary().unwrap().canonical_sha256,
                    long.summary().unwrap().canonical_sha256,
                    "{multiplier}x terminal={terminal_index}",
                );
            }
        }
    }

    #[test]
    fn macro_v10_terminal_late_failure_preserves_source_hash_revision_and_runtime() {
        let mut state = productive_galactic_export_macro_fixture(15.0, 0);
        let revision = state.revision;
        let result =
            advance_macro_v10(&mut state, &pure_idle_macro_request(revision, 30.0, 2.0)).unwrap();
        assert!(result.supported, "reason={:?}", result.reason);
        let certificate = state
            .pure_idle_macro_runtime
            .as_mut()
            .and_then(|runtime| runtime.certificate.as_mut())
            .expect("Galactic terminal certificate");
        certificate
            .galactic_export
            .as_mut()
            .expect("Galactic sink")
            .consumed_units_per_second
            .insert("solar_sail".to_owned(), i128::MAX);
        let before_revision = state.revision;
        let before_hash = state.summary().unwrap().canonical_sha256;
        let before_credit = state.pure_idle_macro_exact_seconds_used();
        let before_runtime = format!("{:#?}", state.pure_idle_macro_runtime);
        let result = advance_macro_v10(
            &mut state,
            &pure_idle_macro_request(before_revision, 15.0, 1.0),
        )
        .unwrap();
        assert!(!result.supported);
        assert_eq!(state.revision, before_revision);
        assert_eq!(state.summary().unwrap().canonical_sha256, before_hash);
        assert_eq!(state.pure_idle_macro_exact_seconds_used(), before_credit);
        assert_eq!(
            format!("{:#?}", state.pure_idle_macro_runtime),
            before_runtime
        );
    }

    #[test]
    fn macro_v10_closed_recipe_has_a_fixed_cross_thread_hash() {
        assert_fixed_macro_hash_at_one_two_four_eight_workers(
            productive_closed_recipe_macro_fixture,
            "84944662ddf998621707fcbb757856158fa92d452b0523cd7ab0bd9545bf9746",
            "e2ce7700859fc0321532bee4351f3b3d365180a68980cffa478e483a99ed8e42",
            "f9a4439bfcb9a337868933db93ad18f71c09c5a327583abf6304ae38be17b78f",
            "0d1d41bcab8958166f540dfbd5d0e51b074d51e98682df846bb169d097e7aae8",
            "c28b7772359e7e1f4ce50cb5030407e777c9146921552baef00c47d24c222b2c",
        );
    }

    #[test]
    fn closed_recipe_certificate_rejects_unclosed_domains_but_allows_isolated_construction() {
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
        let construction_certificate =
            build_ordinary_flow_certificate(&construction, &snapshots).unwrap();
        assert_eq!(construction_certificate.recipe_ids, ["iron_ingot"]);
        let mut export = state.clone();
        export.base_value_mut()["endgame"]["exportInputMode"] = json!("legacy-network");
        export.base_value_mut()["endgame"]["autoDispatch"] = json!(true);
        export.base_value_mut()["endgame"]["exportProjects"]["universe_archive"]["enabled"] =
            json!(true);
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
    fn macro_v10_certifies_finite_source_and_rejects_fuel_backed_power() {
        let initial = productive_quantum_macro_fixture(15.0, "finite");
        let mut prefix = initial.clone();
        let prefix_revision = prefix.revision;
        advance_macro_v10(
            &mut prefix,
            &pure_idle_macro_request(prefix_revision, 30.0, 2.0),
        )
        .unwrap();
        let prefix_reserve = proof_counter(
            prefix.parse_entity(2).unwrap().get("resourceRemaining"),
            "prefix.resourceRemaining",
        )
        .unwrap();
        let prefix_produced = proof_counter(
            prefix.base_value()["totalProduced"].get("iron_ore"),
            "prefix.totalProduced.iron_ore",
        )
        .unwrap();

        let mut finite = initial;
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
                .is_some_and(|reason| reason.contains("source-only ordinary")),
            "reason={:?}",
            finite_result.reason
        );
        let deposited = proof_counter(
            finite.base_value()["quantumLogisticsNetwork"]["inventory"].get("iron_ore"),
            "finite.quantum.iron_ore",
        )
        .unwrap();
        let final_reserve = proof_counter(
            finite.parse_entity(2).unwrap().get("resourceRemaining"),
            "finite.resourceRemaining",
        )
        .unwrap();
        let final_produced = proof_counter(
            finite.base_value()["totalProduced"].get("iron_ore"),
            "finite.totalProduced.iron_ore",
        )
        .unwrap();
        assert!(deposited > 0);
        assert_eq!(prefix_reserve - final_reserve, deposited);
        assert_eq!(final_produced - prefix_produced, deposited);

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
    fn macro_v10_finite_vein_horizon_is_conservative_and_segment_invariant() {
        let mut initial = productive_quantum_macro_fixture(15.0, "finite");
        let mut vein = initial.parse_entity(2).unwrap();
        vein["resourceCapacity"] = json!(120);
        vein["resourceRemaining"] = json!(120);
        vein["resourceDepletionRemainder"] = json!(5);
        initial.replace_entity_raw(2, serde_json::to_string(&vein).unwrap().into());

        let mut long = initial.clone();
        let revision = long.revision;
        let result =
            advance_macro_v10(&mut long, &pure_idle_macro_request(revision, 600.0, 40.0)).unwrap();
        assert!(result.supported, "reason={:?}", result.reason);
        assert!(
            result
                .reason
                .as_deref()
                .is_some_and(|reason| reason.contains("capacity horizon")),
            "reason={:?}",
            result.reason
        );
        let final_vein = long.parse_entity(2).unwrap();
        // The whole-second schedule stops one two-unit batch before the final
        // single unit. Under-production is intentional; reserve must never be
        // overspent merely to make the horizon exact.
        assert_eq!(final_vein["resourceRemaining"], json!(2));
        assert_eq!(final_vein["resourceDepletionRemainder"], json!(5));
        assert_eq!(
            long.base_value()["quantumLogisticsNetwork"]["inventory"]["iron_ore"],
            json!("58")
        );
        assert_eq!(
            proof_counter(
                long.base_value()["totalProduced"].get("iron_ore"),
                "long.totalProduced.iron_ore",
            )
            .unwrap(),
            118
        );

        let mut segmented = initial;
        for seconds in [30.0, 200.0, 370.0] {
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
    fn macro_v10_finite_vein_uses_the_public_tenths_remainder_ledger() {
        let mut initial = productive_quantum_macro_fixture(15.0, "finite");
        initial.base_value_mut()["endgame"]["infiniteResearch"]["vein_utilization"]["level"] =
            json!(1);
        let mut vein = initial.parse_entity(2).unwrap();
        vein["minerCount"] = json!(10);
        vein["resourceCapacity"] = json!(10_000);
        vein["resourceRemaining"] = json!(10_000);
        vein["resourceDepletionRemainder"] = json!(7);
        initial.replace_entity_raw(2, serde_json::to_string(&vein).unwrap().into());
        initial.rebuild_indexes().unwrap();

        let mut long = initial.clone();
        let revision = long.revision;
        let result =
            advance_macro_v10(&mut long, &pure_idle_macro_request(revision, 60.0, 4.0)).unwrap();
        assert!(result.supported, "reason={:?}", result.reason);
        let produced = proof_counter(
            long.base_value()["totalProduced"].get("iron_ore"),
            "long.totalProduced.iron_ore",
        )
        .unwrap();
        let accrued_tenths = 7 + produced * 9;
        let final_vein = long.parse_entity(2).unwrap();
        assert_eq!(
            proof_counter(
                final_vein.get("resourceRemaining"),
                "long.resourceRemaining",
            )
            .unwrap(),
            10_000 - accrued_tenths / 10
        );
        assert_eq!(
            proof_counter(
                final_vein.get("resourceDepletionRemainder"),
                "long.resourceDepletionRemainder",
            )
            .unwrap(),
            accrued_tenths % 10
        );

        let mut segmented = initial;
        for seconds in [10.0, 20.0, 30.0] {
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
    fn macro_v10_finite_fluid_vein_accepts_missing_solid_remainder_and_uses_whole_reserve() {
        let mut state = productive_quantum_macro_fixture(15.0, "finite");
        let catalog = Arc::make_mut(&mut state.catalog);
        catalog.items.insert(
            "crude_oil".to_owned(),
            ItemDefinition {
                id: "crude_oil".to_owned(),
                name: "crude_oil".to_owned(),
                kind: "fluid".to_owned(),
                fuel_energy_mj: 0.0,
            },
        );
        catalog.buildings.insert(
            "oil_extractor".to_owned(),
            BuildingDefinition {
                id: "oil_extractor".to_owned(),
                kind: "miner".to_owned(),
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
        );
        state.base_value_mut()["quantumLogisticsNetwork"]["itemCapacities"] =
            json!({ "crude_oil": "10000000000" });
        let mut vein = state.parse_entity(2).unwrap();
        vein["resourceId"] = json!("crude_oil");
        vein["extractorBuildingId"] = json!("oil_extractor");
        vein["outputs"] = json!({ "crude_oil": 0 });
        vein.as_object_mut()
            .unwrap()
            .remove("resourceDepletionRemainder");
        state.replace_entity_raw(2, serde_json::to_string(&vein).unwrap().into());
        state.rebuild_indexes().unwrap();

        let revision = state.revision;
        let result =
            advance_macro_v10(&mut state, &pure_idle_macro_request(revision, 60.0, 4.0)).unwrap();
        assert!(result.supported, "reason={:?}", result.reason);
        let produced = proof_counter(
            state.base_value()["totalProduced"].get("crude_oil"),
            "totalProduced.crude_oil",
        )
        .unwrap();
        assert!(produced > 0);
        let final_vein = state.parse_entity(2).unwrap();
        assert_eq!(
            proof_counter(final_vein.get("resourceRemaining"), "fluid.remaining").unwrap(),
            1_000_000 - produced
        );
        assert_eq!(
            proof_counter(
                final_vein.get("resourceDepletionRemainder"),
                "fluid.remainder",
            )
            .unwrap(),
            0
        );
    }

    #[test]
    fn macro_v10_finite_vein_is_segment_invariant_at_supported_multipliers() {
        for multiplier in [8.0, 12.0, 15.0, 16.0] {
            let initial = productive_quantum_macro_fixture(multiplier, "finite");
            let mut long = initial.clone();
            let revision = long.revision;
            let result = advance_macro_v10(
                &mut long,
                &pure_idle_macro_request(revision, 60.0, 60.0 / multiplier),
            )
            .unwrap();
            assert!(
                result.supported,
                "multiplier={multiplier} reason={:?}",
                result.reason
            );

            let mut segmented = initial;
            for seconds in [10.0, 20.0, 30.0] {
                let revision = segmented.revision;
                let result = advance_macro_v10(
                    &mut segmented,
                    &pure_idle_macro_request(revision, seconds, seconds / multiplier),
                )
                .unwrap();
                assert!(
                    result.supported,
                    "multiplier={multiplier} segment={seconds} reason={:?}",
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
    fn macro_v10_finite_vein_funds_the_complete_closed_recipe_ledger() {
        let mut initial = productive_closed_recipe_macro_fixture(15.0);
        initial.base_value_mut()["settings"]["resourceMode"] = json!("finite");
        let mut prefix = initial.clone();
        let revision = prefix.revision;
        advance_macro_v10(&mut prefix, &pure_idle_macro_request(revision, 30.0, 2.0)).unwrap();
        let prefix_state = prefix.materialize().unwrap();
        let prefix_reserve = proof_counter(
            prefix_state["entities"][2].get("resourceRemaining"),
            "prefix.resourceRemaining",
        )
        .unwrap();

        let mut long = initial.clone();
        let revision = long.revision;
        let result =
            advance_macro_v10(&mut long, &pure_idle_macro_request(revision, 60.0, 4.0)).unwrap();
        assert!(result.supported, "reason={:?}", result.reason);
        assert!(
            result
                .reason
                .as_deref()
                .is_some_and(|reason| reason.contains("acyclic closed ordinary recipe")),
            "reason={:?}",
            result.reason
        );
        let long_state = long.materialize().unwrap();
        let deposited = proof_counter(
            long_state["quantumLogisticsNetwork"]["inventory"].get("iron_ingot"),
            "long.quantum.iron_ingot",
        )
        .unwrap();
        assert!(deposited > 0);
        assert!(
            proof_counter(
                long_state["entities"][2].get("resourceRemaining"),
                "long.resourceRemaining",
            )
            .unwrap()
                < prefix_reserve
        );

        let mut segmented = initial;
        for seconds in [10.0, 20.0, 30.0] {
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
    fn macro_v10_finite_vein_certificate_divergence_is_atomic() {
        let mut state = productive_quantum_macro_fixture(15.0, "finite");
        let revision = state.revision;
        advance_macro_v10(&mut state, &pure_idle_macro_request(revision, 30.0, 2.0)).unwrap();
        state
            .pure_idle_macro_runtime
            .as_mut()
            .and_then(|runtime| runtime.certificate.as_mut())
            .and_then(|certificate| certificate.finite_veins.first_mut())
            .expect("finite vein certificate")
            .expected
            .remaining += 1;
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
                .is_some_and(|reason| reason.contains("diverged from its certified endpoint")),
            "reason={:?}",
            result.reason
        );
        assert_eq!(state.revision, before_revision);
        assert_eq!(state.summary().unwrap().canonical_sha256, before_hash);
        assert_eq!(state.pure_idle_macro_exact_seconds_used(), before_credit);
    }

    #[test]
    fn settlement_proof_rejects_uncredited_finite_vein_depletion() {
        let state = productive_quantum_macro_fixture(15.0, "finite");
        let before = capture_settlement_snapshot(&state).unwrap();
        let mut after = before.clone();
        after.finite_veins.get_mut("vein").unwrap().remaining -= 1;
        let rejection =
            validate_settlement_proof(&before, &after, &state.catalog, None).unwrap_err();
        assert!(rejection.contains("finite reserve funded"), "{rejection}");
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
        for resource_mode in ["infinite", "finite"] {
            let mut calibrated = productive_quantum_macro_fixture(15.0, resource_mode);
            let revision = calibrated.revision;
            let result = advance_macro_v10(
                &mut calibrated,
                &pure_idle_macro_request(revision, 30.0, 2.0),
            )
            .unwrap();
            assert!(
                result.supported,
                "mode={resource_mode} reason={:?}",
                result.reason
            );

            let mut cached = calibrated.clone();
            let mut rebuilt = calibrated;
            rebuilt.pure_idle_macro_runtime = None;
            for state in [&mut cached, &mut rebuilt] {
                let revision = state.revision;
                let result =
                    advance_macro_v10(state, &pure_idle_macro_request(revision, 30.0, 2.0))
                        .unwrap();
                assert!(
                    result.supported,
                    "mode={resource_mode} reason={:?}",
                    result.reason
                );
            }
            assert_eq!(
                rebuilt.summary().unwrap().canonical_sha256,
                cached.summary().unwrap().canonical_sha256,
                "mode={resource_mode}"
            );
        }
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
                finite_veins: Vec::new(),
                recipe_ids: Vec::new(),
                research: None,
                dyson_rocket: None,
                dyson_sail: None,
                galactic_export: None,
                orbital_contracts: None,
                renewable_power: None,
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
            assert!(
                (budget.frozen_tail_wall_seconds
                    - (wall_seconds - PURE_IDLE_SESSION_EXACT_CREDIT_SECONDS / multiplier))
                    .abs()
                    <= EPSILON
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
                frozen_tail_wall_seconds: 0.0,
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
            let mut segmented_exact_wall = 0.0;
            let mut segmented_tail_wall = 0.0;
            for wall_seconds in [3.0, 7.0, 11.0, 9.0] {
                let simulation_seconds = wall_seconds * multiplier;
                let budget = prefix_budget(simulation_seconds, wall_seconds, remaining_credit);
                segmented_exact += budget.exact_simulation_seconds;
                segmented_tail += budget.frozen_tail_seconds;
                segmented_exact_wall += budget.exact_wall_seconds;
                segmented_tail_wall += budget.frozen_tail_wall_seconds;
                remaining_credit = (remaining_credit - budget.exact_simulation_seconds).max(0.0);
            }

            assert!((segmented_exact - long.exact_simulation_seconds).abs() <= EPSILON);
            assert!((segmented_tail - long.frozen_tail_seconds).abs() <= EPSILON);
            assert!((segmented_exact_wall - long.exact_wall_seconds).abs() <= EPSILON);
            assert!((segmented_tail_wall - long.frozen_tail_wall_seconds).abs() <= EPSILON);
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

    #[test]
    fn durable_replay_preserves_offline_macro_mode_without_session_credit() {
        let initial = as_offline_fixture(productive_quantum_macro_fixture(15.0, "infinite"));
        let mut expected = initial.clone();
        let result =
            advance_offline_macro_v1(&mut expected, &offline_macro_request(7, 600.0)).unwrap();
        assert!(result.supported, "reason={:?}", result.reason);

        let mut replayed = initial;
        replayed
            .replay_operation(
                7,
                result.revision,
                None,
                600.0,
                600.0,
                CoreAdvanceMode::OfflineMacroV1,
            )
            .unwrap();
        assert_eq!(
            replayed.summary().unwrap().canonical_sha256,
            expected.summary().unwrap().canonical_sha256
        );
        assert_eq!(replayed.pure_idle_macro_exact_seconds_used(), 0.0);
        assert_eq!(replayed.pure_idle_exact_seconds_used(), 0.0);
        assert!(replayed.pure_idle_macro_runtime.is_none());
    }

    fn exact_station_mode_transition_fixture() -> CoreState {
        let mut base = powered_fixture_base(15.0, "infinite");
        base["timeWarp"]["enabled"] = json!(false);
        base["timeWarp"]["requestedMultiplier"] = json!(1);
        base["timeWarp"]["effectiveMultiplier"] = json!(1);
        base["timeWarp"]["requiredPowerKw"] = json!(0);
        base["timeWarp"]["allocatedPowerKw"] = json!(0);
        let mut catalog = fixture_catalog().snapshot;
        catalog.buildings.push(BuildingDefinition {
            id: "interstellar_logistics_station".to_owned(),
            kind: "station".to_owned(),
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
        });
        let catalog = RuntimeCatalog::validate(catalog, "pure-idle-test").unwrap();
        fixture_state_from_parts_with_belts_and_catalog(
            base,
            vec![
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
                    "utilization": 0,
                    "productionRate": 0
                }),
                json!({
                    "id": "committed-transition-station",
                    "kind": "station",
                    "planetId": "home",
                    "powerGridId": "grid-a",
                    "buildingId": "interstellar_logistics_station",
                    "stationTier": 2,
                    "stationOperationMode": "legacy",
                    "stationModeTransition": "to-elevator",
                    "quantumMode": "legacy",
                    "machineCount": 1,
                    "stationSlots": [
                        { "itemId": null, "localMode": "storage", "remoteMode": "storage", "minimumLoad": 0.1, "minStock": 0, "maxStock": 1000000, "priority": 1, "routePolicy": "direct", "warperBudget": 0 },
                        { "itemId": null, "localMode": "storage", "remoteMode": "storage", "minimumLoad": 0.1, "minStock": 0, "maxStock": 1000000, "priority": 1, "routePolicy": "direct", "warperBudget": 0 },
                        { "itemId": null, "localMode": "storage", "remoteMode": "storage", "minimumLoad": 0.1, "minStock": 0, "maxStock": 1000000, "priority": 1, "routePolicy": "direct", "warperBudget": 0 },
                        { "itemId": null, "localMode": "storage", "remoteMode": "storage", "minimumLoad": 0.1, "minStock": 0, "maxStock": 1000000, "priority": 1, "routePolicy": "direct", "warperBudget": 0 },
                        { "itemId": null, "localMode": "storage", "remoteMode": "storage", "minimumLoad": 0.1, "minStock": 0, "maxStock": 1000000, "priority": 1, "routePolicy": "direct", "warperBudget": 0 }
                    ],
                    "stationRoutes": [],
                    "stationDrones": 0,
                    "stationVessels": 0,
                    "stationWarpEnabled": false,
                    "stationWarpers": 0,
                    "stationDispatchCursor": 0,
                    "stationLastSupplyPeerBySlot": {},
                    "stationProgress": 0,
                    "stationCongestion": 0,
                    "stationTrips": 0,
                    "stationLastTransfer": 0,
                    "inputs": {},
                    "outputs": {},
                    "progress": 0,
                    "routingCursor": 0,
                    "utilization": 0,
                    "productionRate": 0
                }),
            ],
            Vec::new(),
            catalog,
        )
    }

    #[test]
    fn committed_five_then_sixty_second_advances_do_not_reprobe_cleared_transition_rows() {
        let mut segmented = exact_station_mode_transition_fixture();
        let first = segmented
            .advance(&exact_request(segmented.revision, 5.0, 5.0))
            .unwrap();
        assert!(first.supported, "first commit reason={:?}", first.reason);
        let first_runtime = segmented
            .prepared_station_mode_transition_runtime()
            .expect("first commit installs transition runtime");
        assert_eq!(first_runtime.active_row_count(), 0);
        let first_entities = segmented.parse_entities_parallel().unwrap();
        assert_eq!(
            first_entities[1]["stationOperationMode"],
            Value::from("elevator")
        );
        assert!(first_entities[1]["stationModeTransition"].is_null());

        let second = segmented
            .advance(&exact_request(segmented.revision, 60.0, 60.0))
            .unwrap();
        assert!(second.supported, "second commit reason={:?}", second.reason);
        let second_runtime = segmented
            .prepared_station_mode_transition_runtime()
            .expect("second commit retains transition runtime");
        assert_eq!(second_runtime.active_row_count(), 0);

        let mut continuous = exact_station_mode_transition_fixture();
        let result = continuous
            .advance(&exact_request(continuous.revision, 65.0, 65.0))
            .unwrap();
        assert!(result.supported, "continuous reason={:?}", result.reason);
        assert_eq!(
            serde_json::to_vec(&segmented.parse_entities_parallel().unwrap()).unwrap(),
            serde_json::to_vec(&continuous.parse_entities_parallel().unwrap()).unwrap(),
            "5+60 second commit segmentation changed persisted entity order or bytes"
        );
        assert_eq!(
            continuous
                .prepared_station_mode_transition_runtime()
                .expect("continuous commit installs transition runtime")
                .active_row_count(),
            0
        );
    }

    fn pad_parallel_certificate_fixture(source: CoreState) -> CoreState {
        let base = Value::Object(source.base_value().clone());
        let mut entities = source.parse_entities_parallel().unwrap();
        // Cross the fixed 4,096-row scheduler threshold without introducing a
        // new material writer. Zero-stack renewable rows remain legitimate
        // persisted records and make the quantum grant's immutable entity
        // directory large enough to exercise the shared pool.
        for index in 0..4_160 {
            entities.push(json!({
                "id": format!("parallel-cert-inert-wind-{index:05}"),
                "kind": "power",
                "planetId": "home",
                "powerGridId": "grid-a",
                "buildingId": "wind_turbine",
                "machineCount": 0,
                "minerCount": 0,
                "inputs": {},
                "outputs": {},
                "progress": 0,
                "routingCursor": 0,
                "utilization": 0,
                "productionRate": 0
            }));
        }
        fixture_state_from_parts_with_belts_and_catalog(
            base,
            entities,
            source.parse_belts_parallel().unwrap(),
            source.catalog.as_ref().clone(),
        )
    }

    fn parallel_certificate_fixture() -> CoreState {
        pad_parallel_certificate_fixture(productive_recipe_construction_quantum_macro_fixture(
            15.0, 10_000,
        ))
    }

    fn parallel_certificate_conservation_sha256(state: &CoreState) -> String {
        let materialized = state.materialize().unwrap();
        let object = materialized.as_object().unwrap();
        let mut projection = Map::new();
        for key in [
            "tray",
            "planetTrays",
            "quantumLogisticsNetwork",
            "totalProduced",
            "manualMined",
            "galacticExports",
            "constructionQueue",
            "constructionProjects",
            "constructionAutomation",
            "dysonSphere",
            "dysonSwarm",
            "dysonPlans",
            "entities",
            "belts",
        ] {
            if let Some(value) = object.get(key) {
                projection.insert(key.to_owned(), value.clone());
            }
        }
        crate::canonical::canonical_sha256(&Value::Object(projection))
    }

    #[derive(Debug, Clone, PartialEq, Eq)]
    struct ParallelCertificateRun {
        bytes: Vec<u8>,
        canonical: String,
        domain: String,
        conservation: String,
        report: Vec<u8>,
    }

    fn run_parallel_certificate_fixture(worker_count: usize) -> ParallelCertificateRun {
        let runtime = DeterministicRuntime::for_test(worker_count);
        let mut state = parallel_certificate_fixture();
        let request = pure_idle_macro_request(state.revision, 60.0, 4.0);
        let report = advance_bounded_with_runtime(&mut state, &request, true, &runtime).unwrap();
        assert!(report.supported, "reason={:?}", report.reason);
        ParallelCertificateRun {
            bytes: serde_json::to_vec(&state.materialize().unwrap()).unwrap(),
            canonical: state.canonical_sha256().unwrap(),
            domain: state.domain_sha256().unwrap(),
            conservation: parallel_certificate_conservation_sha256(&state),
            report: serde_json::to_vec(&report).unwrap(),
        }
    }

    #[test]
    fn macro_v10_certificate_prepare_is_byte_exact_at_one_two_four_eight_auto_and_repeat_eight() {
        let expected = run_parallel_certificate_fixture(1);
        for worker_count in [2, 4, 8] {
            assert_eq!(
                run_parallel_certificate_fixture(worker_count),
                expected,
                "pure-idle certificate prepare diverged at {worker_count} workers"
            );
        }
        let available = std::thread::available_parallelism()
            .map(usize::from)
            .unwrap_or(1);
        let automatic = crate::deterministic_runtime::resolve_worker_limit(Some("auto"), available);
        assert_eq!(run_parallel_certificate_fixture(automatic), expected);
        assert_eq!(run_parallel_certificate_fixture(8), expected);
    }

    #[test]
    fn macro_v10_parallel_prepare_preserves_early_and_late_failure_order_atomically() {
        let state = parallel_certificate_fixture();
        let request = pure_idle_macro_request(state.revision, 60.0, 4.0);
        let snapshots = exact_three_window_probe_isolating_construction(&state, &request).unwrap();
        let source_revision = state.revision;
        let source_hash = state.canonical_sha256().unwrap();
        let source_bytes = serde_json::to_vec(&state.materialize().unwrap()).unwrap();

        let mut early = state.clone();
        let wind_index = early.entity_index.get("wind").copied().unwrap();
        let mut wind = early.parse_entity(wind_index).unwrap();
        wind["buildingId"] = json!("unknown-renewable-source");
        early.replace_entity_raw(wind_index, serde_json::to_string(&wind).unwrap().into());
        let early_one = prepare_ordinary_flow_certificate_with_runtime(
            &early,
            &snapshots,
            &DeterministicRuntime::for_test(1),
        )
        .result
        .unwrap_err();
        for worker_count in [2, 4, 8] {
            let reason = prepare_ordinary_flow_certificate_with_runtime(
                &early,
                &snapshots,
                &DeterministicRuntime::for_test(worker_count),
            )
            .result
            .unwrap_err();
            assert_eq!(reason, early_one);
        }

        let mut late = state.clone();
        late.base_value_mut()["research"]["selectedTechId"] = json!("unknown-parallel-tech");
        let late_revision = late.revision;
        let late_bytes = serde_json::to_vec(&late.materialize().unwrap()).unwrap();
        let late_one = prepare_ordinary_flow_certificate_with_runtime(
            &late,
            &snapshots,
            &DeterministicRuntime::for_test(1),
        )
        .result
        .unwrap_err();
        assert!(late_one.contains("current research state is not a calibration endpoint"));
        for worker_count in [2, 4, 8] {
            let reason = prepare_ordinary_flow_certificate_with_runtime(
                &late,
                &snapshots,
                &DeterministicRuntime::for_test(worker_count),
            )
            .result
            .unwrap_err();
            assert_eq!(reason, late_one);
        }
        assert_eq!(late.revision, late_revision);
        assert_eq!(
            serde_json::to_vec(&late.materialize().unwrap()).unwrap(),
            late_bytes
        );
        assert_eq!(state.revision, source_revision);
        assert_eq!(state.canonical_sha256().unwrap(), source_hash);
        assert_eq!(
            serde_json::to_vec(&state.materialize().unwrap()).unwrap(),
            source_bytes
        );
    }

    #[test]
    fn macro_v10_adjacent_research_and_sail_failures_keep_historical_priority() {
        let state = pad_parallel_certificate_fixture(sustainable_dynamic_ray_power_fixture(14.0));
        let request = pure_idle_macro_request(state.revision, 60.0, 60.0 / 14.0);
        let snapshots = exact_three_window_probe(&state, &request).unwrap();

        let mut research_only = state.clone();
        research_only.base_value_mut()["research"]["selectedTechId"] =
            json!("unknown-parallel-tech");
        let expected = prepare_ordinary_flow_certificate_with_runtime(
            &research_only,
            &snapshots,
            &DeterministicRuntime::for_test(1),
        )
        .result
        .unwrap_err();
        assert!(
            expected.contains("current research state is not a calibration endpoint"),
            "unexpected research rejection: {expected}",
        );

        let mut double_failure = research_only;
        let launched = proof_counter(
            double_failure.base_value()["dysonSwarm"].get("totalLaunched"),
            "double failure totalLaunched",
        )
        .unwrap();
        double_failure.base_value_mut()["dysonSwarm"]["totalLaunched"] = json!(launched + 1);
        let source_revision = double_failure.revision;
        let source_bytes = serde_json::to_vec(&double_failure.materialize().unwrap()).unwrap();
        let source_hash = double_failure.canonical_sha256().unwrap();
        for worker_count in [1, 2, 4, 8] {
            let prepared = prepare_ordinary_flow_certificate_with_runtime(
                &double_failure,
                &snapshots,
                &DeterministicRuntime::for_test(worker_count),
            );
            assert_eq!(prepared.result.unwrap_err(), expected);
        }
        assert_eq!(double_failure.revision, source_revision);
        assert_eq!(double_failure.canonical_sha256().unwrap(), source_hash);
        assert_eq!(
            serde_json::to_vec(&double_failure.materialize().unwrap()).unwrap(),
            source_bytes,
        );
        assert!(double_failure.pure_idle_macro_runtime.is_none());
    }

    #[test]
    fn construction_parallel_prepare_preserves_interleaved_center_error_order() {
        let mut state = pad_parallel_certificate_fixture(
            productive_multi_center_construction_macro_fixture(15.0, 2, 0),
        );
        let request = pure_idle_macro_request(state.revision, 60.0, 4.0);
        let mut snapshots = exact_three_window_probe(&state, &request).unwrap();
        let missing_grid = PowerGridKey {
            planet_id: "home".to_owned(),
            grid_id: "grid-b".to_owned(),
        };
        for snapshot in snapshots.iter_mut().skip(1) {
            snapshot.renewable_power.grids.remove(&missing_grid);
        }

        let first_center_index = state
            .entity_index
            .get("construction-center-00000")
            .copied()
            .unwrap();
        let mut first_center = state.parse_entity(first_center_index).unwrap();
        first_center["powerGridId"] = json!("grid-b");
        state.replace_entity_raw(
            first_center_index,
            serde_json::to_string(&first_center).unwrap().into(),
        );
        let wind_index = state.entity_index.get("wind").copied().unwrap();
        Arc::make_mut(&mut state.factory_topology)
            .construction_center_indices
            .push(wind_index);

        let renewable =
            build_renewable_power_tail_certificate_for_test(&state, &snapshots).unwrap();
        let expected = state
            .factory_topology
            .construction_center_indices
            .iter()
            .copied()
            .find_map(
                |entity_index| match construction_center_identity(&state, entity_index) {
                    Err(reason) => Some(reason),
                    Ok((entity_id, grid)) if !renewable.grids.contains_key(&grid) => Some(format!(
                        "construction center {entity_id} has no permanent renewable grid grant"
                    )),
                    Ok(_) => None,
                },
            )
            .expect("sequential construction oracle should reject");
        assert_eq!(
            expected,
            "construction center construction-center-00000 has no permanent renewable grid grant"
        );
        let source_revision = state.revision;
        let source_bytes = serde_json::to_vec(&state.materialize().unwrap()).unwrap();
        for worker_count in [1, 2, 4, 8] {
            let prepared = prepare_construction_tail_certificate_with_runtime(
                &state,
                &snapshots,
                &DeterministicRuntime::for_test(worker_count),
            );
            assert_eq!(prepared.result.unwrap_err(), expected);
        }
        assert_eq!(state.revision, source_revision);
        assert_eq!(
            serde_json::to_vec(&state.materialize().unwrap()).unwrap(),
            source_bytes
        );
    }

    #[test]
    fn construction_adjacent_center_and_quantum_failures_keep_center_priority() {
        let mut center_failure = parallel_certificate_fixture();
        let request = pure_idle_macro_request(center_failure.revision, 60.0, 4.0);
        let snapshots = exact_three_window_probe(&center_failure, &request).unwrap();
        let wind_index = center_failure.entity_index.get("wind").copied().unwrap();
        Arc::make_mut(&mut center_failure.factory_topology)
            .construction_center_indices
            .push(wind_index);
        let expected = prepare_construction_tail_certificate_with_runtime(
            &center_failure,
            &snapshots,
            &DeterministicRuntime::for_test(1),
        )
        .result
        .unwrap_err();
        assert!(
            expected.contains("construction center") || expected.contains("construction_center"),
            "unexpected center rejection: {expected}",
        );

        let mut double_failure = center_failure;
        let tower_index = (0..double_failure.entities.ids.len())
            .find(|&entity_index| {
                let entity = double_failure.parse_entity(entity_index).unwrap();
                entity.get("kind").and_then(Value::as_str) == Some("station")
                    && entity.get("quantumMode").and_then(Value::as_str) == Some("quantum")
            })
            .expect("parallel fixture quantum tower");
        let mut tower = double_failure.parse_entity(tower_index).unwrap();
        tower["stationSlots"] = Value::Null;
        double_failure
            .replace_entity_raw(tower_index, serde_json::to_string(&tower).unwrap().into());
        let source_revision = double_failure.revision;
        let source_bytes = serde_json::to_vec(&double_failure.materialize().unwrap()).unwrap();
        let source_hash = double_failure.canonical_sha256().unwrap();
        for worker_count in [1, 2, 4, 8] {
            let prepared = prepare_construction_tail_certificate_with_runtime(
                &double_failure,
                &snapshots,
                &DeterministicRuntime::for_test(worker_count),
            );
            assert_eq!(prepared.result.unwrap_err(), expected);
        }
        assert_eq!(double_failure.revision, source_revision);
        assert_eq!(double_failure.canonical_sha256().unwrap(), source_hash);
        assert_eq!(
            serde_json::to_vec(&double_failure.materialize().unwrap()).unwrap(),
            source_bytes,
        );
        assert!(double_failure.pure_idle_macro_runtime.is_none());
    }

    #[test]
    fn macro_v10_public_advance_late_malformed_entity_is_atomic_and_installs_no_cache() {
        let mut malformed = parallel_certificate_fixture();
        let malformed_index = malformed.entities.ids.len() - 1;
        malformed.replace_entity_raw(malformed_index, "null".into());
        let source_revision = malformed.revision;
        let source_bytes = serde_json::to_vec(&malformed.materialize().unwrap()).unwrap();
        let source_hash = malformed.canonical_sha256().unwrap();
        let source_credit = malformed.pure_idle_macro_exact_seconds_used();
        assert!(malformed.pure_idle_macro_runtime.is_none());
        let mut expected_reason = None;

        for worker_count in [1, 2, 4, 8] {
            let mut candidate = malformed.clone();
            let request = pure_idle_macro_request(candidate.revision, 60.0, 4.0);
            let result = advance_bounded_with_runtime(
                &mut candidate,
                &request,
                true,
                &DeterministicRuntime::for_test(worker_count),
            )
            .unwrap();
            assert!(!result.supported);
            let reason = result.reason.expect("late malformed rejection");
            assert!(
                reason.contains("pure-idle-settlement-proof-baseline-invalid")
                    && reason.contains("entity is not an object"),
                "workers={worker_count} reason={reason}",
            );
            match &expected_reason {
                None => expected_reason = Some(reason),
                Some(expected) => assert_eq!(&reason, expected),
            }
            assert_eq!(candidate.revision, source_revision);
            assert_eq!(candidate.canonical_sha256().unwrap(), source_hash);
            assert_eq!(
                serde_json::to_vec(&candidate.materialize().unwrap()).unwrap(),
                source_bytes,
            );
            assert_eq!(
                candidate.pure_idle_macro_exact_seconds_used(),
                source_credit
            );
            assert!(candidate.pure_idle_macro_runtime.is_none());
        }
    }

    #[test]
    fn macro_v10_parallel_certificate_domains_match_for_finite_infinite_research_sail_rocket_and_construction_quantum()
     {
        let cases = [
            (
                "finite-source",
                pad_parallel_certificate_fixture(productive_quantum_macro_fixture(15.0, "finite")),
            ),
            (
                "infinite-source",
                pad_parallel_certificate_fixture(productive_quantum_macro_fixture(
                    15.0, "infinite",
                )),
            ),
            (
                "research",
                pad_parallel_certificate_fixture(productive_research_macro_fixture(
                    15.0,
                    ResearchFixtureMode::Finite,
                )),
            ),
            (
                "renewable-sail",
                sustainable_dynamic_ray_power_fixture(14.0),
            ),
            (
                "rocket",
                pad_parallel_certificate_fixture(productive_rocket_macro_fixture(
                    15.0, "infinite", 2, 2, 2_000,
                )),
            ),
        ];
        for (label, state) in cases {
            let multiplier =
                finite_number_at(state.base_value().get("timeWarp"), &["effectiveMultiplier"])
                    .unwrap();
            let request = pure_idle_macro_request(state.revision, 60.0, 60.0 / multiplier);
            let snapshots = exact_three_window_probe(&state, &request)
                .unwrap_or_else(|reason| panic!("{label} probe reason={reason}"));
            let one = prepare_ordinary_flow_certificate_with_runtime(
                &state,
                &snapshots,
                &DeterministicRuntime::for_test(1),
            )
            .result
            .unwrap_or_else(|reason| panic!("{label} one-worker reason={reason}"));
            let eight = prepare_ordinary_flow_certificate_with_runtime(
                &state,
                &snapshots,
                &DeterministicRuntime::for_test(8),
            )
            .result
            .unwrap_or_else(|reason| panic!("{label} eight-worker reason={reason}"));
            assert_eq!(eight, one, "{label} certificate changed by worker count");
            match label {
                "finite-source" => assert!(!one.finite_veins.is_empty()),
                "infinite-source" => assert!(one.finite_veins.is_empty()),
                "research" => assert!(one.research.is_some()),
                "renewable-sail" => {
                    assert!(one.dyson_sail.is_some());
                    assert!(one.dyson_rocket.is_none());
                    assert!(one.renewable_power.is_some());
                }
                "rocket" => {
                    assert!(one.dyson_rocket.is_some());
                    assert!(one.dyson_sail.is_none());
                }
                _ => unreachable!(),
            }
        }

        let state = parallel_certificate_fixture();
        let request = pure_idle_macro_request(state.revision, 60.0, 4.0);
        let snapshots = exact_three_window_probe(&state, &request).unwrap();
        let one = prepare_construction_tail_certificate_with_runtime(
            &state,
            &snapshots,
            &DeterministicRuntime::for_test(1),
        )
        .result
        .unwrap()
        .expect("construction certificate");
        let eight = prepare_construction_tail_certificate_with_runtime(
            &state,
            &snapshots,
            &DeterministicRuntime::for_test(8),
        )
        .result
        .unwrap()
        .expect("construction certificate");
        assert_eq!(eight, one);
        assert!(one.quantum.is_some());
    }

    fn assert_parallel_certificate_wave(
        diagnostics: PartitionedPrepareDiagnostics,
        active_partitions: usize,
    ) {
        assert_eq!(diagnostics.active_partitions, active_partitions);
        assert!(diagnostics.work_items >= 4_096);
        assert!(diagnostics.parallel);
        assert_eq!(diagnostics.selected_worker_count, active_partitions.min(8));
        assert!(
            (1..=diagnostics.selected_worker_count).contains(&diagnostics.observed_worker_count)
        );
    }

    fn assert_certificate_entity_parse(
        diagnostics: IndexedPrepareDiagnostics,
        entity_count: usize,
        worker_count: usize,
    ) {
        assert_eq!(diagnostics.item_count, entity_count);
        let expected_workers = if entity_count < crate::deterministic_runtime::PARALLEL_MIN_ITEMS {
            1
        } else {
            worker_count
        };
        assert_eq!(diagnostics.selected_worker_count, expected_workers);
        assert_eq!(diagnostics.parallel, expected_workers > 1);
        if expected_workers == 1 {
            assert_eq!(diagnostics.observed_worker_count, 1);
        } else {
            assert!(
                (2..=expected_workers).contains(&diagnostics.observed_worker_count),
                "actual entity parser did not demonstrate bounded parallel execution: {diagnostics:?}",
            );
        }
    }

    #[test]
    fn construction_entity_parse_is_owned_by_injected_one_two_four_eight_worker_runtime() {
        let state = parallel_certificate_fixture();
        let request = pure_idle_macro_request(state.revision, 60.0, 4.0);
        let snapshots = exact_three_window_probe(&state, &request).unwrap();
        for worker_count in [1, 2, 4, 8] {
            let prepared = prepare_construction_tail_certificate_with_runtime(
                &state,
                &snapshots,
                &DeterministicRuntime::for_test(worker_count),
            );
            assert!(
                prepared.result.is_ok(),
                "workers={worker_count} reason={:?}",
                prepared.result,
            );
            assert_certificate_entity_parse(
                prepared.entity_parse.expect("construction entity parse"),
                state.entities.ids.len(),
                worker_count,
            );
        }
    }

    #[test]
    fn macro_v10_large_certificate_directory_records_real_bounded_pool_diagnostics() {
        let state = parallel_certificate_fixture();
        let request = pure_idle_macro_request(state.revision, 60.0, 4.0);
        let ordinary_snapshots =
            exact_three_window_probe_isolating_construction(&state, &request).unwrap();
        let construction_snapshots = exact_three_window_probe(&state, &request).unwrap();
        let runtime = DeterministicRuntime::for_test(8);

        let ordinary =
            prepare_ordinary_flow_certificate_with_runtime(&state, &ordinary_snapshots, &runtime);
        assert!(ordinary.result.is_ok(), "reason={:?}", ordinary.result);
        assert!(ordinary.entity_parse.is_none());
        assert_parallel_certificate_wave(ordinary.wave_one.unwrap(), 4);
        assert_parallel_certificate_wave(ordinary.wave_two.unwrap(), 2);

        let construction = prepare_construction_tail_certificate_with_runtime(
            &state,
            &construction_snapshots,
            &runtime,
        );
        assert!(
            construction.result.is_ok(),
            "reason={:?}",
            construction.result
        );
        assert_parallel_certificate_wave(construction.wave.unwrap(), 3);
        assert_certificate_entity_parse(
            construction
                .entity_parse
                .expect("construction entity parse diagnostics"),
            state.entities.ids.len(),
            8,
        );

        let serial_runtime = DeterministicRuntime::for_test(1);
        for diagnostics in [
            prepare_ordinary_flow_certificate_with_runtime(
                &state,
                &ordinary_snapshots,
                &serial_runtime,
            )
            .wave_one
            .unwrap(),
            prepare_ordinary_flow_certificate_with_runtime(
                &state,
                &ordinary_snapshots,
                &serial_runtime,
            )
            .wave_two
            .unwrap(),
            prepare_construction_tail_certificate_with_runtime(
                &state,
                &construction_snapshots,
                &serial_runtime,
            )
            .wave
            .unwrap(),
        ] {
            assert!(!diagnostics.parallel);
            assert_eq!(diagnostics.selected_worker_count, 1);
            assert_eq!(diagnostics.observed_worker_count, 1);
        }

        let small = productive_recipe_construction_quantum_macro_fixture(15.0, 10_000);
        let small_request = pure_idle_macro_request(small.revision, 60.0, 4.0);
        let small_ordinary_snapshots =
            exact_three_window_probe_isolating_construction(&small, &small_request).unwrap();
        let small_construction_snapshots =
            exact_three_window_probe(&small, &small_request).unwrap();
        let small_runtime = DeterministicRuntime::for_test(8);
        let small_ordinary = prepare_ordinary_flow_certificate_with_runtime(
            &small,
            &small_ordinary_snapshots,
            &small_runtime,
        );
        let small_construction = prepare_construction_tail_certificate_with_runtime(
            &small,
            &small_construction_snapshots,
            &small_runtime,
        );
        assert!(small_ordinary.result.is_ok());
        assert!(small_construction.result.is_ok());
        assert!(small_ordinary.entity_parse.is_none());
        assert_certificate_entity_parse(
            small_construction
                .entity_parse
                .expect("small construction entity parse diagnostics"),
            small.entities.ids.len(),
            8,
        );
        for diagnostics in [
            small_ordinary.wave_one.unwrap(),
            small_ordinary.wave_two.unwrap(),
            small_construction.wave.unwrap(),
        ] {
            assert!(diagnostics.work_items < crate::deterministic_runtime::PARALLEL_MIN_ITEMS);
            assert!(!diagnostics.parallel);
            assert_eq!(diagnostics.selected_worker_count, 1);
            assert_eq!(diagnostics.observed_worker_count, 1);
        }
    }

    fn measure_parallel_certificate_prepare(
        state: &CoreState,
        ordinary_snapshots: &[SettlementProofSnapshot],
        construction_snapshots: &[SettlementProofSnapshot],
        runtime: &DeterministicRuntime,
    ) -> std::time::Duration {
        let started = std::time::Instant::now();
        let ordinary =
            prepare_ordinary_flow_certificate_with_runtime(state, ordinary_snapshots, runtime);
        let construction = prepare_construction_tail_certificate_with_runtime(
            state,
            construction_snapshots,
            runtime,
        );
        std::hint::black_box(ordinary.result.unwrap());
        std::hint::black_box(construction.result.unwrap());
        started.elapsed()
    }

    #[test]
    #[ignore = "opt-in release-mode interleaved prepare-only A/B gate"]
    fn profile_macro_v10_parallel_certificate_prepare_only() {
        let state = parallel_certificate_fixture();
        let request = pure_idle_macro_request(state.revision, 60.0, 4.0);
        let ordinary_snapshots =
            exact_three_window_probe_isolating_construction(&state, &request).unwrap();
        let construction_snapshots = exact_three_window_probe(&state, &request).unwrap();
        let source_bytes = serde_json::to_vec(&state.materialize().unwrap()).unwrap();
        let source_bytes_sha256 = hex::encode(Sha256::digest(&source_bytes));
        let source_canonical_sha256 = state.canonical_sha256().unwrap();
        let source_domain_sha256 = state.domain_sha256().unwrap();
        let source_conservation_sha256 = parallel_certificate_conservation_sha256(&state);
        let ordinary_snapshots_sha256 = hex::encode(Sha256::digest(
            ordinary_snapshots
                .iter()
                .map(settlement_snapshot_hash)
                .collect::<Vec<_>>()
                .join("\n")
                .as_bytes(),
        ));
        let construction_snapshots_sha256 = hex::encode(Sha256::digest(
            construction_snapshots
                .iter()
                .map(settlement_snapshot_hash)
                .collect::<Vec<_>>()
                .join("\n")
                .as_bytes(),
        ));
        let one = DeterministicRuntime::for_test(1);
        let eight = DeterministicRuntime::for_test(8);
        for _ in 0..3 {
            std::hint::black_box(measure_parallel_certificate_prepare(
                &state,
                &ordinary_snapshots,
                &construction_snapshots,
                &one,
            ));
            std::hint::black_box(measure_parallel_certificate_prepare(
                &state,
                &ordinary_snapshots,
                &construction_snapshots,
                &eight,
            ));
        }
        let mut one_samples = Vec::with_capacity(15);
        let mut eight_samples = Vec::with_capacity(15);
        let mut order = Vec::with_capacity(30);
        for round in 0..15 {
            let mut measure =
                |label: &'static str, runtime: &DeterministicRuntime, samples: &mut Vec<u128>| {
                    order.push(label);
                    samples.push(
                        measure_parallel_certificate_prepare(
                            &state,
                            &ordinary_snapshots,
                            &construction_snapshots,
                            runtime,
                        )
                        .as_nanos(),
                    );
                };
            if round % 2 == 0 {
                measure("one", &one, &mut one_samples);
                measure("eight", &eight, &mut eight_samples);
            } else {
                measure("eight", &eight, &mut eight_samples);
                measure("one", &one, &mut one_samples);
            }
        }
        let one_samples_in_order = one_samples.clone();
        let eight_samples_in_order = eight_samples.clone();
        one_samples.sort_unstable();
        eight_samples.sort_unstable();
        let one_median = one_samples[one_samples.len() / 2];
        let eight_median = eight_samples[eight_samples.len() / 2];
        let improvement = 1.0 - eight_median as f64 / one_median as f64;
        eprintln!(
            "PURE_IDLE_CERT_PREP_INPUT sourceBytesSha256={source_bytes_sha256} sourceCanonicalSha256={source_canonical_sha256} sourceDomainSha256={source_domain_sha256} sourceConservationSha256={source_conservation_sha256} ordinarySnapshotsSha256={ordinary_snapshots_sha256} constructionSnapshotsSha256={construction_snapshots_sha256} entities={} belts={} workItems={} threshold={}",
            state.entities.ids.len(),
            state.belts.ids.len(),
            pure_idle_certificate_prepare_work_items(&state),
            crate::deterministic_runtime::PARALLEL_MIN_ITEMS,
        );
        eprintln!(
            "PURE_IDLE_CERT_PREP_AB oneMedianNs={one_median} eightMedianNs={eight_median} improvementPct={:.3} order={order:?} oneInOrder={one_samples_in_order:?} eightInOrder={eight_samples_in_order:?} oneSorted={one_samples:?} eightSorted={eight_samples:?}",
            improvement * 100.0
        );
        assert_eq!(
            hex::encode(Sha256::digest(
                serde_json::to_vec(&state.materialize().unwrap()).unwrap()
            )),
            source_bytes_sha256,
            "prepare-only A/B mutated its immutable source fixture"
        );
        assert!(
            improvement >= 0.035,
            "prepare-only median improvement {:.3}% is below the 3.5% merge gate",
            improvement * 100.0
        );
    }
}
