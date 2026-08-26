use std::collections::{HashMap, HashSet};

use anyhow::{Context, anyhow};
use serde_json::{Map, Number, Value, json};

use crate::catalog::{BuildingDefinition, RecipeDefinition};
use crate::state::CoreState;

const EPSILON: f64 = 0.0001;
const MIN_BUILDING_BUFFER_LIMIT: f64 = 1_000.0;
const DEFAULT_BUILDING_BUFFER_LIMIT: f64 = 1_000_000.0;
const MAX_BUILDING_BUFFER_LIMIT: f64 = 100_000_000.0;
const GRID_IDS: [&str; 3] = ["grid-a", "grid-b", "grid-c"];
const CAMPAIGN_TASK_IDS: [&str; 31] = [
    "mine_first_ore",
    "smelt_iron",
    "deploy_miner",
    "lay_first_belt",
    "deploy_matrix_lab",
    "produce_blue_matrix",
    "refine_oil",
    "produce_plastic",
    "produce_red_matrix",
    "deploy_planetary_station",
    "complete_planetary_trip",
    "produce_structure_matrix",
    "unlock_borealis",
    "deploy_interstellar_station",
    "complete_interstellar_trip",
    "produce_information_matrix",
    "produce_gravity_matrix",
    "produce_universe_matrix",
    "launch_solar_sail",
    "launch_carrier_rocket",
    "build_dyson_structure",
    "absorb_shell_sail",
    "side_storage",
    "side_stable_power",
    "side_belt_upgrade",
    "side_rare_resource",
    "side_spray_coater",
    "side_blueprint",
    "endgame_infinite_research",
    "endgame_export",
    "endgame_score",
    // endgame_mastery is checked separately below. Keeping this explicit
    // list catches accidental campaign additions at the native boundary.
];

#[derive(Debug, Clone, Copy, Default)]
struct PlanetProfile {
    wind_multiplier: f64,
    solar_power_multiplier: f64,
    geothermal_multiplier: f64,
    mining_multiplier: f64,
    production_speed_multiplier: f64,
    specialization: &'static str,
    ocean_type: &'static str,
}

#[derive(Debug, Clone, Default)]
struct Consumer {
    entity_index: usize,
    demand_kw: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DispatchKind {
    Thermal,
    Fusion,
    ArtificialStar,
    Accumulator,
    Exchanger,
}

#[derive(Debug, Clone)]
struct PowerCandidate {
    entity_index: usize,
    capacity: f64,
    priority: usize,
    kind: DispatchKind,
}

#[derive(Debug, Clone)]
struct GridRuntime {
    generation_kw: f64,
    base_generation_kw: f64,
    demand_kw: f64,
    supplied_kw: f64,
    factor: f64,
    wind_generation_kw: f64,
    solar_generation_kw: f64,
    geothermal_generation_kw: f64,
    thermal_generation_kw: f64,
    fusion_generation_kw: f64,
    artificial_star_generation_kw: f64,
    ray_generation_kw: f64,
    storage_discharge_kw: f64,
    storage_charge_kw: f64,
    stored_energy_mj: f64,
    storage_capacity_mj: f64,
    fuel_electric_energy_mj: f64,
    rated_fuel_generator_kw: f64,
    connected_entities: u64,
    disconnected_entities: u64,
    generator_count: f64,
    has_power_source: bool,
    consumers: [Vec<Consumer>; 4],
    disconnected_demand_kw: f64,
    dispatch_candidates: Vec<PowerCandidate>,
    accumulator_charge_candidates: Vec<PowerCandidate>,
    exchanger_charge_candidates: Vec<PowerCandidate>,
    power_output_by_entity: HashMap<usize, f64>,
    power_input_by_entity: HashMap<usize, f64>,
}

impl Default for GridRuntime {
    fn default() -> Self {
        Self {
            generation_kw: 0.0,
            base_generation_kw: 0.0,
            demand_kw: 0.0,
            supplied_kw: 0.0,
            factor: 1.0,
            wind_generation_kw: 0.0,
            solar_generation_kw: 0.0,
            geothermal_generation_kw: 0.0,
            thermal_generation_kw: 0.0,
            fusion_generation_kw: 0.0,
            artificial_star_generation_kw: 0.0,
            ray_generation_kw: 0.0,
            storage_discharge_kw: 0.0,
            storage_charge_kw: 0.0,
            stored_energy_mj: 0.0,
            storage_capacity_mj: 0.0,
            fuel_electric_energy_mj: 0.0,
            rated_fuel_generator_kw: 0.0,
            connected_entities: 0,
            disconnected_entities: 0,
            generator_count: 0.0,
            has_power_source: false,
            consumers: std::array::from_fn(|_| Vec::new()),
            disconnected_demand_kw: 0.0,
            dispatch_candidates: Vec::new(),
            accumulator_charge_candidates: Vec::new(),
            exchanger_charge_candidates: Vec::new(),
            power_output_by_entity: HashMap::new(),
            power_input_by_entity: HashMap::new(),
        }
    }
}

fn rounded(value: f64, digits: i32) -> f64 {
    let scale = 10_f64.powi(digits);
    (value * scale).round() / scale
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

fn bool_at(value: Option<&Value>, path: &[&str]) -> bool {
    let mut current = value;
    for key in path {
        current = current
            .and_then(Value::as_object)
            .and_then(|object| object.get(*key));
    }
    current.and_then(Value::as_bool).unwrap_or(false)
}

fn number_at(value: Option<&Value>, path: &[&str]) -> f64 {
    let mut current = value;
    for key in path {
        current = current
            .and_then(Value::as_object)
            .and_then(|object| object.get(*key));
    }
    finite_number(current)
}

fn empty_array(value: Option<&Value>) -> bool {
    value.and_then(Value::as_array).is_some_and(Vec::is_empty)
}

fn empty_object(value: Option<&Value>) -> bool {
    value.and_then(Value::as_object).is_some_and(Map::is_empty)
}

fn grid_index(entity: &Map<String, Value>) -> Option<usize> {
    let id = string_at(entity, "powerGridId").unwrap_or("grid-a");
    GRID_IDS.iter().position(|candidate| *candidate == id)
}

fn normalized_buffer_limit(value: Option<&Value>) -> f64 {
    let value = value
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
        .unwrap_or(DEFAULT_BUILDING_BUFFER_LIMIT)
        .floor();
    value.clamp(MIN_BUILDING_BUFFER_LIMIT, MAX_BUILDING_BUFFER_LIMIT)
}

fn stacked_capacity(base_capacity: f64, count: f64, limit: f64) -> f64 {
    let base = base_capacity.max(0.0).floor();
    let count = count.floor().max(1.0);
    if base == 0.0 {
        0.0
    } else if base > limit / count {
        limit
    } else {
        (base * count).min(limit)
    }
}

fn item_amount(entity: &Map<String, Value>, record: &str, item_id: &str) -> f64 {
    entity
        .get(record)
        .and_then(Value::as_object)
        .and_then(|values| values.get(item_id))
        .map(|value| finite_number(Some(value)))
        .unwrap_or(0.0)
}

fn is_fuel_generator(building_id: &str) -> bool {
    matches!(
        building_id,
        "thermal_power_plant" | "mini_fusion_power_plant" | "artificial_star"
    )
}

fn fuel_energy_available(
    state: &CoreState,
    entity: &Map<String, Value>,
    building: &BuildingDefinition,
) -> f64 {
    let Some(fuel_item_id) = string_at(entity, "fuelItemId") else {
        return 0.0;
    };
    if !building.fuel_item_ids.iter().any(|id| id == fuel_item_id) {
        return 0.0;
    }
    let energy_per_item = state
        .catalog
        .items
        .get(fuel_item_id)
        .map(|item| item.fuel_energy_mj)
        .unwrap_or(0.0);
    finite_number(entity.get("fuelRemainingMj")).max(0.0)
        + (item_amount(entity, "inputs", fuel_item_id) + EPSILON).floor() * energy_per_item
}

fn energy_capacity(entity: &Map<String, Value>, building: &BuildingDefinition) -> f64 {
    building.energy_capacity_mj * finite_number(entity.get("machineCount"))
}

fn stored_energy(entity: &Map<String, Value>, building: &BuildingDefinition) -> f64 {
    finite_number(entity.get("storedEnergyMj"))
        .max(0.0)
        .min(energy_capacity(entity, building))
}

fn item_output_free(
    entity: &Map<String, Value>,
    building: &BuildingDefinition,
    item_id: &str,
    buffer_limit: f64,
) -> f64 {
    let capacity = stacked_capacity(
        building.output_capacity,
        finite_number(entity.get("machineCount")),
        buffer_limit,
    );
    ((capacity - item_amount(entity, "outputs", item_id)).max(0.0) + EPSILON).floor()
}

fn accumulator_energy_mj(state: &CoreState) -> anyhow::Result<f64> {
    let energy = state
        .catalog
        .buildings
        .get("accumulator")
        .map(|building| building.energy_capacity_mj)
        .unwrap_or(0.0);
    if !energy.is_finite() || energy <= EPSILON {
        return Err(anyhow!("native accumulator energy catalog is invalid"));
    }
    Ok(energy)
}

fn default_generation_priority(building_id: &str) -> usize {
    match building_id {
        "energy_exchanger" => 2,
        "accumulator" | "thermal_power_plant" | "mini_fusion_power_plant" | "artificial_star" => 1,
        _ => 3,
    }
}

fn generation_priority(entity: &Map<String, Value>, building_id: &str) -> usize {
    entity
        .get("generationPriority")
        .and_then(Value::as_u64)
        .map(|value| value.clamp(1, 3) as usize)
        .unwrap_or_else(|| default_generation_priority(building_id))
}

fn allocate_power(
    candidates: &[PowerCandidate],
    requested_kw: f64,
    outputs: &mut HashMap<usize, f64>,
) -> f64 {
    let capacity = candidates
        .iter()
        .map(|candidate| candidate.capacity)
        .sum::<f64>();
    let allocated = requested_kw.max(0.0).min(capacity);
    for candidate in candidates {
        outputs.insert(
            candidate.entity_index,
            if capacity > EPSILON {
                allocated * candidate.capacity / capacity
            } else {
                0.0
            },
        );
    }
    allocated
}

fn allocate_power_by_priority(
    candidates: &[PowerCandidate],
    requested_kw: f64,
    outputs: &mut HashMap<usize, f64>,
) -> f64 {
    let mut remaining = requested_kw.max(0.0);
    let mut allocated = 0.0;
    for priority in [3_usize, 2, 1] {
        let group = candidates
            .iter()
            .filter(|candidate| candidate.priority == priority)
            .cloned()
            .collect::<Vec<_>>();
        let supplied = allocate_power(&group, remaining, outputs);
        allocated += supplied;
        remaining -= supplied;
        if remaining <= EPSILON {
            break;
        }
    }
    allocated
}

fn exact_campaign_complete(base: &Map<String, Value>) -> bool {
    let Some(campaign) = base.get("campaign").and_then(Value::as_object) else {
        return false;
    };
    if campaign
        .get("activeTaskId")
        .is_none_or(|value| !value.is_null())
        || campaign.get("activeChapterId").and_then(Value::as_str) != Some("galactic_endgame")
    {
        return false;
    }
    let expected = CAMPAIGN_TASK_IDS
        .iter()
        .copied()
        .chain(std::iter::once("endgame_mastery"))
        .collect::<HashSet<_>>();
    let ids = |key: &str| {
        campaign
            .get(key)
            .and_then(Value::as_array)
            .map(|values| {
                values
                    .iter()
                    .filter_map(Value::as_str)
                    .collect::<HashSet<_>>()
            })
            .unwrap_or_default()
    };
    ids("completedTaskIds") == expected && ids("rewardedTaskIds") == expected
}

fn inactive_global_reason(state: &CoreState) -> Option<&'static str> {
    let base = state.base_value();
    if base.get("mode").and_then(Value::as_str) != Some("normal") {
        return Some("speedrun-factory-requires-domain-core");
    }
    if !exact_campaign_complete(base) {
        return Some("campaign-completion-requires-domain-core");
    }
    if !empty_array(base.get("handcraftQueue")) || !empty_array(base.get("constructionQueue")) {
        return Some("craft-or-construction-queue-active");
    }
    if !base
        .get("exploration")
        .and_then(Value::as_object)
        .and_then(|value| value.get("missions"))
        .is_some_and(|value| empty_array(Some(value)))
    {
        return Some("exploration-active");
    }
    let time_warp = base.get("timeWarp");
    if bool_at(time_warp, &["enabled"])
        || number_at(time_warp, &["pendingSimulationSeconds"]).abs() > EPSILON
        || number_at(time_warp, &["pendingWallSeconds"]).abs() > EPSILON
    {
        return Some("time-warp-active");
    }
    if !empty_object(base.get("systemSpaceStations")) {
        return Some("system-space-station-active");
    }
    let endgame = base.get("endgame");
    if endgame
        .and_then(Value::as_object)
        .and_then(|value| value.get("constructionActivity"))
        .and_then(Value::as_object)
        .and_then(|value| value.get("activityId"))
        .is_some_and(|value| !value.is_null())
        || endgame
            .and_then(Value::as_object)
            .and_then(|value| value.get("exportProjects"))
            .and_then(Value::as_object)
            .is_some_and(|projects| {
                projects
                    .values()
                    .any(|project| bool_at(Some(project), &["enabled"]))
            })
    {
        return Some("endgame-activity-active");
    }
    if !base
        .get("orbitalStation")
        .and_then(Value::as_object)
        .and_then(|value| value.get("status"))
        .and_then(Value::as_str)
        .is_some_and(|status| matches!(status, "locked" | "eligible"))
    {
        return Some("orbital-station-boundary-active");
    }
    None
}

pub(crate) fn admission_reason(state: &CoreState) -> anyhow::Result<Option<&'static str>> {
    if let Some(reason) = inactive_global_reason(state) {
        return Ok(Some(reason));
    }
    if state.entity_index.is_empty() {
        return Ok(Some("simple-factory-is-empty"));
    }
    let planet_ids = state
        .catalog
        .planets
        .iter()
        .map(|planet| planet.id.as_str())
        .collect::<HashSet<_>>();
    for index in 0..state.entity_index.len() {
        let entity = state.parse_entity(index)?;
        let object = entity
            .as_object()
            .ok_or_else(|| anyhow!("native simple factory entity is not an object"))?;
        if !string_at(object, "planetId").is_some_and(|id| planet_ids.contains(id))
            || grid_index(object).is_none()
        {
            return Ok(Some("simple-factory-entity-location-invalid"));
        }
        match string_at(object, "kind") {
            Some("vein") => {
                let Some(resource) = string_at(object, "resourceId") else {
                    return Ok(Some("simple-factory-vein-resource-missing"));
                };
                let Some(kind) = state
                    .catalog
                    .items
                    .get(resource)
                    .map(|item| item.kind.as_str())
                else {
                    return Ok(Some("simple-factory-vein-resource-missing"));
                };
                if !matches!(kind, "solid" | "fluid") {
                    return Ok(Some("simple-factory-vein-resource-unsupported"));
                }
                let extractor = match resource {
                    "crude_oil" => "oil_extractor",
                    "water" | "sulfuric_acid" => "water_pump",
                    _ => "mining_machine",
                };
                if string_at(object, "extractorBuildingId")
                    .is_some_and(|building| building != extractor)
                    || !state.catalog.buildings.contains_key(extractor)
                {
                    return Ok(Some("simple-factory-extractor-unsupported"));
                }
            }
            Some("power") => {
                let building = string_at(object, "buildingId").unwrap_or_default();
                if !matches!(
                    building,
                    "wind_turbine"
                        | "solar_panel"
                        | "geothermal_power_station"
                        | "thermal_power_plant"
                        | "mini_fusion_power_plant"
                        | "artificial_star"
                        | "accumulator"
                        | "energy_exchanger"
                ) || !state.catalog.buildings.contains_key(building)
                {
                    return Ok(Some("simple-factory-power-source-unsupported"));
                }
                if is_fuel_generator(building)
                    && string_at(object, "fuelItemId").is_some_and(|fuel| {
                        state
                            .catalog
                            .buildings
                            .get(building)
                            .is_none_or(|definition| {
                                !definition.fuel_item_ids.iter().any(|id| id == fuel)
                            })
                    })
                {
                    return Ok(Some("simple-factory-fuel-invalid"));
                }
                if building == "energy_exchanger"
                    && !matches!(
                        string_at(object, "energyMode"),
                        Some("charge" | "discharge")
                    )
                {
                    return Ok(Some("simple-factory-energy-mode-invalid"));
                }
            }
            Some("machine") => {
                let building_id = string_at(object, "buildingId").unwrap_or_default();
                let recipe_id = string_at(object, "recipeId").unwrap_or_default();
                let Some(building) = state.catalog.buildings.get(building_id) else {
                    return Ok(Some("simple-factory-machine-building-missing"));
                };
                if matches!(building_id, "construction_center" | "time_warp_device") {
                    if building.kind != "machine" {
                        return Ok(Some("simple-factory-machine-feature-unsupported"));
                    }
                    continue;
                }
                let Some(recipe) = state.catalog.recipes.get(recipe_id) else {
                    return Ok(Some("simple-factory-machine-recipe-missing"));
                };
                let supported_dyson_machine = matches!(
                    (building_id, recipe_id),
                    ("ray_receiver", "ray_power" | "critical_photon")
                        | ("em_rail_ejector", "solar_sail_launch")
                        | ("vertical_launching_silo", "carrier_rocket_launch")
                );
                if building.kind != "machine"
                    || matches!(building_id, "galactic_material_exporter")
                    || matches!(
                        building_id,
                        "ray_receiver" | "em_rail_ejector" | "vertical_launching_silo"
                    ) && !supported_dyson_machine
                    || recipe_id != "matrix_research"
                        && !supported_dyson_machine
                        && (recipe.inputs.is_empty() || recipe.outputs.is_empty())
                {
                    return Ok(Some("simple-factory-machine-feature-unsupported"));
                }
                if bool_at(Some(&entity), &["sprayCoaterInstalled"])
                    && (object
                        .get("proliferatorTier")
                        .and_then(Value::as_u64)
                        .and_then(|tier| u8::try_from(tier).ok())
                        .is_none_or(|tier| !state.catalog.proliferators.contains_key(&tier))
                        || !matches!(
                            string_at(object, "proliferatorMode"),
                            Some("normal" | "extra" | "speed")
                        ))
                {
                    return Ok(Some("simple-factory-proliferator-invalid"));
                }
            }
            Some("storage" | "splitter") => {
                let building_id = string_at(object, "buildingId").unwrap_or_default();
                let Some(building) = state.catalog.buildings.get(building_id) else {
                    return Ok(Some("simple-factory-logistics-building-missing"));
                };
                if building.kind != string_at(object, "kind").unwrap_or_default()
                    || object
                        .get("storedItemId")
                        .and_then(Value::as_str)
                        .is_some_and(|id| !state.catalog.items.contains_key(id))
                    || string_at(object, "kind") == Some("splitter")
                        && !matches!(
                            string_at(object, "distributionMode"),
                            Some("balanced" | "priority")
                        )
                {
                    return Ok(Some("simple-factory-logistics-entity-invalid"));
                }
            }
            Some("station") => {}
            _ => return Ok(Some("simple-factory-entity-kind-unsupported")),
        }
    }
    let base = state.base_value();
    if let Some(research) = base.get("research").and_then(Value::as_object) {
        let selected_invalid = research
            .get("selectedTechId")
            .and_then(Value::as_str)
            .is_some_and(|id| !state.catalog.technologies.contains_key(id));
        let queue_invalid = research
            .get("queuedTechIds")
            .and_then(Value::as_array)
            .is_none_or(|ids| {
                ids.iter().any(|id| {
                    id.as_str()
                        .is_none_or(|id| !state.catalog.technologies.contains_key(id))
                })
            });
        if selected_invalid || queue_invalid {
            return Ok(Some("simple-factory-research-catalog-invalid"));
        }
    }
    if let Some(infinite_id) = active_infinite_research_id(base) {
        if !crate::infinite_research::valid_id(infinite_id) || !endgame_unlocked(base) {
            return Ok(Some("simple-factory-infinite-research-invalid"));
        }
    }
    let profiles = base
        .get("galaxy")
        .and_then(Value::as_object)
        .and_then(|value| value.get("profiles"))
        .and_then(Value::as_object);
    let planet_metrics = base.get("planetMetrics").and_then(Value::as_object);
    let grid_metrics = base.get("powerGridMetrics").and_then(Value::as_object);
    if state.catalog.planets.iter().any(|planet| {
        profiles.is_none_or(|values| !values.contains_key(&planet.id))
            || planet_metrics.is_none_or(|values| !values.contains_key(&planet.id))
            || grid_metrics.is_none_or(|values| !values.contains_key(&planet.id))
    }) {
        return Ok(Some("simple-factory-planet-directory-incomplete"));
    }
    if let Some(reason) = crate::belts::admission_reason(state)? {
        return Ok(Some(reason));
    }
    if let Some(reason) = crate::dyson::admission_reason(state)? {
        return Ok(Some(reason));
    }
    if let Some(reason) = crate::local_logistics::admission_reason(state)? {
        return Ok(Some(reason));
    }
    if let Some(reason) = crate::construction::admission_reason(state)? {
        return Ok(Some(reason));
    }
    if let Some(reason) = crate::quantum_logistics::admission_reason(state)? {
        return Ok(Some(reason));
    }
    if let Some(reason) = crate::interstellar_logistics::admission_reason(state)? {
        return Ok(Some(reason));
    }
    Ok(None)
}

