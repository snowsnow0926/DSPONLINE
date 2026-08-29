use std::collections::{BTreeSet, HashMap};

use anyhow::anyhow;
use num_bigint::BigUint;
use num_traits::{ToPrimitive, Zero};
use serde_json::{Map, Value, json};

use crate::deterministic_runtime::{DeterministicRuntime, runtime as deterministic_runtime};
use crate::state::CoreState;

const MAX_DIGITS: usize = 256;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const SETTLEMENT_SECONDS: f64 = 5.0;
const FLEET_RETURN_SECONDS: u64 = 30;
const CARGO_PER_VESSEL: u64 = 100;
const BASE_INTERSTELLAR_THROUGHPUT: u64 = 10_000_000;

const CONSTRUCTION_PHASES: [(&str, &str, u64); 16] = [
    ("轨道基座", "titanium_alloy", 1_000_000),
    ("轨道基座", "frame_material", 500_000),
    ("轨道基座", "small_carrier_rocket", 100_000),
    ("轨道基座", "universe_matrix", 100_000),
    ("主体框架", "frame_material", 2_000_000),
    ("主体框架", "dyson_sphere_component", 1_000_000),
    ("主体框架", "titanium_glass", 1_000_000),
    ("主体框架", "quantum_chip", 500_000),
    ("能源核心", "antimatter_fuel_rod", 250_000),
    ("能源核心", "annihilation_constraint_sphere", 500_000),
    ("能源核心", "strange_matter", 1_000_000),
    ("能源核心", "plane_filter", 1_000_000),
    ("调度核心", "processor", 5_000_000),
    ("调度核心", "particle_broadband", 2_000_000),
    ("调度核心", "quantum_chip", 2_000_000),
    ("调度核心", "universe_matrix", 1_000_000),
];

#[derive(Debug, Clone)]
struct AllocationRequest {
    key: String,
    amount: BigUint,
}

#[derive(Debug)]
struct AllocationResult {
    allocations: HashMap<String, BigUint>,
    next_cursor: usize,
}

#[derive(Debug)]
struct HubEntry {
    system_id: String,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct ModeTransitionScan {
    pub selected_rows: usize,
    pub total_rows: usize,
    pub transition_rows: usize,
    pub route_reference_probes: usize,
    pub dense_fallback: bool,
    pub index_fallback: bool,
    pub ledger_fallback: bool,
}

#[derive(Debug, Clone)]
struct ModeTransitionCandidate {
    entity_index: usize,
    station_id: String,
    transition: String,
}

#[derive(Debug)]
struct ModeTransitionCandidateProbe {
    candidate: Option<ModeTransitionCandidate>,
    #[cfg(test)]
    worker_index: Option<usize>,
}

#[derive(Debug, Clone)]
struct ModeTransitionPatch {
    entity_index: usize,
    target_mode: &'static str,
}

/// Runs only the read-only elevator admission probe in parallel. Sparse saves
/// visit the immutable system-station candidates; dense saves pass `None` and
/// deliberately retain the historical full scan. Ordered collection and the
/// serial grouping pass preserve persisted entity order exactly; inventory
/// allocation and every fairness cursor remain on the deterministic serial
/// commit path below.
fn collect_station_groups_with_runtime<K, F>(
    runtime: &DeterministicRuntime,
    entities: &[Value],
    candidate_indices: Option<&[usize]>,
    classify: F,
) -> Vec<(K, Vec<usize>)>
where
    K: PartialEq + Send,
    F: Fn(usize, &Value) -> Option<K> + Send + Sync,
{
    let admitted = if let Some(candidate_indices) = candidate_indices {
        runtime.indexed_map(candidate_indices, |_, &entity_index| {
            (
                entity_index,
                entities
                    .get(entity_index)
                    .and_then(|entity| classify(entity_index, entity)),
            )
        })
    } else {
        runtime.indexed_map(entities, |entity_index, entity| {
            (entity_index, classify(entity_index, entity))
        })
    };
    let mut stations_by_system = Vec::<(K, Vec<usize>)>::new();
    for (entity_index, system_id) in admitted {
        let Some(system_id) = system_id else {
            continue;
        };
        if let Some((_, indexes)) = stations_by_system
            .iter_mut()
            .find(|(candidate, _)| candidate == &system_id)
        {
            indexes.push(entity_index);
        } else {
            stations_by_system.push((system_id, vec![entity_index]));
        }
    }
    stations_by_system
}

fn finite_number(value: Option<&Value>) -> f64 {
    value
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
        .unwrap_or(0.0)
}

fn string_at<'a>(object: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    object.get(key).and_then(Value::as_str)
}

fn safe_amount(value: Option<&Value>) -> u64 {
    let amount = finite_number(value).floor().max(0.0);
    amount.min(MAX_SAFE_INTEGER as f64) as u64
}

fn safe_count(value: Option<&Value>) -> u64 {
    value
        .and_then(Value::as_u64)
        .filter(|value| *value <= MAX_SAFE_INTEGER)
        .unwrap_or(0)
}

fn integer(value: Option<&Value>) -> BigUint {
    match value {
        Some(Value::String(text))
            if !text.is_empty()
                && text.len() <= MAX_DIGITS
                && text.bytes().all(|byte| byte.is_ascii_digit()) =>
        {
            BigUint::parse_bytes(text.as_bytes(), 10).unwrap_or_default()
        }
        Some(Value::Number(number)) => number
            .as_u64()
            .filter(|value| *value <= MAX_SAFE_INTEGER)
            .map(BigUint::from)
            .unwrap_or_default(),
        _ => BigUint::zero(),
    }
}

fn decimal(value: BigUint) -> String {
    let text = value.to_string();
    if text.len() <= MAX_DIGITS {
        text
    } else {
        "9".repeat(MAX_DIGITS)
    }
}

fn positive_difference(left: BigUint, right: BigUint) -> BigUint {
    if left > right {
        left - right
    } else {
        BigUint::zero()
    }
}

fn add_integer(left: Option<&Value>, right: BigUint) -> String {
    decimal(integer(left) + right)
}

fn planet_system_id<'a>(state: &'a CoreState, planet_id: &str) -> Option<&'a str> {
    state
        .catalog
        .planets
        .iter()
        .find(|planet| planet.id == planet_id)
        .map(|planet| planet.system_id.as_str())
}

fn entity_system_id<'a>(state: &'a CoreState, entity: &Map<String, Value>) -> Option<&'a str> {
    planet_system_id(state, string_at(entity, "planetId")?)
}

pub(crate) fn is_elevator(entity: &Map<String, Value>) -> bool {
    string_at(entity, "buildingId") == Some("interstellar_logistics_station")
        && finite_number(entity.get("stationTier")).floor() == 2.0
        && string_at(entity, "stationOperationMode") == Some("elevator")
}

fn system_stations(base: &Map<String, Value>) -> Option<&Map<String, Value>> {
    base.get("systemSpaceStations").and_then(Value::as_object)
}

fn system_status<'a>(base: &'a Map<String, Value>, system_id: &str) -> Option<&'a str> {
    system_stations(base)
        .and_then(|stations| stations.get(system_id))
        .and_then(Value::as_object)
        .and_then(|station| string_at(station, "status"))
}

fn completed_tech(base: &Map<String, Value>, tech_id: &str) -> bool {
    base.get("research")
        .and_then(Value::as_object)
        .and_then(|research| research.get("completedTechIds"))
        .and_then(Value::as_array)
        .is_some_and(|ids| ids.iter().any(|id| id.as_str() == Some(tech_id)))
}

pub(crate) fn admission_reason(state: &CoreState) -> anyhow::Result<Option<&'static str>> {
    let base = state.base_value();
    let Some(stations) = system_stations(base) else {
        return Ok(Some("system-space-station-directory-missing"));
    };
    for (system_id, value) in stations {
        if !state
            .catalog
            .planets
            .iter()
            .any(|planet| planet.system_id == *system_id)
        {
            return Ok(Some("system-space-station-system-invalid"));
        }
        let Some(station) = value.as_object() else {
            return Ok(Some("system-space-station-record-invalid"));
        };
        if string_at(station, "systemId") != Some(system_id)
            || !matches!(
                string_at(station, "status"),
                Some("not-started" | "building" | "operational")
            )
            || station
                .get("delivered")
                .and_then(Value::as_object)
                .is_none()
            || station
                .get("constructionBuffer")
                .and_then(Value::as_object)
                .is_none()
            || station
                .get("inventory")
                .and_then(Value::as_object)
                .is_none()
            || station
                .get("itemPolicies")
                .and_then(Value::as_object)
                .is_none()
            || station.get("modules").and_then(Value::as_object).is_none()
            || station
                .get("routingCursors")
                .and_then(Value::as_object)
                .is_none()
        {
            return Ok(Some("system-space-station-record-invalid"));
        }
    }
    let Some(network) = base.get("galacticHubNetwork").and_then(Value::as_object) else {
        return Ok(Some("galactic-hub-network-missing"));
    };
    if network
        .get("fleetReturns")
        .and_then(Value::as_array)
        .is_none()
        || network
            .get("routingCursors")
            .and_then(Value::as_object)
            .is_none()
    {
        return Ok(Some("galactic-hub-network-invalid"));
    }
    for index in 0..state.entity_index.len() {
        let entity = state.parse_entity(index)?;
        let entity = entity
            .as_object()
            .ok_or_else(|| anyhow!("native system station entity is invalid"))?;
        if string_at(entity, "buildingId") == Some("space_station_construction_launcher")
            && (string_at(entity, "kind") != Some("station")
                || entity.get("inputs").and_then(Value::as_object).is_none()
                || entity.get("outputs").and_then(Value::as_object).is_none())
        {
            return Ok(Some("space-station-launcher-invalid"));
        }
        if string_at(entity, "buildingId") == Some("interstellar_logistics_station") {
            if entity.get("stationModeTransition").is_some_and(|value| {
                !value.is_null() && !matches!(value.as_str(), Some("to-elevator" | "to-legacy"))
            }) {
                return Ok(Some("station-mode-transition-invalid"));
            }
            if is_elevator(entity)
                && (entity.get("inputs").and_then(Value::as_object).is_none()
                    || entity.get("outputs").and_then(Value::as_object).is_none()
                    || entity
                        .get("elevatorOutputItems")
                        .and_then(Value::as_array)
                        .is_none_or(|items| items.len() != 5))
            {
                return Ok(Some("elevator-station-record-invalid"));
            }
        }
    }
    Ok(None)
}

