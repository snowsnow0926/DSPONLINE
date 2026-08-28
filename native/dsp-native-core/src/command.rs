use anyhow::{anyhow, bail};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;
use std::{
    collections::{BTreeMap, HashSet},
    sync::Arc,
};

use crate::state::CoreState;

const MAX_PLAYER_BUILDING_STACK: u64 = 100_000_000;
const MAX_PLAYER_BELT_LANES: u64 = 4_096;
const MAX_JAVASCRIPT_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const MAX_PLAYER_ORBIT_ID_BYTES: usize = 160;
const BELT_ROUTE_MODES: &[&str] = &["bezier", "auto", "upper", "lower", "manual"];
/// FNV-1a fingerprint produced by `createContentPackRegistry()` with no packs.
/// The current CORE catalog omits the optional MOD `stackLimit`, so positive
/// stack changes are only provable when no content pack can have overridden a
/// core building's limit.  Non-empty registries remain fail-closed until that
/// bound is carried by a future, explicitly versioned catalog protocol.
const EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT: &str = "7df8cf3a";

const BUILTIN_ORDINARY_STACK_BUILDINGS: &[&str] = &[
    "accumulator",
    "arc_smelter",
    "artificial_star",
    "assembling_machine_mk1",
    "assembling_machine_mk2",
    "assembling_machine_mk3",
    "chemical_plant",
    "em_rail_ejector",
    "energy_exchanger",
    "fractionator",
    "geothermal_power_station",
    "matrix_lab",
    "mini_fusion_power_plant",
    "miniature_particle_collider",
    "oil_refinery",
    "plane_smelter",
    "quantum_chemical_plant",
    "ray_receiver",
    "solar_panel",
    "splitter_4way",
    "spray_coater",
    "storage_mk1",
    "storage_tank",
    "thermal_power_plant",
    "vertical_launching_silo",
    "wind_turbine",
];

const UNSUPPORTED_ORDINARY_PLACEMENT_BUILDINGS: &[&str] = &[
    "galactic_material_exporter",
    "geothermal_power_station",
    "material_delivery_hub",
    "micro_black_hole_connector",
    "orbital_cargo_terminal",
    "space_station_construction_launcher",
    "time_warp_device",
];

const UNSUPPORTED_ORDINARY_REMOVAL_BUILDINGS: &[&str] = &[
    "construction_center",
    "galactic_material_exporter",
    "material_delivery_hub",
    "micro_black_hole_connector",
    "orbital_cargo_terminal",
    "space_station_construction_launcher",
    "time_warp_device",
];

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(untagged)]
pub enum PathSegment {
    Key(String),
    Index(usize),
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ValuePatch {
    pub path: Vec<PathSegment>,
    pub operation: String,
    #[serde(default, deserialize_with = "deserialize_present_patch_value")]
    pub value: Option<Value>,
}

/// `Option<Value>` normally decodes an explicit JSON `null` as `None`, which
/// would make a player command unable to distinguish `set null` from an
/// omitted value on `delete`. The renderer command protocol deliberately uses
/// that distinction. Serialization keeps the established durable `value:null`
/// form for an omitted delete value; the Host accepts the renderer omission
/// only after proving it is exactly that legacy-compatible form.
fn deserialize_present_patch_value<'de, D>(deserializer: D) -> Result<Option<Value>, D::Error>
where
    D: Deserializer<'de>,
{
    Value::deserialize(deserializer).map(Some)
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordPatch {
    pub id: String,
    pub changes: Vec<ValuePatch>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AddedRecord {
    pub index: usize,
    pub value: Value,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SimulationCommandPatch {
    pub protocol_version: u16,
    pub base_revision: u64,
    pub top_level_changes: Vec<ValuePatch>,
    pub changed_entities: Vec<RecordPatch>,
    pub added_entities: Vec<AddedRecord>,
    pub removed_entity_ids: Vec<String>,
    pub changed_belts: Vec<RecordPatch>,
    pub added_belts: Vec<AddedRecord>,
    pub removed_belt_ids: Vec<String>,
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandApplyResult {
    pub previous_revision: u64,
    pub revision: u64,
    pub changed_entity_ids: Vec<String>,
    pub changed_belt_ids: Vec<String>,
    pub topology_dirty: bool,
}

fn container_at_mut<'a>(
    root: &'a mut Value,
    path: &[PathSegment],
) -> anyhow::Result<&'a mut Value> {
    let mut cursor = root;
    for segment in path {
        cursor = match segment {
            PathSegment::Key(key) => cursor
                .as_object_mut()
                .and_then(|object| object.get_mut(key))
                .ok_or_else(|| anyhow!("native command path key is missing"))?,
            PathSegment::Index(index) => cursor
                .as_array_mut()
                .and_then(|array| array.get_mut(*index))
                .ok_or_else(|| anyhow!("native command path index is missing"))?,
        };
    }
    Ok(cursor)
}

fn apply_value_patch(root: &mut Value, patch: &ValuePatch) -> anyhow::Result<()> {
    if patch.path.len() > 64 {
        bail!("native command patch path is too deep")
    }
    if patch.path.is_empty() {
        match patch.operation.as_str() {
            "set" => {
                *root = patch
                    .value
                    .clone()
                    .ok_or_else(|| anyhow!("native set patch has no value"))?
            }
            "delete" => bail!("native command cannot delete a record root"),
            _ => bail!("native command patch operation is invalid"),
        }
        return Ok(());
    }
    let (parent_path, leaf) = patch.path.split_at(patch.path.len() - 1);
    let parent = container_at_mut(root, parent_path)?;
    match (&leaf[0], patch.operation.as_str()) {
        (PathSegment::Key(key), "set") => {
            parent
                .as_object_mut()
                .ok_or_else(|| anyhow!("native command patch parent is not an object"))?
                .insert(
                    key.clone(),
                    patch
                        .value
                        .clone()
                        .ok_or_else(|| anyhow!("native set patch has no value"))?,
                );
        }
        (PathSegment::Key(key), "delete") => {
            parent
                .as_object_mut()
                .ok_or_else(|| anyhow!("native command patch parent is not an object"))?
                .remove(key);
        }
        (PathSegment::Index(index), "set") => {
            let target = parent
                .as_array_mut()
                .and_then(|array| array.get_mut(*index))
                .ok_or_else(|| anyhow!("native command patch array index is invalid"))?;
            *target = patch
                .value
                .clone()
                .ok_or_else(|| anyhow!("native set patch has no value"))?;
        }
        (PathSegment::Index(_), "delete") => {
            bail!("native command does not delete an array element by index")
        }
        (_, _) => bail!("native command patch operation is invalid"),
    }
    Ok(())
}

fn apply_record_changes(value: &mut Value, changes: &[ValuePatch]) -> anyhow::Result<()> {
    if changes.len() > 16_384 {
        bail!("native command contains too many record changes")
    }
    for change in changes {
        apply_value_patch(value, change)?;
    }
    Ok(())
}

fn command_requires_production_history_rebuild(command: &SimulationCommandPatch) -> bool {
    command
        .top_level_changes
        .iter()
        .any(|change| match change.path.first() {
            Some(PathSegment::Key(key))
                if matches!(
                    key.as_str(),
                    "productionHistory" | "historyRecordedAt" | "elapsedSeconds"
                ) =>
            {
                true
            }
            Some(PathSegment::Key(key)) => !crate::state::is_known_base_checkpoint_key(key),
            // A root replacement or a non-object top-level path cannot prove
            // that the public history source remains byte-for-byte unchanged.
            None | Some(PathSegment::Index(_)) => true,
        })
}

fn top_level_change_is_projection_safe(change: &ValuePatch) -> bool {
    if matches!(
        change.path.as_slice(),
        [PathSegment::Key(root), PathSegment::Key(field)]
            if root == "recipeFocus" && matches!(field.as_str(), "itemId" | "mode")
    ) || matches!(
        change.path.as_slice(),
        [
            PathSegment::Key(root),
            PathSegment::Key(position),
            PathSegment::Key(axis),
        ] if root == "recipeFocus"
            && position == "position"
            && matches!(axis.as_str(), "x" | "y")
    ) || matches!(
        change.path.as_slice(),
        [
            PathSegment::Key(root),
            PathSegment::Key(_planet_id),
            PathSegment::Key(field),
        ] if root == "planetViewports"
            && matches!(field.as_str(), "x" | "y" | "zoom")
            && change.operation == "set"
            && change.value.is_some()
    ) {
        return true;
    }
    matches!(
        change.path.first(),
        Some(PathSegment::Key(key)) if matches!(
            key.as_str(),
            "paused"
                | "elapsedSeconds"
                | "lastSavedAt"
                | "totalProduced"
                | "productionHistory"
                | "metrics"
                | "planetMetrics"
                | "powerGridMetrics"
                | "canvasBookmarks"
                | "canvasRegions"
                | "timeWarp"
                | "idleSettlement"
        )
    )
}

fn entity_change_is_projection_safe(change: &ValuePatch) -> bool {
    matches!(
        change.path.first(),
        Some(PathSegment::Key(key)) if matches!(
            key.as_str(),
            "position"
                | "inputs"
                | "outputs"
                | "progress"
                | "routingCursor"
                | "utilization"
                | "productionRate"
                | "powerFactor"
                | "stationProgress"
                | "stationTrips"
                | "stationLastTransfer"
                | "stationDrones"
                | "stationVessels"
                | "stationWarpers"
                | "stationCongestion"
                | "stationDispatchCursor"
                | "stationLastSupplyPeerBySlot"
                | "stationRoutes"
                | "fuelRemainingMj"
                | "powerOutputKw"
                | "powerInputKw"
                | "storedEnergyMj"
                | "orbitalCargoProgress"
                | "orbitalCargoTotalUploaded"
                | "blackHolePorts"
                | "proliferatorBonusProgress"
        )
    )
}

fn belt_change_is_projection_safe(change: &ValuePatch) -> bool {
    matches!(
        change.path.first(),
        Some(PathSegment::Key(key)) if matches!(
            key.as_str(),
            "progress" | "totalTransferred" | "congestion" | "lastFlow" | "monitorEnabled"
        )
    )
}

fn path_matches(path: &[PathSegment], expected: &[&str]) -> bool {
    path.len() == expected.len()
        && path
            .iter()
            .zip(expected)
            .all(|(actual, expected)| matches!(actual, PathSegment::Key(key) if key == expected))
}

fn require_exact_set_patch<'a>(
    patches: &'a [ValuePatch],
    expected_path: &[&str],
) -> anyhow::Result<&'a Value> {
    let mut found = None;
    for patch in patches {
        if !path_matches(&patch.path, expected_path) {
            continue;
        }
        if found.is_some() {
            bail!("native player-authority command repeats a protected patch")
        }
        if patch.operation != "set" {
            bail!("native player-authority protected patch operation is invalid")
        }
        found = Some(
            patch
                .value
                .as_ref()
                .ok_or_else(|| anyhow!("native player-authority protected set has no value"))?,
        );
    }
    found.ok_or_else(|| anyhow!("native player-authority protected patch is missing"))
}

fn safe_json_integer(value: Option<&Value>, label: &str) -> anyhow::Result<u64> {
    value
        .and_then(Value::as_u64)
        .filter(|value| *value <= MAX_JAVASCRIPT_SAFE_INTEGER)
        .ok_or_else(|| anyhow!("native player-authority {label} is not a safe integer"))
}

fn finite_json_number(value: Option<&Value>, label: &str) -> anyhow::Result<f64> {
    value
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
        .ok_or_else(|| anyhow!("native player-authority {label} is not a finite number"))
}

fn normalized_construction_inventory(value: Option<&Value>) -> anyhow::Result<u64> {
    let Some(value) = value else {
        return Ok(0);
    };
    if value.is_null() {
        return Ok(0);
    }
    let value = value
        .as_f64()
        .filter(|value| value.is_finite())
        .ok_or_else(|| anyhow!("native player-authority construction inventory is invalid"))?;
    let value = value.floor().max(0.0);
    if value > MAX_JAVASCRIPT_SAFE_INTEGER as f64 {
        bail!("native player-authority construction inventory exceeds the safe integer limit")
    }
    Ok(value as u64)
}

fn technology_is_completed(state: &CoreState, technology_id: &str) -> bool {
    state
        .base_value()
        .get("research")
        .and_then(Value::as_object)
        .and_then(|research| research.get("completedTechIds"))
        .and_then(Value::as_array)
        .is_some_and(|completed| {
            completed
                .iter()
                .any(|candidate| candidate.as_str() == Some(technology_id))
        })
}

fn recipe_building_base<'a>(building_id: &'a str, family: Option<&str>) -> &'a str {
    match family {
        Some("smelter") => "arc_smelter",
        Some("assembler") => "assembling_machine_mk1",
        Some("chemical") => "chemical_plant",
        _ => building_id,
    }
}

fn default_placement_recipe(state: &CoreState, building_id: &str) -> Option<String> {
    let building = state.catalog.buildings.get(building_id)?;
    let base_building_id = recipe_building_base(building_id, building.family.as_deref());
    state
        .catalog
        .snapshot
        .recipes
        .iter()
        .find(|recipe| {
            recipe.building_id == base_building_id
                && recipe
                    .required_tech_id
                    .as_deref()
                    .is_none_or(|technology_id| technology_is_completed(state, technology_id))
        })
        .map(|recipe| recipe.id.clone())
}

fn active_or_first_dyson_orbit(
    state: &CoreState,
    planet_id: &str,
) -> anyhow::Result<Option<String>> {
    let system_id = state
        .catalog
        .planets
        .iter()
        .find(|planet| planet.id == planet_id)
        .map(|planet| planet.system_id.as_str())
        .ok_or_else(|| anyhow!("native player-authority placement planet is not in the catalog"))?;
    let engineering = state
        .base_value()
        .get("dysonEngineering")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("native player-authority Dyson engineering state is missing"))?;
    let orbits = engineering
        .get("orbitsBySystem")
        .and_then(Value::as_object)
        .and_then(|systems| systems.get(system_id))
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("native player-authority Dyson orbit directory is invalid"))?;
    let active = engineering
        .get("activeOrbitBySystem")
        .and_then(Value::as_object)
        .and_then(|systems| systems.get(system_id))
        .and_then(Value::as_str);
    if let Some(active) = active
        && !active.is_empty()
        && active.len() <= MAX_PLAYER_ORBIT_ID_BYTES
        && orbits.iter().any(|orbit| {
            orbit
                .get("id")
                .and_then(Value::as_str)
                .is_some_and(|id| id == active)
        })
    {
        return Ok(Some(active.to_owned()));
    }
    orbits
        .first()
        .map(|orbit| {
            orbit
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty() && id.len() <= MAX_PLAYER_ORBIT_ID_BYTES)
                .map(str::to_owned)
                .ok_or_else(|| anyhow!("native player-authority Dyson orbit ID is invalid"))
        })
        .transpose()
}

