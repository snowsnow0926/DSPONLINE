//! Minimal durable construction-queue intents.
//!
//! Cancellation retains its established semantic marker. Queue-only blueprint
//! admission adds the exact marker
//! `{ kind: "enqueue", blueprintId, blueprintRevision, position, revision }`.
//! Rust re-derives every persisted queue/version field from the authoritative
//! public-v47 base; neither a blueprint body nor an allocator/queue ID enters
//! the WAL.

use std::collections::{HashMap, HashSet};

use anyhow::{anyhow, bail};
use serde_json::{Map, Value, json};

use crate::{
    blueprint_workspace::{
        queue_only_definition_supported, queue_only_definition_supported_on_planet,
        validate_blueprint_directory, validate_queue_directory, validate_version_directory,
    },
    command::{
        AddedRecord, EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT, PathSegment, SimulationCommandPatch,
    },
    state::CoreState,
};

const BLUEPRINT_ENQUEUE_CONTEXT_PROJECTION: &str = "blueprint-enqueue-context-v1";
const MAX_PROJECTION_BYTES: usize = 1_048_576;
const MAX_SOURCE_ROWS: usize = 4_096;
const MAX_QUEUE_ORDERS: usize = 100;
const MAX_REFUND_ROWS: usize = 4_096;
const MAX_OPAQUE_ID_BYTES: usize = 512;
const MAX_NAME_BYTES: usize = 256;
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

#[derive(Debug, Clone)]
struct EnqueueIntent {
    blueprint_id: String,
    blueprint_revision: u64,
    position: Value,
    x: f64,
    y: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FundScope {
    Construction,
    Fleet,
    All,
}

#[derive(Debug, Clone)]
struct FundIntent {
    id: String,
    scope: FundScope,
}

#[derive(Debug, Clone)]
enum ConstructionQueueIntent {
    Cancel(String),
    Enqueue(EnqueueIntent),
    Fund(FundIntent),
    Deploy(String),
}

#[derive(Debug, Clone)]
struct PreparedEnqueue {
    expected_queue_id: String,
    next_id: u64,
    queue_len: usize,
    version_len: usize,
    version_container_missing: bool,
    version_id: String,
    version_to_append: Option<Value>,
    blueprint: Value,
    blueprint_id: String,
    blueprint_revision: u64,
    blueprint_name: String,
    active_planet_id: String,
    rotation: u64,
    mirror: String,
    queued_at: Value,
}

#[derive(Debug, Clone)]
struct ConstructionQueueEnqueuePlan {
    expected_queue_id: String,
    next_id: u64,
    queue_len: usize,
    version_len: usize,
    version_container_missing: bool,
    version_id: String,
    version_to_append: Option<Value>,
    queue_row: Value,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct InventoryUpdate {
    id: String,
    amount_after: u64,
}

#[derive(Debug, Clone)]
struct ConstructionQueueFundPlan {
    id: String,
    index: usize,
    construction_updates: Vec<InventoryUpdate>,
    fleet_updates: Vec<InventoryUpdate>,
    reserved_construction: Option<Map<String, Value>>,
    reserved_fleet: Option<Map<String, Value>>,
}

#[derive(Debug, Clone)]
struct ConstructionQueueDeployPlan {
    id: String,
    index: usize,
    next_id: u64,
    next_id_after: u64,
    retained_version_ids: HashSet<String>,
    added_entities: Vec<AddedRecord>,
    added_belts: Vec<AddedRecord>,
}

#[derive(Debug, Clone)]
enum ConstructionQueuePlan {
    Cancel(ConstructionQueueCancelPlan),
    Enqueue(ConstructionQueueEnqueuePlan),
    Fund(ConstructionQueueFundPlan),
    Deploy(Box<ConstructionQueueDeployPlan>),
}

enum EnqueuePreparation {
    Supported(Box<PreparedEnqueue>),
    Unsupported(&'static str),
}

pub(crate) struct ConstructionQueueExpansion {
    command: SimulationCommandPatch,
    plan: ConstructionQueuePlan,
}

impl ConstructionQueueExpansion {
    pub(crate) fn command(&self) -> &SimulationCommandPatch {
        &self.command
    }

    pub(crate) fn apply_to_base(&self, base: &mut Map<String, Value>) -> anyhow::Result<()> {
        match &self.plan {
            ConstructionQueuePlan::Cancel(plan) => apply_cancel_plan(base, plan),
            ConstructionQueuePlan::Enqueue(plan) => apply_enqueue_plan(base, plan),
            ConstructionQueuePlan::Fund(plan) => apply_fund_plan(base, plan),
            ConstructionQueuePlan::Deploy(plan) => apply_deploy_plan(base, plan),
        }
    }

    pub(crate) fn is_deploy(&self) -> bool {
        matches!(self.plan, ConstructionQueuePlan::Deploy(_))
    }
}

fn apply_deploy_plan(
    base: &mut Map<String, Value>,
    plan: &ConstructionQueueDeployPlan,
) -> anyhow::Result<()> {
    if safe_integer(base.get("nextId"), "next ID")? != plan.next_id {
        bail!("native construction queue deploy allocator is no longer current")
    }
    let queue = base
        .get_mut("constructionQueue")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| anyhow!("native construction queue directory is invalid"))?;
    let row = queue
        .get(plan.index)
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("native construction queue deploy row is invalid"))?;
    if row.get("id").and_then(Value::as_str) != Some(plan.id.as_str())
        || queue_status(row)? != "pending-materials"
    {
        bail!("native construction queue deploy target is no longer current")
    }
    queue.remove(plan.index);

    match base.get_mut("blueprintVersions") {
        None | Some(Value::Null) if plan.retained_version_ids.is_empty() => {}
        Some(Value::Array(versions)) => versions.retain(|value| {
            value
                .get("id")
                .and_then(Value::as_str)
                .is_some_and(|id| plan.retained_version_ids.contains(id))
        }),
        _ => bail!("native construction queue blueprint versions are invalid"),
    }
    base.insert("nextId".to_owned(), Value::from(plan.next_id_after));
    Ok(())
}

fn apply_fund_plan(
    base: &mut Map<String, Value>,
    plan: &ConstructionQueueFundPlan,
) -> anyhow::Result<()> {
    let construction = base
        .get_mut("construction")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| anyhow!("native construction queue construction inventory is invalid"))?;
    for update in &plan.construction_updates {
        construction.insert(update.id.clone(), Value::from(update.amount_after));
    }
    let fleet = base
        .get_mut("portableFleet")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| anyhow!("native construction queue portable fleet is invalid"))?;
    for update in &plan.fleet_updates {
        fleet.insert(update.id.clone(), Value::from(update.amount_after));
    }

    let queue = base
        .get_mut("constructionQueue")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| anyhow!("native construction queue directory is invalid"))?;
    let row = queue
        .get_mut(plan.index)
        .and_then(Value::as_object_mut)
        .ok_or_else(|| anyhow!("native construction queue fund row is invalid"))?;
    if row.get("id").and_then(Value::as_str) != Some(plan.id.as_str())
        || queue_status(row)? != "pending-materials"
    {
        bail!("native construction queue fund target is no longer current")
    }
    if let Some(reserved) = &plan.reserved_construction {
        row.insert(
            "reservedConstruction".to_owned(),
            Value::Object(reserved.clone()),
        );
    }
    if let Some(reserved) = &plan.reserved_fleet {
        row.insert("reservedFleet".to_owned(), Value::Object(reserved.clone()));
    }
    Ok(())
}

fn apply_cancel_plan(
    base: &mut Map<String, Value>,
    plan: &ConstructionQueueCancelPlan,
) -> anyhow::Result<()> {
    apply_refunds(
        base.get_mut("construction")
            .and_then(Value::as_object_mut)
            .ok_or_else(|| {
                anyhow!("native construction queue construction inventory is invalid")
            })?,
        &plan.construction_refunds,
    );
    apply_refunds(
        base.get_mut("portableFleet")
            .and_then(Value::as_object_mut)
            .ok_or_else(|| anyhow!("native construction queue portable fleet is invalid"))?,
        &plan.fleet_refunds,
    );

    let queue = base
        .get_mut("constructionQueue")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| anyhow!("native construction queue directory is invalid"))?;
    let current_id = queue
        .get(plan.index)
        .and_then(Value::as_object)
        .and_then(|row| row.get("id"))
        .and_then(Value::as_str);
    if current_id != Some(plan.id.as_str()) {
        bail!("native construction queue cancel index is no longer current")
    }
    queue.remove(plan.index);

    let versions = base
        .get_mut("blueprintVersions")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| anyhow!("native construction queue blueprint versions are invalid"))?;
    versions.retain(|value| {
        value
            .as_object()
            .and_then(|row| row.get("id"))
            .and_then(Value::as_str)
            .is_some_and(|id| plan.retained_version_ids.contains(id))
    });
    Ok(())
}

