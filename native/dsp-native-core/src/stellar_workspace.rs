//! Bounded native read models for the shared star-map and stellar-industry UI.
//!
//! These projections deliberately expose only scalar identifiers, labels,
//! coordinates, counters, and small fixed-shape summaries. They never export
//! entity arrays, raw station slots/routes, or the public v47 state. Paging is
//! tied to an exact native revision and catalog fingerprint so the renderer
//! cannot accidentally combine rows from two authorities.

use std::cmp::Ordering;
use std::collections::{BTreeMap, HashMap, HashSet};

use anyhow::{anyhow, bail};
use serde_json::{Map, Value, json};

use crate::state::CoreState;

const STAR_MAP_SCHEMA: &str = "star-map-overview-v1";
const STAR_MAP_CATALOG_SCHEMA: &str = "star-map-catalog-v1";
const STELLAR_INDUSTRY_SCHEMA: &str = "stellar-industry-v1";
const STELLAR_INDUSTRY_V2_SCHEMA: &str = "stellar-industry-v2";
const STELLAR_QUANTUM_SCHEMA: &str = "stellar-quantum-v1";
const MAX_PAGE_ROWS: usize = 64;
const MAX_REQUEST_BYTES: usize = 32_768;
const MAX_PROJECTION_BYTES: usize = 1_048_576;
const MAX_LABEL_BYTES: usize = 512;
const MAX_CATALOG_NESTED_ROWS: usize = 64;
const MAX_CATALOG_TAG_ROWS: usize = 32;
const MAX_QUERY_BYTES: usize = 512;
const MAX_PATH_VISITS: usize = 200_000;
const MAX_QUANTUM_ITEM_ROWS: usize = 4_096;
const MAX_QUANTUM_COLLECTOR_ROWS: usize = 8_192;
const MAX_DECIMAL_DIGITS: usize = 256;
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;
const MAX_SAFE_INTEGER_U64: u64 = 9_007_199_254_740_991;
const QUANTUM_ITEM_CAPACITY_MIN: &str = "10000";
const QUANTUM_ITEM_CAPACITY_MAX: &str = "10000000000";
const QUANTUM_UNIT_CAP_PER_MINUTE: f64 = 5_000.0;
const STATION_SLOT_COUNT: usize = 5;
const DRONES_PER_BUILDING: f64 = 50.0;
const VESSELS_PER_BUILDING: f64 = 10.0;
const CARGO_PER_DRONE: f64 = 25.0;
const CARGO_PER_VESSEL: f64 = 100.0;
const PLANETARY_TRIP_SECONDS: f64 = 8.0;
const INTERSTELLAR_TRIP_SECONDS: f64 = 30.0;
const WARP_TRIP_SECONDS: f64 = 12.0;
const LONG_WARP_LEG_LY: f64 = 12.0;

#[derive(Debug, Default, Clone)]
struct PlanetLogisticsSummary {
    station_count: usize,
    interstellar_station_count: usize,
    orbital_collector_count: usize,
    legacy_station_count: usize,
    quantum_station_count: usize,
    quantum_attachable_count: usize,
    configured_import_slots: usize,
    configured_export_slots: usize,
    route_count: usize,
    active_route_count: usize,
    congested_station_id: Option<String>,
}

#[derive(Debug)]
struct StationScan {
    by_planet: Vec<PlanetLogisticsSummary>,
    total_matching: usize,
    rows: Vec<Value>,
}

#[derive(Debug)]
struct SystemDirectoryEntry<'a> {
    system_id: &'a str,
    planet_indices: Vec<usize>,
    first_simulation_order: u16,
}

#[derive(Debug, Clone)]
struct RouteSlot {
    item_id: Option<String>,
    local_mode: String,
    remote_mode: String,
    minimum_load: f64,
    min_stock: f64,
    max_stock: f64,
    priority: usize,
    route_policy: String,
    warper_budget: usize,
}

impl Default for RouteSlot {
    fn default() -> Self {
        Self {
            item_id: None,
            local_mode: "storage".to_owned(),
            remote_mode: "storage".to_owned(),
            minimum_load: 1.0,
            min_stock: 0.0,
            max_stock: 0.0,
            priority: 1,
            route_policy: "relay-preferred".to_owned(),
            warper_budget: 2,
        }
    }
}

#[derive(Debug, Clone)]
struct StoredStationRoute {
    scope: String,
    slot_index: usize,
    peer_id: String,
    item_id: String,
    vehicle_count: f64,
    cargo: f64,
    owner_id: String,
}

#[derive(Debug)]
struct RouteStation {
    id: String,
    building_id: String,
    planet_index: usize,
    machine_count: f64,
    outputs: HashMap<String, f64>,
    slots: Vec<RouteSlot>,
    routes: Vec<StoredStationRoute>,
    stored_item_id: Option<String>,
    installed_drones: f64,
    installed_vessels: f64,
    available_warpers: f64,
    warp_enabled: bool,
    congestion: f64,
    explicit_power_factor: Option<f64>,
    power_grid_id: String,
    power_covered: bool,
    hub_enabled: bool,
    hub_priority: f64,
    quantum_remote_disabled: bool,
    elevator: bool,
}

#[derive(Debug, Clone)]
struct RoutePeer {
    station_index: usize,
    slot_index: usize,
    slot: RouteSlot,
}

#[derive(Debug, Clone)]
struct PlannedRoutePath {
    station_indices: Vec<usize>,
    distance_ly: f64,
    duration_seconds: f64,
    max_leg_distance_ly: f64,
    score: f64,
}

#[derive(Debug, Clone)]
struct RouteEconomicsProjection {
    distance_ly: f64,
    orbit_span: usize,
    requires_warp: bool,
    duration_seconds: f64,
    cargo_per_trip: f64,
    throughput_per_minute: f64,
    warpers_per_trip: f64,
    power_kw: f64,
    energy_mj_per_trip: f64,
    route_available: bool,
    route_kind: &'static str,
    waypoint_station_indices: Vec<usize>,
    hop_count: usize,
    max_leg_distance_ly: f64,
    warpers_per_vessel: f64,
    route_planning_complete: bool,
}

#[derive(Debug)]
struct RouteSnapshotProjection {
    id: String,
    scope: &'static str,
    priority: usize,
    status: &'static str,
    row: Value,
    source_planet_index: Option<usize>,
    target_planet_index: usize,
}

#[derive(Debug, Default)]
struct QuantumCollectorScan {
    rows: Vec<Value>,
    total_count: usize,
    connected_count: usize,
    pending_count: usize,
    available_count: usize,
    connected_stacks: u64,
    active_tower_count: usize,
    active_tower_stacks: u64,
}

fn checked_add(target: &mut usize, amount: usize, label: &'static str) -> anyhow::Result<()> {
    *target = target
        .checked_add(amount)
        .ok_or_else(|| anyhow!("native stellar {label} overflow"))?;
    Ok(())
}

fn bounded_label(candidate: Option<&str>, fallback: &str) -> (String, bool) {
    let source = candidate
        .filter(|value| !value.is_empty() && !value.chars().any(char::is_control))
        .unwrap_or(fallback);
    if source.len() <= MAX_LABEL_BYTES {
        return (source.to_owned(), false);
    }
    let mut output = String::with_capacity(MAX_LABEL_BYTES);
    for character in source.chars() {
        if output.len() + character.len_utf8() > MAX_LABEL_BYTES {
            break;
        }
        output.push(character);
    }
    (output, true)
}

fn finite_number(value: Option<&Value>) -> f64 {
    value
        .and_then(Value::as_f64)
        .filter(|number| number.is_finite())
        .unwrap_or(0.0)
}

fn non_negative_number(value: Option<&Value>) -> f64 {
    finite_number(value).max(0.0)
}

fn non_negative_integer(value: Option<&Value>) -> f64 {
    non_negative_number(value).floor()
}

fn unit_number_or(value: Option<&Value>, fallback: f64) -> f64 {
    value
        .and_then(Value::as_f64)
        .filter(|number| number.is_finite())
        .unwrap_or(fallback)
        .clamp(0.0, 1.0)
}

fn bounded_token(value: Option<&Value>) -> Option<&str> {
    value
        .and_then(Value::as_str)
        .filter(|value| value.len() <= 64 && !value.chars().any(char::is_control))
}

fn bounded_catalog_item_ids(
    state: &CoreState,
    value: Option<&Value>,
    label: &'static str,
) -> anyhow::Result<Value> {
    let values = match value {
        Some(Value::Array(values)) => values,
        Some(Value::Null) | None => {
            return Ok(json!({
                "totalCount": 0,
                "truncated": false,
                "rows": [],
            }));
        }
        Some(_) => bail!("native star-map catalog {label} is invalid"),
    };
    let mut seen = HashSet::with_capacity(values.len().min(MAX_CATALOG_NESTED_ROWS));
    let mut rows = Vec::with_capacity(values.len().min(MAX_CATALOG_NESTED_ROWS));
    for value in values {
        let item_id = value
            .as_str()
            .filter(|item_id| state.catalog.items.contains_key(*item_id))
            .ok_or_else(|| anyhow!("native star-map catalog {label} contains an unknown item"))?;
        if !seen.insert(item_id) {
            bail!("native star-map catalog {label} contains a duplicate item");
        }
        if rows.len() < MAX_CATALOG_NESTED_ROWS {
            rows.push(item_id);
        }
    }
    Ok(json!({
        "totalCount": values.len(),
        "truncated": values.len() > rows.len(),
        "rows": rows,
    }))
}

fn bounded_catalog_orbital_yields(
    state: &CoreState,
    value: Option<&Value>,
    fallback: &HashMap<String, f64>,
) -> anyhow::Result<Value> {
    let mut entries = match value {
        Some(Value::Object(values)) => values
            .iter()
            .map(|(item_id, rate)| {
                if !state.catalog.items.contains_key(item_id) {
                    bail!("native star-map catalog orbital yield contains an unknown item");
                }
                let rate = rate
                    .as_f64()
                    .filter(|rate| rate.is_finite() && *rate >= 0.0)
                    .ok_or_else(|| anyhow!("native star-map catalog orbital yield is invalid"))?;
                Ok((item_id.as_str(), rate))
            })
            .collect::<anyhow::Result<Vec<_>>>()?,
        Some(Value::Null) | None => fallback
            .iter()
            .map(|(item_id, rate)| {
                if !state.catalog.items.contains_key(item_id) || !rate.is_finite() || *rate < 0.0 {
                    bail!("native star-map catalog fallback orbital yield is invalid");
                }
                Ok((item_id.as_str(), *rate))
            })
            .collect::<anyhow::Result<Vec<_>>>()?,
        Some(_) => bail!("native star-map catalog orbital yields are invalid"),
    };
    entries.sort_unstable_by(|left, right| left.0.cmp(right.0));
    let total_count = entries.len();
    let rows = entries
        .into_iter()
        .take(MAX_CATALOG_NESTED_ROWS)
        .map(|(item_id, rate)| json!({ "itemId": item_id, "rate": rate }))
        .collect::<Vec<_>>();
    Ok(json!({
        "totalCount": total_count,
        "truncated": total_count > rows.len(),
        "rows": rows,
    }))
}

fn bounded_catalog_metadata(base: &Map<String, Value>, planet_id: &str) -> anyhow::Result<Value> {
    let metadata = nested_object(object_at(base, "galaxy"), "planetMetadata")
        .and_then(|directory| directory.get(planet_id))
        .and_then(Value::as_object);
    let (note, note_truncated) = bounded_label(
        metadata
            .and_then(|value| value.get("note"))
            .and_then(Value::as_str),
        "",
    );
    let tags = match metadata.and_then(|value| value.get("tags")) {
        Some(Value::Array(tags)) => tags,
        Some(Value::Null) | None => {
            return Ok(json!({
                "note": note,
                "noteTruncated": note_truncated,
                "tagTextTruncated": false,
                "tags": { "totalCount": 0, "truncated": false, "rows": [] },
            }));
        }
        Some(_) => bail!("native star-map catalog metadata tags are invalid"),
    };
    let mut seen = HashSet::with_capacity(tags.len().min(MAX_CATALOG_TAG_ROWS));
    let mut rows = Vec::with_capacity(tags.len().min(MAX_CATALOG_TAG_ROWS));
    let mut tag_text_truncated = false;
    for tag in tags {
        let tag = tag
            .as_str()
            .filter(|tag| !tag.is_empty() && !tag.chars().any(char::is_control))
            .ok_or_else(|| anyhow!("native star-map catalog metadata tag is invalid"))?;
        if !seen.insert(tag) {
            bail!("native star-map catalog metadata contains a duplicate tag");
        }
        if rows.len() < MAX_CATALOG_TAG_ROWS {
            let (bounded, truncated) = bounded_label(Some(tag), "");
            tag_text_truncated |= truncated;
            rows.push(bounded);
        }
    }
    Ok(json!({
        "note": note,
        "noteTruncated": note_truncated,
        "tagTextTruncated": tag_text_truncated,
        "tags": {
            "totalCount": tags.len(),
            "truncated": tags.len() > rows.len(),
            "rows": rows,
        },
    }))
}

fn object_at<'a>(base: &'a Map<String, Value>, key: &str) -> Option<&'a Map<String, Value>> {
    base.get(key).and_then(Value::as_object)
}

fn nested_object<'a>(
    object: Option<&'a Map<String, Value>>,
    key: &str,
) -> Option<&'a Map<String, Value>> {
    object?.get(key).and_then(Value::as_object)
}

fn system_profile<'a>(
    base: &'a Map<String, Value>,
    system_id: &str,
) -> Option<&'a Map<String, Value>> {
    nested_object(object_at(base, "galaxy"), "systemProfiles")?
        .get(system_id)
        .and_then(Value::as_object)
}

fn planet_profile<'a>(
    base: &'a Map<String, Value>,
    planet_id: &str,
) -> Option<&'a Map<String, Value>> {
    nested_object(object_at(base, "galaxy"), "profiles")?
        .get(planet_id)
        .and_then(Value::as_object)
}

fn planet_metrics<'a>(
    base: &'a Map<String, Value>,
    planet_id: &str,
) -> Option<&'a Map<String, Value>> {
    object_at(base, "planetMetrics")?
        .get(planet_id)
        .and_then(Value::as_object)
}

fn custom_label<'a>(
    base: &'a Map<String, Value>,
    directory_key: &str,
    id: &str,
) -> Option<&'a str> {
    nested_object(object_at(base, "galaxy"), directory_key)?
        .get(id)
        .and_then(Value::as_object)
        .and_then(|metadata| metadata.get("customName"))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
}

fn planet_label(state: &CoreState, planet_index: usize) -> (String, bool) {
    let planet = &state.catalog.planets[planet_index];
    let fallback = if planet.name.is_empty() {
        planet.id.as_str()
    } else {
        planet.name.as_str()
    };
    bounded_label(
        custom_label(state.base_value(), "planetMetadata", &planet.id),
        fallback,
    )
}

fn system_label(state: &CoreState, system_id: &str) -> (String, bool) {
    bounded_label(
        custom_label(state.base_value(), "systemMetadata", system_id),
        system_id,
    )
}

fn known_members(value: Option<&Value>) -> HashSet<&str> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flat_map(|values| values.iter())
        .filter_map(Value::as_str)
        .collect()
}

fn system_directory(state: &CoreState) -> Vec<SystemDirectoryEntry<'_>> {
    let mut grouped = BTreeMap::<&str, Vec<usize>>::new();
    for (planet_index, planet) in state.catalog.planets.iter().enumerate() {
        grouped
            .entry(planet.system_id.as_str())
            .or_default()
            .push(planet_index);
    }
    let mut entries = grouped
        .into_iter()
        .map(|(system_id, mut planet_indices)| {
            planet_indices.sort_unstable_by(|left, right| {
                state.catalog.planets[*left]
                    .simulation_order
                    .cmp(&state.catalog.planets[*right].simulation_order)
                    .then_with(|| {
                        state.catalog.planets[*left]
                            .id
                            .cmp(&state.catalog.planets[*right].id)
                    })
            });
            SystemDirectoryEntry {
                system_id,
                first_simulation_order: planet_indices.first().map_or(u16::MAX, |index| {
                    state.catalog.planets[*index].simulation_order
                }),
                planet_indices,
            }
        })
        .collect::<Vec<_>>();
    entries.sort_unstable_by(|left, right| {
        left.first_simulation_order
            .cmp(&right.first_simulation_order)
            .then_with(|| left.system_id.cmp(right.system_id))
    });
    entries
}

fn validate_page(cursor: usize, limit: usize) -> anyhow::Result<()> {
    if !(1..=MAX_PAGE_ROWS).contains(&limit) {
        bail!("native stellar projection page limit is invalid");
    }
    if cursor > u32::MAX as usize {
        bail!("native stellar projection cursor is invalid");
    }
    Ok(())
}

fn validate_identity(
    state: &CoreState,
    expected_revision: u64,
    expected_registry_fingerprint: &str,
) -> anyhow::Result<()> {
    if expected_revision != state.revision
        || expected_registry_fingerprint != state.catalog.snapshot.registry_fingerprint
    {
        bail!("native stellar projection identity is stale");
    }
    Ok(())
}

fn validate_request(request: &Value) -> anyhow::Result<()> {
    if serde_json::to_vec(request)?.len() > MAX_REQUEST_BYTES {
        bail!("native stellar projection request exceeds the byte limit");
    }
    Ok(())
}

fn finish_projection(value: Value) -> anyhow::Result<Value> {
    if serde_json::to_vec(&value)?.len() > MAX_PROJECTION_BYTES {
        bail!("native stellar projection exceeds the byte limit");
    }
    Ok(value)
}

fn next_cursor(
    cursor: usize,
    row_count: usize,
    total_count: usize,
) -> anyhow::Result<Option<usize>> {
    let consumed = cursor
        .checked_add(row_count)
        .ok_or_else(|| anyhow!("native stellar projection cursor overflow"))?;
    Ok((consumed < total_count).then_some(consumed))
}

fn rounded(value: f64, digits: i32) -> f64 {
    let scale = 10_f64.powi(digits);
    (value * scale).round() / scale
}

fn route_filter_is_valid(route_filter: &str) -> bool {
    matches!(route_filter, "all" | "remote" | "issues")
}

fn validate_route_query(query: &str) -> anyhow::Result<()> {
    if query.len() > MAX_QUERY_BYTES || query.chars().any(char::is_control) {
        bail!("native stellar route query is invalid");
    }
    Ok(())
}

fn normalized_route_slot(state: &CoreState, value: &Value) -> anyhow::Result<RouteSlot> {
    let object = value
        .as_object()
        .ok_or_else(|| anyhow!("native stellar route slot is invalid"))?;
    let mode = |key: &str| match object.get(key).and_then(Value::as_str) {
        Some(value @ ("supply" | "demand" | "storage")) => value.to_owned(),
        _ => "storage".to_owned(),
    };
    let minimum_load = finite_number(object.get("minimumLoad"));
    let minimum_load = [0.1, 0.25, 0.5, 1.0]
        .into_iter()
        .find(|candidate| (minimum_load - candidate).abs() <= f64::EPSILON)
        .unwrap_or(1.0);
    let route_policy = object
        .get("routePolicy")
        .and_then(Value::as_str)
        .filter(|value| matches!(*value, "direct" | "relay-preferred" | "relay-required"))
        .unwrap_or("relay-preferred");
    let item_id = object
        .get("itemId")
        .and_then(Value::as_str)
        .filter(|item_id| state.catalog.items.contains_key(*item_id))
        .map(str::to_owned);
    Ok(RouteSlot {
        item_id,
        local_mode: mode("localMode"),
        remote_mode: mode("remoteMode"),
        minimum_load,
        min_stock: non_negative_integer(object.get("minStock")),
        max_stock: non_negative_integer(object.get("maxStock")),
        priority: object
            .get("priority")
            .and_then(Value::as_u64)
            .filter(|priority| matches!(*priority, 0 | 2))
            .unwrap_or(1) as usize,
        route_policy: route_policy.to_owned(),
        warper_budget: object
            .get("warperBudget")
            .and_then(Value::as_f64)
            .filter(|value| value.is_finite())
            .map(f64::floor)
            .unwrap_or(2.0)
            .clamp(1.0, 4.0) as usize,
    })
}

fn normalized_route_slots(
    state: &CoreState,
    station: &Map<String, Value>,
    building_id: &str,
) -> anyhow::Result<Vec<RouteSlot>> {
    if building_id == "orbital_collector" {
        return Ok(Vec::new());
    }
    let mut slots = match station.get("stationSlots") {
        Some(Value::Array(values)) => values
            .iter()
            .take(STATION_SLOT_COUNT)
            .map(|value| normalized_route_slot(state, value))
            .collect::<anyhow::Result<Vec<_>>>()?,
        Some(Value::Null) | None => Vec::new(),
        Some(_) => bail!("native stellar station slots are invalid"),
    };
    if slots.is_empty()
        && let Some(item_id) = station
            .get("storedItemId")
            .and_then(Value::as_str)
            .filter(|item_id| state.catalog.items.contains_key(*item_id))
    {
        let legacy_mode = if station.get("stationMode").and_then(Value::as_str) == Some("demand") {
            "demand"
        } else {
            "supply"
        };
        let mut slot = RouteSlot {
            item_id: Some(item_id.to_owned()),
            ..RouteSlot::default()
        };
        if building_id == "planetary_logistics_station" {
            slot.local_mode = legacy_mode.to_owned();
        } else if building_id == "interstellar_logistics_station" {
            slot.remote_mode = legacy_mode.to_owned();
        }
        slots.push(slot);
    }
    slots.resize_with(STATION_SLOT_COUNT, RouteSlot::default);
    Ok(slots)
}

