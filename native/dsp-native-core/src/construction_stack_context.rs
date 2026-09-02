//! Bounded, same-revision context for one ordinary building stack target.
//!
//! The projection and durable command validator share the exact eligibility
//! helper. Reading this context never mutates the Rust authority, while command
//! apply re-derives every active-planet, catalog and inventory fact atomically.

use anyhow::bail;
use serde_json::{Value, json};

use crate::{command::ordinary_building_stack_eligibility, state::CoreState};

const CONSTRUCTION_STACK_CONTEXT_PROJECTION: &str = "construction-stack-context-v1";
const MAX_PROJECTION_BYTES: usize = 1_048_576;
const MAX_SESSION_ID_BYTES: usize = 128;
const MAX_OPAQUE_ID_BYTES: usize = 512;
const MAX_JAVASCRIPT_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

fn valid_opaque_id(value: &str, max_bytes: usize) -> bool {
    !value.is_empty() && value.len() <= max_bytes && !value.chars().any(char::is_control)
}

impl CoreState {
    /// Derives the exact material adjustment for one requested stack target.
    pub fn construction_stack_context_projection(
        &self,
        session_id: &str,
        expected_revision: u64,
        expected_registry_fingerprint: &str,
        entity_id: &str,
        target_count: u64,
    ) -> anyhow::Result<Value> {
        if expected_revision != self.revision
            || expected_registry_fingerprint != self.catalog.snapshot.registry_fingerprint
            || !valid_opaque_id(session_id, MAX_SESSION_ID_BYTES)
            || !valid_opaque_id(entity_id, MAX_OPAQUE_ID_BYTES)
            || target_count == 0
            || target_count > MAX_JAVASCRIPT_SAFE_INTEGER
        {
            bail!("native construction stack context request is invalid")
        }
        let eligibility = ordinary_building_stack_eligibility(self, entity_id, target_count)?;
        let value = json!({
            "schemaVersion": 1,
            "projectionType": CONSTRUCTION_STACK_CONTEXT_PROJECTION,
            "source": "native-core",
            "sessionId": session_id,
            "revision": self.revision,
            "stateVersion": self.identity.state_version,
            "registryFingerprint": self.catalog.snapshot.registry_fingerprint,
            "request": {
                "sessionId": session_id,
                "expectedRevision": expected_revision,
                "expectedRegistryFingerprint": expected_registry_fingerprint,
                "entityId": entity_id,
                "targetCount": target_count,
            },
            "activePlanetId": eligibility.active_planet_id,
            "entityId": eligibility.entity_id,
            "buildingId": eligibility.building_id,
            "currentCount": eligibility.current_count,
            "targetCount": eligibility.target_count,
            "currentConstruction": eligibility.current_construction,
            "constructionAfter": eligibility.construction_after,
            "support": {
                "supported": eligibility.unsupported_reason.is_none(),
                "reason": eligibility.unsupported_reason,
            },
            "limits": {
                "projectionBytes": MAX_PROJECTION_BYTES,
            },
        });
        if serde_json::to_vec(&value)?.len() > MAX_PROJECTION_BYTES {
            bail!("native construction stack context exceeds the byte limit")
        }
        Ok(value)
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::{
        CORE_PROTOCOL_VERSION, CoreCheckpointIdentity, catalog::RuntimeCatalog,
        command::SimulationCommandPatch,
    };

    const REGISTRY: &str = "construction-stack-test";

    fn catalog(stack_limit_complete: bool) -> RuntimeCatalog {
        let value = json!({
            "protocolVersion": CORE_PROTOCOL_VERSION,
            "registryFingerprint": REGISTRY,
            "planets": [
                { "id": "home", "systemId": "helios", "kind": "terrestrial", "orbitIndex": 1 },
                { "id": "away", "systemId": "helios", "kind": "terrestrial", "orbitIndex": 2 }
            ],
            "items": [{ "id": "iron_ingot", "kind": "solid" }],
            "buildings": [
                {
                    "id": "arc_smelter", "kind": "machine", "speed": 1,
                    "inputCapacity": 10, "outputCapacity": 10,
                    "stackLimit": null, "stackLimitComplete": stack_limit_complete
                },
                {
                    "id": "MOD/custom-machine", "kind": "machine", "speed": 1,
                    "inputCapacity": 10, "outputCapacity": 10,
                    "stackLimit": 40, "stackLimitComplete": stack_limit_complete
                },
                {
                    "id": "station", "kind": "station", "speed": 1,
                    "inputCapacity": 10, "outputCapacity": 10,
                    "stackLimit": null, "stackLimitComplete": stack_limit_complete
                }
            ],
            "recipes": [],
            "constructions": [
                { "id": "arc_smelter", "outputAmount": 1, "costs": [{ "itemId": "iron_ingot", "amount": 1 }] },
                { "id": "MOD/custom-machine", "outputAmount": 1, "costs": [{ "itemId": "iron_ingot", "amount": 1 }] },
                { "id": "station", "outputAmount": 1, "costs": [{ "itemId": "iron_ingot", "amount": 1 }] }
            ],
            "belts": [],
            "technologies": []
        });
        RuntimeCatalog::from_value(value, REGISTRY).unwrap()
    }

    fn fixture_state(stack_limit_complete: bool, entity: Value, construction: Value) -> CoreState {
        let base = json!({
            "version": 47,
            "mode": "normal",
            "activePlanetId": "home",
            "elapsedSeconds": 10,
            "paused": false,
            "nextId": 9,
            "construction": construction,
            "research": { "completedTechIds": [] },
            "settings": { "simulationSpeed": 1 },
            "exploration": { "colonizedPlanetIds": ["home"], "unlockedSystemIds": ["helios"] }
        })
        .as_object()
        .unwrap()
        .clone();
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
            vec![serde_json::to_string(&entity).unwrap()],
            Vec::new(),
            catalog(stack_limit_complete),
        )
        .unwrap()
    }

