//! Bounded semantic commands for selection-wide factory mutations.
//!
//! The renderer sends only an operation plus opaque selected row IDs.  Rust
//! re-reads the exact current revision, derives every stack/lane limit and
//! construction debit/refund, then expands the marker to one ordinary patch.
//! The compact marker is what the durable WAL stores, so cold replay performs
//! the same derivation from the same source revision and cannot double-spend a
//! renderer-authored material estimate.

use std::collections::{BTreeMap, HashSet};

use anyhow::{anyhow, bail};
use serde_json::Value;

use crate::{
    command::{
        PathSegment, RecordPatch, SimulationCommandPatch, ValuePatch,
        ordinary_building_removal_eligibility_with_incident_allowlist,
    },
    state::CoreState,
};

const INTENT_ROOT: &str = "factoryBatch";
const INTENT_LEAF: &str = "intent";
const MAX_ENTITY_ROWS: usize = 4_096;
const MAX_BELT_ROWS: usize = 8_192;
const MAX_OPAQUE_ID_BYTES: usize = 512;
const MAX_BUILDING_STACK: u64 = 100_000_000;
const MAX_BELT_LANES: u64 = 4_096;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BatchKind {
    Increase,
    Remove,
    UpgradeBuildings,
    UpgradeBelts,
}

#[derive(Debug, Clone)]
struct BatchIntent {
    kind: BatchKind,
    entity_ids: Vec<String>,
    belt_ids: Vec<String>,
    amount: Option<u64>,
}

fn exact_intent_path(path: &[PathSegment]) -> bool {
    matches!(
        path,
        [PathSegment::Key(root), PathSegment::Key(leaf)]
            if root == INTENT_ROOT && leaf == INTENT_LEAF
    )
}

pub(crate) fn command_contains_intent(command: &SimulationCommandPatch) -> bool {
    command
        .top_level_changes
        .iter()
        .any(|change| exact_intent_path(&change.path))
}

fn valid_opaque_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= MAX_OPAQUE_ID_BYTES && !value.chars().any(char::is_control)
}

fn parse_unique_ids(
    value: Option<&Value>,
    label: &str,
    limit: usize,
) -> anyhow::Result<Vec<String>> {
    let values = value
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("native factory batch {label} IDs are invalid"))?;
    if values.len() > limit {
        bail!("native factory batch {label} scope exceeds its row limit")
    }
    let mut seen = HashSet::<&str>::with_capacity(values.len());
    let mut result = Vec::with_capacity(values.len());
    for value in values {
        let id = value
            .as_str()
            .filter(|id| valid_opaque_id(id))
            .ok_or_else(|| anyhow!("native factory batch {label} ID is invalid"))?;
        if !seen.insert(id) {
            bail!("native factory batch {label} ID is repeated")
        }
        result.push(id.to_owned());
    }
    Ok(result)
}

fn require_intent(command: &SimulationCommandPatch) -> anyhow::Result<BatchIntent> {
    if command.top_level_changes.len() != 1
        || !command.changed_entities.is_empty()
        || !command.added_entities.is_empty()
        || !command.removed_entity_ids.is_empty()
        || !command.changed_belts.is_empty()
        || !command.added_belts.is_empty()
        || !command.removed_belt_ids.is_empty()
    {
        bail!("native player-authority factory batch intent shape is invalid")
    }
    let change = &command.top_level_changes[0];
    if !exact_intent_path(&change.path) || change.operation != "set" {
        bail!("native player-authority factory batch intent path is invalid")
    }
    let value = change
        .value
        .as_ref()
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("native player-authority factory batch intent is invalid"))?;
    if value
        .keys()
        .any(|key| !matches!(key.as_str(), "kind" | "entityIds" | "beltIds" | "amount"))
        || !value.contains_key("kind")
        || !value.contains_key("entityIds")
        || !value.contains_key("beltIds")
    {
        bail!("native player-authority factory batch intent fields are invalid")
    }
    let kind = match value.get("kind").and_then(Value::as_str) {
        Some("increase") => BatchKind::Increase,
        Some("remove") => BatchKind::Remove,
        Some("upgrade-buildings") => BatchKind::UpgradeBuildings,
        Some("upgrade-belts") => BatchKind::UpgradeBelts,
        _ => bail!("native player-authority factory batch kind is invalid"),
    };
    let entity_ids = parse_unique_ids(value.get("entityIds"), "entity", MAX_ENTITY_ROWS)?;
    let belt_ids = parse_unique_ids(value.get("beltIds"), "belt", MAX_BELT_ROWS)?;
    let amount = value
        .get("amount")
        .map(|value| {
            value
                .as_u64()
                .filter(|amount| *amount > 0 && *amount <= 1_000_000)
                .ok_or_else(|| anyhow!("native player-authority factory batch amount is invalid"))
        })
        .transpose()?;
    match kind {
        BatchKind::Increase if amount.is_none() => {
            bail!("native player-authority factory batch increase amount is missing")
        }
        BatchKind::Increase => {}
        _ if amount.is_some() => {
            bail!("native player-authority factory batch amount is unexpected")
        }
        _ => {}
    }
    match kind {
        BatchKind::UpgradeBuildings if entity_ids.is_empty() || !belt_ids.is_empty() => {
            bail!("native player-authority building upgrade scope is invalid")
        }
        BatchKind::UpgradeBelts if belt_ids.is_empty() || !entity_ids.is_empty() => {
            bail!("native player-authority belt upgrade scope is invalid")
        }
        _ if entity_ids.is_empty() && belt_ids.is_empty() => {
            bail!("native player-authority factory batch scope is empty")
        }
        _ => {}
    }
    Ok(BatchIntent {
        kind,
        entity_ids,
        belt_ids,
        amount,
    })
}

