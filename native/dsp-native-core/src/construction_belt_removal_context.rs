//! Same-revision proof and durable gate for recycling one ordinary belt.
//!
//! Only a built-in Mk.I/Mk.II/Mk.III route between ordinary active-planet
//! endpoints is covered. The projection and command validator share the same
//! eligibility function, so the renderer cannot invent a refund or remove a
//! special-port route after reading a stale projection.

use anyhow::{anyhow, bail};
use serde_json::{Map, Value, json};

use crate::{
    command::{PathSegment, SimulationCommandPatch, ValuePatch},
    state::CoreState,
};

const PROJECTION_TYPE: &str = "construction-belt-removal-context-v1";
const MAX_PROJECTION_BYTES: usize = 1_048_576;
const MAX_OPAQUE_ID_BYTES: usize = 512;
const MAX_JAVASCRIPT_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

fn valid_opaque_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= MAX_OPAQUE_ID_BYTES && !value.chars().any(char::is_control)
}

fn builtin_construction_id(tier: u8) -> Option<&'static str> {
    match tier {
        1 => Some("conveyor_belt_mk1"),
        2 => Some("conveyor_belt_mk2"),
        3 => Some("conveyor_belt_mk3"),
        _ => None,
    }
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
        .ok_or_else(|| anyhow!("native ordinary belt removal construction inventory is invalid"))?;
    let value = value.floor().max(0.0);
    if value > MAX_JAVASCRIPT_SAFE_INTEGER as f64 {
        bail!("native ordinary belt removal construction inventory exceeds the safe integer limit")
    }
    Ok(value as u64)
}

fn safe_positive_integer(value: Option<&Value>, label: &str) -> anyhow::Result<u64> {
    value
        .and_then(Value::as_u64)
        .filter(|value| *value > 0 && *value <= MAX_JAVASCRIPT_SAFE_INTEGER)
        .ok_or_else(|| {
            anyhow!("native ordinary belt removal {label} is not a positive safe integer")
        })
}

fn endpoint(state: &CoreState, entity_id: &str) -> anyhow::Result<Option<Map<String, Value>>> {
    let Some(index) = state.entity_index.get(entity_id).copied() else {
        return Ok(None);
    };
    let value = state.parse_entity(index)?;
    let object = value
        .as_object()
        .ok_or_else(|| anyhow!("native ordinary belt removal endpoint is invalid"))?;
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
    pub active_planet_id: String,
    pub belt_id: String,
    pub planet_id: Option<String>,
    pub source_id: Option<String>,
    pub target_id: Option<String>,
    pub tier: Option<u8>,
    pub lanes: Option<u64>,
    pub construction_id: Option<String>,
    pub current_construction: Option<u64>,
    pub refund_after_removal: Option<u64>,
    pub unsupported_reason: Option<&'static str>,
}

impl Eligibility {
    fn unsupported(mut self, reason: &'static str) -> Self {
        self.unsupported_reason = Some(reason);
        self.refund_after_removal = None;
        self
    }
}

/// Re-derives the complete refund and topology proof used by projection and
/// durable command validation. It reads one belt and its two endpoint rows.
pub(crate) fn eligibility(state: &CoreState, belt_id: &str) -> anyhow::Result<Eligibility> {
    let active_planet_id = state
        .base_value()
        .get("activePlanetId")
        .and_then(Value::as_str)
        .filter(|value| valid_opaque_id(value))
        .ok_or_else(|| anyhow!("native ordinary belt removal active planet is invalid"))?
        .to_owned();
    let mut result = Eligibility {
        active_planet_id: active_planet_id.clone(),
        belt_id: belt_id.to_owned(),
        planet_id: None,
        source_id: None,
        target_id: None,
        tier: None,
        lanes: None,
        construction_id: None,
        current_construction: None,
        refund_after_removal: None,
        unsupported_reason: None,
    };
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
    if !valid_opaque_id(source_id) || !valid_opaque_id(target_id) || source_id == target_id {
        return Ok(result.unsupported("invalid-belt"));
    }
    result.source_id = Some(source_id.to_owned());
    result.target_id = Some(target_id.to_owned());
    if belt.contains_key("targetPortIndex") || belt.contains_key("elevatorOutputIndex") {
        return Ok(result.unsupported("unsupported-belt-domain"));
    }
    let tier_value = safe_positive_integer(belt.get("tier"), "tier");
    let Ok(tier_value) = tier_value else {
        return Ok(result.unsupported("invalid-belt"));
    };
    let Ok(tier) = u8::try_from(tier_value) else {
        return Ok(result.unsupported("unsupported-belt-tier"));
    };
    result.tier = Some(tier);
    let Some(construction_id) = builtin_construction_id(tier) else {
        return Ok(result.unsupported("unsupported-belt-tier"));
    };
    result.construction_id = Some(construction_id.to_owned());
    if !state.catalog.belt_speeds.contains_key(&tier)
        || !state.catalog.constructions.contains_key(construction_id)
    {
        return Ok(result.unsupported("missing-construction-definition"));
    }
    let lanes = match safe_positive_integer(belt.get("lanes"), "lanes") {
        Ok(value) => value,
        Err(_) => return Ok(result.unsupported("invalid-belt")),
    };
    result.lanes = Some(lanes);

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
        .ok_or_else(|| anyhow!("native ordinary belt removal construction inventory is missing"))?;
    let current = match normalized_construction_inventory(construction.get(construction_id)) {
        Ok(value) => value,
        Err(_) => return Ok(result.unsupported("invalid-construction-inventory")),
    };
    result.current_construction = Some(current);
    let Some(refund) = current
        .checked_add(lanes)
        .filter(|value| *value <= MAX_JAVASCRIPT_SAFE_INTEGER)
    else {
        return Ok(result.unsupported("refund-overflow"));
    };
    result.refund_after_removal = Some(refund);
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
        .ok_or_else(|| anyhow!("native ordinary belt removal refund patch is missing"))?;
    if matching.next().is_some() || change.operation != "set" {
        bail!("native ordinary belt removal refund patch is not canonical")
    }
    change
        .value
        .as_ref()
        .ok_or_else(|| anyhow!("native ordinary belt removal refund set has no value"))
}

