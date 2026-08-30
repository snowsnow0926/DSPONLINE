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
const PLAYER_STATION_SLOT_COUNT: usize = 5;
const MAX_STATION_ITEM_OPTIONS: usize = 128;
const MAX_STATION_ITEM_LABEL_BYTES: usize = 256;
const MAX_PLAYER_STATION_STOCK: u64 = 100_000_000;
const MAX_JAVASCRIPT_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT: &str = "7df8cf3a";

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

fn required_safe_integer(value: Option<&Value>, label: &str, maximum: u64) -> anyhow::Result<u64> {
    value
        .and_then(Value::as_u64)
        .filter(|value| *value <= maximum)
        .ok_or_else(|| anyhow!("native factory read-model {label} is invalid"))
}

fn required_station_mode<'a>(value: Option<&'a Value>, label: &str) -> anyhow::Result<&'a str> {
    value
        .and_then(Value::as_str)
        .filter(|mode| matches!(*mode, "supply" | "demand" | "storage"))
        .ok_or_else(|| anyhow!("native factory read-model {label} is invalid"))
}

fn required_station_minimum_load(value: Option<&Value>, label: &str) -> anyhow::Result<f64> {
    value
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite() && matches!(*value, 0.1 | 0.25 | 0.5 | 1.0))
        .ok_or_else(|| anyhow!("native factory read-model {label} is invalid"))
}

fn station_accepts_item(accepts: &str, item_kind: &str) -> bool {
    accepts == "any" || accepts == item_kind || (accepts == "solid" && item_kind == "matrix")
}

fn station_item_options(state: &CoreState, accepts: &str) -> anyhow::Result<Value> {
    let mut items = state
        .catalog
        .snapshot
        .items
        .iter()
        .filter(|item| station_accepts_item(accepts, &item.kind))
        .collect::<Vec<_>>();
    items.sort_unstable_by(|left, right| left.id.cmp(&right.id));
    let total_count = items.len();
    let rows = items
        .into_iter()
        .take(MAX_STATION_ITEM_OPTIONS)
        .map(|item| {
            let label = if item.name.is_empty() {
                item.id.as_str()
            } else {
                item.name.as_str()
            };
            if label.len() > MAX_STATION_ITEM_LABEL_BYTES || label.contains('\0') {
                bail!("native factory read-model station item label is invalid")
            }
            Ok(json!({
                "itemId": item.id,
                "name": label,
                "kind": item.kind,
            }))
        })
        .collect::<anyhow::Result<Vec<_>>>()?;
    Ok(json!({
        "rows": rows,
        "totalCount": total_count,
        "truncated": total_count > MAX_STATION_ITEM_OPTIONS,
        "limit": MAX_STATION_ITEM_OPTIONS,
    }))
}

