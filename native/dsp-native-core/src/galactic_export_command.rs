//! Durable semantic commands for galactic export management.
//!
//! Renderer and WAL records contain only a bounded intent. Rust re-derives
//! every material withdrawal, reserve, project counter, level reward and
//! activity mirror from the authoritative revision before atomically applying
//! the expanded patch.

use anyhow::{anyhow, bail};
use serde_json::{Map, Value};

use crate::{
    command::{
        EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT, PathSegment, RecordPatch, SimulationCommandPatch,
        create_expected_value_patches,
    },
    state::CoreState,
};

const EXPORT_ROOT: &str = "galacticExports";
const EXPORT_LEAF: &str = "intent";
const EXPORTER_ROOT: &str = "galacticExporter";
const EXPORTER_LEAF: &str = "pauseIntent";
const MAX_OPAQUE_ID_BYTES: usize = 512;
const MAX_PROJECT_ID_BYTES: usize = 160;
const MAX_EXPANDED_CHANGE_COUNT: usize = 65_536;
const MAX_JS_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const PROJECT_IDS: &[&str] = &[
    "universe_archive",
    "solar_sail_array",
    "carrier_rocket_fleet",
    "antimatter_exchange",
];

#[derive(Debug, Clone, PartialEq)]
enum GalacticExportIntent {
    SetAutoDispatch { enabled: bool },
    SetDispatchThrottle { throttle: f64 },
    SetProjectEnabled { project_id: String, enabled: bool },
    SetProjectPriority { project_id: String, priority: u64 },
    ManualDispatch { project_id: String, requested: u64 },
    SetExporterPaused { entity_id: String, paused: bool },
}

fn export_path(path: &[PathSegment]) -> bool {
    matches!(
        path,
        [PathSegment::Key(root), PathSegment::Key(leaf)]
            if root == EXPORT_ROOT && leaf == EXPORT_LEAF
    )
}

fn exporter_path(path: &[PathSegment]) -> bool {
    matches!(
        path,
        [PathSegment::Key(root), PathSegment::Key(leaf)]
            if root == EXPORTER_ROOT && leaf == EXPORTER_LEAF
    )
}

pub(crate) fn command_contains_intent(command: &SimulationCommandPatch) -> bool {
    command
        .top_level_changes
        .iter()
        .any(|change| export_path(&change.path))
        || command.changed_entities.iter().any(|record| {
            record
                .changes
                .iter()
                .any(|change| exporter_path(&change.path))
        })
}

pub(crate) fn validate_resume_marker(
    command: &SimulationCommandPatch,
) -> anyhow::Result<Option<String>> {
    Ok(match require_intent(command)? {
        GalacticExportIntent::SetExporterPaused { entity_id, .. } => Some(entity_id),
        _ => None,
    })
}

fn valid_opaque_id(value: &str, maximum_bytes: usize) -> bool {
    !value.is_empty() && value.len() <= maximum_bytes && !value.chars().any(char::is_control)
}

fn exact_object<'a>(
    value: Option<&'a Value>,
    keys: &[&str],
    label: &str,
) -> anyhow::Result<&'a Map<String, Value>> {
    let object = value
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("native galactic export {label} is invalid"))?;
    if object.len() != keys.len() || keys.iter().any(|key| !object.contains_key(*key)) {
        bail!("native galactic export {label} fields are invalid")
    }
    Ok(object)
}

fn project_id(value: Option<&Value>) -> anyhow::Result<String> {
    value
        .and_then(Value::as_str)
        .filter(|value| value.len() <= MAX_PROJECT_ID_BYTES && PROJECT_IDS.contains(value))
        .map(str::to_owned)
        .ok_or_else(|| anyhow!("native galactic export project is invalid"))
}

