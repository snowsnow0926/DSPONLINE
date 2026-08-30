use std::collections::{HashMap, HashSet};
use std::io::Read;

use anyhow::{Context, anyhow, bail};
use dsp_native_core::canonical::canonical_sha256;
use dsp_native_core::catalog::RuntimeCatalog;
use dsp_native_core::{
    CommandApplyResult, CoreAdvanceMode, CoreAdvanceRequest, CoreAdvanceResult,
    CoreCheckpointIdentity, CoreState, CoreStateSummary, SimulationCommandPatch,
    V47EnvelopeExportResult, V47ImportProof, parse_v47_envelope, parse_v47_envelope_stream,
};
use serde::{Deserialize, Deserializer, Serialize, de};
use serde_json::{Value, json};

use crate::exact_realtime_lease::{
    ExactRealtimeCheckpoint, ExactRealtimeLease, ExactRealtimeLeasePurpose,
    ExactRealtimePendingAdvance, ExactRealtimeStateProof, decode_player_authority_command_payload,
    derive_player_authority_pause_command_id, player_authority_command_request_sha256,
    player_authority_macro_request_sha256, player_authority_pause_command,
    player_authority_pause_target,
};
use crate::save_store::{
    PlayerAuthorityCommandChangeReceipt, SaveCommitResult, SaveStore, WalEntry,
    json_values_bitwise_equal,
};

const MAX_CORE_SESSIONS: usize = 4;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const MAX_COMMAND_PALETTE_SEARCH_REQUEST_BYTES: usize = 32_768;

#[allow(clippy::too_many_arguments)]
fn command_palette_search_request_bytes(
    session_id: &str,
    expected_revision: u64,
    expected_registry_fingerprint: &str,
    query: &str,
    cursor: usize,
    limit: usize,
    building_ids: &[String],
    resource_ids: &[String],
    planet_ids: &[String],
) -> anyhow::Result<usize> {
    Ok(serde_json::to_vec(&json!({
        "operation": "coreCommandPaletteEntitySearchProjection",
        "sessionId": session_id,
        "expectedRevision": expected_revision,
        "expectedRegistryFingerprint": expected_registry_fingerprint,
        "query": query,
        "cursor": cursor,
        "limit": limit,
        "buildingIds": building_ids,
        "resourceIds": resource_ids,
        "planetIds": planet_ids,
    }))?
    .len())
}

pub const PLAYER_AUTHORITY_GATE_CAPABILITY: &str = "native-core-player-authority-gate-v1";
pub const PLAYER_AUTHORITY_TICK_CAPABILITY: &str = "native-core-player-authority-tick-v1";
pub const PLAYER_AUTHORITY_COMMAND_CAPABILITY: &str = "native-core-player-authority-command-v1";
pub const PLAYER_AUTHORITY_PAUSE_CAPABILITY: &str =
    "native-core-player-authority-pause-lifecycle-v1";
pub const PLAYER_AUTHORITY_MACRO_ADVANCE_CAPABILITY: &str =
    "native-core-player-authority-pure-idle-macro-v1";
pub const PLAYER_AUTHORITY_STARTUP_RECOVERY_CAPABILITY: &str =
    "native-core-player-authority-startup-recovery-v1";

#[derive(Clone)]
enum CoreLeaseAuthorization {
    Experiment(ExactRealtimeLease),
    PlayerAuthority {
        lease: ExactRealtimeLease,
        authority_session_id: String,
        pause_lifecycle: bool,
    },
}

impl CoreLeaseAuthorization {
    fn lease(&self) -> &ExactRealtimeLease {
        match self {
            Self::Experiment(lease) | Self::PlayerAuthority { lease, .. } => lease,
        }
    }
}

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

#[derive(Clone, Debug, Serialize)]
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

fn deserialize_player_authority_command<'de, D>(
    deserializer: D,
) -> Result<SimulationCommandPatch, D::Error>
where
    D: Deserializer<'de>,
{
    let value = Value::deserialize(deserializer)?;
    decode_player_authority_command_payload(&value).map_err(de::Error::custom)
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
    if let Some(lease) = lease {
        let expected_revision = match (
            lease.pending_tick.as_ref(),
            lease.pending_command.as_ref(),
            lease.pending_advance.as_ref(),
        ) {
            (Some(pending), None, None) => Some(pending.expected_revision),
            (None, Some(pending), None) => Some(pending.expected_revision),
            (None, None, Some(pending)) => Some(pending.expected_revision),
            _ => None,
        };
        if expected_revision != Some(revision) {
            bail!("native exact realtime operation result differs from the pending event")
        }
    }
    Ok(())
}

fn milliseconds_to_seconds(value: u64) -> f64 {
    value as f64 / 1_000.0
}

fn require_authorized_operation_matches_pending(
    lease: &ExactRealtimeLease,
    request: &CoreCommitOperationRequest,
) -> anyhow::Result<()> {
    match (
        lease.pending_tick.as_ref(),
        lease.pending_command.as_ref(),
        lease.pending_advance.as_ref(),
    ) {
        (Some(pending), None, None)
            if request.command_id == pending.command_id
                && request.base_revision == pending.base_revision
                && request.command.is_none()
                && request.simulation_seconds.to_bits()
                    == (pending.simulation_seconds as f64).to_bits()
                && request.wall_seconds.to_bits() == (pending.wall_seconds as f64).to_bits()
                && request.advance_mode == CoreAdvanceMode::Exact =>
        {
            Ok(())
        }
        (None, Some(pending), None)
            if request.command_id == pending.command_id
                && request.base_revision == pending.base_revision
                && request.simulation_seconds.to_bits() == 0.0_f64.to_bits()
                && request.wall_seconds.to_bits() == 0.0_f64.to_bits()
                && request.advance_mode == CoreAdvanceMode::Exact
                && request.command.as_ref().is_some_and(|command| {
                    serde_json::to_value(command)
                        .ok()
                        .is_some_and(|value| json_values_bitwise_equal(&value, &pending.command))
                }) =>
        {
            Ok(())
        }
        (None, None, Some(pending))
            if request.command_id == pending.command_id
                && request.base_revision == pending.base_revision
                && request.command.is_none()
                && request.simulation_seconds.to_bits()
                    == milliseconds_to_seconds(pending.simulation_milliseconds).to_bits()
                && request.wall_seconds.to_bits()
                    == milliseconds_to_seconds(pending.wall_milliseconds).to_bits()
                && request.advance_mode == CoreAdvanceMode::PureIdleMacroV10 =>
        {
            Ok(())
        }
        _ => bail!("native exact realtime operation differs from its durable pending event"),
    }
}

fn macro_operation_from_pending(
    pending: &ExactRealtimePendingAdvance,
) -> CoreCommitOperationRequest {
    CoreCommitOperationRequest {
        command_id: pending.command_id.clone(),
        base_revision: pending.base_revision,
        command: None,
        simulation_seconds: milliseconds_to_seconds(pending.simulation_milliseconds),
        wall_seconds: milliseconds_to_seconds(pending.wall_milliseconds),
        advance_mode: CoreAdvanceMode::PureIdleMacroV10,
        include_diagnostics: true,
    }
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CoreCommitPlayerAuthorityTickRequest {
    pub run_id: String,
    pub sequence: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CoreCommitPlayerAuthorityCommandRequest {
    pub run_id: String,
    pub command_id: String,
    pub base_revision: u64,
    #[serde(deserialize_with = "deserialize_player_authority_command")]
    pub command: SimulationCommandPatch,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CoreCommitPlayerAuthorityPauseRequest {
    pub run_id: String,
    pub base_revision: u64,
    pub target_paused: bool,
    /// Pausing must preserve the already-settled deadline. Resuming supplies
    /// a fresh main-process wall-clock anchor so paused time is not replayed.
    pub settled_deadline_ms: u64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CoreCommitPlayerAuthorityMacroAdvanceRequest {
    pub run_id: String,
    pub macro_session_id: String,
    pub operation_id: String,
    pub base_revision: u64,
    pub simulation_milliseconds: u64,
    pub wall_milliseconds: u64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CoreFinishPlayerAuthorityMacroSessionRequest {
    pub run_id: String,
    pub macro_session_id: String,
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
pub struct CoreCommitPlayerAuthorityTickResult {
    pub sequence: u64,
    pub revision: u64,
    pub checkpoint: ExactRealtimeCheckpoint,
    pub summary: CoreStateSummary,
    pub duplicate: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreCommitPlayerAuthorityCommandResult {
    pub sequence: u64,
    pub command_id: String,
    pub base_revision: u64,
    pub revision: u64,
    pub settled_deadline_ms: u64,
    pub checkpoint: ExactRealtimeCheckpoint,
    pub changed_entity_ids: Vec<String>,
    pub changed_belt_ids: Vec<String>,
    pub topology_dirty: bool,
    pub summary: CoreStateSummary,
    pub duplicate: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreCommitPlayerAuthorityPauseResult {
    pub sequence: u64,
    pub base_revision: u64,
    pub revision: u64,
    pub target_paused: bool,
    pub settled_deadline_ms: u64,
    pub checkpoint: ExactRealtimeCheckpoint,
    pub summary: CoreStateSummary,
    pub duplicate: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreCommitPlayerAuthorityMacroAdvanceResult {
    pub acknowledged_sequence: u64,
    pub macro_session_id: String,
    pub operation_id: String,
    pub base_revision: u64,
    pub revision: u64,
    pub simulation_milliseconds: u64,
    pub wall_milliseconds: u64,
    pub algorithm_version: String,
    pub settled_deadline_ms: u64,
    pub checkpoint: ExactRealtimeCheckpoint,
    pub summary: CoreStateSummary,
    pub duplicate: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreRecoverPlayerAuthorityMacroAdvanceResult {
    pub run_id: String,
    #[serde(flatten)]
    pub committed: CoreCommitPlayerAuthorityMacroAdvanceResult,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreRecoverPlayerAuthorityCommandResult {
    pub run_id: String,
    #[serde(flatten)]
    pub committed: CoreCommitPlayerAuthorityCommandResult,
}

/// One-shot host-startup handoff. The Rust session already owns the active
/// lease and the pending command has reached ACK before this receipt exists.
/// Only the main-process NativeHostClient can receive it over private stdio.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CorePlayerAuthorityStartupRecoveryReceipt {
    pub schema_version: u16,
    pub kind: &'static str,
    pub owner_id: &'static str,
    pub session_id: String,
    pub run_id: String,
    pub registry_fingerprint: String,
    pub revision: u64,
    /// Immutable checkpoint at which the browser handoff journal was fenced.
    /// This remains stable while `checkpoint` advances with acknowledged work.
    pub entry_checkpoint: ExactRealtimeCheckpoint,
    pub checkpoint: ExactRealtimeCheckpoint,
    pub acknowledged_sequence: u64,
    pub next_sequence: u64,
    pub settled_deadline_ms: u64,
    pub next_deadline_ms: u64,
    /// The durable scheduler/GameState lifecycle at this exact checkpoint.
    /// Main uses this to keep a recovered paused lease clock-stopped; it is
    /// never inferred from renderer state.
    pub paused: bool,
    pub command_id: Option<String>,
    pub command_base_revision: Option<u64>,
    pub changed_entity_ids: Vec<String>,
    pub changed_belt_ids: Vec<String>,
    pub topology_dirty: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub macro_session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recovered_macro_operation_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub macro_algorithm_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub macro_simulation_milliseconds: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub macro_wall_milliseconds: Option<u64>,
    /// Main-process-only intent left after a macro finish ACK until the
    /// renderer's time-warp-disable command is itself durably acknowledged.
    /// These two fields are emitted as a pair and are bound by this receipt's
    /// session/run identity. They never enter GameState or a public envelope.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pending_macro_cleanup_session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pending_macro_cleanup_revision: Option<u64>,
    pub summary: CoreStateSummary,
}

#[cfg(test)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum PlayerAuthorityTickFault {
    None,
    AfterStage,
    AfterWal,
    AfterCheckpoint,
    AfterLeaseAcknowledge,
}

#[cfg(test)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum PlayerAuthorityCommandFault {
    None,
    AfterStage,
    AfterWal,
    AfterCheckpoint,
    AfterReceipt,
    AfterLeaseAcknowledge,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum PlayerAuthorityCommandKind {
    Gameplay,
    PauseLifecycle {
        target_paused: bool,
        settled_deadline_ms: u64,
    },
}

impl PlayerAuthorityCommandKind {
    fn is_pause_lifecycle(self) -> bool {
        matches!(self, Self::PauseLifecycle { .. })
    }
}

#[cfg(test)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum PlayerAuthorityMacroFault {
    None,
    AfterStage,
    AfterWal,
    AfterCheckpoint,
    AfterLeaseAcknowledge,
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
    player_authority_startup_recovery: Option<CorePlayerAuthorityStartupRecoveryReceipt>,
    #[cfg(test)]
    player_authority_coverage_override: bool,
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
            player_authority_startup_recovery: None,
            #[cfg(test)]
            player_authority_coverage_override: false,
        }
    }
}

impl CoreRegistry {
    fn player_authority_coverage_eligible(&self, summary: &CoreStateSummary) -> bool {
        if summary.coverage.authority_eligible {
            return true;
        }
        #[cfg(test)]
        {
            self.player_authority_coverage_override
        }
        #[cfg(not(test))]
        false
    }

    #[cfg(test)]
    fn enable_player_authority_coverage_for_test(&mut self) {
        self.player_authority_coverage_override = true;
    }

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
        if !self.player_authority_coverage_eligible(&summary) {
            bail!("native core domain coverage is not player-authority eligible");
        }
        let proof = ExactRealtimeStateProof {
            revision: summary.revision,
            canonical_sha256: summary.canonical_sha256.clone(),
            domain_sha256: summary.domain_sha256.clone(),
        };
        let authority_session_id = store.player_authority_session_binding(session_id)?;
        let catalog = serde_json::to_value(&self.session(session_id)?.catalog.snapshot)?;
        // Publish the fixed-path catalog candidate before the lease. A crash
        // here leaves inert metadata because startup recovery is triggered
        // only by an active player lease with a pending command. Conversely,
        // once Prepare is durable, activation can always verify the catalog.
        store.write_player_authority_recovery_catalog(
            &request.run_id,
            &request.expected_checkpoint,
            &summary.registry_fingerprint,
            catalog,
        )?;
        let lease = store.prepare_player_authority_lease(
            authority_session_id,
            request.run_id.clone(),
            summary.registry_fingerprint.clone(),
            request.expected_checkpoint.clone(),
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
        let authority_session_id = store.player_authority_session_binding(session_id)?;
        let current = store.require_exact_realtime_lease()?;
        if current.purpose()? != ExactRealtimeLeasePurpose::PlayerAuthority
            || current.authority_session_id.as_deref() != Some(authority_session_id.as_str())
            || current.run_id != request.run_id
            || current.registry_fingerprint != summary.registry_fingerprint
            || current.checkpoint != request.expected_checkpoint
        {
            bail!("native player-authority activation lease identity conflicts");
        }
        if !self.player_authority_coverage_eligible(&summary) {
            bail!("native core domain coverage is not player-authority eligible");
        }
        let published = store
            .latest_published_checkpoint_identity("normal-main")?
            .ok_or_else(|| anyhow!("normal-main published checkpoint is missing"))?;
        store.read_player_authority_recovery_catalog(&current, &published)?;
        let lease = store.activate_player_authority_lease(
            &authority_session_id,
            &request.run_id,
            &summary.registry_fingerprint,
        )?;
        Ok(CorePlayerAuthorityLeaseResult { lease, summary })
    }

    /// Settles one and only one player-authoritative realtime second. This is
    /// intentionally a single host operation: Rust derives and durably stages
    /// the pending command, commits its idempotent WAL entry, publishes an
    /// incremental checkpoint, and finally advances the lease ACK. Retrying
    /// the same sequence after a lost response resumes from whichever durable
    /// boundary was reached.
    pub fn commit_player_authority_tick(
        &mut self,
        store: &mut SaveStore,
        session_id: &str,
        request: CoreCommitPlayerAuthorityTickRequest,
    ) -> anyhow::Result<CoreCommitPlayerAuthorityTickResult> {
        self.commit_player_authority_tick_internal(
            store,
            session_id,
            request,
            #[cfg(test)]
            PlayerAuthorityTickFault::None,
        )
    }

    #[cfg(not(test))]
    fn commit_player_authority_tick_internal(
        &mut self,
        store: &mut SaveStore,
        session_id: &str,
        request: CoreCommitPlayerAuthorityTickRequest,
    ) -> anyhow::Result<CoreCommitPlayerAuthorityTickResult> {
        self.commit_player_authority_tick_impl(store, session_id, request, || Ok(()))
    }

    #[cfg(test)]
    fn commit_player_authority_tick_internal(
        &mut self,
        store: &mut SaveStore,
        session_id: &str,
        request: CoreCommitPlayerAuthorityTickRequest,
        fault: PlayerAuthorityTickFault,
    ) -> anyhow::Result<CoreCommitPlayerAuthorityTickResult> {
        let reached = std::cell::Cell::new(PlayerAuthorityTickFault::None);
        self.commit_player_authority_tick_impl(store, session_id, request, || {
            let next = match reached.get() {
                PlayerAuthorityTickFault::None => PlayerAuthorityTickFault::AfterStage,
                PlayerAuthorityTickFault::AfterStage => PlayerAuthorityTickFault::AfterWal,
                PlayerAuthorityTickFault::AfterWal => PlayerAuthorityTickFault::AfterCheckpoint,
                PlayerAuthorityTickFault::AfterCheckpoint => {
                    PlayerAuthorityTickFault::AfterLeaseAcknowledge
                }
                PlayerAuthorityTickFault::AfterLeaseAcknowledge => {
                    PlayerAuthorityTickFault::AfterLeaseAcknowledge
                }
            };
            reached.set(next);
            if next == fault {
                bail!("injected native player-authority tick lost response at {next:?}")
            }
            Ok(())
        })
    }

    fn commit_player_authority_tick_impl(
        &mut self,
        store: &mut SaveStore,
        session_id: &str,
        request: CoreCommitPlayerAuthorityTickRequest,
        mut after_durable_boundary: impl FnMut() -> anyhow::Result<()>,
    ) -> anyhow::Result<CoreCommitPlayerAuthorityTickResult> {
        validate_session_id(session_id)?;
        if request.sequence == 0 || request.sequence > MAX_SAFE_INTEGER {
            bail!("native player-authority tick sequence is invalid");
        }
        self.reconcile_uncertain_checkpoint_publication(store, session_id)?;
        let authority_session_id = store.player_authority_session_binding(session_id)?;
        let initial = store.require_exact_realtime_lease()?;
        if initial.purpose()? != ExactRealtimeLeasePurpose::PlayerAuthority
            || initial.authority_session_id.as_deref() != Some(authority_session_id.as_str())
            || initial.run_id != request.run_id
            || initial.phase != crate::exact_realtime_lease::ExactRealtimeLeasePhase::Active
        {
            bail!("native player-authority tick lease session/run identity conflicts");
        }

        let initial_summary = self.status(session_id)?;
        let initial_state = self.session(session_id)?;
        if initial_state.identity.slot != "normal-main"
            || initial_state.identity.mode != "normal"
            || initial_state.identity.state_version != 47
            || initial_state.identity.registry_fingerprint != initial.registry_fingerprint
            || initial_summary.mode != "normal"
            || initial_summary.state_version != 47
            || initial_summary.registry_fingerprint != initial.registry_fingerprint
            || initial_summary.paused
        {
            bail!("native player-authority tick requires a running v47 normal-main session");
        }

        if initial.pending_command.is_some() {
            bail!("native player-authority gameplay command is pending before realtime tick");
        }
        if initial.pending_advance.is_some() || initial.macro_session.is_some() {
            bail!("native player-authority macro session must finish before realtime tick");
        }
        if initial.pending_tick.is_none() && request.sequence == initial.acknowledged.sequence {
            if initial_summary.revision != initial.acknowledged.revision
                || initial_summary.canonical_sha256 != initial.acknowledged.proof.canonical_sha256
                || initial_summary.domain_sha256 != initial.acknowledged.proof.domain_sha256
            {
                bail!("native player-authority duplicate tick differs from its durable ACK");
            }
            let latest = store
                .latest_published_checkpoint_identity("normal-main")?
                .ok_or_else(|| anyhow!("normal-main published checkpoint is missing"))?;
            let checkpoint = initial.acknowledged.checkpoint.clone();
            if latest.generation != checkpoint.generation
                || latest.root_hash != checkpoint.root_hash
                || latest.revision != checkpoint.revision
                || latest.mode != "normal"
                || latest.state_version != 47
                || latest.registry_fingerprint != initial.registry_fingerprint
                || initial_state.identity.generation != checkpoint.generation
                || initial_state.identity.root_hash != checkpoint.root_hash
                || initial_state.identity.revision != checkpoint.revision
            {
                bail!("native player-authority duplicate tick checkpoint is no longer current");
            }
            return Ok(CoreCommitPlayerAuthorityTickResult {
                sequence: request.sequence,
                revision: initial_summary.revision,
                checkpoint,
                summary: initial_summary,
                duplicate: true,
            });
        }

        let resumed = initial.pending_tick.is_some();
        if let Some(pending) = initial.pending_tick.as_ref() {
            if pending.sequence != request.sequence
                || !matches!(
                    initial_summary.revision,
                    revision
                        if revision == pending.base_revision
                            || revision == pending.expected_revision
                )
            {
                bail!("native player-authority pending tick conflicts with the request");
            }
        } else if request.sequence
            != initial
                .acknowledged
                .sequence
                .checked_add(1)
                .ok_or_else(|| anyhow!("native player-authority sequence is exhausted"))?
        {
            bail!("native player-authority tick sequence is not next");
        }

        let staged = store.stage_player_authority_tick(
            &authority_session_id,
            &request.run_id,
            request.sequence,
        )?;
        after_durable_boundary()?;
        let pending = staged
            .pending_tick
            .as_ref()
            .ok_or_else(|| anyhow!("native player-authority staged tick is missing"))?
            .clone();
        let published_before_commit = store
            .latest_published_checkpoint_identity("normal-main")?
            .ok_or_else(|| anyhow!("normal-main published checkpoint is missing"))?;
        let state_before_commit = self.session(session_id)?;
        let checkpoint_already_published = published_before_commit.revision
            == pending.expected_revision
            && state_before_commit.identity.generation == published_before_commit.generation
            && state_before_commit.identity.root_hash == published_before_commit.root_hash
            && state_before_commit.identity.revision == published_before_commit.revision
            && state_before_commit.revision == pending.expected_revision;
        let committed_duplicate = if checkpoint_already_published {
            // Checkpoint publication compacted the covered WAL. Its exact
            // generation plus the in-memory state proof is therefore the
            // durable idempotency receipt for a retry after a lost response.
            true
        } else {
            let operation = CoreCommitOperationRequest {
                command_id: pending.command_id.clone(),
                base_revision: pending.base_revision,
                command: None,
                simulation_seconds: pending.simulation_seconds as f64,
                wall_seconds: pending.wall_seconds as f64,
                advance_mode: CoreAdvanceMode::Exact,
                include_diagnostics: true,
            };
            let committed = self.commit_operation_internal(
                store,
                session_id,
                operation,
                Some(CoreLeaseAuthorization::PlayerAuthority {
                    lease: staged.clone(),
                    authority_session_id: authority_session_id.clone(),
                    pause_lifecycle: false,
                }),
            )?;
            if committed.revision != pending.expected_revision
                || committed.current_revision != pending.expected_revision
            {
                bail!("native player-authority WAL result differs from the pending tick");
            }
            committed.duplicate
        };
        after_durable_boundary()?;

        let summary = self.status(session_id)?;
        if summary.revision != pending.expected_revision {
            bail!("native player-authority state differs from its durable WAL");
        }
        let latest = store
            .latest_published_checkpoint_identity("normal-main")?
            .ok_or_else(|| anyhow!("normal-main published checkpoint is missing"))?;
        if latest.mode != "normal"
            || latest.state_version != 47
            || latest.registry_fingerprint != staged.registry_fingerprint
        {
            bail!("native player-authority published checkpoint identity changed");
        }
        let (checkpoint, checkpoint_reused) = if latest.revision == pending.expected_revision {
            let state = self.session(session_id)?;
            if state.identity.generation != latest.generation
                || state.identity.root_hash != latest.root_hash
                || state.identity.revision != latest.revision
            {
                bail!("native player-authority session is not based on its pending checkpoint");
            }
            (
                ExactRealtimeCheckpoint {
                    generation: latest.generation,
                    root_hash: latest.root_hash,
                    revision: latest.revision,
                },
                true,
            )
        } else {
            if latest.revision != pending.base_revision
                || latest.generation != staged.acknowledged.checkpoint.generation
                || latest.root_hash != staged.acknowledged.checkpoint.root_hash
            {
                bail!("native player-authority cannot checkpoint across an unproven publication");
            }
            let authorization = CoreLeaseAuthorization::PlayerAuthority {
                lease: staged.clone(),
                authority_session_id: authority_session_id.clone(),
                pause_lifecycle: false,
            };
            let published = self.checkpoint_internal(
                store,
                session_id,
                pending.settled_deadline_ms,
                Some(&authorization),
            )?;
            if published.checkpoint.slot != "normal-main"
                || published.checkpoint.revision != pending.expected_revision
                || published.summary.revision != pending.expected_revision
                || published.summary.canonical_sha256 != summary.canonical_sha256
                || published.summary.domain_sha256 != summary.domain_sha256
            {
                bail!("native player-authority checkpoint differs from its durable WAL");
            }
            (
                ExactRealtimeCheckpoint {
                    generation: published.checkpoint.generation,
                    root_hash: published.checkpoint.root_hash,
                    revision: published.checkpoint.revision,
                },
                false,
            )
        };
        after_durable_boundary()?;

        let proof = ExactRealtimeStateProof {
            revision: summary.revision,
            canonical_sha256: summary.canonical_sha256.clone(),
            domain_sha256: summary.domain_sha256.clone(),
        };
        let lease = store.acknowledge_player_authority_tick(
            &authority_session_id,
            &request.run_id,
            proof,
            checkpoint.clone(),
        )?;
        after_durable_boundary()?;
        if lease.acknowledged.sequence != request.sequence
            || lease.acknowledged.revision != summary.revision
            || lease.pending_tick.is_some()
            || lease.pending_command.is_some()
            || lease.pending_advance.is_some()
        {
            bail!("native player-authority lease ACK did not close the tick");
        }
        Ok(CoreCommitPlayerAuthorityTickResult {
            sequence: request.sequence,
            revision: summary.revision,
            checkpoint,
            summary,
            duplicate: resumed || committed_duplicate || checkpoint_reused,
        })
    }

    /// Settles one bounded PureIdleMacroV10 window as a single durable player
    /// operation even when the three ten-second calibration slices span
    /// multiple internal revisions. A fresh request is preflighted once; a
    /// restart reuses the staged identity and any existing WAL/checkpoint.
    pub fn commit_player_authority_macro_advance(
        &mut self,
        store: &mut SaveStore,
        session_id: &str,
        request: CoreCommitPlayerAuthorityMacroAdvanceRequest,
    ) -> anyhow::Result<CoreCommitPlayerAuthorityMacroAdvanceResult> {
        self.commit_player_authority_macro_advance_internal(
            store,
            session_id,
            request,
            #[cfg(test)]
            PlayerAuthorityMacroFault::None,
        )
    }

    #[cfg(not(test))]
    fn commit_player_authority_macro_advance_internal(
        &mut self,
        store: &mut SaveStore,
        session_id: &str,
        request: CoreCommitPlayerAuthorityMacroAdvanceRequest,
    ) -> anyhow::Result<CoreCommitPlayerAuthorityMacroAdvanceResult> {
        self.commit_player_authority_macro_advance_impl(store, session_id, request, || Ok(()))
    }

    #[cfg(test)]
    fn commit_player_authority_macro_advance_internal(
        &mut self,
        store: &mut SaveStore,
        session_id: &str,
        request: CoreCommitPlayerAuthorityMacroAdvanceRequest,
        fault: PlayerAuthorityMacroFault,
    ) -> anyhow::Result<CoreCommitPlayerAuthorityMacroAdvanceResult> {
        let reached = std::cell::Cell::new(PlayerAuthorityMacroFault::None);
        self.commit_player_authority_macro_advance_impl(store, session_id, request, || {
            let next = match reached.get() {
                PlayerAuthorityMacroFault::None => PlayerAuthorityMacroFault::AfterStage,
                PlayerAuthorityMacroFault::AfterStage => PlayerAuthorityMacroFault::AfterWal,
                PlayerAuthorityMacroFault::AfterWal => PlayerAuthorityMacroFault::AfterCheckpoint,
                PlayerAuthorityMacroFault::AfterCheckpoint => {
                    PlayerAuthorityMacroFault::AfterLeaseAcknowledge
                }
                PlayerAuthorityMacroFault::AfterLeaseAcknowledge => {
                    PlayerAuthorityMacroFault::AfterLeaseAcknowledge
                }
            };
            reached.set(next);
            if next == fault {
                bail!("injected native player-authority macro lost response at {next:?}")
            }
            Ok(())
        })
    }

    fn commit_player_authority_macro_advance_impl(
        &mut self,
        store: &mut SaveStore,
        session_id: &str,
        request: CoreCommitPlayerAuthorityMacroAdvanceRequest,
        mut after_durable_boundary: impl FnMut() -> anyhow::Result<()>,
    ) -> anyhow::Result<CoreCommitPlayerAuthorityMacroAdvanceResult> {
        validate_session_id(session_id)?;
        if request.base_revision > MAX_SAFE_INTEGER
            || request.simulation_milliseconds == 0
            || request.wall_milliseconds == 0
            || request.simulation_milliseconds > 30 * 24 * 60 * 60 * 1_000
            || request.wall_milliseconds > 30 * 24 * 60 * 60 * 1_000
        {
            bail!("native player-authority macro budget is invalid");
        }
        self.reconcile_uncertain_checkpoint_publication(store, session_id)?;
        let authority_session_id = store.player_authority_session_binding(session_id)?;
        let initial = store.require_exact_realtime_lease()?;
        if initial.purpose()? != ExactRealtimeLeasePurpose::PlayerAuthority
            || initial.authority_session_id.as_deref() != Some(authority_session_id.as_str())
            || initial.run_id != request.run_id
            || initial.phase != crate::exact_realtime_lease::ExactRealtimeLeasePhase::Active
            || !initial.startup_resume_enabled
        {
            bail!("native player-authority macro lease session/run identity conflicts");
        }
        let initial_summary = self.status(session_id)?;
        let initial_state = self.session(session_id)?;
        if initial_state.identity.slot != "normal-main"
            || initial_state.identity.mode != "normal"
            || initial_state.identity.state_version != 47
            || initial_state.identity.registry_fingerprint != initial.registry_fingerprint
            || initial_summary.mode != "normal"
            || initial_summary.state_version != 47
            || initial_summary.registry_fingerprint != initial.registry_fingerprint
            || initial_summary.paused
        {
            bail!("native player-authority macro requires a running v47 normal-main session");
        }
        if initial.pending_tick.is_some() || initial.pending_command.is_some() {
            bail!("another native player-authority event is pending before the macro advance");
        }
        if let Some(session) = initial.macro_session.as_ref()
            && session.session_id != request.macro_session_id
        {
            bail!("native player-authority macro session identity conflicts");
        }

        // Immediate replay after ACK uses the request-bound command digest as
        // its durable receipt. Once another event commits, the old operation
        // is intentionally outside the one-event recovery window.
        if initial.pending_advance.is_none()
            && request.base_revision < initial.acknowledged.revision
            && let Some(session) = initial.macro_session.as_ref()
        {
            let request_sha256 = player_authority_macro_request_sha256(
                &request.run_id,
                &request.macro_session_id,
                &request.operation_id,
                request.base_revision,
                request.simulation_milliseconds,
                request.wall_milliseconds,
                &session.algorithm_version,
                &initial.registry_fingerprint,
                initial.acknowledged.settled_deadline_ms,
            )?;
            if let Some(last) = session.last_acknowledged_advance.as_ref()
                && last.operation_id == request.operation_id
                && last.base_revision == request.base_revision
                && last.simulation_milliseconds == request.simulation_milliseconds
                && last.wall_milliseconds == request.wall_milliseconds
                && last.request_sha256 == request_sha256
                && initial.acknowledged.command_id.as_deref() == Some(last.command_id.as_str())
            {
                if initial_summary.revision != initial.acknowledged.revision
                    || initial_summary.canonical_sha256
                        != initial.acknowledged.proof.canonical_sha256
                    || initial_summary.domain_sha256 != initial.acknowledged.proof.domain_sha256
                {
                    bail!("native player-authority duplicate macro differs from its durable ACK");
                }
                let latest = store
                    .latest_published_checkpoint_identity("normal-main")?
                    .ok_or_else(|| anyhow!("normal-main published checkpoint is missing"))?;
                let checkpoint = initial.acknowledged.checkpoint.clone();
                if latest.generation != checkpoint.generation
                    || latest.root_hash != checkpoint.root_hash
                    || latest.revision != checkpoint.revision
                    || initial_state.identity.generation != checkpoint.generation
                    || initial_state.identity.root_hash != checkpoint.root_hash
                    || initial_state.identity.revision != checkpoint.revision
                {
                    bail!(
                        "native player-authority duplicate macro checkpoint is no longer current"
                    );
                }
                return Ok(CoreCommitPlayerAuthorityMacroAdvanceResult {
                    acknowledged_sequence: initial.acknowledged.sequence,
                    macro_session_id: request.macro_session_id,
                    operation_id: request.operation_id,
                    base_revision: request.base_revision,
                    revision: initial_summary.revision,
                    simulation_milliseconds: request.simulation_milliseconds,
                    wall_milliseconds: request.wall_milliseconds,
                    algorithm_version: session.algorithm_version.clone(),
                    settled_deadline_ms: initial.acknowledged.settled_deadline_ms,
                    checkpoint,
                    summary: initial_summary,
                    duplicate: true,
                });
            }
            bail!("native player-authority macro base revision is not current");
        }

        let resumed = initial.pending_advance.is_some();
        let mut prepared_candidate = None;
        let (expected_revision, algorithm_version) =
            if let Some(pending) = initial.pending_advance.as_ref() {
                if pending.macro_session_id != request.macro_session_id
                    || pending.operation_id != request.operation_id
                    || pending.base_revision != request.base_revision
                    || pending.simulation_milliseconds != request.simulation_milliseconds
                    || pending.wall_milliseconds != request.wall_milliseconds
                    || !matches!(
                        initial_summary.revision,
                        revision
                            if revision == pending.base_revision
                                || revision == pending.expected_revision
                    )
                {
                    bail!("native player-authority pending macro conflicts with the request");
                }
                (pending.expected_revision, pending.algorithm_version.clone())
            } else {
                if request.base_revision != initial.acknowledged.revision {
                    bail!("native player-authority macro base revision is not current");
                }
                let mut prepared = initial_state.clone();
                let advanced = prepared.advance(&CoreAdvanceRequest {
                    base_revision: request.base_revision,
                    simulation_seconds: milliseconds_to_seconds(request.simulation_milliseconds),
                    wall_seconds: milliseconds_to_seconds(request.wall_milliseconds),
                    advance_mode: CoreAdvanceMode::PureIdleMacroV10,
                    include_diagnostics: false,
                })?;
                if !advanced.supported || prepared.revision <= request.base_revision {
                    bail!(
                        "native player-authority macro preflight was rejected: {}",
                        advanced.reason.as_deref().unwrap_or("no revision progress")
                    );
                }
                let algorithm_version = advanced
                    .algorithm_version
                    .ok_or_else(|| anyhow!("native player-authority macro algorithm is missing"))?
                    .to_owned();
                if let Some(session) = initial.macro_session.as_ref()
                    && session.algorithm_version != algorithm_version
                {
                    bail!("native player-authority macro algorithm changed inside the session");
                }
                let expected_revision = prepared.revision;
                prepared_candidate = Some(prepared);
                (expected_revision, algorithm_version)
            };

        let staged = store.stage_player_authority_macro_advance(
            &authority_session_id,
            &request.run_id,
            &request.macro_session_id,
            &request.operation_id,
            request.base_revision,
            expected_revision,
            request.simulation_milliseconds,
            request.wall_milliseconds,
            &algorithm_version,
        )?;
        after_durable_boundary()?;
        let pending = staged
            .pending_advance
            .as_ref()
            .ok_or_else(|| anyhow!("native player-authority staged macro advance is missing"))?
            .clone();
        let published_before_commit = store
            .latest_published_checkpoint_identity("normal-main")?
            .ok_or_else(|| anyhow!("normal-main published checkpoint is missing"))?;
        let state_before_commit = self.session(session_id)?;
        let checkpoint_already_published = published_before_commit.revision
            == pending.expected_revision
            && state_before_commit.identity.generation == published_before_commit.generation
            && state_before_commit.identity.root_hash == published_before_commit.root_hash
            && state_before_commit.identity.revision == published_before_commit.revision
            && state_before_commit.revision == pending.expected_revision;
        let committed_duplicate = if checkpoint_already_published {
            true
        } else {
            let operation = macro_operation_from_pending(&pending);
            let committed = self.commit_operation_internal_with_prepared(
                store,
                session_id,
                operation,
                Some(CoreLeaseAuthorization::PlayerAuthority {
                    lease: staged.clone(),
                    authority_session_id: authority_session_id.clone(),
                    pause_lifecycle: false,
                }),
                prepared_candidate,
            )?;
            if committed.revision != pending.expected_revision
                || committed.current_revision != pending.expected_revision
            {
                bail!("native player-authority WAL result differs from the pending macro advance");
            }
            committed.duplicate
        };
        after_durable_boundary()?;

        let summary = self.status(session_id)?;
        if summary.revision != pending.expected_revision {
            bail!("native player-authority macro state differs from its durable WAL");
        }
        let latest = store
            .latest_published_checkpoint_identity("normal-main")?
            .ok_or_else(|| anyhow!("normal-main published checkpoint is missing"))?;
        if latest.mode != "normal"
            || latest.state_version != 47
            || latest.registry_fingerprint != staged.registry_fingerprint
        {
            bail!("native player-authority macro publication identity changed");
        }
        let (checkpoint, checkpoint_reused) = if latest.revision == pending.expected_revision {
            let state = self.session(session_id)?;
            if state.identity.generation != latest.generation
                || state.identity.root_hash != latest.root_hash
                || state.identity.revision != latest.revision
            {
                bail!("native player-authority session is not based on its macro checkpoint");
            }
            (
                ExactRealtimeCheckpoint {
                    generation: latest.generation,
                    root_hash: latest.root_hash,
                    revision: latest.revision,
                },
                true,
            )
        } else {
            if latest.revision != pending.base_revision
                || latest.generation != staged.acknowledged.checkpoint.generation
                || latest.root_hash != staged.acknowledged.checkpoint.root_hash
            {
                bail!(
                    "native player-authority macro cannot checkpoint across an unproven publication"
                );
            }
            let authorization = CoreLeaseAuthorization::PlayerAuthority {
                lease: staged.clone(),
                authority_session_id: authority_session_id.clone(),
                pause_lifecycle: false,
            };
            let published = self.checkpoint_internal(
                store,
                session_id,
                pending.settled_deadline_ms,
                Some(&authorization),
            )?;
            if published.checkpoint.slot != "normal-main"
                || published.checkpoint.revision != pending.expected_revision
                || published.summary.revision != pending.expected_revision
                || published.summary.canonical_sha256 != summary.canonical_sha256
                || published.summary.domain_sha256 != summary.domain_sha256
            {
                bail!("native player-authority macro checkpoint differs from its durable WAL");
            }
            (
                ExactRealtimeCheckpoint {
                    generation: published.checkpoint.generation,
                    root_hash: published.checkpoint.root_hash,
                    revision: published.checkpoint.revision,
                },
                false,
            )
        };
        after_durable_boundary()?;

        let proof = ExactRealtimeStateProof {
            revision: summary.revision,
            canonical_sha256: summary.canonical_sha256.clone(),
            domain_sha256: summary.domain_sha256.clone(),
        };
        let lease = store.acknowledge_player_authority_macro_advance(
            &authority_session_id,
            &request.run_id,
            proof,
            checkpoint.clone(),
        )?;
        after_durable_boundary()?;
        if lease.acknowledged.sequence != pending.expected_sequence
            || lease.acknowledged.revision != summary.revision
            || lease.pending_advance.is_some()
            || lease.pending_tick.is_some()
            || lease.pending_command.is_some()
        {
            bail!("native player-authority lease ACK did not close the macro advance");
        }
        Ok(CoreCommitPlayerAuthorityMacroAdvanceResult {
            acknowledged_sequence: lease.acknowledged.sequence,
            macro_session_id: pending.macro_session_id,
            operation_id: pending.operation_id,
            base_revision: pending.base_revision,
            revision: summary.revision,
            simulation_milliseconds: pending.simulation_milliseconds,
            wall_milliseconds: pending.wall_milliseconds,
            algorithm_version: pending.algorithm_version,
            settled_deadline_ms: pending.settled_deadline_ms,
            checkpoint,
            summary,
            duplicate: resumed || committed_duplicate || checkpoint_reused,
        })
    }

    /// Ends a native macro session at its latest ACKed checkpoint. This does
    /// not mutate GameState or WAL; it only releases the private lease fence so
    /// the next exact tick or gameplay command can begin.
    pub fn finish_player_authority_macro_session(
        &mut self,
        store: &mut SaveStore,
        session_id: &str,
        request: CoreFinishPlayerAuthorityMacroSessionRequest,
    ) -> anyhow::Result<CorePlayerAuthorityLeaseResult> {
        validate_session_id(session_id)?;
        self.reconcile_uncertain_checkpoint_publication(store, session_id)?;
        let authority_session_id = store.player_authority_session_binding(session_id)?;
        let lease = store.require_exact_realtime_lease()?;
        let summary = self.status(session_id)?;
        let state = self.session(session_id)?;
        let latest = store
            .latest_published_checkpoint_identity("normal-main")?
            .ok_or_else(|| anyhow!("normal-main published checkpoint is missing"))?;
        if lease.purpose()? != ExactRealtimeLeasePurpose::PlayerAuthority
            || lease.authority_session_id.as_deref() != Some(authority_session_id.as_str())
            || lease.run_id != request.run_id
            || lease.phase != crate::exact_realtime_lease::ExactRealtimeLeasePhase::Active
            || lease.pending_tick.is_some()
            || lease.pending_command.is_some()
            || lease.pending_advance.is_some()
            || summary.revision != lease.acknowledged.revision
            || summary.canonical_sha256 != lease.acknowledged.proof.canonical_sha256
            || summary.domain_sha256 != lease.acknowledged.proof.domain_sha256
            || state.identity.generation != latest.generation
            || state.identity.root_hash != latest.root_hash
            || state.identity.revision != latest.revision
            || latest.generation != lease.acknowledged.checkpoint.generation
            || latest.root_hash != lease.acknowledged.checkpoint.root_hash
            || latest.revision != lease.acknowledged.checkpoint.revision
        {
            bail!("native player-authority macro finish identity conflicts");
        }
        let lease = store.finish_player_authority_macro_session(
            &authority_session_id,
            &request.run_id,
            &request.macro_session_id,
        )?;
        Ok(CorePlayerAuthorityLeaseResult { lease, summary })
    }

    /// Commits one zero-time gameplay command as a durable player-authority
    /// event. Tick and command events share one sequence/revision chain and
    /// the lease permits only one pending event, so neither can overtake the
    /// other's WAL, checkpoint, or ACK boundary.
    pub fn commit_player_authority_command(
        &mut self,
        store: &mut SaveStore,
        session_id: &str,
        request: CoreCommitPlayerAuthorityCommandRequest,
    ) -> anyhow::Result<CoreCommitPlayerAuthorityCommandResult> {
        self.commit_player_authority_command_internal(
            store,
            session_id,
            request,
            PlayerAuthorityCommandKind::Gameplay,
            #[cfg(test)]
            PlayerAuthorityCommandFault::None,
        )
    }

    pub fn commit_player_authority_pause_transition(
        &mut self,
        store: &mut SaveStore,
        session_id: &str,
        request: CoreCommitPlayerAuthorityPauseRequest,
    ) -> anyhow::Result<CoreCommitPlayerAuthorityPauseResult> {
        if request.base_revision > MAX_SAFE_INTEGER
            || request.settled_deadline_ms > MAX_SAFE_INTEGER
        {
            bail!("native player-authority pause lifecycle bounds are invalid")
        }
        let command_value =
            player_authority_pause_command(request.base_revision, request.target_paused);
        let command = decode_player_authority_command_payload(&command_value)?;
        let command_id = derive_player_authority_pause_command_id(
            &request.run_id,
            request.base_revision,
            request.target_paused,
            request.settled_deadline_ms,
        )?;
        let committed = self.commit_player_authority_command_internal(
            store,
            session_id,
            CoreCommitPlayerAuthorityCommandRequest {
                run_id: request.run_id,
                command_id,
                base_revision: request.base_revision,
                command,
            },
            PlayerAuthorityCommandKind::PauseLifecycle {
                target_paused: request.target_paused,
                settled_deadline_ms: request.settled_deadline_ms,
            },
            #[cfg(test)]
            PlayerAuthorityCommandFault::None,
        )?;
        if committed.summary.paused != request.target_paused {
            bail!("native player-authority pause lifecycle result state differs")
        }
        Ok(CoreCommitPlayerAuthorityPauseResult {
            sequence: committed.sequence,
            base_revision: committed.base_revision,
            revision: committed.revision,
            target_paused: request.target_paused,
            settled_deadline_ms: committed.settled_deadline_ms,
            checkpoint: committed.checkpoint,
            summary: committed.summary,
            duplicate: committed.duplicate,
        })
    }

    /// Reopens a durable player-authority session and recovers either a staged
    /// command or a staged macro advance from a previous host process. The
    /// legacy method name remains stable for existing host startup wiring.
    pub fn recover_player_authority_pending_command_on_startup(
        &mut self,
        store: &mut SaveStore,
    ) -> anyhow::Result<Option<CorePlayerAuthorityStartupRecoveryReceipt>> {
        if let Some(receipt) = self.player_authority_startup_recovery.as_ref() {
            return Ok(Some(receipt.clone()));
        }
        let Some(lease) = store.read_exact_realtime_lease()? else {
            return Ok(None);
        };
        if lease.purpose()? != ExactRealtimeLeasePurpose::PlayerAuthority
            || !matches!(
                lease.phase,
                crate::exact_realtime_lease::ExactRealtimeLeasePhase::Active
                    | crate::exact_realtime_lease::ExactRealtimeLeasePhase::Paused
            )
        {
            return Ok(None);
        }
        let recovering_command = lease.pending_command.is_some();
        let recovering_macro = lease.pending_advance.is_some();
        if !recovering_command && !recovering_macro && !lease.startup_resume_enabled {
            return Ok(None);
        }
        if lease.pending_tick.is_some() {
            bail!("native player-authority startup recovery found competing pending work")
        }
        if recovering_command && recovering_macro {
            bail!("native player-authority startup recovery found multiple pending operations")
        }
        let pending_macro = lease.pending_advance.clone();
        let published = store
            .latest_published_checkpoint_identity("normal-main")?
            .ok_or_else(|| anyhow!("normal-main published checkpoint is missing"))?;
        let catalog = store.read_player_authority_recovery_catalog(&lease, &published)?;
        let preexisting_command_changes = if !recovering_command
            && lease
                .acknowledged
                .last_player_command_id
                .as_ref()
                .is_some_and(|command_id| {
                    lease.acknowledged.command_id.as_ref() == Some(command_id)
                }) {
            Some(store.read_player_authority_command_change_receipt(&lease)?)
        } else {
            None
        };
        let opened = self.open(
            store,
            &published.slot,
            published.generation,
            &published.root_hash,
            published.revision,
            &published.registry_fingerprint,
            catalog,
        )?;
        if !self.player_authority_coverage_eligible(&opened.summary) {
            self.sessions.remove(&opened.session_id);
            bail!("native core domain coverage is not player-authority eligible")
        }
        if recovering_command {
            self.recover_player_authority_pending_command(store, &opened.session_id)
                .context("recover durable player-authority command during host startup")?;
        } else if recovering_macro {
            self.recover_player_authority_pending_macro_advance(store, &opened.session_id)
                .context("recover durable player-authority macro advance during host startup")?;
        } else {
            let summary = self.status(&opened.session_id)?;
            let lease_paused =
                lease.phase == crate::exact_realtime_lease::ExactRealtimeLeasePhase::Paused;
            if summary.revision != lease.acknowledged.revision
                || summary.state_version != 47
                || summary.mode != "normal"
                || summary.paused != lease_paused
                || summary.registry_fingerprint != lease.registry_fingerprint
                || summary.canonical_sha256 != lease.acknowledged.proof.canonical_sha256
                || summary.domain_sha256 != lease.acknowledged.proof.domain_sha256
            {
                bail!("native player-authority resumable state proof conflicts")
            }
            let authority_session_id =
                store.player_authority_session_binding(&opened.session_id)?;
            store.rebind_resumable_player_authority_session(&lease, &authority_session_id)?;
        }
        let acknowledged = store.require_exact_realtime_lease()?;
        let summary = self.status(&opened.session_id)?;
        let latest = store
            .latest_published_checkpoint_identity("normal-main")?
            .ok_or_else(|| anyhow!("normal-main published checkpoint is missing"))?;
        let authority_session_id = store.player_authority_session_binding(&opened.session_id)?;
        let acknowledged_paused =
            acknowledged.phase == crate::exact_realtime_lease::ExactRealtimeLeasePhase::Paused;
        if acknowledged.purpose()? != ExactRealtimeLeasePurpose::PlayerAuthority
            || !matches!(
                acknowledged.phase,
                crate::exact_realtime_lease::ExactRealtimeLeasePhase::Active
                    | crate::exact_realtime_lease::ExactRealtimeLeasePhase::Paused
            )
            || !acknowledged.startup_resume_enabled
            || acknowledged.authority_session_id.as_deref() != Some(authority_session_id.as_str())
            || acknowledged.pending_tick.is_some()
            || acknowledged.pending_command.is_some()
            || acknowledged.pending_advance.is_some()
            || acknowledged.acknowledged.revision != summary.revision
            || summary.canonical_sha256 != acknowledged.acknowledged.proof.canonical_sha256
            || summary.domain_sha256 != acknowledged.acknowledged.proof.domain_sha256
            || summary.state_version != 47
            || summary.mode != "normal"
            || summary.paused != acknowledged_paused
            || !self.player_authority_coverage_eligible(&summary)
            || summary.registry_fingerprint != acknowledged.registry_fingerprint
            || latest.generation != acknowledged.acknowledged.checkpoint.generation
            || latest.root_hash != acknowledged.acknowledged.checkpoint.root_hash
            || latest.revision != acknowledged.acknowledged.checkpoint.revision
            || latest.state_version != 47
            || latest.mode != "normal"
            || latest.registry_fingerprint != acknowledged.registry_fingerprint
        {
            bail!("native player-authority startup recovery receipt identity conflicts")
        }
        let next_sequence = acknowledged
            .acknowledged
            .sequence
            .checked_add(1)
            .filter(|value| *value <= MAX_SAFE_INTEGER)
            .ok_or_else(|| anyhow!("native player-authority startup sequence is exhausted"))?;
        let next_deadline_ms = acknowledged
            .acknowledged
            .settled_deadline_ms
            .checked_add(1_000)
            .filter(|value| *value <= MAX_SAFE_INTEGER)
            .ok_or_else(|| anyhow!("native player-authority startup deadline is exhausted"))?;
        let command_changes = if recovering_command {
            match store.read_player_authority_command_change_receipt(&acknowledged) {
                Ok(changes) => Some(changes),
                Err(error) => {
                    self.sessions.remove(&opened.session_id);
                    return Err(error)
                        .context("validate recovered player-authority command change receipt");
                }
            }
        } else {
            preexisting_command_changes
        };
        let macro_session_id = acknowledged
            .macro_session
            .as_ref()
            .map(|session| session.session_id.clone());
        let acknowledged_macro = acknowledged
            .macro_session
            .as_ref()
            .and_then(|session| session.last_acknowledged_advance.clone());
        let (pending_macro_cleanup_session_id, pending_macro_cleanup_revision) = match (
            acknowledged.last_finished_macro_session_id.as_ref(),
            acknowledged.last_finished_macro_revision,
        ) {
            (Some(session_id), Some(revision)) => (Some(session_id.clone()), Some(revision)),
            // Legacy finish IDs intentionally cannot manufacture a revision-
            // bound cleanup intent after restart.
            _ => (None, None),
        };
        let receipt = CorePlayerAuthorityStartupRecoveryReceipt {
            schema_version: 1,
            kind: "native-core-player-authority-startup-recovery-v1",
            owner_id: "main-player-authority",
            session_id: opened.session_id,
            run_id: acknowledged.run_id,
            registry_fingerprint: acknowledged.registry_fingerprint,
            revision: acknowledged.acknowledged.revision,
            entry_checkpoint: acknowledged.checkpoint.clone(),
            checkpoint: acknowledged.acknowledged.checkpoint,
            acknowledged_sequence: acknowledged.acknowledged.sequence,
            next_sequence,
            settled_deadline_ms: acknowledged.acknowledged.settled_deadline_ms,
            next_deadline_ms,
            paused: acknowledged_paused,
            command_id: command_changes
                .as_ref()
                .map(|changes| changes.command_id.clone()),
            command_base_revision: command_changes
                .as_ref()
                .map(|changes| changes.base_revision),
            changed_entity_ids: command_changes
                .as_ref()
                .map(|changes| changes.changed_entity_ids.clone())
                .unwrap_or_default(),
            changed_belt_ids: command_changes
                .as_ref()
                .map(|changes| changes.changed_belt_ids.clone())
                .unwrap_or_default(),
            topology_dirty: command_changes
                .as_ref()
                .is_some_and(|changes| changes.topology_dirty),
            macro_session_id,
            recovered_macro_operation_id: pending_macro
                .as_ref()
                .map(|pending| pending.operation_id.clone())
                .or_else(|| {
                    acknowledged_macro
                        .as_ref()
                        .map(|advance| advance.operation_id.clone())
                }),
            macro_algorithm_version: acknowledged
                .macro_session
                .as_ref()
                .map(|session| session.algorithm_version.clone()),
            macro_simulation_milliseconds: pending_macro
                .as_ref()
                .map(|pending| pending.simulation_milliseconds)
                .or_else(|| {
                    acknowledged_macro
                        .as_ref()
                        .map(|advance| advance.simulation_milliseconds)
                }),
            macro_wall_milliseconds: pending_macro
                .as_ref()
                .map(|pending| pending.wall_milliseconds)
                .or_else(|| {
                    acknowledged_macro
                        .as_ref()
                        .map(|advance| advance.wall_milliseconds)
                }),
            pending_macro_cleanup_session_id,
            pending_macro_cleanup_revision,
            summary,
        };
        self.player_authority_startup_recovery = Some(receipt.clone());
        Ok(Some(receipt))
    }

    pub fn recover_player_authority_pending_macro_advance(
        &mut self,
        store: &mut SaveStore,
        session_id: &str,
    ) -> anyhow::Result<CoreRecoverPlayerAuthorityMacroAdvanceResult> {
        validate_session_id(session_id)?;
        self.reconcile_uncertain_checkpoint_publication(store, session_id)?;
        let lease = store.require_exact_realtime_lease()?;
        if lease.purpose()? != ExactRealtimeLeasePurpose::PlayerAuthority
            || lease.phase != crate::exact_realtime_lease::ExactRealtimeLeasePhase::Active
            || lease.pending_tick.is_some()
            || lease.pending_command.is_some()
        {
            bail!("native player-authority recovery requires one active pending macro advance")
        }
        let pending = lease
            .pending_advance
            .as_ref()
            .ok_or_else(|| {
                anyhow!("native player-authority recovery has no pending macro advance")
            })?
            .clone();
        let summary = self.status(session_id)?;
        let state = self.session(session_id)?;
        let latest = store
            .latest_published_checkpoint_identity("normal-main")?
            .ok_or_else(|| anyhow!("normal-main published checkpoint is missing"))?;
        if state.identity.slot != "normal-main"
            || state.identity.mode != "normal"
            || state.identity.state_version != 47
            || state.identity.registry_fingerprint != lease.registry_fingerprint
            || summary.mode != "normal"
            || summary.state_version != 47
            || summary.registry_fingerprint != lease.registry_fingerprint
            || summary.paused
            || !matches!(summary.revision, revision if revision == pending.base_revision || revision == pending.expected_revision)
            || latest.mode != "normal"
            || latest.state_version != 47
            || latest.registry_fingerprint != lease.registry_fingerprint
            || state.identity.generation != latest.generation
            || state.identity.root_hash != latest.root_hash
            || state.identity.revision != latest.revision
        {
            bail!("native player-authority macro recovery session/publication identity conflicts")
        }
        let publication_is_acknowledged = latest.generation
            == lease.acknowledged.checkpoint.generation
            && latest.root_hash == lease.acknowledged.checkpoint.root_hash
            && latest.revision == lease.acknowledged.checkpoint.revision;
        if !publication_is_acknowledged && latest.revision != pending.expected_revision {
            bail!(
                "native player-authority macro recovery publication is outside the pending advance"
            )
        }
        if summary.revision == pending.base_revision
            && (summary.canonical_sha256 != lease.acknowledged.proof.canonical_sha256
                || summary.domain_sha256 != lease.acknowledged.proof.domain_sha256)
        {
            bail!("native player-authority macro recovery base proof conflicts")
        }

        let authority_session_id = store.player_authority_session_binding(session_id)?;
        store.rebind_pending_player_authority_macro_advance(&lease, &authority_session_id)?;
        let run_id = lease.run_id;
        let committed = self.commit_player_authority_macro_advance(
            store,
            session_id,
            CoreCommitPlayerAuthorityMacroAdvanceRequest {
                run_id: run_id.clone(),
                macro_session_id: pending.macro_session_id,
                operation_id: pending.operation_id,
                base_revision: pending.base_revision,
                simulation_milliseconds: pending.simulation_milliseconds,
                wall_milliseconds: pending.wall_milliseconds,
            },
        )?;
        Ok(CoreRecoverPlayerAuthorityMacroAdvanceResult { run_id, committed })
    }

    pub fn recover_player_authority_pending_command(
        &mut self,
        store: &mut SaveStore,
        session_id: &str,
    ) -> anyhow::Result<CoreRecoverPlayerAuthorityCommandResult> {
        validate_session_id(session_id)?;
        self.reconcile_uncertain_checkpoint_publication(store, session_id)?;
        let lease = store.require_exact_realtime_lease()?;
        let pending = lease
            .pending_command
            .as_ref()
            .ok_or_else(|| anyhow!("native player-authority recovery has no pending command"))?
            .clone();
        let pause_target = player_authority_pause_target(&pending.command);
        let expected_source_phase = match pause_target {
            Some(true) | None => crate::exact_realtime_lease::ExactRealtimeLeasePhase::Active,
            Some(false) => crate::exact_realtime_lease::ExactRealtimeLeasePhase::Paused,
        };
        if lease.purpose()? != ExactRealtimeLeasePurpose::PlayerAuthority
            || lease.phase != expected_source_phase
            || lease.pending_tick.is_some()
            || lease.pending_advance.is_some()
        {
            bail!(
                "native player-authority recovery requires one lifecycle-consistent pending command"
            )
        }
        let command = decode_player_authority_command_payload(&pending.command)?;
        let summary = self.status(session_id)?;
        let state = self.session(session_id)?;
        let latest = store
            .latest_published_checkpoint_identity("normal-main")?
            .ok_or_else(|| anyhow!("normal-main published checkpoint is missing"))?;
        if state.identity.slot != "normal-main"
            || state.identity.mode != "normal"
            || state.identity.state_version != 47
            || state.identity.registry_fingerprint != lease.registry_fingerprint
            || summary.mode != "normal"
            || summary.state_version != 47
            || summary.registry_fingerprint != lease.registry_fingerprint
            || match (summary.revision, pause_target) {
                (revision, Some(target)) if revision == pending.base_revision => {
                    summary.paused == target
                }
                (revision, Some(target)) if revision == pending.expected_revision => {
                    summary.paused != target
                }
                (_, Some(_)) => true,
                (_, None) => summary.paused,
            }
            || !matches!(summary.revision, revision if revision == pending.base_revision || revision == pending.expected_revision)
            || latest.mode != "normal"
            || latest.state_version != 47
            || latest.registry_fingerprint != lease.registry_fingerprint
            || state.identity.generation != latest.generation
            || state.identity.root_hash != latest.root_hash
            || state.identity.revision != latest.revision
        {
            bail!("native player-authority recovery session/publication identity conflicts")
        }
        let publication_is_acknowledged = latest.generation
            == lease.acknowledged.checkpoint.generation
            && latest.root_hash == lease.acknowledged.checkpoint.root_hash
            && latest.revision == lease.acknowledged.checkpoint.revision;
        if !publication_is_acknowledged && latest.revision != pending.expected_revision {
            bail!("native player-authority recovery publication is outside the pending command")
        }
        if summary.revision == pending.base_revision
            && (summary.canonical_sha256 != lease.acknowledged.proof.canonical_sha256
                || summary.domain_sha256 != lease.acknowledged.proof.domain_sha256)
        {
            bail!("native player-authority recovery base proof conflicts")
        }

        let authority_session_id = store.player_authority_session_binding(session_id)?;
        store.rebind_pending_player_authority_command(&lease, &authority_session_id)?;
        let run_id = lease.run_id;
        let kind = match pause_target {
            Some(target_paused) => PlayerAuthorityCommandKind::PauseLifecycle {
                target_paused,
                settled_deadline_ms: pending.settled_deadline_ms,
            },
            None => PlayerAuthorityCommandKind::Gameplay,
        };
        let committed = self.commit_player_authority_command_internal(
            store,
            session_id,
            CoreCommitPlayerAuthorityCommandRequest {
                run_id: run_id.clone(),
                command_id: pending.command_id,
                base_revision: pending.base_revision,
                command,
            },
            kind,
            #[cfg(test)]
            PlayerAuthorityCommandFault::None,
        )?;
        Ok(CoreRecoverPlayerAuthorityCommandResult { run_id, committed })
    }

    #[cfg(not(test))]
    fn commit_player_authority_command_internal(
        &mut self,
        store: &mut SaveStore,
        session_id: &str,
        request: CoreCommitPlayerAuthorityCommandRequest,
        kind: PlayerAuthorityCommandKind,
    ) -> anyhow::Result<CoreCommitPlayerAuthorityCommandResult> {
        self.commit_player_authority_command_impl(store, session_id, request, kind, || Ok(()))
    }

    #[cfg(test)]
    fn commit_player_authority_command_internal(
        &mut self,
        store: &mut SaveStore,
        session_id: &str,
        request: CoreCommitPlayerAuthorityCommandRequest,
        kind: PlayerAuthorityCommandKind,
        fault: PlayerAuthorityCommandFault,
    ) -> anyhow::Result<CoreCommitPlayerAuthorityCommandResult> {
        let reached = std::cell::Cell::new(PlayerAuthorityCommandFault::None);
        self.commit_player_authority_command_impl(store, session_id, request, kind, || {
            let next = match reached.get() {
                PlayerAuthorityCommandFault::None => PlayerAuthorityCommandFault::AfterStage,
                PlayerAuthorityCommandFault::AfterStage => PlayerAuthorityCommandFault::AfterWal,
                PlayerAuthorityCommandFault::AfterWal => {
                    PlayerAuthorityCommandFault::AfterCheckpoint
                }
                PlayerAuthorityCommandFault::AfterCheckpoint => {
                    PlayerAuthorityCommandFault::AfterReceipt
                }
                PlayerAuthorityCommandFault::AfterReceipt => {
                    PlayerAuthorityCommandFault::AfterLeaseAcknowledge
                }
                PlayerAuthorityCommandFault::AfterLeaseAcknowledge => {
                    PlayerAuthorityCommandFault::AfterLeaseAcknowledge
                }
            };
            reached.set(next);
            if next == fault {
                bail!("injected native player-authority command lost response at {next:?}")
            }
            Ok(())
        })
    }

    fn commit_player_authority_command_impl(
        &mut self,
        store: &mut SaveStore,
        session_id: &str,
        request: CoreCommitPlayerAuthorityCommandRequest,
        kind: PlayerAuthorityCommandKind,
        mut after_durable_boundary: impl FnMut() -> anyhow::Result<()>,
    ) -> anyhow::Result<CoreCommitPlayerAuthorityCommandResult> {
        validate_session_id(session_id)?;
        if request.base_revision > MAX_SAFE_INTEGER
            || request.command.base_revision != request.base_revision
        {
            bail!("native player-authority command base revision is invalid");
        }
        let command_value = serde_json::to_value(&request.command)?;
        match kind {
            PlayerAuthorityCommandKind::Gameplay => {
                if player_authority_pause_target(&command_value).is_some() {
                    bail!("native player-authority pause transition requires the lifecycle path")
                }
            }
            PlayerAuthorityCommandKind::PauseLifecycle { target_paused, .. } => {
                if player_authority_pause_target(&command_value) != Some(target_paused) {
                    bail!("native player-authority pause lifecycle command identity conflicts")
                }
            }
        }
        let request_sha256 = player_authority_command_request_sha256(
            &request.run_id,
            &request.command_id,
            request.base_revision,
            &command_value,
        )?;
        self.reconcile_uncertain_checkpoint_publication(store, session_id)?;
        let authority_session_id = store.player_authority_session_binding(session_id)?;
        let initial = store.require_exact_realtime_lease()?;
        let expected_source_phase = match kind {
            PlayerAuthorityCommandKind::Gameplay
            | PlayerAuthorityCommandKind::PauseLifecycle {
                target_paused: true,
                ..
            } => crate::exact_realtime_lease::ExactRealtimeLeasePhase::Active,
            PlayerAuthorityCommandKind::PauseLifecycle {
                target_paused: false,
                ..
            } => crate::exact_realtime_lease::ExactRealtimeLeasePhase::Paused,
        };
        let expected_target_paused = match kind {
            PlayerAuthorityCommandKind::Gameplay => false,
            PlayerAuthorityCommandKind::PauseLifecycle { target_paused, .. } => target_paused,
        };
        let expected_source_paused = match kind {
            PlayerAuthorityCommandKind::Gameplay => false,
            PlayerAuthorityCommandKind::PauseLifecycle { target_paused, .. } => !target_paused,
        };
        let duplicate_lifecycle_ack = kind.is_pause_lifecycle()
            && initial.pending_command.is_none()
            && initial.acknowledged.last_player_command_id.as_deref()
                == Some(request.command_id.as_str())
            && initial.phase
                == if expected_target_paused {
                    crate::exact_realtime_lease::ExactRealtimeLeasePhase::Paused
                } else {
                    crate::exact_realtime_lease::ExactRealtimeLeasePhase::Active
                };
        if initial.purpose()? != ExactRealtimeLeasePurpose::PlayerAuthority
            || initial.authority_session_id.as_deref() != Some(authority_session_id.as_str())
            || initial.run_id != request.run_id
            || (!duplicate_lifecycle_ack && initial.phase != expected_source_phase)
        {
            bail!("native player-authority command lease session/run identity conflicts");
        }

        let initial_summary = self.status(session_id)?;
        let initial_state = self.session(session_id)?;
        if initial_state.identity.slot != "normal-main"
            || initial_state.identity.mode != "normal"
            || initial_state.identity.state_version != 47
            || initial_state.identity.registry_fingerprint != initial.registry_fingerprint
            || initial_summary.mode != "normal"
            || initial_summary.state_version != 47
            || initial_summary.registry_fingerprint != initial.registry_fingerprint
            || if duplicate_lifecycle_ack {
                initial_summary.paused != expected_target_paused
            } else if initial.pending_command.is_some() {
                initial_summary.paused != expected_source_paused
                    && initial_summary.paused != expected_target_paused
            } else {
                initial_summary.paused != expected_source_paused
            }
        {
            bail!("native player-authority command state/lease lifecycle conflicts");
        }

        if initial.pending_tick.is_some() {
            bail!("native player-authority tick is pending before gameplay command");
        }
        if initial.pending_advance.is_some() || initial.macro_session.is_some() {
            bail!("native player-authority macro session must finish before gameplay command");
        }
        if initial.pending_command.is_none()
            && initial.acknowledged.last_player_command_id.as_deref()
                == Some(request.command_id.as_str())
        {
            if initial.acknowledged.command_base_revision != Some(request.base_revision)
                || initial.acknowledged.command_request_sha256.as_deref()
                    != Some(request_sha256.as_str())
                || initial.acknowledged.command_id.as_deref() != Some(request.command_id.as_str())
                || initial.acknowledged.revision != request.base_revision + 1
            {
                bail!("native player-authority replayed command ID is already closed or conflicts");
            }
            if initial_summary.revision != initial.acknowledged.revision
                || initial_summary.canonical_sha256 != initial.acknowledged.proof.canonical_sha256
                || initial_summary.domain_sha256 != initial.acknowledged.proof.domain_sha256
            {
                bail!("native player-authority duplicate command conflicts with its durable ACK");
            }
            let latest = store
                .latest_published_checkpoint_identity("normal-main")?
                .ok_or_else(|| anyhow!("normal-main published checkpoint is missing"))?;
            let checkpoint = initial.acknowledged.checkpoint.clone();
            if latest.generation != checkpoint.generation
                || latest.root_hash != checkpoint.root_hash
                || latest.revision != checkpoint.revision
                || latest.mode != "normal"
                || latest.state_version != 47
                || latest.registry_fingerprint != initial.registry_fingerprint
                || initial_state.identity.generation != checkpoint.generation
                || initial_state.identity.root_hash != checkpoint.root_hash
                || initial_state.identity.revision != checkpoint.revision
            {
                bail!("native player-authority duplicate command checkpoint is no longer current");
            }
            let changes = store.read_player_authority_command_change_receipt(&initial)?;
            return Ok(CoreCommitPlayerAuthorityCommandResult {
                sequence: initial.acknowledged.sequence,
                command_id: request.command_id,
                base_revision: request.base_revision,
                revision: initial_summary.revision,
                settled_deadline_ms: initial.acknowledged.settled_deadline_ms,
                checkpoint,
                changed_entity_ids: changes.changed_entity_ids,
                changed_belt_ids: changes.changed_belt_ids,
                topology_dirty: changes.topology_dirty,
                summary: initial_summary,
                duplicate: true,
            });
        }

        let resumed = initial.pending_command.is_some();
        if let Some(pending) = initial.pending_command.as_ref() {
            if pending.command_id != request.command_id
                || pending.base_revision != request.base_revision
                || pending.request_sha256 != request_sha256
                || !json_values_bitwise_equal(&pending.command, &command_value)
                || !matches!(
                    initial_summary.revision,
                    revision
                        if revision == pending.base_revision
                            || revision == pending.expected_revision
                )
            {
                bail!("native player-authority pending command conflicts with the request");
            }
        } else if request.base_revision != initial.acknowledged.revision {
            bail!("native player-authority command base revision is not current");
        }

        let command_changes = if initial.pending_command.is_none()
            || initial_summary.revision == request.base_revision
        {
            let mut preflight = self.session(session_id)?.clone();
            let applied = match kind {
                PlayerAuthorityCommandKind::Gameplay => {
                    preflight.apply_player_authority_command(&request.command)?
                }
                PlayerAuthorityCommandKind::PauseLifecycle { .. } => {
                    preflight.apply_player_authority_pause_transition(&request.command)?
                }
            };
            if applied.previous_revision != request.base_revision
                || applied.revision != request.base_revision + 1
            {
                bail!("native player-authority command preflight revision is invalid")
            }
            applied
        } else {
            self.session(session_id)?
                .deterministic_player_authority_resume_result(
                    &request.command,
                    request.base_revision,
                    request.base_revision.checked_add(1).ok_or_else(|| {
                        anyhow!("native player-authority command revision is exhausted")
                    })?,
                )?
        };

        let staged = match kind {
            PlayerAuthorityCommandKind::Gameplay => store.stage_player_authority_command(
                &authority_session_id,
                &request.run_id,
                &request.command_id,
                request.base_revision,
                command_value,
            )?,
            PlayerAuthorityCommandKind::PauseLifecycle {
                target_paused,
                settled_deadline_ms,
            } => store.stage_player_authority_pause_transition(
                &authority_session_id,
                &request.run_id,
                request.base_revision,
                target_paused,
                settled_deadline_ms,
            )?,
        };
        after_durable_boundary()?;
        let pending = staged
            .pending_command
            .as_ref()
            .ok_or_else(|| anyhow!("native player-authority staged command is missing"))?
            .clone();
        let published_before_commit = store
            .latest_published_checkpoint_identity("normal-main")?
            .ok_or_else(|| anyhow!("normal-main published checkpoint is missing"))?;
        let state_before_commit = self.session(session_id)?;
        let checkpoint_already_published = published_before_commit.revision
            == pending.expected_revision
            && state_before_commit.identity.generation == published_before_commit.generation
            && state_before_commit.identity.root_hash == published_before_commit.root_hash
            && state_before_commit.identity.revision == published_before_commit.revision
            && state_before_commit.revision == pending.expected_revision;
        let committed_duplicate = if checkpoint_already_published {
            true
        } else {
            let operation = CoreCommitOperationRequest {
                command_id: pending.command_id.clone(),
                base_revision: pending.base_revision,
                command: Some(request.command),
                simulation_seconds: 0.0,
                wall_seconds: 0.0,
                advance_mode: CoreAdvanceMode::Exact,
                include_diagnostics: true,
            };
            let committed = self.commit_operation_internal(
                store,
                session_id,
                operation,
                Some(CoreLeaseAuthorization::PlayerAuthority {
                    lease: staged.clone(),
                    authority_session_id: authority_session_id.clone(),
                    pause_lifecycle: kind.is_pause_lifecycle(),
                }),
            )?;
            if committed.revision != pending.expected_revision
                || committed.current_revision != pending.expected_revision
            {
                bail!("native player-authority command WAL differs from the pending command");
            }
            committed.duplicate
        };
        after_durable_boundary()?;

        let summary = self.status(session_id)?;
        if summary.revision != pending.expected_revision {
            bail!("native player-authority command state differs from its durable WAL");
        }
        let latest = store
            .latest_published_checkpoint_identity("normal-main")?
            .ok_or_else(|| anyhow!("normal-main published checkpoint is missing"))?;
        if latest.mode != "normal"
            || latest.state_version != 47
            || latest.registry_fingerprint != staged.registry_fingerprint
        {
            bail!("native player-authority command publication identity changed");
        }
        let (checkpoint, checkpoint_reused) = if latest.revision == pending.expected_revision {
            let state = self.session(session_id)?;
            if state.identity.generation != latest.generation
                || state.identity.root_hash != latest.root_hash
                || state.identity.revision != latest.revision
            {
                bail!("native player-authority session is not based on its command checkpoint");
            }
            (
                ExactRealtimeCheckpoint {
                    generation: latest.generation,
                    root_hash: latest.root_hash,
                    revision: latest.revision,
                },
                true,
            )
        } else {
            if latest.revision != pending.base_revision
                || latest.generation != staged.acknowledged.checkpoint.generation
                || latest.root_hash != staged.acknowledged.checkpoint.root_hash
            {
                bail!(
                    "native player-authority command cannot checkpoint across an unproven publication"
                );
            }
            let authorization = CoreLeaseAuthorization::PlayerAuthority {
                lease: staged.clone(),
                authority_session_id: authority_session_id.clone(),
                pause_lifecycle: kind.is_pause_lifecycle(),
            };
            let published = self.checkpoint_internal(
                store,
                session_id,
                pending.settled_deadline_ms,
                Some(&authorization),
            )?;
            if published.checkpoint.slot != "normal-main"
                || published.checkpoint.revision != pending.expected_revision
                || published.summary.revision != pending.expected_revision
                || published.summary.canonical_sha256 != summary.canonical_sha256
                || published.summary.domain_sha256 != summary.domain_sha256
            {
                bail!("native player-authority command checkpoint differs from its durable WAL");
            }
            (
                ExactRealtimeCheckpoint {
                    generation: published.checkpoint.generation,
                    root_hash: published.checkpoint.root_hash,
                    revision: published.checkpoint.revision,
                },
                false,
            )
        };
        after_durable_boundary()?;

        let durable_changes = PlayerAuthorityCommandChangeReceipt {
            command_id: pending.command_id.clone(),
            command_request_sha256: pending.request_sha256.clone(),
            base_revision: pending.base_revision,
            revision: summary.revision,
            sequence: pending.sequence,
            checkpoint: checkpoint.clone(),
            changed_entity_ids: command_changes.changed_entity_ids,
            changed_belt_ids: command_changes.changed_belt_ids,
            topology_dirty: command_changes.topology_dirty,
        };
        store.write_player_authority_command_change_receipt(&staged, &durable_changes)?;
        after_durable_boundary()?;

        let proof = ExactRealtimeStateProof {
            revision: summary.revision,
            canonical_sha256: summary.canonical_sha256.clone(),
            domain_sha256: summary.domain_sha256.clone(),
        };
        let lease = match kind {
            PlayerAuthorityCommandKind::Gameplay => store.acknowledge_player_authority_command(
                &authority_session_id,
                &request.run_id,
                proof,
                checkpoint.clone(),
            )?,
            PlayerAuthorityCommandKind::PauseLifecycle { .. } => store
                .acknowledge_player_authority_pause_transition(
                    &authority_session_id,
                    &request.run_id,
                    proof,
                    checkpoint.clone(),
                )?,
        };
        after_durable_boundary()?;
        if lease.acknowledged.sequence != pending.sequence
            || lease.acknowledged.command_id.as_deref() != Some(pending.command_id.as_str())
            || lease.acknowledged.command_base_revision != Some(pending.base_revision)
            || lease.acknowledged.command_request_sha256.as_deref()
                != Some(pending.request_sha256.as_str())
            || lease.acknowledged.last_player_command_id.as_deref()
                != Some(pending.command_id.as_str())
            || lease.acknowledged.revision != summary.revision
            || lease.pending_command.is_some()
            || lease.pending_advance.is_some()
        {
            bail!("native player-authority lease ACK did not close the command");
        }
        if kind.is_pause_lifecycle()
            && lease.phase
                != if expected_target_paused {
                    crate::exact_realtime_lease::ExactRealtimeLeasePhase::Paused
                } else {
                    crate::exact_realtime_lease::ExactRealtimeLeasePhase::Active
                }
        {
            bail!("native player-authority pause lifecycle ACK phase differs")
        }
        Ok(CoreCommitPlayerAuthorityCommandResult {
            sequence: pending.sequence,
            command_id: pending.command_id,
            base_revision: pending.base_revision,
            revision: summary.revision,
            settled_deadline_ms: pending.settled_deadline_ms,
            checkpoint,
            changed_entity_ids: durable_changes.changed_entity_ids,
            changed_belt_ids: durable_changes.changed_belt_ids,
            topology_dirty: durable_changes.topology_dirty,
            summary,
            duplicate: resumed || committed_duplicate || checkpoint_reused,
        })
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

    pub fn factory_read_model_projection(
        &self,
        session_id: &str,
        selected_entity_ids: &[String],
        selected_belt_ids: &[String],
    ) -> anyhow::Result<Value> {
        self.session(session_id)?
            .factory_read_model_projection(selected_entity_ids, selected_belt_ids)
    }

    pub fn factory_inventory_projection(
        &self,
        session_id: &str,
        expected_revision: u64,
        cursor: usize,
        limit: usize,
    ) -> anyhow::Result<Value> {
        self.session(session_id)?
            .factory_inventory_projection(expected_revision, cursor, limit)
    }

    pub fn construction_inventory_projection(
        &self,
        session_id: &str,
        expected_revision: u64,
        expected_registry_fingerprint: &str,
        cursor: usize,
        limit: usize,
    ) -> anyhow::Result<Value> {
        self.session(session_id)?.construction_inventory_projection(
            expected_revision,
            expected_registry_fingerprint,
            cursor,
            limit,
        )
    }

    pub fn construction_placement_context(
        &self,
        session_id: &str,
        expected_revision: u64,
        expected_registry_fingerprint: &str,
        building_id: &str,
    ) -> anyhow::Result<Value> {
        self.session(session_id)?
            .construction_placement_context_projection(
                expected_revision,
                expected_registry_fingerprint,
                building_id,
            )
    }

    // Keep the internal Host forwarding call field-for-field identical to the
    // bounded protocol variant; no loosely typed options object crosses it.
    #[allow(clippy::too_many_arguments)]
    pub fn construction_belt_placement_context(
        &self,
        session_id: &str,
        expected_revision: u64,
        expected_registry_fingerprint: &str,
        source_id: &str,
        target_id: &str,
        item_id: &str,
        tier: u8,
        lanes: u64,
    ) -> anyhow::Result<Value> {
        self.session(session_id)?
            .construction_belt_placement_context_projection(
                expected_revision,
                expected_registry_fingerprint,
                source_id,
                target_id,
                item_id,
                tier,
                lanes,
            )
    }

    pub fn construction_belt_removal_context(
        &self,
        session_id: &str,
        expected_revision: u64,
        expected_registry_fingerprint: &str,
        belt_id: &str,
    ) -> anyhow::Result<Value> {
        self.session(session_id)?
            .construction_belt_removal_context_projection(
                expected_revision,
                expected_registry_fingerprint,
                belt_id,
            )
    }

    pub fn construction_belt_lane_context(
        &self,
        session_id: &str,
        expected_revision: u64,
        expected_registry_fingerprint: &str,
        belt_id: &str,
        target_lanes: u64,
    ) -> anyhow::Result<Value> {
        self.session(session_id)?
            .construction_belt_lane_context_projection(
                expected_revision,
                expected_registry_fingerprint,
                belt_id,
                target_lanes,
            )
    }

    pub fn construction_removal_context(
        &self,
        session_id: &str,
        expected_revision: u64,
        expected_registry_fingerprint: &str,
        entity_id: &str,
    ) -> anyhow::Result<Value> {
        self.session(session_id)?
            .construction_removal_context_projection(
                expected_revision,
                expected_registry_fingerprint,
                entity_id,
            )
    }

    pub fn construction_stack_context(
        &self,
        session_id: &str,
        expected_revision: u64,
        expected_registry_fingerprint: &str,
        entity_id: &str,
        target_count: u64,
    ) -> anyhow::Result<Value> {
        self.session(session_id)?
            .construction_stack_context_projection(
                session_id,
                expected_revision,
                expected_registry_fingerprint,
                entity_id,
                target_count,
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

    pub fn technology_projection(&self, session_id: &str) -> anyhow::Result<Value> {
        self.session(session_id)?.technology_projection()
    }

    #[allow(clippy::too_many_arguments)]
    pub fn recipe_workspace_projection(
        &self,
        session_id: &str,
        expected_registry_fingerprint: &str,
        item_ids: &[String],
        selected_item_id: &str,
        location_planet_id: Option<&str>,
        location_cursor: usize,
        location_limit: usize,
    ) -> anyhow::Result<Value> {
        self.session(session_id)?.recipe_workspace_projection(
            expected_registry_fingerprint,
            item_ids,
            selected_item_id,
            location_planet_id,
            location_cursor,
            location_limit,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn command_palette_entity_search_projection(
        &self,
        session_id: &str,
        expected_revision: u64,
        expected_registry_fingerprint: &str,
        query: &str,
        cursor: usize,
        limit: usize,
        building_ids: &[String],
        resource_ids: &[String],
        planet_ids: &[String],
    ) -> anyhow::Result<Value> {
        if command_palette_search_request_bytes(
            session_id,
            expected_revision,
            expected_registry_fingerprint,
            query,
            cursor,
            limit,
            building_ids,
            resource_ids,
            planet_ids,
        )? > MAX_COMMAND_PALETTE_SEARCH_REQUEST_BYTES
        {
            bail!("native command palette entity-search request exceeds the IPC byte limit");
        }
        self.session(session_id)?
            .command_palette_entity_search_projection(
                expected_revision,
                expected_registry_fingerprint,
                query,
                cursor,
                limit,
                building_ids,
                resource_ids,
                planet_ids,
            )
    }

    pub fn star_map_overview_projection(
        &self,
        session_id: &str,
        expected_revision: u64,
        expected_registry_fingerprint: &str,
        cursor: usize,
        limit: usize,
    ) -> anyhow::Result<Value> {
        self.session(session_id)?.star_map_overview_projection(
            expected_revision,
            expected_registry_fingerprint,
            cursor,
            limit,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn star_map_catalog_projection(
        &self,
        session_id: &str,
        expected_revision: u64,
        expected_registry_fingerprint: &str,
        system_cursor: usize,
        system_limit: usize,
        planet_cursor: usize,
        planet_limit: usize,
    ) -> anyhow::Result<Value> {
        self.session(session_id)?.star_map_catalog_projection(
            expected_revision,
            expected_registry_fingerprint,
            system_cursor,
            system_limit,
            planet_cursor,
            planet_limit,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn stellar_industry_projection(
        &self,
        session_id: &str,
        expected_revision: u64,
        expected_registry_fingerprint: &str,
        system_id: Option<&str>,
        planet_id: Option<&str>,
        planet_cursor: usize,
        planet_limit: usize,
        station_cursor: usize,
        station_limit: usize,
    ) -> anyhow::Result<Value> {
        self.session(session_id)?.stellar_industry_projection(
            expected_revision,
            expected_registry_fingerprint,
            system_id,
            planet_id,
            planet_cursor,
            planet_limit,
            station_cursor,
            station_limit,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn stellar_industry_v2_projection(
        &self,
        session_id: &str,
        expected_revision: u64,
        expected_registry_fingerprint: &str,
        system_id: Option<&str>,
        planet_id: Option<&str>,
        planet_cursor: usize,
        planet_limit: usize,
        station_cursor: usize,
        station_limit: usize,
        route_cursor: usize,
        route_limit: usize,
        route_filter: &str,
        query: &str,
    ) -> anyhow::Result<Value> {
        self.session(session_id)?.stellar_industry_v2_projection(
            expected_revision,
            expected_registry_fingerprint,
            system_id,
            planet_id,
            planet_cursor,
            planet_limit,
            station_cursor,
            station_limit,
            route_cursor,
            route_limit,
            route_filter,
            query,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn stellar_quantum_projection(
        &self,
        session_id: &str,
        expected_revision: u64,
        expected_registry_fingerprint: &str,
        item_cursor: usize,
        item_limit: usize,
        collector_cursor: usize,
        collector_limit: usize,
    ) -> anyhow::Result<Value> {
        self.session(session_id)?.stellar_quantum_projection(
            expected_revision,
            expected_registry_fingerprint,
            item_cursor,
            item_limit,
            collector_cursor,
            collector_limit,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn dyson_workspace_projection(
        &self,
        session_id: &str,
        expected_revision: u64,
        expected_registry_fingerprint: &str,
        selected_system_id: &str,
        system_cursor: usize,
        system_limit: usize,
        layer_cursor: usize,
        layer_limit: usize,
        orbit_cursor: usize,
        orbit_limit: usize,
        node_cursor: usize,
        node_limit: usize,
        frame_cursor: usize,
        frame_limit: usize,
        shell_cursor: usize,
        shell_limit: usize,
    ) -> anyhow::Result<Value> {
        self.session(session_id)?.dyson_workspace_projection(
            expected_revision,
            expected_registry_fingerprint,
            selected_system_id,
            system_cursor,
            system_limit,
            layer_cursor,
            layer_limit,
            orbit_cursor,
            orbit_limit,
            node_cursor,
            node_limit,
            frame_cursor,
            frame_limit,
            shell_cursor,
            shell_limit,
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
        self.commit_operation_internal(
            store,
            session_id,
            operation,
            Some(CoreLeaseAuthorization::Experiment(lease)),
        )
    }

    fn commit_operation_internal(
        &mut self,
        store: &SaveStore,
        session_id: &str,
        request: CoreCommitOperationRequest,
        lease_authorization: Option<CoreLeaseAuthorization>,
    ) -> anyhow::Result<CoreCommitOperationResult> {
        self.commit_operation_internal_with_prepared(
            store,
            session_id,
            request,
            lease_authorization,
            None,
        )
    }

    fn commit_operation_internal_with_prepared(
        &mut self,
        store: &SaveStore,
        session_id: &str,
        request: CoreCommitOperationRequest,
        lease_authorization: Option<CoreLeaseAuthorization>,
        prepared_state: Option<CoreState>,
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
        if let Some(authorization) = lease_authorization.as_ref() {
            require_authorized_operation_matches_pending(authorization.lease(), &request)?;
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
                lease_authorization
                    .as_ref()
                    .map(CoreLeaseAuthorization::lease),
                operation.result_revision,
            )?;
            if current_revision < operation.result_revision {
                if current_revision != operation.base_revision {
                    bail!("native authoritative retry cannot prove revision continuity");
                }
                let state = self.session_mut(session_id)?;
                if let Some(CoreLeaseAuthorization::PlayerAuthority {
                    pause_lifecycle, ..
                }) = lease_authorization.as_ref()
                    && let Some(command) = operation.command.as_ref()
                {
                    if *pause_lifecycle {
                        let mut probe = state.clone();
                        probe.apply_player_authority_pause_transition(command)?;
                    } else {
                        state.validate_player_authority_command(command)?;
                    }
                }
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
            let receipt = match lease_authorization.as_ref() {
                Some(CoreLeaseAuthorization::Experiment(lease)) => store
                    .append_wal_idempotent_exact_realtime(
                        lease,
                        &slot,
                        operation.base_revision,
                        operation.result_revision,
                        &request.command_id,
                        existing.payload,
                    )?,
                Some(CoreLeaseAuthorization::PlayerAuthority {
                    lease,
                    authority_session_id,
                    ..
                }) => store.append_wal_idempotent_player_authority(
                    lease,
                    authority_session_id,
                    &slot,
                    operation.base_revision,
                    operation.result_revision,
                    &request.command_id,
                    existing.payload,
                )?,
                None => store.append_wal_idempotent(
                    &slot,
                    operation.base_revision,
                    operation.result_revision,
                    &request.command_id,
                    existing.payload,
                )?,
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
        let prepared = match prepared_state {
            Some(prepared) => {
                if request.command.is_some()
                    || prepared.identity.slot != slot
                    || prepared.identity.registry_fingerprint != fingerprint
                    || prepared.revision <= request.base_revision
                {
                    bail!("native authoritative prepared candidate identity conflicts")
                }
                prepared
            }
            None => {
                let mut prepared = self.session(session_id)?.clone();
                if let Some(command) = request.command.as_ref() {
                    match lease_authorization.as_ref() {
                        Some(CoreLeaseAuthorization::PlayerAuthority {
                            pause_lifecycle: true,
                            ..
                        }) => {
                            prepared.apply_player_authority_pause_transition(command)?;
                        }
                        Some(CoreLeaseAuthorization::PlayerAuthority { .. }) => {
                            prepared.apply_player_authority_command(command)?;
                        }
                        _ => {
                            prepared.apply_command(command)?;
                        }
                    }
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
                prepared
            }
        };
        if prepared.revision <= request.base_revision {
            bail!("native authoritative operation made no revision progress");
        }
        let result_revision = prepared.revision;
        require_exact_realtime_result_revision(
            lease_authorization
                .as_ref()
                .map(CoreLeaseAuthorization::lease),
            result_revision,
        )?;
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
        let receipt = match lease_authorization.as_ref() {
            Some(CoreLeaseAuthorization::Experiment(lease)) => store
                .append_wal_idempotent_exact_realtime(
                    lease,
                    &slot,
                    request.base_revision,
                    result_revision,
                    &request.command_id,
                    payload,
                )?,
            Some(CoreLeaseAuthorization::PlayerAuthority {
                lease,
                authority_session_id,
                ..
            }) => store.append_wal_idempotent_player_authority(
                lease,
                authority_session_id,
                &slot,
                request.base_revision,
                result_revision,
                &request.command_id,
                payload,
            )?,
            None => store.append_wal_idempotent(
                &slot,
                request.base_revision,
                result_revision,
                &request.command_id,
                payload,
            )?,
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
        lease_authorization: Option<&CoreLeaseAuthorization>,
    ) -> anyhow::Result<CoreCheckpointResult> {
        self.checkpoint_internal_with_commit(
            store,
            session_id,
            saved_at_ms,
            lease_authorization,
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
        lease_authorization: Option<&CoreLeaseAuthorization>,
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
        let begin = match lease_authorization {
            Some(CoreLeaseAuthorization::Experiment(lease)) => store
                .begin_exact_realtime_checkpoint(
                    &slot,
                    &mode,
                    state_version,
                    &base_checksum,
                    &fingerprint,
                    revision,
                    saved_at_ms,
                    lease,
                )?,
            Some(CoreLeaseAuthorization::PlayerAuthority {
                lease,
                authority_session_id,
                ..
            }) => store.begin_player_authority_checkpoint(
                &slot,
                &mode,
                state_version,
                &base_checksum,
                &fingerprint,
                revision,
                saved_at_ms,
                lease,
                authority_session_id,
            )?,
            None => store.begin(
                &slot,
                &mode,
                state_version,
                &base_checksum,
                &fingerprint,
                revision,
                saved_at_ms,
            )?,
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
            let authorization = CoreLeaseAuthorization::Experiment(current.clone());
            let published = self.checkpoint_internal(
                store,
                session_id,
                request.settled_deadline_ms,
                Some(&authorization),
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
            let authorization = CoreLeaseAuthorization::Experiment(current.clone());
            let published = self.checkpoint_internal(
                store,
                session_id,
                request.saved_at_ms,
                Some(&authorization),
            )?;
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
        if self
            .player_authority_startup_recovery
            .as_ref()
            .is_some_and(|receipt| receipt.session_id == session_id)
        {
            self.player_authority_startup_recovery = None;
        }
        Ok(self.sessions.remove(session_id).is_some())
    }

    pub fn close_all(&mut self) {
        self.uncertain_checkpoint_transactions.clear();
        self.player_authority_startup_recovery = None;
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

    const EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT: &str = "7df8cf3a";

    #[test]
    fn command_palette_host_request_byte_accounting_includes_the_full_envelope() {
        assert!(
            command_palette_search_request_bytes(
                "core-1",
                7,
                "builtin:test",
                "熔炉",
                0,
                16,
                &["smelter".to_owned()],
                &[],
                &[],
            )
            .unwrap()
                <= MAX_COMMAND_PALETTE_SEARCH_REQUEST_BYTES
        );
        let oversized = (0..205)
            .map(|index| format!("mod_{index:03}_{}", "x".repeat(150)))
            .collect::<Vec<_>>();
        assert!(
            command_palette_search_request_bytes(
                &"s".repeat(128),
                u64::MAX,
                &"f".repeat(256),
                "mod",
                0,
                16,
                &oversized,
                &[],
                &[],
            )
            .unwrap()
                > MAX_COMMAND_PALETTE_SEARCH_REQUEST_BYTES
        );
    }

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
            "items": [
                { "id": "iron_ore", "name": "iron_ore", "kind": "solid" },
                { "id": "iron_ingot", "name": "iron_ingot", "kind": "solid" }
            ],
            "buildings": [
                {
                    "id": "mining_machine",
                    "kind": "miner",
                    "speed": 1,
                    "inputCapacity": 0,
                    "outputCapacity": 50,
                    "powerDemandKw": 1,
                    "powerGenerationKw": 0,
                },
                {
                    "id": "arc_smelter",
                    "kind": "machine",
                    "speed": 1,
                    "inputCapacity": 100,
                    "outputCapacity": 100,
                    "powerDemandKw": 1,
                    "powerGenerationKw": 0,
                }
            ],
            "recipes": [{
                "id": "iron_ingot",
                "buildingId": "arc_smelter",
                "duration": 1,
                "inputs": [{ "itemId": "iron_ore", "amount": 1 }],
                "outputs": [{ "itemId": "iron_ingot", "amount": 1 }]
            }],
            "constructions": [
                {
                    "id": "arc_smelter",
                    "outputAmount": 1,
                    "costs": [{ "itemId": "iron_ingot", "amount": 1 }]
                },
                {
                    "id": "conveyor_belt_mk1",
                    "outputAmount": 3,
                    "costs": [{ "itemId": "iron_ingot", "amount": 1 }]
                }
            ],
            "belts": [{ "tier": 1, "speed": 6 }],
            "proliferators": [],
            "technologies": [],
        })
    }

    fn player_authority_catalog() -> Value {
        let mut catalog = import_catalog();
        catalog["registryFingerprint"] = Value::from(EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT);
        catalog
    }

    fn player_authority_fuel_catalog() -> Value {
        let mut catalog = player_authority_catalog();
        catalog["items"].as_array_mut().unwrap().extend([
            json!({ "id": "coal", "name": "coal", "kind": "solid", "fuelEnergyMj": 2.7 }),
            json!({ "id": "fire_ice", "name": "fire_ice", "kind": "solid", "fuelEnergyMj": 4.8 }),
            json!({ "id": "crude_oil", "name": "crude_oil", "kind": "fluid", "fuelEnergyMj": 4.0 }),
            json!({ "id": "energetic_graphite", "name": "energetic_graphite", "kind": "solid", "fuelEnergyMj": 6.3 }),
            json!({ "id": "refined_oil", "name": "refined_oil", "kind": "fluid", "fuelEnergyMj": 4.4 }),
            json!({ "id": "hydrogen", "name": "hydrogen", "kind": "fluid", "fuelEnergyMj": 8.0 }),
            json!({ "id": "hydrogen_fuel_rod", "name": "hydrogen_fuel_rod", "kind": "solid", "fuelEnergyMj": 54.0 }),
            json!({ "id": "deuteron_fuel_rod", "name": "deuteron_fuel_rod", "kind": "solid", "fuelEnergyMj": 600.0 }),
            json!({ "id": "antimatter_fuel_rod", "name": "antimatter_fuel_rod", "kind": "solid", "fuelEnergyMj": 7_200.0 }),
            json!({ "id": "logistics_drone", "name": "logistics_drone", "kind": "solid" }),
        ]);
        catalog["buildings"].as_array_mut().unwrap().push(json!({
            "id": "thermal_power_plant",
            "kind": "power",
            "speed": 1,
            "inputCapacity": 120,
            "outputCapacity": 0,
            "powerGenerationKw": 2_160,
            "fuelItemIds": [
                "coal",
                "fire_ice",
                "crude_oil",
                "energetic_graphite",
                "refined_oil",
                "hydrogen",
                "hydrogen_fuel_rod",
                "deuteron_fuel_rod",
                "antimatter_fuel_rod"
            ],
            "fuelEfficiency": 0.8
        }));
        catalog["recipes"].as_array_mut().unwrap().push(json!({
            "id": "energetic_graphite",
            "buildingId": "arc_smelter",
            "duration": 2,
            "requiredTechId": "energy_matrix",
            "inputs": [{ "itemId": "coal", "amount": 2 }],
            "outputs": [{ "itemId": "energetic_graphite", "amount": 1 }]
        }));
        catalog["constructions"]
            .as_array_mut()
            .unwrap()
            .push(json!({
                "id": "thermal_power_plant",
                "outputAmount": 1,
                "requiredTechId": "thermal_power",
                "costs": [{ "itemId": "iron_ingot", "amount": 1 }]
            }));
        catalog["technologies"].as_array_mut().unwrap().extend([
            json!({
                "id": "thermal_power",
                "costs": [{ "itemId": "iron_ingot", "amount": 1 }],
                "prerequisites": []
            }),
            json!({
                "id": "energy_matrix",
                "costs": [{ "itemId": "iron_ingot", "amount": 1 }],
                "prerequisites": ["thermal_power"]
            }),
        ]);
        catalog
    }

    fn player_authority_station_inventory_catalog() -> Value {
        let mut catalog = player_authority_catalog();
        catalog["items"].as_array_mut().unwrap().extend([
            json!({ "id": "logistics_drone", "name": "logistics_drone", "kind": "solid" }),
            json!({ "id": "logistics_vessel", "name": "logistics_vessel", "kind": "solid" }),
            json!({ "id": "space_warper", "name": "space_warper", "kind": "solid" }),
        ]);
        catalog["buildings"].as_array_mut().unwrap().extend([
            json!({
                "id": "planetary_logistics_station",
                "kind": "station",
                "speed": 1,
                "inputCapacity": 100,
                "outputCapacity": 100,
                "powerDemandKw": 1,
                "powerGenerationKw": 0
            }),
            json!({
                "id": "interstellar_logistics_station",
                "kind": "station",
                "speed": 1,
                "inputCapacity": 100,
                "outputCapacity": 100,
                "powerDemandKw": 1,
                "powerGenerationKw": 0
            }),
        ]);
        catalog["technologies"].as_array_mut().unwrap().push(json!({
            "id": "space_warp",
            "costs": [{ "itemId": "iron_ingot", "amount": 1 }],
            "prerequisites": []
        }));
        catalog
    }

    fn player_authority_construction_automation_catalog() -> Value {
        let mut catalog = player_authority_catalog();
        catalog["planets"].as_array_mut().unwrap().push(json!({
            "id": "ashen",
            "name": "ashen",
            "systemId": "sigma",
            "kind": "terrestrial",
            "orbitIndex": 1,
            "simulationOrder": 1,
            "orbitalYields": {}
        }));
        catalog["items"].as_array_mut().unwrap().extend([
            json!({ "id": "logistics_drone", "name": "logistics_drone", "kind": "solid" }),
            json!({ "id": "logistics_vessel", "name": "logistics_vessel", "kind": "solid" }),
            json!({ "id": "space_warper", "name": "space_warper", "kind": "solid" }),
        ]);
        catalog["buildings"].as_array_mut().unwrap().extend([
            json!({
                "id": "construction_center",
                "kind": "machine",
                "speed": 1,
                "inputCapacity": 100000000,
                "outputCapacity": 100000000
            }),
            json!({
                "id": "orbital_cargo_terminal",
                "kind": "storage",
                "speed": 1,
                "inputCapacity": 100000000,
                "outputCapacity": 100000000
            }),
        ]);
        catalog["recipes"].as_array_mut().unwrap().extend([
            json!({
                "id": "logistics_drone",
                "buildingId": "arc_smelter",
                "duration": 4,
                "requiredTechId": "planetary_logistics",
                "inputs": [{ "itemId": "iron_ingot", "amount": 1 }],
                "outputs": [{ "itemId": "logistics_drone", "amount": 1 }]
            }),
            json!({
                "id": "logistics_vessel",
                "buildingId": "arc_smelter",
                "duration": 8,
                "requiredTechId": "interstellar_logistics",
                "inputs": [{ "itemId": "iron_ingot", "amount": 1 }],
                "outputs": [{ "itemId": "logistics_vessel", "amount": 1 }]
            }),
        ]);
        catalog["constructions"].as_array_mut().unwrap().extend([
            json!({
                "id": "construction_center",
                "outputAmount": 1,
                "requiredTechId": "construction_automation",
                "costs": [{ "itemId": "iron_ingot", "amount": 1 }]
            }),
            json!({
                "id": "orbital_cargo_terminal",
                "outputAmount": 1,
                "requiredTechId": "universe_matrix",
                "costs": [{ "itemId": "iron_ingot", "amount": 1 }]
            }),
        ]);
        catalog["technologies"].as_array_mut().unwrap().extend([
            json!({
                "id": "construction_automation",
                "costs": [{ "itemId": "iron_ingot", "amount": 1 }],
                "prerequisites": []
            }),
            json!({
                "id": "construction_capacity_1",
                "costs": [{ "itemId": "iron_ingot", "amount": 1 }],
                "prerequisites": ["construction_automation"]
            }),
            json!({
                "id": "construction_capacity_2",
                "costs": [{ "itemId": "iron_ingot", "amount": 1 }],
                "prerequisites": ["construction_capacity_1"]
            }),
            json!({
                "id": "quantum_logistics_network",
                "costs": [{ "itemId": "iron_ingot", "amount": 1 }],
                "prerequisites": ["construction_automation"]
            }),
            json!({
                "id": "planetary_logistics",
                "costs": [{ "itemId": "iron_ingot", "amount": 1 }],
                "prerequisites": []
            }),
            json!({
                "id": "interstellar_logistics",
                "costs": [{ "itemId": "iron_ingot", "amount": 1 }],
                "prerequisites": ["planetary_logistics"]
            }),
            json!({
                "id": "universe_matrix",
                "costs": [{ "itemId": "iron_ingot", "amount": 1 }],
                "prerequisites": []
            }),
        ]);
        catalog
    }

    fn player_authority_macro_catalog() -> Value {
        let mut catalog = player_authority_catalog();
        catalog["buildings"].as_array_mut().unwrap().extend([
            json!({
                "id": "wind_turbine",
                "kind": "power",
                "speed": 1,
                "inputCapacity": 0,
                "outputCapacity": 0,
                "powerDemandKw": 0,
                "powerGenerationKw": 1_000_000_000_000_000_000_u64,
            }),
            json!({
                "id": "time_warp_device",
                "kind": "machine",
                "speed": 1,
                "inputCapacity": 0,
                "outputCapacity": 0,
                "powerDemandKw": 0,
                "powerGenerationKw": 0,
            }),
        ]);
        catalog
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
        let mut plans = serde_json::Map::new();
        let mut active_orbits = serde_json::Map::new();
        let mut orbits = serde_json::Map::new();
        let mut absorption = serde_json::Map::new();
        for system in [
            "helios",
            "borealis",
            "aurora",
            "ember",
            "sirius",
            "white_dwarf",
            "neutron",
            "blue_giant",
        ] {
            let orbit_id = format!("test-orbit-{system}");
            plans.insert(
                system.to_owned(),
                json!({
                    "systemId": system,
                    "activeLayerId": null,
                    "structurePoints": 0,
                    "shellSails": 0,
                    "layers": []
                }),
            );
            active_orbits.insert(system.to_owned(), Value::from(orbit_id.clone()));
            orbits.insert(
                system.to_owned(),
                json!([{
                    "id": orbit_id,
                    "name": "test",
                    "radius": 12000,
                    "inclination": 0,
                    "longitude": 0,
                    "sailsInOrbit": 0,
                    "totalLaunched": 0,
                    "totalExpired": 0,
                    "decayProgress": 0,
                    "generationKw": 0
                }]),
            );
            absorption.insert(system.to_owned(), Value::from(0));
        }
        let endgame = json!({
            "activeInfiniteResearchId": null,
            "autoResearch": false,
            "autoDispatch": false,
            "dispatchThrottle": 1,
            "exportInputMode": "building",
            "exportProjects": {
                "universe_archive": { "enabled": false, "priority": 1, "level": 0, "delivered": 0, "totalDelivered": 0, "dispatchProgress": 0 },
                "solar_sail_array": { "enabled": false, "priority": 1, "level": 0, "delivered": 0, "totalDelivered": 0, "dispatchProgress": 0 },
                "carrier_rocket_fleet": { "enabled": false, "priority": 1, "level": 0, "delivered": 0, "totalDelivered": 0, "dispatchProgress": 0 },
                "antimatter_exchange": { "enabled": false, "priority": 1, "level": 0, "delivered": 0, "totalDelivered": 0, "dispatchProgress": 0 }
            },
            "galacticCredits": 0,
            "galacticScore": 0,
            "totalExported": 0,
            "exportedLastMinute": 0,
            "exportWindowAmount": 0,
            "exportWindowStartedAt": 0,
            "infiniteResearch": {
                "matrix_compression": { "level": 0, "progress": "0" },
                "vein_utilization": { "level": 0, "progress": "0" },
                "galactic_logistics": { "level": 0, "progress": "0" },
                "stellar_harnessing": { "level": 0, "progress": "0" },
                "continuum_simulation": { "level": 0, "progress": "0" }
            },
            "constructionActivity": { "activityId": null, "activityClockMs": 0 }
        });
        let mut state = serde_json::Map::new();
        for (key, value) in [
            ("version", json!(47)),
            ("mode", json!("normal")),
            ("activePlanetId", json!("home")),
            ("elapsedSeconds", json!(2)),
            ("historyRecordedAt", json!(0)),
            ("productionHistory", json!([])),
            ("paused", json!(false)),
            ("manualMined", json!(0)),
            ("totalProduced", json!({})),
            ("blueprints", json!([])),
            ("blueprintVersions", json!([])),
            ("handcraftQueue", json!([])),
            ("constructionQueue", json!([])),
            ("systemSpaceStations", json!({})),
            ("tray", json!({})),
            ("belts", json!([])),
            ("nextId", json!(9)),
            (
                "recipeFocus",
                json!({
                    "itemId": null,
                    "mode": "two-level",
                    "position": { "x": 24, "y": 72 }
                }),
            ),
            (
                "planetViewports",
                json!({
                    "home": { "x": 510, "y": 250, "zoom": 0.84 }
                }),
            ),
        ] {
            state.insert(key.to_owned(), value);
        }
        state.insert(
            "settings".to_owned(),
            json!({
                "simulationSpeed": 1,
                "resourceMode": "infinite",
                "difficulty": "standard",
                "productionBufferLimit": 1000000,
                "logisticsBufferLimit": 1000000,
                "beltBufferLimit": 100000000,
                "proliferatorBufferLimit": 600,
                "defaultBeltStackSize": 1,
                "defaultBeltRouteMode": "auto"
            }),
        );
        for (key, value) in [
            ("planetTrays", json!({ "home": {} })),
            ("planetTrayItemLimits", json!({ "home": 1000000 })),
            (
                "portableFleet",
                json!({ "logistics_drone": 0, "logistics_vessel": 0 }),
            ),
            (
                "construction",
                json!({ "mining_machine": 0, "conveyor_belt_mk1": 4, "arc_smelter": 2 }),
            ),
            ("planetMetrics", json!({ "home": {} })),
            ("powerGridMetrics", json!({ "home": {} })),
        ] {
            state.insert(key.to_owned(), value);
        }
        state.insert(
            "research".to_owned(),
            json!({
                "selectedTechId": null,
                "pausedTechId": null,
                "queuedTechIds": [],
                "progressByTech": {},
                "completedTechIds": []
            }),
        );
        state.insert(
            "campaign".to_owned(),
            json!({
                "completedTaskIds": [],
                "rewardedTaskIds": [],
                "activeTaskId": "mine_first_ore",
                "activeChapterId": "foundation"
            }),
        );
        state.insert(
            "constructionAutomation".to_owned(),
            json!({
                "enabled": false,
                "jobs": {},
                "targetStock": {},
                "cursor": 0,
                "totalCrafted": 0,
                "lastCraftedId": null,
                "destroyedByproducts": {}
            }),
        );
        state.insert(
            "exploration".to_owned(),
            json!({
                "missions": [],
                "unlockedSystemIds": ["helios"],
                "colonizedPlanetIds": ["home"],
                "surveyProgressBySystem": { "helios": 1 }
            }),
        );
        state.insert(
            "galaxy".to_owned(),
            json!({
                "profiles": {
                    "home": {
                        "windMultiplier": 1,
                        "solarMultiplier": 1,
                        "geothermalMultiplier": 1,
                        "miningMultiplier": 1,
                        "productionSpeedMultiplier": 1,
                        "specialization": "balanced",
                        "oceanType": "none"
                    }
                },
                "systemProfiles": { "helios": { "luminosity": 1 } }
            }),
        );
        state.insert(
            "timeWarp".to_owned(),
            json!({
                "enabled": false,
                "pendingSimulationSeconds": 0,
                "pendingWallSeconds": 0,
                "effectiveMultiplier": 1,
                "requiredPowerKw": 0,
                "allocatedPowerKw": 0
            }),
        );
        state.insert(
            "dysonSwarm".to_owned(),
            json!({
                "sailsInOrbit": 0,
                "totalLaunched": 0,
                "totalExpired": 0,
                "decayProgress": 0,
                "generationKw": 0,
                "receiverLoadKw": 0
            }),
        );
        state.insert(
            "dysonSphere".to_owned(),
            json!({
                "structurePoints": 0,
                "totalRocketsLaunched": 0,
                "shellSails": 0,
                "totalSailsAbsorbed": 0,
                "absorptionProgress": 0,
                "generationKw": 0
            }),
        );
        state.insert(
            "dysonEngineering".to_owned(),
            json!({
                "launchMode": "balanced",
                "launchThrottle": 1,
                "launchEnabled": true,
                "activeOrbitBySystem": Value::Object(active_orbits),
                "orbitsBySystem": Value::Object(orbits),
                "absorptionProgressBySystem": Value::Object(absorption),
                "launchEnergySpentMj": 0
            }),
        );
        state.insert("dysonPlans".to_owned(), Value::Object(plans));
        state.insert(
            "quantumLogisticsNetwork".to_owned(),
            json!({
                "enabled": false,
                "inventory": {},
                "itemCapacities": {},
                "routingCursors": {},
                "uploadRoutingCursors": {}
            }),
        );
        state.insert(
            "galacticHubNetwork".to_owned(),
            json!({
                "fleetInstalled": 0,
                "fleetBusy": 0,
                "fleetReturns": [],
                "warpers": "0",
                "warperTarget": "0",
                "routingCursors": {}
            }),
        );
        state.insert("endgame".to_owned(), endgame);
        state.insert(
            "entities".to_owned(),
            json!([{
                "id": "vein",
                "kind": "vein",
                "planetId": "home",
                "gridId": "main",
                "position": { "x": 1, "y": 2 },
                "interactionLocked": false,
                "resourceId": "iron_ore",
                "extractorBuildingId": "mining_machine",
                "minerCount": 2,
                "inputs": {},
                "outputs": { "iron_ore": 3 },
                "progress": 0,
                "utilization": 0,
                "productionRate": 0,
                "routingCursor": 0,
            }]),
        );
        let state = serde_json::to_string(&Value::Object(state)).unwrap();
        let checksum = utf16_fnv(&format!("{{\"formatVersion\":2,\"state\":{state}}}"));
        format!(
            "{{\"formatVersion\":2,\"kind\":\"primary\",\"savedAt\":42,\"mode\":\"normal\",\"slot\":\"main\",\"state\":{state},\"checksum\":\"{checksum}\"}}"
        )
        .into_bytes()
    }

    fn player_authority_fuel_envelope() -> Vec<u8> {
        let mut envelope: Value = serde_json::from_slice(&import_envelope()).unwrap();
        envelope["state"]["tray"]["coal"] = Value::from(7);
        envelope["state"]["portableFleet"]["logistics_drone"] = Value::from(20);
        envelope["state"]["research"]["completedTechIds"] =
            json!(["thermal_power", "energy_matrix"]);
        envelope["state"]["entities"]
            .as_array_mut()
            .unwrap()
            .push(json!({
                "id": "thermal-a",
                "kind": "power",
                "planetId": "home",
                "position": { "x": 7, "y": 2 },
                "interactionLocked": false,
                "buildingId": "thermal_power_plant",
                "powerGridId": "grid-a",
                "generationPriority": 1,
                "fuelItemId": "coal",
                "fuelRemainingMj": 3.25,
                "machineCount": 2,
                "minerCount": 0,
                "inputs": { "coal": 2.4, "logistics_drone": 1.9 },
                "outputs": { "iron_ingot": 4 },
                "progress": 0.75,
                "powerInputKw": 19,
                "powerOutputKw": 1_700,
                "routingCursor": 0,
                "utilization": 0.5,
                "productionRate": 0.25
            }));
        envelope["state"]["belts"] = json!([
            {
                "id": "belt-fuel-in",
                "planetId": "home",
                "source": "vein",
                "target": "thermal-a",
                "itemId": "coal",
                "lanes": 2,
                "tier": 1,
                "sorterTier": 1,
                "progress": 0,
                "priority": 1,
                "stackSize": 1,
                "monitorEnabled": false,
                "routeMode": "auto",
                "lastFlow": 0
            },
            {
                "id": "belt-fuel-out",
                "planetId": "home",
                "source": "thermal-a",
                "target": "vein",
                "itemId": "coal",
                "lanes": 3,
                "tier": 1,
                "sorterTier": 1,
                "progress": 0,
                "priority": 1,
                "stackSize": 1,
                "monitorEnabled": false,
                "routeMode": "auto",
                "lastFlow": 0
            }
        ]);
        let state = serde_json::to_string(&envelope["state"]).unwrap();
        envelope["checksum"] = Value::from(utf16_fnv(&format!(
            "{{\"formatVersion\":2,\"state\":{state}}}"
        )));
        serde_json::to_vec(&envelope).unwrap()
    }

    fn player_authority_station_inventory_envelope() -> Vec<u8> {
        let mut envelope: Value = serde_json::from_slice(&import_envelope()).unwrap();
        envelope["state"]["tray"]["space_warper"] = Value::from(10);
        envelope["state"]["tray"]["logistics_drone"] = Value::from(41);
        envelope["state"]["tray"]["logistics_vessel"] = Value::from(43);
        envelope["state"]["portableFleet"] = json!({ "logistics_drone": 3, "logistics_vessel": 2 });
        envelope["state"]["research"]["completedTechIds"] = json!(["space_warp"]);
        envelope["state"]["entities"]
            .as_array_mut()
            .unwrap()
            .extend([
                json!({
                    "id": "station-ils",
                    "kind": "station",
                    "planetId": "home",
                    "position": { "x": 7, "y": 2 },
                    "interactionLocked": false,
                    "buildingId": "interstellar_logistics_station",
                    "powerGridId": "grid-a",
                    "powerPriority": 2,
                    "machineCount": 1,
                    "minerCount": 0,
                    "inputs": {},
                    "outputs": {},
                    "progress": 0,
                    "routingCursor": 0,
                    "utilization": 0,
                    "productionRate": 0,
                    "stationSlots": [],
                    "stationProgress": 0.75,
                    "stationDrones": 7,
                    "stationVessels": 4,
                    "stationWarpers": 0,
                    "stationPeerId": "station-peer",
                    "stationRoutes": [],
                    "stationWarpEnabled": true,
                    "stationWarperAutoRefill": false,
                    "stationWarperTarget": 50,
                    "stationHubEnabled": false,
                    "stationHubPriority": 1
                }),
                json!({
                    "id": "station-peer",
                    "kind": "station",
                    "planetId": "home",
                    "position": { "x": 8, "y": 2 },
                    "interactionLocked": false,
                    "buildingId": "interstellar_logistics_station",
                    "powerGridId": "grid-a",
                    "powerPriority": 2,
                    "machineCount": 1,
                    "minerCount": 0,
                    "inputs": {},
                    "outputs": {},
                    "progress": 0,
                    "routingCursor": 0,
                    "utilization": 0,
                    "productionRate": 0,
                    "stationSlots": [],
                    "stationProgress": 0.5,
                    "stationDrones": 0,
                    "stationVessels": 0,
                    "stationWarpers": 0,
                    "stationPeerId": "station-ils",
                    "stationRoutes": [{
                        "id": "busy-local",
                        "slotIndex": 0,
                        "peerId": "station-ils",
                        "itemId": "iron_ore",
                        "scope": "local",
                        "cargo": 2,
                        "vehicleCount": 2,
                        "progress": 0.25,
                        "duration": 10,
                        "requiresWarp": false,
                        "vehicleStationId": "station-ils",
                        "waypointStationIds": []
                    }, {
                        "id": "busy-remote",
                        "slotIndex": 0,
                        "peerId": "station-ils",
                        "itemId": "iron_ore",
                        "scope": "remote",
                        "cargo": 1,
                        "vehicleCount": 1,
                        "progress": 0.5,
                        "duration": 20,
                        "requiresWarp": true,
                        "vehicleStationId": "station-ils",
                        "waypointStationIds": []
                    }],
                    "stationWarpEnabled": true,
                    "stationWarperAutoRefill": false,
                    "stationWarperTarget": 50,
                    "stationHubEnabled": false,
                    "stationHubPriority": 1
                }),
            ]);
        let state = serde_json::to_string(&envelope["state"]).unwrap();
        envelope["checksum"] = Value::from(utf16_fnv(&format!(
            "{{\"formatVersion\":2,\"state\":{state}}}"
        )));
        serde_json::to_vec(&envelope).unwrap()
    }

    fn player_authority_station_slot_directory(primary_item_id: Option<&str>) -> Value {
        Value::Array(
            (0..5)
                .map(|slot_index| {
                    json!({
                        "itemId": if slot_index == 0 { primary_item_id } else { None },
                        "localMode": if slot_index == 0 { "supply" } else { "storage" },
                        "remoteMode": if slot_index == 0 { "demand" } else { "storage" },
                        "minimumLoad": 0.5,
                        "minStock": 0,
                        "maxStock": 0,
                        "priority": 1,
                        "routePolicy": "direct",
                        "warperBudget": 2,
                        "slotPayload": { "owner": "future:slot", "index": slot_index }
                    })
                })
                .collect(),
        )
    }

    fn player_authority_station_slot_envelope() -> Vec<u8> {
        let mut envelope: Value =
            serde_json::from_slice(&player_authority_station_inventory_envelope()).unwrap();
        envelope["state"]["quantumLogisticsNetwork"] = json!({
            "enabled": true,
            "inventory": { "iron_ore": "25000", "iron_ingot": "1234" },
            "itemCapacities": { "iron_ore": "100000", "iron_ingot": "100000" },
            "routingCursors": { "iron_ore": 17 },
            "uploadRoutingCursors": { "iron_ingot": 23 }
        });
        let entities = envelope["state"]["entities"].as_array_mut().unwrap();
        let target = entities
            .iter_mut()
            .find(|entity| entity["id"] == "station-ils")
            .unwrap();
        target["stationSlots"] = player_authority_station_slot_directory(Some("iron_ore"));
        target["storedItemId"] = Value::from("iron_ore");
        target["stationMode"] = Value::from("demand");
        target["stationMinimumLoad"] = Value::from(0.5);
        target["outputs"] = json!({ "iron_ore": 3 });
        target["quantumMaterialBuffer"] = json!({ "hydrogen": 123 });
        let peer = entities
            .iter_mut()
            .find(|entity| entity["id"] == "station-peer")
            .unwrap();
        peer["stationSlots"] = player_authority_station_slot_directory(Some("iron_ore"));
        peer["storedItemId"] = Value::from("iron_ore");
        peer["stationMode"] = Value::from("demand");
        peer["stationMinimumLoad"] = Value::from(0.5);
        let state = serde_json::to_string(&envelope["state"]).unwrap();
        envelope["checksum"] = Value::from(utf16_fnv(&format!(
            "{{\"formatVersion\":2,\"state\":{state}}}"
        )));
        serde_json::to_vec(&envelope).unwrap()
    }

    fn player_authority_construction_automation_envelope() -> Vec<u8> {
        let mut envelope: Value = serde_json::from_slice(&import_envelope()).unwrap();
        envelope["state"]["research"]["completedTechIds"] = json!([
            "construction_automation",
            "construction_capacity_1",
            "construction_capacity_2",
            "quantum_logistics_network",
            "planetary_logistics",
            "interstellar_logistics",
            "universe_matrix"
        ]);
        envelope["state"]["constructionAutomation"] = json!({
            "enabled": false,
            "targetStock": { "arc_smelter": 2 },
            "cursor": 3,
            "totalCrafted": 7,
            "lastCraftedId": "arc_smelter",
            "destroyedByproducts": { "iron_ore": 5 },
            "jobs": {
                "construction-center-a": {
                    "constructionId": "arc_smelter",
                    "steps": [{ "kind": "building", "constructionId": "arc_smelter" }],
                    "stepIndex": 0,
                    "elapsedSeconds": 1,
                    "inventory": { "iron_ingot": 9, "logistics_drone": 2 }
                },
                "construction-center-b": {
                    "constructionId": "arc_smelter",
                    "steps": [{ "kind": "building", "constructionId": "arc_smelter" }],
                    "stepIndex": 0,
                    "elapsedSeconds": 2,
                    "inventory": { "iron_ingot": 4 }
                },
                "construction-center-unrelated": {
                    "constructionId": "logistics_vessel",
                    "steps": [{ "kind": "fleet", "itemId": "logistics_vessel", "amount": 1 }],
                    "stepIndex": 0,
                    "elapsedSeconds": 0,
                    "inventory": { "iron_ingot": 6 }
                }
            },
            "quantumMaterialBuffer": {
                "construction-center-a": { "iron_ingot": 11 },
                "construction-center-b": { "iron_ingot": 7, "space_warper": 3 },
                "construction-center-unrelated": { "iron_ingot": 2 }
            }
        });
        envelope["state"]["quantumLogisticsNetwork"] = json!({
            "enabled": true,
            "inventory": { "iron_ingot": "9980", "space_warper": "9997" },
            "itemCapacities": { "iron_ingot": "10000", "space_warper": "10000" },
            "routingCursors": { "iron_ingot": 7 },
            "uploadRoutingCursors": { "iron_ingot": 9 }
        });
        envelope["state"]["orbitalStation"] = json!({ "status": "operational" });
        envelope["state"]["construction"]["construction_center"] = Value::from(0);
        envelope["state"]["construction"]["orbital_cargo_terminal"] = Value::from(0);
        envelope["state"]["planetTrays"]["ashen"] = json!({ "space_warper": 7 });
        envelope["state"]["entities"]
            .as_array_mut()
            .unwrap()
            .push(json!({
                "id": "construction-center-a",
                "kind": "machine",
                "planetId": "home",
                "position": { "x": 9, "y": 2 },
                "interactionLocked": false,
                "buildingId": "construction_center",
                "powerGridId": "grid-a",
                "powerPriority": 2,
                "recipeId": null,
                "machineCount": 2,
                "minerCount": 0,
                "inputs": { "iron_ingot": 13 },
                "outputs": { "arc_smelter": 17 },
                "progress": 0.25,
                "routingCursor": 0,
                "utilization": 0.5,
                "productionRate": 0
            }));
        envelope["state"]["entities"]
            .as_array_mut()
            .unwrap()
            .push(json!({
                "id": "construction-center-b",
                "kind": "machine",
                "planetId": "ashen",
                "position": { "x": 10, "y": 2 },
                "interactionLocked": false,
                "buildingId": "construction_center",
                "powerGridId": "grid-b",
                "powerPriority": 2,
                "recipeId": null,
                "machineCount": 1,
                "minerCount": 0,
                "inputs": { "iron_ingot": 3 },
                "outputs": {},
                "progress": 0.5,
                "routingCursor": 0,
                "utilization": 0.25,
                "productionRate": 0
            }));
        let state = serde_json::to_string(&envelope["state"]).unwrap();
        envelope["checksum"] = Value::from(utf16_fnv(&format!(
            "{{\"formatVersion\":2,\"state\":{state}}}"
        )));
        serde_json::to_vec(&envelope).unwrap()
    }

    fn player_authority_fixture() -> (
        tempfile::TempDir,
        SaveStore,
        CoreRegistry,
        String,
        ExactRealtimeCheckpoint,
    ) {
        player_authority_fixture_from_bytes(import_envelope())
    }

    fn player_authority_fuel_fixture() -> (
        tempfile::TempDir,
        SaveStore,
        CoreRegistry,
        String,
        ExactRealtimeCheckpoint,
    ) {
        player_authority_fixture_from_parts(
            player_authority_fuel_envelope(),
            player_authority_fuel_catalog(),
        )
    }

    fn player_authority_station_inventory_fixture() -> (
        tempfile::TempDir,
        SaveStore,
        CoreRegistry,
        String,
        ExactRealtimeCheckpoint,
    ) {
        player_authority_fixture_from_parts(
            player_authority_station_inventory_envelope(),
            player_authority_station_inventory_catalog(),
        )
    }

    fn player_authority_station_slot_fixture() -> (
        tempfile::TempDir,
        SaveStore,
        CoreRegistry,
        String,
        ExactRealtimeCheckpoint,
    ) {
        player_authority_fixture_from_parts(
            player_authority_station_slot_envelope(),
            player_authority_station_inventory_catalog(),
        )
    }

    fn player_authority_construction_automation_fixture() -> (
        tempfile::TempDir,
        SaveStore,
        CoreRegistry,
        String,
        ExactRealtimeCheckpoint,
    ) {
        player_authority_fixture_from_parts(
            player_authority_construction_automation_envelope(),
            player_authority_construction_automation_catalog(),
        )
    }

    fn persisted_inventory_amount(value: Option<&Value>) -> u128 {
        value
            .and_then(|value| {
                value
                    .as_u64()
                    .map(u128::from)
                    .or_else(|| value.as_str()?.parse::<u128>().ok())
            })
            .unwrap_or(0)
    }

    fn construction_owned_material_total(state: &Value, item_id: &str) -> u128 {
        let mut total = persisted_inventory_amount(state["tray"].get(item_id));
        if let Some(planet_trays) = state["planetTrays"].as_object() {
            total += planet_trays
                .values()
                .map(|tray| persisted_inventory_amount(tray.get(item_id)))
                .sum::<u128>();
        }
        total += persisted_inventory_amount(state["portableFleet"].get(item_id));
        total +=
            persisted_inventory_amount(state["quantumLogisticsNetwork"]["inventory"].get(item_id));
        if let Some(jobs) = state["constructionAutomation"]["jobs"].as_object() {
            total += jobs
                .values()
                .map(|job| persisted_inventory_amount(job["inventory"].get(item_id)))
                .sum::<u128>();
        }
        if let Some(buffers) = state["constructionAutomation"]["quantumMaterialBuffer"].as_object()
        {
            total += buffers
                .values()
                .map(|buffer| persisted_inventory_amount(buffer.get(item_id)))
                .sum::<u128>();
        }
        total
    }

    fn player_authority_belt_fixture() -> (
        tempfile::TempDir,
        SaveStore,
        CoreRegistry,
        String,
        ExactRealtimeCheckpoint,
    ) {
        let mut envelope: Value = serde_json::from_slice(&import_envelope()).unwrap();
        envelope["state"]["belts"] = json!([{
            "id": "belt-priority",
            "planetId": "home",
            "source": "vein",
            "target": "vein",
            "itemId": "iron_ore",
            "lanes": 1,
            "tier": 1,
            "sorterTier": 1,
            "progress": 0,
            "priority": 1,
            "lastFlow": 0,
            "modPayload": { "owner": "pack:test", "revision": 7 }
        }]);
        let state = serde_json::to_string(&envelope["state"]).unwrap();
        envelope["checksum"] = Value::from(utf16_fnv(&format!(
            "{{\"formatVersion\":2,\"state\":{state}}}"
        )));
        player_authority_fixture_from_bytes(serde_json::to_vec(&envelope).unwrap())
    }

    fn player_authority_macro_fixture() -> (
        tempfile::TempDir,
        SaveStore,
        CoreRegistry,
        String,
        ExactRealtimeCheckpoint,
    ) {
        let mut envelope: Value = serde_json::from_slice(&import_envelope()).unwrap();
        envelope["state"]["timeWarp"] = json!({
            "controllerEntityId": "controller",
            "enabled": true,
            "requestedMultiplier": 15,
            "effectiveMultiplier": 15,
            "pendingSimulationSeconds": 0,
            "pendingWallSeconds": 0,
            "requiredPowerKw": 10_000_000_000_000_000_u64,
            "allocatedPowerKw": 10_000_000_000_000_000_u64
        });
        envelope["state"]["quantumLogisticsNetwork"] = json!({
            "enabled": true,
            "inventory": {},
            "itemCapacities": { "iron_ore": "10000000000" },
            "routingCursors": {},
            "uploadRoutingCursors": {}
        });
        envelope["state"]["entities"] = json!([
            {
                "id": "wind",
                "kind": "power",
                "planetId": "home",
                "powerGridId": "grid-a",
                "position": { "x": 0, "y": 0 },
                "interactionLocked": false,
                "buildingId": "wind_turbine",
                "machineCount": 1,
                "minerCount": 0,
                "inputs": {},
                "outputs": {},
                "progress": 0,
                "routingCursor": 0,
                "utilization": 0,
                "productionRate": 0
            },
            {
                "id": "controller",
                "kind": "machine",
                "planetId": "home",
                "powerGridId": "grid-a",
                "position": { "x": 1, "y": 0 },
                "interactionLocked": false,
                "buildingId": "time_warp_device",
                "machineCount": 1,
                "minerCount": 0,
                "inputs": {},
                "outputs": {},
                "progress": 0,
                "routingCursor": 0,
                "utilization": 1,
                "productionRate": 0
            },
            {
                "id": "vein",
                "kind": "vein",
                "planetId": "home",
                "powerGridId": "grid-a",
                "position": { "x": 2, "y": 0 },
                "interactionLocked": false,
                "resourceId": "iron_ore",
                "extractorBuildingId": "mining_machine",
                "minerCount": 2,
                "inputs": {},
                "outputs": { "iron_ore": 0 },
                "resourceCapacity": 1000000,
                "resourceRemaining": 1000000,
                "resourceDepletionRemainder": 0,
                "progress": 0,
                "routingCursor": 0,
                "utilization": 0,
                "productionRate": 0
            }
        ]);
        let state = serde_json::to_string(&envelope["state"]).unwrap();
        envelope["checksum"] = Value::from(utf16_fnv(&format!(
            "{{\"formatVersion\":2,\"state\":{state}}}"
        )));
        player_authority_fixture_from_parts(
            serde_json::to_vec(&envelope).unwrap(),
            player_authority_macro_catalog(),
        )
    }

    fn player_authority_fixture_from_bytes(
        bytes: Vec<u8>,
    ) -> (
        tempfile::TempDir,
        SaveStore,
        CoreRegistry,
        String,
        ExactRealtimeCheckpoint,
    ) {
        player_authority_fixture_from_parts(bytes, player_authority_catalog())
    }

    fn player_authority_fixture_from_parts(
        bytes: Vec<u8>,
        catalog: Value,
    ) -> (
        tempfile::TempDir,
        SaveStore,
        CoreRegistry,
        String,
        ExactRealtimeCheckpoint,
    ) {
        let root = tempdir().unwrap();
        let mut store = SaveStore::open(root.path()).unwrap();
        let mut registry = CoreRegistry::default();
        let imported = registry
            .import_v47(
                &mut store,
                Cursor::new(bytes.clone()),
                bytes.len() as u64,
                EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT,
                catalog.clone(),
            )
            .unwrap();
        let checkpoint = ExactRealtimeCheckpoint {
            generation: imported.checkpoint.generation,
            root_hash: imported.checkpoint.root_hash,
            revision: imported.checkpoint.revision,
        };
        let summary = registry.status(&imported.session_id).unwrap();
        let authority_session_id = store
            .player_authority_session_binding(&imported.session_id)
            .unwrap();
        store
            .prepare_player_authority_lease(
                authority_session_id.clone(),
                "player-authority-run".to_owned(),
                summary.registry_fingerprint.clone(),
                checkpoint.clone(),
                ExactRealtimeStateProof {
                    revision: summary.revision,
                    canonical_sha256: summary.canonical_sha256,
                    domain_sha256: summary.domain_sha256,
                },
                42_000,
            )
            .unwrap();
        store
            .write_player_authority_recovery_catalog(
                "player-authority-run",
                &checkpoint,
                &summary.registry_fingerprint,
                catalog,
            )
            .unwrap();
        store
            .activate_player_authority_lease(
                &authority_session_id,
                "player-authority-run",
                &summary.registry_fingerprint,
            )
            .unwrap();
        (root, store, registry, imported.session_id, checkpoint)
    }

    fn resumable_player_authority_registry_for_test() -> CoreRegistry {
        let mut registry = CoreRegistry::default();
        registry.enable_player_authority_coverage_for_test();
        registry
    }

    fn player_authority_fixture_with_probe(
        probe: Arc<MutableDiskSpaceProbe>,
    ) -> (
        tempfile::TempDir,
        SaveStore,
        CoreRegistry,
        String,
        ExactRealtimeCheckpoint,
    ) {
        let root = tempdir().unwrap();
        let mut store = SaveStore::open_with_disk_space_probe(root.path(), probe).unwrap();
        let mut registry = CoreRegistry::default();
        let bytes = import_envelope();
        let imported = registry
            .import_v47(
                &mut store,
                Cursor::new(bytes.clone()),
                bytes.len() as u64,
                EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT,
                player_authority_catalog(),
            )
            .unwrap();
        let checkpoint = ExactRealtimeCheckpoint {
            generation: imported.checkpoint.generation,
            root_hash: imported.checkpoint.root_hash,
            revision: imported.checkpoint.revision,
        };
        let summary = registry.status(&imported.session_id).unwrap();
        let authority_session_id = store
            .player_authority_session_binding(&imported.session_id)
            .unwrap();
        store
            .prepare_player_authority_lease(
                authority_session_id.clone(),
                "player-authority-run".to_owned(),
                summary.registry_fingerprint.clone(),
                checkpoint.clone(),
                ExactRealtimeStateProof {
                    revision: summary.revision,
                    canonical_sha256: summary.canonical_sha256,
                    domain_sha256: summary.domain_sha256,
                },
                42_000,
            )
            .unwrap();
        store
            .write_player_authority_recovery_catalog(
                "player-authority-run",
                &checkpoint,
                &summary.registry_fingerprint,
                player_authority_catalog(),
            )
            .unwrap();
        store
            .activate_player_authority_lease(
                &authority_session_id,
                "player-authority-run",
                &summary.registry_fingerprint,
            )
            .unwrap();
        (root, store, registry, imported.session_id, checkpoint)
    }

    fn player_authority_command(
        base_revision: u64,
        command_id: &str,
        value: Value,
    ) -> CoreCommitPlayerAuthorityCommandRequest {
        let x = value.as_f64().unwrap_or(17.0);
        CoreCommitPlayerAuthorityCommandRequest {
            run_id: "player-authority-run".to_owned(),
            command_id: command_id.to_owned(),
            base_revision,
            command: serde_json::from_value(json!({
                "protocolVersion": 1,
                "baseRevision": base_revision,
                "topLevelChanges": [],
                "changedEntities": [{
                    "id": "vein",
                    "changes": [{
                        "path": ["position", "x"],
                        "operation": "set",
                        "value": x
                    }]
                }],
                "addedEntities": [],
                "removedEntityIds": [],
                "changedBelts": [],
                "addedBelts": [],
                "removedBeltIds": []
            }))
            .unwrap(),
        }
    }

    fn player_authority_pause_request(
        base_revision: u64,
        target_paused: bool,
        settled_deadline_ms: u64,
    ) -> CoreCommitPlayerAuthorityPauseRequest {
        CoreCommitPlayerAuthorityPauseRequest {
            run_id: "player-authority-run".to_owned(),
            base_revision,
            target_paused,
            settled_deadline_ms,
        }
    }

    fn player_authority_pause_command_request(
        base_revision: u64,
        target_paused: bool,
        settled_deadline_ms: u64,
    ) -> CoreCommitPlayerAuthorityCommandRequest {
        let run_id = "player-authority-run";
        let command = player_authority_pause_command(base_revision, target_paused);
        CoreCommitPlayerAuthorityCommandRequest {
            run_id: run_id.to_owned(),
            command_id: derive_player_authority_pause_command_id(
                run_id,
                base_revision,
                target_paused,
                settled_deadline_ms,
            )
            .unwrap(),
            base_revision,
            command: decode_player_authority_command_payload(&command).unwrap(),
        }
    }

    fn player_authority_time_warp_disable_command(
        base_revision: u64,
        command_id: &str,
    ) -> CoreCommitPlayerAuthorityCommandRequest {
        CoreCommitPlayerAuthorityCommandRequest {
            run_id: "player-authority-run".to_owned(),
            command_id: command_id.to_owned(),
            base_revision,
            command: serde_json::from_value(json!({
                "protocolVersion": 1,
                "baseRevision": base_revision,
                "topLevelChanges": [{
                    "path": ["timeWarp", "intent"],
                    "operation": "set",
                    "value": {
                        "controllerEntityId": "controller",
                        "enabled": false
                    }
                }],
                "changedEntities": [],
                "addedEntities": [],
                "removedEntityIds": [],
                "changedBelts": [],
                "addedBelts": [],
                "removedBeltIds": []
            }))
            .unwrap(),
        }
    }

    fn player_authority_macro_request(
        base_revision: u64,
        macro_session_id: &str,
        operation_id: &str,
    ) -> CoreCommitPlayerAuthorityMacroAdvanceRequest {
        CoreCommitPlayerAuthorityMacroAdvanceRequest {
            run_id: "player-authority-run".to_owned(),
            macro_session_id: macro_session_id.to_owned(),
            operation_id: operation_id.to_owned(),
            base_revision,
            simulation_milliseconds: 60_000,
            wall_milliseconds: 4_000,
        }
    }

    fn player_authority_entity_position_command(
        base_revision: u64,
        command_id: &str,
        x: f64,
    ) -> CoreCommitPlayerAuthorityCommandRequest {
        CoreCommitPlayerAuthorityCommandRequest {
            run_id: "player-authority-run".to_owned(),
            command_id: command_id.to_owned(),
            base_revision,
            command: serde_json::from_value(json!({
                "protocolVersion": 1,
                "baseRevision": base_revision,
                "topLevelChanges": [],
                "changedEntities": [{
                    "id": "vein",
                    "changes": [{
                        "path": ["position", "x"],
                        "operation": "set",
                        "value": x
                    }]
                }],
                "addedEntities": [],
                "removedEntityIds": [],
                "changedBelts": [],
                "addedBelts": [],
                "removedBeltIds": []
            }))
            .unwrap(),
        }
    }

    fn player_authority_fuel_item_command(
        base_revision: u64,
        command_id: &str,
    ) -> CoreCommitPlayerAuthorityCommandRequest {
        CoreCommitPlayerAuthorityCommandRequest {
            run_id: "player-authority-run".to_owned(),
            command_id: command_id.to_owned(),
            base_revision,
            command: serde_json::from_value(json!({
                "protocolVersion": 1,
                "baseRevision": base_revision,
                "topLevelChanges": [],
                "changedEntities": [{
                    "id": "thermal-a",
                    "changes": [{
                        "path": ["fuelItemId"],
                        "operation": "set",
                        "value": "energetic_graphite"
                    }]
                }],
                "addedEntities": [],
                "removedEntityIds": [],
                "changedBelts": [],
                "addedBelts": [],
                "removedBeltIds": []
            }))
            .unwrap(),
        }
    }

    fn player_authority_station_fleet_intent_command(
        base_revision: u64,
        command_id: &str,
    ) -> CoreCommitPlayerAuthorityCommandRequest {
        CoreCommitPlayerAuthorityCommandRequest {
            run_id: "player-authority-run".to_owned(),
            command_id: command_id.to_owned(),
            base_revision,
            command: serde_json::from_value(json!({
                "protocolVersion": 1,
                "baseRevision": base_revision,
                "topLevelChanges": [],
                "changedEntities": [{
                    "id": "station-ils",
                    "changes": [{
                        "path": ["stationFleetTarget", "intent"],
                        "operation": "set",
                        "value": { "kind": "drone", "targetCount": 12 }
                    }]
                }],
                "addedEntities": [],
                "removedEntityIds": [],
                "changedBelts": [],
                "addedBelts": [],
                "removedBeltIds": []
            }))
            .unwrap(),
        }
    }

    fn player_authority_station_warper_intent_command(
        base_revision: u64,
        command_id: &str,
    ) -> CoreCommitPlayerAuthorityCommandRequest {
        CoreCommitPlayerAuthorityCommandRequest {
            run_id: "player-authority-run".to_owned(),
            command_id: command_id.to_owned(),
            base_revision,
            command: serde_json::from_value(json!({
                "protocolVersion": 1,
                "baseRevision": base_revision,
                "topLevelChanges": [],
                "changedEntities": [{
                    "id": "station-ils",
                    "changes": [{
                        "path": ["stationWarperInventory", "intent"],
                        "operation": "set",
                        "value": { "delta": 20 }
                    }]
                }],
                "addedEntities": [],
                "removedEntityIds": [],
                "changedBelts": [],
                "addedBelts": [],
                "removedBeltIds": []
            }))
            .unwrap(),
        }
    }

    fn player_authority_station_slot_item_intent_command(
        base_revision: u64,
        command_id: &str,
    ) -> CoreCommitPlayerAuthorityCommandRequest {
        CoreCommitPlayerAuthorityCommandRequest {
            run_id: "player-authority-run".to_owned(),
            command_id: command_id.to_owned(),
            base_revision,
            command: serde_json::from_value(json!({
                "protocolVersion": 1,
                "baseRevision": base_revision,
                "topLevelChanges": [],
                "changedEntities": [{
                    "id": "station-ils",
                    "changes": [{
                        "path": ["stationSlotItem", "intent"],
                        "operation": "set",
                        "value": { "slotIndex": 0, "itemId": "iron_ingot" }
                    }]
                }],
                "addedEntities": [],
                "removedEntityIds": [],
                "changedBelts": [],
                "addedBelts": [],
                "removedBeltIds": []
            }))
            .unwrap(),
        }
    }

    fn player_authority_construction_automation_intent_command(
        base_revision: u64,
        command_id: &str,
        intent: Value,
    ) -> CoreCommitPlayerAuthorityCommandRequest {
        CoreCommitPlayerAuthorityCommandRequest {
            run_id: "player-authority-run".to_owned(),
            command_id: command_id.to_owned(),
            base_revision,
            command: serde_json::from_value(json!({
                "protocolVersion": 1,
                "baseRevision": base_revision,
                "topLevelChanges": [{
                    "path": ["constructionAutomation", "intent"],
                    "operation": "set",
                    "value": intent
                }],
                "changedEntities": [],
                "addedEntities": [],
                "removedEntityIds": [],
                "changedBelts": [],
                "addedBelts": [],
                "removedBeltIds": []
            }))
            .unwrap(),
        }
    }

    fn player_authority_raw_top_level_command(
        base_revision: u64,
        command_id: &str,
        changes: Vec<Value>,
    ) -> CoreCommitPlayerAuthorityCommandRequest {
        let command = json!({
            "protocolVersion": 1,
            "baseRevision": base_revision,
            "topLevelChanges": changes,
            "changedEntities": [],
            "addedEntities": [],
            "removedEntityIds": [],
            "changedBelts": [],
            "addedBelts": [],
            "removedBeltIds": []
        });
        CoreCommitPlayerAuthorityCommandRequest {
            run_id: "player-authority-run".to_owned(),
            command_id: command_id.to_owned(),
            base_revision,
            command: decode_player_authority_command_payload(&command).unwrap(),
        }
    }

    fn player_authority_raw_belt_command(
        base_revision: u64,
        command_id: &str,
        belt_id: &str,
        changes: Vec<Value>,
        top_level_changes: Vec<Value>,
    ) -> CoreCommitPlayerAuthorityCommandRequest {
        let command = json!({
            "protocolVersion": 1,
            "baseRevision": base_revision,
            "topLevelChanges": top_level_changes,
            "changedEntities": [],
            "addedEntities": [],
            "removedEntityIds": [],
            "changedBelts": [{
                "id": belt_id,
                "changes": changes
            }],
            "addedBelts": [],
            "removedBeltIds": []
        });
        CoreCommitPlayerAuthorityCommandRequest {
            run_id: "player-authority-run".to_owned(),
            command_id: command_id.to_owned(),
            base_revision,
            command: decode_player_authority_command_payload(&command).unwrap(),
        }
    }

    fn player_authority_belt_priority_command(
        base_revision: u64,
        command_id: &str,
        belt_id: &str,
        priority: Value,
    ) -> CoreCommitPlayerAuthorityCommandRequest {
        player_authority_raw_belt_command(
            base_revision,
            command_id,
            belt_id,
            vec![json!({
                "path": ["priority"],
                "operation": "set",
                "value": priority
            })],
            Vec::new(),
        )
    }

    fn ordinary_building_placement_command(
        base_revision: u64,
        command_id: &str,
    ) -> CoreCommitPlayerAuthorityCommandRequest {
        CoreCommitPlayerAuthorityCommandRequest {
            run_id: "player-authority-run".to_owned(),
            command_id: command_id.to_owned(),
            base_revision,
            command: serde_json::from_value(json!({
                "protocolVersion": 1,
                "baseRevision": base_revision,
                "topLevelChanges": [
                    {
                        "path": ["construction", "arc_smelter"],
                        "operation": "set",
                        "value": 1
                    },
                    {
                        "path": ["nextId"],
                        "operation": "set",
                        "value": 10
                    }
                ],
                "changedEntities": [],
                "addedEntities": [{
                    "index": 1,
                    "value": {
                        "id": "entity_9",
                        "kind": "machine",
                        "planetId": "home",
                        "position": { "x": 12.5, "y": 24.5 },
                        "interactionLocked": false,
                        "buildingId": "arc_smelter",
                        "powerGridId": "grid-a",
                        "powerPriority": 2,
                        "recipeId": "iron_ingot",
                        "machineCount": 1,
                        "minerCount": 0,
                        "inputs": {},
                        "outputs": {},
                        "progress": 0,
                        "routingCursor": 0,
                        "utilization": 0,
                        "productionRate": 0
                    }
                }],
                "removedEntityIds": [],
                "changedBelts": [],
                "addedBelts": [],
                "removedBeltIds": []
            }))
            .unwrap(),
        }
    }

    fn ordinary_building_stack_increase_command(
        base_revision: u64,
        command_id: &str,
        target: u64,
        construction: u64,
    ) -> CoreCommitPlayerAuthorityCommandRequest {
        CoreCommitPlayerAuthorityCommandRequest {
            run_id: "player-authority-run".to_owned(),
            command_id: command_id.to_owned(),
            base_revision,
            command: serde_json::from_value(json!({
                "protocolVersion": 1,
                "baseRevision": base_revision,
                "topLevelChanges": [{
                    "path": ["construction", "arc_smelter"],
                    "operation": "set",
                    "value": construction
                }],
                "changedEntities": [{
                    "id": "entity_9",
                    "changes": [{
                        "path": ["machineCount"],
                        "operation": "set",
                        "value": target
                    }]
                }],
                "addedEntities": [],
                "removedEntityIds": [],
                "changedBelts": [],
                "addedBelts": [],
                "removedBeltIds": []
            }))
            .unwrap(),
        }
    }

    fn ordinary_belt_placement_command(
        projection: &Value,
        command_id: &str,
    ) -> CoreCommitPlayerAuthorityCommandRequest {
        let base_revision = projection["revision"].as_u64().unwrap();
        CoreCommitPlayerAuthorityCommandRequest {
            run_id: "player-authority-run".to_owned(),
            command_id: command_id.to_owned(),
            base_revision,
            command: serde_json::from_value(json!({
                "protocolVersion": 1,
                "baseRevision": base_revision,
                "topLevelChanges": [
                    {
                        "path": ["construction", projection["constructionId"]],
                        "operation": "set",
                        "value": projection["placement"]["remainingConstruction"]
                    },
                    {
                        "path": ["nextId"],
                        "operation": "set",
                        "value": projection["placement"]["nextIdAfterPlacement"]
                    }
                ],
                "changedEntities": [],
                "addedEntities": [],
                "removedEntityIds": [],
                "changedBelts": [],
                "addedBelts": [{
                    "index": projection["appendBeltIndex"],
                    "value": projection["placement"]["beltTemplate"]
                }],
                "removedBeltIds": []
            }))
            .unwrap(),
        }
    }

    fn ordinary_belt_removal_command(
        projection: &Value,
        command_id: &str,
    ) -> CoreCommitPlayerAuthorityCommandRequest {
        let base_revision = projection["revision"].as_u64().unwrap();
        CoreCommitPlayerAuthorityCommandRequest {
            run_id: "player-authority-run".to_owned(),
            command_id: command_id.to_owned(),
            base_revision,
            command: serde_json::from_value(json!({
                "protocolVersion": 1,
                "baseRevision": base_revision,
                "topLevelChanges": [{
                    "path": ["construction", projection["constructionId"]],
                    "operation": "set",
                    "value": projection["refundAfterRemoval"]
                }],
                "changedEntities": [],
                "addedEntities": [],
                "removedEntityIds": [],
                "changedBelts": [],
                "addedBelts": [],
                "removedBeltIds": [projection["beltId"]]
            }))
            .unwrap(),
        }
    }

    fn ordinary_belt_lane_command(
        projection: &Value,
        command_id: &str,
    ) -> CoreCommitPlayerAuthorityCommandRequest {
        let base_revision = projection["revision"].as_u64().unwrap();
        CoreCommitPlayerAuthorityCommandRequest {
            run_id: "player-authority-run".to_owned(),
            command_id: command_id.to_owned(),
            base_revision,
            command: serde_json::from_value(json!({
                "protocolVersion": 1,
                "baseRevision": base_revision,
                "topLevelChanges": [{
                    "path": ["construction", projection["constructionId"]],
                    "operation": "set",
                    "value": projection["constructionAfterAdjustment"]
                }],
                "changedEntities": [],
                "addedEntities": [],
                "removedEntityIds": [],
                "changedBelts": [{
                    "id": projection["beltId"],
                    "changes": [{
                        "path": ["lanes"],
                        "operation": "set",
                        "value": projection["targetLanes"]
                    }]
                }],
                "addedBelts": [],
                "removedBeltIds": []
            }))
            .unwrap(),
        }
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
                command_base_revision: None,
                command_request_sha256: None,
                last_player_command_id: None,
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
            pending_command: None,
            pending_advance: None,
            macro_session: None,
            last_finished_macro_session_id: None,
            last_finished_macro_revision: None,
            startup_resume_enabled: false,
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
        let mut summary_after =
            serde_json::to_value(registry.status(&imported.session_id).unwrap()).unwrap();
        let mut summary_before = summary_before;
        // estimatedRuntimeBytes is a diagnostic estimate whose Arc accounting
        // can change while read-only snapshots are materialized. The durable
        // and canonical identities below are the atomicity boundary.
        summary_before.as_object_mut().unwrap().remove("memory");
        summary_after.as_object_mut().unwrap().remove("memory");
        assert_eq!(summary_after, summary_before);
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
        let authority_session_id = store
            .player_authority_session_binding(&imported.session_id)
            .unwrap();
        let prepared = store
            .prepare_player_authority_lease(
                authority_session_id,
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
    fn player_authority_tick_derives_the_full_durable_chain_and_is_idempotent() {
        let (_root, mut store, mut registry, session_id, entry_checkpoint) =
            player_authority_fixture();
        let request = || CoreCommitPlayerAuthorityTickRequest {
            run_id: "player-authority-run".to_owned(),
            sequence: 1,
        };

        let committed = registry
            .commit_player_authority_tick(&mut store, &session_id, request())
            .unwrap();
        assert_eq!(committed.sequence, 1);
        assert_eq!(committed.revision, entry_checkpoint.revision + 1);
        assert_eq!(committed.checkpoint.revision, committed.revision);
        assert!(!committed.duplicate);
        let lease = store.require_exact_realtime_lease().unwrap();
        assert_eq!(
            lease.purpose().unwrap(),
            ExactRealtimeLeasePurpose::PlayerAuthority
        );
        assert_eq!(lease.acknowledged.sequence, 1);
        assert_eq!(lease.acknowledged.revision, committed.revision);
        assert_eq!(lease.acknowledged.checkpoint, committed.checkpoint);
        assert!(lease.pending_tick.is_none());
        let generation = committed.checkpoint.generation;

        let retry = registry
            .commit_player_authority_tick(&mut store, &session_id, request())
            .unwrap();
        assert!(retry.duplicate);
        assert_eq!(retry.revision, committed.revision);
        assert_eq!(retry.checkpoint, committed.checkpoint);
        assert_eq!(
            store.recover("normal-main").unwrap().unwrap().generation,
            generation
        );

        let second = registry
            .commit_player_authority_tick(
                &mut store,
                &session_id,
                CoreCommitPlayerAuthorityTickRequest {
                    run_id: "player-authority-run".to_owned(),
                    sequence: 2,
                },
            )
            .unwrap();
        assert!(!second.duplicate);
        assert_eq!(second.revision, committed.revision + 1);
        let second_lease = store.require_exact_realtime_lease().unwrap();
        assert_eq!(second_lease.acknowledged.sequence, 2);
        assert_eq!(second_lease.acknowledged.settled_deadline_ms, 44_000);
    }

    #[test]
    fn player_authority_tick_resumes_after_each_lost_response_boundary() {
        for fault in [
            PlayerAuthorityTickFault::AfterStage,
            PlayerAuthorityTickFault::AfterWal,
            PlayerAuthorityTickFault::AfterCheckpoint,
            PlayerAuthorityTickFault::AfterLeaseAcknowledge,
        ] {
            let (_root, mut store, mut registry, session_id, entry_checkpoint) =
                player_authority_fixture();
            let request = || CoreCommitPlayerAuthorityTickRequest {
                run_id: "player-authority-run".to_owned(),
                sequence: 1,
            };
            let error = registry
                .commit_player_authority_tick_internal(&mut store, &session_id, request(), fault)
                .unwrap_err();
            assert!(
                format!("{error:#}").contains("lost response"),
                "{fault:?}: {error:#}"
            );

            let durable_after_fault = store.require_exact_realtime_lease().unwrap();
            match fault {
                PlayerAuthorityTickFault::AfterStage
                | PlayerAuthorityTickFault::AfterWal
                | PlayerAuthorityTickFault::AfterCheckpoint => {
                    assert_eq!(
                        durable_after_fault.pending_tick.as_ref().unwrap().sequence,
                        1
                    );
                    assert_eq!(durable_after_fault.acknowledged.sequence, 0);
                }
                PlayerAuthorityTickFault::AfterLeaseAcknowledge => {
                    assert!(durable_after_fault.pending_tick.is_none());
                    assert_eq!(durable_after_fault.acknowledged.sequence, 1);
                }
                PlayerAuthorityTickFault::None => unreachable!(),
            }

            let recovered = registry
                .commit_player_authority_tick(&mut store, &session_id, request())
                .unwrap_or_else(|error| panic!("{fault:?}: {error:#}"));
            assert!(recovered.duplicate, "{fault:?}");
            assert_eq!(recovered.revision, entry_checkpoint.revision + 1);
            assert_eq!(recovered.checkpoint.revision, recovered.revision);
            let durable = store.require_exact_realtime_lease().unwrap();
            assert_eq!(durable.acknowledged.sequence, 1);
            assert_eq!(durable.acknowledged.revision, recovered.revision);
            assert!(durable.pending_tick.is_none());

            let second_retry = registry
                .commit_player_authority_tick(&mut store, &session_id, request())
                .unwrap();
            assert!(second_retry.duplicate);
            assert_eq!(second_retry.checkpoint, recovered.checkpoint);
        }
    }

    #[test]
    fn player_authority_commands_are_idempotent_and_share_order_with_ticks() {
        let (_root, mut store, mut registry, session_id, entry_checkpoint) =
            player_authority_fixture();
        let first = registry
            .commit_player_authority_command(
                &mut store,
                &session_id,
                player_authority_command(entry_checkpoint.revision, "player-command-1", json!(1)),
            )
            .unwrap();
        assert_eq!(first.sequence, 1);
        assert_eq!(first.revision, entry_checkpoint.revision + 1);
        assert_eq!(first.settled_deadline_ms, 42_000);
        assert!(!first.duplicate);
        let retry = registry
            .commit_player_authority_command(
                &mut store,
                &session_id,
                player_authority_command(entry_checkpoint.revision, "player-command-1", json!(1)),
            )
            .unwrap();
        assert!(retry.duplicate);
        assert_eq!(retry.checkpoint, first.checkpoint);

        let tick = registry
            .commit_player_authority_tick(
                &mut store,
                &session_id,
                CoreCommitPlayerAuthorityTickRequest {
                    run_id: "player-authority-run".to_owned(),
                    sequence: 2,
                },
            )
            .unwrap();
        assert_eq!(tick.revision, first.revision + 1);
        let old_retry = registry
            .commit_player_authority_command(
                &mut store,
                &session_id,
                player_authority_command(entry_checkpoint.revision, "player-command-1", json!(1)),
            )
            .unwrap_err();
        assert!(format!("{old_retry:#}").contains("already closed or conflicts"));
        let reused_id = registry
            .commit_player_authority_command(
                &mut store,
                &session_id,
                player_authority_command(tick.revision, "player-command-1", json!(999)),
            )
            .unwrap_err();
        assert!(format!("{reused_id:#}").contains("already closed or conflicts"));
        assert!(
            store
                .require_exact_realtime_lease()
                .unwrap()
                .pending_command
                .is_none()
        );
        let second = registry
            .commit_player_authority_command(
                &mut store,
                &session_id,
                player_authority_command(tick.revision, "player-command-2", json!(2)),
            )
            .unwrap();
        let third = registry
            .commit_player_authority_command(
                &mut store,
                &session_id,
                player_authority_command(second.revision, "player-command-3", json!(3)),
            )
            .unwrap();
        assert_eq!((second.sequence, third.sequence), (3, 4));
        assert_eq!(third.revision, entry_checkpoint.revision + 4);
        assert_eq!(second.settled_deadline_ms, 43_000);
        assert_eq!(third.settled_deadline_ms, 43_000);
        let lease = store.require_exact_realtime_lease().unwrap();
        assert_eq!(lease.acknowledged.sequence, 4);
        assert_eq!(lease.acknowledged.revision, third.revision);
        assert!(lease.pending_tick.is_none());
        assert!(lease.pending_command.is_none());
    }

    #[test]
    fn player_authority_command_change_receipt_is_exact_and_survives_clean_restart() {
        let (root, mut store, mut registry, session_id, entry_checkpoint) =
            player_authority_fixture();
        let request = || {
            player_authority_entity_position_command(
                entry_checkpoint.revision,
                "position-command-1",
                12.5,
            )
        };
        let committed = registry
            .commit_player_authority_command(&mut store, &session_id, request())
            .unwrap();
        assert_eq!(committed.changed_entity_ids, ["vein"]);
        assert!(committed.changed_belt_ids.is_empty());
        assert!(!committed.topology_dirty);

        let duplicate = registry
            .commit_player_authority_command(&mut store, &session_id, request())
            .unwrap();
        assert!(duplicate.duplicate);
        assert_eq!(duplicate.changed_entity_ids, committed.changed_entity_ids);
        assert_eq!(duplicate.changed_belt_ids, committed.changed_belt_ids);
        assert_eq!(duplicate.topology_dirty, committed.topology_dirty);
        assert_eq!(duplicate.checkpoint, committed.checkpoint);
        drop(registry);
        drop(store);

        let mut reopened_store = SaveStore::open(root.path()).unwrap();
        let mut reopened_registry = resumable_player_authority_registry_for_test();
        let startup = reopened_registry
            .recover_player_authority_pending_command_on_startup(&mut reopened_store)
            .unwrap()
            .expect("acknowledged command must provide a startup receipt");
        assert_eq!(startup.command_id.as_deref(), Some("position-command-1"));
        assert_eq!(
            startup.command_base_revision,
            Some(entry_checkpoint.revision)
        );
        assert_eq!(startup.changed_entity_ids, committed.changed_entity_ids);
        assert_eq!(startup.changed_belt_ids, committed.changed_belt_ids);
        assert_eq!(startup.topology_dirty, committed.topology_dirty);

        let restarted_duplicate = reopened_registry
            .commit_player_authority_command(&mut reopened_store, &startup.session_id, request())
            .unwrap();
        assert!(restarted_duplicate.duplicate);
        assert_eq!(
            restarted_duplicate.changed_entity_ids,
            committed.changed_entity_ids
        );
        assert_eq!(
            restarted_duplicate.changed_belt_ids,
            committed.changed_belt_ids
        );
        assert_eq!(restarted_duplicate.topology_dirty, committed.topology_dirty);
    }

    #[test]
    fn typed_building_placement_recovers_retries_exports_and_reloads_exactly() {
        let (root, mut store, mut registry, session_id, entry_checkpoint) =
            player_authority_fixture();
        let source_hash = registry.status(&session_id).unwrap().canonical_sha256;
        let source_checkpoint =
            serde_json::to_value(store.recover("normal-main").unwrap().unwrap()).unwrap();
        let request = || {
            ordinary_building_placement_command(
                entry_checkpoint.revision,
                "ordinary-building-placement",
            )
        };
        let lost_response = registry
            .commit_player_authority_command_internal(
                &mut store,
                &session_id,
                request(),
                PlayerAuthorityCommandKind::Gameplay,
                PlayerAuthorityCommandFault::AfterStage,
            )
            .unwrap_err();
        assert!(format!("{lost_response:#}").contains("lost response"));
        assert_eq!(
            registry.status(&session_id).unwrap().canonical_sha256,
            source_hash
        );
        assert_eq!(
            serde_json::to_value(store.recover("normal-main").unwrap().unwrap()).unwrap(),
            source_checkpoint
        );
        assert!(
            store
                .require_exact_realtime_lease()
                .unwrap()
                .pending_command
                .is_some()
        );
        drop(registry);
        drop(store);

        let mut reopened_store = SaveStore::open(root.path()).unwrap();
        let mut reopened_registry = resumable_player_authority_registry_for_test();
        let recovered = reopened_registry
            .recover_player_authority_pending_command_on_startup(&mut reopened_store)
            .unwrap()
            .expect("typed placement must recover from its durable stage");
        assert_eq!(
            recovered.command_id.as_deref(),
            Some("ordinary-building-placement")
        );
        assert_eq!(recovered.revision, entry_checkpoint.revision + 1);
        assert_eq!(recovered.changed_entity_ids, ["entity_9"]);
        assert!(recovered.changed_belt_ids.is_empty());
        assert!(recovered.topology_dirty);
        let recovered_hash = recovered.summary.canonical_sha256.clone();

        let duplicate = reopened_registry
            .commit_player_authority_command(&mut reopened_store, &recovered.session_id, request())
            .unwrap();
        assert!(duplicate.duplicate);
        assert_eq!(duplicate.revision, recovered.revision);
        assert_eq!(duplicate.summary.canonical_sha256, recovered_hash);

        reopened_registry
            .export_v47(
                &reopened_store,
                &recovered.session_id,
                "ordinary-building-placement-recovered",
                recovered.settled_deadline_ms,
            )
            .unwrap();
        let exported = std::fs::read(
            root.path()
                .join("exports/ordinary-building-placement-recovered.json"),
        )
        .unwrap();
        let envelope: Value = serde_json::from_slice(&exported).unwrap();
        assert_eq!(envelope["state"]["nextId"], 10);
        assert_eq!(envelope["state"]["construction"]["arc_smelter"], 1);
        assert_eq!(envelope["state"]["entities"][1]["id"], "entity_9");

        let reload_root = tempdir().unwrap();
        let mut reload_store = SaveStore::open(reload_root.path()).unwrap();
        let mut reload_registry = CoreRegistry::default();
        let reloaded = reload_registry
            .import_v47(
                &mut reload_store,
                Cursor::new(exported.clone()),
                exported.len() as u64,
                EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT,
                player_authority_catalog(),
            )
            .unwrap();
        let reloaded_summary = reload_registry.status(&reloaded.session_id).unwrap();
        assert_eq!(reloaded_summary.canonical_sha256, recovered_hash);
        assert_eq!(reloaded_summary.entity_count, 2);
    }

    #[test]
    fn typed_ordinary_belt_placement_context_is_read_only_durable_and_reloadable() {
        let (root, mut store, mut registry, session_id, entry_checkpoint) =
            player_authority_fixture();
        let placed = registry
            .commit_player_authority_command(
                &mut store,
                &session_id,
                ordinary_building_placement_command(
                    entry_checkpoint.revision,
                    "belt-target-placement",
                ),
            )
            .unwrap();
        let placed_hash = placed.summary.canonical_sha256.clone();
        let placed_checkpoint =
            serde_json::to_value(store.recover("normal-main").unwrap().unwrap()).unwrap();
        let projection = registry
            .construction_belt_placement_context(
                &session_id,
                placed.revision,
                EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT,
                "vein",
                "entity_9",
                "iron_ore",
                1,
                3,
            )
            .unwrap();
        assert_eq!(projection["support"]["supported"], true);
        assert_eq!(projection["placement"]["beltTemplate"]["id"], "belt_10");
        assert_eq!(projection["placement"]["remainingConstruction"], 1);
        assert_eq!(
            registry.status(&session_id).unwrap().canonical_sha256,
            placed_hash
        );
        assert_eq!(
            serde_json::to_value(store.recover("normal-main").unwrap().unwrap()).unwrap(),
            placed_checkpoint
        );
        let request = || ordinary_belt_placement_command(&projection, "ordinary-belt-placement");
        let lost_response = registry
            .commit_player_authority_command_internal(
                &mut store,
                &session_id,
                request(),
                PlayerAuthorityCommandKind::Gameplay,
                PlayerAuthorityCommandFault::AfterStage,
            )
            .unwrap_err();
        assert!(format!("{lost_response:#}").contains("lost response"));
        assert_eq!(
            registry.status(&session_id).unwrap().canonical_sha256,
            placed_hash
        );
        assert_eq!(
            serde_json::to_value(store.recover("normal-main").unwrap().unwrap()).unwrap(),
            placed_checkpoint
        );
        drop(registry);
        drop(store);

        let mut reopened_store = SaveStore::open(root.path()).unwrap();
        let mut reopened_registry = resumable_player_authority_registry_for_test();
        let recovered = reopened_registry
            .recover_player_authority_pending_command_on_startup(&mut reopened_store)
            .unwrap()
            .expect("typed belt placement must recover from its durable stage");
        assert_eq!(
            recovered.command_id.as_deref(),
            Some("ordinary-belt-placement")
        );
        assert_eq!(recovered.revision, placed.revision + 1);
        assert!(recovered.changed_entity_ids.is_empty());
        assert_eq!(recovered.changed_belt_ids, ["belt_10"]);
        assert!(recovered.topology_dirty);
        let recovered_hash = recovered.summary.canonical_sha256.clone();

        let duplicate = reopened_registry
            .commit_player_authority_command(&mut reopened_store, &recovered.session_id, request())
            .unwrap();
        assert!(duplicate.duplicate);
        assert_eq!(duplicate.summary.canonical_sha256, recovered_hash);
        reopened_registry
            .export_v47(
                &reopened_store,
                &recovered.session_id,
                "ordinary-belt-placement-recovered",
                recovered.settled_deadline_ms,
            )
            .unwrap();
        let exported = std::fs::read(
            root.path()
                .join("exports/ordinary-belt-placement-recovered.json"),
        )
        .unwrap();
        let envelope: Value = serde_json::from_slice(&exported).unwrap();
        assert_eq!(envelope["state"]["nextId"], 11);
        assert_eq!(envelope["state"]["construction"]["conveyor_belt_mk1"], 1);
        assert_eq!(
            envelope["state"]["belts"][0],
            projection["placement"]["beltTemplate"]
        );

        let reload_root = tempdir().unwrap();
        let mut reload_store = SaveStore::open(reload_root.path()).unwrap();
        let mut reload_registry = CoreRegistry::default();
        let reloaded = reload_registry
            .import_v47(
                &mut reload_store,
                Cursor::new(exported.clone()),
                exported.len() as u64,
                EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT,
                player_authority_catalog(),
            )
            .unwrap();
        let reloaded_summary = reload_registry.status(&reloaded.session_id).unwrap();
        assert_eq!(reloaded_summary.canonical_sha256, recovered_hash);
        assert_eq!(reloaded_summary.belt_count, 1);
    }

    #[test]
    fn typed_ordinary_belt_removal_context_is_read_only_durable_and_reloadable() {
        let (root, mut store, mut registry, session_id, entry_checkpoint) =
            player_authority_fixture();
        let target = registry
            .commit_player_authority_command(
                &mut store,
                &session_id,
                ordinary_building_placement_command(
                    entry_checkpoint.revision,
                    "belt-removal-target-placement",
                ),
            )
            .unwrap();
        let placement = registry
            .construction_belt_placement_context(
                &session_id,
                target.revision,
                EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT,
                "vein",
                "entity_9",
                "iron_ore",
                1,
                3,
            )
            .unwrap();
        let belt = registry
            .commit_player_authority_command(
                &mut store,
                &session_id,
                ordinary_belt_placement_command(&placement, "belt-removal-prerequisite"),
            )
            .unwrap();
        let belt_hash = belt.summary.canonical_sha256.clone();
        let belt_checkpoint =
            serde_json::to_value(store.recover("normal-main").unwrap().unwrap()).unwrap();
        let projection = registry
            .construction_belt_removal_context(
                &session_id,
                belt.revision,
                EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT,
                "belt_10",
            )
            .unwrap();
        assert_eq!(projection["support"]["supported"], true);
        assert_eq!(projection["constructionId"], "conveyor_belt_mk1");
        assert_eq!(projection["currentConstruction"], 1);
        assert_eq!(projection["refundAfterRemoval"], 4);
        assert_eq!(
            registry.status(&session_id).unwrap().canonical_sha256,
            belt_hash
        );
        assert_eq!(
            serde_json::to_value(store.recover("normal-main").unwrap().unwrap()).unwrap(),
            belt_checkpoint
        );

        let request = || ordinary_belt_removal_command(&projection, "ordinary-belt-removal");
        let lost_response = registry
            .commit_player_authority_command_internal(
                &mut store,
                &session_id,
                request(),
                PlayerAuthorityCommandKind::Gameplay,
                PlayerAuthorityCommandFault::AfterStage,
            )
            .unwrap_err();
        assert!(format!("{lost_response:#}").contains("lost response"));
        assert_eq!(
            registry.status(&session_id).unwrap().canonical_sha256,
            belt_hash
        );
        assert_eq!(
            serde_json::to_value(store.recover("normal-main").unwrap().unwrap()).unwrap(),
            belt_checkpoint
        );
        drop(registry);
        drop(store);

        let mut reopened_store = SaveStore::open(root.path()).unwrap();
        let mut reopened_registry = resumable_player_authority_registry_for_test();
        let recovered = reopened_registry
            .recover_player_authority_pending_command_on_startup(&mut reopened_store)
            .unwrap()
            .expect("typed belt removal must recover from its durable stage");
        assert_eq!(
            recovered.command_id.as_deref(),
            Some("ordinary-belt-removal")
        );
        assert_eq!(recovered.revision, belt.revision + 1);
        assert!(recovered.changed_entity_ids.is_empty());
        assert_eq!(recovered.changed_belt_ids, ["belt_10"]);
        assert!(recovered.topology_dirty);
        let recovered_hash = recovered.summary.canonical_sha256.clone();

        let duplicate = reopened_registry
            .commit_player_authority_command(&mut reopened_store, &recovered.session_id, request())
            .unwrap();
        assert!(duplicate.duplicate);
        assert_eq!(duplicate.summary.canonical_sha256, recovered_hash);
        reopened_registry
            .export_v47(
                &reopened_store,
                &recovered.session_id,
                "ordinary-belt-removal-recovered",
                recovered.settled_deadline_ms,
            )
            .unwrap();
        let exported = std::fs::read(
            root.path()
                .join("exports/ordinary-belt-removal-recovered.json"),
        )
        .unwrap();
        let envelope: Value = serde_json::from_slice(&exported).unwrap();
        assert_eq!(envelope["state"]["nextId"], 11);
        assert_eq!(envelope["state"]["construction"]["conveyor_belt_mk1"], 4);
        assert_eq!(envelope["state"]["belts"], json!([]));

        let reload_root = tempdir().unwrap();
        let mut reload_store = SaveStore::open(reload_root.path()).unwrap();
        let mut reload_registry = CoreRegistry::default();
        let reloaded = reload_registry
            .import_v47(
                &mut reload_store,
                Cursor::new(exported.clone()),
                exported.len() as u64,
                EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT,
                player_authority_catalog(),
            )
            .unwrap();
        let reloaded_summary = reload_registry.status(&reloaded.session_id).unwrap();
        assert_eq!(reloaded_summary.canonical_sha256, recovered_hash);
        assert_eq!(reloaded_summary.belt_count, 0);
    }

    #[test]
    fn typed_ordinary_belt_lane_context_is_read_only_durable_and_reloadable() {
        let (root, mut store, mut registry, session_id, entry_checkpoint) =
            player_authority_fixture();
        let target = registry
            .commit_player_authority_command(
                &mut store,
                &session_id,
                ordinary_building_placement_command(
                    entry_checkpoint.revision,
                    "belt-lane-target-placement",
                ),
            )
            .unwrap();
        let placement = registry
            .construction_belt_placement_context(
                &session_id,
                target.revision,
                EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT,
                "vein",
                "entity_9",
                "iron_ore",
                1,
                3,
            )
            .unwrap();
        let belt = registry
            .commit_player_authority_command(
                &mut store,
                &session_id,
                ordinary_belt_placement_command(&placement, "belt-lane-prerequisite"),
            )
            .unwrap();
        let belt_hash = belt.summary.canonical_sha256.clone();
        let belt_checkpoint =
            serde_json::to_value(store.recover("normal-main").unwrap().unwrap()).unwrap();
        let projection = registry
            .construction_belt_lane_context(
                &session_id,
                belt.revision,
                EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT,
                "belt_10",
                2,
            )
            .unwrap();
        assert_eq!(projection["support"]["supported"], true);
        assert_eq!(projection["currentLanes"], 3);
        assert_eq!(projection["targetLanes"], 2);
        assert_eq!(projection["constructionId"], "conveyor_belt_mk1");
        assert_eq!(projection["currentConstruction"], 1);
        assert_eq!(projection["constructionAfterAdjustment"], 2);
        assert_eq!(
            registry.status(&session_id).unwrap().canonical_sha256,
            belt_hash
        );
        assert_eq!(
            serde_json::to_value(store.recover("normal-main").unwrap().unwrap()).unwrap(),
            belt_checkpoint
        );

        let request = || ordinary_belt_lane_command(&projection, "ordinary-belt-lane-adjustment");
        let lost_response = registry
            .commit_player_authority_command_internal(
                &mut store,
                &session_id,
                request(),
                PlayerAuthorityCommandKind::Gameplay,
                PlayerAuthorityCommandFault::AfterStage,
            )
            .unwrap_err();
        assert!(format!("{lost_response:#}").contains("lost response"));
        assert_eq!(
            registry.status(&session_id).unwrap().canonical_sha256,
            belt_hash
        );
        assert_eq!(
            serde_json::to_value(store.recover("normal-main").unwrap().unwrap()).unwrap(),
            belt_checkpoint
        );
        drop(registry);
        drop(store);

        let mut reopened_store = SaveStore::open(root.path()).unwrap();
        let mut reopened_registry = resumable_player_authority_registry_for_test();
        let recovered = reopened_registry
            .recover_player_authority_pending_command_on_startup(&mut reopened_store)
            .unwrap()
            .expect("typed belt lane adjustment must recover from its durable stage");
        assert_eq!(
            recovered.command_id.as_deref(),
            Some("ordinary-belt-lane-adjustment")
        );
        assert_eq!(recovered.revision, belt.revision + 1);
        assert!(recovered.changed_entity_ids.is_empty());
        assert_eq!(recovered.changed_belt_ids, ["belt_10"]);
        assert!(recovered.topology_dirty);
        let recovered_hash = recovered.summary.canonical_sha256.clone();

        let duplicate = reopened_registry
            .commit_player_authority_command(&mut reopened_store, &recovered.session_id, request())
            .unwrap();
        assert!(duplicate.duplicate);
        assert_eq!(duplicate.summary.canonical_sha256, recovered_hash);
        reopened_registry
            .export_v47(
                &reopened_store,
                &recovered.session_id,
                "ordinary-belt-lane-recovered",
                recovered.settled_deadline_ms,
            )
            .unwrap();
        let exported = std::fs::read(
            root.path()
                .join("exports/ordinary-belt-lane-recovered.json"),
        )
        .unwrap();
        let envelope: Value = serde_json::from_slice(&exported).unwrap();
        assert_eq!(envelope["state"]["nextId"], 11);
        assert_eq!(envelope["state"]["construction"]["conveyor_belt_mk1"], 2);
        assert_eq!(envelope["state"]["belts"][0]["lanes"], 2);

        let reload_root = tempdir().unwrap();
        let mut reload_store = SaveStore::open(reload_root.path()).unwrap();
        let mut reload_registry = CoreRegistry::default();
        let reloaded = reload_registry
            .import_v47(
                &mut reload_store,
                Cursor::new(exported.clone()),
                exported.len() as u64,
                EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT,
                player_authority_catalog(),
            )
            .unwrap();
        let reloaded_summary = reload_registry.status(&reloaded.session_id).unwrap();
        assert_eq!(reloaded_summary.canonical_sha256, recovered_hash);
        assert_eq!(reloaded_summary.belt_count, 1);
    }

    #[test]
    fn typed_building_stack_increase_recovers_retries_exports_and_reloads_exactly() {
        let (root, mut store, mut registry, session_id, entry_checkpoint) =
            player_authority_fixture();
        let placed = registry
            .commit_player_authority_command(
                &mut store,
                &session_id,
                ordinary_building_placement_command(
                    entry_checkpoint.revision,
                    "stack-prerequisite-placement",
                ),
            )
            .unwrap();
        let placed_hash = placed.summary.canonical_sha256.clone();
        let placed_checkpoint =
            serde_json::to_value(store.recover("normal-main").unwrap().unwrap()).unwrap();
        let request = || {
            ordinary_building_stack_increase_command(
                placed.revision,
                "ordinary-building-stack-increase",
                2,
                0,
            )
        };
        let lost_response = registry
            .commit_player_authority_command_internal(
                &mut store,
                &session_id,
                request(),
                PlayerAuthorityCommandKind::Gameplay,
                PlayerAuthorityCommandFault::AfterStage,
            )
            .unwrap_err();
        assert!(format!("{lost_response:#}").contains("lost response"));
        assert_eq!(
            registry.status(&session_id).unwrap().canonical_sha256,
            placed_hash
        );
        assert_eq!(
            serde_json::to_value(store.recover("normal-main").unwrap().unwrap()).unwrap(),
            placed_checkpoint
        );
        assert!(
            store
                .require_exact_realtime_lease()
                .unwrap()
                .pending_command
                .is_some()
        );
        drop(registry);
        drop(store);

        let mut reopened_store = SaveStore::open(root.path()).unwrap();
        let mut reopened_registry = resumable_player_authority_registry_for_test();
        let recovered = reopened_registry
            .recover_player_authority_pending_command_on_startup(&mut reopened_store)
            .unwrap()
            .expect("typed stack increase must recover from its durable stage");
        assert_eq!(
            recovered.command_id.as_deref(),
            Some("ordinary-building-stack-increase")
        );
        assert_eq!(recovered.revision, placed.revision + 1);
        assert_eq!(recovered.changed_entity_ids, ["entity_9"]);
        assert!(recovered.changed_belt_ids.is_empty());
        assert!(recovered.topology_dirty);
        let recovered_hash = recovered.summary.canonical_sha256.clone();

        let duplicate = reopened_registry
            .commit_player_authority_command(&mut reopened_store, &recovered.session_id, request())
            .unwrap();
        assert!(duplicate.duplicate);
        assert_eq!(duplicate.revision, recovered.revision);
        assert_eq!(duplicate.summary.canonical_sha256, recovered_hash);

        reopened_registry
            .export_v47(
                &reopened_store,
                &recovered.session_id,
                "ordinary-building-stack-increase-recovered",
                recovered.settled_deadline_ms,
            )
            .unwrap();
        let exported = std::fs::read(
            root.path()
                .join("exports/ordinary-building-stack-increase-recovered.json"),
        )
        .unwrap();
        let envelope: Value = serde_json::from_slice(&exported).unwrap();
        assert_eq!(envelope["state"]["construction"]["arc_smelter"], 0);
        assert_eq!(envelope["state"]["entities"][1]["id"], "entity_9");
        assert_eq!(envelope["state"]["entities"][1]["machineCount"], 2);

        let reload_root = tempdir().unwrap();
        let mut reload_store = SaveStore::open(reload_root.path()).unwrap();
        let mut reload_registry = CoreRegistry::default();
        let reloaded = reload_registry
            .import_v47(
                &mut reload_store,
                Cursor::new(exported.clone()),
                exported.len() as u64,
                EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT,
                player_authority_catalog(),
            )
            .unwrap();
        let reloaded_summary = reload_registry.status(&reloaded.session_id).unwrap();
        assert_eq!(reloaded_summary.canonical_sha256, recovered_hash);
        assert_eq!(reloaded_summary.entity_count, 2);
    }

    #[test]
    fn forged_building_stack_debit_fails_before_stage_and_preserves_checkpoint() {
        let (_root, mut store, mut registry, session_id, entry_checkpoint) =
            player_authority_fixture();
        let placed = registry
            .commit_player_authority_command(
                &mut store,
                &session_id,
                ordinary_building_placement_command(
                    entry_checkpoint.revision,
                    "forged-stack-prerequisite-placement",
                ),
            )
            .unwrap();
        let summary_before = serde_json::to_value(registry.status(&session_id).unwrap()).unwrap();
        let checkpoint_before =
            serde_json::to_value(store.recover("normal-main").unwrap().unwrap()).unwrap();
        let lease_before = store.require_exact_realtime_lease().unwrap();
        let error = registry
            .commit_player_authority_command(
                &mut store,
                &session_id,
                ordinary_building_stack_increase_command(
                    placed.revision,
                    "forged-building-stack-increase",
                    2,
                    1,
                ),
            )
            .unwrap_err();
        assert!(
            format!("{error:#}").contains("stack inventory adjustment is invalid"),
            "{error:#}"
        );
        assert_eq!(
            serde_json::to_value(registry.status(&session_id).unwrap()).unwrap(),
            summary_before
        );
        assert_eq!(
            serde_json::to_value(store.recover("normal-main").unwrap().unwrap()).unwrap(),
            checkpoint_before
        );
        assert_eq!(store.require_exact_realtime_lease().unwrap(), lease_before);
    }

    #[test]
    fn typed_recipe_focus_recovers_retries_exports_and_reloads_exactly() {
        let (root, mut store, mut registry, session_id, entry_checkpoint) =
            player_authority_fixture();
        let source_hash = registry.status(&session_id).unwrap().canonical_sha256;
        let source_checkpoint =
            serde_json::to_value(store.recover("normal-main").unwrap().unwrap()).unwrap();
        let request = || {
            player_authority_raw_top_level_command(
                entry_checkpoint.revision,
                "recipe-focus-pin",
                vec![json!({
                    "path": ["recipeFocus", "itemId"],
                    "operation": "set",
                    "value": "iron_ingot"
                })],
            )
        };
        let lost_response = registry
            .commit_player_authority_command_internal(
                &mut store,
                &session_id,
                request(),
                PlayerAuthorityCommandKind::Gameplay,
                PlayerAuthorityCommandFault::AfterStage,
            )
            .unwrap_err();
        assert!(format!("{lost_response:#}").contains("lost response"));
        assert_eq!(
            registry.status(&session_id).unwrap().canonical_sha256,
            source_hash
        );
        assert_eq!(
            serde_json::to_value(store.recover("normal-main").unwrap().unwrap()).unwrap(),
            source_checkpoint
        );
        assert!(
            store
                .require_exact_realtime_lease()
                .unwrap()
                .pending_command
                .is_some()
        );
        drop(registry);
        drop(store);

        let mut reopened_store = SaveStore::open(root.path()).unwrap();
        let mut reopened_registry = resumable_player_authority_registry_for_test();
        let recovered = reopened_registry
            .recover_player_authority_pending_command_on_startup(&mut reopened_store)
            .unwrap()
            .expect("typed recipe focus must recover from its durable stage");
        assert_eq!(recovered.command_id.as_deref(), Some("recipe-focus-pin"));
        assert_eq!(recovered.revision, entry_checkpoint.revision + 1);
        assert!(recovered.changed_entity_ids.is_empty());
        assert!(recovered.changed_belt_ids.is_empty());
        assert!(!recovered.topology_dirty);
        let recovered_hash = recovered.summary.canonical_sha256.clone();

        let duplicate = reopened_registry
            .commit_player_authority_command(&mut reopened_store, &recovered.session_id, request())
            .unwrap();
        assert!(duplicate.duplicate);
        assert_eq!(duplicate.revision, recovered.revision);
        assert_eq!(duplicate.summary.canonical_sha256, recovered_hash);
        assert!(!duplicate.topology_dirty);

        reopened_registry
            .export_v47(
                &reopened_store,
                &recovered.session_id,
                "recipe-focus-recovered",
                recovered.settled_deadline_ms,
            )
            .unwrap();
        let exported =
            std::fs::read(root.path().join("exports/recipe-focus-recovered.json")).unwrap();
        let envelope: Value = serde_json::from_slice(&exported).unwrap();
        assert_eq!(envelope["state"]["recipeFocus"]["itemId"], "iron_ingot");
        assert_eq!(envelope["state"]["recipeFocus"]["mode"], "two-level");
        assert_eq!(envelope["state"]["recipeFocus"]["position"]["x"], 24);
        assert_eq!(envelope["state"]["recipeFocus"]["position"]["y"], 72);

        let reload_root = tempdir().unwrap();
        let mut reload_store = SaveStore::open(reload_root.path()).unwrap();
        let mut reload_registry = CoreRegistry::default();
        let reloaded = reload_registry
            .import_v47(
                &mut reload_store,
                Cursor::new(exported.clone()),
                exported.len() as u64,
                EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT,
                player_authority_catalog(),
            )
            .unwrap();
        let reloaded_summary = reload_registry.status(&reloaded.session_id).unwrap();
        assert_eq!(reloaded_summary.canonical_sha256, recovered_hash);
    }

    #[test]
    fn forged_recipe_focus_fails_before_stage_and_preserves_checkpoint() {
        let (_root, mut store, mut registry, session_id, entry_checkpoint) =
            player_authority_fixture();
        let summary_before = serde_json::to_value(registry.status(&session_id).unwrap()).unwrap();
        let checkpoint_before =
            serde_json::to_value(store.recover("normal-main").unwrap().unwrap()).unwrap();
        let lease_before = store.require_exact_realtime_lease().unwrap();
        let requests = [
            player_authority_raw_top_level_command(
                entry_checkpoint.revision,
                "unknown-recipe-focus-item",
                vec![json!({
                    "path": ["recipeFocus", "itemId"],
                    "operation": "set",
                    "value": "missing_item"
                })],
            ),
            player_authority_raw_top_level_command(
                entry_checkpoint.revision,
                "whole-recipe-focus-object",
                vec![json!({
                    "path": ["recipeFocus"],
                    "operation": "set",
                    "value": {
                        "itemId": "iron_ingot",
                        "mode": "full",
                        "position": { "x": 40, "y": 96 }
                    }
                })],
            ),
            player_authority_raw_top_level_command(
                entry_checkpoint.revision,
                "mixed-recipe-focus-command",
                vec![
                    json!({
                        "path": ["recipeFocus", "itemId"],
                        "operation": "set",
                        "value": "iron_ingot"
                    }),
                    json!({
                        "path": ["paused"],
                        "operation": "set",
                        "value": false
                    }),
                ],
            ),
        ];
        for request in requests {
            let error = registry
                .commit_player_authority_command(&mut store, &session_id, request)
                .unwrap_err();
            assert!(format!("{error:#}").contains("recipe focus"), "{error:#}");
            assert_eq!(
                serde_json::to_value(registry.status(&session_id).unwrap()).unwrap(),
                summary_before
            );
            assert_eq!(
                serde_json::to_value(store.recover("normal-main").unwrap().unwrap()).unwrap(),
                checkpoint_before
            );
            assert_eq!(store.require_exact_realtime_lease().unwrap(), lease_before);
        }
    }

    #[test]
    fn typed_planet_viewport_recovers_retries_exports_and_reloads_exactly() {
        let (root, mut store, mut registry, session_id, entry_checkpoint) =
            player_authority_fixture();
        let source_hash = registry.status(&session_id).unwrap().canonical_sha256;
        let source_checkpoint =
            serde_json::to_value(store.recover("normal-main").unwrap().unwrap()).unwrap();
        let request = || {
            player_authority_raw_top_level_command(
                entry_checkpoint.revision,
                "planet-viewport-pan",
                vec![
                    json!({
                        "path": ["planetViewports", "home", "x"],
                        "operation": "set",
                        "value": -123.25
                    }),
                    json!({
                        "path": ["planetViewports", "home", "y"],
                        "operation": "set",
                        "value": 456.5
                    }),
                    json!({
                        "path": ["planetViewports", "home", "zoom"],
                        "operation": "set",
                        "value": 0.75
                    }),
                ],
            )
        };
        let lost_response = registry
            .commit_player_authority_command_internal(
                &mut store,
                &session_id,
                request(),
                PlayerAuthorityCommandKind::Gameplay,
                PlayerAuthorityCommandFault::AfterStage,
            )
            .unwrap_err();
        assert!(format!("{lost_response:#}").contains("lost response"));
        assert_eq!(
            registry.status(&session_id).unwrap().canonical_sha256,
            source_hash
        );
        assert_eq!(
            serde_json::to_value(store.recover("normal-main").unwrap().unwrap()).unwrap(),
            source_checkpoint
        );
        assert!(
            store
                .require_exact_realtime_lease()
                .unwrap()
                .pending_command
                .is_some()
        );
        drop(registry);
        drop(store);

        let mut reopened_store = SaveStore::open(root.path()).unwrap();
        let mut reopened_registry = resumable_player_authority_registry_for_test();
        let recovered = reopened_registry
            .recover_player_authority_pending_command_on_startup(&mut reopened_store)
            .unwrap()
            .expect("typed planet viewport must recover from its durable stage");
        assert_eq!(recovered.command_id.as_deref(), Some("planet-viewport-pan"));
        assert_eq!(recovered.revision, entry_checkpoint.revision + 1);
        assert!(recovered.changed_entity_ids.is_empty());
        assert!(recovered.changed_belt_ids.is_empty());
        assert!(!recovered.topology_dirty);
        let recovered_hash = recovered.summary.canonical_sha256.clone();

        let duplicate = reopened_registry
            .commit_player_authority_command(&mut reopened_store, &recovered.session_id, request())
            .unwrap();
        assert!(duplicate.duplicate);
        assert_eq!(duplicate.revision, recovered.revision);
        assert_eq!(duplicate.summary.canonical_sha256, recovered_hash);
        assert!(!duplicate.topology_dirty);

        reopened_registry
            .export_v47(
                &reopened_store,
                &recovered.session_id,
                "planet-viewport-recovered",
                recovered.settled_deadline_ms,
            )
            .unwrap();
        let exported =
            std::fs::read(root.path().join("exports/planet-viewport-recovered.json")).unwrap();
        let envelope: Value = serde_json::from_slice(&exported).unwrap();
        assert_eq!(envelope["state"]["planetViewports"]["home"]["x"], -123.25);
        assert_eq!(envelope["state"]["planetViewports"]["home"]["y"], 456.5);
        assert_eq!(envelope["state"]["planetViewports"]["home"]["zoom"], 0.75);
        assert_eq!(envelope["state"]["productionHistory"], json!([]));

        let reload_root = tempdir().unwrap();
        let mut reload_store = SaveStore::open(reload_root.path()).unwrap();
        let mut reload_registry = CoreRegistry::default();
        let reloaded = reload_registry
            .import_v47(
                &mut reload_store,
                Cursor::new(exported.clone()),
                exported.len() as u64,
                EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT,
                player_authority_catalog(),
            )
            .unwrap();
        let reloaded_summary = reload_registry.status(&reloaded.session_id).unwrap();
        assert_eq!(reloaded_summary.canonical_sha256, recovered_hash);
    }

    #[test]
    fn forged_planet_viewport_fails_before_stage_and_preserves_checkpoint() {
        let (_root, mut store, mut registry, session_id, entry_checkpoint) =
            player_authority_fixture();
        let summary_before = serde_json::to_value(registry.status(&session_id).unwrap()).unwrap();
        let checkpoint_before =
            serde_json::to_value(store.recover("normal-main").unwrap().unwrap()).unwrap();
        let lease_before = store.require_exact_realtime_lease().unwrap();
        let requests = [
            player_authority_raw_top_level_command(
                entry_checkpoint.revision,
                "unknown-planet-viewport",
                vec![json!({
                    "path": ["planetViewports", "missing", "x"],
                    "operation": "set",
                    "value": 1
                })],
            ),
            player_authority_raw_top_level_command(
                entry_checkpoint.revision,
                "whole-planet-viewport",
                vec![json!({
                    "path": ["planetViewports", "home"],
                    "operation": "set",
                    "value": { "x": 1, "y": 2, "zoom": 1 }
                })],
            ),
            player_authority_raw_top_level_command(
                entry_checkpoint.revision,
                "invalid-planet-viewport-zoom",
                vec![json!({
                    "path": ["planetViewports", "home", "zoom"],
                    "operation": "set",
                    "value": 2
                })],
            ),
            player_authority_raw_top_level_command(
                entry_checkpoint.revision,
                "mixed-planet-viewport-command",
                vec![
                    json!({
                        "path": ["planetViewports", "home", "x"],
                        "operation": "set",
                        "value": 1
                    }),
                    json!({
                        "path": ["paused"],
                        "operation": "set",
                        "value": false
                    }),
                ],
            ),
        ];
        for request in requests {
            let error = registry
                .commit_player_authority_command(&mut store, &session_id, request)
                .unwrap_err();
            assert!(
                format!("{error:#}").contains("planet viewport"),
                "{error:#}"
            );
            assert_eq!(
                serde_json::to_value(registry.status(&session_id).unwrap()).unwrap(),
                summary_before
            );
            assert_eq!(
                serde_json::to_value(store.recover("normal-main").unwrap().unwrap()).unwrap(),
                checkpoint_before
            );
            assert_eq!(store.require_exact_realtime_lease().unwrap(), lease_before);
        }
    }

    #[test]
    fn typed_belt_priority_recovers_retries_exports_and_reloads_exactly() {
        let (root, mut store, mut registry, session_id, entry_checkpoint) =
            player_authority_belt_fixture();
        let source_hash = registry.status(&session_id).unwrap().canonical_sha256;
        let source_checkpoint =
            serde_json::to_value(store.recover("normal-main").unwrap().unwrap()).unwrap();
        let request = || {
            player_authority_belt_priority_command(
                entry_checkpoint.revision,
                "belt-priority-high",
                "belt-priority",
                Value::from(2),
            )
        };
        let lost_response = registry
            .commit_player_authority_command_internal(
                &mut store,
                &session_id,
                request(),
                PlayerAuthorityCommandKind::Gameplay,
                PlayerAuthorityCommandFault::AfterStage,
            )
            .unwrap_err();
        assert!(format!("{lost_response:#}").contains("lost response"));
        assert_eq!(
            registry.status(&session_id).unwrap().canonical_sha256,
            source_hash
        );
        assert_eq!(
            serde_json::to_value(store.recover("normal-main").unwrap().unwrap()).unwrap(),
            source_checkpoint
        );
        assert!(
            store
                .require_exact_realtime_lease()
                .unwrap()
                .pending_command
                .is_some()
        );
        drop(registry);
        drop(store);

        let mut reopened_store = SaveStore::open(root.path()).unwrap();
        let mut reopened_registry = resumable_player_authority_registry_for_test();
        let recovered = reopened_registry
            .recover_player_authority_pending_command_on_startup(&mut reopened_store)
            .unwrap()
            .expect("typed belt priority must recover from its durable stage");
        assert_eq!(recovered.command_id.as_deref(), Some("belt-priority-high"));
        assert_eq!(recovered.revision, entry_checkpoint.revision + 1);
        assert!(recovered.changed_entity_ids.is_empty());
        assert_eq!(recovered.changed_belt_ids, ["belt-priority"]);
        assert!(recovered.topology_dirty);
        let recovered_hash = recovered.summary.canonical_sha256.clone();

        let duplicate = reopened_registry
            .commit_player_authority_command(&mut reopened_store, &recovered.session_id, request())
            .unwrap();
        assert!(duplicate.duplicate);
        assert_eq!(duplicate.revision, recovered.revision);
        assert_eq!(duplicate.summary.canonical_sha256, recovered_hash);
        assert_eq!(duplicate.changed_belt_ids, ["belt-priority"]);
        assert!(duplicate.topology_dirty);

        reopened_registry
            .export_v47(
                &reopened_store,
                &recovered.session_id,
                "belt-priority-recovered",
                recovered.settled_deadline_ms,
            )
            .unwrap();
        let exported =
            std::fs::read(root.path().join("exports/belt-priority-recovered.json")).unwrap();
        let envelope: Value = serde_json::from_slice(&exported).unwrap();
        let belt = envelope["state"]["belts"]
            .as_array()
            .unwrap()
            .iter()
            .find(|belt| belt["id"] == "belt-priority")
            .unwrap();
        assert_eq!(belt["priority"], 2);
        assert_eq!(
            belt["modPayload"],
            json!({ "owner": "pack:test", "revision": 7 })
        );
        assert_eq!(envelope["state"]["productionHistory"], json!([]));

        let reload_root = tempdir().unwrap();
        let mut reload_store = SaveStore::open(reload_root.path()).unwrap();
        let mut reload_registry = CoreRegistry::default();
        let reloaded = reload_registry
            .import_v47(
                &mut reload_store,
                Cursor::new(exported.clone()),
                exported.len() as u64,
                EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT,
                player_authority_catalog(),
            )
            .unwrap();
        let reloaded_summary = reload_registry.status(&reloaded.session_id).unwrap();
        assert_eq!(reloaded_summary.canonical_sha256, recovered_hash);
    }

    #[test]
    fn forged_belt_priority_fails_before_stage_and_preserves_checkpoint() {
        let (_root, mut store, mut registry, session_id, entry_checkpoint) =
            player_authority_belt_fixture();
        let summary_before = serde_json::to_value(registry.status(&session_id).unwrap()).unwrap();
        let checkpoint_before =
            serde_json::to_value(store.recover("normal-main").unwrap().unwrap()).unwrap();
        let lease_before = store.require_exact_realtime_lease().unwrap();
        let mut duplicate_record = player_authority_belt_priority_command(
            entry_checkpoint.revision,
            "duplicate-belt-priority",
            "belt-priority",
            Value::from(2),
        );
        let repeated_record = duplicate_record.command.changed_belts[0].clone();
        duplicate_record.command.changed_belts.push(repeated_record);
        let requests = vec![
            player_authority_belt_priority_command(
                entry_checkpoint.revision,
                "invalid-belt-priority",
                "belt-priority",
                Value::from(3),
            ),
            player_authority_belt_priority_command(
                entry_checkpoint.revision,
                "missing-belt-priority",
                "missing-belt",
                Value::from(2),
            ),
            player_authority_raw_belt_command(
                entry_checkpoint.revision,
                "mixed-mod-belt-priority",
                "belt-priority",
                vec![
                    json!({
                        "path": ["priority"],
                        "operation": "set",
                        "value": 2
                    }),
                    json!({
                        "path": ["modPayload"],
                        "operation": "set",
                        "value": { "owner": "forged" }
                    }),
                ],
                Vec::new(),
            ),
            player_authority_raw_belt_command(
                entry_checkpoint.revision,
                "mixed-top-level-belt-priority",
                "belt-priority",
                vec![json!({
                    "path": ["priority"],
                    "operation": "set",
                    "value": 2
                })],
                vec![json!({
                    "path": ["paused"],
                    "operation": "set",
                    "value": true
                })],
            ),
            duplicate_record,
        ];
        for request in requests {
            let error = registry
                .commit_player_authority_command(&mut store, &session_id, request)
                .unwrap_err();
            assert!(format!("{error:#}").contains("belt"), "{error:#}");
            assert_eq!(
                serde_json::to_value(registry.status(&session_id).unwrap()).unwrap(),
                summary_before
            );
            assert_eq!(
                serde_json::to_value(store.recover("normal-main").unwrap().unwrap()).unwrap(),
                checkpoint_before
            );
            assert_eq!(store.require_exact_realtime_lease().unwrap(), lease_before);
        }
    }

    #[test]
    fn forged_building_placement_fails_before_stage_and_preserves_checkpoint() {
        let (_root, mut store, mut registry, session_id, entry_checkpoint) =
            player_authority_fixture();
        let mut request = ordinary_building_placement_command(
            entry_checkpoint.revision,
            "forged-building-placement",
        );
        request.command.top_level_changes[0].value = Some(Value::from(0));
        let summary_before = serde_json::to_value(registry.status(&session_id).unwrap()).unwrap();
        let checkpoint_before =
            serde_json::to_value(store.recover("normal-main").unwrap().unwrap()).unwrap();
        let lease_before = store.require_exact_realtime_lease().unwrap();
        let error = registry
            .commit_player_authority_command(&mut store, &session_id, request)
            .unwrap_err();
        assert!(format!("{error:#}").contains("construction debit is invalid"));
        assert_eq!(
            serde_json::to_value(registry.status(&session_id).unwrap()).unwrap(),
            summary_before
        );
        assert_eq!(
            serde_json::to_value(store.recover("normal-main").unwrap().unwrap()).unwrap(),
            checkpoint_before
        );
        assert_eq!(store.require_exact_realtime_lease().unwrap(), lease_before);
    }

    #[test]
    fn missing_set_value_fails_before_player_command_is_staged() {
        let (_root, mut store, mut registry, session_id, entry_checkpoint) =
            player_authority_fixture();
        let summary_before = serde_json::to_value(registry.status(&session_id).unwrap()).unwrap();
        let checkpoint_before =
            serde_json::to_value(store.recover("normal-main").unwrap().unwrap()).unwrap();
        let lease_before = store.require_exact_realtime_lease().unwrap();
        let error = registry
            .commit_player_authority_command(
                &mut store,
                &session_id,
                CoreCommitPlayerAuthorityCommandRequest {
                    run_id: "player-authority-run".to_owned(),
                    command_id: "missing-set-value".to_owned(),
                    base_revision: entry_checkpoint.revision,
                    command: SimulationCommandPatch {
                        protocol_version: 1,
                        base_revision: entry_checkpoint.revision,
                        top_level_changes: vec![dsp_native_core::command::ValuePatch {
                            path: vec![dsp_native_core::command::PathSegment::Key(
                                "paused".to_owned(),
                            )],
                            operation: "set".to_owned(),
                            value: None,
                        }],
                        changed_entities: Vec::new(),
                        added_entities: Vec::new(),
                        removed_entity_ids: Vec::new(),
                        changed_belts: Vec::new(),
                        added_belts: Vec::new(),
                        removed_belt_ids: Vec::new(),
                    },
                },
            )
            .unwrap_err();
        assert!(format!("{error:#}").contains("protected set has no value"));
        assert_eq!(
            serde_json::to_value(registry.status(&session_id).unwrap()).unwrap(),
            summary_before
        );
        assert_eq!(
            serde_json::to_value(store.recover("normal-main").unwrap().unwrap()).unwrap(),
            checkpoint_before
        );
        assert_eq!(store.require_exact_realtime_lease().unwrap(), lease_before);
    }

    #[test]
    fn untyped_nullable_and_delete_player_command_fails_before_durable_stage() {
        let (_root, mut store, mut registry, session_id, entry_checkpoint) =
            player_authority_fixture();
        let summary_before = serde_json::to_value(registry.status(&session_id).unwrap()).unwrap();
        let checkpoint_before =
            serde_json::to_value(store.recover("normal-main").unwrap().unwrap()).unwrap();
        let lease_before = store.require_exact_realtime_lease().unwrap();
        let request = player_authority_raw_top_level_command(
            entry_checkpoint.revision,
            "nullable-delete-command",
            vec![
                json!({
                    "path": ["nullablePlayerCommandProbe"],
                    "operation": "set",
                    "value": null
                }),
                json!({
                    "path": ["optionalPlayerCommandProbe"],
                    "operation": "delete"
                }),
            ],
        );
        assert_eq!(
            serde_json::to_value(&request.command).unwrap()["topLevelChanges"][0]["value"],
            Value::Null
        );
        let error = registry
            .commit_player_authority_command_internal(
                &mut store,
                &session_id,
                request,
                PlayerAuthorityCommandKind::Gameplay,
                PlayerAuthorityCommandFault::AfterStage,
            )
            .unwrap_err();
        assert!(format!("{error:#}").contains("pause command shape is invalid"));
        assert_eq!(
            serde_json::to_value(registry.status(&session_id).unwrap()).unwrap(),
            summary_before
        );
        assert_eq!(
            serde_json::to_value(store.recover("normal-main").unwrap().unwrap()).unwrap(),
            checkpoint_before
        );
        assert_eq!(store.require_exact_realtime_lease().unwrap(), lease_before);
    }

    #[test]
    fn player_authority_pause_resume_is_durable_idempotent_and_clock_stopping() {
        let (_root, mut store, mut registry, session_id, entry_checkpoint) =
            player_authority_fixture();
        let initial_summary = registry.status(&session_id).unwrap();
        let initial_elapsed = initial_summary.elapsed_seconds;
        let initial_summary_value = serde_json::to_value(&initial_summary).unwrap();
        let initial_lease = store.require_exact_realtime_lease().unwrap();
        let initial_publication =
            serde_json::to_value(store.recover("normal-main").unwrap().unwrap()).unwrap();

        // Even an exact pause-shaped command cannot use the renderer gameplay
        // path. The paired GameState/clock transition is main/Host-owned.
        let generic_error = registry
            .commit_player_authority_command(
                &mut store,
                &session_id,
                player_authority_pause_command_request(entry_checkpoint.revision, true, 42_000),
            )
            .unwrap_err();
        assert!(format!("{generic_error:#}").contains("requires the lifecycle path"));
        assert_eq!(
            serde_json::to_value(registry.status(&session_id).unwrap()).unwrap(),
            initial_summary_value
        );
        assert_eq!(store.require_exact_realtime_lease().unwrap(), initial_lease);
        assert_eq!(
            serde_json::to_value(store.recover("normal-main").unwrap().unwrap()).unwrap(),
            initial_publication
        );

        let moved_pause_deadline = registry
            .commit_player_authority_pause_transition(
                &mut store,
                &session_id,
                player_authority_pause_request(entry_checkpoint.revision, true, 42_001),
            )
            .unwrap_err();
        assert!(format!("{moved_pause_deadline:#}").contains("cannot move"));
        assert_eq!(
            serde_json::to_value(registry.status(&session_id).unwrap()).unwrap(),
            initial_summary_value
        );
        assert_eq!(store.require_exact_realtime_lease().unwrap(), initial_lease);

        let pause = || player_authority_pause_request(entry_checkpoint.revision, true, 42_000);
        let paused = registry
            .commit_player_authority_pause_transition(&mut store, &session_id, pause())
            .unwrap();
        assert_eq!(paused.sequence, 1);
        assert_eq!(paused.base_revision, entry_checkpoint.revision);
        assert_eq!(paused.revision, entry_checkpoint.revision + 1);
        assert_eq!(paused.settled_deadline_ms, 42_000);
        assert!(paused.target_paused);
        assert!(paused.summary.paused);
        assert!(!paused.duplicate);
        assert_eq!(
            registry.status(&session_id).unwrap().elapsed_seconds,
            initial_elapsed
        );
        let paused_lease = store.require_exact_realtime_lease().unwrap();
        assert_eq!(
            paused_lease.phase,
            crate::exact_realtime_lease::ExactRealtimeLeasePhase::Paused
        );
        assert_eq!(
            paused_lease
                .pause
                .as_ref()
                .map(|pause| pause.reason_code.as_str()),
            Some("player-request")
        );
        assert!(paused_lease.pending_command.is_none());
        assert_eq!(paused_lease.acknowledged.revision, paused.revision);
        assert_eq!(paused_lease.acknowledged.settled_deadline_ms, 42_000);

        let backward_resume = registry
            .commit_player_authority_pause_transition(
                &mut store,
                &session_id,
                player_authority_pause_request(paused.revision, false, 41_999),
            )
            .unwrap_err();
        assert!(format!("{backward_resume:#}").contains("moves backwards"));
        assert_eq!(store.require_exact_realtime_lease().unwrap(), paused_lease);
        assert_eq!(
            registry.status(&session_id).unwrap().canonical_sha256,
            paused.summary.canonical_sha256
        );

        let repeated_pause = registry
            .commit_player_authority_pause_transition(&mut store, &session_id, pause())
            .unwrap();
        assert!(repeated_pause.duplicate);
        assert_eq!(repeated_pause.revision, paused.revision);
        assert_eq!(repeated_pause.checkpoint, paused.checkpoint);
        assert_eq!(
            repeated_pause.summary.canonical_sha256,
            paused.summary.canonical_sha256
        );

        // A stopped lease cannot stage exact simulation ticks.
        let paused_before_tick = store.require_exact_realtime_lease().unwrap();
        let paused_hash = registry.status(&session_id).unwrap().canonical_sha256;
        let tick_error = registry
            .commit_player_authority_tick(
                &mut store,
                &session_id,
                CoreCommitPlayerAuthorityTickRequest {
                    run_id: "player-authority-run".to_owned(),
                    sequence: 2,
                },
            )
            .unwrap_err();
        let tick_error = format!("{tick_error:#}");
        assert!(
            tick_error.contains("active") || tick_error.contains("identity conflicts"),
            "{tick_error}"
        );
        assert_eq!(
            store.require_exact_realtime_lease().unwrap(),
            paused_before_tick
        );
        assert_eq!(
            registry.status(&session_id).unwrap().canonical_sha256,
            paused_hash
        );

        // Resume uses a fresh main-owned deadline. The 57 seconds spent paused
        // change no simulation field and can never become tick backlog.
        let resume = || player_authority_pause_request(paused.revision, false, 99_000);
        let resumed = registry
            .commit_player_authority_pause_transition(&mut store, &session_id, resume())
            .unwrap();
        assert_eq!(resumed.sequence, 2);
        assert_eq!(resumed.base_revision, paused.revision);
        assert_eq!(resumed.revision, paused.revision + 1);
        assert_eq!(resumed.settled_deadline_ms, 99_000);
        assert!(!resumed.target_paused);
        assert!(!resumed.summary.paused);
        assert!(!resumed.duplicate);
        assert_eq!(
            registry.status(&session_id).unwrap().elapsed_seconds,
            initial_elapsed
        );
        let resumed_lease = store.require_exact_realtime_lease().unwrap();
        assert_eq!(
            resumed_lease.phase,
            crate::exact_realtime_lease::ExactRealtimeLeasePhase::Active
        );
        assert!(resumed_lease.pause.is_none());
        assert!(resumed_lease.pending_command.is_none());
        assert_eq!(resumed_lease.acknowledged.sequence, 2);
        assert_eq!(resumed_lease.acknowledged.settled_deadline_ms, 99_000);

        let repeated_resume = registry
            .commit_player_authority_pause_transition(&mut store, &session_id, resume())
            .unwrap();
        assert!(repeated_resume.duplicate);
        assert_eq!(repeated_resume.revision, resumed.revision);
        assert_eq!(repeated_resume.checkpoint, resumed.checkpoint);
    }

    #[test]
    fn player_authority_pause_resume_recovers_after_every_durable_boundary() {
        let (_clean_root, mut clean_store, mut clean_registry, clean_session, clean_entry) =
            player_authority_fixture();
        let clean_paused = clean_registry
            .commit_player_authority_pause_transition(
                &mut clean_store,
                &clean_session,
                player_authority_pause_request(clean_entry.revision, true, 42_000),
            )
            .unwrap();
        let clean_resumed = clean_registry
            .commit_player_authority_pause_transition(
                &mut clean_store,
                &clean_session,
                player_authority_pause_request(clean_paused.revision, false, 99_000),
            )
            .unwrap();

        for fault in [
            PlayerAuthorityCommandFault::AfterStage,
            PlayerAuthorityCommandFault::AfterWal,
            PlayerAuthorityCommandFault::AfterCheckpoint,
            PlayerAuthorityCommandFault::AfterReceipt,
            PlayerAuthorityCommandFault::AfterLeaseAcknowledge,
        ] {
            let (root, mut store, mut registry, session_id, entry_checkpoint) =
                player_authority_fixture();
            let initial_elapsed = registry.status(&session_id).unwrap().elapsed_seconds;
            let pause_error = registry
                .commit_player_authority_command_internal(
                    &mut store,
                    &session_id,
                    player_authority_pause_command_request(entry_checkpoint.revision, true, 42_000),
                    PlayerAuthorityCommandKind::PauseLifecycle {
                        target_paused: true,
                        settled_deadline_ms: 42_000,
                    },
                    fault,
                )
                .unwrap_err();
            assert!(
                format!("{pause_error:#}").contains("lost response"),
                "pause {fault:?}: {pause_error:#}"
            );
            drop(registry);
            drop(store);

            let mut paused_store = SaveStore::open(root.path()).unwrap();
            let mut paused_registry = resumable_player_authority_registry_for_test();
            let paused_receipt = paused_registry
                .recover_player_authority_pending_command_on_startup(&mut paused_store)
                .unwrap_or_else(|error| panic!("pause {fault:?}: {error:#}"))
                .expect("paused authority must be resumable");
            assert!(paused_receipt.paused, "pause {fault:?}");
            assert_eq!(
                paused_receipt.revision, clean_paused.revision,
                "pause {fault:?}"
            );
            assert_eq!(paused_receipt.acknowledged_sequence, 1, "pause {fault:?}");
            assert_eq!(paused_receipt.next_sequence, 2, "pause {fault:?}");
            assert_eq!(
                paused_receipt.settled_deadline_ms, 42_000,
                "pause {fault:?}"
            );
            assert_eq!(paused_receipt.next_deadline_ms, 43_000, "pause {fault:?}");
            assert_eq!(
                paused_receipt.checkpoint, clean_paused.checkpoint,
                "pause {fault:?}"
            );
            assert_eq!(
                paused_receipt.summary.canonical_sha256, clean_paused.summary.canonical_sha256,
                "pause {fault:?}"
            );
            assert_eq!(
                paused_registry
                    .status(&paused_receipt.session_id)
                    .unwrap()
                    .elapsed_seconds,
                initial_elapsed,
                "pause {fault:?}"
            );
            let paused_lease = paused_store.require_exact_realtime_lease().unwrap();
            assert_eq!(
                paused_lease.phase,
                crate::exact_realtime_lease::ExactRealtimeLeasePhase::Paused,
                "pause {fault:?}"
            );
            assert!(paused_lease.pending_command.is_none(), "pause {fault:?}");

            let resume_error = paused_registry
                .commit_player_authority_command_internal(
                    &mut paused_store,
                    &paused_receipt.session_id,
                    player_authority_pause_command_request(paused_receipt.revision, false, 99_000),
                    PlayerAuthorityCommandKind::PauseLifecycle {
                        target_paused: false,
                        settled_deadline_ms: 99_000,
                    },
                    fault,
                )
                .unwrap_err();
            assert!(
                format!("{resume_error:#}").contains("lost response"),
                "resume {fault:?}: {resume_error:#}"
            );
            drop(paused_registry);
            drop(paused_store);

            let mut resumed_store = SaveStore::open(root.path()).unwrap();
            let mut resumed_registry = resumable_player_authority_registry_for_test();
            let resumed_receipt = resumed_registry
                .recover_player_authority_pending_command_on_startup(&mut resumed_store)
                .unwrap_or_else(|error| panic!("resume {fault:?}: {error:#}"))
                .expect("resumed authority must be recoverable");
            assert!(!resumed_receipt.paused, "resume {fault:?}");
            assert_eq!(
                resumed_receipt.revision, clean_resumed.revision,
                "resume {fault:?}"
            );
            assert_eq!(resumed_receipt.acknowledged_sequence, 2, "resume {fault:?}");
            assert_eq!(resumed_receipt.next_sequence, 3, "resume {fault:?}");
            assert_eq!(
                resumed_receipt.settled_deadline_ms, 99_000,
                "resume {fault:?}"
            );
            assert_eq!(
                resumed_receipt.next_deadline_ms, 100_000,
                "resume {fault:?}"
            );
            assert_eq!(
                resumed_receipt.checkpoint, clean_resumed.checkpoint,
                "resume {fault:?}"
            );
            assert_eq!(
                resumed_receipt.summary.canonical_sha256, clean_resumed.summary.canonical_sha256,
                "resume {fault:?}"
            );
            assert_eq!(
                resumed_registry
                    .status(&resumed_receipt.session_id)
                    .unwrap()
                    .elapsed_seconds,
                initial_elapsed,
                "resume {fault:?}"
            );
            let resumed_lease = resumed_store.require_exact_realtime_lease().unwrap();
            assert_eq!(
                resumed_lease.phase,
                crate::exact_realtime_lease::ExactRealtimeLeasePhase::Active,
                "resume {fault:?}"
            );
            assert!(resumed_lease.pause.is_none(), "resume {fault:?}");
            assert!(resumed_lease.pending_command.is_none(), "resume {fault:?}");

            let duplicate = resumed_registry
                .commit_player_authority_pause_transition(
                    &mut resumed_store,
                    &resumed_receipt.session_id,
                    player_authority_pause_request(clean_paused.revision, false, 99_000),
                )
                .unwrap_or_else(|error| panic!("duplicate resume {fault:?}: {error:#}"));
            assert!(duplicate.duplicate, "resume {fault:?}");
            assert_eq!(
                duplicate.revision, clean_resumed.revision,
                "resume {fault:?}"
            );
        }
    }

    #[test]
    fn player_authority_command_resumes_each_boundary_after_core_registry_restart() {
        for fault in [
            PlayerAuthorityCommandFault::AfterStage,
            PlayerAuthorityCommandFault::AfterWal,
            PlayerAuthorityCommandFault::AfterCheckpoint,
            PlayerAuthorityCommandFault::AfterReceipt,
            PlayerAuthorityCommandFault::AfterLeaseAcknowledge,
        ] {
            let (_root, mut store, mut registry, session_id, entry_checkpoint) =
                player_authority_fixture();
            let request = || {
                player_authority_command(
                    entry_checkpoint.revision,
                    "restart-command-1",
                    json!({ "fault": format!("{fault:?}") }),
                )
            };
            let error = registry
                .commit_player_authority_command_internal(
                    &mut store,
                    &session_id,
                    request(),
                    PlayerAuthorityCommandKind::Gameplay,
                    fault,
                )
                .unwrap_err();
            assert!(
                format!("{error:#}").contains("lost response"),
                "{fault:?}: {error:#}"
            );

            drop(registry);
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
                    player_authority_catalog(),
                )
                .unwrap();
            let recovered = reopened
                .commit_player_authority_command(&mut store, &opened.session_id, request())
                .unwrap_or_else(|error| panic!("{fault:?}: {error:#}"));
            assert!(recovered.duplicate, "{fault:?}");
            assert_eq!(recovered.revision, entry_checkpoint.revision + 1);
            assert_eq!(recovered.changed_entity_ids, ["vein"]);
            assert!(recovered.changed_belt_ids.is_empty());
            assert!(!recovered.topology_dirty);
            let lease = store.require_exact_realtime_lease().unwrap();
            assert_eq!(lease.acknowledged.sequence, 1);
            assert_eq!(lease.acknowledged.revision, recovered.revision);
            assert!(lease.pending_command.is_none());
        }
    }

    #[test]
    fn staged_player_authority_command_recovers_after_process_restart_without_request() {
        let (root, mut store, mut registry, session_id, entry_checkpoint) =
            player_authority_fixture();
        let old_binding = store.player_authority_session_binding(&session_id).unwrap();
        let error = registry
            .commit_player_authority_command_internal(
                &mut store,
                &session_id,
                player_authority_command(
                    entry_checkpoint.revision,
                    "process-restart-command",
                    json!({ "persisted": true }),
                ),
                PlayerAuthorityCommandKind::Gameplay,
                PlayerAuthorityCommandFault::AfterStage,
            )
            .unwrap_err();
        assert!(format!("{error:#}").contains("lost response"));
        let staged = store.require_exact_realtime_lease().unwrap();
        assert_eq!(
            staged
                .pending_command
                .as_ref()
                .unwrap()
                .command
                .pointer("/changedEntities/0/changes/0/value"),
            Some(&json!(17.0))
        );
        drop(registry);
        drop(store);

        let mut reopened_store = SaveStore::open(root.path()).unwrap();
        let mut reopened_registry = resumable_player_authority_registry_for_test();
        let recovered = reopened_registry
            .recover_player_authority_pending_command_on_startup(&mut reopened_store)
            .unwrap();
        let recovered = recovered.expect("startup recovery must consume the staged command");
        assert_eq!(recovered.run_id, "player-authority-run");
        assert_eq!(recovered.owner_id, "main-player-authority");
        assert_eq!(recovered.revision, entry_checkpoint.revision + 1);
        assert_eq!(recovered.acknowledged_sequence, 1);
        assert_eq!(recovered.next_sequence, 2);
        assert_eq!(recovered.settled_deadline_ms, 42_000);
        assert_eq!(recovered.next_deadline_ms, 43_000);
        assert_eq!(recovered.entry_checkpoint, entry_checkpoint);
        assert_eq!(recovered.checkpoint.revision, recovered.revision);
        assert_eq!(
            recovered.command_id.as_deref(),
            Some("process-restart-command")
        );
        assert_eq!(
            recovered.command_base_revision,
            Some(entry_checkpoint.revision)
        );
        assert_eq!(recovered.changed_entity_ids, ["vein"]);
        assert!(recovered.changed_belt_ids.is_empty());
        assert!(!recovered.topology_dirty);
        assert_eq!(recovered.summary.revision, recovered.revision);
        let lease = reopened_store.require_exact_realtime_lease().unwrap();
        assert_ne!(
            lease.authority_session_id.as_deref(),
            Some(old_binding.as_str())
        );
        assert!(lease.pending_command.is_none());
        assert_eq!(
            lease.acknowledged.last_player_command_id.as_deref(),
            Some("process-restart-command")
        );
        let recovered_session_id = recovered.session_id.clone();
        let recovered_run_id = recovered.run_id.clone();
        let tick = reopened_registry
            .commit_player_authority_tick(
                &mut reopened_store,
                &recovered_session_id,
                CoreCommitPlayerAuthorityTickRequest {
                    run_id: recovered_run_id,
                    sequence: recovered.next_sequence,
                },
            )
            .unwrap();
        assert_eq!(tick.sequence, 2);
        assert_eq!(tick.revision, entry_checkpoint.revision + 2);
    }

    #[test]
    fn acknowledged_player_authority_session_resumes_after_clean_or_lost_hello_restart() {
        let (root, store, registry, old_session_id, entry_checkpoint) = player_authority_fixture();
        let old_binding = store
            .player_authority_session_binding(&old_session_id)
            .unwrap();
        drop(registry);
        drop(store);

        // Process B reconstructs the active session, but its hello receipt is
        // deliberately "lost" when the process is dropped immediately.
        let mut second_store = SaveStore::open(root.path()).unwrap();
        let mut second_registry = resumable_player_authority_registry_for_test();
        let lost_receipt = second_registry
            .recover_player_authority_pending_command_on_startup(&mut second_store)
            .unwrap()
            .expect("active player authority must be resumable");
        assert_eq!(lost_receipt.revision, entry_checkpoint.revision);
        assert_eq!(lost_receipt.next_sequence, 1);
        let repeated = second_registry
            .recover_player_authority_pending_command_on_startup(&mut second_store)
            .unwrap()
            .expect("startup receipt replay must be idempotent");
        assert_eq!(repeated.session_id, lost_receipt.session_id);
        assert_eq!(second_registry.sessions.len(), 1);
        assert_ne!(
            second_store
                .require_exact_realtime_lease()
                .unwrap()
                .authority_session_id
                .as_deref(),
            Some(old_binding.as_str())
        );
        drop(second_registry);
        drop(second_store);

        // Process C can reconstruct the receipt again from the durable flag;
        // receipt delivery is therefore not itself a crash boundary.
        let mut third_store = SaveStore::open(root.path()).unwrap();
        let mut third_registry = resumable_player_authority_registry_for_test();
        let receipt = third_registry
            .recover_player_authority_pending_command_on_startup(&mut third_store)
            .unwrap()
            .expect("lost hello must remain restart-recoverable");
        assert_eq!(receipt.revision, entry_checkpoint.revision);
        assert_eq!(receipt.next_sequence, 1);
        let command = third_registry
            .commit_player_authority_command(
                &mut third_store,
                &receipt.session_id,
                player_authority_command(
                    receipt.revision,
                    "command-after-clean-restart",
                    json!({ "continued": true }),
                ),
            )
            .unwrap();
        assert_eq!(command.sequence, 1);
        assert_eq!(command.revision, entry_checkpoint.revision + 1);
    }

    #[test]
    fn startup_resume_revalidates_current_domain_coverage_before_rebinding() {
        let (root, store, registry, _session_id, _entry_checkpoint) = player_authority_fixture();
        let lease_before = store.require_exact_realtime_lease().unwrap();
        let publication_before = store.recover("normal-main").unwrap().unwrap();
        drop(registry);
        drop(store);

        // The fixture carries a valid durable active lease and catalog, but
        // production coverage remains intentionally ineligible. Startup must
        // not trust an activation decision made by an earlier binary after
        // the current binary's coverage has regressed or remains incomplete.
        let mut reopened_store = SaveStore::open(root.path()).unwrap();
        let mut reopened_registry = CoreRegistry::default();
        let error = reopened_registry
            .recover_player_authority_pending_command_on_startup(&mut reopened_store)
            .unwrap_err();
        assert!(
            format!("{error:#}").contains("not player-authority eligible"),
            "{error:#}"
        );
        assert!(reopened_registry.sessions.is_empty());
        assert_eq!(
            reopened_store.require_exact_realtime_lease().unwrap(),
            lease_before
        );
        let publication_after = reopened_store.recover("normal-main").unwrap().unwrap();
        assert_eq!(publication_after.generation, publication_before.generation);
        assert_eq!(publication_after.root_hash, publication_before.root_hash);
        assert_eq!(publication_after.revision, publication_before.revision);
    }

    #[test]
    fn stale_player_authority_catalog_cannot_trigger_startup_recovery_by_itself() {
        let (root, store, registry, _session_id, _entry_checkpoint) = player_authority_fixture();
        let mut lease_before = store.require_exact_realtime_lease().unwrap();
        assert!(lease_before.pending_command.is_none());
        assert!(lease_before.startup_resume_enabled);
        let legacy = store
            .clear_player_authority_startup_resume_for_test()
            .unwrap();
        assert!(!legacy.startup_resume_enabled);
        drop(registry);
        drop(store);

        // Model a valid old v2 active player lease written before the durable
        // resume marker existed. The still-present catalog must not upgrade it
        // or trigger authority merely because its bytes are available.
        lease_before.startup_resume_enabled = false;

        let mut reopened_store = SaveStore::open(root.path()).unwrap();
        let mut reopened_registry = CoreRegistry::default();
        assert!(
            reopened_registry
                .recover_player_authority_pending_command_on_startup(&mut reopened_store)
                .unwrap()
                .is_none()
        );
        assert!(reopened_registry.sessions.is_empty());
        assert_eq!(
            reopened_store.require_exact_realtime_lease().unwrap(),
            lease_before
        );
    }

    #[test]
    fn catalog_candidate_followed_by_prepare_failure_leaves_no_authority_tombstone() {
        let probe = Arc::new(MutableDiskSpaceProbe::available());
        let root = tempdir().unwrap();
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
        let checkpoint = ExactRealtimeCheckpoint {
            generation: imported.checkpoint.generation,
            root_hash: imported.checkpoint.root_hash,
            revision: imported.checkpoint.revision,
        };
        let summary = registry.status(&imported.session_id).unwrap();
        let authority_session_id = store
            .player_authority_session_binding(&imported.session_id)
            .unwrap();
        store
            .write_player_authority_recovery_catalog(
                "prepare-failure-run",
                &checkpoint,
                &summary.registry_fingerprint,
                import_catalog(),
            )
            .unwrap();
        probe.set(0);
        let prepare = store
            .prepare_player_authority_lease(
                authority_session_id,
                "prepare-failure-run".to_owned(),
                summary.registry_fingerprint,
                checkpoint,
                ExactRealtimeStateProof {
                    revision: summary.revision,
                    canonical_sha256: summary.canonical_sha256,
                    domain_sha256: summary.domain_sha256,
                },
                42_000,
            )
            .unwrap_err();
        assert!(
            format!("{prepare:#}").contains(crate::disk_budget::LOW_SPACE_ERROR),
            "{prepare:#}"
        );
        assert_eq!(
            store
                .exact_realtime_lease(
                    crate::exact_realtime_lease::ExactRealtimeLeaseRequest::Inspect
                )
                .unwrap(),
            json!({ "state": "missing" })
        );
        drop(registry);
        drop(store);

        let mut reopened_store = SaveStore::open(root.path()).unwrap();
        let mut reopened_registry = CoreRegistry::default();
        assert!(
            reopened_registry
                .recover_player_authority_pending_command_on_startup(&mut reopened_store)
                .unwrap()
                .is_none()
        );
        assert!(reopened_registry.sessions.is_empty());
    }

    #[test]
    fn startup_recovery_rejects_catalog_unknown_fields_without_mutating_pending_state() {
        let (root, mut store, mut registry, session_id, entry_checkpoint) =
            player_authority_fixture();
        let error = registry
            .commit_player_authority_command_internal(
                &mut store,
                &session_id,
                player_authority_command(
                    entry_checkpoint.revision,
                    "catalog-integrity-command",
                    json!({ "mustRemainPending": true }),
                ),
                PlayerAuthorityCommandKind::Gameplay,
                PlayerAuthorityCommandFault::AfterStage,
            )
            .unwrap_err();
        assert!(format!("{error:#}").contains("lost response"));
        let lease_before = store.require_exact_realtime_lease().unwrap();
        let publication_before = store.recover("normal-main").unwrap().unwrap();
        drop(registry);
        drop(store);

        let catalog_path = root
            .path()
            .join("authority")
            .join("normal-main")
            .join("player-authority-catalog-v1.json");
        let mut envelope =
            serde_json::from_slice::<Value>(&std::fs::read(&catalog_path).unwrap()).unwrap();
        envelope
            .as_object_mut()
            .unwrap()
            .insert("unexpected".to_owned(), json!(true));
        std::fs::write(&catalog_path, serde_json::to_vec(&envelope).unwrap()).unwrap();

        let mut reopened_store = SaveStore::open(root.path()).unwrap();
        let mut reopened_registry = CoreRegistry::default();
        let recovery = reopened_registry
            .recover_player_authority_pending_command_on_startup(&mut reopened_store)
            .unwrap_err();
        assert!(
            format!("{recovery:#}").contains("unknown field"),
            "{recovery:#}"
        );
        assert!(reopened_registry.sessions.is_empty());
        assert_eq!(
            reopened_store.require_exact_realtime_lease().unwrap(),
            lease_before
        );
        let publication_after = reopened_store.recover("normal-main").unwrap().unwrap();
        assert_eq!(publication_after.generation, publication_before.generation);
        assert_eq!(publication_after.root_hash, publication_before.root_hash);
        assert_eq!(publication_after.revision, publication_before.revision);
    }

    #[test]
    fn player_authority_command_id_conflict_and_stale_base_leave_state_unchanged() {
        let (_root, mut store, mut registry, session_id, entry_checkpoint) =
            player_authority_fixture();
        let committed = registry
            .commit_player_authority_command(
                &mut store,
                &session_id,
                player_authority_command(
                    entry_checkpoint.revision,
                    "conflict-command",
                    json!(-0.0),
                ),
            )
            .unwrap();
        let before = registry.status(&session_id).unwrap();
        let publication = store.recover("normal-main").unwrap().unwrap();
        let conflict = registry
            .commit_player_authority_command(
                &mut store,
                &session_id,
                player_authority_command(entry_checkpoint.revision, "conflict-command", json!(0.0)),
            )
            .unwrap_err();
        assert!(
            format!("{conflict:#}").contains("replayed command ID is already closed or conflicts"),
            "{conflict:#}"
        );
        let stale = registry
            .commit_player_authority_command(
                &mut store,
                &session_id,
                player_authority_command(entry_checkpoint.revision, "stale-command", json!(2)),
            )
            .unwrap_err();
        assert!(format!("{stale:#}").contains("base revision is not current"));
        let after = registry.status(&session_id).unwrap();
        assert_eq!(after.revision, committed.revision);
        assert_eq!(after.canonical_sha256, before.canonical_sha256);
        let publication_after = store.recover("normal-main").unwrap().unwrap();
        assert_eq!(publication_after.generation, publication.generation);
        assert_eq!(publication_after.root_hash, publication.root_hash);
        assert_eq!(publication_after.revision, publication.revision);
    }

    #[test]
    fn player_authority_command_checkpoint_failure_keeps_pending_wal_recoverable() {
        let probe = Arc::new(MutableDiskSpaceProbe::available());
        let (_root, mut store, mut registry, session_id, entry_checkpoint) =
            player_authority_fixture_with_probe(probe.clone());
        let boundaries = std::cell::Cell::new(0_u8);
        let error = registry
            .commit_player_authority_command_impl(
                &mut store,
                &session_id,
                player_authority_command(entry_checkpoint.revision, "low-space-command", json!(1)),
                PlayerAuthorityCommandKind::Gameplay,
                || {
                    let next = boundaries.get() + 1;
                    boundaries.set(next);
                    if next == 2 {
                        probe.set(0);
                    }
                    Ok(())
                },
            )
            .unwrap_err();
        assert!(
            format!("{error:#}").contains(crate::disk_budget::LOW_SPACE_ERROR),
            "{error:#}"
        );
        probe.set(u64::MAX);
        let publication = store.recover("normal-main").unwrap().unwrap();
        assert_eq!(publication.generation, entry_checkpoint.generation);
        assert_eq!(publication.root_hash, entry_checkpoint.root_hash);
        assert_eq!(publication.revision, entry_checkpoint.revision);
        let pending = store
            .require_exact_realtime_lease()
            .unwrap()
            .pending_command
            .unwrap();
        assert_eq!(pending.command_id, "low-space-command");
        assert_eq!(pending.expected_revision, entry_checkpoint.revision + 1);

        let recovered = registry
            .commit_player_authority_command(
                &mut store,
                &session_id,
                player_authority_command(entry_checkpoint.revision, "low-space-command", json!(1)),
            )
            .unwrap();
        assert!(recovered.duplicate);
        assert_eq!(recovered.revision, entry_checkpoint.revision + 1);
        assert!(
            store
                .require_exact_realtime_lease()
                .unwrap()
                .pending_command
                .is_none()
        );
    }

    #[test]
    fn player_authority_command_receipt_write_failure_keeps_pending_checkpoint_recoverable() {
        let probe = Arc::new(MutableDiskSpaceProbe::available());
        let (_root, mut store, mut registry, session_id, entry_checkpoint) =
            player_authority_fixture_with_probe(probe.clone());
        let boundaries = std::cell::Cell::new(0_u8);
        let request = || {
            player_authority_entity_position_command(
                entry_checkpoint.revision,
                "receipt-low-space-command",
                7.0,
            )
        };
        let error = registry
            .commit_player_authority_command_impl(
                &mut store,
                &session_id,
                request(),
                PlayerAuthorityCommandKind::Gameplay,
                || {
                    let next = boundaries.get() + 1;
                    boundaries.set(next);
                    if next == 3 {
                        probe.set(0);
                    }
                    Ok(())
                },
            )
            .unwrap_err();
        assert!(
            format!("{error:#}").contains(crate::disk_budget::LOW_SPACE_ERROR),
            "{error:#}"
        );
        let publication = store.recover("normal-main").unwrap().unwrap();
        assert_eq!(publication.revision, entry_checkpoint.revision + 1);
        let pending = store.require_exact_realtime_lease().unwrap();
        assert_eq!(
            pending.pending_command.as_ref().unwrap().command_id,
            "receipt-low-space-command"
        );
        assert_eq!(pending.acknowledged.revision, entry_checkpoint.revision);

        probe.set(u64::MAX);
        let recovered = registry
            .commit_player_authority_command(&mut store, &session_id, request())
            .unwrap();
        assert!(recovered.duplicate);
        assert_eq!(recovered.changed_entity_ids, ["vein"]);
        assert!(recovered.changed_belt_ids.is_empty());
        assert!(!recovered.topology_dirty);
        assert!(
            store
                .require_exact_realtime_lease()
                .unwrap()
                .pending_command
                .is_none()
        );
    }

    #[test]
    fn corrupted_acknowledged_command_receipt_blocks_clean_startup_before_session_rebind() {
        let (root, mut store, mut registry, session_id, entry_checkpoint) =
            player_authority_fixture();
        registry
            .commit_player_authority_command(
                &mut store,
                &session_id,
                player_authority_entity_position_command(
                    entry_checkpoint.revision,
                    "corrupt-receipt-command",
                    3.0,
                ),
            )
            .unwrap();
        let lease_before = store.require_exact_realtime_lease().unwrap();
        let publication_before = store.recover("normal-main").unwrap().unwrap();
        drop(registry);
        drop(store);

        let receipt_path = root
            .path()
            .join("authority")
            .join("normal-main")
            .join("player-authority-command-receipt-v1.json");
        let mut envelope =
            serde_json::from_slice::<Value>(&std::fs::read(&receipt_path).unwrap()).unwrap();
        envelope
            .as_object_mut()
            .unwrap()
            .insert("unexpected".to_owned(), json!(true));
        std::fs::write(&receipt_path, serde_json::to_vec(&envelope).unwrap()).unwrap();

        let mut reopened_store = SaveStore::open(root.path()).unwrap();
        let mut reopened_registry = resumable_player_authority_registry_for_test();
        let error = reopened_registry
            .recover_player_authority_pending_command_on_startup(&mut reopened_store)
            .unwrap_err();
        assert!(format!("{error:#}").contains("unknown field"), "{error:#}");
        assert!(reopened_registry.sessions.is_empty());
        assert_eq!(
            reopened_store.require_exact_realtime_lease().unwrap(),
            lease_before
        );
        let publication_after = reopened_store.recover("normal-main").unwrap().unwrap();
        assert_eq!(publication_after.generation, publication_before.generation);
        assert_eq!(publication_after.root_hash, publication_before.root_hash);
        assert_eq!(publication_after.revision, publication_before.revision);
    }

    #[test]
    fn player_authority_restart_rejects_predictable_session_id_reuse() {
        let (root, store, registry, session_id, checkpoint) = player_authority_fixture();
        let old_binding = store.player_authority_session_binding(&session_id).unwrap();
        let lease_before = store.require_exact_realtime_lease().unwrap();
        drop(registry);
        drop(store);

        let mut reopened_store = SaveStore::open(root.path()).unwrap();
        let recovered = reopened_store.recover("normal-main").unwrap().unwrap();
        let mut reopened_registry = CoreRegistry::default();
        let reopened = reopened_registry
            .open(
                &reopened_store,
                "normal-main",
                recovered.generation,
                &recovered.root_hash,
                recovered.revision,
                &recovered.registry_fingerprint,
                player_authority_catalog(),
            )
            .unwrap();
        assert_eq!(reopened.session_id, session_id);
        assert_ne!(
            reopened_store
                .player_authority_session_binding(&reopened.session_id)
                .unwrap(),
            old_binding
        );

        let error = reopened_registry
            .commit_player_authority_tick(
                &mut reopened_store,
                &reopened.session_id,
                CoreCommitPlayerAuthorityTickRequest {
                    run_id: "player-authority-run".to_owned(),
                    sequence: 1,
                },
            )
            .unwrap_err();
        assert!(format!("{error:#}").contains("session/run identity conflicts"));
        assert_eq!(
            reopened_store.require_exact_realtime_lease().unwrap(),
            lease_before
        );
        let checkpoint_after = reopened_store.recover("normal-main").unwrap().unwrap();
        assert_eq!(checkpoint_after.generation, checkpoint.generation);
        assert_eq!(checkpoint_after.root_hash, checkpoint.root_hash);
        assert_eq!(checkpoint_after.revision, checkpoint.revision);
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
    fn player_authority_fuel_item_ack_publishes_one_same_revision_projection() {
        let (_root, mut store, mut registry, session_id, checkpoint) =
            player_authority_fuel_fixture();
        let committed = registry
            .commit_player_authority_command(
                &mut store,
                &session_id,
                player_authority_fuel_item_command(checkpoint.revision, "fuel-item-authority-ack"),
            )
            .unwrap();
        assert_eq!(committed.base_revision, checkpoint.revision);
        assert_eq!(committed.revision, checkpoint.revision + 1);
        assert_eq!(committed.changed_entity_ids, ["thermal-a"]);
        assert_eq!(
            committed.changed_belt_ids,
            ["belt-fuel-in", "belt-fuel-out"]
        );
        assert!(committed.topology_dirty);
        let lease = store.require_exact_realtime_lease().unwrap();
        assert!(lease.pending_command.is_none());
        assert_eq!(
            lease.acknowledged.command_id.as_deref(),
            Some("fuel-item-authority-ack")
        );
        assert_eq!(lease.acknowledged.revision, committed.revision);
        assert_eq!(
            lease.acknowledged.proof.canonical_sha256,
            committed.summary.canonical_sha256
        );

        let projection = registry
            .factory_read_model_projection(&session_id, &["thermal-a".to_owned()], &[])
            .unwrap();
        assert_eq!(projection["revision"], committed.revision);
        assert_eq!(
            projection["selection"]["entityRows"]["rows"][0]["fuelItemId"],
            "energetic_graphite"
        );
        assert_eq!(
            projection["selection"]["entityRows"]["rows"][0]["inputItems"]["totalCount"],
            0
        );
        assert_eq!(projection["shell"]["beltCount"], 0);
    }

    #[test]
    fn staged_fuel_item_intent_recovers_to_ack_and_same_revision_projection() {
        let (root, mut store, mut registry, session_id, checkpoint) =
            player_authority_fuel_fixture();
        let before = registry.status(&session_id).unwrap();
        let error = registry
            .commit_player_authority_command_internal(
                &mut store,
                &session_id,
                player_authority_fuel_item_command(
                    checkpoint.revision,
                    "fuel-item-staged-recovery",
                ),
                PlayerAuthorityCommandKind::Gameplay,
                PlayerAuthorityCommandFault::AfterStage,
            )
            .unwrap_err();
        assert!(format!("{error:#}").contains("lost response"));
        assert_eq!(
            registry.status(&session_id).unwrap().revision,
            checkpoint.revision
        );
        assert_eq!(
            registry.status(&session_id).unwrap().canonical_sha256,
            before.canonical_sha256
        );
        assert!(
            store
                .require_exact_realtime_lease()
                .unwrap()
                .pending_command
                .is_some()
        );
        drop(registry);
        drop(store);

        let mut reopened_store = SaveStore::open(root.path()).unwrap();
        let mut reopened_registry = resumable_player_authority_registry_for_test();
        let recovered = reopened_registry
            .recover_player_authority_pending_command_on_startup(&mut reopened_store)
            .unwrap()
            .expect("staged fuel intent must recover");
        assert_eq!(recovered.revision, checkpoint.revision + 1);
        assert_eq!(
            recovered.command_id.as_deref(),
            Some("fuel-item-staged-recovery")
        );
        assert_eq!(recovered.changed_entity_ids, ["thermal-a"]);
        assert!(recovered.topology_dirty);
        assert!(
            reopened_store
                .require_exact_realtime_lease()
                .unwrap()
                .pending_command
                .is_none()
        );
        let projection = reopened_registry
            .factory_read_model_projection(&recovered.session_id, &["thermal-a".to_owned()], &[])
            .unwrap();
        assert_eq!(projection["revision"], recovered.revision);
        assert_eq!(
            projection["selection"]["entityRows"]["rows"][0]["fuelItemId"],
            "energetic_graphite"
        );
        assert_eq!(projection["shell"]["beltCount"], 0);
    }

    #[test]
    fn fuel_item_semantic_intent_survives_generic_cold_wal_reopen() {
        let root = tempdir().unwrap();
        let mut store = SaveStore::open(root.path()).unwrap();
        let mut registry = CoreRegistry::default();
        let bytes = player_authority_fuel_envelope();
        let imported = registry
            .import_v47(
                &mut store,
                Cursor::new(bytes.clone()),
                bytes.len() as u64,
                EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT,
                player_authority_fuel_catalog(),
            )
            .unwrap();
        let checkpoint = imported.checkpoint.clone();
        let command = serde_json::from_value(json!({
            "protocolVersion": 1,
            "baseRevision": checkpoint.revision,
            "topLevelChanges": [],
            "changedEntities": [{
                "id": "thermal-a",
                "changes": [{
                    "path": ["fuelItemId"],
                    "operation": "set",
                    "value": "energetic_graphite"
                }]
            }],
            "addedEntities": [],
            "removedEntityIds": [],
            "changedBelts": [],
            "addedBelts": [],
            "removedBeltIds": []
        }))
        .unwrap();
        let committed = registry
            .commit_operation(
                &store,
                &imported.session_id,
                CoreCommitOperationRequest {
                    command_id: "fuel-item-before-cold-reopen".to_owned(),
                    base_revision: checkpoint.revision,
                    command: Some(command),
                    simulation_seconds: 0.0,
                    wall_seconds: 0.0,
                    advance_mode: CoreAdvanceMode::Exact,
                    include_diagnostics: true,
                },
            )
            .unwrap();
        let live_summary = committed
            .summary
            .as_ref()
            .expect("diagnostic commit must return the live summary");
        assert_eq!(committed.revision, checkpoint.revision + 1);
        registry
            .export_v47(&store, &imported.session_id, "fuel-item-live", 100)
            .unwrap();
        let live: Value = serde_json::from_slice(
            &std::fs::read(root.path().join("exports/fuel-item-live.json")).unwrap(),
        )
        .unwrap();
        let thermal = live["state"]["entities"]
            .as_array()
            .unwrap()
            .iter()
            .find(|entity| entity["id"] == "thermal-a")
            .unwrap();
        assert_eq!(thermal["fuelItemId"], "energetic_graphite");
        assert_eq!(thermal["inputs"], json!({}));
        assert_eq!(thermal["outputs"], json!({ "iron_ingot": 4 }));
        assert_eq!(thermal["fuelRemainingMj"], 3.25);
        assert_eq!(thermal["powerOutputKw"], 0);
        assert_eq!(thermal["powerInputKw"], 19);
        assert_eq!(live["state"]["tray"]["coal"], 9);
        assert_eq!(live["state"]["portableFleet"]["logistics_drone"], 21);
        assert_eq!(live["state"]["construction"]["conveyor_belt_mk1"], 9);
        assert_eq!(live["state"]["belts"], json!([]));
        let live_state = live["state"].clone();
        let live_hash = live_summary.canonical_sha256.clone();

        drop(registry);
        drop(store);

        let reopened_store = SaveStore::open(root.path()).unwrap();
        let mut reopened_registry = CoreRegistry::default();
        let reopened = reopened_registry
            .open(
                &reopened_store,
                &checkpoint.slot,
                checkpoint.generation,
                &checkpoint.root_hash,
                checkpoint.revision,
                EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT,
                player_authority_fuel_catalog(),
            )
            .unwrap();
        assert_eq!(reopened.replayed_wal_entries, 1);
        assert_eq!(reopened.replayed_revision, committed.revision);
        assert_eq!(reopened.summary.revision, committed.revision);
        assert_eq!(reopened.summary.canonical_sha256, live_hash);
        reopened_registry
            .export_v47(
                &reopened_store,
                &reopened.session_id,
                "fuel-item-replayed",
                100,
            )
            .unwrap();
        let replayed: Value = serde_json::from_slice(
            &std::fs::read(root.path().join("exports/fuel-item-replayed.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(replayed["state"], live_state);
    }

    #[test]
    fn station_inventory_semantic_intents_survive_generic_cold_wal_reopen() {
        let root = tempdir().unwrap();
        let mut store = SaveStore::open(root.path()).unwrap();
        let mut registry = CoreRegistry::default();
        let bytes = player_authority_station_inventory_envelope();
        let imported = registry
            .import_v47(
                &mut store,
                Cursor::new(bytes.clone()),
                bytes.len() as u64,
                EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT,
                player_authority_station_inventory_catalog(),
            )
            .unwrap();
        let checkpoint = imported.checkpoint.clone();
        let fleet_command = serde_json::from_value(json!({
            "protocolVersion": 1,
            "baseRevision": checkpoint.revision,
            "topLevelChanges": [],
            "changedEntities": [{
                "id": "station-ils",
                "changes": [{
                    "path": ["stationFleetTarget", "intent"],
                    "operation": "set",
                    "value": { "kind": "drone", "targetCount": 12 }
                }]
            }],
            "addedEntities": [],
            "removedEntityIds": [],
            "changedBelts": [],
            "addedBelts": [],
            "removedBeltIds": []
        }))
        .unwrap();
        let fleet = registry
            .commit_operation(
                &store,
                &imported.session_id,
                CoreCommitOperationRequest {
                    command_id: "station-fleet-before-cold-reopen".to_owned(),
                    base_revision: checkpoint.revision,
                    command: Some(fleet_command),
                    simulation_seconds: 0.0,
                    wall_seconds: 0.0,
                    advance_mode: CoreAdvanceMode::Exact,
                    include_diagnostics: true,
                },
            )
            .unwrap();
        let warper_command = serde_json::from_value(json!({
            "protocolVersion": 1,
            "baseRevision": fleet.revision,
            "topLevelChanges": [],
            "changedEntities": [{
                "id": "station-ils",
                "changes": [{
                    "path": ["stationWarperInventory", "intent"],
                    "operation": "set",
                    "value": { "delta": 20 }
                }]
            }],
            "addedEntities": [],
            "removedEntityIds": [],
            "changedBelts": [],
            "addedBelts": [],
            "removedBeltIds": []
        }))
        .unwrap();
        let warpers = registry
            .commit_operation(
                &store,
                &imported.session_id,
                CoreCommitOperationRequest {
                    command_id: "station-warpers-before-cold-reopen".to_owned(),
                    base_revision: fleet.revision,
                    command: Some(warper_command),
                    simulation_seconds: 0.0,
                    wall_seconds: 0.0,
                    advance_mode: CoreAdvanceMode::Exact,
                    include_diagnostics: true,
                },
            )
            .unwrap();
        let live_summary = warpers
            .summary
            .as_ref()
            .expect("diagnostic commit must return the live summary");
        assert_eq!(warpers.revision, checkpoint.revision + 2);

        let wal = store
            .read_wal(&checkpoint.slot, checkpoint.revision)
            .unwrap();
        assert_eq!(wal.len(), 2);
        let fleet_payload = serde_json::to_string(&wal[0].payload).unwrap();
        let warper_payload = serde_json::to_string(&wal[1].payload).unwrap();
        assert!(fleet_payload.contains("stationFleetTarget"));
        assert!(!fleet_payload.contains("portableFleet"));
        assert!(!fleet_payload.contains("stationProgress"));
        assert!(warper_payload.contains("stationWarperInventory"));
        assert!(!warper_payload.contains("space_warper"));
        assert!(!warper_payload.contains("stationWarpers"));

        registry
            .export_v47(&store, &imported.session_id, "station-intents-live", 100)
            .unwrap();
        let live: Value = serde_json::from_slice(
            &std::fs::read(root.path().join("exports/station-intents-live.json")).unwrap(),
        )
        .unwrap();
        let station = live["state"]["entities"]
            .as_array()
            .unwrap()
            .iter()
            .find(|entity| entity["id"] == "station-ils")
            .unwrap();
        let peer = live["state"]["entities"]
            .as_array()
            .unwrap()
            .iter()
            .find(|entity| entity["id"] == "station-peer")
            .unwrap();
        assert_eq!(station["stationDrones"], 10);
        assert_eq!(station["stationWarpers"], 10);
        assert_eq!(station["stationProgress"], 0);
        assert_eq!(peer["stationProgress"], 0);
        assert_eq!(peer["stationRoutes"].as_array().unwrap().len(), 2);
        assert_eq!(live["state"]["portableFleet"]["logistics_drone"], 0);
        assert_eq!(live["state"]["tray"]["space_warper"], 0);
        assert_eq!(live["state"]["tray"]["logistics_drone"], 41);
        let live_state = live["state"].clone();
        let live_hash = live_summary.canonical_sha256.clone();

        drop(registry);
        drop(store);
        let reopened_store = SaveStore::open(root.path()).unwrap();
        let mut reopened_registry = CoreRegistry::default();
        let reopened = reopened_registry
            .open(
                &reopened_store,
                &checkpoint.slot,
                checkpoint.generation,
                &checkpoint.root_hash,
                checkpoint.revision,
                EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT,
                player_authority_station_inventory_catalog(),
            )
            .unwrap();
        assert_eq!(reopened.replayed_wal_entries, 2);
        assert_eq!(reopened.replayed_revision, warpers.revision);
        assert_eq!(reopened.summary.canonical_sha256, live_hash);
        reopened_registry
            .export_v47(
                &reopened_store,
                &reopened.session_id,
                "station-intents-replayed",
                100,
            )
            .unwrap();
        let replayed: Value = serde_json::from_slice(
            &std::fs::read(root.path().join("exports/station-intents-replayed.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(replayed["state"], live_state);
    }

    #[test]
    fn construction_automation_semantic_intents_survive_generic_cold_wal_reopen() {
        let root = tempdir().unwrap();
        let mut store = SaveStore::open(root.path()).unwrap();
        let mut registry = CoreRegistry::default();
        let bytes = player_authority_construction_automation_envelope();
        let source: Value = serde_json::from_slice(&bytes).unwrap();
        let source_material_totals = ["iron_ingot", "space_warper", "logistics_drone"]
            .map(|item_id| construction_owned_material_total(&source["state"], item_id));
        let imported = registry
            .import_v47(
                &mut store,
                Cursor::new(bytes.clone()),
                bytes.len() as u64,
                EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT,
                player_authority_construction_automation_catalog(),
            )
            .unwrap();
        let checkpoint = imported.checkpoint.clone();

        let enabled_command = player_authority_construction_automation_intent_command(
            checkpoint.revision,
            "construction-enabled-before-cold-reopen",
            json!({ "kind": "enabled", "enabled": true }),
        )
        .command;
        let enabled = registry
            .commit_operation(
                &store,
                &imported.session_id,
                CoreCommitOperationRequest {
                    command_id: "construction-enabled-before-cold-reopen".to_owned(),
                    base_revision: checkpoint.revision,
                    command: Some(enabled_command),
                    simulation_seconds: 0.0,
                    wall_seconds: 0.0,
                    advance_mode: CoreAdvanceMode::Exact,
                    include_diagnostics: true,
                },
            )
            .unwrap();
        let quantum_command = player_authority_construction_automation_intent_command(
            enabled.revision,
            "construction-quantum-before-cold-reopen",
            json!({ "kind": "quantumSupplyEnabled", "enabled": true }),
        )
        .command;
        let quantum = registry
            .commit_operation(
                &store,
                &imported.session_id,
                CoreCommitOperationRequest {
                    command_id: "construction-quantum-before-cold-reopen".to_owned(),
                    base_revision: enabled.revision,
                    command: Some(quantum_command),
                    simulation_seconds: 0.0,
                    wall_seconds: 0.0,
                    advance_mode: CoreAdvanceMode::Exact,
                    include_diagnostics: true,
                },
            )
            .unwrap();
        let stock_command = player_authority_construction_automation_intent_command(
            quantum.revision,
            "construction-stock-before-cold-reopen",
            json!({
                "kind": "targetStock",
                "targetId": "logistics_vessel",
                "target": 500
            }),
        )
        .command;
        let stock = registry
            .commit_operation(
                &store,
                &imported.session_id,
                CoreCommitOperationRequest {
                    command_id: "construction-stock-before-cold-reopen".to_owned(),
                    base_revision: quantum.revision,
                    command: Some(stock_command),
                    simulation_seconds: 0.0,
                    wall_seconds: 0.0,
                    advance_mode: CoreAdvanceMode::Exact,
                    include_diagnostics: true,
                },
            )
            .unwrap();
        let clear_command = player_authority_construction_automation_intent_command(
            stock.revision,
            "construction-clear-before-cold-reopen",
            json!({
                "kind": "targetStock",
                "targetId": "arc_smelter",
                "target": 0
            }),
        )
        .command;
        let cleared = registry
            .commit_operation(
                &store,
                &imported.session_id,
                CoreCommitOperationRequest {
                    command_id: "construction-clear-before-cold-reopen".to_owned(),
                    base_revision: stock.revision,
                    command: Some(clear_command),
                    simulation_seconds: 0.0,
                    wall_seconds: 0.0,
                    advance_mode: CoreAdvanceMode::Exact,
                    include_diagnostics: true,
                },
            )
            .unwrap();
        assert_eq!(cleared.revision, checkpoint.revision + 4);

        let wal = store
            .read_wal(&checkpoint.slot, checkpoint.revision)
            .unwrap();
        assert_eq!(wal.len(), 4);
        let wal_payload = serde_json::to_string(&wal).unwrap();
        assert!(wal_payload.contains("constructionAutomation"));
        assert!(wal_payload.contains("quantumSupplyEnabled"));
        assert!(wal_payload.contains("logistics_vessel"));
        assert!(!wal_payload.contains("quantumMaterialBuffer"));
        assert!(!wal_payload.contains("construction-center-a"));
        assert!(!wal_payload.contains("constructionQueue"));
        assert!(!wal_payload.contains("portableFleet"));

        registry
            .export_v47(
                &store,
                &imported.session_id,
                "construction-intents-live",
                100,
            )
            .unwrap();
        let live: Value = serde_json::from_slice(
            &std::fs::read(root.path().join("exports/construction-intents-live.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(live["state"]["constructionAutomation"]["enabled"], true);
        assert_eq!(
            live["state"]["constructionAutomation"]["quantumSourceEnabled"],
            true
        );
        assert_eq!(
            live["state"]["constructionAutomation"]["targetStock"]["logistics_vessel"],
            500
        );
        assert!(
            live["state"]["constructionAutomation"]["targetStock"]
                .get("arc_smelter")
                .is_none()
        );
        assert_eq!(
            live["state"]["constructionAutomation"]["jobs"]
                .as_object()
                .unwrap()
                .keys()
                .collect::<Vec<_>>(),
            vec!["construction-center-unrelated"]
        );
        assert!(
            live["state"]["constructionAutomation"]
                .get("quantumMaterialBuffer")
                .is_none()
        );
        assert_eq!(
            live["state"]["quantumLogisticsNetwork"]["inventory"]["iron_ingot"],
            "10000"
        );
        assert_eq!(
            live["state"]["quantumLogisticsNetwork"]["inventory"]["space_warper"],
            "10000"
        );
        assert_eq!(live["state"]["tray"]["iron_ingot"], 9);
        assert_eq!(live["state"]["planetTrays"]["ashen"]["iron_ingot"], 4);
        assert_eq!(live["state"]["planetTrays"]["ashen"]["space_warper"], 7);
        assert_eq!(live["state"]["portableFleet"]["logistics_drone"], 2);
        let center = live["state"]["entities"]
            .as_array()
            .unwrap()
            .iter()
            .find(|entity| entity["id"] == "construction-center-a")
            .unwrap();
        assert_eq!(center["inputs"]["iron_ingot"], 13);
        for (index, item_id) in ["iron_ingot", "space_warper", "logistics_drone"]
            .iter()
            .enumerate()
        {
            assert_eq!(
                construction_owned_material_total(&live["state"], item_id),
                source_material_totals[index],
                "{item_id}"
            );
        }
        let live_state = live["state"].clone();
        let live_hash = cleared.summary.as_ref().unwrap().canonical_sha256.clone();

        drop(registry);
        drop(store);
        let reopened_store = SaveStore::open(root.path()).unwrap();
        let mut reopened_registry = CoreRegistry::default();
        let reopened = reopened_registry
            .open(
                &reopened_store,
                &checkpoint.slot,
                checkpoint.generation,
                &checkpoint.root_hash,
                checkpoint.revision,
                EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT,
                player_authority_construction_automation_catalog(),
            )
            .unwrap();
        assert_eq!(reopened.replayed_wal_entries, 4);
        assert_eq!(reopened.replayed_revision, cleared.revision);
        assert_eq!(reopened.summary.canonical_sha256, live_hash);
        reopened_registry
            .export_v47(
                &reopened_store,
                &reopened.session_id,
                "construction-intents-replayed",
                100,
            )
            .unwrap();
        let replayed: Value = serde_json::from_slice(
            &std::fs::read(
                root.path()
                    .join("exports/construction-intents-replayed.json"),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(replayed["state"], live_state);
    }

    #[test]
    fn construction_automation_intents_are_atomic_across_host_durable_boundaries() {
        for (label, intent) in [
            ("enabled", json!({ "kind": "enabled", "enabled": true })),
            (
                "quantum",
                json!({ "kind": "quantumSupplyEnabled", "enabled": true }),
            ),
            (
                "target",
                json!({
                    "kind": "targetStock",
                    "targetId": "arc_smelter",
                    "target": 0
                }),
            ),
        ] {
            let command_id = format!("construction-{label}-boundary");
            let (_clean_root, mut clean_store, mut clean_registry, clean_session, checkpoint) =
                player_authority_construction_automation_fixture();
            let clean = clean_registry
                .commit_player_authority_command(
                    &mut clean_store,
                    &clean_session,
                    player_authority_construction_automation_intent_command(
                        checkpoint.revision,
                        &command_id,
                        intent.clone(),
                    ),
                )
                .unwrap_or_else(|error| panic!("{label}: {error:#}"));
            assert!(clean.changed_entity_ids.is_empty(), "{label}");
            assert!(clean.changed_belt_ids.is_empty(), "{label}");
            assert!(clean.topology_dirty, "{label}");

            for fault in [
                PlayerAuthorityCommandFault::AfterStage,
                PlayerAuthorityCommandFault::AfterWal,
                PlayerAuthorityCommandFault::AfterCheckpoint,
                PlayerAuthorityCommandFault::AfterReceipt,
                PlayerAuthorityCommandFault::AfterLeaseAcknowledge,
            ] {
                let (_root, mut store, mut registry, session_id, checkpoint) =
                    player_authority_construction_automation_fixture();
                let before = registry.status(&session_id).unwrap();
                let request = || {
                    player_authority_construction_automation_intent_command(
                        checkpoint.revision,
                        &command_id,
                        intent.clone(),
                    )
                };
                let error = registry
                    .commit_player_authority_command_internal(
                        &mut store,
                        &session_id,
                        request(),
                        PlayerAuthorityCommandKind::Gameplay,
                        fault,
                    )
                    .unwrap_err();
                assert!(
                    format!("{error:#}").contains("lost response"),
                    "{label}/{fault:?}: {error:#}"
                );
                if fault == PlayerAuthorityCommandFault::AfterStage {
                    let after = registry.status(&session_id).unwrap();
                    assert_eq!(after.revision, before.revision, "{label}");
                    assert_eq!(after.canonical_sha256, before.canonical_sha256, "{label}");
                }

                drop(registry);
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
                        player_authority_construction_automation_catalog(),
                    )
                    .unwrap();
                let recovered = reopened
                    .commit_player_authority_command(&mut store, &opened.session_id, request())
                    .unwrap_or_else(|error| panic!("{label}/{fault:?}: {error:#}"));
                assert!(recovered.duplicate, "{label}/{fault:?}");
                assert_eq!(recovered.revision, clean.revision, "{label}/{fault:?}");
                assert_eq!(
                    recovered.summary.canonical_sha256, clean.summary.canonical_sha256,
                    "{label}/{fault:?}"
                );
                assert!(recovered.changed_entity_ids.is_empty(), "{label}/{fault:?}");
                assert!(recovered.changed_belt_ids.is_empty(), "{label}/{fault:?}");
                assert!(recovered.topology_dirty, "{label}/{fault:?}");
                let lease = store.require_exact_realtime_lease().unwrap();
                assert_eq!(
                    lease.acknowledged.revision, recovered.revision,
                    "{label}/{fault:?}"
                );
                assert!(lease.pending_command.is_none(), "{label}/{fault:?}");
            }
        }
    }

    #[test]
    fn station_slot_semantic_intents_survive_host_generic_wal_cold_reopen() {
        let root = tempdir().unwrap();
        let mut store = SaveStore::open(root.path()).unwrap();
        let mut registry = CoreRegistry::default();
        let bytes = player_authority_station_slot_envelope();
        let imported = registry
            .import_v47(
                &mut store,
                Cursor::new(bytes.clone()),
                bytes.len() as u64,
                EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT,
                player_authority_station_inventory_catalog(),
            )
            .unwrap();
        let checkpoint = imported.checkpoint.clone();
        let mode_command = serde_json::from_value(json!({
            "protocolVersion": 1,
            "baseRevision": checkpoint.revision,
            "topLevelChanges": [],
            "changedEntities": [{
                "id": "station-ils",
                "changes": [{
                    "path": ["stationSlotMode", "intent"],
                    "operation": "set",
                    "value": { "slotIndex": 0, "scope": "remote", "mode": "storage" }
                }]
            }],
            "addedEntities": [],
            "removedEntityIds": [],
            "changedBelts": [],
            "addedBelts": [],
            "removedBeltIds": []
        }))
        .unwrap();
        let mode = registry
            .commit_operation(
                &store,
                &imported.session_id,
                CoreCommitOperationRequest {
                    command_id: "station-slot-mode-before-cold-reopen".to_owned(),
                    base_revision: checkpoint.revision,
                    command: Some(mode_command),
                    simulation_seconds: 0.0,
                    wall_seconds: 0.0,
                    advance_mode: CoreAdvanceMode::Exact,
                    include_diagnostics: true,
                },
            )
            .unwrap();
        let item_command = serde_json::from_value(json!({
            "protocolVersion": 1,
            "baseRevision": mode.revision,
            "topLevelChanges": [],
            "changedEntities": [{
                "id": "station-ils",
                "changes": [{
                    "path": ["stationSlotItem", "intent"],
                    "operation": "set",
                    "value": { "slotIndex": 0, "itemId": "iron_ingot" }
                }]
            }],
            "addedEntities": [],
            "removedEntityIds": [],
            "changedBelts": [],
            "addedBelts": [],
            "removedBeltIds": []
        }))
        .unwrap();
        let item = registry
            .commit_operation(
                &store,
                &imported.session_id,
                CoreCommitOperationRequest {
                    command_id: "station-slot-item-before-cold-reopen".to_owned(),
                    base_revision: mode.revision,
                    command: Some(item_command),
                    simulation_seconds: 0.0,
                    wall_seconds: 0.0,
                    advance_mode: CoreAdvanceMode::Exact,
                    include_diagnostics: true,
                },
            )
            .unwrap();
        let live_summary = item.summary.as_ref().unwrap();
        assert_eq!(item.revision, checkpoint.revision + 2);

        let wal = store
            .read_wal(&checkpoint.slot, checkpoint.revision)
            .unwrap();
        assert_eq!(wal.len(), 2);
        let mode_payload = serde_json::to_string(&wal[0].payload).unwrap();
        let item_payload = serde_json::to_string(&wal[1].payload).unwrap();
        assert!(mode_payload.contains("stationSlotMode"));
        assert!(!mode_payload.contains("stationRoutes"));
        assert!(!mode_payload.contains("stationWarpers"));
        assert!(item_payload.contains("stationSlotItem"));
        assert!(!item_payload.contains("stationSlots"));
        assert!(!item_payload.contains("stationProgress"));
        assert!(!item_payload.contains("planetTrays"));
        assert!(!item_payload.contains("quantumLogisticsNetwork"));

        registry
            .export_v47(&store, &imported.session_id, "station-slot-live", 100)
            .unwrap();
        let live: Value = serde_json::from_slice(
            &std::fs::read(root.path().join("exports/station-slot-live.json")).unwrap(),
        )
        .unwrap();
        let station = live["state"]["entities"]
            .as_array()
            .unwrap()
            .iter()
            .find(|entity| entity["id"] == "station-ils")
            .unwrap();
        let peer = live["state"]["entities"]
            .as_array()
            .unwrap()
            .iter()
            .find(|entity| entity["id"] == "station-peer")
            .unwrap();
        assert_eq!(station["stationSlots"][0]["itemId"], "iron_ingot");
        assert_eq!(station["stationSlots"][0]["remoteMode"], "supply");
        assert_eq!(station["storedItemId"], "iron_ingot");
        assert_eq!(station["stationMode"], "supply");
        assert_eq!(station["stationProgress"], 0);
        assert_eq!(station["stationWarpers"], 1);
        assert_eq!(station["outputs"]["iron_ore"], 0);
        assert_eq!(station["quantumMaterialBuffer"], json!({ "hydrogen": 123 }));
        assert_eq!(
            station["stationSlots"][0]["slotPayload"],
            json!({ "owner": "future:slot", "index": 0 })
        );
        assert_eq!(peer["stationRoutes"], json!([]));
        assert_eq!(peer["stationProgress"], 0);
        assert_eq!(
            live["state"]["portableFleet"],
            json!({
                "logistics_drone": 3,
                "logistics_vessel": 2
            })
        );
        assert_eq!(
            live["state"]["quantumLogisticsNetwork"],
            json!({
                "enabled": true,
                "inventory": { "iron_ore": "25000", "iron_ingot": "1234" },
                "itemCapacities": { "iron_ore": "100000", "iron_ingot": "100000" },
                "routingCursors": { "iron_ore": 17 },
                "uploadRoutingCursors": { "iron_ingot": 23 }
            })
        );
        let live_state = live["state"].clone();
        let live_hash = live_summary.canonical_sha256.clone();

        drop(registry);
        drop(store);
        let reopened_store = SaveStore::open(root.path()).unwrap();
        let mut reopened_registry = CoreRegistry::default();
        let reopened = reopened_registry
            .open(
                &reopened_store,
                &checkpoint.slot,
                checkpoint.generation,
                &checkpoint.root_hash,
                checkpoint.revision,
                EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT,
                player_authority_station_inventory_catalog(),
            )
            .unwrap();
        assert_eq!(reopened.replayed_wal_entries, 2);
        assert_eq!(reopened.replayed_revision, item.revision);
        assert_eq!(reopened.summary.canonical_sha256, live_hash);
        reopened_registry
            .export_v47(
                &reopened_store,
                &reopened.session_id,
                "station-slot-replayed",
                100,
            )
            .unwrap();
        let replayed: Value = serde_json::from_slice(
            &std::fs::read(root.path().join("exports/station-slot-replayed.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(replayed["state"], live_state);
    }

    #[test]
    fn station_slot_item_intent_is_atomic_across_host_durable_boundaries() {
        let (_clean_root, mut clean_store, mut clean_registry, clean_session, checkpoint) =
            player_authority_station_slot_fixture();
        let clean = clean_registry
            .commit_player_authority_command(
                &mut clean_store,
                &clean_session,
                player_authority_station_slot_item_intent_command(
                    checkpoint.revision,
                    "station-slot-item-boundary",
                ),
            )
            .unwrap();
        assert_eq!(clean.changed_entity_ids, ["station-ils", "station-peer"]);
        assert!(clean.changed_belt_ids.is_empty());
        assert!(clean.topology_dirty);

        for fault in [
            PlayerAuthorityCommandFault::AfterStage,
            PlayerAuthorityCommandFault::AfterWal,
            PlayerAuthorityCommandFault::AfterCheckpoint,
            PlayerAuthorityCommandFault::AfterReceipt,
            PlayerAuthorityCommandFault::AfterLeaseAcknowledge,
        ] {
            let (_root, mut store, mut registry, session_id, checkpoint) =
                player_authority_station_slot_fixture();
            let before = registry.status(&session_id).unwrap();
            let request = || {
                player_authority_station_slot_item_intent_command(
                    checkpoint.revision,
                    "station-slot-item-boundary",
                )
            };
            let error = registry
                .commit_player_authority_command_internal(
                    &mut store,
                    &session_id,
                    request(),
                    PlayerAuthorityCommandKind::Gameplay,
                    fault,
                )
                .unwrap_err();
            assert!(
                format!("{error:#}").contains("lost response"),
                "{fault:?}: {error:#}"
            );
            if fault == PlayerAuthorityCommandFault::AfterStage {
                let after = registry.status(&session_id).unwrap();
                assert_eq!(after.revision, before.revision);
                assert_eq!(after.canonical_sha256, before.canonical_sha256);
            }

            drop(registry);
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
                    player_authority_station_inventory_catalog(),
                )
                .unwrap();
            let recovered = reopened
                .commit_player_authority_command(&mut store, &opened.session_id, request())
                .unwrap_or_else(|error| panic!("{fault:?}: {error:#}"));
            assert!(recovered.duplicate, "{fault:?}");
            assert_eq!(recovered.revision, clean.revision, "{fault:?}");
            assert_eq!(
                recovered.summary.canonical_sha256, clean.summary.canonical_sha256,
                "{fault:?}"
            );
            assert!(
                recovered
                    .changed_entity_ids
                    .iter()
                    .any(|id| id == "station-ils"),
                "{fault:?}"
            );
            assert!(recovered.changed_belt_ids.is_empty(), "{fault:?}");
            assert!(recovered.topology_dirty, "{fault:?}");
            let lease = store.require_exact_realtime_lease().unwrap();
            assert_eq!(lease.acknowledged.revision, recovered.revision, "{fault:?}");
            assert!(lease.pending_command.is_none(), "{fault:?}");
        }
    }

    #[test]
    fn station_fleet_intent_is_atomic_across_every_host_durable_boundary() {
        let (_clean_root, mut clean_store, mut clean_registry, clean_session, checkpoint) =
            player_authority_station_inventory_fixture();
        let clean = clean_registry
            .commit_player_authority_command(
                &mut clean_store,
                &clean_session,
                player_authority_station_fleet_intent_command(
                    checkpoint.revision,
                    "station-fleet-boundary",
                ),
            )
            .unwrap();
        assert_eq!(
            clean.changed_entity_ids,
            ["station-ils".to_owned(), "station-peer".to_owned()]
        );
        assert!(clean.changed_belt_ids.is_empty());
        assert!(!clean.topology_dirty);

        for fault in [
            PlayerAuthorityCommandFault::AfterStage,
            PlayerAuthorityCommandFault::AfterWal,
            PlayerAuthorityCommandFault::AfterCheckpoint,
            PlayerAuthorityCommandFault::AfterReceipt,
            PlayerAuthorityCommandFault::AfterLeaseAcknowledge,
        ] {
            let (_root, mut store, mut registry, session_id, checkpoint) =
                player_authority_station_inventory_fixture();
            let before = registry.status(&session_id).unwrap();
            let request = || {
                player_authority_station_fleet_intent_command(
                    checkpoint.revision,
                    "station-fleet-boundary",
                )
            };
            let error = registry
                .commit_player_authority_command_internal(
                    &mut store,
                    &session_id,
                    request(),
                    PlayerAuthorityCommandKind::Gameplay,
                    fault,
                )
                .unwrap_err();
            assert!(
                format!("{error:#}").contains("lost response"),
                "{fault:?}: {error:#}"
            );
            if fault == PlayerAuthorityCommandFault::AfterStage {
                let after = registry.status(&session_id).unwrap();
                assert_eq!(after.revision, before.revision);
                assert_eq!(after.canonical_sha256, before.canonical_sha256);
            }

            drop(registry);
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
                    player_authority_station_inventory_catalog(),
                )
                .unwrap();
            let recovered = reopened
                .commit_player_authority_command(&mut store, &opened.session_id, request())
                .unwrap_or_else(|error| panic!("{fault:?}: {error:#}"));
            assert!(recovered.duplicate, "{fault:?}");
            assert_eq!(recovered.revision, clean.revision, "{fault:?}");
            assert_eq!(
                recovered.summary.canonical_sha256, clean.summary.canonical_sha256,
                "{fault:?}"
            );
            assert_eq!(
                recovered.changed_entity_ids, clean.changed_entity_ids,
                "{fault:?}"
            );
            assert!(recovered.changed_belt_ids.is_empty(), "{fault:?}");
            assert!(!recovered.topology_dirty, "{fault:?}");
            let lease = store.require_exact_realtime_lease().unwrap();
            assert_eq!(lease.acknowledged.revision, recovered.revision, "{fault:?}");
            assert!(lease.pending_command.is_none(), "{fault:?}");
        }
    }

    #[test]
    fn station_warper_intent_keeps_exact_receipt_after_wal_boundary_restart() {
        let (_clean_root, mut clean_store, mut clean_registry, clean_session, checkpoint) =
            player_authority_station_inventory_fixture();
        let clean = clean_registry
            .commit_player_authority_command(
                &mut clean_store,
                &clean_session,
                player_authority_station_warper_intent_command(
                    checkpoint.revision,
                    "station-warper-boundary",
                ),
            )
            .unwrap();
        assert_eq!(clean.changed_entity_ids, ["station-ils"]);
        assert!(clean.changed_belt_ids.is_empty());
        assert!(!clean.topology_dirty);

        let (_root, mut store, mut registry, session_id, checkpoint) =
            player_authority_station_inventory_fixture();
        let request = || {
            player_authority_station_warper_intent_command(
                checkpoint.revision,
                "station-warper-boundary",
            )
        };
        let error = registry
            .commit_player_authority_command_internal(
                &mut store,
                &session_id,
                request(),
                PlayerAuthorityCommandKind::Gameplay,
                PlayerAuthorityCommandFault::AfterWal,
            )
            .unwrap_err();
        assert!(format!("{error:#}").contains("lost response"));
        drop(registry);

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
                player_authority_station_inventory_catalog(),
            )
            .unwrap();
        let recovered = reopened
            .commit_player_authority_command(&mut store, &opened.session_id, request())
            .unwrap();
        assert!(recovered.duplicate);
        assert_eq!(
            recovered.summary.canonical_sha256,
            clean.summary.canonical_sha256
        );
        assert_eq!(recovered.changed_entity_ids, clean.changed_entity_ids);
        assert!(recovered.changed_belt_ids.is_empty());
        assert!(!recovered.topology_dirty);
    }

    #[test]
    fn ejector_target_leaf_survives_host_wal_cold_reopen() {
        let root = tempdir().unwrap();
        let mut store = SaveStore::open(root.path()).unwrap();
        let mut registry = CoreRegistry::default();
        let mut catalog = player_authority_catalog();
        catalog["items"]
            .as_array_mut()
            .unwrap()
            .push(json!({ "id": "solar_sail", "name": "solar_sail", "kind": "solid" }));
        catalog["buildings"].as_array_mut().unwrap().push(json!({
            "id": "em_rail_ejector",
            "kind": "machine",
            "speed": 1,
            "inputCapacity": 100,
            "outputCapacity": 0,
            "powerDemandKw": 1,
            "powerGenerationKw": 0
        }));
        catalog["recipes"].as_array_mut().unwrap().push(json!({
            "id": "solar_sail_launch",
            "buildingId": "em_rail_ejector",
            "duration": 1,
            "inputs": [{ "itemId": "solar_sail", "amount": 1 }],
            "outputs": []
        }));
        catalog["constructions"]
            .as_array_mut()
            .unwrap()
            .push(json!({
                "id": "em_rail_ejector",
                "outputAmount": 1,
                "costs": [{ "itemId": "iron_ingot", "amount": 1 }]
            }));

        let mut envelope: Value = serde_json::from_slice(&import_envelope()).unwrap();
        envelope["state"]["dysonEngineering"]["orbitsBySystem"]["helios"]
            .as_array_mut()
            .unwrap()
            .push(json!({
                "id": "orbit-new",
                "name": "new",
                "radius": 18000,
                "inclination": 12,
                "longitude": 24,
                "sailsInOrbit": 0,
                "totalLaunched": 0,
                "totalExpired": 0,
                "decayProgress": 0,
                "generationKw": 0
            }));
        envelope["state"]["entities"]
            .as_array_mut()
            .unwrap()
            .push(json!({
                "id": "ejector-a",
                "kind": "machine",
                "planetId": "home",
                "position": { "x": 7, "y": 2 },
                "interactionLocked": false,
                "buildingId": "em_rail_ejector",
                "recipeId": "solar_sail_launch",
                "targetDysonOrbitId": "test-orbit-helios",
                "machineCount": 1,
                "minerCount": 0,
                "inputs": {},
                "outputs": {},
                "progress": 0,
                "routingCursor": 0,
                "utilization": 0,
                "productionRate": 0
            }));
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
                EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT,
                catalog.clone(),
            )
            .unwrap();
        let checkpoint = imported.checkpoint.clone();
        let command = serde_json::from_value(json!({
            "protocolVersion": 1,
            "baseRevision": checkpoint.revision,
            "topLevelChanges": [],
            "changedEntities": [{
                "id": "ejector-a",
                "changes": [{
                    "path": ["targetDysonOrbitId"],
                    "operation": "set",
                    "value": "orbit-new"
                }]
            }],
            "addedEntities": [],
            "removedEntityIds": [],
            "changedBelts": [],
            "addedBelts": [],
            "removedBeltIds": []
        }))
        .unwrap();
        let committed = registry
            .commit_operation(
                &store,
                &imported.session_id,
                CoreCommitOperationRequest {
                    command_id: "ejector-target-before-cold-reopen".to_owned(),
                    base_revision: checkpoint.revision,
                    command: Some(command),
                    simulation_seconds: 0.0,
                    wall_seconds: 0.0,
                    advance_mode: CoreAdvanceMode::Exact,
                    include_diagnostics: true,
                },
            )
            .unwrap();
        let live_hash = committed
            .summary
            .as_ref()
            .expect("diagnostic commit must return the live summary")
            .canonical_sha256
            .clone();
        registry
            .export_v47(&store, &imported.session_id, "ejector-target-live", 100)
            .unwrap();
        let live: Value = serde_json::from_slice(
            &std::fs::read(root.path().join("exports/ejector-target-live.json")).unwrap(),
        )
        .unwrap();
        let ejector = live["state"]["entities"]
            .as_array()
            .unwrap()
            .iter()
            .find(|entity| entity["id"] == "ejector-a")
            .unwrap();
        assert_eq!(ejector["targetDysonOrbitId"], "orbit-new");
        let live_state = live["state"].clone();

        drop(registry);
        drop(store);

        let reopened_store = SaveStore::open(root.path()).unwrap();
        let mut reopened_registry = CoreRegistry::default();
        let reopened = reopened_registry
            .open(
                &reopened_store,
                &checkpoint.slot,
                checkpoint.generation,
                &checkpoint.root_hash,
                checkpoint.revision,
                EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT,
                catalog,
            )
            .unwrap();
        assert_eq!(reopened.replayed_wal_entries, 1);
        assert_eq!(reopened.replayed_revision, committed.revision);
        assert_eq!(reopened.summary.canonical_sha256, live_hash);
        reopened_registry
            .export_v47(
                &reopened_store,
                &reopened.session_id,
                "ejector-target-replayed",
                100,
            )
            .unwrap();
        let replayed: Value = serde_json::from_slice(
            &std::fs::read(root.path().join("exports/ejector-target-replayed.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(replayed["state"], live_state);
    }

    #[test]
    fn remote_station_configuration_and_legacy_hub_pair_survive_cold_wal_reopen() {
        let root = tempdir().unwrap();
        let mut store = SaveStore::open(root.path()).unwrap();
        let mut registry = CoreRegistry::default();
        let mut catalog = player_authority_catalog();
        catalog["planets"].as_array_mut().unwrap().push(json!({
            "id": "ashen",
            "name": "ashen",
            "systemId": "helios",
            "kind": "terrestrial",
            "orbitIndex": 2,
            "simulationOrder": 1,
            "orbitalYields": {},
        }));
        catalog["buildings"].as_array_mut().unwrap().push(json!({
            "id": "interstellar_logistics_station",
            "kind": "station",
            "speed": 1,
            "inputCapacity": 100_000_000,
            "outputCapacity": 100_000_000,
            "powerDemandKw": 0,
            "powerGenerationKw": 0
        }));

        let slots = Value::Array(
            (0..5)
                .map(|slot_index| {
                    json!({
                        "itemId": if slot_index == 0 { Some("iron_ore") } else { None },
                        "localMode": if slot_index == 0 { "supply" } else { "storage" },
                        "remoteMode": if slot_index == 0 { "demand" } else { "storage" },
                        "minimumLoad": 0.5,
                        "minStock": 0,
                        "maxStock": if slot_index == 0 { 1000 } else { 0 },
                        "priority": 1,
                        "routePolicy": "relay-preferred",
                        "warperBudget": 2
                    })
                })
                .collect(),
        );
        let preserved_route = json!({
            "id": "route-preserved-across-wal",
            "slotIndex": 0,
            "peerId": "station-peer",
            "itemId": "iron_ore",
            "scope": "remote",
            "cargo": 100,
            "vehicleCount": 1,
            "progress": 0.4,
            "duration": 10,
            "requiresWarp": true,
            "warpersPerVessel": 1,
            "vehicleStationId": "station-remote",
            "modPayload": { "opaque": "must-stay-in-checkpoint-only" }
        });
        let station = |id: &str, planet_id: &str, station_routes: Value| {
            json!({
                "id": id,
                "kind": "station",
                "planetId": planet_id,
                "position": { "x": 7, "y": 2 },
                "interactionLocked": false,
                "buildingId": "interstellar_logistics_station",
                "machineCount": 1,
                "minerCount": 0,
                "inputs": {},
                "outputs": { "iron_ore": 321 },
                "progress": 0,
                "routingCursor": 0,
                "utilization": 0,
                "productionRate": 0,
                "stationSlots": slots.clone(),
                "storedItemId": "iron_ore",
                "stationMode": "demand",
                "stationMinimumLoad": 0.5,
                "stationProgress": 0.4,
                "stationDrones": 5,
                "stationVessels": 2,
                "stationWarpers": 1,
                "stationPeerId": null,
                "stationRoutes": station_routes,
                "stationWarpEnabled": true,
                "stationWarperAutoRefill": false,
                "stationWarperTarget": 50,
                "stationHubEnabled": false,
                "stationHubPriority": 1
            })
        };
        let mut envelope: Value = serde_json::from_slice(&import_envelope()).unwrap();
        envelope["state"]["entities"]
            .as_array_mut()
            .unwrap()
            .extend([
                station(
                    "station-remote",
                    "ashen",
                    Value::Array(vec![preserved_route.clone()]),
                ),
                station("station-peer", "home", Value::Array(Vec::new())),
            ]);
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
                EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT,
                catalog.clone(),
            )
            .unwrap();
        let checkpoint = imported.checkpoint.clone();
        let remote_slot = serde_json::from_value(json!({
            "protocolVersion": 1,
            "baseRevision": checkpoint.revision,
            "topLevelChanges": [],
            "changedEntities": [{
                "id": "station-remote",
                "changes": [{
                    "path": ["stationSlots", 0, "priority"],
                    "operation": "set",
                    "value": 2
                }]
            }],
            "addedEntities": [],
            "removedEntityIds": [],
            "changedBelts": [],
            "addedBelts": [],
            "removedBeltIds": []
        }))
        .unwrap();
        let remote_committed = registry
            .commit_operation(
                &store,
                &imported.session_id,
                CoreCommitOperationRequest {
                    command_id: "remote-station-slot-before-cold-reopen".to_owned(),
                    base_revision: checkpoint.revision,
                    command: Some(remote_slot),
                    simulation_seconds: 0.0,
                    wall_seconds: 0.0,
                    advance_mode: CoreAdvanceMode::Exact,
                    include_diagnostics: true,
                },
            )
            .unwrap();
        let legacy_hub_pair = serde_json::from_value(json!({
            "protocolVersion": 1,
            "baseRevision": remote_committed.revision,
            "topLevelChanges": [],
            "changedEntities": [{
                "id": "station-remote",
                "changes": [
                    { "path": ["stationHubEnabled"], "operation": "set", "value": true },
                    { "path": ["stationHubPriority"], "operation": "set", "value": 2 }
                ]
            }],
            "addedEntities": [],
            "removedEntityIds": [],
            "changedBelts": [],
            "addedBelts": [],
            "removedBeltIds": []
        }))
        .unwrap();
        let committed = registry
            .commit_operation(
                &store,
                &imported.session_id,
                CoreCommitOperationRequest {
                    command_id: "legacy-hub-pair-before-cold-reopen".to_owned(),
                    base_revision: remote_committed.revision,
                    command: Some(legacy_hub_pair),
                    simulation_seconds: 0.0,
                    wall_seconds: 0.0,
                    advance_mode: CoreAdvanceMode::Exact,
                    include_diagnostics: true,
                },
            )
            .unwrap();
        let live_hash = committed.summary.as_ref().unwrap().canonical_sha256.clone();
        let projection = registry
            .factory_read_model_projection(
                &imported.session_id,
                &["station-remote".to_owned()],
                &[],
            )
            .unwrap();
        assert!(projection["selection"]["entityRows"]["rows"][0]["stationConfiguration"].is_null());
        assert!(
            !serde_json::to_string(&projection)
                .unwrap()
                .contains("stationRoutes")
        );
        registry
            .export_v47(&store, &imported.session_id, "station-live", 100)
            .unwrap();
        let live: Value = serde_json::from_slice(
            &std::fs::read(root.path().join("exports/station-live.json")).unwrap(),
        )
        .unwrap();
        let remote = live["state"]["entities"]
            .as_array()
            .unwrap()
            .iter()
            .find(|entity| entity["id"] == "station-remote")
            .unwrap();
        assert_eq!(remote["stationSlots"][0]["priority"], 2);
        assert_eq!(remote["stationHubEnabled"], true);
        assert_eq!(remote["stationHubPriority"], 2);
        assert_eq!(remote["outputs"]["iron_ore"], 321);
        assert_eq!(remote["stationRoutes"], Value::Array(vec![preserved_route]));
        let live_state = live["state"].clone();

        drop(registry);
        drop(store);
        let reopened_store = SaveStore::open(root.path()).unwrap();
        let mut reopened_registry = CoreRegistry::default();
        let reopened = reopened_registry
            .open(
                &reopened_store,
                &checkpoint.slot,
                checkpoint.generation,
                &checkpoint.root_hash,
                checkpoint.revision,
                EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT,
                catalog,
            )
            .unwrap();
        assert_eq!(reopened.replayed_wal_entries, 2);
        assert_eq!(reopened.replayed_revision, committed.revision);
        assert_eq!(reopened.summary.canonical_sha256, live_hash);
        reopened_registry
            .export_v47(
                &reopened_store,
                &reopened.session_id,
                "station-replayed",
                100,
            )
            .unwrap();
        let replayed: Value = serde_json::from_slice(
            &std::fs::read(root.path().join("exports/station-replayed.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(replayed["state"], live_state);
    }

    #[test]
    fn black_hole_pause_intent_survives_host_wal_cold_reopen_without_touching_ledgers() {
        let root = tempdir().unwrap();
        let mut store = SaveStore::open(root.path()).unwrap();
        let mut registry = CoreRegistry::default();
        let mut catalog = player_authority_catalog();
        catalog["buildings"].as_array_mut().unwrap().push(json!({
            "id": "micro_black_hole_connector",
            "kind": "machine",
            "speed": 1,
            "inputCapacity": 0,
            "outputCapacity": 0
        }));
        let mut envelope: Value = serde_json::from_slice(&import_envelope()).unwrap();
        envelope["state"]["entities"]
            .as_array_mut()
            .unwrap()
            .push(json!({
                "id": "black-hole-a",
                "kind": "machine",
                "planetId": "home",
                "position": { "x": 7, "y": 2 },
                "interactionLocked": false,
                "buildingId": "micro_black_hole_connector",
                "machineCount": 1,
                "minerCount": 0,
                "inputs": {},
                "outputs": {},
                "progress": 0,
                "routingCursor": 0,
                "utilization": 0,
                "productionRate": 0,
                "blackHolePaused": true,
                "blackHoleActivationConfirmed": false,
                "blackHolePorts": [
                    { "index": 0, "currentItemId": "iron_ore", "totalDestroyed": "12345678901234567890" },
                    { "index": 1, "totalDestroyed": "7" },
                    { "index": 2, "totalDestroyed": "0" }
                ]
            }));
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
                EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT,
                catalog.clone(),
            )
            .unwrap();
        let checkpoint = imported.checkpoint.clone();
        let command = serde_json::from_value(json!({
            "protocolVersion": 1,
            "baseRevision": checkpoint.revision,
            "topLevelChanges": [],
            "changedEntities": [{
                "id": "black-hole-a",
                "changes": [{
                    "path": ["blackHolePaused", "intent"],
                    "operation": "set",
                    "value": { "paused": false, "confirmActivation": true }
                }]
            }],
            "addedEntities": [],
            "removedEntityIds": [],
            "changedBelts": [],
            "addedBelts": [],
            "removedBeltIds": []
        }))
        .unwrap();
        let committed = registry
            .commit_operation(
                &store,
                &imported.session_id,
                CoreCommitOperationRequest {
                    command_id: "black-hole-before-cold-reopen".to_owned(),
                    base_revision: checkpoint.revision,
                    command: Some(command),
                    simulation_seconds: 0.0,
                    wall_seconds: 0.0,
                    advance_mode: CoreAdvanceMode::Exact,
                    include_diagnostics: true,
                },
            )
            .unwrap();
        let live_hash = committed
            .summary
            .as_ref()
            .expect("diagnostic commit must return the live summary")
            .canonical_sha256
            .clone();
        registry
            .export_v47(&store, &imported.session_id, "black-hole-live", 100)
            .unwrap();
        let live: Value = serde_json::from_slice(
            &std::fs::read(root.path().join("exports/black-hole-live.json")).unwrap(),
        )
        .unwrap();
        let black_hole = live["state"]["entities"]
            .as_array()
            .unwrap()
            .iter()
            .find(|entity| entity["id"] == "black-hole-a")
            .unwrap();
        assert_eq!(black_hole["blackHolePaused"], false);
        assert_eq!(black_hole["blackHoleActivationConfirmed"], true);
        assert_eq!(
            black_hole["blackHolePorts"][0]["totalDestroyed"],
            "12345678901234567890"
        );
        let live_state = live["state"].clone();

        drop(registry);
        drop(store);

        let reopened_store = SaveStore::open(root.path()).unwrap();
        let mut reopened_registry = CoreRegistry::default();
        let reopened = reopened_registry
            .open(
                &reopened_store,
                &checkpoint.slot,
                checkpoint.generation,
                &checkpoint.root_hash,
                checkpoint.revision,
                EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT,
                catalog,
            )
            .unwrap();
        assert_eq!(reopened.replayed_wal_entries, 1);
        assert_eq!(reopened.replayed_revision, committed.revision);
        assert_eq!(reopened.summary.canonical_sha256, live_hash);
        reopened_registry
            .export_v47(
                &reopened_store,
                &reopened.session_id,
                "black-hole-replayed",
                100,
            )
            .unwrap();
        let replayed: Value = serde_json::from_slice(
            &std::fs::read(root.path().join("exports/black-hole-replayed.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(replayed["state"], live_state);
    }

    #[test]
    fn manual_mining_semantic_intent_survives_cold_wal_reopen() {
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
        let checkpoint = imported.checkpoint.clone();
        let command = serde_json::from_value(json!({
            "protocolVersion": 1,
            "baseRevision": checkpoint.revision,
            "topLevelChanges": [],
            "changedEntities": [{
                "id": "vein",
                "changes": [{
                    "path": ["manualMine"],
                    "operation": "set",
                    "value": 1
                }]
            }],
            "addedEntities": [],
            "removedEntityIds": [],
            "changedBelts": [],
            "addedBelts": [],
            "removedBeltIds": []
        }))
        .unwrap();
        let committed = registry
            .commit_operation(
                &store,
                &imported.session_id,
                CoreCommitOperationRequest {
                    command_id: "manual-mine-before-cold-reopen".to_owned(),
                    base_revision: checkpoint.revision,
                    command: Some(command),
                    simulation_seconds: 0.0,
                    wall_seconds: 0.0,
                    advance_mode: CoreAdvanceMode::Exact,
                    include_diagnostics: true,
                },
            )
            .unwrap();
        let live_summary = committed
            .summary
            .as_ref()
            .expect("diagnostic commit must return the live summary");
        assert_eq!(committed.revision, checkpoint.revision + 1);
        registry
            .export_v47(&store, &imported.session_id, "manual-mine-live", 100)
            .unwrap();
        let live: Value = serde_json::from_slice(
            &std::fs::read(root.path().join("exports/manual-mine-live.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(live["state"]["entities"][0]["outputs"]["iron_ore"], 4);
        assert_eq!(live["state"]["manualMined"], 1);
        assert_eq!(live["state"]["totalProduced"]["iron_ore"], 1);
        let live_state = live["state"].clone();
        let live_hash = live_summary.canonical_sha256.clone();

        drop(registry);
        drop(store);

        let reopened_store = SaveStore::open(root.path()).unwrap();
        let mut reopened_registry = CoreRegistry::default();
        let reopened = reopened_registry
            .open(
                &reopened_store,
                &checkpoint.slot,
                checkpoint.generation,
                &checkpoint.root_hash,
                checkpoint.revision,
                "builtin:test",
                import_catalog(),
            )
            .unwrap();
        assert_eq!(reopened.replayed_wal_entries, 1);
        assert_eq!(reopened.replayed_revision, committed.revision);
        assert_eq!(reopened.summary.revision, committed.revision);
        assert_eq!(reopened.summary.canonical_sha256, live_hash);
        reopened_registry
            .export_v47(
                &reopened_store,
                &reopened.session_id,
                "manual-mine-replayed",
                100,
            )
            .unwrap();
        let replayed: Value = serde_json::from_slice(
            &std::fs::read(root.path().join("exports/manual-mine-replayed.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(replayed["state"], live_state);
        assert_eq!(
            replayed["state"]["entities"][0]["outputs"]["iron_ore"],
            live["state"]["entities"][0]["outputs"]["iron_ore"]
        );
        assert_eq!(
            replayed["state"]["manualMined"],
            live["state"]["manualMined"]
        );
        assert_eq!(
            replayed["state"]["totalProduced"]["iron_ore"],
            live["state"]["totalProduced"]["iron_ore"]
        );
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
    fn player_authority_macro_lifecycle_is_durable_idempotent_and_fences_exact_events() {
        let (_root, mut store, mut registry, session_id, entry_checkpoint) =
            player_authority_macro_fixture();
        let request = || {
            player_authority_macro_request(
                entry_checkpoint.revision,
                "macro-session-1",
                "macro-operation-1",
            )
        };

        let committed = registry
            .commit_player_authority_macro_advance(&mut store, &session_id, request())
            .unwrap();
        let revision_span = committed.revision - entry_checkpoint.revision;
        assert!((1..=3).contains(&revision_span));
        assert_eq!(committed.acknowledged_sequence, revision_span);
        assert_eq!(committed.settled_deadline_ms, 46_000);
        assert_eq!(committed.checkpoint.revision, committed.revision);
        assert_eq!(committed.macro_session_id, "macro-session-1");
        assert_eq!(committed.operation_id, "macro-operation-1");
        assert!(!committed.algorithm_version.is_empty());
        assert!(!committed.duplicate);
        let committed_hash = committed.summary.canonical_sha256.clone();
        let committed_checkpoint = committed.checkpoint.clone();
        let lease = store.require_exact_realtime_lease().unwrap();
        assert!(lease.pending_advance.is_none());
        assert_eq!(
            lease.macro_session.as_ref().unwrap().session_id,
            "macro-session-1"
        );
        assert_eq!(lease.acknowledged.sequence, revision_span);
        assert_eq!(lease.acknowledged.revision, committed.revision);

        let duplicate = registry
            .commit_player_authority_macro_advance(&mut store, &session_id, request())
            .unwrap();
        assert!(duplicate.duplicate);
        assert_eq!(duplicate.checkpoint, committed_checkpoint);
        assert_eq!(duplicate.summary.canonical_sha256, committed_hash);

        let tick_error = registry
            .commit_player_authority_tick(
                &mut store,
                &session_id,
                CoreCommitPlayerAuthorityTickRequest {
                    run_id: "player-authority-run".to_owned(),
                    sequence: revision_span + 1,
                },
            )
            .unwrap_err();
        assert!(format!("{tick_error:#}").contains("macro session"));
        let command_error = registry
            .commit_player_authority_command(
                &mut store,
                &session_id,
                player_authority_command(committed.revision, "command-during-macro", json!(3)),
            )
            .unwrap_err();
        assert!(format!("{command_error:#}").contains("macro session"));

        let finish = || CoreFinishPlayerAuthorityMacroSessionRequest {
            run_id: "player-authority-run".to_owned(),
            macro_session_id: "macro-session-1".to_owned(),
        };
        let finished = registry
            .finish_player_authority_macro_session(&mut store, &session_id, finish())
            .unwrap();
        assert!(finished.lease.macro_session.is_none());
        assert_eq!(
            finished.lease.last_finished_macro_session_id.as_deref(),
            Some("macro-session-1")
        );
        assert_eq!(
            finished.lease.last_finished_macro_revision,
            Some(committed.revision)
        );
        let finished_retry = registry
            .finish_player_authority_macro_session(&mut store, &session_id, finish())
            .unwrap();
        assert_eq!(finished_retry.lease, finished.lease);

        let tick = registry
            .commit_player_authority_tick(
                &mut store,
                &session_id,
                CoreCommitPlayerAuthorityTickRequest {
                    run_id: "player-authority-run".to_owned(),
                    sequence: revision_span + 1,
                },
            )
            .unwrap();
        assert_eq!(tick.revision, committed.revision + 1);
        let after_tick = store.require_exact_realtime_lease().unwrap();
        assert_eq!(
            after_tick.last_finished_macro_session_id.as_deref(),
            Some("macro-session-1")
        );
        assert_eq!(
            after_tick.last_finished_macro_revision,
            Some(committed.revision)
        );
        registry
            .commit_player_authority_macro_advance(
                &mut store,
                &session_id,
                player_authority_macro_request(
                    tick.revision,
                    "macro-session-2",
                    "macro-operation-2",
                ),
            )
            .unwrap();
        let next_macro = store.require_exact_realtime_lease().unwrap();
        assert!(next_macro.last_finished_macro_session_id.is_none());
        assert!(next_macro.last_finished_macro_revision.is_none());
    }

    #[test]
    fn finished_macro_cleanup_survives_restart_and_retires_with_disable_ack() {
        let (root, mut store, mut registry, session_id, entry_checkpoint) =
            player_authority_macro_fixture();
        let committed = registry
            .commit_player_authority_macro_advance(
                &mut store,
                &session_id,
                player_authority_macro_request(
                    entry_checkpoint.revision,
                    "macro-session-cleanup",
                    "macro-operation-cleanup",
                ),
            )
            .unwrap();
        registry
            .finish_player_authority_macro_session(
                &mut store,
                &session_id,
                CoreFinishPlayerAuthorityMacroSessionRequest {
                    run_id: "player-authority-run".to_owned(),
                    macro_session_id: "macro-session-cleanup".to_owned(),
                },
            )
            .unwrap();
        drop(registry);
        drop(store);

        let mut restarted_store = SaveStore::open(root.path()).unwrap();
        let mut restarted_registry = resumable_player_authority_registry_for_test();
        let finish_receipt = restarted_registry
            .recover_player_authority_pending_command_on_startup(&mut restarted_store)
            .unwrap()
            .expect("finished macro cleanup must survive host restart");
        assert_eq!(finish_receipt.run_id, "player-authority-run");
        assert_eq!(
            finish_receipt.pending_macro_cleanup_session_id.as_deref(),
            Some("macro-session-cleanup")
        );
        assert_eq!(
            finish_receipt.pending_macro_cleanup_revision,
            Some(committed.revision)
        );
        assert_eq!(finish_receipt.revision, committed.revision);

        let tick = restarted_registry
            .commit_player_authority_tick(
                &mut restarted_store,
                &finish_receipt.session_id,
                CoreCommitPlayerAuthorityTickRequest {
                    run_id: "player-authority-run".to_owned(),
                    sequence: finish_receipt.next_sequence,
                },
            )
            .unwrap();
        assert_eq!(tick.revision, committed.revision + 1);
        drop(restarted_registry);
        drop(restarted_store);

        let mut advanced_store = SaveStore::open(root.path()).unwrap();
        let mut advanced_registry = resumable_player_authority_registry_for_test();
        let advanced_receipt = advanced_registry
            .recover_player_authority_pending_command_on_startup(&mut advanced_store)
            .unwrap()
            .expect("cleanup must survive later exact ticks");
        assert_eq!(advanced_receipt.revision, tick.revision);
        assert_eq!(
            advanced_receipt.pending_macro_cleanup_session_id.as_deref(),
            Some("macro-session-cleanup")
        );
        assert_eq!(
            advanced_receipt.pending_macro_cleanup_revision,
            Some(committed.revision)
        );

        let lost_reply = advanced_registry
            .commit_player_authority_command_internal(
                &mut advanced_store,
                &advanced_receipt.session_id,
                player_authority_time_warp_disable_command(
                    advanced_receipt.revision,
                    "disable-time-warp-after-finish",
                ),
                PlayerAuthorityCommandKind::Gameplay,
                PlayerAuthorityCommandFault::AfterLeaseAcknowledge,
            )
            .unwrap_err();
        assert!(
            format!("{lost_reply:#}").contains("lost response"),
            "{lost_reply:#}"
        );
        let retired = advanced_store.require_exact_realtime_lease().unwrap();
        assert!(retired.last_finished_macro_session_id.is_none());
        assert!(retired.last_finished_macro_revision.is_none());
        drop(advanced_registry);
        drop(advanced_store);

        let mut final_store = SaveStore::open(root.path()).unwrap();
        let mut final_registry = resumable_player_authority_registry_for_test();
        let final_receipt = final_registry
            .recover_player_authority_pending_command_on_startup(&mut final_store)
            .unwrap()
            .expect("authority remains resumable after cleanup retirement");
        assert!(final_receipt.pending_macro_cleanup_session_id.is_none());
        assert!(final_receipt.pending_macro_cleanup_revision.is_none());
        let projection = final_registry
            .factory_read_model_projection(
                &final_receipt.session_id,
                &["controller".to_owned()],
                &[],
            )
            .unwrap();
        assert_eq!(projection["revision"], final_receipt.revision);
        assert_eq!(projection["shell"]["timeWarp"]["enabled"], false);
        assert_eq!(
            projection["shell"]["timeWarp"]["effectiveMultiplier"].as_f64(),
            Some(1.0)
        );
        assert_eq!(
            projection["shell"]["timeWarp"]["requiredPowerKw"].as_f64(),
            Some(0.0)
        );
        assert_eq!(
            projection["shell"]["timeWarp"]["allocatedPowerKw"].as_f64(),
            Some(0.0)
        );
    }

    #[test]
    fn player_authority_macro_reuses_each_durable_boundary_without_double_advancing() {
        let (_clean_root, mut clean_store, mut clean_registry, clean_session, clean_checkpoint) =
            player_authority_macro_fixture();
        let clean = clean_registry
            .commit_player_authority_macro_advance(
                &mut clean_store,
                &clean_session,
                player_authority_macro_request(
                    clean_checkpoint.revision,
                    "macro-session-boundary",
                    "macro-operation-boundary",
                ),
            )
            .unwrap();

        for fault in [
            PlayerAuthorityMacroFault::AfterStage,
            PlayerAuthorityMacroFault::AfterWal,
            PlayerAuthorityMacroFault::AfterCheckpoint,
            PlayerAuthorityMacroFault::AfterLeaseAcknowledge,
        ] {
            let (_root, mut store, mut registry, session_id, entry_checkpoint) =
                player_authority_macro_fixture();
            let request = || {
                player_authority_macro_request(
                    entry_checkpoint.revision,
                    "macro-session-boundary",
                    "macro-operation-boundary",
                )
            };
            let error = registry
                .commit_player_authority_macro_advance_internal(
                    &mut store,
                    &session_id,
                    request(),
                    fault,
                )
                .unwrap_err();
            assert!(format!("{error:#}").contains("lost response"), "{fault:?}");
            let durable_after_fault = store.require_exact_realtime_lease().unwrap();
            if fault == PlayerAuthorityMacroFault::AfterLeaseAcknowledge {
                assert!(durable_after_fault.pending_advance.is_none());
                assert_eq!(durable_after_fault.acknowledged.revision, clean.revision);
            } else {
                assert_eq!(
                    durable_after_fault
                        .pending_advance
                        .as_ref()
                        .unwrap()
                        .operation_id,
                    "macro-operation-boundary"
                );
                assert_eq!(
                    durable_after_fault.acknowledged.revision,
                    entry_checkpoint.revision
                );
            }

            let recovered = registry
                .commit_player_authority_macro_advance(&mut store, &session_id, request())
                .unwrap_or_else(|error| panic!("{fault:?}: {error:#}"));
            assert!(recovered.duplicate, "{fault:?}");
            assert_eq!(recovered.revision, clean.revision, "{fault:?}");
            assert_eq!(
                recovered.summary.canonical_sha256, clean.summary.canonical_sha256,
                "{fault:?}"
            );
            assert_eq!(
                recovered.summary.domain_sha256, clean.summary.domain_sha256,
                "{fault:?}"
            );
            assert_eq!(recovered.checkpoint, clean.checkpoint, "{fault:?}");
            let durable = store.require_exact_realtime_lease().unwrap();
            assert!(durable.pending_advance.is_none(), "{fault:?}");
            assert_eq!(durable.acknowledged.revision, clean.revision, "{fault:?}");
            assert_eq!(
                durable.acknowledged.sequence, clean.acknowledged_sequence,
                "{fault:?}"
            );
        }
    }

    #[test]
    fn player_authority_macro_recovers_after_process_restart_at_every_boundary() {
        let (_clean_root, mut clean_store, mut clean_registry, clean_session, clean_checkpoint) =
            player_authority_macro_fixture();
        let clean = clean_registry
            .commit_player_authority_macro_advance(
                &mut clean_store,
                &clean_session,
                player_authority_macro_request(
                    clean_checkpoint.revision,
                    "macro-session-restart",
                    "macro-operation-restart",
                ),
            )
            .unwrap();

        for fault in [
            PlayerAuthorityMacroFault::AfterStage,
            PlayerAuthorityMacroFault::AfterWal,
            PlayerAuthorityMacroFault::AfterCheckpoint,
            PlayerAuthorityMacroFault::AfterLeaseAcknowledge,
        ] {
            let (root, mut store, mut registry, session_id, entry_checkpoint) =
                player_authority_macro_fixture();
            let error = registry
                .commit_player_authority_macro_advance_internal(
                    &mut store,
                    &session_id,
                    player_authority_macro_request(
                        entry_checkpoint.revision,
                        "macro-session-restart",
                        "macro-operation-restart",
                    ),
                    fault,
                )
                .unwrap_err();
            assert!(format!("{error:#}").contains("lost response"), "{fault:?}");
            drop(registry);
            drop(store);

            let mut reopened_store = SaveStore::open(root.path()).unwrap();
            let mut reopened_registry = resumable_player_authority_registry_for_test();
            let receipt = reopened_registry
                .recover_player_authority_pending_command_on_startup(&mut reopened_store)
                .unwrap_or_else(|error| panic!("{fault:?}: {error:#}"))
                .expect("active macro session must yield a startup receipt");
            assert_eq!(
                receipt.macro_session_id.as_deref(),
                Some("macro-session-restart")
            );
            assert_eq!(
                receipt.macro_algorithm_version.as_deref(),
                Some(clean.algorithm_version.as_str())
            );
            assert_eq!(
                receipt.recovered_macro_operation_id.as_deref(),
                Some("macro-operation-restart")
            );
            assert_eq!(receipt.macro_simulation_milliseconds, Some(60_000));
            assert_eq!(receipt.macro_wall_milliseconds, Some(4_000));
            assert_eq!(receipt.revision, clean.revision, "{fault:?}");
            assert_eq!(
                receipt.summary.canonical_sha256, clean.summary.canonical_sha256,
                "{fault:?}"
            );
            assert_eq!(
                receipt.summary.domain_sha256, clean.summary.domain_sha256,
                "{fault:?}"
            );
            assert_eq!(receipt.checkpoint, clean.checkpoint, "{fault:?}");
            let durable = reopened_store.require_exact_realtime_lease().unwrap();
            assert!(durable.pending_advance.is_none(), "{fault:?}");
            assert_eq!(durable.acknowledged.revision, clean.revision, "{fault:?}");
            assert_eq!(
                durable.acknowledged.sequence, clean.acknowledged_sequence,
                "{fault:?}"
            );

            // The startup receipt and rebound session are also replay-safe.
            let repeated = reopened_registry
                .recover_player_authority_pending_command_on_startup(&mut reopened_store)
                .unwrap()
                .unwrap();
            assert_eq!(repeated.session_id, receipt.session_id);
            assert_eq!(repeated.revision, receipt.revision);

            let continued = reopened_registry
                .commit_player_authority_macro_advance(
                    &mut reopened_store,
                    &receipt.session_id,
                    player_authority_macro_request(
                        receipt.revision,
                        "macro-session-restart",
                        "macro-operation-after-restart",
                    ),
                )
                .unwrap_or_else(|error| panic!("{fault:?}: {error:#}"));
            assert!(continued.revision > receipt.revision, "{fault:?}");
            assert_eq!(
                continued.algorithm_version, clean.algorithm_version,
                "{fault:?}"
            );
            assert_eq!(
                reopened_store
                    .require_exact_realtime_lease()
                    .unwrap()
                    .macro_session
                    .as_ref()
                    .unwrap()
                    .session_id,
                "macro-session-restart"
            );
        }
    }

    #[test]
    fn conflicting_macro_retry_fails_closed_and_preserves_the_staged_checkpoint() {
        let (_root, mut store, mut registry, session_id, entry_checkpoint) =
            player_authority_macro_fixture();
        let valid = || {
            player_authority_macro_request(
                entry_checkpoint.revision,
                "macro-session-conflict",
                "macro-operation-conflict",
            )
        };
        let error = registry
            .commit_player_authority_macro_advance_internal(
                &mut store,
                &session_id,
                valid(),
                PlayerAuthorityMacroFault::AfterStage,
            )
            .unwrap_err();
        assert!(format!("{error:#}").contains("lost response"));
        let lease_before = store.require_exact_realtime_lease().unwrap();
        let summary_before = registry.status(&session_id).unwrap();
        let checkpoint_before = store.recover("normal-main").unwrap().unwrap();

        for conflicting in [
            player_authority_macro_request(
                entry_checkpoint.revision,
                "macro-session-other",
                "macro-operation-conflict",
            ),
            player_authority_macro_request(
                entry_checkpoint.revision,
                "macro-session-conflict",
                "macro-operation-other",
            ),
            CoreCommitPlayerAuthorityMacroAdvanceRequest {
                simulation_milliseconds: 60_001,
                ..valid()
            },
        ] {
            let conflict = registry
                .commit_player_authority_macro_advance(&mut store, &session_id, conflicting)
                .unwrap_err();
            assert!(format!("{conflict:#}").contains("conflict"), "{conflict:#}");
            assert_eq!(store.require_exact_realtime_lease().unwrap(), lease_before);
            let summary_after = registry.status(&session_id).unwrap();
            assert_eq!(summary_after.revision, summary_before.revision);
            assert_eq!(
                summary_after.canonical_sha256,
                summary_before.canonical_sha256
            );
            let checkpoint_after = store.recover("normal-main").unwrap().unwrap();
            assert_eq!(checkpoint_after.generation, checkpoint_before.generation);
            assert_eq!(checkpoint_after.root_hash, checkpoint_before.root_hash);
            assert_eq!(checkpoint_after.revision, checkpoint_before.revision);
        }

        let recovered = registry
            .commit_player_authority_macro_advance(&mut store, &session_id, valid())
            .unwrap();
        assert!(recovered.duplicate);
        assert!(recovered.revision > entry_checkpoint.revision);
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
