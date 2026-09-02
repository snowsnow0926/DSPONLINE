use std::collections::{HashMap, HashSet};

use anyhow::{Context, bail};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::canonical::canonical_sha256;

const MAX_CATALOG_ENTRIES: usize = 65_536;
const MAX_ID_BYTES: usize = 160;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemAmount {
    pub item_id: String,
    pub amount: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemDefinition {
    pub id: String,
    #[serde(default)]
    pub name: String,
    pub kind: String,
    #[serde(default)]
    pub fuel_energy_mj: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanetDefinition {
    pub id: String,
    #[serde(default)]
    pub name: String,
    pub system_id: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub orbit_index: u16,
    #[serde(default)]
    pub simulation_order: u16,
    #[serde(default)]
    pub orbital_yields: HashMap<String, f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StarSystemDefinition {
    pub id: String,
    #[serde(default)]
    pub name: String,
    pub planet_ids: Vec<String>,
    #[serde(default)]
    pub exploration_cost: Vec<ItemAmount>,
    #[serde(default)]
    pub required_tech_id: Option<String>,
    #[serde(default)]
    pub prerequisite_system_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildingDefinition {
    pub id: String,
    pub kind: String,
    pub speed: f64,
    pub input_capacity: f64,
    pub output_capacity: f64,
    #[serde(default)]
    pub power_demand_kw: f64,
    #[serde(default)]
    pub power_generation_kw: f64,
    #[serde(default)]
    pub power_charge_kw: f64,
    #[serde(default)]
    pub energy_capacity_mj: f64,
    #[serde(default)]
    pub fuel_item_ids: Vec<String>,
    #[serde(default = "default_fuel_efficiency")]
    pub fuel_efficiency: f64,
    #[serde(default)]
    pub family: Option<String>,
    #[serde(default)]
    pub accepts: Option<String>,
}

fn default_fuel_efficiency() -> f64 {
    1.0
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecipeDefinition {
    pub id: String,
    #[serde(default)]
    pub name: String,
    pub building_id: String,
    pub duration: f64,
    #[serde(default)]
    pub required_tech_id: Option<String>,
    #[serde(default)]
    pub recursive_priority: f64,
    #[serde(default)]
    pub recursive_manufacturing: bool,
    pub inputs: Vec<ItemAmount>,
    pub outputs: Vec<ItemAmount>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConstructionDefinition {
    pub id: String,
    pub output_amount: f64,
    #[serde(default)]
    pub automation_order: u32,
    #[serde(default)]
    pub required_tech_id: Option<String>,
    pub costs: Vec<ItemAmount>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BeltDefinition {
    pub tier: u8,
    pub speed: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProliferatorDefinition {
    pub tier: u8,
    pub item_id: String,
    pub spray_points: f64,
    pub extra_product_bonus: f64,
    pub speed_bonus: f64,
    pub power_multiplier: f64,
    pub required_tech_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TechnologyDefinition {
    pub id: String,
    #[serde(default)]
    pub name: String,
    pub costs: Vec<ItemAmount>,
    #[serde(default)]
    pub prerequisites: Vec<String>,
    #[serde(default)]
    pub construction_rewards: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogSnapshot {
    pub protocol_version: u16,
    pub registry_fingerprint: String,
    pub planets: Vec<PlanetDefinition>,
    pub items: Vec<ItemDefinition>,
    pub buildings: Vec<BuildingDefinition>,
    pub recipes: Vec<RecipeDefinition>,
    #[serde(default)]
    pub constructions: Vec<ConstructionDefinition>,
    pub belts: Vec<BeltDefinition>,
    #[serde(default)]
    pub proliferators: Vec<ProliferatorDefinition>,
    #[serde(default)]
    pub technologies: Vec<TechnologyDefinition>,
}

#[derive(Debug, Clone)]
pub struct RuntimeCatalog {
    pub snapshot: CatalogSnapshot,
    pub fingerprint: String,
    pub planets: Vec<PlanetDefinition>,
    pub star_systems: HashMap<String, StarSystemDefinition>,
    pub items: HashMap<String, ItemDefinition>,
    pub buildings: HashMap<String, BuildingDefinition>,
    pub recipes: HashMap<String, RecipeDefinition>,
    pub constructions: HashMap<String, ConstructionDefinition>,
    pub belt_speeds: HashMap<u8, f64>,
    pub proliferators: HashMap<u8, ProliferatorDefinition>,
    pub technologies: HashMap<String, TechnologyDefinition>,
    /// Transient policy proof carried by current catalog payloads. Older
    /// protocol-v1 payloads remain readable but cannot authorize increases in
    /// a content-pack registry because they omitted the optional stack bound.
    pub building_stack_policies: HashMap<String, BuildingStackPolicy>,
    /// Command/layout/presentation fields carried by the canonical renderer
    /// snapshot without widening the public v47 save schema.  Older protocol
    /// v1 catalogs get conservative defaults; a current data-only content pack
    /// supplies every field explicitly and is therefore eligible for native
    /// placement, stacking, layout and display.
    pub building_metadata: HashMap<String, BuildingRuntimeMetadata>,
    /// Stable construction item for each registered belt tier.  Core tiers
    /// retain their historical IDs while declarative tiers carry their own ID
    /// in the catalog payload.
    pub belt_construction_ids: HashMap<u8, String>,
    /// False when a catalog declares script/native-code behavior that the
    /// deterministic data-only core cannot execute.  The save remains readable
    /// and exportable; player-authority admission must fail closed.
    pub data_only_native_supported: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BuildingStackPolicy {
    pub limit: Option<u64>,
    pub complete: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct BuildingPortDefinition {
    pub index: u8,
    pub direction: String,
    pub accepts: String,
    pub max_connections: u8,
    pub special: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct BuildingRuntimeMetadata {
    pub name: String,
    pub short_name: String,
    pub description: String,
    pub required_tech_id: Option<String>,
    pub upgrade_target_id: Option<String>,
    pub unique: bool,
    pub megastructure: bool,
    pub layout_width: f64,
    pub layout_height: f64,
    pub layout_clearance: f64,
    pub ports: Vec<BuildingPortDefinition>,
    pub capabilities: HashSet<String>,
    pub scripted: bool,
}

fn builtin_megastructure(id: &str) -> bool {
    matches!(
        id,
        "orbital_cargo_terminal"
            | "construction_center"
            | "galactic_material_exporter"
            | "micro_black_hole_connector"
            | "time_warp_device"
            | "space_station_construction_launcher"
    )
}

fn default_building_metadata(building: &BuildingDefinition) -> BuildingRuntimeMetadata {
    let megastructure = builtin_megastructure(&building.id);
    BuildingRuntimeMetadata {
        name: building.id.clone(),
        short_name: building.id.clone(),
        description: String::new(),
        required_tech_id: None,
        upgrade_target_id: None,
        unique: matches!(
            building.id.as_str(),
            "micro_black_hole_connector" | "time_warp_device"
        ),
        megastructure,
        layout_width: if megastructure { 620.0 } else { 300.0 },
        layout_height: if megastructure { 420.0 } else { 220.0 },
        layout_clearance: 24.0,
        ports: Vec::new(),
        capabilities: HashSet::new(),
        scripted: false,
    }
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_ID_BYTES
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.' | b':' | b'/')
        })
}

fn unique_ids<'a>(values: impl IntoIterator<Item = &'a str>) -> anyhow::Result<()> {
    let mut ids = HashSet::new();
    for id in values {
        if !valid_id(id) {
            bail!("native catalog contains an invalid ID");
        }
        if !ids.insert(id) {
            bail!("native catalog contains a duplicate ID: {id}");
        }
    }
    Ok(())
}

fn upgrade_graph_is_acyclic(metadata: &HashMap<String, BuildingRuntimeMetadata>) -> bool {
    #[derive(Clone, Copy, PartialEq, Eq)]
    enum Mark {
        Visiting,
        Complete,
    }

    fn visit(
        id: &str,
        metadata: &HashMap<String, BuildingRuntimeMetadata>,
        marks: &mut HashMap<String, Mark>,
    ) -> bool {
        match marks.get(id) {
            Some(Mark::Visiting) => return false,
            Some(Mark::Complete) => return true,
            None => {}
        }
        marks.insert(id.to_owned(), Mark::Visiting);
        if let Some(target) = metadata
            .get(id)
            .and_then(|definition| definition.upgrade_target_id.as_deref())
            && !visit(target, metadata, marks)
        {
            return false;
        }
        marks.insert(id.to_owned(), Mark::Complete);
        true
    }

    let mut marks = HashMap::new();
    metadata.keys().all(|id| visit(id, metadata, &mut marks))
}

fn data_only_catalog_relations_are_closed(catalog: &RuntimeCatalog) -> bool {
    let technology_known = |id: &Option<String>| {
        id.as_ref()
            .is_none_or(|id| catalog.technologies.contains_key(id))
    };
    catalog
        .recipes
        .values()
        .all(|recipe| technology_known(&recipe.required_tech_id))
        && catalog
            .constructions
            .values()
            .all(|definition| technology_known(&definition.required_tech_id))
        && catalog.building_metadata.iter().all(|(id, metadata)| {
            technology_known(&metadata.required_tech_id)
                && metadata
                    .upgrade_target_id
                    .as_ref()
                    .is_none_or(|target| target != id && catalog.buildings.contains_key(target))
        })
        && upgrade_graph_is_acyclic(&catalog.building_metadata)
        && catalog.belt_speeds.keys().all(|tier| {
            *tier <= 3
                || catalog
                    .belt_construction_ids
                    .get(tier)
                    .is_some_and(|id| catalog.constructions.contains_key(id))
        })
}

impl RuntimeCatalog {
    pub fn validate(
        snapshot: CatalogSnapshot,
        expected_registry_fingerprint: &str,
    ) -> anyhow::Result<Self> {
        if snapshot.protocol_version != crate::CORE_PROTOCOL_VERSION {
            bail!("native catalog protocol version is unsupported");
        }
        if snapshot.registry_fingerprint != expected_registry_fingerprint
            || snapshot.registry_fingerprint.is_empty()
            || snapshot.registry_fingerprint.len() > 256
        {
            bail!("native catalog registry fingerprint does not match the checkpoint");
        }
        let total = snapshot.items.len()
            + snapshot.buildings.len()
            + snapshot.recipes.len()
            + snapshot.constructions.len()
            + snapshot.belts.len()
            + snapshot.proliferators.len()
            + snapshot.technologies.len()
            + snapshot.planets.len();
        if total == 0 || total > MAX_CATALOG_ENTRIES {
            bail!("native catalog entry count is invalid");
        }
        unique_ids(snapshot.planets.iter().map(|value| value.id.as_str()))?;
        unique_ids(snapshot.items.iter().map(|value| value.id.as_str()))?;
        unique_ids(snapshot.buildings.iter().map(|value| value.id.as_str()))?;
        unique_ids(snapshot.recipes.iter().map(|value| value.id.as_str()))?;
        unique_ids(snapshot.constructions.iter().map(|value| value.id.as_str()))?;
        unique_ids(snapshot.technologies.iter().map(|value| value.id.as_str()))?;
        let item_ids = snapshot
            .items
            .iter()
            .map(|value| value.id.as_str())
            .collect::<HashSet<_>>();
        if snapshot.planets.is_empty() {
            bail!("native catalog planet directory is empty");
        }
        for planet in &snapshot.planets {
            if !valid_id(&planet.system_id)
                || !matches!(planet.kind.as_str(), "terrestrial" | "gas-giant")
                || planet.orbit_index == 0
                || planet.orbital_yields.iter().any(|(item_id, rate)| {
                    !item_ids.contains(item_id.as_str()) || !rate.is_finite() || *rate <= 0.0
                })
            {
                bail!("native catalog planet system ID is invalid: {}", planet.id);
            }
        }
        let building_ids = snapshot
            .buildings
            .iter()
            .map(|value| value.id.as_str())
            .collect::<HashSet<_>>();
        let recipe_ids = snapshot
            .recipes
            .iter()
            .map(|value| value.id.as_str())
            .collect::<HashSet<_>>();
        for construction in &snapshot.constructions {
            if !construction.output_amount.is_finite()
                || construction.output_amount <= 0.0
                || construction.costs.is_empty()
                || construction.costs.iter().any(|amount| {
                    !item_ids.contains(amount.item_id.as_str())
                        || !amount.amount.is_finite()
                        || amount.amount <= 0.0
                })
                || construction
                    .required_tech_id
                    .as_deref()
                    .is_some_and(|id| !valid_id(id))
            {
                bail!(
                    "native catalog construction definition is invalid: {}",
                    construction.id
                );
            }
        }
        for item in &snapshot.items {
            if !matches!(item.kind.as_str(), "solid" | "fluid" | "matrix") {
                bail!("native catalog item kind is invalid: {}", item.id);
            }
            if !item.fuel_energy_mj.is_finite() || item.fuel_energy_mj < 0.0 {
                bail!("native catalog item fuel energy is invalid: {}", item.id);
            }
        }
        for building in &snapshot.buildings {
            if !building.speed.is_finite()
                || building.speed < 0.0
                || !building.input_capacity.is_finite()
                || building.input_capacity < 0.0
                || !building.output_capacity.is_finite()
                || building.output_capacity < 0.0
                || !building.power_demand_kw.is_finite()
                || building.power_demand_kw < 0.0
                || !building.power_generation_kw.is_finite()
                || building.power_generation_kw < 0.0
                || !building.power_charge_kw.is_finite()
                || building.power_charge_kw < 0.0
                || !building.energy_capacity_mj.is_finite()
                || building.energy_capacity_mj < 0.0
                || !building.fuel_efficiency.is_finite()
                || building.fuel_efficiency <= 0.0
                || building
                    .fuel_item_ids
                    .iter()
                    .any(|id| !item_ids.contains(id.as_str()))
            {
                bail!(
                    "native catalog building numeric field is invalid: {}",
                    building.id
                );
            }
            if building
                .accepts
                .as_deref()
                .is_some_and(|value| !matches!(value, "solid" | "fluid" | "any"))
            {
                bail!(
                    "native catalog building acceptance is invalid: {}",
                    building.id
                );
            }
        }
        for recipe in &snapshot.recipes {
            if !building_ids.contains(recipe.building_id.as_str())
                || !recipe.duration.is_finite()
                || recipe.duration <= 0.0
                || !recipe.recursive_priority.is_finite()
            {
                bail!(
                    "native catalog recipe building/duration is invalid: {}",
                    recipe.id
                );
            }
            for amount in recipe.inputs.iter().chain(recipe.outputs.iter()) {
                if !item_ids.contains(amount.item_id.as_str())
                    || !amount.amount.is_finite()
                    || amount.amount <= 0.0
                {
                    bail!("native catalog recipe item is invalid: {}", recipe.id);
                }
            }
        }
        let mut belt_tiers = HashSet::new();
        for belt in &snapshot.belts {
            if belt.tier == 0
                || belt.tier > 32
                || !belt.speed.is_finite()
                || belt.speed <= 0.0
                || !belt_tiers.insert(belt.tier)
            {
                bail!("native catalog belt definition is invalid");
            }
        }
        let mut proliferator_tiers = HashSet::new();
        for proliferator in &snapshot.proliferators {
            if proliferator.tier == 0
                || proliferator.tier > 32
                || !proliferator_tiers.insert(proliferator.tier)
                || !item_ids.contains(proliferator.item_id.as_str())
                || !valid_id(&proliferator.required_tech_id)
                || !proliferator.spray_points.is_finite()
                || proliferator.spray_points <= 0.0
                || !proliferator.extra_product_bonus.is_finite()
                || proliferator.extra_product_bonus < 0.0
                || !proliferator.speed_bonus.is_finite()
                || proliferator.speed_bonus < 0.0
                || !proliferator.power_multiplier.is_finite()
                || proliferator.power_multiplier < 1.0
            {
                bail!("native catalog proliferator definition is invalid");
            }
        }
        let technology_ids = snapshot
            .technologies
            .iter()
            .map(|value| value.id.as_str())
            .collect::<HashSet<_>>();
        for technology in &snapshot.technologies {
            if technology.costs.is_empty()
                || technology.costs.iter().any(|amount| {
                    !item_ids.contains(amount.item_id.as_str())
                        || !amount.amount.is_finite()
                        || amount.amount <= 0.0
                })
                || technology
                    .prerequisites
                    .iter()
                    .any(|id| !technology_ids.contains(id.as_str()))
                || technology
                    .construction_rewards
                    .iter()
                    .any(|id| !valid_id(id))
            {
                bail!(
                    "native catalog technology definition is invalid: {}",
                    technology.id
                );
            }
        }
        let material = serde_json::to_value(&snapshot).context("serialize native catalog")?;
        let fingerprint = canonical_sha256(&material);
        let planets = snapshot.planets.clone();
        let items = snapshot
            .items
            .iter()
            .cloned()
            .map(|value| (value.id.clone(), value))
            .collect();
        let buildings = snapshot
            .buildings
            .iter()
            .cloned()
            .map(|value| (value.id.clone(), value))
            .collect();
        let recipes = snapshot
            .recipes
            .iter()
            .cloned()
            .map(|value| (value.id.clone(), value))
            .collect();
        let constructions = snapshot
            .constructions
            .iter()
            .cloned()
            .map(|value| (value.id.clone(), value))
            .collect();
        let belt_speeds = snapshot
            .belts
            .iter()
            .map(|value| (value.tier, value.speed))
            .collect();
        let proliferators = snapshot
            .proliferators
            .iter()
            .cloned()
            .map(|value| (value.tier, value))
            .collect();
        let technologies = snapshot
            .technologies
            .iter()
            .cloned()
            .map(|value| (value.id.clone(), value))
            .collect();
        // Keep this assertion close to validation: a future catalog extension
        // must not accidentally allow a recipe to shadow another definition.
        if recipe_ids.len() != snapshot.recipes.len() {
            bail!("native catalog recipe index is ambiguous");
        }
        let building_stack_policies = snapshot
            .buildings
            .iter()
            .map(|building| {
                (
                    building.id.clone(),
                    BuildingStackPolicy {
                        limit: None,
                        complete: false,
                    },
                )
            })
            .collect();
        let building_metadata = snapshot
            .buildings
            .iter()
            .map(|building| (building.id.clone(), default_building_metadata(building)))
            .collect();
        let belt_construction_ids = snapshot
            .belts
            .iter()
            .filter_map(|belt| {
                let id = match belt.tier {
                    1 => "conveyor_belt_mk1",
                    2 => "conveyor_belt_mk2",
                    3 => "conveyor_belt_mk3",
                    _ => return None,
                };
                snapshot
                    .constructions
                    .iter()
                    .any(|definition| definition.id == id)
                    .then(|| (belt.tier, id.to_owned()))
            })
            .collect();
        Ok(Self {
            snapshot,
            fingerprint,
            planets,
            star_systems: HashMap::new(),
            items,
            buildings,
            recipes,
            constructions,
            belt_speeds,
            proliferators,
            technologies,
            building_stack_policies,
            building_metadata,
            belt_construction_ids,
            data_only_native_supported: true,
        })
    }

    pub fn from_value(value: Value, expected_registry_fingerprint: &str) -> anyhow::Result<Self> {
        let mut building_stack_policies = HashMap::new();
        let mut building_metadata = HashMap::new();
        let mut data_only_native_supported = true;
        let star_system_rows = match value.get("starSystems") {
            None | Some(Value::Null) => Vec::new(),
            Some(Value::Array(rows)) => {
                serde_json::from_value::<Vec<StarSystemDefinition>>(Value::Array(rows.clone()))
                    .context("decode native star-system command directory")?
            }
            Some(_) => bail!("native catalog star-system command directory is invalid"),
        };
        if let Some(buildings) = value.get("buildings").and_then(Value::as_array) {
            for building in buildings {
                let Some(object) = building.as_object() else {
                    continue;
                };
                let Some(id) = object.get("id").and_then(Value::as_str) else {
                    continue;
                };
                let complete = object
                    .get("stackLimitComplete")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                let limit = if complete {
                    match object.get("stackLimit") {
                        Some(Value::Null) => None,
                        Some(value) => Some(
                            value
                                .as_u64()
                                .filter(|limit| *limit > 0 && *limit <= 100_000_000)
                                .ok_or_else(|| {
                                    anyhow::anyhow!(
                                        "native catalog building stack limit is invalid: {id}"
                                    )
                                })?,
                        ),
                        None => {
                            bail!("native catalog building stack policy is incomplete: {id}")
                        }
                    }
                } else {
                    None
                };
                building_stack_policies
                    .insert(id.to_owned(), BuildingStackPolicy { limit, complete });

                let name = object
                    .get("name")
                    .and_then(Value::as_str)
                    .filter(|value| !value.is_empty() && value.len() <= 160)
                    .unwrap_or(id)
                    .to_owned();
                let short_name = object
                    .get("shortName")
                    .and_then(Value::as_str)
                    .filter(|value| !value.is_empty() && value.len() <= 80)
                    .unwrap_or(&name)
                    .to_owned();
                let description = object
                    .get("description")
                    .and_then(Value::as_str)
                    .filter(|value| value.len() <= 2_048)
                    .unwrap_or_default()
                    .to_owned();
                let required_tech_id = object
                    .get("requiredTechId")
                    .filter(|value| !value.is_null())
                    .map(|value| {
                        value
                            .as_str()
                            .filter(|value| valid_id(value))
                            .map(str::to_owned)
                            .ok_or_else(|| {
                                anyhow::anyhow!(
                                    "native catalog building required technology is invalid: {id}"
                                )
                            })
                    })
                    .transpose()?;
                let upgrade_target_id = object
                    .get("upgradeTargetId")
                    .filter(|value| !value.is_null())
                    .map(|value| {
                        value
                            .as_str()
                            .filter(|value| valid_id(value))
                            .map(str::to_owned)
                            .ok_or_else(|| {
                                anyhow::anyhow!(
                                    "native catalog building upgrade target is invalid: {id}"
                                )
                            })
                    })
                    .transpose()?;
                let boolean = |key: &str, default: bool| -> anyhow::Result<bool> {
                    match object.get(key) {
                        None => Ok(default),
                        Some(Value::Bool(value)) => Ok(*value),
                        Some(_) => bail!("native catalog building {key} flag is invalid: {id}"),
                    }
                };
                let megastructure = boolean("megastructure", builtin_megastructure(id))?;
                let unique = boolean(
                    "unique",
                    matches!(id, "micro_black_hole_connector" | "time_warp_device"),
                )?;
                let scripted = boolean("scripted", false)?;
                data_only_native_supported &= !scripted;
                let bounded_dimension = |key: &str, default: f64| -> anyhow::Result<f64> {
                    match object.get(key) {
                        None => Ok(default),
                        Some(value) => value
                            .as_f64()
                            .filter(|value| {
                                value.is_finite() && *value >= 0.0 && *value <= 10_000.0
                            })
                            .ok_or_else(|| {
                                anyhow::anyhow!("native catalog building {key} is invalid: {id}")
                            }),
                    }
                };
                let layout_width =
                    bounded_dimension("layoutWidth", if megastructure { 620.0 } else { 300.0 })?;
                let layout_height =
                    bounded_dimension("layoutHeight", if megastructure { 420.0 } else { 220.0 })?;
                let layout_clearance = bounded_dimension("layoutClearance", 24.0)?;
                if layout_width <= 0.0 || layout_height <= 0.0 {
                    bail!("native catalog building layout size is empty: {id}")
                }
                let capabilities = object
                    .get("capabilities")
                    .map(|value| {
                        let values = value
                            .as_array()
                            .filter(|values| values.len() <= 64)
                            .ok_or_else(|| {
                                anyhow::anyhow!(
                                    "native catalog building capabilities are invalid: {id}"
                                )
                            })?;
                        let mut result = HashSet::with_capacity(values.len());
                        for value in values {
                            let capability = value
                                .as_str()
                                .filter(|value| valid_id(value))
                                .ok_or_else(|| {
                                    anyhow::anyhow!(
                                        "native catalog building capability is invalid: {id}"
                                    )
                                })?;
                            if !result.insert(capability.to_owned()) {
                                bail!("native catalog building capability is repeated: {id}")
                            }
                        }
                        Ok(result)
                    })
                    .transpose()?
                    .unwrap_or_default();
                let ports = object
                    .get("ports")
                    .map(|value| {
                        let values = value
                            .as_array()
                            .filter(|values| values.len() <= 32)
                            .ok_or_else(|| anyhow::anyhow!("native catalog building ports are invalid: {id}"))?;
                        let mut seen = HashSet::new();
                        let mut result = Vec::with_capacity(values.len());
                        for value in values {
                            let port = value
                                .as_object()
                                .ok_or_else(|| anyhow::anyhow!("native catalog building port is invalid: {id}"))?;
                            let index = port
                                .get("index")
                                .and_then(Value::as_u64)
                                .and_then(|value| u8::try_from(value).ok())
                                .filter(|value| *value < 32)
                                .ok_or_else(|| anyhow::anyhow!("native catalog building port index is invalid: {id}"))?;
                            let direction = port
                                .get("direction")
                                .and_then(Value::as_str)
                                .filter(|value| matches!(*value, "input" | "output" | "bidirectional"))
                                .ok_or_else(|| anyhow::anyhow!("native catalog building port direction is invalid: {id}"))?
                                .to_owned();
                            if !seen.insert((index, direction.clone())) {
                                bail!("native catalog building port is repeated: {id}")
                            }
                            let accepts = port
                                .get("accepts")
                                .and_then(Value::as_str)
                                .filter(|value| matches!(*value, "solid" | "fluid" | "matrix" | "any"))
                                .unwrap_or("any")
                                .to_owned();
                            let max_connections = port
                                .get("maxConnections")
                                .and_then(Value::as_u64)
                                .and_then(|value| u8::try_from(value).ok())
                                .filter(|value| *value > 0 && *value <= 16)
                                .unwrap_or(1);
                            let special = port
                                .get("special")
                                .filter(|value| !value.is_null())
                                .map(|value| {
                                    value
                                        .as_str()
                                        .filter(|value| valid_id(value))
                                        .map(str::to_owned)
                                        .ok_or_else(|| anyhow::anyhow!("native catalog building port special kind is invalid: {id}"))
                                })
                                .transpose()?;
                            result.push(BuildingPortDefinition {
                                index,
                                direction,
                                accepts,
                                max_connections,
                                special,
                            });
                        }
                        result.sort_by(|left, right| {
                            (left.index, left.direction.as_str())
                                .cmp(&(right.index, right.direction.as_str()))
                        });
                        Ok(result)
                    })
                    .transpose()?
                    .unwrap_or_default();
                building_metadata.insert(
                    id.to_owned(),
                    BuildingRuntimeMetadata {
                        name,
                        short_name,
                        description,
                        required_tech_id,
                        upgrade_target_id,
                        unique,
                        megastructure,
                        layout_width,
                        layout_height,
                        layout_clearance,
                        ports,
                        capabilities,
                        scripted,
                    },
                );
            }
        }
        let mut belt_construction_ids = HashMap::new();
        if let Some(belts) = value.get("belts").and_then(Value::as_array) {
            for belt in belts {
                let Some(object) = belt.as_object() else {
                    continue;
                };
                let Some(tier) = object
                    .get("tier")
                    .and_then(Value::as_u64)
                    .and_then(|value| u8::try_from(value).ok())
                else {
                    continue;
                };
                let construction_id = object
                    .get("constructionId")
                    .or_else(|| object.get("id"))
                    .and_then(Value::as_str)
                    .filter(|value| valid_id(value))
                    .map(str::to_owned)
                    .or_else(|| match tier {
                        1 => Some("conveyor_belt_mk1".to_owned()),
                        2 => Some("conveyor_belt_mk2".to_owned()),
                        3 => Some("conveyor_belt_mk3".to_owned()),
                        _ => None,
                    });
                if let Some(construction_id) = construction_id
                    && belt_construction_ids
                        .insert(tier, construction_id)
                        .is_some()
                {
                    bail!("native catalog belt construction tier is repeated")
                }
            }
        }
        let snapshot = serde_json::from_value::<CatalogSnapshot>(value.clone())
            .context("decode native catalog")?;
        let mut catalog = Self::validate(snapshot, expected_registry_fingerprint)?;
        if !star_system_rows.is_empty() {
            if star_system_rows.len() > MAX_CATALOG_ENTRIES {
                bail!("native catalog star-system command directory is too large")
            }
            unique_ids(star_system_rows.iter().map(|system| system.id.as_str()))?;
            let system_ids = star_system_rows
                .iter()
                .map(|system| system.id.as_str())
                .collect::<HashSet<_>>();
            let planet_ids = catalog
                .planets
                .iter()
                .map(|planet| planet.id.as_str())
                .collect::<HashSet<_>>();
            let mut assigned_planets = HashSet::new();
            for system in &star_system_rows {
                if system.planet_ids.is_empty()
                    || system.planet_ids.iter().any(|planet_id| {
                        !planet_ids.contains(planet_id.as_str())
                            || !assigned_planets.insert(planet_id.as_str())
                    })
                    || system.exploration_cost.iter().any(|amount| {
                        !catalog.items.contains_key(&amount.item_id)
                            || !amount.amount.is_finite()
                            || amount.amount <= 0.0
                    })
                    || system
                        .required_tech_id
                        .as_ref()
                        .is_some_and(|id| !catalog.technologies.contains_key(id))
                    || system
                        .prerequisite_system_id
                        .as_ref()
                        .is_some_and(|id| !system_ids.contains(id.as_str()) || id == &system.id)
                {
                    bail!(
                        "native catalog star-system definition is invalid: {}",
                        system.id
                    )
                }
                if system.planet_ids.iter().any(|planet_id| {
                    catalog
                        .planets
                        .iter()
                        .find(|planet| &planet.id == planet_id)
                        .is_none_or(|planet| planet.system_id != system.id)
                }) {
                    bail!(
                        "native catalog star-system planet binding is invalid: {}",
                        system.id
                    )
                }
                let mut cursor = system.prerequisite_system_id.as_deref();
                let mut visited = HashSet::new();
                while let Some(id) = cursor {
                    if !visited.insert(id) || id == system.id {
                        bail!("native catalog star-system prerequisite graph is cyclic")
                    }
                    cursor = star_system_rows
                        .iter()
                        .find(|candidate| candidate.id == id)
                        .and_then(|candidate| candidate.prerequisite_system_id.as_deref());
                }
            }
            if assigned_planets.len() != catalog.planets.len() {
                bail!("native catalog star-system command directory is incomplete")
            }
            catalog.star_systems = star_system_rows
                .into_iter()
                .map(|system| (system.id.clone(), system))
                .collect();
            // Include transient command semantics in the in-memory catalog
            // identity without changing the public registry fingerprint.
            catalog.fingerprint = canonical_sha256(&value);
        }
        for (id, policy) in building_stack_policies {
            if catalog.buildings.contains_key(&id) {
                catalog.building_stack_policies.insert(id, policy);
            }
        }
        for (id, metadata) in building_metadata {
            if catalog.buildings.contains_key(&id) {
                catalog.building_metadata.insert(id, metadata);
            }
        }
        for (tier, construction_id) in belt_construction_ids {
            if catalog.belt_speeds.contains_key(&tier)
                && catalog.constructions.contains_key(&construction_id)
            {
                catalog.belt_construction_ids.insert(tier, construction_id);
            }
        }
        // Cross references are intentionally checked after the permissive v1
        // decoder has retained every unknown row. A malformed or scripted
        // content pack therefore remains importable/exportable, while native
        // player-authority admission fails closed instead of silently running
        // a partial upgrade/technology/line policy.
        catalog.data_only_native_supported =
            data_only_native_supported && data_only_catalog_relations_are_closed(&catalog);
        Ok(catalog)
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn catalog_value(buildings: Value, belts: Value) -> Value {
        json!({
            "protocolVersion": crate::CORE_PROTOCOL_VERSION,
            "registryFingerprint": "catalog-closure-test",
            "planets": [{ "id": "home", "systemId": "helios", "kind": "terrestrial", "orbitIndex": 1 }],
            "items": [{ "id": "ore", "kind": "solid" }],
            "buildings": buildings,
            "recipes": [],
            "constructions": [
                { "id": "mod_a", "outputAmount": 1, "costs": [{ "itemId": "ore", "amount": 1 }] },
                { "id": "mod_b", "outputAmount": 1, "costs": [{ "itemId": "ore", "amount": 1 }] },
                { "id": "mod_belt", "outputAmount": 1, "costs": [{ "itemId": "ore", "amount": 1 }] }
            ],
            "belts": belts,
            "technologies": [{ "id": "mod_tech", "costs": [{ "itemId": "ore", "amount": 1 }] }]
        })
    }

    #[test]
    fn declarative_upgrade_and_custom_belt_relations_are_native_eligible() {
        let value = catalog_value(
            json!([
                { "id": "mod_a", "kind": "machine", "speed": 1, "inputCapacity": 10, "outputCapacity": 10,
                  "stackLimit": 20, "stackLimitComplete": true, "requiredTechId": "mod_tech", "upgradeTargetId": "mod_b" },
                { "id": "mod_b", "kind": "machine", "speed": 2, "inputCapacity": 20, "outputCapacity": 20,
                  "stackLimit": 20, "stackLimitComplete": true }
            ]),
            json!([{ "tier": 4, "speed": 120, "constructionId": "mod_belt" }]),
        );
        let catalog = RuntimeCatalog::from_value(value, "catalog-closure-test").unwrap();
        assert!(catalog.data_only_native_supported);
        assert_eq!(
            catalog.belt_construction_ids.get(&4).map(String::as_str),
            Some("mod_belt")
        );
    }

    #[test]
    fn unknown_technology_cycle_script_or_unfunded_custom_belt_fail_closed() {
        let cases = [
            catalog_value(
                json!([
                    { "id": "mod_a", "kind": "machine", "speed": 1, "inputCapacity": 10, "outputCapacity": 10,
                      "stackLimit": 20, "stackLimitComplete": true, "requiredTechId": "missing" },
                    { "id": "mod_b", "kind": "machine", "speed": 1, "inputCapacity": 10, "outputCapacity": 10,
                      "stackLimit": 20, "stackLimitComplete": true }
                ]),
                json!([]),
            ),
            catalog_value(
                json!([
                    { "id": "mod_a", "kind": "machine", "speed": 1, "inputCapacity": 10, "outputCapacity": 10,
                      "stackLimit": 20, "stackLimitComplete": true, "upgradeTargetId": "mod_b" },
                    { "id": "mod_b", "kind": "machine", "speed": 1, "inputCapacity": 10, "outputCapacity": 10,
                      "stackLimit": 20, "stackLimitComplete": true, "upgradeTargetId": "mod_a" }
                ]),
                json!([]),
            ),
            catalog_value(
                json!([
                    { "id": "mod_a", "kind": "machine", "speed": 1, "inputCapacity": 10, "outputCapacity": 10,
                      "stackLimit": 20, "stackLimitComplete": true, "scripted": true },
                    { "id": "mod_b", "kind": "machine", "speed": 1, "inputCapacity": 10, "outputCapacity": 10,
                      "stackLimit": 20, "stackLimitComplete": true }
                ]),
                json!([]),
            ),
            catalog_value(
                json!([
                    { "id": "mod_a", "kind": "machine", "speed": 1, "inputCapacity": 10, "outputCapacity": 10,
                      "stackLimit": 20, "stackLimitComplete": true },
                    { "id": "mod_b", "kind": "machine", "speed": 1, "inputCapacity": 10, "outputCapacity": 10,
                      "stackLimit": 20, "stackLimitComplete": true }
                ]),
                json!([{ "tier": 4, "speed": 120 }]),
            ),
        ];
        for value in cases {
            let catalog = RuntimeCatalog::from_value(value, "catalog-closure-test").unwrap();
            assert!(!catalog.data_only_native_supported);
        }
    }
}
