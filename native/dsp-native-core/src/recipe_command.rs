//! Minimal, durable single-entity recipe-selection intent.
//!
//! The renderer submits only `{ entityId, targetRecipeId }`. Rust re-reads the
//! current built-in catalog and authoritative entity, refunds both production
//! buffers, removes and refunds every incident belt, and resets the same
//! entity fields as the public-v47 JavaScript `setEntityRecipe()` transition.
//! No inventory, topology, or derived entity patch is renderer-authored.

use std::collections::BTreeMap;

use anyhow::{anyhow, bail};
use serde_json::{Map, Value};

use crate::{
    command::{
        EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT, PathSegment, RecordPatch, SimulationCommandPatch,
        builtin_belt_construction_id, create_expected_value_patches,
        normalized_construction_inventory, recipe_building_base, technology_is_completed,
    },
    state::CoreState,
};

const INTENT_ROOT: &str = "entityRecipe";
const INTENT_LEAF: &str = "intent";
const MAX_OPAQUE_ENTITY_ID_BYTES: usize = 512;
const MAX_CATALOG_ID_BYTES: usize = 160;
const MAX_JAVASCRIPT_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const MAX_RECIPE_BUFFER_ROWS: usize = 4_096;
const MAX_INCIDENT_BELTS: usize = 16_384;
const MAX_EXPANDED_CHANGE_COUNT: usize = 65_536;
const INVENTORY_EPSILON: f64 = 0.0001;

// Keep this boundary narrower than the full catalog. Ray receivers have a
// synchronous Dyson-allocation side effect, energy exchangers have a paired
// mode invariant, and content-pack machines do not have a proven semantic
// contract in the current protocol.
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

#[derive(Debug, Clone, PartialEq, Eq)]
struct RecipeIntent {
    entity_id: String,
    target_recipe_id: String,
}

#[derive(Debug)]
struct ValidatedRecipeTransition {
    entity_id: String,
    entity_index: usize,
    before_entity: Value,
    target_recipe_id: String,
}

fn exact_intent_path(path: &[PathSegment]) -> bool {
    matches!(
        path,
        [PathSegment::Key(root), PathSegment::Key(leaf)]
            if root == INTENT_ROOT && leaf == INTENT_LEAF
    )
}

pub(crate) fn command_contains_intent(command: &SimulationCommandPatch) -> bool {
    command
        .top_level_changes
        .iter()
        .any(|change| exact_intent_path(&change.path))
}

fn valid_opaque_id(value: &str, maximum_bytes: usize) -> bool {
    !value.is_empty() && value.len() <= maximum_bytes && !value.chars().any(char::is_control)
}

fn require_intent(command: &SimulationCommandPatch) -> anyhow::Result<RecipeIntent> {
    if command.top_level_changes.len() != 1
        || !command.changed_entities.is_empty()
        || !command.added_entities.is_empty()
        || !command.removed_entity_ids.is_empty()
        || !command.changed_belts.is_empty()
        || !command.added_belts.is_empty()
        || !command.removed_belt_ids.is_empty()
    {
        bail!("native player-authority recipe intent shape is invalid")
    }
    let change = &command.top_level_changes[0];
    if !exact_intent_path(&change.path) || change.operation != "set" {
        bail!("native player-authority recipe intent path is invalid")
    }
    let intent = change
        .value
        .as_ref()
        .and_then(Value::as_object)
        .filter(|intent| {
            intent.len() == 2
                && intent.contains_key("entityId")
                && intent.contains_key("targetRecipeId")
        })
        .ok_or_else(|| anyhow!("native player-authority recipe intent is invalid"))?;
    let entity_id = intent
        .get("entityId")
        .and_then(Value::as_str)
        .filter(|value| valid_opaque_id(value, MAX_OPAQUE_ENTITY_ID_BYTES))
        .ok_or_else(|| anyhow!("native player-authority recipe entity ID is invalid"))?;
    let target_recipe_id = intent
        .get("targetRecipeId")
        .and_then(Value::as_str)
        .filter(|value| valid_opaque_id(value, MAX_CATALOG_ID_BYTES))
        .ok_or_else(|| anyhow!("native player-authority target recipe ID is invalid"))?;
    Ok(RecipeIntent {
        entity_id: entity_id.to_owned(),
        target_recipe_id: target_recipe_id.to_owned(),
    })
}

