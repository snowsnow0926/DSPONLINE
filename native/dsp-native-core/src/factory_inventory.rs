//! Revision-bound, bounded inventory read model and player command gate.
//!
//! The public v47 state remains the persisted source of truth. This module only
//! exposes a pageable thin-renderer projection and proves the bounded inventory
//! transitions that the native player-authority UI can currently originate.

use anyhow::{anyhow, bail};
use serde_json::{Map, Value, json};

use crate::{
    command::{PathSegment, SimulationCommandPatch, ValuePatch},
    state::CoreState,
};

const FACTORY_INVENTORY_PROJECTION: &str = "factory-inventory-v1";
const MAX_PROJECTION_BYTES: usize = 1_048_576;
const MAX_PAGE_ROWS: usize = 256;
const MAX_OPAQUE_ID_BYTES: usize = 512;
const MAX_JAVASCRIPT_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const PICKUP_TARGET_AMOUNT: u64 = 100;
const MIN_TRAY_ITEM_LIMIT: u64 = 1_000;
const DEFAULT_TRAY_ITEM_LIMIT: u64 = 1_000_000;
const MAX_TRAY_ITEM_LIMIT: u64 = 100_000_000;
const MIN_PRODUCTION_BUFFER_LIMIT: u64 = 1_000;
const DEFAULT_PRODUCTION_BUFFER_LIMIT: u64 = 1_000_000;
const MAX_PRODUCTION_BUFFER_LIMIT: u64 = 100_000_000;
const EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT: &str = "7df8cf3a";

/// Deliberately excludes storage, splitters, power/fuel buildings, stations,
/// construction megastructures and every opaque/MOD building. These are the
/// built-in recipe machines whose ordinary input semantics are fully described
/// by the v47 catalog without another domain ledger.
const BUILTIN_ORDINARY_RECIPE_BUILDINGS: &[&str] = &[
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
    "vertical_launching_silo",
];

const BUILTIN_MATRIX_ITEMS: &[&str] = &[
    "electromagnetic_matrix",
    "energy_matrix",
    "structure_matrix",
    "information_matrix",
    "gravity_matrix",
    "universe_matrix",
];

#[derive(Clone, Debug, PartialEq, Eq)]
struct HeldCargo {
    item_id: String,
    amount: u64,
    origin: Option<CargoOrigin>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct CargoOrigin {
    kind: String,
    id: Option<String>,
}

fn valid_opaque_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_OPAQUE_ID_BYTES
        && !value.contains('\0')
        && !value.chars().any(char::is_control)
}

fn known_item_id<'a>(state: &CoreState, value: &'a str) -> anyhow::Result<&'a str> {
    if !valid_opaque_id(value) || !state.catalog.items.contains_key(value) {
        bail!("native factory inventory item ID is invalid")
    }
    Ok(value)
}

fn safe_nonnegative_integer(value: Option<&Value>, label: &str) -> anyhow::Result<u64> {
    value
        .and_then(Value::as_u64)
        .filter(|value| *value <= MAX_JAVASCRIPT_SAFE_INTEGER)
        .ok_or_else(|| anyhow!("native factory inventory {label} is not a safe integer"))
}

fn optional_safe_nonnegative_integer(value: Option<&Value>, label: &str) -> anyhow::Result<u64> {
    match value {
        None | Some(Value::Null) => Ok(0),
        Some(value) => safe_nonnegative_integer(Some(value), label),
    }
}

fn active_planet_id<'a>(
    state: &CoreState,
    base: &'a Map<String, Value>,
) -> anyhow::Result<&'a str> {
    let planet_id = base
        .get("activePlanetId")
        .and_then(Value::as_str)
        .filter(|planet_id| valid_opaque_id(planet_id))
        .ok_or_else(|| anyhow!("native factory inventory active planet ID is invalid"))?;
    if !state
        .catalog
        .planets
        .iter()
        .any(|planet| planet.id == planet_id)
    {
        bail!("native factory inventory active planet is missing from the catalog")
    }
    Ok(planet_id)
}

fn active_tray(base: &Map<String, Value>) -> anyhow::Result<&Map<String, Value>> {
    base.get("tray")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("native factory inventory active tray is invalid"))
}

fn effective_tray_item_limit(
    base: &Map<String, Value>,
    active_planet_id: &str,
) -> anyhow::Result<u64> {
    let limits = base
        .get("planetTrayItemLimits")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("native factory inventory tray-limit directory is invalid"))?;
    let raw = match limits.get(active_planet_id) {
        None | Some(Value::Null) => return Ok(DEFAULT_TRAY_ITEM_LIMIT),
        Some(value) => safe_nonnegative_integer(Some(value), "active tray item limit")?,
    };
    Ok(raw.clamp(MIN_TRAY_ITEM_LIMIT, MAX_TRAY_ITEM_LIMIT))
}

fn effective_production_buffer_limit(base: &Map<String, Value>) -> u64 {
    base.get("settings")
        .and_then(Value::as_object)
        .and_then(|settings| settings.get("productionBufferLimit"))
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
        .map(|value| {
            value.floor().clamp(
                MIN_PRODUCTION_BUFFER_LIMIT as f64,
                MAX_PRODUCTION_BUFFER_LIMIT as f64,
            ) as u64
        })
        .unwrap_or(DEFAULT_PRODUCTION_BUFFER_LIMIT)
}

fn validate_cargo_origin(value: Option<&Value>) -> anyhow::Result<Option<CargoOrigin>> {
    let Some(value) = value else {
        return Ok(None);
    };
    if value.is_null() {
        return Ok(None);
    }
    let origin = value
        .as_object()
        .ok_or_else(|| anyhow!("native factory inventory cargo origin is invalid"))?;
    let kind = origin
        .get("kind")
        .and_then(Value::as_str)
        .filter(|kind| matches!(*kind, "node-output" | "node-input" | "tray"))
        .ok_or_else(|| anyhow!("native factory inventory cargo origin kind is invalid"))?
        .to_owned();
    let id = match origin.get("id") {
        None | Some(Value::Null) => None,
        Some(Value::String(id)) if valid_opaque_id(id) => Some(id.to_owned()),
        _ => bail!("native factory inventory cargo origin identity is invalid"),
    };
    Ok(Some(CargoOrigin { kind, id }))
}

fn held_cargo(state: &CoreState, base: &Map<String, Value>) -> anyhow::Result<Option<HeldCargo>> {
    let Some(value) = base.get("cargo") else {
        return Ok(None);
    };
    if value.is_null() {
        return Ok(None);
    }
    let cargo = value
        .as_object()
        .ok_or_else(|| anyhow!("native factory inventory cargo is invalid"))?;
    let item_id = cargo
        .get("itemId")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("native factory inventory cargo item ID is invalid"))?;
    known_item_id(state, item_id)?;
    let amount = safe_nonnegative_integer(cargo.get("amount"), "cargo amount")?;
    // Historical valid saves may carry a stack larger than the modern manual
    // pick limit. Keep it visible and returnable without truncation; the limit
    // only controls how much a new tray-take may add.
    if amount == 0 {
        bail!("native factory inventory cargo amount is empty")
    }
    let origin = validate_cargo_origin(cargo.get("origin"))?;
    Ok(Some(HeldCargo {
        item_id: item_id.to_owned(),
        amount,
        origin,
    }))
}

fn is_portable_fleet_item(item_id: &str) -> bool {
    matches!(item_id, "logistics_drone" | "logistics_vessel")
}

fn path_equals(path: &[PathSegment], expected: &[&str]) -> bool {
    path.len() == expected.len()
        && path.iter().zip(expected).all(
            |(segment, expected)| matches!(segment, PathSegment::Key(value) if value == expected),
        )
}

fn patches_have_only_top_level_changes(command: &SimulationCommandPatch) -> bool {
    command.changed_entities.is_empty()
        && command.added_entities.is_empty()
        && command.removed_entity_ids.is_empty()
        && command.changed_belts.is_empty()
        && command.added_belts.is_empty()
        && command.removed_belt_ids.is_empty()
}

fn inventory_root(path: &[PathSegment]) -> bool {
    matches!(
        path.first(),
        Some(PathSegment::Key(root))
            if matches!(
                root.as_str(),
                "cargo" | "tray" | "planetTrayItemLimits" | "portableFleet"
            )
    )
}

fn production_buffer_limit_path(path: &[PathSegment]) -> bool {
    path_equals(path, &["settings", "productionBufferLimit"])
}

fn factory_inventory_command_path(path: &[PathSegment]) -> bool {
    inventory_root(path) || production_buffer_limit_path(path)
}

pub(crate) fn command_touches_factory_inventory(command: &SimulationCommandPatch) -> bool {
    command
        .top_level_changes
        .iter()
        .any(|change| factory_inventory_command_path(&change.path))
}