fn set_number(object: &mut Map<String, Value>, key: &str, value: f64) -> anyhow::Result<()> {
    object.insert(
        key.to_owned(),
        Value::Number(
            Number::from_f64(value)
                .ok_or_else(|| anyhow!("native simple factory produced a non-finite number"))?,
        ),
    );
    Ok(())
}

fn profile_for(
    base: &Map<String, Value>,
    planet_id: &str,
    system_id: &str,
) -> anyhow::Result<PlanetProfile> {
    let profile = base
        .get("galaxy")
        .and_then(Value::as_object)
        .and_then(|value| value.get("profiles"))
        .and_then(Value::as_object)
        .and_then(|profiles| profiles.get(planet_id))
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("native simple factory planet profile is missing"))?;
    let luminosity = base
        .get("galaxy")
        .and_then(Value::as_object)
        .and_then(|value| value.get("systemProfiles"))
        .and_then(Value::as_object)
        .and_then(|profiles| profiles.get(system_id))
        .and_then(Value::as_object)
        .map(|profile| finite_number(profile.get("luminosity")))
        .ok_or_else(|| anyhow!("native simple factory star-system profile is missing"))?;
    let solar_multiplier = finite_number(profile.get("solarMultiplier"));
    let tidal_bonus = if profile
        .get("tidalLocked")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        1.25
    } else {
        1.0
    };
    let specialization = match profile
        .get("specialization")
        .and_then(Value::as_str)
        .unwrap_or("balanced")
    {
        "smelting" => "smelting",
        "chemical" => "chemical",
        "research" => "research",
        "particle" => "particle",
        "logistics" => "logistics",
        _ => "balanced",
    };
    let ocean_type = match profile
        .get("oceanType")
        .and_then(Value::as_str)
        .unwrap_or("none")
    {
        "water" => "water",
        "sulfuric-acid" => "sulfuric-acid",
        _ => "none",
    };
    Ok(PlanetProfile {
        wind_multiplier: finite_number(profile.get("windMultiplier")),
        solar_power_multiplier: rounded(solar_multiplier * luminosity * tidal_bonus, 2),
        geothermal_multiplier: finite_number(profile.get("geothermalMultiplier")),
        mining_multiplier: finite_number(profile.get("miningMultiplier")),
        production_speed_multiplier: finite_number(profile.get("productionSpeedMultiplier")),
        specialization,
        ocean_type,
    })
}

fn extractor_id(resource: &str) -> &'static str {
    match resource {
        "crude_oil" => "oil_extractor",
        "water" | "sulfuric_acid" => "water_pump",
        _ => "mining_machine",
    }
}

fn vein_is_infinite(
    resource: &str,
    item_kind: &str,
    profile: PlanetProfile,
    infinite_resource_mode: bool,
    solid_consumption_tenths: f64,
) -> bool {
    infinite_resource_mode
        || item_kind == "solid" && solid_consumption_tenths <= 0.0
        || resource == "water" && profile.ocean_type == "water"
        || resource == "sulfuric_acid" && profile.ocean_type == "sulfuric-acid"
}

fn specialization_applies(profile: PlanetProfile, building: &BuildingDefinition) -> bool {
    match profile.specialization {
        "balanced" => true,
        "smelting" => building.family.as_deref() == Some("smelter"),
        "chemical" => building.family.as_deref() == Some("chemical"),
        "research" => building.id == "matrix_lab",
        "particle" => {
            matches!(
                building.id.as_str(),
                "miniature_particle_collider" | "fractionator"
            )
        }
        _ => building.id == "orbital_collector" || building.id.contains("logistics_station"),
    }
}

fn completed_tech(base: &Map<String, Value>, id: &str) -> bool {
    base.get("research")
        .and_then(Value::as_object)
        .and_then(|value| value.get("completedTechIds"))
        .and_then(Value::as_array)
        .is_some_and(|values| values.iter().any(|value| value.as_str() == Some(id)))
}

fn vein_utilization_level(base: &Map<String, Value>) -> f64 {
    number_at(
        base.get("endgame"),
        &["infiniteResearch", "vein_utilization", "level"],
    )
    .floor()
    .clamp(0.0, 1_000.0)
}

fn difficulty_multipliers(base: &Map<String, Value>) -> (f64, f64) {
    match base
        .get("settings")
        .and_then(Value::as_object)
        .and_then(|value| value.get("difficulty"))
        .and_then(Value::as_str)
        .unwrap_or("standard")
    {
        "relaxed" => (1.15, 0.9),
        "hard" => (0.85, 1.2),
        _ => (1.0, 1.0),
    }
}

fn industrial_speed_multiplier(base: &Map<String, Value>) -> f64 {
    let level = number_at(
        base.get("endgame"),
        &["infiniteResearch", "matrix_compression", "level"],
    )
    .floor()
    .clamp(0.0, 1_000.0);
    let difficulty = match base
        .get("settings")
        .and_then(Value::as_object)
        .and_then(|value| value.get("difficulty"))
        .and_then(Value::as_str)
        .unwrap_or("standard")
    {
        "relaxed" => 1.15,
        "hard" => 0.85,
        _ => 1.0,
    };
    (1.0 + level * 0.04) * difficulty
}

fn research_speed_multiplier(base: &Map<String, Value>) -> f64 {
    let finite_bonus = ["research_speed_1", "research_speed_2", "research_speed_3"]
        .iter()
        .filter(|id| completed_tech(base, id))
        .count() as f64
        * 0.25;
    let compression = number_at(
        base.get("endgame"),
        &["infiniteResearch", "matrix_compression", "level"],
    )
    .floor()
    .clamp(0.0, 1_000.0);
    let difficulty = match base
        .get("settings")
        .and_then(Value::as_object)
        .and_then(|value| value.get("difficulty"))
        .and_then(Value::as_str)
        .unwrap_or("standard")
    {
        "relaxed" => 1.15,
        "hard" => 0.85,
        _ => 1.0,
    };
    (1.0 + finite_bonus) * (1.0 + compression * 0.1) * difficulty
}

fn recipe_technology_available(base: &Map<String, Value>, recipe: &RecipeDefinition) -> bool {
    recipe
        .required_tech_id
        .as_deref()
        .is_none_or(|id| completed_tech(base, id))
}

fn proliferator_tier(entity: &Map<String, Value>) -> Option<u8> {
    entity
        .get("proliferatorTier")
        .and_then(Value::as_u64)
        .and_then(|value| u8::try_from(value).ok())
}

