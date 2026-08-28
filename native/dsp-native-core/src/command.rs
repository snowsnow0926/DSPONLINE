use anyhow::{anyhow, bail};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Map, Value};
use std::{
    collections::{BTreeMap, HashSet},
    sync::Arc,
};

use crate::state::CoreState;

const MAX_PLAYER_BUILDING_STACK: u64 = 100_000_000;
const MAX_PLAYER_BELT_LANES: u64 = 4_096;
const PLAYER_STATION_SLOT_COUNT: usize = 5;
const MAX_PLAYER_STATION_STOCK: u64 = 100_000_000;
const PLAYER_STATION_DRONES_PER_BUILDING: u64 = 50;
const PLAYER_STATION_VESSELS_PER_BUILDING: u64 = 10;
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

fn optional_exact_set_patch<'a>(
    patches: &'a [ValuePatch],
    expected_path: &[&str],
) -> anyhow::Result<Option<&'a Value>> {
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
    Ok(found)
}

fn require_exact_set_patch_values(
    patches: &[ValuePatch],
    expected: &[(Vec<&str>, Value)],
) -> anyhow::Result<()> {
    if patches.len() != expected.len() {
        bail!("native player-authority protected patch set is incomplete or mixed")
    }
    let mut matched = vec![false; expected.len()];
    for patch in patches {
        let Some(index) = expected
            .iter()
            .position(|(path, _)| path_matches(&patch.path, path))
        else {
            bail!("native player-authority protected patch set contains an unknown path")
        };
        if matched[index] || patch.operation != "set" {
            bail!("native player-authority protected patch set is repeated or malformed")
        }
        let value = patch
            .value
            .as_ref()
            .ok_or_else(|| anyhow!("native player-authority protected set has no value"))?;
        if value != &expected[index].1 {
            bail!("native player-authority protected patch value is not canonical")
        }
        matched[index] = true;
    }
    if matched.iter().any(|matched| !matched) {
        bail!("native player-authority protected patch set is incomplete")
    }
    Ok(())
}

fn patch_paths_equal(left: &[PathSegment], right: &[PathSegment]) -> bool {
    left.len() == right.len()
        && left
            .iter()
            .zip(right)
            .all(|(left, right)| match (left, right) {
                (PathSegment::Key(left), PathSegment::Key(right)) => left == right,
                (PathSegment::Index(left), PathSegment::Index(right)) => left == right,
                _ => false,
            })
}

fn optional_undefined_station_path(path: &[PathSegment]) -> bool {
    matches!(
        path.last(),
        Some(PathSegment::Key(field)) if field == "stationPeerId"
    )
}

fn exact_patch_sets_match(actual: &[ValuePatch], expected: &[ValuePatch]) -> anyhow::Result<()> {
    if actual.len() != expected.len() {
        bail!("native player-authority station patch set is incomplete or mixed")
    }
    let mut matched = vec![false; expected.len()];
    for actual_patch in actual {
        let Some(expected_index) =
            expected
                .iter()
                .enumerate()
                .find_map(|(index, expected_patch)| {
                    (!matched[index] && patch_paths_equal(&actual_patch.path, &expected_patch.path))
                        .then_some(index)
                })
        else {
            bail!("native player-authority station patch path is not canonical")
        };
        let expected_patch = &expected[expected_index];
        let equivalent_optional_delete = expected_patch.operation == "delete"
            && actual_patch.operation == "set"
            && actual_patch.value.as_ref().is_none_or(Value::is_null)
            && optional_undefined_station_path(&actual_patch.path);
        let equivalent_delete = expected_patch.operation == "delete"
            && actual_patch.operation == "delete"
            && actual_patch.value.as_ref().is_none_or(Value::is_null);
        let equivalent_set = expected_patch.operation == "set"
            && actual_patch.operation == "set"
            && actual_patch.value == expected_patch.value;
        if !equivalent_optional_delete && !equivalent_delete && !equivalent_set {
            bail!("native player-authority station patch value is not canonical")
        }
        matched[expected_index] = true;
    }
    if matched.iter().any(|matched| !matched) {
        bail!("native player-authority station patch set is incomplete")
    }
    Ok(())
}

fn create_expected_value_patches(
    previous: &Value,
    current: &Value,
    path: Vec<PathSegment>,
    changes: &mut Vec<ValuePatch>,
) {
    if previous == current {
        return;
    }
    match (previous, current) {
        (Value::Array(previous), Value::Array(current)) if previous.len() == current.len() => {
            for (index, (previous, current)) in previous.iter().zip(current).enumerate() {
                let mut child_path = path.clone();
                child_path.push(PathSegment::Index(index));
                create_expected_value_patches(previous, current, child_path, changes);
            }
        }
        (Value::Object(previous), Value::Object(current)) => {
            let mut keys = previous
                .keys()
                .chain(current.keys())
                .cloned()
                .collect::<Vec<_>>();
            keys.sort_unstable();
            keys.dedup();
            for key in keys {
                let mut child_path = path.clone();
                child_path.push(PathSegment::Key(key.clone()));
                match (previous.get(&key), current.get(&key)) {
                    (Some(previous), Some(current)) => {
                        create_expected_value_patches(previous, current, child_path, changes)
                    }
                    (Some(_), None) => changes.push(ValuePatch {
                        path: child_path,
                        operation: "delete".to_owned(),
                        value: None,
                    }),
                    (None, Some(current)) => changes.push(ValuePatch {
                        path: child_path,
                        operation: "set".to_owned(),
                        value: Some(current.clone()),
                    }),
                    (None, None) => unreachable!("a key came from at least one object"),
                }
            }
        }
        _ => changes.push(ValuePatch {
            path,
            operation: "set".to_owned(),
            value: Some(current.clone()),
        }),
    }
}

fn normalized_nonnegative_integer(value: Option<&Value>, label: &str) -> anyhow::Result<u64> {
    let Some(value) = value else {
        return Ok(0);
    };
    if value.is_null() {
        return Ok(0);
    }
    let value = value
        .as_f64()
        .filter(|value| value.is_finite())
        .ok_or_else(|| anyhow!("native player-authority {label} is invalid"))?
        .floor()
        .max(0.0);
    if value > MAX_JAVASCRIPT_SAFE_INTEGER as f64 {
        bail!("native player-authority {label} exceeds the safe integer limit")
    }
    Ok(value as u64)
}

fn normalized_nonnegative_inventory(value: Option<&Value>, label: &str) -> anyhow::Result<u64> {
    let Some(value) = value else {
        return Ok(0);
    };
    if value.is_null() {
        return Ok(0);
    }
    let value = value
        .as_f64()
        .filter(|value| value.is_finite() && *value >= 0.0)
        .ok_or_else(|| anyhow!("native player-authority {label} is invalid"))?
        .floor();
    if value > MAX_JAVASCRIPT_SAFE_INTEGER as f64 {
        bail!("native player-authority {label} exceeds the safe integer limit")
    }
    Ok(value as u64)
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
        .filter(|planet_id| {
            state
                .catalog
                .planets
                .iter()
                .any(|planet| planet.id == *planet_id)
        })
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

fn validate_interaction_lock_command(
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
        bail!("native player-authority interaction lock command shape is invalid")
    }
    let mut entity_ids = HashSet::new();
    let mut shared_target = None;
    for record in &command.changed_entities {
        if !entity_ids.insert(record.id.as_str()) || record.changes.len() != 1 {
            bail!("native player-authority interaction lock target set is invalid")
        }
        let target = require_exact_set_patch(&record.changes, &["interactionLocked"])?
            .as_bool()
            .ok_or_else(|| anyhow!("native player-authority interaction lock target is invalid"))?;
        if shared_target.is_some_and(|candidate| candidate != target) {
            bail!("native player-authority interaction lock batch targets disagree")
        }
        shared_target = Some(target);
        let index = *state
            .entity_index
            .get(&record.id)
            .ok_or_else(|| anyhow!("native player-authority interaction lock entity is missing"))?;
        let entity = state.parse_entity(index)?;
        // v47 treats an absent optional field as unlocked. Setting either
        // explicit boolean is still a real canonicalization command and must
        // remain reachable for an older/MOD-authored entity.
        if let Some(current) = entity.get("interactionLocked") {
            let current = current.as_bool().ok_or_else(|| {
                anyhow!("native player-authority current interaction lock is invalid")
            })?;
            if current == target {
                bail!("native player-authority interaction lock target is unchanged")
            }
        }
    }
    Ok(())
}

fn validate_entity_power_or_splitter_configuration_command(
    state: &CoreState,
    command: &SimulationCommandPatch,
) -> anyhow::Result<()> {
    if command.changed_entities.len() != 1
        || command.changed_entities[0].changes.len() != 1
        || !command.top_level_changes.is_empty()
        || !command.added_entities.is_empty()
        || !command.removed_entity_ids.is_empty()
        || !command.changed_belts.is_empty()
        || !command.added_belts.is_empty()
        || !command.removed_belt_ids.is_empty()
    {
        bail!("native player-authority entity configuration command shape is invalid")
    }
    let record = &command.changed_entities[0];
    let index = *state
        .entity_index
        .get(&record.id)
        .ok_or_else(|| anyhow!("native player-authority configured entity is missing"))?;
    let entity = state.parse_entity(index)?;
    let object = entity
        .as_object()
        .ok_or_else(|| anyhow!("native player-authority configured entity is invalid"))?;
    if let Some(locked) = object.get("interactionLocked")
        && locked.as_bool() != Some(false)
    {
        bail!("native player-authority configured entity is locked or malformed")
    }
    let change = &record.changes[0];
    if change.operation != "set" {
        bail!("native player-authority entity configuration operation is invalid")
    }
    let target = change
        .value
        .as_ref()
        .ok_or_else(|| anyhow!("native player-authority entity configuration has no value"))?;
    let [PathSegment::Key(field)] = change.path.as_slice() else {
        bail!("native player-authority entity configuration path is invalid")
    };
    if object.get(field) == Some(target) {
        bail!("native player-authority entity configuration target is unchanged")
    }
    match field.as_str() {
        "powerGridId" => {
            target
                .as_str()
                .filter(|grid_id| matches!(*grid_id, "grid-a" | "grid-b" | "grid-c"))
                .ok_or_else(|| anyhow!("native player-authority power grid target is invalid"))?;
            if let Some(current) = object.get("powerGridId") {
                current
                    .as_str()
                    .filter(|grid_id| matches!(*grid_id, "grid-a" | "grid-b" | "grid-c"))
                    .ok_or_else(|| {
                        anyhow!("native player-authority current power grid is invalid")
                    })?;
            }
        }
        "powerPriority" => {
            target
                .as_u64()
                .filter(|priority| (1..=3).contains(priority))
                .ok_or_else(|| {
                    anyhow!("native player-authority power priority target is invalid")
                })?;
            if let Some(current) = object.get("powerPriority") {
                current
                    .as_u64()
                    .filter(|priority| (1..=3).contains(priority))
                    .ok_or_else(|| {
                        anyhow!("native player-authority current power priority is invalid")
                    })?;
            }
        }
        "generationPriority" => {
            target
                .as_u64()
                .filter(|priority| (1..=3).contains(priority))
                .ok_or_else(|| {
                    anyhow!("native player-authority generation priority target is invalid")
                })?;
            if object.get("kind").and_then(Value::as_str) != Some("power")
                && object.get("buildingId").and_then(Value::as_str) != Some("ray_receiver")
            {
                bail!("native player-authority generation priority target cannot generate power")
            }
            if let Some(current) = object.get("generationPriority") {
                current
                    .as_u64()
                    .filter(|priority| (1..=3).contains(priority))
                    .ok_or_else(|| {
                        anyhow!("native player-authority current generation priority is invalid")
                    })?;
            }
        }
        "distributionMode" => {
            target
                .as_str()
                .filter(|mode| matches!(*mode, "balanced" | "priority"))
                .ok_or_else(|| {
                    anyhow!("native player-authority splitter mode target is invalid")
                })?;
            if object.get("kind").and_then(Value::as_str) != Some("splitter") {
                bail!("native player-authority splitter mode target is not a splitter")
            }
            if let Some(current) = object.get("distributionMode") {
                current
                    .as_str()
                    .filter(|mode| matches!(*mode, "balanced" | "priority"))
                    .ok_or_else(|| {
                        anyhow!("native player-authority current splitter mode is invalid")
                    })?;
            }
        }
        _ => bail!("native player-authority entity configuration field is not typed"),
    }
    Ok(())
}

fn station_slot_mode_change(change: &ValuePatch) -> Option<(usize, &str)> {
    match change.path.as_slice() {
        [
            PathSegment::Key(root),
            PathSegment::Index(slot_index),
            PathSegment::Key(field),
        ] if root == "stationSlots" && matches!(field.as_str(), "localMode" | "remoteMode") => {
            Some((*slot_index, field.as_str()))
        }
        _ => None,
    }
}

fn command_contains_station_slot_mode(command: &SimulationCommandPatch) -> bool {
    command.changed_entities.iter().any(|record| {
        record
            .changes
            .iter()
            .any(|change| station_slot_mode_change(change).is_some())
    })
}

fn expected_entity_mut<'a>(
    state: &CoreState,
    expected: &'a mut BTreeMap<String, (Value, Value)>,
    entity_id: &str,
) -> anyhow::Result<&'a mut Value> {
    if !expected.contains_key(entity_id) {
        let index = *state
            .entity_index
            .get(entity_id)
            .ok_or_else(|| anyhow!("native player-authority station route entity is missing"))?;
        let current = state.parse_entity(index)?;
        expected.insert(entity_id.to_owned(), (current.clone(), current));
    }
    Ok(&mut expected
        .get_mut(entity_id)
        .expect("expected station entity was inserted")
        .1)
}

#[derive(Debug)]
struct StationRouteWarperRefund {
    owner_id: Option<String>,
    fallback_planet_id: String,
    amount: u64,
}

