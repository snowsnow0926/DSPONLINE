//! Bounded, same-revision context for one ordinary construction placement.
//!
//! The renderer receives the exact Rust-derived entity fields except for its
//! finite canvas position. It never receives a complete GameState and cannot
//! mutate construction stock through this read model. The resulting command
//! still crosses `validate_ordinary_building_placement`, which re-derives the
//! template, inventory debit, append index and next ID atomically.

use anyhow::{anyhow, bail};
use serde_json::{Value, json};

use crate::{
    command::{canonical_ordinary_placement_entity_template, ordinary_placement_support_reason},
    state::CoreState,
};

const CONSTRUCTION_PLACEMENT_CONTEXT_PROJECTION: &str = "construction-placement-context-v1";
const MAX_PROJECTION_BYTES: usize = 1_048_576;
const MAX_OPAQUE_ID_BYTES: usize = 512;
const MAX_JAVASCRIPT_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

fn valid_opaque_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= MAX_OPAQUE_ID_BYTES && !value.chars().any(char::is_control)
}

fn safe_nonnegative_integer(value: Option<&Value>, label: &str) -> anyhow::Result<u64> {
    match value {
        None | Some(Value::Null) => Ok(0),
        Some(value) => value
            .as_u64()
            .filter(|value| *value <= MAX_JAVASCRIPT_SAFE_INTEGER)
            .ok_or_else(|| anyhow!("native construction placement {label} is not a safe integer")),
    }
}

fn active_planet_id(state: &CoreState) -> anyhow::Result<&str> {
    let active_planet_id = state
        .base_value()
        .get("activePlanetId")
        .and_then(Value::as_str)
        .filter(|value| valid_opaque_id(value))
        .ok_or_else(|| anyhow!("native construction placement active planet is invalid"))?;
    if !state
        .catalog
        .planets
        .iter()
        .any(|planet| planet.id == active_planet_id)
    {
        bail!("native construction placement active planet is not in the catalog")
    }
    Ok(active_planet_id)
}

