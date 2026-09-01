//! One durable semantic transaction for continuous/batch ordinary belts.
//!
//! The renderer owns only the gesture preview.  Its WAL marker contains the
//! ordered endpoint/item/tier/lane requests and never contains generated IDs,
//! construction balances, defaults, or a copied belt record.  Rust rechecks
//! every request against the current catalog and topology, aggregates material
//! debits, allocates stable IDs, and either commits the whole batch or nothing.

use std::collections::{BTreeMap, HashSet};

use anyhow::{anyhow, bail};
use serde_json::Value;

use crate::{
    command::{AddedRecord, PathSegment, SimulationCommandPatch, ValuePatch},
    construction_belt_placement_context,
    state::CoreState,
};

const INTENT_ROOT: &str = "factoryBeltBatch";
const INTENT_LEAF: &str = "intent";
const MAX_REQUESTS: usize = 1_024;
const MAX_OPAQUE_ID_BYTES: usize = 512;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Debug, Clone)]
struct BeltRequest {
    source_id: String,
    target_id: String,
    item_id: String,
    tier: u8,
    lanes: u64,
}

fn exact_path(path: &[PathSegment]) -> bool {
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
        .any(|change| exact_path(&change.path))
}

fn valid_opaque_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= MAX_OPAQUE_ID_BYTES && !value.chars().any(char::is_control)
}

fn required_id<'a>(
    object: &'a serde_json::Map<String, Value>,
    key: &str,
) -> anyhow::Result<&'a str> {
    object
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| valid_opaque_id(value))
        .ok_or_else(|| anyhow!("native factory belt batch {key} is invalid"))
}

fn parse_requests(command: &SimulationCommandPatch) -> anyhow::Result<Vec<BeltRequest>> {
    if command.top_level_changes.len() != 1
        || !command.changed_entities.is_empty()
        || !command.added_entities.is_empty()
        || !command.removed_entity_ids.is_empty()
        || !command.changed_belts.is_empty()
        || !command.added_belts.is_empty()
        || !command.removed_belt_ids.is_empty()
    {
        bail!("native factory belt batch intent shape is invalid")
    }
    let change = &command.top_level_changes[0];
    if !exact_path(&change.path) || change.operation != "set" {
        bail!("native factory belt batch intent path is invalid")
    }
    let value = change
        .value
        .as_ref()
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("native factory belt batch intent is invalid"))?;
    if value.keys().any(|key| key != "requests") {
        bail!("native factory belt batch intent fields are invalid")
    }
    let values = value
        .get("requests")
        .and_then(Value::as_array)
        .filter(|requests| !requests.is_empty() && requests.len() <= MAX_REQUESTS)
        .ok_or_else(|| anyhow!("native factory belt batch request count is invalid"))?;
    let mut route_keys = HashSet::with_capacity(values.len());
    let mut requests = Vec::with_capacity(values.len());
    for value in values {
        let object = value
            .as_object()
            .ok_or_else(|| anyhow!("native factory belt batch request is invalid"))?;
        if object.keys().any(|key| {
            !matches!(
                key.as_str(),
                "sourceId" | "targetId" | "itemId" | "tier" | "lanes"
            )
        }) {
            bail!("native factory belt batch request fields are invalid")
        }
        let source_id = required_id(object, "sourceId")?.to_owned();
        let target_id = required_id(object, "targetId")?.to_owned();
        let item_id = required_id(object, "itemId")?.to_owned();
        let tier = object
            .get("tier")
            .and_then(Value::as_u64)
            .and_then(|value| u8::try_from(value).ok())
            .filter(|value| *value > 0)
            .ok_or_else(|| anyhow!("native factory belt batch tier is invalid"))?;
        let lanes = object
            .get("lanes")
            .and_then(Value::as_u64)
            .filter(|value| (1..=4_096).contains(value))
            .ok_or_else(|| anyhow!("native factory belt batch lanes are invalid"))?;
        let route_key = (source_id.clone(), target_id.clone(), item_id.clone());
        if !route_keys.insert(route_key) {
            bail!("native factory belt batch repeats an ordinary route")
        }
        requests.push(BeltRequest {
            source_id,
            target_id,
            item_id,
            tier,
            lanes,
        });
    }
    Ok(requests)
}

pub(crate) fn validate_resume_marker(command: &SimulationCommandPatch) -> anyhow::Result<()> {
    parse_requests(command).map(|_| ())
}

fn safe_integer(value: Option<&Value>, label: &str) -> anyhow::Result<u64> {
    value
        .and_then(Value::as_u64)
        .filter(|value| *value <= MAX_SAFE_INTEGER)
        .ok_or_else(|| anyhow!("native factory belt batch {label} is invalid"))
}

