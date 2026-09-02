use std::collections::HashSet;

use anyhow::{anyhow, bail};
use serde_json::{Value, json};

use crate::state::CoreState;

pub(crate) const COMMAND_PALETTE_MAX_QUERY_BYTES: usize = 256;
pub(crate) const COMMAND_PALETTE_MAX_SELECTOR_IDS: usize = 256;
pub(crate) const COMMAND_PALETTE_MAX_ROWS: usize = 16;
pub(crate) const COMMAND_PALETTE_MAX_REQUEST_BYTES: usize = 32_768;
const MAX_PROJECTION_BYTES: usize = 1_048_576;
const MAX_POSITION_ABS: f64 = 10_000_000.0;

fn valid_query(query: &str) -> bool {
    !query.is_empty()
        && query.encode_utf16().count() >= 2
        && query.len() <= COMMAND_PALETTE_MAX_QUERY_BYTES
        && query.trim() == query
        && !query.chars().any(char::is_control)
        && query.to_lowercase() == query
}

fn validate_sorted_selectors(
    values: &[String],
    known: impl Fn(&str) -> bool,
) -> anyhow::Result<HashSet<&str>> {
    if values
        .windows(2)
        .any(|pair| pair[0].as_bytes() >= pair[1].as_bytes())
        || values.iter().any(|value| !known(value))
    {
        bail!("native command palette selector is invalid");
    }
    Ok(values.iter().map(String::as_str).collect())
}

fn folded_contains(value: &str, normalized_query: &str) -> bool {
    value.to_lowercase().contains(normalized_query)
}