fn validate_station_slot_mode_command(
    state: &CoreState,
    command: &SimulationCommandPatch,
) -> anyhow::Result<()> {
    if !command.added_entities.is_empty()
        || !command.removed_entity_ids.is_empty()
        || !command.changed_belts.is_empty()
        || !command.added_belts.is_empty()
        || !command.removed_belt_ids.is_empty()
    {
        bail!("native player-authority station mode command shape is invalid")
    }

    let mut intent = None;
    for record in &command.changed_entities {
        for change in &record.changes {
            let Some((slot_index, field)) = station_slot_mode_change(change) else {
                continue;
            };
            if intent.is_some() || change.operation != "set" {
                bail!("native player-authority station mode intent is repeated or malformed")
            }
            let mode = change
                .value
                .as_ref()
                .and_then(Value::as_str)
                .filter(|mode| matches!(*mode, "supply" | "demand" | "storage"))
                .ok_or_else(|| anyhow!("native player-authority station mode target is invalid"))?;
            intent = Some((
                record.id.clone(),
                slot_index,
                field.to_owned(),
                mode.to_owned(),
            ));
        }
    }
    let (target_id, slot_index, mode_field, target_mode) =
        intent.ok_or_else(|| anyhow!("native player-authority station mode intent is missing"))?;
    if slot_index >= PLAYER_STATION_SLOT_COUNT {
        bail!("native player-authority station mode slot is out of range")
    }

    let target_index = *state
        .entity_index
        .get(&target_id)
        .ok_or_else(|| anyhow!("native player-authority station mode target is missing"))?;
    let target = state.parse_entity(target_index)?;
    let target_object = target
        .as_object()
        .ok_or_else(|| anyhow!("native player-authority station mode target is invalid"))?;
    let building_id = target_object
        .get("buildingId")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("native player-authority station mode building is missing"))?
        .to_owned();
    if target_object.get("kind").and_then(Value::as_str) != Some("station")
        || building_id == "orbital_collector"
        || state
            .catalog
            .buildings
            .get(&building_id)
            .is_none_or(|building| building.kind != "station")
    {
        bail!("native player-authority station mode target is not configurable")
    }
    if let Some(locked) = target_object.get("interactionLocked")
        && locked.as_bool() != Some(false)
    {
        bail!("native player-authority station mode target is locked or malformed")
    }
    let _target_planet_id = target_object
        .get("planetId")
        .and_then(Value::as_str)
        .filter(|planet_id| {
            state
                .catalog
                .planets
                .iter()
                .any(|planet| planet.id == *planet_id)
        })
        .ok_or_else(|| anyhow!("native player-authority station mode planet is invalid"))?
        .to_owned();
    let slots = target_object
        .get("stationSlots")
        .and_then(Value::as_array)
        .filter(|slots| slots.len() == PLAYER_STATION_SLOT_COUNT)
        .ok_or_else(|| anyhow!("native player-authority station mode slots are invalid"))?;
    let slot = slots[slot_index]
        .as_object()
        .ok_or_else(|| anyhow!("native player-authority station mode slot is invalid"))?;
    let item_id = slot
        .get("itemId")
        .and_then(Value::as_str)
        .filter(|item_id| state.catalog.items.contains_key(*item_id))
        .ok_or_else(|| anyhow!("native player-authority station mode slot item is invalid"))?
        .to_owned();
    let current_mode = slot
        .get(&mode_field)
        .and_then(Value::as_str)
        .filter(|mode| matches!(*mode, "supply" | "demand" | "storage"))
        .ok_or_else(|| anyhow!("native player-authority current station mode is invalid"))?;
    if current_mode == target_mode {
        bail!("native player-authority station mode target is unchanged")
    }
    let scope = if mode_field == "localMode" {
        "local"
    } else {
        if building_id != "interstellar_logistics_station" {
            bail!("native player-authority remote mode requires an interstellar station")
        }
        "remote"
    };

    let mut expected_entities = BTreeMap::<String, (Value, Value)>::new();
    expected_entities.insert(target_id.clone(), (target.clone(), target));
    let mut refunds = Vec::<StationRouteWarperRefund>::new();

    // Routes are reservations: canceling one releases its cargo in place and
    // refunds only the warpers already reserved by the owning vessel fleet.
    // Scan the exact v47 entity directory once and derive every affected
    // demand/owner record before accepting any renderer-provided leaf.
    for entity_index in 0..state.entities.kinds.len() {
        let current = state.parse_entity(entity_index)?;
        let object = current
            .as_object()
            .ok_or_else(|| anyhow!("native player-authority station route entity is invalid"))?;
        let Some(routes_value) = object.get("stationRoutes") else {
            continue;
        };
        if routes_value.is_null() {
            continue;
        }
        let routes = routes_value
            .as_array()
            .ok_or_else(|| anyhow!("native player-authority station routes are invalid"))?;
        if routes.is_empty() {
            continue;
        }
        if routes.len() > 65_536 {
            bail!("native player-authority station route list is too large")
        }
        let demand_id = object
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| state.entity_index.get(id).copied() == Some(entity_index))
            .ok_or_else(|| anyhow!("native player-authority station route owner ID is invalid"))?;
        let demand_building_id = object
            .get("buildingId")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                anyhow!("native player-authority station route owner building is invalid")
            })?;
        if object.get("kind").and_then(Value::as_str) != Some("station")
            || state
                .catalog
                .buildings
                .get(demand_building_id)
                .is_none_or(|building| building.kind != "station")
        {
            bail!("native player-authority station route owner is not a catalog station")
        }
        let demand_planet_id = object
            .get("planetId")
            .and_then(Value::as_str)
            .filter(|planet_id| {
                state
                    .catalog
                    .planets
                    .iter()
                    .any(|planet| planet.id == *planet_id)
            })
            .ok_or_else(|| anyhow!("native player-authority station route planet is invalid"))?;
        let mut remaining = Vec::with_capacity(routes.len());
        let mut canceled_any = false;
        for route in routes {
            let route_object = route
                .as_object()
                .ok_or_else(|| anyhow!("native player-authority station route is invalid"))?;
            let route_scope = route_object
                .get("scope")
                .and_then(Value::as_str)
                .filter(|scope| matches!(*scope, "local" | "remote"))
                .ok_or_else(|| anyhow!("native player-authority station route scope is invalid"))?;
            let route_slot_index =
                safe_json_integer(route_object.get("slotIndex"), "station route slot index")?;
            if route_slot_index >= PLAYER_STATION_SLOT_COUNT as u64 {
                bail!("native player-authority station route slot is out of range")
            }
            let peer_id = route_object
                .get("peerId")
                .and_then(Value::as_str)
                .filter(|peer_id| !peer_id.is_empty())
                .ok_or_else(|| anyhow!("native player-authority station route peer is invalid"))?;
            let route_item_id = route_object
                .get("itemId")
                .and_then(Value::as_str)
                .filter(|route_item_id| state.catalog.items.contains_key(*route_item_id))
                .ok_or_else(|| anyhow!("native player-authority station route item is invalid"))?;
            safe_json_integer(route_object.get("cargo"), "station route cargo")?;
            let progress =
                finite_json_number(route_object.get("progress"), "station route progress")?;
            if !(0.0..=1.0).contains(&progress) {
                bail!("native player-authority station route progress is out of range")
            }
            let cancel = route_scope == scope
                && ((demand_id == target_id && route_slot_index as usize == slot_index)
                    || (peer_id == target_id && route_item_id == item_id));
            if !cancel {
                remaining.push(route.clone());
                continue;
            }
            canceled_any = true;
            let vehicle_count = safe_json_integer(
                route_object.get("vehicleCount"),
                "station route vehicle count",
            )?;
            let requires_warp = route_object
                .get("requiresWarp")
                .and_then(Value::as_bool)
                .ok_or_else(|| {
                    anyhow!("native player-authority station route warp state is invalid")
                })?;
            let warpers_per_vessel = match route_object.get("warpersPerVessel") {
                None | Some(Value::Null) => 0,
                value => safe_json_integer(value, "station route warpers per vessel")?,
            };
            let per_vessel = warpers_per_vessel.max(u64::from(requires_warp));
            let amount = vehicle_count
                .checked_mul(per_vessel)
                .filter(|amount| *amount <= MAX_JAVASCRIPT_SAFE_INTEGER)
                .ok_or_else(|| {
                    anyhow!("native player-authority station route warper refund overflows")
                })?;
            if amount > 0 {
                let owner_id = match route_object.get("vehicleStationId") {
                    None | Some(Value::Null) => demand_id.to_owned(),
                    Some(value) => value
                        .as_str()
                        .filter(|owner_id| !owner_id.is_empty())
                        .ok_or_else(|| {
                            anyhow!(
                                "native player-authority station route vehicle owner is invalid"
                            )
                        })?
                        .to_owned(),
                };
                let compatible_owner = if let Some(index) = state.entity_index.get(&owner_id) {
                    let owner = state.parse_entity(*index)?;
                    (owner.get("buildingId").and_then(Value::as_str)
                        == Some("interstellar_logistics_station"))
                    .then_some(owner_id)
                } else {
                    None
                };
                refunds.push(StationRouteWarperRefund {
                    owner_id: compatible_owner,
                    fallback_planet_id: demand_planet_id.to_owned(),
                    amount,
                });
            }
        }
        let remaining_progress = remaining.iter().try_fold(0.0_f64, |maximum, route| {
            let progress =
                finite_json_number(route.get("progress"), "remaining station route progress")?;
            Ok::<_, anyhow::Error>(maximum.max(progress))
        })?;
        let progress_is_current = object
            .get("stationProgress")
            .and_then(Value::as_f64)
            .is_some_and(|current| current.to_bits() == remaining_progress.to_bits());
        if !canceled_any && progress_is_current {
            continue;
        }
        let expected = expected_entity_mut(state, &mut expected_entities, demand_id)?;
        let expected_object = expected.as_object_mut().ok_or_else(|| {
            anyhow!("native player-authority expected station route entity is invalid")
        })?;
        expected_object.insert("stationRoutes".to_owned(), Value::Array(remaining));
        expected_object.insert(
            "stationProgress".to_owned(),
            Value::from(remaining_progress),
        );
    }

    let mut tray_refunds = BTreeMap::<String, u64>::new();
    for refund in refunds {
        let (overflow_planet_id, overflow) = if let Some(owner_id) = refund.owner_id {
            let owner = expected_entity_mut(state, &mut expected_entities, &owner_id)?;
            let owner_object = owner.as_object_mut().ok_or_else(|| {
                anyhow!("native player-authority station route vehicle owner is invalid")
            })?;
            if owner_object.get("kind").and_then(Value::as_str) != Some("station")
                || state
                    .catalog
                    .buildings
                    .get("interstellar_logistics_station")
                    .is_none_or(|building| building.kind != "station")
            {
                bail!("native player-authority station route vehicle owner is incompatible")
            }
            let machine_count = safe_json_integer(
                owner_object.get("machineCount"),
                "station route vehicle owner stack",
            )?;
            let capacity = machine_count
                .checked_mul(50)
                .filter(|capacity| *capacity <= MAX_JAVASCRIPT_SAFE_INTEGER)
                .ok_or_else(|| {
                    anyhow!("native player-authority station route warper capacity overflows")
                })?;
            let current = normalized_nonnegative_integer(
                owner_object.get("stationWarpers"),
                "station route owner warper inventory",
            )?;
            let stored = refund.amount.min(capacity.saturating_sub(current));
            owner_object.insert("stationWarpers".to_owned(), Value::from(current + stored));
            let overflow = refund.amount - stored;
            let planet_id = owner_object
                .get("planetId")
                .and_then(Value::as_str)
                .filter(|planet_id| {
                    state
                        .catalog
                        .planets
                        .iter()
                        .any(|planet| planet.id == *planet_id)
                })
                .ok_or_else(|| {
                    anyhow!("native player-authority station route vehicle owner planet is invalid")
                })?
                .to_owned();
            (planet_id, overflow)
        } else {
            (refund.fallback_planet_id, refund.amount)
        };
        if overflow > 0 {
            let total = tray_refunds.entry(overflow_planet_id).or_default();
            *total = total
                .checked_add(overflow)
                .filter(|amount| *amount <= MAX_JAVASCRIPT_SAFE_INTEGER)
                .ok_or_else(|| {
                    anyhow!("native player-authority station route tray refund overflows")
                })?;
        }
    }

    // Apply the visible mode and every legacy mirror exactly as
    // `ensureStationSlots()` does after route cancellation.
    let expected_target = expected_entity_mut(state, &mut expected_entities, &target_id)?;
    let expected_target_object = expected_target.as_object_mut().ok_or_else(|| {
        anyhow!("native player-authority expected station mode target is invalid")
    })?;
    let expected_slots = expected_target_object
        .get_mut("stationSlots")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| anyhow!("native player-authority expected station slots are invalid"))?;
    expected_slots[slot_index]
        .as_object_mut()
        .ok_or_else(|| anyhow!("native player-authority expected station slot is invalid"))?
        .insert(mode_field.clone(), Value::from(target_mode));
    let primary = expected_slots
        .iter()
        .find_map(|slot| {
            let object = slot.as_object()?;
            let item_id = object.get("itemId")?.as_str()?;
            Some((
                item_id.to_owned(),
                object.get("localMode")?.as_str()?.to_owned(),
                object.get("remoteMode")?.as_str()?.to_owned(),
                object.get("minimumLoad")?.clone(),
            ))
        })
        .ok_or_else(|| anyhow!("native player-authority station mode primary slot is missing"))?;
    if !state.catalog.items.contains_key(&primary.0)
        || !matches!(primary.1.as_str(), "supply" | "demand" | "storage")
        || !matches!(primary.2.as_str(), "supply" | "demand" | "storage")
    {
        bail!("native player-authority station mode primary slot is invalid")
    }
    let minimum_load = finite_json_number(Some(&primary.3), "station mode primary minimum load")?;
    if !matches!(minimum_load, 0.1 | 0.25 | 0.5 | 1.0) {
        bail!("native player-authority station mode primary minimum load is invalid")
    }
    expected_target_object.insert("storedItemId".to_owned(), Value::from(primary.0));
    let legacy_mode = if (building_id == "planetary_logistics_station" && primary.1 == "demand")
        || (building_id == "interstellar_logistics_station" && primary.2 == "demand")
    {
        "demand"
    } else {
        "supply"
    };
    expected_target_object.insert("stationMode".to_owned(), Value::from(legacy_mode));
    expected_target_object.insert("stationMinimumLoad".to_owned(), primary.3);
    expected_target_object.insert("stationProgress".to_owned(), Value::from(0));
    expected_target_object.remove("stationPeerId");
    if expected_target_object
        .get("stationRoutes")
        .is_none_or(Value::is_null)
    {
        expected_target_object.insert("stationRoutes".to_owned(), Value::Array(Vec::new()));
    }

    let active_planet_id = state
        .base_value()
        .get("activePlanetId")
        .and_then(Value::as_str)
        .filter(|planet_id| {
            state
                .catalog
                .planets
                .iter()
                .any(|planet| planet.id == *planet_id)
        })
        .ok_or_else(|| anyhow!("native player-authority active planet is missing"))?;
    let base = state.base_value();
    let mut expected_top_level = Vec::new();
    for (planet_id, refund) in tray_refunds {
        if refund == 0 {
            continue;
        }
        if !state.catalog.items.contains_key("space_warper") {
            bail!("native player-authority space warper is not in the catalog")
        }
        if planet_id == active_planet_id {
            let tray = base
                .get("tray")
                .and_then(Value::as_object)
                .ok_or_else(|| anyhow!("native player-authority active tray is invalid"))?;
            let current = normalized_nonnegative_inventory(
                tray.get("space_warper"),
                "station route active tray warper inventory",
            )?;
            let expected = current
                .checked_add(refund)
                .filter(|amount| *amount <= MAX_JAVASCRIPT_SAFE_INTEGER)
                .ok_or_else(|| {
                    anyhow!("native player-authority station route tray refund overflows")
                })?;
            expected_top_level.push(ValuePatch {
                path: vec![
                    PathSegment::Key("tray".to_owned()),
                    PathSegment::Key("space_warper".to_owned()),
                ],
                operation: "set".to_owned(),
                value: Some(Value::from(expected)),
            });
        } else {
            let planet_trays = base
                .get("planetTrays")
                .and_then(Value::as_object)
                .ok_or_else(|| {
                    anyhow!("native player-authority planet tray directory is invalid")
                })?;
            if let Some(tray) = planet_trays.get(&planet_id) {
                let tray = tray.as_object().ok_or_else(|| {
                    anyhow!("native player-authority remote planet tray is invalid")
                })?;
                let current = normalized_nonnegative_inventory(
                    tray.get("space_warper"),
                    "station route remote tray warper inventory",
                )?;
                let expected = current
                    .checked_add(refund)
                    .filter(|amount| *amount <= MAX_JAVASCRIPT_SAFE_INTEGER)
                    .ok_or_else(|| {
                        anyhow!("native player-authority station route tray refund overflows")
                    })?;
                expected_top_level.push(ValuePatch {
                    path: vec![
                        PathSegment::Key("planetTrays".to_owned()),
                        PathSegment::Key(planet_id),
                        PathSegment::Key("space_warper".to_owned()),
                    ],
                    operation: "set".to_owned(),
                    value: Some(Value::from(expected)),
                });
            } else {
                expected_top_level.push(ValuePatch {
                    path: vec![
                        PathSegment::Key("planetTrays".to_owned()),
                        PathSegment::Key(planet_id),
                    ],
                    operation: "set".to_owned(),
                    value: Some(serde_json::json!({ "space_warper": refund })),
                });
            }
        }
    }
    exact_patch_sets_match(&command.top_level_changes, &expected_top_level)?;

    let mut expected_records = BTreeMap::<String, Vec<ValuePatch>>::new();
    for (entity_id, (current, expected)) in expected_entities {
        let mut changes = Vec::new();
        create_expected_value_patches(&current, &expected, Vec::new(), &mut changes);
        if !changes.is_empty() {
            expected_records.insert(entity_id, changes);
        }
    }
    if command.changed_entities.len() != expected_records.len() {
        bail!("native player-authority station mode entity set is incomplete or mixed")
    }
    let mut seen_entities = HashSet::new();
    for record in &command.changed_entities {
        if !seen_entities.insert(record.id.as_str()) {
            bail!("native player-authority station mode entity is repeated")
        }
        let expected = expected_records.get(&record.id).ok_or_else(|| {
            anyhow!("native player-authority station mode changed an unrelated entity")
        })?;
        exact_patch_sets_match(&record.changes, expected)?;
    }
    Ok(())
}

