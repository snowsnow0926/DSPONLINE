//! Durable semantic commands for special logistics input ports.
//!
//! The renderer submits only a selected entity, one port index and the desired
//! port action. Rust derives every inventory refund, incident-belt removal and
//! construction refund from the current authoritative revision. The compact
//! marker is therefore safe to replay from WAL and never persists renderer-
//! authored inventories, belt IDs or derived compatibility mirrors.

use std::collections::BTreeMap;

use anyhow::{anyhow, bail};
use serde_json::{Map, Value, json};

use crate::{
    command::{
        EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT, PathSegment, RecordPatch, SimulationCommandPatch,
        builtin_belt_construction_id, create_expected_value_patches,
        normalized_construction_inventory,
    },
    state::CoreState,
};

const MATERIAL_DELIVERY_ROOT: &str = "materialDeliverySlot";
const MATERIAL_DELIVERY_LEAF: &str = "intent";
const ORBITAL_CARGO_ROOT: &str = "orbitalCargoPort";
const ORBITAL_CARGO_LEAF: &str = "clearIntent";
const MATERIAL_DELIVERY_SLOT_COUNT: usize = 3;
const ORBITAL_CARGO_PORT_COUNT: usize = 4;
const MAX_OPAQUE_ID_BYTES: usize = 512;
const MAX_CATALOG_ID_BYTES: usize = 160;
const MAX_INCIDENT_BELTS: usize = 16_384;
const MAX_BUFFER_ROWS: usize = 4_096;
const MAX_EXPANDED_CHANGE_COUNT: usize = 65_536;
const MAX_JAVASCRIPT_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const INVENTORY_EPSILON: f64 = 0.0001;

#[derive(Debug, Clone, PartialEq, Eq)]
struct DeliverySlot {
    item_id: Option<String>,
    mode: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum SpecialInputPortIntent {
    MaterialDelivery {
        entity_id: String,
        slot_index: usize,
        mode: String,
        item_id: Option<String>,
    },
    OrbitalCargoClear {
        entity_id: String,
        port_index: usize,
    },
}

#[derive(Debug)]
enum ValidatedTransition {
    MaterialDelivery {
        entity_id: String,
        entity_index: usize,
        before_entity: Value,
        slots: Vec<DeliverySlot>,
        slot_index: usize,
        mode: String,
        item_id: Option<String>,
    },
    OrbitalCargoClear {
        entity_id: String,
        entity_index: usize,
        before_entity: Value,
        ports: Vec<Option<String>>,
        port_index: usize,
        item_id: String,
    },
}

fn material_delivery_path(path: &[PathSegment]) -> bool {
    matches!(
        path,
        [PathSegment::Key(root), PathSegment::Key(leaf)]
            if root == MATERIAL_DELIVERY_ROOT && leaf == MATERIAL_DELIVERY_LEAF
    )
}

fn orbital_cargo_path(path: &[PathSegment]) -> bool {
    matches!(
        path,
        [PathSegment::Key(root), PathSegment::Key(leaf)]
            if root == ORBITAL_CARGO_ROOT && leaf == ORBITAL_CARGO_LEAF
    )
}

pub(crate) fn command_contains_intent(command: &SimulationCommandPatch) -> bool {
    command.changed_entities.iter().any(|record| {
        record
            .changes
            .iter()
            .any(|change| material_delivery_path(&change.path) || orbital_cargo_path(&change.path))
    })
}

pub(crate) fn validate_resume_marker(command: &SimulationCommandPatch) -> anyhow::Result<String> {
    Ok(match require_intent(command)? {
        SpecialInputPortIntent::MaterialDelivery { entity_id, .. }
        | SpecialInputPortIntent::OrbitalCargoClear { entity_id, .. } => entity_id,
    })
}

fn valid_id(value: &str, maximum_bytes: usize) -> bool {
    !value.is_empty() && value.len() <= maximum_bytes && !value.chars().any(char::is_control)
}

fn require_exact_marker(
    command: &SimulationCommandPatch,
) -> anyhow::Result<(&str, &crate::command::ValuePatch)> {
    if command.changed_entities.len() != 1
        || command.changed_entities[0].changes.len() != 1
        || !command.top_level_changes.is_empty()
        || !command.added_entities.is_empty()
        || !command.removed_entity_ids.is_empty()
        || !command.changed_belts.is_empty()
        || !command.added_belts.is_empty()
        || !command.removed_belt_ids.is_empty()
    {
        bail!("native player-authority special input port intent shape is invalid")
    }
    let record = &command.changed_entities[0];
    if !valid_id(&record.id, MAX_OPAQUE_ID_BYTES) {
        bail!("native player-authority special input port entity ID is invalid")
    }
    let change = &record.changes[0];
    if change.operation != "set"
        || (!material_delivery_path(&change.path) && !orbital_cargo_path(&change.path))
    {
        bail!("native player-authority special input port intent path is invalid")
    }
    Ok((&record.id, change))
}

fn require_intent(command: &SimulationCommandPatch) -> anyhow::Result<SpecialInputPortIntent> {
    let (entity_id, change) = require_exact_marker(command)?;
    let marker = change
        .value
        .as_ref()
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("native player-authority special input port intent is invalid"))?;
    if material_delivery_path(&change.path) {
        if marker.len() != 4
            || !marker.contains_key("slotIndex")
            || !marker.contains_key("mode")
            || !marker.contains_key("itemId")
            || marker.get("confirmed").and_then(Value::as_bool) != Some(true)
        {
            bail!("native player-authority material delivery intent fields are invalid")
        }
        let slot_index = marker
            .get("slotIndex")
            .and_then(Value::as_u64)
            .and_then(|value| usize::try_from(value).ok())
            .filter(|value| *value < MATERIAL_DELIVERY_SLOT_COUNT)
            .ok_or_else(|| anyhow!("native player-authority material delivery slot is invalid"))?;
        let mode = marker
            .get("mode")
            .and_then(Value::as_str)
            .filter(|mode| matches!(*mode, "auto" | "manual" | "disabled"))
            .ok_or_else(|| anyhow!("native player-authority material delivery mode is invalid"))?;
        let item_id = match marker.get("itemId") {
            Some(Value::Null) => None,
            Some(Value::String(item_id)) if valid_id(item_id, MAX_CATALOG_ID_BYTES) => {
                Some(item_id.clone())
            }
            _ => bail!("native player-authority material delivery item is invalid"),
        };
        if (mode == "manual") != item_id.is_some() {
            bail!("native player-authority material delivery item and mode disagree")
        }
        return Ok(SpecialInputPortIntent::MaterialDelivery {
            entity_id: entity_id.to_owned(),
            slot_index,
            mode: mode.to_owned(),
            item_id,
        });
    }

