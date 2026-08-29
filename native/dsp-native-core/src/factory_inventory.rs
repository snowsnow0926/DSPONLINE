//! Revision-bound, bounded inventory read model and player command gate.
//!
//! The public v47 state remains the persisted source of truth. This module only
//! exposes a pageable thin-renderer projection and proves the three inventory
//! transitions that the native player-authority UI can currently originate:
//! fill the held stack from the active tray, return it without loss, and change
//! the active planet's per-item tray limit.

use anyhow::{anyhow, bail};
use serde_json::{Map, Value, json};

use crate::{
    command::{PathSegment, SimulationCommandPatch, ValuePatch},
    state::CoreState,
};

const FACTORY_INVENTORY_PROJECTION: &str = "factory-inventory-v1";
const MAX_PROJECTION_BYTES: usize = 1_048_576;
const MAX_PAGE_ROWS: usize = 256;
const MAX_OPAQUE_ID_BYTES: usize = 512;
const MAX_JAVASCRIPT_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const PICKUP_TARGET_AMOUNT: u64 = 100;
const MIN_TRAY_ITEM_LIMIT: u64 = 1_000;
const DEFAULT_TRAY_ITEM_LIMIT: u64 = 1_000_000;
const MAX_TRAY_ITEM_LIMIT: u64 = 100_000_000;

#[derive(Clone, Debug, PartialEq, Eq)]
struct HeldCargo {
    item_id: String,
    amount: u64,
    origin: Option<CargoOrigin>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct CargoOrigin {
    kind: String,
    id: Option<String>,
}

fn valid_opaque_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_OPAQUE_ID_BYTES
        && !value.contains('\0')
        && !value.chars().any(char::is_control)
}

fn known_item_id<'a>(state: &CoreState, value: &'a str) -> anyhow::Result<&'a str> {
    if !valid_opaque_id(value) || !state.catalog.items.contains_key(value) {
        bail!("native factory inventory item ID is invalid")
    }
    Ok(value)
}

fn safe_nonnegative_integer(value: Option<&Value>, label: &str) -> anyhow::Result<u64> {
    value
        .and_then(Value::as_u64)
        .filter(|value| *value <= MAX_JAVASCRIPT_SAFE_INTEGER)
        .ok_or_else(|| anyhow!("native factory inventory {label} is not a safe integer"))
}

fn optional_safe_nonnegative_integer(value: Option<&Value>, label: &str) -> anyhow::Result<u64> {
    match value {
        None | Some(Value::Null) => Ok(0),
        Some(value) => safe_nonnegative_integer(Some(value), label),
    }
}

fn active_planet_id<'a>(
    state: &CoreState,
    base: &'a Map<String, Value>,
) -> anyhow::Result<&'a str> {
    let planet_id = base
        .get("activePlanetId")
        .and_then(Value::as_str)
        .filter(|planet_id| valid_opaque_id(planet_id))
        .ok_or_else(|| anyhow!("native factory inventory active planet ID is invalid"))?;
    if !state
        .catalog
        .planets
        .iter()
        .any(|planet| planet.id == planet_id)
    {
        bail!("native factory inventory active planet is missing from the catalog")
    }
    Ok(planet_id)
}

fn active_tray(base: &Map<String, Value>) -> anyhow::Result<&Map<String, Value>> {
    base.get("tray")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("native factory inventory active tray is invalid"))
}

fn effective_tray_item_limit(
    base: &Map<String, Value>,
    active_planet_id: &str,
) -> anyhow::Result<u64> {
    let limits = base
        .get("planetTrayItemLimits")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("native factory inventory tray-limit directory is invalid"))?;
    let raw = match limits.get(active_planet_id) {
        None | Some(Value::Null) => return Ok(DEFAULT_TRAY_ITEM_LIMIT),
        Some(value) => safe_nonnegative_integer(Some(value), "active tray item limit")?,
    };
    Ok(raw.clamp(MIN_TRAY_ITEM_LIMIT, MAX_TRAY_ITEM_LIMIT))
}

