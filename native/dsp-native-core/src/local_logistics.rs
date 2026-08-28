use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};

use anyhow::{anyhow, bail};
use serde_json::{Map, Number, Value, json};

use crate::deterministic_runtime::{DeterministicRuntime, runtime as deterministic_runtime};
use crate::state::{CoreState, ExactRowIdIndex};

const EPSILON: f64 = 0.0001;
const SLOT_COUNT: usize = 5;
const DRONES_PER_BUILDING: f64 = 50.0;
const CARGO_PER_DRONE: f64 = 25.0;
const BASE_TRIP_SECONDS: f64 = 8.0;

#[derive(Debug, Clone)]
struct Slot {
    item_id: Option<String>,
    local_mode: LocalMode,
    minimum_load: f64,
    min_stock: f64,
    max_stock: f64,
    priority: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LocalMode {
    Supply,
    Demand,
    Storage,
}

impl LocalMode {
    fn parse(value: &str) -> anyhow::Result<Self> {
        match value {
            "supply" => Ok(Self::Supply),
            "demand" => Ok(Self::Demand),
            "storage" => Ok(Self::Storage),
            _ => bail!("native local station mode is invalid"),
        }
    }
}

#[derive(Debug, Default)]
struct Ledger {
    busy: HashMap<usize, f64>,
    reserved: HashMap<usize, HashMap<String, f64>>,
    in_flight: HashMap<usize, HashMap<String, f64>>,
    active_vehicle_load: HashMap<usize, f64>,
    active_local_stations: HashSet<usize>,
    active_local_progress: HashMap<usize, f64>,
}

fn ledger_item_amount(
    values: &HashMap<usize, HashMap<String, f64>>,
    station_index: usize,
    item_id: &str,
) -> f64 {
    values
        .get(&station_index)
        .and_then(|items| items.get(item_id))
        .copied()
        .unwrap_or(0.0)
}

fn add_ledger_item_amount(
    values: &mut HashMap<usize, HashMap<String, f64>>,
    station_index: usize,
    item_id: &str,
    amount: f64,
) {
    let items = values.entry(station_index).or_default();
    if let Some(current) = items.get_mut(item_id) {
        *current += amount;
    } else {
        items.insert(item_id.to_owned(), amount);
    }
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

fn rounded(value: f64, digits: i32) -> f64 {
    let scale = 10_f64.powi(digits);
    (value * scale).round() / scale
}

fn set_number(object: &mut Map<String, Value>, key: &str, value: f64) -> anyhow::Result<()> {
    let value = Number::from_f64(value)
        .map(Value::Number)
        .ok_or_else(|| anyhow!("native local logistics produced a non-finite number"))?;
    if let Some(target) = object.get_mut(key) {
        *target = value;
    } else {
        object.insert(key.to_owned(), value);
    }
    Ok(())
}

fn item_amount(entity: &Map<String, Value>, record: &str, item_id: &str) -> f64 {
    entity
        .get(record)
        .and_then(Value::as_object)
        .and_then(|values| values.get(item_id))
        .map(|value| finite_number(Some(value)))
        .unwrap_or(0.0)
}

fn set_item_amount(
    entity: &mut Map<String, Value>,
    record: &str,
    item_id: &str,
    amount: f64,
) -> anyhow::Result<()> {
    let inventory = entity
        .get_mut(record)
        .and_then(Value::as_object_mut)
        .ok_or_else(|| anyhow!("native local logistics inventory is missing"))?;
    let amount = Number::from_f64(amount)
        .map(Value::Number)
        .ok_or_else(|| anyhow!("native local logistics inventory is non-finite"))?;
    if let Some(current) = inventory.get_mut(item_id) {
        *current = amount;
    } else {
        inventory.insert(item_id.to_owned(), amount);
    }
    Ok(())
}

fn normalized_buffer_limit(base: &Map<String, Value>) -> f64 {
    base.get("settings")
        .and_then(Value::as_object)
        .and_then(|settings| settings.get("logisticsBufferLimit"))
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
        .unwrap_or(1_000_000.0)
        .floor()
        .clamp(1_000.0, 100_000_000.0)
}

fn stacked_capacity(base: f64, count: f64, limit: f64) -> f64 {
    let base = base.max(0.0).floor();
    let count = count.floor().max(1.0);
    if base == 0.0 {
        0.0
    } else if base > limit / count {
        limit
    } else {
        (base * count).min(limit)
    }
}

fn slots(entity: &Map<String, Value>) -> anyhow::Result<Vec<Slot>> {
    let values = entity
        .get("stationSlots")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("native local station slots are missing"))?;
    if values.len() != SLOT_COUNT {
        bail!("native local station slot count is invalid");
    }
    values
        .iter()
        .map(|value| {
            let slot = value
                .as_object()
                .ok_or_else(|| anyhow!("native local station slot is invalid"))?;
            let local_mode = LocalMode::parse(string_at(slot, "localMode").unwrap_or("storage"))?;
            let minimum_load = finite_number(slot.get("minimumLoad"));
            if ![0.1, 0.25, 0.5, 1.0]
                .iter()
                .any(|value| (minimum_load - value).abs() <= f64::EPSILON)
            {
                bail!("native local station minimum load is invalid");
            }
            Ok(Slot {
                item_id: string_at(slot, "itemId").map(str::to_owned),
                local_mode,
                minimum_load,
                min_stock: finite_number(slot.get("minStock")).floor().max(0.0),
                max_stock: finite_number(slot.get("maxStock")).floor().max(0.0),
                priority: slot
                    .get("priority")
                    .and_then(Value::as_u64)
                    .unwrap_or(1)
                    .min(2) as usize,
            })
        })
        .collect()
}

fn station_indices(entities: &[Value]) -> Vec<usize> {
    entities
        .iter()
        .enumerate()
        .filter_map(|(index, entity)| {
            entity.as_object().and_then(|object| {
                let building = string_at(object, "buildingId");
                (string_at(object, "kind") == Some("station")
                    && matches!(
                        building,
                        Some("planetary_logistics_station" | "interstellar_logistics_station")
                    )
                    && !(building == Some("interstellar_logistics_station")
                        && finite_number(object.get("stationTier")).floor() == 2.0
                        && string_at(object, "stationOperationMode") == Some("elevator")))
                .then_some(index)
            })
        })
        .collect()
}

#[derive(Debug, Default)]
pub(crate) struct LocalPeerDirectory {
    station_indices: Vec<usize>,
    by_planet_item: HashMap<usize, HashMap<String, LocalPeers>>,
    station_slots: HashMap<usize, Vec<Slot>>,
    station_planets: HashMap<usize, usize>,
}

impl LocalPeerDirectory {
    pub(crate) fn estimated_bytes(&self) -> u64 {
        let station_index_bytes = self.station_indices.capacity() * std::mem::size_of::<usize>();
        let planet_item_bytes = self
            .by_planet_item
            .values()
            .flat_map(HashMap::iter)
            .map(|(item_id, peers)| {
                item_id.capacity()
                    + (peers.supply.capacity() + peers.demand.capacity())
                        * std::mem::size_of::<(usize, usize)>()
            })
            .sum::<usize>();
        let slot_bytes = self
            .station_slots
            .values()
            .map(|slots| {
                slots.capacity() * std::mem::size_of::<Slot>()
                    + slots
                        .iter()
                        .filter_map(|slot| slot.item_id.as_ref())
                        .map(String::capacity)
                        .sum::<usize>()
            })
            .sum::<usize>();
        let hash_entry_bytes = self.by_planet_item.capacity()
            * std::mem::size_of::<(usize, HashMap<String, LocalPeers>)>()
            + self.station_slots.capacity() * std::mem::size_of::<(usize, Vec<Slot>)>()
            + self.station_planets.capacity() * std::mem::size_of::<(usize, usize)>();
        (station_index_bytes + planet_item_bytes + slot_bytes + hash_entry_bytes) as u64
    }
}

#[derive(Debug, Default)]
struct LocalPeers {
    supply: Vec<(usize, usize)>,
    demand: Vec<(usize, usize)>,
}

fn build_peer_directory(
    entities: &[Value],
    station_indices: &[usize],
) -> anyhow::Result<LocalPeerDirectory> {
    let mut by_planet_item = HashMap::<usize, HashMap<String, LocalPeers>>::new();
    let mut station_slots = HashMap::with_capacity(station_indices.len());
    let mut station_planets = HashMap::with_capacity(station_indices.len());
    let mut planet_symbols = HashMap::<String, usize>::new();
    for &station_index in station_indices {
        let station = entities[station_index].as_object().expect("station object");
        if !matches!(
            string_at(station, "buildingId"),
            Some("planetary_logistics_station" | "interstellar_logistics_station")
        ) {
            continue;
        }
        let planet_id = string_at(station, "planetId").unwrap_or_default();
        let planet_key = if let Some(&key) = planet_symbols.get(planet_id) {
            key
        } else {
            let key = planet_symbols.len();
            planet_symbols.insert(planet_id.to_owned(), key);
            key
        };
        let parsed_slots = slots(station)?;
        for (slot_index, slot) in parsed_slots.iter().enumerate() {
            let Some(item_id) = slot.item_id.as_deref() else {
                continue;
            };
            if slot.local_mode == LocalMode::Storage {
                continue;
            }
            let items = by_planet_item.entry(planet_key).or_default();
            if !items.contains_key(item_id) {
                items.insert(item_id.to_owned(), LocalPeers::default());
            }
            let peers = items
                .get_mut(item_id)
                .expect("inserted native local peer item");
            match slot.local_mode {
                LocalMode::Supply => peers.supply.push((station_index, slot_index)),
                LocalMode::Demand => peers.demand.push((station_index, slot_index)),
                LocalMode::Storage => unreachable!("storage slots were filtered"),
            }
        }
        station_planets.insert(station_index, planet_key);
        station_slots.insert(station_index, parsed_slots);
    }
    let sort_matches = |matches: &mut Vec<(usize, usize)>| {
        matches.sort_by(|(left_index, left_slot), (right_index, right_slot)| {
            let left = entities[*left_index].as_object().expect("station object");
            let right = entities[*right_index].as_object().expect("station object");
            let left_priority = station_slots
                .get(left_index)
                .and_then(|values| values.get(*left_slot).map(|slot| slot.priority))
                .unwrap_or(1);
            let right_priority = station_slots
                .get(right_index)
                .and_then(|values| values.get(*right_slot).map(|slot| slot.priority))
                .unwrap_or(1);
            right_priority
                .cmp(&left_priority)
                .then_with(|| {
                    string_at(left, "id")
                        .unwrap_or_default()
                        .cmp(string_at(right, "id").unwrap_or_default())
                })
                .then_with(|| left_slot.cmp(right_slot))
        });
    };
    for peers in by_planet_item.values_mut().flat_map(HashMap::values_mut) {
        sort_matches(&mut peers.supply);
        sort_matches(&mut peers.demand);
        peers.supply.shrink_to_fit();
        peers.demand.shrink_to_fit();
    }
    for items in by_planet_item.values_mut() {
        items.shrink_to_fit();
    }
    by_planet_item.shrink_to_fit();
    station_slots.shrink_to_fit();
    station_planets.shrink_to_fit();
    Ok(LocalPeerDirectory {
        station_indices: station_indices.to_vec(),
        by_planet_item,
        station_slots,
        station_planets,
    })
}

pub(crate) fn prepare_step_directory(
    entities: &[Value],
    station_indices: &[usize],
) -> anyhow::Result<LocalPeerDirectory> {
    let local_station_indices = station_indices
        .iter()
        .copied()
        .filter(|&index| {
            entities[index].as_object().is_some_and(|object| {
                let building = string_at(object, "buildingId");
                string_at(object, "kind") == Some("station")
                    && matches!(
                        building,
                        Some("planetary_logistics_station" | "interstellar_logistics_station")
                    )
                    && !(building == Some("interstellar_logistics_station")
                        && finite_number(object.get("stationTier")).floor() == 2.0
                        && string_at(object, "stationOperationMode") == Some("elevator"))
            })
        })
        .collect::<Vec<_>>();
    build_peer_directory(entities, &local_station_indices)
}

fn entity_index(entities: &[Value]) -> HashMap<String, usize> {
    entities
        .iter()
        .enumerate()
        .filter_map(|(index, entity)| {
            entity
                .as_object()
                .and_then(|object| string_at(object, "id"))
                .map(|id| (id.to_owned(), index))
        })
        .collect()
}

fn has_local_route(entities: &[Value], station_indices: &[usize]) -> bool {
    station_indices.iter().copied().any(|index| {
        let Some(entity) = entities[index].as_object() else {
            return false;
        };
        entity
            .get("stationRoutes")
            .and_then(Value::as_array)
            .is_some_and(|routes| {
                routes
                    .iter()
                    .filter_map(Value::as_object)
                    .any(|route| string_at(route, "scope") == Some("local"))
            })
    })
}

fn directory_has_local_pair(directory: &LocalPeerDirectory) -> bool {
    let has_demand = directory
        .by_planet_item
        .values()
        .flat_map(HashMap::values)
        .any(|peers| !peers.demand.is_empty());
    let has_supply = directory
        .by_planet_item
        .values()
        .flat_map(HashMap::values)
        .any(|peers| !peers.supply.is_empty());
    has_demand && has_supply
}

fn station_capacity(
    state: &CoreState,
    entity: &Map<String, Value>,
    slot: &Slot,
    buffer_limit: f64,
) -> anyhow::Result<f64> {
    let building = string_at(entity, "buildingId")
        .and_then(|id| state.catalog.buildings.get(id))
        .ok_or_else(|| anyhow!("native local station building is missing"))?;
    let rated = stacked_capacity(
        building.output_capacity,
        finite_number(entity.get("machineCount")),
        buffer_limit,
    );
    Ok(if slot.max_stock > 0.0 {
        rated.min(slot.max_stock)
    } else {
        rated
    })
}

fn installed_drones(entity: &Map<String, Value>) -> f64 {
    (DRONES_PER_BUILDING * finite_number(entity.get("machineCount")).floor().max(0.0))
        .min(finite_number(entity.get("stationDrones")).floor().max(0.0))
}

fn drone_capacity(entity: &Map<String, Value>) -> f64 {
    DRONES_PER_BUILDING * finite_number(entity.get("machineCount")).floor().max(0.0)
}

fn logistics_level(base: &Map<String, Value>) -> f64 {
    base.get("endgame")
        .and_then(Value::as_object)
        .and_then(|endgame| endgame.get("infiniteResearch"))
        .and_then(Value::as_object)
        .and_then(|research| research.get("galactic_logistics"))
        .and_then(Value::as_object)
        .and_then(|progress| progress.get("level"))
        .map(|value| finite_number(Some(value)).floor().clamp(0.0, 1_000.0))
        .unwrap_or(0.0)
}

fn completed_tech(base: &Map<String, Value>, id: &str) -> bool {
    base.get("research")
        .and_then(Value::as_object)
        .and_then(|research| research.get("completedTechIds"))
        .and_then(Value::as_array)
        .is_some_and(|ids| ids.iter().any(|value| value.as_str() == Some(id)))
}

fn cargo_capacity(base: &Map<String, Value>) -> f64 {
    let multiplier =
        (1.0 + if completed_tech(base, "logistics_capacity_1") {
            0.5
        } else {
            0.0
        } + if completed_tech(base, "logistics_capacity_2") {
            0.5
        } else {
            0.0
        }) * (1.0 + logistics_level(base) * 0.05);
    (CARGO_PER_DRONE * multiplier).round()
}

fn logistics_speed(base: &Map<String, Value>) -> f64 {
    let research =
        1.0 + if completed_tech(base, "logistics_engine_1") {
            0.5
        } else {
            0.0
        } + if completed_tech(base, "logistics_engine_2") {
            0.5
        } else {
            0.0
        };
    let difficulty = match base
        .get("settings")
        .and_then(Value::as_object)
        .and_then(|settings| settings.get("difficulty"))
        .and_then(Value::as_str)
        .unwrap_or("standard")
    {
        "relaxed" => 1.1,
        "hard" => 0.9,
        _ => 1.0,
    };
    research * (1.0 + logistics_level(base) * 0.05) * difficulty
}

fn minimum_cargo(cargo_capacity: f64, slot: &Slot) -> f64 {
    (cargo_capacity * slot.minimum_load).ceil()
}

fn route_owner_id<'a>(demand: &'a Map<String, Value>, route: &'a Map<String, Value>) -> &'a str {
    string_at(route, "vehicleStationId")
        .unwrap_or_else(|| string_at(demand, "id").unwrap_or_default())
}

fn build_ledger(
    entities: &[Value],
    indexes: &ExactRowIdIndex,
    station_indices: &[usize],
) -> Ledger {
    let mut ledger = Ledger::default();
    for &demand_index in station_indices {
        let demand = entities[demand_index].as_object().expect("station object");
        let Some(routes) = demand.get("stationRoutes").and_then(Value::as_array) else {
            continue;
        };
        for route in routes.iter().filter_map(Value::as_object) {
            let Some(scope) = string_at(route, "scope") else {
                continue;
            };
            if !matches!(scope, "local" | "remote") {
                continue;
            }
            let vehicles = finite_number(route.get("vehicleCount")).floor().max(0.0);
            let cargo = finite_number(route.get("cargo")).floor().max(0.0);
            let item = string_at(route, "itemId").unwrap_or_default();
            let owner = indexes
                .get(route_owner_id(demand, route))
                .copied()
                .unwrap_or(demand_index);
            let supply = string_at(route, "peerId")
                .and_then(|id| indexes.get(id))
                .copied();
            if scope == "local" {
                *ledger.busy.entry(owner).or_default() += vehicles;
            }
            add_ledger_item_amount(&mut ledger.in_flight, demand_index, item, cargo);
            let mut active_stations = HashSet::from([demand_index, owner]);
            if let Some(supply) = supply {
                add_ledger_item_amount(&mut ledger.reserved, supply, item, cargo);
                active_stations.insert(supply);
            }
            for waypoint in route
                .get("waypointStationIds")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .filter_map(|id| indexes.get(id))
            {
                active_stations.insert(*waypoint);
            }
            for station_index in active_stations {
                *ledger.active_vehicle_load.entry(station_index).or_default() += vehicles;
                if scope == "local" {
                    ledger.active_local_stations.insert(station_index);
                    let progress = finite_number(route.get("progress"));
                    let current = ledger
                        .active_local_progress
                        .entry(station_index)
                        .or_default();
                    *current = current.max(progress);
                }
            }
        }
    }
    ledger
}

fn peer_matches(
    directory: &LocalPeerDirectory,
    station_index: usize,
    slot_index: usize,
) -> anyhow::Result<Vec<(usize, usize)>> {
    let slot = directory
        .station_slots
        .get(&station_index)
        .ok_or_else(|| anyhow!("native local station slots are missing"))?
        .get(slot_index)
        .ok_or_else(|| anyhow!("native local station slot index is invalid"))?;
    let Some(item_id) = slot.item_id.as_deref() else {
        return Ok(Vec::new());
    };
    if slot.local_mode == LocalMode::Storage {
        return Ok(Vec::new());
    }
    let planet_key = directory
        .station_planets
        .get(&station_index)
        .copied()
        .unwrap_or_default();
    let matches = directory
        .by_planet_item
        .get(&planet_key)
        .and_then(|items| items.get(item_id))
        .map(|peers| match slot.local_mode {
            LocalMode::Supply => peers.demand.as_slice(),
            LocalMode::Demand => peers.supply.as_slice(),
            LocalMode::Storage => &[],
        })
        .into_iter()
        .flatten()
        .copied()
        .filter(|(peer_index, _)| *peer_index != station_index)
        .collect();
    Ok(matches)
}

fn has_peer_match(
    directory: &LocalPeerDirectory,
    station_index: usize,
    slot_index: usize,
) -> anyhow::Result<bool> {
    let slot = directory
        .station_slots
        .get(&station_index)
        .ok_or_else(|| anyhow!("native local station slots are missing"))?
        .get(slot_index)
        .ok_or_else(|| anyhow!("native local station slot index is invalid"))?;
    let Some(item_id) = slot.item_id.as_deref() else {
        return Ok(false);
    };
    if slot.local_mode == LocalMode::Storage {
        return Ok(false);
    }
    let planet_key = directory
        .station_planets
        .get(&station_index)
        .copied()
        .unwrap_or_default();
    Ok(directory
        .by_planet_item
        .get(&planet_key)
        .and_then(|items| items.get(item_id))
        .map(|peers| match slot.local_mode {
            LocalMode::Supply => peers.demand.as_slice(),
            LocalMode::Demand => peers.supply.as_slice(),
            LocalMode::Storage => &[],
        })
        .is_some_and(|matches| {
            matches
                .iter()
                .any(|(peer_index, _)| *peer_index != station_index)
        }))
}

pub(crate) fn admission_reason(state: &CoreState) -> anyhow::Result<Option<&'static str>> {
    let entities = (0..state.entity_index.len())
        .map(|index| state.parse_entity(index))
        .collect::<anyhow::Result<Vec<_>>>()?;
    let indexes = entity_index(&entities);
    for station_index in station_indices(&entities) {
        let station = entities[station_index].as_object().expect("station object");
        if string_at(station, "buildingId") == Some("orbital_collector") {
            continue;
        }
        if !matches!(
            string_at(station, "buildingId"),
            Some("planetary_logistics_station" | "interstellar_logistics_station")
        ) {
            return Ok(Some("local-logistics-station-type-unsupported"));
        }
        if string_at(station, "buildingId") == Some("interstellar_logistics_station")
            && !matches!(
                string_at(station, "stationOperationMode"),
                None | Some("legacy")
            )
        {
            return Ok(Some("local-logistics-operation-mode-unsupported"));
        }
        if station.get("stationModeTransition").is_some_and(|value| {
            !value.is_null() && !matches!(value.as_str(), Some("to-elevator" | "to-legacy"))
        }) {
            return Ok(Some("local-logistics-transition-unsupported"));
        }
        let station_slots = match slots(station) {
            Ok(values) => values,
            Err(_) => return Ok(Some("local-logistics-slots-invalid")),
        };
        if station_slots
            .iter()
            .filter_map(|slot| slot.item_id.as_deref())
            .any(|id| !state.catalog.items.contains_key(id))
        {
            return Ok(Some("local-logistics-slot-item-invalid"));
        }
        let Some(routes) = station.get("stationRoutes").and_then(Value::as_array) else {
            return Ok(Some("local-logistics-routes-invalid"));
        };
        for route_value in routes {
            let Some(route) = route_value.as_object() else {
                return Ok(Some("local-logistics-route-invalid"));
            };
            if string_at(route, "scope") == Some("remote") {
                continue;
            }
            let peer_valid = string_at(route, "peerId")
                .and_then(|id| indexes.get(id))
                .is_some();
            let owner_valid = indexes.contains_key(route_owner_id(station, route));
            if string_at(route, "scope") != Some("local")
                || !peer_valid
                || !owner_valid
                || string_at(route, "itemId").is_none_or(|id| !state.catalog.items.contains_key(id))
            {
                return Ok(Some("local-logistics-route-invalid"));
            }
        }
    }
    Ok(None)
}

