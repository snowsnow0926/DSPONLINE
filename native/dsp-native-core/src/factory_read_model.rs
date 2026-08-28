//! Bounded player-facing read models for the desktop thin renderer.
//!
//! The projection deliberately contains no raw table, `CoreState`, or public
//! v47 envelope. It is reconstructed from the already-owned native state and
//! can therefore replace renderer-side full-state reads one surface at a time.

use std::collections::HashSet;

use anyhow::{anyhow, bail};
use serde_json::{Map, Value, json};

use crate::state::CoreState;

const READ_MODEL_SCHEMA: &str = "factory-read-model-v1";
const MAX_PROJECTION_BYTES: usize = 1_048_576;
const MAX_OPAQUE_ID_BYTES: usize = 512;
const MAX_SELECTED_ENTITIES: usize = 64;
const MAX_SELECTED_BELTS: usize = 64;
const MAX_PLANET_ROWS: usize = 64;
const MAX_ITEM_ROWS: usize = 32;
const MAX_QUEUE_ROWS: usize = 64;
const MAX_RESERVATION_ROWS: usize = 32;
const MAX_TARGET_ROWS: usize = 128;
const MAX_JOB_ROWS: usize = 64;

fn valid_opaque_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= MAX_OPAQUE_ID_BYTES && !value.contains('\0')
}

fn finite_number(value: Option<&Value>) -> f64 {
    value
        .and_then(Value::as_f64)
        .filter(|number| number.is_finite())
        .unwrap_or(0.0)
}

fn optional_string(value: Option<&Value>) -> Value {
    value
        .and_then(Value::as_str)
        .map_or(Value::Null, |value| Value::from(value.to_owned()))
}

fn rows_model(rows: Vec<Value>, total_count: usize, limit: usize) -> Value {
    let truncated = total_count > limit;
    json!({
        "rows": rows.into_iter().take(limit).collect::<Vec<_>>(),
        "totalCount": total_count,
        "truncated": truncated,
    })
}

fn numeric_rows(value: Option<&Value>, limit: usize, id_key: &str) -> Value {
    let mut entries = value
        .and_then(Value::as_object)
        .into_iter()
        .flat_map(Map::iter)
        .filter_map(|(item_id, amount)| {
            let amount = amount.as_f64()?;
            (amount.is_finite() && valid_opaque_id(item_id)).then_some((item_id, amount))
        })
        .collect::<Vec<_>>();
    entries.sort_unstable_by(|left, right| left.0.cmp(right.0));
    let total_count = entries.len();
    let rows = entries
        .into_iter()
        .take(limit)
        .map(|(id, amount)| {
            let mut row = Map::new();
            row.insert(id_key.to_owned(), Value::from(id.to_owned()));
            row.insert("amount".to_owned(), Value::from(amount));
            Value::Object(row)
        })
        .collect::<Vec<_>>();
    rows_model(rows, total_count, limit)
}

fn position(value: Option<&Value>) -> Value {
    let object = value.and_then(Value::as_object);
    json!({
        "x": finite_number(object.and_then(|value| value.get("x"))),
        "y": finite_number(object.and_then(|value| value.get("y"))),
    })
}

fn selected_entity_row(value: Value) -> anyhow::Result<Value> {
    let object = value
        .as_object()
        .ok_or_else(|| anyhow!("native factory read-model entity is not an object"))?;
    let entity_id = object
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| valid_opaque_id(id))
        .ok_or_else(|| anyhow!("native factory read-model entity ID is invalid"))?;
    let planet_id = object
        .get("planetId")
        .and_then(Value::as_str)
        .filter(|id| valid_opaque_id(id))
        .ok_or_else(|| anyhow!("native factory read-model entity planet is invalid"))?;
    let kind = object
        .get("kind")
        .and_then(Value::as_str)
        .filter(|id| valid_opaque_id(id))
        .unwrap_or("unknown");
    Ok(json!({
        "entityId": entity_id,
        "planetId": planet_id,
        "kind": kind,
        "position": position(object.get("position")),
        "interactionLocked": object.get("interactionLocked").and_then(Value::as_bool).unwrap_or(false),
        "buildingId": optional_string(object.get("buildingId")),
        "resourceId": optional_string(object.get("resourceId")),
        "recipeId": optional_string(object.get("recipeId")),
        "storedItemId": optional_string(object.get("storedItemId")),
        "fuelItemId": optional_string(object.get("fuelItemId")),
        "machineCount": finite_number(object.get("machineCount")),
        "minerCount": finite_number(object.get("minerCount")),
        "progress": finite_number(object.get("progress")),
        "utilization": finite_number(object.get("utilization")),
        "productionRate": finite_number(object.get("productionRate")),
        "powerFactor": object.get("powerFactor").and_then(Value::as_f64).filter(|value| value.is_finite()),
        "inputItems": numeric_rows(object.get("inputs"), MAX_ITEM_ROWS, "itemId"),
        "outputItems": numeric_rows(object.get("outputs"), MAX_ITEM_ROWS, "itemId"),
    }))
}

