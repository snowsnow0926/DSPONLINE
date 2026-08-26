use std::cell::RefCell;
use std::collections::{BTreeMap, HashMap};
use std::mem::size_of;
use std::sync::mpsc::{SyncSender, sync_channel};
use std::sync::{Arc, OnceLock};

use anyhow::{Context, anyhow, bail};
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use crate::canonical::{fnv1a_utf8, update_canonical, update_canonical_object};
use crate::catalog::RuntimeCatalog;

const INTERNAL_MANIFEST_SUFFIX: &str = "manifest";
const MAX_INTERNAL_RECORDS: usize = 4_096;
const MAX_ENTITY_COUNT: usize = 2_000_000;
const MAX_BELT_COUNT: usize = 4_000_000;
const MAX_PROJECTION_ENTITIES: usize = 32;
const MAX_PROJECTION_BELTS: usize = 64;
const MAX_PROJECTION_BASE_FIELDS: usize = 64;
const MAX_PROJECTION_BYTES: usize = 1_048_576;
const NONE_SYMBOL: u32 = u32::MAX;

struct DeferredRecordDrop {
    entities: Vec<Value>,
    belts: Vec<Value>,
}

fn deferred_record_drop_sender() -> &'static SyncSender<DeferredRecordDrop> {
    static SENDER: OnceLock<SyncSender<DeferredRecordDrop>> = OnceLock::new();
    SENDER.get_or_init(|| {
        // A zero-capacity channel permits one batch being destroyed while the
        // next simulation runs, but never allows retired full states to queue
        // and turn latency optimization into unbounded memory growth.
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
            // Disconnecting the receiver makes send return ownership to the
            // caller, which then falls back to a synchronous drop safely.
        }
        sender
    })
}

