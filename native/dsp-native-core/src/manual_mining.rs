use anyhow::{anyhow, bail};
use serde_json::Value;

use crate::{
    command::{PathSegment, RecordPatch, SimulationCommandPatch, ValuePatch},
    state::CoreState,
};

const MANUAL_MINE_INTENT_FIELD: &str = "manualMine";
const VEIN_DEPLETION_SCALE: u64 = 10;
const MIN_BUILDING_BUFFER_LIMIT: u64 = 1_000;
const MAX_BUILDING_BUFFER_LIMIT: u64 = 100_000_000;
const MAX_JAVASCRIPT_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const MAX_VEIN_UTILIZATION_LEVEL: u64 = 1_000;

#[derive(Debug)]
struct ManualMiningTransition {
    entity_id: String,
    resource_id: String,
    output_after: u64,
    manual_mined_after: u64,
    total_produced_after: u64,
    finite_reserve_after: Option<(u64, u64)>,
}

fn exact_intent_path(path: &[PathSegment]) -> bool {
    matches!(path, [PathSegment::Key(field)] if field == MANUAL_MINE_INTENT_FIELD)
}

pub(crate) fn command_contains_intent(command: &SimulationCommandPatch) -> bool {
    command.changed_entities.iter().any(|record| {
        record
            .changes
            .iter()
            .any(|change| exact_intent_path(&change.path))
    })
}

fn safe_counter(value: Option<&Value>, label: &str) -> anyhow::Result<u64> {
    value
        .and_then(Value::as_u64)
        .filter(|value| *value <= MAX_JAVASCRIPT_SAFE_INTEGER)
        .ok_or_else(|| anyhow!("native manual mining {label} is not a safe integer"))
}

fn optional_safe_counter(value: Option<&Value>, label: &str) -> anyhow::Result<u64> {
    match value {
        None | Some(Value::Null) => Ok(0),
        Some(value) => safe_counter(Some(value), label),
    }
}

fn checked_increment(value: u64, label: &str) -> anyhow::Result<u64> {
    value
        .checked_add(1)
        .filter(|value| *value <= MAX_JAVASCRIPT_SAFE_INTEGER)
        .ok_or_else(|| anyhow!("native manual mining {label} exceeds the safe integer limit"))
}

fn manual_output_capacity(
    state: &CoreState,
    entity: &serde_json::Map<String, Value>,
) -> anyhow::Result<u64> {
    let limit = state
        .base_value()
        .get("settings")
        .and_then(Value::as_object)
        .and_then(|settings| settings.get("productionBufferLimit"))
        .and_then(Value::as_u64)
        .filter(|limit| (MIN_BUILDING_BUFFER_LIMIT..=MAX_BUILDING_BUFFER_LIMIT).contains(limit))
        .ok_or_else(|| anyhow!("native manual mining production buffer limit is invalid"))?;
    let extractor_id = entity
        .get("extractorBuildingId")
        .and_then(Value::as_str)
        .unwrap_or("mining_machine");
    let extractor = state
        .catalog
        .buildings
        .get(extractor_id)
        .filter(|building| {
            building.kind == "miner"
                && building.output_capacity.is_finite()
                && building.output_capacity >= 0.0
        })
        .ok_or_else(|| anyhow!("native manual mining extractor catalog entry is invalid"))?;
    let miner_count = safe_counter(entity.get("minerCount"), "miner count")?.max(1);
    let base_capacity = extractor.output_capacity.floor();
    let rated = if base_capacity <= 0.0 {
        0
    } else if base_capacity >= limit as f64 {
        limit
    } else {
        let base_capacity = base_capacity as u64;
        if base_capacity > limit / miner_count {
            limit
        } else {
            (base_capacity * miner_count).min(limit)
        }
    };
    Ok(rated.max(60).min(limit))
}

fn vein_utilization_level(state: &CoreState) -> anyhow::Result<u64> {
    state
        .base_value()
        .get("endgame")
        .and_then(Value::as_object)
        .and_then(|endgame| endgame.get("infiniteResearch"))
        .and_then(Value::as_object)
        .and_then(|research| research.get("vein_utilization"))
        .and_then(Value::as_object)
        .and_then(|progress| progress.get("level"))
        .and_then(Value::as_u64)
        .filter(|level| *level <= MAX_VEIN_UTILIZATION_LEVEL)
        .ok_or_else(|| anyhow!("native manual mining vein-utilization technology level is invalid"))
}