pub(crate) fn validate_command(
    state: &CoreState,
    command: &SimulationCommandPatch,
) -> anyhow::Result<()> {
    if command.removed_belt_ids.len() != 1
        || command.top_level_changes.len() != 1
        || !command.changed_entities.is_empty()
        || !command.added_entities.is_empty()
        || !command.removed_entity_ids.is_empty()
        || !command.changed_belts.is_empty()
        || !command.added_belts.is_empty()
    {
        bail!("native ordinary belt removal command shape is invalid")
    }
    let belt_id = &command.removed_belt_ids[0];
    if !valid_opaque_id(belt_id) {
        bail!("native ordinary belt removal command ID is invalid")
    }
    let eligibility = eligibility(state, belt_id)?;
    if let Some(reason) = eligibility.unsupported_reason {
        bail!("native ordinary belt removal is unsupported: {reason}")
    }
    let construction_id = eligibility
        .construction_id
        .ok_or_else(|| anyhow!("native ordinary belt removal construction ID is missing"))?;
    let refund = eligibility
        .refund_after_removal
        .ok_or_else(|| anyhow!("native ordinary belt removal refund is missing"))?;
    if exact_set_patch(
        &command.top_level_changes,
        &["construction", &construction_id],
    )?
    .as_u64()
        != Some(refund)
    {
        bail!("native ordinary belt removal refund is invalid")
    }
    Ok(())
}