fn validate_cargo_origin(value: Option<&Value>) -> anyhow::Result<Option<CargoOrigin>> {
    let Some(value) = value else {
        return Ok(None);
    };
    if value.is_null() {
        return Ok(None);
    }
    let origin = value
        .as_object()
        .ok_or_else(|| anyhow!("native factory inventory cargo origin is invalid"))?;
    let kind = origin
        .get("kind")
        .and_then(Value::as_str)
        .filter(|kind| matches!(*kind, "node-output" | "node-input" | "tray"))
        .ok_or_else(|| anyhow!("native factory inventory cargo origin kind is invalid"))?
        .to_owned();
    let id = match origin.get("id") {
        None | Some(Value::Null) => None,
        Some(Value::String(id)) if valid_opaque_id(id) => Some(id.to_owned()),
        _ => bail!("native factory inventory cargo origin identity is invalid"),
    };
    Ok(Some(CargoOrigin { kind, id }))
}

fn held_cargo(state: &CoreState, base: &Map<String, Value>) -> anyhow::Result<Option<HeldCargo>> {
    let Some(value) = base.get("cargo") else {
        return Ok(None);
    };
    if value.is_null() {
        return Ok(None);
    }
    let cargo = value
        .as_object()
        .ok_or_else(|| anyhow!("native factory inventory cargo is invalid"))?;
    let item_id = cargo
        .get("itemId")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("native factory inventory cargo item ID is invalid"))?;
    known_item_id(state, item_id)?;
    let amount = safe_nonnegative_integer(cargo.get("amount"), "cargo amount")?;
    // Historical valid saves may carry a stack larger than the modern manual
    // pick limit. Keep it visible and returnable without truncation; the limit
    // only controls how much a new tray-take may add.
    if amount == 0 {
        bail!("native factory inventory cargo amount is empty")
    }
    let origin = validate_cargo_origin(cargo.get("origin"))?;
    Ok(Some(HeldCargo {
        item_id: item_id.to_owned(),
        amount,
        origin,
    }))
}

fn is_portable_fleet_item(item_id: &str) -> bool {
    matches!(item_id, "logistics_drone" | "logistics_vessel")
}

fn path_equals(path: &[PathSegment], expected: &[&str]) -> bool {
    path.len() == expected.len()
        && path.iter().zip(expected).all(
            |(segment, expected)| matches!(segment, PathSegment::Key(value) if value == expected),
        )
}

fn patches_have_only_top_level_changes(command: &SimulationCommandPatch) -> bool {
    command.changed_entities.is_empty()
        && command.added_entities.is_empty()
        && command.removed_entity_ids.is_empty()
        && command.changed_belts.is_empty()
        && command.added_belts.is_empty()
        && command.removed_belt_ids.is_empty()
}

fn inventory_root(path: &[PathSegment]) -> bool {
    matches!(
        path.first(),
        Some(PathSegment::Key(root))
            if matches!(
                root.as_str(),
                "cargo" | "tray" | "planetTrayItemLimits" | "portableFleet"
            )
    )
}

pub(crate) fn command_touches_factory_inventory(command: &SimulationCommandPatch) -> bool {
    command
        .top_level_changes
        .iter()
        .any(|change| inventory_root(&change.path))
}

fn exact_patch_sets_match(actual: &[ValuePatch], expected: &[ValuePatch]) -> anyhow::Result<()> {
    if actual.len() != expected.len() {
        bail!("native factory inventory patch set is incomplete or mixed")
    }
    let mut matched = vec![false; expected.len()];
    for actual_patch in actual {
        let Some(expected_index) =
            expected
                .iter()
                .enumerate()
                .find_map(|(index, expected_patch)| {
                    (!matched[index]
                        && actual_patch.path.len() == expected_patch.path.len()
                        && actual_patch.path.iter().zip(&expected_patch.path).all(
                            |(actual, expected)| match (actual, expected) {
                                (PathSegment::Key(actual), PathSegment::Key(expected)) => {
                                    actual == expected
                                }
                                (PathSegment::Index(actual), PathSegment::Index(expected)) => {
                                    actual == expected
                                }
                                _ => false,
                            },
                        ))
                    .then_some(index)
                })
        else {
            bail!("native factory inventory patch path is not canonical")
        };
        let expected_patch = &expected[expected_index];
        let equivalent_delete = expected_patch.operation == "delete"
            && actual_patch.operation == "delete"
            && actual_patch.value.as_ref().is_none_or(Value::is_null);
        let equivalent_set = expected_patch.operation == "set"
            && actual_patch.operation == "set"
            && actual_patch.value == expected_patch.value;
        if !equivalent_delete && !equivalent_set {
            bail!("native factory inventory patch value is not canonical")
        }
        matched[expected_index] = true;
    }
    if matched.iter().any(|matched| !matched) {
        bail!("native factory inventory patch set is incomplete")
    }
    Ok(())
}

