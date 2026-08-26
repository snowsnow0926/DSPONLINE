use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};

use anyhow::{anyhow, bail};
use serde_json::{Map, Number, Value, json};

use crate::state::CoreState;

const EPSILON: f64 = 0.0001;
const SLOT_COUNT: usize = 5;
const DRONES_PER_BUILDING: f64 = 50.0;
const CARGO_PER_DRONE: f64 = 25.0;
const BASE_TRIP_SECONDS: f64 = 8.0;

#[derive(Debug, Clone)]
struct Slot {
    item_id: Option<String>,
    local_mode: String,
    minimum_load: f64,
    min_stock: f64,
    max_stock: f64,
    priority: usize,
}

#[derive(Debug, Default)]
struct Ledger {
    busy: HashMap<usize, f64>,
    reserved: HashMap<(usize, String), f64>,
    in_flight: HashMap<(usize, String), f64>,
    active_vehicle_load: HashMap<usize, f64>,
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
    object.insert(
        key.to_owned(),
        Number::from_f64(value)
            .map(Value::Number)
            .ok_or_else(|| anyhow!("native local logistics produced a non-finite number"))?,
    );
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
            let local_mode = string_at(slot, "localMode").unwrap_or("storage");
            if !matches!(local_mode, "supply" | "demand" | "storage") {
                bail!("native local station mode is invalid");
            }
            let minimum_load = finite_number(slot.get("minimumLoad"));
            if ![0.1, 0.25, 0.5, 1.0]
                .iter()
                .any(|value| (minimum_load - value).abs() <= f64::EPSILON)
            {
                bail!("native local station minimum load is invalid");
            }
            Ok(Slot {
                item_id: string_at(slot, "itemId").map(str::to_owned),
                local_mode: local_mode.to_owned(),
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
            entity
                .as_object()
                .and_then(|object| (string_at(object, "kind") == Some("station")).then_some(index))
        })
        .collect()
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

fn station_capacity(
    state: &CoreState,
    base: &Map<String, Value>,
    entity: &Map<String, Value>,
    slot: &Slot,
) -> anyhow::Result<f64> {
    let building = string_at(entity, "buildingId")
        .and_then(|id| state.catalog.buildings.get(id))
        .ok_or_else(|| anyhow!("native local station building is missing"))?;
    let rated = stacked_capacity(
        building.output_capacity,
        finite_number(entity.get("machineCount")),
        normalized_buffer_limit(base),
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

fn minimum_cargo(base: &Map<String, Value>, slot: &Slot) -> f64 {
    (cargo_capacity(base) * slot.minimum_load).ceil()
}

fn route_owner_id<'a>(demand: &'a Map<String, Value>, route: &'a Map<String, Value>) -> &'a str {
    string_at(route, "vehicleStationId")
        .unwrap_or_else(|| string_at(demand, "id").unwrap_or_default())
}

fn build_ledger(entities: &[Value], indexes: &HashMap<String, usize>) -> Ledger {
    let mut ledger = Ledger::default();
    for (demand_index, demand) in entities
        .iter()
        .enumerate()
        .filter_map(|(index, value)| value.as_object().map(|object| (index, object)))
    {
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
            let item = string_at(route, "itemId").unwrap_or_default().to_owned();
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
            *ledger
                .in_flight
                .entry((demand_index, item.clone()))
                .or_default() += cargo;
            let mut active_stations = HashSet::from([demand_index, owner]);
            if let Some(supply) = supply {
                *ledger.reserved.entry((supply, item)).or_default() += cargo;
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
            }
        }
    }
    ledger
}

fn peer_matches(
    entities: &[Value],
    station_index: usize,
    slot_index: usize,
) -> anyhow::Result<Vec<(usize, usize)>> {
    let station = entities[station_index]
        .as_object()
        .ok_or_else(|| anyhow!("native local station is invalid"))?;
    let station_slots = slots(station)?;
    let slot = station_slots
        .get(slot_index)
        .ok_or_else(|| anyhow!("native local station slot index is invalid"))?;
    let Some(item_id) = slot.item_id.as_deref() else {
        return Ok(Vec::new());
    };
    if slot.local_mode == "storage" {
        return Ok(Vec::new());
    }
    let opposite = if slot.local_mode == "supply" {
        "demand"
    } else {
        "supply"
    };
    let planet_id = string_at(station, "planetId");
    let mut matches = Vec::new();
    for peer_index in station_indices(entities) {
        if peer_index == station_index {
            continue;
        }
        let peer = entities[peer_index].as_object().expect("station object");
        if !matches!(
            string_at(peer, "buildingId"),
            Some("planetary_logistics_station" | "interstellar_logistics_station")
        ) || string_at(peer, "planetId") != planet_id
        {
            continue;
        }
        for (peer_slot_index, peer_slot) in slots(peer)?.iter().enumerate() {
            if peer_slot.item_id.as_deref() == Some(item_id) && peer_slot.local_mode == opposite {
                matches.push((peer_index, peer_slot_index));
            }
        }
    }
    matches.sort_by(|(left_index, left_slot), (right_index, right_slot)| {
        let left = entities[*left_index].as_object().expect("station object");
        let right = entities[*right_index].as_object().expect("station object");
        let left_priority = slots(left)
            .ok()
            .and_then(|values| values.get(*left_slot).map(|slot| slot.priority))
            .unwrap_or(1);
        let right_priority = slots(right)
            .ok()
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
    Ok(matches)
}

fn route_active_for_station(
    entities: &[Value],
    indexes: &HashMap<String, usize>,
    station_index: usize,
) -> bool {
    entities.iter().enumerate().any(|(demand_index, value)| {
        let Some(demand) = value.as_object() else {
            return false;
        };
        demand
            .get("stationRoutes")
            .and_then(Value::as_array)
            .is_some_and(|routes| {
                routes.iter().filter_map(Value::as_object).any(|route| {
                    if string_at(route, "scope") != Some("local") {
                        return false;
                    }
                    let supply = string_at(route, "peerId")
                        .and_then(|id| indexes.get(id))
                        .copied();
                    let owner = indexes
                        .get(route_owner_id(demand, route))
                        .copied()
                        .unwrap_or(demand_index);
                    demand_index == station_index
                        || supply == Some(station_index)
                        || owner == station_index
                })
            })
    })
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
        if station
            .get("stationModeTransition")
            .is_some_and(|value| !value.is_null())
            || station
                .get("quantumTransition")
                .is_some_and(|value| !value.is_null())
        {
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

pub(crate) fn reset_runtime(entities: &mut [Value]) -> anyhow::Result<()> {
    for station in entities
        .iter_mut()
        .filter_map(Value::as_object_mut)
        .filter(|entity| string_at(entity, "kind") == Some("station"))
    {
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
) -> anyhow::Result<()> {
    for station in entities
        .iter_mut()
        .filter_map(Value::as_object_mut)
        .filter(|entity| {
            matches!(
                string_at(entity, "buildingId"),
                Some("planetary_logistics_station" | "interstellar_logistics_station")
            )
        })
    {
        for slot in slots(station)? {
            let Some(item_id) = slot.item_id.as_deref() else {
                continue;
            };
            let capacity = station_capacity(state, base, station, &slot)?;
            let incoming = (item_amount(station, "inputs", item_id) + EPSILON).floor();
            let stored = (item_amount(station, "outputs", item_id) + EPSILON).floor();
            let moved = incoming.min((capacity - stored).max(0.0));
            set_item_amount(station, "inputs", item_id, incoming - moved)?;
            set_item_amount(station, "outputs", item_id, stored + moved)?;
        }
    }
    Ok(())
}

pub(crate) fn ready_station_indices(
    state: &CoreState,
    base: &Map<String, Value>,
    entities: &[Value],
) -> anyhow::Result<HashSet<usize>> {
    let indexes = entity_index(entities);
    let ledger = build_ledger(entities, &indexes);
    let mut ready = HashSet::new();
    for station_index in station_indices(entities) {
        let station = entities[station_index].as_object().expect("station object");
        if !matches!(
            string_at(station, "buildingId"),
            Some("planetary_logistics_station" | "interstellar_logistics_station")
        ) {
            continue;
        }
        if route_active_for_station(entities, &indexes, station_index) {
            ready.insert(station_index);
            continue;
        }
        let station_slots = slots(station)?;
        'slots: for (slot_index, slot) in station_slots.iter().enumerate() {
            let Some(item_id) = slot.item_id.as_deref() else {
                continue;
            };
            if slot.local_mode == "storage" {
                continue;
            }
            for (peer_index, peer_slot_index) in peer_matches(entities, station_index, slot_index)?
            {
                let peer = entities[peer_index].as_object().expect("station object");
                let peer_slots = slots(peer)?;
                let (demand_index, demand_slot, supply_index, supply_slot) =
                    if slot.local_mode == "demand" {
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
                let available = (item_amount(supply, "outputs", item_id) - supply_slot.min_stock)
                    .max(0.0)
                    .floor();
                let free = (station_capacity(state, base, demand, demand_slot)?
                    - item_amount(demand, "outputs", item_id)
                    - ledger
                        .in_flight
                        .get(&(demand_index, item_id.to_owned()))
                        .copied()
                        .unwrap_or(0.0))
                .max(0.0)
                .floor();
                for (owner_index, owner_slot) in
                    [(demand_index, demand_slot), (supply_index, supply_slot)]
                {
                    let owner = entities[owner_index].as_object().expect("station object");
                    let has_vehicle = installed_drones(owner)
                        - ledger.busy.get(&owner_index).copied().unwrap_or(0.0)
                        > 0.0;
                    let minimum = minimum_cargo(base, owner_slot);
                    if has_vehicle && available >= minimum && free >= minimum {
                        ready.insert(station_index);
                        break 'slots;
                    }
                }
            }
        }
    }
    Ok(ready)
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
        entity.insert("stationPeerId".to_owned(), Value::from(peer_id));
    }
}

pub(crate) fn dispatch(
    state: &CoreState,
    base: &mut Map<String, Value>,
    entities: &mut [Value],
    powers: &HashMap<usize, f64>,
) -> anyhow::Result<()> {
    let indexes = entity_index(entities);
    let mut ledger = build_ledger(entities, &indexes);
    for demand_index in station_indices(entities) {
        let demand_snapshot = entities[demand_index]
            .as_object()
            .ok_or_else(|| anyhow!("native local demand station is invalid"))?
            .clone();
        if !matches!(
            string_at(&demand_snapshot, "buildingId"),
            Some("planetary_logistics_station" | "interstellar_logistics_station")
        ) {
            continue;
        }
        let demand_slots = slots(&demand_snapshot)?;
        let mut ordered_slots = demand_slots
            .iter()
            .enumerate()
            .filter(|(_, slot)| slot.item_id.is_some() && slot.local_mode == "demand")
            .map(|(index, slot)| (index, slot.clone()))
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
        let cursor = finite_number(demand_snapshot.get("stationDispatchCursor"))
            .floor()
            .max(0.0) as usize;
        for offset in 0..ordered_slots.len() {
            let (slot_index, slot) = &ordered_slots[(cursor + offset) % ordered_slots.len()];
            let item_id = slot.item_id.as_deref().expect("demand item").to_owned();
            let fairness_key = format!("local:{slot_index}");
            let last_peer_id = demand_snapshot
                .get("stationLastSupplyPeerBySlot")
                .and_then(Value::as_object)
                .and_then(|values| values.get(&fairness_key))
                .and_then(Value::as_str)
                .map(str::to_owned);
            let mut matches = peer_matches(entities, demand_index, *slot_index)?;
            matches.sort_by(|(left_index, left_slot), (right_index, right_slot)| {
                let left = entities[*left_index].as_object().expect("station object");
                let right = entities[*right_index].as_object().expect("station object");
                let left_priority = slots(left)
                    .ok()
                    .and_then(|values| values.get(*left_slot).map(|slot| slot.priority))
                    .unwrap_or(1);
                let right_priority = slots(right)
                    .ok()
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
            let mut remaining_free = (station_capacity(state, base, demand_now, slot)?
                - item_amount(demand_now, "outputs", &item_id)
                - ledger
                    .in_flight
                    .get(&(demand_index, item_id.clone()))
                    .copied()
                    .unwrap_or(0.0)
                + EPSILON)
                .floor()
                .max(0.0);
            for (supply_index, peer_slot_index) in matches {
                if remaining_free < 1.0 {
                    break;
                }
                let supply_snapshot = entities[supply_index]
                    .as_object()
                    .expect("station object")
                    .clone();
                let supply_slot = slots(&supply_snapshot)?[peer_slot_index].clone();
                for (owner_index, owner_slot) in [
                    (demand_index, slot.clone()),
                    (supply_index, supply_slot.clone()),
                ] {
                    let owner = entities[owner_index].as_object().expect("station object");
                    let free_vehicles = (installed_drones(owner)
                        - ledger.busy.get(&owner_index).copied().unwrap_or(0.0))
                    .max(0.0);
                    if free_vehicles < 1.0
                        || powers.get(&owner_index).copied().unwrap_or(0.0) <= EPSILON
                    {
                        continue;
                    }
                    let available = (item_amount(&supply_snapshot, "outputs", &item_id)
                        - supply_slot.min_stock
                        - ledger
                            .reserved
                            .get(&(supply_index, item_id.clone()))
                            .copied()
                            .unwrap_or(0.0)
                        + EPSILON)
                        .floor()
                        .max(0.0);
                    let minimum = minimum_cargo(base, &owner_slot);
                    let dispatchable = free_vehicles
                        .min((available / minimum).floor())
                        .min((remaining_free / minimum).floor());
                    if dispatchable < 1.0 {
                        continue;
                    }
                    let cargo = available
                        .min(remaining_free)
                        .min(cargo_capacity(base) * dispatchable);
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
                    let demand_id = string_at(
                        entities[demand_index].as_object().expect("station object"),
                        "id",
                    )
                    .unwrap_or_default()
                    .to_owned();
                    let supply_id = string_at(&supply_snapshot, "id")
                        .unwrap_or_default()
                        .to_owned();
                    let owner_id = string_at(owner, "id").unwrap_or_default().to_owned();
                    let route = json!({
                        "id": format!("route_{}", next_id as u64),
                        "slotIndex": *slot_index,
                        "peerId": supply_id,
                        "itemId": item_id,
                        "scope": "local",
                        "cargo": cargo,
                        "vehicleCount": dispatchable,
                        "progress": initial_progress,
                        "duration": BASE_TRIP_SECONDS / logistics_speed(base),
                        "requiresWarp": false,
                        "waypointStationIds": [],
                        "distanceLy": 0,
                        "warpersPerVessel": 0,
                        "vehicleStationId": owner_id,
                    });
                    entities[demand_index]
                        .as_object_mut()
                        .and_then(|entity| entity.get_mut("stationRoutes"))
                        .and_then(Value::as_array_mut)
                        .ok_or_else(|| anyhow!("native local demand routes are missing"))?
                        .push(route);
                    *ledger.busy.entry(owner_index).or_default() += dispatchable;
                    *ledger
                        .reserved
                        .entry((supply_index, item_id.clone()))
                        .or_default() += cargo;
                    *ledger
                        .in_flight
                        .entry((demand_index, item_id.clone()))
                        .or_default() += cargo;
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
                        set_number(demand, "stationDispatchCursor", *slot_index as f64 + 1.0)?;
                        demand
                            .get_mut("stationLastSupplyPeerBySlot")
                            .and_then(Value::as_object_mut)
                            .ok_or_else(|| anyhow!("native local fairness record is missing"))?
                            .insert(fairness_key.clone(), Value::from(supply_id.clone()));
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
    entities: &mut [Value],
    seconds: f64,
    powers: &HashMap<usize, f64>,
) -> anyhow::Result<()> {
    let indexes = entity_index(entities);
    for demand_index in station_indices(entities) {
        let demand_snapshot = entities[demand_index]
            .as_object()
            .ok_or_else(|| anyhow!("native local demand is invalid"))?
            .clone();
        let routes = entities[demand_index]
            .as_object_mut()
            .and_then(|demand| demand.get_mut("stationRoutes"))
            .and_then(Value::as_array_mut)
            .map(std::mem::take)
            .ok_or_else(|| anyhow!("native local demand routes are missing"))?;
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
                .get(route_owner_id(&demand_snapshot, route))
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
                (supply_current - cargo).max(0.0).floor(),
            )?;
            for index in [demand_index, supply_index] {
                let station = entities[index].as_object_mut().expect("station object");
                let trips = finite_number(station.get("stationTrips"));
                set_number(station, "stationTrips", (trips + vehicles).floor())?;
                set_number(station, "stationLastTransfer", cargo)?;
            }
            completed_cargo += cargo;
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

pub(crate) fn update_congestion(entities: &mut [Value]) -> anyhow::Result<()> {
    let indexes = entity_index(entities);
    let ledger = build_ledger(entities, &indexes);
    let snapshots = entities.to_vec();
    for station_index in station_indices(&snapshots) {
        let station = snapshots[station_index]
            .as_object()
            .expect("station object");
        if !matches!(
            string_at(station, "buildingId"),
            Some("planetary_logistics_station" | "interstellar_logistics_station")
        ) {
            continue;
        }
        let station_slots = slots(station)?;
        let mut waiting = 0.0;
        for (slot_index, slot) in station_slots.iter().enumerate() {
            if slot.item_id.is_some()
                && slot.local_mode == "demand"
                && !peer_matches(&snapshots, station_index, slot_index)?.is_empty()
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
        let mut active_progress = 0.0_f64;
        for (demand_index, demand) in snapshots
            .iter()
            .enumerate()
            .filter_map(|(index, value)| value.as_object().map(|object| (index, object)))
        {
            for route in demand
                .get("stationRoutes")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_object)
            {
                if string_at(route, "scope") != Some("local") {
                    continue;
                }
                let supply = string_at(route, "peerId")
                    .and_then(|id| indexes.get(id))
                    .copied();
                let owner = indexes
                    .get(route_owner_id(demand, route))
                    .copied()
                    .unwrap_or(demand_index);
                if demand_index == station_index
                    || supply == Some(station_index)
                    || owner == station_index
                {
                    active_progress = active_progress.max(finite_number(route.get("progress")));
                }
            }
        }
        let target = entities[station_index]
            .as_object_mut()
            .expect("station object");
        set_number(target, "stationCongestion", rounded(congestion, 3))?;
        set_number(target, "stationProgress", active_progress)?;
    }
    Ok(())
}
