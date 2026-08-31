//! Bounded, read-only blueprint library and construction-queue projection.
//!
//! The public v47 arrays stay in the canonical base chunk.  This module reads
//! them in their persisted order and never rewrites, sorts, or supplements
//! them from a renderer-owned `GameState`.  Catalog-backed detail is compacted
//! to display-only fields; any material reference that the active registry
//! cannot prove makes that one detail explicitly unsupported.

use std::collections::HashSet;

use anyhow::{anyhow, bail};
use serde_json::{Map, Value, json};

use crate::state::CoreState;

const BLUEPRINT_WORKSPACE_PROJECTION: &str = "blueprint-workspace-v1";
const MAX_PROJECTION_BYTES: usize = 1_048_576;
const PAGE_ROWS: usize = 32;
const MAX_SOURCE_ROWS: usize = 4_096;
const MAX_DETAIL_ENTITIES: usize = 512;
const MAX_DETAIL_BELTS: usize = 1_024;
const MAX_DETAIL_ANCHORS: usize = 256;
const MAX_DETAIL_PORTS: usize = 256;
const MAX_OPAQUE_ID_BYTES: usize = 512;
const MAX_NAME_BYTES: usize = 256;
const MAX_BELT_LANES: u64 = 4_096;
const MAX_BUILDING_STACK_COUNT: u64 = 100_000_000;
const MAX_JAVASCRIPT_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Section {
    Library,
    Detail,
    Queue,
    QueueMembership,
}

impl Section {
    fn parse(value: &str) -> anyhow::Result<Self> {
        match value {
            "library" => Ok(Self::Library),
            "detail" => Ok(Self::Detail),
            "queue" => Ok(Self::Queue),
            "queue-membership" => Ok(Self::QueueMembership),
            _ => bail!("native blueprint workspace section is invalid"),
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Library => "library",
            Self::Detail => "detail",
            Self::Queue => "queue",
            Self::QueueMembership => "queue-membership",
        }
    }
}

fn valid_opaque_text(value: &str, maximum_bytes: usize) -> bool {
    !value.is_empty() && value.len() <= maximum_bytes && !value.chars().any(char::is_control)
}

fn required_object<'a>(value: &'a Value, label: &str) -> anyhow::Result<&'a Map<String, Value>> {
    value
        .as_object()
        .ok_or_else(|| anyhow!("native blueprint workspace {label} is invalid"))
}

fn required_array<'a>(
    object: &'a Map<String, Value>,
    key: &str,
    label: &str,
) -> anyhow::Result<&'a Vec<Value>> {
    object
        .get(key)
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("native blueprint workspace {label} is invalid"))
}

fn optional_array<'a>(
    object: &'a Map<String, Value>,
    key: &str,
    label: &str,
) -> anyhow::Result<&'a [Value]> {
    match object.get(key) {
        None | Some(Value::Null) => Ok(&[]),
        Some(Value::Array(values)) => Ok(values),
        _ => bail!("native blueprint workspace {label} is invalid"),
    }
}

fn required_text<'a>(
    object: &'a Map<String, Value>,
    key: &str,
    maximum_bytes: usize,
    label: &str,
) -> anyhow::Result<&'a str> {
    object
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| valid_opaque_text(value, maximum_bytes))
        .ok_or_else(|| anyhow!("native blueprint workspace {label} is invalid"))
}

fn optional_text<'a>(
    object: &'a Map<String, Value>,
    key: &str,
    maximum_bytes: usize,
    label: &str,
) -> anyhow::Result<Option<&'a str>> {
    match object.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) if valid_opaque_text(value, maximum_bytes) => Ok(Some(value)),
        _ => bail!("native blueprint workspace {label} is invalid"),
    }
}

fn safe_nonnegative_integer(value: Option<&Value>, label: &str) -> anyhow::Result<u64> {
    value
        .and_then(Value::as_u64)
        .filter(|value| *value <= MAX_JAVASCRIPT_SAFE_INTEGER)
        .ok_or_else(|| anyhow!("native blueprint workspace {label} is invalid"))
}

fn positive_integer(value: Option<&Value>, label: &str) -> anyhow::Result<u64> {
    safe_nonnegative_integer(value, label).and_then(|value| {
        if value == 0 {
            bail!("native blueprint workspace {label} is invalid")
        }
        Ok(value)
    })
}

fn finite_number(value: Option<&Value>, label: &str) -> anyhow::Result<f64> {
    value
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
        .ok_or_else(|| anyhow!("native blueprint workspace {label} is invalid"))
}

fn blueprint_revision(object: &Map<String, Value>) -> anyhow::Result<u64> {
    match object.get("revision") {
        None | Some(Value::Null) => Ok(1),
        value => positive_integer(value, "blueprint revision"),
    }
}

fn blueprint_rotation(object: &Map<String, Value>) -> anyhow::Result<u64> {
    let rotation = match object.get("rotation") {
        None | Some(Value::Null) => 0,
        value => safe_nonnegative_integer(value, "blueprint rotation")?,
    };
    if !matches!(rotation, 0 | 90 | 180 | 270) {
        bail!("native blueprint workspace blueprint rotation is invalid")
    }
    Ok(rotation)
}

fn blueprint_mirror(object: &Map<String, Value>) -> anyhow::Result<&str> {
    let mirror = match object.get("mirror") {
        None | Some(Value::Null) => "none",
        Some(Value::String(value)) => value.as_str(),
        _ => bail!("native blueprint workspace blueprint mirror is invalid"),
    };
    if !matches!(mirror, "none" | "horizontal") {
        bail!("native blueprint workspace blueprint mirror is invalid")
    }
    Ok(mirror)
}

fn blueprint_counts(object: &Map<String, Value>) -> anyhow::Result<(usize, usize, usize, usize)> {
    Ok((
        required_array(object, "entities", "blueprint entities")?.len(),
        required_array(object, "belts", "blueprint belts")?.len(),
        optional_array(object, "resourceAnchors", "blueprint resource anchors")?.len(),
        optional_array(object, "externalPorts", "blueprint external ports")?.len(),
    ))
}

fn detail_limit_exceeded(counts: (usize, usize, usize, usize)) -> bool {
    counts.0 > MAX_DETAIL_ENTITIES
        || counts.1 > MAX_DETAIL_BELTS
        || counts.2 > MAX_DETAIL_ANCHORS
        || counts.3 > MAX_DETAIL_PORTS
}

fn counts_value(counts: (usize, usize, usize, usize)) -> Value {
    json!({
        "entities": counts.0,
        "belts": counts.1,
        "resourceAnchors": counts.2,
        "externalPorts": counts.3,
    })
}