pub(crate) fn expand_intent(
    state: &CoreState,
    command: &SimulationCommandPatch,
) -> anyhow::Result<SimulationCommandPatch> {
    if command.protocol_version != crate::CORE_PROTOCOL_VERSION {
        bail!("native factory belt batch protocol is unsupported")
    }
    if command.base_revision != state.revision {
        bail!("native factory belt batch revision is stale")
    }
    if !state.catalog.data_only_native_supported {
        bail!("native factory belt batch catalog requires scripted behavior")
    }
    let requests = parse_requests(command)?;
    let next_id = safe_integer(state.base_value().get("nextId"), "next ID")?;
    let request_count = u64::try_from(requests.len())?;
    let next_id_after = next_id
        .checked_add(request_count)
        .filter(|value| *value <= MAX_SAFE_INTEGER)
        .ok_or_else(|| anyhow!("native factory belt batch exhausts the ID range"))?;
    let construction = state
        .base_value()
        .get("construction")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("native factory belt batch construction inventory is invalid"))?;

    let mut debits = BTreeMap::<String, u64>::new();
    let mut additions = Vec::with_capacity(requests.len());
    let mut allocated_ids = HashSet::with_capacity(requests.len());
    for (offset, request) in requests.iter().enumerate() {
        let eligibility = construction_belt_placement_context::eligibility(
            state,
            &request.source_id,
            &request.target_id,
            &request.item_id,
            request.tier,
            request.lanes,
        )?;
        if let Some(reason) = eligibility.unsupported_reason {
            bail!("native factory belt batch request is unsupported: {reason}")
        }
        let construction_id = eligibility
            .construction_id
            .ok_or_else(|| anyhow!("native factory belt batch construction ID is missing"))?;
        let debit = debits.entry(construction_id).or_default();
        *debit = debit
            .checked_add(request.lanes)
            .filter(|value| *value <= MAX_SAFE_INTEGER)
            .ok_or_else(|| anyhow!("native factory belt batch construction debit overflows"))?;

        let offset = u64::try_from(offset)?;
        let id_number = next_id
            .checked_add(offset)
            .ok_or_else(|| anyhow!("native factory belt batch ID overflows"))?;
        let belt_id = format!("belt_{id_number}");
        if state.belt_index.contains_key(&belt_id) || !allocated_ids.insert(belt_id.clone()) {
            bail!("native factory belt batch ID collides with an existing row")
        }
        let mut belt = eligibility
            .belt_template
            .ok_or_else(|| anyhow!("native factory belt batch template is missing"))?;
        belt.insert("id".to_owned(), Value::from(belt_id));
        additions.push(AddedRecord {
            index: state
                .belt_index
                .len()
                .checked_add(usize::try_from(offset)?)
                .ok_or_else(|| anyhow!("native factory belt batch append index overflows"))?,
            value: Value::Object(belt),
        });
    }

    let mut top_level_changes = Vec::with_capacity(debits.len() + 1);
    for (construction_id, debit) in debits {
        let available = safe_integer(construction.get(&construction_id), "construction inventory")?;
        let remaining = available.checked_sub(debit).ok_or_else(|| {
            anyhow!("native factory belt batch construction inventory is insufficient")
        })?;
        top_level_changes.push(ValuePatch {
            path: vec![
                PathSegment::Key("construction".to_owned()),
                PathSegment::Key(construction_id),
            ],
            operation: "set".to_owned(),
            value: Some(Value::from(remaining)),
        });
    }
    top_level_changes.push(ValuePatch {
        path: vec![PathSegment::Key("nextId".to_owned())],
        operation: "set".to_owned(),
        value: Some(Value::from(next_id_after)),
    });

    Ok(SimulationCommandPatch {
        protocol_version: command.protocol_version,
        base_revision: command.base_revision,
        top_level_changes,
        changed_entities: Vec::new(),
        added_entities: Vec::new(),
        removed_entity_ids: Vec::new(),
        changed_belts: Vec::new(),
        added_belts: additions,
        removed_belt_ids: Vec::new(),
    })
}

