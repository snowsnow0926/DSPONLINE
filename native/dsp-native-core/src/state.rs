use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fmt;
use std::io::Write as IoWrite;
use std::mem::size_of;
use std::ops::{Deref, DerefMut, Index, IndexMut};
use std::sync::mpsc::{SyncSender, sync_channel};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};

use anyhow::{Context, anyhow, bail};
use serde::ser::SerializeMap;
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use crate::canonical::{fnv1a_utf8, update_canonical, update_canonical_object};
use crate::catalog::RuntimeCatalog;
use crate::deterministic_runtime::{DeterministicRuntime, runtime as deterministic_runtime};
use crate::entity_raw::encode_entity_records_full;
#[cfg(test)]
use crate::entity_raw::json_bitwise_eq;

const INTERNAL_MANIFEST_SUFFIX: &str = "manifest";
const MAX_INTERNAL_RECORDS: usize = 4_096;
const MAX_ENTITY_COUNT: usize = 2_000_000;
const MAX_BELT_COUNT: usize = 4_000_000;
const MAX_PROJECTION_ENTITIES: usize = 32;
const MAX_PROJECTION_BELTS: usize = 64;
const MAX_PROJECTION_BASE_FIELDS: usize = 64;
const MAX_PROJECTION_BYTES: usize = 1_048_576;
const MAX_VIEWPORT_PROJECTION_ENTITIES: usize = 4_096;
const MAX_VIEWPORT_PROJECTION_BELTS: usize = 8_192;
const MAX_VIEWPORT_PINNED_ENTITIES: usize = 64;
const MAX_VIEWPORT_PINNED_BELTS: usize = 128;
const MAX_VIEWPORT_OPAQUE_ID_BYTES: usize = 1_024;
const VIEWPORT_SPATIAL_CELL_SIZE: f64 = 512.0;
const MAX_VIEWPORT_GRID_CELL_PROBES: u64 = 4_096;
const MAX_STATISTICS_PROJECTION_SAMPLES: usize = 512;
const NONE_SYMBOL: u32 = u32::MAX;
const ENTITY_CHECKPOINT_CHUNK_SIZE: usize = 1_024;
const BELT_CHECKPOINT_CHUNK_SIZE: usize = 2_048;
const LEGACY_INTERNAL_CHECKPOINT_FORMAT_VERSION: u16 = 1;
const DOMAIN_INTERNAL_CHECKPOINT_FORMAT_VERSION: u16 = 2;
pub(crate) const PURE_IDLE_SESSION_EXACT_CREDIT_SECONDS: f64 = 30.0;
const PURE_IDLE_SESSION_FORMAT_VERSION: u8 = 1;

/// A cloneable synchronization cell for the two diagnostic/persistence caches
/// that are reachable through shared `CoreState` references. Keeping interior
/// mutability behind a mutex makes the immutable simulation catalog and
/// topology safe to share with deterministic worker threads; clones receive an
/// independent snapshot, so transactional candidates cannot mutate the live
/// session's cache state.
struct SyncCell<T>(Mutex<T>);

impl<T> SyncCell<T> {
    fn new(value: T) -> Self {
        Self(Mutex::new(value))
    }

    fn borrow(&self) -> MutexGuard<'_, T> {
        self.0.lock().unwrap_or_else(|error| error.into_inner())
    }

    fn borrow_mut(&self) -> MutexGuard<'_, T> {
        self.borrow()
    }

    fn get_mut(&mut self) -> &mut T {
        self.0.get_mut().unwrap_or_else(|error| error.into_inner())
    }

    fn replace(&self, value: T) -> T {
        std::mem::replace(&mut *self.borrow_mut(), value)
    }
}

impl<T: Clone> Clone for SyncCell<T> {
    fn clone(&self) -> Self {
        Self::new(self.borrow().clone())
    }
}

impl<T: fmt::Debug> fmt::Debug for SyncCell<T> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_tuple("SyncCell")
            .field(&*self.borrow())
            .finish()
    }
}

/// One-shot decoded entity graph for the next sequential factory revision.
///
/// Raw JSON records remain authoritative. A successful simulation installs
/// the exact Values it just encoded; the next transaction moves that graph
/// out instead of reparsing every entity. Shared transactional clones compete
/// for the same one-shot value, so at most one full decoded graph is retained.
/// Invalidating any entity record clears the cache for every clone. Losing the
/// cache after a failed candidate is only a performance loss: the next caller
/// rebuilds it from the unchanged raw records.
#[derive(Default)]
struct EntityRuntimeCache(Mutex<Option<Vec<Value>>>);

impl EntityRuntimeCache {
    fn with_values(values: Vec<Value>) -> Self {
        Self(Mutex::new(Some(values)))
    }

    fn take(&self, expected_rows: usize) -> Option<Vec<Value>> {
        let mut cached = self.0.lock().unwrap_or_else(|error| error.into_inner());
        if cached
            .as_ref()
            .is_some_and(|values| values.len() == expected_rows)
        {
            cached.take()
        } else {
            // A mismatched runtime cache is never a source of gameplay truth.
            // Discard it and let the caller decode the authoritative rows.
            cached.take();
            None
        }
    }

    fn clear(&self) {
        self.0
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .take();
    }

    fn estimated_bytes(&self, raw_entity_bytes: u64) -> u64 {
        self.0
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .as_ref()
            .map(|values| {
                // JSON text bytes are a conservative lower-bound proxy for
                // strings/map allocations; add the outer Value allocation.
                raw_entity_bytes.saturating_add((values.capacity() * size_of::<Value>()) as u64)
            })
            .unwrap_or(0)
    }

    #[cfg(test)]
    fn resident_rows(&self) -> usize {
        self.0
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .as_ref()
            .map(Vec::len)
            .unwrap_or(0)
    }
}

impl fmt::Debug for EntityRuntimeCache {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("EntityRuntimeCache")
            .field(
                "resident_rows",
                &self
                    .0
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .as_ref()
                    .map(Vec::len)
                    .unwrap_or(0),
            )
            .finish()
    }
}

/// Clone-on-write ownership for immutable factory indexes and scalar columns.
/// Ordinary simulation revisions share these tables in O(1); topology edits
/// keep the existing mutation syntax and clone a table only on first write.
#[derive(Debug)]
pub(crate) struct SharedArc<T: Clone>(Arc<T>);

impl<T: Clone> SharedArc<T> {
    fn new(value: T) -> Self {
        Self(Arc::new(value))
    }
}

impl<T: Clone> Clone for SharedArc<T> {
    fn clone(&self) -> Self {
        Self(self.0.clone())
    }
}

impl<T: Clone + Default> Default for SharedArc<T> {
    fn default() -> Self {
        Self::new(T::default())
    }
}

impl<T: Clone> From<T> for SharedArc<T> {
    fn from(value: T) -> Self {
        Self::new(value)
    }
}

impl<T: Clone> Deref for SharedArc<T> {
    type Target = T;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl<T: Clone> DerefMut for SharedArc<T> {
    fn deref_mut(&mut self) -> &mut Self::Target {
        Arc::make_mut(&mut self.0)
    }
}

const EXACT_ROW_ID_HASH_OFFSET: u64 = 0xcbf29ce484222325;
const EXACT_ROW_ID_HASH_PRIME: u64 = 0x100000001b3;
const EXACT_ROW_ID_MAX_LOAD_NUMERATOR: usize = 3;
const EXACT_ROW_ID_MAX_LOAD_DENOMINATOR: usize = 4;
const EXACT_ROW_ID_MAX_PROBE_DISTANCE: usize = 256;

#[derive(Debug, Clone, Copy)]
struct ExactRowIdEntry {
    start: u32,
    len: u32,
    /// Kept beside the string range so `HashMap::get`-style callers can retain
    /// their existing `Option<&usize>` contract without a second row array.
    row_index: usize,
}

#[derive(Debug, Default)]
struct ExactRowIdsStorage {
    text: Box<str>,
    entries: Box<[ExactRowIdEntry]>,
}

/// One exact decoded ID arena shared by the scalar columns and row index.
/// Entries stay 16 bytes on x64, matching the former `Box<str>` column, while
/// eliminating both the index's owned `String` and one allocation per ID.
#[derive(Debug, Clone, Default)]
pub(crate) struct ExactRowIds(Arc<ExactRowIdsStorage>);

impl ExactRowIds {
    pub(crate) fn from_boxed(
        ids: Vec<Box<str>>,
        record_kind: &'static str,
    ) -> anyhow::Result<Self> {
        if ids.len() > u32::MAX as usize {
            bail!("native core {record_kind} ID row capacity overflow");
        }
        let text_bytes = ids.iter().try_fold(0_usize, |total, id| {
            if id.is_empty() {
                bail!("native core {record_kind} ID is empty");
            }
            total
                .checked_add(id.len())
                .ok_or_else(|| anyhow!("native core {record_kind} ID text capacity overflow"))
        })?;
        if text_bytes > u32::MAX as usize {
            bail!("native core {record_kind} ID text capacity overflow");
        }

        let mut text = String::with_capacity(text_bytes);
        let mut entries = Vec::with_capacity(ids.len());
        for (row_index, id) in ids.into_iter().enumerate() {
            let start = u32::try_from(text.len())
                .map_err(|_| anyhow!("native core {record_kind} ID text capacity overflow"))?;
            let len = u32::try_from(id.len())
                .map_err(|_| anyhow!("native core {record_kind} ID text capacity overflow"))?;
            text.push_str(&id);
            entries.push(ExactRowIdEntry {
                start,
                len,
                row_index,
            });
        }
        Ok(Self(Arc::new(ExactRowIdsStorage {
            text: text.into_boxed_str(),
            entries: entries.into_boxed_slice(),
        })))
    }

    pub(crate) fn len(&self) -> usize {
        self.0.entries.len()
    }

    fn is_empty(&self) -> bool {
        self.0.entries.is_empty()
    }

    fn text_bytes(&self) -> usize {
        self.0.text.len()
    }

    fn row_index(&self, index: usize) -> &usize {
        &self.0.entries[index].row_index
    }
}

impl Index<usize> for ExactRowIds {
    type Output = str;

    fn index(&self, index: usize) -> &Self::Output {
        let entry = self.0.entries[index];
        let start = entry.start as usize;
        &self.0.text[start..start + entry.len as usize]
    }
}

/// Deterministic bounded-load open-addressed index. Hashes select a probe
/// start only; every match is proved against the complete decoded ID string.
#[derive(Debug, Clone, Default)]
pub(crate) struct ExactRowIdIndex {
    ids: ExactRowIds,
    buckets: Vec<u32>,
    hash_mask: u64,
}

impl ExactRowIdIndex {
    fn from_boxed(ids: Vec<Box<str>>, record_kind: &'static str) -> anyhow::Result<Self> {
        let ids = ExactRowIds::from_boxed(ids, record_kind)?;
        Self::from_ids(ids, record_kind, u64::MAX)
    }

    fn from_ids(
        ids: ExactRowIds,
        record_kind: &'static str,
        hash_mask: u64,
    ) -> anyhow::Result<Self> {
        let bucket_capacity = Self::bucket_capacity_for_len(ids.len())?;
        let mut index = Self {
            ids,
            buckets: vec![0; bucket_capacity],
            hash_mask,
        };
        for row_index in 0..index.ids.len() {
            index.insert_row(row_index, record_kind)?;
        }
        Ok(index)
    }

    fn bucket_capacity_for_len(len: usize) -> anyhow::Result<usize> {
        if len == 0 {
            return Ok(0);
        }
        if len > MAX_BELT_COUNT || len > u32::MAX as usize {
            bail!("native core row ID index capacity overflow");
        }
        let scaled = len
            .checked_mul(EXACT_ROW_ID_MAX_LOAD_DENOMINATOR)
            .and_then(|value| value.checked_add(EXACT_ROW_ID_MAX_LOAD_NUMERATOR - 1))
            .ok_or_else(|| anyhow!("native core row ID index capacity overflow"))?;
        let minimum = scaled / EXACT_ROW_ID_MAX_LOAD_NUMERATOR;
        minimum
            .checked_next_power_of_two()
            .ok_or_else(|| anyhow!("native core row ID index capacity overflow"))
    }

    #[inline]
    fn hash_with_mask(&self, id: &str) -> u64 {
        let mut hash = EXACT_ROW_ID_HASH_OFFSET;
        for byte in id.as_bytes() {
            hash ^= u64::from(*byte);
            hash = hash.wrapping_mul(EXACT_ROW_ID_HASH_PRIME);
        }
        hash & self.hash_mask
    }

    fn insert_row(&mut self, row_index: usize, record_kind: &'static str) -> anyhow::Result<()> {
        let id = &self.ids[row_index];
        let mask = self.buckets.len() - 1;
        let start = self.hash_with_mask(id) as usize & mask;
        let probe_count = self.buckets.len().min(EXACT_ROW_ID_MAX_PROBE_DISTANCE + 1);
        for distance in 0..probe_count {
            let bucket_index = start.wrapping_add(distance) & mask;
            let stored = self.buckets[bucket_index];
            if stored == 0 {
                self.buckets[bucket_index] = u32::try_from(row_index + 1)
                    .map_err(|_| anyhow!("native core {record_kind} ID row capacity overflow"))?;
                return Ok(());
            }
            let stored_row = stored as usize - 1;
            if &self.ids[stored_row] == id {
                bail!("native core {record_kind} ID is duplicated: {id}");
            }
        }
        bail!("native core {record_kind} ID index probe limit exceeded")
    }

    pub(crate) fn get(&self, id: &str) -> Option<&usize> {
        if self.buckets.is_empty() || id.is_empty() {
            return None;
        }
        let mask = self.buckets.len() - 1;
        let start = self.hash_with_mask(id) as usize & mask;
        let probe_count = self.buckets.len().min(EXACT_ROW_ID_MAX_PROBE_DISTANCE + 1);
        for distance in 0..probe_count {
            let bucket_index = start.wrapping_add(distance) & mask;
            let stored = self.buckets[bucket_index];
            if stored == 0 {
                return None;
            }
            let row_index = stored as usize - 1;
            if &self.ids[row_index] == id {
                return Some(self.ids.row_index(row_index));
            }
        }
        None
    }

    pub(crate) fn contains_key(&self, id: &str) -> bool {
        self.get(id).is_some()
    }

    pub(crate) fn len(&self) -> usize {
        self.ids.len()
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.ids.is_empty()
    }

    fn ids(&self) -> ExactRowIds {
        self.ids.clone()
    }

    fn estimated_bytes(&self) -> u64 {
        (self.buckets.capacity() * size_of::<u32>()) as u64
    }

    #[cfg(test)]
    fn from_boxed_with_hash_mask(
        ids: Vec<Box<str>>,
        record_kind: &'static str,
        hash_mask: u64,
    ) -> anyhow::Result<Self> {
        let ids = ExactRowIds::from_boxed(ids, record_kind)?;
        Self::from_ids(ids, record_kind, hash_mask)
    }
}

#[derive(Debug, Clone, Default)]
struct SaveDirtyPages {
    entity_pages: BTreeSet<usize>,
    belt_pages: BTreeSet<usize>,
    entity_topology: bool,
    belt_topology: bool,
}

impl SaveDirtyPages {
    fn mark_entity(&mut self, index: usize) {
        self.entity_pages
            .insert(index / ENTITY_CHECKPOINT_CHUNK_SIZE);
    }

    fn mark_belt(&mut self, index: usize) {
        self.belt_pages.insert(index / BELT_CHECKPOINT_CHUNK_SIZE);
    }

    fn mark_entity_topology(&mut self) {
        self.entity_topology = true;
        self.entity_pages.clear();
    }

    fn mark_belt_topology(&mut self) {
        self.belt_topology = true;
        self.belt_pages.clear();
    }

    fn clear(&mut self) {
        *self = Self::default();
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InternalCheckpointVisitResult {
    pub active_keys: Vec<String>,
    pub encoded_records: usize,
    pub reused_records: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct V47EnvelopeExportResult {
    pub revision: u64,
    pub saved_at_ms: u64,
    pub byte_length: u64,
    pub envelope_sha256: String,
    pub state_checksum: String,
}

struct Utf16Fnv1a {
    value: u32,
}

impl Utf16Fnv1a {
    fn new() -> Self {
        Self { value: 0x811c9dc5 }
    }

    fn update(&mut self, text: &str) {
        for unit in text.encode_utf16() {
            self.value ^= u32::from(unit);
            self.value = self.value.wrapping_mul(0x01000193);
        }
    }

    fn finish(&self) -> String {
        format!("{:08x}", self.value)
    }
}

/// Retired JSON graphs must be fully destroyed before an exact-advance ACK.
/// A detached reclaimer used to let process shutdown or the next large
/// allocation overlap tens of thousands of frees. The process-lifetime
/// deterministic pool may destroy large ownership chunks in parallel, but its
/// joined boundary still makes a successful return mean that no retired object
/// graph is live.
fn drop_retired_records_joined(entities: Vec<Value>, belts: Vec<Value>) {
    let profile_enabled = std::env::var_os("DSP_NATIVE_CORE_PROFILE").is_some();
    let started = std::time::Instant::now();
    let diagnostics = deterministic_runtime().drop_owned_joined(entities, belts);
    if profile_enabled {
        eprintln!(
            "DSP_NATIVE_CORE_PROFILE\trecord-drop-sync\t{:.3}",
            started.elapsed().as_secs_f64() * 1_000.0
        );
        eprintln!(
            "DSP_NATIVE_CORE_PROFILE\trecord-drop-sync-workers\t{}",
            diagnostics.worker_count
        );
        eprintln!(
            "DSP_NATIVE_CORE_PROFILE\trecord-drop-sync-chunks\t{}",
            diagnostics.chunk_count
        );
        eprintln!(
            "DSP_NATIVE_CORE_PROFILE\trecord-drop-sync-items\t{}",
            diagnostics.item_count
        );
    }
}

struct DeferredRecordDrop {
    entities: Vec<Value>,
    belts: Vec<Value>,
}

fn deferred_record_drop_sender() -> &'static SyncSender<DeferredRecordDrop> {
    static SENDER: OnceLock<SyncSender<DeferredRecordDrop>> = OnceLock::new();
    SENDER.get_or_init(|| {
        // A zero-capacity handoff allows at most one retired parsed graph to be
        // reclaimed while the next step runs. If the prior batch is still
        // being destroyed, the next handoff applies backpressure instead of
        // growing an unbounded queue of full save graphs.
        let (sender, receiver) = sync_channel::<DeferredRecordDrop>(0);
        if std::thread::Builder::new()
            .name("dsp-native-record-reclaimer".to_owned())
            .spawn(move || {
                while let Ok(batch) = receiver.recv() {
                    let DeferredRecordDrop { entities, belts } = batch;
                    drop(entities);
                    drop(belts);
                }
            })
            .is_err()
        {
            // A disconnected receiver returns the complete batch to send(),
            // where it is synchronously destroyed without losing ownership.
        }
        sender
    })
}

fn resolve_sync_record_drop(value: Option<&str>) -> bool {
    matches!(value, Some("1"))
}

fn sync_record_drop_enabled() -> bool {
    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(|| {
        let value = std::env::var("DSP_NATIVE_CORE_SYNC_RECORD_DROP").ok();
        resolve_sync_record_drop(value.as_deref())
    })
}

fn retire_record_values(entities: Vec<Value>, belts: Vec<Value>) {
    if sync_record_drop_enabled() {
        drop_retired_records_joined(entities, belts);
        return;
    }

    let profile_enabled = std::env::var_os("DSP_NATIVE_CORE_PROFILE").is_some();
    let started = std::time::Instant::now();
    if let Err(error) = deferred_record_drop_sender().send(DeferredRecordDrop { entities, belts }) {
        drop(error.0);
    }
    if profile_enabled {
        eprintln!(
            "DSP_NATIVE_CORE_PROFILE\trecord-drop-deferred-submit\t{:.3}",
            started.elapsed().as_secs_f64() * 1_000.0
        );
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreCheckpointIdentity {
    pub slot: String,
    pub generation: u64,
    pub root_hash: String,
    pub revision: u64,
    pub state_version: u16,
    pub mode: String,
    pub registry_fingerprint: String,
    /// Checksum of the last compatible v47 primary on which this sidecar is
    /// based. It intentionally remains stable while native generations move
    /// forward so the existing v47 recovery adapter can rebuild an exact,
    /// newer envelope without changing the public save format.
    pub base_primary_checksum: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeMemoryEstimate {
    pub raw_record_bytes: u64,
    pub indexed_string_bytes: u64,
    pub inventory_entry_count: u64,
    pub topology_index_bytes: u64,
    pub estimated_runtime_bytes: u64,
}

/// Per-commit evidence for deterministic full entity encoding. Every row is
/// encoded from the final Value; byte-identical rows retain their authoritative
/// `Arc<str>`, while changed rows become dirty replacement records.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EntityRawWritebackDiagnostics {
    pub full_encoded_rows: usize,
    pub shared_rows: usize,
    pub changed_rows: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DomainCoverage {
    pub state_container: bool,
    pub command_patches: bool,
    pub quiescent_clock: bool,
    pub infinite_solid_mining: bool,
    pub finite_solid_mining: bool,
    pub fluid_mining: bool,
    pub wind_power: bool,
    pub renewable_power: bool,
    pub fuel_power: bool,
    pub energy_storage: bool,
    pub power_priorities: bool,
    pub ordinary_production: bool,
    pub proliferated_production: bool,
    pub finite_research: bool,
    pub infinite_research: bool,
    pub ordinary_belts: bool,
    pub storage_and_splitters: bool,
    pub planetary_logistics: bool,
    pub same_system_interstellar_logistics: bool,
    pub direct_warp_logistics: bool,
    pub relay_logistics: bool,
    pub orbital_collectors: bool,
    pub station_warper_auto_refill: bool,
    pub quantum_logistics_network: bool,
    pub quantum_local_drone_bridge: bool,
    pub quantum_belt_bridge: bool,
    pub persisted_construction_jobs: bool,
    pub construction_quantum_prefetch: bool,
    pub recursive_construction_planning: bool,
    pub portable_fleet_construction: bool,
    pub construction_byproduct_settlement: bool,
    pub construction_arithmetic_batching: bool,
    pub quantum_attachment_transitions: bool,
    pub inactive_time_warp_controller: bool,
    pub active_time_warp_power: bool,
    pub unified_advance_budgets: bool,
    pub dyson_swarm_and_sphere: bool,
    pub dyson_launchers: bool,
    pub dyson_ray_receivers: bool,
    pub orbital_cargo_terminals: bool,
    pub station_contract_refresh: bool,
    pub system_space_station_construction: bool,
    pub system_hub_logistics: bool,
    pub elevator_belts: bool,
    pub station_mode_transitions: bool,
    pub campaign_progress: bool,
    pub handcraft_queue: bool,
    pub exploration_missions: bool,
    pub galactic_exports: bool,
    pub speedrun_clock_and_milestones: bool,
    pub exact_segmented_offline: bool,
    pub pure_idle_macro: bool,
    pub mining: bool,
    pub production: bool,
    pub research: bool,
    pub belts: bool,
    pub logistics: bool,
    pub power: bool,
    pub dyson: bool,
    pub construction: bool,
    pub space_station: bool,
    pub offline_and_time_warp: bool,
    pub content_packs: bool,
    pub authority_eligible: bool,
}

impl DomainCoverage {
    pub fn implemented_beta_scope() -> Self {
        Self {
            state_container: true,
            command_patches: true,
            quiescent_clock: true,
            infinite_solid_mining: true,
            finite_solid_mining: true,
            fluid_mining: true,
            wind_power: true,
            renewable_power: true,
            fuel_power: true,
            energy_storage: true,
            power_priorities: true,
            ordinary_production: true,
            proliferated_production: true,
            finite_research: true,
            infinite_research: true,
            ordinary_belts: true,
            storage_and_splitters: true,
            planetary_logistics: true,
            same_system_interstellar_logistics: true,
            direct_warp_logistics: true,
            relay_logistics: true,
            orbital_collectors: true,
            station_warper_auto_refill: true,
            quantum_logistics_network: true,
            quantum_local_drone_bridge: true,
            quantum_belt_bridge: true,
            persisted_construction_jobs: true,
            construction_quantum_prefetch: true,
            recursive_construction_planning: true,
            portable_fleet_construction: true,
            construction_byproduct_settlement: true,
            construction_arithmetic_batching: true,
            quantum_attachment_transitions: true,
            inactive_time_warp_controller: true,
            active_time_warp_power: true,
            unified_advance_budgets: true,
            dyson_swarm_and_sphere: true,
            dyson_launchers: true,
            dyson_ray_receivers: true,
            orbital_cargo_terminals: true,
            station_contract_refresh: true,
            system_space_station_construction: true,
            system_hub_logistics: true,
            elevator_belts: true,
            station_mode_transitions: true,
            campaign_progress: true,
            handcraft_queue: true,
            exploration_missions: true,
            galactic_exports: true,
            speedrun_clock_and_milestones: true,
            exact_segmented_offline: true,
            pure_idle_macro: false,
            mining: true,
            production: true,
            research: true,
            belts: true,
            logistics: true,
            power: true,
            dyson: true,
            construction: true,
            space_station: true,
            offline_and_time_warp: false,
            content_packs: true,
            authority_eligible: false,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreStateSummary {
    pub revision: u64,
    pub state_version: u16,
    pub mode: String,
    pub active_planet_id: String,
    pub elapsed_seconds: f64,
    pub paused: bool,
    pub entity_count: usize,
    pub belt_count: usize,
    pub canonical_sha256: String,
    pub canonical_components: BTreeMap<String, String>,
    pub canonical_fields: BTreeMap<String, String>,
    pub domain_sha256: String,
    pub catalog_sha256: String,
    pub registry_fingerprint: String,
    pub memory: RuntimeMemoryEstimate,
    pub coverage: DomainCoverage,
}

struct CanonicalDigestBundle {
    canonical_sha256: String,
    canonical_components: BTreeMap<String, String>,
    canonical_fields: BTreeMap<String, String>,
    domain_sha256: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChunkMetadata {
    id: String,
    kind: String,
    offset: usize,
    count: usize,
    checksum: String,
    bytes: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    sha256: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BaseCheckpointDomain {
    Core,
    Logistics,
    Dyson,
    Statistics,
    Unknown,
}

const BASE_CHECKPOINT_DOMAINS: [BaseCheckpointDomain; 5] = [
    BaseCheckpointDomain::Core,
    BaseCheckpointDomain::Logistics,
    BaseCheckpointDomain::Dyson,
    BaseCheckpointDomain::Statistics,
    BaseCheckpointDomain::Unknown,
];

impl BaseCheckpointDomain {
    fn id(self) -> &'static str {
        match self {
            Self::Core => "base:core",
            Self::Logistics => "base:logistics",
            Self::Dyson => "base:dyson",
            Self::Statistics => "base:statistics",
            Self::Unknown => "base:unknown-mod",
        }
    }

    fn kind(self) -> &'static str {
        match self {
            Self::Core => "base-core",
            Self::Logistics => "base-logistics",
            Self::Dyson => "base-dyson",
            Self::Statistics => "base-statistics",
            Self::Unknown => "base-unknown-mod",
        }
    }
}

fn classify_base_checkpoint_key(key: &str) -> BaseCheckpointDomain {
    match key {
        "cargo"
        | "tray"
        | "planetTrays"
        | "planetTrayItemLimits"
        | "portableFleet"
        | "systemSpaceStations"
        | "galacticHubNetwork"
        | "quantumLogisticsNetwork"
        | "orbitalStation" => BaseCheckpointDomain::Logistics,
        "dysonSwarm" | "dysonSphere" | "dysonEngineering" | "dysonPlans" => {
            BaseCheckpointDomain::Dyson
        }
        "manualMined" | "totalProduced" | "productionHistory" | "historyRecordedAt" | "metrics"
        | "planetMetrics" | "powerGridMetrics" => BaseCheckpointDomain::Statistics,
        "version"
        | "mode"
        | "nextId"
        | "activePlanetId"
        | "construction"
        | "constructionAutomation"
        | "research"
        | "exploration"
        | "galaxy"
        | "recipeFocus"
        | "settings"
        | "contentPacks"
        | "achievements"
        | "campaign"
        | "planetViewports"
        | "canvasBookmarks"
        | "canvasRegions"
        | "blueprints"
        | "blueprintVersions"
        | "constructionQueue"
        | "handcraftQueue"
        | "productionPlans"
        | "idleSettlement"
        | "speedrun"
        | "elapsedSeconds"
        | "timeWarp"
        | "endgame"
        | "paused" => BaseCheckpointDomain::Core,
        _ => BaseCheckpointDomain::Unknown,
    }
}

pub(crate) fn is_known_base_checkpoint_key(key: &str) -> bool {
    classify_base_checkpoint_key(key) != BaseCheckpointDomain::Unknown
}

struct BaseCheckpointDomainView<'a> {
    base: &'a Map<String, Value>,
    domain: BaseCheckpointDomain,
}

impl BaseCheckpointDomainView<'_> {
    fn field_count(&self) -> usize {
        self.base
            .keys()
            .filter(|key| classify_base_checkpoint_key(key) == self.domain)
            .count()
    }
}

impl Serialize for BaseCheckpointDomainView<'_> {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let mut output = serializer.serialize_map(Some(self.field_count()))?;
        for (key, value) in self.base {
            if classify_base_checkpoint_key(key) == self.domain {
                output.serialize_entry(key, value)?;
            }
        }
        output.end()
    }
}

fn encode_base_checkpoint_domain(
    base: &Map<String, Value>,
    domain: BaseCheckpointDomain,
) -> anyhow::Result<(String, usize)> {
    if base.contains_key("entities") || base.contains_key("belts") {
        bail!("native core base contains an unbounded collection");
    }
    let view = BaseCheckpointDomainView { base, domain };
    let count = view.field_count();
    Ok((serde_json::to_string(&view)?, count))
}

fn checkpoint_chunk_metadata(
    id: impl Into<String>,
    kind: impl Into<String>,
    offset: usize,
    count: usize,
    text: &str,
) -> ChunkMetadata {
    ChunkMetadata {
        id: id.into(),
        kind: kind.into(),
        offset,
        count,
        checksum: fnv1a_utf8(text.as_bytes()),
        bytes: text.len(),
        sha256: Some(hex::encode(Sha256::digest(text.as_bytes()))),
    }
}

fn checkpoint_chunk_content_matches(left: &ChunkMetadata, right: &ChunkMetadata) -> bool {
    left.id == right.id
        && left.kind == right.kind
        && left.offset == right.offset
        && left.count == right.count
        && left.checksum == right.checksum
        && left.bytes == right.bytes
        && left.sha256.is_some()
        && left.sha256 == right.sha256
}

fn checkpoint_chunk_has_valid_sha256_metadata(metadata: &ChunkMetadata) -> bool {
    metadata.sha256.as_ref().is_some_and(|expected| {
        expected.len() == 64 && expected.bytes().all(|byte| byte.is_ascii_hexdigit())
    })
}

fn checkpoint_root_material(metadata: &[ChunkMetadata]) -> anyhow::Result<String> {
    let mut material = String::new();
    for chunk in metadata {
        use std::fmt::Write as _;
        write!(
            material,
            "{}:{}:{}:{}:{}:{}:{};",
            chunk.id,
            chunk.kind,
            chunk.offset,
            chunk.count,
            chunk.checksum,
            chunk.bytes,
            chunk.sha256.as_deref().unwrap_or("-")
        )?;
    }
    Ok(material)
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChunkedManifest {
    format_version: u16,
    envelope_format_version: u16,
    mode: String,
    state_version: u16,
    base_primary_checksum: String,
    chunk_root_checksum: String,
    entity_count: usize,
    belt_count: usize,
    chunks: Vec<ChunkMetadata>,
    #[serde(default, deserialize_with = "deserialize_present_pure_idle_session")]
    pure_idle_session: Option<PureIdleSessionState>,
    // Kept separate from the legacy field so an older native host can ignore
    // the new private cache instead of rejecting the whole checkpoint because
    // PureIdleSessionState uses deny_unknown_fields.
    #[serde(default, deserialize_with = "deserialize_present_pure_idle_session")]
    pure_idle_macro_session: Option<PureIdleSessionState>,
}

fn deserialize_present_pure_idle_session<'de, D>(
    deserializer: D,
) -> Result<Option<PureIdleSessionState>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    PureIdleSessionState::deserialize(deserializer).map(Some)
}

/// Private native-checkpoint state for one continuous conservative pure-idle
/// session. This never enters the public v47 GameState or envelope schema.
///
/// A revision mismatch means a command or exact/realtime advance committed
/// after the last pure-idle slice. The next pure-idle request then starts a new
/// session lazily, without adding hooks to every command/simulation path.
#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PureIdleSessionState {
    format_version: u8,
    exact_simulation_seconds_used: f64,
    last_committed_revision: u64,
    #[serde(default, skip_serializing_if = "is_false")]
    macro_v10: bool,
}

fn is_false(value: &bool) -> bool {
    !*value
}

impl PureIdleSessionState {
    fn validate(self, checkpoint_revision: u64) -> anyhow::Result<Self> {
        if self.format_version != PURE_IDLE_SESSION_FORMAT_VERSION
            || !self.exact_simulation_seconds_used.is_finite()
            || !(0.0..=PURE_IDLE_SESSION_EXACT_CREDIT_SECONDS)
                .contains(&self.exact_simulation_seconds_used)
            || self.last_committed_revision != checkpoint_revision
        {
            bail!("native core pure-idle session checkpoint is invalid");
        }
        Ok(self)
    }
}

#[derive(Debug, Default, Clone)]
pub(crate) struct Symbols {
    values: Vec<Box<str>>,
    by_value: HashMap<String, u32>,
}

impl Symbols {
    fn intern(&mut self, value: Option<&str>) -> u32 {
        let Some(value) = value else {
            return NONE_SYMBOL;
        };
        if let Some(index) = self.by_value.get(value) {
            return *index;
        }
        let index = self.values.len() as u32;
        self.values.push(value.into());
        self.by_value.insert(value.to_owned(), index);
        index
    }

    pub(crate) fn resolve(&self, value: u32) -> Option<&str> {
        if value == NONE_SYMBOL {
            None
        } else {
            self.values.get(value as usize).map(AsRef::as_ref)
        }
    }

    pub(crate) fn lookup(&self, value: &str) -> Option<u32> {
        self.by_value.get(value).copied()
    }

    fn estimated_bytes(&self) -> u64 {
        let text = self
            .values
            .iter()
            .map(|value| value.len() as u64)
            .sum::<u64>()
            + self
                .by_value
                .keys()
                .map(|value| value.len() as u64)
                .sum::<u64>();
        text + (self.values.capacity() * size_of::<Box<str>>()) as u64
            + (self.by_value.capacity() * (size_of::<String>() + size_of::<u32>())) as u64
    }
}

/// Sparse ordering scratch used only while hashing inventory objects.
///
/// The resident symbol table already owns every topology/static string in the
/// save. The former digest path cloned that whole table (including all entity
/// and belt endpoint IDs) merely so the few inventory-only extension IDs could
/// be assigned the same trailing indexes. Keep the resident table borrowed and
/// own only those genuinely missing strings instead.
#[derive(Debug)]
struct DomainSymbolOrder<'a> {
    base: &'a Symbols,
    additional_by_value: HashMap<Box<str>, u32>,
}

impl<'a> DomainSymbolOrder<'a> {
    fn new(base: &'a Symbols) -> Self {
        Self {
            base,
            additional_by_value: HashMap::new(),
        }
    }

    fn rank(&mut self, value: &str) -> u32 {
        if let Some(index) = self.base.lookup(value) {
            return index;
        }
        if let Some(index) = self.additional_by_value.get(value) {
            return *index;
        }
        // This is byte-for-byte the index the old `Symbols::clone().intern()`
        // path assigned: base length plus first-seen missing strings.
        let index = (self.base.values.len() + self.additional_by_value.len()) as u32;
        self.additional_by_value.insert(value.into(), index);
        index
    }

    #[cfg(test)]
    fn additional_len(&self) -> usize {
        self.additional_by_value.len()
    }

    #[cfg(test)]
    fn additional_text_bytes(&self) -> usize {
        self.additional_by_value
            .keys()
            .map(|value| value.len())
            .sum()
    }
}

#[derive(Debug)]
struct DomainInventoryEntry<'a> {
    item: &'a str,
    rank: u32,
    amount: f64,
}

pub(crate) type RawRecord = Arc<str>;

#[derive(Debug, Clone, Default)]
pub(crate) struct EntityColumns {
    pub ids: ExactRowIds,
    pub kinds: Vec<u32>,
    pub planets: Vec<u32>,
    pub buildings: Vec<u32>,
    pub recipes: Vec<u32>,
    pub resources: Vec<u32>,
    pub stored_items: Vec<u32>,
    pub machine_counts: Vec<f64>,
    pub miner_counts: Vec<f64>,
    pub position_x: Vec<f64>,
    pub position_y: Vec<f64>,
}

impl EntityColumns {
    fn with_capacity(rows: usize) -> Self {
        Self {
            ids: ExactRowIds::default(),
            kinds: Vec::with_capacity(rows),
            planets: Vec::with_capacity(rows),
            buildings: Vec::with_capacity(rows),
            recipes: Vec::with_capacity(rows),
            resources: Vec::with_capacity(rows),
            stored_items: Vec::with_capacity(rows),
            machine_counts: Vec::with_capacity(rows),
            miner_counts: Vec::with_capacity(rows),
            position_x: Vec::with_capacity(rows),
            position_y: Vec::with_capacity(rows),
        }
    }
}

/// Exact JSON shape retained by the resident entity columns. Raw entity JSON
/// remains authoritative, but consumers can distinguish an absent field from
/// an explicit `null`, a finite number, and a malformed/MOD value without
/// reparsing the record. Two bits are sufficient for every state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum ResidentValueKind {
    Missing = 0,
    Number = 1,
    Null = 2,
    Other = 3,
}

impl ResidentValueKind {
    fn classify(value: Option<&Value>) -> (Self, f64) {
        match value {
            None => (Self::Missing, 0.0),
            Some(Value::Null) => (Self::Null, 0.0),
            Some(Value::Number(number)) => number
                .as_f64()
                .filter(|number| number.is_finite())
                .map_or((Self::Other, 0.0), |number| (Self::Number, number)),
            Some(_) => (Self::Other, 0.0),
        }
    }
}

/// Shape tag for the `inputs` and `outputs` containers. Object is distinct
/// from Number even though both tags fit in the same two-bit footprint.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum ResidentObjectKind {
    Missing = 0,
    Object = 1,
    Null = 2,
    Other = 3,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ResidentNumber {
    kind: ResidentValueKind,
    value: f64,
}

impl ResidentNumber {
    pub fn kind(self) -> ResidentValueKind {
        self.kind
    }

    /// Returns the exact resident IEEE value only for a JSON number. This
    /// preserves negative zero; missing, null and malformed values stay
    /// distinguishable through `kind()` and do not silently become zero.
    pub fn as_f64(self) -> Option<f64> {
        (self.kind == ResidentValueKind::Number).then_some(self.value)
    }
}

/// The first E1 scalar set is intentionally narrow: these are the fields read
/// repeatedly by exact simulation/history and the persisted cursor/transfer
/// signals needed to describe power and delivery state. Adding a field here is
/// an internal layout change only; public v47 JSON is not changed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum EntityDynamicField {
    ProductionRate = 0,
    Utilization = 1,
    Progress = 2,
    PowerFactor = 3,
    StationProgress = 4,
    StationLastTransfer = 5,
    RoutingCursor = 6,
}

impl EntityDynamicField {
    #[cfg(test)]
    const COUNT: usize = 7;
    #[cfg(test)]
    const ALL: [Self; Self::COUNT] = [
        Self::ProductionRate,
        Self::Utilization,
        Self::Progress,
        Self::PowerFactor,
        Self::StationProgress,
        Self::StationLastTransfer,
        Self::RoutingCursor,
    ];

    fn key(self) -> &'static str {
        match self {
            Self::ProductionRate => "productionRate",
            Self::Utilization => "utilization",
            Self::Progress => "progress",
            Self::PowerFactor => "powerFactor",
            Self::StationProgress => "stationProgress",
            Self::StationLastTransfer => "stationLastTransfer",
            Self::RoutingCursor => "routingCursor",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EntityInventorySide {
    Inputs,
    Outputs,
}

#[derive(Debug, Clone)]
pub(crate) struct EntityDynamicColumns {
    /// The former 7*f64 + CSR resident mirror had no production consumer.
    /// Values are decoded lazily from raw rows; this descriptor retains only
    /// topology and diagnostic inventory cardinality.
    row_count: usize,
    inventory_entry_count: usize,
}

impl Default for EntityDynamicColumns {
    fn default() -> Self {
        Self::with_capacity(0)
    }
}

impl EntityDynamicColumns {
    fn with_capacity(_rows: usize) -> Self {
        Self {
            row_count: 0,
            inventory_entry_count: 0,
        }
    }

    fn push_from_object(&mut self, object: &Map<String, Value>) -> anyhow::Result<()> {
        self.row_count = self
            .row_count
            .checked_add(1)
            .ok_or_else(|| anyhow!("native entity dynamic row count overflow"))?;
        let entries = ["inputs", "outputs"]
            .into_iter()
            .filter_map(|key| object.get(key).and_then(Value::as_object))
            .map(Map::len)
            .sum::<usize>();
        self.inventory_entry_count = self
            .inventory_entry_count
            .checked_add(entries)
            .ok_or_else(|| anyhow!("native entity inventory entry count overflow"))?;
        Ok(())
    }

    fn from_full_encode(row_count: usize, inventory_entry_count: usize) -> Self {
        Self {
            row_count,
            inventory_entry_count,
        }
    }

    fn validate(&self, expected_rows: usize) -> anyhow::Result<()> {
        if self.row_count != expected_rows {
            bail!("native entity lazy descriptor topology changed");
        }
        Ok(())
    }

    fn bitwise_eq(&self, other: &Self) -> bool {
        self.row_count == other.row_count
            && self.inventory_entry_count == other.inventory_entry_count
    }

    fn inventory_entry_count(&self) -> usize {
        self.inventory_entry_count
    }

    fn estimated_bytes(&self) -> u64 {
        0
    }
}

#[derive(Debug, Clone, Copy)]
pub struct EntityInventoryEntry<'a> {
    item_id: &'a str,
    amount: ResidentNumber,
}

impl<'a> EntityInventoryEntry<'a> {
    pub fn item_id(self) -> &'a str {
        self.item_id
    }

    pub fn amount(self) -> ResidentNumber {
        self.amount
    }
}

#[derive(Debug, Clone)]
struct OwnedEntityInventoryEntry {
    item_id: Box<str>,
    amount: ResidentNumber,
}

#[derive(Debug, Clone)]
pub struct EntityInventoryView {
    container_kind: ResidentObjectKind,
    entries: Vec<OwnedEntityInventoryEntry>,
}

impl EntityInventoryView {
    pub fn container_kind(&self) -> ResidentObjectKind {
        self.container_kind
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn entries(&self) -> impl ExactSizeIterator<Item = EntityInventoryEntry<'_>> + '_ {
        self.entries.iter().map(|entry| EntityInventoryEntry {
            item_id: &entry.item_id,
            amount: entry.amount,
        })
    }

    pub fn get(&self, item_id: &str) -> Option<ResidentNumber> {
        self.entries
            .iter()
            .find(|entry| entry.item_id.as_ref() == item_id)
            .map(|entry| entry.amount)
    }
}

#[derive(Debug, Clone, Default)]
pub(crate) struct BeltColumns {
    pub ids: ExactRowIds,
    pub planets: Vec<u32>,
    pub sources: Vec<u32>,
    pub targets: Vec<u32>,
    pub items: Vec<u32>,
    pub lanes: Vec<f64>,
    pub tiers: Vec<u8>,
    pub stack_sizes: Vec<f64>,
    pub priorities: Vec<u8>,
}

impl BeltColumns {
    fn with_capacity(rows: usize) -> Self {
        Self {
            ids: ExactRowIds::default(),
            planets: Vec::with_capacity(rows),
            sources: Vec::with_capacity(rows),
            targets: Vec::with_capacity(rows),
            items: Vec::with_capacity(rows),
            lanes: Vec::with_capacity(rows),
            tiers: Vec::with_capacity(rows),
            stack_sizes: Vec::with_capacity(rows),
            priorities: Vec::with_capacity(rows),
        }
    }
}

pub(crate) const BELT_DYNAMIC_PAGE_ROWS: usize = 1_024;
const BELT_DYNAMIC_GROUP_PAGES: usize = 64;
const BELT_DYNAMIC_GROUPS: usize = 64;
const BELT_DYNAMIC_MAX_ROWS: usize =
    BELT_DYNAMIC_PAGE_ROWS * BELT_DYNAMIC_GROUP_PAGES * BELT_DYNAMIC_GROUPS;
const BELT_DYNAMIC_PAGE_BITMAP_WORDS: usize =
    BELT_DYNAMIC_GROUP_PAGES * BELT_DYNAMIC_GROUPS / u64::BITS as usize;

#[derive(Debug, Clone)]
struct BeltPagedGroup<T: Copy> {
    pages: [Option<Arc<[T; BELT_DYNAMIC_PAGE_ROWS]>>; BELT_DYNAMIC_GROUP_PAGES],
}

impl<T: Copy> Default for BeltPagedGroup<T> {
    fn default() -> Self {
        Self {
            pages: std::array::from_fn(|_| None),
        }
    }
}

/// Fixed-depth, page-granular clone-on-write storage for mutable belt signals.
///
/// The maximum v47 belt count fits in 64 top-level groups, each containing 64
/// independently shared 1,024-row pages. Cloning a column therefore copies a
/// fixed 64 Arc directory entries rather than `len` values. A sparse write
/// clones at most one 64-entry group directory and one bounded page per newly
/// touched page. Missing pages read as the column default, which lets runtime-
/// only boolean evidence start at logical length B without allocating B bits.
#[derive(Debug, Clone)]
pub(crate) struct BeltPagedColumn<T: Copy> {
    len: usize,
    default_value: T,
    groups: [Option<Arc<BeltPagedGroup<T>>>; BELT_DYNAMIC_GROUPS],
    dirty_pages: [u64; BELT_DYNAMIC_PAGE_BITMAP_WORDS],
    allocated_pages: usize,
}

impl<T: Copy + Default> Default for BeltPagedColumn<T> {
    fn default() -> Self {
        Self::with_len_default(0)
    }
}

impl<T: Copy + Default> BeltPagedColumn<T> {
    pub(crate) fn with_len_default(len: usize) -> Self {
        assert!(
            len <= BELT_DYNAMIC_MAX_ROWS,
            "native belt paged column exceeds its fixed address space"
        );
        Self {
            len,
            default_value: T::default(),
            groups: std::array::from_fn(|_| None),
            dirty_pages: [0; BELT_DYNAMIC_PAGE_BITMAP_WORDS],
            allocated_pages: 0,
        }
    }

    #[inline]
    pub(crate) fn len(&self) -> usize {
        self.len
    }

    #[inline]
    pub(crate) fn is_empty(&self) -> bool {
        self.len == 0
    }

    pub(crate) fn push(&mut self, value: T) -> anyhow::Result<()> {
        if self.len == BELT_DYNAMIC_MAX_ROWS {
            bail!("native belt paged column exceeds its fixed address space");
        }
        let index = self.len;
        self.len += 1;
        self[index] = value;
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn pop(&mut self) -> Option<T> {
        let index = self.len.checked_sub(1)?;
        let value = self[index];
        self.len = index;
        Some(value)
    }

    #[inline]
    fn page_coordinates(index: usize) -> (usize, usize, usize, usize) {
        let page_index = index / BELT_DYNAMIC_PAGE_ROWS;
        (
            page_index,
            page_index / BELT_DYNAMIC_GROUP_PAGES,
            page_index % BELT_DYNAMIC_GROUP_PAGES,
            index % BELT_DYNAMIC_PAGE_ROWS,
        )
    }

    #[inline]
    fn page(&self, page_index: usize) -> Option<&Arc<[T; BELT_DYNAMIC_PAGE_ROWS]>> {
        let group_index = page_index / BELT_DYNAMIC_GROUP_PAGES;
        let group_page = page_index % BELT_DYNAMIC_GROUP_PAGES;
        self.groups[group_index]
            .as_ref()
            .and_then(|group| group.pages[group_page].as_ref())
    }

    fn page_mut(&mut self, page_index: usize) -> &mut [T; BELT_DYNAMIC_PAGE_ROWS] {
        let group_index = page_index / BELT_DYNAMIC_GROUP_PAGES;
        let group_page = page_index % BELT_DYNAMIC_GROUP_PAGES;
        let group =
            self.groups[group_index].get_or_insert_with(|| Arc::new(BeltPagedGroup::default()));
        let group = Arc::make_mut(group);
        let page = group.pages[group_page].get_or_insert_with(|| {
            self.allocated_pages += 1;
            Arc::new([self.default_value; BELT_DYNAMIC_PAGE_ROWS])
        });
        Arc::make_mut(page)
    }

    #[inline]
    fn mark_page_dirty(&mut self, page_index: usize) {
        self.dirty_pages[page_index / u64::BITS as usize] |=
            1_u64 << (page_index % u64::BITS as usize);
    }

    pub(crate) fn clear_dirty(&mut self) {
        self.dirty_pages.fill(0);
    }

    pub(crate) fn dirty_page_count(&self) -> usize {
        self.dirty_pages
            .iter()
            .map(|word| word.count_ones() as usize)
            .sum()
    }

    fn dirty_page_words(&self) -> &[u64; BELT_DYNAMIC_PAGE_BITMAP_WORDS] {
        &self.dirty_pages
    }

    pub(crate) fn iter(&self) -> BeltPagedIter<'_, T> {
        BeltPagedIter {
            column: self,
            index: 0,
        }
    }

    /// Materializes and uniquely owns every logical page. Callers use this
    /// only after the active selector deliberately chose the dense fallback.
    /// Sparse revisions must never call it.
    pub(crate) fn materialized_pages_mut(&mut self) -> Vec<&mut [T]> {
        let page_count = self.len.div_ceil(BELT_DYNAMIC_PAGE_ROWS);
        for page_index in 0..page_count {
            self.mark_page_dirty(page_index);
        }
        let mut remaining = self.len;
        let mut pages = Vec::with_capacity(page_count);
        for group_slot in &mut self.groups {
            if remaining == 0 {
                break;
            }
            let group = group_slot.get_or_insert_with(|| Arc::new(BeltPagedGroup::default()));
            let group = Arc::make_mut(group);
            for page_slot in &mut group.pages {
                if remaining == 0 {
                    break;
                }
                let page = page_slot.get_or_insert_with(|| {
                    self.allocated_pages += 1;
                    Arc::new([self.default_value; BELT_DYNAMIC_PAGE_ROWS])
                });
                let used = remaining.min(BELT_DYNAMIC_PAGE_ROWS);
                pages.push(&mut Arc::make_mut(page)[..used]);
                remaining -= used;
            }
        }
        debug_assert_eq!(remaining, 0);
        pages
    }

    fn estimated_bytes(&self) -> u64 {
        let group_count = self.groups.iter().filter(|group| group.is_some()).count();
        (group_count * size_of::<BeltPagedGroup<T>>()
            + self.allocated_pages * size_of::<[T; BELT_DYNAMIC_PAGE_ROWS]>()) as u64
    }

    #[cfg(test)]
    pub(crate) fn changed_page_count_from(&self, source: &Self) -> usize {
        let page_count = self.len.max(source.len).div_ceil(BELT_DYNAMIC_PAGE_ROWS);
        (0..page_count)
            .filter(
                |&page_index| match (self.page(page_index), source.page(page_index)) {
                    (Some(left), Some(right)) => !Arc::ptr_eq(left, right),
                    (None, None) => false,
                    _ => true,
                },
            )
            .count()
    }
}

impl<T: Copy + Default> Index<usize> for BeltPagedColumn<T> {
    type Output = T;

    fn index(&self, index: usize) -> &Self::Output {
        assert!(
            index < self.len,
            "native belt paged column index out of bounds"
        );
        let (page_index, _, _, offset) = Self::page_coordinates(index);
        self.page(page_index)
            .map_or(&self.default_value, |page| &page[offset])
    }
}

impl<T: Copy + Default> IndexMut<usize> for BeltPagedColumn<T> {
    fn index_mut(&mut self, index: usize) -> &mut Self::Output {
        assert!(
            index < self.len,
            "native belt paged column index out of bounds"
        );
        let (page_index, _, _, offset) = Self::page_coordinates(index);
        self.mark_page_dirty(page_index);
        &mut self.page_mut(page_index)[offset]
    }
}

pub(crate) struct BeltPagedIter<'a, T: Copy + Default> {
    column: &'a BeltPagedColumn<T>,
    index: usize,
}

impl<'a, T: Copy + Default> Iterator for BeltPagedIter<'a, T> {
    type Item = &'a T;

    fn next(&mut self) -> Option<Self::Item> {
        if self.index == self.column.len {
            return None;
        }
        let index = self.index;
        self.index += 1;
        Some(&self.column[index])
    }

    fn size_hint(&self) -> (usize, Option<usize>) {
        let remaining = self.column.len - self.index;
        (remaining, Some(remaining))
    }
}

impl<T: Copy + Default> ExactSizeIterator for BeltPagedIter<'_, T> {}

impl<'a, T: Copy + Default> IntoIterator for &'a BeltPagedColumn<T> {
    type Item = &'a T;
    type IntoIter = BeltPagedIter<'a, T>;

    fn into_iter(self) -> Self::IntoIter {
        self.iter()
    }
}

impl<T: Copy + Default> FromIterator<T> for BeltPagedColumn<T> {
    fn from_iter<I: IntoIterator<Item = T>>(values: I) -> Self {
        let mut column = Self::default();
        for value in values {
            column
                .push(value)
                .expect("native belt paged iterator exceeds fixed address space");
        }
        column
    }
}

/// Compact authoritative mirror of the four mutable belt signals. The raw JSON
/// records remain the persistence/canonical source of truth; these columns are
/// rebuilt from raw records on load/topology commands and replaced only with a
/// fully validated simulation candidate. `number_mask` preserves whether each
/// value was a finite JSON number, while the f64 columns preserve its exact
/// IEEE bits (including negative zero).
#[derive(Debug, Clone, Default)]
pub(crate) struct BeltDynamicColumns {
    pub progress: BeltPagedColumn<f64>,
    pub total_transferred: BeltPagedColumn<f64>,
    pub congestion: BeltPagedColumn<f64>,
    pub last_flow: BeltPagedColumn<f64>,
    pub number_mask: BeltPagedColumn<u8>,
    missing_required_rows: Vec<u32>,
}

impl BeltDynamicColumns {
    pub(crate) const PROGRESS: usize = 0;
    pub(crate) const TOTAL_TRANSFERRED: usize = 1;
    pub(crate) const CONGESTION: usize = 2;
    pub(crate) const LAST_FLOW: usize = 3;
    const VALID_MASK: u8 = (1 << 4) - 1;

    fn with_capacity(rows: usize) -> Self {
        assert!(rows <= MAX_BELT_COUNT);
        Self {
            progress: BeltPagedColumn::default(),
            total_transferred: BeltPagedColumn::default(),
            congestion: BeltPagedColumn::default(),
            last_flow: BeltPagedColumn::default(),
            number_mask: BeltPagedColumn::default(),
            missing_required_rows: Vec::new(),
        }
    }

    pub(crate) fn from_runtime_columns(
        progress: BeltPagedColumn<f64>,
        total_transferred: BeltPagedColumn<f64>,
        congestion: BeltPagedColumn<f64>,
        last_flow: BeltPagedColumn<f64>,
        number_mask: BeltPagedColumn<u8>,
    ) -> Self {
        Self {
            progress,
            total_transferred,
            congestion,
            last_flow,
            number_mask,
            // Every historically missing progress/congestion/lastFlow row is
            // included in the runtime evidence and canonicalized on commit.
            missing_required_rows: Vec::new(),
        }
    }

    fn signals_from_object(object: &Map<String, Value>) -> [Option<f64>; 4] {
        let read = |key: &str| {
            object
                .get(key)
                .and_then(Value::as_f64)
                .filter(|value| value.is_finite())
        };
        [
            read("progress"),
            read("totalTransferred"),
            read("congestion"),
            read("lastFlow"),
        ]
    }

    pub(crate) fn push_from_object(&mut self, object: &Map<String, Value>) -> anyhow::Result<()> {
        self.push_signals(Self::signals_from_object(object))
    }

    fn push_signals(&mut self, signals: [Option<f64>; 4]) -> anyhow::Result<()> {
        let index = self.progress.len();
        let mut mask = 0_u8;
        let mut read = |slot: usize| {
            signals[slot].map_or(0.0, |value| {
                mask |= 1 << slot;
                value
            })
        };
        self.progress.push(read(Self::PROGRESS))?;
        self.total_transferred.push(read(Self::TOTAL_TRANSFERRED))?;
        self.congestion.push(read(Self::CONGESTION))?;
        self.last_flow.push(read(Self::LAST_FLOW))?;
        self.number_mask.push(mask)?;
        if mask & Self::required_runtime_mask() != Self::required_runtime_mask() {
            self.missing_required_rows
                .push(u32::try_from(index).context("compact missing belt dynamic index")?);
        }
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.progress.len()
    }

    #[inline]
    fn required_runtime_mask() -> u8 {
        (1 << Self::PROGRESS) | (1 << Self::LAST_FLOW) | (1 << Self::CONGESTION)
    }

    pub(crate) fn missing_required_rows(&self) -> &[u32] {
        &self.missing_required_rows
    }

    pub(crate) fn validate_shape(&self, expected: usize) -> anyhow::Result<()> {
        if self.progress.len() != expected
            || self.total_transferred.len() != expected
            || self.congestion.len() != expected
            || self.last_flow.len() != expected
            || self.number_mask.len() != expected
        {
            bail!("native belt dynamic column topology changed");
        }
        if self
            .missing_required_rows
            .iter()
            .any(|&index| index as usize >= expected)
            || self
                .missing_required_rows
                .windows(2)
                .any(|pair| pair[0] >= pair[1])
        {
            bail!("native belt missing-signal index is invalid");
        }
        Ok(())
    }

    fn validate_row(&self, index: usize) -> anyhow::Result<()> {
        if self.number_mask[index] & !Self::VALID_MASK != 0
            || !self.progress[index].is_finite()
            || !self.total_transferred[index].is_finite()
            || !self.congestion[index].is_finite()
            || !self.last_flow[index].is_finite()
        {
            bail!("native belt dynamic column is invalid");
        }
        for (slot, value) in [
            self.progress[index],
            self.total_transferred[index],
            self.congestion[index],
            self.last_flow[index],
        ]
        .into_iter()
        .enumerate()
        {
            if self.number_mask[index] & (1 << slot) == 0 && value.to_bits() != 0.0_f64.to_bits() {
                bail!("native belt absent dynamic column is nonzero");
            }
        }
        Ok(())
    }

    pub(crate) fn validate(&self, expected: usize) -> anyhow::Result<()> {
        self.validate_shape(expected)?;
        let mut missing_position = 0_usize;
        for index in 0..expected {
            self.validate_row(index)?;
            if self.number_mask[index] & Self::required_runtime_mask()
                != Self::required_runtime_mask()
            {
                if self.missing_required_rows.get(missing_position).copied() != Some(index as u32) {
                    bail!("native belt missing-signal index is inconsistent");
                }
                missing_position += 1;
            }
        }
        if missing_position != self.missing_required_rows.len() {
            bail!("native belt missing-signal index is inconsistent");
        }
        Ok(())
    }

    /// Validates only pages made writable since this state was forked. The
    /// fixed 4,096-bit union scan is independent of B; value work is bounded
    /// by the number of pages touched by the active frontier.
    pub(crate) fn validate_dirty(&self, expected: usize) -> anyhow::Result<usize> {
        self.validate_shape(expected)?;
        let columns = [
            self.progress.dirty_page_words(),
            self.total_transferred.dirty_page_words(),
            self.congestion.dirty_page_words(),
            self.last_flow.dirty_page_words(),
            self.number_mask.dirty_page_words(),
        ];
        let mut checked = 0_usize;
        for word_index in 0..BELT_DYNAMIC_PAGE_BITMAP_WORDS {
            let mut word = columns
                .iter()
                .fold(0_u64, |union, column| union | column[word_index]);
            while word != 0 {
                let bit = word.trailing_zeros() as usize;
                let page_index = word_index * u64::BITS as usize + bit;
                let start = page_index * BELT_DYNAMIC_PAGE_ROWS;
                let end = (start + BELT_DYNAMIC_PAGE_ROWS).min(expected);
                for index in start..end {
                    self.validate_row(index)?;
                }
                checked += end.saturating_sub(start);
                word &= word - 1;
            }
        }
        Ok(checked)
    }

    pub(crate) fn clear_dirty(&mut self) {
        self.progress.clear_dirty();
        self.total_transferred.clear_dirty();
        self.congestion.clear_dirty();
        self.last_flow.clear_dirty();
        self.number_mask.clear_dirty();
    }

    pub(crate) fn dynamic_dirty_page_count(&self) -> usize {
        self.progress.dirty_page_count()
            + self.total_transferred.dirty_page_count()
            + self.congestion.dirty_page_count()
            + self.last_flow.dirty_page_count()
    }

    #[inline]
    pub(crate) fn persisted_number_matches(&self, index: usize, slot: usize, next: f64) -> bool {
        self.number_mask[index] & (1 << slot) != 0
            && self.value(index, slot).to_bits() == next.to_bits()
    }

    #[inline]
    fn value(&self, index: usize, slot: usize) -> f64 {
        match slot {
            Self::PROGRESS => self.progress[index],
            Self::TOTAL_TRANSFERRED => self.total_transferred[index],
            Self::CONGESTION => self.congestion[index],
            Self::LAST_FLOW => self.last_flow[index],
            _ => unreachable!("bounded native belt dynamic slot"),
        }
    }

    #[cfg(test)]
    pub(crate) fn row_bitwise_eq(&self, other: &Self, index: usize) -> bool {
        self.number_mask[index] == other.number_mask[index]
            && self.progress[index].to_bits() == other.progress[index].to_bits()
            && self.total_transferred[index].to_bits() == other.total_transferred[index].to_bits()
            && self.congestion[index].to_bits() == other.congestion[index].to_bits()
            && self.last_flow[index].to_bits() == other.last_flow[index].to_bits()
    }

    #[cfg(test)]
    pub(crate) fn bitwise_eq(&self, other: &Self) -> bool {
        self.len() == other.len() && (0..self.len()).all(|index| self.row_bitwise_eq(other, index))
    }

    fn estimated_bytes(&self) -> u64 {
        self.progress.estimated_bytes()
            + self.total_transferred.estimated_bytes()
            + self.congestion.estimated_bytes()
            + self.last_flow.estimated_bytes()
            + self.number_mask.estimated_bytes()
            + (self.missing_required_rows.capacity() * size_of::<u32>()) as u64
    }
}

#[derive(Debug, Clone)]
pub(crate) struct BeltCommitSource {
    revision: u64,
    raw: Arc<Vec<RawRecord>>,
    topology: Arc<BeltColumns>,
    dynamics: Arc<BeltDynamicColumns>,
}

impl BeltCommitSource {
    pub(crate) fn matches(&self, state: &CoreState) -> bool {
        self.revision == state.revision
            && Arc::ptr_eq(&self.raw, &state.belt_raw.0)
            && Arc::ptr_eq(&self.topology, &state.belts.0)
            && Arc::ptr_eq(&self.dynamics, &state.belt_dynamics.0)
    }
}

#[derive(Debug, Clone, Copy, Default)]
struct ViewportWorldBounds {
    min_x: f64,
    min_y: f64,
    max_x: f64,
    max_y: f64,
}

impl ViewportWorldBounds {
    fn include(&mut self, x: f64, y: f64, first: bool) {
        debug_assert!(x.is_finite() && y.is_finite());
        if first {
            *self = Self {
                min_x: x,
                min_y: y,
                max_x: x,
                max_y: y,
            };
            return;
        }
        self.min_x = self.min_x.min(x);
        self.min_y = self.min_y.min(y);
        self.max_x = self.max_x.max(x);
        self.max_y = self.max_y.max(y);
    }

    fn as_json(self) -> Value {
        serde_json::json!({
            "minX": self.min_x,
            "minY": self.min_y,
            "maxX": self.max_x,
            "maxY": self.max_y,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
struct ViewportCellKey {
    x: i64,
    y: i64,
}

fn viewport_cell_coordinate(value: f64) -> i64 {
    let scaled = (value / VIEWPORT_SPATIAL_CELL_SIZE).floor();
    if scaled <= i64::MIN as f64 {
        i64::MIN
    } else if scaled >= i64::MAX as f64 {
        i64::MAX
    } else {
        scaled as i64
    }
}

/// Immutable per-planet spatial index. Cell members are persisted entity row
/// indexes, and every query re-sorts only the touched rows by that index. This
/// keeps viewport order independent from grid-cell traversal order.
#[derive(Debug, Clone, Default)]
struct PlanetViewportIndex {
    cell_keys: Vec<ViewportCellKey>,
    cell_offsets: Vec<usize>,
    entity_indices: Vec<usize>,
    world_bounds: ViewportWorldBounds,
}

impl PlanetViewportIndex {
    fn build(entity_indices: &[usize], entities: &EntityColumns) -> Self {
        let mut cells = BTreeMap::<ViewportCellKey, Vec<usize>>::new();
        let mut world_bounds = ViewportWorldBounds::default();
        for (ordinal, &entity_index) in entity_indices.iter().enumerate() {
            let x = entities.position_x[entity_index];
            let y = entities.position_y[entity_index];
            world_bounds.include(x, y, ordinal == 0);
            cells
                .entry(ViewportCellKey {
                    x: viewport_cell_coordinate(x),
                    y: viewport_cell_coordinate(y),
                })
                .or_default()
                .push(entity_index);
        }

        let mut cell_keys = Vec::with_capacity(cells.len());
        let mut cell_offsets = Vec::with_capacity(cells.len().saturating_add(1));
        let mut flattened = Vec::with_capacity(entity_indices.len());
        cell_offsets.push(0);
        for (key, indices) in cells {
            cell_keys.push(key);
            flattened.extend(indices);
            cell_offsets.push(flattened.len());
        }
        cell_keys.shrink_to_fit();
        cell_offsets.shrink_to_fit();
        flattened.shrink_to_fit();
        Self {
            cell_keys,
            cell_offsets,
            entity_indices: flattened,
            world_bounds,
        }
    }

    fn query(
        &self,
        planet_entities: &[usize],
        entities: &EntityColumns,
        min_x: f64,
        min_y: f64,
        max_x: f64,
        max_y: f64,
    ) -> (Vec<usize>, bool) {
        let min_cell_x = viewport_cell_coordinate(min_x);
        let min_cell_y = viewport_cell_coordinate(min_y);
        let max_cell_x = viewport_cell_coordinate(max_x);
        let max_cell_y = viewport_cell_coordinate(max_y);
        let span_x = i128::from(max_cell_x) - i128::from(min_cell_x) + 1;
        let span_y = i128::from(max_cell_y) - i128::from(min_cell_y) + 1;
        let cell_probes = span_x
            .checked_mul(span_y)
            .filter(|value| *value >= 0)
            .and_then(|value| u64::try_from(value).ok());
        let broad_fallback = cell_probes.is_none_or(|count| {
            count > MAX_VIEWPORT_GRID_CELL_PROBES || count > self.cell_keys.len() as u64 * 16 + 64
        });

        let mut candidates = if broad_fallback {
            planet_entities.to_vec()
        } else {
            let mut candidates = Vec::new();
            for cell_x in min_cell_x..=max_cell_x {
                for cell_y in min_cell_y..=max_cell_y {
                    let key = ViewportCellKey {
                        x: cell_x,
                        y: cell_y,
                    };
                    if let Ok(index) = self.cell_keys.binary_search(&key) {
                        candidates.extend_from_slice(
                            &self.entity_indices
                                [self.cell_offsets[index]..self.cell_offsets[index + 1]],
                        );
                    }
                }
            }
            candidates.sort_unstable();
            candidates
        };
        candidates.retain(|&index| {
            let x = entities.position_x[index];
            let y = entities.position_y[index];
            x >= min_x && x <= max_x && y >= min_y && y <= max_y
        });
        (candidates, broad_fallback)
    }

    fn estimated_bytes(&self) -> u64 {
        (self.cell_keys.capacity() * size_of::<ViewportCellKey>()
            + self.cell_offsets.capacity() * size_of::<usize>()
            + self.entity_indices.capacity() * size_of::<usize>()) as u64
    }
}

/// Immutable CSR mapping from persisted entity rows to incident persisted
/// belt rows. It is rebuilt only with topology and is never serialized.
#[derive(Debug, Clone, Default)]
struct EntityBeltAdjacency {
    offsets: Vec<usize>,
    belt_indices: Vec<usize>,
}

impl EntityBeltAdjacency {
    fn from_rows(mut rows: Vec<Vec<usize>>) -> Self {
        let edge_count = rows.iter().map(Vec::len).sum();
        let mut offsets = Vec::with_capacity(rows.len().saturating_add(1));
        let mut belt_indices = Vec::with_capacity(edge_count);
        offsets.push(0);
        for row in &mut rows {
            row.sort_unstable();
            row.dedup();
            belt_indices.extend_from_slice(row);
            offsets.push(belt_indices.len());
        }
        offsets.shrink_to_fit();
        belt_indices.shrink_to_fit();
        Self {
            offsets,
            belt_indices,
        }
    }

    fn incident(&self, entity_index: usize) -> &[usize] {
        self.offsets
            .get(entity_index..=entity_index.saturating_add(1))
            .filter(|range| range.len() == 2)
            .map_or(&[], |range| &self.belt_indices[range[0]..range[1]])
    }

    fn estimated_bytes(&self) -> u64 {
        ((self.offsets.capacity() + self.belt_indices.capacity()) * size_of::<usize>()) as u64
    }
}

#[derive(Debug, Clone, Default)]
pub(crate) struct FactoryTopology {
    pub station_indices: Vec<usize>,
    pub quantum_endpoint_indices: Vec<usize>,
    pub construction_center_indices: Vec<usize>,
    pub time_warp_indices: Vec<usize>,
    pub logistics_buffer_indices: Vec<usize>,
    pub material_delivery_hub_indices: Vec<usize>,
    pub orbital_cargo_terminal_indices: Vec<usize>,
    pub galactic_material_exporter_indices: Vec<usize>,
    pub space_station_launcher_indices: Vec<usize>,
    /// Stable persisted-row order for every ray receiver. Runtime recipe,
    /// technology, output-capacity, and power eligibility still belong to the
    /// exact Dyson probe; this immutable index only removes the O(all
    /// non-stations) discovery scan from every simulation revision.
    pub ray_receiver_indices: Vec<usize>,
    pub power_source_indices: Vec<usize>,
    pub vein_indices: Vec<usize>,
    pub ordinary_machine_indices: Vec<usize>,
    pub non_station_indices: Vec<usize>,
    pub research_entity_indices: Vec<usize>,
    pub entity_planet_indices: Vec<usize>,
    pub entity_grid_indices: Vec<usize>,
    pub entities_by_planet: Vec<Vec<usize>>,
    pub belts_by_planet: Vec<Vec<usize>>,
    /// Sum of machine/miner stacks per planet for bounded UI projections.
    /// Counts are rebuilt with the immutable topology columns, so reading the
    /// planet navigator never scans every entity on a simulation revision.
    pub device_counts_by_planet: Vec<f64>,
    planet_viewport_indexes: Vec<PlanetViewportIndex>,
    entity_belt_adjacency: EntityBeltAdjacency,
    pub has_galactic_material_exporter: bool,
}

impl FactoryTopology {
    fn shrink_to_fit(&mut self) {
        self.station_indices.shrink_to_fit();
        self.quantum_endpoint_indices.shrink_to_fit();
        self.construction_center_indices.shrink_to_fit();
        self.time_warp_indices.shrink_to_fit();
        self.logistics_buffer_indices.shrink_to_fit();
        self.material_delivery_hub_indices.shrink_to_fit();
        self.orbital_cargo_terminal_indices.shrink_to_fit();
        self.galactic_material_exporter_indices.shrink_to_fit();
        self.space_station_launcher_indices.shrink_to_fit();
        self.ray_receiver_indices.shrink_to_fit();
        self.power_source_indices.shrink_to_fit();
        self.vein_indices.shrink_to_fit();
        self.ordinary_machine_indices.shrink_to_fit();
        self.non_station_indices.shrink_to_fit();
        self.research_entity_indices.shrink_to_fit();
        self.entity_planet_indices.shrink_to_fit();
        self.entity_grid_indices.shrink_to_fit();
        for indices in self
            .entities_by_planet
            .iter_mut()
            .chain(self.belts_by_planet.iter_mut())
        {
            indices.shrink_to_fit();
        }
        self.entities_by_planet.shrink_to_fit();
        self.belts_by_planet.shrink_to_fit();
        self.device_counts_by_planet.shrink_to_fit();
        self.planet_viewport_indexes.shrink_to_fit();
    }

    fn estimated_bytes(&self) -> u64 {
        let index_capacity = self.station_indices.capacity()
            + self.quantum_endpoint_indices.capacity()
            + self.construction_center_indices.capacity()
            + self.time_warp_indices.capacity()
            + self.logistics_buffer_indices.capacity()
            + self.material_delivery_hub_indices.capacity()
            + self.orbital_cargo_terminal_indices.capacity()
            + self.galactic_material_exporter_indices.capacity()
            + self.space_station_launcher_indices.capacity()
            + self.ray_receiver_indices.capacity()
            + self.power_source_indices.capacity()
            + self.vein_indices.capacity()
            + self.ordinary_machine_indices.capacity()
            + self.non_station_indices.capacity()
            + self.research_entity_indices.capacity()
            + self.entity_planet_indices.capacity()
            + self.entity_grid_indices.capacity();
        let planet_index_capacity = self
            .entities_by_planet
            .iter()
            .chain(self.belts_by_planet.iter())
            .map(Vec::capacity)
            .sum::<usize>();
        ((index_capacity + planet_index_capacity) * size_of::<usize>()) as u64
            + (self.device_counts_by_planet.capacity() * size_of::<f64>()) as u64
            + (self.planet_viewport_indexes.capacity() * size_of::<PlanetViewportIndex>()) as u64
            + self
                .planet_viewport_indexes
                .iter()
                .map(PlanetViewportIndex::estimated_bytes)
                .sum::<u64>()
            + self.entity_belt_adjacency.estimated_bytes()
    }
}

#[derive(Debug, Clone)]
pub struct CoreState {
    pub identity: CoreCheckpointIdentity,
    pub revision: u64,
    pub catalog: Arc<RuntimeCatalog>,
    base: Map<String, Value>,
    entity_raw: SharedArc<Vec<RawRecord>>,
    belt_raw: SharedArc<Vec<RawRecord>>,
    /// Process-local one-shot cache; never persisted or hashed.
    parsed_entity_runtime: Arc<EntityRuntimeCache>,
    pub(crate) entity_index: SharedArc<ExactRowIdIndex>,
    pub(crate) belt_index: SharedArc<ExactRowIdIndex>,
    pub(crate) symbols: SharedArc<Symbols>,
    pub(crate) entities: SharedArc<EntityColumns>,
    entity_dynamics: SharedArc<EntityDynamicColumns>,
    last_entity_raw_writeback: EntityRawWritebackDiagnostics,
    pub(crate) belts: SharedArc<BeltColumns>,
    pub(crate) belt_dynamics: SharedArc<BeltDynamicColumns>,
    pub(crate) factory_topology: Arc<FactoryTopology>,
    coverage: DomainCoverage,
    factory_static_admission_checked: bool,
    factory_static_admission_reason: Option<&'static str>,
    prepared_belt_routes: Option<Arc<crate::belts::PreparedRoutes>>,
    /// Runtime-only deterministic wake set paired with the exact prepared
    /// route graph. It is installed only after a successful revision commit.
    prepared_belt_activity: Option<Arc<crate::belts::BeltActivitySnapshot>>,
    prepared_local_peer_directory: Option<Arc<crate::local_logistics::LocalPeerDirectory>>,
    /// Runtime-only deterministic wake set for in-flight interstellar routes.
    /// It is installed only after a successful candidate revision commits.
    prepared_interstellar_route_activity:
        Option<Arc<crate::interstellar_logistics::InterstellarRouteActivity>>,
    /// Persistence dirtiness is deliberately independent from the simulation
    /// wake queues. A successful checkpoint clears only this structure; belt
    /// or logistics scheduling state is never acknowledged by the saver.
    save_dirty: SaveDirtyPages,
    checkpoint_chunks: Vec<ChunkMetadata>,
    pending_checkpoint_chunks: SyncCell<Option<Vec<ChunkMetadata>>>,
    /// Optional state for the bounded exact prefix shared by all slices in a
    /// continuous conservative pure-idle session. It is persisted only in the
    /// private chunk manifest, never in public saves or canonical hashes.
    pure_idle_session: Option<PureIdleSessionState>,
    /// Runtime-only macro-v10 calibration snapshots and ordinary-flow proof.
    /// A checkpoint reload deliberately drops this cache; pure-idle rebuilds
    /// it with a disposable exact probe before authorizing any productive tail.
    pub(crate) pure_idle_macro_runtime: Option<crate::pure_idle::PureIdleMacroRuntimeCache>,
    /// Canonical diagnostics are intentionally expensive on very large saves.
    /// A revision is immutable from the protocol's point of view, so repeated
    /// status/compare/checkpoint calls can safely reuse the small digest result
    /// instead of reparsing every entity and belt again.
    summary_cache: SyncCell<Option<(u64, CoreStateSummary)>>,
    /// Runtime-only four-level production-history index. This cache is never
    /// serialized and never participates in the public v47 canonical hash.
    /// The established JS-authority `base.productionHistory` remains byte-for-
    /// byte unchanged for differential and cloud compatibility.
    production_history_tiers: SharedArc<crate::production_history::TieredProductionHistory>,
}

fn object_string<'a>(object: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    object.get(key).and_then(Value::as_str)
}

fn object_number(object: &Map<String, Value>, key: &str) -> f64 {
    object
        .get(key)
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
        .unwrap_or(0.0)
}

fn retain_statistics_item(value: &mut Value, item_id: &str) {
    if let Some(record) = value.as_object_mut() {
        record.retain(|key, _| key == item_id);
    }
}

fn retain_statistics_planet(value: &mut Value, planet_id: Option<&str>, item_id: Option<&str>) {
    let Some(planets) = value.as_object_mut() else {
        return;
    };
    if let Some(planet_id) = planet_id {
        planets.retain(|key, _| key == planet_id);
    }
    if let Some(item_id) = item_id {
        for rates in planets.values_mut() {
            retain_statistics_item(rates, item_id);
        }
    }
}

fn parse_domain_inventory<'a>(
    value: Option<&'a Value>,
    symbols: &mut DomainSymbolOrder<'_>,
) -> Vec<DomainInventoryEntry<'a>> {
    let Some(object) = value.and_then(Value::as_object) else {
        return Vec::new();
    };
    let mut values = object
        .iter()
        .filter_map(|(item, amount)| {
            let amount = amount.as_f64()?;
            amount.is_finite().then(|| DomainInventoryEntry {
                item,
                rank: symbols.rank(item),
                amount,
            })
        })
        .collect::<Vec<_>>();
    values.sort_by_key(|entry| entry.rank);
    values
}

fn parse_records_with_runtime(
    runtime: &DeterministicRuntime,
    records: &[RawRecord],
    label: &'static str,
) -> anyhow::Result<Vec<Value>> {
    runtime.indexed_try_map(records, |index, raw| {
        serde_json::from_str(raw).with_context(|| format!("decode {label} at index {index}"))
    })
}

fn parse_records_parallel(
    records: &[RawRecord],
    label: &'static str,
) -> anyhow::Result<Vec<Value>> {
    parse_records_with_runtime(deterministic_runtime(), records, label)
}

#[cfg(test)]
fn encode_serializables_with_runtime<T>(
    runtime: &DeterministicRuntime,
    records: &[T],
    label: &'static str,
) -> anyhow::Result<Vec<RawRecord>>
where
    T: Serialize + Sync,
{
    runtime.indexed_try_map(records, |index, value| {
        serde_json::to_string(value)
            .with_context(|| format!("encode {label} at index {index}"))
            .map(RawRecord::from)
    })
}

#[cfg(test)]
mod parallel_record_tests {
    use super::*;
    use serde::Serializer;
    use serde::ser::Error as _;

    struct FallibleRecord {
        index: usize,
        fail: bool,
    }

    impl Serialize for FallibleRecord {
        fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
        where
            S: Serializer,
        {
            if self.fail {
                return Err(S::Error::custom(format!("encode-failure-{}", self.index)));
            }
            serializer.serialize_u64(self.index as u64)
        }
    }

    #[test]
    fn parallel_parse_and_encode_report_the_lowest_input_error() {
        let runtime = DeterministicRuntime::for_test(8);
        let mut raw = (0..4_257)
            .map(|index| RawRecord::from(index.to_string()))
            .collect::<Vec<_>>();
        raw[17] = "{".into();
        raw[4_100] = "[}".into();
        let parse_error = parse_records_with_runtime(&runtime, &raw, "ordered record")
            .expect_err("two malformed records must fail");
        assert!(parse_error.to_string().contains("index 17"));

        let records = (0..4_257)
            .map(|index| FallibleRecord {
                index,
                fail: matches!(index, 17 | 4_100),
            })
            .collect::<Vec<_>>();
        let encode_error = encode_serializables_with_runtime(&runtime, &records, "ordered record")
            .expect_err("two failing records must fail");
        assert!(encode_error.to_string().contains("index 17"));
    }

    #[test]
    fn parallel_record_output_preserves_exact_input_byte_order() {
        let runtime = DeterministicRuntime::for_test(8);
        let records = (0..4_257)
            .map(
                |index| serde_json::json!({ "index": index, "text": format!("record-{index:05}") }),
            )
            .collect::<Vec<_>>();
        let encoded = encode_serializables_with_runtime(&runtime, &records, "ordered record")
            .expect("parallel record encoding should succeed");
        assert_eq!(encoded.len(), records.len());
        for (index, raw) in encoded.iter().enumerate() {
            assert_eq!(
                raw.as_ref(),
                serde_json::to_string(&records[index]).unwrap(),
                "index={index}"
            );
        }
    }
}

fn encoded_chunk_id(id: &str) -> String {
    let mut encoded = String::with_capacity(id.len());
    for byte in id.bytes() {
        if byte.is_ascii_alphanumeric()
            || matches!(
                byte,
                b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')'
            )
        {
            encoded.push(char::from(byte));
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

fn verify_chunk(metadata: &ChunkMetadata, bytes: &[u8]) -> anyhow::Result<()> {
    if bytes.len() != metadata.bytes || fnv1a_utf8(bytes) != metadata.checksum {
        bail!(
            "native core checkpoint chunk checksum is invalid: {}",
            metadata.id
        );
    }
    if let Some(expected) = metadata.sha256.as_deref()
        && (expected.len() != 64
            || !expected.bytes().all(|byte| byte.is_ascii_hexdigit())
            || hex::encode(Sha256::digest(bytes)) != expected)
    {
        bail!(
            "native core checkpoint chunk sha256 is invalid: {}",
            metadata.id
        );
    }
    Ok(())
}

fn take_manifest(
    records: &mut BTreeMap<String, Vec<u8>>,
) -> anyhow::Result<(String, ChunkedManifest)> {
    let mut candidates = Vec::new();
    for (key, bytes) in records.iter() {
        if !key.ends_with(INTERNAL_MANIFEST_SUFFIX) {
            continue;
        }
        let Ok(value) = serde_json::from_slice::<Value>(bytes) else {
            continue;
        };
        if !matches!(
            value.get("formatVersion").and_then(Value::as_u64),
            Some(1 | 2)
        ) || value.get("chunks").and_then(Value::as_array).is_none()
        {
            continue;
        }
        let manifest = serde_json::from_value::<ChunkedManifest>(value)
            .context("decode native core chunk manifest")?;
        candidates.push((key.clone(), manifest));
    }
    if candidates.len() != 1 {
        bail!("native core checkpoint must contain exactly one chunk manifest");
    }
    let (manifest_key, manifest) = candidates.pop().expect("one manifest");
    let manifest_bytes = records
        .remove(&manifest_key)
        .ok_or_else(|| anyhow!("native core checkpoint manifest disappeared during open"))?;
    drop(manifest_bytes);
    Ok((manifest_key, manifest))
}

fn chunk_record_key(manifest_key: &str, id: &str) -> anyhow::Result<String> {
    let prefix = manifest_key
        .strip_suffix(INTERNAL_MANIFEST_SUFFIX)
        .ok_or_else(|| anyhow!("native core manifest key is invalid"))?;
    Ok(format!("{prefix}chunk.{}", encoded_chunk_id(id)))
}

enum ChunkRecordBytes<'a> {
    Borrowed(&'a [u8]),
    Owned(Vec<u8>),
}

impl AsRef<[u8]> for ChunkRecordBytes<'_> {
    fn as_ref(&self) -> &[u8] {
        match self {
            Self::Borrowed(bytes) => bytes,
            Self::Owned(bytes) => bytes,
        }
    }
}

fn take_chunk_record<'a>(
    records: &'a mut BTreeMap<String, Vec<u8>>,
    manifest_key: &str,
    id: &str,
    referenced_again: bool,
) -> anyhow::Result<ChunkRecordBytes<'a>> {
    let key = chunk_record_key(manifest_key, id)?;
    if referenced_again {
        return records
            .get(&key)
            .map(|bytes| ChunkRecordBytes::Borrowed(bytes.as_slice()))
            .ok_or_else(|| anyhow!("native core checkpoint chunk is missing: {id}"));
    }
    records
        .remove(&key)
        .map(ChunkRecordBytes::Owned)
        .ok_or_else(|| anyhow!("native core checkpoint chunk is missing: {id}"))
}

fn has_later_chunk_reference(
    remaining_references: &mut HashMap<String, usize>,
    id: &str,
) -> anyhow::Result<bool> {
    let remaining = remaining_references
        .get_mut(id)
        .ok_or_else(|| anyhow!("native core checkpoint chunk accounting is invalid"))?;
    *remaining = remaining
        .checked_sub(1)
        .ok_or_else(|| anyhow!("native core checkpoint chunk accounting is invalid"))?;
    Ok(*remaining > 0)
}

fn load_checkpoint_base(
    records: &mut BTreeMap<String, Vec<u8>>,
    manifest_key: &str,
    manifest: &ChunkedManifest,
    remaining_chunk_references: &mut HashMap<String, usize>,
) -> anyhow::Result<Map<String, Value>> {
    if manifest.format_version == LEGACY_INTERNAL_CHECKPOINT_FORMAT_VERSION {
        let base_metadata = manifest
            .chunks
            .iter()
            .filter(|chunk| chunk.kind == "base")
            .collect::<Vec<_>>();
        if base_metadata.len() != 1 || base_metadata[0].offset != 0 || base_metadata[0].count != 1 {
            bail!("native core checkpoint base chunk is invalid");
        }
        let metadata = base_metadata[0];
        let referenced_again = has_later_chunk_reference(remaining_chunk_references, &metadata.id)?;
        let bytes = take_chunk_record(records, manifest_key, &metadata.id, referenced_again)?;
        verify_chunk(metadata, bytes.as_ref())?;
        let base = match serde_json::from_slice::<Value>(bytes.as_ref())
            .context("decode native core base chunk")?
        {
            Value::Object(base) => base,
            _ => bail!("native core base chunk is not an object"),
        };
        if base.contains_key("entities") || base.contains_key("belts") {
            bail!("native core base chunk contains an unbounded collection");
        }
        return Ok(base);
    }

    let mut base = Map::<String, Value>::new();
    for domain in BASE_CHECKPOINT_DOMAINS {
        let candidates = manifest
            .chunks
            .iter()
            .filter(|chunk| chunk.kind == domain.kind())
            .collect::<Vec<_>>();
        if candidates.len() != 1 {
            bail!(
                "native core checkpoint base domain chunk is invalid: {}",
                domain.id()
            );
        }
        let metadata = candidates[0];
        if metadata.id != domain.id() || metadata.offset != 0 || metadata.sha256.is_none() {
            bail!(
                "native core checkpoint base domain metadata is invalid: {}",
                domain.id()
            );
        }
        let referenced_again = has_later_chunk_reference(remaining_chunk_references, &metadata.id)?;
        let bytes = take_chunk_record(records, manifest_key, &metadata.id, referenced_again)?;
        verify_chunk(metadata, bytes.as_ref())?;
        let fields = match serde_json::from_slice::<Value>(bytes.as_ref())
            .with_context(|| format!("decode native core base domain chunk: {}", domain.id()))?
        {
            Value::Object(fields) => fields,
            _ => bail!(
                "native core base domain chunk is not an object: {}",
                domain.id()
            ),
        };
        if fields.len() != metadata.count {
            bail!(
                "native core checkpoint base domain count is invalid: {}",
                domain.id()
            );
        }
        for (key, value) in fields {
            if matches!(key.as_str(), "entities" | "belts")
                || classify_base_checkpoint_key(&key) != domain
            {
                bail!(
                    "native core checkpoint base domain ownership is invalid: {}",
                    domain.id()
                );
            }
            if base.insert(key, value).is_some() {
                bail!("native core checkpoint base domains overlap");
            }
        }
    }
    Ok(base)
}

impl CoreState {
    /// Compatibility wrapper for callers that must retain their decoded
    /// record map. Production checkpoint open should move the map into
    /// [`Self::from_owned_internal_records`] so chunk bytes can be released as
    /// soon as each record has been verified and converted.
    pub fn from_internal_records(
        identity: CoreCheckpointIdentity,
        records: &BTreeMap<String, Vec<u8>>,
        catalog: RuntimeCatalog,
    ) -> anyhow::Result<Self> {
        Self::from_owned_internal_records(identity, records.clone(), catalog)
    }

    pub fn from_owned_internal_records(
        identity: CoreCheckpointIdentity,
        mut records: BTreeMap<String, Vec<u8>>,
        catalog: RuntimeCatalog,
    ) -> anyhow::Result<Self> {
        if records.is_empty() || records.len() > MAX_INTERNAL_RECORDS {
            bail!("native core checkpoint record count is invalid");
        }
        if identity.state_version != 47
            || !matches!(identity.mode.as_str(), "normal" | "speedrun")
            || !identity
                .root_hash
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit())
            || identity.root_hash.len() != 64
            || identity.base_primary_checksum.len() != 8
            || !identity
                .base_primary_checksum
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit())
        {
            bail!("native core checkpoint identity is invalid");
        }
        let (manifest_key, manifest) = take_manifest(&mut records)?;
        if !matches!(
            manifest.format_version,
            LEGACY_INTERNAL_CHECKPOINT_FORMAT_VERSION | DOMAIN_INTERNAL_CHECKPOINT_FORMAT_VERSION
        ) || manifest.envelope_format_version != 2
            || manifest.state_version != identity.state_version
            || manifest.mode != identity.mode
            || manifest.entity_count > MAX_ENTITY_COUNT
            || manifest.belt_count > MAX_BELT_COUNT
            || !manifest
                .base_primary_checksum
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit())
            || manifest.base_primary_checksum.len() != 8
            || !manifest
                .chunk_root_checksum
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit())
            || manifest.chunk_root_checksum.len() != 8
        {
            bail!("native core checkpoint manifest identity is invalid");
        }
        if manifest.format_version == DOMAIN_INTERNAL_CHECKPOINT_FORMAT_VERSION {
            if let Some(metadata) = manifest
                .chunks
                .iter()
                .find(|metadata| !checkpoint_chunk_has_valid_sha256_metadata(metadata))
            {
                bail!(
                    "native core v2 checkpoint chunk requires sha256: {}",
                    metadata.id
                );
            }
            let root_material = checkpoint_root_material(&manifest.chunks)?;
            if fnv1a_utf8(root_material.as_bytes()) != manifest.chunk_root_checksum {
                bail!("native core checkpoint manifest chunk root is invalid");
            }
        }
        let pure_idle_session = match (manifest.pure_idle_session, manifest.pure_idle_macro_session)
        {
            (Some(_), Some(_)) => {
                bail!("native core checkpoint contains conflicting pure-idle sessions")
            }
            (Some(session), None) if session.macro_v10 => {
                bail!("native core legacy pure-idle session has the wrong mode")
            }
            (None, Some(session)) if !session.macro_v10 => {
                bail!("native core macro pure-idle session has the wrong mode")
            }
            (Some(session), None) | (None, Some(session)) => {
                Some(session.validate(identity.revision)?)
            }
            (None, None) => None,
        };
        let mut remaining_chunk_references = HashMap::<String, usize>::new();
        for metadata in &manifest.chunks {
            *remaining_chunk_references
                .entry(metadata.id.clone())
                .or_default() += 1;
        }
        let base = load_checkpoint_base(
            &mut records,
            &manifest_key,
            &manifest,
            &mut remaining_chunk_references,
        )?;

        let mut entity_raw = vec![None; manifest.entity_count];
        let mut belt_raw = vec![None; manifest.belt_count];
        for metadata in &manifest.chunks {
            if metadata.kind == "base"
                || BASE_CHECKPOINT_DOMAINS
                    .iter()
                    .any(|domain| metadata.kind == domain.kind())
            {
                continue;
            }
            let target = match metadata.kind.as_str() {
                "entities" => &mut entity_raw,
                "belts" => &mut belt_raw,
                _ => bail!("native core checkpoint contains an unknown chunk kind"),
            };
            if metadata
                .offset
                .checked_add(metadata.count)
                .is_none_or(|end| end > target.len())
            {
                bail!("native core checkpoint chunk range is invalid");
            }
            let referenced_again =
                has_later_chunk_reference(&mut remaining_chunk_references, &metadata.id)?;
            let bytes =
                take_chunk_record(&mut records, &manifest_key, &metadata.id, referenced_again)?;
            verify_chunk(metadata, bytes.as_ref())?;
            // Preserve each already-valid JSON record as raw text. Decoding
            // the page into a full `Value` graph and immediately serializing
            // every record again doubled startup parsing and allocation; the
            // index rebuild below performs the required object validation.
            let values = serde_json::from_slice::<Vec<Box<RawValue>>>(bytes.as_ref())
                .context("decode native core record chunk")?;
            if values.len() != metadata.count {
                bail!("native core checkpoint chunk count is invalid");
            }
            for (index, value) in values.into_iter().enumerate() {
                if target[metadata.offset + index].is_some() {
                    bail!("native core checkpoint record topology is invalid");
                }
                target[metadata.offset + index] = Some(RawRecord::from(value.get()));
            }
            drop(bytes);
        }
        debug_assert!(
            remaining_chunk_references
                .values()
                .all(|remaining| *remaining == 0)
        );
        drop(remaining_chunk_references);
        if entity_raw.iter().any(Option::is_none) || belt_raw.iter().any(Option::is_none) {
            bail!("native core checkpoint record ranges are incomplete");
        }
        if !records.is_empty() {
            bail!("native core checkpoint contains unreferenced records");
        }
        drop(records);
        Self::from_raw_record_parts(
            identity,
            base,
            entity_raw
                .into_iter()
                .map(Option::unwrap)
                .collect::<Vec<_>>(),
            belt_raw.into_iter().map(Option::unwrap).collect::<Vec<_>>(),
            catalog,
            manifest.chunks,
            pure_idle_session,
            SaveDirtyPages::default(),
        )
    }

    pub(crate) fn from_public_v47_parts(
        identity: CoreCheckpointIdentity,
        base: Map<String, Value>,
        entities: Vec<String>,
        belts: Vec<String>,
        catalog: RuntimeCatalog,
    ) -> anyhow::Result<Self> {
        if identity.state_version != 47
            || !matches!(identity.mode.as_str(), "normal" | "speedrun")
            || identity.root_hash.len() != 64
            || !identity
                .root_hash
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit())
            || identity.base_primary_checksum.len() != 8
            || !identity
                .base_primary_checksum
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit())
            || entities.len() > MAX_ENTITY_COUNT
            || belts.len() > MAX_BELT_COUNT
        {
            bail!("native v47 import identity is invalid");
        }
        if base.get("version").and_then(Value::as_u64) != Some(47)
            || base.get("mode").and_then(Value::as_str) != Some(identity.mode.as_str())
            || base.contains_key("entities")
            || base.contains_key("belts")
        {
            bail!("native v47 import state identity is invalid");
        }
        Self::from_raw_record_parts(
            identity,
            base,
            entities.into_iter().map(RawRecord::from).collect(),
            belts.into_iter().map(RawRecord::from).collect(),
            catalog,
            Vec::new(),
            None,
            SaveDirtyPages {
                entity_topology: true,
                belt_topology: true,
                ..SaveDirtyPages::default()
            },
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn from_raw_record_parts(
        identity: CoreCheckpointIdentity,
        base: Map<String, Value>,
        entity_raw: Vec<RawRecord>,
        belt_raw: Vec<RawRecord>,
        catalog: RuntimeCatalog,
        checkpoint_chunks: Vec<ChunkMetadata>,
        pure_idle_session: Option<PureIdleSessionState>,
        save_dirty: SaveDirtyPages,
    ) -> anyhow::Result<Self> {
        let production_history_tiers =
            crate::production_history::TieredProductionHistory::from_base(&base);
        let mut state = Self {
            revision: identity.revision,
            identity,
            catalog: Arc::new(catalog),
            base,
            entity_raw: entity_raw.into(),
            belt_raw: belt_raw.into(),
            parsed_entity_runtime: Arc::new(EntityRuntimeCache::default()),
            entity_index: ExactRowIdIndex::default().into(),
            belt_index: ExactRowIdIndex::default().into(),
            symbols: Symbols::default().into(),
            entities: EntityColumns::default().into(),
            entity_dynamics: EntityDynamicColumns::default().into(),
            last_entity_raw_writeback: EntityRawWritebackDiagnostics::default(),
            belts: BeltColumns::default().into(),
            belt_dynamics: BeltDynamicColumns::default().into(),
            factory_topology: Arc::new(FactoryTopology::default()),
            coverage: DomainCoverage::implemented_beta_scope(),
            factory_static_admission_checked: false,
            factory_static_admission_reason: None,
            prepared_belt_routes: None,
            prepared_belt_activity: None,
            prepared_local_peer_directory: None,
            prepared_interstellar_route_activity: None,
            save_dirty,
            checkpoint_chunks,
            pending_checkpoint_chunks: SyncCell::new(None),
            pure_idle_session,
            pure_idle_macro_runtime: None,
            summary_cache: SyncCell::new(None),
            production_history_tiers: production_history_tiers.into(),
        };
        // Entity records remain shared by startup admission, route preparation
        // and the canonical proof. Belt records are intentionally decoded one
        // at a time by each consumer so opening a large save never owns a full
        // second `Vec<Value>` belt graph.
        let parsed_entities = state.parse_entities_parallel()?;
        state.rebuild_indexes_from_parsed_entities(&parsed_entities)?;
        state.refresh_factory_static_admission_with_entities(&parsed_entities)?;
        if state.factory_static_admission_reason.is_none() {
            state.prepared_belt_routes = Some(Arc::new(crate::belts::prepare_routes_from_state(
                &state,
                &parsed_entities,
            )?));
            state.prepared_local_peer_directory =
                Some(Arc::new(crate::local_logistics::prepare_step_directory(
                    &parsed_entities,
                    &state.factory_topology.station_indices,
                )?));
            state.prepared_interstellar_route_activity = Some(Arc::new(
                crate::interstellar_logistics::prepare_route_activity(&parsed_entities),
            ));
        }
        // `coreOpen` must return a verified canonical proof. Reuse the parsed
        // entity graph while canonicalizing each raw belt independently.
        let canonical = state.canonical_digest_bundle_with_parsed(Some(&parsed_entities), None)?;
        let summary = state.summary_from_digest(canonical);
        state.summary_cache.replace(Some((state.revision, summary)));
        if !sync_record_drop_enabled() {
            state.parsed_entity_runtime =
                Arc::new(EntityRuntimeCache::with_values(parsed_entities));
        }
        Ok(state)
    }

    /// Streams one bounded internal checkpoint record at a time. The caller
    /// owns durability and must publish the returned manifest record last.
    /// No complete GameState or 77 MB JSON string is assembled here.
    pub fn visit_internal_checkpoint_records(
        &self,
        saved_at_ms: u64,
        mut visit: impl FnMut(&str, &str) -> anyhow::Result<()>,
    ) -> anyhow::Result<Vec<String>> {
        let prefix = format!(
            "dsp-idle-network.internal.v1.chunked.v1.{}.",
            self.identity.mode
        );
        let mut metadata = Vec::<ChunkMetadata>::new();
        let mut active_keys = Vec::<String>::new();
        let mut total_bytes = 0_usize;

        let mut emit = |id: String,
                        kind: &str,
                        offset: usize,
                        count: usize,
                        text: String|
         -> anyhow::Result<()> {
            let bytes = text.len();
            metadata.push(checkpoint_chunk_metadata(
                id.clone(),
                kind,
                offset,
                count,
                &text,
            ));
            total_bytes = total_bytes.saturating_add(bytes);
            let key = format!("{prefix}chunk.{}", encoded_chunk_id(&id));
            visit(&key, &text)?;
            active_keys.push(key);
            Ok(())
        };

        for domain in BASE_CHECKPOINT_DOMAINS {
            let (text, count) = encode_base_checkpoint_domain(&self.base, domain)?;
            emit(domain.id().to_owned(), domain.kind(), 0, count, text)?;
        }
        #[allow(clippy::type_complexity)]
        let emit_raw_ranges =
            |values: &[RawRecord],
             kind: &str,
             chunk_size: usize,
             emit: &mut dyn FnMut(String, &str, usize, usize, String) -> anyhow::Result<()>|
             -> anyhow::Result<()> {
                if values.is_empty() {
                    return emit(format!("{kind}:00000000"), kind, 0, 0, "[]".to_owned());
                }
                for offset in (0..values.len()).step_by(chunk_size) {
                    let end = (offset + chunk_size).min(values.len());
                    let capacity = values[offset..end]
                        .iter()
                        .map(|raw| raw.len() + 1)
                        .sum::<usize>()
                        .saturating_add(1);
                    let mut text = String::with_capacity(capacity);
                    text.push('[');
                    for (relative, raw) in values[offset..end].iter().enumerate() {
                        if relative > 0 {
                            text.push(',');
                        }
                        text.push_str(raw);
                    }
                    text.push(']');
                    emit(
                        format!("{kind}:{offset:08}"),
                        kind,
                        offset,
                        end - offset,
                        text,
                    )?;
                }
                Ok(())
            };
        emit_raw_ranges(
            &self.entity_raw,
            "entities",
            ENTITY_CHECKPOINT_CHUNK_SIZE,
            &mut emit,
        )?;
        emit_raw_ranges(
            &self.belt_raw,
            "belts",
            BELT_CHECKPOINT_CHUNK_SIZE,
            &mut emit,
        )?;

        let root_material = checkpoint_root_material(&metadata)?;
        let manifest_key = format!("{prefix}manifest");
        let mut manifest_value = serde_json::json!({
            "formatVersion": DOMAIN_INTERNAL_CHECKPOINT_FORMAT_VERSION,
            "envelopeFormatVersion": 2,
            "mode": self.identity.mode,
            "slot": "main",
            "stateVersion": 47,
            "savedAt": saved_at_ms,
            "basePrimaryChecksum": self.identity.base_primary_checksum,
            "chunkRootChecksum": fnv1a_utf8(root_material.as_bytes()),
            "totalBytes": total_bytes,
            "entityCount": self.entity_raw.len(),
            "beltCount": self.belt_raw.len(),
            "chunks": metadata,
        });
        if let Some(session) = self
            .pure_idle_session
            .filter(|session| session.last_committed_revision == self.revision)
        {
            let key = if session.macro_v10 {
                "pureIdleMacroSession"
            } else {
                "pureIdleSession"
            };
            manifest_value
                .as_object_mut()
                .expect("native checkpoint manifest is an object")
                .insert(key.to_owned(), serde_json::to_value(session)?);
        }
        let manifest = serde_json::to_string(&manifest_value)?;
        visit(&manifest_key, &manifest)?;
        active_keys.push(manifest_key);
        Ok(active_keys)
    }

    /// Emits only checkpoint records whose owning page is dirty while still
    /// returning the complete active-key set required for stale-record
    /// removal. Clean page metadata is reused from the verified generation;
    /// the save transaction already starts from that generation's manifest.
    /// Dirtiness is not cleared here because the filesystem commit may still
    /// fail after this method returns.
    pub fn visit_dirty_internal_checkpoint_records(
        &self,
        saved_at_ms: u64,
        mut visit: impl FnMut(&str, &str) -> anyhow::Result<()>,
    ) -> anyhow::Result<InternalCheckpointVisitResult> {
        let prefix = format!(
            "dsp-idle-network.internal.v1.chunked.v1.{}.",
            self.identity.mode
        );
        let previous = self
            .checkpoint_chunks
            .iter()
            .map(|chunk| (chunk.id.clone(), chunk.clone()))
            .collect::<HashMap<_, _>>();
        let mut metadata = Vec::<ChunkMetadata>::new();
        let mut active_keys = Vec::<String>::new();
        let mut encoded_records = 0_usize;
        let mut reused_records = 0_usize;

        let mut install = |chunk: ChunkMetadata, text: Option<String>| -> anyhow::Result<()> {
            let key = format!("{prefix}chunk.{}", encoded_chunk_id(&chunk.id));
            if let Some(text) = text {
                visit(&key, &text)?;
                encoded_records += 1;
            } else {
                reused_records += 1;
            }
            active_keys.push(key);
            metadata.push(chunk);
            Ok(())
        };

        // Base domains intentionally do not depend on manually maintained
        // dirty bits. Exact serialized content is compared with the last
        // durable generation, so an unmarked mutation is still detected while
        // unrelated systems remain reusable.
        for domain in BASE_CHECKPOINT_DOMAINS {
            let (text, count) = encode_base_checkpoint_domain(&self.base, domain)?;
            let candidate = checkpoint_chunk_metadata(domain.id(), domain.kind(), 0, count, &text);
            if let Some(cached) = previous
                .get(domain.id())
                .filter(|cached| checkpoint_chunk_content_matches(cached, &candidate))
            {
                install(cached.clone(), None)?;
            } else {
                install(candidate, Some(text))?;
            }
        }

        let mut install_pages = |values: &[RawRecord],
                                 kind: &str,
                                 chunk_size: usize,
                                 topology_dirty: bool,
                                 dirty_pages: &BTreeSet<usize>|
         -> anyhow::Result<()> {
            let page_count = values.len().max(1).div_ceil(chunk_size);
            for page in 0..page_count {
                let offset = page * chunk_size;
                let end = (offset + chunk_size).min(values.len());
                let count = end.saturating_sub(offset);
                let id = format!("{kind}:{offset:08}");
                let cached = previous.get(&id).filter(|chunk| {
                    chunk.kind == kind
                        && chunk.offset == offset
                        && chunk.count == count
                        && checkpoint_chunk_has_valid_sha256_metadata(chunk)
                });
                if !topology_dirty
                    && !dirty_pages.contains(&page)
                    && let Some(chunk) = cached
                {
                    install((*chunk).clone(), None)?;
                    continue;
                }
                let capacity = values[offset..end]
                    .iter()
                    .map(|raw| raw.len() + 1)
                    .sum::<usize>()
                    .saturating_add(1);
                let mut text = String::with_capacity(capacity);
                text.push('[');
                for (relative, raw) in values[offset..end].iter().enumerate() {
                    if relative > 0 {
                        text.push(',');
                    }
                    text.push_str(raw);
                }
                text.push(']');
                let metadata = checkpoint_chunk_metadata(id, kind, offset, count, &text);
                install(metadata, Some(text))?;
            }
            Ok(())
        };
        install_pages(
            &self.entity_raw,
            "entities",
            ENTITY_CHECKPOINT_CHUNK_SIZE,
            self.save_dirty.entity_topology,
            &self.save_dirty.entity_pages,
        )?;
        install_pages(
            &self.belt_raw,
            "belts",
            BELT_CHECKPOINT_CHUNK_SIZE,
            self.save_dirty.belt_topology,
            &self.save_dirty.belt_pages,
        )?;

        let total_bytes = metadata.iter().map(|chunk| chunk.bytes).sum::<usize>();
        let root_material = checkpoint_root_material(&metadata)?;
        let manifest_key = format!("{prefix}manifest");
        let mut manifest_value = serde_json::json!({
            "formatVersion": DOMAIN_INTERNAL_CHECKPOINT_FORMAT_VERSION,
            "envelopeFormatVersion": 2,
            "mode": self.identity.mode,
            "slot": "main",
            "stateVersion": 47,
            "savedAt": saved_at_ms,
            "basePrimaryChecksum": self.identity.base_primary_checksum,
            "chunkRootChecksum": fnv1a_utf8(root_material.as_bytes()),
            "totalBytes": total_bytes,
            "entityCount": self.entity_raw.len(),
            "beltCount": self.belt_raw.len(),
            "chunks": metadata,
        });
        if let Some(session) = self
            .pure_idle_session
            .filter(|session| session.last_committed_revision == self.revision)
        {
            let key = if session.macro_v10 {
                "pureIdleMacroSession"
            } else {
                "pureIdleSession"
            };
            manifest_value
                .as_object_mut()
                .expect("native checkpoint manifest is an object")
                .insert(key.to_owned(), serde_json::to_value(session)?);
        }
        let manifest = serde_json::to_string(&manifest_value)?;
        visit(&manifest_key, &manifest)?;
        encoded_records += 1;
        active_keys.push(manifest_key);
        *self.pending_checkpoint_chunks.borrow_mut() = Some(metadata);
        Ok(InternalCheckpointVisitResult {
            active_keys,
            encoded_records,
            reused_records,
        })
    }

    pub fn install_checkpoint_identity(&mut self, generation: u64, root_hash: String) {
        self.identity.generation = generation;
        self.identity.root_hash = root_hash;
        self.identity.revision = self.revision;
        if let Some(chunks) = self.pending_checkpoint_chunks.get_mut().take() {
            self.checkpoint_chunks = chunks;
        }
        self.save_dirty.clear();
    }

    pub fn abort_checkpoint_visit(&self) {
        self.pending_checkpoint_chunks.borrow_mut().take();
    }

    pub(crate) fn refresh_factory_static_admission(&mut self) -> anyhow::Result<()> {
        self.factory_static_admission_reason =
            crate::simple_factory::static_admission_reason(self)?;
        self.factory_static_admission_checked = true;
        Ok(())
    }

    fn refresh_factory_static_admission_with_entities(
        &mut self,
        entities: &[Value],
    ) -> anyhow::Result<()> {
        self.factory_static_admission_reason =
            crate::simple_factory::static_admission_reason_with_entities(self, entities)?;
        self.factory_static_admission_checked = true;
        Ok(())
    }

    pub(crate) fn factory_static_admission_reason(&self) -> Option<Option<&'static str>> {
        self.factory_static_admission_checked
            .then_some(self.factory_static_admission_reason)
    }

    pub(crate) fn invalidate_factory_static_admission(&mut self) {
        self.factory_static_admission_checked = false;
        self.factory_static_admission_reason = None;
        self.prepared_belt_routes = None;
        self.prepared_belt_activity = None;
    }

    pub(crate) fn prepared_belt_routes(&self) -> Option<Arc<crate::belts::PreparedRoutes>> {
        self.prepared_belt_routes.clone()
    }

    pub(crate) fn install_prepared_belt_routes(
        &mut self,
        routes: Arc<crate::belts::PreparedRoutes>,
    ) {
        self.prepared_belt_routes = Some(routes);
    }

    pub(crate) fn prepared_belt_activity(&self) -> Option<Arc<crate::belts::BeltActivitySnapshot>> {
        self.prepared_belt_activity.clone()
    }

    pub(crate) fn install_prepared_belt_activity(
        &mut self,
        activity: Arc<crate::belts::BeltActivitySnapshot>,
    ) {
        self.prepared_belt_activity = Some(activity);
    }

    pub(crate) fn prepared_local_peer_directory(
        &self,
    ) -> Option<Arc<crate::local_logistics::LocalPeerDirectory>> {
        self.prepared_local_peer_directory.clone()
    }

    pub(crate) fn install_prepared_local_peer_directory(
        &mut self,
        directory: Arc<crate::local_logistics::LocalPeerDirectory>,
    ) {
        self.prepared_local_peer_directory = Some(directory);
    }

    pub(crate) fn prepared_interstellar_route_activity(
        &self,
    ) -> Option<Arc<crate::interstellar_logistics::InterstellarRouteActivity>> {
        self.prepared_interstellar_route_activity.clone()
    }

    pub(crate) fn install_prepared_interstellar_route_activity(
        &mut self,
        activity: Arc<crate::interstellar_logistics::InterstellarRouteActivity>,
    ) {
        self.prepared_interstellar_route_activity = Some(activity);
    }

    pub(crate) fn rebuild_indexes(&mut self) -> anyhow::Result<()> {
        let entities = self.parse_entities_parallel()?;
        self.rebuild_indexes_from_parsed_entities(&entities)?;
        if !sync_record_drop_enabled() {
            self.install_parsed_entity_runtime(entities);
        }
        Ok(())
    }

    fn rebuild_indexes_from_parsed_entities(
        &mut self,
        entity_values: &[Value],
    ) -> anyhow::Result<()> {
        if entity_values.len() != self.entity_raw.len() {
            bail!("native core parsed record count is inconsistent");
        }
        self.symbols = Symbols::default().into();
        self.entities = EntityColumns::with_capacity(entity_values.len()).into();
        self.entity_dynamics = EntityDynamicColumns::default().into();
        self.last_entity_raw_writeback = EntityRawWritebackDiagnostics::default();
        self.belts = BeltColumns::with_capacity(self.belt_raw.len()).into();
        self.belt_dynamics = BeltDynamicColumns::with_capacity(self.belt_raw.len()).into();
        self.entity_index = ExactRowIdIndex::default().into();
        self.belt_index = ExactRowIdIndex::default().into();
        let mut entity_ids = Vec::<Box<str>>::with_capacity(entity_values.len());
        let mut belt_ids = Vec::<Box<str>>::with_capacity(self.belt_raw.len());
        let planet_indices = self
            .catalog
            .planets
            .iter()
            .enumerate()
            .map(|(index, planet)| (planet.id.as_str(), index))
            .collect::<HashMap<_, _>>();
        let mut factory_topology = FactoryTopology {
            entities_by_planet: vec![Vec::new(); self.catalog.planets.len()],
            belts_by_planet: vec![Vec::new(); self.catalog.planets.len()],
            device_counts_by_planet: vec![0.0; self.catalog.planets.len()],
            ..FactoryTopology::default()
        };
        let mut entity_dynamics = EntityDynamicColumns::with_capacity(entity_values.len());
        for (index, value) in entity_values.iter().enumerate() {
            let object = value
                .as_object()
                .ok_or_else(|| anyhow!("native core entity is not an object"))?;
            let id = object_string(object, "id")
                .ok_or_else(|| anyhow!("native core entity ID is missing"))?;
            entity_ids.push(id.into());
            self.entities
                .kinds
                .push(self.symbols.intern(object_string(object, "kind")));
            self.entities
                .planets
                .push(self.symbols.intern(object_string(object, "planetId")));
            self.entities
                .buildings
                .push(self.symbols.intern(object_string(object, "buildingId")));
            self.entities
                .recipes
                .push(self.symbols.intern(object_string(object, "recipeId")));
            self.entities
                .resources
                .push(self.symbols.intern(object_string(object, "resourceId")));
            self.entities
                .stored_items
                .push(self.symbols.intern(object_string(object, "storedItemId")));
            self.entities
                .machine_counts
                .push(object_number(object, "machineCount"));
            self.entities
                .miner_counts
                .push(object_number(object, "minerCount"));
            let position = object.get("position").and_then(Value::as_object);
            self.entities.position_x.push(
                position
                    .and_then(|value| value.get("x"))
                    .and_then(Value::as_f64)
                    .filter(|value| value.is_finite())
                    .unwrap_or(0.0),
            );
            self.entities.position_y.push(
                position
                    .and_then(|value| value.get("y"))
                    .and_then(Value::as_f64)
                    .filter(|value| value.is_finite())
                    .unwrap_or(0.0),
            );
            entity_dynamics.push_from_object(object)?;

            let kind = object_string(object, "kind").unwrap_or_default();
            let building = object_string(object, "buildingId").unwrap_or_default();
            let recipe = object_string(object, "recipeId").unwrap_or_default();
            if kind == "station" {
                factory_topology.station_indices.push(index);
                if matches!(
                    building,
                    "interstellar_logistics_station" | "orbital_collector"
                ) {
                    factory_topology.quantum_endpoint_indices.push(index);
                }
            } else {
                factory_topology.non_station_indices.push(index);
            }
            if kind == "machine" && building == "construction_center" {
                factory_topology.construction_center_indices.push(index);
            }
            if building == "time_warp_device" {
                factory_topology.time_warp_indices.push(index);
            }
            if matches!(kind, "storage" | "splitter") {
                factory_topology.logistics_buffer_indices.push(index);
            }
            if building == "material_delivery_hub" {
                factory_topology.material_delivery_hub_indices.push(index);
            }
            if building == "orbital_cargo_terminal" {
                factory_topology.orbital_cargo_terminal_indices.push(index);
            }
            if building == "galactic_material_exporter" {
                factory_topology
                    .galactic_material_exporter_indices
                    .push(index);
            }
            if building == "space_station_construction_launcher" {
                factory_topology.space_station_launcher_indices.push(index);
            }
            if kind == "machine" && building == "ray_receiver" {
                factory_topology.ray_receiver_indices.push(index);
            }
            if kind == "power"
                || (kind == "machine" && building == "ray_receiver" && recipe == "ray_power")
            {
                factory_topology.power_source_indices.push(index);
            }
            if kind == "vein" {
                factory_topology.vein_indices.push(index);
            }
            if kind == "machine"
                && !matches!(
                    building,
                    "construction_center"
                        | "time_warp_device"
                        | "ray_receiver"
                        | "galactic_material_exporter"
                        | "micro_black_hole_connector"
                )
            {
                factory_topology.ordinary_machine_indices.push(index);
            }
            if recipe == "matrix_research" {
                factory_topology.research_entity_indices.push(index);
            }
            factory_topology.has_galactic_material_exporter |=
                building == "galactic_material_exporter";
            let entity_planet = object_string(object, "planetId")
                .and_then(|id| planet_indices.get(id).copied())
                .unwrap_or(usize::MAX);
            factory_topology.entity_planet_indices.push(entity_planet);
            if let Some(indices) = factory_topology.entities_by_planet.get_mut(entity_planet) {
                indices.push(index);
            }
            if let Some(device_count) = factory_topology
                .device_counts_by_planet
                .get_mut(entity_planet)
            {
                *device_count +=
                    self.entities.machine_counts[index] + self.entities.miner_counts[index];
            }
            factory_topology.entity_grid_indices.push(
                match object_string(object, "powerGridId").unwrap_or("grid-a") {
                    "grid-a" => 0,
                    "grid-b" => 1,
                    "grid-c" => 2,
                    _ => usize::MAX,
                },
            );
        }
        let entity_index = ExactRowIdIndex::from_boxed(entity_ids, "entity")?;
        self.entities.ids = entity_index.ids();
        self.entity_index = entity_index.into();
        let mut entity_belt_rows = vec![Vec::<usize>::new(); entity_values.len()];

        for index in 0..self.belt_raw.len() {
            let value = self.parse_belt(index)?;
            let object = value
                .as_object()
                .ok_or_else(|| anyhow!("native core belt is not an object"))?;
            let id = object_string(object, "id")
                .ok_or_else(|| anyhow!("native core belt ID is missing"))?;
            belt_ids.push(id.into());
            let source_id = object_string(object, "source");
            let target_id = object_string(object, "target");
            self.belts
                .planets
                .push(self.symbols.intern(object_string(object, "planetId")));
            self.belts.sources.push(self.symbols.intern(source_id));
            self.belts.targets.push(self.symbols.intern(target_id));
            self.belts
                .items
                .push(self.symbols.intern(object_string(object, "itemId")));
            self.belts.lanes.push(
                object
                    .get("lanes")
                    .map(|value| {
                        value
                            .as_f64()
                            .filter(|value| value.is_finite())
                            .unwrap_or(0.0)
                    })
                    .unwrap_or(1.0),
            );
            self.belts.tiers.push(
                object
                    .get("tier")
                    .and_then(Value::as_u64)
                    .unwrap_or(0)
                    .min(u8::MAX as u64) as u8,
            );
            self.belts
                .stack_sizes
                .push(object_number(object, "stackSize").max(1.0));
            self.belts.priorities.push(
                object
                    .get("priority")
                    .and_then(Value::as_u64)
                    .unwrap_or(1)
                    .min(2) as u8,
            );
            self.belt_dynamics.push_from_object(object)?;
            if let Some(planet) = object_string(object, "planetId")
                .and_then(|id| planet_indices.get(id).copied())
                .and_then(|planet| factory_topology.belts_by_planet.get_mut(planet))
            {
                planet.push(index);
            }
            for endpoint_id in [source_id, target_id].into_iter().flatten() {
                if let Some(&entity_index) = self.entity_index.get(endpoint_id) {
                    entity_belt_rows[entity_index].push(index);
                }
            }
        }
        let belt_index = ExactRowIdIndex::from_boxed(belt_ids, "belt")?;
        self.belts.ids = belt_index.ids();
        self.belt_index = belt_index.into();
        entity_dynamics.validate(entity_values.len())?;
        self.entity_dynamics = entity_dynamics.into();
        self.belt_dynamics.validate(self.belt_raw.len())?;
        self.belt_dynamics.clear_dirty();
        factory_topology.planet_viewport_indexes = factory_topology
            .entities_by_planet
            .iter()
            .map(|indices| PlanetViewportIndex::build(indices, &self.entities))
            .collect();
        factory_topology.entity_belt_adjacency = EntityBeltAdjacency::from_rows(entity_belt_rows);
        // These immutable indexes live for the complete native session. Trim
        // geometric growth slack once, after construction, so a large save
        // does not retain several MiB of unreachable topology capacity.
        factory_topology.shrink_to_fit();
        self.factory_topology = Arc::new(factory_topology);
        // Record commands may alter station slots or elevator mode. The next
        // admitted advance recompiles this immutable directory from the new
        // records; keeping the previous one would route against stale topology.
        self.prepared_local_peer_directory = None;
        self.prepared_interstellar_route_activity = None;
        Ok(())
    }

    pub(crate) fn parse_entity(&self, index: usize) -> anyhow::Result<Value> {
        serde_json::from_str(&self.entity_raw[index]).context("decode native core entity")
    }

    pub(crate) fn parse_belt(&self, index: usize) -> anyhow::Result<Value> {
        serde_json::from_str(&self.belt_raw[index]).context("decode native core belt")
    }

    pub(crate) fn belt_raw_record(&self, index: usize) -> &RawRecord {
        &self.belt_raw[index]
    }

    pub(crate) fn validate_belt_runtime_topology(&self) -> anyhow::Result<usize> {
        let rows = self.belts.ids.len();
        if self.belt_raw.len() != rows
            || self.belts.planets.len() != rows
            || self.belts.sources.len() != rows
            || self.belts.targets.len() != rows
            || self.belts.items.len() != rows
            || self.belts.lanes.len() != rows
            || self.belts.tiers.len() != rows
            || self.belts.stack_sizes.len() != rows
            || self.belts.priorities.len() != rows
        {
            bail!("native belt runtime topology changed");
        }
        // Full value validation is paid when records enter the resident state.
        // Per-revision runtimes only need this fixed-depth shape proof; every
        // subsequently writable page is value-validated before publication.
        self.belt_dynamics.validate_shape(rows)?;
        Ok(rows)
    }

    pub(crate) fn belt_commit_source(&self) -> BeltCommitSource {
        BeltCommitSource {
            revision: self.revision,
            raw: self.belt_raw.0.clone(),
            topology: self.belts.0.clone(),
            dynamics: self.belt_dynamics.0.clone(),
        }
    }

    pub(crate) fn parse_entities_parallel(&self) -> anyhow::Result<Vec<Value>> {
        parse_records_parallel(&self.entity_raw, "native core entity")
    }

    pub(crate) fn take_entities_for_simulation(&self) -> anyhow::Result<Vec<Value>> {
        if let Some(values) = self.parsed_entity_runtime.take(self.entity_raw.len()) {
            if std::env::var_os("DSP_NATIVE_CORE_PROFILE").is_some() {
                eprintln!(
                    "DSP_NATIVE_CORE_PROFILE\tstate-entity-runtime-cache\treused\trows={}",
                    values.len()
                );
            }
            return Ok(values);
        }
        if std::env::var_os("DSP_NATIVE_CORE_PROFILE").is_some() {
            eprintln!(
                "DSP_NATIVE_CORE_PROFILE\tstate-entity-runtime-cache\tdecoded\trows={}",
                self.entity_raw.len()
            );
        }
        self.parse_entities_parallel()
    }

    fn install_parsed_entity_runtime(&mut self, values: Vec<Value>) {
        debug_assert_eq!(values.len(), self.entity_raw.len());
        self.parsed_entity_runtime = Arc::new(EntityRuntimeCache::with_values(values));
    }

    #[cfg(test)]
    pub(crate) fn parsed_entity_runtime_rows_for_test(&self) -> usize {
        self.parsed_entity_runtime.resident_rows()
    }

    /// Read-only scalar access over the authoritative raw row. The former dense
    /// resident mirror exceeded the real-save memory gate and had no production
    /// consumer; one-row lazy decoding preserves missing/null/MOD/-0 semantics
    /// without keeping a second inventory graph alive in every CoreState.
    pub fn entity_dynamic_number(
        &self,
        index: usize,
        field: EntityDynamicField,
    ) -> Option<ResidentNumber> {
        let entity: Value = serde_json::from_str(self.entity_raw.get(index)?.as_ref()).ok()?;
        let object = entity.as_object()?;
        let (kind, value) = ResidentValueKind::classify(object.get(field.key()));
        Some(ResidentNumber { kind, value })
    }

    /// Read-only inventory access decoded from one authoritative raw row. The
    /// returned view owns only that requested row and never becomes resident
    /// CoreState memory.
    pub fn entity_inventory(
        &self,
        index: usize,
        side: EntityInventorySide,
    ) -> Option<EntityInventoryView> {
        let entity: Value = serde_json::from_str(self.entity_raw.get(index)?.as_ref()).ok()?;
        let object = entity.as_object()?;
        let key = match side {
            EntityInventorySide::Inputs => "inputs",
            EntityInventorySide::Outputs => "outputs",
        };
        let (container_kind, entries) = match object.get(key) {
            None => (ResidentObjectKind::Missing, Vec::new()),
            Some(Value::Null) => (ResidentObjectKind::Null, Vec::new()),
            Some(Value::Object(values)) => (
                ResidentObjectKind::Object,
                values
                    .iter()
                    .map(|(item_id, amount)| {
                        let (kind, value) = ResidentValueKind::classify(Some(amount));
                        OwnedEntityInventoryEntry {
                            item_id: item_id.as_str().into(),
                            amount: ResidentNumber { kind, value },
                        }
                    })
                    .collect(),
            ),
            Some(_) => (ResidentObjectKind::Other, Vec::new()),
        };
        Some(EntityInventoryView {
            container_kind,
            entries,
        })
    }

    pub fn entity_raw_writeback_diagnostics(&self) -> EntityRawWritebackDiagnostics {
        self.last_entity_raw_writeback
    }

    #[cfg(test)]
    pub(crate) fn parse_belts_parallel(&self) -> anyhow::Result<Vec<Value>> {
        parse_records_parallel(&self.belt_raw, "native core belt")
    }

    pub(crate) fn base_value_mut(&mut self) -> &mut Map<String, Value> {
        self.summary_cache.get_mut().take();
        self.production_history_tiers.invalidate();
        &mut self.base
    }

    /// Commands are applied to a disposable cloned state. Moving the base map
    /// out through this boundary avoids cloning or invalidating the private
    /// history tiers before the command has been classified. The caller must
    /// rebuild the tiers whenever a patch can touch their public source.
    pub(crate) fn take_base_for_command(&mut self) -> Map<String, Value> {
        self.summary_cache.get_mut().take();
        std::mem::take(&mut self.base)
    }

    pub(crate) fn install_base_from_command(
        &mut self,
        base: Map<String, Value>,
        rebuild_production_history: bool,
    ) {
        self.base = base;
        if rebuild_production_history {
            self.rebuild_production_history_tiers();
        }
    }
    pub(crate) fn base_value(&self) -> &Map<String, Value> {
        &self.base
    }

    pub(crate) fn refresh_production_history_tiers(&mut self) {
        self.production_history_tiers
            .refresh_after_internal_sample(&self.base);
    }

    pub(crate) fn rebuild_production_history_tiers(&mut self) {
        self.production_history_tiers.refresh_from_base(&self.base);
    }

    /// Exports only the disposable desktop diagnostics cache. The returned
    /// value is excluded from public v47 state, canonical hashes and the
    /// authoritative checkpoint manifest.
    pub fn production_history_sidecar(&self) -> Option<Value> {
        self.production_history_tiers.sidecar_value(&self.base)
    }

    /// Installs a previously validated, identity-bound diagnostics cache.
    /// Callers must treat every error as a cache miss and keep the history
    /// rebuilt from public v47 state.
    pub fn restore_production_history_sidecar(&mut self, value: Value) -> anyhow::Result<()> {
        self.production_history_tiers
            .restore_sidecar(&self.base, value)
    }

    /// Returns progress only when no other committed operation has interrupted
    /// the conservative session. Commands and exact/realtime advances already
    /// move `revision`; observing that mismatch is the reset boundary.
    pub(crate) fn pure_idle_exact_seconds_used(&self) -> f64 {
        self.pure_idle_session
            .filter(|session| {
                session.last_committed_revision == self.revision && !session.macro_v10
            })
            .map(|session| session.exact_simulation_seconds_used)
            .unwrap_or(0.0)
    }

    pub(crate) fn pure_idle_macro_exact_seconds_used(&self) -> f64 {
        self.pure_idle_session
            .filter(|session| session.last_committed_revision == self.revision && session.macro_v10)
            .map(|session| session.exact_simulation_seconds_used)
            .unwrap_or(0.0)
    }

    /// Installs session progress on a disposable candidate. Callers must do
    /// this only after every simulation, multiplier and diagnostic check has
    /// succeeded, immediately before atomically replacing the live state.
    pub(crate) fn install_pure_idle_session_progress(
        &mut self,
        exact_simulation_seconds_used: f64,
    ) -> anyhow::Result<()> {
        PureIdleSessionState {
            format_version: PURE_IDLE_SESSION_FORMAT_VERSION,
            exact_simulation_seconds_used,
            last_committed_revision: self.revision,
            macro_v10: false,
        }
        .validate(self.revision)
        .map(|session| self.pure_idle_session = Some(session))
    }

    pub(crate) fn install_pure_idle_macro_session_progress(
        &mut self,
        exact_simulation_seconds_used: f64,
    ) -> anyhow::Result<()> {
        PureIdleSessionState {
            format_version: PURE_IDLE_SESSION_FORMAT_VERSION,
            exact_simulation_seconds_used,
            last_committed_revision: self.revision,
            macro_v10: true,
        }
        .validate(self.revision)
        .map(|session| self.pure_idle_session = Some(session))
    }

    pub(crate) fn replace_entity_raw(&mut self, index: usize, value: RawRecord) {
        self.parsed_entity_runtime.clear();
        self.summary_cache.get_mut().take();
        self.last_entity_raw_writeback = EntityRawWritebackDiagnostics::default();
        self.entity_raw[index] = value;
        self.save_dirty.mark_entity(index);
    }

    pub(crate) fn replace_belt_raw(&mut self, index: usize, value: RawRecord) {
        self.summary_cache.get_mut().take();
        self.belt_raw[index] = value;
        self.save_dirty.mark_belt(index);
    }

    pub(crate) fn entity_raw_mut_topology(&mut self) -> &mut Vec<RawRecord> {
        self.parsed_entity_runtime.clear();
        self.summary_cache.get_mut().take();
        self.save_dirty.mark_entity_topology();
        self.last_entity_raw_writeback = EntityRawWritebackDiagnostics::default();
        &mut self.entity_raw
    }

    pub(crate) fn belt_raw_mut_topology(&mut self) -> &mut Vec<RawRecord> {
        self.summary_cache.get_mut().take();
        self.save_dirty.mark_belt_topology();
        &mut self.belt_raw
    }

    pub(crate) fn commit_simulated_state(
        &mut self,
        base: Map<String, Value>,
        entities: Vec<Value>,
        belt_commit: crate::belts::BeltCommitBatch,
        next_revision: u64,
        populate_summary_cache: bool,
    ) -> anyhow::Result<Option<CoreStateSummary>> {
        let profile_enabled = std::env::var_os("DSP_NATIVE_CORE_PROFILE").is_some();
        let mut profile_checkpoint = std::time::Instant::now();
        macro_rules! profile_mark {
            ($label:literal) => {
                if profile_enabled {
                    eprintln!(
                        "DSP_NATIVE_CORE_PROFILE\tcommit-{}\t{:.3}",
                        $label,
                        profile_checkpoint.elapsed().as_secs_f64() * 1_000.0
                    );
                    profile_checkpoint = std::time::Instant::now();
                }
            };
        }
        macro_rules! profile_last {
            ($label:literal) => {
                if profile_enabled {
                    eprintln!(
                        "DSP_NATIVE_CORE_PROFILE\tcommit-{}\t{:.3}",
                        $label,
                        profile_checkpoint.elapsed().as_secs_f64() * 1_000.0
                    );
                }
            };
        }
        if entities.len() != self.entity_raw.len()
            || next_revision != self.revision.saturating_add(1)
        {
            bail!("native simulation changed record topology");
        }
        // The sealed runtime batch proves that it was derived from this
        // revision and these Arc-backed columns. Recheck the cheap structural
        // invariant before any patch index is used so an internally damaged
        // state fails closed instead of panicking during candidate assembly.
        self.validate_belt_runtime_topology()?;
        let belt_commit = belt_commit.unseal(self)?;
        let (belt_patches, belt_dynamics) = belt_commit.into_parts();
        profile_mark!("identity");

        let entity_writeback =
            encode_entity_records_full(&entities, &self.entity_raw, &self.entities.ids)?;
        let (entity_writeback, inventory_entry_count, shared_rows) = entity_writeback.into_parts();
        let entity_dynamics =
            EntityDynamicColumns::from_full_encode(entities.len(), inventory_entry_count);
        let entity_dynamics_changed = !entity_dynamics.bitwise_eq(&self.entity_dynamics);
        let writeback_diagnostics = EntityRawWritebackDiagnostics {
            full_encoded_rows: entity_writeback.len(),
            shared_rows,
            changed_rows: entity_writeback.len() - shared_rows,
        };
        if profile_enabled {
            eprintln!(
                "DSP_NATIVE_CORE_PROFILE\tcommit-entity-raw-full-encode\t{:.3}\tencoded={}\tshared={}\tchanged={}",
                profile_checkpoint.elapsed().as_secs_f64() * 1_000.0,
                writeback_diagnostics.full_encoded_rows,
                writeback_diagnostics.shared_rows,
                writeback_diagnostics.changed_rows
            );
            profile_checkpoint = std::time::Instant::now();
        }

        // All validation and fallible encoding above completed against the
        // live state. Apply records to a cheap COW candidate; only a fully
        // valid candidate may replace `self`.
        let mut candidate = self.clone();
        candidate.summary_cache.get_mut().take();
        for (index, row) in entity_writeback.iter().enumerate() {
            if !Arc::ptr_eq(row, &self.entity_raw[index]) {
                candidate.save_dirty.mark_entity(index);
            }
        }
        for patch in belt_patches {
            let (index, raw) = patch.into_parts();
            if !Arc::ptr_eq(&self.belt_raw[index], &raw)
                && self.belt_raw[index].as_ref() != raw.as_ref()
            {
                candidate.save_dirty.mark_belt(index);
                candidate.belt_raw[index] = raw;
            }
        }
        candidate.base = base;
        if writeback_diagnostics.changed_rows != 0 {
            candidate.entity_raw = entity_writeback.into();
        }
        candidate.last_entity_raw_writeback = writeback_diagnostics;
        if entity_dynamics_changed {
            candidate.entity_dynamics = entity_dynamics.into();
        }
        if let Some(belt_dynamics) = belt_dynamics {
            candidate.belt_dynamics = belt_dynamics.into();
        }
        candidate.revision = next_revision;
        let summary = if populate_summary_cache {
            let canonical = candidate.canonical_digest_bundle_with_parsed(Some(&entities), None)?;
            let summary = candidate.summary_from_digest(canonical);
            candidate
                .summary_cache
                .replace(Some((candidate.revision, summary.clone())));
            Some(summary)
        } else {
            None
        };
        let retired_entities = if sync_record_drop_enabled() {
            Some(entities)
        } else {
            candidate.install_parsed_entity_runtime(entities);
            None
        };
        *self = candidate;
        self.refresh_production_history_tiers();
        if let Some(entities) = retired_entities {
            retire_record_values(entities, Vec::new());
        }
        profile_last!("install");
        Ok(summary)
    }

    /// Streams a public v47/envelope-v2 export directly from native-owned
    /// records. The state is never materialized as a second `Value` graph or
    /// one giant String. The legacy checksum is calculated over the exact
    /// UTF-16 JSON code units while SHA-256 and byte length are calculated over
    /// the bytes written to the destination.
    pub fn write_v47_envelope(
        &self,
        saved_at_ms: u64,
        mut writer: impl IoWrite,
    ) -> anyhow::Result<V47EnvelopeExportResult> {
        if self.identity.state_version != 47 || saved_at_ms > 9_007_199_254_740_991 {
            bail!("native v47 export identity is invalid");
        }
        let mut envelope_sha = Sha256::new();
        let mut byte_length = 0_u64;
        let mut state_checksum = Utf16Fnv1a::new();
        state_checksum.update("{\"formatVersion\":2,\"state\":");
        let checksum;
        {
            let mut write = |text: &str| -> anyhow::Result<()> {
                let next_byte_length = byte_length
                    .checked_add(u64::try_from(text.len())?)
                    .ok_or_else(|| anyhow!("native v47 export byte length overflowed"))?;
                writer.write_all(text.as_bytes())?;
                envelope_sha.update(text.as_bytes());
                byte_length = next_byte_length;
                Ok(())
            };
            let prefix = format!(
                "{{\"formatVersion\":2,\"kind\":\"primary\",\"mode\":{},\"slot\":\"main\",\"savedAt\":{},\"state\":",
                serde_json::to_string(&self.identity.mode)?,
                saved_at_ms,
            );
            write(&prefix)?;

            {
                let mut write_state = |text: &str| -> anyhow::Result<()> {
                    state_checksum.update(text);
                    write(text)
                };
                write_state("{")?;
                let mut first = true;
                for (key, value) in &self.base {
                    if !first {
                        write_state(",")?;
                    }
                    first = false;
                    write_state(&serde_json::to_string(key)?)?;
                    write_state(":")?;
                    write_state(&serde_json::to_string(value)?)?;
                }
                for (key, records) in [
                    ("entities", self.entity_raw.as_slice()),
                    ("belts", self.belt_raw.as_slice()),
                ] {
                    if !first {
                        write_state(",")?;
                    }
                    first = false;
                    write_state(&serde_json::to_string(key)?)?;
                    write_state(":")?;
                    write_state("[")?;
                    for (index, raw) in records.iter().enumerate() {
                        if index > 0 {
                            write_state(",")?;
                        }
                        write_state(raw)?;
                    }
                    write_state("]")?;
                }
                write_state("}")?;
            }
            state_checksum.update("}");
            checksum = state_checksum.finish();
            write(&format!(",\"checksum\":\"{checksum}\"}}"))?;
        }
        writer.flush()?;
        Ok(V47EnvelopeExportResult {
            revision: self.revision,
            saved_at_ms,
            byte_length,
            envelope_sha256: hex::encode(envelope_sha.finalize()),
            state_checksum: checksum,
        })
    }

    pub fn materialize(&self) -> anyhow::Result<Value> {
        let mut state = self.base.clone();
        state.insert(
            "entities".to_owned(),
            Value::Array(
                self.entity_raw
                    .iter()
                    .map(|raw| serde_json::from_str(raw).context("decode native entity for export"))
                    .collect::<anyhow::Result<Vec<_>>>()?,
            ),
        );
        state.insert(
            "belts".to_owned(),
            Value::Array(
                self.belt_raw
                    .iter()
                    .map(|raw| serde_json::from_str(raw).context("decode native belt for export"))
                    .collect::<anyhow::Result<Vec<_>>>()?,
            ),
        );
        Ok(Value::Object(state))
    }

    pub fn projection(
        &self,
        base_fields: &[String],
        entity_ids: &[String],
        belt_ids: &[String],
    ) -> anyhow::Result<Value> {
        if base_fields.len() > MAX_PROJECTION_BASE_FIELDS
            || entity_ids.len() > MAX_PROJECTION_ENTITIES
            || belt_ids.len() > MAX_PROJECTION_BELTS
        {
            bail!("native core projection selection is too large");
        }
        let valid_key = |value: &str| {
            !value.is_empty()
                && value.len() <= 160
                && value.bytes().all(|byte| {
                    byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.' | b':' | b'/')
                })
        };
        if base_fields
            .iter()
            .chain(entity_ids)
            .chain(belt_ids)
            .any(|value| !valid_key(value))
        {
            bail!("native core projection contains an invalid selector");
        }
        let mut base = Map::new();
        for field in base_fields {
            if matches!(field.as_str(), "entities" | "belts") {
                bail!("native core projection cannot select an unbounded collection");
            }
            if let Some(value) = self.base.get(field) {
                base.insert(field.clone(), value.clone());
            }
        }
        let entities = entity_ids
            .iter()
            .filter_map(|id| self.entity_index.get(id).copied())
            .map(|index| self.parse_entity(index))
            .collect::<anyhow::Result<Vec<_>>>()?;
        let belts = belt_ids
            .iter()
            .filter_map(|id| self.belt_index.get(id).copied())
            .map(|index| self.parse_belt(index))
            .collect::<anyhow::Result<Vec<_>>>()?;
        let value = serde_json::json!({
            "revision": self.revision,
            "base": base,
            "entities": entities,
            "belts": belts,
        });
        if serde_json::to_vec(&value)?.len() > MAX_PROJECTION_BYTES {
            bail!("native core projection exceeds the byte limit");
        }
        Ok(value)
    }

    /// Produces a bounded current-viewport projection without materializing or
    /// transferring the complete factory. Stable cursors paginate dense
    /// regions in persisted entity order; belts are limited to connections
    /// touching the returned node page.
    #[allow(clippy::too_many_arguments)]
    pub fn viewport_projection(
        &self,
        base_fields: &[String],
        planet_id: &str,
        min_x: f64,
        min_y: f64,
        max_x: f64,
        max_y: f64,
        entity_cursor: usize,
        entity_limit: usize,
        belt_limit: usize,
    ) -> anyhow::Result<Value> {
        if base_fields.len() > MAX_PROJECTION_BASE_FIELDS
            || entity_limit == 0
            || entity_limit > MAX_VIEWPORT_PROJECTION_ENTITIES
            || belt_limit > MAX_VIEWPORT_PROJECTION_BELTS
            || entity_cursor > self.entity_raw.len()
            || [min_x, min_y, max_x, max_y]
                .iter()
                .any(|value| !value.is_finite())
            || min_x > max_x
            || min_y > max_y
            || max_x - min_x > 10_000_000.0
            || max_y - min_y > 10_000_000.0
        {
            bail!("native viewport projection bounds are invalid");
        }
        let valid_key = |value: &str| {
            !value.is_empty()
                && value.len() <= 160
                && value.bytes().all(|byte| {
                    byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.' | b':' | b'/')
                })
        };
        if !valid_key(planet_id)
            || base_fields
                .iter()
                .any(|field| !valid_key(field) || matches!(field.as_str(), "entities" | "belts"))
        {
            bail!("native viewport projection selector is invalid");
        }
        let planet_index = self
            .catalog
            .planets
            .iter()
            .position(|planet| planet.id == planet_id)
            .ok_or_else(|| anyhow!("native viewport projection planet is missing"))?;
        let candidates = self
            .factory_topology
            .entities_by_planet
            .get(planet_index)
            .ok_or_else(|| anyhow!("native viewport projection planet index is invalid"))?;
        let matching = candidates.iter().copied().filter(|&index| {
            let x = self.entities.position_x[index];
            let y = self.entities.position_y[index];
            x >= min_x && x <= max_x && y >= min_y && y <= max_y
        });
        let mut selected_indices = matching
            .skip(entity_cursor)
            .take(entity_limit.saturating_add(1))
            .collect::<Vec<_>>();
        let has_more_entities = selected_indices.len() > entity_limit;
        selected_indices.truncate(entity_limit);
        let selected_ids = selected_indices
            .iter()
            .map(|&index| &self.entities.ids[index])
            .collect::<HashSet<_>>();
        let mut selected_belts = self
            .factory_topology
            .belts_by_planet
            .get(planet_index)
            .into_iter()
            .flatten()
            .copied()
            .filter(|&index| {
                let source = self.symbols.resolve(self.belts.sources[index]);
                let target = self.symbols.resolve(self.belts.targets[index]);
                source.is_some_and(|id| selected_ids.contains(id))
                    || target.is_some_and(|id| selected_ids.contains(id))
            })
            .take(belt_limit.saturating_add(1))
            .collect::<Vec<_>>();
        let has_more_belts = selected_belts.len() > belt_limit;
        selected_belts.truncate(belt_limit);

        let mut base = Map::new();
        for field in base_fields {
            if let Some(value) = self.base.get(field) {
                base.insert(field.clone(), value.clone());
            }
        }
        let entities = selected_indices
            .iter()
            .copied()
            .map(|index| self.parse_entity(index))
            .collect::<anyhow::Result<Vec<_>>>()?;
        let belts = selected_belts
            .iter()
            .copied()
            .map(|index| self.parse_belt(index))
            .collect::<anyhow::Result<Vec<_>>>()?;
        let next_entity_cursor = has_more_entities.then_some(entity_cursor + entities.len());
        let value = serde_json::json!({
            "schemaVersion": 1,
            "projectionType": "viewport-v1",
            "revision": self.revision,
            "planetId": planet_id,
            "bounds": { "minX": min_x, "minY": min_y, "maxX": max_x, "maxY": max_y },
            "base": base,
            "entities": entities,
            "belts": belts,
            "nextEntityCursor": next_entity_cursor,
            "truncatedBelts": has_more_belts,
        });
        if serde_json::to_vec(&value)?.len() > MAX_PROJECTION_BYTES {
            bail!("native viewport projection exceeds the byte limit");
        }
        Ok(value)
    }

    /// Second-generation viewport projection with independently pageable
    /// entity and belt streams. Ordinary entities come from the immutable
    /// per-planet spatial grid; ordinary belts come from the immutable
    /// entity-to-belt CSR for every visible entity, never merely the current
    /// entity page. Explicitly pinned IDs are merged after pagination so a
    /// selected off-screen object remains available to the thin renderer.
    #[allow(clippy::too_many_arguments)]
    pub fn viewport_projection_v2(
        &self,
        base_fields: &[String],
        planet_id: &str,
        min_x: f64,
        min_y: f64,
        max_x: f64,
        max_y: f64,
        entity_cursor: usize,
        entity_limit: usize,
        belt_cursor: usize,
        belt_limit: usize,
        pinned_entity_ids: &[String],
        pinned_belt_ids: &[String],
    ) -> anyhow::Result<Value> {
        if base_fields.len() > MAX_PROJECTION_BASE_FIELDS
            || entity_limit == 0
            || entity_limit > MAX_VIEWPORT_PROJECTION_ENTITIES
            || belt_limit == 0
            || belt_limit > MAX_VIEWPORT_PROJECTION_BELTS
            || pinned_entity_ids.len() > MAX_VIEWPORT_PINNED_ENTITIES
            || pinned_belt_ids.len() > MAX_VIEWPORT_PINNED_BELTS
            || entity_cursor > self.entity_raw.len()
            || belt_cursor > self.belt_raw.len()
            || [min_x, min_y, max_x, max_y]
                .iter()
                .any(|value| !value.is_finite())
            || min_x > max_x
            || min_y > max_y
            || max_x - min_x > 10_000_000.0
            || max_y - min_y > 10_000_000.0
        {
            bail!("native viewport v2 bounds or limits are invalid");
        }
        let valid_base_key = |value: &str| {
            !value.is_empty()
                && value.len() <= 160
                && value.bytes().all(|byte| {
                    byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.' | b':' | b'/')
                })
        };
        // Entity, belt and planet IDs are opaque content-pack identifiers.
        // Bound only their encoded size and NUL use; do not impose the core
        // catalog's ASCII spelling on MOD-owned IDs.
        let valid_opaque_id = |value: &str| {
            !value.is_empty()
                && value.len() <= MAX_VIEWPORT_OPAQUE_ID_BYTES
                && !value.contains('\0')
        };
        if !valid_opaque_id(planet_id)
            || base_fields.iter().any(|field| {
                !valid_base_key(field) || matches!(field.as_str(), "entities" | "belts")
            })
            || pinned_entity_ids.iter().any(|id| !valid_opaque_id(id))
            || pinned_belt_ids.iter().any(|id| !valid_opaque_id(id))
        {
            bail!("native viewport v2 selector is invalid");
        }

        let planet_index = self
            .catalog
            .planets
            .iter()
            .position(|planet| planet.id == planet_id)
            .ok_or_else(|| anyhow!("native viewport v2 planet is missing"))?;
        let planet_entities = self
            .factory_topology
            .entities_by_planet
            .get(planet_index)
            .ok_or_else(|| anyhow!("native viewport v2 planet index is invalid"))?;
        let planet_belts = self
            .factory_topology
            .belts_by_planet
            .get(planet_index)
            .ok_or_else(|| anyhow!("native viewport v2 belt planet index is invalid"))?;
        let spatial = self
            .factory_topology
            .planet_viewport_indexes
            .get(planet_index)
            .ok_or_else(|| anyhow!("native viewport v2 spatial index is missing"))?;
        let (visible_entity_indices, broad_query_fallback) =
            spatial.query(planet_entities, &self.entities, min_x, min_y, max_x, max_y);
        if entity_cursor > visible_entity_indices.len() {
            bail!("native viewport v2 entity cursor is invalid");
        }

        let entity_page_end = entity_cursor
            .saturating_add(entity_limit)
            .min(visible_entity_indices.len());
        let mut returned_entity_indices =
            visible_entity_indices[entity_cursor..entity_page_end].to_vec();
        let mut resolved_pinned_entity_indices = pinned_entity_ids
            .iter()
            .filter_map(|id| self.entity_index.get(id).copied())
            .filter(|&index| self.factory_topology.entity_planet_indices[index] == planet_index)
            .collect::<Vec<_>>();
        resolved_pinned_entity_indices.sort_unstable();
        resolved_pinned_entity_indices.dedup();
        returned_entity_indices.extend_from_slice(&resolved_pinned_entity_indices);
        returned_entity_indices.sort_unstable();
        returned_entity_indices.dedup();

        // The ordinary belt stream is derived from every visible node plus
        // any selected off-screen node. It therefore remains identical while
        // entity pages advance through the same viewport.
        let mut belt_source_entities = visible_entity_indices.clone();
        belt_source_entities.extend_from_slice(&resolved_pinned_entity_indices);
        belt_source_entities.sort_unstable();
        belt_source_entities.dedup();
        let mut visible_belt_indices = Vec::new();
        for entity_index in belt_source_entities {
            visible_belt_indices.extend_from_slice(
                self.factory_topology
                    .entity_belt_adjacency
                    .incident(entity_index),
            );
        }
        visible_belt_indices.sort_unstable();
        visible_belt_indices.dedup();
        visible_belt_indices
            .retain(|&index| self.symbols.resolve(self.belts.planets[index]) == Some(planet_id));
        if belt_cursor > visible_belt_indices.len() {
            bail!("native viewport v2 belt cursor is invalid");
        }

        let belt_page_end = belt_cursor
            .saturating_add(belt_limit)
            .min(visible_belt_indices.len());
        let mut returned_belt_indices = visible_belt_indices[belt_cursor..belt_page_end].to_vec();
        let mut resolved_pinned_belt_indices = pinned_belt_ids
            .iter()
            .filter_map(|id| self.belt_index.get(id).copied())
            .filter(|&index| self.symbols.resolve(self.belts.planets[index]) == Some(planet_id))
            .collect::<Vec<_>>();
        resolved_pinned_belt_indices.sort_unstable();
        resolved_pinned_belt_indices.dedup();
        returned_belt_indices.extend_from_slice(&resolved_pinned_belt_indices);
        returned_belt_indices.sort_unstable();
        returned_belt_indices.dedup();

        let mut base = Map::new();
        for field in base_fields {
            if let Some(value) = self.base.get(field) {
                base.insert(field.clone(), value.clone());
            }
        }
        let entities = returned_entity_indices
            .iter()
            .copied()
            .map(|index| self.parse_entity(index))
            .collect::<anyhow::Result<Vec<_>>>()?;
        let belts = returned_belt_indices
            .iter()
            .copied()
            .map(|index| self.parse_belt(index))
            .collect::<anyhow::Result<Vec<_>>>()?;
        let pinned_entity_ids = resolved_pinned_entity_indices
            .iter()
            .map(|&index| self.entities.ids[index].to_owned())
            .collect::<Vec<_>>();
        let pinned_belt_ids = resolved_pinned_belt_indices
            .iter()
            .map(|&index| self.belts.ids[index].to_owned())
            .collect::<Vec<_>>();
        let next_entity_cursor =
            (entity_page_end < visible_entity_indices.len()).then_some(entity_page_end);
        let next_belt_cursor =
            (belt_page_end < visible_belt_indices.len()).then_some(belt_page_end);
        let world_bounds = spatial.world_bounds.as_json();
        let value = serde_json::json!({
            "schemaVersion": 2,
            "projectionType": "viewport-v2",
            "revision": self.revision,
            "planetId": planet_id,
            "bounds": { "minX": min_x, "minY": min_y, "maxX": max_x, "maxY": max_y },
            "base": base,
            "entities": entities,
            "belts": belts,
            "pinnedEntityIds": pinned_entity_ids,
            "pinnedBeltIds": pinned_belt_ids,
            "nextEntityCursor": next_entity_cursor,
            "nextBeltCursor": next_belt_cursor,
            "planetTotals": {
                "entities": planet_entities.len(),
                "belts": planet_belts.len(),
            },
            "viewportTotals": {
                "entities": visible_entity_indices.len(),
                "belts": visible_belt_indices.len(),
            },
            "worldBounds": world_bounds,
            "minimap": {
                "bounds": spatial.world_bounds.as_json(),
                "entityCount": planet_entities.len(),
                "beltCount": planet_belts.len(),
                "occupiedCellCount": spatial.cell_keys.len(),
                "cellSize": VIEWPORT_SPATIAL_CELL_SIZE,
            },
            "broadQueryFallback": broad_query_fallback,
        });
        if serde_json::to_vec(&value)?.len() > MAX_PROJECTION_BYTES {
            bail!("native viewport v2 projection exceeds the byte limit");
        }
        Ok(value)
    }

    /// Returns only the requested window from the already-maintained native
    /// rolling history. This query never reparses or scans entity/belt records,
    /// and filters are applied before the bounded IPC payload is encoded.
    #[allow(clippy::too_many_arguments)]
    pub fn statistics_projection(
        &self,
        min_elapsed_seconds: f64,
        max_elapsed_seconds: f64,
        cursor: usize,
        limit: usize,
        planet_id: Option<&str>,
        item_id: Option<&str>,
    ) -> anyhow::Result<Value> {
        let valid_selector = |value: &str| {
            !value.is_empty()
                && value.len() <= 160
                && value.bytes().all(|byte| {
                    byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.' | b':')
                })
        };
        if !min_elapsed_seconds.is_finite()
            || !max_elapsed_seconds.is_finite()
            || min_elapsed_seconds < 0.0
            || min_elapsed_seconds > max_elapsed_seconds
            || limit == 0
            || limit > MAX_STATISTICS_PROJECTION_SAMPLES
            || planet_id.is_some_and(|value| !valid_selector(value))
            || item_id.is_some_and(|value| !valid_selector(value))
        {
            bail!("native statistics projection selector is invalid");
        }
        if let Some(planet_id) = planet_id
            && !self
                .catalog
                .planets
                .iter()
                .any(|planet| planet.id == planet_id)
        {
            bail!("native statistics projection planet is missing");
        }
        if let Some(item_id) = item_id
            && !self.catalog.items.contains_key(item_id)
        {
            bail!("native statistics projection item is missing");
        }
        let history = self
            .production_history_tiers
            .samples_if_current(&self.base)?;
        let matching = history.iter().filter(|sample| {
            sample
                .get("elapsedSeconds")
                .and_then(Value::as_f64)
                .is_some_and(|elapsed| {
                    elapsed >= min_elapsed_seconds && elapsed <= max_elapsed_seconds
                })
        });
        let mut samples = matching
            .skip(cursor)
            .take(limit.saturating_add(1))
            .cloned()
            .collect::<Vec<_>>();
        let has_more = samples.len() > limit;
        samples.truncate(limit);
        for sample in &mut samples {
            let Some(sample) = sample.as_object_mut() else {
                bail!("native statistics history sample is invalid");
            };
            if let Some(item_id) = item_id {
                for key in ["productionPerMinute", "consumptionPerMinute", "inventory"] {
                    if let Some(value) = sample.get_mut(key) {
                        retain_statistics_item(value, item_id);
                    }
                }
            }
            for key in ["planetProductionPerMinute", "planetConsumptionPerMinute"] {
                if let Some(value) = sample.get_mut(key) {
                    retain_statistics_planet(value, planet_id, item_id);
                }
            }
        }
        let sample_count = samples.len();
        let value = serde_json::json!({
            "schemaVersion": 1,
            "projectionType": "statistics-v1",
            "revision": self.revision,
            "window": { "minElapsedSeconds": min_elapsed_seconds, "maxElapsedSeconds": max_elapsed_seconds },
            "filters": { "planetId": planet_id, "itemId": item_id },
            "samples": samples,
            "nextCursor": has_more.then_some(cursor + sample_count),
        });
        if serde_json::to_vec(&value)?.len() > MAX_PROJECTION_BYTES {
            bail!("native statistics projection exceeds the byte limit");
        }
        Ok(value)
    }

    pub fn canonical_sha256(&self) -> anyhow::Result<String> {
        let mut hasher = Sha256::new();
        hasher.update(b"{");
        let mut keys = self.base.keys().map(String::as_str).collect::<Vec<_>>();
        keys.push("entities");
        keys.push("belts");
        keys.sort_unstable();
        for (position, key) in keys.iter().enumerate() {
            if position > 0 {
                hasher.update(b",");
            }
            hasher.update(serde_json::to_string(key)?.as_bytes());
            hasher.update(b":");
            match *key {
                "entities" => {
                    hasher.update(b"[");
                    for (index, raw) in self.entity_raw.iter().enumerate() {
                        if index > 0 {
                            hasher.update(b",");
                        }
                        update_canonical(&mut hasher, &serde_json::from_str(raw)?);
                    }
                    hasher.update(b"]");
                }
                "belts" => {
                    hasher.update(b"[");
                    for (index, raw) in self.belt_raw.iter().enumerate() {
                        if index > 0 {
                            hasher.update(b",");
                        }
                        update_canonical(&mut hasher, &serde_json::from_str(raw)?);
                    }
                    hasher.update(b"]");
                }
                key => update_canonical(&mut hasher, &self.base[key]),
            }
        }
        hasher.update(b"}");
        Ok(hex::encode(hasher.finalize()))
    }

    pub fn canonical_components(&self) -> anyhow::Result<BTreeMap<String, String>> {
        let hash_records = |records: &[RawRecord]| -> anyhow::Result<String> {
            let mut hasher = Sha256::new();
            hasher.update(b"[");
            for (index, raw) in records.iter().enumerate() {
                if index > 0 {
                    hasher.update(b",");
                }
                update_canonical(&mut hasher, &serde_json::from_str(raw)?);
            }
            hasher.update(b"]");
            Ok(hex::encode(hasher.finalize()))
        };
        Ok(BTreeMap::from([
            (
                "base".to_owned(),
                crate::canonical::canonical_sha256(&Value::Object(self.base.clone())),
            ),
            ("entities".to_owned(), hash_records(&self.entity_raw)?),
            ("belts".to_owned(), hash_records(&self.belt_raw)?),
        ]))
    }

    pub fn canonical_fields(&self) -> anyhow::Result<BTreeMap<String, String>> {
        let mut fields = self
            .base
            .iter()
            .map(|(key, value)| (key.clone(), crate::canonical::canonical_sha256(value)))
            .collect::<BTreeMap<_, _>>();
        let components = self.canonical_components()?;
        fields.insert(
            "entities".to_owned(),
            components
                .get("entities")
                .cloned()
                .ok_or_else(|| anyhow!("native core entity component hash is missing"))?,
        );
        fields.insert(
            "belts".to_owned(),
            components
                .get("belts")
                .cloned()
                .ok_or_else(|| anyhow!("native core belt component hash is missing"))?,
        );
        Ok(fields)
    }

    /// Computes the full-state hash and both collection component hashes in
    /// one parse pass. Previously `summary()` parsed every entity/belt once
    /// for the full hash, twice more through components/fields, and once for
    /// the domain hash. Large 1.1.x saves therefore spent several seconds on
    /// duplicate JSON decoding for every diagnostics request.
    fn canonical_digest_bundle_with_parsed(
        &self,
        parsed_entities: Option<&[Value]>,
        parsed_belts: Option<&[Value]>,
    ) -> anyhow::Result<CanonicalDigestBundle> {
        if parsed_entities.is_some_and(|values| values.len() != self.entity_raw.len())
            || parsed_belts.is_some_and(|values| values.len() != self.belt_raw.len())
        {
            bail!("native canonical parsed record count is inconsistent");
        }
        let mut canonical = Sha256::new();
        let mut entities = Sha256::new();
        let mut belts = Sha256::new();
        let mut domain = self.start_domain_hasher();
        let mut domain_symbols = DomainSymbolOrder::new(&self.symbols);
        let mut belt_domain_columns_match = self.belt_dynamics.progress.len()
            == self.belt_raw.len()
            && self.belt_dynamics.total_transferred.len() == self.belt_raw.len()
            && self.belt_dynamics.last_flow.len() == self.belt_raw.len();
        canonical.update(b"{");
        entities.update(b"[");
        belts.update(b"[");

        let mut keys = self.base.keys().map(String::as_str).collect::<Vec<_>>();
        keys.push("entities");
        keys.push("belts");
        keys.sort_unstable();
        for (position, key) in keys.iter().enumerate() {
            if position > 0 {
                canonical.update(b",");
            }
            canonical.update(serde_json::to_string(key)?.as_bytes());
            canonical.update(b":");
            match *key {
                "entities" => {
                    canonical.update(b"[");
                    for (index, raw) in self.entity_raw.iter().enumerate() {
                        if index > 0 {
                            canonical.update(b",");
                            entities.update(b",");
                        }
                        let decoded;
                        let value = if let Some(values) = parsed_entities {
                            &values[index]
                        } else {
                            decoded = serde_json::from_str(raw)
                                .context("decode native canonical entity")?;
                            &decoded
                        };
                        update_canonical(&mut canonical, value);
                        update_canonical(&mut entities, value);
                        self.update_domain_entity(&mut domain, &mut domain_symbols, index, value)?;
                    }
                    canonical.update(b"]");
                }
                "belts" => {
                    canonical.update(b"[");
                    for (index, raw) in self.belt_raw.iter().enumerate() {
                        if index > 0 {
                            canonical.update(b",");
                            belts.update(b",");
                        }
                        let decoded;
                        let value = if let Some(values) = parsed_belts {
                            &values[index]
                        } else {
                            decoded = serde_json::from_str(raw)
                                .context("decode native canonical belt")?;
                            &decoded
                        };
                        update_canonical(&mut canonical, value);
                        update_canonical(&mut belts, value);
                        let belt = value
                            .as_object()
                            .ok_or_else(|| anyhow!("native domain belt is not an object"))?;
                        if belt_domain_columns_match {
                            belt_domain_columns_match &= object_number(belt, "progress").to_bits()
                                == self.belt_dynamics.progress[index].to_bits()
                                && object_number(belt, "totalTransferred").to_bits()
                                    == self.belt_dynamics.total_transferred[index].to_bits()
                                && object_number(belt, "lastFlow").to_bits()
                                    == self.belt_dynamics.last_flow[index].to_bits();
                        }
                    }
                    canonical.update(b"]");
                }
                key => update_canonical(&mut canonical, &self.base[key]),
            }
        }
        canonical.update(b"}");
        entities.update(b"]");
        belts.update(b"]");
        if self.belt_raw.len() != self.belts.ids.len() {
            bail!("native domain belt metric count is inconsistent");
        }
        // Belt rows and their compact dynamics are installed transactionally
        // by load, commands and simulation commits. Stream those authoritative
        // columns only after every entity so the historical domain byte order
        // remains entities-then-belts without retaining a Vec<[f64; 3]> for
        // the entire belt table. If a caller supplies a same-length parsed
        // view with different metrics, or an internal invariant is damaged,
        // fall back to the historical one-row-at-a-time source semantics.
        if belt_domain_columns_match {
            for index in 0..self.belt_raw.len() {
                self.update_domain_belt_metrics(
                    &mut domain,
                    index,
                    [
                        self.belt_dynamics.progress[index],
                        self.belt_dynamics.total_transferred[index],
                        self.belt_dynamics.last_flow[index],
                    ],
                );
            }
        } else {
            for (index, raw) in self.belt_raw.iter().enumerate() {
                let decoded;
                let value = if let Some(values) = parsed_belts {
                    &values[index]
                } else {
                    decoded = serde_json::from_str(raw).context("decode native domain belt")?;
                    &decoded
                };
                let belt = value
                    .as_object()
                    .ok_or_else(|| anyhow!("native domain belt is not an object"))?;
                self.update_domain_belt_metrics(
                    &mut domain,
                    index,
                    [
                        object_number(belt, "progress"),
                        object_number(belt, "totalTransferred"),
                        object_number(belt, "lastFlow"),
                    ],
                );
            }
        }

        let mut base = Sha256::new();
        update_canonical_object(&mut base, &self.base);
        let entity_sha256 = hex::encode(entities.finalize());
        let belt_sha256 = hex::encode(belts.finalize());
        let canonical_components = BTreeMap::from([
            ("base".to_owned(), hex::encode(base.finalize())),
            ("entities".to_owned(), entity_sha256.clone()),
            ("belts".to_owned(), belt_sha256.clone()),
        ]);
        let mut canonical_fields = self
            .base
            .iter()
            .map(|(key, value)| (key.clone(), crate::canonical::canonical_sha256(value)))
            .collect::<BTreeMap<_, _>>();
        canonical_fields.insert("entities".to_owned(), entity_sha256);
        canonical_fields.insert("belts".to_owned(), belt_sha256);
        Ok(CanonicalDigestBundle {
            canonical_sha256: hex::encode(canonical.finalize()),
            canonical_components,
            canonical_fields,
            domain_sha256: hex::encode(domain.finalize()),
        })
    }

    fn canonical_digest_bundle(&self) -> anyhow::Result<CanonicalDigestBundle> {
        self.canonical_digest_bundle_with_parsed(None, None)
    }

    fn start_domain_hasher(&self) -> Sha256 {
        let mut hasher = Sha256::new();
        hasher.update(b"dsp-native-domain-v1\0");
        hasher.update(self.revision.to_le_bytes());
        for key in [
            "version",
            "mode",
            "activePlanetId",
            "elapsedSeconds",
            "paused",
        ] {
            if let Some(value) = self.base.get(key) {
                update_canonical(&mut hasher, value);
            }
            hasher.update(b"\0");
        }
        hasher
    }

    fn update_domain_entity(
        &self,
        hasher: &mut Sha256,
        symbols: &mut DomainSymbolOrder<'_>,
        index: usize,
        value: &Value,
    ) -> anyhow::Result<()> {
        let entity = value
            .as_object()
            .ok_or_else(|| anyhow!("native domain entity is not an object"))?;
        hasher.update(self.entities.ids[index].as_bytes());
        hasher.update(b"\0");
        for entry in parse_domain_inventory(entity.get("inputs"), symbols) {
            hasher.update(entry.item.as_bytes());
            hasher.update(entry.amount.to_bits().to_le_bytes());
        }
        hasher.update(b"|");
        for entry in parse_domain_inventory(entity.get("outputs"), symbols) {
            hasher.update(entry.item.as_bytes());
            hasher.update(entry.amount.to_bits().to_le_bytes());
        }
        hasher.update(object_number(entity, "progress").to_bits().to_le_bytes());
        hasher.update(object_number(entity, "utilization").to_bits().to_le_bytes());
        hasher.update(
            object_number(entity, "productionRate")
                .to_bits()
                .to_le_bytes(),
        );
        Ok(())
    }

    fn update_domain_belt_metrics(&self, hasher: &mut Sha256, index: usize, metrics: [f64; 3]) {
        hasher.update(self.belts.ids[index].as_bytes());
        for value in metrics {
            hasher.update(value.to_bits().to_le_bytes());
        }
    }

    pub fn domain_sha256(&self) -> anyhow::Result<String> {
        let mut hasher = Sha256::new();
        hasher.update(b"dsp-native-domain-v1\0");
        hasher.update(self.revision.to_le_bytes());
        for key in [
            "version",
            "mode",
            "activePlanetId",
            "elapsedSeconds",
            "paused",
        ] {
            if let Some(value) = self.base.get(key) {
                update_canonical(&mut hasher, value);
            }
            hasher.update(b"\0");
        }
        let mut symbols = DomainSymbolOrder::new(&self.symbols);
        for (index, raw) in self.entity_raw.iter().enumerate() {
            let value: Value = serde_json::from_str(raw).context("decode native domain entity")?;
            self.update_domain_entity(&mut hasher, &mut symbols, index, &value)?;
        }
        for (index, raw) in self.belt_raw.iter().enumerate() {
            let value: Value = serde_json::from_str(raw).context("decode native domain belt")?;
            let belt = value
                .as_object()
                .ok_or_else(|| anyhow!("native domain belt is not an object"))?;
            hasher.update(self.belts.ids[index].as_bytes());
            hasher.update(object_number(belt, "progress").to_bits().to_le_bytes());
            hasher.update(
                object_number(belt, "totalTransferred")
                    .to_bits()
                    .to_le_bytes(),
            );
            hasher.update(object_number(belt, "lastFlow").to_bits().to_le_bytes());
        }
        Ok(hex::encode(hasher.finalize()))
    }

    pub fn memory_estimate(&self) -> RuntimeMemoryEstimate {
        let raw_entity_bytes = self
            .entity_raw
            .iter()
            .map(|value| value.len() as u64)
            .sum::<u64>();
        let raw_belt_bytes = self
            .belt_raw
            .iter()
            .map(|value| value.len() as u64)
            .sum::<u64>();
        let raw_record_bytes = raw_entity_bytes.saturating_add(raw_belt_bytes);
        // Raw records remain authoritative. E1 values are decoded one row at
        // a time, and full writeback encoding keeps no per-row proof or target
        // mirror. Inventory cardinality is diagnostic rather than allocating
        // a second resident JSON/CSR graph.
        let inventory_entry_count = self.entity_dynamics.inventory_entry_count() as u64;
        let indexed_string_bytes = self.symbols.estimated_bytes()
            + self.entities.ids.text_bytes() as u64
            + self.belts.ids.text_bytes() as u64;
        let entity_rows = self.entities.ids.len() as u64;
        let belt_rows = self.belts.ids.len() as u64;
        // The pre-1.2.3 estimate accounted for IDs, interned symbols and
        // machine/miner counts as 56 bytes per entity row. Position x/y add
        // two more f64 columns. Keep this estimate in lockstep with
        // `EntityColumns` so the native memory budget does not under-report
        // the viewport indexes.
        let numeric_columns = entity_rows * 72 + belt_rows * 72;
        let index_overhead =
            self.entity_index.estimated_bytes() + self.belt_index.estimated_bytes();
        let topology_index_bytes = self
            .prepared_belt_routes
            .as_ref()
            .map(|routes| routes.estimated_bytes())
            .unwrap_or(0)
            + self
                .prepared_local_peer_directory
                .as_ref()
                .map(|directory| directory.estimated_bytes())
                .unwrap_or(0)
            + self
                .prepared_interstellar_route_activity
                .as_ref()
                .map(|activity| activity.estimated_bytes())
                .unwrap_or(0)
            + self.factory_topology.estimated_bytes();
        let belt_activity_runtime_bytes = self
            .prepared_belt_activity
            .as_ref()
            .map(|activity| activity.estimated_bytes())
            .unwrap_or(0);
        let parsed_entity_runtime_bytes =
            self.parsed_entity_runtime.estimated_bytes(raw_entity_bytes);
        let estimated_runtime_bytes = raw_record_bytes
            + indexed_string_bytes
            + numeric_columns
            + self.entity_dynamics.estimated_bytes()
            + self.belt_dynamics.estimated_bytes()
            + index_overhead
            + topology_index_bytes
            + belt_activity_runtime_bytes
            + parsed_entity_runtime_bytes
            + serde_json::to_vec(&self.base)
                .map(|bytes| bytes.len() as u64)
                .unwrap_or(0);
        RuntimeMemoryEstimate {
            raw_record_bytes,
            indexed_string_bytes,
            inventory_entry_count,
            topology_index_bytes,
            estimated_runtime_bytes,
        }
    }

    fn summary_from_digest(&self, canonical: CanonicalDigestBundle) -> CoreStateSummary {
        CoreStateSummary {
            revision: self.revision,
            state_version: self
                .base
                .get("version")
                .and_then(Value::as_u64)
                .unwrap_or(0) as u16,
            mode: self
                .base
                .get("mode")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            active_planet_id: self
                .base
                .get("activePlanetId")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            elapsed_seconds: self
                .base
                .get("elapsedSeconds")
                .and_then(Value::as_f64)
                .unwrap_or(0.0),
            paused: self
                .base
                .get("paused")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            entity_count: self.entity_raw.len(),
            belt_count: self.belt_raw.len(),
            canonical_sha256: canonical.canonical_sha256,
            canonical_components: canonical.canonical_components,
            canonical_fields: canonical.canonical_fields,
            domain_sha256: canonical.domain_sha256,
            catalog_sha256: self.catalog.fingerprint.clone(),
            registry_fingerprint: self.identity.registry_fingerprint.clone(),
            memory: self.memory_estimate(),
            coverage: self.coverage.clone(),
        }
    }

    pub fn summary(&self) -> anyhow::Result<CoreStateSummary> {
        if let Some(summary) = self
            .summary_cache
            .borrow()
            .as_ref()
            .filter(|(revision, _)| *revision == self.revision)
            .map(|(_, summary)| summary.clone())
        {
            return Ok(summary);
        }
        let canonical = self.canonical_digest_bundle()?;
        let summary = self.summary_from_digest(canonical);
        self.summary_cache
            .replace(Some((self.revision, summary.clone())));
        Ok(summary)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::{
        BeltDefinition, BuildingDefinition, CatalogSnapshot, ItemDefinition, PlanetDefinition,
        RuntimeCatalog,
    };
    use crate::command::{
        AddedRecord, PathSegment, RecordPatch, SimulationCommandPatch, ValuePatch,
    };
    use serde_json::json;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[test]
    fn joined_record_drop_finishes_every_destructor_before_return() {
        struct DropCounter(Arc<AtomicUsize>);

        impl Drop for DropCounter {
            fn drop(&mut self) {
                self.0.fetch_add(1, Ordering::SeqCst);
            }
        }

        let dropped = Arc::new(AtomicUsize::new(0));
        let records = (0..4_096)
            .map(|_| DropCounter(Arc::clone(&dropped)))
            .collect::<Vec<_>>();
        deterministic_runtime().drop_owned_joined(records, Vec::new());
        assert_eq!(dropped.load(Ordering::SeqCst), 4_096);
    }

    #[test]
    fn synchronous_record_drop_is_only_enabled_by_exact_one() {
        assert!(resolve_sync_record_drop(Some("1")));
        for value in [
            None,
            Some(""),
            Some("0"),
            Some("true"),
            Some(" 1 "),
            Some("2"),
        ] {
            assert!(!resolve_sync_record_drop(value));
        }
    }

    #[test]
    fn exact_row_id_index_proves_forced_collisions_with_full_strings() {
        let index = ExactRowIdIndex::from_boxed_with_hash_mask(
            ["alpha", "beta", "gamma", "delta"]
                .into_iter()
                .map(Box::<str>::from)
                .collect(),
            "test",
            0,
        )
        .unwrap();

        assert_eq!(index.len(), 4);
        assert_eq!(index.get("alpha"), Some(&0));
        assert_eq!(index.get("beta"), Some(&1));
        assert_eq!(index.get("gamma"), Some(&2));
        assert_eq!(index.get("delta"), Some(&3));
        assert_eq!(index.get("not-present"), None);
        assert!(!index.contains_key(""));
        assert_eq!(index.buckets.iter().filter(|&&row| row != 0).count(), 4);
    }

    #[test]
    fn exact_row_id_index_rejects_empty_duplicate_and_capacity_overflow() {
        let empty = ExactRowIdIndex::from_boxed(vec![Box::<str>::from("")], "entity").unwrap_err();
        assert!(empty.to_string().contains("ID is empty"));

        let duplicate = ExactRowIdIndex::from_boxed_with_hash_mask(
            vec![Box::<str>::from("same"), Box::<str>::from("same")],
            "belt",
            0,
        )
        .unwrap_err();
        assert!(duplicate.to_string().contains("ID is duplicated: same"));

        let adversarial_collision = ExactRowIdIndex::from_boxed_with_hash_mask(
            (0..=EXACT_ROW_ID_MAX_PROBE_DISTANCE + 1)
                .map(|row| format!("collision-{row}").into_boxed_str())
                .collect(),
            "entity",
            0,
        )
        .unwrap_err();
        assert!(
            adversarial_collision
                .to_string()
                .contains("probe limit exceeded")
        );

        let overflow = ExactRowIdIndex::bucket_capacity_for_len(MAX_BELT_COUNT + 1).unwrap_err();
        assert!(overflow.to_string().contains("capacity overflow"));
    }

    #[test]
    fn exact_row_id_index_matches_random_hashmap_oracle_and_rebuilds() {
        let mut seed = 0x4d59_5df4_d0f3_3173_u64;
        let ids = (0..4_096)
            .map(|row| {
                seed = seed
                    .wrapping_mul(6_364_136_223_846_793_005)
                    .wrapping_add(1_442_695_040_888_963_407);
                format!("row-{row:04x}-{seed:016x}").into_boxed_str()
            })
            .collect::<Vec<_>>();
        let oracle = ids
            .iter()
            .enumerate()
            .map(|(row, id)| (id.to_string(), row))
            .collect::<HashMap<_, _>>();
        let index = ExactRowIdIndex::from_boxed(ids.clone(), "test").unwrap();

        for (id, expected) in &oracle {
            assert_eq!(index.get(id).copied(), Some(*expected));
        }
        for row in 0..4_096 {
            assert_eq!(index.get(&format!("missing-{row:04x}")), None);
        }

        let rebuilt_ids = ids.into_iter().rev().collect::<Vec<_>>();
        let rebuilt = ExactRowIdIndex::from_boxed(rebuilt_ids.clone(), "test").unwrap();
        for (row, id) in rebuilt_ids.iter().enumerate() {
            assert_eq!(rebuilt.get(id).copied(), Some(row));
        }
        assert!(Arc::ptr_eq(&rebuilt.ids.0, &rebuilt.ids().0));
    }

    #[test]
    fn exact_row_id_index_has_bounded_load_and_expected_memory_cost() {
        assert_eq!(size_of::<ExactRowIdEntry>(), size_of::<Box<str>>());
        assert_eq!(
            ExactRowIdIndex::bucket_capacity_for_len(80_674).unwrap(),
            131_072
        );
        assert_eq!(
            ExactRowIdIndex::bucket_capacity_for_len(155_746).unwrap(),
            262_144
        );
        assert_eq!((131_072_u64 + 262_144) * size_of::<u32>() as u64, 1_572_864);

        let index = ExactRowIdIndex::from_boxed(
            ["a", "bb", "ccc"]
                .into_iter()
                .map(Box::<str>::from)
                .collect(),
            "test",
        )
        .unwrap();
        assert_eq!(index.buckets.len(), 4);
        assert_eq!(index.estimated_bytes(), 16);
        assert_eq!(index.ids.text_bytes(), 6);
    }

    fn fixture_catalog() -> RuntimeCatalog {
        RuntimeCatalog::validate(
            CatalogSnapshot {
                protocol_version: 1,
                registry_fingerprint: "core".into(),
                planets: vec![PlanetDefinition {
                    id: "home".into(),
                    name: "家园".into(),
                    system_id: "helios".into(),
                    kind: "terrestrial".into(),
                    orbit_index: 1,
                    simulation_order: 0,
                    orbital_yields: HashMap::new(),
                }],
                items: vec![ItemDefinition {
                    id: "iron_ore".into(),
                    name: "iron_ore".into(),
                    kind: "solid".into(),
                    fuel_energy_mj: 0.0,
                }],
                buildings: vec![BuildingDefinition {
                    id: "mining_machine".into(),
                    kind: "miner".into(),
                    speed: 1.0,
                    input_capacity: 0.0,
                    output_capacity: 50.0,
                    power_demand_kw: 1.0,
                    power_generation_kw: 0.0,
                    power_charge_kw: 0.0,
                    energy_capacity_mj: 0.0,
                    fuel_item_ids: Vec::new(),
                    fuel_efficiency: 1.0,
                    family: None,
                    accepts: None,
                }],
                recipes: vec![],
                constructions: vec![],
                belts: vec![BeltDefinition {
                    tier: 1,
                    speed: 6.0,
                }],
                proliferators: vec![],
                technologies: vec![],
            },
            "core",
        )
        .unwrap()
    }

    fn fixture_records() -> BTreeMap<String, Vec<u8>> {
        let base = serde_json::to_vec(&json!({"version":47,"mode":"normal","activePlanetId":"home","elapsedSeconds":0,"paused":false})).unwrap();
        let entities = serde_json::to_vec(&json!([{"id":"vein","kind":"vein","planetId":"home","resourceId":"iron_ore","minerCount":2,"inputs":{},"outputs":{"iron_ore":3},"progress":0,"utilization":0,"productionRate":0,"routingCursor":0}])).unwrap();
        let belts = serde_json::to_vec(&json!([{"id":"belt","planetId":"home","source":"vein","target":"sink","itemId":"iron_ore","lanes":1,"tier":1,"priority":1,"progress":0,"lastFlow":0}])).unwrap();
        let chunks = [
            ("base", "base", &base, 0, 1),
            ("entities:00000000", "entities", &entities, 0, 1),
            ("belts:00000000", "belts", &belts, 0, 1),
        ].into_iter().map(|(id, kind, bytes, offset, count)| json!({"id":id,"kind":kind,"offset":offset,"count":count,"checksum":fnv1a_utf8(bytes),"bytes":bytes.len()})).collect::<Vec<_>>();
        let manifest = serde_json::to_vec(&json!({
            "formatVersion":1,"envelopeFormatVersion":2,"mode":"normal","slot":"main","stateVersion":47,"savedAt":1,
            "basePrimaryChecksum":"12345678","chunkRootChecksum":"12345678","totalBytes":base.len()+entities.len()+belts.len(),
            "entityCount":1,"beltCount":1,"chunks":chunks
        })).unwrap();
        BTreeMap::from([
            (
                "dsp-idle-network.internal.v1.chunked.v1.normal.manifest".into(),
                manifest,
            ),
            (
                "dsp-idle-network.internal.v1.chunked.v1.normal.chunk.base".into(),
                base,
            ),
            (
                "dsp-idle-network.internal.v1.chunked.v1.normal.chunk.entities%3A00000000".into(),
                entities,
            ),
            (
                "dsp-idle-network.internal.v1.chunked.v1.normal.chunk.belts%3A00000000".into(),
                belts,
            ),
        ])
    }

    fn apply_checkpoint_delta(
        records: &mut BTreeMap<String, Vec<u8>>,
        visit: &InternalCheckpointVisitResult,
        delta: BTreeMap<String, Vec<u8>>,
    ) {
        let active_keys = visit.active_keys.iter().cloned().collect::<HashSet<_>>();
        records.retain(|key, _| active_keys.contains(key));
        records.extend(delta);
    }

    fn replace_fixture_entity_chunk(
        records: &mut BTreeMap<String, Vec<u8>>,
        bytes: Vec<u8>,
        count: usize,
    ) {
        let chunk_key = "dsp-idle-network.internal.v1.chunked.v1.normal.chunk.entities%3A00000000";
        let manifest_key = "dsp-idle-network.internal.v1.chunked.v1.normal.manifest";
        records.insert(chunk_key.into(), bytes.clone());
        let mut manifest: Value = serde_json::from_slice(&records[manifest_key]).unwrap();
        manifest["entityCount"] = json!(count);
        let entity_chunk = manifest["chunks"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|chunk| chunk["kind"] == "entities")
            .unwrap();
        entity_chunk["count"] = json!(count);
        entity_chunk["checksum"] = json!(fnv1a_utf8(&bytes));
        entity_chunk["bytes"] = json!(bytes.len());
        records.insert(manifest_key.into(), serde_json::to_vec(&manifest).unwrap());
    }

    fn fixture_records_with_entity_json(
        raw_array: &str,
        count: usize,
    ) -> BTreeMap<String, Vec<u8>> {
        let mut records = fixture_records();
        replace_fixture_entity_chunk(&mut records, raw_array.as_bytes().to_vec(), count);
        records
    }

    fn fixture_records_with_belts(belts: Vec<Value>) -> BTreeMap<String, Vec<u8>> {
        let mut records = fixture_records();
        let bytes = serde_json::to_vec(&belts).unwrap();
        replace_fixture_belt_chunk(&mut records, bytes, belts.len());
        records
    }

    fn replace_fixture_belt_chunk(
        records: &mut BTreeMap<String, Vec<u8>>,
        bytes: Vec<u8>,
        count: usize,
    ) {
        let chunk_key = "dsp-idle-network.internal.v1.chunked.v1.normal.chunk.belts%3A00000000";
        let manifest_key = "dsp-idle-network.internal.v1.chunked.v1.normal.manifest";
        records.insert(chunk_key.into(), bytes.clone());
        let mut manifest: Value = serde_json::from_slice(&records[manifest_key]).unwrap();
        manifest["beltCount"] = json!(count);
        let belt_chunk = manifest["chunks"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|chunk| chunk["kind"] == "belts")
            .unwrap();
        belt_chunk["count"] = json!(count);
        belt_chunk["checksum"] = json!(fnv1a_utf8(&bytes));
        belt_chunk["bytes"] = json!(bytes.len());
        records.insert(manifest_key.into(), serde_json::to_vec(&manifest).unwrap());
    }

    fn fixture_records_with_raw_entities_and_belts(
        entities: &str,
        entity_count: usize,
        belts: &str,
        belt_count: usize,
    ) -> BTreeMap<String, Vec<u8>> {
        let mut records = fixture_records();
        replace_fixture_entity_chunk(&mut records, entities.as_bytes().to_vec(), entity_count);
        replace_fixture_belt_chunk(&mut records, belts.as_bytes().to_vec(), belt_count);
        records
    }

    fn legacy_parse_inventory(value: Option<&Value>, symbols: &mut Symbols) -> Vec<(u32, f64)> {
        let Some(object) = value.and_then(Value::as_object) else {
            return Vec::new();
        };
        let mut values = object
            .iter()
            .filter_map(|(item, amount)| {
                let amount = amount.as_f64()?;
                amount
                    .is_finite()
                    .then(|| (symbols.intern(Some(item)), amount))
            })
            .collect::<Vec<_>>();
        values.sort_by_key(|entry| entry.0);
        values
    }

    /// Frozen pre-E14 oracle. Keep this deliberately independent from the new
    /// sparse ordering helper so a shared implementation cannot mask drift.
    fn legacy_domain_sha256(state: &CoreState) -> anyhow::Result<String> {
        let mut hasher = Sha256::new();
        hasher.update(b"dsp-native-domain-v1\0");
        hasher.update(state.revision.to_le_bytes());
        for key in [
            "version",
            "mode",
            "activePlanetId",
            "elapsedSeconds",
            "paused",
        ] {
            if let Some(value) = state.base.get(key) {
                update_canonical(&mut hasher, value);
            }
            hasher.update(b"\0");
        }
        let mut symbols = state.symbols.0.as_ref().clone();
        for (index, raw) in state.entity_raw.iter().enumerate() {
            let value: Value = serde_json::from_str(raw).context("decode legacy oracle entity")?;
            let entity = value
                .as_object()
                .ok_or_else(|| anyhow!("native domain entity is not an object"))?;
            hasher.update(state.entities.ids[index].as_bytes());
            hasher.update(b"\0");
            for (item, amount) in legacy_parse_inventory(entity.get("inputs"), &mut symbols) {
                if let Some(item) = state.symbols.resolve(item) {
                    hasher.update(item.as_bytes());
                } else if let Some(item) = symbols.resolve(item) {
                    hasher.update(item.as_bytes());
                }
                hasher.update(amount.to_bits().to_le_bytes());
            }
            hasher.update(b"|");
            for (item, amount) in legacy_parse_inventory(entity.get("outputs"), &mut symbols) {
                if let Some(item) = state.symbols.resolve(item) {
                    hasher.update(item.as_bytes());
                } else if let Some(item) = symbols.resolve(item) {
                    hasher.update(item.as_bytes());
                }
                hasher.update(amount.to_bits().to_le_bytes());
            }
            hasher.update(object_number(entity, "progress").to_bits().to_le_bytes());
            hasher.update(object_number(entity, "utilization").to_bits().to_le_bytes());
            hasher.update(
                object_number(entity, "productionRate")
                    .to_bits()
                    .to_le_bytes(),
            );
        }
        for (index, raw) in state.belt_raw.iter().enumerate() {
            let value: Value = serde_json::from_str(raw).context("decode legacy oracle belt")?;
            let belt = value
                .as_object()
                .ok_or_else(|| anyhow!("native domain belt is not an object"))?;
            hasher.update(state.belts.ids[index].as_bytes());
            hasher.update(object_number(belt, "progress").to_bits().to_le_bytes());
            hasher.update(
                object_number(belt, "totalTransferred")
                    .to_bits()
                    .to_le_bytes(),
            );
            hasher.update(object_number(belt, "lastFlow").to_bits().to_le_bytes());
        }
        Ok(hex::encode(hasher.finalize()))
    }

    fn fixture_identity(revision: u64) -> CoreCheckpointIdentity {
        CoreCheckpointIdentity {
            slot: "normal-main".into(),
            generation: 1,
            root_hash: "a".repeat(64),
            revision,
            state_version: 47,
            mode: "normal".into(),
            registry_fingerprint: "core".into(),
            base_primary_checksum: "12345678".into(),
        }
    }

    fn belt_commit_for_test(state: &CoreState) -> crate::belts::BeltCommitBatch {
        crate::belts::BeltCommitBatch::unchanged_for_test(state)
    }

    #[test]
    fn owned_internal_records_load_legacy_v1_checkpoint_without_sha256() {
        let records = fixture_records();
        let manifest: Value = serde_json::from_slice(
            &records["dsp-idle-network.internal.v1.chunked.v1.normal.manifest"],
        )
        .unwrap();
        assert!(
            manifest["chunks"]
                .as_array()
                .unwrap()
                .iter()
                .all(|chunk| chunk.get("sha256").is_none())
        );
        let state =
            CoreState::from_owned_internal_records(fixture_identity(7), records, fixture_catalog())
                .unwrap();

        assert_eq!(state.revision, 7);
        assert_eq!(state.entity_raw.len(), 1);
        assert_eq!(state.belt_raw.len(), 1);
        let summary = state.summary().unwrap();
        assert_eq!(summary.state_version, 47);
        assert_eq!(summary.canonical_sha256, state.canonical_sha256().unwrap());
    }

    #[test]
    fn owned_internal_records_reject_v2_chunk_without_sha256() {
        let state = CoreState::from_owned_internal_records(
            fixture_identity(7),
            fixture_records(),
            fixture_catalog(),
        )
        .unwrap();
        let manifest_key = "dsp-idle-network.internal.v1.chunked.v1.normal.manifest";
        let mut records = BTreeMap::<String, Vec<u8>>::new();
        state
            .visit_internal_checkpoint_records(42, |key, value| {
                records.insert(key.to_owned(), value.as_bytes().to_vec());
                Ok(())
            })
            .unwrap();
        let manifest: Value = serde_json::from_slice(&records[manifest_key]).unwrap();

        for index in 0..manifest["chunks"].as_array().unwrap().len() {
            let mut candidate_records = records.clone();
            let mut candidate_manifest = manifest.clone();
            let chunk = candidate_manifest["chunks"][index].as_object_mut().unwrap();
            let id = chunk["id"].as_str().unwrap().to_owned();
            assert!(chunk.remove("sha256").is_some());
            candidate_records.insert(
                manifest_key.to_owned(),
                serde_json::to_vec(&candidate_manifest).unwrap(),
            );

            let error = CoreState::from_owned_internal_records(
                fixture_identity(7),
                candidate_records,
                fixture_catalog(),
            )
            .unwrap_err();
            assert_eq!(
                error.to_string(),
                format!("native core v2 checkpoint chunk requires sha256: {id}")
            );
        }
    }

    #[test]
    fn owned_internal_records_reject_missing_chunk() {
        let mut records = fixture_records();
        records.remove("dsp-idle-network.internal.v1.chunked.v1.normal.chunk.entities%3A00000000");

        let error =
            CoreState::from_owned_internal_records(fixture_identity(7), records, fixture_catalog())
                .unwrap_err();
        assert!(
            error
                .to_string()
                .contains("checkpoint chunk is missing: entities:00000000")
        );
    }

    #[test]
    fn owned_internal_records_reject_chunk_hash_mismatch() {
        let mut records = fixture_records();
        records
            .get_mut("dsp-idle-network.internal.v1.chunked.v1.normal.chunk.entities%3A00000000")
            .unwrap()
            .push(b' ');

        let error =
            CoreState::from_owned_internal_records(fixture_identity(7), records, fixture_catalog())
                .unwrap_err();
        assert!(
            error
                .to_string()
                .contains("checkpoint chunk checksum is invalid: entities:00000000")
        );
    }

    #[test]
    fn owned_internal_records_preserve_duplicate_chunk_topology_error() {
        let mut records = fixture_records();
        let manifest_key = "dsp-idle-network.internal.v1.chunked.v1.normal.manifest";
        let mut manifest: Value = serde_json::from_slice(&records[manifest_key]).unwrap();
        let duplicate = manifest["chunks"][1].clone();
        manifest["chunks"].as_array_mut().unwrap().push(duplicate);
        records.insert(manifest_key.into(), serde_json::to_vec(&manifest).unwrap());

        let error =
            CoreState::from_owned_internal_records(fixture_identity(7), records, fixture_catalog())
                .unwrap_err();
        assert!(
            error
                .to_string()
                .contains("checkpoint record topology is invalid")
        );
        assert!(!error.to_string().contains("chunk is missing"));
    }

    #[test]
    fn owned_internal_records_preserve_zero_count_duplicate_chunk_compatibility() {
        let mut records = fixture_records_with_belts(Vec::new());
        let manifest_key = "dsp-idle-network.internal.v1.chunked.v1.normal.manifest";
        let mut manifest: Value = serde_json::from_slice(&records[manifest_key]).unwrap();
        let duplicate = manifest["chunks"]
            .as_array()
            .unwrap()
            .iter()
            .find(|chunk| chunk["kind"] == "belts")
            .unwrap()
            .clone();
        manifest["chunks"].as_array_mut().unwrap().push(duplicate);
        records.insert(manifest_key.into(), serde_json::to_vec(&manifest).unwrap());

        let state =
            CoreState::from_owned_internal_records(fixture_identity(7), records, fixture_catalog())
                .unwrap();
        assert!(state.belt_raw.is_empty());
    }

    #[test]
    fn owned_internal_records_reject_incomplete_ranges() {
        let mut records = fixture_records();
        let manifest_key = "dsp-idle-network.internal.v1.chunked.v1.normal.manifest";
        let mut manifest: Value = serde_json::from_slice(&records[manifest_key]).unwrap();
        manifest["entityCount"] = json!(2);
        records.insert(manifest_key.into(), serde_json::to_vec(&manifest).unwrap());

        let error =
            CoreState::from_owned_internal_records(fixture_identity(7), records, fixture_catalog())
                .unwrap_err();
        assert!(
            error
                .to_string()
                .contains("checkpoint record ranges are incomplete")
        );
    }

    #[test]
    fn owned_internal_records_preserve_out_of_range_error() {
        let mut records = fixture_records();
        let manifest_key = "dsp-idle-network.internal.v1.chunked.v1.normal.manifest";
        let mut manifest: Value = serde_json::from_slice(&records[manifest_key]).unwrap();
        manifest["chunks"][1]["offset"] = json!(1);
        records.insert(manifest_key.into(), serde_json::to_vec(&manifest).unwrap());

        let error =
            CoreState::from_owned_internal_records(fixture_identity(7), records, fixture_catalog())
                .unwrap_err();
        assert!(
            error
                .to_string()
                .contains("checkpoint chunk range is invalid")
        );
    }

    #[test]
    fn owned_internal_records_reject_unreferenced_record() {
        let mut records = fixture_records();
        records.insert(
            "dsp-idle-network.internal.v1.chunked.v1.normal.chunk.unreferenced".into(),
            b"[]".to_vec(),
        );

        let error =
            CoreState::from_owned_internal_records(fixture_identity(7), records, fixture_catalog())
                .unwrap_err();
        assert!(error.to_string().contains("contains unreferenced records"));
    }

    #[test]
    fn loads_exact_chunked_v47_state_into_indexed_columns() {
        let mut state = CoreState::from_internal_records(
            CoreCheckpointIdentity {
                slot: "normal-main".into(),
                generation: 1,
                root_hash: "a".repeat(64),
                revision: 7,
                state_version: 47,
                mode: "normal".into(),
                registry_fingerprint: "core".into(),
                base_primary_checksum: "12345678".into(),
            },
            &fixture_records(),
            fixture_catalog(),
        )
        .unwrap();
        let summary = state.summary().unwrap();
        assert_eq!(summary.revision, 7);
        assert_eq!(summary.entity_count, 1);
        assert_eq!(summary.belt_count, 1);
        assert!(summary.coverage.state_container);
        assert!(!summary.coverage.authority_eligible);
        let parsed_entities = state.parse_entities_parallel().unwrap();
        let parsed_belts = state.parse_belts_parallel().unwrap();
        let fully_parsed = state
            .canonical_digest_bundle_with_parsed(Some(&parsed_entities), Some(&parsed_belts))
            .unwrap();
        let streamed_belts = state
            .canonical_digest_bundle_with_parsed(Some(&parsed_entities), None)
            .unwrap();
        assert_eq!(
            streamed_belts.canonical_sha256,
            fully_parsed.canonical_sha256
        );
        assert_eq!(
            streamed_belts.canonical_components,
            fully_parsed.canonical_components
        );
        assert_eq!(
            streamed_belts.canonical_fields,
            fully_parsed.canonical_fields
        );
        assert_eq!(streamed_belts.domain_sha256, fully_parsed.domain_sha256);
        assert_eq!(state.materialize().unwrap()["entities"][0]["id"], "vein");
        let mut transactional_clone = state.clone();
        assert!(Arc::ptr_eq(&state.catalog, &transactional_clone.catalog));
        assert!(Arc::ptr_eq(
            &state.entity_raw.0,
            &transactional_clone.entity_raw.0
        ));
        assert!(Arc::ptr_eq(
            &state.belt_raw.0,
            &transactional_clone.belt_raw.0
        ));
        assert!(Arc::ptr_eq(
            &state.entity_raw[0],
            &transactional_clone.entity_raw[0]
        ));
        assert!(Arc::ptr_eq(
            &state.belt_raw[0],
            &transactional_clone.belt_raw[0]
        ));
        assert!(Arc::ptr_eq(
            &state.entity_index.0,
            &transactional_clone.entity_index.0
        ));
        assert!(Arc::ptr_eq(
            &state.entities.ids.0,
            &state.entity_index.ids.0
        ));
        assert!(Arc::ptr_eq(
            &state.entity_index.ids.0,
            &transactional_clone.entity_index.ids.0
        ));
        assert!(Arc::ptr_eq(
            &state.entities.0,
            &transactional_clone.entities.0
        ));
        assert!(Arc::ptr_eq(
            &state.entity_dynamics.0,
            &transactional_clone.entity_dynamics.0
        ));
        assert_eq!(summary.memory.inventory_entry_count, 1);
        assert_eq!(state.entity_dynamics.estimated_bytes(), 0);
        assert_eq!(
            state.entity_index.estimated_bytes() + state.belt_index.estimated_bytes(),
            16
        );
        assert!(summary.memory.estimated_runtime_bytes >= summary.memory.raw_record_bytes);
        transactional_clone.entity_index =
            ExactRowIdIndex::from_boxed(vec!["candidate-only".into()], "entity")
                .unwrap()
                .into();
        assert!(!state.entity_index.contains_key("candidate-only"));
        assert!(!Arc::ptr_eq(
            &state.entity_index.0,
            &transactional_clone.entity_index.0
        ));
        assert_eq!(state.entity_index.get("vein"), Some(&0));
        assert_eq!(
            transactional_clone.entity_index.get("candidate-only"),
            Some(&0)
        );
        transactional_clone.summary_cache.replace(None);
        assert!(state.summary_cache.borrow().is_some());

        // The fused pass is byte-identical to the independent public oracles,
        // and the cache may only survive while the protocol revision does.
        assert_eq!(summary.canonical_sha256, state.canonical_sha256().unwrap());
        assert_eq!(
            summary.canonical_components,
            state.canonical_components().unwrap()
        );
        assert_eq!(summary.canonical_fields, state.canonical_fields().unwrap());
        assert_eq!(summary.domain_sha256, state.domain_sha256().unwrap());
        assert!(state.summary_cache.borrow().is_some());
        state
            .base
            .insert("elapsedSeconds".to_owned(), Value::from(1));
        state.revision += 1;
        let advanced = state.summary().unwrap();
        assert_eq!(advanced.elapsed_seconds, 1.0);
        assert_ne!(advanced.canonical_sha256, summary.canonical_sha256);
    }

    #[test]
    fn resident_columns_and_factory_topology_drop_geometric_capacity_slack() {
        let entities = (0..17)
            .map(|index| {
                json!({
                    "id": format!("vein-{index}"),
                    "kind": "vein",
                    "planetId": "home",
                    "resourceId": "iron_ore",
                    "minerCount": 1,
                    "inputs": {},
                    "outputs": {"iron_ore": 1},
                })
            })
            .collect::<Vec<_>>();
        let mut records = fixture_records_with_entity_json(
            &serde_json::to_string(&entities).unwrap(),
            entities.len(),
        );
        replace_fixture_belt_chunk(&mut records, b"[]".to_vec(), 0);
        let state =
            CoreState::from_owned_internal_records(fixture_identity(7), records, fixture_catalog())
                .unwrap();

        for capacity in [
            state.entities.kinds.capacity(),
            state.entities.planets.capacity(),
            state.entities.buildings.capacity(),
            state.entities.recipes.capacity(),
            state.entities.resources.capacity(),
            state.entities.stored_items.capacity(),
            state.entities.machine_counts.capacity(),
            state.entities.miner_counts.capacity(),
            state.entities.position_x.capacity(),
            state.entities.position_y.capacity(),
        ] {
            assert_eq!(capacity, entities.len());
        }
        assert_eq!(
            state.factory_topology.estimated_bytes(),
            (state.factory_topology.vein_indices.len()
                + state.factory_topology.non_station_indices.len()
                + state.factory_topology.entity_planet_indices.len()
                + state.factory_topology.entity_grid_indices.len()
                + state.factory_topology.entities_by_planet[0].len()) as u64
                * size_of::<usize>() as u64
                + (state.factory_topology.device_counts_by_planet.capacity() * size_of::<f64>())
                    as u64
                + (state.factory_topology.planet_viewport_indexes.capacity()
                    * size_of::<PlanetViewportIndex>()) as u64
                + state.factory_topology.planet_viewport_indexes[0].estimated_bytes()
                + state
                    .factory_topology
                    .entity_belt_adjacency
                    .estimated_bytes()
        );
        assert_eq!(
            state.memory_estimate().topology_index_bytes,
            state.factory_topology.estimated_bytes()
                + state
                    .prepared_belt_routes
                    .as_ref()
                    .map(|routes| routes.estimated_bytes())
                    .unwrap_or(0)
                + state
                    .prepared_local_peer_directory
                    .as_ref()
                    .map(|directory| directory.estimated_bytes())
                    .unwrap_or(0)
        );
    }

    #[test]
    fn ray_receiver_topology_index_is_compact_and_counted_in_memory_diagnostics() {
        let receiver_rows = [1_usize, 4];
        let entities = (0..6)
            .map(|index| {
                if receiver_rows.contains(&index) {
                    json!({
                        "id": format!("receiver-{index}"),
                        "kind": "machine",
                        "planetId": "home",
                        "buildingId": "ray_receiver",
                        "recipeId": if index == 1 { "ray_power" } else { "critical_photon" },
                        "machineCount": 1,
                        "inputs": {},
                        "outputs": {"critical_photon": 0},
                    })
                } else {
                    json!({
                        "id": format!("vein-{index}"),
                        "kind": "vein",
                        "planetId": "home",
                        "resourceId": "iron_ore",
                        "minerCount": 1,
                        "inputs": {},
                        "outputs": {"iron_ore": 1},
                    })
                }
            })
            .collect::<Vec<_>>();
        let mut records = fixture_records_with_entity_json(
            &serde_json::to_string(&entities).unwrap(),
            entities.len(),
        );
        replace_fixture_belt_chunk(&mut records, b"[]".to_vec(), 0);
        let state =
            CoreState::from_owned_internal_records(fixture_identity(7), records, fixture_catalog())
                .unwrap();

        assert_eq!(state.factory_topology.ray_receiver_indices, receiver_rows);
        assert_eq!(
            state.factory_topology.ray_receiver_indices.capacity(),
            receiver_rows.len(),
            "the immutable session index must not retain geometric growth slack"
        );
        let indexed_bytes = (receiver_rows.len() * size_of::<usize>()) as u64;
        let mut topology_without_receivers = (*state.factory_topology).clone();
        topology_without_receivers.ray_receiver_indices = Vec::new();
        assert_eq!(
            state.factory_topology.estimated_bytes(),
            topology_without_receivers.estimated_bytes() + indexed_bytes
        );
        assert!(
            state.memory_estimate().topology_index_bytes
                >= state.factory_topology.estimated_bytes(),
            "public memory diagnostics must include the dedicated receiver index"
        );
    }

    #[test]
    fn viewport_v2_paginates_dense_entities_and_belts_independently_in_persisted_order() {
        let entities = (0..7)
            .map(|index| {
                json!({
                    "id": format!("entity-{index}"),
                    "kind": "vein",
                    "planetId": "home",
                    "resourceId": "iron_ore",
                    "minerCount": 1,
                    // Alternate grid cells so grid traversal order differs
                    // from persisted row order.
                    "position": {"x": if index % 2 == 0 { 900 + index } else { index }, "y": index},
                    "inputs": {},
                    "outputs": {"iron_ore": 1},
                })
            })
            .collect::<Vec<_>>();
        let belts = (0..6)
            .map(|index| {
                json!({
                    "id": format!("belt-{index}"),
                    "planetId": "home",
                    "source": format!("entity-{index}"),
                    "target": format!("entity-{}", index + 1),
                    "itemId": "iron_ore",
                    "lanes": 1,
                    "tier": 1,
                    "priority": 1,
                })
            })
            .collect::<Vec<_>>();
        let records = fixture_records_with_raw_entities_and_belts(
            &serde_json::to_string(&entities).unwrap(),
            entities.len(),
            &serde_json::to_string(&belts).unwrap(),
            belts.len(),
        );
        let state =
            CoreState::from_internal_records(fixture_identity(7), &records, fixture_catalog())
                .unwrap();
        let project = |entity_cursor, belt_cursor| {
            state
                .viewport_projection_v2(
                    &[],
                    "home",
                    -1.0,
                    -1.0,
                    1_000.0,
                    100.0,
                    entity_cursor,
                    2,
                    belt_cursor,
                    2,
                    &[],
                    &[],
                )
                .unwrap()
        };

        let first = project(0, 0);
        assert_eq!(first["schemaVersion"], 2);
        assert_eq!(first["projectionType"], "viewport-v2");
        assert_eq!(first["planetTotals"]["entities"], 7);
        assert_eq!(first["planetTotals"]["belts"], 6);
        assert_eq!(first["viewportTotals"]["entities"], 7);
        assert_eq!(first["viewportTotals"]["belts"], 6);
        assert_eq!(first["entities"][0]["id"], "entity-0");
        assert_eq!(first["entities"][1]["id"], "entity-1");
        assert_eq!(first["belts"][0]["id"], "belt-0");
        assert_eq!(first["belts"][1]["id"], "belt-1");
        assert_eq!(first["nextEntityCursor"], 2);
        assert_eq!(first["nextBeltCursor"], 2);

        let second_entity_page = project(2, 0);
        assert_eq!(second_entity_page["entities"][0]["id"], "entity-2");
        assert_eq!(second_entity_page["entities"][1]["id"], "entity-3");
        assert_eq!(second_entity_page["belts"], first["belts"]);

        let mut entity_ids = Vec::new();
        let mut cursor = 0;
        loop {
            let page = project(cursor, 0);
            entity_ids.extend(
                page["entities"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|entity| entity["id"].as_str().unwrap().to_owned()),
            );
            let Some(next) = page["nextEntityCursor"].as_u64() else {
                break;
            };
            cursor = next as usize;
        }
        assert_eq!(
            entity_ids,
            (0..7)
                .map(|index| format!("entity-{index}"))
                .collect::<Vec<_>>()
        );

        let mut belt_ids = Vec::new();
        let mut cursor = 0;
        loop {
            let page = project(0, cursor);
            belt_ids.extend(
                page["belts"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|belt| belt["id"].as_str().unwrap().to_owned()),
            );
            let Some(next) = page["nextBeltCursor"].as_u64() else {
                break;
            };
            cursor = next as usize;
        }
        assert_eq!(
            belt_ids,
            (0..6)
                .map(|index| format!("belt-{index}"))
                .collect::<Vec<_>>()
        );

        for key in ["minX", "minY", "maxX", "maxY"] {
            assert!(first["worldBounds"][key].as_f64().unwrap().is_finite());
            assert!(
                first["minimap"]["bounds"][key]
                    .as_f64()
                    .unwrap()
                    .is_finite()
            );
        }
        let broad = state
            .viewport_projection_v2(
                &[],
                "home",
                -5_000_000.0,
                -5_000_000.0,
                5_000_000.0,
                5_000_000.0,
                0,
                7,
                0,
                6,
                &[],
                &[],
            )
            .unwrap();
        assert_eq!(broad["broadQueryFallback"], true);
        assert_eq!(broad["entities"].as_array().unwrap().len(), 7);
        assert_eq!(broad["entities"][0]["id"], "entity-0");
        assert_eq!(broad["entities"][6]["id"], "entity-6");
    }

    #[test]
    fn viewport_v2_keeps_opaque_out_of_view_pins_and_incident_belts() {
        let pinned_entity_id = "mod:节点/Ω [selected]";
        let pinned_belt_id = "mod:线路/β #pinned";
        let entities = json!([
            {"id": pinned_entity_id, "kind":"vein", "planetId":"home", "resourceId":"iron_ore", "position":{"x":2000,"y":2000}, "inputs":{}, "outputs":{"iron_ore":1}},
            {"id":"visible", "kind":"vein", "planetId":"home", "resourceId":"iron_ore", "position":{"x":0,"y":0}, "inputs":{}, "outputs":{"iron_ore":1}},
            {"id":"far", "kind":"vein", "planetId":"home", "resourceId":"iron_ore", "position":{"x":3000,"y":3000}, "inputs":{}, "outputs":{"iron_ore":1}}
        ]);
        let belts = json!([
            {"id":pinned_belt_id,"planetId":"home","source":"far","target":"far","itemId":"iron_ore","lanes":1,"tier":1,"priority":1},
            {"id":"incident-to-selection","planetId":"home","source":pinned_entity_id,"target":"far","itemId":"iron_ore","lanes":1,"tier":1,"priority":1}
        ]);
        let records = fixture_records_with_raw_entities_and_belts(
            &entities.to_string(),
            3,
            &belts.to_string(),
            2,
        );
        let state =
            CoreState::from_internal_records(fixture_identity(7), &records, fixture_catalog())
                .unwrap();
        let projection = state
            .viewport_projection_v2(
                &[],
                "home",
                -10.0,
                -10.0,
                10.0,
                10.0,
                0,
                1,
                0,
                1,
                &[pinned_entity_id.to_owned()],
                &[pinned_belt_id.to_owned()],
            )
            .unwrap();

        // Returned arrays are always persisted-row ordered, even when the
        // pinned record precedes the ordinary visible page.
        assert_eq!(projection["entities"][0]["id"], pinned_entity_id);
        assert_eq!(projection["entities"][1]["id"], "visible");
        assert_eq!(projection["belts"][0]["id"], pinned_belt_id);
        assert_eq!(projection["belts"][1]["id"], "incident-to-selection");
        assert_eq!(projection["pinnedEntityIds"], json!([pinned_entity_id]));
        assert_eq!(projection["pinnedBeltIds"], json!([pinned_belt_id]));
        assert_eq!(projection["viewportTotals"]["entities"], 1);
        assert_eq!(projection["viewportTotals"]["belts"], 1);
        assert_eq!(projection["worldBounds"]["minX"], 0.0);
        assert_eq!(projection["worldBounds"]["maxX"], 3000.0);
    }

    #[test]
    fn viewport_v2_rejects_invalid_bounds_cursors_limits_and_selectors() {
        let state = CoreState::from_internal_records(
            fixture_identity(7),
            &fixture_records(),
            fixture_catalog(),
        )
        .unwrap();
        let project = |min_x,
                       max_x,
                       entity_cursor,
                       entity_limit,
                       belt_cursor,
                       belt_limit,
                       pinned_entity_ids: &[String]| {
            state.viewport_projection_v2(
                &[],
                "home",
                min_x,
                -1.0,
                max_x,
                1.0,
                entity_cursor,
                entity_limit,
                belt_cursor,
                belt_limit,
                pinned_entity_ids,
                &[],
            )
        };
        assert!(project(f64::NAN, 1.0, 0, 1, 0, 1, &[]).is_err());
        assert!(project(2.0, 1.0, 0, 1, 0, 1, &[]).is_err());
        assert!(project(-1.0, 1.0, 0, 0, 0, 1, &[]).is_err());
        assert!(project(-1.0, 1.0, 0, 1, 0, 0, &[]).is_err());
        assert!(project(-1.0, 1.0, 2, 1, 0, 1, &[]).is_err());
        assert!(project(-1.0, 1.0, 0, 1, 2, 1, &[]).is_err());
        assert!(
            project(
                -1.0,
                1.0,
                0,
                1,
                0,
                1,
                &vec!["opaque".to_owned(); MAX_VIEWPORT_PINNED_ENTITIES + 1],
            )
            .is_err()
        );
        assert!(
            project(
                -1.0,
                1.0,
                0,
                1,
                0,
                1,
                &["x".repeat(MAX_VIEWPORT_OPAQUE_ID_BYTES + 1)],
            )
            .is_err()
        );
        assert!(
            state
                .viewport_projection_v2(
                    &[],
                    "missing/mod-planet",
                    -1.0,
                    -1.0,
                    1.0,
                    1.0,
                    0,
                    1,
                    0,
                    1,
                    &[],
                    &[],
                )
                .is_err()
        );
    }

    #[test]
    fn viewport_v2_enforces_the_one_mib_serialized_boundary() {
        let records = fixture_records_with_entity_json(
            &json!([{
                "id":"large",
                "kind":"vein",
                "planetId":"home",
                "resourceId":"iron_ore",
                "position":{"x":0,"y":0},
                "inputs":{},
                "outputs":{"iron_ore":1},
                "opaqueModPayload":"x".repeat(MAX_PROJECTION_BYTES)
            }])
            .to_string(),
            1,
        );
        let state =
            CoreState::from_internal_records(fixture_identity(7), &records, fixture_catalog())
                .unwrap();
        let error = state
            .viewport_projection_v2(&[], "home", -1.0, -1.0, 1.0, 1.0, 0, 1, 0, 1, &[], &[])
            .unwrap_err();
        assert_eq!(
            error.to_string(),
            "native viewport v2 projection exceeds the byte limit"
        );
    }

    #[test]
    fn core_state_is_send_sync_and_summary_cache_is_concurrent() {
        fn assert_send_sync<T: Send + Sync>() {}
        assert_send_sync::<CoreState>();

        let state = Arc::new(
            CoreState::from_internal_records(
                CoreCheckpointIdentity {
                    slot: "normal-main".into(),
                    generation: 1,
                    root_hash: "a".repeat(64),
                    revision: 7,
                    state_version: 47,
                    mode: "normal".into(),
                    registry_fingerprint: "core".into(),
                    base_primary_checksum: "12345678".into(),
                },
                &fixture_records(),
                fixture_catalog(),
            )
            .unwrap(),
        );
        let expected = state.summary().unwrap().canonical_sha256;
        let workers = (0..8)
            .map(|_| {
                let state = state.clone();
                std::thread::spawn(move || state.summary().unwrap().canonical_sha256)
            })
            .collect::<Vec<_>>();
        for worker in workers {
            assert_eq!(worker.join().unwrap(), expected);
        }
    }

    #[test]
    fn statistics_projection_filters_the_compact_history_without_factory_records() {
        let mut state = CoreState::from_internal_records(
            CoreCheckpointIdentity {
                slot: "normal-main".into(),
                generation: 1,
                root_hash: "a".repeat(64),
                revision: 7,
                state_version: 47,
                mode: "normal".into(),
                registry_fingerprint: "core".into(),
                base_primary_checksum: "12345678".into(),
            },
            &fixture_records(),
            fixture_catalog(),
        )
        .unwrap();
        state.base.insert(
            "productionHistory".into(),
            json!([
                {"elapsedSeconds":1,"sampleDurationSeconds":1,"productionPerMinute":{"iron_ore":60,"hidden":5},"consumptionPerMinute":{"iron_ore":2,"hidden":1},"inventory":{"iron_ore":3,"hidden":9},"planetProductionPerMinute":{"home":{"iron_ore":60,"hidden":5}},"planetConsumptionPerMinute":{"home":{"iron_ore":2,"hidden":1}}},
                {"elapsedSeconds":2,"sampleDurationSeconds":1,"productionPerMinute":{"iron_ore":120},"consumptionPerMinute":{},"inventory":{"iron_ore":5},"planetProductionPerMinute":{"home":{"iron_ore":120}},"planetConsumptionPerMinute":{"home":{}}},
                {"elapsedSeconds":3,"sampleDurationSeconds":1,"productionPerMinute":{"iron_ore":180},"consumptionPerMinute":{},"inventory":{"iron_ore":8},"planetProductionPerMinute":{"home":{"iron_ore":180}},"planetConsumptionPerMinute":{"home":{}}}
            ]),
        );
        let canonical_before_private_refresh = state.canonical_sha256().unwrap();
        state.refresh_production_history_tiers();
        assert_eq!(
            state.canonical_sha256().unwrap(),
            canonical_before_private_refresh
        );
        let first = state
            .statistics_projection(1.0, 3.0, 0, 2, Some("home"), Some("iron_ore"))
            .unwrap();
        assert_eq!(first["projectionType"], "statistics-v1");
        assert_eq!(first["samples"].as_array().unwrap().len(), 2);
        assert_eq!(first["nextCursor"], 2);
        assert!(
            first["samples"][0]["productionPerMinute"]
                .get("hidden")
                .is_none()
        );
        let second = state
            .statistics_projection(1.0, 3.0, 2, 2, Some("home"), Some("iron_ore"))
            .unwrap();
        assert_eq!(second["samples"].as_array().unwrap().len(), 1);
        assert!(second["nextCursor"].is_null());
        assert_eq!(state.entity_raw.len(), 1);
        assert_eq!(state.belt_raw.len(), 1);
    }

    fn state_with_restored_cold_history() -> CoreState {
        let mut state = CoreState::from_internal_records(
            fixture_identity(7),
            &fixture_records(),
            fixture_catalog(),
        )
        .unwrap();
        state
            .base
            .insert("elapsedSeconds".to_owned(), Value::from(102));
        state
            .base
            .insert("historyRecordedAt".to_owned(), Value::from(102));
        state.base.insert(
            "productionHistory".to_owned(),
            json!([
                {"elapsedSeconds":101,"sampleDurationSeconds":1,"productionPerMinute":{"iron_ore":60}},
                {"elapsedSeconds":102,"sampleDurationSeconds":1,"productionPerMinute":{"iron_ore":70}}
            ]),
        );
        state.rebuild_production_history_tiers();
        state
            .restore_production_history_sidecar(json!({
                "formatVersion": 1,
                "source": {
                    "publicLen": 2,
                    "historyRecordedAtBits": 102.0_f64.to_bits(),
                    "latestElapsedBits": 102.0_f64.to_bits(),
                    "latestDurationBits": 1.0_f64.to_bits()
                },
                "coldSamples": [{
                    "elapsedSeconds": 100,
                    "sampleDurationSeconds": 100,
                    "productionPerMinute": {"iron_ore": 12}
                }]
            }))
            .unwrap();
        state
    }

    fn top_level_command(revision: u64, key: &str, value: Value) -> SimulationCommandPatch {
        SimulationCommandPatch {
            protocol_version: crate::CORE_PROTOCOL_VERSION,
            base_revision: revision,
            top_level_changes: vec![ValuePatch {
                path: vec![PathSegment::Key(key.to_owned())],
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
    fn unrelated_command_preserves_cold_history_but_source_or_unknown_patch_rebuilds() {
        let mut paused = state_with_restored_cold_history();
        let sidecar_before = paused.production_history_sidecar().unwrap();
        paused
            .apply_command(&top_level_command(7, "paused", Value::from(true)))
            .unwrap();
        assert_eq!(paused.production_history_sidecar().unwrap(), sidecar_before);
        let projection = paused
            .statistics_projection(0.0, 100.0, 0, 10, None, None)
            .unwrap();
        assert_eq!(projection["samples"].as_array().unwrap().len(), 1);
        assert_eq!(projection["samples"][0]["elapsedSeconds"], 100);

        for (key, value) in [
            (
                "productionHistory",
                json!([
                    {"elapsedSeconds":101,"sampleDurationSeconds":1,"productionPerMinute":{"iron_ore":60}},
                    {"elapsedSeconds":102,"sampleDurationSeconds":1,"productionPerMinute":{"iron_ore":70}}
                ]),
            ),
            ("historyRecordedAt", Value::from(102)),
            ("elapsedSeconds", Value::from(102)),
            ("futureUnknownField", Value::from(true)),
        ] {
            let mut state = state_with_restored_cold_history();
            state
                .apply_command(&top_level_command(7, key, value))
                .unwrap();
            assert!(
                state.production_history_sidecar().is_none(),
                "{key} must rebuild rather than retain an unproved cold cache"
            );
            let projection = state
                .statistics_projection(0.0, 100.0, 0, 10, None, None)
                .unwrap();
            assert_eq!(projection["samples"], Value::Array(Vec::new()));
        }
    }

    #[test]
    fn statistics_projection_refreshes_after_command_rewrites_or_clears_public_history() {
        let mut state = CoreState::from_internal_records(
            fixture_identity(7),
            &fixture_records(),
            fixture_catalog(),
        )
        .unwrap();
        state.base.insert(
            "productionHistory".into(),
            json!([
                {"elapsedSeconds":1,"sampleDurationSeconds":1,"productionPerMinute":{"iron_ore":60},"consumptionPerMinute":{},"inventory":{"iron_ore":1}},
                {"elapsedSeconds":2,"sampleDurationSeconds":1,"productionPerMinute":{"iron_ore":70},"consumptionPerMinute":{},"inventory":{"iron_ore":2}}
            ]),
        );
        state
            .base
            .insert("historyRecordedAt".into(), Value::from(2));
        state.rebuild_production_history_tiers();

        state
            .apply_command(&SimulationCommandPatch {
                protocol_version: crate::CORE_PROTOCOL_VERSION,
                base_revision: 7,
                top_level_changes: vec![ValuePatch {
                    path: vec![
                        PathSegment::Key("productionHistory".into()),
                        PathSegment::Index(0),
                        PathSegment::Key("productionPerMinute".into()),
                        PathSegment::Key("iron_ore".into()),
                    ],
                    operation: "set".into(),
                    value: Some(Value::from(777)),
                }],
                changed_entities: Vec::new(),
                added_entities: Vec::new(),
                removed_entity_ids: Vec::new(),
                changed_belts: Vec::new(),
                added_belts: Vec::new(),
                removed_belt_ids: Vec::new(),
            })
            .unwrap();
        let projection = state
            .statistics_projection(1.0, 2.0, 0, 10, None, Some("iron_ore"))
            .unwrap();
        assert_eq!(
            projection["samples"][0]["productionPerMinute"]["iron_ore"],
            777
        );

        state
            .apply_command(&SimulationCommandPatch {
                protocol_version: crate::CORE_PROTOCOL_VERSION,
                base_revision: 8,
                top_level_changes: vec![ValuePatch {
                    path: vec![PathSegment::Key("productionHistory".into())],
                    operation: "set".into(),
                    value: Some(Value::Array(Vec::new())),
                }],
                changed_entities: Vec::new(),
                added_entities: Vec::new(),
                removed_entity_ids: Vec::new(),
                changed_belts: Vec::new(),
                added_belts: Vec::new(),
                removed_belt_ids: Vec::new(),
            })
            .unwrap();
        let projection = state
            .statistics_projection(0.0, 2.0, 0, 10, None, Some("iron_ore"))
            .unwrap();
        assert_eq!(projection["samples"], Value::Array(Vec::new()));
    }

    #[test]
    fn streams_a_compatible_bounded_checkpoint_without_materializing_game_state() {
        let identity = CoreCheckpointIdentity {
            slot: "normal-main".into(),
            generation: 1,
            root_hash: "a".repeat(64),
            revision: 7,
            state_version: 47,
            mode: "normal".into(),
            registry_fingerprint: "core".into(),
            base_primary_checksum: "12345678".into(),
        };
        let state = CoreState::from_internal_records(
            identity.clone(),
            &fixture_records(),
            fixture_catalog(),
        )
        .unwrap();
        let mut streamed = BTreeMap::<String, Vec<u8>>::new();
        let keys = state
            .visit_internal_checkpoint_records(42, |key, value| {
                assert!(value.len() < 8 * 1024 * 1024);
                streamed.insert(key.to_owned(), value.as_bytes().to_vec());
                Ok(())
            })
            .unwrap();
        assert_eq!(keys.len(), streamed.len());
        let restored =
            CoreState::from_internal_records(identity, &streamed, fixture_catalog()).unwrap();
        assert_eq!(
            restored.canonical_sha256().unwrap(),
            state.canonical_sha256().unwrap()
        );
        let manifest_key = "dsp-idle-network.internal.v1.chunked.v1.normal.manifest";
        let manifest: Value = serde_json::from_slice(&streamed[manifest_key]).unwrap();
        assert_eq!(manifest["savedAt"], 42);
        assert_eq!(manifest["basePrimaryChecksum"], "12345678");
    }

    #[test]
    fn v2_domain_checkpoint_preserves_mod_data_and_reuses_content_until_durable_ack() {
        let identity = fixture_identity(7);
        let mut legacy = CoreState::from_internal_records(
            identity.clone(),
            &fixture_records(),
            fixture_catalog(),
        )
        .unwrap();
        legacy.base_value_mut().insert(
            "quantumLogisticsNetwork".to_owned(),
            json!({"inventory":{"iron_ore":"123"},"modSlot":{"keep":true}}),
        );
        legacy.base_value_mut().insert(
            "dysonSphere".to_owned(),
            json!({"structurePoints":7,"modShell":{"keep":[1,2,3]}}),
        );
        legacy
            .base_value_mut()
            .insert("totalProduced".to_owned(), json!({"iron_ore":11}));
        legacy.base_value_mut().insert(
            "mod:opaque-domain".to_owned(),
            json!({"signedZero":-0.0,"nested":{"keep":[1,null,"three"]}}),
        );
        let expected = legacy.materialize().unwrap();

        let mut records = BTreeMap::<String, Vec<u8>>::new();
        legacy
            .visit_internal_checkpoint_records(42, |key, value| {
                records.insert(key.to_owned(), value.as_bytes().to_vec());
                Ok(())
            })
            .unwrap();
        let manifest_key = "dsp-idle-network.internal.v1.chunked.v1.normal.manifest";
        let manifest: Value = serde_json::from_slice(&records[manifest_key]).unwrap();
        assert_eq!(
            manifest["formatVersion"],
            DOMAIN_INTERNAL_CHECKPOINT_FORMAT_VERSION
        );
        let kinds = manifest["chunks"]
            .as_array()
            .unwrap()
            .iter()
            .map(|chunk| chunk["kind"].as_str().unwrap())
            .collect::<HashSet<_>>();
        for domain in BASE_CHECKPOINT_DOMAINS {
            assert!(kinds.contains(domain.kind()));
        }
        assert!(manifest["chunks"].as_array().unwrap().iter().all(|chunk| {
            chunk["sha256"]
                .as_str()
                .is_some_and(|hash| hash.len() == 64)
        }));

        let mut state =
            CoreState::from_internal_records(identity.clone(), &records, fixture_catalog())
                .unwrap();
        assert!(json_bitwise_eq(&state.materialize().unwrap(), &expected));
        assert_eq!(
            state.base["mod:opaque-domain"]["signedZero"]
                .as_f64()
                .unwrap()
                .to_bits(),
            (-0.0_f64).to_bits()
        );

        state
            .base_value_mut()
            .insert("elapsedSeconds".to_owned(), Value::from(1));
        let mut first_delta = BTreeMap::new();
        let first = state
            .visit_dirty_internal_checkpoint_records(43, |key, value| {
                first_delta.insert(key.to_owned(), value.as_bytes().to_vec());
                Ok(())
            })
            .unwrap();
        assert_eq!(first.encoded_records, 2);
        assert_eq!(first.reused_records, 6);
        assert!(
            first_delta
                .keys()
                .any(|key| key.ends_with("chunk.base%3Acore"))
        );
        assert!(first_delta.keys().any(|key| key.ends_with("manifest")));
        assert_eq!(first_delta.len(), 2);

        // Aborting the filesystem transaction must leave the changed domain
        // pending. The exact same domain is emitted again on retry.
        state.abort_checkpoint_visit();
        let mut retry_delta = BTreeMap::new();
        let retry = state
            .visit_dirty_internal_checkpoint_records(44, |key, value| {
                retry_delta.insert(key.to_owned(), value.as_bytes().to_vec());
                Ok(())
            })
            .unwrap();
        assert_eq!(retry.encoded_records, 2);
        assert_eq!(retry.reused_records, 6);
        apply_checkpoint_delta(&mut records, &retry, retry_delta);
        state.install_checkpoint_identity(2, "b".repeat(64));

        let clean = state
            .visit_dirty_internal_checkpoint_records(45, |_key, _value| Ok(()))
            .unwrap();
        assert_eq!(clean.encoded_records, 1);
        assert_eq!(clean.reused_records, 7);
        state.abort_checkpoint_visit();

        // Content validation is authoritative even if a future call site
        // mutates an owned domain without setting the coarse base dirty bit.
        state
            .base
            .insert("dysonSphere".to_owned(), json!({"structurePoints":8}));
        let mut unmarked_delta = BTreeMap::new();
        let unmarked = state
            .visit_dirty_internal_checkpoint_records(46, |key, value| {
                unmarked_delta.insert(key.to_owned(), value.as_bytes().to_vec());
                Ok(())
            })
            .unwrap();
        assert_eq!(unmarked.encoded_records, 2);
        assert_eq!(unmarked.reused_records, 6);
        assert!(
            unmarked_delta
                .keys()
                .any(|key| key.ends_with("chunk.base%3Adyson"))
        );
        state.abort_checkpoint_visit();

        let restored = CoreState::from_internal_records(
            CoreCheckpointIdentity {
                generation: 2,
                root_hash: "b".repeat(64),
                ..identity
            },
            &records,
            fixture_catalog(),
        )
        .unwrap();
        assert_eq!(restored.base["elapsedSeconds"], 1);
        assert_eq!(
            restored.base["mod:opaque-domain"]["nested"]["keep"][2],
            "three"
        );
    }

    #[test]
    fn streams_v47_envelope_with_exact_legacy_checksum_and_sha256() {
        let identity = CoreCheckpointIdentity {
            slot: "normal-main".into(),
            generation: 1,
            root_hash: "a".repeat(64),
            revision: 7,
            state_version: 47,
            mode: "normal".into(),
            registry_fingerprint: "core".into(),
            base_primary_checksum: "12345678".into(),
        };
        let state =
            CoreState::from_internal_records(identity, &fixture_records(), fixture_catalog())
                .unwrap();
        let mut bytes = Vec::new();
        let result = state.write_v47_envelope(42, &mut bytes).unwrap();
        let envelope: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(envelope["formatVersion"], 2);
        assert_eq!(envelope["state"]["version"], 47);
        assert_eq!(envelope["state"]["entities"][0]["id"], "vein");
        let raw = String::from_utf8(bytes.clone()).unwrap();
        let state_start = raw.find("\"state\":").unwrap() + "\"state\":".len();
        let state_end = raw.rfind(",\"checksum\":").unwrap();
        let state_text = &raw[state_start..state_end];
        let mut checksum = Utf16Fnv1a::new();
        checksum.update("{\"formatVersion\":2,\"state\":");
        checksum.update(state_text);
        checksum.update("}");
        assert_eq!(envelope["checksum"], checksum.finish());
        assert_eq!(result.state_checksum, checksum.finish());
        assert_eq!(result.byte_length, bytes.len() as u64);
        assert_eq!(result.envelope_sha256, hex::encode(Sha256::digest(&bytes)));
    }

    #[test]
    fn dirty_checkpoint_reuses_clean_pages_until_commit_acknowledges_them() {
        let identity = CoreCheckpointIdentity {
            slot: "normal-main".into(),
            generation: 1,
            root_hash: "a".repeat(64),
            revision: 7,
            state_version: 47,
            mode: "normal".into(),
            registry_fingerprint: "core".into(),
            base_primary_checksum: "12345678".into(),
        };
        let mut state = CoreState::from_internal_records(
            identity.clone(),
            &fixture_records(),
            fixture_catalog(),
        )
        .unwrap();
        let mut first_delta = BTreeMap::<String, Vec<u8>>::new();
        let first = state
            .visit_dirty_internal_checkpoint_records(43, |key, value| {
                first_delta.insert(key.to_owned(), value.as_bytes().to_vec());
                Ok(())
            })
            .unwrap();
        // A legacy v1 checkpoint cannot lend its SHA-less entity/belt pages to
        // a v2 manifest. The first upgrade therefore rewrites all seven data
        // chunks and publishes the v2 manifest last.
        assert_eq!(first.encoded_records, 8);
        assert_eq!(first.reused_records, 0);
        assert_eq!(first_delta.len(), 8);
        let first_manifest: Value = serde_json::from_slice(
            &first_delta["dsp-idle-network.internal.v1.chunked.v1.normal.manifest"],
        )
        .unwrap();
        assert_eq!(
            first_manifest["formatVersion"],
            DOMAIN_INTERNAL_CHECKPOINT_FORMAT_VERSION
        );
        assert!(
            first_delta
                .keys()
                .any(|key| key.ends_with("chunk.base%3Aunknown-mod"))
        );
        assert!(
            first_manifest["chunks"]
                .as_array()
                .unwrap()
                .iter()
                .all(|chunk| {
                    chunk["sha256"]
                        .as_str()
                        .is_some_and(|hash| hash.len() == 64)
                })
        );

        // A failed filesystem transaction must not acknowledge a later dirty
        // base/page. The next attempt has to emit them again.
        state.abort_checkpoint_visit();
        state
            .base_value_mut()
            .insert("elapsedSeconds".to_owned(), Value::from(1));
        state.replace_entity_raw(
            0,
            Arc::<str>::from(
                serde_json::to_string(&json!({
                    "id":"vein","kind":"vein","planetId":"home","resourceId":"iron_ore",
                    "minerCount":2,"inputs":{},"outputs":{"iron_ore":4},"progress":0,
                    "utilization":0,"productionRate":0,"routingCursor":0
                }))
                .unwrap(),
            ),
        );
        let mut retry_delta = BTreeMap::<String, Vec<u8>>::new();
        let retry = state
            .visit_dirty_internal_checkpoint_records(44, |key, value| {
                retry_delta.insert(key.to_owned(), value.as_bytes().to_vec());
                Ok(())
            })
            .unwrap();
        assert_eq!(retry.encoded_records, 8);
        assert_eq!(retry.reused_records, 0);
        assert!(
            retry_delta
                .keys()
                .any(|key| key.ends_with("chunk.base%3Acore"))
        );
        assert!(
            retry_delta
                .keys()
                .any(|key| key.ends_with("chunk.entities%3A00000000"))
        );

        state.install_checkpoint_identity(2, "b".repeat(64));
        let clean = state
            .visit_dirty_internal_checkpoint_records(45, |_key, _value| Ok(()))
            .unwrap();
        assert_eq!(clean.encoded_records, 1);
        assert_eq!(clean.reused_records, 7);
    }

    #[test]
    fn dirty_checkpoint_encodes_only_the_changed_entity_page() {
        let base = serde_json::to_vec(&json!({
            "version":47,"mode":"normal","activePlanetId":"home","elapsedSeconds":0,"paused":false
        }))
        .unwrap();
        let entities = (0..1_025)
            .map(|index| {
                json!({
                    "id":format!("vein-{index}"),"kind":"vein","planetId":"home",
                    "resourceId":"iron_ore","minerCount":0,"inputs":{},"outputs":{},
                    "progress":0,"utilization":0,"productionRate":0,"routingCursor":0
                })
            })
            .collect::<Vec<_>>();
        let entity_pages = entities
            .chunks(ENTITY_CHECKPOINT_CHUNK_SIZE)
            .enumerate()
            .map(|(page, values)| {
                let offset = page * ENTITY_CHECKPOINT_CHUNK_SIZE;
                let id = format!("entities:{offset:08}");
                (id, offset, serde_json::to_vec(values).unwrap())
            })
            .collect::<Vec<_>>();
        let belts = serde_json::to_vec(&json!([])).unwrap();
        let mut chunk_values = vec![json!({
            "id":"base","kind":"base","offset":0,"count":1,
            "checksum":fnv1a_utf8(&base),"bytes":base.len()
        })];
        for (id, offset, bytes) in &entity_pages {
            chunk_values.push(json!({
                "id":id,"kind":"entities","offset":offset,
                "count":serde_json::from_slice::<Vec<Value>>(bytes).unwrap().len(),
                "checksum":fnv1a_utf8(bytes),"bytes":bytes.len()
            }));
        }
        chunk_values.push(json!({
            "id":"belts:00000000","kind":"belts","offset":0,"count":0,
            "checksum":fnv1a_utf8(&belts),"bytes":belts.len()
        }));
        let manifest = serde_json::to_vec(&json!({
            "formatVersion":1,"envelopeFormatVersion":2,"mode":"normal","slot":"main",
            "stateVersion":47,"savedAt":1,"basePrimaryChecksum":"12345678",
            "chunkRootChecksum":"12345678","totalBytes":base.len()+belts.len()+entity_pages.iter().map(|(_,_,bytes)|bytes.len()).sum::<usize>(),
            "entityCount":entities.len(),"beltCount":0,"chunks":chunk_values
        }))
        .unwrap();
        let prefix = "dsp-idle-network.internal.v1.chunked.v1.normal.";
        let mut records = BTreeMap::from([
            (format!("{prefix}manifest"), manifest),
            (format!("{prefix}chunk.base"), base),
            (format!("{prefix}chunk.belts%3A00000000"), belts),
        ]);
        for (id, _, bytes) in entity_pages {
            records.insert(format!("{prefix}chunk.{}", encoded_chunk_id(&id)), bytes);
        }
        let identity = CoreCheckpointIdentity {
            slot: "normal-main".into(),
            generation: 1,
            root_hash: "a".repeat(64),
            revision: 7,
            state_version: 47,
            mode: "normal".into(),
            registry_fingerprint: "core".into(),
            base_primary_checksum: "12345678".into(),
        };
        let mut state =
            CoreState::from_internal_records(identity.clone(), &records, fixture_catalog())
                .unwrap();
        let mut upgrade_delta = BTreeMap::new();
        let upgrade = state
            .visit_dirty_internal_checkpoint_records(1, |key, value| {
                upgrade_delta.insert(key.to_owned(), value.as_bytes().to_vec());
                Ok(())
            })
            .unwrap();
        assert_eq!(upgrade.encoded_records, 9);
        assert_eq!(upgrade.reused_records, 0);
        apply_checkpoint_delta(&mut records, &upgrade, upgrade_delta);
        state.install_checkpoint_identity(2, "b".repeat(64));

        let mut changed = state.parse_entity(1_024).unwrap();
        changed["outputs"]["iron_ore"] = Value::from(9);
        state.replace_entity_raw(
            1_024,
            Arc::<str>::from(serde_json::to_string(&changed).unwrap()),
        );
        let mut delta = BTreeMap::new();
        let visit = state
            .visit_dirty_internal_checkpoint_records(2, |key, value| {
                delta.insert(key.to_owned(), value.as_bytes().to_vec());
                Ok(())
            })
            .unwrap();
        assert_eq!(visit.encoded_records, 2);
        assert_eq!(visit.reused_records, 7);
        assert!(
            delta
                .keys()
                .any(|key| key.ends_with("chunk.entities%3A00001024"))
        );
        assert!(
            !delta
                .keys()
                .any(|key| key.ends_with("chunk.entities%3A00000000"))
        );

        apply_checkpoint_delta(&mut records, &visit, delta);
        let restored =
            CoreState::from_internal_records(identity, &records, fixture_catalog()).unwrap();
        assert_eq!(
            restored.materialize().unwrap()["entities"][1_024]["outputs"]["iron_ore"],
            9
        );
    }

    #[test]
    fn entity_columns_preserve_duplicate_missing_null_negative_zero_and_mod_semantics() {
        let records = fixture_records_with_entity_json(
            r#"[{
                "id":"discarded-id","id":"entity-special",
                "kind":"machine","planetId":"home","buildingId":"mining_machine",
                "productionRate":1e2,"productionRate":-0.0,
                "utilization":null,
                "powerFactor":"mod-power",
                "stationProgress":1.25e-2,
                "stationLastTransfer":-0e0,
                "routingCursor":2E3,
                "inputs":{"discarded":9},
                "inputs":{"iron_ore":1e3,"mod-item":null,"other":{"nested":true},"iron_ore":-0.0},
                "outputs":null,
                "modPayload":{"progress":999,"inputs":{"iron_ore":777}}
            }]"#,
            1,
        );
        let state =
            CoreState::from_internal_records(fixture_identity(7), &records, fixture_catalog())
                .unwrap();

        assert_eq!(state.entity_index.get("entity-special"), Some(&0));
        assert!(!state.entity_index.contains_key("discarded-id"));
        assert_eq!(
            state
                .entity_dynamic_number(0, EntityDynamicField::ProductionRate)
                .unwrap()
                .as_f64()
                .unwrap()
                .to_bits(),
            (-0.0_f64).to_bits()
        );
        assert_eq!(
            state
                .entity_dynamic_number(0, EntityDynamicField::Utilization)
                .unwrap()
                .kind(),
            ResidentValueKind::Null
        );
        assert_eq!(
            state
                .entity_dynamic_number(0, EntityDynamicField::Progress)
                .unwrap()
                .kind(),
            ResidentValueKind::Missing
        );
        assert_eq!(
            state
                .entity_dynamic_number(0, EntityDynamicField::PowerFactor)
                .unwrap()
                .kind(),
            ResidentValueKind::Other
        );
        assert_eq!(
            state
                .entity_dynamic_number(0, EntityDynamicField::StationProgress)
                .unwrap()
                .as_f64(),
            Some(0.0125)
        );
        assert_eq!(
            state
                .entity_dynamic_number(0, EntityDynamicField::StationLastTransfer)
                .unwrap()
                .as_f64()
                .unwrap()
                .to_bits(),
            (-0.0_f64).to_bits()
        );
        assert_eq!(
            state
                .entity_dynamic_number(0, EntityDynamicField::RoutingCursor)
                .unwrap()
                .as_f64(),
            Some(2_000.0)
        );
        assert!(
            state
                .entity_dynamic_number(1, EntityDynamicField::Progress)
                .is_none()
        );

        let inputs = state
            .entity_inventory(0, EntityInventorySide::Inputs)
            .unwrap();
        assert_eq!(inputs.container_kind(), ResidentObjectKind::Object);
        assert_eq!(inputs.len(), 3);
        assert_eq!(
            inputs.get("iron_ore").unwrap().as_f64().unwrap().to_bits(),
            (-0.0_f64).to_bits()
        );
        assert_eq!(
            inputs.get("mod-item").unwrap().kind(),
            ResidentValueKind::Null
        );
        assert_eq!(
            inputs.get("other").unwrap().kind(),
            ResidentValueKind::Other
        );
        assert!(inputs.get("discarded").is_none());
        let entries = inputs
            .entries()
            .map(|entry| (entry.item_id().to_owned(), entry.amount().kind()))
            .collect::<BTreeMap<_, _>>();
        assert_eq!(entries["iron_ore"], ResidentValueKind::Number);
        assert_eq!(entries["mod-item"], ResidentValueKind::Null);
        assert_eq!(entries["other"], ResidentValueKind::Other);

        let outputs = state
            .entity_inventory(0, EntityInventorySide::Outputs)
            .unwrap();
        assert_eq!(outputs.container_kind(), ResidentObjectKind::Null);
        assert!(outputs.is_empty());
        assert_eq!(state.memory_estimate().inventory_entry_count, 3);

        let parsed = state.parse_entity(0).unwrap();
        assert_eq!(parsed["id"], "entity-special");
        assert_eq!(parsed["modPayload"]["progress"], 999);
        assert_eq!(parsed["modPayload"]["inputs"]["iron_ore"], 777);
        assert_eq!(
            parsed["inputs"]["iron_ore"].as_f64().unwrap().to_bits(),
            (-0.0_f64).to_bits()
        );
    }

    #[test]
    fn malformed_entity_records_fail_before_installing_resident_columns() {
        for (raw, expected) in [
            (r#"[{"id":"truncated""#, "record chunk"),
            (r#"[["not-an-object"]]"#, "not an object"),
            (
                r#"[{"kind":"machine","inputs":{},"outputs":{}}]"#,
                "ID is missing",
            ),
        ] {
            let records = fixture_records_with_entity_json(raw, 1);
            let error =
                CoreState::from_internal_records(fixture_identity(7), &records, fixture_catalog())
                    .unwrap_err();
            assert!(
                format!("{error:#}").contains(expected),
                "raw={raw} error={error:#}"
            );
        }
    }

    #[test]
    fn randomized_entity_columns_match_independent_json_value_reads() {
        fn next_random(seed: &mut u64) -> u64 {
            *seed = seed
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            *seed
        }

        fn random_scalar(seed: &mut u64, index: usize) -> Option<Value> {
            match next_random(seed) & 3 {
                0 => None,
                1 => Some(Value::Null),
                2 => Some(if index.is_multiple_of(17) {
                    Value::from(-0.0)
                } else {
                    Value::from(((next_random(seed) >> 11) as f64) / 1_000_000.0)
                }),
                _ => Some(json!({"modNested":{"kept":index}})),
            }
        }

        fn random_inventory(seed: &mut u64, index: usize) -> Option<Value> {
            match next_random(seed) & 3 {
                0 => None,
                1 => Some(Value::Null),
                2 => {
                    let mut values = Map::new();
                    let entries = (next_random(seed) % 5) as usize;
                    for entry in 0..entries {
                        let item_id = if entry == 0 && index.is_multiple_of(3) {
                            "iron_ore".to_owned()
                        } else {
                            format!("mod-item-{index}-{entry}")
                        };
                        values.insert(
                            item_id,
                            random_scalar(seed, index + entry).unwrap_or(Value::Null),
                        );
                    }
                    Some(Value::Object(values))
                }
                _ => Some(json!(["mod", {"nested":index}])),
            }
        }

        fn expected_number(value: Option<&Value>) -> (ResidentValueKind, Option<f64>) {
            match value {
                None => (ResidentValueKind::Missing, None),
                Some(Value::Null) => (ResidentValueKind::Null, None),
                Some(Value::Number(number)) => (ResidentValueKind::Number, number.as_f64()),
                Some(_) => (ResidentValueKind::Other, None),
            }
        }

        let mut seed = 0x5eed_e1c0_1a55_0047_u64;
        let mut entities = Vec::new();
        for index in 0..257 {
            let mut entity = Map::from_iter([
                ("id".to_owned(), Value::from(format!("random-{index}"))),
                ("kind".to_owned(), Value::from("mod-entity")),
                ("planetId".to_owned(), Value::from("home")),
                (
                    "modPayload".to_owned(),
                    json!({"progress":index,"inputs":{"nested":true}}),
                ),
            ]);
            for field in EntityDynamicField::ALL {
                if let Some(value) = random_scalar(&mut seed, index + field as usize) {
                    entity.insert(field.key().to_owned(), value);
                }
            }
            if let Some(value) = random_inventory(&mut seed, index) {
                entity.insert("inputs".to_owned(), value);
            }
            if let Some(value) = random_inventory(&mut seed, index + 1_000) {
                entity.insert("outputs".to_owned(), value);
            }
            entities.push(Value::Object(entity));
        }
        let bytes = serde_json::to_vec(&entities).unwrap();
        let mut records = fixture_records();
        replace_fixture_entity_chunk(&mut records, bytes, entities.len());
        let state =
            CoreState::from_internal_records(fixture_identity(7), &records, fixture_catalog())
                .unwrap();

        let mut expected_inventory_entries = 0_u64;
        for (index, expected) in entities.iter().enumerate() {
            let object = expected.as_object().unwrap();
            for field in EntityDynamicField::ALL {
                let (expected_kind, expected_value) = expected_number(object.get(field.key()));
                let resident = state.entity_dynamic_number(index, field).unwrap();
                assert_eq!(
                    resident.kind(),
                    expected_kind,
                    "index={index} field={field:?}"
                );
                assert_eq!(
                    resident.as_f64().map(f64::to_bits),
                    expected_value.map(f64::to_bits),
                    "index={index} field={field:?}"
                );
            }
            for (side, key) in [
                (EntityInventorySide::Inputs, "inputs"),
                (EntityInventorySide::Outputs, "outputs"),
            ] {
                let view = state.entity_inventory(index, side).unwrap();
                let (expected_kind, expected_entries) = match object.get(key) {
                    None => (ResidentObjectKind::Missing, None),
                    Some(Value::Null) => (ResidentObjectKind::Null, None),
                    Some(Value::Object(entries)) => {
                        expected_inventory_entries += entries.len() as u64;
                        (ResidentObjectKind::Object, Some(entries))
                    }
                    Some(_) => (ResidentObjectKind::Other, None),
                };
                assert_eq!(
                    view.container_kind(),
                    expected_kind,
                    "index={index} side={side:?}"
                );
                assert_eq!(view.len(), expected_entries.map_or(0, Map::len));
                if let Some(entries) = expected_entries {
                    for (item_id, amount) in entries {
                        let (expected_kind, expected_value) = expected_number(Some(amount));
                        let resident = view.get(item_id).unwrap();
                        assert_eq!(resident.kind(), expected_kind);
                        assert_eq!(
                            resident.as_f64().map(f64::to_bits),
                            expected_value.map(f64::to_bits)
                        );
                    }
                }
            }
            assert_eq!(
                state.parse_entity(index).unwrap()["modPayload"],
                expected["modPayload"]
            );
        }
        assert_eq!(
            state.memory_estimate().inventory_entry_count,
            expected_inventory_entries
        );
    }

    #[test]
    fn compact_entity_descriptor_rejects_corrupt_row_topology() {
        let state = CoreState::from_internal_records(
            fixture_identity(7),
            &fixture_records(),
            fixture_catalog(),
        )
        .unwrap();
        let mut invalid = state.entity_dynamics.0.as_ref().clone();
        invalid.row_count += 1;
        assert!(invalid.validate(1).is_err());
    }

    #[test]
    fn entity_lazy_descriptor_has_exact_constant_resident_cost() {
        let rows = 80_674;
        let mut columns = EntityDynamicColumns::with_capacity(rows);
        let object = Map::new();
        for _ in 0..rows {
            columns.push_from_object(&object).unwrap();
        }
        columns.validate(rows).unwrap();
        assert_eq!(columns.inventory_entry_count(), 0);
        assert_eq!(columns.estimated_bytes(), 0);

        let mut inventory_heavy = Map::new();
        for side in ["inputs", "outputs"] {
            inventory_heavy.insert(
                side.to_owned(),
                Value::Object(Map::from_iter(
                    (0..1_024).map(|index| (format!("mod-item-{index}"), Value::from(index))),
                )),
            );
        }
        let mut one_row = EntityDynamicColumns::with_capacity(1);
        one_row.push_from_object(&inventory_heavy).unwrap();
        assert_eq!(one_row.inventory_entry_count(), 2_048);
        assert_eq!(one_row.estimated_bytes(), 0);
    }

    #[test]
    fn duplicate_record_ids_fail_closed() {
        let mut records = fixture_records();
        let key = "dsp-idle-network.internal.v1.chunked.v1.normal.chunk.entities%3A00000000";
        let bytes = serde_json::to_vec(&json!([
            {"id":"same","kind":"vein","planetId":"home","inputs":{},"outputs":{}},
            {"id":"same","kind":"vein","planetId":"home","inputs":{},"outputs":{}}
        ]))
        .unwrap();
        records.insert(key.into(), bytes.clone());
        let manifest_key = "dsp-idle-network.internal.v1.chunked.v1.normal.manifest";
        let mut manifest: Value = serde_json::from_slice(&records[manifest_key]).unwrap();
        manifest["entityCount"] = json!(2);
        manifest["chunks"][1]["count"] = json!(2);
        manifest["chunks"][1]["checksum"] = json!(fnv1a_utf8(&bytes));
        manifest["chunks"][1]["bytes"] = json!(bytes.len());
        records.insert(manifest_key.into(), serde_json::to_vec(&manifest).unwrap());
        let error = CoreState::from_internal_records(
            CoreCheckpointIdentity {
                slot: "normal-main".into(),
                generation: 1,
                root_hash: "a".repeat(64),
                revision: 7,
                state_version: 47,
                mode: "normal".into(),
                registry_fingerprint: "core".into(),
                base_primary_checksum: "12345678".into(),
            },
            &records,
            fixture_catalog(),
        )
        .unwrap_err();
        assert!(error.to_string().contains("duplicated"));
    }

    #[test]
    fn simulated_belt_patch_failures_leave_source_state_byte_exact() {
        for case in [
            "out-of-range",
            "duplicate",
            "wrong-id",
            "invalid-json",
            "non-object",
            "dynamic-mismatch",
            "hidden-dynamic-change",
            "hidden-raw-change",
        ] {
            let mut state = CoreState::from_internal_records(
                fixture_identity(7),
                &fixture_records(),
                fixture_catalog(),
            )
            .unwrap();
            let raw = state.belt_raw[0].clone();
            let patches = match case {
                "out-of-range" => vec![(1, raw)],
                "duplicate" => vec![(0, raw.clone()), (0, raw)],
                "wrong-id" => vec![(0, r#"{"id":"other"}"#.into())],
                "invalid-json" => vec![(0, "{".into())],
                "non-object" => vec![(0, "[]".into())],
                "dynamic-mismatch" => vec![(0, raw)],
                "hidden-raw-change" => vec![(
                    0,
                    r#"{"id":"belt","planetId":"home","source":"vein","target":"sink","itemId":"iron_ore","lanes":1,"tier":1,"priority":1,"progress":0,"lastFlow":0,"modPayload":{"forged":true}}"#.into(),
                )],
                "hidden-dynamic-change" => Vec::new(),
                _ => unreachable!(),
            };
            let canonical_before = state.canonical_sha256().unwrap();
            let belt_table_before = state.belt_raw.0.clone();
            let belt_dynamics_before = state.belt_dynamics.0.clone();
            let dirty_before = format!("{:?}", state.save_dirty);
            let mut envelope_before = Vec::new();
            state.write_v47_envelope(42, &mut envelope_before).unwrap();
            let mut belt_dynamics = state.belt_dynamics.0.as_ref().clone();
            if matches!(case, "dynamic-mismatch" | "hidden-dynamic-change") {
                belt_dynamics.progress[0] = 99.0;
                belt_dynamics.number_mask[0] |= 1 << BeltDynamicColumns::PROGRESS;
            }
            let belt_commit =
                crate::belts::BeltCommitBatch::forged_for_test(&state, patches, belt_dynamics);

            let error = state
                .commit_simulated_state(
                    state.base_value().clone(),
                    state.parse_entities_parallel().unwrap(),
                    belt_commit,
                    8,
                    true,
                )
                .unwrap_err();
            assert!(!error.to_string().is_empty(), "case={case}");
            assert_eq!(state.revision, 7, "case={case}");
            assert_eq!(
                state.canonical_sha256().unwrap(),
                canonical_before,
                "case={case}"
            );
            assert!(
                Arc::ptr_eq(&state.belt_raw.0, &belt_table_before),
                "case={case}"
            );
            assert!(
                Arc::ptr_eq(&state.belt_dynamics.0, &belt_dynamics_before),
                "case={case}"
            );
            assert_eq!(
                format!("{:?}", state.save_dirty),
                dirty_before,
                "case={case}"
            );
            let mut envelope_after = Vec::new();
            state.write_v47_envelope(42, &mut envelope_after).unwrap();
            assert_eq!(envelope_after, envelope_before, "case={case}");
        }
    }

    #[test]
    fn simulated_belt_patches_apply_once_and_empty_patches_keep_raw_table_shared() {
        let mut state = CoreState::from_internal_records(
            fixture_identity(7),
            &fixture_records(),
            fixture_catalog(),
        )
        .unwrap();
        let shared_before = state.belt_raw.0.clone();
        let dynamic_shared_before = state.belt_dynamics.0.clone();
        let entity_dynamic_shared_before = state.entity_dynamics.0.clone();
        let belt_commit = belt_commit_for_test(&state);
        state
            .commit_simulated_state(
                state.base_value().clone(),
                state.parse_entities_parallel().unwrap(),
                belt_commit,
                8,
                true,
            )
            .unwrap();
        assert!(Arc::ptr_eq(&state.belt_raw.0, &shared_before));
        assert!(Arc::ptr_eq(&state.belt_dynamics.0, &dynamic_shared_before));
        assert!(Arc::ptr_eq(
            &state.entity_dynamics.0,
            &entity_dynamic_shared_before
        ));

        let mut belt_dynamics = state.belt_dynamics.0.as_ref().clone();
        belt_dynamics.progress[0] = 5.0;
        belt_dynamics.number_mask[0] |= 1 << BeltDynamicColumns::PROGRESS;
        let belt_commit =
            crate::belts::BeltCommitBatch::from_dynamics_for_test(&state, belt_dynamics).unwrap();
        state
            .commit_simulated_state(
                state.base_value().clone(),
                state.parse_entities_parallel().unwrap(),
                belt_commit,
                9,
                true,
            )
            .unwrap();
        assert_eq!(state.revision, 9);
        assert_eq!(state.parse_belt(0).unwrap()["progress"].as_f64(), Some(5.0));
        assert_eq!(state.belt_dynamics.progress[0], 5.0);
        assert!(!Arc::ptr_eq(&state.belt_raw.0, &shared_before));
        assert!(Arc::ptr_eq(
            &state.entity_dynamics.0,
            &entity_dynamic_shared_before
        ));
    }

    #[test]
    fn sparse_domain_digest_matches_legacy_oracle_for_extension_inventories_and_belts() {
        let entities_a = r#"[
            {"outputs":{"mod:β":2,"iron_ore":-0.0,"ignored":null,"text":"7"},"inputs":{"新物料":3,"iron_ore":1},"id":"e-α","kind":"storage","planetId":"home","progress":-0.0,"utilization":null,"modPayload":{"z":1,"a":2}},
            {"planetId":"home","kind":"storage","id":"e-b","inputs":{"另一个":5,"mod:β":4},"outputs":{"新物料":6},"progress":null,"utilization":-0.0,"productionRate":1}
        ]"#;
        let belts_a = r#"[
            {"lastFlow":-0.0,"totalTransferred":null,"priority":1,"tier":1,"lanes":1,"itemId":"iron_ore","target":"e-b","source":"e-α","planetId":"home","id":"belt-0","modPayload":{"z":1,"a":2}},
            {"id":"belt-1","planetId":"home","source":"e-b","target":"e-α","itemId":"mod:β","lanes":1,"tier":1,"priority":1,"progress":-0.0},
            {"id":"belt-2","planetId":"home","source":"e-α","target":"e-b","itemId":"新物料","lanes":1,"tier":1,"priority":1,"progress":null,"totalTransferred":3.25,"lastFlow":4}
        ]"#;
        // Same semantic JSON with deliberately different object-key order.
        let entities_b = r#"[
            {"id":"e-α","kind":"storage","planetId":"home","inputs":{"iron_ore":1,"新物料":3},"outputs":{"text":"7","ignored":null,"iron_ore":-0.0,"mod:β":2},"modPayload":{"a":2,"z":1},"utilization":null,"progress":-0.0},
            {"productionRate":1,"utilization":-0.0,"progress":null,"outputs":{"新物料":6},"inputs":{"mod:β":4,"另一个":5},"id":"e-b","kind":"storage","planetId":"home"}
        ]"#;
        let belts_b = r#"[
            {"id":"belt-0","planetId":"home","source":"e-α","target":"e-b","itemId":"iron_ore","lanes":1,"tier":1,"priority":1,"totalTransferred":null,"lastFlow":-0.0,"modPayload":{"a":2,"z":1}},
            {"progress":-0.0,"priority":1,"tier":1,"lanes":1,"itemId":"mod:β","target":"e-α","source":"e-b","planetId":"home","id":"belt-1"},
            {"lastFlow":4,"totalTransferred":3.25,"progress":null,"priority":1,"tier":1,"lanes":1,"itemId":"新物料","target":"e-b","source":"e-α","planetId":"home","id":"belt-2"}
        ]"#;

        let load = |entities, belts| {
            CoreState::from_internal_records(
                fixture_identity(7),
                &fixture_records_with_raw_entities_and_belts(entities, 2, belts, 3),
                fixture_catalog(),
            )
            .unwrap()
        };
        let state_a = load(entities_a, belts_a);
        let state_b = load(entities_b, belts_b);

        for state in [&state_a, &state_b] {
            let parsed_entities = state.parse_entities_parallel().unwrap();
            let parsed_belts = state.parse_belts_parallel().unwrap();
            let bundled = state
                .canonical_digest_bundle_with_parsed(Some(&parsed_entities), Some(&parsed_belts))
                .unwrap();
            let legacy_domain = legacy_domain_sha256(state).unwrap();
            assert_eq!(bundled.domain_sha256, legacy_domain);
            assert_eq!(state.domain_sha256().unwrap(), legacy_domain);
            assert_eq!(bundled.canonical_sha256, state.canonical_sha256().unwrap());
            assert_eq!(
                bundled.canonical_components,
                state.canonical_components().unwrap()
            );
            assert_eq!(bundled.canonical_fields, state.canonical_fields().unwrap());

            let mut sparse_symbols = DomainSymbolOrder::new(&state.symbols);
            let mut scratch_hasher = Sha256::new();
            for (index, entity) in parsed_entities.iter().enumerate() {
                state
                    .update_domain_entity(&mut scratch_hasher, &mut sparse_symbols, index, entity)
                    .unwrap();
            }
            // `mod:β` and `新物料` already exist in the resident belt item
            // symbols; only the inventory-exclusive ID needs scratch storage.
            assert_eq!(state.symbols.values.len(), 7);
            assert_eq!(sparse_symbols.additional_len(), 1);
            assert_eq!(sparse_symbols.additional_text_bytes(), "另一个".len());
            assert!(
                state.symbols.estimated_bytes() > sparse_symbols.additional_text_bytes() as u64
            );
        }

        assert_eq!(
            state_a.canonical_sha256().unwrap(),
            state_b.canonical_sha256().unwrap()
        );
        assert_eq!(
            state_a.domain_sha256().unwrap(),
            state_b.domain_sha256().unwrap()
        );
        assert_eq!(
            state_a.canonical_components().unwrap(),
            state_b.canonical_components().unwrap()
        );
        assert_eq!(
            state_a.canonical_fields().unwrap(),
            state_b.canonical_fields().unwrap()
        );

        // An internally stale compact column must not change the historical
        // raw-record digest. The allocation-free common path detects the bit
        // mismatch and falls back to streaming one raw row at a time.
        let mut stale_columns = state_a.clone();
        stale_columns.belt_dynamics.progress[0] = 99.0;
        let parsed_entities = stale_columns.parse_entities_parallel().unwrap();
        let parsed_belts = stale_columns.parse_belts_parallel().unwrap();
        let fallback = stale_columns
            .canonical_digest_bundle_with_parsed(Some(&parsed_entities), Some(&parsed_belts))
            .unwrap();
        assert_eq!(
            fallback.domain_sha256,
            legacy_domain_sha256(&stale_columns).unwrap()
        );
    }

    #[test]
    fn digest_path_preserves_non_finite_json_rejection() {
        let records = fixture_records_with_entity_json(
            r#"[{"id":"vein","kind":"vein","planetId":"home","resourceId":"iron_ore","inputs":{"iron_ore":1e400},"outputs":{}}]"#,
            1,
        );
        let error =
            CoreState::from_internal_records(fixture_identity(7), &records, fixture_catalog())
                .unwrap_err();
        assert!(
            error.to_string().contains("decode native core entity")
                || error.to_string().contains("number out of range")
        );
    }

    #[test]
    fn simulated_entity_commit_rebuilds_validated_columns_with_full_encode() {
        let mut state = CoreState::from_internal_records(
            fixture_identity(7),
            &fixture_records(),
            fixture_catalog(),
        )
        .unwrap();
        let original_columns = state.entity_dynamics.0.clone();
        let mut entities = state.parse_entities_parallel().unwrap();
        let entity = entities[0].as_object_mut().unwrap();
        entity.insert("productionRate".into(), Value::from(-0.0));
        entity.insert("utilization".into(), Value::Null);
        entity.remove("progress");
        entity.insert("powerFactor".into(), json!({"mod":"kept"}));
        entity.insert(
            "inputs".into(),
            json!({"new-mod-item":-0.0,"malformed":null}),
        );
        entity.insert("modPayload".into(), json!({"nested":{"kept":true}}));
        let belt_commit = belt_commit_for_test(&state);
        state
            .commit_simulated_state(state.base_value().clone(), entities, belt_commit, 8, true)
            .unwrap();

        if !sync_record_drop_enabled() {
            assert_eq!(state.parsed_entity_runtime_rows_for_test(), 1);
        }
        assert!(!Arc::ptr_eq(&state.entity_dynamics.0, &original_columns));
        assert_eq!(
            state
                .entity_dynamic_number(0, EntityDynamicField::ProductionRate)
                .unwrap()
                .as_f64()
                .unwrap()
                .to_bits(),
            (-0.0_f64).to_bits()
        );
        assert_eq!(
            state
                .entity_dynamic_number(0, EntityDynamicField::Utilization)
                .unwrap()
                .kind(),
            ResidentValueKind::Null
        );
        assert_eq!(
            state
                .entity_dynamic_number(0, EntityDynamicField::Progress)
                .unwrap()
                .kind(),
            ResidentValueKind::Missing
        );
        assert_eq!(
            state
                .entity_dynamic_number(0, EntityDynamicField::PowerFactor)
                .unwrap()
                .kind(),
            ResidentValueKind::Other
        );
        let inputs = state
            .entity_inventory(0, EntityInventorySide::Inputs)
            .unwrap();
        assert_eq!(inputs.container_kind(), ResidentObjectKind::Object);
        assert_eq!(
            inputs
                .get("new-mod-item")
                .unwrap()
                .as_f64()
                .unwrap()
                .to_bits(),
            (-0.0_f64).to_bits()
        );
        assert_eq!(
            inputs.get("malformed").unwrap().kind(),
            ResidentValueKind::Null
        );
        assert_eq!(
            state.parse_entity(0).unwrap()["modPayload"]["nested"]["kept"],
            true
        );
        assert_eq!(
            state.entity_raw_writeback_diagnostics(),
            EntityRawWritebackDiagnostics {
                full_encoded_rows: 1,
                shared_rows: 0,
                changed_rows: 1,
            }
        );

        let shared_after_change = state.entity_dynamics.0.clone();
        let belt_commit = belt_commit_for_test(&state);
        state
            .commit_simulated_state(
                state.base_value().clone(),
                state.parse_entities_parallel().unwrap(),
                belt_commit,
                9,
                false,
            )
            .unwrap();
        assert!(Arc::ptr_eq(&state.entity_dynamics.0, &shared_after_change));
        assert_eq!(
            state.entity_raw_writeback_diagnostics(),
            EntityRawWritebackDiagnostics {
                full_encoded_rows: 1,
                shared_rows: 1,
                changed_rows: 0,
            }
        );
    }

    #[test]
    fn parsed_entity_runtime_is_one_shot_counted_and_invalidated_by_raw_changes() {
        let mut state = CoreState::from_internal_records(
            fixture_identity(7),
            &fixture_records(),
            fixture_catalog(),
        )
        .unwrap();
        let values = state.parse_entities_parallel().unwrap();
        let expected = values.clone();
        let moved_pointer = values.as_ptr();
        state.install_parsed_entity_runtime(values);
        let memory_with_cache = state.memory_estimate().estimated_runtime_bytes;

        let moved = state.take_entities_for_simulation().unwrap();
        assert_eq!(moved.as_ptr(), moved_pointer);
        assert_eq!(moved, expected);
        assert_eq!(state.parsed_entity_runtime_rows_for_test(), 0);
        assert!(state.memory_estimate().estimated_runtime_bytes < memory_with_cache);

        state.install_parsed_entity_runtime(moved);
        let mut transactional_clone = state.clone();
        let original_raw = state.entity_raw[0].clone();
        transactional_clone.replace_entity_raw(0, original_raw.clone());
        assert_eq!(state.parsed_entity_runtime_rows_for_test(), 0);
        assert_eq!(transactional_clone.parsed_entity_runtime_rows_for_test(), 0);
        assert!(Arc::ptr_eq(&state.entity_raw[0], &original_raw));
    }

    #[test]
    fn byte_equal_full_encode_reuses_raw_table_without_entity_dirty() {
        let mut state = CoreState::from_internal_records(
            fixture_identity(7),
            &fixture_records(),
            fixture_catalog(),
        )
        .unwrap();
        let raw_table_before = state.entity_raw.0.clone();
        let row_before = state.entity_raw[0].clone();
        let dirty_before = format!("{:?}", state.save_dirty);
        let belt_commit = belt_commit_for_test(&state);

        state
            .commit_simulated_state(
                state.base_value().clone(),
                state.parse_entities_parallel().unwrap(),
                belt_commit,
                8,
                false,
            )
            .unwrap();

        assert!(Arc::ptr_eq(&state.entity_raw.0, &raw_table_before));
        assert!(Arc::ptr_eq(&state.entity_raw[0], &row_before));
        assert_eq!(format!("{:?}", state.save_dirty), dirty_before);
        assert_eq!(
            state.entity_raw_writeback_diagnostics(),
            EntityRawWritebackDiagnostics {
                full_encoded_rows: 1,
                shared_rows: 1,
                changed_rows: 0,
            }
        );
    }

    #[test]
    fn full_entity_writeback_preserves_values_and_collapses_duplicate_keys() {
        let records = fixture_records_with_entity_json(
            r#"[
              {"id":"vein","kind":"vein","planetId":"home","resourceId":"iron_ore","minerCount":2,"progress":1e0,"utilization":0,"productionRate":0,"routingCursor":0,"inputs":{},"outputs":{"iron_ore":3},"modPayload" : { "rawSpacing" : [ 1, 2 ] }},
              {"id":"machine-1","kind":"machine","planetId":"home","buildingId":"mining_machine","pro\u0067ress":2e0,"utilization":null,"productionRate":-0.0,"routingCursor":0,"inputs":{"iron_ore":1},"outputs":{},"modPayload" : { "rawSpacing" : [ 3, 4 ] }},
              {"id":"terminal-1","kind":"station","planetId":"home","buildingId":"orbital_cargo_terminal","progress":0,"stationProgress":1,"stationLastTransfer":null,"inputs":{},"outputs":{},"stationSlots":[{"itemId":"iron_ore","minimumLoad":0.5}],"modPayload":{"nested":{"keep":true}}},
              {"id":"dup-1","kind":"machine","planetId":"home","progress":1,"pro\u0067ress":2,"utilization":0,"productionRate":0,"inputs":null,"outputs":{},"modPayload":{"unknown":[1,{"keep":true}]}}
            ]"#,
            4,
        );
        let mut state =
            CoreState::from_internal_records(fixture_identity(7), &records, fixture_catalog())
                .unwrap();
        let previous_raw = state.entity_raw.iter().cloned().collect::<Vec<_>>();
        let mut entities = state.parse_entities_parallel().unwrap();
        entities[1]["progress"] = Value::from(-0.0);
        entities[1]["inputs"]["iron_ore"] = Value::from(5);
        entities[2]["stationSlots"][0]["minimumLoad"] = Value::from(0.75);
        entities[2]["stationLastSupplyPeerBySlot"] = json!(["peer-a", null, "peer-c"]);
        let expected = entities.clone();
        let expected_raw = expected
            .iter()
            .map(|entity| serde_json::to_string(entity).unwrap())
            .collect::<Vec<_>>();
        let expected_shared = previous_raw
            .iter()
            .zip(&expected_raw)
            .filter(|(previous, expected)| previous.as_ref() == expected.as_str())
            .count();
        let belt_commit = belt_commit_for_test(&state);

        state
            .commit_simulated_state(state.base_value().clone(), entities, belt_commit, 8, true)
            .unwrap();

        assert_eq!(
            state.entity_raw_writeback_diagnostics(),
            EntityRawWritebackDiagnostics {
                full_encoded_rows: 4,
                shared_rows: expected_shared,
                changed_rows: 4 - expected_shared,
            }
        );
        for (index, ((actual, previous), expected)) in state
            .entity_raw
            .iter()
            .zip(&previous_raw)
            .zip(&expected_raw)
            .enumerate()
        {
            assert_eq!(actual.as_ref(), expected, "index={index}");
            assert_eq!(
                Arc::ptr_eq(actual, previous),
                previous.as_ref() == expected.as_str(),
                "index={index}"
            );
        }
        let actual = state.parse_entities_parallel().unwrap();
        assert!(json_bitwise_eq(
            &Value::Array(actual.clone()),
            &Value::Array(expected)
        ));
        assert_eq!(actual[1]["modPayload"]["rawSpacing"], json!([3, 4]));
        assert_eq!(
            actual[1]["progress"].as_f64().unwrap().to_bits(),
            (-0.0_f64).to_bits()
        );
        assert_eq!(
            actual[2]["stationLastSupplyPeerBySlot"],
            json!(["peer-a", null, "peer-c"])
        );
        assert!(state.entity_raw[3].contains(r#""progress":2"#));
        assert!(!state.entity_raw[3].contains(r#"pro\u0067ress"#));
        assert_eq!(state.parse_entity(0).unwrap()["id"], "vein");
        assert_eq!(state.parse_entity(2).unwrap()["id"], "terminal-1");
    }

    #[test]
    fn invalid_simulated_entity_full_encode_is_atomic() {
        for invalid in [json!(["not-an-object"]), json!({"id":"wrong-identity"})] {
            let mut state = CoreState::from_internal_records(
                fixture_identity(7),
                &fixture_records(),
                fixture_catalog(),
            )
            .unwrap();
            let mut entities = state.parse_entities_parallel().unwrap();
            entities[0] = invalid;
            let raw_table_before = state.entity_raw.0.clone();
            let dynamic_before = state.entity_dynamics.0.clone();
            let dirty_before = format!("{:?}", state.save_dirty);
            let belt_commit = belt_commit_for_test(&state);

            let error = state
                .commit_simulated_state(state.base_value().clone(), entities, belt_commit, 8, true)
                .unwrap_err();

            assert!(!error.to_string().is_empty());
            assert_eq!(state.revision, 7);
            assert!(Arc::ptr_eq(&state.entity_raw.0, &raw_table_before));
            assert!(Arc::ptr_eq(&state.entity_dynamics.0, &dynamic_before));
            assert_eq!(format!("{:?}", state.save_dirty), dirty_before);
            assert_eq!(
                state.entity_raw_writeback_diagnostics(),
                EntityRawWritebackDiagnostics::default()
            );
        }
    }

    #[test]
    fn sealed_belt_commit_preserves_missing_null_mod_and_negative_zero_semantics() {
        let records = fixture_records_with_belts(vec![
            json!({
                "id":"belt-negative-zero",
                "planetId":"home",
                "source":"vein",
                "target":"sink",
                "itemId":"iron_ore",
                "lanes":1,
                "tier":1,
                "priority":1,
                "progress":-0.0,
                "totalTransferred":null,
                "congestion":"mod-value",
                "modPayload":{"large":[1,2,3]}
            }),
            json!({
                "id":"belt-stable",
                "planetId":"home",
                "source":"vein",
                "target":"sink",
                "itemId":"iron_ore",
                "lanes":1,
                "tier":1,
                "priority":1,
                "progress":0,
                "congestion":0,
                "lastFlow":0,
                "modPayload":{"preserved":true}
            }),
        ]);
        let mut state =
            CoreState::from_internal_records(fixture_identity(7), &records, fixture_catalog())
                .unwrap();
        let stable_raw = state.belt_raw[1].clone();
        let belt_commit = crate::belts::BeltCommitBatch::from_dynamics_for_test(
            &state,
            state.belt_dynamics.0.as_ref().clone(),
        )
        .unwrap();
        assert_eq!(belt_commit.patch_count(), 2);

        state
            .commit_simulated_state(
                state.base_value().clone(),
                state.parse_entities_parallel().unwrap(),
                belt_commit,
                8,
                true,
            )
            .unwrap();

        let first = state.parse_belt(0).unwrap();
        assert_eq!(
            first["progress"].as_f64().unwrap().to_bits(),
            (-0.0_f64).to_bits()
        );
        assert!(first["totalTransferred"].is_null());
        assert_eq!(first["congestion"], 0.0);
        assert_eq!(first["lastFlow"], 0.0);
        assert_eq!(first["modPayload"]["large"], json!([1, 2, 3]));
        assert!(Arc::ptr_eq(&state.belt_raw[1], &stable_raw));
        assert_eq!(
            state.parse_belt(1).unwrap()["modPayload"]["preserved"],
            true
        );
    }

    #[test]
    fn sealed_belt_commit_keeps_sparse_delta_and_historical_dense_full_encode() {
        let belts = (0..6)
            .map(|index| {
                json!({
                    "id":format!("belt-{index}"),
                    "planetId":"home",
                    "source":"vein",
                    "target":"sink",
                    "itemId":"iron_ore",
                    "lanes":1,
                    "tier":1,
                    "priority":1,
                    "progress":0,
                    "congestion":0,
                    "lastFlow":0,
                    "modPayload":{"row":index}
                })
            })
            .collect::<Vec<_>>();
        let records = fixture_records_with_belts(belts);

        for (changed_rows, expected_patches) in [(vec![1_usize], 1_usize), (vec![0, 2, 4], 6)] {
            let mut state =
                CoreState::from_internal_records(fixture_identity(7), &records, fixture_catalog())
                    .unwrap();
            let mut dynamics = state.belt_dynamics.0.as_ref().clone();
            for &index in &changed_rows {
                dynamics.progress[index] = index as f64 + 0.5;
            }
            let belt_commit =
                crate::belts::BeltCommitBatch::from_dynamics_for_test(&state, dynamics).unwrap();
            assert_eq!(belt_commit.patch_count(), expected_patches);

            state
                .commit_simulated_state(
                    state.base_value().clone(),
                    state.parse_entities_parallel().unwrap(),
                    belt_commit,
                    8,
                    true,
                )
                .unwrap();

            for index in 0..6 {
                let expected = if changed_rows.contains(&index) {
                    index as f64 + 0.5
                } else {
                    0.0
                };
                assert_eq!(
                    state.parse_belt(index).unwrap()["progress"].as_f64(),
                    Some(expected),
                    "index={index} changed_rows={changed_rows:?}"
                );
                assert_eq!(state.parse_belt(index).unwrap()["modPayload"]["row"], index);
            }
        }
    }

    #[test]
    fn sparse_touched_belt_writeback_checks_only_evidence_and_preserves_raw_semantics() {
        let belts = (0..300)
            .map(|index| {
                json!({
                    "id":format!("belt-{index}"),
                    "planetId":"home",
                    "source":"vein",
                    "target":"sink",
                    "itemId":"iron_ore",
                    "lanes":1,
                    "tier":1,
                    "priority":1,
                    "progress":if index == 17 { -0.0 } else { 0.0 },
                    "totalTransferred":index,
                    "congestion":0,
                    "lastFlow":if index == 17 { -0.0 } else { index as f64 / 10.0 },
                    "modPayload":{"opaque":format!("模组-{index}"),"raw":[index,255,256]}
                })
            })
            .collect::<Vec<_>>();
        let records = fixture_records_with_belts(belts);
        let state =
            CoreState::from_internal_records(fixture_identity(7), &records, fixture_catalog())
                .unwrap();
        let untouched_raw = state.belt_raw[17].clone();

        let skipped = crate::belts::BeltRuntime::from_dynamics_for_test(
            &state,
            state.belt_dynamics.0.as_ref().clone(),
        )
        .unwrap();
        let (skipped_batch, skipped_flow, skipped_diagnostics) = skipped
            .into_patches(&state, crate::belts::BeltFlowRequirement::NotRequired)
            .unwrap();
        assert_eq!(skipped_batch.patch_count(), 0);
        assert!(matches!(
            skipped_flow,
            crate::belts::PreparedBeltFlow::NotRequired
        ));
        assert_eq!(skipped_diagnostics.write_back_flow_checks, 0);
        assert_eq!(skipped_diagnostics.write_back_evidence_checks, 0);

        let unchanged = crate::belts::BeltRuntime::from_dynamics_for_test(
            &state,
            state.belt_dynamics.0.as_ref().clone(),
        )
        .unwrap();
        let (unchanged_batch, unchanged_flow, unchanged_diagnostics) = unchanged
            .into_patches(
                &state,
                crate::belts::BeltFlowRequirement::ExactOriginalOrder,
            )
            .unwrap();
        assert_eq!(unchanged_batch.patch_count(), 0);
        assert_eq!(unchanged_diagnostics.write_back_flow_checks, 300);
        assert_eq!(unchanged_diagnostics.write_back_evidence_checks, 0);
        let expected_unchanged_flow = state
            .belt_dynamics
            .last_flow
            .iter()
            .fold(0.0, |sum, value| sum + value.max(0.0));
        let crate::belts::PreparedBeltFlow::Exact(unchanged_flow) = unchanged_flow else {
            panic!("exact belt flow was not prepared");
        };
        assert_eq!(
            unchanged_flow.flow.to_bits(),
            expected_unchanged_flow.to_bits()
        );

        let mut dynamics = state.belt_dynamics.0.as_ref().clone();
        dynamics.congestion[1] = 0.5;
        dynamics.progress[255] = -0.0;
        dynamics.progress[256] = 12.5;
        dynamics.total_transferred[256] += 7.0;
        dynamics.last_flow[256] = 42.25;
        let expected_flow = dynamics
            .last_flow
            .iter()
            .fold(0.0, |sum, value| sum + value.max(0.0));
        let runtime = crate::belts::BeltRuntime::from_dynamics_for_test(&state, dynamics).unwrap();
        let (batch, aggregate, diagnostics) = runtime
            .into_patches(
                &state,
                crate::belts::BeltFlowRequirement::ExactOriginalOrder,
            )
            .unwrap();
        assert_eq!(batch.patch_indices(), [1, 255, 256]);
        assert_eq!(diagnostics.changed_belt_records, 3);
        assert_eq!(diagnostics.write_back_patch_records, 3);
        assert_eq!(diagnostics.write_back_flow_checks, 300);
        assert_eq!(diagnostics.write_back_evidence_checks, 3);
        let crate::belts::PreparedBeltFlow::Exact(aggregate) = aggregate else {
            panic!("exact belt flow was not prepared");
        };
        assert_eq!(aggregate.flow.to_bits(), expected_flow.to_bits());

        let mut committed = state.clone();
        committed
            .commit_simulated_state(
                committed.base_value().clone(),
                committed.parse_entities_parallel().unwrap(),
                batch,
                8,
                true,
            )
            .unwrap();
        assert_eq!(
            committed.parse_belt(255).unwrap()["progress"]
                .as_f64()
                .unwrap()
                .to_bits(),
            (-0.0_f64).to_bits()
        );
        assert_eq!(
            committed.parse_belt(256).unwrap()["totalTransferred"],
            263.0
        );
        assert_eq!(
            committed.parse_belt(256).unwrap()["modPayload"]["opaque"],
            "模组-256"
        );
        assert!(Arc::ptr_eq(&committed.belt_raw[17], &untouched_raw));
        assert_eq!(
            committed.parse_belt(17).unwrap()["progress"]
                .as_f64()
                .unwrap()
                .to_bits(),
            (-0.0_f64).to_bits()
        );
        assert_eq!(
            committed.parse_belt(17).unwrap()["lastFlow"]
                .as_f64()
                .unwrap()
                .to_bits(),
            (-0.0_f64).to_bits()
        );
    }

    #[test]
    fn sparse_belt_revision_clones_and_validates_only_bounded_pages_at_every_worker_limit() {
        let belt_count = 4_097;
        let belts = (0..belt_count)
            .map(|index| {
                json!({
                    "id":format!("belt-{index}"),
                    "planetId":"home",
                    "source":"vein",
                    "target":"sink",
                    "itemId":"iron_ore",
                    "lanes":1,
                    "tier":1,
                    "priority":1,
                    "progress":if index == 7 { -0.0 } else { 0.0 },
                    "totalTransferred":index,
                    "congestion":0,
                    "lastFlow":0,
                    "modPayload":{"kept":index}
                })
            })
            .collect::<Vec<_>>();
        let records = fixture_records_with_belts(belts);
        let source =
            CoreState::from_internal_records(fixture_identity(7), &records, fixture_catalog())
                .unwrap();
        let source_hash = source.canonical_sha256().unwrap();
        let source_raw = source.belt_raw[3_000].clone();
        let mut expected = None::<(String, Vec<u8>)>;

        for workers in [1, 2, 4, 8] {
            let mut dynamics = source.belt_dynamics.0.as_ref().clone();
            dynamics.progress[7] = 12.5;
            dynamics.congestion[8] = 0.75;
            dynamics.total_transferred[9] += 3.0;
            dynamics.last_flow[9] = 3.0;

            // All three changed rows reside in one 1,024-row page. No column
            // may copy a factory-sized Vec, and untouched pages stay shared.
            assert_eq!(
                dynamics
                    .progress
                    .changed_page_count_from(&source.belt_dynamics.progress),
                1
            );
            assert_eq!(
                dynamics
                    .congestion
                    .changed_page_count_from(&source.belt_dynamics.congestion),
                1
            );
            assert_eq!(
                dynamics
                    .total_transferred
                    .changed_page_count_from(&source.belt_dynamics.total_transferred),
                1
            );
            assert_eq!(
                dynamics
                    .last_flow
                    .changed_page_count_from(&source.belt_dynamics.last_flow),
                1
            );

            let runtime =
                crate::belts::BeltRuntime::from_dynamics_for_test(&source, dynamics).unwrap();
            let (batch, flow, diagnostics) = runtime
                .into_patches_with_worker_count_for_test(
                    &source,
                    workers,
                    crate::belts::BeltFlowRequirement::NotRequired,
                )
                .unwrap();
            assert!(matches!(flow, crate::belts::PreparedBeltFlow::NotRequired));
            assert_eq!(batch.patch_indices(), [7, 8, 9]);
            assert_eq!(diagnostics.write_back_evidence_checks, 3);
            assert_eq!(diagnostics.dynamic_cow_pages, 4);
            assert_eq!(diagnostics.mask_cow_pages, 1);
            assert_eq!(diagnostics.dirty_validation_rows, BELT_DYNAMIC_PAGE_ROWS);
            assert!(diagnostics.dirty_validation_rows < belt_count);

            let mut committed = source.clone();
            committed
                .commit_simulated_state(
                    committed.base_value().clone(),
                    committed.parse_entities_parallel().unwrap(),
                    batch,
                    8,
                    true,
                )
                .unwrap();
            assert!(Arc::ptr_eq(&committed.belt_raw[3_000], &source_raw));
            let hash = committed.canonical_sha256().unwrap();
            let mut bytes = Vec::new();
            committed.write_v47_envelope(123, &mut bytes).unwrap();
            if let Some((expected_hash, expected_bytes)) = &expected {
                assert_eq!(&hash, expected_hash, "worker limit {workers}");
                assert_eq!(&bytes, expected_bytes, "worker limit {workers}");
            } else {
                expected = Some((hash, bytes));
            }
            assert_eq!(source.canonical_sha256().unwrap(), source_hash);
            assert!(Arc::ptr_eq(&source.belt_raw[3_000], &source_raw));
        }
    }

    #[test]
    fn dense_touched_writeback_is_bitwise_equal_at_one_two_four_and_eight_workers() {
        let belt_count = crate::deterministic_runtime::PARALLEL_MIN_ITEMS + 257;
        let belts = (0..belt_count)
            .map(|index| {
                json!({
                    "id":format!("belt-{index}"),
                    "planetId":"home",
                    "source":"vein",
                    "target":"sink",
                    "itemId":"iron_ore",
                    "lanes":1,
                    "tier":1,
                    "priority":1,
                    "progress":0,
                    "totalTransferred":index,
                    "congestion":0,
                    "lastFlow":0,
                    "modPayload":{"row":index}
                })
            })
            .collect::<Vec<_>>();
        let records = fixture_records_with_belts(belts);
        let source =
            CoreState::from_internal_records(fixture_identity(7), &records, fixture_catalog())
                .unwrap();
        let changed_count = belt_count / 3 + 1;
        let run = |workers, flow_requirement| {
            let mut state = source.clone();
            let mut dynamics = state.belt_dynamics.0.as_ref().clone();
            for index in 0..changed_count {
                dynamics.progress[index] = index as f64 + 0.25;
                if index % 3 == 0 {
                    dynamics.total_transferred[index] += 1.0;
                }
            }
            let runtime =
                crate::belts::BeltRuntime::from_dynamics_for_test(&state, dynamics).unwrap();
            let (batch, aggregate, diagnostics) = runtime
                .into_patches_with_worker_count_for_test(&state, workers, flow_requirement)
                .unwrap();
            assert_eq!(batch.patch_count(), belt_count);
            assert_eq!(diagnostics.changed_belt_records, changed_count);
            assert_eq!(diagnostics.write_back_evidence_checks, changed_count);
            state
                .commit_simulated_state(
                    state.base_value().clone(),
                    state.parse_entities_parallel().unwrap(),
                    batch,
                    8,
                    true,
                )
                .unwrap();
            let aggregate_bits = match aggregate {
                crate::belts::PreparedBeltFlow::Exact(aggregate) => {
                    Some((aggregate.capacity.to_bits(), aggregate.flow.to_bits()))
                }
                crate::belts::PreparedBeltFlow::NotRequired => None,
            };
            (
                state.canonical_sha256().unwrap(),
                aggregate_bits,
                diagnostics.write_back_workers,
                diagnostics.write_back_flow_checks,
            )
        };
        let expected = run(1, crate::belts::BeltFlowRequirement::ExactOriginalOrder);
        assert_eq!(expected.2, 1);
        assert!(expected.1.is_some());
        assert_eq!(expected.3, belt_count);
        for workers in [2, 4, 8] {
            let actual = run(
                workers,
                crate::belts::BeltFlowRequirement::ExactOriginalOrder,
            );
            assert_eq!(actual.0, expected.0, "workers={workers}");
            assert_eq!(actual.1, expected.1, "workers={workers}");
            assert_eq!(actual.2, workers, "workers={workers}");
            assert_eq!(actual.3, belt_count, "workers={workers}");
        }

        let skipped = run(1, crate::belts::BeltFlowRequirement::NotRequired);
        assert_eq!(skipped.0, expected.0);
        assert_eq!(skipped.1, None);
        assert_eq!(skipped.3, 0);
        for workers in [2, 4, 8] {
            let actual = run(workers, crate::belts::BeltFlowRequirement::NotRequired);
            assert_eq!(actual.0, skipped.0, "skipped workers={workers}");
            assert_eq!(actual.1, None, "skipped workers={workers}");
            assert_eq!(actual.2, workers, "skipped workers={workers}");
            assert_eq!(actual.3, 0, "skipped workers={workers}");
        }
    }

    #[test]
    fn required_history_boundary_rejects_an_explicitly_skipped_belt_flow_atomically() {
        let state = CoreState::from_internal_records(
            fixture_identity(7),
            &fixture_records(),
            fixture_catalog(),
        )
        .unwrap();
        let state_hash = state.canonical_sha256().unwrap();
        let mut base = state.base_value().clone();
        base.insert("elapsedSeconds".to_owned(), Value::from(10.0));
        base.insert("historyRecordedAt".to_owned(), Value::from(9.0));
        base.insert(
            "productionHistory".to_owned(),
            Value::Array(vec![json!({"elapsedSeconds":9})]),
        );
        let base_before = serde_json::to_vec(&base).unwrap();
        let entities = state.parse_entities_parallel().unwrap();

        let error = state
            .record_production_history_with_records(
                &mut base,
                &entities,
                Some(crate::belts::PreparedBeltFlow::NotRequired),
            )
            .unwrap_err();
        assert!(error.to_string().contains("belt flow was skipped"));
        assert_eq!(serde_json::to_vec(&base).unwrap(), base_before);
        assert_eq!(state.canonical_sha256().unwrap(), state_hash);
    }

    #[test]
    fn belt_runtime_and_commit_seals_reject_stale_sources_and_unmarked_totals() {
        let mut state = CoreState::from_internal_records(
            fixture_identity(7),
            &fixture_records(),
            fixture_catalog(),
        )
        .unwrap();
        let runtime = crate::belts::BeltRuntime::from_dynamics_for_test(
            &state,
            state.belt_dynamics.0.as_ref().clone(),
        )
        .unwrap();
        state.belt_raw = state.belt_raw.0.as_ref().clone().into();
        assert!(
            runtime
                .into_patches(
                    &state,
                    crate::belts::BeltFlowRequirement::ExactOriginalOrder,
                )
                .is_err()
        );

        let belt_commit = crate::belts::BeltCommitBatch::unchanged_for_test(&state);
        state.belts = state.belts.0.as_ref().clone().into();
        let hash_before = state.canonical_sha256().unwrap();
        let dirty_before = format!("{:?}", state.save_dirty);
        let error = state
            .commit_simulated_state(
                state.base_value().clone(),
                state.parse_entities_parallel().unwrap(),
                belt_commit,
                8,
                true,
            )
            .unwrap_err();
        assert!(error.to_string().contains("seal"));
        assert_eq!(state.revision, 7);
        assert_eq!(state.canonical_sha256().unwrap(), hash_before);
        assert_eq!(format!("{:?}", state.save_dirty), dirty_before);

        let state = CoreState::from_internal_records(
            fixture_identity(7),
            &fixture_records(),
            fixture_catalog(),
        )
        .unwrap();
        let mut dynamics = state.belt_dynamics.0.as_ref().clone();
        dynamics.total_transferred[0] = 1.0;
        dynamics.number_mask[0] |= 1 << BeltDynamicColumns::TOTAL_TRANSFERRED;
        let mut runtime =
            crate::belts::BeltRuntime::from_dynamics_for_test(&state, dynamics).unwrap();
        runtime.clear_total_dirty_for_test(0);
        let hash_before = state.canonical_sha256().unwrap();
        let dirty_before = format!("{:?}", state.save_dirty);
        assert!(
            runtime
                .into_patches(
                    &state,
                    crate::belts::BeltFlowRequirement::ExactOriginalOrder,
                )
                .is_err()
        );
        assert_eq!(state.revision, 7);
        assert_eq!(state.canonical_sha256().unwrap(), hash_before);
        assert_eq!(format!("{:?}", state.save_dirty), dirty_before);
    }

    #[test]
    fn belt_runtime_column_topology_mismatch_fails_without_panicking() {
        for extra_row in [false, true] {
            let mut malformed = CoreState::from_internal_records(
                fixture_identity(7),
                &fixture_records(),
                fixture_catalog(),
            )
            .unwrap();
            if extra_row {
                let duplicate = malformed.belt_raw[0].clone();
                malformed.belt_raw.push(duplicate);
            } else {
                malformed.belt_raw.pop();
            }
            let error = malformed.validate_belt_runtime_topology().unwrap_err();
            assert!(error.to_string().contains("topology"));

            // Even a seal created from the same internally inconsistent Arc
            // set must not let commit reach patch indexing or publish a new
            // revision.
            let belt_commit = crate::belts::BeltCommitBatch::unchanged_for_test(&malformed);
            let entities = malformed.parse_entities_parallel().unwrap();
            let error = malformed
                .commit_simulated_state(
                    malformed.base_value().clone(),
                    entities,
                    belt_commit,
                    8,
                    false,
                )
                .unwrap_err();
            assert!(error.to_string().contains("topology"));
            assert_eq!(malformed.revision, 7);
        }

        let state = CoreState::from_internal_records(
            fixture_identity(7),
            &fixture_records(),
            fixture_catalog(),
        )
        .unwrap();
        let source_hash = state.canonical_sha256().unwrap();
        let source_dirty = format!("{:?}", state.save_dirty);
        for column in [
            "progress",
            "totalTransferred",
            "congestion",
            "lastFlow",
            "totalDirty",
        ] {
            let mut runtime = crate::belts::BeltRuntime::from_dynamics_for_test(
                &state,
                state.belt_dynamics.0.as_ref().clone(),
            )
            .unwrap();
            runtime.truncate_column_for_test(column);
            let error = runtime
                .into_patches(
                    &state,
                    crate::belts::BeltFlowRequirement::ExactOriginalOrder,
                )
                .unwrap_err();
            assert!(error.to_string().contains("topology"), "column={column}");
            assert_eq!(state.canonical_sha256().unwrap(), source_hash);
            assert_eq!(format!("{:?}", state.save_dirty), source_dirty);
        }

        let mut runtime = crate::belts::BeltRuntime::from_dynamics_for_test(
            &state,
            state.belt_dynamics.0.as_ref().clone(),
        )
        .unwrap();
        runtime
            .record_touched_for_test(state.belt_raw.len())
            .unwrap();
        let error = runtime
            .into_patches(
                &state,
                crate::belts::BeltFlowRequirement::ExactOriginalOrder,
            )
            .unwrap_err();
        assert!(error.to_string().contains("outside"));
        assert_eq!(state.canonical_sha256().unwrap(), source_hash);
        assert_eq!(format!("{:?}", state.save_dirty), source_dirty);
    }

    #[test]
    fn resident_dynamic_columns_refresh_after_command_topology_and_checkpoint_reload() {
        let mut state = CoreState::from_internal_records(
            fixture_identity(7),
            &fixture_records(),
            fixture_catalog(),
        )
        .unwrap();
        let result = state
            .apply_command(&SimulationCommandPatch {
                protocol_version: crate::CORE_PROTOCOL_VERSION,
                base_revision: 7,
                top_level_changes: Vec::new(),
                changed_entities: vec![RecordPatch {
                    id: "vein".into(),
                    changes: vec![
                        ValuePatch {
                            path: vec![PathSegment::Key("progress".into())],
                            operation: "set".into(),
                            value: Some(Value::from(-0.0)),
                        },
                        ValuePatch {
                            path: vec![PathSegment::Key("utilization".into())],
                            operation: "set".into(),
                            value: Some(Value::Null),
                        },
                        ValuePatch {
                            path: vec![PathSegment::Key("productionRate".into())],
                            operation: "delete".into(),
                            value: None,
                        },
                        ValuePatch {
                            path: vec![PathSegment::Key("inputs".into())],
                            operation: "set".into(),
                            value: Some(json!({"iron_ore":-0.0,"mod-input":null})),
                        },
                        ValuePatch {
                            path: vec![PathSegment::Key("modPayload".into())],
                            operation: "set".into(),
                            value: Some(json!({"nested":{"kept":true}})),
                        },
                    ],
                }],
                added_entities: vec![AddedRecord {
                    index: 1,
                    value: json!({
                        "id":"mod-entity","kind":"mod-kind","planetId":"home",
                        "inputs":null,"outputs":{"unknown-output":1e3},
                        "progress":"mod-progress","stationLastTransfer":-0.0,
                        "modPayload":{"alsoKept":[1,2,3]}
                    }),
                }],
                removed_entity_ids: Vec::new(),
                changed_belts: vec![RecordPatch {
                    id: "belt".into(),
                    changes: vec![
                        ValuePatch {
                            path: vec![PathSegment::Key("progress".into())],
                            operation: "set".into(),
                            value: Some(Value::from(-0.0)),
                        },
                        ValuePatch {
                            path: vec![PathSegment::Key("lastFlow".into())],
                            operation: "delete".into(),
                            value: None,
                        },
                        ValuePatch {
                            path: vec![PathSegment::Key("congestion".into())],
                            operation: "set".into(),
                            value: Some(Value::Null),
                        },
                        ValuePatch {
                            path: vec![PathSegment::Key("modSignal".into())],
                            operation: "set".into(),
                            value: Some(json!({"kept":[1,2,3]})),
                        },
                    ],
                }],
                added_belts: vec![AddedRecord {
                    index: 1,
                    value: json!({
                        "id":"belt-missing-fields","planetId":"home","source":"vein",
                        "target":"sink","itemId":"iron_ore","tier":1,"priority":1,
                        "modSignal":{"alsoKept":true}
                    }),
                }],
                removed_belt_ids: Vec::new(),
            })
            .unwrap();
        assert!(result.topology_dirty);
        assert_eq!(state.entity_dynamics.row_count, 2);
        assert_eq!(
            state
                .entity_dynamic_number(0, EntityDynamicField::Progress)
                .unwrap()
                .as_f64()
                .unwrap()
                .to_bits(),
            (-0.0_f64).to_bits()
        );
        assert_eq!(
            state
                .entity_dynamic_number(0, EntityDynamicField::Utilization)
                .unwrap()
                .kind(),
            ResidentValueKind::Null
        );
        assert_eq!(
            state
                .entity_dynamic_number(0, EntityDynamicField::ProductionRate)
                .unwrap()
                .kind(),
            ResidentValueKind::Missing
        );
        let first_inputs = state
            .entity_inventory(0, EntityInventorySide::Inputs)
            .unwrap();
        assert_eq!(first_inputs.container_kind(), ResidentObjectKind::Object);
        assert_eq!(
            first_inputs
                .get("iron_ore")
                .unwrap()
                .as_f64()
                .unwrap()
                .to_bits(),
            (-0.0_f64).to_bits()
        );
        assert_eq!(
            first_inputs.get("mod-input").unwrap().kind(),
            ResidentValueKind::Null
        );
        assert_eq!(
            state
                .entity_inventory(1, EntityInventorySide::Inputs)
                .unwrap()
                .container_kind(),
            ResidentObjectKind::Null
        );
        assert_eq!(
            state
                .entity_inventory(1, EntityInventorySide::Outputs)
                .unwrap()
                .get("unknown-output")
                .unwrap()
                .as_f64(),
            Some(1_000.0)
        );
        assert_eq!(
            state
                .entity_dynamic_number(1, EntityDynamicField::Progress)
                .unwrap()
                .kind(),
            ResidentValueKind::Other
        );
        assert_eq!(
            state.parse_entity(0).unwrap()["modPayload"]["nested"]["kept"],
            true
        );
        assert_eq!(
            state.parse_entity(1).unwrap()["modPayload"]["alsoKept"][2],
            3
        );
        assert_eq!(state.belts.lanes, vec![1.0, 1.0]);
        assert_eq!(state.belt_dynamics.len(), 2);
        assert_eq!(
            state.belt_dynamics.progress[0].to_bits(),
            (-0.0_f64).to_bits()
        );
        assert_ne!(
            state.belt_dynamics.number_mask[0] & (1 << BeltDynamicColumns::PROGRESS),
            0
        );
        assert_eq!(
            state.belt_dynamics.number_mask[0] & (1 << BeltDynamicColumns::LAST_FLOW),
            0
        );
        assert_eq!(
            state.belt_dynamics.number_mask[0] & (1 << BeltDynamicColumns::CONGESTION),
            0
        );
        assert_eq!(state.belt_dynamics.number_mask[1], 0);
        assert_eq!(state.parse_belt(0).unwrap()["modSignal"]["kept"][2], 3);
        assert_eq!(state.parse_belt(1).unwrap()["modSignal"]["alsoKept"], true);

        let mut records = BTreeMap::new();
        state
            .visit_internal_checkpoint_records(42, |key, value| {
                records.insert(key.to_owned(), value.as_bytes().to_vec());
                Ok(())
            })
            .unwrap();
        let restored =
            CoreState::from_internal_records(fixture_identity(8), &records, fixture_catalog())
                .unwrap();
        assert!(restored.entity_dynamics.bitwise_eq(&state.entity_dynamics));
        assert!(restored.belt_dynamics.bitwise_eq(&state.belt_dynamics));
        assert_eq!(restored.belts.lanes, state.belts.lanes);
        assert_eq!(
            restored.canonical_sha256().unwrap(),
            state.canonical_sha256().unwrap()
        );
    }

    #[test]
    fn legacy_checkpoint_without_pure_idle_session_keeps_full_credit() {
        let state = CoreState::from_internal_records(
            fixture_identity(7),
            &fixture_records(),
            fixture_catalog(),
        )
        .unwrap();
        assert_eq!(state.pure_idle_exact_seconds_used(), 0.0);

        let mut streamed = BTreeMap::<String, Vec<u8>>::new();
        state
            .visit_internal_checkpoint_records(42, |key, value| {
                streamed.insert(key.to_owned(), value.as_bytes().to_vec());
                Ok(())
            })
            .unwrap();
        let manifest: Value = serde_json::from_slice(
            &streamed["dsp-idle-network.internal.v1.chunked.v1.normal.manifest"],
        )
        .unwrap();
        assert!(manifest.get("pureIdleSession").is_none());
    }

    #[test]
    fn private_pure_idle_session_survives_checkpoint_without_entering_public_v47() {
        let mut state = CoreState::from_internal_records(
            fixture_identity(7),
            &fixture_records(),
            fixture_catalog(),
        )
        .unwrap();
        let canonical_before = state.canonical_sha256().unwrap();
        state.install_pure_idle_session_progress(12.5).unwrap();
        assert_eq!(state.canonical_sha256().unwrap(), canonical_before);

        let mut streamed = BTreeMap::<String, Vec<u8>>::new();
        state
            .visit_internal_checkpoint_records(42, |key, value| {
                streamed.insert(key.to_owned(), value.as_bytes().to_vec());
                Ok(())
            })
            .unwrap();
        let manifest_key = "dsp-idle-network.internal.v1.chunked.v1.normal.manifest";
        let manifest: Value = serde_json::from_slice(&streamed[manifest_key]).unwrap();
        assert_eq!(manifest["pureIdleSession"]["formatVersion"], 1);
        assert_eq!(
            manifest["pureIdleSession"]["exactSimulationSecondsUsed"],
            12.5
        );
        assert_eq!(manifest["pureIdleSession"]["lastCommittedRevision"], 7);

        let restored =
            CoreState::from_internal_records(fixture_identity(7), &streamed, fixture_catalog())
                .unwrap();
        assert_eq!(restored.pure_idle_exact_seconds_used(), 12.5);
        assert_eq!(restored.canonical_sha256().unwrap(), canonical_before);

        let mut public = Vec::new();
        restored.write_v47_envelope(42, &mut public).unwrap();
        let envelope: Value = serde_json::from_slice(&public).unwrap();
        assert!(envelope["state"].get("pureIdleSession").is_none());
    }

    #[test]
    fn private_macro_v10_credit_roundtrips_without_changing_public_v47() {
        let mut state = CoreState::from_internal_records(
            fixture_identity(7),
            &fixture_records(),
            fixture_catalog(),
        )
        .unwrap();
        let canonical_before = state.canonical_sha256().unwrap();
        state
            .install_pure_idle_macro_session_progress(20.0)
            .unwrap();
        assert_eq!(state.pure_idle_macro_exact_seconds_used(), 20.0);
        assert_eq!(state.pure_idle_exact_seconds_used(), 0.0);

        let mut streamed = BTreeMap::<String, Vec<u8>>::new();
        state
            .visit_internal_checkpoint_records(42, |key, value| {
                streamed.insert(key.to_owned(), value.as_bytes().to_vec());
                Ok(())
            })
            .unwrap();
        let manifest_key = "dsp-idle-network.internal.v1.chunked.v1.normal.manifest";
        let manifest: Value = serde_json::from_slice(&streamed[manifest_key]).unwrap();
        assert!(manifest.get("pureIdleSession").is_none());
        assert_eq!(manifest["pureIdleMacroSession"]["formatVersion"], 1);
        assert_eq!(manifest["pureIdleMacroSession"]["macroV10"], true);

        let restored =
            CoreState::from_internal_records(fixture_identity(7), &streamed, fixture_catalog())
                .unwrap();
        assert_eq!(restored.pure_idle_macro_exact_seconds_used(), 20.0);
        assert_eq!(restored.pure_idle_exact_seconds_used(), 0.0);
        assert_eq!(restored.canonical_sha256().unwrap(), canonical_before);

        let mut public = Vec::new();
        restored.write_v47_envelope(42, &mut public).unwrap();
        let envelope: Value = serde_json::from_slice(&public).unwrap();
        assert!(envelope["state"].get("pureIdleSession").is_none());
    }

    #[test]
    fn conservative_and_macro_v10_sessions_never_inherit_each_others_credit() {
        let mut state = CoreState::from_internal_records(
            fixture_identity(7),
            &fixture_records(),
            fixture_catalog(),
        )
        .unwrap();
        state.install_pure_idle_session_progress(30.0).unwrap();
        assert_eq!(state.pure_idle_exact_seconds_used(), 30.0);
        assert_eq!(state.pure_idle_macro_exact_seconds_used(), 0.0);

        state
            .install_pure_idle_macro_session_progress(10.0)
            .unwrap();
        assert_eq!(state.pure_idle_exact_seconds_used(), 0.0);
        assert_eq!(state.pure_idle_macro_exact_seconds_used(), 10.0);

        state.install_pure_idle_session_progress(5.0).unwrap();
        assert_eq!(state.pure_idle_exact_seconds_used(), 5.0);
        assert_eq!(state.pure_idle_macro_exact_seconds_used(), 0.0);
    }

    #[test]
    fn private_pure_idle_session_survives_incremental_checkpoint_reload() {
        let mut state = CoreState::from_internal_records(
            fixture_identity(7),
            &fixture_records(),
            fixture_catalog(),
        )
        .unwrap();
        state.install_pure_idle_session_progress(18.0).unwrap();

        let mut records = fixture_records();
        let mut delta = BTreeMap::new();
        let visit = state
            .visit_dirty_internal_checkpoint_records(43, |key, value| {
                delta.insert(key.to_owned(), value.as_bytes().to_vec());
                Ok(())
            })
            .unwrap();
        apply_checkpoint_delta(&mut records, &visit, delta);
        state.abort_checkpoint_visit();
        assert_eq!(state.pure_idle_exact_seconds_used(), 18.0);

        let restored =
            CoreState::from_internal_records(fixture_identity(7), &records, fixture_catalog())
                .unwrap();
        assert_eq!(restored.pure_idle_exact_seconds_used(), 18.0);
    }

    #[test]
    fn pure_idle_session_manifest_is_strictly_validated() {
        let manifest_key = "dsp-idle-network.internal.v1.chunked.v1.normal.manifest";
        let invalid_sessions = [
            Value::Null,
            json!({"formatVersion":0,"exactSimulationSecondsUsed":1,"lastCommittedRevision":7}),
            json!({"formatVersion":1,"exactSimulationSecondsUsed":-1,"lastCommittedRevision":7}),
            json!({"formatVersion":1,"exactSimulationSecondsUsed":30.0001,"lastCommittedRevision":7}),
            json!({"formatVersion":1,"exactSimulationSecondsUsed":1,"lastCommittedRevision":6}),
            json!({"formatVersion":1,"exactSimulationSecondsUsed":1,"lastCommittedRevision":7,"unexpected":true}),
            json!({"formatVersion":1,"exactSimulationSecondsUsed":"1","lastCommittedRevision":7}),
        ];

        for session in invalid_sessions {
            let mut records = fixture_records();
            let mut manifest: Value = serde_json::from_slice(&records[manifest_key]).unwrap();
            manifest["pureIdleSession"] = session;
            records.insert(manifest_key.into(), serde_json::to_vec(&manifest).unwrap());
            assert!(
                CoreState::from_internal_records(fixture_identity(7), &records, fixture_catalog(),)
                    .is_err()
            );
        }
    }

    #[test]
    fn committed_non_idle_revision_lazily_resets_pure_idle_credit() {
        let mut state = CoreState::from_internal_records(
            fixture_identity(7),
            &fixture_records(),
            fixture_catalog(),
        )
        .unwrap();
        state.install_pure_idle_session_progress(30.0).unwrap();
        assert_eq!(state.pure_idle_exact_seconds_used(), 30.0);

        // Successful commands and exact/realtime advances both commit a new
        // revision without updating this private pure-idle marker.
        state.revision += 1;
        assert_eq!(state.pure_idle_exact_seconds_used(), 0.0);
    }

    #[test]
    fn successful_command_starts_a_new_pure_idle_session() {
        let mut state = CoreState::from_internal_records(
            fixture_identity(7),
            &fixture_records(),
            fixture_catalog(),
        )
        .unwrap();
        state.install_pure_idle_session_progress(30.0).unwrap();
        let result = state
            .apply_command(&SimulationCommandPatch {
                protocol_version: crate::CORE_PROTOCOL_VERSION,
                base_revision: 7,
                top_level_changes: vec![ValuePatch {
                    path: vec![PathSegment::Key("paused".to_owned())],
                    operation: "set".to_owned(),
                    value: Some(Value::Bool(true)),
                }],
                changed_entities: Vec::new(),
                added_entities: Vec::new(),
                removed_entity_ids: Vec::new(),
                changed_belts: Vec::new(),
                added_belts: Vec::new(),
                removed_belt_ids: Vec::new(),
            })
            .unwrap();
        assert_eq!(result.revision, 8);
        assert_eq!(state.pure_idle_exact_seconds_used(), 0.0);

        let mut streamed = BTreeMap::<String, Vec<u8>>::new();
        state
            .visit_internal_checkpoint_records(43, |key, value| {
                streamed.insert(key.to_owned(), value.as_bytes().to_vec());
                Ok(())
            })
            .unwrap();
        let manifest: Value = serde_json::from_slice(
            &streamed["dsp-idle-network.internal.v1.chunked.v1.normal.manifest"],
        )
        .unwrap();
        assert!(manifest.get("pureIdleSession").is_none());
        let restored =
            CoreState::from_internal_records(fixture_identity(8), &streamed, fixture_catalog())
                .unwrap();
        assert_eq!(restored.pure_idle_exact_seconds_used(), 0.0);

        let mut incremental = fixture_records();
        let mut delta = BTreeMap::new();
        let visit = state
            .visit_dirty_internal_checkpoint_records(44, |key, value| {
                delta.insert(key.to_owned(), value.as_bytes().to_vec());
                Ok(())
            })
            .unwrap();
        apply_checkpoint_delta(&mut incremental, &visit, delta);
        let restored =
            CoreState::from_internal_records(fixture_identity(8), &incremental, fixture_catalog())
                .unwrap();
        assert_eq!(restored.pure_idle_exact_seconds_used(), 0.0);
    }
}