fn expected_ordinary_placement_entity(
    state: &CoreState,
    addition: &AddedRecord,
) -> anyhow::Result<(String, u64)> {
    if addition.index != state.entity_index.len() {
        bail!("native player-authority building placement is not appended")
    }
    let entity = addition
        .value
        .as_object()
        .ok_or_else(|| anyhow!("native player-authority placed entity is not an object"))?;
    let building_id = entity
        .get("buildingId")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("native player-authority placed building ID is missing"))?;
    let building =
        state.catalog.buildings.get(building_id).ok_or_else(|| {
            anyhow!("native player-authority placed building is not in the catalog")
        })?;
    let construction = state
        .catalog
        .constructions
        .get(building_id)
        .ok_or_else(|| {
            anyhow!("native player-authority placed building has no construction definition")
        })?;
    if construction
        .required_tech_id
        .as_deref()
        .is_some_and(|technology_id| !technology_is_completed(state, technology_id))
    {
        bail!("native player-authority placed building technology is locked")
    }
    if matches!(building.kind.as_str(), "miner" | "station")
        || !matches!(
            building.kind.as_str(),
            "machine" | "power" | "storage" | "splitter"
        )
        || UNSUPPORTED_ORDINARY_PLACEMENT_BUILDINGS.contains(&building_id)
    {
        bail!("native player-authority building placement domain is not covered")
    }
    let machine_count = safe_json_integer(entity.get("machineCount"), "building stack")?;
    // The current native catalog intentionally does not carry the optional
    // MOD `stackLimit`. A single-unit placement is valid for every accepted
    // catalog definition; larger placement batches stay fail-closed until
    // that bound can be proved without changing the CORE protocol.
    if machine_count != 1 {
        bail!("native player-authority building placement must contain one unit")
    }
    let next_id = safe_json_integer(state.base_value().get("nextId"), "next entity ID")?;
    if next_id == MAX_JAVASCRIPT_SAFE_INTEGER {
        bail!("native player-authority next entity ID is exhausted")
    }
    let expected_id = format!("entity_{next_id}");
    if entity.get("id").and_then(Value::as_str) != Some(expected_id.as_str()) {
        bail!("native player-authority placed entity ID is not the next deterministic ID")
    }
    let active_planet_id = state
        .base_value()
        .get("activePlanetId")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("native player-authority active planet is missing"))?;
    if entity.get("planetId").and_then(Value::as_str) != Some(active_planet_id)
        || !state
            .catalog
            .planets
            .iter()
            .any(|planet| planet.id == active_planet_id && planet.kind == "terrestrial")
    {
        bail!("native player-authority placed entity planet is invalid")
    }
    let position = entity
        .get("position")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("native player-authority building position is invalid"))?;
    let x = position
        .get("x")
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
        .ok_or_else(|| anyhow!("native player-authority building X position is invalid"))?;
    let y = position
        .get("y")
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
        .ok_or_else(|| anyhow!("native player-authority building Y position is invalid"))?;

    let entity_kind = match building.kind.as_str() {
        "power" => "power",
        "storage" => "storage",
        "splitter" => "splitter",
        _ => "machine",
    };
    let mut expected = serde_json::Map::new();
    for (key, value) in [
        ("id", Value::from(expected_id)),
        ("kind", Value::from(entity_kind)),
        ("planetId", Value::from(active_planet_id)),
        ("position", serde_json::json!({ "x": x, "y": y })),
        ("interactionLocked", Value::from(false)),
        ("buildingId", Value::from(building_id)),
        ("powerGridId", Value::from("grid-a")),
        ("powerPriority", Value::from(2)),
        ("machineCount", Value::from(machine_count)),
        ("minerCount", Value::from(0)),
        ("inputs", serde_json::json!({})),
        ("outputs", serde_json::json!({})),
        ("progress", Value::from(0)),
        ("routingCursor", Value::from(0)),
        ("utilization", Value::from(0)),
        ("productionRate", Value::from(0)),
    ] {
        expected.insert(key.to_owned(), value);
    }
    if building.kind == "power" {
        let generation_priority =
            if building_id == "accumulator" || !building.fuel_item_ids.is_empty() {
                1
            } else if building_id == "energy_exchanger" {
                2
            } else {
                3
            };
        expected.insert(
            "generationPriority".to_owned(),
            Value::from(generation_priority),
        );
        expected.insert("powerOutputKw".to_owned(), Value::from(0));
        expected.insert("powerInputKw".to_owned(), Value::from(0));
    }
    if let Some(recipe_id) = default_placement_recipe(state, building_id) {
        expected.insert("recipeId".to_owned(), Value::from(recipe_id));
    }
    if building_id == "em_rail_ejector"
        && let Some(orbit_id) = active_or_first_dyson_orbit(state, active_planet_id)?
    {
        expected.insert("targetDysonOrbitId".to_owned(), Value::from(orbit_id));
    }
    if building.kind == "splitter" {
        expected.insert("distributionMode".to_owned(), Value::from("balanced"));
    }
    if !building.fuel_item_ids.is_empty() {
        expected.insert("fuelRemainingMj".to_owned(), Value::from(0));
    }
    if matches!(building_id, "accumulator" | "energy_exchanger") {
        expected.insert("storedEnergyMj".to_owned(), Value::from(0));
        expected.insert(
            "energyMode".to_owned(),
            Value::from(if building_id == "accumulator" {
                "auto"
            } else {
                "charge"
            }),
        );
    }
    if addition.value != Value::Object(expected) {
        bail!("native player-authority placed entity fields are not canonical")
    }
    Ok((building_id.to_owned(), machine_count))
}

fn validate_ordinary_building_placement(
    state: &CoreState,
    command: &SimulationCommandPatch,
) -> anyhow::Result<()> {
    if command.added_entities.len() != 1
        || !command.changed_entities.is_empty()
        || !command.removed_entity_ids.is_empty()
        || !command.changed_belts.is_empty()
        || !command.added_belts.is_empty()
        || !command.removed_belt_ids.is_empty()
        || command.top_level_changes.len() != 2
    {
        bail!("native player-authority building placement shape is invalid")
    }
    let (building_id, machine_count) =
        expected_ordinary_placement_entity(state, &command.added_entities[0])?;
    let construction = state
        .base_value()
        .get("construction")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("native player-authority construction inventory is missing"))?;
    let available = safe_json_integer(construction.get(&building_id), "construction inventory")?;
    let remaining = available.checked_sub(machine_count).ok_or_else(|| {
        anyhow!("native player-authority building construction stock is insufficient")
    })?;
    let construction_value = require_exact_set_patch(
        &command.top_level_changes,
        &["construction", building_id.as_str()],
    )?;
    if construction_value.as_u64() != Some(remaining) {
        bail!("native player-authority building construction debit is invalid")
    }
    let next_id = safe_json_integer(state.base_value().get("nextId"), "next entity ID")?;
    if require_exact_set_patch(&command.top_level_changes, &["nextId"])?.as_u64()
        != next_id.checked_add(1)
    {
        bail!("native player-authority building next ID increment is invalid")
    }
    Ok(())
}

fn ordinary_removal_entity(
    state: &CoreState,
    entity_id: &str,
) -> anyhow::Result<(Value, String, u64)> {
    let index = *state
        .entity_index
        .get(entity_id)
        .ok_or_else(|| anyhow!("native player-authority removal entity is missing"))?;
    let entity = state.parse_entity(index)?;
    let object = entity
        .as_object()
        .ok_or_else(|| anyhow!("native player-authority removal entity is invalid"))?;
    if object.get("interactionLocked").and_then(Value::as_bool) == Some(true) {
        bail!("native player-authority removal entity is locked")
    }
    let building_id = object
        .get("buildingId")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("native player-authority removal building ID is missing"))?
        .to_owned();
    let building =
        state.catalog.buildings.get(&building_id).ok_or_else(|| {
            anyhow!("native player-authority removal building is not in the catalog")
        })?;
    if !state.catalog.constructions.contains_key(&building_id)
        || matches!(building.kind.as_str(), "miner" | "station")
        || !matches!(
            building.kind.as_str(),
            "machine" | "power" | "storage" | "splitter"
        )
        || UNSUPPORTED_ORDINARY_REMOVAL_BUILDINGS.contains(&building_id.as_str())
    {
        bail!("native player-authority removal building domain is not covered")
    }
    let expected_kind = match building.kind.as_str() {
        "power" => "power",
        "storage" => "storage",
        "splitter" => "splitter",
        _ => "machine",
    };
    if object.get("kind").and_then(Value::as_str) != Some(expected_kind) {
        bail!("native player-authority removal entity kind conflicts with the catalog")
    }
    let machine_count = safe_json_integer(object.get("machineCount"), "building stack")?;
    if machine_count == 0 {
        bail!("native player-authority removal building stack is empty")
    }
    Ok((entity, building_id, machine_count))
}

fn queue_or_blueprint_pruning_would_change(state: &CoreState, entity_id: &str) -> bool {
    let queue = state
        .base_value()
        .get("constructionQueue")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    if queue.iter().any(|entry| {
        let status = entry
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("pending-materials");
        status == "waiting-fleet"
            && entry
                .get("placedEntityIdsByKey")
                .and_then(Value::as_object)
                .is_some_and(|ids| ids.values().any(|value| value.as_str() == Some(entity_id)))
    }) {
        return true;
    }
    let referenced_versions = queue
        .iter()
        .filter_map(|entry| entry.get("blueprintVersionId").and_then(Value::as_str))
        .collect::<HashSet<_>>();
    state
        .base_value()
        .get("blueprintVersions")
        .and_then(Value::as_array)
        .is_some_and(|versions| {
            versions.iter().any(|version| {
                version
                    .get("id")
                    .and_then(Value::as_str)
                    .is_none_or(|id| !referenced_versions.contains(id))
            })
        })
}

fn validate_ordinary_building_stack_change(
    state: &CoreState,
    command: &SimulationCommandPatch,
) -> anyhow::Result<()> {
    if command.changed_entities.len() != 1
        || command.changed_entities[0].changes.len() != 1
        || command.top_level_changes.len() != 1
        || !command.added_entities.is_empty()
        || !command.removed_entity_ids.is_empty()
        || !command.changed_belts.is_empty()
        || !command.added_belts.is_empty()
        || !command.removed_belt_ids.is_empty()
    {
        bail!("native player-authority building stack change shape is invalid")
    }
    let record = &command.changed_entities[0];
    let (_, building_id, current) = ordinary_removal_entity(state, &record.id)?;
    let target = require_exact_set_patch(&record.changes, &["machineCount"])?
        .as_u64()
        .filter(|value| *value <= MAX_PLAYER_BUILDING_STACK)
        .ok_or_else(|| anyhow!("native player-authority building stack target is invalid"))?;
    if target == 0 || target == current {
        bail!("native player-authority building stack command is unchanged")
    }
    let construction = state
        .base_value()
        .get("construction")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("native player-authority construction inventory is missing"))?;
    let previous = if target > current {
        // Content packs may override a core building's optional stackLimit,
        // while the existing CORE protocol deliberately omits that field.
        // Prove the built-in, unbounded definition instead of guessing that a
        // catalog-shaped MOD entry has the same player semantics.
        if state.catalog.snapshot.registry_fingerprint != EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT
            || !BUILTIN_ORDINARY_STACK_BUILDINGS.contains(&building_id.as_str())
        {
            bail!("native player-authority building stack limit is not provable")
        }
        safe_json_integer(construction.get(&building_id), "construction inventory")?
    } else {
        normalized_construction_inventory(construction.get(&building_id))?
    };
    let expected = if target > current {
        previous.checked_sub(target - current).ok_or_else(|| {
            anyhow!("native player-authority building construction stock is insufficient")
        })?
    } else {
        previous
            .checked_add(current - target)
            .filter(|value| *value <= MAX_JAVASCRIPT_SAFE_INTEGER)
            .ok_or_else(|| anyhow!("native player-authority building refund overflows"))?
    };
    if require_exact_set_patch(
        &command.top_level_changes,
        &["construction", building_id.as_str()],
    )?
    .as_u64()
        != Some(expected)
    {
        bail!("native player-authority building stack inventory adjustment is invalid")
    }
    Ok(())
}

fn validate_ordinary_building_removal(
    state: &CoreState,
    command: &SimulationCommandPatch,
) -> anyhow::Result<()> {
    if command.removed_entity_ids.len() != 1
        || command.top_level_changes.len() != 1
        || !command.changed_entities.is_empty()
        || !command.added_entities.is_empty()
        || !command.changed_belts.is_empty()
        || !command.added_belts.is_empty()
        || !command.removed_belt_ids.is_empty()
    {
        bail!("native player-authority ordinary building removal shape is invalid")
    }
    let entity_id = &command.removed_entity_ids[0];
    let (entity, building_id, machine_count) = ordinary_removal_entity(state, entity_id)?;
    let object = entity.as_object().expect("validated entity object");
    if object.get("sprayCoaterInstalled").and_then(Value::as_bool) == Some(true)
        || ["inputs", "outputs"].iter().any(|key| {
            object
                .get(*key)
                .and_then(Value::as_object)
                .is_none_or(|inventory| inventory.values().any(|value| value.as_f64() != Some(0.0)))
        })
    {
        bail!("native player-authority removal building owns buffered material")
    }
    for belt_index in 0..state.belt_index.len() {
        let belt = state.parse_belt(belt_index)?;
        if ["source", "target"]
            .iter()
            .any(|key| belt.get(*key).and_then(Value::as_str) == Some(entity_id))
        {
            bail!("native player-authority removal building still has an incident belt")
        }
    }
    if queue_or_blueprint_pruning_would_change(state, entity_id) {
        bail!("native player-authority removal requires queue or blueprint pruning")
    }
    let construction = state
        .base_value()
        .get("construction")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("native player-authority construction inventory is missing"))?;
    let previous = normalized_construction_inventory(construction.get(&building_id))?;
    let expected = previous
        .checked_add(machine_count)
        .filter(|value| *value <= MAX_JAVASCRIPT_SAFE_INTEGER)
        .ok_or_else(|| anyhow!("native player-authority building refund overflows"))?;
    if require_exact_set_patch(
        &command.top_level_changes,
        &["construction", building_id.as_str()],
    )?
    .as_u64()
        != Some(expected)
    {
        bail!("native player-authority building removal refund is invalid")
    }
    Ok(())
}