    if marker.len() != 2
        || !marker.contains_key("portIndex")
        || marker.get("confirmed").and_then(Value::as_bool) != Some(true)
    {
        bail!("native player-authority orbital cargo clear intent fields are invalid")
    }
    let port_index = marker
        .get("portIndex")
        .and_then(Value::as_u64)
        .and_then(|value| usize::try_from(value).ok())
        .filter(|value| *value < ORBITAL_CARGO_PORT_COUNT)
        .ok_or_else(|| anyhow!("native player-authority orbital cargo port is invalid"))?;
    Ok(SpecialInputPortIntent::OrbitalCargoClear {
        entity_id: entity_id.to_owned(),
        port_index,
    })
}

fn finite_nonnegative(value: Option<&Value>, label: &str) -> anyhow::Result<f64> {
    value
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite() && *value >= 0.0)
        .ok_or_else(|| anyhow!("native player-authority special input port {label} is invalid"))
}

fn safe_positive_integer(value: Option<&Value>, label: &str) -> anyhow::Result<u64> {
    value
        .and_then(Value::as_u64)
        .filter(|value| *value > 0 && *value <= MAX_JAVASCRIPT_SAFE_INTEGER)
        .ok_or_else(|| anyhow!("native player-authority special input port {label} is invalid"))
}

fn validate_builtin_domain(state: &CoreState) -> anyhow::Result<&str> {
    if state.catalog.snapshot.registry_fingerprint != EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT
        || state.identity.registry_fingerprint != EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT
    {
        bail!("native player-authority special input ports require the built-in catalog")
    }
    state
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
        .ok_or_else(|| {
            anyhow!("native player-authority special input port active planet is invalid")
        })
}