fn apply_enqueue_plan(
    base: &mut Map<String, Value>,
    plan: &ConstructionQueueEnqueuePlan,
) -> anyhow::Result<()> {
    let current_next_id = safe_integer(base.get("nextId"), "next ID")?;
    if current_next_id != plan.next_id {
        bail!("native construction queue allocator is no longer current")
    }

    if plan.version_container_missing {
        match base.get("blueprintVersions") {
            None | Some(Value::Null) => {
                base.insert("blueprintVersions".to_owned(), Value::Array(Vec::new()));
            }
            _ => bail!("native construction queue version directory is no longer current"),
        }
    }
    let versions = base
        .get_mut("blueprintVersions")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| anyhow!("native construction queue blueprint versions are invalid"))?;
    if versions.len() != plan.version_len {
        bail!("native construction queue version directory is no longer current")
    }
    if let Some(version) = &plan.version_to_append {
        if versions
            .iter()
            .any(|value| value.get("id").and_then(Value::as_str) == Some(plan.version_id.as_str()))
        {
            bail!("native construction queue version ID is no longer available")
        }
        versions.push(version.clone());
    }

    let queue = base
        .get_mut("constructionQueue")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| anyhow!("native construction queue directory is invalid"))?;
    if queue.len() != plan.queue_len
        || queue.iter().any(|value| {
            value.get("id").and_then(Value::as_str) == Some(plan.expected_queue_id.as_str())
        })
    {
        bail!("native construction queue append position is no longer current")
    }
    queue.push(plan.queue_row.clone());
    base.insert("nextId".to_owned(), Value::from(plan.next_id + 1));
    Ok(())
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

fn require_intent(command: &SimulationCommandPatch) -> anyhow::Result<ConstructionQueueIntent> {
    if command.top_level_changes.len() != 1
        || !command.changed_entities.is_empty()
        || !command.added_entities.is_empty()
        || !command.removed_entity_ids.is_empty()
        || !command.changed_belts.is_empty()
        || !command.added_belts.is_empty()
        || !command.removed_belt_ids.is_empty()
    {
        bail!("native construction queue intent shape is invalid")
    }
    let change = &command.top_level_changes[0];
    if !path_matches(&change.path) || change.operation != "set" {
        bail!("native construction queue intent path is invalid")
    }
    let intent = change
        .value
        .as_ref()
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("native construction queue intent is invalid"))?;
    if intent.get("revision").and_then(Value::as_u64) != Some(command.base_revision)
        || command.base_revision > MAX_JAVASCRIPT_SAFE_INTEGER
    {
        bail!("native construction queue intent identity is invalid")
    }
    match intent.get("kind").and_then(Value::as_str) {
        Some("cancel") => {
            if intent.len() != 3 {
                bail!("native construction queue cancel intent shape is invalid")
            }
            let id = intent
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| valid_opaque_text(id))
                .ok_or_else(|| anyhow!("native construction queue cancel ID is invalid"))?;
            Ok(ConstructionQueueIntent::Cancel(id.to_owned()))
        }
        Some("enqueue") => {
            if command.base_revision == MAX_JAVASCRIPT_SAFE_INTEGER {
                bail!("native construction queue enqueue revision is exhausted")
            }
            if intent.len() != 5 {
                bail!("native construction queue enqueue intent shape is invalid")
            }
            let blueprint_id = intent
                .get("blueprintId")
                .and_then(Value::as_str)
                .filter(|id| valid_opaque_text(id))
                .ok_or_else(|| anyhow!("native construction queue blueprint ID is invalid"))?;
            let blueprint_revision = intent
                .get("blueprintRevision")
                .and_then(Value::as_u64)
                .filter(|revision| *revision > 0 && *revision <= MAX_JAVASCRIPT_SAFE_INTEGER)
                .ok_or_else(|| {
                    anyhow!("native construction queue blueprint revision is invalid")
                })?;
            let position = intent
                .get("position")
                .and_then(Value::as_object)
                .filter(|position| {
                    position.len() == 2 && position.contains_key("x") && position.contains_key("y")
                })
                .ok_or_else(|| anyhow!("native construction queue position is invalid"))?;
            let x = finite_number(position.get("x"), "x position")?;
            let y = finite_number(position.get("y"), "y position")?;
            Ok(ConstructionQueueIntent::Enqueue(EnqueueIntent {
                blueprint_id: blueprint_id.to_owned(),
                blueprint_revision,
                position: intent
                    .get("position")
                    .expect("enqueue position was validated")
                    .clone(),
                x,
                y,
            }))
        }
        Some("fund") => {
            if command.base_revision == MAX_JAVASCRIPT_SAFE_INTEGER || intent.len() != 4 {
                bail!("native construction queue fund intent shape is invalid")
            }
            let id = intent
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| valid_opaque_text(id))
                .ok_or_else(|| anyhow!("native construction queue fund ID is invalid"))?;
            let scope = match intent.get("scope").and_then(Value::as_str) {
                Some("construction") => FundScope::Construction,
                Some("fleet") => FundScope::Fleet,
                Some("all") => FundScope::All,
                _ => bail!("native construction queue fund scope is invalid"),
            };
            Ok(ConstructionQueueIntent::Fund(FundIntent {
                id: id.to_owned(),
                scope,
            }))
        }
        Some("deploy") => {
            if command.base_revision == MAX_JAVASCRIPT_SAFE_INTEGER || intent.len() != 3 {
                bail!("native construction queue deploy intent shape is invalid")
            }
            let id = intent
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| valid_opaque_text(id))
                .ok_or_else(|| anyhow!("native construction queue deploy ID is invalid"))?;
            Ok(ConstructionQueueIntent::Deploy(id.to_owned()))
        }
        _ => bail!("native construction queue intent kind is invalid"),
    }
}

fn safe_integer(value: Option<&Value>, label: &str) -> anyhow::Result<u64> {
    value
        .and_then(Value::as_u64)
        .filter(|value| *value <= MAX_JAVASCRIPT_SAFE_INTEGER)
        .ok_or_else(|| anyhow!("native construction queue {label} is not a safe integer"))
}

fn positive_integer(value: Option<&Value>, label: &str) -> anyhow::Result<u64> {
    safe_integer(value, label).and_then(|value| {
        if value == 0 {
            bail!("native construction queue {label} is invalid")
        }
        Ok(value)
    })
}

fn finite_number(value: Option<&Value>, label: &str) -> anyhow::Result<f64> {
    value
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
        .ok_or_else(|| anyhow!("native construction queue {label} is invalid"))
}

fn blueprint_revision(row: &Map<String, Value>) -> anyhow::Result<u64> {
    match row.get("revision") {
        None | Some(Value::Null) => Ok(1),
        Some(value) => value
            .as_f64()
            .filter(|value| value.is_finite())
            .map(|value| value.floor().max(1.0))
            .filter(|value| *value <= MAX_JAVASCRIPT_SAFE_INTEGER as f64)
            .map(|value| value as u64)
            .ok_or_else(|| anyhow!("native construction queue blueprint revision is invalid")),
    }
}

fn blueprint_rotation(row: &Map<String, Value>) -> anyhow::Result<u64> {
    let rotation = match row.get("rotation") {
        None | Some(Value::Null) => 0,
        value => safe_integer(value, "blueprint rotation")?,
    };
    if !matches!(rotation, 0 | 90 | 180 | 270) {
        bail!("native construction queue blueprint rotation is invalid")
    }
    Ok(rotation)
}

fn blueprint_mirror(row: &Map<String, Value>) -> anyhow::Result<&str> {
    let mirror = match row.get("mirror") {
        None | Some(Value::Null) => "none",
        Some(Value::String(value)) => value.as_str(),
        _ => bail!("native construction queue blueprint mirror is invalid"),
    };
    if !matches!(mirror, "none" | "horizontal") {
        bail!("native construction queue blueprint mirror is invalid")
    }
    Ok(mirror)
}

fn blueprint_name<'a>(row: &'a Map<String, Value>, label: &str) -> anyhow::Result<&'a str> {
    row.get("name")
        .and_then(Value::as_str)
        .filter(|name| {
            !name.is_empty() && name.len() <= MAX_NAME_BYTES && !name.chars().any(char::is_control)
        })
        .ok_or_else(|| anyhow!("native construction queue {label} is invalid"))
}

fn active_planet_id(state: &CoreState) -> anyhow::Result<&str> {
    let planet_id = state
        .base_value()
        .get("activePlanetId")
        .and_then(Value::as_str)
        .filter(|id| valid_opaque_text(id))
        .ok_or_else(|| anyhow!("native construction queue active planet is invalid"))?;
    if !state
        .catalog
        .planets
        .iter()
        .any(|planet| planet.id == planet_id)
    {
        bail!("native construction queue active planet is not in the catalog")
    }
    Ok(planet_id)
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

fn validated_cancel_plan(
    state: &CoreState,
    target_id: String,
) -> anyhow::Result<ConstructionQueueCancelPlan> {
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

fn queue_status(row: &Map<String, Value>) -> anyhow::Result<&str> {
    match row.get("status") {
        None | Some(Value::Null) => Ok("pending-materials"),
        Some(Value::String(value))
            if matches!(value.as_str(), "pending-materials" | "waiting-fleet") =>
        {
            Ok(value)
        }
        _ => bail!("native construction queue status is invalid"),
    }
}

fn queue_position(row: &Map<String, Value>) -> anyhow::Result<(f64, f64)> {
    let position = row
        .get("position")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("native construction queue persisted position is invalid"))?;
    Ok((
        finite_number(position.get("x"), "persisted x position")?,
        finite_number(position.get("y"), "persisted y position")?,
    ))
}

fn definition_offsets(definition: &Map<String, Value>) -> anyhow::Result<Vec<(f64, f64)>> {
    let entities = definition
        .get("entities")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("native construction queue blueprint entities are invalid"))?;
    entities
        .iter()
        .map(|value| {
            let offset = value
                .as_object()
                .and_then(|entity| entity.get("offset"))
                .and_then(Value::as_object)
                .ok_or_else(|| anyhow!("native construction queue blueprint offset is invalid"))?;
            Ok((
                finite_number(offset.get("x"), "blueprint x offset")?,
                finite_number(offset.get("y"), "blueprint y offset")?,
            ))
        })
        .collect()
}