    fn entity(building_id: &str, count: u64) -> Value {
        json!({
            "id": "machine-a",
            "kind": "machine",
            "planetId": "home",
            "buildingId": building_id,
            "machineCount": count,
            "inputs": {},
            "outputs": {},
            "progress": 0,
            "position": { "x": 0, "y": 0 }
        })
    }

    fn stack_command(projection: &Value) -> SimulationCommandPatch {
        serde_json::from_value(json!({
            "protocolVersion": CORE_PROTOCOL_VERSION,
            "baseRevision": projection["revision"],
            "topLevelChanges": [{
                "path": ["construction", projection["buildingId"]],
                "operation": "set",
                "value": projection["constructionAfter"]
            }],
            "changedEntities": [{
                "id": projection["entityId"],
                "changes": [{
                    "path": ["machineCount"],
                    "operation": "set",
                    "value": projection["targetCount"]
                }]
            }],
            "addedEntities": [],
            "removedEntityIds": [],
            "changedBelts": [],
            "addedBelts": [],
            "removedBeltIds": []
        }))
        .unwrap()
    }

    fn context(state: &CoreState, target_count: u64) -> Value {
        state
            .construction_stack_context_projection(
                "main-player-authority",
                7,
                REGISTRY,
                "machine-a",
                target_count,
            )
            .unwrap()
    }

    #[test]
    fn exact_context_supports_plus_one_plus_ten_explicit_and_decrease_to_one() {
        let state = fixture_state(true, entity("arc_smelter", 5), json!({ "arc_smelter": 20 }));
        let before = state.canonical_sha256().unwrap();
        for (target, expected_after) in [(6, 19), (15, 10), (9, 16), (1, 24)] {
            let projection = context(&state, target);
            assert_eq!(projection["sessionId"], "main-player-authority");
            assert_eq!(projection["revision"], 7);
            assert_eq!(projection["registryFingerprint"], REGISTRY);
            assert_eq!(projection["activePlanetId"], "home");
            assert_eq!(projection["entityId"], "machine-a");
            assert_eq!(projection["buildingId"], "arc_smelter");
            assert_eq!(projection["currentCount"], 5);
            assert_eq!(projection["targetCount"], target);
            assert_eq!(projection["currentConstruction"], 20);
            assert_eq!(projection["constructionAfter"], expected_after);
            assert_eq!(
                projection["support"],
                json!({ "supported": true, "reason": null })
            );
            state
                .validate_player_authority_command(&stack_command(&projection))
                .unwrap();
            assert!(serde_json::to_vec(&projection).unwrap().len() <= MAX_PROJECTION_BYTES);
        }
        assert_eq!(state.canonical_sha256().unwrap(), before);
    }