pub(crate) fn validate_command(
    state: &CoreState,
    command: &SimulationCommandPatch,
) -> anyhow::Result<()> {
    expand_intent(state, command).map(|_| ())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::{CoreCheckpointIdentity, catalog::RuntimeCatalog};

    const REGISTRY: &str = "factory-belt-batch-test";

    fn catalog() -> RuntimeCatalog {
        RuntimeCatalog::from_value(
            json!({
                "protocolVersion": crate::CORE_PROTOCOL_VERSION,
                "registryFingerprint": REGISTRY,
                "planets": [{ "id": "home", "name": "Home", "systemId": "helios", "kind": "terrestrial", "orbitIndex": 1 }],
                "items": [{ "id": "iron_ore", "name": "Iron", "kind": "solid" }],
                "buildings": [
                    { "id": "mod_source", "name": "Source", "kind": "machine", "speed": 1, "inputCapacity": 100, "outputCapacity": 100, "stackLimit": 100, "stackLimitComplete": true },
                    { "id": "mod_target", "name": "Target", "kind": "machine", "speed": 1, "inputCapacity": 100, "outputCapacity": 100, "stackLimit": 100, "stackLimitComplete": true }
                ],
                "recipes": [
                    { "id": "source_recipe", "buildingId": "mod_source", "duration": 1, "inputs": [], "outputs": [{ "itemId": "iron_ore", "amount": 1 }] },
                    { "id": "target_recipe", "buildingId": "mod_target", "duration": 1, "inputs": [{ "itemId": "iron_ore", "amount": 1 }], "outputs": [{ "itemId": "iron_ore", "amount": 1 }] }
                ],
                "constructions": [{ "id": "mod_belt_4", "outputAmount": 1, "costs": [{ "itemId": "iron_ore", "amount": 1 }] }],
                "belts": [{ "tier": 4, "speed": 60, "id": "mod_belt_4", "constructionId": "mod_belt_4" }],
                "technologies": []
            }),
            REGISTRY,
        )
        .unwrap()
    }

    fn entity(id: &str, building_id: &str, recipe_id: &str, x: f64) -> String {
        serde_json::to_string(&json!({
            "id": id, "kind": "machine", "planetId": "home", "buildingId": building_id,
            "machineCount": 1, "recipeId": recipe_id, "interactionLocked": false,
            "inputs": {}, "outputs": {}, "progress": 0, "utilization": 0,
            "productionRate": 0, "position": { "x": x, "y": 0 }
        }))
        .unwrap()
    }

    fn state(stock: u64) -> CoreState {
        CoreState::from_public_v47_parts(
            CoreCheckpointIdentity {
                slot: "normal-main".to_owned(), generation: 1, root_hash: "a".repeat(64),
                revision: 5, state_version: 47, mode: "normal".to_owned(),
                registry_fingerprint: REGISTRY.to_owned(), base_primary_checksum: "12345678".to_owned(),
            },
            json!({
                "version": 47, "mode": "normal", "activePlanetId": "home", "elapsedSeconds": 0,
                "paused": false, "nextId": 20, "construction": { "mod_belt_4": stock },
                "research": { "completedTechIds": [] },
                "settings": { "simulationSpeed": 1, "defaultBeltStackSize": 1, "defaultBeltRouteMode": "auto" },
                "exploration": { "colonizedPlanetIds": ["home"], "unlockedSystemIds": ["helios"] }
            }).as_object().unwrap().clone(),
            vec![
                entity("source", "mod_source", "source_recipe", 0.0),
                entity("target-a", "mod_target", "target_recipe", 300.0),
                entity("target-b", "mod_target", "target_recipe", 600.0),
            ],
            Vec::new(),
            catalog(),
        ).unwrap()
    }

    fn marker(targets: &[&str]) -> SimulationCommandPatch {
        let requests = targets.iter().map(|target| json!({
            "sourceId": "source", "targetId": target, "itemId": "iron_ore", "tier": 4, "lanes": 3
        })).collect::<Vec<_>>();
        serde_json::from_value(json!({
            "protocolVersion": crate::CORE_PROTOCOL_VERSION, "baseRevision": 5,
            "topLevelChanges": [{ "path": ["factoryBeltBatch", "intent"], "operation": "set", "value": { "requests": requests } }],
            "changedEntities": [], "addedEntities": [], "removedEntityIds": [],
            "changedBelts": [], "addedBelts": [], "removedBeltIds": []
        })).unwrap()
    }

    #[test]
    fn registered_tier_batch_allocates_ids_and_debits_once() {
        let mut state = state(10);
        state
            .apply_player_authority_command(&marker(&["target-a", "target-b"]))
            .unwrap();
        assert_eq!(state.revision, 6);
        assert_eq!(state.base_value()["nextId"], 22);
        assert_eq!(state.base_value()["construction"]["mod_belt_4"], 4);
        assert_eq!(state.parse_belt(0).unwrap()["id"], "belt_20");
        assert_eq!(state.parse_belt(1).unwrap()["id"], "belt_21");
        assert_eq!(state.parse_belt(1).unwrap()["tier"], 4);
    }

    #[test]
    fn aggregate_shortage_duplicate_and_replay_are_atomic() {
        let command = marker(&["target-a", "target-b"]);
        let mut short = state(5);
        let before = short.canonical_sha256().unwrap();
        assert!(short.apply_player_authority_command(&command).is_err());
        assert_eq!(short.canonical_sha256().unwrap(), before);
        assert_eq!(short.revision, 5);

        let mut duplicate = marker(&["target-a", "target-a"]);
        assert!(
            state(20)
                .apply_player_authority_command(&duplicate)
                .is_err()
        );
        duplicate.top_level_changes[0].value.as_mut().unwrap()["requests"][1]["targetId"] =
            json!("target-b");

        let durable = serde_json::to_string(&duplicate).unwrap();
        assert!(!durable.contains("construction"));
        assert!(!durable.contains("belt_20"));
        let replay: SimulationCommandPatch = serde_json::from_str(&durable).unwrap();
        let mut live = state(20);
        let mut cold = state(20);
        live.apply_player_authority_command(&duplicate).unwrap();
        cold.apply_command(&replay).unwrap();
        assert_eq!(
            live.canonical_sha256().unwrap(),
            cold.canonical_sha256().unwrap()
        );
    }
}