pub(crate) fn validate_resume_marker(command: &SimulationCommandPatch) -> anyhow::Result<()> {
    require_intent(command).map(|_| ())
}

fn safe_integer(value: Option<&Value>, label: &str) -> anyhow::Result<u64> {
    match value {
        None | Some(Value::Null) => Ok(0),
        Some(value) => value
            .as_u64()
            .filter(|value| *value <= MAX_SAFE_INTEGER)
            .ok_or_else(|| anyhow!("native factory batch {label} is not a safe integer")),
    }
}

fn active_planet_id(state: &CoreState) -> anyhow::Result<&str> {
    let id = state
        .base_value()
        .get("activePlanetId")
        .and_then(Value::as_str)
        .filter(|id| valid_opaque_id(id))
        .ok_or_else(|| anyhow!("native factory batch active planet is invalid"))?;
    if !state.catalog.planets.iter().any(|planet| planet.id == id) {
        bail!("native factory batch active planet is not in the catalog")
    }
    Ok(id)
}

fn construction_inventory(state: &CoreState) -> anyhow::Result<&serde_json::Map<String, Value>> {
    state
        .base_value()
        .get("construction")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("native factory batch construction inventory is missing"))
}

fn add_delta(
    deltas: &mut BTreeMap<String, i128>,
    construction_id: &str,
    delta: i128,
) -> anyhow::Result<()> {
    if !valid_opaque_id(construction_id) {
        bail!("native factory batch construction ID is invalid")
    }
    let entry = deltas.entry(construction_id.to_owned()).or_default();
    *entry = entry
        .checked_add(delta)
        .ok_or_else(|| anyhow!("native factory batch construction delta overflowed"))?;
    Ok(())
}

fn construction_patches(
    state: &CoreState,
    deltas: BTreeMap<String, i128>,
) -> anyhow::Result<Vec<ValuePatch>> {
    let inventory = construction_inventory(state)?;
    deltas
        .into_iter()
        .filter(|(_, delta)| *delta != 0)
        .map(|(id, delta)| {
            let current = safe_integer(inventory.get(&id), "construction inventory")?;
            let next = i128::from(current)
                .checked_add(delta)
                .filter(|value| *value >= 0 && *value <= i128::from(MAX_SAFE_INTEGER))
                .ok_or_else(|| {
                    anyhow!(
                        "native factory batch construction inventory is insufficient or overflowed"
                    )
                })?;
            Ok(ValuePatch {
                path: vec![
                    PathSegment::Key("construction".to_owned()),
                    PathSegment::Key(id),
                ],
                operation: "set".to_owned(),
                value: Some(Value::from(u64::try_from(next)?)),
            })
        })
        .collect()
}

fn core_extractor_for_resource(resource_id: &str) -> &'static str {
    match resource_id {
        "crude_oil" => "oil_extractor",
        "water" | "sulfuric_acid" => "water_pump",
        _ => "mining_machine",
    }
}

fn belt_construction_id(state: &CoreState, tier: u8) -> Option<String> {
    let built_in = match tier {
        1 => Some("conveyor_belt_mk1"),
        2 => Some("conveyor_belt_mk2"),
        3 => Some("conveyor_belt_mk3"),
        _ => None,
    };
    built_in
        .filter(|id| state.catalog.constructions.contains_key(*id))
        .map(str::to_owned)
        .or_else(|| state.catalog.belt_construction_ids.get(&tier).cloned())
}