fn station_configuration_with_scope(
    state: &CoreState,
    entity: &Map<String, Value>,
    require_active_planet: bool,
) -> anyhow::Result<Value> {
    if state.identity.registry_fingerprint != EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT
        || state.catalog.snapshot.registry_fingerprint != EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT
    {
        return Ok(Value::Null);
    }
    let Some(building_id) = entity.get("buildingId").and_then(Value::as_str) else {
        return Ok(Value::Null);
    };
    let interstellar = match building_id {
        "planetary_logistics_station" => false,
        "interstellar_logistics_station" => true,
        _ => return Ok(Value::Null),
    };
    if require_active_planet {
        let active_planet_id = state
            .base_value()
            .get("activePlanetId")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow!("native factory read-model active planet is invalid"))?;
        if entity.get("planetId").and_then(Value::as_str) != Some(active_planet_id) {
            return Ok(Value::Null);
        }
    }
    let building = state
        .catalog
        .buildings
        .get(building_id)
        .filter(|building| building.kind == "station")
        .ok_or_else(|| anyhow!("native factory read-model built-in station identity is invalid"))?;
    if entity.get("kind").and_then(Value::as_str) != Some("station")
        || !entity
            .get("interactionLocked")
            .is_some_and(Value::is_boolean)
    {
        bail!("native factory read-model built-in station identity is invalid");
    }
    let accepts = building.accepts.as_deref().unwrap_or("any");
    let slots = entity
        .get("stationSlots")
        .and_then(Value::as_array)
        .filter(|slots| slots.len() == PLAYER_STATION_SLOT_COUNT)
        .ok_or_else(|| anyhow!("native factory read-model station must have exactly five slots"))?;
    let mut configured_item_ids = HashSet::new();
    let mut primary = None::<(String, String, String, f64)>;
    let mut projected_slots = Vec::with_capacity(PLAYER_STATION_SLOT_COUNT);
    for (slot_index, value) in slots.iter().enumerate() {
        let slot = value
            .as_object()
            .ok_or_else(|| anyhow!("native factory read-model station slot is invalid"))?;
        let item_id = match slot.get("itemId") {
            None | Some(Value::Null) => None,
            Some(Value::String(item_id)) if valid_opaque_id(item_id) => {
                let item = state
                    .catalog
                    .items
                    .get(item_id)
                    .filter(|item| station_accepts_item(accepts, &item.kind))
                    .ok_or_else(|| {
                        anyhow!("native factory read-model station slot item is incompatible")
                    })?;
                if !configured_item_ids.insert(item_id.as_str()) {
                    bail!("native factory read-model station slot item is repeated");
                }
                debug_assert_eq!(item.id, *item_id);
                Some(item_id.clone())
            }
            _ => bail!("native factory read-model station slot item is invalid"),
        };
        let local_mode = required_station_mode(slot.get("localMode"), "station local mode")?;
        let remote_mode = required_station_mode(slot.get("remoteMode"), "station remote mode")?;
        let minimum_load =
            required_station_minimum_load(slot.get("minimumLoad"), "station minimum load")?;
        let min_stock = required_safe_integer(
            slot.get("minStock"),
            "station stock limit pair minimum",
            MAX_PLAYER_STATION_STOCK,
        )?;
        let max_stock = required_safe_integer(
            slot.get("maxStock"),
            "station stock limit pair maximum",
            MAX_PLAYER_STATION_STOCK,
        )?;
        if max_stock > 0 && min_stock > max_stock {
            bail!("native factory read-model station stock limits are inconsistent");
        }
        let priority = required_safe_integer(slot.get("priority"), "station priority", 2)?;
        let route_policy = slot
            .get("routePolicy")
            .and_then(Value::as_str)
            .filter(|policy| matches!(*policy, "direct" | "relay-preferred" | "relay-required"))
            .ok_or_else(|| anyhow!("native factory read-model station route policy is invalid"))?;
        let warper_budget =
            required_safe_integer(slot.get("warperBudget"), "station warper budget", 4)?;
        if !(1..=4).contains(&warper_budget) {
            bail!("native factory read-model station warper budget is invalid");
        }
        if primary.is_none()
            && let Some(item_id) = item_id.as_ref()
        {
            primary = Some((
                item_id.clone(),
                local_mode.to_owned(),
                remote_mode.to_owned(),
                minimum_load,
            ));
        }
        let mut projected = json!({
            "slotIndex": slot_index,
            "itemId": item_id,
            "localMode": local_mode,
            "remoteMode": remote_mode,
            "minimumLoad": minimum_load,
            "minStock": min_stock,
            "maxStock": max_stock,
            "priority": priority,
        });
        if interstellar {
            projected["routePolicy"] = Value::from(route_policy);
            projected["warperBudget"] = Value::from(warper_budget);
        }
        projected_slots.push(projected);
    }
    if let Some((item_id, local_mode, remote_mode, minimum_load)) = primary {
        if entity.get("storedItemId").and_then(Value::as_str) != Some(item_id.as_str()) {
            bail!("native factory read-model station primary item mirror is inconsistent");
        }
        let expected_mode = if (!interstellar && local_mode == "demand")
            || (interstellar && remote_mode == "demand")
        {
            "demand"
        } else {
            "supply"
        };
        if entity.get("stationMode").and_then(Value::as_str) != Some(expected_mode)
            || required_station_minimum_load(
                entity.get("stationMinimumLoad"),
                "station legacy minimum load",
            )? != minimum_load
        {
            bail!("native factory read-model station legacy mirrors are inconsistent");
        }
    } else if entity
        .get("storedItemId")
        .is_some_and(|value| !value.is_null())
    {
        bail!("native factory read-model empty station has a stored-item mirror");
    }
    let machine_count = required_safe_integer(
        entity.get("machineCount"),
        "station stack",
        MAX_JAVASCRIPT_SAFE_INTEGER,
    )?;
    let drone_capacity = machine_count
        .checked_mul(50)
        .filter(|value| *value <= MAX_JAVASCRIPT_SAFE_INTEGER)
        .ok_or_else(|| anyhow!("native factory read-model station drone capacity overflows"))?;
    let station_drones = required_safe_integer(
        entity.get("stationDrones"),
        "station drones",
        drone_capacity,
    )?;
    let mut result = json!({
        "schema": "station-configuration-v1",
        "registryFingerprint": EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT,
        "stationType": if interstellar { "interstellar" } else { "planetary" },
        "itemOptions": station_item_options(state, accepts)?,
        "stationDrones": station_drones,
        "stationVessels": Value::Null,
        "stationWarpers": Value::Null,
        "slots": projected_slots,
        "spaceWarpUnlocked": false,
        "stationWarpEnabled": Value::Null,
        "stationWarperAutoRefill": Value::Null,
        "stationWarperTarget": Value::Null,
        "stationHubEnabled": Value::Null,
        "stationHubPriority": Value::Null,
    });
    if interstellar {
        let vessel_capacity = machine_count
            .checked_mul(10)
            .filter(|value| *value <= MAX_JAVASCRIPT_SAFE_INTEGER)
            .ok_or_else(|| {
                anyhow!("native factory read-model station vessel capacity overflows")
            })?;
        let warper_capacity = machine_count
            .checked_mul(50)
            .filter(|value| *value <= MAX_JAVASCRIPT_SAFE_INTEGER && *value > 0)
            .ok_or_else(|| {
                anyhow!("native factory read-model station warper capacity is invalid")
            })?;
        result["stationVessels"] = Value::from(required_safe_integer(
            entity.get("stationVessels"),
            "station vessels",
            vessel_capacity,
        )?);
        result["stationWarpers"] = Value::from(required_safe_integer(
            entity.get("stationWarpers"),
            "station warpers",
            warper_capacity,
        )?);
        result["stationWarpEnabled"] = Value::from(
            entity
                .get("stationWarpEnabled")
                .and_then(Value::as_bool)
                .ok_or_else(|| {
                    anyhow!("native factory read-model station warp toggle is invalid")
                })?,
        );
        result["stationWarperAutoRefill"] = Value::from(
            entity
                .get("stationWarperAutoRefill")
                .and_then(Value::as_bool)
                .ok_or_else(|| {
                    anyhow!("native factory read-model station auto refill is invalid")
                })?,
        );
        let warper_target = required_safe_integer(
            entity.get("stationWarperTarget"),
            "station warper target",
            warper_capacity,
        )?;
        if warper_target == 0 {
            bail!("native factory read-model station warper target is invalid");
        }
        result["stationWarperTarget"] = Value::from(warper_target);
        result["stationHubEnabled"] = Value::from(
            entity
                .get("stationHubEnabled")
                .and_then(Value::as_bool)
                .ok_or_else(|| {
                    anyhow!("native factory read-model station hub toggle is invalid")
                })?,
        );
        result["stationHubPriority"] = Value::from(required_safe_integer(
            entity.get("stationHubPriority"),
            "current station hub priority",
            2,
        )?);
        result["spaceWarpUnlocked"] = Value::from(
            state
                .base_value()
                .get("research")
                .and_then(Value::as_object)
                .and_then(|research| research.get("completedTechIds"))
                .and_then(Value::as_array)
                .is_some_and(|rows| rows.iter().any(|row| row.as_str() == Some("space_warp"))),
        );
    }
    Ok(result)
}