fn exact_patch_sets_match(actual: &[ValuePatch], expected: &[ValuePatch]) -> anyhow::Result<()> {
    if actual.len() != expected.len() {
        bail!("native factory inventory patch set is incomplete or mixed")
    }
    let mut matched = vec![false; expected.len()];
    for actual_patch in actual {
        let Some(expected_index) =
            expected
                .iter()
                .enumerate()
                .find_map(|(index, expected_patch)| {
                    (!matched[index]
                        && actual_patch.path.len() == expected_patch.path.len()
                        && actual_patch.path.iter().zip(&expected_patch.path).all(
                            |(actual, expected)| match (actual, expected) {
                                (PathSegment::Key(actual), PathSegment::Key(expected)) => {
                                    actual == expected
                                }
                                (PathSegment::Index(actual), PathSegment::Index(expected)) => {
                                    actual == expected
                                }
                                _ => false,
                            },
                        ))
                    .then_some(index)
                })
        else {
            bail!("native factory inventory patch path is not canonical")
        };
        let expected_patch = &expected[expected_index];
        let equivalent_delete = expected_patch.operation == "delete"
            && actual_patch.operation == "delete"
            && actual_patch.value.as_ref().is_none_or(Value::is_null);
        let equivalent_set = expected_patch.operation == "set"
            && actual_patch.operation == "set"
            && actual_patch.value == expected_patch.value;
        if !equivalent_delete && !equivalent_set {
            bail!("native factory inventory patch value is not canonical")
        }
        matched[expected_index] = true;
    }
    if matched.iter().any(|matched| !matched) {
        bail!("native factory inventory patch set is incomplete")
    }
    Ok(())
}

fn validate_take_from_active_tray(
    state: &CoreState,
    command: &SimulationCommandPatch,
) -> anyhow::Result<()> {
    let base = state.base_value();
    active_planet_id(state, base)?;
    let tray = active_tray(base)?;
    let current_cargo = held_cargo(state, base)?;
    let mut target = None::<(&str, u64)>;
    for change in &command.top_level_changes {
        let [PathSegment::Key(root), PathSegment::Key(item_id)] = change.path.as_slice() else {
            continue;
        };
        if root != "tray" {
            continue;
        }
        if target.is_some() || change.operation != "set" {
            bail!("native factory inventory tray-take target is repeated or malformed")
        }
        let remaining = safe_nonnegative_integer(change.value.as_ref(), "tray-take remainder")?;
        target = Some((item_id, remaining));
    }
    let (item_id, target_remaining) =
        target.ok_or_else(|| anyhow!("native factory inventory tray-take target is missing"))?;
    known_item_id(state, item_id)?;
    let available = safe_nonnegative_integer(tray.get(item_id), "tray-take source amount")?;
    if available == 0 {
        bail!("native factory inventory tray-take source is empty")
    }
    let held_amount = match current_cargo.as_ref() {
        None => 0,
        Some(cargo) if cargo.item_id == item_id => cargo.amount,
        Some(_) => bail!("native factory inventory tray-take would mix held item types"),
    };
    let take = available.min(PICKUP_TARGET_AMOUNT.saturating_sub(held_amount));
    if take == 0 || target_remaining != available - take {
        bail!("native factory inventory tray-take amount is not canonical")
    }
    let next_held = held_amount
        .checked_add(take)
        .filter(|amount| *amount <= PICKUP_TARGET_AMOUNT)
        .ok_or_else(|| anyhow!("native factory inventory held stack overflows"))?;

    // Native authority always rebuilds the complete held stack. This gives
    // tray-take one bounded canonical shape, clears untrusted legacy cargo
    // extensions, and avoids recursively diffing the full GameState.
    let expected = vec![
        ValuePatch {
            path: vec![
                PathSegment::Key("tray".to_owned()),
                PathSegment::Key(item_id.to_owned()),
            ],
            operation: "set".to_owned(),
            value: Some(Value::from(target_remaining)),
        },
        ValuePatch {
            path: vec![PathSegment::Key("cargo".to_owned())],
            operation: "set".to_owned(),
            value: Some(json!({
                "itemId": item_id,
                "amount": next_held,
                "origin": { "kind": "tray" },
            })),
        },
    ];
    exact_patch_sets_match(&command.top_level_changes, &expected)
}

fn validate_return_held_cargo(
    state: &CoreState,
    command: &SimulationCommandPatch,
) -> anyhow::Result<()> {
    let base = state.base_value();
    active_planet_id(state, base)?;
    let cargo = held_cargo(state, base)?
        .ok_or_else(|| anyhow!("native factory inventory held-cargo return has no cargo"))?;
    let (inventory_root, current) = if is_portable_fleet_item(&cargo.item_id) {
        let portable = base
            .get("portableFleet")
            .and_then(Value::as_object)
            .ok_or_else(|| anyhow!("native factory inventory portable fleet is invalid"))?;
        (
            "portableFleet",
            optional_safe_nonnegative_integer(
                portable.get(&cargo.item_id),
                "portable fleet return target",
            )?,
        )
    } else {
        (
            "tray",
            optional_safe_nonnegative_integer(
                active_tray(base)?.get(&cargo.item_id),
                "held-cargo tray return target",
            )?,
        )
    };
    let next = current
        .checked_add(cargo.amount)
        .filter(|value| *value <= MAX_JAVASCRIPT_SAFE_INTEGER)
        .ok_or_else(|| anyhow!("native factory inventory held-cargo return overflows"))?;
    // Manual/protective returns intentionally ignore the configured tray
    // limit: the held cursor must never become trapped and no material may
    // vanish. Portable fleet items keep the existing JavaScript redirection.
    let expected = vec![
        ValuePatch {
            path: vec![
                PathSegment::Key(inventory_root.to_owned()),
                PathSegment::Key(cargo.item_id.clone()),
            ],
            operation: "set".to_owned(),
            value: Some(Value::from(next)),
        },
        ValuePatch {
            path: vec![PathSegment::Key("cargo".to_owned())],
            operation: "set".to_owned(),
            value: Some(Value::Null),
        },
    ];
    exact_patch_sets_match(&command.top_level_changes, &expected)
}

fn validate_active_tray_item_limit(
    state: &CoreState,
    command: &SimulationCommandPatch,
) -> anyhow::Result<()> {
    let base = state.base_value();
    let planet_id = active_planet_id(state, base)?;
    if command.top_level_changes.len() != 1 {
        bail!("native factory inventory tray-limit patch set is incomplete or mixed")
    }
    let change = &command.top_level_changes[0];
    if !path_equals(&change.path, &["planetTrayItemLimits", planet_id]) || change.operation != "set"
    {
        bail!("native factory inventory tray-limit path is not canonical")
    }
    let target = safe_nonnegative_integer(change.value.as_ref(), "tray-limit target")?;
    if !(MIN_TRAY_ITEM_LIMIT..=MAX_TRAY_ITEM_LIMIT).contains(&target) {
        bail!("native factory inventory tray-limit target is outside game bounds")
    }
    if effective_tray_item_limit(base, planet_id)? == target {
        bail!("native factory inventory tray-limit target is unchanged")
    }
    exact_patch_sets_match(
        &command.top_level_changes,
        &[ValuePatch {
            path: vec![
                PathSegment::Key("planetTrayItemLimits".to_owned()),
                PathSegment::Key(planet_id.to_owned()),
            ],
            operation: "set".to_owned(),
            value: Some(Value::from(target)),
        }],
    )
}

fn validate_production_buffer_limit(
    state: &CoreState,
    command: &SimulationCommandPatch,
) -> anyhow::Result<()> {
    if command.top_level_changes.len() != 1 || !patches_have_only_top_level_changes(command) {
        bail!("native factory inventory production-buffer patch set is incomplete or mixed")
    }
    let change = &command.top_level_changes[0];
    if !production_buffer_limit_path(&change.path) || change.operation != "set" {
        bail!("native factory inventory production-buffer path is not canonical")
    }
    let target = safe_nonnegative_integer(change.value.as_ref(), "production-buffer target")?;
    if !(MIN_PRODUCTION_BUFFER_LIMIT..=MAX_PRODUCTION_BUFFER_LIMIT).contains(&target) {
        bail!("native factory inventory production-buffer target is outside game bounds")
    }
    if effective_production_buffer_limit(state.base_value()) == target {
        bail!("native factory inventory production-buffer target is unchanged")
    }
    exact_patch_sets_match(
        &command.top_level_changes,
        &[ValuePatch {
            path: vec![
                PathSegment::Key("settings".to_owned()),
                PathSegment::Key("productionBufferLimit".to_owned()),
            ],
            operation: "set".to_owned(),
            value: Some(Value::from(target)),
        }],
    )
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum EntityInventorySourceField {
    Inputs,
    Outputs,
}

impl EntityInventorySourceField {
    fn key(self) -> &'static str {
        match self {
            Self::Inputs => "inputs",
            Self::Outputs => "outputs",
        }
    }

    fn cargo_origin_kind(self) -> &'static str {
        match self {
            Self::Inputs => "node-input",
            Self::Outputs => "node-output",
        }
    }
}