pub(crate) fn active_power_consumers(
    state: &CoreState,
    base: &Map<String, Value>,
    entities: &[Value],
) -> Vec<usize> {
    let active_at = |index: usize, entity: &Value| {
        let entity = entity.as_object()?;
        let system_id = entity_system_id(state, entity)?;
        let active = string_at(entity, "buildingId") == Some("space_station_construction_launcher")
            && system_status(base, system_id) == Some("building")
            || is_elevator(entity) && system_status(base, system_id) == Some("operational");
        active.then_some(index)
    };
    if state
        .factory_topology
        .system_space_station_full_scan_required
    {
        entities
            .iter()
            .enumerate()
            .filter_map(|(index, entity)| active_at(index, entity))
            .collect()
    } else {
        state
            .factory_topology
            .system_space_station_entity_indices
            .iter()
            .filter_map(|&index| {
                entities
                    .get(index)
                    .and_then(|entity| active_at(index, entity))
            })
            .collect()
    }
}

fn required_phase_amount(base_amount: u64, basis_points: f64) -> BigUint {
    let multiplier = basis_points.floor().clamp(8_000.0, 10_000.0) as u64;
    BigUint::from((base_amount * multiplier).div_ceil(10_000))
}

fn apply_construction_buffer(station: &mut Map<String, Value>) -> anyhow::Result<bool> {
    let basis_points = finite_number(station.get("costMultiplierBasisPoints"));
    let mut phase_index =
        safe_amount(station.get("phaseIndex")).min(CONSTRUCTION_PHASES.len() as u64) as usize;
    while phase_index < CONSTRUCTION_PHASES.len() {
        let phase_name = CONSTRUCTION_PHASES[phase_index].0;
        let phase_requirements = CONSTRUCTION_PHASES
            .iter()
            .filter(|(name, _, _)| *name == phase_name)
            .copied()
            .collect::<Vec<_>>();
        let mut phase_complete = true;
        for (_, item_id, base_amount) in &phase_requirements {
            let required = required_phase_amount(*base_amount, basis_points);
            let current = station
                .get("delivered")
                .and_then(Value::as_object)
                .map(|delivered| integer(delivered.get(*item_id)))
                .unwrap_or_default();
            let remaining = positive_difference(required.clone(), current.clone());
            let available = station
                .get("constructionBuffer")
                .and_then(Value::as_object)
                .map(|buffer| integer(buffer.get(*item_id)))
                .unwrap_or_default();
            let take = if available < remaining {
                available.clone()
            } else {
                remaining
            };
            if !take.is_zero() {
                station
                    .get_mut("delivered")
                    .and_then(Value::as_object_mut)
                    .ok_or_else(|| anyhow!("native system station delivery record is missing"))?
                    .insert(item_id.to_string(), Value::from(decimal(current + &take)));
                station
                    .get_mut("constructionBuffer")
                    .and_then(Value::as_object_mut)
                    .ok_or_else(|| anyhow!("native system station construction buffer is missing"))?
                    .insert(item_id.to_string(), Value::from(decimal(available - take)));
            }
            let delivered = station
                .get("delivered")
                .and_then(Value::as_object)
                .map(|values| integer(values.get(*item_id)))
                .unwrap_or_default();
            if delivered < required {
                phase_complete = false;
            }
        }
        if !phase_complete {
            break;
        }
        phase_index += phase_requirements.len();
    }
    let completed = phase_index >= CONSTRUCTION_PHASES.len();
    station.insert("phaseIndex".to_owned(), Value::from(phase_index as u64));
    station.insert(
        "status".to_owned(),
        Value::from(if completed { "operational" } else { "building" }),
    );
    Ok(completed)
}

pub(crate) fn settle_construction(
    state: &CoreState,
    base: &mut Map<String, Value>,
    entities: &mut [Value],
) -> anyhow::Result<()> {
    for &entity_index in &state.factory_topology.space_station_launcher_indices {
        let (system_id, power_factor, inputs) = {
            let launcher = entities[entity_index]
                .as_object()
                .ok_or_else(|| anyhow!("native space station launcher is invalid"))?;
            let Some(system_id) = entity_system_id(state, launcher).map(str::to_owned) else {
                continue;
            };
            if system_status(base, &system_id) != Some("building") {
                continue;
            }
            let power_factor = launcher
                .get("powerFactor")
                .and_then(Value::as_f64)
                .filter(|value| value.is_finite())
                .unwrap_or(1.0)
                .clamp(0.0, 1.0);
            let inputs = launcher
                .get("inputs")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            (system_id, power_factor, inputs)
        };
        let mut accepted = Vec::<(String, u64)>::new();
        for (item_id, amount) in inputs {
            if !state.catalog.items.contains_key(&item_id) {
                continue;
            }
            let amount = safe_amount(Some(&amount));
            let moved = (amount as f64 * power_factor).floor() as u64;
            if moved > 0 {
                accepted.push((item_id, moved));
            }
        }
        if accepted.is_empty() {
            continue;
        }
        let station = base
            .get_mut("systemSpaceStations")
            .and_then(Value::as_object_mut)
            .and_then(|stations| stations.get_mut(&system_id))
            .and_then(Value::as_object_mut)
            .ok_or_else(|| anyhow!("native system space station is missing"))?;
        for (item_id, moved) in &accepted {
            let buffer = station
                .get_mut("constructionBuffer")
                .and_then(Value::as_object_mut)
                .ok_or_else(|| anyhow!("native system construction buffer is missing"))?;
            let value = add_integer(buffer.get(item_id), BigUint::from(*moved));
            buffer.insert(item_id.clone(), Value::from(value));
            let launcher = entities[entity_index]
                .as_object_mut()
                .expect("validated launcher");
            let current = launcher
                .get("inputs")
                .and_then(Value::as_object)
                .map(|inputs| safe_amount(inputs.get(item_id)))
                .unwrap_or(0);
            launcher
                .get_mut("inputs")
                .and_then(Value::as_object_mut)
                .expect("validated launcher inputs")
                .insert(item_id.clone(), Value::from(current.saturating_sub(*moved)));
        }
        apply_construction_buffer(station)?;
    }
    Ok(())
}

fn route_references_station(entities: &[Value], station_id: &str) -> bool {
    entities
        .iter()
        .filter_map(Value::as_object)
        .any(|candidate| {
            let candidate_id = string_at(candidate, "id").unwrap_or_default();
            candidate
                .get("stationRoutes")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_object)
                .any(|route| {
                    candidate_id == station_id
                        || string_at(route, "peerId") == Some(station_id)
                        || string_at(route, "vehicleStationId") == Some(station_id)
                        || route
                            .get("waypointStationIds")
                            .and_then(Value::as_array)
                            .is_some_and(|ids| ids.iter().any(|id| id.as_str() == Some(station_id)))
                })
        })
}

fn mode_transition_candidate(
    entity_index: usize,
    entity: Option<&Value>,
) -> ModeTransitionCandidateProbe {
    let candidate = entity.and_then(Value::as_object).and_then(|entity| {
        let transition = string_at(entity, "stationModeTransition")?;
        let station_id = string_at(entity, "id")?;
        Some(ModeTransitionCandidate {
            entity_index,
            station_id: station_id.to_owned(),
            transition: transition.to_owned(),
        })
    });
    ModeTransitionCandidateProbe {
        candidate,
        #[cfg(test)]
        worker_index: rayon::current_thread_index(),
    }
}

fn transition_index_is_valid(state: &CoreState, entities: &[Value]) -> bool {
    let indices = &state.factory_topology.station_mode_transition_indices;
    state.entities.ids.len() == entities.len()
        && indices.last().is_none_or(|index| *index < entities.len())
        && indices.windows(2).all(|pair| pair[0] < pair[1])
        && indices.iter().all(|&index| {
            entities
                .get(index)
                .and_then(Value::as_object)
                .and_then(|entity| entity.get("stationModeTransition"))
                .is_some_and(|transition| transition.is_string() || transition.is_null())
        })
}

fn collect_mode_transition_candidates(
    runtime: &DeterministicRuntime,
    state: &CoreState,
    entities: &[Value],
) -> (Vec<ModeTransitionCandidate>, ModeTransitionScan) {
    let index_fallback = !state
        .factory_topology
        .station_mode_transition_full_scan_required
        && !transition_index_is_valid(state, entities);
    let use_full_scan = state
        .factory_topology
        .station_mode_transition_full_scan_required
        || index_fallback;
    let probes = if use_full_scan {
        runtime.indexed_map(entities, |entity_index, entity| {
            mode_transition_candidate(entity_index, Some(entity))
        })
    } else {
        runtime.indexed_map(
            &state.factory_topology.station_mode_transition_indices,
            |_, &entity_index| mode_transition_candidate(entity_index, entities.get(entity_index)),
        )
    };
    let mut candidates = Vec::new();
    for probe in probes {
        #[cfg(test)]
        let _ = probe.worker_index;
        if let Some(candidate) = probe.candidate {
            candidates.push(candidate);
        }
    }
    let scan = ModeTransitionScan {
        selected_rows: if use_full_scan {
            entities.len()
        } else {
            state.factory_topology.station_mode_transition_indices.len()
        },
        total_rows: entities.len(),
        transition_rows: candidates.len(),
        dense_fallback: state
            .factory_topology
            .station_mode_transition_full_scan_required,
        index_fallback,
        ..ModeTransitionScan::default()
    };
    (candidates, scan)
}

fn plan_mode_transition_patches<F>(
    runtime: &DeterministicRuntime,
    candidates: &[ModeTransitionCandidate],
    route_references: F,
) -> anyhow::Result<Vec<Option<ModeTransitionPatch>>>
where
    F: Fn(usize, &str) -> anyhow::Result<bool> + Send + Sync,
{
    runtime.indexed_try_map(candidates, |_, candidate| {
        Ok(
            (!route_references(candidate.entity_index, &candidate.station_id)?).then_some(
                ModeTransitionPatch {
                    entity_index: candidate.entity_index,
                    target_mode: if candidate.transition == "to-elevator" {
                        "elevator"
                    } else {
                        "legacy"
                    },
                },
            ),
        )
    })
}

