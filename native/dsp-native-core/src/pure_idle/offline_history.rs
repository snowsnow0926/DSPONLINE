//! Public production-history reconstruction for a proved ordinary offline tail.
//!
//! A physical flow proof supplies thirty real one-second Exact observations.
//! The first ten samples retain any inherited diagnostic values; the second
//! and third complete refresh cycles must agree at every phase. Only then may
//! their telemetry be replayed. Every future timestamp, sample duration and
//! compression boundary still goes through the ordinary recorder's helpers.

use super::offline_flow::OfflineFlowProof;
use super::*;
use crate::production_history::{append_production_history_sample, production_history_boundary};
use crate::simulation::exact_elapsed_after_step;

const CYCLE_SECONDS: usize = 10;
const OBSERVED_SECONDS: usize = CYCLE_SECONDS * 3;
const MAX_TAIL_SECONDS: f64 = 8.0 * 60.0 * 60.0;

#[derive(Clone)]
struct ObservedSample {
    payload: Map<String, Value>,
    refresh: bool,
}

pub(super) struct OfflineHistoryProof {
    source_elapsed: Value,
    source_recorded: Value,
    source_history: Value,
    tail_seconds: f64,
    first_cycle: Vec<ObservedSample>,
    repeating_cycle: Vec<ObservedSample>,
}

fn clock_number(base: &Map<String, Value>, key: &str) -> Result<f64, String> {
    base.get(key)
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite() && *value >= 0.0)
        .ok_or_else(|| format!("offline-history-invalid-{key}"))
}

fn validate_tail(tail_seconds: f64) -> Result<usize, String> {
    if !tail_seconds.is_finite()
        || !(1.0..=MAX_TAIL_SECONDS).contains(&tail_seconds)
        || tail_seconds.fract() != 0.0
    {
        return Err("offline-history-tail-budget-or-fraction".to_owned());
    }
    Ok(tail_seconds as usize)
}

/// This is deliberately the only production constructor: observed history by
/// itself cannot establish a stationary physical factory or close its writers.
pub(super) fn prepare(
    prefix: &CoreState,
    flow: &OfflineFlowProof,
    tail_seconds: f64,
) -> Result<OfflineHistoryProof, String> {
    flow.matches_prefix_and_tail(prefix, tail_seconds)?;
    prepare_observed(
        prefix.base_value(),
        flow.observed_history_samples(),
        tail_seconds,
    )
}

fn prepare_observed(
    prefix: &Map<String, Value>,
    observed: &[Value],
    tail_seconds: f64,
) -> Result<OfflineHistoryProof, String> {
    validate_tail(tail_seconds)?;
    let elapsed = clock_number(prefix, "elapsedSeconds")?;
    if clock_number(prefix, "historyRecordedAt")? != elapsed {
        return Err("offline-history-prefix-clock-unaligned".to_owned());
    }
    let history = prefix
        .get("productionHistory")
        .and_then(Value::as_array)
        .ok_or_else(|| "offline-history-prefix-missing".to_owned())?;
    for sample in history {
        let sample = sample
            .as_object()
            .ok_or_else(|| "offline-history-prefix-row-invalid".to_owned())?;
        if clock_number(sample, "elapsedSeconds")? > elapsed
            || clock_number(sample, "sampleDurationSeconds")? == 0.0
        {
            return Err("offline-history-prefix-row-clock-invalid".to_owned());
        }
    }
    if observed.len() != OBSERVED_SECONDS {
        return Err("offline-history-probe-cycle-count".to_owned());
    }
    let mut replay = Map::from_iter([
        (
            "elapsedSeconds".to_owned(),
            prefix["elapsedSeconds"].clone(),
        ),
        (
            "historyRecordedAt".to_owned(),
            prefix["historyRecordedAt"].clone(),
        ),
        (
            "productionHistory".to_owned(),
            Value::Array(history.clone()),
        ),
    ]);
    let mut phases = Vec::with_capacity(OBSERVED_SECONDS);
    for sample in observed {
        let next_elapsed = exact_elapsed_after_step(clock_number(&replay, "elapsedSeconds")?, 1.0);
        replay.insert("elapsedSeconds".to_owned(), Value::from(next_elapsed));
        let boundary = production_history_boundary(&replay)
            .map_err(|error| format!("offline-history-probe-boundary: {error}"))?
            .ok_or_else(|| "offline-history-probe-not-due".to_owned())?;
        let mut payload = sample
            .as_object()
            .cloned()
            .ok_or_else(|| "offline-history-probe-row-invalid".to_owned())?;
        if clock_number(&payload, "elapsedSeconds")? != boundary.elapsed
            || clock_number(&payload, "sampleDurationSeconds")? != boundary.duration
        {
            return Err("offline-history-probe-clock-mismatch".to_owned());
        }
        payload.remove("elapsedSeconds");
        payload.remove("sampleDurationSeconds");
        phases.push(ObservedSample {
            payload,
            refresh: boundary.refresh,
        });
        append_to_replay(&mut replay, sample.clone(), boundary.elapsed)?;
    }
    for phase in 0..CYCLE_SECONDS {
        let settled = &phases[CYCLE_SECONDS + phase];
        let verified = &phases[2 * CYCLE_SECONDS + phase];
        if settled.payload != verified.payload || settled.refresh != verified.refresh {
            return Err(format!("offline-history-nonrepeating-phase-{phase}"));
        }
    }
    Ok(OfflineHistoryProof {
        source_elapsed: prefix["elapsedSeconds"].clone(),
        source_recorded: prefix["historyRecordedAt"].clone(),
        source_history: prefix["productionHistory"].clone(),
        tail_seconds,
        first_cycle: phases[..CYCLE_SECONDS].to_vec(),
        repeating_cycle: phases[CYCLE_SECONDS..2 * CYCLE_SECONDS].to_vec(),
    })
}

