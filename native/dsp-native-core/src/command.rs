use anyhow::{anyhow, bail};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Arc;

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

#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
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

fn command_requires_production_history_rebuild(command: &SimulationCommandPatch) -> bool {
    command
        .top_level_changes
        .iter()
        .any(|change| match change.path.first() {
            Some(PathSegment::Key(key))
                if matches!(
                    key.as_str(),
                    "productionHistory" | "historyRecordedAt" | "elapsedSeconds"
                ) =>
            {
                true
            }
            Some(PathSegment::Key(key)) => !crate::state::is_known_base_checkpoint_key(key),
            // A root replacement or a non-object top-level path cannot prove
            // that the public history source remains byte-for-byte unchanged.
            None | Some(PathSegment::Index(_)) => true,
        })
}

fn top_level_change_is_projection_safe(change: &ValuePatch) -> bool {
    matches!(
        change.path.first(),
        Some(PathSegment::Key(key)) if matches!(
            key.as_str(),
            "paused"
                | "elapsedSeconds"
                | "lastSavedAt"
                | "totalProduced"
                | "productionHistory"
                | "metrics"
                | "planetMetrics"
                | "powerGridMetrics"
                | "canvasBookmarks"
                | "canvasRegions"
                | "planetViewports"
                | "timeWarp"
                | "idleSettlement"
        )
    )
}

fn entity_change_is_projection_safe(change: &ValuePatch) -> bool {
    matches!(
        change.path.first(),
        Some(PathSegment::Key(key)) if matches!(
            key.as_str(),
            "position"
                | "inputs"
                | "outputs"
                | "progress"
                | "routingCursor"
                | "utilization"
                | "productionRate"
                | "powerFactor"
                | "stationProgress"
                | "stationTrips"
                | "stationLastTransfer"
                | "stationDrones"
                | "stationVessels"
                | "stationWarpers"
                | "stationCongestion"
                | "stationDispatchCursor"
                | "stationLastSupplyPeerBySlot"
                | "stationRoutes"
                | "fuelRemainingMj"
                | "powerOutputKw"
                | "powerInputKw"
                | "storedEnergyMj"
                | "orbitalCargoProgress"
                | "orbitalCargoTotalUploaded"
                | "blackHolePorts"
                | "proliferatorBonusProgress"
        )
    )
}

fn belt_change_is_projection_safe(change: &ValuePatch) -> bool {
    matches!(
        change.path.first(),
        Some(PathSegment::Key(key)) if matches!(
            key.as_str(),
            "progress" | "totalTransferred" | "congestion" | "lastFlow" | "monitorEnabled"
        )
    )
}

impl SimulationCommandPatch {
    /// Derives the renderer invalidation receipt solely from a command that
    /// has already passed authoritative command validation. This makes the
    /// receipt reproducible after WAL/checkpoint/lease crash boundaries
    /// without trusting a renderer-provided dirty set.
    pub fn deterministic_apply_result(
        &self,
        previous_revision: u64,
        revision: u64,
    ) -> anyhow::Result<CommandApplyResult> {
        if revision
            != previous_revision
                .checked_add(1)
                .ok_or_else(|| anyhow!("native command change receipt revision is exhausted"))?
        {
            bail!("native command change receipt revision is not contiguous")
        }
        let mut changed_entity_ids = self
            .changed_entities
            .iter()
            .map(|record| record.id.clone())
            .chain(self.removed_entity_ids.iter().cloned())
            .collect::<Vec<_>>();
        for addition in &self.added_entities {
            changed_entity_ids.push(
                addition
                    .value
                    .get("id")
                    .and_then(Value::as_str)
                    .ok_or_else(|| anyhow!("native command added entity ID is missing"))?
                    .to_owned(),
            );
        }
        changed_entity_ids.sort_unstable();
        changed_entity_ids.dedup();

        let mut changed_belt_ids = self
            .changed_belts
            .iter()
            .map(|record| record.id.clone())
            .chain(self.removed_belt_ids.iter().cloned())
            .collect::<Vec<_>>();
        for addition in &self.added_belts {
            changed_belt_ids.push(
                addition
                    .value
                    .get("id")
                    .and_then(Value::as_str)
                    .ok_or_else(|| anyhow!("native command added belt ID is missing"))?
                    .to_owned(),
            );
        }
        changed_belt_ids.sort_unstable();
        changed_belt_ids.dedup();

        let topology_dirty = !self.added_entities.is_empty()
            || !self.removed_entity_ids.is_empty()
            || !self.added_belts.is_empty()
            || !self.removed_belt_ids.is_empty()
            || self
                .top_level_changes
                .iter()
                .any(|change| !top_level_change_is_projection_safe(change))
            || self.changed_entities.iter().any(|record| {
                record
                    .changes
                    .iter()
                    .any(|change| !entity_change_is_projection_safe(change))
            })
            || self.changed_belts.iter().any(|record| {
                record
                    .changes
                    .iter()
                    .any(|change| !belt_change_is_projection_safe(change))
            });

        Ok(CommandApplyResult {
            previous_revision,
            revision,
            changed_entity_ids,
            changed_belt_ids,
            topology_dirty,
        })
    }
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
        let rebuild_production_history = command_requires_production_history_rebuild(command);
        let mut next = self.clone();
        // `next` is already disposable on failure. Move its base map into the
        // patch value instead of retaining two complete copies during every
        // pause/edit command.
        let mut base = Value::Object(next.take_base_for_command());
        for change in &command.top_level_changes {
            apply_value_patch(&mut base, change)?;
        }
        let base = match base {
            Value::Object(base) => base,
            _ => bail!("native command replaced the GameState root"),
        };
        next.install_base_from_command(base, rebuild_production_history);