fn validate_station_slot_configuration_command(
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
        bail!("native player-authority station slot command shape is invalid")
    }

    let mut entity_ids = HashSet::new();
    for record in &command.changed_entities {
        if !entity_ids.insert(record.id.as_str()) || record.changes.is_empty() {
            bail!("native player-authority station slot target set is invalid")
        }
        let index = *state
            .entity_index
            .get(&record.id)
            .ok_or_else(|| anyhow!("native player-authority station entity is missing"))?;
        let entity = state.parse_entity(index)?;
        let object = entity
            .as_object()
            .ok_or_else(|| anyhow!("native player-authority station entity is invalid"))?;
        let building_id = object
            .get("buildingId")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow!("native player-authority station building ID is missing"))?;
        if object.get("kind").and_then(Value::as_str) != Some("station")
            || building_id == "orbital_collector"
            || state
                .catalog
                .buildings
                .get(building_id)
                .is_none_or(|building| building.kind != "station")
        {
            bail!("native player-authority station slot target is not a configurable station")
        }
        if let Some(locked) = object.get("interactionLocked")
            && locked.as_bool() != Some(false)
        {
            bail!("native player-authority station slot target is locked or malformed")
        }
        let slots = object
            .get("stationSlots")
            .and_then(Value::as_array)
            .filter(|slots| slots.len() == PLAYER_STATION_SLOT_COUNT)
            .ok_or_else(|| anyhow!("native player-authority station slots are invalid"))?;
        let primary_slot_index = slots.iter().position(|slot| {
            slot.get("itemId")
                .and_then(Value::as_str)
                .is_some_and(|item_id| !item_id.is_empty())
        });

        let mut seen_slot_fields = HashSet::new();
        let mut final_limits = BTreeMap::<usize, (u64, u64)>::new();
        let mut expected_legacy_minimum_load = None;
        let mut legacy_minimum_load_patch = None;
        let mut slot_change_count = 0usize;
        for change in &record.changes {
            if matches!(
                change.path.as_slice(),
                [PathSegment::Key(field)] if field == "stationMinimumLoad"
            ) {
                if legacy_minimum_load_patch.is_some() || change.operation != "set" {
                    bail!("native player-authority station legacy minimum load patch is malformed")
                }
                legacy_minimum_load_patch = Some(change.value.as_ref().ok_or_else(|| {
                    anyhow!("native player-authority station legacy minimum load has no value")
                })?);
                continue;
            }
            let [
                PathSegment::Key(root),
                PathSegment::Index(slot_index),
                PathSegment::Key(field),
            ] = change.path.as_slice()
            else {
                bail!("native player-authority station slot path is invalid")
            };
            if root != "stationSlots"
                || *slot_index >= PLAYER_STATION_SLOT_COUNT
                || !seen_slot_fields.insert((*slot_index, field.as_str()))
                || change.operation != "set"
            {
                bail!("native player-authority station slot patch is malformed")
            }
            let target = change
                .value
                .as_ref()
                .ok_or_else(|| anyhow!("native player-authority station slot set has no value"))?;
            let slot = slots[*slot_index]
                .as_object()
                .ok_or_else(|| anyhow!("native player-authority station slot is invalid"))?;
            let item_id = slot
                .get("itemId")
                .and_then(Value::as_str)
                .filter(|item_id| !item_id.is_empty())
                .ok_or_else(|| anyhow!("native player-authority station slot is not configured"))?;
            if !state.catalog.items.contains_key(item_id) {
                bail!("native player-authority station slot item is not in the catalog")
            }
            let current = slot.get(field).ok_or_else(|| {
                anyhow!("native player-authority current station slot field is missing")
            })?;
            if current == target {
                bail!("native player-authority station slot target is unchanged")
            }
            match field.as_str() {
                "minimumLoad" => {
                    let target_number = finite_json_number(Some(target), "station minimum load")?;
                    if !matches!(target_number, 0.1 | 0.25 | 0.5 | 1.0) {
                        bail!("native player-authority station minimum load is invalid")
                    }
                    let current_number =
                        finite_json_number(Some(current), "current station minimum load")?;
                    if !matches!(current_number, 0.1 | 0.25 | 0.5 | 1.0) {
                        bail!("native player-authority current station minimum load is invalid")
                    }
                    if primary_slot_index == Some(*slot_index) {
                        expected_legacy_minimum_load = Some(target);
                    }
                }
                "minStock" | "maxStock" => {
                    let target_amount = safe_json_integer(Some(target), "station stock limit")?;
                    if target_amount > MAX_PLAYER_STATION_STOCK {
                        bail!("native player-authority station stock limit is too large")
                    }
                    let limits = final_limits.entry(*slot_index).or_insert_with(|| {
                        (
                            safe_json_integer(
                                slot.get("minStock"),
                                "current station minimum stock",
                            )
                            .unwrap_or(MAX_PLAYER_STATION_STOCK + 1),
                            safe_json_integer(
                                slot.get("maxStock"),
                                "current station maximum stock",
                            )
                            .unwrap_or(MAX_PLAYER_STATION_STOCK + 1),
                        )
                    });
                    if field == "minStock" {
                        limits.0 = target_amount;
                    } else {
                        limits.1 = target_amount;
                    }
                }
                "priority" => {
                    target
                        .as_u64()
                        .filter(|priority| *priority <= 2)
                        .ok_or_else(|| {
                            anyhow!("native player-authority station priority is invalid")
                        })?;
                    current
                        .as_u64()
                        .filter(|priority| *priority <= 2)
                        .ok_or_else(|| {
                            anyhow!("native player-authority current station priority is invalid")
                        })?;
                }
                "routePolicy" => {
                    if building_id != "interstellar_logistics_station" {
                        bail!(
                            "native player-authority station route policy requires an interstellar station"
                        )
                    }
                    target
                        .as_str()
                        .filter(|policy| {
                            matches!(*policy, "direct" | "relay-preferred" | "relay-required")
                        })
                        .ok_or_else(|| {
                            anyhow!("native player-authority station route policy is invalid")
                        })?;
                    current
                        .as_str()
                        .filter(|policy| {
                            matches!(*policy, "direct" | "relay-preferred" | "relay-required")
                        })
                        .ok_or_else(|| {
                            anyhow!(
                                "native player-authority current station route policy is invalid"
                            )
                        })?;
                }
                "warperBudget" => {
                    if building_id != "interstellar_logistics_station" {
                        bail!(
                            "native player-authority station warper budget requires an interstellar station"
                        )
                    }
                    target
                        .as_u64()
                        .filter(|budget| (1..=4).contains(budget))
                        .ok_or_else(|| {
                            anyhow!("native player-authority station warper budget is invalid")
                        })?;
                    current
                        .as_u64()
                        .filter(|budget| (1..=4).contains(budget))
                        .ok_or_else(|| {
                            anyhow!(
                                "native player-authority current station warper budget is invalid"
                            )
                        })?;
                }
                _ => bail!("native player-authority station slot field is not typed"),
            }
            slot_change_count += 1;
        }
        if slot_change_count == 0 {
            bail!("native player-authority station slot command has no slot change")
        }
        for (minimum, maximum) in final_limits.values() {
            if *minimum > MAX_PLAYER_STATION_STOCK
                || *maximum > MAX_PLAYER_STATION_STOCK
                || (*maximum > 0 && minimum > maximum)
            {
                bail!("native player-authority station stock limit pair is invalid")
            }
        }

        let current_legacy_minimum_load = object.get("stationMinimumLoad");
        if let Some(current) = current_legacy_minimum_load {
            let current = finite_json_number(Some(current), "current legacy station minimum load")?;
            if !matches!(current, 0.1 | 0.25 | 0.5 | 1.0) {
                bail!("native player-authority current legacy station minimum load is invalid")
            }
        }
        let legacy_change_required = expected_legacy_minimum_load
            .is_some_and(|target| current_legacy_minimum_load != Some(target));
        match (
            expected_legacy_minimum_load,
            legacy_minimum_load_patch,
            legacy_change_required,
        ) {
            (Some(expected), Some(actual), true) if expected == actual => {}
            (Some(_), None, false) => {}
            (None, None, false) => {}
            _ => bail!("native player-authority station legacy minimum load is not canonical"),
        }
    }
    Ok(())
}

fn validate_interstellar_station_configuration_command(
    state: &CoreState,
    command: &SimulationCommandPatch,
) -> anyhow::Result<()> {
    if command.changed_entities.len() != 1
        || command.changed_entities[0].changes.is_empty()
        || !command.top_level_changes.is_empty()
        || !command.added_entities.is_empty()
        || !command.removed_entity_ids.is_empty()
        || !command.changed_belts.is_empty()
        || !command.added_belts.is_empty()
        || !command.removed_belt_ids.is_empty()
    {
        bail!("native player-authority interstellar station command shape is invalid")
    }
    let record = &command.changed_entities[0];
    let index = *state
        .entity_index
        .get(&record.id)
        .ok_or_else(|| anyhow!("native player-authority interstellar station is missing"))?;
    let entity = state.parse_entity(index)?;
    let object = entity
        .as_object()
        .ok_or_else(|| anyhow!("native player-authority interstellar station is invalid"))?;
    if object.get("kind").and_then(Value::as_str) != Some("station")
        || object.get("buildingId").and_then(Value::as_str)
            != Some("interstellar_logistics_station")
        || state
            .catalog
            .buildings
            .get("interstellar_logistics_station")
            .is_none_or(|building| building.kind != "station")
    {
        bail!("native player-authority interstellar station target is invalid")
    }
    if let Some(locked) = object.get("interactionLocked")
        && locked.as_bool() != Some(false)
    {
        bail!("native player-authority interstellar station is locked or malformed")
    }

    let fields = record
        .changes
        .iter()
        .map(|change| {
            let [PathSegment::Key(field)] = change.path.as_slice() else {
                bail!("native player-authority interstellar station path is invalid")
            };
            if change.operation != "set" || change.value.is_none() {
                bail!("native player-authority interstellar station patch is malformed")
            }
            Ok(field.as_str())
        })
        .collect::<anyhow::Result<Vec<_>>>()?;
    let mut unique_fields = HashSet::new();
    if fields.iter().any(|field| !unique_fields.insert(*field)) {
        bail!("native player-authority interstellar station field is repeated")
    }

    let hub_command = fields
        .iter()
        .all(|field| matches!(*field, "stationHubEnabled" | "stationHubPriority"));
    if hub_command {
        for change in &record.changes {
            let PathSegment::Key(field) = &change.path[0] else {
                unreachable!("single-key path was proved above")
            };
            let target = change.value.as_ref().expect("set value was proved above");
            match field.as_str() {
                "stationHubEnabled" => {
                    let target = target.as_bool().ok_or_else(|| {
                        anyhow!("native player-authority station hub enabled target is invalid")
                    })?;
                    let current = match object.get(field) {
                        Some(value) => value.as_bool().ok_or_else(|| {
                            anyhow!("native player-authority current station hub enabled state is invalid")
                        })?,
                        None => false,
                    };
                    if current == target {
                        bail!("native player-authority station hub enabled target is unchanged")
                    }
                }
                "stationHubPriority" => {
                    let target = target
                        .as_u64()
                        .filter(|priority| *priority <= 2)
                        .ok_or_else(|| {
                            anyhow!(
                                "native player-authority station hub priority target is invalid"
                            )
                        })?;
                    let current = match object.get(field) {
                        Some(value) => value
                            .as_u64()
                            .filter(|priority| *priority <= 2)
                            .ok_or_else(|| {
                                anyhow!("native player-authority current station hub priority is invalid")
                            })?,
                        None => 1,
                    };
                    if current == target {
                        bail!("native player-authority station hub priority target is unchanged")
                    }
                }
                _ => unreachable!("hub command fields were proved above"),
            }
        }
        return Ok(());
    }

    if record.changes.len() != 1 {
        bail!("native player-authority station warp command mixes intents")
    }
    let change = &record.changes[0];
    let PathSegment::Key(field) = &change.path[0] else {
        unreachable!("single-key path was proved above")
    };
    let target = change.value.as_ref().expect("set value was proved above");
    match field.as_str() {
        "stationWarpEnabled" | "stationWarperAutoRefill" => {
            let target = target.as_bool().ok_or_else(|| {
                anyhow!("native player-authority station warp toggle target is invalid")
            })?;
            if target && !technology_is_completed(state, "space_warp") {
                bail!("native player-authority station warp technology is locked")
            }
            let default = field == "stationWarpEnabled";
            let current = match object.get(field) {
                Some(value) => value.as_bool().ok_or_else(|| {
                    anyhow!("native player-authority current station warp toggle is invalid")
                })?,
                None => default,
            };
            if current == target {
                bail!("native player-authority station warp toggle is unchanged")
            }
        }
        "stationWarperTarget" => {
            let machine_count = safe_json_integer(object.get("machineCount"), "station stack")?;
            let capacity = machine_count
                .checked_mul(50)
                .filter(|capacity| *capacity <= MAX_JAVASCRIPT_SAFE_INTEGER)
                .ok_or_else(|| {
                    anyhow!("native player-authority station warper capacity overflows")
                })?;
            if capacity == 0 {
                bail!("native player-authority station warper capacity is empty")
            }
            let target = target
                .as_u64()
                .filter(|target| (1..=capacity).contains(target))
                .ok_or_else(|| {
                    anyhow!("native player-authority station warper target is invalid")
                })?;
            let current = match object.get(field) {
                Some(value) => safe_json_integer(Some(value), "current station warper target")?
                    .clamp(1, capacity),
                None => 50_u64.clamp(1, capacity),
            };
            if current == target {
                bail!("native player-authority station warper target is unchanged")
            }
        }
        _ => bail!("native player-authority interstellar station field is not typed"),
    }
    Ok(())
}

fn station_busy_vehicle_count(
    state: &CoreState,
    station_id: &str,
    scope: &str,
) -> anyhow::Result<u64> {
    let mut total = 0_u64;
    for entity_index in 0..state.entity_index.len() {
        let entity = state.parse_entity(entity_index)?;
        let demand = entity
            .as_object()
            .ok_or_else(|| anyhow!("native player-authority route owner is invalid"))?;
        let demand_id = demand
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow!("native player-authority route owner ID is missing"))?;
        let Some(routes) = demand.get("stationRoutes") else {
            continue;
        };
        if routes.is_null() {
            continue;
        }
        let routes = routes
            .as_array()
            .ok_or_else(|| anyhow!("native player-authority station route directory is invalid"))?;
        for route in routes {
            let route = route
                .as_object()
                .ok_or_else(|| anyhow!("native player-authority station route is invalid"))?;
            if route.get("scope").and_then(Value::as_str) != Some(scope) {
                continue;
            }
            let owner_id = match route.get("vehicleStationId") {
                None | Some(Value::Null) => demand_id,
                Some(Value::String(owner_id)) if !owner_id.is_empty() => owner_id,
                _ => bail!("native player-authority station route vehicle owner is invalid"),
            };
            if owner_id != station_id {
                continue;
            }
            let count = safe_json_integer(
                route.get("vehicleCount"),
                "station route busy vehicle count",
            )?;
            total = total
                .checked_add(count)
                .filter(|total| *total <= MAX_JAVASCRIPT_SAFE_INTEGER)
                .ok_or_else(|| {
                    anyhow!("native player-authority station busy vehicle count overflows")
                })?;
        }
    }
    Ok(total)
}

fn validate_station_fleet_target_command(
    state: &CoreState,
    command: &SimulationCommandPatch,
) -> anyhow::Result<()> {
    if command.changed_entities.is_empty()
        || !command.added_entities.is_empty()
        || !command.removed_entity_ids.is_empty()
        || !command.changed_belts.is_empty()
        || !command.added_belts.is_empty()
        || !command.removed_belt_ids.is_empty()
    {
        bail!("native player-authority station fleet command shape is invalid")
    }
    let mut target = None;
    for record in &command.changed_entities {
        for change in &record.changes {
            let [PathSegment::Key(field)] = change.path.as_slice() else {
                continue;
            };
            if !matches!(field.as_str(), "stationDrones" | "stationVessels") {
                continue;
            }
            if target.is_some() || change.operation != "set" {
                bail!("native player-authority station fleet target is repeated or malformed")
            }
            let value = change
                .value
                .as_ref()
                .and_then(Value::as_u64)
                .ok_or_else(|| {
                    anyhow!("native player-authority station fleet target is invalid")
                })?;
            target = Some((record.id.as_str(), field.as_str(), value));
        }
    }
    let (station_id, field, final_count) =
        target.ok_or_else(|| anyhow!("native player-authority station fleet target is missing"))?;
    let station_index = *state
        .entity_index
        .get(station_id)
        .ok_or_else(|| anyhow!("native player-authority station fleet entity is missing"))?;
    let station = state.parse_entity(station_index)?;
    let station = station
        .as_object()
        .ok_or_else(|| anyhow!("native player-authority station fleet entity is invalid"))?;
    let building_id = station
        .get("buildingId")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("native player-authority station fleet building is missing"))?;
    let compatible = match field {
        "stationDrones" => matches!(
            building_id,
            "planetary_logistics_station" | "interstellar_logistics_station"
        ),
        "stationVessels" => building_id == "interstellar_logistics_station",
        _ => false,
    };
    if !compatible
        || station.get("kind").and_then(Value::as_str) != Some("station")
        || state
            .catalog
            .buildings
            .get(building_id)
            .is_none_or(|building| building.kind != "station")
    {
        bail!("native player-authority station fleet target is incompatible")
    }
    if let Some(locked) = station.get("interactionLocked")
        && locked.as_bool() != Some(false)
    {
        bail!("native player-authority station fleet target is locked or malformed")
    }
    let current_count = finite_json_number(station.get(field), "current station fleet count")?
        .floor()
        .max(0.0);
    if current_count > MAX_JAVASCRIPT_SAFE_INTEGER as f64 {
        bail!("native player-authority current station fleet count is too large")
    }
    let current_count = current_count as u64;
    if final_count == current_count {
        bail!("native player-authority station fleet target is unchanged")
    }
    let machine_count = safe_json_integer(station.get("machineCount"), "station stack")?;
    let per_building = if field == "stationDrones" {
        PLAYER_STATION_DRONES_PER_BUILDING
    } else {
        PLAYER_STATION_VESSELS_PER_BUILDING
    };
    let capacity = machine_count
        .checked_mul(per_building)
        .filter(|capacity| *capacity <= MAX_JAVASCRIPT_SAFE_INTEGER)
        .ok_or_else(|| anyhow!("native player-authority station fleet capacity overflows"))?;
    let scope = if field == "stationDrones" {
        "local"
    } else {
        "remote"
    };
    let busy = station_busy_vehicle_count(state, station_id, scope)?;
    if final_count > capacity || final_count < busy {
        bail!("native player-authority station fleet target violates capacity or busy vehicles")
    }

    let item_id = if field == "stationDrones" {
        "logistics_drone"
    } else {
        "logistics_vessel"
    };
    if !state.catalog.items.contains_key(item_id) {
        bail!("native player-authority station fleet item is not in the catalog")
    }
    let base = state.base_value();
    let (inventory_root, expected_inventory) = if final_count > current_count {
        let portable = base
            .get("portableFleet")
            .and_then(Value::as_object)
            .ok_or_else(|| anyhow!("native player-authority portable fleet is missing"))?;
        let available = normalized_construction_inventory(portable.get(item_id))?;
        let loaded = final_count - current_count;
        let remaining = available.checked_sub(loaded).ok_or_else(|| {
            anyhow!("native player-authority portable fleet stock is insufficient")
        })?;
        ("portableFleet", remaining)
    } else {
        let tray = base
            .get("tray")
            .and_then(Value::as_object)
            .ok_or_else(|| anyhow!("native player-authority tray is missing"))?;
        let current = normalized_construction_inventory(tray.get(item_id))?;
        let returned = current_count - final_count;
        let next = current
            .checked_add(returned)
            .filter(|next| *next <= MAX_JAVASCRIPT_SAFE_INTEGER)
            .ok_or_else(|| anyhow!("native player-authority fleet refund overflows"))?;
        ("tray", next)
    };
    if command.top_level_changes.len() != 1
        || require_exact_set_patch(&command.top_level_changes, &[inventory_root, item_id])?.as_u64()
            != Some(expected_inventory)
    {
        bail!("native player-authority station fleet inventory accounting is invalid")
    }

    let mut expected_records = BTreeMap::<String, Vec<(Vec<&str>, Value)>>::new();
    let mut station_changes = vec![(vec![field], Value::from(final_count))];
    let station_progress_is_zero = station
        .get("stationProgress")
        .map(|value| finite_json_number(Some(value), "current station progress"))
        .transpose()?
        .is_some_and(|progress| progress == 0.0);
    if !station_progress_is_zero {
        station_changes.push((vec!["stationProgress"], Value::from(0)));
    }
    expected_records.insert(station_id.to_owned(), station_changes);
    let peer_id = match station.get("stationPeerId") {
        None | Some(Value::Null) => None,
        Some(Value::String(peer_id)) if !peer_id.is_empty() => Some(peer_id.as_str()),
        _ => bail!("native player-authority station fleet peer ID is invalid"),
    };
    if let Some(peer_id) = peer_id
        && peer_id != station_id
        && let Some(peer_index) = state.entity_index.get(peer_id)
    {
        let peer = state.parse_entity(*peer_index)?;
        let peer_progress_is_zero = peer
            .get("stationProgress")
            .map(|value| finite_json_number(Some(value), "current station peer progress"))
            .transpose()?
            .is_some_and(|progress| progress == 0.0);
        if !peer_progress_is_zero {
            expected_records.insert(
                peer_id.to_owned(),
                vec![(vec!["stationProgress"], Value::from(0))],
            );
        }
    }
    if command.changed_entities.len() != expected_records.len() {
        bail!("native player-authority station fleet entity effects are incomplete or mixed")
    }
    let mut seen_records = HashSet::new();
    for record in &command.changed_entities {
        if !seen_records.insert(record.id.as_str()) {
            bail!("native player-authority station fleet entity is repeated")
        }
        let expected = expected_records.get(&record.id).ok_or_else(|| {
            anyhow!("native player-authority station fleet command changes an unrelated entity")
        })?;
        require_exact_set_patch_values(&record.changes, expected)?;
    }
    Ok(())
}

