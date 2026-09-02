//! Durable lifecycle commands for solar-sail orbits.
//!
//! Orbit directories contain material-bearing counters. The renderer is never
//! allowed to replace those arrays directly: it sends a compact add/remove
//! marker and Rust validates, derives and aggregates the authoritative rows.

use std::collections::HashSet;

use anyhow::{anyhow, bail};
use serde_json::{Map, Number, Value, json};

use crate::{
    command::{PathSegment, SimulationCommandPatch, ValuePatch, technology_is_completed},
    dyson::sail_power,
    state::CoreState,
};

const INTENT_ROOT: &str = "dysonEngineering";
const INTENT_LEAF: &str = "intent";
const MAX_OPAQUE_ID_BYTES: usize = 1_024;
const MAX_LABEL_BYTES: usize = 4_096;
const MAX_ORBITS_PER_SYSTEM: usize = 8;
const MAX_JAVASCRIPT_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum DysonOrbitIntentKind {
    AddOrbit,
    RemoveOrbit,
}

#[derive(Debug)]
struct DysonOrbitIntent {
    kind: DysonOrbitIntentKind,
    system_id: String,
    orbit_id: Option<String>,
}

#[derive(Debug, Default)]
struct SwarmAggregate {
    sails_in_orbit: u64,
    total_launched: u64,
    total_expired: u64,
    decay_progress: f64,
    generation_kw: f64,
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

fn exact_object_keys(value: &Map<String, Value>, keys: &[&str]) -> bool {
    value.len() == keys.len() && keys.iter().all(|key| value.contains_key(*key))
}

fn require_intent(command: &SimulationCommandPatch) -> anyhow::Result<DysonOrbitIntent> {
    if command.top_level_changes.len() != 1
        || !command.changed_entities.is_empty()
        || !command.added_entities.is_empty()
        || !command.removed_entity_ids.is_empty()
        || !command.changed_belts.is_empty()
        || !command.added_belts.is_empty()
        || !command.removed_belt_ids.is_empty()
    {
        bail!("native player-authority Dyson orbit intent shape is invalid")
    }
    let change = &command.top_level_changes[0];
    if !exact_intent_path(&change.path) || change.operation != "set" {
        bail!("native player-authority Dyson orbit intent path is invalid")
    }
    let intent = change
        .value
        .as_ref()
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("native player-authority Dyson orbit intent is invalid"))?;
    let kind = match intent.get("kind").and_then(Value::as_str) {
        Some("add-orbit") => DysonOrbitIntentKind::AddOrbit,
        Some("remove-orbit") => DysonOrbitIntentKind::RemoveOrbit,
        _ => bail!("native player-authority Dyson orbit intent kind is invalid"),
    };
    let expected = match kind {
        DysonOrbitIntentKind::AddOrbit => &["kind", "systemId"][..],
        DysonOrbitIntentKind::RemoveOrbit => &["kind", "systemId", "orbitId"][..],
    };
    if !exact_object_keys(intent, expected) {
        bail!("native player-authority Dyson orbit intent fields are invalid")
    }
    let system_id = intent
        .get("systemId")
        .and_then(Value::as_str)
        .filter(|value| valid_opaque_id(value))
        .ok_or_else(|| anyhow!("native player-authority Dyson orbit system ID is invalid"))?;
    let orbit_id = if kind == DysonOrbitIntentKind::RemoveOrbit {
        Some(
            intent
                .get("orbitId")
                .and_then(Value::as_str)
                .filter(|value| valid_opaque_id(value))
                .ok_or_else(|| anyhow!("native player-authority Dyson orbit ID is invalid"))?
                .to_owned(),
        )
    } else {
        None
    };
    Ok(DysonOrbitIntent {
        kind,
        system_id: system_id.to_owned(),
        orbit_id,
    })
}

