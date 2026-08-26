use std::cell::RefCell;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Component, Path, PathBuf};

use anyhow::{Context, anyhow, bail};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

const MAX_SLOT_BYTES: usize = 64;
const MAX_KEY_BYTES: usize = 512;
const MAX_RECORD_BYTES: usize = 8 * 1024 * 1024;
const MAX_WAL_ENTRY_BYTES: usize = 2 * 1024 * 1024;
const DEFAULT_RETAIN_GENERATIONS: usize = 2;

#[derive(Clone, Debug, Serialize, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChunkMetadata {
    pub hash: String,
    pub compressed_hash: String,
    pub uncompressed_bytes: u64,
    pub compressed_bytes: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SaveManifest {
    pub format_version: u16,
    pub slot: String,
    pub mode: String,
    pub state_version: u16,
    pub base_checksum: String,
    pub registry_fingerprint: String,
    pub generation: u64,
    pub previous_generation: Option<u64>,
    pub revision: u64,
    pub saved_at_ms: u64,
    pub records: BTreeMap<String, ChunkMetadata>,
    pub root_hash: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SuperblockPayload {
    format_version: u16,
    slot: String,
    generation: u64,
    revision: u64,
    manifest_hash: String,
    root_hash: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Checksummed<T> {
    payload: T,
    checksum: String,
}

#[derive(Clone, Debug)]
pub struct SaveTransaction {
    pub id: String,
    slot: String,
    mode: String,
    state_version: u16,
    base_checksum: String,
    registry_fingerprint: String,
    revision: u64,
    saved_at_ms: u64,
    previous_generation: Option<u64>,
    records: BTreeMap<String, ChunkMetadata>,
    changed_keys: HashSet<String>,
    changed_bytes: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveBeginResult {
    pub transaction_id: String,
    pub previous_generation: Option<u64>,
    pub previous_revision: Option<u64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveCommitResult {
    pub slot: String,
    pub generation: u64,
    pub revision: u64,
    pub root_hash: String,
    pub record_count: usize,
    pub changed_records: usize,
    pub changed_bytes: u64,
    pub total_uncompressed_bytes: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveRecoveryResult {
    pub slot: String,
    pub generation: u64,
    pub revision: u64,
    pub root_hash: String,
    pub state_version: u16,
    pub mode: String,
    pub base_checksum: String,
    pub registry_fingerprint: String,
    pub saved_at_ms: u64,
    pub record_keys: Vec<String>,
    pub wal_first_revision: Option<u64>,
    pub wal_last_revision: Option<u64>,
    pub wal_entry_count: usize,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WalEntry {
    pub base_revision: u64,
    pub revision: u64,
    pub command_id: String,
    pub payload: Value,
    pub previous_hash: String,
    pub entry_hash: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WalAppendResult {
    pub revision: u64,
    pub entry_hash: String,
    pub wal_bytes: u64,
    pub duplicate: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CommitFaultPoint {
    None,
    BeforeManifestWrite,
    AfterManifestSync,
    BeforeSuperblockPublish,
    AfterSuperblockPublish,
}

#[derive(Debug)]
pub struct SaveStore {
    root: PathBuf,
    next_transaction_id: u64,
    transactions: HashMap<String, SaveTransaction>,
    verified_manifests: RefCell<HashMap<String, SaveManifest>>,
}

impl SaveStore {
    pub fn open(root: impl AsRef<Path>) -> anyhow::Result<Self> {
        let root = root.as_ref();
        fs::create_dir_all(root)
            .with_context(|| format!("create native save root {}", root.display()))?;
        let root = fs::canonicalize(root)
            .with_context(|| format!("canonicalize native save root {}", root.display()))?;
        Ok(Self {
            root,
            next_transaction_id: 1,
            transactions: HashMap::new(),
            verified_manifests: RefCell::new(HashMap::new()),
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn begin(
        &mut self,
        slot: &str,
        mode: &str,
        state_version: u16,
        base_checksum: &str,
        registry_fingerprint: &str,
        revision: u64,
        saved_at_ms: u64,
    ) -> anyhow::Result<SaveBeginResult> {
        validate_slot(slot)?;
        validate_mode(mode)?;
        validate_hex_identity(base_checksum, "base checksum")?;
        validate_fingerprint(registry_fingerprint)?;
        let previous = self.recover_manifest(slot)?;
        if let Some(manifest) = previous.as_ref() {
            if revision < manifest.revision {
                bail!("native save revision cannot move backwards");
            }
            if manifest.mode != mode || manifest.state_version != state_version {
                bail!("native save identity is incompatible with the active slot");
            }
        }
        let transaction_id = format!("tx-{saved_at_ms:016x}-{:016x}", self.next_transaction_id);
        self.next_transaction_id = self
            .next_transaction_id
            .checked_add(1)
            .ok_or_else(|| anyhow!("native transaction counter exhausted"))?;
        let transaction = SaveTransaction {
            id: transaction_id.clone(),
            slot: slot.to_owned(),
            mode: mode.to_owned(),
            state_version,
            base_checksum: base_checksum.to_owned(),
            registry_fingerprint: registry_fingerprint.to_owned(),
            revision,
            saved_at_ms,
            previous_generation: previous.as_ref().map(|manifest| manifest.generation),
            records: previous
                .as_ref()
                .map(|manifest| manifest.records.clone())
                .unwrap_or_default(),
            changed_keys: HashSet::new(),
            changed_bytes: 0,
        };
        let result = SaveBeginResult {
            transaction_id: transaction_id.clone(),
            previous_generation: transaction.previous_generation,
            previous_revision: previous.as_ref().map(|manifest| manifest.revision),
        };
        self.transactions.insert(transaction_id, transaction);
        Ok(result)
    }

    pub fn put(
        &mut self,
        transaction_id: &str,
        key: &str,
        value: Option<&str>,
    ) -> anyhow::Result<()> {
        validate_key(key)?;
        let slot = self
            .transactions
            .get(transaction_id)
            .ok_or_else(|| anyhow!("unknown native save transaction"))?
            .slot
            .clone();
        let metadata = match value {
            Some(value) => {
                if value.len() > MAX_RECORD_BYTES {
                    bail!("native save record exceeds the bounded write limit");
                }
                Some(self.write_chunk(&slot, value.as_bytes())?)
            }
            None => None,
        };
        let transaction = self
            .transactions
            .get_mut(transaction_id)
            .ok_or_else(|| anyhow!("native save transaction disappeared"))?;
        let changed = match metadata {
            Some(metadata) => {
                let same = transaction.records.get(key) == Some(&metadata);
                if !same {
                    transaction.changed_bytes = transaction
                        .changed_bytes
                        .saturating_add(metadata.compressed_bytes);
                    transaction.records.insert(key.to_owned(), metadata);
                }
                !same
            }
            None => transaction.records.remove(key).is_some(),
        };
        if changed {
            transaction.changed_keys.insert(key.to_owned());
        }
        Ok(())
    }

    pub fn abort(&mut self, transaction_id: &str) -> bool {
        self.transactions.remove(transaction_id).is_some()
    }

    pub fn commit(&mut self, transaction_id: &str) -> anyhow::Result<SaveCommitResult> {
        self.commit_with_fault(transaction_id, CommitFaultPoint::None)
    }

    pub fn commit_with_fault(
        &mut self,
        transaction_id: &str,
        fault: CommitFaultPoint,
    ) -> anyhow::Result<SaveCommitResult> {
        let transaction = self
            .transactions
            .remove(transaction_id)
            .ok_or_else(|| anyhow!("unknown native save transaction"))?;
        let generation = transaction
            .previous_generation
            .unwrap_or(0)
            .checked_add(1)
            .ok_or_else(|| anyhow!("native save generation exhausted"))?;
        let mut manifest = SaveManifest {
            format_version: crate::NATIVE_FORMAT_VERSION,
            slot: transaction.slot.clone(),
            mode: transaction.mode,
            state_version: transaction.state_version,
            base_checksum: transaction.base_checksum,
            registry_fingerprint: transaction.registry_fingerprint,
            generation,
            previous_generation: transaction.previous_generation,
            revision: transaction.revision,
            saved_at_ms: transaction.saved_at_ms,
            records: transaction.records,
            root_hash: String::new(),
        };
        manifest.root_hash = manifest_root_hash(&manifest)?;
        if fault == CommitFaultPoint::BeforeManifestWrite {
            bail!("injected failure before manifest write");
        }
        let manifest_bytes = serde_json::to_vec(&manifest)?;
        let manifest_hash = sha256_hex(&manifest_bytes);
        let generation_dir = self.generation_dir(&transaction.slot, generation)?;
        fs::create_dir_all(&generation_dir)?;
        atomic_write_new(&generation_dir.join("manifest.json"), &manifest_bytes)?;
        sync_directory(&generation_dir)?;
        if fault == CommitFaultPoint::AfterManifestSync {
            bail!("injected failure after manifest sync");
        }
        let payload = SuperblockPayload {
            format_version: crate::NATIVE_FORMAT_VERSION,
            slot: transaction.slot.clone(),
            generation,
            revision: transaction.revision,
            manifest_hash,
            root_hash: manifest.root_hash.clone(),
        };
        let superblock = checksummed(payload)?;
        let superblock_bytes = serde_json::to_vec(&superblock)?;
        if fault == CommitFaultPoint::BeforeSuperblockPublish {
            bail!("injected failure before superblock publish");
        }
        let superblock_target = self
            .slot_dir(&transaction.slot)?
            .join(if generation % 2 == 0 {
                "superblock-a.json"
            } else {
                "superblock-b.json"
            });
        atomic_replace(&superblock_target, &superblock_bytes)?;
        sync_directory(&self.slot_dir(&transaction.slot)?)?;
        if fault == CommitFaultPoint::AfterSuperblockPublish {
            self.verified_manifests
                .borrow_mut()
                .remove(&transaction.slot);
            bail!("injected failure after superblock publish");
        }
        self.verified_manifests
            .borrow_mut()
            .insert(transaction.slot.clone(), manifest.clone());
        let total_uncompressed_bytes = manifest
            .records
            .values()
            .map(|metadata| metadata.uncompressed_bytes)
            .sum();
        Ok(SaveCommitResult {
            slot: transaction.slot,
            generation,
            revision: transaction.revision,
            root_hash: manifest.root_hash,
            record_count: manifest.records.len(),
            changed_records: transaction.changed_keys.len(),
            changed_bytes: transaction.changed_bytes,
            total_uncompressed_bytes,
        })
    }

    pub fn recover(&self, slot: &str) -> anyhow::Result<Option<SaveRecoveryResult>> {
        let Some(manifest) = self.recover_manifest(slot)? else {
            return Ok(None);
        };
        let wal = self.read_wal(slot, manifest.revision)?;
        Ok(Some(SaveRecoveryResult {
            slot: manifest.slot,
            generation: manifest.generation,
            revision: manifest.revision,
            root_hash: manifest.root_hash,
            state_version: manifest.state_version,
            mode: manifest.mode,
            base_checksum: manifest.base_checksum,
            registry_fingerprint: manifest.registry_fingerprint,
            saved_at_ms: manifest.saved_at_ms,
            record_keys: manifest.records.keys().cloned().collect(),
            wal_first_revision: wal.first().map(|entry| entry.revision),
            wal_last_revision: wal.last().map(|entry| entry.revision),
            wal_entry_count: wal.len(),
        }))
    }

    pub fn read_record(&self, slot: &str, key: &str) -> anyhow::Result<Option<Vec<u8>>> {
        validate_key(key)?;
        let Some(manifest) = self.recover_manifest(slot)? else {
            return Ok(None);
        };
        let Some(metadata) = manifest.records.get(key) else {
            return Ok(None);
        };
        Ok(Some(self.read_verified_chunk(slot, metadata)?))
    }

    fn read_verified_chunk(&self, slot: &str, metadata: &ChunkMetadata) -> anyhow::Result<Vec<u8>> {
        let compressed = fs::read(self.chunk_path(slot, &metadata.hash)?)?;
        if compressed.len() as u64 != metadata.compressed_bytes
            || sha256_hex(&compressed) != metadata.compressed_hash
        {
            bail!("native save chunk compressed length is invalid");
        }
        let decoded = zstd::stream::decode_all(compressed.as_slice())?;
        if decoded.len() as u64 != metadata.uncompressed_bytes
            || sha256_hex(&decoded) != metadata.hash
        {
            bail!("native save chunk hash is invalid");
        }
        Ok(decoded)
    }

    pub fn read_record_at(
        &self,
        slot: &str,
        key: &str,
        generation: u64,
        root_hash: &str,
    ) -> anyhow::Result<Option<Vec<u8>>> {
        let manifest = self
            .recover_manifest(slot)?
            .ok_or_else(|| anyhow!("native save slot is missing"))?;
        if manifest.generation != generation || manifest.root_hash != root_hash {
            bail!("native save generation changed during readback");
        }
        validate_key(key)?;
        manifest
            .records
            .get(key)
            .map(|metadata| self.read_verified_chunk(slot, metadata))
            .transpose()
    }

    /// Reads one immutable generation after a single identity check. Native
    /// core startup previously called `recover()` for every logical record,
    /// repeatedly reopening and decoding the same WAL while loading a large
    /// checkpoint. The host is single-threaded and generations are immutable,
    /// so this bounded per-record loop preserves the exact verification model.
    pub fn read_records_at(
        &self,
        slot: &str,
        keys: &[String],
        generation: u64,
        root_hash: &str,
    ) -> anyhow::Result<BTreeMap<String, Vec<u8>>> {
        let manifest = self
            .recover_manifest(slot)?
            .ok_or_else(|| anyhow!("native save slot is missing"))?;
        if manifest.generation != generation || manifest.root_hash != root_hash {
            bail!("native save generation changed during readback");
        }
        let mut records = BTreeMap::new();
        for key in keys {
            validate_key(key)?;
            if records.contains_key(key) {
                bail!("native save record read repeats a key");
            }
            let metadata = manifest
                .records
                .get(key)
                .ok_or_else(|| anyhow!("native save record disappeared during readback"))?;
            records.insert(key.clone(), self.read_verified_chunk(slot, metadata)?);
        }
        Ok(records)
    }

    pub fn append_wal(
        &self,
        slot: &str,
        base_revision: u64,
        revision: u64,
        command_id: &str,
        payload: Value,
    ) -> anyhow::Result<WalAppendResult> {
        self.append_wal_internal(slot, base_revision, revision, command_id, payload, false)
    }

    /// Append an authority operation with an idempotency key. A renderer may
    /// lose the response after `sync_all` even though the command is already
    /// durable. Retrying the exact same operation returns the original receipt;
    /// reusing the key for different bytes fails closed.
    pub fn append_wal_idempotent(
        &self,
        slot: &str,
        base_revision: u64,
        revision: u64,
        command_id: &str,
        payload: Value,
    ) -> anyhow::Result<WalAppendResult> {
        self.append_wal_internal(slot, base_revision, revision, command_id, payload, true)
    }

    pub fn find_wal_command(
        &self,
        slot: &str,
        command_id: &str,
    ) -> anyhow::Result<Option<WalEntry>> {
        validate_slot(slot)?;
        validate_command_id(command_id)?;
        let wal_path = self.wal_path(slot)?;
        if !wal_path.exists() {
            return Ok(None);
        }
        Ok(decode_all_wal_bytes(&fs::read(wal_path)?)?
            .into_iter()
            .find(|entry| entry.command_id == command_id))
    }

    fn append_wal_internal(
        &self,
        slot: &str,
        base_revision: u64,
        revision: u64,
        command_id: &str,
        payload: Value,
        allow_identical_duplicate: bool,
    ) -> anyhow::Result<WalAppendResult> {
        validate_slot(slot)?;
        validate_command_id(command_id)?;
        let checkpoint_revision = self
            .recover_manifest(slot)?
            .map(|manifest| manifest.revision)
            .unwrap_or(0);
        let wal_path = self.wal_path(slot)?;
        let all_entries = if wal_path.exists() {
            decode_all_wal_bytes(&fs::read(&wal_path)?)?
        } else {
            Vec::new()
        };
        if let Some(existing) = all_entries
            .iter()
            .find(|entry| entry.command_id == command_id)
        {
            if !allow_identical_duplicate {
                bail!("native WAL command ID is duplicated");
            }
            if existing.base_revision != base_revision
                || existing.revision != revision
                || existing.payload != payload
            {
                bail!("native WAL idempotency key conflicts with another operation");
            }
            return Ok(WalAppendResult {
                revision: existing.revision,
                entry_hash: existing.entry_hash.clone(),
                wal_bytes: fs::metadata(&wal_path)?.len(),
                duplicate: true,
            });
        }
        let active_entries = all_entries
            .iter()
            .filter(|entry| entry.revision > checkpoint_revision)
            .collect::<Vec<_>>();
        let expected_base_revision = active_entries
            .last()
            .map(|entry| entry.revision)
            .unwrap_or(checkpoint_revision);
        if base_revision != expected_base_revision || revision <= base_revision {
            bail!("native WAL revision range is not contiguous");
        }
        let previous_hash = all_entries
            .last()
            .map(|entry| entry.entry_hash.clone())
            .unwrap_or_else(|| "0".repeat(64));
        let entry_hash = wal_entry_hash(
            base_revision,
            revision,
            command_id,
            &payload,
            &previous_hash,
        )?;
        let entry = WalEntry {
            base_revision,
            revision,
            command_id: command_id.to_owned(),
            payload,
            previous_hash,
            entry_hash: entry_hash.clone(),
        };
        let encoded = serde_json::to_vec(&entry)?;
        if encoded.len() > MAX_WAL_ENTRY_BYTES {
            bail!("native WAL entry exceeds the bounded write limit");
        }
        fs::create_dir_all(wal_path.parent().expect("wal parent"))?;
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&wal_path)?;
        let mut crc = crc32fast::Hasher::new();
        crc.update(&encoded);
        file.write_all(&(encoded.len() as u32).to_le_bytes())?;
        file.write_all(&crc.finalize().to_le_bytes())?;
        file.write_all(&encoded)?;
        file.sync_all()?;
        Ok(WalAppendResult {
            revision,
            entry_hash,
            wal_bytes: file.metadata()?.len(),
            duplicate: false,
        })
    }

    pub fn read_wal(&self, slot: &str, checkpoint_revision: u64) -> anyhow::Result<Vec<WalEntry>> {
        validate_slot(slot)?;
        let path = self.wal_path(slot)?;
        if !path.exists() {
            return Ok(Vec::new());
        }
        decode_wal_bytes(&fs::read(path)?, checkpoint_revision)
    }

    pub fn compact(&self, slot: &str, retain_generations: usize) -> anyhow::Result<usize> {
        validate_slot(slot)?;
        let retain_generations = retain_generations.max(DEFAULT_RETAIN_GENERATIONS);
        let Some(active) = self.recover_manifest(slot)? else {
            return Ok(0);
        };
        let generations_root = self.slot_dir(slot)?.join("generations");
        if !generations_root.exists() {
            return Ok(0);
        }
        let mut generations = fs::read_dir(&generations_root)?
            .filter_map(Result::ok)
            .filter_map(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .parse::<u64>()
                    .ok()
                    .map(|generation| (generation, entry.path()))
            })
            .collect::<Vec<_>>();
        generations.sort_by_key(|(generation, _)| *generation);
        let keep_floor = active
            .generation
            .saturating_sub((retain_generations - 1) as u64);
        let mut removed = 0;
        for (generation, path) in generations {
            if generation >= keep_floor || generation == active.generation {
                continue;
            }
            if !path.starts_with(&generations_root) {
                bail!("native generation cleanup escaped its root");
            }
            fs::remove_dir_all(path)?;
            removed += 1;
        }
        self.collect_unreferenced_chunks(slot)?;
        Ok(removed)
    }

    fn collect_unreferenced_chunks(&self, slot: &str) -> anyhow::Result<()> {
        let slot_dir = self.slot_dir(slot)?;
        let generations_root = slot_dir.join("generations");
        let mut referenced = HashSet::new();
        if generations_root.exists() {
            for entry in fs::read_dir(&generations_root)? {
                let entry = entry?;
                let manifest_path = entry.path().join("manifest.json");
                if !manifest_path.exists() {
                    continue;
                }
                if let Ok(manifest) =
                    serde_json::from_slice::<SaveManifest>(&fs::read(manifest_path)?)
                {
                    referenced.extend(
                        manifest
                            .records
                            .values()
                            .map(|metadata| metadata.hash.clone()),
                    );
                }
            }
        }
        let chunks_root = slot_dir.join("chunks");
        if !chunks_root.exists() {
            return Ok(());
        }
        for entry in fs::read_dir(&chunks_root)? {
            let entry = entry?;
            let path = entry.path();
            let Some(name) = path.file_stem().and_then(|value| value.to_str()) else {
                continue;
            };
            if referenced.contains(name) {
                continue;
            }
            if !path.starts_with(&chunks_root) {
                bail!("native chunk cleanup escaped its root")
            }
            fs::remove_file(path)?;
        }
        Ok(())
    }

    fn recover_manifest(&self, slot: &str) -> anyhow::Result<Option<SaveManifest>> {
        validate_slot(slot)?;
        if let Some(manifest) = self.verified_manifests.borrow().get(slot) {
            return Ok(Some(manifest.clone()));
        }
        let slot_dir = self.slot_dir(slot)?;
        if !slot_dir.exists() {
            return Ok(None);
        }
        // Superblock/manifest identities are cheap to validate. Rank those
        // first, then verify chunk payloads newest-to-oldest and stop at the
        // first valid generation. The previous implementation decompressed
        // both retained generations even when the newest one was healthy.
        let mut candidates = Vec::new();
        for name in ["superblock-a.json", "superblock-b.json"] {
            let path = slot_dir.join(name);
            if !path.exists() {
                continue;
            }
            let Ok(bytes) = fs::read(path) else { continue };
            let Ok(superblock) = decode_superblock(slot, &bytes) else {
                continue;
            };
            let manifest_path = self
                .generation_dir(slot, superblock.generation)?
                .join("manifest.json");
            let Ok(manifest_bytes) = fs::read(manifest_path) else {
                continue;
            };
            let manifest = verify_generation_identity(slot, &superblock, &manifest_bytes);
            let Ok(manifest) = manifest else {
                continue;
            };
            candidates.push(manifest);
        }
        candidates.sort_by_key(|manifest| (manifest.revision, manifest.generation));
        let mut recovered = None;
        while let Some(manifest) = candidates.pop() {
            let verified = verify_manifest_chunks(&manifest, |hash| {
                fs::read(self.chunk_path(slot, hash)?).map_err(Into::into)
            });
            if verified.is_ok() {
                recovered = Some(manifest);
                break;
            }
        }
        if let Some(manifest) = recovered.as_ref() {
            self.verified_manifests
                .borrow_mut()
                .insert(slot.to_owned(), manifest.clone());
        }
        Ok(recovered)
    }

    fn write_chunk(&self, slot: &str, bytes: &[u8]) -> anyhow::Result<ChunkMetadata> {
        let hash = sha256_hex(bytes);
        let path = self.chunk_path(slot, &hash)?;
        fs::create_dir_all(path.parent().expect("chunk parent"))?;
        if path.exists() {
            let compressed = fs::read(&path)?;
            return Ok(ChunkMetadata {
                hash,
                compressed_hash: sha256_hex(&compressed),
                uncompressed_bytes: bytes.len() as u64,
                compressed_bytes: compressed.len() as u64,
            });
        }
        let compressed = zstd::stream::encode_all(bytes, 3)?;
        atomic_write_new(&path, &compressed)?;
        Ok(ChunkMetadata {
            hash,
            compressed_hash: sha256_hex(&compressed),
            uncompressed_bytes: bytes.len() as u64,
            compressed_bytes: compressed.len() as u64,
        })
    }

    fn slot_dir(&self, slot: &str) -> anyhow::Result<PathBuf> {
        validate_slot(slot)?;
        safe_child(&self.root, slot)
    }

    fn generation_dir(&self, slot: &str, generation: u64) -> anyhow::Result<PathBuf> {
        safe_child(
            &self.slot_dir(slot)?.join("generations"),
            &generation.to_string(),
        )
    }

    fn chunk_path(&self, slot: &str, hash: &str) -> anyhow::Result<PathBuf> {
        validate_hex_identity(hash, "chunk hash")?;
        safe_child(&self.slot_dir(slot)?.join("chunks"), &format!("{hash}.zst"))
    }

    fn wal_path(&self, slot: &str) -> anyhow::Result<PathBuf> {
        Ok(self.slot_dir(slot)?.join("wal").join("active.wal"))
    }
}

fn decode_superblock(slot: &str, bytes: &[u8]) -> anyhow::Result<SuperblockPayload> {
    let superblock = serde_json::from_slice::<Checksummed<SuperblockPayload>>(bytes)?;
    verify_checksummed(&superblock)?;
    if superblock.payload.slot != slot
        || superblock.payload.format_version != crate::NATIVE_FORMAT_VERSION
    {
        bail!("native superblock identity is invalid");
    }
    Ok(superblock.payload)
}

#[cfg(test)]
fn verify_generation_artifacts(
    slot: &str,
    superblock: &SuperblockPayload,
    manifest_bytes: &[u8],
    read_chunk: impl FnMut(&str) -> anyhow::Result<Vec<u8>>,
) -> anyhow::Result<SaveManifest> {
    let manifest = verify_generation_identity(slot, superblock, manifest_bytes)?;
    verify_manifest_chunks(&manifest, read_chunk)?;
    Ok(manifest)
}

fn verify_generation_identity(
    slot: &str,
    superblock: &SuperblockPayload,
    manifest_bytes: &[u8],
) -> anyhow::Result<SaveManifest> {
    if sha256_hex(manifest_bytes) != superblock.manifest_hash {
        bail!("native manifest digest mismatch");
    }
    let manifest = serde_json::from_slice::<SaveManifest>(manifest_bytes)?;
    if manifest.slot != slot
        || manifest.generation != superblock.generation
        || manifest.revision != superblock.revision
        || manifest.root_hash != superblock.root_hash
        || manifest_root_hash(&manifest)? != manifest.root_hash
    {
        bail!("native manifest identity is invalid");
    }
    Ok(manifest)
}

fn verify_manifest_chunks(
    manifest: &SaveManifest,
    mut read_chunk: impl FnMut(&str) -> anyhow::Result<Vec<u8>>,
) -> anyhow::Result<()> {
    for metadata in manifest.records.values() {
        validate_hex_identity(&metadata.hash, "chunk hash")?;
        let compressed = read_chunk(&metadata.hash)?;
        if compressed.len() as u64 != metadata.compressed_bytes
            || sha256_hex(&compressed) != metadata.compressed_hash
        {
            bail!("native chunk length mismatch");
        }
        let decoded = zstd::stream::decode_all(compressed.as_slice())?;
        if decoded.len() as u64 != metadata.uncompressed_bytes
            || sha256_hex(&decoded) != metadata.hash
        {
            bail!("native chunk digest mismatch");
        }
    }
    Ok(())
}

fn decode_all_wal_bytes(bytes: &[u8]) -> anyhow::Result<Vec<WalEntry>> {
    let mut all_entries = Vec::new();
    let mut previous_hash = "0".repeat(64);
    let mut previous_revision: Option<u64> = None;
    let mut offset = 0;
    while offset < bytes.len() {
        if bytes.len() - offset < 8 {
            bail!("native WAL is truncated before an entry header");
        }
        let length = u32::from_le_bytes(
            bytes[offset..offset + 4]
                .try_into()
                .expect("fixed WAL length"),
        ) as usize;
        let expected_crc = u32::from_le_bytes(
            bytes[offset + 4..offset + 8]
                .try_into()
                .expect("fixed WAL CRC"),
        );
        offset += 8;
        if length == 0 || length > MAX_WAL_ENTRY_BYTES {
            bail!("native WAL entry length is invalid");
        }
        if bytes.len() - offset < length {
            bail!("native WAL is truncated inside an entry");
        }
        let encoded = &bytes[offset..offset + length];
        offset += length;
        let mut crc = crc32fast::Hasher::new();
        crc.update(encoded);
        if crc.finalize() != expected_crc {
            bail!("native WAL checksum is invalid");
        }
        let entry: WalEntry = serde_json::from_slice(encoded)?;
        if entry.revision <= entry.base_revision
            || previous_revision
                .is_some_and(|previous_revision| entry.revision <= previous_revision)
        {
            bail!("native WAL revision range is invalid");
        }
        if entry.previous_hash != previous_hash
            || entry.entry_hash
                != wal_entry_hash(
                    entry.base_revision,
                    entry.revision,
                    &entry.command_id,
                    &entry.payload,
                    &entry.previous_hash,
                )?
        {
            bail!("native WAL chain is not contiguous");
        }
        previous_revision = Some(entry.revision);
        previous_hash = entry.entry_hash.clone();
        all_entries.push(entry);
    }
    let mut ids = HashSet::new();
    if all_entries
        .iter()
        .any(|entry| !ids.insert(entry.command_id.as_str()))
    {
        bail!("native WAL contains a duplicated command ID");
    }
    Ok(all_entries)
}

fn decode_wal_bytes(bytes: &[u8], checkpoint_revision: u64) -> anyhow::Result<Vec<WalEntry>> {
    let entries = decode_all_wal_bytes(bytes)?
        .into_iter()
        .filter(|entry| entry.revision > checkpoint_revision)
        .collect::<Vec<_>>();
    if let Some(first) = entries.first()
        && first.base_revision != checkpoint_revision
    {
        bail!("native WAL does not continue the checkpoint revision");
    }
    if entries
        .windows(2)
        .any(|window| window[1].base_revision != window[0].revision)
    {
        bail!("native WAL is not contiguous after the checkpoint");
    }
    Ok(entries)
}

fn validate_slot(value: &str) -> anyhow::Result<()> {
    if value.is_empty()
        || value.len() > MAX_SLOT_BYTES
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        bail!("native save slot is invalid");
    }
    Ok(())
}

fn validate_key(value: &str) -> anyhow::Result<()> {
    if value.is_empty()
        || value.len() > MAX_KEY_BYTES
        || value.contains('\0')
        || value.contains("..")
        || value.contains(['/', '\\'])
    {
        bail!("native save record key is invalid");
    }
    Ok(())
}

fn validate_mode(value: &str) -> anyhow::Result<()> {
    if !matches!(value, "normal" | "speedrun") {
        bail!("native save mode is invalid")
    }
    Ok(())
}

fn validate_fingerprint(value: &str) -> anyhow::Result<()> {
    if value.is_empty()
        || value.len() > 256
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b':' | b'.'))
    {
        bail!("native registry fingerprint is invalid")
    }
    Ok(())
}

fn validate_command_id(value: &str) -> anyhow::Result<()> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b':' | b'.'))
    {
        bail!("native WAL command ID is invalid")
    }
    Ok(())
}

fn validate_hex_identity(value: &str, label: &str) -> anyhow::Result<()> {
    if value.len() < 8 || value.len() > 128 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        bail!("{label} is invalid")
    }
    Ok(())
}

fn safe_child(parent: &Path, child: &str) -> anyhow::Result<PathBuf> {
    let candidate = parent.join(child);
    if Path::new(child)
        .components()
        .any(|component| !matches!(component, Component::Normal(_)))
    {
        bail!("native path component is invalid")
    }
    Ok(candidate)
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn manifest_root_hash(manifest: &SaveManifest) -> anyhow::Result<String> {
    let mut root = manifest.clone();
    root.root_hash.clear();
    Ok(sha256_hex(&serde_json::to_vec(&root)?))
}

fn wal_entry_hash(
    base_revision: u64,
    revision: u64,
    command_id: &str,
    payload: &Value,
    previous_hash: &str,
) -> anyhow::Result<String> {
    Ok(sha256_hex(&serde_json::to_vec(&(
        base_revision,
        revision,
        command_id,
        payload,
        previous_hash,
    ))?))
}

fn checksummed<T>(payload: T) -> anyhow::Result<Checksummed<T>>
where
    T: Serialize,
{
    let checksum = sha256_hex(&serde_json::to_vec(&payload)?);
    Ok(Checksummed { payload, checksum })
}

fn verify_checksummed<T>(value: &Checksummed<T>) -> anyhow::Result<()>
where
    T: Serialize,
{
    if sha256_hex(&serde_json::to_vec(&value.payload)?) != value.checksum {
        bail!("checksummed native record is invalid")
    }
    Ok(())
}

fn atomic_write_new(path: &Path, bytes: &[u8]) -> anyhow::Result<()> {
    if path.exists() {
        let existing = fs::read(path)?;
        if existing == bytes {
            return Ok(());
        }
        bail!("immutable native path already contains different data")
    }
    let parent = path
        .parent()
        .ok_or_else(|| anyhow!("native write has no parent"))?;
    fs::create_dir_all(parent)?;
    let temporary = parent.join(format!(
        ".{}.tmp-{}",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("native"),
        std::process::id()
    ));
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    match fs::rename(&temporary, path) {
        Ok(()) => {}
        Err(error) if path.exists() => {
            let _ = fs::remove_file(&temporary);
            let existing = fs::read(path)?;
            if existing != bytes {
                return Err(error.into());
            }
        }
        Err(error) => return Err(error.into()),
    }
    sync_directory(parent)?;
    Ok(())
}

fn atomic_replace(path: &Path, bytes: &[u8]) -> anyhow::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| anyhow!("native replace has no parent"))?;
    fs::create_dir_all(parent)?;
    let temporary = parent.join(format!(
        ".{}.tmp-{}",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("native"),
        std::process::id()
    ));
    if temporary.exists() {
        fs::remove_file(&temporary)?
    }
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    if path.exists() {
        fs::remove_file(path)?
    }
    fs::rename(&temporary, path)?;
    sync_directory(parent)?;
    Ok(())
}

fn sync_directory(path: &Path) -> anyhow::Result<()> {
    match File::open(path).and_then(|file| file.sync_all()) {
        Ok(()) => Ok(()),
        Err(error)
            if cfg!(windows)
                && matches!(
                    error.kind(),
                    std::io::ErrorKind::PermissionDenied | std::io::ErrorKind::InvalidInput
                ) =>
        {
            Ok(())
        }
        Err(error) => Err(error.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn begin(store: &mut SaveStore, revision: u64) -> String {
        store
            .begin(
                "normal-main",
                "normal",
                47,
                "01234567",
                "builtin:test",
                revision,
                1000 + revision,
            )
            .unwrap()
            .transaction_id
    }

    #[test]
    fn immutable_chunks_and_dual_superblocks_recover_latest_revision() {
        let root = tempdir().unwrap();
        let mut store = SaveStore::open(root.path()).unwrap();
        let tx = begin(&mut store, 1);
        store.put(&tx, "base", Some("{\"version\":47}")).unwrap();
        store.put(&tx, "entities:00000000", Some("[]")).unwrap();
        let first = store.commit(&tx).unwrap();
        assert_eq!(first.generation, 1);
        let tx = begin(&mut store, 2);
        store
            .put(&tx, "entities:00000000", Some("[{\"id\":\"a\"}]"))
            .unwrap();
        let second = store.commit(&tx).unwrap();
        assert_eq!(second.generation, 2);
        let recovered = store.recover("normal-main").unwrap().unwrap();
        assert_eq!((recovered.generation, recovered.revision), (2, 2));
        assert_eq!(
            store
                .read_record("normal-main", "entities:00000000")
                .unwrap()
                .unwrap(),
            b"[{\"id\":\"a\"}]"
        );
        let records = store
            .read_records_at(
                "normal-main",
                &["base".to_owned(), "entities:00000000".to_owned()],
                second.generation,
                &second.root_hash,
            )
            .unwrap();
        assert_eq!(records["base"], b"{\"version\":47}");
        assert_eq!(records["entities:00000000"], b"[{\"id\":\"a\"}]");
        assert!(
            store
                .read_records_at(
                    "normal-main",
                    &["base".to_owned()],
                    first.generation,
                    &first.root_hash,
                )
                .is_err()
        );
    }

    #[test]
    fn unpublished_manifest_never_replaces_previous_generation() {
        for fault in [
            CommitFaultPoint::BeforeManifestWrite,
            CommitFaultPoint::AfterManifestSync,
            CommitFaultPoint::BeforeSuperblockPublish,
        ] {
            let root = tempdir().unwrap();
            let mut store = SaveStore::open(root.path()).unwrap();
            let tx = begin(&mut store, 1);
            store.put(&tx, "base", Some("old")).unwrap();
            store.commit(&tx).unwrap();
            let tx = begin(&mut store, 2);
            store.put(&tx, "base", Some("new")).unwrap();
            assert!(store.commit_with_fault(&tx, fault).is_err());
            assert_eq!(store.recover("normal-main").unwrap().unwrap().revision, 1);
            assert_eq!(
                store.read_record("normal-main", "base").unwrap().unwrap(),
                b"old"
            );
        }
    }

    #[test]
    fn published_superblock_is_a_valid_commit_even_if_ack_is_lost() {
        let root = tempdir().unwrap();
        let mut store = SaveStore::open(root.path()).unwrap();
        let tx = begin(&mut store, 1);
        store.put(&tx, "base", Some("old")).unwrap();
        store.commit(&tx).unwrap();
        let tx = begin(&mut store, 2);
        store.put(&tx, "base", Some("new")).unwrap();
        assert!(
            store
                .commit_with_fault(&tx, CommitFaultPoint::AfterSuperblockPublish)
                .is_err()
        );
        assert_eq!(store.recover("normal-main").unwrap().unwrap().revision, 2);
        assert_eq!(
            store.read_record("normal-main", "base").unwrap().unwrap(),
            b"new"
        );
    }

    #[test]
    fn wal_requires_a_contiguous_hash_chain() {
        let root = tempdir().unwrap();
        let mut store = SaveStore::open(root.path()).unwrap();
        let tx = begin(&mut store, 5);
        store.put(&tx, "base", Some("state")).unwrap();
        store.commit(&tx).unwrap();
        store
            .append_wal(
                "normal-main",
                5,
                6,
                "command-6",
                serde_json::json!({"seconds": 1}),
            )
            .unwrap();
        store
            .append_wal(
                "normal-main",
                6,
                8,
                "command-and-advance-8",
                serde_json::json!({"seconds": 1}),
            )
            .unwrap();
        assert!(
            store
                .append_wal("normal-main", 9, 10, "command-10", serde_json::json!({}))
                .is_err()
        );
        let recovered = store.recover("normal-main").unwrap().unwrap();
        assert_eq!(
            (
                recovered.wal_first_revision,
                recovered.wal_last_revision,
                recovered.wal_entry_count
            ),
            (Some(6), Some(8), 2)
        );
    }

    #[test]
    fn authority_wal_retry_is_idempotent_but_key_reuse_conflicts() {
        let root = tempdir().unwrap();
        let mut store = SaveStore::open(root.path()).unwrap();
        let tx = begin(&mut store, 5);
        store.put(&tx, "base", Some("state")).unwrap();
        store.commit(&tx).unwrap();
        let payload = serde_json::json!({"kind":"stable-operation-v1","seconds":1});
        let first = store
            .append_wal_idempotent("normal-main", 5, 6, "authority-6", payload.clone())
            .unwrap();
        let retry = store
            .append_wal_idempotent("normal-main", 5, 6, "authority-6", payload)
            .unwrap();
        assert!(!first.duplicate);
        assert!(retry.duplicate);
        assert_eq!(retry.entry_hash, first.entry_hash);
        assert_eq!(retry.wal_bytes, first.wal_bytes);
        assert!(
            store
                .append_wal_idempotent(
                    "normal-main",
                    5,
                    6,
                    "authority-6",
                    serde_json::json!({"kind":"stable-operation-v1","seconds":2}),
                )
                .is_err()
        );
        assert_eq!(store.read_wal("normal-main", 5).unwrap().len(), 1);
    }

    #[test]
    fn traversal_is_rejected() {
        let root = tempdir().unwrap();
        let mut store = SaveStore::open(root.path()).unwrap();
        assert!(
            store
                .begin("../escape", "normal", 47, "01234567", "builtin:test", 1, 1)
                .is_err()
        );
        let tx = begin(&mut store, 1);
        assert!(store.put(&tx, "../escape", Some("bad")).is_err());
    }

    #[test]
    fn ten_thousand_deterministic_faults_never_pass_integrity_verification() {
        let root = tempdir().unwrap();
        let mut store = SaveStore::open(root.path()).unwrap();
        let tx = begin(&mut store, 1);
        store
            .put(&tx, "base", Some("{\"version\":47,\"elapsedSeconds\":0}"))
            .unwrap();
        store
            .put(
                &tx,
                "entities:00000000",
                Some("[{\"id\":\"a\",\"progress\":0}]"),
            )
            .unwrap();
        store
            .put(
                &tx,
                "belts:00000000",
                Some("[{\"id\":\"b\",\"lastFlow\":0}]"),
            )
            .unwrap();
        store.commit(&tx).unwrap();
        store
            .append_wal(
                "normal-main",
                1,
                2,
                "command-2",
                serde_json::json!({ "simulationSeconds": 1 }),
            )
            .unwrap();
        store
            .append_wal(
                "normal-main",
                2,
                3,
                "command-3",
                serde_json::json!({ "simulationSeconds": 1 }),
            )
            .unwrap();

        let slot_dir = store.slot_dir("normal-main").unwrap();
        let superblock_bytes = fs::read(slot_dir.join("superblock-b.json")).unwrap();
        let superblock = decode_superblock("normal-main", &superblock_bytes).unwrap();
        let manifest_bytes = fs::read(
            store
                .generation_dir("normal-main", 1)
                .unwrap()
                .join("manifest.json"),
        )
        .unwrap();
        let manifest: SaveManifest = serde_json::from_slice(&manifest_bytes).unwrap();
        let chunks = manifest
            .records
            .values()
            .map(|metadata| {
                (
                    metadata.hash.clone(),
                    fs::read(store.chunk_path("normal-main", &metadata.hash).unwrap()).unwrap(),
                )
            })
            .collect::<HashMap<_, _>>();
        let wal_bytes = fs::read(store.wal_path("normal-main").unwrap()).unwrap();
        verify_generation_artifacts("normal-main", &superblock, &manifest_bytes, |hash| {
            chunks
                .get(hash)
                .cloned()
                .ok_or_else(|| anyhow!("missing test chunk"))
        })
        .unwrap();
        assert_eq!(decode_wal_bytes(&wal_bytes, 1).unwrap().len(), 2);

        let mut random = 0x9e37_79b9_7f4a_7c15_u64;
        let mut detected = 0;
        for iteration in 0..10_000_u64 {
            random ^= random << 13;
            random ^= random >> 7;
            random ^= random << 17;
            let scenario = (random ^ iteration) % 8;
            let rejected = match scenario {
                0 => {
                    let mut corrupt = superblock_bytes.clone();
                    let index = (random as usize) % corrupt.len();
                    corrupt[index] ^= 0x01;
                    decode_superblock("normal-main", &corrupt).is_err()
                }
                1 => {
                    let end = 1 + (random as usize % (superblock_bytes.len() - 1));
                    decode_superblock("normal-main", &superblock_bytes[..end]).is_err()
                }
                2 | 3 => {
                    let mut corrupt = manifest_bytes.clone();
                    if scenario == 2 {
                        let index = (random as usize) % corrupt.len();
                        corrupt[index] ^= 0x04;
                    } else {
                        corrupt.truncate(1 + (random as usize % (corrupt.len() - 1)));
                    }
                    verify_generation_artifacts("normal-main", &superblock, &corrupt, |hash| {
                        chunks
                            .get(hash)
                            .cloned()
                            .ok_or_else(|| anyhow!("missing test chunk"))
                    })
                    .is_err()
                }
                4 | 5 => {
                    let selected = chunks
                        .keys()
                        .nth((random as usize) % chunks.len())
                        .unwrap()
                        .clone();
                    let mut corrupt_chunks = chunks.clone();
                    if scenario == 4 {
                        let value = corrupt_chunks.get_mut(&selected).unwrap();
                        let index = (random as usize) % value.len();
                        value[index] ^= 0x20;
                    } else {
                        corrupt_chunks.remove(&selected);
                    }
                    verify_generation_artifacts(
                        "normal-main",
                        &superblock,
                        &manifest_bytes,
                        |hash| {
                            corrupt_chunks
                                .get(hash)
                                .cloned()
                                .ok_or_else(|| anyhow!("missing test chunk"))
                        },
                    )
                    .is_err()
                }
                6 => {
                    let mut corrupt = wal_bytes.clone();
                    let index = (random as usize) % corrupt.len();
                    corrupt[index] ^= 0x40;
                    decode_wal_bytes(&corrupt, 1).is_err()
                }
                _ => {
                    let mut corrupt = wal_bytes.clone();
                    corrupt.pop();
                    decode_wal_bytes(&corrupt, 1).is_err()
                }
            };
            if rejected {
                detected += 1;
            }
        }
        assert_eq!(
            detected, 10_000,
            "every injected corruption must be detected"
        );
    }
}