fn resolve_queue_definition<'a>(
    row: &Map<String, Value>,
    blueprints: &[&'a Map<String, Value>],
    blueprint_indices: &HashMap<String, usize>,
    versions: &[&'a Map<String, Value>],
    version_indices: &HashMap<String, usize>,
) -> anyhow::Result<&'a Map<String, Value>> {
    let blueprint_id = row
        .get("blueprintId")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("native construction queue blueprint reference is invalid"))?;
    let definition = match row.get("blueprintVersionId") {
        Some(Value::String(version_id)) => {
            let index = version_indices.get(version_id).ok_or_else(|| {
                anyhow!("native construction queue immutable version reference is missing")
            })?;
            let version = versions[*index];
            if version.get("blueprintId").and_then(Value::as_str) != Some(blueprint_id) {
                bail!("native construction queue immutable version owner is invalid")
            }
            version
                .get("definition")
                .and_then(Value::as_object)
                .ok_or_else(|| {
                    anyhow!("native construction queue immutable version definition is invalid")
                })?
        }
        None | Some(Value::Null) => {
            let index = blueprint_indices.get(blueprint_id).ok_or_else(|| {
                anyhow!("native construction queue live blueprint reference is missing")
            })?;
            blueprints[*index]
        }
        _ => bail!("native construction queue immutable version reference is invalid"),
    };
    if let Some(value) = row.get("blueprintRevision")
        && !value.is_null()
        && positive_integer(Some(value), "persisted blueprint revision")?
            != blueprint_revision(definition)?
    {
        bail!("native construction queue persisted blueprint revision is inconsistent")
    }
    Ok(definition)
}

fn prepare_enqueue(
    state: &CoreState,
    blueprint_id: &str,
    requested_revision: u64,
) -> anyhow::Result<EnqueuePreparation> {
    let base = state.base_value();
    let active_planet_id = active_planet_id(state)?.to_owned();
    let active_planet = state
        .catalog
        .planets
        .iter()
        .find(|planet| planet.id == active_planet_id)
        .expect("active planet membership was validated");
    if active_planet.kind != "terrestrial" {
        return Ok(EnqueuePreparation::Unsupported("unsupported-active-planet"));
    }
    if state.identity.registry_fingerprint != EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT
        || state.catalog.snapshot.registry_fingerprint != EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT
    {
        return Ok(EnqueuePreparation::Unsupported(
            "unsupported-blueprint-domain",
        ));
    }

    let blueprint_values = base
        .get("blueprints")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("native construction queue blueprint directory is invalid"))?;
    let empty_version_values = Vec::new();
    let (version_values, version_container_missing) = match base.get("blueprintVersions") {
        None | Some(Value::Null) => (&empty_version_values, true),
        Some(Value::Array(values)) => (values, false),
        _ => bail!("native construction queue version directory is invalid"),
    };
    let queue_values = base
        .get("constructionQueue")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("native construction queue directory is invalid"))?;
    let blueprints = validate_blueprint_directory(blueprint_values)?;
    let versions = validate_version_directory(version_values)?;
    let queue = validate_queue_directory(queue_values)?;

    let blueprint_indices = blueprints
        .iter()
        .enumerate()
        .map(|(index, row)| {
            (
                row.get("id")
                    .and_then(Value::as_str)
                    .expect("blueprint directory ID was validated")
                    .to_owned(),
                index,
            )
        })
        .collect::<HashMap<_, _>>();
    let version_indices = versions
        .iter()
        .enumerate()
        .map(|(index, row)| {
            (
                row.get("id")
                    .and_then(Value::as_str)
                    .expect("version directory ID was validated")
                    .to_owned(),
                index,
            )
        })
        .collect::<HashMap<_, _>>();

    for version in &versions {
        let owner_id = version
            .get("blueprintId")
            .and_then(Value::as_str)
            .expect("version owner was validated");
        let revision = positive_integer(version.get("revision"), "version revision")?;
        let definition = version
            .get("definition")
            .and_then(Value::as_object)
            .expect("version definition was validated");
        if definition.get("id").and_then(Value::as_str) != Some(owner_id)
            || blueprint_revision(definition)? != revision
        {
            bail!("native construction queue immutable version identity is invalid")
        }
    }
    let target_index = *blueprint_indices
        .get(blueprint_id)
        .ok_or_else(|| anyhow!("native construction queue blueprint selector is missing"))?;
    let target = blueprints[target_index];
    let target_revision = blueprint_revision(target)?;
    if target_revision != requested_revision {
        bail!("native construction queue blueprint selector is stale")
    }
    if !queue_only_definition_supported(state, target)? {
        return Ok(EnqueuePreparation::Unsupported(
            "unsupported-blueprint-domain",
        ));
    }

    for row in &queue {
        let planet_id = row
            .get("planetId")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow!("native construction queue persisted planet is invalid"))?;
        if !state
            .catalog
            .planets
            .iter()
            .any(|planet| planet.id == planet_id)
        {
            bail!("native construction queue persisted planet is not in the catalog")
        }
        let definition = resolve_queue_definition(
            row,
            &blueprints,
            &blueprint_indices,
            &versions,
            &version_indices,
        )?;
        if planet_id == active_planet_id
            && queue_status(row)? == "pending-materials"
            && !queue_only_definition_supported(state, definition)?
        {
            return Ok(EnqueuePreparation::Unsupported(
                "unsupported-existing-queue-domain",
            ));
        }
    }

    if queue.len() >= MAX_QUEUE_ORDERS {
        return Ok(EnqueuePreparation::Unsupported("queue-full"));
    }
    let next_id = safe_integer(base.get("nextId"), "next ID")?;
    if next_id == MAX_JAVASCRIPT_SAFE_INTEGER {
        return Ok(EnqueuePreparation::Unsupported("next-id-exhausted"));
    }
    let expected_queue_id = format!("construction_{next_id}");
    if !valid_opaque_text(&expected_queue_id)
        || state.entity_index.contains_key(&expected_queue_id)
        || state.belt_index.contains_key(&expected_queue_id)
        || queue
            .iter()
            .any(|row| row.get("id").and_then(Value::as_str) == Some(expected_queue_id.as_str()))
    {
        return Ok(EnqueuePreparation::Unsupported("queue-id-collision"));
    }

    let version_id = format!("{blueprint_id}@{target_revision}");
    if !valid_opaque_text(&version_id) {
        return Ok(EnqueuePreparation::Unsupported("version-conflict"));
    }
    let target_value = blueprint_values[target_index].clone();
    let version_to_append = if let Some(index) = version_indices.get(&version_id) {
        let version = versions[*index];
        if version.get("blueprintId").and_then(Value::as_str) != Some(blueprint_id)
            || positive_integer(version.get("revision"), "version revision")? != target_revision
            || version.get("definition") != Some(&target_value)
        {
            return Ok(EnqueuePreparation::Unsupported("version-conflict"));
        }
        None
    } else {
        if versions.len() >= MAX_SOURCE_ROWS {
            return Ok(EnqueuePreparation::Unsupported("version-conflict"));
        }
        Some(json!({
            "id": version_id,
            "blueprintId": blueprint_id,
            "revision": target_revision,
            "definition": target_value,
        }))
    };

    let queued_at = base
        .get("elapsedSeconds")
        .filter(|value| {
            value
                .as_f64()
                .is_some_and(|seconds| seconds.is_finite() && seconds >= 0.0)
        })
        .cloned()
        .ok_or_else(|| anyhow!("native construction queue elapsed time is invalid"))?;
    let blueprint_name = blueprint_name(target, "blueprint name")?.to_owned();
    let rotation = blueprint_rotation(target)?;
    let mirror = blueprint_mirror(target)?.to_owned();
    Ok(EnqueuePreparation::Supported(Box::new(PreparedEnqueue {
        expected_queue_id,
        next_id,
        queue_len: queue.len(),
        version_len: versions.len(),
        version_container_missing,
        version_id,
        version_to_append,
        blueprint: blueprint_values[target_index].clone(),
        blueprint_id: blueprint_id.to_owned(),
        blueprint_revision: target_revision,
        blueprint_name,
        active_planet_id,
        rotation,
        mirror,
        queued_at,
    })))
}

fn transformed_offset(x: f64, y: f64, rotation: u64, mirror: &str) -> (f64, f64) {
    let mirrored_x = if mirror == "horizontal" { -x } else { x };
    match rotation {
        90 => (-y, mirrored_x),
        180 => (-mirrored_x, -y),
        270 => (y, -mirrored_x),
        _ => (mirrored_x, y),
    }
}

fn javascript_round(value: f64) -> f64 {
    let rounded = (value + 0.5).floor();
    if rounded == 0.0 { 0.0 } else { rounded }
}

fn rounded_position_key(x: f64, y: f64) -> anyhow::Result<(u64, u64)> {
    if !x.is_finite() || !y.is_finite() {
        bail!("native construction queue transformed position is invalid")
    }
    Ok((javascript_round(x).to_bits(), javascript_round(y).to_bits()))
}

fn add_definition_positions(
    occupied: &mut HashSet<(u64, u64)>,
    definition: &Map<String, Value>,
    position: (f64, f64),
    rotation: u64,
    mirror: &str,
) -> anyhow::Result<()> {
    for (x, y) in definition_offsets(definition)? {
        let offset = transformed_offset(x, y, rotation, mirror);
        occupied.insert(rounded_position_key(
            position.0 + offset.0,
            position.1 + offset.1,
        )?);
    }
    Ok(())
}

