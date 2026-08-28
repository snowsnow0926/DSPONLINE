use std::collections::{BTreeSet, HashMap};

use anyhow::anyhow;
use num_bigint::BigUint;
use num_traits::{ToPrimitive, Zero};
use serde_json::{Map, Value, json};

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

pub(crate) fn settle_mode_transitions(entities: &mut [Value]) -> anyhow::Result<bool> {
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

    let mut stations_by_system = Vec::<(String, Vec<usize>)>::new();
    for (entity_index, entity) in entities.iter().enumerate() {
        let Some(entity) = entity.as_object() else {
            continue;
        };
        let Some(system_id) = entity_system_id(state, entity) else {
            continue;
        };
        if !is_elevator(entity)
            || stations
                .get(system_id)
                .and_then(Value::as_object)
                .and_then(|hub| string_at(hub, "status"))
                != Some("operational")
        {
            continue;
        }
        if let Some((_, indexes)) = stations_by_system
            .iter_mut()
            .find(|(candidate, _)| candidate == system_id)
        {
            indexes.push(entity_index);
        } else {
            stations_by_system.push((system_id.to_owned(), vec![entity_index]));
        }
    }

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
    use serde_json::json;

    #[test]
    fn mode_transition_reports_only_an_actual_topology_change() {
        let mut entities = vec![json!({
            "id": "station-a",
            "kind": "station",
            "stationOperationMode": "legacy",
            "stationModeTransition": null
        })];
        let before = serde_json::to_vec(&entities).unwrap();
        assert!(!settle_mode_transitions(&mut entities).unwrap());
        assert_eq!(serde_json::to_vec(&entities).unwrap(), before);

        entities[0]["stationModeTransition"] = Value::from("to-elevator");
        assert!(settle_mode_transitions(&mut entities).unwrap());
        assert_eq!(entities[0]["stationOperationMode"], Value::from("elevator"));
        assert!(entities[0]["stationModeTransition"].is_null());
        assert!(!settle_mode_transitions(&mut entities).unwrap());
    }

    #[test]
    fn referenced_mode_transition_stays_pending_and_reports_no_change() {
        let mut entities = vec![
            json!({
                "id": "station-a",
                "kind": "station",
                "stationOperationMode": "legacy",
                "stationModeTransition": "to-elevator"
            }),
            json!({
                "id": "station-b",
                "kind": "station",
                "stationRoutes": [{ "peerId": "station-a" }]
            }),
        ];
        assert!(!settle_mode_transitions(&mut entities).unwrap());
        assert_eq!(
            entities[0]["stationModeTransition"],
            Value::from("to-elevator")
        );

        entities[1]["stationRoutes"] = Value::Array(Vec::new());
        assert!(settle_mode_transitions(&mut entities).unwrap());
        assert!(entities[0]["stationModeTransition"].is_null());
    }
}