struct EntityInventorySource<'a> {
    entity_id: &'a str,
    item_id: &'a str,
    field: EntityInventorySourceField,
    available: u64,
}

#[derive(Debug)]
struct EntityInventoryTarget {
    item_id: String,
    current: u64,
    capacity: u64,
}

fn canonical_recipe_building_id(building_id: &str) -> Option<&str> {
    if !BUILTIN_ORDINARY_RECIPE_BUILDINGS.contains(&building_id) {
        return None;
    }
    Some(match building_id {
        "assembling_machine_mk2" | "assembling_machine_mk3" => "assembling_machine_mk1",
        "plane_smelter" => "arc_smelter",
        "quantum_chemical_plant" => "chemical_plant",
        other => other,
    })
}

fn recipe_accepts_ordinary_input(recipe: &crate::catalog::RecipeDefinition, item_id: &str) -> bool {
    recipe.inputs.iter().any(|input| input.item_id == item_id)
        || recipe.id == "matrix_research" && BUILTIN_MATRIX_ITEMS.contains(&item_id)
}

fn entity_inventory_target(
    state: &CoreState,
    command: &SimulationCommandPatch,
) -> anyhow::Result<Option<EntityInventoryTarget>> {
    let [record] = command.changed_entities.as_slice() else {
        return Ok(None);
    };
    let [change] = record.changes.as_slice() else {
        return Ok(None);
    };
    let [PathSegment::Key(field), PathSegment::Key(item_id)] = change.path.as_slice() else {
        return Ok(None);
    };
    if field != "inputs" || change.operation != "set" {
        return Ok(None);
    }
    let target = safe_nonnegative_integer(change.value.as_ref(), "entity input target")?;
    let entity_index = state
        .entity_index
        .get(&record.id)
        .copied()
        .ok_or_else(|| anyhow!("native factory entity input target is missing"))?;
    let entity = state.parse_entity(entity_index)?;
    let entity = entity
        .as_object()
        .ok_or_else(|| anyhow!("native factory entity input target is malformed"))?;
    let current = optional_safe_nonnegative_integer(
        entity
            .get("inputs")
            .and_then(Value::as_object)
            .and_then(|inputs| inputs.get(item_id)),
        "entity input current amount",
    )?;
    if target <= current {
        return Ok(None);
    }
    if command.changed_entities.len() != 1
        || !command.added_entities.is_empty()
        || !command.removed_entity_ids.is_empty()
        || !command.changed_belts.is_empty()
        || !command.added_belts.is_empty()
        || !command.removed_belt_ids.is_empty()
    {
        bail!("native factory entity input command shape is invalid")
    }
    if state.catalog.snapshot.registry_fingerprint != EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT
        || state.identity.registry_fingerprint != EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT
    {
        bail!("native factory entity input requires the built-in content registry")
    }
    known_item_id(state, item_id)?;
    let active_planet_id = active_planet_id(state, state.base_value())?;
    if entity.get("planetId").and_then(Value::as_str) != Some(active_planet_id) {
        bail!("native factory entity input target is not on the active planet")
    }
    if entity.get("kind").and_then(Value::as_str) != Some("machine") {
        bail!("native factory entity input target is not an ordinary recipe machine")
    }
    let building_id = entity
        .get("buildingId")
        .and_then(Value::as_str)
        .and_then(canonical_recipe_building_id)
        .ok_or_else(|| anyhow!("native factory entity input building is not supported"))?;
    let building = entity
        .get("buildingId")
        .and_then(Value::as_str)
        .and_then(|id| state.catalog.buildings.get(id))
        .ok_or_else(|| anyhow!("native factory entity input building is missing"))?;
    if building.kind != "machine" {
        bail!("native factory entity input catalog kind is not supported")
    }
    let recipe = entity
        .get("recipeId")
        .and_then(Value::as_str)
        .and_then(|id| state.catalog.recipes.get(id))
        .ok_or_else(|| anyhow!("native factory entity input recipe is missing"))?;
    if recipe.building_id != building_id || !recipe_accepts_ordinary_input(recipe, item_id) {
        bail!("native factory entity input item is not consumed by the active recipe")
    }
    let machine_count = safe_nonnegative_integer(entity.get("machineCount"), "machine count")?;
    if machine_count == 0 {
        bail!("native factory entity input machine count is empty")
    }
    if !building.input_capacity.is_finite()
        || building.input_capacity <= 0.0
        || building.input_capacity.fract() != 0.0
        || building.input_capacity > MAX_JAVASCRIPT_SAFE_INTEGER as f64
    {
        bail!("native factory entity input capacity is not a safe integer")
    }
    let base_capacity = building.input_capacity as u64;
    let capacity = base_capacity
        .checked_mul(machine_count)
        .unwrap_or(MAX_JAVASCRIPT_SAFE_INTEGER)
        .min(effective_production_buffer_limit(state.base_value()))
        .min(MAX_JAVASCRIPT_SAFE_INTEGER);
    if current >= capacity {
        bail!("native factory entity input target has no free capacity")
    }
    Ok(Some(EntityInventoryTarget {
        item_id: item_id.clone(),
        current,
        capacity,
    }))
}

fn entity_inventory_source<'a>(
    state: &CoreState,
    command: &'a SimulationCommandPatch,
) -> anyhow::Result<EntityInventorySource<'a>> {
    if command.changed_entities.len() != 1
        || !command.added_entities.is_empty()
        || !command.removed_entity_ids.is_empty()
        || !command.changed_belts.is_empty()
        || !command.added_belts.is_empty()
        || !command.removed_belt_ids.is_empty()
    {
        bail!("native factory entity inventory command shape is invalid")
    }
    let record = &command.changed_entities[0];
    if !valid_opaque_id(&record.id) || record.changes.len() != 1 {
        bail!("native factory entity inventory source is invalid")
    }
    let change = &record.changes[0];
    let [PathSegment::Key(field), PathSegment::Key(item_id)] = change.path.as_slice() else {
        bail!("native factory entity inventory source path is invalid")
    };
    let field = match field.as_str() {
        "inputs" => EntityInventorySourceField::Inputs,
        "outputs" => EntityInventorySourceField::Outputs,
        _ => bail!("native factory entity inventory source field is invalid"),
    };
    known_item_id(state, item_id)?;
    if change.operation != "set" {
        bail!("native factory entity inventory source operation is invalid")
    }
    let remaining =
        safe_nonnegative_integer(change.value.as_ref(), "entity inventory source remainder")?;
    let entity_index = state
        .entity_index
        .get(&record.id)
        .copied()
        .ok_or_else(|| anyhow!("native factory entity inventory source is missing"))?;
    let entity = state.parse_entity(entity_index)?;
    let entity = entity
        .as_object()
        .ok_or_else(|| anyhow!("native factory entity inventory source is malformed"))?;
    let active_planet_id = active_planet_id(state, state.base_value())?;
    if entity.get("planetId").and_then(Value::as_str) != Some(active_planet_id) {
        bail!("native factory entity inventory source is not on the active planet")
    }
    // Station outputs may already back local/interstellar/quantum routes. A
    // bounded UI projection does not carry the complete route-reservation
    // ledger, so keep that case closed until a dedicated receipt is supplied.
    if field == EntityInventorySourceField::Outputs
        && entity.get("kind").and_then(Value::as_str) == Some("station")
    {
        bail!("native factory station output requires a route reservation proof")
    }
    let available = entity
        .get(field.key())
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("native factory entity inventory directory is invalid"))?
        .get(item_id);
    let available = safe_nonnegative_integer(available, "entity inventory source amount")?;
    if available == 0 || remaining > available {
        bail!("native factory entity inventory source amount is empty or reversed")
    }
    Ok(EntityInventorySource {
        entity_id: &record.id,
        item_id,
        field,
        available,
    })
}

fn source_remainder_patch(source: &EntityInventorySource<'_>, remaining: u64) -> ValuePatch {
    ValuePatch {
        path: vec![
            PathSegment::Key(source.field.key().to_owned()),
            PathSegment::Key(source.item_id.to_owned()),
        ],
        operation: "set".to_owned(),
        value: Some(Value::from(remaining)),
    }
}