fn validate_ejector_target_command(
    state: &CoreState,
    command: &SimulationCommandPatch,
) -> anyhow::Result<()> {
    if command.changed_entities.is_empty()
        || !command.top_level_changes.is_empty()
        || !command.added_entities.is_empty()
        || !command.removed_entity_ids.is_empty()
        || !command.changed_belts.is_empty()
        || !command.added_belts.is_empty()
        || !command.removed_belt_ids.is_empty()
    {
        bail!("native player-authority ejector target command shape is invalid")
    }
    let mut entity_ids = HashSet::new();
    let mut shared_orbit_id: Option<&str> = None;
    for record in &command.changed_entities {
        if !entity_ids.insert(record.id.as_str()) || record.changes.len() != 1 {
            bail!("native player-authority ejector target entity set is invalid")
        }
        let orbit_id = require_exact_set_patch(&record.changes, &["targetDysonOrbitId"])?
            .as_str()
            .filter(|value| !value.is_empty() && value.len() <= MAX_PLAYER_ORBIT_ID_BYTES)
            .ok_or_else(|| anyhow!("native player-authority ejector target orbit ID is invalid"))?;
        if shared_orbit_id.is_some_and(|candidate| candidate != orbit_id) {
            bail!("native player-authority batch ejector targets disagree")
        }
        shared_orbit_id = Some(orbit_id);
        let index = *state
            .entity_index
            .get(&record.id)
            .ok_or_else(|| anyhow!("native player-authority ejector is missing"))?;
        let mut entity = state.parse_entity(index)?;
        let object = entity
            .as_object_mut()
            .ok_or_else(|| anyhow!("native player-authority ejector is invalid"))?;
        if object.get("buildingId").and_then(Value::as_str) != Some("em_rail_ejector")
            || !state.catalog.buildings.contains_key("em_rail_ejector")
            || object.get("interactionLocked").and_then(Value::as_bool) == Some(true)
            || object.get("targetDysonOrbitId").and_then(Value::as_str) == Some(orbit_id)
        {
            bail!("native player-authority ejector target transition is invalid")
        }
        object.insert(
            "targetDysonOrbitId".to_owned(),
            Value::from(orbit_id.to_owned()),
        );
        if !crate::dyson::valid_ejector_target(state, state.base_value(), object) {
            bail!("native player-authority ejector target is outside its stellar system")
        }
    }
    Ok(())
}

fn validate_player_pause_command(
    state: &CoreState,
    command: &SimulationCommandPatch,
) -> anyhow::Result<()> {
    if command.top_level_changes.len() != 1
        || !command.changed_entities.is_empty()
        || !command.added_entities.is_empty()
        || !command.removed_entity_ids.is_empty()
        || !command.changed_belts.is_empty()
        || !command.added_belts.is_empty()
        || !command.removed_belt_ids.is_empty()
    {
        bail!("native player-authority pause command shape is invalid")
    }
    let target = require_exact_set_patch(&command.top_level_changes, &["paused"])?
        .as_bool()
        .ok_or_else(|| anyhow!("native player-authority paused value is invalid"))?;
    if state
        .base_value()
        .get("paused")
        .and_then(Value::as_bool)
        .is_none()
    {
        bail!("native player-authority paused state is invalid")
    }
    // Setting true would make a durable retry ineligible under the active
    // player-authority lease. Pause remains owned by its existing control
    // path; accepting the running value is retained for protocol/retry tests.
    if target {
        bail!("native player-authority pause transition is not owned by this command path")
    }
    Ok(())
}

fn validate_recipe_focus_command(
    state: &CoreState,
    command: &SimulationCommandPatch,
) -> anyhow::Result<()> {
    if command.top_level_changes.is_empty()
        || command.top_level_changes.len() > 2
        || !command.changed_entities.is_empty()
        || !command.added_entities.is_empty()
        || !command.removed_entity_ids.is_empty()
        || !command.changed_belts.is_empty()
        || !command.added_belts.is_empty()
        || !command.removed_belt_ids.is_empty()
    {
        bail!("native player-authority recipe focus command shape is invalid")
    }
    let focus = state
        .base_value()
        .get("recipeFocus")
        .and_then(Value::as_object)
        .filter(|focus| {
            focus.len() == 3
                && focus.contains_key("itemId")
                && focus.contains_key("mode")
                && focus.contains_key("position")
        })
        .ok_or_else(|| anyhow!("native player-authority recipe focus state is invalid"))?;
    let current_item = match focus.get("itemId") {
        Some(Value::Null) => None,
        Some(Value::String(item_id)) if state.catalog.items.contains_key(item_id) => {
            Some(item_id.as_str())
        }
        _ => bail!("native player-authority current recipe focus item is invalid"),
    };
    let current_mode = focus
        .get("mode")
        .and_then(Value::as_str)
        .filter(|mode| matches!(*mode, "two-level" | "full"))
        .ok_or_else(|| anyhow!("native player-authority current recipe focus mode is invalid"))?;
    let current_position = focus
        .get("position")
        .and_then(Value::as_object)
        .filter(|position| {
            position.len() == 2 && position.contains_key("x") && position.contains_key("y")
        })
        .ok_or_else(|| {
            anyhow!("native player-authority current recipe focus position is invalid")
        })?;
    let current_x = safe_json_integer(current_position.get("x"), "recipe focus X position")?;
    let current_y = safe_json_integer(current_position.get("y"), "recipe focus Y position")?;
    if current_x < 8 || current_y < 8 {
        bail!("native player-authority current recipe focus position is below the UI boundary")
    }

    if command.top_level_changes.len() == 1 {
        let change = &command.top_level_changes[0];
        if change.operation != "set" {
            bail!("native player-authority recipe focus patch operation is invalid")
        }
        let value = change
            .value
            .as_ref()
            .ok_or_else(|| anyhow!("native player-authority recipe focus set has no value"))?;
        match change.path.as_slice() {
            [PathSegment::Key(root), PathSegment::Key(field)]
                if root == "recipeFocus" && field == "itemId" =>
            {
                let target = match value {
                    Value::Null => None,
                    Value::String(item_id) if state.catalog.items.contains_key(item_id) => {
                        Some(item_id.as_str())
                    }
                    _ => bail!("native player-authority recipe focus item is invalid"),
                };
                if target == current_item {
                    bail!("native player-authority recipe focus item is unchanged")
                }
                return Ok(());
            }
            [PathSegment::Key(root), PathSegment::Key(field)]
                if root == "recipeFocus" && field == "mode" =>
            {
                let target = value
                    .as_str()
                    .filter(|mode| matches!(*mode, "two-level" | "full"))
                    .ok_or_else(|| {
                        anyhow!("native player-authority recipe focus mode is invalid")
                    })?;
                if target == current_mode {
                    bail!("native player-authority recipe focus mode is unchanged")
                }
                return Ok(());
            }
            [
                PathSegment::Key(root),
                PathSegment::Key(position),
                PathSegment::Key(axis),
            ] if root == "recipeFocus"
                && position == "position"
                && matches!(axis.as_str(), "x" | "y") =>
            {
                let target = safe_json_integer(Some(value), "recipe focus position")?;
                let current = if axis == "x" { current_x } else { current_y };
                if target < 8 {
                    bail!("native player-authority recipe focus position is below the UI boundary")
                }
                if target == current {
                    bail!("native player-authority recipe focus position is unchanged")
                }
                return Ok(());
            }
            _ => bail!("native player-authority recipe focus patch path is not canonical"),
        }
    }

    let mut axes = HashSet::new();
    for change in &command.top_level_changes {
        let axis = match change.path.as_slice() {
            [
                PathSegment::Key(root),
                PathSegment::Key(position),
                PathSegment::Key(axis),
            ] if root == "recipeFocus"
                && position == "position"
                && matches!(axis.as_str(), "x" | "y") =>
            {
                axis.as_str()
            }
            _ => bail!("native player-authority recipe focus multi-patch is not a position drag"),
        };
        if !axes.insert(axis) || change.operation != "set" {
            bail!("native player-authority recipe focus position axis is repeated or invalid")
        }
        let target = safe_json_integer(change.value.as_ref(), "recipe focus position")?;
        let current = if axis == "x" { current_x } else { current_y };
        if target < 8 {
            bail!("native player-authority recipe focus position is below the UI boundary")
        }
        if target == current {
            bail!("native player-authority recipe focus position contains an unchanged axis")
        }
    }
    if axes.len() != 2 {
        bail!("native player-authority recipe focus position drag is incomplete")
    }
    Ok(())
}

fn validate_planet_viewport_command(
    state: &CoreState,
    command: &SimulationCommandPatch,
) -> anyhow::Result<()> {
    if command.top_level_changes.is_empty()
        || command.top_level_changes.len() > 3
        || !command.changed_entities.is_empty()
        || !command.added_entities.is_empty()
        || !command.removed_entity_ids.is_empty()
        || !command.changed_belts.is_empty()
        || !command.added_belts.is_empty()
        || !command.removed_belt_ids.is_empty()
    {
        bail!("native player-authority planet viewport command shape is invalid")
    }

    let mut command_planet_id = None;
    let mut fields = HashSet::new();
    for change in &command.top_level_changes {
        let (planet_id, field) = match change.path.as_slice() {
            [
                PathSegment::Key(root),
                PathSegment::Key(planet_id),
                PathSegment::Key(field),
            ] if root == "planetViewports" && matches!(field.as_str(), "x" | "y" | "zoom") => {
                (planet_id.as_str(), field.as_str())
            }
            _ => bail!("native player-authority planet viewport patch path is not canonical"),
        };
        if command_planet_id.is_some_and(|current| current != planet_id) {
            bail!("native player-authority planet viewport command spans multiple planets")
        }
        command_planet_id = Some(planet_id);
        if !fields.insert(field) || change.operation != "set" || change.value.is_none() {
            bail!("native player-authority planet viewport field is repeated or invalid")
        }
    }

    let planet_id = command_planet_id
        .ok_or_else(|| anyhow!("native player-authority planet viewport target is missing"))?;
    if !state
        .catalog
        .planets
        .iter()
        .any(|planet| planet.id == planet_id)
    {
        bail!("native player-authority planet viewport target is unknown")
    }
    let viewport = state
        .base_value()
        .get("planetViewports")
        .and_then(Value::as_object)
        .and_then(|viewports| viewports.get(planet_id))
        .and_then(Value::as_object)
        .filter(|viewport| {
            viewport.len() == 3
                && viewport.contains_key("x")
                && viewport.contains_key("y")
                && viewport.contains_key("zoom")
        })
        .ok_or_else(|| anyhow!("native player-authority planet viewport state is invalid"))?;
    let current_x = finite_json_number(viewport.get("x"), "planet viewport X")?;
    let current_y = finite_json_number(viewport.get("y"), "planet viewport Y")?;
    let current_zoom = finite_json_number(viewport.get("zoom"), "planet viewport zoom")?;
    if !(0.25..=1.8).contains(&current_zoom) {
        bail!("native player-authority current planet viewport zoom is out of range")
    }

    for change in &command.top_level_changes {
        let field = match &change.path[2] {
            PathSegment::Key(field) => field.as_str(),
            PathSegment::Index(_) => unreachable!("canonical viewport path was already checked"),
        };
        let target = finite_json_number(change.value.as_ref(), "planet viewport value")?;
        let current = match field {
            "x" => current_x,
            "y" => current_y,
            "zoom" => {
                if !(0.25..=1.8).contains(&target) {
                    bail!("native player-authority planet viewport zoom is out of range")
                }
                current_zoom
            }
            _ => unreachable!("canonical viewport field was already checked"),
        };
        if target == current {
            bail!("native player-authority planet viewport patch is unchanged")
        }
    }
    Ok(())
}

fn validate_player_position_command(
    state: &CoreState,
    command: &SimulationCommandPatch,
) -> anyhow::Result<()> {
    if command.changed_entities.is_empty()
        || !command.top_level_changes.is_empty()
        || !command.added_entities.is_empty()
        || !command.removed_entity_ids.is_empty()
        || !command.changed_belts.is_empty()
        || !command.added_belts.is_empty()
        || !command.removed_belt_ids.is_empty()
    {
        bail!("native player-authority entity position command shape is invalid")
    }
    let mut entity_ids = HashSet::new();
    for record in &command.changed_entities {
        if !entity_ids.insert(record.id.as_str()) || record.changes.is_empty() {
            bail!("native player-authority entity position set is invalid")
        }
        let index = *state
            .entity_index
            .get(&record.id)
            .ok_or_else(|| anyhow!("native player-authority moved entity is missing"))?;
        let mut entity = state.parse_entity(index)?;
        if entity.get("interactionLocked").and_then(Value::as_bool) == Some(true) {
            bail!("native player-authority moved entity is locked")
        }
        let mut axes = HashSet::new();
        for change in &record.changes {
            let axis = match change.path.as_slice() {
                [PathSegment::Key(position), PathSegment::Key(axis)]
                    if position == "position" && matches!(axis.as_str(), "x" | "y") =>
                {
                    axis.as_str()
                }
                _ => bail!("native player-authority entity position patch is not canonical"),
            };
            if !axes.insert(axis) || change.operation != "set" {
                bail!("native player-authority entity position axis is repeated or invalid")
            }
            let value = change
                .value
                .as_ref()
                .and_then(Value::as_f64)
                .filter(|value| value.is_finite())
                .ok_or_else(|| anyhow!("native player-authority entity position is invalid"))?;
            entity
                .get_mut("position")
                .and_then(Value::as_object_mut)
                .ok_or_else(|| anyhow!("native player-authority entity position state is invalid"))?
                .insert(axis.to_owned(), Value::from(value));
        }
        let position = entity
            .get("position")
            .and_then(Value::as_object)
            .ok_or_else(|| anyhow!("native player-authority entity position state is invalid"))?;
        if position.len() != 2
            || !["x", "y"].iter().all(|axis| {
                position
                    .get(*axis)
                    .and_then(Value::as_f64)
                    .is_some_and(f64::is_finite)
            })
        {
            bail!("native player-authority entity position state is invalid")
        }
    }
    Ok(())
}

fn player_belt_value(state: &CoreState, belt_id: &str) -> anyhow::Result<Value> {
    let belt_index = *state
        .belt_index
        .get(belt_id)
        .ok_or_else(|| anyhow!("native player-authority belt target is missing"))?;
    let belt = state.parse_belt(belt_index)?;
    if !belt.is_object() {
        bail!("native player-authority belt target is invalid")
    }
    Ok(belt)
}

fn builtin_belt_construction_id(state: &CoreState, tier: u8) -> anyhow::Result<&'static str> {
    // The current catalog snapshot carries a belt tier and speed but not the
    // matching construction ID.  Built-in tiers are stable and can therefore
    // prove their debit/refund.  A content pack may register an arbitrary ID
    // for tier 4+, so inventory-affecting belt commands remain fail-closed
    // until that ID is added to an internal catalog revision.
    if state.catalog.snapshot.registry_fingerprint != EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT {
        bail!("native player-authority belt construction mapping is not provable")
    }
    let construction_id = match tier {
        1 => "conveyor_belt_mk1",
        2 => "conveyor_belt_mk2",
        3 => "conveyor_belt_mk3",
        _ => bail!("native player-authority belt tier construction is not covered"),
    };
    if !state.catalog.belt_speeds.contains_key(&tier)
        || !state.catalog.constructions.contains_key(construction_id)
    {
        bail!("native player-authority belt construction is not in the catalog")
    }
    Ok(construction_id)
}