fn validate_take_from_active_tray(
    state: &CoreState,
    command: &SimulationCommandPatch,
) -> anyhow::Result<()> {
    let base = state.base_value();
    active_planet_id(state, base)?;
    let tray = active_tray(base)?;
    let current_cargo = held_cargo(state, base)?;
    let mut target = None::<(&str, u64)>;
    for change in &command.top_level_changes {
        let [PathSegment::Key(root), PathSegment::Key(item_id)] = change.path.as_slice() else {
            continue;
        };
        if root != "tray" {
            continue;
        }
        if target.is_some() || change.operation != "set" {
            bail!("native factory inventory tray-take target is repeated or malformed")
        }
        let remaining = safe_nonnegative_integer(change.value.as_ref(), "tray-take remainder")?;
        target = Some((item_id, remaining));
    }
    let (item_id, target_remaining) =
        target.ok_or_else(|| anyhow!("native factory inventory tray-take target is missing"))?;
    known_item_id(state, item_id)?;
    let available = safe_nonnegative_integer(tray.get(item_id), "tray-take source amount")?;
    if available == 0 {
        bail!("native factory inventory tray-take source is empty")
    }
    let held_amount = match current_cargo.as_ref() {
        None => 0,
        Some(cargo) if cargo.item_id == item_id => cargo.amount,
        Some(_) => bail!("native factory inventory tray-take would mix held item types"),
    };
    let take = available.min(PICKUP_TARGET_AMOUNT.saturating_sub(held_amount));
    if take == 0 || target_remaining != available - take {
        bail!("native factory inventory tray-take amount is not canonical")
    }
    let next_held = held_amount
        .checked_add(take)
        .filter(|amount| *amount <= PICKUP_TARGET_AMOUNT)
        .ok_or_else(|| anyhow!("native factory inventory held stack overflows"))?;

    // Native authority always rebuilds the complete held stack. This gives
    // tray-take one bounded canonical shape, clears untrusted legacy cargo
    // extensions, and avoids recursively diffing the full GameState.
    let expected = vec![
        ValuePatch {
            path: vec![
                PathSegment::Key("tray".to_owned()),
                PathSegment::Key(item_id.to_owned()),
            ],
            operation: "set".to_owned(),
            value: Some(Value::from(target_remaining)),
        },
        ValuePatch {
            path: vec![PathSegment::Key("cargo".to_owned())],
            operation: "set".to_owned(),
            value: Some(json!({
                "itemId": item_id,
                "amount": next_held,
                "origin": { "kind": "tray" },
            })),
        },
    ];
    exact_patch_sets_match(&command.top_level_changes, &expected)
}

fn validate_return_held_cargo(
    state: &CoreState,
    command: &SimulationCommandPatch,
) -> anyhow::Result<()> {
    let base = state.base_value();
    active_planet_id(state, base)?;
    let cargo = held_cargo(state, base)?
        .ok_or_else(|| anyhow!("native factory inventory held-cargo return has no cargo"))?;
    let (inventory_root, current) = if is_portable_fleet_item(&cargo.item_id) {
        let portable = base
            .get("portableFleet")
            .and_then(Value::as_object)
            .ok_or_else(|| anyhow!("native factory inventory portable fleet is invalid"))?;
        (
            "portableFleet",
            optional_safe_nonnegative_integer(
                portable.get(&cargo.item_id),
                "portable fleet return target",
            )?,
        )
    } else {
        (
            "tray",
            optional_safe_nonnegative_integer(
                active_tray(base)?.get(&cargo.item_id),
                "held-cargo tray return target",
            )?,
        )
    };
    let next = current
        .checked_add(cargo.amount)
        .filter(|value| *value <= MAX_JAVASCRIPT_SAFE_INTEGER)
        .ok_or_else(|| anyhow!("native factory inventory held-cargo return overflows"))?;
    // Manual/protective returns intentionally ignore the configured tray
    // limit: the held cursor must never become trapped and no material may
    // vanish. Portable fleet items keep the existing JavaScript redirection.
    let expected = vec![
        ValuePatch {
            path: vec![
                PathSegment::Key(inventory_root.to_owned()),
                PathSegment::Key(cargo.item_id.clone()),
            ],
            operation: "set".to_owned(),
            value: Some(Value::from(next)),
        },
        ValuePatch {
            path: vec![PathSegment::Key("cargo".to_owned())],
            operation: "set".to_owned(),
            value: Some(Value::Null),
        },
    ];
    exact_patch_sets_match(&command.top_level_changes, &expected)
}