fn derive_transition(
    state: &CoreState,
    command: &SimulationCommandPatch,
) -> anyhow::Result<ManualMiningTransition> {
    if command.changed_entities.len() != 1
        || command.changed_entities[0].changes.len() != 1
        || !command.top_level_changes.is_empty()
        || !command.added_entities.is_empty()
        || !command.removed_entity_ids.is_empty()
        || !command.changed_belts.is_empty()
        || !command.added_belts.is_empty()
        || !command.removed_belt_ids.is_empty()
    {
        bail!("native manual mining intent shape is invalid")
    }
    let record = &command.changed_entities[0];
    let intent = &record.changes[0];
    if !exact_intent_path(&intent.path)
        || intent.operation != "set"
        || intent.value.as_ref().and_then(Value::as_u64) != Some(1)
    {
        bail!("native manual mining intent is invalid")
    }

    let active_planet_id = state
        .base_value()
        .get("activePlanetId")
        .and_then(Value::as_str)
        .filter(|planet_id| {
            state
                .catalog
                .planets
                .iter()
                .any(|planet| planet.id == *planet_id)
        })
        .ok_or_else(|| anyhow!("native manual mining active planet is invalid"))?;
    let entity_index = *state
        .entity_index
        .get(&record.id)
        .ok_or_else(|| anyhow!("native manual mining vein is missing"))?;
    let entity = state.parse_entity(entity_index)?;
    let entity = entity
        .as_object()
        .ok_or_else(|| anyhow!("native manual mining vein is not an object"))?;
    if entity.get("kind").and_then(Value::as_str) != Some("vein")
        || entity.get("planetId").and_then(Value::as_str) != Some(active_planet_id)
    {
        bail!("native manual mining target is not an active-planet vein")
    }
    let resource_id = entity
        .get("resourceId")
        .and_then(Value::as_str)
        .filter(|resource_id| {
            state
                .catalog
                .items
                .get(*resource_id)
                .is_some_and(|item| item.kind == "solid")
        })
        .ok_or_else(|| anyhow!("native manual mining resource is not a solid catalog item"))?;
    let outputs = entity
        .get("outputs")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("native manual mining output inventory is invalid"))?;
    let current_output = optional_safe_counter(outputs.get(resource_id), "output inventory")?;
    let capacity = manual_output_capacity(state, entity)?;
    if current_output >= capacity {
        bail!("native manual mining output inventory is full")
    }

    let level = vein_utilization_level(state)?;
    let consumption_tenths = VEIN_DEPLETION_SCALE.saturating_sub(level.min(10));
    let resource_mode = state
        .base_value()
        .get("settings")
        .and_then(Value::as_object)
        .and_then(|settings| settings.get("resourceMode"))
        .and_then(Value::as_str)
        .filter(|mode| matches!(*mode, "finite" | "infinite"))
        .ok_or_else(|| anyhow!("native manual mining resource mode is invalid"))?;
    let finite_reserve_after = if resource_mode == "finite" && consumption_tenths > 0 {
        let remaining = safe_counter(entity.get("resourceRemaining"), "remaining reserve")?;
        let remainder = safe_counter(
            entity.get("resourceDepletionRemainder"),
            "depletion remainder",
        )?;
        if remainder >= VEIN_DEPLETION_SCALE {
            bail!("native manual mining depletion remainder is outside 0..9")
        }
        let available_tenths = u128::from(remaining)
            .saturating_mul(u128::from(VEIN_DEPLETION_SCALE))
            .saturating_sub(u128::from(remainder));
        if available_tenths < u128::from(consumption_tenths) {
            bail!("native manual mining finite reserve is exhausted")
        }
        let accrued = remainder + consumption_tenths;
        let depleted = accrued / VEIN_DEPLETION_SCALE;
        let remaining_after = remaining
            .checked_sub(depleted)
            .ok_or_else(|| anyhow!("native manual mining finite reserve underflowed"))?;
        Some((remaining_after, accrued % VEIN_DEPLETION_SCALE))
    } else {
        None
    };

    let manual_mined_after = checked_increment(
        safe_counter(
            state.base_value().get("manualMined"),
            "manual-mined counter",
        )?,
        "manual-mined counter",
    )?;
    let total_produced = state
        .base_value()
        .get("totalProduced")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("native manual mining total-produced inventory is invalid"))?;
    let total_produced_after = checked_increment(
        optional_safe_counter(total_produced.get(resource_id), "total-produced counter")?,
        "total-produced counter",
    )?;

    Ok(ManualMiningTransition {
        entity_id: record.id.clone(),
        resource_id: resource_id.to_owned(),
        output_after: checked_increment(current_output, "output inventory")?,
        manual_mined_after,
        total_produced_after,
        finite_reserve_after,
    })
}