fn safe_integer(value: Option<&Value>, label: &str) -> anyhow::Result<u64> {
    let value = value
        .and_then(Value::as_f64)
        .filter(|value| {
            value.is_finite()
                && *value >= 0.0
                && *value <= MAX_JAVASCRIPT_SAFE_INTEGER as f64
                && value.fract() == 0.0
        })
        .ok_or_else(|| anyhow!("native player-authority Dyson orbit {label} is invalid"))?;
    Ok(value as u64)
}

fn finite_non_negative(value: Option<&Value>, label: &str) -> anyhow::Result<f64> {
    value
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite() && *value >= 0.0)
        .ok_or_else(|| anyhow!("native player-authority Dyson orbit {label} is invalid"))
}

fn checked_counter_add(target: &mut u64, value: u64, label: &str) -> anyhow::Result<()> {
    *target = target
        .checked_add(value)
        .filter(|value| *value <= MAX_JAVASCRIPT_SAFE_INTEGER)
        .ok_or_else(|| anyhow!("native player-authority Dyson orbit {label} overflows"))?;
    Ok(())
}

fn rounded(value: f64, digits: i32) -> f64 {
    let scale = 10_f64.powi(digits);
    (value * scale).round() / scale
}

fn validate_orbit(
    orbit: &Map<String, Value>,
    ids: &mut HashSet<String>,
    aggregate: &mut SwarmAggregate,
) -> anyhow::Result<()> {
    let id = orbit
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| valid_opaque_id(id))
        .ok_or_else(|| anyhow!("native player-authority Dyson orbit ID is invalid"))?;
    if !ids.insert(id.to_owned()) {
        bail!("native player-authority Dyson orbit ID is duplicated")
    }
    orbit
        .get("name")
        .and_then(Value::as_str)
        .filter(|name| name.len() <= MAX_LABEL_BYTES && !name.chars().any(char::is_control))
        .ok_or_else(|| anyhow!("native player-authority Dyson orbit name is invalid"))?;
    let radius = safe_integer(orbit.get("radius"), "radius")?;
    if !(5_000..=50_000).contains(&radius) {
        bail!("native player-authority Dyson orbit radius is outside its canonical range")
    }
    let inclination = orbit
        .get("inclination")
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite() && value.fract() == 0.0 && (-90.0..=90.0).contains(value))
        .ok_or_else(|| anyhow!("native player-authority Dyson orbit inclination is invalid"))?;
    let _ = inclination;
    orbit
        .get("longitude")
        .and_then(Value::as_f64)
        .filter(|value| {
            value.is_finite()
                && (0.0..360.0).contains(value)
                && (value * 10.0 - (value * 10.0).round()).abs() < 1e-9
        })
        .ok_or_else(|| anyhow!("native player-authority Dyson orbit longitude is invalid"))?;
    let sails = safe_integer(orbit.get("sailsInOrbit"), "sails")?;
    let launched = safe_integer(orbit.get("totalLaunched"), "launch total")?;
    let expired = safe_integer(orbit.get("totalExpired"), "expiry total")?;
    if launched < sails.saturating_add(expired) {
        bail!("native player-authority Dyson orbit material counters are inconsistent")
    }
    let progress = finite_non_negative(orbit.get("decayProgress"), "decay progress")?;
    if progress >= 1.0 + 0.0001 {
        bail!("native player-authority Dyson orbit decay progress is outside its canonical range")
    }
    let generation = finite_non_negative(orbit.get("generationKw"), "generation")?;
    checked_counter_add(&mut aggregate.sails_in_orbit, sails, "sail total")?;
    checked_counter_add(&mut aggregate.total_launched, launched, "launch total")?;
    checked_counter_add(&mut aggregate.total_expired, expired, "expiry total")?;
    aggregate.decay_progress += progress;
    aggregate.generation_kw += generation;
    if !aggregate.decay_progress.is_finite() || !aggregate.generation_kw.is_finite() {
        bail!("native player-authority Dyson orbit aggregate is non-finite")
    }
    Ok(())
}