fn validate_belt_configuration_command(
    state: &CoreState,
    command: &SimulationCommandPatch,
) -> anyhow::Result<()> {
    if command.changed_belts.is_empty()
        || !command.top_level_changes.is_empty()
        || !command.changed_entities.is_empty()
        || !command.added_entities.is_empty()
        || !command.removed_entity_ids.is_empty()
        || !command.added_belts.is_empty()
        || !command.removed_belt_ids.is_empty()
    {
        bail!("native player-authority belt configuration command shape is invalid")
    }
    let mut belt_ids = HashSet::new();
    for record in &command.changed_belts {
        if !belt_ids.insert(record.id.as_str())
            || record.changes.is_empty()
            || record.changes.len() > 6
        {
            bail!("native player-authority belt configuration target set is invalid")
        }
        let belt = player_belt_value(state, &record.id)?;
        let object = belt
            .as_object()
            .expect("player_belt_value validated the object");
        let mut fields = HashSet::new();
        let mut effective_route_mode = object
            .get("routeMode")
            .map(|value| {
                value
                    .as_str()
                    .filter(|value| BELT_ROUTE_MODES.contains(value))
                    .ok_or_else(|| {
                        anyhow!("native player-authority current belt route mode is invalid")
                    })
            })
            .transpose()?
            .unwrap_or("auto");
        let mut route_offset_changed = false;
        let mut stack_size_changed = false;
        let mut progress_reset = false;
        for change in &record.changes {
            let [PathSegment::Key(field)] = change.path.as_slice() else {
                bail!("native player-authority belt configuration path is invalid")
            };
            if !fields.insert(field.as_str()) || change.operation != "set" {
                bail!("native player-authority belt configuration patch is duplicated or invalid")
            }
            let target = change.value.as_ref().ok_or_else(|| {
                anyhow!("native player-authority belt configuration set has no value")
            })?;
            if object.get(field) == Some(target) {
                bail!("native player-authority belt configuration command is unchanged")
            }
            match field.as_str() {
                "priority" => {
                    object
                        .get("priority")
                        .and_then(Value::as_u64)
                        .filter(|value| *value <= 2)
                        .ok_or_else(|| {
                            anyhow!("native player-authority current belt priority is invalid")
                        })?;
                    target.as_u64().filter(|value| *value <= 2).ok_or_else(|| {
                        anyhow!("native player-authority belt priority target is invalid")
                    })?;
                }
                "monitorEnabled" => {
                    target.as_bool().ok_or_else(|| {
                        anyhow!("native player-authority belt monitor target is invalid")
                    })?;
                }
                "routeMode" => {
                    effective_route_mode = target
                        .as_str()
                        .filter(|value| BELT_ROUTE_MODES.contains(value))
                        .ok_or_else(|| {
                            anyhow!("native player-authority belt route mode is invalid")
                        })?;
                }
                "routeOffsetY" => {
                    target
                        .as_i64()
                        .filter(|value| (-600..=600).contains(value))
                        .ok_or_else(|| {
                            anyhow!("native player-authority belt route offset is invalid")
                        })?;
                    route_offset_changed = true;
                }
                "stackSize" => {
                    let stack_size = target
                        .as_u64()
                        .filter(|value| matches!(*value, 1 | 2 | 4))
                        .ok_or_else(|| {
                            anyhow!("native player-authority belt stack size is invalid")
                        })?;
                    if stack_size == 2 && !technology_is_completed(state, "high_speed_logistics")
                        || stack_size == 4
                            && !technology_is_completed(state, "super_magnetic_logistics")
                    {
                        bail!("native player-authority belt stack technology is locked")
                    }
                    stack_size_changed = true;
                }
                "progress" => {
                    if target.as_f64() != Some(0.0) {
                        bail!("native player-authority belt progress reset is invalid")
                    }
                    progress_reset = true;
                }
                _ => bail!("native player-authority belt configuration field is not typed"),
            }
        }
        if route_offset_changed && effective_route_mode != "manual" {
            bail!("native player-authority belt route offset requires manual routing")
        }
        if progress_reset && !stack_size_changed {
            bail!("native player-authority belt progress may only reset with a stack change")
        }
    }
    Ok(())
}

fn validate_belt_lane_command(
    state: &CoreState,
    command: &SimulationCommandPatch,
) -> anyhow::Result<()> {
    if command.changed_belts.len() != 1
        || command.changed_belts[0].changes.len() != 1
        || command.top_level_changes.len() != 1
        || !command.changed_entities.is_empty()
        || !command.added_entities.is_empty()
        || !command.removed_entity_ids.is_empty()
        || !command.added_belts.is_empty()
        || !command.removed_belt_ids.is_empty()
    {
        bail!("native player-authority belt lane command shape is invalid")
    }
    let record = &command.changed_belts[0];
    let belt = player_belt_value(state, &record.id)?;
    let object = belt
        .as_object()
        .expect("player_belt_value validated the object");
    let current = safe_json_integer(object.get("lanes"), "current belt lanes")?;
    if current == 0 {
        bail!("native player-authority current belt lanes are empty")
    }
    let target = safe_json_integer(
        Some(require_exact_set_patch(&record.changes, &["lanes"])?),
        "belt lane target",
    )?;
    if target == 0 || target == current {
        bail!("native player-authority belt lane target is empty or unchanged")
    }
    // Migrated saves may retain a historical count above the current limit.
    // They can be reduced, but a player cannot maintain or increase an
    // over-limit line through this command.
    if target > MAX_PLAYER_BELT_LANES && target >= current {
        bail!("native player-authority belt lane target exceeds its limit")
    }
    let tier = safe_json_integer(object.get("tier"), "belt tier")?
        .try_into()
        .map_err(|_| anyhow!("native player-authority belt tier is invalid"))?;
    let construction_id = builtin_belt_construction_id(state, tier)?;
    let construction = state
        .base_value()
        .get("construction")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("native player-authority construction inventory is missing"))?;
    let available = normalized_construction_inventory(construction.get(construction_id))?;
    let expected = if target > current {
        available.checked_sub(target - current).ok_or_else(|| {
            anyhow!("native player-authority belt construction stock is insufficient")
        })?
    } else {
        available
            .checked_add(current - target)
            .filter(|value| *value <= MAX_JAVASCRIPT_SAFE_INTEGER)
            .ok_or_else(|| anyhow!("native player-authority belt construction refund overflows"))?
    };
    if require_exact_set_patch(
        &command.top_level_changes,
        &["construction", construction_id],
    )?
    .as_u64()
        != Some(expected)
    {
        bail!("native player-authority belt lane inventory adjustment is invalid")
    }
    Ok(())
}

fn validate_belt_removal_command(
    state: &CoreState,
    command: &SimulationCommandPatch,
) -> anyhow::Result<()> {
    if command.removed_belt_ids.is_empty()
        || !command.changed_entities.is_empty()
        || !command.added_entities.is_empty()
        || !command.removed_entity_ids.is_empty()
        || !command.changed_belts.is_empty()
        || !command.added_belts.is_empty()
    {
        bail!("native player-authority belt removal shape is invalid")
    }
    let mut belt_ids = HashSet::new();
    let mut refunds = BTreeMap::<&'static str, u64>::new();
    for belt_id in &command.removed_belt_ids {
        if !belt_ids.insert(belt_id.as_str()) {
            bail!("native player-authority belt removal target is repeated")
        }
        let belt = player_belt_value(state, belt_id)?;
        let object = belt
            .as_object()
            .expect("player_belt_value validated the object");
        let lanes = safe_json_integer(object.get("lanes"), "removed belt lanes")?;
        if lanes == 0 {
            bail!("native player-authority removed belt lanes are empty")
        }
        let tier = safe_json_integer(object.get("tier"), "removed belt tier")?
            .try_into()
            .map_err(|_| anyhow!("native player-authority removed belt tier is invalid"))?;
        let construction_id = builtin_belt_construction_id(state, tier)?;
        let total = refunds.entry(construction_id).or_default();
        *total = total
            .checked_add(lanes)
            .filter(|value| *value <= MAX_JAVASCRIPT_SAFE_INTEGER)
            .ok_or_else(|| anyhow!("native player-authority belt refund total overflows"))?;
    }
    if command.top_level_changes.len() != refunds.len() {
        bail!("native player-authority belt removal inventory shape is invalid")
    }
    let construction = state
        .base_value()
        .get("construction")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("native player-authority construction inventory is missing"))?;
    for (construction_id, refund) in refunds {
        let previous = normalized_construction_inventory(construction.get(construction_id))?;
        let expected = previous
            .checked_add(refund)
            .filter(|value| *value <= MAX_JAVASCRIPT_SAFE_INTEGER)
            .ok_or_else(|| anyhow!("native player-authority belt construction refund overflows"))?;
        if require_exact_set_patch(
            &command.top_level_changes,
            &["construction", construction_id],
        )?
        .as_u64()
            != Some(expected)
        {
            bail!("native player-authority belt removal refund is invalid")
        }
    }
    Ok(())
}

impl SimulationCommandPatch {
    /// Derives the renderer invalidation receipt solely from a command that
    /// has already passed authoritative command validation. This makes the
    /// receipt reproducible after WAL/checkpoint/lease crash boundaries
    /// without trusting a renderer-provided dirty set.
    pub fn deterministic_apply_result(
        &self,
        previous_revision: u64,
        revision: u64,
    ) -> anyhow::Result<CommandApplyResult> {
        if revision
            != previous_revision
                .checked_add(1)
                .ok_or_else(|| anyhow!("native command change receipt revision is exhausted"))?
        {
            bail!("native command change receipt revision is not contiguous")
        }
        let mut changed_entity_ids = self
            .changed_entities
            .iter()
            .map(|record| record.id.clone())
            .chain(self.removed_entity_ids.iter().cloned())
            .collect::<Vec<_>>();
        for addition in &self.added_entities {
            changed_entity_ids.push(
                addition
                    .value
                    .get("id")
                    .and_then(Value::as_str)
                    .ok_or_else(|| anyhow!("native command added entity ID is missing"))?
                    .to_owned(),
            );
        }
        changed_entity_ids.sort_unstable();
        changed_entity_ids.dedup();

        let mut changed_belt_ids = self
            .changed_belts
            .iter()
            .map(|record| record.id.clone())
            .chain(self.removed_belt_ids.iter().cloned())
            .collect::<Vec<_>>();
        for addition in &self.added_belts {
            changed_belt_ids.push(
                addition
                    .value
                    .get("id")
                    .and_then(Value::as_str)
                    .ok_or_else(|| anyhow!("native command added belt ID is missing"))?
                    .to_owned(),
            );
        }
        changed_belt_ids.sort_unstable();
        changed_belt_ids.dedup();

        let topology_dirty = !self.added_entities.is_empty()
            || !self.removed_entity_ids.is_empty()
            || !self.added_belts.is_empty()
            || !self.removed_belt_ids.is_empty()
            || self
                .top_level_changes
                .iter()
                .any(|change| !top_level_change_is_projection_safe(change))
            || self.changed_entities.iter().any(|record| {
                record
                    .changes
                    .iter()
                    .any(|change| !entity_change_is_projection_safe(change))
            })
            || self.changed_belts.iter().any(|record| {
                record
                    .changes
                    .iter()
                    .any(|change| !belt_change_is_projection_safe(change))
            });

        Ok(CommandApplyResult {
            previous_revision,
            revision,
            changed_entity_ids,
            changed_belt_ids,
            topology_dirty,
        })
    }
}

impl CoreState {
    /// Validates player-reachable topology/configuration commands before any
    /// durable stage. The general command engine remains available to exact
    /// simulation/replay, but a player-authority writer may only cross a
    /// protected domain after one typed validator has proved its complete
    /// field set, catalog references, inventory debit/refund and topology.
    pub fn validate_player_authority_command(
        &self,
        command: &SimulationCommandPatch,
    ) -> anyhow::Result<()> {
        if command.protocol_version != crate::CORE_PROTOCOL_VERSION {
            bail!("native player-authority command protocol version is unsupported")
        }
        if command.base_revision != self.revision {
            bail!("native player-authority command base revision is not current")
        }
        let total = command.top_level_changes.len()
            + command.changed_entities.len()
            + command.added_entities.len()
            + command.removed_entity_ids.len()
            + command.changed_belts.len()
            + command.added_belts.len()
            + command.removed_belt_ids.len();
        if total == 0 || total > 65_536 {
            bail!("native player-authority command change count is invalid")
        }
        if command
            .changed_entities
            .iter()
            .any(|record| record.changes.is_empty())
            || command
                .changed_belts
                .iter()
                .any(|record| record.changes.is_empty())
        {
            bail!("native player-authority command contains an empty record patch")
        }
        if !command.added_entities.is_empty() {
            return validate_ordinary_building_placement(self, command);
        }
        if !command.removed_entity_ids.is_empty() {
            return validate_ordinary_building_removal(self, command);
        }
        if command.changed_entities.iter().any(|record| {
            record
                .changes
                .iter()
                .any(|change| path_matches(&change.path, &["machineCount"]))
        }) {
            return validate_ordinary_building_stack_change(self, command);
        }
        if command.changed_entities.iter().any(|record| {
            record
                .changes
                .iter()
                .any(|change| path_matches(&change.path, &["targetDysonOrbitId"]))
        }) {
            return validate_ejector_target_command(self, command);
        }
        if !command.changed_entities.is_empty()
            && command.changed_entities.iter().all(|record| {
                record.changes.iter().all(|change| {
                    matches!(
                        change.path.as_slice(),
                        [PathSegment::Key(position), PathSegment::Key(axis)]
                            if position == "position" && matches!(axis.as_str(), "x" | "y")
                    )
                })
            })
        {
            return validate_player_position_command(self, command);
        }
        if command.top_level_changes.iter().any(|change| {
            matches!(change.path.first(), Some(PathSegment::Key(root)) if root == "recipeFocus")
        }) {
            return validate_recipe_focus_command(self, command);
        }
        if command.top_level_changes.iter().any(|change| {
            matches!(change.path.first(), Some(PathSegment::Key(root)) if root == "planetViewports")
        }) {
            return validate_planet_viewport_command(self, command);
        }
        if !command.removed_belt_ids.is_empty() {
            return validate_belt_removal_command(self, command);
        }
        if command.changed_belts.iter().any(|record| {
            record
                .changes
                .iter()
                .any(|change| path_matches(&change.path, &["lanes"]))
        }) {
            return validate_belt_lane_command(self, command);
        }
        if !command.changed_belts.is_empty() {
            return validate_belt_configuration_command(self, command);
        }
        if !command.top_level_changes.is_empty() {
            return validate_player_pause_command(self, command);
        }
        bail!("native player-authority command domain is not typed yet")
    }