fn validate_no_exact_overlap(
    state: &CoreState,
    prepared: &PreparedEnqueue,
    candidate_position: (f64, f64),
) -> anyhow::Result<()> {
    let base = state.base_value();
    let blueprint_values = base
        .get("blueprints")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("native construction queue blueprint directory is invalid"))?;
    let empty_version_values = Vec::new();
    let version_values = match base.get("blueprintVersions") {
        None | Some(Value::Null) => &empty_version_values,
        Some(Value::Array(values)) => values,
        _ => bail!("native construction queue version directory is invalid"),
    };
    let queue_values = base
        .get("constructionQueue")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("native construction queue directory is invalid"))?;
    let blueprints = validate_blueprint_directory(blueprint_values)?;
    let versions = validate_version_directory(version_values)?;
    let queue = validate_queue_directory(queue_values)?;
    let blueprint_indices = blueprints
        .iter()
        .enumerate()
        .map(|(index, row)| {
            (
                row.get("id")
                    .and_then(Value::as_str)
                    .expect("blueprint ID was validated")
                    .to_owned(),
                index,
            )
        })
        .collect::<HashMap<_, _>>();
    let version_indices = versions
        .iter()
        .enumerate()
        .map(|(index, row)| {
            (
                row.get("id")
                    .and_then(Value::as_str)
                    .expect("version ID was validated")
                    .to_owned(),
                index,
            )
        })
        .collect::<HashMap<_, _>>();

    let mut occupied = HashSet::new();
    for index in 0..state.entity_index.len() {
        let entity = state.parse_entity(index)?;
        let entity = entity
            .as_object()
            .ok_or_else(|| anyhow!("native construction queue live entity is invalid"))?;
        if entity.get("planetId").and_then(Value::as_str)
            != Some(prepared.active_planet_id.as_str())
        {
            continue;
        }
        let position = entity
            .get("position")
            .and_then(Value::as_object)
            .ok_or_else(|| anyhow!("native construction queue live entity position is invalid"))?;
        occupied.insert(rounded_position_key(
            finite_number(position.get("x"), "live entity x position")?,
            finite_number(position.get("y"), "live entity y position")?,
        )?);
    }
    for row in queue {
        if row.get("planetId").and_then(Value::as_str) != Some(prepared.active_planet_id.as_str())
            || queue_status(row)? == "waiting-fleet"
        {
            continue;
        }
        let definition = resolve_queue_definition(
            row,
            &blueprints,
            &blueprint_indices,
            &versions,
            &version_indices,
        )?;
        add_definition_positions(
            &mut occupied,
            definition,
            queue_position(row)?,
            blueprint_rotation(row)?,
            blueprint_mirror(row)?,
        )?;
    }

    let blueprint = prepared
        .blueprint
        .as_object()
        .ok_or_else(|| anyhow!("native construction queue prepared blueprint is invalid"))?;
    let mut candidate_positions = HashSet::new();
    for (x, y) in definition_offsets(blueprint)? {
        let offset = transformed_offset(x, y, prepared.rotation, &prepared.mirror);
        let key = rounded_position_key(
            candidate_position.0 + offset.0,
            candidate_position.1 + offset.1,
        )?;
        if occupied.contains(&key) || !candidate_positions.insert(key) {
            bail!("native construction queue blueprint has an exact position overlap")
        }
    }
    Ok(())
}

fn validated_enqueue_plan(
    state: &CoreState,
    intent: EnqueueIntent,
) -> anyhow::Result<ConstructionQueueEnqueuePlan> {
    let prepared = match prepare_enqueue(state, &intent.blueprint_id, intent.blueprint_revision)? {
        EnqueuePreparation::Supported(prepared) => prepared,
        EnqueuePreparation::Unsupported(reason) => {
            bail!("native construction queue enqueue is unsupported: {reason}")
        }
    };
    validate_no_exact_overlap(state, &prepared, (intent.x, intent.y))?;
    let queue_row = json!({
        "id": prepared.expected_queue_id,
        "blueprintId": prepared.blueprint_id,
        "blueprintVersionId": prepared.version_id,
        "blueprintRevision": prepared.blueprint_revision,
        "blueprintName": prepared.blueprint_name,
        "planetId": prepared.active_planet_id,
        "position": intent.position,
        "rotation": prepared.rotation,
        "mirror": prepared.mirror,
        "queuedAt": prepared.queued_at,
        "status": "pending-materials",
        "reservedConstruction": {},
        "reservedFleet": {},
        "placedEntityIdsByKey": {},
    });
    Ok(ConstructionQueueEnqueuePlan {
        expected_queue_id: prepared.expected_queue_id,
        next_id: prepared.next_id,
        queue_len: prepared.queue_len,
        version_len: prepared.version_len,
        version_container_missing: prepared.version_container_missing,
        version_id: prepared.version_id,
        version_to_append: prepared.version_to_append,
        queue_row,
    })
}

fn add_construction_requirement(
    requirements: &mut Vec<(String, u64)>,
    indices: &mut HashMap<String, usize>,
    construction_id: &str,
    amount: u64,
) -> anyhow::Result<()> {
    if amount == 0 {
        return Ok(());
    }
    if let Some(index) = indices.get(construction_id).copied() {
        requirements[index].1 = requirements[index]
            .1
            .checked_add(amount)
            .filter(|value| *value <= MAX_JAVASCRIPT_SAFE_INTEGER)
            .ok_or_else(|| anyhow!("native construction queue requirement overflows"))?;
    } else {
        indices.insert(construction_id.to_owned(), requirements.len());
        requirements.push((construction_id.to_owned(), amount));
    }
    Ok(())
}

fn construction_requirements(
    state: &CoreState,
    definition: &Map<String, Value>,
) -> anyhow::Result<Vec<(String, u64)>> {
    let mut requirements = Vec::new();
    let mut indices = HashMap::new();
    let entities = definition
        .get("entities")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("native construction queue blueprint entities are invalid"))?;
    for value in entities {
        let entity = value
            .as_object()
            .ok_or_else(|| anyhow!("native construction queue blueprint entity is invalid"))?;
        let building_id = entity
            .get("buildingId")
            .and_then(Value::as_str)
            .filter(|id| valid_opaque_text(id))
            .ok_or_else(|| anyhow!("native construction queue blueprint building ID is invalid"))?;
        if !state.catalog.constructions.contains_key(building_id) {
            bail!("native construction queue blueprint construction is missing")
        }
        add_construction_requirement(
            &mut requirements,
            &mut indices,
            building_id,
            positive_integer(entity.get("machineCount"), "blueprint machine count")?,
        )?;
        match entity.get("sprayCoaterInstalled") {
            None | Some(Value::Null) | Some(Value::Bool(false)) => {}
            Some(Value::Bool(true)) => {
                if !state.catalog.constructions.contains_key("spray_coater") {
                    bail!("native construction queue spray coater construction is missing")
                }
                add_construction_requirement(&mut requirements, &mut indices, "spray_coater", 1)?;
            }
            _ => bail!("native construction queue spray coater intent is invalid"),
        }
    }
    let belts = definition
        .get("belts")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("native construction queue blueprint belts are invalid"))?;
    for value in belts {
        let belt = value
            .as_object()
            .ok_or_else(|| anyhow!("native construction queue blueprint belt is invalid"))?;
        let tier = positive_integer(belt.get("tier"), "blueprint belt tier")?;
        let tier = u8::try_from(tier)
            .map_err(|_| anyhow!("native construction queue blueprint belt tier is invalid"))?;
        let construction_id = crate::command::builtin_belt_construction_id(state, tier)?;
        add_construction_requirement(
            &mut requirements,
            &mut indices,
            construction_id,
            positive_integer(belt.get("lanes"), "blueprint belt lanes")?,
        )?;
    }
    Ok(requirements)
}

