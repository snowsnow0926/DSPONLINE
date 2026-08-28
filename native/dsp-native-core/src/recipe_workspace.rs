use std::collections::{HashMap, HashSet};

use anyhow::{anyhow, bail};
use serde_json::{Map, Value, json};

use crate::state::CoreState;

const MAX_PROJECTION_BYTES: usize = 1_048_576;
const MAX_ITEM_ROWS: usize = 256;
const MAX_COMPLETED_TECH_ROWS: usize = 512;
const MAX_PLANET_ROWS: usize = 64;
const MAX_PROFILE_ITEM_ROWS: usize = 256;
const MAX_COLONY_COST_ROWS: usize = 32;
const MAX_LOCATION_ROWS: usize = 4_096;
const DYSON_STRUCTURE_POWER_KW: f64 = 960.0;
const DYSON_SHELL_SAIL_POWER_KW: f64 = 88.0;
const DYSON_SHELL_CAPACITY_PER_STRUCTURE: f64 = 40.0;

fn finite(value: Option<&Value>) -> f64 {
    value
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
        .unwrap_or(0.0)
}

fn required_finite(object: &Map<String, Value>, key: &str, label: &str) -> anyhow::Result<f64> {
    object
        .get(key)
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
        .ok_or_else(|| anyhow!("native recipe workspace {label} is invalid"))
}

fn required_text<'a>(
    object: &'a Map<String, Value>,
    key: &str,
    label: &str,
) -> anyhow::Result<&'a str> {
    object
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty() && value.len() <= 512)
        .ok_or_else(|| anyhow!("native recipe workspace {label} is invalid"))
}

fn infinite_level(base: &Map<String, Value>, research_id: &str) -> f64 {
    base.get("endgame")
        .and_then(Value::as_object)
        .and_then(|endgame| endgame.get("infiniteResearch"))
        .and_then(Value::as_object)
        .and_then(|research| research.get(research_id))
        .and_then(Value::as_object)
        .map(|progress| finite(progress.get("level")).floor().max(0.0))
        .unwrap_or(0.0)
}

fn dyson_power_multiplier(base: &Map<String, Value>) -> f64 {
    1.0 + infinite_level(base, "stellar_harnessing") * 0.05
}

fn round_to(value: f64, digits: i32) -> f64 {
    let scale = 10_f64.powi(digits);
    (value * scale).round() / scale
}

fn shell_is_active(layer: &Map<String, Value>, shell: &Map<String, Value>) -> bool {
    let Some(boundary_ids) = shell.get("boundaryFrameIds").and_then(Value::as_array) else {
        return false;
    };
    if boundary_ids.is_empty() {
        return false;
    }
    let frames = layer
        .get("frames")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    boundary_ids.iter().all(|boundary_id| {
        boundary_id.as_str().is_some_and(|boundary_id| {
            frames.iter().filter_map(Value::as_object).any(|frame| {
                frame.get("id").and_then(Value::as_str) == Some(boundary_id)
                    && finite(frame.get("completedStructurePoints"))
                        >= finite(frame.get("requiredStructurePoints"))
            })
        })
    })
}

fn dyson_plan_summary(
    base: &Map<String, Value>,
    system_id: &str,
) -> anyhow::Result<(usize, f64, f64, f64, f64)> {
    let plan = base
        .get("dysonPlans")
        .and_then(Value::as_object)
        .and_then(|plans| plans.get(system_id))
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("native recipe workspace Dyson plan is missing"))?;
    let layers = plan
        .get("layers")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("native recipe workspace Dyson layers are missing"))?;
    let mut completed_structure = 0.0;
    let mut shell_capacity = 0.0;
    let mut shell_found = false;
    for layer in layers.iter().filter_map(Value::as_object) {
        for key in ["nodes", "frames"] {
            let entries = layer
                .get(key)
                .and_then(Value::as_array)
                .ok_or_else(|| anyhow!("native recipe workspace Dyson {key} are missing"))?;
            completed_structure += entries
                .iter()
                .filter_map(Value::as_object)
                .map(|entry| finite(entry.get("completedStructurePoints")))
                .sum::<f64>();
        }
        let shells = layer
            .get("shells")
            .and_then(Value::as_array)
            .ok_or_else(|| anyhow!("native recipe workspace Dyson shells are missing"))?;
        for shell in shells.iter().filter_map(Value::as_object) {
            shell_found = true;
            if shell_is_active(layer, shell) {
                shell_capacity += finite(shell.get("sailCapacity"));
            }
        }
    }
    let structure_points = finite(plan.get("structurePoints")).floor().max(0.0);
    if !shell_found && layers.is_empty() {
        shell_capacity = structure_points * DYSON_SHELL_CAPACITY_PER_STRUCTURE;
    }
    Ok((
        layers.len(),
        completed_structure,
        shell_capacity,
        finite(plan.get("shellSails")).floor().max(0.0),
        structure_points,
    ))
}