    pub fn apply_player_authority_command(
        &mut self,
        command: &SimulationCommandPatch,
    ) -> anyhow::Result<CommandApplyResult> {
        self.validate_player_authority_command(command)?;
        self.apply_command(command)
    }

    pub fn apply_command(
        &mut self,
        command: &SimulationCommandPatch,
    ) -> anyhow::Result<CommandApplyResult> {
        if command.protocol_version != crate::CORE_PROTOCOL_VERSION {
            bail!("native command protocol version is unsupported");
        }
        if command.base_revision != self.revision {
            bail!("native command base revision is not current");
        }
        let total = command.top_level_changes.len()
            + command.changed_entities.len()
            + command.added_entities.len()
            + command.removed_entity_ids.len()
            + command.changed_belts.len()
            + command.added_belts.len()
            + command.removed_belt_ids.len();
        if total == 0 || total > 65_536 {
            bail!("native command change count is invalid")
        }

        // Apply to a cloned transactional state. A malformed late patch can
        // never leave the authoritative candidate partially edited.
        let rebuild_production_history = command_requires_production_history_rebuild(command);
        let mut next = self.clone();
        // `next` is already disposable on failure. Move its base map into the
        // patch value instead of retaining two complete copies during every
        // pause/edit command.
        let mut base = Value::Object(next.take_base_for_command());
        for change in &command.top_level_changes {
            apply_value_patch(&mut base, change)?;
        }
        let base = match base {
            Value::Object(base) => base,
            _ => bail!("native command replaced the GameState root"),
        };
        next.install_base_from_command(base, rebuild_production_history);

        for record in &command.changed_entities {
            let index = *next
                .entity_index
                .get(&record.id)
                .ok_or_else(|| anyhow!("native command entity is missing"))?;
            let mut value = next.parse_entity(index)?;
            apply_record_changes(&mut value, &record.changes)?;
            next.replace_entity_raw(index, Arc::<str>::from(serde_json::to_string(&value)?));
        }
        if !command.removed_entity_ids.is_empty() {
            let removed = command
                .removed_entity_ids
                .iter()
                .collect::<std::collections::HashSet<_>>();
            if removed.len() != command.removed_entity_ids.len() {
                bail!("native command repeats an entity removal")
            }
            if removed.iter().any(|id| !next.entity_index.contains_key(id)) {
                bail!("native command removes a missing entity")
            }
            next.entity_raw_mut_topology().retain(|raw| {
                serde_json::from_str::<Value>(raw)
                    .ok()
                    .and_then(|value| {
                        value
                            .get("id")
                            .and_then(Value::as_str)
                            .map(|id| !removed.contains(&id.to_owned()))
                    })
                    .unwrap_or(false)
            });
        }
        if !command.added_entities.is_empty() {
            let mut additions = command.added_entities.clone();
            additions.sort_by_key(|entry| entry.index);
            for addition in additions {
                if addition.index > next.entity_raw_mut_topology().len()
                    || !addition.value.is_object()
                {
                    bail!("native command entity insertion is invalid")
                }
                let id = addition
                    .value
                    .get("id")
                    .and_then(Value::as_str)
                    .ok_or_else(|| anyhow!("native command added entity ID is missing"))?;
                if next.entity_index.contains_key(id) {
                    bail!("native command added entity ID already exists")
                }
                next.entity_raw_mut_topology().insert(
                    addition.index,
                    Arc::<str>::from(serde_json::to_string(&addition.value)?),
                );
            }
        }

        for record in &command.changed_belts {
            let index = *next
                .belt_index
                .get(&record.id)
                .ok_or_else(|| anyhow!("native command belt is missing"))?;
            let mut value = next.parse_belt(index)?;
            apply_record_changes(&mut value, &record.changes)?;
            next.replace_belt_raw(index, Arc::<str>::from(serde_json::to_string(&value)?));
        }
        if !command.removed_belt_ids.is_empty() {
            let removed = command
                .removed_belt_ids
                .iter()
                .collect::<std::collections::HashSet<_>>();
            if removed.len() != command.removed_belt_ids.len() {
                bail!("native command repeats a belt removal")
            }
            if removed.iter().any(|id| !next.belt_index.contains_key(id)) {
                bail!("native command removes a missing belt")
            }
            next.belt_raw_mut_topology().retain(|raw| {
                serde_json::from_str::<Value>(raw)
                    .ok()
                    .and_then(|value| {
                        value
                            .get("id")
                            .and_then(Value::as_str)
                            .map(|id| !removed.contains(&id.to_owned()))
                    })
                    .unwrap_or(false)
            });
        }
        if !command.added_belts.is_empty() {
            let mut additions = command.added_belts.clone();
            additions.sort_by_key(|entry| entry.index);
            for addition in additions {
                if addition.index > next.belt_raw_mut_topology().len()
                    || !addition.value.is_object()
                {
                    bail!("native command belt insertion is invalid")
                }
                let id = addition
                    .value
                    .get("id")
                    .and_then(Value::as_str)
                    .ok_or_else(|| anyhow!("native command added belt ID is missing"))?;
                if next.belt_index.contains_key(id) {
                    bail!("native command added belt ID already exists")
                }
                next.belt_raw_mut_topology().insert(
                    addition.index,
                    Arc::<str>::from(serde_json::to_string(&addition.value)?),
                );
            }
        }
        next.revision += 1;
        let only_pause_changed = command.changed_entities.is_empty()
            && command.added_entities.is_empty()
            && command.removed_entity_ids.is_empty()
            && command.changed_belts.is_empty()
            && command.added_belts.is_empty()
            && command.removed_belt_ids.is_empty()
            && command.top_level_changes.iter().all(|change| {
                matches!(
                    change.path.first(),
                    Some(PathSegment::Key(key)) if key == "paused"
                )
            });
        // Top-level commands never change record IDs or topology. Rebuilding
        // all 80k entity and 155k belt indexes for a pause/resume toggle made
        // a tiny Windows command pay the full save-open parsing cost.
        let records_changed = !command.changed_entities.is_empty()
            || !command.added_entities.is_empty()
            || !command.removed_entity_ids.is_empty()
            || !command.changed_belts.is_empty()
            || !command.added_belts.is_empty()
            || !command.removed_belt_ids.is_empty();
        if records_changed {
            next.rebuild_indexes()?;
        }
        if !only_pause_changed {
            next.invalidate_factory_static_admission();
        }
        let previous_revision = self.revision;
        // Derive the deterministic receipt before publishing the candidate.
        // Even a malformed future command shape must therefore leave the
        // source state untouched if receipt construction fails.
        let result = command.deterministic_apply_result(previous_revision, next.revision)?;
        *self = next;
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        CoreCheckpointIdentity,
        catalog::{CatalogSnapshot, RuntimeCatalog},
    };

    #[test]
    fn patch_json_preserves_explicit_null_and_omitted_delete_value() {
        let set_null_json = serde_json::json!({
            "path": ["recipeId"],
            "operation": "set",
            "value": null
        });
        let set_null: ValuePatch = serde_json::from_value(set_null_json.clone()).unwrap();
        assert_eq!(set_null.value, Some(Value::Null));
        assert_eq!(serde_json::to_value(&set_null).unwrap(), set_null_json);

        let delete_json = serde_json::json!({
            "path": ["targetDysonOrbitId"],
            "operation": "delete"
        });
        let delete: ValuePatch = serde_json::from_value(delete_json.clone()).unwrap();
        assert_eq!(delete.value, None);
        assert_eq!(
            serde_json::to_value(&delete).unwrap(),
            serde_json::json!({
                "path": ["targetDysonOrbitId"],
                "operation": "delete",
                "value": null
            })
        );

        let mut entity = serde_json::json!({
            "recipeId": "iron_ingot",
            "targetDysonOrbitId": "orbit-1"
        });
        apply_value_patch(&mut entity, &set_null).unwrap();
        apply_value_patch(&mut entity, &delete).unwrap();
        assert_eq!(entity["recipeId"], Value::Null);
        assert!(entity.get("targetDysonOrbitId").is_none());
    }

    fn command_for_path(path: Vec<PathSegment>) -> SimulationCommandPatch {
        SimulationCommandPatch {
            protocol_version: crate::CORE_PROTOCOL_VERSION,
            base_revision: 1,
            top_level_changes: vec![ValuePatch {
                path,
                operation: "set".to_owned(),
                value: Some(Value::Null),
            }],
            changed_entities: Vec::new(),
            added_entities: Vec::new(),
            removed_entity_ids: Vec::new(),
            changed_belts: Vec::new(),
            added_belts: Vec::new(),
            removed_belt_ids: Vec::new(),
        }
    }

    #[test]
    fn production_history_cache_rebuild_classification_is_fail_closed() {
        for key in ["productionHistory", "historyRecordedAt", "elapsedSeconds"] {
            assert!(command_requires_production_history_rebuild(
                &command_for_path(vec![PathSegment::Key(key.to_owned())])
            ));
        }
        assert!(!command_requires_production_history_rebuild(
            &command_for_path(vec![PathSegment::Key("paused".to_owned())])
        ));
        assert!(!command_requires_production_history_rebuild(
            &command_for_path(vec![PathSegment::Key("metrics".to_owned())])
        ));
        assert!(!command_requires_production_history_rebuild(
            &command_for_path(vec![
                PathSegment::Key("recipeFocus".to_owned()),
                PathSegment::Key("itemId".to_owned()),
            ])
        ));
        assert!(!command_requires_production_history_rebuild(
            &command_for_path(vec![
                PathSegment::Key("planetViewports".to_owned()),
                PathSegment::Key("home".to_owned()),
                PathSegment::Key("x".to_owned()),
            ])
        ));
        assert!(!command_requires_production_history_rebuild(
            &belt_priority_command(1, "belt-priority", Value::from(2))
        ));
        assert!(command_requires_production_history_rebuild(
            &command_for_path(vec![PathSegment::Key("futureUnknownField".to_owned())])
        ));
        assert!(command_requires_production_history_rebuild(
            &command_for_path(Vec::new())
        ));
        assert!(command_requires_production_history_rebuild(
            &command_for_path(vec![PathSegment::Index(0)])
        ));
    }

    #[test]
    fn deterministic_change_receipt_is_sorted_deduplicated_and_topology_aware() {
        let paused = command_for_path(vec![PathSegment::Key("paused".to_owned())]);
        assert!(
            !paused
                .deterministic_apply_result(1, 2)
                .unwrap()
                .topology_dirty
        );
        let unknown = command_for_path(vec![PathSegment::Key("futureTopology".to_owned())]);
        assert!(
            unknown
                .deterministic_apply_result(1, 2)
                .unwrap()
                .topology_dirty
        );
        let recipe_focus_leaf = command_for_path(vec![
            PathSegment::Key("recipeFocus".to_owned()),
            PathSegment::Key("itemId".to_owned()),
        ]);
        assert!(
            !recipe_focus_leaf
                .deterministic_apply_result(1, 2)
                .unwrap()
                .topology_dirty
        );
        let whole_recipe_focus = command_for_path(vec![PathSegment::Key("recipeFocus".to_owned())]);
        assert!(
            whole_recipe_focus
                .deterministic_apply_result(1, 2)
                .unwrap()
                .topology_dirty
        );
        let planet_viewport_leaf = command_for_path(vec![
            PathSegment::Key("planetViewports".to_owned()),
            PathSegment::Key("home".to_owned()),
            PathSegment::Key("zoom".to_owned()),
        ]);
        assert!(
            !planet_viewport_leaf
                .deterministic_apply_result(1, 2)
                .unwrap()
                .topology_dirty
        );
        let mut deleted_planet_viewport_leaf = planet_viewport_leaf.clone();
        deleted_planet_viewport_leaf.top_level_changes[0].operation = "delete".to_owned();
        deleted_planet_viewport_leaf.top_level_changes[0].value = None;
        assert!(
            deleted_planet_viewport_leaf
                .deterministic_apply_result(1, 2)
                .unwrap()
                .topology_dirty
        );
        let whole_planet_viewport = command_for_path(vec![
            PathSegment::Key("planetViewports".to_owned()),
            PathSegment::Key("home".to_owned()),
        ]);
        assert!(
            whole_planet_viewport
                .deterministic_apply_result(1, 2)
                .unwrap()
                .topology_dirty
        );

        let mut command = command_for_path(Vec::new());
        command.top_level_changes.clear();
        command.changed_entities = vec![
            RecordPatch {
                id: "entity-z".to_owned(),
                changes: vec![ValuePatch {
                    path: vec![PathSegment::Key("position".to_owned())],
                    operation: "set".to_owned(),
                    value: Some(serde_json::json!({ "x": 1, "y": 2 })),
                }],
            },
            RecordPatch {
                id: "entity-a".to_owned(),
                changes: Vec::new(),
            },
            RecordPatch {
                id: "entity-z".to_owned(),
                changes: Vec::new(),
            },
        ];
        command.removed_entity_ids = vec!["entity-m".to_owned(), "entity-a".to_owned()];
        command.added_entities = vec![AddedRecord {
            index: 0,
            value: serde_json::json!({ "id": "entity-b" }),
        }];
        command.changed_belts = vec![RecordPatch {
            id: "belt-z".to_owned(),
            changes: vec![ValuePatch {
                path: vec![PathSegment::Key("monitorEnabled".to_owned())],
                operation: "set".to_owned(),
                value: Some(Value::Bool(true)),
            }],
        }];
        command.removed_belt_ids = vec!["belt-a".to_owned()];
        let result = command.deterministic_apply_result(1, 2).unwrap();
        assert_eq!(
            result.changed_entity_ids,
            ["entity-a", "entity-b", "entity-m", "entity-z"]
        );
        assert_eq!(result.changed_belt_ids, ["belt-a", "belt-z"]);
        assert!(result.topology_dirty);

        command.added_entities.clear();
        command.removed_entity_ids.clear();
        command.removed_belt_ids.clear();
        let safe = command.deterministic_apply_result(1, 2).unwrap();
        assert!(!safe.topology_dirty);
        command.changed_entities[0].changes[0].path = vec![PathSegment::Key("recipeId".to_owned())];
        assert!(
            command
                .deterministic_apply_result(1, 2)
                .unwrap()
                .topology_dirty
        );
        command.changed_entities[0].changes[0].path = vec![PathSegment::Key("position".to_owned())];
        command.changed_belts[0].changes[0].path = vec![PathSegment::Key("source".to_owned())];
        assert!(
            command
                .deterministic_apply_result(1, 2)
                .unwrap()
                .topology_dirty
        );

        let belt_priority = belt_priority_command(1, "belt-priority", Value::from(2));
        let belt_priority_result = belt_priority.deterministic_apply_result(1, 2).unwrap();
        assert_eq!(belt_priority_result.changed_belt_ids, ["belt-priority"]);
        assert!(belt_priority_result.topology_dirty);
    }

