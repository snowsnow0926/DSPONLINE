//! Bounded, same-revision context and durable gate for one ordinary belt.
//!
//! This intentionally covers only a newly appended built-in Mk.I/Mk.II/Mk.III
//! route between already configured ordinary endpoints. Any automatic recipe,
//! item, station-slot, special-port, elevator, or parallel-route mutation stays
//! fail-closed until its complete domain transaction is natively typed.

use anyhow::{anyhow, bail};
use serde_json::{Map, Value, json};

use crate::{
    command::{PathSegment, SimulationCommandPatch, ValuePatch},
    state::CoreState,
};

const PROJECTION_TYPE: &str = "construction-belt-placement-context-v1";
const MAX_PROJECTION_BYTES: usize = 1_048_576;
const MAX_OPAQUE_ID_BYTES: usize = 512;
const MAX_JAVASCRIPT_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const MAX_BELT_LANES: u64 = 4_096;

fn valid_opaque_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= MAX_OPAQUE_ID_BYTES && !value.chars().any(char::is_control)
}

fn technology_is_completed(state: &CoreState, technology_id: &str) -> bool {
    state
        .base_value()
        .get("research")
        .and_then(|value| value.get("completedTechIds"))
        .and_then(Value::as_array)
        .is_some_and(|ids| {
            ids.iter()
                .any(|value| value.as_str() == Some(technology_id))
        })
}

fn safe_integer(value: Option<&Value>, label: &str) -> anyhow::Result<u64> {
    match value {
        None | Some(Value::Null) => Ok(0),
        Some(value) => value
            .as_u64()
            .filter(|value| *value <= MAX_JAVASCRIPT_SAFE_INTEGER)
            .ok_or_else(|| anyhow!("native ordinary belt {label} is not a safe integer")),
    }
}

fn required_safe_integer(value: Option<&Value>, label: &str) -> anyhow::Result<u64> {
    value
        .and_then(Value::as_u64)
        .filter(|value| *value <= MAX_JAVASCRIPT_SAFE_INTEGER)
        .ok_or_else(|| anyhow!("native ordinary belt {label} is not a required safe integer"))
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

fn recipe<'a>(
    state: &'a CoreState,
    entity: &Map<String, Value>,
) -> Option<&'a crate::catalog::RecipeDefinition> {
    entity
        .get("recipeId")
        .and_then(Value::as_str)
        .and_then(|recipe_id| state.catalog.recipes.get(recipe_id))
}

fn source_is_configured(state: &CoreState, entity: &Map<String, Value>, item_id: &str) -> bool {
    match entity.get("kind").and_then(Value::as_str) {
        Some("vein") => entity.get("resourceId").and_then(Value::as_str) == Some(item_id),
        Some("machine") => recipe(state, entity).is_some_and(|recipe| {
            recipe
                .outputs
                .iter()
                .any(|output| output.item_id == item_id)
        }),
        Some("storage" | "splitter") => {
            entity.get("storedItemId").and_then(Value::as_str) == Some(item_id)
        }
        _ => false,
    }
}

fn accepts_item_kind(state: &CoreState, building_id: &str, item_id: &str) -> bool {
    let Some(building) = state.catalog.buildings.get(building_id) else {
        return false;
    };
    let Some(item) = state.catalog.items.get(item_id) else {
        return false;
    };
    match building.accepts.as_deref().unwrap_or("any") {
        "any" => true,
        "solid" => item.kind == "solid" || item.kind == "matrix",
        accepted => accepted == item.kind,
    }
}

fn target_is_configured(state: &CoreState, entity: &Map<String, Value>, item_id: &str) -> bool {
    let building_id = entity.get("buildingId").and_then(Value::as_str);
    match entity.get("kind").and_then(Value::as_str) {
        Some("machine") => recipe(state, entity)
            .is_some_and(|recipe| recipe.inputs.iter().any(|input| input.item_id == item_id)),
        Some("storage" | "splitter") => building_id.is_some_and(|building_id| {
            entity.get("storedItemId").and_then(Value::as_str) == Some(item_id)
                && accepts_item_kind(state, building_id, item_id)
        }),
        Some("power") => building_id.is_some_and(|building_id| {
            state
                .catalog
                .buildings
                .get(building_id)
                .is_some_and(|building| {
                    building
                        .fuel_item_ids
                        .iter()
                        .any(|candidate| candidate == item_id)
                })
                && entity.get("fuelItemId").and_then(Value::as_str) == Some(item_id)
        }),
        _ => false,
    }
}