fn validate_take_from_entity(
    state: &CoreState,
    command: &SimulationCommandPatch,
    source: &EntityInventorySource<'_>,
) -> anyhow::Result<()> {
    if command.top_level_changes.len() != 1 {
        bail!("native factory entity take patch set is incomplete or mixed")
    }
    let current_cargo = held_cargo(state, state.base_value())?;
    let held_amount = match current_cargo.as_ref() {
        None => 0,
        Some(cargo) if cargo.item_id == source.item_id => cargo.amount,
        Some(_) => bail!("native factory entity take would mix held item types"),
    };
    let take = source
        .available
        .min(PICKUP_TARGET_AMOUNT.saturating_sub(held_amount));
    if take == 0 {
        bail!("native factory entity take has no cursor capacity")
    }
    let next_held = held_amount
        .checked_add(take)
        .filter(|amount| *amount <= PICKUP_TARGET_AMOUNT)
        .ok_or_else(|| anyhow!("native factory entity take overflows the cursor"))?;
    exact_patch_sets_match(
        &command.top_level_changes,
        &[ValuePatch {
            path: vec![PathSegment::Key("cargo".to_owned())],
            operation: "set".to_owned(),
            value: Some(json!({
                "itemId": source.item_id,
                "amount": next_held,
                "origin": {
                    "kind": source.field.cargo_origin_kind(),
                    "id": source.entity_id,
                },
            })),
        }],
    )?;
    exact_patch_sets_match(
        &command.changed_entities[0].changes,
        &[source_remainder_patch(source, source.available - take)],
    )
}

fn validate_stow_entity_inventory(
    state: &CoreState,
    command: &SimulationCommandPatch,
    source: &EntityInventorySource<'_>,
) -> anyhow::Result<()> {
    if command.top_level_changes.len() != 1 {
        bail!("native factory entity stow patch set is incomplete or mixed")
    }
    let base = state.base_value();
    let active_planet_id = active_planet_id(state, base)?;
    let (root, current, free_capacity) = if is_portable_fleet_item(source.item_id) {
        let portable = base
            .get("portableFleet")
            .and_then(Value::as_object)
            .ok_or_else(|| anyhow!("native factory inventory portable fleet is invalid"))?;
        let current = optional_safe_nonnegative_integer(
            portable.get(source.item_id),
            "portable fleet stow target",
        )?;
        (
            "portableFleet",
            current,
            MAX_JAVASCRIPT_SAFE_INTEGER.saturating_sub(current),
        )
    } else {
        let tray = active_tray(base)?;
        let current =
            optional_safe_nonnegative_integer(tray.get(source.item_id), "entity stow tray target")?;
        let limit = effective_tray_item_limit(base, active_planet_id)?;
        ("tray", current, limit.saturating_sub(current))
    };
    let moved = source.available.min(free_capacity);
    if moved == 0 {
        bail!("native factory entity stow has no destination capacity")
    }
    let target = current
        .checked_add(moved)
        .filter(|value| *value <= MAX_JAVASCRIPT_SAFE_INTEGER)
        .ok_or_else(|| anyhow!("native factory entity stow destination overflows"))?;
    exact_patch_sets_match(
        &command.top_level_changes,
        &[ValuePatch {
            path: vec![
                PathSegment::Key(root.to_owned()),
                PathSegment::Key(source.item_id.to_owned()),
            ],
            operation: "set".to_owned(),
            value: Some(Value::from(target)),
        }],
    )?;
    exact_patch_sets_match(
        &command.changed_entities[0].changes,
        &[source_remainder_patch(source, source.available - moved)],
    )
}

fn canonical_partial_cargo(cargo: &HeldCargo, remaining: u64) -> Value {
    let origin = cargo.origin.as_ref().map_or(
        Value::Null,
        |origin| json!({ "kind": origin.kind, "id": origin.id }),
    );
    json!({ "itemId": cargo.item_id, "amount": remaining, "origin": origin })
}

fn require_nonopaque_held_cargo(base: &Map<String, Value>) -> anyhow::Result<()> {
    let cargo = base
        .get("cargo")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("native factory entity input held cargo is invalid"))?;
    if cargo
        .keys()
        .any(|key| !matches!(key.as_str(), "itemId" | "amount" | "origin"))
    {
        bail!("native factory entity input held cargo has opaque fields")
    }
    if let Some(origin) = cargo.get("origin").filter(|origin| !origin.is_null()) {
        let origin = origin
            .as_object()
            .ok_or_else(|| anyhow!("native factory entity input cargo origin is invalid"))?;
        if origin
            .keys()
            .any(|key| !matches!(key.as_str(), "kind" | "id"))
        {
            bail!("native factory entity input cargo origin has opaque fields")
        }
    }
    Ok(())
}

fn validate_deposit_to_entity(
    state: &CoreState,
    command: &SimulationCommandPatch,
    target: &EntityInventoryTarget,
) -> anyhow::Result<()> {
    if command.top_level_changes.len() != 1 {
        bail!("native factory entity input source patch set is incomplete or mixed")
    }
    let base = state.base_value();
    let free_capacity = target.capacity - target.current;
    let source_change = &command.top_level_changes[0];
    let (available, expected_source) = if path_equals(&source_change.path, &["cargo"])
        && source_change.operation == "set"
    {
        let cargo = held_cargo(state, base)?
            .ok_or_else(|| anyhow!("native factory entity input held cargo is empty"))?;
        if cargo.item_id != target.item_id {
            bail!("native factory entity input held item is incompatible")
        }
        require_nonopaque_held_cargo(base)?;
        let moved = cargo.amount.min(free_capacity);
        if moved == 0 {
            bail!("native factory entity input held transfer is empty")
        }
        let remaining = cargo.amount - moved;
        let value = if remaining == 0 {
            Value::Null
        } else {
            canonical_partial_cargo(&cargo, remaining)
        };
        (
            cargo.amount,
            ValuePatch {
                path: vec![PathSegment::Key("cargo".to_owned())],
                operation: "set".to_owned(),
                value: Some(value),
            },
        )
    } else if path_equals(&source_change.path, &["tray", target.item_id.as_str()])
        && source_change.operation == "set"
    {
        let tray = active_tray(base)?;
        let available =
            safe_nonnegative_integer(tray.get(&target.item_id), "entity input tray source amount")?;
        if available == 0 {
            bail!("native factory entity input tray source is empty")
        }
        let moved = available.min(free_capacity);
        (
            available,
            ValuePatch {
                path: vec![
                    PathSegment::Key("tray".to_owned()),
                    PathSegment::Key(target.item_id.clone()),
                ],
                operation: "set".to_owned(),
                value: Some(Value::from(available - moved)),
            },
        )
    } else {
        bail!("native factory entity input source is not held cargo or active tray")
    };
    let moved = available.min(free_capacity);
    let next_input = target
        .current
        .checked_add(moved)
        .filter(|value| *value <= target.capacity)
        .ok_or_else(|| anyhow!("native factory entity input target overflows"))?;
    exact_patch_sets_match(&command.top_level_changes, &[expected_source])?;
    exact_patch_sets_match(
        &command.changed_entities[0].changes,
        &[ValuePatch {
            path: vec![
                PathSegment::Key("inputs".to_owned()),
                PathSegment::Key(target.item_id.clone()),
            ],
            operation: "set".to_owned(),
            value: Some(Value::from(next_input)),
        }],
    )
}

pub(crate) fn validate_factory_inventory_command(
    state: &CoreState,
    command: &SimulationCommandPatch,
) -> anyhow::Result<()> {
    if command.top_level_changes.is_empty()
        || command
            .top_level_changes
            .iter()
            .any(|change| !factory_inventory_command_path(&change.path))
    {
        bail!("native factory inventory command shape is invalid")
    }
    if command
        .top_level_changes
        .iter()
        .any(|change| production_buffer_limit_path(&change.path))
    {
        return validate_production_buffer_limit(state, command);
    }
    if !command.changed_entities.is_empty() {
        if let Some(target) = entity_inventory_target(state, command)? {
            return validate_deposit_to_entity(state, command, &target);
        }
        let source = entity_inventory_source(state, command)?;
        let takes_to_cursor = command.top_level_changes.iter().any(|change| {
            path_equals(&change.path, &["cargo"])
                && change.operation == "set"
                && change.value.as_ref().is_some_and(|value| !value.is_null())
        });
        return if takes_to_cursor {
            validate_take_from_entity(state, command, &source)
        } else {
            validate_stow_entity_inventory(state, command, &source)
        };
    }
    if !patches_have_only_top_level_changes(command) {
        bail!("native factory inventory command shape is invalid")
    }
    if command.top_level_changes.iter().any(|change| {
        matches!(
            change.path.first(),
            Some(PathSegment::Key(root)) if root == "planetTrayItemLimits"
        )
    }) {
        return validate_active_tray_item_limit(state, command);
    }
    let returns_cargo = command.top_level_changes.iter().any(|change| {
        path_equals(&change.path, &["cargo"])
            && change.operation == "set"
            && change.value.as_ref().is_some_and(Value::is_null)
    });
    if returns_cargo {
        validate_return_held_cargo(state, command)
    } else {
        validate_take_from_active_tray(state, command)
    }
}