fn completed_technology(state: &CoreState, technology_id: &str) -> bool {
    state
        .base_value()
        .get("research")
        .and_then(|research| research.get("completedTechIds"))
        .and_then(Value::as_array)
        .is_some_and(|ids| ids.iter().any(|id| id.as_str() == Some(technology_id)))
}

fn entity_change(id: String, path: &str, value: Value) -> RecordPatch {
    RecordPatch {
        id,
        changes: vec![ValuePatch {
            path: vec![PathSegment::Key(path.to_owned())],
            operation: "set".to_owned(),
            value: Some(value),
        }],
    }
}

fn belt_change(id: String, changes: Vec<ValuePatch>) -> RecordPatch {
    RecordPatch { id, changes }
}

fn expand_increase(
    state: &CoreState,
    intent: &BatchIntent,
) -> anyhow::Result<SimulationCommandPatch> {
    let active_planet = active_planet_id(state)?;
    let amount = intent.amount.expect("validated increase amount");
    let mut deltas = BTreeMap::<String, i128>::new();
    let mut changed_entities = Vec::new();
    let mut changed_belts = Vec::new();

    for id in &intent.entity_ids {
        let index = *state
            .entity_index
            .get(id)
            .ok_or_else(|| anyhow!("native factory batch entity is missing"))?;
        let entity = state.parse_entity(index)?;
        if entity.get("planetId").and_then(Value::as_str) != Some(active_planet)
            || entity.get("interactionLocked").and_then(Value::as_bool) == Some(true)
        {
            continue;
        }
        if entity.get("kind").and_then(Value::as_str) == Some("vein") {
            let current = safe_integer(entity.get("minerCount"), "miner count")?;
            let target = current
                .checked_add(amount)
                .filter(|value| *value <= MAX_BUILDING_STACK)
                .ok_or_else(|| anyhow!("native factory batch miner stack exceeds its limit"))?;
            let resource_id = entity
                .get("resourceId")
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow!("native factory batch vein resource is invalid"))?;
            let construction_id = entity
                .get("extractorBuildingId")
                .and_then(Value::as_str)
                .unwrap_or_else(|| core_extractor_for_resource(resource_id));
            if !state.catalog.constructions.contains_key(construction_id) {
                bail!("native factory batch extractor construction is unknown")
            }
            add_delta(&mut deltas, construction_id, -i128::from(amount))?;
            changed_entities.push(entity_change(id.clone(), "minerCount", Value::from(target)));
            continue;
        }
        let building_id = entity
            .get("buildingId")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow!("native factory batch building ID is missing"))?;
        let building = state
            .catalog
            .buildings
            .get(building_id)
            .ok_or_else(|| anyhow!("native factory batch building is unknown"))?;
        if !matches!(
            building.kind.as_str(),
            "machine" | "power" | "storage" | "splitter"
        ) || state
            .catalog
            .building_metadata
            .get(building_id)
            .is_some_and(|metadata| metadata.unique)
        {
            continue;
        }
        let current = safe_integer(entity.get("machineCount"), "machine count")?;
        let target = current
            .checked_add(amount)
            .filter(|value| *value <= MAX_BUILDING_STACK)
            .ok_or_else(|| anyhow!("native factory batch building stack exceeds its limit"))?;
        let policy = state.catalog.building_stack_policies.get(building_id);
        if !policy.is_some_and(|policy| policy.complete)
            || policy
                .and_then(|policy| policy.limit)
                .is_some_and(|limit| target > limit)
        {
            continue;
        }
        if !state.catalog.constructions.contains_key(building_id) {
            bail!("native factory batch building construction is unknown")
        }
        add_delta(&mut deltas, building_id, -i128::from(amount))?;
        changed_entities.push(entity_change(
            id.clone(),
            "machineCount",
            Value::from(target),
        ));
    }

    for id in &intent.belt_ids {
        let index = *state
            .belt_index
            .get(id)
            .ok_or_else(|| anyhow!("native factory batch belt is missing"))?;
        let belt = state.parse_belt(index)?;
        if belt.get("planetId").and_then(Value::as_str) != Some(active_planet) {
            continue;
        }
        let current = safe_integer(belt.get("lanes"), "belt lanes")?;
        let Some(target) = current.checked_add(amount) else {
            bail!("native factory batch belt lanes overflowed")
        };
        if target > MAX_BELT_LANES {
            continue;
        }
        let tier = safe_integer(belt.get("tier"), "belt tier")?;
        let construction_id = belt_construction_id(state, u8::try_from(tier)?)
            .ok_or_else(|| anyhow!("native factory batch belt construction is unknown"))?;
        add_delta(&mut deltas, &construction_id, -i128::from(amount))?;
        changed_belts.push(belt_change(
            id.clone(),
            vec![ValuePatch {
                path: vec![PathSegment::Key("lanes".to_owned())],
                operation: "set".to_owned(),
                value: Some(Value::from(target)),
            }],
        ));
    }
    if changed_entities.is_empty() && changed_belts.is_empty() {
        bail!("native factory batch increase has no eligible rows")
    }
    changed_entities.sort_by(|left, right| left.id.cmp(&right.id));
    changed_belts.sort_by(|left, right| left.id.cmp(&right.id));
    Ok(SimulationCommandPatch {
        protocol_version: command_protocol(state),
        base_revision: state.revision,
        top_level_changes: construction_patches(state, deltas)?,
        changed_entities,
        added_entities: Vec::new(),
        removed_entity_ids: Vec::new(),
        changed_belts,
        added_belts: Vec::new(),
        removed_belt_ids: Vec::new(),
    })
}

