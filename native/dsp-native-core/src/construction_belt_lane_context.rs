//! Same-revision proof and durable gate for adjusting one ordinary belt.
//!
//! The renderer supplies only a belt ID and requested lane count. Rust binds
//! that request to the current active planet, exact persisted route endpoints,
//! built-in tier, current lanes and construction inventory before returning a
//! bounded projection. Durable validation re-runs this same eligibility path,
//! so a stale projection can neither mint refunded belts nor spend inventory
//! from a different revision.

use anyhow::{anyhow, bail};
use serde_json::{Map, Value, json};

use crate::{
    command::{PathSegment, SimulationCommandPatch, ValuePatch},
    state::CoreState,
};

const PROJECTION_TYPE: &str = "construction-belt-lane-context-v1";
const MAX_PROJECTION_BYTES: usize = 1_048_576;
const MAX_OPAQUE_ID_BYTES: usize = 512;
const MAX_PLAYER_BELT_LANES: u64 = 4_096;
const MAX_JAVASCRIPT_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

fn valid_opaque_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= MAX_OPAQUE_ID_BYTES && !value.chars().any(char::is_control)
}

fn registered_construction_id(state: &CoreState, tier: u8) -> Option<&str> {
    state
        .catalog
        .belt_construction_ids
        .get(&tier)
        .map(String::as_str)
}

fn endpoint_domain_is_special(building_id: &str) -> bool {
    matches!(
        building_id,
        "galactic_material_exporter"
            | "material_delivery_hub"
            | "micro_black_hole_connector"
            | "orbital_cargo_terminal"
            | "orbital_collector"
            | "planetary_logistics_station"
            | "interstellar_logistics_station"
            | "space_station_construction_launcher"
            | "time_warp_device"
    )
}

fn building_kind_matches(entity_kind: &str, building_kind: &str) -> bool {
    matches!(
        (entity_kind, building_kind),
        ("machine", "machine")
            | ("power", "power")
            | ("storage", "storage")
            | ("splitter", "splitter")
    )
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
        .ok_or_else(|| anyhow!("native ordinary belt lane construction inventory is invalid"))?;
    let value = value.floor().max(0.0);
    if value > MAX_JAVASCRIPT_SAFE_INTEGER as f64 {
        bail!("native ordinary belt lane construction inventory exceeds the safe integer limit")
    }
    Ok(value as u64)
}

fn safe_positive_integer(value: Option<&Value>, label: &str) -> anyhow::Result<u64> {
    value
        .and_then(Value::as_u64)
        .filter(|value| *value > 0 && *value <= MAX_JAVASCRIPT_SAFE_INTEGER)
        .ok_or_else(|| anyhow!("native ordinary belt lane {label} is not a positive safe integer"))
}

fn endpoint(state: &CoreState, entity_id: &str) -> anyhow::Result<Option<Map<String, Value>>> {
    let Some(index) = state.entity_index.get(entity_id).copied() else {
        return Ok(None);
    };
    let value = state.parse_entity(index)?;
    let object = value
        .as_object()
        .ok_or_else(|| anyhow!("native ordinary belt lane endpoint is invalid"))?;
    Ok(Some(object.clone()))
}

fn endpoint_is_ordinary(state: &CoreState, endpoint: &Map<String, Value>, source: bool) -> bool {
    let kind = endpoint
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let allowed = if source {
        matches!(kind, "vein" | "machine" | "storage" | "splitter")
    } else {
        matches!(kind, "machine" | "power" | "storage" | "splitter")
    };
    if !allowed {
        return false;
    }
    if kind == "vein" {
        return source;
    }
    let Some(building_id) = endpoint.get("buildingId").and_then(Value::as_str) else {
        return false;
    };
    let Some(building) = state.catalog.buildings.get(building_id) else {
        return false;
    };
    !endpoint_domain_is_special(building_id) && building_kind_matches(kind, &building.kind)
}

#[derive(Debug, Clone)]
pub(crate) struct Eligibility {
    active_planet_id: String,
    belt_id: String,
    planet_id: Option<String>,
    source_id: Option<String>,
    target_id: Option<String>,
    item_id: Option<String>,
    tier: Option<u8>,
    current_lanes: Option<u64>,
    target_lanes: u64,
    construction_id: Option<String>,
    current_construction: Option<u64>,
    lane_delta: Option<i64>,
    construction_after_adjustment: Option<u64>,
    unsupported_reason: Option<&'static str>,
}