    fn player_command_catalog_for_registry(registry_fingerprint: &str) -> RuntimeCatalog {
        let snapshot: CatalogSnapshot = serde_json::from_value(serde_json::json!({
            "protocolVersion": crate::CORE_PROTOCOL_VERSION,
            "registryFingerprint": registry_fingerprint,
            "planets": [
                { "id": "home", "systemId": "helios", "kind": "terrestrial", "orbitIndex": 1 },
                { "id": "ashen", "systemId": "sigma", "kind": "terrestrial", "orbitIndex": 1 },
                { "id": "giant", "systemId": "helios", "kind": "gas-giant", "orbitIndex": 2 }
            ],
            "items": [
                { "id": "iron_ore", "kind": "solid" },
                { "id": "iron_ingot", "kind": "solid" },
                { "id": "solar_sail", "kind": "solid" }
            ],
            "buildings": [
                {
                    "id": "arc_smelter", "kind": "machine", "speed": 1,
                    "inputCapacity": 100, "outputCapacity": 100
                },
                {
                    "id": "em_rail_ejector", "kind": "machine", "speed": 1,
                    "inputCapacity": 100, "outputCapacity": 100
                }
            ],
            "recipes": [
                {
                    "id": "iron_ingot", "buildingId": "arc_smelter", "duration": 1,
                    "inputs": [{ "itemId": "iron_ore", "amount": 1 }],
                    "outputs": [{ "itemId": "iron_ingot", "amount": 1 }]
                },
                {
                    "id": "solar_sail_launch", "buildingId": "em_rail_ejector", "duration": 1,
                    "inputs": [{ "itemId": "solar_sail", "amount": 1 }],
                    "outputs": []
                }
            ],
            "constructions": [
                {
                    "id": "arc_smelter", "outputAmount": 1,
                    "costs": [{ "itemId": "iron_ingot", "amount": 1 }]
                },
                {
                    "id": "em_rail_ejector", "outputAmount": 1,
                    "costs": [{ "itemId": "iron_ingot", "amount": 1 }]
                },
                {
                    "id": "conveyor_belt_mk1", "outputAmount": 3,
                    "requiredTechId": "basic_logistics",
                    "costs": [{ "itemId": "iron_ingot", "amount": 2 }]
                }
            ],
            "belts": [{ "tier": 1, "speed": 6 }]
        }))
        .unwrap();
        RuntimeCatalog::validate(snapshot, registry_fingerprint).unwrap()
    }

    fn player_command_entity(
        id: &str,
        building_id: &str,
        x: f64,
        target_orbit_id: Option<&str>,
    ) -> String {
        let mut entity = serde_json::json!({
            "id": id,
            "kind": "machine",
            "planetId": "home",
            "position": { "x": x, "y": 2.0 },
            "interactionLocked": false,
            "buildingId": building_id,
            "powerGridId": "grid-a",
            "powerPriority": 2,
            "recipeId": if building_id == "arc_smelter" { "iron_ingot" } else { "solar_sail_launch" },
            "machineCount": if building_id == "arc_smelter" { 3 } else { 1 },
            "minerCount": 0,
            "inputs": {},
            "outputs": {},
            "progress": 0,
            "routingCursor": 0,
            "utilization": 0,
            "productionRate": 0
        });
        if let Some(target_orbit_id) = target_orbit_id {
            entity["targetDysonOrbitId"] = Value::from(target_orbit_id);
        }
        entity.to_string()
    }

    fn player_command_belt() -> String {
        serde_json::json!({
            "id": "belt-priority",
            "planetId": "home",
            "source": "ejector-a",
            "target": "ejector-b",
            "itemId": "solar_sail",
            "lanes": 1,
            "tier": 1,
            "sorterTier": 1,
            "progress": 0,
            "priority": 1,
            "stackSize": 1,
            "monitorEnabled": false,
            "routeMode": "auto",
            "lastFlow": 0,
            "modPayload": { "owner": "pack:test", "revision": 7 }
        })
        .to_string()
    }

    fn player_command_state_for_registry(registry_fingerprint: &str) -> CoreState {
        let base = serde_json::json!({
            "version": 47,
            "mode": "normal",
            "activePlanetId": "home",
            "elapsedSeconds": 100,
            "paused": false,
            "nextId": 9,
            "recipeFocus": {
                "itemId": null,
                "mode": "two-level",
                "position": { "x": 24, "y": 72 }
            },
            "planetViewports": {
                "home": { "x": 510, "y": 250, "zoom": 0.84 },
                "ashen": { "x": 510, "y": 250, "zoom": 0.84 },
                "giant": { "x": 510, "y": 250, "zoom": 0.84 }
            },
            "construction": { "arc_smelter": 4, "em_rail_ejector": 0, "conveyor_belt_mk1": 5 },
            "constructionQueue": [],
            "blueprintVersions": [],
            "totalProduced": { "iron_ingot": 10 },
            "research": { "completedTechIds": [] },
            "dysonEngineering": {
                "activeOrbitBySystem": { "helios": "orbit-home-old", "sigma": "orbit-foreign" },
                "orbitsBySystem": {
                    "helios": [{ "id": "orbit-home-old" }, { "id": "orbit-home-new" }],
                    "sigma": [{ "id": "orbit-foreign" }]
                }
            }
        })
        .as_object()
        .unwrap()
        .clone();
        CoreState::from_public_v47_parts(
            CoreCheckpointIdentity {
                slot: "normal-main".to_owned(),
                generation: 1,
                root_hash: "a".repeat(64),
                revision: 9,
                state_version: 47,
                mode: "normal".to_owned(),
                registry_fingerprint: registry_fingerprint.to_owned(),
                base_primary_checksum: "12345678".to_owned(),
            },
            base,
            vec![
                player_command_entity("smelter-a", "arc_smelter", 1.0, None),
                player_command_entity("ejector-a", "em_rail_ejector", 3.0, Some("orbit-home-old")),
                player_command_entity("ejector-b", "em_rail_ejector", 5.0, Some("orbit-home-old")),
            ],
            vec![player_command_belt()],
            player_command_catalog_for_registry(registry_fingerprint),
        )
        .unwrap()
    }

    fn player_command_state() -> CoreState {
        player_command_state_for_registry(EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT)
    }

    fn empty_player_command(revision: u64) -> SimulationCommandPatch {
        SimulationCommandPatch {
            protocol_version: crate::CORE_PROTOCOL_VERSION,
            base_revision: revision,
            top_level_changes: Vec::new(),
            changed_entities: Vec::new(),
            added_entities: Vec::new(),
            removed_entity_ids: Vec::new(),
            changed_belts: Vec::new(),
            added_belts: Vec::new(),
            removed_belt_ids: Vec::new(),
        }
    }

    fn ordinary_placement_command(revision: u64) -> SimulationCommandPatch {
        let mut command = empty_player_command(revision);
        command.top_level_changes = vec![
            ValuePatch {
                path: vec![
                    PathSegment::Key("construction".to_owned()),
                    PathSegment::Key("arc_smelter".to_owned()),
                ],
                operation: "set".to_owned(),
                value: Some(Value::from(3)),
            },
            ValuePatch {
                path: vec![PathSegment::Key("nextId".to_owned())],
                operation: "set".to_owned(),
                value: Some(Value::from(10)),
            },
        ];
        command.added_entities = vec![AddedRecord {
            index: 3,
            value: serde_json::json!({
                "id": "entity_9",
                "kind": "machine",
                "planetId": "home",
                "position": { "x": 12.0, "y": 24.0 },
                "interactionLocked": false,
                "buildingId": "arc_smelter",
                "powerGridId": "grid-a",
                "powerPriority": 2,
                "recipeId": "iron_ingot",
                "machineCount": 1,
                "minerCount": 0,
                "inputs": {},
                "outputs": {},
                "progress": 0,
                "routingCursor": 0,
                "utilization": 0,
                "productionRate": 0
            }),
        }];
        command
    }

    fn ordinary_stack_change_command(
        revision: u64,
        target: u64,
        construction: u64,
    ) -> SimulationCommandPatch {
        let mut command = empty_player_command(revision);
        command.top_level_changes = vec![ValuePatch {
            path: vec![
                PathSegment::Key("construction".to_owned()),
                PathSegment::Key("arc_smelter".to_owned()),
            ],
            operation: "set".to_owned(),
            value: Some(Value::from(construction)),
        }];
        command.changed_entities = vec![RecordPatch {
            id: "smelter-a".to_owned(),
            changes: vec![ValuePatch {
                path: vec![PathSegment::Key("machineCount".to_owned())],
                operation: "set".to_owned(),
                value: Some(Value::from(target)),
            }],
        }];
        command
    }

    fn recipe_focus_leaf_command(
        revision: u64,
        path: &[&str],
        value: Value,
    ) -> SimulationCommandPatch {
        let mut command = empty_player_command(revision);
        command.top_level_changes = vec![ValuePatch {
            path: path
                .iter()
                .map(|segment| PathSegment::Key((*segment).to_owned()))
                .collect(),
            operation: "set".to_owned(),
            value: Some(value),
        }];
        command
    }

    fn recipe_focus_position_command(revision: u64, x: u64, y: u64) -> SimulationCommandPatch {
        let mut command =
            recipe_focus_leaf_command(revision, &["recipeFocus", "position", "x"], Value::from(x));
        command.top_level_changes.push(ValuePatch {
            path: ["recipeFocus", "position", "y"]
                .into_iter()
                .map(|segment| PathSegment::Key(segment.to_owned()))
                .collect(),
            operation: "set".to_owned(),
            value: Some(Value::from(y)),
        });
        command
    }

    fn planet_viewport_command(
        revision: u64,
        planet_id: &str,
        fields: &[(&str, Value)],
    ) -> SimulationCommandPatch {
        let mut command = empty_player_command(revision);
        command.top_level_changes = fields
            .iter()
            .map(|(field, value)| ValuePatch {
                path: ["planetViewports", planet_id, *field]
                    .into_iter()
                    .map(|segment| PathSegment::Key(segment.to_owned()))
                    .collect(),
                operation: "set".to_owned(),
                value: Some(value.clone()),
            })
            .collect();
        command
    }

    fn belt_priority_command(
        revision: u64,
        belt_id: &str,
        priority: Value,
    ) -> SimulationCommandPatch {
        let mut command = empty_player_command(revision);
        command.changed_belts = vec![RecordPatch {
            id: belt_id.to_owned(),
            changes: vec![ValuePatch {
                path: vec![PathSegment::Key("priority".to_owned())],
                operation: "set".to_owned(),
                value: Some(priority),
            }],
        }];
        command
    }

    fn belt_lane_command(
        revision: u64,
        lanes: Value,
        construction: Value,
    ) -> SimulationCommandPatch {
        let mut command = empty_player_command(revision);
        command.top_level_changes = vec![ValuePatch {
            path: vec![
                PathSegment::Key("construction".to_owned()),
                PathSegment::Key("conveyor_belt_mk1".to_owned()),
            ],
            operation: "set".to_owned(),
            value: Some(construction),
        }];
        command.changed_belts = vec![RecordPatch {
            id: "belt-priority".to_owned(),
            changes: vec![ValuePatch {
                path: vec![PathSegment::Key("lanes".to_owned())],
                operation: "set".to_owned(),
                value: Some(lanes),
            }],
        }];
        command
    }

    fn belt_configuration_command(
        revision: u64,
        changes: &[(&str, Value)],
    ) -> SimulationCommandPatch {
        let mut command = empty_player_command(revision);
        command.changed_belts = vec![RecordPatch {
            id: "belt-priority".to_owned(),
            changes: changes
                .iter()
                .map(|(field, value)| ValuePatch {
                    path: vec![PathSegment::Key((*field).to_owned())],
                    operation: "set".to_owned(),
                    value: Some(value.clone()),
                })
                .collect(),
        }];
        command
    }

    fn belt_removal_command(revision: u64, construction: Value) -> SimulationCommandPatch {
        let mut command = empty_player_command(revision);
        command.top_level_changes = vec![ValuePatch {
            path: vec![
                PathSegment::Key("construction".to_owned()),
                PathSegment::Key("conveyor_belt_mk1".to_owned()),
            ],
            operation: "set".to_owned(),
            value: Some(construction),
        }];
        command.removed_belt_ids = vec!["belt-priority".to_owned()];
        command
    }

    #[test]
    fn player_authority_places_one_canonical_catalog_building_atomically() {
        let mut state = player_command_state();
        let command = ordinary_placement_command(state.revision);
        let applied = state.apply_player_authority_command(&command).unwrap();
        assert_eq!(applied.previous_revision, 9);
        assert_eq!(applied.revision, 10);
        assert!(applied.topology_dirty);
        assert_eq!(applied.changed_entity_ids, ["entity_9"]);
        assert_eq!(state.base_value()["construction"]["arc_smelter"], 3);
        assert_eq!(state.base_value()["nextId"], 10);
        assert!(state.entity_index.contains_key("entity_9"));

        let committed_hash = state.canonical_sha256().unwrap();
        let retry_error = state.apply_player_authority_command(&command).unwrap_err();
        assert!(format!("{retry_error:#}").contains("base revision is not current"));
        assert_eq!(state.canonical_sha256().unwrap(), committed_hash);
    }

    #[test]
    fn player_authority_increases_builtin_building_stack_with_exact_debit() {
        let mut state = player_command_state();
        let command = ordinary_stack_change_command(state.revision, 5, 2);
        let applied = state.apply_player_authority_command(&command).unwrap();
        assert_eq!(applied.previous_revision, 9);
        assert_eq!(applied.revision, 10);
        assert_eq!(applied.changed_entity_ids, ["smelter-a"]);
        assert!(applied.changed_belt_ids.is_empty());
        assert!(applied.topology_dirty);
        assert_eq!(state.parse_entity(0).unwrap()["machineCount"], 5);
        assert_eq!(state.base_value()["construction"]["arc_smelter"], 2);

        let committed_hash = state.canonical_sha256().unwrap();
        let retry_error = state.apply_player_authority_command(&command).unwrap_err();
        assert!(format!("{retry_error:#}").contains("base revision is not current"));
        assert_eq!(state.canonical_sha256().unwrap(), committed_hash);
    }

