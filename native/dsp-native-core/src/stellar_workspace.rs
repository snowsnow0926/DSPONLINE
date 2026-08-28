//! Bounded native read models for the shared star-map and stellar-industry UI.
//!
//! These projections deliberately expose only scalar identifiers, labels,
//! coordinates, counters, and small fixed-shape summaries. They never export
//! entity arrays, raw station slots/routes, or the public v47 state. Paging is
//! tied to an exact native revision and catalog fingerprint so the renderer
//! cannot accidentally combine rows from two authorities.

use std::collections::{BTreeMap, HashSet};

use anyhow::{anyhow, bail};
use serde_json::{Map, Value, json};

use crate::state::CoreState;

const STAR_MAP_SCHEMA: &str = "star-map-overview-v1";
const STELLAR_INDUSTRY_SCHEMA: &str = "stellar-industry-v1";
const MAX_PAGE_ROWS: usize = 64;
const MAX_REQUEST_BYTES: usize = 32_768;
const MAX_PROJECTION_BYTES: usize = 1_048_576;
const MAX_LABEL_BYTES: usize = 512;

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

impl CoreState {
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
                Ok(json!({
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

    fn catalog(planets: Vec<PlanetDefinition>, fingerprint: &str) -> RuntimeCatalog {
        RuntimeCatalog::validate(
            CatalogSnapshot {
                protocol_version: 1,
                registry_fingerprint: fingerprint.to_owned(),
                planets,
                items: vec![ItemDefinition {
                    id: "iron_ore".to_owned(),
                    name: "铁矿".to_owned(),
                    kind: "solid".to_owned(),
                    fuel_energy_mj: 0.0,
                }],
                buildings: vec![building()],
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
            "stationRoutes": [{ "vehicleCount": 1, "cargo": 100 }]
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
                    "home": { "climateName": "温带", "oceanType": "water", "specialization": "balanced", "specializationName": "均衡工业", "tidalLocked": false, "windMultiplier": 1.1, "solarMultiplier": 1.2, "geothermalMultiplier": 0.8, "miningMultiplier": 1, "orbitalYieldMultiplier": 1, "reserveScale": 1.5, "travelTimeMultiplier": 1 },
                    "ashen": { "climateName": "荒漠", "oceanType": "none", "specialization": "smelting", "specializationName": "冶炼", "tidalLocked": true },
                    "tau-one": { "climateName": "冰原", "oceanType": "ice", "specialization": "logistics", "specializationName": "物流" }
                },
                "planetRoles": { "home": "manufacturing", "ashen": "smelting", "tau-one": "auto" },
                "planetMetadata": { "ashen": { "customName": "灰烬前哨" } },
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
        assert_eq!(state.canonical_sha256().unwrap(), before);
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
    }
}
