use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Instant;

use dsp_native_core::catalog::RuntimeCatalog;
use dsp_native_core::{
    CatalogSnapshot, CoreAdvanceMode, CoreAdvanceRequest, CoreCheckpointIdentity, CoreState,
};
use serde::Deserialize;

const MAX_ADVANCE_SECONDS: f64 = 30.0 * 24.0 * 60.0 * 60.0;

#[derive(Deserialize)]
struct Bundle {
    identity: CoreCheckpointIdentity,
    catalog: CatalogSnapshot,
    records: BTreeMap<String, String>,
}

fn bundle_path(label: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../target/audit-block-bench")
        .join(format!("{label}.json"))
}

fn load(label: &str) -> CoreState {
    let bytes = std::fs::read(bundle_path(label)).unwrap();
    let bundle: Bundle = serde_json::from_slice(&bytes).unwrap();
    let expected_fingerprint = bundle.identity.registry_fingerprint.clone();
    let catalog = RuntimeCatalog::validate(bundle.catalog, &expected_fingerprint).unwrap();
    let records = bundle
        .records
        .into_iter()
        .map(|(key, value)| (key, value.into_bytes()))
        .collect();
    CoreState::from_owned_internal_records(bundle.identity, records, catalog).unwrap()
}

fn request(state: &CoreState, seconds: f64) -> CoreAdvanceRequest {
    CoreAdvanceRequest {
        base_revision: state.revision,
        simulation_seconds: seconds,
        wall_seconds: seconds / 15.0,
        advance_mode: CoreAdvanceMode::PureIdleMacroV10,
        include_diagnostics: true,
    }
}

fn sample(
    label: &str,
    initial: &CoreState,
    seconds: f64,
    expected_calls: Option<usize>,
) -> (Vec<usize>, Vec<usize>) {
    let upper_bound = ((seconds / 30.0).ceil()) as usize;
    let mut millis = Vec::new();
    let mut calls = Vec::new();
    let mut empty_stops = Vec::new();
    for _ in 0..3 {
        let mut state = initial.clone();
        dsp_native_core::audit_reset_construction_tail_block_calls();
        let started = Instant::now();
        let result = state.advance(&request(&state, seconds)).unwrap();
        let elapsed_ms = started.elapsed().as_secs_f64() * 1_000.0;
        assert!(result.supported, "{label} reason={:?}", result.reason);
        let observed_calls = dsp_native_core::audit_construction_tail_block_calls();
        let observed_empty_stops = dsp_native_core::audit_construction_tail_empty_stops();
        assert!(
            observed_calls <= upper_bound,
            "{label}: {observed_calls} calls exceeded ceil(seconds/30)={upper_bound}",
        );
        if let Some(expected) = expected_calls {
            assert_eq!(observed_calls, expected, "{label} block calls");
        }
        std::hint::black_box(state.summary().unwrap().canonical_sha256);
        millis.push(elapsed_ms);
        calls.push(observed_calls);
        empty_stops.push(observed_empty_stops);
    }
    let mut sorted = millis.clone();
    sorted.sort_by(f64::total_cmp);
    println!(
        "AUDIT_BLOCK_BENCH {label} seconds={seconds} runs_ms={millis:?} median_ms={} p95_ms={} calls={calls:?} empty_stops={empty_stops:?} bound={upper_bound}",
        sorted[1], sorted[2],
    );
    (calls, empty_stops)
}

fn main() {
    let one = load("one");
    let _ = sample("one-center-24h", &one, 86_400.0, Some(2_880));
    let _ = sample("one-center-30d", &one, MAX_ADVANCE_SECONDS, Some(86_400));

    let five = load("five");
    let _ = sample("five-center-shared-24h", &five, 86_400.0, Some(2_880));
    let _ = sample(
        "five-center-shared-30d",
        &five,
        MAX_ADVANCE_SECONDS,
        Some(86_400),
    );

    let near_real = load("near-real");
    let (calls, empty_stops) = sample(
        "near-real-221-44311-30d",
        &near_real,
        MAX_ADVANCE_SECONDS,
        None,
    );
    assert!(
        calls.iter().all(|&count| count < 1_000),
        "near-real owned-stock horizon failed to stop early: {calls:?}",
    );
    assert_eq!(empty_stops, vec![1, 1, 1]);

    let exhausted = load("exhausted");
    let (calls, empty_stops) = sample(
        "selected-rows-empty-30d",
        &exhausted,
        MAX_ADVANCE_SECONDS,
        None,
    );
    assert!(
        calls.iter().all(|&count| count <= 2),
        "empty active directory failed to stop promptly: {calls:?}",
    );
    assert_eq!(empty_stops, vec![1, 1, 1]);
}
