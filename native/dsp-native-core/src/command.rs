use anyhow::{anyhow, bail};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Map, Value};
use std::{
    collections::{BTreeMap, HashSet},
    sync::Arc,
};

use crate::state::CoreState;

const MAX_PLAYER_BUILDING_STACK: u64 = 100_000_000;
const PLAYER_STATION_SLOT_COUNT: usize = 5;
const MAX_PLAYER_STATION_STOCK: u64 = 100_000_000;
const PLAYER_STATION_DRONES_PER_BUILDING: u64 = 50;
const PLAYER_STATION_VESSELS_PER_BUILDING: u64 = 10;
const MAX_JAVASCRIPT_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const MAX_PLAYER_ORBIT_ID_BYTES: usize = 160;
const PLAYER_QUANTUM_CAPACITY_MIN: &str = "10000";
const PLAYER_QUANTUM_CAPACITY_MAX: &str = "10000000000";
const MAX_PLAYER_TECHNOLOGY_ROWS: usize = 512;
const PLAYER_ENERGY_EPSILON: f64 = 0.0001;
const BELT_ROUTE_MODES: &[&str] = &["bezier", "auto", "upper", "lower", "manual"];
/// FNV-1a fingerprint produced by `createContentPackRegistry()` with no packs.
/// The current CORE catalog omits the optional MOD `stackLimit`, so positive
/// stack changes are only provable when no content pack can have overridden a
/// core building's limit.  Non-empty registries remain fail-closed until that
/// bound is carried by a future, explicitly versioned catalog protocol.
pub(crate) const EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT: &str = "7df8cf3a";

const DEPRECATED_PLAYER_TECHNOLOGIES: &[&str] = &[
    "orbital_elevator_engineering",
    "orbital_multi_cargo_bus",
    "orbital_energy_recovery",
    "system_space_station_engineering",
    "orbital_modular_assembly",
    "autonomous_station_construction",
    "unified_system_logistics_protocol",
];

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

// Power-priority controls are intentionally narrower than the ordinary
// placement/stack catalogs. They cover only built-in recipe consumers whose
// exact runtime meaning is the shared 1..=3 consumer queue. Generators,
// stations, storage, special logistics/megastructure controllers and unknown
// content-pack entities stay fail-closed at this command boundary.
const BUILTIN_POWER_PRIORITY_BUILDINGS: &[&str] = &[
    "arc_smelter",
    "assembling_machine_mk1",
    "assembling_machine_mk2",
    "assembling_machine_mk3",
    "chemical_plant",
    "em_rail_ejector",
    "fractionator",
    "matrix_lab",
    "miniature_particle_collider",
    "oil_refinery",
    "plane_smelter",
    "quantum_chemical_plant",
    "spray_coater",
    "vertical_launching_silo",
];

const BUILTIN_THERMAL_FUEL_ITEMS: &[&str] = &[
    "coal",
    "fire_ice",
    "crude_oil",
    "energetic_graphite",
    "refined_oil",
    "hydrogen",
    "hydrogen_fuel_rod",
    "deuteron_fuel_rod",
    "antimatter_fuel_rod",
];
const BUILTIN_FUSION_FUEL_ITEMS: &[&str] = &["deuteron_fuel_rod"];
const BUILTIN_ARTIFICIAL_STAR_FUEL_ITEMS: &[&str] = &["antimatter_fuel_rod"];

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
        [PathSegment::Key(root), PathSegment::Key(field)]
            if root == "settings"
                && field == "technologyLayout"
                && change.operation == "set"
                && change.value.is_some()
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
                | "cargo"
                | "tray"
                | "planetTrayItemLimits"
                | "portableFleet"
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
                | "blackHolePaused"
                | "blackHoleActivationConfirmed"
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
        path,
        [PathSegment::Key(field)]
            if matches!(field.as_str(), "stationPeerId" | "storedItemId")
    ) || matches!(
        path,
        [
            PathSegment::Key(root),
            PathSegment::Index(_),
            PathSegment::Key(field),
        ] if root == "stationSlots" && field == "itemId"
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
            bail!(
                "native player-authority station patch value is not canonical at {:?}",
                actual_patch.path
            )
        }
        matched[expected_index] = true;
    }
    if matched.iter().any(|matched| !matched) {
        bail!("native player-authority station patch set is incomplete")
    }
    Ok(())
}

pub(crate) fn create_expected_value_patches(
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

fn station_progress_value(progress: f64) -> Value {
    if progress == 0.0 {
        Value::from(0)
    } else {
        Value::from(progress)
    }
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

pub(crate) fn normalized_construction_inventory(value: Option<&Value>) -> anyhow::Result<u64> {
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

pub(crate) fn technology_is_completed(state: &CoreState, technology_id: &str) -> bool {
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

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum OrdinaryPlacementUnsupportedReason {
    UnknownBuilding,
    MissingConstructionDefinition,
    TechnologyLocked,
    UnsupportedBuildingKind,
    UnsupportedBuildingDomain,
    UnsupportedActivePlanet,
}

impl OrdinaryPlacementUnsupportedReason {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::UnknownBuilding => "unknown-building",
            Self::MissingConstructionDefinition => "missing-construction-definition",
            Self::TechnologyLocked => "technology-locked",
            Self::UnsupportedBuildingKind => "unsupported-building-kind",
            Self::UnsupportedBuildingDomain => "unsupported-building-domain",
            Self::UnsupportedActivePlanet => "unsupported-active-planet",
        }
    }

    fn validation_message(self) -> &'static str {
        match self {
            Self::UnknownBuilding => {
                "native player-authority placed building is not in the catalog"
            }
            Self::MissingConstructionDefinition => {
                "native player-authority placed building has no construction definition"
            }
            Self::TechnologyLocked => {
                "native player-authority placed building technology is locked"
            }
            Self::UnsupportedBuildingKind | Self::UnsupportedBuildingDomain => {
                "native player-authority building placement domain is not covered"
            }
            Self::UnsupportedActivePlanet => {
                "native player-authority placed entity planet is invalid"
            }
        }
    }
}

pub(crate) fn recipe_building_base<'a>(building_id: &'a str, family: Option<&str>) -> &'a str {
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

pub(crate) fn ordinary_placement_support_reason(
    state: &CoreState,
    building_id: &str,
) -> anyhow::Result<Option<OrdinaryPlacementUnsupportedReason>> {
    let Some(building) = state.catalog.buildings.get(building_id) else {
        return Ok(Some(OrdinaryPlacementUnsupportedReason::UnknownBuilding));
    };
    let Some(construction) = state.catalog.constructions.get(building_id) else {
        return Ok(Some(
            OrdinaryPlacementUnsupportedReason::MissingConstructionDefinition,
        ));
    };
    if construction
        .required_tech_id
        .as_deref()
        .is_some_and(|technology_id| !technology_is_completed(state, technology_id))
    {
        return Ok(Some(OrdinaryPlacementUnsupportedReason::TechnologyLocked));
    }
    if matches!(building.kind.as_str(), "miner" | "station")
        || !matches!(
            building.kind.as_str(),
            "machine" | "power" | "storage" | "splitter"
        )
    {
        return Ok(Some(
            OrdinaryPlacementUnsupportedReason::UnsupportedBuildingKind,
        ));
    }
    if UNSUPPORTED_ORDINARY_PLACEMENT_BUILDINGS.contains(&building_id) {
        return Ok(Some(
            OrdinaryPlacementUnsupportedReason::UnsupportedBuildingDomain,
        ));
    }
    let active_planet_id = state
        .base_value()
        .get("activePlanetId")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("native player-authority active planet is missing"))?;
    let active_planet = state
        .catalog
        .planets
        .iter()
        .find(|planet| planet.id == active_planet_id)
        .ok_or_else(|| anyhow!("native player-authority active planet is missing"))?;
    if active_planet.kind != "terrestrial" {
        return Ok(Some(
            OrdinaryPlacementUnsupportedReason::UnsupportedActivePlanet,
        ));
    }
    Ok(None)
}

pub(crate) fn canonical_ordinary_placement_entity_template(
    state: &CoreState,
    building_id: &str,
    expected_id: &str,
    active_planet_id: &str,
) -> anyhow::Result<Map<String, Value>> {
    let building =
        state.catalog.buildings.get(building_id).ok_or_else(|| {
            anyhow!("native player-authority placed building is not in the catalog")
        })?;
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
        ("interactionLocked", Value::from(false)),
        ("buildingId", Value::from(building_id)),
        ("powerGridId", Value::from("grid-a")),
        ("powerPriority", Value::from(2)),
        ("machineCount", Value::from(1)),
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
    Ok(expected)
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
    if let Some(reason) = ordinary_placement_support_reason(state, building_id)? {
        bail!(reason.validation_message())
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
    if entity.get("planetId").and_then(Value::as_str) != Some(active_planet_id) {
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

    let mut expected = canonical_ordinary_placement_entity_template(
        state,
        building_id,
        &expected_id,
        active_planet_id,
    )?;
    expected.insert("position".to_owned(), serde_json::json!({ "x": x, "y": y }));
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct OrdinaryBuildingRemovalEligibility {
    pub active_planet_id: String,
    pub entity_id: String,
    pub building_id: Option<String>,
    pub machine_count: Option<u64>,
    pub current_construction: Option<u64>,
    pub refund_after_removal: Option<u64>,
    pub unsupported_reason: Option<&'static str>,
}

impl OrdinaryBuildingRemovalEligibility {
    fn new(active_planet_id: &str, entity_id: &str) -> Self {
        Self {
            active_planet_id: active_planet_id.to_owned(),
            entity_id: entity_id.to_owned(),
            building_id: None,
            machine_count: None,
            current_construction: None,
            refund_after_removal: None,
            unsupported_reason: None,
        }
    }

    fn unsupported(mut self, reason: &'static str) -> Self {
        self.unsupported_reason = Some(reason);
        self.refund_after_removal = None;
        self
    }
}

fn construction_queue_references_entity(state: &CoreState, entity_id: &str) -> bool {
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
    false
}

fn blueprint_pruning_would_change(state: &CoreState) -> bool {
    let queue = state
        .base_value()
        .get("constructionQueue")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[]);
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

/// Re-derives every eligibility and refund fact needed to remove exactly one
/// ordinary building. Both the read-only same-revision context and the durable
/// player-authority command validator call this helper; neither trusts fields
/// copied from an earlier renderer response.
pub(crate) fn ordinary_building_removal_eligibility(
    state: &CoreState,
    entity_id: &str,
) -> anyhow::Result<OrdinaryBuildingRemovalEligibility> {
    let active_planet_id = state
        .base_value()
        .get("activePlanetId")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("native player-authority active planet is invalid"))?;
    if !state
        .catalog
        .planets
        .iter()
        .any(|planet| planet.id == active_planet_id)
    {
        bail!("native player-authority active planet is not in the catalog")
    }
    let mut eligibility = OrdinaryBuildingRemovalEligibility::new(active_planet_id, entity_id);
    let Some(index) = state.entity_index.get(entity_id).copied() else {
        return Ok(eligibility.unsupported("entity-not-found"));
    };
    let entity = state.parse_entity(index)?;
    let Some(object) = entity.as_object() else {
        return Ok(eligibility.unsupported("invalid-entity"));
    };

    eligibility.building_id = object
        .get("buildingId")
        .and_then(Value::as_str)
        .map(str::to_owned);
    eligibility.machine_count =
        safe_json_integer(object.get("machineCount"), "building stack").ok();
    let construction = state
        .base_value()
        .get("construction")
        .and_then(Value::as_object);
    eligibility.current_construction = eligibility
        .building_id
        .as_deref()
        .zip(construction)
        .and_then(|(building_id, stock)| {
            normalized_construction_inventory(stock.get(building_id)).ok()
        });

    if object.get("planetId").and_then(Value::as_str) != Some(active_planet_id) {
        return Ok(eligibility.unsupported("not-active-planet"));
    }
    if object.get("interactionLocked").and_then(Value::as_bool) == Some(true) {
        return Ok(eligibility.unsupported("interaction-locked"));
    }
    let Some(building_id) = eligibility.building_id.as_deref() else {
        return Ok(eligibility.unsupported("missing-building-id"));
    };
    let Some(building) = state.catalog.buildings.get(building_id) else {
        return Ok(eligibility.unsupported("unknown-building"));
    };
    if !state.catalog.constructions.contains_key(building_id) {
        return Ok(eligibility.unsupported("missing-construction-definition"));
    }
    if matches!(building.kind.as_str(), "miner" | "station")
        || !matches!(
            building.kind.as_str(),
            "machine" | "power" | "storage" | "splitter"
        )
    {
        return Ok(eligibility.unsupported("unsupported-building-kind"));
    }
    if UNSUPPORTED_ORDINARY_REMOVAL_BUILDINGS.contains(&building_id) {
        return Ok(eligibility.unsupported("unsupported-building-domain"));
    }
    let expected_kind = match building.kind.as_str() {
        "power" => "power",
        "storage" => "storage",
        "splitter" => "splitter",
        _ => "machine",
    };
    if object.get("kind").and_then(Value::as_str) != Some(expected_kind) {
        return Ok(eligibility.unsupported("entity-kind-mismatch"));
    }
    let Some(machine_count) = eligibility.machine_count else {
        return Ok(eligibility.unsupported("invalid-machine-count"));
    };
    if machine_count == 0 {
        return Ok(eligibility.unsupported("empty-machine-stack"));
    }
    if object.get("sprayCoaterInstalled").and_then(Value::as_bool) == Some(true) {
        return Ok(eligibility.unsupported("spray-coater-installed"));
    }
    if ["inputs", "outputs"].iter().any(|key| {
        object
            .get(*key)
            .and_then(Value::as_object)
            .is_none_or(|inventory| inventory.values().any(|value| value.as_f64() != Some(0.0)))
    }) {
        return Ok(eligibility.unsupported("buffered-material"));
    }
    for belt_index in 0..state.belt_index.len() {
        let belt = state.parse_belt(belt_index)?;
        if ["source", "target"]
            .iter()
            .any(|key| belt.get(*key).and_then(Value::as_str) == Some(entity_id))
        {
            return Ok(eligibility.unsupported("incident-belt"));
        }
    }
    if construction_queue_references_entity(state, entity_id) {
        return Ok(eligibility.unsupported("construction-queue-reference"));
    }
    if blueprint_pruning_would_change(state) {
        return Ok(eligibility.unsupported("blueprint-pruning-required"));
    }
    let Some(construction) = construction else {
        return Ok(eligibility.unsupported("invalid-construction-inventory"));
    };
    let Ok(current_construction) = normalized_construction_inventory(construction.get(building_id))
    else {
        return Ok(eligibility.unsupported("invalid-construction-inventory"));
    };
    eligibility.current_construction = Some(current_construction);
    let Some(refund_after_removal) = current_construction
        .checked_add(machine_count)
        .filter(|value| *value <= MAX_JAVASCRIPT_SAFE_INTEGER)
    else {
        return Ok(eligibility.unsupported("refund-overflow"));
    };
    eligibility.refund_after_removal = Some(refund_after_removal);
    Ok(eligibility)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct OrdinaryBuildingStackEligibility {
    pub active_planet_id: String,
    pub entity_id: String,
    pub building_id: Option<String>,
    pub current_count: Option<u64>,
    pub target_count: u64,
    pub current_construction: Option<u64>,
    pub construction_after: Option<u64>,
    pub unsupported_reason: Option<&'static str>,
}

impl OrdinaryBuildingStackEligibility {
    fn new(active_planet_id: &str, entity_id: &str, target_count: u64) -> Self {
        Self {
            active_planet_id: active_planet_id.to_owned(),
            entity_id: entity_id.to_owned(),
            building_id: None,
            current_count: None,
            target_count,
            current_construction: None,
            construction_after: None,
            unsupported_reason: None,
        }
    }

    fn unsupported(mut self, reason: &'static str) -> Self {
        self.unsupported_reason = Some(reason);
        self.construction_after = None;
        self
    }
}

fn exact_construction_inventory(value: Option<&Value>) -> anyhow::Result<u64> {
    match value {
        None | Some(Value::Null) => Ok(0),
        Some(value) => safe_json_integer(Some(value), "construction inventory"),
    }
}

/// Re-derives the complete material and domain proof for one ordinary stack
/// target. The read-only same-revision context and the durable command
/// validator both call this helper so a stale renderer result is never trusted.
pub(crate) fn ordinary_building_stack_eligibility(
    state: &CoreState,
    entity_id: &str,
    target_count: u64,
) -> anyhow::Result<OrdinaryBuildingStackEligibility> {
    let active_planet_id = state
        .base_value()
        .get("activePlanetId")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("native player-authority active planet is invalid"))?;
    if !state
        .catalog
        .planets
        .iter()
        .any(|planet| planet.id == active_planet_id)
    {
        bail!("native player-authority active planet is not in the catalog")
    }
    let mut eligibility =
        OrdinaryBuildingStackEligibility::new(active_planet_id, entity_id, target_count);
    if target_count == 0 || target_count > MAX_JAVASCRIPT_SAFE_INTEGER {
        return Ok(eligibility.unsupported("invalid-target-count"));
    }
    let Some(index) = state.entity_index.get(entity_id).copied() else {
        return Ok(eligibility.unsupported("entity-not-found"));
    };
    let entity = state.parse_entity(index)?;
    let Some(object) = entity.as_object() else {
        return Ok(eligibility.unsupported("invalid-entity"));
    };
    eligibility.building_id = object
        .get("buildingId")
        .and_then(Value::as_str)
        .map(str::to_owned);
    eligibility.current_count =
        safe_json_integer(object.get("machineCount"), "building stack").ok();

    if object.get("planetId").and_then(Value::as_str) != Some(active_planet_id) {
        return Ok(eligibility.unsupported("not-active-planet"));
    }
    if object
        .get("interactionLocked")
        .is_some_and(|value| value.as_bool() != Some(false))
    {
        return Ok(eligibility.unsupported("interaction-locked"));
    }
    let Some(building_id) = eligibility.building_id.as_deref() else {
        return Ok(eligibility.unsupported("missing-building-id"));
    };
    let Some(building) = state.catalog.buildings.get(building_id) else {
        return Ok(eligibility.unsupported("unknown-building"));
    };
    if !state.catalog.constructions.contains_key(building_id) {
        return Ok(eligibility.unsupported("missing-construction-definition"));
    }
    if matches!(building.kind.as_str(), "miner" | "station")
        || !matches!(
            building.kind.as_str(),
            "machine" | "power" | "storage" | "splitter"
        )
    {
        return Ok(eligibility.unsupported("unsupported-building-kind"));
    }
    if UNSUPPORTED_ORDINARY_REMOVAL_BUILDINGS.contains(&building_id) {
        return Ok(eligibility.unsupported("unsupported-building-domain"));
    }
    let expected_kind = match building.kind.as_str() {
        "power" => "power",
        "storage" => "storage",
        "splitter" => "splitter",
        _ => "machine",
    };
    if object.get("kind").and_then(Value::as_str) != Some(expected_kind) {
        return Ok(eligibility.unsupported("entity-kind-mismatch"));
    }
    let Some(current_count) = eligibility.current_count else {
        return Ok(eligibility.unsupported("invalid-current-count"));
    };
    if current_count == 0 {
        return Ok(eligibility.unsupported("empty-machine-stack"));
    }
    if target_count == current_count {
        return Ok(eligibility.unsupported("unchanged-target"));
    }

    let Some(construction) = state
        .base_value()
        .get("construction")
        .and_then(Value::as_object)
    else {
        return Ok(eligibility.unsupported("invalid-construction-inventory"));
    };
    let Ok(current_construction) = exact_construction_inventory(construction.get(building_id))
    else {
        return Ok(eligibility.unsupported("invalid-construction-inventory"));
    };
    eligibility.current_construction = Some(current_construction);

    if target_count > current_count {
        // Historical over-limit groups may be preserved or reduced, but can
        // never be maintained through this mutating command or increased.
        if current_count > MAX_PLAYER_BUILDING_STACK || target_count > MAX_PLAYER_BUILDING_STACK {
            return Ok(eligibility.unsupported("stack-limit"));
        }
        // Current clients mark the optional stack bound complete. Older
        // non-empty content-pack catalogs remain fail-closed; the built-in
        // empty registry keeps its established compatibility path.
        let built_in_legacy_complete = state.catalog.snapshot.registry_fingerprint
            == EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT
            && BUILTIN_ORDINARY_STACK_BUILDINGS.contains(&building_id);
        let stack_policy = state.catalog.building_stack_policies.get(building_id);
        if !stack_policy.is_some_and(|policy| policy.complete) && !built_in_legacy_complete {
            return Ok(eligibility.unsupported("catalog-incomplete"));
        }
        if stack_policy
            .and_then(|policy| policy.limit)
            .is_some_and(|stack_limit| target_count > stack_limit)
        {
            return Ok(eligibility.unsupported("stack-limit"));
        }
        let addition = target_count - current_count;
        let Some(construction_after) = current_construction.checked_sub(addition) else {
            return Ok(eligibility.unsupported("inventory-insufficient"));
        };
        eligibility.construction_after = Some(construction_after);
    } else {
        let refund = current_count - target_count;
        let Some(construction_after) = current_construction
            .checked_add(refund)
            .filter(|value| *value <= MAX_JAVASCRIPT_SAFE_INTEGER)
        else {
            return Ok(eligibility.unsupported("refund-overflow"));
        };
        eligibility.construction_after = Some(construction_after);
    }
    Ok(eligibility)
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
    let target = require_exact_set_patch(&record.changes, &["machineCount"])?
        .as_u64()
        .filter(|value| *value <= MAX_JAVASCRIPT_SAFE_INTEGER)
        .ok_or_else(|| anyhow!("native player-authority building stack target is invalid"))?;
    let eligibility = ordinary_building_stack_eligibility(state, &record.id, target)?;
    if let Some(reason) = eligibility.unsupported_reason {
        bail!("native player-authority building stack change is unsupported: {reason}")
    }
    let building_id = eligibility
        .building_id
        .as_deref()
        .ok_or_else(|| anyhow!("native player-authority building stack ID is missing"))?;
    let expected = eligibility
        .construction_after
        .ok_or_else(|| anyhow!("native player-authority building stack inventory is missing"))?;
    if require_exact_set_patch(&command.top_level_changes, &["construction", building_id])?.as_u64()
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
    let eligibility = ordinary_building_removal_eligibility(state, entity_id)?;
    if let Some(reason) = eligibility.unsupported_reason {
        bail!("native player-authority ordinary building removal is unsupported: {reason}")
    }
    let building_id = eligibility
        .building_id
        .as_deref()
        .ok_or_else(|| anyhow!("native player-authority removal building ID is missing"))?;
    let expected = eligibility
        .refund_after_removal
        .ok_or_else(|| anyhow!("native player-authority building refund is missing"))?;
    if require_exact_set_patch(&command.top_level_changes, &["construction", building_id])?.as_u64()
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
    if state.catalog.snapshot.registry_fingerprint != EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT
        || state.identity.registry_fingerprint != EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT
    {
        bail!("native player-authority ejector target requires the built-in registry")
    }
    let active_planet_id = state
        .base_value()
        .get("activePlanetId")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("native player-authority active planet is invalid"))?;
    if !state
        .catalog
        .planets
        .iter()
        .any(|planet| planet.id == active_planet_id)
    {
        bail!("native player-authority active planet is not in the catalog")
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
        if object.get("planetId").and_then(Value::as_str) != Some(active_planet_id) {
            bail!("native player-authority ejector is not on the active planet")
        }
        if object.get("interactionLocked").and_then(Value::as_bool) != Some(false) {
            bail!("native player-authority ejector is locked or malformed")
        }
        if object.get("kind").and_then(Value::as_str) != Some("machine")
            || object.get("buildingId").and_then(Value::as_str) != Some("em_rail_ejector")
            || state
                .catalog
                .buildings
                .get("em_rail_ejector")
                .is_none_or(|building| building.kind != "machine")
        {
            bail!("native player-authority ejector target is not the built-in ejector")
        }
        if object.get("targetDysonOrbitId").and_then(Value::as_str) == Some(orbit_id) {
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

fn command_contains_energy_exchanger_mode_intent(command: &SimulationCommandPatch) -> bool {
    command.changed_entities.iter().any(|record| {
        record
            .changes
            .iter()
            .any(|change| path_matches(&change.path, &["energyMode"]))
    })
}

fn validated_energy_exchanger_mode_intent(
    state: &CoreState,
    command: &SimulationCommandPatch,
) -> anyhow::Result<(String, Value, String)> {
    if command.changed_entities.len() != 1
        || command.changed_entities[0].changes.len() != 1
        || !command.top_level_changes.is_empty()
        || !command.added_entities.is_empty()
        || !command.removed_entity_ids.is_empty()
        || !command.changed_belts.is_empty()
        || !command.added_belts.is_empty()
        || !command.removed_belt_ids.is_empty()
    {
        bail!("native player-authority energy exchanger command shape is invalid")
    }
    if state.catalog.snapshot.registry_fingerprint != EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT
        || state.identity.registry_fingerprint != EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT
    {
        bail!("native player-authority energy exchanger commands require the built-in catalog")
    }
    let record = &command.changed_entities[0];
    let target = require_exact_set_patch(&record.changes, &["energyMode"])?
        .as_str()
        .filter(|mode| matches!(*mode, "charge" | "discharge"))
        .ok_or_else(|| anyhow!("native player-authority energy exchanger target is invalid"))?
        .to_owned();
    let index = *state
        .entity_index
        .get(&record.id)
        .ok_or_else(|| anyhow!("native player-authority energy exchanger is missing"))?;
    let entity = state.parse_entity(index)?;
    let object = entity
        .as_object()
        .ok_or_else(|| anyhow!("native player-authority energy exchanger is invalid"))?;
    if object.get("kind").and_then(Value::as_str) != Some("power")
        || object.get("buildingId").and_then(Value::as_str) != Some("energy_exchanger")
    {
        bail!("native player-authority energy exchanger target is not the built-in building")
    }
    let active_planet_id = state
        .base_value()
        .get("activePlanetId")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("native player-authority active planet is missing"))?;
    if object.get("planetId").and_then(Value::as_str) != Some(active_planet_id) {
        bail!("native player-authority energy exchanger is not on the active planet")
    }
    if object
        .get("interactionLocked")
        .is_some_and(|locked| locked.as_bool() != Some(false))
    {
        bail!("native player-authority energy exchanger is locked or malformed")
    }
    let current = object
        .get("energyMode")
        .and_then(Value::as_str)
        .filter(|mode| matches!(*mode, "charge" | "discharge"))
        .ok_or_else(|| {
            anyhow!("native player-authority current energy exchanger mode is invalid")
        })?;
    if current == target {
        bail!("native player-authority energy exchanger target is unchanged")
    }
    let building = state
        .catalog
        .buildings
        .get("energy_exchanger")
        .filter(|building| {
            building.kind == "power"
                && building.energy_capacity_mj.is_finite()
                && building.energy_capacity_mj > 0.0
        })
        .ok_or_else(|| anyhow!("native player-authority energy exchanger catalog is invalid"))?;
    let construction = state
        .catalog
        .constructions
        .get("energy_exchanger")
        .ok_or_else(|| {
            anyhow!("native player-authority energy exchanger construction is missing")
        })?;
    if construction
        .required_tech_id
        .as_deref()
        .is_some_and(|technology_id| !technology_is_completed(state, technology_id))
    {
        bail!("native player-authority energy exchanger technology is locked")
    }
    for recipe_id in ["accumulator_charge", "accumulator_discharge"] {
        let recipe = state.catalog.recipes.get(recipe_id).filter(|recipe| {
            recipe.building_id == "energy_exchanger"
                && recipe
                    .required_tech_id
                    .as_deref()
                    .is_none_or(|technology_id| technology_is_completed(state, technology_id))
        });
        if recipe.is_none() {
            bail!("native player-authority energy exchanger recipe is missing or locked")
        }
    }
    let machine_count = safe_json_integer(object.get("machineCount"), "energy exchanger count")?;
    if machine_count == 0 {
        bail!("native player-authority energy exchanger count is empty")
    }
    let capacity = building.energy_capacity_mj * machine_count as f64;
    if !capacity.is_finite() {
        bail!("native player-authority energy exchanger capacity is invalid")
    }
    let raw_stored = match object.get("storedEnergyMj") {
        Some(value) => finite_json_number(Some(value), "energy exchanger stored energy")?,
        None => 0.0,
    };
    if raw_stored.max(0.0).min(capacity) > PLAYER_ENERGY_EPSILON {
        bail!("native player-authority energy exchanger still contains stored energy")
    }
    for field in ["inputs", "outputs"] {
        let inventory = object
            .get(field)
            .and_then(Value::as_object)
            .ok_or_else(|| {
                anyhow!("native player-authority energy exchanger inventory is invalid")
            })?;
        for (item_id, amount) in inventory {
            if !state.catalog.items.contains_key(item_id) {
                bail!("native player-authority energy exchanger inventory item is unknown")
            }
            if finite_json_number(Some(amount), "energy exchanger inventory")? < 0.0 {
                bail!("native player-authority energy exchanger inventory is negative")
            }
        }
    }
    Ok((record.id.clone(), entity, target))
}

fn validate_energy_exchanger_mode_command(
    state: &CoreState,
    command: &SimulationCommandPatch,
) -> anyhow::Result<()> {
    validated_energy_exchanger_mode_intent(state, command).map(|_| ())
}

fn add_energy_exchanger_refund_to_tray(
    base: &mut Map<String, Value>,
    item_id: &str,
    amount: &Value,
) -> anyhow::Result<()> {
    let amount = finite_json_number(Some(amount), "energy exchanger inventory refund")?;
    if amount < 0.0 {
        bail!("native player-authority energy exchanger inventory refund is negative")
    }
    let target = if matches!(item_id, "logistics_drone" | "logistics_vessel") {
        base.entry("portableFleet".to_owned())
            .or_insert_with(|| serde_json::json!({ "logistics_drone": 0, "logistics_vessel": 0 }))
            .as_object_mut()
            .ok_or_else(|| {
                anyhow!("native player-authority energy exchanger portable fleet is invalid")
            })?
    } else {
        base.get_mut("tray")
            .and_then(Value::as_object_mut)
            .ok_or_else(|| anyhow!("native player-authority active tray is invalid"))?
    };
    let current = match target.get(item_id) {
        Some(value) => finite_json_number(Some(value), "energy exchanger tray inventory")?,
        None => 0.0,
    };
    if current < 0.0 {
        bail!("native player-authority energy exchanger tray inventory is negative")
    }
    let next = (current + amount + PLAYER_ENERGY_EPSILON).floor();
    if !next.is_finite() || next > MAX_JAVASCRIPT_SAFE_INTEGER as f64 {
        bail!("native player-authority energy exchanger tray refund overflows")
    }
    target.insert(item_id.to_owned(), Value::from(next as u64));
    Ok(())
}

fn expand_energy_exchanger_mode_intent(
    state: &CoreState,
    command: &SimulationCommandPatch,
) -> anyhow::Result<SimulationCommandPatch> {
    let (entity_id, before_entity, target) =
        validated_energy_exchanger_mode_intent(state, command)?;
    let before_object = before_entity
        .as_object()
        .expect("energy exchanger intent validated the entity object");
    let mut candidate_base = Value::Object(state.base_value().clone());
    let candidate_base_object = candidate_base
        .as_object_mut()
        .expect("the native core base is an object");
    for field in ["inputs", "outputs"] {
        for (item_id, amount) in before_object[field]
            .as_object()
            .expect("energy exchanger inventory was validated")
        {
            add_energy_exchanger_refund_to_tray(candidate_base_object, item_id, amount)?;
        }
    }

    let mut removed_belt_ids = Vec::new();
    let mut belt_refunds = BTreeMap::<&'static str, u64>::new();
    for belt_index in 0..state.belts.ids.len() {
        let belt = state.parse_belt(belt_index)?;
        let object = belt
            .as_object()
            .ok_or_else(|| anyhow!("native player-authority incident belt is invalid"))?;
        if object.get("source").and_then(Value::as_str) != Some(entity_id.as_str())
            && object.get("target").and_then(Value::as_str) != Some(entity_id.as_str())
        {
            continue;
        }
        let belt_id = object
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow!("native player-authority incident belt ID is invalid"))?;
        let lanes = safe_json_integer(object.get("lanes"), "incident belt lanes")?;
        if lanes == 0 {
            bail!("native player-authority incident belt lanes are empty")
        }
        let tier = safe_json_integer(object.get("tier"), "incident belt tier")?
            .try_into()
            .map_err(|_| anyhow!("native player-authority incident belt tier is invalid"))?;
        let construction_id = builtin_belt_construction_id(state, tier)?;
        let refund = belt_refunds.entry(construction_id).or_default();
        *refund = refund
            .checked_add(lanes)
            .filter(|value| *value <= MAX_JAVASCRIPT_SAFE_INTEGER)
            .ok_or_else(|| {
                anyhow!("native player-authority energy exchanger belt refund overflows")
            })?;
        removed_belt_ids.push(belt_id.to_owned());
    }
    let construction = candidate_base_object
        .get_mut("construction")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| anyhow!("native player-authority construction inventory is missing"))?;
    for (construction_id, refund) in belt_refunds {
        let current = normalized_construction_inventory(construction.get(construction_id))?;
        let next = current
            .checked_add(refund)
            .filter(|value| *value <= MAX_JAVASCRIPT_SAFE_INTEGER)
            .ok_or_else(|| {
                anyhow!("native player-authority energy exchanger belt refund overflows")
            })?;
        construction.insert(construction_id.to_owned(), Value::from(next));
    }

    let mut candidate_entity = before_entity.clone();
    let candidate_object = candidate_entity
        .as_object_mut()
        .expect("energy exchanger intent validated the entity object");
    candidate_object.insert("inputs".to_owned(), Value::Object(Map::new()));
    candidate_object.insert("outputs".to_owned(), Value::Object(Map::new()));
    candidate_object.insert("energyMode".to_owned(), Value::from(target.as_str()));
    candidate_object.insert(
        "recipeId".to_owned(),
        Value::from(if target == "discharge" {
            "accumulator_discharge"
        } else {
            "accumulator_charge"
        }),
    );
    candidate_object.insert("progress".to_owned(), Value::from(0));
    candidate_object.insert("powerInputKw".to_owned(), Value::from(0));
    candidate_object.insert("powerOutputKw".to_owned(), Value::from(0));

    let mut top_level_changes = Vec::new();
    create_expected_value_patches(
        &Value::Object(state.base_value().clone()),
        &candidate_base,
        Vec::new(),
        &mut top_level_changes,
    );
    let mut entity_changes = Vec::new();
    create_expected_value_patches(
        &before_entity,
        &candidate_entity,
        Vec::new(),
        &mut entity_changes,
    );
    if entity_changes.is_empty() {
        bail!("native player-authority energy exchanger transition is empty")
    }
    Ok(SimulationCommandPatch {
        protocol_version: command.protocol_version,
        base_revision: command.base_revision,
        top_level_changes,
        changed_entities: vec![RecordPatch {
            id: entity_id,
            changes: entity_changes,
        }],
        added_entities: Vec::new(),
        removed_entity_ids: Vec::new(),
        changed_belts: Vec::new(),
        added_belts: Vec::new(),
        removed_belt_ids,
    })
}

fn command_contains_fuel_item_intent(command: &SimulationCommandPatch) -> bool {
    command.changed_entities.iter().any(|record| {
        record
            .changes
            .iter()
            .any(|change| path_matches(&change.path, &["fuelItemId"]))
    })
}

fn builtin_fuel_items_for_building(building_id: &str) -> Option<&'static [&'static str]> {
    match building_id {
        "thermal_power_plant" => Some(BUILTIN_THERMAL_FUEL_ITEMS),
        "mini_fusion_power_plant" => Some(BUILTIN_FUSION_FUEL_ITEMS),
        "artificial_star" => Some(BUILTIN_ARTIFICIAL_STAR_FUEL_ITEMS),
        _ => None,
    }
}

fn builtin_fuel_building_technology(building_id: &str) -> Option<&'static str> {
    match building_id {
        "thermal_power_plant" => Some("thermal_power"),
        "mini_fusion_power_plant" => Some("fusion_power"),
        "artificial_star" => Some("artificial_star"),
        _ => None,
    }
}

fn builtin_fuel_item_definition(item_id: &str) -> Option<(&'static str, f64)> {
    match item_id {
        "coal" => Some(("solid", 2.7)),
        "fire_ice" => Some(("solid", 4.8)),
        "crude_oil" => Some(("fluid", 4.0)),
        "energetic_graphite" => Some(("solid", 6.3)),
        "refined_oil" => Some(("fluid", 4.4)),
        "hydrogen" => Some(("fluid", 8.0)),
        "hydrogen_fuel_rod" => Some(("solid", 54.0)),
        "deuteron_fuel_rod" => Some(("solid", 600.0)),
        "antimatter_fuel_rod" => Some(("solid", 7_200.0)),
        _ => None,
    }
}

fn builtin_fuel_item_unlock(item_id: &str) -> Option<(&'static str, &'static str)> {
    match item_id {
        "energetic_graphite" => Some(("energy_matrix", "energetic_graphite")),
        "refined_oil" | "hydrogen" => Some(("high_efficiency_plasma_control", "plasma_refining")),
        "hydrogen_fuel_rod" => Some(("fractionation", "hydrogen_fuel_rod")),
        "deuteron_fuel_rod" => Some(("miniature_particle_collider", "deuteron_fuel_rod")),
        "antimatter_fuel_rod" => Some(("antimatter", "antimatter_fuel_rod")),
        _ => None,
    }
}

fn validated_fuel_item_intent(
    state: &CoreState,
    command: &SimulationCommandPatch,
) -> anyhow::Result<(String, Value, String)> {
    if command.changed_entities.len() != 1
        || command.changed_entities[0].changes.len() != 1
        || !command.top_level_changes.is_empty()
        || !command.added_entities.is_empty()
        || !command.removed_entity_ids.is_empty()
        || !command.changed_belts.is_empty()
        || !command.added_belts.is_empty()
        || !command.removed_belt_ids.is_empty()
    {
        bail!("native player-authority fuel item command shape is invalid")
    }
    if state.catalog.snapshot.registry_fingerprint != EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT
        || state.identity.registry_fingerprint != EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT
    {
        bail!("native player-authority fuel item commands require the built-in catalog")
    }
    let record = &command.changed_entities[0];
    let target = require_exact_set_patch(&record.changes, &["fuelItemId"])?
        .as_str()
        .ok_or_else(|| anyhow!("native player-authority fuel item target is invalid"))?
        .to_owned();
    let index = *state
        .entity_index
        .get(&record.id)
        .ok_or_else(|| anyhow!("native player-authority fuel building is missing"))?;
    let entity = state.parse_entity(index)?;
    let object = entity
        .as_object()
        .ok_or_else(|| anyhow!("native player-authority fuel building is invalid"))?;
    let building_id = object
        .get("buildingId")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("native player-authority fuel building ID is missing"))?;
    let builtin_fuel_items = builtin_fuel_items_for_building(building_id).ok_or_else(|| {
        anyhow!("native player-authority fuel target is not a built-in generator")
    })?;
    if object.get("kind").and_then(Value::as_str) != Some("power")
        || !builtin_fuel_items.contains(&target.as_str())
    {
        bail!("native player-authority building and fuel combination is invalid")
    }
    let active_planet_id = state
        .base_value()
        .get("activePlanetId")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("native player-authority active planet is missing"))?;
    if object.get("planetId").and_then(Value::as_str) != Some(active_planet_id) {
        bail!("native player-authority fuel building is not on the active planet")
    }
    if object
        .get("interactionLocked")
        .is_some_and(|locked| locked.as_bool() != Some(false))
    {
        bail!("native player-authority fuel building is locked or malformed")
    }
    if let Some(current) = object.get("fuelItemId").filter(|value| !value.is_null()) {
        let current = current
            .as_str()
            .filter(|item_id| builtin_fuel_items.contains(item_id))
            .ok_or_else(|| anyhow!("native player-authority current fuel item is invalid"))?;
        if current == target {
            bail!("native player-authority fuel item target is unchanged")
        }
    }
    if state
        .catalog
        .buildings
        .get(building_id)
        .filter(|building| {
            building.kind == "power"
                && building.power_generation_kw.is_finite()
                && building.power_generation_kw > 0.0
                && building.input_capacity.is_finite()
                && building.input_capacity > 0.0
                && building
                    .fuel_item_ids
                    .iter()
                    .map(String::as_str)
                    .eq(builtin_fuel_items.iter().copied())
        })
        .is_none()
    {
        bail!("native player-authority fuel building catalog is invalid")
    }
    let required_building_technology = builtin_fuel_building_technology(building_id)
        .expect("built-in fuel building has a technology mapping");
    if state
        .catalog
        .constructions
        .get(building_id)
        .filter(|construction| {
            construction.required_tech_id.as_deref() == Some(required_building_technology)
        })
        .is_none()
    {
        bail!("native player-authority fuel construction catalog is invalid")
    }
    if !state
        .catalog
        .technologies
        .contains_key(required_building_technology)
        || !technology_is_completed(state, required_building_technology)
    {
        bail!("native player-authority fuel building technology is locked")
    }
    let (expected_kind, expected_energy_mj) =
        builtin_fuel_item_definition(&target).expect("built-in fuel item has a catalog definition");
    if state
        .catalog
        .items
        .get(&target)
        .filter(|item| {
            item.kind == expected_kind
                && item.fuel_energy_mj.to_bits() == expected_energy_mj.to_bits()
        })
        .is_none()
    {
        bail!("native player-authority fuel item catalog is invalid")
    }
    if let Some((required_technology, recipe_id)) = builtin_fuel_item_unlock(&target) {
        let recipe = state.catalog.recipes.get(recipe_id).filter(|recipe| {
            recipe.required_tech_id.as_deref() == Some(required_technology)
                && recipe.outputs.iter().any(|output| {
                    output.item_id == target && output.amount.is_finite() && output.amount > 0.0
                })
        });
        if !state.catalog.technologies.contains_key(required_technology)
            || !technology_is_completed(state, required_technology)
            || recipe.is_none()
        {
            bail!("native player-authority fuel item is missing or locked")
        }
    }
    let machine_count = safe_json_integer(object.get("machineCount"), "fuel building count")?;
    if machine_count == 0 {
        bail!("native player-authority fuel building count is empty")
    }
    if let Some(fuel_remaining_mj) = object.get("fuelRemainingMj")
        && finite_json_number(Some(fuel_remaining_mj), "fuel chamber energy")? < 0.0
    {
        bail!("native player-authority fuel chamber energy is negative")
    }
    if let Some(power_output_kw) = object.get("powerOutputKw")
        && finite_json_number(Some(power_output_kw), "fuel building power output")? < 0.0
    {
        bail!("native player-authority fuel building power output is negative")
    }
    let inputs = object
        .get("inputs")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("native player-authority fuel inputs are invalid"))?;
    for (item_id, amount) in inputs {
        if !state.catalog.items.contains_key(item_id) {
            bail!("native player-authority fuel input item is unknown")
        }
        if finite_json_number(Some(amount), "fuel input inventory")? < 0.0 {
            bail!("native player-authority fuel input inventory is negative")
        }
    }
    Ok((record.id.clone(), entity, target))
}

fn validate_fuel_item_command(
    state: &CoreState,
    command: &SimulationCommandPatch,
) -> anyhow::Result<()> {
    validated_fuel_item_intent(state, command).map(|_| ())
}

fn add_fuel_refund_to_tray(
    base: &mut Map<String, Value>,
    item_id: &str,
    amount: &Value,
) -> anyhow::Result<()> {
    let amount = finite_json_number(Some(amount), "fuel input refund")?;
    if amount < 0.0 {
        bail!("native player-authority fuel input refund is negative")
    }
    let target = if matches!(item_id, "logistics_drone" | "logistics_vessel") {
        base.entry("portableFleet".to_owned())
            .or_insert_with(|| serde_json::json!({ "logistics_drone": 0, "logistics_vessel": 0 }))
            .as_object_mut()
            .ok_or_else(|| anyhow!("native player-authority portable fleet is invalid"))?
    } else {
        base.get_mut("tray")
            .and_then(Value::as_object_mut)
            .ok_or_else(|| anyhow!("native player-authority active tray is invalid"))?
    };
    let current = match target.get(item_id) {
        Some(value) => finite_json_number(Some(value), "fuel refund inventory")?,
        None => 0.0,
    };
    if current < 0.0 {
        bail!("native player-authority fuel refund inventory is negative")
    }
    let next = (current + amount + PLAYER_ENERGY_EPSILON).floor();
    if !next.is_finite() || next > MAX_JAVASCRIPT_SAFE_INTEGER as f64 {
        bail!("native player-authority fuel input refund overflows")
    }
    target.insert(item_id.to_owned(), Value::from(next as u64));
    Ok(())
}

fn expand_fuel_item_intent(
    state: &CoreState,
    command: &SimulationCommandPatch,
) -> anyhow::Result<SimulationCommandPatch> {
    let (entity_id, before_entity, target) = validated_fuel_item_intent(state, command)?;
    let before_object = before_entity
        .as_object()
        .expect("fuel item intent validated the entity object");
    let mut candidate_base = Value::Object(state.base_value().clone());
    let candidate_base_object = candidate_base
        .as_object_mut()
        .expect("the native core base is an object");
    for (item_id, amount) in before_object["inputs"]
        .as_object()
        .expect("fuel input inventory was validated")
    {
        add_fuel_refund_to_tray(candidate_base_object, item_id, amount)?;
    }

    let mut removed_belt_ids = Vec::new();
    let mut belt_refunds = BTreeMap::<&'static str, u64>::new();
    for belt_index in 0..state.belts.ids.len() {
        let belt = state.parse_belt(belt_index)?;
        let object = belt
            .as_object()
            .ok_or_else(|| anyhow!("native player-authority incident fuel belt is invalid"))?;
        if object.get("source").and_then(Value::as_str) != Some(entity_id.as_str())
            && object.get("target").and_then(Value::as_str) != Some(entity_id.as_str())
        {
            continue;
        }
        let belt_id = object
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow!("native player-authority incident fuel belt ID is invalid"))?;
        let lanes = safe_json_integer(object.get("lanes"), "incident fuel belt lanes")?;
        if lanes == 0 {
            bail!("native player-authority incident fuel belt lanes are empty")
        }
        let tier = safe_json_integer(object.get("tier"), "incident fuel belt tier")?
            .try_into()
            .map_err(|_| anyhow!("native player-authority incident fuel belt tier is invalid"))?;
        let construction_id = builtin_belt_construction_id(state, tier)?;
        let refund = belt_refunds.entry(construction_id).or_default();
        *refund = refund
            .checked_add(lanes)
            .filter(|value| *value <= MAX_JAVASCRIPT_SAFE_INTEGER)
            .ok_or_else(|| anyhow!("native player-authority fuel belt refund overflows"))?;
        removed_belt_ids.push(belt_id.to_owned());
    }
    let construction = candidate_base_object
        .get_mut("construction")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| anyhow!("native player-authority construction inventory is missing"))?;
    for (construction_id, refund) in belt_refunds {
        let current = normalized_construction_inventory(construction.get(construction_id))?;
        let next = current
            .checked_add(refund)
            .filter(|value| *value <= MAX_JAVASCRIPT_SAFE_INTEGER)
            .ok_or_else(|| anyhow!("native player-authority fuel belt refund overflows"))?;
        construction.insert(construction_id.to_owned(), Value::from(next));
    }

    let mut candidate_entity = before_entity.clone();
    let candidate_object = candidate_entity
        .as_object_mut()
        .expect("fuel item intent validated the entity object");
    candidate_object.insert("inputs".to_owned(), Value::Object(Map::new()));
    candidate_object.insert("fuelItemId".to_owned(), Value::from(target.as_str()));
    candidate_object.insert("powerOutputKw".to_owned(), Value::from(0));

    let mut top_level_changes = Vec::new();
    create_expected_value_patches(
        &Value::Object(state.base_value().clone()),
        &candidate_base,
        Vec::new(),
        &mut top_level_changes,
    );
    let mut entity_changes = Vec::new();
    create_expected_value_patches(
        &before_entity,
        &candidate_entity,
        Vec::new(),
        &mut entity_changes,
    );
    if entity_changes.is_empty() {
        bail!("native player-authority fuel item transition is empty")
    }
    Ok(SimulationCommandPatch {
        protocol_version: command.protocol_version,
        base_revision: command.base_revision,
        top_level_changes,
        changed_entities: vec![RecordPatch {
            id: entity_id,
            changes: entity_changes,
        }],
        added_entities: Vec::new(),
        removed_entity_ids: Vec::new(),
        changed_belts: Vec::new(),
        added_belts: Vec::new(),
        removed_belt_ids,
    })
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
    let require_active_planet = || -> anyhow::Result<()> {
        let active_planet_id = state
            .base_value()
            .get("activePlanetId")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow!("native player-authority active planet is missing"))?;
        if object.get("planetId").and_then(Value::as_str) != Some(active_planet_id) {
            bail!("native player-authority configured entity is not on the active planet")
        }
        Ok(())
    };
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
            require_active_planet()?;
            let building_id = object.get("buildingId").and_then(Value::as_str);
            if object.get("kind").and_then(Value::as_str) != Some("machine")
                || !building_id.is_some_and(|building_id| {
                    BUILTIN_POWER_PRIORITY_BUILDINGS.contains(&building_id)
                })
            {
                bail!(
                    "native player-authority power priority target is not a built-in ordinary consumer"
                )
            }
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
            require_active_planet()?;
            target
                .as_str()
                .filter(|mode| matches!(*mode, "balanced" | "priority"))
                .ok_or_else(|| {
                    anyhow!("native player-authority splitter mode target is invalid")
                })?;
            if object.get("kind").and_then(Value::as_str) != Some("splitter")
                || object.get("buildingId").and_then(Value::as_str) != Some("splitter_4way")
            {
                bail!("native player-authority splitter mode target is not the built-in splitter")
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

#[derive(Debug, Clone, PartialEq, Eq)]
struct BlackHolePauseIntent {
    entity_id: String,
    paused: bool,
    confirm_activation: bool,
}

fn command_contains_black_hole_pause_intent(command: &SimulationCommandPatch) -> bool {
    command.changed_entities.iter().any(|record| {
        record
            .changes
            .iter()
            .any(|change| path_matches(&change.path, &["blackHolePaused", "intent"]))
    })
}

fn require_black_hole_pause_intent(
    command: &SimulationCommandPatch,
) -> anyhow::Result<BlackHolePauseIntent> {
    if command.changed_entities.len() != 1
        || command.changed_entities[0].changes.len() != 1
        || !command.top_level_changes.is_empty()
        || !command.added_entities.is_empty()
        || !command.removed_entity_ids.is_empty()
        || !command.changed_belts.is_empty()
        || !command.added_belts.is_empty()
        || !command.removed_belt_ids.is_empty()
    {
        bail!("native player-authority black-hole pause intent shape is invalid")
    }
    let record = &command.changed_entities[0];
    let change = &record.changes[0];
    if !path_matches(&change.path, &["blackHolePaused", "intent"]) || change.operation != "set" {
        bail!("native player-authority black-hole pause intent path is invalid")
    }
    let intent = change
        .value
        .as_ref()
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("native player-authority black-hole pause intent is invalid"))?;
    if intent.len() != 2
        || !intent.contains_key("paused")
        || !intent.contains_key("confirmActivation")
    {
        bail!("native player-authority black-hole pause intent fields are invalid")
    }
    let paused = intent
        .get("paused")
        .and_then(Value::as_bool)
        .ok_or_else(|| anyhow!("native player-authority black-hole pause target is invalid"))?;
    let confirm_activation = intent
        .get("confirmActivation")
        .and_then(Value::as_bool)
        .ok_or_else(|| {
            anyhow!("native player-authority black-hole activation confirmation is invalid")
        })?;
    Ok(BlackHolePauseIntent {
        entity_id: record.id.clone(),
        paused,
        confirm_activation,
    })
}

fn validate_black_hole_pause_command(
    state: &CoreState,
    command: &SimulationCommandPatch,
) -> anyhow::Result<()> {
    let intent = require_black_hole_pause_intent(command)?;
    if state.catalog.snapshot.registry_fingerprint != EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT
        || state.identity.registry_fingerprint != EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT
    {
        bail!("native player-authority black-hole pause requires the built-in registry")
    }
    let active_planet_id = state
        .base_value()
        .get("activePlanetId")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("native player-authority active planet is invalid"))?;
    if !state
        .catalog
        .planets
        .iter()
        .any(|planet| planet.id == active_planet_id)
    {
        bail!("native player-authority active planet is not in the catalog")
    }
    let index = *state
        .entity_index
        .get(&intent.entity_id)
        .ok_or_else(|| anyhow!("native player-authority black-hole entity is missing"))?;
    let entity = state.parse_entity(index)?;
    let object = entity
        .as_object()
        .ok_or_else(|| anyhow!("native player-authority black-hole entity is invalid"))?;
    if object.get("planetId").and_then(Value::as_str) != Some(active_planet_id) {
        bail!("native player-authority black-hole entity is not on the active planet")
    }
    if object.get("interactionLocked").and_then(Value::as_bool) != Some(false) {
        bail!("native player-authority black-hole entity is locked or malformed")
    }
    if object.get("kind").and_then(Value::as_str) != Some("machine")
        || object.get("buildingId").and_then(Value::as_str) != Some("micro_black_hole_connector")
        || state
            .catalog
            .buildings
            .get("micro_black_hole_connector")
            .is_none_or(|building| building.kind != "machine")
    {
        bail!("native player-authority black-hole target is not the built-in connector")
    }
    let current_paused = object
        .get("blackHolePaused")
        .and_then(Value::as_bool)
        .ok_or_else(|| anyhow!("native player-authority black-hole paused state is invalid"))?;
    let activation_confirmed = object
        .get("blackHoleActivationConfirmed")
        .and_then(Value::as_bool)
        .ok_or_else(|| {
            anyhow!("native player-authority black-hole confirmation state is invalid")
        })?;
    if !intent.paused && !activation_confirmed && !intent.confirm_activation {
        bail!("native player-authority black-hole first activation is not confirmed")
    }
    if current_paused == intent.paused && (intent.paused || activation_confirmed) {
        bail!("native player-authority black-hole pause target is unchanged")
    }
    Ok(())
}

fn expand_black_hole_pause_intent(
    state: &CoreState,
    command: &SimulationCommandPatch,
) -> anyhow::Result<SimulationCommandPatch> {
    validate_black_hole_pause_command(state, command)?;
    let intent = require_black_hole_pause_intent(command)?;
    let index = *state
        .entity_index
        .get(&intent.entity_id)
        .ok_or_else(|| anyhow!("native player-authority black-hole entity is missing"))?;
    let entity = state.parse_entity(index)?;
    let object = entity
        .as_object()
        .ok_or_else(|| anyhow!("native player-authority black-hole entity is invalid"))?;
    let current_paused = object
        .get("blackHolePaused")
        .and_then(Value::as_bool)
        .ok_or_else(|| anyhow!("native player-authority black-hole paused state is invalid"))?;
    let current_confirmed = object
        .get("blackHoleActivationConfirmed")
        .and_then(Value::as_bool)
        .ok_or_else(|| {
            anyhow!("native player-authority black-hole confirmation state is invalid")
        })?;
    let target_confirmed = current_confirmed || (!intent.paused && intent.confirm_activation);
    let mut changes = Vec::with_capacity(2);
    if current_paused != intent.paused {
        changes.push(ValuePatch {
            path: vec![PathSegment::Key("blackHolePaused".to_owned())],
            operation: "set".to_owned(),
            value: Some(Value::from(intent.paused)),
        });
    }
    if current_confirmed != target_confirmed {
        changes.push(ValuePatch {
            path: vec![PathSegment::Key("blackHoleActivationConfirmed".to_owned())],
            operation: "set".to_owned(),
            value: Some(Value::from(target_confirmed)),
        });
    }
    if changes.is_empty() {
        bail!("native player-authority black-hole pause transition is empty")
    }
    Ok(SimulationCommandPatch {
        protocol_version: command.protocol_version,
        base_revision: command.base_revision,
        top_level_changes: Vec::new(),
        changed_entities: vec![RecordPatch {
            id: intent.entity_id,
            changes,
        }],
        added_entities: Vec::new(),
        removed_entity_ids: Vec::new(),
        changed_belts: Vec::new(),
        added_belts: Vec::new(),
        removed_belt_ids: Vec::new(),
    })
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

fn station_slot_item_change(change: &ValuePatch) -> Option<usize> {
    match change.path.as_slice() {
        [
            PathSegment::Key(root),
            PathSegment::Index(slot_index),
            PathSegment::Key(field),
        ] if root == "stationSlots" && field == "itemId" => Some(*slot_index),
        _ => None,
    }
}

fn command_contains_station_slot_item(command: &SimulationCommandPatch) -> bool {
    command.changed_entities.iter().any(|record| {
        record
            .changes
            .iter()
            .any(|change| station_slot_item_change(change).is_some())
    })
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

fn derive_station_slot_mode_command_from_direct(
    state: &CoreState,
    command: &SimulationCommandPatch,
    validate_candidate: bool,
) -> anyhow::Result<SimulationCommandPatch> {
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
            station_progress_value(remaining_progress),
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
    if validate_candidate {
        exact_patch_sets_match(&command.top_level_changes, &expected_top_level)?;
    }

    let mut expected_records = BTreeMap::<String, Vec<ValuePatch>>::new();
    for (entity_id, (current, expected)) in expected_entities {
        let mut changes = Vec::new();
        create_expected_value_patches(&current, &expected, Vec::new(), &mut changes);
        if !changes.is_empty() {
            expected_records.insert(entity_id, changes);
        }
    }
    if validate_candidate {
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
    }
    Ok(SimulationCommandPatch {
        protocol_version: command.protocol_version,
        base_revision: command.base_revision,
        top_level_changes: expected_top_level,
        changed_entities: expected_records
            .into_iter()
            .map(|(id, changes)| RecordPatch { id, changes })
            .collect(),
        added_entities: Vec::new(),
        removed_entity_ids: Vec::new(),
        changed_belts: Vec::new(),
        added_belts: Vec::new(),
        removed_belt_ids: Vec::new(),
    })
}

fn validate_station_slot_mode_command(
    state: &CoreState,
    command: &SimulationCommandPatch,
) -> anyhow::Result<()> {
    derive_station_slot_mode_command_from_direct(state, command, true).map(|_| ())
}

fn validated_station_slot_item_id(
    state: &CoreState,
    slot: &Map<String, Value>,
    label: &str,
) -> anyhow::Result<Option<String>> {
    match slot.get("itemId") {
        None | Some(Value::Null) => Ok(None),
        Some(value) => value
            .as_str()
            .filter(|item_id| state.catalog.items.contains_key(*item_id))
            .map(str::to_owned)
            .map(Some)
            .ok_or_else(|| anyhow!("native player-authority {label} item is invalid")),
    }
}

fn validate_station_slot_shape(
    state: &CoreState,
    slot: &Map<String, Value>,
    label: &str,
) -> anyhow::Result<Option<String>> {
    let item_id = validated_station_slot_item_id(state, slot, label)?;
    for field in ["localMode", "remoteMode"] {
        slot.get(field)
            .and_then(Value::as_str)
            .filter(|mode| matches!(*mode, "supply" | "demand" | "storage"))
            .ok_or_else(|| anyhow!("native player-authority {label} {field} is invalid"))?;
    }
    let minimum_load =
        finite_json_number(slot.get("minimumLoad"), &format!("{label} minimum load"))?;
    if !matches!(minimum_load, 0.1 | 0.25 | 0.5 | 1.0) {
        bail!("native player-authority {label} minimum load is invalid")
    }
    let min_stock = safe_json_integer(slot.get("minStock"), &format!("{label} minimum stock"))?;
    let max_stock = safe_json_integer(slot.get("maxStock"), &format!("{label} maximum stock"))?;
    if min_stock > MAX_PLAYER_STATION_STOCK
        || max_stock > MAX_PLAYER_STATION_STOCK
        || max_stock > 0 && min_stock > max_stock
    {
        bail!("native player-authority {label} stock limits are invalid")
    }
    let priority = safe_json_integer(slot.get("priority"), &format!("{label} priority"))?;
    if priority > 2 {
        bail!("native player-authority {label} priority is invalid")
    }
    slot.get("routePolicy")
        .and_then(Value::as_str)
        .filter(|policy| matches!(*policy, "direct" | "relay-preferred" | "relay-required"))
        .ok_or_else(|| anyhow!("native player-authority {label} route policy is invalid"))?;
    let warper_budget =
        safe_json_integer(slot.get("warperBudget"), &format!("{label} warper budget"))?;
    if !(1..=4).contains(&warper_budget) {
        bail!("native player-authority {label} warper budget is invalid")
    }
    Ok(item_id)
}

fn add_protective_station_inventory_refund(
    state: &CoreState,
    expected_base: &mut Value,
    planet_id: &str,
    item_id: &str,
    amount: u64,
    label: &str,
) -> anyhow::Result<()> {
    if amount == 0 {
        return Ok(());
    }
    if !state.catalog.items.contains_key(item_id) {
        bail!("native player-authority {label} item is not in the catalog")
    }
    if !state
        .catalog
        .planets
        .iter()
        .any(|planet| planet.id == planet_id)
    {
        bail!("native player-authority {label} planet is invalid")
    }
    let base = expected_base
        .as_object_mut()
        .ok_or_else(|| anyhow!("native player-authority expected base state is invalid"))?;
    if matches!(item_id, "logistics_drone" | "logistics_vessel") {
        let portable = base
            .entry("portableFleet".to_owned())
            .or_insert_with(|| serde_json::json!({ "logistics_drone": 0, "logistics_vessel": 0 }))
            .as_object_mut()
            .ok_or_else(|| {
                anyhow!("native player-authority portable fleet inventory is invalid")
            })?;
        let current = normalized_nonnegative_inventory(portable.get(item_id), label)?;
        let expected = current
            .checked_add(amount)
            .filter(|value| *value <= MAX_JAVASCRIPT_SAFE_INTEGER)
            .ok_or_else(|| anyhow!("native player-authority {label} overflows"))?;
        portable.insert(item_id.to_owned(), Value::from(expected));
        return Ok(());
    }

    let active_planet_id = base
        .get("activePlanetId")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("native player-authority active planet is missing"))?
        .to_owned();
    let tray = if planet_id == active_planet_id {
        base.get_mut("tray")
            .and_then(Value::as_object_mut)
            .ok_or_else(|| anyhow!("native player-authority active tray is invalid"))?
    } else {
        let planet_trays = base
            .get_mut("planetTrays")
            .and_then(Value::as_object_mut)
            .ok_or_else(|| anyhow!("native player-authority planet tray directory is invalid"))?;
        planet_trays
            .entry(planet_id.to_owned())
            .or_insert_with(|| Value::Object(Map::new()))
            .as_object_mut()
            .ok_or_else(|| anyhow!("native player-authority remote planet tray is invalid"))?
    };
    let current = normalized_nonnegative_inventory(tray.get(item_id), label)?;
    let expected = current
        .checked_add(amount)
        .filter(|value| *value <= MAX_JAVASCRIPT_SAFE_INTEGER)
        .ok_or_else(|| anyhow!("native player-authority {label} overflows"))?;
    tray.insert(item_id.to_owned(), Value::from(expected));
    Ok(())
}

fn derive_station_slot_item_command_from_direct(
    state: &CoreState,
    command: &SimulationCommandPatch,
    validate_candidate: bool,
) -> anyhow::Result<SimulationCommandPatch> {
    if !command.added_entities.is_empty()
        || !command.removed_entity_ids.is_empty()
        || !command.changed_belts.is_empty()
        || !command.added_belts.is_empty()
    {
        bail!("native player-authority station slot item command shape is invalid")
    }

    let mut intent = None::<(String, usize, Option<String>)>;
    for record in &command.changed_entities {
        for change in &record.changes {
            let Some(slot_index) = station_slot_item_change(change) else {
                continue;
            };
            if intent.is_some() {
                bail!("native player-authority station slot item intent is repeated")
            }
            let target_item_id = match change.operation.as_str() {
                "set" => match change.value.as_ref() {
                    None | Some(Value::Null) => None,
                    Some(value) => Some(
                        value
                            .as_str()
                            .filter(|item_id| state.catalog.items.contains_key(*item_id))
                            .ok_or_else(|| {
                                anyhow!(
                                    "native player-authority station slot target item is invalid"
                                )
                            })?
                            .to_owned(),
                    ),
                },
                "delete" if change.value.as_ref().is_none_or(Value::is_null) => None,
                _ => bail!("native player-authority station slot item intent is malformed"),
            };
            intent = Some((record.id.clone(), slot_index, target_item_id));
        }
    }
    let (target_id, slot_index, target_item_id) = intent
        .ok_or_else(|| anyhow!("native player-authority station slot item intent is missing"))?;
    if slot_index >= PLAYER_STATION_SLOT_COUNT {
        bail!("native player-authority station slot item index is out of range")
    }

    let target_index = *state
        .entity_index
        .get(&target_id)
        .ok_or_else(|| anyhow!("native player-authority station slot item target is missing"))?;
    let target = state.parse_entity(target_index)?;
    let target_object = target
        .as_object()
        .ok_or_else(|| anyhow!("native player-authority station slot item target is invalid"))?;
    let building_id = target_object
        .get("buildingId")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("native player-authority station slot item building is missing"))?
        .to_owned();
    let building = state
        .catalog
        .buildings
        .get(&building_id)
        .filter(|building| building.kind == "station")
        .ok_or_else(|| {
            anyhow!("native player-authority station slot item building is incompatible")
        })?;
    if target_object.get("kind").and_then(Value::as_str) != Some("station")
        || building_id == "orbital_collector"
    {
        bail!("native player-authority station slot item target is not configurable")
    }
    if let Some(locked) = target_object.get("interactionLocked")
        && locked.as_bool() != Some(false)
    {
        bail!("native player-authority station slot item target is locked or malformed")
    }
    let target_planet_id = target_object
        .get("planetId")
        .and_then(Value::as_str)
        .filter(|planet_id| {
            state
                .catalog
                .planets
                .iter()
                .any(|planet| planet.id == *planet_id)
        })
        .ok_or_else(|| anyhow!("native player-authority station slot item planet is invalid"))?
        .to_owned();
    let slots = target_object
        .get("stationSlots")
        .and_then(Value::as_array)
        .filter(|slots| slots.len() == PLAYER_STATION_SLOT_COUNT)
        .ok_or_else(|| anyhow!("native player-authority station slot item directory is invalid"))?;
    let mut slot_items = Vec::with_capacity(PLAYER_STATION_SLOT_COUNT);
    for (index, slot) in slots.iter().enumerate() {
        let slot = slot
            .as_object()
            .ok_or_else(|| anyhow!("native player-authority station slot {index} is invalid"))?;
        slot_items.push(validate_station_slot_shape(
            state,
            slot,
            &format!("station slot {index}"),
        )?);
    }
    let previous_item_id = slot_items[slot_index].clone();
    if previous_item_id == target_item_id {
        bail!("native player-authority station slot item target is unchanged")
    }
    if let Some(target_item_id) = target_item_id.as_deref() {
        if slot_items.iter().enumerate().any(|(index, item_id)| {
            index != slot_index && item_id.as_deref() == Some(target_item_id)
        }) {
            bail!("native player-authority station slot item is already configured")
        }
        let item = state
            .catalog
            .items
            .get(target_item_id)
            .expect("the station slot target item was validated above");
        let accepts = building.accepts.as_deref().unwrap_or("any");
        if accepts != "any"
            && accepts != item.kind
            && !(accepts == "solid" && item.kind == "matrix")
        {
            bail!("native player-authority station slot item is incompatible")
        }
    }

    let mut expected_base = Value::Object(state.base_value().clone());
    let mut expected_entities = BTreeMap::<String, (Value, Value)>::new();
    expected_entities.insert(target_id.clone(), (target.clone(), target.clone()));

    // A station route carries a reservation, not a second copy of its cargo:
    // dispatch leaves the source output in place and completion performs the
    // single debit. Item replacement therefore releases reservations without
    // adding route.cargo to an inventory. The backing check below proves the
    // canceled reservations still belong to their exact source owner.
    let mut canceled_cargo_by_source = BTreeMap::<(String, String), u64>::new();
    let mut warper_refunds = Vec::<StationRouteWarperRefund>::new();
    let mut canceled_route_ids = HashSet::<String>::new();
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
            match route_object.get("scope") {
                None | Some(Value::Null) => {}
                Some(value)
                    if value
                        .as_str()
                        .is_some_and(|scope| matches!(scope, "local" | "remote")) => {}
                _ => bail!("native player-authority station route scope is invalid"),
            }
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
                .filter(|item_id| state.catalog.items.contains_key(*item_id))
                .ok_or_else(|| anyhow!("native player-authority station route item is invalid"))?;
            let cargo = safe_json_integer(route_object.get("cargo"), "station route cargo")?;
            let progress =
                finite_json_number(route_object.get("progress"), "station route progress")?;
            if !(0.0..=1.0).contains(&progress) {
                bail!("native player-authority station route progress is out of range")
            }
            let cancel = (demand_id == target_id && route_slot_index as usize == slot_index)
                || (previous_item_id.is_some()
                    && peer_id == target_id
                    && Some(route_item_id) == previous_item_id.as_deref());
            if !cancel {
                remaining.push(route.clone());
                continue;
            }
            canceled_any = true;
            let route_id = route_object
                .get("id")
                .and_then(Value::as_str)
                .filter(|route_id| !route_id.is_empty())
                .ok_or_else(|| anyhow!("native player-authority station route ID is invalid"))?;
            if !canceled_route_ids.insert(route_id.to_owned()) {
                bail!("native player-authority station route ID is repeated")
            }
            let source_index = *state.entity_index.get(peer_id).ok_or_else(|| {
                anyhow!("native player-authority station route cargo owner is missing")
            })?;
            let source = state.parse_entity(source_index)?;
            let source_object = source.as_object().ok_or_else(|| {
                anyhow!("native player-authority station route cargo owner is invalid")
            })?;
            let source_building_id = source_object
                .get("buildingId")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    anyhow!("native player-authority station route cargo owner building is invalid")
                })?;
            if source_object.get("kind").and_then(Value::as_str) != Some("station")
                || state
                    .catalog
                    .buildings
                    .get(source_building_id)
                    .is_none_or(|building| building.kind != "station")
            {
                bail!("native player-authority station route cargo owner is incompatible")
            }
            let cargo_total = canceled_cargo_by_source
                .entry((peer_id.to_owned(), route_item_id.to_owned()))
                .or_default();
            *cargo_total = cargo_total
                .checked_add(cargo)
                .filter(|amount| *amount <= MAX_JAVASCRIPT_SAFE_INTEGER)
                .ok_or_else(|| {
                    anyhow!("native player-authority station route cargo reservation overflows")
                })?;

            let vehicle_count = safe_json_integer(
                route_object.get("vehicleCount"),
                "station route vehicle count",
            )?;
            let requires_warp = match route_object.get("requiresWarp") {
                None | Some(Value::Null) => false,
                Some(value) => value.as_bool().ok_or_else(|| {
                    anyhow!("native player-authority station route warp state is invalid")
                })?,
            };
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
                warper_refunds.push(StationRouteWarperRefund {
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
            station_progress_value(remaining_progress),
        );
    }
    for ((source_id, item_id), reserved) in canceled_cargo_by_source {
        let source_index = *state
            .entity_index
            .get(&source_id)
            .expect("the station route cargo owner was validated above");
        let source = state.parse_entity(source_index)?;
        let outputs = source
            .get("outputs")
            .and_then(Value::as_object)
            .ok_or_else(|| {
                anyhow!("native player-authority station route cargo owner output is invalid")
            })?;
        let available = normalized_nonnegative_inventory(
            outputs.get(&item_id),
            "station route cargo owner output",
        )?;
        if reserved > available {
            bail!("native player-authority station route cargo is not backed by its owner")
        }
    }

    for refund in warper_refunds {
        if let Some(owner_id) = refund.owner_id {
            let owner = expected_entity_mut(state, &mut expected_entities, &owner_id)?;
            let owner_object = owner.as_object_mut().ok_or_else(|| {
                anyhow!("native player-authority station route vehicle owner is invalid")
            })?;
            if owner_object.get("kind").and_then(Value::as_str) != Some("station")
                || owner_object.get("buildingId").and_then(Value::as_str)
                    != Some("interstellar_logistics_station")
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
            let owner_planet_id = owner_object
                .get("planetId")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    anyhow!("native player-authority station route vehicle owner planet is invalid")
                })?
                .to_owned();
            add_protective_station_inventory_refund(
                state,
                &mut expected_base,
                &owner_planet_id,
                "space_warper",
                refund.amount - stored,
                "station route warper refund",
            )?;
        } else {
            add_protective_station_inventory_refund(
                state,
                &mut expected_base,
                &refund.fallback_planet_id,
                "space_warper",
                refund.amount,
                "station route fallback warper refund",
            )?;
        }
    }

    let mut buffered_refund = 0_u64;
    if let Some(previous_item_id) = previous_item_id.as_deref() {
        for field in ["inputs", "outputs"] {
            let inventory = target_object
                .get(field)
                .and_then(Value::as_object)
                .ok_or_else(|| {
                    anyhow!("native player-authority station slot {field} is invalid")
                })?;
            buffered_refund = buffered_refund
                .checked_add(normalized_nonnegative_inventory(
                    inventory.get(previous_item_id),
                    &format!("station slot {field} inventory"),
                )?)
                .filter(|amount| *amount <= MAX_JAVASCRIPT_SAFE_INTEGER)
                .ok_or_else(|| anyhow!("native player-authority station slot refund overflows"))?;
        }
        let expected_target = expected_entity_mut(state, &mut expected_entities, &target_id)?;
        let expected_target_object = expected_target.as_object_mut().ok_or_else(|| {
            anyhow!("native player-authority expected station slot target is invalid")
        })?;
        for field in ["inputs", "outputs"] {
            expected_target_object
                .get_mut(field)
                .and_then(Value::as_object_mut)
                .ok_or_else(|| {
                    anyhow!("native player-authority expected station slot {field} is invalid")
                })?
                .insert(previous_item_id.to_owned(), Value::from(0));
        }
        add_protective_station_inventory_refund(
            state,
            &mut expected_base,
            &target_planet_id,
            previous_item_id,
            buffered_refund,
            "station slot buffered refund",
        )?;
    }

    let mut expected_removed_belt_ids = Vec::<String>::new();
    let mut belt_refunds = BTreeMap::<&'static str, u64>::new();
    if let Some(previous_item_id) = previous_item_id.as_deref() {
        for belt_index in 0..state.belts.ids.len() {
            let belt = state.parse_belt(belt_index)?;
            let object = belt
                .as_object()
                .ok_or_else(|| anyhow!("native player-authority station slot belt is invalid"))?;
            let source = object.get("source").and_then(Value::as_str);
            let target = object.get("target").and_then(Value::as_str);
            if source != Some(target_id.as_str()) && target != Some(target_id.as_str()) {
                continue;
            }
            let item_id = object
                .get("itemId")
                .and_then(Value::as_str)
                .filter(|item_id| state.catalog.items.contains_key(*item_id))
                .ok_or_else(|| {
                    anyhow!("native player-authority station slot belt item is invalid")
                })?;
            if item_id != previous_item_id {
                continue;
            }
            let belt_id = object
                .get("id")
                .and_then(Value::as_str)
                .filter(|belt_id| state.belt_index.get(belt_id).copied() == Some(belt_index))
                .ok_or_else(|| {
                    anyhow!("native player-authority station slot belt ID is invalid")
                })?;
            let lanes = safe_json_integer(object.get("lanes"), "station slot belt lanes")?;
            if lanes == 0 {
                bail!("native player-authority station slot belt lanes are empty")
            }
            let tier = safe_json_integer(object.get("tier"), "station slot belt tier")?
                .try_into()
                .map_err(|_| {
                    anyhow!("native player-authority station slot belt tier is invalid")
                })?;
            let construction_id = builtin_belt_construction_id(state, tier)?;
            let refund = belt_refunds.entry(construction_id).or_default();
            *refund = refund
                .checked_add(lanes)
                .filter(|amount| *amount <= MAX_JAVASCRIPT_SAFE_INTEGER)
                .ok_or_else(|| {
                    anyhow!("native player-authority station slot belt refund overflows")
                })?;
            expected_removed_belt_ids.push(belt_id.to_owned());
        }
    }
    if validate_candidate && command.removed_belt_ids != expected_removed_belt_ids {
        bail!("native player-authority station slot belt removal set is invalid")
    }
    if !belt_refunds.is_empty() {
        let base = expected_base
            .as_object_mut()
            .expect("expected base was initialized as an object");
        let construction = base
            .get_mut("construction")
            .and_then(Value::as_object_mut)
            .ok_or_else(|| anyhow!("native player-authority construction inventory is missing"))?;
        for (construction_id, refund) in belt_refunds {
            let current = normalized_construction_inventory(construction.get(construction_id))?;
            let expected = current
                .checked_add(refund)
                .filter(|amount| *amount <= MAX_JAVASCRIPT_SAFE_INTEGER)
                .ok_or_else(|| {
                    anyhow!("native player-authority station slot belt refund overflows")
                })?;
            construction.insert(construction_id.to_owned(), Value::from(expected));
        }
    }

    // Apply the selected item and the legacy mirrors exactly once. Unknown
    // entity/slot members remain on their original objects; the native
    // authority never rebuilds a MOD record from a reduced schema.
    let expected_target = expected_entity_mut(state, &mut expected_entities, &target_id)?;
    let expected_target_object = expected_target.as_object_mut().ok_or_else(|| {
        anyhow!("native player-authority expected station slot target is invalid")
    })?;
    {
        let expected_slots = expected_target_object
            .get_mut("stationSlots")
            .and_then(Value::as_array_mut)
            .ok_or_else(|| anyhow!("native player-authority expected station slots are invalid"))?;
        let expected_slot = expected_slots[slot_index]
            .as_object_mut()
            .ok_or_else(|| anyhow!("native player-authority expected station slot is invalid"))?;
        if let Some(item_id) = target_item_id.as_deref() {
            expected_slot.insert("itemId".to_owned(), Value::from(item_id));
            if building_id == "planetary_logistics_station" {
                expected_slot.insert("localMode".to_owned(), Value::from("supply"));
            }
            if building_id == "interstellar_logistics_station" {
                expected_slot.insert("remoteMode".to_owned(), Value::from("supply"));
            }
        } else {
            expected_slot.remove("itemId");
            expected_slot.insert("localMode".to_owned(), Value::from("storage"));
            expected_slot.insert("remoteMode".to_owned(), Value::from("storage"));
        }
    }
    let primary = expected_target_object
        .get("stationSlots")
        .and_then(Value::as_array)
        .expect("the expected station slot directory was validated above")
        .iter()
        .find_map(|slot| {
            let slot = slot.as_object()?;
            let item_id = slot.get("itemId")?.as_str()?;
            Some((
                item_id.to_owned(),
                slot.get("localMode")?.as_str()?.to_owned(),
                slot.get("remoteMode")?.as_str()?.to_owned(),
                slot.get("minimumLoad")?.clone(),
            ))
        });
    if let Some((primary_item_id, local_mode, remote_mode, minimum_load)) = primary {
        if !state.catalog.items.contains_key(&primary_item_id)
            || !matches!(local_mode.as_str(), "supply" | "demand" | "storage")
            || !matches!(remote_mode.as_str(), "supply" | "demand" | "storage")
        {
            bail!("native player-authority station slot primary item is invalid")
        }
        let minimum = finite_json_number(Some(&minimum_load), "station slot primary minimum load")?;
        if !matches!(minimum, 0.1 | 0.25 | 0.5 | 1.0) {
            bail!("native player-authority station slot primary minimum load is invalid")
        }
        expected_target_object.insert("storedItemId".to_owned(), Value::from(primary_item_id));
        let legacy_mode = if (building_id == "planetary_logistics_station"
            && local_mode == "demand")
            || (building_id == "interstellar_logistics_station" && remote_mode == "demand")
        {
            "demand"
        } else {
            "supply"
        };
        expected_target_object.insert("stationMode".to_owned(), Value::from(legacy_mode));
        expected_target_object.insert("stationMinimumLoad".to_owned(), minimum_load);
    } else {
        expected_target_object.remove("storedItemId");
    }
    expected_target_object.insert("stationProgress".to_owned(), Value::from(0));
    expected_target_object.remove("stationPeerId");
    if expected_target_object
        .get("stationRoutes")
        .is_none_or(Value::is_null)
    {
        expected_target_object.insert("stationRoutes".to_owned(), Value::Array(Vec::new()));
    }

    let current_base = Value::Object(state.base_value().clone());
    let mut expected_top_level = Vec::new();
    create_expected_value_patches(
        &current_base,
        &expected_base,
        Vec::new(),
        &mut expected_top_level,
    );
    if validate_candidate {
        exact_patch_sets_match(&command.top_level_changes, &expected_top_level)?;
    }

    let mut expected_records = BTreeMap::<String, Vec<ValuePatch>>::new();
    for (entity_id, (current, expected)) in expected_entities {
        let mut changes = Vec::new();
        create_expected_value_patches(&current, &expected, Vec::new(), &mut changes);
        if !changes.is_empty() {
            expected_records.insert(entity_id, changes);
        }
    }
    if validate_candidate {
        if command.changed_entities.len() != expected_records.len() {
            bail!("native player-authority station slot entity set is incomplete or mixed")
        }
        let mut seen_entities = HashSet::new();
        for record in &command.changed_entities {
            if !seen_entities.insert(record.id.as_str()) {
                bail!("native player-authority station slot entity is repeated")
            }
            let expected = expected_records.get(&record.id).ok_or_else(|| {
                anyhow!("native player-authority station slot changed an unrelated entity")
            })?;
            exact_patch_sets_match(&record.changes, expected)?;
        }
    }
    Ok(SimulationCommandPatch {
        protocol_version: command.protocol_version,
        base_revision: command.base_revision,
        top_level_changes: expected_top_level,
        changed_entities: expected_records
            .into_iter()
            .map(|(id, changes)| RecordPatch { id, changes })
            .collect(),
        added_entities: Vec::new(),
        removed_entity_ids: Vec::new(),
        changed_belts: Vec::new(),
        added_belts: Vec::new(),
        removed_belt_ids: expected_removed_belt_ids,
    })
}

fn validate_station_slot_item_command(
    state: &CoreState,
    command: &SimulationCommandPatch,
) -> anyhow::Result<()> {
    derive_station_slot_item_command_from_direct(state, command, true).map(|_| ())
}

fn command_contains_station_slot_mode_intent(command: &SimulationCommandPatch) -> bool {
    command.changed_entities.iter().any(|record| {
        record
            .changes
            .iter()
            .any(|change| path_matches(&change.path, &["stationSlotMode", "intent"]))
    })
}

fn command_contains_station_slot_item_intent(command: &SimulationCommandPatch) -> bool {
    command.changed_entities.iter().any(|record| {
        record
            .changes
            .iter()
            .any(|change| path_matches(&change.path, &["stationSlotItem", "intent"]))
    })
}

fn require_station_slot_mode_intent(
    command: &SimulationCommandPatch,
) -> anyhow::Result<(&str, usize, &str, &str)> {
    if command.changed_entities.len() != 1
        || command.changed_entities[0].changes.len() != 1
        || !command.top_level_changes.is_empty()
        || !command.added_entities.is_empty()
        || !command.removed_entity_ids.is_empty()
        || !command.changed_belts.is_empty()
        || !command.added_belts.is_empty()
        || !command.removed_belt_ids.is_empty()
    {
        bail!("native player-authority station slot mode intent shape is invalid")
    }
    let record = &command.changed_entities[0];
    let change = &record.changes[0];
    if !path_matches(&change.path, &["stationSlotMode", "intent"]) || change.operation != "set" {
        bail!("native player-authority station slot mode intent path is invalid")
    }
    let intent = change
        .value
        .as_ref()
        .and_then(Value::as_object)
        .filter(|intent| intent.len() == 3)
        .ok_or_else(|| anyhow!("native player-authority station slot mode intent is invalid"))?;
    let slot_index = intent
        .get("slotIndex")
        .and_then(Value::as_u64)
        .and_then(|slot_index| usize::try_from(slot_index).ok())
        .filter(|slot_index| *slot_index < PLAYER_STATION_SLOT_COUNT)
        .ok_or_else(|| {
            anyhow!("native player-authority station slot mode intent index is invalid")
        })?;
    let scope = intent
        .get("scope")
        .and_then(Value::as_str)
        .filter(|scope| matches!(*scope, "local" | "remote"))
        .ok_or_else(|| {
            anyhow!("native player-authority station slot mode intent scope is invalid")
        })?;
    let mode = intent
        .get("mode")
        .and_then(Value::as_str)
        .filter(|mode| matches!(*mode, "supply" | "demand" | "storage"))
        .ok_or_else(|| {
            anyhow!("native player-authority station slot mode intent target is invalid")
        })?;
    Ok((record.id.as_str(), slot_index, scope, mode))
}

fn require_station_slot_item_intent(
    command: &SimulationCommandPatch,
) -> anyhow::Result<(&str, usize, Option<&str>)> {
    if command.changed_entities.len() != 1
        || command.changed_entities[0].changes.len() != 1
        || !command.top_level_changes.is_empty()
        || !command.added_entities.is_empty()
        || !command.removed_entity_ids.is_empty()
        || !command.changed_belts.is_empty()
        || !command.added_belts.is_empty()
        || !command.removed_belt_ids.is_empty()
    {
        bail!("native player-authority station slot item intent shape is invalid")
    }
    let record = &command.changed_entities[0];
    let change = &record.changes[0];
    if !path_matches(&change.path, &["stationSlotItem", "intent"]) || change.operation != "set" {
        bail!("native player-authority station slot item intent path is invalid")
    }
    let intent = change
        .value
        .as_ref()
        .and_then(Value::as_object)
        .filter(|intent| intent.len() == 2)
        .ok_or_else(|| anyhow!("native player-authority station slot item intent is invalid"))?;
    let slot_index = intent
        .get("slotIndex")
        .and_then(Value::as_u64)
        .and_then(|slot_index| usize::try_from(slot_index).ok())
        .filter(|slot_index| *slot_index < PLAYER_STATION_SLOT_COUNT)
        .ok_or_else(|| {
            anyhow!("native player-authority station slot item intent index is invalid")
        })?;
    let item_id = match intent.get("itemId") {
        Some(Value::Null) => None,
        Some(Value::String(item_id)) if !item_id.is_empty() => Some(item_id.as_str()),
        _ => {
            bail!("native player-authority station slot item intent target is invalid")
        }
    };
    Ok((record.id.as_str(), slot_index, item_id))
}

fn validate_builtin_active_station_slot_target(
    state: &CoreState,
    station_id: &str,
) -> anyhow::Result<()> {
    if state.catalog.snapshot.registry_fingerprint != EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT
        || state.identity.registry_fingerprint != EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT
    {
        bail!("native player-authority station slot intent requires the built-in catalog")
    }
    let station_index = *state
        .entity_index
        .get(station_id)
        .ok_or_else(|| anyhow!("native player-authority station slot intent target is missing"))?;
    let station = state.parse_entity(station_index)?;
    let station = station
        .as_object()
        .ok_or_else(|| anyhow!("native player-authority station slot intent target is invalid"))?;
    let building_id = station
        .get("buildingId")
        .and_then(Value::as_str)
        .filter(|building_id| {
            matches!(
                *building_id,
                "planetary_logistics_station" | "interstellar_logistics_station"
            )
        })
        .ok_or_else(|| {
            anyhow!("native player-authority station slot intent target is incompatible")
        })?;
    let building = state
        .catalog
        .buildings
        .get(building_id)
        .filter(|building| building.kind == "station")
        .ok_or_else(|| {
            anyhow!("native player-authority station slot intent target is incompatible")
        })?;
    if station.get("kind").and_then(Value::as_str) != Some("station") {
        bail!("native player-authority station slot intent target is incompatible")
    }
    if station.get("interactionLocked").and_then(Value::as_bool) != Some(false) {
        bail!("native player-authority station slot intent target is locked or malformed")
    }
    let planet_id = station
        .get("planetId")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("native player-authority station slot intent planet is invalid"))?;
    let active_planet_id = state
        .base_value()
        .get("activePlanetId")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("native player-authority active planet is missing"))?;
    if planet_id != active_planet_id {
        bail!("native player-authority station slot intent target is not on the active planet")
    }
    let slots = station
        .get("stationSlots")
        .and_then(Value::as_array)
        .filter(|slots| slots.len() == PLAYER_STATION_SLOT_COUNT)
        .ok_or_else(|| {
            anyhow!("native player-authority station slot intent directory is invalid")
        })?;
    let accepts = building.accepts.as_deref().unwrap_or("any");
    let mut seen_items = HashSet::new();
    for (slot_index, slot) in slots.iter().enumerate() {
        let slot = slot.as_object().ok_or_else(|| {
            anyhow!("native player-authority station slot intent slot {slot_index} is invalid")
        })?;
        if let Some(item_id) = validate_station_slot_shape(
            state,
            slot,
            &format!("station slot intent slot {slot_index}"),
        )? {
            if !seen_items.insert(item_id.clone()) {
                bail!("native player-authority station slot intent item is repeated")
            }
            let item = state
                .catalog
                .items
                .get(&item_id)
                .expect("the station slot intent item was validated above");
            if accepts != "any"
                && accepts != item.kind
                && !(accepts == "solid" && item.kind == "matrix")
            {
                bail!("native player-authority station slot intent item is incompatible")
            }
        }
    }
    Ok(())
}

fn expand_station_slot_mode_intent(
    state: &CoreState,
    command: &SimulationCommandPatch,
) -> anyhow::Result<SimulationCommandPatch> {
    let (station_id, slot_index, scope, mode) = require_station_slot_mode_intent(command)?;
    validate_builtin_active_station_slot_target(state, station_id)?;
    let field = if scope == "local" {
        "localMode"
    } else {
        "remoteMode"
    };
    let direct = SimulationCommandPatch {
        protocol_version: command.protocol_version,
        base_revision: command.base_revision,
        top_level_changes: Vec::new(),
        changed_entities: vec![RecordPatch {
            id: station_id.to_owned(),
            changes: vec![ValuePatch {
                path: vec![
                    PathSegment::Key("stationSlots".to_owned()),
                    PathSegment::Index(slot_index),
                    PathSegment::Key(field.to_owned()),
                ],
                operation: "set".to_owned(),
                value: Some(Value::from(mode)),
            }],
        }],
        added_entities: Vec::new(),
        removed_entity_ids: Vec::new(),
        changed_belts: Vec::new(),
        added_belts: Vec::new(),
        removed_belt_ids: Vec::new(),
    };
    // Keep the marker immutable in the WAL. Only this temporary direct leaf is
    // expanded into the same complete route/refund/mirror diff accepted from
    // legacy renderers.
    derive_station_slot_mode_command_from_direct(state, &direct, false)
}

fn expand_station_slot_item_intent(
    state: &CoreState,
    command: &SimulationCommandPatch,
) -> anyhow::Result<SimulationCommandPatch> {
    let (station_id, slot_index, item_id) = require_station_slot_item_intent(command)?;
    validate_builtin_active_station_slot_target(state, station_id)?;
    let direct = SimulationCommandPatch {
        protocol_version: command.protocol_version,
        base_revision: command.base_revision,
        top_level_changes: Vec::new(),
        changed_entities: vec![RecordPatch {
            id: station_id.to_owned(),
            changes: vec![ValuePatch {
                path: vec![
                    PathSegment::Key("stationSlots".to_owned()),
                    PathSegment::Index(slot_index),
                    PathSegment::Key("itemId".to_owned()),
                ],
                operation: "set".to_owned(),
                value: Some(item_id.map_or(Value::Null, Value::from)),
            }],
        }],
        added_entities: Vec::new(),
        removed_entity_ids: Vec::new(),
        changed_belts: Vec::new(),
        added_belts: Vec::new(),
        removed_belt_ids: Vec::new(),
    };
    derive_station_slot_item_command_from_direct(state, &direct, false)
}

fn validate_station_slot_mode_intent(
    state: &CoreState,
    command: &SimulationCommandPatch,
) -> anyhow::Result<()> {
    expand_station_slot_mode_intent(state, command).map(|_| ())
}

fn validate_station_slot_item_intent(
    state: &CoreState,
    command: &SimulationCommandPatch,
) -> anyhow::Result<()> {
    expand_station_slot_item_intent(state, command).map(|_| ())
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
        let entity = validated_builtin_station(state, &record.id, false, false)?;
        let object = entity
            .as_object()
            .ok_or_else(|| anyhow!("native player-authority station entity is invalid"))?;
        let building_id = object
            .get("buildingId")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow!("native player-authority station building ID is missing"))?;
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

fn validated_builtin_station(
    state: &CoreState,
    entity_id: &str,
    require_interstellar: bool,
    require_active_planet: bool,
) -> anyhow::Result<Value> {
    if state.identity.registry_fingerprint != EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT
        || state.catalog.snapshot.registry_fingerprint != EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT
    {
        bail!("native player-authority station configuration requires the built-in registry")
    }
    let index = *state
        .entity_index
        .get(entity_id)
        .ok_or_else(|| anyhow!("native player-authority station entity is missing"))?;
    let entity = state.parse_entity(index)?;
    let object = entity
        .as_object()
        .ok_or_else(|| anyhow!("native player-authority station entity is invalid"))?;
    let building_id = object.get("buildingId").and_then(Value::as_str);
    let active_planet_id = state
        .base_value()
        .get("activePlanetId")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("native player-authority active planet is invalid"))?;
    if object.get("kind").and_then(Value::as_str) != Some("station")
        || !matches!(
            building_id,
            Some("planetary_logistics_station" | "interstellar_logistics_station")
        )
        || require_interstellar && building_id != Some("interstellar_logistics_station")
        || object.get("interactionLocked").and_then(Value::as_bool) != Some(false)
        || require_active_planet
            && object.get("planetId").and_then(Value::as_str) != Some(active_planet_id)
    {
        bail!("native player-authority station target is locked, stale, foreign or malformed")
    }
    crate::factory_read_model::validate_station_configuration_for_command(state, object)?;
    Ok(entity)
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
    let entity = validated_builtin_station(state, &record.id, true, false)?;
    let object = entity
        .as_object()
        .ok_or_else(|| anyhow!("native player-authority interstellar station is invalid"))?;
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

#[derive(Clone, Copy)]
enum StationFleetKind {
    Drone,
    Vessel,
}

impl StationFleetKind {
    fn from_intent(value: &str) -> anyhow::Result<Self> {
        match value {
            "drone" => Ok(Self::Drone),
            "vessel" => Ok(Self::Vessel),
            _ => bail!("native player-authority station fleet intent kind is invalid"),
        }
    }

    fn from_field(value: &str) -> anyhow::Result<Self> {
        match value {
            "stationDrones" => Ok(Self::Drone),
            "stationVessels" => Ok(Self::Vessel),
            _ => bail!("native player-authority station fleet field is invalid"),
        }
    }

    fn field(self) -> &'static str {
        match self {
            Self::Drone => "stationDrones",
            Self::Vessel => "stationVessels",
        }
    }

    fn item_id(self) -> &'static str {
        match self {
            Self::Drone => "logistics_drone",
            Self::Vessel => "logistics_vessel",
        }
    }

    fn route_scope(self) -> &'static str {
        match self {
            Self::Drone => "local",
            Self::Vessel => "remote",
        }
    }

    fn capacity_per_building(self) -> u64 {
        match self {
            Self::Drone => PLAYER_STATION_DRONES_PER_BUILDING,
            Self::Vessel => PLAYER_STATION_VESSELS_PER_BUILDING,
        }
    }
}

struct StationFleetContext {
    station_id: String,
    station: Map<String, Value>,
    kind: StationFleetKind,
    current_count: u64,
    capacity: u64,
    busy: u64,
    portable_count: u64,
}

struct StationFleetDerivation {
    top_level_changes: Vec<ValuePatch>,
    changed_entities: Vec<RecordPatch>,
}

impl StationFleetDerivation {
    fn into_command(self, protocol_version: u16, base_revision: u64) -> SimulationCommandPatch {
        SimulationCommandPatch {
            protocol_version,
            base_revision,
            top_level_changes: self.top_level_changes,
            changed_entities: self.changed_entities,
            added_entities: Vec::new(),
            removed_entity_ids: Vec::new(),
            changed_belts: Vec::new(),
            added_belts: Vec::new(),
            removed_belt_ids: Vec::new(),
        }
    }
}

fn station_fleet_context(
    state: &CoreState,
    station_id: &str,
    kind: StationFleetKind,
    require_active_planet: bool,
    require_builtin_catalog: bool,
) -> anyhow::Result<StationFleetContext> {
    if require_builtin_catalog
        && (state.catalog.snapshot.registry_fingerprint != EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT
            || state.identity.registry_fingerprint != EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT)
    {
        bail!("native player-authority station fleet requires the built-in catalog")
    }
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
    let compatible = match kind {
        StationFleetKind::Drone => matches!(
            building_id,
            "planetary_logistics_station" | "interstellar_logistics_station"
        ),
        StationFleetKind::Vessel => building_id == "interstellar_logistics_station",
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
    if require_active_planet {
        let planet_id = station
            .get("planetId")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow!("native player-authority station fleet planet is invalid"))?;
        let active_planet_id = state
            .base_value()
            .get("activePlanetId")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow!("native player-authority active planet is missing"))?;
        if planet_id != active_planet_id {
            bail!("native player-authority station fleet target is not on the active planet")
        }
    }
    if (require_active_planet
        && station.get("interactionLocked").and_then(Value::as_bool) != Some(false))
        || (!require_active_planet
            && station
                .get("interactionLocked")
                .is_some_and(|locked| locked.as_bool() != Some(false)))
    {
        bail!("native player-authority station fleet target is locked or malformed")
    }
    let current_count =
        finite_json_number(station.get(kind.field()), "current station fleet count")?
            .floor()
            .max(0.0);
    if current_count > MAX_JAVASCRIPT_SAFE_INTEGER as f64 {
        bail!("native player-authority current station fleet count is too large")
    }
    let current_count = current_count as u64;
    let machine_count = safe_json_integer(station.get("machineCount"), "station stack")?;
    let capacity = machine_count
        .checked_mul(kind.capacity_per_building())
        .filter(|capacity| *capacity <= MAX_JAVASCRIPT_SAFE_INTEGER)
        .ok_or_else(|| anyhow!("native player-authority station fleet capacity overflows"))?;
    let busy = station_busy_vehicle_count(state, station_id, kind.route_scope())?;
    let item_id = kind.item_id();
    if !state.catalog.items.contains_key(item_id) {
        bail!("native player-authority station fleet item is not in the catalog")
    }
    let base = state.base_value();
    let portable = base
        .get("portableFleet")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("native player-authority portable fleet is missing"))?;
    let portable_count = normalized_construction_inventory(portable.get(item_id))?;
    Ok(StationFleetContext {
        station_id: station_id.to_owned(),
        station: station.clone(),
        kind,
        current_count,
        capacity,
        busy,
        portable_count,
    })
}

fn derive_station_fleet_final(
    state: &CoreState,
    context: StationFleetContext,
    final_count: u64,
    force_progress_resets: bool,
) -> anyhow::Result<StationFleetDerivation> {
    if final_count == context.current_count {
        bail!("native player-authority station fleet target is unchanged")
    }
    if final_count > context.capacity || final_count < context.busy {
        bail!("native player-authority station fleet target violates capacity or busy vehicles")
    }
    let item_id = context.kind.item_id();
    let expected_inventory = if final_count > context.current_count {
        let loaded = final_count - context.current_count;
        context.portable_count.checked_sub(loaded).ok_or_else(|| {
            anyhow!("native player-authority portable fleet stock is insufficient")
        })?
    } else {
        let returned = context.current_count - final_count;
        context
            .portable_count
            .checked_add(returned)
            .filter(|next| *next <= MAX_JAVASCRIPT_SAFE_INTEGER)
            .ok_or_else(|| anyhow!("native player-authority fleet refund overflows"))?
    };
    let mut station_changes = vec![ValuePatch {
        path: vec![PathSegment::Key(context.kind.field().to_owned())],
        operation: "set".to_owned(),
        value: Some(Value::from(final_count)),
    }];
    let station_progress_is_zero = context
        .station
        .get("stationProgress")
        .map(|value| finite_json_number(Some(value), "current station progress"))
        .transpose()?
        .is_some_and(|progress| progress == 0.0);
    if force_progress_resets || !station_progress_is_zero {
        station_changes.push(ValuePatch {
            path: vec![PathSegment::Key("stationProgress".to_owned())],
            operation: "set".to_owned(),
            value: Some(Value::from(0)),
        });
    }
    let mut changed_entities = vec![RecordPatch {
        id: context.station_id.clone(),
        changes: station_changes,
    }];
    let peer_id = match context.station.get("stationPeerId") {
        None | Some(Value::Null) => None,
        Some(Value::String(peer_id)) if !peer_id.is_empty() => Some(peer_id.as_str()),
        _ => bail!("native player-authority station fleet peer ID is invalid"),
    };
    if let Some(peer_id) = peer_id
        && peer_id != context.station_id
        && let Some(peer_index) = state.entity_index.get(peer_id)
    {
        let peer = state.parse_entity(*peer_index)?;
        let peer_progress_is_zero = peer
            .get("stationProgress")
            .map(|value| finite_json_number(Some(value), "current station peer progress"))
            .transpose()?
            .is_some_and(|progress| progress == 0.0);
        if force_progress_resets || !peer_progress_is_zero {
            changed_entities.push(RecordPatch {
                id: peer_id.to_owned(),
                changes: vec![ValuePatch {
                    path: vec![PathSegment::Key("stationProgress".to_owned())],
                    operation: "set".to_owned(),
                    value: Some(Value::from(0)),
                }],
            });
        }
    }
    Ok(StationFleetDerivation {
        top_level_changes: vec![ValuePatch {
            path: vec![
                PathSegment::Key("portableFleet".to_owned()),
                PathSegment::Key(item_id.to_owned()),
            ],
            operation: "set".to_owned(),
            value: Some(Value::from(expected_inventory)),
        }],
        changed_entities,
    })
}

fn validate_station_fleet_derivation(
    command: &SimulationCommandPatch,
    derivation: &StationFleetDerivation,
) -> anyhow::Result<()> {
    if !command.added_entities.is_empty()
        || !command.removed_entity_ids.is_empty()
        || !command.changed_belts.is_empty()
        || !command.added_belts.is_empty()
        || !command.removed_belt_ids.is_empty()
        || command.top_level_changes.len() != derivation.top_level_changes.len()
        || command.changed_entities.len() != derivation.changed_entities.len()
    {
        bail!("native player-authority station fleet entity effects are incomplete or mixed")
    }
    let expected_top = &derivation.top_level_changes[0];
    let expected_path = expected_top
        .path
        .iter()
        .map(|segment| match segment {
            PathSegment::Key(key) => Ok(key.as_str()),
            PathSegment::Index(_) => Err(anyhow!(
                "native player-authority station fleet derived path is invalid"
            )),
        })
        .collect::<anyhow::Result<Vec<_>>>()?;
    if require_exact_set_patch(&command.top_level_changes, &expected_path)?
        != expected_top
            .value
            .as_ref()
            .expect("derived fleet value exists")
    {
        bail!("native player-authority station fleet inventory accounting is invalid")
    }
    let mut seen = HashSet::new();
    for record in &command.changed_entities {
        if !seen.insert(record.id.as_str()) {
            bail!("native player-authority station fleet entity is repeated")
        }
        let Some(expected_record) = derivation
            .changed_entities
            .iter()
            .find(|expected| expected.id == record.id)
        else {
            bail!("native player-authority station fleet command changes an unrelated entity")
        };
        if serde_json::to_value(&record.changes)? != serde_json::to_value(&expected_record.changes)?
        {
            bail!("native player-authority station fleet entity accounting is invalid")
        }
    }
    Ok(())
}

fn command_contains_station_fleet_target_intent(command: &SimulationCommandPatch) -> bool {
    command.changed_entities.iter().any(|record| {
        record
            .changes
            .iter()
            .any(|change| path_matches(&change.path, &["stationFleetTarget", "intent"]))
    })
}

fn require_station_fleet_target_intent(
    command: &SimulationCommandPatch,
) -> anyhow::Result<(&str, StationFleetKind, u64)> {
    if command.changed_entities.len() != 1
        || command.changed_entities[0].changes.len() != 1
        || !command.top_level_changes.is_empty()
        || !command.added_entities.is_empty()
        || !command.removed_entity_ids.is_empty()
        || !command.changed_belts.is_empty()
        || !command.added_belts.is_empty()
        || !command.removed_belt_ids.is_empty()
    {
        bail!("native player-authority station fleet intent shape is invalid")
    }
    let record = &command.changed_entities[0];
    let change = &record.changes[0];
    if !path_matches(&change.path, &["stationFleetTarget", "intent"]) || change.operation != "set" {
        bail!("native player-authority station fleet intent path is invalid")
    }
    let intent = change
        .value
        .as_ref()
        .and_then(Value::as_object)
        .filter(|intent| intent.len() == 2)
        .ok_or_else(|| anyhow!("native player-authority station fleet intent is invalid"))?;
    let kind =
        StationFleetKind::from_intent(intent.get("kind").and_then(Value::as_str).ok_or_else(
            || anyhow!("native player-authority station fleet intent kind is invalid"),
        )?)?;
    let target_count = intent
        .get("targetCount")
        .and_then(Value::as_u64)
        .filter(|value| *value <= MAX_JAVASCRIPT_SAFE_INTEGER)
        .ok_or_else(|| anyhow!("native player-authority station fleet intent target is invalid"))?;
    Ok((record.id.as_str(), kind, target_count))
}

fn expand_station_fleet_target_intent(
    state: &CoreState,
    command: &SimulationCommandPatch,
) -> anyhow::Result<SimulationCommandPatch> {
    let (station_id, kind, target_count) = require_station_fleet_target_intent(command)?;
    let context = station_fleet_context(state, station_id, kind, true, true)?;
    let requested = target_count.min(context.capacity);
    let desired = requested.max(context.busy);
    let loaded = desired
        .saturating_sub(context.current_count)
        .min(context.portable_count);
    let unloaded = context.current_count.saturating_sub(desired);
    let final_count = context
        .current_count
        .checked_add(loaded)
        .and_then(|value| value.checked_sub(unloaded))
        .ok_or_else(|| anyhow!("native player-authority station fleet intent overflows"))?;
    derive_station_fleet_final(state, context, final_count, true)
        .map(|derived| derived.into_command(command.protocol_version, command.base_revision))
}

fn validate_station_fleet_target_intent(
    state: &CoreState,
    command: &SimulationCommandPatch,
) -> anyhow::Result<()> {
    expand_station_fleet_target_intent(state, command).map(|_| ())
}

fn validate_station_fleet_target_command(
    state: &CoreState,
    command: &SimulationCommandPatch,
) -> anyhow::Result<()> {
    if command.changed_entities.is_empty() {
        bail!("native player-authority station fleet command shape is invalid")
    }
    if state.catalog.snapshot.registry_fingerprint != EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT
        || state.identity.registry_fingerprint != EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT
    {
        bail!("native player-authority station fleet requires the built-in catalog")
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
                .filter(|value| *value <= MAX_JAVASCRIPT_SAFE_INTEGER)
                .ok_or_else(|| {
                    anyhow!("native player-authority station fleet target is invalid")
                })?;
            target = Some((
                record.id.as_str(),
                StationFleetKind::from_field(field)?,
                value,
            ));
        }
    }
    let (station_id, kind, final_count) =
        target.ok_or_else(|| anyhow!("native player-authority station fleet target is missing"))?;
    let context = station_fleet_context(state, station_id, kind, false, true)?;
    let derivation = derive_station_fleet_final(state, context, final_count, false)?;
    validate_station_fleet_derivation(command, &derivation)
}

struct StationWarperContext {
    station_id: String,
    current_count: u64,
    capacity: u64,
    tray_count: u64,
    tray_path: Vec<String>,
}

struct StationWarperDerivation {
    top_level_changes: Vec<ValuePatch>,
    changed_entities: Vec<RecordPatch>,
}

impl StationWarperDerivation {
    fn into_command(self, protocol_version: u16, base_revision: u64) -> SimulationCommandPatch {
        SimulationCommandPatch {
            protocol_version,
            base_revision,
            top_level_changes: self.top_level_changes,
            changed_entities: self.changed_entities,
            added_entities: Vec::new(),
            removed_entity_ids: Vec::new(),
            changed_belts: Vec::new(),
            added_belts: Vec::new(),
            removed_belt_ids: Vec::new(),
        }
    }
}

fn station_warper_context(
    state: &CoreState,
    station_id: &str,
    require_active_planet: bool,
    require_builtin_catalog: bool,
) -> anyhow::Result<StationWarperContext> {
    if require_builtin_catalog
        && (state.catalog.snapshot.registry_fingerprint != EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT
            || state.identity.registry_fingerprint != EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT)
    {
        bail!("native player-authority station warper requires the built-in catalog")
    }
    let station_index = *state
        .entity_index
        .get(station_id)
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
    if (require_active_planet
        && station.get("interactionLocked").and_then(Value::as_bool) != Some(false))
        || (!require_active_planet
            && station
                .get("interactionLocked")
                .is_some_and(|locked| locked.as_bool() != Some(false)))
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
    let machine_count = safe_json_integer(station.get("machineCount"), "station stack")?;
    let capacity = machine_count
        .checked_mul(50)
        .filter(|capacity| *capacity <= MAX_JAVASCRIPT_SAFE_INTEGER)
        .ok_or_else(|| anyhow!("native player-authority station warper capacity overflows"))?;
    if current > capacity {
        bail!("native player-authority current station warper count exceeds capacity")
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
    if require_active_planet && planet_id != active_planet_id {
        bail!("native player-authority station warper target is not on the active planet")
    }
    let (tray, tray_path) = if planet_id == active_planet_id {
        (
            state
                .base_value()
                .get("tray")
                .and_then(Value::as_object)
                .ok_or_else(|| anyhow!("native player-authority active tray is missing"))?,
            vec!["tray".to_owned(), "space_warper".to_owned()],
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
            vec![
                "planetTrays".to_owned(),
                planet_id.to_owned(),
                "space_warper".to_owned(),
            ],
        )
    };
    let tray_count = normalized_construction_inventory(tray.get("space_warper"))?;
    Ok(StationWarperContext {
        station_id: station_id.to_owned(),
        current_count: current,
        capacity,
        tray_count,
        tray_path,
    })
}

fn derive_station_warper_final(
    context: StationWarperContext,
    final_count: u64,
) -> anyhow::Result<StationWarperDerivation> {
    if final_count == context.current_count {
        bail!("native player-authority station warper count is unchanged")
    }
    if final_count > context.capacity {
        bail!("native player-authority station warper count exceeds capacity")
    }
    let expected_tray = if final_count > context.current_count {
        context
            .tray_count
            .checked_sub(final_count - context.current_count)
            .ok_or_else(|| {
                anyhow!("native player-authority station warper stock is insufficient")
            })?
    } else {
        context
            .tray_count
            .checked_add(context.current_count - final_count)
            .filter(|count| *count <= MAX_JAVASCRIPT_SAFE_INTEGER)
            .ok_or_else(|| anyhow!("native player-authority station warper refund overflows"))?
    };
    Ok(StationWarperDerivation {
        top_level_changes: vec![ValuePatch {
            path: context
                .tray_path
                .into_iter()
                .map(PathSegment::Key)
                .collect(),
            operation: "set".to_owned(),
            value: Some(Value::from(expected_tray)),
        }],
        changed_entities: vec![RecordPatch {
            id: context.station_id,
            changes: vec![ValuePatch {
                path: vec![PathSegment::Key("stationWarpers".to_owned())],
                operation: "set".to_owned(),
                value: Some(Value::from(final_count)),
            }],
        }],
    })
}

fn validate_station_warper_derivation(
    command: &SimulationCommandPatch,
    derivation: &StationWarperDerivation,
) -> anyhow::Result<()> {
    if !command.added_entities.is_empty()
        || !command.removed_entity_ids.is_empty()
        || !command.changed_belts.is_empty()
        || !command.added_belts.is_empty()
        || !command.removed_belt_ids.is_empty()
        || serde_json::to_value(&command.top_level_changes)?
            != serde_json::to_value(&derivation.top_level_changes)?
        || serde_json::to_value(&command.changed_entities)?
            != serde_json::to_value(&derivation.changed_entities)?
    {
        bail!("native player-authority station warper inventory accounting is invalid")
    }
    Ok(())
}

fn command_contains_station_warper_inventory_intent(command: &SimulationCommandPatch) -> bool {
    command.changed_entities.iter().any(|record| {
        record
            .changes
            .iter()
            .any(|change| path_matches(&change.path, &["stationWarperInventory", "intent"]))
    })
}

fn require_station_warper_inventory_intent(
    command: &SimulationCommandPatch,
) -> anyhow::Result<(&str, i64)> {
    if command.changed_entities.len() != 1
        || command.changed_entities[0].changes.len() != 1
        || !command.top_level_changes.is_empty()
        || !command.added_entities.is_empty()
        || !command.removed_entity_ids.is_empty()
        || !command.changed_belts.is_empty()
        || !command.added_belts.is_empty()
        || !command.removed_belt_ids.is_empty()
    {
        bail!("native player-authority station warper intent shape is invalid")
    }
    let record = &command.changed_entities[0];
    let change = &record.changes[0];
    if !path_matches(&change.path, &["stationWarperInventory", "intent"])
        || change.operation != "set"
    {
        bail!("native player-authority station warper intent path is invalid")
    }
    let intent = change
        .value
        .as_ref()
        .and_then(Value::as_object)
        .filter(|intent| intent.len() == 1)
        .ok_or_else(|| anyhow!("native player-authority station warper intent is invalid"))?;
    let delta = intent
        .get("delta")
        .and_then(Value::as_i64)
        .filter(|delta| *delta != 0 && delta.unsigned_abs() <= MAX_JAVASCRIPT_SAFE_INTEGER)
        .ok_or_else(|| anyhow!("native player-authority station warper intent delta is invalid"))?;
    Ok((record.id.as_str(), delta))
}

fn expand_station_warper_inventory_intent(
    state: &CoreState,
    command: &SimulationCommandPatch,
) -> anyhow::Result<SimulationCommandPatch> {
    let (station_id, delta) = require_station_warper_inventory_intent(command)?;
    let context = station_warper_context(state, station_id, true, true)?;
    let final_count = if delta > 0 {
        let added = (delta as u64)
            .min(context.capacity - context.current_count)
            .min(context.tray_count);
        context
            .current_count
            .checked_add(added)
            .ok_or_else(|| anyhow!("native player-authority station warper intent overflows"))?
    } else {
        context.current_count - context.current_count.min(delta.unsigned_abs())
    };
    derive_station_warper_final(context, final_count)
        .map(|derived| derived.into_command(command.protocol_version, command.base_revision))
}

fn validate_station_warper_inventory_intent(
    state: &CoreState,
    command: &SimulationCommandPatch,
) -> anyhow::Result<()> {
    expand_station_warper_inventory_intent(state, command).map(|_| ())
}

fn validate_station_warper_inventory_command(
    state: &CoreState,
    command: &SimulationCommandPatch,
) -> anyhow::Result<()> {
    if command.changed_entities.len() != 1
        || command.changed_entities[0].changes.len() != 1
        || command.top_level_changes.len() != 1
    {
        bail!("native player-authority station warper inventory command shape is invalid")
    }
    let record = &command.changed_entities[0];
    let final_count = require_exact_set_patch(&record.changes, &["stationWarpers"])?
        .as_u64()
        .filter(|value| *value <= MAX_JAVASCRIPT_SAFE_INTEGER)
        .ok_or_else(|| anyhow!("native player-authority station warper count is invalid"))?;
    let context = station_warper_context(state, &record.id, false, false)?;
    let derivation = derive_station_warper_final(context, final_count)?;
    validate_station_warper_derivation(command, &derivation)
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum ConstructionAutomationIntent {
    Enabled(bool),
    QuantumSupplyEnabled(bool),
    TargetStock { target_id: String, target: u64 },
    BatchBuildingTargetStock { target: u64 },
}

fn command_contains_construction_automation_intent(command: &SimulationCommandPatch) -> bool {
    command
        .top_level_changes
        .iter()
        .any(|change| path_matches(&change.path, &["constructionAutomation", "intent"]))
}

fn require_construction_automation_intent(
    command: &SimulationCommandPatch,
) -> anyhow::Result<ConstructionAutomationIntent> {
    if command.top_level_changes.len() != 1
        || !command.changed_entities.is_empty()
        || !command.added_entities.is_empty()
        || !command.removed_entity_ids.is_empty()
        || !command.changed_belts.is_empty()
        || !command.added_belts.is_empty()
        || !command.removed_belt_ids.is_empty()
    {
        bail!("native player-authority construction automation intent shape is invalid")
    }
    let change = &command.top_level_changes[0];
    if !path_matches(&change.path, &["constructionAutomation", "intent"])
        || change.operation != "set"
    {
        bail!("native player-authority construction automation intent path is invalid")
    }
    let intent = change
        .value
        .as_ref()
        .and_then(Value::as_object)
        .ok_or_else(|| {
            anyhow!("native player-authority construction automation intent is invalid")
        })?;
    match intent.get("kind").and_then(Value::as_str) {
        Some("enabled") if intent.len() == 2 => Ok(ConstructionAutomationIntent::Enabled(
            intent
                .get("enabled")
                .and_then(Value::as_bool)
                .ok_or_else(|| {
                    anyhow!("native player-authority construction automation enabled intent is invalid")
                })?,
        )),
        Some("quantumSupplyEnabled") if intent.len() == 2 => {
            Ok(ConstructionAutomationIntent::QuantumSupplyEnabled(
                intent
                    .get("enabled")
                    .and_then(Value::as_bool)
                    .ok_or_else(|| {
                        anyhow!(
                            "native player-authority construction automation quantum intent is invalid"
                        )
                    })?,
            ))
        }
        Some("targetStock") if intent.len() == 3 => {
            let target_id = intent
                .get("targetId")
                .and_then(Value::as_str)
                .filter(|target_id| {
                    !target_id.is_empty()
                        && target_id.len() <= MAX_PLAYER_ORBIT_ID_BYTES
                        && !target_id.chars().any(char::is_control)
                })
                .ok_or_else(|| {
                    anyhow!(
                        "native player-authority construction automation target ID is invalid"
                    )
                })?;
            let target = safe_json_integer(
                intent.get("target"),
                "construction automation target stock",
            )?;
            Ok(ConstructionAutomationIntent::TargetStock {
                target_id: target_id.to_owned(),
                target,
            })
        }
        Some("batchBuildingTargetStock") if intent.len() == 2 => {
            let target = safe_json_integer(
                intent.get("target"),
                "construction automation batch building target stock",
            )?;
            Ok(ConstructionAutomationIntent::BatchBuildingTargetStock { target })
        }
        _ => bail!("native player-authority construction automation intent fields are invalid"),
    }
}

fn construction_automation_state(state: &CoreState) -> anyhow::Result<&Map<String, Value>> {
    let automation = state
        .base_value()
        .get("constructionAutomation")
        .and_then(Value::as_object)
        .ok_or_else(|| {
            anyhow!("native player-authority construction automation state is missing")
        })?;
    automation
        .get("enabled")
        .and_then(Value::as_bool)
        .ok_or_else(|| {
            anyhow!("native player-authority construction automation enabled state is invalid")
        })?;
    match automation.get("quantumSourceEnabled") {
        None | Some(Value::Bool(_)) => {}
        _ => {
            bail!("native player-authority construction automation quantum source state is invalid")
        }
    }
    automation
        .get("targetStock")
        .and_then(Value::as_object)
        .ok_or_else(|| {
            anyhow!("native player-authority construction automation target directory is invalid")
        })?;
    Ok(automation)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ConstructionAutomationWriteEligibility {
    Available,
    RegistryUnavailable,
    TechnologyLocked,
    CatalogInvalid,
    CenterUnavailable,
}

pub(crate) fn construction_automation_write_eligibility(
    state: &CoreState,
) -> anyhow::Result<ConstructionAutomationWriteEligibility> {
    if state.catalog.snapshot.registry_fingerprint != EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT
        || state.identity.registry_fingerprint != EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT
    {
        return Ok(ConstructionAutomationWriteEligibility::RegistryUnavailable);
    }
    if !technology_is_completed(state, "construction_automation") {
        return Ok(ConstructionAutomationWriteEligibility::TechnologyLocked);
    }
    if state
        .catalog
        .buildings
        .get("construction_center")
        .is_none_or(|building| building.kind != "machine")
        || state
            .catalog
            .constructions
            .get("construction_center")
            .is_none_or(|definition| {
                definition.required_tech_id.as_deref() != Some("construction_automation")
            })
    {
        return Ok(ConstructionAutomationWriteEligibility::CatalogInvalid);
    }
    let mut available = false;
    for entity_index in &state.factory_topology.construction_center_indices {
        let entity = state.parse_entity(*entity_index)?;
        let object = entity.as_object().ok_or_else(|| {
            anyhow!("native player-authority construction automation entity is invalid")
        })?;
        if object.get("buildingId").and_then(Value::as_str) == Some("construction_center")
            && object.get("kind").and_then(Value::as_str) == Some("machine")
            && object.get("interactionLocked").and_then(Value::as_bool) == Some(false)
            && object
                .get("machineCount")
                .and_then(Value::as_u64)
                .is_some_and(|machine_count| {
                    machine_count > 0 && machine_count <= MAX_JAVASCRIPT_SAFE_INTEGER
                })
        {
            available = true;
        }
    }
    Ok(if available {
        ConstructionAutomationWriteEligibility::Available
    } else {
        ConstructionAutomationWriteEligibility::CenterUnavailable
    })
}

fn require_builtin_unlocked_construction_automation(state: &CoreState) -> anyhow::Result<()> {
    match construction_automation_write_eligibility(state)? {
        ConstructionAutomationWriteEligibility::Available => Ok(()),
        ConstructionAutomationWriteEligibility::RegistryUnavailable => {
            bail!("native player-authority construction automation requires the built-in registry")
        }
        ConstructionAutomationWriteEligibility::TechnologyLocked => {
            bail!("native player-authority construction automation technology is locked")
        }
        ConstructionAutomationWriteEligibility::CatalogInvalid => {
            bail!("native player-authority construction automation catalog is invalid")
        }
        ConstructionAutomationWriteEligibility::CenterUnavailable => {
            bail!("native player-authority construction automation center is unavailable")
        }
    }
}

fn construction_automation_stock_limit(state: &CoreState) -> u64 {
    if technology_is_completed(state, "construction_capacity_2") {
        MAX_PLAYER_BUILDING_STACK
    } else if technology_is_completed(state, "construction_capacity_1") {
        500
    } else {
        100
    }
}

fn normalized_construction_automation_target(
    state: &CoreState,
    requested: u64,
) -> anyhow::Result<u64> {
    if requested > MAX_PLAYER_BUILDING_STACK {
        bail!("native player-authority construction automation target exceeds the global limit")
    }
    Ok(requested.min(construction_automation_stock_limit(state)))
}

fn require_construction_automation_batch_target(
    state: &CoreState,
    requested: u64,
) -> anyhow::Result<u64> {
    let stock_limit = construction_automation_stock_limit(state);
    if requested < 1 || requested > stock_limit {
        bail!(
            "native player-authority construction automation batch target must be between 1 and {stock_limit}"
        )
    }
    Ok(requested)
}

fn unlocked_construction_automation_building_target_ids(
    state: &CoreState,
) -> anyhow::Result<Vec<String>> {
    let base = state.base_value();
    let targets = crate::construction_planner::targets(state)
        .into_iter()
        .filter(|target| {
            matches!(
                &target.kind,
                crate::construction_planner::TargetKind::Building
            ) && crate::construction_planner::target_is_unlocked(base, target)
        })
        .map(|target| target.id)
        .collect::<Vec<_>>();
    if targets.is_empty() {
        bail!("native player-authority construction automation has no unlocked building targets")
    }
    Ok(targets)
}

fn validate_construction_automation_target(
    state: &CoreState,
    target_id: &str,
) -> anyhow::Result<()> {
    if matches!(target_id, "logistics_drone" | "logistics_vessel") {
        let item = state
            .catalog
            .items
            .get(target_id)
            .filter(|item| item.kind == "solid")
            .ok_or_else(|| {
                anyhow!("native player-authority construction automation fleet target is invalid")
            })?;
        let recipe = state
            .catalog
            .recipes
            .get(target_id)
            .filter(|recipe| {
                recipe.outputs.iter().any(|output| {
                    output.item_id == item.id && output.amount.is_finite() && output.amount > 0.0
                })
            })
            .ok_or_else(|| {
                anyhow!("native player-authority construction automation fleet recipe is invalid")
            })?;
        if recipe
            .required_tech_id
            .as_deref()
            .is_some_and(|technology_id| !technology_is_completed(state, technology_id))
        {
            bail!("native player-authority construction automation target technology is locked")
        }
        return Ok(());
    }
    let definition = state.catalog.constructions.get(target_id).ok_or_else(|| {
        anyhow!("native player-authority construction automation target is unknown")
    })?;
    if definition
        .required_tech_id
        .as_deref()
        .is_some_and(|technology_id| !technology_is_completed(state, technology_id))
    {
        bail!("native player-authority construction automation target technology is locked")
    }
    if target_id == "orbital_cargo_terminal" {
        let base = state.base_value();
        if base.get("mode").and_then(Value::as_str) != Some("normal")
            || base
                .get("orbitalStation")
                .and_then(Value::as_object)
                .and_then(|station| station.get("status"))
                .and_then(Value::as_str)
                .is_none_or(|status| status == "locked")
        {
            bail!("native player-authority construction automation target mode is locked")
        }
    }
    Ok(())
}

fn validate_construction_automation_intent(
    state: &CoreState,
    command: &SimulationCommandPatch,
) -> anyhow::Result<()> {
    let intent = require_construction_automation_intent(command)?;
    require_builtin_unlocked_construction_automation(state)?;
    let automation = construction_automation_state(state)?;
    match intent {
        ConstructionAutomationIntent::Enabled(target) => {
            let current = automation
                .get("enabled")
                .and_then(Value::as_bool)
                .expect("construction automation enabled was validated above");
            if current == target {
                bail!("native player-authority construction automation enabled target is unchanged")
            }
        }
        ConstructionAutomationIntent::QuantumSupplyEnabled(target) => {
            let current = automation
                .get("quantumSourceEnabled")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            if current == target {
                bail!("native player-authority construction automation quantum target is unchanged")
            }
            if !technology_is_completed(state, "quantum_logistics_network")
                || state
                    .base_value()
                    .get("quantumLogisticsNetwork")
                    .and_then(Value::as_object)
                    .and_then(|network| network.get("enabled"))
                    .and_then(Value::as_bool)
                    != Some(true)
            {
                bail!("native player-authority construction automation quantum network is locked")
            }
        }
        ConstructionAutomationIntent::TargetStock {
            ref target_id,
            target,
        } => {
            validate_construction_automation_target(state, target_id)?;
            let normalized = normalized_construction_automation_target(state, target)?;
            let target_stock = automation
                .get("targetStock")
                .and_then(Value::as_object)
                .expect("construction automation target directory was validated above");
            let current = match target_stock.get(target_id) {
                None => 0,
                Some(value) => {
                    safe_json_integer(Some(value), "current construction automation target stock")?
                }
            };
            if current == normalized {
                bail!("native player-authority construction automation target is unchanged")
            }
        }
        ConstructionAutomationIntent::BatchBuildingTargetStock { target } => {
            let target = require_construction_automation_batch_target(state, target)?;
            let target_stock = automation
                .get("targetStock")
                .and_then(Value::as_object)
                .expect("construction automation target directory was validated above");
            let target_ids = unlocked_construction_automation_building_target_ids(state)?;
            let mut changed = false;
            for target_id in target_ids {
                let current = match target_stock.get(&target_id) {
                    None => 0,
                    Some(value) => safe_json_integer(
                        Some(value),
                        "current construction automation batch building target stock",
                    )?,
                };
                changed |= current != target;
            }
            if !changed {
                bail!("native player-authority construction automation batch target is unchanged")
            }
        }
    }
    Ok(())
}

fn expand_construction_automation_intent(
    state: &CoreState,
    command: &SimulationCommandPatch,
) -> anyhow::Result<SimulationCommandPatch> {
    validate_construction_automation_intent(state, command)?;
    let intent = require_construction_automation_intent(command)?;
    let top_level_changes = match intent {
        ConstructionAutomationIntent::Enabled(enabled) => vec![ValuePatch {
            path: vec![
                PathSegment::Key("constructionAutomation".to_owned()),
                PathSegment::Key("enabled".to_owned()),
            ],
            operation: "set".to_owned(),
            value: Some(Value::from(enabled)),
        }],
        ConstructionAutomationIntent::QuantumSupplyEnabled(enabled) => vec![ValuePatch {
            path: vec![
                PathSegment::Key("constructionAutomation".to_owned()),
                PathSegment::Key("quantumSourceEnabled".to_owned()),
            ],
            operation: if enabled { "set" } else { "delete" }.to_owned(),
            value: enabled.then_some(Value::from(true)),
        }],
        ConstructionAutomationIntent::TargetStock { target_id, target } => {
            let normalized = normalized_construction_automation_target(state, target)?;
            let before = state.base_value();
            let mut derived = before.clone();
            crate::construction::apply_target_stock_policy(
                state,
                &mut derived,
                &target_id,
                normalized,
            )?;
            [
                "constructionAutomation",
                "tray",
                "planetTrays",
                "portableFleet",
                "quantumLogisticsNetwork",
            ]
            .into_iter()
            .filter_map(|root| {
                let previous = before.get(root);
                let next = derived.get(root);
                (previous != next).then(|| ValuePatch {
                    path: vec![PathSegment::Key(root.to_owned())],
                    operation: if next.is_some() { "set" } else { "delete" }.to_owned(),
                    value: next.cloned(),
                })
            })
            .collect()
        }
        ConstructionAutomationIntent::BatchBuildingTargetStock { target } => {
            let target = require_construction_automation_batch_target(state, target)?;
            let target_stock = construction_automation_state(state)?
                .get("targetStock")
                .and_then(Value::as_object)
                .expect("construction automation target directory was validated above");
            unlocked_construction_automation_building_target_ids(state)?
                .into_iter()
                .filter(|target_id| {
                    target_stock
                        .get(target_id)
                        .and_then(Value::as_u64)
                        .unwrap_or(0)
                        != target
                })
                .map(|target_id| ValuePatch {
                    path: vec![
                        PathSegment::Key("constructionAutomation".to_owned()),
                        PathSegment::Key("targetStock".to_owned()),
                        PathSegment::Key(target_id),
                    ],
                    operation: "set".to_owned(),
                    value: Some(Value::from(target)),
                })
                .collect()
        }
    };
    Ok(SimulationCommandPatch {
        protocol_version: command.protocol_version,
        base_revision: command.base_revision,
        top_level_changes,
        changed_entities: Vec::new(),
        added_entities: Vec::new(),
        removed_entity_ids: Vec::new(),
        changed_belts: Vec::new(),
        added_belts: Vec::new(),
        removed_belt_ids: Vec::new(),
    })
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

/// The renderer cannot safely materialize either planet tray while Rust owns
/// the player state. Encode travel as one deliberately non-generic patch:
/// `activePlanetId/<observed-current> = <target>`. The current ID binds the
/// intent to the same projected revision, while the target remains the only
/// requested mutation. `apply_command()` expands this marker from authoritative
/// state as well, so the exact durable WAL payload replays after a cold start.
fn require_active_planet_intent(command: &SimulationCommandPatch) -> anyhow::Result<(&str, &str)> {
    if command.top_level_changes.len() != 1
        || !command.changed_entities.is_empty()
        || !command.added_entities.is_empty()
        || !command.removed_entity_ids.is_empty()
        || !command.changed_belts.is_empty()
        || !command.added_belts.is_empty()
        || !command.removed_belt_ids.is_empty()
    {
        bail!("native player-authority active planet intent shape is invalid")
    }
    let change = &command.top_level_changes[0];
    let [
        PathSegment::Key(root),
        PathSegment::Key(observed_current_id),
    ] = change.path.as_slice()
    else {
        bail!("native player-authority active planet intent path is invalid")
    };
    if root != "activePlanetId" || change.operation != "set" {
        bail!("native player-authority active planet intent path is invalid")
    }
    let target_id = change
        .value
        .as_ref()
        .and_then(Value::as_str)
        .filter(|planet_id| {
            !planet_id.is_empty()
                && planet_id.len() <= MAX_PLAYER_ORBIT_ID_BYTES
                && !planet_id.contains('\0')
        })
        .ok_or_else(|| anyhow!("native player-authority active planet target is invalid"))?;
    if observed_current_id.is_empty()
        || observed_current_id.len() > MAX_PLAYER_ORBIT_ID_BYTES
        || observed_current_id.contains('\0')
    {
        bail!("native player-authority observed active planet is invalid")
    }
    Ok((observed_current_id, target_id))
}

fn validate_active_planet_command(
    state: &CoreState,
    command: &SimulationCommandPatch,
) -> anyhow::Result<()> {
    let (observed_current_id, target_id) = require_active_planet_intent(command)?;
    let base = state.base_value();
    let current_id = base
        .get("activePlanetId")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("native player-authority current active planet is invalid"))?;
    if observed_current_id != current_id {
        bail!("native player-authority observed active planet is stale")
    }
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

    base.get("tray")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("native player-authority active planet tray is invalid"))?;
    let planet_trays = base
        .get("planetTrays")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("native player-authority planet tray directory is invalid"))?;
    if planet_trays
        .get(target_id)
        .is_some_and(|value| !value.is_object())
    {
        bail!("native player-authority target planet tray is invalid")
    }
    if !base.get("metrics").is_some_and(Value::is_object) {
        bail!("native player-authority current planet metrics are missing")
    }
    if !base
        .get("planetMetrics")
        .and_then(Value::as_object)
        .and_then(|metrics| metrics.get(target_id))
        .is_some_and(Value::is_object)
    {
        bail!("native player-authority target planet metrics are missing")
    }
    Ok(())
}

fn command_contains_active_planet_intent(command: &SimulationCommandPatch) -> bool {
    command.top_level_changes.iter().any(|change| {
        matches!(
            change.path.as_slice(),
            [PathSegment::Key(root), PathSegment::Key(_)] if root == "activePlanetId"
        )
    })
}

fn expand_active_planet_intent(
    state: &CoreState,
    command: &SimulationCommandPatch,
) -> anyhow::Result<SimulationCommandPatch> {
    validate_active_planet_command(state, command)?;
    let (current_id, target_id) = require_active_planet_intent(command)?;
    let base = state.base_value();
    let current_tray = base
        .get("tray")
        .and_then(Value::as_object)
        .cloned()
        .ok_or_else(|| anyhow!("native player-authority active planet tray is invalid"))?;
    let target_tray = base
        .get("planetTrays")
        .and_then(Value::as_object)
        .and_then(|trays| trays.get(target_id))
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
    Ok(SimulationCommandPatch {
        protocol_version: command.protocol_version,
        base_revision: command.base_revision,
        top_level_changes: vec![
            ValuePatch {
                path: vec![PathSegment::Key("activePlanetId".to_owned())],
                operation: "set".to_owned(),
                value: Some(Value::from(target_id)),
            },
            ValuePatch {
                path: vec![
                    PathSegment::Key("planetTrays".to_owned()),
                    PathSegment::Key(current_id.to_owned()),
                ],
                operation: "set".to_owned(),
                value: Some(Value::Object(current_tray)),
            },
            ValuePatch {
                path: vec![PathSegment::Key("tray".to_owned())],
                operation: "set".to_owned(),
                value: Some(Value::Object(target_tray)),
            },
            ValuePatch {
                path: vec![PathSegment::Key("metrics".to_owned())],
                operation: "set".to_owned(),
                value: Some(Value::Object(target_metrics)),
            },
        ],
        changed_entities: Vec::new(),
        added_entities: Vec::new(),
        removed_entity_ids: Vec::new(),
        changed_belts: Vec::new(),
        added_belts: Vec::new(),
        removed_belt_ids: Vec::new(),
    })
}

struct ValidatedTimeWarpState<'a> {
    value: &'a Map<String, Value>,
    controller_entity_id: Option<&'a str>,
    enabled: bool,
    requested_multiplier: u64,
    simulation_speed: Value,
    paused: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum TimeWarpIntentTarget {
    Enabled(bool),
    RequestedMultiplier(u64),
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct TimeWarpIntent {
    controller_entity_id: String,
    target: TimeWarpIntentTarget,
}

fn command_contains_time_warp_intent(command: &SimulationCommandPatch) -> bool {
    command
        .top_level_changes
        .iter()
        .any(|change| path_matches(&change.path, &["timeWarp", "intent"]))
}

fn require_time_warp_intent(command: &SimulationCommandPatch) -> anyhow::Result<TimeWarpIntent> {
    if command.top_level_changes.len() != 1
        || !command.changed_entities.is_empty()
        || !command.added_entities.is_empty()
        || !command.removed_entity_ids.is_empty()
        || !command.changed_belts.is_empty()
        || !command.added_belts.is_empty()
        || !command.removed_belt_ids.is_empty()
    {
        bail!("native player-authority time-warp intent shape is invalid")
    }
    let change = &command.top_level_changes[0];
    if !path_matches(&change.path, &["timeWarp", "intent"]) || change.operation != "set" {
        bail!("native player-authority time-warp intent path is invalid")
    }
    let intent = change
        .value
        .as_ref()
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("native player-authority time-warp intent is invalid"))?;
    let controller_entity_id = intent
        .get("controllerEntityId")
        .and_then(Value::as_str)
        .filter(|entity_id| !entity_id.is_empty() && entity_id.len() <= MAX_PLAYER_ORBIT_ID_BYTES)
        .ok_or_else(|| anyhow!("native player-authority time-warp controller intent is invalid"))?
        .to_owned();
    let target = match (intent.get("enabled"), intent.get("requestedMultiplier")) {
        (Some(enabled), None) if intent.len() == 2 => {
            TimeWarpIntentTarget::Enabled(enabled.as_bool().ok_or_else(|| {
                anyhow!("native player-authority time-warp enabled intent is invalid")
            })?)
        }
        (None, Some(multiplier)) if intent.len() == 2 => {
            let multiplier = safe_json_integer(Some(multiplier), "time-warp requested multiplier")?;
            TimeWarpIntentTarget::RequestedMultiplier(multiplier)
        }
        _ => bail!("native player-authority time-warp intent fields are invalid"),
    };
    Ok(TimeWarpIntent {
        controller_entity_id,
        target,
    })
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
    let active_planet_id = state
        .base_value()
        .get("activePlanetId")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("native player-authority active planet is invalid"))?;
    if !state
        .catalog
        .planets
        .iter()
        .any(|planet| planet.id == active_planet_id)
    {
        bail!("native player-authority active planet is not in the catalog")
    }
    let index = *state
        .entity_index
        .get(entity_id)
        .ok_or_else(|| anyhow!("native player-authority time-warp controller is missing"))?;
    let entity = state.parse_entity(index)?;
    let object = entity
        .as_object()
        .ok_or_else(|| anyhow!("native player-authority time-warp controller is invalid"))?;
    if object.get("planetId").and_then(Value::as_str) != Some(active_planet_id) {
        bail!("native player-authority time-warp controller is not on the active planet")
    }
    if object.get("kind").and_then(Value::as_str) != Some("machine")
        || object.get("buildingId").and_then(Value::as_str) != Some("time_warp_device")
        || state
            .catalog
            .buildings
            .get("time_warp_device")
            .is_none_or(|building| building.kind != "machine")
    {
        bail!("native player-authority time-warp controller building is invalid")
    }
    if object.get("interactionLocked").and_then(Value::as_bool) != Some(false) {
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

fn validate_time_warp_intent(
    state: &CoreState,
    command: &SimulationCommandPatch,
) -> anyhow::Result<()> {
    let intent = require_time_warp_intent(command)?;
    if state.catalog.snapshot.registry_fingerprint != EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT
        || state.identity.registry_fingerprint != EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT
    {
        bail!("native player-authority time-warp intent requires the built-in registry")
    }
    let current = validated_time_warp_state(state)?;
    if current.controller_entity_id != Some(intent.controller_entity_id.as_str()) {
        bail!("native player-authority time-warp controller intent is stale")
    }
    require_unlocked_time_warp_controller(state, &intent.controller_entity_id)?;
    match intent.target {
        TimeWarpIntentTarget::Enabled(target) => {
            if current.enabled == target {
                bail!("native player-authority time-warp enabled target is unchanged")
            }
        }
        TimeWarpIntentTarget::RequestedMultiplier(target) => {
            if target < 5 || target == current.requested_multiplier {
                bail!("native player-authority time-warp requested multiplier target is invalid")
            }
        }
    }
    Ok(())
}

fn expand_time_warp_intent(
    state: &CoreState,
    command: &SimulationCommandPatch,
) -> anyhow::Result<SimulationCommandPatch> {
    validate_time_warp_intent(state, command)?;
    let intent = require_time_warp_intent(command)?;
    let current = validated_time_warp_state(state)?;
    let mut expected = Vec::<(Vec<&'static str>, Value)>::new();
    match intent.target {
        TimeWarpIntentTarget::Enabled(target) => {
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
        }
        TimeWarpIntentTarget::RequestedMultiplier(target) => {
            expected.push((vec!["timeWarp", "requestedMultiplier"], Value::from(target)))
        }
    }
    Ok(SimulationCommandPatch {
        protocol_version: command.protocol_version,
        base_revision: command.base_revision,
        top_level_changes: expected
            .into_iter()
            .map(|(path, value)| ValuePatch {
                path: path
                    .into_iter()
                    .map(|segment| PathSegment::Key(segment.to_owned()))
                    .collect(),
                operation: "set".to_owned(),
                value: Some(value),
            })
            .collect(),
        changed_entities: Vec::new(),
        added_entities: Vec::new(),
        removed_entity_ids: Vec::new(),
        changed_belts: Vec::new(),
        added_belts: Vec::new(),
        removed_belt_ids: Vec::new(),
    })
}

fn validate_time_warp_command(
    state: &CoreState,
    command: &SimulationCommandPatch,
) -> anyhow::Result<()> {
    if command_contains_time_warp_intent(command) {
        return validate_time_warp_intent(state, command);
    }
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
    if state.catalog.snapshot.registry_fingerprint != EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT
        || state.identity.registry_fingerprint != EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT
    {
        bail!("native player-authority time-warp command requires the built-in registry")
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

#[derive(Debug)]
struct PlayerResearchCommandState {
    completed: HashSet<String>,
    selected: Option<String>,
    paused: Option<String>,
    queue: Vec<String>,
    planned: HashSet<String>,
    selected_completion_due: bool,
    active_infinite: Option<String>,
    auto_research: bool,
}

fn player_research_id(value: &Value, label: &str) -> anyhow::Result<String> {
    value
        .as_str()
        .filter(|id| !id.is_empty() && id.len() <= 1_024)
        .map(str::to_owned)
        .ok_or_else(|| anyhow!("native player-authority {label} is invalid"))
}

fn player_optional_research_id(
    record: &Map<String, Value>,
    key: &str,
) -> anyhow::Result<Option<String>> {
    match record.get(key) {
        Some(Value::Null) => Ok(None),
        Some(value) => player_research_id(value, key).map(Some),
        None => bail!("native player-authority research {key} is missing"),
    }
}

fn player_research_id_array(value: &Value, label: &str) -> anyhow::Result<Vec<String>> {
    let values = value
        .as_array()
        .filter(|values| values.len() <= MAX_PLAYER_TECHNOLOGY_ROWS)
        .ok_or_else(|| anyhow!("native player-authority {label} is invalid"))?;
    let mut unique = HashSet::with_capacity(values.len());
    let mut result = Vec::with_capacity(values.len());
    for value in values {
        let id = player_research_id(value, label)?;
        if !unique.insert(id.clone()) {
            bail!("native player-authority {label} repeats a technology")
        }
        result.push(id);
    }
    Ok(result)
}

fn player_active_technology<'a>(
    state: &'a CoreState,
    technology_id: &str,
) -> anyhow::Result<&'a crate::catalog::TechnologyDefinition> {
    let technology = state
        .catalog
        .technologies
        .get(technology_id)
        .ok_or_else(|| anyhow!("native player-authority research technology is unknown"))?;
    if DEPRECATED_PLAYER_TECHNOLOGIES.contains(&technology_id) {
        bail!("native player-authority research technology is deprecated")
    }
    Ok(technology)
}

fn validate_player_research_progress(
    state: &CoreState,
    research: &Map<String, Value>,
) -> anyhow::Result<()> {
    let progress = research
        .get("progressByTech")
        .and_then(Value::as_object)
        .filter(|rows| rows.len() <= MAX_PLAYER_TECHNOLOGY_ROWS)
        .ok_or_else(|| anyhow!("native player-authority research progress is invalid"))?;
    for (technology_id, row) in progress {
        if !state.catalog.technologies.contains_key(technology_id) {
            bail!("native player-authority research progress technology is unknown")
        }
        let row = row
            .as_object()
            .filter(|row| row.len() <= 16)
            .ok_or_else(|| anyhow!("native player-authority research progress row is invalid"))?;
        for (item_id, amount) in row {
            if !state.catalog.items.contains_key(item_id) {
                bail!("native player-authority research progress item is unknown")
            }
            safe_json_integer(Some(amount), "research progress amount")?;
        }
    }
    Ok(())
}

fn player_technology_cost(amount: f64) -> anyhow::Result<u64> {
    if !amount.is_finite()
        || amount <= 0.0
        || amount.fract() != 0.0
        || amount > MAX_JAVASCRIPT_SAFE_INTEGER as f64
    {
        bail!("native player-authority research technology cost is invalid")
    }
    Ok(amount as u64)
}

fn selected_player_research_completion_due(
    state: &CoreState,
    research: &Map<String, Value>,
    technology_id: &str,
) -> anyhow::Result<bool> {
    let technology = player_active_technology(state, technology_id)?;
    let progress = research
        .get("progressByTech")
        .and_then(Value::as_object)
        .and_then(|rows| rows.get(technology_id))
        .and_then(Value::as_object);
    for cost in &technology.costs {
        let required = player_technology_cost(cost.amount)?;
        let invested = match progress.and_then(|row| row.get(&cost.item_id)) {
            Some(value) => safe_json_integer(Some(value), "research progress amount")?,
            None => 0,
        };
        if invested < required {
            return Ok(false);
        }
    }
    Ok(true)
}

fn validate_player_infinite_research_state(
    endgame: &Map<String, Value>,
) -> anyhow::Result<(Option<String>, bool)> {
    let active = player_optional_research_id(endgame, "activeInfiniteResearchId")?;
    if active
        .as_deref()
        .is_some_and(|research_id| !crate::infinite_research::valid_id(research_id))
    {
        bail!("native player-authority infinite research target is unknown")
    }
    let auto_research = endgame
        .get("autoResearch")
        .and_then(Value::as_bool)
        .ok_or_else(|| {
            anyhow!("native player-authority infinite research automation is invalid")
        })?;
    let progress = endgame
        .get("infiniteResearch")
        .and_then(Value::as_object)
        .filter(|rows| rows.len() == 5)
        .ok_or_else(|| anyhow!("native player-authority infinite research directory is invalid"))?;
    for (research_id, row) in progress {
        if !crate::infinite_research::valid_id(research_id) {
            bail!("native player-authority infinite research directory contains an unknown ID")
        }
        let row = row
            .as_object()
            .ok_or_else(|| anyhow!("native player-authority infinite research row is invalid"))?;
        safe_json_integer(row.get("level"), "infinite research level")?;
        if let Some(historical_level) = row.get("historicalLevel").filter(|value| !value.is_null())
        {
            safe_json_integer(Some(historical_level), "infinite research historical level")?;
        }
        let progress = row
            .get("progress")
            .and_then(Value::as_str)
            .filter(|value| {
                !value.is_empty()
                    && value.len() <= 1_024
                    && value.bytes().all(|byte| byte.is_ascii_digit())
                    && (value.len() == 1 || !value.starts_with('0'))
            })
            .ok_or_else(|| {
                anyhow!("native player-authority infinite research progress is invalid")
            })?;
        progress.parse::<u128>().map_err(|_| {
            anyhow!("native player-authority infinite research progress is too large")
        })?;
    }
    Ok((active, auto_research))
}

fn validated_player_research_state(
    state: &CoreState,
) -> anyhow::Result<PlayerResearchCommandState> {
    if state.catalog.snapshot.registry_fingerprint != EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT
        || state.identity.registry_fingerprint != EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT
    {
        bail!("native player-authority research commands require the built-in catalog")
    }
    let research = state
        .base_value()
        .get("research")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("native player-authority research state is invalid"))?;
    validate_player_research_progress(state, research)?;
    let completed_rows = player_research_id_array(
        research
            .get("completedTechIds")
            .ok_or_else(|| anyhow!("native player-authority completed research is missing"))?,
        "completed research",
    )?;
    let completed = completed_rows.iter().cloned().collect::<HashSet<_>>();
    for technology_id in &completed_rows {
        if !state.catalog.technologies.contains_key(technology_id) {
            bail!("native player-authority completed research technology is unknown")
        }
    }
    let selected = player_optional_research_id(research, "selectedTechId")?;
    let paused = player_optional_research_id(research, "pausedTechId")?;
    if selected.is_some() && selected == paused {
        bail!("native player-authority selected and paused research overlap")
    }
    for technology_id in [selected.as_deref(), paused.as_deref()]
        .into_iter()
        .flatten()
    {
        let technology = player_active_technology(state, technology_id)?;
        if completed.contains(technology_id)
            || !technology
                .prerequisites
                .iter()
                .all(|prerequisite| completed.contains(prerequisite))
        {
            bail!("native player-authority current research prerequisites are invalid")
        }
    }

    let queue = player_research_id_array(
        research
            .get("queuedTechIds")
            .ok_or_else(|| anyhow!("native player-authority research queue is missing"))?,
        "research queue",
    )?;
    let mut planned = completed.clone();
    if let Some(technology_id) = &paused {
        planned.insert(technology_id.clone());
    }
    if let Some(technology_id) = &selected {
        planned.insert(technology_id.clone());
    }
    for technology_id in &queue {
        let technology = player_active_technology(state, technology_id)?;
        if planned.contains(technology_id)
            || !technology
                .prerequisites
                .iter()
                .all(|prerequisite| planned.contains(prerequisite))
        {
            bail!("native player-authority research queue dependencies are invalid")
        }
        planned.insert(technology_id.clone());
    }

    let selected_completion_due = selected
        .as_deref()
        .map(|technology_id| {
            selected_player_research_completion_due(state, research, technology_id)
        })
        .transpose()?
        .unwrap_or(false);
    let endgame = state
        .base_value()
        .get("endgame")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("native player-authority endgame state is invalid"))?;
    let (active_infinite, auto_research) = validate_player_infinite_research_state(endgame)?;
    Ok(PlayerResearchCommandState {
        completed,
        selected,
        paused,
        queue,
        planned,
        selected_completion_due,
        active_infinite,
        auto_research,
    })
}

fn player_queue_after_removal(
    state: &CoreState,
    current: &PlayerResearchCommandState,
    removed_id: &str,
) -> anyhow::Result<Vec<String>> {
    let mut planned = current.completed.clone();
    if let Some(technology_id) = &current.paused {
        planned.insert(technology_id.clone());
    }
    if let Some(technology_id) = &current.selected {
        planned.insert(technology_id.clone());
    }
    let mut result = Vec::with_capacity(current.queue.len().saturating_sub(1));
    for technology_id in &current.queue {
        if technology_id == removed_id {
            continue;
        }
        let technology = player_active_technology(state, technology_id)?;
        if !technology
            .prerequisites
            .iter()
            .all(|prerequisite| planned.contains(prerequisite))
        {
            continue;
        }
        result.push(technology_id.clone());
        planned.insert(technology_id.clone());
    }
    Ok(result)
}

fn player_infinite_research_is_complete(
    state: &CoreState,
    research_id: &str,
) -> anyhow::Result<bool> {
    let level = state
        .base_value()
        .get("endgame")
        .and_then(Value::as_object)
        .and_then(|endgame| endgame.get("infiniteResearch"))
        .and_then(Value::as_object)
        .and_then(|research| research.get(research_id))
        .and_then(Value::as_object)
        .and_then(|progress| progress.get("level"))
        .ok_or_else(|| anyhow!("native player-authority infinite research row is missing"))?;
    let level = safe_json_integer(Some(level), "infinite research level")?;
    Ok(crate::infinite_research::maximum_level(research_id)
        .is_some_and(|maximum| level >= u64::from(maximum)))
}

fn player_research_transition_intent(
    command: &SimulationCommandPatch,
) -> anyhow::Result<Option<crate::simple_factory::PlayerResearchTransition>> {
    if command.top_level_changes.len() != 1 {
        return Ok(None);
    }
    let change = &command.top_level_changes[0];
    if change.operation != "set" {
        return Ok(None);
    }
    let Some(value) = change.value.as_ref() else {
        return Ok(None);
    };
    match change.path.as_slice() {
        [PathSegment::Key(root), PathSegment::Key(field)]
            if root == "research" && field == "selectedTechId" =>
        {
            Ok(Some(match value {
                Value::Null => crate::simple_factory::PlayerResearchTransition::CancelCurrent,
                Value::String(technology_id) => {
                    crate::simple_factory::PlayerResearchTransition::SelectFinite(
                        technology_id.clone(),
                    )
                }
                _ => bail!("native player-authority finite research target is invalid"),
            }))
        }
        [PathSegment::Key(root), PathSegment::Key(field)]
            if root == "research" && field == "pausedTechId" =>
        {
            player_research_id(value, "paused research target")?;
            Ok(Some(
                crate::simple_factory::PlayerResearchTransition::PauseCurrent,
            ))
        }
        [PathSegment::Key(root), PathSegment::Key(field)]
            if root == "endgame" && field == "activeInfiniteResearchId" =>
        {
            Ok(Some(
                crate::simple_factory::PlayerResearchTransition::SelectInfinite(match value {
                    Value::Null => None,
                    Value::String(research_id) => Some(research_id.clone()),
                    _ => bail!("native player-authority infinite research target is invalid"),
                }),
            ))
        }
        _ => Ok(None),
    }
}

fn command_contains_player_research_transition_intent(command: &SimulationCommandPatch) -> bool {
    command.top_level_changes.iter().any(|change| {
        matches!(
            change.path.as_slice(),
            [PathSegment::Key(root), PathSegment::Key(field)]
                if (root == "research" && matches!(field.as_str(), "selectedTechId" | "pausedTechId"))
                    || (root == "endgame" && field == "activeInfiniteResearchId")
        )
    })
}

fn expand_player_research_transition_intent(
    state: &CoreState,
    command: &SimulationCommandPatch,
) -> anyhow::Result<SimulationCommandPatch> {
    validate_player_research_command(state, command)?;
    let transition = player_research_transition_intent(command)?
        .ok_or_else(|| anyhow!("native player-authority research transition intent is missing"))?;
    let mut candidate_base = state.base_value().clone();
    let mut candidate_entities = state.parse_entities_parallel()?;
    let reset_rows = candidate_entities
        .iter()
        .enumerate()
        .filter(|(_, entity)| {
            entity.get("recipeId").and_then(Value::as_str) == Some("matrix_research")
        })
        .map(|(index, entity)| {
            (
                index,
                entity.get("id").and_then(Value::as_str).map(str::to_owned),
                entity.get("progress").cloned(),
            )
        })
        .collect::<Vec<_>>();
    crate::simple_factory::apply_player_research_transition(
        state,
        &mut candidate_base,
        &mut candidate_entities,
        &transition,
    )?;

    let mut top_level_changes = Vec::new();
    for root in ["research", "endgame", "construction", "exploration"] {
        let before = state.base_value().get(root);
        let after = candidate_base.get(root).ok_or_else(|| {
            anyhow!("native player-authority research transition root is missing")
        })?;
        if before != Some(after) {
            top_level_changes.push(ValuePatch {
                path: vec![PathSegment::Key(root.to_owned())],
                operation: "set".to_owned(),
                value: Some(after.clone()),
            });
        }
    }

    let mut changed_entities = Vec::new();
    for (index, entity_id, before_progress) in reset_rows {
        let entity_id = entity_id
            .ok_or_else(|| anyhow!("native player-authority research entity ID is missing"))?;
        let after_progress = candidate_entities[index]
            .get("progress")
            .cloned()
            .ok_or_else(|| anyhow!("native player-authority research progress reset is missing"))?;
        if before_progress.as_ref() == Some(&after_progress) {
            continue;
        }
        changed_entities.push(RecordPatch {
            id: entity_id,
            changes: vec![ValuePatch {
                path: vec![PathSegment::Key("progress".to_owned())],
                operation: "set".to_owned(),
                value: Some(after_progress),
            }],
        });
    }

    if top_level_changes.is_empty() && changed_entities.is_empty() {
        bail!("native player-authority research transition target is unchanged")
    }
    Ok(SimulationCommandPatch {
        protocol_version: command.protocol_version,
        base_revision: command.base_revision,
        top_level_changes,
        changed_entities,
        added_entities: Vec::new(),
        removed_entity_ids: Vec::new(),
        changed_belts: Vec::new(),
        added_belts: Vec::new(),
        removed_belt_ids: Vec::new(),
    })
}

/// Research lifecycle commands are renderer-minimal semantic intents. Rust
/// validates the complete transition and re-derives every matrix-lab reset;
/// entity IDs and completion rewards never come from the renderer.
fn validate_player_research_command(
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
        bail!("native player-authority research command shape is invalid")
    }
    let current = validated_player_research_state(state)?;
    let change = &command.top_level_changes[0];
    if change.operation != "set" {
        bail!("native player-authority research command operation is invalid")
    }
    let target = change
        .value
        .as_ref()
        .ok_or_else(|| anyhow!("native player-authority research command target is missing"))?;
    if path_matches(&change.path, &["research", "queuedTechIds"]) {
        let target_queue = player_research_id_array(target, "research queue target")?;
        if target_queue == current.queue {
            bail!("native player-authority research queue target is unchanged")
        }

        if target_queue.len() == current.queue.len() + 1
            && target_queue[..current.queue.len()] == current.queue
        {
            let target_id = target_queue
                .last()
                .expect("one research queue row was appended");
            let technology = player_active_technology(state, target_id)?;
            if current.selected.is_none()
                || current.active_infinite.is_some()
                || current.selected_completion_due
                || current.completed.contains(target_id)
                || current.paused.as_deref() == Some(target_id)
                || current.planned.contains(target_id)
                || !technology
                    .prerequisites
                    .iter()
                    .all(|prerequisite| current.planned.contains(prerequisite))
            {
                bail!("native player-authority research queue append is not currently legal")
            }
            return Ok(());
        }

        let matches_removal = current.queue.iter().any(|removed_id| {
            player_queue_after_removal(state, &current, removed_id)
                .is_ok_and(|expected| expected == target_queue)
        });
        if !matches_removal {
            bail!("native player-authority research queue removal is not canonical")
        }
        return Ok(());
    }

    if path_matches(&change.path, &["endgame", "autoResearch"]) {
        let enabled = target.as_bool().ok_or_else(|| {
            anyhow!("native player-authority infinite automation target is invalid")
        })?;
        if !current.completed.contains("universe_matrix") {
            bail!("native player-authority infinite automation technology is locked")
        }
        if enabled == current.auto_research {
            bail!("native player-authority infinite automation target is unchanged")
        }
        return Ok(());
    }

    if path_matches(&change.path, &["research", "pausedTechId"]) {
        let target_id = player_research_id(target, "paused research target")?;
        if current.selected.as_deref() != Some(target_id.as_str()) {
            bail!("native player-authority research pause target is not active")
        }
        return Ok(());
    }

    if path_matches(&change.path, &["research", "selectedTechId"]) {
        if target.is_null() {
            if current.selected.is_none() && current.active_infinite.is_none() {
                bail!("native player-authority research cancel has no active target")
            }
            return Ok(());
        }
        let target_id = player_research_id(target, "finite research target")?;
        let technology = player_active_technology(state, &target_id)?;
        if current.selected.is_some()
            || current.active_infinite.is_some()
            || current.completed.contains(&target_id)
            || current.queue.iter().any(|queued| queued == &target_id)
            || !technology
                .prerequisites
                .iter()
                .all(|prerequisite| current.completed.contains(prerequisite))
        {
            bail!("native player-authority finite research selection is not currently legal")
        }
        return Ok(());
    }

    if path_matches(&change.path, &["endgame", "activeInfiniteResearchId"]) {
        if target.is_null() {
            if current.active_infinite.is_none() || current.selected.is_some() {
                bail!("native player-authority infinite research stop is not independently active")
            }
            return Ok(());
        }
        let target_id = player_research_id(target, "infinite research target")?;
        if !crate::infinite_research::valid_id(&target_id)
            || !current.completed.contains("universe_matrix")
            || current.selected.is_some()
            || current.active_infinite.as_deref() == Some(target_id.as_str())
            || player_infinite_research_is_complete(state, &target_id)?
        {
            bail!("native player-authority infinite research selection is not currently legal")
        }
        return Ok(());
    }

    bail!("native player-authority research transition is not canonical")
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
    let _target = require_exact_set_patch(&command.top_level_changes, &["paused"])?
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
    // Pause and resume change both GameState and the private durable clock
    // lease. A renderer-shaped gameplay command cannot prove that paired
    // transition, even when it happens to request the current value.
    bail!("native player-authority pause transition is not owned by this command path")
}

fn canonical_player_quantum_capacity<'a>(
    value: Option<&'a Value>,
    label: &str,
) -> anyhow::Result<&'a str> {
    let value = value
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("native player-authority {label} is not a decimal string"))?;
    if value.is_empty()
        || value.len() > PLAYER_QUANTUM_CAPACITY_MAX.len()
        || !value.bytes().all(|byte| byte.is_ascii_digit())
        || value.len() > 1 && value.starts_with('0')
    {
        bail!("native player-authority {label} is not canonical")
    }
    let at_least_min = value.len() > PLAYER_QUANTUM_CAPACITY_MIN.len()
        || value.len() == PLAYER_QUANTUM_CAPACITY_MIN.len() && value >= PLAYER_QUANTUM_CAPACITY_MIN;
    let at_most_max = value.len() < PLAYER_QUANTUM_CAPACITY_MAX.len()
        || value.len() == PLAYER_QUANTUM_CAPACITY_MAX.len() && value <= PLAYER_QUANTUM_CAPACITY_MAX;
    if !at_least_min || !at_most_max {
        bail!("native player-authority {label} is outside the allowed range")
    }
    Ok(value)
}

fn validate_quantum_item_capacity_command(
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
        bail!("native player-authority quantum capacity command shape is invalid")
    }
    let change = &command.top_level_changes[0];
    let [
        PathSegment::Key(root),
        PathSegment::Key(directory),
        PathSegment::Key(item_id),
    ] = change.path.as_slice()
    else {
        bail!("native player-authority quantum capacity path is invalid")
    };
    if root != "quantumLogisticsNetwork" || directory != "itemCapacities" {
        bail!("native player-authority quantum capacity path is invalid")
    }
    if change.operation != "set" {
        bail!("native player-authority quantum capacity operation is invalid")
    }
    if !state.catalog.items.contains_key(item_id) {
        bail!("native player-authority quantum capacity item is unknown")
    }
    let target =
        canonical_player_quantum_capacity(change.value.as_ref(), "quantum capacity target")?;
    let capacities = state
        .base_value()
        .get("quantumLogisticsNetwork")
        .and_then(Value::as_object)
        .and_then(|network| network.get("itemCapacities"))
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("native player-authority quantum capacity state is invalid"))?;
    let current = match capacities.get(item_id) {
        Some(value) => canonical_player_quantum_capacity(Some(value), "current quantum capacity")?,
        None => PLAYER_QUANTUM_CAPACITY_MAX,
    };
    if current == target {
        bail!("native player-authority quantum capacity target is unchanged")
    }
    Ok(())
}

fn validate_dyson_launch_configuration_command(
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
        bail!("native player-authority Dyson launch command shape is invalid")
    }
    let change = &command.top_level_changes[0];
    if change.operation != "set" {
        bail!("native player-authority Dyson launch command operation is invalid")
    }
    let value = change
        .value
        .as_ref()
        .ok_or_else(|| anyhow!("native player-authority Dyson launch command has no value"))?;
    let engineering = state
        .base_value()
        .get("dysonEngineering")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("native player-authority Dyson engineering state is invalid"))?;

    match change.path.as_slice() {
        [PathSegment::Key(root), PathSegment::Key(field)]
            if root == "dysonEngineering" && field == "launchMode" =>
        {
            let current = engineering
                .get("launchMode")
                .and_then(Value::as_str)
                .filter(|mode| matches!(*mode, "balanced" | "swarm" | "sphere"))
                .ok_or_else(|| {
                    anyhow!("native player-authority current Dyson launch mode is invalid")
                })?;
            let target = value
                .as_str()
                .filter(|mode| matches!(*mode, "balanced" | "swarm" | "sphere"))
                .ok_or_else(|| anyhow!("native player-authority Dyson launch mode is invalid"))?;
            if target == current {
                bail!("native player-authority Dyson launch mode is unchanged")
            }
        }
        [PathSegment::Key(root), PathSegment::Key(field)]
            if root == "dysonEngineering" && field == "launchThrottle" =>
        {
            let valid_throttle = |value: f64| matches!(value, 0.25 | 0.5 | 0.75 | 1.0);
            let current = finite_json_number(
                engineering.get("launchThrottle"),
                "current Dyson launch throttle",
            )?;
            let target = finite_json_number(Some(value), "Dyson launch throttle")?;
            if !valid_throttle(current) || !valid_throttle(target) {
                bail!("native player-authority Dyson launch throttle is invalid")
            }
            if target == current {
                bail!("native player-authority Dyson launch throttle is unchanged")
            }
        }
        [PathSegment::Key(root), PathSegment::Key(field)]
            if root == "dysonEngineering" && field == "launchEnabled" =>
        {
            let current = engineering
                .get("launchEnabled")
                .and_then(Value::as_bool)
                .ok_or_else(|| {
                    anyhow!("native player-authority current Dyson launch enabled state is invalid")
                })?;
            let target = value.as_bool().ok_or_else(|| {
                anyhow!("native player-authority Dyson launch enabled state is invalid")
            })?;
            if target == current {
                bail!("native player-authority Dyson launch enabled state is unchanged")
            }
        }
        [
            PathSegment::Key(root),
            PathSegment::Key(directory),
            PathSegment::Key(system_id),
        ] if root == "dysonEngineering" && directory == "activeOrbitBySystem" => {
            let target = value
                .as_str()
                .filter(|orbit_id| {
                    !orbit_id.is_empty() && orbit_id.len() <= MAX_PLAYER_ORBIT_ID_BYTES
                })
                .ok_or_else(|| {
                    anyhow!("native player-authority active Dyson orbit ID is invalid")
                })?;
            let current = engineering
                .get("activeOrbitBySystem")
                .and_then(Value::as_object)
                .and_then(|systems| systems.get(system_id))
                .and_then(Value::as_str)
                .filter(|orbit_id| {
                    !orbit_id.is_empty() && orbit_id.len() <= MAX_PLAYER_ORBIT_ID_BYTES
                })
                .ok_or_else(|| {
                    anyhow!("native player-authority current active Dyson orbit is invalid")
                })?;
            if target == current {
                bail!("native player-authority active Dyson orbit is unchanged")
            }
            let orbits = engineering
                .get("orbitsBySystem")
                .and_then(Value::as_object)
                .and_then(|systems| systems.get(system_id))
                .and_then(Value::as_array)
                .ok_or_else(|| {
                    anyhow!("native player-authority Dyson orbit directory is invalid")
                })?;
            if !orbits
                .iter()
                .any(|orbit| orbit.get("id").and_then(Value::as_str) == Some(target))
            {
                bail!("native player-authority active Dyson orbit is outside its stellar system")
            }
        }
        _ => bail!("native player-authority Dyson launch patch path is not canonical"),
    }
    Ok(())
}

fn validate_dyson_orbit_geometry_command(
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
        bail!("native player-authority Dyson orbit geometry command shape is invalid")
    }
    let engineering = state
        .base_value()
        .get("dysonEngineering")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("native player-authority Dyson engineering state is invalid"))?;
    let systems = engineering
        .get("orbitsBySystem")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("native player-authority Dyson orbit directory is invalid"))?;
    let mut command_target: Option<(&str, usize)> = None;
    let mut fields = HashSet::new();

    for change in &command.top_level_changes {
        let (system_id, orbit_index, field) = match change.path.as_slice() {
            [
                PathSegment::Key(root),
                PathSegment::Key(directory),
                PathSegment::Key(system_id),
                PathSegment::Index(orbit_index),
                PathSegment::Key(field),
            ] if root == "dysonEngineering"
                && directory == "orbitsBySystem"
                && matches!(field.as_str(), "radius" | "inclination" | "longitude") =>
            {
                (system_id.as_str(), *orbit_index, field.as_str())
            }
            _ => {
                bail!("native player-authority Dyson orbit geometry patch path is not canonical")
            }
        };
        if command_target.is_some_and(|target| target != (system_id, orbit_index)) {
            bail!("native player-authority Dyson orbit geometry command spans multiple orbits")
        }
        command_target = Some((system_id, orbit_index));
        if !fields.insert(field) || change.operation != "set" || change.value.is_none() {
            bail!("native player-authority Dyson orbit geometry field is repeated or invalid")
        }
    }

    let (system_id, orbit_index) = command_target
        .ok_or_else(|| anyhow!("native player-authority Dyson orbit geometry target is missing"))?;
    if !state
        .catalog
        .planets
        .iter()
        .any(|planet| planet.system_id == system_id)
    {
        bail!("native player-authority Dyson orbit geometry system is unknown")
    }
    let orbit = systems
        .get(system_id)
        .and_then(Value::as_array)
        .and_then(|orbits| orbits.get(orbit_index))
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("native player-authority Dyson orbit geometry target is missing"))?;
    orbit
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty() && id.len() <= MAX_PLAYER_ORBIT_ID_BYTES)
        .ok_or_else(|| anyhow!("native player-authority Dyson orbit geometry ID is invalid"))?;

    let valid_geometry = |field: &str, value: f64| match field {
        "radius" => value.fract() == 0.0 && (5_000.0..=50_000.0).contains(&value),
        "inclination" => value.fract() == 0.0 && (-90.0..=90.0).contains(&value),
        "longitude" => {
            (0.0..360.0).contains(&value) && (value * 10.0 - (value * 10.0).round()).abs() < 1e-9
        }
        _ => false,
    };
    for change in &command.top_level_changes {
        let field = match change.path.last() {
            Some(PathSegment::Key(field)) => field.as_str(),
            _ => unreachable!("canonical Dyson orbit path was already checked"),
        };
        let current = finite_json_number(orbit.get(field), "current Dyson orbit geometry")?;
        let target = finite_json_number(change.value.as_ref(), "Dyson orbit geometry")?;
        if !valid_geometry(field, current) || !valid_geometry(field, target) {
            bail!("native player-authority Dyson orbit geometry is outside its canonical range")
        }
        if target == current {
            bail!("native player-authority Dyson orbit geometry is unchanged")
        }
    }
    Ok(())
}

fn validate_active_dyson_layer_command(
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
        bail!("native player-authority active Dyson layer command shape is invalid")
    }
    let change = &command.top_level_changes[0];
    let system_id = match change.path.as_slice() {
        [
            PathSegment::Key(root),
            PathSegment::Key(system_id),
            PathSegment::Key(field),
        ] if root == "dysonPlans" && field == "activeLayerId" => system_id.as_str(),
        _ => bail!("native player-authority active Dyson layer path is not canonical"),
    };
    let target = change
        .value
        .as_ref()
        .filter(|_| change.operation == "set")
        .and_then(Value::as_str)
        .filter(|layer_id| !layer_id.is_empty() && layer_id.len() <= MAX_PLAYER_ORBIT_ID_BYTES)
        .ok_or_else(|| anyhow!("native player-authority active Dyson layer ID is invalid"))?;
    if !state
        .catalog
        .planets
        .iter()
        .any(|planet| planet.system_id == system_id)
    {
        bail!("native player-authority active Dyson layer system is unknown")
    }
    let plan = state
        .base_value()
        .get("dysonPlans")
        .and_then(Value::as_object)
        .and_then(|plans| plans.get(system_id))
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("native player-authority Dyson plan is missing"))?;
    let current = match plan.get("activeLayerId") {
        Some(Value::Null) => None,
        Some(Value::String(layer_id))
            if !layer_id.is_empty() && layer_id.len() <= MAX_PLAYER_ORBIT_ID_BYTES =>
        {
            Some(layer_id.as_str())
        }
        _ => bail!("native player-authority current active Dyson layer is invalid"),
    };
    if current == Some(target) {
        bail!("native player-authority active Dyson layer is unchanged")
    }
    let layers = plan
        .get("layers")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("native player-authority Dyson layer directory is invalid"))?;
    if !layers
        .iter()
        .any(|layer| layer.get("id").and_then(Value::as_str) == Some(target))
    {
        bail!("native player-authority active Dyson layer is outside its stellar system")
    }
    Ok(())
}

fn player_planet_industry_role_is_valid(role: &str) -> bool {
    matches!(
        role,
        "auto"
            | "mining"
            | "smelting"
            | "manufacturing"
            | "chemical"
            | "research"
            | "logistics"
            | "power"
    )
}

fn validate_planet_industry_role_command(
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
        bail!("native player-authority planet industry role command shape is invalid")
    }
    let change = &command.top_level_changes[0];
    let planet_id = match change.path.as_slice() {
        [
            PathSegment::Key(root),
            PathSegment::Key(directory),
            PathSegment::Key(planet_id),
        ] if root == "galaxy" && directory == "planetRoles" => planet_id.as_str(),
        _ => bail!("native player-authority planet industry role path is not canonical"),
    };
    if !state
        .catalog
        .planets
        .iter()
        .any(|planet| planet.id == planet_id)
    {
        bail!("native player-authority planet industry role target is unknown")
    }
    let target = change
        .value
        .as_ref()
        .filter(|_| change.operation == "set")
        .and_then(Value::as_str)
        .filter(|role| player_planet_industry_role_is_valid(role))
        .ok_or_else(|| anyhow!("native player-authority planet industry role is invalid"))?;
    let roles = state
        .base_value()
        .get("galaxy")
        .and_then(Value::as_object)
        .and_then(|galaxy| galaxy.get("planetRoles"))
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("native player-authority planet role directory is invalid"))?;
    let current = roles
        .get(planet_id)
        .map(|value| {
            value
                .as_str()
                .filter(|role| player_planet_industry_role_is_valid(role))
                .ok_or_else(|| {
                    anyhow!("native player-authority current planet industry role is invalid")
                })
        })
        .transpose()?;
    if current == Some(target) {
        bail!("native player-authority planet industry role is unchanged")
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

fn validate_technology_layout_command(
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
        bail!("native player-authority technology layout command shape is invalid")
    }
    if state.catalog.snapshot.registry_fingerprint != EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT
        || state.identity.registry_fingerprint != EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT
    {
        bail!("native player-authority technology layout requires the built-in catalog")
    }
    let target = require_exact_set_patch(
        &command.top_level_changes,
        &["settings", "technologyLayout"],
    )?
    .as_str()
    .filter(|layout| matches!(*layout, "standard" | "compact"))
    .ok_or_else(|| anyhow!("native player-authority technology layout target is invalid"))?;
    let current = state
        .base_value()
        .get("settings")
        .and_then(Value::as_object)
        .and_then(|settings| settings.get("technologyLayout"))
        .and_then(Value::as_str)
        .filter(|layout| matches!(*layout, "standard" | "compact"))
        .ok_or_else(|| anyhow!("native player-authority current technology layout is invalid"))?;
    if current == target {
        bail!("native player-authority technology layout target is unchanged")
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

pub(crate) fn builtin_belt_construction_id(
    state: &CoreState,
    tier: u8,
) -> anyhow::Result<&'static str> {
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
    crate::construction_belt_lane_context::validate_command(state, command)
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
        if crate::manual_mining::command_contains_intent(command) {
            return crate::manual_mining::validate_command(self, command);
        }
        if crate::blueprint_command::command_contains_intent(command) {
            return crate::blueprint_command::validate_command(self, command);
        }
        if crate::recipe_command::command_contains_intent(command) {
            return crate::recipe_command::validate_command(self, command);
        }
        if command_contains_black_hole_pause_intent(command) {
            return validate_black_hole_pause_command(self, command);
        }
        if !command.added_entities.is_empty() {
            return validate_ordinary_building_placement(self, command);
        }
        if !command.added_belts.is_empty() {
            return crate::construction_belt_placement_context::validate_command(self, command);
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
        if command_contains_energy_exchanger_mode_intent(command) {
            return validate_energy_exchanger_mode_command(self, command);
        }
        if command_contains_fuel_item_intent(command) {
            return validate_fuel_item_command(self, command);
        }
        if command_contains_station_fleet_target_intent(command) {
            return validate_station_fleet_target_intent(self, command);
        }
        if command_contains_station_warper_inventory_intent(command) {
            return validate_station_warper_inventory_intent(self, command);
        }
        if command_contains_station_slot_mode_intent(command) {
            return validate_station_slot_mode_intent(self, command);
        }
        if command_contains_station_slot_item_intent(command) {
            return validate_station_slot_item_intent(self, command);
        }
        if command_contains_construction_automation_intent(command) {
            return validate_construction_automation_intent(self, command);
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
            if command_contains_station_slot_item(command) {
                return validate_station_slot_item_command(self, command);
            }
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
            matches!(
                change.path.first(),
                Some(PathSegment::Key(root)) if root == "quantumLogisticsNetwork"
            )
        }) {
            return validate_quantum_item_capacity_command(self, command);
        }
        if command.top_level_changes.iter().any(|change| {
            matches!(change.path.first(), Some(PathSegment::Key(root)) if root == "timeWarp")
        }) {
            return validate_time_warp_command(self, command);
        }
        if command.top_level_changes.iter().any(|change| {
            matches!(change.path.first(), Some(PathSegment::Key(root)) if root == "dysonEngineering")
        }) {
            if command.top_level_changes.iter().any(|change| {
                matches!(
                    change.path.get(1),
                    Some(PathSegment::Key(directory)) if directory == "orbitsBySystem"
                )
            }) {
                return validate_dyson_orbit_geometry_command(self, command);
            }
            return validate_dyson_launch_configuration_command(self, command);
        }
        if command.top_level_changes.iter().any(|change| {
            matches!(change.path.first(), Some(PathSegment::Key(root)) if root == "dysonPlans")
        }) {
            return validate_active_dyson_layer_command(self, command);
        }
        if command.top_level_changes.iter().any(|change| {
            matches!(
                change.path.as_slice(),
                [PathSegment::Key(root), PathSegment::Key(directory), ..]
                    if root == "galaxy" && directory == "planetRoles"
            )
        }) {
            return validate_planet_industry_role_command(self, command);
        }
        if command.top_level_changes.iter().any(|change| {
            matches!(change.path.first(), Some(PathSegment::Key(root)) if root == "activePlanetId")
        }) {
            return validate_active_planet_command(self, command);
        }
        if command.top_level_changes.iter().any(|change| {
            matches!(
                change.path.as_slice(),
                [PathSegment::Key(root), ..] if root == "research"
            ) || matches!(
                change.path.as_slice(),
                [PathSegment::Key(root), PathSegment::Key(field), ..]
                    if root == "endgame"
                        && matches!(field.as_str(), "activeInfiniteResearchId" | "autoResearch")
            )
        }) {
            return validate_player_research_command(self, command);
        }
        if command.top_level_changes.iter().any(|change| {
            matches!(
                change.path.as_slice(),
                [PathSegment::Key(root), PathSegment::Key(field)]
                    if root == "settings" && field == "technologyLayout"
            )
        }) {
            return validate_technology_layout_command(self, command);
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
            if command.removed_belt_ids.len() == 1 {
                return crate::construction_belt_removal_context::validate_command(self, command);
            }
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
        if crate::factory_inventory::command_touches_factory_inventory(command) {
            return crate::factory_inventory::validate_factory_inventory_command(self, command);
        }
        if !command.top_level_changes.is_empty() {
            return validate_player_pause_command(self, command);
        }
        bail!("native player-authority command domain is not typed yet")
    }

    /// Rebuilds the durable renderer invalidation receipt after a Host restart.
    /// A station fleet WAL stores only its semantic marker, so the current
    /// authoritative station is also needed to recover the peer progress reset.
    pub fn deterministic_player_authority_resume_result(
        &self,
        command: &SimulationCommandPatch,
        previous_revision: u64,
        revision: u64,
    ) -> anyhow::Result<CommandApplyResult> {
        let mut result = command.deterministic_apply_result(previous_revision, revision)?;
        if crate::recipe_command::command_contains_intent(command) {
            let entity_id = crate::recipe_command::validate_resume_marker(command)?;
            result.changed_entity_ids.push(entity_id);
            result.changed_entity_ids.sort_unstable();
            result.changed_entity_ids.dedup();
            // The semantic marker does not retain removed belt IDs. Force a
            // complete topology refresh after cold recovery instead.
            result.topology_dirty = true;
            return Ok(result);
        }
        if crate::blueprint_command::command_contains_intent(command) {
            crate::blueprint_command::validate_resume_marker(command)?;
            result.topology_dirty = true;
            return Ok(result);
        }
        if command_contains_station_warper_inventory_intent(command) {
            require_station_warper_inventory_intent(command)?;
            result.topology_dirty = false;
            return Ok(result);
        }
        if command_contains_station_slot_mode_intent(command) {
            require_station_slot_mode_intent(command)?;
            // The post-commit state no longer contains canceled route leaves.
            // A conservative topology invalidation is deterministic and makes
            // cold recovery refresh every affected station without persisting
            // renderer-derived IDs beside the semantic WAL marker.
            result.topology_dirty = true;
            return Ok(result);
        }
        if command_contains_station_slot_item_intent(command) {
            require_station_slot_item_intent(command)?;
            // Item replacement may also remove matching belts; force a full
            // topology refresh when a staged command resumes after restart.
            result.topology_dirty = true;
            return Ok(result);
        }
        if !command_contains_station_fleet_target_intent(command) {
            return Ok(result);
        }
        let (station_id, _, _) = require_station_fleet_target_intent(command)?;
        let station_index = *self
            .entity_index
            .get(station_id)
            .ok_or_else(|| anyhow!("native player-authority station fleet entity is missing"))?;
        let station = self.parse_entity(station_index)?;
        let station = station
            .as_object()
            .ok_or_else(|| anyhow!("native player-authority station fleet entity is invalid"))?;
        let peer_id = match station.get("stationPeerId") {
            None | Some(Value::Null) => None,
            Some(Value::String(peer_id)) if !peer_id.is_empty() => Some(peer_id.as_str()),
            _ => bail!("native player-authority station fleet peer ID is invalid"),
        };
        if let Some(peer_id) = peer_id
            && peer_id != station_id
            && self.entity_index.contains_key(peer_id)
        {
            result.changed_entity_ids.push(peer_id.to_owned());
            result.changed_entity_ids.sort_unstable();
            result.changed_entity_ids.dedup();
        }
        result.topology_dirty = false;
        Ok(result)
    }

    pub fn apply_player_authority_command(
        &mut self,
        command: &SimulationCommandPatch,
    ) -> anyhow::Result<CommandApplyResult> {
        self.validate_player_authority_command(command)?;
        if !command_contains_station_slot_mode(command)
            && !command_contains_station_slot_item(command)
        {
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
                if optional_undefined_station_path(&change.path)
                    && change.operation == "set"
                    && change.value.as_ref().is_none_or(Value::is_null)
                {
                    change.operation = "delete".to_owned();
                    change.value = None;
                }
            }
        }
        self.apply_command(&normalized)
    }

    /// Applies the one exact pause bit used by the main-owned durable clock.
    ///
    /// The Host calls this only while holding a request-bound player-authority
    /// lease transition. Keeping it separate from
    /// `apply_player_authority_command()` prevents renderer gameplay commands
    /// from changing the clock lifecycle without its paired durable lease ACK.
    pub fn apply_player_authority_pause_transition(
        &mut self,
        command: &SimulationCommandPatch,
    ) -> anyhow::Result<CommandApplyResult> {
        if command.top_level_changes.len() != 1
            || !command.changed_entities.is_empty()
            || !command.added_entities.is_empty()
            || !command.removed_entity_ids.is_empty()
            || !command.changed_belts.is_empty()
            || !command.added_belts.is_empty()
            || !command.removed_belt_ids.is_empty()
        {
            bail!("native player-authority pause lifecycle command shape is invalid")
        }
        let target = require_exact_set_patch(&command.top_level_changes, &["paused"])?
            .as_bool()
            .ok_or_else(|| anyhow!("native player-authority pause lifecycle target is invalid"))?;
        let current = self
            .base_value()
            .get("paused")
            .and_then(Value::as_bool)
            .ok_or_else(|| anyhow!("native player-authority paused state is invalid"))?;
        if current == target {
            bail!("native player-authority pause lifecycle target is unchanged")
        }
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

        // Player-authority travel is durably stored as a minimal semantic
        // intent. Expand it inside the generic command engine as well as the
        // live player path, otherwise cold WAL replay would update only the ID
        // and leave the two planet inventories and visible metrics mismatched.
        let expanded_active_planet_intent;
        let expanded_research_transition_intent;
        let expanded_energy_exchanger_mode_intent;
        let expanded_fuel_item_intent;
        let expanded_station_fleet_target_intent;
        let expanded_station_warper_inventory_intent;
        let expanded_station_slot_mode_intent;
        let expanded_station_slot_item_intent;
        let expanded_construction_automation_intent;
        let expanded_manual_mining_intent;
        let expanded_black_hole_pause_intent;
        let expanded_time_warp_intent;
        let expanded_blueprint_intent;
        let expanded_entity_recipe_intent;
        let mut compact_entity_recipe_receipt_id = None;
        let mut blueprint_delete_index = None;
        let applied_command = if command_contains_active_planet_intent(command) {
            expanded_active_planet_intent = expand_active_planet_intent(self, command)?;
            &expanded_active_planet_intent
        } else if command_contains_player_research_transition_intent(command) {
            expanded_research_transition_intent =
                expand_player_research_transition_intent(self, command)?;
            &expanded_research_transition_intent
        } else if command_contains_energy_exchanger_mode_intent(command) {
            expanded_energy_exchanger_mode_intent =
                expand_energy_exchanger_mode_intent(self, command)?;
            &expanded_energy_exchanger_mode_intent
        } else if command_contains_fuel_item_intent(command) {
            expanded_fuel_item_intent = expand_fuel_item_intent(self, command)?;
            &expanded_fuel_item_intent
        } else if command_contains_station_fleet_target_intent(command) {
            expanded_station_fleet_target_intent =
                expand_station_fleet_target_intent(self, command)?;
            &expanded_station_fleet_target_intent
        } else if command_contains_station_warper_inventory_intent(command) {
            expanded_station_warper_inventory_intent =
                expand_station_warper_inventory_intent(self, command)?;
            &expanded_station_warper_inventory_intent
        } else if command_contains_station_slot_mode_intent(command) {
            expanded_station_slot_mode_intent = expand_station_slot_mode_intent(self, command)?;
            &expanded_station_slot_mode_intent
        } else if command_contains_station_slot_item_intent(command) {
            expanded_station_slot_item_intent = expand_station_slot_item_intent(self, command)?;
            &expanded_station_slot_item_intent
        } else if command_contains_construction_automation_intent(command) {
            expanded_construction_automation_intent =
                expand_construction_automation_intent(self, command)?;
            &expanded_construction_automation_intent
        } else if crate::recipe_command::command_contains_intent(command) {
            compact_entity_recipe_receipt_id =
                Some(crate::recipe_command::validate_resume_marker(command)?);
            expanded_entity_recipe_intent = crate::recipe_command::expand_intent(self, command)?;
            &expanded_entity_recipe_intent
        } else if crate::blueprint_command::command_contains_intent(command) {
            expanded_blueprint_intent = crate::blueprint_command::expand_intent(self, command)?;
            blueprint_delete_index = expanded_blueprint_intent.delete_index();
            expanded_blueprint_intent.command()
        } else if crate::manual_mining::command_contains_intent(command) {
            expanded_manual_mining_intent = crate::manual_mining::expand_intent(self, command)?;
            &expanded_manual_mining_intent
        } else if command_contains_black_hole_pause_intent(command) {
            expanded_black_hole_pause_intent = expand_black_hole_pause_intent(self, command)?;
            &expanded_black_hole_pause_intent
        } else if command_contains_time_warp_intent(command) {
            expanded_time_warp_intent = expand_time_warp_intent(self, command)?;
            &expanded_time_warp_intent
        } else {
            command
        };

        // Apply to a cloned transactional state. A malformed late patch can
        // never leave the authoritative candidate partially edited.
        let rebuild_production_history =
            command_requires_production_history_rebuild(applied_command);
        let mut next = self.clone();
        // `next` is already disposable on failure. Move its base map into the
        // patch value instead of retaining two complete copies during every
        // pause/edit command.
        let mut base = Value::Object(next.take_base_for_command());
        for change in &applied_command.top_level_changes {
            apply_value_patch(&mut base, change)?;
        }
        if let Some(index) = blueprint_delete_index {
            let blueprints = base
                .get_mut("blueprints")
                .and_then(Value::as_array_mut)
                .ok_or_else(|| anyhow!("native player-authority blueprint directory is invalid"))?;
            if index >= blueprints.len() {
                bail!("native player-authority blueprint delete index is invalid")
            }
            blueprints.remove(index);
        }
        let base = match base {
            Value::Object(base) => base,
            _ => bail!("native command replaced the GameState root"),
        };
        next.install_base_from_command(base, rebuild_production_history);

        for record in &applied_command.changed_entities {
            let index = *next
                .entity_index
                .get(&record.id)
                .ok_or_else(|| anyhow!("native command entity is missing"))?;
            let mut value = next.parse_entity(index)?;
            apply_record_changes(&mut value, &record.changes)?;
            next.replace_entity_raw(index, Arc::<str>::from(serde_json::to_string(&value)?));
        }
        if !applied_command.removed_entity_ids.is_empty() {
            let removed = applied_command
                .removed_entity_ids
                .iter()
                .collect::<std::collections::HashSet<_>>();
            if removed.len() != applied_command.removed_entity_ids.len() {
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
        if !applied_command.added_entities.is_empty() {
            let mut additions = applied_command.added_entities.clone();
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

        for record in &applied_command.changed_belts {
            let index = *next
                .belt_index
                .get(&record.id)
                .ok_or_else(|| anyhow!("native command belt is missing"))?;
            let mut value = next.parse_belt(index)?;
            apply_record_changes(&mut value, &record.changes)?;
            next.replace_belt_raw(index, Arc::<str>::from(serde_json::to_string(&value)?));
        }
        if !applied_command.removed_belt_ids.is_empty() {
            let removed = applied_command
                .removed_belt_ids
                .iter()
                .collect::<std::collections::HashSet<_>>();
            if removed.len() != applied_command.removed_belt_ids.len() {
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
        if !applied_command.added_belts.is_empty() {
            let mut additions = applied_command.added_belts.clone();
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
        let only_pause_changed = blueprint_delete_index.is_none()
            && applied_command.changed_entities.is_empty()
            && applied_command.added_entities.is_empty()
            && applied_command.removed_entity_ids.is_empty()
            && applied_command.changed_belts.is_empty()
            && applied_command.added_belts.is_empty()
            && applied_command.removed_belt_ids.is_empty()
            && applied_command.top_level_changes.iter().all(|change| {
                matches!(
                    change.path.first(),
                    Some(PathSegment::Key(key)) if key == "paused"
                )
            });
        // Top-level commands never change record IDs or topology. Rebuilding
        // all 80k entity and 155k belt indexes for a pause/resume toggle made
        // a tiny Windows command pay the full save-open parsing cost.
        let records_changed = !applied_command.changed_entities.is_empty()
            || !applied_command.added_entities.is_empty()
            || !applied_command.removed_entity_ids.is_empty()
            || !applied_command.changed_belts.is_empty()
            || !applied_command.added_belts.is_empty()
            || !applied_command.removed_belt_ids.is_empty();
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
        let mut result =
            applied_command.deterministic_apply_result(previous_revision, next.revision)?;
        if let Some(entity_id) = compact_entity_recipe_receipt_id {
            // The semantic recipe transition may remove thousands of opaque-ID
            // belts. The durable Host receipt has a much smaller byte budget
            // than the authoritative topology, so expose the same compact
            // invalidation for live apply and cold resume: refresh the changed
            // entity directly and re-read the complete topology.
            result.changed_entity_ids.clear();
            result.changed_entity_ids.push(entity_id);
            result.changed_belt_ids.clear();
            result.topology_dirty = true;
        }
        if blueprint_delete_index.is_some() {
            // The compact semantic marker and private delete plan carry no
            // renderer-derived dirty set. Blueprint workspace consumers must
            // therefore re-read their bounded projection after live apply just
            // as they do after cold WAL recovery.
            result.topology_dirty = true;
        }
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
                { "id": "space_warper", "kind": "solid" },
                { "id": "electromagnetic_matrix", "kind": "solid" },
                { "id": "gravity_matrix", "kind": "solid" },
                { "id": "universe_matrix", "kind": "solid" }
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
            "belts": [{ "tier": 1, "speed": 6 }],
            "technologies": [
                {
                    "id": "electromagnetic_matrix",
                    "costs": [{ "itemId": "electromagnetic_matrix", "amount": 3 }],
                    "prerequisites": []
                },
                {
                    "id": "electromagnetism",
                    "costs": [{ "itemId": "electromagnetic_matrix", "amount": 5 }],
                    "prerequisites": ["electromagnetic_matrix"]
                },
                {
                    "id": "basic_logistics",
                    "costs": [{ "itemId": "electromagnetic_matrix", "amount": 8 }],
                    "prerequisites": ["electromagnetism"],
                    "constructionRewards": ["conveyor_belt_mk1"]
                },
                {
                    "id": "thermal_power",
                    "costs": [{ "itemId": "electromagnetic_matrix", "amount": 8 }],
                    "prerequisites": ["electromagnetism"]
                },
                {
                    "id": "high_efficiency_plasma_control",
                    "costs": [{ "itemId": "electromagnetic_matrix", "amount": 12 }],
                    "prerequisites": ["basic_logistics", "thermal_power"]
                },
                {
                    "id": "gravity_matrix",
                    "costs": [{ "itemId": "gravity_matrix", "amount": 5 }],
                    "prerequisites": []
                },
                {
                    "id": "research_speed_1",
                    "costs": [{ "itemId": "electromagnetic_matrix", "amount": 20 }],
                    "prerequisites": ["gravity_matrix"]
                },
                {
                    "id": "research_speed_2",
                    "costs": [{ "itemId": "gravity_matrix", "amount": 20 }],
                    "prerequisites": ["gravity_matrix", "research_speed_1"]
                },
                {
                    "id": "universe_matrix",
                    "costs": [{ "itemId": "universe_matrix", "amount": 5 }],
                    "prerequisites": []
                },
                {
                    "id": "interstellar_logistics",
                    "costs": [{ "itemId": "gravity_matrix", "amount": 5 }],
                    "prerequisites": []
                },
                {
                    "id": "research_speed_3",
                    "costs": [{ "itemId": "universe_matrix", "amount": 30 }],
                    "prerequisites": ["universe_matrix", "research_speed_2"]
                }
            ]
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
            "galaxy": {
                "planetRoles": { "home": "auto" },
                "modPayload": { "owner": "pack:test", "revision": 7 }
            },
            "metrics": { "generationKw": 1, "demandKw": 2, "powerFactor": 0.5 },
            "planetMetrics": {
                "home": { "generationKw": 1, "demandKw": 2, "powerFactor": 0.5 },
                "ashen": { "generationKw": 3, "demandKw": 4, "powerFactor": 0.75 },
                "giant": { "generationKw": 0, "demandKw": 0, "powerFactor": 1 }
            },
            "dysonPlans": {
                "helios": {
                    "activeLayerId": "dyson-layer-old",
                    "layers": [
                        { "id": "dyson-layer-old", "modPayload": { "owner": "pack:test" } },
                        { "id": "dyson-layer-new", "modPayload": { "owner": "pack:test" } }
                    ]
                },
                "sigma": {
                    "activeLayerId": "dyson-layer-foreign",
                    "layers": [{ "id": "dyson-layer-foreign" }]
                }
            },
            "dysonEngineering": {
                "launchMode": "balanced",
                "launchThrottle": 1,
                "launchEnabled": true,
                "activeOrbitBySystem": { "helios": "orbit-home-old", "sigma": "orbit-foreign" },
                "orbitsBySystem": {
                    "helios": [
                        { "id": "orbit-home-old", "radius": 12000, "inclination": 0, "longitude": 0 },
                        { "id": "orbit-home-new", "radius": 18000, "inclination": 18, "longitude": 24 }
                    ],
                    "sigma": [
                        { "id": "orbit-foreign", "radius": 12000, "inclination": 0, "longitude": 0 }
                    ]
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

    fn player_construction_automation_catalog_for_registry(
        registry_fingerprint: &str,
    ) -> RuntimeCatalog {
        let mut catalog = serde_json::to_value(
            player_command_catalog_for_registry(registry_fingerprint).snapshot,
        )
        .unwrap();
        catalog["buildings"].as_array_mut().unwrap().extend([
            serde_json::json!({
                "id": "construction_center", "kind": "machine", "speed": 1,
                "inputCapacity": 100000000, "outputCapacity": 100000000
            }),
            serde_json::json!({
                "id": "orbital_cargo_terminal", "kind": "storage", "speed": 1,
                "inputCapacity": 100000000, "outputCapacity": 100000000
            }),
        ]);
        catalog["recipes"].as_array_mut().unwrap().extend([
            serde_json::json!({
                "id": "logistics_drone", "buildingId": "arc_smelter", "duration": 4,
                "requiredTechId": "planetary_logistics",
                "inputs": [{ "itemId": "iron_ingot", "amount": 1 }],
                "outputs": [{ "itemId": "logistics_drone", "amount": 1 }]
            }),
            serde_json::json!({
                "id": "logistics_vessel", "buildingId": "arc_smelter", "duration": 8,
                "requiredTechId": "interstellar_logistics",
                "inputs": [{ "itemId": "iron_ingot", "amount": 1 }],
                "outputs": [{ "itemId": "logistics_vessel", "amount": 1 }]
            }),
        ]);
        catalog["constructions"].as_array_mut().unwrap().extend([
            serde_json::json!({
                "id": "construction_center", "outputAmount": 1,
                "requiredTechId": "construction_automation",
                "costs": [{ "itemId": "iron_ingot", "amount": 1 }]
            }),
            serde_json::json!({
                "id": "orbital_cargo_terminal", "outputAmount": 1,
                "requiredTechId": "universe_matrix",
                "costs": [{ "itemId": "iron_ingot", "amount": 1 }]
            }),
        ]);
        catalog["technologies"].as_array_mut().unwrap().extend([
            serde_json::json!({
                "id": "construction_automation",
                "costs": [{ "itemId": "universe_matrix", "amount": 1 }],
                "prerequisites": []
            }),
            serde_json::json!({
                "id": "construction_capacity_1",
                "costs": [{ "itemId": "universe_matrix", "amount": 1 }],
                "prerequisites": ["construction_automation"]
            }),
            serde_json::json!({
                "id": "construction_capacity_2",
                "costs": [{ "itemId": "universe_matrix", "amount": 1 }],
                "prerequisites": ["construction_capacity_1"]
            }),
            serde_json::json!({
                "id": "quantum_logistics_network",
                "costs": [{ "itemId": "universe_matrix", "amount": 1 }],
                "prerequisites": ["construction_automation"]
            }),
            serde_json::json!({
                "id": "planetary_logistics",
                "costs": [{ "itemId": "electromagnetic_matrix", "amount": 1 }],
                "prerequisites": []
            }),
        ]);
        RuntimeCatalog::from_value(catalog, registry_fingerprint).unwrap()
    }

    fn player_construction_automation_state_for_registry(registry_fingerprint: &str) -> CoreState {
        let mut state = player_command_state_for_registry(registry_fingerprint);
        state.catalog = Arc::new(player_construction_automation_catalog_for_registry(
            registry_fingerprint,
        ));
        state.base_value_mut()["research"]["completedTechIds"] = serde_json::json!([
            "construction_automation",
            "construction_capacity_1",
            "construction_capacity_2",
            "quantum_logistics_network",
            "basic_logistics",
            "planetary_logistics",
            "interstellar_logistics",
            "universe_matrix"
        ]);
        state.base_value_mut().insert(
            "constructionAutomation".to_owned(),
            serde_json::json!({
            "enabled": false,
            "targetStock": { "arc_smelter": 2 },
            "cursor": 3,
            "totalCrafted": 7,
            "lastCraftedId": "arc_smelter",
            "destroyedByproducts": { "iron_ore": 5 },
            "jobs": {
                "construction-center-a": {
                    "constructionId": "arc_smelter",
                    "steps": [{ "kind": "building", "constructionId": "arc_smelter" }],
                    "stepIndex": 0,
                    "elapsedSeconds": 1,
                    "inventory": { "iron_ingot": 9, "logistics_drone": 2 }
                },
                "construction-center-b": {
                    "constructionId": "arc_smelter",
                    "steps": [{ "kind": "building", "constructionId": "arc_smelter" }],
                    "stepIndex": 0,
                    "elapsedSeconds": 2,
                    "inventory": { "iron_ingot": 4 }
                },
                "construction-center-unrelated": {
                    "constructionId": "logistics_vessel",
                    "steps": [{ "kind": "fleet", "itemId": "logistics_vessel", "amount": 1 }],
                    "stepIndex": 0,
                    "elapsedSeconds": 0,
                    "inventory": { "iron_ingot": 6 }
                }
            },
            "quantumMaterialBuffer": {
                "construction-center-a": { "iron_ingot": 11 },
                "construction-center-b": { "iron_ingot": 7, "space_warper": 3 },
                "construction-center-unrelated": { "iron_ingot": 2 }
            }
            }),
        );
        state.base_value_mut().insert(
            "quantumLogisticsNetwork".to_owned(),
            serde_json::json!({
            "enabled": true,
            "inventory": { "iron_ingot": "9980", "space_warper": "9997" },
            "itemCapacities": { "iron_ingot": "10000", "space_warper": "10000" },
            "routingCursors": { "iron_ingot": 7 },
            "uploadRoutingCursors": { "iron_ingot": 9 }
            }),
        );
        state.base_value_mut().insert(
            "orbitalStation".to_owned(),
            serde_json::json!({ "status": "operational" }),
        );
        state.base_value_mut()["construction"]["construction_center"] = Value::from(0);
        state.base_value_mut()["construction"]["orbital_cargo_terminal"] = Value::from(0);
        state.entity_raw_mut_topology().push(Arc::<str>::from(
            serde_json::json!({
                "id": "construction-center-a",
                "kind": "machine",
                "planetId": "home",
                "position": { "x": 9, "y": 2 },
                "interactionLocked": false,
                "buildingId": "construction_center",
                "powerGridId": "grid-a",
                "powerPriority": 2,
                "recipeId": null,
                "machineCount": 2,
                "minerCount": 0,
                "inputs": { "iron_ingot": 13 },
                "outputs": { "arc_smelter": 17 },
                "progress": 0.25,
                "routingCursor": 0,
                "utilization": 0.5,
                "productionRate": 0
            })
            .to_string(),
        ));
        state.entity_raw_mut_topology().push(Arc::<str>::from(
            serde_json::json!({
                "id": "construction-center-b",
                "kind": "machine",
                "planetId": "ashen",
                "position": { "x": 10, "y": 2 },
                "interactionLocked": false,
                "buildingId": "construction_center",
                "powerGridId": "grid-b",
                "powerPriority": 2,
                "recipeId": null,
                "machineCount": 1,
                "minerCount": 0,
                "inputs": { "iron_ingot": 3 },
                "outputs": {},
                "progress": 0.5,
                "routingCursor": 0,
                "utilization": 0.25,
                "productionRate": 0
            })
            .to_string(),
        ));
        state.rebuild_indexes().unwrap();
        state
    }

    fn player_construction_automation_state() -> CoreState {
        player_construction_automation_state_for_registry(EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT)
    }

    fn construction_automation_intent_command(
        revision: u64,
        intent: Value,
    ) -> SimulationCommandPatch {
        let mut command = empty_player_command(revision);
        command.top_level_changes = vec![ValuePatch {
            path: vec![
                PathSegment::Key("constructionAutomation".to_owned()),
                PathSegment::Key("intent".to_owned()),
            ],
            operation: "set".to_owned(),
            value: Some(intent),
        }];
        command
    }

    fn construction_automation_material_snapshot(state: &CoreState) -> Value {
        serde_json::json!({
            "tray": state.base_value().get("tray"),
            "planetTrays": state.base_value().get("planetTrays"),
            "portableFleet": state.base_value().get("portableFleet"),
            "construction": state.base_value().get("construction"),
            "constructionQueue": state.base_value().get("constructionQueue"),
            "jobs": state.base_value()["constructionAutomation"].get("jobs"),
            "quantumMaterialBuffer": state.base_value()["constructionAutomation"].get("quantumMaterialBuffer"),
            "quantumLogisticsNetwork": state.base_value().get("quantumLogisticsNetwork"),
            "entities": (0..state.entity_index.len()).map(|index| state.parse_entity(index).unwrap()).collect::<Vec<_>>()
        })
    }

    fn construction_owned_material_total(state: &CoreState, item_id: &str) -> u128 {
        fn amount(value: Option<&Value>) -> u128 {
            match value {
                Some(Value::String(value)) => value.parse::<u128>().unwrap(),
                Some(value) => value.as_u64().unwrap_or(0) as u128,
                None => 0,
            }
        }
        fn record_amount(value: Option<&Value>, item_id: &str) -> u128 {
            value
                .and_then(Value::as_object)
                .map(|record| amount(record.get(item_id)))
                .unwrap_or(0)
        }

        let base = state.base_value();
        let mut total = record_amount(base.get("tray"), item_id)
            + record_amount(base.get("portableFleet"), item_id)
            + base
                .get("planetTrays")
                .and_then(Value::as_object)
                .into_iter()
                .flat_map(|trays| trays.values())
                .map(|tray| record_amount(Some(tray), item_id))
                .sum::<u128>()
            + base
                .get("quantumLogisticsNetwork")
                .and_then(Value::as_object)
                .and_then(|network| network.get("inventory"))
                .map(|inventory| record_amount(Some(inventory), item_id))
                .unwrap_or(0);
        let automation = base["constructionAutomation"].as_object().unwrap();
        total += automation
            .get("jobs")
            .and_then(Value::as_object)
            .into_iter()
            .flat_map(|jobs| jobs.values())
            .map(|job| {
                job.as_object()
                    .and_then(|job| job.get("inventory"))
                    .map(|inventory| record_amount(Some(inventory), item_id))
                    .unwrap_or(0)
            })
            .sum::<u128>();
        total += automation
            .get("quantumMaterialBuffer")
            .and_then(Value::as_object)
            .into_iter()
            .flat_map(|buffers| buffers.values())
            .map(|inventory| record_amount(Some(inventory), item_id))
            .sum::<u128>();
        total += (0..state.entity_index.len())
            .map(|index| state.parse_entity(index).unwrap())
            .map(|entity| {
                record_amount(entity.get("inputs"), item_id)
                    + record_amount(entity.get("outputs"), item_id)
            })
            .sum::<u128>();
        total
    }

    fn construction_quantum_refund_order_fixture(
        free_quantum_capacity: u64,
        a_center_planet_id: &str,
    ) -> CoreState {
        assert!(free_quantum_capacity <= 10_000);
        let mut state = player_construction_automation_state();
        for (old_id, new_id, planet_id) in [
            ("construction-center-a", "z-center", "home"),
            ("construction-center-b", "a-center", a_center_planet_id),
        ] {
            let index = *state.entity_index.get(old_id).unwrap();
            let mut entity = state.parse_entity(index).unwrap();
            entity["id"] = Value::from(new_id);
            entity["planetId"] = Value::from(planet_id);
            state.replace_entity_raw(
                index,
                Arc::<str>::from(serde_json::to_string(&entity).unwrap()),
            );
        }
        state.rebuild_indexes().unwrap();
        state.base_value_mut()["constructionAutomation"]["jobs"] = serde_json::json!({});
        let mut reverse_buffers = Map::new();
        // This explicit oracle order is z@home followed by a@planet. The
        // default serde_json Map deliberately cannot retain it, which is why
        // a cross-planet partial deposit must fail closed instead of guessing.
        reverse_buffers.insert(
            "z-center".to_owned(),
            serde_json::json!({ "iron_ingot": 6 }),
        );
        reverse_buffers.insert(
            "a-center".to_owned(),
            serde_json::json!({ "iron_ingot": 4 }),
        );
        state.base_value_mut()["constructionAutomation"]["quantumMaterialBuffer"] =
            Value::Object(reverse_buffers);
        state.base_value_mut()["quantumLogisticsNetwork"] = serde_json::json!({
            "enabled": true,
            "inventory": {
                "iron_ingot": (10_000 - free_quantum_capacity).to_string()
            },
            "itemCapacities": { "iron_ingot": "10000" },
            "routingCursors": {},
            "uploadRoutingCursors": {}
        });
        state.base_value_mut()["tray"]
            .as_object_mut()
            .unwrap()
            .remove("iron_ingot");
        state.base_value_mut()["planetTrays"]["ashen"]
            .as_object_mut()
            .unwrap()
            .remove("iron_ingot");
        state
    }

    fn apply_reverse_js_quantum_cancel_oracle(mut state: CoreState) -> CoreState {
        state.base_value_mut()["constructionAutomation"]["targetStock"]
            .as_object_mut()
            .unwrap()
            .remove("arc_smelter");
        for entity_id in ["z-center", "a-center"] {
            let amount = state.base_value()["constructionAutomation"]["quantumMaterialBuffer"]
                [entity_id]["iron_ingot"]
                .as_u64()
                .unwrap();
            let planet_id = {
                let entity_index = *state.entity_index.get(entity_id).unwrap();
                state.parse_entity(entity_index).unwrap()["planetId"]
                    .as_str()
                    .unwrap()
                    .to_owned()
            };
            let accepted = crate::quantum_logistics::deposit_construction_refund(
                state.base_value_mut(),
                "iron_ingot",
                amount,
            )
            .unwrap();
            let remainder = amount - accepted;
            if remainder == 0 {
                continue;
            }
            let tray = if planet_id == "home" {
                state.base_value_mut()["tray"].as_object_mut().unwrap()
            } else {
                state.base_value_mut()["planetTrays"][&planet_id]
                    .as_object_mut()
                    .unwrap()
            };
            let current = tray.get("iron_ingot").and_then(Value::as_u64).unwrap_or(0);
            tray.insert("iron_ingot".to_owned(), Value::from(current + remainder));
        }
        state.base_value_mut()["constructionAutomation"]
            .as_object_mut()
            .unwrap()
            .remove("quantumMaterialBuffer");
        state
    }

    #[test]
    fn construction_automation_semantic_intents_expand_and_refund_without_loss() {
        let mut live = player_construction_automation_state();
        let mut replay = live.clone();
        let material_before = construction_automation_material_snapshot(&live);
        let commands = [
            construction_automation_intent_command(
                live.revision,
                serde_json::json!({ "kind": "enabled", "enabled": true }),
            ),
            construction_automation_intent_command(
                live.revision + 1,
                serde_json::json!({
                    "kind": "quantumSupplyEnabled",
                    "enabled": true
                }),
            ),
            construction_automation_intent_command(
                live.revision + 2,
                serde_json::json!({
                    "kind": "targetStock",
                    "targetId": "logistics_vessel",
                    "target": 500
                }),
            ),
        ];
        for command in &commands {
            let live_result = live.apply_player_authority_command(command).unwrap();
            let replay_result = replay.apply_command(command).unwrap();
            assert_eq!(live_result, replay_result);
            assert!(live_result.changed_entity_ids.is_empty());
            assert!(live_result.changed_belt_ids.is_empty());
            assert!(live_result.topology_dirty);
            assert_eq!(
                construction_automation_material_snapshot(&live),
                material_before
            );
            assert_eq!(
                live.canonical_sha256().unwrap(),
                replay.canonical_sha256().unwrap()
            );
        }
        assert_eq!(live.base_value()["constructionAutomation"]["enabled"], true);
        assert_eq!(
            live.base_value()["constructionAutomation"]["quantumSourceEnabled"],
            true
        );
        assert_eq!(
            live.base_value()["constructionAutomation"]["targetStock"]["arc_smelter"],
            2
        );
        assert_eq!(
            live.base_value()["constructionAutomation"]["targetStock"]["logistics_vessel"],
            500
        );
        assert!(
            live.base_value()["constructionAutomation"]
                .get("intent")
                .is_none()
        );

        let iron_before = construction_owned_material_total(&live, "iron_ingot");
        let warpers_before = construction_owned_material_total(&live, "space_warper");
        let drones_before = construction_owned_material_total(&live, "logistics_drone");
        let clear = construction_automation_intent_command(
            live.revision,
            serde_json::json!({
                "kind": "targetStock",
                "targetId": "arc_smelter",
                "target": 0
            }),
        );
        let live_result = live.apply_player_authority_command(&clear).unwrap();
        let replay_result = replay.apply_command(&clear).unwrap();
        assert_eq!(live_result, replay_result);
        assert!(live_result.changed_entity_ids.is_empty());
        assert!(live_result.changed_belt_ids.is_empty());
        assert!(live_result.topology_dirty);
        assert_eq!(
            live.canonical_sha256().unwrap(),
            replay.canonical_sha256().unwrap()
        );
        assert!(
            live.base_value()["constructionAutomation"]["targetStock"]
                .get("arc_smelter")
                .is_none()
        );
        assert_eq!(
            live.base_value()["constructionAutomation"]["jobs"]
                .as_object()
                .unwrap()
                .keys()
                .cloned()
                .collect::<Vec<_>>(),
            vec!["construction-center-unrelated".to_owned()]
        );
        assert!(
            live.base_value()["constructionAutomation"]
                .get("quantumMaterialBuffer")
                .is_none()
        );
        assert_eq!(live.base_value()["tray"]["iron_ingot"], 9);
        assert_eq!(live.base_value()["planetTrays"]["ashen"]["iron_ingot"], 4);
        assert_eq!(live.base_value()["planetTrays"]["ashen"]["space_warper"], 7);
        assert_eq!(live.base_value()["portableFleet"]["logistics_drone"], 22);
        assert_eq!(
            live.base_value()["quantumLogisticsNetwork"]["inventory"]["iron_ingot"],
            "10000"
        );
        assert_eq!(
            live.base_value()["quantumLogisticsNetwork"]["inventory"]["space_warper"],
            "10000"
        );
        assert_eq!(
            construction_owned_material_total(&live, "iron_ingot"),
            iron_before
        );
        assert_eq!(
            construction_owned_material_total(&live, "space_warper"),
            warpers_before
        );
        assert_eq!(
            construction_owned_material_total(&live, "logistics_drone"),
            drones_before
        );

        let before_disable = construction_automation_material_snapshot(&live);
        let disable_quantum = construction_automation_intent_command(
            live.revision,
            serde_json::json!({
                "kind": "quantumSupplyEnabled",
                "enabled": false
            }),
        );
        live.apply_player_authority_command(&disable_quantum)
            .unwrap();
        assert!(
            live.base_value()["constructionAutomation"]
                .get("quantumSourceEnabled")
                .is_none()
        );
        assert_eq!(
            construction_automation_material_snapshot(&live),
            before_disable
        );

        let before_pause = construction_automation_material_snapshot(&live);
        let disable_automation = construction_automation_intent_command(
            live.revision,
            serde_json::json!({ "kind": "enabled", "enabled": false }),
        );
        live.apply_player_authority_command(&disable_automation)
            .unwrap();
        assert_eq!(
            live.base_value()["constructionAutomation"]["enabled"],
            false
        );
        assert_eq!(
            construction_automation_material_snapshot(&live),
            before_pause
        );
    }

    #[test]
    fn construction_automation_batch_building_target_is_atomic_and_replayable() {
        let mut live = player_construction_automation_state();
        live.base_value_mut()["research"]["completedTechIds"] = serde_json::json!([
            "construction_automation",
            "construction_capacity_1",
            "construction_capacity_2",
            "quantum_logistics_network",
            "basic_logistics",
            "planetary_logistics",
            "interstellar_logistics"
        ]);
        live.base_value_mut()["constructionAutomation"]["targetStock"]["logistics_vessel"] =
            Value::from(73);
        // This row deliberately satisfies the single-target cancellation
        // predicate (new target <= owned stock) while retaining live WIP and
        // direct quantum reservations. The batch command is policy-only and
        // must not reuse that cancellation/refund path.
        live.base_value_mut()["constructionAutomation"]["targetStock"]["arc_smelter"] =
            Value::from(50);
        live.base_value_mut()["constructionAutomation"]["targetStock"]["orbital_cargo_terminal"] =
            Value::from(91);
        live.base_value_mut()["constructionAutomation"]["targetStock"]["future_opaque_target"] =
            Value::from(44);
        live.base_value_mut()["constructionAutomation"]["opaquePolicy"] =
            serde_json::json!({ "owner": "future-core", "revision": 7 });

        let mut replay = live.clone();
        let unlocked_ids = unlocked_construction_automation_building_target_ids(&live).unwrap();
        assert!(unlocked_ids.contains(&"arc_smelter".to_owned()));
        assert!(unlocked_ids.contains(&"construction_center".to_owned()));
        assert!(!unlocked_ids.contains(&"orbital_cargo_terminal".to_owned()));
        let before_target_stock = live.base_value()["constructionAutomation"]["targetStock"]
            .as_object()
            .unwrap()
            .clone();
        let mut before_non_policy = live.base_value()["constructionAutomation"].clone();
        before_non_policy
            .as_object_mut()
            .unwrap()
            .remove("targetStock");
        let material_before = construction_automation_material_snapshot(&live);
        let jobs_before = live.base_value()["constructionAutomation"]["jobs"].clone();
        let quantum_buffers_before =
            live.base_value()["constructionAutomation"]["quantumMaterialBuffer"].clone();
        assert_eq!(live.base_value()["construction"]["arc_smelter"], 4);
        assert!(
            live.base_value()["constructionAutomation"]["jobs"]
                .as_object()
                .unwrap()
                .values()
                .any(|job| job["constructionId"] == "arc_smelter")
        );
        assert!(
            live.base_value()["constructionAutomation"]["quantumMaterialBuffer"]
                .as_object()
                .is_some_and(|buffers| !buffers.is_empty())
        );
        let revision = live.revision;
        let command = construction_automation_intent_command(
            revision,
            serde_json::json!({
                "kind": "batchBuildingTargetStock",
                "target": 3
            }),
        );

        let expanded = expand_construction_automation_intent(&live, &command).unwrap();
        let expanded_ids = expanded
            .top_level_changes
            .iter()
            .map(|patch| match patch.path.as_slice() {
                [
                    PathSegment::Key(root),
                    PathSegment::Key(directory),
                    PathSegment::Key(id),
                ] if root == "constructionAutomation" && directory == "targetStock" => id.clone(),
                _ => panic!("unexpected batch target patch"),
            })
            .collect::<Vec<_>>();
        assert_eq!(expanded_ids, unlocked_ids);

        let live_result = live.apply_player_authority_command(&command).unwrap();
        let replay_result = replay.apply_command(&command).unwrap();
        assert_eq!(live_result, replay_result);
        assert_eq!(live.revision, revision + 1);
        assert!(live_result.changed_entity_ids.is_empty());
        assert!(live_result.changed_belt_ids.is_empty());
        assert!(live_result.topology_dirty);
        assert_eq!(
            live.canonical_sha256().unwrap(),
            replay.canonical_sha256().unwrap()
        );
        for target_id in &unlocked_ids {
            assert_eq!(
                live.base_value()["constructionAutomation"]["targetStock"][target_id],
                3,
                "{target_id}"
            );
        }
        assert_eq!(
            live.base_value()["constructionAutomation"]["targetStock"]["logistics_vessel"],
            73
        );
        assert_eq!(
            live.base_value()["constructionAutomation"]["targetStock"]["orbital_cargo_terminal"],
            before_target_stock["orbital_cargo_terminal"]
        );
        assert_eq!(
            live.base_value()["constructionAutomation"]["targetStock"]["future_opaque_target"],
            before_target_stock["future_opaque_target"]
        );
        let mut after_non_policy = live.base_value()["constructionAutomation"].clone();
        after_non_policy
            .as_object_mut()
            .unwrap()
            .remove("targetStock");
        assert_eq!(after_non_policy, before_non_policy);
        assert_eq!(
            live.base_value()["constructionAutomation"]["jobs"],
            jobs_before
        );
        assert_eq!(
            live.base_value()["constructionAutomation"]["quantumMaterialBuffer"],
            quantum_buffers_before
        );
        assert_eq!(
            construction_automation_material_snapshot(&live),
            material_before
        );

        let unchanged_revision = live.revision;
        let unchanged_hash = live.canonical_sha256().unwrap();
        let unchanged = construction_automation_intent_command(
            unchanged_revision,
            serde_json::json!({
                "kind": "batchBuildingTargetStock",
                "target": 3
            }),
        );
        assert!(live.apply_player_authority_command(&unchanged).is_err());
        assert_eq!(live.revision, unchanged_revision);
        assert_eq!(live.canonical_sha256().unwrap(), unchanged_hash);
    }

    #[test]
    fn construction_automation_batch_building_target_rejects_forged_or_untrusted_intents() {
        let mut limited = player_construction_automation_state();
        limited.base_value_mut()["research"]["completedTechIds"] =
            serde_json::json!(["construction_automation"]);

        let mut registry_drift = player_construction_automation_state();
        registry_drift.catalog = Arc::new(player_construction_automation_catalog_for_registry(
            "catalog-registry-drift",
        ));

        let cases = [
            (
                player_construction_automation_state(),
                serde_json::json!({
                    "kind": "batchBuildingTargetStock",
                    "target": 0
                }),
            ),
            (
                limited,
                serde_json::json!({
                    "kind": "batchBuildingTargetStock",
                    "target": 101
                }),
            ),
            (
                player_construction_automation_state(),
                serde_json::json!({
                    "kind": "batchBuildingTargetStock",
                    "target": 10,
                    "targetIds": ["arc_smelter"]
                }),
            ),
            (
                player_construction_automation_state_for_registry("modded-construction-automation"),
                serde_json::json!({
                    "kind": "batchBuildingTargetStock",
                    "target": 10
                }),
            ),
            (
                registry_drift,
                serde_json::json!({
                    "kind": "batchBuildingTargetStock",
                    "target": 10
                }),
            ),
        ];

        for (mut state, intent) in cases {
            let revision = state.revision;
            let before = state.canonical_sha256().unwrap();
            let base_before = state.base_value().clone();
            let command = construction_automation_intent_command(revision, intent);
            assert!(state.apply_player_authority_command(&command).is_err());
            assert_eq!(state.revision, revision);
            assert_eq!(state.canonical_sha256().unwrap(), before);
            assert_eq!(state.base_value(), &base_before);
        }
    }

    #[test]
    fn construction_automation_target_normalizes_with_one_available_center() {
        let mut state = player_construction_automation_state();
        state.base_value_mut()["research"]["completedTechIds"] = serde_json::json!([
            "construction_automation",
            "construction_capacity_1",
            "interstellar_logistics"
        ]);
        let center_index = *state.entity_index.get("construction-center-a").unwrap();
        let mut center = state.parse_entity(center_index).unwrap();
        center["interactionLocked"] = Value::from(true);
        state.replace_entity_raw(
            center_index,
            Arc::<str>::from(serde_json::to_string(&center).unwrap()),
        );
        let before = construction_automation_material_snapshot(&state);
        let command = construction_automation_intent_command(
            state.revision,
            serde_json::json!({
                "kind": "targetStock",
                "targetId": "logistics_vessel",
                "target": 501
            }),
        );
        let result = state.apply_player_authority_command(&command).unwrap();
        assert_eq!(
            state.base_value()["constructionAutomation"]["targetStock"]["logistics_vessel"],
            500
        );
        assert!(result.changed_entity_ids.is_empty());
        assert!(result.changed_belt_ids.is_empty());
        assert!(result.topology_dirty);
        assert_eq!(construction_automation_material_snapshot(&state), before);
    }

    #[test]
    fn construction_automation_target_cancels_against_owned_stock_not_previous_policy() {
        let mut state = player_construction_automation_state();
        assert_eq!(state.base_value()["construction"]["arc_smelter"], 4);
        assert_eq!(
            state.base_value()["constructionAutomation"]["targetStock"]["arc_smelter"],
            2
        );
        let command = construction_automation_intent_command(
            state.revision,
            serde_json::json!({
                "kind": "targetStock",
                "targetId": "arc_smelter",
                "target": 3
            }),
        );
        let result = state.apply_player_authority_command(&command).unwrap();
        assert!(result.topology_dirty);
        assert_eq!(
            state.base_value()["constructionAutomation"]["targetStock"]["arc_smelter"],
            3
        );
        assert_eq!(
            state.base_value()["constructionAutomation"]["jobs"]
                .as_object()
                .unwrap()
                .keys()
                .cloned()
                .collect::<Vec<_>>(),
            vec!["construction-center-unrelated".to_owned()]
        );
        assert!(
            state.base_value()["constructionAutomation"]
                .get("quantumMaterialBuffer")
                .is_none()
        );
    }

    #[test]
    fn construction_automation_quantum_refund_requires_order_independence() {
        let mut ambiguous = construction_quantum_refund_order_fixture(5, "ashen");
        let ambiguous_revision = ambiguous.revision;
        let ambiguous_hash = ambiguous.canonical_sha256().unwrap();
        let ambiguous_material = construction_owned_material_total(&ambiguous, "iron_ingot");
        let error = ambiguous
            .apply_player_authority_command(&construction_automation_intent_command(
                ambiguous_revision,
                serde_json::json!({
                    "kind": "targetStock",
                    "targetId": "arc_smelter",
                    "target": 0
                }),
            ))
            .unwrap_err();
        assert!(
            error
                .to_string()
                .contains("order is ambiguous across planets")
        );
        assert_eq!(ambiguous.revision, ambiguous_revision);
        assert_eq!(ambiguous.canonical_sha256().unwrap(), ambiguous_hash);
        assert_eq!(
            construction_owned_material_total(&ambiguous, "iron_ingot"),
            ambiguous_material
        );

        for (label, free_capacity, a_center_planet_id) in [
            ("full-acceptance", 10, "ashen"),
            ("zero-acceptance", 0, "ashen"),
            ("same-planet-partial-acceptance", 5, "home"),
        ] {
            let mut live =
                construction_quantum_refund_order_fixture(free_capacity, a_center_planet_id);
            let expected = apply_reverse_js_quantum_cancel_oracle(live.clone());
            let before = construction_owned_material_total(&live, "iron_ingot");
            let revision = live.revision;
            let result = live
                .apply_player_authority_command(&construction_automation_intent_command(
                    revision,
                    serde_json::json!({
                        "kind": "targetStock",
                        "targetId": "arc_smelter",
                        "target": 0
                    }),
                ))
                .unwrap_or_else(|error| panic!("{label}: {error:#}"));
            assert!(result.topology_dirty, "{label}");
            assert_eq!(live.base_value(), expected.base_value(), "{label}");
            assert_eq!(
                live.canonical_sha256().unwrap(),
                expected.canonical_sha256().unwrap(),
                "{label}"
            );
            assert_eq!(
                construction_owned_material_total(&live, "iron_ingot"),
                before,
                "{label}"
            );
        }
    }

    #[test]
    fn construction_automation_semantic_intents_fail_closed_on_untrusted_or_locked_state() {
        let baseline = player_construction_automation_state();
        let revision = baseline.revision;
        let mut cases = Vec::<(CoreState, SimulationCommandPatch)>::new();

        cases.push((
            player_construction_automation_state(),
            construction_automation_intent_command(
                revision - 1,
                serde_json::json!({ "kind": "enabled", "enabled": true }),
            ),
        ));
        cases.push((
            player_construction_automation_state_for_registry("modded-construction-automation"),
            construction_automation_intent_command(
                revision,
                serde_json::json!({ "kind": "enabled", "enabled": true }),
            ),
        ));
        cases.push((
            player_construction_automation_state(),
            construction_automation_intent_command(
                revision,
                serde_json::json!({
                    "kind": "targetStock",
                    "targetId": "missing_mod_target",
                    "target": 1
                }),
            ),
        ));

        let mut locked_center = player_construction_automation_state();
        for center_id in ["construction-center-a", "construction-center-b"] {
            let center_index = *locked_center.entity_index.get(center_id).unwrap();
            let mut center = locked_center.parse_entity(center_index).unwrap();
            center["interactionLocked"] = Value::from(true);
            locked_center.replace_entity_raw(
                center_index,
                Arc::<str>::from(serde_json::to_string(&center).unwrap()),
            );
        }
        cases.push((
            locked_center,
            construction_automation_intent_command(
                revision,
                serde_json::json!({ "kind": "enabled", "enabled": true }),
            ),
        ));

        let mut locked_feature = player_construction_automation_state();
        locked_feature.base_value_mut()["research"]["completedTechIds"] = serde_json::json!([]);
        cases.push((
            locked_feature,
            construction_automation_intent_command(
                revision,
                serde_json::json!({ "kind": "enabled", "enabled": true }),
            ),
        ));

        let mut locked_target = player_construction_automation_state();
        locked_target.base_value_mut()["research"]["completedTechIds"] =
            serde_json::json!(["construction_automation"]);
        cases.push((
            locked_target,
            construction_automation_intent_command(
                revision,
                serde_json::json!({
                    "kind": "targetStock",
                    "targetId": "conveyor_belt_mk1",
                    "target": 1
                }),
            ),
        ));

        let mut locked_mode = player_construction_automation_state();
        locked_mode.base_value_mut()["mode"] = Value::from("speedrun");
        cases.push((
            locked_mode,
            construction_automation_intent_command(
                revision,
                serde_json::json!({
                    "kind": "targetStock",
                    "targetId": "orbital_cargo_terminal",
                    "target": 1
                }),
            ),
        ));

        let limited = player_construction_automation_state();
        cases.push((
            limited,
            construction_automation_intent_command(
                revision,
                serde_json::json!({
                    "kind": "targetStock",
                    "targetId": "arc_smelter",
                    "target": 100000001
                }),
            ),
        ));

        let mut refund_overflow = player_construction_automation_state();
        refund_overflow.base_value_mut()["tray"]["iron_ingot"] =
            Value::from(MAX_JAVASCRIPT_SAFE_INTEGER);
        cases.push((
            refund_overflow,
            construction_automation_intent_command(
                revision,
                serde_json::json!({
                    "kind": "targetStock",
                    "targetId": "arc_smelter",
                    "target": 0
                }),
            ),
        ));

        let mut quantum_disabled = player_construction_automation_state();
        quantum_disabled.base_value_mut()["quantumLogisticsNetwork"]["enabled"] =
            Value::from(false);
        cases.push((
            quantum_disabled,
            construction_automation_intent_command(
                revision,
                serde_json::json!({
                    "kind": "quantumSupplyEnabled",
                    "enabled": true
                }),
            ),
        ));

        cases.push((
            player_construction_automation_state(),
            construction_automation_intent_command(
                revision,
                serde_json::json!({ "kind": "enabled", "enabled": false }),
            ),
        ));

        let mut mixed = construction_automation_intent_command(
            revision,
            serde_json::json!({ "kind": "enabled", "enabled": true }),
        );
        mixed.top_level_changes.push(ValuePatch {
            path: vec![PathSegment::Key("totalProduced".to_owned())],
            operation: "set".to_owned(),
            value: Some(serde_json::json!({ "iron_ingot": 999_999 })),
        });
        cases.push((player_construction_automation_state(), mixed));

        for (mut state, command) in cases {
            let before = state.canonical_sha256().unwrap();
            let material_before = construction_automation_material_snapshot(&state);
            assert!(state.apply_player_authority_command(&command).is_err());
            assert_eq!(state.revision, revision);
            assert_eq!(state.canonical_sha256().unwrap(), before);
            assert_eq!(
                construction_automation_material_snapshot(&state),
                material_before
            );
        }
    }

    fn player_energy_exchanger_catalog_for_registry(registry_fingerprint: &str) -> RuntimeCatalog {
        let mut snapshot = serde_json::to_value(
            player_command_catalog_for_registry(registry_fingerprint).snapshot,
        )
        .unwrap();
        snapshot["items"].as_array_mut().unwrap().extend([
            serde_json::json!({ "id": "accumulator", "kind": "solid" }),
            serde_json::json!({ "id": "charged_accumulator", "kind": "solid" }),
        ]);
        snapshot["buildings"]
            .as_array_mut()
            .unwrap()
            .push(serde_json::json!({
                "id": "energy_exchanger",
                "kind": "power",
                "speed": 1,
                "inputCapacity": 100,
                "outputCapacity": 100,
                "powerGenerationKw": 45000,
                "powerChargeKw": 45000,
                "energyCapacityMj": 90
            }));
        snapshot["recipes"].as_array_mut().unwrap().extend([
            serde_json::json!({
                "id": "accumulator_charge",
                "buildingId": "energy_exchanger",
                "duration": 2,
                "requiredTechId": "energy_storage",
                "inputs": [{ "itemId": "accumulator", "amount": 1 }],
                "outputs": [{ "itemId": "charged_accumulator", "amount": 1 }]
            }),
            serde_json::json!({
                "id": "accumulator_discharge",
                "buildingId": "energy_exchanger",
                "duration": 2,
                "requiredTechId": "energy_storage",
                "inputs": [{ "itemId": "charged_accumulator", "amount": 1 }],
                "outputs": [{ "itemId": "accumulator", "amount": 1 }]
            }),
        ]);
        snapshot["constructions"]
            .as_array_mut()
            .unwrap()
            .push(serde_json::json!({
                "id": "energy_exchanger",
                "outputAmount": 1,
                "requiredTechId": "energy_storage",
                "costs": [{ "itemId": "iron_ingot", "amount": 1 }]
            }));
        snapshot["technologies"]
            .as_array_mut()
            .unwrap()
            .push(serde_json::json!({
                "id": "energy_storage",
                "costs": [{ "itemId": "electromagnetic_matrix", "amount": 3 }],
                "prerequisites": []
            }));
        RuntimeCatalog::validate(
            serde_json::from_value(snapshot).unwrap(),
            registry_fingerprint,
        )
        .unwrap()
    }

    fn player_energy_exchanger_entity() -> String {
        serde_json::json!({
            "id": "exchanger-a",
            "kind": "power",
            "planetId": "home",
            "position": { "x": 7.0, "y": 2.0 },
            "interactionLocked": false,
            "buildingId": "energy_exchanger",
            "powerGridId": "grid-a",
            "generationPriority": 2,
            "recipeId": "accumulator_charge",
            "energyMode": "charge",
            "storedEnergyMj": PLAYER_ENERGY_EPSILON,
            "machineCount": 2,
            "minerCount": 0,
            "inputs": { "accumulator": 2.4 },
            "outputs": { "charged_accumulator": 3.6 },
            "progress": 0.75,
            "powerInputKw": 42000,
            "powerOutputKw": 17000,
            "routingCursor": 0,
            "utilization": 0.5,
            "productionRate": 0.25
        })
        .to_string()
    }

    fn player_energy_exchanger_belt(id: &str, source: &str, target: &str, lanes: u64) -> String {
        serde_json::json!({
            "id": id,
            "planetId": "home",
            "source": source,
            "target": target,
            "itemId": "accumulator",
            "lanes": lanes,
            "tier": 1,
            "sorterTier": 1,
            "progress": 0,
            "priority": 1,
            "stackSize": 1,
            "monitorEnabled": false,
            "routeMode": "auto",
            "lastFlow": 0
        })
        .to_string()
    }

    fn player_energy_exchanger_state_for_registry(registry_fingerprint: &str) -> CoreState {
        let seed = player_command_state_for_registry(registry_fingerprint);
        let mut base = seed.base_value().clone();
        base.get_mut("tray")
            .and_then(Value::as_object_mut)
            .unwrap()
            .extend([
                ("accumulator".to_owned(), Value::from(7)),
                ("charged_accumulator".to_owned(), Value::from(11)),
            ]);
        base["research"]["completedTechIds"] = serde_json::json!(["energy_storage"]);
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
                player_energy_exchanger_entity(),
            ],
            vec![
                player_command_belt(),
                player_energy_exchanger_belt("belt-exchanger-in", "smelter-a", "exchanger-a", 2),
                player_energy_exchanger_belt("belt-exchanger-out", "exchanger-a", "ejector-a", 3),
            ],
            player_energy_exchanger_catalog_for_registry(registry_fingerprint),
        )
        .unwrap()
    }

    fn player_energy_exchanger_state() -> CoreState {
        player_energy_exchanger_state_for_registry(EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT)
    }

    fn energy_exchanger_mode_command(base_revision: u64, target: Value) -> SimulationCommandPatch {
        entity_leaf_command(base_revision, "exchanger-a", "energyMode", target)
    }

    fn player_fuel_catalog_for_registry(registry_fingerprint: &str) -> RuntimeCatalog {
        let mut snapshot = serde_json::to_value(
            player_command_catalog_for_registry(registry_fingerprint).snapshot,
        )
        .unwrap();
        snapshot["items"].as_array_mut().unwrap().extend([
            serde_json::json!({ "id": "coal", "kind": "solid", "fuelEnergyMj": 2.7 }),
            serde_json::json!({ "id": "fire_ice", "kind": "solid", "fuelEnergyMj": 4.8 }),
            serde_json::json!({ "id": "crude_oil", "kind": "fluid", "fuelEnergyMj": 4.0 }),
            serde_json::json!({ "id": "energetic_graphite", "kind": "solid", "fuelEnergyMj": 6.3 }),
            serde_json::json!({ "id": "refined_oil", "kind": "fluid", "fuelEnergyMj": 4.4 }),
            serde_json::json!({ "id": "hydrogen", "kind": "fluid", "fuelEnergyMj": 8.0 }),
            serde_json::json!({ "id": "hydrogen_fuel_rod", "kind": "solid", "fuelEnergyMj": 54.0 }),
            serde_json::json!({ "id": "deuteron_fuel_rod", "kind": "solid", "fuelEnergyMj": 600.0 }),
            serde_json::json!({ "id": "antimatter_fuel_rod", "kind": "solid", "fuelEnergyMj": 7_200.0 }),
        ]);
        snapshot["buildings"]
            .as_array_mut()
            .unwrap()
            .push(serde_json::json!({
                "id": "thermal_power_plant",
                "kind": "power",
                "speed": 1,
                "inputCapacity": 120,
                "outputCapacity": 0,
                "powerGenerationKw": 2_160,
                "fuelItemIds": BUILTIN_THERMAL_FUEL_ITEMS,
                "fuelEfficiency": 0.8
            }));
        snapshot["recipes"]
            .as_array_mut()
            .unwrap()
            .push(serde_json::json!({
                "id": "energetic_graphite",
                "buildingId": "arc_smelter",
                "duration": 2,
                "requiredTechId": "energy_matrix",
                "inputs": [{ "itemId": "coal", "amount": 2 }],
                "outputs": [{ "itemId": "energetic_graphite", "amount": 1 }]
            }));
        snapshot["constructions"]
            .as_array_mut()
            .unwrap()
            .push(serde_json::json!({
                "id": "thermal_power_plant",
                "outputAmount": 1,
                "requiredTechId": "thermal_power",
                "costs": [{ "itemId": "iron_ingot", "amount": 1 }]
            }));
        snapshot["technologies"]
            .as_array_mut()
            .unwrap()
            .push(serde_json::json!({
                "id": "energy_matrix",
                "costs": [{ "itemId": "electromagnetic_matrix", "amount": 3 }],
                "prerequisites": ["thermal_power"]
            }));
        RuntimeCatalog::validate(
            serde_json::from_value(snapshot).unwrap(),
            registry_fingerprint,
        )
        .unwrap()
    }

    fn player_fuel_entity() -> String {
        serde_json::json!({
            "id": "thermal-a",
            "kind": "power",
            "planetId": "home",
            "position": { "x": 7.0, "y": 2.0 },
            "interactionLocked": false,
            "buildingId": "thermal_power_plant",
            "powerGridId": "grid-a",
            "generationPriority": 1,
            "fuelItemId": "coal",
            "fuelRemainingMj": 3.25,
            "machineCount": 2,
            "minerCount": 0,
            "inputs": { "coal": 2.4, "logistics_drone": 1.9 },
            "outputs": { "iron_ingot": 4 },
            "progress": 0.75,
            "powerInputKw": 19,
            "powerOutputKw": 1_700,
            "routingCursor": 0,
            "utilization": 0.5,
            "productionRate": 0.25
        })
        .to_string()
    }

    fn player_fuel_belt(id: &str, source: &str, target: &str, lanes: u64) -> String {
        serde_json::json!({
            "id": id,
            "planetId": "home",
            "source": source,
            "target": target,
            "itemId": "coal",
            "lanes": lanes,
            "tier": 1,
            "sorterTier": 1,
            "progress": 0,
            "priority": 1,
            "stackSize": 1,
            "monitorEnabled": false,
            "routeMode": "auto",
            "lastFlow": 0
        })
        .to_string()
    }

    fn player_fuel_state_for_registry(registry_fingerprint: &str) -> CoreState {
        let seed = player_command_state_for_registry(registry_fingerprint);
        let mut base = seed.base_value().clone();
        base.get_mut("tray")
            .and_then(Value::as_object_mut)
            .unwrap()
            .insert("coal".to_owned(), Value::from(7));
        base["research"]["completedTechIds"] =
            serde_json::json!(["thermal_power", "energy_matrix"]);
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
                player_fuel_entity(),
            ],
            vec![
                player_command_belt(),
                player_fuel_belt("belt-fuel-in", "smelter-a", "thermal-a", 2),
                player_fuel_belt("belt-fuel-out", "thermal-a", "ejector-a", 3),
            ],
            player_fuel_catalog_for_registry(registry_fingerprint),
        )
        .unwrap()
    }

    fn player_fuel_state() -> CoreState {
        player_fuel_state_for_registry(EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT)
    }

    fn fuel_item_command(base_revision: u64, target: Value) -> SimulationCommandPatch {
        entity_leaf_command(base_revision, "thermal-a", "fuelItemId", target)
    }

    fn player_technology_layout_state() -> CoreState {
        let mut state = player_command_state();
        state.base_value_mut()["settings"]["technologyLayout"] = Value::from("standard");
        state
    }

    fn player_research_state() -> CoreState {
        let mut state = player_command_state();
        state.base_value_mut().insert(
            "research".to_owned(),
            serde_json::json!({
                "selectedTechId": "research_speed_2",
                "pausedTechId": null,
                "queuedTechIds": [],
                "progressByTech": {
                    "research_speed_2": { "gravity_matrix": 9 }
                },
                "completedTechIds": [
                    "gravity_matrix",
                    "research_speed_1",
                    "universe_matrix"
                ]
            }),
        );
        state.base_value_mut().insert(
            "endgame".to_owned(),
            serde_json::json!({
                "activeInfiniteResearchId": null,
                "autoResearch": false,
                "infiniteResearch": {
                    "matrix_compression": { "level": 2, "progress": "17" },
                    "vein_utilization": { "level": 1, "progress": "0" },
                    "galactic_logistics": { "level": 3, "progress": "0" },
                    "stellar_harnessing": { "level": 4, "progress": "0" },
                    "continuum_simulation": { "level": 0, "progress": "0" }
                }
            }),
        );
        state
    }

    fn player_quantum_capacity_state() -> CoreState {
        let mut state = player_command_state();
        state.base_value_mut().insert(
            "quantumLogisticsNetwork".to_owned(),
            serde_json::json!({
                "enabled": true,
                "inventory": { "iron_ore": "25000" },
                "itemCapacities": { "iron_ore": "100000" },
                "routingCursors": {},
                "uploadRoutingCursors": {}
            }),
        );
        state
    }

    fn quantum_capacity_command(
        revision: u64,
        item_id: &str,
        target: Value,
    ) -> SimulationCommandPatch {
        top_level_leaf_command(
            revision,
            &["quantumLogisticsNetwork", "itemCapacities", item_id],
            target,
        )
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

    fn player_time_warp_state_for_registry(registry_fingerprint: &str) -> CoreState {
        let mut state = player_command_state_for_registry(registry_fingerprint);
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

    fn player_time_warp_state() -> CoreState {
        player_time_warp_state_for_registry(EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT)
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

    fn player_station_configuration_state_for_registry(registry_fingerprint: &str) -> CoreState {
        let mut state = player_command_state_for_registry(registry_fingerprint);
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
            |(offset, (id, building_id, interaction_locked, station_slots))| {
                let primary = station_slots.as_array().and_then(|slots| {
                    slots.iter().find_map(|slot| {
                        let item_id = slot.get("itemId")?.as_str()?;
                        Some((
                            item_id.to_owned(),
                            slot.get("localMode")?.as_str()?.to_owned(),
                            slot.get("remoteMode")?.as_str()?.to_owned(),
                        ))
                    })
                });
                let stored_item_id = primary
                    .as_ref()
                    .map(|(item_id, _, _)| Value::from(item_id.clone()))
                    .unwrap_or(Value::Null);
                let station_mode = primary.as_ref().map_or("supply", |(_, local, remote)| {
                    if (building_id == "planetary_logistics_station" && local == "demand")
                        || (building_id == "interstellar_logistics_station" && remote == "demand")
                    {
                        "demand"
                    } else {
                        "supply"
                    }
                });
                AddedRecord {
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
                        "storedItemId": stored_item_id,
                        "stationMode": station_mode,
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
                }
            },
        )
        .collect();
        state.apply_command(&addition).unwrap();
        state
    }

    fn player_station_configuration_state() -> CoreState {
        player_station_configuration_state_for_registry(EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT)
    }

    fn station_fleet_conservation_fixture() -> Value {
        serde_json::from_str(include_str!(
            "../../../tests/fixtures/synthetic/station-fleet-conservation-v1.json"
        ))
        .unwrap()
    }

    fn player_station_fleet_conservation_state_for_registry(
        registry_fingerprint: &str,
    ) -> CoreState {
        let fixture = station_fleet_conservation_fixture();
        let mut state = player_station_configuration_state_for_registry(registry_fingerprint);
        state.base_value_mut()["portableFleet"] = fixture["portableFleet"].clone();
        state.base_value_mut()["tray"]["logistics_drone"] =
            fixture["traySentinel"]["logistics_drone"].clone();
        state.base_value_mut()["tray"]["logistics_vessel"] =
            fixture["traySentinel"]["logistics_vessel"].clone();

        let target_id = fixture["targetStationId"].as_str().unwrap();
        let peer_id = fixture["peerStationId"].as_str().unwrap();
        let target_index = *state.entity_index.get(target_id).unwrap();
        let peer_index = *state.entity_index.get(peer_id).unwrap();
        let mut target = state.parse_entity(target_index).unwrap();
        target["stationDrones"] = fixture["station"]["stationDrones"].clone();
        target["stationVessels"] = fixture["station"]["stationVessels"].clone();
        target["stationProgress"] = fixture["station"]["stationProgress"].clone();
        target["stationPeerId"] = Value::from(peer_id);
        let mut peer = state.parse_entity(peer_index).unwrap();
        peer["stationProgress"] = fixture["peer"]["stationProgress"].clone();
        peer["stationRoutes"] = fixture["busyRoutes"].clone();
        state.replace_entity_raw(target_index, serde_json::to_string(&target).unwrap().into());
        state.replace_entity_raw(peer_index, serde_json::to_string(&peer).unwrap().into());
        state.rebuild_indexes().unwrap();
        state
    }

    fn player_station_fleet_conservation_state() -> CoreState {
        player_station_fleet_conservation_state_for_registry(
            EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT,
        )
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

    fn station_slot_item_route(
        id: &str,
        peer_id: &str,
        cargo: u64,
        scope: Option<&str>,
        progress: f64,
        vehicle_station_id: &str,
        warp: (bool, u64),
    ) -> Value {
        let mut route = serde_json::json!({
            "id": id,
            "slotIndex": 0,
            "peerId": peer_id,
            "itemId": "iron_ore",
            "scope": scope,
            "cargo": cargo,
            "vehicleCount": 1,
            "progress": progress,
            "duration": 10,
            "requiresWarp": warp.0,
            "warpersPerVessel": warp.1,
            "vehicleStationId": vehicle_station_id,
            "modPayload": { "owner": "pack:item-route", "revision": id }
        });
        if scope.is_none() {
            route
                .as_object_mut()
                .expect("the route fixture is an object")
                .remove("scope");
        }
        route
    }

    fn station_slot_item_belt(
        id: &str,
        source: &str,
        target: &str,
        item_id: &str,
        lanes: u64,
    ) -> Value {
        serde_json::json!({
            "id": id,
            "planetId": "home",
            "source": source,
            "target": target,
            "itemId": item_id,
            "lanes": lanes,
            "tier": 1,
            "sorterTier": 1,
            "progress": 0,
            "priority": 1,
            "stackSize": 1,
            "monitorEnabled": false,
            "routeMode": "auto",
            "lastFlow": 0,
            "modPayload": { "owner": "pack:item-belt", "revision": id }
        })
    }

    fn player_station_slot_item_state() -> CoreState {
        let mut state = player_station_configuration_state();
        let target_routes = serde_json::json!([
            station_slot_item_route(
                "slot-item-target-remote",
                "station-remote",
                100,
                Some("remote"),
                0.8,
                "station-ils",
                (true, 2),
            ),
            station_slot_item_route(
                "slot-item-target-legacy",
                "station-remote",
                50,
                None,
                0.6,
                "station-ils",
                (false, 0),
            )
        ]);
        let peer_routes = serde_json::json!([station_slot_item_route(
            "slot-item-peer-local",
            "station-ils",
            10,
            Some("local"),
            0.9,
            "station-remote",
            (true, 1),
        )]);
        let mut target_slots = station_slots(Some("iron_ore"));
        target_slots[0]["modSlotPayload"] =
            serde_json::json!({ "owner": "pack:slot", "revision": 41 });
        let mut setup = empty_player_command(state.revision);
        setup.changed_entities = vec![
            RecordPatch {
                id: "station-ils".to_owned(),
                changes: vec![
                    ValuePatch {
                        path: vec![PathSegment::Key("stationSlots".to_owned())],
                        operation: "set".to_owned(),
                        value: Some(target_slots),
                    },
                    ValuePatch {
                        path: vec![PathSegment::Key("inputs".to_owned())],
                        operation: "set".to_owned(),
                        value: Some(serde_json::json!({ "iron_ore": 7 })),
                    },
                    ValuePatch {
                        path: vec![PathSegment::Key("outputs".to_owned())],
                        operation: "set".to_owned(),
                        value: Some(serde_json::json!({ "iron_ore": 11 })),
                    },
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
                        path: vec![PathSegment::Key("outputs".to_owned())],
                        operation: "set".to_owned(),
                        value: Some(serde_json::json!({ "iron_ore": 150 })),
                    },
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
        setup.added_belts = vec![
            AddedRecord {
                index: 1,
                value: station_slot_item_belt(
                    "belt-station-in",
                    "smelter-a",
                    "station-ils",
                    "iron_ore",
                    2,
                ),
            },
            AddedRecord {
                index: 2,
                value: station_slot_item_belt(
                    "belt-station-out",
                    "station-ils",
                    "smelter-a",
                    "iron_ore",
                    3,
                ),
            },
            AddedRecord {
                index: 3,
                value: station_slot_item_belt(
                    "belt-station-keep",
                    "station-ils",
                    "smelter-a",
                    "iron_ingot",
                    1,
                ),
            },
        ];
        state.apply_command(&setup).unwrap();
        state
    }

    fn station_slot_item_assignment_command(state: &CoreState) -> SimulationCommandPatch {
        let mut command = empty_player_command(state.revision);
        command.top_level_changes = vec![
            ValuePatch {
                path: vec![
                    PathSegment::Key("construction".to_owned()),
                    PathSegment::Key("conveyor_belt_mk1".to_owned()),
                ],
                operation: "set".to_owned(),
                value: Some(Value::from(10)),
            },
            ValuePatch {
                path: vec![
                    PathSegment::Key("tray".to_owned()),
                    PathSegment::Key("iron_ore".to_owned()),
                ],
                operation: "set".to_owned(),
                value: Some(Value::from(18)),
            },
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
                    ValuePatch {
                        path: vec![
                            PathSegment::Key("inputs".to_owned()),
                            PathSegment::Key("iron_ore".to_owned()),
                        ],
                        operation: "set".to_owned(),
                        value: Some(Value::from(0)),
                    },
                    ValuePatch {
                        path: vec![
                            PathSegment::Key("outputs".to_owned()),
                            PathSegment::Key("iron_ore".to_owned()),
                        ],
                        operation: "set".to_owned(),
                        value: Some(Value::from(0)),
                    },
                    station_slot_leaf(0, "itemId", Value::from("iron_ingot")),
                    station_slot_leaf(0, "remoteMode", Value::from("supply")),
                    ValuePatch {
                        path: vec![PathSegment::Key("storedItemId".to_owned())],
                        operation: "set".to_owned(),
                        value: Some(Value::from("iron_ingot")),
                    },
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
                    ValuePatch {
                        path: vec![PathSegment::Key("stationPeerId".to_owned())],
                        operation: "set".to_owned(),
                        value: None,
                    },
                    ValuePatch {
                        path: vec![PathSegment::Key("stationRoutes".to_owned())],
                        operation: "set".to_owned(),
                        value: Some(Value::Array(Vec::new())),
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
                        value: Some(Value::Array(Vec::new())),
                    },
                    ValuePatch {
                        path: vec![PathSegment::Key("stationProgress".to_owned())],
                        operation: "set".to_owned(),
                        value: Some(Value::from(0)),
                    },
                ],
            },
        ];
        command.removed_belt_ids =
            vec!["belt-station-in".to_owned(), "belt-station-out".to_owned()];
        command
    }

    fn station_slot_item_removal_command(state: &CoreState) -> SimulationCommandPatch {
        let mut command = empty_player_command(state.revision);
        command.changed_entities = vec![RecordPatch {
            id: "station-ils".to_owned(),
            changes: vec![
                ValuePatch {
                    path: vec![
                        PathSegment::Key("inputs".to_owned()),
                        PathSegment::Key("iron_ore".to_owned()),
                    ],
                    operation: "set".to_owned(),
                    value: Some(Value::from(0)),
                },
                ValuePatch {
                    path: vec![
                        PathSegment::Key("outputs".to_owned()),
                        PathSegment::Key("iron_ore".to_owned()),
                    ],
                    operation: "set".to_owned(),
                    value: Some(Value::from(0)),
                },
                ValuePatch {
                    path: vec![
                        PathSegment::Key("stationSlots".to_owned()),
                        PathSegment::Index(0),
                        PathSegment::Key("itemId".to_owned()),
                    ],
                    operation: "set".to_owned(),
                    value: None,
                },
                station_slot_leaf(0, "localMode", Value::from("storage")),
                station_slot_leaf(0, "remoteMode", Value::from("storage")),
                ValuePatch {
                    path: vec![PathSegment::Key("storedItemId".to_owned())],
                    operation: "set".to_owned(),
                    value: None,
                },
                ValuePatch {
                    path: vec![PathSegment::Key("stationPeerId".to_owned())],
                    operation: "set".to_owned(),
                    value: None,
                },
            ],
        }];
        command
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

    fn station_slot_mode_intent_command(
        revision: u64,
        entity_id: &str,
        slot_index: Value,
        scope: &str,
        mode: &str,
    ) -> SimulationCommandPatch {
        let mut command = empty_player_command(revision);
        command.changed_entities = vec![RecordPatch {
            id: entity_id.to_owned(),
            changes: vec![ValuePatch {
                path: vec![
                    PathSegment::Key("stationSlotMode".to_owned()),
                    PathSegment::Key("intent".to_owned()),
                ],
                operation: "set".to_owned(),
                value: Some(serde_json::json!({
                    "slotIndex": slot_index,
                    "scope": scope,
                    "mode": mode,
                })),
            }],
        }];
        command
    }

    fn station_slot_item_intent_command(
        revision: u64,
        entity_id: &str,
        slot_index: Value,
        item_id: Value,
    ) -> SimulationCommandPatch {
        let mut command = empty_player_command(revision);
        command.changed_entities = vec![RecordPatch {
            id: entity_id.to_owned(),
            changes: vec![ValuePatch {
                path: vec![
                    PathSegment::Key("stationSlotItem".to_owned()),
                    PathSegment::Key("intent".to_owned()),
                ],
                operation: "set".to_owned(),
                value: Some(serde_json::json!({
                    "slotIndex": slot_index,
                    "itemId": item_id,
                })),
            }],
        }];
        command
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

    fn station_fleet_intent_command(
        revision: u64,
        entity_id: &str,
        kind: &str,
        target_count: Value,
    ) -> SimulationCommandPatch {
        let mut command = empty_player_command(revision);
        command.changed_entities = vec![RecordPatch {
            id: entity_id.to_owned(),
            changes: vec![ValuePatch {
                path: vec![
                    PathSegment::Key("stationFleetTarget".to_owned()),
                    PathSegment::Key("intent".to_owned()),
                ],
                operation: "set".to_owned(),
                value: Some(serde_json::json!({
                    "kind": kind,
                    "targetCount": target_count,
                })),
            }],
        }];
        command
    }

    fn station_warper_intent_command(
        revision: u64,
        entity_id: &str,
        delta: Value,
    ) -> SimulationCommandPatch {
        let mut command = empty_player_command(revision);
        command.changed_entities = vec![RecordPatch {
            id: entity_id.to_owned(),
            changes: vec![ValuePatch {
                path: vec![
                    PathSegment::Key("stationWarperInventory".to_owned()),
                    PathSegment::Key("intent".to_owned()),
                ],
                operation: "set".to_owned(),
                value: Some(serde_json::json!({ "delta": delta })),
            }],
        }];
        command
    }

    fn station_fleet_conservation_case(name: &str) -> Value {
        station_fleet_conservation_fixture()["cases"]
            .as_array()
            .unwrap()
            .iter()
            .find(|case| case["name"].as_str() == Some(name))
            .unwrap()
            .clone()
    }

    fn station_fleet_conservation_command(
        state: &CoreState,
        test_case: &Value,
    ) -> SimulationCommandPatch {
        let fixture = station_fleet_conservation_fixture();
        let field = match test_case["kind"].as_str().unwrap() {
            "drone" => "stationDrones",
            "vessel" => "stationVessels",
            other => panic!("unsupported station fleet fixture kind {other}"),
        };
        let target_id = fixture["targetStationId"].as_str().unwrap();
        let peer_id = fixture["peerStationId"].as_str().unwrap();
        let mut command = station_fleet_command(
            state.revision,
            target_id,
            field,
            test_case["expected"]["final"].as_u64().unwrap(),
            "portableFleet",
            test_case["itemId"].as_str().unwrap(),
            test_case["expected"]["portableFleetAfter"]
                .as_u64()
                .unwrap(),
        );
        command.changed_entities[0].changes.push(ValuePatch {
            path: vec![PathSegment::Key("stationProgress".to_owned())],
            operation: "set".to_owned(),
            value: Some(Value::from(0)),
        });
        command.changed_entities.push(RecordPatch {
            id: peer_id.to_owned(),
            changes: vec![ValuePatch {
                path: vec![PathSegment::Key("stationProgress".to_owned())],
                operation: "set".to_owned(),
                value: Some(Value::from(0)),
            }],
        });
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

    fn research_queue_command(revision: u64, technology_ids: &[&str]) -> SimulationCommandPatch {
        top_level_leaf_command(
            revision,
            &["research", "queuedTechIds"],
            Value::Array(
                technology_ids
                    .iter()
                    .map(|technology_id| Value::from(*technology_id))
                    .collect(),
            ),
        )
    }

    fn install_research_lab(state: &mut CoreState, progress: f64) -> String {
        let mut entity = state.parse_entity(0).unwrap();
        entity["buildingId"] = Value::from("matrix_lab");
        entity["recipeId"] = Value::from("matrix_research");
        entity["progress"] = Value::from(progress);
        let id = entity["id"].as_str().unwrap().to_owned();
        state.replace_entity_raw(0, Arc::<str>::from(entity.to_string()));
        id
    }

    fn assert_research_intent_replays_identically(
        live: &mut CoreState,
        replay: &mut CoreState,
        command: &SimulationCommandPatch,
    ) {
        let live_receipt = live.apply_player_authority_command(command).unwrap();
        let replay_receipt = replay.apply_command(command).unwrap();
        assert_eq!(live_receipt, replay_receipt);
        assert_eq!(
            live.canonical_sha256().unwrap(),
            replay.canonical_sha256().unwrap()
        );
        assert_eq!(live.base_value(), replay.base_value());
        let entity_count = live.summary().unwrap().entity_count;
        for index in 0..entity_count {
            assert_eq!(
                live.parse_entity(index).unwrap(),
                replay.parse_entity(index).unwrap()
            );
        }
    }

    fn active_planet_intent(
        revision: u64,
        observed_current_id: &str,
        target_id: &str,
    ) -> SimulationCommandPatch {
        let mut command = empty_player_command(revision);
        command.top_level_changes = vec![ValuePatch {
            path: vec![
                PathSegment::Key("activePlanetId".to_owned()),
                PathSegment::Key(observed_current_id.to_owned()),
            ],
            operation: "set".to_owned(),
            value: Some(Value::from(target_id)),
        }];
        command
    }

    fn active_planet_to_ashen_command(revision: u64) -> SimulationCommandPatch {
        active_planet_intent(revision, "home", "ashen")
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

    fn time_warp_intent_command(
        revision: u64,
        controller_entity_id: &str,
        target_field: &str,
        target: Value,
    ) -> SimulationCommandPatch {
        let mut command = empty_player_command(revision);
        let mut intent = serde_json::Map::new();
        intent.insert(
            "controllerEntityId".to_owned(),
            Value::from(controller_entity_id),
        );
        intent.insert(target_field.to_owned(), target);
        command.top_level_changes = vec![ValuePatch {
            path: vec![
                PathSegment::Key("timeWarp".to_owned()),
                PathSegment::Key("intent".to_owned()),
            ],
            operation: "set".to_owned(),
            value: Some(Value::Object(intent)),
        }];
        command
    }

    fn dyson_launch_command(revision: u64, field: &str, value: Value) -> SimulationCommandPatch {
        let mut command = empty_player_command(revision);
        command.top_level_changes = vec![ValuePatch {
            path: ["dysonEngineering", field]
                .into_iter()
                .map(|segment| PathSegment::Key(segment.to_owned()))
                .collect(),
            operation: "set".to_owned(),
            value: Some(value),
        }];
        command
    }

    fn ejector_target_command(
        revision: u64,
        entity_ids: &[&str],
        orbit_id: &str,
    ) -> SimulationCommandPatch {
        let mut command = empty_player_command(revision);
        command.changed_entities = entity_ids
            .iter()
            .map(|entity_id| RecordPatch {
                id: (*entity_id).to_owned(),
                changes: vec![ValuePatch {
                    path: vec![PathSegment::Key("targetDysonOrbitId".to_owned())],
                    operation: "set".to_owned(),
                    value: Some(Value::from(orbit_id)),
                }],
            })
            .collect();
        command
    }

    fn dyson_orbit_geometry_command(
        revision: u64,
        system_id: &str,
        orbit_index: usize,
        fields: &[(&str, Value)],
    ) -> SimulationCommandPatch {
        let mut command = empty_player_command(revision);
        command.top_level_changes = fields
            .iter()
            .map(|(field, value)| ValuePatch {
                path: vec![
                    PathSegment::Key("dysonEngineering".to_owned()),
                    PathSegment::Key("orbitsBySystem".to_owned()),
                    PathSegment::Key(system_id.to_owned()),
                    PathSegment::Index(orbit_index),
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
    fn player_authority_pause_bit_requires_the_dedicated_lifecycle_entrypoint() {
        let mut state = player_command_state();
        let pause = top_level_leaf_command(state.revision, &["paused"], Value::from(true));
        let running_hash = state.canonical_sha256().unwrap();

        let generic_error = state.apply_player_authority_command(&pause).unwrap_err();
        assert!(format!("{generic_error:#}").contains("not owned by this command path"));
        assert_eq!(state.revision, 9);
        assert!(!state.base_value()["paused"].as_bool().unwrap());
        assert_eq!(state.canonical_sha256().unwrap(), running_hash);

        let paused = state
            .apply_player_authority_pause_transition(&pause)
            .unwrap();
        assert_eq!(paused.previous_revision, 9);
        assert_eq!(paused.revision, 10);
        assert!(paused.changed_entity_ids.is_empty());
        assert!(paused.changed_belt_ids.is_empty());
        assert!(!paused.topology_dirty);
        assert!(state.base_value()["paused"].as_bool().unwrap());

        let resume = top_level_leaf_command(state.revision, &["paused"], Value::from(false));
        let paused_hash = state.canonical_sha256().unwrap();
        assert!(state.apply_player_authority_command(&resume).is_err());
        assert_eq!(state.revision, 10);
        assert_eq!(state.canonical_sha256().unwrap(), paused_hash);

        let resumed = state
            .apply_player_authority_pause_transition(&resume)
            .unwrap();
        assert_eq!(resumed.previous_revision, 10);
        assert_eq!(resumed.revision, 11);
        assert!(!state.base_value()["paused"].as_bool().unwrap());

        let unchanged = top_level_leaf_command(state.revision, &["paused"], Value::from(false));
        let resumed_hash = state.canonical_sha256().unwrap();
        let unchanged_error = state
            .apply_player_authority_pause_transition(&unchanged)
            .unwrap_err();
        assert!(format!("{unchanged_error:#}").contains("target is unchanged"));
        assert_eq!(state.revision, 11);
        assert_eq!(state.canonical_sha256().unwrap(), resumed_hash);
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
        assert!(format!("{error:#}").contains("catalog-incomplete"));
        assert_eq!(modded.revision, 9);
        assert_eq!(modded.canonical_sha256().unwrap(), before);
    }

    #[test]
    fn player_authority_safely_reduces_a_historical_over_limit_building_stack() {
        let mut state = player_command_state();
        let mut entity = state.parse_entity(0).unwrap();
        entity["machineCount"] = Value::from(150_000_000_u64);
        state.replace_entity_raw(0, Arc::<str>::from(serde_json::to_string(&entity).unwrap()));
        state.base_value_mut()["construction"]["arc_smelter"] = Value::from(0);

        let command = ordinary_stack_change_command(state.revision, 120_000_000, 30_000_000);
        let applied = state.apply_player_authority_command(&command).unwrap();
        assert_eq!(applied.revision, 10);
        assert_eq!(state.parse_entity(0).unwrap()["machineCount"], 120_000_000);
        assert_eq!(
            state.base_value()["construction"]["arc_smelter"],
            30_000_000
        );

        let committed_hash = state.canonical_sha256().unwrap();
        let mut forbidden = ordinary_stack_change_command(state.revision, 120_000_001, 29_999_999);
        forbidden.base_revision = state.revision;
        let error = state
            .apply_player_authority_command(&forbidden)
            .unwrap_err();
        assert!(format!("{error:#}").contains("stack-limit"));
        assert_eq!(state.canonical_sha256().unwrap(), committed_hash);
    }

    #[test]
    fn player_authority_research_appends_only_one_provable_finite_queue_row() {
        let mut state = player_research_state();
        let before_entities = (0..3)
            .map(|index| state.parse_entity(index).unwrap())
            .collect::<Vec<_>>();
        let before_belt = state.parse_belt(0).unwrap();
        let before_total_produced = state.base_value()["totalProduced"].clone();
        let before_tray = state.base_value()["tray"].clone();
        let command = research_queue_command(state.revision, &["research_speed_3"]);

        let applied = state.apply_player_authority_command(&command).unwrap();

        assert_eq!(applied.previous_revision, 9);
        assert_eq!(applied.revision, 10);
        assert!(applied.changed_entity_ids.is_empty());
        assert!(applied.changed_belt_ids.is_empty());
        assert!(applied.topology_dirty);
        assert_eq!(
            state.base_value()["research"]["queuedTechIds"],
            serde_json::json!(["research_speed_3"])
        );
        assert_eq!(state.base_value()["totalProduced"], before_total_produced);
        assert_eq!(state.base_value()["tray"], before_tray);
        assert_eq!(
            (0..3)
                .map(|index| state.parse_entity(index).unwrap())
                .collect::<Vec<_>>(),
            before_entities
        );
        assert_eq!(state.parse_belt(0).unwrap(), before_belt);
    }

    #[test]
    fn player_authority_research_removes_queue_row_with_canonical_dependency_cascade() {
        let mut state = player_research_state();
        state.base_value_mut().insert(
            "research".to_owned(),
            serde_json::json!({
                "selectedTechId": "electromagnetism",
                "pausedTechId": null,
                "queuedTechIds": [
                    "basic_logistics",
                    "thermal_power",
                    "high_efficiency_plasma_control"
                ],
                "progressByTech": {},
                "completedTechIds": ["electromagnetic_matrix"]
            }),
        );
        let command = research_queue_command(state.revision, &["thermal_power"]);

        let applied = state.apply_player_authority_command(&command).unwrap();

        assert_eq!(applied.revision, 10);
        assert_eq!(
            state.base_value()["research"]["queuedTechIds"],
            serde_json::json!(["thermal_power"])
        );
        assert_eq!(
            state.base_value()["research"]["selectedTechId"],
            "electromagnetism"
        );
        assert_eq!(
            state.base_value()["research"]["completedTechIds"],
            serde_json::json!(["electromagnetic_matrix"])
        );
    }

    #[test]
    fn player_authority_research_toggles_only_unlocked_infinite_automation() {
        let mut state = player_research_state();
        let before_research = state.base_value()["research"].clone();
        let command = top_level_leaf_command(
            state.revision,
            &["endgame", "autoResearch"],
            Value::from(true),
        );

        let applied = state.apply_player_authority_command(&command).unwrap();

        assert_eq!(applied.revision, 10);
        assert!(applied.topology_dirty);
        assert_eq!(state.base_value()["endgame"]["autoResearch"], true);
        assert_eq!(state.base_value()["research"], before_research);
        assert_eq!(
            state.base_value()["endgame"]["activeInfiniteResearchId"],
            Value::Null
        );
    }

    #[test]
    fn player_authority_research_runs_finite_start_pause_resume_and_cancel_lifecycle() {
        let mut started = player_research_state();
        started.base_value_mut()["research"]["selectedTechId"] = Value::Null;
        started.base_value_mut()["research"]["pausedTechId"] = Value::from("research_speed_2");
        let lab_id = install_research_lab(&mut started, 0.75);
        let mut second_lab = started.parse_entity(1).unwrap();
        second_lab["buildingId"] = Value::from("matrix_lab");
        second_lab["recipeId"] = Value::from("matrix_research");
        second_lab["progress"] = Value::from(0.25);
        let second_lab_id = second_lab["id"].as_str().unwrap().to_owned();
        started.replace_entity_raw(1, Arc::<str>::from(second_lab.to_string()));
        let start = top_level_leaf_command(
            started.revision,
            &["research", "selectedTechId"],
            Value::from("research_speed_2"),
        );
        let start_receipt = started.apply_player_authority_command(&start).unwrap();
        assert_eq!(
            started.base_value()["research"]["selectedTechId"],
            "research_speed_2"
        );
        assert_eq!(
            started.base_value()["research"]["pausedTechId"],
            Value::Null
        );
        assert_eq!(started.parse_entity(0).unwrap()["progress"], 0.0);
        assert_eq!(started.parse_entity(1).unwrap()["progress"], 0.0);
        assert_eq!(
            start_receipt.changed_entity_ids,
            [second_lab_id, lab_id.clone()]
        );

        let mut paused = started.clone();
        let mut lab = paused.parse_entity(0).unwrap();
        lab["progress"] = Value::from(0.5);
        paused.replace_entity_raw(0, Arc::<str>::from(lab.to_string()));
        let pause = top_level_leaf_command(
            paused.revision,
            &["research", "pausedTechId"],
            Value::from("research_speed_2"),
        );
        let pause_receipt = paused.apply_player_authority_command(&pause).unwrap();
        assert_eq!(
            paused.base_value()["research"]["selectedTechId"],
            Value::Null
        );
        assert_eq!(
            paused.base_value()["research"]["pausedTechId"],
            "research_speed_2"
        );
        assert_eq!(paused.parse_entity(0).unwrap()["progress"], 0.0);
        assert_eq!(
            pause_receipt.changed_entity_ids,
            std::slice::from_ref(&lab_id)
        );

        let resume = top_level_leaf_command(
            paused.revision,
            &["research", "selectedTechId"],
            Value::from("research_speed_2"),
        );
        paused.apply_player_authority_command(&resume).unwrap();
        assert_eq!(
            paused.base_value()["research"]["selectedTechId"],
            "research_speed_2"
        );
        assert_eq!(paused.base_value()["research"]["pausedTechId"], Value::Null);

        paused.base_value_mut()["research"]["queuedTechIds"] =
            serde_json::json!(["electromagnetic_matrix"]);
        let cancel = top_level_leaf_command(
            paused.revision,
            &["research", "selectedTechId"],
            Value::Null,
        );
        paused.apply_player_authority_command(&cancel).unwrap();
        assert_eq!(
            paused.base_value()["research"]["selectedTechId"],
            "electromagnetic_matrix"
        );
        assert_eq!(
            paused.base_value()["research"]["queuedTechIds"],
            serde_json::json!([])
        );
    }

    #[test]
    fn player_authority_research_selects_another_legal_finite_target_without_losing_paused_target()
    {
        let mut state = player_research_state();
        state.base_value_mut()["research"]["selectedTechId"] = Value::Null;
        state.base_value_mut()["research"]["pausedTechId"] = Value::from("research_speed_2");
        let command = top_level_leaf_command(
            state.revision,
            &["research", "selectedTechId"],
            Value::from("electromagnetic_matrix"),
        );

        state.apply_player_authority_command(&command).unwrap();

        assert_eq!(
            state.base_value()["research"]["selectedTechId"],
            "electromagnetic_matrix"
        );
        assert_eq!(
            state.base_value()["research"]["pausedTechId"],
            "research_speed_2"
        );
    }

    #[test]
    fn player_authority_research_completion_preserves_construction_and_exploration_rewards() {
        let mut construction = player_research_state();
        construction.base_value_mut()["research"] = serde_json::json!({
            "selectedTechId": "basic_logistics",
            "pausedTechId": null,
            "queuedTechIds": [],
            "progressByTech": {
                "basic_logistics": { "electromagnetic_matrix": 8 }
            },
            "completedTechIds": ["electromagnetic_matrix", "electromagnetism"]
        });
        let cancel = top_level_leaf_command(
            construction.revision,
            &["research", "selectedTechId"],
            Value::Null,
        );
        let receipt = construction
            .apply_player_authority_command(&cancel)
            .unwrap();
        assert_eq!(
            construction.base_value()["construction"]["conveyor_belt_mk1"].as_f64(),
            Some(7.0)
        );
        assert!(receipt.topology_dirty);

        let mut exploration = player_research_state();
        exploration.base_value_mut()["research"] = serde_json::json!({
            "selectedTechId": "interstellar_logistics",
            "pausedTechId": null,
            "queuedTechIds": [],
            "progressByTech": {
                "interstellar_logistics": { "gravity_matrix": 5 }
            },
            "completedTechIds": []
        });
        let cancel = top_level_leaf_command(
            exploration.revision,
            &["research", "selectedTechId"],
            Value::Null,
        );
        exploration.apply_player_authority_command(&cancel).unwrap();
        assert_eq!(
            exploration.base_value()["exploration"]["colonizedPlanetIds"],
            serde_json::json!(["home", "ashen", "giant"])
        );

        let mut universe = player_research_state();
        universe.base_value_mut()["research"] = serde_json::json!({
            "selectedTechId": "universe_matrix",
            "pausedTechId": null,
            "queuedTechIds": [],
            "progressByTech": {
                "universe_matrix": { "universe_matrix": 5 }
            },
            "completedTechIds": []
        });
        let cancel = top_level_leaf_command(
            universe.revision,
            &["research", "selectedTechId"],
            Value::Null,
        );
        universe.apply_player_authority_command(&cancel).unwrap();
        assert_eq!(
            universe.base_value()["construction"]["galactic_material_exporter"],
            1
        );
    }

    #[test]
    fn player_authority_research_cancel_settles_due_boundary_without_canceling_next_queue_row() {
        let mut state = player_research_state();
        state.base_value_mut()["research"]["progressByTech"]["research_speed_2"]["gravity_matrix"] =
            Value::from(20);
        state.base_value_mut()["research"]["queuedTechIds"] =
            serde_json::json!(["research_speed_3"]);
        let lab_id = install_research_lab(&mut state, 0.875);
        let construction_before = state.base_value()["construction"].clone();
        let exploration_before = state.base_value()["exploration"].clone();
        let cancel =
            top_level_leaf_command(state.revision, &["research", "selectedTechId"], Value::Null);

        let receipt = state.apply_player_authority_command(&cancel).unwrap();

        assert!(
            state.base_value()["research"]["completedTechIds"]
                .as_array()
                .unwrap()
                .iter()
                .any(|value| value == "research_speed_2")
        );
        assert_eq!(
            state.base_value()["research"]["selectedTechId"],
            "research_speed_3"
        );
        assert_eq!(
            state.base_value()["research"]["queuedTechIds"],
            serde_json::json!([])
        );
        assert_eq!(state.base_value()["construction"], construction_before);
        assert_eq!(state.base_value()["exploration"], exploration_before);
        assert_eq!(state.parse_entity(0).unwrap()["progress"], 0.0);
        assert_eq!(receipt.changed_entity_ids, [lab_id]);
    }

    #[test]
    fn player_authority_research_selects_and_stops_infinite_target_with_lab_reset() {
        let mut state = player_research_state();
        state.base_value_mut()["research"]["selectedTechId"] = Value::Null;
        let lab_id = install_research_lab(&mut state, 0.625);
        let select = top_level_leaf_command(
            state.revision,
            &["endgame", "activeInfiniteResearchId"],
            Value::from("matrix_compression"),
        );
        let selected = state.apply_player_authority_command(&select).unwrap();
        assert_eq!(
            state.base_value()["endgame"]["activeInfiniteResearchId"],
            "matrix_compression"
        );
        assert_eq!(state.parse_entity(0).unwrap()["progress"], 0.0);
        assert_eq!(selected.changed_entity_ids, [lab_id]);

        let stop = top_level_leaf_command(
            state.revision,
            &["endgame", "activeInfiniteResearchId"],
            Value::Null,
        );
        state.apply_player_authority_command(&stop).unwrap();
        assert_eq!(
            state.base_value()["endgame"]["activeInfiniteResearchId"],
            Value::Null
        );
    }

    #[test]
    fn player_authority_research_pause_and_cancel_infinite_follow_distinct_queue_rules() {
        let mut paused = player_research_state();
        paused.base_value_mut()["research"]["selectedTechId"] = Value::Null;
        paused.base_value_mut()["research"]["queuedTechIds"] =
            serde_json::json!(["electromagnetic_matrix"]);
        paused.base_value_mut()["endgame"]["activeInfiniteResearchId"] =
            Value::from("matrix_compression");
        let stop = top_level_leaf_command(
            paused.revision,
            &["endgame", "activeInfiniteResearchId"],
            Value::Null,
        );
        paused.apply_player_authority_command(&stop).unwrap();
        assert_eq!(
            paused.base_value()["research"]["selectedTechId"],
            Value::Null
        );
        assert_eq!(
            paused.base_value()["research"]["queuedTechIds"],
            serde_json::json!(["electromagnetic_matrix"])
        );

        let mut canceled = player_research_state();
        canceled.base_value_mut()["research"]["selectedTechId"] = Value::Null;
        canceled.base_value_mut()["research"]["queuedTechIds"] =
            serde_json::json!(["electromagnetic_matrix"]);
        canceled.base_value_mut()["endgame"]["activeInfiniteResearchId"] =
            Value::from("matrix_compression");
        let cancel = top_level_leaf_command(
            canceled.revision,
            &["research", "selectedTechId"],
            Value::Null,
        );
        canceled.apply_player_authority_command(&cancel).unwrap();
        assert_eq!(
            canceled.base_value()["research"]["selectedTechId"],
            "electromagnetic_matrix"
        );
        assert_eq!(
            canceled.base_value()["research"]["queuedTechIds"],
            serde_json::json!([])
        );
    }

    #[test]
    fn player_authority_research_minimal_intent_replays_identically_through_generic_wal_apply() {
        let mut live = player_research_state();
        live.base_value_mut()["research"]["selectedTechId"] = Value::Null;
        live.base_value_mut()["research"]["pausedTechId"] = Value::from("research_speed_2");
        install_research_lab(&mut live, 0.5);
        let mut replay = live.clone();
        let resume = top_level_leaf_command(
            live.revision,
            &["research", "selectedTechId"],
            Value::from("research_speed_2"),
        );
        assert_research_intent_replays_identically(&mut live, &mut replay, &resume);

        let pause = top_level_leaf_command(
            live.revision,
            &["research", "pausedTechId"],
            Value::from("research_speed_2"),
        );
        assert_research_intent_replays_identically(&mut live, &mut replay, &pause);

        let select_other = top_level_leaf_command(
            live.revision,
            &["research", "selectedTechId"],
            Value::from("electromagnetic_matrix"),
        );
        assert_research_intent_replays_identically(&mut live, &mut replay, &select_other);

        let cancel =
            top_level_leaf_command(live.revision, &["research", "selectedTechId"], Value::Null);
        assert_research_intent_replays_identically(&mut live, &mut replay, &cancel);

        let start_infinite = top_level_leaf_command(
            live.revision,
            &["endgame", "activeInfiniteResearchId"],
            Value::from("matrix_compression"),
        );
        assert_research_intent_replays_identically(&mut live, &mut replay, &start_infinite);

        let stop_infinite = top_level_leaf_command(
            live.revision,
            &["endgame", "activeInfiniteResearchId"],
            Value::Null,
        );
        assert_research_intent_replays_identically(&mut live, &mut replay, &stop_infinite);

        live.base_value_mut()["research"]["queuedTechIds"] =
            serde_json::json!(["electromagnetic_matrix"]);
        replay.base_value_mut()["research"]["queuedTechIds"] =
            serde_json::json!(["electromagnetic_matrix"]);
        let restart_infinite = top_level_leaf_command(
            live.revision,
            &["endgame", "activeInfiniteResearchId"],
            Value::from("matrix_compression"),
        );
        assert_research_intent_replays_identically(&mut live, &mut replay, &restart_infinite);
        let cancel_infinite =
            top_level_leaf_command(live.revision, &["research", "selectedTechId"], Value::Null);
        assert_research_intent_replays_identically(&mut live, &mut replay, &cancel_infinite);
    }

    #[test]
    fn player_authority_research_rejects_stale_unknown_modded_and_completion_boundary_atomically() {
        let baseline = player_research_state();
        let revision = baseline.revision;

        let stale = research_queue_command(revision - 1, &["research_speed_3"]);
        let unknown = research_queue_command(revision, &["missing_mod_technology"]);
        for command in [stale, unknown] {
            let mut state = player_research_state();
            let before = state.canonical_sha256().unwrap();
            assert!(state.apply_player_authority_command(&command).is_err());
            assert_eq!(state.revision, revision);
            assert_eq!(state.canonical_sha256().unwrap(), before);
        }

        let transition_cases = [
            (
                top_level_leaf_command(
                    revision - 1,
                    &["research", "selectedTechId"],
                    Value::from("electromagnetic_matrix"),
                ),
                false,
            ),
            (
                top_level_leaf_command(
                    revision,
                    &["research", "selectedTechId"],
                    Value::from("missing_mod_technology"),
                ),
                false,
            ),
            (
                top_level_leaf_command(
                    revision,
                    &["research", "selectedTechId"],
                    Value::from("research_speed_3"),
                ),
                false,
            ),
            (
                top_level_leaf_command(
                    revision,
                    &["endgame", "activeInfiniteResearchId"],
                    Value::from("matrix_compression"),
                ),
                true,
            ),
        ];
        for (command, retain_selected) in transition_cases {
            let mut state = player_research_state();
            if !retain_selected {
                state.base_value_mut()["research"]["selectedTechId"] = Value::Null;
                state.base_value_mut()["research"]["pausedTechId"] = Value::Null;
            }
            let before = state.canonical_sha256().unwrap();
            assert!(state.apply_player_authority_command(&command).is_err());
            assert_eq!(state.revision, revision);
            assert_eq!(state.canonical_sha256().unwrap(), before);
        }

        let mut completion_due = player_research_state();
        completion_due.base_value_mut()["research"]["progressByTech"]["research_speed_2"]["gravity_matrix"] =
            Value::from(20);
        let before = completion_due.canonical_sha256().unwrap();
        let command = research_queue_command(completion_due.revision, &["research_speed_3"]);
        assert!(
            completion_due
                .apply_player_authority_command(&command)
                .is_err()
        );
        assert_eq!(completion_due.revision, revision);
        assert_eq!(completion_due.canonical_sha256().unwrap(), before);

        let canonical = player_research_state();
        let mut modded = player_command_state_for_registry("modded-player-research-test");
        for root in ["research", "endgame"] {
            modded.base_value_mut().insert(
                root.to_owned(),
                canonical
                    .base_value()
                    .get(root)
                    .expect("canonical research fixture root")
                    .clone(),
            );
        }
        let before = modded.canonical_sha256().unwrap();
        let command = research_queue_command(modded.revision, &["research_speed_3"]);
        assert!(modded.apply_player_authority_command(&command).is_err());
        assert_eq!(modded.revision, revision);
        assert_eq!(modded.canonical_sha256().unwrap(), before);

        modded.base_value_mut()["research"]["selectedTechId"] = Value::Null;
        let before = modded.canonical_sha256().unwrap();
        let command = top_level_leaf_command(
            modded.revision,
            &["research", "selectedTechId"],
            Value::from("electromagnetic_matrix"),
        );
        assert!(modded.apply_player_authority_command(&command).is_err());
        assert_eq!(modded.revision, revision);
        assert_eq!(modded.canonical_sha256().unwrap(), before);

        let mut locked_automation = player_research_state();
        locked_automation.base_value_mut()["research"]["completedTechIds"] =
            serde_json::json!(["gravity_matrix", "research_speed_1"]);
        let before = locked_automation.canonical_sha256().unwrap();
        let command = top_level_leaf_command(
            locked_automation.revision,
            &["endgame", "autoResearch"],
            Value::from(true),
        );
        assert!(
            locked_automation
                .apply_player_authority_command(&command)
                .is_err()
        );
        assert_eq!(locked_automation.revision, revision);
        assert_eq!(locked_automation.canonical_sha256().unwrap(), before);

        let mut unchanged_automation = player_research_state();
        let before = unchanged_automation.canonical_sha256().unwrap();
        let command = top_level_leaf_command(
            unchanged_automation.revision,
            &["endgame", "autoResearch"],
            Value::from(false),
        );
        assert!(
            unchanged_automation
                .apply_player_authority_command(&command)
                .is_err()
        );
        assert_eq!(unchanged_automation.revision, revision);
        assert_eq!(unchanged_automation.canonical_sha256().unwrap(), before);
    }

    #[test]
    fn player_authority_research_rejects_cross_domain_and_empty_cancel_atomically() {
        let mut cross_domain = research_queue_command(9, &["research_speed_3"]);
        cross_domain.top_level_changes.push(ValuePatch {
            path: vec![
                PathSegment::Key("totalProduced".to_owned()),
                PathSegment::Key("iron_ingot".to_owned()),
            ],
            operation: "set".to_owned(),
            value: Some(Value::from(999_999)),
        });
        let mut empty_cancel_state = player_research_state();
        empty_cancel_state.base_value_mut()["research"]["selectedTechId"] = Value::Null;
        let empty_cancel = top_level_leaf_command(9, &["research", "selectedTechId"], Value::Null);

        let mut state = player_research_state();
        let before = state.canonical_sha256().unwrap();
        assert!(state.apply_player_authority_command(&cross_domain).is_err());
        assert_eq!(state.revision, 9);
        assert_eq!(state.canonical_sha256().unwrap(), before);

        let mut semantic_cross_domain = top_level_leaf_command(
            9,
            &["research", "selectedTechId"],
            Value::from("electromagnetic_matrix"),
        );
        semantic_cross_domain.top_level_changes.push(ValuePatch {
            path: vec![PathSegment::Key("totalProduced".to_owned())],
            operation: "set".to_owned(),
            value: Some(serde_json::json!({ "iron_ingot": 999_999 })),
        });
        let mut state = player_research_state();
        state.base_value_mut()["research"]["selectedTechId"] = Value::Null;
        let before = state.canonical_sha256().unwrap();
        assert!(
            state
                .apply_player_authority_command(&semantic_cross_domain)
                .is_err()
        );
        assert_eq!(state.revision, 9);
        assert_eq!(state.canonical_sha256().unwrap(), before);

        let before = empty_cancel_state.canonical_sha256().unwrap();
        assert!(
            empty_cancel_state
                .apply_player_authority_command(&empty_cancel)
                .is_err()
        );
        assert_eq!(empty_cancel_state.revision, 9);
        assert_eq!(empty_cancel_state.canonical_sha256().unwrap(), before);

        let mut late_failure = player_research_state();
        late_failure.base_value_mut()["research"]["selectedTechId"] = Value::Null;
        late_failure.base_value_mut()["research"]["pausedTechId"] = Value::from("research_speed_2");
        let mut malformed_lab = late_failure.parse_entity(0).unwrap();
        malformed_lab.as_object_mut().unwrap().remove("id");
        malformed_lab["buildingId"] = Value::from("matrix_lab");
        malformed_lab["recipeId"] = Value::from("matrix_research");
        malformed_lab["progress"] = Value::from(0.5);
        late_failure.replace_entity_raw(0, Arc::<str>::from(malformed_lab.to_string()));
        let before = late_failure.canonical_sha256().unwrap();
        let start = top_level_leaf_command(
            late_failure.revision,
            &["research", "selectedTechId"],
            Value::from("research_speed_2"),
        );
        assert!(late_failure.apply_player_authority_command(&start).is_err());
        assert_eq!(late_failure.revision, 9);
        assert_eq!(late_failure.canonical_sha256().unwrap(), before);
    }

    #[test]
    fn player_authority_research_apply_is_deterministic() {
        let mut left = player_research_state();
        let mut right = left.clone();
        let command = research_queue_command(left.revision, &["research_speed_3"]);

        let left_receipt = left.apply_player_authority_command(&command).unwrap();
        let right_receipt = right.apply_player_authority_command(&command).unwrap();

        assert_eq!(left_receipt, right_receipt);
        assert_eq!(
            left.canonical_sha256().unwrap(),
            right.canonical_sha256().unwrap()
        );
    }

    #[test]
    fn player_authority_applies_and_replays_only_the_exact_technology_layout_leaf() {
        let mut live = player_technology_layout_state();
        let mut replay = live.clone();
        let command = top_level_leaf_command(
            live.revision,
            &["settings", "technologyLayout"],
            Value::from("compact"),
        );

        let live_receipt = live.apply_player_authority_command(&command).unwrap();
        let replay_receipt = replay.apply_command(&command).unwrap();

        assert_eq!(live_receipt, replay_receipt);
        assert!(live_receipt.changed_entity_ids.is_empty());
        assert!(live_receipt.changed_belt_ids.is_empty());
        assert!(!live_receipt.topology_dirty);
        assert_eq!(live.base_value()["settings"]["technologyLayout"], "compact");
        assert_eq!(live.base_value(), replay.base_value());
        assert_eq!(
            live.canonical_sha256().unwrap(),
            replay.canonical_sha256().unwrap()
        );
    }

    #[test]
    fn player_authority_technology_layout_rejects_stale_modded_mixed_and_invalid_commands() {
        let revision = player_technology_layout_state().revision;
        let wrong_leaf =
            top_level_leaf_command(revision, &["settings", "fontScale"], Value::from(1.25));
        let whole_settings = top_level_leaf_command(
            revision,
            &["settings"],
            serde_json::json!({ "technologyLayout": "compact" }),
        );
        let mut delete_layout = top_level_leaf_command(
            revision,
            &["settings", "technologyLayout"],
            Value::from("compact"),
        );
        delete_layout.top_level_changes[0].operation = "delete".to_owned();
        delete_layout.top_level_changes[0].value = None;
        let mut mixed = top_level_leaf_command(
            revision,
            &["settings", "technologyLayout"],
            Value::from("compact"),
        );
        mixed.top_level_changes.push(ValuePatch {
            path: vec![PathSegment::Key("paused".to_owned())],
            operation: "set".to_owned(),
            value: Some(Value::from(true)),
        });
        let commands = [
            top_level_leaf_command(
                revision - 1,
                &["settings", "technologyLayout"],
                Value::from("compact"),
            ),
            top_level_leaf_command(
                revision,
                &["settings", "technologyLayout"],
                Value::from("standard"),
            ),
            top_level_leaf_command(
                revision,
                &["settings", "technologyLayout"],
                Value::from("expanded"),
            ),
            wrong_leaf,
            whole_settings,
            delete_layout,
            mixed,
        ];
        for command in commands {
            let mut state = player_technology_layout_state();
            let before = state.canonical_sha256().unwrap();
            assert!(state.apply_player_authority_command(&command).is_err());
            assert_eq!(state.revision, revision);
            assert_eq!(state.canonical_sha256().unwrap(), before);
        }

        let mut modded = player_command_state_for_registry("modded-technology-layout-test");
        modded.base_value_mut()["settings"]["technologyLayout"] = Value::from("standard");
        let before = modded.canonical_sha256().unwrap();
        let command = top_level_leaf_command(
            modded.revision,
            &["settings", "technologyLayout"],
            Value::from("compact"),
        );
        assert!(modded.apply_player_authority_command(&command).is_err());
        assert_eq!(modded.revision, revision);
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
    fn player_authority_energy_exchanger_mode_expands_inventory_and_topology_atomically() {
        let command = energy_exchanger_mode_command(9, Value::from("discharge"));
        let durable = serde_json::to_string(&command).unwrap();
        assert!(!durable.contains("accumulator_charge"));
        assert!(!durable.contains("charged_accumulator"));
        assert!(!durable.contains("belt-exchanger"));

        let mut live = player_energy_exchanger_state();
        let receipt = live.apply_player_authority_command(&command).unwrap();
        assert_eq!(receipt.previous_revision, 9);
        assert_eq!(receipt.revision, 10);
        assert_eq!(receipt.changed_entity_ids, ["exchanger-a"]);
        assert_eq!(
            receipt.changed_belt_ids,
            ["belt-exchanger-in", "belt-exchanger-out"]
        );
        assert!(receipt.topology_dirty);

        let exchanger_index = *live.entity_index.get("exchanger-a").unwrap();
        let exchanger = live.parse_entity(exchanger_index).unwrap();
        assert_eq!(exchanger["energyMode"], "discharge");
        assert_eq!(exchanger["recipeId"], "accumulator_discharge");
        assert_eq!(exchanger["inputs"], serde_json::json!({}));
        assert_eq!(exchanger["outputs"], serde_json::json!({}));
        assert_eq!(exchanger["progress"], 0);
        assert_eq!(exchanger["powerInputKw"], 0);
        assert_eq!(exchanger["powerOutputKw"], 0);
        assert_eq!(live.base_value()["tray"]["accumulator"], 9);
        assert_eq!(live.base_value()["tray"]["charged_accumulator"], 14);
        assert_eq!(live.base_value()["construction"]["conveyor_belt_mk1"], 10);
        assert!(live.belt_index.contains_key("belt-priority"));
        assert!(!live.belt_index.contains_key("belt-exchanger-in"));
        assert!(!live.belt_index.contains_key("belt-exchanger-out"));

        let live_hash = live.canonical_sha256().unwrap();
        let replayed_command: SimulationCommandPatch = serde_json::from_str(&durable).unwrap();
        let mut replayed = player_energy_exchanger_state();
        replayed
            .replay_operation(
                9,
                10,
                Some(&replayed_command),
                0.0,
                0.0,
                crate::CoreAdvanceMode::Exact,
            )
            .unwrap();
        assert_eq!(replayed.canonical_sha256().unwrap(), live_hash);
        assert_eq!(replayed.base_value(), live.base_value());
        assert_eq!(
            replayed
                .parse_entity(*replayed.entity_index.get("exchanger-a").unwrap())
                .unwrap(),
            exchanger
        );
        assert!(replayed.belt_index.contains_key("belt-priority"));
        assert!(!replayed.belt_index.contains_key("belt-exchanger-in"));
        assert!(!replayed.belt_index.contains_key("belt-exchanger-out"));
    }

    #[test]
    fn player_authority_energy_exchanger_mode_matches_portable_refund_and_epsilon_boundary() {
        let mut state = player_energy_exchanger_state();
        let index = *state.entity_index.get("exchanger-a").unwrap();
        let mut entity = state.parse_entity(index).unwrap();
        entity["inputs"]["logistics_drone"] = Value::from(1.9);
        state.replace_entity_raw(index, Arc::<str>::from(entity.to_string()));

        state
            .apply_player_authority_command(&energy_exchanger_mode_command(
                9,
                Value::from("discharge"),
            ))
            .unwrap();

        assert_eq!(state.base_value()["portableFleet"]["logistics_drone"], 21);
        assert_eq!(state.base_value()["tray"]["logistics_drone"], 0);
    }

    #[test]
    fn player_authority_energy_exchanger_mode_fails_closed_on_forged_or_unsupported_intents() {
        let mut extra_root = energy_exchanger_mode_command(9, Value::from("discharge"));
        extra_root.top_level_changes.push(ValuePatch {
            path: vec![PathSegment::Key("paused".to_owned())],
            operation: "set".to_owned(),
            value: Some(Value::from(true)),
        });
        let mut preexpanded = energy_exchanger_mode_command(9, Value::from("discharge"));
        preexpanded
            .removed_belt_ids
            .push("belt-exchanger-in".to_owned());
        let mut delete = energy_exchanger_mode_command(9, Value::from("discharge"));
        delete.changed_entities[0].changes[0].operation = "delete".to_owned();
        delete.changed_entities[0].changes[0].value = None;
        let commands = [
            energy_exchanger_mode_command(8, Value::from("discharge")),
            energy_exchanger_mode_command(9, Value::from("auto")),
            energy_exchanger_mode_command(9, Value::from("charge")),
            entity_leaf_command(9, "smelter-a", "energyMode", Value::from("discharge")),
            extra_root,
            preexpanded,
            delete,
        ];
        for command in commands {
            let mut state = player_energy_exchanger_state();
            let before = state.canonical_sha256().unwrap();
            assert!(state.apply_player_authority_command(&command).is_err());
            assert_eq!(state.revision, 9);
            assert_eq!(state.canonical_sha256().unwrap(), before);
        }

        for (field, value) in [
            ("interactionLocked", Value::from(true)),
            (
                "storedEnergyMj",
                Value::from(PLAYER_ENERGY_EPSILON + 0.00001),
            ),
            ("planetId", Value::from("ashen")),
        ] {
            let mut state = player_energy_exchanger_state();
            let index = *state.entity_index.get("exchanger-a").unwrap();
            let mut entity = state.parse_entity(index).unwrap();
            entity[field] = value;
            state.replace_entity_raw(index, Arc::<str>::from(entity.to_string()));
            let before = state.canonical_sha256().unwrap();
            assert!(
                state
                    .apply_player_authority_command(&energy_exchanger_mode_command(
                        9,
                        Value::from("discharge"),
                    ))
                    .is_err()
            );
            assert_eq!(state.canonical_sha256().unwrap(), before);
        }

        let mut locked_technology = player_energy_exchanger_state();
        locked_technology.base_value_mut()["research"]["completedTechIds"] = serde_json::json!([]);
        let before = locked_technology.canonical_sha256().unwrap();
        assert!(
            locked_technology
                .apply_player_authority_command(&energy_exchanger_mode_command(
                    9,
                    Value::from("discharge"),
                ))
                .is_err()
        );
        assert_eq!(locked_technology.canonical_sha256().unwrap(), before);

        let mut modded = player_energy_exchanger_state_for_registry("modded-energy-mode-test");
        let before = modded.canonical_sha256().unwrap();
        assert!(
            modded
                .apply_player_authority_command(&energy_exchanger_mode_command(
                    9,
                    Value::from("discharge"),
                ))
                .is_err()
        );
        assert_eq!(modded.canonical_sha256().unwrap(), before);
    }

    #[test]
    fn player_authority_energy_exchanger_late_refund_failure_is_atomic_for_live_and_wal() {
        for replay in [false, true] {
            let mut state = player_energy_exchanger_state();
            state.base_value_mut()["tray"]["accumulator"] =
                Value::from(MAX_JAVASCRIPT_SAFE_INTEGER);
            let before = state.canonical_sha256().unwrap();
            let command = energy_exchanger_mode_command(9, Value::from("discharge"));
            let result = if replay {
                state.replay_operation(
                    9,
                    10,
                    Some(&command),
                    0.0,
                    0.0,
                    crate::CoreAdvanceMode::Exact,
                )
            } else {
                state.apply_player_authority_command(&command).map(|_| ())
            };
            assert!(result.is_err());
            assert_eq!(state.revision, 9);
            assert_eq!(state.canonical_sha256().unwrap(), before);
        }
    }

    #[test]
    fn player_authority_fuel_item_matches_js_refunds_topology_and_power_reset() {
        assert_eq!(
            builtin_fuel_items_for_building("thermal_power_plant").unwrap(),
            BUILTIN_THERMAL_FUEL_ITEMS
        );
        assert_eq!(
            builtin_fuel_items_for_building("mini_fusion_power_plant").unwrap(),
            ["deuteron_fuel_rod"]
        );
        assert_eq!(
            builtin_fuel_items_for_building("artificial_star").unwrap(),
            ["antimatter_fuel_rod"]
        );

        let command = fuel_item_command(9, Value::from("energetic_graphite"));
        let durable = serde_json::to_string(&command).unwrap();
        let durable_value: Value = serde_json::from_str(&durable).unwrap();
        assert_eq!(
            durable_value["changedEntities"],
            serde_json::json!([{
                "id": "thermal-a",
                "changes": [{
                    "path": ["fuelItemId"],
                    "operation": "set",
                    "value": "energetic_graphite"
                }]
            }])
        );
        assert_eq!(durable_value["topLevelChanges"], serde_json::json!([]));
        assert_eq!(durable_value["removedBeltIds"], serde_json::json!([]));

        let mut live = player_fuel_state();
        let applied = live.apply_player_authority_command(&command).unwrap();
        assert_eq!(applied.previous_revision, 9);
        assert_eq!(applied.revision, 10);
        assert_eq!(applied.changed_entity_ids, ["thermal-a"]);
        assert_eq!(applied.changed_belt_ids, ["belt-fuel-in", "belt-fuel-out"]);
        assert!(applied.topology_dirty);
        let thermal = live
            .parse_entity(*live.entity_index.get("thermal-a").unwrap())
            .unwrap();
        assert_eq!(thermal["fuelItemId"], "energetic_graphite");
        assert_eq!(thermal["inputs"], serde_json::json!({}));
        assert_eq!(thermal["outputs"], serde_json::json!({ "iron_ingot": 4 }));
        assert_eq!(thermal["fuelRemainingMj"], 3.25);
        assert_eq!(thermal["powerOutputKw"], 0);
        assert_eq!(thermal["powerInputKw"], 19);
        assert_eq!(live.base_value()["tray"]["coal"], 9);
        assert_eq!(live.base_value()["tray"]["logistics_drone"], 0);
        assert_eq!(live.base_value()["portableFleet"]["logistics_drone"], 21);
        assert_eq!(live.base_value()["construction"]["conveyor_belt_mk1"], 10);
        assert!(live.belt_index.contains_key("belt-priority"));
        assert!(!live.belt_index.contains_key("belt-fuel-in"));
        assert!(!live.belt_index.contains_key("belt-fuel-out"));

        let live_hash = live.canonical_sha256().unwrap();
        let replayed_command: SimulationCommandPatch = serde_json::from_str(&durable).unwrap();
        let mut replayed = player_fuel_state();
        replayed
            .replay_operation(
                9,
                10,
                Some(&replayed_command),
                0.0,
                0.0,
                crate::CoreAdvanceMode::Exact,
            )
            .unwrap();
        assert_eq!(replayed.canonical_sha256().unwrap(), live_hash);
        assert_eq!(replayed.base_value(), live.base_value());
        assert_eq!(
            replayed
                .parse_entity(*replayed.entity_index.get("thermal-a").unwrap())
                .unwrap(),
            thermal
        );
        assert!(replayed.belt_index.contains_key("belt-priority"));
        assert!(!replayed.belt_index.contains_key("belt-fuel-in"));
        assert!(!replayed.belt_index.contains_key("belt-fuel-out"));
    }

    #[test]
    fn player_authority_fuel_item_fails_closed_for_forged_or_unsupported_intents() {
        let mut extra_root = fuel_item_command(9, Value::from("energetic_graphite"));
        extra_root.top_level_changes.push(ValuePatch {
            path: vec![PathSegment::Key("paused".to_owned())],
            operation: "set".to_owned(),
            value: Some(Value::from(true)),
        });
        let mut preexpanded = fuel_item_command(9, Value::from("energetic_graphite"));
        preexpanded.removed_belt_ids.push("belt-fuel-in".to_owned());
        let mut delete = fuel_item_command(9, Value::from("energetic_graphite"));
        delete.changed_entities[0].changes[0].operation = "delete".to_owned();
        delete.changed_entities[0].changes[0].value = None;
        let mut batch = fuel_item_command(9, Value::from("energetic_graphite"));
        batch.changed_entities.push(RecordPatch {
            id: "smelter-a".to_owned(),
            changes: vec![ValuePatch {
                path: vec![PathSegment::Key("fuelItemId".to_owned())],
                operation: "set".to_owned(),
                value: Some(Value::from("coal")),
            }],
        });
        let commands = [
            fuel_item_command(8, Value::from("energetic_graphite")),
            fuel_item_command(9, Value::from("coal")),
            fuel_item_command(9, Value::from("iron_ingot")),
            entity_leaf_command(9, "smelter-a", "fuelItemId", Value::from("coal")),
            extra_root,
            preexpanded,
            delete,
            batch,
        ];
        for command in commands {
            let mut state = player_fuel_state();
            let before = state.canonical_sha256().unwrap();
            assert!(state.apply_player_authority_command(&command).is_err());
            assert_eq!(state.revision, 9);
            assert_eq!(state.canonical_sha256().unwrap(), before);
        }

        for (field, value) in [
            ("interactionLocked", Value::from(true)),
            ("planetId", Value::from("ashen")),
            ("kind", Value::from("machine")),
            ("buildingId", Value::from("mini_fusion_power_plant")),
            ("fuelItemId", Value::from("iron_ingot")),
        ] {
            let mut state = player_fuel_state();
            let index = *state.entity_index.get("thermal-a").unwrap();
            let mut entity = state.parse_entity(index).unwrap();
            entity[field] = value;
            state.replace_entity_raw(index, Arc::<str>::from(entity.to_string()));
            let before = state.canonical_sha256().unwrap();
            assert!(
                state
                    .apply_player_authority_command(&fuel_item_command(
                        9,
                        Value::from("energetic_graphite"),
                    ))
                    .is_err()
            );
            assert_eq!(state.revision, 9);
            assert_eq!(state.canonical_sha256().unwrap(), before);
        }

        for completed in [serde_json::json!([]), serde_json::json!(["thermal_power"])] {
            let mut state = player_fuel_state();
            state.base_value_mut()["research"]["completedTechIds"] = completed;
            let before = state.canonical_sha256().unwrap();
            assert!(
                state
                    .apply_player_authority_command(&fuel_item_command(
                        9,
                        Value::from("energetic_graphite"),
                    ))
                    .is_err()
            );
            assert_eq!(state.revision, 9);
            assert_eq!(state.canonical_sha256().unwrap(), before);
        }

        let mut unknown_input = player_fuel_state();
        let index = *unknown_input.entity_index.get("thermal-a").unwrap();
        let mut entity = unknown_input.parse_entity(index).unwrap();
        entity["inputs"]["MOD/fuel"] = Value::from(1);
        unknown_input.replace_entity_raw(index, Arc::<str>::from(entity.to_string()));
        let before = unknown_input.canonical_sha256().unwrap();
        assert!(
            unknown_input
                .apply_player_authority_command(&fuel_item_command(
                    9,
                    Value::from("energetic_graphite"),
                ))
                .is_err()
        );
        assert_eq!(unknown_input.revision, 9);
        assert_eq!(unknown_input.canonical_sha256().unwrap(), before);

        let mut modded = player_fuel_state_for_registry("modded-fuel-item-test");
        let before = modded.canonical_sha256().unwrap();
        assert!(
            modded
                .apply_player_authority_command(&fuel_item_command(
                    9,
                    Value::from("energetic_graphite"),
                ))
                .is_err()
        );
        assert_eq!(modded.revision, 9);
        assert_eq!(modded.canonical_sha256().unwrap(), before);
    }

    #[test]
    fn player_authority_fuel_item_refund_overflow_is_atomic_for_live_and_wal() {
        for overflow_target in ["tray", "portable-fleet", "belt-construction"] {
            for replay in [false, true] {
                let mut state = player_fuel_state();
                match overflow_target {
                    "tray" => {
                        state.base_value_mut()["tray"]["coal"] =
                            Value::from(MAX_JAVASCRIPT_SAFE_INTEGER);
                    }
                    "portable-fleet" => {
                        state.base_value_mut()["portableFleet"]["logistics_drone"] =
                            Value::from(MAX_JAVASCRIPT_SAFE_INTEGER);
                    }
                    "belt-construction" => {
                        state.base_value_mut()["construction"]["conveyor_belt_mk1"] =
                            Value::from(MAX_JAVASCRIPT_SAFE_INTEGER);
                    }
                    _ => unreachable!(),
                }
                let before = state.canonical_sha256().unwrap();
                let command = fuel_item_command(9, Value::from("energetic_graphite"));
                let result = if replay {
                    state.replay_operation(
                        9,
                        10,
                        Some(&command),
                        0.0,
                        0.0,
                        crate::CoreAdvanceMode::Exact,
                    )
                } else {
                    state.apply_player_authority_command(&command).map(|_| ())
                };
                assert!(result.is_err());
                assert_eq!(state.revision, 9);
                assert_eq!(state.canonical_sha256().unwrap(), before);
            }
        }
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
    fn player_authority_entity_configuration_rejects_foreign_or_non_builtin_targets_atomically() {
        fn assert_rejected(
            mut state: CoreState,
            entity_id: &str,
            field: &str,
            value: Value,
            expected_error: &str,
        ) {
            let before_revision = state.revision;
            let before = state.canonical_sha256().unwrap();
            let error = state
                .apply_player_authority_command(&entity_leaf_command(
                    before_revision,
                    entity_id,
                    field,
                    value,
                ))
                .unwrap_err();
            assert!(
                format!("{error:#}").contains(expected_error),
                "unexpected error: {error:#}"
            );
            assert_eq!(state.revision, before_revision);
            assert_eq!(state.canonical_sha256().unwrap(), before);
        }

        let mut foreign = player_entity_configuration_state();
        let foreign_revision = foreign.revision;
        foreign
            .apply_command(&entity_leaf_command(
                foreign_revision,
                "smelter-a",
                "planetId",
                Value::from("ashen"),
            ))
            .unwrap();
        assert_rejected(
            foreign,
            "smelter-a",
            "powerPriority",
            Value::from(1),
            "not on the active planet",
        );

        let mut custom_machine = player_entity_configuration_state();
        let custom_machine_revision = custom_machine.revision;
        custom_machine
            .apply_command(&entity_leaf_command(
                custom_machine_revision,
                "smelter-a",
                "buildingId",
                Value::from("MOD/custom-machine"),
            ))
            .unwrap();
        assert_rejected(
            custom_machine,
            "smelter-a",
            "powerPriority",
            Value::from(1),
            "not a built-in ordinary consumer",
        );

        assert_rejected(
            player_station_configuration_state(),
            "station-ils",
            "powerPriority",
            Value::from(1),
            "not a built-in ordinary consumer",
        );

        let mut custom_splitter = player_entity_configuration_state();
        let custom_splitter_revision = custom_splitter.revision;
        custom_splitter
            .apply_command(&entity_leaf_command(
                custom_splitter_revision,
                "splitter-a",
                "buildingId",
                Value::from("MOD/custom-splitter"),
            ))
            .unwrap();
        assert_rejected(
            custom_splitter,
            "splitter-a",
            "distributionMode",
            Value::from("priority"),
            "not the built-in splitter",
        );
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
    fn player_authority_preserves_legacy_multi_station_configuration_shape() {
        let mut state = player_station_configuration_state();
        let mut command = empty_player_command(state.revision);
        command.changed_entities = vec![
            RecordPatch {
                id: "station-ils".to_owned(),
                changes: vec![station_slot_leaf(0, "priority", Value::from(2))],
            },
            RecordPatch {
                id: "station-pls".to_owned(),
                changes: vec![station_slot_leaf(0, "priority", Value::from(2))],
            },
        ];
        state.apply_player_authority_command(&command).unwrap();
        for station_id in ["station-ils", "station-pls"] {
            let station = state
                .parse_entity(*state.entity_index.get(station_id).unwrap())
                .unwrap();
            assert_eq!(station["stationSlots"][0]["priority"], 2);
        }
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
    fn player_authority_preserves_remote_station_configuration_support() {
        let mut state = player_station_configuration_state();
        let mut slot = empty_player_command(state.revision);
        slot.changed_entities = vec![RecordPatch {
            id: "station-remote".to_owned(),
            changes: vec![station_slot_leaf(0, "priority", Value::from(2))],
        }];
        state.apply_player_authority_command(&slot).unwrap();
        state
            .apply_player_authority_command(&entity_leaf_command(
                state.revision,
                "station-remote",
                "stationWarpEnabled",
                Value::from(false),
            ))
            .unwrap();
        let remote = state
            .parse_entity(*state.entity_index.get("station-remote").unwrap())
            .unwrap();
        assert_eq!(remote["stationSlots"][0]["priority"], 2);
        assert_eq!(remote["stationWarpEnabled"], false);
    }

    #[test]
    fn player_authority_station_configuration_requires_builtin_complete_station() {
        let mut malformed = player_station_configuration_state();
        let index = *malformed.entity_index.get("station-ils").unwrap();
        let mut slots = malformed.parse_entity(index).unwrap()["stationSlots"].clone();
        slots.as_array_mut().unwrap().pop();
        malformed
            .apply_command(&entity_leaf_command(
                malformed.revision,
                "station-ils",
                "stationSlots",
                slots,
            ))
            .unwrap();

        let mut mixed = empty_player_command(10);
        mixed.changed_entities = vec![RecordPatch {
            id: "station-ils".to_owned(),
            changes: vec![
                station_slot_leaf(0, "priority", Value::from(2)),
                ValuePatch {
                    path: vec![PathSegment::Key("stationHubEnabled".to_owned())],
                    operation: "set".to_owned(),
                    value: Some(Value::from(true)),
                },
            ],
        }];
        let commands = [
            (
                player_station_configuration_state_for_registry("MOD/station-registry"),
                entity_leaf_command(10, "station-ils", "stationWarpEnabled", Value::from(false)),
            ),
            (malformed, {
                let mut command = empty_player_command(11);
                command.changed_entities = vec![RecordPatch {
                    id: "station-ils".to_owned(),
                    changes: vec![station_slot_leaf(0, "priority", Value::from(2))],
                }];
                command
            }),
            (player_station_configuration_state(), mixed),
        ];
        for (mut state, command) in commands {
            let before_revision = state.revision;
            let before = state.canonical_sha256().unwrap();
            assert!(state.apply_player_authority_command(&command).is_err());
            assert_eq!(state.revision, before_revision);
            assert_eq!(state.canonical_sha256().unwrap(), before);
        }
    }

    #[test]
    fn player_authority_station_primary_mirror_uses_first_configured_nonzero_slot() {
        let mut state = player_station_configuration_state();
        let index = *state.entity_index.get("station-ils").unwrap();
        let mut slots = state.parse_entity(index).unwrap()["stationSlots"].clone();
        slots[0]["itemId"] = Value::Null;
        slots[0]["localMode"] = Value::from("storage");
        slots[0]["remoteMode"] = Value::from("storage");
        slots[2]["itemId"] = Value::from("iron_ore");
        slots[2]["localMode"] = Value::from("supply");
        slots[2]["remoteMode"] = Value::from("demand");
        slots[2]["minimumLoad"] = Value::from(0.5);
        state
            .apply_command(&entity_leaf_command(
                state.revision,
                "station-ils",
                "stationSlots",
                slots,
            ))
            .unwrap();

        let mut command = empty_player_command(state.revision);
        command.changed_entities = vec![RecordPatch {
            id: "station-ils".to_owned(),
            changes: vec![
                station_slot_leaf(2, "minimumLoad", Value::from(0.25)),
                ValuePatch {
                    path: vec![PathSegment::Key("stationMinimumLoad".to_owned())],
                    operation: "set".to_owned(),
                    value: Some(Value::from(0.25)),
                },
            ],
        }];
        state.apply_player_authority_command(&command).unwrap();
        let station = state.parse_entity(index).unwrap();
        assert_eq!(station["stationSlots"][2]["minimumLoad"], 0.25);
        assert_eq!(station["stationMinimumLoad"], 0.25);
        assert_eq!(station["storedItemId"], "iron_ore");
        assert_eq!(station["stationMode"], "demand");
    }

    #[test]
    fn lowering_station_max_stock_preserves_inventory_and_routes() {
        let mut state = player_station_configuration_state();
        let route = station_route(
            "preserved-route",
            "station-remote",
            "iron_ore",
            "remote",
            0.4,
            "station-ils",
            (true, 1),
        );
        let mut seed = empty_player_command(state.revision);
        seed.changed_entities = vec![RecordPatch {
            id: "station-ils".to_owned(),
            changes: vec![
                ValuePatch {
                    path: vec![PathSegment::Key("outputs".to_owned())],
                    operation: "set".to_owned(),
                    value: Some(serde_json::json!({ "iron_ore": 1000 })),
                },
                ValuePatch {
                    path: vec![PathSegment::Key("stationRoutes".to_owned())],
                    operation: "set".to_owned(),
                    value: Some(Value::Array(vec![route.clone()])),
                },
            ],
        }];
        state.apply_command(&seed).unwrap();
        let mut command = empty_player_command(state.revision);
        command.changed_entities = vec![RecordPatch {
            id: "station-ils".to_owned(),
            changes: vec![station_slot_leaf(0, "maxStock", Value::from(10))],
        }];
        state.apply_player_authority_command(&command).unwrap();
        let station = state
            .parse_entity(*state.entity_index.get("station-ils").unwrap())
            .unwrap();
        assert_eq!(station["stationSlots"][0]["maxStock"], 10);
        assert_eq!(station["outputs"]["iron_ore"], 1000);
        assert_eq!(station["stationRoutes"], Value::Array(vec![route]));
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
        // Reproduce the legacy mirror drift that this semantic command is
        // required to repair.  The shared station fixture is otherwise kept
        // canonical so strict station projections can fail closed on drift.
        let mut legacy_drift = empty_player_command(state.revision);
        legacy_drift.changed_entities = vec![RecordPatch {
            id: "station-pls".to_owned(),
            changes: vec![
                ValuePatch {
                    path: vec![PathSegment::Key("storedItemId".to_owned())],
                    operation: "set".to_owned(),
                    value: Some(Value::from("iron_ore")),
                },
                ValuePatch {
                    path: vec![PathSegment::Key("stationMode".to_owned())],
                    operation: "set".to_owned(),
                    value: Some(Value::from("demand")),
                },
            ],
        }];
        state.apply_command(&legacy_drift).unwrap();

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
    fn player_authority_assigns_station_slot_item_with_exact_material_and_topology_accounting() {
        let mut state = player_station_slot_item_state();
        let previous_revision = state.revision;
        let command = station_slot_item_assignment_command(&state);
        let durable: SimulationCommandPatch =
            serde_json::from_str(&serde_json::to_string(&command).unwrap()).unwrap();
        let applied = state.apply_player_authority_command(&durable).unwrap();

        assert_eq!(applied.previous_revision, previous_revision);
        assert_eq!(applied.revision, previous_revision + 1);
        assert_eq!(
            applied.changed_entity_ids,
            ["station-ils", "station-remote"]
        );
        assert_eq!(
            applied.changed_belt_ids,
            ["belt-station-in", "belt-station-out"]
        );
        assert!(applied.topology_dirty);

        let target = state
            .parse_entity(*state.entity_index.get("station-ils").unwrap())
            .unwrap();
        assert_eq!(target["inputs"]["iron_ore"], 0);
        assert_eq!(target["outputs"]["iron_ore"], 0);
        assert_eq!(target["stationSlots"][0]["itemId"], "iron_ingot");
        assert_eq!(target["stationSlots"][0]["remoteMode"], "supply");
        assert_eq!(target["storedItemId"], "iron_ingot");
        assert_eq!(target["stationMode"], "supply");
        assert_eq!(target["stationProgress"], 0);
        assert!(target.get("stationPeerId").is_none());
        assert_eq!(target["stationRoutes"], serde_json::json!([]));
        assert_eq!(target["stationWarpers"], 50);
        assert_eq!(
            target["stationSlots"][0]["modSlotPayload"],
            serde_json::json!({ "owner": "pack:slot", "revision": 41 })
        );
        assert_eq!(
            target["modPayload"],
            serde_json::json!({ "owner": "pack:test", "revision": 31 })
        );

        let remote = state
            .parse_entity(*state.entity_index.get("station-remote").unwrap())
            .unwrap();
        assert_eq!(remote["stationRoutes"], serde_json::json!([]));
        assert_eq!(remote["stationProgress"], 0);
        assert_eq!(remote["stationWarpers"], 50);
        assert_eq!(remote["stationPeerId"], "station-ils");
        // Route cargo was a reservation backed by this output. Canceling the
        // route releases it in place instead of minting a second copy.
        assert_eq!(remote["outputs"]["iron_ore"], 150);

        assert_eq!(state.base_value()["tray"]["iron_ore"], 18);
        assert_eq!(state.base_value()["tray"]["space_warper"], 11);
        assert_eq!(
            state.base_value()["planetTrays"]["ashen"]["space_warper"],
            8
        );
        assert_eq!(state.base_value()["construction"]["conveyor_belt_mk1"], 10);
        assert!(!state.belt_index.contains_key("belt-station-in"));
        assert!(!state.belt_index.contains_key("belt-station-out"));
        let kept = state
            .parse_belt(*state.belt_index.get("belt-station-keep").unwrap())
            .unwrap();
        assert_eq!(kept["itemId"], "iron_ingot");
        assert_eq!(
            kept["modPayload"],
            serde_json::json!({ "owner": "pack:item-belt", "revision": "belt-station-keep" })
        );

        // Iron cargo: 7 input + 11 output + 150 source output remains 168.
        assert_eq!(
            state.base_value()["tray"]["iron_ore"].as_u64().unwrap()
                + target["inputs"]["iron_ore"].as_u64().unwrap()
                + target["outputs"]["iron_ore"].as_u64().unwrap()
                + remote["outputs"]["iron_ore"].as_u64().unwrap(),
            168
        );
        // Warpers: the three route reservations move back into two station
        // inventories/trays exactly once (10 + 7 + 49 + 50 + 3 = 119).
        assert_eq!(
            state.base_value()["tray"]["space_warper"].as_u64().unwrap()
                + state.base_value()["planetTrays"]["ashen"]["space_warper"]
                    .as_u64()
                    .unwrap()
                + target["stationWarpers"].as_u64().unwrap()
                + remote["stationWarpers"].as_u64().unwrap(),
            119
        );
        // Construction inventory plus installed lanes stays at twelve.
        let installed_lanes = (0..state.belts.ids.len())
            .map(|index| state.parse_belt(index).unwrap()["lanes"].as_u64().unwrap())
            .sum::<u64>();
        assert_eq!(
            state.base_value()["construction"]["conveyor_belt_mk1"]
                .as_u64()
                .unwrap()
                + installed_lanes,
            12
        );
    }

    #[test]
    fn player_authority_removes_station_slot_item_across_durable_null_delete_boundary() {
        let mut state = player_station_configuration_state();
        let command = station_slot_item_removal_command(&state);
        let raw = serde_json::to_string(&command).unwrap();
        let durable: SimulationCommandPatch = serde_json::from_str(&raw).unwrap();
        for path in [
            vec![
                PathSegment::Key("stationSlots".to_owned()),
                PathSegment::Index(0),
                PathSegment::Key("itemId".to_owned()),
            ],
            vec![PathSegment::Key("storedItemId".to_owned())],
            vec![PathSegment::Key("stationPeerId".to_owned())],
        ] {
            assert_eq!(
                durable.changed_entities[0]
                    .changes
                    .iter()
                    .find(|change| patch_paths_equal(&change.path, &path))
                    .and_then(|change| change.value.as_ref()),
                Some(&Value::Null)
            );
        }

        state.apply_player_authority_command(&durable).unwrap();
        let target = state
            .parse_entity(*state.entity_index.get("station-ils").unwrap())
            .unwrap();
        assert!(target["stationSlots"][0].get("itemId").is_none());
        assert_eq!(target["stationSlots"][0]["localMode"], "storage");
        assert_eq!(target["stationSlots"][0]["remoteMode"], "storage");
        assert!(target.get("storedItemId").is_none());
        assert!(target.get("stationPeerId").is_none());
        assert_eq!(target["stationMode"], "demand");
        assert_eq!(target["stationMinimumLoad"], 0.5);
        assert_eq!(target["inputs"]["iron_ore"], 0);
        assert_eq!(target["outputs"]["iron_ore"], 0);
        assert_eq!(
            target["modPayload"],
            serde_json::json!({ "owner": "pack:test", "revision": 31 })
        );
    }

    #[test]
    fn player_authority_station_slot_item_replay_is_deterministic_and_stale_safe() {
        let baseline = player_station_slot_item_state();
        let command = station_slot_item_assignment_command(&baseline);
        let durable: SimulationCommandPatch =
            serde_json::from_str(&serde_json::to_string(&command).unwrap()).unwrap();
        let mut reordered = durable.clone();
        reordered.top_level_changes.reverse();
        reordered.changed_entities.reverse();
        for record in &mut reordered.changed_entities {
            record.changes.reverse();
        }

        let mut first = baseline.clone();
        let mut second = baseline.clone();
        first.apply_player_authority_command(&durable).unwrap();
        second.apply_player_authority_command(&reordered).unwrap();
        assert_eq!(first.revision, second.revision);
        assert_eq!(
            first.canonical_sha256().unwrap(),
            second.canonical_sha256().unwrap()
        );

        let committed_hash = first.canonical_sha256().unwrap();
        let error = first.apply_player_authority_command(&durable).unwrap_err();
        assert!(format!("{error:#}").contains("base revision is not current"));
        assert_eq!(first.canonical_sha256().unwrap(), committed_hash);
    }

    #[test]
    fn station_slot_semantic_intents_match_direct_derivations_and_generic_wal_replay() {
        let mode_baseline = player_station_route_mode_state();
        let direct_mode = station_remote_mode_with_route_cancellation_command(&mode_baseline);
        let mode_intent = station_slot_mode_intent_command(
            mode_baseline.revision,
            "station-ils",
            Value::from(0),
            "remote",
            "storage",
        );
        let mut direct_mode_state = mode_baseline.clone();
        let mut live_mode_state = mode_baseline.clone();
        let mut replayed_mode_state = mode_baseline;
        let direct_mode_receipt = direct_mode_state
            .apply_player_authority_command(&direct_mode)
            .unwrap();
        let live_mode_receipt = live_mode_state
            .apply_player_authority_command(&mode_intent)
            .unwrap();
        let replayed_mode_receipt = replayed_mode_state.apply_command(&mode_intent).unwrap();
        assert_eq!(live_mode_receipt, direct_mode_receipt);
        assert_eq!(replayed_mode_receipt, direct_mode_receipt);
        assert_eq!(
            live_mode_state.canonical_sha256().unwrap(),
            direct_mode_state.canonical_sha256().unwrap()
        );
        assert_eq!(
            replayed_mode_state.canonical_sha256().unwrap(),
            direct_mode_state.canonical_sha256().unwrap()
        );

        let item_baseline = player_station_slot_item_state();
        let item_target_before = item_baseline
            .parse_entity(*item_baseline.entity_index.get("station-ils").unwrap())
            .unwrap();
        let item_peer_before = item_baseline
            .parse_entity(*item_baseline.entity_index.get("station-remote").unwrap())
            .unwrap();
        assert_eq!(
            item_target_before["stationRoutes"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        assert_eq!(
            item_peer_before["stationRoutes"].as_array().unwrap().len(),
            1
        );
        let direct_item = station_slot_item_assignment_command(&item_baseline);
        let item_intent = station_slot_item_intent_command(
            item_baseline.revision,
            "station-ils",
            Value::from(0),
            Value::from("iron_ingot"),
        );
        let mut direct_item_state = item_baseline.clone();
        let mut live_item_state = item_baseline.clone();
        let mut replayed_item_state = item_baseline;
        let direct_item_receipt = direct_item_state
            .apply_player_authority_command(&direct_item)
            .unwrap();
        let live_item_receipt = live_item_state
            .apply_player_authority_command(&item_intent)
            .unwrap();
        let replayed_item_receipt = replayed_item_state.apply_command(&item_intent).unwrap();
        assert_eq!(live_item_receipt, direct_item_receipt);
        assert_eq!(replayed_item_receipt, direct_item_receipt);
        assert_eq!(
            live_item_state.canonical_sha256().unwrap(),
            direct_item_state.canonical_sha256().unwrap()
        );
        assert_eq!(
            replayed_item_state.canonical_sha256().unwrap(),
            direct_item_state.canonical_sha256().unwrap()
        );
        let target = live_item_state
            .parse_entity(*live_item_state.entity_index.get("station-ils").unwrap())
            .unwrap();
        let peer = live_item_state
            .parse_entity(*live_item_state.entity_index.get("station-remote").unwrap())
            .unwrap();
        assert_eq!(target["stationRoutes"], serde_json::json!([]));
        assert_eq!(peer["stationRoutes"], serde_json::json!([]));
        assert_eq!(peer["outputs"]["iron_ore"], 150);
        assert_eq!(live_item_state.base_value()["tray"]["iron_ore"], 18);
        // The two target-owned routes and the remote peer-owned route are
        // canceled together. Each owner's reserved warpers fill that station
        // first; the target overflow returns to the active tray and the remote
        // owner's overflow returns to its own planet tray.
        assert_eq!(target["stationWarpers"], 50);
        assert_eq!(peer["stationWarpers"], 50);
        assert_eq!(live_item_state.base_value()["tray"]["space_warper"], 11);
        assert_eq!(
            live_item_state.base_value()["planetTrays"]["ashen"]["space_warper"],
            8
        );
        assert_eq!(
            live_item_receipt.changed_belt_ids,
            ["belt-station-in", "belt-station-out"]
        );
    }

    #[test]
    fn station_slot_item_null_intent_matches_direct_and_preserves_unknown_payloads() {
        let mut baseline = player_station_configuration_state();
        let quantum_network_sentinel = serde_json::json!({
            "enabled": true,
            "inventory": { "iron_ore": "25000", "hydrogen": "9007199254740991" },
            "itemCapacities": { "iron_ore": "100000", "hydrogen": "9007199254740991" },
            "routingCursors": { "iron_ore": 17 },
            "uploadRoutingCursors": { "hydrogen": 23 },
            "runtimeFlow": {
                "boundarySecond": 120,
                "uploaded": { "iron_ore": "31" },
                "withdrawn": { "hydrogen": "29" }
            }
        });
        baseline.base_value_mut().insert(
            "quantumLogisticsNetwork".to_owned(),
            quantum_network_sentinel.clone(),
        );
        let target_index = *baseline.entity_index.get("station-ils").unwrap();
        let mut target = baseline.parse_entity(target_index).unwrap();
        target["stationSlots"][0]["quantumSlotPayload"] =
            serde_json::json!({ "owner": "future:quantum", "revision": 7 });
        target["quantumMaterialBuffer"] = serde_json::json!({ "hydrogen": 123 });
        baseline.replace_entity_raw(
            target_index,
            Arc::<str>::from(serde_json::to_string(&target).unwrap()),
        );
        baseline.rebuild_indexes().unwrap();

        let direct = station_slot_item_removal_command(&baseline);
        let intent = station_slot_item_intent_command(
            baseline.revision,
            "station-ils",
            Value::from(0),
            Value::Null,
        );
        let mut direct_state = baseline.clone();
        let mut intent_state = baseline;
        direct_state
            .apply_player_authority_command(&direct)
            .unwrap();
        intent_state
            .apply_player_authority_command(&intent)
            .unwrap();
        assert_eq!(
            intent_state.canonical_sha256().unwrap(),
            direct_state.canonical_sha256().unwrap()
        );
        let target = intent_state
            .parse_entity(*intent_state.entity_index.get("station-ils").unwrap())
            .unwrap();
        assert!(target["stationSlots"][0].get("itemId").is_none());
        assert_eq!(
            target["stationSlots"][0]["quantumSlotPayload"],
            serde_json::json!({ "owner": "future:quantum", "revision": 7 })
        );
        assert_eq!(
            target["quantumMaterialBuffer"],
            serde_json::json!({ "hydrogen": 123 })
        );
        assert_eq!(
            intent_state.base_value()["quantumLogisticsNetwork"],
            quantum_network_sentinel
        );
    }

    #[test]
    fn station_slot_item_intent_refunds_portable_fleet_without_touching_tray() {
        for (item_id, expected_drones, expected_vessels) in
            [("logistics_drone", 17, 20), ("logistics_vessel", 10, 27)]
        {
            let mut state = player_station_configuration_state();
            state.base_value_mut()["portableFleet"] = serde_json::json!({
                "logistics_drone": 10,
                "logistics_vessel": 20,
            });
            state.base_value_mut()["tray"]["logistics_drone"] = Value::from(777);
            state.base_value_mut()["tray"]["logistics_vessel"] = Value::from(888);
            let target_index = *state.entity_index.get("station-ils").unwrap();
            let mut target = state.parse_entity(target_index).unwrap();
            target["stationSlots"][0]["itemId"] = Value::from(item_id);
            target["storedItemId"] = Value::from(item_id);
            target["inputs"] =
                Value::Object([(item_id.to_owned(), Value::from(3))].into_iter().collect());
            target["outputs"] =
                Value::Object([(item_id.to_owned(), Value::from(4))].into_iter().collect());
            target["stationSlots"][0]["slotPayload"] =
                serde_json::json!({ "owner": "future:slot", "revision": 9 });
            state.replace_entity_raw(
                target_index,
                Arc::<str>::from(serde_json::to_string(&target).unwrap()),
            );
            state.rebuild_indexes().unwrap();

            let intent = station_slot_item_intent_command(
                state.revision,
                "station-ils",
                Value::from(0),
                Value::Null,
            );
            state.apply_player_authority_command(&intent).unwrap();
            assert_eq!(
                state.base_value()["portableFleet"]["logistics_drone"],
                expected_drones
            );
            assert_eq!(
                state.base_value()["portableFleet"]["logistics_vessel"],
                expected_vessels
            );
            assert_eq!(state.base_value()["tray"]["logistics_drone"], 777);
            assert_eq!(state.base_value()["tray"]["logistics_vessel"], 888);
            let target = state
                .parse_entity(*state.entity_index.get("station-ils").unwrap())
                .unwrap();
            assert_eq!(target["inputs"][item_id], 0);
            assert_eq!(target["outputs"][item_id], 0);
            assert_eq!(
                target["stationSlots"][0]["slotPayload"],
                serde_json::json!({ "owner": "future:slot", "revision": 9 })
            );
        }
    }

    #[test]
    fn station_slot_semantic_intents_fail_closed_for_untrusted_or_malformed_requests() {
        let baseline = player_station_configuration_state();
        let mut mixed = station_slot_mode_intent_command(
            baseline.revision,
            "station-ils",
            Value::from(0),
            "local",
            "demand",
        );
        mixed.top_level_changes.push(ValuePatch {
            path: vec![PathSegment::Key("paused".to_owned())],
            operation: "set".to_owned(),
            value: Some(Value::from(true)),
        });
        let mut extra_key = station_slot_mode_intent_command(
            baseline.revision,
            "station-ils",
            Value::from(0),
            "local",
            "demand",
        );
        extra_key.changed_entities[0].changes[0]
            .value
            .as_mut()
            .unwrap()["rendererDerived"] = Value::from(true);
        let mut repeated = station_slot_item_intent_command(
            baseline.revision,
            "station-ils",
            Value::from(0),
            Value::Null,
        );
        let repeated_change = repeated.changed_entities[0].changes[0].clone();
        repeated.changed_entities[0].changes.push(repeated_change);
        let mut delete_marker = station_slot_item_intent_command(
            baseline.revision,
            "station-ils",
            Value::from(0),
            Value::Null,
        );
        delete_marker.changed_entities[0].changes[0].operation = "delete".to_owned();
        let commands = [
            mixed,
            extra_key,
            repeated,
            delete_marker,
            station_slot_mode_intent_command(
                baseline.revision,
                "station-pls",
                Value::from(0),
                "remote",
                "demand",
            ),
            station_slot_mode_intent_command(
                baseline.revision,
                "station-ils",
                Value::from(5),
                "local",
                "demand",
            ),
            station_slot_mode_intent_command(
                baseline.revision,
                "station-ils",
                Value::from(0.5),
                "local",
                "demand",
            ),
            station_slot_mode_intent_command(
                baseline.revision,
                "station-ils",
                Value::from(0),
                "local",
                "supply",
            ),
            station_slot_item_intent_command(
                baseline.revision,
                "station-ils",
                Value::from(0),
                Value::from("missing-item"),
            ),
            station_slot_item_intent_command(
                baseline.revision,
                "station-empty",
                Value::from(0),
                Value::Null,
            ),
            station_slot_item_intent_command(
                baseline.revision + 1,
                "station-ils",
                Value::from(0),
                Value::Null,
            ),
        ];
        for command in commands {
            let mut state = baseline.clone();
            let before_revision = state.revision;
            let before_hash = state.canonical_sha256().unwrap();
            assert!(state.apply_player_authority_command(&command).is_err());
            assert_eq!(state.revision, before_revision);
            assert_eq!(state.canonical_sha256().unwrap(), before_hash);
        }

        for (mut state, command) in [
            (
                player_station_configuration_state_for_registry("pack:test"),
                station_slot_mode_intent_command(
                    baseline.revision,
                    "station-ils",
                    Value::from(0),
                    "local",
                    "demand",
                ),
            ),
            (
                player_station_configuration_state(),
                station_slot_item_intent_command(
                    baseline.revision,
                    "station-remote",
                    Value::from(0),
                    Value::Null,
                ),
            ),
            (
                player_station_configuration_state(),
                station_slot_item_intent_command(
                    baseline.revision,
                    "station-locked",
                    Value::from(0),
                    Value::Null,
                ),
            ),
        ] {
            let before_revision = state.revision;
            let before_hash = state.canonical_sha256().unwrap();
            assert!(state.apply_player_authority_command(&command).is_err());
            assert_eq!(state.revision, before_revision);
            assert_eq!(state.canonical_sha256().unwrap(), before_hash);
        }

        let mut malformed_slots = player_station_configuration_state();
        let target_index = *malformed_slots.entity_index.get("station-ils").unwrap();
        let mut target = malformed_slots.parse_entity(target_index).unwrap();
        target["stationSlots"].as_array_mut().unwrap().pop();
        malformed_slots.replace_entity_raw(
            target_index,
            Arc::<str>::from(serde_json::to_string(&target).unwrap()),
        );
        malformed_slots.rebuild_indexes().unwrap();
        let before_hash = malformed_slots.canonical_sha256().unwrap();
        assert!(
            malformed_slots
                .apply_player_authority_command(&station_slot_item_intent_command(
                    malformed_slots.revision,
                    "station-ils",
                    Value::from(0),
                    Value::Null,
                ))
                .is_err()
        );
        assert_eq!(malformed_slots.canonical_sha256().unwrap(), before_hash);
    }

    #[test]
    fn player_authority_station_slot_item_fails_closed_on_forgery_or_invalid_source() {
        let baseline = player_station_slot_item_state();
        let canonical = station_slot_item_assignment_command(&baseline);

        let mut forged_buffer_refund = canonical.clone();
        forged_buffer_refund
            .top_level_changes
            .iter_mut()
            .find(|change| path_matches(&change.path, &["tray", "iron_ore"]))
            .unwrap()
            .value = Some(Value::from(19));
        let mut missing_belt = canonical.clone();
        missing_belt.removed_belt_ids.pop();
        let mut extra_belt = canonical.clone();
        extra_belt
            .removed_belt_ids
            .push("belt-station-keep".to_owned());
        let mut reordered_belts = canonical.clone();
        reordered_belts.removed_belt_ids.reverse();
        let mut missing_route_owner = canonical.clone();
        missing_route_owner.changed_entities.pop();
        let mut forged_warper_owner = canonical.clone();
        forged_warper_owner.changed_entities[0]
            .changes
            .iter_mut()
            .find(|change| path_matches(&change.path, &["stationWarpers"]))
            .unwrap()
            .value = Some(Value::from(49));
        let mut duplicate_intent = canonical.clone();
        duplicate_intent.changed_entities[0]
            .changes
            .push(station_slot_leaf(1, "itemId", Value::from("iron_ingot")));
        let mut invalid_item = canonical.clone();
        invalid_item.changed_entities[0]
            .changes
            .iter_mut()
            .find(|change| station_slot_item_change(change).is_some())
            .unwrap()
            .value = Some(Value::from("missing_mod_item"));
        let mut unchanged_item = canonical.clone();
        unchanged_item.changed_entities[0]
            .changes
            .iter_mut()
            .find(|change| station_slot_item_change(change).is_some())
            .unwrap()
            .value = Some(Value::from("iron_ore"));
        let mut mixed_belt_patch = canonical.clone();
        mixed_belt_patch.changed_belts.push(RecordPatch {
            id: "belt-station-keep".to_owned(),
            changes: vec![ValuePatch {
                path: vec![PathSegment::Key("priority".to_owned())],
                operation: "set".to_owned(),
                value: Some(Value::from(2)),
            }],
        });
        let mut missing_target = canonical.clone();
        missing_target.changed_entities[0].id = "missing-station".to_owned();
        let mut non_station_target = canonical.clone();
        non_station_target.changed_entities[0].id = "smelter-a".to_owned();
        let mut out_of_range_slot = canonical.clone();
        out_of_range_slot.changed_entities[0]
            .changes
            .iter_mut()
            .find(|change| station_slot_item_change(change).is_some())
            .unwrap()
            .path = vec![
            PathSegment::Key("stationSlots".to_owned()),
            PathSegment::Index(PLAYER_STATION_SLOT_COUNT),
            PathSegment::Key("itemId".to_owned()),
        ];

        for command in [
            forged_buffer_refund,
            missing_belt,
            extra_belt,
            reordered_belts,
            missing_route_owner,
            forged_warper_owner,
            duplicate_intent,
            invalid_item,
            unchanged_item,
            mixed_belt_patch,
            missing_target,
            non_station_target,
            out_of_range_slot,
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
        assert!(
            locked
                .apply_player_authority_command(&station_slot_item_assignment_command(&locked))
                .is_err()
        );
        assert_eq!(locked.canonical_sha256().unwrap(), before);

        let mut unbacked = baseline.clone();
        let source_index = *unbacked.entity_index.get("station-remote").unwrap();
        let mut source = unbacked.parse_entity(source_index).unwrap();
        source["outputs"]["iron_ore"] = Value::from(149);
        unbacked.replace_entity_raw(source_index, serde_json::to_string(&source).unwrap().into());
        unbacked.rebuild_indexes().unwrap();
        let before = unbacked.canonical_sha256().unwrap();
        let error = unbacked
            .apply_player_authority_command(&station_slot_item_assignment_command(&unbacked))
            .unwrap_err();
        assert!(format!("{error:#}").contains("not backed by its owner"));
        assert_eq!(unbacked.canonical_sha256().unwrap(), before);

        let mut duplicate_route = baseline.clone();
        let target_index = *duplicate_route.entity_index.get("station-ils").unwrap();
        let mut target = duplicate_route.parse_entity(target_index).unwrap();
        let duplicate_id = target["stationRoutes"][0]["id"].clone();
        target["stationRoutes"][1]["id"] = duplicate_id;
        duplicate_route
            .replace_entity_raw(target_index, serde_json::to_string(&target).unwrap().into());
        duplicate_route.rebuild_indexes().unwrap();
        let before = duplicate_route.canonical_sha256().unwrap();
        let error = duplicate_route
            .apply_player_authority_command(&station_slot_item_assignment_command(&duplicate_route))
            .unwrap_err();
        assert!(format!("{error:#}").contains("route ID is repeated"));
        assert_eq!(duplicate_route.canonical_sha256().unwrap(), before);

        let mut duplicate_item = baseline.clone();
        let target_index = *duplicate_item.entity_index.get("station-ils").unwrap();
        let mut target = duplicate_item.parse_entity(target_index).unwrap();
        target["stationSlots"][1]["itemId"] = Value::from("iron_ingot");
        duplicate_item
            .replace_entity_raw(target_index, serde_json::to_string(&target).unwrap().into());
        duplicate_item.rebuild_indexes().unwrap();
        let before = duplicate_item.canonical_sha256().unwrap();
        let error = duplicate_item
            .apply_player_authority_command(&station_slot_item_assignment_command(&duplicate_item))
            .unwrap_err();
        assert!(format!("{error:#}").contains("already configured"));
        assert_eq!(duplicate_item.canonical_sha256().unwrap(), before);
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
        let mut mixed_warp_toggles =
            entity_leaf_command(10, "station-ils", "stationWarpEnabled", Value::from(false));
        mixed_warp_toggles.changed_entities[0]
            .changes
            .push(ValuePatch {
                path: vec![PathSegment::Key("stationWarperAutoRefill".to_owned())],
                operation: "set".to_owned(),
                value: Some(Value::from(true)),
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
            mixed_warp_toggles,
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
            "portableFleet",
            "logistics_drone",
            17,
        );
        unload.changed_entities[0].changes.push(ValuePatch {
            path: vec![PathSegment::Key("stationProgress".to_owned())],
            operation: "set".to_owned(),
            value: Some(Value::from(0)),
        });
        state.apply_player_authority_command(&unload).unwrap();
        assert_eq!(state.base_value()["portableFleet"]["logistics_drone"], 17);
        assert_eq!(state.base_value()["tray"]["logistics_drone"], 0);

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
    fn player_authority_station_fleet_matches_cross_language_conservation_fixture() {
        let fixture = station_fleet_conservation_fixture();
        for case_name in [
            "drone-partial-load",
            "drone-busy-floor-refund",
            "vessel-busy-floor-refund",
        ] {
            let test_case = station_fleet_conservation_case(case_name);
            let mut state = player_station_fleet_conservation_state();
            let target_id = fixture["targetStationId"].as_str().unwrap();
            let peer_id = fixture["peerStationId"].as_str().unwrap();
            let field = if test_case["kind"] == "drone" {
                "stationDrones"
            } else {
                "stationVessels"
            };
            let item_id = test_case["itemId"].as_str().unwrap();
            let target_before = state
                .parse_entity(*state.entity_index.get(target_id).unwrap())
                .unwrap();
            let peer_before = state
                .parse_entity(*state.entity_index.get(peer_id).unwrap())
                .unwrap();
            let tray_before = state.base_value()["tray"].clone();
            let total_before = target_before[field].as_u64().unwrap()
                + state.base_value()["portableFleet"][item_id]
                    .as_u64()
                    .unwrap();
            let command = station_fleet_conservation_command(&state, &test_case);

            state.apply_player_authority_command(&command).unwrap();

            let target = state
                .parse_entity(*state.entity_index.get(target_id).unwrap())
                .unwrap();
            let peer = state
                .parse_entity(*state.entity_index.get(peer_id).unwrap())
                .unwrap();
            assert_eq!(
                target[field], test_case["expected"]["final"],
                "{case_name} final station fleet"
            );
            assert_eq!(
                state.base_value()["portableFleet"][item_id],
                test_case["expected"]["portableFleetAfter"],
                "{case_name} portable fleet"
            );
            assert_eq!(state.base_value()["tray"], tray_before, "{case_name} tray");
            assert_eq!(target["stationProgress"], 0, "{case_name} target progress");
            assert_eq!(peer["stationProgress"], 0, "{case_name} peer progress");
            assert_eq!(
                peer["stationRoutes"], peer_before["stationRoutes"],
                "{case_name} routes"
            );
            assert_eq!(
                target[field].as_u64().unwrap()
                    + state.base_value()["portableFleet"][item_id]
                        .as_u64()
                        .unwrap(),
                total_before,
                "{case_name} conservation"
            );
        }
    }

    #[test]
    fn player_authority_station_fleet_generic_wal_replay_matches_live_hash() {
        let baseline = player_station_fleet_conservation_state();
        let command = station_fleet_conservation_command(
            &baseline,
            &station_fleet_conservation_case("drone-busy-floor-refund"),
        );
        let durable: SimulationCommandPatch =
            serde_json::from_str(&serde_json::to_string(&command).unwrap()).unwrap();

        let mut live = baseline.clone();
        let receipt = live.apply_player_authority_command(&durable).unwrap();
        let live_hash = live.canonical_sha256().unwrap();

        let mut replayed = baseline;
        replayed
            .replay_operation(
                command.base_revision,
                receipt.revision,
                Some(&durable),
                0.0,
                0.0,
                crate::CoreAdvanceMode::Exact,
            )
            .unwrap();
        assert_eq!(replayed.canonical_sha256().unwrap(), live_hash);
        assert_eq!(replayed.base_value(), live.base_value());
    }

    #[test]
    fn player_authority_station_fleet_intent_partially_loads_and_replays_semantically() {
        let baseline = player_station_fleet_conservation_state();
        let command = station_fleet_intent_command(
            baseline.revision,
            "station-ils",
            "drone",
            Value::from(12),
        );
        let durable_json = serde_json::to_string(&command).unwrap();
        assert!(durable_json.contains("stationFleetTarget"));
        assert!(!durable_json.contains("portableFleetAfter"));
        assert!(!durable_json.contains("stationProgress\":0"));
        let durable: SimulationCommandPatch = serde_json::from_str(&durable_json).unwrap();
        let tray_before = baseline.base_value()["tray"].clone();
        let routes_before = baseline
            .parse_entity(*baseline.entity_index.get("station-empty").unwrap())
            .unwrap()["stationRoutes"]
            .clone();

        let mut live = baseline.clone();
        let receipt = live.apply_player_authority_command(&durable).unwrap();
        assert_eq!(
            receipt.changed_entity_ids,
            vec!["station-empty".to_owned(), "station-ils".to_owned()]
        );
        let target = live
            .parse_entity(*live.entity_index.get("station-ils").unwrap())
            .unwrap();
        let peer = live
            .parse_entity(*live.entity_index.get("station-empty").unwrap())
            .unwrap();
        assert_eq!(target["stationDrones"], 10);
        assert_eq!(live.base_value()["portableFleet"]["logistics_drone"], 0);
        assert_eq!(live.base_value()["tray"], tray_before);
        assert_eq!(target["stationProgress"], 0);
        assert_eq!(peer["stationProgress"], 0);
        assert_eq!(peer["stationRoutes"], routes_before);

        let live_hash = live.canonical_sha256().unwrap();
        let mut replayed = baseline;
        replayed
            .replay_operation(
                command.base_revision,
                receipt.revision,
                Some(&durable),
                0.0,
                0.0,
                crate::CoreAdvanceMode::Exact,
            )
            .unwrap();
        assert_eq!(replayed.canonical_sha256().unwrap(), live_hash);
        assert_eq!(replayed.base_value(), live.base_value());
    }

    #[test]
    fn player_authority_station_fleet_intent_enforces_busy_floor_and_atomic_boundaries() {
        let mut busy = player_station_fleet_conservation_state();
        let tray_before = busy.base_value()["tray"].clone();
        busy.apply_player_authority_command(&station_fleet_intent_command(
            busy.revision,
            "station-ils",
            "vessel",
            Value::from(0),
        ))
        .unwrap();
        let target = busy
            .parse_entity(*busy.entity_index.get("station-ils").unwrap())
            .unwrap();
        assert_eq!(target["stationVessels"], 1);
        assert_eq!(busy.base_value()["portableFleet"]["logistics_vessel"], 5);
        assert_eq!(busy.base_value()["tray"], tray_before);

        let assert_rejected =
            |mut state: CoreState, command: SimulationCommandPatch, expected: &str| {
                let revision = state.revision;
                let hash = state.canonical_sha256().unwrap();
                let error = state.apply_player_authority_command(&command).unwrap_err();
                assert!(
                    format!("{error:#}").contains(expected),
                    "unexpected intent rejection: {error:#}"
                );
                assert_eq!(state.revision, revision);
                assert_eq!(state.canonical_sha256().unwrap(), hash);
            };

        let stale_state = player_station_configuration_state();
        assert_rejected(
            stale_state.clone(),
            station_fleet_intent_command(
                stale_state.revision - 1,
                "station-ils",
                "drone",
                Value::from(6),
            ),
            "base revision is not current",
        );
        assert_rejected(
            stale_state.clone(),
            station_fleet_intent_command(
                stale_state.revision,
                "station-ils",
                "drone",
                Value::from(5),
            ),
            "unchanged",
        );
        let mut no_stock = stale_state.clone();
        no_stock.base_value_mut()["portableFleet"]["logistics_drone"] = Value::from(0);
        assert_rejected(
            no_stock.clone(),
            station_fleet_intent_command(no_stock.revision, "station-ils", "drone", Value::from(6)),
            "unchanged",
        );
        assert_rejected(
            stale_state.clone(),
            station_fleet_intent_command(
                stale_state.revision,
                "station-pls",
                "vessel",
                Value::from(3),
            ),
            "incompatible",
        );
        assert_rejected(
            stale_state.clone(),
            station_fleet_intent_command(
                stale_state.revision,
                "station-locked",
                "drone",
                Value::from(6),
            ),
            "locked or malformed",
        );
        assert_rejected(
            stale_state.clone(),
            station_fleet_intent_command(
                stale_state.revision,
                "station-remote",
                "drone",
                Value::from(6),
            ),
            "active planet",
        );
        let modded = player_station_configuration_state_for_registry("MOD-station-intent");
        assert_rejected(
            modded.clone(),
            station_fleet_intent_command(modded.revision, "station-ils", "drone", Value::from(6)),
            "built-in catalog",
        );
        let mut overflow = stale_state.clone();
        overflow.base_value_mut()["portableFleet"]["logistics_drone"] =
            Value::from(MAX_JAVASCRIPT_SAFE_INTEGER);
        assert_rejected(
            overflow.clone(),
            station_fleet_intent_command(overflow.revision, "station-ils", "drone", Value::from(0)),
            "refund overflows",
        );
        let mut mixed = station_fleet_intent_command(
            stale_state.revision,
            "station-ils",
            "drone",
            Value::from(6),
        );
        mixed.changed_entities[0].changes.push(ValuePatch {
            path: vec![PathSegment::Key("stationDrones".to_owned())],
            operation: "set".to_owned(),
            value: Some(Value::from(6)),
        });
        assert_rejected(stale_state.clone(), mixed, "intent shape");
        let mut extra_key = station_fleet_intent_command(
            stale_state.revision,
            "station-ils",
            "drone",
            Value::from(6),
        );
        extra_key.changed_entities[0].changes[0].value = Some(serde_json::json!({
            "kind": "drone",
            "targetCount": 6,
            "stationDrones": 6
        }));
        assert_rejected(stale_state.clone(), extra_key, "intent is invalid");
        assert_rejected(
            stale_state.clone(),
            station_fleet_intent_command(
                stale_state.revision,
                "station-ils",
                "drone",
                Value::from(MAX_JAVASCRIPT_SAFE_INTEGER + 1),
            ),
            "intent target",
        );
    }

    #[test]
    fn player_authority_station_fleet_conservation_failures_are_atomic() {
        let test_case = station_fleet_conservation_case("drone-busy-floor-refund");
        let assert_rejected =
            |mut state: CoreState, command: SimulationCommandPatch, expected_error: &str| {
                let revision = state.revision;
                let before = state.canonical_sha256().unwrap();
                let error = state.apply_player_authority_command(&command).unwrap_err();
                assert!(
                    format!("{error:#}").contains(expected_error),
                    "unexpected station fleet rejection: {error:#}"
                );
                assert_eq!(state.revision, revision);
                assert_eq!(state.canonical_sha256().unwrap(), before);
            };

        let stale_state = player_station_fleet_conservation_state();
        let mut stale = station_fleet_conservation_command(&stale_state, &test_case);
        stale.base_revision -= 1;
        assert_rejected(stale_state, stale, "base revision is not current");

        let forged_tray_state = player_station_fleet_conservation_state();
        let mut forged_tray = station_fleet_conservation_command(&forged_tray_state, &test_case);
        forged_tray.top_level_changes[0].path[0] = PathSegment::Key("tray".to_owned());
        assert_rejected(forged_tray_state, forged_tray, "protected patch is missing");

        let mut locked_state = player_station_fleet_conservation_state();
        let target_index = *locked_state.entity_index.get("station-ils").unwrap();
        let mut target = locked_state.parse_entity(target_index).unwrap();
        target["interactionLocked"] = Value::from(true);
        locked_state
            .replace_entity_raw(target_index, serde_json::to_string(&target).unwrap().into());
        locked_state.rebuild_indexes().unwrap();
        let locked_command = station_fleet_conservation_command(&locked_state, &test_case);
        assert_rejected(locked_state, locked_command, "locked or malformed");

        let mut malformed_count_state = player_station_fleet_conservation_state();
        let target_index = *malformed_count_state
            .entity_index
            .get("station-ils")
            .unwrap();
        let mut target = malformed_count_state.parse_entity(target_index).unwrap();
        target["stationDrones"] = Value::from("seven");
        malformed_count_state
            .replace_entity_raw(target_index, serde_json::to_string(&target).unwrap().into());
        malformed_count_state.rebuild_indexes().unwrap();
        let malformed_count_command =
            station_fleet_conservation_command(&malformed_count_state, &test_case);
        assert_rejected(
            malformed_count_state,
            malformed_count_command,
            "current station fleet count",
        );

        let mut malformed_route_state = player_station_fleet_conservation_state();
        let peer_index = *malformed_route_state
            .entity_index
            .get("station-empty")
            .unwrap();
        let mut peer = malformed_route_state.parse_entity(peer_index).unwrap();
        peer["stationRoutes"][0]["vehicleCount"] = Value::from("two");
        malformed_route_state
            .replace_entity_raw(peer_index, serde_json::to_string(&peer).unwrap().into());
        malformed_route_state.rebuild_indexes().unwrap();
        let malformed_route_command =
            station_fleet_conservation_command(&malformed_route_state, &test_case);
        assert_rejected(
            malformed_route_state,
            malformed_route_command,
            "busy vehicle count",
        );

        let mut overflow_state = player_station_fleet_conservation_state();
        overflow_state.base_value_mut()["portableFleet"]["logistics_drone"] =
            Value::from(MAX_JAVASCRIPT_SAFE_INTEGER);
        let overflow_command = station_fleet_conservation_command(&overflow_state, &test_case);
        assert_rejected(overflow_state, overflow_command, "fleet refund overflows");

        let modded_state = player_station_fleet_conservation_state_for_registry(
            "station-fleet-conservation-modded",
        );
        let modded_command = station_fleet_conservation_command(&modded_state, &test_case);
        assert_rejected(modded_state, modded_command, "built-in catalog");
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
    fn player_authority_station_warper_intent_partially_loads_and_replays_semantically() {
        let mut baseline = player_station_configuration_state();
        baseline
            .apply_command(&top_level_leaf_command(
                baseline.revision,
                &["research", "completedTechIds"],
                serde_json::json!(["space_warp"]),
            ))
            .unwrap();
        let command =
            station_warper_intent_command(baseline.revision, "station-ils", Value::from(20));
        let durable_json = serde_json::to_string(&command).unwrap();
        assert!(durable_json.contains("stationWarperInventory"));
        assert!(!durable_json.contains("space_warper"));
        let durable: SimulationCommandPatch = serde_json::from_str(&durable_json).unwrap();
        let target_before = baseline
            .parse_entity(*baseline.entity_index.get("station-ils").unwrap())
            .unwrap();
        let progress_before = target_before["stationProgress"].clone();
        let routes_before = target_before["stationRoutes"].clone();

        let mut live = baseline.clone();
        let receipt = live.apply_player_authority_command(&durable).unwrap();
        assert_eq!(receipt.changed_entity_ids, vec!["station-ils".to_owned()]);
        let target = live
            .parse_entity(*live.entity_index.get("station-ils").unwrap())
            .unwrap();
        assert_eq!(target["stationWarpers"], 10);
        assert_eq!(live.base_value()["tray"]["space_warper"], 0);
        assert_eq!(target["stationProgress"], progress_before);
        assert_eq!(target["stationRoutes"], routes_before);

        let live_hash = live.canonical_sha256().unwrap();
        let mut replayed = baseline;
        replayed
            .replay_operation(
                command.base_revision,
                receipt.revision,
                Some(&durable),
                0.0,
                0.0,
                crate::CoreAdvanceMode::Exact,
            )
            .unwrap();
        assert_eq!(replayed.canonical_sha256().unwrap(), live_hash);

        live.apply_player_authority_command(&station_warper_intent_command(
            live.revision,
            "station-ils",
            Value::from(-4),
        ))
        .unwrap();
        let target = live
            .parse_entity(*live.entity_index.get("station-ils").unwrap())
            .unwrap();
        assert_eq!(target["stationWarpers"], 6);
        assert_eq!(live.base_value()["tray"]["space_warper"], 4);
    }

    #[test]
    fn player_authority_station_warper_intent_failures_are_atomic() {
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
        let assert_rejected =
            |mut state: CoreState, command: SimulationCommandPatch, expected: &str| {
                let revision = state.revision;
                let hash = state.canonical_sha256().unwrap();
                let error = state.apply_player_authority_command(&command).unwrap_err();
                assert!(
                    format!("{error:#}").contains(expected),
                    "unexpected warper intent rejection: {error:#}"
                );
                assert_eq!(state.revision, revision);
                assert_eq!(state.canonical_sha256().unwrap(), hash);
            };

        let locked_tech = player_station_configuration_state();
        assert_rejected(
            locked_tech.clone(),
            station_warper_intent_command(locked_tech.revision, "station-ils", Value::from(1)),
            "technology is locked",
        );
        let state = unlocked_state();
        assert_rejected(
            state.clone(),
            station_warper_intent_command(state.revision, "station-ils", Value::from(0)),
            "delta is invalid",
        );
        assert_rejected(
            state.clone(),
            station_warper_intent_command(state.revision, "station-pls", Value::from(1)),
            "incompatible",
        );
        assert_rejected(
            state.clone(),
            station_warper_intent_command(state.revision, "station-locked", Value::from(1)),
            "locked or malformed",
        );
        assert_rejected(
            state.clone(),
            station_warper_intent_command(state.revision, "station-remote", Value::from(1)),
            "active planet",
        );
        let mut no_stock = state.clone();
        no_stock.base_value_mut()["tray"]["space_warper"] = Value::from(0);
        assert_rejected(
            no_stock.clone(),
            station_warper_intent_command(no_stock.revision, "station-ils", Value::from(1)),
            "unchanged",
        );
        let modded = {
            let mut state = player_station_configuration_state_for_registry("MOD-warper-intent");
            state
                .apply_command(&top_level_leaf_command(
                    state.revision,
                    &["research", "completedTechIds"],
                    serde_json::json!(["space_warp"]),
                ))
                .unwrap();
            state
        };
        assert_rejected(
            modded.clone(),
            station_warper_intent_command(modded.revision, "station-ils", Value::from(1)),
            "built-in catalog",
        );
        let mut overflow = state.clone();
        overflow.base_value_mut()["tray"]["space_warper"] =
            Value::from(MAX_JAVASCRIPT_SAFE_INTEGER);
        let index = *overflow.entity_index.get("station-ils").unwrap();
        let mut station = overflow.parse_entity(index).unwrap();
        station["stationWarpers"] = Value::from(1);
        overflow.replace_entity_raw(index, serde_json::to_string(&station).unwrap().into());
        overflow.rebuild_indexes().unwrap();
        assert_rejected(
            overflow.clone(),
            station_warper_intent_command(overflow.revision, "station-ils", Value::from(-1)),
            "refund overflows",
        );
        let mut mixed =
            station_warper_intent_command(state.revision, "station-ils", Value::from(1));
        mixed.changed_entities[0].changes.push(ValuePatch {
            path: vec![PathSegment::Key("stationWarpers".to_owned())],
            operation: "set".to_owned(),
            value: Some(Value::from(1)),
        });
        assert_rejected(state.clone(), mixed, "intent shape");
        let mut extra_key =
            station_warper_intent_command(state.revision, "station-ils", Value::from(1));
        extra_key.changed_entities[0].changes[0].value =
            Some(serde_json::json!({ "delta": 1, "stationWarpers": 1 }));
        assert_rejected(state.clone(), extra_key, "intent is invalid");
        assert_rejected(
            state.clone(),
            station_warper_intent_command(
                state.revision,
                "station-ils",
                Value::from((MAX_JAVASCRIPT_SAFE_INTEGER + 1) as i64),
            ),
            "delta is invalid",
        );
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
    fn player_authority_switches_planet_from_minimal_intent_without_renderer_inventory() {
        let mut state = player_command_state();
        let command = active_planet_to_ashen_command(state.revision);
        assert_eq!(command.top_level_changes.len(), 1);
        assert!(path_matches(
            &command.top_level_changes[0].path,
            &["activePlanetId", "home"]
        ));
        let durable = serde_json::to_string(&command).unwrap();
        assert!(!durable.contains("space_warper"));
        assert!(!durable.contains("generationKw"));
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
    fn player_authority_planet_switch_replays_the_same_semantic_wal_deterministically() {
        let command = active_planet_to_ashen_command(9);
        let durable = serde_json::to_string(&command).unwrap();
        let replayed_command: SimulationCommandPatch = serde_json::from_str(&durable).unwrap();

        let mut live = player_command_state();
        let live_receipt = live.apply_player_authority_command(&command).unwrap();
        let live_hash = live.canonical_sha256().unwrap();

        let mut replayed = player_command_state();
        replayed
            .replay_operation(
                9,
                10,
                Some(&replayed_command),
                0.0,
                0.0,
                crate::CoreAdvanceMode::Exact,
            )
            .unwrap();
        assert_eq!(replayed.canonical_sha256().unwrap(), live_hash);
        assert_eq!(replayed.base_value(), live.base_value());
        assert_eq!(live_receipt.changed_entity_ids, Vec::<String>::new());
        assert_eq!(live_receipt.changed_belt_ids, Vec::<String>::new());
        assert!(live_receipt.topology_dirty);
    }

    #[test]
    fn player_authority_planet_switch_fails_closed_on_stale_forged_or_locked_intent() {
        let mut stale_current = active_planet_to_ashen_command(9);
        stale_current.top_level_changes[0].path[1] = PathSegment::Key("other-current".to_owned());
        let mut extra = active_planet_to_ashen_command(9);
        extra.top_level_changes.push(ValuePatch {
            path: vec![PathSegment::Key("paused".to_owned())],
            operation: "set".to_owned(),
            value: Some(Value::from(true)),
        });
        let mut delete_target = active_planet_to_ashen_command(9);
        delete_target.top_level_changes[0].operation = "delete".to_owned();
        delete_target.top_level_changes[0].value = None;
        let mut changed_entity = active_planet_to_ashen_command(9);
        changed_entity.changed_entities.push(RecordPatch {
            id: "smelter-a".to_owned(),
            changes: vec![ValuePatch {
                path: vec![PathSegment::Key("progress".to_owned())],
                operation: "set".to_owned(),
                value: Some(Value::from(1)),
            }],
        });
        let mut stale_revision = active_planet_to_ashen_command(8);
        stale_revision.top_level_changes[0].value = Some(Value::from("ashen"));
        let nul_target = active_planet_intent(9, "home", "ashen\0forged");
        let nul_current = active_planet_intent(9, "home\0forged", "ashen");
        let commands = [
            (
                active_planet_intent(9, "home", "home"),
                "target is unchanged",
            ),
            (
                active_planet_intent(9, "home", "missing"),
                "not in the catalog",
            ),
            (active_planet_intent(9, "home", "giant"), "is not colonized"),
            (
                top_level_leaf_command(9, &["activePlanetId"], Value::from("ashen")),
                "intent path is invalid",
            ),
            (stale_current, "observed active planet is stale"),
            (extra, "intent shape is invalid"),
            (delete_target, "intent path is invalid"),
            (changed_entity, "intent shape is invalid"),
            (stale_revision, "base revision is not current"),
            (nul_target, "target is invalid"),
            (nul_current, "observed active planet is invalid"),
        ];
        for (command, expected_error) in commands {
            let mut state = player_command_state();
            let before = state.canonical_sha256().unwrap();
            let error = state.apply_player_authority_command(&command).unwrap_err();
            assert!(
                format!("{error:#}").contains(expected_error),
                "unexpected rejection for {expected_error}: {error:#}"
            );
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
    fn player_authority_applies_only_canonical_dyson_launch_and_orbit_controls() {
        let mut state = player_command_state();

        let mode = dyson_launch_command(state.revision, "launchMode", Value::from("sphere"));
        let applied = state.apply_player_authority_command(&mode).unwrap();
        assert_eq!(applied.previous_revision, 9);
        assert_eq!(applied.revision, 10);
        assert!(applied.changed_entity_ids.is_empty());
        assert!(applied.changed_belt_ids.is_empty());
        assert!(applied.topology_dirty);
        assert_eq!(
            state.base_value()["dysonEngineering"]["launchMode"],
            "sphere"
        );

        state
            .apply_player_authority_command(&dyson_launch_command(
                state.revision,
                "launchThrottle",
                Value::from(0.25),
            ))
            .unwrap();
        state
            .apply_player_authority_command(&dyson_launch_command(
                state.revision,
                "launchEnabled",
                Value::from(false),
            ))
            .unwrap();
        assert_eq!(
            state.base_value()["dysonEngineering"]["launchThrottle"],
            0.25
        );
        assert_eq!(
            state.base_value()["dysonEngineering"]["launchEnabled"],
            false
        );
        state
            .apply_player_authority_command(&top_level_leaf_command(
                state.revision,
                &["dysonEngineering", "activeOrbitBySystem", "helios"],
                Value::from("orbit-home-new"),
            ))
            .unwrap();
        assert_eq!(
            state.base_value()["dysonEngineering"]["activeOrbitBySystem"]["helios"],
            "orbit-home-new"
        );
        state
            .apply_player_authority_command(&dyson_orbit_geometry_command(
                state.revision,
                "helios",
                1,
                &[
                    ("radius", Value::from(24_000)),
                    ("inclination", Value::from(-12)),
                    ("longitude", Value::from(359.9)),
                ],
            ))
            .unwrap();
        let orbit = &state.base_value()["dysonEngineering"]["orbitsBySystem"]["helios"][1];
        assert_eq!(orbit["radius"], 24_000);
        assert_eq!(orbit["inclination"], -12);
        assert_eq!(orbit["longitude"], 359.9);
        state
            .apply_player_authority_command(&top_level_leaf_command(
                state.revision,
                &["dysonPlans", "helios", "activeLayerId"],
                Value::from("dyson-layer-new"),
            ))
            .unwrap();
        assert_eq!(
            state.base_value()["dysonPlans"]["helios"]["activeLayerId"],
            "dyson-layer-new"
        );
        assert_eq!(
            state.base_value()["dysonPlans"]["helios"]["layers"][1]["modPayload"],
            serde_json::json!({ "owner": "pack:test" })
        );
        assert_eq!(state.revision, 15);

        let committed_hash = state.canonical_sha256().unwrap();
        let retry_error = state.apply_player_authority_command(&mode).unwrap_err();
        assert!(format!("{retry_error:#}").contains("base revision is not current"));
        assert_eq!(state.canonical_sha256().unwrap(), committed_hash);
    }

    #[test]
    fn player_authority_dyson_launch_and_orbit_controls_fail_closed_without_mutation() {
        let mut delete_mode = dyson_launch_command(9, "launchMode", Value::from("sphere"));
        delete_mode.top_level_changes[0].operation = "delete".to_owned();
        delete_mode.top_level_changes[0].value = None;
        let mut mixed = dyson_launch_command(9, "launchMode", Value::from("sphere"));
        mixed.top_level_changes.push(ValuePatch {
            path: vec![PathSegment::Key("paused".to_owned())],
            operation: "set".to_owned(),
            value: Some(Value::from(true)),
        });
        let mut entity_mixed = dyson_launch_command(9, "launchEnabled", Value::from(false));
        entity_mixed.changed_entities = vec![RecordPatch {
            id: "smelter-a".to_owned(),
            changes: vec![ValuePatch {
                path: vec![PathSegment::Key("interactionLocked".to_owned())],
                operation: "set".to_owned(),
                value: Some(Value::from(true)),
            }],
        }];
        let mut cross_orbit =
            dyson_orbit_geometry_command(9, "helios", 0, &[("radius", Value::from(22_000))]);
        cross_orbit.top_level_changes.push(
            dyson_orbit_geometry_command(9, "helios", 1, &[("inclination", Value::from(12))])
                .top_level_changes
                .remove(0),
        );
        let mut delete_geometry =
            dyson_orbit_geometry_command(9, "helios", 0, &[("radius", Value::from(22_000))]);
        delete_geometry.top_level_changes[0].operation = "delete".to_owned();
        delete_geometry.top_level_changes[0].value = None;
        let mut delete_active_layer = top_level_leaf_command(
            9,
            &["dysonPlans", "helios", "activeLayerId"],
            Value::from("dyson-layer-new"),
        );
        delete_active_layer.top_level_changes[0].operation = "delete".to_owned();
        delete_active_layer.top_level_changes[0].value = None;
        let mut mixed_active_layer = top_level_leaf_command(
            9,
            &["dysonPlans", "helios", "activeLayerId"],
            Value::from("dyson-layer-new"),
        );
        mixed_active_layer.top_level_changes.push(ValuePatch {
            path: vec![PathSegment::Key("paused".to_owned())],
            operation: "set".to_owned(),
            value: Some(Value::from(true)),
        });
        let commands = [
            dyson_launch_command(9, "launchMode", Value::from("balanced")),
            dyson_launch_command(9, "launchMode", Value::from("unlimited")),
            dyson_launch_command(9, "launchThrottle", Value::from(0.9)),
            dyson_launch_command(9, "launchThrottle", Value::from(1)),
            dyson_launch_command(9, "launchEnabled", Value::from("false")),
            dyson_launch_command(9, "launchEnergySpentMj", Value::from(0)),
            top_level_leaf_command(
                9,
                &["dysonEngineering", "activeOrbitBySystem", "helios"],
                Value::from("orbit-home-old"),
            ),
            top_level_leaf_command(
                9,
                &["dysonEngineering", "activeOrbitBySystem", "helios"],
                Value::from("orbit-foreign"),
            ),
            top_level_leaf_command(
                9,
                &["dysonEngineering", "activeOrbitBySystem", "missing"],
                Value::from("orbit-home-new"),
            ),
            top_level_leaf_command(
                9,
                &["dysonEngineering", "activeOrbitBySystem", "helios"],
                Value::from(""),
            ),
            dyson_orbit_geometry_command(9, "helios", 0, &[("radius", Value::from(12_000))]),
            dyson_orbit_geometry_command(9, "helios", 0, &[("radius", Value::from(4_999))]),
            dyson_orbit_geometry_command(9, "helios", 0, &[("radius", Value::from(12_000.5))]),
            dyson_orbit_geometry_command(9, "helios", 0, &[("inclination", Value::from(90.5))]),
            dyson_orbit_geometry_command(9, "helios", 0, &[("longitude", Value::from(360))]),
            dyson_orbit_geometry_command(9, "helios", 0, &[("longitude", Value::from(12.34))]),
            dyson_orbit_geometry_command(9, "missing", 0, &[("radius", Value::from(22_000))]),
            dyson_orbit_geometry_command(9, "helios", 99, &[("radius", Value::from(22_000))]),
            top_level_leaf_command(
                9,
                &["dysonPlans", "helios", "activeLayerId"],
                Value::from("dyson-layer-old"),
            ),
            top_level_leaf_command(
                9,
                &["dysonPlans", "helios", "activeLayerId"],
                Value::from("dyson-layer-foreign"),
            ),
            top_level_leaf_command(
                9,
                &["dysonPlans", "missing", "activeLayerId"],
                Value::from("dyson-layer-new"),
            ),
            top_level_leaf_command(
                9,
                &["dysonPlans", "helios", "layers"],
                serde_json::json!([]),
            ),
            cross_orbit,
            delete_geometry,
            delete_active_layer,
            delete_mode,
            mixed,
            mixed_active_layer,
            entity_mixed,
        ];
        for command in commands {
            let mut state = player_command_state();
            let before = state.canonical_sha256().unwrap();
            assert!(state.apply_player_authority_command(&command).is_err());
            assert_eq!(state.revision, 9);
            assert_eq!(state.canonical_sha256().unwrap(), before);
        }

        let mut malformed = player_command_state();
        malformed.base_value_mut()["dysonEngineering"]["launchThrottle"] = Value::from(0.9);
        let before = malformed.canonical_sha256().unwrap();
        assert!(
            malformed
                .apply_player_authority_command(&dyson_launch_command(
                    malformed.revision,
                    "launchThrottle",
                    Value::from(0.5),
                ))
                .is_err()
        );
        assert_eq!(malformed.canonical_sha256().unwrap(), before);

        let mut malformed_plan = player_command_state();
        malformed_plan.base_value_mut()["dysonPlans"]["helios"]["activeLayerId"] = Value::from("");
        let before = malformed_plan.canonical_sha256().unwrap();
        assert!(
            malformed_plan
                .apply_player_authority_command(&top_level_leaf_command(
                    malformed_plan.revision,
                    &["dysonPlans", "helios", "activeLayerId"],
                    Value::from("dyson-layer-new"),
                ))
                .is_err()
        );
        assert_eq!(malformed_plan.canonical_sha256().unwrap(), before);
    }

    #[test]
    fn player_authority_selects_first_dyson_layer_from_an_unset_plan() {
        let mut state = player_command_state();
        state.base_value_mut()["dysonPlans"]["helios"]["activeLayerId"] = Value::Null;

        state
            .apply_player_authority_command(&top_level_leaf_command(
                state.revision,
                &["dysonPlans", "helios", "activeLayerId"],
                Value::from("dyson-layer-new"),
            ))
            .unwrap();

        assert_eq!(
            state.base_value()["dysonPlans"]["helios"]["activeLayerId"],
            "dyson-layer-new"
        );
        assert_eq!(state.revision, 10);
    }

    #[test]
    fn player_authority_applies_planet_industry_roles_from_the_current_revision() {
        let mut state = player_command_state();

        state
            .apply_player_authority_command(&top_level_leaf_command(
                state.revision,
                &["galaxy", "planetRoles", "home"],
                Value::from("mining"),
            ))
            .unwrap();
        assert_eq!(
            state.base_value()["galaxy"]["planetRoles"]["home"],
            "mining"
        );

        state
            .apply_player_authority_command(&top_level_leaf_command(
                state.revision,
                &["galaxy", "planetRoles", "home"],
                Value::from("auto"),
            ))
            .unwrap();
        state
            .apply_player_authority_command(&top_level_leaf_command(
                state.revision,
                &["galaxy", "planetRoles", "ashen"],
                Value::from("power"),
            ))
            .unwrap();

        assert_eq!(state.base_value()["galaxy"]["planetRoles"]["home"], "auto");
        assert_eq!(
            state.base_value()["galaxy"]["planetRoles"]["ashen"],
            "power"
        );
        assert_eq!(
            state.base_value()["galaxy"]["modPayload"],
            serde_json::json!({ "owner": "pack:test", "revision": 7 })
        );
        assert_eq!(state.revision, 12);
    }

    #[test]
    fn player_authority_planet_industry_roles_fail_closed_without_mutation() {
        let mut delete =
            top_level_leaf_command(9, &["galaxy", "planetRoles", "home"], Value::from("mining"));
        delete.top_level_changes[0].operation = "delete".to_owned();
        delete.top_level_changes[0].value = None;
        let mut mixed =
            top_level_leaf_command(9, &["galaxy", "planetRoles", "home"], Value::from("mining"));
        mixed.top_level_changes.push(ValuePatch {
            path: vec![PathSegment::Key("paused".to_owned())],
            operation: "set".to_owned(),
            value: Some(Value::from(true)),
        });
        let commands = [
            top_level_leaf_command(9, &["galaxy", "planetRoles", "home"], Value::from("auto")),
            top_level_leaf_command(
                9,
                &["galaxy", "planetRoles", "missing"],
                Value::from("mining"),
            ),
            top_level_leaf_command(
                9,
                &["galaxy", "planetRoles", "home"],
                Value::from("factory"),
            ),
            top_level_leaf_command(
                9,
                &["galaxy", "planetRoles"],
                serde_json::json!({ "home": "mining" }),
            ),
            delete,
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
        malformed.base_value_mut()["galaxy"]["planetRoles"]["home"] = Value::from("factory");
        let before = malformed.canonical_sha256().unwrap();
        assert!(
            malformed
                .apply_player_authority_command(&top_level_leaf_command(
                    malformed.revision,
                    &["galaxy", "planetRoles", "home"],
                    Value::from("mining"),
                ))
                .is_err()
        );
        assert_eq!(malformed.canonical_sha256().unwrap(), before);
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
    fn player_authority_time_warp_semantic_intent_is_minimal_and_wal_deterministic() {
        let mut live = player_time_warp_state();
        let mut replay = player_time_warp_state();
        for state in [&mut live, &mut replay] {
            state
                .apply_player_authority_command(&time_warp_changes_command(
                    state.revision,
                    &[("controllerEntityId", Value::from("time-warp-a"))],
                ))
                .unwrap();
        }

        let multiplier = time_warp_intent_command(
            live.revision,
            "time-warp-a",
            "requestedMultiplier",
            Value::from(MAX_JAVASCRIPT_SAFE_INTEGER),
        );
        assert_eq!(multiplier.top_level_changes.len(), 1);
        assert_research_intent_replays_identically(&mut live, &mut replay, &multiplier);
        assert_eq!(
            live.base_value()["timeWarp"]["requestedMultiplier"],
            MAX_JAVASCRIPT_SAFE_INTEGER
        );

        let mut powered_snapshot = time_warp_changes_command(
            live.revision,
            &[
                ("effectiveMultiplier", Value::from(12)),
                ("requiredPowerKw", Value::from(100_000)),
                ("allocatedPowerKw", Value::from(80_000)),
            ],
        );
        powered_snapshot.top_level_changes.insert(
            0,
            ValuePatch {
                path: vec![PathSegment::Key("paused".to_owned())],
                operation: "set".to_owned(),
                value: Some(Value::from(true)),
            },
        );
        live.apply_command(&powered_snapshot).unwrap();
        replay.apply_command(&powered_snapshot).unwrap();
        let enable =
            time_warp_intent_command(live.revision, "time-warp-a", "enabled", Value::from(true));
        assert_research_intent_replays_identically(&mut live, &mut replay, &enable);
        assert_eq!(live.base_value()["paused"], false);
        assert_eq!(live.base_value()["timeWarp"]["enabled"], true);
        assert_eq!(live.base_value()["timeWarp"]["effectiveMultiplier"], 4);
        assert_eq!(live.base_value()["timeWarp"]["requiredPowerKw"], 0);
        assert_eq!(live.base_value()["timeWarp"]["allocatedPowerKw"], 0);

        let powered_snapshot = time_warp_changes_command(
            live.revision,
            &[
                ("effectiveMultiplier", Value::from(15)),
                ("requiredPowerKw", Value::from(200_000)),
                ("allocatedPowerKw", Value::from(200_000)),
            ],
        );
        live.apply_command(&powered_snapshot).unwrap();
        replay.apply_command(&powered_snapshot).unwrap();
        let disable =
            time_warp_intent_command(live.revision, "time-warp-a", "enabled", Value::from(false));
        assert_research_intent_replays_identically(&mut live, &mut replay, &disable);
        assert_eq!(live.base_value()["timeWarp"]["enabled"], false);
        assert_eq!(live.base_value()["timeWarp"]["effectiveMultiplier"], 4);
        assert_eq!(live.base_value()["timeWarp"]["requiredPowerKw"], 0);
        assert_eq!(live.base_value()["timeWarp"]["allocatedPowerKw"], 0);
    }

    #[test]
    fn player_authority_time_warp_semantic_intent_rejects_forged_or_stale_state_atomically() {
        fn selected_state() -> CoreState {
            let mut state = player_time_warp_state();
            state
                .apply_player_authority_command(&time_warp_changes_command(
                    state.revision,
                    &[("controllerEntityId", Value::from("time-warp-a"))],
                ))
                .unwrap();
            state
        }

        let revision = selected_state().revision;
        let mut deleted = time_warp_intent_command(
            revision,
            "time-warp-a",
            "requestedMultiplier",
            Value::from(16),
        );
        deleted.top_level_changes[0].operation = "delete".to_owned();
        deleted.top_level_changes[0].value = None;
        let mut mixed = time_warp_intent_command(
            revision,
            "time-warp-a",
            "requestedMultiplier",
            Value::from(16),
        );
        mixed.top_level_changes.push(ValuePatch {
            path: vec![PathSegment::Key("paused".to_owned())],
            operation: "set".to_owned(),
            value: Some(Value::from(true)),
        });
        let mut mixed_entity = time_warp_intent_command(
            revision,
            "time-warp-a",
            "requestedMultiplier",
            Value::from(16),
        );
        mixed_entity.changed_entities.push(RecordPatch {
            id: "smelter-a".to_owned(),
            changes: vec![ValuePatch {
                path: vec![PathSegment::Key("powerPriority".to_owned())],
                operation: "set".to_owned(),
                value: Some(Value::from(3)),
            }],
        });
        let mut both_targets = time_warp_intent_command(
            revision,
            "time-warp-a",
            "requestedMultiplier",
            Value::from(16),
        );
        both_targets.top_level_changes[0]
            .value
            .as_mut()
            .unwrap()
            .as_object_mut()
            .unwrap()
            .insert("enabled".to_owned(), Value::from(true));
        let mut extra_field = time_warp_intent_command(
            revision,
            "time-warp-a",
            "requestedMultiplier",
            Value::from(16),
        );
        extra_field.top_level_changes[0]
            .value
            .as_mut()
            .unwrap()
            .as_object_mut()
            .unwrap()
            .insert("effectiveMultiplier".to_owned(), Value::from(16));

        let commands = [
            time_warp_intent_command(
                revision - 1,
                "time-warp-a",
                "requestedMultiplier",
                Value::from(16),
            ),
            time_warp_intent_command(
                revision,
                "time-warp-b",
                "requestedMultiplier",
                Value::from(16),
            ),
            time_warp_intent_command(
                revision,
                &"x".repeat(MAX_PLAYER_ORBIT_ID_BYTES + 1),
                "requestedMultiplier",
                Value::from(16),
            ),
            time_warp_intent_command(
                revision,
                "time-warp-a",
                "requestedMultiplier",
                Value::from(15),
            ),
            time_warp_intent_command(
                revision,
                "time-warp-a",
                "requestedMultiplier",
                Value::from(4),
            ),
            time_warp_intent_command(
                revision,
                "time-warp-a",
                "requestedMultiplier",
                Value::from(5.5),
            ),
            time_warp_intent_command(
                revision,
                "time-warp-a",
                "requestedMultiplier",
                Value::from(MAX_JAVASCRIPT_SAFE_INTEGER + 1),
            ),
            time_warp_intent_command(revision, "time-warp-a", "enabled", Value::from(false)),
            time_warp_intent_command(revision, "time-warp-a", "enabled", Value::from("true")),
            deleted,
            mixed,
            mixed_entity,
            both_targets,
            extra_field,
        ];
        for command in commands {
            let mut state = selected_state();
            let before = state.canonical_sha256().unwrap();
            assert!(state.apply_player_authority_command(&command).is_err());
            assert_eq!(state.revision, revision);
            assert_eq!(state.canonical_sha256().unwrap(), before);
        }

        for (field, value) in [
            ("interactionLocked", Value::from(true)),
            ("planetId", Value::from("ashen")),
            ("kind", Value::from("power")),
            ("buildingId", Value::from("arc_smelter")),
        ] {
            let mut state = selected_state();
            let mutation = entity_leaf_command(state.revision, "time-warp-a", field, value);
            state.apply_command(&mutation).unwrap();
            let command = time_warp_intent_command(
                state.revision,
                "time-warp-a",
                "requestedMultiplier",
                Value::from(16),
            );
            let before = state.canonical_sha256().unwrap();
            assert!(
                state.apply_player_authority_command(&command).is_err(),
                "{field}"
            );
            assert_eq!(state.canonical_sha256().unwrap(), before, "{field}");
        }

        let mut modded = player_time_warp_state_for_registry("modded-time-warp-intent");
        modded
            .apply_command(&time_warp_changes_command(
                modded.revision,
                &[("controllerEntityId", Value::from("time-warp-a"))],
            ))
            .unwrap();
        let command = time_warp_intent_command(
            modded.revision,
            "time-warp-a",
            "requestedMultiplier",
            Value::from(16),
        );
        let before = modded.canonical_sha256().unwrap();
        assert!(modded.apply_player_authority_command(&command).is_err());
        assert_eq!(modded.canonical_sha256().unwrap(), before);

        for active_planet_id in ["ashen", "missing"] {
            let mut state = selected_state();
            state
                .apply_command(&top_level_leaf_command(
                    state.revision,
                    &["activePlanetId"],
                    Value::from(active_planet_id),
                ))
                .unwrap();
            let command = time_warp_intent_command(
                state.revision,
                "time-warp-a",
                "requestedMultiplier",
                Value::from(16),
            );
            let before = state.canonical_sha256().unwrap();
            assert!(state.apply_player_authority_command(&command).is_err());
            assert_eq!(state.canonical_sha256().unwrap(), before);
        }
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
        let adjusted = modded
            .apply_player_authority_command(&belt_lane_command(9, Value::from(2), Value::from(4)))
            .unwrap();
        assert_eq!(adjusted.changed_belt_ids, ["belt-priority"]);
        assert_eq!(modded.revision, 10);
        assert_eq!(modded.parse_belt(0).unwrap()["lanes"], 2);
        assert_eq!(modded.base_value()["construction"]["conveyor_belt_mk1"], 4);

        // A custom registry may retain ordinary opaque endpoints while using a
        // built-in belt tier. The removal capability proves that exact belt
        // and refund instead of rejecting the registry fingerprint wholesale.
        let removed = modded
            .apply_player_authority_command(&belt_removal_command(10, Value::from(6)))
            .unwrap();
        assert_eq!(removed.changed_belt_ids, ["belt-priority"]);
        assert_eq!(modded.base_value()["construction"]["conveyor_belt_mk1"], 6);
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
        let mut target = ejector_target_command(
            state.revision,
            &["ejector-a", "ejector-b"],
            "orbit-home-new",
        );
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

    #[test]
    fn player_authority_ejector_target_rejects_mod_cross_planet_locked_mixed_and_same_atomically() {
        let base = player_command_state();
        let revision = base.revision;
        let mut deleted = ejector_target_command(revision, &["ejector-a"], "orbit-home-new");
        deleted.changed_entities[0].changes[0].operation = "delete".to_owned();
        deleted.changed_entities[0].changes[0].value = None;
        let mut mixed = ejector_target_command(revision, &["ejector-a"], "orbit-home-new");
        mixed.changed_entities[0].changes.push(ValuePatch {
            path: vec![PathSegment::Key("powerPriority".to_owned())],
            operation: "set".to_owned(),
            value: Some(Value::from(3)),
        });
        let mut mixed_top = ejector_target_command(revision, &["ejector-a"], "orbit-home-new");
        mixed_top.top_level_changes.push(ValuePatch {
            path: vec![PathSegment::Key("paused".to_owned())],
            operation: "set".to_owned(),
            value: Some(Value::from(true)),
        });
        let commands = [
            ejector_target_command(revision - 1, &["ejector-a"], "orbit-home-new"),
            ejector_target_command(revision, &["ejector-a"], "orbit-home-old"),
            ejector_target_command(revision, &["ejector-a"], "orbit-foreign"),
            ejector_target_command(
                revision,
                &["ejector-a"],
                &"x".repeat(MAX_PLAYER_ORBIT_ID_BYTES + 1),
            ),
            ejector_target_command(revision, &["smelter-a"], "orbit-home-new"),
            deleted,
            mixed,
            mixed_top,
        ];
        for command in commands {
            let mut state = player_command_state();
            let before = state.canonical_sha256().unwrap();
            assert!(state.apply_player_authority_command(&command).is_err());
            assert_eq!(state.revision, revision);
            assert_eq!(state.canonical_sha256().unwrap(), before);
        }

        for (field, value) in [
            ("interactionLocked", Value::from(true)),
            ("planetId", Value::from("ashen")),
            ("kind", Value::from("power")),
            ("buildingId", Value::from("arc_smelter")),
        ] {
            let mut state = player_command_state();
            let mutation = entity_leaf_command(state.revision, "ejector-a", field, value);
            state.apply_command(&mutation).unwrap();
            let command = ejector_target_command(state.revision, &["ejector-a"], "orbit-home-new");
            let before = state.canonical_sha256().unwrap();
            assert!(
                state.apply_player_authority_command(&command).is_err(),
                "{field}"
            );
            assert_eq!(state.canonical_sha256().unwrap(), before, "{field}");
        }

        let mut modded = player_command_state_for_registry("modded-ejector-target");
        let command = ejector_target_command(modded.revision, &["ejector-a"], "orbit-home-new");
        let before = modded.canonical_sha256().unwrap();
        assert!(modded.apply_player_authority_command(&command).is_err());
        assert_eq!(modded.canonical_sha256().unwrap(), before);

        for active_planet_id in ["ashen", "missing"] {
            let mut state = player_command_state();
            state
                .apply_command(&top_level_leaf_command(
                    state.revision,
                    &["activePlanetId"],
                    Value::from(active_planet_id),
                ))
                .unwrap();
            let command = ejector_target_command(state.revision, &["ejector-a"], "orbit-home-new");
            let before = state.canonical_sha256().unwrap();
            assert!(state.apply_player_authority_command(&command).is_err());
            assert_eq!(state.canonical_sha256().unwrap(), before);
        }
    }

    #[test]
    fn player_authority_applies_only_known_canonical_quantum_capacity_leaf() {
        let mut state = player_quantum_capacity_state();
        let command = quantum_capacity_command(state.revision, "iron_ore", Value::from("1000000"));
        let result = state.apply_player_authority_command(&command).unwrap();
        assert_eq!(result.previous_revision, 9);
        assert_eq!(result.revision, 10);
        // Capacity changes alter quantum scheduling horizons. Keep the
        // renderer receipt dirty so every consumer reloads the authoritative
        // projection instead of predicting the new derived logistics state.
        assert!(result.topology_dirty);
        assert_eq!(
            state.base_value()["quantumLogisticsNetwork"]["itemCapacities"]["iron_ore"],
            "1000000"
        );

        let mut defaulted = player_quantum_capacity_state();
        defaulted.base_value_mut()["quantumLogisticsNetwork"]["itemCapacities"]
            .as_object_mut()
            .unwrap()
            .remove("iron_ore");
        let command = quantum_capacity_command(
            defaulted.revision,
            "iron_ore",
            Value::from(PLAYER_QUANTUM_CAPACITY_MIN),
        );
        defaulted.apply_player_authority_command(&command).unwrap();
        assert_eq!(
            defaulted.base_value()["quantumLogisticsNetwork"]["itemCapacities"]["iron_ore"],
            PLAYER_QUANTUM_CAPACITY_MIN
        );
    }

    #[test]
    fn player_authority_quantum_capacity_rejects_stale_unknown_mixed_or_malformed_atomically() {
        let base = player_quantum_capacity_state();
        let revision = base.revision;
        let stale = quantum_capacity_command(revision - 1, "iron_ore", Value::from("1000000"));
        let unchanged = quantum_capacity_command(revision, "iron_ore", Value::from("100000"));
        let unknown =
            quantum_capacity_command(revision, "missing_mod_item", Value::from("1000000"));
        let mut deleted = quantum_capacity_command(revision, "iron_ore", Value::from("1000000"));
        deleted.top_level_changes[0].operation = "delete".to_owned();
        deleted.top_level_changes[0].value = None;
        let mut whole_object =
            quantum_capacity_command(revision, "iron_ore", Value::from("1000000"));
        whole_object.top_level_changes[0].path.pop();
        let mut mixed = quantum_capacity_command(revision, "iron_ore", Value::from("1000000"));
        mixed.top_level_changes.push(ValuePatch {
            path: vec![PathSegment::Key("paused".to_owned())],
            operation: "set".to_owned(),
            value: Some(Value::from(false)),
        });
        let mut mixed_entity =
            quantum_capacity_command(revision, "iron_ore", Value::from("1000000"));
        mixed_entity.changed_entities.push(RecordPatch {
            id: "smelter-a".to_owned(),
            changes: vec![ValuePatch {
                path: vec![PathSegment::Key("progress".to_owned())],
                operation: "set".to_owned(),
                value: Some(Value::from(0)),
            }],
        });
        let commands = [
            stale,
            unchanged,
            unknown,
            deleted,
            whole_object,
            mixed,
            mixed_entity,
            quantum_capacity_command(revision, "iron_ore", Value::from("010000")),
            quantum_capacity_command(revision, "iron_ore", Value::from("9999")),
            quantum_capacity_command(revision, "iron_ore", Value::from("10000000001")),
            quantum_capacity_command(revision, "iron_ore", Value::from("-1")),
            quantum_capacity_command(revision, "iron_ore", Value::from("1e6")),
            quantum_capacity_command(revision, "iron_ore", Value::from(1_000_000)),
            quantum_capacity_command(revision, "iron_ore", Value::Null),
        ];
        for command in commands {
            let mut state = player_quantum_capacity_state();
            let before = state.canonical_sha256().unwrap();
            assert!(state.apply_player_authority_command(&command).is_err());
            assert_eq!(state.revision, revision);
            assert_eq!(state.canonical_sha256().unwrap(), before);
        }

        let mut malformed_current = player_quantum_capacity_state();
        malformed_current.base_value_mut()["quantumLogisticsNetwork"]["itemCapacities"]["iron_ore"] =
            Value::from(100_000);
        let before = malformed_current.canonical_sha256().unwrap();
        let command = quantum_capacity_command(
            malformed_current.revision,
            "iron_ore",
            Value::from("1000000"),
        );
        assert!(
            malformed_current
                .apply_player_authority_command(&command)
                .is_err()
        );
        assert_eq!(malformed_current.canonical_sha256().unwrap(), before);
    }

    fn player_black_hole_state_for_registry(registry_fingerprint: &str) -> CoreState {
        let seed = player_command_state_for_registry(registry_fingerprint);
        let mut catalog_value = serde_json::to_value(
            player_command_catalog_for_registry(registry_fingerprint).snapshot,
        )
        .unwrap();
        catalog_value["buildings"]
            .as_array_mut()
            .unwrap()
            .push(serde_json::json!({
                "id": "micro_black_hole_connector",
                "kind": "machine",
                "speed": 1,
                "inputCapacity": 0,
                "outputCapacity": 0
            }));
        let snapshot: CatalogSnapshot = serde_json::from_value(catalog_value).unwrap();
        let catalog = RuntimeCatalog::validate(snapshot, registry_fingerprint).unwrap();
        CoreState::from_public_v47_parts(
            CoreCheckpointIdentity {
                slot: "normal-main".to_owned(),
                generation: 1,
                root_hash: "b".repeat(64),
                revision: 9,
                state_version: 47,
                mode: "normal".to_owned(),
                registry_fingerprint: registry_fingerprint.to_owned(),
                base_primary_checksum: "12345678".to_owned(),
            },
            seed.base_value().clone(),
            vec![serde_json::json!({
                "id": "black-hole-a",
                "kind": "machine",
                "planetId": "home",
                "position": { "x": 7, "y": 8 },
                "interactionLocked": false,
                "buildingId": "micro_black_hole_connector",
                "machineCount": 1,
                "minerCount": 0,
                "inputs": {},
                "outputs": {},
                "progress": 0,
                "routingCursor": 0,
                "utilization": 0,
                "productionRate": 0,
                "blackHolePaused": true,
                "blackHoleActivationConfirmed": false,
                "blackHolePorts": [
                    { "index": 0, "currentItemId": "iron_ore", "totalDestroyed": "12345678901234567890" },
                    { "index": 1, "totalDestroyed": "7" },
                    { "index": 2, "totalDestroyed": "0" }
                ],
                "modPayload": { "mustSurvive": true }
            })
            .to_string()],
            Vec::new(),
            catalog,
        )
        .unwrap()
    }

    fn black_hole_pause_intent_command(
        base_revision: u64,
        paused: bool,
        confirm_activation: bool,
    ) -> SimulationCommandPatch {
        let mut command = empty_player_command(base_revision);
        command.changed_entities = vec![RecordPatch {
            id: "black-hole-a".to_owned(),
            changes: vec![ValuePatch {
                path: vec![
                    PathSegment::Key("blackHolePaused".to_owned()),
                    PathSegment::Key("intent".to_owned()),
                ],
                operation: "set".to_owned(),
                value: Some(serde_json::json!({
                    "paused": paused,
                    "confirmActivation": confirm_activation
                })),
            }],
        }];
        command
    }

    #[test]
    fn player_authority_black_hole_first_activation_pause_and_resume_match_javascript() {
        let mut state =
            player_black_hole_state_for_registry(EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT);
        let before = state.parse_entity(0).unwrap();
        let ports = before["blackHolePorts"].clone();
        let destroyed = before["blackHolePorts"][0]["totalDestroyed"].clone();
        let mod_payload = before["modPayload"].clone();

        let activated = state
            .apply_player_authority_command(&black_hole_pause_intent_command(9, false, true))
            .unwrap();
        assert_eq!(activated.previous_revision, 9);
        assert_eq!(activated.revision, 10);
        assert_eq!(activated.changed_entity_ids, ["black-hole-a"]);
        assert!(!activated.topology_dirty);
        let entity = state.parse_entity(0).unwrap();
        assert_eq!(entity["blackHolePaused"], false);
        assert_eq!(entity["blackHoleActivationConfirmed"], true);
        assert_eq!(entity["blackHolePorts"], ports);
        assert_eq!(entity["blackHolePorts"][0]["totalDestroyed"], destroyed);
        assert_eq!(entity["modPayload"], mod_payload);

        state
            .apply_player_authority_command(&black_hole_pause_intent_command(10, true, false))
            .unwrap();
        state
            .apply_player_authority_command(&black_hole_pause_intent_command(11, false, false))
            .unwrap();
        let resumed = state.parse_entity(0).unwrap();
        assert_eq!(resumed["blackHolePaused"], false);
        assert_eq!(resumed["blackHoleActivationConfirmed"], true);
        assert_eq!(resumed["blackHolePorts"], ports);
    }

    #[test]
    fn player_authority_black_hole_confirmation_only_edge_matches_javascript() {
        let mut state =
            player_black_hole_state_for_registry(EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT);
        state
            .apply_command(&entity_leaf_command(
                9,
                "black-hole-a",
                "blackHolePaused",
                Value::from(false),
            ))
            .unwrap();
        let receipt = state
            .apply_player_authority_command(&black_hole_pause_intent_command(10, false, true))
            .unwrap();
        assert_eq!(receipt.changed_entity_ids, ["black-hole-a"]);
        let entity = state.parse_entity(0).unwrap();
        assert_eq!(entity["blackHolePaused"], false);
        assert_eq!(entity["blackHoleActivationConfirmed"], true);
        assert_eq!(
            entity["blackHolePorts"][0]["totalDestroyed"],
            "12345678901234567890"
        );
    }

    #[test]
    fn player_authority_black_hole_intent_is_atomic_and_fails_closed() {
        let commands = [
            black_hole_pause_intent_command(8, false, true),
            black_hole_pause_intent_command(9, false, false),
            black_hole_pause_intent_command(9, true, false),
        ];
        for command in commands {
            let mut state =
                player_black_hole_state_for_registry(EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT);
            let before = state.canonical_sha256().unwrap();
            assert!(state.apply_player_authority_command(&command).is_err());
            assert_eq!(state.revision, 9);
            assert_eq!(state.canonical_sha256().unwrap(), before);
        }

        let mut foreign_registry = player_black_hole_state_for_registry("pack:test");
        let before = foreign_registry.canonical_sha256().unwrap();
        assert!(
            foreign_registry
                .apply_player_authority_command(&black_hole_pause_intent_command(9, false, true))
                .is_err()
        );
        assert_eq!(foreign_registry.canonical_sha256().unwrap(), before);

        for (field, value) in [
            ("interactionLocked", Value::from(true)),
            ("planetId", Value::from("ashen")),
            ("buildingId", Value::from("arc_smelter")),
        ] {
            let mut state =
                player_black_hole_state_for_registry(EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT);
            state
                .apply_command(&entity_leaf_command(9, "black-hole-a", field, value))
                .unwrap();
            let before = state.canonical_sha256().unwrap();
            assert!(
                state
                    .apply_player_authority_command(&black_hole_pause_intent_command(
                        10, false, true,
                    ))
                    .is_err()
            );
            assert_eq!(state.canonical_sha256().unwrap(), before);
        }
    }

    #[test]
    fn player_authority_black_hole_intent_replays_identically_through_generic_wal_apply() {
        let command = black_hole_pause_intent_command(9, false, true);
        let durable = serde_json::to_string(&command).unwrap();
        assert!(!durable.contains("blackHolePorts"));
        assert!(!durable.contains("totalDestroyed"));
        assert!(!durable.contains("blackHoleActivationConfirmed"));
        let replayed: SimulationCommandPatch = serde_json::from_str(&durable).unwrap();
        let mut live =
            player_black_hole_state_for_registry(EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT);
        let mut replay = live.clone();
        let live_receipt = live.apply_player_authority_command(&command).unwrap();
        let replay_receipt = replay.apply_command(&replayed).unwrap();
        assert_eq!(live_receipt, replay_receipt);
        assert_eq!(
            live.canonical_sha256().unwrap(),
            replay.canonical_sha256().unwrap()
        );
        assert_eq!(
            replay.parse_entity(0).unwrap()["blackHolePorts"][0]["totalDestroyed"],
            "12345678901234567890"
        );
    }

    #[test]
    fn player_authority_black_hole_rejects_forged_or_mixed_intent_atomically() {
        let mut extra_field = black_hole_pause_intent_command(9, false, true);
        extra_field.changed_entities[0].changes[0].value = Some(serde_json::json!({
            "paused": false,
            "confirmActivation": true,
            "blackHolePorts": []
        }));
        let mut direct_leaf = black_hole_pause_intent_command(9, false, true);
        direct_leaf.changed_entities[0].changes[0].path =
            vec![PathSegment::Key("blackHolePaused".to_owned())];
        direct_leaf.changed_entities[0].changes[0].value = Some(Value::from(false));
        let mut direct_confirmation = black_hole_pause_intent_command(9, false, true);
        direct_confirmation.changed_entities[0].changes[0].path =
            vec![PathSegment::Key("blackHoleActivationConfirmed".to_owned())];
        direct_confirmation.changed_entities[0].changes[0].value = Some(Value::from(true));
        let mut mixed = black_hole_pause_intent_command(9, false, true);
        mixed.changed_entities[0].changes.push(ValuePatch {
            path: vec![PathSegment::Key("blackHoleActivationConfirmed".to_owned())],
            operation: "set".to_owned(),
            value: Some(Value::from(true)),
        });
        let mut wrong_type = black_hole_pause_intent_command(9, false, true);
        wrong_type.changed_entities[0].changes[0].value = Some(serde_json::json!({
            "paused": false,
            "confirmActivation": 1
        }));
        for command in [
            extra_field,
            direct_leaf,
            direct_confirmation,
            mixed,
            wrong_type,
        ] {
            let mut state =
                player_black_hole_state_for_registry(EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT);
            let before = state.canonical_sha256().unwrap();
            assert!(state.apply_player_authority_command(&command).is_err());
            assert_eq!(state.revision, 9);
            assert_eq!(state.canonical_sha256().unwrap(), before);
        }
    }

    fn blueprint_rename_state() -> CoreState {
        let mut state = player_command_state();
        state.base_value_mut().insert(
            "blueprints".to_owned(),
            serde_json::json!([
                {
                    "id": "mod:opaque/rocket",
                    "name": "旧模组蓝图",
                    "entities": (0..513).map(|index| serde_json::json!({
                        "key": format!("mod-entity-{index}"),
                        "buildingId": "mod:unknown-building",
                        "opaqueEntityPayload": { "owner": "future-mod", "index": index }
                    })).collect::<Vec<_>>(),
                    "belts": [{
                        "key": "mod-belt-a",
                        "sourceKey": "mod-entity-0",
                        "targetKey": "mod-entity-1",
                        "itemId": "mod:unknown-item",
                        "opaqueBeltPayload": [1, 2, 3]
                    }],
                    "opaqueDefinitionPayload": {
                        "owner": "future-mod",
                        "nested": { "keep": true }
                    }
                },
                {
                    "id": "builtin-second",
                    "name": "第二张蓝图",
                    "revision": 7,
                    "rotation": 90,
                    "mirror": "horizontal",
                    "entities": [],
                    "belts": [],
                    "resourceAnchors": [],
                    "externalPorts": [],
                    "futureBuiltinPayload": "keep-byte-for-byte"
                }
            ]),
        );
        state.base_value_mut().insert(
            "blueprintVersions".to_owned(),
            serde_json::json!([{
                "id": "version-mod-1",
                "blueprintId": "mod:opaque/rocket",
                "revision": 1,
                "createdAt": 123,
                "definition": {
                    "id": "mod:opaque/rocket",
                    "name": "历史快照名",
                    "entities": [{ "key": "historic", "buildingId": "mod:historic" }],
                    "belts": [],
                    "opaqueVersionPayload": { "doNotRewrite": true }
                }
            }]),
        );
        state.base_value_mut().insert(
            "constructionQueue".to_owned(),
            serde_json::json!([{
                "id": "queue-mod-1",
                "blueprintId": "mod:opaque/rocket",
                "blueprintVersionId": "version-mod-1",
                "blueprintRevision": 1,
                "blueprintName": "排队时快照名",
                "opaqueQueuePayload": { "doNotRewrite": ["a", "b"] }
            }]),
        );
        state
    }

    fn blueprint_rename_intent_command(
        revision: u64,
        id: &str,
        name: &str,
    ) -> SimulationCommandPatch {
        let mut command = empty_player_command(revision);
        command.top_level_changes = vec![ValuePatch {
            path: vec![
                PathSegment::Key("blueprints".to_owned()),
                PathSegment::Key("intent".to_owned()),
            ],
            operation: "set".to_owned(),
            value: Some(serde_json::json!({
                "kind": "rename",
                "id": id,
                "name": name
            })),
        }];
        command
    }

    fn blueprint_transform_intent_command(
        revision: u64,
        id: &str,
        rotation: u64,
        mirror: &str,
    ) -> SimulationCommandPatch {
        let mut command = empty_player_command(revision);
        command.top_level_changes = vec![ValuePatch {
            path: vec![
                PathSegment::Key("blueprints".to_owned()),
                PathSegment::Key("intent".to_owned()),
            ],
            operation: "set".to_owned(),
            value: Some(serde_json::json!({
                "kind": "transform",
                "id": id,
                "rotation": rotation,
                "mirror": mirror
            })),
        }];
        command
    }

    fn blueprint_delete_intent_command(
        revision: u64,
        id: &str,
        blueprint_revision: u64,
    ) -> SimulationCommandPatch {
        let mut command = empty_player_command(revision);
        command.top_level_changes = vec![ValuePatch {
            path: vec![
                PathSegment::Key("blueprints".to_owned()),
                PathSegment::Key("intent".to_owned()),
            ],
            operation: "set".to_owned(),
            value: Some(serde_json::json!({
                "kind": "delete",
                "id": id,
                "revision": blueprint_revision
            })),
        }];
        command
    }

    #[test]
    fn player_authority_blueprint_rename_is_minimal_atomic_and_preserves_opaque_state() {
        let mut state = blueprint_rename_state();
        let command = blueprint_rename_intent_command(9, "mod:opaque/rocket", "新模组蓝图🚀");
        let encoded = serde_json::to_string(&command).unwrap();
        assert!(encoded.contains("\"kind\":\"rename\""));
        assert!(!encoded.contains("entities"));
        assert!(!encoded.contains("belts"));
        assert!(!encoded.contains("blueprintVersions"));
        assert!(!encoded.contains("constructionQueue"));

        let before = state.base_value().clone();
        let versions_before = serde_json::to_vec(&before["blueprintVersions"]).unwrap();
        let queue_before = serde_json::to_vec(&before["constructionQueue"]).unwrap();
        let entity_before = state.parse_entity(0).unwrap();
        let belt_before = state.parse_belt(0).unwrap();
        let next_id_before = before["nextId"].clone();
        let receipt = state.apply_player_authority_command(&command).unwrap();

        assert_eq!(receipt.previous_revision, 9);
        assert_eq!(receipt.revision, 10);
        assert!(receipt.changed_entity_ids.is_empty());
        assert!(receipt.changed_belt_ids.is_empty());
        assert!(receipt.topology_dirty);
        let target = &state.base_value()["blueprints"][0];
        assert_eq!(target["name"], "新模组蓝图🚀");
        assert_eq!(target["revision"], 2);
        assert_eq!(
            target["opaqueDefinitionPayload"],
            before["blueprints"][0]["opaqueDefinitionPayload"]
        );
        assert_eq!(target["entities"], before["blueprints"][0]["entities"]);
        assert_eq!(target["belts"], before["blueprints"][0]["belts"]);
        assert_eq!(state.base_value()["blueprints"][1], before["blueprints"][1]);
        assert_eq!(
            serde_json::to_vec(&state.base_value()["blueprintVersions"]).unwrap(),
            versions_before
        );
        assert_eq!(
            serde_json::to_vec(&state.base_value()["constructionQueue"]).unwrap(),
            queue_before
        );
        assert_eq!(state.base_value()["nextId"], next_id_before);
        assert_eq!(state.parse_entity(0).unwrap(), entity_before);
        assert_eq!(state.parse_belt(0).unwrap(), belt_before);
    }

    #[test]
    fn player_authority_blueprint_rename_replays_identically_from_semantic_wal_marker() {
        let command = blueprint_rename_intent_command(9, "builtin-second", "稳定重放名");
        let durable = serde_json::to_string(&command).unwrap();
        let replayed: SimulationCommandPatch = serde_json::from_str(&durable).unwrap();
        let mut live = blueprint_rename_state();
        let mut replay = live.clone();
        let live_receipt = live.apply_player_authority_command(&command).unwrap();
        let replay_receipt = replay.apply_command(&replayed).unwrap();
        assert_eq!(live_receipt, replay_receipt);
        assert!(live_receipt.topology_dirty);
        assert_eq!(
            live.canonical_sha256().unwrap(),
            replay.canonical_sha256().unwrap()
        );
        assert_eq!(replay.base_value()["blueprints"][1]["name"], "稳定重放名");
        assert_eq!(replay.base_value()["blueprints"][1]["revision"], 8);
    }

    #[test]
    fn player_authority_blueprint_rename_fails_closed_for_every_forged_boundary() {
        let mut cases = Vec::new();
        let mut extra = blueprint_rename_intent_command(9, "builtin-second", "新名字");
        extra.top_level_changes[0].value.as_mut().unwrap()["entities"] = serde_json::json!([]);
        cases.push(extra);
        let mut direct = blueprint_rename_intent_command(9, "builtin-second", "新名字");
        direct.top_level_changes[0].path = vec![
            PathSegment::Key("blueprints".to_owned()),
            PathSegment::Index(1),
            PathSegment::Key("name".to_owned()),
        ];
        cases.push(direct);
        let mut mixed = blueprint_rename_intent_command(9, "builtin-second", "新名字");
        mixed.changed_entities.push(RecordPatch {
            id: "smelter-a".to_owned(),
            changes: vec![ValuePatch {
                path: vec![PathSegment::Key("machineCount".to_owned())],
                operation: "set".to_owned(),
                value: Some(Value::from(2)),
            }],
        });
        cases.push(mixed);
        for (id, name) in [
            ("missing", "新名字"),
            ("builtin-second", "第二张蓝图"),
            ("builtin-second", " 前导空格"),
            ("builtin-second", "尾随空格\u{feff}"),
            ("builtin-second", "控制\u{0001}字符"),
            ("builtin-second", ""),
            ("builtin-second", "1234567890123456789012345678901🚀"),
        ] {
            cases.push(blueprint_rename_intent_command(9, id, name));
        }
        for command in cases {
            let mut state = blueprint_rename_state();
            let before = state.canonical_sha256().unwrap();
            let revision = state.revision;
            assert!(state.apply_player_authority_command(&command).is_err());
            assert_eq!(state.revision, revision);
            assert_eq!(state.canonical_sha256().unwrap(), before);
        }

        for mutate in ["duplicate-id", "hidden-bad-row", "source-limit", "overflow"] {
            let mut state = blueprint_rename_state();
            match mutate {
                "duplicate-id" => {
                    state.base_value_mut()["blueprints"][1]["id"] =
                        Value::from("mod:opaque/rocket");
                }
                "hidden-bad-row" => {
                    state.base_value_mut()["blueprints"].as_array_mut().unwrap().push(
                        serde_json::json!({ "id": "hidden\u{0001}", "name": "坏行", "entities": [], "belts": [] }),
                    );
                }
                "source-limit" => {
                    state.base_value_mut()["blueprints"] = Value::Array(
                        (0..4_097)
                            .map(|index| {
                                serde_json::json!({
                                    "id": format!("blueprint-{index}"),
                                    "name": format!("蓝图{index}"),
                                    "entities": [],
                                    "belts": []
                                })
                            })
                            .collect(),
                    );
                }
                "overflow" => {
                    state.base_value_mut()["blueprints"][1]["revision"] =
                        Value::from(MAX_JAVASCRIPT_SAFE_INTEGER);
                }
                _ => unreachable!(),
            }
            let before = state.canonical_sha256().unwrap();
            assert!(
                state
                    .apply_player_authority_command(&blueprint_rename_intent_command(
                        9,
                        if mutate == "source-limit" {
                            "blueprint-0"
                        } else {
                            "builtin-second"
                        },
                        "新名字",
                    ))
                    .is_err()
            );
            assert_eq!(state.revision, 9);
            assert_eq!(state.canonical_sha256().unwrap(), before);
        }
    }

    #[test]
    fn player_authority_blueprint_rename_accepts_exact_utf16_emoji_boundary() {
        for name in [format!("{}🚀", "a".repeat(30)), "🚀".repeat(16)] {
            let mut state = blueprint_rename_state();
            state
                .apply_player_authority_command(&blueprint_rename_intent_command(
                    9,
                    "builtin-second",
                    &name,
                ))
                .unwrap();
            assert_eq!(state.base_value()["blueprints"][1]["name"], name);
        }
    }

    #[test]
    fn player_authority_blueprint_transform_is_target_state_atomic_and_preserves_opaque_state() {
        let mut state = blueprint_rename_state();
        let command = blueprint_transform_intent_command(9, "mod:opaque/rocket", 270, "horizontal");
        let encoded = serde_json::to_string(&command).unwrap();
        assert!(encoded.contains("\"kind\":\"transform\""));
        assert!(!encoded.contains("entities"));
        assert!(!encoded.contains("belts"));
        assert!(!encoded.contains("blueprintVersions"));
        assert!(!encoded.contains("constructionQueue"));

        let before = state.base_value().clone();
        let entity_before = state.parse_entity(0).unwrap();
        let belt_before = state.parse_belt(0).unwrap();
        let receipt = state.apply_player_authority_command(&command).unwrap();
        assert_eq!(receipt.previous_revision, 9);
        assert_eq!(receipt.revision, 10);
        assert!(receipt.changed_entity_ids.is_empty());
        assert!(receipt.changed_belt_ids.is_empty());
        assert!(receipt.topology_dirty);
        let target = &state.base_value()["blueprints"][0];
        assert_eq!(target["rotation"], 270);
        assert_eq!(target["mirror"], "horizontal");
        // A legacy missing/null row revision is interpreted as one.
        assert_eq!(target["revision"], 2);
        assert_eq!(target["name"], before["blueprints"][0]["name"]);
        assert_eq!(target["entities"], before["blueprints"][0]["entities"]);
        assert_eq!(target["belts"], before["blueprints"][0]["belts"]);
        assert_eq!(
            target["opaqueDefinitionPayload"],
            before["blueprints"][0]["opaqueDefinitionPayload"]
        );
        assert_eq!(state.base_value()["blueprints"][1], before["blueprints"][1]);
        assert_eq!(
            state.base_value()["blueprintVersions"],
            before["blueprintVersions"]
        );
        assert_eq!(
            state.base_value()["constructionQueue"],
            before["constructionQueue"]
        );
        assert_eq!(state.parse_entity(0).unwrap(), entity_before);
        assert_eq!(state.parse_belt(0).unwrap(), belt_before);
        assert_eq!(state.base_value()["nextId"], before["nextId"]);
        let mut expected_base = before.clone();
        expected_base["blueprints"][0]["rotation"] = Value::from(270);
        expected_base["blueprints"][0]["mirror"] = Value::from("horizontal");
        expected_base["blueprints"][0]["revision"] = Value::from(2);
        assert_eq!(state.base_value(), &expected_base);

        let mut null_legacy = blueprint_rename_state();
        null_legacy.base_value_mut()["blueprints"][0]["rotation"] = Value::Null;
        null_legacy.base_value_mut()["blueprints"][0]["mirror"] = Value::Null;
        null_legacy.base_value_mut()["blueprints"][0]["revision"] = Value::Null;
        null_legacy
            .apply_player_authority_command(&blueprint_transform_intent_command(
                9,
                "mod:opaque/rocket",
                90,
                "none",
            ))
            .unwrap();
        assert_eq!(null_legacy.base_value()["blueprints"][0]["rotation"], 90);
        assert_eq!(null_legacy.base_value()["blueprints"][0]["mirror"], "none");
        assert_eq!(null_legacy.base_value()["blueprints"][0]["revision"], 2);
    }

    #[test]
    fn player_authority_blueprint_transform_replays_identically_from_semantic_wal_marker() {
        let command = blueprint_transform_intent_command(9, "builtin-second", 180, "none");
        let durable = serde_json::to_string(&command).unwrap();
        let replayed: SimulationCommandPatch = serde_json::from_str(&durable).unwrap();
        let mut live = blueprint_rename_state();
        let mut replay = live.clone();
        let live_receipt = live.apply_player_authority_command(&command).unwrap();
        let replay_receipt = replay.apply_command(&replayed).unwrap();
        assert_eq!(live_receipt, replay_receipt);
        assert!(live_receipt.topology_dirty);
        assert_eq!(
            live.canonical_sha256().unwrap(),
            replay.canonical_sha256().unwrap()
        );
        assert_eq!(replay.base_value()["blueprints"][1]["rotation"], 180);
        assert_eq!(replay.base_value()["blueprints"][1]["mirror"], "none");
        assert_eq!(replay.base_value()["blueprints"][1]["revision"], 8);
    }

    #[test]
    fn player_authority_blueprint_transform_fails_closed_at_exact_marker_and_directory_boundaries()
    {
        let mut cases = vec![
            blueprint_transform_intent_command(9, "missing", 180, "none"),
            // Effective legacy defaults are 0 / none, so this is a no-op.
            blueprint_transform_intent_command(9, "mod:opaque/rocket", 0, "none"),
            blueprint_transform_intent_command(9, "builtin-second", 45, "none"),
            blueprint_transform_intent_command(9, "builtin-second", 180, "vertical"),
        ];
        let mut missing_rotation =
            blueprint_transform_intent_command(9, "builtin-second", 180, "horizontal");
        missing_rotation.top_level_changes[0]
            .value
            .as_mut()
            .unwrap()
            .as_object_mut()
            .unwrap()
            .remove("rotation");
        cases.push(missing_rotation);
        let mut missing_mirror =
            blueprint_transform_intent_command(9, "builtin-second", 180, "horizontal");
        missing_mirror.top_level_changes[0]
            .value
            .as_mut()
            .unwrap()
            .as_object_mut()
            .unwrap()
            .remove("mirror");
        cases.push(missing_mirror);
        let mut extra = blueprint_transform_intent_command(9, "builtin-second", 180, "horizontal");
        extra.top_level_changes[0].value.as_mut().unwrap()["name"] = Value::from("forged");
        cases.push(extra);
        let mut rename_with_transform_key =
            blueprint_rename_intent_command(9, "builtin-second", "严格改名");
        rename_with_transform_key.top_level_changes[0]
            .value
            .as_mut()
            .unwrap()["rotation"] = Value::from(90);
        cases.push(rename_with_transform_key);

        for command in cases {
            let mut state = blueprint_rename_state();
            let before = state.canonical_sha256().unwrap();
            assert!(state.apply_player_authority_command(&command).is_err());
            assert_eq!(state.revision, 9);
            assert_eq!(state.canonical_sha256().unwrap(), before);
        }

        for mutate in ["duplicate-id", "hidden-bad-row", "overflow"] {
            let mut state = blueprint_rename_state();
            match mutate {
                "duplicate-id" => {
                    state.base_value_mut()["blueprints"][1]["id"] =
                        Value::from("mod:opaque/rocket");
                }
                "hidden-bad-row" => {
                    state.base_value_mut()["blueprints"]
                        .as_array_mut()
                        .unwrap()
                        .push(serde_json::json!({
                            "id": "hidden",
                            "name": "坏行",
                            "entities": "not-an-array",
                            "belts": []
                        }));
                }
                "overflow" => {
                    state.base_value_mut()["blueprints"][1]["revision"] =
                        Value::from(MAX_JAVASCRIPT_SAFE_INTEGER);
                }
                _ => unreachable!(),
            }
            let before = state.canonical_sha256().unwrap();
            assert!(
                state
                    .apply_player_authority_command(&blueprint_transform_intent_command(
                        9,
                        "builtin-second",
                        180,
                        "none",
                    ))
                    .is_err()
            );
            assert_eq!(state.revision, 9);
            assert_eq!(state.canonical_sha256().unwrap(), before);
        }
    }

    #[test]
    fn player_authority_blueprint_delete_is_atomic_and_preserves_queued_snapshot_state() {
        let mut state = blueprint_rename_state();
        state.base_value_mut()["blueprints"]
            .as_array_mut()
            .unwrap()
            .push(serde_json::json!({
                "id": "tail-blueprint",
                "name": "尾部蓝图",
                "revision": 3,
                "entities": [],
                "belts": [],
                "opaqueTailPayload": { "keep": [3, 2, 1] }
            }));
        let command = blueprint_delete_intent_command(9, "mod:opaque/rocket", 1);
        let encoded = serde_json::to_string(&command).unwrap();
        assert!(encoded.contains("\"kind\":\"delete\""));
        assert!(encoded.contains("\"revision\":1"));
        assert!(!encoded.contains("entities"));
        assert!(!encoded.contains("belts"));
        assert!(!encoded.contains("blueprintVersions"));
        assert!(!encoded.contains("constructionQueue"));

        let expansion = crate::blueprint_command::expand_intent(&state, &command).unwrap();
        assert_eq!(expansion.delete_index(), Some(0));
        assert!(expansion.command().top_level_changes.is_empty());
        assert!(expansion.command().changed_entities.is_empty());
        assert!(expansion.command().changed_belts.is_empty());

        let before = state.base_value().clone();
        let versions_before = serde_json::to_vec(&before["blueprintVersions"]).unwrap();
        let queue_before = serde_json::to_vec(&before["constructionQueue"]).unwrap();
        let entity_before = state.parse_entity(0).unwrap();
        let belt_before = state.parse_belt(0).unwrap();
        let receipt = state.apply_player_authority_command(&command).unwrap();

        assert_eq!(receipt.previous_revision, 9);
        assert_eq!(receipt.revision, 10);
        assert!(receipt.changed_entity_ids.is_empty());
        assert!(receipt.changed_belt_ids.is_empty());
        assert!(receipt.topology_dirty);
        assert_eq!(
            state.base_value()["blueprints"].as_array().unwrap().len(),
            2
        );
        assert_eq!(state.base_value()["blueprints"][0], before["blueprints"][1]);
        assert_eq!(state.base_value()["blueprints"][1], before["blueprints"][2]);
        assert_eq!(
            serde_json::to_vec(&state.base_value()["blueprintVersions"]).unwrap(),
            versions_before
        );
        assert_eq!(
            serde_json::to_vec(&state.base_value()["constructionQueue"]).unwrap(),
            queue_before
        );
        assert_eq!(state.base_value()["nextId"], before["nextId"]);
        assert_eq!(state.parse_entity(0).unwrap(), entity_before);
        assert_eq!(state.parse_belt(0).unwrap(), belt_before);
        let mut expected_base = before.clone();
        expected_base["blueprints"] = Value::Array(vec![
            before["blueprints"][1].clone(),
            before["blueprints"][2].clone(),
        ]);
        assert_eq!(state.base_value(), &expected_base);
    }

    #[test]
    fn player_authority_blueprint_delete_accepts_max_safe_target_revision() {
        let mut state = blueprint_rename_state();
        state.base_value_mut()["blueprints"][1]["revision"] =
            Value::from(MAX_JAVASCRIPT_SAFE_INTEGER);
        let before = state.base_value().clone();
        let receipt = state
            .apply_player_authority_command(&blueprint_delete_intent_command(
                9,
                "builtin-second",
                MAX_JAVASCRIPT_SAFE_INTEGER,
            ))
            .unwrap();
        assert_eq!(receipt.revision, 10);
        assert_eq!(
            state.base_value()["blueprints"],
            Value::Array(vec![before["blueprints"][0].clone()])
        );
    }

    #[test]
    fn player_authority_blueprint_delete_replays_identically_from_semantic_wal_marker() {
        let command = blueprint_delete_intent_command(9, "mod:opaque/rocket", 1);
        let durable = serde_json::to_string(&command).unwrap();
        assert!(durable.contains("\"kind\":\"delete\""));
        assert!(!durable.contains("opaqueDefinitionPayload"));
        let replayed: SimulationCommandPatch = serde_json::from_str(&durable).unwrap();
        let mut live = blueprint_rename_state();
        let mut replay = live.clone();
        let live_receipt = live.apply_player_authority_command(&command).unwrap();
        let replay_receipt = replay.apply_command(&replayed).unwrap();
        assert_eq!(live_receipt, replay_receipt);
        assert!(live_receipt.changed_entity_ids.is_empty());
        assert!(live_receipt.changed_belt_ids.is_empty());
        assert!(live_receipt.topology_dirty);
        assert_eq!(
            live.canonical_sha256().unwrap(),
            replay.canonical_sha256().unwrap()
        );
        assert_eq!(
            replay.base_value()["blueprints"].as_array().unwrap().len(),
            1
        );
        assert_eq!(
            replay.base_value()["blueprintVersions"],
            blueprint_rename_state().base_value()["blueprintVersions"]
        );
        assert_eq!(
            replay.base_value()["constructionQueue"],
            blueprint_rename_state().base_value()["constructionQueue"]
        );
    }

    #[test]
    fn player_authority_blueprint_delete_fails_closed_at_marker_and_directory_boundaries() {
        let mut cases = vec![
            blueprint_delete_intent_command(9, "missing", 1),
            blueprint_delete_intent_command(9, "builtin-second", 6),
            blueprint_delete_intent_command(9, "builtin-second", 8),
            blueprint_delete_intent_command(9, "builtin-second", 0),
            blueprint_delete_intent_command(9, "builtin-second", MAX_JAVASCRIPT_SAFE_INTEGER + 1),
        ];
        let mut missing_revision = blueprint_delete_intent_command(9, "builtin-second", 7);
        missing_revision.top_level_changes[0]
            .value
            .as_mut()
            .unwrap()
            .as_object_mut()
            .unwrap()
            .remove("revision");
        cases.push(missing_revision);
        let mut extra = blueprint_delete_intent_command(9, "builtin-second", 7);
        extra.top_level_changes[0].value.as_mut().unwrap()["name"] = Value::from("forged");
        cases.push(extra);
        let mut rename_with_delete_revision =
            blueprint_rename_intent_command(9, "builtin-second", "严格改名");
        rename_with_delete_revision.top_level_changes[0]
            .value
            .as_mut()
            .unwrap()["revision"] = Value::from(7);
        cases.push(rename_with_delete_revision);

        for command in cases {
            let mut state = blueprint_rename_state();
            let before = state.canonical_sha256().unwrap();
            assert!(state.apply_player_authority_command(&command).is_err());
            assert_eq!(state.revision, 9);
            assert_eq!(state.canonical_sha256().unwrap(), before);
        }

        for mutate in ["duplicate-id", "hidden-bad-row", "source-limit"] {
            let mut state = blueprint_rename_state();
            match mutate {
                "duplicate-id" => {
                    state.base_value_mut()["blueprints"][1]["id"] =
                        Value::from("mod:opaque/rocket");
                }
                "hidden-bad-row" => {
                    state.base_value_mut()["blueprints"]
                        .as_array_mut()
                        .unwrap()
                        .push(serde_json::json!({
                            "id": "hidden",
                            "name": "坏行",
                            "entities": [],
                            "belts": "not-an-array"
                        }));
                }
                "source-limit" => {
                    state.base_value_mut()["blueprints"] = Value::Array(
                        (0..4_097)
                            .map(|index| {
                                serde_json::json!({
                                    "id": format!("blueprint-{index}"),
                                    "name": format!("蓝图{index}"),
                                    "revision": 1,
                                    "entities": [],
                                    "belts": []
                                })
                            })
                            .collect(),
                    );
                }
                _ => unreachable!(),
            }
            let before = state.canonical_sha256().unwrap();
            let target_id = if mutate == "source-limit" {
                "blueprint-0"
            } else {
                "mod:opaque/rocket"
            };
            assert!(
                state
                    .apply_player_authority_command(&blueprint_delete_intent_command(
                        9, target_id, 1,
                    ))
                    .is_err()
            );
            assert_eq!(state.revision, 9);
            assert_eq!(state.canonical_sha256().unwrap(), before);
        }

        let mut raw_array_delete = empty_player_command(9);
        raw_array_delete.top_level_changes = vec![ValuePatch {
            path: vec![
                PathSegment::Key("blueprints".to_owned()),
                PathSegment::Index(0),
            ],
            operation: "delete".to_owned(),
            value: None,
        }];
        let mut state = blueprint_rename_state();
        let before = state.canonical_sha256().unwrap();
        assert!(state.apply_command(&raw_array_delete).is_err());
        assert_eq!(state.revision, 9);
        assert_eq!(state.canonical_sha256().unwrap(), before);
    }
}