fn validated_fund_plan(
    state: &CoreState,
    intent: FundIntent,
) -> anyhow::Result<ConstructionQueueFundPlan> {
    if state.identity.registry_fingerprint != EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT
        || state.catalog.snapshot.registry_fingerprint != EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT
    {
        bail!("native construction queue funding domain is unsupported")
    }
    let base = state.base_value();
    let construction = validate_inventory(base, "construction", "construction inventory")?;
    let fleet = validate_inventory(base, "portableFleet", "portable fleet")?;
    let blueprint_values = base
        .get("blueprints")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("native construction queue blueprint directory is invalid"))?;
    let empty_version_values = Vec::new();
    let version_values = match base.get("blueprintVersions") {
        None | Some(Value::Null) => &empty_version_values,
        Some(Value::Array(values)) => values,
        _ => bail!("native construction queue blueprint versions are invalid"),
    };
    let queue_values = base
        .get("constructionQueue")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("native construction queue directory is invalid"))?;
    let blueprints = validate_blueprint_directory(blueprint_values)?;
    let versions = validate_version_directory(version_values)?;
    let queue = validate_queue_directory(queue_values)?;
    let blueprint_indices = blueprints
        .iter()
        .enumerate()
        .map(|(index, row)| {
            (
                row.get("id")
                    .and_then(Value::as_str)
                    .expect("blueprint ID was validated")
                    .to_owned(),
                index,
            )
        })
        .collect::<HashMap<_, _>>();
    let version_indices = versions
        .iter()
        .enumerate()
        .map(|(index, row)| {
            (
                row.get("id")
                    .and_then(Value::as_str)
                    .expect("version ID was validated")
                    .to_owned(),
                index,
            )
        })
        .collect::<HashMap<_, _>>();
    let (index, row) = queue
        .iter()
        .enumerate()
        .find(|(_, row)| row.get("id").and_then(Value::as_str) == Some(intent.id.as_str()))
        .ok_or_else(|| anyhow!("native construction queue fund target is missing"))?;
    if queue_status(row)? != "pending-materials" {
        bail!("native construction queue fund target status is unsupported")
    }
    let definition = resolve_queue_definition(
        row,
        &blueprints,
        &blueprint_indices,
        &versions,
        &version_indices,
    )?;
    if !queue_only_definition_supported(state, definition)? {
        bail!("native construction queue fund definition is unsupported")
    }
    let requirements = construction_requirements(state, definition)?;
    let targets = requirements
        .iter()
        .map(|(id, amount)| (id.as_str(), *amount))
        .collect::<HashMap<_, _>>();
    let mut inventory_after = HashMap::<String, u64>::new();
    let mut reserved_after = Map::new();
    let mut construction_changed = false;
    if intent.scope != FundScope::Fleet {
        let reserved_source = match row.get("reservedConstruction") {
            None | Some(Value::Null) => Map::new(),
            Some(Value::Object(values)) if values.len() <= MAX_REFUND_ROWS => values.clone(),
            _ => bail!("native construction queue reserved construction is invalid"),
        };
        for (id, raw_amount) in &reserved_source {
            if !valid_opaque_text(id) {
                bail!("native construction queue reserved construction ID is invalid")
            }
            let amount = safe_inventory_amount(Some(raw_amount), "reserved construction")?;
            let target = targets.get(id.as_str()).copied().unwrap_or(0);
            let retained = amount.min(target);
            if retained > 0 {
                reserved_after.insert(id.clone(), Value::from(retained));
            }
            let refund = amount - retained;
            if refund > 0 {
                let current = inventory_after
                    .get(id)
                    .copied()
                    .unwrap_or(safe_inventory_amount(
                        construction.get(id),
                        "construction inventory",
                    )?);
                let returned = current
                    .checked_add(refund)
                    .filter(|value| *value <= MAX_JAVASCRIPT_SAFE_INTEGER)
                    .ok_or_else(|| {
                        anyhow!("native construction queue construction refund overflows")
                    })?;
                inventory_after.insert(id.clone(), returned);
                construction_changed = true;
            }
        }
        for (id, target) in &requirements {
            let reserved = reserved_after.get(id).and_then(Value::as_u64).unwrap_or(0);
            let current = inventory_after
                .get(id)
                .copied()
                .unwrap_or(safe_inventory_amount(
                    construction.get(id),
                    "construction inventory",
                )?);
            let taken = (target - reserved).min(current);
            let reserved = reserved + taken;
            if reserved > 0 {
                reserved_after.insert(id.clone(), Value::from(reserved));
            }
            if taken > 0 {
                inventory_after.insert(id.clone(), current - taken);
                construction_changed = true;
            }
        }
    }

    // The current queue-only ordinary blueprint domain has no supported
    // station templates, so its authoritative fleet target is exactly zero.
    // Fleet/all therefore only normalize legacy/excess reservations back into
    // the portable inventory; they never invent a renderer-provided target.
    let mut fleet_after = HashMap::<String, u64>::new();
    let mut fleet_changed = false;
    if intent.scope != FundScope::Construction {
        let reserved_fleet = match row.get("reservedFleet") {
            None | Some(Value::Null) => Map::new(),
            Some(Value::Object(values)) if values.len() <= MAX_REFUND_ROWS => values.clone(),
            _ => bail!("native construction queue reserved fleet is invalid"),
        };
        for (id, raw_amount) in reserved_fleet {
            if !valid_opaque_text(&id) {
                bail!("native construction queue reserved fleet ID is invalid")
            }
            let amount = safe_inventory_amount(Some(&raw_amount), "reserved fleet")?;
            if amount == 0 {
                continue;
            }
            let current = safe_inventory_amount(fleet.get(&id), "portable fleet")?;
            let returned = current
                .checked_add(amount)
                .filter(|value| *value <= MAX_JAVASCRIPT_SAFE_INTEGER)
                .ok_or_else(|| anyhow!("native construction queue fleet refund overflows"))?;
            fleet_after.insert(id, returned);
            fleet_changed = true;
        }
    }
    if !construction_changed && !fleet_changed {
        bail!("native construction queue fund intent is a no-op")
    }
    let mut construction_updates = inventory_after
        .into_iter()
        .map(|(id, amount_after)| InventoryUpdate { id, amount_after })
        .collect::<Vec<_>>();
    construction_updates.sort_by(|left, right| left.id.cmp(&right.id));
    let mut fleet_updates = fleet_after
        .into_iter()
        .map(|(id, amount_after)| InventoryUpdate { id, amount_after })
        .collect::<Vec<_>>();
    fleet_updates.sort_by(|left, right| left.id.cmp(&right.id));
    Ok(ConstructionQueueFundPlan {
        id: intent.id,
        index,
        construction_updates,
        fleet_updates,
        reserved_construction: construction_changed.then_some(reserved_after),
        reserved_fleet: fleet_changed.then(Map::new),
    })
}

fn optional_bounded_integer(
    value: Option<&Value>,
    minimum: u64,
    maximum: u64,
    label: &str,
) -> anyhow::Result<Option<u64>> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(value) => safe_integer(Some(value), label).and_then(|value| {
            if value < minimum || value > maximum {
                bail!("native construction queue {label} is invalid")
            }
            Ok(Some(value))
        }),
    }
}

fn optional_text<'a>(value: Option<&'a Value>, label: &str) -> anyhow::Result<Option<&'a str>> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) if valid_opaque_text(value) => Ok(Some(value)),
        _ => bail!("native construction queue {label} is invalid"),
    }
}

fn optional_bool(value: Option<&Value>, label: &str) -> anyhow::Result<Option<bool>> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Bool(value)) => Ok(Some(*value)),
        _ => bail!("native construction queue {label} is invalid"),
    }
}

fn ensure_only_keys(
    object: &Map<String, Value>,
    allowed: &[&str],
    label: &str,
) -> anyhow::Result<()> {
    if object.keys().any(|key| !allowed.contains(&key.as_str())) {
        bail!("native construction queue {label} contains unsupported fields")
    }
    Ok(())
}

fn reservation_map<'a>(
    value: Option<&'a Value>,
    label: &str,
) -> anyhow::Result<Option<&'a Map<String, Value>>> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Object(values)) if values.len() <= MAX_REFUND_ROWS => Ok(Some(values)),
        _ => bail!("native construction queue reserved {label} is invalid"),
    }
}

fn exact_reservations_ready(
    state: &CoreState,
    row: &Map<String, Value>,
    definition: &Map<String, Value>,
) -> anyhow::Result<bool> {
    let requirements = construction_requirements(state, definition)?;
    let targets = requirements
        .iter()
        .map(|(id, amount)| (id.as_str(), *amount))
        .collect::<HashMap<_, _>>();
    let reserved = reservation_map(row.get("reservedConstruction"), "construction")?;
    for (id, amount) in reserved.into_iter().flatten() {
        if !valid_opaque_text(id) {
            bail!("native construction queue reserved construction ID is invalid")
        }
        let amount = safe_inventory_amount(Some(amount), "reserved construction")?;
        if amount != targets.get(id.as_str()).copied().unwrap_or(0) {
            return Ok(false);
        }
    }
    for (id, amount) in &requirements {
        if safe_inventory_amount(
            reserved.and_then(|values| values.get(id)),
            "reserved construction",
        )? != *amount
        {
            return Ok(false);
        }
    }
    for (id, amount) in reservation_map(row.get("reservedFleet"), "fleet")?
        .into_iter()
        .flatten()
    {
        if !valid_opaque_text(id) {
            bail!("native construction queue reserved fleet ID is invalid")
        }
        if safe_inventory_amount(Some(amount), "reserved fleet")? != 0 {
            return Ok(false);
        }
    }
    Ok(true)
}

const DEPLOY_ENTITY_KEYS: &[&str] = &[
    "key",
    "buildingId",
    "offset",
    "machineCount",
    "recipeId",
    "targetDysonOrbitId",
    "storedItemId",
    "distributionMode",
    "fuelItemId",
    "energyMode",
    "powerGridId",
    "powerPriority",
    "generationPriority",
    "sprayCoaterInstalled",
    "proliferatorTier",
    "proliferatorMode",
];

const DEPLOY_BELT_KEYS: &[&str] = &[
    "key",
    "sourceKey",
    "targetKey",
    "itemId",
    "lanes",
    "tier",
    "sorterTier",
    "priority",
    "stackSize",
    "monitorEnabled",
    "routeMode",
    "routeOffsetY",
];

fn dyson_orbit_belongs_to_planet(
    state: &CoreState,
    planet_id: &str,
    orbit_id: &str,
) -> anyhow::Result<bool> {
    let system_id = state
        .catalog
        .planets
        .iter()
        .find(|planet| planet.id == planet_id)
        .map(|planet| planet.system_id.as_str())
        .ok_or_else(|| anyhow!("native construction queue deploy planet is missing"))?;
    Ok(state
        .base_value()
        .get("dysonEngineering")
        .and_then(Value::as_object)
        .and_then(|engineering| engineering.get("orbitsBySystem"))
        .and_then(Value::as_object)
        .and_then(|systems| systems.get(system_id))
        .and_then(Value::as_array)
        .is_some_and(|orbits| {
            orbits
                .iter()
                .any(|orbit| orbit.get("id").and_then(Value::as_str) == Some(orbit_id))
        }))
}

