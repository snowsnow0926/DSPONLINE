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

#[derive(Debug, Clone)]
struct GridRuntime {
    generation_kw: f64,
    demand_kw: f64,
    supplied_kw: f64,
    factor: f64,
    wind_generation_kw: f64,
    solar_generation_kw: f64,
    geothermal_generation_kw: f64,
    connected_entities: u64,
    disconnected_entities: u64,
    generator_count: f64,
    has_power_source: bool,
    consumers: [Vec<Consumer>; 4],
    disconnected_demand_kw: f64,
}

impl Default for GridRuntime {
    fn default() -> Self {
        Self {
            generation_kw: 0.0,
            demand_kw: 0.0,
            supplied_kw: 0.0,
            factor: 1.0,
            wind_generation_kw: 0.0,
            solar_generation_kw: 0.0,
            geothermal_generation_kw: 0.0,
            connected_entities: 0,
            disconnected_entities: 0,
            generator_count: 0.0,
            has_power_source: false,
            consumers: std::array::from_fn(|_| Vec::new()),
            disconnected_demand_kw: 0.0,
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
    if base
        .get("research")
        .and_then(Value::as_object)
        .and_then(|value| value.get("selectedTechId"))
        .is_some_and(|value| !value.is_null())
    {
        return Some("research-boundary-requires-domain-core");
    }
    if !exact_campaign_complete(base) {
        return Some("campaign-completion-requires-domain-core");
    }
    if !empty_array(base.get("handcraftQueue")) || !empty_array(base.get("constructionQueue")) {
        return Some("craft-or-construction-queue-active");
    }
    let automation = base.get("constructionAutomation");
    if bool_at(automation, &["enabled"])
        || !empty_object(
            automation
                .and_then(Value::as_object)
                .and_then(|value| value.get("jobs")),
        )
        || !empty_object(
            automation
                .and_then(Value::as_object)
                .and_then(|value| value.get("targetStock")),
        )
    {
        return Some("construction-automation-active");
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
        || time_warp
            .and_then(Value::as_object)
            .and_then(|value| value.get("controllerEntityId"))
            .is_some_and(|value| !value.is_null())
        || number_at(time_warp, &["pendingSimulationSeconds"]).abs() > EPSILON
        || number_at(time_warp, &["pendingWallSeconds"]).abs() > EPSILON
    {
        return Some("time-warp-active");
    }
    if number_at(base.get("dysonSwarm"), &["sailsInOrbit"]) > 0.0
        || number_at(base.get("dysonSwarm"), &["totalLaunched"]) > 0.0
        || number_at(base.get("dysonSphere"), &["structurePoints"]) > 0.0
        || number_at(base.get("dysonSphere"), &["totalRocketsLaunched"]) > 0.0
        || number_at(base.get("dysonSphere"), &["shellSails"]) > 0.0
    {
        return Some("dyson-active");
    }
    if !empty_object(base.get("systemSpaceStations")) {
        return Some("system-space-station-active");
    }
    let quantum = base.get("quantumLogisticsNetwork");
    if bool_at(quantum, &["enabled"])
        || !empty_object(
            quantum
                .and_then(Value::as_object)
                .and_then(|value| value.get("inventory")),
        )
    {
        return Some("quantum-network-active");
    }
    let endgame = base.get("endgame");
    if endgame
        .and_then(Value::as_object)
        .and_then(|value| value.get("activeInfiniteResearchId"))
        .is_some_and(|value| !value.is_null())
        || endgame
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
    if !state.belt_index.is_empty() {
        return Ok(Some("simple-factory-belts-active"));
    }
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
                    "wind_turbine" | "solar_panel" | "geothermal_power_station"
                ) || !state.catalog.buildings.contains_key(building)
                {
                    return Ok(Some("simple-factory-power-source-unsupported"));
                }
            }
            Some("machine") => {
                let building_id = string_at(object, "buildingId").unwrap_or_default();
                let recipe_id = string_at(object, "recipeId").unwrap_or_default();
                let Some(building) = state.catalog.buildings.get(building_id) else {
                    return Ok(Some("simple-factory-machine-building-missing"));
                };
                let Some(recipe) = state.catalog.recipes.get(recipe_id) else {
                    return Ok(Some("simple-factory-machine-recipe-missing"));
                };
                if building.kind != "machine"
                    || matches!(
                        building_id,
                        "ray_receiver"
                            | "em_rail_ejector"
                            | "vertical_launching_silo"
                            | "construction_center"
                            | "galactic_material_exporter"
                    )
                    || matches!(
                        recipe_id,
                        "matrix_research" | "solar_sail_launch" | "carrier_rocket_launch"
                    )
                    || recipe.inputs.is_empty()
                    || recipe.outputs.is_empty()
                    || bool_at(Some(&entity), &["sprayCoaterInstalled"])
                {
                    return Ok(Some("simple-factory-machine-feature-unsupported"));
                }
            }
            _ => return Ok(Some("simple-factory-entity-kind-unsupported")),
        }
    }
    let base = state.base_value();
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

