//! Minimal durable construction-queue cancellation intent.
//!
//! The renderer sends only `{ kind: "cancel", id, revision }`. Rust validates
//! the current public-v47 queue, computes every construction/fleet refund from
//! the authoritative row, removes that one row, and prunes now-unreferenced
//! immutable blueprint versions. Derived refunds and array indexes remain
//! Core-private and never enter the WAL marker.

use std::collections::HashSet;

use anyhow::{anyhow, bail};
use serde_json::{Map, Value};

use crate::{
    command::{PathSegment, SimulationCommandPatch},
    state::CoreState,
};

const MAX_SOURCE_ROWS: usize = 4_096;
const MAX_REFUND_ROWS: usize = 4_096;
const MAX_OPAQUE_ID_BYTES: usize = 512;
const MAX_JAVASCRIPT_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Debug, Clone, PartialEq, Eq)]
struct Refund {
    id: String,
    amount_after: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ConstructionQueueCancelPlan {
    id: String,
    index: usize,
    construction_refunds: Vec<Refund>,
    fleet_refunds: Vec<Refund>,
    retained_version_ids: HashSet<String>,
}

pub(crate) struct ConstructionQueueCancelExpansion {
    command: SimulationCommandPatch,
    plan: ConstructionQueueCancelPlan,
}

impl ConstructionQueueCancelExpansion {
    pub(crate) fn command(&self) -> &SimulationCommandPatch {
        &self.command
    }

    pub(crate) fn apply_to_base(&self, base: &mut Map<String, Value>) -> anyhow::Result<()> {
        apply_refunds(
            base.get_mut("construction")
                .and_then(Value::as_object_mut)
                .ok_or_else(|| {
                    anyhow!("native construction queue construction inventory is invalid")
                })?,
            &self.plan.construction_refunds,
        );
        apply_refunds(
            base.get_mut("portableFleet")
                .and_then(Value::as_object_mut)
                .ok_or_else(|| anyhow!("native construction queue portable fleet is invalid"))?,
            &self.plan.fleet_refunds,
        );

        let queue = base
            .get_mut("constructionQueue")
            .and_then(Value::as_array_mut)
            .ok_or_else(|| anyhow!("native construction queue directory is invalid"))?;
        let current_id = queue
            .get(self.plan.index)
            .and_then(Value::as_object)
            .and_then(|row| row.get("id"))
            .and_then(Value::as_str);
        if current_id != Some(self.plan.id.as_str()) {
            bail!("native construction queue cancel index is no longer current")
        }
        queue.remove(self.plan.index);

        let versions = base
            .get_mut("blueprintVersions")
            .and_then(Value::as_array_mut)
            .ok_or_else(|| anyhow!("native construction queue blueprint versions are invalid"))?;
        versions.retain(|value| {
            value
                .as_object()
                .and_then(|row| row.get("id"))
                .and_then(Value::as_str)
                .is_some_and(|id| self.plan.retained_version_ids.contains(id))
        });
        Ok(())
    }
}

fn apply_refunds(inventory: &mut Map<String, Value>, refunds: &[Refund]) {
    for refund in refunds {
        inventory.insert(refund.id.clone(), Value::from(refund.amount_after));
    }
}

fn path_matches(path: &[PathSegment]) -> bool {
    matches!(
        path,
        [PathSegment::Key(root), PathSegment::Key(leaf)]
            if root == "constructionQueue" && leaf == "intent"
    )
}

pub(crate) fn command_contains_intent(command: &SimulationCommandPatch) -> bool {
    command
        .top_level_changes
        .iter()
        .any(|change| path_matches(&change.path))
}

fn valid_opaque_text(value: &str) -> bool {
    !value.is_empty() && value.len() <= MAX_OPAQUE_ID_BYTES && !value.chars().any(char::is_control)
}

fn require_intent(command: &SimulationCommandPatch) -> anyhow::Result<String> {
    if command.top_level_changes.len() != 1
        || !command.changed_entities.is_empty()
        || !command.added_entities.is_empty()
        || !command.removed_entity_ids.is_empty()
        || !command.changed_belts.is_empty()
        || !command.added_belts.is_empty()
        || !command.removed_belt_ids.is_empty()
    {
        bail!("native construction queue cancel intent shape is invalid")
    }
    let change = &command.top_level_changes[0];
    if !path_matches(&change.path) || change.operation != "set" {
        bail!("native construction queue cancel intent path is invalid")
    }
    let intent = change
        .value
        .as_ref()
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("native construction queue cancel intent is invalid"))?;
    if intent.len() != 3
        || intent.get("kind").and_then(Value::as_str) != Some("cancel")
        || intent.get("revision").and_then(Value::as_u64) != Some(command.base_revision)
        || command.base_revision > MAX_JAVASCRIPT_SAFE_INTEGER
    {
        bail!("native construction queue cancel intent identity is invalid")
    }
    intent
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| valid_opaque_text(id))
        .map(str::to_owned)
        .ok_or_else(|| anyhow!("native construction queue cancel ID is invalid"))
}

fn safe_inventory_amount(value: Option<&Value>, label: &str) -> anyhow::Result<u64> {
    let Some(value) = value else {
        return Ok(0);
    };
    if value.is_null() {
        return Ok(0);
    }
    let amount = value
        .as_f64()
        .filter(|amount| amount.is_finite())
        .map(|amount| amount.floor().max(0.0))
        .filter(|amount| *amount <= MAX_JAVASCRIPT_SAFE_INTEGER as f64)
        .ok_or_else(|| anyhow!("native construction queue {label} is invalid"))?;
    Ok(amount as u64)
}