pub(crate) fn validate_resume_marker(command: &SimulationCommandPatch) -> anyhow::Result<String> {
    require_intent(command).map(|intent| intent.entity_id)
}

fn safe_positive_integer(value: Option<&Value>, label: &str) -> anyhow::Result<u64> {
    value
        .and_then(Value::as_u64)
        .filter(|value| *value > 0 && *value <= MAX_JAVASCRIPT_SAFE_INTEGER)
        .ok_or_else(|| anyhow!("native player-authority recipe {label} is invalid"))
}

fn finite_nonnegative(value: Option<&Value>, label: &str) -> anyhow::Result<f64> {
    value
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite() && *value >= 0.0)
        .ok_or_else(|| anyhow!("native player-authority recipe {label} is invalid"))
}

fn validate_buffer(state: &CoreState, value: Option<&Value>, label: &str) -> anyhow::Result<()> {
    let buffer = value
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("native player-authority recipe {label} is invalid"))?;
    if buffer.len() > MAX_RECIPE_BUFFER_ROWS {
        bail!("native player-authority recipe {label} source limit is exceeded")
    }
    for (item_id, amount) in buffer {
        if !state.catalog.items.contains_key(item_id) {
            bail!("native player-authority recipe {label} item is unknown")
        }
        finite_nonnegative(Some(amount), label)?;
    }
    Ok(())
}

fn validate_bonus_progress(state: &CoreState, value: Option<&Value>) -> anyhow::Result<()> {
    let Some(value) = value else {
        return Ok(());
    };
    let progress = value.as_object().ok_or_else(|| {
        anyhow!("native player-authority recipe proliferator progress is invalid")
    })?;
    if progress.len() > MAX_RECIPE_BUFFER_ROWS {
        bail!("native player-authority recipe proliferator progress source limit is exceeded")
    }
    for (item_id, amount) in progress {
        if !state.catalog.items.contains_key(item_id) {
            bail!("native player-authority recipe proliferator item is unknown")
        }
        finite_nonnegative(Some(amount), "proliferator progress")?;
    }
    Ok(())
}