fn recipe_technology_available(base: &Map<String, Value>, recipe: &RecipeDefinition) -> bool {
    recipe
        .required_tech_id
        .as_deref()
        .is_none_or(|id| completed_tech(base, id))
}

fn machine_input_cycles(entity: &Map<String, Value>, recipe: &RecipeDefinition) -> f64 {
    let inputs = entity.get("inputs").and_then(Value::as_object);
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
    entity: &Map<String, Value>,
    recipe: &RecipeDefinition,
    capacity: f64,
    maximum: f64,
) -> f64 {
    let outputs = entity.get("outputs").and_then(Value::as_object);
    recipe
        .outputs
        .iter()
        .fold(f64::INFINITY, |available, output| {
            let current = outputs
                .and_then(|values| values.get(&output.item_id))
                .map(|value| finite_number(Some(value)))
                .unwrap_or(0.0);
            let free = ((capacity - current).max(0.0) + EPSILON).floor();
            available.min((free / output.amount).floor().min(maximum.floor().max(0.0)))
        })
}

fn machine_can_run(
    base: &Map<String, Value>,
    entity: &Map<String, Value>,
    building: &BuildingDefinition,
    recipe: &RecipeDefinition,
    buffer_limit: f64,
) -> bool {
    if !recipe_technology_available(base, recipe) {
        return false;
    }
    let capacity = stacked_capacity(
        building.output_capacity,
        finite_number(entity.get("machineCount")),
        buffer_limit,
    );
    (machine_input_cycles(entity, recipe) + EPSILON).floor() >= 1.0
        && (machine_output_cycles(entity, recipe, capacity, 1.0) + EPSILON).floor() >= 1.0
}