fn require_intent(command: &SimulationCommandPatch) -> anyhow::Result<GalacticExportIntent> {
    let top_level_marker = command
        .top_level_changes
        .iter()
        .filter(|change| export_path(&change.path))
        .collect::<Vec<_>>();
    let entity_markers = command
        .changed_entities
        .iter()
        .flat_map(|record| {
            record
                .changes
                .iter()
                .filter(|change| exporter_path(&change.path))
                .map(move |change| (record, change))
        })
        .collect::<Vec<_>>();
    if top_level_marker.len() + entity_markers.len() != 1
        || !command.added_entities.is_empty()
        || !command.removed_entity_ids.is_empty()
        || !command.changed_belts.is_empty()
        || !command.added_belts.is_empty()
        || !command.removed_belt_ids.is_empty()
    {
        bail!("native galactic export intent shape is invalid")
    }
    if let Some(change) = top_level_marker.first() {
        if command.top_level_changes.len() != 1
            || !command.changed_entities.is_empty()
            || change.operation != "set"
        {
            bail!("native galactic export top-level intent shape is invalid")
        }
        let marker = change
            .value
            .as_ref()
            .and_then(Value::as_object)
            .ok_or_else(|| anyhow!("native galactic export intent is invalid"))?;
        return match marker.get("type").and_then(Value::as_str) {
            Some("set-auto-dispatch") => {
                let marker = exact_object(
                    change.value.as_ref(),
                    &["type", "enabled"],
                    "automation intent",
                )?;
                Ok(GalacticExportIntent::SetAutoDispatch {
                    enabled: marker
                        .get("enabled")
                        .and_then(Value::as_bool)
                        .ok_or_else(|| {
                            anyhow!("native galactic export automation target is invalid")
                        })?,
                })
            }
            Some("set-dispatch-throttle") => {
                let marker = exact_object(
                    change.value.as_ref(),
                    &["type", "throttle"],
                    "throttle intent",
                )?;
                let throttle = marker
                    .get("throttle")
                    .and_then(Value::as_f64)
                    .filter(|value| matches!(*value, 0.25 | 0.5 | 1.0))
                    .ok_or_else(|| anyhow!("native galactic export throttle target is invalid"))?;
                Ok(GalacticExportIntent::SetDispatchThrottle { throttle })
            }
            Some("set-project-enabled") => {
                let marker = exact_object(
                    change.value.as_ref(),
                    &["type", "projectId", "enabled"],
                    "project switch intent",
                )?;
                Ok(GalacticExportIntent::SetProjectEnabled {
                    project_id: project_id(marker.get("projectId"))?,
                    enabled: marker
                        .get("enabled")
                        .and_then(Value::as_bool)
                        .ok_or_else(|| {
                            anyhow!("native galactic export project target is invalid")
                        })?,
                })
            }
            Some("set-project-priority") => {
                let marker = exact_object(
                    change.value.as_ref(),
                    &["type", "projectId", "priority"],
                    "project priority intent",
                )?;
                let priority = marker
                    .get("priority")
                    .and_then(Value::as_u64)
                    .filter(|value| matches!(*value, 1..=3))
                    .ok_or_else(|| anyhow!("native galactic export priority target is invalid"))?;
                Ok(GalacticExportIntent::SetProjectPriority {
                    project_id: project_id(marker.get("projectId"))?,
                    priority,
                })
            }
            Some("manual-dispatch") => {
                let marker = exact_object(
                    change.value.as_ref(),
                    &["type", "projectId", "requestedAmount"],
                    "manual dispatch intent",
                )?;
                let requested = marker
                    .get("requestedAmount")
                    .and_then(Value::as_str)
                    .filter(|value| !value.is_empty() && value.len() <= 16)
                    .and_then(|value| value.parse::<u64>().ok())
                    .filter(|value| *value > 0 && *value <= MAX_JS_SAFE_INTEGER)
                    .ok_or_else(|| anyhow!("native galactic export dispatch amount is invalid"))?;
                Ok(GalacticExportIntent::ManualDispatch {
                    project_id: project_id(marker.get("projectId"))?,
                    requested,
                })
            }
            _ => bail!("native galactic export intent type is invalid"),
        };
    }

    let (record, change) = entity_markers[0];
    if command.changed_entities.len() != 1
        || record.changes.len() != 1
        || !command.top_level_changes.is_empty()
        || change.operation != "set"
        || !valid_opaque_id(&record.id, MAX_OPAQUE_ID_BYTES)
    {
        bail!("native galactic exporter pause intent shape is invalid")
    }
    let marker = exact_object(change.value.as_ref(), &["paused"], "exporter pause intent")?;
    Ok(GalacticExportIntent::SetExporterPaused {
        entity_id: record.id.clone(),
        paused: marker
            .get("paused")
            .and_then(Value::as_bool)
            .ok_or_else(|| anyhow!("native galactic exporter pause target is invalid"))?,
    })
}