fn validate_active_tray_item_limit(
    state: &CoreState,
    command: &SimulationCommandPatch,
) -> anyhow::Result<()> {
    let base = state.base_value();
    let planet_id = active_planet_id(state, base)?;
    if command.top_level_changes.len() != 1 {
        bail!("native factory inventory tray-limit patch set is incomplete or mixed")
    }
    let change = &command.top_level_changes[0];
    if !path_equals(&change.path, &["planetTrayItemLimits", planet_id]) || change.operation != "set"
    {
        bail!("native factory inventory tray-limit path is not canonical")
    }
    let target = safe_nonnegative_integer(change.value.as_ref(), "tray-limit target")?;
    if !(MIN_TRAY_ITEM_LIMIT..=MAX_TRAY_ITEM_LIMIT).contains(&target) {
        bail!("native factory inventory tray-limit target is outside game bounds")
    }
    if effective_tray_item_limit(base, planet_id)? == target {
        bail!("native factory inventory tray-limit target is unchanged")
    }
    exact_patch_sets_match(
        &command.top_level_changes,
        &[ValuePatch {
            path: vec![
                PathSegment::Key("planetTrayItemLimits".to_owned()),
                PathSegment::Key(planet_id.to_owned()),
            ],
            operation: "set".to_owned(),
            value: Some(Value::from(target)),
        }],
    )
}

pub(crate) fn validate_factory_inventory_command(
    state: &CoreState,
    command: &SimulationCommandPatch,
) -> anyhow::Result<()> {
    if !patches_have_only_top_level_changes(command)
        || command.top_level_changes.is_empty()
        || command
            .top_level_changes
            .iter()
            .any(|change| !inventory_root(&change.path))
    {
        bail!("native factory inventory command shape is invalid")
    }
    if command.top_level_changes.iter().any(|change| {
        matches!(
            change.path.first(),
            Some(PathSegment::Key(root)) if root == "planetTrayItemLimits"
        )
    }) {
        return validate_active_tray_item_limit(state, command);
    }
    let returns_cargo = command.top_level_changes.iter().any(|change| {
        path_equals(&change.path, &["cargo"])
            && change.operation == "set"
            && change.value.as_ref().is_some_and(Value::is_null)
    });
    if returns_cargo {
        validate_return_held_cargo(state, command)
    } else {
        validate_take_from_active_tray(state, command)
    }
}