fn metric_value(grid_id: Option<&str>, grid: &GridRuntime, total_items_per_minute: f64) -> Value {
    let mut metric = json!({
        "generationKw": rounded(grid.generation_kw, 2),
        "demandKw": rounded(grid.demand_kw, 2),
        "powerFactor": rounded(grid.factor, 4),
        "windGenerationKw": rounded(grid.wind_generation_kw, 2),
        "solarGenerationKw": rounded(grid.solar_generation_kw, 2),
        "geothermalGenerationKw": rounded(grid.geothermal_generation_kw, 2),
        "thermalGenerationKw": 0,
        "fusionGenerationKw": 0,
        "artificialStarGenerationKw": 0,
        "rayGenerationKw": 0,
        "storageDischargeKw": 0,
        "storageChargeKw": 0,
        "storedEnergyMj": 0,
        "storageCapacityMj": 0,
        "fuelReserveSeconds": 0,
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

fn simulate_step(
    state: &CoreState,
    base: &mut Map<String, Value>,
    entities: &mut [Value],
    seconds: f64,
) -> anyhow::Result<()> {
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
    let simulation_speed = base
        .get("settings")
        .and_then(Value::as_object)
        .and_then(|value| value.get("simulationSpeed"))
        .cloned()
        .unwrap_or(Value::from(1));
    let mut grids = vec![GridRuntime::default(); planet_ids.len() * GRID_IDS.len()];
    let grid_slot = |planet: usize, grid: usize| planet * GRID_IDS.len() + grid;

    for (entity_index, entity) in entities.iter().enumerate() {
        let object = entity
            .as_object()
            .ok_or_else(|| anyhow!("native simple factory entity is not an object"))?;
        if string_at(object, "kind") != Some("power") {
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
        let multiplier = match building_id {
            "solar_panel" => profiles[planet].solar_power_multiplier,
            "geothermal_power_station" => profiles[planet].geothermal_multiplier,
            _ => profiles[planet].wind_multiplier,
        };
        let output = building.power_generation_kw * machine_count * multiplier;
        runtime.has_power_source = true;
        runtime.generation_kw += output;
        match building_id {
            "solar_panel" => runtime.solar_generation_kw += output,
            "geothermal_power_station" => runtime.geothermal_generation_kw += output,
            _ => runtime.wind_generation_kw += output,
        }
        runtime.generator_count += machine_count;
        let _ = entity_index;
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
        if !machine_can_run(base, object, building, recipe, production_buffer_limit) {
            continue;
        }
        let planet = *planet_index
            .get(string_at(object, "planetId").unwrap_or_default())
            .ok_or_else(|| anyhow!("native simple factory entity planet is unknown"))?;
        let grid = grid_index(object)
            .ok_or_else(|| anyhow!("native simple factory entity grid is unknown"))?;
        let runtime = &mut grids[grid_slot(planet, grid)];
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
        runtime.supplied_kw = connected_demand.min(runtime.generation_kw);
        runtime.demand_kw = connected_demand + runtime.disconnected_demand_kw;
        runtime.factor = if runtime.demand_kw <= EPSILON {
            1.0
        } else {
            (runtime.supplied_kw / runtime.demand_kw).min(1.0)
        };
        let mut remaining = runtime.generation_kw.max(0.0);
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
    for (entity_index, entity) in entities.iter().enumerate() {
        let Some(object) = entity.as_object() else {
            continue;
        };
        if string_at(object, "kind") != Some("machine") {
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
        if machine_can_run(base, object, building, recipe, production_buffer_limit) {
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
    let industrial_speed = industrial_speed_multiplier(base);
    let mut produced_by_item = HashMap::<String, f64>::new();

    for (entity_index, entity) in entities.iter_mut().enumerate() {
        let object = entity_object(entity)?;
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
            let building_id = string_at(object, "buildingId").unwrap_or_default();
            let building = state
                .catalog
                .buildings
                .get(building_id)
                .ok_or_else(|| anyhow!("native simple factory renewable catalog is missing"))?;
            let machine_count = finite_number(object.get("machineCount"));
            let multiplier = match building_id {
                "solar_panel" => profiles[planet].solar_power_multiplier,
                "geothermal_power_station" => profiles[planet].geothermal_multiplier,
                _ => profiles[planet].wind_multiplier,
            };
            let output = building.power_generation_kw * machine_count * multiplier;
            let rated = building.power_generation_kw * machine_count;
            set_number(object, "powerOutputKw", rounded(output, 2))?;
            set_number(object, "powerInputKw", 0.0)?;
            set_number(
                object,
                "utilization",
                if rated > EPSILON {
                    rounded(output / rated, 4)
                } else {
                    0.0
                },
            )?;
            set_number(object, "productionRate", 0.0)?;
            continue;
        }
        if kind == "machine" {
            let building_id = string_at(object, "buildingId")
                .unwrap_or_default()
                .to_owned();
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
            let input_cycles = (machine_input_cycles(object, recipe) + EPSILON).floor();
            let output_cycles =
                (machine_output_cycles(object, recipe, capacity, input_cycles) + EPSILON).floor();
            let maximum_cycles = input_cycles.min(output_cycles);
            let progress_at_start = finite_number(object.get("progress"));
            let power_factor = power_factors.get(&entity_index).copied().unwrap_or(1.0);
            let planet_speed = if specialization_applies(profiles[planet], building) {
                profiles[planet].production_speed_multiplier
            } else {
                1.0
            };
            let effective_cycles_per_second =
                building.speed * machine_count * industrial_speed * planet_speed / recipe.duration;
            let potential_cycles = effective_cycles_per_second * power_factor * seconds;
            if maximum_cycles < 1.0 || potential_cycles <= EPSILON {
                set_number(object, "utilization", 0.0)?;
                set_number(object, "productionRate", 0.0)?;
                continue;
            }
            let work = potential_cycles.min((maximum_cycles - progress_at_start).max(0.0));
            let progressed = rounded(progress_at_start + work, 6);
            let cycles = maximum_cycles.min((progressed + EPSILON).floor());
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
            let outputs = object
                .get_mut("outputs")
                .and_then(Value::as_object_mut)
                .ok_or_else(|| anyhow!("native simple factory machine outputs are missing"))?;
            for output in &recipe.outputs {
                let produced = output.amount * cycles;
                let current = finite_number(outputs.get(&output.item_id));
                outputs.insert(
                    output.item_id.clone(),
                    Number::from_f64((current + produced).floor())
                        .map(Value::Number)
                        .unwrap_or(Value::from(0)),
                );
                *produced_by_item.entry(output.item_id.clone()).or_default() += produced;
            }
            let bonus = object
                .get_mut("proliferatorBonusProgress")
                .and_then(Value::as_object_mut)
                .ok_or_else(|| anyhow!("native simple factory bonus record is missing"))?;
            for output in &recipe.outputs {
                bonus.insert(output.item_id.clone(), Value::from(0));
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
                rounded(power_factor * activity_factor, 4),
            )?;
            let base_units_per_cycle = recipe
                .outputs
                .iter()
                .map(|output| output.amount)
                .sum::<f64>();
            set_number(
                object,
                "productionRate",
                rounded(work / seconds * base_units_per_cycle * 60.0, 2),
            )?;
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
        let free = (capacity - current).max(0.0);
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
        }
        combined.factor = if combined.demand_kw <= EPSILON {
            1.0
        } else {
            combined.supplied_kw / combined.demand_kw
        };
        let total_items = entities
            .iter()
            .filter_map(Value::as_object)
            .filter(|entity| string_at(entity, "planetId") == Some(planet_id))
            .map(|entity| finite_number(entity.get("productionRate")))
            .sum::<f64>();
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

    if let Some(time_warp) = base.get_mut("timeWarp").and_then(Value::as_object_mut) {
        time_warp.insert("controllerEntityId".to_owned(), Value::Null);
        time_warp.insert("enabled".to_owned(), Value::Bool(false));
        time_warp.insert("effectiveMultiplier".to_owned(), simulation_speed);
        time_warp.insert("requiredPowerKw".to_owned(), Value::from(0));
        time_warp.insert("allocatedPowerKw".to_owned(), Value::from(0));
    }
    if let Some(swarm) = base.get_mut("dysonSwarm").and_then(Value::as_object_mut) {
        swarm.insert("receiverLoadKw".to_owned(), Value::from(0));
    }
    let elapsed = rounded(finite_number(base.get("elapsedSeconds")) + seconds, 4);
    set_number(base, "elapsedSeconds", elapsed)?;
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
        simulate_step(state, &mut base, &mut entities, step)
            .context("advance native simple factory step")?;
        *state.base_value_mut() = base;
        remaining = (remaining - step).max(0.0);
    }
    for (raw, entity) in state.entity_raw_mut().iter_mut().zip(entities) {
        *raw = serde_json::to_string(&entity)
            .context("encode native simple factory entity")?
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