pub(crate) fn reset_runtime_for_indices(
    entities: &mut [Value],
    station_indices: &[usize],
) -> anyhow::Result<()> {
    for &station_index in station_indices {
        let station = entities[station_index]
            .as_object_mut()
            .ok_or_else(|| anyhow!("native local station is invalid"))?;
        set_number(station, "utilization", 0.0)?;
        set_number(station, "productionRate", 0.0)?;
        station.remove("stationPeerId");
    }
    Ok(())
}

pub(crate) fn transfer_buffers(
    state: &CoreState,
    base: &Map<String, Value>,
    entities: &mut [Value],
    directory: &LocalPeerDirectory,
) -> anyhow::Result<()> {
    let buffer_limit = normalized_buffer_limit(base);
    for &station_index in &directory.station_indices {
        let station_slots = directory
            .station_slots
            .get(&station_index)
            .ok_or_else(|| anyhow!("native local station slots are missing"))?;
        let station = entities[station_index]
            .as_object_mut()
            .ok_or_else(|| anyhow!("native local station is invalid"))?;
        if !matches!(
            string_at(station, "buildingId"),
            Some("planetary_logistics_station" | "interstellar_logistics_station")
        ) {
            continue;
        }
        for slot in station_slots {
            let Some(item_id) = slot.item_id.as_deref() else {
                continue;
            };
            let capacity = station_capacity(state, station, slot, buffer_limit)?;
            let incoming = (item_amount(station, "inputs", item_id) + EPSILON).floor();
            let stored = (item_amount(station, "outputs", item_id) + EPSILON).floor();
            let moved = incoming.min((capacity - stored).max(0.0));
            set_item_amount(station, "inputs", item_id, incoming - moved)?;
            set_item_amount(station, "outputs", item_id, stored + moved)?;
        }
    }
    Ok(())
}

