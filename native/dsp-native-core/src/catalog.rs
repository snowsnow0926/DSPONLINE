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
    pub kind: String,
    #[serde(default)]
    pub fuel_energy_mj: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanetDefinition {
    pub id: String,
    pub system_id: String,
    pub kind: String,
    pub orbit_index: u16,
    #[serde(default)]
    pub orbital_yields: HashMap<String, f64>,
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
    pub building_id: String,
    pub duration: f64,
    #[serde(default)]
    pub required_tech_id: Option<String>,
    pub inputs: Vec<ItemAmount>,
    pub outputs: Vec<ItemAmount>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConstructionDefinition {
    pub id: String,
    pub output_amount: f64,
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
    pub items: HashMap<String, ItemDefinition>,
    pub buildings: HashMap<String, BuildingDefinition>,
    pub recipes: HashMap<String, RecipeDefinition>,
    pub constructions: HashMap<String, ConstructionDefinition>,
    pub belt_speeds: HashMap<u8, f64>,
    pub proliferators: HashMap<u8, ProliferatorDefinition>,
    pub technologies: HashMap<String, TechnologyDefinition>,
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
        Ok(Self {
            snapshot,
            fingerprint,
            planets,
            items,
            buildings,
            recipes,
            constructions,
            belt_speeds,
            proliferators,
            technologies,
        })
    }

    pub fn from_value(value: Value, expected_registry_fingerprint: &str) -> anyhow::Result<Self> {
        let snapshot =
            serde_json::from_value::<CatalogSnapshot>(value).context("decode native catalog")?;
        Self::validate(snapshot, expected_registry_fingerprint)
    }
}