impl Eligibility {
    fn unsupported(mut self, reason: &'static str) -> Self {
        self.unsupported_reason = Some(reason);
        self.lane_delta = None;
        self.construction_after_adjustment = None;
        self
    }
}

/// Single source of truth shared by the projection and durable command gate.
pub(crate) fn eligibility(
    state: &CoreState,
    belt_id: &str,
    target_lanes: u64,
) -> anyhow::Result<Eligibility> {
    let active_planet_id = state
        .base_value()
        .get("activePlanetId")
        .and_then(Value::as_str)
        .filter(|value| valid_opaque_id(value))
        .ok_or_else(|| anyhow!("native ordinary belt lane active planet is invalid"))?
        .to_owned();
    let mut result = Eligibility {
        active_planet_id: active_planet_id.clone(),
        belt_id: belt_id.to_owned(),
        planet_id: None,
        source_id: None,
        target_id: None,
        item_id: None,
        tier: None,
        current_lanes: None,
        target_lanes,
        construction_id: None,
        current_construction: None,
        lane_delta: None,
        construction_after_adjustment: None,
        unsupported_reason: None,
    };
    if target_lanes == 0 || target_lanes > MAX_JAVASCRIPT_SAFE_INTEGER {
        return Ok(result.unsupported("invalid-target-lanes"));
    }
    if !state
        .catalog
        .planets
        .iter()
        .any(|planet| planet.id == active_planet_id && planet.kind == "terrestrial")
    {
        return Ok(result.unsupported("unsupported-active-planet"));
    }
    let Some(index) = state.belt_index.get(belt_id).copied() else {
        return Ok(result.unsupported("belt-not-found"));
    };
    let belt_value = state.parse_belt(index)?;
    let Some(belt) = belt_value.as_object() else {
        return Ok(result.unsupported("invalid-belt"));
    };
    if belt.get("id").and_then(Value::as_str) != Some(belt_id) {
        return Ok(result.unsupported("invalid-belt"));
    }
    let Some(planet_id) = belt.get("planetId").and_then(Value::as_str) else {
        return Ok(result.unsupported("invalid-belt"));
    };
    result.planet_id = Some(planet_id.to_owned());
    if planet_id != active_planet_id {
        return Ok(result.unsupported("not-active-planet"));
    }
    let Some(source_id) = belt.get("source").and_then(Value::as_str) else {
        return Ok(result.unsupported("invalid-belt"));
    };
    let Some(target_id) = belt.get("target").and_then(Value::as_str) else {
        return Ok(result.unsupported("invalid-belt"));
    };
    let Some(item_id) = belt.get("itemId").and_then(Value::as_str) else {
        return Ok(result.unsupported("invalid-belt"));
    };
    if !valid_opaque_id(source_id)
        || !valid_opaque_id(target_id)
        || !valid_opaque_id(item_id)
        || source_id == target_id
    {
        return Ok(result.unsupported("invalid-belt"));
    }
    result.source_id = Some(source_id.to_owned());
    result.target_id = Some(target_id.to_owned());
    result.item_id = Some(item_id.to_owned());
    if !state.catalog.items.contains_key(item_id) {
        return Ok(result.unsupported("unsupported-item"));
    }
    if belt.contains_key("targetPortIndex") || belt.contains_key("elevatorOutputIndex") {
        return Ok(result.unsupported("unsupported-belt-domain"));
    }
    let tier_value = match safe_positive_integer(belt.get("tier"), "tier") {
        Ok(value) => value,
        Err(_) => return Ok(result.unsupported("invalid-belt")),
    };
    let Ok(tier) = u8::try_from(tier_value) else {
        return Ok(result.unsupported("unsupported-belt-tier"));
    };
    result.tier = Some(tier);
    let Some(construction_id) = registered_construction_id(state, tier) else {
        return Ok(result.unsupported("unsupported-belt-tier"));
    };
    result.construction_id = Some(construction_id.to_owned());
    if !state.catalog.belt_speeds.contains_key(&tier)
        || !state.catalog.constructions.contains_key(construction_id)
    {
        return Ok(result.unsupported("missing-construction-definition"));
    }
    let current_lanes = match safe_positive_integer(belt.get("lanes"), "current lanes") {
        Ok(value) => value,
        Err(_) => return Ok(result.unsupported("invalid-belt")),
    };
    result.current_lanes = Some(current_lanes);
    if target_lanes == current_lanes {
        return Ok(result.unsupported("unchanged-lanes"));
    }
    // Historical saves above the current cap may only move downward.
    if target_lanes > MAX_PLAYER_BELT_LANES && target_lanes >= current_lanes {
        return Ok(result.unsupported("target-lanes-exceed-limit"));
    }

    let Some(source) = endpoint(state, source_id)? else {
        return Ok(result.unsupported("source-not-found"));
    };
    let Some(target) = endpoint(state, target_id)? else {
        return Ok(result.unsupported("target-not-found"));
    };
    if source.get("planetId").and_then(Value::as_str) != Some(active_planet_id.as_str())
        || target.get("planetId").and_then(Value::as_str) != Some(active_planet_id.as_str())
    {
        return Ok(result.unsupported("not-active-planet"));
    }
    if !endpoint_is_ordinary(state, &source, true) {
        return Ok(result.unsupported("unsupported-source-domain"));
    }
    if !endpoint_is_ordinary(state, &target, false) {
        return Ok(result.unsupported("unsupported-target-domain"));
    }

    let construction = state
        .base_value()
        .get("construction")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("native ordinary belt lane construction inventory is missing"))?;
    let current_construction =
        match normalized_construction_inventory(construction.get(construction_id)) {
            Ok(value) => value,
            Err(_) => return Ok(result.unsupported("invalid-construction-inventory")),
        };
    result.current_construction = Some(current_construction);
    let delta = i64::try_from(target_lanes)? - i64::try_from(current_lanes)?;
    let adjusted = if delta > 0 {
        let required = u64::try_from(delta)?;
        let Some(remaining) = current_construction.checked_sub(required) else {
            return Ok(result.unsupported("insufficient-construction"));
        };
        remaining
    } else {
        let refund = delta.unsigned_abs();
        let Some(refunded) = current_construction
            .checked_add(refund)
            .filter(|value| *value <= MAX_JAVASCRIPT_SAFE_INTEGER)
        else {
            return Ok(result.unsupported("refund-overflow"));
        };
        refunded
    };
    result.lane_delta = Some(delta);
    result.construction_after_adjustment = Some(adjusted);
    Ok(result)
}

