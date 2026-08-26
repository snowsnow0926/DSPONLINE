use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};

use anyhow::{anyhow, bail};
use serde_json::{Map, Number, Value, json};

use crate::catalog::PlanetDefinition;
use crate::state::CoreState;

const EPSILON: f64 = 0.0001;
const SLOT_COUNT: usize = 5;
const VESSELS_PER_BUILDING: f64 = 10.0;
const CARGO_PER_VESSEL: f64 = 100.0;
const BASE_TRIP_SECONDS: f64 = 30.0;
const WARPER_CAPACITY_PER_BUILDING: f64 = 50.0;
const DEFAULT_WARPER_TARGET: f64 = WARPER_CAPACITY_PER_BUILDING;

#[derive(Debug, Clone)]
struct Slot {
    item_id: Option<String>,
    remote_mode: String,
    minimum_load: f64,
    min_stock: f64,
    max_stock: f64,
    priority: usize,
    route_policy: String,
    warper_budget: usize,
}

#[derive(Debug, Clone)]
struct RouteEconomics {
    requires_warp: bool,
    duration: f64,
    distance_ly: f64,
    warpers_per_vessel: f64,
    waypoint_station_ids: Vec<String>,
}

#[derive(Debug, Clone)]
struct PlannedPath {
    station_indices: Vec<usize>,
    distance_ly: f64,
    duration: f64,
    max_leg_distance_ly: f64,
    score: f64,
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
            .ok_or_else(|| anyhow!("native interstellar logistics produced a non-finite number"))?,
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
        .ok_or_else(|| anyhow!("native interstellar inventory is missing"))?
        .insert(
            item_id.to_owned(),
            Number::from_f64(amount)
                .map(Value::Number)
                .ok_or_else(|| anyhow!("native interstellar inventory is non-finite"))?,
        );
    Ok(())
}