fn proliferator_applies(entity: &Map<String, Value>, recipe: &RecipeDefinition) -> bool {
    entity.get("sprayCoaterInstalled").and_then(Value::as_bool) == Some(true)
        && proliferator_tier(entity).is_some()
        && matches!(
            string_at(entity, "proliferatorMode"),
            Some("extra" | "speed")
        )
        && (if recipe.id == "matrix_research" {
            string_at(entity, "proliferatorMode") == Some("speed")
        } else {
            !recipe.inputs.is_empty() && !recipe.outputs.is_empty()
        })
}

fn proliferator_spray_cost(recipe: &RecipeDefinition) -> f64 {
    recipe
        .inputs
        .iter()
        .map(|input| input.amount)
        .sum::<f64>()
        .max(1.0)
}

fn available_full_proliferator_cycles(
    state: &CoreState,
    entity: &Map<String, Value>,
    recipe: &RecipeDefinition,
) -> f64 {
    if !proliferator_applies(entity, recipe) {
        return 0.0;
    }
    let Some(definition) =
        proliferator_tier(entity).and_then(|tier| state.catalog.proliferators.get(&tier))
    else {
        return 0.0;
    };
    let points = finite_number(entity.get("proliferatorPoints")).max(0.0)
        + entity
            .get("inputs")
            .and_then(Value::as_object)
            .and_then(|inputs| inputs.get(&definition.item_id))
            .map(|value| (finite_number(Some(value)) + EPSILON).floor())
            .unwrap_or(0.0)
            * definition.spray_points;
    (points / proliferator_spray_cost(recipe) + EPSILON)
        .floor()
        .max(0.0)
}

fn proliferator_extra_bonus(
    state: &CoreState,
    entity: &Map<String, Value>,
    recipe: &RecipeDefinition,
) -> f64 {
    if !proliferator_applies(entity, recipe)
        || string_at(entity, "proliferatorMode") != Some("extra")
    {
        return 0.0;
    }
    proliferator_tier(entity)
        .and_then(|tier| state.catalog.proliferators.get(&tier))
        .map(|definition| definition.extra_product_bonus)
        .unwrap_or(0.0)
}

pub(crate) fn next_proliferated_output_bonus(
    state: &CoreState,
    entity: &Map<String, Value>,
    recipe: &RecipeDefinition,
    item_id: &str,
    output_amount: f64,
) -> f64 {
    if available_full_proliferator_cycles(state, entity, recipe) < 1.0 {
        return 0.0;
    }
    let progress = entity
        .get("proliferatorBonusProgress")
        .and_then(Value::as_object)
        .and_then(|values| values.get(item_id))
        .map(|value| finite_number(Some(value)))
        .unwrap_or(0.0);
    (progress + output_amount * proliferator_extra_bonus(state, entity, recipe) + EPSILON)
        .floor()
        .max(0.0)
}

fn proliferator_speed_multiplier(
    state: &CoreState,
    entity: &Map<String, Value>,
    recipe: &RecipeDefinition,
) -> f64 {
    if !proliferator_applies(entity, recipe)
        || string_at(entity, "proliferatorMode") != Some("speed")
    {
        return 1.0;
    }
    proliferator_tier(entity)
        .and_then(|tier| state.catalog.proliferators.get(&tier))
        .map(|definition| 1.0 + definition.speed_bonus)
        .unwrap_or(1.0)
}

fn proliferator_power_multiplier_for_step(
    state: &CoreState,
    entity: &Map<String, Value>,
    building: &BuildingDefinition,
    recipe: &RecipeDefinition,
    planet_speed: f64,
    recipe_speed: f64,
    seconds: f64,
) -> f64 {
    if !proliferator_applies(entity, recipe) {
        return 1.0;
    }
    let sprayed_cycles = available_full_proliferator_cycles(state, entity, recipe);
    if sprayed_cycles < 1.0 {
        return 1.0;
    }
    let base_cycles_per_second =
        building.speed * finite_number(entity.get("machineCount")) * recipe_speed * planet_speed
            / recipe.duration;
    if base_cycles_per_second <= EPSILON || seconds <= EPSILON {
        return 1.0;
    }
    let speed_multiplier = proliferator_speed_multiplier(state, entity, recipe);
    let accelerated_work = (sprayed_cycles - finite_number(entity.get("progress"))).max(0.0);
    let sprayed_seconds =
        accelerated_work / (base_cycles_per_second * speed_multiplier).max(EPSILON);
    let sprayed_fraction = (sprayed_seconds / seconds).min(1.0);
    let power_multiplier = proliferator_tier(entity)
        .and_then(|tier| state.catalog.proliferators.get(&tier))
        .map(|definition| definition.power_multiplier)
        .unwrap_or(1.0);
    1.0 + (power_multiplier - 1.0) * sprayed_fraction
}

fn consume_proliferator_points(
    state: &CoreState,
    entity: &mut Map<String, Value>,
    recipe: &RecipeDefinition,
    cycles: f64,
) -> anyhow::Result<()> {
    if !proliferator_applies(entity, recipe) || cycles < 1.0 {
        return Ok(());
    }
    let definition = proliferator_tier(entity)
        .and_then(|tier| state.catalog.proliferators.get(&tier))
        .ok_or_else(|| anyhow!("native proliferator definition is missing"))?;
    let required_points = proliferator_spray_cost(recipe) * cycles;
    let mut points = finite_number(entity.get("proliferatorPoints")).max(0.0);
    if points < required_points {
        let required_items = ((required_points - points) / definition.spray_points).ceil();
        let inputs = entity
            .get_mut("inputs")
            .and_then(Value::as_object_mut)
            .ok_or_else(|| anyhow!("native proliferator inputs are missing"))?;
        let available = inputs
            .get(&definition.item_id)
            .map(|value| (finite_number(Some(value)) + EPSILON).floor())
            .unwrap_or(0.0);
        let consumed = required_items.min(available);
        inputs.insert(
            definition.item_id.clone(),
            Number::from_f64(available - consumed)
                .map(Value::Number)
                .unwrap_or(Value::from(0)),
        );
        points += consumed * definition.spray_points;
    }
    set_number(
        entity,
        "proliferatorPoints",
        (points - required_points).max(0.0),
    )
}

fn selected_technology_id(base: &Map<String, Value>) -> Option<&str> {
    base.get("research")
        .and_then(Value::as_object)
        .and_then(|research| research.get("selectedTechId"))
        .and_then(Value::as_str)
}

fn active_infinite_research_id(base: &Map<String, Value>) -> Option<&str> {
    base.get("endgame")
        .and_then(Value::as_object)
        .and_then(|endgame| endgame.get("activeInfiniteResearchId"))
        .and_then(Value::as_str)
}

fn endgame_unlocked(base: &Map<String, Value>) -> bool {
    completed_tech(base, "universe_matrix")
}

fn has_active_research(base: &Map<String, Value>) -> bool {
    selected_technology_id(base).is_some()
        || active_infinite_research_id(base).is_some() && endgame_unlocked(base)
}

fn remaining_research_costs(state: &CoreState, base: &Map<String, Value>) -> Vec<(String, f64)> {
    let Some(technology_id) = selected_technology_id(base) else {
        return Vec::new();
    };
    let Some(technology) = state.catalog.technologies.get(technology_id) else {
        return Vec::new();
    };
    let progress = base
        .get("research")
        .and_then(Value::as_object)
        .and_then(|research| research.get("progressByTech"))
        .and_then(Value::as_object)
        .and_then(|progress| progress.get(technology_id))
        .and_then(Value::as_object);
    technology
        .costs
        .iter()
        .filter_map(|cost| {
            let completed = progress
                .and_then(|values| values.get(&cost.item_id))
                .map(|value| finite_number(Some(value)))
                .unwrap_or(0.0);
            let remaining = (cost.amount - completed).max(0.0);
            (remaining > 0.0).then(|| (cost.item_id.clone(), remaining))
        })
        .collect()
}

fn reset_research_machine_progress(entities: &mut [Value]) -> anyhow::Result<()> {
    for entity in entities.iter_mut().filter_map(Value::as_object_mut) {
        if string_at(entity, "recipeId") == Some("matrix_research") {
            set_number(entity, "progress", 0.0)?;
        }
    }
    Ok(())
}

fn activate_next_queued_technology(
    state: &CoreState,
    base: &mut Map<String, Value>,
) -> anyhow::Result<()> {
    let completed = base
        .get("research")
        .and_then(Value::as_object)
        .and_then(|research| research.get("completedTechIds"))
        .and_then(Value::as_array)
        .map(|ids| ids.iter().filter_map(Value::as_str).collect::<HashSet<_>>())
        .unwrap_or_default();
    let queue = base
        .get("research")
        .and_then(Value::as_object)
        .and_then(|research| research.get("queuedTechIds"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let next_index = queue.iter().position(|id| {
        id.as_str()
            .and_then(|id| state.catalog.technologies.get(id))
            .is_some_and(|technology| {
                technology
                    .prerequisites
                    .iter()
                    .all(|id| completed.contains(id.as_str()))
            })
    });
    let research = base
        .get_mut("research")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| anyhow!("native research state is missing"))?;
    let queued = research
        .get_mut("queuedTechIds")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| anyhow!("native research queue is missing"))?;
    if let Some(index) = next_index {
        let next = queued.remove(index);
        research.insert("selectedTechId".to_owned(), next);
    } else {
        research.insert("selectedTechId".to_owned(), Value::Null);
    }
    Ok(())
}

fn complete_technology(
    state: &CoreState,
    base: &mut Map<String, Value>,
    has_galactic_material_exporter: bool,
    technology_id: &str,
) -> anyhow::Result<()> {
    let technology = state
        .catalog
        .technologies
        .get(technology_id)
        .ok_or_else(|| anyhow!("native technology catalog entry is missing"))?;
    let already_completed = base
        .get("research")
        .and_then(Value::as_object)
        .and_then(|research| research.get("completedTechIds"))
        .and_then(Value::as_array)
        .is_some_and(|ids| ids.iter().any(|id| id.as_str() == Some(technology_id)));
    if already_completed {
        return Ok(());
    }
    base.get_mut("research")
        .and_then(Value::as_object_mut)
        .and_then(|research| research.get_mut("completedTechIds"))
        .and_then(Value::as_array_mut)
        .ok_or_else(|| anyhow!("native completed technology list is missing"))?
        .push(Value::from(technology_id));
    let construction = base
        .get_mut("construction")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| anyhow!("native construction inventory is missing"))?;
    for reward in &technology.construction_rewards {
        let current = finite_number(construction.get(reward));
        construction.insert(
            reward.clone(),
            Number::from_f64((current + 2.0).floor())
                .map(Value::Number)
                .unwrap_or(Value::from(0)),
        );
    }
    if technology_id == "universe_matrix"
        && !has_galactic_material_exporter
        && finite_number(construction.get("galactic_material_exporter")).floor() < 1.0
    {
        construction.insert("galactic_material_exporter".to_owned(), Value::from(1));
    }
    if technology_id == "interstellar_logistics" {
        let colonized = base
            .get_mut("exploration")
            .and_then(Value::as_object_mut)
            .and_then(|exploration| exploration.get_mut("colonizedPlanetIds"))
            .and_then(Value::as_array_mut)
            .ok_or_else(|| anyhow!("native colonized planet list is missing"))?;
        for planet in ["ashen", "giant"] {
            if !colonized.iter().any(|value| value.as_str() == Some(planet)) {
                colonized.push(Value::from(planet));
            }
        }
    }
    Ok(())
}

fn settle_completed_research_boundaries(
    state: &CoreState,
    base: &mut Map<String, Value>,
    entities: &mut [Value],
) -> anyhow::Result<()> {
    let queue_len = base
        .get("research")
        .and_then(Value::as_object)
        .and_then(|research| research.get("queuedTechIds"))
        .and_then(Value::as_array)
        .map(Vec::len)
        .unwrap_or(0);
    let limit = state.catalog.recipes.len() + queue_len + 8;
    for _ in 0..limit {
        let Some(technology_id) = selected_technology_id(base).map(str::to_owned) else {
            break;
        };
        let Some(technology) = state.catalog.technologies.get(&technology_id).cloned() else {
            activate_next_queued_technology(state, base)?;
            continue;
        };
        if completed_tech(base, &technology_id) {
            activate_next_queued_technology(state, base)?;
            continue;
        }
        let complete = technology.costs.iter().all(|cost| {
            base.get("research")
                .and_then(Value::as_object)
                .and_then(|research| research.get("progressByTech"))
                .and_then(Value::as_object)
                .and_then(|progress| progress.get(&technology_id))
                .and_then(Value::as_object)
                .and_then(|progress| progress.get(&cost.item_id))
                .map(|value| finite_number(Some(value)).floor() >= cost.amount)
                .unwrap_or(false)
        });
        if !complete {
            break;
        }
        let progress = base
            .get_mut("research")
            .and_then(Value::as_object_mut)
            .and_then(|research| research.get_mut("progressByTech"))
            .and_then(Value::as_object_mut)
            .ok_or_else(|| anyhow!("native research progress directory is missing"))?
            .entry(technology_id.clone())
            .or_insert_with(|| Value::Object(Map::new()))
            .as_object_mut()
            .ok_or_else(|| anyhow!("native research progress entry is invalid"))?;
        for cost in &technology.costs {
            progress.insert(
                cost.item_id.clone(),
                Number::from_f64(cost.amount)
                    .map(Value::Number)
                    .unwrap_or(Value::from(0)),
            );
        }
        let has_exporter = entities
            .iter()
            .filter_map(Value::as_object)
            .any(|entity| string_at(entity, "buildingId") == Some("galactic_material_exporter"));
        complete_technology(state, base, has_exporter, &technology_id)?;
        activate_next_queued_technology(state, base)?;
        reset_research_machine_progress(entities)?;
    }
    Ok(())
}