fn deploy_definition_semantics_supported(
    state: &CoreState,
    definition: &Map<String, Value>,
    planet_id: &str,
) -> anyhow::Result<bool> {
    let entities = definition
        .get("entities")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("native construction queue blueprint entities are invalid"))?;
    for value in entities {
        let entity = value
            .as_object()
            .ok_or_else(|| anyhow!("native construction queue blueprint entity is invalid"))?;
        if ensure_only_keys(entity, DEPLOY_ENTITY_KEYS, "blueprint entity").is_err() {
            return Ok(false);
        }
        let building_id = entity
            .get("buildingId")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow!("native construction queue blueprint building ID is invalid"))?;
        let building =
            state.catalog.buildings.get(building_id).ok_or_else(|| {
                anyhow!("native construction queue blueprint building is missing")
            })?;
        if optional_text(entity.get("storedItemId"), "stored item")?.is_some_and(|id| {
            !state.catalog.items.contains_key(id)
                || !matches!(building.kind.as_str(), "storage" | "splitter")
        }) || optional_text(entity.get("fuelItemId"), "fuel item")?.is_some_and(|id| {
            !building
                .fuel_item_ids
                .iter()
                .any(|candidate| candidate == id)
        }) {
            return Ok(false);
        }
        if let Some(value) = optional_text(entity.get("distributionMode"), "distribution mode")?
            && (building.kind != "splitter" || !matches!(value, "balanced" | "priority"))
        {
            return Ok(false);
        }
        if let Some(value) = optional_text(entity.get("energyMode"), "energy mode")? {
            let supported = match building_id {
                "accumulator" => value == "auto",
                "energy_exchanger" => matches!(value, "auto" | "charge" | "discharge"),
                _ => false,
            };
            if !supported {
                return Ok(false);
            }
        }
        if optional_text(entity.get("powerGridId"), "power grid")?
            .is_some_and(|value| !matches!(value, "grid-a" | "grid-b" | "grid-c"))
        {
            return Ok(false);
        }
        optional_bounded_integer(entity.get("powerPriority"), 1, 3, "power priority")?;
        if entity.get("generationPriority").is_some() && building.kind != "power" {
            return Ok(false);
        }
        optional_bounded_integer(
            entity.get("generationPriority"),
            1,
            3,
            "generation priority",
        )?;
        if let Some(orbit_id) = optional_text(entity.get("targetDysonOrbitId"), "Dyson orbit")? {
            if building_id != "em_rail_ejector" {
                return Ok(false);
            }
            if !dyson_orbit_belongs_to_planet(state, planet_id, orbit_id)? {
                return Ok(false);
            }
        }
        if let Some(installed) =
            optional_bool(entity.get("sprayCoaterInstalled"), "spray coater installed")?
        {
            if installed {
                let tier = optional_bounded_integer(
                    entity.get("proliferatorTier"),
                    1,
                    3,
                    "proliferator tier",
                )?
                .unwrap_or(1) as u8;
                let Some(proliferator) = state.catalog.proliferators.get(&tier) else {
                    return Ok(false);
                };
                if !crate::command::technology_is_completed(state, &proliferator.required_tech_id)
                    || optional_text(entity.get("proliferatorMode"), "proliferator mode")?
                        .is_some_and(|value| !matches!(value, "normal" | "extra" | "speed"))
                {
                    return Ok(false);
                }
            } else if entity.get("proliferatorTier").is_some()
                || entity.get("proliferatorMode").is_some()
            {
                return Ok(false);
            }
        } else if entity.get("proliferatorTier").is_some()
            || entity.get("proliferatorMode").is_some()
        {
            return Ok(false);
        }
    }
    let belts = definition
        .get("belts")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("native construction queue blueprint belts are invalid"))?;
    for value in belts {
        let belt = value
            .as_object()
            .ok_or_else(|| anyhow!("native construction queue blueprint belt is invalid"))?;
        if ensure_only_keys(belt, DEPLOY_BELT_KEYS, "blueprint belt").is_err() {
            return Ok(false);
        }
        let tier = positive_integer(belt.get("tier"), "blueprint belt tier")?;
        if optional_bounded_integer(belt.get("sorterTier"), 1, 3, "sorter tier")?
            .is_some_and(|sorter| sorter != tier.min(3))
            || optional_bounded_integer(belt.get("stackSize"), 1, 4, "belt stack size")?
                .is_some_and(|value| !matches!(value, 1 | 2 | 4))
        {
            return Ok(false);
        }
        optional_bounded_integer(belt.get("priority"), 0, 2, "belt priority")?;
        let stack_size =
            optional_bounded_integer(belt.get("stackSize"), 1, 4, "belt stack size")?.unwrap_or(1);
        if stack_size == 2
            && !crate::command::technology_is_completed(state, "high_speed_logistics")
            || stack_size == 4
                && !crate::command::technology_is_completed(state, "super_magnetic_logistics")
        {
            return Ok(false);
        }
        optional_bool(belt.get("monitorEnabled"), "belt monitor")?;
        let route_mode = optional_text(belt.get("routeMode"), "belt route mode")?.unwrap_or("auto");
        if !matches!(route_mode, "bezier" | "auto" | "upper" | "lower" | "manual") {
            return Ok(false);
        }
        if let Some(value) = belt.get("routeOffsetY")
            && !value.is_null()
        {
            let offset = value
                .as_i64()
                .filter(|value| (-600..=600).contains(value))
                .ok_or_else(|| anyhow!("native construction queue belt route offset is invalid"))?;
            if route_mode != "manual" || !(-600..=600).contains(&offset) {
                return Ok(false);
            }
        }
        if belt.get("sourceKey") == belt.get("targetKey") {
            return Ok(false);
        }
    }
    Ok(true)
}

pub(crate) fn queue_entry_deploy_ready(
    state: &CoreState,
    row: &Map<String, Value>,
    definition: &Map<String, Value>,
) -> anyhow::Result<bool> {
    if state.identity.registry_fingerprint != EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT
        || state.catalog.snapshot.registry_fingerprint != EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT
        || queue_status(row)? != "pending-materials"
        || !matches!(row.get("allowExactOverlap"), None | Some(Value::Null))
        || !matches!(row.get("buildingCompletedAt"), None | Some(Value::Null))
    {
        return Ok(false);
    }
    let placed = match row.get("placedEntityIdsByKey") {
        None | Some(Value::Null) => None,
        Some(Value::Object(values)) => Some(values),
        _ => return Ok(false),
    };
    if placed.is_some_and(|values| !values.is_empty()) {
        return Ok(false);
    }
    let planet_id = row
        .get("planetId")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("native construction queue persisted planet is invalid"))?;
    let queue_supported = queue_only_definition_supported_on_planet(state, definition, planet_id)?;
    let semantics_supported = deploy_definition_semantics_supported(state, definition, planet_id)?;
    let reservations_ready = exact_reservations_ready(state, row, definition)?;
    if !queue_supported || !semantics_supported || !reservations_ready {
        return Ok(false);
    }
    Ok(true)
}

#[allow(clippy::too_many_arguments)]
fn validate_deploy_overlap(
    state: &CoreState,
    target_id: &str,
    target: &Map<String, Value>,
    definition: &Map<String, Value>,
    blueprints: &[&Map<String, Value>],
    blueprint_indices: &HashMap<String, usize>,
    versions: &[&Map<String, Value>],
    version_indices: &HashMap<String, usize>,
    queue: &[&Map<String, Value>],
) -> anyhow::Result<()> {
    let planet_id = target
        .get("planetId")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("native construction queue persisted planet is invalid"))?;
    let mut occupied = HashSet::new();
    for index in 0..state.entity_index.len() {
        let entity = state.parse_entity(index)?;
        let entity = entity
            .as_object()
            .ok_or_else(|| anyhow!("native construction queue live entity is invalid"))?;
        if entity.get("planetId").and_then(Value::as_str) != Some(planet_id) {
            continue;
        }
        let position = entity
            .get("position")
            .and_then(Value::as_object)
            .ok_or_else(|| anyhow!("native construction queue live entity position is invalid"))?;
        occupied.insert(rounded_position_key(
            finite_number(position.get("x"), "live entity x position")?,
            finite_number(position.get("y"), "live entity y position")?,
        )?);
    }
    for row in queue {
        if row.get("id").and_then(Value::as_str) == Some(target_id)
            || row.get("planetId").and_then(Value::as_str) != Some(planet_id)
            || queue_status(row)? == "waiting-fleet"
        {
            continue;
        }
        let peer = resolve_queue_definition(
            row,
            blueprints,
            blueprint_indices,
            versions,
            version_indices,
        )?;
        add_definition_positions(
            &mut occupied,
            peer,
            queue_position(row)?,
            blueprint_rotation(row)?,
            blueprint_mirror(row)?,
        )?;
    }
    let position = queue_position(target)?;
    let rotation = blueprint_rotation(target)?;
    let mirror = blueprint_mirror(target)?;
    let mut candidate = HashSet::new();
    for (x, y) in definition_offsets(definition)? {
        let offset = transformed_offset(x, y, rotation, mirror);
        let key = rounded_position_key(position.0 + offset.0, position.1 + offset.1)?;
        if occupied.contains(&key) || !candidate.insert(key) {
            bail!("native construction queue deploy has an exact position overlap")
        }
    }
    Ok(())
}