        for record in &command.changed_entities {
            let index = *next
                .entity_index
                .get(&record.id)
                .ok_or_else(|| anyhow!("native command entity is missing"))?;
            let mut value = next.parse_entity(index)?;
            apply_record_changes(&mut value, &record.changes)?;
            next.replace_entity_raw(index, Arc::<str>::from(serde_json::to_string(&value)?));
        }
        if !command.removed_entity_ids.is_empty() {
            let removed = command
                .removed_entity_ids
                .iter()
                .collect::<std::collections::HashSet<_>>();
            if removed.len() != command.removed_entity_ids.len() {
                bail!("native command repeats an entity removal")
            }
            if removed.iter().any(|id| !next.entity_index.contains_key(id)) {
                bail!("native command removes a missing entity")
            }
            next.entity_raw_mut_topology().retain(|raw| {
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
        }
        if !command.added_entities.is_empty() {
            let mut additions = command.added_entities.clone();
            additions.sort_by_key(|entry| entry.index);
            for addition in additions {
                if addition.index > next.entity_raw_mut_topology().len()
                    || !addition.value.is_object()
                {
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
                next.entity_raw_mut_topology().insert(
                    addition.index,
                    Arc::<str>::from(serde_json::to_string(&addition.value)?),
                );
            }
        }

        for record in &command.changed_belts {
            let index = *next
                .belt_index
                .get(&record.id)
                .ok_or_else(|| anyhow!("native command belt is missing"))?;
            let mut value = next.parse_belt(index)?;
            apply_record_changes(&mut value, &record.changes)?;
            next.replace_belt_raw(index, Arc::<str>::from(serde_json::to_string(&value)?));
        }
        if !command.removed_belt_ids.is_empty() {
            let removed = command
                .removed_belt_ids
                .iter()
                .collect::<std::collections::HashSet<_>>();
            if removed.len() != command.removed_belt_ids.len() {
                bail!("native command repeats a belt removal")
            }
            if removed.iter().any(|id| !next.belt_index.contains_key(id)) {
                bail!("native command removes a missing belt")
            }
            next.belt_raw_mut_topology().retain(|raw| {
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
        }
        if !command.added_belts.is_empty() {
            let mut additions = command.added_belts.clone();
            additions.sort_by_key(|entry| entry.index);
            for addition in additions {
                if addition.index > next.belt_raw_mut_topology().len()
                    || !addition.value.is_object()
                {
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
                next.belt_raw_mut_topology().insert(
                    addition.index,
                    Arc::<str>::from(serde_json::to_string(&addition.value)?),
                );
            }
        }
        next.revision += 1;
        let only_pause_changed = command.changed_entities.is_empty()
            && command.added_entities.is_empty()
            && command.removed_entity_ids.is_empty()
            && command.changed_belts.is_empty()
            && command.added_belts.is_empty()
            && command.removed_belt_ids.is_empty()
            && command.top_level_changes.iter().all(|change| {
                matches!(
                    change.path.first(),
                    Some(PathSegment::Key(key)) if key == "paused"
                )
            });
        // Top-level commands never change record IDs or topology. Rebuilding
        // all 80k entity and 155k belt indexes for a pause/resume toggle made
        // a tiny Windows command pay the full save-open parsing cost.
        let records_changed = !command.changed_entities.is_empty()
            || !command.added_entities.is_empty()
            || !command.removed_entity_ids.is_empty()
            || !command.changed_belts.is_empty()
            || !command.added_belts.is_empty()
            || !command.removed_belt_ids.is_empty();
        if records_changed {
            next.rebuild_indexes()?;
        }
        if !only_pause_changed {
            next.invalidate_factory_static_admission();
        }
        let previous_revision = self.revision;
        // Derive the deterministic receipt before publishing the candidate.
        // Even a malformed future command shape must therefore leave the
        // source state untouched if receipt construction fails.
        let result = command.deterministic_apply_result(previous_revision, next.revision)?;
        *self = next;
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn command_for_path(path: Vec<PathSegment>) -> SimulationCommandPatch {
        SimulationCommandPatch {
            protocol_version: crate::CORE_PROTOCOL_VERSION,
            base_revision: 1,
            top_level_changes: vec![ValuePatch {
                path,
                operation: "set".to_owned(),
                value: Some(Value::Null),
            }],
            changed_entities: Vec::new(),
            added_entities: Vec::new(),
            removed_entity_ids: Vec::new(),
            changed_belts: Vec::new(),
            added_belts: Vec::new(),
            removed_belt_ids: Vec::new(),
        }
    }

    #[test]
    fn production_history_cache_rebuild_classification_is_fail_closed() {
        for key in ["productionHistory", "historyRecordedAt", "elapsedSeconds"] {
            assert!(command_requires_production_history_rebuild(
                &command_for_path(vec![PathSegment::Key(key.to_owned())])
            ));
        }
        assert!(!command_requires_production_history_rebuild(
            &command_for_path(vec![PathSegment::Key("paused".to_owned())])
        ));
        assert!(!command_requires_production_history_rebuild(
            &command_for_path(vec![PathSegment::Key("metrics".to_owned())])
        ));
        assert!(command_requires_production_history_rebuild(
            &command_for_path(vec![PathSegment::Key("futureUnknownField".to_owned())])
        ));
        assert!(command_requires_production_history_rebuild(
            &command_for_path(Vec::new())
        ));
        assert!(command_requires_production_history_rebuild(
            &command_for_path(vec![PathSegment::Index(0)])
        ));
    }

    #[test]
    fn deterministic_change_receipt_is_sorted_deduplicated_and_topology_aware() {
        let paused = command_for_path(vec![PathSegment::Key("paused".to_owned())]);
        assert!(
            !paused
                .deterministic_apply_result(1, 2)
                .unwrap()
                .topology_dirty
        );
        let unknown = command_for_path(vec![PathSegment::Key("futureTopology".to_owned())]);
        assert!(
            unknown
                .deterministic_apply_result(1, 2)
                .unwrap()
                .topology_dirty
        );

        let mut command = command_for_path(Vec::new());
        command.top_level_changes.clear();
        command.changed_entities = vec![
            RecordPatch {
                id: "entity-z".to_owned(),
                changes: vec![ValuePatch {
                    path: vec![PathSegment::Key("position".to_owned())],
                    operation: "set".to_owned(),
                    value: Some(serde_json::json!({ "x": 1, "y": 2 })),
                }],
            },
            RecordPatch {
                id: "entity-a".to_owned(),
                changes: Vec::new(),
            },
            RecordPatch {
                id: "entity-z".to_owned(),
                changes: Vec::new(),
            },
        ];
        command.removed_entity_ids = vec!["entity-m".to_owned(), "entity-a".to_owned()];
        command.added_entities = vec![AddedRecord {
            index: 0,
            value: serde_json::json!({ "id": "entity-b" }),
        }];
        command.changed_belts = vec![RecordPatch {
            id: "belt-z".to_owned(),
            changes: vec![ValuePatch {
                path: vec![PathSegment::Key("monitorEnabled".to_owned())],
                operation: "set".to_owned(),
                value: Some(Value::Bool(true)),
            }],
        }];
        command.removed_belt_ids = vec!["belt-a".to_owned()];
        let result = command.deterministic_apply_result(1, 2).unwrap();
        assert_eq!(
            result.changed_entity_ids,
            ["entity-a", "entity-b", "entity-m", "entity-z"]
        );
        assert_eq!(result.changed_belt_ids, ["belt-a", "belt-z"]);
        assert!(result.topology_dirty);

        command.added_entities.clear();
        command.removed_entity_ids.clear();
        command.removed_belt_ids.clear();
        let safe = command.deterministic_apply_result(1, 2).unwrap();
        assert!(!safe.topology_dirty);
        command.changed_entities[0].changes[0].path = vec![PathSegment::Key("recipeId".to_owned())];
        assert!(
            command
                .deterministic_apply_result(1, 2)
                .unwrap()
                .topology_dirty
        );
        command.changed_entities[0].changes[0].path = vec![PathSegment::Key("position".to_owned())];
        command.changed_belts[0].changes[0].path = vec![PathSegment::Key("source".to_owned())];
        assert!(
            command
                .deterministic_apply_result(1, 2)
                .unwrap()
                .topology_dirty
        );
    }
}