impl CoreState {
    pub fn construction_belt_removal_context_projection(
        &self,
        expected_revision: u64,
        expected_registry_fingerprint: &str,
        belt_id: &str,
    ) -> anyhow::Result<Value> {
        if expected_revision != self.revision
            || expected_registry_fingerprint != self.catalog.snapshot.registry_fingerprint
            || !valid_opaque_id(belt_id)
        {
            bail!("native ordinary belt removal context request is invalid")
        }
        let eligibility = eligibility(self, belt_id)?;
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
            },
            "activePlanetId": eligibility.active_planet_id,
            "beltId": eligibility.belt_id,
            "planetId": eligibility.planet_id,
            "sourceId": eligibility.source_id,
            "targetId": eligibility.target_id,
            "tier": eligibility.tier,
            "lanes": eligibility.lanes,
            "constructionId": eligibility.construction_id,
            "currentConstruction": eligibility.current_construction,
            "refundAfterRemoval": eligibility.refund_after_removal,
            "support": {
                "supported": supported,
                "reason": eligibility.unsupported_reason,
            },
            "limits": { "projectionBytes": MAX_PROJECTION_BYTES },
        });
        if serde_json::to_vec(&value)?.len() > MAX_PROJECTION_BYTES {
            bail!("native ordinary belt removal context exceeds the byte limit")
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
    };

    const REGISTRY: &str = "ordinary-belt-removal-mod-test";

    fn catalog() -> RuntimeCatalog {
        let snapshot: CatalogSnapshot = serde_json::from_value(json!({
            "protocolVersion": CORE_PROTOCOL_VERSION,
            "registryFingerprint": REGISTRY,
            "planets": [
                { "id": "home", "systemId": "helios", "kind": "terrestrial", "orbitIndex": 1 },
                { "id": "other", "systemId": "helios", "kind": "terrestrial", "orbitIndex": 2 },
                { "id": "giant", "systemId": "helios", "kind": "gas-giant", "orbitIndex": 3 }
            ],
            "items": [{ "id": "mod_item", "kind": "solid" }],
            "buildings": [
                { "id": "mod_source", "kind": "machine", "speed": 1, "inputCapacity": 10, "outputCapacity": 10 },
                { "id": "mod_target", "kind": "storage", "speed": 1, "inputCapacity": 10, "outputCapacity": 10, "accepts": "solid" },
                { "id": "interstellar_logistics_station", "kind": "station", "speed": 1, "inputCapacity": 10, "outputCapacity": 10 }
            ],
            "recipes": [],
            "constructions": [
                { "id": "conveyor_belt_mk1", "outputAmount": 3, "costs": [{ "itemId": "mod_item", "amount": 1 }] },
                { "id": "conveyor_belt_mk2", "outputAmount": 3, "costs": [{ "itemId": "mod_item", "amount": 1 }] },
                { "id": "conveyor_belt_mk3", "outputAmount": 3, "costs": [{ "itemId": "mod_item", "amount": 1 }] }
            ],
            "belts": [
                { "tier": 1, "speed": 6 },
                { "tier": 2, "speed": 12 },
                { "tier": 3, "speed": 30 },
                { "tier": 4, "speed": 60 }
            ],
            "technologies": []
        }))
        .unwrap();
        RuntimeCatalog::validate(snapshot, REGISTRY).unwrap()
    }

    fn entity(id: &str, kind: &str, building_id: &str, planet_id: &str) -> Value {
        json!({
            "id": id,
            "kind": kind,
            "planetId": planet_id,
            "interactionLocked": false,
            "buildingId": building_id,
            "machineCount": 1,
            "minerCount": 0,
            "inputs": {},
            "outputs": {},
            "progress": 0,
            "routingCursor": 0,
            "utilization": 0,
            "productionRate": 0
        })
    }

    fn belt(id: &str, planet_id: &str, tier: u64, lanes: u64) -> Value {
        json!({
            "id": id,
            "planetId": planet_id,
            "source": "MOD/源-一",
            "target": "MOD/目标-二",
            "itemId": "mod_item",
            "lanes": lanes,
            "tier": tier,
            "sorterTier": tier.min(3),
            "progress": 0,
            "priority": 1,
            "stackSize": 1,
            "monitorEnabled": false,
            "totalTransferred": 0,
            "congestion": 0,
            "lastFlow": 0,
            "routeMode": "auto"
        })
    }

    fn state(active_planet: &str, construction: Value, belt_value: Value) -> CoreState {
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
                "version": 47,
                "mode": "normal",
                "activePlanetId": active_planet,
                "elapsedSeconds": 10,
                "paused": false,
                "construction": construction,
                "research": { "completedTechIds": [] },
                "settings": { "simulationSpeed": 1 },
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
                "operation": "set",
                "value": projection["refundAfterRemoval"]
            }],
            "changedEntities": [],
            "addedEntities": [],
            "removedEntityIds": [],
            "changedBelts": [],
            "addedBelts": [],
            "removedBeltIds": [projection["beltId"]]
        }))
        .unwrap()
    }

    #[test]
    fn exact_mod_registry_context_refunds_one_builtin_belt_and_is_read_only() {
        let mut state = state(
            "home",
            json!({ "conveyor_belt_mk1": 7 }),
            belt("MOD/线路-一", "home", 1, 4),
        );
        let before = state.canonical_sha256().unwrap();
        let projection = state
            .construction_belt_removal_context_projection(11, REGISTRY, "MOD/线路-一")
            .unwrap();
        assert_eq!(projection["projectionType"], PROJECTION_TYPE);
        assert_eq!(projection["activePlanetId"], "home");
        assert_eq!(projection["constructionId"], "conveyor_belt_mk1");
        assert_eq!(projection["currentConstruction"], 7);
        assert_eq!(projection["lanes"], 4);
        assert_eq!(projection["refundAfterRemoval"], 11);
        assert_eq!(
            projection["support"],
            json!({ "supported": true, "reason": null })
        );
        assert_eq!(state.canonical_sha256().unwrap(), before);
        assert!(serde_json::to_vec(&projection).unwrap().len() <= MAX_PROJECTION_BYTES);

        let durable = command(&projection);
        state.validate_player_authority_command(&durable).unwrap();
        assert_eq!(state.canonical_sha256().unwrap(), before);
        let receipt = state.apply_player_authority_command(&durable).unwrap();
        assert_eq!(receipt.changed_belt_ids, ["MOD/线路-一"]);
        assert!(receipt.topology_dirty);
        assert_eq!(state.base_value()["construction"]["conveyor_belt_mk1"], 11);
        assert_eq!(state.belt_index.len(), 0);
    }

    #[test]
    fn forged_refund_mixed_fields_and_same_revision_topology_are_rejected_atomically() {
        let current_state = state(
            "home",
            json!({ "conveyor_belt_mk1": 7 }),
            belt("MOD/线路-一", "home", 1, 4),
        );
        let projection = current_state
            .construction_belt_removal_context_projection(11, REGISTRY, "MOD/线路-一")
            .unwrap();
        let mut forged = Vec::new();
        let mut refund = command(&projection);
        refund.top_level_changes[0].value = Some(Value::from(12));
        forged.push(refund);
        let mut field = command(&projection);
        field.changed_belts.push(crate::command::RecordPatch {
            id: "MOD/线路-一".to_owned(),
            changes: vec![ValuePatch {
                path: vec![PathSegment::Key("priority".to_owned())],
                operation: "set".to_owned(),
                value: Some(Value::from(2)),
            }],
        });
        forged.push(field);
        let mut repeated = command(&projection);
        repeated.removed_belt_ids.push("MOD/线路-一".to_owned());
        forged.push(repeated);
        for candidate in forged {
            let hash = current_state.canonical_sha256().unwrap();
            assert!(
                current_state
                    .validate_player_authority_command(&candidate)
                    .is_err()
            );
            assert_eq!(current_state.canonical_sha256().unwrap(), hash);
        }

        let replacement = state(
            "home",
            json!({ "conveyor_belt_mk1": 8 }),
            belt("MOD/线路-一", "home", 1, 4),
        );
        assert!(
            replacement
                .validate_player_authority_command(&command(&projection))
                .is_err()
        );
    }

    #[test]
    fn special_ports_domains_tiers_planets_and_overflow_fail_closed() {
        let mut special_port = belt("belt-port", "home", 1, 1);
        special_port["targetPortIndex"] = Value::from(0);
        let special = state("home", json!({ "conveyor_belt_mk1": 0 }), special_port);
        assert_eq!(
            special
                .construction_belt_removal_context_projection(11, REGISTRY, "belt-port")
                .unwrap()["support"]["reason"],
            "unsupported-belt-domain"
        );

        let tier = state(
            "home",
            json!({ "conveyor_belt_mk1": 0 }),
            belt("belt-tier", "home", 4, 1),
        );
        assert_eq!(
            tier.construction_belt_removal_context_projection(11, REGISTRY, "belt-tier")
                .unwrap()["support"]["reason"],
            "unsupported-belt-tier"
        );

        let other = state(
            "home",
            json!({ "conveyor_belt_mk1": 0 }),
            belt("belt-other", "other", 1, 1),
        );
        assert_eq!(
            other
                .construction_belt_removal_context_projection(11, REGISTRY, "belt-other")
                .unwrap()["support"]["reason"],
            "not-active-planet"
        );

        let giant = state(
            "giant",
            json!({ "conveyor_belt_mk1": 0 }),
            belt("belt-giant", "giant", 1, 1),
        );
        assert_eq!(
            giant
                .construction_belt_removal_context_projection(11, REGISTRY, "belt-giant")
                .unwrap()["support"]["reason"],
            "unsupported-active-planet"
        );

        let overflow = state(
            "home",
            json!({ "conveyor_belt_mk1": MAX_JAVASCRIPT_SAFE_INTEGER }),
            belt("belt-overflow", "home", 1, 1),
        );
        assert_eq!(
            overflow
                .construction_belt_removal_context_projection(11, REGISTRY, "belt-overflow")
                .unwrap()["support"]["reason"],
            "refund-overflow"
        );
    }

    #[test]
    fn stale_fingerprint_invalid_ids_missing_belt_and_invalid_inventory_are_bounded() {
        let invalid_stock = state(
            "home",
            json!({ "conveyor_belt_mk1": "bad" }),
            belt("belt-stock", "home", 1, 1),
        );
        let projection = invalid_stock
            .construction_belt_removal_context_projection(11, REGISTRY, "belt-stock")
            .unwrap();
        assert_eq!(
            projection["support"]["reason"],
            "invalid-construction-inventory"
        );
        assert!(projection["refundAfterRemoval"].is_null());
        let missing = invalid_stock
            .construction_belt_removal_context_projection(11, REGISTRY, "unknown-belt")
            .unwrap();
        assert_eq!(missing["support"]["reason"], "belt-not-found");
        assert!(missing["tier"].is_null());
        for rejected in [
            invalid_stock.construction_belt_removal_context_projection(10, REGISTRY, "belt-stock"),
            invalid_stock.construction_belt_removal_context_projection(11, "other", "belt-stock"),
            invalid_stock.construction_belt_removal_context_projection(11, REGISTRY, "bad\nid"),
            invalid_stock.construction_belt_removal_context_projection(
                11,
                REGISTRY,
                &"界".repeat(171),
            ),
        ] {
            assert!(rejected.is_err());
        }
    }
}