fn commit_mode_transition_patches(
    entities: &mut [Value],
    patches: Vec<Option<ModeTransitionPatch>>,
) -> anyhow::Result<bool> {
    // Preflight every target before the first write. A future fallible route
    // probe or malformed candidate can therefore never leave a partial mode
    // transition in the candidate state.
    for patch in patches.iter().flatten() {
        if entities
            .get(patch.entity_index)
            .and_then(Value::as_object)
            .is_none()
        {
            return Err(anyhow!("native transitioning station is invalid"));
        }
    }
    let mut changed = false;
    for patch in patches.into_iter().flatten() {
        let station = entities[patch.entity_index]
            .as_object_mut()
            .expect("preflighted transitioning station");
        station.insert(
            "stationOperationMode".to_owned(),
            Value::from(patch.target_mode),
        );
        station.insert("stationModeTransition".to_owned(), Value::Null);
        changed = true;
    }
    Ok(changed)
}

fn settle_mode_transition_candidates<F>(
    runtime: &DeterministicRuntime,
    entities: &mut [Value],
    candidates: &[ModeTransitionCandidate],
    route_references: F,
) -> anyhow::Result<bool>
where
    F: Fn(usize, &str) -> anyhow::Result<bool> + Send + Sync,
{
    let patches = plan_mode_transition_patches(runtime, candidates, route_references)?;
    commit_mode_transition_patches(entities, patches)
}

fn settle_mode_transitions_with_runtime(
    runtime: &DeterministicRuntime,
    state: &CoreState,
    entities: &mut [Value],
    route_ledger: &crate::station_route_ledger::StationRouteLedger,
) -> anyhow::Result<(bool, ModeTransitionScan)> {
    let (candidates, mut scan) = collect_mode_transition_candidates(runtime, state, entities);
    scan.route_reference_probes = candidates.len();
    let ledger_usable = route_ledger.has_route_reference_index()
        && candidates.iter().all(|candidate| {
            candidate.entity_index < state.entities.ids.len()
                && &state.entities.ids[candidate.entity_index] == candidate.station_id.as_str()
        });
    scan.ledger_fallback = !candidates.is_empty() && !ledger_usable;
    let changed = if ledger_usable {
        settle_mode_transition_candidates(runtime, entities, &candidates, |entity_index, _| {
            Ok(route_ledger.references_station(entity_index))
        })?
    } else {
        let frozen_entities: &[Value] = entities;
        let patches = plan_mode_transition_patches(runtime, &candidates, |_, station_id| {
            Ok(route_references_station(frozen_entities, station_id))
        })?;
        commit_mode_transition_patches(entities, patches)?
    };
    Ok((changed, scan))
}

#[cfg(test)]
fn settle_mode_transitions(
    state: &CoreState,
    entities: &mut [Value],
    route_ledger: &crate::station_route_ledger::StationRouteLedger,
) -> anyhow::Result<bool> {
    settle_mode_transitions_with_scan(state, entities, route_ledger).map(|(changed, _)| changed)
}

pub(crate) fn settle_mode_transitions_with_scan(
    state: &CoreState,
    entities: &mut [Value],
    route_ledger: &crate::station_route_ledger::StationRouteLedger,
) -> anyhow::Result<(bool, ModeTransitionScan)> {
    settle_mode_transitions_with_runtime(deterministic_runtime(), state, entities, route_ledger)
}

fn allocate_budget(
    budget: BigUint,
    requests: impl IntoIterator<Item = AllocationRequest>,
    cursor: usize,
) -> AllocationResult {
    let mut requests = requests
        .into_iter()
        .filter(|request| !request.key.is_empty() && !request.amount.is_zero())
        .collect::<Vec<_>>();
    requests.sort_by(|left, right| left.key.cmp(&right.key));
    let mut allocations = HashMap::new();
    if requests.is_empty() || budget.is_zero() {
        for request in requests {
            allocations.insert(request.key, BigUint::zero());
        }
        return AllocationResult {
            allocations,
            next_cursor: 0,
        };
    }
    let total = requests
        .iter()
        .fold(BigUint::zero(), |sum, request| sum + &request.amount);
    let available = budget.min(total.clone());
    let mut allocated = BigUint::zero();
    for request in &requests {
        let amount = &available * &request.amount / &total;
        allocated += &amount;
        allocations.insert(request.key.clone(), amount);
    }
    let mut remainder = &available - &allocated;
    let start = cursor % requests.len();
    for offset in 0..requests.len() * 2 {
        if remainder.is_zero() {
            break;
        }
        let request = &requests[(start + offset) % requests.len()];
        let current = allocations.get(&request.key).cloned().unwrap_or_default();
        if current >= request.amount {
            continue;
        }
        allocations.insert(request.key.clone(), current + 1_u8);
        remainder -= 1_u8;
    }
    let actually_allocated = available - remainder;
    let advance = (&actually_allocated % BigUint::from(requests.len()))
        .to_usize()
        .unwrap_or(0);
    AllocationResult {
        allocations,
        next_cursor: (start + advance) % requests.len(),
    }
}

fn empty_system_hub(system_id: &str) -> Value {
    json!({
        "systemId": system_id,
        "status": "not-started",
        "costRevision": 0,
        "costMultiplierBasisPoints": 10000,
        "phaseIndex": 0,
        "delivered": {},
        "constructionBuffer": {},
        "inventory": {},
        "itemPolicies": {},
        "modules": { "backbone": 0, "energy": 0, "interstellar": 0 },
        "routingCursors": {},
        "viewport": { "x": 0, "y": 0, "zoom": 0.85 },
        "decorations": [],
    })
}

fn ensure_hub<'a>(
    stations: &'a mut Map<String, Value>,
    system_id: &str,
) -> &'a mut Map<String, Value> {
    stations
        .entry(system_id.to_owned())
        .or_insert_with(|| empty_system_hub(system_id))
        .as_object_mut()
        .expect("validated system hub")
}

fn hub_integer(hub: &Map<String, Value>, record: &str, item_id: &str) -> BigUint {
    hub.get(record)
        .and_then(Value::as_object)
        .map(|values| integer(values.get(item_id)))
        .unwrap_or_default()
}

fn set_hub_integer(
    hub: &mut Map<String, Value>,
    record: &str,
    item_id: &str,
    amount: BigUint,
) -> anyhow::Result<()> {
    hub.get_mut(record)
        .and_then(Value::as_object_mut)
        .ok_or_else(|| anyhow!("native system hub integer record is missing"))?
        .insert(item_id.to_owned(), Value::from(decimal(amount)));
    Ok(())
}

fn station_power_factor(entities: &[Value], indexes: &[usize]) -> f64 {
    if indexes.is_empty() {
        return 1.0;
    }
    indexes.iter().fold(1.0, |factor, index| {
        let station = entities[*index].as_object().expect("validated elevator");
        let value = station
            .get("powerFactor")
            .and_then(Value::as_f64)
            .filter(|value| value.is_finite())
            .unwrap_or(1.0)
            .clamp(0.0, 1.0);
        factor.min(value)
    })
}

fn logistics_buffer_limit(base: &Map<String, Value>) -> u64 {
    let raw = base
        .get("settings")
        .and_then(Value::as_object)
        .and_then(|settings| settings.get("logisticsBufferLimit"));
    match raw.and_then(Value::as_u64) {
        Some(value) if value <= MAX_SAFE_INTEGER => value.clamp(1_000, 100_000_000),
        _ => 1_000_000,
    }
}

fn station_output_capacity(
    state: &CoreState,
    base: &Map<String, Value>,
    station: &Map<String, Value>,
) -> u64 {
    let Some(building) =
        string_at(station, "buildingId").and_then(|id| state.catalog.buildings.get(id))
    else {
        return 0;
    };
    let count = safe_amount(station.get("machineCount")).max(1);
    let rated = building.output_capacity.floor().max(0.0) as u64;
    rated
        .saturating_mul(count)
        .min(logistics_buffer_limit(base))
}

fn system_distance_ly(base: &Map<String, Value>, source: &str, target: &str) -> f64 {
    if source == target {
        return 0.0;
    }
    let coordinate = |system_id: &str, key: &str| {
        base.get("galaxy")
            .and_then(Value::as_object)
            .and_then(|galaxy| galaxy.get("systemProfiles"))
            .and_then(Value::as_object)
            .and_then(|profiles| profiles.get(system_id))
            .and_then(Value::as_object)
            .and_then(|profile| profile.get(key))
            .map(|value| finite_number(Some(value)))
            .unwrap_or(0.0)
    };
    let dx = coordinate(source, "positionX") - coordinate(target, "positionX");
    let dy = coordinate(source, "positionY") - coordinate(target, "positionY");
    ((dx.hypot(dy).max(0.1) * 10_000.0).round()) / 10_000.0
}

fn merge_fleet_return(
    base: &Map<String, Value>,
    network: &mut Map<String, Value>,
    route_key: String,
    simulation_second: u64,
    source_system: &str,
    target_system: &str,
    vessel_count: u64,
) -> anyhow::Result<()> {
    if vessel_count == 0 {
        return Ok(());
    }
    let distance = system_distance_ly(base, source_system, target_system);
    let return_seconds = FLEET_RETURN_SECONDS.max((15.0 + distance * 2.0).ceil() as u64);
    let return_at = simulation_second.saturating_add(return_seconds);
    let buckets = network
        .get_mut("fleetReturns")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| anyhow!("native hub fleet return buckets are missing"))?;
    if let Some(bucket) = buckets
        .iter_mut()
        .filter_map(Value::as_object_mut)
        .find(|bucket| {
            string_at(bucket, "routeKey") == Some(&route_key)
                && safe_count(bucket.get("returnAtSecond")) == return_at
        })
    {
        let current = safe_count(bucket.get("vesselCount"));
        bucket.insert(
            "vesselCount".to_owned(),
            Value::from(current.saturating_add(vessel_count).min(MAX_SAFE_INTEGER)),
        );
    } else {
        buckets.push(json!({
            "routeKey": route_key,
            "returnAtSecond": return_at,
            "vesselCount": vessel_count,
        }));
    }
    buckets.sort_by(|left, right| {
        let left = left.as_object().expect("validated fleet bucket");
        let right = right.as_object().expect("validated fleet bucket");
        safe_count(left.get("returnAtSecond"))
            .cmp(&safe_count(right.get("returnAtSecond")))
            .then_with(|| {
                string_at(left, "routeKey")
                    .unwrap_or_default()
                    .cmp(string_at(right, "routeKey").unwrap_or_default())
            })
    });
    Ok(())
}

