//! Minimal, durable blueprint rename intent.
//!
//! The renderer sends only `{ kind, id, name }`. Rust validates the complete
//! public-v47 blueprint directory and expands the marker to the target row's
//! `name` and `revision` leaves. No blueprint body, version snapshot, queue,
//! inventory, entity, belt, or allocator field is renderer-derived.

use std::collections::HashSet;

use anyhow::{anyhow, bail};
use serde_json::{Map, Value};

use crate::{
    command::{PathSegment, SimulationCommandPatch, ValuePatch},
    state::CoreState,
};

const MAX_BLUEPRINT_ROWS: usize = 4_096;
const MAX_OPAQUE_ID_BYTES: usize = 512;
const MAX_EXISTING_NAME_BYTES: usize = 256;
const MAX_RENAME_UTF16_UNITS: usize = 32;
const MAX_JAVASCRIPT_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Debug, Clone, PartialEq, Eq)]
struct BlueprintRenameIntent {
    id: String,
    name: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ValidatedBlueprintRename {
    index: usize,
    name: String,
    revision: u64,
}

fn path_matches(path: &[PathSegment], expected: &[&str]) -> bool {
    path.len() == expected.len()
        && path.iter().zip(expected).all(
            |(segment, expected)| matches!(segment, PathSegment::Key(value) if value == expected),
        )
}

fn valid_opaque_text(value: &str, maximum_bytes: usize) -> bool {
    !value.is_empty() && value.len() <= maximum_bytes && !value.chars().any(char::is_control)
}

fn blueprint_edge_whitespace(value: char) -> bool {
    value.is_whitespace() || value == '\u{feff}'
}

fn canonical_blueprint_name(value: &str) -> Option<String> {
    let trimmed = value.trim_matches(blueprint_edge_whitespace);
    if trimmed.is_empty() || trimmed.chars().any(char::is_control) {
        return None;
    }
    let mut units = 0usize;
    let mut canonical = String::new();
    for character in trimmed.chars() {
        let next = units.checked_add(character.len_utf16())?;
        if next > MAX_RENAME_UTF16_UNITS {
            break;
        }
        units = next;
        canonical.push(character);
    }
    let canonical = canonical
        .trim_end_matches(blueprint_edge_whitespace)
        .to_owned();
    (!canonical.is_empty() && !canonical.chars().any(char::is_control)).then_some(canonical)
}

pub(crate) fn command_contains_intent(command: &SimulationCommandPatch) -> bool {
    command
        .top_level_changes
        .iter()
        .any(|change| path_matches(&change.path, &["blueprints", "intent"]))
}

fn require_intent(command: &SimulationCommandPatch) -> anyhow::Result<BlueprintRenameIntent> {
    if command.top_level_changes.len() != 1
        || !command.changed_entities.is_empty()
        || !command.added_entities.is_empty()
        || !command.removed_entity_ids.is_empty()
        || !command.changed_belts.is_empty()
        || !command.added_belts.is_empty()
        || !command.removed_belt_ids.is_empty()
    {
        bail!("native player-authority blueprint rename intent shape is invalid")
    }
    let change = &command.top_level_changes[0];
    if !path_matches(&change.path, &["blueprints", "intent"]) || change.operation != "set" {
        bail!("native player-authority blueprint rename intent path is invalid")
    }
    let intent = change
        .value
        .as_ref()
        .and_then(Value::as_object)
        .filter(|intent| {
            intent.len() == 3
                && intent.contains_key("kind")
                && intent.contains_key("id")
                && intent.contains_key("name")
        })
        .ok_or_else(|| anyhow!("native player-authority blueprint rename intent is invalid"))?;
    if intent.get("kind").and_then(Value::as_str) != Some("rename") {
        bail!("native player-authority blueprint rename kind is invalid")
    }
    let id = intent
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| valid_opaque_text(id, MAX_OPAQUE_ID_BYTES))
        .ok_or_else(|| anyhow!("native player-authority blueprint rename ID is invalid"))?;
    let name = intent
        .get("name")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("native player-authority blueprint rename name is invalid"))?;
    let canonical = canonical_blueprint_name(name)
        .filter(|canonical| canonical == name)
        .ok_or_else(|| anyhow!("native player-authority blueprint rename name is not canonical"))?;
    Ok(BlueprintRenameIntent {
        id: id.to_owned(),
        name: canonical,
    })
}

fn optional_array_shape(row: &Map<String, Value>, key: &str, label: &str) -> anyhow::Result<()> {
    match row.get(key) {
        None | Some(Value::Null) | Some(Value::Array(_)) => Ok(()),
        _ => bail!("native player-authority blueprint {label} is invalid"),
    }
}