fn compile_deploy_records(
    state: &CoreState,
    row: &Map<String, Value>,
    definition: &Map<String, Value>,
    next_id: u64,
) -> anyhow::Result<(Vec<AddedRecord>, Vec<AddedRecord>, u64)> {
    let planet_id = row
        .get("planetId")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("native construction queue deploy planet is invalid"))?;
    let origin = queue_position(row)?;
    let rotation = blueprint_rotation(row)?;
    let mirror = blueprint_mirror(row)?;
    let entity_values = definition
        .get("entities")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("native construction queue blueprint entities are invalid"))?;
    let belt_values = definition
        .get("belts")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("native construction queue blueprint belts are invalid"))?;
    let record_count = entity_values
        .len()
        .checked_add(belt_values.len())
        .ok_or_else(|| anyhow!("native construction queue deploy record count overflows"))?;
    let next_id_after = next_id
        .checked_add(record_count as u64)
        .filter(|value| *value <= MAX_JAVASCRIPT_SAFE_INTEGER)
        .ok_or_else(|| anyhow!("native construction queue deploy allocator is exhausted"))?;
    let overrides = match definition.get("recipeOverrides") {
        None | Some(Value::Null) => None,
        Some(Value::Object(values)) => Some(values),
        _ => bail!("native construction queue blueprint recipe overrides are invalid"),
    };

    let mut keys = HashMap::<String, (String, usize)>::with_capacity(entity_values.len());
    let mut entities = Vec::<Map<String, Value>>::with_capacity(entity_values.len());
    for (ordinal, value) in entity_values.iter().enumerate() {
        let template = value
            .as_object()
            .ok_or_else(|| anyhow!("native construction queue blueprint entity is invalid"))?;
        let key = template
            .get("key")
            .and_then(Value::as_str)
            .filter(|value| valid_opaque_text(value))
            .ok_or_else(|| anyhow!("native construction queue blueprint entity key is invalid"))?;
        let building_id = template
            .get("buildingId")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow!("native construction queue blueprint building ID is invalid"))?;
        let allocated = next_id
            .checked_add(ordinal as u64)
            .ok_or_else(|| anyhow!("native construction queue deploy allocator overflows"))?;
        let id = format!("entity_{allocated}");
        if state.entity_index.contains_key(&id)
            || state.belt_index.contains_key(&id)
            || keys.contains_key(key)
        {
            bail!("native construction queue deploy entity ID or key collides")
        }
        let mut entity = crate::command::canonical_ordinary_placement_entity_template(
            state,
            building_id,
            &id,
            planet_id,
        )?;
        let offset = template
            .get("offset")
            .and_then(Value::as_object)
            .ok_or_else(|| anyhow!("native construction queue blueprint offset is invalid"))?;
        let transformed = transformed_offset(
            finite_number(offset.get("x"), "blueprint x offset")?,
            finite_number(offset.get("y"), "blueprint y offset")?,
            rotation,
            mirror,
        );
        let x = origin.0 + transformed.0;
        let y = origin.1 + transformed.1;
        if !x.is_finite() || !y.is_finite() {
            bail!("native construction queue deploy position is invalid")
        }
        entity.insert("position".to_owned(), json!({ "x": x, "y": y }));
        entity.insert(
            "machineCount".to_owned(),
            Value::from(positive_integer(
                template.get("machineCount"),
                "blueprint machine count",
            )?),
        );

        if let Some(source_recipe_id) = optional_text(template.get("recipeId"), "recipe ID")? {
            let recipe_id = overrides
                .and_then(|values| values.get(source_recipe_id))
                .and_then(Value::as_str)
                .unwrap_or(source_recipe_id);
            let recipe = state
                .catalog
                .recipes
                .get(recipe_id)
                .ok_or_else(|| anyhow!("native construction queue deploy recipe is missing"))?;
            let building =
                state.catalog.buildings.get(building_id).ok_or_else(|| {
                    anyhow!("native construction queue deploy building is missing")
                })?;
            if recipe.building_id
                != crate::command::recipe_building_base(building_id, building.family.as_deref())
                || recipe
                    .required_tech_id
                    .as_deref()
                    .is_some_and(|tech| !crate::command::technology_is_completed(state, tech))
            {
                bail!("native construction queue deploy recipe is unsupported")
            }
            entity.insert("recipeId".to_owned(), Value::from(recipe_id));
        }
        if let Some(value) = optional_text(template.get("targetDysonOrbitId"), "Dyson orbit")? {
            entity.insert("targetDysonOrbitId".to_owned(), Value::from(value));
        }
        if let Some(value) = optional_text(template.get("storedItemId"), "stored item")? {
            entity.insert("storedItemId".to_owned(), Value::from(value));
        }
        if let Some(value) = optional_text(template.get("fuelItemId"), "fuel item")? {
            entity.insert("fuelItemId".to_owned(), Value::from(value));
        }
        if let Some(value) = optional_text(template.get("distributionMode"), "distribution mode")? {
            entity.insert("distributionMode".to_owned(), Value::from(value));
        }
        if let Some(value) = optional_text(template.get("energyMode"), "energy mode")? {
            entity.insert("energyMode".to_owned(), Value::from(value));
        }
        if let Some(value) = optional_text(template.get("powerGridId"), "power grid")? {
            entity.insert("powerGridId".to_owned(), Value::from(value));
        }
        if let Some(value) =
            optional_bounded_integer(template.get("powerPriority"), 1, 3, "power priority")?
        {
            entity.insert("powerPriority".to_owned(), Value::from(value));
        }
        let building = state
            .catalog
            .buildings
            .get(building_id)
            .expect("deployment building was validated");
        if building.kind == "power"
            && let Some(priority) = optional_bounded_integer(
                template.get("generationPriority"),
                1,
                3,
                "generation priority",
            )?
        {
            entity.insert("generationPriority".to_owned(), Value::from(priority));
        }
        if let Some(installed) = optional_bool(
            template.get("sprayCoaterInstalled"),
            "spray coater installed",
        )? {
            entity.insert("sprayCoaterInstalled".to_owned(), Value::from(installed));
            if installed {
                entity.insert(
                    "proliferatorTier".to_owned(),
                    Value::from(
                        optional_bounded_integer(
                            template.get("proliferatorTier"),
                            1,
                            3,
                            "proliferator tier",
                        )?
                        .unwrap_or(1),
                    ),
                );
                entity.insert(
                    "proliferatorMode".to_owned(),
                    Value::from(
                        optional_text(template.get("proliferatorMode"), "proliferator mode")?
                            .unwrap_or("normal"),
                    ),
                );
            }
        }
        entity.insert("proliferatorPoints".to_owned(), Value::from(0));
        entity.insert("proliferatorBonusProgress".to_owned(), json!({}));
        keys.insert(key.to_owned(), (id, ordinal));
        entities.push(entity);
    }

    let mut belts = Vec::with_capacity(belt_values.len());
    for (ordinal, value) in belt_values.iter().enumerate() {
        let template = value
            .as_object()
            .ok_or_else(|| anyhow!("native construction queue blueprint belt is invalid"))?;
        let source_key = template
            .get("sourceKey")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow!("native construction queue belt source key is invalid"))?;
        let target_key = template
            .get("targetKey")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow!("native construction queue belt target key is invalid"))?;
        let (source_id, _) = keys
            .get(source_key)
            .ok_or_else(|| anyhow!("native construction queue belt source is missing"))?;
        let (target_id, target_index) = keys
            .get(target_key)
            .ok_or_else(|| anyhow!("native construction queue belt target is missing"))?;
        let item_id = template
            .get("itemId")
            .and_then(Value::as_str)
            .filter(|id| state.catalog.items.contains_key(*id))
            .ok_or_else(|| anyhow!("native construction queue belt item is invalid"))?;
        let target = entities
            .get_mut(*target_index)
            .ok_or_else(|| anyhow!("native construction queue belt target index is invalid"))?;
        let target_kind = target.get("kind").and_then(Value::as_str);
        if matches!(target_kind, Some("storage" | "splitter")) {
            match target.get("storedItemId").and_then(Value::as_str) {
                Some(existing) if existing != item_id => {
                    bail!("native construction queue storage target item conflicts")
                }
                None => {
                    target.insert("storedItemId".to_owned(), Value::from(item_id));
                }
                _ => {}
            }
        }
        let target_building_id = target
            .get("buildingId")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow!("native construction queue belt target building is invalid"))?;
        let target_accepts_fuel = state
            .catalog
            .buildings
            .get(target_building_id)
            .is_some_and(|building| building.fuel_item_ids.iter().any(|id| id == item_id));
        if target_accepts_fuel {
            match target.get("fuelItemId").and_then(Value::as_str) {
                Some(existing) if existing != item_id => {
                    bail!("native construction queue fuel target item conflicts")
                }
                None => {
                    target.insert("fuelItemId".to_owned(), Value::from(item_id));
                }
                _ => {}
            }
        }
        let allocated = next_id
            .checked_add(entity_values.len() as u64)
            .and_then(|value| value.checked_add(ordinal as u64))
            .ok_or_else(|| anyhow!("native construction queue deploy allocator overflows"))?;
        let id = format!("belt_{allocated}");
        if state.entity_index.contains_key(&id) || state.belt_index.contains_key(&id) {
            bail!("native construction queue deploy belt ID collides")
        }
        let tier = positive_integer(template.get("tier"), "blueprint belt tier")?;
        let belt = json!({
            "id": id,
            "planetId": planet_id,
            "source": source_id,
            "target": target_id,
            "itemId": item_id,
            "lanes": positive_integer(template.get("lanes"), "blueprint belt lanes")?,
            "tier": tier,
            "sorterTier": tier.min(3),
            "progress": 0,
            "priority": optional_bounded_integer(template.get("priority"), 0, 2, "belt priority")?.unwrap_or(1),
            "stackSize": optional_bounded_integer(template.get("stackSize"), 1, 4, "belt stack size")?.unwrap_or(1),
            "monitorEnabled": optional_bool(template.get("monitorEnabled"), "belt monitor")?.unwrap_or(false),
            "routeMode": optional_text(template.get("routeMode"), "belt route mode")?.unwrap_or("auto"),
            "totalTransferred": 0,
            "congestion": 0,
            "lastFlow": 0,
        });
        let mut belt = belt
            .as_object()
            .expect("canonical deployment belt is an object")
            .clone();
        if let Some(value) = template.get("routeOffsetY")
            && !value.is_null()
        {
            belt.insert(
                "routeOffsetY".to_owned(),
                Value::from(
                    value
                        .as_i64()
                        .filter(|value| (-600..=600).contains(value))
                        .ok_or_else(|| {
                            anyhow!("native construction queue belt route offset is invalid")
                        })?,
                ),
            );
        }
        belts.push(AddedRecord {
            index: state.belt_index.len() + ordinal,
            value: Value::Object(belt),
        });
    }
    let added_entities = entities
        .into_iter()
        .enumerate()
        .map(|(ordinal, entity)| AddedRecord {
            index: state.entity_index.len() + ordinal,
            value: Value::Object(entity),
        })
        .collect();
    Ok((added_entities, belts, next_id_after))
}