impl CoreState {
    /// Returns a stable page of the current native tray without transferring a
    /// full GameState. Item IDs use Rust string order, which is lexicographic
    /// UTF-8 byte order, so the same cursor is deterministic for one revision.
    pub fn factory_inventory_projection(
        &self,
        expected_revision: u64,
        cursor: usize,
        limit: usize,
    ) -> anyhow::Result<Value> {
        if expected_revision != self.revision || !(1..=MAX_PAGE_ROWS).contains(&limit) {
            bail!("native factory inventory projection request is invalid")
        }
        let base = self.base_value();
        let active_planet_id = active_planet_id(self, base)?;
        let tray_item_limit = effective_tray_item_limit(base, active_planet_id)?;
        let production_buffer_limit = effective_production_buffer_limit(base);
        let tray = active_tray(base)?;
        let mut inventory = Vec::<(&str, u64)>::with_capacity(tray.len());
        for (item_id, amount) in tray {
            known_item_id(self, item_id)?;
            let amount = safe_nonnegative_integer(Some(amount), "tray item amount")?;
            if amount > 0 {
                inventory.push((item_id, amount));
            }
        }
        inventory.sort_unstable_by(|left, right| left.0.as_bytes().cmp(right.0.as_bytes()));
        let total_count = inventory.len();
        if cursor > total_count {
            bail!("native factory inventory projection cursor is invalid")
        }
        let rows = inventory
            .iter()
            .skip(cursor)
            .take(limit)
            .map(|(item_id, amount)| {
                json!({
                    "itemId": item_id,
                    "amount": amount,
                    "freeCapacity": tray_item_limit.saturating_sub(*amount),
                    "overLimit": *amount > tray_item_limit,
                })
            })
            .collect::<Vec<_>>();
        let consumed = cursor
            .checked_add(rows.len())
            .ok_or_else(|| anyhow!("native factory inventory projection cursor overflows"))?;
        let next_cursor = (consumed < total_count).then_some(consumed);
        let cargo = held_cargo(self, base)?.map_or(Value::Null, |cargo| {
            let origin = cargo.origin.map_or(
                Value::Null,
                |origin| json!({ "kind": origin.kind, "id": origin.id }),
            );
            json!({ "itemId": cargo.item_id, "amount": cargo.amount, "origin": origin })
        });
        let portable_fleet = base
            .get("portableFleet")
            .and_then(Value::as_object)
            .ok_or_else(|| anyhow!("native factory inventory portable fleet is invalid"))?;
        let logistics_drone = optional_safe_nonnegative_integer(
            portable_fleet.get("logistics_drone"),
            "portable logistics drone amount",
        )?;
        let logistics_vessel = optional_safe_nonnegative_integer(
            portable_fleet.get("logistics_vessel"),
            "portable logistics vessel amount",
        )?;
        let value = json!({
            "schemaVersion": 1,
            "projectionType": FACTORY_INVENTORY_PROJECTION,
            "source": "native-core",
            "revision": self.revision,
            "stateVersion": self.identity.state_version,
            "registryFingerprint": self.catalog.snapshot.registry_fingerprint,
            "activePlanetId": active_planet_id,
            "cargo": cargo,
            "pickupTargetAmount": PICKUP_TARGET_AMOUNT,
            "portableFleet": {
                "logistics_drone": logistics_drone,
                "logistics_vessel": logistics_vessel,
            },
            "productionBufferLimit": production_buffer_limit,
            "trayItemLimit": tray_item_limit,
            "trayItemLimitBounds": {
                "minimum": MIN_TRAY_ITEM_LIMIT,
                "default": DEFAULT_TRAY_ITEM_LIMIT,
                "maximum": MAX_TRAY_ITEM_LIMIT,
            },
            "request": { "expectedRevision": expected_revision, "cursor": cursor, "limit": limit },
            "totalCount": total_count,
            "rows": rows,
            "nextCursor": next_cursor,
            "truncated": next_cursor.is_some(),
            "limits": { "rows": MAX_PAGE_ROWS, "projectionBytes": MAX_PROJECTION_BYTES },
        });
        if serde_json::to_vec(&value)?.len() > MAX_PROJECTION_BYTES {
            bail!("native factory inventory projection exceeds the byte limit")
        }
        Ok(value)
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::{
        CoreCheckpointIdentity,
        catalog::{CatalogSnapshot, RuntimeCatalog},
    };

    const REGISTRY: &str = "factory-inventory-test";

    fn catalog_for_registry(registry_fingerprint: &str) -> RuntimeCatalog {
        let snapshot: CatalogSnapshot = serde_json::from_value(json!({
            "protocolVersion": crate::CORE_PROTOCOL_VERSION,
            "registryFingerprint": registry_fingerprint,
            "planets": [
                { "id": "home", "systemId": "helios", "kind": "terrestrial", "orbitIndex": 1 },
                { "id": "ashen", "systemId": "sigma", "kind": "terrestrial", "orbitIndex": 1 }
            ],
            "items": [
                { "id": "iron_ore", "kind": "solid" },
                { "id": "iron_ingot", "kind": "solid" },
                { "id": "gear", "kind": "solid" },
                { "id": "MOD/item-beta", "kind": "solid" },
                { "id": "zeta_ore", "kind": "solid" },
                { "id": "logistics_drone", "kind": "solid" },
                { "id": "logistics_vessel", "kind": "solid" }
            ],
            "buildings": [
                {
                    "id": "assembling_machine_mk1", "kind": "machine", "speed": 1,
                    "inputCapacity": 120, "outputCapacity": 120
                },
                {
                    "id": "MOD/opaque-machine", "kind": "machine", "speed": 1,
                    "inputCapacity": 120, "outputCapacity": 120
                },
                {
                    "id": "interstellar_logistics_station", "kind": "station", "speed": 1,
                    "inputCapacity": 1000, "outputCapacity": 1000
                }
            ],
            "recipes": [
                {
                    "id": "gear", "buildingId": "assembling_machine_mk1", "duration": 1,
                    "inputs": [{ "itemId": "iron_ingot", "amount": 1 }],
                    "outputs": [{ "itemId": "gear", "amount": 1 }]
                },
                {
                    "id": "MOD/opaque-recipe", "buildingId": "MOD/opaque-machine", "duration": 1,
                    "inputs": [{ "itemId": "iron_ingot", "amount": 1 }],
                    "outputs": [{ "itemId": "gear", "amount": 1 }]
                }
            ],
            "constructions": [],
            "belts": [],
            "technologies": []
        }))
        .unwrap();
        RuntimeCatalog::validate(snapshot, registry_fingerprint).unwrap()
    }

    fn fixture_base() -> Map<String, Value> {
        json!({
            "version": 47,
            "mode": "normal",
            "activePlanetId": "home",
            "elapsedSeconds": 10,
            "paused": false,
            "cargo": null,
            "tray": {
                "iron_ore": 150,
                "MOD/item-beta": 7,
                "zeta_ore": 3,
                "logistics_drone": 0
            },
            "planetTrays": { "home": {}, "ashen": {} },
            "planetTrayItemLimits": { "home": 1000, "ashen": 2000 },
            "portableFleet": { "logistics_drone": 3, "logistics_vessel": 4 },
            "settings": { "simulationSpeed": 1, "productionBufferLimit": 1000 },
            "exploration": { "colonizedPlanetIds": ["home", "ashen"], "unlockedSystemIds": ["helios", "sigma"] }
        })
        .as_object()
        .unwrap()
        .clone()
    }

    fn state_with_entities_for_registry(
        entities: Vec<Value>,
        registry_fingerprint: &str,
    ) -> CoreState {
        CoreState::from_public_v47_parts(
            CoreCheckpointIdentity {
                slot: "normal-main".to_owned(),
                generation: 1,
                root_hash: "a".repeat(64),
                revision: 7,
                state_version: 47,
                mode: "normal".to_owned(),
                registry_fingerprint: registry_fingerprint.to_owned(),
                base_primary_checksum: "12345678".to_owned(),
            },
            fixture_base(),
            entities
                .into_iter()
                .map(|entity| serde_json::to_string(&entity).unwrap())
                .collect(),
            Vec::new(),
            catalog_for_registry(registry_fingerprint),
        )
        .unwrap()
    }

    fn state_with_entities(entities: Vec<Value>) -> CoreState {
        state_with_entities_for_registry(entities, REGISTRY)
    }

    fn state() -> CoreState {
        state_with_entities(Vec::new())
    }

    fn inventory_entity(id: &str, kind: &str, inputs: Value, outputs: Value) -> Value {
        json!({
            "id": id,
            "kind": kind,
            "planetId": "home",
            "position": { "x": 0, "y": 0 },
            "interactionLocked": false,
            "buildingId": "fixture-machine",
            "machineCount": 1,
            "minerCount": 0,
            "inputs": inputs,
            "outputs": outputs,
            "progress": 0,
            "routingCursor": 0,
            "utilization": 0,
            "productionRate": 0
        })
    }

    fn ordinary_recipe_entity(id: &str, inputs: Value) -> Value {
        json!({
            "id": id,
            "kind": "machine",
            "planetId": "home",
            "position": { "x": 0, "y": 0 },
            "interactionLocked": false,
            "buildingId": "assembling_machine_mk1",
            "recipeId": "gear",
            "machineCount": 2,
            "minerCount": 0,
            "inputs": inputs,
            "outputs": {},
            "progress": 0,
            "routingCursor": 0,
            "utilization": 0,
            "productionRate": 0
        })
    }

    fn command(revision: u64, changes: Vec<ValuePatch>) -> SimulationCommandPatch {
        SimulationCommandPatch {
            protocol_version: crate::CORE_PROTOCOL_VERSION,
            base_revision: revision,
            top_level_changes: changes,
            changed_entities: Vec::new(),
            added_entities: Vec::new(),
            removed_entity_ids: Vec::new(),
            changed_belts: Vec::new(),
            added_belts: Vec::new(),
            removed_belt_ids: Vec::new(),
        }
    }

    fn set(path: &[&str], value: Value) -> ValuePatch {
        ValuePatch {
            path: path
                .iter()
                .map(|segment| PathSegment::Key((*segment).to_owned()))
                .collect(),
            operation: "set".to_owned(),
            value: Some(value),
        }
    }

    fn entity_inventory_command(
        revision: u64,
        entity_id: &str,
        field: &str,
        item_id: &str,
        remaining: u64,
        top_level_changes: Vec<ValuePatch>,
    ) -> SimulationCommandPatch {
        let mut command = command(revision, top_level_changes);
        command.changed_entities.push(crate::command::RecordPatch {
            id: entity_id.to_owned(),
            changes: vec![set(&[field, item_id], Value::from(remaining))],
        });
        command
    }

    #[test]
    fn projection_pages_sorted_utf8_rows_without_hiding_mod_items() {
        let state = state();
        let before = state.summary().unwrap().canonical_sha256;
        let first = state.factory_inventory_projection(7, 0, 2).unwrap();
        assert_eq!(first["projectionType"], FACTORY_INVENTORY_PROJECTION);
        assert_eq!(first["revision"], 7);
        assert_eq!(first["activePlanetId"], "home");
        assert_eq!(first["registryFingerprint"], REGISTRY);
        assert_eq!(first["trayItemLimit"], 1_000);
        assert_eq!(first["productionBufferLimit"], 1_000);
        assert_eq!(first["pickupTargetAmount"], 100);
        assert_eq!(first["portableFleet"]["logistics_drone"], 3);
        assert_eq!(first["portableFleet"]["logistics_vessel"], 4);
        assert_eq!(first["totalCount"], 3);
        assert_eq!(first["rows"][0]["itemId"], "MOD/item-beta");
        assert_eq!(first["rows"][1]["itemId"], "iron_ore");
        assert_eq!(first["nextCursor"], 2);
        assert_eq!(first["truncated"], true);
        assert!(first["cargo"].is_null());

        let second = state.factory_inventory_projection(7, 2, 2).unwrap();
        assert_eq!(second["rows"][0]["itemId"], "zeta_ore");
        assert!(second["nextCursor"].is_null());
        assert_eq!(second["truncated"], false);
        assert_eq!(second["trayItemLimit"], first["trayItemLimit"]);
        assert_eq!(second["portableFleet"], first["portableFleet"]);
        assert_eq!(state.summary().unwrap().canonical_sha256, before);
    }

    #[test]
    fn projection_is_revision_bounded_and_rejects_invalid_inventory() {
        let state = state();
        assert!(state.factory_inventory_projection(6, 0, 2).is_err());
        assert!(state.factory_inventory_projection(7, 0, 0).is_err());
        assert!(
            state
                .factory_inventory_projection(7, 0, MAX_PAGE_ROWS + 1)
                .is_err()
        );
        assert!(state.factory_inventory_projection(7, 4, 1).is_err());

        let mut fractional = state.clone();
        fractional.base_value_mut()["tray"]["iron_ore"] = json!(1.5);
        assert!(fractional.factory_inventory_projection(7, 0, 2).is_err());
        let mut unsafe_integer = state.clone();
        unsafe_integer.base_value_mut()["tray"]["iron_ore"] = json!(9_007_199_254_740_992_u64);
        assert!(
            unsafe_integer
                .factory_inventory_projection(7, 0, 2)
                .is_err()
        );
        let mut unknown_item = state.clone();
        unknown_item.base_value_mut()["tray"]["unknown-mod-item"] = json!(1);
        assert!(unknown_item.factory_inventory_projection(7, 0, 2).is_err());
        let mut historical_cargo = state;
        historical_cargo.base_value_mut()["cargo"] = json!({
            "itemId": "iron_ore",
            "amount": 101,
            "origin": { "kind": "tray", "id": "historical-origin", "modTag": 7 },
            "modPayload": { "owner": "pack:test" }
        });
        let projection = historical_cargo
            .factory_inventory_projection(7, 0, 2)
            .unwrap();
        assert_eq!(projection["cargo"]["amount"], 101);
        assert_eq!(projection["cargo"]["origin"]["kind"], "tray");
        assert_eq!(projection["cargo"]["origin"]["id"], "historical-origin");
    }

    #[test]
    fn player_authority_fills_an_empty_or_same_item_held_stack_canonically() {
        let mut empty = state();
        let take = command(
            7,
            vec![
                set(&["tray", "iron_ore"], json!(50)),
                set(
                    &["cargo"],
                    json!({ "itemId": "iron_ore", "amount": 100, "origin": { "kind": "tray" } }),
                ),
            ],
        );
        let applied = empty.apply_player_authority_command(&take).unwrap();
        assert!(!applied.topology_dirty);
        assert_eq!(empty.base_value()["tray"]["iron_ore"], 50);
        assert_eq!(empty.base_value()["cargo"]["amount"], 100);

        let mut same_item = state();
        same_item.base_value_mut()["cargo"] = json!({
            "itemId": "iron_ore",
            "amount": 40,
            "origin": { "kind": "node-output", "id": "source-node", "modTag": 7 },
            "modPayload": { "owner": "pack:test" }
        });
        let refill = command(
            7,
            vec![
                set(&["tray", "iron_ore"], json!(90)),
                set(
                    &["cargo"],
                    json!({ "itemId": "iron_ore", "amount": 100, "origin": { "kind": "tray" } }),
                ),
            ],
        );
        same_item.apply_player_authority_command(&refill).unwrap();
        assert_eq!(same_item.base_value()["tray"]["iron_ore"], 90);
        assert_eq!(same_item.base_value()["cargo"]["amount"], 100);
        assert_eq!(
            same_item.base_value()["cargo"]["origin"],
            json!({ "kind": "tray" })
        );
    }

    #[test]
    fn player_authority_tray_take_rejects_mixing_partial_or_forged_accounting() {
        let mut mixed = state();
        mixed.base_value_mut()["cargo"] =
            json!({ "itemId": "MOD/item-beta", "amount": 1, "origin": { "kind": "tray" } });
        let before = mixed.summary().unwrap().canonical_sha256;
        let forged = command(
            7,
            vec![
                set(&["tray", "iron_ore"], json!(149)),
                set(
                    &["cargo"],
                    json!({ "itemId": "iron_ore", "amount": 1, "origin": { "kind": "tray" } }),
                ),
            ],
        );
        assert!(mixed.apply_player_authority_command(&forged).is_err());
        assert_eq!(mixed.summary().unwrap().canonical_sha256, before);

        let mut partial = state();
        let before = partial.summary().unwrap().canonical_sha256;
        assert!(partial.apply_player_authority_command(&forged).is_err());
        assert_eq!(partial.summary().unwrap().canonical_sha256, before);

        let mut extra = command(
            7,
            vec![
                set(&["tray", "iron_ore"], json!(50)),
                set(
                    &["cargo"],
                    json!({ "itemId": "iron_ore", "amount": 100, "origin": { "kind": "tray" } }),
                ),
                set(&["portableFleet", "logistics_drone"], json!(999)),
            ],
        );
        assert!(partial.apply_player_authority_command(&extra).is_err());
        extra.base_revision = 6;
        assert!(partial.apply_player_authority_command(&extra).is_err());

        let mut historical = state();
        historical.base_value_mut()["cargo"] =
            json!({ "itemId": "iron_ore", "amount": 101, "origin": { "kind": "tray" } });
        let before = historical.summary().unwrap().canonical_sha256;
        // The old JavaScript expression could turn a negative room into a
        // negative take, increasing the tray while shrinking the held stack.
        // Native authority treats a full/overfull historical stack as no-op.
        let reverse_transfer = command(
            7,
            vec![
                set(&["tray", "iron_ore"], json!(151)),
                set(&["cargo", "amount"], json!(100)),
            ],
        );
        assert!(
            historical
                .apply_player_authority_command(&reverse_transfer)
                .is_err()
        );
        assert_eq!(historical.summary().unwrap().canonical_sha256, before);
    }

    #[test]
    fn player_authority_returns_regular_cargo_losslessly_above_a_lowered_limit() {
        let mut state = state();
        state.base_value_mut()["tray"]["iron_ore"] = json!(1_000);
        state.base_value_mut()["cargo"] = json!({
            "itemId": "iron_ore",
            "amount": 125,
            "origin": { "kind": "tray", "id": "historical-origin", "modTag": 7 },
            "modPayload": { "owner": "pack:test" }
        });
        let return_command = command(
            7,
            vec![
                set(&["tray", "iron_ore"], json!(1_125)),
                set(&["cargo"], Value::Null),
            ],
        );
        state
            .apply_player_authority_command(&return_command)
            .unwrap();
        assert_eq!(state.base_value()["tray"]["iron_ore"], 1_125);
        assert!(state.base_value()["cargo"].is_null());
        let projection = state.factory_inventory_projection(8, 0, 8).unwrap();
        let iron = projection["rows"]
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["itemId"] == "iron_ore")
            .unwrap();
        assert_eq!(iron["freeCapacity"], 0);
        assert_eq!(iron["overLimit"], true);
    }