fn endpoint(state: &CoreState, entity_id: &str) -> anyhow::Result<Option<(usize, Value)>> {
    let Some(index) = state.entity_index.get(entity_id).copied() else {
        return Ok(None);
    };
    let value = state.parse_entity(index)?;
    if !value.is_object() {
        bail!("native ordinary belt endpoint is invalid")
    }
    Ok(Some((index, value)))
}

#[derive(Debug, Clone)]
pub(crate) struct Eligibility {
    pub active_planet_id: String,
    pub construction_id: Option<String>,
    pub available: Option<u64>,
    pub append_belt_index: Option<u64>,
    pub next_belt_id: Option<String>,
    pub remaining_construction: Option<u64>,
    pub next_id_after_placement: Option<u64>,
    pub belt_template: Option<Map<String, Value>>,
    pub unsupported_reason: Option<&'static str>,
}

impl Eligibility {
    fn unsupported(mut self, reason: &'static str) -> Self {
        self.unsupported_reason = Some(reason);
        self.remaining_construction = None;
        self.next_id_after_placement = None;
        self.belt_template = None;
        self
    }
}

/// Re-derives every current-revision fact needed by both projection and gate.
pub(crate) fn eligibility(
    state: &CoreState,
    source_id: &str,
    target_id: &str,
    item_id: &str,
    tier: u8,
    lanes: u64,
) -> anyhow::Result<Eligibility> {
    let active_planet_id = state
        .base_value()
        .get("activePlanetId")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("native ordinary belt active planet is invalid"))?
        .to_owned();
    let mut result = Eligibility {
        active_planet_id: active_planet_id.clone(),
        construction_id: None,
        available: None,
        append_belt_index: None,
        next_belt_id: None,
        remaining_construction: None,
        next_id_after_placement: None,
        belt_template: None,
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
    if lanes == 0 || lanes > MAX_BELT_LANES {
        return Ok(result.unsupported("invalid-lanes"));
    }
    let Some(construction_id) = builtin_construction_id(tier) else {
        return Ok(result.unsupported("unsupported-belt-tier"));
    };
    result.construction_id = Some(construction_id.to_owned());
    if !state.catalog.belt_speeds.contains_key(&tier) {
        return Ok(result.unsupported("unsupported-belt-tier"));
    }
    let Some(construction_definition) = state.catalog.constructions.get(construction_id) else {
        return Ok(result.unsupported("missing-construction-definition"));
    };
    if construction_definition
        .required_tech_id
        .as_deref()
        .is_some_and(|technology_id| !technology_is_completed(state, technology_id))
    {
        return Ok(result.unsupported("technology-locked"));
    }
    if !state.catalog.items.contains_key(item_id) {
        return Ok(result.unsupported("unknown-item"));
    }
    let construction = state
        .base_value()
        .get("construction")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("native ordinary belt construction inventory is invalid"))?;
    let available = safe_integer(construction.get(construction_id), "construction inventory")?;
    result.available = Some(available);
    if available < lanes {
        return Ok(result.unsupported("insufficient-inventory"));
    }
    if source_id == target_id {
        return Ok(result.unsupported("same-endpoint"));
    }
    let Some((source_index, source_value)) = endpoint(state, source_id)? else {
        return Ok(result.unsupported("source-not-found"));
    };
    let Some((_target_index, target_value)) = endpoint(state, target_id)? else {
        return Ok(result.unsupported("target-not-found"));
    };
    let source = source_value.as_object().expect("endpoint validated object");
    let target = target_value.as_object().expect("endpoint validated object");
    if source.get("planetId").and_then(Value::as_str) != Some(active_planet_id.as_str())
        || target.get("planetId").and_then(Value::as_str) != Some(active_planet_id.as_str())
    {
        return Ok(result.unsupported("not-active-planet"));
    }
    if source.get("interactionLocked").and_then(Value::as_bool) == Some(true)
        || target.get("interactionLocked").and_then(Value::as_bool) == Some(true)
    {
        return Ok(result.unsupported("interaction-locked"));
    }
    for (entity, reason) in [
        (source, "unsupported-source-domain"),
        (target, "unsupported-target-domain"),
    ] {
        let kind = entity
            .get("kind")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if kind == "station" {
            return Ok(result.unsupported(reason));
        }
        if kind != "vein" {
            let Some(building_id) = entity.get("buildingId").and_then(Value::as_str) else {
                return Ok(result.unsupported(reason));
            };
            let Some(building) = state.catalog.buildings.get(building_id) else {
                return Ok(result.unsupported(reason));
            };
            if endpoint_domain_is_special(building_id)
                || !building_kind_matches(kind, &building.kind)
            {
                return Ok(result.unsupported(reason));
            }
        }
    }
    if !source_is_configured(state, source, item_id) {
        return Ok(result.unsupported("source-not-configured"));
    }
    if !target_is_configured(state, target, item_id) {
        return Ok(result.unsupported("target-not-configured"));
    }
    for belt_index in state.incident_belt_indices(source_index) {
        if belt_index >= state.belts.ids.len() {
            bail!("native ordinary belt adjacency is invalid")
        }
        let belt = state.parse_belt(belt_index)?;
        if belt.get("source").and_then(Value::as_str) == Some(source_id)
            && belt.get("target").and_then(Value::as_str) == Some(target_id)
            && belt.get("itemId").and_then(Value::as_str) == Some(item_id)
        {
            return Ok(result.unsupported("matching-route-exists"));
        }
    }

    let append_belt_index = u64::try_from(state.belt_index.len())
        .ok()
        .filter(|value| *value <= MAX_JAVASCRIPT_SAFE_INTEGER)
        .ok_or_else(|| anyhow!("native ordinary belt append index is invalid"))?;
    result.append_belt_index = Some(append_belt_index);
    let next_id = required_safe_integer(state.base_value().get("nextId"), "next ID")?;
    if next_id == MAX_JAVASCRIPT_SAFE_INTEGER {
        return Ok(result.unsupported("next-id-exhausted"));
    }
    let next_belt_id = format!("belt_{next_id}");
    result.next_belt_id = Some(next_belt_id.clone());
    if state.belt_index.contains_key(&next_belt_id) {
        return Ok(result.unsupported("next-id-collision"));
    }
    let settings = state
        .base_value()
        .get("settings")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("native ordinary belt settings are invalid"))?;
    let requested_stack_size =
        safe_integer(settings.get("defaultBeltStackSize"), "default stack size")?;
    if !matches!(requested_stack_size, 1 | 2 | 4) {
        return Ok(result.unsupported("invalid-default-settings"));
    }
    let stack_size = match requested_stack_size {
        2 if technology_is_completed(state, "high_speed_logistics") => 2,
        4 if technology_is_completed(state, "super_magnetic_logistics") => 4,
        1 => 1,
        _ => 1,
    };
    let Some(route_mode) = settings
        .get("defaultBeltRouteMode")
        .and_then(Value::as_str)
        .filter(|mode| matches!(*mode, "auto" | "bezier" | "upper" | "lower"))
    else {
        return Ok(result.unsupported("invalid-default-settings"));
    };
    let remaining_construction = available
        .checked_sub(lanes)
        .ok_or_else(|| anyhow!("native ordinary belt stock subtraction overflow"))?;
    let next_id_after_placement = next_id
        .checked_add(1)
        .ok_or_else(|| anyhow!("native ordinary belt next ID overflow"))?;
    result.remaining_construction = Some(remaining_construction);
    result.next_id_after_placement = Some(next_id_after_placement);
    result.belt_template = Some(
        json!({
            "id": next_belt_id,
            "planetId": active_planet_id,
            "source": source_id,
            "target": target_id,
            "itemId": item_id,
            "lanes": lanes,
            "tier": tier,
            "sorterTier": tier.min(3),
            "progress": 0,
            "priority": 1,
            "stackSize": stack_size,
            "monitorEnabled": false,
            "totalTransferred": 0,
            "congestion": 0,
            "lastFlow": 0,
            "routeMode": route_mode,
        })
        .as_object()
        .expect("ordinary belt template is an object")
        .clone(),
    );
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
        .ok_or_else(|| anyhow!("native ordinary belt command patch is missing"))?;
    if matching.next().is_some() || change.operation != "set" {
        bail!("native ordinary belt command patch is not canonical")
    }
    change
        .value
        .as_ref()
        .ok_or_else(|| anyhow!("native ordinary belt command set has no value"))
}