fn invest_finite_research(
    state: &CoreState,
    base: &mut Map<String, Value>,
    entity: &mut Map<String, Value>,
    requested_cycles: f64,
    has_galactic_material_exporter: bool,
) -> anyhow::Result<(f64, bool)> {
    if requested_cycles < 1.0 {
        return Ok((0.0, false));
    }
    let Some(technology_id) = selected_technology_id(base).map(str::to_owned) else {
        return Ok((0.0, false));
    };
    let Some(technology) = state.catalog.technologies.get(&technology_id).cloned() else {
        return Ok((0.0, false));
    };
    let current_progress = base
        .get("research")
        .and_then(Value::as_object)
        .and_then(|research| research.get("progressByTech"))
        .and_then(Value::as_object)
        .and_then(|progress| progress.get(&technology_id))
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let mut progress = current_progress;
    let mut remaining_cycles = requested_cycles.floor().max(0.0);
    let mut consumed = 0.0;
    for cost in &technology.costs {
        if remaining_cycles < 1.0 {
            break;
        }
        let completed = finite_number(progress.get(&cost.item_id));
        let remaining_cost = (cost.amount - completed).max(0.0);
        let available = entity
            .get("inputs")
            .and_then(Value::as_object)
            .and_then(|inputs| inputs.get(&cost.item_id))
            .map(|value| (finite_number(Some(value)) + EPSILON).floor())
            .unwrap_or(0.0);
        let amount = remaining_cycles.min(remaining_cost).min(available).floor();
        if amount < 1.0 {
            continue;
        }
        entity
            .get_mut("inputs")
            .and_then(Value::as_object_mut)
            .ok_or_else(|| anyhow!("native research machine inputs are missing"))?
            .insert(
                cost.item_id.clone(),
                Number::from_f64(available - amount)
                    .map(Value::Number)
                    .unwrap_or(Value::from(0)),
            );
        progress.insert(
            cost.item_id.clone(),
            Number::from_f64((completed + amount).floor())
                .map(Value::Number)
                .unwrap_or(Value::from(0)),
        );
        remaining_cycles -= amount;
        consumed += amount;
    }
    base.get_mut("research")
        .and_then(Value::as_object_mut)
        .and_then(|research| research.get_mut("progressByTech"))
        .and_then(Value::as_object_mut)
        .ok_or_else(|| anyhow!("native research progress directory is missing"))?
        .insert(technology_id.clone(), Value::Object(progress.clone()));
    let completed = technology
        .costs
        .iter()
        .all(|cost| finite_number(progress.get(&cost.item_id)).floor() >= cost.amount);
    if completed {
        complete_technology(state, base, has_galactic_material_exporter, &technology_id)?;
        activate_next_queued_technology(state, base)?;
    }
    Ok((consumed, completed))
}

fn parse_decimal_u128(value: Option<&str>) -> anyhow::Result<u128> {
    let value = value.unwrap_or("0");
    if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return Ok(0);
    }
    value
        .parse::<u128>()
        .map_err(|_| anyhow!("native infinite research integer exceeds u128"))
}

fn invest_infinite_research(
    base: &mut Map<String, Value>,
    entity: &mut Map<String, Value>,
    requested_cycles: f64,
) -> anyhow::Result<(f64, bool)> {
    if requested_cycles < 1.0 || !endgame_unlocked(base) {
        return Ok((0.0, false));
    }
    let Some(research_id) = active_infinite_research_id(base).map(str::to_owned) else {
        return Ok((0.0, false));
    };
    let available = (item_amount(entity, "inputs", "universe_matrix") + EPSILON).floor();
    let requested = requested_cycles.floor().min(available).max(0.0) as u128;
    if requested == 0 {
        return Ok((0.0, false));
    }
    let (level, progress, auto_research) = {
        let endgame = base
            .get("endgame")
            .and_then(Value::as_object)
            .ok_or_else(|| anyhow!("native endgame state is missing"))?;
        let progress = endgame
            .get("infiniteResearch")
            .and_then(Value::as_object)
            .and_then(|values| values.get(&research_id))
            .and_then(Value::as_object)
            .ok_or_else(|| anyhow!("native infinite research progress is missing"))?;
        (
            finite_number(progress.get("level")).floor().max(0.0) as u32,
            parse_decimal_u128(progress.get("progress").and_then(Value::as_str))?,
            endgame
                .get("autoResearch")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        )
    };
    let settlement =
        crate::infinite_research::settle(&research_id, level, progress, requested, auto_research)?;
    let consumed = settlement.consumed as f64;
    if settlement.consumed > 0 {
        set_item_amount(entity, "inputs", "universe_matrix", available - consumed)?;
    }
    let endgame = base
        .get_mut("endgame")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| anyhow!("native endgame state is missing"))?;
    let progress = endgame
        .get_mut("infiniteResearch")
        .and_then(Value::as_object_mut)
        .and_then(|values| values.get_mut(&research_id))
        .and_then(Value::as_object_mut)
        .ok_or_else(|| anyhow!("native infinite research progress is missing"))?;
    progress.insert("level".to_owned(), Value::from(settlement.level));
    progress.insert(
        "progress".to_owned(),
        Value::from(settlement.progress.to_string()),
    );
    let score_gain = settlement
        .completed_levels
        .iter()
        .map(|level| 1_000.0 + f64::from(*level) * 250.0)
        .sum::<f64>();
    if score_gain > 0.0 {
        let score = finite_number(endgame.get("galacticScore"));
        set_number(endgame, "galacticScore", (score + score_gain).floor())?;
    }
    if settlement.reached_maximum || !auto_research && !settlement.completed_levels.is_empty() {
        endgame.insert("activeInfiniteResearchId".to_owned(), Value::Null);
    }
    Ok((consumed, settlement.consumed > 0))
}

fn machine_input_cycles(
    state: &CoreState,
    base: &Map<String, Value>,
    entity: &Map<String, Value>,
    recipe: &RecipeDefinition,
) -> f64 {
    let inputs = entity.get("inputs").and_then(Value::as_object);
    if recipe.id == "matrix_research" {
        if selected_technology_id(base).is_none()
            && active_infinite_research_id(base).is_some()
            && endgame_unlocked(base)
        {
            return inputs
                .and_then(|values| values.get("universe_matrix"))
                .map(|value| (finite_number(Some(value)) + EPSILON).floor())
                .unwrap_or(0.0);
        }
        return remaining_research_costs(state, base)
            .iter()
            .map(|(item_id, remaining)| {
                remaining.min(
                    inputs
                        .and_then(|values| values.get(item_id))
                        .map(|value| (finite_number(Some(value)) + EPSILON).floor())
                        .unwrap_or(0.0),
                )
            })
            .sum();
    }
    recipe
        .inputs
        .iter()
        .fold(f64::INFINITY, |available, input| {
            available.min(
                inputs
                    .and_then(|values| values.get(&input.item_id))
                    .map(|value| finite_number(Some(value)))
                    .unwrap_or(0.0)
                    / input.amount,
            )
        })
}

fn machine_output_cycles(
    state: &CoreState,
    entity: &Map<String, Value>,
    recipe: &RecipeDefinition,
    capacity: f64,
    maximum: f64,
    credits: Option<&HashMap<String, f64>>,
) -> f64 {
    let entity_id = string_at(entity, "id").unwrap_or_default();
    let outputs = entity.get("outputs").and_then(Value::as_object);
    let extra_bonus = proliferator_extra_bonus(state, entity, recipe);
    let sprayed_cycle_limit = available_full_proliferator_cycles(state, entity, recipe);
    recipe
        .outputs
        .iter()
        .fold(f64::INFINITY, |available, output| {
            let current = outputs
                .and_then(|values| values.get(&output.item_id))
                .map(|value| finite_number(Some(value)))
                .unwrap_or(0.0);
            let free = ((capacity - current).max(0.0)
                + credits
                    .map(|credits| crate::belts::output_credit(credits, entity_id, &output.item_id))
                    .unwrap_or(0.0)
                + EPSILON)
                .floor();
            let mut low = 0.0;
            let mut high = (free / output.amount).floor().min(maximum.floor().max(0.0));
            let bonus_progress = entity
                .get("proliferatorBonusProgress")
                .and_then(Value::as_object)
                .and_then(|values| values.get(&output.item_id))
                .map(|value| finite_number(Some(value)))
                .unwrap_or(0.0);
            if extra_bonus <= EPSILON || sprayed_cycle_limit < 1.0 {
                let static_bonus = (bonus_progress + EPSILON).floor();
                return available.min(
                    high.min(((free - static_bonus) / output.amount).floor())
                        .max(0.0),
                );
            }
            if high > sprayed_cycle_limit {
                let bonus_at_limit =
                    (bonus_progress + output.amount * sprayed_cycle_limit * extra_bonus + EPSILON)
                        .floor();
                let beyond_spray = high
                    .min(((free - bonus_at_limit) / output.amount).floor())
                    .max(0.0);
                if beyond_spray >= sprayed_cycle_limit {
                    return available.min(beyond_spray);
                }
                high = high.min(sprayed_cycle_limit);
            }
            while low < high {
                let candidate = ((low + high) / 2.0).ceil();
                let sprayed = candidate.min(sprayed_cycle_limit);
                let bonus =
                    (bonus_progress + output.amount * sprayed * extra_bonus + EPSILON).floor();
                if output.amount * candidate + bonus <= free {
                    low = candidate;
                } else {
                    high = candidate - 1.0;
                }
            }
            available.min(low)
        })
}

fn machine_can_run(
    state: &CoreState,
    base: &Map<String, Value>,
    entity: &Map<String, Value>,
    building: &BuildingDefinition,
    recipe: &RecipeDefinition,
    buffer_limit: f64,
) -> bool {
    if !recipe_technology_available(base, recipe) {
        return false;
    }
    if proliferator_applies(entity, recipe)
        && proliferator_tier(entity)
            .and_then(|tier| state.catalog.proliferators.get(&tier))
            .is_none_or(|definition| !completed_tech(base, &definition.required_tech_id))
    {
        return false;
    }
    let capacity = stacked_capacity(
        building.output_capacity,
        finite_number(entity.get("machineCount")),
        buffer_limit,
    );
    if recipe.id == "matrix_research" && !has_active_research(base) {
        return false;
    }
    if recipe.id == "solar_sail_launch" && !crate::dyson::valid_ejector_target(state, base, entity)
    {
        return false;
    }
    (machine_input_cycles(state, base, entity, recipe) + EPSILON).floor() >= 1.0
        && (machine_output_cycles(state, entity, recipe, capacity, 1.0, None) + EPSILON).floor()
            >= 1.0
}

fn metric_value(grid_id: Option<&str>, grid: &GridRuntime, total_items_per_minute: f64) -> Value {
    let fuel_reserve_seconds = if grid.rated_fuel_generator_kw > EPSILON {
        rounded(
            grid.fuel_electric_energy_mj * 1_000.0 / grid.rated_fuel_generator_kw,
            1,
        )
    } else {
        0.0
    };
    let mut metric = json!({
        "generationKw": rounded(grid.generation_kw, 2),
        "demandKw": rounded(grid.demand_kw, 2),
        "powerFactor": rounded(grid.factor, 4),
        "windGenerationKw": rounded(grid.wind_generation_kw, 2),
        "solarGenerationKw": rounded(grid.solar_generation_kw, 2),
        "geothermalGenerationKw": rounded(grid.geothermal_generation_kw, 2),
        "thermalGenerationKw": rounded(grid.thermal_generation_kw, 2),
        "fusionGenerationKw": rounded(grid.fusion_generation_kw, 2),
        "artificialStarGenerationKw": rounded(grid.artificial_star_generation_kw, 2),
        "rayGenerationKw": rounded(grid.ray_generation_kw, 2),
        "storageDischargeKw": rounded(grid.storage_discharge_kw, 2),
        "storageChargeKw": rounded(grid.storage_charge_kw, 2),
        "storedEnergyMj": rounded(grid.stored_energy_mj, 3),
        "storageCapacityMj": rounded(grid.storage_capacity_mj, 3),
        "fuelReserveSeconds": fuel_reserve_seconds,
        "totalItemsPerMinute": rounded(total_items_per_minute, 2),
    });
    if let Some(grid_id) = grid_id {
        let object = metric.as_object_mut().expect("metric object");
        object.insert("gridId".to_owned(), Value::from(grid_id));
        object.insert(
            "connectedEntities".to_owned(),
            Value::from(grid.connected_entities),
        );
        object.insert(
            "disconnectedEntities".to_owned(),
            Value::from(grid.disconnected_entities),
        );
        object.insert(
            "generatorCount".to_owned(),
            Number::from_f64(grid.generator_count)
                .map(Value::Number)
                .unwrap_or(Value::from(0)),
        );
        object.insert("coverageRadius".to_owned(), Value::from(0));
    }
    metric
}

fn entity_object(entity: &mut Value) -> anyhow::Result<&mut Map<String, Value>> {
    entity
        .as_object_mut()
        .ok_or_else(|| anyhow!("native simple factory entity is not an object"))
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
        .ok_or_else(|| anyhow!("native power inventory record is missing"))?
        .insert(
            item_id.to_owned(),
            Number::from_f64(amount)
                .map(Value::Number)
                .ok_or_else(|| anyhow!("native power inventory amount is non-finite"))?,
        );
    Ok(())
}

fn add_total_produced(
    base: &mut Map<String, Value>,
    item_id: &str,
    amount: f64,
) -> anyhow::Result<()> {
    if amount <= 0.0 {
        return Ok(());
    }
    let total = base
        .get_mut("totalProduced")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| anyhow!("native power total production record is missing"))?;
    let current = total
        .get(item_id)
        .map(|value| finite_number(Some(value)))
        .unwrap_or(0.0);
    total.insert(
        item_id.to_owned(),
        Number::from_f64((current + amount).floor())
            .map(Value::Number)
            .ok_or_else(|| anyhow!("native power total production is non-finite"))?,
    );
    Ok(())
}