fn validate_inventory<'a>(
    base: &'a Map<String, Value>,
    key: &str,
    label: &str,
) -> anyhow::Result<&'a Map<String, Value>> {
    let inventory = base
        .get(key)
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("native construction queue {label} is invalid"))?;
    for (id, amount) in inventory {
        if !valid_opaque_text(id) {
            bail!("native construction queue {label} ID is invalid")
        }
        safe_inventory_amount(Some(amount), label)?;
    }
    Ok(inventory)
}

fn derive_refunds(
    reserved: Option<&Value>,
    inventory: &Map<String, Value>,
    label: &str,
) -> anyhow::Result<Vec<Refund>> {
    let Some(reserved) = reserved else {
        return Ok(Vec::new());
    };
    if reserved.is_null() {
        return Ok(Vec::new());
    }
    let reserved = reserved
        .as_object()
        .ok_or_else(|| anyhow!("native construction queue reserved {label} is invalid"))?;
    if reserved.len() > MAX_REFUND_ROWS {
        bail!("native construction queue reserved {label} source limit is exceeded")
    }
    let mut refunds = Vec::with_capacity(reserved.len());
    for (id, amount) in reserved {
        if !valid_opaque_text(id) {
            bail!("native construction queue reserved {label} ID is invalid")
        }
        let current = safe_inventory_amount(inventory.get(id), label)?;
        let amount = safe_inventory_amount(Some(amount), label)?;
        let amount_after = current
            .checked_add(amount)
            .filter(|value| *value <= MAX_JAVASCRIPT_SAFE_INTEGER)
            .ok_or_else(|| anyhow!("native construction queue {label} refund overflows"))?;
        refunds.push(Refund {
            id: id.clone(),
            amount_after,
        });
    }
    Ok(refunds)
}

fn validate_version_ids(base: &Map<String, Value>) -> anyhow::Result<()> {
    let versions = base
        .get("blueprintVersions")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("native construction queue blueprint versions are invalid"))?;
    if versions.len() > MAX_SOURCE_ROWS {
        bail!("native construction queue blueprint version source limit is exceeded")
    }
    let mut ids = HashSet::with_capacity(versions.len());
    for value in versions {
        let id = value
            .as_object()
            .and_then(|row| row.get("id"))
            .and_then(Value::as_str)
            .filter(|id| valid_opaque_text(id))
            .ok_or_else(|| anyhow!("native construction queue blueprint version ID is invalid"))?;
        if !ids.insert(id) {
            bail!("native construction queue blueprint version IDs are not unique")
        }
    }
    Ok(())
}

fn validated_plan(
    state: &CoreState,
    command: &SimulationCommandPatch,
) -> anyhow::Result<ConstructionQueueCancelPlan> {
    let target_id = require_intent(command)?;
    let base = state.base_value();
    let construction = validate_inventory(base, "construction", "construction inventory")?;
    let fleet = validate_inventory(base, "portableFleet", "portable fleet")?;
    validate_version_ids(base)?;

    let queue = base
        .get("constructionQueue")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("native construction queue directory is invalid"))?;
    if queue.len() > MAX_SOURCE_ROWS {
        bail!("native construction queue source limit is exceeded")
    }
    let mut ids = HashSet::with_capacity(queue.len());
    let mut target = None;
    let mut retained_version_ids = HashSet::new();
    for (index, value) in queue.iter().enumerate() {
        let row = value
            .as_object()
            .ok_or_else(|| anyhow!("native construction queue row is invalid"))?;
        let id = row
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| valid_opaque_text(id))
            .ok_or_else(|| anyhow!("native construction queue row ID is invalid"))?;
        if !ids.insert(id) {
            bail!("native construction queue IDs are not unique")
        }
        let version_id = match row.get("blueprintVersionId") {
            None | Some(Value::Null) => None,
            Some(Value::String(id)) if valid_opaque_text(id) => Some(id.as_str()),
            _ => bail!("native construction queue blueprint version reference is invalid"),
        };
        if id == target_id {
            target = Some((
                index,
                derive_refunds(
                    row.get("reservedConstruction"),
                    construction,
                    "construction",
                )?,
                derive_refunds(row.get("reservedFleet"), fleet, "fleet")?,
            ));
        } else if let Some(version_id) = version_id {
            retained_version_ids.insert(version_id.to_owned());
        }
    }
    let (index, construction_refunds, fleet_refunds) =
        target.ok_or_else(|| anyhow!("native construction queue cancel target is missing"))?;
    Ok(ConstructionQueueCancelPlan {
        id: target_id,
        index,
        construction_refunds,
        fleet_refunds,
        retained_version_ids,
    })
}

pub(crate) fn validate_command(
    state: &CoreState,
    command: &SimulationCommandPatch,
) -> anyhow::Result<()> {
    validated_plan(state, command).map(|_| ())
}

pub(crate) fn validate_resume_marker(command: &SimulationCommandPatch) -> anyhow::Result<()> {
    require_intent(command).map(|_| ())
}

pub(crate) fn expand_intent(
    state: &CoreState,
    command: &SimulationCommandPatch,
) -> anyhow::Result<ConstructionQueueCancelExpansion> {
    let plan = validated_plan(state, command)?;
    Ok(ConstructionQueueCancelExpansion {
        command: SimulationCommandPatch {
            protocol_version: command.protocol_version,
            base_revision: command.base_revision,
            top_level_changes: Vec::new(),
            changed_entities: Vec::new(),
            added_entities: Vec::new(),
            removed_entity_ids: Vec::new(),
            changed_belts: Vec::new(),
            added_belts: Vec::new(),
            removed_belt_ids: Vec::new(),
        },
        plan,
    })
}