fn stored_station_routes(
    state: &CoreState,
    station: &Map<String, Value>,
    station_id: &str,
) -> anyhow::Result<Vec<StoredStationRoute>> {
    let routes = match station.get("stationRoutes") {
        Some(Value::Array(routes)) => routes,
        Some(Value::Null) | None => return Ok(Vec::new()),
        Some(_) => bail!("native stellar station routes are invalid"),
    };
    routes
        .iter()
        .map(|value| {
            let route = value
                .as_object()
                .ok_or_else(|| anyhow!("native stellar station route is invalid"))?;
            let scope = route
                .get("scope")
                .and_then(Value::as_str)
                .filter(|scope| matches!(*scope, "local" | "remote"))
                .ok_or_else(|| anyhow!("native stellar station route scope is invalid"))?;
            let slot_index = route
                .get("slotIndex")
                .and_then(Value::as_u64)
                .and_then(|index| usize::try_from(index).ok())
                .filter(|index| *index < STATION_SLOT_COUNT)
                .ok_or_else(|| anyhow!("native stellar station route slot is invalid"))?;
            let bounded_identifier = |key: &str| {
                route
                    .get(key)
                    .and_then(Value::as_str)
                    .filter(|value| {
                        !value.is_empty()
                            && value.len() <= MAX_LABEL_BYTES
                            && !value.chars().any(char::is_control)
                    })
                    .ok_or_else(|| anyhow!("native stellar station route {key} is invalid"))
            };
            let peer_id = bounded_identifier("peerId")?;
            let item_id = bounded_identifier("itemId")?;
            if !state.catalog.items.contains_key(item_id) {
                bail!("native stellar station route item is unknown");
            }
            let owner_id = route
                .get("vehicleStationId")
                .map(|_| bounded_identifier("vehicleStationId"))
                .transpose()?
                .unwrap_or(station_id);
            let non_negative_safe_integer = |key: &str| {
                route
                    .get(key)
                    .and_then(Value::as_f64)
                    .filter(|value| {
                        value.is_finite()
                            && *value >= 0.0
                            && value.floor() == *value
                            && *value <= 9_007_199_254_740_991.0
                    })
                    .ok_or_else(|| anyhow!("native stellar station route {key} is invalid"))
            };
            Ok(StoredStationRoute {
                scope: scope.to_owned(),
                slot_index,
                peer_id: peer_id.to_owned(),
                item_id: item_id.to_owned(),
                vehicle_count: non_negative_safe_integer("vehicleCount")?,
                cargo: non_negative_safe_integer("cargo")?,
                owner_id: owner_id.to_owned(),
            })
        })
        .collect()
}

fn load_route_stations(state: &CoreState) -> anyhow::Result<Vec<RouteStation>> {
    let powered_grids = state
        .factory_topology
        .power_source_indices
        .iter()
        .filter_map(|&entity_index| {
            Some((
                *state
                    .factory_topology
                    .entity_planet_indices
                    .get(entity_index)?,
                *state
                    .factory_topology
                    .entity_grid_indices
                    .get(entity_index)?,
            ))
        })
        .collect::<HashSet<_>>();
    state
        .factory_topology
        .station_indices
        .iter()
        .map(|&entity_index| {
            let value = state.parse_entity(entity_index)?;
            let station = value
                .as_object()
                .ok_or_else(|| anyhow!("native stellar route station is not an object"))?;
            let id = state.entities.ids[entity_index].to_owned();
            let planet_index = state
                .factory_topology
                .entity_planet_indices
                .get(entity_index)
                .copied()
                .ok_or_else(|| anyhow!("native stellar route station planet is missing"))?;
            if planet_index >= state.catalog.planets.len() {
                bail!("native stellar route station planet is invalid");
            }
            let grid_index = state
                .factory_topology
                .entity_grid_indices
                .get(entity_index)
                .copied()
                .unwrap_or(usize::MAX);
            let building_id = station
                .get("buildingId")
                .and_then(Value::as_str)
                .unwrap_or("station")
                .to_owned();
            let outputs = station
                .get("outputs")
                .and_then(Value::as_object)
                .into_iter()
                .flat_map(|values| values.iter())
                .filter_map(|(item_id, value)| {
                    value
                        .as_f64()
                        .filter(|amount| amount.is_finite())
                        .map(|amount| (item_id.to_owned(), amount.floor().max(0.0)))
                })
                .collect();
            let routes = stored_station_routes(state, station, &id)?;
            let slots = normalized_route_slots(state, station, &building_id)?;
            let explicit_power_factor = station
                .get("powerFactor")
                .and_then(Value::as_f64)
                .filter(|value| value.is_finite())
                .map(|value| value.clamp(0.0, 1.0));
            Ok(RouteStation {
                id,
                building_id: building_id.clone(),
                planet_index,
                machine_count: non_negative_integer(station.get("machineCount")),
                outputs,
                slots,
                routes,
                stored_item_id: station
                    .get("storedItemId")
                    .and_then(Value::as_str)
                    .filter(|item_id| state.catalog.items.contains_key(*item_id))
                    .map(str::to_owned),
                installed_drones: non_negative_integer(station.get("stationDrones")),
                installed_vessels: non_negative_integer(station.get("stationVessels")),
                available_warpers: non_negative_integer(station.get("stationWarpers")),
                warp_enabled: station
                    .get("stationWarpEnabled")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                congestion: non_negative_number(station.get("stationCongestion")).clamp(0.0, 1.0),
                explicit_power_factor,
                power_grid_id: station
                    .get("powerGridId")
                    .and_then(Value::as_str)
                    .unwrap_or("grid-a")
                    .to_owned(),
                power_covered: powered_grids.contains(&(planet_index, grid_index)),
                hub_enabled: station
                    .get("stationHubEnabled")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                hub_priority: station
                    .get("stationHubPriority")
                    .and_then(Value::as_f64)
                    .filter(|value| value.is_finite())
                    .unwrap_or(1.0),
                quantum_remote_disabled: station.get("quantumMode").and_then(Value::as_str)
                    == Some("quantum")
                    || station
                        .get("quantumTransition")
                        .is_some_and(|value| !value.is_null()),
                elevator: building_id == "interstellar_logistics_station"
                    && non_negative_integer(station.get("stationTier")) == 2.0
                    && station.get("stationOperationMode").and_then(Value::as_str)
                        == Some("elevator"),
            })
        })
        .collect()
}

fn completed_technology(base: &Map<String, Value>, technology_id: &str) -> bool {
    base.get("research")
        .and_then(Value::as_object)
        .and_then(|research| research.get("completedTechIds"))
        .and_then(Value::as_array)
        .is_some_and(|ids| {
            ids.iter()
                .any(|value| value.as_str() == Some(technology_id))
        })
}

fn galactic_logistics_level(base: &Map<String, Value>) -> f64 {
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

fn route_cargo_capacity(base: &Map<String, Value>, scope: &str) -> f64 {
    let multiplier =
        (1.0 + if completed_technology(base, "logistics_capacity_1") {
            0.5
        } else {
            0.0
        } + if completed_technology(base, "logistics_capacity_2") {
            0.5
        } else {
            0.0
        }) * (1.0 + galactic_logistics_level(base) * 0.05);
    let base_capacity = if scope == "local" {
        CARGO_PER_DRONE
    } else {
        CARGO_PER_VESSEL
    };
    (base_capacity * multiplier).round()
}

fn route_speed_multiplier(base: &Map<String, Value>) -> f64 {
    let research =
        1.0 + if completed_technology(base, "logistics_engine_1") {
            0.5
        } else {
            0.0
        } + if completed_technology(base, "logistics_engine_2") {
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
    research * (1.0 + galactic_logistics_level(base) * 0.05) * difficulty
}

fn route_travel_multiplier(base: &Map<String, Value>, planet_id: &str) -> f64 {
    planet_profile(base, planet_id)
        .and_then(|profile| profile.get("travelTimeMultiplier"))
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite() && *value > 0.0)
        .unwrap_or(1.0)
}

fn route_system_distance(
    base: &Map<String, Value>,
    source_system: &str,
    target_system: &str,
) -> f64 {
    if source_system == target_system {
        return 0.0;
    }
    let coordinate = |system_id: &str, key: &str| {
        system_profile(base, system_id)
            .and_then(|profile| profile.get(key))
            .and_then(Value::as_f64)
            .filter(|value| value.is_finite())
            .unwrap_or(0.0)
    };
    let dx = coordinate(source_system, "positionX") - coordinate(target_system, "positionX");
    let dy = coordinate(source_system, "positionY") - coordinate(target_system, "positionY");
    rounded(dx.hypot(dy).max(0.1), 4)
}

fn route_buffer_limit(base: &Map<String, Value>) -> f64 {
    base.get("settings")
        .and_then(Value::as_object)
        .and_then(|settings| settings.get("logisticsBufferLimit"))
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
        .unwrap_or(1_000_000.0)
        .floor()
        .clamp(1_000.0, 100_000_000.0)
}

fn route_station_capacity(
    state: &CoreState,
    base: &Map<String, Value>,
    station: &RouteStation,
    slot: &RouteSlot,
) -> anyhow::Result<f64> {
    let building = state
        .catalog
        .buildings
        .get(&station.building_id)
        .ok_or_else(|| anyhow!("native stellar route station building is missing"))?;
    let count = station.machine_count.floor().max(1.0);
    let limit = route_buffer_limit(base);
    let base_capacity = building.output_capacity.max(0.0).floor();
    let rated = if base_capacity == 0.0 {
        0.0
    } else if base_capacity > limit / count {
        limit
    } else {
        (base_capacity * count).min(limit)
    };
    Ok(if slot.max_stock > 0.0 {
        rated.min(slot.max_stock)
    } else {
        rated
    })
}

fn route_station_power_factor(state: &CoreState, station: &RouteStation) -> (f64, bool) {
    if station.building_id == "orbital_collector" {
        return (1.0, true);
    }
    // Match getEntityPowerFactor(): a persisted factor is meaningful only
    // when the station's exact planet/grid has a power source. The compact
    // topology proves coverage without scanning every entity for every row.
    if !station.power_covered {
        return (0.0, true);
    }
    if let Some(value) = station.explicit_power_factor {
        return (value, true);
    }
    let planet_id = &state.catalog.planets[station.planet_index].id;
    let metric = state
        .base_value()
        .get("powerGridMetrics")
        .and_then(Value::as_object)
        .and_then(|planets| planets.get(planet_id))
        .and_then(Value::as_object)
        .and_then(|grids| grids.get(&station.power_grid_id))
        .and_then(Value::as_object)
        .and_then(|grid| grid.get("powerFactor"))
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite());
    metric.map_or((0.0, false), |value| (value.clamp(0.0, 1.0), true))
}

fn station_building_power_kw(state: &CoreState, station: &RouteStation) -> anyhow::Result<f64> {
    let building = state
        .catalog
        .buildings
        .get(&station.building_id)
        .ok_or_else(|| anyhow!("native stellar route building power is missing"))?;
    Ok(building.power_demand_kw.max(0.0) * station.machine_count.max(1.0))
}

fn route_system_unlocked(base: &Map<String, Value>, system_id: &str) -> bool {
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

fn route_leg(
    state: &CoreState,
    base: &Map<String, Value>,
    stations: &[RouteStation],
    source_index: usize,
    target_index: usize,
) -> (f64, f64) {
    let source_planet = &state.catalog.planets[stations[source_index].planet_index];
    let target_planet = &state.catalog.planets[stations[target_index].planet_index];
    let distance = route_system_distance(base, &source_planet.system_id, &target_planet.system_id);
    let environment = (route_travel_multiplier(base, &source_planet.id)
        + route_travel_multiplier(base, &target_planet.id))
        / 2.0;
    let distance_factor = 0.75 + distance / 24.0;
    let long_leg_penalty = if distance > LONG_WARP_LEG_LY {
        1.0 + (distance - LONG_WARP_LEG_LY) / 14.0
    } else {
        1.0
    };
    (
        distance,
        WARP_TRIP_SECONDS / route_speed_multiplier(base)
            * environment
            * distance_factor
            * long_leg_penalty,
    )
}

fn collect_route_path(
    state: &CoreState,
    base: &Map<String, Value>,
    stations: &[RouteStation],
    station_indices: Vec<usize>,
) -> PlannedRoutePath {
    let mut distance_ly = 0.0;
    let mut duration_seconds = 0.0;
    let mut max_leg_distance_ly = 0.0_f64;
    for leg in station_indices.windows(2) {
        let (distance, duration) = route_leg(state, base, stations, leg[0], leg[1]);
        distance_ly += distance;
        duration_seconds += duration;
        max_leg_distance_ly = max_leg_distance_ly.max(distance);
    }
    let priority_bonus = station_indices[1..station_indices.len() - 1]
        .iter()
        .map(|index| stations[*index].hub_priority * 0.025)
        .sum::<f64>();
    PlannedRoutePath {
        station_indices,
        distance_ly,
        duration_seconds,
        max_leg_distance_ly,
        score: duration_seconds * (1.0 - priority_bonus).max(0.85),
    }
}

fn compare_route_paths(
    left: &PlannedRoutePath,
    right: &PlannedRoutePath,
    stations: &[RouteStation],
) -> Ordering {
    left.score
        .partial_cmp(&right.score)
        .unwrap_or(Ordering::Equal)
        .then_with(|| left.station_indices.len().cmp(&right.station_indices.len()))
        .then_with(|| {
            let ids = |path: &PlannedRoutePath| {
                path.station_indices
                    .iter()
                    .map(|index| stations[*index].id.as_str())
                    .collect::<Vec<_>>()
                    .join(":")
            };
            ids(left).cmp(&ids(right))
        })
}

#[allow(clippy::too_many_arguments)]
fn visit_route_paths(
    state: &CoreState,
    base: &Map<String, Value>,
    stations: &[RouteStation],
    target_index: usize,
    route_policy: &str,
    maximum_hops: usize,
    path: &mut Vec<usize>,
    remaining_hubs: &[usize],
    best: &mut Option<PlannedRoutePath>,
    visits: &mut usize,
) -> bool {
    if *visits >= MAX_PATH_VISITS {
        return false;
    }
    *visits += 1;
    let hops_used = path.len() - 1;
    if hops_used >= maximum_hops {
        return true;
    }
    let mut direct = path.clone();
    direct.push(target_index);
    if route_policy != "relay-required" || direct.len() > 2 {
        let candidate = collect_route_path(state, base, stations, direct);
        if best
            .as_ref()
            .is_none_or(|current| compare_route_paths(&candidate, current, stations).is_lt())
        {
            *best = Some(candidate);
        }
    }
    if route_policy == "direct" || hops_used + 1 >= maximum_hops {
        return true;
    }
    let Some(&current) = path.last() else {
        return false;
    };
    for hub_index in remaining_hubs {
        let (distance, _) = route_leg(state, base, stations, current, *hub_index);
        if distance > LONG_WARP_LEG_LY * 1.5 {
            continue;
        }
        path.push(*hub_index);
        let next_hubs = remaining_hubs
            .iter()
            .copied()
            .filter(|candidate| candidate != hub_index)
            .collect::<Vec<_>>();
        if !visit_route_paths(
            state,
            base,
            stations,
            target_index,
            route_policy,
            maximum_hops,
            path,
            &next_hubs,
            best,
            visits,
        ) {
            path.pop();
            return false;
        }
        path.pop();
    }
    true
}

fn route_hub_representatives(
    state: &CoreState,
    base: &Map<String, Value>,
    stations: &[RouteStation],
) -> Vec<usize> {
    let mut by_system = BTreeMap::<&str, usize>::new();
    for (station_index, station) in stations.iter().enumerate() {
        if station.building_id != "interstellar_logistics_station" || !station.hub_enabled {
            continue;
        }
        let system_id = state.catalog.planets[station.planet_index]
            .system_id
            .as_str();
        if !route_system_unlocked(base, system_id) {
            continue;
        }
        let replace = by_system.get(system_id).is_none_or(|previous_index| {
            let previous = &stations[*previous_index];
            station.hub_priority > previous.hub_priority
                || (station.hub_priority == previous.hub_priority && station.id < previous.id)
        });
        if replace {
            by_system.insert(system_id, station_index);
        }
    }
    let mut hubs = by_system.into_values().collect::<Vec<_>>();
    hubs.sort_unstable_by(|left, right| stations[*left].id.cmp(&stations[*right].id));
    hubs
}

#[allow(clippy::too_many_arguments)]
fn plan_route_path(
    state: &CoreState,
    base: &Map<String, Value>,
    stations: &[RouteStation],
    hub_representatives: &[usize],
    source_index: usize,
    target_index: usize,
    route_policy: &str,
    warper_budget: usize,
) -> (Option<PlannedRoutePath>, bool) {
    let source_system = &state.catalog.planets[stations[source_index].planet_index].system_id;
    let target_system = &state.catalog.planets[stations[target_index].planet_index].system_id;
    let hubs = hub_representatives
        .iter()
        .copied()
        .filter(|index| {
            let system_id = &state.catalog.planets[stations[*index].planet_index].system_id;
            system_id != source_system && system_id != target_system
        })
        .collect::<Vec<_>>();
    let mut best = None;
    let mut visits = 0_usize;
    let complete = visit_route_paths(
        state,
        base,
        stations,
        target_index,
        route_policy,
        warper_budget.clamp(1, 4),
        &mut vec![source_index],
        &hubs,
        &mut best,
        &mut visits,
    );
    if !complete {
        return (None, false);
    }
    (best, true)
}

#[allow(clippy::too_many_arguments)]
fn route_economics_projection(
    state: &CoreState,
    base: &Map<String, Value>,
    stations: &[RouteStation],
    hub_representatives: &[usize],
    source_index: usize,
    target_index: usize,
    installed_vehicles: f64,
    demand_slot: &RouteSlot,
) -> anyhow::Result<RouteEconomicsProjection> {
    let source = &stations[source_index];
    let target = &stations[target_index];
    let source_planet = &state.catalog.planets[source.planet_index];
    let target_planet = &state.catalog.planets[target.planet_index];
    let requires_warp = source_planet.system_id != target_planet.system_id;
    let (path, route_planning_complete) = if requires_warp {
        plan_route_path(
            state,
            base,
            stations,
            hub_representatives,
            source_index,
            target_index,
            &demand_slot.route_policy,
            demand_slot.warper_budget,
        )
    } else {
        (None, true)
    };
    let route_available = !requires_warp || route_planning_complete && path.is_some();
    let direct_distance =
        route_system_distance(base, &source_planet.system_id, &target_planet.system_id);
    let distance_ly = path
        .as_ref()
        .map_or(if requires_warp { direct_distance } else { 0.0 }, |path| {
            path.distance_ly
        });
    let orbit_span = source_planet
        .orbit_index
        .abs_diff(target_planet.orbit_index)
        .max(1) as usize;
    let environment = (route_travel_multiplier(base, &source_planet.id)
        + route_travel_multiplier(base, &target_planet.id))
        / 2.0;
    let duration_seconds = rounded(
        if requires_warp {
            path.as_ref().map_or(
                WARP_TRIP_SECONDS / route_speed_multiplier(base) * environment * 4.0,
                |path| path.duration_seconds,
            )
        } else {
            INTERSTELLAR_TRIP_SECONDS / route_speed_multiplier(base)
                * environment
                * (0.9 + orbit_span as f64 * 0.1)
        },
        2,
    );
    let vessels = installed_vehicles.floor().max(1.0);
    let cargo_per_trip = route_cargo_capacity(base, "remote") * vessels;
    let waypoint_station_indices = path.as_ref().map_or_else(Vec::new, |path| {
        path.station_indices[1..path.station_indices.len() - 1].to_vec()
    });
    let hop_count = if requires_warp {
        path.as_ref().map_or(demand_slot.warper_budget, |path| {
            path.station_indices.len() - 1
        })
    } else {
        0
    };
    let hub_power_kw = waypoint_station_indices
        .iter()
        .map(|index| station_building_power_kw(state, &stations[*index]))
        .collect::<anyhow::Result<Vec<_>>>()?
        .into_iter()
        .sum::<f64>();
    let drive_power_kw = if requires_warp {
        900.0 * hop_count as f64
    } else {
        240.0
    } * vessels;
    let power_kw = rounded(
        station_building_power_kw(state, source)?
            + station_building_power_kw(state, target)?
            + hub_power_kw
            + drive_power_kw,
        2,
    );
    Ok(RouteEconomicsProjection {
        distance_ly: rounded(distance_ly, 2),
        orbit_span,
        requires_warp,
        duration_seconds,
        cargo_per_trip,
        throughput_per_minute: rounded(cargo_per_trip * 60.0 / duration_seconds.max(1.0), 2),
        warpers_per_trip: if requires_warp {
            vessels * hop_count as f64
        } else {
            0.0
        },
        power_kw,
        energy_mj_per_trip: rounded(power_kw * duration_seconds / 1_000.0, 2),
        route_available,
        route_kind: if !requires_warp {
            "local"
        } else if waypoint_station_indices.is_empty() {
            "direct"
        } else {
            "relay"
        },
        waypoint_station_indices,
        hop_count,
        max_leg_distance_ly: rounded(
            path.as_ref()
                .map_or(distance_ly, |path| path.max_leg_distance_ly),
            2,
        ),
        warpers_per_vessel: if requires_warp { hop_count as f64 } else { 0.0 },
        route_planning_complete,
    })
}

#[derive(Debug, Default)]
struct RouteSupplyDirectories {
    local: HashMap<(usize, String), Vec<RoutePeer>>,
    remote: HashMap<String, Vec<RoutePeer>>,
}

fn orbital_route_slot(station: &RouteStation) -> Option<RouteSlot> {
    station.stored_item_id.as_ref().map(|item_id| RouteSlot {
        item_id: Some(item_id.clone()),
        remote_mode: "supply".to_owned(),
        ..RouteSlot::default()
    })
}

fn route_supply_directories(
    state: &CoreState,
    base: &Map<String, Value>,
    stations: &[RouteStation],
) -> RouteSupplyDirectories {
    let mut result = RouteSupplyDirectories::default();
    for (station_index, station) in stations.iter().enumerate() {
        if station.elevator {
            continue;
        }
        if station.building_id == "orbital_collector" {
            if station.quantum_remote_disabled {
                continue;
            }
            if let Some(slot) = orbital_route_slot(station)
                && let Some(item_id) = slot.item_id.clone()
            {
                let system_id = &state.catalog.planets[station.planet_index].system_id;
                if route_system_unlocked(base, system_id) {
                    result.remote.entry(item_id).or_default().push(RoutePeer {
                        station_index,
                        slot_index: 0,
                        slot,
                    });
                }
            }
            continue;
        }
        for (slot_index, slot) in station.slots.iter().enumerate() {
            let Some(item_id) = slot.item_id.as_ref() else {
                continue;
            };
            if slot.local_mode == "supply" {
                result
                    .local
                    .entry((station.planet_index, item_id.clone()))
                    .or_default()
                    .push(RoutePeer {
                        station_index,
                        slot_index,
                        slot: slot.clone(),
                    });
            }
            if station.building_id == "interstellar_logistics_station"
                && !station.quantum_remote_disabled
                && slot.remote_mode == "supply"
            {
                let system_id = &state.catalog.planets[station.planet_index].system_id;
                if route_system_unlocked(base, system_id) {
                    result
                        .remote
                        .entry(item_id.clone())
                        .or_default()
                        .push(RoutePeer {
                            station_index,
                            slot_index,
                            slot: slot.clone(),
                        });
                }
            }
        }
    }
    result
}

#[allow(clippy::too_many_arguments)]
fn select_route_peer(
    state: &CoreState,
    base: &Map<String, Value>,
    stations: &[RouteStation],
    directories: &RouteSupplyDirectories,
    hub_representatives: &[usize],
    economics_cache: &mut HashMap<(usize, usize, String, usize), RouteEconomicsProjection>,
    target_index: usize,
    target_slot: &RouteSlot,
    scope: &str,
) -> anyhow::Result<Option<RoutePeer>> {
    let target = &stations[target_index];
    let Some(item_id) = target_slot.item_id.as_ref() else {
        return Ok(None);
    };
    if target.elevator
        || scope == "remote"
            && (target.building_id != "interstellar_logistics_station"
                || target.quantum_remote_disabled)
    {
        return Ok(None);
    }
    let candidates = if scope == "local" {
        directories
            .local
            .get(&(target.planet_index, item_id.clone()))
    } else {
        directories.remote.get(item_id)
    };
    let mut ranked = Vec::new();
    for candidate in candidates.into_iter().flatten() {
        if candidate.station_index == target_index {
            continue;
        }
        let source = &stations[candidate.station_index];
        if scope == "local" && source.planet_index != target.planet_index
            || scope == "remote" && source.planet_index == target.planet_index
        {
            continue;
        }
        let (route_available, route_duration) = if scope == "remote" {
            let cache_key = (
                candidate.station_index,
                target_index,
                target_slot.route_policy.clone(),
                target_slot.warper_budget,
            );
            if !economics_cache.contains_key(&cache_key) {
                let economics = route_economics_projection(
                    state,
                    base,
                    stations,
                    hub_representatives,
                    candidate.station_index,
                    target_index,
                    1.0,
                    target_slot,
                )?;
                economics_cache.insert(cache_key.clone(), economics);
            }
            let economics = &economics_cache[&cache_key];
            (economics.route_available, economics.duration_seconds)
        } else {
            (true, 0.0)
        };
        ranked.push((candidate.clone(), route_available, route_duration));
    }
    ranked.sort_by(|left, right| {
        right
            .1
            .cmp(&left.1)
            .then_with(|| right.0.slot.priority.cmp(&left.0.slot.priority))
            .then_with(|| left.2.partial_cmp(&right.2).unwrap_or(Ordering::Equal))
            .then_with(|| {
                stations[left.0.station_index]
                    .id
                    .cmp(&stations[right.0.station_index].id)
            })
            .then_with(|| left.0.slot_index.cmp(&right.0.slot_index))
    });
    Ok(ranked.into_iter().next().map(|value| value.0))
}

fn route_status_label(status: &str) -> &'static str {
    match status {
        "active" => "运输中",
        "ready" => "等待发船",
        "missing-source" => "缺少供应站",
        "missing-vehicle" => "缺少运输载具",
        "missing-hub" => "缺少中转枢纽",
        "missing-warper" => "缺少翘曲器",
        "missing-stock" => "供应库存不足",
        "target-full" => "需求库存已满",
        "no-power" => "站点电力不足",
        _ => "无法验证",
    }
}