fn selected_belt_row(value: Value) -> anyhow::Result<Value> {
    let object = value
        .as_object()
        .ok_or_else(|| anyhow!("native factory read-model belt is not an object"))?;
    let required_id = |key: &str| {
        object
            .get(key)
            .and_then(Value::as_str)
            .filter(|id| valid_opaque_id(id))
            .ok_or_else(|| anyhow!("native factory read-model belt {key} is invalid"))
    };
    Ok(json!({
        "beltId": required_id("id")?,
        "planetId": required_id("planetId")?,
        "sourceEntityId": required_id("source")?,
        "targetEntityId": required_id("target")?,
        "itemId": required_id("itemId")?,
        "lanes": finite_number(object.get("lanes")),
        "tier": finite_number(object.get("tier")),
        "sorterTier": finite_number(object.get("sorterTier")),
        "stackSize": object.get("stackSize").and_then(Value::as_f64).filter(|value| value.is_finite()),
        "priority": finite_number(object.get("priority")),
        "progress": finite_number(object.get("progress")),
        "lastFlow": finite_number(object.get("lastFlow")),
        "totalTransferred": object.get("totalTransferred").and_then(Value::as_f64).filter(|value| value.is_finite()),
        "congestion": object.get("congestion").and_then(Value::as_f64).filter(|value| value.is_finite()),
    }))
}

fn unique_ids(values: &[String], maximum: usize) -> anyhow::Result<Vec<&str>> {
    if values.len() > maximum || values.iter().any(|id| !valid_opaque_id(id)) {
        bail!("native factory read-model selection is invalid");
    }
    let mut seen = HashSet::new();
    Ok(values
        .iter()
        .map(String::as_str)
        .filter(|id| seen.insert(*id))
        .collect())
}

fn construction_queue(base: &Map<String, Value>) -> Value {
    let source = base
        .get("constructionQueue")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    let mut rows = source
        .iter()
        .filter_map(Value::as_object)
        .filter_map(|entry| {
            let queue_id = entry.get("id")?.as_str()?.to_owned();
            let blueprint_id = entry.get("blueprintId")?.as_str()?.to_owned();
            let planet_id = entry.get("planetId")?.as_str()?.to_owned();
            (valid_opaque_id(&queue_id)
                && valid_opaque_id(&blueprint_id)
                && valid_opaque_id(&planet_id))
                .then(|| {
                    let queued_at = finite_number(entry.get("queuedAt"));
                    let placed_entity_count = entry
                        .get("placedEntityIdsByKey")
                        .and_then(Value::as_object)
                        .map_or(0, Map::len);
                    let row = json!({
                        "queueId": queue_id,
                        "blueprintId": blueprint_id,
                        "blueprintVersionId": optional_string(entry.get("blueprintVersionId")),
                        "blueprintRevision": entry.get("blueprintRevision").and_then(Value::as_f64).filter(|value| value.is_finite()),
                        "blueprintName": entry.get("blueprintName").and_then(Value::as_str).unwrap_or(""),
                        "planetId": planet_id,
                        "queuedAt": queued_at,
                        "status": if entry.get("status").and_then(Value::as_str) == Some("waiting-fleet") { "waiting-fleet" } else { "pending-materials" },
                        "rotation": finite_number(entry.get("rotation")),
                        "mirror": entry.get("mirror").and_then(Value::as_str).unwrap_or("none"),
                        "placedEntityCount": placed_entity_count,
                        "reservedConstruction": numeric_rows(entry.get("reservedConstruction"), MAX_RESERVATION_ROWS, "constructionId"),
                        "reservedFleet": numeric_rows(entry.get("reservedFleet"), MAX_RESERVATION_ROWS, "itemId"),
                    });
                    (queued_at, row)
                })
        })
        .collect::<Vec<_>>();
    rows.sort_by(|left, right| {
        left.0
            .total_cmp(&right.0)
            .then_with(|| left.1["queueId"].as_str().cmp(&right.1["queueId"].as_str()))
    });
    let total_count = rows.len();
    rows_model(
        rows.into_iter().map(|(_, row)| row).collect(),
        total_count,
        MAX_QUEUE_ROWS,
    )
}