pub(crate) fn validate_command(
    state: &CoreState,
    command: &SimulationCommandPatch,
) -> anyhow::Result<()> {
    if command.added_belts.len() != 1
        || !command.changed_belts.is_empty()
        || !command.removed_belt_ids.is_empty()
        || !command.changed_entities.is_empty()
        || !command.added_entities.is_empty()
        || !command.removed_entity_ids.is_empty()
        || command.top_level_changes.len() != 2
    {
        bail!("native ordinary belt placement command shape is invalid")
    }
    let addition = &command.added_belts[0];
    let belt = addition
        .value
        .as_object()
        .ok_or_else(|| anyhow!("native ordinary belt command value is invalid"))?;
    let source_id = belt
        .get("source")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("native ordinary belt source is missing"))?;
    let target_id = belt
        .get("target")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("native ordinary belt target is missing"))?;
    let item_id = belt
        .get("itemId")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("native ordinary belt item is missing"))?;
    let tier = belt
        .get("tier")
        .and_then(Value::as_u64)
        .and_then(|value| u8::try_from(value).ok())
        .ok_or_else(|| anyhow!("native ordinary belt tier is invalid"))?;
    let lanes = safe_integer(belt.get("lanes"), "lanes")?;
    let eligibility = eligibility(state, source_id, target_id, item_id, tier, lanes)?;
    if let Some(reason) = eligibility.unsupported_reason {
        bail!("native ordinary belt placement is unsupported: {reason}")
    }
    let append_belt_index = usize::try_from(
        eligibility
            .append_belt_index
            .ok_or_else(|| anyhow!("native ordinary belt append index is missing"))?,
    )?;
    if addition.index != append_belt_index {
        bail!("native ordinary belt is not appended")
    }
    if addition.value
        != Value::Object(
            eligibility
                .belt_template
                .ok_or_else(|| anyhow!("native ordinary belt template is missing"))?,
        )
    {
        bail!("native ordinary belt fields are not canonical")
    }
    let construction_id = eligibility
        .construction_id
        .ok_or_else(|| anyhow!("native ordinary belt construction ID is missing"))?;
    let remaining = eligibility
        .remaining_construction
        .ok_or_else(|| anyhow!("native ordinary belt remaining stock is missing"))?;
    if exact_set_patch(
        &command.top_level_changes,
        &["construction", &construction_id],
    )?
    .as_u64()
        != Some(remaining)
    {
        bail!("native ordinary belt construction debit is invalid")
    }
    let next_id = eligibility
        .next_id_after_placement
        .ok_or_else(|| anyhow!("native ordinary belt next ID is missing"))?;
    if exact_set_patch(&command.top_level_changes, &["nextId"])?.as_u64() != Some(next_id) {
        bail!("native ordinary belt next ID increment is invalid")
    }
    Ok(())
}