fn validate_engineering(
    engineering: &Map<String, Value>,
    target_system_id: &str,
) -> anyhow::Result<SwarmAggregate> {
    let systems = engineering
        .get("orbitsBySystem")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("native player-authority Dyson orbit directory is invalid"))?;
    let active = engineering
        .get("activeOrbitBySystem")
        .and_then(Value::as_object)
        .ok_or_else(|| {
            anyhow!("native player-authority Dyson active orbit directory is invalid")
        })?;
    if !systems.contains_key(target_system_id) || !active.contains_key(target_system_id) {
        bail!("native player-authority Dyson target orbit directory is missing")
    }
    let mut ids = HashSet::new();
    let mut aggregate = SwarmAggregate::default();
    for (system_id, orbits) in systems {
        let orbits = orbits
            .as_array()
            .filter(|orbits| !orbits.is_empty() && orbits.len() <= MAX_ORBITS_PER_SYSTEM)
            .ok_or_else(|| {
                anyhow!("native player-authority Dyson orbit system directory is invalid")
            })?;
        for orbit in orbits {
            validate_orbit(
                orbit
                    .as_object()
                    .ok_or_else(|| anyhow!("native player-authority Dyson orbit row is invalid"))?,
                &mut ids,
                &mut aggregate,
            )?;
        }
        let active_id = active
            .get(system_id)
            .and_then(Value::as_str)
            .filter(|id| valid_opaque_id(id))
            .ok_or_else(|| anyhow!("native player-authority Dyson active orbit ID is invalid"))?;
        if !orbits
            .iter()
            .any(|orbit| orbit.get("id").and_then(Value::as_str) == Some(active_id))
        {
            bail!("native player-authority Dyson active orbit is missing")
        }
    }
    Ok(aggregate)
}

fn validate_swarm(swarm: &Map<String, Value>, aggregate: &SwarmAggregate) -> anyhow::Result<()> {
    if safe_integer(swarm.get("sailsInOrbit"), "global sails")? != aggregate.sails_in_orbit
        || safe_integer(swarm.get("totalLaunched"), "global launch total")?
            != aggregate.total_launched
        || safe_integer(swarm.get("totalExpired"), "global expiry total")?
            != aggregate.total_expired
        || (finite_non_negative(swarm.get("decayProgress"), "global decay progress")?
            - rounded(aggregate.decay_progress, 6))
        .abs()
            > 1e-6
        || (finite_non_negative(swarm.get("generationKw"), "global generation")?
            - aggregate.generation_kw.floor())
        .abs()
            > 1e-6
    {
        bail!("native player-authority Dyson global swarm aggregate is inconsistent")
    }
    Ok(())
}

fn value_number(value: f64) -> anyhow::Result<Value> {
    Number::from_f64(value)
        .map(Value::Number)
        .ok_or_else(|| anyhow!("native player-authority Dyson orbit produced a non-finite number"))
}

fn aggregate_engineering(engineering: &Map<String, Value>) -> anyhow::Result<SwarmAggregate> {
    let systems = engineering
        .get("orbitsBySystem")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("native player-authority Dyson orbit directory is invalid"))?;
    let mut aggregate = SwarmAggregate::default();
    for orbits in systems.values().filter_map(Value::as_array) {
        for orbit in orbits.iter().filter_map(Value::as_object) {
            checked_counter_add(
                &mut aggregate.sails_in_orbit,
                safe_integer(orbit.get("sailsInOrbit"), "sails")?,
                "sail total",
            )?;
            checked_counter_add(
                &mut aggregate.total_launched,
                safe_integer(orbit.get("totalLaunched"), "launch total")?,
                "launch total",
            )?;
            checked_counter_add(
                &mut aggregate.total_expired,
                safe_integer(orbit.get("totalExpired"), "expiry total")?,
                "expiry total",
            )?;
            aggregate.decay_progress +=
                finite_non_negative(orbit.get("decayProgress"), "decay progress")?;
            aggregate.generation_kw +=
                finite_non_negative(orbit.get("generationKw"), "generation")?;
        }
    }
    if !aggregate.decay_progress.is_finite() || !aggregate.generation_kw.is_finite() {
        bail!("native player-authority Dyson orbit aggregate is non-finite")
    }
    Ok(aggregate)
}

