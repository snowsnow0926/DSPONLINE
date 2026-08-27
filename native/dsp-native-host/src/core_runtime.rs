use std::collections::HashMap;

use anyhow::{anyhow, bail};
use dsp_native_core::canonical::canonical_sha256;
use dsp_native_core::catalog::RuntimeCatalog;
use dsp_native_core::{
    CommandApplyResult, CoreAdvanceMode, CoreAdvanceRequest, CoreAdvanceResult,
    CoreCheckpointIdentity, CoreState, CoreStateSummary, SimulationCommandPatch,
    V47EnvelopeExportResult,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::exact_realtime_lease::{
    ExactRealtimeCheckpoint, ExactRealtimeLease, ExactRealtimeStateProof,
};
use crate::save_store::{SaveCommitResult, SaveStore, WalEntry, json_values_bitwise_equal};

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
pub struct CoreExportResult {
    pub export_id: String,
    pub mode: String,
    pub result: V47EnvelopeExportResult,
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
        let checkpoint = match store.commit(&transaction_id) {
            Ok(checkpoint) => checkpoint,
            Err(error) => {
                self.session(session_id)?.abort_checkpoint_visit();
                store.abort(&transaction_id);
                return Err(error.context("publish native core checkpoint"));
            }
        };
        let state = self.session_mut(session_id)?;
        state.install_checkpoint_identity(checkpoint.generation, checkpoint.root_hash.clone());
        Ok(CoreCheckpointResult {
            checkpoint,
            summary: state.summary()?,
            encoded_records: visit_result.encoded_records,
            reused_records: visit_result.reused_records,
        })
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
        let result = store.publish_export(export_id, |writer| {
            state.write_v47_envelope(saved_at_ms, writer)
        })?;
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

#[cfg(test)]
mod tests {
    use super::*;

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