fn path_matches(path: &[PathSegment], expected: &[&str]) -> bool {
    path.len() == expected.len()
        && path
            .iter()
            .zip(expected)
            .all(|(segment, key)| matches!(segment, PathSegment::Key(actual) if actual == key))
}

fn exact_set_patch<'a>(changes: &'a [ValuePatch], path: &[&str]) -> anyhow::Result<&'a Value> {
    let mut matching = changes
        .iter()
        .filter(|change| path_matches(&change.path, path));
    let change = matching
        .next()
        .ok_or_else(|| anyhow!("native ordinary belt lane patch is missing"))?;
    if matching.next().is_some() || change.operation != "set" {
        bail!("native ordinary belt lane patch is not canonical")
    }
    change
        .value
        .as_ref()
        .ok_or_else(|| anyhow!("native ordinary belt lane set has no value"))
}

pub(crate) fn validate_command(
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
        bail!("native ordinary belt lane command shape is invalid")
    }
    let record = &command.changed_belts[0];
    if !valid_opaque_id(&record.id) {
        bail!("native ordinary belt lane command ID is invalid")
    }
    let target_lanes = safe_positive_integer(
        Some(exact_set_patch(&record.changes, &["lanes"])?),
        "target lanes",
    )?;
    let eligibility = eligibility(state, &record.id, target_lanes)?;
    if let Some(reason) = eligibility.unsupported_reason {
        bail!("native ordinary belt lane adjustment is unsupported: {reason}")
    }
    let construction_id = eligibility
        .construction_id
        .ok_or_else(|| anyhow!("native ordinary belt lane construction ID is missing"))?;
    let adjusted = eligibility
        .construction_after_adjustment
        .ok_or_else(|| anyhow!("native ordinary belt lane adjusted inventory is missing"))?;
    if exact_set_patch(
        &command.top_level_changes,
        &["construction", &construction_id],
    )?
    .as_u64()
        != Some(adjusted)
    {
        bail!("native ordinary belt lane inventory adjustment is invalid")
    }
    Ok(())
}

