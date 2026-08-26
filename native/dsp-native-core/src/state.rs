use std::collections::{BTreeMap, HashMap};
use std::mem::size_of;

use anyhow::{Context, anyhow, bail};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use crate::canonical::{fnv1a_utf8, update_canonical};
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
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeMemoryEstimate {
    pub raw_record_bytes: u64,
    pub indexed_string_bytes: u64,
    pub inventory_entry_count: u64,
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
    pub fn state_container_only() -> Self {
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
            mining: false,
            production: false,
            research: false,
            belts: false,
            logistics: false,
            power: false,
            dyson: false,
            construction: false,
            space_station: false,
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

#[derive(Debug, Clone, Deserialize)]
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

    fn resolve(&self, value: u32) -> Option<&str> {
        if value == NONE_SYMBOL {
            None
        } else {
            self.values.get(value as usize).map(AsRef::as_ref)
        }
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
    pub progress: Vec<f64>,
    pub utilization: Vec<f64>,
    pub production_rate: Vec<f64>,
    pub power_factor: Vec<Option<f64>>,
    pub routing_cursor: Vec<f64>,
    pub inputs: Vec<Vec<ItemQuantity>>,
    pub outputs: Vec<Vec<ItemQuantity>>,
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
    pub progress: Vec<f64>,
    pub priorities: Vec<u8>,
    pub total_transferred: Vec<f64>,
    pub congestion: Vec<f64>,
    pub last_flow: Vec<f64>,
}

#[derive(Debug, Clone)]
pub struct CoreState {
    pub identity: CoreCheckpointIdentity,
    pub revision: u64,
    pub catalog: RuntimeCatalog,
    base: Map<String, Value>,
    entity_raw: Vec<Box<str>>,
    belt_raw: Vec<Box<str>>,
    pub(crate) entity_index: HashMap<String, usize>,
    pub(crate) belt_index: HashMap<String, usize>,
    pub(crate) symbols: Symbols,
    pub(crate) entities: EntityColumns,
    pub(crate) belts: BeltColumns,
    coverage: DomainCoverage,
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
            let values = serde_json::from_slice::<Vec<Value>>(bytes)
                .context("decode native core record chunk")?;
            if values.len() != metadata.count {
                bail!("native core checkpoint chunk count is invalid");
            }
            for (index, value) in values.into_iter().enumerate() {
                if !value.is_object() || target[metadata.offset + index].is_some() {
                    bail!("native core checkpoint record topology is invalid");
                }
                target[metadata.offset + index] =
                    Some(serde_json::to_string(&value)?.into_boxed_str());
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
            coverage: DomainCoverage::state_container_only(),
        };
        state.rebuild_indexes()?;
        Ok(state)
    }

    pub(crate) fn rebuild_indexes(&mut self) -> anyhow::Result<()> {
        self.symbols = Symbols::default();
        self.entities = EntityColumns::default();
        self.belts = BeltColumns::default();
        self.entity_index.clear();
        self.belt_index.clear();
        for (index, raw) in self.entity_raw.iter().enumerate() {
            let value =
                serde_json::from_str::<Value>(raw).context("decode native core entity record")?;
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
            self.entities
                .progress
                .push(object_number(object, "progress"));
            self.entities
                .utilization
                .push(object_number(object, "utilization"));
            self.entities
                .production_rate
                .push(object_number(object, "productionRate"));
            self.entities.power_factor.push(
                object
                    .get("powerFactor")
                    .and_then(Value::as_f64)
                    .filter(|value| value.is_finite()),
            );
            self.entities
                .routing_cursor
                .push(object_number(object, "routingCursor"));
            self.entities
                .inputs
                .push(parse_inventory(object.get("inputs"), &mut self.symbols));
            self.entities
                .outputs
                .push(parse_inventory(object.get("outputs"), &mut self.symbols));
        }
        for (index, raw) in self.belt_raw.iter().enumerate() {
            let value =
                serde_json::from_str::<Value>(raw).context("decode native core belt record")?;
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
            self.belts.progress.push(object_number(object, "progress"));
            self.belts.priorities.push(
                object
                    .get("priority")
                    .and_then(Value::as_u64)
                    .unwrap_or(1)
                    .min(2) as u8,
            );
            self.belts
                .total_transferred
                .push(object_number(object, "totalTransferred"));
            self.belts
                .congestion
                .push(object_number(object, "congestion"));
            self.belts.last_flow.push(object_number(object, "lastFlow"));
        }
        Ok(())
    }

    pub(crate) fn parse_entity(&self, index: usize) -> anyhow::Result<Value> {
        serde_json::from_str(&self.entity_raw[index]).context("decode native core entity")
    }

    pub(crate) fn parse_belt(&self, index: usize) -> anyhow::Result<Value> {
        serde_json::from_str(&self.belt_raw[index]).context("decode native core belt")
    }

    pub(crate) fn base_value_mut(&mut self) -> &mut Map<String, Value> {
        &mut self.base
    }
    pub(crate) fn base_value(&self) -> &Map<String, Value> {
        &self.base
    }
    pub(crate) fn entity_raw_mut(&mut self) -> &mut Vec<Box<str>> {
        &mut self.entity_raw
    }
    pub(crate) fn belt_raw_mut(&mut self) -> &mut Vec<Box<str>> {
        &mut self.belt_raw
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
        let hash_records = |records: &[Box<str>]| -> anyhow::Result<String> {
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

    pub fn domain_sha256(&self) -> String {
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
        for index in 0..self.entities.ids.len() {
            hasher.update(self.entities.ids[index].as_bytes());
            hasher.update(b"\0");
            for entry in &self.entities.inputs[index] {
                if let Some(item) = self.symbols.resolve(entry.item) {
                    hasher.update(item.as_bytes());
                }
                hasher.update(entry.amount.to_bits().to_le_bytes());
            }
            hasher.update(b"|");
            for entry in &self.entities.outputs[index] {
                if let Some(item) = self.symbols.resolve(entry.item) {
                    hasher.update(item.as_bytes());
                }
                hasher.update(entry.amount.to_bits().to_le_bytes());
            }
            hasher.update(self.entities.progress[index].to_bits().to_le_bytes());
            hasher.update(self.entities.utilization[index].to_bits().to_le_bytes());
            hasher.update(self.entities.production_rate[index].to_bits().to_le_bytes());
        }
        for index in 0..self.belts.ids.len() {
            hasher.update(self.belts.ids[index].as_bytes());
            hasher.update(self.belts.progress[index].to_bits().to_le_bytes());
            hasher.update(self.belts.total_transferred[index].to_bits().to_le_bytes());
            hasher.update(self.belts.last_flow[index].to_bits().to_le_bytes());
        }
        hex::encode(hasher.finalize())
    }

    pub fn memory_estimate(&self) -> RuntimeMemoryEstimate {
        let raw_record_bytes = self
            .entity_raw
            .iter()
            .chain(self.belt_raw.iter())
            .map(|value| value.len() as u64)
            .sum();
        let inventory_entry_count = self
            .entities
            .inputs
            .iter()
            .chain(self.entities.outputs.iter())
            .map(|values| values.len() as u64)
            .sum();
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
        let numeric_columns = entity_rows * 112 + belt_rows * 104;
        let index_overhead = ((self.entity_index.capacity() + self.belt_index.capacity())
            * (size_of::<String>() + size_of::<usize>())) as u64;
        let estimated_runtime_bytes = raw_record_bytes
            + indexed_string_bytes
            + inventory_entry_count * size_of::<ItemQuantity>() as u64
            + numeric_columns
            + index_overhead
            + serde_json::to_vec(&self.base)
                .map(|bytes| bytes.len() as u64)
                .unwrap_or(0);
        RuntimeMemoryEstimate {
            raw_record_bytes,
            indexed_string_bytes,
            inventory_entry_count,
            estimated_runtime_bytes,
        }
    }

    pub fn summary(&self) -> anyhow::Result<CoreStateSummary> {
        let canonical_sha256 = self.canonical_sha256()?;
        let canonical_components = self.canonical_components()?;
        let canonical_fields = self.canonical_fields()?;
        Ok(CoreStateSummary {
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
            canonical_sha256,
            canonical_components,
            canonical_fields,
            domain_sha256: self.domain_sha256(),
            catalog_sha256: self.catalog.fingerprint.clone(),
            registry_fingerprint: self.identity.registry_fingerprint.clone(),
            memory: self.memory_estimate(),
            coverage: self.coverage.clone(),
        })
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
                    system_id: "helios".into(),
                }],
                items: vec![ItemDefinition {
                    id: "iron_ore".into(),
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
        let state = CoreState::from_internal_records(
            CoreCheckpointIdentity {
                slot: "normal-main".into(),
                generation: 1,
                root_hash: "a".repeat(64),
                revision: 7,
                state_version: 47,
                mode: "normal".into(),
                registry_fingerprint: "core".into(),
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
            },
            &records,
            fixture_catalog(),
        )
        .unwrap_err();
        assert!(error.to_string().contains("duplicated"));
    }
}