pub(crate) fn station_configuration(
    state: &CoreState,
    entity: &Map<String, Value>,
) -> anyhow::Result<Value> {
    station_configuration_with_scope(state, entity, true)
}

pub(crate) fn validate_station_configuration_for_command(
    state: &CoreState,
    entity: &Map<String, Value>,
) -> anyhow::Result<()> {
    if station_configuration_with_scope(state, entity, false)?.is_null() {
        bail!("native player-authority station target is foreign or malformed")
    }
    Ok(())
}

fn selected_entity_row(state: &CoreState, value: Value) -> anyhow::Result<Value> {
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
    let station_configuration = station_configuration(state, object)?;
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
        "stationConfiguration": station_configuration,
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
        let time_warp = base.get("timeWarp").and_then(Value::as_object);
        let controller_entity_id = time_warp
            .and_then(|value| value.get("controllerEntityId"))
            .and_then(Value::as_str)
            .filter(|id| valid_opaque_id(id))
            .map_or(Value::Null, |id| Value::from(id.to_owned()));
        let simulation_speed =
            finite_number(settings.and_then(|value| value.get("simulationSpeed"))).max(1.0);
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
            "simulationSpeed": simulation_speed,
            "timeWarp": {
                "controllerEntityId": controller_entity_id,
                "enabled": time_warp
                    .and_then(|value| value.get("enabled"))
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                "requestedMultiplier": finite_number(
                    time_warp.and_then(|value| value.get("requestedMultiplier")),
                ).max(simulation_speed),
                "effectiveMultiplier": finite_number(
                    time_warp.and_then(|value| value.get("effectiveMultiplier")),
                ).max(simulation_speed),
                "requiredPowerKw": finite_number(
                    time_warp.and_then(|value| value.get("requiredPowerKw")),
                ).max(0.0),
                "allocatedPowerKw": finite_number(
                    time_warp.and_then(|value| value.get("allocatedPowerKw")),
                ).max(0.0),
            },
            "entityCount": self.entities.ids.len(),
            "beltCount": self.belts.ids.len(),
            "activePlanetEntityCount": self.factory_topology.entities_by_planet[active_planet_index].len(),
            "activePlanetBeltCount": self.factory_topology.belt_counts_by_planet[active_planet_index],
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
                    "beltCount": self.factory_topology.belt_counts_by_planet[index],
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
            .map(|index| {
                self.parse_entity(index)
                    .and_then(|entity| selected_entity_row(self, entity))
            })
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

    fn station_catalog(registry_fingerprint: &str) -> RuntimeCatalog {
        let mut snapshot = catalog().snapshot;
        snapshot.registry_fingerprint = registry_fingerprint.to_owned();
        snapshot.buildings.extend([
            BuildingDefinition {
                id: "planetary_logistics_station".to_owned(),
                kind: "station".to_owned(),
                speed: 1.0,
                input_capacity: 100_000_000.0,
                output_capacity: 100_000_000.0,
                power_demand_kw: 0.0,
                power_generation_kw: 0.0,
                power_charge_kw: 0.0,
                energy_capacity_mj: 0.0,
                fuel_item_ids: Vec::new(),
                fuel_efficiency: 1.0,
                family: None,
                accepts: None,
            },
            BuildingDefinition {
                id: "interstellar_logistics_station".to_owned(),
                kind: "station".to_owned(),
                speed: 1.0,
                input_capacity: 100_000_000.0,
                output_capacity: 100_000_000.0,
                power_demand_kw: 0.0,
                power_generation_kw: 0.0,
                power_charge_kw: 0.0,
                energy_capacity_mj: 0.0,
                fuel_item_ids: Vec::new(),
                fuel_efficiency: 1.0,
                family: None,
                accepts: None,
            },
        ]);
        RuntimeCatalog::validate(snapshot, registry_fingerprint).unwrap()
    }

    fn station_slots(primary_slot_index: usize, interstellar: bool) -> Value {
        Value::Array(
            (0..PLAYER_STATION_SLOT_COUNT)
                .map(|slot_index| {
                    let configured = slot_index == primary_slot_index;
                    json!({
                        "itemId": configured.then_some("iron_ore"),
                        "localMode": if configured { "demand" } else { "storage" },
                        "remoteMode": if configured && interstellar { "demand" } else { "storage" },
                        "minimumLoad": if configured { 0.25 } else { 1.0 },
                        "minStock": if configured { 25 } else { 0 },
                        "maxStock": if configured { 100 } else { 0 },
                        "priority": if configured { 2 } else { 1 },
                        "routePolicy": if configured { "relay-required" } else { "relay-preferred" },
                        "warperBudget": if configured { 4 } else { 2 },
                    })
                })
                .collect(),
        )
    }

    fn station_state(registry_fingerprint: &str) -> CoreState {
        let base = json!({
            "version": 47,
            "mode": "normal",
            "activePlanetId": "home",
            "elapsedSeconds": 0,
            "paused": false,
            "settings": { "simulationSpeed": 1 },
            "research": { "completedTechIds": ["space_warp"] },
            "constructionQueue": [],
        })
        .as_object()
        .unwrap()
        .clone();
        let station = |id: &str, building_id: &str, primary_slot_index, interstellar| {
            json!({
                "id": id,
                "kind": "station",
                "planetId": "home",
                "position": { "x": primary_slot_index, "y": 0 },
                "interactionLocked": false,
                "buildingId": building_id,
                "machineCount": 2,
                "minerCount": 0,
                "inputs": { "iron_ore": 777 },
                "outputs": { "iron_ore": 888 },
                "progress": 0,
                "utilization": 0,
                "productionRate": 0,
                "stationSlots": station_slots(primary_slot_index, interstellar),
                "storedItemId": "iron_ore",
                "stationMode": "demand",
                "stationMinimumLoad": 0.25,
                "stationDrones": 12,
                "stationVessels": 3,
                "stationWarpers": 7,
                "stationWarpEnabled": true,
                "stationWarperAutoRefill": true,
                "stationWarperTarget": 75,
                "stationHubEnabled": true,
                "stationHubPriority": 2,
                "stationRoutes": [{
                    "id": "must-never-cross-ipc",
                    "cargo": 456,
                    "modPayload": { "secret": "opaque" }
                }],
            })
            .to_string()
        };
        CoreState::from_public_v47_parts(
            CoreCheckpointIdentity {
                slot: "normal-main".to_owned(),
                generation: 1,
                root_hash: "b".repeat(64),
                revision: 11,
                state_version: 47,
                mode: "normal".to_owned(),
                registry_fingerprint: registry_fingerprint.to_owned(),
                base_primary_checksum: "12345678".to_owned(),
            },
            base,
            vec![
                station("pls", "planetary_logistics_station", 2, false),
                station("ils", "interstellar_logistics_station", 0, true),
            ],
            Vec::new(),
            station_catalog(registry_fingerprint),
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
            "timeWarp": {
                "controllerEntityId": "MOD-时间扭曲/Ω",
                "enabled": true,
                "requestedMultiplier": 15,
                "effectiveMultiplier": 12,
                "requiredPowerKw": 10000000000000.0,
                "allocatedPowerKw": 10000000000000.0
            },
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
        assert_eq!(projection["shell"]["timeWarp"]["effectiveMultiplier"], 12.0);
        assert_eq!(
            projection["shell"]["timeWarp"]["controllerEntityId"],
            "MOD-时间扭曲/Ω"
        );
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

    #[test]
    fn built_in_station_projection_is_exactly_five_slots_and_never_exports_routes() {
        let state = station_state(EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT);
        let before = state.summary().unwrap().canonical_sha256;
        let projection = state
            .factory_read_model_projection(&["pls".to_owned(), "ils".to_owned()], &[])
            .unwrap();
        let rows = projection["selection"]["entityRows"]["rows"]
            .as_array()
            .unwrap();
        let pls = &rows[0]["stationConfiguration"];
        let ils = &rows[1]["stationConfiguration"];
        assert_eq!(pls["stationType"], "planetary");
        assert_eq!(pls["itemOptions"]["limit"], MAX_STATION_ITEM_OPTIONS);
        assert_eq!(pls["itemOptions"]["totalCount"], 1);
        assert_eq!(pls["itemOptions"]["truncated"], false);
        assert_eq!(pls["itemOptions"]["rows"][0]["itemId"], "iron_ore");
        assert_eq!(pls["itemOptions"]["rows"][0]["name"], "铁矿");
        assert_eq!(pls["itemOptions"], ils["itemOptions"]);
        assert_eq!(pls["slots"].as_array().unwrap().len(), 5);
        assert_eq!(pls["slots"][2]["itemId"], "iron_ore");
        assert!(pls["slots"][2].get("routePolicy").is_none());
        assert!(pls["slots"][2].get("warperBudget").is_none());
        assert!(pls["stationVessels"].is_null());
        assert!(pls["stationWarpEnabled"].is_null());
        assert_eq!(ils["stationType"], "interstellar");
        assert_eq!(ils["slots"].as_array().unwrap().len(), 5);
        assert_eq!(ils["slots"][0]["routePolicy"], "relay-required");
        assert_eq!(ils["slots"][0]["warperBudget"], 4);
        assert_eq!(ils["stationDrones"], 12);
        assert_eq!(ils["stationVessels"], 3);
        assert_eq!(ils["stationWarpers"], 7);
        assert_eq!(ils["spaceWarpUnlocked"], true);
        let encoded = serde_json::to_string(&projection).unwrap();
        assert!(!encoded.contains("stationRoutes"));
        assert!(!encoded.contains("must-never-cross-ipc"));
        assert_eq!(state.summary().unwrap().canonical_sha256, before);
    }

    #[test]
    fn station_item_options_are_stable_bounded_and_truncated_without_mutation() {
        let mut state = station_state(EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT);
        let mut snapshot = state.catalog.snapshot.clone();
        snapshot
            .items
            .extend((0..MAX_STATION_ITEM_OPTIONS + 2).map(|index| {
                ItemDefinition {
                    id: format!("item_{index:03}"),
                    name: format!("内置物品 {index:03}"),
                    kind: match index % 3 {
                        0 => "solid",
                        1 => "fluid",
                        _ => "matrix",
                    }
                    .to_owned(),
                    fuel_energy_mj: 0.0,
                }
            }));
        state.catalog = std::sync::Arc::new(
            RuntimeCatalog::validate(snapshot, EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT).unwrap(),
        );
        let before = state.summary().unwrap().canonical_sha256;
        let first = state
            .factory_read_model_projection(&["pls".to_owned()], &[])
            .unwrap();
        let second = state
            .factory_read_model_projection(&["pls".to_owned()], &[])
            .unwrap();
        let options =
            &first["selection"]["entityRows"]["rows"][0]["stationConfiguration"]["itemOptions"];
        let rows = options["rows"].as_array().unwrap();
        assert_eq!(options["limit"], MAX_STATION_ITEM_OPTIONS);
        assert_eq!(options["totalCount"], MAX_STATION_ITEM_OPTIONS + 3);
        assert_eq!(options["truncated"], true);
        assert_eq!(rows.len(), MAX_STATION_ITEM_OPTIONS);
        assert_eq!(rows[0]["itemId"], "iron_ore");
        assert_eq!(rows[1]["itemId"], "item_000");
        assert_eq!(rows[MAX_STATION_ITEM_OPTIONS - 1]["itemId"], "item_126");
        assert!(rows.windows(2).all(|pair| {
            pair[0]["itemId"].as_str().unwrap() < pair[1]["itemId"].as_str().unwrap()
        }));
        assert_eq!(first, second);
        assert_eq!(state.summary().unwrap().canonical_sha256, before);
    }

    #[test]
    fn station_projection_fails_closed_on_slot_or_legacy_mirror_drift_and_mod_registry() {
        for mutate in [
            |entity: &mut Value| {
                entity["stationSlots"].as_array_mut().unwrap().pop();
            },
            |entity: &mut Value| {
                entity["storedItemId"] = Value::from("wrong-item");
            },
            |entity: &mut Value| {
                entity["stationMinimumLoad"] = Value::from(1);
            },
        ] {
            let mut state = station_state(EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT);
            let index = *state.entity_index.get("pls").unwrap();
            let mut entity = state.parse_entity(index).unwrap();
            mutate(&mut entity);
            let command = crate::command::SimulationCommandPatch {
                protocol_version: crate::CORE_PROTOCOL_VERSION,
                base_revision: state.revision,
                top_level_changes: Vec::new(),
                changed_entities: vec![crate::command::RecordPatch {
                    id: "pls".to_owned(),
                    changes: vec![crate::command::ValuePatch {
                        path: Vec::new(),
                        operation: "set".to_owned(),
                        value: Some(entity),
                    }],
                }],
                added_entities: Vec::new(),
                removed_entity_ids: Vec::new(),
                changed_belts: Vec::new(),
                added_belts: Vec::new(),
                removed_belt_ids: Vec::new(),
            };
            state.apply_command(&command).unwrap();
            let before = state.summary().unwrap().canonical_sha256;
            assert!(
                state
                    .factory_read_model_projection(&["pls".to_owned()], &[])
                    .is_err()
            );
            assert_eq!(state.summary().unwrap().canonical_sha256, before);
        }

        let mod_state = station_state("mod-registry");
        let projection = mod_state
            .factory_read_model_projection(&["pls".to_owned()], &[])
            .unwrap();
        assert!(projection["selection"]["entityRows"]["rows"][0]["stationConfiguration"].is_null());

        let mut remote_state = station_state(EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT);
        let index = *remote_state.entity_index.get("pls").unwrap();
        let mut remote = remote_state.parse_entity(index).unwrap();
        remote["planetId"] = Value::from("remote");
        let command = crate::command::SimulationCommandPatch {
            protocol_version: crate::CORE_PROTOCOL_VERSION,
            base_revision: remote_state.revision,
            top_level_changes: Vec::new(),
            changed_entities: vec![crate::command::RecordPatch {
                id: "pls".to_owned(),
                changes: vec![crate::command::ValuePatch {
                    path: Vec::new(),
                    operation: "set".to_owned(),
                    value: Some(remote),
                }],
            }],
            added_entities: Vec::new(),
            removed_entity_ids: Vec::new(),
            changed_belts: Vec::new(),
            added_belts: Vec::new(),
            removed_belt_ids: Vec::new(),
        };
        remote_state.apply_command(&command).unwrap();
        let projection = remote_state
            .factory_read_model_projection(&["pls".to_owned()], &[])
            .unwrap();
        assert!(projection["selection"]["entityRows"]["rows"][0]["stationConfiguration"].is_null());
    }
}
