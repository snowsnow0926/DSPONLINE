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
    pub family: Option<String>,
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
pub struct BeltDefinition {
    pub tier: u8,
    pub speed: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogSnapshot {
    pub protocol_version: u16,
    pub registry_fingerprint: String,
    pub items: Vec<ItemDefinition>,
    pub buildings: Vec<BuildingDefinition>,
    pub recipes: Vec<RecipeDefinition>,
    pub belts: Vec<BeltDefinition>,
}

#[derive(Debug, Clone)]
pub struct RuntimeCatalog {
    pub snapshot: CatalogSnapshot,
    pub fingerprint: String,
    pub items: HashMap<String, ItemDefinition>,
    pub buildings: HashMap<String, BuildingDefinition>,
    pub recipes: HashMap<String, RecipeDefinition>,
    pub belt_speeds: HashMap<u8, f64>,
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
            + snapshot.belts.len();
        if total == 0 || total > MAX_CATALOG_ENTRIES {
            bail!("native catalog entry count is invalid");
        }
        unique_ids(snapshot.items.iter().map(|value| value.id.as_str()))?;
        unique_ids(snapshot.buildings.iter().map(|value| value.id.as_str()))?;
        unique_ids(snapshot.recipes.iter().map(|value| value.id.as_str()))?;
        let item_ids = snapshot
            .items
            .iter()
            .map(|value| value.id.as_str())
            .collect::<HashSet<_>>();
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
        for item in &snapshot.items {
            if !matches!(item.kind.as_str(), "solid" | "fluid" | "matrix") {
                bail!("native catalog item kind is invalid: {}", item.id);
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
            {
                bail!(
                    "native catalog building numeric field is invalid: {}",
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
        let material = serde_json::to_value(&snapshot).context("serialize native catalog")?;
        let fingerprint = canonical_sha256(&material);
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
        let belt_speeds = snapshot
            .belts
            .iter()
            .map(|value| (value.tier, value.speed))
            .collect();
        // Keep this assertion close to validation: a future catalog extension
        // must not accidentally allow a recipe to shadow another definition.
        if recipe_ids.len() != snapshot.recipes.len() {
            bail!("native catalog recipe index is ambiguous");
        }
        Ok(Self {
            snapshot,
            fingerprint,
            items,
            buildings,
            recipes,
            belt_speeds,
        })
    }

    pub fn from_value(value: Value, expected_registry_fingerprint: &str) -> anyhow::Result<Self> {
        let snapshot =
            serde_json::from_value::<CatalogSnapshot>(value).context("decode native catalog")?;
        Self::validate(snapshot, expected_registry_fingerprint)
    }
}