fn profile_item_ids(
    value: Option<&Value>,
    known_items: &HashSet<&str>,
    label: &str,
) -> anyhow::Result<(Vec<Value>, usize, bool)> {
    let values = value
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("native recipe workspace {label} is missing"))?;
    let rows = values
        .iter()
        .take(MAX_PROFILE_ITEM_ROWS)
        .map(|value| {
            let item_id = value
                .as_str()
                .filter(|item_id| known_items.contains(*item_id))
                .ok_or_else(|| anyhow!("native recipe workspace {label} item is invalid"))?;
            Ok(Value::from(item_id))
        })
        .collect::<anyhow::Result<Vec<_>>>()?;
    Ok((rows, values.len(), values.len() > MAX_PROFILE_ITEM_ROWS))
}

fn profile_amount_rows(
    value: Option<&Value>,
    known_items: &HashSet<&str>,
    limit: usize,
    label: &str,
) -> anyhow::Result<(Vec<Value>, usize, bool)> {
    let values = value
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("native recipe workspace {label} is missing"))?;
    let rows = values
        .iter()
        .take(limit)
        .map(|value| {
            let row = value
                .as_object()
                .ok_or_else(|| anyhow!("native recipe workspace {label} row is invalid"))?;
            let item_id = required_text(row, "itemId", label)?;
            if !known_items.contains(item_id) {
                bail!("native recipe workspace {label} item is missing");
            }
            let amount = required_finite(row, "amount", label)?;
            if amount < 0.0 {
                bail!("native recipe workspace {label} amount is negative");
            }
            Ok(json!({ "itemId": item_id, "amount": amount }))
        })
        .collect::<anyhow::Result<Vec<_>>>()?;
    Ok((rows, values.len(), values.len() > limit))
}

fn profile_yield_rows(
    value: Option<&Value>,
    known_items: &HashSet<&str>,
    label: &str,
) -> anyhow::Result<(Vec<Value>, usize, bool)> {
    let values = value
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("native recipe workspace {label} is missing"))?;
    let mut entries = values.iter().collect::<Vec<_>>();
    entries.sort_by(|left, right| left.0.cmp(right.0));
    let rows = entries
        .into_iter()
        .take(MAX_PROFILE_ITEM_ROWS)
        .map(|(item_id, rate)| {
            if !known_items.contains(item_id.as_str()) {
                bail!("native recipe workspace {label} item is missing");
            }
            let rate = rate
                .as_f64()
                .filter(|rate| rate.is_finite() && *rate >= 0.0)
                .ok_or_else(|| anyhow!("native recipe workspace {label} rate is invalid"))?;
            Ok(json!({ "itemId": item_id, "rate": rate }))
        })
        .collect::<anyhow::Result<Vec<_>>>()?;
    Ok((rows, values.len(), values.len() > MAX_PROFILE_ITEM_ROWS))
}

fn producer_for_item(state: &CoreState, entity: &Map<String, Value>, item_id: &str) -> bool {
    if entity.get("kind").and_then(Value::as_str) == Some("vein") {
        return entity.get("resourceId").and_then(Value::as_str) == Some(item_id)
            && finite(entity.get("minerCount")) > 0.0;
    }
    if entity.get("buildingId").and_then(Value::as_str) == Some("orbital_collector") {
        return entity.get("storedItemId").and_then(Value::as_str) == Some(item_id);
    }
    entity
        .get("recipeId")
        .and_then(Value::as_str)
        .and_then(|recipe_id| state.catalog.recipes.get(recipe_id))
        .is_some_and(|recipe| {
            recipe
                .outputs
                .iter()
                .any(|output| output.item_id == item_id && output.amount > 0.0)
        })
}