fn plan_ready_station_indices_with<F>(
    runtime: &DeterministicRuntime,
    entities: &[Value],
    directory: &LocalPeerDirectory,
    ledger: &Ledger,
    cargo_capacity: f64,
    station_capacity: F,
) -> anyhow::Result<Vec<Option<usize>>>
where
    F: Fn(usize, &Map<String, Value>, &Slot) -> anyhow::Result<f64> + Send + Sync,
{
    runtime.indexed_try_map(
        &directory.station_indices,
        |_, station_index| -> anyhow::Result<Option<usize>> {
            let station_index = *station_index;
            let station = entities[station_index].as_object().expect("station object");
            if !matches!(
                string_at(station, "buildingId"),
                Some("planetary_logistics_station" | "interstellar_logistics_station")
            ) {
                return Ok(None);
            }
            if ledger.active_local_stations.contains(&station_index) {
                return Ok(Some(station_index));
            }
            let station_slots = directory
                .station_slots
                .get(&station_index)
                .ok_or_else(|| anyhow!("native local station slots are missing"))?;
            for (slot_index, slot) in station_slots.iter().enumerate() {
                let Some(item_id) = slot.item_id.as_deref() else {
                    continue;
                };
                if slot.local_mode == LocalMode::Storage {
                    continue;
                }
                for (peer_index, peer_slot_index) in
                    peer_matches(directory, station_index, slot_index)?
                {
                    let peer_slots = directory
                        .station_slots
                        .get(&peer_index)
                        .ok_or_else(|| anyhow!("native local peer slots are missing"))?;
                    let (demand_index, demand_slot, supply_index, supply_slot) =
                        if slot.local_mode == LocalMode::Demand {
                            (
                                station_index,
                                slot,
                                peer_index,
                                &peer_slots[peer_slot_index],
                            )
                        } else {
                            (
                                peer_index,
                                &peer_slots[peer_slot_index],
                                station_index,
                                slot,
                            )
                        };
                    let demand = entities[demand_index].as_object().expect("station object");
                    let supply = entities[supply_index].as_object().expect("station object");
                    let available = (item_amount(supply, "outputs", item_id)
                        - supply_slot.min_stock)
                        .max(0.0)
                        .floor();
                    let free = (station_capacity(demand_index, demand, demand_slot)?
                        - item_amount(demand, "outputs", item_id)
                        - ledger_item_amount(&ledger.in_flight, demand_index, item_id))
                    .max(0.0)
                    .floor();
                    for (owner_index, owner_slot) in
                        [(demand_index, demand_slot), (supply_index, supply_slot)]
                    {
                        let owner = entities[owner_index].as_object().expect("station object");
                        let has_vehicle = installed_drones(owner)
                            - ledger.busy.get(&owner_index).copied().unwrap_or(0.0)
                            > 0.0;
                        let minimum = minimum_cargo(cargo_capacity, owner_slot);
                        if has_vehicle && available >= minimum && free >= minimum {
                            return Ok(Some(station_index));
                        }
                    }
                }
            }
            Ok(None)
        },
    )
}