fn validated_transition(
    state: &CoreState,
    command: &SimulationCommandPatch,
) -> anyhow::Result<ValidatedRecipeTransition> {
    let intent = require_intent(command)?;
    if state.catalog.snapshot.registry_fingerprint != EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT
        || state.identity.registry_fingerprint != EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT
    {
        bail!("native player-authority recipe intents require the built-in catalog")
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
                .any(|planet| planet.id == *planet_id && planet.kind == "terrestrial")
        })
        .ok_or_else(|| anyhow!("native player-authority recipe active planet is invalid"))?;
    let entity_index = *state
        .entity_index
        .get(&intent.entity_id)
        .ok_or_else(|| anyhow!("native player-authority recipe entity is missing"))?;
    let before_entity = state.parse_entity(entity_index)?;
    let entity = before_entity
        .as_object()
        .ok_or_else(|| anyhow!("native player-authority recipe entity is invalid"))?;
    if entity.get("kind").and_then(Value::as_str) != Some("machine")
        || entity.get("planetId").and_then(Value::as_str) != Some(active_planet_id)
    {
        bail!("native player-authority recipe target is not an active-planet machine")
    }
    if entity
        .get("interactionLocked")
        .is_some_and(|locked| locked.as_bool() != Some(false))
    {
        bail!("native player-authority recipe target is locked or malformed")
    }
    let building_id = entity
        .get("buildingId")
        .and_then(Value::as_str)
        .filter(|building_id| BUILTIN_ORDINARY_RECIPE_BUILDINGS.contains(building_id))
        .ok_or_else(|| anyhow!("native player-authority recipe building domain is not covered"))?;
    let building = state
        .catalog
        .buildings
        .get(building_id)
        .filter(|building| building.kind == "machine")
        .ok_or_else(|| anyhow!("native player-authority recipe building catalog is invalid"))?;
    let recipe_base = recipe_building_base(building_id, building.family.as_deref());
    let target_recipe = state
        .catalog
        .recipes
        .get(&intent.target_recipe_id)
        .filter(|recipe| recipe.building_id == recipe_base)
        .ok_or_else(|| {
            anyhow!("native player-authority recipe is not supported by the building")
        })?;
    if let Some(technology_id) = target_recipe.required_tech_id.as_deref()
        && (!state.catalog.technologies.contains_key(technology_id)
            || !technology_is_completed(state, technology_id))
    {
        bail!("native player-authority recipe technology is locked or missing")
    }
    if let Some(current) = entity.get("recipeId").filter(|value| !value.is_null()) {
        let current = current
            .as_str()
            .ok_or_else(|| anyhow!("native player-authority current recipe ID is invalid"))?;
        if current == intent.target_recipe_id {
            bail!("native player-authority recipe target is unchanged")
        }
        if state
            .catalog
            .recipes
            .get(current)
            .is_none_or(|recipe| recipe.building_id != recipe_base)
        {
            bail!("native player-authority current recipe is invalid for the building")
        }
    }
    safe_positive_integer(entity.get("machineCount"), "machine count")?;
    validate_buffer(state, entity.get("inputs"), "input inventory")?;
    validate_buffer(state, entity.get("outputs"), "output inventory")?;
    finite_nonnegative(entity.get("progress"), "production progress")?;
    validate_bonus_progress(state, entity.get("proliferatorBonusProgress"))?;

    Ok(ValidatedRecipeTransition {
        entity_id: intent.entity_id,
        entity_index,
        before_entity,
        target_recipe_id: intent.target_recipe_id,
    })
}

fn add_inventory_refund(
    base: &mut Map<String, Value>,
    item_id: &str,
    amount: &Value,
) -> anyhow::Result<()> {
    let amount = finite_nonnegative(Some(amount), "inventory refund")?;
    let target = if matches!(item_id, "logistics_drone" | "logistics_vessel") {
        base.entry("portableFleet".to_owned())
            .or_insert_with(|| serde_json::json!({ "logistics_drone": 0, "logistics_vessel": 0 }))
            .as_object_mut()
            .ok_or_else(|| anyhow!("native player-authority recipe portable fleet is invalid"))?
    } else {
        base.get_mut("tray")
            .and_then(Value::as_object_mut)
            .ok_or_else(|| anyhow!("native player-authority recipe tray is invalid"))?
    };
    let current = match target.get(item_id) {
        None | Some(Value::Null) => 0.0,
        Some(value) => finite_nonnegative(Some(value), "refund target inventory")?,
    };
    let next = (current + amount + INVENTORY_EPSILON).floor();
    if !next.is_finite() || next > MAX_JAVASCRIPT_SAFE_INTEGER as f64 {
        bail!("native player-authority recipe inventory refund overflows")
    }
    target.insert(item_id.to_owned(), Value::from(next as u64));
    Ok(())
}

pub(crate) fn validate_command(
    state: &CoreState,
    command: &SimulationCommandPatch,
) -> anyhow::Result<()> {
    expand_intent(state, command).map(|_| ())
}