fn bounded_page_cursor(requested: usize, total_count: usize) -> usize {
    if total_count == 0 {
        0
    } else if requested < total_count {
        requested
    } else {
        (total_count - 1) / PAGE_ROWS * PAGE_ROWS
    }
}

fn validate_blueprint_directory(values: &[Value]) -> anyhow::Result<Vec<&Map<String, Value>>> {
    if values.len() > MAX_SOURCE_ROWS {
        bail!("native blueprint workspace library source limit is exceeded")
    }
    let mut ids = HashSet::with_capacity(values.len());
    let mut rows = Vec::with_capacity(values.len());
    for value in values {
        let object = required_object(value, "blueprint row")?;
        let id = required_text(object, "id", MAX_OPAQUE_ID_BYTES, "blueprint ID")?;
        if !ids.insert(id) {
            bail!("native blueprint workspace contains duplicate blueprint IDs")
        }
        required_text(object, "name", MAX_NAME_BYTES, "blueprint name")?;
        blueprint_revision(object)?;
        blueprint_rotation(object)?;
        blueprint_mirror(object)?;
        blueprint_counts(object)?;
        rows.push(object);
    }
    Ok(rows)
}

fn validate_version_directory(values: &[Value]) -> anyhow::Result<Vec<&Map<String, Value>>> {
    if values.len() > MAX_SOURCE_ROWS {
        bail!("native blueprint workspace version source limit is exceeded")
    }
    let mut ids = HashSet::with_capacity(values.len());
    let mut rows = Vec::with_capacity(values.len());
    for value in values {
        let object = required_object(value, "blueprint version row")?;
        let id = required_text(object, "id", MAX_OPAQUE_ID_BYTES, "blueprint version ID")?;
        if !ids.insert(id) {
            bail!("native blueprint workspace contains duplicate version IDs")
        }
        required_text(
            object,
            "blueprintId",
            MAX_OPAQUE_ID_BYTES,
            "blueprint version blueprint ID",
        )?;
        positive_integer(object.get("revision"), "blueprint version revision")?;
        let definition = object
            .get("definition")
            .ok_or_else(|| anyhow!("native blueprint workspace version definition is missing"))?;
        let definition = required_object(definition, "blueprint version definition")?;
        library_summary(definition)?;
        rows.push(object);
    }
    Ok(rows)
}

fn library_summary(object: &Map<String, Value>) -> anyhow::Result<Value> {
    let counts = blueprint_counts(object)?;
    Ok(json!({
        "id": required_text(object, "id", MAX_OPAQUE_ID_BYTES, "blueprint ID")?,
        "name": required_text(object, "name", MAX_NAME_BYTES, "blueprint name")?,
        "revision": blueprint_revision(object)?,
        "rotation": blueprint_rotation(object)?,
        "mirror": blueprint_mirror(object)?,
        "counts": counts_value(counts),
        "detailStatus": if detail_limit_exceeded(counts) { "truncated" } else { "candidate" },
    }))
}

fn normalized_offset(object: &Map<String, Value>, label: &str) -> anyhow::Result<Value> {
    let offset = object
        .get("offset")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("native blueprint workspace {label} offset is invalid"))?;
    Ok(json!({
        "x": finite_number(offset.get("x"), label)?,
        "y": finite_number(offset.get("y"), label)?,
    }))
}

fn expected_extractor_building_id(resource_id: &str) -> &'static str {
    match resource_id {
        "crude_oil" => "oil_extractor",
        "water" | "sulfuric_acid" => "water_pump",
        _ => "mining_machine",
    }
}