pub(crate) fn settle_hubs(
    state: &CoreState,
    base: &mut Map<String, Value>,
    entities: &mut [Value],
    simulation_second: f64,
) -> anyhow::Result<()> {
    let simulation_second = simulation_second.floor().max(0.0) as u64;
    let mut stations = base
        .get("systemSpaceStations")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let mut network = base
        .get("galacticHubNetwork")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_else(|| {
            json!({
                "fleetInstalled": 0,
                "fleetBusy": 0,
                "fleetReturns": [],
                "warpers": "0",
                "warperTarget": "0",
                "routingCursors": {},
            })
            .as_object()
            .expect("hub network object")
            .clone()
        });

    let old_buckets = network
        .get("fleetReturns")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut released = 0_u64;
    let mut remaining_buckets = Vec::new();
    for bucket in old_buckets {
        let Some(bucket_object) = bucket.as_object() else {
            continue;
        };
        let return_at = bucket_object
            .get("returnAtSecond")
            .and_then(Value::as_u64)
            .filter(|value| *value <= MAX_SAFE_INTEGER)
            .unwrap_or(MAX_SAFE_INTEGER);
        let vessels = safe_count(bucket_object.get("vesselCount"));
        if return_at <= simulation_second {
            released = released.saturating_add(vessels).min(MAX_SAFE_INTEGER);
        } else {
            remaining_buckets.push(json!({
                "routeKey": string_at(bucket_object, "routeKey").unwrap_or_default(),
                "returnAtSecond": return_at,
                "vesselCount": vessels,
            }));
        }
    }
    remaining_buckets.sort_by(|left, right| {
        let left = left.as_object().expect("fleet bucket");
        let right = right.as_object().expect("fleet bucket");
        safe_count(left.get("returnAtSecond"))
            .cmp(&safe_count(right.get("returnAtSecond")))
            .then_with(|| {
                string_at(left, "routeKey")
                    .unwrap_or_default()
                    .cmp(string_at(right, "routeKey").unwrap_or_default())
            })
    });
    network.insert("fleetReturns".to_owned(), Value::Array(remaining_buckets));
    let busy = safe_count(network.get("fleetBusy"));
    network.insert(
        "fleetBusy".to_owned(),
        Value::from(busy.saturating_sub(released)),
    );

    let mut stations_by_system = collect_station_groups_with_runtime(
        deterministic_runtime(),
        entities,
        (!state
            .factory_topology
            .system_space_station_full_scan_required)
            .then_some(
                state
                    .factory_topology
                    .system_space_station_entity_indices
                    .as_slice(),
            ),
        |_, entity| {
            let entity = entity.as_object()?;
            let system_id = entity_system_id(state, entity)?;
            (is_elevator(entity)
                && stations
                    .get(system_id)
                    .and_then(Value::as_object)
                    .and_then(|hub| string_at(hub, "status"))
                    == Some("operational"))
            .then_some(system_id)
        },
    )
    .into_iter()
    .map(|(system_id, indexes)| (system_id.to_owned(), indexes))
    .collect::<Vec<_>>();

    for (system_id, station_indexes) in &mut stations_by_system {
        station_indexes.sort_by(|left, right| {
            entities[*left]
                .as_object()
                .and_then(|entity| string_at(entity, "id"))
                .cmp(
                    &entities[*right]
                        .as_object()
                        .and_then(|entity| string_at(entity, "id")),
                )
        });
        let power_factor = station_power_factor(entities, station_indexes);
        let hub = ensure_hub(&mut stations, system_id);
        for &entity_index in station_indexes.iter() {
            let inputs = entities[entity_index]
                .as_object()
                .and_then(|station| station.get("inputs"))
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            for (item_id, amount) in inputs {
                let amount = safe_amount(Some(&amount));
                let accepted = (amount as f64 * power_factor).floor() as u64;
                if accepted == 0 {
                    continue;
                }
                let current = hub_integer(hub, "inventory", &item_id);
                set_hub_integer(hub, "inventory", &item_id, current + accepted)?;
                entities[entity_index]
                    .as_object_mut()
                    .and_then(|station| station.get_mut("inputs"))
                    .and_then(Value::as_object_mut)
                    .expect("validated elevator inputs")
                    .insert(item_id, Value::from(amount - accepted));
            }
        }

        let mut output_items = BTreeSet::<String>::new();
        for &entity_index in station_indexes.iter() {
            let station = entities[entity_index]
                .as_object()
                .expect("validated elevator");
            for item in station
                .get("elevatorOutputItems")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .take(5)
                .filter_map(Value::as_str)
            {
                output_items.insert(item.to_owned());
            }
        }
        for item_id in output_items {
            let mut requests = Vec::<(AllocationRequest, usize)>::new();
            for &entity_index in station_indexes.iter() {
                let station = entities[entity_index]
                    .as_object()
                    .expect("validated elevator");
                let capacity = station_output_capacity(state, base, station);
                let mut seen = BTreeSet::new();
                for (port_index, assigned) in station
                    .get("elevatorOutputItems")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .take(5)
                    .enumerate()
                {
                    let Some(assigned) = assigned.as_str() else {
                        continue;
                    };
                    if !seen.insert(assigned.to_owned()) || assigned != item_id {
                        continue;
                    }
                    let current = station
                        .get("outputs")
                        .and_then(Value::as_object)
                        .map(|outputs| safe_amount(outputs.get(&item_id)))
                        .unwrap_or(0);
                    let free = capacity.saturating_sub(current);
                    if free > 0 {
                        requests.push((
                            AllocationRequest {
                                key: format!(
                                    "{}:{port_index}",
                                    string_at(station, "id").unwrap_or_default()
                                ),
                                amount: BigUint::from(free),
                            },
                            entity_index,
                        ));
                    }
                }
            }
            if requests.is_empty() {
                continue;
            }
            let backbone = hub
                .get("modules")
                .and_then(Value::as_object)
                .map(|modules| safe_count(modules.get("backbone")))
                .unwrap_or(0);
            let throughput = ((BASE_INTERSTELLAR_THROUGHPUT as f64
                * backbone.saturating_add(1) as f64
                * power_factor)
                .floor()
                .min(MAX_SAFE_INTEGER as f64)) as u64;
            let inventory = hub_integer(hub, "inventory", &item_id);
            let budget = inventory.min(BigUint::from(throughput));
            let cursor = hub
                .get("routingCursors")
                .and_then(Value::as_object)
                .map(|cursors| safe_count(cursors.get(&item_id)) as usize)
                .unwrap_or(0);
            let allocation = allocate_budget(
                budget,
                requests.iter().map(|(request, _)| request.clone()),
                cursor,
            );
            hub.get_mut("routingCursors")
                .and_then(Value::as_object_mut)
                .expect("validated hub cursors")
                .insert(item_id.clone(), Value::from(allocation.next_cursor as u64));
            for (request, entity_index) in requests {
                let moved = allocation
                    .allocations
                    .get(&request.key)
                    .and_then(BigUint::to_u64)
                    .unwrap_or(0);
                if moved == 0 {
                    continue;
                }
                let station = entities[entity_index]
                    .as_object_mut()
                    .expect("validated elevator");
                let outputs = station
                    .get_mut("outputs")
                    .and_then(Value::as_object_mut)
                    .expect("validated elevator outputs");
                let current = safe_amount(outputs.get(&item_id));
                outputs.insert(item_id.clone(), Value::from(current.saturating_add(moved)));
                let current = hub_integer(hub, "inventory", &item_id);
                set_hub_integer(
                    hub,
                    "inventory",
                    &item_id,
                    positive_difference(current, BigUint::from(moved)),
                )?;
            }
        }
    }

    let installed_from_elevators = stations_by_system
        .iter()
        .flat_map(|(_, indexes)| indexes)
        .map(|index| {
            entities[*index]
                .as_object()
                .map(|station| safe_amount(station.get("stationVessels")))
                .unwrap_or(0)
        })
        .fold(0_u64, |sum, value| {
            sum.saturating_add(value).min(MAX_SAFE_INTEGER)
        });
    if installed_from_elevators > 0 {
        network.insert(
            "fleetInstalled".to_owned(),
            Value::from(installed_from_elevators),
        );
        let busy = safe_count(network.get("fleetBusy")).min(installed_from_elevators);
        network.insert("fleetBusy".to_owned(), Value::from(busy));
    }

    let mut operational = stations_by_system
        .iter()
        .map(|(system_id, _)| HubEntry {
            system_id: system_id.clone(),
        })
        .filter(|entry| {
            stations
                .get(&entry.system_id)
                .and_then(Value::as_object)
                .and_then(|hub| string_at(hub, "status"))
                == Some("operational")
        })
        .collect::<Vec<_>>();
    operational.sort_by(|left, right| left.system_id.cmp(&right.system_id));
    if operational.len() >= 2 && completed_tech(base, "unified_system_logistics_protocol") {
        let installed = safe_count(network.get("fleetInstalled"));
        let busy = safe_count(network.get("fleetBusy"));
        let free_vessels = installed.saturating_sub(busy);
        let module_count = operational.iter().fold(0_u64, |sum, entry| {
            let count = stations
                .get(&entry.system_id)
                .and_then(Value::as_object)
                .and_then(|hub| hub.get("modules"))
                .and_then(Value::as_object)
                .map(|modules| safe_count(modules.get("interstellar")))
                .unwrap_or(0);
            sum.saturating_add(count).min(MAX_SAFE_INTEGER)
        });
        let network_power = operational.iter().fold(1.0_f64, |factor, entry| {
            let indexes = stations_by_system
                .iter()
                .find(|(system_id, _)| system_id == &entry.system_id)
                .map(|(_, indexes)| indexes.as_slice())
                .unwrap_or_default();
            factor.min(station_power_factor(entities, indexes))
        });
        let warper_vessels = (&integer(network.get("warpers")) / BigUint::from(2_u8))
            .min(BigUint::from(MAX_SAFE_INTEGER / CARGO_PER_VESSEL))
            .to_u64()
            .unwrap_or(MAX_SAFE_INTEGER / CARGO_PER_VESSEL);
        let raw_throughput = BASE_INTERSTELLAR_THROUGHPUT
            .saturating_mul(module_count.saturating_add(1))
            .min(free_vessels.saturating_mul(CARGO_PER_VESSEL))
            .min(warper_vessels.saturating_mul(CARGO_PER_VESSEL));
        let throughput = (raw_throughput as f64 * network_power).floor() as u64;
        if throughput > 0 {
            let mut item_ids = BTreeSet::<String>::new();
            for entry in &operational {
                if let Some(policies) = stations
                    .get(&entry.system_id)
                    .and_then(Value::as_object)
                    .and_then(|hub| hub.get("itemPolicies"))
                    .and_then(Value::as_object)
                {
                    item_ids.extend(policies.keys().cloned());
                }
            }
            for item_id in item_ids {
                let mut sources = Vec::<(String, String, BigUint)>::new();
                let mut targets = Vec::<(String, String, BigUint)>::new();
                for entry in &operational {
                    let hub = stations
                        .get(&entry.system_id)
                        .and_then(Value::as_object)
                        .expect("validated operational hub");
                    let Some(policy) = hub
                        .get("itemPolicies")
                        .and_then(Value::as_object)
                        .and_then(|policies| policies.get(&item_id))
                        .and_then(Value::as_object)
                    else {
                        continue;
                    };
                    if policy.get("interstellarEnabled").and_then(Value::as_bool) != Some(true) {
                        continue;
                    }
                    let inventory = hub_integer(hub, "inventory", &item_id);
                    let reserve = integer(policy.get("reserve"));
                    let target = integer(policy.get("target"));
                    if inventory > reserve {
                        sources.push((
                            format!("{}:source", entry.system_id),
                            entry.system_id.clone(),
                            &inventory - &reserve,
                        ));
                    }
                    if target > inventory {
                        targets.push((
                            format!("{}:target", entry.system_id),
                            entry.system_id.clone(),
                            target - inventory,
                        ));
                    }
                }
                if sources.is_empty() || targets.is_empty() {
                    continue;
                }
                let source_allocation = allocate_budget(
                    BigUint::from(throughput),
                    sources.iter().map(|(key, _, amount)| AllocationRequest {
                        key: key.clone(),
                        amount: amount.clone(),
                    }),
                    0,
                );
                let target_allocation = allocate_budget(
                    BigUint::from(throughput),
                    targets.iter().map(|(key, _, amount)| AllocationRequest {
                        key: key.clone(),
                        amount: amount.clone(),
                    }),
                    0,
                );
                let mut source_remaining = sources
                    .iter()
                    .map(|(key, _, _)| {
                        (
                            key.clone(),
                            source_allocation
                                .allocations
                                .get(key)
                                .cloned()
                                .unwrap_or_default(),
                        )
                    })
                    .collect::<HashMap<_, _>>();
                let mut target_remaining = targets
                    .iter()
                    .map(|(key, _, _)| {
                        (
                            key.clone(),
                            target_allocation
                                .allocations
                                .get(key)
                                .cloned()
                                .unwrap_or_default(),
                        )
                    })
                    .collect::<HashMap<_, _>>();
                let mut source_index = 0_usize;
                let mut target_index = 0_usize;
                while source_index < sources.len() && target_index < targets.len() {
                    let source = &sources[source_index];
                    let target = &targets[target_index];
                    if source.1 == target.1 {
                        if let Some(alternative) = (target_index..targets.len()).find(|index| {
                            targets[*index].1 != source.1
                                && !target_remaining
                                    .get(&targets[*index].0)
                                    .is_none_or(BigUint::is_zero)
                        }) {
                            target_index = alternative;
                        } else {
                            source_index += 1;
                            target_index = 0;
                        }
                        continue;
                    }
                    let source_amount =
                        source_remaining.get(&source.0).cloned().unwrap_or_default();
                    let target_amount =
                        target_remaining.get(&target.0).cloned().unwrap_or_default();
                    let moved = source_amount.min(target_amount);
                    if moved.is_zero() {
                        if source_remaining.get(&source.0).is_none_or(BigUint::is_zero) {
                            source_index += 1;
                        }
                        if target_remaining.get(&target.0).is_none_or(BigUint::is_zero) {
                            target_index += 1;
                        }
                        continue;
                    }
                    {
                        let source_hub = ensure_hub(&mut stations, &source.1);
                        let current = hub_integer(source_hub, "inventory", &item_id);
                        set_hub_integer(
                            source_hub,
                            "inventory",
                            &item_id,
                            positive_difference(current, moved.clone()),
                        )?;
                    }
                    {
                        let target_hub = ensure_hub(&mut stations, &target.1);
                        let current = hub_integer(target_hub, "inventory", &item_id);
                        set_hub_integer(target_hub, "inventory", &item_id, current + &moved)?;
                    }
                    *source_remaining.get_mut(&source.0).expect("source budget") -= &moved;
                    *target_remaining.get_mut(&target.0).expect("target budget") -= &moved;
                    let moved_number = moved
                        .min(BigUint::from(MAX_SAFE_INTEGER))
                        .to_u64()
                        .unwrap_or(MAX_SAFE_INTEGER);
                    let vessels = moved_number.div_ceil(CARGO_PER_VESSEL).max(1);
                    let busy = safe_count(network.get("fleetBusy"));
                    network.insert(
                        "fleetBusy".to_owned(),
                        Value::from(busy.saturating_add(vessels).min(MAX_SAFE_INTEGER)),
                    );
                    let warpers = integer(network.get("warpers"));
                    network.insert(
                        "warpers".to_owned(),
                        Value::from(decimal(positive_difference(
                            warpers,
                            BigUint::from(vessels.saturating_mul(2)),
                        ))),
                    );
                    merge_fleet_return(
                        base,
                        &mut network,
                        format!("{}->{}:{item_id}", source.1, target.1),
                        simulation_second,
                        &source.1,
                        &target.1,
                        vessels,
                    )?;
                    if source_remaining.get(&source.0).is_none_or(BigUint::is_zero) {
                        source_index += 1;
                    }
                    if target_remaining.get(&target.0).is_none_or(BigUint::is_zero) {
                        target_index += 1;
                    }
                }
            }
        }
    }

    base.insert("systemSpaceStations".to_owned(), Value::Object(stations));
    base.insert("galacticHubNetwork".to_owned(), Value::Object(network));
    Ok(())
}