fn validate_common_entity(
    state: &CoreState,
    entity_id: &str,
    building_id: &str,
    active_planet_id: &str,
) -> anyhow::Result<(usize, Value)> {
    let building = state
        .catalog
        .buildings
        .get(building_id)
        .filter(|building| building.kind == "storage" && building.accepts.as_deref() == Some("any"))
        .ok_or_else(|| {
            anyhow!("native player-authority special input port building catalog is invalid")
        })?;
    if !building.input_capacity.is_finite() || building.input_capacity <= 0.0 {
        bail!("native player-authority special input port building capacity is invalid")
    }
    let entity_index = *state
        .entity_index
        .get(entity_id)
        .ok_or_else(|| anyhow!("native player-authority special input port entity is missing"))?;
    let entity = state.parse_entity(entity_index)?;
    let object = entity
        .as_object()
        .ok_or_else(|| anyhow!("native player-authority special input port entity is invalid"))?;
    if object.get("kind").and_then(Value::as_str) != Some("storage")
        || object.get("buildingId").and_then(Value::as_str) != Some(building_id)
        || object.get("planetId").and_then(Value::as_str) != Some(active_planet_id)
    {
        bail!(
            "native player-authority special input port target is outside its active built-in domain"
        )
    }
    if object.get("interactionLocked").and_then(Value::as_bool) != Some(false) {
        bail!("native player-authority special input port target is locked or malformed")
    }
    let inputs = object
        .get("inputs")
        .and_then(Value::as_object)
        .ok_or_else(|| {
            anyhow!("native player-authority special input port inventory is invalid")
        })?;
    if inputs.len() > MAX_BUFFER_ROWS {
        bail!("native player-authority special input port inventory source limit is exceeded")
    }
    for (item_id, amount) in inputs {
        if !state.catalog.items.contains_key(item_id) {
            bail!("native player-authority special input port inventory item is unknown")
        }
        finite_nonnegative(Some(amount), "buffer amount")?;
    }
    Ok((entity_index, entity))
}

fn parse_delivery_slots(
    state: &CoreState,
    entity: &Map<String, Value>,
) -> anyhow::Result<Vec<DeliverySlot>> {
    let rows = entity
        .get("deliverySlots")
        .and_then(Value::as_array)
        .filter(|rows| rows.len() == MATERIAL_DELIVERY_SLOT_COUNT)
        .ok_or_else(|| anyhow!("native player-authority material delivery slots are invalid"))?;
    rows.iter()
        .map(|row| {
            let row = row
                .as_object()
                .filter(|row| {
                    row.len() == 2 && row.contains_key("itemId") && row.contains_key("mode")
                })
                .ok_or_else(|| {
                    anyhow!("native player-authority material delivery slot row is invalid")
                })?;
            let mode = row
                .get("mode")
                .and_then(Value::as_str)
                .filter(|mode| matches!(*mode, "auto" | "manual" | "disabled"))
                .ok_or_else(|| {
                    anyhow!("native player-authority material delivery saved mode is invalid")
                })?;
            let item_id = match row.get("itemId") {
                Some(Value::Null) => None,
                Some(Value::String(item_id))
                    if valid_id(item_id, MAX_CATALOG_ID_BYTES)
                        && state.catalog.items.contains_key(item_id) =>
                {
                    Some(item_id.clone())
                }
                _ => bail!("native player-authority material delivery saved item is invalid"),
            };
            if mode == "manual" && item_id.is_none() || mode == "disabled" && item_id.is_some() {
                bail!("native player-authority material delivery saved slot is inconsistent")
            }
            Ok(DeliverySlot {
                item_id,
                mode: mode.to_owned(),
            })
        })
        .collect()
}

fn parse_orbital_ports(
    state: &CoreState,
    entity: &Map<String, Value>,
) -> anyhow::Result<Vec<Option<String>>> {
    entity
        .get("orbitalCargoPortItems")
        .and_then(Value::as_array)
        .filter(|rows| rows.len() == ORBITAL_CARGO_PORT_COUNT)
        .ok_or_else(|| anyhow!("native player-authority orbital cargo ports are invalid"))?
        .iter()
        .map(|value| match value {
            Value::Null => Ok(None),
            Value::String(item_id)
                if valid_id(item_id, MAX_CATALOG_ID_BYTES)
                    && state.catalog.items.contains_key(item_id) =>
            {
                Ok(Some(item_id.clone()))
            }
            _ => bail!("native player-authority orbital cargo port item is invalid"),
        })
        .collect()
}