fn compact_detail(state: &CoreState, blueprint: &Map<String, Value>) -> anyhow::Result<Value> {
    let counts = blueprint_counts(blueprint)?;
    let summary = library_summary(blueprint)?;
    if detail_limit_exceeded(counts) {
        return Ok(json!({
            "summary": summary,
            "status": "truncated",
            "unsupportedReason": "detail-limits-exceeded",
            "entities": [],
            "belts": [],
            "resourceAnchors": [],
            "externalPorts": [],
        }));
    }

    let mut all_keys = HashSet::with_capacity(counts.0 + counts.2);
    let mut entity_keys = HashSet::with_capacity(counts.0);
    let mut entities = Vec::with_capacity(counts.0);
    let mut unsupported = false;
    for value in required_array(blueprint, "entities", "blueprint entities")? {
        let object = required_object(value, "blueprint entity")?;
        let key = required_text(object, "key", MAX_OPAQUE_ID_BYTES, "blueprint entity key")?;
        if !all_keys.insert(key) || !entity_keys.insert(key) {
            bail!("native blueprint workspace contains duplicate detail keys")
        }
        let building_id = required_text(
            object,
            "buildingId",
            MAX_OPAQUE_ID_BYTES,
            "blueprint building ID",
        )?;
        let building = state.catalog.buildings.get(building_id);
        if building.is_none() {
            unsupported = true;
        }
        let recipe_id = optional_text(
            object,
            "recipeId",
            MAX_OPAQUE_ID_BYTES,
            "blueprint recipe ID",
        )?;
        let recipe_supported = recipe_id.is_none_or(|recipe_id| {
            state
                .catalog
                .recipes
                .get(recipe_id)
                .is_some_and(|recipe| recipe.building_id == building_id)
        });
        if !recipe_supported {
            unsupported = true;
        }
        let operation_enabled = match object.get("operationEnabledOnDeploy") {
            None | Some(Value::Null) => None,
            Some(Value::Bool(value)) if building_id == "micro_black_hole_connector" => Some(*value),
            Some(Value::Bool(_)) => {
                unsupported = true;
                None
            }
            _ => bail!("native blueprint workspace operation intent is invalid"),
        };
        let machine_count = positive_integer(object.get("machineCount"), "machine count")?;
        if machine_count > MAX_BUILDING_STACK_COUNT {
            unsupported = true;
        }
        entities.push(json!({
            "key": key,
            "buildingId": building_id,
            "buildingLabel": building
                .map(|building| building.id.as_str())
                .unwrap_or(building_id),
            "offset": normalized_offset(object, "blueprint entity")?,
            "machineCount": machine_count,
            "recipeId": recipe_id,
            "operationEnabledOnDeploy": operation_enabled,
        }));
    }

    let mut anchors = Vec::with_capacity(counts.2);
    for value in optional_array(blueprint, "resourceAnchors", "blueprint resource anchors")? {
        let object = required_object(value, "blueprint resource anchor")?;
        let key = required_text(object, "key", MAX_OPAQUE_ID_BYTES, "resource anchor key")?;
        if !all_keys.insert(key) {
            bail!("native blueprint workspace contains duplicate detail keys")
        }
        let resource_id = required_text(
            object,
            "resourceId",
            MAX_OPAQUE_ID_BYTES,
            "resource anchor item ID",
        )?;
        let extractor_id = required_text(
            object,
            "extractorBuildingId",
            MAX_OPAQUE_ID_BYTES,
            "resource anchor extractor ID",
        )?;
        if !state.catalog.items.contains_key(resource_id)
            || !state.catalog.buildings.contains_key(extractor_id)
            || extractor_id != expected_extractor_building_id(resource_id)
        {
            unsupported = true;
        }
        let miner_count =
            positive_integer(object.get("minerCount"), "resource anchor miner count")?;
        if miner_count > MAX_BUILDING_STACK_COUNT {
            unsupported = true;
        }
        anchors.push(json!({
            "key": key,
            "resourceId": resource_id,
            "extractorBuildingId": extractor_id,
            "offset": normalized_offset(object, "resource anchor")?,
            "minerCount": miner_count,
        }));
    }

    let mut belt_keys = HashSet::with_capacity(counts.1);
    let mut belts = Vec::with_capacity(counts.1);
    for value in required_array(blueprint, "belts", "blueprint belts")? {
        let object = required_object(value, "blueprint belt")?;
        let key = required_text(object, "key", MAX_OPAQUE_ID_BYTES, "blueprint belt key")?;
        if !belt_keys.insert(key) {
            bail!("native blueprint workspace contains duplicate belt keys")
        }
        let source_key = required_text(
            object,
            "sourceKey",
            MAX_OPAQUE_ID_BYTES,
            "blueprint belt source key",
        )?;
        let target_key = required_text(
            object,
            "targetKey",
            MAX_OPAQUE_ID_BYTES,
            "blueprint belt target key",
        )?;
        if !all_keys.contains(source_key) || !all_keys.contains(target_key) {
            bail!("native blueprint workspace belt endpoint is invalid")
        }
        let item_id = required_text(
            object,
            "itemId",
            MAX_OPAQUE_ID_BYTES,
            "blueprint belt item ID",
        )?;
        if !state.catalog.items.contains_key(item_id) {
            unsupported = true;
        }
        let tier = positive_integer(object.get("tier"), "blueprint belt tier")?;
        if tier > u8::MAX as u64 || !state.catalog.belt_speeds.contains_key(&(tier as u8)) {
            unsupported = true;
        }
        let lanes = positive_integer(object.get("lanes"), "blueprint belt lanes")?;
        if lanes > MAX_BELT_LANES {
            unsupported = true;
        }
        belts.push(json!({
            "key": key,
            "sourceKey": source_key,
            "targetKey": target_key,
            "itemId": item_id,
            "lanes": lanes,
            "tier": tier,
        }));
    }

    let mut port_keys = HashSet::with_capacity(counts.3);
    let mut ports = Vec::with_capacity(counts.3);
    for value in optional_array(blueprint, "externalPorts", "blueprint external ports")? {
        let object = required_object(value, "blueprint external port")?;
        let key = required_text(object, "key", MAX_OPAQUE_ID_BYTES, "external port key")?;
        if !port_keys.insert(key) {
            bail!("native blueprint workspace contains duplicate external port keys")
        }
        let entity_key = required_text(
            object,
            "entityKey",
            MAX_OPAQUE_ID_BYTES,
            "external port entity key",
        )?;
        if !entity_keys.contains(entity_key) {
            bail!("native blueprint workspace external port entity is invalid")
        }
        let direction = required_text(object, "direction", 16, "external port direction")?;
        if !matches!(direction, "input" | "output") {
            bail!("native blueprint workspace external port direction is invalid")
        }
        let item_id = required_text(
            object,
            "itemId",
            MAX_OPAQUE_ID_BYTES,
            "external port item ID",
        )?;
        if !state.catalog.items.contains_key(item_id) {
            unsupported = true;
        }
        ports.push(json!({
            "key": key,
            "entityKey": entity_key,
            "direction": direction,
            "itemId": item_id,
            "offset": normalized_offset(object, "external port")?,
        }));
    }

    if unsupported {
        return Ok(json!({
            "summary": summary,
            "status": "unsupported",
            "unsupportedReason": "unproven-catalog-semantics",
            "entities": [],
            "belts": [],
            "resourceAnchors": [],
            "externalPorts": [],
        }));
    }
    Ok(json!({
        "summary": summary,
        "status": "supported",
        "unsupportedReason": Value::Null,
        "entities": entities,
        "belts": belts,
        "resourceAnchors": anchors,
        "externalPorts": ports,
    }))
}

fn truncate_detail_for_projection_byte_budget(value: &mut Value) -> anyhow::Result<bool> {
    let rows = value
        .get_mut("page")
        .and_then(Value::as_object_mut)
        .and_then(|page| page.get_mut("rows"))
        .and_then(Value::as_array_mut)
        .ok_or_else(|| anyhow!("native blueprint workspace detail page is invalid"))?;
    let Some(detail) = rows.first_mut() else {
        return Ok(false);
    };
    if detail.get("status").and_then(Value::as_str) != Some("supported") {
        return Ok(false);
    }
    let summary = detail
        .get("summary")
        .cloned()
        .ok_or_else(|| anyhow!("native blueprint workspace detail summary is invalid"))?;
    *detail = json!({
        "summary": summary,
        "status": "truncated",
        "unsupportedReason": "projection-byte-budget-exceeded",
        "entities": [],
        "belts": [],
        "resourceAnchors": [],
        "externalPorts": [],
    });
    Ok(true)
}

fn safe_record_total(value: Option<&Value>, label: &str) -> anyhow::Result<u64> {
    let Some(value) = value else {
        return Ok(0);
    };
    if value.is_null() {
        return Ok(0);
    }
    let object = value
        .as_object()
        .ok_or_else(|| anyhow!("native blueprint workspace {label} is invalid"))?;
    object.values().try_fold(0_u64, |total, amount| {
        let amount = safe_nonnegative_integer(Some(amount), label)?;
        total
            .checked_add(amount)
            .filter(|value| *value <= MAX_JAVASCRIPT_SAFE_INTEGER)
            .ok_or_else(|| anyhow!("native blueprint workspace {label} overflows"))
    })
}