    #[test]
    fn player_authority_stack_increase_fails_closed_on_inventory_limit_or_mod_catalog() {
        let commands = [
            ordinary_stack_change_command(9, 5, 3),
            ordinary_stack_change_command(9, 8, 0),
            ordinary_stack_change_command(9, MAX_PLAYER_BUILDING_STACK + 1, 0),
        ];
        for command in commands {
            let mut state = player_command_state();
            let before = state.canonical_sha256().unwrap();
            assert!(state.apply_player_authority_command(&command).is_err());
            assert_eq!(state.revision, 9);
            assert_eq!(state.canonical_sha256().unwrap(), before);
        }

        let mut modded = player_command_state_for_registry("modded-player-command-test");
        let before = modded.canonical_sha256().unwrap();
        let command = ordinary_stack_change_command(modded.revision, 5, 2);
        let error = modded.apply_player_authority_command(&command).unwrap_err();
        assert!(format!("{error:#}").contains("stack limit is not provable"));
        assert_eq!(modded.revision, 9);
        assert_eq!(modded.canonical_sha256().unwrap(), before);
    }

    #[test]
    fn player_authority_applies_only_canonical_recipe_focus_leaf_commands() {
        let mut state = player_command_state();
        let pin = recipe_focus_leaf_command(
            state.revision,
            &["recipeFocus", "itemId"],
            Value::from("iron_ingot"),
        );
        let pinned = state.apply_player_authority_command(&pin).unwrap();
        assert!(pinned.changed_entity_ids.is_empty());
        assert!(pinned.changed_belt_ids.is_empty());
        assert!(!pinned.topology_dirty);
        assert_eq!(state.base_value()["recipeFocus"]["itemId"], "iron_ingot");

        let mode = recipe_focus_leaf_command(
            state.revision,
            &["recipeFocus", "mode"],
            Value::from("full"),
        );
        let mode_result = state.apply_player_authority_command(&mode).unwrap();
        assert!(!mode_result.topology_dirty);
        assert_eq!(state.base_value()["recipeFocus"]["mode"], "full");

        let compact_mode = recipe_focus_leaf_command(
            state.revision,
            &["recipeFocus", "mode"],
            Value::from("two-level"),
        );
        let compact_mode_result = state.apply_player_authority_command(&compact_mode).unwrap();
        assert!(!compact_mode_result.topology_dirty);
        assert_eq!(state.base_value()["recipeFocus"]["mode"], "two-level");

        let position = recipe_focus_position_command(state.revision, 40, 96);
        let position_result = state.apply_player_authority_command(&position).unwrap();
        assert!(!position_result.topology_dirty);
        assert_eq!(state.base_value()["recipeFocus"]["position"]["x"], 40);
        assert_eq!(state.base_value()["recipeFocus"]["position"]["y"], 96);

        let one_axis_position = recipe_focus_leaf_command(
            state.revision,
            &["recipeFocus", "position", "x"],
            Value::from(48),
        );
        let one_axis_position_result = state
            .apply_player_authority_command(&one_axis_position)
            .unwrap();
        assert!(!one_axis_position_result.topology_dirty);
        assert_eq!(state.base_value()["recipeFocus"]["position"]["x"], 48);
        assert_eq!(state.base_value()["recipeFocus"]["position"]["y"], 96);

        let clear =
            recipe_focus_leaf_command(state.revision, &["recipeFocus", "itemId"], Value::Null);
        let clear_result = state.apply_player_authority_command(&clear).unwrap();
        assert!(!clear_result.topology_dirty);
        assert_eq!(state.base_value()["recipeFocus"]["itemId"], Value::Null);
        assert_eq!(state.revision, 15);

        let committed_hash = state.canonical_sha256().unwrap();
        let retry_error = state.apply_player_authority_command(&clear).unwrap_err();
        assert!(format!("{retry_error:#}").contains("base revision is not current"));
        assert_eq!(state.canonical_sha256().unwrap(), committed_hash);
    }

    #[test]
    fn player_authority_recipe_focus_rejects_unknown_whole_mixed_or_unsafe_patches() {
        let whole_focus = recipe_focus_leaf_command(
            9,
            &["recipeFocus"],
            serde_json::json!({
                "itemId": "iron_ingot",
                "mode": "two-level",
                "position": { "x": 24, "y": 72 }
            }),
        );
        let mut delete_item =
            recipe_focus_leaf_command(9, &["recipeFocus", "itemId"], Value::from("iron_ingot"));
        delete_item.top_level_changes[0].operation = "delete".to_owned();
        delete_item.top_level_changes[0].value = None;
        let mut mixed =
            recipe_focus_leaf_command(9, &["recipeFocus", "itemId"], Value::from("iron_ingot"));
        mixed.top_level_changes.push(ValuePatch {
            path: vec![PathSegment::Key("paused".to_owned())],
            operation: "set".to_owned(),
            value: Some(Value::from(false)),
        });
        let drag_with_unchanged_axis = recipe_focus_position_command(9, 40, 72);
        let unsafe_position = recipe_focus_leaf_command(
            9,
            &["recipeFocus", "position", "x"],
            Value::from(MAX_JAVASCRIPT_SAFE_INTEGER + 1),
        );
        let whole_position = recipe_focus_leaf_command(
            9,
            &["recipeFocus", "position"],
            serde_json::json!({ "x": 40, "y": 96 }),
        );
        let commands = [
            recipe_focus_leaf_command(9, &["recipeFocus", "itemId"], Value::from("missing_item")),
            recipe_focus_leaf_command(9, &["recipeFocus", "mode"], Value::from("expanded")),
            recipe_focus_leaf_command(9, &["recipeFocus", "position", "x"], Value::from(7)),
            recipe_focus_leaf_command(9, &["recipeFocus", "itemId"], Value::Null),
            whole_focus,
            whole_position,
            delete_item,
            mixed,
            unsafe_position,
            drag_with_unchanged_axis,
        ];
        for command in commands {
            let mut state = player_command_state();
            let before = state.canonical_sha256().unwrap();
            assert!(state.apply_player_authority_command(&command).is_err());
            assert_eq!(state.revision, 9);
            assert_eq!(state.canonical_sha256().unwrap(), before);
        }
    }

    #[test]
    fn player_authority_applies_only_canonical_planet_viewport_leaf_commands() {
        let mut state = player_command_state();
        let pan_and_zoom = planet_viewport_command(
            state.revision,
            "home",
            &[
                ("x", Value::from(-123.25)),
                ("y", Value::from(456.5)),
                ("zoom", Value::from(1.125)),
            ],
        );
        let panned = state.apply_player_authority_command(&pan_and_zoom).unwrap();
        assert!(panned.changed_entity_ids.is_empty());
        assert!(panned.changed_belt_ids.is_empty());
        assert!(!panned.topology_dirty);
        assert_eq!(state.base_value()["planetViewports"]["home"]["x"], -123.25);
        assert_eq!(state.base_value()["planetViewports"]["home"]["y"], 456.5);
        assert_eq!(state.base_value()["planetViewports"]["home"]["zoom"], 1.125);

        let queued_other_planet =
            planet_viewport_command(state.revision, "ashen", &[("x", Value::from(512.25))]);
        let queued = state
            .apply_player_authority_command(&queued_other_planet)
            .unwrap();
        assert!(!queued.topology_dirty);
        assert_eq!(state.base_value()["planetViewports"]["ashen"]["x"], 512.25);

        for zoom in [0.25, 1.8] {
            let zoom_command =
                planet_viewport_command(state.revision, "home", &[("zoom", Value::from(zoom))]);
            let zoomed = state.apply_player_authority_command(&zoom_command).unwrap();
            assert!(!zoomed.topology_dirty);
            assert_eq!(state.base_value()["planetViewports"]["home"]["zoom"], zoom);
        }
        assert_eq!(state.revision, 13);

        let committed_hash = state.canonical_sha256().unwrap();
        let retry_error = state
            .apply_player_authority_command(&pan_and_zoom)
            .unwrap_err();
        assert!(format!("{retry_error:#}").contains("base revision is not current"));
        assert_eq!(state.canonical_sha256().unwrap(), committed_hash);
    }

    #[test]
    fn player_authority_planet_viewport_rejects_whole_mixed_or_invalid_patches() {
        let whole_viewport = planet_viewport_command(
            9,
            "home",
            &[("viewport", serde_json::json!({ "x": 1, "y": 2, "zoom": 1 }))],
        );
        let whole_entry = {
            let mut command = empty_player_command(9);
            command.top_level_changes = vec![ValuePatch {
                path: ["planetViewports", "home"]
                    .into_iter()
                    .map(|segment| PathSegment::Key(segment.to_owned()))
                    .collect(),
                operation: "set".to_owned(),
                value: Some(serde_json::json!({ "x": 1, "y": 2, "zoom": 1 })),
            }];
            command
        };
        let whole_map = {
            let mut command = empty_player_command(9);
            command.top_level_changes = vec![ValuePatch {
                path: vec![PathSegment::Key("planetViewports".to_owned())],
                operation: "set".to_owned(),
                value: Some(serde_json::json!({
                    "home": { "x": 1, "y": 2, "zoom": 1 }
                })),
            }];
            command
        };
        let mut delete_x = planet_viewport_command(9, "home", &[("x", Value::from(511))]);
        delete_x.top_level_changes[0].operation = "delete".to_owned();
        delete_x.top_level_changes[0].value = None;
        let mut duplicate_x = planet_viewport_command(9, "home", &[("x", Value::from(511))]);
        duplicate_x
            .top_level_changes
            .push(duplicate_x.top_level_changes[0].clone());
        let mut cross_planet = planet_viewport_command(9, "home", &[("x", Value::from(511))]);
        cross_planet.top_level_changes.push(
            planet_viewport_command(9, "ashen", &[("y", Value::from(251))])
                .top_level_changes
                .remove(0),
        );
        let mut mixed = planet_viewport_command(9, "home", &[("x", Value::from(511))]);
        mixed.top_level_changes.push(ValuePatch {
            path: vec![PathSegment::Key("paused".to_owned())],
            operation: "set".to_owned(),
            value: Some(Value::from(false)),
        });
        let commands = [
            planet_viewport_command(9, "missing", &[("x", Value::from(1))]),
            planet_viewport_command(9, "home", &[("zoom", Value::from(0.249))]),
            planet_viewport_command(9, "home", &[("zoom", Value::from(1.801))]),
            planet_viewport_command(9, "home", &[("x", Value::from("far"))]),
            planet_viewport_command(9, "home", &[("x", Value::from(510))]),
            whole_viewport,
            whole_entry,
            whole_map,
            delete_x,
            duplicate_x,
            cross_planet,
            mixed,
        ];
        for command in commands {
            let mut state = player_command_state();
            let before = state.canonical_sha256().unwrap();
            assert!(state.apply_player_authority_command(&command).is_err());
            assert_eq!(state.revision, 9);
            assert_eq!(state.canonical_sha256().unwrap(), before);
        }

        let mut malformed = player_command_state();
        malformed.base_value_mut()["planetViewports"]["home"]["zoom"] = Value::from(2);
        let before = malformed.canonical_sha256().unwrap();
        let error = malformed
            .apply_player_authority_command(&planet_viewport_command(
                9,
                "home",
                &[("x", Value::from(511))],
            ))
            .unwrap_err();
        assert!(format!("{error:#}").contains("current planet viewport zoom"));
        assert_eq!(malformed.revision, 9);
        assert_eq!(malformed.canonical_sha256().unwrap(), before);
    }

    #[test]
    fn player_authority_applies_only_canonical_belt_priority_command() {
        let mut state = player_command_state();
        let command = belt_priority_command(state.revision, "belt-priority", Value::from(2));
        let applied = state.apply_player_authority_command(&command).unwrap();
        assert_eq!(applied.previous_revision, 9);
        assert_eq!(applied.revision, 10);
        assert!(applied.changed_entity_ids.is_empty());
        assert_eq!(applied.changed_belt_ids, ["belt-priority"]);
        assert!(applied.topology_dirty);
        let belt = state.parse_belt(0).unwrap();
        assert_eq!(belt["priority"], 2);
        assert_eq!(
            belt["modPayload"],
            serde_json::json!({ "owner": "pack:test", "revision": 7 })
        );

        let committed_hash = state.canonical_sha256().unwrap();
        let retry_error = state.apply_player_authority_command(&command).unwrap_err();
        assert!(format!("{retry_error:#}").contains("base revision is not current"));
        assert_eq!(state.canonical_sha256().unwrap(), committed_hash);

        let mut modded = player_command_state_for_registry("modded-belt-priority-test");
        let modded_command =
            belt_priority_command(modded.revision, "belt-priority", Value::from(0));
        let modded_applied = modded
            .apply_player_authority_command(&modded_command)
            .unwrap();
        assert!(modded_applied.topology_dirty);
        let modded_belt = modded.parse_belt(0).unwrap();
        assert_eq!(modded_belt["priority"], 0);
        assert_eq!(
            modded_belt["modPayload"],
            serde_json::json!({ "owner": "pack:test", "revision": 7 })
        );
    }