fn burn_fuel(
    state: &CoreState,
    entity: &mut Map<String, Value>,
    building: &BuildingDefinition,
    output_kw: f64,
    seconds: f64,
) -> anyhow::Result<()> {
    let Some(fuel_item_id) = string_at(entity, "fuelItemId").map(str::to_owned) else {
        return Ok(());
    };
    if output_kw <= EPSILON {
        return Ok(());
    }
    let energy_per_item = state
        .catalog
        .items
        .get(&fuel_item_id)
        .map(|item| item.fuel_energy_mj)
        .unwrap_or(0.0);
    let required_heat_mj = (output_kw * seconds / (1_000.0 * building.fuel_efficiency)).max(0.0);
    let initial_heat_mj = finite_number(entity.get("fuelRemainingMj")).max(0.0);
    let queued_fuel = (item_amount(entity, "inputs", &fuel_item_id) + EPSILON).floor();
    if energy_per_item <= EPSILON {
        set_number(
            entity,
            "fuelRemainingMj",
            rounded(
                (initial_heat_mj - required_heat_mj.min(initial_heat_mj)).max(0.0),
                6,
            ),
        )?;
        return Ok(());
    }
    let heat_needed_after_current = (required_heat_mj - initial_heat_mj).max(0.0);
    let requested_items = if heat_needed_after_current > EPSILON {
        ((heat_needed_after_current - EPSILON).max(0.0) / energy_per_item).ceil()
    } else {
        0.0
    };
    let loaded = queued_fuel.min(requested_items);
    let available_heat_mj = initial_heat_mj + loaded * energy_per_item;
    let burned_heat_mj = required_heat_mj.min(available_heat_mj);
    if loaded > 0.0 {
        set_item_amount(entity, "inputs", &fuel_item_id, queued_fuel - loaded)?;
    }
    set_number(
        entity,
        "fuelRemainingMj",
        rounded((available_heat_mj - burned_heat_mj).max(0.0), 6),
    )?;
    Ok(())
}

fn charge_exchanger(
    state: &CoreState,
    base: &mut Map<String, Value>,
    entity: &mut Map<String, Value>,
    building: &BuildingDefinition,
    energy_mj: f64,
    buffer_limit: f64,
) -> anyhow::Result<f64> {
    if energy_mj <= EPSILON {
        return Ok(0.0);
    }
    let cell_energy_mj = accumulator_energy_mj(state)?;
    let stored = stored_energy(entity, building).min(cell_energy_mj);
    let active_cells = if stored > EPSILON { 1.0 } else { 0.0 };
    let queued_cells = (item_amount(entity, "inputs", "accumulator") + EPSILON).floor();
    let usable_cells = (active_cells + queued_cells).min(item_output_free(
        entity,
        building,
        "charged_accumulator",
        buffer_limit,
    ));
    if usable_cells < 1.0 {
        return Ok(0.0);
    }
    let applied_energy_mj = energy_mj
        .max(0.0)
        .min((usable_cells * cell_energy_mj - stored).max(0.0));
    if applied_energy_mj <= EPSILON {
        return Ok(0.0);
    }
    let total_energy_mj = stored + applied_energy_mj;
    let completed = usable_cells.min(((total_energy_mj + EPSILON) / cell_energy_mj).floor());
    let remaining_energy_mj = (total_energy_mj - completed * cell_energy_mj).max(0.0);
    let residual = if remaining_energy_mj > EPSILON {
        remaining_energy_mj
    } else {
        0.0
    };
    let touched_cells = completed + if residual > EPSILON { 1.0 } else { 0.0 };
    let consumed_cells = queued_cells.min((touched_cells - active_cells).max(0.0));
    if consumed_cells > 0.0 {
        set_item_amount(
            entity,
            "inputs",
            "accumulator",
            queued_cells - consumed_cells,
        )?;
    }
    let previous = item_amount(entity, "outputs", "charged_accumulator");
    set_item_amount(
        entity,
        "outputs",
        "charged_accumulator",
        (previous + completed).floor(),
    )?;
    add_total_produced(base, "charged_accumulator", completed)?;
    set_number(entity, "storedEnergyMj", rounded(residual, 6))?;
    set_number(entity, "progress", residual / cell_energy_mj)?;
    Ok(completed)
}

fn discharge_exchanger(
    state: &CoreState,
    base: &mut Map<String, Value>,
    entity: &mut Map<String, Value>,
    building: &BuildingDefinition,
    energy_mj: f64,
    buffer_limit: f64,
) -> anyhow::Result<f64> {
    if energy_mj <= EPSILON {
        return Ok(0.0);
    }
    let cell_energy_mj = accumulator_energy_mj(state)?;
    let stored = stored_energy(entity, building).min(cell_energy_mj);
    let active_cells = if stored > EPSILON { 1.0 } else { 0.0 };
    let queued_cells = (item_amount(entity, "inputs", "charged_accumulator") + EPSILON).floor();
    let usable_cells = (active_cells + queued_cells).min(item_output_free(
        entity,
        building,
        "accumulator",
        buffer_limit,
    ));
    if usable_cells < 1.0 {
        return Ok(0.0);
    }
    let available_energy_mj = stored + (usable_cells - active_cells).max(0.0) * cell_energy_mj;
    let applied_energy_mj = energy_mj.max(0.0).min(available_energy_mj);
    if applied_energy_mj <= EPSILON {
        return Ok(0.0);
    }
    let energy_needed_after_current = (applied_energy_mj - stored).max(0.0);
    let loaded_cells = queued_cells.min(if energy_needed_after_current > EPSILON {
        ((energy_needed_after_current - EPSILON).max(0.0) / cell_energy_mj).ceil()
    } else {
        0.0
    });
    let remaining_energy_mj = (stored + loaded_cells * cell_energy_mj - applied_energy_mj).max(0.0);
    let residual = if remaining_energy_mj > EPSILON {
        remaining_energy_mj
    } else {
        0.0
    };
    let completed =
        (active_cells + loaded_cells - if residual > EPSILON { 1.0 } else { 0.0 }).max(0.0);
    if loaded_cells > 0.0 {
        set_item_amount(
            entity,
            "inputs",
            "charged_accumulator",
            queued_cells - loaded_cells,
        )?;
    }
    let previous = item_amount(entity, "outputs", "accumulator");
    set_item_amount(
        entity,
        "outputs",
        "accumulator",
        (previous + completed).floor(),
    )?;
    add_total_produced(base, "accumulator", completed)?;
    set_number(entity, "storedEnergyMj", rounded(residual, 6))?;
    set_number(
        entity,
        "progress",
        if residual > EPSILON {
            1.0 - residual / cell_energy_mj
        } else {
            0.0
        },
    )?;
    Ok(completed)
}

fn power_reserves(
    state: &CoreState,
    entities: &[Value],
    planet_id: &str,
) -> anyhow::Result<(f64, f64, f64, f64)> {
    let mut stored_mj = 0.0;
    let mut capacity_mj = 0.0;
    let mut fuel_electric_mj = 0.0;
    let mut rated_fuel_kw = 0.0;
    for entity in entities.iter().filter_map(Value::as_object) {
        if string_at(entity, "planetId") != Some(planet_id) {
            continue;
        }
        let Some(building_id) = string_at(entity, "buildingId") else {
            continue;
        };
        let building = state
            .catalog
            .buildings
            .get(building_id)
            .ok_or_else(|| anyhow!("native power reserve building is missing"))?;
        if matches!(building_id, "accumulator" | "energy_exchanger") {
            stored_mj += stored_energy(entity, building);
            capacity_mj += energy_capacity(entity, building);
        } else if is_fuel_generator(building_id) {
            fuel_electric_mj +=
                fuel_energy_available(state, entity, building) * building.fuel_efficiency;
            rated_fuel_kw +=
                building.power_generation_kw * finite_number(entity.get("machineCount"));
        }
    }
    Ok((stored_mj, capacity_mj, fuel_electric_mj, rated_fuel_kw))
}

fn transfer_logistics_buffers(
    state: &CoreState,
    base: &Map<String, Value>,
    entities: &mut [Value],
) -> anyhow::Result<()> {
    let limit = normalized_buffer_limit(
        base.get("settings")
            .and_then(Value::as_object)
            .and_then(|settings| settings.get("logisticsBufferLimit")),
    );
    for entity in entities.iter_mut().filter_map(Value::as_object_mut) {
        if !matches!(string_at(entity, "kind"), Some("storage" | "splitter")) {
            continue;
        }
        let Some(item_id) = string_at(entity, "storedItemId").map(str::to_owned) else {
            continue;
        };
        let building = string_at(entity, "buildingId")
            .and_then(|id| state.catalog.buildings.get(id))
            .ok_or_else(|| anyhow!("native logistics building is missing"))?;
        let capacity = stacked_capacity(
            building.output_capacity,
            finite_number(entity.get("machineCount")),
            limit,
        );
        let incoming = entity
            .get("inputs")
            .and_then(Value::as_object)
            .and_then(|inputs| inputs.get(&item_id))
            .map(|value| (finite_number(Some(value)) + EPSILON).floor())
            .unwrap_or(0.0);
        let stored = entity
            .get("outputs")
            .and_then(Value::as_object)
            .and_then(|outputs| outputs.get(&item_id))
            .map(|value| (finite_number(Some(value)) + EPSILON).floor())
            .unwrap_or(0.0);
        let moved = incoming.min((capacity - stored).max(0.0));
        entity
            .get_mut("inputs")
            .and_then(Value::as_object_mut)
            .ok_or_else(|| anyhow!("native logistics inputs are missing"))?
            .insert(
                item_id.clone(),
                Number::from_f64(incoming - moved)
                    .map(Value::Number)
                    .unwrap_or(Value::from(0)),
            );
        entity
            .get_mut("outputs")
            .and_then(Value::as_object_mut)
            .ok_or_else(|| anyhow!("native logistics outputs are missing"))?
            .insert(
                item_id,
                Number::from_f64(stored + moved)
                    .map(Value::Number)
                    .unwrap_or(Value::from(0)),
            );
    }
    Ok(())
}

fn prepare_inactive_time_warp(
    base: &mut Map<String, Value>,
    entities: &mut [Value],
) -> anyhow::Result<()> {
    let controller_id = base
        .get("timeWarp")
        .and_then(Value::as_object)
        .and_then(|time_warp| string_at(time_warp, "controllerEntityId"))
        .map(str::to_owned);
    let controller_valid = controller_id.as_deref().is_some_and(|id| {
        entities.iter().filter_map(Value::as_object).any(|entity| {
            string_at(entity, "id") == Some(id)
                && string_at(entity, "buildingId") == Some("time_warp_device")
        })
    });
    let simulation_speed = base
        .get("settings")
        .and_then(Value::as_object)
        .and_then(|settings| settings.get("simulationSpeed"))
        .map(|value| finite_number(Some(value)))
        .unwrap_or(1.0);
    let time_warp = base
        .get_mut("timeWarp")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| anyhow!("native time-warp state is missing"))?;
    if !controller_valid {
        time_warp.insert("controllerEntityId".to_owned(), Value::Null);
        time_warp.insert("enabled".to_owned(), Value::Bool(false));
    }
    set_number(time_warp, "effectiveMultiplier", simulation_speed)?;
    set_number(time_warp, "requiredPowerKw", 0.0)?;
    set_number(time_warp, "allocatedPowerKw", 0.0)?;
    for entity in entities.iter_mut().filter_map(Value::as_object_mut) {
        if string_at(entity, "buildingId") != Some("time_warp_device") {
            continue;
        }
        set_number(entity, "powerInputKw", 0.0)?;
        set_number(entity, "powerFactor", 0.0)?;
        set_number(entity, "utilization", 0.0)?;
        set_number(entity, "productionRate", 0.0)?;
    }
    Ok(())
}

