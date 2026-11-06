use crate::catalog::{CatalogSnapshot, RecipeDefinition, RuntimeCatalog};
use anyhow::{Result, bail};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::HashMap;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentRules {
    #[serde(default)]
    pub id_migrations: Vec<crate::content_id_migration::IdMigration>,
    #[serde(default)]
    pub technology_effects: Vec<TechnologyEffect>,
    #[serde(default)]
    pub recipe_groups: Vec<RecipeGroup>,
    #[serde(default)]
    pub recipe_policies: Vec<RecipePolicy>,
    #[serde(default)]
    pub generators: Vec<GeneratorRule>,
    #[serde(default)]
    pub resources: Vec<ResourceRule>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TechnologyEffect {
    pub technology_id: String,
    #[serde(flatten)]
    pub multipliers: HashMap<String, f64>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecipeGroup {
    pub required_tech_id: String,
    pub recipe_ids: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecipePolicy {
    pub building_id: String,
    pub recipe_ids: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceRule {
    pub item_id: String,
    pub extractor_building_id: String,
    #[serde(default)]
    pub planet_ids: Vec<String>,
    #[serde(default)]
    pub reserve: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneratorRule {
    pub building_id: String,
}

fn completed(base: &Map<String, Value>, id: &str) -> bool {
    base.get("research")
        .and_then(|value| value.get("completedTechIds"))
        .and_then(Value::as_array)
        .is_some_and(|ids| ids.iter().any(|value| value.as_str() == Some(id)))
}
impl ContentRules {
    pub fn is_empty(&self) -> bool {
        self.id_migrations.is_empty()
            && self.technology_effects.is_empty()
            && self.recipe_groups.is_empty()
            && self.recipe_policies.is_empty()
            && self.generators.is_empty()
            && self.resources.is_empty()
    }
    pub fn validate(&self, snapshot: &CatalogSnapshot) -> Result<()> {
        if self.id_migrations.len() > 16_384 {
            bail!("content ID migrations exceed limit");
        }
        for rule in &self.id_migrations {
            let valid_target = match rule.kind.as_str() {
                "items" => snapshot.items.iter().any(|entry| entry.id == rule.to),
                "buildings" => snapshot.buildings.iter().any(|entry| entry.id == rule.to),
                "recipes" => snapshot.recipes.iter().any(|entry| entry.id == rule.to),
                "technologies" => snapshot
                    .technologies
                    .iter()
                    .any(|entry| entry.id == rule.to),
                "belts" => snapshot
                    .constructions
                    .iter()
                    .any(|entry| entry.id == rule.to),
                _ => false,
            };
            if !valid_target
                || rule.from.is_empty()
                || rule.from.len() > 160
                || rule.from == rule.to
                || self
                    .id_migrations
                    .iter()
                    .any(|next| next.kind == rule.kind && next.from == rule.to)
            {
                bail!("invalid content ID migration");
            }
        }
        if self.technology_effects.len()
            + self.recipe_groups.len()
            + self.recipe_policies.len()
            + self.resources.len()
            > 16_384
        {
            bail!("content rules exceed limit");
        }
        for effect in &self.technology_effects {
            if !snapshot
                .technologies
                .iter()
                .any(|tech| tech.id == effect.technology_id)
                || effect.multipliers.is_empty()
                || effect.multipliers.iter().any(|(key, value)| {
                    ![
                        "productionSpeed",
                        "powerConsumption",
                        "miningSpeed",
                        "storageCapacity",
                    ]
                    .contains(&key.as_str())
                        || !value.is_finite()
                        || *value < 0.01
                        || *value > 100.0
                })
            {
                bail!("invalid technology effect");
            }
        }
        for group in &self.recipe_groups {
            if !snapshot
                .technologies
                .iter()
                .any(|tech| tech.id == group.required_tech_id)
                || group
                    .recipe_ids
                    .iter()
                    .any(|id| !snapshot.recipes.iter().any(|recipe| &recipe.id == id))
            {
                bail!("invalid recipe group");
            }
        }
        for policy in &self.recipe_policies {
            if !snapshot
                .buildings
                .iter()
                .any(|building| building.id == policy.building_id && building.kind == "machine")
                || policy
                    .recipe_ids
                    .iter()
                    .any(|id| !snapshot.recipes.iter().any(|recipe| &recipe.id == id))
            {
                bail!("invalid recipe policy");
            }
        }
        for generator in &self.generators {
            if !snapshot.buildings.iter().any(|building| {
                building.id == generator.building_id
                    && building.kind == "power"
                    && !building.fuel_item_ids.is_empty()
            }) {
                bail!("invalid generator rule");
            }
        }
        for resource in &self.resources {
            if !snapshot
                .items
                .iter()
                .any(|item| item.id == resource.item_id)
                || !snapshot.buildings.iter().any(|building| {
                    building.id == resource.extractor_building_id && building.kind == "miner"
                })
                || resource.planet_ids.iter().any(|id| {
                    !snapshot
                        .planets
                        .iter()
                        .any(|planet| &planet.id == id && planet.kind == "terrestrial")
                })
                || resource
                    .reserve
                    .is_some_and(|reserve| reserve == 0 || reserve > 1_000_000_000_000)
            {
                bail!("invalid resource rule");
            }
        }
        Ok(())
    }
    pub fn multiplier(&self, base: &Map<String, Value>, key: &str) -> f64 {
        self.technology_effects
            .iter()
            .filter(|effect| completed(base, &effect.technology_id))
            .fold(1.0_f64, |result, effect| {
                (result * effect.multipliers.get(key).copied().unwrap_or(1.0)).clamp(0.01, 100.0)
            })
    }
    pub fn recipe_available(&self, base: &Map<String, Value>, recipe: &RecipeDefinition) -> bool {
        recipe
            .required_tech_id
            .as_deref()
            .is_none_or(|id| completed(base, id))
            && self.recipe_groups.iter().all(|group| {
                !group.recipe_ids.contains(&recipe.id) || completed(base, &group.required_tech_id)
            })
    }
    pub fn extractor_id<'a>(&'a self, resource: &'a str) -> &'a str {
        self.resources
            .iter()
            .find(|rule| rule.item_id == resource)
            .map(|rule| rule.extractor_building_id.as_str())
            .unwrap_or(match resource {
                "crude_oil" => "oil_extractor",
                "water" | "sulfuric_acid" => "water_pump",
                _ => "mining_machine",
            })
    }
}
impl RuntimeCatalog {
    pub fn recipe_allowed(&self, building_id: &str, recipe: &RecipeDefinition) -> bool {
        if let Some(policy) = self
            .snapshot
            .content_rules
            .recipe_policies
            .iter()
            .find(|policy| policy.building_id == building_id)
        {
            return policy.recipe_ids.contains(&recipe.id);
        }
        let Some(building) = self.buildings.get(building_id) else {
            return false;
        };
        let base = crate::command::recipe_building_base(building_id, building.family.as_deref());
        base == recipe.building_id
            || building_id == recipe.building_id
            || building.family.as_ref().is_some_and(|family| {
                self.buildings
                    .get(&recipe.building_id)
                    .and_then(|other| other.family.as_ref())
                    == Some(family)
            })
    }
}

impl crate::state::CoreState {
    pub(crate) fn capacity_multiplier(&self) -> f64 {
        self.capacity_multiplier_for(self.base_value())
    }
    pub(crate) fn capacity_multiplier_for(&self, base: &Map<String, Value>) -> f64 {
        self.catalog
            .snapshot
            .content_rules
            .multiplier(base, "storageCapacity")
    }
}