fn apply_swarm_aggregate(
    swarm: &mut Map<String, Value>,
    aggregate: &SwarmAggregate,
) -> anyhow::Result<()> {
    swarm.insert(
        "sailsInOrbit".to_owned(),
        Value::from(aggregate.sails_in_orbit),
    );
    swarm.insert(
        "totalLaunched".to_owned(),
        Value::from(aggregate.total_launched),
    );
    swarm.insert(
        "totalExpired".to_owned(),
        Value::from(aggregate.total_expired),
    );
    swarm.insert(
        "decayProgress".to_owned(),
        value_number(rounded(aggregate.decay_progress, 6))?,
    );
    swarm.insert(
        "generationKw".to_owned(),
        value_number(aggregate.generation_kw.floor())?,
    );
    Ok(())
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
    if !state
        .catalog
        .planets
        .iter()
        .any(|planet| planet.system_id == intent.system_id)
    {
        bail!("native player-authority Dyson orbit system is unknown")
    }
    let base = state.base_value();
    let unlocked = base
        .get("exploration")
        .and_then(Value::as_object)
        .and_then(|exploration| exploration.get("unlockedSystemIds"))
        .and_then(Value::as_array)
        .is_some_and(|systems| {
            systems
                .iter()
                .any(|system| system.as_str() == Some(&intent.system_id))
        });
    if !unlocked || !technology_is_completed(state, "dyson_swarm") {
        bail!("native player-authority Dyson orbit system or technology is locked")
    }
    let original_engineering = base
        .get("dysonEngineering")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("native player-authority Dyson engineering state is invalid"))?;
    let original_swarm = base
        .get("dysonSwarm")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("native player-authority Dyson swarm state is invalid"))?;
    let aggregate = validate_engineering(original_engineering, &intent.system_id)?;
    validate_swarm(original_swarm, &aggregate)?;

    let mut engineering = original_engineering.clone();
    let mut swarm = original_swarm.clone();
    let mut next_id = safe_integer(base.get("nextId"), "next ID")?;
    let original_next_id = next_id;
    let orbits = engineering
        .get_mut("orbitsBySystem")
        .and_then(Value::as_object_mut)
        .and_then(|systems| systems.get_mut(&intent.system_id))
        .and_then(Value::as_array_mut)
        .expect("Dyson target orbit directory was validated");

    let active_id = match intent.kind {
        DysonOrbitIntentKind::AddOrbit => {
            if orbits.len() >= MAX_ORBITS_PER_SYSTEM {
                bail!("native player-authority Dyson orbit limit is exceeded")
            }
            let following = next_id
                .checked_add(1)
                .filter(|value| *value <= MAX_JAVASCRIPT_SAFE_INTEGER)
                .ok_or_else(|| anyhow!("native player-authority Dyson orbit next ID overflows"))?;
            let id = format!("dyson_orbit_{next_id}");
            if original_engineering
                .get("orbitsBySystem")
                .and_then(Value::as_object)
                .into_iter()
                .flat_map(Map::values)
                .filter_map(Value::as_array)
                .flatten()
                .any(|orbit| orbit.get("id").and_then(Value::as_str) == Some(&id))
            {
                bail!("native player-authority Dyson generated orbit ID collides")
            }
            let index = orbits.len();
            let label = char::from(b'A' + index as u8);
            orbits.push(json!({
                "id": id,
                "name": format!("太阳帆轨道 {label}"),
                "radius": (12_000 + index * 6_000).min(50_000),
                "inclination": index * 12,
                "longitude": index * 45,
                "sailsInOrbit": 0,
                "totalLaunched": 0,
                "totalExpired": 0,
                "decayProgress": 0,
                "generationKw": 0,
            }));
            next_id = following;
            id
        }
        DysonOrbitIntentKind::RemoveOrbit => {
            if orbits.len() <= 1 {
                bail!("native player-authority Dyson system must retain one orbit")
            }
            let orbit_id = intent
                .orbit_id
                .as_deref()
                .expect("remove orbit intent has a validated orbit ID");
            let removed_index = orbits
                .iter()
                .position(|orbit| orbit.get("id").and_then(Value::as_str) == Some(orbit_id))
                .ok_or_else(|| anyhow!("native player-authority Dyson orbit target is missing"))?;
            let removed = orbits
                .get(removed_index)
                .and_then(Value::as_object)
                .cloned()
                .expect("Dyson orbit target was validated");
            let fallback_index = if removed_index == 0 { 1 } else { 0 };
            let fallback = orbits
                .get_mut(fallback_index)
                .and_then(Value::as_object_mut)
                .expect("Dyson fallback orbit was validated");
            for field in ["sailsInOrbit", "totalLaunched", "totalExpired"] {
                let merged = safe_integer(fallback.get(field), field)?
                    .checked_add(safe_integer(removed.get(field), field)?)
                    .filter(|value| *value <= MAX_JAVASCRIPT_SAFE_INTEGER)
                    .ok_or_else(|| {
                        anyhow!("native player-authority Dyson orbit merge overflows")
                    })?;
                fallback.insert(field.to_owned(), Value::from(merged));
            }
            let fallback_id = fallback
                .get("id")
                .and_then(Value::as_str)
                .expect("Dyson fallback orbit ID was validated")
                .to_owned();
            let sails = safe_integer(fallback.get("sailsInOrbit"), "sails")?;
            fallback.insert(
                "generationKw".to_owned(),
                value_number(sails as f64 * sail_power(base, &intent.system_id))?,
            );
            orbits.remove(removed_index);
            let current_active = engineering
                .get("activeOrbitBySystem")
                .and_then(Value::as_object)
                .and_then(|active| active.get(&intent.system_id))
                .and_then(Value::as_str)
                .expect("Dyson active orbit was validated");
            if current_active == orbit_id {
                fallback_id
            } else {
                current_active.to_owned()
            }
        }
    };
    engineering
        .get_mut("activeOrbitBySystem")
        .and_then(Value::as_object_mut)
        .expect("Dyson active orbit directory was validated")
        .insert(intent.system_id.clone(), Value::from(active_id));
    if intent.kind == DysonOrbitIntentKind::RemoveOrbit {
        let aggregate = aggregate_engineering(&engineering)?;
        apply_swarm_aggregate(&mut swarm, &aggregate)?;
    }

    let mut top_level_changes = vec![ValuePatch {
        path: vec![PathSegment::Key("dysonEngineering".to_owned())],
        operation: "set".to_owned(),
        value: Some(Value::Object(engineering)),
    }];
    if intent.kind == DysonOrbitIntentKind::RemoveOrbit {
        top_level_changes.push(ValuePatch {
            path: vec![PathSegment::Key("dysonSwarm".to_owned())],
            operation: "set".to_owned(),
            value: Some(Value::Object(swarm)),
        });
    }
    if next_id != original_next_id {
        top_level_changes.push(ValuePatch {
            path: vec![PathSegment::Key("nextId".to_owned())],
            operation: "set".to_owned(),
            value: Some(Value::from(next_id)),
        });
    }
    Ok(SimulationCommandPatch {
        protocol_version: command.protocol_version,
        base_revision: command.base_revision,
        top_level_changes,
        changed_entities: Vec::new(),
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
        command::EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT,
    };

    fn catalog() -> RuntimeCatalog {
        let snapshot: CatalogSnapshot = serde_json::from_value(json!({
            "protocolVersion": crate::CORE_PROTOCOL_VERSION,
            "registryFingerprint": EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT,
            "planets": [
                { "id": "home", "systemId": "helios", "kind": "terrestrial", "orbitIndex": 1 }
            ],
            "items": [{ "id": "universe_matrix", "kind": "matrix" }],
            "buildings": [],
            "recipes": [],
            "constructions": [],
            "belts": [],
            "technologies": [{
                "id": "dyson_swarm",
                "costs": [{ "itemId": "universe_matrix", "amount": 1 }],
                "prerequisites": []
            }]
        }))
        .unwrap();
        RuntimeCatalog::validate(snapshot, EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT).unwrap()
    }

    fn state() -> CoreState {
        let base = json!({
            "version": 47,
            "mode": "normal",
            "activePlanetId": "home",
            "elapsedSeconds": 10,
            "paused": false,
            "nextId": 100,
            "research": { "completedTechIds": ["dyson_swarm"] },
            "exploration": { "unlockedSystemIds": ["helios"] },
            "dysonEngineering": {
                "launchMode": "balanced",
                "launchThrottle": 1,
                "launchEnabled": true,
                "activeOrbitBySystem": { "helios": "orbit-a" },
                "orbitsBySystem": {
                    "helios": [
                        {
                            "id": "orbit-a",
                            "name": "A",
                            "radius": 12000,
                            "inclination": 0,
                            "longitude": 0,
                            "sailsInOrbit": 100,
                            "totalLaunched": 180,
                            "totalExpired": 50,
                            "decayProgress": 0.5,
                            "generationKw": 8800
                        },
                        {
                            "id": "orbit-b",
                            "name": "B",
                            "radius": 18000,
                            "inclination": 12,
                            "longitude": 45,
                            "sailsInOrbit": 20,
                            "totalLaunched": 40,
                            "totalExpired": 5,
                            "decayProgress": 0.25,
                            "generationKw": 1760
                        }
                    ]
                },
                "absorptionProgressBySystem": { "helios": 0 },
                "launchEnergySpentMj": 0
            },
            "dysonSwarm": {
                "sailsInOrbit": 120,
                "totalLaunched": 220,
                "totalExpired": 55,
                "decayProgress": 0.75,
                "generationKw": 10560,
                "receiverLoadKw": 123
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
                registry_fingerprint: EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT.to_owned(),
                base_primary_checksum: "12345678".to_owned(),
            },
            base,
            Vec::new(),
            Vec::new(),
            catalog(),
        )
        .unwrap()
    }

    fn intent(revision: u64, value: Value) -> SimulationCommandPatch {
        SimulationCommandPatch {
            protocol_version: crate::CORE_PROTOCOL_VERSION,
            base_revision: revision,
            top_level_changes: vec![ValuePatch {
                path: vec![
                    PathSegment::Key(INTENT_ROOT.to_owned()),
                    PathSegment::Key(INTENT_LEAF.to_owned()),
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

    #[test]
    fn add_orbit_derives_a_canonical_row_and_stable_id() {
        let mut live = state();
        let command = intent(
            live.revision,
            json!({ "kind": "add-orbit", "systemId": "helios" }),
        );
        live.validate_player_authority_command(&command).unwrap();
        assert!(serde_json::to_vec(&command).unwrap().len() < 384);
        live.apply_command(&command).unwrap();
        let orbits = live.base_value()["dysonEngineering"]["orbitsBySystem"]["helios"]
            .as_array()
            .unwrap();
        assert_eq!(orbits.len(), 3);
        assert_eq!(
            orbits[2],
            json!({
                "id": "dyson_orbit_100",
                "name": "太阳帆轨道 C",
                "radius": 24000,
                "inclination": 24,
                "longitude": 90,
                "sailsInOrbit": 0,
                "totalLaunched": 0,
                "totalExpired": 0,
                "decayProgress": 0,
                "generationKw": 0
            })
        );
        assert_eq!(
            live.base_value()["dysonEngineering"]["activeOrbitBySystem"]["helios"],
            "dyson_orbit_100"
        );
        assert_eq!(live.base_value()["nextId"], 101);
        assert_eq!(live.base_value()["dysonSwarm"]["sailsInOrbit"], 120);
        assert_eq!(live.base_value()["dysonSwarm"]["totalLaunched"], 220);
    }

    #[test]
    fn remove_orbit_merges_every_material_counter_and_rebuilds_the_global_aggregate() {
        let initial = state();
        let command = intent(
            initial.revision,
            json!({ "kind": "remove-orbit", "systemId": "helios", "orbitId": "orbit-a" }),
        );
        let mut live = initial.clone();
        live.validate_player_authority_command(&command).unwrap();
        live.apply_command(&command).unwrap();
        let mut replayed = initial;
        replayed.apply_command(&command).unwrap();
        assert_eq!(live.base_value(), replayed.base_value());

        let orbits = live.base_value()["dysonEngineering"]["orbitsBySystem"]["helios"]
            .as_array()
            .unwrap();
        assert_eq!(orbits.len(), 1);
        assert_eq!(orbits[0]["id"], "orbit-b");
        assert_eq!(orbits[0]["sailsInOrbit"], 120);
        assert_eq!(orbits[0]["totalLaunched"], 220);
        assert_eq!(orbits[0]["totalExpired"], 55);
        assert_eq!(orbits[0]["generationKw"].as_f64(), Some(10_560.0));
        assert_eq!(orbits[0]["decayProgress"], 0.25);
        assert_eq!(
            live.base_value()["dysonEngineering"]["activeOrbitBySystem"]["helios"],
            "orbit-b"
        );
        assert_eq!(live.base_value()["dysonSwarm"]["sailsInOrbit"], 120);
        assert_eq!(live.base_value()["dysonSwarm"]["totalLaunched"], 220);
        assert_eq!(live.base_value()["dysonSwarm"]["totalExpired"], 55);
        assert_eq!(live.base_value()["dysonSwarm"]["decayProgress"], 0.25);
        assert_eq!(
            live.base_value()["dysonSwarm"]["generationKw"].as_f64(),
            Some(10_560.0)
        );
        assert_eq!(live.base_value()["dysonSwarm"]["receiverLoadKw"], 123);
        assert_eq!(live.base_value()["nextId"], 100);
    }

    #[test]
    fn locked_forged_aggregate_last_orbit_and_extra_fields_fail_closed() {
        let mut locked = state();
        locked.base_value_mut()["research"]["completedTechIds"] = json!([]);
        assert!(
            locked
                .validate_player_authority_command(&intent(
                    locked.revision,
                    json!({ "kind": "add-orbit", "systemId": "helios" })
                ))
                .is_err()
        );

        let mut forged = state();
        forged.base_value_mut()["dysonSwarm"]["totalLaunched"] = Value::from(221);
        assert!(
            forged
                .validate_player_authority_command(&intent(
                    forged.revision,
                    json!({ "kind": "remove-orbit", "systemId": "helios", "orbitId": "orbit-a" })
                ))
                .is_err()
        );

        let mut one = state();
        one.base_value_mut()["dysonEngineering"]["orbitsBySystem"]["helios"] =
            json!([one.base_value()["dysonEngineering"]["orbitsBySystem"]["helios"][0].clone()]);
        one.base_value_mut()["dysonSwarm"] = json!({
            "sailsInOrbit": 100,
            "totalLaunched": 180,
            "totalExpired": 50,
            "decayProgress": 0.5,
            "generationKw": 8800,
            "receiverLoadKw": 123
        });
        assert!(
            one.validate_player_authority_command(&intent(
                one.revision,
                json!({ "kind": "remove-orbit", "systemId": "helios", "orbitId": "orbit-a" })
            ))
            .is_err()
        );

        assert!(
            state()
                .validate_player_authority_command(&intent(
                    7,
                    json!({ "kind": "add-orbit", "systemId": "helios", "orbits": [] })
                ))
                .is_err()
        );
    }
}