fn simulate_step(
    state: &CoreState,
    base: &mut Map<String, Value>,
    entities: &mut [Value],
    belts: &mut [Value],
    seconds: f64,
) -> anyhow::Result<()> {
    let elapsed_before_step = finite_number(base.get("elapsedSeconds"));
    let projected_elapsed = rounded(elapsed_before_step + seconds, 4);
    let first_quantum_boundary = (elapsed_before_step / 5.0).floor() as u64 + 1;
    let last_quantum_boundary = (projected_elapsed / 5.0).floor() as u64;
    let crossed_quantum_boundary = first_quantum_boundary <= last_quantum_boundary;
    // The TypeScript engine builds its quantum endpoint lookup before this
    // simulation call. A tower that completes attachment at a boundary is
    // intentionally absent from uploads until the next call refreshes that
    // lookup, even when this call crosses more than one boundary.
    let indexed_quantum_endpoint_ids = entities
        .iter()
        .filter_map(Value::as_object)
        .filter(|entity| {
            string_at(entity, "kind") == Some("station")
                && string_at(entity, "quantumMode") == Some("quantum")
                && matches!(
                    string_at(entity, "buildingId"),
                    Some("interstellar_logistics_station" | "orbital_collector")
                )
        })
        .filter_map(|entity| string_at(entity, "id").map(str::to_owned))
        .collect::<HashSet<_>>();
    prepare_inactive_time_warp(base, entities)?;
    crate::dyson::advance_environment(base, seconds)?;
    crate::local_logistics::reset_runtime(entities)?;
    transfer_logistics_buffers(state, base, entities)?;
    crate::local_logistics::transfer_buffers(state, base, entities)?;
    crate::quantum_logistics::flush_supply_buffers(base, entities)?;
    crate::belts::transfer(state, base, entities, belts, seconds, true, None, seconds)?;
    let belt_reservation = crate::belts::reserve(state, base, entities, belts)?;
    crate::interstellar_logistics::run_orbital_collectors(
        state,
        base,
        entities,
        seconds,
        &belt_reservation.output_credits,
    )?;
    let reception = crate::dyson::calculate_reception(state, base, entities)?;
    let planet_ids = state
        .catalog
        .planets
        .iter()
        .map(|planet| planet.id.clone())
        .collect::<Vec<_>>();
    let planet_index = planet_ids
        .iter()
        .enumerate()
        .map(|(index, id)| (id.clone(), index))
        .collect::<HashMap<_, _>>();
    let profiles = state
        .catalog
        .planets
        .iter()
        .map(|planet| profile_for(base, &planet.id, &planet.system_id))
        .collect::<anyhow::Result<Vec<_>>>()?;
    let (_, power_demand_multiplier) = difficulty_multipliers(base);
    let production_buffer_limit = normalized_buffer_limit(
        base.get("settings")
            .and_then(Value::as_object)
            .and_then(|value| value.get("productionBufferLimit")),
    );
    let mut grids = vec![GridRuntime::default(); planet_ids.len() * GRID_IDS.len()];
    let grid_slot = |planet: usize, grid: usize| planet * GRID_IDS.len() + grid;

    for (entity_index, entity) in entities.iter().enumerate() {
        let object = entity
            .as_object()
            .ok_or_else(|| anyhow!("native simple factory entity is not an object"))?;
        let is_ray_power = string_at(object, "kind") == Some("machine")
            && string_at(object, "buildingId") == Some("ray_receiver")
            && string_at(object, "recipeId") == Some("ray_power");
        if string_at(object, "kind") != Some("power") && !is_ray_power {
            continue;
        }
        let planet = *planet_index
            .get(string_at(object, "planetId").unwrap_or_default())
            .ok_or_else(|| anyhow!("native simple factory entity planet is unknown"))?;
        let grid = grid_index(object)
            .ok_or_else(|| anyhow!("native simple factory entity grid is unknown"))?;
        let runtime = &mut grids[grid_slot(planet, grid)];
        let building_id = string_at(object, "buildingId").unwrap_or_default();
        let building = state
            .catalog
            .buildings
            .get(building_id)
            .ok_or_else(|| anyhow!("native simple factory renewable catalog is missing"))?;
        let machine_count = finite_number(object.get("machineCount"));
        runtime.has_power_source = true;
        runtime.generator_count += machine_count;
        if is_ray_power {
            let output = string_at(object, "id")
                .and_then(|entity_id| reception.ray_power_by_entity.get(entity_id))
                .copied()
                .unwrap_or(0.0);
            runtime.base_generation_kw += output;
            runtime.ray_generation_kw += output;
            runtime.power_output_by_entity.insert(entity_index, output);
            continue;
        }
        if is_fuel_generator(building_id) {
            let available = fuel_energy_available(state, object, building);
            let rated = building.power_generation_kw * machine_count;
            let capacity = rated.min(available * building.fuel_efficiency * 1_000.0 / seconds);
            runtime.fuel_electric_energy_mj += available * building.fuel_efficiency;
            runtime.rated_fuel_generator_kw += rated;
            if capacity > EPSILON {
                runtime.dispatch_candidates.push(PowerCandidate {
                    entity_index,
                    capacity,
                    priority: generation_priority(object, building_id),
                    kind: match building_id {
                        "thermal_power_plant" => DispatchKind::Thermal,
                        "mini_fusion_power_plant" => DispatchKind::Fusion,
                        _ => DispatchKind::ArtificialStar,
                    },
                });
            }
            continue;
        }
        if building_id == "accumulator" {
            let stored = stored_energy(object, building);
            let capacity_mj = energy_capacity(object, building);
            runtime.stored_energy_mj += stored;
            runtime.storage_capacity_mj += capacity_mj;
            let discharge =
                (building.power_generation_kw * machine_count).min(stored * 1_000.0 / seconds);
            let charge = (building.power_charge_kw * machine_count)
                .min((capacity_mj - stored).max(0.0) * 1_000.0 / seconds);
            if discharge > EPSILON {
                runtime.dispatch_candidates.push(PowerCandidate {
                    entity_index,
                    capacity: discharge,
                    priority: generation_priority(object, building_id),
                    kind: DispatchKind::Accumulator,
                });
            }
            if charge > EPSILON {
                runtime.accumulator_charge_candidates.push(PowerCandidate {
                    entity_index,
                    capacity: charge,
                    priority: 1,
                    kind: DispatchKind::Accumulator,
                });
            }
            continue;
        }
        if building_id == "energy_exchanger" {
            let cell_energy_mj = accumulator_energy_mj(state)?;
            let stored = stored_energy(object, building);
            runtime.stored_energy_mj += stored;
            runtime.storage_capacity_mj += energy_capacity(object, building);
            let active_cells = if stored > EPSILON { 1.0 } else { 0.0 };
            let mode = string_at(object, "energyMode").unwrap_or("charge");
            if mode == "discharge" {
                let queued =
                    (item_amount(object, "inputs", "charged_accumulator") + EPSILON).floor();
                let usable = (active_cells + queued).min(item_output_free(
                    object,
                    building,
                    "accumulator",
                    production_buffer_limit,
                ));
                let available = if usable > 0.0 {
                    stored + (usable - active_cells).max(0.0) * cell_energy_mj
                } else {
                    0.0
                };
                let discharge = (building.power_generation_kw * machine_count)
                    .min(available * 1_000.0 / seconds);
                if discharge > EPSILON {
                    runtime.dispatch_candidates.push(PowerCandidate {
                        entity_index,
                        capacity: discharge,
                        priority: generation_priority(object, building_id),
                        kind: DispatchKind::Exchanger,
                    });
                }
            } else {
                let queued = (item_amount(object, "inputs", "accumulator") + EPSILON).floor();
                let usable = (active_cells + queued).min(item_output_free(
                    object,
                    building,
                    "charged_accumulator",
                    production_buffer_limit,
                ));
                let available = if usable > 0.0 {
                    usable * cell_energy_mj - stored
                } else {
                    0.0
                };
                let charge = (building.power_charge_kw * machine_count)
                    .min(available.max(0.0) * 1_000.0 / seconds);
                if charge > EPSILON {
                    runtime.exchanger_charge_candidates.push(PowerCandidate {
                        entity_index,
                        capacity: charge,
                        priority: 2,
                        kind: DispatchKind::Exchanger,
                    });
                }
            }
            continue;
        }
        let multiplier = match building_id {
            "solar_panel" => profiles[planet].solar_power_multiplier,
            "geothermal_power_station" => profiles[planet].geothermal_multiplier,
            _ => profiles[planet].wind_multiplier,
        };
        let output = building.power_generation_kw * machine_count * multiplier;
        runtime.base_generation_kw += output;
        runtime.power_output_by_entity.insert(entity_index, output);
        match building_id {
            "solar_panel" => runtime.solar_generation_kw += output,
            "geothermal_power_station" => runtime.geothermal_generation_kw += output,
            _ => runtime.wind_generation_kw += output,
        }
    }

    let mut ready_stations = crate::local_logistics::ready_station_indices(state, base, entities)?;
    ready_stations.extend(crate::interstellar_logistics::ready_station_indices(
        state, base, entities,
    )?);
    ready_stations.extend(entities.iter().enumerate().filter_map(|(index, entity)| {
        let entity = entity.as_object()?;
        (string_at(entity, "kind") == Some("station")
            && string_at(entity, "buildingId") == Some("interstellar_logistics_station")
            && string_at(entity, "quantumMode") == Some("quantum"))
        .then_some(index)
    }));
    if crate::construction::has_deficit(state, base) {
        ready_stations.extend(entities.iter().enumerate().filter_map(|(index, entity)| {
            let entity = entity.as_object()?;
            (string_at(entity, "kind") == Some("machine")
                && string_at(entity, "buildingId") == Some("construction_center"))
            .then_some(index)
        }));
    }
    let mut disconnected_ready_stations = Vec::new();
    for &entity_index in &ready_stations {
        let object = entities[entity_index]
            .as_object()
            .ok_or_else(|| anyhow!("native local station is not an object"))?;
        let planet = *planet_index
            .get(string_at(object, "planetId").unwrap_or_default())
            .ok_or_else(|| anyhow!("native local station planet is unknown"))?;
        let grid =
            grid_index(object).ok_or_else(|| anyhow!("native local station grid is unknown"))?;
        let runtime = &mut grids[grid_slot(planet, grid)];
        let building = string_at(object, "buildingId")
            .and_then(|id| state.catalog.buildings.get(id))
            .ok_or_else(|| anyhow!("native local station building is missing"))?;
        let demand = building.power_demand_kw
            * finite_number(object.get("machineCount"))
            * power_demand_multiplier;
        let priority = finite_number(object.get("powerPriority"))
            .floor()
            .clamp(1.0, 3.0) as usize;
        if runtime.has_power_source {
            runtime.connected_entities += 1;
            runtime.consumers[priority].push(Consumer {
                entity_index,
                demand_kw: demand,
            });
        } else {
            runtime.disconnected_entities += 1;
            runtime.disconnected_demand_kw += demand;
            disconnected_ready_stations.push(entity_index);
        }
    }

    for (entity_index, entity) in entities.iter().enumerate() {
        let object = entity
            .as_object()
            .ok_or_else(|| anyhow!("native simple factory entity is not an object"))?;
        if string_at(object, "kind") != Some("vein") {
            continue;
        }
        let miner_count = finite_number(object.get("minerCount"));
        if miner_count <= 0.0 {
            continue;
        }
        let planet = *planet_index
            .get(string_at(object, "planetId").unwrap_or_default())
            .ok_or_else(|| anyhow!("native simple factory entity planet is unknown"))?;
        let grid = grid_index(object)
            .ok_or_else(|| anyhow!("native simple factory entity grid is unknown"))?;
        let runtime = &mut grids[grid_slot(planet, grid)];
        let resource = string_at(object, "resourceId").unwrap_or_default();
        let extractor = state
            .catalog
            .buildings
            .get(extractor_id(resource))
            .ok_or_else(|| anyhow!("native simple factory extractor catalog is missing"))?;
        let current = object
            .get("outputs")
            .and_then(Value::as_object)
            .and_then(|outputs| outputs.get(resource))
            .map(|value| finite_number(Some(value)))
            .unwrap_or(0.0);
        let capacity = stacked_capacity(
            extractor.output_capacity,
            miner_count,
            production_buffer_limit,
        );
        let demand = extractor.power_demand_kw * miner_count * power_demand_multiplier;
        if runtime.has_power_source {
            runtime.connected_entities += 1;
            if current < capacity - EPSILON {
                let priority = finite_number(object.get("powerPriority"))
                    .floor()
                    .clamp(1.0, 3.0) as usize;
                runtime.consumers[priority].push(Consumer {
                    entity_index,
                    demand_kw: demand,
                });
            }
        } else {
            runtime.disconnected_entities += 1;
            if current < capacity - EPSILON {
                runtime.disconnected_demand_kw += demand;
            }
        }
    }

    for (entity_index, entity) in entities.iter().enumerate() {
        let object = entity
            .as_object()
            .ok_or_else(|| anyhow!("native simple factory entity is not an object"))?;
        if string_at(object, "kind") != Some("machine") {
            continue;
        }
        let building_id = string_at(object, "buildingId").unwrap_or_default();
        if matches!(
            building_id,
            "construction_center" | "time_warp_device" | "ray_receiver"
        ) {
            continue;
        }
        let recipe_id = string_at(object, "recipeId").unwrap_or_default();
        let building = state
            .catalog
            .buildings
            .get(building_id)
            .ok_or_else(|| anyhow!("native simple factory machine building is missing"))?;
        let recipe = state
            .catalog
            .recipes
            .get(recipe_id)
            .ok_or_else(|| anyhow!("native simple factory machine recipe is missing"))?;
        if !machine_can_run(
            state,
            base,
            object,
            building,
            recipe,
            production_buffer_limit,
        ) {
            continue;
        }
        let planet = *planet_index
            .get(string_at(object, "planetId").unwrap_or_default())
            .ok_or_else(|| anyhow!("native simple factory entity planet is unknown"))?;
        let grid = grid_index(object)
            .ok_or_else(|| anyhow!("native simple factory entity grid is unknown"))?;
        let runtime = &mut grids[grid_slot(planet, grid)];
        let planet_speed = if specialization_applies(profiles[planet], building) {
            profiles[planet].production_speed_multiplier
        } else {
            1.0
        };
        let demand = building.power_demand_kw
            * finite_number(object.get("machineCount"))
            * proliferator_power_multiplier_for_step(
                state,
                object,
                building,
                recipe,
                planet_speed,
                if recipe.id == "matrix_research" {
                    research_speed_multiplier(base)
                } else {
                    industrial_speed_multiplier(base)
                },
                seconds,
            )
            * power_demand_multiplier;
        let priority = finite_number(object.get("powerPriority"))
            .floor()
            .clamp(1.0, 3.0) as usize;
        if runtime.has_power_source {
            runtime.connected_entities += 1;
            runtime.consumers[priority].push(Consumer {
                entity_index,
                demand_kw: demand,
            });
        } else {
            runtime.disconnected_entities += 1;
            runtime.disconnected_demand_kw += demand;
            // calculatePower persists an explicit zero only for consumers
            // that were runnable when their grid was found disconnected.
            // Inserted after allocation below to avoid a second side table.
        }
    }

    let mut power_factors = HashMap::<usize, f64>::new();
    for runtime in &mut grids {
        let connected_demand = runtime
            .consumers
            .iter()
            .flat_map(|group| group.iter())
            .map(|consumer| consumer.demand_kw)
            .sum::<f64>();
        let dispatch_capacity = runtime
            .dispatch_candidates
            .iter()
            .map(|candidate| candidate.capacity)
            .sum::<f64>();
        runtime.generation_kw = runtime.base_generation_kw + dispatch_capacity;
        runtime.supplied_kw = connected_demand.min(runtime.generation_kw);
        runtime.demand_kw = connected_demand + runtime.disconnected_demand_kw;
        runtime.factor = if runtime.demand_kw <= EPSILON {
            1.0
        } else {
            (runtime.supplied_kw / runtime.demand_kw).min(1.0)
        };
        let missing_kw = (runtime.supplied_kw - runtime.base_generation_kw).max(0.0);
        let dispatch_candidates = runtime.dispatch_candidates.clone();
        allocate_power_by_priority(
            &dispatch_candidates,
            missing_kw,
            &mut runtime.power_output_by_entity,
        );
        for candidate in &dispatch_candidates {
            let output = runtime
                .power_output_by_entity
                .get(&candidate.entity_index)
                .copied()
                .unwrap_or(0.0);
            match candidate.kind {
                DispatchKind::Thermal => runtime.thermal_generation_kw += output,
                DispatchKind::Fusion => runtime.fusion_generation_kw += output,
                DispatchKind::ArtificialStar => runtime.artificial_star_generation_kw += output,
                DispatchKind::Accumulator | DispatchKind::Exchanger => {
                    runtime.storage_discharge_kw += output;
                }
            }
        }
        let mut surplus_kw = (runtime.base_generation_kw - runtime.demand_kw).max(0.0);
        let exchanger_charge_candidates = runtime.exchanger_charge_candidates.clone();
        let exchanger_charge = allocate_power(
            &exchanger_charge_candidates,
            surplus_kw,
            &mut runtime.power_input_by_entity,
        );
        runtime.storage_charge_kw += exchanger_charge;
        surplus_kw -= exchanger_charge;
        let accumulator_charge_candidates = runtime.accumulator_charge_candidates.clone();
        let accumulator_charge = allocate_power(
            &accumulator_charge_candidates,
            surplus_kw,
            &mut runtime.power_input_by_entity,
        );
        runtime.storage_charge_kw += accumulator_charge;
        let mut remaining = runtime.supplied_kw.max(0.0);
        for priority in [3_usize, 2, 1] {
            let demand = runtime.consumers[priority]
                .iter()
                .map(|consumer| consumer.demand_kw)
                .sum::<f64>();
            let factor = if demand <= EPSILON {
                1.0
            } else {
                (remaining / demand).min(1.0)
            };
            for consumer in &runtime.consumers[priority] {
                power_factors.insert(consumer.entity_index, factor);
            }
            remaining = (remaining - demand * factor).max(0.0);
        }
    }
    for entity_index in disconnected_ready_stations {
        power_factors.insert(entity_index, 0.0);
    }
    for (entity_index, entity) in entities.iter().enumerate() {
        let Some(object) = entity.as_object() else {
            continue;
        };
        if string_at(object, "kind") != Some("machine") {
            continue;
        }
        if matches!(
            string_at(object, "buildingId"),
            Some("construction_center" | "time_warp_device" | "ray_receiver")
        ) {
            continue;
        }
        let Some(&planet) = planet_index.get(string_at(object, "planetId").unwrap_or_default())
        else {
            continue;
        };
        let Some(grid) = grid_index(object) else {
            continue;
        };
        if grids[grid_slot(planet, grid)].has_power_source {
            continue;
        }
        let Some(building) =
            string_at(object, "buildingId").and_then(|id| state.catalog.buildings.get(id))
        else {
            continue;
        };
        let Some(recipe) =
            string_at(object, "recipeId").and_then(|id| state.catalog.recipes.get(id))
        else {
            continue;
        };
        if machine_can_run(
            state,
            base,
            object,
            building,
            recipe,
            production_buffer_limit,
        ) {
            power_factors.insert(entity_index, 0.0);
        }
    }

    let (difficulty_mining_multiplier, _) = difficulty_multipliers(base);
    let research_base = if completed_tech(base, "mining_speed_3") {
        3.0
    } else if completed_tech(base, "mining_speed_2") {
        2.0
    } else if completed_tech(base, "mining_speed_1") {
        1.5
    } else {
        1.0
    };
    let mining_research_multiplier =
        research_base * (1.0 + vein_utilization_level(base) * 0.1) * difficulty_mining_multiplier;
    let vein_level = vein_utilization_level(base);
    let finite_consumption_tenths = (10.0 - vein_level.min(10.0)).max(0.0).floor();
    let infinite_resource_mode = base
        .get("settings")
        .and_then(Value::as_object)
        .and_then(|settings| settings.get("resourceMode"))
        .and_then(Value::as_str)
        == Some("infinite");
    let mut produced_by_item = HashMap::<String, f64>::new();
    let has_galactic_material_exporter = entities
        .iter()
        .filter_map(Value::as_object)
        .any(|entity| string_at(entity, "buildingId") == Some("galactic_material_exporter"));
    let mut reset_research_progress_before_next_entity = false;

    for entity_index in 0..entities.len() {
        if reset_research_progress_before_next_entity {
            reset_research_machine_progress(entities)?;
            reset_research_progress_before_next_entity = false;
        }
        let object = entity_object(&mut entities[entity_index])?;
        object
            .entry("stationLastSupplyPeerBySlot".to_owned())
            .or_insert_with(|| Value::Object(Map::new()));
        object
            .entry("proliferatorBonusProgress".to_owned())
            .or_insert_with(|| Value::Object(Map::new()));
        let kind = string_at(object, "kind").unwrap_or_default().to_owned();
        let planet = *planet_index
            .get(string_at(object, "planetId").unwrap_or_default())
            .ok_or_else(|| anyhow!("native simple factory entity planet is unknown"))?;
        let grid = grid_index(object)
            .ok_or_else(|| anyhow!("native simple factory entity grid is unknown"))?;
        if kind == "power" {
            let building_id = string_at(object, "buildingId")
                .unwrap_or_default()
                .to_owned();
            let building = state
                .catalog
                .buildings
                .get(&building_id)
                .ok_or_else(|| anyhow!("native simple factory power catalog is missing"))?;
            let machine_count = finite_number(object.get("machineCount"));
            let runtime = &grids[grid_slot(planet, grid)];
            let output = runtime
                .power_output_by_entity
                .get(&entity_index)
                .copied()
                .unwrap_or(0.0);
            let input = runtime
                .power_input_by_entity
                .get(&entity_index)
                .copied()
                .unwrap_or(0.0);
            let rated = building.power_generation_kw * machine_count;
            set_number(object, "powerOutputKw", rounded(output, 2))?;
            set_number(object, "powerInputKw", rounded(input, 2))?;
            set_number(
                object,
                "utilization",
                if rated > EPSILON {
                    rounded(output.max(input) / rated, 4)
                } else {
                    0.0
                },
            )?;
            set_number(object, "productionRate", 0.0)?;
            if is_fuel_generator(&building_id) {
                burn_fuel(state, object, building, output, seconds)?;
            } else if building_id == "accumulator" {
                let capacity = energy_capacity(object, building);
                let next = (stored_energy(object, building) + input * seconds / 1_000.0
                    - output * seconds / 1_000.0)
                    .max(0.0)
                    .min(capacity);
                let rounded_next = rounded(next, 6);
                set_number(object, "storedEnergyMj", rounded_next)?;
                set_number(
                    object,
                    "progress",
                    if capacity > EPSILON {
                        rounded_next / capacity
                    } else {
                        0.0
                    },
                )?;
            } else if building_id == "energy_exchanger" {
                let completed = if string_at(object, "energyMode") == Some("discharge") {
                    discharge_exchanger(
                        state,
                        base,
                        object,
                        building,
                        output * seconds / 1_000.0,
                        production_buffer_limit,
                    )?
                } else {
                    charge_exchanger(
                        state,
                        base,
                        object,
                        building,
                        input * seconds / 1_000.0,
                        production_buffer_limit,
                    )?
                };
                set_number(
                    object,
                    "productionRate",
                    if seconds > EPSILON {
                        rounded(completed * 60.0 / seconds, 2)
                    } else {
                        0.0
                    },
                )?;
            }
            continue;
        }
        if kind == "machine" {
            let building_id = string_at(object, "buildingId")
                .unwrap_or_default()
                .to_owned();
            if matches!(
                building_id.as_str(),
                "construction_center" | "time_warp_device" | "ray_receiver"
            ) {
                continue;
            }
            let recipe_id = string_at(object, "recipeId").unwrap_or_default().to_owned();
            let building = state
                .catalog
                .buildings
                .get(&building_id)
                .ok_or_else(|| anyhow!("native simple factory machine building is missing"))?;
            let recipe = state
                .catalog
                .recipes
                .get(&recipe_id)
                .ok_or_else(|| anyhow!("native simple factory machine recipe is missing"))?;
            if let Some(factor) = power_factors.get(&entity_index).copied() {
                set_number(object, "powerFactor", rounded(factor, 4))?;
            } else {
                object.remove("powerFactor");
            }
            if !recipe_technology_available(base, recipe) {
                set_number(object, "progress", 0.0)?;
                set_number(object, "utilization", 0.0)?;
                set_number(object, "productionRate", 0.0)?;
                continue;
            }
            let machine_count = finite_number(object.get("machineCount"));
            let capacity = stacked_capacity(
                building.output_capacity,
                machine_count,
                production_buffer_limit,
            );
            let input_cycles =
                (machine_input_cycles(state, base, object, recipe) + EPSILON).floor();
            let output_cycles = (machine_output_cycles(
                state,
                object,
                recipe,
                capacity,
                input_cycles,
                Some(&belt_reservation.output_credits),
            ) + EPSILON)
                .floor();
            let maximum_cycles = input_cycles.min(output_cycles);
            let sprayed_cycle_limit = available_full_proliferator_cycles(state, object, recipe);
            let extra_product_bonus = proliferator_extra_bonus(state, object, recipe);
            let progress_at_start = finite_number(object.get("progress"));
            let power_factor = power_factors.get(&entity_index).copied().unwrap_or(1.0);
            let planet_speed = if specialization_applies(profiles[planet], building) {
                profiles[planet].production_speed_multiplier
            } else {
                1.0
            };
            let recipe_speed = if recipe.id == "matrix_research" {
                research_speed_multiplier(base)
            } else {
                industrial_speed_multiplier(base)
            };
            let effective_cycles_per_second =
                building.speed * machine_count * recipe_speed * planet_speed / recipe.duration;
            let launch_factor = crate::dyson::launch_factor(base, &recipe.id);
            let base_rate = effective_cycles_per_second * power_factor * launch_factor;
            let mut potential_cycles = base_rate * seconds;
            let mut sprayed_work = 0.0;
            if string_at(object, "proliferatorMode") == Some("speed")
                && sprayed_cycle_limit > 0.0
                && base_rate > EPSILON
            {
                let accelerated_rate =
                    base_rate * proliferator_speed_multiplier(state, object, recipe);
                let accelerated_capacity =
                    (maximum_cycles.min(sprayed_cycle_limit) - progress_at_start).max(0.0);
                let accelerated_seconds =
                    seconds.min(accelerated_capacity / accelerated_rate.max(EPSILON));
                sprayed_work = accelerated_capacity.min(accelerated_rate * accelerated_seconds);
                potential_cycles =
                    sprayed_work + base_rate * (seconds - accelerated_seconds).max(0.0);
            }
            if maximum_cycles < 1.0 || potential_cycles <= EPSILON {
                set_number(object, "utilization", 0.0)?;
                set_number(object, "productionRate", 0.0)?;
                continue;
            }
            let work = potential_cycles.min((maximum_cycles - progress_at_start).max(0.0));
            if string_at(object, "proliferatorMode") != Some("speed") {
                sprayed_work = work.min((sprayed_cycle_limit - progress_at_start).max(0.0));
            }
            let progressed = rounded(progress_at_start + work, 6);
            let cycles = maximum_cycles.min((progressed + EPSILON).floor());
            let sprayed_cycles = cycles.min(sprayed_cycle_limit);
            if recipe.id == "matrix_research" {
                let (consumed, completed) = if selected_technology_id(base).is_some() {
                    invest_finite_research(
                        state,
                        base,
                        object,
                        cycles,
                        has_galactic_material_exporter,
                    )?
                } else {
                    invest_infinite_research(base, object, cycles)?
                };
                consume_proliferator_points(state, object, recipe, sprayed_cycles.min(consumed))?;
                reset_research_progress_before_next_entity |= completed;
            } else {
                let inputs = object
                    .get_mut("inputs")
                    .and_then(Value::as_object_mut)
                    .ok_or_else(|| anyhow!("native simple factory machine inputs are missing"))?;
                for input in &recipe.inputs {
                    let current = finite_number(inputs.get(&input.item_id));
                    inputs.insert(
                        input.item_id.clone(),
                        Number::from_f64((current - input.amount * cycles).max(0.0).floor())
                            .map(Value::Number)
                            .unwrap_or(Value::from(0)),
                    );
                }
                consume_proliferator_points(state, object, recipe, sprayed_cycles)?;
                crate::dyson::launch(state, base, object, &recipe.id, cycles)?;
                for output in &recipe.outputs {
                    let accumulated_bonus = object
                        .get("proliferatorBonusProgress")
                        .and_then(Value::as_object)
                        .and_then(|values| values.get(&output.item_id))
                        .map(|value| finite_number(Some(value)))
                        .unwrap_or(0.0)
                        + output.amount * sprayed_cycles * extra_product_bonus;
                    let bonus_produced = (accumulated_bonus + EPSILON).floor();
                    let produced = output.amount * cycles + bonus_produced;
                    let current = object
                        .get("outputs")
                        .and_then(Value::as_object)
                        .and_then(|outputs| outputs.get(&output.item_id))
                        .map(|value| finite_number(Some(value)))
                        .unwrap_or(0.0);
                    object
                        .get_mut("outputs")
                        .and_then(Value::as_object_mut)
                        .ok_or_else(|| {
                            anyhow!("native simple factory machine outputs are missing")
                        })?
                        .insert(
                            output.item_id.clone(),
                            Number::from_f64((current + produced).floor())
                                .map(Value::Number)
                                .unwrap_or(Value::from(0)),
                        );
                    object
                        .get_mut("proliferatorBonusProgress")
                        .and_then(Value::as_object_mut)
                        .ok_or_else(|| anyhow!("native simple factory bonus record is missing"))?
                        .insert(
                            output.item_id.clone(),
                            Number::from_f64((accumulated_bonus - bonus_produced).max(0.0))
                                .map(Value::Number)
                                .unwrap_or(Value::from(0)),
                        );
                    *produced_by_item.entry(output.item_id.clone()).or_default() += produced;
                }
            }
            set_number(
                object,
                "progress",
                rounded((progressed - cycles).max(0.0), 6),
            )?;
            let activity_factor = if potential_cycles > EPSILON {
                (work / potential_cycles).min(1.0)
            } else {
                0.0
            };
            set_number(
                object,
                "utilization",
                rounded(power_factor * launch_factor * activity_factor, 4),
            )?;
            let base_units_per_cycle = if matches!(
                recipe.id.as_str(),
                "matrix_research" | "solar_sail_launch" | "carrier_rocket_launch"
            ) {
                1.0
            } else {
                recipe
                    .outputs
                    .iter()
                    .map(|output| output.amount)
                    .sum::<f64>()
            };
            let bonus_units_per_cycle = if work > EPSILON {
                base_units_per_cycle * extra_product_bonus * sprayed_work / work
            } else {
                0.0
            };
            set_number(
                object,
                "productionRate",
                rounded(
                    work / seconds * (base_units_per_cycle + bonus_units_per_cycle) * 60.0,
                    2,
                ),
            )?;
            continue;
        }
        if matches!(kind.as_str(), "storage" | "splitter") {
            continue;
        }
        let miner_count = finite_number(object.get("minerCount"));
        if miner_count <= 0.0 {
            continue;
        }
        let power_factor = if grids[grid_slot(planet, grid)].has_power_source {
            power_factors.get(&entity_index).copied().unwrap_or(1.0)
        } else {
            0.0
        };
        set_number(object, "powerFactor", rounded(power_factor, 4))?;
        let resource = string_at(object, "resourceId")
            .ok_or_else(|| anyhow!("native simple factory vein resource is missing"))?
            .to_owned();
        let extractor = state
            .catalog
            .buildings
            .get(extractor_id(&resource))
            .ok_or_else(|| anyhow!("native simple factory extractor catalog is missing"))?;
        let item_kind = state
            .catalog
            .items
            .get(&resource)
            .map(|item| item.kind.as_str())
            .ok_or_else(|| anyhow!("native simple factory vein item catalog is missing"))?;
        let previous_progress = finite_number(object.get("progress"));
        let current = object
            .get("outputs")
            .and_then(Value::as_object)
            .and_then(|outputs| outputs.get(&resource))
            .map(|value| finite_number(Some(value)))
            .unwrap_or(0.0)
            .floor();
        let capacity = stacked_capacity(
            extractor.output_capacity,
            miner_count,
            production_buffer_limit,
        );
        let entity_id = string_at(object, "id").unwrap_or_default();
        let free = (capacity - current).max(0.0)
            + crate::belts::output_credit(&belt_reservation.output_credits, entity_id, &resource);
        let remaining_resource = finite_number(object.get("resourceRemaining"))
            .floor()
            .max(0.0);
        let depletion_remainder = finite_number(object.get("resourceDepletionRemainder"))
            .floor()
            .clamp(0.0, 9.0);
        let solid_consumption_tenths = finite_consumption_tenths;
        let consumption_tenths = if item_kind == "solid" {
            solid_consumption_tenths
        } else {
            10.0
        };
        let infinite = vein_is_infinite(
            &resource,
            item_kind,
            profiles[planet],
            infinite_resource_mode,
            solid_consumption_tenths,
        );
        let output_allowance = if infinite {
            f64::INFINITY
        } else {
            ((remaining_resource * 10.0 - depletion_remainder).max(0.0) / consumption_tenths)
                .floor()
        };
        if free < 1.0 || power_factor <= EPSILON || output_allowance < 1.0 {
            set_number(object, "progress", 0.0)?;
            set_number(object, "utilization", 0.0)?;
            set_number(object, "productionRate", 0.0)?;
            continue;
        }
        let mining_speed = (if item_kind == "solid" {
            mining_research_multiplier
        } else {
            1.0 + vein_level * 0.1
        }) * profiles[planet].mining_multiplier;
        let progress = rounded(
            previous_progress
                + extractor.speed * mining_speed * miner_count * seconds * power_factor,
            4,
        );
        let produced = free.min(output_allowance).min((progress + EPSILON).floor());
        let outputs = object
            .get_mut("outputs")
            .and_then(Value::as_object_mut)
            .ok_or_else(|| anyhow!("native simple factory vein outputs are missing"))?;
        outputs.insert(
            resource.clone(),
            Number::from_f64(current + produced)
                .map(Value::Number)
                .unwrap_or(Value::from(0)),
        );
        if !infinite {
            let accrued = depletion_remainder + produced.floor().max(0.0) * consumption_tenths;
            let depleted = remaining_resource.min((accrued / 10.0).floor());
            set_number(object, "resourceRemaining", remaining_resource - depleted)?;
            set_number(
                object,
                "resourceDepletionRemainder",
                accrued - depleted * 10.0,
            )?;
        }
        set_number(
            object,
            "progress",
            if produced >= free {
                0.0
            } else {
                rounded(progress - produced, 4)
            },
        )?;
        set_number(object, "utilization", power_factor)?;
        set_number(
            object,
            "productionRate",
            rounded(
                extractor.speed * mining_speed * miner_count * power_factor * 60.0,
                2,
            ),
        )?;
        *produced_by_item.entry(resource).or_default() += produced;
    }

    if reset_research_progress_before_next_entity {
        reset_research_machine_progress(entities)?;
    }

    crate::construction::run_centers(state, base, entities, seconds, &power_factors)?;

    crate::dyson::run_ray_receivers(
        state,
        base,
        entities,
        seconds,
        &belt_reservation.output_credits,
        &reception,
    )?;

    if !produced_by_item.is_empty() {
        let total = base
            .get_mut("totalProduced")
            .and_then(Value::as_object_mut)
            .ok_or_else(|| anyhow!("native simple factory total production record is missing"))?;
        for (item, produced) in produced_by_item {
            let previous = finite_number(total.get(&item));
            total.insert(
                item,
                Number::from_f64((previous + produced).floor())
                    .map(Value::Number)
                    .unwrap_or(Value::from(0)),
            );
        }
    }

    let total_items_before_global = planet_ids
        .iter()
        .map(|planet_id| {
            entities
                .iter()
                .filter_map(Value::as_object)
                .filter(|entity| string_at(entity, "planetId") == Some(planet_id))
                .map(|entity| finite_number(entity.get("productionRate")))
                .fold(0.0_f64, |sum, value| sum + value)
        })
        .collect::<Vec<_>>();

    let quantum_flow = if crossed_quantum_boundary {
        crate::quantum_logistics::settle_downloads(
            state,
            base,
            entities,
            &belt_reservation.output_credits,
            first_quantum_boundary as f64 * 5.0,
            5.0,
        )?
    } else {
        None
    };

    crate::belts::transfer(
        state,
        base,
        entities,
        belts,
        0.0,
        false,
        Some(&belt_reservation.allowance_by_belt),
        seconds,
    )?;

    let station_powers = entities
        .iter()
        .enumerate()
        .filter_map(|(entity_index, entity)| {
            let object = entity.as_object()?;
            if string_at(object, "kind") != Some("station") {
                return None;
            }
            if string_at(object, "buildingId") == Some("orbital_collector") {
                return Some((entity_index, 1.0));
            }
            let planet = *planet_index.get(string_at(object, "planetId").unwrap_or_default())?;
            let grid = grid_index(object)?;
            Some((
                entity_index,
                power_factors
                    .get(&entity_index)
                    .copied()
                    .unwrap_or(grids[grid_slot(planet, grid)].factor),
            ))
        })
        .collect::<HashMap<_, _>>();
    crate::interstellar_logistics::refill_station_warpers(base, entities)?;
    crate::local_logistics::dispatch(state, base, entities, &station_powers)?;
    crate::interstellar_logistics::dispatch(state, base, entities, &station_powers)?;
    crate::local_logistics::advance_routes(state, base, entities, seconds, &station_powers)?;
    crate::interstellar_logistics::advance_routes(entities, seconds, &station_powers)?;
    crate::interstellar_logistics::refill_station_warpers(base, entities)?;
    crate::local_logistics::update_congestion(entities)?;
    crate::interstellar_logistics::update_congestion(state, base, entities)?;
    crate::dyson::finalize(base)?;
    let receiver_load_kw = reception
        .allocation_by_entity
        .values()
        .copied()
        .sum::<f64>();
    if let Some(swarm) = base.get_mut("dysonSwarm").and_then(Value::as_object_mut) {
        set_number(swarm, "receiverLoadKw", rounded(receiver_load_kw, 2))?;
    }

    let mut power_grid_metrics = Map::new();
    let mut planet_metrics = Map::new();
    for (planet, planet_id) in planet_ids.iter().enumerate() {
        let mut per_grid = Map::new();
        let mut combined = GridRuntime::default();
        for (grid, grid_id) in GRID_IDS.iter().enumerate() {
            let runtime = &grids[grid_slot(planet, grid)];
            per_grid.insert(
                (*grid_id).to_owned(),
                metric_value(Some(grid_id), runtime, 0.0),
            );
            combined.generation_kw += runtime.generation_kw;
            combined.demand_kw += runtime.demand_kw;
            combined.supplied_kw += runtime.supplied_kw;
            combined.wind_generation_kw += runtime.wind_generation_kw;
            combined.solar_generation_kw += runtime.solar_generation_kw;
            combined.geothermal_generation_kw += runtime.geothermal_generation_kw;
            combined.thermal_generation_kw += runtime.thermal_generation_kw;
            combined.fusion_generation_kw += runtime.fusion_generation_kw;
            combined.artificial_star_generation_kw += runtime.artificial_star_generation_kw;
            combined.ray_generation_kw += runtime.ray_generation_kw;
            combined.storage_discharge_kw += runtime.storage_discharge_kw;
            combined.storage_charge_kw += runtime.storage_charge_kw;
        }
        combined.factor = if combined.demand_kw <= EPSILON {
            1.0
        } else {
            combined.supplied_kw / combined.demand_kw
        };
        let (stored_mj, capacity_mj, fuel_electric_mj, rated_fuel_kw) =
            power_reserves(state, entities, planet_id)?;
        combined.stored_energy_mj = stored_mj;
        combined.storage_capacity_mj = capacity_mj;
        combined.fuel_electric_energy_mj = fuel_electric_mj;
        combined.rated_fuel_generator_kw = rated_fuel_kw;
        let total_items = total_items_before_global[planet];
        power_grid_metrics.insert(planet_id.clone(), Value::Object(per_grid));
        planet_metrics.insert(
            planet_id.clone(),
            metric_value(None, &combined, total_items),
        );
    }
    base.insert(
        "powerGridMetrics".to_owned(),
        Value::Object(power_grid_metrics),
    );
    base.insert("planetMetrics".to_owned(), Value::Object(planet_metrics));
    let active_planet = base
        .get("activePlanetId")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("native simple factory active planet is missing"))?;
    let active_metrics = base
        .get("planetMetrics")
        .and_then(Value::as_object)
        .and_then(|metrics| metrics.get(active_planet))
        .cloned()
        .ok_or_else(|| anyhow!("native simple factory active planet metrics are missing"))?;
    base.insert("metrics".to_owned(), active_metrics);

    let elapsed = projected_elapsed;
    set_number(base, "elapsedSeconds", elapsed)?;
    if crossed_quantum_boundary {
        for boundary in first_quantum_boundary..=last_quantum_boundary {
            crate::quantum_logistics::settle_transitions(base, entities)?;
            crate::quantum_logistics::settle_uploads(
                base,
                entities,
                boundary as f64 * 5.0,
                quantum_flow.clone(),
                5.0,
                &indexed_quantum_endpoint_ids,
            )?;
        }
    }
    if let Some(endgame) = base.get_mut("endgame").and_then(Value::as_object_mut) {
        let mut started = finite_number(endgame.get("exportWindowStartedAt"));
        if started <= 0.0 {
            started = elapsed;
            set_number(endgame, "exportWindowStartedAt", started)?;
        }
        if elapsed - started >= 10.0 - EPSILON {
            let amount = finite_number(endgame.get("exportWindowAmount"));
            set_number(
                endgame,
                "exportedLastMinute",
                rounded(amount * 60.0 / (elapsed - started), 2),
            )?;
            endgame.insert("exportWindowAmount".to_owned(), Value::from(0));
            set_number(endgame, "exportWindowStartedAt", elapsed)?;
        }
    }
    Ok(())
}