fn replay_ready_station_indices(planned: Vec<Option<usize>>) -> HashSet<usize> {
    let mut ready = HashSet::with_capacity(planned.len());
    // Replay in original topology order even though the public result is a
    // set. The caller later sorts this set before power probes; retaining the
    // historical insertion order also keeps this boundary ready for a future
    // ordered representation without making it worker-schedule dependent.
    for station_index in planned.into_iter().flatten() {
        ready.insert(station_index);
    }
    ready
}

pub(crate) fn ready_station_indices(
    state: &CoreState,
    base: &Map<String, Value>,
    entities: &[Value],
    directory: &LocalPeerDirectory,
) -> anyhow::Result<HashSet<usize>> {
    if !directory_has_local_pair(directory)
        && !has_local_route(entities, &directory.station_indices)
    {
        return Ok(HashSet::new());
    }
    let ledger = build_ledger(entities, &state.entity_index, &directory.station_indices);
    let buffer_limit = normalized_buffer_limit(base);
    let planned = plan_ready_station_indices_with(
        deterministic_runtime(),
        entities,
        directory,
        &ledger,
        cargo_capacity(base),
        |_, demand, demand_slot| station_capacity(state, demand, demand_slot, buffer_limit),
    )?;
    Ok(replay_ready_station_indices(planned))
}

fn add_max_field(
    entities: &mut [Value],
    index: usize,
    key: &str,
    value: f64,
) -> anyhow::Result<()> {
    let entity = entities[index]
        .as_object_mut()
        .ok_or_else(|| anyhow!("native local station is invalid"))?;
    set_number(entity, key, finite_number(entity.get(key)).max(value))
}

fn set_peer(entities: &mut [Value], index: usize, peer_id: &str) {
    if let Some(entity) = entities[index].as_object_mut() {
        let peer_id = Value::from(peer_id);
        if let Some(current) = entity.get_mut("stationPeerId") {
            *current = peer_id;
        } else {
            entity.insert("stationPeerId".to_owned(), peer_id);
        }
    }
}