fn validated_transition(
    state: &CoreState,
    command: &SimulationCommandPatch,
) -> anyhow::Result<ValidatedTransition> {
    let intent = require_intent(command)?;
    let active_planet_id = validate_builtin_domain(state)?.to_owned();
    match intent {
        SpecialInputPortIntent::MaterialDelivery {
            entity_id,
            slot_index,
            mode,
            item_id,
        } => {
            if item_id
                .as_ref()
                .is_some_and(|item_id| !state.catalog.items.contains_key(item_id))
            {
                bail!("native player-authority material delivery target item is unknown")
            }
            let (entity_index, before_entity) = validate_common_entity(
                state,
                &entity_id,
                "material_delivery_hub",
                &active_planet_id,
            )?;
            let slots = parse_delivery_slots(
                state,
                before_entity
                    .as_object()
                    .expect("special input entity was validated"),
            )?;
            if slots[slot_index].mode == mode && slots[slot_index].item_id == item_id {
                bail!("native player-authority material delivery target is unchanged")
            }
            Ok(ValidatedTransition::MaterialDelivery {
                entity_id,
                entity_index,
                before_entity,
                slots,
                slot_index,
                mode,
                item_id,
            })
        }
        SpecialInputPortIntent::OrbitalCargoClear {
            entity_id,
            port_index,
        } => {
            let (entity_index, before_entity) = validate_common_entity(
                state,
                &entity_id,
                "orbital_cargo_terminal",
                &active_planet_id,
            )?;
            let ports = parse_orbital_ports(
                state,
                before_entity
                    .as_object()
                    .expect("special input entity was validated"),
            )?;
            let item_id = ports[port_index].clone().ok_or_else(|| {
                anyhow!("native player-authority orbital cargo port is already empty")
            })?;
            Ok(ValidatedTransition::OrbitalCargoClear {
                entity_id,
                entity_index,
                before_entity,
                ports,
                port_index,
                item_id,
            })
        }
    }
}

fn refund_inventory(
    base: &mut Map<String, Value>,
    item_id: &str,
    amount: &Value,
) -> anyhow::Result<()> {
    let amount = finite_nonnegative(Some(amount), "inventory refund")?;
    let target = if matches!(item_id, "logistics_drone" | "logistics_vessel") {
        base.entry("portableFleet".to_owned())
            .or_insert_with(|| json!({ "logistics_drone": 0, "logistics_vessel": 0 }))
            .as_object_mut()
            .ok_or_else(|| {
                anyhow!("native player-authority special input portable fleet is invalid")
            })?
    } else {
        base.get_mut("tray")
            .and_then(Value::as_object_mut)
            .ok_or_else(|| anyhow!("native player-authority special input tray is invalid"))?
    };
    let current = match target.get(item_id) {
        None | Some(Value::Null) => 0.0,
        Some(value) => finite_nonnegative(Some(value), "refund target inventory")?,
    };
    let next = (current + amount + INVENTORY_EPSILON).floor();
    if !next.is_finite() || next > MAX_JAVASCRIPT_SAFE_INTEGER as f64 {
        bail!("native player-authority special input inventory refund overflows")
    }
    target.insert(item_id.to_owned(), Value::from(next as u64));
    Ok(())
}