fn safe_record_count(value: Option<&Value>, label: &str) -> anyhow::Result<usize> {
    let Some(value) = value else {
        return Ok(0);
    };
    if value.is_null() {
        return Ok(0);
    }
    let object = value
        .as_object()
        .ok_or_else(|| anyhow!("native blueprint workspace {label} is invalid"))?;
    for (key, value) in object {
        if !valid_opaque_text(key, MAX_OPAQUE_ID_BYTES)
            || !value
                .as_str()
                .is_some_and(|value| valid_opaque_text(value, MAX_OPAQUE_ID_BYTES))
        {
            bail!("native blueprint workspace {label} is invalid")
        }
    }
    Ok(object.len())
}

fn validate_queue_directory(values: &[Value]) -> anyhow::Result<Vec<&Map<String, Value>>> {
    if values.len() > MAX_SOURCE_ROWS {
        bail!("native blueprint workspace queue source limit is exceeded")
    }
    let mut ids = HashSet::with_capacity(values.len());
    let mut rows = Vec::with_capacity(values.len());
    for value in values {
        let object = required_object(value, "queue row")?;
        let id = required_text(object, "id", MAX_OPAQUE_ID_BYTES, "queue ID")?;
        if !ids.insert(id) {
            bail!("native blueprint workspace contains duplicate queue IDs")
        }
        required_text(
            object,
            "blueprintId",
            MAX_OPAQUE_ID_BYTES,
            "queue blueprint ID",
        )?;
        optional_text(
            object,
            "blueprintVersionId",
            MAX_OPAQUE_ID_BYTES,
            "queue blueprint version ID",
        )?;
        match object.get("blueprintRevision") {
            None | Some(Value::Null) => {}
            value => {
                positive_integer(value, "queue blueprint revision")?;
            }
        }
        required_text(
            object,
            "blueprintName",
            MAX_NAME_BYTES,
            "queue blueprint name",
        )?;
        required_text(object, "planetId", MAX_OPAQUE_ID_BYTES, "queue planet ID")?;
        let position = object
            .get("position")
            .and_then(Value::as_object)
            .ok_or_else(|| anyhow!("native blueprint workspace queue position is invalid"))?;
        finite_number(position.get("x"), "queue x position")?;
        finite_number(position.get("y"), "queue y position")?;
        blueprint_rotation(object)?;
        blueprint_mirror(object)?;
        let queued_at = finite_number(object.get("queuedAt"), "queue time")?;
        if queued_at < 0.0 {
            bail!("native blueprint workspace queue time is invalid")
        }
        match object.get("status") {
            None | Some(Value::Null) => {}
            Some(Value::String(value))
                if matches!(value.as_str(), "pending-materials" | "waiting-fleet") => {}
            _ => bail!("native blueprint workspace queue status is invalid"),
        }
        safe_record_total(object.get("reservedConstruction"), "reserved construction")?;
        safe_record_total(object.get("reservedFleet"), "reserved fleet")?;
        safe_record_count(object.get("placedEntityIdsByKey"), "placed entity map")?;
        rows.push(object);
    }
    Ok(rows)
}

fn queue_row(
    state: &CoreState,
    object: &Map<String, Value>,
    blueprints: &[&Map<String, Value>],
    versions: &[&Map<String, Value>],
) -> anyhow::Result<Value> {
    let blueprint_id = required_text(
        object,
        "blueprintId",
        MAX_OPAQUE_ID_BYTES,
        "queue blueprint ID",
    )?;
    let version_id = optional_text(
        object,
        "blueprintVersionId",
        MAX_OPAQUE_ID_BYTES,
        "queue blueprint version ID",
    )?;
    let resolved = version_id
        .and_then(|id| {
            versions
                .iter()
                .find(|version| version.get("id").and_then(Value::as_str) == Some(id))
                .and_then(|version| version.get("definition"))
                .and_then(Value::as_object)
        })
        .or_else(|| {
            blueprints
                .iter()
                .copied()
                .find(|blueprint| blueprint.get("id").and_then(Value::as_str) == Some(blueprint_id))
        });
    let counts = resolved.map(blueprint_counts).transpose()?;
    let semantic_status = if let Some(blueprint) = resolved {
        if detail_limit_exceeded(counts.expect("resolved blueprint has counts")) {
            "truncated"
        } else {
            match compact_detail(state, blueprint)?["status"].as_str() {
                Some("supported") => "catalog-backed",
                _ => "unsupported",
            }
        }
    } else {
        "unsupported"
    };
    let position = object
        .get("position")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("native blueprint workspace queue position is invalid"))?;
    let planet_id = required_text(object, "planetId", MAX_OPAQUE_ID_BYTES, "queue planet ID")?;
    let status = match object.get("status") {
        None | Some(Value::Null) => "pending-materials",
        Some(Value::String(value))
            if matches!(value.as_str(), "pending-materials" | "waiting-fleet") =>
        {
            value
        }
        _ => bail!("native blueprint workspace queue status is invalid"),
    };
    let queued_at = finite_number(object.get("queuedAt"), "queue time")?;
    if queued_at < 0.0 {
        bail!("native blueprint workspace queue time is invalid")
    }
    let revision = match object.get("blueprintRevision") {
        None | Some(Value::Null) => resolved.map(blueprint_revision).transpose()?.unwrap_or(1),
        value => positive_integer(value, "queue blueprint revision")?,
    };
    let placed_entity_count =
        safe_record_count(object.get("placedEntityIdsByKey"), "placed entity map")?;
    if let Some(counts) = counts {
        let maximum_placed = counts
            .0
            .checked_add(counts.2)
            .ok_or_else(|| anyhow!("native blueprint workspace placed entity count overflows"))?;
        if placed_entity_count > maximum_placed {
            bail!("native blueprint workspace placed entity count is invalid")
        }
    }
    Ok(json!({
        "id": required_text(object, "id", MAX_OPAQUE_ID_BYTES, "queue ID")?,
        "blueprintId": blueprint_id,
        "blueprintVersionId": version_id,
        "blueprintRevision": revision,
        "blueprintName": required_text(object, "blueprintName", MAX_NAME_BYTES, "queue blueprint name")?,
        "planetId": planet_id,
        "planetName": state.catalog.planets.iter().find(|planet| planet.id == planet_id).map(|planet| {
            if valid_opaque_text(&planet.name, MAX_NAME_BYTES) && !planet.name.is_empty() {
                planet.name.as_str()
            } else {
                planet.id.as_str()
            }
        }),
        "position": {
            "x": finite_number(position.get("x"), "queue x position")?,
            "y": finite_number(position.get("y"), "queue y position")?,
        },
        "rotation": blueprint_rotation(object)?,
        "mirror": blueprint_mirror(object)?,
        "queuedAt": queued_at,
        "status": status,
        "counts": counts.map(counts_value),
        "semanticStatus": semantic_status,
        "reservedConstructionTotal": safe_record_total(object.get("reservedConstruction"), "reserved construction")?,
        "reservedFleetTotal": safe_record_total(object.get("reservedFleet"), "reserved fleet")?,
        "placedEntityCount": placed_entity_count,
        "actionable": false,
    }))
}