impl CoreState {
    /// Derives one placement command context without copying entities, belts,
    /// inventories, or the persisted state container.
    pub fn construction_placement_context_projection(
        &self,
        expected_revision: u64,
        expected_registry_fingerprint: &str,
        building_id: &str,
    ) -> anyhow::Result<Value> {
        if expected_revision != self.revision
            || expected_registry_fingerprint != self.catalog.snapshot.registry_fingerprint
            || !valid_opaque_id(building_id)
        {
            bail!("native construction placement context request is invalid")
        }

        let active_planet_id = active_planet_id(self)?;
        let construction = self
            .base_value()
            .get("construction")
            .and_then(Value::as_object)
            .ok_or_else(|| anyhow!("native construction placement inventory is invalid"))?;
        let available =
            safe_nonnegative_integer(construction.get(building_id), "construction inventory")?;
        let append_entity_index = u64::try_from(self.entity_index.len())
            .ok()
            .filter(|value| *value <= MAX_JAVASCRIPT_SAFE_INTEGER)
            .ok_or_else(|| anyhow!("native construction placement append index is invalid"))?;
        let next_id = safe_nonnegative_integer(self.base_value().get("nextId"), "next entity ID")?;
        let next_entity_id = format!("entity_{next_id}");

        let mut reason =
            ordinary_placement_support_reason(self, building_id)?.map(|reason| reason.as_str());
        if reason.is_none() && next_id == MAX_JAVASCRIPT_SAFE_INTEGER {
            reason = Some("next-id-exhausted");
        }
        if reason.is_none() && available == 0 {
            reason = Some("inventory-empty");
        }

        let placement = if reason.is_none() {
            let entity_template = canonical_ordinary_placement_entity_template(
                self,
                building_id,
                &next_entity_id,
                active_planet_id,
            )?;
            Some(json!({
                "remainingConstruction": available - 1,
                "nextIdAfterPlacement": next_id + 1,
                "entityTemplate": entity_template,
            }))
        } else {
            None
        };
        let value = json!({
            "schemaVersion": 1,
            "projectionType": CONSTRUCTION_PLACEMENT_CONTEXT_PROJECTION,
            "source": "native-core",
            "revision": self.revision,
            "stateVersion": self.identity.state_version,
            "registryFingerprint": self.catalog.snapshot.registry_fingerprint,
            "request": {
                "expectedRevision": expected_revision,
                "expectedRegistryFingerprint": expected_registry_fingerprint,
                "buildingId": building_id,
            },
            "activePlanetId": active_planet_id,
            "available": available,
            "appendEntityIndex": append_entity_index,
            "nextEntityId": next_entity_id,
            "support": {
                "supported": reason.is_none(),
                "reason": reason,
            },
            "placement": placement,
            "limits": {
                "projectionBytes": MAX_PROJECTION_BYTES,
            },
        });
        if serde_json::to_vec(&value)?.len() > MAX_PROJECTION_BYTES {
            bail!("native construction placement context exceeds the byte limit")
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

    const REGISTRY: &str = "construction-placement-test";

    fn catalog() -> RuntimeCatalog {
        let snapshot: CatalogSnapshot = serde_json::from_value(json!({
            "protocolVersion": CORE_PROTOCOL_VERSION,
            "registryFingerprint": REGISTRY,
            "planets": [
                { "id": "home", "systemId": "helios", "kind": "terrestrial", "orbitIndex": 1 },
                { "id": "gas", "systemId": "helios", "kind": "gas-giant", "orbitIndex": 2 }
            ],
            "items": [{ "id": "iron_ingot", "kind": "solid" }],
            "buildings": [
                { "id": "arc_smelter", "kind": "machine", "speed": 1, "inputCapacity": 10, "outputCapacity": 10 },
                { "id": "MOD/custom-machine", "kind": "machine", "speed": 1, "inputCapacity": 10, "outputCapacity": 10 },
                { "id": "locked_machine", "kind": "machine", "speed": 1, "inputCapacity": 10, "outputCapacity": 10 },
                { "id": "mining_machine", "kind": "miner", "speed": 1, "inputCapacity": 0, "outputCapacity": 10 },
                { "id": "solar_panel", "kind": "power", "speed": 1, "inputCapacity": 0, "outputCapacity": 0, "powerGenerationKw": 360 },
                { "id": "storage_mk1", "kind": "storage", "speed": 1, "inputCapacity": 100, "outputCapacity": 100 },
                { "id": "splitter_4way", "kind": "splitter", "speed": 1, "inputCapacity": 100, "outputCapacity": 100 },
                { "id": "geothermal_power_station", "kind": "power", "speed": 1, "inputCapacity": 0, "outputCapacity": 0, "powerGenerationKw": 1 }
            ],
            "recipes": [
                { "id": "iron_ingot", "buildingId": "arc_smelter", "duration": 1, "inputs": [], "outputs": [{ "itemId": "iron_ingot", "amount": 1 }] }
            ],
            "constructions": [
                { "id": "arc_smelter", "outputAmount": 1, "costs": [{ "itemId": "iron_ingot", "amount": 1 }] },
                { "id": "MOD/custom-machine", "outputAmount": 1, "costs": [{ "itemId": "iron_ingot", "amount": 1 }] },
                { "id": "locked_machine", "outputAmount": 1, "requiredTechId": "locked_tech", "costs": [{ "itemId": "iron_ingot", "amount": 1 }] },
                { "id": "mining_machine", "outputAmount": 1, "costs": [{ "itemId": "iron_ingot", "amount": 1 }] },
                { "id": "solar_panel", "outputAmount": 1, "costs": [{ "itemId": "iron_ingot", "amount": 1 }] },
                { "id": "storage_mk1", "outputAmount": 1, "costs": [{ "itemId": "iron_ingot", "amount": 1 }] },
                { "id": "splitter_4way", "outputAmount": 1, "costs": [{ "itemId": "iron_ingot", "amount": 1 }] },
                { "id": "geothermal_power_station", "outputAmount": 1, "costs": [{ "itemId": "iron_ingot", "amount": 1 }] }
            ],
            "belts": [],
            "technologies": [{
                "id": "locked_tech", "costs": [{ "itemId": "iron_ingot", "amount": 1 }],
                "prerequisites": [], "constructionRewards": []
            }]
        }))
        .unwrap();
        RuntimeCatalog::validate(snapshot, REGISTRY).unwrap()
    }

    fn fixture_state(active_planet_id: &str, next_id: u64, construction: Value) -> CoreState {
        let base = json!({
            "version": 47,
            "mode": "normal",
            "activePlanetId": active_planet_id,
            "elapsedSeconds": 10,
            "paused": false,
            "nextId": next_id,
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
            Vec::new(),
            Vec::new(),
            catalog(),
        )
        .unwrap()
    }

    fn placement_command(projection: &Value, x: f64, y: f64) -> SimulationCommandPatch {
        let mut entity = projection["placement"]["entityTemplate"]
            .as_object()
            .unwrap()
            .clone();
        entity.insert("position".to_owned(), json!({ "x": x, "y": y }));
        serde_json::from_value(json!({
            "protocolVersion": CORE_PROTOCOL_VERSION,
            "baseRevision": projection["revision"],
            "topLevelChanges": [
                {
                    "path": ["construction", projection["request"]["buildingId"]],
                    "operation": "set",
                    "value": projection["placement"]["remainingConstruction"]
                },
                {
                    "path": ["nextId"],
                    "operation": "set",
                    "value": projection["placement"]["nextIdAfterPlacement"]
                }
            ],
            "changedEntities": [],
            "addedEntities": [{
                "index": projection["appendEntityIndex"],
                "value": entity
            }],
            "removedEntityIds": [],
            "changedBelts": [],
            "addedBelts": [],
            "removedBeltIds": []
        }))
        .unwrap()
    }

    #[test]
    fn supported_context_builds_the_existing_atomic_command_without_state_mutation() {
        let state = fixture_state("home", 9, json!({ "arc_smelter": 4 }));
        let before = state.canonical_sha256().unwrap();
        let projection = state
            .construction_placement_context_projection(7, REGISTRY, "arc_smelter")
            .unwrap();
        assert_eq!(
            projection["projectionType"],
            CONSTRUCTION_PLACEMENT_CONTEXT_PROJECTION
        );
        assert_eq!(projection["source"], "native-core");
        assert_eq!(projection["activePlanetId"], "home");
        assert_eq!(projection["available"], 4);
        assert_eq!(projection["appendEntityIndex"], 0);
        assert_eq!(projection["nextEntityId"], "entity_9");
        assert_eq!(
            projection["support"],
            json!({ "supported": true, "reason": null })
        );
        assert_eq!(projection["placement"]["remainingConstruction"], 3);
        assert_eq!(projection["placement"]["nextIdAfterPlacement"], 10);
        assert!(
            projection["placement"]["entityTemplate"]
                .get("position")
                .is_none()
        );
        assert_eq!(
            projection["placement"]["entityTemplate"]["recipeId"],
            "iron_ingot"
        );
        state
            .validate_player_authority_command(&placement_command(&projection, 12.5, -24.25))
            .unwrap();
        assert_eq!(state.canonical_sha256().unwrap(), before);
        assert!(serde_json::to_vec(&projection).unwrap().len() <= MAX_PROJECTION_BYTES);

        let mut drifted = placement_command(&projection, 12.5, -24.25);
        drifted.added_entities[0].value["powerPriority"] = Value::from(1);
        assert!(state.validate_player_authority_command(&drifted).is_err());
    }

    #[test]
    fn context_supports_catalog_mods_and_explains_unknown_unicode_ids() {
        let state = fixture_state(
            "home",
            9,
            json!({ "MOD/custom-machine": 2, "未知/MOD-建筑": 7 }),
        );
        let supported = state
            .construction_placement_context_projection(7, REGISTRY, "MOD/custom-machine")
            .unwrap();
        assert_eq!(supported["support"]["supported"], true);
        assert_eq!(
            supported["placement"]["entityTemplate"]["buildingId"],
            "MOD/custom-machine"
        );
        state
            .validate_player_authority_command(&placement_command(&supported, 0.0, 0.0))
            .unwrap();

        let unknown = state
            .construction_placement_context_projection(7, REGISTRY, "未知/MOD-建筑")
            .unwrap();
        assert_eq!(unknown["available"], 7);
        assert_eq!(unknown["support"]["supported"], false);
        assert_eq!(unknown["support"]["reason"], "unknown-building");
        assert!(unknown["placement"].is_null());
    }

    #[test]
    fn context_derives_each_supported_ordinary_entity_kind_without_a_position() {
        let state = fixture_state(
            "home",
            9,
            json!({ "solar_panel": 1, "storage_mk1": 1, "splitter_4way": 1 }),
        );
        for (building_id, expected_kind) in [
            ("solar_panel", "power"),
            ("storage_mk1", "storage"),
            ("splitter_4way", "splitter"),
        ] {
            let projection = state
                .construction_placement_context_projection(7, REGISTRY, building_id)
                .unwrap();
            assert_eq!(projection["support"]["supported"], true);
            assert_eq!(
                projection["placement"]["entityTemplate"]["kind"],
                expected_kind
            );
            assert!(
                projection["placement"]["entityTemplate"]
                    .get("position")
                    .is_none()
            );
            state
                .validate_player_authority_command(&placement_command(&projection, 1.0, 2.0))
                .unwrap();
        }
        assert_eq!(
            state
                .construction_placement_context_projection(7, REGISTRY, "solar_panel")
                .unwrap()["placement"]["entityTemplate"]["generationPriority"],
            3
        );
        assert_eq!(
            state
                .construction_placement_context_projection(7, REGISTRY, "splitter_4way")
                .unwrap()["placement"]["entityTemplate"]["distributionMode"],
            "balanced"
        );
    }

    #[test]
    fn context_reports_locked_empty_domain_and_planet_boundaries() {
        let state = fixture_state(
            "home",
            9,
            json!({
                "arc_smelter": 0,
                "locked_machine": 3,
                "mining_machine": 2,
                "geothermal_power_station": 2
            }),
        );
        for (building_id, expected_reason) in [
            ("arc_smelter", "inventory-empty"),
            ("locked_machine", "technology-locked"),
            ("mining_machine", "unsupported-building-kind"),
            ("geothermal_power_station", "unsupported-building-domain"),
        ] {
            let projection = state
                .construction_placement_context_projection(7, REGISTRY, building_id)
                .unwrap();
            assert_eq!(projection["support"]["supported"], false);
            assert_eq!(projection["support"]["reason"], expected_reason);
            assert!(projection["placement"].is_null());
        }

        let gas = fixture_state("gas", 9, json!({ "arc_smelter": 2 }));
        let gas_projection = gas
            .construction_placement_context_projection(7, REGISTRY, "arc_smelter")
            .unwrap();
        assert_eq!(
            gas_projection["support"]["reason"],
            "unsupported-active-planet"
        );

        let exhausted = fixture_state(
            "home",
            MAX_JAVASCRIPT_SAFE_INTEGER,
            json!({ "arc_smelter": 2 }),
        );
        let exhausted_projection = exhausted
            .construction_placement_context_projection(7, REGISTRY, "arc_smelter")
            .unwrap();
        assert_eq!(
            exhausted_projection["support"]["reason"],
            "next-id-exhausted"
        );
    }

    #[test]
    fn context_rejects_stale_identity_invalid_ids_and_unsafe_inventory() {
        let state = fixture_state("home", 9, json!({ "arc_smelter": 2 }));
        assert!(
            state
                .construction_placement_context_projection(6, REGISTRY, "arc_smelter")
                .is_err()
        );
        assert!(
            state
                .construction_placement_context_projection(7, "other", "arc_smelter")
                .is_err()
        );
        assert!(
            state
                .construction_placement_context_projection(7, REGISTRY, "bad\nidentifier")
                .is_err()
        );
        assert!(
            state
                .construction_placement_context_projection(7, REGISTRY, &"x".repeat(513))
                .is_err()
        );

        let unsafe_inventory = fixture_state(
            "home",
            9,
            json!({ "arc_smelter": 9_007_199_254_740_992_u64 }),
        );
        assert!(
            unsafe_inventory
                .construction_placement_context_projection(7, REGISTRY, "arc_smelter")
                .is_err()
        );
    }
}