pub(crate) fn advance(state: &mut CoreState, simulation_seconds: f64) -> anyhow::Result<()> {
    let mut entities = (0..state.entity_index.len())
        .map(|index| state.parse_entity(index))
        .collect::<anyhow::Result<Vec<_>>>()?;
    let mut belts = (0..state.belt_index.len())
        .map(|index| state.parse_belt(index))
        .collect::<anyhow::Result<Vec<_>>>()?;
    let mut base = std::mem::take(state.base_value_mut());
    if let (Some(active_planet), Some(tray)) = (
        base.get("activePlanetId")
            .and_then(Value::as_str)
            .map(str::to_owned),
        base.get("tray").cloned(),
    ) {
        base.get_mut("planetTrays")
            .and_then(Value::as_object_mut)
            .ok_or_else(|| anyhow!("native active planet trays are missing"))?
            .insert(active_planet, tray);
    }
    settle_completed_research_boundaries(state, &mut base, &mut entities)?;
    *state.base_value_mut() = base;
    let total = simulation_seconds;
    let step_size = if total >= 24.0 * 60.0 * 60.0 {
        30.0
    } else if total > 8.0 * 60.0 * 60.0 {
        10.0
    } else {
        1.0
    };
    let mut remaining = total;
    while remaining > EPSILON {
        let step = remaining.min(step_size);
        let mut base = std::mem::take(state.base_value_mut());
        simulate_step(state, &mut base, &mut entities, &mut belts, step)
            .context("advance native simple factory step")?;
        *state.base_value_mut() = base;
        remaining = (remaining - step).max(0.0);
    }
    let mut base = std::mem::take(state.base_value_mut());
    settle_completed_research_boundaries(state, &mut base, &mut entities)?;
    *state.base_value_mut() = base;
    for (raw, entity) in state.entity_raw_mut().iter_mut().zip(entities) {
        *raw = serde_json::to_string(&entity)
            .context("encode native simple factory entity")?
            .into_boxed_str();
    }
    for (raw, belt) in state.belt_raw_mut().iter_mut().zip(belts) {
        *raw = serde_json::to_string(&belt)
            .context("encode native simple factory belt")?
            .into_boxed_str();
    }
    let universe_matrix = number_at(
        state.base_value().get("totalProduced"),
        &["universe_matrix"],
    );
    if universe_matrix >= 1.0 {
        if let Some(station) = state
            .base_value_mut()
            .get_mut("orbitalStation")
            .and_then(Value::as_object_mut)
        {
            if station.get("status").and_then(Value::as_str) == Some("locked") {
                station.insert("status".to_owned(), Value::from("eligible"));
            }
        }
    }
    state.rebuild_indexes()?;
    Ok(())
}