pub(crate) fn boundary_seconds() -> f64 {
    SETTLEMENT_SECONDS
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::{CatalogSnapshot, RuntimeCatalog};
    use crate::deterministic_runtime::PARALLEL_MIN_ITEMS;
    use crate::state::CoreCheckpointIdentity;
    use serde_json::json;
    use sha2::{Digest, Sha256};
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn fixture_catalog() -> RuntimeCatalog {
        let snapshot = serde_json::from_value::<CatalogSnapshot>(json!({
            "protocolVersion": 1,
            "registryFingerprint": "system-space-test",
            "planets": [
                {
                    "id": "home",
                    "name": "Home",
                    "systemId": "helios",
                    "kind": "terrestrial",
                    "orbitIndex": 1,
                    "simulationOrder": 0,
                    "orbitalYields": {}
                },
                {
                    "id": "frontier",
                    "name": "Frontier",
                    "systemId": "alpha",
                    "kind": "terrestrial",
                    "orbitIndex": 1,
                    "simulationOrder": 1,
                    "orbitalYields": {}
                }
            ],
            "items": [{
                "id": "iron_ore",
                "name": "Iron Ore",
                "kind": "solid",
                "fuelEnergyMj": 0
            }],
            "buildings": [
                {
                    "id": "mining_machine",
                    "kind": "miner",
                    "speed": 1,
                    "inputCapacity": 0,
                    "outputCapacity": 50,
                    "powerDemandKw": 1
                },
                {
                    "id": "interstellar_logistics_station",
                    "kind": "station",
                    "speed": 1,
                    "inputCapacity": 64,
                    "outputCapacity": 64,
                    "powerDemandKw": 1
                },
                {
                    "id": "space_station_construction_launcher",
                    "kind": "station",
                    "speed": 1,
                    "inputCapacity": 64,
                    "outputCapacity": 64,
                    "powerDemandKw": 1
                }
            ],
            "recipes": [],
            "constructions": [],
            "belts": [{"tier": 1, "speed": 6}],
            "proliferators": [],
            "technologies": []
        }))
        .unwrap();
        RuntimeCatalog::validate(snapshot, "system-space-test").unwrap()
    }

    fn system_hub(system_id: &str, status: &str) -> Value {
        json!({
            "systemId": system_id,
            "status": status,
            "delivered": {},
            "constructionBuffer": {},
            "inventory": {"iron_ore": "128"},
            "itemPolicies": {},
            "modules": {"backbone": 0, "interstellar": 0},
            "routingCursors": {},
            "phaseIndex": 16,
            "costMultiplierBasisPoints": 10000,
            "decorations": []
        })
    }

    fn system_base(helios_status: &str, alpha_status: &str) -> Map<String, Value> {
        json!({
            "version": 47,
            "mode": "normal",
            "activePlanetId": "home",
            "elapsedSeconds": 0,
            "paused": false,
            "systemSpaceStations": {
                "helios": system_hub("helios", helios_status),
                "alpha": system_hub("alpha", alpha_status)
            },
            "galacticHubNetwork": {
                "fleetInstalled": 0,
                "fleetBusy": 0,
                "fleetReturns": [],
                "warpers": "0",
                "warperTarget": "0",
                "routingCursors": {}
            },
            "research": {"completedTechIds": []},
            "settings": {"logisticsBufferLimit": 1000000}
        })
        .as_object()
        .unwrap()
        .clone()
    }

    fn elevator(id: &str, kind: &str, planet_id: &str, input: u64) -> Value {
        json!({
            "id": id,
            "kind": kind,
            "planetId": planet_id,
            "buildingId": "interstellar_logistics_station",
            "machineCount": 1,
            "stationTier": 2,
            "stationOperationMode": "elevator",
            "stationModeTransition": null,
            "stationVessels": 2,
            "stationSlots": [],
            "stationRoutes": [],
            "elevatorOutputItems": ["iron_ore", null, null, null, null],
            "inputs": {"iron_ore": input},
            "outputs": {"iron_ore": 0},
            "powerFactor": 1,
            "progress": 0,
            "utilization": 0,
            "productionRate": 0,
            "routingCursor": 0
        })
    }

    fn launcher(id: &str, planet_id: &str) -> Value {
        json!({
            "id": id,
            "kind": "station",
            "planetId": planet_id,
            "buildingId": "space_station_construction_launcher",
            "inputs": {},
            "outputs": {},
            "progress": 0,
            "utilization": 0,
            "productionRate": 0,
            "routingCursor": 0
        })
    }

    fn fixture_entities() -> Vec<Value> {
        let mut entities = (0..24)
            .map(|index| {
                json!({
                    "id": format!("ordinary-{index}"),
                    "kind": "machine",
                    "planetId": if index % 2 == 0 { "home" } else { "frontier" },
                    "buildingId": "mining_machine",
                    "inputs": {},
                    "outputs": {},
                    "progress": 0,
                    "utilization": 0,
                    "productionRate": 0,
                    "routingCursor": 0
                })
            })
            .collect::<Vec<_>>();
        entities[2] = elevator("elevator-home", "station", "home", 17);
        entities[7] = elevator("mod-elevator-home", "mod-storage", "home", 11);
        entities[13] = launcher("launcher-alpha", "frontier");
        entities[19] = elevator("elevator-alpha", "station", "frontier", 23);
        entities
    }

    fn state_from_entities(entities: &[Value]) -> CoreState {
        CoreState::from_public_v47_parts(
            CoreCheckpointIdentity {
                slot: "normal-main".into(),
                generation: 1,
                root_hash: "a".repeat(64),
                revision: 7,
                state_version: 47,
                mode: "normal".into(),
                registry_fingerprint: "system-space-test".into(),
                base_primary_checksum: "12345678".into(),
            },
            system_base("operational", "operational"),
            entities
                .iter()
                .map(|entity| serde_json::to_string(entity).unwrap())
                .collect(),
            Vec::new(),
            fixture_catalog(),
        )
        .unwrap()
    }

    fn built_route_ledger(
        state: &CoreState,
        entities: &[Value],
    ) -> crate::station_route_ledger::StationRouteLedger {
        let local = crate::local_logistics::prepare_step_directory(
            entities,
            &state.factory_topology.station_indices,
        )
        .unwrap();
        let remote = crate::interstellar_logistics::prepare_route_activity(entities);
        crate::station_route_ledger::StationRouteLedger::build(state, entities, &local, &remote)
    }

    fn frozen_settle_mode_transitions(entities: &mut [Value]) -> anyhow::Result<bool> {
        let transitions = entities
            .iter()
            .enumerate()
            .filter_map(|(index, entity)| {
                let entity = entity.as_object()?;
                let transition = string_at(entity, "stationModeTransition")?;
                let id = string_at(entity, "id")?.to_owned();
                Some((index, id, transition.to_owned()))
            })
            .collect::<Vec<_>>();
        let mut changed = false;
        for (index, station_id, transition) in transitions {
            if route_references_station(entities, &station_id) {
                continue;
            }
            let station = entities[index]
                .as_object_mut()
                .ok_or_else(|| anyhow!("native transitioning station is invalid"))?;
            station.insert(
                "stationOperationMode".to_owned(),
                Value::from(if transition == "to-elevator" {
                    "elevator"
                } else {
                    "legacy"
                }),
            );
            station.insert("stationModeTransition".to_owned(), Value::Null);
            changed = true;
        }
        Ok(changed)
    }

    fn transition_row(
        index: usize,
        kind: &str,
        building_id: &str,
        transition: Option<&str>,
    ) -> Value {
        let mut row = json!({
            "id": format!("transition-{index:05}"),
            "kind": kind,
            "planetId": "home",
            "buildingId": building_id,
            "machineCount": 1,
            "stationTier": 1,
            "stationOperationMode": "legacy",
            "stationModeTransition": transition,
            "stationSlots": [],
            "stationRoutes": [],
            "inputs": {},
            "outputs": {},
            "progress": 0,
            "utilization": 0,
            "productionRate": 0,
            "routingCursor": 0
        });
        if kind == "station" && building_id == "interstellar_logistics_station" {
            row["stationSlots"] = json!([
                {"itemId": null, "localMode": "storage", "remoteMode": "storage", "minimumLoad": 1, "minStock": 0, "maxStock": 0, "priority": 1},
                {"itemId": null, "localMode": "storage", "remoteMode": "storage", "minimumLoad": 1, "minStock": 0, "maxStock": 0, "priority": 1},
                {"itemId": null, "localMode": "storage", "remoteMode": "storage", "minimumLoad": 1, "minStock": 0, "maxStock": 0, "priority": 1},
                {"itemId": null, "localMode": "storage", "remoteMode": "storage", "minimumLoad": 1, "minStock": 0, "maxStock": 0, "priority": 1},
                {"itemId": null, "localMode": "storage", "remoteMode": "storage", "minimumLoad": 1, "minStock": 0, "maxStock": 0, "priority": 1}
            ]);
        }
        row
    }

    fn mode_transition_digest(entities: &[Value]) -> (Vec<u8>, String) {
        let bytes = serde_json::to_vec(entities).unwrap();
        let hash = format!("{:x}", Sha256::digest(&bytes));
        (bytes, hash)
    }

    fn frozen_active_power_consumers(
        state: &CoreState,
        base: &Map<String, Value>,
        entities: &[Value],
    ) -> Vec<usize> {
        entities
            .iter()
            .enumerate()
            .filter_map(|(index, entity)| {
                let entity = entity.as_object()?;
                let system_id = entity_system_id(state, entity)?;
                let active = string_at(entity, "buildingId")
                    == Some("space_station_construction_launcher")
                    && system_status(base, system_id) == Some("building")
                    || is_elevator(entity) && system_status(base, system_id) == Some("operational");
                active.then_some(index)
            })
            .collect()
    }

    fn frozen_station_groups<F>(entities: &[Value], classify: F) -> Vec<(u8, Vec<usize>)>
    where
        F: Fn(usize, &Value) -> Option<u8>,
    {
        let mut groups = Vec::<(u8, Vec<usize>)>::new();
        for (entity_index, entity) in entities.iter().enumerate() {
            let Some(group) = classify(entity_index, entity) else {
                continue;
            };
            if let Some((_, indexes)) = groups.iter_mut().find(|(candidate, _)| *candidate == group)
            {
                indexes.push(entity_index);
            } else {
                groups.push((group, vec![entity_index]));
            }
        }
        groups
    }

    fn force_full_scan(state: &mut CoreState) {
        let topology = Arc::make_mut(&mut state.factory_topology);
        topology.system_space_station_entity_indices.clear();
        topology.system_space_station_full_scan_required = true;
    }

    #[test]
    fn stable_candidate_index_preserves_mod_rows_and_rebuilds_in_persisted_order() {
        let entities = fixture_entities();
        let mut state = state_from_entities(&entities);
        assert_eq!(
            state.factory_topology.system_space_station_entity_indices,
            vec![2, 7, 13, 19]
        );
        assert!(
            !state
                .factory_topology
                .system_space_station_full_scan_required
        );

        state.replace_entity_raw(
            2,
            Arc::<str>::from(
                serde_json::to_string(&json!({
                    "id": "replacement-ordinary",
                    "kind": "machine",
                    "planetId": "home",
                    "buildingId": "mining_machine",
                    "inputs": {},
                    "outputs": {}
                }))
                .unwrap(),
            ),
        );
        state.replace_entity_raw(
            5,
            Arc::<str>::from(
                serde_json::to_string(&elevator("replacement-mod-elevator", "mod-row", "home", 3))
                    .unwrap(),
            ),
        );
        state.rebuild_indexes().unwrap();
        assert_eq!(
            state.factory_topology.system_space_station_entity_indices,
            vec![5, 7, 13, 19]
        );
        assert!(
            !state
                .factory_topology
                .system_space_station_full_scan_required
        );
    }

    #[test]
    fn dense_candidate_topology_uses_deterministic_full_scan_fallback() {
        let entities = vec![
            elevator("elevator-0", "station", "home", 1),
            elevator("elevator-1", "mod-row", "home", 1),
            launcher("launcher-2", "frontier"),
            elevator("elevator-3", "station", "frontier", 1),
            json!({
                "id": "ordinary-4",
                "kind": "machine",
                "planetId": "home",
                "buildingId": "mining_machine",
                "inputs": {},
                "outputs": {}
            }),
        ];
        let state = state_from_entities(&entities);
        assert!(
            state
                .factory_topology
                .system_space_station_full_scan_required
        );
        assert!(
            state
                .factory_topology
                .system_space_station_entity_indices
                .is_empty()
        );

        let base = system_base("operational", "building");
        assert_eq!(
            active_power_consumers(&state, &base, &entities),
            frozen_active_power_consumers(&state, &base, &entities)
        );
    }

    #[test]
    fn indexed_power_discovery_matches_frozen_full_scan_including_mod_elevator() {
        let entities = fixture_entities();
        let state = state_from_entities(&entities);
        let base = system_base("operational", "building");
        let expected = frozen_active_power_consumers(&state, &base, &entities);
        assert_eq!(expected, vec![2, 7, 13]);
        assert_eq!(active_power_consumers(&state, &base, &entities), expected);
    }

    #[test]
    fn indexed_hub_settlement_is_bitwise_equal_to_full_scan_oracle() {
        let initial_entities = fixture_entities();
        let indexed_state = state_from_entities(&initial_entities);
        let mut oracle_state = indexed_state.clone();
        force_full_scan(&mut oracle_state);
        let mut indexed_base = system_base("operational", "operational");
        let mut oracle_base = indexed_base.clone();
        let mut indexed_entities = initial_entities.clone();
        let mut oracle_entities = initial_entities;

        settle_hubs(
            &indexed_state,
            &mut indexed_base,
            &mut indexed_entities,
            5.0,
        )
        .unwrap();
        settle_hubs(&oracle_state, &mut oracle_base, &mut oracle_entities, 5.0).unwrap();

        assert_eq!(
            serde_json::to_vec(&(indexed_base, indexed_entities)).unwrap(),
            serde_json::to_vec(&(oracle_base, oracle_entities)).unwrap()
        );
    }

    #[test]
    fn indexed_and_full_scan_hub_boundary_replays_match_across_split_loops() {
        let state = state_from_entities(&fixture_entities());
        let mut continuous_base = system_base("operational", "operational");
        let mut continuous_entities = fixture_entities();
        for boundary in 1..=12 {
            settle_hubs(
                &state,
                &mut continuous_base,
                &mut continuous_entities,
                boundary as f64 * boundary_seconds(),
            )
            .unwrap();
        }

        let mut segmented_state = state.clone();
        force_full_scan(&mut segmented_state);
        let mut segmented_base = system_base("operational", "operational");
        let mut segmented_entities = fixture_entities();
        for boundaries in [1..=5, 6..=12] {
            for boundary in boundaries {
                settle_hubs(
                    &segmented_state,
                    &mut segmented_base,
                    &mut segmented_entities,
                    boundary as f64 * boundary_seconds(),
                )
                .unwrap();
            }
        }

        assert_eq!(
            serde_json::to_vec(&(continuous_base, continuous_entities)).unwrap(),
            serde_json::to_vec(&(segmented_base, segmented_entities)).unwrap()
        );
    }

    #[test]
    fn sparse_index_matches_full_scan_oracle_and_probes_only_candidates() {
        let mut entities = (0..(PARALLEL_MIN_ITEMS * 2 + 17))
            .map(|index| {
                json!({
                    "id": format!("ordinary-{index}"),
                    "buildingId": "mining_machine",
                    "system": "unused",
                    "enabled": true,
                    "elevator": false
                })
            })
            .collect::<Vec<_>>();
        for (index, kind, system, enabled) in [
            (3, "mod-row", "beta", true),
            (97, "station", "alpha", false),
            (PARALLEL_MIN_ITEMS + 3, "station", "gamma", true),
        ] {
            entities[index] = json!({
                "id": format!("candidate-{index}"),
                "kind": kind,
                "buildingId": "interstellar_logistics_station",
                "system": system,
                "enabled": enabled,
                "elevator": true
            });
        }
        let launcher_index = entities.len() - 1;
        entities[launcher_index] = json!({
            "id": "launcher",
            "kind": "station",
            "buildingId": "space_station_construction_launcher",
            "system": "alpha",
            "enabled": true,
            "elevator": false
        });
        let candidate_indices = entities
            .iter()
            .enumerate()
            .filter_map(|(index, entity)| {
                matches!(
                    entity.get("buildingId").and_then(Value::as_str),
                    Some("interstellar_logistics_station" | "space_station_construction_launcher")
                )
                .then_some(index)
            })
            .collect::<Vec<_>>();
        let classify = |_: usize, entity: &Value| {
            let entity = entity.as_object()?;
            if entity.get("enabled").and_then(Value::as_bool) != Some(true)
                || entity.get("elevator").and_then(Value::as_bool) != Some(true)
            {
                return None;
            }
            match entity.get("system").and_then(Value::as_str) {
                Some("gamma") => Some(0_u8),
                Some("alpha") => Some(1_u8),
                Some("beta") => Some(2_u8),
                _ => None,
            }
        };
        let expected = frozen_station_groups(&entities, classify);
        let probes = AtomicUsize::new(0);
        let actual = collect_station_groups_with_runtime(
            &DeterministicRuntime::for_test(8),
            &entities,
            Some(&candidate_indices),
            |index, entity| {
                probes.fetch_add(1, Ordering::Relaxed);
                classify(index, entity)
            },
        );
        assert_eq!(actual, expected);
        assert_eq!(probes.load(Ordering::Relaxed), candidate_indices.len());
        assert!(candidate_indices.len() * 1_000 < entities.len());
    }

    #[test]
    fn elevator_admission_probe_is_identical_at_every_worker_limit() {
        let entities = (0..(PARALLEL_MIN_ITEMS * 2 + 17))
            .map(|index| {
                if index % 2 == 0 {
                    json!({
                    "id": format!("elevator-{index}"),
                    "buildingId": "interstellar_logistics_station",
                    "system": if index % 3 == 0 { "gamma" } else if index % 3 == 1 { "alpha" } else { "beta" },
                    "enabled": index % 5 != 0,
                    "elevator": true,
                    })
                } else {
                    json!({
                        "id": format!("ordinary-{index}"),
                        "buildingId": "mining_machine",
                        "system": "unused",
                        "enabled": true,
                        "elevator": false
                    })
                }
            })
            .collect::<Vec<_>>();
        let classify = |_: usize, entity: &Value| {
            let entity = entity.as_object()?;
            if entity.get("enabled").and_then(Value::as_bool) != Some(true)
                || entity.get("elevator").and_then(Value::as_bool) != Some(true)
            {
                return None;
            }
            match entity.get("system").and_then(Value::as_str) {
                Some("gamma") => Some(0_u8),
                Some("alpha") => Some(1_u8),
                Some("beta") => Some(2_u8),
                _ => None,
            }
        };
        let candidate_indices = entities
            .iter()
            .enumerate()
            .filter_map(|(index, entity)| {
                (entity.get("buildingId").and_then(Value::as_str)
                    == Some("interstellar_logistics_station"))
                .then_some(index)
            })
            .collect::<Vec<_>>();
        assert!(candidate_indices.len() >= PARALLEL_MIN_ITEMS);
        assert!(candidate_indices.len() * 4 < entities.len() * 3);
        let expected = frozen_station_groups(&entities, classify);
        assert_eq!(expected.first().map(|entry| entry.0), Some(2));
        for workers in [1, 2, 4, 8] {
            let runtime = DeterministicRuntime::for_test(workers);
            assert_eq!(
                runtime.worker_count_for_items(candidate_indices.len()),
                workers
            );
            assert_eq!(
                collect_station_groups_with_runtime(
                    &runtime,
                    &entities,
                    Some(&candidate_indices),
                    classify,
                ),
                expected,
                "elevator probe/group order diverged at {workers} workers",
            );
        }
    }

    #[test]
    fn dense_full_scan_fallback_is_identical_at_every_worker_limit() {
        let entity_count = PARALLEL_MIN_ITEMS * 2 + 17;
        let candidate_count = entity_count.saturating_mul(3).div_ceil(4);
        let entities = (0..entity_count)
            .map(|index| {
                if index < candidate_count {
                    json!({
                        "id": format!("elevator-{index}"),
                        "buildingId": "interstellar_logistics_station",
                        "system": if index % 3 == 0 { "gamma" } else if index % 3 == 1 { "alpha" } else { "beta" },
                        "enabled": index % 5 != 0,
                        "elevator": true
                    })
                } else {
                    json!({
                        "id": format!("ordinary-{index}"),
                        "buildingId": "mining_machine",
                        "system": "unused",
                        "enabled": true,
                        "elevator": false
                    })
                }
            })
            .collect::<Vec<_>>();
        assert!(candidate_count >= PARALLEL_MIN_ITEMS);
        assert!(candidate_count * 4 >= entities.len() * 3);
        let classify = |_: usize, entity: &Value| {
            let entity = entity.as_object()?;
            if entity.get("enabled").and_then(Value::as_bool) != Some(true)
                || entity.get("elevator").and_then(Value::as_bool) != Some(true)
            {
                return None;
            }
            match entity.get("system").and_then(Value::as_str) {
                Some("gamma") => Some(0_u8),
                Some("alpha") => Some(1_u8),
                Some("beta") => Some(2_u8),
                _ => None,
            }
        };
        let expected = frozen_station_groups(&entities, classify);
        for workers in [1, 2, 4, 8] {
            let runtime = DeterministicRuntime::for_test(workers);
            assert_eq!(runtime.worker_count_for_items(entities.len()), workers);
            assert_eq!(
                collect_station_groups_with_runtime(&runtime, &entities, None, classify),
                expected,
                "dense full-scan grouping diverged at {workers} workers",
            );
        }
    }

    #[test]
    fn no_mode_transition_probes_zero_rows_and_preserves_bytes() {
        let mut entities = fixture_entities();
        let state = state_from_entities(&entities);
        let ledger = built_route_ledger(&state, &entities);
        let before = serde_json::to_vec(&entities).unwrap();
        let (changed, scan) = settle_mode_transitions_with_runtime(
            &DeterministicRuntime::for_test(8),
            &state,
            &mut entities,
            &ledger,
        )
        .unwrap();
        assert!(!changed);
        assert_eq!(scan.selected_rows, 0);
        assert_eq!(scan.total_rows, entities.len());
        assert_eq!(scan.transition_rows, 0);
        assert_eq!(scan.route_reference_probes, 0);
        assert!(!scan.dense_fallback);
        assert!(!scan.index_fallback);
        assert!(!scan.ledger_fallback);
        assert_eq!(serde_json::to_vec(&entities).unwrap(), before);
    }

    #[test]
    fn sparse_transition_index_probes_only_active_rows_and_preserves_mod_semantics() {
        let mut entities = (0..4_113)
            .map(|index| transition_row(index, "machine", "mining_machine", None))
            .collect::<Vec<_>>();
        entities[3] = transition_row(
            3,
            "station",
            "interstellar_logistics_station",
            Some("to-elevator"),
        );
        entities[4_097] = transition_row(
            4_097,
            "mod-row",
            "mod:orbital-lift/Ω",
            Some("custom-to-legacy"),
        );
        let state = state_from_entities(&entities);
        assert_eq!(
            state.factory_topology.station_mode_transition_indices,
            vec![3, 4_097]
        );
        assert!(
            !state
                .factory_topology
                .station_mode_transition_full_scan_required
        );
        let ledger = built_route_ledger(&state, &entities);
        let mut oracle = entities.clone();
        let oracle_changed = frozen_settle_mode_transitions(&mut oracle).unwrap();
        let (changed, scan) = settle_mode_transitions_with_runtime(
            &DeterministicRuntime::for_test(8),
            &state,
            &mut entities,
            &ledger,
        )
        .unwrap();
        assert_eq!(changed, oracle_changed);
        assert_eq!(
            mode_transition_digest(&entities),
            mode_transition_digest(&oracle)
        );
        assert_eq!(scan.selected_rows, 2);
        assert_eq!(scan.total_rows, 4_113);
        assert_eq!(scan.transition_rows, 2);
        assert_eq!(scan.route_reference_probes, 2);
        assert!(!scan.dense_fallback);
        assert!(!scan.index_fallback);
        assert!(!scan.ledger_fallback);
        assert_eq!(entities[3]["stationOperationMode"], "elevator");
        assert_eq!(entities[4_097]["stationOperationMode"], "legacy");
    }

    #[test]
    fn dense_and_invalid_transition_indexes_fall_back_to_frozen_full_oracle() {
        let dense_source = (0..64)
            .map(|index| {
                transition_row(
                    index,
                    "mod-row",
                    "mod:dense-transition",
                    (index < 48).then_some("to-elevator"),
                )
            })
            .collect::<Vec<_>>();
        let dense_state = state_from_entities(&dense_source);
        assert!(
            dense_state
                .factory_topology
                .station_mode_transition_full_scan_required
        );
        assert!(
            dense_state
                .factory_topology
                .station_mode_transition_indices
                .is_empty()
        );
        let dense_ledger = built_route_ledger(&dense_state, &dense_source);
        let mut dense_actual = dense_source.clone();
        let mut dense_oracle = dense_source;
        frozen_settle_mode_transitions(&mut dense_oracle).unwrap();
        let (_, dense_scan) = settle_mode_transitions_with_runtime(
            &DeterministicRuntime::for_test(8),
            &dense_state,
            &mut dense_actual,
            &dense_ledger,
        )
        .unwrap();
        assert_eq!(
            mode_transition_digest(&dense_actual),
            mode_transition_digest(&dense_oracle)
        );
        assert_eq!(dense_scan.selected_rows, 64);
        assert!(dense_scan.dense_fallback);
        assert!(!dense_scan.index_fallback);

        let mut sparse_source = (0..64)
            .map(|index| {
                transition_row(
                    index,
                    "mod-row",
                    "mod:sparse-transition",
                    (index == 7).then_some("to-elevator"),
                )
            })
            .collect::<Vec<_>>();
        sparse_source[0]
            .as_object_mut()
            .unwrap()
            .remove("stationModeTransition");
        let mut invalid_state = state_from_entities(&sparse_source);
        let invalid_topology = Arc::make_mut(&mut invalid_state.factory_topology);
        invalid_topology.station_mode_transition_indices = vec![0];
        invalid_topology.station_mode_transition_full_scan_required = false;
        let invalid_ledger = built_route_ledger(&invalid_state, &sparse_source);
        let mut invalid_actual = sparse_source.clone();
        let mut invalid_oracle = sparse_source;
        frozen_settle_mode_transitions(&mut invalid_oracle).unwrap();
        let (_, invalid_scan) = settle_mode_transitions_with_runtime(
            &DeterministicRuntime::for_test(8),
            &invalid_state,
            &mut invalid_actual,
            &invalid_ledger,
        )
        .unwrap();
        assert_eq!(
            mode_transition_digest(&invalid_actual),
            mode_transition_digest(&invalid_oracle)
        );
        assert_eq!(invalid_scan.selected_rows, 64);
        assert!(!invalid_scan.dense_fallback);
        assert!(invalid_scan.index_fallback);
    }

    #[test]
    fn route_peer_and_waypoint_membership_block_transition_until_post_route_ledger_clears() {
        let mut peer_entities = vec![
            transition_row(
                0,
                "station",
                "interstellar_logistics_station",
                Some("to-elevator"),
            ),
            transition_row(1, "station", "interstellar_logistics_station", None),
        ];
        peer_entities[1]["stationRoutes"] = json!([{
            "id": "peer-route",
            "scope": "remote",
            "peerId": "transition-00000",
            "vehicleStationId": "transition-00001",
            "waypointStationIds": [],
            "itemId": "iron_ore",
            "cargo": 1,
            "vehicleCount": 1,
            "progress": 0
        }]);
        let peer_state = state_from_entities(&peer_entities);
        let peer_ledger = built_route_ledger(&peer_state, &peer_entities);
        assert!(peer_ledger.references_station(0));
        let before = mode_transition_digest(&peer_entities);
        let (changed, scan) = settle_mode_transitions_with_runtime(
            &DeterministicRuntime::for_test(8),
            &peer_state,
            &mut peer_entities,
            &peer_ledger,
        )
        .unwrap();
        assert!(!changed);
        assert_eq!(scan.route_reference_probes, 1);
        assert_eq!(mode_transition_digest(&peer_entities), before);

        let mut waypoint_entities = vec![
            transition_row(
                0,
                "station",
                "interstellar_logistics_station",
                Some("to-elevator"),
            ),
            transition_row(1, "station", "interstellar_logistics_station", None),
            transition_row(2, "station", "interstellar_logistics_station", None),
        ];
        waypoint_entities[1]["stationRoutes"] = json!([{
            "id": "waypoint-route",
            "scope": "remote",
            "peerId": "transition-00002",
            "vehicleStationId": "transition-00001",
            "waypointStationIds": ["transition-00000"],
            "itemId": "iron_ore",
            "cargo": 1,
            "vehicleCount": 1,
            "progress": 0
        }]);
        let waypoint_state = state_from_entities(&waypoint_entities);
        let waypoint_ledger = built_route_ledger(&waypoint_state, &waypoint_entities);
        assert!(waypoint_ledger.references_station(0));
        assert!(
            !settle_mode_transitions(&waypoint_state, &mut waypoint_entities, &waypoint_ledger,)
                .unwrap()
        );
        waypoint_entities[1]["stationRoutes"] = Value::Array(Vec::new());
        let cleared_state = state_from_entities(&waypoint_entities);
        let cleared_ledger = built_route_ledger(&cleared_state, &waypoint_entities);
        assert!(!cleared_ledger.references_station(0));
        assert!(
            settle_mode_transitions(&cleared_state, &mut waypoint_entities, &cleared_ledger,)
                .unwrap()
        );
        assert!(waypoint_entities[0]["stationModeTransition"].is_null());
    }

    fn run_mode_transition_boundaries(segmented: bool) -> Vec<Value> {
        let mut entities = vec![
            transition_row(
                0,
                "station",
                "interstellar_logistics_station",
                Some("to-elevator"),
            ),
            transition_row(1, "station", "interstellar_logistics_station", None),
        ];
        entities[1]["stationRoutes"] = json!([{
            "id": "draining-route",
            "scope": "remote",
            "peerId": "transition-00000",
            "vehicleStationId": "transition-00001",
            "waypointStationIds": [],
            "itemId": "iron_ore",
            "cargo": 1,
            "vehicleCount": 1,
            "progress": 0
        }]);
        let ranges = if segmented {
            vec![1_u64..=5, 6_u64..=12]
        } else {
            vec![1_u64..=12]
        };
        let mut state = state_from_entities(&entities);
        for (segment_index, range) in ranges.into_iter().enumerate() {
            if segment_index != 0 {
                state = state_from_entities(&entities);
            }
            for boundary in range {
                if boundary == 6 {
                    entities[1]["stationRoutes"] = Value::Array(Vec::new());
                }
                let ledger = built_route_ledger(&state, &entities);
                settle_mode_transitions(&state, &mut entities, &ledger).unwrap();
            }
        }
        entities
    }

    #[test]
    fn continuous_and_segmented_five_second_boundaries_are_byte_identical() {
        let continuous = run_mode_transition_boundaries(false);
        let segmented = run_mode_transition_boundaries(true);
        assert_eq!(
            mode_transition_digest(&continuous),
            mode_transition_digest(&segmented)
        );
        assert_eq!(continuous[0]["stationOperationMode"], "elevator");
        assert!(continuous[0]["stationModeTransition"].is_null());
    }

    #[test]
    fn sparse_transition_parallel_matrix_is_frozen_json_and_hash_identical() {
        let transition_count = PARALLEL_MIN_ITEMS + 3;
        let entity_count = transition_count * 2 + 17;
        let source = (0..entity_count)
            .map(|index| {
                json!({
                    "id": format!("parallel-transition-{index:05}"),
                    "kind": "mod-row",
                    "buildingId": "mod:parallel-transition",
                    "stationOperationMode": "legacy",
                    "stationModeTransition": (index < transition_count).then_some(if index % 2 == 0 {
                        "to-elevator"
                    } else {
                        "custom-to-legacy"
                    })
                })
            })
            .collect::<Vec<_>>();
        let state = state_from_entities(&source);
        let ledger = built_route_ledger(&state, &source);
        let mut oracle = source.clone();
        assert!(frozen_settle_mode_transitions(&mut oracle).unwrap());
        let expected = mode_transition_digest(&oracle);
        for workers in [1, 2, 4, 8] {
            let runtime = DeterministicRuntime::for_test(workers);
            assert_eq!(runtime.worker_count_for_items(transition_count), workers);
            let mut candidate = source.clone();
            let (changed, scan) =
                settle_mode_transitions_with_runtime(&runtime, &state, &mut candidate, &ledger)
                    .unwrap();
            assert!(changed);
            assert_eq!(scan.selected_rows, transition_count);
            assert_eq!(scan.transition_rows, transition_count);
            assert_eq!(scan.route_reference_probes, transition_count);
            let digest = mode_transition_digest(&candidate);
            assert_eq!(
                digest, expected,
                "mode transition diverged from frozen oracle at {workers} workers"
            );
        }
    }

    #[test]
    fn failing_route_probe_leaves_candidate_json_unchanged() {
        let source = vec![
            transition_row(
                0,
                "station",
                "interstellar_logistics_station",
                Some("to-elevator"),
            ),
            transition_row(1, "mod-row", "mod:transition", Some("custom-to-legacy")),
        ];
        let state = state_from_entities(&source);
        let (candidates, scan) =
            collect_mode_transition_candidates(&DeterministicRuntime::for_test(8), &state, &source);
        assert_eq!(scan.transition_rows, 2);
        let mut candidate = source.clone();
        let before = mode_transition_digest(&candidate);
        let error = settle_mode_transition_candidates(
            &DeterministicRuntime::for_test(8),
            &mut candidate,
            &candidates,
            |entity_index, _| {
                if entity_index == 1 {
                    Err(anyhow!("injected route probe failure"))
                } else {
                    Ok(false)
                }
            },
        )
        .unwrap_err();
        assert_eq!(error.to_string(), "injected route probe failure");
        assert_eq!(mode_transition_digest(&candidate), before);
    }

    #[test]
    fn mode_transition_reports_only_an_actual_topology_change() {
        let mut entities = vec![transition_row(
            0,
            "station",
            "interstellar_logistics_station",
            None,
        )];
        let before = serde_json::to_vec(&entities).unwrap();
        let state = state_from_entities(&entities);
        let ledger = built_route_ledger(&state, &entities);
        assert!(!settle_mode_transitions(&state, &mut entities, &ledger).unwrap());
        assert_eq!(serde_json::to_vec(&entities).unwrap(), before);

        entities[0]["stationModeTransition"] = Value::from("to-elevator");
        let state = state_from_entities(&entities);
        let ledger = built_route_ledger(&state, &entities);
        assert!(settle_mode_transitions(&state, &mut entities, &ledger).unwrap());
        assert_eq!(entities[0]["stationOperationMode"], Value::from("elevator"));
        assert!(entities[0]["stationModeTransition"].is_null());
        let state = state_from_entities(&entities);
        let ledger = built_route_ledger(&state, &entities);
        assert!(!settle_mode_transitions(&state, &mut entities, &ledger).unwrap());
    }
}
