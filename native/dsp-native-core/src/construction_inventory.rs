//! Revision- and catalog-bound construction stock for the native thin UI.
//!
//! This read model deliberately exposes no direct inventory mutation.  A
//! standalone `construction[id] = amount` patch cannot prove where material
//! came from or where it was refunded.  Ordinary native placement/removal
//! continues through the existing atomic command validators in `command.rs`.

use anyhow::{anyhow, bail};
use serde_json::{Value, json};

use crate::state::CoreState;

const CONSTRUCTION_INVENTORY_PROJECTION: &str = "construction-inventory-v1";
const MAX_PROJECTION_BYTES: usize = 1_048_576;
const MAX_PAGE_ROWS: usize = 256;
const MAX_OPAQUE_ID_BYTES: usize = 512;
const MAX_JAVASCRIPT_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

fn valid_opaque_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= MAX_OPAQUE_ID_BYTES && !value.chars().any(char::is_control)
}

fn safe_nonnegative_integer(value: Option<&Value>) -> anyhow::Result<u64> {
    value
        .and_then(Value::as_u64)
        .filter(|value| *value <= MAX_JAVASCRIPT_SAFE_INTEGER)
        .ok_or_else(|| anyhow!("native construction inventory amount is not a safe integer"))
}

impl CoreState {
    /// Returns one deterministic UTF-8-sorted page of the top-level v47
    /// construction inventory without transferring a complete GameState.
    pub fn construction_inventory_projection(
        &self,
        expected_revision: u64,
        expected_registry_fingerprint: &str,
        cursor: usize,
        limit: usize,
    ) -> anyhow::Result<Value> {
        if expected_revision != self.revision
            || expected_registry_fingerprint != self.catalog.snapshot.registry_fingerprint
            || !(1..=MAX_PAGE_ROWS).contains(&limit)
        {
            bail!("native construction inventory projection request is invalid")
        }

        let construction = self
            .base_value()
            .get("construction")
            .and_then(Value::as_object)
            .ok_or_else(|| anyhow!("native construction inventory is invalid"))?;
        let mut inventory = Vec::<(&str, u64)>::with_capacity(construction.len());
        for (building_id, raw_amount) in construction {
            // Keep opaque historical and currently disabled MOD IDs visible.
            // The registry fingerprint binds the page to the active catalog,
            // but absence from that catalog must not hide preserved stock.
            if !valid_opaque_id(building_id) {
                bail!("native construction inventory building ID is invalid")
            }
            let amount = safe_nonnegative_integer(Some(raw_amount))?;
            if amount > 0 {
                inventory.push((building_id, amount));
            }
        }
        inventory.sort_unstable_by(|left, right| left.0.as_bytes().cmp(right.0.as_bytes()));

        let total_count = inventory.len();
        if cursor > total_count {
            bail!("native construction inventory projection cursor is invalid")
        }
        let rows = inventory
            .iter()
            .skip(cursor)
            .take(limit)
            .map(|(building_id, amount)| {
                json!({
                    "buildingId": building_id,
                    "amount": amount,
                })
            })
            .collect::<Vec<_>>();
        let consumed = cursor
            .checked_add(rows.len())
            .ok_or_else(|| anyhow!("native construction inventory cursor overflows"))?;
        let next_cursor = (consumed < total_count).then_some(consumed);
        let value = json!({
            "schemaVersion": 1,
            "projectionType": CONSTRUCTION_INVENTORY_PROJECTION,
            "source": "native-core",
            "revision": self.revision,
            "stateVersion": self.identity.state_version,
            "registryFingerprint": self.catalog.snapshot.registry_fingerprint,
            "readOnly": true,
            "request": {
                "expectedRevision": expected_revision,
                "expectedRegistryFingerprint": expected_registry_fingerprint,
                "cursor": cursor,
                "limit": limit,
            },
            "totalCount": total_count,
            "rows": rows,
            "nextCursor": next_cursor,
            "truncated": next_cursor.is_some(),
            "limits": {
                "rows": MAX_PAGE_ROWS,
                "projectionBytes": MAX_PROJECTION_BYTES,
            },
        });
        if serde_json::to_vec(&value)?.len() > MAX_PROJECTION_BYTES {
            bail!("native construction inventory projection exceeds the byte limit")
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

    const REGISTRY: &str = "construction-inventory-test";

    fn catalog() -> RuntimeCatalog {
        let snapshot: CatalogSnapshot = serde_json::from_value(json!({
            "protocolVersion": crate::CORE_PROTOCOL_VERSION,
            "registryFingerprint": REGISTRY,
            "planets": [
                { "id": "home", "systemId": "helios", "kind": "terrestrial", "orbitIndex": 1 }
            ],
            "items": [
                { "id": "iron_ingot", "kind": "solid" }
            ],
            "buildings": [],
            "recipes": [],
            "constructions": [
                { "id": "arc_smelter", "outputAmount": 1, "costs": [{ "itemId": "iron_ingot", "amount": 1 }] },
                { "id": "conveyor_belt_mk1", "outputAmount": 3, "costs": [{ "itemId": "iron_ingot", "amount": 1 }] },
                { "id": "MOD/building-beta", "outputAmount": 1, "costs": [{ "itemId": "iron_ingot", "amount": 2 }] },
                { "id": "zeta_lab", "outputAmount": 1, "costs": [{ "itemId": "iron_ingot", "amount": 3 }] }
            ],
            "belts": [],
            "technologies": []
        }))
        .unwrap();
        RuntimeCatalog::validate(snapshot, REGISTRY).unwrap()
    }

    fn state(construction: Value) -> CoreState {
        let base = json!({
            "version": 47,
            "mode": "normal",
            "activePlanetId": "home",
            "elapsedSeconds": 10,
            "paused": false,
            "construction": construction,
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

    #[test]
    fn projection_pages_utf8_sorted_stock_and_keeps_mod_entries() {
        let state = state(json!({
            "zeta_lab": 3,
            "arc_smelter": 8,
            "MOD/building-beta": 2,
            "未知/MOD-建筑": 5,
            "conveyor_belt_mk1": 0
        }));
        let before = state.summary().unwrap().canonical_sha256;
        let first = state
            .construction_inventory_projection(7, REGISTRY, 0, 2)
            .unwrap();
        assert_eq!(first["projectionType"], CONSTRUCTION_INVENTORY_PROJECTION);
        assert_eq!(first["source"], "native-core");
        assert_eq!(first["revision"], 7);
        assert_eq!(first["stateVersion"], 47);
        assert_eq!(first["registryFingerprint"], REGISTRY);
        assert_eq!(first["readOnly"], true);
        assert_eq!(first["totalCount"], 4);
        assert_eq!(
            first["rows"][0],
            json!({ "buildingId": "MOD/building-beta", "amount": 2 })
        );
        assert_eq!(
            first["rows"][1],
            json!({ "buildingId": "arc_smelter", "amount": 8 })
        );
        assert_eq!(first["nextCursor"], 2);
        assert_eq!(first["truncated"], true);

        let second = state
            .construction_inventory_projection(7, REGISTRY, 2, 2)
            .unwrap();
        assert_eq!(
            second["rows"][0],
            json!({ "buildingId": "zeta_lab", "amount": 3 })
        );
        assert_eq!(
            second["rows"][1],
            json!({ "buildingId": "未知/MOD-建筑", "amount": 5 })
        );
        assert!(second["nextCursor"].is_null());
        assert_eq!(second["truncated"], false);
        assert_eq!(state.summary().unwrap().canonical_sha256, before);
    }

    #[test]
    fn projection_rejects_stale_identity_and_invalid_page_bounds() {
        let state = state(json!({ "arc_smelter": 1 }));
        assert!(
            state
                .construction_inventory_projection(6, REGISTRY, 0, 1)
                .is_err()
        );
        assert!(
            state
                .construction_inventory_projection(7, "other", 0, 1)
                .is_err()
        );
        assert!(
            state
                .construction_inventory_projection(7, REGISTRY, 0, 0)
                .is_err()
        );
        assert!(
            state
                .construction_inventory_projection(7, REGISTRY, 0, MAX_PAGE_ROWS + 1)
                .is_err()
        );
        assert!(
            state
                .construction_inventory_projection(7, REGISTRY, 2, 1)
                .is_err()
        );
    }

    #[test]
    fn projection_fails_closed_for_invalid_id_and_unsafe_stock() {
        let invalid_id = state(json!({ "bad\nidentifier": 1 }));
        assert!(
            invalid_id
                .construction_inventory_projection(7, REGISTRY, 0, 1)
                .is_err()
        );

        let fractional = state(json!({ "arc_smelter": 1.5 }));
        assert!(
            fractional
                .construction_inventory_projection(7, REGISTRY, 0, 1)
                .is_err()
        );

        let negative = state(json!({ "arc_smelter": -1 }));
        assert!(
            negative
                .construction_inventory_projection(7, REGISTRY, 0, 1)
                .is_err()
        );

        let unsafe_integer = state(json!({ "arc_smelter": 9_007_199_254_740_992_u64 }));
        assert!(
            unsafe_integer
                .construction_inventory_projection(7, REGISTRY, 0, 1)
                .is_err()
        );
    }
}