impl CoreState {
    // The request remains deliberately flat because it is mirrored by the
    // versioned Host/IPC contract and each field participates in the proof.
    #[allow(clippy::too_many_arguments)]
    pub fn construction_belt_placement_context_projection(
        &self,
        expected_revision: u64,
        expected_registry_fingerprint: &str,
        source_id: &str,
        target_id: &str,
        item_id: &str,
        tier: u8,
        lanes: u64,
    ) -> anyhow::Result<Value> {
        if expected_revision != self.revision
            || expected_registry_fingerprint != self.catalog.snapshot.registry_fingerprint
            || !valid_opaque_id(source_id)
            || !valid_opaque_id(target_id)
            || !valid_opaque_id(item_id)
        {
            bail!("native ordinary belt context request is invalid")
        }
        let eligibility = eligibility(self, source_id, target_id, item_id, tier, lanes)?;
        let supported = eligibility.unsupported_reason.is_none();
        let placement = supported.then(|| {
            json!({
                "remainingConstruction": eligibility.remaining_construction,
                "nextIdAfterPlacement": eligibility.next_id_after_placement,
                "beltTemplate": eligibility.belt_template,
            })
        });
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
                "sourceId": source_id,
                "targetId": target_id,
                "itemId": item_id,
                "tier": tier,
                "lanes": lanes,
            },
            "activePlanetId": eligibility.active_planet_id,
            "constructionId": eligibility.construction_id,
            "available": eligibility.available,
            "appendBeltIndex": eligibility.append_belt_index,
            "nextBeltId": eligibility.next_belt_id,
            "support": {
                "supported": supported,
                "reason": eligibility.unsupported_reason,
            },
            "placement": placement,
            "limits": { "projectionBytes": MAX_PROJECTION_BYTES },
        });
        if serde_json::to_vec(&value)?.len() > MAX_PROJECTION_BYTES {
            bail!("native ordinary belt context exceeds the byte limit")
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

    const REGISTRY: &str = "ordinary-belt-mod-test";

    fn catalog() -> RuntimeCatalog {
        let snapshot: CatalogSnapshot = serde_json::from_value(json!({
            "protocolVersion": CORE_PROTOCOL_VERSION,
            "registryFingerprint": REGISTRY,
            "planets": [
                { "id": "home", "systemId": "helios", "kind": "terrestrial", "orbitIndex": 1 },
                { "id": "other", "systemId": "helios", "kind": "terrestrial", "orbitIndex": 2 },
                { "id": "giant", "systemId": "helios", "kind": "gas-giant", "orbitIndex": 3 }
            ],
            "items": [
                { "id": "MOD/item-alpha", "kind": "solid" },
                { "id": "iron_ingot", "kind": "solid" }
            ],
            "buildings": [
                { "id": "MOD/source-machine", "kind": "machine", "speed": 1, "inputCapacity": 10, "outputCapacity": 10 },
                { "id": "MOD/target-machine", "kind": "machine", "speed": 1, "inputCapacity": 10, "outputCapacity": 10 },
                { "id": "MOD/storage", "kind": "storage", "speed": 1, "inputCapacity": 10, "outputCapacity": 10, "accepts": "solid" },
                { "id": "interstellar_logistics_station", "kind": "station", "speed": 1, "inputCapacity": 10, "outputCapacity": 10 }
            ],
            "recipes": [
                { "id": "MOD/source-recipe", "buildingId": "MOD/source-machine", "duration": 1, "inputs": [], "outputs": [{ "itemId": "MOD/item-alpha", "amount": 1 }] },
                { "id": "MOD/target-recipe", "buildingId": "MOD/target-machine", "duration": 1, "inputs": [{ "itemId": "MOD/item-alpha", "amount": 1 }], "outputs": [{ "itemId": "iron_ingot", "amount": 1 }] }
            ],
            "constructions": [
                { "id": "conveyor_belt_mk1", "outputAmount": 3, "requiredTechId": "basic_logistics", "costs": [{ "itemId": "iron_ingot", "amount": 1 }] },
                { "id": "conveyor_belt_mk2", "outputAmount": 3, "requiredTechId": "high_speed_logistics", "costs": [{ "itemId": "iron_ingot", "amount": 1 }] },
                { "id": "conveyor_belt_mk3", "outputAmount": 3, "requiredTechId": "super_magnetic_logistics", "costs": [{ "itemId": "iron_ingot", "amount": 1 }] }
            ],
            "belts": [
                { "tier": 1, "speed": 6 },
                { "tier": 2, "speed": 12 },
                { "tier": 3, "speed": 30 },
                { "tier": 4, "speed": 60 }
            ],
            "technologies": [
                { "id": "basic_logistics", "costs": [{ "itemId": "iron_ingot", "amount": 1 }], "prerequisites": [] },
                { "id": "high_speed_logistics", "costs": [{ "itemId": "iron_ingot", "amount": 1 }], "prerequisites": ["basic_logistics"] },
                { "id": "super_magnetic_logistics", "costs": [{ "itemId": "iron_ingot", "amount": 1 }], "prerequisites": ["high_speed_logistics"] }
            ]
        }))
        .unwrap();
        RuntimeCatalog::validate(snapshot, REGISTRY).unwrap()
    }

    fn machine(id: &str, building_id: &str, recipe_id: &str, planet_id: &str) -> Value {
        json!({
            "id": id,
            "kind": "machine",
            "planetId": planet_id,
            "interactionLocked": false,
            "buildingId": building_id,
            "recipeId": recipe_id,
            "machineCount": 1,
            "minerCount": 0,
            "inputs": {},
            "outputs": {},
            "progress": 0,
            "routingCursor": 0,
            "utilization": 0,
            "productionRate": 0,
            "position": { "x": 0, "y": 0 }
        })
    }

    fn fixture(
        active_planet_id: &str,
        completed: &[&str],
        next_id: u64,
        construction: Value,
        entities: Vec<Value>,
        belts: Vec<Value>,
        stack_size: u64,
    ) -> CoreState {
        let base = json!({
            "version": 47,
            "mode": "normal",
            "activePlanetId": active_planet_id,
            "elapsedSeconds": 10,
            "paused": false,
            "nextId": next_id,
            "construction": construction,
            "research": { "completedTechIds": completed },
            "settings": {
                "simulationSpeed": 1,
                "defaultBeltStackSize": stack_size,
                "defaultBeltRouteMode": "upper"
            },
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
            entities
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

    fn ordinary_state() -> CoreState {
        fixture(
            "home",
            &[
                "basic_logistics",
                "high_speed_logistics",
                "super_magnetic_logistics",
            ],
            42,
            json!({
                "conveyor_belt_mk1": 12,
                "conveyor_belt_mk2": 12,
                "conveyor_belt_mk3": 12
            }),
            vec![
                machine(
                    "MOD/源-一",
                    "MOD/source-machine",
                    "MOD/source-recipe",
                    "home",
                ),
                machine(
                    "MOD/目标-二",
                    "MOD/target-machine",
                    "MOD/target-recipe",
                    "home",
                ),
            ],
            Vec::new(),
            4,
        )
    }

    fn command(projection: &Value) -> SimulationCommandPatch {
        serde_json::from_value(json!({
            "protocolVersion": CORE_PROTOCOL_VERSION,
            "baseRevision": projection["revision"],
            "topLevelChanges": [
                {
                    "path": ["construction", projection["constructionId"]],
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
            "addedEntities": [],
            "removedEntityIds": [],
            "changedBelts": [],
            "addedBelts": [{
                "index": projection["appendBeltIndex"],
                "value": projection["placement"]["beltTemplate"]
            }],
            "removedBeltIds": []
        }))
        .unwrap()
    }

    #[test]
    fn mod_endpoints_and_item_build_a_bounded_exact_builtin_belt_command() {
        let mut state = ordinary_state();
        let before = state.canonical_sha256().unwrap();
        let projection = state
            .construction_belt_placement_context_projection(
                7,
                REGISTRY,
                "MOD/源-一",
                "MOD/目标-二",
                "MOD/item-alpha",
                1,
                3,
            )
            .unwrap();
        assert_eq!(projection["projectionType"], PROJECTION_TYPE);
        assert_eq!(projection["activePlanetId"], "home");
        assert_eq!(projection["constructionId"], "conveyor_belt_mk1");
        assert_eq!(projection["available"], 12);
        assert_eq!(projection["appendBeltIndex"], 0);
        assert_eq!(projection["nextBeltId"], "belt_42");
        assert_eq!(
            projection["support"],
            json!({ "supported": true, "reason": null })
        );
        assert_eq!(projection["placement"]["remainingConstruction"], 9);
        assert_eq!(projection["placement"]["nextIdAfterPlacement"], 43);
        assert_eq!(projection["placement"]["beltTemplate"]["stackSize"], 4);
        assert_eq!(
            projection["placement"]["beltTemplate"]["routeMode"],
            "upper"
        );
        assert!(
            projection["placement"]["beltTemplate"]
                .get("targetPortIndex")
                .is_none()
        );
        assert_eq!(state.canonical_sha256().unwrap(), before);
        assert!(serde_json::to_vec(&projection).unwrap().len() <= MAX_PROJECTION_BYTES);

        let durable = command(&projection);
        state.validate_player_authority_command(&durable).unwrap();
        assert_eq!(state.canonical_sha256().unwrap(), before);
        let receipt = state.apply_player_authority_command(&durable).unwrap();
        assert_eq!(receipt.changed_belt_ids, ["belt_42"]);
        assert!(receipt.topology_dirty);
        assert_eq!(state.base_value()["construction"]["conveyor_belt_mk1"], 9);
        assert_eq!(state.base_value()["nextId"], 43);
        assert_eq!(
            state.parse_belt(0).unwrap(),
            projection["placement"]["beltTemplate"]
        );
    }

    #[test]
    fn forged_ports_defaults_debits_and_same_revision_topology_are_rejected() {
        let state = ordinary_state();
        let projection = state
            .construction_belt_placement_context_projection(
                7,
                REGISTRY,
                "MOD/源-一",
                "MOD/目标-二",
                "MOD/item-alpha",
                1,
                3,
            )
            .unwrap();
        let mut commands = Vec::new();
        let mut port = command(&projection);
        port.added_belts[0].value["targetPortIndex"] = Value::from(0);
        commands.push(port);
        let mut wrong_direction = command(&projection);
        wrong_direction.added_belts[0].value["source"] = Value::from("MOD/目标-二");
        wrong_direction.added_belts[0].value["target"] = Value::from("MOD/源-一");
        commands.push(wrong_direction);
        let mut debit = command(&projection);
        debit.top_level_changes[0].value = Some(Value::from(10));
        commands.push(debit);
        let mut id = command(&projection);
        id.added_belts[0].value["id"] = Value::from("belt_43");
        commands.push(id);
        for forged in commands {
            let before = state.canonical_sha256().unwrap();
            assert!(state.validate_player_authority_command(&forged).is_err());
            assert_eq!(state.canonical_sha256().unwrap(), before);
        }

        let existing = projection["placement"]["beltTemplate"].clone();
        let changed = fixture(
            "home",
            &[
                "basic_logistics",
                "high_speed_logistics",
                "super_magnetic_logistics",
            ],
            42,
            json!({ "conveyor_belt_mk1": 12, "conveyor_belt_mk2": 12, "conveyor_belt_mk3": 12 }),
            vec![
                machine(
                    "MOD/源-一",
                    "MOD/source-machine",
                    "MOD/source-recipe",
                    "home",
                ),
                machine(
                    "MOD/目标-二",
                    "MOD/target-machine",
                    "MOD/target-recipe",
                    "home",
                ),
            ],
            vec![existing],
            4,
        );
        assert_eq!(
            changed
                .construction_belt_placement_context_projection(
                    7,
                    REGISTRY,
                    "MOD/源-一",
                    "MOD/目标-二",
                    "MOD/item-alpha",
                    1,
                    3,
                )
                .unwrap()["support"]["reason"],
            "matching-route-exists"
        );
        assert!(
            changed
                .validate_player_authority_command(&command(&projection))
                .is_err()
        );
    }

    #[test]
    fn unsupported_tier_technology_inventory_planet_and_unconfigured_endpoints_fail_closed() {
        let base = ordinary_state();
        for (tier, lanes, reason) in [(4, 1, "unsupported-belt-tier"), (1, 4_097, "invalid-lanes")]
        {
            let projection = base
                .construction_belt_placement_context_projection(
                    7,
                    REGISTRY,
                    "MOD/源-一",
                    "MOD/目标-二",
                    "MOD/item-alpha",
                    tier,
                    lanes,
                )
                .unwrap();
            assert_eq!(projection["support"]["reason"], reason);
            assert!(projection["placement"].is_null());
        }

        let locked = fixture(
            "home",
            &["basic_logistics"],
            42,
            json!({ "conveyor_belt_mk1": 1, "conveyor_belt_mk2": 12, "conveyor_belt_mk3": 12 }),
            vec![
                machine(
                    "MOD/源-一",
                    "MOD/source-machine",
                    "MOD/source-recipe",
                    "home",
                ),
                machine(
                    "MOD/目标-二",
                    "MOD/target-machine",
                    "MOD/target-recipe",
                    "home",
                ),
            ],
            Vec::new(),
            4,
        );
        assert_eq!(
            locked
                .construction_belt_placement_context_projection(
                    7,
                    REGISTRY,
                    "MOD/源-一",
                    "MOD/目标-二",
                    "MOD/item-alpha",
                    2,
                    1,
                )
                .unwrap()["support"]["reason"],
            "technology-locked"
        );
        assert_eq!(
            locked
                .construction_belt_placement_context_projection(
                    7,
                    REGISTRY,
                    "MOD/源-一",
                    "MOD/目标-二",
                    "MOD/item-alpha",
                    1,
                    2,
                )
                .unwrap()["support"]["reason"],
            "insufficient-inventory"
        );

        let giant = fixture(
            "giant",
            &["basic_logistics"],
            42,
            json!({ "conveyor_belt_mk1": 12 }),
            vec![
                machine(
                    "MOD/源-一",
                    "MOD/source-machine",
                    "MOD/source-recipe",
                    "giant",
                ),
                machine(
                    "MOD/目标-二",
                    "MOD/target-machine",
                    "MOD/target-recipe",
                    "giant",
                ),
            ],
            Vec::new(),
            1,
        );
        assert_eq!(
            giant
                .construction_belt_placement_context_projection(
                    7,
                    REGISTRY,
                    "MOD/源-一",
                    "MOD/目标-二",
                    "MOD/item-alpha",
                    1,
                    1,
                )
                .unwrap()["support"]["reason"],
            "unsupported-active-planet"
        );

        let mut unconfigured_target = machine(
            "MOD/目标-二",
            "MOD/target-machine",
            "MOD/target-recipe",
            "home",
        );
        unconfigured_target
            .as_object_mut()
            .unwrap()
            .remove("recipeId");
        let unconfigured = fixture(
            "home",
            &["basic_logistics"],
            42,
            json!({ "conveyor_belt_mk1": 12 }),
            vec![
                machine(
                    "MOD/源-一",
                    "MOD/source-machine",
                    "MOD/source-recipe",
                    "home",
                ),
                unconfigured_target,
            ],
            Vec::new(),
            1,
        );
        assert_eq!(
            unconfigured
                .construction_belt_placement_context_projection(
                    7,
                    REGISTRY,
                    "MOD/源-一",
                    "MOD/目标-二",
                    "MOD/item-alpha",
                    1,
                    1,
                )
                .unwrap()["support"]["reason"],
            "target-not-configured"
        );
    }

    #[test]
    fn context_rejects_stale_identity_controls_and_unsafe_numbers() {
        let state = ordinary_state();
        for result in [
            state.construction_belt_placement_context_projection(
                6,
                REGISTRY,
                "MOD/源-一",
                "MOD/目标-二",
                "MOD/item-alpha",
                1,
                1,
            ),
            state.construction_belt_placement_context_projection(
                7,
                "other",
                "MOD/源-一",
                "MOD/目标-二",
                "MOD/item-alpha",
                1,
                1,
            ),
            state.construction_belt_placement_context_projection(
                7,
                REGISTRY,
                "bad\nid",
                "MOD/目标-二",
                "MOD/item-alpha",
                1,
                1,
            ),
        ] {
            assert!(result.is_err());
        }

        let overflow = fixture(
            "home",
            &["basic_logistics"],
            MAX_JAVASCRIPT_SAFE_INTEGER,
            json!({ "conveyor_belt_mk1": 9_007_199_254_740_992_u64 }),
            vec![
                machine(
                    "MOD/源-一",
                    "MOD/source-machine",
                    "MOD/source-recipe",
                    "home",
                ),
                machine(
                    "MOD/目标-二",
                    "MOD/target-machine",
                    "MOD/target-recipe",
                    "home",
                ),
            ],
            Vec::new(),
            1,
        );
        assert!(
            overflow
                .construction_belt_placement_context_projection(
                    7,
                    REGISTRY,
                    "MOD/源-一",
                    "MOD/目标-二",
                    "MOD/item-alpha",
                    1,
                    1,
                )
                .is_err()
        );

        let mut missing_next_id = ordinary_state();
        missing_next_id.base_value_mut().remove("nextId");
        assert!(
            missing_next_id
                .construction_belt_placement_context_projection(
                    7,
                    REGISTRY,
                    "MOD/源-一",
                    "MOD/目标-二",
                    "MOD/item-alpha",
                    1,
                    1,
                )
                .is_err()
        );
    }
}