    #[test]
    fn player_authority_returns_portable_fleet_to_its_lossless_global_inventory() {
        let mut state = state();
        state.base_value_mut()["cargo"] = json!({
            "itemId": "logistics_drone",
            "amount": 7,
            "origin": { "kind": "node-output", "id": "station" }
        });
        let tray_before = state.base_value()["tray"].clone();
        let return_command = command(
            7,
            vec![
                set(&["portableFleet", "logistics_drone"], json!(10)),
                set(&["cargo"], Value::Null),
            ],
        );
        state
            .apply_player_authority_command(&return_command)
            .unwrap();
        assert_eq!(state.base_value()["portableFleet"]["logistics_drone"], 10);
        assert_eq!(state.base_value()["tray"], tray_before);
        assert!(state.base_value()["cargo"].is_null());
        let projection = state.factory_inventory_projection(8, 0, 8).unwrap();
        assert_eq!(projection["portableFleet"]["logistics_drone"], 10);
    }

    #[test]
    fn player_authority_return_rejects_overflow_or_forged_destination_atomically() {
        let mut overflow = state();
        overflow.base_value_mut()["tray"]["iron_ore"] = Value::from(MAX_JAVASCRIPT_SAFE_INTEGER);
        overflow.base_value_mut()["cargo"] =
            json!({ "itemId": "iron_ore", "amount": 1, "origin": { "kind": "tray" } });
        let before = overflow.summary().unwrap().canonical_sha256;
        let overflow_command = command(
            7,
            vec![
                set(&["tray", "iron_ore"], json!(MAX_JAVASCRIPT_SAFE_INTEGER)),
                set(&["cargo"], Value::Null),
            ],
        );
        assert!(
            overflow
                .apply_player_authority_command(&overflow_command)
                .is_err()
        );
        assert_eq!(overflow.summary().unwrap().canonical_sha256, before);

        let mut portable = state();
        portable.base_value_mut()["cargo"] = json!({
            "itemId": "logistics_drone",
            "amount": 7,
            "origin": { "kind": "tray" }
        });
        let forged = command(
            7,
            vec![
                set(&["tray", "logistics_drone"], json!(7)),
                set(&["cargo"], Value::Null),
            ],
        );
        assert!(portable.apply_player_authority_command(&forged).is_err());
    }

