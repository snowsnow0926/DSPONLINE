//! Bounded player-facing read models for the desktop thin renderer.
//!
//! The projection deliberately contains no raw table, `CoreState`, or public
//! v47 envelope. It is reconstructed from the already-owned native state and
//! can therefore replace renderer-side full-state reads one surface at a time.

use std::collections::{HashMap, HashSet};

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
const MAX_CONSTRUCTION_CENTER_ROWS: usize = 64;
const MAX_CONSTRUCTION_MATERIAL_ROWS: usize = 256;
const MAX_CONSTRUCTION_QUANTUM_BUFFER_ROWS: usize = 256;
const MAX_CONSTRUCTION_DESTROYED_BYPRODUCT_ROWS: usize = 256;
const MAX_CONSTRUCTION_COST_ROWS: usize = 32;
const MAX_CONSTRUCTION_LABEL_BYTES: usize = 256;
const PLAYER_STATION_SLOT_COUNT: usize = 5;
const MAX_STATION_ITEM_OPTIONS: usize = 128;
const MAX_CANVAS_REGION_ROWS: usize = 48;
const MAX_CANVAS_BOOKMARK_ROWS: usize = 24;
const MAX_HANDCRAFT_QUEUE_ROWS: usize = 20;
const MAX_HANDCRAFT_RECIPE_ROWS: usize = 256;
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

fn workspace_safe_integer(value: Option<&Value>, label: &str) -> anyhow::Result<u64> {
    value
        .and_then(Value::as_u64)
        .filter(|value| *value <= MAX_JAVASCRIPT_SAFE_INTEGER)
        .ok_or_else(|| anyhow!("native workspace read-model {label} is invalid"))
}

fn workspace_finite(value: Option<&Value>, label: &str) -> anyhow::Result<f64> {
    value
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
        .ok_or_else(|| anyhow!("native workspace read-model {label} is invalid"))
}

fn workspace_label(value: &str, label: &str) -> anyhow::Result<String> {
    if value.is_empty() || value.len() > MAX_CONSTRUCTION_LABEL_BYTES || value.contains('\0') {
        bail!("native workspace read-model {label} is invalid")
    }
    Ok(value.to_owned())
}

fn handcraftable_recipe(recipe_id: &str) -> bool {
    !matches!(
        recipe_id,
        "plasma_refining"
            | "xray_cracking"
            | "reforming_refine"
            | "ray_power"
            | "critical_photon"
            | "matrix_research"
            | "solar_sail_launch"
            | "carrier_rocket_launch"
            | "accumulator_charge"
            | "accumulator_discharge"
    )
}

fn workspace_item_row(state: &CoreState, item_id: &str, amount: f64) -> anyhow::Result<Value> {
    if !amount.is_finite() || amount <= 0.0 {
        bail!("native workspace recipe amount is invalid")
    }
    let item = state
        .catalog
        .items
        .get(item_id)
        .ok_or_else(|| anyhow!("native workspace recipe item is missing"))?;
    Ok(json!({
        "itemId": item.id,
        "name": workspace_label(if item.name.is_empty() { &item.id } else { &item.name }, "item name")?,
        "amount": amount,
    }))
}