impl CoreState {
    pub fn construction_belt_lane_context_projection(
        &self,
        expected_revision: u64,
        expected_registry_fingerprint: &str,
        belt_id: &str,
        target_lanes: u64,
    ) -> anyhow::Result<Value> {
        if expected_revision != self.revision
            || expected_registry_fingerprint != self.catalog.snapshot.registry_fingerprint
            || !valid_opaque_id(belt_id)
            || target_lanes > MAX_JAVASCRIPT_SAFE_INTEGER
        {
            bail!("native ordinary belt lane context request is invalid")
        }
        let eligibility = eligibility(self, belt_id, target_lanes)?;
        let supported = eligibility.unsupported_reason.is_none();
        let value = json!({
            "schemaVersion": 1,
            "projectionType": PROJECTION_TYPE,
            "source": "native-core",
            "revision": self.revision,
            "stateVersion": self.identity.state_version,
            "registryFingerprint": self.catalog.snapshot.registry_fingerprint,
            "request": {
                "expectedRevision": expected_revision,
                "expectedRegistryFingerprint": expected_registry_fingerprint,
                "beltId": belt_id,
                "targetLanes": target_lanes,
            },
            "activePlanetId": eligibility.active_planet_id,
            "beltId": eligibility.belt_id,
            "planetId": eligibility.planet_id,
            "sourceId": eligibility.source_id,
            "targetId": eligibility.target_id,
            "itemId": eligibility.item_id,
            "tier": eligibility.tier,
            "currentLanes": eligibility.current_lanes,
            "targetLanes": eligibility.target_lanes,
            "constructionId": eligibility.construction_id,
            "currentConstruction": eligibility.current_construction,
            "laneDelta": eligibility.lane_delta,
            "constructionAfterAdjustment": eligibility.construction_after_adjustment,
            "support": {
                "supported": supported,
                "reason": eligibility.unsupported_reason,
            },
            "limits": {
                "maxPlayerLanes": MAX_PLAYER_BELT_LANES,
                "projectionBytes": MAX_PROJECTION_BYTES,
            },
        });
        if serde_json::to_vec(&value)?.len() > MAX_PROJECTION_BYTES {
            bail!("native ordinary belt lane context exceeds the byte limit")
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
        command::{RecordPatch, SimulationCommandPatch},
    };

    const REGISTRY: &str = "ordinary-belt-lane-mod-test";

    fn catalog() -> RuntimeCatalog {
        let snapshot: CatalogSnapshot = serde_json::from_value(json!({
            "protocolVersion": CORE_PROTOCOL_VERSION,
            "registryFingerprint": REGISTRY,
            "planets": [
                { "id": "home", "systemId": "helios", "kind": "terrestrial", "orbitIndex": 1 },
                { "id": "other", "systemId": "helios", "kind": "terrestrial", "orbitIndex": 2 }
            ],
            "items": [{ "id": "mod_item_omega", "kind": "solid" }],
            "buildings": [
                { "id": "mod_source", "kind": "machine", "speed": 1, "inputCapacity": 10, "outputCapacity": 10 },
                { "id": "mod_target", "kind": "storage", "speed": 1, "inputCapacity": 10, "outputCapacity": 10, "accepts": "solid" },
                { "id": "interstellar_logistics_station", "kind": "station", "speed": 1, "inputCapacity": 10, "outputCapacity": 10 }
            ],
            "recipes": [],
            "constructions": [
                { "id": "conveyor_belt_mk1", "outputAmount": 1, "costs": [{ "itemId": "mod_item_omega", "amount": 1 }] },
                { "id": "conveyor_belt_mk2", "outputAmount": 1, "costs": [{ "itemId": "mod_item_omega", "amount": 1 }] },
                { "id": "conveyor_belt_mk3", "outputAmount": 1, "costs": [{ "itemId": "mod_item_omega", "amount": 1 }] }
            ],
            "belts": [{ "tier": 1, "speed": 6 }, { "tier": 2, "speed": 12 }, { "tier": 3, "speed": 30 }, { "tier": 4, "speed": 60 }],
            "technologies": []
        }))
        .unwrap();
        RuntimeCatalog::validate(snapshot, REGISTRY).unwrap()
    }

    fn entity(id: &str, kind: &str, building_id: &str, planet_id: &str) -> Value {
        json!({
            "id": id, "kind": kind, "planetId": planet_id, "buildingId": building_id,
            "interactionLocked": false, "machineCount": 1, "minerCount": 0,
            "inputs": {}, "outputs": {}, "progress": 0, "routingCursor": 0,
            "utilization": 0, "productionRate": 0
        })
    }

    fn belt(id: &str, planet_id: &str, tier: u64, lanes: u64) -> Value {
        json!({
            "id": id, "planetId": planet_id, "source": "MOD/源-一", "target": "MOD/目标-二",
            "itemId": "mod_item_omega", "lanes": lanes, "tier": tier, "sorterTier": tier.min(3),
            "progress": 0, "priority": 1, "stackSize": 1, "monitorEnabled": false,
            "totalTransferred": 0, "congestion": 0, "lastFlow": 0, "routeMode": "auto",
            "modPayload": { "opaque": true }
        })
    }

    fn state(stock: Value, belt_value: Value) -> CoreState {
        CoreState::from_public_v47_parts(
            CoreCheckpointIdentity {
                slot: "normal-main".to_owned(),
                generation: 1,
                root_hash: "a".repeat(64),
                revision: 11,
                state_version: 47,
                mode: "normal".to_owned(),
                registry_fingerprint: REGISTRY.to_owned(),
                base_primary_checksum: "12345678".to_owned(),
            },
            json!({
                "version": 47, "mode": "normal", "activePlanetId": "home", "elapsedSeconds": 10,
                "paused": false, "construction": { "conveyor_belt_mk1": stock },
                "research": { "completedTechIds": [] }, "settings": { "simulationSpeed": 1 },
                "exploration": { "colonizedPlanetIds": ["home"], "unlockedSystemIds": ["helios"] }
            })
            .as_object()
            .unwrap()
            .clone(),
            vec![
                serde_json::to_string(&entity("MOD/源-一", "machine", "mod_source", "home"))
                    .unwrap(),
                serde_json::to_string(&entity("MOD/目标-二", "storage", "mod_target", "home"))
                    .unwrap(),
            ],
            vec![serde_json::to_string(&belt_value).unwrap()],
            catalog(),
        )
        .unwrap()
    }

    fn command(projection: &Value) -> SimulationCommandPatch {
        serde_json::from_value(json!({
            "protocolVersion": CORE_PROTOCOL_VERSION,
            "baseRevision": projection["revision"],
            "topLevelChanges": [{
                "path": ["construction", projection["constructionId"]],
                "operation": "set", "value": projection["constructionAfterAdjustment"]
            }],
            "changedEntities": [], "addedEntities": [], "removedEntityIds": [],
            "changedBelts": [{
                "id": projection["beltId"],
                "changes": [{ "path": ["lanes"], "operation": "set", "value": projection["targetLanes"] }]
            }],
            "addedBelts": [], "removedBeltIds": []
        })).unwrap()
    }

    #[test]
    fn mod_ids_increase_and_decrease_use_exact_atomic_inventory() {
        let mut increased = state(Value::from(7), belt("MOD/线路-一", "home", 1, 4));
        let before = increased.canonical_sha256().unwrap();
        let projection = increased
            .construction_belt_lane_context_projection(11, REGISTRY, "MOD/线路-一", 6)
            .unwrap();
        assert_eq!(projection["sourceId"], "MOD/源-一");
        assert_eq!(projection["itemId"], "mod_item_omega");
        assert_eq!(projection["laneDelta"], 2);
        assert_eq!(projection["constructionAfterAdjustment"], 5);
        assert_eq!(increased.canonical_sha256().unwrap(), before);
        increased
            .apply_player_authority_command(&command(&projection))
            .unwrap();
        assert_eq!(increased.parse_belt(0).unwrap()["lanes"], 6);
        assert_eq!(
            increased.parse_belt(0).unwrap()["modPayload"]["opaque"],
            true
        );
        assert_eq!(
            increased.base_value()["construction"]["conveyor_belt_mk1"],
            5
        );

        let projection = increased
            .construction_belt_lane_context_projection(12, REGISTRY, "MOD/线路-一", 2)
            .unwrap();
        assert_eq!(projection["laneDelta"], -4);
        assert_eq!(projection["constructionAfterAdjustment"], 9);
        increased
            .apply_player_authority_command(&command(&projection))
            .unwrap();
        assert_eq!(increased.parse_belt(0).unwrap()["lanes"], 2);
        assert_eq!(
            increased.base_value()["construction"]["conveyor_belt_mk1"],
            9
        );
    }

    #[test]
    fn forged_inventory_fields_and_stale_revision_fail_without_mutation() {
        let current = state(Value::from(7), belt("MOD/线路-一", "home", 1, 4));
        let projection = current
            .construction_belt_lane_context_projection(11, REGISTRY, "MOD/线路-一", 6)
            .unwrap();
        let mut candidates = Vec::new();
        let mut forged = command(&projection);
        forged.top_level_changes[0].value = Some(Value::from(6));
        candidates.push(forged);
        let mut mixed = command(&projection);
        mixed.changed_belts[0].changes.push(ValuePatch {
            path: vec![PathSegment::Key("priority".to_owned())],
            operation: "set".to_owned(),
            value: Some(Value::from(2)),
        });
        candidates.push(mixed);
        let mut other = command(&projection);
        other.changed_belts = vec![RecordPatch {
            id: "other".to_owned(),
            changes: other.changed_belts[0].changes.clone(),
        }];
        candidates.push(other);
        for candidate in candidates {
            let hash = current.canonical_sha256().unwrap();
            assert!(
                current
                    .validate_player_authority_command(&candidate)
                    .is_err()
            );
            assert_eq!(current.canonical_sha256().unwrap(), hash);
        }
        let replacement = state(Value::from(8), belt("MOD/线路-一", "home", 1, 4));
        assert!(
            replacement
                .validate_player_authority_command(&command(&projection))
                .is_err()
        );
    }

    #[test]
    fn special_topology_tier_limits_stock_and_overflow_fail_closed() {
        let mut port = belt("belt-port", "home", 1, 4);
        port["targetPortIndex"] = Value::from(0);
        let special = state(Value::from(7), port);
        assert_eq!(
            special
                .construction_belt_lane_context_projection(11, REGISTRY, "belt-port", 5)
                .unwrap()["support"]["reason"],
            "unsupported-belt-domain"
        );

        let tier = state(Value::from(7), belt("belt-tier", "home", 4, 4));
        assert_eq!(
            tier.construction_belt_lane_context_projection(11, REGISTRY, "belt-tier", 5)
                .unwrap()["support"]["reason"],
            "unsupported-belt-tier"
        );

        let shortage = state(Value::from(1), belt("belt-stock", "home", 1, 4));
        assert_eq!(
            shortage
                .construction_belt_lane_context_projection(11, REGISTRY, "belt-stock", 6)
                .unwrap()["support"]["reason"],
            "insufficient-construction"
        );

        let overflow = state(
            Value::from(MAX_JAVASCRIPT_SAFE_INTEGER),
            belt("belt-overflow", "home", 1, 4),
        );
        assert_eq!(
            overflow
                .construction_belt_lane_context_projection(11, REGISTRY, "belt-overflow", 3)
                .unwrap()["support"]["reason"],
            "refund-overflow"
        );

        let grandfathered = state(Value::from(0), belt("belt-old", "home", 1, 5_000));
        assert!(
            grandfathered
                .construction_belt_lane_context_projection(11, REGISTRY, "belt-old", 4_999)
                .unwrap()["support"]["supported"]
                .as_bool()
                .unwrap()
        );
        assert_eq!(
            grandfathered
                .construction_belt_lane_context_projection(11, REGISTRY, "belt-old", 5_001)
                .unwrap()["support"]["reason"],
            "target-lanes-exceed-limit"
        );
    }

    #[test]
    fn request_identity_and_projection_budget_are_strict() {
        let state = state(Value::from(7), belt("MOD/线路-一", "home", 1, 4));
        for result in [
            state.construction_belt_lane_context_projection(10, REGISTRY, "MOD/线路-一", 5),
            state.construction_belt_lane_context_projection(11, "other", "MOD/线路-一", 5),
            state.construction_belt_lane_context_projection(11, REGISTRY, "bad\nid", 5),
        ] {
            assert!(result.is_err());
        }
        let projection = state
            .construction_belt_lane_context_projection(11, REGISTRY, "MOD/线路-一", 5)
            .unwrap();
        assert!(serde_json::to_vec(&projection).unwrap().len() <= MAX_PROJECTION_BYTES);
    }
}