fn command_protocol(_state: &CoreState) -> u16 {
    crate::CORE_PROTOCOL_VERSION
}

fn expand_remove(
    state: &CoreState,
    intent: &BatchIntent,
) -> anyhow::Result<SimulationCommandPatch> {
    let active_planet = active_planet_id(state)?;
    let selected_entities = intent.entity_ids.iter().cloned().collect::<HashSet<_>>();
    let mut removed_belts = intent.belt_ids.iter().cloned().collect::<HashSet<_>>();
    for index in 0..state.belt_index.len() {
        let belt = state.parse_belt(index)?;
        let source = belt.get("source").and_then(Value::as_str);
        let target = belt.get("target").and_then(Value::as_str);
        if source.is_some_and(|id| selected_entities.contains(id))
            || target.is_some_and(|id| selected_entities.contains(id))
        {
            let id = belt
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| valid_opaque_id(id))
                .ok_or_else(|| anyhow!("native factory batch incident belt ID is invalid"))?;
            removed_belts.insert(id.to_owned());
        }
    }
    if removed_belts.len() > MAX_BELT_ROWS {
        bail!("native factory batch derived belt scope exceeds its row limit")
    }

    let mut deltas = BTreeMap::<String, i128>::new();
    let mut changed_entities = Vec::<RecordPatch>::new();
    let mut removed_entities = Vec::<String>::new();
    for id in &intent.entity_ids {
        let index = *state
            .entity_index
            .get(id)
            .ok_or_else(|| anyhow!("native factory batch entity is missing"))?;
        let entity = state.parse_entity(index)?;
        if entity.get("planetId").and_then(Value::as_str) != Some(active_planet)
            || entity.get("interactionLocked").and_then(Value::as_bool) == Some(true)
        {
            continue;
        }
        if entity.get("kind").and_then(Value::as_str) == Some("vein") {
            let count = safe_integer(entity.get("minerCount"), "miner count")?;
            if count == 0 {
                continue;
            }
            let resource_id = entity
                .get("resourceId")
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow!("native factory batch vein resource is invalid"))?;
            let construction_id = entity
                .get("extractorBuildingId")
                .and_then(Value::as_str)
                .unwrap_or_else(|| core_extractor_for_resource(resource_id));
            add_delta(&mut deltas, construction_id, i128::from(count))?;
            changed_entities.push(RecordPatch {
                id: id.clone(),
                changes: vec![
                    ValuePatch {
                        path: vec![PathSegment::Key("minerCount".to_owned())],
                        operation: "set".to_owned(),
                        value: Some(Value::from(0)),
                    },
                    ValuePatch {
                        path: vec![PathSegment::Key("utilization".to_owned())],
                        operation: "set".to_owned(),
                        value: Some(Value::from(0)),
                    },
                    ValuePatch {
                        path: vec![PathSegment::Key("productionRate".to_owned())],
                        operation: "set".to_owned(),
                        value: Some(Value::from(0)),
                    },
                    ValuePatch {
                        path: vec![PathSegment::Key("powerFactor".to_owned())],
                        operation: "delete".to_owned(),
                        value: None,
                    },
                ],
            });
            continue;
        }
        let eligibility = ordinary_building_removal_eligibility_with_incident_allowlist(
            state,
            id,
            &removed_belts,
        )?;
        if let Some(reason) = eligibility.unsupported_reason {
            bail!("native factory batch building removal is unsupported: {reason}")
        }
        let building_id = eligibility
            .building_id
            .ok_or_else(|| anyhow!("native factory batch removal building ID is missing"))?;
        let count = eligibility
            .machine_count
            .ok_or_else(|| anyhow!("native factory batch removal count is missing"))?;
        add_delta(&mut deltas, &building_id, i128::from(count))?;
        removed_entities.push(id.clone());
    }

    let mut removed_belt_ids = removed_belts.into_iter().collect::<Vec<_>>();
    removed_belt_ids.sort();
    for id in &removed_belt_ids {
        let eligibility = crate::construction_belt_removal_context::eligibility(state, id)?;
        if let Some(reason) = eligibility.unsupported_reason {
            bail!("native factory batch belt removal is unsupported: {reason}")
        }
        let construction_id = eligibility
            .construction_id
            .ok_or_else(|| anyhow!("native factory batch belt construction ID is missing"))?;
        let lanes = eligibility
            .lanes
            .ok_or_else(|| anyhow!("native factory batch belt lanes are missing"))?;
        add_delta(&mut deltas, &construction_id, i128::from(lanes))?;
    }
    if changed_entities.is_empty() && removed_entities.is_empty() && removed_belt_ids.is_empty() {
        bail!("native factory batch removal has no eligible rows")
    }
    changed_entities.sort_by(|left, right| left.id.cmp(&right.id));
    removed_entities.sort();
    Ok(SimulationCommandPatch {
        protocol_version: command_protocol(state),
        base_revision: state.revision,
        top_level_changes: construction_patches(state, deltas)?,
        changed_entities,
        added_entities: Vec::new(),
        removed_entity_ids: removed_entities,
        changed_belts: Vec::new(),
        added_belts: Vec::new(),
        removed_belt_ids,
    })
}