fn built_in_unlocked_endgame(state: &CoreState) -> anyhow::Result<&Map<String, Value>> {
    if state.catalog.snapshot.registry_fingerprint != EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT
        || state.identity.registry_fingerprint != EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT
    {
        bail!("native galactic export intents require the built-in catalog")
    }
    if crate::galactic_exports::admission_reason(state)?.is_some() {
        bail!("native galactic export state is unsupported")
    }
    let base = state.base_value();
    let unlocked = base
        .get("research")
        .and_then(Value::as_object)
        .and_then(|research| research.get("completedTechIds"))
        .and_then(Value::as_array)
        .is_some_and(|ids| ids.iter().any(|id| id.as_str() == Some("universe_matrix")));
    if !unlocked {
        bail!("native galactic export technology is locked")
    }
    base.get("endgame")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("native galactic endgame state is missing"))
}

fn require_legacy_mode(endgame: &Map<String, Value>) -> anyhow::Result<()> {
    if endgame.get("exportInputMode").and_then(Value::as_str) != Some("legacy-network") {
        bail!("native galactic export intent requires legacy network mode")
    }
    Ok(())
}

fn project<'a>(
    endgame: &'a Map<String, Value>,
    id: &str,
) -> anyhow::Result<&'a Map<String, Value>> {
    endgame
        .get("exportProjects")
        .and_then(Value::as_object)
        .and_then(|projects| projects.get(id))
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("native galactic export project is missing"))
}