fn route_status_is_issue(status: &str) -> bool {
    !matches!(status, "active" | "ready" | "missing-stock" | "target-full")
}

fn route_building_label(building_id: &str) -> &str {
    match building_id {
        "planetary_logistics_station" => "行星站",
        "interstellar_logistics_station" => "星际站",
        "orbital_collector" => "轨道采集器",
        _ => building_id,
    }
}

fn route_endpoint_label(state: &CoreState, station: &RouteStation) -> (String, bool) {
    let (planet_display_name, _) = planet_label(state, station.planet_index);
    let raw = format!(
        "{} · {}",
        planet_display_name,
        route_building_label(&station.building_id)
    );
    bounded_label(Some(&raw), &station.id)
}

fn route_path_labels(
    state: &CoreState,
    stations: &[RouteStation],
    source_index: Option<usize>,
    waypoint_station_indices: &[usize],
    target_index: usize,
    distance_ly: f64,
) -> (String, bool, Vec<String>, Vec<String>, Vec<String>) {
    let station_indices = source_index
        .into_iter()
        .chain(waypoint_station_indices.iter().copied())
        .chain(std::iter::once(target_index))
        .collect::<Vec<_>>();
    let waypoint_station_ids = waypoint_station_indices
        .iter()
        .map(|index| stations[*index].id.clone())
        .collect::<Vec<_>>();
    let waypoint_planet_ids = waypoint_station_indices
        .iter()
        .map(|index| {
            state.catalog.planets[stations[*index].planet_index]
                .id
                .clone()
        })
        .collect::<Vec<_>>();
    let waypoint_labels = waypoint_station_indices
        .iter()
        .map(|index| route_endpoint_label(state, &stations[*index]).0)
        .collect::<Vec<_>>();
    let mut labels = Vec::new();
    for station_index in station_indices {
        let station = &stations[station_index];
        let label = if distance_ly > 0.0 {
            let system_id = &state.catalog.planets[station.planet_index].system_id;
            system_label(state, system_id).0
        } else {
            planet_label(state, station.planet_index).0
        };
        if labels.last() != Some(&label) {
            labels.push(label);
        }
    }
    let raw = labels.join(" → ");
    let (label, truncated) = bounded_label(Some(&raw), "待匹配");
    (
        label,
        truncated,
        waypoint_station_ids,
        waypoint_planet_ids,
        waypoint_labels,
    )
}

fn route_station_output(station: &RouteStation, item_id: &str) -> f64 {
    station.outputs.get(item_id).copied().unwrap_or(0.0)
}

fn route_installed_vehicles(station: &RouteStation, scope: &str) -> f64 {
    if scope == "local" {
        station.installed_drones
    } else {
        station.installed_vessels
    }
}

fn route_vehicle_capacity(station: &RouteStation, scope: &str) -> f64 {
    let per_building = if scope == "local" {
        DRONES_PER_BUILDING
    } else {
        VESSELS_PER_BUILDING
    };
    per_building * station.machine_count.floor().max(0.0)
}

fn route_scope_matches(
    state: &CoreState,
    snapshot: &RouteSnapshotProjection,
    system_id: Option<&str>,
    planet_id: Option<&str>,
) -> bool {
    let target_planet = &state.catalog.planets[snapshot.target_planet_index];
    let source_planet = snapshot
        .source_planet_index
        .map(|index| &state.catalog.planets[index]);
    system_id.is_none_or(|system_id| {
        target_planet.system_id == system_id
            || source_planet.is_some_and(|planet| planet.system_id == system_id)
    }) && planet_id.is_none_or(|planet_id| {
        target_planet.id == planet_id || source_planet.is_some_and(|planet| planet.id == planet_id)
    })
}

#[allow(clippy::too_many_arguments)]
fn build_route_snapshot(
    state: &CoreState,
    base: &Map<String, Value>,
    stations: &[RouteStation],
    hub_representatives: &[usize],
    busy_vehicles: &HashMap<(String, String), f64>,
    economics_cache: &mut HashMap<(usize, usize, String, usize), RouteEconomicsProjection>,
    target_index: usize,
    target_slot_index: usize,
    target_slot: &RouteSlot,
    scope: &'static str,
    source_peer: Option<RoutePeer>,
) -> anyhow::Result<RouteSnapshotProjection> {
    let target = &stations[target_index];
    let item_id = target_slot
        .item_id
        .as_deref()
        .ok_or_else(|| anyhow!("native stellar demand route item is missing"))?;
    let source_index = source_peer.as_ref().map(|peer| peer.station_index);
    let source = source_index.map(|index| &stations[index]);
    let active_routes = target
        .routes
        .iter()
        .filter(|route| {
            route.scope == scope
                && route.slot_index == target_slot_index
                && source.is_none_or(|source| route.peer_id == source.id)
        })
        .collect::<Vec<_>>();
    let active_vehicles = active_routes
        .iter()
        .map(|route| route.vehicle_count)
        .sum::<f64>();
    let active_cargo = active_routes.iter().map(|route| route.cargo).sum::<f64>();
    let active_item_consistent = active_routes.iter().all(|route| route.item_id == item_id);

    let mut vehicle_station_indices = vec![target_index];
    if let Some(source_index) = source_index
        && stations[source_index].building_id != "orbital_collector"
        && source_index != target_index
    {
        vehicle_station_indices.push(source_index);
    }
    vehicle_station_indices.retain(|index| stations[*index].building_id != "orbital_collector");
    let installed_vehicles = vehicle_station_indices
        .iter()
        .map(|index| route_installed_vehicles(&stations[*index], scope))
        .sum::<f64>();
    let installed_vehicle_capacity = vehicle_station_indices
        .iter()
        .map(|index| route_vehicle_capacity(&stations[*index], scope))
        .sum::<f64>();
    let available_by_station = vehicle_station_indices
        .iter()
        .map(|index| {
            let station = &stations[*index];
            let busy = busy_vehicles
                .get(&(station.id.clone(), scope.to_owned()))
                .copied()
                .unwrap_or(0.0);
            (
                *index,
                (route_installed_vehicles(station, scope) - busy).max(0.0),
            )
        })
        .collect::<HashMap<_, _>>();
    let available_vehicles = available_by_station.values().sum::<f64>();

    let economics = if scope == "remote"
        && let Some(source_index) = source_index
    {
        Some(route_economics_projection(
            state,
            base,
            stations,
            hub_representatives,
            source_index,
            target_index,
            installed_vehicles.max(1.0),
            target_slot,
        )?)
    } else {
        None
    };
    if let (Some(source_index), Some(economics)) = (source_index, economics.as_ref()) {
        economics_cache.insert(
            (
                source_index,
                target_index,
                target_slot.route_policy.clone(),
                target_slot.warper_budget,
            ),
            economics.clone(),
        );
    }
    let duration_seconds = economics.as_ref().map_or(
        PLANETARY_TRIP_SECONDS / route_speed_multiplier(base),
        |economics| economics.duration_seconds,
    );
    let cargo_capacity = route_cargo_capacity(base, scope);
    let throughput_per_minute = if installed_vehicles > 0.0 {
        cargo_capacity * installed_vehicles * 60.0 / duration_seconds.max(1.0)
    } else {
        0.0
    };
    let fallback_power_kw = state
        .catalog
        .buildings
        .get(&target.building_id)
        .ok_or_else(|| anyhow!("native stellar target station building is missing"))?
        .power_demand_kw
        .max(0.0)
        + 120.0 * installed_vehicles;
    let power_kw = economics
        .as_ref()
        .map_or(fallback_power_kw, |economics| economics.power_kw);
    let energy_mj_per_trip = economics
        .as_ref()
        .map_or(power_kw * duration_seconds / 1_000.0, |economics| {
            economics.energy_mj_per_trip
        });

    let required_warpers = economics
        .as_ref()
        .map_or(0.0, |economics| economics.warpers_per_vessel);
    let requires_warp = economics
        .as_ref()
        .is_some_and(|economics| economics.requires_warp);
    let warp_vehicle_ready = !requires_warp
        || vehicle_station_indices.iter().any(|index| {
            let station = &stations[*index];
            available_by_station.get(index).copied().unwrap_or(0.0) > 0.0
                && station.warp_enabled
                && station.available_warpers >= required_warpers
        });
    let local_vehicle_power_ready = scope != "local"
        || vehicle_station_indices.iter().any(|index| {
            available_by_station.get(index).copied().unwrap_or(0.0) > 0.0
                && route_station_power_factor(state, &stations[*index]).0 > 0.0
        });
    let active_owner_id = active_routes.first().map(|route| route.owner_id.as_str());
    let dispatch_station_index = active_owner_id
        .and_then(|owner_id| {
            vehicle_station_indices
                .iter()
                .copied()
                .find(|index| stations[*index].id == owner_id)
        })
        .or_else(|| {
            vehicle_station_indices.iter().copied().find(|index| {
                let station = &stations[*index];
                available_by_station.get(index).copied().unwrap_or(0.0) > 0.0
                    && (!requires_warp
                        || station.warp_enabled && station.available_warpers >= required_warpers)
            })
        })
        .or_else(|| {
            vehicle_station_indices
                .iter()
                .copied()
                .find(|index| available_by_station.get(index).copied().unwrap_or(0.0) > 0.0)
        });
    let dispatch_direction = dispatch_station_index.map_or("unassigned", |dispatch_index| {
        if source_index == Some(dispatch_index) {
            "supply-delivery"
        } else {
            "demand-pickup"
        }
    });

    let source_reserve = source_peer.as_ref().map_or(0.0, |peer| peer.slot.min_stock);
    let source_stock = source.map_or(0.0, |source| {
        (route_station_output(source, item_id) - source_reserve).max(0.0)
    });
    let target_stock = route_station_output(target, item_id);
    let target_limit = route_station_capacity(state, base, target, target_slot)?;
    let target_free = (target_limit - target_stock - active_cargo).max(0.0);
    let minimum_cargo = (cargo_capacity * target_slot.minimum_load).ceil();

    let waypoint_station_indices = economics.as_ref().map_or(&[][..], |economics| {
        economics.waypoint_station_indices.as_slice()
    });
    let route_station_indices = source_index
        .into_iter()
        .chain(std::iter::once(target_index))
        .chain(waypoint_station_indices.iter().copied())
        .collect::<Vec<_>>();
    let route_power = route_station_indices
        .iter()
        .map(|index| route_station_power_factor(state, &stations[*index]))
        .collect::<Vec<_>>();
    let route_power_ready = route_power.iter().all(|(factor, _)| *factor > 0.0);
    let power_proof_complete = route_power.iter().all(|(_, proven)| *proven);
    let source_power_factor = source_index
        .map(|index| route_station_power_factor(state, &stations[index]).0)
        .unwrap_or(0.0);
    let target_power_factor = route_station_power_factor(state, target).0;
    let route_available = source.is_some()
        && economics
            .as_ref()
            .is_none_or(|economics| economics.route_available);
    let route_planning_complete = source.is_some()
        && economics
            .as_ref()
            .is_none_or(|economics| economics.route_planning_complete);
    let status = if source.is_none() {
        "missing-source"
    } else if active_vehicles > 0.0 {
        "active"
    } else if available_vehicles < 1.0 {
        "missing-vehicle"
    } else if requires_warp && !route_available {
        "missing-hub"
    } else if requires_warp && (!completed_technology(base, "space_warp") || !warp_vehicle_ready) {
        "missing-warper"
    } else if scope == "remote" && !route_power_ready
        || scope == "local" && !local_vehicle_power_ready
    {
        "no-power"
    } else if source_stock < minimum_cargo {
        "missing-stock"
    } else if target_free < minimum_cargo {
        "target-full"
    } else {
        "ready"
    };

    let target_planet = &state.catalog.planets[target.planet_index];
    let source_planet = source.map(|source| &state.catalog.planets[source.planet_index]);
    let (target_station_label, target_station_label_truncated) =
        route_endpoint_label(state, target);
    let (target_planet_label, target_planet_label_truncated) =
        planet_label(state, target.planet_index);
    let (source_station_label, source_station_label_truncated) = source.map_or_else(
        || ("未匹配".to_owned(), false),
        |source| route_endpoint_label(state, source),
    );
    let (source_planet_label, source_planet_label_truncated) =
        source.map_or((None, false), |source| {
            let (label, truncated) = planet_label(state, source.planet_index);
            (Some(label), truncated)
        });
    let distance_ly = economics
        .as_ref()
        .map_or(0.0, |economics| economics.distance_ly);
    let (
        route_path_label,
        route_path_label_truncated,
        waypoint_station_ids,
        waypoint_planet_ids,
        waypoint_station_labels,
    ) = route_path_labels(
        state,
        stations,
        source_index,
        waypoint_station_indices,
        target_index,
        distance_ly,
    );
    let source_congestion = source.map_or(0.0, |source| source.congestion);
    let waypoint_congestion = waypoint_station_indices
        .iter()
        .map(|index| stations[*index].congestion)
        .fold(0.0_f64, f64::max);
    let route_congestion = source_congestion
        .max(target.congestion)
        .max(waypoint_congestion);
    let item = state
        .catalog
        .items
        .get(item_id)
        .ok_or_else(|| anyhow!("native stellar route item is missing"))?;
    let (item_label, item_label_truncated) = bounded_label(Some(&item.name), item_id);
    let route_id = format!(
        "{}:{}:{}:{}",
        scope,
        target.id,
        target_slot_index,
        source.map_or("unbound", |source| source.id.as_str())
    );
    let mut row = json!({
        "id": route_id.clone(),
        "scope": scope,
        "itemId": item_id,
        "itemLabel": item_label,
        "itemLabelTruncated": item_label_truncated,
        "sourceStationId": source.map(|source| source.id.as_str()),
        "sourceStationLabel": source_station_label,
        "sourceStationLabelTruncated": source_station_label_truncated,
        "sourceBuildingId": source.map(|source| source.building_id.as_str()),
        "sourceBuildingLabel": source.map(|source| route_building_label(&source.building_id)),
        "sourceSlotIndex": source_peer.as_ref().map(|peer| peer.slot_index),
        "sourcePlanetId": source_planet.map(|planet| planet.id.as_str()),
        "sourcePlanetLabel": source_planet_label,
        "sourcePlanetLabelTruncated": source_planet_label_truncated,
        "targetStationId": target.id,
        "targetStationLabel": target_station_label,
        "targetStationLabelTruncated": target_station_label_truncated,
        "targetBuildingId": target.building_id,
        "targetBuildingLabel": route_building_label(&target.building_id),
        "targetSlotIndex": target_slot_index,
        "targetPlanetId": target_planet.id,
        "targetPlanetLabel": target_planet_label,
        "targetPlanetLabelTruncated": target_planet_label_truncated,
    })
    .as_object()
    .expect("literal stellar route identity")
    .clone();
    row.extend(
        json!({
            "sourceStock": source_stock,
            "sourceReserve": source_reserve,
            "sourceSlotMinStock": source_peer.as_ref().map_or(0.0, |peer| peer.slot.min_stock),
            "sourceSlotMaxStock": source_peer.as_ref().map_or(0.0, |peer| peer.slot.max_stock),
            "targetStock": target_stock,
            "targetLimit": target_limit,
            "targetFree": target_free,
            "targetSlotMinStock": target_slot.min_stock,
            "targetSlotMaxStock": target_slot.max_stock,
            "minimumLoad": target_slot.minimum_load,
            "minimumCargo": minimum_cargo,
            "priority": target_slot.priority,
            "installedVehicles": installed_vehicles,
            "installedVehicleCapacity": installed_vehicle_capacity,
            "availableVehicles": available_vehicles,
            "activeVehicles": active_vehicles,
            "activeRouteCount": active_routes.len(),
            "activeCargo": active_cargo,
            "activeRouteItemConsistent": active_item_consistent,
        })
        .as_object()
        .expect("literal stellar route inventory")
        .clone(),
    );
    row.extend(
        json!({
            "distanceLy": distance_ly,
            "orbitSpan": economics.as_ref().map_or(0, |economics| economics.orbit_span),
            "durationSeconds": duration_seconds,
            "cargoPerTrip": economics.as_ref().map_or(cargo_capacity * installed_vehicles.max(1.0), |economics| economics.cargo_per_trip),
            "throughputPerMinute": throughput_per_minute,
            "economicsThroughputPerMinute": economics.as_ref().map_or(throughput_per_minute, |economics| economics.throughput_per_minute),
            "powerKw": power_kw,
            "energyMjPerTrip": energy_mj_per_trip,
            "warpersPerTrip": economics.as_ref().map_or(0.0, |economics| economics.warpers_per_trip),
            "warpersPerVessel": required_warpers,
            "availableWarpers": dispatch_station_index.map_or(0.0, |index| {
                if stations[index].warp_enabled { stations[index].available_warpers } else { 0.0 }
            }),
            "dispatchStationId": dispatch_station_index.map(|index| stations[index].id.as_str()),
            "dispatchPlanetId": dispatch_station_index.map(|index| state.catalog.planets[stations[index].planet_index].id.as_str()),
            "dispatchDirection": dispatch_direction,
            "routeKind": economics.as_ref().map_or("local", |economics| economics.route_kind),
            "routeAvailable": route_available,
            "routePlanningComplete": route_planning_complete,
            "routePathLabel": route_path_label,
            "routePathLabelTruncated": route_path_label_truncated,
            "waypointStationIds": waypoint_station_ids,
            "waypointPlanetIds": waypoint_planet_ids,
            "waypointStationLabels": waypoint_station_labels,
            "hopCount": economics.as_ref().map_or(0, |economics| economics.hop_count),
            "maxLegDistanceLy": economics.as_ref().map_or(0.0, |economics| economics.max_leg_distance_ly),
            "routePolicy": target_slot.route_policy,
            "warperBudget": target_slot.warper_budget,
        })
        .as_object()
        .expect("literal stellar route economics")
        .clone(),
    );
    row.extend(
        json!({
            "requiresWarp": requires_warp,
            "warpVehicleReady": warp_vehicle_ready,
            "localVehiclePowerReady": local_vehicle_power_ready,
            "sourcePowerFactor": source_power_factor,
            "targetPowerFactor": target_power_factor,
            "routePowerReady": route_power_ready,
            "powerProofComplete": power_proof_complete,
            "sourceCongestion": source_congestion,
            "targetCongestion": target.congestion,
            "waypointMaxCongestion": waypoint_congestion,
            "routeCongestion": route_congestion,
            "status": status,
            "statusLabel": route_status_label(status),
        })
        .as_object()
        .expect("literal stellar route diagnostics")
        .clone(),
    );
    let row = Value::Object(row);
    Ok(RouteSnapshotProjection {
        id: route_id,
        scope,
        priority: target_slot.priority,
        status,
        row,
        source_planet_index: source.map(|source| source.planet_index),
        target_planet_index: target.planet_index,
    })
}