fn building_upgrade_target(state: &CoreState, building_id: &str) -> Option<String> {
    state
        .catalog
        .building_metadata
        .get(building_id)
        .and_then(|metadata| metadata.upgrade_target_id.clone())
        .or_else(|| match building_id {
            "assembling_machine_mk1" => Some("assembling_machine_mk2".to_owned()),
            "assembling_machine_mk2" => Some("assembling_machine_mk3".to_owned()),
            "arc_smelter" => Some("plane_smelter".to_owned()),
            "chemical_plant" => Some("quantum_chemical_plant".to_owned()),
            _ => None,
        })
}

fn expand_upgrade_buildings(
    state: &CoreState,
    intent: &BatchIntent,
) -> anyhow::Result<SimulationCommandPatch> {
    let active_planet = active_planet_id(state)?;
    let mut deltas = BTreeMap::<String, i128>::new();
    let mut changed_entities = Vec::new();
    for id in &intent.entity_ids {
        let index = *state
            .entity_index
            .get(id)
            .ok_or_else(|| anyhow!("native factory batch upgrade entity is missing"))?;
        let entity = state.parse_entity(index)?;
        if entity.get("planetId").and_then(Value::as_str) != Some(active_planet)
            || entity.get("interactionLocked").and_then(Value::as_bool) == Some(true)
            || entity.get("kind").and_then(Value::as_str) == Some("vein")
        {
            continue;
        }
        let source_id = entity
            .get("buildingId")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow!("native factory batch upgrade building ID is invalid"))?;
        let Some(target_id) = building_upgrade_target(state, source_id) else {
            continue;
        };
        let target = state
            .catalog
            .buildings
            .get(&target_id)
            .ok_or_else(|| anyhow!("native factory batch upgrade target is unknown"))?;
        let construction = state
            .catalog
            .constructions
            .get(&target_id)
            .ok_or_else(|| anyhow!("native factory batch upgrade construction is missing"))?;
        if construction
            .required_tech_id
            .as_deref()
            .is_some_and(|technology_id| !completed_technology(state, technology_id))
        {
            continue;
        }
        let source = state
            .catalog
            .buildings
            .get(source_id)
            .ok_or_else(|| anyhow!("native factory batch upgrade source is unknown"))?;
        if source.kind != target.kind || source.family != target.family {
            bail!("native factory batch upgrade family is incompatible")
        }
        let count = safe_integer(entity.get("machineCount"), "upgrade machine count")?;
        if count == 0 {
            continue;
        }
        add_delta(&mut deltas, &target_id, -i128::from(count))?;
        add_delta(&mut deltas, source_id, i128::from(count))?;
        changed_entities.push(entity_change(
            id.clone(),
            "buildingId",
            Value::from(target_id),
        ));
    }
    if changed_entities.is_empty() {
        bail!("native factory batch building upgrade has no eligible rows")
    }
    changed_entities.sort_by(|left, right| left.id.cmp(&right.id));
    Ok(SimulationCommandPatch {
        protocol_version: command_protocol(state),
        base_revision: state.revision,
        top_level_changes: construction_patches(state, deltas)?,
        changed_entities,
        added_entities: Vec::new(),
        removed_entity_ids: Vec::new(),
        changed_belts: Vec::new(),
        added_belts: Vec::new(),
        removed_belt_ids: Vec::new(),
    })
}