impl CoreState {
    /// Searches the native entity directory without exporting entity records.
    ///
    /// Building display names intentionally do not belong to the Rust catalog
    /// contract. The renderer therefore resolves display-name matches against
    /// its fingerprint-bound catalog and sends only bounded stable IDs. Rust
    /// validates every selector against the exact session catalog before using
    /// it. Results retain persisted order and contain only bounded scalar IDs
    /// plus finite coordinates needed to focus the selected native row.
    #[allow(clippy::too_many_arguments)]
    pub fn command_palette_entity_search_projection(
        &self,
        expected_revision: u64,
        expected_registry_fingerprint: &str,
        query: &str,
        cursor: usize,
        limit: usize,
        building_ids: &[String],
        resource_ids: &[String],
        planet_ids: &[String],
    ) -> anyhow::Result<Value> {
        let selector_count = building_ids
            .len()
            .checked_add(resource_ids.len())
            .and_then(|count| count.checked_add(planet_ids.len()))
            .ok_or_else(|| anyhow!("native command palette selector count overflow"))?;
        if expected_revision != self.revision
            || expected_registry_fingerprint != self.catalog.snapshot.registry_fingerprint
            || !valid_query(query)
            || !(1..=COMMAND_PALETTE_MAX_ROWS).contains(&limit)
            || selector_count > COMMAND_PALETTE_MAX_SELECTOR_IDS
        {
            bail!("native command palette search request is invalid");
        }
        let selected_buildings =
            validate_sorted_selectors(building_ids, |id| self.catalog.buildings.contains_key(id))?;
        let selected_resources =
            validate_sorted_selectors(resource_ids, |id| self.catalog.items.contains_key(id))?;
        let selected_planets = validate_sorted_selectors(planet_ids, |id| {
            self.catalog.planets.iter().any(|planet| planet.id == id)
        })?;

        let mut total_count = 0_usize;
        let mut rows = Vec::with_capacity(limit);
        for entity_index in 0..self.entities.ids.len() {
            let entity_id = &self.entities.ids[entity_index];
            let building_id = self.symbols.resolve(self.entities.buildings[entity_index]);
            let resource_id = self.symbols.resolve(self.entities.resources[entity_index]);
            let planet_id = self
                .symbols
                .resolve(self.entities.planets[entity_index])
                .filter(|id| self.catalog.planets.iter().any(|planet| planet.id == *id))
                .ok_or_else(|| anyhow!("native command palette entity planet is invalid"))?;
            let recipe_id = self.symbols.resolve(self.entities.recipes[entity_index]);
            let position_x = self.entities.position_x[entity_index];
            let position_y = self.entities.position_y[entity_index];

            if building_id.is_some_and(|id| !self.catalog.buildings.contains_key(id))
                || resource_id.is_some_and(|id| !self.catalog.items.contains_key(id))
                || recipe_id.is_some_and(|id| !self.catalog.recipes.contains_key(id))
                || !position_x.is_finite()
                || !position_y.is_finite()
                || position_x.abs() > MAX_POSITION_ABS
                || position_y.abs() > MAX_POSITION_ABS
            {
                bail!("native command palette entity catalog identity is invalid");
            }
            let matches = folded_contains(entity_id, query)
                || recipe_id.is_some_and(|id| folded_contains(id, query))
                || building_id.is_some_and(|id| selected_buildings.contains(id))
                || resource_id.is_some_and(|id| selected_resources.contains(id))
                || selected_planets.contains(planet_id);
            if !matches {
                continue;
            }
            if total_count >= cursor && rows.len() < limit {
                rows.push(json!({
                    "entityId": entity_id,
                    "buildingId": building_id,
                    "resourceId": resource_id,
                    "planetId": planet_id,
                    "recipeId": recipe_id,
                    "positionX": position_x,
                    "positionY": position_y,
                }));
            }
            total_count = total_count
                .checked_add(1)
                .ok_or_else(|| anyhow!("native command palette match count overflow"))?;
        }
        if cursor > total_count {
            bail!("native command palette cursor is invalid");
        }
        let consumed = cursor
            .checked_add(rows.len())
            .ok_or_else(|| anyhow!("native command palette cursor overflow"))?;
        let next_cursor = (consumed < total_count).then_some(consumed);
        let value = json!({
            "schemaVersion": 1,
            "projectionType": "command-palette-entity-search-v1",
            "revision": self.revision,
            "registryFingerprint": self.catalog.snapshot.registry_fingerprint,
            "limits": {
                "queryBytes": COMMAND_PALETTE_MAX_QUERY_BYTES,
                "selectorIds": COMMAND_PALETTE_MAX_SELECTOR_IDS,
                "rows": COMMAND_PALETTE_MAX_ROWS,
                "requestBytes": COMMAND_PALETTE_MAX_REQUEST_BYTES,
                "projectionBytes": MAX_PROJECTION_BYTES,
            },
            "request": {
                "query": query,
                "cursor": cursor,
                "limit": limit,
                "buildingIds": building_ids,
                "resourceIds": resource_ids,
                "planetIds": planet_ids,
            },
            "totalCount": total_count,
            "rows": rows,
            "nextCursor": next_cursor,
        });
        if serde_json::to_vec(&value)?.len() > MAX_PROJECTION_BYTES {
            bail!("native command palette projection exceeds the byte limit");
        }
        Ok(value)
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use serde_json::json;

    use super::*;
    use crate::catalog::{
        BuildingDefinition, CatalogSnapshot, ItemDefinition, PlanetDefinition, RecipeDefinition,
        RuntimeCatalog,
    };
    use crate::state::CoreCheckpointIdentity;

    fn catalog() -> RuntimeCatalog {
        RuntimeCatalog::validate(
            CatalogSnapshot {
                protocol_version: 1,
                registry_fingerprint: "command-palette-test".to_owned(),
                planets: vec![
                    PlanetDefinition {
                        id: "home".to_owned(),
                        name: "Home".to_owned(),
                        system_id: "helios".to_owned(),
                        kind: "terrestrial".to_owned(),
                        orbit_index: 1,
                        simulation_order: 0,
                        orbital_yields: HashMap::new(),
                    },
                    PlanetDefinition {
                        id: "ashen".to_owned(),
                        name: "Ashen".to_owned(),
                        system_id: "helios".to_owned(),
                        kind: "terrestrial".to_owned(),
                        orbit_index: 2,
                        simulation_order: 1,
                        orbital_yields: HashMap::new(),
                    },
                ],
                items: vec![ItemDefinition {
                    id: "iron_ore".to_owned(),
                    name: "Iron ore".to_owned(),
                    kind: "solid".to_owned(),
                    fuel_energy_mj: 0.0,
                }],
                buildings: vec![BuildingDefinition {
                    id: "smelter".to_owned(),
                    kind: "machine".to_owned(),
                    speed: 1.0,
                    input_capacity: 100.0,
                    output_capacity: 100.0,
                    power_demand_kw: 0.0,
                    power_generation_kw: 0.0,
                    power_charge_kw: 0.0,
                    energy_capacity_mj: 0.0,
                    fuel_item_ids: Vec::new(),
                    fuel_efficiency: 1.0,
                    family: None,
                    accepts: None,
                }],
                recipes: vec![RecipeDefinition {
                    id: "smelt_iron".to_owned(),
                    name: "Smelt iron".to_owned(),
                    building_id: "smelter".to_owned(),
                    duration: 1.0,
                    required_tech_id: None,
                    recursive_priority: 0.0,
                    recursive_manufacturing: false,
                    inputs: Vec::new(),
                    outputs: Vec::new(),
                }],
                constructions: Vec::new(),
                belts: Vec::new(),
                proliferators: Vec::new(),
                technologies: Vec::new(),
            },
            "command-palette-test",
        )
        .unwrap()
    }

    fn state() -> CoreState {
        let entities = vec![
            json!({
                "id": "machine-alpha", "kind": "machine", "planetId": "home",
                "position": { "x": 0, "y": 0 }, "buildingId": "smelter",
                "recipeId": "smelt_iron", "machineCount": 1, "inputs": {}, "outputs": {}
            })
            .to_string(),
            json!({
                "id": "machine-beta", "kind": "machine", "planetId": "ashen",
                "position": { "x": 1, "y": 1 }, "buildingId": "smelter",
                "recipeId": "smelt_iron", "machineCount": 1, "inputs": {}, "outputs": {}
            })
            .to_string(),
            json!({
                "id": "vein-gamma", "kind": "vein", "planetId": "home",
                "position": { "x": 2, "y": 2 }, "resourceId": "iron_ore",
                "minerCount": 1, "inputs": {}, "outputs": {}
            })
            .to_string(),
        ];
        CoreState::from_public_v47_parts(
            CoreCheckpointIdentity {
                slot: "normal-main".to_owned(),
                generation: 1,
                root_hash: "a".repeat(64),
                revision: 11,
                state_version: 47,
                mode: "normal".to_owned(),
                registry_fingerprint: "command-palette-test".to_owned(),
                base_primary_checksum: "12345678".to_owned(),
            },
            json!({
                "version": 47, "mode": "normal", "activePlanetId": "home",
                "paused": false, "settings": {}, "tray": {}, "planetTrays": {}
            })
            .as_object()
            .unwrap()
            .clone(),
            entities,
            Vec::new(),
            catalog(),
        )
        .unwrap()
    }

    #[test]
    fn entity_search_is_revision_bound_paginated_scalar_only_and_read_only() {
        let state = state();
        let before = state.canonical_sha256().unwrap();
        let first = state
            .command_palette_entity_search_projection(
                11,
                "command-palette-test",
                "熔炉",
                0,
                1,
                &["smelter".to_owned()],
                &[],
                &[],
            )
            .unwrap();
        assert_eq!(first["revision"], 11);
        assert_eq!(first["registryFingerprint"], "command-palette-test");
        assert_eq!(first["totalCount"], 2);
        assert_eq!(first["rows"][0]["entityId"], "machine-alpha");
        assert_eq!(first["rows"][0]["buildingId"], "smelter");
        assert_eq!(first["rows"][0]["planetId"], "home");
        assert_eq!(first["rows"][0]["recipeId"], "smelt_iron");
        assert_eq!(first["rows"][0]["positionX"], 0.0);
        assert_eq!(first["rows"][0]["positionY"], 0.0);
        assert_eq!(first["nextCursor"], 1);
        assert_eq!(first["rows"][0].as_object().unwrap().len(), 7);
        assert!(first["rows"][0].get("position").is_none());

        let second = state
            .command_palette_entity_search_projection(
                11,
                "command-palette-test",
                "熔炉",
                1,
                1,
                &["smelter".to_owned()],
                &[],
                &[],
            )
            .unwrap();
        assert_eq!(second["rows"][0]["entityId"], "machine-beta");
        assert_eq!(second["nextCursor"], Value::Null);
        assert!(serde_json::to_vec(&second).unwrap().len() <= MAX_PROJECTION_BYTES);
        assert_eq!(state.canonical_sha256().unwrap(), before);
    }

    #[test]
    fn entity_search_rejects_drift_unknown_unsorted_and_over_limit_requests() {
        let state = state();
        assert!(
            state
                .command_palette_entity_search_projection(11, "wrong", "sm", 0, 1, &[], &[], &[],)
                .is_err()
        );
        assert!(
            state
                .command_palette_entity_search_projection(
                    10,
                    "command-palette-test",
                    "sm",
                    0,
                    1,
                    &[],
                    &[],
                    &[],
                )
                .is_err()
        );
        assert!(
            state
                .command_palette_entity_search_projection(
                    11,
                    "command-palette-test",
                    "sm",
                    0,
                    1,
                    &["unknown".to_owned()],
                    &[],
                    &[],
                )
                .is_err()
        );
        assert!(
            state
                .command_palette_entity_search_projection(
                    11,
                    "command-palette-test",
                    "sm",
                    0,
                    1,
                    &["smelter".to_owned(), "smelter".to_owned()],
                    &[],
                    &[],
                )
                .is_err()
        );
        assert!(
            state
                .command_palette_entity_search_projection(
                    11,
                    "command-palette-test",
                    "sm",
                    0,
                    COMMAND_PALETTE_MAX_ROWS + 1,
                    &[],
                    &[],
                    &[],
                )
                .is_err()
        );
        assert!(
            state
                .command_palette_entity_search_projection(
                    11,
                    "command-palette-test",
                    "sm",
                    4,
                    1,
                    &[],
                    &[],
                    &[],
                )
                .is_err()
        );
    }
}