fn blueprint_revision(row: &Map<String, Value>) -> anyhow::Result<u64> {
    match row.get("revision") {
        None | Some(Value::Null) => Ok(1),
        Some(value) => value
            .as_u64()
            .filter(|revision| *revision > 0 && *revision <= MAX_JAVASCRIPT_SAFE_INTEGER)
            .ok_or_else(|| anyhow!("native player-authority blueprint revision is invalid")),
    }
}

fn validate_blueprint_row(row: &Map<String, Value>) -> anyhow::Result<(&str, &str, u64)> {
    let id = row
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| valid_opaque_text(id, MAX_OPAQUE_ID_BYTES))
        .ok_or_else(|| anyhow!("native player-authority blueprint ID is invalid"))?;
    let name = row
        .get("name")
        .and_then(Value::as_str)
        .filter(|name| valid_opaque_text(name, MAX_EXISTING_NAME_BYTES))
        .ok_or_else(|| anyhow!("native player-authority blueprint name is invalid"))?;
    row.get("entities")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("native player-authority blueprint entities are invalid"))?;
    row.get("belts")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("native player-authority blueprint belts are invalid"))?;
    optional_array_shape(row, "resourceAnchors", "resource anchors")?;
    optional_array_shape(row, "externalPorts", "external ports")?;
    match row.get("rotation") {
        None | Some(Value::Null) => {}
        Some(value)
            if value
                .as_u64()
                .is_some_and(|rotation| matches!(rotation, 0 | 90 | 180 | 270)) => {}
        _ => bail!("native player-authority blueprint rotation is invalid"),
    }
    match row.get("mirror") {
        None | Some(Value::Null) => {}
        Some(Value::String(value)) if matches!(value.as_str(), "none" | "horizontal") => {}
        _ => bail!("native player-authority blueprint mirror is invalid"),
    }
    Ok((id, name, blueprint_revision(row)?))
}

fn validated_rename(
    state: &CoreState,
    command: &SimulationCommandPatch,
) -> anyhow::Result<ValidatedBlueprintRename> {
    let intent = require_intent(command)?;
    let blueprints = state
        .base_value()
        .get("blueprints")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("native player-authority blueprint directory is invalid"))?;
    if blueprints.len() > MAX_BLUEPRINT_ROWS {
        bail!("native player-authority blueprint directory source limit is exceeded")
    }
    let mut ids = HashSet::with_capacity(blueprints.len());
    let mut target = None;
    for (index, value) in blueprints.iter().enumerate() {
        let row = value
            .as_object()
            .ok_or_else(|| anyhow!("native player-authority blueprint row is invalid"))?;
        let (id, current_name, revision) = validate_blueprint_row(row)?;
        if !ids.insert(id) {
            bail!("native player-authority blueprint IDs are not unique")
        }
        if id == intent.id {
            if target.is_some() {
                bail!("native player-authority blueprint rename target is not unique")
            }
            if current_name == intent.name {
                bail!("native player-authority blueprint rename target is unchanged")
            }
            target = Some(ValidatedBlueprintRename {
                index,
                name: intent.name.clone(),
                revision: revision
                    .checked_add(1)
                    .filter(|value| *value <= MAX_JAVASCRIPT_SAFE_INTEGER)
                    .ok_or_else(|| {
                        anyhow!("native player-authority blueprint revision overflows")
                    })?,
            });
        }
    }
    target.ok_or_else(|| anyhow!("native player-authority blueprint rename target is missing"))
}

pub(crate) fn validate_command(
    state: &CoreState,
    command: &SimulationCommandPatch,
) -> anyhow::Result<()> {
    validated_rename(state, command).map(|_| ())
}

pub(crate) fn validate_resume_marker(command: &SimulationCommandPatch) -> anyhow::Result<()> {
    require_intent(command).map(|_| ())
}

pub(crate) fn expand_intent(
    state: &CoreState,
    command: &SimulationCommandPatch,
) -> anyhow::Result<SimulationCommandPatch> {
    let rename = validated_rename(state, command)?;
    Ok(SimulationCommandPatch {
        protocol_version: command.protocol_version,
        base_revision: command.base_revision,
        top_level_changes: vec![
            ValuePatch {
                path: vec![
                    PathSegment::Key("blueprints".to_owned()),
                    PathSegment::Index(rename.index),
                    PathSegment::Key("name".to_owned()),
                ],
                operation: "set".to_owned(),
                value: Some(Value::from(rename.name)),
            },
            ValuePatch {
                path: vec![
                    PathSegment::Key("blueprints".to_owned()),
                    PathSegment::Index(rename.index),
                    PathSegment::Key("revision".to_owned()),
                ],
                operation: "set".to_owned(),
                value: Some(Value::from(rename.revision)),
            },
        ],
        changed_entities: Vec::new(),
        added_entities: Vec::new(),
        removed_entity_ids: Vec::new(),
        changed_belts: Vec::new(),
        added_belts: Vec::new(),
        removed_belt_ids: Vec::new(),
    })
}
