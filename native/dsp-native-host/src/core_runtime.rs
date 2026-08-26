use std::collections::{BTreeMap, HashMap};

use anyhow::{anyhow, bail};
use dsp_native_core::canonical::canonical_sha256;
use dsp_native_core::catalog::RuntimeCatalog;
use dsp_native_core::{
    CommandApplyResult, CoreAdvanceRequest, CoreAdvanceResult, CoreCheckpointIdentity, CoreState,
    CoreStateSummary, SimulationCommandPatch,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::save_store::{SaveCommitResult, SaveStore, WalEntry};

const MAX_CORE_SESSIONS: usize = 4;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreOpenResult {
    pub session_id: String,
    pub authority: &'static str,
    pub checkpoint_revision: u64,
    pub replayed_wal_entries: usize,
    pub replayed_revision: u64,
    pub summary: CoreStateSummary,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WalRegistryIdentity {
    fingerprint: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DurableWalIntent {
    schema_version: u16,
    session_id: String,
    generation: u64,
    sequence: u64,
    intent_sha256: String,
    base_state_revision: u64,
    command: Option<SimulationCommandPatch>,
    simulation_seconds: f64,
    wall_seconds: f64,
    #[allow(dead_code)]
    #[serde(default)]
    approximate: bool,
    registry: WalRegistryIdentity,
    committed_at_ms: f64,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind")]
enum AcceptedWalPayload {
    #[serde(rename = "stable-operation-v1", rename_all = "camelCase")]
    Stable {
        base_state_revision: u64,
        result_state_revision: u64,
        command: Option<SimulationCommandPatch>,
        simulation_seconds: f64,
        wall_seconds: f64,
        registry: WalRegistryIdentity,
    },
    #[serde(rename = "durable-operation-v1", rename_all = "camelCase")]
    Durable {
        intent: DurableWalIntent,
        result_state_revision: u64,
    },
}

struct ReplayOperation {
    base_revision: u64,
    result_revision: u64,
    command: Option<SimulationCommandPatch>,
    simulation_seconds: f64,
    wall_seconds: f64,
    registry_fingerprint: String,
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn valid_session_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}

fn validate_operation_numbers(operation: &ReplayOperation) -> anyhow::Result<()> {
    if operation.base_revision > MAX_SAFE_INTEGER
        || operation.result_revision > MAX_SAFE_INTEGER
        || operation.result_revision <= operation.base_revision
        || !operation.simulation_seconds.is_finite()
        || operation.simulation_seconds < 0.0
        || !operation.wall_seconds.is_finite()
        || operation.wall_seconds < 0.0
    {
        bail!("native core WAL operation bounds are invalid");
    }
    Ok(())
}

fn verify_durable_intent_digest(payload: &Value, expected: &str) -> anyhow::Result<()> {
    if !valid_sha256(expected) {
        bail!("native core durable intent digest is invalid");
    }
    let mut unsigned = payload
        .as_object()
        .cloned()
        .ok_or_else(|| anyhow!("native core durable intent is not an object"))?;
    unsigned.remove("intentSha256");
    if canonical_sha256(&Value::Object(unsigned)) != expected {
        bail!("native core durable intent digest does not match");
    }
    Ok(())
}

fn decode_wal_operation(entry: &WalEntry) -> anyhow::Result<ReplayOperation> {
    let decoded = serde_json::from_value::<AcceptedWalPayload>(entry.payload.clone())
        .map_err(|error| anyhow!("decode native core WAL operation: {error}"))?;
    let operation = match decoded {
        AcceptedWalPayload::Stable {
            base_state_revision,
            result_state_revision,
            command,
            simulation_seconds,
            wall_seconds,
            registry,
        } => ReplayOperation {
            base_revision: base_state_revision,
            result_revision: result_state_revision,
            command,
            simulation_seconds,
            wall_seconds,
            registry_fingerprint: registry.fingerprint,
        },
        AcceptedWalPayload::Durable {
            intent,
            result_state_revision,
        } => {
            let intent_value = entry
                .payload
                .get("intent")
                .ok_or_else(|| anyhow!("native core durable WAL intent is missing"))?;
            verify_durable_intent_digest(intent_value, &intent.intent_sha256)?;
            if intent.schema_version != 1
                || !valid_session_id(&intent.session_id)
                || intent.generation == 0
                || intent.generation > MAX_SAFE_INTEGER
                || intent.sequence == 0
                || intent.sequence > MAX_SAFE_INTEGER
                || !intent.committed_at_ms.is_finite()
                || intent.committed_at_ms < 0.0
            {
                bail!("native core durable WAL intent metadata is invalid");
            }
            ReplayOperation {
                base_revision: intent.base_state_revision,
                result_revision: result_state_revision,
                command: intent.command,
                simulation_seconds: intent.simulation_seconds,
                wall_seconds: intent.wall_seconds,
                registry_fingerprint: intent.registry.fingerprint,
            }
        }
    };
    validate_operation_numbers(&operation)?;
    if operation.base_revision != entry.base_revision || operation.result_revision != entry.revision
    {
        bail!("native core WAL payload revision range does not match its envelope");
    }
    Ok(operation)
}

fn replay_wal_entry(state: &mut CoreState, entry: &WalEntry) -> anyhow::Result<()> {
    let operation = decode_wal_operation(entry)?;
    if operation.registry_fingerprint != state.identity.registry_fingerprint {
        bail!("native core WAL registry fingerprint changed");
    }
    state.replay_operation(
        operation.base_revision,
        operation.result_revision,
        operation.command.as_ref(),
        operation.simulation_seconds,
        operation.wall_seconds,
    )?;
    Ok(())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreCompareResult {
    pub matches: bool,
    pub revision_matches: bool,
    pub canonical_matches: bool,
    pub domain_matches: bool,
    pub promotion_blocked: bool,
    pub summary: CoreStateSummary,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreCommitOperationRequest {
    pub command_id: String,
    pub base_revision: u64,
    #[serde(default)]
    pub command: Option<SimulationCommandPatch>,
    pub simulation_seconds: f64,
    pub wall_seconds: f64,
    #[serde(default)]
    pub include_diagnostics: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreCommitOperationResult {
    pub command_id: String,
    pub base_revision: u64,
    /// Revision accepted by this idempotency key.
    pub revision: u64,
    /// Current session revision. It can be newer when an old lost response is
    /// retried after later operations have already committed.
    pub current_revision: u64,
    pub entry_hash: String,
    pub wal_bytes: u64,
    pub duplicate: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<CoreStateSummary>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreCheckpointResult {
    pub checkpoint: SaveCommitResult,
    pub summary: CoreStateSummary,
}

pub struct CoreRegistry {
    next_session_id: u64,
    sessions: HashMap<String, CoreState>,
}

impl Default for CoreRegistry {
    fn default() -> Self {
        Self {
            next_session_id: 1,
            sessions: HashMap::new(),
        }
    }
}

impl CoreRegistry {
    #[allow(clippy::too_many_arguments)]
    pub fn open(
        &mut self,
        store: &SaveStore,
        slot: &str,
        generation: u64,
        root_hash: &str,
        revision: u64,
        registry_fingerprint: &str,
        catalog_value: Value,
    ) -> anyhow::Result<CoreOpenResult> {
        if self.sessions.len() >= MAX_CORE_SESSIONS {
            bail!("native core session limit has been reached");
        }
        let recovery = store
            .recover(slot)?
            .ok_or_else(|| anyhow!("native core checkpoint slot is missing"))?;
        if recovery.generation != generation
            || recovery.root_hash != root_hash
            || recovery.revision != revision
            || recovery.registry_fingerprint != registry_fingerprint
        {
            bail!("native core checkpoint identity changed before open");
        }
        let catalog = RuntimeCatalog::from_value(catalog_value, registry_fingerprint)?;
        let mut records = BTreeMap::new();
        for key in &recovery.record_keys {
            let value = store
                .read_record_at(slot, key, generation, root_hash)?
                .ok_or_else(|| anyhow!("native core checkpoint record disappeared"))?;
            records.insert(key.clone(), value);
        }
        let mut state = CoreState::from_internal_records(
            CoreCheckpointIdentity {
                slot: slot.to_owned(),
                generation,
                root_hash: root_hash.to_owned(),
                revision,
                state_version: recovery.state_version,
                mode: recovery.mode,
                registry_fingerprint: registry_fingerprint.to_owned(),
                base_primary_checksum: recovery.base_checksum,
            },
            &records,
            catalog,
        )?;
        let wal = store.read_wal(slot, revision)?;
        for entry in &wal {
            replay_wal_entry(&mut state, entry)?;
        }
        let summary = state.summary()?;
        let session_id = format!("core-{}", self.next_session_id);
        self.next_session_id = self.next_session_id.saturating_add(1);
        self.sessions.insert(session_id.clone(), state);
        Ok(CoreOpenResult {
            session_id,
            authority: "shadow",
            checkpoint_revision: revision,
            replayed_wal_entries: wal.len(),
            replayed_revision: summary.revision,
            summary,
        })
    }

    pub fn status(&self, session_id: &str) -> anyhow::Result<CoreStateSummary> {
        self.session(session_id)?.summary()
    }

    pub fn projection(
        &self,
        session_id: &str,
        base_fields: &[String],
        entity_ids: &[String],
        belt_ids: &[String],
    ) -> anyhow::Result<Value> {
        self.session(session_id)?
            .projection(base_fields, entity_ids, belt_ids)
    }

    pub fn apply_command(
        &mut self,
        session_id: &str,
        command: &SimulationCommandPatch,
    ) -> anyhow::Result<CommandApplyResult> {
        self.session_mut(session_id)?.apply_command(command)
    }

    pub fn advance(
        &mut self,
        session_id: &str,
        request: &CoreAdvanceRequest,
    ) -> anyhow::Result<CoreAdvanceResult> {
        self.session_mut(session_id)?.advance(request)
    }

    /// Durably accepts one authoritative operation. The exact command and
    /// simulation budget are preflighted on a transactional state before the
    /// hash-chained WAL is synced. Only then is the prepared state installed.
    /// A repeated command ID is an idempotent receipt lookup, never a second
    /// simulation step.
    pub fn commit_operation(
        &mut self,
        store: &SaveStore,
        session_id: &str,
        request: CoreCommitOperationRequest,
    ) -> anyhow::Result<CoreCommitOperationResult> {
        validate_session_id(session_id)?;
        if request.base_revision > MAX_SAFE_INTEGER
            || !request.simulation_seconds.is_finite()
            || request.simulation_seconds < 0.0
            || !request.wall_seconds.is_finite()
            || request.wall_seconds < 0.0
        {
            bail!("native authoritative operation bounds are invalid");
        }
        if let Some(command) = request.command.as_ref() {
            if command.base_revision != request.base_revision {
                bail!("native authoritative command base revision is invalid");
            }
        }

        let (slot, fingerprint, current_revision) = {
            let state = self.session(session_id)?;
            (
                state.identity.slot.clone(),
                state.identity.registry_fingerprint.clone(),
                state.revision,
            )
        };

        if let Some(existing) = store.find_wal_command(&slot, &request.command_id)? {
            let operation = decode_wal_operation(&existing)?;
            let requested_command = serde_json::to_value(&request.command)?;
            let accepted_command = serde_json::to_value(&operation.command)?;
            if operation.base_revision != request.base_revision
                || operation.registry_fingerprint != fingerprint
                || operation.simulation_seconds.to_bits() != request.simulation_seconds.to_bits()
                || operation.wall_seconds.to_bits() != request.wall_seconds.to_bits()
                || requested_command != accepted_command
            {
                bail!("native authoritative idempotency key conflicts with another operation");
            }
            if current_revision < operation.result_revision {
                if current_revision != operation.base_revision {
                    bail!("native authoritative retry cannot prove revision continuity");
                }
                let state = self.session_mut(session_id)?;
                state.replay_operation(
                    operation.base_revision,
                    operation.result_revision,
                    operation.command.as_ref(),
                    operation.simulation_seconds,
                    operation.wall_seconds,
                )?;
            }
            let state = self.session(session_id)?;
            if state.revision < operation.result_revision {
                bail!("native authoritative retry did not reach its durable revision");
            }
            let receipt = store.append_wal_idempotent(
                &slot,
                operation.base_revision,
                operation.result_revision,
                &request.command_id,
                existing.payload,
            )?;
            return Ok(CoreCommitOperationResult {
                command_id: request.command_id,
                base_revision: operation.base_revision,
                revision: operation.result_revision,
                current_revision: state.revision,
                entry_hash: receipt.entry_hash,
                wal_bytes: receipt.wal_bytes,
                duplicate: receipt.duplicate,
                summary: request
                    .include_diagnostics
                    .then(|| state.summary())
                    .transpose()?,
            });
        }

        if current_revision != request.base_revision {
            bail!("native authoritative operation base revision is not current");
        }
        let mut prepared = self.session(session_id)?.clone();
        if let Some(command) = request.command.as_ref() {
            prepared.apply_command(command)?;
        }
        let advanced = prepared.advance(&CoreAdvanceRequest {
            base_revision: prepared.revision,
            simulation_seconds: request.simulation_seconds,
            wall_seconds: request.wall_seconds,
            include_diagnostics: false,
        })?;
        if !advanced.supported {
            bail!(
                "native authoritative operation reached unsupported domain: {}",
                advanced.reason.as_deref().unwrap_or("unknown")
            );
        }
        if prepared.revision <= request.base_revision {
            bail!("native authoritative operation made no revision progress");
        }
        let result_revision = prepared.revision;
        let payload = json!({
            "kind": "stable-operation-v1",
            "baseStateRevision": request.base_revision,
            "resultStateRevision": result_revision,
            "command": request.command,
            "simulationSeconds": request.simulation_seconds,
            "wallSeconds": request.wall_seconds,
            "approximate": false,
            "registry": { "fingerprint": fingerprint },
        });
        let receipt = store.append_wal_idempotent(
            &slot,
            request.base_revision,
            result_revision,
            &request.command_id,
            payload,
        )?;
        let state = self.session_mut(session_id)?;
        *state = prepared;
        Ok(CoreCommitOperationResult {
            command_id: request.command_id,
            base_revision: request.base_revision,
            revision: result_revision,
            current_revision: result_revision,
            entry_hash: receipt.entry_hash,
            wal_bytes: receipt.wal_bytes,
            duplicate: receipt.duplicate,
            summary: request
                .include_diagnostics
                .then(|| state.summary())
                .transpose()?,
        })
    }

    /// Publishes a new content-addressed generation directly from native-owned
    /// records. Records are streamed in bounded chunks and the save manifest is
    /// atomically published by `SaveStore`; no full JSON state crosses IPC.
    pub fn checkpoint(
        &mut self,
        store: &mut SaveStore,
        session_id: &str,
        saved_at_ms: u64,
    ) -> anyhow::Result<CoreCheckpointResult> {
        validate_session_id(session_id)?;
        if saved_at_ms > MAX_SAFE_INTEGER {
            bail!("native core checkpoint timestamp is invalid");
        }
        let (
            slot,
            mode,
            state_version,
            fingerprint,
            base_checksum,
            generation,
            root_hash,
            revision,
        ) = {
            let state = self.session(session_id)?;
            (
                state.identity.slot.clone(),
                state.identity.mode.clone(),
                state.identity.state_version,
                state.identity.registry_fingerprint.clone(),
                state.identity.base_primary_checksum.clone(),
                state.identity.generation,
                state.identity.root_hash.clone(),
                state.revision,
            )
        };
        let recovery = store
            .recover(&slot)?
            .ok_or_else(|| anyhow!("native core checkpoint slot disappeared"))?;
        if recovery.generation != generation
            || recovery.root_hash != root_hash
            || recovery.revision != self.session(session_id)?.identity.revision
        {
            bail!("native core checkpoint base generation changed");
        }
        let previous_keys = recovery.record_keys;
        let begin = store.begin(
            &slot,
            &mode,
            state_version,
            &base_checksum,
            &fingerprint,
            revision,
            saved_at_ms,
        )?;
        let transaction_id = begin.transaction_id;
        let written = self
            .session(session_id)?
            .visit_internal_checkpoint_records(saved_at_ms, |key, value| {
                store.put(&transaction_id, key, Some(value))
            });
        let active_keys = match written {
            Ok(keys) => keys,
            Err(error) => {
                store.abort(&transaction_id);
                return Err(error.context("stream native core checkpoint records"));
            }
        };
        let active = active_keys
            .into_iter()
            .collect::<std::collections::HashSet<_>>();
        let prefix = format!("dsp-idle-network.internal.v1.chunked.v1.{mode}.");
        for key in previous_keys {
            if key.starts_with(&prefix) && !active.contains(&key) {
                if let Err(error) = store.put(&transaction_id, &key, None) {
                    store.abort(&transaction_id);
                    return Err(error.context("remove stale native core checkpoint record"));
                }
            }
        }
        let checkpoint = match store.commit(&transaction_id) {
            Ok(checkpoint) => checkpoint,
            Err(error) => {
                store.abort(&transaction_id);
                return Err(error.context("publish native core checkpoint"));
            }
        };
        let state = self.session_mut(session_id)?;
        state.install_checkpoint_identity(checkpoint.generation, checkpoint.root_hash.clone());
        Ok(CoreCheckpointResult {
            checkpoint,
            summary: state.summary()?,
        })
    }

    pub fn compare(
        &self,
        session_id: &str,
        revision: u64,
        canonical_sha256: &str,
        domain_sha256: &str,
    ) -> anyhow::Result<CoreCompareResult> {
        if canonical_sha256.len() != 64
            || domain_sha256.len() != 64
            || !canonical_sha256
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit())
            || !domain_sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            bail!("native core comparison digest is invalid");
        }
        let summary = self.status(session_id)?;
        let revision_matches = summary.revision == revision;
        let canonical_matches = summary.canonical_sha256 == canonical_sha256;
        let domain_matches = summary.domain_sha256 == domain_sha256;
        Ok(CoreCompareResult {
            matches: revision_matches && canonical_matches && domain_matches,
            revision_matches,
            canonical_matches,
            domain_matches,
            // Promotion stays blocked until every domain reports complete and
            // the long-running shadow gate has been satisfied externally.
            promotion_blocked: !summary.coverage.authority_eligible,
            summary,
        })
    }

    pub fn close(&mut self, session_id: &str) -> anyhow::Result<bool> {
        validate_session_id(session_id)?;
        Ok(self.sessions.remove(session_id).is_some())
    }

    pub fn close_all(&mut self) {
        self.sessions.clear();
    }

    fn session(&self, session_id: &str) -> anyhow::Result<&CoreState> {
        validate_session_id(session_id)?;
        self.sessions
            .get(session_id)
            .ok_or_else(|| anyhow!("native core session is missing"))
    }

    fn session_mut(&mut self, session_id: &str) -> anyhow::Result<&mut CoreState> {
        validate_session_id(session_id)?;
        self.sessions
            .get_mut(session_id)
            .ok_or_else(|| anyhow!("native core session is missing"))
    }
}

fn validate_session_id(value: &str) -> anyhow::Result<()> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        bail!("native core session ID is invalid");
    }
    Ok(())
}