fn construction_jobs(automation: Option<&Map<String, Value>>) -> Value {
    let mut entries = automation
        .and_then(|value| value.get("jobs"))
        .and_then(Value::as_object)
        .into_iter()
        .flat_map(Map::iter)
        .filter(|(entity_id, _)| valid_opaque_id(entity_id))
        .collect::<Vec<_>>();
    entries.sort_unstable_by(|left, right| left.0.cmp(right.0));
    let total_count = entries.len();
    let rows = entries
        .into_iter()
        .take(MAX_JOB_ROWS)
        .filter_map(|(entity_id, value)| {
            let job = value.as_object()?;
            Some(json!({
                "entityId": entity_id,
                "constructionId": job.get("constructionId").and_then(Value::as_str).unwrap_or(""),
                "stepIndex": finite_number(job.get("stepIndex")),
                "stepCount": job.get("steps").and_then(Value::as_array).map_or(0, Vec::len),
                "elapsedSeconds": finite_number(job.get("elapsedSeconds")),
                "inventory": numeric_rows(job.get("inventory"), MAX_ITEM_ROWS, "itemId"),
            }))
        })
        .collect::<Vec<_>>();
    rows_model(rows, total_count, MAX_JOB_ROWS)
}

impl CoreState {
    /// Produces the complete bounded shell/selection/construction contract
    /// needed by a thin desktop renderer. The result is read-only and bound to
    /// the current native revision; public save schemas are unaffected.
    pub fn factory_read_model_projection(
        &self,
        selected_entity_ids: &[String],
        selected_belt_ids: &[String],
    ) -> anyhow::Result<Value> {
        let entity_ids = unique_ids(selected_entity_ids, MAX_SELECTED_ENTITIES)?;
        let belt_ids = unique_ids(selected_belt_ids, MAX_SELECTED_BELTS)?;
        let base = self.base_value();
        let active_planet_id = base
            .get("activePlanetId")
            .and_then(Value::as_str)
            .filter(|id| valid_opaque_id(id))
            .ok_or_else(|| anyhow!("native factory read-model active planet is invalid"))?;
        let active_planet_index = self
            .catalog
            .planets
            .iter()
            .position(|planet| planet.id == active_planet_id)
            .ok_or_else(|| anyhow!("native factory read-model active planet is missing"))?;
        let queue_count = base
            .get("constructionQueue")
            .and_then(Value::as_array)
            .map_or(0, Vec::len);
        let settings = base.get("settings").and_then(Value::as_object);
        let mode = base.get("mode").and_then(Value::as_str).unwrap_or("normal");
        if !matches!(mode, "normal" | "speedrun") {
            bail!("native factory read-model mode is invalid");
        }
        let shell = json!({
            "schema": READ_MODEL_SCHEMA,
            "source": "native-core",
            "stateVersion": self.identity.state_version,
            "mode": mode,
            "activePlanetId": active_planet_id,
            "paused": base.get("paused").and_then(Value::as_bool).unwrap_or(false),
            "elapsedSeconds": finite_number(base.get("elapsedSeconds")),
            "simulationSpeed": finite_number(settings.and_then(|value| value.get("simulationSpeed"))).max(1.0),
            "entityCount": self.entities.ids.len(),
            "beltCount": self.belts.ids.len(),
            "activePlanetEntityCount": self.factory_topology.entities_by_planet[active_planet_index].len(),
            "activePlanetBeltCount": self.factory_topology.belts_by_planet[active_planet_index].len(),
            "constructionQueueCount": queue_count,
        });

        let exploration = base.get("exploration").and_then(Value::as_object);
        let unlocked_systems = exploration
            .and_then(|value| value.get("unlockedSystemIds"))
            .and_then(Value::as_array)
            .into_iter()
            .flat_map(|values| values.iter())
            .filter_map(Value::as_str)
            .collect::<HashSet<_>>();
        let colonized_planets = exploration
            .and_then(|value| value.get("colonizedPlanetIds"))
            .and_then(Value::as_array)
            .into_iter()
            .flat_map(|values| values.iter())
            .filter_map(Value::as_str)
            .collect::<HashSet<_>>();
        let galaxy = base.get("galaxy").and_then(Value::as_object);
        let metadata = galaxy
            .and_then(|value| value.get("planetMetadata"))
            .and_then(Value::as_object);
        let roles = galaxy
            .and_then(|value| value.get("planetRoles"))
            .and_then(Value::as_object);
        let mut planets = self.catalog.planets.iter().enumerate().collect::<Vec<_>>();
        planets.sort_by(|left, right| {
            left.1
                .simulation_order
                .cmp(&right.1.simulation_order)
                .then_with(|| left.1.id.cmp(&right.1.id))
        });
        let planet_total = planets.len();
        let planet_rows = planets
            .into_iter()
            .take(MAX_PLANET_ROWS)
            .map(|(index, planet)| {
                let custom_name = metadata
                    .and_then(|value| value.get(&planet.id))
                    .and_then(Value::as_object)
                    .and_then(|value| value.get("customName"))
                    .and_then(Value::as_str)
                    .filter(|value| !value.is_empty());
                let queue_for_planet = base
                    .get("constructionQueue")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flat_map(|values| values.iter())
                    .filter(|entry| entry.get("planetId").and_then(Value::as_str) == Some(&planet.id))
                    .count();
                json!({
                    "planetId": planet.id,
                    "systemId": planet.system_id,
                    "displayName": custom_name.unwrap_or(if planet.name.is_empty() { &planet.id } else { &planet.name }),
                    // The catalog protocol has no display-code field yet. ID
                    // is an explicit bounded fallback, never a full-state read.
                    "code": planet.id,
                    "active": planet.id == active_planet_id,
                    "discovered": planet.id == active_planet_id || unlocked_systems.contains(planet.system_id.as_str()),
                    "colonized": colonized_planets.contains(planet.id.as_str()),
                    "role": optional_string(roles.and_then(|value| value.get(&planet.id))),
                    "entityCount": self.factory_topology.entities_by_planet[index].len(),
                    "deviceCount": self.factory_topology.device_counts_by_planet[index],
                    "beltCount": self.factory_topology.belts_by_planet[index].len(),
                    "constructionQueueCount": queue_for_planet,
                    "powerFactor": base
                        .get("planetMetrics")
                        .and_then(Value::as_object)
                        .and_then(|value| value.get(&planet.id))
                        .and_then(Value::as_object)
                        .map(|value| finite_number(value.get("powerFactor")))
                        .unwrap_or(1.0),
                })
            })
            .collect::<Vec<_>>();
        let planet_navigation = json!({
            "schema": READ_MODEL_SCHEMA,
            "activePlanetId": active_planet_id,
            "planets": rows_model(planet_rows, planet_total, MAX_PLANET_ROWS),
        });

        let entity_rows = entity_ids
            .iter()
            .filter_map(|id| self.entity_index.get(id).copied())
            .map(|index| self.parse_entity(index).and_then(selected_entity_row))
            .collect::<anyhow::Result<Vec<_>>>()?;
        let entity_row_count = entity_rows.len();
        let belt_rows = belt_ids
            .iter()
            .filter_map(|id| self.belt_index.get(id).copied())
            .map(|index| self.parse_belt(index).and_then(selected_belt_row))
            .collect::<anyhow::Result<Vec<_>>>()?;
        let belt_row_count = belt_rows.len();
        let selection = json!({
            "schema": READ_MODEL_SCHEMA,
            "activePlanetId": active_planet_id,
            "requestedEntityCount": selected_entity_ids.len(),
            "requestedBeltCount": selected_belt_ids.len(),
            "entityRows": rows_model(entity_rows, entity_row_count, MAX_SELECTED_ENTITIES),
            "beltRows": rows_model(belt_rows, belt_row_count, MAX_SELECTED_BELTS),
        });

        let automation = base
            .get("constructionAutomation")
            .and_then(Value::as_object);
        let construction = json!({
            "schema": READ_MODEL_SCHEMA,
            "activePlanetId": active_planet_id,
            "queue": construction_queue(base),
            "automation": {
                "enabled": automation.and_then(|value| value.get("enabled")).and_then(Value::as_bool).unwrap_or(false),
                "quantumSourceEnabled": automation.and_then(|value| value.get("quantumSourceEnabled")).and_then(Value::as_bool).unwrap_or(false),
                "totalCrafted": finite_number(automation.and_then(|value| value.get("totalCrafted"))),
                "lastCraftedId": optional_string(automation.and_then(|value| value.get("lastCraftedId"))),
                "targets": numeric_rows(automation.and_then(|value| value.get("targetStock")), MAX_TARGET_ROWS, "targetId"),
                "jobs": construction_jobs(automation),
                "destroyedByproducts": numeric_rows(automation.and_then(|value| value.get("destroyedByproducts")), MAX_ITEM_ROWS, "itemId"),
            },
        });
        let result = json!({
            "schemaVersion": 1,
            "projectionType": READ_MODEL_SCHEMA,
            "revision": self.revision,
            "shell": shell,
            "planetNavigation": planet_navigation,
            "selection": selection,
            "construction": construction,
        });
        if serde_json::to_vec(&result)?.len() > MAX_PROJECTION_BYTES {
            bail!("native factory read-model projection exceeds the byte limit");
        }
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use serde_json::json;

    use super::*;
    use crate::catalog::{
        BeltDefinition, BuildingDefinition, CatalogSnapshot, ItemDefinition, PlanetDefinition,
        RuntimeCatalog,
    };
    use crate::state::CoreCheckpointIdentity;

    fn catalog() -> RuntimeCatalog {
        RuntimeCatalog::validate(
            CatalogSnapshot {
                protocol_version: 1,
                registry_fingerprint: "factory-read-model-test".to_owned(),
                planets: vec![
                    PlanetDefinition {
                        id: "home".to_owned(),
                        name: "家园".to_owned(),
                        system_id: "helios".to_owned(),
                        kind: "terrestrial".to_owned(),
                        orbit_index: 1,
                        simulation_order: 0,
                        orbital_yields: HashMap::new(),
                    },
                    PlanetDefinition {
                        id: "mod_planet".to_owned(),
                        name: "MOD 行星".to_owned(),
                        system_id: "mod_system".to_owned(),
                        kind: "terrestrial".to_owned(),
                        orbit_index: 1,
                        simulation_order: 1,
                        orbital_yields: HashMap::new(),
                    },
                ],
                items: vec![ItemDefinition {
                    id: "iron_ore".to_owned(),
                    name: "铁矿".to_owned(),
                    kind: "solid".to_owned(),
                    fuel_energy_mj: 0.0,
                }],
                buildings: vec![BuildingDefinition {
                    id: "storage".to_owned(),
                    kind: "storage".to_owned(),
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
                recipes: Vec::new(),
                constructions: Vec::new(),
                belts: vec![BeltDefinition {
                    tier: 1,
                    speed: 6.0,
                }],
                proliferators: Vec::new(),
                technologies: Vec::new(),
            },
            "factory-read-model-test",
        )
        .unwrap()
    }

    fn state() -> CoreState {
        let base = json!({
            "version": 47,
            "mode": "normal",
            "activePlanetId": "home",
            "elapsedSeconds": 123,
            "paused": false,
            "settings": { "simulationSpeed": 4 },
            "exploration": {
                "unlockedSystemIds": ["helios"],
                "colonizedPlanetIds": ["home"]
            },
            "galaxy": {
                "planetMetadata": { "home": { "customName": "测试家园" } },
                "planetRoles": { "home": "industry" }
            },
            "planetMetrics": {
                "home": { "powerFactor": 0.75 },
                "mod_planet": { "powerFactor": 1 }
            },
            "constructionQueue": [{
                "id": "queue-1",
                "blueprintId": "bp-1",
                "blueprintName": "蓝图",
                "planetId": "home",
                "queuedAt": 2,
                "rotation": 0,
                "mirror": "none",
                "placedEntityIdsByKey": { "a": "MOD-建筑" },
                "reservedConstruction": { "storage": 2 },
                "reservedFleet": { "iron_ore": 3 }
            }],
            "constructionAutomation": {
                "enabled": true,
                "quantumSourceEnabled": true,
                "totalCrafted": 7,
                "lastCraftedId": "storage",
                "targetStock": { "storage": 10 },
                "destroyedByproducts": { "iron_ore": 1 },
                "jobs": {
                    "MOD-建筑": {
                        "constructionId": "storage",
                        "stepIndex": 1,
                        "steps": [{}, {}],
                        "elapsedSeconds": 0.5,
                        "inventory": { "iron_ore": 4 }
                    }
                }
            }
        })
        .as_object()
        .unwrap()
        .clone();
        let entities = vec![
            json!({
                "id": "MOD-建筑",
                "kind": "storage",
                "planetId": "home",
                "position": { "x": 5, "y": 6 },
                "interactionLocked": false,
                "buildingId": "storage",
                "machineCount": 1,
                "minerCount": 0,
                "inputs": { "iron_ore": 4 },
                "outputs": {},
                "progress": 0,
                "utilization": 0.5,
                "productionRate": 1
            })
            .to_string(),
            json!({
                "id": "sink",
                "kind": "storage",
                "planetId": "home",
                "position": { "x": 8, "y": 9 },
                "buildingId": "storage",
                "machineCount": 1,
                "minerCount": 0,
                "inputs": {},
                "outputs": {},
                "progress": 0,
                "utilization": 0,
                "productionRate": 0
            })
            .to_string(),
        ];
        let belts = vec![
            json!({
                "id": "MOD-线路",
                "planetId": "home",
                "source": "MOD-建筑",
                "target": "sink",
                "itemId": "iron_ore",
                "lanes": 1,
                "tier": 1,
                "sorterTier": 1,
                "priority": 1,
                "progress": 0,
                "lastFlow": 2
            })
            .to_string(),
        ];
        CoreState::from_public_v47_parts(
            CoreCheckpointIdentity {
                slot: "normal-main".to_owned(),
                generation: 1,
                root_hash: "a".repeat(64),
                revision: 7,
                state_version: 47,
                mode: "normal".to_owned(),
                registry_fingerprint: "factory-read-model-test".to_owned(),
                base_primary_checksum: "12345678".to_owned(),
            },
            base,
            entities,
            belts,
            catalog(),
        )
        .unwrap()
    }

    #[test]
    fn complete_factory_projection_is_bounded_revision_bound_and_mod_safe() {
        let state = state();
        let before = state.summary().unwrap().canonical_sha256;
        let projection = state
            .factory_read_model_projection(
                &["MOD-建筑".to_owned(), "missing".to_owned()],
                &["MOD-线路".to_owned()],
            )
            .unwrap();
        assert_eq!(projection["projectionType"], READ_MODEL_SCHEMA);
        assert_eq!(projection["revision"], 7);
        assert_eq!(projection["shell"]["source"], "native-core");
        assert_eq!(projection["shell"]["entityCount"], 2);
        assert_eq!(projection["shell"]["beltCount"], 1);
        assert_eq!(
            projection["planetNavigation"]["planets"]["rows"][0]["displayName"],
            "测试家园"
        );
        assert_eq!(
            projection["planetNavigation"]["planets"]["rows"][0]["deviceCount"],
            2.0
        );
        assert_eq!(
            projection["planetNavigation"]["planets"]["rows"][0]["powerFactor"],
            0.75
        );
        assert_eq!(projection["selection"]["requestedEntityCount"], 2);
        assert_eq!(projection["selection"]["entityRows"]["totalCount"], 1);
        assert_eq!(
            projection["selection"]["entityRows"]["rows"][0]["entityId"],
            "MOD-建筑"
        );
        assert_eq!(
            projection["selection"]["beltRows"]["rows"][0]["beltId"],
            "MOD-线路"
        );
        assert_eq!(projection["construction"]["queue"]["totalCount"], 1);
        assert_eq!(
            projection["construction"]["automation"]["jobs"]["rows"][0]["entityId"],
            "MOD-建筑"
        );
        assert!(serde_json::to_vec(&projection).unwrap().len() <= MAX_PROJECTION_BYTES);
        assert_eq!(state.summary().unwrap().canonical_sha256, before);
    }

    #[test]
    fn factory_projection_rejects_unbounded_or_invalid_selectors_without_mutation() {
        let state = state();
        let before = state.summary().unwrap().canonical_sha256;
        assert!(
            state
                .factory_read_model_projection(
                    &vec!["entity".to_owned(); MAX_SELECTED_ENTITIES + 1],
                    &[],
                )
                .is_err()
        );
        assert!(
            state
                .factory_read_model_projection(&["bad\0id".to_owned()], &[])
                .is_err()
        );
        assert_eq!(state.summary().unwrap().canonical_sha256, before);
    }
}
