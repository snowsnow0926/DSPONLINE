use std::cell::{Cell, RefCell};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{BufReader, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, anyhow, bail};
use serde::{Deserialize, Serialize};
use serde_json::{Number, Value};
use sha2::{Digest, Sha256};

use crate::disk_budget::{
    DiskBudgetOutcome, DiskBudgetStatus, DiskSpaceProbe, SystemDiskSpaceProbe, require_write_budget,
};
use crate::exact_realtime_lease::ExactRealtimeLease;

const MAX_SLOT_BYTES: usize = 64;
const MAX_KEY_BYTES: usize = 512;
const MAX_RECORD_BYTES: usize = 8 * 1024 * 1024;
const MAX_BATCH_RECORDS: usize = 8;
const MAX_WAL_ENTRY_BYTES: usize = 2 * 1024 * 1024;
const MAX_WAL_BYTES: u64 = 64 * 1024 * 1024;
const MAX_WAL_ENTRIES: usize = 4_096;
const MAX_STATISTICS_SIDECAR_BYTES: u64 = 8 * 1024 * 1024;
const STATISTICS_SIDECAR_FORMAT_VERSION: u16 = 1;
const STATISTICS_SIDECAR_FILE: &str = "statistics-history-v1.json";
const WAL_FRAME_HEADER_BYTES: u64 = 8;
const DEFAULT_RETAIN_GENERATIONS: usize = 2;
const SAVE_SLOTS: [&str; 2] = ["normal-main", "speedrun-main"];
const SLOT_DIRECTORIES: [&str; 3] = ["generations", "chunks", "wal"];
#[cfg(windows)]
const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;

/// Compares persisted JSON without applying `serde_json::Value`'s numeric
/// coercions. Idempotency keys identify one exact operation, so an integer and
/// a float remain different categories and floating-point signed zero remains
/// significant at every nested value.
pub(crate) fn json_values_bitwise_equal(left: &Value, right: &Value) -> bool {
    match (left, right) {
        (Value::Null, Value::Null) => true,
        (Value::Bool(left), Value::Bool(right)) => left == right,
        (Value::Number(left), Value::Number(right)) => json_numbers_bitwise_equal(left, right),
        (Value::String(left), Value::String(right)) => left == right,
        (Value::Array(left), Value::Array(right)) => {
            left.len() == right.len()
                && left
                    .iter()
                    .zip(right)
                    .all(|(left, right)| json_values_bitwise_equal(left, right))
        }
        (Value::Object(left), Value::Object(right)) => {
            left.len() == right.len()
                && left.iter().all(|(key, left)| {
                    right
                        .get(key)
                        .is_some_and(|right| json_values_bitwise_equal(left, right))
                })
        }
        _ => false,
    }
}

fn json_numbers_bitwise_equal(left: &Number, right: &Number) -> bool {
    match (left.is_f64(), right.is_f64()) {
        (true, true) => {
            left.as_f64().expect("floating JSON number").to_bits()
                == right.as_f64().expect("floating JSON number").to_bits()
        }
        (true, false) | (false, true) => false,
        (false, false) => match (left.as_u64(), right.as_u64()) {
            (Some(left), Some(right)) => left == right,
            (None, None) => left.as_i64() == right.as_i64(),
            (Some(_), None) | (None, Some(_)) => false,
        },
    }
}

struct Sha256CountingReader<R> {
    inner: R,
    digest: Sha256,
    bytes_read: u64,
}

impl<R> Sha256CountingReader<R> {
    fn new(inner: R) -> Self {
        Self {
            inner,
            digest: Sha256::new(),
            bytes_read: 0,
        }
    }

    fn finish(self) -> (u64, String) {
        (self.bytes_read, hex::encode(self.digest.finalize()))
    }
}

impl<R: Read> Read for Sha256CountingReader<R> {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        let bytes = self.inner.read(buffer)?;
        if bytes > 0 {
            self.digest.update(&buffer[..bytes]);
            self.bytes_read = self
                .bytes_read
                .checked_add(u64::try_from(bytes).map_err(|_| {
                    std::io::Error::new(
                        std::io::ErrorKind::InvalidData,
                        "native byte counter length overflowed",
                    )
                })?)
                .ok_or_else(|| {
                    std::io::Error::new(
                        std::io::ErrorKind::InvalidData,
                        "native byte counter overflowed",
                    )
                })?;
        }
        Ok(bytes)
    }
}

struct Sha256CountingWriter {
    digest: Sha256,
    bytes_written: u64,
}

impl Sha256CountingWriter {
    fn new() -> Self {
        Self {
            digest: Sha256::new(),
            bytes_written: 0,
        }
    }

    fn finish(self) -> (u64, String) {
        (self.bytes_written, hex::encode(self.digest.finalize()))
    }
}

impl Write for Sha256CountingWriter {
    fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
        let bytes = u64::try_from(buffer.len()).map_err(|_| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "native byte counter length overflowed",
            )
        })?;
        let next = self.bytes_written.checked_add(bytes).ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "native byte counter overflowed",
            )
        })?;
        self.digest.update(buffer);
        self.bytes_written = next;
        Ok(buffer.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, Eq, Hash, PartialEq)]
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
    previous_revision: Option<u64>,
    previous_root_hash: Option<String>,
    records: BTreeMap<String, ChunkMetadata>,
    changed_keys: HashSet<String>,
    changed_bytes: u64,
    exact_realtime_checkpoint_lease: Option<ExactRealtimeLease>,
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
    pub wal_maintenance_pending: bool,
    pub wal_bytes: u64,
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

/// A disposable diagnostics cache bound to one exact authoritative
/// generation. It deliberately lives outside `SaveManifest.records`; a stale
/// or damaged file is a cache miss, never a reason to reject the save.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StatisticsSidecarPayload {
    format_version: u16,
    checkpoint_format_version: u16,
    slot: String,
    generation: u64,
    revision: u64,
    root_hash: String,
    state_version: u16,
    mode: String,
    base_checksum: String,
    registry_fingerprint: String,
    history: Value,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StatisticsSidecarEnvelope {
    payload: StatisticsSidecarPayload,
    checksum: String,
}

/// Identity of a checkpoint that was fully verified from the published
/// SaveStore superblocks, manifest, and chunks. Authority coordination must
/// never manufacture this identity from an IPC request or an in-memory core.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PublishedCheckpointIdentity {
    pub slot: String,
    pub generation: u64,
    pub revision: u64,
    pub root_hash: String,
    pub mode: String,
    pub state_version: u16,
    pub registry_fingerprint: String,
}

impl From<&SaveManifest> for PublishedCheckpointIdentity {
    fn from(manifest: &SaveManifest) -> Self {
        Self {
            slot: manifest.slot.clone(),
            generation: manifest.generation,
            revision: manifest.revision,
            root_hash: manifest.root_hash.clone(),
            mode: manifest.mode.clone(),
            state_version: manifest.state_version,
            registry_fingerprint: manifest.registry_fingerprint.clone(),
        }
    }
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

#[derive(Clone, Debug, Eq, PartialEq)]
struct WalFileIdentity {
    exists: bool,
    bytes: u64,
    sha256: String,
}

#[derive(Clone, Debug)]
struct WalScanResult {
    entries: Vec<WalEntry>,
    identity: WalFileIdentity,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct WalMaintenanceResult {
    pending: bool,
    bytes: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CommitFaultPoint {
    None,
    BeforeManifestWrite,
    AfterManifestSync,
    BeforeSuperblockPublish,
    AfterSuperblockPublish,
    #[cfg(test)]
    CorruptManifestBeforeReadback,
    #[cfg(test)]
    TransientReconciliationReadbackFailure,
    #[cfg(test)]
    WalMaintenanceIoFailure,
    #[cfg(test)]
    MutateWalAfterSuperblockPublish,
}

#[derive(Debug)]
struct InvalidPublishedGeneration {
    generation: u64,
    revision: u64,
    reason: String,
}

#[derive(Clone, Debug)]
struct UncertainPublication {
    identity: PublishedCheckpointIdentity,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct DirectoryIdentity {
    volume: u64,
    file: u64,
}

#[derive(Debug)]
pub struct SaveStore {
    root: PathBuf,
    _root_lock: File,
    fixed_directories: HashMap<PathBuf, DirectoryIdentity>,
    next_transaction_id: u64,
    next_temporary_id: Cell<u64>,
    temporary_namespace: String,
    transactions: HashMap<String, SaveTransaction>,
    verified_manifests: RefCell<HashMap<String, SaveManifest>>,
    uncertain_publications: HashMap<String, UncertainPublication>,
    disk_space_probe: Arc<dyn DiskSpaceProbe>,
    last_disk_budget_status: Cell<DiskBudgetStatus>,
    #[cfg(test)]
    transient_reconciliation_failures: HashSet<String>,
}

#[derive(Debug)]
struct TemporaryPathGuard {
    path: PathBuf,
    owned: bool,
}

impl TemporaryPathGuard {
    fn new(path: PathBuf) -> Self {
        Self { path, owned: false }
    }

    fn arm(&mut self) {
        self.owned = true;
    }
}

impl Drop for TemporaryPathGuard {
    fn drop(&mut self) {
        if self.owned {
            let _ = fs::remove_file(&self.path);
        }
    }
}

struct ExactLengthWriter<'a> {
    inner: &'a mut File,
    remaining: u64,
}

impl ExactLengthWriter<'_> {
    fn finish(self) -> anyhow::Result<()> {
        if self.remaining != 0 {
            bail!("native compatibility export wrote fewer bytes than preflighted");
        }
        Ok(())
    }
}

impl Write for ExactLengthWriter<'_> {
    fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
        let requested = u64::try_from(buffer.len()).map_err(|_| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "native compatibility export buffer length overflowed",
            )
        })?;
        if requested > self.remaining {
            return Err(std::io::Error::new(
                std::io::ErrorKind::StorageFull,
                "native compatibility export exceeded its preflighted byte length",
            ));
        }
        let written = self.inner.write(buffer)?;
        self.remaining = self
            .remaining
            .checked_sub(written as u64)
            .expect("bounded export write cannot exceed remaining bytes");
        Ok(written)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.inner.flush()
    }
}

impl SaveStore {
    pub fn open(root: impl AsRef<Path>) -> anyhow::Result<Self> {
        Self::open_with_probe(root, Arc::new(SystemDiskSpaceProbe))
    }

    #[cfg(test)]
    pub(crate) fn open_with_disk_space_probe(
        root: impl AsRef<Path>,
        disk_space_probe: Arc<dyn DiskSpaceProbe>,
    ) -> anyhow::Result<Self> {
        Self::open_with_probe(root, disk_space_probe)
    }