fn build_route_snapshots(state: &CoreState) -> anyhow::Result<Vec<RouteSnapshotProjection>> {
    let base = state.base_value();
    let stations = load_route_stations(state)?;
    let directories = route_supply_directories(state, base, &stations);
    let hub_representatives = route_hub_representatives(state, base, &stations);
    let mut busy_vehicles = HashMap::<(String, String), f64>::new();
    for station in &stations {
        for route in &station.routes {
            *busy_vehicles
                .entry((route.owner_id.clone(), route.scope.clone()))
                .or_default() += route.vehicle_count;
        }
    }
    let mut economics_cache = HashMap::new();
    let mut snapshots = Vec::new();
    for (target_index, target) in stations.iter().enumerate() {
        if target.building_id == "orbital_collector" {
            continue;
        }
        let scopes: &[&'static str] = if target.building_id == "interstellar_logistics_station" {
            &["local", "remote"]
        } else {
            &["local"]
        };
        for &scope in scopes {
            for (target_slot_index, target_slot) in target.slots.iter().enumerate() {
                let mode = if scope == "local" {
                    target_slot.local_mode.as_str()
                } else {
                    target_slot.remote_mode.as_str()
                };
                if target_slot.item_id.is_none() || mode != "demand" {
                    continue;
                }
                let source_peer = select_route_peer(
                    state,
                    base,
                    &stations,
                    &directories,
                    &hub_representatives,
                    &mut economics_cache,
                    target_index,
                    target_slot,
                    scope,
                )?;
                snapshots.push(build_route_snapshot(
                    state,
                    base,
                    &stations,
                    &hub_representatives,
                    &busy_vehicles,
                    &mut economics_cache,
                    target_index,
                    target_slot_index,
                    target_slot,
                    scope,
                    source_peer,
                )?);
            }
        }
    }
    snapshots.sort_by(|left, right| {
        (right.status == "active")
            .cmp(&(left.status == "active"))
            .then_with(|| right.priority.cmp(&left.priority))
            .then_with(|| left.id.cmp(&right.id))
    });
    Ok(snapshots)
}

fn route_query_matches(snapshot: &RouteSnapshotProjection, normalized_query: &str) -> bool {
    if normalized_query.is_empty() {
        return true;
    }
    [
        "itemId",
        "itemLabel",
        "sourceStationLabel",
        "sourcePlanetLabel",
        "targetStationLabel",
        "targetPlanetLabel",
        "routePathLabel",
        "statusLabel",
    ]
    .iter()
    .filter_map(|key| snapshot.row.get(*key).and_then(Value::as_str))
    .any(|value| value.to_lowercase().contains(normalized_query))
}

fn scan_stations(
    state: &CoreState,
    system_filter: Option<&str>,
    planet_filter: Option<&str>,
    page: Option<(usize, usize)>,
) -> anyhow::Result<StationScan> {
    let mut by_planet = vec![PlanetLogisticsSummary::default(); state.catalog.planets.len()];
    let mut rows = page.map_or_else(Vec::new, |(_, limit)| Vec::with_capacity(limit));
    let mut total_matching = 0_usize;
    for &entity_index in &state.factory_topology.station_indices {
        let planet_index = state
            .factory_topology
            .entity_planet_indices
            .get(entity_index)
            .copied()
            .unwrap_or(usize::MAX);
        let Some(planet) = state.catalog.planets.get(planet_index) else {
            continue;
        };
        let entity = state.parse_entity(entity_index)?;
        let object = entity
            .as_object()
            .ok_or_else(|| anyhow!("native stellar station row is not an object"))?;
        let station_id = &state.entities.ids[entity_index];
        let building_id = state
            .symbols
            .resolve(state.entities.buildings[entity_index]);
        let tier = non_negative_integer(object.get("stationTier"));
        let quantum_mode = object
            .get("quantumMode")
            .and_then(Value::as_str)
            .filter(|value| value.len() <= 64 && !value.chars().any(char::is_control));
        let transition_active = quantum_mode == Some("transitioning")
            || object
                .get("quantumTransition")
                .is_some_and(|value| !value.is_null());
        let slots = object.get("stationSlots").and_then(Value::as_array);
        let routes = object.get("stationRoutes").and_then(Value::as_array);
        let import_slots = slots.map_or(0, |values| {
            values
                .iter()
                .filter(|slot| slot.get("remoteMode").and_then(Value::as_str) == Some("demand"))
                .count()
        });
        let export_slots = slots.map_or(0, |values| {
            values
                .iter()
                .filter(|slot| slot.get("remoteMode").and_then(Value::as_str) == Some("supply"))
                .count()
        });
        let route_count = routes.map_or(0, Vec::len);
        let active_route_count = routes.map_or(0, |values| {
            values
                .iter()
                .filter(|route| {
                    non_negative_number(route.get("vehicleCount")) > 0.0
                        || non_negative_number(route.get("cargo")) > 0.0
                })
                .count()
        });
        let congestion = non_negative_number(object.get("stationCongestion"));
        let summary = &mut by_planet[planet_index];
        checked_add(&mut summary.station_count, 1, "station count")?;
        if building_id == Some("interstellar_logistics_station") {
            checked_add(
                &mut summary.interstellar_station_count,
                1,
                "interstellar station count",
            )?;
        } else if building_id == Some("orbital_collector") {
            checked_add(
                &mut summary.orbital_collector_count,
                1,
                "orbital collector count",
            )?;
        }
        checked_add(
            &mut summary.configured_import_slots,
            import_slots,
            "import slot count",
        )?;
        checked_add(
            &mut summary.configured_export_slots,
            export_slots,
            "export slot count",
        )?;
        checked_add(&mut summary.route_count, route_count, "route count")?;
        checked_add(
            &mut summary.active_route_count,
            active_route_count,
            "active route count",
        )?;
        if building_id == Some("interstellar_logistics_station") && tier < 2.0 {
            checked_add(&mut summary.legacy_station_count, 1, "legacy station count")?;
        } else if building_id == Some("interstellar_logistics_station")
            && quantum_mode == Some("quantum")
        {
            checked_add(
                &mut summary.quantum_station_count,
                1,
                "quantum station count",
            )?;
        } else if building_id == Some("interstellar_logistics_station")
            && tier >= 2.0
            && !transition_active
        {
            checked_add(
                &mut summary.quantum_attachable_count,
                1,
                "quantum attachable count",
            )?;
        }
        if congestion >= 0.8 && summary.congested_station_id.is_none() {
            summary.congested_station_id = Some(station_id.to_owned());
        }

        let matches_scope = system_filter.is_none_or(|id| id == planet.system_id)
            && planet_filter.is_none_or(|id| id == planet.id);
        if !matches_scope {
            continue;
        }
        if let Some((cursor, limit)) = page
            && total_matching >= cursor
            && rows.len() < limit
        {
            let (planet_display_name, planet_name_truncated) = planet_label(state, planet_index);
            let building_fallback = building_id.unwrap_or("station");
            let (building_display_name, building_name_truncated) = bounded_label(
                building_id
                    .and_then(|id| state.catalog.buildings.get(id))
                    .map(|definition| definition.id.as_str())
                    .or(building_id),
                building_fallback,
            );
            rows.push(json!({
                "stationId": station_id,
                "buildingId": building_id,
                "buildingLabel": building_display_name,
                "buildingLabelTruncated": building_name_truncated,
                "planetId": planet.id,
                "planetLabel": planet_display_name,
                "planetLabelTruncated": planet_name_truncated,
                "systemId": planet.system_id,
                "positionX": state.entities.position_x[entity_index],
                "positionY": state.entities.position_y[entity_index],
                "stationTier": tier,
                "quantumMode": quantum_mode,
                "quantumTransitionActive": transition_active,
                "powerFactor": unit_number_or(
                    object.get("powerFactor"),
                    unit_number_or(
                        planet_metrics(state.base_value(), &planet.id)
                            .and_then(|metrics| metrics.get("powerFactor")),
                        1.0,
                    ),
                ),
                "congestion": congestion.clamp(0.0, 1.0),
                "installedDrones": non_negative_integer(object.get("stationDrones")),
                "installedVessels": non_negative_integer(object.get("stationVessels")),
                "availableWarpers": non_negative_integer(object.get("stationWarpers")),
                "slotCount": slots.map_or(0, Vec::len),
                "configuredImportSlotCount": import_slots,
                "configuredExportSlotCount": export_slots,
                "routeCount": route_count,
                "activeRouteCount": active_route_count,
            }));
        }
        checked_add(&mut total_matching, 1, "matching station count")?;
    }
    if let Some((cursor, _)) = page
        && cursor > total_matching
    {
        bail!("native stellar station cursor is invalid");
    }
    Ok(StationScan {
        by_planet,
        total_matching,
        rows,
    })
}

fn page_value(
    cursor: usize,
    limit: usize,
    total_count: usize,
    rows: Vec<Value>,
) -> anyhow::Result<Value> {
    Ok(json!({
        "cursor": cursor,
        "limit": limit,
        "totalCount": total_count,
        "nextCursor": next_cursor(cursor, rows.len(), total_count)?,
        "rows": rows,
    }))
}

fn strict_decimal_string<'a>(value: Option<&'a Value>, label: &str) -> anyhow::Result<&'a str> {
    let value = value
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("native stellar quantum {label} is not a decimal string"))?;
    if value.is_empty()
        || value.len() > MAX_DECIMAL_DIGITS
        || !value.bytes().all(|byte| byte.is_ascii_digit())
        || value.len() > 1 && value.starts_with('0')
    {
        bail!("native stellar quantum {label} is not canonical");
    }
    Ok(value)
}

fn decimal_at_least(left: &str, right: &str) -> bool {
    left.len() > right.len() || left.len() == right.len() && left >= right
}

fn decimal_at_most(left: &str, right: &str) -> bool {
    left.len() < right.len() || left.len() == right.len() && left <= right
}

fn strict_quantity_record<'a>(
    value: Option<&'a Value>,
    state: &CoreState,
    label: &str,
    capacity: bool,
) -> anyhow::Result<Option<&'a Map<String, Value>>> {
    let Some(value) = value else {
        return Ok(None);
    };
    let record = value
        .as_object()
        .ok_or_else(|| anyhow!("native stellar quantum {label} is not an object"))?;
    if record.len() > MAX_QUANTUM_ITEM_ROWS {
        bail!("native stellar quantum {label} exceeds the item limit");
    }
    for (item_id, amount) in record {
        if !state.catalog.items.contains_key(item_id) {
            bail!("native stellar quantum {label} contains an unknown item");
        }
        let amount = strict_decimal_string(Some(amount), label)?;
        if capacity
            && (!decimal_at_least(amount, QUANTUM_ITEM_CAPACITY_MIN)
                || !decimal_at_most(amount, QUANTUM_ITEM_CAPACITY_MAX))
        {
            bail!("native stellar quantum item capacity is outside the allowed range");
        }
    }
    Ok(Some(record))
}

fn strict_safe_integer(value: Option<&Value>, label: &str) -> anyhow::Result<u64> {
    let value = value
        .and_then(Value::as_f64)
        .filter(|value| {
            value.is_finite() && *value >= 0.0 && *value <= MAX_SAFE_INTEGER && value.fract() == 0.0
        })
        .ok_or_else(|| anyhow!("native stellar quantum {label} is not a safe integer"))?;
    Ok(value as u64)
}

fn strict_non_negative_number(value: Option<&Value>, label: &str) -> anyhow::Result<f64> {
    value
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite() && *value >= 0.0)
        .ok_or_else(|| anyhow!("native stellar quantum {label} is invalid"))
}

fn quantum_mode(object: &Map<String, Value>) -> anyhow::Result<&str> {
    match object.get("quantumMode") {
        None | Some(Value::Null) => Ok("legacy"),
        Some(Value::String(value))
            if matches!(value.as_str(), "legacy" | "transitioning" | "quantum") =>
        {
            Ok(value)
        }
        _ => bail!("native stellar quantum attachment mode is invalid"),
    }
}

fn quantum_logistics_level_strict(base: &Map<String, Value>) -> anyhow::Result<u64> {
    let level = base
        .get("endgame")
        .and_then(Value::as_object)
        .and_then(|endgame| endgame.get("infiniteResearch"))
        .and_then(Value::as_object)
        .and_then(|research| research.get("galactic_logistics"))
        .and_then(Value::as_object)
        .and_then(|progress| progress.get("level"));
    match level {
        None => Ok(0),
        Some(value) => strict_safe_integer(Some(value), "galactic logistics level"),
    }
}

fn scan_quantum_collectors(state: &CoreState) -> anyhow::Result<QuantumCollectorScan> {
    let mut scan = QuantumCollectorScan::default();
    for &entity_index in &state.factory_topology.station_indices {
        let building_id = state
            .symbols
            .resolve(state.entities.buildings[entity_index]);
        if !matches!(
            building_id,
            Some("interstellar_logistics_station" | "orbital_collector")
        ) {
            continue;
        }
        let entity = state.parse_entity(entity_index)?;
        let object = entity
            .as_object()
            .ok_or_else(|| anyhow!("native stellar quantum endpoint is not an object"))?;
        let mode = quantum_mode(object)?;
        let machine_count = strict_safe_integer(object.get("machineCount"), "machine count")?;
        if building_id == Some("interstellar_logistics_station") {
            if mode == "quantum" {
                if machine_count > 0 {
                    checked_add(
                        &mut scan.active_tower_count,
                        1,
                        "quantum active tower count",
                    )?;
                }
                scan.active_tower_stacks = scan
                    .active_tower_stacks
                    .checked_add(machine_count)
                    .ok_or_else(|| anyhow!("native stellar quantum tower stack overflow"))?;
                if scan.active_tower_stacks > MAX_SAFE_INTEGER_U64 {
                    bail!("native stellar quantum tower stacks exceed the safe integer range");
                }
            }
            continue;
        }

        let planet_index = state
            .factory_topology
            .entity_planet_indices
            .get(entity_index)
            .copied()
            .ok_or_else(|| anyhow!("native stellar quantum collector planet is missing"))?;
        let planet = state
            .catalog
            .planets
            .get(planet_index)
            .ok_or_else(|| anyhow!("native stellar quantum collector planet is invalid"))?;
        let transition_active = mode == "transitioning"
            || object
                .get("quantumTransition")
                .is_some_and(|value| !value.is_null());
        let attachment_state = if mode == "quantum" {
            checked_add(
                &mut scan.connected_count,
                1,
                "quantum connected collector count",
            )?;
            scan.connected_stacks = scan
                .connected_stacks
                .checked_add(machine_count)
                .ok_or_else(|| anyhow!("native stellar quantum collector stack overflow"))?;
            if scan.connected_stacks > MAX_SAFE_INTEGER_U64 {
                bail!("native stellar quantum collector stacks exceed the safe integer range");
            }
            "connected"
        } else if mode == "transitioning" {
            checked_add(
                &mut scan.pending_count,
                1,
                "quantum pending collector count",
            )?;
            "pending"
        } else if !transition_active {
            checked_add(
                &mut scan.available_count,
                1,
                "quantum available collector count",
            )?;
            "available"
        } else {
            "unavailable"
        };
        checked_add(&mut scan.total_count, 1, "quantum collector count")?;
        if scan.total_count > MAX_QUANTUM_COLLECTOR_ROWS {
            bail!("native stellar quantum collector count exceeds the bounded limit");
        }
        scan.rows.push(json!({
            "collectorId": &state.entities.ids[entity_index],
            "planetId": planet.id,
            "systemId": planet.system_id,
            "machineCount": machine_count,
            "quantumMode": mode,
            "quantumTransitionActive": transition_active,
            "attachmentState": attachment_state,
        }));
    }
    Ok(scan)
}

impl CoreState {
    /// Returns the complete star-system and planet directory through two
    /// independently pageable lanes. The projection is intentionally free of
    /// industry selectors so a renderer cannot mistake a scoped logistics
    /// page for the global map catalog.
    #[allow(clippy::too_many_arguments)]
    pub fn star_map_catalog_projection(
        &self,
        expected_revision: u64,
        expected_registry_fingerprint: &str,
        system_cursor: usize,
        system_limit: usize,
        planet_cursor: usize,
        planet_limit: usize,
    ) -> anyhow::Result<Value> {
        validate_identity(self, expected_revision, expected_registry_fingerprint)?;
        validate_page(system_cursor, system_limit)?;
        validate_page(planet_cursor, planet_limit)?;
        let request = json!({
            "expectedRevision": expected_revision,
            "expectedRegistryFingerprint": expected_registry_fingerprint,
            "systemCursor": system_cursor,
            "systemLimit": system_limit,
            "planetCursor": planet_cursor,
            "planetLimit": planet_limit,
        });
        validate_request(&request)?;

        let base = self.base_value();
        let active_planet_id = base
            .get("activePlanetId")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow!("native star-map catalog active planet is invalid"))?;
        let active_planet = self
            .catalog
            .planets
            .iter()
            .find(|planet| planet.id == active_planet_id)
            .ok_or_else(|| anyhow!("native star-map catalog active planet is missing"))?;
        let exploration = object_at(base, "exploration");
        let unlocked_systems =
            known_members(exploration.and_then(|value| value.get("unlockedSystemIds")));
        let colonized_planets =
            known_members(exploration.and_then(|value| value.get("colonizedPlanetIds")));
        let systems = system_directory(self);
        if system_cursor > systems.len() {
            bail!("native star-map catalog system cursor is invalid");
        }
        let planet_indices = systems
            .iter()
            .flat_map(|system| system.planet_indices.iter().copied())
            .collect::<Vec<_>>();
        if planet_cursor > planet_indices.len() {
            bail!("native star-map catalog planet cursor is invalid");
        }

        let system_rows = systems
            .iter()
            .skip(system_cursor)
            .take(system_limit)
            .map(|system| {
                let (display_name, display_name_truncated) =
                    system_label(self, system.system_id);
                let profile = system_profile(base, system.system_id);
                let (star_type_name, star_type_name_truncated) = bounded_label(
                    profile
                        .and_then(|value| value.get("starTypeName"))
                        .and_then(Value::as_str),
                    system.system_id,
                );
                let mission = exploration
                    .and_then(|value| value.get("missions"))
                    .and_then(Value::as_array)
                    .and_then(|missions| {
                        missions.iter().find(|mission| {
                            mission.get("systemId").and_then(Value::as_str)
                                == Some(system.system_id)
                        })
                    });
                let unlocked = system.system_id == active_planet.system_id
                    || unlocked_systems.contains(system.system_id);
                let survey_progress = exploration
                    .and_then(|value| value.get("surveyProgressBySystem"))
                    .and_then(Value::as_object)
                    .and_then(|value| value.get(system.system_id))
                    .and_then(Value::as_f64)
                    .filter(|value| value.is_finite())
                    .unwrap_or(if unlocked { 1.0 } else { 0.0 })
                    .clamp(0.0, 1.0);
                let colonized_planet_count = system
                    .planet_indices
                    .iter()
                    .filter(|index| {
                        let planet = &self.catalog.planets[**index];
                        planet.id == active_planet_id
                            || colonized_planets.contains(planet.id.as_str())
                    })
                    .count();
                Ok::<Value, anyhow::Error>(json!({
                    "systemId": system.system_id,
                    "displayName": display_name,
                    "displayNameTruncated": display_name_truncated,
                    "starClassId": bounded_token(profile.and_then(|value| value.get("starClassId"))),
                    "starTypeName": star_type_name,
                    "starTypeNameTruncated": star_type_name_truncated,
                    "positionX": finite_number(profile.and_then(|value| value.get("positionX"))),
                    "positionY": finite_number(profile.and_then(|value| value.get("positionY"))),
                    "distanceFromOriginLy": non_negative_number(profile.and_then(|value| value.get("distanceFromOriginLy"))),
                    "luminosity": non_negative_number(profile.and_then(|value| value.get("luminosity"))),
                    "massMultiplier": non_negative_number(profile.and_then(|value| value.get("massMultiplier"))),
                    "radiusMultiplier": non_negative_number(profile.and_then(|value| value.get("radiusMultiplier"))),
                    "active": system.system_id == active_planet.system_id,
                    "discovered": unlocked,
                    "missionActive": mission.is_some(),
                    "missionElapsedSeconds": non_negative_number(mission.and_then(|value| value.get("elapsedSeconds"))),
                    "missionDurationSeconds": non_negative_number(mission.and_then(|value| value.get("durationSeconds"))),
                    "surveyProgress": survey_progress,
                    "firstPlanetId": system.planet_indices.first().map(|index| self.catalog.planets[*index].id.as_str()),
                    "planetCount": system.planet_indices.len(),
                    "colonizedPlanetCount": colonized_planet_count,
                }))
            })
            .collect::<anyhow::Result<Vec<_>>>()?;

