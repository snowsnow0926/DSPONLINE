//! Bounded, same-revision context for completely recycling one ordinary building.
//!
//! The projection is read-only. Durable command submission still calls the
//! same ordinary-removal eligibility helper against the current Rust revision
//! and then validates the exact construction refund patch atomically.

use anyhow::bail;
use serde_json::{Value, json};

use crate::{command::ordinary_building_removal_eligibility, state::CoreState};

const CONSTRUCTION_REMOVAL_CONTEXT_PROJECTION: &str = "construction-removal-context-v1";
const MAX_PROJECTION_BYTES: usize = 1_048_576;
const MAX_OPAQUE_ID_BYTES: usize = 512;

fn valid_opaque_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= MAX_OPAQUE_ID_BYTES && !value.chars().any(char::is_control)
}

impl CoreState {
    /// Derives a complete ordinary-building removal/refund decision without
    /// mutating the source state or copying the full entity/belt collections.
    pub fn construction_removal_context_projection(
        &self,
        expected_revision: u64,
        expected_registry_fingerprint: &str,
        entity_id: &str,
    ) -> anyhow::Result<Value> {
        if expected_revision != self.revision
            || expected_registry_fingerprint != self.catalog.snapshot.registry_fingerprint
            || !valid_opaque_id(entity_id)
        {
            bail!("native construction removal context request is invalid")
        }

        let eligibility = ordinary_building_removal_eligibility(self, entity_id)?;
        if !valid_opaque_id(&eligibility.active_planet_id)
            || !valid_opaque_id(&eligibility.entity_id)
        {
            bail!("native construction removal context identity is invalid")
        }
        let reason = eligibility.unsupported_reason;
        let value = json!({
            "schemaVersion": 1,
            "projectionType": CONSTRUCTION_REMOVAL_CONTEXT_PROJECTION,
            "source": "native-core",
            "revision": self.revision,
            "stateVersion": self.identity.state_version,
            "registryFingerprint": self.catalog.snapshot.registry_fingerprint,
            "request": {
                "expectedRevision": expected_revision,
                "expectedRegistryFingerprint": expected_registry_fingerprint,
                "entityId": entity_id,
            },
            "activePlanetId": eligibility.active_planet_id,
            "entityId": eligibility.entity_id,
            "buildingId": eligibility.building_id,
            "machineCount": eligibility.machine_count,
            "currentConstruction": eligibility.current_construction,
            "refundAfterRemoval": eligibility.refund_after_removal,
            "support": {
                "supported": reason.is_none(),
                "reason": reason,
            },
            "limits": {
                "projectionBytes": MAX_PROJECTION_BYTES,
            },
        });
        if serde_json::to_vec(&value)?.len() > MAX_PROJECTION_BYTES {
            bail!("native construction removal context exceeds the byte limit")
        }
        Ok(value)
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::{
        CORE_PROTOCOL_VERSION, CoreCheckpointIdentity,
        catalog::{CatalogSnapshot, RuntimeCatalog},
        command::SimulationCommandPatch,
    };

    const REGISTRY: &str = "construction-removal-test";
    const MAX_JAVASCRIPT_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

    fn catalog() -> RuntimeCatalog {
        let snapshot: CatalogSnapshot = serde_json::from_value(json!({
            "protocolVersion": CORE_PROTOCOL_VERSION,
            "registryFingerprint": REGISTRY,
            "planets": [
                { "id": "home", "systemId": "helios", "kind": "terrestrial", "orbitIndex": 1 },
                { "id": "other", "systemId": "helios", "kind": "terrestrial", "orbitIndex": 2 }
            ],
            "items": [{ "id": "iron_ingot", "kind": "solid" }],
            "buildings": [
                { "id": "arc_smelter", "kind": "machine", "speed": 1, "inputCapacity": 10, "outputCapacity": 10 },
                { "id": "MOD/custom-machine", "kind": "machine", "speed": 1, "inputCapacity": 10, "outputCapacity": 10 },
                { "id": "missing_construction", "kind": "machine", "speed": 1, "inputCapacity": 10, "outputCapacity": 10 },
                { "id": "mining_machine", "kind": "miner", "speed": 1, "inputCapacity": 0, "outputCapacity": 10 },
                { "id": "interstellar_logistics_station", "kind": "station", "speed": 1, "inputCapacity": 10, "outputCapacity": 10 },
                { "id": "construction_center", "kind": "machine", "speed": 1, "inputCapacity": 10, "outputCapacity": 10 }
            ],
            "recipes": [],
            "constructions": [
                { "id": "arc_smelter", "outputAmount": 1, "costs": [{ "itemId": "iron_ingot", "amount": 1 }] },
                { "id": "MOD/custom-machine", "outputAmount": 1, "costs": [{ "itemId": "iron_ingot", "amount": 1 }] },
                { "id": "mining_machine", "outputAmount": 1, "costs": [{ "itemId": "iron_ingot", "amount": 1 }] },
                { "id": "interstellar_logistics_station", "outputAmount": 1, "costs": [{ "itemId": "iron_ingot", "amount": 1 }] },
                { "id": "construction_center", "outputAmount": 1, "costs": [{ "itemId": "iron_ingot", "amount": 1 }] }
            ],
            "belts": [{ "tier": 1, "speed": 6 }],
            "technologies": []
        }))
        .unwrap();
        RuntimeCatalog::validate(snapshot, REGISTRY).unwrap()
    }

    fn ordinary_entity(entity_id: &str, building_id: &str) -> Value {
        json!({
            "id": entity_id,
            "kind": "machine",
            "planetId": "home",
            "interactionLocked": false,
            "buildingId": building_id,
            "machineCount": 2,
            "inputs": {},
            "outputs": {}
        })
    }

    fn fixture_state(
        entity: Option<Value>,
        construction: Option<Value>,
        belts: Vec<Value>,
        construction_queue: Value,
        blueprint_versions: Value,
    ) -> CoreState {
        let mut base = json!({
            "version": 47,
            "mode": "normal",
            "activePlanetId": "home",
            "elapsedSeconds": 10,
            "paused": false,
            "research": { "completedTechIds": [] },
            "settings": { "simulationSpeed": 1 },
            "exploration": { "colonizedPlanetIds": ["home"], "unlockedSystemIds": ["helios"] },
            "constructionQueue": construction_queue,
            "blueprintVersions": blueprint_versions
        })
        .as_object()
        .unwrap()
        .clone();
        if let Some(construction) = construction {
            base.insert("construction".to_owned(), construction);
        }
        CoreState::from_public_v47_parts(
            CoreCheckpointIdentity {
                slot: "normal-main".to_owned(),
                generation: 1,
                root_hash: "a".repeat(64),
                revision: 7,
                state_version: 47,
                mode: "normal".to_owned(),
                registry_fingerprint: REGISTRY.to_owned(),
                base_primary_checksum: "12345678".to_owned(),
            },
            base,
            entity
                .into_iter()
                .map(|value| serde_json::to_string(&value).unwrap())
                .collect(),
            belts
                .into_iter()
                .map(|value| serde_json::to_string(&value).unwrap())
                .collect(),
            catalog(),
        )
        .unwrap()
    }

    fn basic_state(entity: Option<Value>, construction: Option<Value>) -> CoreState {
        fixture_state(entity, construction, Vec::new(), json!([]), json!([]))
    }

    fn removal_command(projection: &Value) -> SimulationCommandPatch {
        serde_json::from_value(json!({
            "protocolVersion": CORE_PROTOCOL_VERSION,
            "baseRevision": projection["revision"],
            "topLevelChanges": [{
                "path": ["construction", projection["buildingId"]],
                "operation": "set",
                "value": projection["refundAfterRemoval"]
            }],
            "changedEntities": [],
            "addedEntities": [],
            "removedEntityIds": [projection["entityId"]],
            "changedBelts": [],
            "addedBelts": [],
            "removedBeltIds": []
        }))
        .unwrap()
    }

    fn assert_reason(state: &CoreState, entity_id: &str, expected_reason: &str) -> Value {
        let before = state.canonical_sha256().unwrap();
        let projection = state
            .construction_removal_context_projection(7, REGISTRY, entity_id)
            .unwrap();
        assert_eq!(projection["support"]["supported"], false);
        assert_eq!(projection["support"]["reason"], expected_reason);
        assert!(projection["refundAfterRemoval"].is_null());
        assert_eq!(state.canonical_sha256().unwrap(), before);
        assert!(serde_json::to_vec(&projection).unwrap().len() <= MAX_PROJECTION_BYTES);
        projection
    }

    #[test]
    fn supported_mod_context_is_bounded_read_only_and_builds_the_atomic_command() {
        let state = basic_state(
            Some(ordinary_entity("MOD/设备-一", "MOD/custom-machine")),
            Some(json!({ "MOD/custom-machine": 4 })),
        );
        let before = state.canonical_sha256().unwrap();
        let projection = state
            .construction_removal_context_projection(7, REGISTRY, "MOD/设备-一")
            .unwrap();
        assert_eq!(
            projection["projectionType"],
            CONSTRUCTION_REMOVAL_CONTEXT_PROJECTION
        );
        assert_eq!(projection["activePlanetId"], "home");
        assert_eq!(projection["entityId"], "MOD/设备-一");
        assert_eq!(projection["buildingId"], "MOD/custom-machine");
        assert_eq!(projection["machineCount"], 2);
        assert_eq!(projection["currentConstruction"], 4);
        assert_eq!(projection["refundAfterRemoval"], 6);
        assert_eq!(
            projection["support"],
            json!({ "supported": true, "reason": null })
        );
        state
            .validate_player_authority_command(&removal_command(&projection))
            .unwrap();
        assert_eq!(state.canonical_sha256().unwrap(), before);
        assert!(serde_json::to_vec(&projection).unwrap().len() <= MAX_PROJECTION_BYTES);

        let mut forged = removal_command(&projection);
        forged.top_level_changes[0].value = Some(Value::from(7));
        assert!(state.validate_player_authority_command(&forged).is_err());

        let mut buffered = ordinary_entity("MOD/设备-一", "MOD/custom-machine");
        buffered["outputs"] = json!({ "iron_ingot": 1 });
        let blocked_same_revision =
            basic_state(Some(buffered), Some(json!({ "MOD/custom-machine": 4 })));
        assert!(
            blocked_same_revision
                .validate_player_authority_command(&removal_command(&projection))
                .is_err()
        );
    }

    #[test]
    fn unknown_unicode_and_identity_mismatches_fail_closed_without_panics() {
        let state = basic_state(None, Some(json!({ "未知/MOD-建筑": 9 })));
        let unknown = assert_reason(&state, "未知/MOD-实体", "entity-not-found");
        assert!(unknown["buildingId"].is_null());
        assert!(unknown["machineCount"].is_null());
        assert!(unknown["currentConstruction"].is_null());

        let unknown_building_state = basic_state(
            Some(ordinary_entity("未知/MOD-实体", "未知/MOD-建筑")),
            Some(json!({ "未知/MOD-建筑": 9 })),
        );
        let unknown_building =
            assert_reason(&unknown_building_state, "未知/MOD-实体", "unknown-building");
        assert_eq!(unknown_building["buildingId"], "未知/MOD-建筑");
        assert_eq!(unknown_building["machineCount"], 2);
        assert_eq!(unknown_building["currentConstruction"], 9);

        assert!(
            state
                .construction_removal_context_projection(6, REGISTRY, "未知/MOD-实体")
                .is_err()
        );
        assert!(
            state
                .construction_removal_context_projection(7, "other", "未知/MOD-实体")
                .is_err()
        );
        assert!(
            state
                .construction_removal_context_projection(7, REGISTRY, "bad\nidentifier")
                .is_err()
        );
        assert!(
            state
                .construction_removal_context_projection(7, REGISTRY, &"界".repeat(171))
                .is_err()
        );
    }

    #[test]
    fn location_lock_catalog_and_domain_boundaries_are_explicit() {
        let mut wrong_planet = ordinary_entity("entity-wrong-planet", "arc_smelter");
        wrong_planet["planetId"] = Value::from("other");
        assert_reason(
            &basic_state(Some(wrong_planet), Some(json!({ "arc_smelter": 1 }))),
            "entity-wrong-planet",
            "not-active-planet",
        );

        let mut locked = ordinary_entity("entity-locked", "arc_smelter");
        locked["interactionLocked"] = Value::from(true);
        assert_reason(
            &basic_state(Some(locked), Some(json!({ "arc_smelter": 1 }))),
            "entity-locked",
            "interaction-locked",
        );

        assert_reason(
            &basic_state(
                Some(ordinary_entity(
                    "entity-missing-construction",
                    "missing_construction",
                )),
                Some(json!({ "missing_construction": 1 })),
            ),
            "entity-missing-construction",
            "missing-construction-definition",
        );

        for (entity_id, building_id, kind) in [
            ("entity-miner", "mining_machine", "miner"),
            (
                "entity-station",
                "interstellar_logistics_station",
                "station",
            ),
        ] {
            let mut entity = ordinary_entity(entity_id, building_id);
            entity["kind"] = Value::from(kind);
            assert_reason(
                &basic_state(Some(entity), Some(json!({ (building_id): 1 }))),
                entity_id,
                "unsupported-building-kind",
            );
        }

        assert_reason(
            &basic_state(
                Some(ordinary_entity("entity-special", "construction_center")),
                Some(json!({ "construction_center": 1 })),
            ),
            "entity-special",
            "unsupported-building-domain",
        );
    }

    #[test]
    fn material_spray_belt_queue_blueprint_and_refund_boundaries_are_explicit() {
        for (entity_id, field) in [("entity-input", "inputs"), ("entity-output", "outputs")] {
            let mut entity = ordinary_entity(entity_id, "arc_smelter");
            entity[field] = json!({ "iron_ingot": 1 });
            assert_reason(
                &basic_state(Some(entity), Some(json!({ "arc_smelter": 1 }))),
                entity_id,
                "buffered-material",
            );
        }

        let mut sprayed = ordinary_entity("entity-sprayed", "arc_smelter");
        sprayed["sprayCoaterInstalled"] = Value::from(true);
        assert_reason(
            &basic_state(Some(sprayed), Some(json!({ "arc_smelter": 1 }))),
            "entity-sprayed",
            "spray-coater-installed",
        );

        let incident = json!({
            "id": "belt-a", "planetId": "home", "source": "entity-belt",
            "target": "sink", "itemId": "iron_ingot", "lanes": 1,
            "tier": 1, "priority": 1, "progress": 0, "lastFlow": 0
        });
        assert_reason(
            &fixture_state(
                Some(ordinary_entity("entity-belt", "arc_smelter")),
                Some(json!({ "arc_smelter": 1 })),
                vec![incident],
                json!([]),
                json!([]),
            ),
            "entity-belt",
            "incident-belt",
        );

        assert_reason(
            &fixture_state(
                Some(ordinary_entity("entity-queue", "arc_smelter")),
                Some(json!({ "arc_smelter": 1 })),
                Vec::new(),
                json!([{
                    "status": "waiting-fleet",
                    "placedEntityIdsByKey": { "one": "entity-queue" }
                }]),
                json!([]),
            ),
            "entity-queue",
            "construction-queue-reference",
        );

        assert_reason(
            &fixture_state(
                Some(ordinary_entity("entity-blueprint", "arc_smelter")),
                Some(json!({ "arc_smelter": 1 })),
                Vec::new(),
                json!([]),
                json!([{ "id": "unreferenced-version" }]),
            ),
            "entity-blueprint",
            "blueprint-pruning-required",
        );

        assert_reason(
            &basic_state(
                Some(ordinary_entity("entity-overflow", "arc_smelter")),
                Some(json!({ "arc_smelter": MAX_JAVASCRIPT_SAFE_INTEGER })),
            ),
            "entity-overflow",
            "refund-overflow",
        );

        assert_reason(
            &basic_state(
                Some(ordinary_entity("entity-invalid-stock", "arc_smelter")),
                Some(json!({ "arc_smelter": "not-a-number" })),
            ),
            "entity-invalid-stock",
            "invalid-construction-inventory",
        );

        let missing_inventory = assert_reason(
            &basic_state(
                Some(ordinary_entity("entity-missing-stock", "arc_smelter")),
                None,
            ),
            "entity-missing-stock",
            "invalid-construction-inventory",
        );
        assert!(missing_inventory["currentConstruction"].is_null());
    }
}