pub(crate) fn validate_command(
    state: &CoreState,
    command: &SimulationCommandPatch,
) -> anyhow::Result<()> {
    derive_transition(state, command).map(|_| ())
}

pub(crate) fn expand_intent(
    state: &CoreState,
    command: &SimulationCommandPatch,
) -> anyhow::Result<SimulationCommandPatch> {
    let transition = derive_transition(state, command)?;
    let mut entity_changes = vec![ValuePatch {
        path: vec![
            PathSegment::Key("outputs".to_owned()),
            PathSegment::Key(transition.resource_id.clone()),
        ],
        operation: "set".to_owned(),
        value: Some(Value::from(transition.output_after)),
    }];
    if let Some((remaining, remainder)) = transition.finite_reserve_after {
        entity_changes.extend([
            ValuePatch {
                path: vec![PathSegment::Key("resourceRemaining".to_owned())],
                operation: "set".to_owned(),
                value: Some(Value::from(remaining)),
            },
            ValuePatch {
                path: vec![PathSegment::Key("resourceDepletionRemainder".to_owned())],
                operation: "set".to_owned(),
                value: Some(Value::from(remainder)),
            },
        ]);
    }
    Ok(SimulationCommandPatch {
        protocol_version: command.protocol_version,
        base_revision: command.base_revision,
        top_level_changes: vec![
            ValuePatch {
                path: vec![PathSegment::Key("manualMined".to_owned())],
                operation: "set".to_owned(),
                value: Some(Value::from(transition.manual_mined_after)),
            },
            ValuePatch {
                path: vec![
                    PathSegment::Key("totalProduced".to_owned()),
                    PathSegment::Key(transition.resource_id),
                ],
                operation: "set".to_owned(),
                value: Some(Value::from(transition.total_produced_after)),
            },
        ],
        changed_entities: vec![RecordPatch {
            id: transition.entity_id,
            changes: entity_changes,
        }],
        added_entities: Vec::new(),
        removed_entity_ids: Vec::new(),
        changed_belts: Vec::new(),
        added_belts: Vec::new(),
        removed_belt_ids: Vec::new(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        CoreCheckpointIdentity,
        catalog::{CatalogSnapshot, RuntimeCatalog},
    };

    const TEST_REGISTRY_FINGERPRINT: &str = "manual-mining-test";

    fn test_catalog() -> RuntimeCatalog {
        let snapshot: CatalogSnapshot = serde_json::from_value(serde_json::json!({
            "protocolVersion": crate::CORE_PROTOCOL_VERSION,
            "registryFingerprint": TEST_REGISTRY_FINGERPRINT,
            "planets": [
                { "id": "home", "systemId": "helios", "kind": "terrestrial", "orbitIndex": 1 },
                { "id": "away", "systemId": "helios", "kind": "terrestrial", "orbitIndex": 2 }
            ],
            "items": [
                { "id": "iron_ore", "kind": "solid" },
                { "id": "water", "kind": "fluid" }
            ],
            "buildings": [{
                "id": "mining_machine", "kind": "miner", "speed": 1,
                "inputCapacity": 0, "outputCapacity": 30
            }],
            "recipes": [],
            "constructions": [],
            "belts": [],
            "technologies": []
        }))
        .unwrap();
        RuntimeCatalog::validate(snapshot, TEST_REGISTRY_FINGERPRINT).unwrap()
    }

    fn vein_entity(
        id: &str,
        planet_id: &str,
        resource_id: &str,
        output: u64,
        remaining: u64,
        remainder: u64,
    ) -> String {
        let mut entity = serde_json::json!({
            "id": id,
            "kind": "vein",
            "planetId": planet_id,
            "position": { "x": 1, "y": 2 },
            "resourceId": resource_id,
            "extractorBuildingId": "mining_machine",
            "minerCount": 2,
            "outputs": {},
            "resourceRemaining": remaining,
            "resourceDepletionRemainder": remainder
        });
        entity["outputs"][resource_id] = Value::from(output);
        entity.to_string()
    }

    fn test_state(
        resource_mode: &str,
        vein_level: u64,
        output: u64,
        remaining: u64,
        remainder: u64,
    ) -> CoreState {
        let base = serde_json::json!({
            "version": 47,
            "mode": "normal",
            "activePlanetId": "home",
            "elapsedSeconds": 10,
            "paused": false,
            "settings": {
                "productionBufferLimit": 1_000,
                "resourceMode": resource_mode
            },
            "manualMined": 4,
            "totalProduced": { "iron_ore": 9 },
            "endgame": {
                "infiniteResearch": {
                    "vein_utilization": { "level": vein_level }
                }
            }
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
                registry_fingerprint: TEST_REGISTRY_FINGERPRINT.to_owned(),
                base_primary_checksum: "12345678".to_owned(),
            },
            base,
            vec![
                vein_entity(
                    "vein-home",
                    "home",
                    "iron_ore",
                    output,
                    remaining,
                    remainder,
                ),
                vein_entity("vein-away", "away", "iron_ore", 0, 100, 0),
                vein_entity("vein-water", "home", "water", 0, 100, 0),
            ],
            Vec::new(),
            test_catalog(),
        )
        .unwrap()
    }

    fn intent(revision: u64, entity_id: &str) -> SimulationCommandPatch {
        SimulationCommandPatch {
            protocol_version: crate::CORE_PROTOCOL_VERSION,
            base_revision: revision,
            top_level_changes: Vec::new(),
            changed_entities: vec![RecordPatch {
                id: entity_id.to_owned(),
                changes: vec![ValuePatch {
                    path: vec![PathSegment::Key(MANUAL_MINE_INTENT_FIELD.to_owned())],
                    operation: "set".to_owned(),
                    value: Some(Value::from(1)),
                }],
            }],
            added_entities: Vec::new(),
            removed_entity_ids: Vec::new(),
            changed_belts: Vec::new(),
            added_belts: Vec::new(),
            removed_belt_ids: Vec::new(),
        }
    }

    fn entity(state: &CoreState, id: &str) -> Value {
        state
            .parse_entity(*state.entity_index.get(id).unwrap())
            .unwrap()
    }

    fn assert_rejected_without_mutation(state: &mut CoreState, command: &SimulationCommandPatch) {
        let revision = state.revision;
        let source_hash = state.canonical_sha256().unwrap();
        assert!(state.apply_player_authority_command(command).is_err());
        assert_eq!(state.revision, revision);
        assert_eq!(state.canonical_sha256().unwrap(), source_hash);
    }

    #[test]
    fn finite_manual_mining_matches_the_javascript_tenths_formula_and_replay() {
        // Lv.1 consumes 9/10 of a unit per output. Starting at reserve 2 with
        // remainder 8 therefore ends at reserve 1 with remainder 7.
        let mut live = test_state("finite", 1, 59, 2, 8);
        let mut replay = live.clone();
        let command = intent(live.revision, "vein-home");

        let receipt = live.apply_player_authority_command(&command).unwrap();
        replay.apply_command(&command).unwrap();

        assert_eq!(receipt.previous_revision, 7);
        assert_eq!(receipt.revision, 8);
        assert_eq!(receipt.changed_entity_ids, ["vein-home"]);
        assert!(receipt.topology_dirty);
        assert_eq!(live.base_value()["manualMined"], 5);
        assert_eq!(live.base_value()["totalProduced"]["iron_ore"], 10);
        let vein = entity(&live, "vein-home");
        assert_eq!(vein["outputs"]["iron_ore"], 60);
        assert_eq!(vein["resourceRemaining"], 1);
        assert_eq!(vein["resourceDepletionRemainder"], 7);
        assert_eq!(
            live.canonical_sha256().unwrap(),
            replay.canonical_sha256().unwrap()
        );

        // This is the exact JS regression fixture: eleven Lv.1 manual outputs
        // consume nine whole reserve units and retain nine depletion tenths.
        let mut repeated = test_state("finite", 1, 0, 20, 0);
        for _ in 0..11 {
            let command = intent(repeated.revision, "vein-home");
            repeated.apply_player_authority_command(&command).unwrap();
        }
        let vein = entity(&repeated, "vein-home");
        assert_eq!(vein["outputs"]["iron_ore"], 11);
        assert_eq!(vein["resourceRemaining"], 11);
        assert_eq!(vein["resourceDepletionRemainder"], 9);
        assert_eq!(repeated.base_value()["manualMined"], 15);
        assert_eq!(repeated.base_value()["totalProduced"]["iron_ore"], 20);
    }

    #[test]
    fn infinite_mode_and_level_ten_preserve_the_finite_reserve_fields() {
        for (resource_mode, level) in [("infinite", 1), ("finite", 10)] {
            let mut state = test_state(resource_mode, level, 10, 2, 8);
            let command = intent(state.revision, "vein-home");
            state.apply_player_authority_command(&command).unwrap();

            let vein = entity(&state, "vein-home");
            assert_eq!(vein["outputs"]["iron_ore"], 11);
            assert_eq!(vein["resourceRemaining"], 2);
            assert_eq!(vein["resourceDepletionRemainder"], 8);
            assert_eq!(state.base_value()["manualMined"], 5);
            assert_eq!(state.base_value()["totalProduced"]["iron_ore"], 10);
        }
    }

    #[test]
    fn manual_mining_rejects_stale_wrong_planet_fluid_full_and_exhausted_intents() {
        let mut stale = test_state("finite", 1, 0, 100, 0);
        assert_rejected_without_mutation(&mut stale, &intent(6, "vein-home"));

        let mut off_planet = test_state("finite", 1, 0, 100, 0);
        let command = intent(off_planet.revision, "vein-away");
        assert_rejected_without_mutation(&mut off_planet, &command);

        let mut fluid = test_state("finite", 1, 0, 100, 0);
        let command = intent(fluid.revision, "vein-water");
        assert_rejected_without_mutation(&mut fluid, &command);

        let mut full = test_state("finite", 1, 60, 100, 0);
        let command = intent(full.revision, "vein-home");
        assert_rejected_without_mutation(&mut full, &command);

        let mut exhausted = test_state("finite", 1, 0, 0, 0);
        let command = intent(exhausted.revision, "vein-home");
        assert_rejected_without_mutation(&mut exhausted, &command);
    }

    #[test]
    fn manual_mining_rejects_mixed_or_malformed_intents_without_reserve_underflow() {
        let mut mixed = test_state("finite", 1, 0, 100, 0);
        let mut command = intent(mixed.revision, "vein-home");
        command.top_level_changes.push(ValuePatch {
            path: vec![PathSegment::Key("manualMined".to_owned())],
            operation: "set".to_owned(),
            value: Some(Value::from(99)),
        });
        assert_rejected_without_mutation(&mut mixed, &command);

        let mut invalid_remainder = test_state("finite", 1, 0, 0, 9);
        let command = intent(invalid_remainder.revision, "vein-home");
        assert_rejected_without_mutation(&mut invalid_remainder, &command);

        let mut invalid_technology = test_state("finite", 1_001, 0, 100, 0);
        let command = intent(invalid_technology.revision, "vein-home");
        assert_rejected_without_mutation(&mut invalid_technology, &command);

        let mut wrong_amount = test_state("finite", 1, 0, 100, 0);
        let mut command = intent(wrong_amount.revision, "vein-home");
        command.changed_entities[0].changes[0].value = Some(Value::from(2));
        assert_rejected_without_mutation(&mut wrong_amount, &command);
    }
}