fn append_to_replay(
    replay: &mut Map<String, Value>,
    sample: Value,
    elapsed: f64,
) -> Result<(), String> {
    let history = replay
        .get_mut("productionHistory")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| "offline-history-replay-missing".to_owned())?;
    append_production_history_sample(history, sample)
        .map_err(|error| format!("offline-history-compact: {error}"))?;
    replay.insert("historyRecordedAt".to_owned(), Value::from(elapsed));
    Ok(())
}

fn reconstruct(
    candidate: &Map<String, Value>,
    proof: &OfflineHistoryProof,
    tail_seconds: f64,
) -> Result<Map<String, Value>, String> {
    let steps = validate_tail(tail_seconds)?;
    if tail_seconds != proof.tail_seconds
        || candidate.get("elapsedSeconds") != Some(&proof.source_elapsed)
        || candidate.get("historyRecordedAt") != Some(&proof.source_recorded)
        || candidate.get("productionHistory") != Some(&proof.source_history)
    {
        return Err("offline-history-prefix-or-tail-changed".to_owned());
    }
    let mut replay = Map::from_iter([
        ("elapsedSeconds".to_owned(), proof.source_elapsed.clone()),
        (
            "historyRecordedAt".to_owned(),
            proof.source_recorded.clone(),
        ),
        ("productionHistory".to_owned(), proof.source_history.clone()),
    ]);
    for index in 0..steps {
        let observed = if index < CYCLE_SECONDS {
            &proof.first_cycle[index]
        } else {
            &proof.repeating_cycle[index % CYCLE_SECONDS]
        };
        let next_elapsed = exact_elapsed_after_step(clock_number(&replay, "elapsedSeconds")?, 1.0);
        replay.insert("elapsedSeconds".to_owned(), Value::from(next_elapsed));
        let boundary = production_history_boundary(&replay)
            .map_err(|error| format!("offline-history-replay-boundary: {error}"))?
            .ok_or_else(|| "offline-history-replay-not-due".to_owned())?;
        if boundary.refresh != observed.refresh {
            return Err("offline-history-refresh-phase-changed".to_owned());
        }
        let mut sample = observed.payload.clone();
        sample.insert("elapsedSeconds".to_owned(), Value::from(boundary.elapsed));
        sample.insert(
            "sampleDurationSeconds".to_owned(),
            Value::from(boundary.duration),
        );
        append_to_replay(&mut replay, Value::Object(sample), boundary.elapsed)?;
    }
    Ok(replay)
}