    #[test]
    fn player_authority_sets_only_the_active_planet_limit_within_game_bounds() {
        let mut state = state();
        let valid = command(
            7,
            vec![set(&["planetTrayItemLimits", "home"], json!(100_000_000))],
        );
        state.apply_player_authority_command(&valid).unwrap();
        assert_eq!(
            state.base_value()["planetTrayItemLimits"]["home"],
            100_000_000
        );

        for (revision, path, value) in [
            (8, vec!["planetTrayItemLimits", "home"], json!(999)),
            (8, vec!["planetTrayItemLimits", "home"], json!(100_000_001)),
            (8, vec!["planetTrayItemLimits", "ashen"], json!(2_000)),
            (8, vec!["planetTrayItemLimits", "home"], json!(100_000_000)),
        ] {
            let before = state.summary().unwrap().canonical_sha256;
            assert!(
                state
                    .apply_player_authority_command(&command(revision, vec![set(&path, value)]))
                    .is_err()
            );
            assert_eq!(state.summary().unwrap().canonical_sha256, before);
        }
    }

    #[test]
    fn player_authority_sets_only_the_bounded_production_buffer_limit() {
        let mut state = state();
        let tray_before = state.base_value()["tray"].clone();
        let valid = command(
            7,
            vec![set(&["settings", "productionBufferLimit"], json!(10_000))],
        );
        state.apply_player_authority_command(&valid).unwrap();
        assert_eq!(
            state.base_value()["settings"]["productionBufferLimit"],
            10_000
        );
        assert_eq!(state.base_value()["tray"], tray_before);
        assert_eq!(
            state.factory_inventory_projection(8, 0, 8).unwrap()["productionBufferLimit"],
            10_000
        );

        let invalid = [
            command(
                7,
                vec![set(&["settings", "productionBufferLimit"], json!(20_000))],
            ),
            command(
                8,
                vec![set(&["settings", "productionBufferLimit"], json!(999))],
            ),
            command(
                8,
                vec![set(
                    &["settings", "productionBufferLimit"],
                    json!(100_000_001),
                )],
            ),
            command(
                8,
                vec![set(&["settings", "productionBufferLimit"], json!(10_000))],
            ),
            command(
                8,
                vec![set(&["settings", "productionBufferLimit"], json!(10_000.5))],
            ),
            command(
                8,
                vec![
                    set(&["settings", "productionBufferLimit"], json!(20_000)),
                    set(&["planetTrayItemLimits", "home"], json!(20_000)),
                ],
            ),
            command(8, vec![set(&["settings", "simulationSpeed"], json!(2))]),
        ];
        for forged in invalid {
            let before = state.summary().unwrap().canonical_sha256;
            assert!(state.apply_player_authority_command(&forged).is_err());
            assert_eq!(state.summary().unwrap().canonical_sha256, before);
            assert_eq!(
                state.base_value()["settings"]["productionBufferLimit"],
                10_000
            );
        }
    }

    #[test]
    fn player_authority_takes_entity_inputs_and_outputs_with_exact_cursor_accounting() {
        let entity = inventory_entity(
            "machine-a",
            "machine",
            json!({ "iron_ore": 12 }),
            json!({ "iron_ore": 130 }),
        );
        let mut output = state_with_entities(vec![entity.clone()]);
        let take_output = entity_inventory_command(
            7,
            "machine-a",
            "outputs",
            "iron_ore",
            30,
            vec![set(
                &["cargo"],
                json!({
                    "itemId": "iron_ore",
                    "amount": 100,
                    "origin": { "kind": "node-output", "id": "machine-a" }
                }),
            )],
        );
        output.apply_player_authority_command(&take_output).unwrap();
        assert_eq!(output.parse_entity(0).unwrap()["outputs"]["iron_ore"], 30);
        assert_eq!(output.base_value()["cargo"]["amount"], 100);
        assert_eq!(output.revision, 8);

        let mut input = state_with_entities(vec![entity]);
        input.base_value_mut()["cargo"] = json!({
            "itemId": "iron_ore",
            "amount": 95,
            "origin": { "kind": "tray" }
        });
        let take_input = entity_inventory_command(
            7,
            "machine-a",
            "inputs",
            "iron_ore",
            7,
            vec![set(
                &["cargo"],
                json!({
                    "itemId": "iron_ore",
                    "amount": 100,
                    "origin": { "kind": "node-input", "id": "machine-a" }
                }),
            )],
        );
        input.apply_player_authority_command(&take_input).unwrap();
        assert_eq!(input.parse_entity(0).unwrap()["inputs"]["iron_ore"], 7);
        assert_eq!(input.base_value()["cargo"]["amount"], 100);
    }

    #[test]
    fn player_authority_stows_entity_inventory_with_tray_cap_and_portable_redirect() {
        let mut regular = state_with_entities(vec![inventory_entity(
            "machine-a",
            "machine",
            json!({}),
            json!({ "iron_ore": 130 }),
        )]);
        regular.base_value_mut()["tray"]["iron_ore"] = json!(990);
        let stow = entity_inventory_command(
            7,
            "machine-a",
            "outputs",
            "iron_ore",
            120,
            vec![set(&["tray", "iron_ore"], json!(1_000))],
        );
        regular.apply_player_authority_command(&stow).unwrap();
        assert_eq!(regular.base_value()["tray"]["iron_ore"], 1_000);
        assert_eq!(regular.parse_entity(0).unwrap()["outputs"]["iron_ore"], 120);

        let mut portable = state_with_entities(vec![inventory_entity(
            "machine-b",
            "machine",
            json!({ "logistics_drone": 7 }),
            json!({}),
        )]);
        let stow_portable = entity_inventory_command(
            7,
            "machine-b",
            "inputs",
            "logistics_drone",
            0,
            vec![set(&["portableFleet", "logistics_drone"], json!(10))],
        );
        portable
            .apply_player_authority_command(&stow_portable)
            .unwrap();
        assert_eq!(
            portable.base_value()["portableFleet"]["logistics_drone"],
            10
        );
        assert_eq!(
            portable.parse_entity(0).unwrap()["inputs"]["logistics_drone"],
            0
        );
    }