fn expand_upgrade_belts(
    state: &CoreState,
    intent: &BatchIntent,
) -> anyhow::Result<SimulationCommandPatch> {
    let active_planet = active_planet_id(state)?;
    let mut tiers = state
        .catalog
        .belt_speeds
        .keys()
        .copied()
        .collect::<Vec<_>>();
    tiers.sort_unstable();
    let mut deltas = BTreeMap::<String, i128>::new();
    let mut changed_belts = Vec::new();
    for id in &intent.belt_ids {
        let index = *state
            .belt_index
            .get(id)
            .ok_or_else(|| anyhow!("native factory batch upgrade belt is missing"))?;
        let belt = state.parse_belt(index)?;
        if belt.get("planetId").and_then(Value::as_str) != Some(active_planet) {
            continue;
        }
        let source_tier = u8::try_from(safe_integer(belt.get("tier"), "belt tier")?)?;
        let Some(target_tier) = tiers.iter().copied().find(|tier| *tier > source_tier) else {
            continue;
        };
        let source_construction = belt_construction_id(state, source_tier)
            .ok_or_else(|| anyhow!("native factory batch source belt construction is unknown"))?;
        let target_construction = belt_construction_id(state, target_tier)
            .ok_or_else(|| anyhow!("native factory batch target belt construction is unknown"))?;
        if state
            .catalog
            .constructions
            .get(&target_construction)
            .and_then(|construction| construction.required_tech_id.as_deref())
            .is_some_and(|technology_id| !completed_technology(state, technology_id))
        {
            continue;
        }
        let lanes = safe_integer(belt.get("lanes"), "belt lanes")?;
        if lanes == 0 {
            bail!("native factory batch belt lanes are empty")
        }
        add_delta(&mut deltas, &target_construction, -i128::from(lanes))?;
        add_delta(&mut deltas, &source_construction, i128::from(lanes))?;
        changed_belts.push(belt_change(
            id.clone(),
            vec![
                ValuePatch {
                    path: vec![PathSegment::Key("tier".to_owned())],
                    operation: "set".to_owned(),
                    value: Some(Value::from(target_tier)),
                },
                ValuePatch {
                    path: vec![PathSegment::Key("sorterTier".to_owned())],
                    operation: "set".to_owned(),
                    value: Some(Value::from(target_tier.min(3))),
                },
            ],
        ));
    }
    if changed_belts.is_empty() {
        bail!("native factory batch belt upgrade has no eligible rows")
    }
    changed_belts.sort_by(|left, right| left.id.cmp(&right.id));
    Ok(SimulationCommandPatch {
        protocol_version: command_protocol(state),
        base_revision: state.revision,
        top_level_changes: construction_patches(state, deltas)?,
        changed_entities: Vec::new(),
        added_entities: Vec::new(),
        removed_entity_ids: Vec::new(),
        changed_belts,
        added_belts: Vec::new(),
        removed_belt_ids: Vec::new(),
    })
}

pub(crate) fn expand_intent(
    state: &CoreState,
    command: &SimulationCommandPatch,
) -> anyhow::Result<SimulationCommandPatch> {
    if command.protocol_version != crate::CORE_PROTOCOL_VERSION {
        bail!("native player-authority factory batch protocol is unsupported")
    }
    if command.base_revision != state.revision {
        bail!("native player-authority factory batch revision is stale")
    }
    let intent = require_intent(command)?;
    match intent.kind {
        BatchKind::Increase => expand_increase(state, &intent),
        BatchKind::Remove => expand_remove(state, &intent),
        BatchKind::UpgradeBuildings => expand_upgrade_buildings(state, &intent),
        BatchKind::UpgradeBelts => expand_upgrade_belts(state, &intent),
    }
}