        let mut nested_truncated = false;
        let planet_rows = planet_indices
            .iter()
            .skip(planet_cursor)
            .take(planet_limit)
            .map(|&planet_index| {
                let planet = &self.catalog.planets[planet_index];
                let profile = planet_profile(base, &planet.id);
                let star_profile = system_profile(base, &planet.system_id);
                let (display_name, display_name_truncated) = planet_label(self, planet_index);
                let (system_display_name, system_display_name_truncated) =
                    system_label(self, &planet.system_id);
                let (climate_name, climate_name_truncated) = bounded_label(
                    profile
                        .and_then(|value| value.get("climateName"))
                        .and_then(Value::as_str),
                    &planet.kind,
                );
                let (specialization_name, specialization_name_truncated) = bounded_label(
                    profile
                        .and_then(|value| value.get("specializationName"))
                        .and_then(Value::as_str),
                    "",
                );
                let resources = bounded_catalog_item_ids(
                    self,
                    profile.and_then(|value| value.get("resourceIds")),
                    "resource IDs",
                )?;
                let rare_resources = bounded_catalog_item_ids(
                    self,
                    profile.and_then(|value| value.get("rareResourceIds")),
                    "rare resource IDs",
                )?;
                let orbital_yields = bounded_catalog_orbital_yields(
                    self,
                    profile.and_then(|value| value.get("orbitalYields")),
                    &planet.orbital_yields,
                )?;
                let metadata = bounded_catalog_metadata(base, &planet.id)?;
                let row_truncated = [
                    &resources,
                    &rare_resources,
                    &orbital_yields,
                    &metadata["tags"],
                ]
                .into_iter()
                .any(|value| value.get("truncated").and_then(Value::as_bool) == Some(true))
                    || metadata
                        .get("noteTruncated")
                        .and_then(Value::as_bool)
                        == Some(true)
                    || metadata
                        .get("tagTextTruncated")
                        .and_then(Value::as_bool)
                        == Some(true);
                nested_truncated |= row_truncated;
                let role = nested_object(object_at(base, "galaxy"), "planetRoles")
                    .and_then(|roles| roles.get(&planet.id))
                    .and_then(Value::as_str)
                    .filter(|role| matches!(*role, "auto" | "mining" | "smelting" | "manufacturing" | "chemical" | "research" | "logistics" | "power"))
                    .unwrap_or("auto");
                Ok::<Value, anyhow::Error>(json!({
                    "planetId": planet.id,
                    "displayName": display_name,
                    "displayNameTruncated": display_name_truncated,
                    "systemId": planet.system_id,
                    "systemDisplayName": system_display_name,
                    "systemDisplayNameTruncated": system_display_name_truncated,
                    "kind": planet.kind,
                    "orbitIndex": planet.orbit_index,
                    "simulationOrder": planet.simulation_order,
                    "systemPositionX": finite_number(star_profile.and_then(|value| value.get("positionX"))),
                    "systemPositionY": finite_number(star_profile.and_then(|value| value.get("positionY"))),
                    "active": planet.id == active_planet_id,
                    "discovered": planet.system_id == active_planet.system_id || unlocked_systems.contains(planet.system_id.as_str()),
                    "colonized": planet.id == active_planet_id || colonized_planets.contains(planet.id.as_str()),
                    "industryRole": role,
                    "entityCount": self.factory_topology.entities_by_planet[planet_index].len(),
                    "deviceCount": self.factory_topology.device_counts_by_planet[planet_index].max(0.0),
                    "beltCount": self.factory_topology.belt_counts_by_planet[planet_index],
                    "metadata": metadata,
                    "profile": {
                        "climateName": climate_name,
                        "climateNameTruncated": climate_name_truncated,
                        "oceanType": bounded_token(profile.and_then(|value| value.get("oceanType"))).unwrap_or("none"),
                        "specialization": bounded_token(profile.and_then(|value| value.get("specialization"))).unwrap_or("balanced"),
                        "specializationName": specialization_name,
                        "specializationNameTruncated": specialization_name_truncated,
                        "tidalLocked": profile.and_then(|value| value.get("tidalLocked")).and_then(Value::as_bool).unwrap_or(false),
                        "sulfuricOcean": profile.and_then(|value| value.get("sulfuricOcean")).and_then(Value::as_bool).unwrap_or(false),
                        "windMultiplier": non_negative_number(profile.and_then(|value| value.get("windMultiplier"))),
                        "solarMultiplier": non_negative_number(profile.and_then(|value| value.get("solarMultiplier"))),
                        "geothermalMultiplier": non_negative_number(profile.and_then(|value| value.get("geothermalMultiplier"))),
                        "miningMultiplier": non_negative_number(profile.and_then(|value| value.get("miningMultiplier"))),
                        "orbitalYieldMultiplier": non_negative_number(profile.and_then(|value| value.get("orbitalYieldMultiplier"))),
                        "reserveScale": non_negative_number(profile.and_then(|value| value.get("reserveScale"))),
                        "travelTimeMultiplier": non_negative_number(profile.and_then(|value| value.get("travelTimeMultiplier"))),
                        "productionSpeedMultiplier": non_negative_number(profile.and_then(|value| value.get("productionSpeedMultiplier"))),
                        "surveyDurationSeconds": non_negative_number(profile.and_then(|value| value.get("surveyDurationSeconds"))),
                        "resourceIds": resources,
                        "rareResourceIds": rare_resources,
                        "orbitalYields": orbital_yields,
                    },
                }))
            })
            .collect::<anyhow::Result<Vec<_>>>()?;