pub(crate) fn expand_intent(
    state: &CoreState,
    command: &SimulationCommandPatch,
) -> anyhow::Result<SimulationCommandPatch> {
    let transition = validated_transition(state, command)?;
    let before_entity = transition
        .before_entity
        .as_object()
        .expect("recipe transition validated the entity object");
    let mut candidate_base = Value::Object(state.base_value().clone());
    let candidate_base_object = candidate_base
        .as_object_mut()
        .expect("the native core base is an object");
    for field in ["inputs", "outputs"] {
        for (item_id, amount) in before_entity[field]
            .as_object()
            .expect("recipe transition validated both inventories")
        {
            add_inventory_refund(candidate_base_object, item_id, amount)?;
        }
    }

    let mut removed_belt_ids = Vec::new();
    let mut belt_refunds = BTreeMap::<&'static str, u64>::new();
    for (incident_index, belt_index) in state
        .incident_belt_indices(transition.entity_index)
        .enumerate()
    {
        if incident_index >= MAX_INCIDENT_BELTS {
            bail!("native player-authority recipe incident belt source limit is exceeded")
        }
        let belt = state.parse_belt(belt_index)?;
        let belt = belt
            .as_object()
            .ok_or_else(|| anyhow!("native player-authority recipe incident belt is invalid"))?;
        if belt.get("source").and_then(Value::as_str) != Some(&transition.entity_id)
            && belt.get("target").and_then(Value::as_str) != Some(&transition.entity_id)
        {
            bail!("native player-authority recipe belt adjacency is inconsistent")
        }
        let belt_id = belt
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow!("native player-authority recipe incident belt ID is invalid"))?;
        let lanes = safe_positive_integer(belt.get("lanes"), "incident belt lanes")?;
        let tier: u8 = safe_positive_integer(belt.get("tier"), "incident belt tier")?
            .try_into()
            .map_err(|_| anyhow!("native player-authority recipe incident belt tier is invalid"))?;
        let construction_id = builtin_belt_construction_id(state, tier)?;
        let refund = belt_refunds.entry(construction_id).or_default();
        *refund = refund
            .checked_add(lanes)
            .filter(|value| *value <= MAX_JAVASCRIPT_SAFE_INTEGER)
            .ok_or_else(|| anyhow!("native player-authority recipe belt refund overflows"))?;
        removed_belt_ids.push(belt_id.to_owned());
    }
    let construction = candidate_base_object
        .get_mut("construction")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| {
            anyhow!("native player-authority recipe construction inventory is invalid")
        })?;
    for (construction_id, refund) in belt_refunds {
        let current = normalized_construction_inventory(construction.get(construction_id))?;
        let next = current
            .checked_add(refund)
            .filter(|value| *value <= MAX_JAVASCRIPT_SAFE_INTEGER)
            .ok_or_else(|| anyhow!("native player-authority recipe belt refund overflows"))?;
        construction.insert(construction_id.to_owned(), Value::from(next));
    }

    let mut candidate_entity = transition.before_entity.clone();
    let candidate_entity_object = candidate_entity
        .as_object_mut()
        .expect("recipe transition validated the entity object");
    candidate_entity_object.insert("inputs".to_owned(), Value::Object(Map::new()));
    candidate_entity_object.insert("outputs".to_owned(), Value::Object(Map::new()));
    candidate_entity_object.insert("progress".to_owned(), Value::from(0));
    candidate_entity_object.insert(
        "proliferatorBonusProgress".to_owned(),
        Value::Object(Map::new()),
    );
    candidate_entity_object.insert(
        "recipeId".to_owned(),
        Value::from(transition.target_recipe_id),
    );

    let mut top_level_changes = Vec::new();
    create_expected_value_patches(
        &Value::Object(state.base_value().clone()),
        &candidate_base,
        Vec::new(),
        &mut top_level_changes,
    );
    let mut entity_changes = Vec::new();
    create_expected_value_patches(
        &transition.before_entity,
        &candidate_entity,
        Vec::new(),
        &mut entity_changes,
    );
    if entity_changes.is_empty() {
        bail!("native player-authority recipe transition is empty")
    }
    let expanded_change_count = top_level_changes
        .len()
        .checked_add(entity_changes.len())
        .and_then(|count| count.checked_add(removed_belt_ids.len()))
        .ok_or_else(|| anyhow!("native player-authority recipe change count overflows"))?;
    if expanded_change_count > MAX_EXPANDED_CHANGE_COUNT {
        bail!("native player-authority recipe change count is invalid")
    }
    Ok(SimulationCommandPatch {
        protocol_version: command.protocol_version,
        base_revision: command.base_revision,
        top_level_changes,
        changed_entities: vec![RecordPatch {
            id: transition.entity_id,
            changes: entity_changes,
        }],
        added_entities: Vec::new(),
        removed_entity_ids: Vec::new(),
        changed_belts: Vec::new(),
        added_belts: Vec::new(),
        removed_belt_ids,
    })
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use crate::{
        CoreCheckpointIdentity,
        catalog::{CatalogSnapshot, RuntimeCatalog},
        command::ValuePatch,
    };

    fn test_catalog() -> RuntimeCatalog {
        let snapshot: CatalogSnapshot = serde_json::from_value(serde_json::json!({
            "protocolVersion": crate::CORE_PROTOCOL_VERSION,
            "registryFingerprint": EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT,
            "planets": [
                { "id": "home", "systemId": "helios", "kind": "terrestrial", "orbitIndex": 1 },
                { "id": "away", "systemId": "helios", "kind": "terrestrial", "orbitIndex": 2 }
            ],
            "items": [
                { "id": "iron_ore", "kind": "solid" },
                { "id": "copper_ore", "kind": "solid" },
                { "id": "iron_ingot", "kind": "solid" },
                { "id": "copper_ingot", "kind": "solid" },
                { "id": "logistics_drone", "kind": "solid" },
                { "id": "electromagnetic_matrix", "kind": "matrix" }
            ],
            "buildings": [
                {
                    "id": "arc_smelter", "kind": "machine", "speed": 1,
                    "inputCapacity": 100, "outputCapacity": 100
                },
                {
                    "id": "plane_smelter", "kind": "machine", "family": "smelter", "speed": 2,
                    "inputCapacity": 200, "outputCapacity": 200
                },
                {
                    "id": "ray_receiver", "kind": "machine", "speed": 1,
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
                    "id": "copper_ingot", "buildingId": "arc_smelter", "duration": 1,
                    "requiredTechId": "smelting",
                    "inputs": [{ "itemId": "copper_ore", "amount": 1 }],
                    "outputs": [{ "itemId": "copper_ingot", "amount": 1 }]
                },
                {
                    "id": "ray_power", "buildingId": "ray_receiver", "duration": 1,
                    "inputs": [], "outputs": []
                }
            ],
            "constructions": [
                {
                    "id": "conveyor_belt_mk1", "outputAmount": 3,
                    "costs": [{ "itemId": "iron_ingot", "amount": 2 }]
                },
                {
                    "id": "conveyor_belt_mk2", "outputAmount": 3,
                    "costs": [{ "itemId": "iron_ingot", "amount": 2 }]
                }
            ],
            "belts": [
                { "tier": 1, "speed": 6 },
                { "tier": 2, "speed": 12 }
            ],
            "technologies": [{
                "id": "smelting",
                "costs": [{ "itemId": "electromagnetic_matrix", "amount": 1 }],
                "prerequisites": []
            }]
        }))
        .unwrap();
        RuntimeCatalog::validate(snapshot, EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT).unwrap()
    }

    fn machine_entity(
        id: &str,
        planet_id: &str,
        building_id: &str,
        recipe_id: &str,
        x: f64,
    ) -> String {
        serde_json::json!({
            "id": id,
            "kind": "machine",
            "planetId": planet_id,
            "position": { "x": x, "y": 2 },
            "interactionLocked": false,
            "buildingId": building_id,
            "powerGridId": "grid-a",
            "powerPriority": 2,
            "recipeId": recipe_id,
            "machineCount": 1,
            "minerCount": 0,
            "inputs": {},
            "outputs": {},
            "progress": 0,
            "routingCursor": 0,
            "utilization": 0,
            "productionRate": 0
        })
        .to_string()
    }

    fn belt(id: &str, source: &str, target: &str, lanes: u64, tier: u8) -> String {
        serde_json::json!({
            "id": id,
            "planetId": "home",
            "source": source,
            "target": target,
            "itemId": "iron_ore",
            "lanes": lanes,
            "tier": tier,
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

    fn test_state() -> CoreState {
        let base = serde_json::json!({
            "version": 47,
            "mode": "normal",
            "activePlanetId": "home",
            "elapsedSeconds": 10,
            "paused": false,
            "tray": {
                "iron_ore": 10,
                "iron_ingot": 5
            },
            "portableFleet": {
                "logistics_drone": 4,
                "logistics_vessel": 0
            },
            "construction": {
                "conveyor_belt_mk1": 5,
                "conveyor_belt_mk2": 10
            },
            "research": {
                "completedTechIds": ["smelting"]
            }
        })
        .as_object()
        .unwrap()
        .clone();
        let mut target = serde_json::from_str::<Value>(&machine_entity(
            "smelter-main",
            "home",
            "plane_smelter",
            "iron_ingot",
            5.0,
        ))
        .unwrap();
        target["inputs"] = serde_json::json!({
            "iron_ore": 1.75,
            "logistics_drone": 2
        });
        target["outputs"] = serde_json::json!({ "iron_ingot": 2.25 });
        target["progress"] = Value::from(0.75);
        target["proliferatorBonusProgress"] = serde_json::json!({ "iron_ingot": 0.5 });
        CoreState::from_public_v47_parts(
            CoreCheckpointIdentity {
                slot: "normal-main".to_owned(),
                generation: 1,
                root_hash: "a".repeat(64),
                revision: 7,
                state_version: 47,
                mode: "normal".to_owned(),
                registry_fingerprint: EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT.to_owned(),
                base_primary_checksum: "12345678".to_owned(),
            },
            base,
            vec![
                machine_entity("smelter-feed", "home", "arc_smelter", "iron_ingot", 1.0),
                target.to_string(),
                machine_entity("smelter-sink", "home", "arc_smelter", "iron_ingot", 9.0),
                machine_entity("smelter-away", "away", "arc_smelter", "iron_ingot", 13.0),
                machine_entity("receiver-home", "home", "ray_receiver", "ray_power", 17.0),
            ],
            vec![
                // Deliberately reverse lexical ID order. The expansion must
                // preserve authoritative persisted belt order.
                belt("belt-z", "smelter-feed", "smelter-main", 2, 1),
                belt("belt-a", "smelter-main", "smelter-sink", 3, 2),
            ],
            test_catalog(),
        )
        .unwrap()
    }

    fn intent(revision: u64, entity_id: &str, target_recipe_id: &str) -> SimulationCommandPatch {
        SimulationCommandPatch {
            protocol_version: crate::CORE_PROTOCOL_VERSION,
            base_revision: revision,
            top_level_changes: vec![ValuePatch {
                path: vec![
                    PathSegment::Key(INTENT_ROOT.to_owned()),
                    PathSegment::Key(INTENT_LEAF.to_owned()),
                ],
                operation: "set".to_owned(),
                value: Some(serde_json::json!({
                    "entityId": entity_id,
                    "targetRecipeId": target_recipe_id
                })),
            }],
            changed_entities: Vec::new(),
            added_entities: Vec::new(),
            removed_entity_ids: Vec::new(),
            changed_belts: Vec::new(),
            added_belts: Vec::new(),
            removed_belt_ids: Vec::new(),
        }
    }

    fn entity(state: &CoreState, id: &str) -> Value {
        state
            .parse_entity(*state.entity_index.get(id).unwrap())
            .unwrap()
    }

    fn replace_entity(state: &mut CoreState, id: &str, update: impl FnOnce(&mut Value)) {
        let index = *state.entity_index.get(id).unwrap();
        let mut value = state.parse_entity(index).unwrap();
        update(&mut value);
        state.replace_entity_raw(
            index,
            Arc::<str>::from(serde_json::to_string(&value).unwrap()),
        );
    }

    fn assert_rejected_without_mutation(state: &mut CoreState, command: &SimulationCommandPatch) {
        let revision = state.revision;
        let source_hash = state.canonical_sha256().unwrap();
        assert!(state.apply_player_authority_command(command).is_err());
        assert_eq!(state.revision, revision);
        assert_eq!(state.canonical_sha256().unwrap(), source_hash);
    }

    #[test]
    fn recipe_intent_matches_js_refunds_and_is_identical_for_live_and_wal_replay() {
        let mut live = test_state();
        let mut replay = live.clone();
        let command = intent(live.revision, "smelter-main", "copper_ingot");

        let expanded = expand_intent(&live, &command).unwrap();
        assert_eq!(expanded.removed_belt_ids, ["belt-z", "belt-a"]);
        assert_eq!(expanded.changed_entities.len(), 1);
        assert_eq!(expanded.changed_entities[0].id, "smelter-main");

        let live_receipt = live.apply_player_authority_command(&command).unwrap();
        let replay_receipt = replay.apply_command(&command).unwrap();
        assert_eq!(live_receipt, replay_receipt);
        assert_eq!(live_receipt.previous_revision, 7);
        assert_eq!(live_receipt.revision, 8);
        assert_eq!(live_receipt.changed_entity_ids, ["smelter-main"]);
        assert!(live_receipt.changed_belt_ids.is_empty());
        assert!(live_receipt.topology_dirty);
        assert_eq!(
            live.canonical_sha256().unwrap(),
            replay.canonical_sha256().unwrap()
        );

        let target = entity(&live, "smelter-main");
        assert_eq!(target["recipeId"], "copper_ingot");
        assert_eq!(target["inputs"], serde_json::json!({}));
        assert_eq!(target["outputs"], serde_json::json!({}));
        assert_eq!(target["progress"], 0);
        assert_eq!(target["proliferatorBonusProgress"], serde_json::json!({}));
        assert_eq!(live.base_value()["tray"]["iron_ore"], 11);
        assert_eq!(live.base_value()["tray"]["iron_ingot"], 7);
        assert_eq!(live.base_value()["portableFleet"]["logistics_drone"], 6);
        assert_eq!(live.base_value()["construction"]["conveyor_belt_mk1"], 7);
        assert_eq!(live.base_value()["construction"]["conveyor_belt_mk2"], 13);
        assert_eq!(live.belt_index.len(), 0);

        let recovered = live
            .deterministic_player_authority_resume_result(&command, 7, 8)
            .unwrap();
        assert_eq!(recovered.changed_entity_ids, ["smelter-main"]);
        assert!(recovered.topology_dirty);
    }

    #[test]
    fn recipe_intent_compacts_an_oversized_incident_belt_id_for_live_and_generic_apply() {
        let mut live = test_state();
        let oversized_belt_id = "b".repeat(513);
        let belt_index = *live.belt_index.get("belt-z").unwrap();
        let mut oversized_belt = live.parse_belt(belt_index).unwrap();
        oversized_belt["id"] = Value::from(oversized_belt_id.clone());
        live.replace_belt_raw(
            belt_index,
            Arc::<str>::from(serde_json::to_string(&oversized_belt).unwrap()),
        );
        live.rebuild_indexes().unwrap();
        let mut generic = live.clone();
        let command = intent(live.revision, "smelter-main", "copper_ingot");

        let live_receipt = live.apply_player_authority_command(&command).unwrap();
        let generic_receipt = generic.apply_command(&command).unwrap();
        assert_eq!(live_receipt, generic_receipt);
        assert_eq!(live_receipt.changed_entity_ids, ["smelter-main"]);
        assert!(live_receipt.changed_belt_ids.is_empty());
        assert!(live_receipt.topology_dirty);
        assert!(live.belt_index.is_empty());
        assert_eq!(
            live.canonical_sha256().unwrap(),
            generic.canonical_sha256().unwrap()
        );
    }

    #[test]
    fn recipe_intent_rejects_stale_cross_planet_locked_special_locked_tech_and_mixed_shapes() {
        let mut stale = test_state();
        assert_rejected_without_mutation(&mut stale, &intent(6, "smelter-main", "copper_ingot"));

        let mut away = test_state();
        let command = intent(away.revision, "smelter-away", "copper_ingot");
        assert_rejected_without_mutation(&mut away, &command);

        let mut locked = test_state();
        replace_entity(&mut locked, "smelter-main", |entity| {
            entity["interactionLocked"] = Value::Bool(true);
        });
        let command = intent(locked.revision, "smelter-main", "copper_ingot");
        assert_rejected_without_mutation(&mut locked, &command);

        let mut special = test_state();
        let command = intent(special.revision, "receiver-home", "ray_power");
        assert_rejected_without_mutation(&mut special, &command);

        let mut locked_technology = test_state();
        locked_technology.base_value_mut()["research"]["completedTechIds"] = serde_json::json!([]);
        let command = intent(locked_technology.revision, "smelter-main", "copper_ingot");
        assert_rejected_without_mutation(&mut locked_technology, &command);

        let mut unchanged = test_state();
        let command = intent(unchanged.revision, "smelter-main", "iron_ingot");
        assert_rejected_without_mutation(&mut unchanged, &command);

        let mut wrong_building_recipe = test_state();
        let command = intent(wrong_building_recipe.revision, "smelter-main", "ray_power");
        assert_rejected_without_mutation(&mut wrong_building_recipe, &command);

        let mut unknown_recipe = test_state();
        let command = intent(unknown_recipe.revision, "smelter-main", "future_recipe");
        assert_rejected_without_mutation(&mut unknown_recipe, &command);

        let mut content_pack_identity = test_state();
        content_pack_identity.identity.registry_fingerprint = "pack:enabled".to_owned();
        let command = intent(
            content_pack_identity.revision,
            "smelter-main",
            "copper_ingot",
        );
        assert_rejected_without_mutation(&mut content_pack_identity, &command);

        let mut mixed = test_state();
        let mut command = intent(mixed.revision, "smelter-main", "copper_ingot");
        command.changed_entities.push(RecordPatch {
            id: "smelter-main".to_owned(),
            changes: vec![ValuePatch {
                path: vec![PathSegment::Key("recipeId".to_owned())],
                operation: "set".to_owned(),
                value: Some(Value::from("copper_ingot")),
            }],
        });
        assert_rejected_without_mutation(&mut mixed, &command);

        let mut extra_intent_field = test_state();
        let mut command = intent(extra_intent_field.revision, "smelter-main", "copper_ingot");
        command.top_level_changes[0].value.as_mut().unwrap()["rendererRefund"] = Value::from(999);
        assert_rejected_without_mutation(&mut extra_intent_field, &command);
    }

    #[test]
    fn recipe_refund_overflow_and_malformed_buffers_fail_atomically_for_live_and_replay() {
        let mut tray_overflow = test_state();
        tray_overflow.base_value_mut()["tray"]["iron_ore"] =
            Value::from(MAX_JAVASCRIPT_SAFE_INTEGER);
        let command = intent(tray_overflow.revision, "smelter-main", "copper_ingot");
        assert_rejected_without_mutation(&mut tray_overflow, &command);

        let mut belt_overflow = test_state();
        belt_overflow.base_value_mut()["construction"]["conveyor_belt_mk1"] =
            Value::from(MAX_JAVASCRIPT_SAFE_INTEGER);
        let command = intent(belt_overflow.revision, "smelter-main", "copper_ingot");
        assert_rejected_without_mutation(&mut belt_overflow, &command);

        let mut negative = test_state();
        replace_entity(&mut negative, "smelter-main", |entity| {
            entity["outputs"]["iron_ingot"] = Value::from(-1);
        });
        let command = intent(negative.revision, "smelter-main", "copper_ingot");
        assert_rejected_without_mutation(&mut negative, &command);

        let mut generic_replay = test_state();
        generic_replay.base_value_mut()["tray"]["iron_ore"] =
            Value::from(MAX_JAVASCRIPT_SAFE_INTEGER);
        let revision = generic_replay.revision;
        let source_hash = generic_replay.canonical_sha256().unwrap();
        let command = intent(revision, "smelter-main", "copper_ingot");
        assert!(generic_replay.apply_command(&command).is_err());
        assert_eq!(generic_replay.revision, revision);
        assert_eq!(generic_replay.canonical_sha256().unwrap(), source_hash);
    }
}