/// Build and compact on a local history array before touching the disposable
/// macro candidate. The caller owns the separate elapsed/export-window proof;
/// this method must run while the candidate still has the prefix clock.
pub(super) fn apply(
    candidate: &mut CoreState,
    proof: &OfflineHistoryProof,
    tail_seconds: f64,
) -> Result<(), String> {
    let mut replay = reconstruct(candidate.base_value(), proof, tail_seconds)?;
    let history = replay
        .remove("productionHistory")
        .expect("reconstructed history");
    let recorded = replay
        .remove("historyRecordedAt")
        .expect("reconstructed history clock");
    // This accessor also invalidates the private history cache, so no old tier
    // can be mistaken for a projection of the newly reconstructed public rows.
    let base = candidate.base_value_mut();
    base.insert("productionHistory".to_owned(), history);
    base.insert("historyRecordedAt".to_owned(), recorded);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::{CatalogSnapshot, RuntimeCatalog};
    use crate::state::CoreCheckpointIdentity;
    use serde_json::json;

    // This fixture drives the real public history recorder with explicit
    // periodic per-second telemetry. It tests history reconstruction separately
    // from the stricter physical-flow proof tested by the parent integration.
    fn recorder_fixture(elapsed: f64) -> (CoreState, Map<String, Value>, Vec<Value>) {
        let catalog: CatalogSnapshot = serde_json::from_value(json!({
            "protocolVersion": 1,
            "registryFingerprint": "offline-history-test-v1",
            "planets": [{"id":"home", "systemId":"helios", "kind":"terrestrial", "orbitIndex":1}],
            "items": [
                {"id":"iron_ore", "kind":"solid"},
                {"id":"iron_ingot", "kind":"solid"}
            ],
            "buildings": [{
                "id":"arc_smelter", "kind":"machine", "speed":1,
                "inputCapacity":1000, "outputCapacity":1000,
                "powerDemandKw":1, "family":"smelting"
            }],
            "recipes": [{
                "id":"iron_ingot", "buildingId":"arc_smelter", "duration":1,
                "inputs":[{"itemId":"iron_ore", "amount":1}],
                "outputs":[{"itemId":"iron_ingot", "amount":1}]
            }],
            "belts": []
        }))
        .unwrap();
        let catalog = RuntimeCatalog::validate(catalog, "offline-history-test-v1").unwrap();
        let base = json!({
            "version":47, "mode":"normal", "activePlanetId":"home",
            "elapsedSeconds":elapsed, "historyRecordedAt":elapsed,
            "productionHistory":[], "paused":false,
            "settings":{"difficulty":"standard", "resourceMode":"infinite", "productionBufferLimit":1000},
            "research":{"completedTechIds":[], "selectedTechId":null, "progressByTech":{}},
            "endgame":{"infiniteResearch":{"vein_utilization":{"level":0}}},
            "powerGridMetrics":{"home":{"grid-a":{
                "generationKw":100, "demandKw":1, "deliveredKw":1, "powerFactor":1
            }}},
            "planetMetrics":{"home":{"generationKw":100, "demandKw":1}},
            "planetTrays":{"home":{"iron_ore":7}},
            "galaxy":{"profiles":{"home":{"oceanType":"none"}}},
            "totalProduced":{}, "historyTestSentinel":{"preserve":[1,2,3]}
        }).as_object().unwrap().clone();
        let entities = vec![json!({
            "id":"smelter", "kind":"machine", "planetId":"home",
            "powerGridId":"grid-a", "buildingId":"arc_smelter", "recipeId":"iron_ingot",
            "machineCount":1, "minerCount":0, "inputs":{"iron_ore":50},
            "outputs":{"iron_ingot":10}, "progress":0, "productionRate":1,
            "utilization":1, "routingCursor":0
        })];
        let state = CoreState::from_public_v47_parts(
            CoreCheckpointIdentity {
                slot: "normal-main".to_owned(),
                generation: 1,
                root_hash: "a".repeat(64),
                revision: 7,
                state_version: 47,
                mode: "normal".to_owned(),
                registry_fingerprint: "offline-history-test-v1".to_owned(),
                base_primary_checksum: "12345678".to_owned(),
            },
            base.clone(),
            entities
                .iter()
                .map(|entity| serde_json::to_string(entity).unwrap())
                .collect(),
            Vec::new(),
            catalog,
        )
        .unwrap();
        (state, base, entities)
    }

    fn actual_sample(
        state: &CoreState,
        base: &mut Map<String, Value>,
        entities: &mut [Value],
        phase: usize,
    ) -> Value {
        let elapsed = exact_elapsed_after_step(base["elapsedSeconds"].as_f64().unwrap(), 1.0);
        base.insert("elapsedSeconds".to_owned(), json!(elapsed));
        entities[0]["productionRate"] = json!(0.5 + phase as f64 * 0.125);
        entities[0]["utilization"] = json!(0.5 + phase as f64 * 0.05);
        entities[0]["outputs"]["iron_ingot"] = json!(10 + phase);
        base["powerGridMetrics"]["home"]["grid-a"]["generationKw"] = json!(100 + phase);
        base["planetMetrics"]["home"]["generationKw"] = json!(100 + phase);
        state
            .record_production_history_with_records(base, entities, None)
            .unwrap();
        base["productionHistory"]
            .as_array()
            .unwrap()
            .last()
            .unwrap()
            .clone()
    }

    fn observations(
        state: &CoreState,
        prefix: &Map<String, Value>,
        entities: &[Value],
    ) -> Vec<Value> {
        let mut base = prefix.clone();
        let mut entities = entities.to_vec();
        (0..OBSERVED_SECONDS)
            .map(|step| actual_sample(state, &mut base, &mut entities, step % CYCLE_SECONDS))
            .collect()
    }

    fn assert_recorder_parity(
        state: &CoreState,
        prefix: &Map<String, Value>,
        entities: &[Value],
        seconds: usize,
    ) -> Map<String, Value> {
        let before = prefix.clone();
        let samples = observations(state, prefix, entities);
        assert_ne!(
            samples[0]["productionPerMinute"], samples[1]["productionPerMinute"],
            "the oracle must exercise distinct observed production phases"
        );
        let proof = prepare_observed(prefix, &samples, seconds as f64).unwrap();
        let rebuilt = reconstruct(prefix, &proof, seconds as f64).unwrap();
        let mut oracle = prefix.clone();
        let mut entities = entities.to_vec();
        for step in 0..seconds {
            actual_sample(state, &mut oracle, &mut entities, step % CYCLE_SECONDS);
        }
        assert_eq!(rebuilt["productionHistory"], oracle["productionHistory"]);
        assert_eq!(rebuilt["historyRecordedAt"], oracle["historyRecordedAt"]);
        assert_eq!(rebuilt["elapsedSeconds"], oracle["elapsedSeconds"]);
        assert_eq!(*prefix, before, "the source history must stay unchanged");
        rebuilt
    }

    #[test]
    fn offline_history_matches_real_recorder_for_ten_minutes_and_eight_hours() {
        let (state, prefix, entities) = recorder_fixture(51.0);
        for seconds in [600, 28_800] {
            let rebuilt = assert_recorder_parity(&state, &prefix, &entities, seconds);
            let rows = rebuilt["productionHistory"].as_array().unwrap();
            assert!(
                rows.iter()
                    .any(|row| row["sampleDurationSeconds"].as_f64() == Some(10.0))
            );
            if seconds > 3_660 {
                assert!(
                    rows.iter()
                        .any(|row| row["sampleDurationSeconds"].as_f64() == Some(60.0))
                );
                assert!(
                    rows.iter()
                        .map(|row| row["sampleDurationSeconds"].as_f64().unwrap())
                        .sum::<f64>()
                        <= 3_660.0
                );
                assert!(rows[0]["elapsedSeconds"].as_f64().unwrap() > 51.0);
            }
        }
    }

    #[test]
    fn offline_history_retains_existing_buckets_and_real_fractional_sample_durations() {
        let (state, mut prefix, mut entities) = recorder_fixture(0.0043);
        for step in 0..900 {
            actual_sample(&state, &mut prefix, &mut entities, step % CYCLE_SECONDS);
        }
        assert!(
            prefix["productionHistory"]
                .as_array()
                .unwrap()
                .iter()
                .any(|row| row["sampleDurationSeconds"].as_f64() == Some(60.0))
        );
        for seconds in [1, 9, 11, 599, 601] {
            assert_recorder_parity(&state, &prefix, &entities, seconds);
        }
        let (state, prefix, entities) = recorder_fixture(51.25);
        assert_recorder_parity(&state, &prefix, &entities, 601);
    }

    #[test]
    fn offline_history_keeps_first_cycle_inherited_diagnostics_before_real_refresh() {
        let (state, mut prefix, entities) = recorder_fixture(50.0);
        let mut records = entities.clone();
        actual_sample(&state, &mut prefix, &mut records, 0);
        let old = prefix["productionHistory"]
            .as_array_mut()
            .unwrap()
            .last_mut()
            .unwrap();
        old["inventory"] = json!({"iron_ore":999});
        old["machineEfficiency"] = json!(0.1234);
        let samples = observations(&state, &prefix, &entities);
        assert_ne!(samples[0]["inventory"], samples[CYCLE_SECONDS]["inventory"]);
        assert_ne!(
            samples[0]["machineEfficiency"],
            samples[CYCLE_SECONDS]["machineEfficiency"]
        );
        assert_recorder_parity(&state, &prefix, &entities, 601);
    }

    #[test]
    fn offline_history_rejects_bad_probes_and_nonperiodic_telemetry_without_mutation() {
        let (state, prefix, entities) = recorder_fixture(51.0);
        let samples = observations(&state, &prefix, &entities);
        let before = prefix.clone();
        for key in [
            "inventory",
            "productionPerMinute",
            "powerEfficiency",
            "pureIdleReplication",
        ] {
            let mut changed = samples.clone();
            changed[25][key] = json!({"unexpected":123});
            assert!(prepare_observed(&prefix, &changed, 600.0).is_err(), "{key}");
        }
        for key in ["elapsedSeconds", "sampleDurationSeconds"] {
            let mut changed = samples.clone();
            changed[3][key] = json!(0.5);
            assert!(prepare_observed(&prefix, &changed, 600.0).is_err());
        }
        assert!(prepare_observed(&prefix, &samples[..20], 600.0).is_err());
        for seconds in [0.0, 1.5, 28_801.0, f64::NAN, f64::INFINITY] {
            assert!(prepare_observed(&prefix, &samples, seconds).is_err());
        }
        assert_eq!(prefix, before);
    }

    #[test]
    fn offline_history_apply_rejects_stale_bindings_atomically_and_only_writes_history() {
        let (mut state, prefix, entities) = recorder_fixture(51.0);
        let samples = observations(&state, &prefix, &entities);
        let proof = prepare_observed(&prefix, &samples, 601.0).unwrap();
        for key in ["elapsedSeconds", "historyRecordedAt", "productionHistory"] {
            let mut candidate = state.clone();
            candidate
                .base_value_mut()
                .insert(key.to_owned(), json!("changed"));
            let before = candidate.base_value().clone();
            assert!(apply(&mut candidate, &proof, 601.0).is_err());
            assert_eq!(candidate.base_value(), &before);
        }
        let before = state.base_value().clone();
        assert!(apply(&mut state, &proof, 600.0).is_err());
        assert_eq!(state.base_value(), &before);
        let expected = reconstruct(&prefix, &proof, 601.0).unwrap();
        apply(&mut state, &proof, 601.0).unwrap();
        assert_eq!(
            state.base_value()["productionHistory"],
            expected["productionHistory"]
        );
        assert_eq!(
            state.base_value()["historyRecordedAt"],
            expected["historyRecordedAt"]
        );
        let mut other_after = state.base_value().clone();
        let mut other_before = before;
        for key in ["productionHistory", "historyRecordedAt"] {
            other_after.remove(key);
            other_before.remove(key);
        }
        assert_eq!(other_after, other_before);
        // A later replay failure also cannot expose the partially compacted
        // local history (the test deliberately breaks a verified phase).
        let mut broken = prepare_observed(&prefix, &samples, 601.0).unwrap();
        broken.repeating_cycle[7].refresh = !broken.repeating_cycle[7].refresh;
        let before = prefix.clone();
        assert!(reconstruct(&prefix, &broken, 601.0).is_err());
        assert_eq!(prefix, before);
    }
}