fn validate_station_warper_inventory_command(
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
        bail!("native player-authority station warper inventory command shape is invalid")
    }
    let record = &command.changed_entities[0];
    let final_count = require_exact_set_patch(&record.changes, &["stationWarpers"])?
        .as_u64()
        .ok_or_else(|| anyhow!("native player-authority station warper count is invalid"))?;
    let station_index = *state
        .entity_index
        .get(&record.id)
        .ok_or_else(|| anyhow!("native player-authority station warper entity is missing"))?;
    let station = state.parse_entity(station_index)?;
    let station = station
        .as_object()
        .ok_or_else(|| anyhow!("native player-authority station warper entity is invalid"))?;
    if station.get("kind").and_then(Value::as_str) != Some("station")
        || station.get("buildingId").and_then(Value::as_str)
            != Some("interstellar_logistics_station")
        || state
            .catalog
            .buildings
            .get("interstellar_logistics_station")
            .is_none_or(|building| building.kind != "station")
    {
        bail!("native player-authority station warper target is incompatible")
    }
    if let Some(locked) = station.get("interactionLocked")
        && locked.as_bool() != Some(false)
    {
        bail!("native player-authority station warper target is locked or malformed")
    }
    if !technology_is_completed(state, "space_warp") {
        bail!("native player-authority station warper technology is locked")
    }
    if !state.catalog.items.contains_key("space_warper") {
        bail!("native player-authority space warper is not in the catalog")
    }
    let current = finite_json_number(
        station.get("stationWarpers"),
        "current station warper count",
    )?
    .floor()
    .max(0.0);
    if current > MAX_JAVASCRIPT_SAFE_INTEGER as f64 {
        bail!("native player-authority current station warper count is too large")
    }
    let current = current as u64;
    if current == final_count {
        bail!("native player-authority station warper count is unchanged")
    }
    let machine_count = safe_json_integer(station.get("machineCount"), "station stack")?;
    let capacity = machine_count
        .checked_mul(50)
        .filter(|capacity| *capacity <= MAX_JAVASCRIPT_SAFE_INTEGER)
        .ok_or_else(|| anyhow!("native player-authority station warper capacity overflows"))?;
    if final_count > capacity {
        bail!("native player-authority station warper count exceeds capacity")
    }
    let planet_id = station
        .get("planetId")
        .and_then(Value::as_str)
        .filter(|planet_id| {
            state
                .catalog
                .planets
                .iter()
                .any(|planet| planet.id == *planet_id)
        })
        .ok_or_else(|| anyhow!("native player-authority station warper planet is invalid"))?;
    let active_planet_id = state
        .base_value()
        .get("activePlanetId")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("native player-authority active planet is missing"))?;
    let (tray, tray_path) = if planet_id == active_planet_id {
        (
            state
                .base_value()
                .get("tray")
                .and_then(Value::as_object)
                .ok_or_else(|| anyhow!("native player-authority active tray is missing"))?,
            vec!["tray", "space_warper"],
        )
    } else {
        (
            state
                .base_value()
                .get("planetTrays")
                .and_then(Value::as_object)
                .and_then(|trays| trays.get(planet_id))
                .and_then(Value::as_object)
                .ok_or_else(|| anyhow!("native player-authority remote planet tray is missing"))?,
            vec!["planetTrays", planet_id, "space_warper"],
        )
    };
    let tray_count = normalized_construction_inventory(tray.get("space_warper"))?;
    let expected_tray = if final_count > current {
        tray_count
            .checked_sub(final_count - current)
            .ok_or_else(|| {
                anyhow!("native player-authority station warper stock is insufficient")
            })?
    } else {
        tray_count
            .checked_add(current - final_count)
            .filter(|count| *count <= MAX_JAVASCRIPT_SAFE_INTEGER)
            .ok_or_else(|| anyhow!("native player-authority station warper refund overflows"))?
    };
    if require_exact_set_patch(&command.top_level_changes, &tray_path)?.as_u64()
        != Some(expected_tray)
    {
        bail!("native player-authority station warper inventory accounting is invalid")
    }
    Ok(())
}

fn string_array_contains(value: Option<&Value>, needle: &str) -> anyhow::Result<bool> {
    let values = value
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("native player-authority exploration directory is invalid"))?;
    for value in values {
        let value = value
            .as_str()
            .ok_or_else(|| anyhow!("native player-authority exploration ID is invalid"))?;
        if value == needle {
            return Ok(true);
        }
    }
    Ok(false)
}

fn validate_active_planet_command(
    state: &CoreState,
    command: &SimulationCommandPatch,
) -> anyhow::Result<()> {
    if command.top_level_changes.is_empty()
        || !command.changed_entities.is_empty()
        || !command.added_entities.is_empty()
        || !command.removed_entity_ids.is_empty()
        || !command.changed_belts.is_empty()
        || !command.added_belts.is_empty()
        || !command.removed_belt_ids.is_empty()
    {
        bail!("native player-authority active planet command shape is invalid")
    }
    let target_id = require_exact_set_patch(&command.top_level_changes, &["activePlanetId"])?
        .as_str()
        .filter(|planet_id| !planet_id.is_empty() && planet_id.len() <= MAX_PLAYER_ORBIT_ID_BYTES)
        .ok_or_else(|| anyhow!("native player-authority active planet target is invalid"))?;
    let base = state.base_value();
    let current_id = base
        .get("activePlanetId")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("native player-authority current active planet is invalid"))?;
    if target_id == current_id {
        bail!("native player-authority active planet target is unchanged")
    }
    let target_planet = state
        .catalog
        .planets
        .iter()
        .find(|planet| planet.id == target_id)
        .ok_or_else(|| anyhow!("native player-authority active planet is not in the catalog"))?;
    if !state
        .catalog
        .planets
        .iter()
        .any(|planet| planet.id == current_id)
    {
        bail!("native player-authority current active planet is not in the catalog")
    }
    let exploration = base
        .get("exploration")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("native player-authority exploration state is missing"))?;
    if !string_array_contains(
        exploration.get("unlockedSystemIds"),
        &target_planet.system_id,
    )? {
        bail!("native player-authority active planet system is locked")
    }
    let explicitly_colonized =
        string_array_contains(exploration.get("colonizedPlanetIds"), target_id)?;
    let helios_technology_colonized = target_planet.system_id == "helios"
        && target_id != "home"
        && technology_is_completed(state, "interstellar_logistics");
    let pioneer_planet = state
        .catalog
        .planets
        .iter()
        .filter(|planet| planet.system_id == target_planet.system_id)
        .min_by(|left, right| {
            (left.orbit_index, left.simulation_order, left.id.as_str()).cmp(&(
                right.orbit_index,
                right.simulation_order,
                right.id.as_str(),
            ))
        })
        .is_some_and(|planet| planet.id == target_id);
    if !explicitly_colonized && !helios_technology_colonized && !pioneer_planet {
        bail!("native player-authority active planet is not colonized")
    }

    let tray = base
        .get("tray")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("native player-authority active planet tray is invalid"))?;
    let planet_trays = base
        .get("planetTrays")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("native player-authority planet tray directory is invalid"))?;
    let target_tray = planet_trays
        .get(target_id)
        .map(|value| {
            value
                .as_object()
                .cloned()
                .ok_or_else(|| anyhow!("native player-authority target planet tray is invalid"))
        })
        .transpose()?
        .unwrap_or_default();
    let target_metrics = base
        .get("planetMetrics")
        .and_then(Value::as_object)
        .and_then(|metrics| metrics.get(target_id))
        .and_then(Value::as_object)
        .cloned()
        .ok_or_else(|| anyhow!("native player-authority target planet metrics are missing"))?;

    let mut current_subset = Map::new();
    for key in ["activePlanetId", "tray", "planetTrays", "metrics"] {
        current_subset.insert(
            key.to_owned(),
            base.get(key)
                .cloned()
                .ok_or_else(|| anyhow!("native player-authority planet switch field is missing"))?,
        );
    }
    let mut expected_subset = current_subset.clone();
    expected_subset.insert("activePlanetId".to_owned(), Value::from(target_id));
    expected_subset.insert("tray".to_owned(), Value::Object(target_tray));
    expected_subset.insert("metrics".to_owned(), Value::Object(target_metrics));
    expected_subset
        .get_mut("planetTrays")
        .and_then(Value::as_object_mut)
        .expect("planetTrays object was proved above")
        .insert(current_id.to_owned(), Value::Object(tray.clone()));

    let mut candidate = Value::Object(current_subset);
    for change in &command.top_level_changes {
        let Some(PathSegment::Key(root)) = change.path.first() else {
            bail!("native player-authority planet switch path is invalid")
        };
        if !matches!(
            root.as_str(),
            "activePlanetId" | "tray" | "planetTrays" | "metrics"
        ) {
            bail!("native player-authority planet switch changes an unrelated field")
        }
        apply_value_patch(&mut candidate, change)?;
    }
    if candidate != Value::Object(expected_subset) {
        bail!("native player-authority planet switch snapshot is not canonical")
    }
    Ok(())
}

struct ValidatedTimeWarpState<'a> {
    value: &'a Map<String, Value>,
    controller_entity_id: Option<&'a str>,
    enabled: bool,
    requested_multiplier: u64,
    simulation_speed: Value,
    paused: bool,
}

fn validated_time_warp_state(state: &CoreState) -> anyhow::Result<ValidatedTimeWarpState<'_>> {
    let base = state.base_value();
    let value = base
        .get("timeWarp")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("native player-authority time-warp state is missing"))?;
    let controller_entity_id = match value.get("controllerEntityId") {
        Some(Value::Null) => None,
        Some(Value::String(entity_id)) if !entity_id.is_empty() => Some(entity_id.as_str()),
        _ => bail!("native player-authority time-warp controller state is invalid"),
    };
    let enabled = value
        .get("enabled")
        .and_then(Value::as_bool)
        .ok_or_else(|| anyhow!("native player-authority time-warp enabled state is invalid"))?;
    let requested_multiplier = safe_json_integer(
        value.get("requestedMultiplier"),
        "time-warp requested multiplier",
    )?;
    if requested_multiplier < 5 {
        bail!("native player-authority time-warp requested multiplier is invalid")
    }
    let effective_multiplier = finite_json_number(
        value.get("effectiveMultiplier"),
        "time-warp effective multiplier",
    )?;
    if effective_multiplier <= 0.0 {
        bail!("native player-authority time-warp effective multiplier is invalid")
    }
    for field in [
        "pendingSimulationSeconds",
        "pendingWallSeconds",
        "requiredPowerKw",
        "allocatedPowerKw",
    ] {
        if finite_json_number(value.get(field), field)? < 0.0 {
            bail!("native player-authority time-warp non-negative field is invalid")
        }
    }
    let simulation_speed = base
        .get("settings")
        .and_then(Value::as_object)
        .and_then(|settings| settings.get("simulationSpeed"))
        .filter(|value| {
            value
                .as_f64()
                .is_some_and(|speed| speed.is_finite() && speed > 0.0)
        })
        .cloned()
        .ok_or_else(|| anyhow!("native player-authority simulation speed is invalid"))?;
    let paused = base
        .get("paused")
        .and_then(Value::as_bool)
        .ok_or_else(|| anyhow!("native player-authority paused state is invalid"))?;
    Ok(ValidatedTimeWarpState {
        value,
        controller_entity_id,
        enabled,
        requested_multiplier,
        simulation_speed,
        paused,
    })
}

fn require_unlocked_time_warp_controller(state: &CoreState, entity_id: &str) -> anyhow::Result<()> {
    let index = *state
        .entity_index
        .get(entity_id)
        .ok_or_else(|| anyhow!("native player-authority time-warp controller is missing"))?;
    let entity = state.parse_entity(index)?;
    let object = entity
        .as_object()
        .ok_or_else(|| anyhow!("native player-authority time-warp controller is invalid"))?;
    if object.get("buildingId").and_then(Value::as_str) != Some("time_warp_device")
        || !state.catalog.buildings.contains_key("time_warp_device")
    {
        bail!("native player-authority time-warp controller building is invalid")
    }
    if let Some(locked) = object.get("interactionLocked")
        && locked.as_bool() != Some(false)
    {
        bail!("native player-authority time-warp controller is locked or malformed")
    }
    Ok(())
}