fn validate_exporter(
    state: &CoreState,
    entity_id: &str,
    paused: bool,
) -> anyhow::Result<(usize, Value)> {
    let active_planet = state
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
        .ok_or_else(|| anyhow!("native galactic exporter active planet is invalid"))?;
    let index = *state
        .entity_index
        .get(entity_id)
        .ok_or_else(|| anyhow!("native galactic exporter is missing"))?;
    let value = state.parse_entity(index)?;
    let entity = value
        .as_object()
        .ok_or_else(|| anyhow!("native galactic exporter is invalid"))?;
    if entity.get("kind").and_then(Value::as_str) != Some("machine")
        || entity.get("planetId").and_then(Value::as_str) != Some(active_planet)
        || entity.get("buildingId").and_then(Value::as_str) != Some("galactic_material_exporter")
        || state
            .catalog
            .buildings
            .get("galactic_material_exporter")
            .is_none_or(|building| building.kind != "machine")
    {
        bail!("native galactic exporter target is outside the covered domain")
    }
    if entity.get("interactionLocked").and_then(Value::as_bool) != Some(false) {
        bail!("native galactic exporter target is locked or malformed")
    }
    let current = entity
        .get("galacticExporterPaused")
        .and_then(Value::as_bool)
        .ok_or_else(|| anyhow!("native galactic exporter pause state is invalid"))?;
    if current == paused {
        bail!("native galactic exporter pause target is unchanged")
    }
    Ok((index, value))
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
    let intent = require_intent(command)?;
    let endgame = built_in_unlocked_endgame(state)?;
    let before_base = Value::Object(state.base_value().clone());
    let mut candidate_base = before_base.clone();
    let mut changed_entities = Vec::new();

    match intent {
        GalacticExportIntent::SetAutoDispatch { enabled } => {
            require_legacy_mode(endgame)?;
            let current = endgame
                .get("autoDispatch")
                .and_then(Value::as_bool)
                .ok_or_else(|| anyhow!("native galactic export automation state is invalid"))?;
            if current == enabled {
                bail!("native galactic export automation target is unchanged")
            }
            candidate_base["endgame"]["autoDispatch"] = Value::from(enabled);
        }
        GalacticExportIntent::SetDispatchThrottle { throttle } => {
            require_legacy_mode(endgame)?;
            let current = endgame
                .get("dispatchThrottle")
                .and_then(Value::as_f64)
                .ok_or_else(|| anyhow!("native galactic export throttle state is invalid"))?;
            if current == throttle {
                bail!("native galactic export throttle target is unchanged")
            }
            candidate_base["endgame"]["dispatchThrottle"] = Value::from(throttle);
        }
        GalacticExportIntent::SetProjectEnabled {
            project_id,
            enabled,
        } => {
            require_legacy_mode(endgame)?;
            let current = project(endgame, &project_id)?
                .get("enabled")
                .and_then(Value::as_bool)
                .ok_or_else(|| anyhow!("native galactic export project switch is invalid"))?;
            if current == enabled {
                bail!("native galactic export project target is unchanged")
            }
            candidate_base["endgame"]["exportProjects"][&project_id]["enabled"] =
                Value::from(enabled);
        }
        GalacticExportIntent::SetProjectPriority {
            project_id,
            priority,
        } => {
            let current = project(endgame, &project_id)?
                .get("priority")
                .and_then(Value::as_u64)
                .ok_or_else(|| anyhow!("native galactic export project priority is invalid"))?;
            if current == priority {
                bail!("native galactic export priority target is unchanged")
            }
            candidate_base["endgame"]["exportProjects"][&project_id]["priority"] =
                Value::from(priority);
        }
        GalacticExportIntent::ManualDispatch {
            project_id,
            requested,
        } => {
            require_legacy_mode(endgame)?;
            let mut entities = (0..state.entities.ids.len())
                .map(|index| state.parse_entity(index))
                .collect::<anyhow::Result<Vec<_>>>()?;
            let before_entities = entities.clone();
            let candidate_base_object = candidate_base
                .as_object_mut()
                .expect("native command base clone is an object");
            let shipped = crate::galactic_exports::dispatch_manual(
                state,
                candidate_base_object,
                &mut entities,
                &project_id,
                requested,
            )?;
            if shipped == 0 {
                bail!("native galactic export has no material above its reserve")
            }
            for (index, (before, after)) in before_entities.iter().zip(&entities).enumerate() {
                if before == after {
                    continue;
                }
                let mut changes = Vec::new();
                create_expected_value_patches(before, after, Vec::new(), &mut changes);
                if !changes.is_empty() {
                    changed_entities.push(RecordPatch {
                        id: state.entities.ids[index].to_owned(),
                        changes,
                    });
                }
            }
        }
        GalacticExportIntent::SetExporterPaused { entity_id, paused } => {
            let (_index, before) = validate_exporter(state, &entity_id, paused)?;
            let mut after = before.clone();
            after["galacticExporterPaused"] = Value::from(paused);
            let mut changes = Vec::new();
            create_expected_value_patches(&before, &after, Vec::new(), &mut changes);
            changed_entities.push(RecordPatch {
                id: entity_id,
                changes,
            });
        }
    }

    let mut top_level_changes = Vec::new();
    create_expected_value_patches(
        &before_base,
        &candidate_base,
        Vec::new(),
        &mut top_level_changes,
    );
    let expanded_change_count = top_level_changes
        .len()
        .checked_add(
            changed_entities
                .iter()
                .map(|record| record.changes.len())
                .sum::<usize>(),
        )
        .ok_or_else(|| anyhow!("native galactic export change count overflows"))?;
    if expanded_change_count == 0 || expanded_change_count > MAX_EXPANDED_CHANGE_COUNT {
        bail!("native galactic export expanded change count is invalid")
    }
    Ok(SimulationCommandPatch {
        protocol_version: command.protocol_version,
        base_revision: command.base_revision,
        top_level_changes,
        changed_entities,
        added_entities: Vec::new(),
        removed_entity_ids: Vec::new(),
        changed_belts: Vec::new(),
        added_belts: Vec::new(),
        removed_belt_ids: Vec::new(),
    })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::{
        CoreCheckpointIdentity,
        catalog::{CatalogSnapshot, RuntimeCatalog},
        command::ValuePatch,
    };

    fn catalog(registry_fingerprint: &str) -> RuntimeCatalog {
        let snapshot: CatalogSnapshot = serde_json::from_value(json!({
            "protocolVersion": crate::CORE_PROTOCOL_VERSION,
            "registryFingerprint": registry_fingerprint,
            "planets": [
                { "id": "home", "systemId": "helios", "kind": "terrestrial", "orbitIndex": 1 },
                { "id": "away", "systemId": "helios", "kind": "terrestrial", "orbitIndex": 2 }
            ],
            "items": [
                { "id": "universe_matrix", "kind": "solid" },
                { "id": "solar_sail", "kind": "solid" },
                { "id": "small_carrier_rocket", "kind": "solid" },
                { "id": "antimatter_fuel_rod", "kind": "solid" }
            ],
            "buildings": [
                { "id": "storage_mk1", "kind": "storage", "speed": 1, "inputCapacity": 1000, "outputCapacity": 1000, "accepts": "any" },
                { "id": "galactic_material_exporter", "kind": "machine", "speed": 1, "inputCapacity": 1000000, "outputCapacity": 0, "accepts": "any" }
            ],
            "recipes": [], "constructions": [], "belts": [],
            "technologies": [{
                "id": "universe_matrix", "name": "Universe",
                "costs": [{ "itemId": "universe_matrix", "amount": 1 }],
                "prerequisites": [], "constructionRewards": []
            }]
        }))
        .unwrap();
        RuntimeCatalog::validate(snapshot, registry_fingerprint).unwrap()
    }

    fn project_rows() -> Value {
        json!({
            "universe_archive": { "id": "universe_archive", "enabled": false, "priority": 1, "level": 0, "delivered": 0, "totalDelivered": 0, "dispatchProgress": 0 },
            "solar_sail_array": { "id": "solar_sail_array", "enabled": false, "priority": 1, "level": 0, "delivered": 0, "totalDelivered": 0, "dispatchProgress": 0 },
            "carrier_rocket_fleet": { "id": "carrier_rocket_fleet", "enabled": false, "priority": 1, "level": 0, "delivered": 0, "totalDelivered": 0, "dispatchProgress": 0 },
            "antimatter_exchange": { "id": "antimatter_exchange", "enabled": false, "priority": 1, "level": 0, "delivered": 0, "totalDelivered": 0, "dispatchProgress": 0 }
        })
    }

    fn base() -> Map<String, Value> {
        json!({
            "version": 47,
            "mode": "normal",
            "activePlanetId": "home",
            "elapsedSeconds": 0,
            "paused": false,
            "tray": { "universe_matrix": 400 },
            "planetTrays": {
                "home": { "universe_matrix": 400 },
                "away": { "universe_matrix": 0 }
            },
            "research": { "completedTechIds": ["universe_matrix"], "selectedTechId": null, "progressByTech": {} },
            "endgame": {
                "activeInfiniteResearchId": null,
                "autoResearch": false,
                "autoDispatch": false,
                "dispatchThrottle": 1,
                "exportInputMode": "legacy-network",
                "exportProjects": project_rows(),
                "galacticCredits": 0,
                "galacticScore": 0,
                "totalExported": 0,
                "exportedLastMinute": 0,
                "exportWindowAmount": 0,
                "exportWindowStartedAt": 0,
                "infiniteResearch": { "galactic_logistics": { "level": 0, "progress": "0" } },
                "constructionActivity": {
                    "activityId": null,
                    "participantId": null,
                    "configRevision": null,
                    "startsAtMs": 0,
                    "endsAtMs": 0,
                    "serverTimeAnchorMs": 0,
                    "activityClockMs": 0,
                    "personalDelivered": { "universe_matrix": 0, "solar_sail": 0, "small_carrier_rocket": 0, "antimatter_fuel_rod": 0 },
                    "pendingBatches": {},
                    "nextBatchSequence": 0
                }
            },
            "totalProduced": {}
        })
        .as_object()
        .unwrap()
        .clone()
    }

    fn entity(id: &str, building_id: &str, outputs: Value) -> String {
        json!({
            "id": id,
            "kind": if building_id == "galactic_material_exporter" { "machine" } else { "storage" },
            "planetId": "home",
            "position": { "x": 1, "y": 2 },
            "interactionLocked": false,
            "buildingId": building_id,
            "powerGridId": "grid-a",
            "machineCount": 1,
            "minerCount": 0,
            "inputs": {},
            "outputs": outputs,
            "progress": 0,
            "routingCursor": 0,
            "utilization": 0,
            "productionRate": 0,
            "galacticExporterPaused": building_id == "galactic_material_exporter"
        })
        .to_string()
    }

    fn state_with_registry(registry_fingerprint: &str) -> CoreState {
        CoreState::from_public_v47_parts(
            CoreCheckpointIdentity {
                slot: "normal-main".to_owned(),
                generation: 1,
                root_hash: "a".repeat(64),
                revision: 7,
                state_version: 47,
                mode: "normal".to_owned(),
                registry_fingerprint: registry_fingerprint.to_owned(),
                base_primary_checksum: "12345678".to_owned(),
            },
            base(),
            vec![
                entity("stock", "storage_mk1", json!({ "universe_matrix": 500 })),
                entity("exporter", "galactic_material_exporter", json!({})),
            ],
            Vec::new(),
            catalog(registry_fingerprint),
        )
        .unwrap()
    }

    fn top_marker(revision: u64, value: Value) -> SimulationCommandPatch {
        SimulationCommandPatch {
            protocol_version: crate::CORE_PROTOCOL_VERSION,
            base_revision: revision,
            top_level_changes: vec![ValuePatch {
                path: vec![
                    PathSegment::Key(EXPORT_ROOT.to_owned()),
                    PathSegment::Key(EXPORT_LEAF.to_owned()),
                ],
                operation: "set".to_owned(),
                value: Some(value),
            }],
            changed_entities: Vec::new(),
            added_entities: Vec::new(),
            removed_entity_ids: Vec::new(),
            changed_belts: Vec::new(),
            added_belts: Vec::new(),
            removed_belt_ids: Vec::new(),
        }
    }

    fn pause_marker(revision: u64, paused: bool) -> SimulationCommandPatch {
        SimulationCommandPatch {
            protocol_version: crate::CORE_PROTOCOL_VERSION,
            base_revision: revision,
            top_level_changes: Vec::new(),
            changed_entities: vec![RecordPatch {
                id: "exporter".to_owned(),
                changes: vec![ValuePatch {
                    path: vec![
                        PathSegment::Key(EXPORTER_ROOT.to_owned()),
                        PathSegment::Key(EXPORTER_LEAF.to_owned()),
                    ],
                    operation: "set".to_owned(),
                    value: Some(json!({ "paused": paused })),
                }],
            }],
            added_entities: Vec::new(),
            removed_entity_ids: Vec::new(),
            changed_belts: Vec::new(),
            added_belts: Vec::new(),
            removed_belt_ids: Vec::new(),
        }
    }

    #[test]
    fn manual_dispatch_withdraws_only_stock_above_reserve_and_replays_semantics() {
        let mut state = state_with_registry(EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT);
        let source_hash = state.canonical_sha256().unwrap();
        let command = top_marker(
            state.revision,
            json!({
                "type": "manual-dispatch",
                "projectId": "universe_archive",
                "requestedAmount": "1000"
            }),
        );
        state.validate_player_authority_command(&command).unwrap();
        assert_eq!(state.canonical_sha256().unwrap(), source_hash);
        let expanded = expand_intent(&state, &command).unwrap();
        assert!(!expanded.top_level_changes.is_empty());
        assert_eq!(expanded.changed_entities.len(), 1);
        let receipt = state.apply_player_authority_command(&command).unwrap();
        assert_eq!(receipt.previous_revision, 7);
        assert_eq!(receipt.revision, 8);
        assert_eq!(
            state.base_value()["endgame"]["exportProjects"]["universe_archive"]["totalDelivered"],
            Value::from(780.0)
        );
        assert_eq!(
            state.base_value()["endgame"]["totalExported"],
            Value::from(780.0)
        );
        assert_eq!(
            state.base_value()["endgame"]["galacticCredits"],
            Value::from(9360.0)
        );
        assert_eq!(
            state.parse_entity(0).unwrap()["outputs"]["universe_matrix"],
            Value::from(0.0)
        );
        assert_eq!(
            state.base_value()["tray"]["universe_matrix"],
            Value::from(120.0)
        );
    }

    #[test]
    fn settings_and_exporter_pause_are_exact_typed_intents() {
        let mut state = state_with_registry(EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT);
        let automation = top_marker(
            state.revision,
            json!({ "type": "set-auto-dispatch", "enabled": true }),
        );
        state.apply_player_authority_command(&automation).unwrap();
        assert_eq!(state.base_value()["endgame"]["autoDispatch"], true);
        let priority = top_marker(
            state.revision,
            json!({ "type": "set-project-priority", "projectId": "solar_sail_array", "priority": 3 }),
        );
        state.apply_player_authority_command(&priority).unwrap();
        assert_eq!(
            state.base_value()["endgame"]["exportProjects"]["solar_sail_array"]["priority"],
            3
        );
        let pause = pause_marker(state.revision, false);
        state.apply_player_authority_command(&pause).unwrap();
        assert_eq!(
            state.parse_entity(1).unwrap()["galacticExporterPaused"],
            false
        );
        assert!(
            state
                .validate_player_authority_command(&pause_marker(state.revision, false))
                .is_err()
        );
    }

    #[test]
    fn malformed_locked_stale_and_mod_intents_fail_without_mutation() {
        let state = state_with_registry(EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT);
        let hash = state.canonical_sha256().unwrap();
        let mut extra = top_marker(
            state.revision,
            json!({ "type": "set-auto-dispatch", "enabled": true, "derivedInventory": 10 }),
        );
        assert!(state.validate_player_authority_command(&extra).is_err());
        extra.base_revision += 1;
        assert!(state.validate_player_authority_command(&extra).is_err());
        assert_eq!(state.canonical_sha256().unwrap(), hash);

        let mod_state = state_with_registry("mod-registry");
        let command = top_marker(
            mod_state.revision,
            json!({ "type": "set-project-enabled", "projectId": "universe_archive", "enabled": true }),
        );
        assert!(
            mod_state
                .validate_player_authority_command(&command)
                .is_err()
        );
    }
}
