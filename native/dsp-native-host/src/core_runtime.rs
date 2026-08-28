use std::collections::{HashMap, HashSet};
use std::io::Read;

use anyhow::{anyhow, bail};
use dsp_native_core::canonical::canonical_sha256;
use dsp_native_core::catalog::RuntimeCatalog;
use dsp_native_core::{
    CommandApplyResult, CoreAdvanceMode, CoreAdvanceRequest, CoreAdvanceResult,
    CoreCheckpointIdentity, CoreState, CoreStateSummary, SimulationCommandPatch,
    V47EnvelopeExportResult, V47ImportProof, parse_v47_envelope, parse_v47_envelope_stream,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::exact_realtime_lease::{
    ExactRealtimeCheckpoint, ExactRealtimeLease, ExactRealtimeLeasePurpose, ExactRealtimeStateProof,
};
use crate::save_store::{SaveCommitResult, SaveStore, WalEntry, json_values_bitwise_equal};

const MAX_CORE_SESSIONS: usize = 4;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

pub const PLAYER_AUTHORITY_GATE_CAPABILITY: &str = "native-core-player-authority-gate-v1";

fn persist_statistics_sidecar_best_effort(
    store: &SaveStore,
    slot: &str,
    generation: u64,
    revision: u64,
    root_hash: &str,
    history: Option<Value>,
) {
    let Some(history) = history else {
        return;
    };
    let _ = store.write_statistics_sidecar(slot, generation, revision, root_hash, history);
}

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
    #[serde(default)]
    advance_mode: CoreAdvanceMode,
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
        #[serde(default)]
        advance_mode: CoreAdvanceMode,
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
    advance_mode: CoreAdvanceMode,
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

fn commands_bitwise_equal(
    requested: &Option<SimulationCommandPatch>,
    accepted: &Option<SimulationCommandPatch>,
) -> anyhow::Result<bool> {
    Ok(json_values_bitwise_equal(
        &serde_json::to_value(requested)?,
        &serde_json::to_value(accepted)?,
    ))
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
            advance_mode,
            registry,
        } => ReplayOperation {
            base_revision: base_state_revision,
            result_revision: result_state_revision,
            command,
            simulation_seconds,
            wall_seconds,
            advance_mode,
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
                advance_mode: intent.advance_mode,
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
        operation.advance_mode,
    )?;
    Ok(())
}

fn derive_exact_realtime_commit_operation(
    lease: &ExactRealtimeLease,
    slot: &str,
    mode: &str,
    state_version: u16,
    registry_fingerprint: &str,
    current_revision: u64,
    request: &CoreCommitOperationExactRealtimeRequest,
) -> anyhow::Result<CoreCommitOperationRequest> {
    if lease.purpose()? != ExactRealtimeLeasePurpose::Experiment {
        bail!("native player-authority lease cannot enter the E1 experiment commit path")
    }
    let pending = lease
        .pending_tick
        .as_ref()
        .ok_or_else(|| anyhow!("native exact realtime lease has no pending tick"))?;
    if lease.run_id != request.run_id
        || lease.registry_fingerprint != request.registry_fingerprint
        || lease.slot != slot
        || slot != "normal-main"
        || lease.mode != mode
        || mode != "normal"
        || state_version != 47
        || lease.registry_fingerprint != registry_fingerprint
        || !matches!(
            lease.phase,
            crate::exact_realtime_lease::ExactRealtimeLeasePhase::Active
                | crate::exact_realtime_lease::ExactRealtimeLeasePhase::Paused
        )
        || pending.simulation_seconds != 1
        || pending.wall_seconds != 1
        || !matches!(
            current_revision,
            revision if revision == pending.base_revision || revision == pending.expected_revision
        )
    {
        bail!("native exact realtime lease does not authorize the private commit")
    }
    Ok(CoreCommitOperationRequest {
        command_id: pending.command_id.clone(),
        base_revision: pending.base_revision,
        command: None,
        simulation_seconds: pending.simulation_seconds as f64,
        wall_seconds: pending.wall_seconds as f64,
        advance_mode: CoreAdvanceMode::Exact,
        include_diagnostics: true,
    })
}