pub(crate) fn dispatch(
    state: &CoreState,
    base: &mut Map<String, Value>,
    entities: &mut [Value],
    powers: &HashMap<usize, f64>,
    directory: &LocalPeerDirectory,
) -> anyhow::Result<()> {
    if !directory_has_local_pair(directory)
        && !has_local_route(entities, &directory.station_indices)
    {
        return Ok(());
    }
    let indexes = &state.entity_index;
    let mut ledger = build_ledger(entities, indexes, &directory.station_indices);
    let buffer_limit = normalized_buffer_limit(base);
    let cargo_capacity = cargo_capacity(base);
    let logistics_speed = logistics_speed(base);
    for &demand_index in &directory.station_indices {
        let (eligible, cursor, demand_id) = {
            let demand = entities[demand_index]
                .as_object()
                .ok_or_else(|| anyhow!("native local demand station is invalid"))?;
            (
                matches!(
                    string_at(demand, "buildingId"),
                    Some("planetary_logistics_station" | "interstellar_logistics_station")
                ),
                finite_number(demand.get("stationDispatchCursor"))
                    .floor()
                    .max(0.0) as usize,
                string_at(demand, "id").unwrap_or_default().to_owned(),
            )
        };
        if !eligible {
            continue;
        }
        let demand_slots = directory
            .station_slots
            .get(&demand_index)
            .ok_or_else(|| anyhow!("native local demand slots are missing"))?;
        let mut ordered_slots = demand_slots
            .iter()
            .enumerate()
            .filter(|(_, slot)| slot.item_id.is_some() && slot.local_mode == LocalMode::Demand)
            .collect::<Vec<_>>();
        ordered_slots.sort_by(|(left_index, left), (right_index, right)| {
            right
                .priority
                .cmp(&left.priority)
                .then_with(|| left_index.cmp(right_index))
        });
        if ordered_slots.is_empty() {
            continue;
        }
        for offset in 0..ordered_slots.len() {
            let (slot_index, slot) = ordered_slots[(cursor + offset) % ordered_slots.len()];
            let item_id = slot.item_id.as_deref().expect("demand item").to_owned();
            let fairness_key = format!("local:{slot_index}");
            let last_peer_id = entities[demand_index]
                .as_object()
                .and_then(|demand| demand.get("stationLastSupplyPeerBySlot"))
                .and_then(Value::as_object)
                .and_then(|values| values.get(&fairness_key))
                .and_then(Value::as_str)
                .map(str::to_owned);
            let mut matches = peer_matches(directory, demand_index, slot_index)?;
            matches.sort_by(|(left_index, left_slot), (right_index, right_slot)| {
                let left = entities[*left_index].as_object().expect("station object");
                let right = entities[*right_index].as_object().expect("station object");
                let left_priority = directory
                    .station_slots
                    .get(left_index)
                    .and_then(|values| values.get(*left_slot).map(|slot| slot.priority))
                    .unwrap_or(1);
                let right_priority = directory
                    .station_slots
                    .get(right_index)
                    .and_then(|values| values.get(*right_slot).map(|slot| slot.priority))
                    .unwrap_or(1);
                right_priority
                    .cmp(&left_priority)
                    .then_with(|| {
                        ledger
                            .active_vehicle_load
                            .get(left_index)
                            .copied()
                            .unwrap_or(0.0)
                            .partial_cmp(
                                &ledger
                                    .active_vehicle_load
                                    .get(right_index)
                                    .copied()
                                    .unwrap_or(0.0),
                            )
                            .unwrap_or(Ordering::Equal)
                    })
                    .then_with(|| {
                        if let Some(last) = last_peer_id.as_deref() {
                            let left_after =
                                usize::from(string_at(left, "id").unwrap_or_default() <= last);
                            let right_after =
                                usize::from(string_at(right, "id").unwrap_or_default() <= last);
                            left_after.cmp(&right_after)
                        } else {
                            Ordering::Equal
                        }
                    })
                    .then_with(|| {
                        string_at(left, "id")
                            .unwrap_or_default()
                            .cmp(string_at(right, "id").unwrap_or_default())
                    })
                    .then_with(|| left_slot.cmp(right_slot))
            });
            let demand_now = entities[demand_index].as_object().expect("station object");
            let mut remaining_free = (station_capacity(state, demand_now, slot, buffer_limit)?
                - item_amount(demand_now, "outputs", &item_id)
                - ledger_item_amount(&ledger.in_flight, demand_index, &item_id)
                + EPSILON)
                .floor()
                .max(0.0);
            for (supply_index, peer_slot_index) in matches {
                if remaining_free < 1.0 {
                    break;
                }
                let supply_slot = directory
                    .station_slots
                    .get(&supply_index)
                    .and_then(|values| values.get(peer_slot_index))
                    .ok_or_else(|| anyhow!("native local supply slot is missing"))?;
                let (supply_output, supply_id) = {
                    let supply = entities[supply_index].as_object().expect("station object");
                    (
                        item_amount(supply, "outputs", &item_id),
                        string_at(supply, "id").unwrap_or_default().to_owned(),
                    )
                };
                for (owner_index, owner_slot) in [(demand_index, slot), (supply_index, supply_slot)]
                {
                    let (free_vehicles, owner_id) = {
                        let owner = entities[owner_index].as_object().expect("station object");
                        (
                            (installed_drones(owner)
                                - ledger.busy.get(&owner_index).copied().unwrap_or(0.0))
                            .max(0.0),
                            string_at(owner, "id").unwrap_or_default().to_owned(),
                        )
                    };
                    if free_vehicles < 1.0
                        || powers.get(&owner_index).copied().unwrap_or(0.0) <= EPSILON
                    {
                        continue;
                    }
                    let available = (supply_output
                        - supply_slot.min_stock
                        - ledger_item_amount(&ledger.reserved, supply_index, &item_id)
                        + EPSILON)
                        .floor()
                        .max(0.0);
                    let minimum = minimum_cargo(cargo_capacity, owner_slot);
                    let dispatchable = free_vehicles
                        .min((available / minimum).floor())
                        .min((remaining_free / minimum).floor());
                    if dispatchable < 1.0 {
                        continue;
                    }
                    let cargo = available
                        .min(remaining_free)
                        .min(cargo_capacity * dispatchable);
                    let demand_route_count = entities[demand_index]
                        .as_object()
                        .and_then(|entity| entity.get("stationRoutes"))
                        .and_then(Value::as_array)
                        .map(Vec::len)
                        .unwrap_or(0);
                    let initial_progress = if demand_route_count == 0 {
                        finite_number(
                            entities[demand_index]
                                .as_object()
                                .and_then(|entity| entity.get("stationProgress")),
                        )
                        .clamp(0.0, 0.999999)
                    } else {
                        0.0
                    };
                    let next_id = finite_number(base.get("nextId")).floor().max(0.0);
                    let route = json!({
                        "id": format!("route_{}", next_id as u64),
                        "slotIndex": slot_index,
                        "peerId": supply_id,
                        "itemId": item_id,
                        "scope": "local",
                        "cargo": cargo,
                        "vehicleCount": dispatchable,
                        "progress": initial_progress,
                        "duration": BASE_TRIP_SECONDS / logistics_speed,
                        "requiresWarp": false,
                        "waypointStationIds": [],
                        "distanceLy": 0,
                        "warpersPerVessel": 0,
                        "vehicleStationId": owner_id,
                    });
                    let demand_routes = entities[demand_index]
                        .as_object_mut()
                        .ok_or_else(|| anyhow!("native local demand station is invalid"))?;
                    if !demand_routes
                        .get("stationRoutes")
                        .is_some_and(Value::is_array)
                    {
                        demand_routes.insert("stationRoutes".to_owned(), Value::Array(Vec::new()));
                    }
                    demand_routes
                        .get_mut("stationRoutes")
                        .and_then(Value::as_array_mut)
                        .expect("initialized local demand routes")
                        .push(route);
                    *ledger.busy.entry(owner_index).or_default() += dispatchable;
                    add_ledger_item_amount(&mut ledger.reserved, supply_index, &item_id, cargo);
                    add_ledger_item_amount(&mut ledger.in_flight, demand_index, &item_id, cargo);
                    for index in HashSet::from([demand_index, supply_index, owner_index]) {
                        *ledger.active_vehicle_load.entry(index).or_default() += dispatchable;
                    }
                    remaining_free = (remaining_free - cargo).max(0.0);
                    set_number(base, "nextId", next_id + 1.0)?;
                    {
                        let demand = entities[demand_index]
                            .as_object_mut()
                            .expect("station object");
                        set_number(
                            demand,
                            "stationProgress",
                            finite_number(demand.get("stationProgress")).max(initial_progress),
                        )?;
                        set_number(demand, "stationDispatchCursor", slot_index as f64 + 1.0)?;
                        let fairness = demand
                            .get_mut("stationLastSupplyPeerBySlot")
                            .and_then(Value::as_object_mut)
                            .ok_or_else(|| anyhow!("native local fairness record is missing"))?;
                        let peer = Value::from(supply_id.clone());
                        if let Some(current) = fairness.get_mut(&fairness_key) {
                            *current = peer;
                        } else {
                            fairness.insert(fairness_key.clone(), peer);
                        }
                    }
                    set_peer(entities, demand_index, &supply_id);
                    set_peer(entities, supply_index, &demand_id);
                    set_peer(
                        entities,
                        owner_index,
                        if owner_index == demand_index {
                            &supply_id
                        } else {
                            &demand_id
                        },
                    );
                }
            }
        }
    }
    Ok(())
}