fn native_workspace_action_read_model(
    state: &CoreState,
    base: &Map<String, Value>,
    active_planet_id: &str,
) -> anyhow::Result<Value> {
    let raw_regions: &[Value] = match base.get("canvasRegions") {
        None | Some(Value::Null) => &[],
        Some(Value::Array(rows)) => rows,
        Some(_) => bail!("native workspace canvas regions are invalid"),
    };
    if raw_regions.len() > MAX_CANVAS_REGION_ROWS {
        bail!("native workspace canvas regions exceed the persistent limit")
    }
    let mut region_ids = HashSet::new();
    let mut regions = Vec::with_capacity(raw_regions.len());
    for value in raw_regions {
        let row = value
            .as_object()
            .ok_or_else(|| anyhow!("native workspace canvas region is invalid"))?;
        let id = row
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| valid_opaque_id(id))
            .ok_or_else(|| anyhow!("native workspace canvas region ID is invalid"))?;
        let planet_id = row
            .get("planetId")
            .and_then(Value::as_str)
            .filter(|id| valid_opaque_id(id))
            .ok_or_else(|| anyhow!("native workspace canvas region planet is invalid"))?;
        if !region_ids.insert(id)
            || !state
                .catalog
                .planets
                .iter()
                .any(|planet| planet.id == planet_id)
        {
            bail!("native workspace canvas region identity is invalid")
        }
        let name = row
            .get("name")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow!("native workspace canvas region name is invalid"))?;
        let fill = row
            .get("fillColor")
            .and_then(Value::as_str)
            .filter(|color| {
                color.len() == 7
                    && color.starts_with('#')
                    && color.as_bytes()[1..].iter().all(u8::is_ascii_hexdigit)
            })
            .ok_or_else(|| anyhow!("native workspace canvas region fill is invalid"))?;
        let border = row
            .get("borderColor")
            .and_then(Value::as_str)
            .filter(|color| {
                color.len() == 7
                    && color.starts_with('#')
                    && color.as_bytes()[1..].iter().all(u8::is_ascii_hexdigit)
            })
            .ok_or_else(|| anyhow!("native workspace canvas region border is invalid"))?;
        let width = workspace_finite(row.get("width"), "region width")?;
        let height = workspace_finite(row.get("height"), "region height")?;
        if width < 40.0 || height < 40.0 {
            bail!("native workspace canvas region size is invalid")
        }
        regions.push(json!({
            "id": id,
            "name": workspace_label(name, "region name")?,
            "planetId": planet_id,
            "x": workspace_finite(row.get("x"), "region x")?,
            "y": workspace_finite(row.get("y"), "region y")?,
            "width": width,
            "height": height,
            "fillColor": fill,
            "borderColor": border,
        }));
    }

    let raw_bookmarks: &[Value] = match base.get("canvasBookmarks") {
        None | Some(Value::Null) => &[],
        Some(Value::Array(rows)) => rows,
        Some(_) => bail!("native workspace canvas bookmarks are invalid"),
    };
    if raw_bookmarks.len() > MAX_CANVAS_BOOKMARK_ROWS {
        bail!("native workspace canvas bookmarks exceed the persistent limit")
    }
    let mut bookmark_ids = HashSet::new();
    let mut bookmarks = Vec::with_capacity(raw_bookmarks.len());
    for value in raw_bookmarks {
        let row = value
            .as_object()
            .ok_or_else(|| anyhow!("native workspace canvas bookmark is invalid"))?;
        let id = row
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| valid_opaque_id(id))
            .ok_or_else(|| anyhow!("native workspace canvas bookmark ID is invalid"))?;
        let planet_id = row
            .get("planetId")
            .and_then(Value::as_str)
            .filter(|id| valid_opaque_id(id))
            .ok_or_else(|| anyhow!("native workspace canvas bookmark planet is invalid"))?;
        if !bookmark_ids.insert(id)
            || !state
                .catalog
                .planets
                .iter()
                .any(|planet| planet.id == planet_id)
        {
            bail!("native workspace canvas bookmark identity is invalid")
        }
        let viewport = row
            .get("viewport")
            .and_then(Value::as_object)
            .ok_or_else(|| anyhow!("native workspace canvas bookmark viewport is invalid"))?;
        let zoom = workspace_finite(viewport.get("zoom"), "bookmark zoom")?;
        if !(0.1..=2.5).contains(&zoom) {
            bail!("native workspace canvas bookmark zoom is invalid")
        }
        bookmarks.push(json!({
            "id": id,
            "name": workspace_label(row.get("name").and_then(Value::as_str).unwrap_or("视角书签"), "bookmark name")?,
            "planetId": planet_id,
            "viewport": {
                "x": workspace_finite(viewport.get("x"), "bookmark x")?,
                "y": workspace_finite(viewport.get("y"), "bookmark y")?,
                "zoom": zoom,
            },
            "createdAtSeconds": workspace_finite(row.get("createdAtSeconds"), "bookmark creation time")?.max(0.0),
        }));
    }

    let raw_queue: &[Value] = match base.get("handcraftQueue") {
        None | Some(Value::Null) => &[],
        Some(Value::Array(rows)) => rows,
        Some(_) => bail!("native workspace handcraft queue is invalid"),
    };
    if raw_queue.len() > MAX_HANDCRAFT_QUEUE_ROWS {
        bail!("native workspace handcraft queue exceeds the persistent limit")
    }
    let mut queue_ids = HashSet::new();
    let mut queue = Vec::with_capacity(raw_queue.len());
    for value in raw_queue {
        let row = value
            .as_object()
            .ok_or_else(|| anyhow!("native workspace handcraft entry is invalid"))?;
        let entry_id = row
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| valid_opaque_id(id))
            .ok_or_else(|| anyhow!("native workspace handcraft entry ID is invalid"))?;
        let recipe_id = row
            .get("recipeId")
            .and_then(Value::as_str)
            .filter(|id| valid_opaque_id(id))
            .ok_or_else(|| anyhow!("native workspace handcraft recipe ID is invalid"))?;
        let recipe = state
            .catalog
            .recipes
            .get(recipe_id)
            .filter(|recipe| handcraftable_recipe(&recipe.id) && !recipe.outputs.is_empty())
            .ok_or_else(|| anyhow!("native workspace handcraft recipe is missing"))?;
        let output = &recipe.outputs[0];
        let item = state
            .catalog
            .items
            .get(&output.item_id)
            .ok_or_else(|| anyhow!("native workspace handcraft output item is missing"))?;
        let planet_id = row
            .get("planetId")
            .and_then(Value::as_str)
            .filter(|id| valid_opaque_id(id))
            .ok_or_else(|| anyhow!("native workspace handcraft planet is invalid"))?;
        let total = workspace_safe_integer(row.get("batchesTotal"), "handcraft batch total")?;
        let remaining =
            workspace_safe_integer(row.get("batchesRemaining"), "handcraft batch remaining")?;
        let progress = workspace_finite(row.get("progress"), "handcraft progress")?;
        if !queue_ids.insert(entry_id)
            || total < 1
            || remaining > total
            || !(0.0..=1.0).contains(&progress)
            || !state
                .catalog
                .planets
                .iter()
                .any(|planet| planet.id == planet_id)
        {
            bail!("native workspace handcraft entry state is invalid")
        }
        queue.push(json!({
            "entryId": entry_id,
            "recipeId": recipe.id,
            "recipeName": workspace_label(if recipe.name.is_empty() { &recipe.id } else { &recipe.name }, "recipe name")?,
            "outputItemId": item.id,
            "outputItemName": workspace_label(if item.name.is_empty() { &item.id } else { &item.name }, "output item name")?,
            "planetId": planet_id,
            "batchesTotal": total,
            "batchesRemaining": remaining,
            "progress": progress,
            "queuedAt": workspace_finite(row.get("queuedAt"), "handcraft queue time")?.max(0.0),
        }));
    }

    let completed = base
        .get("research")
        .and_then(Value::as_object)
        .and_then(|research| research.get("completedTechIds"))
        .and_then(Value::as_array)
        .into_iter()
        .flat_map(|ids| ids.iter())
        .filter_map(Value::as_str)
        .collect::<HashSet<_>>();
    let mut recipes = state
        .catalog
        .recipes
        .values()
        .filter(|recipe| {
            handcraftable_recipe(&recipe.id)
                && !recipe.inputs.is_empty()
                && !recipe.outputs.is_empty()
        })
        .collect::<Vec<_>>();
    recipes.sort_unstable_by(|left, right| left.id.cmp(&right.id));
    let recipe_total = recipes.len();
    let recipe_rows = recipes.into_iter().take(MAX_HANDCRAFT_RECIPE_ROWS).map(|recipe| {
        let building = state.catalog.buildings.get(&recipe.building_id)
            .ok_or_else(|| anyhow!("native workspace handcraft building is missing"))?;
        let inputs = recipe.inputs.iter().map(|entry| workspace_item_row(state, &entry.item_id, entry.amount))
            .collect::<anyhow::Result<Vec<_>>>()?;
        let outputs = recipe.outputs.iter().map(|entry| workspace_item_row(state, &entry.item_id, entry.amount))
            .collect::<anyhow::Result<Vec<_>>>()?;
        Ok(json!({
            "recipeId": recipe.id,
            "name": workspace_label(if recipe.name.is_empty() { &recipe.id } else { &recipe.name }, "recipe name")?,
            "buildingId": building.id,
            "buildingName": workspace_label(&building.id, "building name")?,
            "duration": recipe.duration,
            "unlocked": recipe.required_tech_id.as_deref().is_none_or(|id| completed.contains(id)),
            "requiredTechId": recipe.required_tech_id,
            "inputs": inputs,
            "outputs": outputs,
        }))
    }).collect::<anyhow::Result<Vec<_>>>()?;

    Ok(json!({
        "schema": "workspace-actions-v1",
        "activePlanetId": active_planet_id,
        "regions": rows_model(regions, raw_regions.len(), MAX_CANVAS_REGION_ROWS),
        "bookmarks": rows_model(bookmarks, raw_bookmarks.len(), MAX_CANVAS_BOOKMARK_ROWS),
        "handcraftQueue": rows_model(queue, raw_queue.len(), MAX_HANDCRAFT_QUEUE_ROWS),
        "handcraftRecipes": rows_model(recipe_rows, recipe_total, MAX_HANDCRAFT_RECIPE_ROWS),
    }))
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
    let building_id = object.get("buildingId").and_then(Value::as_str);
    let building_metadata = building_id.and_then(|id| state.catalog.building_metadata.get(id));
    let orbital_yield_item_ids = if building_id == Some("orbital_collector") {
        let mut rows = state
            .catalog
            .planets
            .iter()
            .find(|planet| planet.id == planet_id)
            .map(|planet| {
                planet
                    .orbital_yields
                    .iter()
                    .filter_map(|(item_id, rate)| {
                        (rate.is_finite()
                            && *rate > 0.0
                            && state.catalog.items.contains_key(item_id))
                        .then_some(item_id.clone())
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        rows.sort_unstable();
        Value::Array(rows.into_iter().map(Value::from).collect())
    } else {
        Value::Array(Vec::new())
    };
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
        "buildingName": building_metadata.map(|metadata| metadata.name.clone()),
        "upgradeTargetId": building_metadata.and_then(|metadata| metadata.upgrade_target_id.clone()),
        "sprayCoaterInstalled": object.get("sprayCoaterInstalled").and_then(Value::as_bool).unwrap_or(false),
        "quantumMode": object.get("quantumMode").and_then(Value::as_str).unwrap_or("legacy"),
        "quantumTransitionActive": object.get("quantumTransition").is_some_and(|value| !value.is_null()),
        "stationTier": finite_number(object.get("stationTier")),
        "orbitalYieldItemIds": orbital_yield_item_ids,
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

fn construction_catalog_label(value: &str, label: &str) -> anyhow::Result<String> {
    if value.is_empty() || value.len() > MAX_CONSTRUCTION_LABEL_BYTES || value.contains('\0') {
        bail!("native construction-center {label} is invalid");
    }
    Ok(value.to_owned())
}

fn construction_safe_amount(value: Option<&Value>, label: &str) -> anyhow::Result<u64> {
    let value = value
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite() && *value >= 0.0 && value.fract() == 0.0)
        .ok_or_else(|| anyhow!("native construction-center {label} is invalid"))?;
    if value > MAX_JAVASCRIPT_SAFE_INTEGER as f64 {
        bail!("native construction-center {label} exceeds the safe integer limit");
    }
    Ok(value as u64)
}

fn construction_catalog_amount(value: f64, label: &str) -> anyhow::Result<u64> {
    if !value.is_finite()
        || value <= 0.0
        || value.fract() != 0.0
        || value > MAX_JAVASCRIPT_SAFE_INTEGER as f64
    {
        bail!("native construction-center {label} is invalid");
    }
    Ok(value as u64)
}

fn construction_item_label(state: &CoreState, item_id: &str) -> anyhow::Result<String> {
    let item = state
        .catalog
        .items
        .get(item_id)
        .ok_or_else(|| anyhow!("native construction-center item directory is unknown"))?;
    construction_catalog_label(&item.name, "item name")
}

fn construction_named_quantity_rows(
    state: &CoreState,
    value: Option<&Value>,
    limit: usize,
    label: &str,
) -> anyhow::Result<Value> {
    let entries = match value {
        None => Vec::new(),
        Some(value) => value
            .as_object()
            .ok_or_else(|| anyhow!("native construction-center {label} is invalid"))?
            .iter()
            .map(|(item_id, amount)| {
                if !valid_opaque_id(item_id) {
                    bail!("native construction-center {label} item ID is invalid");
                }
                let name = construction_item_label(state, item_id)?;
                let amount = construction_safe_amount(Some(amount), label)?;
                Ok((item_id.to_owned(), name, amount))
            })
            .collect::<anyhow::Result<Vec<_>>>()?,
    };
    let mut entries = entries
        .into_iter()
        .filter(|(_, _, amount)| *amount > 0)
        .collect::<Vec<_>>();
    entries.sort_unstable_by(|left, right| left.0.cmp(&right.0));
    let total_count = entries.len();
    let total_amount = entries.iter().try_fold(0_u64, |total, (_, _, amount)| {
        total
            .checked_add(*amount)
            .filter(|total| *total <= MAX_JAVASCRIPT_SAFE_INTEGER)
            .ok_or_else(|| anyhow!("native construction-center {label} total is invalid"))
    })?;
    let rows = entries
        .into_iter()
        .take(limit)
        .map(|(item_id, name, amount)| json!({ "itemId": item_id, "name": name, "amount": amount }))
        .collect::<Vec<_>>();
    Ok(json!({
        "rows": rows,
        "totalCount": total_count,
        "totalAmount": total_amount,
        "truncated": total_count > limit,
    }))
}

const BUILT_IN_CONSTRUCTION_TARGETS: &[(&str, &str, &str)] = &[
    ("wind_turbine", "风力涡轮机", "power"),
    ("solar_panel", "太阳能板", "power"),
    ("geothermal_power_station", "地热发电站", "power"),
    ("thermal_power_plant", "火力发电厂", "power"),
    ("mini_fusion_power_plant", "微型聚变发电站", "power"),
    ("artificial_star", "人造恒星", "power"),
    ("accumulator", "蓄电器", "power"),
    ("energy_exchanger", "能量枢纽", "power"),
    ("mining_machine", "采矿机", "production"),
    ("arc_smelter", "电弧熔炉", "production"),
    ("plane_smelter", "位面熔炉", "production"),
    ("assembling_machine_mk1", "制造台 Mk.I", "production"),
    ("assembling_machine_mk2", "制造台 Mk.II", "production"),
    ("assembling_machine_mk3", "制造台 Mk.III", "production"),
    ("spray_coater", "喷涂机", "production"),
    ("matrix_lab", "矩阵研究站", "production"),
    ("oil_extractor", "原油萃取站", "production"),
    ("oil_refinery", "原油精炼厂", "production"),
    ("water_pump", "抽水站", "production"),
    ("chemical_plant", "化工厂", "production"),
    ("quantum_chemical_plant", "量子化工厂", "production"),
    ("fractionator", "分馏塔", "production"),
    (
        "miniature_particle_collider",
        "微型粒子对撞机",
        "production",
    ),
    ("construction_center", "建筑制造中心", "production"),
    ("conveyor_belt_mk1", "传送带 Mk.I", "logistics"),
    ("conveyor_belt_mk2", "传送带 Mk.II", "logistics"),
    ("conveyor_belt_mk3", "传送带 Mk.III", "logistics"),
    ("storage_mk1", "小型储物仓", "logistics"),
    ("material_delivery_hub", "物资配送枢纽", "logistics"),
    ("orbital_cargo_terminal", "轨道货运终端", "logistics"),
    ("splitter_4way", "四向分流器", "logistics"),
    ("storage_tank", "储液罐", "logistics"),
    ("planetary_logistics_station", "行星物流站", "logistics"),
    ("interstellar_logistics_station", "星际物流站", "logistics"),
    (
        "space_station_construction_launcher",
        "空间站施工发射平台",
        "logistics",
    ),
    ("orbital_collector", "轨道采集器", "logistics"),
    ("logistics_drone", "物流运输机", "logistics"),
    ("logistics_vessel", "物流运输船", "logistics"),
    ("em_rail_ejector", "电磁轨道弹射器", "dyson"),
    ("vertical_launching_silo", "垂直发射井", "dyson"),
    ("ray_receiver", "射线接收站", "dyson"),
    ("galactic_material_exporter", "超大型物资出口", "dyson"),
    ("micro_black_hole_connector", "微型黑洞连接装置", "dyson"),
    ("time_warp_device", "时间扭曲装置", "dyson"),
];

fn construction_target_metadata(target_id: &str) -> anyhow::Result<(&'static str, &'static str)> {
    BUILT_IN_CONSTRUCTION_TARGETS
        .iter()
        .find(|(id, _, _)| *id == target_id)
        .map(|(_, name, category)| (*name, *category))
        .ok_or_else(|| anyhow!("native construction-center target directory is unknown"))
}

fn construction_target_stock(
    base: &Map<String, Value>,
    target_id: &str,
    fleet: bool,
) -> anyhow::Result<u64> {
    let inventory = if fleet {
        "portableFleet"
    } else {
        "construction"
    };
    match base
        .get(inventory)
        .and_then(Value::as_object)
        .and_then(|stock| stock.get(target_id))
    {
        Some(value) => construction_safe_amount(Some(value), "current stock"),
        None => Ok(0),
    }
}

fn construction_stock_limit(base: &Map<String, Value>) -> u64 {
    if crate::construction_planner::completed_tech(base, "construction_capacity_2") {
        100_000_000
    } else if crate::construction_planner::completed_tech(base, "construction_capacity_1") {
        500
    } else {
        100
    }
}

fn construction_cycle_seconds(base: &Map<String, Value>) -> f64 {
    if crate::construction_planner::completed_tech(base, "construction_capacity_2") {
        1.0
    } else if crate::construction_planner::completed_tech(base, "construction_capacity_1") {
        2.5
    } else {
        5.0
    }
}

fn native_construction_center_workspace(
    state: &CoreState,
    base: &Map<String, Value>,
    active_planet_id: &str,
) -> anyhow::Result<Value> {
    if state.identity.registry_fingerprint != EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT
        || state.catalog.snapshot.registry_fingerprint != EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT
    {
        return Ok(Value::Null);
    }
    let active_planet = state
        .catalog
        .planets
        .iter()
        .find(|planet| planet.id == active_planet_id)
        .ok_or_else(|| anyhow!("native construction-center active planet is missing"))?;
    let active_planet_name = construction_catalog_label(&active_planet.name, "planet name")?;
    let automation = base
        .get("constructionAutomation")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("native construction-center automation state is missing"))?;
    let enabled = automation
        .get("enabled")
        .and_then(Value::as_bool)
        .ok_or_else(|| anyhow!("native construction-center enabled state is invalid"))?;
    let quantum_source_enabled = match automation.get("quantumSourceEnabled") {
        None => false,
        Some(Value::Bool(enabled)) => *enabled,
        Some(_) => bail!("native construction-center quantum source state is invalid"),
    };
    let paused = base
        .get("paused")
        .and_then(Value::as_bool)
        .ok_or_else(|| anyhow!("native construction-center pause state is invalid"))?;

    let targets = crate::construction_planner::targets(state);
    let target_ids = targets
        .iter()
        .map(|target| target.id.as_str())
        .collect::<HashSet<_>>();
    let target_stock = automation
        .get("targetStock")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("native construction-center target stock is invalid"))?;
    if target_stock
        .keys()
        .any(|target_id| !target_ids.contains(target_id.as_str()))
    {
        bail!("native construction-center target stock contains an unknown target");
    }
    let mut target_names = HashMap::<String, String>::new();
    let mut target_rows = Vec::with_capacity(targets.len().min(MAX_TARGET_ROWS));
    for target in &targets {
        let (built_in_name, category) = construction_target_metadata(&target.id)?;
        let (kind, costs) = match &target.kind {
            crate::construction_planner::TargetKind::Building => {
                let definition = state.catalog.constructions.get(&target.id).ok_or_else(|| {
                    anyhow!("native construction-center construction directory is stale")
                })?;
                ("building", definition.costs.as_slice())
            }
            crate::construction_planner::TargetKind::Fleet { recipe_id } => {
                let recipe =
                    state.catalog.recipes.get(recipe_id).ok_or_else(|| {
                        anyhow!("native construction-center fleet recipe is missing")
                    })?;
                let item_name = construction_item_label(state, &target.id)?;
                if item_name != built_in_name {
                    bail!("native construction-center fleet item directory is stale");
                }
                ("fleet", recipe.inputs.as_slice())
            }
        };
        let name = construction_catalog_label(built_in_name, "target name")?;
        let required_tech = match target.required_tech_id.as_deref() {
            None => (Value::Null, Value::Null),
            Some(tech_id) => {
                let technology = state.catalog.technologies.get(tech_id).ok_or_else(|| {
                    anyhow!("native construction-center technology directory is stale")
                })?;
                (
                    Value::from(tech_id.to_owned()),
                    Value::from(construction_catalog_label(
                        &technology.name,
                        "technology name",
                    )?),
                )
            }
        };
        let mut cost_rows = Vec::with_capacity(costs.len().min(MAX_CONSTRUCTION_COST_ROWS));
        for cost in costs {
            cost_rows.push(json!({
                "itemId": cost.item_id,
                "name": construction_item_label(state, &cost.item_id)?,
                "amount": construction_catalog_amount(cost.amount, "target cost")?,
            }));
        }
        let desired = match target_stock.get(&target.id) {
            Some(value) => construction_safe_amount(Some(value), "target stock")?,
            None => 0,
        };
        let fleet = matches!(
            target.kind,
            crate::construction_planner::TargetKind::Fleet { .. }
        );
        let current_stock = construction_target_stock(base, &target.id, fleet)?;
        let output_amount = construction_catalog_amount(target.output_amount, "target output")?;
        target_names.insert(target.id.clone(), name.clone());
        target_rows.push(json!({
            "targetId": target.id,
            "name": name,
            "kind": kind,
            "category": category,
            "target": desired,
            "currentStock": current_stock,
            "unlocked": crate::construction_planner::target_is_unlocked(base, target),
            "requiredTechId": required_tech.0,
            "requiredTechName": required_tech.1,
            "outputAmount": output_amount,
            "costs": rows_model(cost_rows, costs.len(), MAX_CONSTRUCTION_COST_ROWS),
        }));
    }

    let raw_jobs = automation
        .get("jobs")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("native construction-center jobs are invalid"))?;
    let write_available = matches!(
        crate::command::construction_automation_write_eligibility(state)?,
        crate::command::ConstructionAutomationWriteEligibility::Available
    );
    let mut all_center_ids = HashSet::<String>::new();
    let mut active_center_ids = HashSet::<String>::new();
    let mut center_rows = Vec::<Value>::new();
    for index in &state.factory_topology.construction_center_indices {
        let entity = state.parse_entity(*index)?;
        let entity = entity
            .as_object()
            .ok_or_else(|| anyhow!("native construction-center entity is invalid"))?;
        if entity.get("buildingId").and_then(Value::as_str) != Some("construction_center") {
            bail!("native construction-center topology is stale");
        }
        let entity_id = entity
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| valid_opaque_id(id))
            .ok_or_else(|| anyhow!("native construction-center entity ID is invalid"))?;
        let planet_id = entity
            .get("planetId")
            .and_then(Value::as_str)
            .filter(|id| valid_opaque_id(id))
            .ok_or_else(|| anyhow!("native construction-center entity planet is invalid"))?;
        all_center_ids.insert(entity_id.to_owned());
        if planet_id == active_planet_id {
            active_center_ids.insert(entity_id.to_owned());
            let status = if paused {
                "game-paused"
            } else if !enabled {
                "automation-paused"
            } else if raw_jobs.contains_key(entity_id) {
                "working"
            } else {
                "idle"
            };
            center_rows.push(json!({
                "entityId": entity_id,
                "planetId": planet_id,
                "planetName": active_planet_name,
                "machineCount": required_safe_integer(
                    entity.get("machineCount"),
                    "construction center machine count",
                    MAX_JAVASCRIPT_SAFE_INTEGER,
                )?,
                "status": status,
            }));
        }
    }
    center_rows.sort_by(|left, right| left["entityId"].as_str().cmp(&right["entityId"].as_str()));

    let mut job_entries = raw_jobs.iter().collect::<Vec<_>>();
    job_entries.sort_unstable_by(|left, right| left.0.cmp(right.0));
    let mut job_rows = Vec::<Value>::new();
    for (entity_id, value) in job_entries {
        if !all_center_ids.contains(entity_id) {
            bail!("native construction-center job refers to an unknown center");
        }
        let job = value
            .as_object()
            .ok_or_else(|| anyhow!("native construction-center job is invalid"))?;
        let target_id = job
            .get("constructionId")
            .and_then(Value::as_str)
            .filter(|target_id| target_ids.contains(*target_id))
            .ok_or_else(|| anyhow!("native construction-center job target is unknown"))?;
        let step_index = construction_safe_amount(job.get("stepIndex"), "job step index")?;
        let steps = job
            .get("steps")
            .and_then(Value::as_array)
            .ok_or_else(|| anyhow!("native construction-center job steps are invalid"))?;
        if step_index as usize > steps.len() {
            bail!("native construction-center job step binding is invalid");
        }
        let elapsed_seconds = job
            .get("elapsedSeconds")
            .and_then(Value::as_f64)
            .filter(|value| value.is_finite() && *value >= 0.0)
            .ok_or_else(|| anyhow!("native construction-center job elapsed time is invalid"))?;
        let inventory = construction_named_quantity_rows(
            state,
            job.get("inventory"),
            MAX_CONSTRUCTION_MATERIAL_ROWS,
            "job inventory",
        )?;
        if active_center_ids.contains(entity_id) {
            job_rows.push(json!({
                "entityId": entity_id,
                "targetId": target_id,
                "targetName": target_names.get(target_id).ok_or_else(|| anyhow!("native construction-center job name is missing"))?,
                "stepIndex": step_index,
                "stepCount": steps.len(),
                "elapsedSeconds": elapsed_seconds,
                "inventory": inventory,
            }));
        }
    }

    let quantum_buffers = match automation.get("quantumMaterialBuffer") {
        None => None,
        Some(Value::Object(buffers)) => Some(buffers),
        Some(_) => bail!("native construction-center quantum buffer directory is invalid"),
    };
    let mut quantum_rows = Vec::<Value>::new();
    let mut quantum_total_amount = 0_u64;
    if let Some(buffers) = quantum_buffers {
        let mut entries = buffers.iter().collect::<Vec<_>>();
        entries.sort_unstable_by(|left, right| left.0.cmp(right.0));
        for (entity_id, inventory) in entries {
            if !all_center_ids.contains(entity_id) {
                bail!("native construction-center quantum buffer refers to an unknown center");
            }
            let inventory = inventory
                .as_object()
                .ok_or_else(|| anyhow!("native construction-center quantum buffer is invalid"))?;
            let mut items = inventory.iter().collect::<Vec<_>>();
            items.sort_unstable_by(|left, right| left.0.cmp(right.0));
            for (item_id, amount) in items {
                let name = construction_item_label(state, item_id)?;
                let amount = construction_safe_amount(Some(amount), "quantum buffer amount")?;
                if active_center_ids.contains(entity_id) && amount > 0 {
                    quantum_total_amount = quantum_total_amount
                        .checked_add(amount)
                        .filter(|total| *total <= MAX_JAVASCRIPT_SAFE_INTEGER)
                        .ok_or_else(|| {
                            anyhow!("native construction-center quantum buffer total is invalid")
                        })?;
                    quantum_rows.push(json!({
                        "entityId": entity_id,
                        "itemId": item_id,
                        "name": name,
                        "amount": amount,
                    }));
                }
            }
        }
    }
    let quantum_total_count = quantum_rows.len();
    let quantum_buffer = json!({
        "rows": quantum_rows.into_iter().take(MAX_CONSTRUCTION_QUANTUM_BUFFER_ROWS).collect::<Vec<_>>(),
        "totalCount": quantum_total_count,
        "totalAmount": quantum_total_amount,
        "truncated": quantum_total_count > MAX_CONSTRUCTION_QUANTUM_BUFFER_ROWS,
    });

    let materials = construction_named_quantity_rows(
        state,
        base.get("tray"),
        MAX_CONSTRUCTION_MATERIAL_ROWS,
        "active planet materials",
    )?;
    let destroyed_byproducts = construction_named_quantity_rows(
        state,
        automation.get("destroyedByproducts"),
        MAX_CONSTRUCTION_DESTROYED_BYPRODUCT_ROWS,
        "destroyed byproducts",
    )?;
    let total_crafted = construction_safe_amount(automation.get("totalCrafted"), "total crafted")?;
    let (last_crafted_id, last_crafted_name) = match automation.get("lastCraftedId") {
        None | Some(Value::Null) => (Value::Null, Value::Null),
        Some(value) => {
            let id = value
                .as_str()
                .filter(|id| target_ids.contains(*id))
                .ok_or_else(|| {
                    anyhow!("native construction-center last crafted target is unknown")
                })?;
            (
                Value::from(id.to_owned()),
                Value::from(
                    target_names
                        .get(id)
                        .ok_or_else(|| {
                            anyhow!("native construction-center last crafted name is missing")
                        })?
                        .clone(),
                ),
            )
        }
    };
    let quantum_network_enabled = match base.get("quantumLogisticsNetwork") {
        None => false,
        Some(Value::Object(network)) => match network.get("enabled") {
            None => false,
            Some(Value::Bool(enabled)) => *enabled,
            Some(_) => bail!("native construction-center quantum network state is invalid"),
        },
        Some(_) => bail!("native construction-center quantum network directory is invalid"),
    };
    let cycle_seconds = construction_cycle_seconds(base);
    let target_total = target_rows.len();
    let center_total = center_rows.len();
    let job_total = job_rows.len();
    Ok(json!({
        "schema": "construction-center-workspace-v1",
        "registryFingerprint": EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT,
        "readOnly": true,
        "writeAvailable": write_available,
        "activePlanetId": active_planet_id,
        "activePlanetName": active_planet_name,
        "paused": paused,
        "enabled": enabled,
        "quantumSourceEnabled": quantum_source_enabled,
        "quantumNetworkEnabled": quantum_network_enabled,
        "totalCrafted": total_crafted,
        "lastCraftedId": last_crafted_id,
        "lastCraftedName": last_crafted_name,
        "stockLimit": construction_stock_limit(base),
        "cycleSeconds": cycle_seconds,
        "materialSeconds": cycle_seconds / 50.0,
        "targets": rows_model(target_rows, target_total, MAX_TARGET_ROWS),
        "centers": rows_model(center_rows, center_total, MAX_CONSTRUCTION_CENTER_ROWS),
        "jobs": rows_model(job_rows, job_total, MAX_JOB_ROWS),
        "materials": materials,
        "quantumBuffer": quantum_buffer,
        "destroyedByproducts": destroyed_byproducts,
        "limits": {
            "targetRows": MAX_TARGET_ROWS,
            "centerRows": MAX_CONSTRUCTION_CENTER_ROWS,
            "jobRows": MAX_JOB_ROWS,
            "materialRows": MAX_CONSTRUCTION_MATERIAL_ROWS,
            "quantumBufferRows": MAX_CONSTRUCTION_QUANTUM_BUFFER_ROWS,
            "destroyedByproductRows": MAX_CONSTRUCTION_DESTROYED_BYPRODUCT_ROWS,
            "costRowsPerTarget": MAX_CONSTRUCTION_COST_ROWS,
            "projectionBytes": MAX_PROJECTION_BYTES,
        },
    }))
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
            // Construction-center data is an optional, built-in-only slice.
            // Any malformed/unknown catalog or state directory closes only
            // that slice instead of weakening the rest of the factory atom.
            "nativeCenterWorkspace": native_construction_center_workspace(self, base, active_planet_id)
                .unwrap_or(Value::Null),
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
        let workspace = native_workspace_action_read_model(self, base, active_planet_id)?;
        let result = json!({
            "schemaVersion": 1,
            "projectionType": READ_MODEL_SCHEMA,
            "revision": self.revision,
            "shell": shell,
            "planetNavigation": planet_navigation,
            "selection": selection,
            "construction": construction,
            "workspace": workspace,
        });
        if serde_json::to_vec(&result)?.len() > MAX_PROJECTION_BYTES {
            bail!("native factory read-model projection exceeds the byte limit");
        }
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use std::{collections::HashMap, sync::Arc};

    use serde_json::json;

    use super::*;
    use crate::catalog::{
        BeltDefinition, BuildingDefinition, CatalogSnapshot, ConstructionDefinition, ItemAmount,
        ItemDefinition, PlanetDefinition, RecipeDefinition, RuntimeCatalog, TechnologyDefinition,
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

    fn construction_center_state(registry_fingerprint: &str, unknown_target: bool) -> CoreState {
        let catalog = RuntimeCatalog::validate(
            CatalogSnapshot {
                protocol_version: 1,
                registry_fingerprint: registry_fingerprint.to_owned(),
                planets: vec![
                    PlanetDefinition {
                        id: "home".to_owned(),
                        name: "家园星".to_owned(),
                        system_id: "helios".to_owned(),
                        kind: "terrestrial".to_owned(),
                        orbit_index: 1,
                        simulation_order: 0,
                        orbital_yields: HashMap::new(),
                    },
                    PlanetDefinition {
                        id: "remote".to_owned(),
                        name: "远方星".to_owned(),
                        system_id: "helios".to_owned(),
                        kind: "terrestrial".to_owned(),
                        orbit_index: 2,
                        simulation_order: 1,
                        orbital_yields: HashMap::new(),
                    },
                ],
                items: vec![
                    ItemDefinition {
                        id: "iron_ore".to_owned(),
                        name: "铁矿石".to_owned(),
                        kind: "solid".to_owned(),
                        fuel_energy_mj: 0.0,
                    },
                    ItemDefinition {
                        id: "logistics_drone".to_owned(),
                        name: "物流运输机".to_owned(),
                        kind: "solid".to_owned(),
                        fuel_energy_mj: 0.0,
                    },
                ],
                buildings: vec![BuildingDefinition {
                    id: "construction_center".to_owned(),
                    kind: "machine".to_owned(),
                    speed: 1.0,
                    input_capacity: 0.0,
                    output_capacity: 0.0,
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
                    id: "logistics_drone".to_owned(),
                    name: "物流运输机".to_owned(),
                    building_id: "construction_center".to_owned(),
                    duration: 4.0,
                    required_tech_id: Some("planetary_logistics".to_owned()),
                    recursive_priority: 0.0,
                    recursive_manufacturing: false,
                    inputs: vec![ItemAmount {
                        item_id: "iron_ore".to_owned(),
                        amount: 2.0,
                    }],
                    outputs: vec![ItemAmount {
                        item_id: "logistics_drone".to_owned(),
                        amount: 1.0,
                    }],
                }],
                constructions: vec![
                    ConstructionDefinition {
                        id: "wind_turbine".to_owned(),
                        output_amount: 1.0,
                        automation_order: 0,
                        required_tech_id: Some("electromagnetism".to_owned()),
                        costs: vec![ItemAmount {
                            item_id: "iron_ore".to_owned(),
                            amount: 6.0,
                        }],
                    },
                    ConstructionDefinition {
                        id: "construction_center".to_owned(),
                        output_amount: 1.0,
                        automation_order: 1,
                        required_tech_id: Some("construction_automation".to_owned()),
                        costs: vec![ItemAmount {
                            item_id: "iron_ore".to_owned(),
                            amount: 10.0,
                        }],
                    },
                ],
                belts: Vec::new(),
                proliferators: Vec::new(),
                technologies: vec![
                    TechnologyDefinition {
                        id: "construction_automation".to_owned(),
                        name: "制造协议".to_owned(),
                        costs: vec![ItemAmount {
                            item_id: "iron_ore".to_owned(),
                            amount: 1.0,
                        }],
                        prerequisites: Vec::new(),
                        construction_rewards: vec!["construction_center".to_owned()],
                    },
                    TechnologyDefinition {
                        id: "electromagnetism".to_owned(),
                        name: "电磁学".to_owned(),
                        costs: vec![ItemAmount {
                            item_id: "iron_ore".to_owned(),
                            amount: 1.0,
                        }],
                        prerequisites: Vec::new(),
                        construction_rewards: vec!["wind_turbine".to_owned()],
                    },
                    TechnologyDefinition {
                        id: "planetary_logistics".to_owned(),
                        name: "行星物流".to_owned(),
                        costs: vec![ItemAmount {
                            item_id: "iron_ore".to_owned(),
                            amount: 1.0,
                        }],
                        prerequisites: Vec::new(),
                        construction_rewards: Vec::new(),
                    },
                ],
            },
            registry_fingerprint,
        )
        .unwrap();
        let target_stock = if unknown_target {
            json!({ "wind_turbine": 50, "logistics_drone": 10, "MOD/unknown": 1 })
        } else {
            json!({ "wind_turbine": 50, "logistics_drone": 10 })
        };
        let base = json!({
            "version": 47,
            "mode": "normal",
            "activePlanetId": "home",
            "elapsedSeconds": 12,
            "paused": false,
            "settings": { "simulationSpeed": 1 },
            "timeWarp": {
                "controllerEntityId": null,
                "enabled": false,
                "requestedMultiplier": 1,
                "effectiveMultiplier": 1,
                "requiredPowerKw": 0,
                "allocatedPowerKw": 0
            },
            "research": { "completedTechIds": ["construction_automation", "electromagnetism", "planetary_logistics"] },
            "exploration": { "unlockedSystemIds": ["helios"], "colonizedPlanetIds": ["home", "remote"] },
            "galaxy": { "planetMetadata": {}, "planetRoles": {} },
            "planetMetrics": { "home": { "powerFactor": 1 }, "remote": { "powerFactor": 1 } },
            "constructionQueue": [],
            "construction": { "wind_turbine": 41 },
            "portableFleet": { "logistics_drone": 7, "logistics_vessel": 0 },
            "tray": { "iron_ore": 123 },
            "planetTrays": {},
            "orbitalStation": { "status": "eligible" },
            "quantumLogisticsNetwork": { "enabled": true, "inventory": {} },
            "constructionAutomation": {
                "enabled": true,
                "quantumSourceEnabled": true,
                "totalCrafted": 3,
                "lastCraftedId": "wind_turbine",
                "targetStock": target_stock,
                "destroyedByproducts": { "iron_ore": 3 },
                "quantumMaterialBuffer": { "center-a": { "iron_ore": 4 } },
                "jobs": {
                    "center-a": {
                        "constructionId": "wind_turbine",
                        "stepIndex": 1,
                        "steps": [
                            { "kind": "material", "recipeId": "iron", "batches": 1, "outputItemId": "iron_ore", "outputAmount": 1 },
                            { "kind": "building", "constructionId": "wind_turbine" }
                        ],
                        "elapsedSeconds": 0.5,
                        "inventory": { "iron_ore": 2 }
                    }
                }
            }
        })
        .as_object()
        .unwrap()
        .clone();
        let entities = vec![
            json!({
                "id": "center-a",
                "kind": "machine",
                "planetId": "home",
                "position": { "x": 5, "y": 6 },
                "interactionLocked": false,
                "buildingId": "construction_center",
                "recipeId": null,
                "machineCount": 2,
                "minerCount": 0,
                "inputs": {},
                "outputs": {},
                "progress": 0,
                "utilization": 0,
                "productionRate": 0
            })
            .to_string(),
        ];
        CoreState::from_public_v47_parts(
            CoreCheckpointIdentity {
                slot: "normal-main".to_owned(),
                generation: 1,
                root_hash: "c".repeat(64),
                revision: 19,
                state_version: 47,
                mode: "normal".to_owned(),
                registry_fingerprint: registry_fingerprint.to_owned(),
                base_primary_checksum: "12345678".to_owned(),
            },
            base,
            entities,
            Vec::new(),
            catalog,
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
    fn built_in_construction_center_projection_is_named_bounded_and_stock_correct() {
        let state = construction_center_state(EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT, false);
        let before = state.summary().unwrap().canonical_sha256;
        let projection = state.factory_read_model_projection(&[], &[]).unwrap();
        let workspace = &projection["construction"]["nativeCenterWorkspace"];
        assert_eq!(workspace["schema"], "construction-center-workspace-v1");
        assert_eq!(
            workspace["registryFingerprint"],
            EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT
        );
        assert_eq!(workspace["readOnly"], true);
        assert_eq!(workspace["writeAvailable"], true);
        assert_eq!(workspace["activePlanetId"], "home");
        assert_eq!(workspace["activePlanetName"], "家园星");
        assert_eq!(workspace["limits"]["targetRows"], MAX_TARGET_ROWS);
        assert_eq!(
            workspace["limits"]["centerRows"],
            MAX_CONSTRUCTION_CENTER_ROWS
        );
        assert_eq!(
            workspace["limits"]["materialRows"],
            MAX_CONSTRUCTION_MATERIAL_ROWS
        );
        assert_eq!(workspace["limits"]["projectionBytes"], MAX_PROJECTION_BYTES);
        assert_eq!(workspace["targets"]["totalCount"], 3);
        assert_eq!(workspace["targets"]["truncated"], false);
        let targets = workspace["targets"]["rows"].as_array().unwrap();
        let building = targets
            .iter()
            .find(|row| row["targetId"] == "wind_turbine")
            .unwrap();
        assert_eq!(building["name"], "风力涡轮机");
        assert_eq!(building["kind"], "building");
        assert_eq!(building["category"], "power");
        assert_eq!(building["target"], 50);
        assert_eq!(building["currentStock"], 41);
        assert_eq!(building["unlocked"], true);
        assert_eq!(building["requiredTechName"], "电磁学");
        assert_eq!(building["outputAmount"], 1);
        assert_eq!(building["costs"]["rows"][0]["name"], "铁矿石");
        let fleet = targets
            .iter()
            .find(|row| row["targetId"] == "logistics_drone")
            .unwrap();
        assert_eq!(fleet["name"], "物流运输机");
        assert_eq!(fleet["kind"], "fleet");
        assert_eq!(fleet["category"], "logistics");
        assert_eq!(fleet["target"], 10);
        assert_eq!(fleet["currentStock"], 7);
        assert_eq!(workspace["centers"]["totalCount"], 1);
        assert_eq!(workspace["centers"]["rows"][0]["status"], "working");
        assert_eq!(workspace["centers"]["rows"][0]["machineCount"], 2);
        assert_eq!(workspace["jobs"]["rows"][0]["targetName"], "风力涡轮机");
        assert_eq!(workspace["jobs"]["rows"][0]["inventory"]["totalAmount"], 2);
        assert_eq!(workspace["materials"]["totalAmount"], 123);
        assert_eq!(workspace["quantumBuffer"]["totalAmount"], 4);
        assert_eq!(workspace["destroyedByproducts"]["totalAmount"], 3);
        assert!(serde_json::to_vec(&projection).unwrap().len() <= MAX_PROJECTION_BYTES);
        assert_eq!(state.summary().unwrap().canonical_sha256, before);
    }

    #[test]
    fn construction_center_write_availability_is_global_and_fails_closed() {
        let mut remote_view =
            construction_center_state(EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT, false);
        remote_view.base_value_mut()["activePlanetId"] = Value::from("remote");
        let remote_projection = remote_view.factory_read_model_projection(&[], &[]).unwrap();
        let remote_workspace = &remote_projection["construction"]["nativeCenterWorkspace"];
        assert_eq!(remote_workspace["centers"]["totalCount"], 0);
        assert_eq!(remote_workspace["writeAvailable"], true);

        for completed_tech_ids in [
            json!(["electromagnetism", "planetary_logistics"]),
            json!(["construction_automation ", "electromagnetism"]),
            Value::from("construction_automation"),
        ] {
            let mut technology_locked =
                construction_center_state(EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT, false);
            technology_locked.base_value_mut()["research"]["completedTechIds"] = completed_tech_ids;
            let locked_projection = technology_locked
                .factory_read_model_projection(&[], &[])
                .unwrap();
            assert_eq!(
                locked_projection["construction"]["nativeCenterWorkspace"]["writeAvailable"],
                false
            );
        }

        for malformed in [
            "kind",
            "locked",
            "zero-machines",
            "missing-machines",
            "negative-machines",
            "fractional-machines",
            "unsafe-machines",
            "missing-lock",
        ] {
            let mut state =
                construction_center_state(EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT, false);
            state.base_value_mut()["activePlanetId"] = Value::from("remote");
            let center_index = *state.entity_index.get("center-a").unwrap();
            let mut center = state.parse_entity(center_index).unwrap();
            match malformed {
                "kind" => center["kind"] = Value::from("storage"),
                "locked" => center["interactionLocked"] = Value::from(true),
                "zero-machines" => center["machineCount"] = Value::from(0),
                "missing-machines" => {
                    center.as_object_mut().unwrap().remove("machineCount");
                }
                "negative-machines" => center["machineCount"] = Value::from(-1),
                "fractional-machines" => center["machineCount"] = Value::from(1.5),
                "unsafe-machines" => {
                    center["machineCount"] = Value::from(MAX_JAVASCRIPT_SAFE_INTEGER + 1)
                }
                "missing-lock" => {
                    center.as_object_mut().unwrap().remove("interactionLocked");
                }
                _ => unreachable!(),
            }
            state.replace_entity_raw(center_index, center.to_string().into());
            let projection = state.factory_read_model_projection(&[], &[]).unwrap();
            assert_eq!(
                projection["construction"]["nativeCenterWorkspace"]["writeAvailable"], false,
                "{malformed}"
            );
        }

        for malformed in ["building-kind", "construction-technology"] {
            let mut state =
                construction_center_state(EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT, false);
            let catalog = Arc::make_mut(&mut state.catalog);
            match malformed {
                "building-kind" => {
                    catalog
                        .buildings
                        .get_mut("construction_center")
                        .unwrap()
                        .kind = "storage".to_owned();
                }
                "construction-technology" => {
                    catalog
                        .constructions
                        .get_mut("construction_center")
                        .unwrap()
                        .required_tech_id = None;
                }
                _ => unreachable!(),
            }
            let projection = state.factory_read_model_projection(&[], &[]).unwrap();
            assert_eq!(
                projection["construction"]["nativeCenterWorkspace"]["writeAvailable"], false,
                "{malformed}"
            );
        }
    }

    #[test]
    fn construction_write_eligibility_does_not_parse_large_non_center_population() {
        let mut state = construction_center_state(EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT, false);
        let first_non_center = state.entity_raw_mut_topology().len();
        {
            let entities = state.entity_raw_mut_topology();
            for index in 0..4_096 {
                entities.push(
                    json!({
                        "id": format!("bulk-non-center-{index}"),
                        "kind": "storage",
                        "planetId": "home",
                        "position": { "x": index, "y": 0 },
                        "interactionLocked": false,
                        "buildingId": "construction_center",
                        "recipeId": null,
                        "machineCount": 1,
                        "minerCount": 0,
                        "inputs": {},
                        "outputs": {},
                        "progress": 0,
                        "utilization": 0,
                        "productionRate": 0
                    })
                    .to_string()
                    .into(),
                );
            }
        }
        state.rebuild_indexes().unwrap();
        assert_eq!(state.factory_topology.construction_center_indices.len(), 1);

        // Make every non-center row unparsable after the topology proof. The
        // shared eligibility check must still read only the one center index.
        for raw in &mut state.entity_raw_mut_topology()[first_non_center..] {
            *raw = Arc::<str>::from("not-json");
        }
        assert_eq!(
            crate::command::construction_automation_write_eligibility(&state).unwrap(),
            crate::command::ConstructionAutomationWriteEligibility::Available
        );
    }

    #[test]
    fn construction_center_workspace_fails_closed_for_mod_or_unknown_directories() {
        for state in [
            construction_center_state("content-pack:mod", false),
            construction_center_state(EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT, true),
        ] {
            let before = state.summary().unwrap().canonical_sha256;
            let projection = state.factory_read_model_projection(&[], &[]).unwrap();
            assert!(projection["construction"]["nativeCenterWorkspace"].is_null());
            assert_eq!(state.summary().unwrap().canonical_sha256, before);
        }
    }

    #[test]
    fn construction_center_workspace_fails_closed_for_present_invalid_state_fields() {
        for malformed_field in [
            "paused",
            "quantum-source-enabled",
            "quantum-buffer-directory",
            "quantum-network-directory",
            "quantum-network-enabled",
        ] {
            let mut state =
                construction_center_state(EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT, false);
            let base = state.base_value_mut();
            match malformed_field {
                "paused" => {
                    base.insert("paused".to_owned(), Value::from("invalid"));
                }
                "quantum-source-enabled" => {
                    base.get_mut("constructionAutomation")
                        .and_then(Value::as_object_mut)
                        .unwrap()
                        .insert("quantumSourceEnabled".to_owned(), Value::from("invalid"));
                }
                "quantum-buffer-directory" => {
                    base.get_mut("constructionAutomation")
                        .and_then(Value::as_object_mut)
                        .unwrap()
                        .insert("quantumMaterialBuffer".to_owned(), json!([]));
                }
                "quantum-network-directory" => {
                    base.insert("quantumLogisticsNetwork".to_owned(), json!([]));
                }
                "quantum-network-enabled" => {
                    base.get_mut("quantumLogisticsNetwork")
                        .and_then(Value::as_object_mut)
                        .unwrap()
                        .insert("enabled".to_owned(), Value::from("invalid"));
                }
                _ => unreachable!(),
            }
            let before = state.summary().unwrap().canonical_sha256;
            let projection = state.factory_read_model_projection(&[], &[]).unwrap();
            assert!(
                projection["construction"]["nativeCenterWorkspace"].is_null(),
                "{malformed_field}"
            );
            assert_eq!(state.summary().unwrap().canonical_sha256, before);
        }
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
        // Keep the configured `iron_ore` binding valid but place it exactly
        // one row beyond the bounded catalog page. The projection must not
        // reject or hide the current slot merely because that item is the
        // 129th stable option.
        snapshot
            .items
            .extend((0..MAX_STATION_ITEM_OPTIONS).map(|index| {
                ItemDefinition {
                    id: format!("a_item_{index:03}"),
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
        assert_eq!(options["totalCount"], MAX_STATION_ITEM_OPTIONS + 1);
        assert_eq!(options["truncated"], true);
        assert_eq!(rows.len(), MAX_STATION_ITEM_OPTIONS);
        assert_eq!(rows[0]["itemId"], "a_item_000");
        assert_eq!(rows[MAX_STATION_ITEM_OPTIONS - 1]["itemId"], "a_item_127");
        assert!(rows.iter().all(|row| row["itemId"] != "iron_ore"));
        assert_eq!(
            first["selection"]["entityRows"]["rows"][0]["stationConfiguration"]["slots"][2]["itemId"],
            "iron_ore"
        );
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