fn require_exact_realtime_result_revision(
    lease: Option<&ExactRealtimeLease>,
    revision: u64,
) -> anyhow::Result<()> {
    if let Some(lease) = lease
        && lease
            .pending_tick
            .as_ref()
            .map(|pending| pending.expected_revision)
            != Some(revision)
    {
        bail!("native exact realtime operation result differs from the pending tick")
    }
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
    pub advance_mode: CoreAdvanceMode,
    #[serde(default)]
    pub include_diagnostics: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CoreCommitOperationExactRealtimeRequest {
    pub run_id: String,
    pub registry_fingerprint: String,
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
    pub encoded_records: usize,
    pub reused_records: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CoreCheckpointAcknowledgeExactRealtimeRequest {
    pub run_id: String,
    pub registry_fingerprint: String,
    pub sequence: u64,
    pub command_id: String,
    pub settled_deadline_ms: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CoreCheckpointExactRealtimeFinalizationRequest {
    pub run_id: String,
    pub registry_fingerprint: String,
    pub saved_at_ms: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CorePreparePlayerAuthorityRequest {
    pub run_id: String,
    pub expected_checkpoint: ExactRealtimeCheckpoint,
    pub settled_deadline_ms: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CoreActivatePlayerAuthorityRequest {
    pub run_id: String,
    pub expected_checkpoint: ExactRealtimeCheckpoint,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreCheckpointAcknowledgeExactRealtimeResult {
    pub checkpoint: ExactRealtimeCheckpoint,
    pub summary: CoreStateSummary,
    pub lease: ExactRealtimeLease,
    pub duplicate: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CorePlayerAuthorityLeaseResult {
    pub lease: ExactRealtimeLease,
    pub summary: CoreStateSummary,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreExportResult {
    pub export_id: String,
    pub mode: String,
    pub result: V47EnvelopeExportResult,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreImportV47Result {
    pub session_id: String,
    pub authority: &'static str,
    pub checkpoint: SaveCommitResult,
    pub import: V47ImportProof,
    pub summary: CoreStateSummary,
}

pub struct CoreRegistry {
    next_session_id: u64,
    sessions: HashMap<String, CoreState>,
    uncertain_checkpoint_transactions: HashMap<String, UncertainCoreCheckpoint>,
}

#[derive(Clone, Debug)]
struct UncertainCoreCheckpoint {
    transaction_id: String,
    revision: u64,
}

impl Default for CoreRegistry {
    fn default() -> Self {
        Self {
            next_session_id: 1,
            sessions: HashMap::new(),
            uncertain_checkpoint_transactions: HashMap::new(),
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
        let records = store.read_records_at(slot, &recovery.record_keys, generation, root_hash)?;
        let mut state = CoreState::from_owned_internal_records(
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
            records,
            catalog,
        )?;
        if let Some(history) = store.read_statistics_sidecar(slot, generation, revision, root_hash)
        {
            // This file is a disposable diagnostic cache. Any schema,
            // identity or content error leaves the public-history rebuild in
            // place and must never prevent the authoritative checkpoint from
            // opening.
            let _ = state.restore_production_history_sidecar(history);
        }
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

    pub fn import_v47<R: Read>(
        &mut self,
        store: &mut SaveStore,
        reader: R,
        expected_byte_length: u64,
        registry_fingerprint: &str,
        catalog_value: Value,
    ) -> anyhow::Result<CoreImportV47Result> {
        self.import_v47_with_commit_mode(
            store,
            reader,
            Some(expected_byte_length),
            registry_fingerprint,
            catalog_value,
            |store, transaction_id| store.commit(transaction_id),
        )
    }

    pub fn import_v47_stream<R: Read>(
        &mut self,
        store: &mut SaveStore,
        reader: R,
        registry_fingerprint: &str,
        catalog_value: Value,
    ) -> anyhow::Result<CoreImportV47Result> {
        self.import_v47_with_commit_mode(
            store,
            reader,
            None,
            registry_fingerprint,
            catalog_value,
            |store, transaction_id| store.commit(transaction_id),
        )
    }

    #[cfg(test)]
    #[allow(clippy::too_many_arguments)]
    fn import_v47_with_commit<R: Read>(
        &mut self,
        store: &mut SaveStore,
        reader: R,
        expected_byte_length: u64,
        registry_fingerprint: &str,
        catalog_value: Value,
        commit: impl FnOnce(&mut SaveStore, &str) -> anyhow::Result<SaveCommitResult>,
    ) -> anyhow::Result<CoreImportV47Result> {
        self.import_v47_with_commit_mode(
            store,
            reader,
            Some(expected_byte_length),
            registry_fingerprint,
            catalog_value,
            commit,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn import_v47_with_commit_mode<R: Read>(
        &mut self,
        store: &mut SaveStore,
        reader: R,
        expected_byte_length: Option<u64>,
        registry_fingerprint: &str,
        catalog_value: Value,
        commit: impl FnOnce(&mut SaveStore, &str) -> anyhow::Result<SaveCommitResult>,
    ) -> anyhow::Result<CoreImportV47Result> {
        if self.sessions.len() >= MAX_CORE_SESSIONS {
            bail!("native core session limit has been reached");
        }
        let catalog = RuntimeCatalog::from_value(catalog_value, registry_fingerprint)?;
        let parsed = match expected_byte_length {
            Some(expected) => parse_v47_envelope(reader, expected)?,
            None => parse_v47_envelope_stream(reader)?,
        };
        let slot = match parsed.proof().mode.as_str() {
            "normal" => "normal-main",
            "speedrun" => "speedrun-main",
            _ => bail!("native v47 import mode is invalid"),
        };
        let previous = store.recover(slot)?;
        let revision = previous
            .as_ref()
            .map(|checkpoint| {
                checkpoint
                    .revision
                    .checked_add(1)
                    .filter(|revision| *revision <= MAX_SAFE_INTEGER)
                    .ok_or_else(|| anyhow!("native v47 import revision is exhausted"))
            })
            .transpose()?
            .unwrap_or(0);
        let (mut state, import) =
            parsed.into_core_state(revision, registry_fingerprint, catalog)?;
        let summary = state.summary()?;

        // Allocate every in-memory identity before the durable publication.
        // After `store.commit` succeeds, installing the already-validated
        // state and inserting it into the bounded map are infallible.
        let session_id = format!("core-{}", self.next_session_id);
        let next_session_id = self
            .next_session_id
            .checked_add(1)
            .ok_or_else(|| anyhow!("native core session counter exhausted"))?;
        let begin = store.begin(
            slot,
            &import.mode,
            47,
            &import.state_checksum,
            registry_fingerprint,
            revision,
            import.saved_at_ms,
        )?;
        let transaction_id = begin.transaction_id;
        let visited = state
            .visit_dirty_internal_checkpoint_records(import.saved_at_ms, |key, value| {
                store.put(&transaction_id, key, Some(value))
            });
        let visit = match visited {
            Ok(visit) => visit,
            Err(error) => {
                state.abort_checkpoint_visit();
                store.abort(&transaction_id);
                return Err(error.context("stream imported native checkpoint records"));
            }
        };
        let active = visit.active_keys.iter().cloned().collect::<HashSet<_>>();
        let prefix = format!("dsp-idle-network.internal.v1.chunked.v1.{}.", import.mode);
        if let Some(previous) = previous {
            for key in previous.record_keys {
                if key.starts_with(&prefix)
                    && !active.contains(&key)
                    && let Err(error) = store.put(&transaction_id, &key, None)
                {
                    state.abort_checkpoint_visit();
                    store.abort(&transaction_id);
                    return Err(error.context("remove stale imported native checkpoint record"));
                }
            }
        }
        let checkpoint = match commit(store, &transaction_id) {
            Ok(checkpoint) => checkpoint,
            Err(error) => {
                state.abort_checkpoint_visit();
                store.abort(&transaction_id);
                return Err(error.context("publish imported native checkpoint"));
            }
        };
        state.install_checkpoint_identity(checkpoint.generation, checkpoint.root_hash.clone());
        // The authoritative checkpoint is already durable. Sidecar I/O is
        // deliberately best-effort and cannot change the import result.
        persist_statistics_sidecar_best_effort(
            store,
            &checkpoint.slot,
            checkpoint.generation,
            checkpoint.revision,
            &checkpoint.root_hash,
            state.production_history_sidecar(),
        );
        self.next_session_id = next_session_id;
        self.sessions.insert(session_id.clone(), state);
        Ok(CoreImportV47Result {
            session_id,
            authority: "shadow",
            checkpoint,
            import,
            summary,
        })
    }

    /// Prepares the durable player-authority writer fence from one exact
    /// current CoreRegistry session. The IPC caller supplies only a run ID,
    /// deadline and expected checkpoint identity; all state proof material and
    /// the registry fingerprint are derived here after disk readback. Current
    /// coverage deliberately fails this gate closed.
    pub fn prepare_player_authority(
        &self,
        store: &SaveStore,
        session_id: &str,
        request: CorePreparePlayerAuthorityRequest,
    ) -> anyhow::Result<CorePlayerAuthorityLeaseResult> {
        if request.settled_deadline_ms > MAX_SAFE_INTEGER {
            bail!("native player-authority entry deadline is invalid");
        }
        let summary = self.validated_player_authority_session(
            store,
            session_id,
            &request.expected_checkpoint,
        )?;
        if !summary.coverage.authority_eligible {
            bail!("native core domain coverage is not player-authority eligible");
        }
        let proof = ExactRealtimeStateProof {
            revision: summary.revision,
            canonical_sha256: summary.canonical_sha256.clone(),
            domain_sha256: summary.domain_sha256.clone(),
        };
        let lease = store.prepare_player_authority_lease(
            session_id.to_owned(),
            request.run_id,
            summary.registry_fingerprint.clone(),
            request.expected_checkpoint,
            proof,
            request.settled_deadline_ms,
        )?;
        Ok(CorePlayerAuthorityLeaseResult { lease, summary })
    }

    /// Player-authority activation remains a separate CoreRegistry-owned
    /// operation so the raw E1 lease protocol cannot activate a production
    /// lease. Session identity, current publication and coverage are all
    /// revalidated immediately before the durable phase transition.
    pub fn activate_player_authority(
        &self,
        store: &SaveStore,
        session_id: &str,
        request: CoreActivatePlayerAuthorityRequest,
    ) -> anyhow::Result<CorePlayerAuthorityLeaseResult> {
        let summary = self.validated_player_authority_session(
            store,
            session_id,
            &request.expected_checkpoint,
        )?;
        let current = store.require_exact_realtime_lease()?;
        if current.purpose()? != ExactRealtimeLeasePurpose::PlayerAuthority
            || current.authority_session_id.as_deref() != Some(session_id)
            || current.run_id != request.run_id
            || current.registry_fingerprint != summary.registry_fingerprint
            || current.checkpoint != request.expected_checkpoint
        {
            bail!("native player-authority activation lease identity conflicts");
        }
        if !summary.coverage.authority_eligible {
            bail!("native core domain coverage is not player-authority eligible");
        }
        let lease = store.activate_player_authority_lease(
            session_id,
            &request.run_id,
            &summary.registry_fingerprint,
        )?;
        Ok(CorePlayerAuthorityLeaseResult { lease, summary })
    }

    fn validated_player_authority_session(
        &self,
        store: &SaveStore,
        session_id: &str,
        expected_checkpoint: &ExactRealtimeCheckpoint,
    ) -> anyhow::Result<CoreStateSummary> {
        validate_session_id(session_id)?;
        self.require_checkpoint_reconciliation_before_mutation(session_id)?;
        let state = self.session(session_id)?;
        let summary = state.summary()?;
        if state.identity.slot != "normal-main"
            || state.identity.mode != "normal"
            || state.identity.state_version != 47
            || summary.mode != "normal"
            || summary.state_version != 47
            || summary.registry_fingerprint != state.identity.registry_fingerprint
            || summary.paused
        {
            bail!("native player-authority entry requires a running v47 normal-main session");
        }
        if state.revision != state.identity.revision
            || summary.revision != state.revision
            || expected_checkpoint.generation != state.identity.generation
            || expected_checkpoint.root_hash != state.identity.root_hash
            || expected_checkpoint.revision != state.identity.revision
        {
            bail!("native player-authority checkpoint/session/revision identity conflicts");
        }
        let published = store
            .latest_published_checkpoint_identity("normal-main")?
            .ok_or_else(|| anyhow!("normal-main published checkpoint is missing"))?;
        if published.slot != "normal-main"
            || published.mode != "normal"
            || published.state_version != 47
            || published.registry_fingerprint != state.identity.registry_fingerprint
            || published.generation != expected_checkpoint.generation
            || published.root_hash != expected_checkpoint.root_hash
            || published.revision != expected_checkpoint.revision
        {
            bail!("native player-authority checkpoint is not the current verified publication");
        }
        Ok(summary)
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

    #[allow(clippy::too_many_arguments)]
    pub fn viewport_projection(
        &self,
        session_id: &str,
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
        self.session(session_id)?.viewport_projection(
            base_fields,
            planet_id,
            min_x,
            min_y,
            max_x,
            max_y,
            entity_cursor,
            entity_limit,
            belt_limit,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn viewport_projection_v2(
        &self,
        session_id: &str,
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
        self.session(session_id)?.viewport_projection_v2(
            base_fields,
            planet_id,
            min_x,
            min_y,
            max_x,
            max_y,
            entity_cursor,
            entity_limit,
            belt_cursor,
            belt_limit,
            pinned_entity_ids,
            pinned_belt_ids,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn statistics_projection(
        &self,
        session_id: &str,
        min_elapsed_seconds: f64,
        max_elapsed_seconds: f64,
        cursor: usize,
        limit: usize,
        planet_id: Option<&str>,
        item_id: Option<&str>,
    ) -> anyhow::Result<Value> {
        self.session(session_id)?.statistics_projection(
            min_elapsed_seconds,
            max_elapsed_seconds,
            cursor,
            limit,
            planet_id,
            item_id,
        )
    }

    pub fn apply_command(
        &mut self,
        session_id: &str,
        command: &SimulationCommandPatch,
    ) -> anyhow::Result<CommandApplyResult> {
        self.require_checkpoint_reconciliation_before_mutation(session_id)?;
        self.session_mut(session_id)?.apply_command(command)
    }

    pub fn advance(
        &mut self,
        session_id: &str,
        request: &CoreAdvanceRequest,
    ) -> anyhow::Result<CoreAdvanceResult> {
        self.require_checkpoint_reconciliation_before_mutation(session_id)?;
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
        self.require_checkpoint_reconciliation_before_mutation(session_id)?;
        let slot = self.session(session_id)?.identity.slot.clone();
        store.require_generic_mutation_unfenced(&slot)?;
        self.commit_operation_internal(store, session_id, request, None)
    }

    /// The exact-realtime writer bridge accepts only a lease identity. The
    /// command ID, revision range, one-second budget, exact mode and absence of
    /// a gameplay command are derived from the durable pending tick here, so
    /// this private path cannot express an arbitrary mutation.
    pub fn commit_operation_exact_realtime(
        &mut self,
        store: &SaveStore,
        session_id: &str,
        request: CoreCommitOperationExactRealtimeRequest,
    ) -> anyhow::Result<CoreCommitOperationResult> {
        validate_session_id(session_id)?;
        self.require_checkpoint_reconciliation_before_mutation(session_id)?;
        let lease = store.require_exact_realtime_lease()?;
        let operation = {
            let state = self.session(session_id)?;
            derive_exact_realtime_commit_operation(
                &lease,
                &state.identity.slot,
                &state.identity.mode,
                state.identity.state_version,
                &state.identity.registry_fingerprint,
                state.revision,
                &request,
            )?
        };
        self.commit_operation_internal(store, session_id, operation, Some(lease))
    }

    fn commit_operation_internal(
        &mut self,
        store: &SaveStore,
        session_id: &str,
        request: CoreCommitOperationRequest,
        exact_realtime_lease: Option<ExactRealtimeLease>,
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
        if let Some(command) = request.command.as_ref()
            && command.base_revision != request.base_revision
        {
            bail!("native authoritative command base revision is invalid");
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
            if operation.base_revision != request.base_revision
                || operation.registry_fingerprint != fingerprint
                || operation.simulation_seconds.to_bits() != request.simulation_seconds.to_bits()
                || operation.wall_seconds.to_bits() != request.wall_seconds.to_bits()
                || operation.advance_mode != request.advance_mode
                || !commands_bitwise_equal(&request.command, &operation.command)?
            {
                bail!("native authoritative idempotency key conflicts with another operation");
            }
            require_exact_realtime_result_revision(
                exact_realtime_lease.as_ref(),
                operation.result_revision,
            )?;
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
                    operation.advance_mode,
                )?;
            }
            let state = self.session(session_id)?;
            if state.revision < operation.result_revision {
                bail!("native authoritative retry did not reach its durable revision");
            }
            let receipt = if let Some(lease) = exact_realtime_lease.as_ref() {
                store.append_wal_idempotent_exact_realtime(
                    lease,
                    &slot,
                    operation.base_revision,
                    operation.result_revision,
                    &request.command_id,
                    existing.payload,
                )?
            } else {
                store.append_wal_idempotent(
                    &slot,
                    operation.base_revision,
                    operation.result_revision,
                    &request.command_id,
                    existing.payload,
                )?
            };
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
            advance_mode: request.advance_mode,
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
        require_exact_realtime_result_revision(exact_realtime_lease.as_ref(), result_revision)?;
        let payload = json!({
            "kind": "stable-operation-v1",
            "baseStateRevision": request.base_revision,
            "resultStateRevision": result_revision,
            "command": request.command,
            "simulationSeconds": request.simulation_seconds,
            "wallSeconds": request.wall_seconds,
            "advanceMode": request.advance_mode,
            "approximate": request.advance_mode != CoreAdvanceMode::Exact,
            "registry": { "fingerprint": fingerprint },
        });
        let receipt = if let Some(lease) = exact_realtime_lease.as_ref() {
            store.append_wal_idempotent_exact_realtime(
                lease,
                &slot,
                request.base_revision,
                result_revision,
                &request.command_id,
                payload,
            )?
        } else {
            store.append_wal_idempotent(
                &slot,
                request.base_revision,
                result_revision,
                &request.command_id,
                payload,
            )?
        };
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
        let slot = self.session(session_id)?.identity.slot.clone();
        store.require_generic_mutation_unfenced(&slot)?;
        self.checkpoint_internal(store, session_id, saved_at_ms, None)
    }

    fn checkpoint_internal(
        &mut self,
        store: &mut SaveStore,
        session_id: &str,
        saved_at_ms: u64,
        exact_realtime_lease: Option<&ExactRealtimeLease>,
    ) -> anyhow::Result<CoreCheckpointResult> {
        self.checkpoint_internal_with_commit(
            store,
            session_id,
            saved_at_ms,
            exact_realtime_lease,
            |store, transaction_id| store.commit(transaction_id),
        )
    }

    #[cfg(test)]
    fn checkpoint_with_fault(
        &mut self,
        store: &mut SaveStore,
        session_id: &str,
        saved_at_ms: u64,
        fault: crate::save_store::CommitFaultPoint,
    ) -> anyhow::Result<CoreCheckpointResult> {
        self.checkpoint_internal_with_commit(
            store,
            session_id,
            saved_at_ms,
            None,
            |store, transaction_id| store.commit_with_fault(transaction_id, fault),
        )
    }

    fn checkpoint_internal_with_commit(
        &mut self,
        store: &mut SaveStore,
        session_id: &str,
        saved_at_ms: u64,
        exact_realtime_lease: Option<&ExactRealtimeLease>,
        commit: impl FnOnce(&mut SaveStore, &str) -> anyhow::Result<SaveCommitResult>,
    ) -> anyhow::Result<CoreCheckpointResult> {
        validate_session_id(session_id)?;
        if saved_at_ms > MAX_SAFE_INTEGER {
            bail!("native core checkpoint timestamp is invalid");
        }
        self.reconcile_uncertain_checkpoint_publication(store, session_id)?;
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
        let begin = if let Some(lease) = exact_realtime_lease {
            store.begin_exact_realtime_checkpoint(
                &slot,
                &mode,
                state_version,
                &base_checksum,
                &fingerprint,
                revision,
                saved_at_ms,
                lease,
            )?
        } else {
            store.begin(
                &slot,
                &mode,
                state_version,
                &base_checksum,
                &fingerprint,
                revision,
                saved_at_ms,
            )?
        };
        let transaction_id = begin.transaction_id;
        let written = self
            .session(session_id)?
            .visit_dirty_internal_checkpoint_records(saved_at_ms, |key, value| {
                store.put(&transaction_id, key, Some(value))
            });
        let visit_result = match written {
            Ok(result) => result,
            Err(error) => {
                self.session(session_id)?.abort_checkpoint_visit();
                store.abort(&transaction_id);
                return Err(error.context("stream native core checkpoint records"));
            }
        };
        let active_keys = visit_result.active_keys.clone();
        let active = active_keys
            .into_iter()
            .collect::<std::collections::HashSet<_>>();
        let prefix = format!("dsp-idle-network.internal.v1.chunked.v1.{mode}.");
        for key in previous_keys {
            if key.starts_with(&prefix)
                && !active.contains(&key)
                && let Err(error) = store.put(&transaction_id, &key, None)
            {
                self.session(session_id)?.abort_checkpoint_visit();
                store.abort(&transaction_id);
                return Err(error.context("remove stale native core checkpoint record"));
            }
        }
        let checkpoint = match commit(store, &transaction_id) {
            Ok(checkpoint) => checkpoint,
            Err(error) => {
                store.abort(&transaction_id);
                self.uncertain_checkpoint_transactions.insert(
                    session_id.to_owned(),
                    UncertainCoreCheckpoint {
                        transaction_id: transaction_id.clone(),
                        revision,
                    },
                );
                if let Err(reconcile_error) =
                    self.reconcile_uncertain_checkpoint_publication(store, session_id)
                {
                    return Err(error.context(format!(
                        "publish native core checkpoint; publication reconciliation failed: {reconcile_error:#}"
                    )));
                }
                self.session(session_id)?.abort_checkpoint_visit();
                return Err(error.context("publish native core checkpoint"));
            }
        };
        let (summary, history) = {
            let state = self.session_mut(session_id)?;
            state.install_checkpoint_identity(checkpoint.generation, checkpoint.root_hash.clone());
            (state.summary()?, state.production_history_sidecar())
        };
        // Publication and dirty ACK already succeeded. A locked, damaged or
        // oversized diagnostics cache is merely skipped.
        persist_statistics_sidecar_best_effort(
            store,
            &checkpoint.slot,
            checkpoint.generation,
            checkpoint.revision,
            &checkpoint.root_hash,
            history,
        );
        Ok(CoreCheckpointResult {
            checkpoint,
            summary,
            encoded_records: visit_result.encoded_records,
            reused_records: visit_result.reused_records,
        })
    }

    fn reconcile_uncertain_checkpoint_publication(
        &mut self,
        store: &mut SaveStore,
        session_id: &str,
    ) -> anyhow::Result<()> {
        let Some(pending) = self
            .uncertain_checkpoint_transactions
            .get(session_id)
            .cloned()
        else {
            return Ok(());
        };

        // The original visit metadata remains live until the exact transaction
        // is either proved or ruled out. Never reconcile after this session
        // has advanced: installing the older checkpoint would clear newer
        // dirty domains.
        if self.session(session_id)?.revision != pending.revision {
            bail!("native core advanced before uncertain checkpoint reconciliation");
        }

        let published = match store.reconcile_uncertain_publication(&pending.transaction_id) {
            Ok(Some(published)) => published,
            Ok(None) => {
                self.session(session_id)?.abort_checkpoint_visit();
                self.uncertain_checkpoint_transactions.remove(session_id);
                return Ok(());
            }
            Err(error) => {
                return Err(error.context("verify uncertain native checkpoint publication"));
            }
        };
        let state = self.session(session_id)?;
        if published.slot != state.identity.slot
            || published.mode != state.identity.mode
            || published.state_version != state.identity.state_version
            || published.registry_fingerprint != state.identity.registry_fingerprint
            || published.revision != state.revision
        {
            self.session(session_id)?.abort_checkpoint_visit();
            bail!("uncertain native checkpoint does not match the active core session");
        }
        let history = {
            let state = self.session_mut(session_id)?;
            state.install_checkpoint_identity(published.generation, published.root_hash.clone());
            state.production_history_sidecar()
        };
        persist_statistics_sidecar_best_effort(
            store,
            &published.slot,
            published.generation,
            published.revision,
            &published.root_hash,
            history,
        );
        self.uncertain_checkpoint_transactions.remove(session_id);
        Ok(())
    }

    fn require_checkpoint_reconciliation_before_mutation(
        &self,
        session_id: &str,
    ) -> anyhow::Result<()> {
        self.session(session_id)?;
        if self
            .uncertain_checkpoint_transactions
            .contains_key(session_id)
        {
            bail!("native core checkpoint publication must be reconciled before mutation");
        }
        Ok(())
    }

    /// Atomically closes the trust gap between an exact-tick WAL commit and
    /// its authority lease ACK. The caller cannot supply a checkpoint or a
    /// proof: both are derived and re-verified inside the lifetime-locked
    /// SaveStore before the lease advances.
    pub fn checkpoint_and_acknowledge_exact_realtime(
        &mut self,
        store: &mut SaveStore,
        session_id: &str,
        request: CoreCheckpointAcknowledgeExactRealtimeRequest,
    ) -> anyhow::Result<CoreCheckpointAcknowledgeExactRealtimeResult> {
        validate_session_id(session_id)?;
        if request.settled_deadline_ms > MAX_SAFE_INTEGER {
            bail!("native exact realtime ACK deadline is invalid");
        }
        let current = store.require_exact_realtime_lease()?;
        if current.purpose()? != ExactRealtimeLeasePurpose::Experiment {
            bail!("native player-authority lease cannot enter the E1 experiment ACK path");
        }
        if current.run_id != request.run_id
            || current.registry_fingerprint != request.registry_fingerprint
        {
            bail!("native exact realtime ACK lease identity conflicts");
        }

        let summary = self.status(session_id)?;
        let state = self.session(session_id)?;
        if state.identity.slot != "normal-main"
            || state.identity.mode != "normal"
            || state.identity.state_version != 47
            || state.identity.registry_fingerprint != request.registry_fingerprint
            || summary.mode != "normal"
            || summary.state_version != 47
            || summary.registry_fingerprint != request.registry_fingerprint
            || summary.paused
        {
            bail!("native exact realtime ACK core identity is not exact normal-main");
        }

        let Some(pending) = current.pending_tick.clone() else {
            if current.acknowledged.sequence != request.sequence
                || current.acknowledged.command_id.as_deref() != Some(request.command_id.as_str())
                || current.acknowledged.settled_deadline_ms != request.settled_deadline_ms
                || summary.revision != current.acknowledged.revision
                || summary.canonical_sha256 != current.acknowledged.proof.canonical_sha256
                || summary.domain_sha256 != current.acknowledged.proof.domain_sha256
            {
                bail!("native exact realtime duplicate ACK conflicts with durable state");
            }
            let latest = store
                .latest_published_checkpoint_identity("normal-main")?
                .ok_or_else(|| anyhow!("normal-main published checkpoint is missing"))?;
            let checkpoint = current.acknowledged.checkpoint.clone();
            if latest.generation != checkpoint.generation
                || latest.root_hash != checkpoint.root_hash
                || latest.revision != checkpoint.revision
                || latest.mode != "normal"
                || latest.state_version != 47
                || latest.registry_fingerprint != request.registry_fingerprint
            {
                bail!("native exact realtime duplicate ACK checkpoint is no longer current");
            }
            return Ok(CoreCheckpointAcknowledgeExactRealtimeResult {
                checkpoint,
                summary,
                lease: current,
                duplicate: true,
            });
        };

        if pending.sequence != request.sequence
            || pending.command_id != request.command_id
            || pending.settled_deadline_ms != request.settled_deadline_ms
            || summary.revision != pending.expected_revision
        {
            bail!("native exact realtime ACK skips or conflicts with the pending tick");
        }

        let latest = store
            .latest_published_checkpoint_identity("normal-main")?
            .ok_or_else(|| anyhow!("normal-main published checkpoint is missing"))?;
        if latest.mode != "normal"
            || latest.state_version != 47
            || latest.registry_fingerprint != request.registry_fingerprint
        {
            bail!("native exact realtime published checkpoint identity changed");
        }
        let checkpoint = if latest.revision == pending.expected_revision {
            if state.identity.generation != latest.generation
                || state.identity.root_hash != latest.root_hash
                || state.identity.revision != latest.revision
            {
                bail!("native core session is not based on the recovered pending checkpoint");
            }
            ExactRealtimeCheckpoint {
                generation: latest.generation,
                root_hash: latest.root_hash,
                revision: latest.revision,
            }
        } else {
            if latest.revision != pending.base_revision
                || latest.generation != current.acknowledged.checkpoint.generation
                || latest.root_hash != current.acknowledged.checkpoint.root_hash
            {
                bail!("native exact realtime cannot checkpoint across an unproven publication");
            }
            let published = self.checkpoint_internal(
                store,
                session_id,
                request.settled_deadline_ms,
                Some(&current),
            )?;
            if published.checkpoint.slot != "normal-main"
                || published.checkpoint.revision != pending.expected_revision
                || published.summary.revision != pending.expected_revision
                || published.summary.canonical_sha256 != summary.canonical_sha256
                || published.summary.domain_sha256 != summary.domain_sha256
            {
                bail!("native exact realtime checkpoint result differs from the committed tick");
            }
            ExactRealtimeCheckpoint {
                generation: published.checkpoint.generation,
                root_hash: published.checkpoint.root_hash,
                revision: published.checkpoint.revision,
            }
        };

        let proof = ExactRealtimeStateProof {
            revision: summary.revision,
            canonical_sha256: summary.canonical_sha256.clone(),
            domain_sha256: summary.domain_sha256.clone(),
        };
        let lease = store.acknowledge_exact_realtime_tick(
            &request.run_id,
            &request.registry_fingerprint,
            request.sequence,
            request.command_id,
            summary.revision,
            proof,
            checkpoint.clone(),
            request.settled_deadline_ms,
        )?;
        Ok(CoreCheckpointAcknowledgeExactRealtimeResult {
            checkpoint,
            summary,
            lease,
            duplicate: false,
        })
    }

    /// Publishes (or after a lost response, reuses) exactly one checkpoint for
    /// a finalizing lease and records that durable identity before any v47
    /// export or public-primary write may begin.
    pub fn checkpoint_exact_realtime_finalization(
        &mut self,
        store: &mut SaveStore,
        session_id: &str,
        request: CoreCheckpointExactRealtimeFinalizationRequest,
    ) -> anyhow::Result<CoreCheckpointAcknowledgeExactRealtimeResult> {
        validate_session_id(session_id)?;
        if request.saved_at_ms > MAX_SAFE_INTEGER {
            bail!("native exact realtime finalization timestamp is invalid");
        }
        let current = store.require_exact_realtime_lease()?;
        if current.purpose()? != ExactRealtimeLeasePurpose::Experiment {
            bail!("native player-authority lease cannot enter the E1 experiment finalization path");
        }
        if current.run_id != request.run_id
            || current.registry_fingerprint != request.registry_fingerprint
            || current.phase != crate::exact_realtime_lease::ExactRealtimeLeasePhase::Finalizing
            || current.acknowledged.settled_deadline_ms != request.saved_at_ms
        {
            bail!("native exact realtime finalization lease identity conflicts");
        }
        let finalization = current
            .finalization
            .as_ref()
            .ok_or_else(|| anyhow!("native exact realtime finalization is missing"))?;
        let summary = self.status(session_id)?;
        let state = self.session(session_id)?;
        if state.identity.slot != "normal-main"
            || state.identity.mode != "normal"
            || state.identity.state_version != 47
            || state.identity.registry_fingerprint != request.registry_fingerprint
            || summary.revision != finalization.target_revision
            || summary.canonical_sha256 != finalization.target_proof.canonical_sha256
            || summary.domain_sha256 != finalization.target_proof.domain_sha256
            || summary.paused
        {
            bail!("native exact realtime finalization core proof differs from the lease");
        }

        if let Some(checkpoint) = finalization.checkpoint.clone() {
            let latest = store
                .latest_published_checkpoint_identity("normal-main")?
                .ok_or_else(|| anyhow!("normal-main finalization checkpoint is missing"))?;
            if latest.generation != checkpoint.generation
                || latest.root_hash != checkpoint.root_hash
                || latest.revision != checkpoint.revision
                || latest.mode != "normal"
                || latest.state_version != 47
                || latest.registry_fingerprint != request.registry_fingerprint
            {
                bail!("native exact realtime finalization checkpoint is no longer current");
            }
            return Ok(CoreCheckpointAcknowledgeExactRealtimeResult {
                checkpoint,
                summary,
                lease: current,
                duplicate: true,
            });
        }

        let latest = store
            .latest_published_checkpoint_identity("normal-main")?
            .ok_or_else(|| anyhow!("normal-main published checkpoint is missing"))?;
        if latest.mode != "normal"
            || latest.state_version != 47
            || latest.registry_fingerprint != request.registry_fingerprint
            || latest.revision != finalization.target_revision
        {
            bail!("native exact realtime finalization publication identity changed");
        }
        let checkpoint = if latest.generation == current.acknowledged.checkpoint.generation
            && latest.root_hash == current.acknowledged.checkpoint.root_hash
        {
            let published =
                self.checkpoint_internal(store, session_id, request.saved_at_ms, Some(&current))?;
            if published.checkpoint.slot != "normal-main"
                || published.checkpoint.revision != finalization.target_revision
                || published.summary.canonical_sha256 != finalization.target_proof.canonical_sha256
                || published.summary.domain_sha256 != finalization.target_proof.domain_sha256
            {
                bail!("native exact realtime finalization checkpoint differs from target");
            }
            ExactRealtimeCheckpoint {
                generation: published.checkpoint.generation,
                root_hash: published.checkpoint.root_hash,
                revision: published.checkpoint.revision,
            }
        } else {
            // Lost response after publication but before lease persistence:
            // the reopened core must identify the exact new generation.
            if state.identity.generation != latest.generation
                || state.identity.root_hash != latest.root_hash
                || state.identity.revision != latest.revision
            {
                bail!("native finalization cannot reuse an unproven checkpoint");
            }
            ExactRealtimeCheckpoint {
                generation: latest.generation,
                root_hash: latest.root_hash,
                revision: latest.revision,
            }
        };
        let lease = store.record_exact_realtime_finalization_checkpoint(
            &request.run_id,
            &request.registry_fingerprint,
            checkpoint.clone(),
        )?;
        Ok(CoreCheckpointAcknowledgeExactRealtimeResult {
            checkpoint,
            summary,
            lease,
            duplicate: false,
        })
    }

    pub fn export_v47(
        &self,
        store: &SaveStore,
        session_id: &str,
        export_id: &str,
        saved_at_ms: u64,
    ) -> anyhow::Result<CoreExportResult> {
        validate_session_id(session_id)?;
        if saved_at_ms > MAX_SAFE_INTEGER {
            bail!("native core export timestamp is invalid");
        }
        let state = self.session(session_id)?;
        let mode = state.identity.mode.clone();
        // The first pass writes only to a sink so SaveStore can prove the exact
        // disk budget before it creates the export temporary file. The second
        // pass is bounded to that length and must reproduce the same digest.
        let preflight = state.write_v47_envelope(saved_at_ms, std::io::sink())?;
        let result = store.publish_export(export_id, preflight.byte_length, |writer| {
            state.write_v47_envelope(saved_at_ms, writer)
        })?;
        if result.revision != preflight.revision
            || result.saved_at_ms != preflight.saved_at_ms
            || result.byte_length != preflight.byte_length
            || result.envelope_sha256 != preflight.envelope_sha256
            || result.state_checksum != preflight.state_checksum
        {
            bail!("native v47 export changed between disk preflight and publication");
        }
        Ok(CoreExportResult {
            export_id: export_id.to_owned(),
            mode,
            result,
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
        self.uncertain_checkpoint_transactions.remove(session_id);
        Ok(self.sessions.remove(session_id).is_some())
    }

    pub fn close_all(&mut self) {
        self.uncertain_checkpoint_transactions.clear();
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::disk_budget::{DiskSpaceProbe, DiskSpaceQuery, MINIMUM_FREE_SPACE_RESERVE_BYTES};
    use sha2::{Digest, Sha256};
    use std::io::Cursor;
    use std::path::Path;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicU64, Ordering};
    use tempfile::tempdir;

    #[derive(Debug)]
    struct MutableDiskSpaceProbe(AtomicU64);

    impl MutableDiskSpaceProbe {
        fn available() -> Self {
            Self(AtomicU64::new(u64::MAX))
        }

        fn set(&self, available_bytes: u64) {
            self.0.store(available_bytes, Ordering::SeqCst);
        }
    }

    impl DiskSpaceProbe for MutableDiskSpaceProbe {
        fn query_available_bytes(&self, _directory: &Path) -> anyhow::Result<DiskSpaceQuery> {
            Ok(DiskSpaceQuery::Available(self.0.load(Ordering::SeqCst)))
        }
    }

    fn import_catalog() -> Value {
        json!({
            "protocolVersion": 1,
            "registryFingerprint": "builtin:test",
            "planets": [{
                "id": "home",
                "name": "home",
                "systemId": "helios",
                "kind": "terrestrial",
                "orbitIndex": 1,
                "simulationOrder": 0,
                "orbitalYields": {},
            }],
            "items": [{ "id": "iron_ore", "name": "iron_ore", "kind": "solid" }],
            "buildings": [{
                "id": "mining_machine",
                "kind": "miner",
                "speed": 1,
                "inputCapacity": 0,
                "outputCapacity": 50,
                "powerDemandKw": 1,
                "powerGenerationKw": 0,
            }],
            "recipes": [],
            "constructions": [],
            "belts": [{ "tier": 1, "speed": 6 }],
            "proliferators": [],
            "technologies": [],
        })
    }

    fn utf16_fnv(text: &str) -> String {
        let mut hash = 0x811c9dc5_u32;
        for unit in text.encode_utf16() {
            hash ^= u32::from(unit);
            hash = hash.wrapping_mul(0x01000193);
        }
        format!("{hash:08x}")
    }

    fn import_envelope() -> Vec<u8> {
        let state = serde_json::to_string(&json!({
            "version": 47,
            "mode": "normal",
            "activePlanetId": "home",
            "elapsedSeconds": 2,
            "paused": false,
            "tray": {},
            "entities": [{
                "id": "vein",
                "kind": "vein",
                "planetId": "home",
                "resourceId": "iron_ore",
                "minerCount": 2,
                "inputs": {},
                "outputs": { "iron_ore": 3 },
                "progress": 0,
                "utilization": 0,
                "productionRate": 0,
                "routingCursor": 0,
            }],
            "belts": [],
        }))
        .unwrap();
        let checksum = utf16_fnv(&format!("{{\"formatVersion\":2,\"state\":{state}}}"));
        format!(
            "{{\"formatVersion\":2,\"kind\":\"primary\",\"savedAt\":42,\"mode\":\"normal\",\"slot\":\"main\",\"state\":{state},\"checksum\":\"{checksum}\"}}"
        )
        .into_bytes()
    }

    fn exact_pending_lease() -> ExactRealtimeLease {
        let checkpoint = ExactRealtimeCheckpoint {
            generation: 1,
            root_hash: "checkpoint-root".to_owned(),
            revision: 7,
        };
        let proof = ExactRealtimeStateProof {
            revision: 7,
            canonical_sha256: "canonical".to_owned(),
            domain_sha256: "domain".to_owned(),
        };
        ExactRealtimeLease {
            schema_version: 2,
            kind: "native-core-exact-realtime-experiment-lease-v2".to_owned(),
            phase: crate::exact_realtime_lease::ExactRealtimeLeasePhase::Active,
            run_id: "authority-run-1".to_owned(),
            authority_session_id: None,
            mode: "normal".to_owned(),
            slot: "normal-main".to_owned(),
            registry_fingerprint: "builtin:test".to_owned(),
            checkpoint: checkpoint.clone(),
            entry_proof: proof.clone(),
            acknowledged: crate::exact_realtime_lease::ExactRealtimeAcknowledged {
                sequence: 0,
                command_id: None,
                revision: 7,
                proof,
                checkpoint,
                settled_deadline_ms: 10_000,
            },
            pending_tick: Some(crate::exact_realtime_lease::ExactRealtimePendingTick {
                sequence: 1,
                command_id: "tick-command-1".to_owned(),
                base_revision: 7,
                expected_revision: 8,
                simulation_seconds: 1,
                wall_seconds: 1,
                settled_deadline_ms: 11_000,
            }),
            pause: None,
            finalization: None,
        }
    }

    #[test]
    fn v47_import_publishes_checkpoint_and_session_only_after_full_validation() {
        let root = tempdir().unwrap();
        let mut store = SaveStore::open(root.path()).unwrap();
        let mut registry = CoreRegistry::default();
        let bytes = import_envelope();
        let imported = registry
            .import_v47(
                &mut store,
                Cursor::new(bytes.clone()),
                bytes.len() as u64,
                "builtin:test",
                import_catalog(),
            )
            .unwrap();
        assert_eq!(imported.authority, "shadow");
        assert_eq!(imported.checkpoint.generation, 1);
        assert_eq!(imported.summary.revision, 0);
        assert_eq!(imported.summary.entity_count, 1);
        assert_eq!(registry.sessions.len(), 1);
        let published = store.recover("normal-main").unwrap().unwrap();
        assert_eq!(published.generation, imported.checkpoint.generation);
        assert_eq!(published.root_hash, imported.checkpoint.root_hash);

        let before = published;
        let session_count = registry.sessions.len();
        let mut corrupt = bytes;
        let checksum = corrupt
            .windows(b"\"checksum\":\"".len())
            .position(|window| window == b"\"checksum\":\"")
            .unwrap()
            + b"\"checksum\":\"".len();
        corrupt[checksum] = if corrupt[checksum] == b'0' {
            b'1'
        } else {
            b'0'
        };
        assert!(
            registry
                .import_v47(
                    &mut store,
                    Cursor::new(corrupt.clone()),
                    corrupt.len() as u64,
                    "builtin:test",
                    import_catalog(),
                )
                .is_err()
        );
        assert_eq!(registry.sessions.len(), session_count);
        let after = store.recover("normal-main").unwrap().unwrap();
        assert_eq!(after.generation, before.generation);
        assert_eq!(after.root_hash, before.root_hash);
        assert_eq!(after.revision, before.revision);
    }

    #[test]
    fn player_authority_prepare_is_atomic_and_fails_closed_on_every_entry_gate() {
        let root = tempdir().unwrap();
        let mut store = SaveStore::open(root.path()).unwrap();
        let mut registry = CoreRegistry::default();
        let bytes = import_envelope();
        let imported = registry
            .import_v47(
                &mut store,
                Cursor::new(bytes.clone()),
                bytes.len() as u64,
                "builtin:test",
                import_catalog(),
            )
            .unwrap();
        let checkpoint = ExactRealtimeCheckpoint {
            generation: imported.checkpoint.generation,
            root_hash: imported.checkpoint.root_hash.clone(),
            revision: imported.checkpoint.revision,
        };
        let checkpoint_before = store.recover("normal-main").unwrap().unwrap();
        let summary_before =
            serde_json::to_value(registry.status(&imported.session_id).unwrap()).unwrap();

        let mut wrong_checkpoint = checkpoint.clone();
        wrong_checkpoint.revision += 1;
        let mismatch = registry
            .prepare_player_authority(
                &store,
                &imported.session_id,
                CorePreparePlayerAuthorityRequest {
                    run_id: "player-authority-run".to_owned(),
                    expected_checkpoint: wrong_checkpoint,
                    settled_deadline_ms: 42_000,
                },
            )
            .unwrap_err();
        assert!(format!("{mismatch:#}").contains("checkpoint/session/revision"));

        registry.uncertain_checkpoint_transactions.insert(
            imported.session_id.clone(),
            UncertainCoreCheckpoint {
                transaction_id: "uncertain-player-authority-entry".to_owned(),
                revision: checkpoint.revision,
            },
        );
        let uncertain = registry
            .prepare_player_authority(
                &store,
                &imported.session_id,
                CorePreparePlayerAuthorityRequest {
                    run_id: "player-authority-run".to_owned(),
                    expected_checkpoint: checkpoint.clone(),
                    settled_deadline_ms: 42_000,
                },
            )
            .unwrap_err();
        assert!(format!("{uncertain:#}").contains("must be reconciled"));
        registry
            .uncertain_checkpoint_transactions
            .remove(&imported.session_id);

        registry
            .sessions
            .get_mut(&imported.session_id)
            .unwrap()
            .revision += 1;
        let session_revision = registry
            .prepare_player_authority(
                &store,
                &imported.session_id,
                CorePreparePlayerAuthorityRequest {
                    run_id: "player-authority-run".to_owned(),
                    expected_checkpoint: checkpoint.clone(),
                    settled_deadline_ms: 42_000,
                },
            )
            .unwrap_err();
        assert!(format!("{session_revision:#}").contains("checkpoint/session/revision"));
        registry
            .sessions
            .get_mut(&imported.session_id)
            .unwrap()
            .revision -= 1;

        let coverage = registry
            .prepare_player_authority(
                &store,
                &imported.session_id,
                CorePreparePlayerAuthorityRequest {
                    run_id: "player-authority-run".to_owned(),
                    expected_checkpoint: checkpoint,
                    settled_deadline_ms: 42_000,
                },
            )
            .unwrap_err();
        assert!(format!("{coverage:#}").contains("not player-authority eligible"));
        assert_eq!(
            store
                .exact_realtime_lease(
                    crate::exact_realtime_lease::ExactRealtimeLeaseRequest::Inspect
                )
                .unwrap(),
            json!({ "state": "missing" })
        );
        let checkpoint_after = store.recover("normal-main").unwrap().unwrap();
        assert_eq!(checkpoint_after.generation, checkpoint_before.generation);
        assert_eq!(checkpoint_after.root_hash, checkpoint_before.root_hash);
        assert_eq!(checkpoint_after.revision, checkpoint_before.revision);
        assert_eq!(
            serde_json::to_value(registry.status(&imported.session_id).unwrap()).unwrap(),
            summary_before
        );
    }

    #[test]
    fn player_authority_activation_revalidates_session_purpose_and_coverage() {
        let root = tempdir().unwrap();
        let mut store = SaveStore::open(root.path()).unwrap();
        let mut registry = CoreRegistry::default();
        let bytes = import_envelope();
        let imported = registry
            .import_v47(
                &mut store,
                Cursor::new(bytes.clone()),
                bytes.len() as u64,
                "builtin:test",
                import_catalog(),
            )
            .unwrap();
        let checkpoint = ExactRealtimeCheckpoint {
            generation: imported.checkpoint.generation,
            root_hash: imported.checkpoint.root_hash.clone(),
            revision: imported.checkpoint.revision,
        };
        let summary = registry.status(&imported.session_id).unwrap();
        let prepared = store
            .prepare_player_authority_lease(
                imported.session_id.clone(),
                "player-authority-run".to_owned(),
                summary.registry_fingerprint.clone(),
                checkpoint.clone(),
                ExactRealtimeStateProof {
                    revision: summary.revision,
                    canonical_sha256: summary.canonical_sha256.clone(),
                    domain_sha256: summary.domain_sha256.clone(),
                },
                42_000,
            )
            .unwrap();

        let raw_activation = store
            .exact_realtime_lease(
                crate::exact_realtime_lease::ExactRealtimeLeaseRequest::Activate {
                    run_id: "player-authority-run".to_owned(),
                    registry_fingerprint: summary.registry_fingerprint.clone(),
                },
            )
            .unwrap_err();
        assert!(format!("{raw_activation:#}").contains("purpose"));
        let gated_activation = registry
            .activate_player_authority(
                &store,
                &imported.session_id,
                CoreActivatePlayerAuthorityRequest {
                    run_id: "player-authority-run".to_owned(),
                    expected_checkpoint: checkpoint,
                },
            )
            .unwrap_err();
        assert!(format!("{gated_activation:#}").contains("not player-authority eligible"));
        assert_eq!(store.require_exact_realtime_lease().unwrap(), prepared);
    }

    #[test]
    fn low_space_v47_export_keeps_the_source_session_and_checkpoint_bitwise_stable() {
        let root = tempdir().unwrap();
        let probe = Arc::new(MutableDiskSpaceProbe::available());
        let mut store = SaveStore::open_with_disk_space_probe(root.path(), probe.clone()).unwrap();
        let mut registry = CoreRegistry::default();
        let bytes = import_envelope();
        let imported = registry
            .import_v47(
                &mut store,
                Cursor::new(bytes.clone()),
                bytes.len() as u64,
                "builtin:test",
                import_catalog(),
            )
            .unwrap();
        let summary_before =
            serde_json::to_value(registry.status(&imported.session_id).unwrap()).unwrap();
        let checkpoint_before = store.recover("normal-main").unwrap().unwrap();

        probe.set(MINIMUM_FREE_SPACE_RESERVE_BYTES);
        let error = registry
            .export_v47(
                &store,
                &imported.session_id,
                "blocked-low-space-export",
                1234,
            )
            .unwrap_err();
        assert!(
            error
                .to_string()
                .contains(crate::disk_budget::LOW_SPACE_ERROR)
        );
        let summary_after =
            serde_json::to_value(registry.status(&imported.session_id).unwrap()).unwrap();
        assert_eq!(summary_after, summary_before);
        let checkpoint_after = store.recover("normal-main").unwrap().unwrap();
        assert_eq!(checkpoint_after.generation, checkpoint_before.generation);
        assert_eq!(checkpoint_after.revision, checkpoint_before.revision);
        assert_eq!(checkpoint_after.root_hash, checkpoint_before.root_hash);
        assert!(
            !root
                .path()
                .join("exports/blocked-low-space-export.part")
                .exists()
        );
        assert!(
            !root
                .path()
                .join("exports/blocked-low-space-export.json")
                .exists()
        );
    }

    #[test]
    fn low_space_checkpoint_aborts_the_visit_and_remains_retryable() {
        let root = tempdir().unwrap();
        let probe = Arc::new(MutableDiskSpaceProbe::available());
        let mut store = SaveStore::open_with_disk_space_probe(root.path(), probe.clone()).unwrap();
        let mut registry = CoreRegistry::default();
        let bytes = import_envelope();
        let imported = registry
            .import_v47(
                &mut store,
                Cursor::new(bytes.clone()),
                bytes.len() as u64,
                "builtin:test",
                import_catalog(),
            )
            .unwrap();
        let summary_before =
            serde_json::to_value(registry.status(&imported.session_id).unwrap()).unwrap();
        let checkpoint_before = store.recover("normal-main").unwrap().unwrap();

        probe.set(MINIMUM_FREE_SPACE_RESERVE_BYTES);
        let error = registry
            .checkpoint(&mut store, &imported.session_id, 1_234)
            .unwrap_err();
        assert!(
            format!("{error:#}").contains(crate::disk_budget::LOW_SPACE_ERROR),
            "{error:#}"
        );
        assert!(
            !registry
                .uncertain_checkpoint_transactions
                .contains_key(&imported.session_id)
        );
        assert_eq!(
            serde_json::to_value(registry.status(&imported.session_id).unwrap()).unwrap(),
            summary_before
        );
        let checkpoint_after_failure = store.recover("normal-main").unwrap().unwrap();
        assert_eq!(
            checkpoint_after_failure.generation,
            checkpoint_before.generation
        );
        assert_eq!(
            checkpoint_after_failure.root_hash,
            checkpoint_before.root_hash
        );

        probe.set(u64::MAX);
        let retry = registry
            .checkpoint(&mut store, &imported.session_id, 1_235)
            .unwrap();
        assert!(retry.checkpoint.generation > checkpoint_before.generation);
        assert_eq!(
            store.recover("normal-main").unwrap().unwrap().generation,
            retry.checkpoint.generation
        );
    }

    #[test]
    fn statistics_sidecar_damage_or_write_failure_never_blocks_authority_lifecycle() {
        let root = tempdir().unwrap();
        let mut store = SaveStore::open(root.path()).unwrap();
        let mut registry = CoreRegistry::default();
        let mut envelope = serde_json::from_slice::<Value>(&import_envelope()).unwrap();
        let state = envelope["state"].as_object_mut().unwrap();
        state.insert("elapsedSeconds".to_owned(), Value::from(102));
        state.insert("historyRecordedAt".to_owned(), Value::from(102));
        state.insert(
            "productionHistory".to_owned(),
            serde_json::json!([
                {"elapsedSeconds":101,"sampleDurationSeconds":1,"productionPerMinute":{"iron_ore":60}},
                {"elapsedSeconds":102,"sampleDurationSeconds":1,"productionPerMinute":{"iron_ore":70}}
            ]),
        );
        let state = serde_json::to_string(&envelope["state"]).unwrap();
        envelope["checksum"] = Value::from(utf16_fnv(&format!(
            "{{\"formatVersion\":2,\"state\":{state}}}"
        )));
        let bytes = serde_json::to_vec(&envelope).unwrap();
        let imported = registry
            .import_v47(
                &mut store,
                Cursor::new(bytes.clone()),
                bytes.len() as u64,
                "builtin:test",
                import_catalog(),
            )
            .unwrap();
        let sidecar = store
            .root()
            .join("normal-main")
            .join("statistics-history-v1.json");
        let valid_history = serde_json::json!({
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
        });
        store
            .write_statistics_sidecar(
                &imported.checkpoint.slot,
                imported.checkpoint.generation,
                imported.checkpoint.revision,
                &imported.checkpoint.root_hash,
                valid_history.clone(),
            )
            .unwrap();

        // Opening the exact checkpoint restores the cold bucket without
        // adding it to the authoritative public v47 state.
        let published = store.recover("normal-main").unwrap().unwrap();
        let mut reopened = CoreRegistry::default();
        let opened = reopened
            .open(
                &store,
                "normal-main",
                published.generation,
                &published.root_hash,
                published.revision,
                &published.registry_fingerprint,
                import_catalog(),
            )
            .unwrap();
        let projection = reopened
            .statistics_projection(&opened.session_id, 0.0, 100.0, 0, 10, None, None)
            .unwrap();
        assert_eq!(projection["samples"].as_array().unwrap().len(), 1);
        assert_eq!(projection["samples"][0]["elapsedSeconds"], 100);

        store
            .write_statistics_sidecar(
                &imported.checkpoint.slot,
                imported.checkpoint.generation,
                imported.checkpoint.revision,
                &imported.checkpoint.root_hash,
                serde_json::json!({
                    "formatVersion": 1,
                    "source": {
                        "publicLen": 2,
                        "historyRecordedAtBits": 102.0_f64.to_bits(),
                        "latestElapsedBits": 102.0_f64.to_bits(),
                        "latestDurationBits": 1.0_f64.to_bits()
                    },
                    "coldSamples": [
                        {
                            "elapsedSeconds": 40,
                            "sampleDurationSeconds": 40,
                            "productionPerMinute": {"iron_ore": 12}
                        },
                        {
                            "elapsedSeconds": 100,
                            "sampleDurationSeconds": 50,
                            "productionPerMinute": {"iron_ore": 12}
                        }
                    ]
                }),
            )
            .unwrap();

        // write_statistics_sidecar recomputed a valid outer SHA-256, but the
        // cold timeline contains a ten-second gap. Core validation treats the
        // carefully re-signed local payload as a cache miss.
        let mut reopened = CoreRegistry::default();
        let opened = reopened
            .open(
                &store,
                "normal-main",
                published.generation,
                &published.root_hash,
                published.revision,
                &published.registry_fingerprint,
                import_catalog(),
            )
            .unwrap();
        assert_eq!(opened.replayed_revision, published.revision);
        let projection = reopened
            .statistics_projection(&opened.session_id, 0.0, 100.0, 0, 10, None, None)
            .unwrap();
        assert_eq!(projection["samples"], Value::Array(Vec::new()));

        std::fs::write(&sidecar, b"damaged disposable cache").unwrap();
        let mut reopened = CoreRegistry::default();
        assert!(
            reopened
                .open(
                    &store,
                    "normal-main",
                    published.generation,
                    &published.root_hash,
                    published.revision,
                    &published.registry_fingerprint,
                    import_catalog(),
                )
                .is_ok()
        );

        // A directory at the exact cache filename makes atomic replacement
        // fail on every supported host. The lifecycle helper deliberately has
        // no error result and therefore cannot rewrite the authority outcome.
        std::fs::remove_file(&sidecar).unwrap();
        std::fs::create_dir(&sidecar).unwrap();
        persist_statistics_sidecar_best_effort(
            &store,
            &imported.checkpoint.slot,
            imported.checkpoint.generation,
            imported.checkpoint.revision,
            &imported.checkpoint.root_hash,
            Some(serde_json::json!({"coldSamples":[]})),
        );
        let recovered = store.recover("normal-main").unwrap().unwrap();
        assert_eq!(recovered.generation, imported.checkpoint.generation);
        assert_eq!(recovered.root_hash, imported.checkpoint.root_hash);
    }

    #[test]
    fn pause_only_wal_replay_preserves_checkpoint_bound_cold_history() {
        let root = tempdir().unwrap();
        let mut store = SaveStore::open(root.path()).unwrap();
        let mut registry = CoreRegistry::default();
        let mut envelope = serde_json::from_slice::<Value>(&import_envelope()).unwrap();
        let state = envelope["state"].as_object_mut().unwrap();
        state.insert("elapsedSeconds".to_owned(), Value::from(102));
        state.insert("historyRecordedAt".to_owned(), Value::from(102));
        state.insert(
            "productionHistory".to_owned(),
            serde_json::json!([
                {"elapsedSeconds":101,"sampleDurationSeconds":1,"productionPerMinute":{"iron_ore":60}},
                {"elapsedSeconds":102,"sampleDurationSeconds":1,"productionPerMinute":{"iron_ore":70}}
            ]),
        );
        let state = serde_json::to_string(&envelope["state"]).unwrap();
        envelope["checksum"] = Value::from(utf16_fnv(&format!(
            "{{\"formatVersion\":2,\"state\":{state}}}"
        )));
        let bytes = serde_json::to_vec(&envelope).unwrap();
        let imported = registry
            .import_v47(
                &mut store,
                Cursor::new(bytes.clone()),
                bytes.len() as u64,
                "builtin:test",
                import_catalog(),
            )
            .unwrap();
        store
            .write_statistics_sidecar(
                &imported.checkpoint.slot,
                imported.checkpoint.generation,
                imported.checkpoint.revision,
                &imported.checkpoint.root_hash,
                serde_json::json!({
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
                }),
            )
            .unwrap();

        let checkpoint = store.recover("normal-main").unwrap().unwrap();
        let mut running = CoreRegistry::default();
        let opened = running
            .open(
                &store,
                &checkpoint.slot,
                checkpoint.generation,
                &checkpoint.root_hash,
                checkpoint.revision,
                &checkpoint.registry_fingerprint,
                import_catalog(),
            )
            .unwrap();
        let pause_command = serde_json::from_value(json!({
            "protocolVersion": 1,
            "baseRevision": checkpoint.revision,
            "topLevelChanges": [{
                "path": ["paused"],
                "operation": "set",
                "value": true
            }],
            "changedEntities": [],
            "addedEntities": [],
            "removedEntityIds": [],
            "changedBelts": [],
            "addedBelts": [],
            "removedBeltIds": []
        }))
        .unwrap();
        let committed = running
            .commit_operation(
                &store,
                &opened.session_id,
                CoreCommitOperationRequest {
                    command_id: "pause-with-cold-history".to_owned(),
                    base_revision: checkpoint.revision,
                    command: Some(pause_command),
                    simulation_seconds: 0.0,
                    wall_seconds: 0.0,
                    advance_mode: CoreAdvanceMode::Exact,
                    include_diagnostics: false,
                },
            )
            .unwrap();

        let mut replayed = CoreRegistry::default();
        let opened = replayed
            .open(
                &store,
                &checkpoint.slot,
                checkpoint.generation,
                &checkpoint.root_hash,
                checkpoint.revision,
                &checkpoint.registry_fingerprint,
                import_catalog(),
            )
            .unwrap();
        assert_eq!(opened.replayed_wal_entries, 1);
        assert_eq!(opened.replayed_revision, committed.revision);
        let projection = replayed
            .statistics_projection(&opened.session_id, 0.0, 100.0, 0, 10, None, None)
            .unwrap();
        assert_eq!(projection["samples"].as_array().unwrap().len(), 1);
        assert_eq!(projection["samples"][0]["elapsedSeconds"], 100);

        let unknown_command = serde_json::from_value(json!({
            "protocolVersion": 1,
            "baseRevision": committed.revision,
            "topLevelChanges": [{
                "path": ["futureUnknownField"],
                "operation": "set",
                "value": true
            }],
            "changedEntities": [],
            "addedEntities": [],
            "removedEntityIds": [],
            "changedBelts": [],
            "addedBelts": [],
            "removedBeltIds": []
        }))
        .unwrap();
        let invalidated = replayed
            .commit_operation(
                &store,
                &opened.session_id,
                CoreCommitOperationRequest {
                    command_id: "unknown-patch-invalidates-cold-history".to_owned(),
                    base_revision: committed.revision,
                    command: Some(unknown_command),
                    simulation_seconds: 0.0,
                    wall_seconds: 0.0,
                    advance_mode: CoreAdvanceMode::Exact,
                    include_diagnostics: false,
                },
            )
            .unwrap();
        let mut replayed_after_unknown = CoreRegistry::default();
        let opened = replayed_after_unknown
            .open(
                &store,
                &checkpoint.slot,
                checkpoint.generation,
                &checkpoint.root_hash,
                checkpoint.revision,
                &checkpoint.registry_fingerprint,
                import_catalog(),
            )
            .unwrap();
        assert_eq!(opened.replayed_wal_entries, 2);
        assert_eq!(opened.replayed_revision, invalidated.revision);
        let projection = replayed_after_unknown
            .statistics_projection(&opened.session_id, 0.0, 100.0, 0, 10, None, None)
            .unwrap();
        assert_eq!(projection["samples"], Value::Array(Vec::new()));
    }

    #[test]
    fn published_checkpoint_with_lost_ack_reconciles_same_session_before_retry() {
        use crate::save_store::CommitFaultPoint;

        let root = tempdir().unwrap();
        let mut store = SaveStore::open(root.path()).unwrap();
        let mut registry = CoreRegistry::default();
        let bytes = import_envelope();
        let imported = registry
            .import_v47(
                &mut store,
                Cursor::new(bytes.clone()),
                bytes.len() as u64,
                "builtin:test",
                import_catalog(),
            )
            .unwrap();

        let error = registry
            .checkpoint_with_fault(
                &mut store,
                &imported.session_id,
                43,
                CommitFaultPoint::AfterSuperblockPublish,
            )
            .unwrap_err();
        assert!(format!("{error:#}").contains("publish native core checkpoint"));
        let published_after_lost_ack = store.recover("normal-main").unwrap().unwrap();
        assert_eq!(published_after_lost_ack.generation, 2);
        assert_eq!(
            registry
                .session(&imported.session_id)
                .unwrap()
                .identity
                .generation,
            published_after_lost_ack.generation,
            "the active session must reconcile the exact transaction that reached its superblock"
        );

        let retry = registry
            .checkpoint(&mut store, &imported.session_id, 44)
            .unwrap();
        assert_eq!(retry.checkpoint.generation, 3);
        assert_eq!(
            store.recover("normal-main").unwrap().unwrap().generation,
            retry.checkpoint.generation
        );
    }

    #[test]
    fn transient_readback_error_reconciles_at_next_same_session_checkpoint() {
        use crate::save_store::CommitFaultPoint;

        let root = tempdir().unwrap();
        let mut store = SaveStore::open(root.path()).unwrap();
        let mut registry = CoreRegistry::default();
        let bytes = import_envelope();
        let imported = registry
            .import_v47(
                &mut store,
                Cursor::new(bytes.clone()),
                bytes.len() as u64,
                "builtin:test",
                import_catalog(),
            )
            .unwrap();

        let error = registry
            .checkpoint_with_fault(
                &mut store,
                &imported.session_id,
                43,
                CommitFaultPoint::TransientReconciliationReadbackFailure,
            )
            .unwrap_err();
        assert!(format!("{error:#}").contains("publication reconciliation failed"));
        assert_eq!(store.recover("normal-main").unwrap().unwrap().generation, 2);
        assert_eq!(
            registry
                .session(&imported.session_id)
                .unwrap()
                .identity
                .generation,
            1,
            "a failed readback must not be acknowledged before it is proved"
        );
        let before_blocked_mutations = registry.status(&imported.session_id).unwrap();
        let advance_error = registry
            .advance(
                &imported.session_id,
                &CoreAdvanceRequest {
                    base_revision: before_blocked_mutations.revision,
                    simulation_seconds: 1.0,
                    wall_seconds: 1.0,
                    advance_mode: CoreAdvanceMode::Exact,
                    include_diagnostics: false,
                },
            )
            .unwrap_err();
        assert!(
            advance_error
                .to_string()
                .contains("must be reconciled before mutation")
        );
        let command = serde_json::from_value(json!({
            "protocolVersion": 1,
            "baseRevision": before_blocked_mutations.revision,
            "topLevelChanges": [{
                "path": ["paused"],
                "operation": "set",
                "value": true,
            }],
            "changedEntities": [],
            "addedEntities": [],
            "removedEntityIds": [],
            "changedBelts": [],
            "addedBelts": [],
            "removedBeltIds": [],
        }))
        .unwrap();
        let command_error = registry
            .apply_command(&imported.session_id, &command)
            .unwrap_err();
        assert!(
            command_error
                .to_string()
                .contains("must be reconciled before mutation")
        );
        let commit_error = registry
            .commit_operation(
                &store,
                &imported.session_id,
                CoreCommitOperationRequest {
                    command_id: "blocked-before-reconcile".to_owned(),
                    base_revision: before_blocked_mutations.revision,
                    command: None,
                    simulation_seconds: 1.0,
                    wall_seconds: 1.0,
                    advance_mode: CoreAdvanceMode::Exact,
                    include_diagnostics: false,
                },
            )
            .unwrap_err();
        assert!(
            commit_error
                .to_string()
                .contains("must be reconciled before mutation")
        );
        let after_blocked_mutations = registry.status(&imported.session_id).unwrap();
        assert_eq!(
            after_blocked_mutations.canonical_sha256,
            before_blocked_mutations.canonical_sha256
        );
        assert_eq!(
            after_blocked_mutations.revision,
            before_blocked_mutations.revision
        );

        let retry = registry
            .checkpoint(&mut store, &imported.session_id, 44)
            .unwrap();
        assert_eq!(retry.checkpoint.generation, 3);
        assert_eq!(
            registry
                .session(&imported.session_id)
                .unwrap()
                .identity
                .generation,
            retry.checkpoint.generation
        );
        assert_eq!(
            store.recover("normal-main").unwrap().unwrap().generation,
            retry.checkpoint.generation
        );
    }

    #[test]
    fn unpublished_checkpoint_failure_is_not_reconciled_as_success() {
        use crate::save_store::CommitFaultPoint;

        let root = tempdir().unwrap();
        let mut store = SaveStore::open(root.path()).unwrap();
        let mut registry = CoreRegistry::default();
        let bytes = import_envelope();
        let imported = registry
            .import_v47(
                &mut store,
                Cursor::new(bytes.clone()),
                bytes.len() as u64,
                "builtin:test",
                import_catalog(),
            )
            .unwrap();

        assert!(
            registry
                .checkpoint_with_fault(
                    &mut store,
                    &imported.session_id,
                    43,
                    CommitFaultPoint::BeforeSuperblockPublish,
                )
                .is_err()
        );
        assert_eq!(
            registry
                .session(&imported.session_id)
                .unwrap()
                .identity
                .generation,
            1
        );
        assert_eq!(store.recover("normal-main").unwrap().unwrap().generation, 1);

        let retry = registry
            .checkpoint(&mut store, &imported.session_id, 44)
            .unwrap();
        assert!(retry.checkpoint.generation > 1);
        assert_eq!(
            store.recover("normal-main").unwrap().unwrap().generation,
            retry.checkpoint.generation
        );
    }

    #[test]
    fn v47_decoded_stream_is_proved_and_validation_failure_publishes_nothing() {
        let root = tempdir().unwrap();
        let mut store = SaveStore::open(root.path()).unwrap();
        let mut registry = CoreRegistry::default();
        let bytes = import_envelope();
        let truncated = bytes[..bytes.len() - 1].to_vec();

        assert!(
            registry
                .import_v47_stream(
                    &mut store,
                    Cursor::new(truncated),
                    "builtin:test",
                    import_catalog(),
                )
                .is_err()
        );
        assert!(registry.sessions.is_empty());
        assert_eq!(registry.next_session_id, 1);
        assert!(store.recover("normal-main").unwrap().is_none());

        let imported = registry
            .import_v47_stream(
                &mut store,
                Cursor::new(bytes.clone()),
                "builtin:test",
                import_catalog(),
            )
            .unwrap();
        assert_eq!(imported.import.source_byte_length, bytes.len() as u64);
        assert_eq!(
            imported.import.source_sha256,
            hex::encode(Sha256::digest(&bytes))
        );
        assert_eq!(registry.sessions.len(), 1);
        assert!(store.recover("normal-main").unwrap().is_some());
    }

    #[test]
    fn v47_import_prepublication_failure_leaves_no_session_or_published_slot() {
        use crate::save_store::CommitFaultPoint;

        let root = tempdir().unwrap();
        let mut store = SaveStore::open(root.path()).unwrap();
        let mut registry = CoreRegistry::default();
        let bytes = import_envelope();
        let error = registry
            .import_v47_with_commit(
                &mut store,
                Cursor::new(bytes.clone()),
                bytes.len() as u64,
                "builtin:test",
                import_catalog(),
                |store, transaction_id| {
                    store.commit_with_fault(
                        transaction_id,
                        CommitFaultPoint::BeforeSuperblockPublish,
                    )
                },
            )
            .unwrap_err();
        assert!(format!("{error:#}").contains("publish imported native checkpoint"));
        assert!(registry.sessions.is_empty());
        assert_eq!(registry.next_session_id, 1);
        assert!(store.recover("normal-main").unwrap().is_none());
    }

    #[test]
    fn v47_lone_surrogate_fallback_publishes_neither_session_nor_checkpoint() {
        let root = tempdir().unwrap();
        let mut store = SaveStore::open(root.path()).unwrap();
        let mut registry = CoreRegistry::default();
        let state = r#"{"version":47,"mode":"normal","activePlanetId":"home","elapsedSeconds":0,"paused":false,"note":"\ud800","entities":[],"belts":[]}"#;
        let bytes = format!(
            "{{\"formatVersion\":2,\"kind\":\"primary\",\"savedAt\":42,\"mode\":\"normal\",\"slot\":\"main\",\"state\":{state},\"checksum\":\"00000000\"}}"
        )
        .into_bytes();
        let error = registry
            .import_v47(
                &mut store,
                Cursor::new(bytes.clone()),
                bytes.len() as u64,
                "builtin:test",
                import_catalog(),
            )
            .unwrap_err();
        assert!(
            error
                .downcast_ref::<dsp_native_core::V47ImportJavascriptCompatibilityRequired>()
                .is_some(),
            "unexpected error: {error:#}"
        );
        assert!(registry.sessions.is_empty());
        assert_eq!(registry.next_session_id, 1);
        assert!(store.recover("normal-main").unwrap().is_none());
    }

    fn exact_pending_request() -> CoreCommitOperationExactRealtimeRequest {
        CoreCommitOperationExactRealtimeRequest {
            run_id: "authority-run-1".to_owned(),
            registry_fingerprint: "builtin:test".to_owned(),
        }
    }

    fn command_with_patch_value(value: Value) -> SimulationCommandPatch {
        serde_json::from_value(json!({
            "protocolVersion": 1,
            "baseRevision": 5,
            "topLevelChanges": [{
                "path": ["elapsedSeconds"],
                "operation": "set",
                "value": value,
            }],
            "changedEntities": [],
            "addedEntities": [],
            "removedEntityIds": [],
            "changedBelts": [],
            "addedBelts": [],
            "removedBeltIds": [],
        }))
        .unwrap()
    }

    #[test]
    fn authoritative_command_identity_preserves_nested_signed_zero() {
        let accepted = Some(command_with_patch_value(json!({
            "nested": [-0.0, {"same": -0.0}],
        })));
        let exact_retry = Some(command_with_patch_value(json!({
            "nested": [-0.0, {"same": -0.0}],
        })));
        let conflicting_retry = Some(command_with_patch_value(json!({
            "nested": [0.0, {"same": -0.0}],
        })));

        assert!(commands_bitwise_equal(&accepted, &exact_retry).unwrap());
        assert!(!commands_bitwise_equal(&accepted, &conflicting_retry).unwrap());
    }

    #[test]
    fn exact_realtime_lease_only_authorizes_its_fixed_pending_operation() {
        let lease = exact_pending_lease();
        let request = exact_pending_request();
        let operation = derive_exact_realtime_commit_operation(
            &lease,
            "normal-main",
            "normal",
            47,
            "builtin:test",
            7,
            &request,
        )
        .unwrap();
        assert_eq!(operation.command_id, "tick-command-1");
        assert_eq!(operation.base_revision, 7);
        assert!(operation.command.is_none());
        assert_eq!(operation.simulation_seconds.to_bits(), 1.0_f64.to_bits());
        assert_eq!(operation.wall_seconds.to_bits(), 1.0_f64.to_bits());
        assert_eq!(operation.advance_mode, CoreAdvanceMode::Exact);
        assert!(operation.include_diagnostics);
        derive_exact_realtime_commit_operation(
            &lease,
            "normal-main",
            "normal",
            47,
            "builtin:test",
            8,
            &request,
        )
        .unwrap();
        require_exact_realtime_result_revision(Some(&lease), 8).unwrap();

        let mut conflicting_identity = request;
        conflicting_identity.run_id = "other-run".to_owned();
        let error = derive_exact_realtime_commit_operation(
            &lease,
            "normal-main",
            "normal",
            47,
            "builtin:test",
            7,
            &conflicting_identity,
        )
        .unwrap_err();
        assert!(format!("{error:#}").contains("exact realtime lease"));
        assert!(require_exact_realtime_result_revision(Some(&lease), 9).is_err());
    }

    #[test]
    fn prepared_lease_cannot_enter_the_private_exact_commit_path() {
        let request = exact_pending_request();
        let mut prepared = exact_pending_lease();
        prepared.phase = crate::exact_realtime_lease::ExactRealtimeLeasePhase::Prepared;
        prepared.pending_tick = None;
        let error = derive_exact_realtime_commit_operation(
            &prepared,
            "normal-main",
            "normal",
            47,
            "builtin:test",
            7,
            &request,
        )
        .unwrap_err();
        assert!(format!("{error:#}").contains("exact realtime lease"));
    }

    #[test]
    fn exact_realtime_commit_protocol_rejects_caller_supplied_mutation_fields() {
        assert!(
            serde_json::from_value::<CoreCommitOperationExactRealtimeRequest>(json!({
                "runId": "authority-run-1",
                "registryFingerprint": "builtin:test",
                "commandId": "caller-controlled-command",
                "simulationSeconds": 1,
            }))
            .is_err()
        );
    }

    #[test]
    fn production_open_moves_records_into_owned_core_constructor() {
        let source = include_str!("core_runtime.rs");
        let open_start = source.find("    pub fn open(").unwrap();
        let open_and_later = &source[open_start..];
        let open_end = open_and_later[1..]
            .find("\n    pub fn ")
            .map_or(open_and_later.len(), |index| index + 1);
        let open_source = &open_and_later[..open_end];
        let owned_constructor = ["CoreState::from_", "owned_internal_records("].concat();
        let borrowed_constructor = ["CoreState::from_", "internal_records("].concat();

        assert!(open_source.contains(&owned_constructor));
        assert!(!open_source.contains(&borrowed_constructor));
        assert!(!open_source.contains("&records,"));
        assert!(!open_source.contains("records.clone()"));
        assert!(open_source.contains("\n            records,\n            catalog,\n        )?;"));
        let constructor_index = open_source.find(&owned_constructor).unwrap();
        assert!(
            constructor_index
                < open_source
                    .find("let session_id =")
                    .expect("session id allocation must remain visible")
        );
        assert!(
            open_source
                .find("for entry in &wal")
                .expect("WAL replay must remain visible")
                < open_source
                    .find("let session_id =")
                    .expect("session id allocation must remain visible")
        );
        assert!(
            open_source
                .find("let summary = state.summary()?")
                .expect("summary verification must remain visible")
                < open_source
                    .find("let session_id =")
                    .expect("session id allocation must remain visible")
        );
        assert!(
            constructor_index
                < open_source
                    .find("self.sessions.insert(")
                    .expect("session insertion must remain visible")
        );
    }
}