    #[test]
    fn historical_over_limit_stack_can_only_move_down_even_above_new_limit() {
        let state = fixture_state(
            false,
            entity("MOD/custom-machine", 150_000_000),
            json!({ "MOD/custom-machine": 0 }),
        );
        let decrease = context(&state, 120_000_000);
        assert_eq!(decrease["support"]["supported"], true);
        assert_eq!(decrease["constructionAfter"], 30_000_000);
        state
            .validate_player_authority_command(&stack_command(&decrease))
            .unwrap();

        for target in [150_000_000, 150_000_001] {
            let blocked = context(&state, target);
            assert_eq!(blocked["support"]["supported"], false);
            assert!(blocked["constructionAfter"].is_null());
        }
        assert_eq!(
            context(&state, 150_000_000)["support"]["reason"],
            "unchanged-target"
        );
        assert_eq!(
            context(&state, 150_000_001)["support"]["reason"],
            "stack-limit"
        );
    }

    #[test]
    fn mod_decrease_is_safe_but_increase_requires_a_complete_bound() {
        let incomplete = fixture_state(
            false,
            entity("MOD/custom-machine", 20),
            json!({ "MOD/custom-machine": 50 }),
        );
        assert_eq!(context(&incomplete, 19)["support"]["supported"], true);
        assert_eq!(
            context(&incomplete, 21)["support"]["reason"],
            "catalog-incomplete"
        );

        let complete = fixture_state(
            true,
            entity("MOD/custom-machine", 20),
            json!({ "MOD/custom-machine": 50 }),
        );
        assert_eq!(context(&complete, 30)["constructionAfter"], 40);
        assert_eq!(context(&complete, 41)["support"]["reason"], "stack-limit");
    }

    #[test]
    fn context_fails_closed_on_planet_lock_domain_inventory_and_refund_boundaries() {
        let mut away = entity("arc_smelter", 5);
        away["planetId"] = json!("away");
        let state = fixture_state(true, away, json!({ "arc_smelter": 5 }));
        assert_eq!(context(&state, 6)["support"]["reason"], "not-active-planet");

        let mut locked = entity("arc_smelter", 5);
        locked["interactionLocked"] = json!(true);
        let state = fixture_state(true, locked, json!({ "arc_smelter": 5 }));
        assert_eq!(
            context(&state, 6)["support"]["reason"],
            "interaction-locked"
        );

        let state = fixture_state(true, entity("station", 5), json!({ "station": 5 }));
        assert_eq!(
            context(&state, 6)["support"]["reason"],
            "unsupported-building-kind"
        );

        let state = fixture_state(true, entity("arc_smelter", 5), json!({ "arc_smelter": 0 }));
        assert_eq!(
            context(&state, 6)["support"]["reason"],
            "inventory-insufficient"
        );

        let state = fixture_state(
            true,
            entity("arc_smelter", 5),
            json!({ "arc_smelter": MAX_JAVASCRIPT_SAFE_INTEGER }),
        );
        assert_eq!(context(&state, 1)["support"]["reason"], "refund-overflow");
    }

    #[test]
    fn request_identity_and_safe_integer_bounds_are_strict() {
        let state = fixture_state(true, entity("arc_smelter", 5), json!({ "arc_smelter": 20 }));
        for result in [
            state.construction_stack_context_projection("main", 6, REGISTRY, "machine-a", 6),
            state.construction_stack_context_projection("main", 7, "other", "machine-a", 6),
            state.construction_stack_context_projection(
                "bad\nsession",
                7,
                REGISTRY,
                "machine-a",
                6,
            ),
            state.construction_stack_context_projection("main", 7, REGISTRY, "bad\nentity", 6),
            state.construction_stack_context_projection("main", 7, REGISTRY, "machine-a", 0),
            state.construction_stack_context_projection(
                "main",
                7,
                REGISTRY,
                "machine-a",
                MAX_JAVASCRIPT_SAFE_INTEGER + 1,
            ),
        ] {
            assert!(result.is_err());
        }
    }
}