impl CoreState {
    #[allow(clippy::too_many_arguments)]
    pub fn recipe_workspace_projection(
        &self,
        expected_registry_fingerprint: &str,
        item_ids: &[String],
        selected_item_id: &str,
        location_planet_id: Option<&str>,
        location_cursor: usize,
        location_limit: usize,
    ) -> anyhow::Result<Value> {
        if expected_registry_fingerprint != self.catalog.snapshot.registry_fingerprint
            || item_ids.len() > MAX_ITEM_ROWS
            || !self.catalog.items.contains_key(selected_item_id)
            || location_planet_id.is_some() && !(1..=MAX_LOCATION_ROWS).contains(&location_limit)
            || location_planet_id.is_none() && (location_cursor != 0 || location_limit != 0)
        {
            bail!("native recipe workspace selector is invalid");
        }
        let mut requested = HashSet::new();
        for item_id in item_ids {
            if !self.catalog.items.contains_key(item_id) || !requested.insert(item_id.as_str()) {
                bail!("native recipe workspace item selector is invalid");
            }
        }
        let location_planet_index = match location_planet_id {
            Some(planet_id) => Some(
                self.catalog
                    .planets
                    .iter()
                    .position(|planet| planet.id == planet_id)
                    .ok_or_else(|| anyhow!("native recipe workspace location planet is missing"))?,
            ),
            None => None,
        };
        let base = self.base_value();
        let active_planet_id = base
            .get("activePlanetId")
            .and_then(Value::as_str)
            .filter(|planet_id| {
                self.catalog
                    .planets
                    .iter()
                    .any(|planet| planet.id == *planet_id)
            })
            .ok_or_else(|| anyhow!("native recipe workspace active planet is invalid"))?;
        let active_system_id = self
            .catalog
            .planets
            .iter()
            .find(|planet| planet.id == active_planet_id)
            .map(|planet| planet.system_id.as_str())
            .ok_or_else(|| anyhow!("native recipe workspace active system is invalid"))?;
        let planet_index = self
            .catalog
            .planets
            .iter()
            .enumerate()
            .map(|(index, planet)| (planet.id.as_str(), index))
            .collect::<HashMap<_, _>>();

        let mut stocks = item_ids
            .iter()
            .map(|item_id| (item_id.clone(), 0.0))
            .collect::<HashMap<_, _>>();
        let mut selected_stock = 0.0;
        let mut producer_counts = vec![0_usize; self.catalog.planets.len()];
        let mut location_total = 0_usize;
        let mut location_entities = Vec::with_capacity(location_limit);
        let mut sail_launches_per_minute = 0.0;
        let mut rocket_launches_per_minute = 0.0;
        let mut receiver_load_kw = 0.0;
        let mut critical_photon_per_minute = 0.0;

        for entity_index in 0..self.entities.ids.len() {
            let entity_value = self.parse_entity(entity_index)?;
            let entity = entity_value
                .as_object()
                .ok_or_else(|| anyhow!("native recipe workspace entity is invalid"))?;
            for inventory in [entity.get("inputs"), entity.get("outputs")]
                .into_iter()
                .filter_map(|value| value.and_then(Value::as_object))
            {
                for (item_id, amount) in inventory {
                    let amount = amount
                        .as_f64()
                        .filter(|amount| amount.is_finite())
                        .unwrap_or(0.0);
                    if let Some(stock) = stocks.get_mut(item_id) {
                        *stock += amount;
                    }
                    if item_id == selected_item_id {
                        selected_stock += amount;
                    }
                }
            }
            let entity_planet_id = entity
                .get("planetId")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let entity_planet_index = planet_index.get(entity_planet_id).copied();
            if producer_for_item(self, entity, selected_item_id)
                && let Some(entity_planet_index) = entity_planet_index
            {
                producer_counts[entity_planet_index] += 1;
                if location_planet_index == Some(entity_planet_index) {
                    if location_total >= location_cursor && location_entities.len() < location_limit
                    {
                        let position = entity
                            .get("position")
                            .and_then(Value::as_object)
                            .ok_or_else(|| {
                                anyhow!("native recipe workspace entity position is invalid")
                            })?;
                        location_entities.push(json!({
                            "id": self.entities.ids[entity_index].to_owned(),
                            "x": required_finite(position, "x", "entity x position")?,
                            "y": required_finite(position, "y", "entity y position")?,
                        }));
                    }
                    location_total += 1;
                }
            }
            let Some(entity_planet_index) = entity_planet_index else {
                continue;
            };
            if self.catalog.planets[entity_planet_index].system_id != active_system_id {
                continue;
            }
            let recipe_id = entity.get("recipeId").and_then(Value::as_str);
            let building_id = entity.get("buildingId").and_then(Value::as_str);
            if entity.get("kind").and_then(Value::as_str) == Some("machine")
                && let (Some(recipe_id), Some(building_id)) = (recipe_id, building_id)
                && matches!(recipe_id, "solar_sail_launch" | "carrier_rocket_launch")
                && (recipe_id != "solar_sail_launch"
                    || crate::dyson::valid_ejector_target(self, base, entity))
                && let (Some(recipe), Some(building)) = (
                    self.catalog.recipes.get(recipe_id),
                    self.catalog.buildings.get(building_id),
                )
            {
                let rate = building.speed * finite(entity.get("machineCount")) / recipe.duration
                    * 60.0
                    * crate::dyson::launch_factor(base, recipe_id);
                if recipe_id == "solar_sail_launch" {
                    sail_launches_per_minute += rate;
                } else {
                    rocket_launches_per_minute += rate;
                }
            }
            if building_id == Some("ray_receiver") {
                receiver_load_kw += finite(entity.get("powerOutputKw")).max(0.0);
            }
            if recipe_id == Some("critical_photon") {
                critical_photon_per_minute += finite(entity.get("productionRate")).max(0.0);
            }
        }
        if location_cursor > location_total {
            bail!("native recipe workspace location cursor is invalid");
        }

        let active_tray = base.get("tray").and_then(Value::as_object);
        let planet_trays = base.get("planetTrays").and_then(Value::as_object);
        for planet in &self.catalog.planets {
            let tray = if planet.id == active_planet_id {
                active_tray
            } else {
                planet_trays
                    .and_then(|trays| trays.get(&planet.id))
                    .and_then(Value::as_object)
            };
            if let Some(tray) = tray {
                for (item_id, amount) in tray {
                    let amount = amount
                        .as_f64()
                        .filter(|amount| amount.is_finite())
                        .unwrap_or(0.0);
                    if let Some(stock) = stocks.get_mut(item_id) {
                        *stock += amount;
                    }
                    if item_id == selected_item_id {
                        selected_stock += amount;
                    }
                }
            }
        }
        if let Some(cargo) = base.get("cargo").and_then(Value::as_object)
            && let (Some(item_id), Some(amount)) = (
                cargo.get("itemId").and_then(Value::as_str),
                cargo
                    .get("amount")
                    .and_then(Value::as_f64)
                    .filter(|value| value.is_finite()),
            )
        {
            if let Some(stock) = stocks.get_mut(item_id) {
                *stock += amount;
            }
            if item_id == selected_item_id {
                selected_stock += amount;
            }
        }
        let item_stock_rows = item_ids
            .iter()
            .map(|item_id| json!({ "itemId": item_id, "amount": stocks[item_id].floor() }))
            .collect::<Vec<_>>();

        let research = base
            .get("research")
            .and_then(Value::as_object)
            .ok_or_else(|| anyhow!("native recipe workspace research is missing"))?;
        let completed_values = research
            .get("completedTechIds")
            .and_then(Value::as_array)
            .ok_or_else(|| anyhow!("native recipe workspace completed technologies are missing"))?;
        let completed_tech_ids = completed_values
            .iter()
            .take(MAX_COMPLETED_TECH_ROWS)
            .map(|value| {
                let tech_id = value
                    .as_str()
                    .filter(|tech_id| self.catalog.technologies.contains_key(*tech_id))
                    .ok_or_else(|| {
                        anyhow!("native recipe workspace completed technology is invalid")
                    })?;
                Ok(Value::from(tech_id))
            })
            .collect::<anyhow::Result<Vec<_>>>()?;
        let mut truncated = completed_values.len() > MAX_COMPLETED_TECH_ROWS
            || self.catalog.planets.len() > MAX_PLANET_ROWS;

        let known_items = self
            .catalog
            .items
            .keys()
            .map(String::as_str)
            .collect::<HashSet<_>>();
        let galaxy = base
            .get("galaxy")
            .and_then(Value::as_object)
            .ok_or_else(|| anyhow!("native recipe workspace galaxy is missing"))?;
        let profiles = galaxy
            .get("profiles")
            .and_then(Value::as_object)
            .ok_or_else(|| anyhow!("native recipe workspace planet profiles are missing"))?;
        let system_profiles = galaxy
            .get("systemProfiles")
            .and_then(Value::as_object)
            .ok_or_else(|| anyhow!("native recipe workspace system profiles are missing"))?;
        let mut planet_rows = Vec::with_capacity(self.catalog.planets.len().min(MAX_PLANET_ROWS));
        for planet in self.catalog.planets.iter().take(MAX_PLANET_ROWS) {
            let profile = profiles
                .get(&planet.id)
                .and_then(Value::as_object)
                .ok_or_else(|| anyhow!("native recipe workspace planet profile is missing"))?;
            let system = system_profiles
                .get(&planet.system_id)
                .and_then(Value::as_object)
                .ok_or_else(|| anyhow!("native recipe workspace system profile is missing"))?;
            let (resource_rows, resource_count, resource_truncated) =
                profile_item_ids(profile.get("resourceIds"), &known_items, "planet resources")?;
            let (yield_rows, yield_count, yield_truncated) = profile_yield_rows(
                profile.get("orbitalYields"),
                &known_items,
                "planet orbital yields",
            )?;
            let (colony_rows, colony_count, colony_truncated) = profile_amount_rows(
                profile.get("colonyCost"),
                &known_items,
                MAX_COLONY_COST_ROWS,
                "planet colony cost",
            )?;
            truncated |= resource_truncated || yield_truncated || colony_truncated;
            let luminosity = required_finite(system, "luminosity", "system luminosity")?;
            let solar_multiplier =
                required_finite(profile, "solarMultiplier", "planet solar multiplier")?;
            let tidal_locked = profile
                .get("tidalLocked")
                .and_then(Value::as_bool)
                .ok_or_else(|| anyhow!("native recipe workspace tidal lock is invalid"))?;
            planet_rows.push(json!({
                "planetId": planet.id,
                "climateName": required_text(profile, "climateName", "planet climate")?,
                "starTypeName": required_text(system, "starTypeName", "system star type")?,
                "oceanType": required_text(profile, "oceanType", "planet ocean")?,
                "windMultiplier": required_finite(profile, "windMultiplier", "planet wind multiplier")?,
                "solarPowerMultiplier": round_to(solar_multiplier * luminosity * if tidal_locked { 1.25 } else { 1.0 }, 2),
                "geothermalMultiplier": required_finite(profile, "geothermalMultiplier", "planet geothermal multiplier")?,
                "miningMultiplier": required_finite(profile, "miningMultiplier", "planet mining multiplier")?,
                "reserveScale": required_finite(profile, "reserveScale", "planet reserve scale")?,
                "tidalLocked": tidal_locked,
                "resourceIds": { "rows": resource_rows, "totalCount": resource_count, "truncated": resource_truncated },
                "orbitalYields": { "rows": yield_rows, "totalCount": yield_count, "truncated": yield_truncated },
                "colonyCost": { "rows": colony_rows, "totalCount": colony_count, "truncated": colony_truncated },
            }));
        }

        let engineering = base
            .get("dysonEngineering")
            .and_then(Value::as_object)
            .ok_or_else(|| anyhow!("native recipe workspace Dyson engineering is missing"))?;
        let orbits = engineering
            .get("orbitsBySystem")
            .and_then(Value::as_object)
            .and_then(|systems| systems.get(active_system_id))
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or(&[]);
        let orbit_sails = orbits
            .iter()
            .filter_map(Value::as_object)
            .map(|orbit| finite(orbit.get("sailsInOrbit")).max(0.0))
            .sum::<f64>();
        let orbit_generation = orbits
            .iter()
            .filter_map(Value::as_object)
            .map(|orbit| finite(orbit.get("generationKw")).max(0.0))
            .sum::<f64>();
        let (_layer_count, completed_structure, shell_capacity, shell_sails, structure_points) =
            dyson_plan_summary(base, active_system_id)?;
        let luminosity = system_profiles
            .get(active_system_id)
            .and_then(Value::as_object)
            .map(|system| required_finite(system, "luminosity", "system luminosity"))
            .transpose()?
            .unwrap_or(1.0);
        let projected_generation = orbit_generation
            + (structure_points * DYSON_STRUCTURE_POWER_KW
                + shell_sails * DYSON_SHELL_SAIL_POWER_KW)
                * dyson_power_multiplier(base)
                * luminosity;

        let recipe_focus = base
            .get("recipeFocus")
            .and_then(Value::as_object)
            .ok_or_else(|| anyhow!("native recipe workspace focus is missing"))?;
        let focus_item_id = match recipe_focus.get("itemId") {
            None | Some(Value::Null) => Value::Null,
            Some(Value::String(item_id)) if self.catalog.items.contains_key(item_id) => {
                Value::from(item_id.clone())
            }
            _ => bail!("native recipe workspace focus item is invalid"),
        };
        let focus_mode = recipe_focus
            .get("mode")
            .and_then(Value::as_str)
            .filter(|mode| matches!(*mode, "two-level" | "full"))
            .ok_or_else(|| anyhow!("native recipe workspace focus mode is invalid"))?;
        let metrics = base
            .get("metrics")
            .and_then(Value::as_object)
            .ok_or_else(|| anyhow!("native recipe workspace metrics are missing"))?;
        let production_locations = self
            .catalog
            .planets
            .iter()
            .enumerate()
            .take(MAX_PLANET_ROWS)
            .filter(|(index, _)| producer_counts[*index] > 0)
            .map(|(index, planet)| {
                json!({ "planetId": planet.id, "producerCount": producer_counts[index] })
            })
            .collect::<Vec<_>>();
        let location_page = location_planet_index.map(|planet_index| {
            let next_cursor = location_cursor
                .checked_add(location_entities.len())
                .filter(|next| *next < location_total);
            json!({
                "planetId": self.catalog.planets[planet_index].id,
                "cursor": location_cursor,
                "totalCount": location_total,
                "entities": location_entities,
                "nextCursor": next_cursor,
            })
        });
        let request_location = location_planet_id.map(|planet_id| {
            json!({ "planetId": planet_id, "cursor": location_cursor, "limit": location_limit })
        });
        let value = json!({
            "schemaVersion": 1,
            "projectionType": "recipe-workspace-v1",
            "revision": self.revision,
            "registryFingerprint": self.catalog.snapshot.registry_fingerprint,
            "truncated": truncated,
            "limits": {
                "itemRows": MAX_ITEM_ROWS,
                "completedTechRows": MAX_COMPLETED_TECH_ROWS,
                "planetRows": MAX_PLANET_ROWS,
                "profileItemRows": MAX_PROFILE_ITEM_ROWS,
                "colonyCostRows": MAX_COLONY_COST_ROWS,
                "locationRows": MAX_LOCATION_ROWS,
            },
            "counts": {
                "catalogItems": self.catalog.items.len(),
                "completedTechIds": completed_values.len(),
                "planetProfiles": self.catalog.planets.len(),
            },
            "request": {
                "itemIds": item_ids,
                "selectedItemId": selected_item_id,
                "location": request_location,
            },
            "live": {
                "activePlanetId": active_planet_id,
                "recipeFocus": { "itemId": focus_item_id, "mode": focus_mode },
                "completedTechIds": completed_tech_ids,
                "beltCount": self.belts.ids.len(),
                "metrics": {
                    "generationKw": required_finite(metrics, "generationKw", "generation metric")?,
                    "demandKw": required_finite(metrics, "demandKw", "demand metric")?,
                    "powerFactor": required_finite(metrics, "powerFactor", "power factor metric")?,
                },
                "planetProfiles": planet_rows,
                "dyson": {
                    "systemId": active_system_id,
                    "orbitCount": orbits.len(),
                    "orbitSails": orbit_sails.floor(),
                    "completedStructurePoints": completed_structure,
                    "projectedGenerationKw": projected_generation.floor(),
                    "sailLaunchesPerMinute": round_to(sail_launches_per_minute, 2),
                    "rocketLaunchesPerMinute": round_to(rocket_launches_per_minute, 2),
                    "receiverLoadKw": receiver_load_kw,
                    "criticalPhotonPerMinute": round_to(critical_photon_per_minute, 2),
                    "shellSails": shell_sails,
                    "shellCapacity": shell_capacity,
                },
            },
            "itemStocks": item_stock_rows,
            "selectedItem": {
                "itemId": selected_item_id,
                "stock": selected_stock.floor(),
                "productionLocations": production_locations,
            },
            "locationPage": location_page,
        });
        if serde_json::to_vec(&value)?.len() > MAX_PROJECTION_BYTES {
            bail!("native recipe workspace projection exceeds the byte limit");
        }
        Ok(value)
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use serde_json::json;

    use super::*;
    use crate::catalog::{
        BeltDefinition, BuildingDefinition, CatalogSnapshot, ItemAmount, ItemDefinition,
        PlanetDefinition, RecipeDefinition, RuntimeCatalog, TechnologyDefinition,
    };
    use crate::state::CoreCheckpointIdentity;

    fn catalog() -> RuntimeCatalog {
        RuntimeCatalog::validate(
            CatalogSnapshot {
                protocol_version: 1,
                registry_fingerprint: "recipe-workspace-test".to_owned(),
                planets: vec![
                    PlanetDefinition {
                        id: "home".to_owned(),
                        name: "Home".to_owned(),
                        system_id: "helios".to_owned(),
                        kind: "terrestrial".to_owned(),
                        orbit_index: 1,
                        simulation_order: 0,
                        orbital_yields: HashMap::new(),
                    },
                    PlanetDefinition {
                        id: "ashen".to_owned(),
                        name: "Ashen".to_owned(),
                        system_id: "helios".to_owned(),
                        kind: "terrestrial".to_owned(),
                        orbit_index: 2,
                        simulation_order: 1,
                        orbital_yields: HashMap::new(),
                    },
                ],
                items: [
                    "iron_ore",
                    "iron_ingot",
                    "solar_sail",
                    "small_carrier_rocket",
                ]
                .into_iter()
                .map(|id| ItemDefinition {
                    id: id.to_owned(),
                    name: id.to_owned(),
                    kind: "solid".to_owned(),
                    fuel_energy_mj: 0.0,
                })
                .collect(),
                buildings: vec![BuildingDefinition {
                    id: "smelter".to_owned(),
                    kind: "machine".to_owned(),
                    speed: 1.0,
                    input_capacity: 100.0,
                    output_capacity: 100.0,
                    power_demand_kw: 0.0,
                    power_generation_kw: 0.0,
                    power_charge_kw: 0.0,
                    energy_capacity_mj: 0.0,
                    fuel_item_ids: Vec::new(),
                    fuel_efficiency: 1.0,
                    family: None,
                    accepts: None,
                }],
                recipes: vec![RecipeDefinition {
                    id: "smelt_iron".to_owned(),
                    name: "Smelt iron".to_owned(),
                    building_id: "smelter".to_owned(),
                    duration: 1.0,
                    required_tech_id: None,
                    recursive_priority: 0.0,
                    recursive_manufacturing: false,
                    inputs: vec![ItemAmount {
                        item_id: "iron_ore".to_owned(),
                        amount: 1.0,
                    }],
                    outputs: vec![ItemAmount {
                        item_id: "iron_ingot".to_owned(),
                        amount: 1.0,
                    }],
                }],
                constructions: Vec::new(),
                belts: vec![BeltDefinition {
                    tier: 1,
                    speed: 6.0,
                }],
                proliferators: Vec::new(),
                technologies: vec![TechnologyDefinition {
                    id: "smelting".to_owned(),
                    name: "Smelting".to_owned(),
                    costs: vec![ItemAmount {
                        item_id: "iron_ingot".to_owned(),
                        amount: 1.0,
                    }],
                    prerequisites: Vec::new(),
                    construction_rewards: Vec::new(),
                }],
            },
            "recipe-workspace-test",
        )
        .unwrap()
    }

    fn state() -> CoreState {
        let profile = |planet_id: &str| {
            json!({
                "planetId": planet_id,
                "climateName": "Temperate",
                "resourceIds": ["iron_ore"],
                "rareResourceIds": [],
                "oceanType": "water",
                "orbitalYields": {},
                "windMultiplier": 1,
                "solarMultiplier": 1,
                "geothermalMultiplier": 1,
                "miningMultiplier": 1,
                "orbitalYieldMultiplier": 1,
                "reserveScale": 1,
                "travelTimeMultiplier": 1,
                "tidalLocked": false,
                "sulfuricOcean": false,
                "specialization": "balanced",
                "specializationName": "Balanced",
                "productionSpeedMultiplier": 1,
                "colonyCost": [],
                "surveyDurationSeconds": 0,
                "templateId": "temperate",
            })
        };
        let empty_plan = || json!({ "structurePoints": 0, "shellSails": 0, "layers": [] });
        let base = json!({
            "version": 47,
            "mode": "normal",
            "activePlanetId": "home",
            "tray": { "iron_ingot": 5 },
            "planetTrays": { "home": { "iron_ingot": 999 }, "ashen": { "iron_ingot": 7 } },
            "cargo": { "itemId": "iron_ingot", "amount": 3 },
            "recipeFocus": { "itemId": "iron_ingot", "mode": "two-level", "position": { "x": 0, "y": 0 } },
            "research": { "selectedTechId": null, "pausedTechId": null, "queuedTechIds": [], "progressByTech": {}, "completedTechIds": ["smelting"] },
            "endgame": { "infiniteResearch": { "stellar_harnessing": { "level": 0, "progress": "0" } } },
            "metrics": { "generationKw": 10, "demandKw": 5, "powerFactor": 1 },
            "galaxy": {
                "profiles": { "home": profile("home"), "ashen": profile("ashen") },
                "systemProfiles": { "helios": { "starTypeName": "G", "luminosity": 1 } }
            },
            "dysonEngineering": { "launchMode": "balanced", "launchThrottle": 1, "launchEnabled": true, "orbitsBySystem": { "helios": [] } },
            "dysonPlans": { "helios": empty_plan() },
        })
        .as_object()
        .unwrap()
        .clone();
        let entities = vec![
            json!({
                "id": "smelter-home", "kind": "machine", "planetId": "home", "position": { "x": 0, "y": 0 },
                "buildingId": "smelter", "recipeId": "smelt_iron", "machineCount": 1, "minerCount": 0,
                "inputs": { "iron_ore": 4 }, "outputs": { "iron_ingot": 2 }, "progress": 0,
                "utilization": 1, "productionRate": 1
            }).to_string(),
            json!({
                "id": "smelter-ashen", "kind": "machine", "planetId": "ashen", "position": { "x": 1, "y": 1 },
                "buildingId": "smelter", "recipeId": "smelt_iron", "machineCount": 1, "minerCount": 0,
                "inputs": {}, "outputs": { "iron_ingot": 11 }, "progress": 0,
                "utilization": 1, "productionRate": 1
            }).to_string(),
        ];
        CoreState::from_public_v47_parts(
            CoreCheckpointIdentity {
                slot: "normal-main".to_owned(),
                generation: 1,
                root_hash: "a".repeat(64),
                revision: 9,
                state_version: 47,
                mode: "normal".to_owned(),
                registry_fingerprint: "recipe-workspace-test".to_owned(),
                base_primary_checksum: "12345678".to_owned(),
            },
            base,
            entities,
            Vec::new(),
            catalog(),
        )
        .unwrap()
    }

    #[test]
    fn recipe_projection_is_bounded_read_only_and_pages_location_ids() {
        let state = state();
        let before = state.summary().unwrap().canonical_sha256;
        let projection = state
            .recipe_workspace_projection(
                "recipe-workspace-test",
                &["iron_ingot".to_owned(), "iron_ore".to_owned()],
                "iron_ingot",
                Some("home"),
                0,
                1,
            )
            .unwrap();
        assert_eq!(projection["projectionType"], "recipe-workspace-v1");
        assert_eq!(projection["revision"], 9);
        assert_eq!(projection["truncated"], false);
        assert_eq!(projection["itemStocks"][0]["amount"], 28.0);
        assert_eq!(projection["itemStocks"][1]["amount"], 4.0);
        assert_eq!(projection["selectedItem"]["stock"], 28.0);
        assert_eq!(
            projection["selectedItem"]["productionLocations"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        assert_eq!(
            projection["locationPage"]["entities"],
            json!([{ "id": "smelter-home", "x": 0.0, "y": 0.0 }])
        );
        assert_eq!(projection["locationPage"]["nextCursor"], Value::Null);
        assert!(serde_json::to_vec(&projection).unwrap().len() <= MAX_PROJECTION_BYTES);
        assert_eq!(state.summary().unwrap().canonical_sha256, before);
    }

    #[test]
    fn recipe_projection_rejects_catalog_drift_and_unbounded_selectors() {
        let state = state();
        assert!(
            state
                .recipe_workspace_projection("wrong", &[], "iron_ingot", None, 0, 0)
                .is_err()
        );
        assert!(
            state
                .recipe_workspace_projection(
                    "recipe-workspace-test",
                    &vec!["iron_ingot".to_owned(); MAX_ITEM_ROWS + 1],
                    "iron_ingot",
                    None,
                    0,
                    0,
                )
                .is_err()
        );
        assert!(
            state
                .recipe_workspace_projection(
                    "recipe-workspace-test",
                    &[],
                    "iron_ingot",
                    Some("home"),
                    0,
                    MAX_LOCATION_ROWS + 1,
                )
                .is_err()
        );
    }
}
