use anyhow::{anyhow, bail};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::state::CoreState;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(untagged)]
pub enum PathSegment {
    Key(String),
    Index(usize),
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ValuePatch {
    pub path: Vec<PathSegment>,
    pub operation: String,
    #[serde(default)]
    pub value: Option<Value>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordPatch {
    pub id: String,
    pub changes: Vec<ValuePatch>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AddedRecord {
    pub index: usize,
    pub value: Value,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SimulationCommandPatch {
    pub protocol_version: u16,
    pub base_revision: u64,
    pub top_level_changes: Vec<ValuePatch>,
    pub changed_entities: Vec<RecordPatch>,
    pub added_entities: Vec<AddedRecord>,
    pub removed_entity_ids: Vec<String>,
    pub changed_belts: Vec<RecordPatch>,
    pub added_belts: Vec<AddedRecord>,
    pub removed_belt_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandApplyResult {
    pub previous_revision: u64,
    pub revision: u64,
    pub changed_entity_ids: Vec<String>,
    pub changed_belt_ids: Vec<String>,
    pub topology_dirty: bool,
}

fn container_at_mut<'a>(
    root: &'a mut Value,
    path: &[PathSegment],
) -> anyhow::Result<&'a mut Value> {
    let mut cursor = root;
    for segment in path {
        cursor = match segment {
            PathSegment::Key(key) => cursor
                .as_object_mut()
                .and_then(|object| object.get_mut(key))
                .ok_or_else(|| anyhow!("native command path key is missing"))?,
            PathSegment::Index(index) => cursor
                .as_array_mut()
                .and_then(|array| array.get_mut(*index))
                .ok_or_else(|| anyhow!("native command path index is missing"))?,
        };
    }
    Ok(cursor)
}

fn apply_value_patch(root: &mut Value, patch: &ValuePatch) -> anyhow::Result<()> {
    if patch.path.len() > 64 {
        bail!("native command patch path is too deep")
    }
    if patch.path.is_empty() {
        match patch.operation.as_str() {
            "set" => {
                *root = patch
                    .value
                    .clone()
                    .ok_or_else(|| anyhow!("native set patch has no value"))?
            }
            "delete" => bail!("native command cannot delete a record root"),
            _ => bail!("native command patch operation is invalid"),
        }
        return Ok(());
    }
    let (parent_path, leaf) = patch.path.split_at(patch.path.len() - 1);
    let parent = container_at_mut(root, parent_path)?;
    match (&leaf[0], patch.operation.as_str()) {
        (PathSegment::Key(key), "set") => {
            parent
                .as_object_mut()
                .ok_or_else(|| anyhow!("native command patch parent is not an object"))?
                .insert(
                    key.clone(),
                    patch
                        .value
                        .clone()
                        .ok_or_else(|| anyhow!("native set patch has no value"))?,
                );
        }
        (PathSegment::Key(key), "delete") => {
            parent
                .as_object_mut()
                .ok_or_else(|| anyhow!("native command patch parent is not an object"))?
                .remove(key);
        }
        (PathSegment::Index(index), "set") => {
            let target = parent
                .as_array_mut()
                .and_then(|array| array.get_mut(*index))
                .ok_or_else(|| anyhow!("native command patch array index is invalid"))?;
            *target = patch
                .value
                .clone()
                .ok_or_else(|| anyhow!("native set patch has no value"))?;
        }
        (PathSegment::Index(_), "delete") => {
            bail!("native command does not delete an array element by index")
        }
        (_, _) => bail!("native command patch operation is invalid"),
    }
    Ok(())
}

fn apply_record_changes(value: &mut Value, changes: &[ValuePatch]) -> anyhow::Result<()> {
    if changes.len() > 16_384 {
        bail!("native command contains too many record changes")
    }
    for change in changes {
        apply_value_patch(value, change)?;
    }
    Ok(())
}

impl CoreState {
    pub fn apply_command(
        &mut self,
        command: &SimulationCommandPatch,
    ) -> anyhow::Result<CommandApplyResult> {
        if command.protocol_version != crate::CORE_PROTOCOL_VERSION {
            bail!("native command protocol version is unsupported");
        }
        if command.base_revision != self.revision {
            bail!("native command base revision is not current");
        }
        let total = command.top_level_changes.len()
            + command.changed_entities.len()
            + command.added_entities.len()
            + command.removed_entity_ids.len()
            + command.changed_belts.len()
            + command.added_belts.len()
            + command.removed_belt_ids.len();
        if total == 0 || total > 65_536 {
            bail!("native command change count is invalid")
        }

        // Apply to a cloned transactional state. A malformed late patch can
        // never leave the authoritative candidate partially edited.
        let mut next = self.clone();
        let mut base = Value::Object(next.base_value_mut().clone());
        for change in &command.top_level_changes {
            apply_value_patch(&mut base, change)?;
        }
        *next.base_value_mut() = base
            .as_object()
            .cloned()
            .ok_or_else(|| anyhow!("native command replaced the GameState root"))?;

        let mut changed_entity_ids = Vec::new();
        for record in &command.changed_entities {
            let index = *next
                .entity_index
                .get(&record.id)
                .ok_or_else(|| anyhow!("native command entity is missing"))?;
            let mut value = next.parse_entity(index)?;
            apply_record_changes(&mut value, &record.changes)?;
            next.entity_raw_mut()[index] = serde_json::to_string(&value)?.into_boxed_str();
            changed_entity_ids.push(record.id.clone());
        }
        let mut topology_dirty = false;
        if !command.removed_entity_ids.is_empty() {
            let removed = command
                .removed_entity_ids
                .iter()
                .collect::<std::collections::HashSet<_>>();
            if removed.len() != command.removed_entity_ids.len() {
                bail!("native command repeats an entity removal")
            }
            if removed
                .iter()
                .any(|id| !next.entity_index.contains_key(*id))
            {
                bail!("native command removes a missing entity")
            }
            next.entity_raw_mut().retain(|raw| {
                serde_json::from_str::<Value>(raw)
                    .ok()
                    .and_then(|value| {
                        value
                            .get("id")
                            .and_then(Value::as_str)
                            .map(|id| !removed.contains(&id.to_owned()))
                    })
                    .unwrap_or(false)
            });
            topology_dirty = true;
        }
        if !command.added_entities.is_empty() {
            let mut additions = command.added_entities.clone();
            additions.sort_by_key(|entry| entry.index);
            for addition in additions {
                if addition.index > next.entity_raw_mut().len() || !addition.value.is_object() {
                    bail!("native command entity insertion is invalid")
                }
                let id = addition
                    .value
                    .get("id")
                    .and_then(Value::as_str)
                    .ok_or_else(|| anyhow!("native command added entity ID is missing"))?;
                if next.entity_index.contains_key(id) {
                    bail!("native command added entity ID already exists")
                }
                next.entity_raw_mut().insert(
                    addition.index,
                    serde_json::to_string(&addition.value)?.into_boxed_str(),
                );
                changed_entity_ids.push(id.to_owned());
            }
            topology_dirty = true;
        }

        let mut changed_belt_ids = Vec::new();
        for record in &command.changed_belts {
            let index = *next
                .belt_index
                .get(&record.id)
                .ok_or_else(|| anyhow!("native command belt is missing"))?;
            let mut value = next.parse_belt(index)?;
            apply_record_changes(&mut value, &record.changes)?;
            next.belt_raw_mut()[index] = serde_json::to_string(&value)?.into_boxed_str();
            changed_belt_ids.push(record.id.clone());
        }
        if !command.removed_belt_ids.is_empty() {
            let removed = command
                .removed_belt_ids
                .iter()
                .collect::<std::collections::HashSet<_>>();
            if removed.len() != command.removed_belt_ids.len() {
                bail!("native command repeats a belt removal")
            }
            if removed.iter().any(|id| !next.belt_index.contains_key(*id)) {
                bail!("native command removes a missing belt")
            }
            next.belt_raw_mut().retain(|raw| {
                serde_json::from_str::<Value>(raw)
                    .ok()
                    .and_then(|value| {
                        value
                            .get("id")
                            .and_then(Value::as_str)
                            .map(|id| !removed.contains(&id.to_owned()))
                    })
                    .unwrap_or(false)
            });
            topology_dirty = true;
        }
        if !command.added_belts.is_empty() {
            let mut additions = command.added_belts.clone();
            additions.sort_by_key(|entry| entry.index);
            for addition in additions {
                if addition.index > next.belt_raw_mut().len() || !addition.value.is_object() {
                    bail!("native command belt insertion is invalid")
                }
                let id = addition
                    .value
                    .get("id")
                    .and_then(Value::as_str)
                    .ok_or_else(|| anyhow!("native command added belt ID is missing"))?;
                if next.belt_index.contains_key(id) {
                    bail!("native command added belt ID already exists")
                }
                next.belt_raw_mut().insert(
                    addition.index,
                    serde_json::to_string(&addition.value)?.into_boxed_str(),
                );
                changed_belt_ids.push(id.to_owned());
            }
            topology_dirty = true;
        }
        next.revision += 1;
        next.rebuild_indexes()?;
        let previous_revision = self.revision;
        *self = next;
        Ok(CommandApplyResult {
            previous_revision,
            revision: self.revision,
            changed_entity_ids,
            changed_belt_ids,
            topology_dirty,
        })
    }
}