    #[test]
    fn player_authority_belt_priority_rejects_invalid_mixed_or_malformed_commands() {
        let mut delete = belt_priority_command(9, "belt-priority", Value::from(2));
        delete.changed_belts[0].changes[0].operation = "delete".to_owned();
        delete.changed_belts[0].changes[0].value = None;

        let mut duplicate_leaf = belt_priority_command(9, "belt-priority", Value::from(2));
        let repeated_priority = duplicate_leaf.changed_belts[0].changes[0].clone();
        duplicate_leaf.changed_belts[0]
            .changes
            .push(repeated_priority);

        let mut other_belt_field = belt_priority_command(9, "belt-priority", Value::from(2));
        other_belt_field.changed_belts[0].changes.push(ValuePatch {
            path: vec![PathSegment::Key("routeMode".to_owned())],
            operation: "set".to_owned(),
            value: Some(Value::from("supply")),
        });

        let mut mixed_mod_payload = belt_priority_command(9, "belt-priority", Value::from(2));
        mixed_mod_payload.changed_belts[0].changes.push(ValuePatch {
            path: vec![PathSegment::Key("modPayload".to_owned())],
            operation: "set".to_owned(),
            value: Some(serde_json::json!({ "owner": "forged" })),
        });

        let mut mixed_top_level = belt_priority_command(9, "belt-priority", Value::from(2));
        mixed_top_level.top_level_changes = vec![ValuePatch {
            path: vec![PathSegment::Key("paused".to_owned())],
            operation: "set".to_owned(),
            value: Some(Value::from(true)),
        }];

        let mut mixed_entity = belt_priority_command(9, "belt-priority", Value::from(2));
        mixed_entity.changed_entities = vec![RecordPatch {
            id: "smelter-a".to_owned(),
            changes: vec![ValuePatch {
                path: vec![
                    PathSegment::Key("position".to_owned()),
                    PathSegment::Key("x".to_owned()),
                ],
                operation: "set".to_owned(),
                value: Some(Value::from(12)),
            }],
        }];

        let mut added_belt = belt_priority_command(9, "belt-priority", Value::from(2));
        added_belt.added_belts = vec![AddedRecord {
            index: 1,
            value: serde_json::json!({
                "id": "forged-belt",
                "planetId": "home",
                "source": "ejector-a",
                "target": "ejector-b",
                "itemId": "solar_sail",
                "lanes": 1,
                "tier": 1,
                "priority": 1
            }),
        }];

        let mut duplicate_record = belt_priority_command(9, "belt-priority", Value::from(2));
        let repeated_record = duplicate_record.changed_belts[0].clone();
        duplicate_record.changed_belts.push(repeated_record);

        let mut nested_priority = belt_priority_command(9, "belt-priority", Value::from(2));
        nested_priority.changed_belts[0].changes[0]
            .path
            .push(PathSegment::Key("level".to_owned()));

        let commands = [
            belt_priority_command(9, "missing-belt", Value::from(2)),
            belt_priority_command(9, "belt-priority", Value::from(3)),
            belt_priority_command(9, "belt-priority", Value::from(-1)),
            belt_priority_command(9, "belt-priority", Value::from(2.0)),
            belt_priority_command(9, "belt-priority", Value::from("high")),
            belt_priority_command(9, "belt-priority", Value::from(1)),
            delete,
            duplicate_leaf,
            other_belt_field,
            mixed_mod_payload,
            mixed_top_level,
            mixed_entity,
            added_belt,
            duplicate_record,
            nested_priority,
        ];
        for command in commands {
            let mut state = player_command_state();
            let before = state.canonical_sha256().unwrap();
            assert!(state.apply_player_authority_command(&command).is_err());
            assert_eq!(state.revision, 9);
            assert_eq!(state.canonical_sha256().unwrap(), before);
        }

        for current in [
            Value::from(9),
            Value::from(-1),
            Value::from(1.0),
            Value::from("high"),
            Value::Null,
        ] {
            let mut malformed = player_command_state();
            malformed
                .apply_command(&belt_priority_command(9, "belt-priority", current))
                .unwrap();
            let before = malformed.canonical_sha256().unwrap();
            let error = malformed
                .apply_player_authority_command(&belt_priority_command(
                    10,
                    "belt-priority",
                    Value::from(2),
                ))
                .unwrap_err();
            assert!(format!("{error:#}").contains("current belt priority"));
            assert_eq!(malformed.revision, 10);
            assert_eq!(malformed.canonical_sha256().unwrap(), before);
        }

        let mut missing_current = player_command_state();
        let mut delete_current = belt_priority_command(9, "belt-priority", Value::from(2));
        delete_current.changed_belts[0].changes[0].operation = "delete".to_owned();
        delete_current.changed_belts[0].changes[0].value = None;
        missing_current.apply_command(&delete_current).unwrap();
        let before = missing_current.canonical_sha256().unwrap();
        let error = missing_current
            .apply_player_authority_command(&belt_priority_command(
                10,
                "belt-priority",
                Value::from(2),
            ))
            .unwrap_err();
        assert!(format!("{error:#}").contains("current belt priority"));
        assert_eq!(missing_current.revision, 10);
        assert_eq!(missing_current.canonical_sha256().unwrap(), before);
    }

    #[test]
    fn player_authority_adjusts_belt_lanes_with_exact_inventory_accounting() {
        let mut state = player_command_state();
        let increase = belt_lane_command(state.revision, Value::from(3), Value::from(3));
        let increased = state.apply_player_authority_command(&increase).unwrap();
        assert_eq!(increased.changed_belt_ids, ["belt-priority"]);
        assert!(increased.topology_dirty);
        assert_eq!(state.parse_belt(0).unwrap()["lanes"], 3);
        assert_eq!(state.base_value()["construction"]["conveyor_belt_mk1"], 3);

        let decrease = belt_lane_command(state.revision, Value::from(1), Value::from(5));
        let decreased = state.apply_player_authority_command(&decrease).unwrap();
        assert_eq!(decreased.changed_belt_ids, ["belt-priority"]);
        assert!(decreased.topology_dirty);
        assert_eq!(state.parse_belt(0).unwrap()["lanes"], 1);
        assert_eq!(state.base_value()["construction"]["conveyor_belt_mk1"], 5);

        let committed_hash = state.canonical_sha256().unwrap();
        assert!(state.apply_player_authority_command(&decrease).is_err());
        assert_eq!(state.canonical_sha256().unwrap(), committed_hash);
    }

    #[test]
    fn player_authority_removes_belt_with_exact_refund() {
        let mut state = player_command_state();
        let command = belt_removal_command(state.revision, Value::from(6));
        let applied = state.apply_player_authority_command(&command).unwrap();
        assert_eq!(applied.changed_belt_ids, ["belt-priority"]);
        assert!(applied.topology_dirty);
        assert!(state.belt_index.is_empty());
        assert_eq!(state.base_value()["construction"]["conveyor_belt_mk1"], 6);

        let committed_hash = state.canonical_sha256().unwrap();
        assert!(state.apply_player_authority_command(&command).is_err());
        assert_eq!(state.canonical_sha256().unwrap(), committed_hash);
    }

    #[test]
    fn player_authority_applies_bounded_belt_configuration_without_touching_mod_fields() {
        let mut state = player_command_state();
        state.base_value_mut()["research"]["completedTechIds"] =
            serde_json::json!(["high_speed_logistics", "super_magnetic_logistics"]);
        let command = belt_configuration_command(
            state.revision,
            &[
                ("priority", Value::from(2)),
                ("monitorEnabled", Value::from(true)),
                ("routeMode", Value::from("manual")),
                ("routeOffsetY", Value::from(42)),
                ("stackSize", Value::from(4)),
            ],
        );
        let applied = state.apply_player_authority_command(&command).unwrap();
        assert_eq!(applied.changed_belt_ids, ["belt-priority"]);
        assert!(applied.topology_dirty);
        let belt = state.parse_belt(0).unwrap();
        assert_eq!(belt["priority"], 2);
        assert_eq!(belt["monitorEnabled"], true);
        assert_eq!(belt["routeMode"], "manual");
        assert_eq!(belt["routeOffsetY"], 42);
        assert_eq!(belt["stackSize"], 4);
        assert_eq!(
            belt["modPayload"],
            serde_json::json!({ "owner": "pack:test", "revision": 7 })
        );

        let monitor_only =
            belt_configuration_command(state.revision, &[("monitorEnabled", Value::from(false))]);
        let monitored = state.apply_player_authority_command(&monitor_only).unwrap();
        assert!(!monitored.topology_dirty);
    }

    #[test]
    fn player_authority_belt_inventory_and_configuration_fail_closed_without_mutation() {
        let mut delete_lane = belt_lane_command(9, Value::from(2), Value::from(4));
        delete_lane.changed_belts[0].changes[0].operation = "delete".to_owned();
        delete_lane.changed_belts[0].changes[0].value = None;
        let mut lane_with_extra = belt_lane_command(9, Value::from(2), Value::from(4));
        lane_with_extra.changed_belts[0].changes.push(ValuePatch {
            path: vec![PathSegment::Key("priority".to_owned())],
            operation: "set".to_owned(),
            value: Some(Value::from(2)),
        });
        let mut duplicate_removal = belt_removal_command(9, Value::from(7));
        duplicate_removal
            .removed_belt_ids
            .push("belt-priority".to_owned());
        let commands = [
            belt_lane_command(9, Value::from(2), Value::from(5)),
            belt_lane_command(9, Value::from(0), Value::from(6)),
            belt_lane_command(9, Value::from(4_097), Value::from(0)),
            belt_lane_command(9, Value::from(2.0), Value::from(4)),
            delete_lane,
            lane_with_extra,
            belt_removal_command(9, Value::from(5)),
            duplicate_removal,
            belt_configuration_command(9, &[("routeMode", Value::from("supply"))]),
            belt_configuration_command(9, &[("routeOffsetY", Value::from(42))]),
            belt_configuration_command(9, &[("routeOffsetY", Value::from(601))]),
            belt_configuration_command(9, &[("stackSize", Value::from(2))]),
            belt_configuration_command(9, &[("progress", Value::from(0))]),
            belt_configuration_command(9, &[("monitorEnabled", Value::from("yes"))]),
        ];
        for command in commands {
            let mut state = player_command_state();
            let before = state.canonical_sha256().unwrap();
            assert!(state.apply_player_authority_command(&command).is_err());
            assert_eq!(state.revision, 9);
            assert_eq!(state.canonical_sha256().unwrap(), before);
        }

        let mut modded = player_command_state_for_registry("modded-belt-inventory-test");
        for command in [
            belt_lane_command(9, Value::from(2), Value::from(4)),
            belt_removal_command(9, Value::from(6)),
        ] {
            let before = modded.canonical_sha256().unwrap();
            assert!(modded.apply_player_authority_command(&command).is_err());
            assert_eq!(modded.revision, 9);
            assert_eq!(modded.canonical_sha256().unwrap(), before);
        }
    }

    #[test]
    fn player_authority_rejects_forged_or_untyped_state_without_mutation() {
        for mut command in [
            {
                let mut command = ordinary_placement_command(9);
                command.top_level_changes[0].value = Some(Value::from(2));
                command
            },
            {
                let mut command = ordinary_placement_command(9);
                command.added_entities[0].value["machineCount"] = Value::from(2);
                command.top_level_changes[0].value = Some(Value::from(2));
                command
            },
            {
                let mut command = empty_player_command(9);
                command.top_level_changes = vec![ValuePatch {
                    path: vec![
                        PathSegment::Key("totalProduced".to_owned()),
                        PathSegment::Key("iron_ingot".to_owned()),
                    ],
                    operation: "set".to_owned(),
                    value: Some(Value::from(999_999)),
                }];
                command
            },
            {
                let mut command = empty_player_command(9);
                command.changed_entities = vec![RecordPatch {
                    id: "smelter-a".to_owned(),
                    changes: vec![ValuePatch {
                        path: vec![PathSegment::Key("recipeId".to_owned())],
                        operation: "set".to_owned(),
                        value: Some(Value::from("solar_sail_launch")),
                    }],
                }];
                command
            },
        ] {
            let mut state = player_command_state();
            command.base_revision = state.revision;
            let before = state.canonical_sha256().unwrap();
            assert!(state.apply_player_authority_command(&command).is_err());
            assert_eq!(state.revision, 9);
            assert_eq!(state.canonical_sha256().unwrap(), before);
        }

        for top_level_key in [
            "elapsedSeconds",
            "historyRecordedAt",
            "productionHistory",
            "metrics",
            "planetMetrics",
            "powerGridMetrics",
            "idleSettlement",
            "dysonSphere",
        ] {
            let mut state = player_command_state();
            let mut command = empty_player_command(state.revision);
            command.top_level_changes = vec![ValuePatch {
                path: vec![PathSegment::Key(top_level_key.to_owned())],
                operation: "set".to_owned(),
                value: Some(serde_json::json!({ "forged": true })),
            }];
            let before = state.canonical_sha256().unwrap();
            assert!(
                state.apply_player_authority_command(&command).is_err(),
                "{top_level_key}"
            );
            assert_eq!(state.revision, 9, "{top_level_key}");
            assert_eq!(state.canonical_sha256().unwrap(), before, "{top_level_key}");
        }
    }

    #[test]
    fn player_authority_decreases_and_removes_empty_unwired_building() {
        let mut state = player_command_state();
        let mut decrease = empty_player_command(state.revision);
        decrease.top_level_changes = vec![ValuePatch {
            path: vec![
                PathSegment::Key("construction".to_owned()),
                PathSegment::Key("arc_smelter".to_owned()),
            ],
            operation: "set".to_owned(),
            value: Some(Value::from(6)),
        }];
        decrease.changed_entities = vec![RecordPatch {
            id: "smelter-a".to_owned(),
            changes: vec![ValuePatch {
                path: vec![PathSegment::Key("machineCount".to_owned())],
                operation: "set".to_owned(),
                value: Some(Value::from(1)),
            }],
        }];
        state.apply_player_authority_command(&decrease).unwrap();
        assert_eq!(state.parse_entity(0).unwrap()["machineCount"], 1);
        assert_eq!(state.base_value()["construction"]["arc_smelter"], 6);

        let mut removal = empty_player_command(state.revision);
        removal.top_level_changes = vec![ValuePatch {
            path: vec![
                PathSegment::Key("construction".to_owned()),
                PathSegment::Key("arc_smelter".to_owned()),
            ],
            operation: "set".to_owned(),
            value: Some(Value::from(7)),
        }];
        removal.removed_entity_ids = vec!["smelter-a".to_owned()];
        let applied = state.apply_player_authority_command(&removal).unwrap();
        assert!(applied.topology_dirty);
        assert!(!state.entity_index.contains_key("smelter-a"));
        assert_eq!(state.base_value()["construction"]["arc_smelter"], 7);
    }

    #[test]
    fn player_authority_validates_position_and_system_local_ejector_targets() {
        let mut moved = player_command_state();
        let mut position = empty_player_command(moved.revision);
        position.changed_entities = vec![RecordPatch {
            id: "smelter-a".to_owned(),
            changes: vec![
                ValuePatch {
                    path: vec![
                        PathSegment::Key("position".to_owned()),
                        PathSegment::Key("x".to_owned()),
                    ],
                    operation: "set".to_owned(),
                    value: Some(Value::from(8.5)),
                },
                ValuePatch {
                    path: vec![
                        PathSegment::Key("position".to_owned()),
                        PathSegment::Key("y".to_owned()),
                    ],
                    operation: "set".to_owned(),
                    value: Some(Value::from(9.5)),
                },
            ],
        }];
        let result = moved.apply_player_authority_command(&position).unwrap();
        assert!(!result.topology_dirty);
        assert_eq!(moved.parse_entity(0).unwrap()["position"]["x"], 8.5);

        let mut state = player_command_state();
        let mut target = empty_player_command(state.revision);
        target.changed_entities = ["ejector-a", "ejector-b"]
            .into_iter()
            .map(|id| RecordPatch {
                id: id.to_owned(),
                changes: vec![ValuePatch {
                    path: vec![PathSegment::Key("targetDysonOrbitId".to_owned())],
                    operation: "set".to_owned(),
                    value: Some(Value::from("orbit-home-new")),
                }],
            })
            .collect();
        state.apply_player_authority_command(&target).unwrap();
        assert_eq!(
            state.parse_entity(1).unwrap()["targetDysonOrbitId"],
            "orbit-home-new"
        );
        assert_eq!(
            state.parse_entity(2).unwrap()["targetDysonOrbitId"],
            "orbit-home-new"
        );

        let mut rejected = player_command_state();
        target.base_revision = rejected.revision;
        target.changed_entities[0].changes[0].value = Some(Value::from("orbit-foreign"));
        target.changed_entities.truncate(1);
        let before = rejected.canonical_sha256().unwrap();
        assert!(rejected.apply_player_authority_command(&target).is_err());
        assert_eq!(rejected.canonical_sha256().unwrap(), before);
    }
}