pub(crate) fn validate_command(
    state: &CoreState,
    command: &SimulationCommandPatch,
) -> anyhow::Result<()> {
    expand_intent(state, command).map(|_| ())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::{CoreCheckpointIdentity, catalog::RuntimeCatalog};

    const REGISTRY: &str = "factory-batch-test";

    fn catalog() -> RuntimeCatalog {
        RuntimeCatalog::from_value(
            json!({
                "protocolVersion": crate::CORE_PROTOCOL_VERSION,
                "registryFingerprint": REGISTRY,
                "planets": [{
                    "id": "home", "name": "Home", "systemId": "helios",
                    "kind": "terrestrial", "orbitIndex": 1
                }],
                "items": [{ "id": "iron_ore", "name": "Iron", "kind": "solid" }],
                "buildings": [
                    {
                        "id": "mod_assembler_1", "name": "Mod Assembler I",
                        "kind": "machine", "speed": 1, "inputCapacity": 100,
                        "outputCapacity": 100, "family": "assembler",
                        "stackLimit": 1000, "stackLimitComplete": true,
                        "upgradeTargetId": "mod_assembler_2", "layoutWidth": 360,
                        "layoutHeight": 240, "layoutClearance": 30,
                        "ports": [
                            { "index": 0, "direction": "input", "accepts": "solid", "maxConnections": 2 },
                            { "index": 0, "direction": "output", "accepts": "solid", "maxConnections": 2 }
                        ],
                        "capabilities": ["ordinary_production"]
                    },
                    {
                        "id": "mod_assembler_2", "name": "Mod Assembler II",
                        "kind": "machine", "speed": 2, "inputCapacity": 100,
                        "outputCapacity": 100, "family": "assembler",
                        "stackLimit": 1000, "stackLimitComplete": true
                    }
                ],
                "recipes": [],
                "constructions": [
                    { "id": "mod_assembler_1", "outputAmount": 1, "costs": [{ "itemId": "iron_ore", "amount": 1 }] },
                    { "id": "mod_assembler_2", "outputAmount": 1, "costs": [{ "itemId": "iron_ore", "amount": 2 }] },
                    { "id": "conveyor_belt_mk1", "outputAmount": 1, "costs": [{ "itemId": "iron_ore", "amount": 1 }] },
                    { "id": "mod_belt_mk4", "outputAmount": 1, "costs": [{ "itemId": "iron_ore", "amount": 2 }] }
                ],
                "belts": [
                    { "tier": 1, "speed": 6, "id": "conveyor_belt_mk1", "constructionId": "conveyor_belt_mk1" },
                    { "tier": 4, "speed": 60, "id": "mod_belt_mk4", "constructionId": "mod_belt_mk4" }
                ],
                "technologies": []
            }),
            REGISTRY,
        )
        .unwrap()
    }

    fn machine(id: &str, building_id: &str, count: u64, x: f64) -> String {
        serde_json::to_string(&json!({
            "id": id,
            "kind": "machine",
            "planetId": "home",
            "buildingId": building_id,
            "machineCount": count,
            "interactionLocked": false,
            "inputs": {},
            "outputs": {},
            "progress": 0,
            "utilization": 0,
            "productionRate": 0,
            "position": { "x": x, "y": 0 }
        }))
        .unwrap()
    }

    fn belt(id: &str, source: &str, target: &str, tier: u8, lanes: u64) -> String {
        serde_json::to_string(&json!({
            "id": id,
            "planetId": "home",
            "source": source,
            "target": target,
            "itemId": "iron_ore",
            "tier": tier,
            "sorterTier": tier.min(3),
            "lanes": lanes,
            "progress": 0,
            "priority": 1,
            "stackSize": 1,
            "monitorEnabled": false,
            "totalTransferred": 0,
            "congestion": 0,
            "lastFlow": 0,
            "routeMode": "auto"
        }))
        .unwrap()
    }

    fn state() -> CoreState {
        let base = json!({
            "version": 47,
            "mode": "normal",
            "activePlanetId": "home",
            "elapsedSeconds": 10,
            "paused": false,
            "nextId": 20,
            "construction": {
                "mod_assembler_1": 100,
                "mod_assembler_2": 100,
                "conveyor_belt_mk1": 100,
                "mod_belt_mk4": 100
            },
            "research": { "completedTechIds": [] },
            "settings": { "simulationSpeed": 1 },
            "exploration": { "colonizedPlanetIds": ["home"], "unlockedSystemIds": ["helios"] },
            "constructionQueue": [],
            "blueprintVersions": []
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
            vec![
                machine("machine-a", "mod_assembler_1", 5, 0.0),
                machine("machine-b", "mod_assembler_1", 7, 400.0),
            ],
            vec![belt("belt-a", "machine-a", "machine-b", 1, 3)],
            catalog(),
        )
        .unwrap()
    }

    fn marker(
        kind: &str,
        entity_ids: &[&str],
        belt_ids: &[&str],
        amount: Option<u64>,
    ) -> SimulationCommandPatch {
        let mut value = json!({
            "kind": kind,
            "entityIds": entity_ids,
            "beltIds": belt_ids
        });
        if let Some(amount) = amount {
            value["amount"] = Value::from(amount);
        }
        serde_json::from_value(json!({
            "protocolVersion": crate::CORE_PROTOCOL_VERSION,
            "baseRevision": 7,
            "topLevelChanges": [{ "path": ["factoryBatch", "intent"], "operation": "set", "value": value }],
            "changedEntities": [], "addedEntities": [], "removedEntityIds": [],
            "changedBelts": [], "addedBelts": [], "removedBeltIds": []
        }))
        .unwrap()
    }

    #[test]
    fn data_defined_buildings_and_registered_belts_increase_atomically() {
        let mut state = state();
        let receipt = state
            .apply_player_authority_command(&marker(
                "increase",
                &["machine-a", "machine-b"],
                &["belt-a"],
                Some(10),
            ))
            .unwrap();
        assert_eq!(receipt.previous_revision, 7);
        assert_eq!(receipt.revision, 8);
        assert!(receipt.topology_dirty);
        assert_eq!(state.parse_entity(0).unwrap()["machineCount"], 15);
        assert_eq!(state.parse_entity(1).unwrap()["machineCount"], 17);
        assert_eq!(state.parse_belt(0).unwrap()["lanes"], 13);
        assert_eq!(state.base_value()["construction"]["mod_assembler_1"], 80);
        assert_eq!(state.base_value()["construction"]["conveyor_belt_mk1"], 90);
    }

    #[test]
    fn aggregate_shortage_and_stale_revision_leave_source_hash_unchanged() {
        let mut state = state();
        state.base_value_mut()["construction"]["mod_assembler_1"] = Value::from(15);
        let before = state.canonical_sha256().unwrap();
        assert!(
            state
                .apply_player_authority_command(&marker(
                    "increase",
                    &["machine-a", "machine-b"],
                    &[],
                    Some(10),
                ))
                .is_err()
        );
        assert_eq!(state.revision, 7);
        assert_eq!(state.canonical_sha256().unwrap(), before);

        let mut stale = marker("increase", &["machine-a"], &[], Some(1));
        stale.base_revision = 6;
        assert!(state.apply_player_authority_command(&stale).is_err());
        assert_eq!(state.canonical_sha256().unwrap(), before);
    }

    #[test]
    fn upgrades_and_incident_removal_are_derived_from_current_catalog_and_topology() {
        let mut upgraded = state();
        upgraded
            .apply_player_authority_command(&marker(
                "upgrade-buildings",
                &["machine-a", "machine-b"],
                &[],
                None,
            ))
            .unwrap();
        assert_eq!(
            upgraded.parse_entity(0).unwrap()["buildingId"],
            "mod_assembler_2"
        );
        assert_eq!(
            upgraded.base_value()["construction"]["mod_assembler_1"],
            112
        );
        assert_eq!(upgraded.base_value()["construction"]["mod_assembler_2"], 88);

        let mut belts = state();
        belts
            .apply_player_authority_command(&marker("upgrade-belts", &[], &["belt-a"], None))
            .unwrap();
        assert_eq!(belts.parse_belt(0).unwrap()["tier"], 4);
        assert_eq!(belts.base_value()["construction"]["conveyor_belt_mk1"], 103);
        assert_eq!(belts.base_value()["construction"]["mod_belt_mk4"], 97);

        let mut removed = state();
        removed
            .apply_player_authority_command(&marker("remove", &["machine-a"], &[], None))
            .unwrap();
        assert!(!removed.entity_index.contains_key("machine-a"));
        assert!(removed.belt_index.is_empty());
        assert_eq!(removed.base_value()["construction"]["mod_assembler_1"], 105);
        assert_eq!(
            removed.base_value()["construction"]["conveyor_belt_mk1"],
            103
        );
    }

    #[test]
    fn compact_marker_replay_is_deterministic_and_never_contains_material_values() {
        let command = marker(
            "increase",
            &["machine-b", "machine-a"],
            &["belt-a"],
            Some(2),
        );
        let durable = serde_json::to_string(&command).unwrap();
        assert!(!durable.contains("construction"));
        let replayed: SimulationCommandPatch = serde_json::from_str(&durable).unwrap();
        let mut left = state();
        let mut right = state();
        left.apply_player_authority_command(&command).unwrap();
        right.apply_command(&replayed).unwrap();
        assert_eq!(
            left.canonical_sha256().unwrap(),
            right.canonical_sha256().unwrap()
        );
        assert_eq!(left.revision, right.revision);
    }
}