impl CoreState {
    /// Returns a stable page of the current native tray without transferring a
    /// full GameState. Item IDs use Rust string order, which is lexicographic
    /// UTF-8 byte order, so the same cursor is deterministic for one revision.
    pub fn factory_inventory_projection(
        &self,
        expected_revision: u64,
        cursor: usize,
        limit: usize,
    ) -> anyhow::Result<Value> {
        if expected_revision != self.revision || !(1..=MAX_PAGE_ROWS).contains(&limit) {
            bail!("native factory inventory projection request is invalid")
        }
        let base = self.base_value();
        let active_planet_id = active_planet_id(self, base)?;
        let tray_item_limit = effective_tray_item_limit(base, active_planet_id)?;
        let tray = active_tray(base)?;
        let mut inventory = Vec::<(&str, u64)>::with_capacity(tray.len());
        for (item_id, amount) in tray {
            known_item_id(self, item_id)?;
            let amount = safe_nonnegative_integer(Some(amount), "tray item amount")?;
            if amount > 0 {
                inventory.push((item_id, amount));
            }
        }
        inventory.sort_unstable_by(|left, right| left.0.as_bytes().cmp(right.0.as_bytes()));
        let total_count = inventory.len();
        if cursor > total_count {
            bail!("native factory inventory projection cursor is invalid")
        }
        let rows = inventory
            .iter()
            .skip(cursor)
            .take(limit)
            .map(|(item_id, amount)| {
                json!({
                    "itemId": item_id,
                    "amount": amount,
                    "freeCapacity": tray_item_limit.saturating_sub(*amount),
                    "overLimit": *amount > tray_item_limit,
                })
            })
            .collect::<Vec<_>>();
        let consumed = cursor
            .checked_add(rows.len())
            .ok_or_else(|| anyhow!("native factory inventory projection cursor overflows"))?;
        let next_cursor = (consumed < total_count).then_some(consumed);
        let cargo = held_cargo(self, base)?.map_or(Value::Null, |cargo| {
            let origin = cargo.origin.map_or(
                Value::Null,
                |origin| json!({ "kind": origin.kind, "id": origin.id }),
            );
            json!({ "itemId": cargo.item_id, "amount": cargo.amount, "origin": origin })
        });
        let portable_fleet = base
            .get("portableFleet")
            .and_then(Value::as_object)
            .ok_or_else(|| anyhow!("native factory inventory portable fleet is invalid"))?;
        let logistics_drone = optional_safe_nonnegative_integer(
            portable_fleet.get("logistics_drone"),
            "portable logistics drone amount",
        )?;
        let logistics_vessel = optional_safe_nonnegative_integer(
            portable_fleet.get("logistics_vessel"),
            "portable logistics vessel amount",
        )?;
        let value = json!({
            "schemaVersion": 1,
            "projectionType": FACTORY_INVENTORY_PROJECTION,
            "source": "native-core",
            "revision": self.revision,
            "stateVersion": self.identity.state_version,
            "registryFingerprint": self.catalog.snapshot.registry_fingerprint,
            "activePlanetId": active_planet_id,
            "cargo": cargo,
            "pickupTargetAmount": PICKUP_TARGET_AMOUNT,
            "portableFleet": {
                "logistics_drone": logistics_drone,
                "logistics_vessel": logistics_vessel,
            },
            "trayItemLimit": tray_item_limit,
            "trayItemLimitBounds": {
                "minimum": MIN_TRAY_ITEM_LIMIT,
                "default": DEFAULT_TRAY_ITEM_LIMIT,
                "maximum": MAX_TRAY_ITEM_LIMIT,
            },
            "request": { "expectedRevision": expected_revision, "cursor": cursor, "limit": limit },
            "totalCount": total_count,
            "rows": rows,
            "nextCursor": next_cursor,
            "truncated": next_cursor.is_some(),
            "limits": { "rows": MAX_PAGE_ROWS, "projectionBytes": MAX_PROJECTION_BYTES },
        });
        if serde_json::to_vec(&value)?.len() > MAX_PROJECTION_BYTES {
            bail!("native factory inventory projection exceeds the byte limit")
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

    const REGISTRY: &str = "factory-inventory-test";

    fn catalog() -> RuntimeCatalog {
        let snapshot: CatalogSnapshot = serde_json::from_value(json!({
            "protocolVersion": crate::CORE_PROTOCOL_VERSION,
            "registryFingerprint": REGISTRY,
            "planets": [
                { "id": "home", "systemId": "helios", "kind": "terrestrial", "orbitIndex": 1 },
                { "id": "ashen", "systemId": "sigma", "kind": "terrestrial", "orbitIndex": 1 }
            ],
            "items": [
                { "id": "iron_ore", "kind": "solid" },
                { "id": "MOD/item-beta", "kind": "solid" },
                { "id": "zeta_ore", "kind": "solid" },
                { "id": "logistics_drone", "kind": "solid" },
                { "id": "logistics_vessel", "kind": "solid" }
            ],
            "buildings": [],
            "recipes": [],
            "constructions": [],
            "belts": [],
            "technologies": []
        }))
        .unwrap();
        RuntimeCatalog::validate(snapshot, REGISTRY).unwrap()
    }

    fn state() -> CoreState {
        let base = json!({
            "version": 47,
            "mode": "normal",
            "activePlanetId": "home",
            "elapsedSeconds": 10,
            "paused": false,
            "cargo": null,
            "tray": {
                "iron_ore": 150,
                "MOD/item-beta": 7,
                "zeta_ore": 3,
                "logistics_drone": 0
            },
            "planetTrays": { "home": {}, "ashen": {} },
            "planetTrayItemLimits": { "home": 1000, "ashen": 2000 },
            "portableFleet": { "logistics_drone": 3, "logistics_vessel": 4 },
            "settings": { "simulationSpeed": 1 },
            "exploration": { "colonizedPlanetIds": ["home", "ashen"], "unlockedSystemIds": ["helios", "sigma"] }
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

    fn command(revision: u64, changes: Vec<ValuePatch>) -> SimulationCommandPatch {
        SimulationCommandPatch {
            protocol_version: crate::CORE_PROTOCOL_VERSION,
            base_revision: revision,
            top_level_changes: changes,
            changed_entities: Vec::new(),
            added_entities: Vec::new(),
            removed_entity_ids: Vec::new(),
            changed_belts: Vec::new(),
            added_belts: Vec::new(),
            removed_belt_ids: Vec::new(),
        }
    }

    fn set(path: &[&str], value: Value) -> ValuePatch {
        ValuePatch {
            path: path
                .iter()
                .map(|segment| PathSegment::Key((*segment).to_owned()))
                .collect(),
            operation: "set".to_owned(),
            value: Some(value),
        }
    }

    #[test]
    fn projection_pages_sorted_utf8_rows_without_hiding_mod_items() {
        let state = state();
        let before = state.summary().unwrap().canonical_sha256;
        let first = state.factory_inventory_projection(7, 0, 2).unwrap();
        assert_eq!(first["projectionType"], FACTORY_INVENTORY_PROJECTION);
        assert_eq!(first["revision"], 7);
        assert_eq!(first["activePlanetId"], "home");
        assert_eq!(first["registryFingerprint"], REGISTRY);
        assert_eq!(first["trayItemLimit"], 1_000);
        assert_eq!(first["pickupTargetAmount"], 100);
        assert_eq!(first["portableFleet"]["logistics_drone"], 3);
        assert_eq!(first["portableFleet"]["logistics_vessel"], 4);
        assert_eq!(first["totalCount"], 3);
        assert_eq!(first["rows"][0]["itemId"], "MOD/item-beta");
        assert_eq!(first["rows"][1]["itemId"], "iron_ore");
        assert_eq!(first["nextCursor"], 2);
        assert_eq!(first["truncated"], true);
        assert!(first["cargo"].is_null());

        let second = state.factory_inventory_projection(7, 2, 2).unwrap();
        assert_eq!(second["rows"][0]["itemId"], "zeta_ore");
        assert!(second["nextCursor"].is_null());
        assert_eq!(second["truncated"], false);
        assert_eq!(second["trayItemLimit"], first["trayItemLimit"]);
        assert_eq!(second["portableFleet"], first["portableFleet"]);
        assert_eq!(state.summary().unwrap().canonical_sha256, before);
    }

    #[test]
    fn projection_is_revision_bounded_and_rejects_invalid_inventory() {
        let state = state();
        assert!(state.factory_inventory_projection(6, 0, 2).is_err());
        assert!(state.factory_inventory_projection(7, 0, 0).is_err());
        assert!(
            state
                .factory_inventory_projection(7, 0, MAX_PAGE_ROWS + 1)
                .is_err()
        );
        assert!(state.factory_inventory_projection(7, 4, 1).is_err());

        let mut fractional = state.clone();
        fractional.base_value_mut()["tray"]["iron_ore"] = json!(1.5);
        assert!(fractional.factory_inventory_projection(7, 0, 2).is_err());
        let mut unsafe_integer = state.clone();
        unsafe_integer.base_value_mut()["tray"]["iron_ore"] = json!(9_007_199_254_740_992_u64);
        assert!(
            unsafe_integer
                .factory_inventory_projection(7, 0, 2)
                .is_err()
        );
        let mut unknown_item = state.clone();
        unknown_item.base_value_mut()["tray"]["unknown-mod-item"] = json!(1);
        assert!(unknown_item.factory_inventory_projection(7, 0, 2).is_err());
        let mut historical_cargo = state;
        historical_cargo.base_value_mut()["cargo"] = json!({
            "itemId": "iron_ore",
            "amount": 101,
            "origin": { "kind": "tray", "id": "historical-origin", "modTag": 7 },
            "modPayload": { "owner": "pack:test" }
        });
        let projection = historical_cargo
            .factory_inventory_projection(7, 0, 2)
            .unwrap();
        assert_eq!(projection["cargo"]["amount"], 101);
        assert_eq!(projection["cargo"]["origin"]["kind"], "tray");
        assert_eq!(projection["cargo"]["origin"]["id"], "historical-origin");
    }

    #[test]
    fn player_authority_fills_an_empty_or_same_item_held_stack_canonically() {
        let mut empty = state();
        let take = command(
            7,
            vec![
                set(&["tray", "iron_ore"], json!(50)),
                set(
                    &["cargo"],
                    json!({ "itemId": "iron_ore", "amount": 100, "origin": { "kind": "tray" } }),
                ),
            ],
        );
        let applied = empty.apply_player_authority_command(&take).unwrap();
        assert!(!applied.topology_dirty);
        assert_eq!(empty.base_value()["tray"]["iron_ore"], 50);
        assert_eq!(empty.base_value()["cargo"]["amount"], 100);

        let mut same_item = state();
        same_item.base_value_mut()["cargo"] = json!({
            "itemId": "iron_ore",
            "amount": 40,
            "origin": { "kind": "node-output", "id": "source-node", "modTag": 7 },
            "modPayload": { "owner": "pack:test" }
        });
        let refill = command(
            7,
            vec![
                set(&["tray", "iron_ore"], json!(90)),
                set(
                    &["cargo"],
                    json!({ "itemId": "iron_ore", "amount": 100, "origin": { "kind": "tray" } }),
                ),
            ],
        );
        same_item.apply_player_authority_command(&refill).unwrap();
        assert_eq!(same_item.base_value()["tray"]["iron_ore"], 90);
        assert_eq!(same_item.base_value()["cargo"]["amount"], 100);
        assert_eq!(
            same_item.base_value()["cargo"]["origin"],
            json!({ "kind": "tray" })
        );
    }

    #[test]
    fn player_authority_tray_take_rejects_mixing_partial_or_forged_accounting() {
        let mut mixed = state();
        mixed.base_value_mut()["cargo"] =
            json!({ "itemId": "MOD/item-beta", "amount": 1, "origin": { "kind": "tray" } });
        let before = mixed.summary().unwrap().canonical_sha256;
        let forged = command(
            7,
            vec![
                set(&["tray", "iron_ore"], json!(149)),
                set(
                    &["cargo"],
                    json!({ "itemId": "iron_ore", "amount": 1, "origin": { "kind": "tray" } }),
                ),
            ],
        );
        assert!(mixed.apply_player_authority_command(&forged).is_err());
        assert_eq!(mixed.summary().unwrap().canonical_sha256, before);

        let mut partial = state();
        let before = partial.summary().unwrap().canonical_sha256;
        assert!(partial.apply_player_authority_command(&forged).is_err());
        assert_eq!(partial.summary().unwrap().canonical_sha256, before);

        let mut extra = command(
            7,
            vec![
                set(&["tray", "iron_ore"], json!(50)),
                set(
                    &["cargo"],
                    json!({ "itemId": "iron_ore", "amount": 100, "origin": { "kind": "tray" } }),
                ),
                set(&["portableFleet", "logistics_drone"], json!(999)),
            ],
        );
        assert!(partial.apply_player_authority_command(&extra).is_err());
        extra.base_revision = 6;
        assert!(partial.apply_player_authority_command(&extra).is_err());

        let mut historical = state();
        historical.base_value_mut()["cargo"] =
            json!({ "itemId": "iron_ore", "amount": 101, "origin": { "kind": "tray" } });
        let before = historical.summary().unwrap().canonical_sha256;
        // The old JavaScript expression could turn a negative room into a
        // negative take, increasing the tray while shrinking the held stack.
        // Native authority treats a full/overfull historical stack as no-op.
        let reverse_transfer = command(
            7,
            vec![
                set(&["tray", "iron_ore"], json!(151)),
                set(&["cargo", "amount"], json!(100)),
            ],
        );
        assert!(
            historical
                .apply_player_authority_command(&reverse_transfer)
                .is_err()
        );
        assert_eq!(historical.summary().unwrap().canonical_sha256, before);
    }

    #[test]
    fn player_authority_returns_regular_cargo_losslessly_above_a_lowered_limit() {
        let mut state = state();
        state.base_value_mut()["tray"]["iron_ore"] = json!(1_000);
        state.base_value_mut()["cargo"] = json!({
            "itemId": "iron_ore",
            "amount": 125,
            "origin": { "kind": "tray", "id": "historical-origin", "modTag": 7 },
            "modPayload": { "owner": "pack:test" }
        });
        let return_command = command(
            7,
            vec![
                set(&["tray", "iron_ore"], json!(1_125)),
                set(&["cargo"], Value::Null),
            ],
        );
        state
            .apply_player_authority_command(&return_command)
            .unwrap();
        assert_eq!(state.base_value()["tray"]["iron_ore"], 1_125);
        assert!(state.base_value()["cargo"].is_null());
        let projection = state.factory_inventory_projection(8, 0, 8).unwrap();
        let iron = projection["rows"]
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["itemId"] == "iron_ore")
            .unwrap();
        assert_eq!(iron["freeCapacity"], 0);
        assert_eq!(iron["overLimit"], true);
    }

    #[test]
    fn player_authority_returns_portable_fleet_to_its_lossless_global_inventory() {
        let mut state = state();
        state.base_value_mut()["cargo"] = json!({
            "itemId": "logistics_drone",
            "amount": 7,
            "origin": { "kind": "node-output", "id": "station" }
        });
        let tray_before = state.base_value()["tray"].clone();
        let return_command = command(
            7,
            vec![
                set(&["portableFleet", "logistics_drone"], json!(10)),
                set(&["cargo"], Value::Null),
            ],
        );
        state
            .apply_player_authority_command(&return_command)
            .unwrap();
        assert_eq!(state.base_value()["portableFleet"]["logistics_drone"], 10);
        assert_eq!(state.base_value()["tray"], tray_before);
        assert!(state.base_value()["cargo"].is_null());
        let projection = state.factory_inventory_projection(8, 0, 8).unwrap();
        assert_eq!(projection["portableFleet"]["logistics_drone"], 10);
    }

    #[test]
    fn player_authority_return_rejects_overflow_or_forged_destination_atomically() {
        let mut overflow = state();
        overflow.base_value_mut()["tray"]["iron_ore"] = Value::from(MAX_JAVASCRIPT_SAFE_INTEGER);
        overflow.base_value_mut()["cargo"] =
            json!({ "itemId": "iron_ore", "amount": 1, "origin": { "kind": "tray" } });
        let before = overflow.summary().unwrap().canonical_sha256;
        let overflow_command = command(
            7,
            vec![
                set(&["tray", "iron_ore"], json!(MAX_JAVASCRIPT_SAFE_INTEGER)),
                set(&["cargo"], Value::Null),
            ],
        );
        assert!(
            overflow
                .apply_player_authority_command(&overflow_command)
                .is_err()
        );
        assert_eq!(overflow.summary().unwrap().canonical_sha256, before);

        let mut portable = state();
        portable.base_value_mut()["cargo"] = json!({
            "itemId": "logistics_drone",
            "amount": 7,
            "origin": { "kind": "tray" }
        });
        let forged = command(
            7,
            vec![
                set(&["tray", "logistics_drone"], json!(7)),
                set(&["cargo"], Value::Null),
            ],
        );
        assert!(portable.apply_player_authority_command(&forged).is_err());
    }

    #[test]
    fn player_authority_sets_only_the_active_planet_limit_within_game_bounds() {
        let mut state = state();
        let valid = command(
            7,
            vec![set(&["planetTrayItemLimits", "home"], json!(100_000_000))],
        );
        state.apply_player_authority_command(&valid).unwrap();
        assert_eq!(
            state.base_value()["planetTrayItemLimits"]["home"],
            100_000_000
        );

        for (revision, path, value) in [
            (8, vec!["planetTrayItemLimits", "home"], json!(999)),
            (8, vec!["planetTrayItemLimits", "home"], json!(100_000_001)),
            (8, vec!["planetTrayItemLimits", "ashen"], json!(2_000)),
            (8, vec!["planetTrayItemLimits", "home"], json!(100_000_000)),
        ] {
            let before = state.summary().unwrap().canonical_sha256;
            assert!(
                state
                    .apply_player_authority_command(&command(revision, vec![set(&path, value)]))
                    .is_err()
            );
            assert_eq!(state.summary().unwrap().canonical_sha256, before);
        }
    }
}