fn push_expected_time_warp_change(
    expected: &mut Vec<(Vec<&'static str>, Value)>,
    current: &Map<String, Value>,
    field: &'static str,
    target: Value,
) {
    if current.get(field) != Some(&target) {
        expected.push((vec!["timeWarp", field], target));
    }
}

fn validate_time_warp_command(
    state: &CoreState,
    command: &SimulationCommandPatch,
) -> anyhow::Result<()> {
    if command.top_level_changes.is_empty()
        || !command.changed_entities.is_empty()
        || !command.added_entities.is_empty()
        || !command.removed_entity_ids.is_empty()
        || !command.changed_belts.is_empty()
        || !command.added_belts.is_empty()
        || !command.removed_belt_ids.is_empty()
    {
        bail!("native player-authority time-warp command shape is invalid")
    }
    let controller_target = optional_exact_set_patch(
        &command.top_level_changes,
        &["timeWarp", "controllerEntityId"],
    )?;
    let enabled_target =
        optional_exact_set_patch(&command.top_level_changes, &["timeWarp", "enabled"])?;
    let multiplier_target = optional_exact_set_patch(
        &command.top_level_changes,
        &["timeWarp", "requestedMultiplier"],
    )?;
    if controller_target.is_none() && enabled_target.is_none() && multiplier_target.is_none() {
        bail!("native player-authority time-warp command intent is ambiguous")
    }

    let current = validated_time_warp_state(state)?;
    let mut expected = Vec::<(Vec<&'static str>, Value)>::new();
    if let Some(target) = controller_target {
        let entity_id = target
            .as_str()
            .filter(|entity_id| !entity_id.is_empty())
            .ok_or_else(|| {
                anyhow!("native player-authority time-warp controller target is invalid")
            })?;
        if current.controller_entity_id == Some(entity_id) {
            bail!("native player-authority time-warp controller target is unchanged")
        }
        require_unlocked_time_warp_controller(state, entity_id)?;
        push_expected_time_warp_change(
            &mut expected,
            current.value,
            "controllerEntityId",
            Value::from(entity_id),
        );
        push_expected_time_warp_change(&mut expected, current.value, "enabled", Value::from(false));
        push_expected_time_warp_change(
            &mut expected,
            current.value,
            "effectiveMultiplier",
            current.simulation_speed.clone(),
        );
        push_expected_time_warp_change(
            &mut expected,
            current.value,
            "requiredPowerKw",
            Value::from(0),
        );
        push_expected_time_warp_change(
            &mut expected,
            current.value,
            "allocatedPowerKw",
            Value::from(0),
        );
    } else if let Some(target) = enabled_target {
        let target = target.as_bool().ok_or_else(|| {
            anyhow!("native player-authority time-warp enabled target is invalid")
        })?;
        if current.enabled == target {
            bail!("native player-authority time-warp enabled target is unchanged")
        }
        let controller_entity_id = current.controller_entity_id.ok_or_else(|| {
            anyhow!("native player-authority time-warp controller is not selected")
        })?;
        require_unlocked_time_warp_controller(state, controller_entity_id)?;
        if target && current.paused {
            expected.push((vec!["paused"], Value::from(false)));
        }
        push_expected_time_warp_change(
            &mut expected,
            current.value,
            "enabled",
            Value::from(target),
        );
        push_expected_time_warp_change(
            &mut expected,
            current.value,
            "effectiveMultiplier",
            current.simulation_speed.clone(),
        );
        push_expected_time_warp_change(
            &mut expected,
            current.value,
            "requiredPowerKw",
            Value::from(0),
        );
        push_expected_time_warp_change(
            &mut expected,
            current.value,
            "allocatedPowerKw",
            Value::from(0),
        );
    } else if let Some(target) = multiplier_target {
        let target = safe_json_integer(Some(target), "time-warp requested multiplier")?;
        if target < 5 || target == current.requested_multiplier {
            bail!("native player-authority time-warp requested multiplier target is invalid")
        }
        if let Some(controller_entity_id) = current.controller_entity_id {
            require_unlocked_time_warp_controller(state, controller_entity_id)?;
        }
        expected.push((vec!["timeWarp", "requestedMultiplier"], Value::from(target)));
    }
    require_exact_set_patch_values(&command.top_level_changes, &expected)
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
        if command.changed_entities.iter().any(|record| {
            record
                .changes
                .iter()
                .any(|change| path_matches(&change.path, &["interactionLocked"]))
        }) {
            return validate_interaction_lock_command(self, command);
        }
        if command.changed_entities.iter().any(|record| {
            record.changes.iter().any(|change| {
                matches!(
                    change.path.as_slice(),
                    [PathSegment::Key(field)] if matches!(
                        field.as_str(),
                        "powerGridId"
                            | "powerPriority"
                            | "generationPriority"
                            | "distributionMode"
                    )
                )
            })
        }) {
            return validate_entity_power_or_splitter_configuration_command(self, command);
        }
        if command.changed_entities.iter().any(|record| {
            record.changes.iter().any(|change| {
                matches!(
                    change.path.first(),
                    Some(PathSegment::Key(root))
                        if matches!(root.as_str(), "stationSlots" | "stationMinimumLoad")
                )
            })
        }) {
            if command_contains_station_slot_mode(command) {
                return validate_station_slot_mode_command(self, command);
            }
            return validate_station_slot_configuration_command(self, command);
        }
        if command.changed_entities.iter().any(|record| {
            record.changes.iter().any(|change| {
                matches!(
                    change.path.first(),
                    Some(PathSegment::Key(field))
                        if matches!(
                            field.as_str(),
                            "stationHubEnabled"
                                | "stationHubPriority"
                                | "stationWarpEnabled"
                                | "stationWarperAutoRefill"
                                | "stationWarperTarget"
                        )
                )
            })
        }) {
            return validate_interstellar_station_configuration_command(self, command);
        }
        if command.changed_entities.iter().any(|record| {
            record.changes.iter().any(|change| {
                matches!(
                    change.path.as_slice(),
                    [PathSegment::Key(field)]
                        if matches!(field.as_str(), "stationDrones" | "stationVessels")
                )
            })
        }) {
            return validate_station_fleet_target_command(self, command);
        }
        if command.changed_entities.iter().any(|record| {
            record
                .changes
                .iter()
                .any(|change| path_matches(&change.path, &["stationWarpers"]))
        }) {
            return validate_station_warper_inventory_command(self, command);
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
            matches!(change.path.first(), Some(PathSegment::Key(root)) if root == "timeWarp")
        }) {
            return validate_time_warp_command(self, command);
        }
        if command.top_level_changes.iter().any(|change| {
            matches!(change.path.first(), Some(PathSegment::Key(root)) if root == "activePlanetId")
        }) {
            return validate_active_planet_command(self, command);
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
        if !command_contains_station_slot_mode(command) {
            return self.apply_command(command);
        }

        // `createSimulationCommandPatch()` observes optional JavaScript
        // members before the renderer's durable JSON boundary. Assigning
        // `undefined` to the peer therefore arrives either as a `set` without
        // a value or, after its first WAL serialization, a `set` with null.
        // The station-mode validator above has proved the complete command and
        // that this is its only optional deletion. Normalize only that typed
        // player path, keeping generic simulation/replay patch semantics exact.
        let mut normalized = command.clone();
        for record in &mut normalized.changed_entities {
            for change in &mut record.changes {
                if matches!(
                    change.path.last(),
                    Some(PathSegment::Key(field)) if field == "stationPeerId"
                ) && change.operation == "set"
                    && change.value.as_ref().is_none_or(Value::is_null)
                {
                    change.operation = "delete".to_owned();
                    change.value = None;
                }
            }
        }
        self.apply_command(&normalized)
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
                { "id": "solar_sail", "kind": "solid" },
                { "id": "logistics_drone", "kind": "solid" },
                { "id": "logistics_vessel", "kind": "solid" },
                { "id": "space_warper", "kind": "solid" }
            ],
            "buildings": [
                {
                    "id": "arc_smelter", "kind": "machine", "speed": 1,
                    "inputCapacity": 100, "outputCapacity": 100
                },
                {
                    "id": "em_rail_ejector", "kind": "machine", "speed": 1,
                    "inputCapacity": 100, "outputCapacity": 100
                },
                {
                    "id": "wind_turbine", "kind": "power", "speed": 1,
                    "inputCapacity": 0, "outputCapacity": 0
                },
                {
                    "id": "splitter_4way", "kind": "splitter", "speed": 1,
                    "inputCapacity": 100, "outputCapacity": 100
                },
                {
                    "id": "ray_receiver", "kind": "machine", "speed": 1,
                    "inputCapacity": 100, "outputCapacity": 100
                },
                {
                    "id": "time_warp_device", "kind": "machine", "speed": 1,
                    "inputCapacity": 0, "outputCapacity": 0
                },
                {
                    "id": "planetary_logistics_station", "kind": "station", "speed": 1,
                    "inputCapacity": 100000000, "outputCapacity": 100000000
                },
                {
                    "id": "interstellar_logistics_station", "kind": "station", "speed": 1,
                    "inputCapacity": 100000000, "outputCapacity": 100000000
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
            "settings": { "simulationSpeed": 4 },
            "timeWarp": {
                "controllerEntityId": null,
                "enabled": false,
                "requestedMultiplier": 15,
                "effectiveMultiplier": 4,
                "pendingSimulationSeconds": 0,
                "pendingWallSeconds": 0,
                "requiredPowerKw": 0,
                "allocatedPowerKw": 0
            },
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
            "tray": { "logistics_drone": 0, "logistics_vessel": 0, "space_warper": 10 },
            "planetTrays": { "ashen": { "space_warper": 7 } },
            "portableFleet": { "logistics_drone": 20, "logistics_vessel": 5 },
            "constructionQueue": [],
            "blueprintVersions": [],
            "totalProduced": { "iron_ingot": 10 },
            "research": { "completedTechIds": [] },
            "exploration": {
                "unlockedSystemIds": ["helios", "sigma"],
                "colonizedPlanetIds": ["home", "ashen"],
                "missions": [],
                "surveyProgressBySystem": { "helios": 1, "sigma": 1 }
            },
            "metrics": { "generationKw": 1, "demandKw": 2, "powerFactor": 0.5 },
            "planetMetrics": {
                "home": { "generationKw": 1, "demandKw": 2, "powerFactor": 0.5 },
                "ashen": { "generationKw": 3, "demandKw": 4, "powerFactor": 0.75 },
                "giant": { "generationKw": 0, "demandKw": 0, "powerFactor": 1 }
            },
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

    fn player_entity_configuration_state() -> CoreState {
        let mut state = player_command_state();
        let mut addition = empty_player_command(state.revision);
        addition.added_entities = vec![
            AddedRecord {
                index: 3,
                value: serde_json::json!({
                    "id": "generator-a",
                    "kind": "power",
                    "planetId": "home",
                    "position": { "x": 7.0, "y": 2.0 },
                    "interactionLocked": false,
                    "buildingId": "wind_turbine",
                    "powerGridId": "grid-a",
                    "powerPriority": 2,
                    "generationPriority": 3,
                    "machineCount": 1,
                    "minerCount": 0,
                    "inputs": {},
                    "outputs": {},
                    "progress": 0,
                    "routingCursor": 0,
                    "utilization": 0,
                    "productionRate": 0,
                    "powerOutputKw": 0,
                    "powerInputKw": 0,
                    "modPayload": { "owner": "pack:test", "revision": 11 }
                }),
            },
            AddedRecord {
                index: 4,
                value: serde_json::json!({
                    "id": "splitter-a",
                    "kind": "splitter",
                    "planetId": "home",
                    "position": { "x": 9.0, "y": 2.0 },
                    "interactionLocked": false,
                    "buildingId": "splitter_4way",
                    "powerGridId": "grid-a",
                    "powerPriority": 2,
                    "machineCount": 1,
                    "minerCount": 0,
                    "inputs": {},
                    "outputs": {},
                    "progress": 0,
                    "routingCursor": 0,
                    "utilization": 0,
                    "productionRate": 0,
                    "distributionMode": "balanced",
                    "modPayload": { "owner": "pack:test", "revision": 12 }
                }),
            },
            AddedRecord {
                index: 5,
                value: serde_json::json!({
                    "id": "receiver-a",
                    "kind": "machine",
                    "planetId": "home",
                    "position": { "x": 11.0, "y": 2.0 },
                    "interactionLocked": false,
                    "buildingId": "ray_receiver",
                    "powerGridId": "grid-a",
                    "powerPriority": 2,
                    "machineCount": 1,
                    "minerCount": 0,
                    "inputs": {},
                    "outputs": {},
                    "progress": 0,
                    "routingCursor": 0,
                    "utilization": 0,
                    "productionRate": 0,
                    "powerOutputKw": 0
                }),
            },
            AddedRecord {
                index: 6,
                value: serde_json::json!({
                    "id": "legacy-defaults-a",
                    "kind": "machine",
                    "planetId": "home",
                    "position": { "x": 13.0, "y": 2.0 },
                    "buildingId": "arc_smelter",
                    "recipeId": "iron_ingot",
                    "machineCount": 1,
                    "minerCount": 0,
                    "inputs": {},
                    "outputs": {},
                    "progress": 0,
                    "routingCursor": 0,
                    "utilization": 0,
                    "productionRate": 0,
                    "modPayload": { "owner": "pack:test", "revision": 13 }
                }),
            },
            AddedRecord {
                index: 7,
                value: serde_json::json!({
                    "id": "splitter-defaults-a",
                    "kind": "splitter",
                    "planetId": "home",
                    "position": { "x": 15.0, "y": 2.0 },
                    "buildingId": "splitter_4way",
                    "machineCount": 1,
                    "minerCount": 0,
                    "inputs": {},
                    "outputs": {},
                    "progress": 0,
                    "routingCursor": 0,
                    "utilization": 0,
                    "productionRate": 0,
                    "modPayload": { "owner": "pack:test", "revision": 14 }
                }),
            },
        ];
        state.apply_command(&addition).unwrap();
        state
    }

    fn player_time_warp_state() -> CoreState {
        let mut state = player_command_state();
        let mut addition = empty_player_command(state.revision);
        addition.added_entities = [
            ("time-warp-a", false, 7.0, 21),
            ("time-warp-b", false, 8.0, 22),
            ("time-warp-locked", true, 9.0, 23),
        ]
        .into_iter()
        .enumerate()
        .map(
            |(offset, (id, interaction_locked, x, mod_revision))| AddedRecord {
                index: 3 + offset,
                value: serde_json::json!({
                    "id": id,
                    "kind": "machine",
                    "planetId": "home",
                    "position": { "x": x, "y": 2.0 },
                    "interactionLocked": interaction_locked,
                    "buildingId": "time_warp_device",
                    "powerGridId": "grid-a",
                    "powerPriority": 2,
                    "machineCount": 1,
                    "minerCount": 0,
                    "inputs": {},
                    "outputs": {},
                    "progress": 0,
                    "routingCursor": 0,
                    "utilization": 0,
                    "productionRate": 0,
                    "powerInputKw": 0,
                    "modPayload": { "owner": "pack:test", "revision": mod_revision }
                }),
            },
        )
        .collect();
        state.apply_command(&addition).unwrap();
        state
    }

    fn station_slots(primary_item_id: Option<&str>) -> Value {
        Value::Array(
            (0..PLAYER_STATION_SLOT_COUNT)
                .map(|slot_index| {
                    serde_json::json!({
                        "itemId": if slot_index == 0 { primary_item_id } else { None },
                        "localMode": if slot_index == 0 { "supply" } else { "storage" },
                        "remoteMode": if slot_index == 0 { "demand" } else { "storage" },
                        "minimumLoad": 0.5,
                        "minStock": 0,
                        "maxStock": 0,
                        "priority": 1,
                        "routePolicy": "relay-preferred",
                        "warperBudget": 2
                    })
                })
                .collect(),
        )
    }

    fn player_station_configuration_state() -> CoreState {
        let mut state = player_command_state();
        let mut addition = empty_player_command(state.revision);
        addition.added_entities = [
            (
                "station-ils",
                "interstellar_logistics_station",
                false,
                station_slots(Some("iron_ore")),
            ),
            (
                "station-pls",
                "planetary_logistics_station",
                false,
                station_slots(Some("iron_ingot")),
            ),
            (
                "station-locked",
                "interstellar_logistics_station",
                true,
                station_slots(Some("iron_ore")),
            ),
            (
                "station-empty",
                "interstellar_logistics_station",
                false,
                station_slots(None),
            ),
            (
                "station-remote",
                "interstellar_logistics_station",
                false,
                station_slots(Some("iron_ore")),
            ),
        ]
        .into_iter()
        .enumerate()
        .map(
            |(offset, (id, building_id, interaction_locked, station_slots))| AddedRecord {
                index: 3 + offset,
                value: serde_json::json!({
                    "id": id,
                    "kind": "station",
                    "planetId": if id == "station-remote" { "ashen" } else { "home" },
                    "position": { "x": 10.0 + offset as f64, "y": 3.0 },
                    "interactionLocked": interaction_locked,
                    "buildingId": building_id,
                    "powerGridId": "grid-a",
                    "powerPriority": 2,
                    "machineCount": 1,
                    "minerCount": 0,
                    "inputs": {},
                    "outputs": {},
                    "progress": 0,
                    "routingCursor": 0,
                    "utilization": 0,
                    "productionRate": 0,
                    "stationSlots": station_slots,
                    "storedItemId": "iron_ore",
                    "stationMode": "demand",
                    "stationMinimumLoad": 0.5,
                    "stationProgress": 0,
                    "stationDrones": 5,
                    "stationVessels": 2,
                    "stationWarpers": 0,
                    "stationPeerId": null,
                    "stationRoutes": [],
                    "stationWarpEnabled": true,
                    "stationWarperAutoRefill": false,
                    "stationWarperTarget": 50,
                    "stationHubEnabled": false,
                    "stationHubPriority": 1,
                    "modPayload": { "owner": "pack:test", "revision": 31 + offset }
                }),
            },
        )
        .collect();
        state.apply_command(&addition).unwrap();
        state
    }

    fn station_route(
        id: &str,
        peer_id: &str,
        item_id: &str,
        scope: &str,
        progress: f64,
        vehicle_station_id: &str,
        warp: (bool, u64),
    ) -> Value {
        serde_json::json!({
            "id": id,
            "slotIndex": 0,
            "peerId": peer_id,
            "itemId": item_id,
            "scope": scope,
            "cargo": 100,
            "vehicleCount": 1,
            "progress": progress,
            "duration": 10,
            "requiresWarp": warp.0,
            "warpersPerVessel": warp.1,
            "vehicleStationId": vehicle_station_id,
            "modPayload": { "owner": "pack:route", "revision": id }
        })
    }

    fn player_station_route_mode_state() -> CoreState {
        let mut state = player_station_configuration_state();
        let target_routes = serde_json::json!([
            station_route(
                "cancel-owned-target",
                "station-remote",
                "iron_ore",
                "remote",
                0.8,
                "station-ils",
                (true, 2),
            ),
            station_route(
                "keep-local-target",
                "station-pls",
                "iron_ore",
                "local",
                0.4,
                "station-ils",
                (false, 0),
            )
        ]);
        let peer_routes = serde_json::json!([
            station_route(
                "cancel-owned-peer",
                "station-ils",
                "iron_ore",
                "remote",
                0.9,
                "station-remote",
                (true, 1),
            ),
            station_route(
                "keep-other-item-peer",
                "station-pls",
                "iron_ingot",
                "remote",
                0.7,
                "station-remote",
                (false, 0),
            )
        ]);
        let mut setup = empty_player_command(state.revision);
        setup.changed_entities = vec![
            RecordPatch {
                id: "station-ils".to_owned(),
                changes: vec![
                    ValuePatch {
                        path: vec![PathSegment::Key("stationRoutes".to_owned())],
                        operation: "set".to_owned(),
                        value: Some(target_routes),
                    },
                    ValuePatch {
                        path: vec![PathSegment::Key("stationProgress".to_owned())],
                        operation: "set".to_owned(),
                        value: Some(Value::from(0.8)),
                    },
                    ValuePatch {
                        path: vec![PathSegment::Key("stationWarpers".to_owned())],
                        operation: "set".to_owned(),
                        value: Some(Value::from(49)),
                    },
                    ValuePatch {
                        path: vec![PathSegment::Key("stationPeerId".to_owned())],
                        operation: "set".to_owned(),
                        value: Some(Value::from("station-remote")),
                    },
                ],
            },
            RecordPatch {
                id: "station-remote".to_owned(),
                changes: vec![
                    ValuePatch {
                        path: vec![PathSegment::Key("stationRoutes".to_owned())],
                        operation: "set".to_owned(),
                        value: Some(peer_routes),
                    },
                    ValuePatch {
                        path: vec![PathSegment::Key("stationProgress".to_owned())],
                        operation: "set".to_owned(),
                        value: Some(Value::from(0.9)),
                    },
                    ValuePatch {
                        path: vec![PathSegment::Key("stationWarpers".to_owned())],
                        operation: "set".to_owned(),
                        value: Some(Value::from(50)),
                    },
                    ValuePatch {
                        path: vec![PathSegment::Key("stationPeerId".to_owned())],
                        operation: "set".to_owned(),
                        value: Some(Value::from("station-ils")),
                    },
                ],
            },
        ];
        state.apply_command(&setup).unwrap();
        state
    }

    fn station_remote_mode_with_route_cancellation_command(
        state: &CoreState,
    ) -> SimulationCommandPatch {
        let mut command = empty_player_command(state.revision);
        command.top_level_changes = vec![
            ValuePatch {
                path: vec![
                    PathSegment::Key("tray".to_owned()),
                    PathSegment::Key("space_warper".to_owned()),
                ],
                operation: "set".to_owned(),
                value: Some(Value::from(11)),
            },
            ValuePatch {
                path: vec![
                    PathSegment::Key("planetTrays".to_owned()),
                    PathSegment::Key("ashen".to_owned()),
                    PathSegment::Key("space_warper".to_owned()),
                ],
                operation: "set".to_owned(),
                value: Some(Value::from(8)),
            },
        ];
        command.changed_entities = vec![
            RecordPatch {
                id: "station-ils".to_owned(),
                changes: vec![
                    station_slot_leaf(0, "remoteMode", Value::from("storage")),
                    ValuePatch {
                        path: vec![PathSegment::Key("stationMode".to_owned())],
                        operation: "set".to_owned(),
                        value: Some(Value::from("supply")),
                    },
                    ValuePatch {
                        path: vec![PathSegment::Key("stationProgress".to_owned())],
                        operation: "set".to_owned(),
                        value: Some(Value::from(0)),
                    },
                    // Durable JSON omits the `undefined` value emitted by the
                    // TypeScript command differ. The typed core persists its
                    // exact JSON meaning: remove the optional peer field.
                    ValuePatch {
                        path: vec![PathSegment::Key("stationPeerId".to_owned())],
                        operation: "set".to_owned(),
                        value: None,
                    },
                    ValuePatch {
                        path: vec![PathSegment::Key("stationRoutes".to_owned())],
                        operation: "set".to_owned(),
                        value: Some(serde_json::json!([station_route(
                            "keep-local-target",
                            "station-pls",
                            "iron_ore",
                            "local",
                            0.4,
                            "station-ils",
                            (false, 0),
                        )])),
                    },
                    ValuePatch {
                        path: vec![PathSegment::Key("stationWarpers".to_owned())],
                        operation: "set".to_owned(),
                        value: Some(Value::from(50)),
                    },
                ],
            },
            RecordPatch {
                id: "station-remote".to_owned(),
                changes: vec![
                    ValuePatch {
                        path: vec![PathSegment::Key("stationRoutes".to_owned())],
                        operation: "set".to_owned(),
                        value: Some(serde_json::json!([station_route(
                            "keep-other-item-peer",
                            "station-pls",
                            "iron_ingot",
                            "remote",
                            0.7,
                            "station-remote",
                            (false, 0),
                        )])),
                    },
                    ValuePatch {
                        path: vec![PathSegment::Key("stationProgress".to_owned())],
                        operation: "set".to_owned(),
                        value: Some(Value::from(0.7)),
                    },
                ],
            },
        ];
        command
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

    fn entity_leaf_command(
        revision: u64,
        entity_id: &str,
        field: &str,
        value: Value,
    ) -> SimulationCommandPatch {
        let mut command = empty_player_command(revision);
        command.changed_entities = vec![RecordPatch {
            id: entity_id.to_owned(),
            changes: vec![ValuePatch {
                path: vec![PathSegment::Key(field.to_owned())],
                operation: "set".to_owned(),
                value: Some(value),
            }],
        }];
        command
    }

    fn station_slot_leaf(slot_index: usize, field: &str, value: Value) -> ValuePatch {
        ValuePatch {
            path: vec![
                PathSegment::Key("stationSlots".to_owned()),
                PathSegment::Index(slot_index),
                PathSegment::Key(field.to_owned()),
            ],
            operation: "set".to_owned(),
            value: Some(value),
        }
    }

    fn station_fleet_command(
        revision: u64,
        entity_id: &str,
        field: &str,
        final_count: u64,
        inventory_root: &str,
        item_id: &str,
        inventory_count: u64,
    ) -> SimulationCommandPatch {
        let mut command = empty_player_command(revision);
        command.top_level_changes = vec![ValuePatch {
            path: vec![
                PathSegment::Key(inventory_root.to_owned()),
                PathSegment::Key(item_id.to_owned()),
            ],
            operation: "set".to_owned(),
            value: Some(Value::from(inventory_count)),
        }];
        command.changed_entities = vec![RecordPatch {
            id: entity_id.to_owned(),
            changes: vec![ValuePatch {
                path: vec![PathSegment::Key(field.to_owned())],
                operation: "set".to_owned(),
                value: Some(Value::from(final_count)),
            }],
        }];
        command
    }

    fn top_level_leaf_command(
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

    fn active_planet_to_ashen_command(revision: u64) -> SimulationCommandPatch {
        let mut command = empty_player_command(revision);
        command.top_level_changes = vec![
            ValuePatch {
                path: vec![PathSegment::Key("activePlanetId".to_owned())],
                operation: "set".to_owned(),
                value: Some(Value::from("ashen")),
            },
            ValuePatch {
                path: vec![
                    PathSegment::Key("planetTrays".to_owned()),
                    PathSegment::Key("home".to_owned()),
                ],
                operation: "set".to_owned(),
                value: Some(serde_json::json!({
                    "logistics_drone": 0,
                    "logistics_vessel": 0,
                    "space_warper": 10
                })),
            },
            ValuePatch {
                path: vec![
                    PathSegment::Key("tray".to_owned()),
                    PathSegment::Key("logistics_drone".to_owned()),
                ],
                operation: "delete".to_owned(),
                value: None,
            },
            ValuePatch {
                path: vec![
                    PathSegment::Key("tray".to_owned()),
                    PathSegment::Key("logistics_vessel".to_owned()),
                ],
                operation: "delete".to_owned(),
                value: None,
            },
            ValuePatch {
                path: vec![
                    PathSegment::Key("tray".to_owned()),
                    PathSegment::Key("space_warper".to_owned()),
                ],
                operation: "set".to_owned(),
                value: Some(Value::from(7)),
            },
            ValuePatch {
                path: vec![
                    PathSegment::Key("metrics".to_owned()),
                    PathSegment::Key("generationKw".to_owned()),
                ],
                operation: "set".to_owned(),
                value: Some(Value::from(3)),
            },
            ValuePatch {
                path: vec![
                    PathSegment::Key("metrics".to_owned()),
                    PathSegment::Key("demandKw".to_owned()),
                ],
                operation: "set".to_owned(),
                value: Some(Value::from(4)),
            },
            ValuePatch {
                path: vec![
                    PathSegment::Key("metrics".to_owned()),
                    PathSegment::Key("powerFactor".to_owned()),
                ],
                operation: "set".to_owned(),
                value: Some(Value::from(0.75)),
            },
        ];
        command
    }

    fn time_warp_changes_command(
        revision: u64,
        changes: &[(&str, Value)],
    ) -> SimulationCommandPatch {
        let mut command = empty_player_command(revision);
        command.top_level_changes = changes
            .iter()
            .map(|(field, value)| ValuePatch {
                path: vec![
                    PathSegment::Key("timeWarp".to_owned()),
                    PathSegment::Key((*field).to_owned()),
                ],
                operation: "set".to_owned(),
                value: Some(value.clone()),
            })
            .collect();
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
    fn player_authority_applies_interaction_lock_power_and_splitter_configuration() {
        let mut state = player_entity_configuration_state();
        assert_eq!(state.revision, 10);

        let mut lock = entity_leaf_command(
            state.revision,
            "smelter-a",
            "interactionLocked",
            Value::from(true),
        );
        lock.changed_entities.push(RecordPatch {
            id: "ejector-a".to_owned(),
            changes: vec![ValuePatch {
                path: vec![PathSegment::Key("interactionLocked".to_owned())],
                operation: "set".to_owned(),
                value: Some(Value::from(true)),
            }],
        });
        let locked = state.apply_player_authority_command(&lock).unwrap();
        assert_eq!(locked.changed_entity_ids, ["ejector-a", "smelter-a"]);
        assert!(state.parse_entity(0).unwrap()["interactionLocked"] == Value::Bool(true));
        assert!(state.parse_entity(1).unwrap()["interactionLocked"] == Value::Bool(true));

        let unlock = entity_leaf_command(
            state.revision,
            "smelter-a",
            "interactionLocked",
            Value::from(false),
        );
        state.apply_player_authority_command(&unlock).unwrap();

        for (entity_id, field, value) in [
            ("smelter-a", "powerGridId", Value::from("grid-b")),
            ("smelter-a", "powerPriority", Value::from(1)),
            ("generator-a", "generationPriority", Value::from(2)),
            ("receiver-a", "generationPriority", Value::from(1)),
            ("splitter-a", "distributionMode", Value::from("priority")),
        ] {
            let command = entity_leaf_command(state.revision, entity_id, field, value.clone());
            let applied = state.apply_player_authority_command(&command).unwrap();
            assert_eq!(applied.changed_entity_ids, [entity_id]);
            let index = *state.entity_index.get(entity_id).unwrap();
            assert_eq!(state.parse_entity(index).unwrap()[field], value);
        }
        for (entity_id, field, value) in [
            ("legacy-defaults-a", "powerGridId", Value::from("grid-c")),
            ("legacy-defaults-a", "powerPriority", Value::from(3)),
            (
                "splitter-defaults-a",
                "distributionMode",
                Value::from("priority"),
            ),
            ("legacy-defaults-a", "interactionLocked", Value::from(false)),
        ] {
            let command = entity_leaf_command(state.revision, entity_id, field, value.clone());
            state.apply_player_authority_command(&command).unwrap();
            let index = *state.entity_index.get(entity_id).unwrap();
            assert_eq!(state.parse_entity(index).unwrap()[field], value);
        }
        let generator_index = *state.entity_index.get("generator-a").unwrap();
        assert_eq!(
            state.parse_entity(generator_index).unwrap()["modPayload"],
            serde_json::json!({ "owner": "pack:test", "revision": 11 })
        );
        let splitter_index = *state.entity_index.get("splitter-a").unwrap();
        assert_eq!(
            state.parse_entity(splitter_index).unwrap()["modPayload"],
            serde_json::json!({ "owner": "pack:test", "revision": 12 })
        );
        let legacy_index = *state.entity_index.get("legacy-defaults-a").unwrap();
        assert_eq!(
            state.parse_entity(legacy_index).unwrap()["modPayload"],
            serde_json::json!({ "owner": "pack:test", "revision": 13 })
        );
        let default_splitter_index = *state.entity_index.get("splitter-defaults-a").unwrap();
        assert_eq!(
            state.parse_entity(default_splitter_index).unwrap()["modPayload"],
            serde_json::json!({ "owner": "pack:test", "revision": 14 })
        );
        assert_eq!(state.revision, 21);
    }

    #[test]
    fn player_authority_entity_configuration_fails_closed_on_forged_or_mixed_changes() {
        let mut delete_lock =
            entity_leaf_command(10, "smelter-a", "interactionLocked", Value::from(true));
        delete_lock.changed_entities[0].changes[0].operation = "delete".to_owned();
        delete_lock.changed_entities[0].changes[0].value = None;

        let mut mixed_lock_targets =
            entity_leaf_command(10, "smelter-a", "interactionLocked", Value::from(true));
        mixed_lock_targets.changed_entities.push(RecordPatch {
            id: "ejector-a".to_owned(),
            changes: vec![ValuePatch {
                path: vec![PathSegment::Key("interactionLocked".to_owned())],
                operation: "set".to_owned(),
                value: Some(Value::from(false)),
            }],
        });

        let mut mixed_configuration =
            entity_leaf_command(10, "smelter-a", "powerGridId", Value::from("grid-b"));
        mixed_configuration.changed_entities[0]
            .changes
            .push(ValuePatch {
                path: vec![PathSegment::Key("powerPriority".to_owned())],
                operation: "set".to_owned(),
                value: Some(Value::from(1)),
            });

        let commands = [
            entity_leaf_command(10, "missing", "interactionLocked", Value::from(true)),
            entity_leaf_command(10, "smelter-a", "interactionLocked", Value::from(false)),
            entity_leaf_command(10, "smelter-a", "powerGridId", Value::from("grid-d")),
            entity_leaf_command(10, "smelter-a", "powerPriority", Value::from(4)),
            entity_leaf_command(10, "smelter-a", "generationPriority", Value::from(2)),
            entity_leaf_command(10, "smelter-a", "distributionMode", Value::from("priority")),
            entity_leaf_command(10, "splitter-a", "distributionMode", Value::from("random")),
            entity_leaf_command(10, "splitter-a", "powerGridId", Value::from("grid-a")),
            delete_lock,
            mixed_lock_targets,
            mixed_configuration,
        ];
        for command in commands {
            let mut state = player_entity_configuration_state();
            let before = state.canonical_sha256().unwrap();
            assert!(state.apply_player_authority_command(&command).is_err());
            assert_eq!(state.revision, 10);
            assert_eq!(state.canonical_sha256().unwrap(), before);
        }

        let mut locked = player_entity_configuration_state();
        locked
            .apply_player_authority_command(&entity_leaf_command(
                locked.revision,
                "smelter-a",
                "interactionLocked",
                Value::from(true),
            ))
            .unwrap();
        let before = locked.canonical_sha256().unwrap();
        let error = locked
            .apply_player_authority_command(&entity_leaf_command(
                locked.revision,
                "smelter-a",
                "powerPriority",
                Value::from(1),
            ))
            .unwrap_err();
        assert!(format!("{error:#}").contains("locked or malformed"));
        assert_eq!(locked.canonical_sha256().unwrap(), before);

        let mut malformed = player_entity_configuration_state();
        malformed
            .apply_command(&entity_leaf_command(
                malformed.revision,
                "legacy-defaults-a",
                "powerGridId",
                Value::from(7),
            ))
            .unwrap();
        let before = malformed.canonical_sha256().unwrap();
        let error = malformed
            .apply_player_authority_command(&entity_leaf_command(
                malformed.revision,
                "legacy-defaults-a",
                "powerGridId",
                Value::from("grid-b"),
            ))
            .unwrap_err();
        assert!(format!("{error:#}").contains("current power grid is invalid"));
        assert_eq!(malformed.canonical_sha256().unwrap(), before);
    }

    #[test]
    fn player_authority_applies_bounded_station_slot_configuration_atomically() {
        let mut state = player_station_configuration_state();
        assert_eq!(state.revision, 10);
        let mut command = empty_player_command(state.revision);
        command.changed_entities = vec![RecordPatch {
            id: "station-ils".to_owned(),
            changes: vec![
                station_slot_leaf(0, "minimumLoad", Value::from(0.25)),
                ValuePatch {
                    path: vec![PathSegment::Key("stationMinimumLoad".to_owned())],
                    operation: "set".to_owned(),
                    value: Some(Value::from(0.25)),
                },
                station_slot_leaf(0, "minStock", Value::from(100)),
                station_slot_leaf(0, "maxStock", Value::from(200)),
                station_slot_leaf(0, "priority", Value::from(2)),
                station_slot_leaf(0, "routePolicy", Value::from("direct")),
                station_slot_leaf(0, "warperBudget", Value::from(4)),
            ],
        }];
        let applied = state.apply_player_authority_command(&command).unwrap();
        assert_eq!(applied.previous_revision, 10);
        assert_eq!(applied.revision, 11);
        assert_eq!(applied.changed_entity_ids, ["station-ils"]);
        assert!(applied.topology_dirty);
        let station_index = *state.entity_index.get("station-ils").unwrap();
        let station = state.parse_entity(station_index).unwrap();
        assert_eq!(station["stationSlots"][0]["minimumLoad"], 0.25);
        assert_eq!(station["stationMinimumLoad"], 0.25);
        assert_eq!(station["stationSlots"][0]["minStock"], 100);
        assert_eq!(station["stationSlots"][0]["maxStock"], 200);
        assert_eq!(station["stationSlots"][0]["priority"], 2);
        assert_eq!(station["stationSlots"][0]["routePolicy"], "direct");
        assert_eq!(station["stationSlots"][0]["warperBudget"], 4);
        assert_eq!(
            station["modPayload"],
            serde_json::json!({ "owner": "pack:test", "revision": 31 })
        );

        let committed_hash = state.canonical_sha256().unwrap();
        let retry_error = state.apply_player_authority_command(&command).unwrap_err();
        assert!(format!("{retry_error:#}").contains("base revision is not current"));
        assert_eq!(state.canonical_sha256().unwrap(), committed_hash);
    }

    #[test]
    fn player_authority_station_slot_configuration_fails_closed_without_mutation() {
        let command = |entity_id: &str, changes: Vec<ValuePatch>| {
            let mut command = empty_player_command(10);
            command.changed_entities = vec![RecordPatch {
                id: entity_id.to_owned(),
                changes,
            }];
            command
        };
        let legacy_minimum_load = |value: Value| ValuePatch {
            path: vec![PathSegment::Key("stationMinimumLoad".to_owned())],
            operation: "set".to_owned(),
            value: Some(value),
        };
        let mut delete_priority = command(
            "station-ils",
            vec![station_slot_leaf(0, "priority", Value::from(2))],
        );
        delete_priority.changed_entities[0].changes[0].operation = "delete".to_owned();
        delete_priority.changed_entities[0].changes[0].value = None;
        let mut mixed_top_level = command(
            "station-ils",
            vec![station_slot_leaf(0, "priority", Value::from(2))],
        );
        mixed_top_level.top_level_changes.push(ValuePatch {
            path: vec![PathSegment::Key("paused".to_owned())],
            operation: "set".to_owned(),
            value: Some(Value::from(true)),
        });
        let commands = [
            command(
                "missing",
                vec![station_slot_leaf(0, "priority", Value::from(2))],
            ),
            command(
                "station-locked",
                vec![station_slot_leaf(0, "priority", Value::from(2))],
            ),
            command(
                "station-empty",
                vec![station_slot_leaf(0, "priority", Value::from(2))],
            ),
            command(
                "station-ils",
                vec![
                    station_slot_leaf(0, "minimumLoad", Value::from(0.3)),
                    legacy_minimum_load(Value::from(0.3)),
                ],
            ),
            command(
                "station-ils",
                vec![station_slot_leaf(0, "minimumLoad", Value::from(0.25))],
            ),
            command(
                "station-ils",
                vec![
                    station_slot_leaf(0, "minimumLoad", Value::from(0.25)),
                    legacy_minimum_load(Value::from(1)),
                ],
            ),
            command(
                "station-ils",
                vec![
                    station_slot_leaf(0, "minStock", Value::from(300)),
                    station_slot_leaf(0, "maxStock", Value::from(200)),
                ],
            ),
            command(
                "station-pls",
                vec![station_slot_leaf(0, "routePolicy", Value::from("direct"))],
            ),
            command(
                "station-ils",
                vec![station_slot_leaf(0, "priority", Value::from(3))],
            ),
            command(
                "station-ils",
                vec![station_slot_leaf(0, "localMode", Value::from("demand"))],
            ),
            command(
                "station-ils",
                vec![station_slot_leaf(0, "minStock", Value::from(0))],
            ),
            delete_priority,
            mixed_top_level,
        ];
        for command in commands {
            let mut state = player_station_configuration_state();
            let before = state.canonical_sha256().unwrap();
            assert!(state.apply_player_authority_command(&command).is_err());
            assert_eq!(state.revision, 10);
            assert_eq!(state.canonical_sha256().unwrap(), before);
        }

        let mut malformed = player_station_configuration_state();
        let station_index = *malformed.entity_index.get("station-ils").unwrap();
        let mut station = malformed.parse_entity(station_index).unwrap();
        station["stationSlots"][0]["maxStock"] = Value::from("unbounded");
        let mut corrupt = empty_player_command(malformed.revision);
        corrupt.changed_entities = vec![RecordPatch {
            id: "station-ils".to_owned(),
            changes: vec![ValuePatch {
                path: vec![
                    PathSegment::Key("stationSlots".to_owned()),
                    PathSegment::Index(0),
                ],
                operation: "set".to_owned(),
                value: Some(station["stationSlots"][0].clone()),
            }],
        }];
        malformed.apply_command(&corrupt).unwrap();
        let before = malformed.canonical_sha256().unwrap();
        let mut malformed_probe = command(
            "station-ils",
            vec![station_slot_leaf(0, "minStock", Value::from(1))],
        );
        malformed_probe.base_revision = malformed.revision;
        let error = malformed
            .apply_player_authority_command(&malformed_probe)
            .unwrap_err();
        assert!(format!("{error:#}").contains("stock limit pair"));
        assert_eq!(malformed.canonical_sha256().unwrap(), before);
    }

    #[test]
    fn player_authority_switches_station_mode_with_exact_route_and_warper_refunds() {
        let mut state = player_station_route_mode_state();
        let previous_revision = state.revision;
        let command = station_remote_mode_with_route_cancellation_command(&state);
        let durable_command: SimulationCommandPatch =
            serde_json::from_str(&serde_json::to_string(&command).unwrap()).unwrap();
        assert_eq!(
            durable_command.changed_entities[0]
                .changes
                .iter()
                .find(|change| path_matches(&change.path, &["stationPeerId"]))
                .and_then(|change| change.value.as_ref()),
            Some(&Value::Null)
        );
        let applied = state
            .apply_player_authority_command(&durable_command)
            .unwrap();

        assert_eq!(applied.previous_revision, previous_revision);
        assert_eq!(applied.revision, previous_revision + 1);
        assert_eq!(
            applied.changed_entity_ids,
            ["station-ils", "station-remote"]
        );
        assert!(applied.topology_dirty);
        let target = state
            .parse_entity(*state.entity_index.get("station-ils").unwrap())
            .unwrap();
        assert_eq!(target["stationSlots"][0]["remoteMode"], "storage");
        assert_eq!(target["stationMode"], "supply");
        assert_eq!(target["stationProgress"], 0);
        assert!(target.get("stationPeerId").is_none());
        assert_eq!(target["stationWarpers"], 50);
        assert_eq!(target["stationRoutes"][0]["id"], "keep-local-target");
        assert_eq!(target["stationRoutes"].as_array().unwrap().len(), 1);
        assert_eq!(
            target["modPayload"],
            serde_json::json!({ "owner": "pack:test", "revision": 31 })
        );

        let peer = state
            .parse_entity(*state.entity_index.get("station-remote").unwrap())
            .unwrap();
        assert_eq!(peer["stationRoutes"].as_array().unwrap().len(), 1);
        assert_eq!(peer["stationRoutes"][0]["id"], "keep-other-item-peer");
        assert_eq!(peer["stationProgress"], 0.7);
        assert_eq!(peer["stationWarpers"], 50);
        assert_eq!(peer["stationPeerId"], "station-ils");
        assert_eq!(state.base_value()["tray"]["space_warper"], 11);
        assert_eq!(
            state.base_value()["planetTrays"]["ashen"]["space_warper"],
            8
        );

        let committed_hash = state.canonical_sha256().unwrap();
        let error = state
            .apply_player_authority_command(&durable_command)
            .unwrap_err();
        assert!(format!("{error:#}").contains("base revision is not current"));
        assert_eq!(state.canonical_sha256().unwrap(), committed_hash);
    }

    #[test]
    fn generic_command_preserves_explicit_null_station_peer() {
        let mut state = player_station_route_mode_state();
        let mut command = empty_player_command(state.revision);
        command.changed_entities = vec![RecordPatch {
            id: "station-ils".to_owned(),
            changes: vec![ValuePatch {
                path: vec![PathSegment::Key("stationPeerId".to_owned())],
                operation: "set".to_owned(),
                value: Some(Value::Null),
            }],
        }];

        state.apply_command(&command).unwrap();
        let station = state
            .parse_entity(*state.entity_index.get("station-ils").unwrap())
            .unwrap();
        assert_eq!(station.get("stationPeerId"), Some(&Value::Null));
    }

    #[test]
    fn player_authority_switches_local_station_mode_and_synchronizes_legacy_item() {
        let mut state = player_station_configuration_state();
        let mut command = empty_player_command(state.revision);
        command.changed_entities = vec![RecordPatch {
            id: "station-pls".to_owned(),
            changes: vec![
                station_slot_leaf(0, "localMode", Value::from("demand")),
                ValuePatch {
                    path: vec![PathSegment::Key("storedItemId".to_owned())],
                    operation: "set".to_owned(),
                    value: Some(Value::from("iron_ingot")),
                },
                ValuePatch {
                    path: vec![PathSegment::Key("stationPeerId".to_owned())],
                    operation: "set".to_owned(),
                    value: None,
                },
            ],
        }];

        state.apply_player_authority_command(&command).unwrap();
        let station = state
            .parse_entity(*state.entity_index.get("station-pls").unwrap())
            .unwrap();
        assert_eq!(station["stationSlots"][0]["localMode"], "demand");
        assert_eq!(station["storedItemId"], "iron_ingot");
        assert_eq!(station["stationMode"], "demand");
        assert!(station.get("stationPeerId").is_none());
        assert_eq!(
            station["modPayload"],
            serde_json::json!({ "owner": "pack:test", "revision": 32 })
        );
    }

    #[test]
    fn player_authority_station_mode_fails_closed_on_forged_or_incomplete_accounting() {
        let baseline = player_station_route_mode_state();
        let canonical = station_remote_mode_with_route_cancellation_command(&baseline);
        let mut forged_tray = canonical.clone();
        forged_tray.top_level_changes[0].value = Some(Value::from(12));
        let mut missing_remote_refund = canonical.clone();
        missing_remote_refund.top_level_changes.pop();
        let mut missing_route_cancellation = canonical.clone();
        missing_route_cancellation.changed_entities.pop();
        let mut forged_owner_inventory = canonical.clone();
        let owner_patch = forged_owner_inventory.changed_entities[0]
            .changes
            .iter_mut()
            .find(|change| path_matches(&change.path, &["stationWarpers"]))
            .unwrap();
        owner_patch.value = Some(Value::from(49));
        let mut forged_legacy_mode = canonical.clone();
        let legacy_patch = forged_legacy_mode.changed_entities[0]
            .changes
            .iter_mut()
            .find(|change| path_matches(&change.path, &["stationMode"]))
            .unwrap();
        legacy_patch.value = Some(Value::from("demand"));
        let mut kept_peer = canonical.clone();
        let peer_patch = kept_peer.changed_entities[0]
            .changes
            .iter_mut()
            .find(|change| path_matches(&change.path, &["stationPeerId"]))
            .unwrap();
        peer_patch.operation = "set".to_owned();
        peer_patch.value = Some(Value::from("station-remote"));
        let mut mixed_belt = canonical.clone();
        mixed_belt.removed_belt_ids.push("belt-priority".to_owned());
        let mut duplicate_intent = canonical.clone();
        duplicate_intent.changed_entities[0]
            .changes
            .push(station_slot_leaf(1, "localMode", Value::from("demand")));
        let mut unchanged_mode = canonical.clone();
        unchanged_mode.changed_entities[0].changes[0].value = Some(Value::from("demand"));
        let mut invalid_mode = canonical.clone();
        invalid_mode.changed_entities[0].changes[0].value = Some(Value::from("automatic"));
        let mut empty_slot = canonical.clone();
        empty_slot.changed_entities[0].changes[0].path = vec![
            PathSegment::Key("stationSlots".to_owned()),
            PathSegment::Index(1),
            PathSegment::Key("remoteMode".to_owned()),
        ];
        let mut planetary_remote = canonical.clone();
        planetary_remote.changed_entities[0].id = "station-pls".to_owned();

        for command in [
            forged_tray,
            missing_remote_refund,
            missing_route_cancellation,
            forged_owner_inventory,
            forged_legacy_mode,
            kept_peer,
            mixed_belt,
            duplicate_intent,
            unchanged_mode,
            invalid_mode,
            empty_slot,
            planetary_remote,
        ] {
            let mut state = baseline.clone();
            let before = state.canonical_sha256().unwrap();
            assert!(state.apply_player_authority_command(&command).is_err());
            assert_eq!(state.revision, baseline.revision);
            assert_eq!(state.canonical_sha256().unwrap(), before);
        }

        let mut locked = baseline.clone();
        let target_index = *locked.entity_index.get("station-ils").unwrap();
        let mut target = locked.parse_entity(target_index).unwrap();
        target["interactionLocked"] = Value::from(true);
        locked.replace_entity_raw(target_index, serde_json::to_string(&target).unwrap().into());
        locked.rebuild_indexes().unwrap();
        let before = locked.canonical_sha256().unwrap();
        let error = locked
            .apply_player_authority_command(&station_remote_mode_with_route_cancellation_command(
                &locked,
            ))
            .unwrap_err();
        assert!(format!("{error:#}").contains("locked or malformed"));
        assert_eq!(locked.canonical_sha256().unwrap(), before);

        let mut malformed_route = baseline.clone();
        let peer_index = *malformed_route.entity_index.get("station-remote").unwrap();
        let mut peer = malformed_route.parse_entity(peer_index).unwrap();
        peer["stationRoutes"][0]["cargo"] = Value::from(-1);
        malformed_route
            .replace_entity_raw(peer_index, serde_json::to_string(&peer).unwrap().into());
        malformed_route.rebuild_indexes().unwrap();
        let before = malformed_route.canonical_sha256().unwrap();
        let error = malformed_route
            .apply_player_authority_command(&station_remote_mode_with_route_cancellation_command(
                &malformed_route,
            ))
            .unwrap_err();
        assert!(format!("{error:#}").contains("route cargo"));
        assert_eq!(malformed_route.canonical_sha256().unwrap(), before);

        let mut malformed_owner = baseline.clone();
        let peer_index = *malformed_owner.entity_index.get("station-remote").unwrap();
        let mut peer = malformed_owner.parse_entity(peer_index).unwrap();
        peer["kind"] = Value::from("machine");
        malformed_owner
            .replace_entity_raw(peer_index, serde_json::to_string(&peer).unwrap().into());
        malformed_owner.rebuild_indexes().unwrap();
        let before = malformed_owner.canonical_sha256().unwrap();
        let error = malformed_owner
            .apply_player_authority_command(&station_remote_mode_with_route_cancellation_command(
                &malformed_owner,
            ))
            .unwrap_err();
        assert!(format!("{error:#}").contains("not a catalog station"));
        assert_eq!(malformed_owner.canonical_sha256().unwrap(), before);
    }

    #[test]
    fn player_authority_applies_interstellar_hub_and_warper_configuration() {
        let mut state = player_station_configuration_state();
        let mut hub = entity_leaf_command(
            state.revision,
            "station-ils",
            "stationHubEnabled",
            Value::from(true),
        );
        hub.changed_entities[0].changes.push(ValuePatch {
            path: vec![PathSegment::Key("stationHubPriority".to_owned())],
            operation: "set".to_owned(),
            value: Some(Value::from(2)),
        });
        state.apply_player_authority_command(&hub).unwrap();
        state
            .apply_player_authority_command(&entity_leaf_command(
                state.revision,
                "station-ils",
                "stationWarpEnabled",
                Value::from(false),
            ))
            .unwrap();
        state
            .apply_player_authority_command(&entity_leaf_command(
                state.revision,
                "station-ils",
                "stationWarperTarget",
                Value::from(25),
            ))
            .unwrap();

        let unlock_warp = top_level_leaf_command(
            state.revision,
            &["research", "completedTechIds"],
            serde_json::json!(["space_warp"]),
        );
        state.apply_command(&unlock_warp).unwrap();
        state
            .apply_player_authority_command(&entity_leaf_command(
                state.revision,
                "station-ils",
                "stationWarperAutoRefill",
                Value::from(true),
            ))
            .unwrap();

        let station_index = *state.entity_index.get("station-ils").unwrap();
        let station = state.parse_entity(station_index).unwrap();
        assert_eq!(station["stationHubEnabled"], true);
        assert_eq!(station["stationHubPriority"], 2);
        assert_eq!(station["stationWarpEnabled"], false);
        assert_eq!(station["stationWarperAutoRefill"], true);
        assert_eq!(station["stationWarperTarget"], 25);
        assert_eq!(
            station["modPayload"],
            serde_json::json!({ "owner": "pack:test", "revision": 31 })
        );
        assert_eq!(state.revision, 15);
    }

    #[test]
    fn player_authority_interstellar_configuration_fails_closed_without_mutation() {
        let mut delete_hub =
            entity_leaf_command(10, "station-ils", "stationHubEnabled", Value::from(true));
        delete_hub.changed_entities[0].changes[0].operation = "delete".to_owned();
        delete_hub.changed_entities[0].changes[0].value = None;
        let mut mixed_intents =
            entity_leaf_command(10, "station-ils", "stationHubEnabled", Value::from(true));
        mixed_intents.changed_entities[0].changes.push(ValuePatch {
            path: vec![PathSegment::Key("stationWarpEnabled".to_owned())],
            operation: "set".to_owned(),
            value: Some(Value::from(false)),
        });
        let mut mixed_top_level =
            entity_leaf_command(10, "station-ils", "stationWarpEnabled", Value::from(false));
        mixed_top_level.top_level_changes.push(ValuePatch {
            path: vec![PathSegment::Key("paused".to_owned())],
            operation: "set".to_owned(),
            value: Some(Value::from(true)),
        });
        let commands = [
            entity_leaf_command(10, "missing", "stationHubEnabled", Value::from(true)),
            entity_leaf_command(10, "station-pls", "stationHubEnabled", Value::from(true)),
            entity_leaf_command(
                10,
                "station-locked",
                "stationWarpEnabled",
                Value::from(false),
            ),
            entity_leaf_command(10, "station-ils", "stationHubEnabled", Value::from(false)),
            entity_leaf_command(10, "station-ils", "stationHubPriority", Value::from(3)),
            entity_leaf_command(10, "station-ils", "stationWarpEnabled", Value::from(true)),
            entity_leaf_command(
                10,
                "station-ils",
                "stationWarperAutoRefill",
                Value::from(true),
            ),
            entity_leaf_command(10, "station-ils", "stationWarperTarget", Value::from(0)),
            entity_leaf_command(10, "station-ils", "stationWarperTarget", Value::from(51)),
            entity_leaf_command(10, "station-ils", "stationWarperTarget", Value::from(50)),
            entity_leaf_command(10, "station-ils", "stationWarperTarget", Value::from(12.5)),
            delete_hub,
            mixed_intents,
            mixed_top_level,
        ];
        for command in commands {
            let mut state = player_station_configuration_state();
            let before = state.canonical_sha256().unwrap();
            assert!(state.apply_player_authority_command(&command).is_err());
            assert_eq!(state.revision, 10);
            assert_eq!(state.canonical_sha256().unwrap(), before);
        }

        let mut malformed = player_station_configuration_state();
        malformed
            .apply_command(&entity_leaf_command(
                malformed.revision,
                "station-ils",
                "stationHubPriority",
                Value::from("highest"),
            ))
            .unwrap();
        let before = malformed.canonical_sha256().unwrap();
        let error = malformed
            .apply_player_authority_command(&entity_leaf_command(
                malformed.revision,
                "station-ils",
                "stationHubPriority",
                Value::from(2),
            ))
            .unwrap_err();
        assert!(format!("{error:#}").contains("current station hub priority"));
        assert_eq!(malformed.canonical_sha256().unwrap(), before);
    }

    #[test]
    fn player_authority_moves_station_fleet_with_exact_material_accounting() {
        let mut state = player_station_configuration_state();
        state
            .apply_player_authority_command(&station_fleet_command(
                state.revision,
                "station-ils",
                "stationDrones",
                10,
                "portableFleet",
                "logistics_drone",
                15,
            ))
            .unwrap();
        assert_eq!(state.base_value()["portableFleet"]["logistics_drone"], 15);

        state
            .apply_command(&entity_leaf_command(
                state.revision,
                "station-ils",
                "stationProgress",
                Value::from(3),
            ))
            .unwrap();
        let mut unload = station_fleet_command(
            state.revision,
            "station-ils",
            "stationDrones",
            8,
            "tray",
            "logistics_drone",
            2,
        );
        unload.changed_entities[0].changes.push(ValuePatch {
            path: vec![PathSegment::Key("stationProgress".to_owned())],
            operation: "set".to_owned(),
            value: Some(Value::from(0)),
        });
        state.apply_player_authority_command(&unload).unwrap();
        assert_eq!(state.base_value()["tray"]["logistics_drone"], 2);

        state
            .apply_player_authority_command(&station_fleet_command(
                state.revision,
                "station-ils",
                "stationVessels",
                4,
                "portableFleet",
                "logistics_vessel",
                3,
            ))
            .unwrap();
        let station_index = *state.entity_index.get("station-ils").unwrap();
        let station = state.parse_entity(station_index).unwrap();
        assert_eq!(station["stationDrones"], 8);
        assert_eq!(station["stationVessels"], 4);
        assert_eq!(station["stationProgress"], 0);
        assert_eq!(state.base_value()["portableFleet"]["logistics_vessel"], 3);
        assert_eq!(
            station["modPayload"],
            serde_json::json!({ "owner": "pack:test", "revision": 31 })
        );
        assert_eq!(state.revision, 14);
    }

    #[test]
    fn player_authority_station_fleet_rejects_forged_or_unfunded_changes_atomically() {
        let mut mixed = station_fleet_command(
            10,
            "station-ils",
            "stationDrones",
            10,
            "portableFleet",
            "logistics_drone",
            15,
        );
        mixed.changed_entities.push(RecordPatch {
            id: "station-pls".to_owned(),
            changes: vec![ValuePatch {
                path: vec![PathSegment::Key("stationProgress".to_owned())],
                operation: "set".to_owned(),
                value: Some(Value::from(0)),
            }],
        });
        let commands = [
            station_fleet_command(
                10,
                "missing",
                "stationDrones",
                10,
                "portableFleet",
                "logistics_drone",
                15,
            ),
            station_fleet_command(
                10,
                "station-pls",
                "stationVessels",
                4,
                "portableFleet",
                "logistics_vessel",
                3,
            ),
            station_fleet_command(
                10,
                "station-locked",
                "stationDrones",
                10,
                "portableFleet",
                "logistics_drone",
                15,
            ),
            station_fleet_command(
                10,
                "station-ils",
                "stationDrones",
                51,
                "portableFleet",
                "logistics_drone",
                0,
            ),
            station_fleet_command(
                10,
                "station-ils",
                "stationDrones",
                30,
                "portableFleet",
                "logistics_drone",
                0,
            ),
            station_fleet_command(
                10,
                "station-ils",
                "stationDrones",
                10,
                "portableFleet",
                "logistics_drone",
                16,
            ),
            station_fleet_command(
                10,
                "station-ils",
                "stationDrones",
                4,
                "tray",
                "logistics_drone",
                0,
            ),
            station_fleet_command(
                10,
                "station-ils",
                "stationDrones",
                5,
                "portableFleet",
                "logistics_drone",
                20,
            ),
            station_fleet_command(
                10,
                "station-ils",
                "stationDrones",
                10,
                "tray",
                "logistics_drone",
                15,
            ),
            mixed,
        ];
        for command in commands {
            let mut state = player_station_configuration_state();
            let before = state.canonical_sha256().unwrap();
            assert!(state.apply_player_authority_command(&command).is_err());
            assert_eq!(state.revision, 10);
            assert_eq!(state.canonical_sha256().unwrap(), before);
        }

        let mut busy = player_station_configuration_state();
        let mut add_busy_route = empty_player_command(busy.revision);
        add_busy_route.changed_entities = vec![RecordPatch {
            id: "station-pls".to_owned(),
            changes: vec![ValuePatch {
                path: vec![PathSegment::Key("stationRoutes".to_owned())],
                operation: "set".to_owned(),
                value: Some(serde_json::json!([{
                    "id": "route-busy",
                    "slotIndex": 0,
                    "peerId": "station-ils",
                    "itemId": "iron_ore",
                    "scope": "local",
                    "cargo": 4,
                    "vehicleCount": 4,
                    "progress": 0,
                    "duration": 1,
                    "requiresWarp": false,
                    "vehicleStationId": "station-ils"
                }])),
            }],
        }];
        busy.apply_command(&add_busy_route).unwrap();
        let before = busy.canonical_sha256().unwrap();
        let mut below_busy = station_fleet_command(
            busy.revision,
            "station-ils",
            "stationDrones",
            3,
            "tray",
            "logistics_drone",
            2,
        );
        below_busy.top_level_changes[0].value = Some(Value::from(2));
        let error = busy
            .apply_player_authority_command(&below_busy)
            .unwrap_err();
        assert!(format!("{error:#}").contains("busy vehicles"));
        assert_eq!(busy.canonical_sha256().unwrap(), before);
    }

    #[test]
    fn player_authority_moves_station_warpers_against_the_owning_planet_tray() {
        let mut state = player_station_configuration_state();
        state
            .apply_command(&top_level_leaf_command(
                state.revision,
                &["research", "completedTechIds"],
                serde_json::json!(["space_warp"]),
            ))
            .unwrap();
        state
            .apply_player_authority_command(&station_fleet_command(
                state.revision,
                "station-ils",
                "stationWarpers",
                6,
                "tray",
                "space_warper",
                4,
            ))
            .unwrap();
        state
            .apply_player_authority_command(&station_fleet_command(
                state.revision,
                "station-ils",
                "stationWarpers",
                2,
                "tray",
                "space_warper",
                8,
            ))
            .unwrap();

        let mut remote = entity_leaf_command(
            state.revision,
            "station-remote",
            "stationWarpers",
            Value::from(3),
        );
        remote.top_level_changes = vec![ValuePatch {
            path: vec![
                PathSegment::Key("planetTrays".to_owned()),
                PathSegment::Key("ashen".to_owned()),
                PathSegment::Key("space_warper".to_owned()),
            ],
            operation: "set".to_owned(),
            value: Some(Value::from(4)),
        }];
        state.apply_player_authority_command(&remote).unwrap();

        let local_index = *state.entity_index.get("station-ils").unwrap();
        let remote_index = *state.entity_index.get("station-remote").unwrap();
        assert_eq!(
            state.parse_entity(local_index).unwrap()["stationWarpers"],
            2
        );
        assert_eq!(
            state.parse_entity(remote_index).unwrap()["stationWarpers"],
            3
        );
        assert_eq!(state.base_value()["tray"]["space_warper"], 8);
        assert_eq!(
            state.base_value()["planetTrays"]["ashen"]["space_warper"],
            4
        );
        assert_eq!(state.revision, 14);
    }

    #[test]
    fn player_authority_station_warper_inventory_fails_closed_without_material() {
        let no_technology = station_fleet_command(
            10,
            "station-ils",
            "stationWarpers",
            1,
            "tray",
            "space_warper",
            9,
        );
        let mut state = player_station_configuration_state();
        let before = state.canonical_sha256().unwrap();
        assert!(
            state
                .apply_player_authority_command(&no_technology)
                .is_err()
        );
        assert_eq!(state.canonical_sha256().unwrap(), before);

        let unlocked_state = || {
            let mut state = player_station_configuration_state();
            state
                .apply_command(&top_level_leaf_command(
                    state.revision,
                    &["research", "completedTechIds"],
                    serde_json::json!(["space_warp"]),
                ))
                .unwrap();
            state
        };
        let mut delete_count = station_fleet_command(
            11,
            "station-ils",
            "stationWarpers",
            1,
            "tray",
            "space_warper",
            9,
        );
        delete_count.changed_entities[0].changes[0].operation = "delete".to_owned();
        delete_count.changed_entities[0].changes[0].value = None;
        let mut mixed = station_fleet_command(
            11,
            "station-ils",
            "stationWarpers",
            1,
            "tray",
            "space_warper",
            9,
        );
        mixed.changed_entities[0].changes.push(ValuePatch {
            path: vec![PathSegment::Key("stationWarpEnabled".to_owned())],
            operation: "set".to_owned(),
            value: Some(Value::from(false)),
        });
        let commands = [
            station_fleet_command(
                11,
                "missing",
                "stationWarpers",
                1,
                "tray",
                "space_warper",
                9,
            ),
            station_fleet_command(
                11,
                "station-pls",
                "stationWarpers",
                1,
                "tray",
                "space_warper",
                9,
            ),
            station_fleet_command(
                11,
                "station-locked",
                "stationWarpers",
                1,
                "tray",
                "space_warper",
                9,
            ),
            station_fleet_command(
                11,
                "station-ils",
                "stationWarpers",
                51,
                "tray",
                "space_warper",
                0,
            ),
            station_fleet_command(
                11,
                "station-ils",
                "stationWarpers",
                20,
                "tray",
                "space_warper",
                0,
            ),
            station_fleet_command(
                11,
                "station-ils",
                "stationWarpers",
                1,
                "tray",
                "space_warper",
                8,
            ),
            station_fleet_command(
                11,
                "station-ils",
                "stationWarpers",
                0,
                "tray",
                "space_warper",
                10,
            ),
            delete_count,
            mixed,
        ];
        for command in commands {
            let mut state = unlocked_state();
            let before = state.canonical_sha256().unwrap();
            assert!(state.apply_player_authority_command(&command).is_err());
            assert_eq!(state.revision, 11);
            assert_eq!(state.canonical_sha256().unwrap(), before);
        }
    }

    #[test]
    fn player_authority_switches_planet_with_exact_tray_and_metrics_snapshot() {
        let mut state = player_command_state();
        let command = active_planet_to_ashen_command(state.revision);
        let applied = state.apply_player_authority_command(&command).unwrap();
        assert_eq!(applied.previous_revision, 9);
        assert_eq!(applied.revision, 10);
        assert!(applied.topology_dirty);
        assert_eq!(state.base_value()["activePlanetId"], "ashen");
        assert_eq!(
            state.base_value()["tray"],
            serde_json::json!({ "space_warper": 7 })
        );
        assert_eq!(
            state.base_value()["planetTrays"]["home"],
            serde_json::json!({
                "logistics_drone": 0,
                "logistics_vessel": 0,
                "space_warper": 10
            })
        );
        assert_eq!(state.base_value()["metrics"]["generationKw"], 3);
        assert_eq!(state.base_value()["metrics"]["demandKw"], 4);
        assert_eq!(state.base_value()["metrics"]["powerFactor"], 0.75);

        let committed_hash = state.canonical_sha256().unwrap();
        let retry_error = state.apply_player_authority_command(&command).unwrap_err();
        assert!(format!("{retry_error:#}").contains("base revision is not current"));
        assert_eq!(state.canonical_sha256().unwrap(), committed_hash);
    }

    #[test]
    fn player_authority_planet_switch_fails_closed_on_forged_or_locked_state() {
        let mut forged_tray = active_planet_to_ashen_command(9);
        let tray_patch = forged_tray
            .top_level_changes
            .iter_mut()
            .find(|change| path_matches(&change.path, &["tray", "space_warper"]))
            .unwrap();
        tray_patch.value = Some(Value::from(8));
        let mut extra = active_planet_to_ashen_command(9);
        extra.top_level_changes.push(ValuePatch {
            path: vec![PathSegment::Key("paused".to_owned())],
            operation: "set".to_owned(),
            value: Some(Value::from(true)),
        });
        let mut delete_target = active_planet_to_ashen_command(9);
        delete_target.top_level_changes[0].operation = "delete".to_owned();
        delete_target.top_level_changes[0].value = None;
        let commands = [
            top_level_leaf_command(9, &["activePlanetId"], Value::from("home")),
            top_level_leaf_command(9, &["activePlanetId"], Value::from("missing")),
            top_level_leaf_command(9, &["activePlanetId"], Value::from("giant")),
            forged_tray,
            extra,
            delete_target,
        ];
        for command in commands {
            let mut state = player_command_state();
            let before = state.canonical_sha256().unwrap();
            assert!(state.apply_player_authority_command(&command).is_err());
            assert_eq!(state.revision, 9);
            assert_eq!(state.canonical_sha256().unwrap(), before);
        }

        let mut locked_system = player_command_state();
        locked_system
            .apply_command(&top_level_leaf_command(
                locked_system.revision,
                &["exploration", "unlockedSystemIds"],
                serde_json::json!(["helios"]),
            ))
            .unwrap();
        let before = locked_system.canonical_sha256().unwrap();
        let mut switch = active_planet_to_ashen_command(9);
        switch.base_revision = locked_system.revision;
        let error = locked_system
            .apply_player_authority_command(&switch)
            .unwrap_err();
        assert!(format!("{error:#}").contains("system is locked"));
        assert_eq!(locked_system.canonical_sha256().unwrap(), before);

        let mut missing_metrics = player_command_state();
        let mut remove_metrics = top_level_leaf_command(
            missing_metrics.revision,
            &["planetMetrics", "ashen"],
            Value::Null,
        );
        remove_metrics.top_level_changes[0].operation = "delete".to_owned();
        remove_metrics.top_level_changes[0].value = None;
        missing_metrics.apply_command(&remove_metrics).unwrap();
        let before = missing_metrics.canonical_sha256().unwrap();
        let mut switch = active_planet_to_ashen_command(9);
        switch.base_revision = missing_metrics.revision;
        let error = missing_metrics
            .apply_player_authority_command(&switch)
            .unwrap_err();
        assert!(format!("{error:#}").contains("metrics are missing"));
        assert_eq!(missing_metrics.canonical_sha256().unwrap(), before);
    }

    #[test]
    fn player_authority_applies_only_canonical_time_warp_controller_multiplier_and_toggle() {
        let mut state = player_time_warp_state();
        assert_eq!(state.revision, 10);

        state
            .apply_player_authority_command(&time_warp_changes_command(
                state.revision,
                &[("controllerEntityId", Value::from("time-warp-a"))],
            ))
            .unwrap();
        state
            .apply_player_authority_command(&time_warp_changes_command(
                state.revision,
                &[("requestedMultiplier", Value::from(16))],
            ))
            .unwrap();
        state
            .apply_player_authority_command(&time_warp_changes_command(
                state.revision,
                &[("enabled", Value::from(true))],
            ))
            .unwrap();

        let mut live_snapshot = time_warp_changes_command(
            state.revision,
            &[
                ("effectiveMultiplier", Value::from(12)),
                ("requiredPowerKw", Value::from(100_000)),
                ("allocatedPowerKw", Value::from(80_000)),
                ("pendingSimulationSeconds", Value::from(7)),
                ("pendingWallSeconds", Value::from(0.5)),
            ],
        );
        state.apply_command(&live_snapshot).unwrap();

        state
            .apply_player_authority_command(&time_warp_changes_command(
                state.revision,
                &[
                    ("controllerEntityId", Value::from("time-warp-b")),
                    ("enabled", Value::from(false)),
                    ("effectiveMultiplier", Value::from(4)),
                    ("requiredPowerKw", Value::from(0)),
                    ("allocatedPowerKw", Value::from(0)),
                ],
            ))
            .unwrap();
        assert_eq!(
            state.base_value()["timeWarp"]["pendingSimulationSeconds"],
            7
        );
        assert_eq!(state.base_value()["timeWarp"]["pendingWallSeconds"], 0.5);

        live_snapshot = top_level_leaf_command(state.revision, &["paused"], Value::from(true));
        live_snapshot.top_level_changes.extend([
            ValuePatch {
                path: vec![
                    PathSegment::Key("timeWarp".to_owned()),
                    PathSegment::Key("pendingSimulationSeconds".to_owned()),
                ],
                operation: "set".to_owned(),
                value: Some(Value::from(0)),
            },
            ValuePatch {
                path: vec![
                    PathSegment::Key("timeWarp".to_owned()),
                    PathSegment::Key("pendingWallSeconds".to_owned()),
                ],
                operation: "set".to_owned(),
                value: Some(Value::from(0)),
            },
        ]);
        state.apply_command(&live_snapshot).unwrap();

        let mut enable =
            time_warp_changes_command(state.revision, &[("enabled", Value::from(true))]);
        enable.top_level_changes.insert(
            0,
            ValuePatch {
                path: vec![PathSegment::Key("paused".to_owned())],
                operation: "set".to_owned(),
                value: Some(Value::from(false)),
            },
        );
        state.apply_player_authority_command(&enable).unwrap();

        live_snapshot = time_warp_changes_command(
            state.revision,
            &[
                ("effectiveMultiplier", Value::from(15)),
                ("requiredPowerKw", Value::from(200_000)),
                ("allocatedPowerKw", Value::from(200_000)),
            ],
        );
        state.apply_command(&live_snapshot).unwrap();
        state
            .apply_player_authority_command(&time_warp_changes_command(
                state.revision,
                &[
                    ("enabled", Value::from(false)),
                    ("effectiveMultiplier", Value::from(4)),
                    ("requiredPowerKw", Value::from(0)),
                    ("allocatedPowerKw", Value::from(0)),
                ],
            ))
            .unwrap();

        let time_warp = &state.base_value()["timeWarp"];
        assert_eq!(time_warp["controllerEntityId"], "time-warp-b");
        assert_eq!(time_warp["enabled"], false);
        assert_eq!(time_warp["requestedMultiplier"], 16);
        assert_eq!(time_warp["effectiveMultiplier"], 4);
        assert_eq!(time_warp["requiredPowerKw"], 0);
        assert_eq!(time_warp["allocatedPowerKw"], 0);
        let controller_index = *state.entity_index.get("time-warp-b").unwrap();
        assert_eq!(
            state.parse_entity(controller_index).unwrap()["modPayload"],
            serde_json::json!({ "owner": "pack:test", "revision": 22 })
        );
        assert_eq!(state.revision, 19);
    }

    #[test]
    fn player_authority_time_warp_commands_fail_closed_without_mutation() {
        let mut delete_multiplier =
            time_warp_changes_command(10, &[("requestedMultiplier", Value::from(16))]);
        delete_multiplier.top_level_changes[0].operation = "delete".to_owned();
        delete_multiplier.top_level_changes[0].value = None;

        let mut mixed_intent = time_warp_changes_command(
            10,
            &[
                ("controllerEntityId", Value::from("time-warp-a")),
                ("requestedMultiplier", Value::from(16)),
            ],
        );
        mixed_intent.top_level_changes.reverse();

        let mut forged_pending =
            time_warp_changes_command(10, &[("requestedMultiplier", Value::from(16))]);
        forged_pending.top_level_changes.push(ValuePatch {
            path: vec![
                PathSegment::Key("timeWarp".to_owned()),
                PathSegment::Key("pendingSimulationSeconds".to_owned()),
            ],
            operation: "set".to_owned(),
            value: Some(Value::from(1_000_000)),
        });

        let commands = [
            time_warp_changes_command(10, &[("enabled", Value::from(true))]),
            time_warp_changes_command(10, &[("controllerEntityId", Value::from("smelter-a"))]),
            time_warp_changes_command(
                10,
                &[("controllerEntityId", Value::from("time-warp-locked"))],
            ),
            time_warp_changes_command(10, &[("controllerEntityId", Value::Null)]),
            time_warp_changes_command(10, &[("requestedMultiplier", Value::from(4))]),
            time_warp_changes_command(10, &[("requestedMultiplier", Value::from(15))]),
            time_warp_changes_command(10, &[("requestedMultiplier", Value::from(5.5))]),
            time_warp_changes_command(
                10,
                &[(
                    "requestedMultiplier",
                    Value::from(MAX_JAVASCRIPT_SAFE_INTEGER + 1),
                )],
            ),
            time_warp_changes_command(10, &[("effectiveMultiplier", Value::from(12))]),
            delete_multiplier,
            mixed_intent,
            forged_pending,
        ];
        for command in commands {
            let mut state = player_time_warp_state();
            let before = state.canonical_sha256().unwrap();
            assert!(state.apply_player_authority_command(&command).is_err());
            assert_eq!(state.revision, 10);
            assert_eq!(state.canonical_sha256().unwrap(), before);
        }

        let mut selected = player_time_warp_state();
        selected
            .apply_player_authority_command(&time_warp_changes_command(
                selected.revision,
                &[("controllerEntityId", Value::from("time-warp-a"))],
            ))
            .unwrap();
        selected
            .apply_command(&entity_leaf_command(
                selected.revision,
                "time-warp-a",
                "interactionLocked",
                Value::from(true),
            ))
            .unwrap();
        let before = selected.canonical_sha256().unwrap();
        assert!(
            selected
                .apply_player_authority_command(&time_warp_changes_command(
                    selected.revision,
                    &[("requestedMultiplier", Value::from(16))],
                ))
                .is_err()
        );
        assert_eq!(selected.canonical_sha256().unwrap(), before);

        let mut malformed = player_time_warp_state();
        malformed
            .apply_command(&time_warp_changes_command(
                malformed.revision,
                &[("requiredPowerKw", Value::from("forged"))],
            ))
            .unwrap();
        let before = malformed.canonical_sha256().unwrap();
        assert!(
            malformed
                .apply_player_authority_command(&time_warp_changes_command(
                    malformed.revision,
                    &[("requestedMultiplier", Value::from(16))],
                ))
                .is_err()
        );
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
