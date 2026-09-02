use std::collections::BTreeSet;

use anyhow::{anyhow, bail};
use serde_json::{Map, Number, Value};

use crate::state::CoreState;

const EPSILON: f64 = 0.0001;
const MIN_BUILDING_BUFFER_LIMIT: f64 = 1_000.0;
const DEFAULT_BUILDING_BUFFER_LIMIT: f64 = 1_000_000.0;
const MAX_BUILDING_BUFFER_LIMIT: f64 = 100_000_000.0;
const ACTIVE_DENSE_NUMERATOR: usize = 3;
const ACTIVE_DENSE_DENOMINATOR: usize = 4;

/// Runtime-only wake queue for the ordinary storage/splitter input-to-output
/// bridge. A row is processed once after a real inventory/topology wake and
/// then sleeps: one legacy settlement drains all currently movable input or
/// fills the output to capacity, so another visit cannot change the row until
/// an external inventory event occurs.
///
/// The queue is keyed by persisted entity row. `BTreeSet` makes insertion
/// order irrelevant while iteration remains byte-for-byte deterministic. It
/// is never serialized, hashed, checkpointed, or exposed to the renderer.
#[derive(Debug, Clone)]
pub(crate) struct LogisticsBufferRuntime {
    entity_count: usize,
    total_rows: usize,
    pending_entity_indices: BTreeSet<usize>,
    wake_all: bool,
    directory_fallback: bool,
    #[cfg(test)]
    force_full_scan: bool,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct LogisticsBufferScan {
    pub selected_rows: usize,
    pub total_rows: usize,
    pub stable_rows_skipped: usize,
    pub dense_fallback: bool,
    pub directory_fallback: bool,
    pub full_scan: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct LogisticsBufferSettlement {
    pub scan: LogisticsBufferScan,
    /// Persisted rows normalized by this settlement. The first cold pass owns
    /// every buffer row because it materializes the legacy zero-valued item
    /// keys; sparse passes contain only the exact wake queue. The caller folds
    /// these rows into the shared factory writer manifest.
    pub written_entity_indices: Vec<usize>,
}

impl LogisticsBufferRuntime {
    pub(crate) fn build(state: &CoreState, entities: &[Value]) -> Self {
        let indices = &state.factory_topology.logistics_buffer_indices;
        // Content packs can attach opaque inventory writers to an
        // ordinary-looking storage row. Only the empty built-in registry has
        // the writer closure proven by the two belt barriers below.
        let directory_fallback = state.identity.registry_fingerprint
            != crate::command::EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT
            || state.catalog.snapshot.registry_fingerprint
                != crate::command::EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT
            || entities.len() != state.entities.ids.len()
            || indices.windows(2).any(|pair| pair[0] >= pair[1])
            || indices.iter().any(|&index| {
                entities
                    .get(index)
                    .and_then(Value::as_object)
                    .is_none_or(|entity| {
                        !matches!(string_at(entity, "kind"), Some("storage" | "splitter"))
                    })
            });
        Self {
            entity_count: entities.len(),
            total_rows: indices.len(),
            pending_entity_indices: BTreeSet::new(),
            // The first admitted pass preserves the legacy normalization of
            // missing/fractional input and output entries for every row.
            wake_all: true,
            directory_fallback,
            #[cfg(test)]
            force_full_scan: false,
        }
    }

    pub(crate) fn estimated_bytes(&self) -> u64 {
        // A BTree node is implementation-private. This deliberately rounds up
        // to four machine words per pending key so the runtime budget cannot
        // under-report a sparse queue.
        (std::mem::size_of::<Self>()
            + self.pending_entity_indices.len() * std::mem::size_of::<usize>() * 4) as u64
    }

    pub(crate) fn wake_from_changed_entities(&mut self, state: &CoreState, changed: &[usize]) {
        if self.directory_fallback || self.wake_all || self.total_rows == 0 {
            return;
        }
        let buffer_indices = &state.factory_topology.logistics_buffer_indices;
        for &entity_index in changed {
            if entity_index >= self.entity_count {
                self.directory_fallback = true;
                self.wake_all = true;
                self.pending_entity_indices.clear();
                return;
            }
            if buffer_indices.binary_search(&entity_index).is_ok() {
                self.pending_entity_indices.insert(entity_index);
            }
        }
    }

    fn selection(
        &self,
        state: &CoreState,
        entities: &[Value],
    ) -> (BufferSelection, LogisticsBufferScan) {
        let indices = &state.factory_topology.logistics_buffer_indices;
        let runtime_fallback = self.directory_fallback
            || self.entity_count != entities.len()
            || self.total_rows != indices.len();
        let active = self.pending_entity_indices.len();
        let dense_fallback = !runtime_fallback
            && !self.wake_all
            && active > 0
            && active.saturating_mul(ACTIVE_DENSE_DENOMINATOR)
                >= self.total_rows.saturating_mul(ACTIVE_DENSE_NUMERATOR);
        #[cfg(test)]
        let forced = self.force_full_scan;
        #[cfg(not(test))]
        let forced = false;
        let full_scan = forced || runtime_fallback || self.wake_all || dense_fallback;
        let selected_rows = if full_scan { self.total_rows } else { active };
        let selection = if full_scan {
            BufferSelection::All
        } else {
            BufferSelection::Sparse(self.pending_entity_indices.iter().copied().collect())
        };
        (
            selection,
            LogisticsBufferScan {
                selected_rows,
                total_rows: self.total_rows,
                stable_rows_skipped: self.total_rows.saturating_sub(selected_rows),
                dense_fallback,
                directory_fallback: runtime_fallback,
                full_scan,
            },
        )
    }

    fn commit_selection(&mut self, selection: &BufferSelection) {
        match selection {
            BufferSelection::All => {
                self.pending_entity_indices.clear();
                self.wake_all = false;
            }
            BufferSelection::Sparse(indices) => {
                for entity_index in indices {
                    self.pending_entity_indices.remove(entity_index);
                }
            }
        }
    }

    #[cfg(test)]
    pub(crate) fn force_full_scan_for_test(&mut self, force: bool) {
        self.force_full_scan = force;
    }

    #[cfg(test)]
    pub(crate) fn pending_rows_for_test(&self) -> Vec<usize> {
        self.pending_entity_indices.iter().copied().collect()
    }
}

enum BufferSelection {
    All,
    Sparse(Vec<usize>),
}

pub(crate) fn settle_with_writer_rows(
    state: &CoreState,
    base: &Map<String, Value>,
    entities: &mut [Value],
    runtime: &mut LogisticsBufferRuntime,
) -> anyhow::Result<LogisticsBufferSettlement> {
    let (selection, scan) = runtime.selection(state, entities);
    let written_entity_indices = match &selection {
        BufferSelection::All => state.factory_topology.logistics_buffer_indices.clone(),
        BufferSelection::Sparse(indices) => indices.clone(),
    };
    match &selection {
        BufferSelection::All => settle_indices(
            state,
            base,
            entities,
            &state.factory_topology.logistics_buffer_indices,
        )?,
        BufferSelection::Sparse(indices) => {
            settle_indices(state, base, entities, indices)?;
        }
    }
    // A failed candidate never reaches this point, so its wake evidence is
    // retained in the source revision. The outer simulation transaction also
    // discards any partially-mutated candidate entity graph on error.
    runtime.commit_selection(&selection);
    Ok(LogisticsBufferSettlement {
        scan,
        written_entity_indices,
    })
}

#[cfg(test)]
pub(crate) fn settle(
    state: &CoreState,
    base: &Map<String, Value>,
    entities: &mut [Value],
    runtime: &mut LogisticsBufferRuntime,
) -> anyhow::Result<LogisticsBufferScan> {
    settle_with_writer_rows(state, base, entities, runtime).map(|outcome| outcome.scan)
}

fn settle_indices(
    state: &CoreState,
    base: &Map<String, Value>,
    entities: &mut [Value],
    entity_indices: &[usize],
) -> anyhow::Result<()> {
    let limit = normalized_buffer_limit(
        base.get("settings")
            .and_then(Value::as_object)
            .and_then(|settings| settings.get("logisticsBufferLimit")),
    );
    for &entity_index in entity_indices {
        let entity = entities
            .get_mut(entity_index)
            .and_then(Value::as_object_mut)
            .ok_or_else(|| anyhow!("native logistics buffer is invalid"))?;
        if !matches!(string_at(entity, "kind"), Some("storage" | "splitter")) {
            bail!("native logistics buffer directory changed");
        }
        let Some(item_id) = string_at(entity, "storedItemId").map(str::to_owned) else {
            continue;
        };
        let building = string_at(entity, "buildingId")
            .and_then(|id| state.catalog.buildings.get(id))
            .ok_or_else(|| anyhow!("native logistics building is missing"))?;
        let capacity = stacked_capacity(
            building.output_capacity,
            finite_number(entity.get("machineCount")),
            limit,
        );
        let incoming = entity
            .get("inputs")
            .and_then(Value::as_object)
            .and_then(|inputs| inputs.get(&item_id))
            .map(|value| (finite_number(Some(value)) + EPSILON).floor())
            .unwrap_or(0.0);
        let stored = entity
            .get("outputs")
            .and_then(Value::as_object)
            .and_then(|outputs| outputs.get(&item_id))
            .map(|value| (finite_number(Some(value)) + EPSILON).floor())
            .unwrap_or(0.0);
        let moved = incoming.min((capacity - stored).max(0.0));
        set_item_amount(entity, "inputs", &item_id, incoming - moved)?;
        set_item_amount(entity, "outputs", &item_id, stored + moved)?;
    }
    Ok(())
}

fn finite_number(value: Option<&Value>) -> f64 {
    value
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
        .unwrap_or(0.0)
}

fn string_at<'a>(object: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    object.get(key).and_then(Value::as_str)
}

fn normalized_buffer_limit(value: Option<&Value>) -> f64 {
    let value = value
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
        .unwrap_or(DEFAULT_BUILDING_BUFFER_LIMIT)
        .floor();
    value.clamp(MIN_BUILDING_BUFFER_LIMIT, MAX_BUILDING_BUFFER_LIMIT)
}

fn stacked_capacity(base_capacity: f64, count: f64, limit: f64) -> f64 {
    let base = base_capacity.max(0.0).floor();
    let count = count.floor().max(1.0);
    if base == 0.0 {
        0.0
    } else if base > limit / count {
        limit
    } else {
        (base * count).min(limit)
    }
}

fn set_item_amount(
    entity: &mut Map<String, Value>,
    record: &str,
    item_id: &str,
    amount: f64,
) -> anyhow::Result<()> {
    let inventory = entity
        .get_mut(record)
        .and_then(Value::as_object_mut)
        .ok_or_else(|| anyhow!("native logistics {record} are missing"))?;
    let amount = Number::from_f64(amount)
        .map(Value::Number)
        .ok_or_else(|| anyhow!("native logistics buffer produced a non-finite amount"))?;
    if let Some(current) = inventory.get_mut(item_id) {
        *current = amount;
    } else {
        inventory.insert(item_id.to_owned(), amount);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use sha2::{Digest, Sha256};

    fn buffer_entity(index: usize, kind: &str, incoming: f64, stored: f64) -> Value {
        let building_id = if kind == "splitter" {
            "splitter"
        } else {
            "storage_mk1"
        };
        json!({
            "id": format!("buffer-{index:05}"),
            "kind": kind,
            "planetId": "home",
            "powerGridId": "grid-a",
            "buildingId": building_id,
            "storedItemId": "iron_ore",
            "machineCount": 1,
            "inputs": { "iron_ore": incoming },
            "outputs": { "iron_ore": stored },
            "distributionMode": if kind == "splitter" { "balanced" } else { "priority" }
        })
    }

    fn fixture(count: usize) -> (CoreState, Map<String, Value>, Vec<Value>) {
        let entities = (0..count)
            .map(|index| {
                buffer_entity(
                    index,
                    if index % 2 == 0 {
                        "storage"
                    } else {
                        "splitter"
                    },
                    0.0,
                    0.0,
                )
            })
            .collect::<Vec<_>>();
        let mut state = crate::simple_factory::tests::fixture_state(&entities);
        state.identity.registry_fingerprint =
            crate::command::EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT.to_owned();
        std::sync::Arc::make_mut(&mut state.catalog)
            .snapshot
            .registry_fingerprint =
            crate::command::EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT.to_owned();
        let base = state.base_value().clone();
        (state, base, entities)
    }

    fn set_inventory(entities: &mut [Value], index: usize, record: &str, amount: f64) {
        entities[index]
            .as_object_mut()
            .unwrap()
            .get_mut(record)
            .and_then(Value::as_object_mut)
            .unwrap()
            .insert(
                "iron_ore".to_owned(),
                Number::from_f64(amount).map(Value::Number).unwrap(),
            );
    }

    fn bytes(entities: &[Value]) -> Vec<u8> {
        serde_json::to_vec(entities).unwrap()
    }

    fn digest(entities: &[Value]) -> [u8; 32] {
        Sha256::digest(bytes(entities)).into()
    }

    fn replay(seconds: usize, seed: u64) -> (Vec<Value>, Vec<LogisticsBufferScan>) {
        let (state, base, source) = fixture(257);
        let mut indexed_entities = source.clone();
        let mut oracle_entities = source;
        let mut indexed = LogisticsBufferRuntime::build(&state, &indexed_entities);
        let mut oracle = LogisticsBufferRuntime::build(&state, &oracle_entities);
        oracle.force_full_scan_for_test(true);
        let mut scans = Vec::with_capacity(seconds);
        let mut random = seed;
        for second in 0..seconds {
            random ^= random << 13;
            random ^= random >> 7;
            random ^= random << 17;
            let changed_count = if second % 17 == 0 { 3 } else { 1 };
            let mut changed = Vec::with_capacity(changed_count);
            for event in 0..changed_count {
                random = random
                    .wrapping_mul(6_364_136_223_846_793_005)
                    .wrapping_add(1 + event as u64);
                let index = random as usize % indexed_entities.len();
                let amount = ((random >> 11) % 97 + 1) as f64;
                if random & 1 == 0 {
                    set_inventory(&mut indexed_entities, index, "inputs", amount + 0.25);
                    set_inventory(&mut oracle_entities, index, "inputs", amount + 0.25);
                } else {
                    let stored = if random & 2 == 0 {
                        100.0
                    } else {
                        amount.min(99.0)
                    };
                    set_inventory(&mut indexed_entities, index, "outputs", stored);
                    set_inventory(&mut oracle_entities, index, "outputs", stored);
                }
                changed.push(index);
            }
            indexed.wake_from_changed_entities(&state, &changed);
            oracle.wake_from_changed_entities(&state, &changed);
            let scan = settle(&state, &base, &mut indexed_entities, &mut indexed).unwrap();
            settle(&state, &base, &mut oracle_entities, &mut oracle).unwrap();
            assert_eq!(
                bytes(&indexed_entities),
                bytes(&oracle_entities),
                "active buffer replay diverged at second {} with seed {seed}",
                second + 1
            );
            scans.push(scan);
        }
        (indexed_entities, scans)
    }

    #[test]
    fn active_buffer_queue_matches_full_scan_at_one_five_and_sixty_seconds() {
        for seconds in [1, 5, 60] {
            let (first, scans) = replay(seconds, 0x9e37_79b9_7f4a_7c15);
            let (second, repeated_scans) = replay(seconds, 0x9e37_79b9_7f4a_7c15);
            assert_eq!(digest(&first), digest(&second), "repeat hash at {seconds}s");
            assert_eq!(scans, repeated_scans, "repeat scans at {seconds}s");
            assert!(scans.iter().all(|scan| scan.total_rows == 257));
            if seconds > 1 {
                assert!(scans.iter().skip(1).any(|scan| scan.selected_rows <= 3));
            }
        }
    }

    #[test]
    fn randomized_active_buffer_differential_is_deterministic_and_byte_exact() {
        for seed in [1, 2, 3, 0xdead_beef, u64::MAX - 1] {
            let (first, first_scans) = replay(120, seed);
            let (second, second_scans) = replay(120, seed);
            assert_eq!(digest(&first), digest(&second), "seed {seed}");
            assert_eq!(first_scans, second_scans, "seed {seed}");
            assert!(first_scans.iter().skip(1).all(|scan| !scan.full_scan));
        }
    }

    #[test]
    fn quiet_sparse_buffer_visits_one_of_1024_and_skips_the_rest() {
        let (state, base, mut entities) = fixture(1_024);
        let mut runtime = LogisticsBufferRuntime::build(&state, &entities);
        let cold = settle_with_writer_rows(&state, &base, &mut entities, &mut runtime).unwrap();
        assert_eq!(cold.scan.selected_rows, 1_024);
        assert!(cold.scan.full_scan);
        assert_eq!(cold.written_entity_indices, (0..1_024).collect::<Vec<_>>());

        let quiet = settle_with_writer_rows(&state, &base, &mut entities, &mut runtime).unwrap();
        assert_eq!(quiet.scan.selected_rows, 0);
        assert_eq!(quiet.scan.stable_rows_skipped, 1_024);
        assert!(!quiet.scan.full_scan);
        assert!(quiet.written_entity_indices.is_empty());

        set_inventory(&mut entities, 511, "inputs", 9.0);
        runtime.wake_from_changed_entities(&state, &[511]);
        let one = settle_with_writer_rows(&state, &base, &mut entities, &mut runtime).unwrap();
        assert_eq!(one.scan.selected_rows, 1);
        assert_eq!(one.scan.stable_rows_skipped, 1_023);
        assert_eq!(one.written_entity_indices, vec![511]);
        assert_eq!(entities[511]["inputs"]["iron_ore"].as_f64(), Some(0.0));
        assert_eq!(entities[511]["outputs"]["iron_ore"].as_f64(), Some(9.0));
    }

    #[test]
    fn exact_three_quarters_wake_falls_back_to_stable_full_order() {
        let (state, base, mut entities) = fixture(8);
        let mut runtime = LogisticsBufferRuntime::build(&state, &entities);
        settle(&state, &base, &mut entities, &mut runtime).unwrap();

        runtime.wake_from_changed_entities(&state, &[7, 1, 5, 3, 0]);
        assert_eq!(runtime.pending_rows_for_test(), vec![0, 1, 3, 5, 7]);
        let sparse = settle(&state, &base, &mut entities, &mut runtime).unwrap();
        assert_eq!(sparse.selected_rows, 5);
        assert!(!sparse.dense_fallback);

        runtime.wake_from_changed_entities(&state, &[7, 6, 5, 4, 3, 2]);
        let dense = settle(&state, &base, &mut entities, &mut runtime).unwrap();
        assert_eq!(dense.selected_rows, 8);
        assert!(dense.dense_fallback);
        assert!(dense.full_scan);
    }

    #[test]
    fn mod_registry_never_uses_the_closed_builtin_wake_proof() {
        let (mut state, base, mut entities) = fixture(4);
        state.identity.registry_fingerprint = "mod:opaque-writer".to_owned();
        let mut runtime = LogisticsBufferRuntime::build(&state, &entities);

        let first = settle(&state, &base, &mut entities, &mut runtime).unwrap();
        let second = settle(&state, &base, &mut entities, &mut runtime).unwrap();
        assert_eq!(first.selected_rows, 4);
        assert_eq!(second.selected_rows, 4);
        assert!(first.directory_fallback && second.directory_fallback);
        assert!(first.full_scan && second.full_scan);
    }

    #[test]
    fn failed_candidate_retains_wake_queue_and_source_bytes() {
        let (state, base, source) = fixture(4);
        let source_bytes = bytes(&source);
        let mut candidate = source.clone();
        let mut runtime = LogisticsBufferRuntime::build(&state, &candidate);
        settle(&state, &base, &mut candidate, &mut runtime).unwrap();

        candidate[2]["inputs"] = Value::from("invalid");
        runtime.wake_from_changed_entities(&state, &[2]);
        let error = settle(&state, &base, &mut candidate, &mut runtime).unwrap_err();
        assert!(error.to_string().contains("inputs are missing"));
        assert_eq!(bytes(&source), source_bytes);
        assert_eq!(runtime.pending_rows_for_test(), vec![2]);

        candidate = source.clone();
        set_inventory(&mut candidate, 2, "inputs", 9.0);
        settle(&state, &base, &mut candidate, &mut runtime).unwrap();
        assert!(runtime.pending_rows_for_test().is_empty());
        assert_eq!(candidate[2]["inputs"]["iron_ore"].as_f64(), Some(0.0));
        assert_eq!(candidate[2]["outputs"]["iron_ore"].as_f64(), Some(9.0));
    }
}