impl CoreState {
    #[allow(clippy::too_many_arguments)]
    pub fn blueprint_workspace_projection(
        &self,
        expected_revision: u64,
        expected_registry_fingerprint: &str,
        section: &str,
        blueprint_id: Option<&str>,
        queue_entry_id: Option<&str>,
        cursor: usize,
        limit: usize,
    ) -> anyhow::Result<Value> {
        if expected_revision != self.revision
            || expected_registry_fingerprint != self.catalog.snapshot.registry_fingerprint
            || cursor > MAX_SOURCE_ROWS
            || limit != PAGE_ROWS
        {
            bail!("native blueprint workspace projection request is invalid")
        }
        let section = Section::parse(section)?;
        match section {
            Section::Detail => {
                if cursor != 0
                    || queue_entry_id.is_some()
                    || !blueprint_id
                        .is_some_and(|value| valid_opaque_text(value, MAX_OPAQUE_ID_BYTES))
                {
                    bail!("native blueprint workspace detail selector is invalid")
                }
            }
            Section::QueueMembership => {
                if cursor != 0
                    || blueprint_id.is_some()
                    || !queue_entry_id
                        .is_some_and(|value| valid_opaque_text(value, MAX_OPAQUE_ID_BYTES))
                {
                    bail!("native blueprint workspace queue membership selector is invalid")
                }
            }
            Section::Library | Section::Queue => {
                if blueprint_id.is_some() || queue_entry_id.is_some() {
                    bail!("native blueprint workspace selector is invalid")
                }
            }
        }

        let base = self.base_value();
        let blueprint_values = base
            .get("blueprints")
            .and_then(Value::as_array)
            .ok_or_else(|| anyhow!("native blueprint workspace library is invalid"))?;
        let version_values = base
            .get("blueprintVersions")
            .and_then(Value::as_array)
            .ok_or_else(|| anyhow!("native blueprint workspace versions are invalid"))?;
        let queue_values = base
            .get("constructionQueue")
            .and_then(Value::as_array)
            .ok_or_else(|| anyhow!("native blueprint workspace queue is invalid"))?;
        let blueprints = validate_blueprint_directory(blueprint_values)?;
        let versions = validate_version_directory(version_values)?;
        let queue = validate_queue_directory(queue_values)?;

        let (total_count, page_cursor, rows) = match section {
            Section::Library => {
                let page_cursor = bounded_page_cursor(cursor, blueprints.len());
                let rows = blueprints
                    .iter()
                    .skip(page_cursor)
                    .take(limit)
                    .map(|blueprint| library_summary(blueprint))
                    .collect::<anyhow::Result<Vec<_>>>()?;
                (blueprints.len(), page_cursor, rows)
            }
            Section::Detail => {
                let selected_id = blueprint_id.expect("detail selector checked above");
                let selected = blueprints.iter().copied().find(|blueprint| {
                    blueprint.get("id").and_then(Value::as_str) == Some(selected_id)
                });
                let rows = selected
                    .map(|blueprint| compact_detail(self, blueprint))
                    .transpose()?
                    .into_iter()
                    .collect::<Vec<_>>();
                (rows.len(), 0, rows)
            }
            Section::Queue => {
                let page_cursor = bounded_page_cursor(cursor, queue.len());
                let rows = queue
                    .iter()
                    .skip(page_cursor)
                    .take(limit)
                    .map(|entry| queue_row(self, entry, &blueprints, &versions))
                    .collect::<anyhow::Result<Vec<_>>>()?;
                (queue.len(), page_cursor, rows)
            }
            Section::QueueMembership => {
                let selected_id = queue_entry_id.expect("queue membership selector checked above");
                let rows = queue
                    .iter()
                    .filter(|entry| entry.get("id").and_then(Value::as_str) == Some(selected_id))
                    .map(|_| json!({ "id": selected_id }))
                    .collect::<Vec<_>>();
                (rows.len(), 0, rows)
            }
        };
        let consumed = page_cursor
            .checked_add(rows.len())
            .ok_or_else(|| anyhow!("native blueprint workspace cursor overflows"))?;
        let next_cursor = (consumed < total_count).then_some(consumed);
        let mut value = json!({
            "schemaVersion": 1,
            "projectionType": BLUEPRINT_WORKSPACE_PROJECTION,
            "source": "native-core",
            "revision": self.revision,
            "stateVersion": self.identity.state_version,
            "registryFingerprint": self.catalog.snapshot.registry_fingerprint,
            "readOnly": true,
            "request": {
                "expectedRevision": expected_revision,
                "expectedRegistryFingerprint": expected_registry_fingerprint,
                "section": section.as_str(),
                "blueprintId": blueprint_id,
                "queueEntryId": queue_entry_id,
                "cursor": cursor,
                "limit": limit,
            },
            "counts": {
                "library": blueprints.len(),
                "queue": queue.len(),
            },
            "page": {
                "cursor": page_cursor,
                "limit": limit,
                "totalCount": total_count,
                "rows": rows,
                "nextCursor": next_cursor,
                "truncated": next_cursor.is_some(),
            },
            "limits": {
                "pageRows": PAGE_ROWS,
                "sourceRows": MAX_SOURCE_ROWS,
                "detailEntities": MAX_DETAIL_ENTITIES,
                "detailBelts": MAX_DETAIL_BELTS,
                "detailResourceAnchors": MAX_DETAIL_ANCHORS,
                "detailExternalPorts": MAX_DETAIL_PORTS,
                "projectionBytes": MAX_PROJECTION_BYTES,
                "opaqueIdBytes": MAX_OPAQUE_ID_BYTES,
                "nameBytes": MAX_NAME_BYTES,
            },
        });
        if serde_json::to_vec(&value)?.len() > MAX_PROJECTION_BYTES
            && (section != Section::Detail
                || !truncate_detail_for_projection_byte_budget(&mut value)?
                || serde_json::to_vec(&value)?.len() > MAX_PROJECTION_BYTES)
        {
            bail!("native blueprint workspace projection exceeds the byte limit")
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

    const REGISTRY: &str = "blueprint-workspace-test";

    fn catalog() -> RuntimeCatalog {
        let snapshot: CatalogSnapshot = serde_json::from_value(json!({
            "protocolVersion": crate::CORE_PROTOCOL_VERSION,
            "registryFingerprint": REGISTRY,
            "planets": [
                { "id": "home", "name": "家园星", "systemId": "helios", "kind": "terrestrial", "orbitIndex": 1 }
            ],
            "items": [
                { "id": "iron_ore", "name": "铁矿", "kind": "solid" },
                { "id": "MOD/item-beta", "name": "模组物品", "kind": "solid" }
            ],
            "buildings": [
                { "id": "mining_machine", "kind": "machine", "speed": 1, "inputCapacity": 100, "outputCapacity": 100 },
                { "id": "arc_smelter", "kind": "machine", "speed": 1, "inputCapacity": 100, "outputCapacity": 100 },
                { "id": "MOD/machine-beta", "kind": "machine", "speed": 1, "inputCapacity": 100, "outputCapacity": 100 }
            ],
            "recipes": [
                { "id": "smelt_iron", "name": "冶炼", "buildingId": "arc_smelter", "duration": 1, "inputs": [{ "itemId": "iron_ore", "amount": 1 }], "outputs": [{ "itemId": "iron_ore", "amount": 1 }] }
            ],
            "constructions": [],
            "belts": [{ "tier": 1, "speed": 6 }],
            "technologies": []
        }))
        .unwrap();
        RuntimeCatalog::validate(snapshot, REGISTRY).unwrap()
    }

    fn blueprint(id: &str, building_id: &str) -> Value {
        json!({
            "id": id,
            "name": format!("蓝图 {id}"),
            "revision": 2,
            "entities": [{
                "key": "node-1",
                "buildingId": building_id,
                "offset": { "x": 1, "y": -2 },
                "machineCount": 3,
            }],
            "resourceAnchors": [],
            "belts": [],
            "externalPorts": [],
            "rotation": 90,
            "mirror": "horizontal",
            "unknownFutureField": { "mustNotLeak": true }
        })
    }

    fn fixed_width_id(prefix: &str, width: usize) -> String {
        assert!(width >= prefix.len());
        format!("{prefix}{}", "x".repeat(width - prefix.len()))
    }

    fn byte_budget_state(endpoint_width: usize) -> CoreState {
        let source_key = fixed_width_id("source-", endpoint_width);
        let target_key = fixed_width_id("target-", endpoint_width);
        let mut value = blueprint("byte-budget", "arc_smelter");
        value["entities"] = json!([
            {
                "key": source_key,
                "buildingId": "arc_smelter",
                "offset": { "x": 0, "y": 0 },
                "machineCount": 1
            },
            {
                "key": target_key,
                "buildingId": "arc_smelter",
                "offset": { "x": 1, "y": 0 },
                "machineCount": 1
            }
        ]);
        value["belts"] = Value::Array(
            (0..MAX_DETAIL_BELTS)
                .map(|index| {
                    json!({
                        "key": format!("belt-{index}"),
                        "sourceKey": source_key,
                        "targetKey": target_key,
                        "itemId": "iron_ore",
                        "lanes": 1,
                        "tier": 1
                    })
                })
                .collect(),
        );
        state(vec![value], Vec::new(), Vec::new())
    }

    fn state(blueprints: Vec<Value>, versions: Vec<Value>, queue: Vec<Value>) -> CoreState {
        let base = json!({
            "version": 47,
            "mode": "normal",
            "activePlanetId": "home",
            "elapsedSeconds": 10,
            "paused": false,
            "construction": {},
            "blueprints": blueprints,
            "blueprintVersions": versions,
            "constructionQueue": queue,
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

    fn project(
        state: &CoreState,
        section: &str,
        blueprint_id: Option<&str>,
        cursor: usize,
    ) -> Value {
        state
            .blueprint_workspace_projection(
                7,
                REGISTRY,
                section,
                blueprint_id,
                None,
                cursor,
                PAGE_ROWS,
            )
            .unwrap()
    }

    #[test]
    fn library_and_queue_pages_preserve_persisted_order_and_hash() {
        let mut blueprints = (0..35)
            .map(|index| blueprint(&format!("bp-{index:02}"), "arc_smelter"))
            .collect::<Vec<_>>();
        blueprints.swap(0, 34);
        let queue = vec![
            json!({
                "id": "queue-z", "blueprintId": "bp-00", "blueprintName": "后入先显",
                "planetId": "home", "position": { "x": 2, "y": 3 }, "rotation": 0,
                "mirror": "none", "queuedAt": 99, "status": "pending-materials"
            }),
            json!({
                "id": "queue-a", "blueprintId": "bp-01", "blueprintName": "旧时间仍后显",
                "planetId": "home", "position": { "x": 4, "y": 5 }, "rotation": 0,
                "mirror": "none", "queuedAt": 1, "status": "pending-materials"
            }),
        ];
        let state = state(blueprints, Vec::new(), queue);
        let before = state.summary().unwrap().canonical_sha256;
        let first = project(&state, "library", None, 0);
        assert_eq!(first["page"]["rows"][0]["id"], "bp-34");
        assert_eq!(first["page"]["nextCursor"], 32);
        let second = project(&state, "library", None, 32);
        assert_eq!(second["page"]["rows"][2]["id"], "bp-00");
        let clamped = project(&state, "library", None, MAX_SOURCE_ROWS);
        assert_eq!(clamped["request"]["cursor"], MAX_SOURCE_ROWS);
        assert_eq!(clamped["page"]["cursor"], 32);
        assert_eq!(clamped["page"]["rows"][2]["id"], "bp-00");
        let queue = project(&state, "queue", None, 0);
        assert_eq!(queue["page"]["rows"][0]["id"], "queue-z");
        assert_eq!(queue["page"]["rows"][1]["id"], "queue-a");
        assert_eq!(state.summary().unwrap().canonical_sha256, before);
    }

    #[test]
    fn detail_accepts_registry_backed_mod_strips_unknown_and_fails_closed_for_unknown_semantics() {
        let semantic_state = state(
            vec![
                blueprint("模组-β", "MOD/machine-beta"),
                blueprint("未知-γ", "missing/MOD-building"),
            ],
            Vec::new(),
            Vec::new(),
        );
        let supported = project(&semantic_state, "detail", Some("模组-β"), 0);
        assert_eq!(supported["page"]["rows"][0]["status"], "supported");
        assert_eq!(
            supported["page"]["rows"][0]["entities"][0]["buildingId"],
            "MOD/machine-beta"
        );
        assert!(supported.to_string().find("mustNotLeak").is_none());

        let unknown = project(&semantic_state, "detail", Some("未知-γ"), 0);
        assert_eq!(unknown["page"]["rows"][0]["status"], "unsupported");
        assert_eq!(unknown["page"]["rows"][0]["entities"], json!([]));

        let mut unproven_mod_anchor = blueprint("mod-anchor", "MOD/machine-beta");
        unproven_mod_anchor["resourceAnchors"] = json!([{
            "key": "mod-anchor-1",
            "resourceId": "MOD/item-beta",
            "extractorBuildingId": "MOD/machine-beta",
            "offset": { "x": 0, "y": 0 },
            "minerCount": 1
        }]);
        let mod_anchor_state = state(vec![unproven_mod_anchor], Vec::new(), Vec::new());
        let unsupported = project(&mod_anchor_state, "detail", Some("mod-anchor"), 0);
        assert_eq!(unsupported["page"]["rows"][0]["status"], "unsupported");
        assert_eq!(unsupported["page"]["rows"][0]["resourceAnchors"], json!([]));

        let mut proven_anchor = blueprint("builtin-anchor", "arc_smelter");
        proven_anchor["resourceAnchors"] = json!([{
            "key": "anchor-1",
            "resourceId": "iron_ore",
            "extractorBuildingId": "mining_machine",
            "offset": { "x": 0, "y": 0 },
            "minerCount": 1
        }]);
        let anchor_state = state(vec![proven_anchor], Vec::new(), Vec::new());
        let supported = project(&anchor_state, "detail", Some("builtin-anchor"), 0);
        assert_eq!(supported["page"]["rows"][0]["status"], "supported");
        assert_eq!(
            supported["page"]["rows"][0]["resourceAnchors"]
                .as_array()
                .unwrap()
                .len(),
            1
        );

        let mut impossible_stack = blueprint("impossible-stack", "arc_smelter");
        impossible_stack["entities"][0]["machineCount"] = json!(MAX_BUILDING_STACK_COUNT + 1);
        let impossible = state(vec![impossible_stack], Vec::new(), Vec::new());
        let unsupported = project(&impossible, "detail", Some("impossible-stack"), 0);
        assert_eq!(unsupported["page"]["rows"][0]["status"], "unsupported");
        assert_eq!(unsupported["page"]["rows"][0]["entities"], json!([]));
    }

    #[test]
    fn huge_detail_is_explicitly_truncated_and_malicious_directories_are_rejected() {
        let mut huge = blueprint("huge", "arc_smelter");
        huge["entities"] = Value::Array(
            (0..=MAX_DETAIL_ENTITIES)
                .map(|index| json!({ "notEvenParsed": index }))
                .collect(),
        );
        let huge_state = state(vec![huge], Vec::new(), Vec::new());
        let detail = project(&huge_state, "detail", Some("huge"), 0);
        assert_eq!(detail["page"]["rows"][0]["status"], "truncated");
        assert_eq!(detail["page"]["rows"][0]["entities"], json!([]));

        let mut cross_page_duplicate = (0..=PAGE_ROWS)
            .map(|index| blueprint(&format!("bp-{index}"), "arc_smelter"))
            .collect::<Vec<_>>();
        cross_page_duplicate[PAGE_ROWS]["id"] = json!("bp-0");
        let duplicate = state(cross_page_duplicate, Vec::new(), Vec::new());
        assert!(
            duplicate
                .blueprint_workspace_projection(7, REGISTRY, "library", None, None, 0, PAGE_ROWS)
                .is_err()
        );

        let malformed = state(
            vec![blueprint("bad\nID", "arc_smelter")],
            Vec::new(),
            Vec::new(),
        );
        assert!(
            malformed
                .blueprint_workspace_projection(7, REGISTRY, "library", None, None, 0, PAGE_ROWS)
                .is_err()
        );

        let mut malformed_off_page_queue = (0..=PAGE_ROWS)
            .map(|index| {
                json!({
                    "id": format!("queue-{index}"),
                    "blueprintId": "same",
                    "blueprintName": "安全摘要",
                    "planetId": "home",
                    "position": { "x": index, "y": 0 },
                    "rotation": 0,
                    "mirror": "none",
                    "queuedAt": index,
                    "status": "pending-materials"
                })
            })
            .collect::<Vec<_>>();
        malformed_off_page_queue[PAGE_ROWS]["position"] = json!({ "x": "not-finite", "y": 0 });
        let malformed_queue = state(
            vec![blueprint("same", "arc_smelter")],
            Vec::new(),
            malformed_off_page_queue,
        );
        assert!(
            malformed_queue
                .blueprint_workspace_projection(7, REGISTRY, "queue", None, None, 0, PAGE_ROWS)
                .is_err()
        );
    }

    #[test]
    fn off_page_selected_blueprint_remains_listable_and_reports_bounded_truncation() {
        let mut blueprints = (0..35)
            .map(|index| blueprint(&format!("bp-{index:02}"), "arc_smelter"))
            .collect::<Vec<_>>();
        blueprints[34]["entities"] = Value::Array(
            (0..=MAX_DETAIL_ENTITIES)
                .map(|index| json!({ "notParsedBeyondTheDetailLimit": index }))
                .collect(),
        );
        let state = state(blueprints, Vec::new(), Vec::new());
        let before = state.summary().unwrap().canonical_sha256;
        let first = project(&state, "library", None, 0);
        assert_eq!(first["page"]["nextCursor"], 32);
        let second = project(&state, "library", None, 32);
        assert_eq!(second["page"]["rows"][2]["id"], "bp-34");
        assert_eq!(second["page"]["rows"][2]["detailStatus"], "truncated");
        let detail = project(&state, "detail", Some("bp-34"), 0);
        assert_eq!(detail["page"]["rows"][0]["status"], "truncated");
        assert_eq!(detail["page"]["rows"][0]["entities"], json!([]));
        assert_eq!(state.summary().unwrap().canonical_sha256, before);
    }

    #[test]
    fn detail_projection_byte_budget_has_stable_close_and_just_over_sides() {
        let low = project(&byte_budget_state(16), "detail", Some("byte-budget"), 0);
        assert_eq!(low["page"]["rows"][0]["status"], "supported");
        let high = project(
            &byte_budget_state(MAX_OPAQUE_ID_BYTES),
            "detail",
            Some("byte-budget"),
            0,
        );
        assert_eq!(high["page"]["rows"][0]["status"], "truncated");

        let mut supported_width = 16;
        let mut truncated_width = MAX_OPAQUE_ID_BYTES;
        while truncated_width - supported_width > 1 {
            let candidate = (supported_width + truncated_width) / 2;
            let projected = project(
                &byte_budget_state(candidate),
                "detail",
                Some("byte-budget"),
                0,
            );
            if projected["page"]["rows"][0]["status"] == "truncated" {
                truncated_width = candidate;
            } else {
                supported_width = candidate;
            }
        }

        let close_state = byte_budget_state(supported_width);
        let close_hash = close_state.summary().unwrap().canonical_sha256;
        let close = project(&close_state, "detail", Some("byte-budget"), 0);
        let close_bytes = serde_json::to_vec(&close).unwrap().len();
        assert_eq!(close["page"]["rows"][0]["status"], "supported");
        assert!(close_bytes <= MAX_PROJECTION_BYTES);
        assert!(close_bytes > MAX_PROJECTION_BYTES - 8_192);
        assert_eq!(close_state.summary().unwrap().canonical_sha256, close_hash);

        let over_state = byte_budget_state(truncated_width);
        let over_hash = over_state.summary().unwrap().canonical_sha256;
        let over = project(&over_state, "detail", Some("byte-budget"), 0);
        assert_eq!(
            over["page"]["rows"][0]["summary"]["detailStatus"],
            "candidate"
        );
        assert_eq!(over["page"]["rows"][0]["status"], "truncated");
        assert_eq!(
            over["page"]["rows"][0]["unsupportedReason"],
            "projection-byte-budget-exceeded"
        );
        assert_eq!(over["page"]["rows"][0]["entities"], json!([]));
        assert_eq!(over["page"]["rows"][0]["belts"], json!([]));
        assert_eq!(over_state.summary().unwrap().canonical_sha256, over_hash);
    }

    #[test]
    fn queue_resolves_version_id_like_web_even_when_historical_ids_differ() {
        let live = blueprint("live-blueprint", "arc_smelter");
        let mut historical = blueprint("historical-definition-id", "MOD/machine-beta");
        historical["entities"].as_array_mut().unwrap().push(json!({
            "key": "node-2",
            "buildingId": "arc_smelter",
            "offset": { "x": 3, "y": 4 },
            "machineCount": 1
        }));
        let versions = vec![json!({
            "id": "version-by-id",
            "blueprintId": "historical-owner-id",
            "revision": 9,
            "definition": historical,
        })];
        let queue = vec![
            json!({
                "id": "queue-versioned",
                "blueprintId": "live-blueprint",
                "blueprintVersionId": "version-by-id",
                "blueprintRevision": 7,
                "blueprintName": "历史不可变版本",
                "planetId": "home",
                "position": { "x": 0, "y": 0 },
                "rotation": 0,
                "mirror": "none",
                "queuedAt": 3,
                "status": "pending-materials"
            }),
            json!({
                "id": "queue-versioned-fallback",
                "blueprintId": "live-blueprint",
                "blueprintVersionId": "version-by-id",
                "blueprintName": "旧存档按定义版本回退",
                "planetId": "home",
                "position": { "x": 1, "y": 1 },
                "rotation": 0,
                "mirror": "none",
                "queuedAt": 4,
                "status": "pending-materials"
            }),
        ];
        let state = state(vec![live], versions, queue);
        let projected = project(&state, "queue", None, 0);
        let row = &projected["page"]["rows"][0];
        assert_eq!(row["counts"]["entities"], 2);
        assert_eq!(row["semanticStatus"], "catalog-backed");
        assert_eq!(row["actionable"], false);
        assert_eq!(row["blueprintVersionId"], "version-by-id");
        assert_eq!(row["blueprintRevision"], 7);
        assert_eq!(projected["page"]["rows"][1]["blueprintRevision"], 2);
    }

    #[test]
    fn stale_identity_and_invalid_selectors_are_rejected_without_mutation() {
        let state = state(vec![blueprint("bp", "arc_smelter")], Vec::new(), Vec::new());
        let before = state.summary().unwrap().canonical_sha256;
        assert!(
            state
                .blueprint_workspace_projection(6, REGISTRY, "library", None, None, 0, PAGE_ROWS)
                .is_err()
        );
        assert!(
            state
                .blueprint_workspace_projection(7, "other", "library", None, None, 0, PAGE_ROWS)
                .is_err()
        );
        assert!(
            state
                .blueprint_workspace_projection(
                    7,
                    REGISTRY,
                    "library",
                    Some("bp"),
                    None,
                    0,
                    PAGE_ROWS,
                )
                .is_err()
        );
        assert!(
            state
                .blueprint_workspace_projection(
                    7,
                    REGISTRY,
                    "detail",
                    Some("bp"),
                    None,
                    1,
                    PAGE_ROWS,
                )
                .is_err()
        );
        assert!(
            state
                .blueprint_workspace_projection(
                    7,
                    REGISTRY,
                    "library",
                    None,
                    None,
                    MAX_SOURCE_ROWS + 1,
                    PAGE_ROWS,
                )
                .is_err()
        );
        assert_eq!(state.summary().unwrap().canonical_sha256, before);
    }

    #[test]
    fn queue_membership_scans_the_complete_validated_queue_at_one_revision() {
        let queue = (0..40)
            .map(|index| {
                json!({
                    "id": format!("queue-{index:02}"),
                    "blueprintId": "bp",
                    "blueprintName": "跨页订单",
                    "planetId": "home",
                    "position": { "x": index, "y": 0 },
                    "rotation": 0,
                    "mirror": "none",
                    "queuedAt": index,
                    "status": "pending-materials"
                })
            })
            .collect::<Vec<_>>();
        let state = state(vec![blueprint("bp", "arc_smelter")], Vec::new(), queue);

        let present = state
            .blueprint_workspace_projection(
                7,
                REGISTRY,
                "queue-membership",
                None,
                Some("queue-39"),
                0,
                PAGE_ROWS,
            )
            .unwrap();
        assert_eq!(present["revision"], 7);
        assert_eq!(present["request"]["queueEntryId"], "queue-39");
        assert_eq!(present["page"]["totalCount"], 1);
        assert_eq!(present["page"]["rows"], json!([{ "id": "queue-39" }]));

        let absent = state
            .blueprint_workspace_projection(
                7,
                REGISTRY,
                "queue-membership",
                None,
                Some("queue-missing"),
                0,
                PAGE_ROWS,
            )
            .unwrap();
        assert_eq!(absent["request"]["queueEntryId"], "queue-missing");
        assert_eq!(absent["page"]["totalCount"], 0);
        assert_eq!(absent["page"]["rows"], json!([]));
    }
}