        let total_systems = systems.len();
        let total_planets = planet_indices.len();
        let unlocked_system_count = systems
            .iter()
            .filter(|system| {
                system.system_id == active_planet.system_id
                    || unlocked_systems.contains(system.system_id)
            })
            .count();
        let colonized_planet_count = self
            .catalog
            .planets
            .iter()
            .filter(|planet| {
                planet.id == active_planet_id || colonized_planets.contains(planet.id.as_str())
            })
            .count();
        let system_page = page_value(system_cursor, system_limit, total_systems, system_rows)?;
        let planet_page = page_value(planet_cursor, planet_limit, total_planets, planet_rows)?;
        let truncated = nested_truncated
            || system_page["nextCursor"].is_number()
            || planet_page["nextCursor"].is_number();
        finish_projection(json!({
            "schemaVersion": 1,
            "projectionType": STAR_MAP_CATALOG_SCHEMA,
            "revision": self.revision,
            "registryFingerprint": self.catalog.snapshot.registry_fingerprint,
            "stateVersion": self.identity.state_version,
            "limits": {
                "requestBytes": MAX_REQUEST_BYTES,
                "projectionBytes": MAX_PROJECTION_BYTES,
                "pageRows": MAX_PAGE_ROWS,
                "labelBytes": MAX_LABEL_BYTES,
                "nestedRows": MAX_CATALOG_NESTED_ROWS,
                "tagRows": MAX_CATALOG_TAG_ROWS,
            },
            "request": request,
            "activePlanetId": active_planet_id,
            "activeSystemId": active_planet.system_id,
            "galaxySeed": object_at(base, "galaxy")
                .and_then(|value| value.get("seed"))
                .and_then(Value::as_u64)
                .unwrap_or(0),
            "summary": {
                "systemCount": total_systems,
                "unlockedSystemCount": unlocked_system_count,
                "planetCount": total_planets,
                "colonizedPlanetCount": colonized_planet_count,
            },
            "truncated": truncated,
            "systems": system_page,
            "planets": planet_page,
        }))
    }

    /// Returns a stable page of star systems with direct display labels,
    /// generated galaxy coordinates, exploration state, and aggregated
    /// industry/logistics counters. No entity or route record is exported.
    pub fn star_map_overview_projection(
        &self,
        expected_revision: u64,
        expected_registry_fingerprint: &str,
        cursor: usize,
        limit: usize,
    ) -> anyhow::Result<Value> {
        validate_identity(self, expected_revision, expected_registry_fingerprint)?;
        validate_page(cursor, limit)?;
        let request = json!({
            "expectedRevision": expected_revision,
            "expectedRegistryFingerprint": expected_registry_fingerprint,
            "cursor": cursor,
            "limit": limit,
        });
        validate_request(&request)?;

        let base = self.base_value();
        let active_planet_id = base
            .get("activePlanetId")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow!("native stellar active planet is invalid"))?;
        let active_planet = self
            .catalog
            .planets
            .iter()
            .find(|planet| planet.id == active_planet_id)
            .ok_or_else(|| anyhow!("native stellar active planet is missing"))?;
        let exploration = object_at(base, "exploration");
        let unlocked_systems =
            known_members(exploration.and_then(|value| value.get("unlockedSystemIds")));
        let colonized_planets =
            known_members(exploration.and_then(|value| value.get("colonizedPlanetIds")));
        let systems = system_directory(self);
        if cursor > systems.len() {
            bail!("native stellar system cursor is invalid");
        }
        let station_scan = scan_stations(self, None, None, None)?;
        let rows = systems
            .iter()
            .skip(cursor)
            .take(limit)
            .map(|system| {
                let (display_name, display_name_truncated) =
                    system_label(self, system.system_id);
                let profile = system_profile(base, system.system_id);
                let (star_type_name, star_type_name_truncated) = bounded_label(
                    profile
                        .and_then(|value| value.get("starTypeName"))
                        .and_then(Value::as_str),
                    system.system_id,
                );
                let mut entity_count = 0_usize;
                let mut belt_count = 0_usize;
                let mut device_count = 0.0_f64;
                let mut station_count = 0_usize;
                let mut interstellar_station_count = 0_usize;
                let mut orbital_collector_count = 0_usize;
                let mut legacy_station_count = 0_usize;
                let mut quantum_station_count = 0_usize;
                let mut quantum_attachable_count = 0_usize;
                let mut import_slots = 0_usize;
                let mut export_slots = 0_usize;
                let mut route_count = 0_usize;
                let mut active_route_count = 0_usize;
                let mut colonized_count = 0_usize;
                let mut generation_kw = 0.0_f64;
                let mut demand_kw = 0.0_f64;
                let mut served_demand_kw = 0.0_f64;
                for &planet_index in &system.planet_indices {
                    let planet = &self.catalog.planets[planet_index];
                    checked_add(
                        &mut entity_count,
                        self.factory_topology.entities_by_planet[planet_index].len(),
                        "system entity count",
                    )?;
                    checked_add(
                        &mut belt_count,
                        self.factory_topology.belt_counts_by_planet[planet_index] as usize,
                        "system belt count",
                    )?;
                    device_count += self.factory_topology.device_counts_by_planet[planet_index];
                    let logistics = &station_scan.by_planet[planet_index];
                    checked_add(&mut station_count, logistics.station_count, "system station count")?;
                    checked_add(
                        &mut interstellar_station_count,
                        logistics.interstellar_station_count,
                        "system interstellar station count",
                    )?;
                    checked_add(
                        &mut orbital_collector_count,
                        logistics.orbital_collector_count,
                        "system orbital collector count",
                    )?;
                    checked_add(
                        &mut legacy_station_count,
                        logistics.legacy_station_count,
                        "system legacy station count",
                    )?;
                    checked_add(
                        &mut quantum_station_count,
                        logistics.quantum_station_count,
                        "system quantum station count",
                    )?;
                    checked_add(
                        &mut quantum_attachable_count,
                        logistics.quantum_attachable_count,
                        "system attachable station count",
                    )?;
                    checked_add(
                        &mut import_slots,
                        logistics.configured_import_slots,
                        "system import slot count",
                    )?;
                    checked_add(
                        &mut export_slots,
                        logistics.configured_export_slots,
                        "system export slot count",
                    )?;
                    checked_add(&mut route_count, logistics.route_count, "system route count")?;
                    checked_add(
                        &mut active_route_count,
                        logistics.active_route_count,
                        "system active route count",
                    )?;
                    if planet.id == active_planet_id || colonized_planets.contains(planet.id.as_str()) {
                        checked_add(&mut colonized_count, 1, "system colonized planet count")?;
                    }
                    let metrics = planet_metrics(base, &planet.id);
                    let planet_demand = non_negative_number(
                        metrics.and_then(|value| value.get("demandKw")),
                    );
                    generation_kw += non_negative_number(
                        metrics.and_then(|value| value.get("generationKw")),
                    );
                    demand_kw += planet_demand;
                    served_demand_kw += planet_demand
                        * unit_number_or(
                            metrics.and_then(|value| value.get("powerFactor")),
                            1.0,
                        );
                }
                let unlocked = system.system_id == active_planet.system_id
                    || unlocked_systems.contains(system.system_id);
                let mission = exploration
                    .and_then(|value| value.get("missions"))
                    .and_then(Value::as_array)
                    .and_then(|missions| {
                        missions.iter().find(|mission| {
                            mission.get("systemId").and_then(Value::as_str)
                                == Some(system.system_id)
                        })
                    });
                let survey_progress = exploration
                    .and_then(|value| value.get("surveyProgressBySystem"))
                    .and_then(Value::as_object)
                    .and_then(|value| value.get(system.system_id))
                    .and_then(Value::as_f64)
                    .filter(|value| value.is_finite())
                    .unwrap_or(if unlocked { 1.0 } else { 0.0 })
                    .clamp(0.0, 1.0);
                Ok::<Value, anyhow::Error>(json!({
                    "systemId": system.system_id,
                    "displayName": display_name,
                    "displayNameTruncated": display_name_truncated,
                    "starTypeName": star_type_name,
                    "starTypeNameTruncated": star_type_name_truncated,
                    "positionX": finite_number(profile.and_then(|value| value.get("positionX"))),
                    "positionY": finite_number(profile.and_then(|value| value.get("positionY"))),
                    "distanceFromOriginLy": non_negative_number(profile.and_then(|value| value.get("distanceFromOriginLy"))),
                    "luminosity": non_negative_number(profile.and_then(|value| value.get("luminosity"))),
                    "active": system.system_id == active_planet.system_id,
                    "unlocked": unlocked,
                    "missionActive": mission.is_some(),
                    "missionElapsedSeconds": non_negative_number(mission.and_then(|value| value.get("elapsedSeconds"))),
                    "missionDurationSeconds": non_negative_number(mission.and_then(|value| value.get("durationSeconds"))),
                    "surveyProgress": survey_progress,
                    "firstPlanetId": system.planet_indices.first().map(|index| self.catalog.planets[*index].id.as_str()),
                    "planetCount": system.planet_indices.len(),
                    "colonizedPlanetCount": colonized_count,
                    "entityCount": entity_count,
                    "deviceCount": device_count.max(0.0),
                    "beltCount": belt_count,
                    "stationCount": station_count,
                    "interstellarStationCount": interstellar_station_count,
                    "orbitalCollectorCount": orbital_collector_count,
                    "legacyStationCount": legacy_station_count,
                    "quantumStationCount": quantum_station_count,
                    "quantumAttachableCount": quantum_attachable_count,
                    "configuredImportSlotCount": import_slots,
                    "configuredExportSlotCount": export_slots,
                    "routeCount": route_count,
                    "activeRouteCount": active_route_count,
                    "generationKw": generation_kw,
                    "demandKw": demand_kw,
                    "powerFactor": if demand_kw > 0.0 { (served_demand_kw / demand_kw).clamp(0.0, 1.0) } else { 1.0 },
                }))
            })
            .collect::<anyhow::Result<Vec<_>>>()?;
        let unlocked_count = systems
            .iter()
            .filter(|system| {
                system.system_id == active_planet.system_id
                    || unlocked_systems.contains(system.system_id)
            })
            .count();
        let colonized_count = self
            .catalog
            .planets
            .iter()
            .filter(|planet| {
                planet.id == active_planet_id || colonized_planets.contains(planet.id.as_str())
            })
            .count();
        let total_systems = systems.len();
        let page = page_value(cursor, limit, total_systems, rows)?;
        finish_projection(json!({
            "schemaVersion": 1,
            "projectionType": STAR_MAP_SCHEMA,
            "revision": self.revision,
            "registryFingerprint": self.catalog.snapshot.registry_fingerprint,
            "stateVersion": self.identity.state_version,
            "limits": {
                "requestBytes": MAX_REQUEST_BYTES,
                "projectionBytes": MAX_PROJECTION_BYTES,
                "pageRows": MAX_PAGE_ROWS,
                "labelBytes": MAX_LABEL_BYTES,
            },
            "request": request,
            "activePlanetId": active_planet_id,
            "activeSystemId": active_planet.system_id,
            "galaxySeed": object_at(base, "galaxy")
                .and_then(|value| value.get("seed"))
                .and_then(Value::as_u64)
                .unwrap_or(0),
            "summary": {
                "systemCount": total_systems,
                "unlockedSystemCount": unlocked_count,
                "planetCount": self.catalog.planets.len(),
                "colonizedPlanetCount": colonized_count,
                "stationCount": station_scan.by_planet.iter().map(|value| value.station_count).sum::<usize>(),
            },
            "systems": page,
        }))
    }

    /// Returns independently pageable planet and logistics-station rows for
    /// the stellar-industry console. Optional system/planet selectors are
    /// catalog-validated and every station row carries direct focus IDs and
    /// finite world coordinates.
    #[allow(clippy::too_many_arguments)]
    pub fn stellar_industry_projection(
        &self,
        expected_revision: u64,
        expected_registry_fingerprint: &str,
        system_id: Option<&str>,
        planet_id: Option<&str>,
        planet_cursor: usize,
        planet_limit: usize,
        station_cursor: usize,
        station_limit: usize,
    ) -> anyhow::Result<Value> {
        validate_identity(self, expected_revision, expected_registry_fingerprint)?;
        validate_page(planet_cursor, planet_limit)?;
        validate_page(station_cursor, station_limit)?;
        let selected_planet_index = planet_id
            .map(|id| {
                self.catalog
                    .planets
                    .iter()
                    .position(|planet| planet.id == id)
                    .ok_or_else(|| anyhow!("native stellar planet selector is unknown"))
            })
            .transpose()?;
        if system_id.is_some_and(|id| {
            !self
                .catalog
                .planets
                .iter()
                .any(|planet| planet.system_id == id)
        }) {
            bail!("native stellar system selector is unknown");
        }
        if let (Some(system_id), Some(planet_index)) = (system_id, selected_planet_index)
            && self.catalog.planets[planet_index].system_id != system_id
        {
            bail!("native stellar selectors do not share a system");
        }
        let request = json!({
            "expectedRevision": expected_revision,
            "expectedRegistryFingerprint": expected_registry_fingerprint,
            "systemId": system_id,
            "planetId": planet_id,
            "planetCursor": planet_cursor,
            "planetLimit": planet_limit,
            "stationCursor": station_cursor,
            "stationLimit": station_limit,
        });
        validate_request(&request)?;

        let base = self.base_value();
        let active_planet_id = base
            .get("activePlanetId")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow!("native stellar active planet is invalid"))?;
        let active_planet = self
            .catalog
            .planets
            .iter()
            .find(|planet| planet.id == active_planet_id)
            .ok_or_else(|| anyhow!("native stellar active planet is missing"))?;
        let exploration = object_at(base, "exploration");
        let unlocked_systems =
            known_members(exploration.and_then(|value| value.get("unlockedSystemIds")));
        let colonized_planets =
            known_members(exploration.and_then(|value| value.get("colonizedPlanetIds")));
        let effective_system_filter = system_id.or_else(|| {
            selected_planet_index.map(|index| self.catalog.planets[index].system_id.as_str())
        });
        let station_scan = scan_stations(
            self,
            effective_system_filter,
            planet_id,
            Some((station_cursor, station_limit)),
        )?;
        let mut planet_indices = self
            .catalog
            .planets
            .iter()
            .enumerate()
            .filter(|(_, planet)| {
                effective_system_filter.is_none_or(|id| id == planet.system_id)
                    && planet_id.is_none_or(|id| id == planet.id)
            })
            .map(|(index, _)| index)
            .collect::<Vec<_>>();
        planet_indices.sort_unstable_by(|left, right| {
            self.catalog.planets[*left]
                .simulation_order
                .cmp(&self.catalog.planets[*right].simulation_order)
                .then_with(|| {
                    self.catalog.planets[*left]
                        .id
                        .cmp(&self.catalog.planets[*right].id)
                })
        });
        if planet_cursor > planet_indices.len() {
            bail!("native stellar planet cursor is invalid");
        }
        let planet_rows = planet_indices
            .iter()
            .skip(planet_cursor)
            .take(planet_limit)
            .map(|&planet_index| {
                let planet = &self.catalog.planets[planet_index];
                let logistics = &station_scan.by_planet[planet_index];
                let (display_name, display_name_truncated) = planet_label(self, planet_index);
                let (system_display_name, system_name_truncated) =
                    system_label(self, &planet.system_id);
                let profile = planet_profile(base, &planet.id);
                let star_profile = system_profile(base, &planet.system_id);
                let metrics = planet_metrics(base, &planet.id);
                let (climate_name, climate_name_truncated) = bounded_label(
                    profile
                        .and_then(|value| value.get("climateName"))
                        .and_then(Value::as_str),
                    &planet.kind,
                );
                let (specialization_name, specialization_name_truncated) = bounded_label(
                    profile
                        .and_then(|value| value.get("specializationName"))
                        .and_then(Value::as_str),
                    "",
                );
                let power = json!({
                    "generationKw": non_negative_number(metrics.and_then(|value| value.get("generationKw"))),
                    "demandKw": non_negative_number(metrics.and_then(|value| value.get("demandKw"))),
                    "powerFactor": unit_number_or(metrics.and_then(|value| value.get("powerFactor")), 1.0),
                    "totalItemsPerMinute": non_negative_number(metrics.and_then(|value| value.get("totalItemsPerMinute"))),
                });
                let profile_row = json!({
                    "climateName": climate_name,
                    "climateNameTruncated": climate_name_truncated,
                    "oceanType": bounded_token(profile.and_then(|value| value.get("oceanType"))),
                    "specialization": bounded_token(profile.and_then(|value| value.get("specialization"))),
                    "specializationName": specialization_name,
                    "specializationNameTruncated": specialization_name_truncated,
                    "tidalLocked": profile.and_then(|value| value.get("tidalLocked")).and_then(Value::as_bool).unwrap_or(false),
                    "windMultiplier": non_negative_number(profile.and_then(|value| value.get("windMultiplier"))),
                    "solarMultiplier": non_negative_number(profile.and_then(|value| value.get("solarMultiplier"))),
                    "geothermalMultiplier": non_negative_number(profile.and_then(|value| value.get("geothermalMultiplier"))),
                    "miningMultiplier": non_negative_number(profile.and_then(|value| value.get("miningMultiplier"))),
                    "orbitalYieldMultiplier": non_negative_number(profile.and_then(|value| value.get("orbitalYieldMultiplier"))),
                    "reserveScale": non_negative_number(profile.and_then(|value| value.get("reserveScale"))),
                    "travelTimeMultiplier": non_negative_number(profile.and_then(|value| value.get("travelTimeMultiplier"))),
                });
                let mut row = json!({
                    "planetId": planet.id,
                    "displayName": display_name,
                    "displayNameTruncated": display_name_truncated,
                    "systemId": planet.system_id,
                    "systemDisplayName": system_display_name,
                    "systemDisplayNameTruncated": system_name_truncated,
                    "kind": planet.kind,
                    "orbitIndex": planet.orbit_index,
                    "simulationOrder": planet.simulation_order,
                    "systemPositionX": finite_number(star_profile.and_then(|value| value.get("positionX"))),
                    "systemPositionY": finite_number(star_profile.and_then(|value| value.get("positionY"))),
                    "active": planet.id == active_planet_id,
                    "discovered": planet.system_id == active_planet.system_id || unlocked_systems.contains(planet.system_id.as_str()),
                    "colonized": planet.id == active_planet_id || colonized_planets.contains(planet.id.as_str()),
                    "industryRole": nested_object(object_at(base, "galaxy"), "planetRoles")
                        .and_then(|roles| roles.get(&planet.id))
                        .and_then(Value::as_str)
                        .filter(|role| matches!(*role, "auto" | "mining" | "smelting" | "manufacturing" | "chemical" | "research" | "logistics" | "power"))
                        .unwrap_or("auto"),
                })
                .as_object()
                .expect("literal planet identity row")
                .clone();
                row.extend(
                    json!({
                    "entityCount": self.factory_topology.entities_by_planet[planet_index].len(),
                    "deviceCount": self.factory_topology.device_counts_by_planet[planet_index].max(0.0),
                    "beltCount": self.factory_topology.belt_counts_by_planet[planet_index],
                    "stationCount": logistics.station_count,
                    "interstellarStationCount": logistics.interstellar_station_count,
                    "orbitalCollectorCount": logistics.orbital_collector_count,
                    "legacyStationCount": logistics.legacy_station_count,
                    "quantumStationCount": logistics.quantum_station_count,
                    "quantumAttachableCount": logistics.quantum_attachable_count,
                    "configuredImportSlotCount": logistics.configured_import_slots,
                    "configuredExportSlotCount": logistics.configured_export_slots,
                    "routeCount": logistics.route_count,
                    "activeRouteCount": logistics.active_route_count,
                    "congestedStationId": logistics.congested_station_id.as_deref(),
                    "power": power,
                    "profile": profile_row,
                })
                    .as_object()
                    .expect("literal planet industry row")
                    .clone(),
                );
                Value::Object(row)
            })
            .collect::<Vec<_>>();
        let planet_total = planet_indices.len();
        let station_total = station_scan.total_matching;
        let planet_page = page_value(planet_cursor, planet_limit, planet_total, planet_rows)?;
        let station_page = page_value(
            station_cursor,
            station_limit,
            station_total,
            station_scan.rows,
        )?;
        let truncated =
            planet_page["nextCursor"].is_number() || station_page["nextCursor"].is_number();
        finish_projection(json!({
            "schemaVersion": 1,
            "projectionType": STELLAR_INDUSTRY_SCHEMA,
            "revision": self.revision,
            "registryFingerprint": self.catalog.snapshot.registry_fingerprint,
            "stateVersion": self.identity.state_version,
            "limits": {
                "requestBytes": MAX_REQUEST_BYTES,
                "projectionBytes": MAX_PROJECTION_BYTES,
                "pageRows": MAX_PAGE_ROWS,
                "labelBytes": MAX_LABEL_BYTES,
            },
            "request": request,
            "activePlanetId": active_planet_id,
            "activeSystemId": active_planet.system_id,
            "scopeSystemId": effective_system_filter,
            "scopePlanetId": planet_id,
            "truncated": truncated,
            "planets": planet_page,
            "stations": station_page,
        }))
    }

    /// Extends the v1 stellar-industry read model with an independently
    /// pageable route table. Route rows are calculated scalars tied to this
    /// exact revision; station-slot and station-route arrays never cross the
    /// native boundary.
    #[allow(clippy::too_many_arguments)]
    pub fn stellar_industry_v2_projection(
        &self,
        expected_revision: u64,
        expected_registry_fingerprint: &str,
        system_id: Option<&str>,
        planet_id: Option<&str>,
        planet_cursor: usize,
        planet_limit: usize,
        station_cursor: usize,
        station_limit: usize,
        route_cursor: usize,
        route_limit: usize,
        route_filter: &str,
        query: &str,
    ) -> anyhow::Result<Value> {
        validate_identity(self, expected_revision, expected_registry_fingerprint)?;
        validate_page(route_cursor, route_limit)?;
        if !route_filter_is_valid(route_filter) {
            bail!("native stellar route filter is invalid");
        }
        validate_route_query(query)?;
        let request = json!({
            "expectedRevision": expected_revision,
            "expectedRegistryFingerprint": expected_registry_fingerprint,
            "systemId": system_id,
            "planetId": planet_id,
            "planetCursor": planet_cursor,
            "planetLimit": planet_limit,
            "stationCursor": station_cursor,
            "stationLimit": station_limit,
            "routeCursor": route_cursor,
            "routeLimit": route_limit,
            "routeFilter": route_filter,
            "query": query,
        });
        validate_request(&request)?;

        // Reuse the v1 implementation rather than duplicating its stable
        // planet/station read model. The final byte gate is repeated after
        // the route page is attached.
        let mut projection = self.stellar_industry_projection(
            expected_revision,
            expected_registry_fingerprint,
            system_id,
            planet_id,
            planet_cursor,
            planet_limit,
            station_cursor,
            station_limit,
        )?;
        let effective_system_id = planet_id
            .and_then(|planet_id| {
                self.catalog
                    .planets
                    .iter()
                    .find(|planet| planet.id == planet_id)
            })
            .map(|planet| planet.system_id.as_str())
            .or(system_id);
        let mut scoped = build_route_snapshots(self)?
            .into_iter()
            .filter(|snapshot| route_scope_matches(self, snapshot, effective_system_id, planet_id))
            .collect::<Vec<_>>();
        let scope_total_count = scoped.len();
        let active_count = scoped
            .iter()
            .filter(|snapshot| snapshot.status == "active")
            .count();
        let blocked_count = scoped
            .iter()
            .filter(|snapshot| route_status_is_issue(snapshot.status))
            .count();
        let remote_count = scoped
            .iter()
            .filter(|snapshot| snapshot.scope == "remote")
            .count();
        let planning_incomplete_count = scoped
            .iter()
            .filter(|snapshot| {
                snapshot
                    .row
                    .get("routePlanningComplete")
                    .and_then(Value::as_bool)
                    == Some(false)
            })
            .count();
        let power_unproven_count = scoped
            .iter()
            .filter(|snapshot| {
                snapshot
                    .row
                    .get("powerProofComplete")
                    .and_then(Value::as_bool)
                    == Some(false)
            })
            .count();
        let mut status_counts = BTreeMap::<&str, usize>::new();
        for snapshot in &scoped {
            *status_counts.entry(snapshot.status).or_default() += 1;
        }
        let normalized_query = query.trim().to_lowercase();
        scoped.retain(|snapshot| {
            (route_filter != "remote" || snapshot.scope == "remote")
                && (route_filter != "issues" || route_status_is_issue(snapshot.status))
                && route_query_matches(snapshot, &normalized_query)
        });
        if route_cursor > scoped.len() {
            bail!("native stellar route cursor is invalid");
        }
        let filtered_count = scoped.len();
        let route_rows = scoped
            .into_iter()
            .skip(route_cursor)
            .take(route_limit)
            .map(|snapshot| snapshot.row)
            .collect::<Vec<_>>();
        let route_page = page_value(route_cursor, route_limit, filtered_count, route_rows)?;
        let object = projection
            .as_object_mut()
            .ok_or_else(|| anyhow!("native stellar v1 projection is invalid"))?;
        object.insert("schemaVersion".to_owned(), json!(2));
        object.insert(
            "projectionType".to_owned(),
            json!(STELLAR_INDUSTRY_V2_SCHEMA),
        );
        object.insert("request".to_owned(), request);
        let limits = object
            .get_mut("limits")
            .and_then(Value::as_object_mut)
            .ok_or_else(|| anyhow!("native stellar projection limits are invalid"))?;
        limits.insert("queryBytes".to_owned(), json!(MAX_QUERY_BYTES));
        limits.insert("pathVisits".to_owned(), json!(MAX_PATH_VISITS));
        object.insert(
            "routeSummary".to_owned(),
            json!({
                "scopeTotalCount": scope_total_count,
                "filteredCount": filtered_count,
                "activeCount": active_count,
                "blockedCount": blocked_count,
                "remoteCount": remote_count,
                "routePlanningIncompleteCount": planning_incomplete_count,
                "powerUnprovenCount": power_unproven_count,
                "statusCounts": status_counts,
            }),
        );
        let route_truncated = route_page["nextCursor"].is_number();
        object.insert("routes".to_owned(), route_page);
        let already_truncated = object
            .get("truncated")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        object.insert(
            "truncated".to_owned(),
            json!(already_truncated || route_truncated),
        );
        finish_projection(projection)
    }

    /// Returns a revision-bound, independently paged view of the shared
    /// quantum inventory and orbital-collector attachment state. Decimal
    /// quantities remain canonical strings so the renderer never rounds a
    /// large inventory through JavaScript `number`.
    pub fn stellar_quantum_projection(
        &self,
        expected_revision: u64,
        expected_registry_fingerprint: &str,
        item_cursor: usize,
        item_limit: usize,
        collector_cursor: usize,
        collector_limit: usize,
    ) -> anyhow::Result<Value> {
        validate_identity(self, expected_revision, expected_registry_fingerprint)?;
        validate_page(item_cursor, item_limit)?;
        validate_page(collector_cursor, collector_limit)?;
        if self.catalog.snapshot.items.len() > MAX_QUANTUM_ITEM_ROWS {
            bail!("native stellar quantum catalog exceeds the bounded item limit");
        }

        let request = json!({
            "expectedRevision": expected_revision,
            "expectedRegistryFingerprint": expected_registry_fingerprint,
            "itemCursor": item_cursor,
            "itemLimit": item_limit,
            "collectorCursor": collector_cursor,
            "collectorLimit": collector_limit,
        });
        validate_request(&request)?;

        let base = self.base_value();
        let network = match base.get("quantumLogisticsNetwork") {
            None => None,
            Some(Value::Object(network)) => Some(network),
            Some(_) => bail!("native stellar quantum network is not an object"),
        };
        let enabled = match network.and_then(|value| value.get("enabled")) {
            None => false,
            Some(Value::Bool(enabled)) => *enabled,
            Some(_) => bail!("native stellar quantum enabled flag is invalid"),
        };
        let inventory = strict_quantity_record(
            network.and_then(|value| value.get("inventory")),
            self,
            "inventory",
            false,
        )?;
        let capacities = strict_quantity_record(
            network.and_then(|value| value.get("itemCapacities")),
            self,
            "item capacities",
            true,
        )?;
        let runtime = match network.and_then(|value| value.get("runtimeFlow")) {
            None => None,
            Some(Value::Object(runtime)) => Some(runtime),
            Some(_) => bail!("native stellar quantum runtime flow is invalid"),
        };
        let uploaded = strict_quantity_record(
            runtime.and_then(|value| value.get("uploaded")),
            self,
            "runtime uploaded totals",
            false,
        )?;
        let downloaded = strict_quantity_record(
            runtime.and_then(|value| value.get("downloaded")),
            self,
            "runtime downloaded totals",
            false,
        )?;
        let runtime_summary = runtime
            .map(|runtime| {
                Ok::<Value, anyhow::Error>(json!({
                    "boundarySecond": strict_safe_integer(runtime.get("boundarySecond"), "runtime boundary")?,
                    "globalUploadPerMinute": strict_non_negative_number(runtime.get("globalUploadPerMinute"), "runtime upload bandwidth")?,
                    "globalDownloadPerMinute": strict_non_negative_number(runtime.get("globalDownloadPerMinute"), "runtime download bandwidth")?,
                    "quantumTowerStacks": strict_safe_integer(runtime.get("quantumTowerStacks"), "runtime tower stacks")?,
                    "quantumCollectorStacks": strict_safe_integer(runtime.get("quantumCollectorStacks"), "runtime collector stacks")?,
                }))
            })
            .transpose()?;

        let item_rows = self
            .catalog
            .snapshot
            .items
            .iter()
            .skip(item_cursor)
            .take(item_limit)
            .map(|item| {
                let inventory = inventory
                    .and_then(|record| record.get(&item.id))
                    .map_or(Ok("0"), |value| {
                        strict_decimal_string(Some(value), "inventory")
                    })?;
                let capacity = capacities
                    .and_then(|record| record.get(&item.id))
                    .map_or(Ok(QUANTUM_ITEM_CAPACITY_MAX), |value| {
                        strict_decimal_string(Some(value), "item capacity")
                    })?;
                let uploaded = uploaded
                    .and_then(|record| record.get(&item.id))
                    .map_or(Ok("0"), |value| {
                        strict_decimal_string(Some(value), "runtime uploaded total")
                    })?;
                let downloaded = downloaded
                    .and_then(|record| record.get(&item.id))
                    .map_or(Ok("0"), |value| {
                        strict_decimal_string(Some(value), "runtime downloaded total")
                    })?;
                Ok(json!({
                    "itemId": item.id,
                    "inventory": inventory,
                    "capacity": capacity,
                    "uploaded": uploaded,
                    "downloaded": downloaded,
                }))
            })
            .collect::<anyhow::Result<Vec<_>>>()?;
        if item_cursor > self.catalog.snapshot.items.len() {
            bail!("native stellar quantum item cursor is invalid");
        }

        let collector_scan = scan_quantum_collectors(self)?;
        if collector_cursor > collector_scan.total_count {
            bail!("native stellar quantum collector cursor is invalid");
        }
        let collector_rows = collector_scan
            .rows
            .iter()
            .skip(collector_cursor)
            .take(collector_limit)
            .cloned()
            .collect::<Vec<_>>();

        let level = quantum_logistics_level_strict(base)? as f64;
        let multiplier_base = 1.0 + 0.05 * level;
        let multiplier = multiplier_base * multiplier_base;
        let global_bandwidth =
            QUANTUM_UNIT_CAP_PER_MINUTE * multiplier * collector_scan.active_tower_stacks as f64;
        if !multiplier.is_finite() || !global_bandwidth.is_finite() {
            bail!("native stellar quantum bandwidth exceeds the finite range");
        }

        let item_page = page_value(
            item_cursor,
            item_limit,
            self.catalog.snapshot.items.len(),
            item_rows,
        )?;
        let collector_page = page_value(
            collector_cursor,
            collector_limit,
            collector_scan.total_count,
            collector_rows,
        )?;
        let truncated =
            item_page["nextCursor"].is_number() || collector_page["nextCursor"].is_number();
        finish_projection(json!({
            "schemaVersion": 1,
            "projectionType": STELLAR_QUANTUM_SCHEMA,
            "revision": self.revision,
            "registryFingerprint": self.catalog.snapshot.registry_fingerprint,
            "stateVersion": 47,
            "limits": {
                "requestBytes": MAX_REQUEST_BYTES,
                "projectionBytes": MAX_PROJECTION_BYTES,
                "pageRows": MAX_PAGE_ROWS,
                "decimalDigits": MAX_DECIMAL_DIGITS,
            },
            "request": request,
            "enabled": enabled,
            "bandwidth": {
                "multiplier": multiplier,
                "globalUploadPerMinute": global_bandwidth,
                "globalDownloadPerMinute": global_bandwidth,
                "activeTowerCount": collector_scan.active_tower_count,
                "activeTowerStacks": collector_scan.active_tower_stacks,
            },
            "runtime": runtime_summary,
            "collectorSummary": {
                "totalCount": collector_scan.total_count,
                "connectedCount": collector_scan.connected_count,
                "pendingCount": collector_scan.pending_count,
                "availableCount": collector_scan.available_count,
                "connectedStacks": collector_scan.connected_stacks,
            },
            "truncated": truncated,
            "items": item_page,
            "collectors": collector_page,
        }))
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use serde_json::json;

    use super::*;
    use crate::catalog::{
        BuildingDefinition, CatalogSnapshot, ItemDefinition, PlanetDefinition, RuntimeCatalog,
    };
    use crate::state::CoreCheckpointIdentity;

    fn building() -> BuildingDefinition {
        BuildingDefinition {
            id: "interstellar_logistics_station".to_owned(),
            kind: "station".to_owned(),
            speed: 1.0,
            input_capacity: 10_000.0,
            output_capacity: 10_000.0,
            power_demand_kw: 1_000.0,
            power_generation_kw: 0.0,
            power_charge_kw: 0.0,
            energy_capacity_mj: 0.0,
            fuel_item_ids: Vec::new(),
            fuel_efficiency: 1.0,
            family: None,
            accepts: None,
        }
    }

    fn orbital_collector_building() -> BuildingDefinition {
        BuildingDefinition {
            id: "orbital_collector".to_owned(),
            kind: "station".to_owned(),
            speed: 1.0,
            input_capacity: 10_000.0,
            output_capacity: 10_000.0,
            power_demand_kw: 1_000.0,
            power_generation_kw: 0.0,
            power_charge_kw: 0.0,
            energy_capacity_mj: 0.0,
            fuel_item_ids: Vec::new(),
            fuel_efficiency: 1.0,
            family: None,
            accepts: None,
        }
    }

    fn catalog(planets: Vec<PlanetDefinition>, fingerprint: &str) -> RuntimeCatalog {
        RuntimeCatalog::validate(
            CatalogSnapshot {
                protocol_version: 1,
                registry_fingerprint: fingerprint.to_owned(),
                planets,
                items: vec![
                    ItemDefinition {
                        id: "iron_ore".to_owned(),
                        name: "铁矿".to_owned(),
                        kind: "solid".to_owned(),
                        fuel_energy_mj: 0.0,
                    },
                    ItemDefinition {
                        id: "copper_ore".to_owned(),
                        name: "铜矿".to_owned(),
                        kind: "solid".to_owned(),
                        fuel_energy_mj: 0.0,
                    },
                ],
                buildings: vec![building(), orbital_collector_building()],
                recipes: Vec::new(),
                constructions: Vec::new(),
                belts: Vec::new(),
                proliferators: Vec::new(),
                technologies: Vec::new(),
            },
            fingerprint,
        )
        .unwrap()
    }

    fn planet(id: &str, name: &str, system_id: &str, order: u16, orbit: u16) -> PlanetDefinition {
        PlanetDefinition {
            id: id.to_owned(),
            name: name.to_owned(),
            system_id: system_id.to_owned(),
            kind: "terrestrial".to_owned(),
            orbit_index: orbit,
            simulation_order: order,
            orbital_yields: HashMap::new(),
        }
    }

    fn station(
        id: &str,
        planet_id: &str,
        x: f64,
        y: f64,
        tier: u8,
        quantum_mode: &str,
        congestion: f64,
    ) -> String {
        json!({
            "id": id,
            "kind": "station",
            "planetId": planet_id,
            "position": { "x": x, "y": y },
            "buildingId": "interstellar_logistics_station",
            "machineCount": 1,
            "minerCount": 0,
            "inputs": {},
            "outputs": {},
            "stationTier": tier,
            "quantumMode": quantum_mode,
            "powerFactor": 0.75,
            "stationCongestion": congestion,
            "stationDrones": 30,
            "stationVessels": 10,
            "stationWarpers": 9,
            "stationSlots": [
                { "itemId": "iron_ore", "localMode": "storage", "remoteMode": "supply" },
                { "itemId": "iron_ore", "localMode": "storage", "remoteMode": "demand" }
            ],
            "stationRoutes": [{
                "scope": "remote",
                "slotIndex": 1,
                "peerId": id,
                "itemId": "iron_ore",
                "vehicleCount": 1,
                "cargo": 100,
                "vehicleStationId": id,
                "requiresWarp": false,
                "waypointStationIds": [],
                "warpersPerVessel": 0
            }]
        })
        .to_string()
    }

    fn power_source(id: &str, planet_id: &str) -> String {
        json!({
            "id": id,
            "kind": "power",
            "planetId": planet_id,
            "position": { "x": 0, "y": 0 },
            "machineCount": 0,
            "minerCount": 0,
            "inputs": {},
            "outputs": {}
        })
        .to_string()
    }

    fn state() -> CoreState {
        let planets = vec![
            planet("home", "母星", "helios", 0, 1),
            planet("ashen", "灰烬", "helios", 1, 2),
            planet("tau-one", "远境", "tau", 2, 1),
        ];
        let base = json!({
            "version": 47,
            "mode": "normal",
            "activePlanetId": "home",
            "paused": false,
            "settings": {},
            "tray": {},
            "planetTrays": {},
            "exploration": {
                "unlockedSystemIds": ["helios", "tau"],
                "colonizedPlanetIds": ["home", "ashen"],
                "missions": [{ "systemId": "tau", "elapsedSeconds": 4, "durationSeconds": 10 }],
                "surveyProgressBySystem": { "helios": 1, "tau": 0.4 }
            },
            "galaxy": {
                "seed": 42,
                "systemProfiles": {
                    "helios": { "starTypeName": "G 型恒星", "luminosity": 1.2, "positionX": 12.5, "positionY": -4, "distanceFromOriginLy": 0 },
                    "tau": { "starTypeName": "红矮星", "luminosity": 0.7, "positionX": 30, "positionY": 40, "distanceFromOriginLy": 50 }
                },
                "profiles": {
                    "home": { "climateName": "温带", "oceanType": "water", "specialization": "balanced", "specializationName": "均衡工业", "tidalLocked": false, "windMultiplier": 1.1, "solarMultiplier": 1.2, "geothermalMultiplier": 0.8, "miningMultiplier": 1, "orbitalYieldMultiplier": 1, "reserveScale": 1.5, "travelTimeMultiplier": 1, "productionSpeedMultiplier": 1.05, "surveyDurationSeconds": 60, "resourceIds": ["iron_ore", "copper_ore"], "rareResourceIds": ["copper_ore"], "orbitalYields": { "copper_ore": 0.25 } },
                    "ashen": { "climateName": "荒漠", "oceanType": "none", "specialization": "smelting", "specializationName": "冶炼", "tidalLocked": true },
                    "tau-one": { "climateName": "冰原", "oceanType": "ice", "specialization": "logistics", "specializationName": "物流" }
                },
                "planetRoles": { "home": "manufacturing", "ashen": "smelting", "tau-one": "auto" },
                "planetMetadata": { "home": { "note": "主生产基地", "tags": ["白糖", "科研"] }, "ashen": { "customName": "灰烬前哨" } },
                "systemMetadata": { "helios": { "customName": "太阳系" } }
            },
            "planetMetrics": {
                "home": { "generationKw": 1200, "demandKw": 1000, "powerFactor": 1, "totalItemsPerMinute": 500 },
                "ashen": { "generationKw": 500, "demandKw": 800, "powerFactor": 0.5, "totalItemsPerMinute": 200 },
                "tau-one": { "generationKw": 100, "demandKw": 0, "powerFactor": 1, "totalItemsPerMinute": 0 }
            }
        })
        .as_object()
        .unwrap()
        .clone();
        let entities = vec![
            json!({
                "id": "machine-home", "kind": "machine", "planetId": "home",
                "position": { "x": 0, "y": 0 }, "machineCount": 3, "minerCount": 0,
                "inputs": {}, "outputs": {}
            })
            .to_string(),
            station("station-home", "home", 99.0, 101.0, 1, "legacy", 0.2),
            station("station-ashen", "ashen", -10.0, 25.0, 2, "legacy", 0.9),
            station("station-tau", "tau-one", 1.0, 2.0, 2, "quantum", 0.0),
            power_source("power-home", "home"),
            power_source("power-ashen", "ashen"),
            power_source("power-tau", "tau-one"),
        ];
        CoreState::from_public_v47_parts(
            CoreCheckpointIdentity {
                slot: "normal-main".to_owned(),
                generation: 3,
                root_hash: "a".repeat(64),
                revision: 41,
                state_version: 47,
                mode: "normal".to_owned(),
                registry_fingerprint: "stellar-test".to_owned(),
                base_primary_checksum: "12345678".to_owned(),
            },
            base,
            entities,
            Vec::new(),
            catalog(planets, "stellar-test"),
        )
        .unwrap()
    }

    fn route_state() -> CoreState {
        let planets = vec![
            planet("source-world", "源星", "alpha", 0, 1),
            planet("hub-world", "枢纽星", "beta", 1, 1),
            planet("target-world", "目标星", "gamma", 2, 1),
        ];
        let empty_slot = || {
            json!({
                "localMode": "storage",
                "remoteMode": "storage",
                "minimumLoad": 1,
                "minStock": 0,
                "maxStock": 0,
                "priority": 1,
                "routePolicy": "relay-preferred",
                "warperBudget": 2
            })
        };
        let source_slots = vec![
            json!({
                "itemId": "iron_ore",
                "localMode": "storage",
                "remoteMode": "supply",
                "minimumLoad": 1,
                "minStock": 50,
                "maxStock": 500,
                "priority": 2,
                "routePolicy": "relay-preferred",
                "warperBudget": 2
            }),
            empty_slot(),
            empty_slot(),
            empty_slot(),
            empty_slot(),
        ];
        let target_slots = vec![
            json!({
                "itemId": "iron_ore",
                "localMode": "storage",
                "remoteMode": "demand",
                "minimumLoad": 0.5,
                "minStock": 11,
                "maxStock": 200,
                "priority": 2,
                "routePolicy": "relay-required",
                "warperBudget": 2
            }),
            empty_slot(),
            empty_slot(),
            empty_slot(),
            empty_slot(),
        ];
        let storage_slots = vec![
            empty_slot(),
            empty_slot(),
            empty_slot(),
            empty_slot(),
            empty_slot(),
        ];
        let entity = |id: &str,
                      planet_id: &str,
                      outputs: Value,
                      slots: Vec<Value>,
                      vessels: u64,
                      warpers: u64,
                      congestion: f64,
                      extra: Value| {
            let mut value = json!({
                "id": id,
                "kind": "station",
                "planetId": planet_id,
                "position": { "x": 0, "y": 0 },
                "buildingId": "interstellar_logistics_station",
                "machineCount": 1,
                "minerCount": 0,
                "inputs": {},
                "outputs": outputs,
                "stationTier": 1,
                "quantumMode": "legacy",
                "powerFactor": 1,
                "stationCongestion": congestion,
                "stationDrones": 0,
                "stationVessels": vessels,
                "stationWarpers": warpers,
                "stationWarpEnabled": true,
                "stationSlots": slots,
                "stationRoutes": []
            });
            value
                .as_object_mut()
                .unwrap()
                .extend(extra.as_object().unwrap().clone());
            value.to_string()
        };
        let entities = vec![
            entity(
                "station-source",
                "source-world",
                json!({ "iron_ore": 500 }),
                source_slots,
                2,
                10,
                0.2,
                json!({}),
            ),
            entity(
                "station-hub",
                "hub-world",
                json!({}),
                storage_slots,
                0,
                0,
                0.6,
                json!({ "stationHubEnabled": true, "stationHubPriority": 2 }),
            ),
            entity(
                "station-target",
                "target-world",
                json!({ "iron_ore": 25 }),
                target_slots,
                3,
                0,
                0.9,
                json!({
                    "stationRoutes": [{
                        "scope": "remote",
                        "slotIndex": 0,
                        "peerId": "station-source",
                        "itemId": "iron_ore",
                        "vehicleCount": 1,
                        "cargo": 50,
                        "vehicleStationId": "station-source",
                        "requiresWarp": true,
                        "waypointStationIds": ["station-hub"],
                        "warpersPerVessel": 2
                    }]
                }),
            ),
            power_source("power-source", "source-world"),
            power_source("power-hub", "hub-world"),
            power_source("power-target", "target-world"),
        ];
        let base = json!({
            "version": 47,
            "mode": "normal",
            "activePlanetId": "source-world",
            "paused": false,
            "settings": { "difficulty": "standard", "logisticsBufferLimit": 1_000_000 },
            "tray": {},
            "planetTrays": {},
            "research": { "completedTechIds": ["space_warp"] },
            "endgame": { "infiniteResearch": {} },
            "exploration": {
                "unlockedSystemIds": ["alpha", "beta", "gamma"],
                "colonizedPlanetIds": ["source-world", "hub-world", "target-world"],
                "missions": [],
                "surveyProgressBySystem": { "alpha": 1, "beta": 1, "gamma": 1 }
            },
            "galaxy": {
                "seed": 9,
                "systemProfiles": {
                    "alpha": { "positionX": 0, "positionY": 0 },
                    "beta": { "positionX": 8, "positionY": 0 },
                    "gamma": { "positionX": 16, "positionY": 0 }
                },
                "profiles": {
                    "source-world": { "travelTimeMultiplier": 1 },
                    "hub-world": { "travelTimeMultiplier": 1 },
                    "target-world": { "travelTimeMultiplier": 1 }
                },
                "planetMetadata": {},
                "systemMetadata": {
                    "alpha": { "customName": "阿尔法" },
                    "beta": { "customName": "贝塔" },
                    "gamma": { "customName": "伽马" }
                },
                "planetRoles": {}
            },
            "planetMetrics": {
                "source-world": { "generationKw": 1, "demandKw": 1, "powerFactor": 1 },
                "hub-world": { "generationKw": 1, "demandKw": 1, "powerFactor": 1 },
                "target-world": { "generationKw": 1, "demandKw": 1, "powerFactor": 1 }
            }
        })
        .as_object()
        .unwrap()
        .clone();
        CoreState::from_public_v47_parts(
            CoreCheckpointIdentity {
                slot: "normal-main".to_owned(),
                generation: 2,
                root_hash: "c".repeat(64),
                revision: 55,
                state_version: 47,
                mode: "normal".to_owned(),
                registry_fingerprint: "stellar-route-test".to_owned(),
                base_primary_checksum: "12345678".to_owned(),
            },
            base,
            entities,
            Vec::new(),
            catalog(planets, "stellar-route-test"),
        )
        .unwrap()
    }

    fn quantum_state() -> CoreState {
        let planets = vec![planet("home", "母星", "helios", 0, 1)];
        let endpoint =
            |id: &str, building_id: &str, machine_count: u64, mode: &str, transition: Value| {
                json!({
                    "id": id,
                    "kind": "station",
                    "planetId": "home",
                    "position": { "x": 0, "y": 0 },
                    "buildingId": building_id,
                    "machineCount": machine_count,
                    "minerCount": 0,
                    "inputs": {},
                    "outputs": {},
                    "stationTier": 2,
                    "quantumMode": mode,
                    "quantumTransition": transition,
                    "stationSlots": [],
                    "stationRoutes": []
                })
                .to_string()
            };
        let base = json!({
            "version": 47,
            "mode": "normal",
            "activePlanetId": "home",
            "paused": false,
            "settings": {},
            "tray": {},
            "planetTrays": {},
            "research": { "completedTechIds": [] },
            "endgame": {
                "infiniteResearch": {
                    "galactic_logistics": { "level": 2, "progress": "0" }
                }
            },
            "exploration": {
                "unlockedSystemIds": ["helios"],
                "colonizedPlanetIds": ["home"],
                "missions": [],
                "surveyProgressBySystem": { "helios": 1 }
            },
            "galaxy": {
                "seed": 42,
                "systemProfiles": { "helios": {} },
                "profiles": { "home": {} },
                "planetRoles": {},
                "planetMetadata": {},
                "systemMetadata": {}
            },
            "planetMetrics": {},
            "quantumLogisticsNetwork": {
                "enabled": true,
                "inventory": { "iron_ore": "123456789012345678901234567890" },
                "itemCapacities": { "iron_ore": "100000" },
                "routingCursors": {},
                "uploadRoutingCursors": {},
                "runtimeFlow": {
                    "boundarySecond": 25,
                    "uploaded": { "iron_ore": "7" },
                    "downloaded": { "iron_ore": "2" },
                    "globalUploadPerMinute": 18150,
                    "globalDownloadPerMinute": 18150,
                    "quantumTowerStacks": 3,
                    "quantumCollectorStacks": 5
                }
            }
        })
        .as_object()
        .unwrap()
        .clone();
        CoreState::from_public_v47_parts(
            CoreCheckpointIdentity {
                slot: "normal-main".to_owned(),
                generation: 4,
                root_hash: "d".repeat(64),
                revision: 61,
                state_version: 47,
                mode: "normal".to_owned(),
                registry_fingerprint: "stellar-quantum-test".to_owned(),
                base_primary_checksum: "12345678".to_owned(),
            },
            base,
            vec![
                endpoint(
                    "tower-connected",
                    "interstellar_logistics_station",
                    3,
                    "quantum",
                    Value::Null,
                ),
                endpoint(
                    "collector-connected",
                    "orbital_collector",
                    5,
                    "quantum",
                    Value::Null,
                ),
                endpoint(
                    "collector-pending",
                    "orbital_collector",
                    7,
                    "transitioning",
                    json!({ "targetMode": "quantum" }),
                ),
                endpoint(
                    "collector-available",
                    "orbital_collector",
                    11,
                    "legacy",
                    Value::Null,
                ),
            ],
            Vec::new(),
            catalog(planets, "stellar-quantum-test"),
        )
        .unwrap()
    }

    #[test]
    fn star_map_page_is_revision_bound_deterministic_and_read_only() {
        let state = state();
        let before = state.canonical_sha256().unwrap();
        let first = state
            .star_map_overview_projection(41, "stellar-test", 0, 1)
            .unwrap();
        assert_eq!(first["projectionType"], STAR_MAP_SCHEMA);
        assert_eq!(first["revision"], 41);
        assert_eq!(first["systems"]["totalCount"], 2);
        assert_eq!(first["systems"]["nextCursor"], 1);
        assert_eq!(first["systems"]["rows"][0]["systemId"], "helios");
        assert_eq!(first["systems"]["rows"][0]["displayName"], "太阳系");
        assert_eq!(first["systems"]["rows"][0]["positionX"], 12.5);
        assert_eq!(first["systems"]["rows"][0]["stationCount"], 2);
        assert_eq!(first["systems"]["rows"][0]["legacyStationCount"], 1);
        assert_eq!(first["systems"]["rows"][0]["quantumAttachableCount"], 1);
        assert_eq!(first["systems"]["rows"][0]["deviceCount"], 5.0);
        assert_eq!(first["systems"]["rows"][0]["routeCount"], 2);
        assert_eq!(first["systems"]["rows"][0]["powerFactor"], 7.0 / 9.0);
        let repeated = state
            .star_map_overview_projection(41, "stellar-test", 0, 1)
            .unwrap();
        assert_eq!(first, repeated);
        let second = state
            .star_map_overview_projection(41, "stellar-test", 1, 1)
            .unwrap();
        assert_eq!(second["systems"]["rows"][0]["systemId"], "tau");
        assert_eq!(second["systems"]["nextCursor"], Value::Null);
        assert!(serde_json::to_vec(&first).unwrap().len() <= MAX_PROJECTION_BYTES);
        assert_eq!(state.canonical_sha256().unwrap(), before);
    }

    #[test]
    fn star_map_catalog_pages_all_systems_and_planets_without_industry_scope() {
        let state = state();
        let before = state.canonical_sha256().unwrap();
        let first = state
            .star_map_catalog_projection(41, "stellar-test", 0, 1, 0, 1)
            .unwrap();
        assert_eq!(first["projectionType"], STAR_MAP_CATALOG_SCHEMA);
        assert_eq!(first["revision"], 41);
        assert_eq!(first["systems"]["totalCount"], 2);
        assert_eq!(first["systems"]["nextCursor"], 1);
        assert_eq!(first["systems"]["rows"][0]["systemId"], "helios");
        assert_eq!(first["systems"]["rows"][0]["displayName"], "太阳系");
        assert_eq!(first["planets"]["totalCount"], 3);
        assert_eq!(first["planets"]["nextCursor"], 1);
        assert_eq!(first["planets"]["rows"][0]["planetId"], "home");
        assert_eq!(first["planets"]["rows"][0]["industryRole"], "manufacturing");
        assert_eq!(
            first["planets"]["rows"][0]["profile"]["resourceIds"]["rows"][1],
            "copper_ore"
        );
        assert_eq!(
            first["planets"]["rows"][0]["profile"]["rareResourceIds"]["rows"][0],
            "copper_ore"
        );
        assert_eq!(
            first["planets"]["rows"][0]["profile"]["orbitalYields"]["rows"][0]["itemId"],
            "copper_ore"
        );
        assert_eq!(
            first["planets"]["rows"][0]["metadata"]["note"],
            "主生产基地"
        );
        assert_eq!(
            first["planets"]["rows"][0]["metadata"]["tags"]["rows"][1],
            "科研"
        );

        let repeated = state
            .star_map_catalog_projection(41, "stellar-test", 0, 1, 0, 1)
            .unwrap();
        assert_eq!(first, repeated);
        let last = state
            .star_map_catalog_projection(41, "stellar-test", 1, 1, 2, 1)
            .unwrap();
        assert_eq!(last["systems"]["rows"][0]["systemId"], "tau");
        assert_eq!(last["systems"]["nextCursor"], Value::Null);
        assert_eq!(last["planets"]["rows"][0]["planetId"], "tau-one");
        assert_eq!(last["planets"]["nextCursor"], Value::Null);
        assert!(serde_json::to_vec(&first).unwrap().len() <= MAX_PROJECTION_BYTES);
        assert_eq!(state.canonical_sha256().unwrap(), before);
    }

    #[test]
    fn star_map_catalog_rejects_stale_identity_and_invalid_mod_resources() {
        let mut state = state();
        assert!(
            state
                .star_map_catalog_projection(40, "stellar-test", 0, 64, 0, 64)
                .is_err()
        );
        assert!(
            state
                .star_map_catalog_projection(41, "other", 0, 64, 0, 64)
                .is_err()
        );
        state
            .base_value_mut()
            .get_mut("galaxy")
            .and_then(Value::as_object_mut)
            .and_then(|galaxy| galaxy.get_mut("profiles"))
            .and_then(Value::as_object_mut)
            .and_then(|profiles| profiles.get_mut("home"))
            .and_then(Value::as_object_mut)
            .unwrap()
            .insert("resourceIds".to_owned(), json!(["missing-mod:item"]));
        assert!(
            state
                .star_map_catalog_projection(41, "stellar-test", 0, 64, 0, 64)
                .is_err()
        );
    }

    #[test]
    fn bounded_catalog_labels_never_split_utf8_scalars() {
        let long = "星".repeat(MAX_LABEL_BYTES);
        let (bounded, truncated) = bounded_label(Some(&long), "fallback");
        assert!(truncated);
        assert!(bounded.len() <= MAX_LABEL_BYTES);
        assert!(bounded.chars().all(|character| character == '星'));
    }

    #[test]
    fn stellar_industry_pages_direct_planet_and_station_focus_scalars() {
        let state = state();
        let before = state.canonical_sha256().unwrap();
        let first = state
            .stellar_industry_projection(41, "stellar-test", Some("helios"), None, 0, 1, 0, 1)
            .unwrap();
        assert_eq!(first["projectionType"], STELLAR_INDUSTRY_SCHEMA);
        assert_eq!(first["planets"]["totalCount"], 2);
        assert_eq!(first["planets"]["nextCursor"], 1);
        assert_eq!(first["planets"]["rows"][0]["planetId"], "home");
        assert_eq!(first["planets"]["rows"][0]["systemDisplayName"], "太阳系");
        assert_eq!(first["planets"]["rows"][0]["systemPositionX"], 12.5);
        assert_eq!(first["planets"]["rows"][0]["industryRole"], "manufacturing");
        assert_eq!(first["stations"]["totalCount"], 2);
        assert_eq!(first["stations"]["nextCursor"], 1);
        assert_eq!(first["stations"]["rows"][0]["stationId"], "station-home");
        assert_eq!(first["stations"]["rows"][0]["planetLabel"], "母星");
        assert_eq!(first["stations"]["rows"][0]["positionX"], 99.0);
        assert_eq!(first["stations"]["rows"][0]["positionY"], 101.0);
        assert_eq!(first["stations"]["rows"][0]["configuredImportSlotCount"], 1);
        assert_eq!(first["stations"]["rows"][0]["configuredExportSlotCount"], 1);

        let second = state
            .stellar_industry_projection(41, "stellar-test", Some("helios"), None, 1, 1, 1, 1)
            .unwrap();
        assert_eq!(second["planets"]["rows"][0]["planetId"], "ashen");
        assert_eq!(second["planets"]["rows"][0]["displayName"], "灰烬前哨");
        assert_eq!(
            second["planets"]["rows"][0]["congestedStationId"],
            "station-ashen"
        );
        assert_eq!(second["stations"]["rows"][0]["stationId"], "station-ashen");
        assert_eq!(second["stations"]["nextCursor"], Value::Null);
        assert!(serde_json::to_vec(&second).unwrap().len() <= MAX_PROJECTION_BYTES);
        assert_eq!(state.canonical_sha256().unwrap(), before);
    }

    #[test]
    fn stellar_industry_v2_routes_are_revision_bound_complete_and_read_only() {
        let state = route_state();
        let before = state.canonical_sha256().unwrap();
        let v1 = state
            .stellar_industry_projection(
                55,
                "stellar-route-test",
                None,
                None,
                0,
                MAX_PAGE_ROWS,
                0,
                MAX_PAGE_ROWS,
            )
            .unwrap();
        let first = state
            .stellar_industry_v2_projection(
                55,
                "stellar-route-test",
                None,
                None,
                0,
                MAX_PAGE_ROWS,
                0,
                MAX_PAGE_ROWS,
                0,
                MAX_PAGE_ROWS,
                "all",
                "",
            )
            .unwrap();
        assert_eq!(first["schemaVersion"], 2);
        assert_eq!(first["projectionType"], STELLAR_INDUSTRY_V2_SCHEMA);
        assert_eq!(first["revision"], 55);
        assert_eq!(first["registryFingerprint"], "stellar-route-test");
        assert_eq!(first["request"]["routeCursor"], 0);
        assert_eq!(first["request"]["routeLimit"], MAX_PAGE_ROWS);
        assert_eq!(first["request"]["routeFilter"], "all");
        assert_eq!(first["request"]["query"], "");
        assert_eq!(first["limits"]["pageRows"], MAX_PAGE_ROWS);
        assert_eq!(first["limits"]["queryBytes"], MAX_QUERY_BYTES);
        assert_eq!(first["planets"], v1["planets"]);
        assert_eq!(first["stations"], v1["stations"]);
        assert_eq!(first["routes"]["totalCount"], 1);
        assert_eq!(first["routes"]["nextCursor"], Value::Null);
        assert_eq!(first["routeSummary"]["scopeTotalCount"], 1);
        assert_eq!(first["routeSummary"]["activeCount"], 1);
        assert_eq!(first["routeSummary"]["blockedCount"], 0);
        let route = &first["routes"]["rows"][0];
        assert_eq!(route["id"], "remote:station-target:0:station-source");
        assert_eq!(route["scope"], "remote");
        assert_eq!(route["itemId"], "iron_ore");
        assert_eq!(route["itemLabel"], "铁矿");
        assert_eq!(route["sourceStationId"], "station-source");
        assert_eq!(route["sourceSlotIndex"], 0);
        assert_eq!(route["sourcePlanetId"], "source-world");
        assert_eq!(route["targetStationId"], "station-target");
        assert_eq!(route["targetSlotIndex"], 0);
        assert_eq!(route["targetPlanetId"], "target-world");
        assert!(
            route["sourceStationLabel"]
                .as_str()
                .unwrap()
                .contains("源星")
        );
        assert!(
            route["targetStationLabel"]
                .as_str()
                .unwrap()
                .contains("目标星")
        );
        assert_eq!(route["sourceStock"], 450.0);
        assert_eq!(route["sourceReserve"], 50.0);
        assert_eq!(route["sourceSlotMinStock"], 50.0);
        assert_eq!(route["sourceSlotMaxStock"], 500.0);
        assert_eq!(route["targetStock"], 25.0);
        assert_eq!(route["targetLimit"], 200.0);
        assert_eq!(route["targetFree"], 125.0);
        assert_eq!(route["targetSlotMinStock"], 11.0);
        assert_eq!(route["targetSlotMaxStock"], 200.0);
        assert_eq!(route["minimumLoad"], 0.5);
        assert_eq!(route["minimumCargo"], 50.0);
        assert_eq!(route["priority"], 2);
        assert_eq!(route["installedVehicles"], 5.0);
        assert_eq!(route["availableVehicles"], 4.0);
        assert_eq!(route["activeVehicles"], 1.0);
        assert_eq!(route["activeCargo"], 50.0);
        assert_eq!(route["dispatchStationId"], "station-source");
        assert_eq!(route["dispatchPlanetId"], "source-world");
        assert_eq!(route["dispatchDirection"], "supply-delivery");
        assert_eq!(route["routeKind"], "relay");
        assert_eq!(route["routeAvailable"], true);
        assert_eq!(route["routePlanningComplete"], true);
        assert_eq!(route["waypointStationIds"], json!(["station-hub"]));
        assert_eq!(route["waypointPlanetIds"], json!(["hub-world"]));
        assert!(
            route["routePathLabel"]
                .as_str()
                .unwrap()
                .contains("阿尔法 → 贝塔 → 伽马")
        );
        assert_eq!(route["hopCount"], 2);
        assert_eq!(route["warpersPerVessel"], 2.0);
        assert_eq!(route["warpersPerTrip"], 10.0);
        assert_eq!(route["availableWarpers"], 10.0);
        assert_eq!(route["routePolicy"], "relay-required");
        assert_eq!(route["warperBudget"], 2);
        assert_eq!(route["requiresWarp"], true);
        assert_eq!(route["routePowerReady"], true);
        assert_eq!(route["powerProofComplete"], true);
        assert_eq!(route["sourceCongestion"], 0.2);
        assert_eq!(route["targetCongestion"], 0.9);
        assert_eq!(route["waypointMaxCongestion"], 0.6);
        assert_eq!(route["routeCongestion"], 0.9);
        assert_eq!(route["status"], "active");
        assert_eq!(route["statusLabel"], "运输中");
        for field in [
            "distanceLy",
            "orbitSpan",
            "durationSeconds",
            "throughputPerMinute",
            "powerKw",
            "energyMjPerTrip",
            "maxLegDistanceLy",
        ] {
            assert!(route[field].as_f64().is_some(), "missing {field}");
        }
        let repeated = state
            .stellar_industry_v2_projection(
                55,
                "stellar-route-test",
                None,
                None,
                0,
                MAX_PAGE_ROWS,
                0,
                MAX_PAGE_ROWS,
                0,
                MAX_PAGE_ROWS,
                "all",
                "",
            )
            .unwrap();
        assert_eq!(first, repeated);
        assert!(serde_json::to_vec(&first).unwrap().len() <= MAX_PROJECTION_BYTES);
        assert_eq!(state.canonical_sha256().unwrap(), before);
    }

    #[test]
    fn stellar_industry_v2_route_filter_query_and_scope_are_server_side() {
        let state = state();
        let before = state.canonical_sha256().unwrap();
        let all = state
            .stellar_industry_v2_projection(
                41,
                "stellar-test",
                None,
                None,
                0,
                3,
                0,
                3,
                0,
                3,
                "all",
                "",
            )
            .unwrap();
        assert_eq!(all["routeSummary"]["scopeTotalCount"], 3);
        assert_eq!(all["routeSummary"]["remoteCount"], 3);
        assert_eq!(all["routeSummary"]["blockedCount"], 1);
        assert_eq!(all["routes"]["totalCount"], 3);

        let issues = state
            .stellar_industry_v2_projection(
                41,
                "stellar-test",
                None,
                None,
                0,
                3,
                0,
                3,
                0,
                1,
                "issues",
                "远境",
            )
            .unwrap();
        assert_eq!(issues["routes"]["totalCount"], 1);
        assert_eq!(issues["routes"]["rows"][0]["targetPlanetId"], "tau-one");
        assert_eq!(issues["routes"]["rows"][0]["sourceStationLabel"], "未匹配");
        assert_eq!(issues["routes"]["rows"][0]["status"], "missing-source");
        assert_eq!(issues["request"]["routeFilter"], "issues");
        assert_eq!(issues["request"]["query"], "远境");

        let helios = state
            .stellar_industry_v2_projection(
                41,
                "stellar-test",
                Some("helios"),
                None,
                0,
                2,
                0,
                2,
                0,
                2,
                "remote",
                "iron_ore",
            )
            .unwrap();
        assert_eq!(helios["routeSummary"]["scopeTotalCount"], 2);
        assert_eq!(helios["routes"]["totalCount"], 2);
        assert!(
            helios["routes"]["rows"]
                .as_array()
                .unwrap()
                .iter()
                .all(|route| route["scope"] == "remote")
        );
        assert_eq!(state.canonical_sha256().unwrap(), before);
    }

    #[test]
    fn stellar_projections_reject_stale_unknown_mismatched_and_unbounded_requests() {
        let state = state();
        let before = state.canonical_sha256().unwrap();
        assert!(
            state
                .star_map_overview_projection(40, "stellar-test", 0, 1)
                .is_err()
        );
        assert!(
            state
                .star_map_overview_projection(41, "wrong", 0, 1)
                .is_err()
        );
        assert!(
            state
                .star_map_overview_projection(41, "stellar-test", 0, 0)
                .is_err()
        );
        assert!(
            state
                .star_map_overview_projection(41, "stellar-test", 0, MAX_PAGE_ROWS + 1)
                .is_err()
        );
        assert!(
            state
                .star_map_overview_projection(41, "stellar-test", 3, 1)
                .is_err()
        );
        assert!(
            state
                .stellar_industry_projection(41, "stellar-test", Some("unknown"), None, 0, 1, 0, 1,)
                .is_err()
        );
        assert!(
            state
                .stellar_industry_projection(
                    41,
                    "stellar-test",
                    Some("tau"),
                    Some("home"),
                    0,
                    1,
                    0,
                    1,
                )
                .is_err()
        );
        assert!(
            state
                .stellar_industry_projection(41, "stellar-test", None, Some("missing"), 0, 1, 0, 1,)
                .is_err()
        );
        assert!(
            state
                .stellar_industry_projection(41, "stellar-test", Some("helios"), None, 3, 1, 0, 1,)
                .is_err()
        );
        assert!(
            state
                .stellar_industry_projection(41, "stellar-test", Some("helios"), None, 0, 1, 3, 1,)
                .is_err()
        );
        assert!(
            state
                .stellar_industry_v2_projection(
                    40,
                    "stellar-test",
                    None,
                    None,
                    0,
                    1,
                    0,
                    1,
                    0,
                    1,
                    "all",
                    "",
                )
                .is_err()
        );
        assert!(
            state
                .stellar_industry_v2_projection(
                    41,
                    "stellar-test",
                    None,
                    None,
                    0,
                    1,
                    0,
                    1,
                    0,
                    MAX_PAGE_ROWS + 1,
                    "all",
                    "",
                )
                .is_err()
        );
        assert!(
            state
                .stellar_industry_v2_projection(
                    41,
                    "stellar-test",
                    None,
                    None,
                    0,
                    1,
                    0,
                    1,
                    0,
                    1,
                    "blocked",
                    "",
                )
                .is_err()
        );
        assert!(
            state
                .stellar_industry_v2_projection(
                    41,
                    "stellar-test",
                    None,
                    None,
                    0,
                    1,
                    0,
                    1,
                    0,
                    1,
                    "all",
                    &"q".repeat(MAX_QUERY_BYTES + 1),
                )
                .is_err()
        );
        assert!(
            state
                .stellar_industry_v2_projection(
                    41,
                    "stellar-test",
                    None,
                    None,
                    0,
                    1,
                    0,
                    1,
                    4,
                    1,
                    "all",
                    "",
                )
                .is_err()
        );
        assert_eq!(state.canonical_sha256().unwrap(), before);
    }

    #[test]
    fn stellar_industry_v2_fails_closed_on_unprovable_route_ledger() {
        let source = state();
        let mut entities = (0..source.factory_topology.entity_planet_indices.len())
            .map(|index| source.parse_entity(index).unwrap())
            .collect::<Vec<_>>();
        entities[1]["stationRoutes"][0]["cargo"] = json!("not-an-integer");
        let malformed = CoreState::from_public_v47_parts(
            source.identity.clone(),
            source.base_value().clone(),
            entities
                .into_iter()
                .map(|entity| entity.to_string())
                .collect(),
            Vec::new(),
            (*source.catalog).clone(),
        )
        .unwrap();
        let before = malformed.canonical_sha256().unwrap();
        assert!(
            malformed
                .stellar_industry_v2_projection(
                    41,
                    "stellar-test",
                    None,
                    None,
                    0,
                    1,
                    0,
                    1,
                    0,
                    1,
                    "all",
                    "",
                )
                .is_err()
        );
        assert_eq!(malformed.canonical_sha256().unwrap(), before);
    }

    #[test]
    fn stellar_quantum_pages_preserve_decimal_inventory_and_attachment_state() {
        let state = quantum_state();
        let before = state.canonical_sha256().unwrap();
        let first = state
            .stellar_quantum_projection(61, "stellar-quantum-test", 0, 1, 0, 2)
            .unwrap();
        assert_eq!(first["schemaVersion"], 1);
        assert_eq!(first["projectionType"], STELLAR_QUANTUM_SCHEMA);
        assert_eq!(first["revision"], 61);
        assert_eq!(first["registryFingerprint"], "stellar-quantum-test");
        assert_eq!(first["limits"]["decimalDigits"], MAX_DECIMAL_DIGITS);
        assert_eq!(first["items"]["totalCount"], 2);
        assert_eq!(first["items"]["nextCursor"], 1);
        assert_eq!(first["items"]["rows"][0]["itemId"], "iron_ore");
        assert_eq!(
            first["items"]["rows"][0]["inventory"],
            "123456789012345678901234567890"
        );
        assert_eq!(first["items"]["rows"][0]["capacity"], "100000");
        assert_eq!(first["items"]["rows"][0]["uploaded"], "7");
        assert_eq!(first["items"]["rows"][0]["downloaded"], "2");
        assert_eq!(first["collectors"]["totalCount"], 3);
        assert_eq!(first["collectors"]["nextCursor"], 2);
        assert_eq!(
            first["collectors"]["rows"][0]["attachmentState"],
            "connected"
        );
        assert_eq!(first["collectors"]["rows"][1]["attachmentState"], "pending");
        assert_eq!(first["collectorSummary"]["connectedCount"], 1);
        assert_eq!(first["collectorSummary"]["pendingCount"], 1);
        assert_eq!(first["collectorSummary"]["availableCount"], 1);
        assert_eq!(first["collectorSummary"]["connectedStacks"], 5);
        assert_eq!(first["bandwidth"]["activeTowerCount"], 1);
        assert_eq!(first["bandwidth"]["activeTowerStacks"], 3);
        let js_contract_base = 1.0_f64 + 0.05_f64 * 2.0_f64;
        let js_contract_bandwidth = 5_000.0_f64 * js_contract_base * js_contract_base * 3.0_f64;
        assert_eq!(
            first["bandwidth"]["globalDownloadPerMinute"],
            json!(js_contract_bandwidth)
        );
        assert_eq!(first["runtime"]["boundarySecond"], 25);
        assert_eq!(first["runtime"]["quantumCollectorStacks"], 5);
        assert_eq!(first["truncated"], true);

        let second = state
            .stellar_quantum_projection(61, "stellar-quantum-test", 1, 1, 2, 1)
            .unwrap();
        assert_eq!(second["items"]["rows"][0]["itemId"], "copper_ore");
        assert_eq!(second["items"]["rows"][0]["inventory"], "0");
        assert_eq!(
            second["items"]["rows"][0]["capacity"],
            QUANTUM_ITEM_CAPACITY_MAX
        );
        assert_eq!(second["items"]["nextCursor"], Value::Null);
        assert_eq!(
            second["collectors"]["rows"][0]["attachmentState"],
            "available"
        );
        assert_eq!(second["collectors"]["nextCursor"], Value::Null);
        assert_eq!(second["truncated"], false);
        assert_eq!(state.canonical_sha256().unwrap(), before);
        assert!(serde_json::to_vec(&first).unwrap().len() <= MAX_PROJECTION_BYTES);
    }

    #[test]
    fn stellar_quantum_rejects_stale_unbounded_and_malformed_quantity_requests() {
        let state = quantum_state();
        assert!(
            state
                .stellar_quantum_projection(60, "stellar-quantum-test", 0, 1, 0, 1)
                .is_err()
        );
        assert!(
            state
                .stellar_quantum_projection(61, "stellar-quantum-test", 0, MAX_PAGE_ROWS + 1, 0, 1,)
                .is_err()
        );
        assert!(
            state
                .stellar_quantum_projection(61, "stellar-quantum-test", 3, 1, 0, 1)
                .is_err()
        );
        assert!(
            state
                .stellar_quantum_projection(61, "stellar-quantum-test", 0, 1, 4, 1)
                .is_err()
        );

        let mut malformed = quantum_state();
        malformed.base_value_mut()["quantumLogisticsNetwork"]["inventory"]["iron_ore"] =
            json!("007");
        assert!(
            malformed
                .stellar_quantum_projection(61, "stellar-quantum-test", 0, 1, 0, 1)
                .is_err()
        );

        let mut unknown = quantum_state();
        unknown.base_value_mut()["quantumLogisticsNetwork"]["runtimeFlow"]["uploaded"]["missing_mod_item"] =
            json!("1");
        assert!(
            unknown
                .stellar_quantum_projection(61, "stellar-quantum-test", 0, 1, 0, 1)
                .is_err()
        );
    }

    #[test]
    fn maximum_pages_remain_bounded_and_labels_end_on_utf8_boundaries() {
        let planets = (0..70)
            .map(|index| planet(&format!("p-{index:02}"), "行星", "many", index, index + 1))
            .collect::<Vec<_>>();
        let long_name = "星".repeat(400);
        let mut profiles = Map::new();
        let mut metadata = Map::new();
        let mut metrics = Map::new();
        for planet in &planets {
            profiles.insert(
                planet.id.clone(),
                json!({ "climateName": long_name, "specializationName": long_name }),
            );
            metadata.insert(planet.id.clone(), json!({ "customName": long_name }));
            metrics.insert(
                planet.id.clone(),
                json!({ "generationKw": 1, "demandKw": 1, "powerFactor": 1 }),
            );
        }
        let base = json!({
            "version": 47,
            "mode": "normal",
            "activePlanetId": "p-00",
            "paused": false,
            "settings": {},
            "tray": {},
            "planetTrays": {},
            "exploration": { "unlockedSystemIds": ["many"], "colonizedPlanetIds": ["p-00"], "missions": [], "surveyProgressBySystem": { "many": 1 } },
            "galaxy": {
                "seed": 1,
                "systemProfiles": { "many": { "positionX": 1, "positionY": 2 } },
                "profiles": profiles,
                "planetMetadata": metadata,
                "systemMetadata": {},
                "planetRoles": {}
            },
            "planetMetrics": metrics
        })
        .as_object()
        .unwrap()
        .clone();
        let entities = planets
            .iter()
            .enumerate()
            .map(|(index, planet)| {
                station(
                    &format!("station-{index:02}"),
                    &planet.id,
                    index as f64,
                    -(index as f64),
                    1,
                    "legacy",
                    0.0,
                )
            })
            .collect::<Vec<_>>();
        let state = CoreState::from_public_v47_parts(
            CoreCheckpointIdentity {
                slot: "normal-main".to_owned(),
                generation: 1,
                root_hash: "b".repeat(64),
                revision: 7,
                state_version: 47,
                mode: "normal".to_owned(),
                registry_fingerprint: "stellar-large-test".to_owned(),
                base_primary_checksum: "12345678".to_owned(),
            },
            base,
            entities,
            Vec::new(),
            catalog(planets, "stellar-large-test"),
        )
        .unwrap();
        let projection = state
            .stellar_industry_projection(
                7,
                "stellar-large-test",
                Some("many"),
                None,
                0,
                MAX_PAGE_ROWS,
                0,
                MAX_PAGE_ROWS,
            )
            .unwrap();
        assert_eq!(projection["planets"]["rows"].as_array().unwrap().len(), 64);
        assert_eq!(projection["stations"]["rows"].as_array().unwrap().len(), 64);
        assert_eq!(projection["planets"]["nextCursor"], 64);
        assert_eq!(projection["stations"]["nextCursor"], 64);
        let label = projection["planets"]["rows"][0]["displayName"]
            .as_str()
            .unwrap();
        assert!(label.len() <= MAX_LABEL_BYTES);
        assert!(label.is_char_boundary(label.len()));
        assert_eq!(
            projection["planets"]["rows"][0]["displayNameTruncated"],
            true
        );
        assert!(serde_json::to_vec(&projection).unwrap().len() <= MAX_PROJECTION_BYTES);

        let v2 = state
            .stellar_industry_v2_projection(
                7,
                "stellar-large-test",
                Some("many"),
                None,
                0,
                MAX_PAGE_ROWS,
                0,
                MAX_PAGE_ROWS,
                0,
                MAX_PAGE_ROWS,
                "all",
                "",
            )
            .unwrap();
        assert_eq!(v2["projectionType"], STELLAR_INDUSTRY_V2_SCHEMA);
        assert_eq!(v2["routes"]["rows"].as_array().unwrap().len(), 64);
        assert_eq!(v2["routes"]["nextCursor"], 64);
        assert_eq!(v2["routes"]["totalCount"], 70);
        assert!(serde_json::to_vec(&v2).unwrap().len() <= MAX_PROJECTION_BYTES);
        let tail = state
            .stellar_industry_v2_projection(
                7,
                "stellar-large-test",
                Some("many"),
                None,
                0,
                1,
                0,
                1,
                64,
                6,
                "all",
                "",
            )
            .unwrap();
        assert_eq!(tail["routes"]["cursor"], 64);
        assert_eq!(tail["routes"]["rows"].as_array().unwrap().len(), 6);
        assert_eq!(tail["routes"]["nextCursor"], Value::Null);
        let head_ids = v2["routes"]["rows"]
            .as_array()
            .unwrap()
            .iter()
            .map(|route| route["id"].as_str().unwrap())
            .collect::<HashSet<_>>();
        assert!(
            tail["routes"]["rows"]
                .as_array()
                .unwrap()
                .iter()
                .all(|route| !head_ids.contains(route["id"].as_str().unwrap()))
        );
    }
}