pub(crate) fn advance_routes(
    state: &CoreState,
    base: &mut Map<String, Value>,
    entities: &mut [Value],
    seconds: f64,
    powers: &HashMap<usize, f64>,
    directory: &LocalPeerDirectory,
) -> anyhow::Result<()> {
    if !has_local_route(entities, &directory.station_indices) {
        return Ok(());
    }
    let indexes = &state.entity_index;
    let quantum_bandwidth = crate::quantum_logistics::runtime_bandwidth(base, entities);
    for &demand_index in &directory.station_indices {
        let demand_id = entities[demand_index]
            .as_object()
            .ok_or_else(|| anyhow!("native local demand is invalid"))?
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let Some(routes) = entities[demand_index]
            .as_object_mut()
            .and_then(|demand| demand.get_mut("stationRoutes"))
            .and_then(Value::as_array_mut)
            .map(std::mem::take)
        else {
            continue;
        };
        let mut remaining = Vec::new();
        let mut completed_cargo = 0.0;
        for mut route_value in routes {
            let route = route_value
                .as_object_mut()
                .ok_or_else(|| anyhow!("native local route is invalid"))?;
            if string_at(route, "scope") != Some("local") {
                remaining.push(route_value);
                continue;
            }
            let supply_index = string_at(route, "peerId")
                .and_then(|id| indexes.get(id))
                .copied()
                .ok_or_else(|| anyhow!("native local route peer is missing"))?;
            let owner_index = indexes
                .get(string_at(route, "vehicleStationId").unwrap_or(&demand_id))
                .copied()
                .unwrap_or(demand_index);
            let power = powers.get(&owner_index).copied().unwrap_or(0.0);
            let duration = finite_number(route.get("duration")).max(1.0);
            let progress = rounded(
                finite_number(route.get("progress")) + seconds * power / duration,
                6,
            );
            set_number(route, "progress", progress)?;
            add_max_field(entities, demand_index, "utilization", power)?;
            add_max_field(entities, supply_index, "utilization", power)?;
            add_max_field(entities, owner_index, "utilization", power)?;
            if progress + EPSILON < 1.0 {
                remaining.push(route_value);
                continue;
            }
            let item_id = string_at(route, "itemId").unwrap_or_default().to_owned();
            let cargo = finite_number(route.get("cargo")).floor().max(0.0);
            let vehicles = finite_number(route.get("vehicleCount")).floor().max(0.0);
            let quantum_supply = crate::quantum_logistics::is_supply_endpoint(
                entities[demand_index].as_object().expect("station object"),
                &item_id,
            );
            let delivered_cargo = if quantum_supply {
                crate::quantum_logistics::receive_supply_material(
                    state,
                    base,
                    quantum_bandwidth,
                    entities[demand_index]
                        .as_object_mut()
                        .expect("station object"),
                    &item_id,
                    cargo,
                )?
            } else {
                let demand_current = item_amount(
                    entities[demand_index].as_object().expect("station object"),
                    "outputs",
                    &item_id,
                );
                set_item_amount(
                    entities[demand_index]
                        .as_object_mut()
                        .expect("station object"),
                    "outputs",
                    &item_id,
                    (demand_current + cargo).floor(),
                )?;
                cargo
            };
            let retain_route = delivered_cargo < cargo;
            if retain_route {
                set_number(route, "cargo", cargo - delivered_cargo)?;
            }
            let supply_current = item_amount(
                entities[supply_index].as_object().expect("station object"),
                "outputs",
                &item_id,
            );
            set_item_amount(
                entities[supply_index]
                    .as_object_mut()
                    .expect("station object"),
                "outputs",
                &item_id,
                (supply_current - delivered_cargo).max(0.0).floor(),
            )?;
            for index in [demand_index, supply_index] {
                let station = entities[index].as_object_mut().expect("station object");
                let trips = finite_number(station.get("stationTrips"));
                set_number(station, "stationTrips", (trips + vehicles).floor())?;
                set_number(station, "stationLastTransfer", delivered_cargo)?;
            }
            completed_cargo += delivered_cargo;
            if retain_route {
                remaining.push(route_value);
            }
        }
        let demand = entities[demand_index]
            .as_object_mut()
            .expect("station object");
        let max_progress = remaining
            .iter()
            .filter_map(Value::as_object)
            .map(|route| finite_number(route.get("progress")))
            .fold(0.0_f64, f64::max);
        demand.insert("stationRoutes".to_owned(), Value::Array(remaining));
        let rate = finite_number(demand.get("productionRate"))
            + if seconds > EPSILON {
                completed_cargo * 60.0 / seconds
            } else {
                0.0
            };
        set_number(demand, "productionRate", rate)?;
        set_number(demand, "stationProgress", max_progress)?;
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct CongestionUpdate {
    station_index: usize,
    congestion: f64,
    active_progress: f64,
}

fn plan_idle_congestion_updates(
    runtime: &DeterministicRuntime,
    entities: &[Value],
    station_indices: &[usize],
) -> Vec<Option<CongestionUpdate>> {
    runtime.indexed_map(station_indices, |_, station_index| {
        let station_index = *station_index;
        let station = entities[station_index].as_object().expect("station object");
        matches!(
            string_at(station, "buildingId"),
            Some("planetary_logistics_station" | "interstellar_logistics_station")
        )
        .then_some(CongestionUpdate {
            station_index,
            congestion: 0.0,
            active_progress: 0.0,
        })
    })
}

fn plan_congestion_updates(
    runtime: &DeterministicRuntime,
    entities: &[Value],
    directory: &LocalPeerDirectory,
    ledger: &Ledger,
) -> anyhow::Result<Vec<Option<CongestionUpdate>>> {
    runtime.indexed_try_map(
        &directory.station_indices,
        |_, station_index| -> anyhow::Result<Option<CongestionUpdate>> {
            let station_index = *station_index;
            let station = entities[station_index].as_object().expect("station object");
            if !matches!(
                string_at(station, "buildingId"),
                Some("planetary_logistics_station" | "interstellar_logistics_station")
            ) {
                return Ok(None);
            }
            let station_slots = directory
                .station_slots
                .get(&station_index)
                .ok_or_else(|| anyhow!("native local station slots are missing"))?;
            let mut waiting = 0.0;
            for (slot_index, slot) in station_slots.iter().enumerate() {
                if slot.item_id.is_some()
                    && slot.local_mode == LocalMode::Demand
                    && has_peer_match(directory, station_index, slot_index)?
                {
                    waiting += 1.0;
                }
            }
            let installed = drone_capacity(station);
            let busy = ledger.busy.get(&station_index).copied().unwrap_or(0.0);
            let fleet_load = if installed > 0.0 {
                busy / installed
            } else if waiting > 0.0 {
                1.0
            } else {
                0.0
            };
            let congestion = fleet_load
                .max(if waiting > 0.0 && busy == 0.0 {
                    0.35
                } else {
                    0.0
                })
                .clamp(0.0, 1.0);
            let active_progress = ledger
                .active_local_progress
                .get(&station_index)
                .copied()
                .unwrap_or(0.0);
            Ok(Some(CongestionUpdate {
                station_index,
                congestion: rounded(congestion, 3),
                active_progress,
            }))
        },
    )
}

fn apply_congestion_updates(
    entities: &mut [Value],
    updates: Vec<Option<CongestionUpdate>>,
) -> anyhow::Result<()> {
    // Replay in the original topology order. Apart from preserving the legacy
    // local-before-remote overwrite contract, this keeps insertion order for
    // absent JSON keys and every opaque MOD field byte-for-byte stable.
    for update in updates.into_iter().flatten() {
        let target = entities[update.station_index]
            .as_object_mut()
            .expect("station object");
        set_number(target, "stationCongestion", update.congestion)?;
        set_number(target, "stationProgress", update.active_progress)?;
    }
    Ok(())
}

pub(crate) fn update_congestion(
    state: &CoreState,
    entities: &mut [Value],
    directory: &LocalPeerDirectory,
) -> anyhow::Result<()> {
    let runtime = deterministic_runtime();
    let updates = if !directory_has_local_pair(directory)
        && !has_local_route(entities, &directory.station_indices)
    {
        plan_idle_congestion_updates(runtime, entities, &directory.station_indices)
    } else {
        let ledger = build_ledger(entities, &state.entity_index, &directory.station_indices);
        plan_congestion_updates(runtime, entities, directory, &ledger)?
    };
    apply_congestion_updates(entities, updates)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::deterministic_runtime::PARALLEL_MIN_ITEMS;
    use std::sync::atomic::{AtomicBool, Ordering as AtomicOrdering};

    fn json_key_pointer(record: &Map<String, Value>, key: &str) -> usize {
        record
            .keys()
            .find(|candidate| candidate.as_str() == key)
            .expect("test JSON key")
            .as_ptr() as usize
    }

    fn legacy_set_item_amount(
        entity: &mut Map<String, Value>,
        record: &str,
        item_id: &str,
        amount: f64,
    ) -> anyhow::Result<()> {
        entity
            .get_mut(record)
            .and_then(Value::as_object_mut)
            .ok_or_else(|| anyhow!("native local logistics inventory is missing"))?
            .insert(
                item_id.to_owned(),
                Number::from_f64(amount)
                    .map(Value::Number)
                    .ok_or_else(|| anyhow!("native local logistics inventory is non-finite"))?,
            );
        Ok(())
    }

    #[test]
    fn item_amount_updates_reuse_existing_keys_and_match_legacy_bytes() {
        let item_id = "mod:本地物流/Ω🚀";
        let source = Map::from_iter([(
            "outputs".to_owned(),
            Value::Object(Map::from_iter([
                ("alpha".to_owned(), Value::from(1)),
                (item_id.to_owned(), Value::from(2)),
                ("zeta".to_owned(), Value::from(3)),
            ])),
        )]);
        let mut actual = source.clone();
        let mut expected = source;
        let before = actual["outputs"].as_object().expect("outputs object");
        let pointer = json_key_pointer(before, item_id);
        let order = before.keys().cloned().collect::<Vec<_>>();

        set_item_amount(&mut actual, "outputs", item_id, -0.0).unwrap();
        legacy_set_item_amount(&mut expected, "outputs", item_id, -0.0).unwrap();

        let after = actual["outputs"].as_object().expect("outputs object");
        assert_eq!(json_key_pointer(after, item_id), pointer);
        assert_eq!(after.keys().cloned().collect::<Vec<_>>(), order);
        assert!(after[item_id].as_f64().unwrap().is_sign_negative());
        assert_eq!(
            serde_json::to_vec(&actual).unwrap(),
            serde_json::to_vec(&expected).unwrap()
        );
    }

    #[test]
    fn item_amount_updates_preserve_missing_insert_and_error_order() {
        let mut entity = Map::from_iter([("inputs".to_owned(), Value::Object(Map::new()))]);
        set_item_amount(&mut entity, "inputs", "mod:新物料/β", 7.0).unwrap();
        assert_eq!(item_amount(&entity, "inputs", "mod:新物料/β"), 7.0);

        let snapshot = entity.clone();
        let error = set_item_amount(&mut entity, "inputs", "mod:新物料/β", f64::NAN)
            .expect_err("non-finite amount must fail");
        assert_eq!(
            error.to_string(),
            "native local logistics inventory is non-finite"
        );
        assert_eq!(entity, snapshot);

        let error = set_item_amount(&mut entity, "missing", "mod:新物料/β", f64::NAN)
            .expect_err("missing record must win error order");
        assert_eq!(
            error.to_string(),
            "native local logistics inventory is missing"
        );
        assert_eq!(entity, snapshot);
    }

    #[test]
    fn peer_updates_reuse_existing_key_and_keep_map_order() {
        let mut entities = vec![Value::Object(Map::from_iter([
            ("alpha".to_owned(), Value::from(1)),
            ("stationPeerId".to_owned(), Value::from("station-old")),
            ("zeta".to_owned(), Value::from(3)),
        ]))];
        let before = entities[0].as_object().expect("station object");
        let pointer = json_key_pointer(before, "stationPeerId");
        let order = before.keys().cloned().collect::<Vec<_>>();

        set_peer(&mut entities, 0, "mod:station/新");

        let after = entities[0].as_object().expect("station object");
        assert_eq!(json_key_pointer(after, "stationPeerId"), pointer);
        assert_eq!(after.keys().cloned().collect::<Vec<_>>(), order);
        assert_eq!(after["stationPeerId"], Value::from("mod:station/新"));

        let mut missing = vec![Value::Object(Map::new())];
        set_peer(&mut missing, 0, "station-first");
        assert_eq!(missing[0]["stationPeerId"], Value::from("station-first"));
    }

    fn local_station(id: &str, mode: &str) -> Value {
        let mut configured = json!({
            "itemId": "mod:物流物料/Ω",
            "localMode": mode,
            "minimumLoad": 0.1,
            "minStock": 0,
            "maxStock": 100,
            "priority": 1
        });
        let empty = json!({
            "itemId": null,
            "localMode": "storage",
            "minimumLoad": 0.1,
            "minStock": 0,
            "maxStock": 0,
            "priority": 1
        });
        json!({
            "id": id,
            "kind": "station",
            "planetId": "mod:行星/β",
            "buildingId": "planetary_logistics_station",
            "machineCount": 1,
            "stationSlots": [
                std::mem::take(&mut configured),
                empty.clone(),
                empty.clone(),
                empty.clone(),
                empty
            ],
            "inputs": {},
            "outputs": { "mod:物流物料/Ω": 10 }
        })
    }

    #[test]
    fn prepared_directory_survives_dynamic_updates_and_rebuilds_for_elevator_mode() {
        let mut entities = vec![
            local_station("supply", "supply"),
            local_station("demand", "demand"),
        ];
        let station_indices = vec![0, 1];
        let cached = prepare_step_directory(&entities, &station_indices).unwrap();
        assert_eq!(peer_matches(&cached, 1, 0).unwrap(), vec![(0, 0)]);

        entities[0]["outputs"]["mod:物流物料/Ω"] = Value::from(7);
        entities[1]["stationProgress"] = Value::from(0.75);
        let rebuilt_dynamic = prepare_step_directory(&entities, &station_indices).unwrap();
        assert_eq!(
            peer_matches(&cached, 1, 0).unwrap(),
            peer_matches(&rebuilt_dynamic, 1, 0).unwrap()
        );

        entities[0]["buildingId"] = Value::from("interstellar_logistics_station");
        entities[0]["stationTier"] = Value::from(2);
        entities[0]["stationOperationMode"] = Value::from("elevator");
        let rebuilt_boundary = prepare_step_directory(&entities, &station_indices).unwrap();
        assert!(peer_matches(&rebuilt_boundary, 1, 0).unwrap().is_empty());
        assert_eq!(rebuilt_boundary.station_indices, vec![1]);
    }

    fn local_congestion_matrix(count: usize) -> (Vec<Value>, LocalPeerDirectory, Ledger) {
        let mut entities = (0..count)
            .map(|index| {
                let mut station = local_station(
                    &format!("mod:本地站/{index:05}/Ω"),
                    if index == 0 { "supply" } else { "demand" },
                );
                let record = station.as_object_mut().expect("local congestion station");
                record.insert("stationDrones".to_owned(), Value::from(50));
                record.insert("stationRoutes".to_owned(), Value::Array(Vec::new()));
                record.insert("stationCongestion".to_owned(), Value::from(-1));
                record.insert("stationProgress".to_owned(), Value::from(-1));
                record.insert(
                    "mod:拥堵探针/原样保留".to_owned(),
                    json!({ "index": index, "signedZero": -0.0, "opaque": "Ω🚀" }),
                );
                station
            })
            .collect::<Vec<_>>();
        // A non-station row in the topology slice exercises the legacy skip
        // without changing the relative replay order of station updates.
        entities.push(json!({
            "id": "mod:非物流实体/保持",
            "kind": "machine",
            "buildingId": "mod:machine",
            "mod:payload": [3, 2, 1]
        }));
        let station_indices = (0..entities.len()).collect::<Vec<_>>();
        let directory = prepare_step_directory(&entities, &station_indices).unwrap();
        let mut ledger = Ledger::default();
        for station_index in 0..count {
            ledger
                .busy
                .insert(station_index, (station_index % 67) as f64);
            ledger.active_local_progress.insert(
                station_index,
                f64::from((station_index % 101) as u32) / 101.0,
            );
        }
        (entities, directory, ledger)
    }

    fn run_local_congestion_plan(worker_count: usize) -> Vec<Value> {
        let (mut entities, directory, ledger) = local_congestion_matrix(PARALLEL_MIN_ITEMS + 37);
        let source = serde_json::to_vec(&entities).unwrap();
        let updates = plan_congestion_updates(
            &DeterministicRuntime::for_test(worker_count),
            &entities,
            &directory,
            &ledger,
        )
        .unwrap();
        assert_eq!(
            serde_json::to_vec(&entities).unwrap(),
            source,
            "read-only probes must not mutate their source"
        );
        apply_congestion_updates(&mut entities, updates).unwrap();
        entities
    }

    #[test]
    fn local_congestion_parallel_probe_is_bitwise_stable_for_1_2_4_8_workers() {
        let expected = run_local_congestion_plan(1);
        let expected_bytes = serde_json::to_vec(&expected).unwrap();
        for worker_count in [2, 4, 8] {
            let actual = run_local_congestion_plan(worker_count);
            assert_eq!(serde_json::to_vec(&actual).unwrap(), expected_bytes);
        }

        let first = expected[0].as_object().unwrap();
        let waiting = expected[67].as_object().unwrap();
        let saturated = expected[66].as_object().unwrap();
        assert_eq!(first["stationCongestion"], Value::from(0.0));
        assert_eq!(waiting["stationCongestion"], Value::from(0.35));
        assert_eq!(saturated["stationCongestion"], Value::from(1.0));
        assert_eq!(
            waiting["mod:拥堵探针/原样保留"]["opaque"],
            Value::from("Ω🚀")
        );
    }

    #[test]
    fn local_congestion_parallel_failure_keeps_source_atomic() {
        let (entities, mut directory, ledger) = local_congestion_matrix(PARALLEL_MIN_ITEMS + 11);
        directory.station_slots.remove(&7);
        directory.station_slots.remove(&(PARALLEL_MIN_ITEMS + 3));
        let source = serde_json::to_vec(&entities).unwrap();

        for worker_count in [1, 2, 4, 8] {
            let error = plan_congestion_updates(
                &DeterministicRuntime::for_test(worker_count),
                &entities,
                &directory,
                &ledger,
            )
            .expect_err("missing station slots must reject the whole probe batch");
            assert_eq!(error.to_string(), "native local station slots are missing");
            assert_eq!(serde_json::to_vec(&entities).unwrap(), source);
        }
    }

    fn run_ready_station_plan(worker_count: usize) -> (Vec<Option<usize>>, Vec<usize>) {
        let (entities, directory, mut ledger) = local_congestion_matrix(PARALLEL_MIN_ITEMS + 43);
        ledger.active_local_stations.insert(7);
        let source = serde_json::to_vec(&entities).unwrap();
        let planned = plan_ready_station_indices_with(
            &DeterministicRuntime::for_test(worker_count),
            &entities,
            &directory,
            &ledger,
            25.0,
            |demand_index, _, _| Ok(if demand_index % 2 == 0 { 100.0 } else { 10.0 }),
        )
        .unwrap();
        assert_eq!(
            serde_json::to_vec(&entities).unwrap(),
            source,
            "ready probes must not mutate routes, inventories, or MOD fields"
        );
        let mut ready = replay_ready_station_indices(planned.clone())
            .into_iter()
            .collect::<Vec<_>>();
        ready.sort_unstable();
        (planned, ready)
    }

    #[test]
    fn ready_station_parallel_probe_is_exact_for_1_2_4_8_workers() {
        let expected = run_ready_station_plan(1);
        for worker_count in [2, 4, 8] {
            assert_eq!(run_ready_station_plan(worker_count), expected);
        }

        let (planned, ready) = expected;
        assert_eq!(planned[0], Some(0));
        assert_eq!(planned[1], None);
        assert_eq!(planned[2], Some(2));
        assert_eq!(planned[7], Some(7));
        assert!(ready.contains(&0));
        assert!(ready.contains(&2));
        assert!(ready.contains(&7));
        assert!(!ready.contains(&1));
        assert!(!ready.contains(&9));
    }

    #[test]
    fn ready_station_parallel_failure_uses_lowest_index_and_keeps_source_atomic() {
        let (entities, directory, ledger) = local_congestion_matrix(PARALLEL_MIN_ITEMS + 23);
        let source = serde_json::to_vec(&entities).unwrap();
        let later_failure = PARALLEL_MIN_ITEMS + 11;

        for worker_count in [1, 2, 4, 8] {
            let visited_later_failure = AtomicBool::new(false);
            let error = plan_ready_station_indices_with(
                &DeterministicRuntime::for_test(worker_count),
                &entities,
                &directory,
                &ledger,
                25.0,
                |demand_index, _, _| {
                    if demand_index == later_failure {
                        visited_later_failure.store(true, AtomicOrdering::SeqCst);
                        bail!("later local ready probe failure");
                    }
                    if demand_index == 7 {
                        bail!("first local ready probe failure");
                    }
                    Ok(100.0)
                },
            )
            .expect_err("any failed readiness probe must reject the whole batch");
            assert_eq!(error.to_string(), "first local ready probe failure");
            assert!(
                visited_later_failure.load(AtomicOrdering::SeqCst),
                "all probes must finish before the lowest input error is selected"
            );
            assert_eq!(serde_json::to_vec(&entities).unwrap(), source);
        }
    }

    #[test]
    fn small_ready_station_batches_stay_serial() {
        let (entities, directory, ledger) = local_congestion_matrix(31);
        let saw_rayon_worker = AtomicBool::new(false);
        let planned = plan_ready_station_indices_with(
            &DeterministicRuntime::for_test(8),
            &entities,
            &directory,
            &ledger,
            25.0,
            |_, _, _| {
                if rayon::current_thread_index().is_some() {
                    saw_rayon_worker.store(true, AtomicOrdering::SeqCst);
                }
                Ok(100.0)
            },
        )
        .unwrap();
        assert_eq!(planned.len(), directory.station_indices.len());
        assert!(!saw_rayon_worker.load(AtomicOrdering::SeqCst));
    }
}