fn remove_target_port_belts(
    state: &CoreState,
    entity_index: usize,
    entity_id: &str,
    port_index: usize,
    candidate_base: &mut Map<String, Value>,
) -> anyhow::Result<Vec<String>> {
    let mut removed_belt_ids = Vec::new();
    let mut belt_refunds = BTreeMap::<&'static str, u64>::new();
    for (incident_index, belt_index) in state.incident_belt_indices(entity_index).enumerate() {
        if incident_index >= MAX_INCIDENT_BELTS {
            bail!("native player-authority special input incident belt source limit is exceeded")
        }
        let belt = state.parse_belt(belt_index)?;
        let belt = belt.as_object().ok_or_else(|| {
            anyhow!("native player-authority special input incident belt is invalid")
        })?;
        if belt.get("target").and_then(Value::as_str) != Some(entity_id) {
            continue;
        }
        let target_port = belt
            .get("targetPortIndex")
            .and_then(Value::as_u64)
            .and_then(|value| usize::try_from(value).ok())
            .ok_or_else(|| anyhow!("native player-authority special input belt port is invalid"))?;
        if target_port != port_index {
            continue;
        }
        let belt_id = belt
            .get("id")
            .and_then(Value::as_str)
            .filter(|value| valid_id(value, MAX_OPAQUE_ID_BYTES))
            .ok_or_else(|| anyhow!("native player-authority special input belt ID is invalid"))?;
        let lanes = safe_positive_integer(belt.get("lanes"), "belt lanes")?;
        let tier: u8 = safe_positive_integer(belt.get("tier"), "belt tier")?
            .try_into()
            .map_err(|_| anyhow!("native player-authority special input belt tier is invalid"))?;
        let construction_id = builtin_belt_construction_id(state, tier)?;
        let refund = belt_refunds.entry(construction_id).or_default();
        *refund = refund
            .checked_add(lanes)
            .filter(|value| *value <= MAX_JAVASCRIPT_SAFE_INTEGER)
            .ok_or_else(|| {
                anyhow!("native player-authority special input belt refund overflows")
            })?;
        removed_belt_ids.push(belt_id.to_owned());
    }
    let construction = candidate_base
        .get_mut("construction")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| {
            anyhow!("native player-authority special input construction inventory is invalid")
        })?;
    for (construction_id, refund) in belt_refunds {
        let current = normalized_construction_inventory(construction.get(construction_id))?;
        let next = current
            .checked_add(refund)
            .filter(|value| *value <= MAX_JAVASCRIPT_SAFE_INTEGER)
            .ok_or_else(|| {
                anyhow!("native player-authority special input belt refund overflows")
            })?;
        construction.insert(construction_id.to_owned(), Value::from(next));
    }
    Ok(removed_belt_ids)
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
    let (entity_id, entity_index, before_entity, port_index) = match &transition {
        ValidatedTransition::MaterialDelivery {
            entity_id,
            entity_index,
            before_entity,
            slot_index,
            ..
        } => (
            entity_id.clone(),
            *entity_index,
            before_entity.clone(),
            *slot_index,
        ),
        ValidatedTransition::OrbitalCargoClear {
            entity_id,
            entity_index,
            before_entity,
            port_index,
            ..
        } => (
            entity_id.clone(),
            *entity_index,
            before_entity.clone(),
            *port_index,
        ),
    };
    let mut candidate_base = Value::Object(state.base_value().clone());
    let candidate_base_object = candidate_base
        .as_object_mut()
        .expect("native core base is an object");
    let removed_belt_ids = remove_target_port_belts(
        state,
        entity_index,
        &entity_id,
        port_index,
        candidate_base_object,
    )?;
    let mut candidate_entity = before_entity.clone();
    let candidate_entity_object = candidate_entity
        .as_object_mut()
        .expect("special input transition validated the entity object");

    match transition {
        ValidatedTransition::MaterialDelivery {
            mut slots,
            slot_index,
            mode,
            item_id,
            ..
        } => {
            slots[slot_index] = DeliverySlot { item_id, mode };
            let mut configured_items = Vec::<String>::new();
            for slot in &slots {
                if let Some(item_id) = slot.item_id.as_ref()
                    && !configured_items.contains(item_id)
                {
                    configured_items.push(item_id.clone());
                }
            }
            let inputs = candidate_entity_object
                .get_mut("inputs")
                .and_then(Value::as_object_mut)
                .expect("special input transition validated the inventory");
            let orphaned = inputs
                .iter()
                .filter(|(item_id, _)| {
                    !configured_items
                        .iter()
                        .any(|candidate| candidate == *item_id)
                })
                .map(|(item_id, amount)| (item_id.clone(), amount.clone()))
                .collect::<Vec<_>>();
            for (item_id, amount) in orphaned {
                refund_inventory(candidate_base_object, &item_id, &amount)?;
                inputs.remove(&item_id);
            }
            candidate_entity_object.insert(
                "deliverySlots".to_owned(),
                Value::Array(
                    slots
                        .iter()
                        .map(|slot| {
                            json!({
                                "itemId": slot.item_id,
                                "mode": slot.mode,
                            })
                        })
                        .collect(),
                ),
            );
            candidate_entity_object.insert(
                "deliveryItemIds".to_owned(),
                Value::Array(configured_items.into_iter().map(Value::from).collect()),
            );
        }
        ValidatedTransition::OrbitalCargoClear {
            mut ports,
            port_index,
            item_id,
            ..
        } => {
            ports[port_index] = None;
            if !ports
                .iter()
                .any(|candidate| candidate.as_deref() == Some(item_id.as_str()))
            {
                let inputs = candidate_entity_object
                    .get_mut("inputs")
                    .and_then(Value::as_object_mut)
                    .expect("special input transition validated the inventory");
                if let Some(amount) = inputs.remove(&item_id) {
                    refund_inventory(candidate_base_object, &item_id, &amount)?;
                }
            }
            candidate_entity_object.insert(
                "orbitalCargoPortItems".to_owned(),
                Value::Array(
                    ports
                        .into_iter()
                        .map(|item_id| item_id.map_or(Value::Null, Value::from))
                        .collect(),
                ),
            );
        }
    }

    let mut top_level_changes = Vec::new();
    create_expected_value_patches(
        &Value::Object(state.base_value().clone()),
        &candidate_base,
        Vec::new(),
        &mut top_level_changes,
    );
    let mut entity_changes = Vec::new();
    create_expected_value_patches(
        &before_entity,
        &candidate_entity,
        Vec::new(),
        &mut entity_changes,
    );
    if entity_changes.is_empty() {
        bail!("native player-authority special input port transition is empty")
    }
    let expanded_change_count = top_level_changes
        .len()
        .checked_add(entity_changes.len())
        .and_then(|count| count.checked_add(removed_belt_ids.len()))
        .ok_or_else(|| {
            anyhow!("native player-authority special input port change count overflows")
        })?;
    if expanded_change_count > MAX_EXPANDED_CHANGE_COUNT {
        bail!("native player-authority special input port change count is invalid")
    }
    Ok(SimulationCommandPatch {
        protocol_version: command.protocol_version,
        base_revision: command.base_revision,
        top_level_changes,
        changed_entities: vec![RecordPatch {
            id: entity_id,
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
        let snapshot: CatalogSnapshot = serde_json::from_value(json!({
            "protocolVersion": crate::CORE_PROTOCOL_VERSION,
            "registryFingerprint": EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT,
            "planets": [
                { "id": "home", "systemId": "helios", "kind": "terrestrial", "orbitIndex": 1 },
                { "id": "away", "systemId": "helios", "kind": "terrestrial", "orbitIndex": 2 }
            ],
            "items": [
                { "id": "iron_ore", "kind": "solid" },
                { "id": "copper_ore", "kind": "solid" },
                { "id": "logistics_drone", "kind": "solid" }
            ],
            "buildings": [
                { "id": "storage_mk1", "kind": "storage", "speed": 1, "inputCapacity": 100, "outputCapacity": 100, "accepts": "any" },
                { "id": "material_delivery_hub", "kind": "storage", "speed": 1, "inputCapacity": 900, "outputCapacity": 0, "accepts": "any" },
                { "id": "orbital_cargo_terminal", "kind": "storage", "speed": 1, "inputCapacity": 1000000, "outputCapacity": 0, "accepts": "any" }
            ],
            "recipes": [],
            "constructions": [
                { "id": "conveyor_belt_mk1", "outputAmount": 3, "costs": [{ "itemId": "iron_ore", "amount": 2 }] },
                { "id": "conveyor_belt_mk2", "outputAmount": 3, "costs": [{ "itemId": "iron_ore", "amount": 2 }] }
            ],
            "belts": [
                { "tier": 1, "speed": 6 },
                { "tier": 2, "speed": 12 }
            ],
            "technologies": []
        }))
        .unwrap();
        RuntimeCatalog::validate(snapshot, EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT).unwrap()
    }

    fn storage_entity(id: &str, planet_id: &str, building_id: &str, x: f64) -> Value {
        json!({
            "id": id,
            "kind": "storage",
            "planetId": planet_id,
            "position": { "x": x, "y": 2 },
            "interactionLocked": false,
            "buildingId": building_id,
            "powerGridId": "grid-a",
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

    fn belt(
        id: &str,
        source: &str,
        target: &str,
        item_id: &str,
        port: usize,
        lanes: u64,
        tier: u8,
    ) -> String {
        json!({
            "id": id,
            "planetId": "home",
            "source": source,
            "target": target,
            "targetPortIndex": port,
            "itemId": item_id,
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
        let base = json!({
            "version": 47,
            "mode": "normal",
            "activePlanetId": "home",
            "elapsedSeconds": 10,
            "paused": false,
            "tray": { "iron_ore": 10, "copper_ore": 5 },
            "portableFleet": { "logistics_drone": 4, "logistics_vessel": 0 },
            "construction": { "conveyor_belt_mk1": 5, "conveyor_belt_mk2": 10 }
        })
        .as_object()
        .unwrap()
        .clone();
        let mut delivery = storage_entity("delivery", "home", "material_delivery_hub", 5.0);
        delivery["inputs"] = json!({ "iron_ore": 7.8, "copper_ore": 3.4, "logistics_drone": 1.9 });
        delivery["deliverySlots"] = json!([
            { "itemId": "iron_ore", "mode": "manual" },
            { "itemId": null, "mode": "auto" },
            { "itemId": null, "mode": "disabled" }
        ]);
        delivery["deliveryItemIds"] = json!(["iron_ore"]);
        let mut terminal = storage_entity("terminal", "home", "orbital_cargo_terminal", 9.0);
        terminal["inputs"] = json!({ "iron_ore": 11.9, "copper_ore": 4 });
        terminal["orbitalCargoPortItems"] = json!(["iron_ore", "iron_ore", "copper_ore", null]);
        terminal["orbitalCargoBinding"] = Value::Null;
        terminal["orbitalCargoProgress"] = Value::from(0);
        terminal["orbitalCargoTotalUploaded"] = Value::from("123");
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
                storage_entity("source", "home", "storage_mk1", 1.0).to_string(),
                delivery.to_string(),
                terminal.to_string(),
                storage_entity("away-delivery", "away", "material_delivery_hub", 13.0).to_string(),
            ],
            vec![
                belt("delivery-belt", "source", "delivery", "iron_ore", 0, 2, 1),
                belt("terminal-belt-a", "source", "terminal", "iron_ore", 0, 3, 2),
                belt("terminal-belt-b", "source", "terminal", "iron_ore", 1, 1, 1),
            ],
            test_catalog(),
        )
        .unwrap()
    }

    fn marker(
        revision: u64,
        entity_id: &str,
        root: &str,
        leaf: &str,
        value: Value,
    ) -> SimulationCommandPatch {
        SimulationCommandPatch {
            protocol_version: crate::CORE_PROTOCOL_VERSION,
            base_revision: revision,
            top_level_changes: Vec::new(),
            changed_entities: vec![RecordPatch {
                id: entity_id.to_owned(),
                changes: vec![ValuePatch {
                    path: vec![
                        PathSegment::Key(root.to_owned()),
                        PathSegment::Key(leaf.to_owned()),
                    ],
                    operation: "set".to_owned(),
                    value: Some(value),
                }],
            }],
            added_entities: Vec::new(),
            removed_entity_ids: Vec::new(),
            changed_belts: Vec::new(),
            added_belts: Vec::new(),
            removed_belt_ids: Vec::new(),
        }
    }

    fn delivery_intent(
        revision: u64,
        entity_id: &str,
        slot_index: usize,
        mode: &str,
        item_id: Value,
    ) -> SimulationCommandPatch {
        marker(
            revision,
            entity_id,
            MATERIAL_DELIVERY_ROOT,
            MATERIAL_DELIVERY_LEAF,
            json!({
                "slotIndex": slot_index,
                "mode": mode,
                "itemId": item_id,
                "confirmed": true
            }),
        )
    }

    fn orbital_clear_intent(revision: u64, port_index: usize) -> SimulationCommandPatch {
        marker(
            revision,
            "terminal",
            ORBITAL_CARGO_ROOT,
            ORBITAL_CARGO_LEAF,
            json!({ "portIndex": port_index, "confirmed": true }),
        )
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
    fn material_delivery_intent_refunds_orphans_and_belt_for_live_and_wal_replay() {
        let mut live = test_state();
        let mut replay = live.clone();
        let command = delivery_intent(7, "delivery", 0, "manual", Value::from("copper_ore"));
        let expanded = expand_intent(&live, &command).unwrap();
        assert_eq!(expanded.removed_belt_ids, ["delivery-belt"]);

        let live_receipt = live.apply_player_authority_command(&command).unwrap();
        let replay_receipt = replay.apply_command(&command).unwrap();
        assert_eq!(live_receipt, replay_receipt);
        assert_eq!(
            live.canonical_sha256().unwrap(),
            replay.canonical_sha256().unwrap()
        );
        assert_eq!(live_receipt.changed_entity_ids, ["delivery"]);
        assert!(live_receipt.changed_belt_ids.is_empty());
        assert!(live_receipt.topology_dirty);

        let delivery = entity(&live, "delivery");
        assert_eq!(
            delivery["deliverySlots"][0],
            json!({ "itemId": "copper_ore", "mode": "manual" })
        );
        assert_eq!(delivery["deliveryItemIds"], json!(["copper_ore"]));
        assert_eq!(delivery["inputs"], json!({ "copper_ore": 3.4 }));
        assert_eq!(live.base_value()["tray"]["iron_ore"], 17);
        assert_eq!(live.base_value()["portableFleet"]["logistics_drone"], 5);
        assert_eq!(live.base_value()["construction"]["conveyor_belt_mk1"], 7);
        assert!(!live.belt_index.contains_key("delivery-belt"));
    }

    #[test]
    fn orbital_clear_preserves_shared_buffer_then_refunds_last_port_without_touching_uploads() {
        let mut state = test_state();
        let mut replay = state.clone();
        let first = orbital_clear_intent(7, 0);
        let live_receipt = state.apply_player_authority_command(&first).unwrap();
        let replay_receipt = replay.apply_command(&first).unwrap();
        assert_eq!(live_receipt, replay_receipt);
        assert_eq!(
            state.canonical_sha256().unwrap(),
            replay.canonical_sha256().unwrap()
        );
        assert_eq!(live_receipt.changed_entity_ids, ["terminal"]);
        assert!(live_receipt.changed_belt_ids.is_empty());
        assert!(live_receipt.topology_dirty);
        let terminal = entity(&state, "terminal");
        assert_eq!(
            terminal["orbitalCargoPortItems"],
            json!([null, "iron_ore", "copper_ore", null])
        );
        assert_eq!(terminal["inputs"]["iron_ore"], 11.9);
        assert_eq!(terminal["orbitalCargoTotalUploaded"], "123");
        assert_eq!(state.base_value()["construction"]["conveyor_belt_mk2"], 13);

        let mut replay = state.clone();
        let second = orbital_clear_intent(8, 1);
        let live_receipt = state.apply_player_authority_command(&second).unwrap();
        let replay_receipt = replay.apply_command(&second).unwrap();
        assert_eq!(live_receipt, replay_receipt);
        assert_eq!(
            state.canonical_sha256().unwrap(),
            replay.canonical_sha256().unwrap()
        );
        let terminal = entity(&state, "terminal");
        assert_eq!(
            terminal["orbitalCargoPortItems"],
            json!([null, null, "copper_ore", null])
        );
        assert!(terminal["inputs"].get("iron_ore").is_none());
        assert_eq!(state.base_value()["tray"]["iron_ore"], 21);
        assert_eq!(state.base_value()["construction"]["conveyor_belt_mk1"], 6);
        assert_eq!(terminal["orbitalCargoTotalUploaded"], "123");
    }

    #[test]
    fn special_port_markers_fail_closed_for_confirmation_shape_scope_and_catalog_errors() {
        let mut state = test_state();
        let mut unconfirmed = delivery_intent(7, "delivery", 0, "auto", Value::Null);
        unconfirmed.changed_entities[0].changes[0]
            .value
            .as_mut()
            .unwrap()["confirmed"] = Value::Bool(false);
        assert_rejected_without_mutation(&mut state, &unconfirmed);

        let mut extra = orbital_clear_intent(7, 0);
        extra.changed_entities[0].changes[0].value.as_mut().unwrap()["inventory"] =
            json!({ "iron_ore": 999 });
        assert_rejected_without_mutation(&mut state, &extra);

        assert_rejected_without_mutation(
            &mut state,
            &delivery_intent(7, "away-delivery", 0, "manual", Value::from("copper_ore")),
        );
        assert_rejected_without_mutation(
            &mut state,
            &delivery_intent(7, "delivery", 0, "manual", Value::from("missing")),
        );
        assert_rejected_without_mutation(
            &mut state,
            &delivery_intent(7, "delivery", 0, "manual", Value::from("iron_ore")),
        );

        replace_entity(&mut state, "delivery", |entity| {
            entity["interactionLocked"] = Value::Bool(true)
        });
        assert_rejected_without_mutation(
            &mut state,
            &delivery_intent(7, "delivery", 0, "auto", Value::Null),
        );

        let mut malformed_lock = test_state();
        replace_entity(&mut malformed_lock, "delivery", |entity| {
            entity.as_object_mut().unwrap().remove("interactionLocked");
        });
        assert_rejected_without_mutation(
            &mut malformed_lock,
            &delivery_intent(7, "delivery", 0, "auto", Value::Null),
        );
    }
}