    fn open_with_probe(
        root: impl AsRef<Path>,
        disk_space_probe: Arc<dyn DiskSpaceProbe>,
    ) -> anyhow::Result<Self> {
        let root = root.as_ref();
        ensure_save_root(root)?;
        let root_identity = require_direct_directory(root, "native save root")?;
        let root = fs::canonicalize(root)
            .with_context(|| format!("canonicalize native save root {}", root.display()))?;
        if require_direct_directory(&root, "canonical native save root")? != root_identity {
            bail!("native save root changed while canonicalizing")
        }
        let fixed_directories = initialize_fixed_directories(&root, root_identity)?;
        let lock_path = root.join(".dsp-native-save-store.lock");
        reject_existing_path_redirect(&lock_path, "native save root lock")?;
        let root_lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&lock_path)
            .with_context(|| format!("open native save root lock {}", lock_path.display()))?;
        root_lock
            .try_lock()
            .with_context(|| format!("lock native save root {}", root.display()))?;
        verify_fixed_directories(&fixed_directories)?;
        let opened_at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        Ok(Self {
            root,
            _root_lock: root_lock,
            fixed_directories,
            next_transaction_id: 1,
            next_temporary_id: Cell::new(1),
            temporary_namespace: format!("{}-{opened_at:032x}", std::process::id()),
            transactions: HashMap::new(),
            verified_manifests: RefCell::new(HashMap::new()),
            uncertain_publications: HashMap::new(),
            disk_space_probe,
            last_disk_budget_status: Cell::new(DiskBudgetStatus::NotChecked),
            #[cfg(test)]
            transient_reconciliation_failures: HashSet::new(),
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    fn require_disk_budget_in_directory(
        &self,
        directory: &Path,
        write_bytes: u64,
    ) -> anyhow::Result<()> {
        match require_write_budget(self.disk_space_probe.as_ref(), directory, write_bytes) {
            Ok(DiskBudgetOutcome::Verified { .. }) => {
                self.last_disk_budget_status.set(DiskBudgetStatus::Verified);
                Ok(())
            }
            Ok(DiskBudgetOutcome::Unsupported { .. }) => {
                self.last_disk_budget_status
                    .set(DiskBudgetStatus::Unsupported);
                Ok(())
            }
            Err(error) => {
                self.last_disk_budget_status.set(DiskBudgetStatus::Failed);
                Err(error)
            }
        }
    }

    fn require_disk_budget_for_path(&self, path: &Path, write_bytes: u64) -> anyhow::Result<()> {
        let parent = path
            .parent()
            .ok_or_else(|| anyhow!("native disk budget target has no parent"))?;
        self.require_disk_budget_in_directory(parent, write_bytes)
    }

    fn atomic_write_new_budgeted(&self, path: &Path, bytes: &[u8]) -> anyhow::Result<()> {
        if !reject_existing_path_redirect(path, "immutable native target")? {
            self.require_disk_budget_for_path(path, u64::try_from(bytes.len())?)?;
        }
        atomic_write_new(path, bytes, &self.next_temporary_name()?)
    }

    pub(crate) fn atomic_replace_budgeted(&self, path: &Path, bytes: &[u8]) -> anyhow::Result<()> {
        self.require_disk_budget_for_path(path, u64::try_from(bytes.len())?)?;
        atomic_replace(path, bytes, &self.next_temporary_name()?)
    }

    #[cfg(test)]
    fn last_disk_budget_status(&self) -> DiskBudgetStatus {
        self.last_disk_budget_status.get()
    }

    /// Best-effort callers must ignore every error from this method. The
    /// sidecar is not part of the save transaction and is published only after
    /// the authoritative generation has already been acknowledged.
    pub(crate) fn write_statistics_sidecar(
        &self,
        slot: &str,
        generation: u64,
        revision: u64,
        root_hash: &str,
        history: Value,
    ) -> anyhow::Result<()> {
        let manifest = self
            .recover_manifest(slot)?
            .ok_or_else(|| anyhow!("native statistics sidecar checkpoint is missing"))?;
        if manifest.generation != generation
            || manifest.revision != revision
            || manifest.root_hash != root_hash
        {
            bail!("native statistics sidecar checkpoint identity is stale");
        }
        let payload = StatisticsSidecarPayload {
            format_version: STATISTICS_SIDECAR_FORMAT_VERSION,
            checkpoint_format_version: manifest.format_version,
            slot: manifest.slot.clone(),
            generation: manifest.generation,
            revision: manifest.revision,
            root_hash: manifest.root_hash.clone(),
            state_version: manifest.state_version,
            mode: manifest.mode.clone(),
            base_checksum: manifest.base_checksum.clone(),
            registry_fingerprint: manifest.registry_fingerprint.clone(),
            history,
        };
        let envelope = StatisticsSidecarEnvelope {
            checksum: sha256_hex(&serde_json::to_vec(&payload)?),
            payload,
        };
        let bytes = serde_json::to_vec(&envelope)?;
        if bytes.len() as u64 > MAX_STATISTICS_SIDECAR_BYTES {
            bail!("native statistics sidecar exceeds its byte budget");
        }
        let path = self.statistics_sidecar_path(slot)?;
        self.atomic_replace_budgeted(&path, &bytes)?;
        sync_directory(&self.slot_dir(slot)?)?;
        Ok(())
    }

    /// Reads a disposable cache fail-open. Corruption, stale identity,
    /// unsupported formats and I/O failures all return `None`; callers retain
    /// the history rebuilt from public v47 fields.
    pub(crate) fn read_statistics_sidecar(
        &self,
        slot: &str,
        generation: u64,
        revision: u64,
        root_hash: &str,
    ) -> Option<Value> {
        self.read_statistics_sidecar_checked(slot, generation, revision, root_hash)
            .ok()
            .flatten()
    }

    fn read_statistics_sidecar_checked(
        &self,
        slot: &str,
        generation: u64,
        revision: u64,
        root_hash: &str,
    ) -> anyhow::Result<Option<Value>> {
        let manifest = self
            .recover_manifest(slot)?
            .ok_or_else(|| anyhow!("native statistics sidecar checkpoint is missing"))?;
        if manifest.generation != generation
            || manifest.revision != revision
            || manifest.root_hash != root_hash
        {
            bail!("native statistics sidecar requested identity is stale");
        }
        let path = self.statistics_sidecar_path(slot)?;
        if !reject_existing_path_redirect(&path, "native statistics sidecar")? {
            return Ok(None);
        }
        let file = File::open(&path)?;
        let length = file.metadata()?.len();
        if length == 0 || length > MAX_STATISTICS_SIDECAR_BYTES {
            bail!("native statistics sidecar byte length is invalid");
        }
        let mut bytes = Vec::with_capacity(usize::try_from(length)?);
        file.take(MAX_STATISTICS_SIDECAR_BYTES.saturating_add(1))
            .read_to_end(&mut bytes)?;
        if bytes.len() as u64 != length {
            bail!("native statistics sidecar changed during read");
        }
        let envelope = serde_json::from_slice::<StatisticsSidecarEnvelope>(&bytes)
            .context("decode native statistics sidecar")?;
        if sha256_hex(&serde_json::to_vec(&envelope.payload)?) != envelope.checksum {
            bail!("native statistics sidecar checksum is invalid");
        }
        let payload = envelope.payload;
        if payload.format_version != STATISTICS_SIDECAR_FORMAT_VERSION
            || payload.checkpoint_format_version != manifest.format_version
            || payload.slot != manifest.slot
            || payload.generation != manifest.generation
            || payload.revision != manifest.revision
            || payload.root_hash != manifest.root_hash
            || payload.state_version != manifest.state_version
            || payload.mode != manifest.mode
            || payload.base_checksum != manifest.base_checksum
            || payload.registry_fingerprint != manifest.registry_fingerprint
        {
            bail!("native statistics sidecar identity is stale");
        }
        Ok(Some(payload.history))
    }

    /// Publishes a bounded native-generated compatibility export under the
    /// host-owned root. Renderer code supplies only a logical identifier and
    /// can never choose an arbitrary filesystem path.
    pub fn publish_export<T>(
        &self,
        export_id: &str,
        expected_bytes: u64,
        write: impl FnOnce(&mut dyn Write) -> anyhow::Result<T>,
    ) -> anyhow::Result<T> {
        validate_export_id(export_id)?;
        let export_root = self.fixed_directory(&self.root.join("exports"), "native export root")?;
        let final_path = safe_child(&export_root, &format!("{export_id}.json"))?;
        let temporary = safe_child(&export_root, &format!("{export_id}.part"))?;
        if reject_existing_path_redirect(&final_path, "native export target")?
            || reject_existing_path_redirect(&temporary, "native export temporary target")?
        {
            bail!("native export identity already exists");
        }
        self.fixed_directory(&export_root, "native export root")?;
        self.require_disk_budget_in_directory(&export_root, expected_bytes)?;
        let mut temporary_guard = TemporaryPathGuard::new(temporary.clone());
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        temporary_guard.arm();
        let result = {
            let mut writer = ExactLengthWriter {
                inner: &mut file,
                remaining: expected_bytes,
            };
            let result = write(&mut writer).context("stream native compatibility export")?;
            writer.finish()?;
            result
        };
        file.sync_all()?;
        drop(file);
        self.fixed_directory(&export_root, "native export root")?;
        fs::rename(&temporary, &final_path)?;
        sync_directory(&export_root)?;
        drop(temporary_guard);
        Ok(result)
    }

    #[allow(clippy::too_many_arguments)]
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
        self.require_generic_mutation_unfenced(slot)?;
        self.begin_internal(
            slot,
            mode,
            state_version,
            base_checksum,
            registry_fingerprint,
            revision,
            saved_at_ms,
            None,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn begin_exact_realtime_checkpoint(
        &mut self,
        slot: &str,
        mode: &str,
        state_version: u16,
        base_checksum: &str,
        registry_fingerprint: &str,
        revision: u64,
        saved_at_ms: u64,
        expected_lease: &ExactRealtimeLease,
    ) -> anyhow::Result<SaveBeginResult> {
        validate_slot(slot)?;
        validate_mode(mode)?;
        validate_hex_identity(base_checksum, "base checksum")?;
        validate_fingerprint(registry_fingerprint)?;
        self.require_exact_realtime_checkpoint_mutation(
            expected_lease,
            slot,
            mode,
            state_version,
            registry_fingerprint,
            revision,
            saved_at_ms,
        )?;
        self.begin_internal(
            slot,
            mode,
            state_version,
            base_checksum,
            registry_fingerprint,
            revision,
            saved_at_ms,
            Some(expected_lease.clone()),
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn begin_internal(
        &mut self,
        slot: &str,
        mode: &str,
        state_version: u16,
        base_checksum: &str,
        registry_fingerprint: &str,
        revision: u64,
        saved_at_ms: u64,
        exact_realtime_checkpoint_lease: Option<ExactRealtimeLease>,
    ) -> anyhow::Result<SaveBeginResult> {
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
            previous_revision: previous.as_ref().map(|manifest| manifest.revision),
            previous_root_hash: previous.as_ref().map(|manifest| manifest.root_hash.clone()),
            records: previous
                .as_ref()
                .map(|manifest| manifest.records.clone())
                .unwrap_or_default(),
            changed_keys: HashSet::new(),
            changed_bytes: 0,
            exact_realtime_checkpoint_lease,
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
        self.put_batch(transaction_id, &[(key, value)])
    }

    pub fn put_batch(
        &mut self,
        transaction_id: &str,
        records: &[(&str, Option<&str>)],
    ) -> anyhow::Result<()> {
        if records.is_empty() || records.len() > MAX_BATCH_RECORDS {
            bail!("native save batch size is invalid");
        }
        let slot = self
            .transactions
            .get(transaction_id)
            .ok_or_else(|| anyhow!("unknown native save transaction"))?
            .slot
            .clone();
        let mut keys = HashSet::with_capacity(records.len());
        for (key, value) in records {
            validate_key(key)?;
            if !keys.insert(*key) {
                bail!("native save batch repeats a record key");
            }
            if value.is_some_and(|value| value.len() > MAX_RECORD_BYTES) {
                bail!("native save record exceeds the bounded write limit");
            }
        }

        // Immutable chunks may be left unreferenced by a failed batch and are
        // reclaimed by compaction. The mutable transaction itself is not
        // touched until every validation and chunk write has succeeded.
        let mut staged = Vec::with_capacity(records.len());
        for (key, value) in records {
            let metadata = match value {
                Some(value) => Some(self.write_chunk(&slot, value.as_bytes())?),
                None => None,
            };
            staged.push(((*key).to_owned(), metadata));
        }

        let transaction = self
            .transactions
            .get_mut(transaction_id)
            .expect("validated native save transaction disappeared");
        for (key, metadata) in staged {
            let changed = match metadata {
                Some(metadata) => {
                    let same = transaction.records.get(&key) == Some(&metadata);
                    if !same {
                        transaction.changed_bytes = transaction
                            .changed_bytes
                            .saturating_add(metadata.compressed_bytes);
                        transaction.records.insert(key.clone(), metadata);
                    }
                    !same
                }
                None => transaction.records.remove(&key).is_some(),
            };
            if changed {
                transaction.changed_keys.insert(key);
            }
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
        if let Some(expected_lease) = transaction.exact_realtime_checkpoint_lease.as_ref() {
            self.require_exact_realtime_checkpoint_mutation(
                expected_lease,
                &transaction.slot,
                &transaction.mode,
                transaction.state_version,
                &transaction.registry_fingerprint,
                transaction.revision,
                transaction.saved_at_ms,
            )?;
        } else {
            // Re-check at the publication boundary. A generic transaction may
            // have been admitted before the durable lease was prepared.
            self.require_generic_mutation_unfenced(&transaction.slot)?;
        }
        // This is the destructive publication boundary. Re-verify the disk
        // authority without consulting the cache before choosing which
        // superblock to replace; otherwise bit rot or another stale view could
        // overwrite the only healthy fallback.
        let current = self.scan_published_manifests(&transaction.slot)?.pop();
        if current.as_ref().map(|manifest| manifest.generation) != transaction.previous_generation
            || current.as_ref().map(|manifest| manifest.revision) != transaction.previous_revision
            || current.as_ref().map(|manifest| manifest.root_hash.as_str())
                != transaction.previous_root_hash.as_deref()
        {
            bail!("native save transaction is based on a stale generation");
        }
        // A logically damaged WAL must stop the checkpoint before its pointer
        // can replace either healthy generation. A final torn, never-ACKed
        // frame may be truncated to its fully verified prefix here.
        let wal_before = self.scan_wal(&transaction.slot, true)?;
        // A checkpoint may cover a complete WAL prefix, but it cannot land in
        // the middle of one authority operation. Otherwise the preserved
        // suffix could no longer prove that it continues from the checkpoint.
        active_wal_entries(&wal_before.entries, transaction.revision)?;
        // A failed commit can leave an immutable manifest directory without a
        // published superblock. Never reuse that generation number: doing so
        // made every later, different checkpoint collide with the orphaned
        // manifest forever.
        let generation =
            self.next_generation(&transaction.slot, transaction.previous_generation)?;
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
        let generations_root = generation_dir
            .parent()
            .ok_or_else(|| anyhow!("native generation has no parent"))?;
        // Check against the already-trusted parent before creating the new
        // generation directory. A rejected manifest must not leave an empty
        // generation behind and consume a generation number.
        self.require_disk_budget_in_directory(
            generations_root,
            u64::try_from(manifest_bytes.len())?,
        )?;
        ensure_direct_directory(
            &generation_dir,
            generations_root,
            "native save generation directory",
        )?;
        atomic_write_new(
            &generation_dir.join("manifest.json"),
            &manifest_bytes,
            &self.next_temporary_name()?,
        )?;
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
        let superblock_target =
            self.slot_dir(&transaction.slot)?
                .join(if generation.is_multiple_of(2) {
                    "superblock-a.json"
                } else {
                    "superblock-b.json"
                });
        self.require_disk_budget_for_path(
            &superblock_target,
            u64::try_from(superblock_bytes.len())?,
        )?;
        atomic_replace(
            &superblock_target,
            &superblock_bytes,
            &self.next_temporary_name()?,
        )?;
        // Keep the exact transaction-to-manifest binding across any error
        // after pointer replacement. Core reconciliation may consume it only
        // after a fresh disk scan proves this complete manifest is current.
        self.uncertain_publications.insert(
            transaction.id.clone(),
            UncertainPublication {
                identity: PublishedCheckpointIdentity::from(&manifest),
            },
        );
        // From this point on the on-disk authority may be newer than the
        // in-process cache, even if a following durability or readback step
        // reports an error. Never allow a retry to observe the old cached
        // generation after pointer publication.
        self.verified_manifests
            .borrow_mut()
            .remove(&transaction.slot);
        sync_directory(&self.slot_dir(&transaction.slot)?)?;
        if fault == CommitFaultPoint::AfterSuperblockPublish {
            bail!("injected failure after superblock publish");
        }

        #[cfg(test)]
        if fault == CommitFaultPoint::TransientReconciliationReadbackFailure {
            self.transient_reconciliation_failures
                .insert(transaction.id.clone());
            bail!("injected transient checkpoint readback failure");
        }

        #[cfg(test)]
        if fault == CommitFaultPoint::CorruptManifestBeforeReadback {
            let manifest_path = generation_dir.join("manifest.json");
            let mut corrupted = fs::read(&manifest_path)?;
            corrupted[0] ^= 0x01;
            let mut file = OpenOptions::new()
                .write(true)
                .truncate(true)
                .open(&manifest_path)?;
            file.write_all(&corrupted)?;
            file.sync_all()?;
            sync_directory(&generation_dir)?;
        }

        // A successful return is an acknowledgement that the exact pointer,
        // manifest, and every referenced immutable chunk can be read and
        // verified from disk. Deliberately bypass the in-process manifest
        // cache here; the dirty checkpoint must not be cleared on the strength
        // of the objects that were just serialized in memory.
        let manifest = match self.read_published_manifest(
            &transaction.slot,
            generation,
            transaction.revision,
            &manifest.root_hash,
        ) {
            Ok(manifest) => manifest,
            Err(error) => {
                self.verified_manifests
                    .borrow_mut()
                    .remove(&transaction.slot);
                return Err(error.context("verify published native checkpoint before ACK"));
            }
        };

        #[cfg(test)]
        if fault == CommitFaultPoint::MutateWalAfterSuperblockPublish {
            let wal_path = self.wal_path(&transaction.slot)?;
            let mut file = OpenOptions::new()
                .create(true)
                .append(true)
                .open(wal_path)?;
            file.write_all(&[0x7f])?;
            file.sync_all()?;
        }

        // The root lock excludes cooperative writers. Re-scan anyway so an
        // antivirus, recovery utility, or disk fault cannot be downgraded to
        // a harmless maintenance miss after pointer publication.
        let wal_after = self
            .scan_wal(&transaction.slot, false)
            .context("verify WAL identity after native checkpoint publication")?;
        if wal_after.identity != wal_before.identity {
            bail!("native WAL identity changed during checkpoint publication");
        }
        let wal_maintenance = {
            #[cfg(test)]
            if fault == CommitFaultPoint::WalMaintenanceIoFailure {
                Err(anyhow!("injected WAL maintenance I/O failure"))
            } else {
                self.converge_verified_wal(&transaction.slot, transaction.revision, &wal_after)
            }
            #[cfg(not(test))]
            self.converge_verified_wal(&transaction.slot, transaction.revision, &wal_after)
        }
        .unwrap_or(WalMaintenanceResult {
            pending: true,
            bytes: wal_after.identity.bytes,
        });
        self.verified_manifests
            .borrow_mut()
            .insert(transaction.slot.clone(), manifest.clone());
        self.uncertain_publications.remove(transaction_id);
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
            wal_maintenance_pending: wal_maintenance.pending,
            wal_bytes: wal_maintenance.bytes,
        })
    }

    /// Reconciles a response lost after superblock replacement. Transactions
    /// without a post-publication marker are never upgraded to success. A
    /// marked transaction is accepted only when a fresh scan proves its full
    /// manifest is still the latest authenticated publication.
    pub(crate) fn reconcile_uncertain_publication(
        &mut self,
        transaction_id: &str,
    ) -> anyhow::Result<Option<PublishedCheckpointIdentity>> {
        let Some(expected) = self.uncertain_publications.get(transaction_id).cloned() else {
            return Ok(None);
        };
        #[cfg(test)]
        if self
            .transient_reconciliation_failures
            .remove(transaction_id)
        {
            bail!("injected transient uncertain checkpoint reconciliation failure");
        }
        let actual = self
            .scan_published_manifests(&expected.identity.slot)?
            .pop()
            .ok_or_else(|| anyhow!("uncertain native checkpoint publication is missing"))?;
        let actual_identity = PublishedCheckpointIdentity::from(&actual);
        if actual_identity != expected.identity {
            bail!("uncertain native checkpoint publication identity changed");
        }
        self.verified_manifests
            .borrow_mut()
            .insert(actual.slot.clone(), actual.clone());
        self.uncertain_publications.remove(transaction_id);
        Ok(Some(actual_identity))
    }

    pub fn recover(&self, slot: &str) -> anyhow::Result<Option<SaveRecoveryResult>> {
        let Some(manifest) = self.recover_manifest(slot)? else {
            return Ok(None);
        };
        let mut wal_scan = self.scan_wal(slot, true)?;
        if wal_scan.identity.bytes > 0
            && self
                .converge_verified_wal(slot, manifest.revision, &wal_scan)
                .is_ok_and(|maintenance| !maintenance.pending)
        {
            wal_scan = self.scan_wal(slot, false)?;
        }
        let wal = active_wal_entries(&wal_scan.entries, manifest.revision)?;
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
        let path = self.chunk_path(slot, &metadata.hash)?;
        let file = File::open(&path)?;
        if file.metadata()?.len() != metadata.compressed_bytes {
            bail!("native save chunk compressed length is invalid");
        }
        // Feed the compressed file directly into zstd. The previous fs::read
        // path held the complete compressed chunk next to the decoded record;
        // a large save could therefore transiently pay for both buffers. This
        // reader hashes and counts the immutable chunk as it is decoded, so the
        // only record-sized allocation is the required uncompressed result.
        let reader = Sha256CountingReader::new(file);
        note_chunk_decode();
        let mut decoder = zstd::stream::read::Decoder::new(reader)?;
        let initial_capacity = usize::try_from(metadata.uncompressed_bytes)
            .unwrap_or(MAX_RECORD_BYTES)
            .min(MAX_RECORD_BYTES);
        let mut decoded = Vec::with_capacity(initial_capacity);
        decoder
            .by_ref()
            .take(metadata.uncompressed_bytes.saturating_add(1))
            .read_to_end(&mut decoded)?;
        let reader = decoder.finish().into_inner();
        let (compressed_bytes, compressed_hash) = reader.finish();
        if compressed_bytes != metadata.compressed_bytes
            || compressed_hash != metadata.compressed_hash
        {
            bail!("native save chunk compressed length is invalid");
        }
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
        self.require_generic_mutation_unfenced(slot)?;
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
        self.require_generic_mutation_unfenced(slot)?;
        self.append_wal_internal(slot, base_revision, revision, command_id, payload, true)
    }

    pub(crate) fn append_wal_idempotent_exact_realtime(
        &self,
        expected_lease: &ExactRealtimeLease,
        slot: &str,
        base_revision: u64,
        revision: u64,
        command_id: &str,
        payload: Value,
    ) -> anyhow::Result<WalAppendResult> {
        self.require_exact_realtime_pending_wal_mutation(
            expected_lease,
            slot,
            &expected_lease.registry_fingerprint,
            base_revision,
            revision,
            command_id,
        )?;
        self.append_wal_internal(slot, base_revision, revision, command_id, payload, true)
    }

    pub fn find_wal_command(
        &self,
        slot: &str,
        command_id: &str,
    ) -> anyhow::Result<Option<WalEntry>> {
        validate_slot(slot)?;
        validate_command_id(command_id)?;
        Ok(self
            .scan_wal(slot, true)?
            .entries
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
        let mut scan = self.scan_wal(slot, true)?;
        if let Some(existing) = scan
            .entries
            .iter()
            .find(|entry| entry.command_id == command_id)
        {
            if !allow_identical_duplicate {
                bail!("native WAL command ID is duplicated");
            }
            if existing.base_revision != base_revision
                || existing.revision != revision
                || !json_values_bitwise_equal(&existing.payload, &payload)
            {
                bail!("native WAL idempotency key conflicts with another operation");
            }
            return Ok(WalAppendResult {
                revision: existing.revision,
                entry_hash: existing.entry_hash.clone(),
                wal_bytes: scan.identity.bytes,
                duplicate: true,
            });
        }
        if !scan
            .entries
            .iter()
            .any(|entry| entry.revision > checkpoint_revision)
            && scan.identity.bytes > 0
            && self
                .converge_verified_wal(slot, checkpoint_revision, &scan)
                .is_ok_and(|maintenance| !maintenance.pending)
        {
            scan = self.scan_wal(slot, false)?;
        }
        let active_entries = active_wal_entries(&scan.entries, checkpoint_revision)?;
        let expected_base_revision = active_entries
            .last()
            .map(|entry| entry.revision)
            .unwrap_or(checkpoint_revision);
        if base_revision != expected_base_revision || revision <= base_revision {
            bail!("native WAL revision range is not contiguous");
        }
        let previous_hash = scan
            .entries
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
        let frame = encode_wal_frame(&encoded)?;
        ensure_wal_append_budget(scan.identity.bytes, scan.entries.len(), frame.len())?;
        let wal_bytes = if wal_path.exists() {
            self.require_disk_budget_for_path(&wal_path, u64::try_from(frame.len())?)?;
            let mut file = OpenOptions::new().append(true).open(&wal_path)?;
            file.write_all(&frame)?;
            file.sync_all()?;
            file.metadata()?.len()
        } else {
            self.atomic_write_new_budgeted(&wal_path, &frame)?;
            frame.len() as u64
        };
        Ok(WalAppendResult {
            revision,
            entry_hash,
            wal_bytes,
            duplicate: false,
        })
    }

    pub fn read_wal(&self, slot: &str, checkpoint_revision: u64) -> anyhow::Result<Vec<WalEntry>> {
        validate_slot(slot)?;
        let scan = self.scan_wal(slot, true)?;
        Ok(active_wal_entries(&scan.entries, checkpoint_revision)?
            .into_iter()
            .cloned()
            .collect())
    }

    fn scan_wal(&self, slot: &str, repair_torn_tail: bool) -> anyhow::Result<WalScanResult> {
        validate_slot(slot)?;
        let path = self.wal_path(slot)?;
        let mut file = match OpenOptions::new()
            .read(true)
            .write(repair_torn_tail)
            .open(&path)
        {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(WalScanResult {
                    entries: Vec::new(),
                    identity: WalFileIdentity {
                        exists: false,
                        bytes: 0,
                        sha256: sha256_hex(&[]),
                    },
                });
            }
            Err(error) => {
                return Err(error).with_context(|| format!("open native WAL {}", path.display()));
            }
        };
        let file_bytes = file.metadata()?.len();
        if file_bytes > MAX_WAL_BYTES {
            bail!("native WAL byte budget is exhausted; checkpoint required");
        }

        let mut entries = Vec::new();
        let mut command_ids = HashSet::new();
        let mut previous_hash = "0".repeat(64);
        let mut previous_revision = None;
        let mut digest = Sha256::new();
        let mut offset = 0u64;
        let mut torn_at = None;
        {
            let mut reader = BufReader::with_capacity(64 * 1024, &mut file);
            while offset < file_bytes {
                let frame_start = offset;
                if file_bytes - offset < WAL_FRAME_HEADER_BYTES {
                    torn_at = Some(frame_start);
                    break;
                }
                let mut header = [0u8; WAL_FRAME_HEADER_BYTES as usize];
                reader.read_exact(&mut header)?;
                offset += WAL_FRAME_HEADER_BYTES;
                digest.update(header);
                let length =
                    u32::from_le_bytes(header[..4].try_into().expect("WAL length")) as usize;
                let expected_crc = u32::from_le_bytes(header[4..].try_into().expect("WAL CRC"));
                if length == 0 || length > MAX_WAL_ENTRY_BYTES {
                    bail!("native WAL entry length is invalid");
                }
                if entries.len() >= MAX_WAL_ENTRIES {
                    bail!("native WAL entry budget is exhausted; checkpoint required");
                }
                if file_bytes - offset < length as u64 {
                    torn_at = Some(frame_start);
                    break;
                }
                let mut encoded = vec![0u8; length];
                reader.read_exact(&mut encoded)?;
                offset += length as u64;
                digest.update(&encoded);
                let mut crc = crc32fast::Hasher::new();
                crc.update(&encoded);
                if crc.finalize() != expected_crc {
                    bail!("native WAL checksum is invalid");
                }
                let entry: WalEntry = serde_json::from_slice(&encoded)?;
                validate_command_id(&entry.command_id)?;
                if entry.revision <= entry.base_revision
                    || previous_revision.is_some_and(|revision| entry.base_revision != revision)
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
                if !command_ids.insert(entry.command_id.clone()) {
                    bail!("native WAL contains a duplicated command ID");
                }
                previous_revision = Some(entry.revision);
                previous_hash = entry.entry_hash.clone();
                entries.push(entry);
            }
        }

        if let Some(valid_bytes) = torn_at {
            if !repair_torn_tail {
                bail!("native WAL has an unacknowledged torn tail");
            }
            file.set_len(valid_bytes)?;
            file.sync_all()?;
            drop(file);
            return self.scan_wal(slot, false);
        }
        if offset != file_bytes {
            bail!("native WAL scanner did not consume the complete file");
        }
        Ok(WalScanResult {
            entries,
            identity: WalFileIdentity {
                exists: true,
                bytes: file_bytes,
                sha256: hex::encode(digest.finalize()),
            },
        })
    }

    fn converge_verified_wal(
        &self,
        slot: &str,
        checkpoint_revision: u64,
        scan: &WalScanResult,
    ) -> anyhow::Result<WalMaintenanceResult> {
        if scan
            .entries
            .iter()
            .any(|entry| entry.revision > checkpoint_revision)
        {
            return Ok(WalMaintenanceResult {
                pending: true,
                bytes: scan.identity.bytes,
            });
        }
        if !scan.identity.exists || scan.identity.bytes == 0 {
            return Ok(WalMaintenanceResult {
                pending: false,
                bytes: 0,
            });
        }
        let path = self.wal_path(slot)?;
        self.atomic_replace_budgeted(&path, &[])?;
        Ok(WalMaintenanceResult {
            pending: false,
            bytes: 0,
        })
    }

    pub fn compact(&self, slot: &str, retain_generations: usize) -> anyhow::Result<usize> {
        validate_slot(slot)?;
        self.require_generic_mutation_unfenced(slot)?;
        if self
            .transactions
            .values()
            .any(|transaction| transaction.slot == slot)
        {
            bail!("native save compaction cannot run while a transaction is active");
        }
        let retain_generations = retain_generations.max(DEFAULT_RETAIN_GENERATIONS);
        let verified = self.scan_published_manifests(slot)?;
        let Some(active) = verified.last() else {
            return Ok(0);
        };
        let generations_root = self.slot_subdirectory(slot, "generations")?;
        let mut generations = self.generation_directories(slot)?;

        // Compaction is destructive. If only the active pointer can be fully
        // verified, keep every generation rather than guessing that a nearby
        // numeric directory is a healthy fallback.
        if verified.len() < DEFAULT_RETAIN_GENERATIONS {
            return Ok(0);
        }

        let mut protected = verified
            .iter()
            .rev()
            .take(retain_generations)
            .map(|manifest| manifest.generation)
            .collect::<HashSet<_>>();
        // Two superblocks can prove at most two published generations. Honour
        // a larger caller retention request conservatively by keeping the
        // newest additional directories as well.
        for (generation, _) in generations.iter().rev() {
            if protected.len() >= retain_generations {
                break;
            }
            protected.insert(*generation);
        }
        let mut removed = 0;
        for (generation, path) in generations.drain(..) {
            if protected.contains(&generation) || generation == active.generation {
                continue;
            }
            if !path.starts_with(&generations_root) {
                bail!("native generation cleanup escaped its root");
            }
            require_direct_directory(&path, "native generation cleanup target")?;
            fs::remove_dir_all(path)?;
            removed += 1;
        }
        sync_directory(&generations_root)?;
        self.collect_unreferenced_chunks(slot)?;
        Ok(removed)
    }

    fn collect_unreferenced_chunks(&self, slot: &str) -> anyhow::Result<()> {
        let generations_root = self.slot_subdirectory(slot, "generations")?;
        let mut referenced = HashSet::new();
        for entry in fs::read_dir(&generations_root)? {
            let entry = entry?;
            if path_is_redirect(&fs::symlink_metadata(entry.path())?) {
                bail!("native generation entry is a filesystem redirect")
            }
            if entry.file_type()?.is_dir() {
                let manifest_path = entry.path().join("manifest.json");
                if !reject_existing_path_redirect(&manifest_path, "native generation manifest")? {
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
        let chunks_root = self.slot_subdirectory(slot, "chunks")?;
        for entry in fs::read_dir(&chunks_root)? {
            let entry = entry?;
            let path = entry.path();
            if path_is_redirect(&fs::symlink_metadata(&path)?) {
                bail!("native chunk cleanup entry is a filesystem redirect")
            }
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
        let recovered = self.scan_published_manifests(slot)?.pop();
        if let Some(manifest) = recovered.as_ref() {
            self.verified_manifests
                .borrow_mut()
                .insert(slot.to_owned(), manifest.clone());
        }
        Ok(recovered)
    }

    /// Re-verifies the durable publication chain instead of consulting the
    /// recovery cache. This is the only checkpoint source trusted by the
    /// exact-realtime authority lease.
    pub(crate) fn latest_published_checkpoint_identity(
        &self,
        slot: &str,
    ) -> anyhow::Result<Option<PublishedCheckpointIdentity>> {
        Ok(self
            .scan_published_manifests(slot)?
            .last()
            .map(PublishedCheckpointIdentity::from))
    }

    /// Proves that an exact checkpoint is still one of the two authenticated
    /// published generations. The previous generation is accepted because a
    /// crash can occur after publishing the next core checkpoint but before
    /// atomically advancing the lease ACK.
    pub(crate) fn verify_published_checkpoint_identity(
        &self,
        expected: &PublishedCheckpointIdentity,
    ) -> anyhow::Result<PublishedCheckpointIdentity> {
        let manifests = self.scan_published_manifests(&expected.slot)?;
        let actual = manifests
            .iter()
            .find(|manifest| {
                manifest.generation == expected.generation
                    && manifest.root_hash == expected.root_hash
                    && manifest.revision == expected.revision
            })
            .ok_or_else(|| anyhow!("native published checkpoint identity is not available"))?;
        let actual = PublishedCheckpointIdentity::from(actual);
        if &actual != expected {
            bail!("native published checkpoint metadata conflicts with the lease")
        }
        Ok(actual)
    }

    /// Reads both published pointers without consulting the manifest cache.
    /// A corrupt or unreadable pointer has no trustworthy ordering identity,
    /// so selecting any other generation would be a possible silent rollback.
    /// Once a pointer itself is authenticated, an invalid referenced
    /// generation may be ignored only when it is provably older than the best
    /// fully verified candidate.
    fn scan_published_manifests(&self, slot: &str) -> anyhow::Result<Vec<SaveManifest>> {
        validate_slot(slot)?;
        let slot_dir = self.slot_dir(slot)?;
        if !slot_dir.exists() {
            return Ok(Vec::new());
        }
        let mut candidates = Vec::new();
        let mut invalid = Vec::new();
        let mut pointer_count = 0usize;
        let mut verified_chunks = HashSet::new();
        for name in ["superblock-a.json", "superblock-b.json"] {
            let path = slot_dir.join(name);
            let bytes = match fs::read(&path) {
                Ok(bytes) => {
                    pointer_count += 1;
                    bytes
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => {
                    bail!(
                        "native save pointer {} cannot be read unambiguously: {error}",
                        path.display()
                    )
                }
            };
            let superblock = decode_superblock(slot, &bytes).with_context(|| {
                format!(
                    "native save pointer {} has no trustworthy recovery identity",
                    path.display()
                )
            })?;
            match self.read_manifest_for_superblock(slot, &superblock, &mut verified_chunks) {
                Ok(manifest) => candidates.push(manifest),
                Err(error) => invalid.push(InvalidPublishedGeneration {
                    generation: superblock.generation,
                    revision: superblock.revision,
                    reason: format!("{error:#}"),
                }),
            }
        }
        if pointer_count == 0 {
            return Ok(Vec::new());
        }
        candidates.sort_by_key(|manifest| manifest.generation);
        candidates.dedup_by(|left, right| {
            left.generation == right.generation && left.root_hash == right.root_hash
        });
        if candidates.windows(2).any(|window| {
            window[0].generation >= window[1].generation
                || window[0].revision > window[1].revision
                || window[1].previous_generation != Some(window[0].generation)
        }) {
            bail!("native save published checkpoint order is inconsistent");
        }
        let Some(newest) = candidates.last() else {
            let failure = invalid
                .last()
                .map(|candidate| candidate.reason.as_str())
                .unwrap_or("no published generation could be verified");
            bail!("native save has pointers but no valid checkpoint: {failure}");
        };
        if let Some(candidate) = invalid.into_iter().find(|candidate| {
            candidate.generation >= newest.generation || candidate.revision > newest.revision
        }) {
            bail!(
                "native save refuses to roll back past invalid generation {} revision {}: {}",
                candidate.generation,
                candidate.revision,
                candidate.reason
            );
        }
        Ok(candidates)
    }

    fn read_manifest_for_superblock(
        &self,
        slot: &str,
        superblock: &SuperblockPayload,
        verified_chunks: &mut HashSet<ChunkMetadata>,
    ) -> anyhow::Result<SaveManifest> {
        let manifest_path = self
            .generation_dir(slot, superblock.generation)?
            .join("manifest.json");
        let file = File::open(&manifest_path)
            .with_context(|| format!("open native manifest {}", manifest_path.display()))?;
        let reader = Sha256CountingReader::new(file);
        let mut reader = BufReader::with_capacity(64 * 1024, reader);
        let manifest: SaveManifest = serde_json::from_reader(&mut reader)
            .with_context(|| format!("decode native manifest {}", manifest_path.display()))?;
        let reader = reader.into_inner();
        let (_, manifest_hash) = reader.finish();
        if manifest_hash != superblock.manifest_hash {
            bail!("native manifest digest mismatch");
        }
        let manifest = verify_generation_manifest(slot, superblock, manifest)?;
        for metadata in manifest.records.values() {
            if verified_chunks.contains(metadata) {
                continue;
            }
            self.verify_compressed_chunk(slot, metadata)?;
            verified_chunks.insert(metadata.clone());
        }
        Ok(manifest)
    }

    fn verify_compressed_chunk(&self, slot: &str, metadata: &ChunkMetadata) -> anyhow::Result<()> {
        validate_hex_identity(&metadata.hash, "chunk hash")?;
        validate_hex_identity(&metadata.compressed_hash, "compressed chunk hash")?;
        let path = self.chunk_path(slot, &metadata.hash)?;
        let mut file =
            File::open(&path).with_context(|| format!("open native chunk {}", path.display()))?;
        if file.metadata()?.len() != metadata.compressed_bytes {
            bail!("native chunk compressed length mismatch");
        }
        let mut digest = Sha256::new();
        let mut bytes_read = 0u64;
        let mut buffer = [0u8; 64 * 1024];
        loop {
            let bytes = file.read(&mut buffer)?;
            if bytes == 0 {
                break;
            }
            note_compressed_verification_read(bytes);
            bytes_read = bytes_read.saturating_add(bytes as u64);
            digest.update(&buffer[..bytes]);
        }
        if bytes_read != metadata.compressed_bytes
            || hex::encode(digest.finalize()) != metadata.compressed_hash
        {
            bail!("native chunk compressed digest mismatch");
        }
        Ok(())
    }

    fn read_published_manifest(
        &self,
        slot: &str,
        generation: u64,
        revision: u64,
        root_hash: &str,
    ) -> anyhow::Result<SaveManifest> {
        let target = self.slot_dir(slot)?.join(if generation.is_multiple_of(2) {
            "superblock-a.json"
        } else {
            "superblock-b.json"
        });
        let bytes = fs::read(&target)
            .with_context(|| format!("read published native pointer {}", target.display()))?;
        let superblock = decode_superblock(slot, &bytes)?;
        if superblock.generation != generation
            || superblock.revision != revision
            || superblock.root_hash != root_hash
        {
            bail!("published native pointer does not identify the committed checkpoint");
        }
        self.read_manifest_for_superblock(slot, &superblock, &mut HashSet::new())
    }

    fn generation_directories(&self, slot: &str) -> anyhow::Result<Vec<(u64, PathBuf)>> {
        let root = self.slot_subdirectory(slot, "generations")?;
        let mut generations = Vec::new();
        for entry in fs::read_dir(root)? {
            let entry = entry?;
            let metadata = fs::symlink_metadata(entry.path())?;
            if path_is_redirect(&metadata) {
                bail!("native generation entry is a filesystem redirect")
            }
            if !entry.file_type()?.is_dir() {
                continue;
            }
            let Some(generation) = entry.file_name().to_string_lossy().parse::<u64>().ok() else {
                continue;
            };
            generations.push((generation, entry.path()));
        }
        generations.sort_by_key(|(generation, _)| *generation);
        Ok(generations)
    }

    fn next_generation(&self, slot: &str, previous_generation: Option<u64>) -> anyhow::Result<u64> {
        let maximum = self
            .generation_directories(slot)?
            .into_iter()
            .map(|(generation, _)| generation)
            .chain(previous_generation)
            .max()
            .unwrap_or(0);
        let mut next = maximum
            .checked_add(1)
            .ok_or_else(|| anyhow!("native save generation exhausted"))?;
        // Skipping an orphan can otherwise land on the same parity as the
        // active generation and overwrite its superblock. Preserve the dual
        // pointer fallback by always publishing to the opposite parity.
        if previous_generation
            .is_some_and(|previous| previous.is_multiple_of(2) == next.is_multiple_of(2))
        {
            next = next
                .checked_add(1)
                .ok_or_else(|| anyhow!("native save generation exhausted"))?;
        }
        Ok(next)
    }

    fn write_chunk(&self, slot: &str, bytes: &[u8]) -> anyhow::Result<ChunkMetadata> {
        let hash = sha256_hex(bytes);
        let path = self.chunk_path(slot, &hash)?;
        if path.exists() {
            return self.verify_reused_chunk(&path, hash, bytes.len() as u64);
        }
        let compressed = zstd::stream::encode_all(bytes, 3)?;
        self.atomic_write_new_budgeted(&path, &compressed)?;
        Ok(ChunkMetadata {
            hash,
            compressed_hash: sha256_hex(&compressed),
            uncompressed_bytes: bytes.len() as u64,
            compressed_bytes: compressed.len() as u64,
        })
    }

    fn verify_reused_chunk(
        &self,
        path: &Path,
        expected_hash: String,
        expected_bytes: u64,
    ) -> anyhow::Result<ChunkMetadata> {
        let file = File::open(path)?;
        let file_bytes = file.metadata()?.len();
        let reader = Sha256CountingReader::new(file);
        note_chunk_decode();
        let mut decoder = zstd::stream::read::Decoder::new(reader)?;
        let mut decoded_hash = Sha256::new();
        let mut decoded_bytes = 0u64;
        let mut buffer = [0u8; 64 * 1024];
        loop {
            let bytes = decoder.read(&mut buffer)?;
            if bytes == 0 {
                break;
            }
            decoded_bytes = decoded_bytes.saturating_add(bytes as u64);
            if decoded_bytes > expected_bytes {
                bail!("reused native chunk expands beyond the requested record");
            }
            decoded_hash.update(&buffer[..bytes]);
        }
        let reader = decoder.finish().into_inner();
        let (compressed_bytes, compressed_hash) = reader.finish();
        if decoded_bytes != expected_bytes
            || hex::encode(decoded_hash.finalize()) != expected_hash
            || compressed_bytes != file_bytes
        {
            bail!("reused native chunk does not match the requested record");
        }
        Ok(ChunkMetadata {
            hash: expected_hash,
            compressed_hash,
            uncompressed_bytes: expected_bytes,
            compressed_bytes,
        })
    }

    fn slot_dir(&self, slot: &str) -> anyhow::Result<PathBuf> {
        validate_slot(slot)?;
        let path = safe_child(&self.root, slot)?;
        self.fixed_directory(&path, "native save slot")
    }

    fn slot_subdirectory(&self, slot: &str, name: &str) -> anyhow::Result<PathBuf> {
        if !SLOT_DIRECTORIES.contains(&name) {
            bail!("native fixed slot directory is invalid")
        }
        let path = safe_child(&self.slot_dir(slot)?, name)?;
        self.fixed_directory(&path, "native fixed slot directory")
    }

    fn generation_dir(&self, slot: &str, generation: u64) -> anyhow::Result<PathBuf> {
        let path = safe_child(
            &self.slot_subdirectory(slot, "generations")?,
            &generation.to_string(),
        )?;
        reject_existing_directory_redirect(&path, "native save generation directory")?;
        Ok(path)
    }

    fn chunk_path(&self, slot: &str, hash: &str) -> anyhow::Result<PathBuf> {
        validate_hex_identity(hash, "chunk hash")?;
        let path = safe_child(
            &self.slot_subdirectory(slot, "chunks")?,
            &format!("{hash}.zst"),
        )?;
        reject_existing_path_redirect(&path, "native save chunk")?;
        Ok(path)
    }

    fn wal_path(&self, slot: &str) -> anyhow::Result<PathBuf> {
        let path = self.slot_subdirectory(slot, "wal")?.join("active.wal");
        reject_existing_path_redirect(&path, "native save WAL")?;
        Ok(path)
    }

    fn statistics_sidecar_path(&self, slot: &str) -> anyhow::Result<PathBuf> {
        let path = safe_child(&self.slot_dir(slot)?, STATISTICS_SIDECAR_FILE)?;
        reject_existing_path_redirect(&path, "native statistics sidecar")?;
        Ok(path)
    }

    fn fixed_directory(&self, path: &Path, label: &str) -> anyhow::Result<PathBuf> {
        let root_expected = self
            .fixed_directories
            .get(&self.root)
            .ok_or_else(|| anyhow!("native save root is not registered"))?;
        let root_actual = require_direct_directory(&self.root, "native save root")?;
        if &root_actual != root_expected {
            bail!("native save root changed after initialization")
        }
        let expected = self
            .fixed_directories
            .get(path)
            .ok_or_else(|| anyhow!("native fixed directory is not registered"))?;
        let actual = require_direct_directory(path, label)?;
        if &actual != expected {
            bail!("{label} changed after native save store initialization")
        }
        Ok(path.to_path_buf())
    }

    fn next_temporary_name(&self) -> anyhow::Result<String> {
        let id = self.next_temporary_id.get();
        self.next_temporary_id.set(
            id.checked_add(1)
                .ok_or_else(|| anyhow!("native temporary file counter exhausted"))?,
        );
        Ok(format!("{}-{id:016x}", self.temporary_namespace))
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

#[cfg(test)]
fn verify_generation_identity(
    slot: &str,
    superblock: &SuperblockPayload,
    manifest_bytes: &[u8],
) -> anyhow::Result<SaveManifest> {
    if sha256_hex(manifest_bytes) != superblock.manifest_hash {
        bail!("native manifest digest mismatch");
    }
    let manifest = serde_json::from_slice::<SaveManifest>(manifest_bytes)?;
    verify_generation_manifest(slot, superblock, manifest)
}

fn verify_generation_manifest(
    slot: &str,
    superblock: &SuperblockPayload,
    manifest: SaveManifest,
) -> anyhow::Result<SaveManifest> {
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

#[cfg(test)]
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
        note_chunk_decode();
        let decoded = zstd::stream::decode_all(compressed.as_slice())?;
        if decoded.len() as u64 != metadata.uncompressed_bytes
            || sha256_hex(&decoded) != metadata.hash
        {
            bail!("native chunk digest mismatch");
        }
    }
    Ok(())
}

#[cfg(test)]
std::thread_local! {
    static TEST_CHUNK_DECODE_COUNT: Cell<usize> = const { Cell::new(0) };
    static TEST_MAX_COMPRESSED_READ_BYTES: Cell<usize> = const { Cell::new(0) };
}

#[cfg(test)]
fn note_chunk_decode() {
    TEST_CHUNK_DECODE_COUNT.with(|count| count.set(count.get().saturating_add(1)));
}

#[cfg(not(test))]
#[inline]
fn note_chunk_decode() {}

#[cfg(test)]
fn note_compressed_verification_read(bytes: usize) {
    TEST_MAX_COMPRESSED_READ_BYTES.with(|maximum| maximum.set(maximum.get().max(bytes)));
}

#[cfg(not(test))]
#[inline]
fn note_compressed_verification_read(_bytes: usize) {}

#[cfg(test)]
fn reset_verification_instrumentation() {
    TEST_CHUNK_DECODE_COUNT.with(|count| count.set(0));
    TEST_MAX_COMPRESSED_READ_BYTES.with(|maximum| maximum.set(0));
}

#[cfg(test)]
fn verification_instrumentation() -> (usize, usize) {
    (
        TEST_CHUNK_DECODE_COUNT.with(Cell::get),
        TEST_MAX_COMPRESSED_READ_BYTES.with(Cell::get),
    )
}

fn encode_wal_frame(encoded: &[u8]) -> anyhow::Result<Vec<u8>> {
    if encoded.is_empty() || encoded.len() > MAX_WAL_ENTRY_BYTES {
        bail!("native WAL entry exceeds the bounded write limit");
    }
    let mut crc = crc32fast::Hasher::new();
    crc.update(encoded);
    let mut frame = Vec::with_capacity(WAL_FRAME_HEADER_BYTES as usize + encoded.len());
    frame.extend_from_slice(&(encoded.len() as u32).to_le_bytes());
    frame.extend_from_slice(&crc.finalize().to_le_bytes());
    frame.extend_from_slice(encoded);
    Ok(frame)
}

fn ensure_wal_append_budget(
    current_bytes: u64,
    current_entries: usize,
    frame_bytes: usize,
) -> anyhow::Result<()> {
    let frame_bytes = u64::try_from(frame_bytes)
        .map_err(|_| anyhow!("native WAL frame length cannot be represented"))?;
    if current_entries >= MAX_WAL_ENTRIES
        || current_bytes
            .checked_add(frame_bytes)
            .is_none_or(|bytes| bytes > MAX_WAL_BYTES)
    {
        bail!("native WAL budget is exhausted; checkpoint required");
    }
    Ok(())
}

fn active_wal_entries(
    entries: &[WalEntry],
    checkpoint_revision: u64,
) -> anyhow::Result<Vec<&WalEntry>> {
    let active = entries
        .iter()
        .filter(|entry| entry.revision > checkpoint_revision)
        .collect::<Vec<_>>();
    if let Some(first) = active.first()
        && first.base_revision != checkpoint_revision
    {
        bail!("native WAL does not continue the checkpoint revision");
    }
    if active
        .windows(2)
        .any(|window| window[1].base_revision != window[0].revision)
    {
        bail!("native WAL is not contiguous after the checkpoint");
    }
    Ok(active)
}

#[cfg(test)]
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

#[cfg(test)]
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
    if value.len() > MAX_SLOT_BYTES || !SAVE_SLOTS.contains(&value) {
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

fn validate_export_id(value: &str) -> anyhow::Result<()> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        bail!("native export ID is invalid");
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

#[cfg(windows)]
fn path_is_redirect(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;

    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn path_is_redirect(metadata: &fs::Metadata) -> bool {
    metadata.file_type().is_symlink()
}

#[cfg(windows)]
fn directory_identity(metadata: &fs::Metadata) -> DirectoryIdentity {
    use std::os::windows::fs::MetadataExt;

    DirectoryIdentity {
        // Stable Rust does not expose a by-handle file index. Creation time is
        // immutable for an ordinary directory and still detects normal-path
        // replacement in the revalidation windows without unsafe Win32 calls.
        volume: metadata.creation_time(),
        file: 0,
    }
}

#[cfg(unix)]
fn directory_identity(metadata: &fs::Metadata) -> DirectoryIdentity {
    use std::os::unix::fs::MetadataExt;

    DirectoryIdentity {
        volume: metadata.dev(),
        file: metadata.ino(),
    }
}

#[cfg(not(any(windows, unix)))]
fn directory_identity(metadata: &fs::Metadata) -> DirectoryIdentity {
    DirectoryIdentity {
        volume: metadata.len(),
        file: 0,
    }
}

fn direct_directory(path: &Path, label: &str) -> anyhow::Result<Option<DirectoryIdentity>> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(error).with_context(|| format!("inspect {label} {}", path.display()));
        }
    };
    if path_is_redirect(&metadata) {
        #[cfg(windows)]
        bail!("{label} is a Windows FILE_ATTRIBUTE_REPARSE_POINT");
        #[cfg(not(windows))]
        bail!("{label} is a symbolic link");
    }
    if !metadata.is_dir() {
        bail!("{label} is not a direct directory")
    }
    Ok(Some(directory_identity(&metadata)))
}

fn require_direct_directory(path: &Path, label: &str) -> anyhow::Result<DirectoryIdentity> {
    direct_directory(path, label)?.ok_or_else(|| anyhow!("{label} is missing"))
}

fn ensure_direct_directory(
    path: &Path,
    parent: &Path,
    label: &str,
) -> anyhow::Result<DirectoryIdentity> {
    let parent_identity = require_direct_directory(parent, &format!("{label} parent"))?;
    if let Some(identity) = direct_directory(path, label)? {
        if require_direct_directory(parent, &format!("{label} parent"))? != parent_identity {
            bail!("{label} parent changed while validating the directory")
        }
        return Ok(identity);
    }
    match fs::create_dir(path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => {
            return Err(error).with_context(|| format!("create {label} {}", path.display()));
        }
    }
    let identity = require_direct_directory(path, label)?;
    if require_direct_directory(parent, &format!("{label} parent"))? != parent_identity {
        bail!("{label} parent changed while publishing the directory")
    }
    Ok(identity)
}

fn ensure_save_root(root: &Path) -> anyhow::Result<()> {
    let mut ancestor = root
        .parent()
        .ok_or_else(|| anyhow!("native save root has no parent"))?;
    loop {
        if direct_directory(ancestor, "native save root ancestor")?.is_some() {
            break;
        }
        ancestor = ancestor
            .parent()
            .ok_or_else(|| anyhow!("native save root has no existing direct ancestor"))?;
    }
    if direct_directory(root, "native save root")?.is_none() {
        fs::create_dir_all(root)
            .with_context(|| format!("create native save root {}", root.display()))?;
    }
    require_direct_directory(root, "native save root")?;
    Ok(())
}

fn initialize_fixed_directories(
    root: &Path,
    root_identity: DirectoryIdentity,
) -> anyhow::Result<HashMap<PathBuf, DirectoryIdentity>> {
    let mut directories = HashMap::new();
    if require_direct_directory(root, "native save root")? != root_identity {
        bail!("native save root changed before fixed directory initialization")
    }
    directories.insert(root.to_path_buf(), root_identity);

    let exports = root.join("exports");
    directories.insert(
        exports.clone(),
        ensure_direct_directory(&exports, root, "native export root")?,
    );
    for slot in SAVE_SLOTS {
        let slot_path = safe_child(root, slot)?;
        directories.insert(
            slot_path.clone(),
            ensure_direct_directory(&slot_path, root, "native save slot")?,
        );
        for name in SLOT_DIRECTORIES {
            let directory = safe_child(&slot_path, name)?;
            directories.insert(
                directory.clone(),
                ensure_direct_directory(&directory, &slot_path, "native fixed slot directory")?,
            );
        }
    }
    Ok(directories)
}

fn verify_fixed_directories(
    directories: &HashMap<PathBuf, DirectoryIdentity>,
) -> anyhow::Result<()> {
    for (path, expected) in directories {
        let actual = require_direct_directory(path, "native fixed directory")?;
        if &actual != expected {
            bail!("native fixed directory changed during save store initialization")
        }
    }
    Ok(())
}

fn reject_existing_directory_redirect(path: &Path, label: &str) -> anyhow::Result<bool> {
    Ok(direct_directory(path, label)?.is_some())
}

fn reject_existing_path_redirect(path: &Path, label: &str) -> anyhow::Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if path_is_redirect(&metadata) => {
            #[cfg(windows)]
            bail!("{label} is a Windows FILE_ATTRIBUTE_REPARSE_POINT");
            #[cfg(not(windows))]
            bail!("{label} is a symbolic link");
        }
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error).with_context(|| format!("inspect {label} {}", path.display())),
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn manifest_root_hash(manifest: &SaveManifest) -> anyhow::Result<String> {
    let mut root = manifest.clone();
    root.root_hash.clear();
    let mut writer = Sha256CountingWriter::new();
    serde_json::to_writer(&mut writer, &root)?;
    Ok(writer.finish().1)
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

fn atomic_write_new(path: &Path, bytes: &[u8], temporary_name: &str) -> anyhow::Result<()> {
    if reject_existing_path_redirect(path, "immutable native target")? {
        let existing = fs::read(path)?;
        if existing == bytes {
            return Ok(());
        }
        bail!("immutable native path already contains different data")
    }
    let parent = path
        .parent()
        .ok_or_else(|| anyhow!("native write has no parent"))?;
    require_direct_directory(parent, "immutable native write parent")?;
    let temporary = parent.join(format!(
        ".{}.tmp-{temporary_name}",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("native")
    ));
    let mut temporary_guard = TemporaryPathGuard::new(temporary.clone());
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary)?;
    temporary_guard.arm();
    file.write_all(bytes)?;
    file.sync_all()?;
    drop(file);
    match publish_new_file_atomically(&temporary, path) {
        Ok(()) => {}
        Err(error) if path.exists() => {
            let existing = fs::read(path)?;
            if existing != bytes {
                return Err(error.into());
            }
        }
        Err(error) => return Err(error.into()),
    }
    sync_directory(parent)?;
    drop(temporary_guard);
    Ok(())
}

pub(crate) fn atomic_replace(
    path: &Path,
    bytes: &[u8],
    temporary_name: &str,
) -> anyhow::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| anyhow!("native replace has no parent"))?;
    require_direct_directory(parent, "atomic native replace parent")?;
    reject_existing_path_redirect(path, "atomic native replace target")?;
    let temporary = parent.join(format!(
        ".{}.tmp-{temporary_name}",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("native")
    ));
    let mut temporary_guard = TemporaryPathGuard::new(temporary.clone());
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary)?;
    temporary_guard.arm();
    file.write_all(bytes)?;
    file.sync_all()?;
    drop(file);
    if let Err(error) = replace_file_atomically(&temporary, path) {
        return Err(error.into());
    }
    drop(temporary_guard);
    Ok(())
}

#[cfg(not(windows))]
fn replace_file_atomically(source: &Path, target: &Path) -> std::io::Result<()> {
    fs::rename(source, target)
}

#[cfg(not(windows))]
fn publish_new_file_atomically(source: &Path, target: &Path) -> std::io::Result<()> {
    fs::hard_link(source, target)?;
    fs::remove_file(source)
}

#[cfg(windows)]
fn replace_file_atomically(source: &Path, target: &Path) -> std::io::Result<()> {
    move_file_write_through(source, target, true)
}

#[cfg(windows)]
fn publish_new_file_atomically(source: &Path, target: &Path) -> std::io::Result<()> {
    move_file_write_through(source, target, false)
}

#[cfg(windows)]
fn move_file_write_through(
    source: &Path,
    target: &Path,
    replace_existing: bool,
) -> std::io::Result<()> {
    use std::iter;
    use std::os::windows::ffi::OsStrExt;

    const MOVEFILE_REPLACE_EXISTING: u32 = 0x0000_0001;
    const MOVEFILE_WRITE_THROUGH: u32 = 0x0000_0008;

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn MoveFileExW(
            existing_file_name: *const u16,
            new_file_name: *const u16,
            flags: u32,
        ) -> i32;
    }

    let source = source
        .as_os_str()
        .encode_wide()
        .chain(iter::once(0))
        .collect::<Vec<_>>();
    let target = target
        .as_os_str()
        .encode_wide()
        .chain(iter::once(0))
        .collect::<Vec<_>>();
    // SAFETY: both paths are owned, NUL-terminated UTF-16 buffers that remain
    // alive for the duration of the synchronous Win32 call.
    let result = unsafe {
        MoveFileExW(
            source.as_ptr(),
            target.as_ptr(),
            MOVEFILE_WRITE_THROUGH
                | if replace_existing {
                    MOVEFILE_REPLACE_EXISTING
                } else {
                    0
                },
        )
    };
    if result == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

pub(crate) fn sync_directory(path: &Path) -> anyhow::Result<()> {
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
    use crate::disk_budget::DiskSpaceQuery;
    use std::collections::VecDeque;
    use std::sync::Mutex;
    use tempfile::tempdir;

    #[derive(Clone, Debug)]
    enum ProbeReply {
        Available(u64),
        Unsupported,
        Failure,
    }

    #[derive(Debug)]
    struct ScriptedDiskSpaceProbe {
        replies: Mutex<VecDeque<ProbeReply>>,
        fallback: Mutex<ProbeReply>,
    }

    impl ScriptedDiskSpaceProbe {
        fn available() -> Self {
            Self {
                replies: Mutex::new(VecDeque::new()),
                fallback: Mutex::new(ProbeReply::Available(u64::MAX)),
            }
        }

        fn replace_replies(&self, replies: impl IntoIterator<Item = ProbeReply>) {
            *self.replies.lock().unwrap() = replies.into_iter().collect();
        }

        fn set_fallback(&self, reply: ProbeReply) {
            *self.fallback.lock().unwrap() = reply;
        }
    }

    impl DiskSpaceProbe for ScriptedDiskSpaceProbe {
        fn query_available_bytes(&self, _directory: &Path) -> anyhow::Result<DiskSpaceQuery> {
            let reply = self
                .replies
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or_else(|| self.fallback.lock().unwrap().clone());
            match reply {
                ProbeReply::Available(bytes) => Ok(DiskSpaceQuery::Available(bytes)),
                ProbeReply::Unsupported => Ok(DiskSpaceQuery::Unsupported),
                ProbeReply::Failure => bail!("injected disk space query failure"),
            }
        }
    }

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

    #[cfg(windows)]
    fn create_directory_redirect(link: &Path, target: &Path) {
        let output = std::process::Command::new("cmd.exe")
            .args(["/d", "/c", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .output()
            .expect("launch Windows junction fixture command");
        assert!(
            output.status.success(),
            "create Windows junction fixture: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(path_is_redirect(&fs::symlink_metadata(link).unwrap()));
    }

    #[cfg(unix)]
    fn create_directory_redirect(link: &Path, target: &Path) {
        std::os::unix::fs::symlink(target, link).unwrap();
        assert!(path_is_redirect(&fs::symlink_metadata(link).unwrap()));
    }

    #[cfg(windows)]
    fn remove_directory_redirect(link: &Path) {
        fs::remove_dir(link).unwrap();
    }

    #[cfg(unix)]
    fn remove_directory_redirect(link: &Path) {
        fs::remove_file(link).unwrap();
    }

    #[cfg(any(windows, unix))]
    fn assert_redirect_error(error: &anyhow::Error) {
        let message = format!("{error:#}");
        #[cfg(windows)]
        assert!(
            message.contains("FILE_ATTRIBUTE_REPARSE_POINT"),
            "{message}"
        );
        #[cfg(unix)]
        assert!(message.contains("symbolic link"), "{message}");
    }

    fn assert_only_outside_sentinel(outside: &Path) {
        assert_eq!(
            fs::read(outside.join("stable-player-save.json")).unwrap(),
            b"stable-data"
        );
        assert_eq!(fs::read_dir(outside).unwrap().count(), 1);
    }

    fn seed_statistics_checkpoint(store: &mut SaveStore, revision: u64) -> SaveCommitResult {
        let transaction = begin(store, revision);
        store
            .put(&transaction, "base", Some("{\"version\":47}"))
            .unwrap();
        store.commit(&transaction).unwrap()
    }

    fn open_with_scripted_disk_probe(root: &Path) -> (SaveStore, Arc<ScriptedDiskSpaceProbe>) {
        let probe = Arc::new(ScriptedDiskSpaceProbe::available());
        let store = SaveStore::open_with_disk_space_probe(root, probe.clone()).unwrap();
        (store, probe)
    }

    fn assert_same_checkpoint(left: &SaveRecoveryResult, right: &SaveRecoveryResult) {
        assert_eq!(left.slot, right.slot);
        assert_eq!(left.generation, right.generation);
        assert_eq!(left.revision, right.revision);
        assert_eq!(left.root_hash, right.root_hash);
        assert_eq!(left.record_keys, right.record_keys);
    }

    #[test]
    fn low_space_chunk_and_wal_writes_leave_transaction_and_checkpoint_unchanged() {
        let root = tempdir().unwrap();
        let (mut store, probe) = open_with_scripted_disk_probe(root.path());
        seed_statistics_checkpoint(&mut store, 1);
        let baseline = store.recover("normal-main").unwrap().unwrap();

        let transaction_id = begin(&mut store, 2);
        let transaction_before = store.transactions[&transaction_id].records.clone();
        probe.set_fallback(ProbeReply::Available(
            crate::disk_budget::MINIMUM_FREE_SPACE_RESERVE_BYTES,
        ));
        let value = "a different immutable chunk";
        let error = store
            .put(&transaction_id, "changed", Some(value))
            .unwrap_err();
        assert!(
            error
                .to_string()
                .contains(crate::disk_budget::LOW_SPACE_ERROR)
        );
        assert_eq!(store.last_disk_budget_status(), DiskBudgetStatus::Failed);
        assert_eq!(
            store.transactions[&transaction_id].records,
            transaction_before
        );
        assert!(
            !store
                .chunk_path("normal-main", &sha256_hex(value.as_bytes()))
                .unwrap()
                .exists()
        );
        assert_same_checkpoint(&store.recover("normal-main").unwrap().unwrap(), &baseline);
        assert!(store.abort(&transaction_id));

        let wal_path = store.wal_path("normal-main").unwrap();
        let error = store
            .append_wal(
                "normal-main",
                baseline.revision,
                baseline.revision + 1,
                "low-space-wal",
                serde_json::json!({"paused": true}),
            )
            .unwrap_err();
        assert!(
            error
                .to_string()
                .contains(crate::disk_budget::LOW_SPACE_ERROR)
        );
        assert!(!wal_path.exists());
        assert_same_checkpoint(&store.recover("normal-main").unwrap().unwrap(), &baseline);

        probe.set_fallback(ProbeReply::Available(u64::MAX));
        store
            .append_wal(
                "normal-main",
                baseline.revision,
                baseline.revision + 1,
                "durable-wal-frame",
                serde_json::json!({"paused": true}),
            )
            .unwrap();
        let wal_before = fs::read(&wal_path).unwrap();
        probe.set_fallback(ProbeReply::Available(
            crate::disk_budget::MINIMUM_FREE_SPACE_RESERVE_BYTES,
        ));
        let error = store
            .append_wal(
                "normal-main",
                baseline.revision + 1,
                baseline.revision + 2,
                "blocked-second-wal-frame",
                serde_json::json!({"paused": false}),
            )
            .unwrap_err();
        assert!(
            error
                .to_string()
                .contains(crate::disk_budget::LOW_SPACE_ERROR)
        );
        assert_eq!(fs::read(&wal_path).unwrap(), wal_before);
        let active = store.read_wal("normal-main", baseline.revision).unwrap();
        assert_eq!(active.len(), 1);
        assert_eq!(active[0].command_id, "durable-wal-frame");
    }

    #[test]
    fn low_space_manifest_or_superblock_never_replaces_the_old_checkpoint() {
        let root = tempdir().unwrap();
        let (mut store, probe) = open_with_scripted_disk_probe(root.path());
        seed_statistics_checkpoint(&mut store, 1);
        let baseline = store.recover("normal-main").unwrap().unwrap();
        let transaction_id = begin(&mut store, 2);
        probe.set_fallback(ProbeReply::Available(
            crate::disk_budget::MINIMUM_FREE_SPACE_RESERVE_BYTES,
        ));
        let error = store.commit(&transaction_id).unwrap_err();
        assert!(
            error
                .to_string()
                .contains(crate::disk_budget::LOW_SPACE_ERROR)
        );
        assert_same_checkpoint(&store.recover("normal-main").unwrap().unwrap(), &baseline);
        assert!(!store.transactions.contains_key(&transaction_id));
        probe.set_fallback(ProbeReply::Available(u64::MAX));
        let retry = begin(&mut store, 2);
        store
            .put(&retry, "retry", Some("after-freeing-space"))
            .unwrap();
        let committed = store.commit(&retry).unwrap();
        assert!(committed.generation > baseline.generation);

        let second_root = tempdir().unwrap();
        let (mut store, probe) = open_with_scripted_disk_probe(second_root.path());
        seed_statistics_checkpoint(&mut store, 1);
        let baseline = store.recover("normal-main").unwrap().unwrap();
        let transaction_id = begin(&mut store, 2);
        probe.replace_replies([
            ProbeReply::Available(u64::MAX),
            ProbeReply::Available(crate::disk_budget::MINIMUM_FREE_SPACE_RESERVE_BYTES),
        ]);
        let error = store.commit(&transaction_id).unwrap_err();
        assert!(
            error
                .to_string()
                .contains(crate::disk_budget::LOW_SPACE_ERROR)
        );
        assert_same_checkpoint(&store.recover("normal-main").unwrap().unwrap(), &baseline);
        assert!(!store.transactions.contains_key(&transaction_id));
        let next_generation = store.generation_dir("normal-main", 2).unwrap();
        assert!(next_generation.join("manifest.json").exists());
        let superblock = store
            .slot_dir("normal-main")
            .unwrap()
            .join("superblock-a.json");
        assert!(!superblock.exists());
        probe.set_fallback(ProbeReply::Available(u64::MAX));
        let retry = begin(&mut store, 2);
        store
            .put(&retry, "retry", Some("after-freeing-space"))
            .unwrap();
        let committed = store.commit(&retry).unwrap();
        assert!(committed.generation > baseline.generation);
    }

    #[test]
    fn sidecar_and_export_low_space_fail_before_replacing_or_creating_files() {
        let root = tempdir().unwrap();
        let (mut store, probe) = open_with_scripted_disk_probe(root.path());
        let checkpoint = seed_statistics_checkpoint(&mut store, 1);
        store
            .write_statistics_sidecar(
                &checkpoint.slot,
                checkpoint.generation,
                checkpoint.revision,
                &checkpoint.root_hash,
                serde_json::json!({"samples": [1]}),
            )
            .unwrap();
        let sidecar = store.statistics_sidecar_path("normal-main").unwrap();
        let sidecar_before = fs::read(&sidecar).unwrap();
        probe.set_fallback(ProbeReply::Available(
            crate::disk_budget::MINIMUM_FREE_SPACE_RESERVE_BYTES,
        ));
        let error = store
            .write_statistics_sidecar(
                &checkpoint.slot,
                checkpoint.generation,
                checkpoint.revision,
                &checkpoint.root_hash,
                serde_json::json!({"samples": [2]}),
            )
            .unwrap_err();
        assert!(
            error
                .to_string()
                .contains(crate::disk_budget::LOW_SPACE_ERROR)
        );
        assert_eq!(fs::read(&sidecar).unwrap(), sidecar_before);

        let invoked = Cell::new(false);
        let error = store
            .publish_export("low-space-export", 7, |writer| {
                invoked.set(true);
                writer.write_all(b"blocked")?;
                Ok(())
            })
            .unwrap_err();
        assert!(
            error
                .to_string()
                .contains(crate::disk_budget::LOW_SPACE_ERROR)
        );
        assert!(!invoked.get());
        let export_root = root.path().join("exports");
        assert!(!export_root.join("low-space-export.part").exists());
        assert!(!export_root.join("low-space-export.json").exists());

        probe.set_fallback(ProbeReply::Available(u64::MAX));
        let error = store
            .publish_export("short-export", 8, |writer| {
                writer.write_all(b"short")?;
                Ok(())
            })
            .unwrap_err();
        assert!(error.to_string().contains("wrote fewer bytes"));
        assert!(!export_root.join("short-export.part").exists());
        assert!(!export_root.join("short-export.json").exists());
    }

    #[test]
    fn unsupported_probe_is_reported_but_query_failure_and_u64_overflow_fail_closed() {
        let root = tempdir().unwrap();
        let (mut store, probe) = open_with_scripted_disk_probe(root.path());
        probe.set_fallback(ProbeReply::Unsupported);
        seed_statistics_checkpoint(&mut store, 1);
        assert_eq!(
            store.last_disk_budget_status(),
            DiskBudgetStatus::Unsupported
        );
        assert!(store.recover("normal-main").unwrap().is_some());

        probe.set_fallback(ProbeReply::Failure);
        let error = store
            .require_disk_budget_in_directory(store.root(), 1)
            .unwrap_err();
        assert!(error.to_string().contains("query native disk free space"));
        assert_eq!(store.last_disk_budget_status(), DiskBudgetStatus::Failed);

        probe.set_fallback(ProbeReply::Available(u64::MAX));
        let error = store
            .require_disk_budget_in_directory(store.root(), u64::MAX)
            .unwrap_err();
        assert!(error.to_string().contains("byte calculation overflowed"));
        assert_eq!(store.last_disk_budget_status(), DiskBudgetStatus::Failed);
    }

    #[test]
    fn statistics_sidecar_round_trip_is_bound_to_one_checkpoint() {
        let root = tempdir().unwrap();
        let mut store = SaveStore::open(root.path()).unwrap();
        let first = seed_statistics_checkpoint(&mut store, 1);
        let history = serde_json::json!({"formatVersion":1,"samples":[{"elapsedSeconds":1}]});
        store
            .write_statistics_sidecar(
                &first.slot,
                first.generation,
                first.revision,
                &first.root_hash,
                history.clone(),
            )
            .unwrap();
        assert_eq!(
            store.read_statistics_sidecar(
                &first.slot,
                first.generation,
                first.revision,
                &first.root_hash,
            ),
            Some(history)
        );

        let second = seed_statistics_checkpoint(&mut store, 2);
        assert!(
            store
                .read_statistics_sidecar(
                    &second.slot,
                    second.generation,
                    second.revision,
                    &second.root_hash,
                )
                .is_none()
        );
        assert_eq!(store.recover("normal-main").unwrap().unwrap().revision, 2);
    }

    #[test]
    fn statistics_sidecar_corruption_and_size_overflow_are_fail_open() {
        let root = tempdir().unwrap();
        let mut store = SaveStore::open(root.path()).unwrap();
        let checkpoint = seed_statistics_checkpoint(&mut store, 1);
        store
            .write_statistics_sidecar(
                &checkpoint.slot,
                checkpoint.generation,
                checkpoint.revision,
                &checkpoint.root_hash,
                serde_json::json!({"samples":[]}),
            )
            .unwrap();
        let path = store.statistics_sidecar_path("normal-main").unwrap();
        fs::write(&path, b"corrupt diagnostics cache").unwrap();
        assert!(
            store
                .read_statistics_sidecar(
                    &checkpoint.slot,
                    checkpoint.generation,
                    checkpoint.revision,
                    &checkpoint.root_hash,
                )
                .is_none()
        );
        assert_eq!(store.recover("normal-main").unwrap().unwrap().revision, 1);

        File::create(&path)
            .unwrap()
            .set_len(MAX_STATISTICS_SIDECAR_BYTES + 1)
            .unwrap();
        assert!(
            store
                .read_statistics_sidecar(
                    &checkpoint.slot,
                    checkpoint.generation,
                    checkpoint.revision,
                    &checkpoint.root_hash,
                )
                .is_none()
        );
        let oversized = serde_json::json!({
            "blob": "x".repeat(MAX_STATISTICS_SIDECAR_BYTES as usize)
        });
        assert!(
            store
                .write_statistics_sidecar(
                    &checkpoint.slot,
                    checkpoint.generation,
                    checkpoint.revision,
                    &checkpoint.root_hash,
                    oversized,
                )
                .is_err()
        );
        assert_eq!(store.recover("normal-main").unwrap().unwrap().revision, 1);
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
    fn put_batch_rejects_an_invalid_later_record_without_mutating_the_transaction() {
        let root = tempdir().unwrap();
        let mut store = SaveStore::open(root.path()).unwrap();
        let tx = begin(&mut store, 1);
        store.put(&tx, "base", Some("old")).unwrap();
        store.commit(&tx).unwrap();

        let tx = begin(&mut store, 2);
        let before = store.transactions[&tx].clone();
        assert!(
            store
                .put_batch(
                    &tx,
                    &[("first", Some("valid")), ("../invalid", Some("invalid"))],
                )
                .is_err()
        );
        let after = &store.transactions[&tx];
        assert_eq!(after.records, before.records);
        assert_eq!(after.changed_keys, before.changed_keys);
        assert_eq!(after.changed_bytes, before.changed_bytes);
    }

    #[test]
    fn put_batch_write_failure_leaves_only_unreferenced_chunks() {
        let root = tempdir().unwrap();
        let mut store = SaveStore::open(root.path()).unwrap();
        let tx = begin(&mut store, 1);
        store.put(&tx, "base", Some("old")).unwrap();
        store.commit(&tx).unwrap();

        let tx = begin(&mut store, 2);
        let before = store.transactions[&tx].clone();
        let bad_value = "second-record-must-fail";
        let bad_path = store
            .chunk_path("normal-main", &sha256_hex(bad_value.as_bytes()))
            .unwrap();
        fs::create_dir_all(bad_path.parent().unwrap()).unwrap();
        fs::write(&bad_path, b"not-zstd").unwrap();
        assert!(
            store
                .put_batch(
                    &tx,
                    &[
                        ("first", Some("first-record-becomes-an-orphan")),
                        ("second", Some(bad_value)),
                    ],
                )
                .is_err()
        );
        let after = &store.transactions[&tx];
        assert_eq!(after.records, before.records);
        assert_eq!(after.changed_keys, before.changed_keys);
        assert_eq!(after.changed_bytes, before.changed_bytes);

        store.commit(&tx).unwrap();
        assert_eq!(
            store.read_record("normal-main", "base").unwrap().unwrap(),
            b"old"
        );
        assert!(store.read_record("normal-main", "first").unwrap().is_none());
    }

    #[test]
    fn reused_chunk_must_decode_to_the_requested_content() {
        let root = tempdir().unwrap();
        let store = SaveStore::open(root.path()).unwrap();
        for (desired, stored) in [
            (
                b"desired".as_slice(),
                zstd::stream::encode_all(b"wrong!!".as_slice(), 3).unwrap(),
            ),
            (b"garbage-target".as_slice(), b"not-zstd".to_vec()),
        ] {
            let path = store
                .chunk_path("normal-main", &sha256_hex(desired))
                .unwrap();
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, stored).unwrap();
            assert!(store.write_chunk("normal-main", desired).is_err());
        }

        let desired = b"truncated-target";
        let path = store
            .chunk_path("normal-main", &sha256_hex(desired))
            .unwrap();
        let mut truncated = zstd::stream::encode_all(desired.as_slice(), 3).unwrap();
        truncated.truncate(truncated.len() / 2);
        fs::write(path, truncated).unwrap();
        assert!(store.write_chunk("normal-main", desired).is_err());
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
            drop(store);

            let mut store = SaveStore::open(root.path()).unwrap();
            assert_eq!(store.recover("normal-main").unwrap().unwrap().revision, 1);
            assert_eq!(
                store.read_record("normal-main", "base").unwrap().unwrap(),
                b"old"
            );

            // A different retry must allocate past an immutable orphan rather
            // than colliding with it forever.
            let tx = begin(&mut store, 3);
            store.put(&tx, "base", Some("retry")).unwrap();
            let retried = store.commit(&tx).unwrap();
            assert_eq!(retried.revision, 3);
            assert_eq!(
                store.scan_published_manifests("normal-main").unwrap().len(),
                2,
                "retry must preserve the previous published fallback"
            );
            assert_eq!(
                store.read_record("normal-main", "base").unwrap().unwrap(),
                b"retry"
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
        drop(store);
        let store = SaveStore::open(root.path()).unwrap();
        assert_eq!(store.recover("normal-main").unwrap().unwrap().revision, 2);
        assert_eq!(
            store.read_record("normal-main", "base").unwrap().unwrap(),
            b"new"
        );
    }

    #[test]
    fn commit_ack_requires_exact_disk_readback() {
        let root = tempdir().unwrap();
        let mut store = SaveStore::open(root.path()).unwrap();
        let tx = begin(&mut store, 1);
        store.put(&tx, "base", Some("old")).unwrap();
        store.commit(&tx).unwrap();

        let tx = begin(&mut store, 2);
        store.put(&tx, "base", Some("new")).unwrap();
        let error = store
            .commit_with_fault(&tx, CommitFaultPoint::CorruptManifestBeforeReadback)
            .unwrap_err();
        assert!(format!("{error:#}").contains("verify published native checkpoint before ACK"));

        drop(store);
        let store = SaveStore::open(root.path()).unwrap();
        assert!(store.recover("normal-main").is_err());
    }

    #[test]
    fn recovery_refuses_to_fall_back_past_a_newer_corrupt_generation() {
        let root = tempdir().unwrap();
        let mut store = SaveStore::open(root.path()).unwrap();
        let tx = begin(&mut store, 1);
        store.put(&tx, "base", Some("old")).unwrap();
        store.commit(&tx).unwrap();
        // Metadata-only checkpoints may legitimately keep the same gameplay
        // revision. Generation ordering must still prevent a silent rollback.
        let tx = begin(&mut store, 1);
        store.put(&tx, "base", Some("new")).unwrap();
        store.commit(&tx).unwrap();

        let manifest_path = store
            .generation_dir("normal-main", 2)
            .unwrap()
            .join("manifest.json");
        let manifest: SaveManifest =
            serde_json::from_slice(&fs::read(manifest_path).unwrap()).unwrap();
        let chunk = store
            .chunk_path("normal-main", &manifest.records["base"].hash)
            .unwrap();
        let mut corrupted = fs::read(&chunk).unwrap();
        let middle = corrupted.len() / 2;
        corrupted[middle] ^= 0x40;
        fs::write(chunk, corrupted).unwrap();
        drop(store);

        let store = SaveStore::open(root.path()).unwrap();
        let error = store.recover("normal-main").unwrap_err();
        assert!(format!("{error:#}").contains("refuses to roll back"));
    }

    #[test]
    fn commit_revalidates_disk_before_overwriting_the_healthy_fallback_pointer() {
        let root = tempdir().unwrap();
        let mut store = SaveStore::open(root.path()).unwrap();
        let tx = begin(&mut store, 1);
        store.put(&tx, "base", Some("healthy-fallback")).unwrap();
        store.commit(&tx).unwrap();
        let tx = begin(&mut store, 2);
        store
            .put(&tx, "base", Some("active-before-bit-rot"))
            .unwrap();
        store.commit(&tx).unwrap();

        let fallback_pointer = store
            .slot_dir("normal-main")
            .unwrap()
            .join("superblock-b.json");
        let fallback_pointer_bytes = fs::read(&fallback_pointer).unwrap();
        let active_manifest: SaveManifest = serde_json::from_slice(
            &fs::read(
                store
                    .generation_dir("normal-main", 2)
                    .unwrap()
                    .join("manifest.json"),
            )
            .unwrap(),
        )
        .unwrap();
        let active_chunk = store
            .chunk_path("normal-main", &active_manifest.records["base"].hash)
            .unwrap();
        let mut truncated = fs::read(&active_chunk).unwrap();
        truncated.pop().unwrap();
        fs::write(active_chunk, truncated).unwrap();

        // begin() intentionally exercises the already-populated manifest
        // cache. The destructive commit boundary must still rescan disk.
        let tx = begin(&mut store, 3);
        store.put(&tx, "base", Some("must-not-publish")).unwrap();
        assert!(store.commit(&tx).is_err());
        assert_eq!(fs::read(&fallback_pointer).unwrap(), fallback_pointer_bytes);
        assert!(!store.generation_dir("normal-main", 3).unwrap().exists());
    }

    #[test]
    fn recovery_refuses_an_untrusted_pointer_identity() {
        let root = tempdir().unwrap();
        let mut store = SaveStore::open(root.path()).unwrap();
        let tx = begin(&mut store, 1);
        store.put(&tx, "base", Some("old")).unwrap();
        store.commit(&tx).unwrap();
        let tx = begin(&mut store, 2);
        store.put(&tx, "base", Some("new")).unwrap();
        store.commit(&tx).unwrap();
        let pointer = store
            .slot_dir("normal-main")
            .unwrap()
            .join("superblock-a.json");
        fs::write(pointer, b"not-a-trustworthy-superblock").unwrap();
        drop(store);

        let store = SaveStore::open(root.path()).unwrap();
        let error = store.recover("normal-main").unwrap_err();
        assert!(format!("{error:#}").contains("no trustworthy recovery identity"));
    }

    #[test]
    fn a_provably_older_corrupt_generation_does_not_hide_the_active_checkpoint() {
        let root = tempdir().unwrap();
        let mut store = SaveStore::open(root.path()).unwrap();
        let tx = begin(&mut store, 1);
        store.put(&tx, "base", Some("old")).unwrap();
        store.commit(&tx).unwrap();
        let first_manifest: SaveManifest = serde_json::from_slice(
            &fs::read(
                store
                    .generation_dir("normal-main", 1)
                    .unwrap()
                    .join("manifest.json"),
            )
            .unwrap(),
        )
        .unwrap();
        let tx = begin(&mut store, 2);
        store.put(&tx, "base", Some("new")).unwrap();
        store.commit(&tx).unwrap();
        let old_chunk = store
            .chunk_path("normal-main", &first_manifest.records["base"].hash)
            .unwrap();
        fs::write(old_chunk, b"corrupt-old-chunk").unwrap();
        drop(store);

        let store = SaveStore::open(root.path()).unwrap();
        let recovered = store.recover("normal-main").unwrap().unwrap();
        assert_eq!((recovered.generation, recovered.revision), (2, 2));
        assert_eq!(
            store.read_record("normal-main", "base").unwrap().unwrap(),
            b"new"
        );
    }

    #[test]
    fn stale_transactions_cannot_replace_a_newer_checkpoint() {
        let root = tempdir().unwrap();
        let mut store = SaveStore::open(root.path()).unwrap();
        let tx = begin(&mut store, 1);
        store.put(&tx, "base", Some("initial")).unwrap();
        store.commit(&tx).unwrap();

        let first = begin(&mut store, 2);
        store.put(&first, "base", Some("first")).unwrap();
        let stale = begin(&mut store, 2);
        store.put(&stale, "base", Some("stale")).unwrap();
        store.commit(&first).unwrap();
        assert!(store.commit(&stale).is_err());
        assert_eq!(
            store.read_record("normal-main", "base").unwrap().unwrap(),
            b"first"
        );
    }

    #[cfg(windows)]
    #[test]
    fn antivirus_style_pointer_lock_preserves_the_previous_checkpoint_and_allows_retry() {
        use std::os::windows::fs::OpenOptionsExt;

        let root = tempdir().unwrap();
        let mut store = SaveStore::open(root.path()).unwrap();
        for revision in 1..=2 {
            let tx = begin(&mut store, revision);
            store
                .put(&tx, "base", Some(&format!("revision-{revision}")))
                .unwrap();
            store.commit(&tx).unwrap();
        }
        let pointer = store
            .slot_dir("normal-main")
            .unwrap()
            .join("superblock-b.json");
        let previous_pointer = fs::read(&pointer).unwrap();
        let lock = OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&pointer)
            .unwrap();

        let tx = begin(&mut store, 3);
        store.put(&tx, "base", Some("locked-write")).unwrap();
        assert!(store.commit(&tx).is_err());
        drop(lock);
        assert_eq!(fs::read(&pointer).unwrap(), previous_pointer);
        drop(store);

        let mut store = SaveStore::open(root.path()).unwrap();
        assert_eq!(store.recover("normal-main").unwrap().unwrap().revision, 2);
        let tx = begin(&mut store, 4);
        store.put(&tx, "base", Some("retry-after-lock")).unwrap();
        let committed = store.commit(&tx).unwrap();
        assert_eq!(committed.revision, 4);
        assert_eq!(
            store.read_record("normal-main", "base").unwrap().unwrap(),
            b"retry-after-lock"
        );
    }

    #[test]
    fn compaction_keeps_the_active_and_verified_fallback() {
        let root = tempdir().unwrap();
        let mut store = SaveStore::open(root.path()).unwrap();
        for revision in 1..=3 {
            let tx = begin(&mut store, revision);
            store
                .put(&tx, "base", Some(&format!("revision-{revision}")))
                .unwrap();
            store.commit(&tx).unwrap();
        }

        assert_eq!(store.compact("normal-main", 2).unwrap(), 1);
        assert!(!store.generation_dir("normal-main", 1).unwrap().exists());
        assert!(store.generation_dir("normal-main", 2).unwrap().exists());
        assert!(store.generation_dir("normal-main", 3).unwrap().exists());
    }

    #[test]
    fn compaction_cannot_collect_chunks_owned_by_an_active_transaction() {
        let root = tempdir().unwrap();
        let mut store = SaveStore::open(root.path()).unwrap();
        for revision in 1..=2 {
            let tx = begin(&mut store, revision);
            store
                .put(&tx, "base", Some(&format!("revision-{revision}")))
                .unwrap();
            store.commit(&tx).unwrap();
        }

        let tx = begin(&mut store, 3);
        store.put(&tx, "base", Some("pending-transaction")).unwrap();
        assert!(store.compact("normal-main", 2).is_err());
        let committed = store.commit(&tx).unwrap();
        assert_eq!(committed.revision, 3);
        assert_eq!(
            store.read_record("normal-main", "base").unwrap().unwrap(),
            b"pending-transaction"
        );
    }

    #[test]
    fn compaction_does_not_delete_a_healthy_backup_when_the_pointer_fallback_is_bad() {
        let root = tempdir().unwrap();
        let mut store = SaveStore::open(root.path()).unwrap();
        for revision in 1..=3 {
            let tx = begin(&mut store, revision);
            store
                .put(&tx, "base", Some(&format!("revision-{revision}")))
                .unwrap();
            store.commit(&tx).unwrap();
        }
        let fallback_manifest: SaveManifest = serde_json::from_slice(
            &fs::read(
                store
                    .generation_dir("normal-main", 2)
                    .unwrap()
                    .join("manifest.json"),
            )
            .unwrap(),
        )
        .unwrap();
        let fallback_chunk = store
            .chunk_path("normal-main", &fallback_manifest.records["base"].hash)
            .unwrap();
        fs::write(fallback_chunk, b"corrupt-fallback-chunk").unwrap();

        assert_eq!(store.compact("normal-main", 2).unwrap(), 0);
        for generation in 1..=3 {
            assert!(
                store
                    .generation_dir("normal-main", generation)
                    .unwrap()
                    .exists()
            );
        }
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
    fn authority_wal_signed_zero_retry_conflicts_without_mutating_durable_data() {
        assert!(!json_values_bitwise_equal(
            &serde_json::json!(0),
            &serde_json::json!(0.0)
        ));
        assert!(!json_values_bitwise_equal(
            &serde_json::json!({"nested": [-0.0]}),
            &serde_json::json!({"nested": [0.0]}),
        ));

        let root = tempdir().unwrap();
        let mut store = SaveStore::open(root.path()).unwrap();
        let tx = begin(&mut store, 5);
        store.put(&tx, "base", Some("state-at-five")).unwrap();
        let checkpoint = store.commit(&tx).unwrap();

        let negative_zero = serde_json::json!({
            "kind": "stable-operation-v1",
            "command": {"changes": [{"value": -0.0}]},
        });
        let first = store
            .append_wal_idempotent(
                "normal-main",
                5,
                6,
                "authority-signed-zero",
                negative_zero.clone(),
            )
            .unwrap();
        let exact_retry = store
            .append_wal_idempotent("normal-main", 5, 6, "authority-signed-zero", negative_zero)
            .unwrap();
        assert!(exact_retry.duplicate);
        assert_eq!(exact_retry.entry_hash, first.entry_hash);

        let wal_path = store.wal_path("normal-main").unwrap();
        let wal_before_conflict = fs::read(&wal_path).unwrap();
        let recovered_before_conflict = store.recover("normal-main").unwrap().unwrap();
        let error = store
            .append_wal_idempotent(
                "normal-main",
                5,
                6,
                "authority-signed-zero",
                serde_json::json!({
                    "kind": "stable-operation-v1",
                    "command": {"changes": [{"value": 0.0}]},
                }),
            )
            .unwrap_err();
        assert!(error.to_string().contains("idempotency key conflicts"));

        assert_eq!(fs::read(&wal_path).unwrap(), wal_before_conflict);
        let entries = store.read_wal("normal-main", 5).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].entry_hash, first.entry_hash);
        assert_eq!(
            entries[0].payload["command"]["changes"][0]["value"]
                .as_f64()
                .unwrap()
                .to_bits(),
            (-0.0_f64).to_bits(),
        );
        let recovered_after_conflict = store.recover("normal-main").unwrap().unwrap();
        assert_eq!(
            (
                recovered_after_conflict.generation,
                recovered_after_conflict.revision,
                recovered_after_conflict.root_hash,
            ),
            (
                checkpoint.generation,
                recovered_before_conflict.revision,
                recovered_before_conflict.root_hash,
            ),
        );
    }

    fn seed_wal_checkpoint(store: &mut SaveStore) {
        let tx = begin(store, 5);
        store.put(&tx, "base", Some("state-at-five")).unwrap();
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
                "command-8",
                serde_json::json!({"seconds": 2}),
            )
            .unwrap();
    }

    fn next_wal_frame(store: &SaveStore, base_revision: u64, revision: u64) -> Vec<u8> {
        let scan = store.scan_wal("normal-main", false).unwrap();
        let previous_hash = scan
            .entries
            .last()
            .map(|entry| entry.entry_hash.clone())
            .unwrap_or_else(|| "0".repeat(64));
        let payload = serde_json::json!({"seconds": 3});
        let entry = WalEntry {
            base_revision,
            revision,
            command_id: format!("command-{revision}"),
            entry_hash: wal_entry_hash(
                base_revision,
                revision,
                &format!("command-{revision}"),
                &payload,
                &previous_hash,
            )
            .unwrap(),
            payload,
            previous_hash,
        };
        encode_wal_frame(&serde_json::to_vec(&entry).unwrap()).unwrap()
    }

    #[test]
    fn wal_repairs_only_a_final_torn_header_or_body_to_the_verified_prefix() {
        let root = tempdir().unwrap();
        let mut store = SaveStore::open(root.path()).unwrap();
        seed_wal_checkpoint(&mut store);
        let path = store.wal_path("normal-main").unwrap();
        let verified_prefix = fs::read(&path).unwrap();

        for header_bytes in 1..WAL_FRAME_HEADER_BYTES as usize {
            let mut torn = verified_prefix.clone();
            torn.extend_from_slice(&[0xa5; WAL_FRAME_HEADER_BYTES as usize][..header_bytes]);
            fs::write(&path, torn).unwrap();
            assert_eq!(store.read_wal("normal-main", 5).unwrap().len(), 2);
            assert_eq!(fs::read(&path).unwrap(), verified_prefix);
        }

        let frame = next_wal_frame(&store, 8, 9);
        let body_bytes = frame.len() - WAL_FRAME_HEADER_BYTES as usize;
        for partial_body in [0, 1, body_bytes / 2, body_bytes - 1] {
            let mut torn = verified_prefix.clone();
            torn.extend_from_slice(&frame[..WAL_FRAME_HEADER_BYTES as usize + partial_body]);
            fs::write(&path, torn).unwrap();
            assert_eq!(store.read_wal("normal-main", 5).unwrap().len(), 2);
            assert_eq!(fs::read(&path).unwrap(), verified_prefix);
        }
    }

    #[test]
    fn wal_complete_crc_json_and_chain_damage_fail_closed_without_truncation() {
        let root = tempdir().unwrap();
        let mut store = SaveStore::open(root.path()).unwrap();
        seed_wal_checkpoint(&mut store);
        let path = store.wal_path("normal-main").unwrap();
        let verified_prefix = fs::read(&path).unwrap();

        let mut bad_crc = verified_prefix.clone();
        let body_index = WAL_FRAME_HEADER_BYTES as usize + 1;
        bad_crc[body_index] ^= 0x20;
        fs::write(&path, &bad_crc).unwrap();
        assert!(store.read_wal("normal-main", 5).is_err());
        assert_eq!(fs::read(&path).unwrap(), bad_crc);

        let mut bad_json = verified_prefix.clone();
        bad_json.extend_from_slice(&encode_wal_frame(b"not-json").unwrap());
        fs::write(&path, &bad_json).unwrap();
        assert!(store.read_wal("normal-main", 5).is_err());
        assert_eq!(fs::read(&path).unwrap(), bad_json);

        fs::write(&path, &verified_prefix).unwrap();
        let payload = serde_json::json!({"seconds": 3});
        let wrong_previous_hash = "f".repeat(64);
        let invalid_entry = WalEntry {
            base_revision: 8,
            revision: 9,
            command_id: "command-bad-chain".to_owned(),
            entry_hash: wal_entry_hash(8, 9, "command-bad-chain", &payload, &wrong_previous_hash)
                .unwrap(),
            payload,
            previous_hash: wrong_previous_hash,
        };
        let mut bad_chain = verified_prefix.clone();
        bad_chain.extend_from_slice(
            &encode_wal_frame(&serde_json::to_vec(&invalid_entry).unwrap()).unwrap(),
        );
        fs::write(&path, &bad_chain).unwrap();
        assert!(store.read_wal("normal-main", 5).is_err());
        assert_eq!(fs::read(&path).unwrap(), bad_chain);
    }

    #[test]
    fn checkpoint_clears_a_fully_covered_wal_and_reopens_cleanly() {
        let root = tempdir().unwrap();
        let mut store = SaveStore::open(root.path()).unwrap();
        seed_wal_checkpoint(&mut store);
        let tx = begin(&mut store, 8);
        store.put(&tx, "base", Some("checkpoint-eight")).unwrap();
        let committed = store.commit(&tx).unwrap();
        assert!(!committed.wal_maintenance_pending);
        assert_eq!(committed.wal_bytes, 0);
        assert_eq!(
            fs::read(store.wal_path("normal-main").unwrap()).unwrap(),
            b""
        );
        drop(store);

        let store = SaveStore::open(root.path()).unwrap();
        let recovered = store.recover("normal-main").unwrap().unwrap();
        assert_eq!(recovered.revision, 8);
        assert_eq!(recovered.wal_entry_count, 0);
    }

    #[test]
    fn checkpoint_preserves_the_complete_wal_when_a_newer_suffix_remains() {
        let root = tempdir().unwrap();
        let mut store = SaveStore::open(root.path()).unwrap();
        seed_wal_checkpoint(&mut store);
        let path = store.wal_path("normal-main").unwrap();
        let before = fs::read(&path).unwrap();
        let receipts = store
            .scan_wal("normal-main", false)
            .unwrap()
            .entries
            .into_iter()
            .map(|entry| (entry.command_id, entry.entry_hash))
            .collect::<Vec<_>>();

        let tx = begin(&mut store, 6);
        store.put(&tx, "base", Some("checkpoint-six")).unwrap();
        let committed = store.commit(&tx).unwrap();
        assert!(committed.wal_maintenance_pending);
        assert_eq!(committed.wal_bytes, before.len() as u64);
        assert_eq!(fs::read(&path).unwrap(), before);
        assert_eq!(
            store
                .scan_wal("normal-main", false)
                .unwrap()
                .entries
                .into_iter()
                .map(|entry| (entry.command_id, entry.entry_hash))
                .collect::<Vec<_>>(),
            receipts
        );
        assert_eq!(store.read_wal("normal-main", 6).unwrap()[0].revision, 8);
        store
            .append_wal(
                "normal-main",
                8,
                9,
                "command-9",
                serde_json::json!({"seconds": 1}),
            )
            .unwrap();
    }

    #[test]
    fn checkpoint_rejects_a_revision_in_the_middle_of_a_wal_operation() {
        let root = tempdir().unwrap();
        let mut store = SaveStore::open(root.path()).unwrap();
        seed_wal_checkpoint(&mut store);
        let tx = begin(&mut store, 7);
        store.put(&tx, "base", Some("must-not-publish")).unwrap();
        assert!(store.commit(&tx).is_err());
        assert!(!store.generation_dir("normal-main", 2).unwrap().exists());
        assert!(
            !store
                .slot_dir("normal-main")
                .unwrap()
                .join("superblock-a.json")
                .exists()
        );
    }

    #[test]
    fn wal_logic_damage_blocks_checkpoint_before_pointer_publication() {
        let root = tempdir().unwrap();
        let mut store = SaveStore::open(root.path()).unwrap();
        seed_wal_checkpoint(&mut store);
        let path = store.wal_path("normal-main").unwrap();
        let mut damaged = fs::read(&path).unwrap();
        damaged[WAL_FRAME_HEADER_BYTES as usize + 2] ^= 0x08;
        fs::write(&path, &damaged).unwrap();

        let tx = begin(&mut store, 8);
        store.put(&tx, "base", Some("must-not-publish")).unwrap();
        let error = store.commit(&tx).unwrap_err();
        assert!(format!("{error:#}").contains("WAL checksum"));
        assert!(!store.generation_dir("normal-main", 2).unwrap().exists());
        assert_eq!(fs::read(&path).unwrap(), damaged);
    }

    #[test]
    fn wal_maintenance_io_failure_acks_checkpoint_but_preserves_verified_wal() {
        let root = tempdir().unwrap();
        let mut store = SaveStore::open(root.path()).unwrap();
        seed_wal_checkpoint(&mut store);
        let path = store.wal_path("normal-main").unwrap();
        let before = fs::read(&path).unwrap();

        let tx = begin(&mut store, 8);
        store.put(&tx, "base", Some("checkpoint-eight")).unwrap();
        let committed = store
            .commit_with_fault(&tx, CommitFaultPoint::WalMaintenanceIoFailure)
            .unwrap();
        assert_eq!(committed.revision, 8);
        assert!(committed.wal_maintenance_pending);
        assert_eq!(committed.wal_bytes, before.len() as u64);
        assert_eq!(fs::read(&path).unwrap(), before);

        let recovered = store.recover("normal-main").unwrap().unwrap();
        assert_eq!(recovered.revision, 8);
        assert_eq!(recovered.wal_entry_count, 0);
        assert_eq!(fs::read(&path).unwrap(), b"");
    }

    #[test]
    fn next_append_retries_pending_wal_maintenance_before_extending_the_chain() {
        let root = tempdir().unwrap();
        let mut store = SaveStore::open(root.path()).unwrap();
        seed_wal_checkpoint(&mut store);
        let tx = begin(&mut store, 8);
        store.put(&tx, "base", Some("checkpoint-eight")).unwrap();
        let committed = store
            .commit_with_fault(&tx, CommitFaultPoint::WalMaintenanceIoFailure)
            .unwrap();
        assert!(committed.wal_maintenance_pending);

        store
            .append_wal(
                "normal-main",
                8,
                9,
                "command-after-maintenance-retry",
                serde_json::json!({"seconds": 1}),
            )
            .unwrap();
        let scan = store.scan_wal("normal-main", false).unwrap();
        assert_eq!(scan.entries.len(), 1);
        assert_eq!(scan.entries[0].base_revision, 8);
        assert_eq!(scan.entries[0].revision, 9);
        assert_eq!(scan.entries[0].previous_hash, "0".repeat(64));
    }

    #[test]
    fn wal_identity_change_after_pointer_publication_fails_closed_not_pending() {
        let root = tempdir().unwrap();
        let mut store = SaveStore::open(root.path()).unwrap();
        seed_wal_checkpoint(&mut store);
        let tx = begin(&mut store, 8);
        store.put(&tx, "base", Some("checkpoint-eight")).unwrap();
        let error = store
            .commit_with_fault(&tx, CommitFaultPoint::MutateWalAfterSuperblockPublish)
            .unwrap_err();
        assert!(format!("{error:#}").contains("verify WAL identity"));

        // The pointer was durable but never ACKed. Recovery repairs only the
        // injected torn tail, keeps revision 8, then safely converges the WAL.
        let recovered = store.recover("normal-main").unwrap().unwrap();
        assert_eq!(recovered.revision, 8);
        assert_eq!(recovered.wal_entry_count, 0);
    }

    #[test]
    fn wal_budget_requires_a_checkpoint_before_append_can_grow_unbounded() {
        assert!(ensure_wal_append_budget(MAX_WAL_BYTES - 8, 0, 8).is_ok());
        assert!(ensure_wal_append_budget(MAX_WAL_BYTES - 8, 0, 9).is_err());
        assert!(ensure_wal_append_budget(0, MAX_WAL_ENTRIES - 1, 8).is_ok());
        assert!(ensure_wal_append_budget(0, MAX_WAL_ENTRIES, 8).is_err());

        let root = tempdir().unwrap();
        let store = SaveStore::open(root.path()).unwrap();
        let path = store.wal_path("normal-main").unwrap();
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        File::create(&path)
            .unwrap()
            .set_len(MAX_WAL_BYTES + 1)
            .unwrap();
        let error = store.read_wal("normal-main", 0).unwrap_err();
        assert!(format!("{error:#}").contains("byte budget"));
    }

    #[cfg(windows)]
    #[test]
    fn antivirus_lock_prevents_torn_wal_repair_until_the_file_is_released() {
        use std::os::windows::fs::OpenOptionsExt;

        let root = tempdir().unwrap();
        let mut store = SaveStore::open(root.path()).unwrap();
        seed_wal_checkpoint(&mut store);
        let path = store.wal_path("normal-main").unwrap();
        let verified = fs::read(&path).unwrap();
        let mut torn = verified.clone();
        torn.push(0x7f);
        fs::write(&path, &torn).unwrap();
        let lock = OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&path)
            .unwrap();
        assert!(store.read_wal("normal-main", 5).is_err());
        drop(lock);
        assert_eq!(fs::read(&path).unwrap(), torn);
        assert_eq!(store.read_wal("normal-main", 5).unwrap().len(), 2);
        assert_eq!(fs::read(&path).unwrap(), verified);
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
    fn existing_normal_fixed_directories_remain_compatible() {
        let root = tempdir().unwrap();
        for path in [
            root.path().join("exports"),
            root.path().join("normal-main").join("generations"),
            root.path().join("normal-main").join("chunks"),
            root.path().join("normal-main").join("wal"),
        ] {
            fs::create_dir_all(path).unwrap();
        }
        let store = SaveStore::open(root.path()).unwrap();
        assert!(store.slot_dir("normal-main").unwrap().is_dir());
        drop(store);
        SaveStore::open(root.path()).unwrap();
    }

    #[cfg(any(windows, unix))]
    #[test]
    fn initialization_rejects_prepositioned_fixed_directory_redirects() {
        for relative in [
            PathBuf::from("normal-main"),
            PathBuf::from("exports"),
            PathBuf::from("normal-main").join("wal"),
        ] {
            let root = tempdir().unwrap();
            let outside = tempdir().unwrap();
            fs::write(
                outside.path().join("stable-player-save.json"),
                b"stable-data",
            )
            .unwrap();
            let redirect = root.path().join(&relative);
            if let Some(parent) = redirect.parent()
                && parent != root.path()
            {
                fs::create_dir_all(parent).unwrap();
            }
            create_directory_redirect(&redirect, outside.path());

            let error = SaveStore::open(root.path()).unwrap_err();
            assert_redirect_error(&error);
            assert_only_outside_sentinel(outside.path());
            remove_directory_redirect(&redirect);
        }
    }

    #[cfg(any(windows, unix))]
    #[test]
    fn every_use_rejects_replaced_slot_and_export_directories() {
        let slot_root = tempdir().unwrap();
        let slot_outside = tempdir().unwrap();
        fs::write(
            slot_outside.path().join("stable-player-save.json"),
            b"stable-data",
        )
        .unwrap();
        let mut slot_store = SaveStore::open(slot_root.path()).unwrap();
        let slot_path = slot_root.path().join("normal-main");
        for name in SLOT_DIRECTORIES {
            fs::remove_dir(slot_path.join(name)).unwrap();
        }
        fs::remove_dir(&slot_path).unwrap();
        create_directory_redirect(&slot_path, slot_outside.path());
        let error = slot_store
            .begin(
                "normal-main",
                "normal",
                47,
                "01234567",
                "builtin:test",
                1,
                1,
            )
            .unwrap_err();
        assert_redirect_error(&error);
        assert_only_outside_sentinel(slot_outside.path());
        remove_directory_redirect(&slot_path);
        drop(slot_store);

        let export_root = tempdir().unwrap();
        let export_outside = tempdir().unwrap();
        fs::write(
            export_outside.path().join("stable-player-save.json"),
            b"stable-data",
        )
        .unwrap();
        let export_store = SaveStore::open(export_root.path()).unwrap();
        let exports = export_root.path().join("exports");
        fs::remove_dir(&exports).unwrap();
        create_directory_redirect(&exports, export_outside.path());
        let invoked = Cell::new(false);
        let error = export_store
            .publish_export("must-not-escape", 7, |file| {
                invoked.set(true);
                file.write_all(b"escaped")?;
                Ok(())
            })
            .unwrap_err();
        assert_redirect_error(&error);
        assert!(!invoked.get());
        assert_only_outside_sentinel(export_outside.path());
        remove_directory_redirect(&exports);
    }

    #[test]
    fn save_root_has_a_process_lifetime_exclusive_lock() {
        let root = tempdir().unwrap();
        let first = SaveStore::open(root.path()).unwrap();
        assert!(SaveStore::open(root.path()).is_err());
        drop(first);
        SaveStore::open(root.path()).unwrap();
    }

    #[test]
    fn temporary_file_cleanup_never_deletes_an_unowned_collision() {
        let root = tempdir().unwrap();
        let manifest = root.path().join("manifest.json");
        let collision = root.path().join(".manifest.json.tmp-collision");
        fs::write(&collision, b"unowned-stale-file").unwrap();
        assert!(atomic_write_new(&manifest, b"new", "collision").is_err());
        assert_eq!(fs::read(&collision).unwrap(), b"unowned-stale-file");
        assert!(!manifest.exists());

        let pointer = root.path().join("pointer.json");
        fs::create_dir(&pointer).unwrap();
        fs::write(pointer.join("keep"), b"old-authority").unwrap();
        let unrelated = root.path().join(".pointer.json.tmp-unrelated");
        fs::write(&unrelated, b"unrelated").unwrap();
        assert!(atomic_replace(&pointer, b"new-authority", "owned").is_err());
        assert_eq!(fs::read(pointer.join("keep")).unwrap(), b"old-authority");
        assert_eq!(fs::read(unrelated).unwrap(), b"unrelated");
        assert!(!root.path().join(".pointer.json.tmp-owned").exists());
    }

    #[test]
    fn immutable_new_file_publication_rejects_a_different_target_collision() {
        let root = tempdir().unwrap();
        let target = root.path().join("immutable.json");
        atomic_write_new(&target, b"first", "first").unwrap();
        atomic_write_new(&target, b"first", "same-content-retry").unwrap();
        assert!(atomic_write_new(&target, b"different", "collision").is_err());
        assert_eq!(fs::read(target).unwrap(), b"first");
    }

    #[test]
    fn checkpoint_verification_streams_compressed_bytes_without_zstd_decode() {
        reset_verification_instrumentation();
        let root = tempdir().unwrap();
        let mut store = SaveStore::open(root.path()).unwrap();
        let tx = begin(&mut store, 1);
        store
            .put(&tx, "base", Some(&"native-checkpoint-data".repeat(4096)))
            .unwrap();
        store.commit(&tx).unwrap();
        let (decodes, maximum_read) = verification_instrumentation();
        assert_eq!(decodes, 0);
        assert!((1..=64 * 1024).contains(&maximum_read));

        drop(store);
        reset_verification_instrumentation();
        let store = SaveStore::open(root.path()).unwrap();
        store.recover("normal-main").unwrap().unwrap();
        let (decodes, maximum_read) = verification_instrumentation();
        assert_eq!(decodes, 0);
        assert!((1..=64 * 1024).contains(&maximum_read));

        store.read_record("normal-main", "base").unwrap().unwrap();
        assert_eq!(verification_instrumentation().0, 1);
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