fn defer_record_drop(entities: Vec<Value>, belts: Vec<Value>) {
    if let Err(error) = deferred_record_drop_sender().send(DeferredRecordDrop { entities, belts }) {
        drop(error.0);
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

#[derive(Debug, Clone)]
pub(crate) struct ItemQuantity {
    pub item: u32,
    pub amount: f64,
}

pub(crate) type RawRecord = Arc<str>;

#[derive(Debug, Clone, Default)]
pub(crate) struct EntityColumns {
    pub ids: Vec<Box<str>>,
    pub kinds: Vec<u32>,
    pub planets: Vec<u32>,
    pub buildings: Vec<u32>,
    pub recipes: Vec<u32>,
    pub resources: Vec<u32>,
    pub stored_items: Vec<u32>,
    pub machine_counts: Vec<f64>,
    pub miner_counts: Vec<f64>,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct BeltColumns {
    pub ids: Vec<Box<str>>,
    pub planets: Vec<u32>,
    pub sources: Vec<u32>,
    pub targets: Vec<u32>,
    pub items: Vec<u32>,
    pub lanes: Vec<f64>,
    pub tiers: Vec<u8>,
    pub stack_sizes: Vec<f64>,
    pub priorities: Vec<u8>,
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
    pub power_source_indices: Vec<usize>,
    pub vein_indices: Vec<usize>,
    pub ordinary_machine_indices: Vec<usize>,
    pub non_station_indices: Vec<usize>,
    pub research_entity_indices: Vec<usize>,
    pub entity_planet_indices: Vec<usize>,
    pub entity_grid_indices: Vec<usize>,
    pub has_galactic_material_exporter: bool,
}

impl FactoryTopology {
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
            + self.power_source_indices.capacity()
            + self.vein_indices.capacity()
            + self.ordinary_machine_indices.capacity()
            + self.non_station_indices.capacity()
            + self.research_entity_indices.capacity()
            + self.entity_planet_indices.capacity()
            + self.entity_grid_indices.capacity();
        (index_capacity * size_of::<usize>()) as u64
    }
}

#[derive(Debug, Clone)]
pub struct CoreState {
    pub identity: CoreCheckpointIdentity,
    pub revision: u64,
    pub catalog: RuntimeCatalog,
    base: Map<String, Value>,
    entity_raw: Vec<RawRecord>,
    belt_raw: Vec<RawRecord>,
    pub(crate) entity_index: HashMap<String, usize>,
    pub(crate) belt_index: HashMap<String, usize>,
    pub(crate) symbols: Symbols,
    pub(crate) entities: EntityColumns,
    pub(crate) belts: BeltColumns,
    pub(crate) factory_topology: Arc<FactoryTopology>,
    coverage: DomainCoverage,
    factory_static_admission_checked: bool,
    factory_static_admission_reason: Option<&'static str>,
    prepared_belt_routes: Option<Arc<crate::belts::PreparedRoutes>>,
    /// Canonical diagnostics are intentionally expensive on very large saves.
    /// A revision is immutable from the protocol's point of view, so repeated
    /// status/compare/checkpoint calls can safely reuse the small digest result
    /// instead of reparsing every entity and belt again.
    summary_cache: RefCell<Option<(u64, CoreStateSummary)>>,
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

fn parse_inventory(value: Option<&Value>, symbols: &mut Symbols) -> Vec<ItemQuantity> {
    let Some(object) = value.and_then(Value::as_object) else {
        return Vec::new();
    };
    let mut values = object
        .iter()
        .filter_map(|(item, amount)| {
            let amount = amount.as_f64()?;
            amount.is_finite().then(|| ItemQuantity {
                item: symbols.intern(Some(item)),
                amount,
            })
        })
        .collect::<Vec<_>>();
    values.sort_by_key(|entry| entry.item);
    values
}

fn parallel_worker_count(record_count: usize) -> usize {
    if record_count < 4_096 {
        return 1;
    }
    std::thread::available_parallelism()
        .map(usize::from)
        .unwrap_or(1)
        .clamp(1, 8)
        .min(record_count)
}

fn parse_records_parallel(
    records: &[RawRecord],
    label: &'static str,
) -> anyhow::Result<Vec<Value>> {
    let workers = parallel_worker_count(records.len());
    if workers == 1 {
        return records
            .iter()
            .map(|raw| serde_json::from_str(raw).with_context(|| format!("decode {label}")))
            .collect();
    }
    let chunk_size = records.len().div_ceil(workers);
    let mut parts = std::thread::scope(|scope| -> anyhow::Result<Vec<(usize, Vec<Value>)>> {
        let handles = records
            .chunks(chunk_size)
            .enumerate()
            .map(|(part_index, chunk)| {
                scope.spawn(move || -> anyhow::Result<(usize, Vec<Value>)> {
                    let values = chunk
                        .iter()
                        .map(|raw| {
                            serde_json::from_str(raw).with_context(|| format!("decode {label}"))
                        })
                        .collect::<anyhow::Result<Vec<_>>>()?;
                    Ok((part_index, values))
                })
            })
            .collect::<Vec<_>>();
        handles
            .into_iter()
            .map(|handle| {
                handle
                    .join()
                    .map_err(|_| anyhow!("native {label} parser thread panicked"))?
            })
            .collect()
    })?;
    parts.sort_by_key(|(part_index, _)| *part_index);
    Ok(parts.into_iter().flat_map(|(_, values)| values).collect())
}

fn encode_records_parallel(
    records: &[Value],
    label: &'static str,
) -> anyhow::Result<Vec<RawRecord>> {
    let workers = parallel_worker_count(records.len());
    if workers == 1 {
        return records
            .iter()
            .map(|value| {
                serde_json::to_string(value)
                    .with_context(|| format!("encode {label}"))
                    .map(RawRecord::from)
            })
            .collect();
    }
    let chunk_size = records.len().div_ceil(workers);
    let mut parts = std::thread::scope(|scope| -> anyhow::Result<Vec<(usize, Vec<RawRecord>)>> {
        let handles = records
            .chunks(chunk_size)
            .enumerate()
            .map(|(part_index, chunk)| {
                scope.spawn(move || -> anyhow::Result<(usize, Vec<RawRecord>)> {
                    let values = chunk
                        .iter()
                        .map(|value| {
                            serde_json::to_string(value)
                                .with_context(|| format!("encode {label}"))
                                .map(RawRecord::from)
                        })
                        .collect::<anyhow::Result<Vec<_>>>()?;
                    Ok((part_index, values))
                })
            })
            .collect::<Vec<_>>();
        handles
            .into_iter()
            .map(|handle| {
                handle
                    .join()
                    .map_err(|_| anyhow!("native {label} encoder thread panicked"))?
            })
            .collect()
    })?;
    parts.sort_by_key(|(part_index, _)| *part_index);
    Ok(parts.into_iter().flat_map(|(_, values)| values).collect())
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
    Ok(())
}

fn parse_manifest(
    records: &BTreeMap<String, Vec<u8>>,
) -> anyhow::Result<(String, ChunkedManifest)> {
    let mut candidates = Vec::new();
    for (key, bytes) in records {
        if !key.ends_with(INTERNAL_MANIFEST_SUFFIX) {
            continue;
        }
        let Ok(value) = serde_json::from_slice::<Value>(bytes) else {
            continue;
        };
        if value.get("formatVersion").and_then(Value::as_u64) != Some(1)
            || value.get("chunks").and_then(Value::as_array).is_none()
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
    Ok(candidates.pop().expect("one manifest"))
}

fn chunk_record<'a>(
    records: &'a BTreeMap<String, Vec<u8>>,
    manifest_key: &str,
    id: &str,
) -> anyhow::Result<&'a [u8]> {
    let prefix = manifest_key
        .strip_suffix(INTERNAL_MANIFEST_SUFFIX)
        .ok_or_else(|| anyhow!("native core manifest key is invalid"))?;
    let key = format!("{prefix}chunk.{}", encoded_chunk_id(id));
    records
        .get(&key)
        .map(Vec::as_slice)
        .ok_or_else(|| anyhow!("native core checkpoint chunk is missing: {id}"))
}

impl CoreState {
    pub fn from_internal_records(
        identity: CoreCheckpointIdentity,
        records: &BTreeMap<String, Vec<u8>>,
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
        let (manifest_key, manifest) = parse_manifest(records)?;
        if manifest.format_version != 1
            || manifest.envelope_format_version != 2
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
        let base_metadata = manifest
            .chunks
            .iter()
            .filter(|chunk| chunk.kind == "base")
            .collect::<Vec<_>>();
        if base_metadata.len() != 1 || base_metadata[0].offset != 0 || base_metadata[0].count != 1 {
            bail!("native core checkpoint base chunk is invalid");
        }
        let base_bytes = chunk_record(records, &manifest_key, &base_metadata[0].id)?;
        verify_chunk(base_metadata[0], base_bytes)?;
        let base = serde_json::from_slice::<Value>(base_bytes)
            .context("decode native core base chunk")?
            .as_object()
            .cloned()
            .ok_or_else(|| anyhow!("native core base chunk is not an object"))?;
        if base.contains_key("entities") || base.contains_key("belts") {
            bail!("native core base chunk contains an unbounded collection");
        }

        let mut entity_raw = vec![None; manifest.entity_count];
        let mut belt_raw = vec![None; manifest.belt_count];
        for metadata in &manifest.chunks {
            if metadata.kind == "base" {
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
            let bytes = chunk_record(records, &manifest_key, &metadata.id)?;
            verify_chunk(metadata, bytes)?;
            // Preserve each already-valid JSON record as raw text. Decoding
            // the page into a full `Value` graph and immediately serializing
            // every record again doubled startup parsing and allocation; the
            // index rebuild below performs the required object validation.
            let values = serde_json::from_slice::<Vec<Box<RawValue>>>(bytes)
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
        }
        if entity_raw.iter().any(Option::is_none) || belt_raw.iter().any(Option::is_none) {
            bail!("native core checkpoint record ranges are incomplete");
        }
        let mut state = Self {
            revision: identity.revision,
            identity,
            catalog,
            base,
            entity_raw: entity_raw.into_iter().map(Option::unwrap).collect(),
            belt_raw: belt_raw.into_iter().map(Option::unwrap).collect(),
            entity_index: HashMap::new(),
            belt_index: HashMap::new(),
            symbols: Symbols::default(),
            entities: EntityColumns::default(),
            belts: BeltColumns::default(),
            factory_topology: Arc::new(FactoryTopology::default()),
            coverage: DomainCoverage::implemented_beta_scope(),
            factory_static_admission_checked: false,
            factory_static_admission_reason: None,
            prepared_belt_routes: None,
            summary_cache: RefCell::new(None),
        };
        // Startup needs parsed records both for indexes and prepared belt
        // routes. Keep one bounded parse graph alive through both consumers
        // instead of decoding all records twice back-to-back.
        let parsed_entities = state.parse_entities_parallel()?;
        let parsed_belts = state.parse_belts_parallel()?;
        state.rebuild_indexes_from_parsed(&parsed_entities, &parsed_belts)?;
        state.refresh_factory_static_admission()?;
        if state.factory_static_admission_reason.is_none() {
            state.prepared_belt_routes = Some(Arc::new(crate::belts::prepare_routes(
                &state,
                &parsed_entities,
                &parsed_belts,
            )?));
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
        const ENTITY_CHUNK_SIZE: usize = 1_024;
        const BELT_CHUNK_SIZE: usize = 2_048;
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
            metadata.push(ChunkMetadata {
                id: id.clone(),
                kind: kind.to_owned(),
                offset,
                count,
                checksum: fnv1a_utf8(text.as_bytes()),
                bytes,
            });
            total_bytes = total_bytes.saturating_add(bytes);
            let key = format!("{prefix}chunk.{}", encoded_chunk_id(&id));
            visit(&key, &text)?;
            active_keys.push(key);
            Ok(())
        };

        emit(
            "base".to_owned(),
            "base",
            0,
            1,
            serde_json::to_string(&Value::Object(self.base.clone()))?,
        )?;
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
        emit_raw_ranges(&self.entity_raw, "entities", ENTITY_CHUNK_SIZE, &mut emit)?;
        emit_raw_ranges(&self.belt_raw, "belts", BELT_CHUNK_SIZE, &mut emit)?;

        let mut root_material = String::new();
        for chunk in &metadata {
            use std::fmt::Write as _;
            write!(
                root_material,
                "{}:{}:{}:{}:{}:{};",
                chunk.id, chunk.kind, chunk.offset, chunk.count, chunk.checksum, chunk.bytes
            )?;
        }
        let manifest_key = format!("{prefix}manifest");
        let manifest = serde_json::to_string(&serde_json::json!({
            "formatVersion": 1,
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
        }))?;
        visit(&manifest_key, &manifest)?;
        active_keys.push(manifest_key);
        Ok(active_keys)
    }

    pub fn install_checkpoint_identity(&mut self, generation: u64, root_hash: String) {
        self.identity.generation = generation;
        self.identity.root_hash = root_hash;
        self.identity.revision = self.revision;
    }

    pub(crate) fn refresh_factory_static_admission(&mut self) -> anyhow::Result<()> {
        self.factory_static_admission_reason =
            crate::simple_factory::static_admission_reason(self)?;
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

    pub(crate) fn rebuild_indexes(&mut self) -> anyhow::Result<()> {
        let entities = self.parse_entities_parallel()?;
        let belts = self.parse_belts_parallel()?;
        self.rebuild_indexes_from_parsed(&entities, &belts)
    }

    fn rebuild_indexes_from_parsed(
        &mut self,
        entity_values: &[Value],
        belt_values: &[Value],
    ) -> anyhow::Result<()> {
        if entity_values.len() != self.entity_raw.len() || belt_values.len() != self.belt_raw.len()
        {
            bail!("native core parsed record count is inconsistent");
        }
        self.symbols = Symbols::default();
        self.entities = EntityColumns::default();
        self.belts = BeltColumns::default();
        self.entity_index.clear();
        self.belt_index.clear();
        let planet_indices = self
            .catalog
            .planets
            .iter()
            .enumerate()
            .map(|(index, planet)| (planet.id.as_str(), index))
            .collect::<HashMap<_, _>>();
        let mut factory_topology = FactoryTopology::default();
        for (index, value) in entity_values.iter().enumerate() {
            let object = value
                .as_object()
                .ok_or_else(|| anyhow!("native core entity is not an object"))?;
            let id = object_string(object, "id")
                .ok_or_else(|| anyhow!("native core entity ID is missing"))?;
            if self.entity_index.insert(id.to_owned(), index).is_some() {
                bail!("native core entity ID is duplicated: {id}");
            }
            self.entities.ids.push(id.into());
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
            factory_topology.entity_planet_indices.push(
                object_string(object, "planetId")
                    .and_then(|id| planet_indices.get(id).copied())
                    .unwrap_or(usize::MAX),
            );
            factory_topology.entity_grid_indices.push(
                match object_string(object, "powerGridId").unwrap_or("grid-a") {
                    "grid-a" => 0,
                    "grid-b" => 1,
                    "grid-c" => 2,
                    _ => usize::MAX,
                },
            );
        }
        for (index, value) in belt_values.iter().enumerate() {
            let object = value
                .as_object()
                .ok_or_else(|| anyhow!("native core belt is not an object"))?;
            let id = object_string(object, "id")
                .ok_or_else(|| anyhow!("native core belt ID is missing"))?;
            if self.belt_index.insert(id.to_owned(), index).is_some() {
                bail!("native core belt ID is duplicated: {id}");
            }
            self.belts.ids.push(id.into());
            self.belts
                .planets
                .push(self.symbols.intern(object_string(object, "planetId")));
            self.belts
                .sources
                .push(self.symbols.intern(object_string(object, "source")));
            self.belts
                .targets
                .push(self.symbols.intern(object_string(object, "target")));
            self.belts
                .items
                .push(self.symbols.intern(object_string(object, "itemId")));
            self.belts.lanes.push(object_number(object, "lanes"));
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
        }
        self.factory_topology = Arc::new(factory_topology);
        Ok(())
    }

    pub(crate) fn parse_entity(&self, index: usize) -> anyhow::Result<Value> {
        serde_json::from_str(&self.entity_raw[index]).context("decode native core entity")
    }

    pub(crate) fn parse_belt(&self, index: usize) -> anyhow::Result<Value> {
        serde_json::from_str(&self.belt_raw[index]).context("decode native core belt")
    }

    pub(crate) fn parse_entities_parallel(&self) -> anyhow::Result<Vec<Value>> {
        parse_records_parallel(&self.entity_raw, "native core entity")
    }

    pub(crate) fn parse_belts_parallel(&self) -> anyhow::Result<Vec<Value>> {
        parse_records_parallel(&self.belt_raw, "native core belt")
    }

    pub(crate) fn base_value_mut(&mut self) -> &mut Map<String, Value> {
        self.summary_cache.get_mut().take();
        &mut self.base
    }
    pub(crate) fn base_value(&self) -> &Map<String, Value> {
        &self.base
    }
    pub(crate) fn entity_raw_mut(&mut self) -> &mut Vec<RawRecord> {
        self.summary_cache.get_mut().take();
        &mut self.entity_raw
    }
    pub(crate) fn belt_raw_mut(&mut self) -> &mut Vec<RawRecord> {
        self.summary_cache.get_mut().take();
        &mut self.belt_raw
    }

    pub(crate) fn commit_simulated_state(
        &mut self,
        base: Map<String, Value>,
        entities: Vec<Value>,
        belts: Vec<Value>,
    ) -> anyhow::Result<()> {
        self.summary_cache.get_mut().take();
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
        if entities.len() != self.entity_raw.len() || belts.len() != self.belt_raw.len() {
            bail!("native simulation changed record topology");
        }
        for (index, entity) in entities.iter().enumerate() {
            let object = entity
                .as_object()
                .ok_or_else(|| anyhow!("native simulated entity is not an object"))?;
            if object_string(object, "id") != Some(self.entities.ids[index].as_ref()) {
                bail!("native simulation changed entity identity");
            }
        }
        for (index, belt) in belts.iter().enumerate() {
            let object = belt
                .as_object()
                .ok_or_else(|| anyhow!("native simulated belt is not an object"))?;
            if object_string(object, "id") != Some(self.belts.ids[index].as_ref()) {
                bail!("native simulation changed belt identity");
            }
        }
        profile_mark!("identity");

        let entity_raw = encode_records_parallel(&entities, "native simulated entity")?;
        let belt_raw = encode_records_parallel(&belts, "native simulated belt")?;
        profile_mark!("encode");

        self.base = base;
        self.entity_raw = entity_raw;
        self.belt_raw = belt_raw;
        defer_record_drop(entities, belts);
        profile_last!("install");
        Ok(())
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
    fn canonical_digest_bundle(&self) -> anyhow::Result<CanonicalDigestBundle> {
        let mut canonical = Sha256::new();
        let mut entities = Sha256::new();
        let mut belts = Sha256::new();
        let mut domain = self.start_domain_hasher();
        let mut domain_symbols = self.symbols.clone();
        let mut belt_domain_metrics = Vec::<[f64; 3]>::with_capacity(self.belt_raw.len());
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
                        let value =
                            serde_json::from_str(raw).context("decode native canonical entity")?;
                        update_canonical(&mut canonical, &value);
                        update_canonical(&mut entities, &value);
                        self.update_domain_entity(&mut domain, &mut domain_symbols, index, &value)?;
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
                        let value =
                            serde_json::from_str(raw).context("decode native canonical belt")?;
                        update_canonical(&mut canonical, &value);
                        update_canonical(&mut belts, &value);
                        let belt = value
                            .as_object()
                            .ok_or_else(|| anyhow!("native domain belt is not an object"))?;
                        belt_domain_metrics.push([
                            object_number(belt, "progress"),
                            object_number(belt, "totalTransferred"),
                            object_number(belt, "lastFlow"),
                        ]);
                    }
                    canonical.update(b"]");
                }
                key => update_canonical(&mut canonical, &self.base[key]),
            }
        }
        canonical.update(b"}");
        entities.update(b"]");
        belts.update(b"]");
        if belt_domain_metrics.len() != self.belts.ids.len() {
            bail!("native domain belt metric count is inconsistent");
        }
        for (index, metrics) in belt_domain_metrics.into_iter().enumerate() {
            self.update_domain_belt_metrics(&mut domain, index, metrics);
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
        symbols: &mut Symbols,
        index: usize,
        value: &Value,
    ) -> anyhow::Result<()> {
        let entity = value
            .as_object()
            .ok_or_else(|| anyhow!("native domain entity is not an object"))?;
        hasher.update(self.entities.ids[index].as_bytes());
        hasher.update(b"\0");
        for entry in parse_inventory(entity.get("inputs"), symbols) {
            if let Some(item) = self.symbols.resolve(entry.item) {
                hasher.update(item.as_bytes());
            } else if let Some(item) = symbols.resolve(entry.item) {
                hasher.update(item.as_bytes());
            }
            hasher.update(entry.amount.to_bits().to_le_bytes());
        }
        hasher.update(b"|");
        for entry in parse_inventory(entity.get("outputs"), symbols) {
            if let Some(item) = self.symbols.resolve(entry.item) {
                hasher.update(item.as_bytes());
            } else if let Some(item) = symbols.resolve(entry.item) {
                hasher.update(item.as_bytes());
            }
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
        let mut symbols = self.symbols.clone();
        for (index, raw) in self.entity_raw.iter().enumerate() {
            let value: Value = serde_json::from_str(raw).context("decode native domain entity")?;
            let entity = value
                .as_object()
                .ok_or_else(|| anyhow!("native domain entity is not an object"))?;
            hasher.update(self.entities.ids[index].as_bytes());
            hasher.update(b"\0");
            for entry in parse_inventory(entity.get("inputs"), &mut symbols) {
                if let Some(item) = self.symbols.resolve(entry.item) {
                    hasher.update(item.as_bytes());
                } else if let Some(item) = symbols.resolve(entry.item) {
                    hasher.update(item.as_bytes());
                }
                hasher.update(entry.amount.to_bits().to_le_bytes());
            }
            hasher.update(b"|");
            for entry in parse_inventory(entity.get("outputs"), &mut symbols) {
                if let Some(item) = self.symbols.resolve(entry.item) {
                    hasher.update(item.as_bytes());
                } else if let Some(item) = symbols.resolve(entry.item) {
                    hasher.update(item.as_bytes());
                }
                hasher.update(entry.amount.to_bits().to_le_bytes());
            }
            hasher.update(object_number(entity, "progress").to_bits().to_le_bytes());
            hasher.update(object_number(entity, "utilization").to_bits().to_le_bytes());
            hasher.update(
                object_number(entity, "productionRate")
                    .to_bits()
                    .to_le_bytes(),
            );
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
        let raw_record_bytes = self
            .entity_raw
            .iter()
            .chain(self.belt_raw.iter())
            .map(|value| value.len() as u64)
            .sum();
        // Hot simulation data lives only in the authoritative records. Keeping
        // a second inventory/progress mirror made every checkpoint retain a
        // large stale object graph without accelerating the native step.
        let inventory_entry_count = 0;
        let indexed_string_bytes = self.symbols.estimated_bytes()
            + self
                .entity_index
                .keys()
                .map(|value| value.len() as u64)
                .sum::<u64>()
            + self
                .belt_index
                .keys()
                .map(|value| value.len() as u64)
                .sum::<u64>();
        let entity_rows = self.entities.ids.len() as u64;
        let belt_rows = self.belts.ids.len() as u64;
        let numeric_columns = entity_rows * 56 + belt_rows * 72;
        let index_overhead = ((self.entity_index.capacity() + self.belt_index.capacity())
            * (size_of::<String>() + size_of::<usize>())) as u64;
        let topology_index_bytes = self
            .prepared_belt_routes
            .as_ref()
            .map(|routes| routes.estimated_bytes())
            .unwrap_or(0)
            + self.factory_topology.estimated_bytes();
        let estimated_runtime_bytes = raw_record_bytes
            + indexed_string_bytes
            + inventory_entry_count * size_of::<ItemQuantity>() as u64
            + numeric_columns
            + index_overhead
            + topology_index_bytes
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
        let summary = CoreStateSummary {
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
        };
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
    use serde_json::json;

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
        assert_eq!(state.materialize().unwrap()["entities"][0]["id"], "vein");
        let transactional_clone = state.clone();
        assert!(Arc::ptr_eq(
            &state.entity_raw[0],
            &transactional_clone.entity_raw[0]
        ));
        assert!(Arc::ptr_eq(
            &state.belt_raw[0],
            &transactional_clone.belt_raw[0]
        ));

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
}