    #[test]
    fn player_authority_feeds_held_or_tray_material_into_bounded_builtin_inputs() {
        let mut held = state_with_entities_for_registry(
            vec![ordinary_recipe_entity(
                "machine-a",
                json!({ "iron_ingot": 200 }),
            )],
            EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT,
        );
        held.base_value_mut()["cargo"] = json!({
            "itemId": "iron_ingot",
            "amount": 100,
            "origin": { "kind": "tray" }
        });
        let feed_held = entity_inventory_command(
            7,
            "machine-a",
            "inputs",
            "iron_ingot",
            240,
            vec![set(
                &["cargo"],
                json!({
                    "itemId": "iron_ingot",
                    "amount": 60,
                    "origin": { "kind": "tray", "id": null }
                }),
            )],
        );
        held.apply_player_authority_command(&feed_held).unwrap();
        assert_eq!(held.parse_entity(0).unwrap()["inputs"]["iron_ingot"], 240);
        assert_eq!(held.base_value()["cargo"]["amount"], 60);
        assert_eq!(held.revision, 8);

        let mut tray = state_with_entities_for_registry(
            vec![ordinary_recipe_entity(
                "machine-b",
                json!({ "iron_ingot": 230 }),
            )],
            EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT,
        );
        tray.base_value_mut()["tray"]["iron_ingot"] = json!(150);
        let feed_tray = entity_inventory_command(
            7,
            "machine-b",
            "inputs",
            "iron_ingot",
            240,
            vec![set(&["tray", "iron_ingot"], json!(140))],
        );
        tray.apply_player_authority_command(&feed_tray).unwrap();
        assert_eq!(tray.parse_entity(0).unwrap()["inputs"]["iron_ingot"], 240);
        assert_eq!(tray.base_value()["tray"]["iron_ingot"], 140);
    }

    #[test]
    fn player_authority_entity_feed_is_conservative_and_failure_atomic() {
        let cases = [
            ordinary_recipe_entity("wrong-planet", json!({ "iron_ingot": 0 })),
            {
                let mut entity = ordinary_recipe_entity("station", json!({ "iron_ingot": 0 }));
                entity["kind"] = json!("station");
                entity["buildingId"] = json!("interstellar_logistics_station");
                entity
            },
            {
                let mut entity = ordinary_recipe_entity("opaque", json!({ "iron_ingot": 0 }));
                entity["buildingId"] = json!("MOD/opaque-machine");
                entity["recipeId"] = json!("MOD/opaque-recipe");
                entity
            },
            ordinary_recipe_entity("fractional", json!({ "iron_ingot": 0.5 })),
        ];
        for (index, mut entity) in cases.into_iter().enumerate() {
            if index == 0 {
                entity["planetId"] = json!("ashen");
            }
            let entity_id = entity["id"].as_str().unwrap().to_owned();
            let mut state = state_with_entities_for_registry(
                vec![entity],
                EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT,
            );
            state.base_value_mut()["cargo"] = json!({
                "itemId": "iron_ingot", "amount": 1, "origin": { "kind": "tray" }
            });
            let command = entity_inventory_command(
                7,
                &entity_id,
                "inputs",
                "iron_ingot",
                1,
                vec![set(&["cargo"], Value::Null)],
            );
            let before_hash = state.canonical_sha256().unwrap();
            let before_revision = state.revision;
            assert!(state.apply_player_authority_command(&command).is_err());
            assert_eq!(state.canonical_sha256().unwrap(), before_hash);
            assert_eq!(state.revision, before_revision);
        }

        let mut modified_registry = state_with_entities(vec![ordinary_recipe_entity(
            "machine-a",
            json!({ "iron_ingot": 0 }),
        )]);
        modified_registry.base_value_mut()["cargo"] = json!({
            "itemId": "iron_ingot", "amount": 1, "origin": { "kind": "tray" }
        });
        let command = entity_inventory_command(
            7,
            "machine-a",
            "inputs",
            "iron_ingot",
            1,
            vec![set(&["cargo"], Value::Null)],
        );
        let before_hash = modified_registry.canonical_sha256().unwrap();
        assert!(
            modified_registry
                .apply_player_authority_command(&command)
                .is_err()
        );
        assert_eq!(modified_registry.canonical_sha256().unwrap(), before_hash);
        assert_eq!(modified_registry.revision, 7);
    }

    #[test]
    fn player_authority_entity_feed_rejects_forged_capacity_item_and_opaque_cargo() {
        let mut state = state_with_entities_for_registry(
            vec![ordinary_recipe_entity(
                "machine-a",
                json!({ "iron_ingot": 239 }),
            )],
            EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT,
        );
        state.base_value_mut()["cargo"] = json!({
            "itemId": "iron_ingot",
            "amount": 5,
            "origin": { "kind": "tray" },
            "opaqueModPayload": { "owner": "MOD/test" }
        });
        let forged = entity_inventory_command(
            7,
            "machine-a",
            "inputs",
            "iron_ingot",
            244,
            vec![set(&["cargo"], Value::Null)],
        );
        let before_hash = state.canonical_sha256().unwrap();
        assert!(state.apply_player_authority_command(&forged).is_err());
        assert_eq!(state.canonical_sha256().unwrap(), before_hash);

        let mut wrong_item = state_with_entities_for_registry(
            vec![ordinary_recipe_entity(
                "machine-b",
                json!({ "iron_ore": 0 }),
            )],
            EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT,
        );
        wrong_item.base_value_mut()["tray"]["iron_ore"] = json!(150);
        let wrong_item_command = entity_inventory_command(
            7,
            "machine-b",
            "inputs",
            "iron_ore",
            120,
            vec![set(&["tray", "iron_ore"], json!(30))],
        );
        let before_hash = wrong_item.canonical_sha256().unwrap();
        assert!(
            wrong_item
                .apply_player_authority_command(&wrong_item_command)
                .is_err()
        );
        assert_eq!(wrong_item.canonical_sha256().unwrap(), before_hash);
        assert_eq!(wrong_item.revision, 7);
    }

    #[test]
    fn entity_inventory_failures_leave_hash_and_revision_unchanged() {
        let mut station = state_with_entities(vec![inventory_entity(
            "station-a",
            "station",
            json!({}),
            json!({ "iron_ore": 130 }),
        )]);
        let forged = entity_inventory_command(
            7,
            "station-a",
            "outputs",
            "iron_ore",
            30,
            vec![set(
                &["cargo"],
                json!({
                    "itemId": "iron_ore",
                    "amount": 100,
                    "origin": { "kind": "node-output", "id": "station-a" }
                }),
            )],
        );
        let before_hash = station.canonical_sha256().unwrap();
        let before_revision = station.revision;
        assert!(station.apply_player_authority_command(&forged).is_err());
        assert_eq!(station.canonical_sha256().unwrap(), before_hash);
        assert_eq!(station.revision, before_revision);

        let mut fractional = state_with_entities(vec![inventory_entity(
            "machine-a",
            "machine",
            json!({ "iron_ore": 1.5 }),
            json!({}),
        )]);
        let fractional_command = entity_inventory_command(
            7,
            "machine-a",
            "inputs",
            "iron_ore",
            0,
            vec![set(
                &["cargo"],
                json!({
                    "itemId": "iron_ore",
                    "amount": 1,
                    "origin": { "kind": "node-input", "id": "machine-a" }
                }),
            )],
        );
        let before_hash = fractional.canonical_sha256().unwrap();
        assert!(
            fractional
                .apply_player_authority_command(&fractional_command)
                .is_err()
        );
        assert_eq!(fractional.canonical_sha256().unwrap(), before_hash);

        let mut stale = state_with_entities(vec![inventory_entity(
            "machine-a",
            "machine",
            json!({ "iron_ore": 1 }),
            json!({}),
        )]);
        let mut stale_command = fractional_command;
        stale_command.base_revision = 6;
        let before_hash = stale.canonical_sha256().unwrap();
        assert!(
            stale
                .apply_player_authority_command(&stale_command)
                .is_err()
        );
        assert_eq!(stale.canonical_sha256().unwrap(), before_hash);
        assert_eq!(stale.revision, 7);
    }
}