fn slots(entity: &Map<String, Value>) -> anyhow::Result<Vec<Slot>> {
    let values = entity
        .get("stationSlots")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("native interstellar slots are missing"))?;
    if values.len() != SLOT_COUNT {
        bail!("native interstellar slot count is invalid");
    }
    values
        .iter()
        .map(|value| {
            let slot = value
                .as_object()
                .ok_or_else(|| anyhow!("native interstellar slot is invalid"))?;
            let remote_mode = string_at(slot, "remoteMode").unwrap_or("storage");
            if !matches!(remote_mode, "supply" | "demand" | "storage") {
                bail!("native interstellar slot mode is invalid");
            }
            let minimum_load = finite_number(slot.get("minimumLoad"));
            if ![0.1, 0.25, 0.5, 1.0]
                .iter()
                .any(|value| (minimum_load - value).abs() <= f64::EPSILON)
            {
                bail!("native interstellar minimum load is invalid");
            }
            let route_policy = string_at(slot, "routePolicy").unwrap_or("relay-preferred");
            if !matches!(
                route_policy,
                "direct" | "relay-preferred" | "relay-required"
            ) {
                bail!("native interstellar route policy is invalid");
            }
            let warper_budget = finite_number(slot.get("warperBudget"))
                .floor()
                .clamp(1.0, 4.0) as usize;
            Ok(Slot {
                item_id: string_at(slot, "itemId").map(str::to_owned),
                remote_mode: remote_mode.to_owned(),
                minimum_load,
                min_stock: finite_number(slot.get("minStock")).floor().max(0.0),
                max_stock: finite_number(slot.get("maxStock")).floor().max(0.0),
                priority: slot
                    .get("priority")
                    .and_then(Value::as_u64)
                    .unwrap_or(1)
                    .min(2) as usize,
                route_policy: route_policy.to_owned(),
                warper_budget,
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

fn planet<'a>(state: &'a CoreState, entity: &Map<String, Value>) -> Option<&'a PlanetDefinition> {
    let planet_id = string_at(entity, "planetId")?;
    state
        .catalog
        .planets
        .iter()
        .find(|planet| planet.id == planet_id)
}

fn same_system(state: &CoreState, left: &Map<String, Value>, right: &Map<String, Value>) -> bool {
    planet(state, left)
        .zip(planet(state, right))
        .is_some_and(|(left, right)| left.system_id == right.system_id)
}

fn system_unlocked(base: &Map<String, Value>, system_id: &str) -> bool {
    base.get("exploration")
        .and_then(Value::as_object)
        .and_then(|exploration| exploration.get("unlockedSystemIds"))
        .and_then(Value::as_array)
        .is_some_and(|systems| {
            systems
                .iter()
                .any(|value| value.as_str() == Some(system_id))
        })
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

fn station_capacity(
    state: &CoreState,
    base: &Map<String, Value>,
    entity: &Map<String, Value>,
    slot: &Slot,
) -> anyhow::Result<f64> {
    let building = string_at(entity, "buildingId")
        .and_then(|id| state.catalog.buildings.get(id))
        .ok_or_else(|| anyhow!("native interstellar station building is missing"))?;
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

fn installed_vessels(entity: &Map<String, Value>) -> f64 {
    (VESSELS_PER_BUILDING * finite_number(entity.get("machineCount")).floor().max(0.0))
        .min(finite_number(entity.get("stationVessels")).floor().max(0.0))
}

fn vessel_capacity(entity: &Map<String, Value>) -> f64 {
    VESSELS_PER_BUILDING * finite_number(entity.get("machineCount")).floor().max(0.0)
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

fn traditional_remote_disabled(entity: &Map<String, Value>) -> bool {
    string_at(entity, "quantumMode") == Some("quantum")
        || entity
            .get("quantumTransition")
            .is_some_and(|value| !value.is_null())
}

pub(crate) fn refill_station_warpers(
    base: &mut Map<String, Value>,
    entities: &mut [Value],
) -> anyhow::Result<()> {
    if !completed_tech(base, "space_warp") {
        return Ok(());
    }

    let mut reserved_outgoing = HashMap::<String, f64>::new();
    for station in entities.iter().filter_map(Value::as_object) {
        let Some(routes) = station.get("stationRoutes").and_then(Value::as_array) else {
            continue;
        };
        for route in routes.iter().filter_map(Value::as_object) {
            if string_at(route, "itemId") != Some("space_warper") {
                continue;
            }
            let Some(source_id) = string_at(route, "peerId") else {
                continue;
            };
            *reserved_outgoing.entry(source_id.to_owned()).or_default() +=
                finite_number(route.get("cargo"));
        }
    }

    for entity in entities.iter_mut() {
        let Some(station) = entity.as_object_mut() else {
            continue;
        };
        if string_at(station, "buildingId") != Some("interstellar_logistics_station")
            || traditional_remote_disabled(station)
            || !station
                .get("stationWarperAutoRefill")
                .and_then(Value::as_bool)
                .unwrap_or(false)
        {
            continue;
        }

        let station_id = string_at(station, "id").unwrap_or_default().to_owned();
        let planet_id = string_at(station, "planetId")
            .ok_or_else(|| anyhow!("native warper refill station planet is missing"))?
            .to_owned();
        let loaded = finite_number(station.get("stationWarpers"))
            .floor()
            .max(0.0);
        let capacity = WARPER_CAPACITY_PER_BUILDING
            * finite_number(station.get("machineCount")).floor().max(0.0);
        if capacity < 1.0 {
            continue;
        }
        let target = station
            .get("stationWarperTarget")
            .and_then(Value::as_f64)
            .filter(|value| value.is_finite())
            .map(f64::floor)
            .unwrap_or(DEFAULT_WARPER_TARGET)
            .max(1.0)
            .min(capacity);
        let input_available = item_amount(station, "inputs", "space_warper")
            .floor()
            .max(0.0);
        let output_stored = item_amount(station, "outputs", "space_warper")
            .floor()
            .max(0.0);
        let output_reserved = reserved_outgoing
            .get(&station_id)
            .copied()
            .unwrap_or(0.0)
            .floor()
            .max(0.0)
            .min(output_stored);
        let output_available = (output_stored - output_reserved).max(0.0);
        let active_planet = base.get("activePlanetId").and_then(Value::as_str);
        let tray_available = (if active_planet == Some(planet_id.as_str()) {
            base.get("tray")
        } else {
            base.get("planetTrays")
                .and_then(Value::as_object)
                .and_then(|trays| trays.get(&planet_id))
        })
        .and_then(Value::as_object)
        .and_then(|tray| tray.get("space_warper"))
        .map(|value| finite_number(Some(value)).floor().max(0.0))
        .unwrap_or(0.0);

        let mut needed = (target - loaded).max(0.0);
        if needed < 1.0 {
            continue;
        }
        let from_input = needed.min(input_available);
        if from_input > 0.0 {
            set_item_amount(
                station,
                "inputs",
                "space_warper",
                input_available - from_input,
            )?;
            set_number(station, "stationWarpers", loaded + from_input)?;
            needed -= from_input;
        }
        let from_output = needed.min(output_available);
        if from_output > 0.0 {
            set_item_amount(
                station,
                "outputs",
                "space_warper",
                output_stored - from_output,
            )?;
            let current = finite_number(station.get("stationWarpers"))
                .floor()
                .max(0.0);
            set_number(station, "stationWarpers", current + from_output)?;
            needed -= from_output;
        }
        if needed < 1.0 {
            continue;
        }
        let from_tray = needed.min(tray_available);
        if from_tray > 0.0 {
            let tray = if active_planet == Some(planet_id.as_str()) {
                base.get_mut("tray").and_then(Value::as_object_mut)
            } else {
                base.get_mut("planetTrays")
                    .and_then(Value::as_object_mut)
                    .and_then(|trays| trays.get_mut(&planet_id))
                    .and_then(Value::as_object_mut)
            }
            .ok_or_else(|| anyhow!("native warper refill planet tray is missing"))?;
            tray.insert(
                "space_warper".to_owned(),
                Number::from_f64(tray_available - from_tray)
                    .map(Value::Number)
                    .ok_or_else(|| anyhow!("native warper refill tray value is non-finite"))?,
            );
            let current = finite_number(station.get("stationWarpers"))
                .floor()
                .max(0.0);
            set_number(station, "stationWarpers", current + from_tray)?;
        }
    }
    Ok(())
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
    (CARGO_PER_VESSEL * multiplier).round()
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

fn travel_multiplier(base: &Map<String, Value>, planet_id: &str) -> f64 {
    base.get("galaxy")
        .and_then(Value::as_object)
        .and_then(|galaxy| galaxy.get("profiles"))
        .and_then(Value::as_object)
        .and_then(|profiles| profiles.get(planet_id))
        .and_then(Value::as_object)
        .and_then(|profile| profile.get("travelTimeMultiplier"))
        .map(|value| finite_number(Some(value)))
        .filter(|value| *value > 0.0)
        .unwrap_or(1.0)
}

fn system_distance_ly(base: &Map<String, Value>, source_system: &str, target_system: &str) -> f64 {
    if source_system == target_system {
        return 0.0;
    }
    let profile = |system_id: &str, key: &str| {
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
    let dx = profile(source_system, "positionX") - profile(target_system, "positionX");
    let dy = profile(source_system, "positionY") - profile(target_system, "positionY");
    rounded(dx.hypot(dy).max(0.1), 4)
}

fn interstellar_leg(
    state: &CoreState,
    base: &Map<String, Value>,
    entities: &[Value],
    source_index: usize,
    target_index: usize,
) -> anyhow::Result<(f64, f64)> {
    let source = entities[source_index]
        .as_object()
        .ok_or_else(|| anyhow!("native interstellar leg source is invalid"))?;
    let target = entities[target_index]
        .as_object()
        .ok_or_else(|| anyhow!("native interstellar leg target is invalid"))?;
    let source_planet = planet(state, source)
        .ok_or_else(|| anyhow!("native interstellar leg source planet is missing"))?;
    let target_planet = planet(state, target)
        .ok_or_else(|| anyhow!("native interstellar leg target planet is missing"))?;
    let distance = system_distance_ly(base, &source_planet.system_id, &target_planet.system_id);
    let environment = (travel_multiplier(base, &source_planet.id)
        + travel_multiplier(base, &target_planet.id))
        / 2.0;
    let distance_factor = 0.75 + distance / 24.0;
    let long_leg_penalty = if distance > 12.0 {
        1.0 + (distance - 12.0) / 14.0
    } else {
        1.0
    };
    Ok((
        distance,
        12.0 / logistics_speed(base) * environment * distance_factor * long_leg_penalty,
    ))
}

fn collect_path_candidate(
    state: &CoreState,
    base: &Map<String, Value>,
    entities: &[Value],
    station_indices: Vec<usize>,
) -> anyhow::Result<PlannedPath> {
    let mut distance = 0.0;
    let mut duration = 0.0;
    let mut max_leg_distance = 0.0_f64;
    for leg in station_indices.windows(2) {
        let (leg_distance, leg_duration) = interstellar_leg(state, base, entities, leg[0], leg[1])?;
        distance += leg_distance;
        duration += leg_duration;
        max_leg_distance = max_leg_distance.max(leg_distance);
    }
    let priority_bonus = station_indices[1..station_indices.len() - 1]
        .iter()
        .map(|index| {
            entities[*index]
                .as_object()
                .map(|station| finite_number(station.get("stationHubPriority")))
                .unwrap_or(1.0)
                * 0.025
        })
        .sum::<f64>();
    Ok(PlannedPath {
        station_indices,
        distance_ly: distance,
        duration,
        max_leg_distance_ly: max_leg_distance,
        score: duration * (1.0 - priority_bonus).max(0.85),
    })
}

#[allow(clippy::too_many_arguments)]
fn visit_paths(
    state: &CoreState,
    base: &Map<String, Value>,
    entities: &[Value],
    target_index: usize,
    route_policy: &str,
    maximum_hops: usize,
    stations: &mut Vec<usize>,
    remaining_hubs: &[usize],
    candidates: &mut Vec<PlannedPath>,
) -> anyhow::Result<()> {
    let hops_used = stations.len() - 1;
    if hops_used >= maximum_hops {
        return Ok(());
    }
    let mut direct = stations.clone();
    direct.push(target_index);
    if route_policy != "relay-required" || direct.len() > 2 {
        candidates.push(collect_path_candidate(state, base, entities, direct)?);
    }
    if route_policy == "direct" || hops_used + 1 >= maximum_hops {
        return Ok(());
    }
    let current = *stations.last().expect("path source");
    for hub_index in remaining_hubs {
        let (distance, _) = interstellar_leg(state, base, entities, current, *hub_index)?;
        if distance > 18.0 {
            continue;
        }
        stations.push(*hub_index);
        let next_hubs = remaining_hubs
            .iter()
            .copied()
            .filter(|candidate| candidate != hub_index)
            .collect::<Vec<_>>();
        visit_paths(
            state,
            base,
            entities,
            target_index,
            route_policy,
            maximum_hops,
            stations,
            &next_hubs,
            candidates,
        )?;
        stations.pop();
    }
    Ok(())
}

fn plan_path(
    state: &CoreState,
    base: &Map<String, Value>,
    entities: &[Value],
    supply_index: usize,
    demand_index: usize,
    demand_slot: &Slot,
) -> anyhow::Result<Option<PlannedPath>> {
    let supply = entities[supply_index].as_object().expect("station object");
    let demand = entities[demand_index].as_object().expect("station object");
    let supply_system = &planet(state, supply)
        .ok_or_else(|| anyhow!("native interstellar supply planet is missing"))?
        .system_id;
    let demand_system = &planet(state, demand)
        .ok_or_else(|| anyhow!("native interstellar demand planet is missing"))?
        .system_id;
    let mut hub_by_system = HashMap::<String, usize>::new();
    for index in station_indices(entities) {
        if index == supply_index || index == demand_index {
            continue;
        }
        let station = entities[index].as_object().expect("station object");
        if string_at(station, "buildingId") != Some("interstellar_logistics_station")
            || !station
                .get("stationHubEnabled")
                .and_then(Value::as_bool)
                .unwrap_or(false)
        {
            continue;
        }
        let Some(system_id) = planet(state, station).map(|planet| planet.system_id.as_str()) else {
            continue;
        };
        if system_id == supply_system
            || system_id == demand_system
            || !system_unlocked(base, system_id)
        {
            continue;
        }
        let replace = hub_by_system.get(system_id).is_none_or(|previous_index| {
            let previous = entities[*previous_index]
                .as_object()
                .expect("station object");
            let priority = finite_number(station.get("stationHubPriority"));
            let previous_priority = finite_number(previous.get("stationHubPriority"));
            priority > previous_priority
                || (priority == previous_priority
                    && string_at(station, "id").unwrap_or_default()
                        < string_at(previous, "id").unwrap_or_default())
        });
        if replace {
            hub_by_system.insert(system_id.to_owned(), index);
        }
    }
    let mut hubs = hub_by_system.into_values().collect::<Vec<_>>();
    hubs.sort_by(|left, right| {
        let left = entities[*left].as_object().expect("station object");
        let right = entities[*right].as_object().expect("station object");
        string_at(left, "id")
            .unwrap_or_default()
            .cmp(string_at(right, "id").unwrap_or_default())
    });
    let mut candidates = Vec::new();
    visit_paths(
        state,
        base,
        entities,
        demand_index,
        &demand_slot.route_policy,
        demand_slot.warper_budget,
        &mut vec![supply_index],
        &hubs,
        &mut candidates,
    )?;
    candidates.sort_by(|left, right| {
        left.score
            .partial_cmp(&right.score)
            .unwrap_or(Ordering::Equal)
            .then_with(|| left.station_indices.len().cmp(&right.station_indices.len()))
            .then_with(|| {
                let ids = |path: &PlannedPath| {
                    path.station_indices
                        .iter()
                        .map(|index| {
                            entities[*index]
                                .as_object()
                                .and_then(|station| string_at(station, "id"))
                                .unwrap_or_default()
                        })
                        .collect::<Vec<_>>()
                        .join(":")
                };
                ids(left).cmp(&ids(right))
            })
    });
    Ok(candidates.into_iter().next())
}

fn route_economics(
    state: &CoreState,
    base: &Map<String, Value>,
    entities: &[Value],
    supply_index: usize,
    demand_index: usize,
    demand_slot: &Slot,
) -> anyhow::Result<Option<RouteEconomics>> {
    let supply = entities[supply_index].as_object().expect("station object");
    let demand = entities[demand_index].as_object().expect("station object");
    let supply_planet = planet(state, supply)
        .ok_or_else(|| anyhow!("native interstellar supply planet is missing"))?;
    let demand_planet = planet(state, demand)
        .ok_or_else(|| anyhow!("native interstellar demand planet is missing"))?;
    let environment = (travel_multiplier(base, &supply_planet.id)
        + travel_multiplier(base, &demand_planet.id))
        / 2.0;
    if supply_planet.system_id == demand_planet.system_id {
        let orbit_span = supply_planet
            .orbit_index
            .abs_diff(demand_planet.orbit_index)
            .max(1) as f64;
        return Ok(Some(RouteEconomics {
            requires_warp: false,
            duration: rounded(
                BASE_TRIP_SECONDS / logistics_speed(base) * environment * (0.9 + orbit_span * 0.1),
                2,
            ),
            distance_ly: 0.0,
            warpers_per_vessel: 0.0,
            waypoint_station_ids: Vec::new(),
        }));
    }
    let Some(path) = plan_path(
        state,
        base,
        entities,
        supply_index,
        demand_index,
        demand_slot,
    )?
    else {
        return Ok(None);
    };
    let waypoint_station_ids = path.station_indices[1..path.station_indices.len() - 1]
        .iter()
        .map(|index| {
            entities[*index]
                .as_object()
                .and_then(|station| string_at(station, "id"))
                .unwrap_or_default()
                .to_owned()
        })
        .collect::<Vec<_>>();
    let hop_count = path.station_indices.len() - 1;
    let _ = path.max_leg_distance_ly;
    Ok(Some(RouteEconomics {
        requires_warp: true,
        duration: rounded(path.duration, 2),
        distance_ly: rounded(path.distance_ly, 2),
        warpers_per_vessel: hop_count as f64,
        waypoint_station_ids,
    }))
}

fn route_owner_id<'a>(demand: &'a Map<String, Value>, route: &'a Map<String, Value>) -> &'a str {
    string_at(route, "vehicleStationId")
        .unwrap_or_else(|| string_at(demand, "id").unwrap_or_default())
}

fn orbital_slot(entity: &Map<String, Value>) -> Slot {
    Slot {
        item_id: string_at(entity, "storedItemId").map(str::to_owned),
        remote_mode: "supply".to_owned(),
        minimum_load: 1.0,
        min_stock: 0.0,
        max_stock: 0.0,
        priority: 1,
        route_policy: "relay-preferred".to_owned(),
        warper_budget: 2,
    }
}

fn orbital_yield(base: &Map<String, Value>, planet_id: &str, item_id: &str) -> f64 {
    base.get("galaxy")
        .and_then(Value::as_object)
        .and_then(|galaxy| galaxy.get("profiles"))
        .and_then(Value::as_object)
        .and_then(|profiles| profiles.get(planet_id))
        .and_then(Value::as_object)
        .and_then(|profile| profile.get("orbitalYields"))
        .and_then(Value::as_object)
        .and_then(|yields| yields.get(item_id))
        .map(|value| finite_number(Some(value)))
        .unwrap_or(0.0)
}

pub(crate) fn run_orbital_collectors(
    state: &CoreState,
    base: &mut Map<String, Value>,
    entities: &mut [Value],
    seconds: f64,
    output_credits: &HashMap<String, f64>,
) -> anyhow::Result<()> {
    let infinite_multiplier = 1.0
        + base
            .get("endgame")
            .and_then(Value::as_object)
            .and_then(|endgame| endgame.get("infiniteResearch"))
            .and_then(Value::as_object)
            .and_then(|research| research.get("vein_utilization"))
            .and_then(Value::as_object)
            .and_then(|progress| progress.get("level"))
            .map(|value| finite_number(Some(value)).floor().clamp(0.0, 1_000.0))
            .unwrap_or(0.0)
            * 0.1;
    for entity in entities.iter_mut().filter_map(Value::as_object_mut) {
        if string_at(entity, "buildingId") != Some("orbital_collector") {
            continue;
        }
        let planet_id = string_at(entity, "planetId").unwrap_or_default().to_owned();
        let item_id = string_at(entity, "storedItemId")
            .ok_or_else(|| anyhow!("native orbital collector item is missing"))?
            .to_owned();
        if orbital_yield(base, &planet_id, &item_id) <= 0.0 {
            bail!("native orbital collector item has no configured yield");
        }
        entity.insert("storedItemId".to_owned(), Value::from(item_id.clone()));
        entity.insert("stationMode".to_owned(), Value::from("supply"));
        let capacity = station_capacity(state, base, entity, &orbital_slot(entity))?;
        let incoming = (item_amount(entity, "inputs", &item_id) + EPSILON).floor();
        let stored = (item_amount(entity, "outputs", &item_id) + EPSILON).floor();
        let buffered = incoming.min((capacity - stored).max(0.0));
        set_item_amount(entity, "inputs", &item_id, incoming - buffered)?;
        let current = stored + buffered;
        set_item_amount(entity, "outputs", &item_id, current)?;
        let entity_id = string_at(entity, "id").unwrap_or_default();
        let credit = crate::belts::output_credit(output_credits, entity_id, &item_id);
        let free = (capacity - current).max(0.0) + credit;
        if free < 1.0 {
            set_number(entity, "progress", 0.0)?;
            continue;
        }
        let profile_multiplier = base
            .get("galaxy")
            .and_then(Value::as_object)
            .and_then(|galaxy| galaxy.get("profiles"))
            .and_then(Value::as_object)
            .and_then(|profiles| profiles.get(&planet_id))
            .and_then(Value::as_object)
            .and_then(|profile| profile.get("orbitalYieldMultiplier"))
            .map(|value| finite_number(Some(value)))
            .unwrap_or(1.0);
        let rate = orbital_yield(base, &planet_id, &item_id)
            * finite_number(entity.get("machineCount"))
            * profile_multiplier
            * infinite_multiplier;
        let progress = rounded(finite_number(entity.get("progress")) + rate * seconds, 6);
        let produced = free.min((progress + EPSILON).floor());
        set_item_amount(entity, "outputs", &item_id, current + produced)?;
        set_number(
            entity,
            "progress",
            if produced >= free {
                0.0
            } else {
                rounded(progress - produced, 6)
            },
        )?;
        set_number(entity, "utilization", 1.0)?;
        set_number(entity, "productionRate", rounded(rate * 60.0, 2))?;
        let total_produced = base
            .get_mut("totalProduced")
            .and_then(Value::as_object_mut)
            .ok_or_else(|| anyhow!("native total-produced record is missing"))?;
        let total = finite_number(total_produced.get(&item_id));
        set_number(total_produced, &item_id, (total + produced).floor())?;
    }
    Ok(())
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
            if scope == "remote" {
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
    state: &CoreState,
    base: &Map<String, Value>,
    entities: &[Value],
    station_index: usize,
    slot_index: usize,
) -> anyhow::Result<Vec<(usize, usize)>> {
    let station = entities[station_index]
        .as_object()
        .ok_or_else(|| anyhow!("native interstellar station is invalid"))?;
    if string_at(station, "buildingId") != Some("interstellar_logistics_station") {
        return Ok(Vec::new());
    }
    if traditional_remote_disabled(station) {
        return Ok(Vec::new());
    }
    let station_slots = slots(station)?;
    let slot = station_slots
        .get(slot_index)
        .ok_or_else(|| anyhow!("native interstellar slot index is invalid"))?;
    let Some(item_id) = slot.item_id.as_deref() else {
        return Ok(Vec::new());
    };
    if slot.remote_mode == "storage" {
        return Ok(Vec::new());
    }
    let opposite = if slot.remote_mode == "supply" {
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
        if traditional_remote_disabled(peer)
            || string_at(peer, "planetId") == planet_id
            || planet(state, peer).is_none_or(|planet| !system_unlocked(base, &planet.system_id))
        {
            continue;
        }
        if string_at(peer, "buildingId") == Some("orbital_collector") {
            if opposite == "supply" && string_at(peer, "storedItemId") == Some(item_id) {
                let (supply_index, demand_index, demand_slot) = (peer_index, station_index, slot);
                if route_economics(
                    state,
                    base,
                    entities,
                    supply_index,
                    demand_index,
                    demand_slot,
                )?
                .is_some()
                {
                    matches.push((peer_index, 0));
                }
            }
            continue;
        }
        if string_at(peer, "buildingId") != Some("interstellar_logistics_station") {
            continue;
        }
        for (peer_slot_index, peer_slot) in slots(peer)?.iter().enumerate() {
            if peer_slot.item_id.as_deref() == Some(item_id) && peer_slot.remote_mode == opposite {
                let (supply_index, demand_index, demand_slot) = if slot.remote_mode == "demand" {
                    (peer_index, station_index, slot)
                } else {
                    (station_index, peer_index, peer_slot)
                };
                if route_economics(
                    state,
                    base,
                    entities,
                    supply_index,
                    demand_index,
                    demand_slot,
                )?
                .is_some()
                {
                    matches.push((peer_index, peer_slot_index));
                }
            }
        }
    }
    matches.sort_by(|(left_index, left_slot), (right_index, right_slot)| {
        let left = entities[*left_index].as_object().expect("station object");
        let right = entities[*right_index].as_object().expect("station object");
        let left_priority = if string_at(left, "buildingId") == Some("orbital_collector") {
            1
        } else {
            slots(left)
                .ok()
                .and_then(|values| values.get(*left_slot).map(|slot| slot.priority))
                .unwrap_or(1)
        };
        let right_priority = if string_at(right, "buildingId") == Some("orbital_collector") {
            1
        } else {
            slots(right)
                .ok()
                .and_then(|values| values.get(*right_slot).map(|slot| slot.priority))
                .unwrap_or(1)
        };
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
                    if string_at(route, "scope") != Some("remote") {
                        return false;
                    }
                    let supply = string_at(route, "peerId")
                        .and_then(|id| indexes.get(id))
                        .copied();
                    let owner = indexes
                        .get(route_owner_id(demand, route))
                        .copied()
                        .unwrap_or(demand_index);
                    let waypoint = route
                        .get("waypointStationIds")
                        .and_then(Value::as_array)
                        .is_some_and(|ids| {
                            ids.iter()
                                .filter_map(Value::as_str)
                                .any(|id| indexes.get(id).copied() == Some(station_index))
                        });
                    demand_index == station_index
                        || supply == Some(station_index)
                        || owner == station_index
                        || waypoint
                })
            })
    })
}

pub(crate) fn admission_reason(state: &CoreState) -> anyhow::Result<Option<&'static str>> {
    let entities = (0..state.entity_index.len())
        .map(|index| state.parse_entity(index))
        .collect::<anyhow::Result<Vec<_>>>()?;
    let indexes = entity_index(&entities);
    let base = state.base_value();
    for station_index in station_indices(&entities) {
        let station = entities[station_index].as_object().expect("station object");
        match string_at(station, "buildingId") {
            Some("planetary_logistics_station") => continue,
            Some("interstellar_logistics_station") => {}
            Some("orbital_collector") => {
                let item_id = string_at(station, "storedItemId");
                let planet_id = string_at(station, "planetId").unwrap_or_default();
                if !matches!(
                    string_at(station, "quantumMode"),
                    None | Some("legacy" | "quantum" | "transitioning")
                ) || item_id.is_none_or(|id| {
                    !state.catalog.items.contains_key(id)
                        || orbital_yield(base, planet_id, id) <= 0.0
                }) || station
                    .get("stationRoutes")
                    .and_then(Value::as_array)
                    .is_some_and(|routes| !routes.is_empty())
                    || planet(state, station)
                        .is_none_or(|planet| !system_unlocked(base, &planet.system_id))
                {
                    return Ok(Some("orbital-collector-invalid"));
                }
                continue;
            }
            _ => return Ok(Some("interstellar-station-type-unsupported")),
        }
        if !matches!(
            string_at(station, "stationOperationMode"),
            None | Some("legacy")
        ) || station
            .get("stationModeTransition")
            .is_some_and(|value| !value.is_null())
            || !matches!(
                string_at(station, "quantumMode"),
                None | Some("legacy" | "quantum" | "transitioning")
            )
        {
            return Ok(Some("interstellar-station-mode-unsupported"));
        }
        let station_slots = match slots(station) {
            Ok(values) => values,
            Err(_) => return Ok(Some("interstellar-slots-invalid")),
        };
        if station_slots
            .iter()
            .filter_map(|slot| slot.item_id.as_deref())
            .any(|id| !state.catalog.items.contains_key(id))
        {
            return Ok(Some("interstellar-slot-item-invalid"));
        }
        let Some(routes) = station.get("stationRoutes").and_then(Value::as_array) else {
            return Ok(Some("interstellar-routes-invalid"));
        };
        for route_value in routes {
            let Some(route) = route_value.as_object() else {
                return Ok(Some("interstellar-route-invalid"));
            };
            if string_at(route, "scope") == Some("local") {
                continue;
            }
            let peer_index = string_at(route, "peerId")
                .and_then(|id| indexes.get(id))
                .copied();
            let owner_valid = indexes.contains_key(route_owner_id(station, route));
            let same_system_route = peer_index.and_then(|peer_index| {
                entities[peer_index]
                    .as_object()
                    .map(|peer| same_system(state, station, peer))
            });
            let expected_warp = same_system_route.map(|same| !same);
            let waypoints = route.get("waypointStationIds").and_then(Value::as_array);
            let waypoints_valid = waypoints.is_some_and(|ids| {
                ids.iter().all(|value| {
                    value
                        .as_str()
                        .and_then(|id| indexes.get(id))
                        .and_then(|index| entities[*index].as_object())
                        .is_some_and(|entity| {
                            string_at(entity, "buildingId")
                                == Some("interstellar_logistics_station")
                        })
                })
            });
            let expected_warpers = if expected_warp == Some(true) {
                waypoints.map(Vec::len).unwrap_or(0) as f64 + 1.0
            } else {
                0.0
            };
            if string_at(route, "scope") != Some("remote")
                || expected_warp.is_none()
                || !owner_valid
                || string_at(route, "itemId").is_none_or(|id| !state.catalog.items.contains_key(id))
                || route.get("requiresWarp").and_then(Value::as_bool) != expected_warp
                || !waypoints_valid
                || (finite_number(route.get("warpersPerVessel")) - expected_warpers).abs() > EPSILON
            {
                return Ok(Some("interstellar-route-invalid"));
            }
        }
        let planet = planet(state, station);
        if planet.is_none_or(|planet| !system_unlocked(base, &planet.system_id)) {
            return Ok(Some("interstellar-system-locked"));
        }
    }
    Ok(None)
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
        if string_at(station, "buildingId") != Some("interstellar_logistics_station") {
            continue;
        }
        if traditional_remote_disabled(station) {
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
            if slot.remote_mode == "storage" {
                continue;
            }
            for (peer_index, peer_slot_index) in
                peer_matches(state, base, entities, station_index, slot_index)?
            {
                let peer = entities[peer_index].as_object().expect("station object");
                let peer_slots = if string_at(peer, "buildingId") == Some("orbital_collector") {
                    vec![orbital_slot(peer)]
                } else {
                    slots(peer)?
                };
                let (demand_index, demand_slot, supply_index, supply_slot) =
                    if slot.remote_mode == "demand" {
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
                let Some(economics) = route_economics(
                    state,
                    base,
                    entities,
                    supply_index,
                    demand_index,
                    demand_slot,
                )?
                else {
                    continue;
                };
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
                    let has_vehicle = installed_vessels(owner)
                        - ledger.busy.get(&owner_index).copied().unwrap_or(0.0)
                        > 0.0;
                    let warp_ready = !economics.requires_warp
                        || (completed_tech(base, "space_warp")
                            && owner
                                .get("stationWarpEnabled")
                                .and_then(Value::as_bool)
                                .unwrap_or(false)
                            && finite_number(owner.get("stationWarpers"))
                                >= economics.warpers_per_vessel);
                    let minimum = minimum_cargo(base, owner_slot);
                    if has_vehicle && warp_ready && available >= minimum && free >= minimum {
                        ready.insert(station_index);
                        break 'slots;
                    }
                }
            }
        }
    }
    Ok(ready)
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
            .ok_or_else(|| anyhow!("native interstellar demand is invalid"))?
            .clone();
        if string_at(&demand_snapshot, "buildingId") != Some("interstellar_logistics_station") {
            continue;
        }
        if traditional_remote_disabled(&demand_snapshot) {
            continue;
        }
        let demand_slots = slots(&demand_snapshot)?;
        let mut ordered_slots = demand_slots
            .iter()
            .enumerate()
            .filter(|(_, slot)| slot.item_id.is_some() && slot.remote_mode == "demand")
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
            let fairness_key = format!("remote:{slot_index}");
            let last_peer_id = demand_snapshot
                .get("stationLastSupplyPeerBySlot")
                .and_then(Value::as_object)
                .and_then(|values| values.get(&fairness_key))
                .and_then(Value::as_str)
                .map(str::to_owned);
            let mut matches = peer_matches(state, base, entities, demand_index, *slot_index)?;
            matches.sort_by(|(left_index, left_slot), (right_index, right_slot)| {
                let left = entities[*left_index].as_object().expect("station object");
                let right = entities[*right_index].as_object().expect("station object");
                let left_priority = if string_at(left, "buildingId") == Some("orbital_collector") {
                    1
                } else {
                    slots(left)
                        .ok()
                        .and_then(|values| values.get(*left_slot).map(|slot| slot.priority))
                        .unwrap_or(1)
                };
                let right_priority = if string_at(right, "buildingId") == Some("orbital_collector")
                {
                    1
                } else {
                    slots(right)
                        .ok()
                        .and_then(|values| values.get(*right_slot).map(|slot| slot.priority))
                        .unwrap_or(1)
                };
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
                let supply_is_orbital =
                    string_at(&supply_snapshot, "buildingId") == Some("orbital_collector");
                let supply_slot = if supply_is_orbital {
                    orbital_slot(&supply_snapshot)
                } else {
                    slots(&supply_snapshot)?[peer_slot_index].clone()
                };
                let Some(economics) =
                    route_economics(state, base, entities, supply_index, demand_index, slot)?
                else {
                    continue;
                };
                if economics.requires_warp && !completed_tech(base, "space_warp") {
                    continue;
                }
                let source_power = if supply_is_orbital {
                    1.0
                } else {
                    powers.get(&supply_index).copied().unwrap_or(0.0)
                };
                let target_power = powers.get(&demand_index).copied().unwrap_or(0.0);
                let hub_power = economics
                    .waypoint_station_ids
                    .iter()
                    .filter_map(|id| indexes.get(id))
                    .fold(1.0_f64, |factor, index| {
                        factor.min(powers.get(index).copied().unwrap_or(0.0))
                    });
                let power_factor = source_power.min(target_power).min(hub_power);
                let mut vehicle_owners = vec![(demand_index, slot.clone())];
                if !supply_is_orbital {
                    vehicle_owners.push((supply_index, supply_slot.clone()));
                }
                for (owner_index, owner_slot) in vehicle_owners {
                    let owner = entities[owner_index].as_object().expect("station object");
                    let free_vehicles = (installed_vessels(owner)
                        - ledger.busy.get(&owner_index).copied().unwrap_or(0.0))
                    .max(0.0);
                    let warp_available =
                        finite_number(owner.get("stationWarpers")).floor().max(0.0);
                    if free_vehicles < 1.0
                        || power_factor <= EPSILON
                        || (economics.requires_warp
                            && (!owner
                                .get("stationWarpEnabled")
                                .and_then(Value::as_bool)
                                .unwrap_or(false)
                                || warp_available < economics.warpers_per_vessel))
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
                    let mut dispatchable = free_vehicles
                        .min((available / minimum).floor())
                        .min((remaining_free / minimum).floor());
                    if economics.requires_warp {
                        dispatchable = dispatchable
                            .min((warp_available / economics.warpers_per_vessel.max(1.0)).floor());
                    }
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
                        "scope": "remote",
                        "cargo": cargo,
                        "vehicleCount": dispatchable,
                        "progress": initial_progress,
                        "duration": economics.duration,
                        "requiresWarp": economics.requires_warp,
                        "waypointStationIds": economics.waypoint_station_ids.clone(),
                        "distanceLy": economics.distance_ly,
                        "warpersPerVessel": economics.warpers_per_vessel,
                        "vehicleStationId": owner_id,
                    });
                    entities[demand_index]
                        .as_object_mut()
                        .and_then(|entity| entity.get_mut("stationRoutes"))
                        .and_then(Value::as_array_mut)
                        .ok_or_else(|| anyhow!("native interstellar demand routes are missing"))?
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
                    for waypoint in &economics.waypoint_station_ids {
                        if let Some(index) = indexes.get(waypoint) {
                            *ledger.active_vehicle_load.entry(*index).or_default() += dispatchable;
                        }
                    }
                    remaining_free = (remaining_free - cargo).max(0.0);
                    set_number(base, "nextId", next_id + 1.0)?;
                    if economics.requires_warp {
                        let owner = entities[owner_index]
                            .as_object_mut()
                            .expect("station object");
                        set_number(
                            owner,
                            "stationWarpers",
                            warp_available - dispatchable * economics.warpers_per_vessel,
                        )?;
                    }
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
                            .ok_or_else(|| {
                                anyhow!("native interstellar fairness record is missing")
                            })?
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

fn add_max_field(
    entities: &mut [Value],
    index: usize,
    key: &str,
    value: f64,
) -> anyhow::Result<()> {
    let entity = entities[index]
        .as_object_mut()
        .ok_or_else(|| anyhow!("native interstellar station is invalid"))?;
    set_number(entity, key, finite_number(entity.get(key)).max(value))
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
            .ok_or_else(|| anyhow!("native interstellar demand is invalid"))?
            .clone();
        let has_remote_route = demand_snapshot
            .get("stationRoutes")
            .and_then(Value::as_array)
            .is_some_and(|routes| {
                routes
                    .iter()
                    .filter_map(Value::as_object)
                    .any(|route| string_at(route, "scope") == Some("remote"))
            });
        if !has_remote_route {
            continue;
        }
        let routes = entities[demand_index]
            .as_object_mut()
            .and_then(|demand| demand.get_mut("stationRoutes"))
            .and_then(Value::as_array_mut)
            .map(std::mem::take)
            .ok_or_else(|| anyhow!("native interstellar demand routes are missing"))?;
        let mut remaining = Vec::new();
        let mut completed_cargo = 0.0;
        for mut route_value in routes {
            let route = route_value
                .as_object_mut()
                .ok_or_else(|| anyhow!("native interstellar route is invalid"))?;
            if string_at(route, "scope") != Some("remote") {
                remaining.push(route_value);
                continue;
            }
            let supply_index = string_at(route, "peerId")
                .and_then(|id| indexes.get(id))
                .copied()
                .ok_or_else(|| anyhow!("native interstellar route peer is missing"))?;
            let waypoint_indices = route
                .get("waypointStationIds")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .filter_map(|id| indexes.get(id).copied())
                .collect::<Vec<_>>();
            let source_power = if entities[supply_index]
                .as_object()
                .is_some_and(|entity| string_at(entity, "buildingId") == Some("orbital_collector"))
            {
                1.0
            } else {
                powers.get(&supply_index).copied().unwrap_or(0.0)
            };
            let target_power = powers.get(&demand_index).copied().unwrap_or(0.0);
            let hub_power = waypoint_indices.iter().fold(1.0_f64, |factor, index| {
                factor.min(powers.get(index).copied().unwrap_or(0.0))
            });
            let power = source_power.min(target_power).min(hub_power);
            let duration = finite_number(route.get("duration")).max(1.0);
            let progress = rounded(
                finite_number(route.get("progress")) + seconds * power / duration,
                6,
            );
            set_number(route, "progress", progress)?;
            add_max_field(entities, demand_index, "utilization", power)?;
            add_max_field(entities, supply_index, "utilization", power)?;
            for waypoint_index in waypoint_indices {
                add_max_field(entities, waypoint_index, "utilization", power)?;
            }
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

fn local_peer_exists(
    entities: &[Value],
    station_index: usize,
    slot_index: usize,
) -> anyhow::Result<bool> {
    let station = entities[station_index].as_object().expect("station object");
    let station_slot = slots(station)?[slot_index].clone();
    let Some(item_id) = station_slot.item_id.as_deref() else {
        return Ok(false);
    };
    let local_mode = station
        .get("stationSlots")
        .and_then(Value::as_array)
        .and_then(|slots| slots.get(slot_index))
        .and_then(Value::as_object)
        .and_then(|slot| string_at(slot, "localMode"))
        .unwrap_or("storage");
    if local_mode != "demand" {
        return Ok(false);
    }
    for peer_index in station_indices(entities) {
        if peer_index == station_index {
            continue;
        }
        let peer = entities[peer_index].as_object().expect("station object");
        if string_at(peer, "planetId") != string_at(station, "planetId")
            || !matches!(
                string_at(peer, "buildingId"),
                Some("planetary_logistics_station" | "interstellar_logistics_station")
            )
        {
            continue;
        }
        let peer_slots = peer
            .get("stationSlots")
            .and_then(Value::as_array)
            .into_iter()
            .flatten();
        if peer_slots.filter_map(Value::as_object).any(|peer_slot| {
            string_at(peer_slot, "itemId") == Some(item_id)
                && string_at(peer_slot, "localMode") == Some("supply")
        }) {
            return Ok(true);
        }
    }
    Ok(false)
}

pub(crate) fn update_congestion(
    state: &CoreState,
    base: &Map<String, Value>,
    entities: &mut [Value],
) -> anyhow::Result<()> {
    let indexes = entity_index(entities);
    let ledger = build_ledger(entities, &indexes);
    let snapshots = entities.to_vec();
    for station_index in station_indices(&snapshots) {
        let station = snapshots[station_index]
            .as_object()
            .expect("station object");
        if string_at(station, "buildingId") != Some("interstellar_logistics_station") {
            continue;
        }
        if traditional_remote_disabled(station) {
            continue;
        }
        let station_slots = slots(station)?;
        let mut waiting = 0.0;
        for (slot_index, slot) in station_slots.iter().enumerate() {
            if slot.item_id.is_none() {
                continue;
            }
            let remote_waiting = slot.remote_mode == "demand"
                && !peer_matches(state, base, &snapshots, station_index, slot_index)?.is_empty();
            if remote_waiting || local_peer_exists(&snapshots, station_index, slot_index)? {
                waiting += 1.0;
            }
        }
        let installed = 50.0 * finite_number(station.get("machineCount")).floor().max(0.0)
            + vessel_capacity(station);
        let mut local_busy = 0.0;
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
                .filter(|route| string_at(route, "scope") == Some("local"))
            {
                let owner = indexes
                    .get(route_owner_id(demand, route))
                    .copied()
                    .unwrap_or(demand_index);
                if owner == station_index {
                    local_busy += finite_number(route.get("vehicleCount"));
                }
            }
        }
        let busy = local_busy + ledger.busy.get(&station_index).copied().unwrap_or(0.0);
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
                let supply = string_at(route, "peerId")
                    .and_then(|id| indexes.get(id))
                    .copied();
                let owner = indexes
                    .get(route_owner_id(demand, route))
                    .copied()
                    .unwrap_or(demand_index);
                let waypoint = route
                    .get("waypointStationIds")
                    .and_then(Value::as_array)
                    .is_some_and(|ids| {
                        ids.iter()
                            .filter_map(Value::as_str)
                            .any(|id| indexes.get(id).copied() == Some(station_index))
                    });
                if demand_index == station_index
                    || supply == Some(station_index)
                    || owner == station_index
                    || waypoint
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