fn validated_deploy_plan(
    state: &CoreState,
    target_id: String,
) -> anyhow::Result<ConstructionQueueDeployPlan> {
    let base = state.base_value();
    let blueprint_values = base
        .get("blueprints")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("native construction queue blueprint directory is invalid"))?;
    let empty_version_values = Vec::new();
    let version_values = match base.get("blueprintVersions") {
        None | Some(Value::Null) => &empty_version_values,
        Some(Value::Array(values)) => values,
        _ => bail!("native construction queue blueprint versions are invalid"),
    };
    let queue_values = base
        .get("constructionQueue")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("native construction queue directory is invalid"))?;
    let blueprints = validate_blueprint_directory(blueprint_values)?;
    let versions = validate_version_directory(version_values)?;
    let queue = validate_queue_directory(queue_values)?;
    let blueprint_indices = blueprints
        .iter()
        .enumerate()
        .map(|(index, row)| {
            (
                row.get("id").and_then(Value::as_str).unwrap().to_owned(),
                index,
            )
        })
        .collect::<HashMap<_, _>>();
    let version_indices = versions
        .iter()
        .enumerate()
        .map(|(index, row)| {
            (
                row.get("id").and_then(Value::as_str).unwrap().to_owned(),
                index,
            )
        })
        .collect::<HashMap<_, _>>();
    for version in &versions {
        let owner = version.get("blueprintId").and_then(Value::as_str).unwrap();
        let revision = positive_integer(version.get("revision"), "version revision")?;
        let definition = version
            .get("definition")
            .and_then(Value::as_object)
            .unwrap();
        if definition.get("id").and_then(Value::as_str) != Some(owner)
            || blueprint_revision(definition)? != revision
        {
            bail!("native construction queue immutable version identity is invalid")
        }
    }
    for candidate in &queue {
        let planet_id = candidate
            .get("planetId")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow!("native construction queue persisted planet is invalid"))?;
        if !state
            .catalog
            .planets
            .iter()
            .any(|planet| planet.id == planet_id)
        {
            bail!("native construction queue persisted planet is not in the catalog")
        }
        resolve_queue_definition(
            candidate,
            &blueprints,
            &blueprint_indices,
            &versions,
            &version_indices,
        )?;
    }
    let (index, row) = queue
        .iter()
        .enumerate()
        .find(|(_, row)| row.get("id").and_then(Value::as_str) == Some(target_id.as_str()))
        .ok_or_else(|| anyhow!("native construction queue deploy target is missing"))?;
    let definition = resolve_queue_definition(
        row,
        &blueprints,
        &blueprint_indices,
        &versions,
        &version_indices,
    )?;
    if !queue_entry_deploy_ready(state, row, definition)? {
        bail!("native construction queue deploy target is not ready")
    }
    validate_deploy_overlap(
        state,
        &target_id,
        row,
        definition,
        &blueprints,
        &blueprint_indices,
        &versions,
        &version_indices,
        &queue,
    )?;
    let next_id = safe_integer(base.get("nextId"), "next ID")?;
    let (added_entities, added_belts, next_id_after) =
        compile_deploy_records(state, row, definition, next_id)?;
    let queue_ids = queue
        .iter()
        .filter_map(|row| row.get("id").and_then(Value::as_str))
        .collect::<HashSet<_>>();
    if added_entities
        .iter()
        .chain(&added_belts)
        .filter_map(|addition| addition.value.get("id").and_then(Value::as_str))
        .any(|id| queue_ids.contains(id))
    {
        bail!("native construction queue deploy generated ID collides with a queue ID")
    }
    let retained_version_ids = queue
        .iter()
        .enumerate()
        .filter(|(candidate_index, _)| *candidate_index != index)
        .filter_map(|(_, row)| row.get("blueprintVersionId").and_then(Value::as_str))
        .map(str::to_owned)
        .collect();
    Ok(ConstructionQueueDeployPlan {
        id: target_id,
        index,
        next_id,
        next_id_after,
        retained_version_ids,
        added_entities,
        added_belts,
    })
}

fn validated_plan(
    state: &CoreState,
    command: &SimulationCommandPatch,
) -> anyhow::Result<ConstructionQueuePlan> {
    match require_intent(command)? {
        ConstructionQueueIntent::Cancel(id) => {
            validated_cancel_plan(state, id).map(ConstructionQueuePlan::Cancel)
        }
        ConstructionQueueIntent::Enqueue(intent) => {
            validated_enqueue_plan(state, intent).map(ConstructionQueuePlan::Enqueue)
        }
        ConstructionQueueIntent::Fund(intent) => {
            validated_fund_plan(state, intent).map(ConstructionQueuePlan::Fund)
        }
        ConstructionQueueIntent::Deploy(id) => validated_deploy_plan(state, id)
            .map(Box::new)
            .map(ConstructionQueuePlan::Deploy),
    }
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
) -> anyhow::Result<ConstructionQueueExpansion> {
    let plan = validated_plan(state, command)?;
    let (added_entities, added_belts) = match &plan {
        ConstructionQueuePlan::Deploy(plan) => {
            (plan.added_entities.clone(), plan.added_belts.clone())
        }
        _ => (Vec::new(), Vec::new()),
    };
    Ok(ConstructionQueueExpansion {
        command: SimulationCommandPatch {
            protocol_version: command.protocol_version,
            base_revision: command.base_revision,
            top_level_changes: Vec::new(),
            changed_entities: Vec::new(),
            added_entities,
            removed_entity_ids: Vec::new(),
            changed_belts: Vec::new(),
            added_belts,
            removed_belt_ids: Vec::new(),
        },
        plan,
    })
}

impl CoreState {
    /// Same-revision, click-time authority context. It exposes only the queue
    /// ID derived from the current allocator; all persisted row fields remain
    /// Core-private and are re-derived again when the marker is applied.
    pub fn blueprint_enqueue_context_projection(
        &self,
        expected_revision: u64,
        expected_registry_fingerprint: &str,
        blueprint_id: &str,
        blueprint_revision: u64,
    ) -> anyhow::Result<Value> {
        if expected_revision != self.revision
            || expected_revision >= MAX_JAVASCRIPT_SAFE_INTEGER
            || expected_registry_fingerprint != self.catalog.snapshot.registry_fingerprint
            || !valid_opaque_text(blueprint_id)
            || blueprint_revision == 0
            || blueprint_revision > MAX_JAVASCRIPT_SAFE_INTEGER
        {
            bail!("native blueprint enqueue context request is invalid")
        }
        let active_planet_id = active_planet_id(self)?.to_owned();
        let preparation = prepare_enqueue(self, blueprint_id, blueprint_revision)?;
        let (supported, reason, expected_queue_id) = match preparation {
            EnqueuePreparation::Supported(prepared) => {
                (true, Value::Null, Value::from(prepared.expected_queue_id))
            }
            EnqueuePreparation::Unsupported(reason) => (false, Value::from(reason), Value::Null),
        };
        let value = json!({
            "schemaVersion": 1,
            "projectionType": BLUEPRINT_ENQUEUE_CONTEXT_PROJECTION,
            "source": "native-core",
            "revision": self.revision,
            "stateVersion": self.identity.state_version,
            "registryFingerprint": self.catalog.snapshot.registry_fingerprint,
            "request": {
                "expectedRevision": expected_revision,
                "expectedRegistryFingerprint": expected_registry_fingerprint,
                "blueprintId": blueprint_id,
                "blueprintRevision": blueprint_revision,
            },
            "activePlanetId": active_planet_id,
            "support": {
                "supported": supported,
                "reason": reason,
            },
            "expectedQueueId": expected_queue_id,
            "limits": {
                "projectionBytes": MAX_PROJECTION_BYTES,
            },
        });
        if serde_json::to_vec(&value)?.len() > MAX_PROJECTION_BYTES {
            bail!("native blueprint enqueue context exceeds the byte limit")
        }
        Ok(value)
    }
}
