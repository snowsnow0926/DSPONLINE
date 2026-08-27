use std::fs::{self, FileType};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, anyhow, bail};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Value, json, to_value};
use sha2::{Digest, Sha256};

use crate::save_store::{PublishedCheckpointIdentity, SaveStore, atomic_replace, sync_directory};

pub const EXACT_REALTIME_LEASE_CAPABILITY: &str = "native-core-exact-realtime-lease-v2";
pub const EXACT_REALTIME_WRITER_FENCE_CAPABILITY: &str =
    "native-core-exact-realtime-writer-fence-v1";

const SCHEMA_VERSION: u16 = 2;
const STORAGE_VERSION: u16 = 2;
const LEASE_KIND: &str = "native-core-exact-realtime-experiment-lease-v2";
const NORMAL_MODE: &str = "normal";
const NORMAL_SLOT: &str = "normal-main";
const STATE_VERSION: u16 = 47;
const PUBLIC_PRIMARY_PROOF_KIND: &str = "public-primary-readback-v1";
const AUTHORITY_DIRECTORY: &str = "authority";
const LEASE_FILE_NAME: &str = "exact-realtime-lease-v2.json";
const LEGACY_LEASE_FILE_NAME: &str = "exact-realtime-lease-v1.json";
const MAX_LEASE_BYTES: u64 = 32 * 1024;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const EXACT_TICK_SECONDS: u64 = 1;
const EXACT_TICK_MILLISECONDS: u64 = 1_000;

static NEXT_LEASE_TEMPORARY_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ExactRealtimeLeasePhase {
    Prepared,
    Active,
    Paused,
    Finalizing,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExactRealtimeCheckpoint {
    pub generation: u64,
    pub root_hash: String,
    pub revision: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExactRealtimeStateProof {
    pub revision: u64,
    pub canonical_sha256: String,
    pub domain_sha256: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExactRealtimeAcknowledged {
    pub sequence: u64,
    #[serde(deserialize_with = "deserialize_required_option")]
    pub command_id: Option<String>,
    pub revision: u64,
    pub proof: ExactRealtimeStateProof,
    pub checkpoint: ExactRealtimeCheckpoint,
    pub settled_deadline_ms: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExactRealtimePendingTick {
    pub sequence: u64,
    pub command_id: String,
    pub base_revision: u64,
    pub expected_revision: u64,
    pub simulation_seconds: u64,
    pub wall_seconds: u64,
    pub settled_deadline_ms: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExactRealtimePause {
    pub reason_code: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PublicPrimaryReadbackProof {
    pub kind: String,
    pub revision: u64,
    pub canonical_sha256: String,
    pub domain_sha256: String,
    pub registry_fingerprint: String,
    pub payload_sha256: String,
    pub base_checksum: String,
    pub byte_length: u64,
    pub saved_at_ms: u64,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ExactRealtimeFinalizationStatus {
    Pending,
    Finalized,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExactRealtimeFinalization {
    pub status: ExactRealtimeFinalizationStatus,
    pub target_revision: u64,
    pub target_proof: ExactRealtimeStateProof,
    #[serde(deserialize_with = "deserialize_required_option")]
    pub checkpoint: Option<ExactRealtimeCheckpoint>,
    #[serde(deserialize_with = "deserialize_required_option")]
    pub public_primary_readback_proof: Option<PublicPrimaryReadbackProof>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExactRealtimeLease {
    pub schema_version: u16,
    pub kind: String,
    pub phase: ExactRealtimeLeasePhase,
    pub run_id: String,
    pub mode: String,
    pub slot: String,
    pub registry_fingerprint: String,
    pub checkpoint: ExactRealtimeCheckpoint,
    pub entry_proof: ExactRealtimeStateProof,
    pub acknowledged: ExactRealtimeAcknowledged,
    #[serde(deserialize_with = "deserialize_required_option")]
    pub pending_tick: Option<ExactRealtimePendingTick>,
    #[serde(deserialize_with = "deserialize_required_option")]
    pub pause: Option<ExactRealtimePause>,
    #[serde(deserialize_with = "deserialize_required_option")]
    pub finalization: Option<ExactRealtimeFinalization>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredExactRealtimeLease {
    storage_version: u16,
    lease: ExactRealtimeLease,
    checksum: String,
}

#[derive(Debug, Deserialize)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "action",
    deny_unknown_fields
)]
pub enum ExactRealtimeLeaseRequest {
    Inspect,
    Prepare {
        run_id: String,
        registry_fingerprint: String,
        checkpoint: ExactRealtimeCheckpoint,
        proof: ExactRealtimeStateProof,
        settled_deadline_ms: u64,
    },
    Activate {
        run_id: String,
        registry_fingerprint: String,
    },
    Pause {
        run_id: String,
        registry_fingerprint: String,
        reason_code: String,
    },
    StageExactTick {
        run_id: String,
        registry_fingerprint: String,
        sequence: u64,
        command_id: String,
        base_revision: u64,
        expected_revision: u64,
        simulation_seconds: u64,
        wall_seconds: u64,
        settled_deadline_ms: u64,
    },
    BeginFinalizing {
        run_id: String,
        registry_fingerprint: String,
    },
    RecordPublicPrimaryReadback {
        run_id: String,
        registry_fingerprint: String,
        public_primary_readback_proof: PublicPrimaryReadbackProof,
    },
    ClearFinalized {
        run_id: String,
        registry_fingerprint: String,
        public_primary_readback_proof: PublicPrimaryReadbackProof,
    },
}

fn deserialize_required_option<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer)
}

impl SaveStore {
    pub fn exact_realtime_lease(
        &self,
        request: ExactRealtimeLeaseRequest,
    ) -> anyhow::Result<Value> {
        match request {
            ExactRealtimeLeaseRequest::Inspect => match self.read_exact_realtime_lease() {
                Ok(Some(lease)) => Ok(json!({ "state": "valid", "lease": lease })),
                Ok(None) => Ok(json!({ "state": "missing" })),
                Err(error) => Ok(json!({
                    "state": "blocked",
                    "code": exact_realtime_inspect_error_code(&error)
                })),
            },
            ExactRealtimeLeaseRequest::Prepare {
                run_id,
                registry_fingerprint,
                checkpoint,
                proof,
                settled_deadline_ms,
            } => to_value(self.prepare_exact_realtime_lease(
                run_id,
                registry_fingerprint,
                checkpoint,
                proof,
                settled_deadline_ms,
            )?)
            .map_err(Into::into),
            ExactRealtimeLeaseRequest::Activate {
                run_id,
                registry_fingerprint,
            } => to_value(self.activate_exact_realtime_lease(&run_id, &registry_fingerprint)?)
                .map_err(Into::into),
            ExactRealtimeLeaseRequest::Pause {
                run_id,
                registry_fingerprint,
                reason_code,
            } => to_value(self.pause_exact_realtime_lease(
                &run_id,
                &registry_fingerprint,
                &reason_code,
            )?)
            .map_err(Into::into),
            ExactRealtimeLeaseRequest::StageExactTick {
                run_id,
                registry_fingerprint,
                sequence,
                command_id,
                base_revision,
                expected_revision,
                simulation_seconds,
                wall_seconds,
                settled_deadline_ms,
            } => to_value(self.stage_exact_realtime_tick(
                &run_id,
                &registry_fingerprint,
                ExactRealtimePendingTick {
                    sequence,
                    command_id,
                    base_revision,
                    expected_revision,
                    simulation_seconds,
                    wall_seconds,
                    settled_deadline_ms,
                },
            )?)
            .map_err(Into::into),
            ExactRealtimeLeaseRequest::BeginFinalizing {
                run_id,
                registry_fingerprint,
            } => to_value(self.begin_exact_realtime_finalizing(&run_id, &registry_fingerprint)?)
                .map_err(Into::into),
            ExactRealtimeLeaseRequest::RecordPublicPrimaryReadback {
                run_id,
                registry_fingerprint,
                public_primary_readback_proof,
            } => to_value(self.record_exact_realtime_public_readback(
                &run_id,
                &registry_fingerprint,
                public_primary_readback_proof,
            )?)
            .map_err(Into::into),
            ExactRealtimeLeaseRequest::ClearFinalized {
                run_id,
                registry_fingerprint,
                public_primary_readback_proof,
            } => self.clear_exact_realtime_finalized(
                &run_id,
                &registry_fingerprint,
                &public_primary_readback_proof,
            ),
        }
    }

    fn prepare_exact_realtime_lease(
        &self,
        run_id: String,
        registry_fingerprint: String,
        checkpoint: ExactRealtimeCheckpoint,
        proof: ExactRealtimeStateProof,
        settled_deadline_ms: u64,
    ) -> anyhow::Result<ExactRealtimeLease> {
        let requested_publication =
            published_checkpoint_identity(&checkpoint, &registry_fingerprint);
        let published = self
            .latest_published_checkpoint_identity(NORMAL_SLOT)?
            .ok_or_else(|| {
                anyhow!("normal-main has no published checkpoint for authority entry")
            })?;
        if published != requested_publication {
            bail!(
                "native exact realtime entry checkpoint is not the current published normal-main checkpoint"
            )
        }
        let lease = ExactRealtimeLease {
            schema_version: SCHEMA_VERSION,
            kind: LEASE_KIND.to_owned(),
            phase: ExactRealtimeLeasePhase::Prepared,
            run_id,
            mode: NORMAL_MODE.to_owned(),
            slot: NORMAL_SLOT.to_owned(),
            registry_fingerprint,
            checkpoint: checkpoint.clone(),
            entry_proof: proof.clone(),
            acknowledged: ExactRealtimeAcknowledged {
                sequence: 0,
                command_id: None,
                revision: checkpoint.revision,
                proof,
                checkpoint,
                settled_deadline_ms,
            },
            pending_tick: None,
            pause: None,
            finalization: None,
        };
        validate_exact_realtime_lease(&lease)?;
        if let Some(current) = self.read_exact_realtime_lease()? {
            if current == lease {
                return Ok(current);
            }
            bail!("a different native exact realtime lease already exists")
        }
        self.write_exact_realtime_lease(&lease)
    }

    fn activate_exact_realtime_lease(
        &self,
        run_id: &str,
        registry_fingerprint: &str,
    ) -> anyhow::Result<ExactRealtimeLease> {
        let mut lease = self.require_exact_realtime_lease()?;
        require_lease_identity(&lease, run_id, registry_fingerprint)?;
        if lease.phase == ExactRealtimeLeasePhase::Active {
            return Ok(lease);
        }
        if !matches!(
            lease.phase,
            ExactRealtimeLeasePhase::Prepared | ExactRealtimeLeasePhase::Paused
        ) || lease.pending_tick.is_some()
        {
            bail!("native exact realtime lease cannot activate from its current phase")
        }
        lease.phase = ExactRealtimeLeasePhase::Active;
        lease.pause = None;
        self.write_exact_realtime_lease(&lease)
    }

    fn pause_exact_realtime_lease(
        &self,
        run_id: &str,
        registry_fingerprint: &str,
        reason_code: &str,
    ) -> anyhow::Result<ExactRealtimeLease> {
        validate_logical_id(reason_code, 160, "pause reason")?;
        let mut lease = self.require_exact_realtime_lease()?;
        require_lease_identity(&lease, run_id, registry_fingerprint)?;
        if lease.phase == ExactRealtimeLeasePhase::Paused {
            if lease.pause.as_ref().map(|pause| pause.reason_code.as_str()) == Some(reason_code) {
                return Ok(lease);
            }
            bail!("paused native exact realtime lease reason conflicts")
        }
        if lease.phase != ExactRealtimeLeasePhase::Active {
            bail!("only an active native exact realtime lease can pause")
        }
        lease.phase = ExactRealtimeLeasePhase::Paused;
        lease.pause = Some(ExactRealtimePause {
            reason_code: reason_code.to_owned(),
        });
        self.write_exact_realtime_lease(&lease)
    }

    fn stage_exact_realtime_tick(
        &self,
        run_id: &str,
        registry_fingerprint: &str,
        pending: ExactRealtimePendingTick,
    ) -> anyhow::Result<ExactRealtimeLease> {
        let mut lease = self.require_exact_realtime_lease()?;
        require_lease_identity(&lease, run_id, registry_fingerprint)?;
        validate_pending_tick(&pending, &lease.run_id)?;
        if let Some(current) = lease.pending_tick.as_ref() {
            if current == &pending {
                return Ok(lease);
            }
            bail!("a different native exact realtime tick is already pending")
        }
        if lease.acknowledged.sequence > 0
            && pending.sequence == lease.acknowledged.sequence
            && Some(pending.command_id.as_str()) == lease.acknowledged.command_id.as_deref()
        {
            let acknowledged = ExactRealtimePendingTick {
                sequence: lease.acknowledged.sequence,
                command_id: lease
                    .acknowledged
                    .command_id
                    .clone()
                    .ok_or_else(|| anyhow!("acknowledged command is missing"))?,
                base_revision: lease
                    .acknowledged
                    .revision
                    .checked_sub(1)
                    .ok_or_else(|| anyhow!("acknowledged revision underflow"))?,
                expected_revision: lease.acknowledged.revision,
                simulation_seconds: EXACT_TICK_SECONDS,
                wall_seconds: EXACT_TICK_SECONDS,
                settled_deadline_ms: lease.acknowledged.settled_deadline_ms,
            };
            if acknowledged == pending {
                return Ok(lease);
            }
            bail!("replayed native exact realtime tick conflicts with its ACK")
        }
        if lease.phase != ExactRealtimeLeasePhase::Active {
            bail!("only an active native exact realtime lease can stage a tick")
        }
        let expected_sequence = safe_add(lease.acknowledged.sequence, 1, "tick sequence")?;
        let expected_revision = safe_add(lease.acknowledged.revision, 1, "tick revision")?;
        let expected_deadline = safe_add(
            lease.acknowledged.settled_deadline_ms,
            EXACT_TICK_MILLISECONDS,
            "tick deadline",
        )?;
        if pending.sequence != expected_sequence
            || pending.base_revision != lease.acknowledged.revision
            || pending.expected_revision != expected_revision
            || pending.settled_deadline_ms != expected_deadline
        {
            bail!("native exact realtime tick is not the next one-second revision")
        }
        lease.pending_tick = Some(pending);
        self.write_exact_realtime_lease(&lease)
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn acknowledge_exact_realtime_tick(
        &self,
        run_id: &str,
        registry_fingerprint: &str,
        sequence: u64,
        command_id: String,
        revision: u64,
        proof: ExactRealtimeStateProof,
        checkpoint: ExactRealtimeCheckpoint,
        settled_deadline_ms: u64,
    ) -> anyhow::Result<ExactRealtimeLease> {
        validate_safe_integer(sequence, 1, "ACK sequence")?;
        validate_logical_id(&command_id, 128, "ACK command ID")?;
        validate_safe_integer(revision, 1, "ACK revision")?;
        validate_safe_integer(settled_deadline_ms, 0, "ACK deadline")?;
        validate_state_proof(&proof)?;
        validate_checkpoint(&checkpoint)?;
        if proof.revision != revision {
            bail!("native exact realtime ACK proof revision does not match")
        }
        if checkpoint.revision != revision {
            bail!("native exact realtime ACK checkpoint revision does not match")
        }
        let expected_publication = published_checkpoint_identity(&checkpoint, registry_fingerprint);
        let published = self
            .latest_published_checkpoint_identity(NORMAL_SLOT)?
            .ok_or_else(|| anyhow!("normal-main has no published checkpoint for authority ACK"))?;
        if published != expected_publication {
            bail!(
                "native exact realtime ACK checkpoint is not the current published normal-main checkpoint"
            )
        }
        let mut lease = self.require_exact_realtime_lease()?;
        require_lease_identity(&lease, run_id, registry_fingerprint)?;
        let Some(pending) = lease.pending_tick.as_ref() else {
            if lease.acknowledged.sequence == sequence
                && lease.acknowledged.command_id.as_deref() == Some(command_id.as_str())
                && lease.acknowledged.revision == revision
                && lease.acknowledged.proof == proof
                && lease.acknowledged.checkpoint == checkpoint
                && lease.acknowledged.settled_deadline_ms == settled_deadline_ms
            {
                return Ok(lease);
            }
            bail!("native exact realtime ACK has no matching pending tick")
        };
        if pending.sequence != sequence
            || pending.command_id != command_id
            || pending.expected_revision != revision
            || pending.settled_deadline_ms != settled_deadline_ms
        {
            bail!("native exact realtime ACK skips or conflicts with the pending tick")
        }
        lease.acknowledged = ExactRealtimeAcknowledged {
            sequence,
            command_id: Some(command_id),
            revision,
            proof,
            checkpoint,
            settled_deadline_ms,
        };
        lease.pending_tick = None;
        self.write_exact_realtime_lease(&lease)
    }

    fn begin_exact_realtime_finalizing(
        &self,
        run_id: &str,
        registry_fingerprint: &str,
    ) -> anyhow::Result<ExactRealtimeLease> {
        let mut lease = self.require_exact_realtime_lease()?;
        require_lease_identity(&lease, run_id, registry_fingerprint)?;
        if lease.phase == ExactRealtimeLeasePhase::Finalizing {
            return Ok(lease);
        }
        if !matches!(
            lease.phase,
            ExactRealtimeLeasePhase::Active | ExactRealtimeLeasePhase::Paused
        ) || lease.pending_tick.is_some()
        {
            bail!("native exact realtime lease cannot finalize with unresolved work")
        }
        lease.phase = ExactRealtimeLeasePhase::Finalizing;
        lease.finalization = Some(ExactRealtimeFinalization {
            status: ExactRealtimeFinalizationStatus::Pending,
            target_revision: lease.acknowledged.revision,
            target_proof: lease.acknowledged.proof.clone(),
            checkpoint: None,
            public_primary_readback_proof: None,
        });
        self.write_exact_realtime_lease(&lease)
    }

    pub(crate) fn record_exact_realtime_finalization_checkpoint(
        &self,
        run_id: &str,
        registry_fingerprint: &str,
        checkpoint: ExactRealtimeCheckpoint,
    ) -> anyhow::Result<ExactRealtimeLease> {
        validate_checkpoint(&checkpoint)?;
        let expected_publication = published_checkpoint_identity(&checkpoint, registry_fingerprint);
        let published = self
            .latest_published_checkpoint_identity(NORMAL_SLOT)?
            .ok_or_else(|| anyhow!("normal-main finalization checkpoint is missing"))?;
        if published != expected_publication {
            bail!("native exact realtime finalization checkpoint is not current")
        }
        let mut lease = self.require_exact_realtime_lease()?;
        require_lease_identity(&lease, run_id, registry_fingerprint)?;
        if lease.phase != ExactRealtimeLeasePhase::Finalizing {
            bail!("native exact realtime lease is not finalizing")
        }
        let finalization = lease
            .finalization
            .as_mut()
            .ok_or_else(|| anyhow!("native exact realtime finalization is missing"))?;
        if checkpoint.revision != finalization.target_revision {
            bail!("native exact realtime finalization checkpoint revision differs")
        }
        if let Some(current) = finalization.checkpoint.as_ref() {
            if current == &checkpoint {
                return Ok(lease);
            }
            bail!("native exact realtime finalization checkpoint conflicts")
        }
        finalization.checkpoint = Some(checkpoint);
        self.write_exact_realtime_lease(&lease)
    }

    fn record_exact_realtime_public_readback(
        &self,
        run_id: &str,
        registry_fingerprint: &str,
        proof: PublicPrimaryReadbackProof,
    ) -> anyhow::Result<ExactRealtimeLease> {
        let mut lease = self.require_exact_realtime_lease()?;
        require_lease_identity(&lease, run_id, registry_fingerprint)?;
        if lease.phase != ExactRealtimeLeasePhase::Finalizing {
            bail!("native exact realtime lease is not finalizing")
        }
        validate_public_primary_proof(&proof, &lease)?;
        let finalization = lease
            .finalization
            .as_mut()
            .ok_or_else(|| anyhow!("native exact realtime finalization is missing"))?;
        if finalization.checkpoint.is_none() {
            bail!("native exact realtime finalization has no durable core checkpoint")
        }
        if finalization.status == ExactRealtimeFinalizationStatus::Finalized {
            if finalization.public_primary_readback_proof.as_ref() == Some(&proof) {
                return Ok(lease);
            }
            bail!("finalized native public-primary proof conflicts")
        }
        finalization.status = ExactRealtimeFinalizationStatus::Finalized;
        finalization.public_primary_readback_proof = Some(proof);
        self.write_exact_realtime_lease(&lease)
    }

    fn clear_exact_realtime_finalized(
        &self,
        run_id: &str,
        registry_fingerprint: &str,
        proof: &PublicPrimaryReadbackProof,
    ) -> anyhow::Result<Value> {
        let Some(lease) = self.read_exact_realtime_lease()? else {
            return Ok(json!({ "state": "missing" }));
        };
        require_lease_identity(&lease, run_id, registry_fingerprint)?;
        validate_public_primary_proof(proof, &lease)?;
        if lease.phase != ExactRealtimeLeasePhase::Finalizing
            || lease.finalization.as_ref().map(|value| value.status)
                != Some(ExactRealtimeFinalizationStatus::Finalized)
            || lease
                .finalization
                .as_ref()
                .and_then(|value| value.public_primary_readback_proof.as_ref())
                != Some(proof)
        {
            bail!("native exact realtime lease cannot clear before finalization")
        }
        self.clear_exact_realtime_lease_file()?;
        Ok(json!({ "state": "missing" }))
    }

    pub(crate) fn require_exact_realtime_lease(&self) -> anyhow::Result<ExactRealtimeLease> {
        self.read_exact_realtime_lease()?
            .ok_or_else(|| anyhow!("native exact realtime lease is missing"))
    }

    /// The durable exact-realtime lease is also the normal-main writer fence.
    /// A malformed or unreadable lease is deliberately returned as an error so
    /// generic mutation fails closed instead of treating damage as absence.
    pub(crate) fn exact_realtime_lease_for_mutation(
        &self,
        slot: &str,
    ) -> anyhow::Result<Option<ExactRealtimeLease>> {
        if slot != NORMAL_SLOT {
            return Ok(None);
        }
        self.read_exact_realtime_lease()
    }

    pub(crate) fn require_generic_mutation_unfenced(&self, slot: &str) -> anyhow::Result<()> {
        if self
            .exact_realtime_lease_for_mutation(slot)
            .context("inspect native exact realtime lease writer fence")?
            .is_some()
        {
            bail!("native exact realtime lease fences generic normal-main mutation")
        }
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn require_exact_realtime_pending_wal_mutation(
        &self,
        expected_lease: &ExactRealtimeLease,
        slot: &str,
        registry_fingerprint: &str,
        base_revision: u64,
        revision: u64,
        command_id: &str,
    ) -> anyhow::Result<()> {
        let current = self.require_exact_realtime_lease()?;
        if current != *expected_lease {
            bail!("native exact realtime WAL authorization changed")
        }
        if current.slot != slot
            || current.slot != NORMAL_SLOT
            || current.mode != NORMAL_MODE
            || current.registry_fingerprint != registry_fingerprint
            || !matches!(
                current.phase,
                ExactRealtimeLeasePhase::Active | ExactRealtimeLeasePhase::Paused
            )
        {
            bail!("native exact realtime WAL authorization is invalid")
        }
        let pending = current
            .pending_tick
            .as_ref()
            .ok_or_else(|| anyhow!("native exact realtime WAL has no pending tick"))?;
        if pending.command_id != command_id
            || pending.base_revision != base_revision
            || pending.expected_revision != revision
            || pending.simulation_seconds != EXACT_TICK_SECONDS
            || pending.wall_seconds != EXACT_TICK_SECONDS
        {
            bail!("native exact realtime WAL differs from the pending tick")
        }
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn require_exact_realtime_checkpoint_mutation(
        &self,
        expected_lease: &ExactRealtimeLease,
        slot: &str,
        mode: &str,
        state_version: u16,
        registry_fingerprint: &str,
        revision: u64,
        saved_at_ms: u64,
    ) -> anyhow::Result<()> {
        let current = self.require_exact_realtime_lease()?;
        if current != *expected_lease {
            bail!("native exact realtime checkpoint authorization changed")
        }
        if current.slot != slot
            || current.slot != NORMAL_SLOT
            || current.mode != mode
            || current.mode != NORMAL_MODE
            || state_version != STATE_VERSION
            || current.registry_fingerprint != registry_fingerprint
        {
            bail!("native exact realtime checkpoint authorization is invalid")
        }
        if let Some(pending) = current.pending_tick.as_ref() {
            if !matches!(
                current.phase,
                ExactRealtimeLeasePhase::Active | ExactRealtimeLeasePhase::Paused
            ) || pending.expected_revision != revision
                || pending.settled_deadline_ms != saved_at_ms
            {
                bail!("native exact realtime checkpoint differs from the pending tick")
            }
            return Ok(());
        }
        if current.phase == ExactRealtimeLeasePhase::Finalizing {
            let finalization = current
                .finalization
                .as_ref()
                .ok_or_else(|| anyhow!("native exact realtime finalization is missing"))?;
            if finalization.checkpoint.is_some()
                || finalization.target_revision != revision
                || current.acknowledged.settled_deadline_ms != saved_at_ms
            {
                bail!("native exact realtime checkpoint differs from finalization")
            }
            return Ok(());
        }
        bail!("native exact realtime lease does not authorize a checkpoint")
    }

    fn read_exact_realtime_lease(&self) -> anyhow::Result<Option<ExactRealtimeLease>> {
        let authority = self.root().join(AUTHORITY_DIRECTORY);
        if !validate_optional_direct_directory(&authority)? {
            return Ok(None);
        }
        let directory = authority.join(NORMAL_SLOT);
        if !validate_optional_direct_directory(&directory)? {
            return Ok(None);
        }
        let legacy_path = directory.join(LEGACY_LEASE_FILE_NAME);
        match fs::symlink_metadata(&legacy_path) {
            Ok(_) => bail!(
                "native exact realtime lease v1 is unsupported and requires explicit recovery"
            ),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        let path = directory.join(LEASE_FILE_NAME);
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        validate_regular_file_type(metadata.file_type(), "native exact realtime lease")?;
        if metadata.len() == 0 || metadata.len() > MAX_LEASE_BYTES {
            bail!("native exact realtime lease size is invalid")
        }
        let bytes = fs::read(&path)?;
        let after = fs::symlink_metadata(&path)?;
        validate_regular_file_type(after.file_type(), "native exact realtime lease")?;
        if bytes.len() as u64 != metadata.len() || after.len() != metadata.len() {
            bail!("native exact realtime lease changed while reading")
        }
        let stored = serde_json::from_slice::<StoredExactRealtimeLease>(&bytes)?;
        if stored.storage_version != STORAGE_VERSION {
            bail!("native exact realtime lease storage version is unsupported")
        }
        if stored.checksum != lease_checksum(&stored.lease)? {
            bail!("native exact realtime lease checksum is invalid")
        }
        validate_exact_realtime_lease(&stored.lease)?;
        let durable_checkpoint = stored
            .lease
            .finalization
            .as_ref()
            .and_then(|finalization| finalization.checkpoint.as_ref())
            .unwrap_or(&stored.lease.acknowledged.checkpoint);
        self.verify_published_checkpoint_identity(&published_checkpoint_identity(
            durable_checkpoint,
            &stored.lease.registry_fingerprint,
        ))?;
        Ok(Some(stored.lease))
    }

    fn write_exact_realtime_lease(
        &self,
        lease: &ExactRealtimeLease,
    ) -> anyhow::Result<ExactRealtimeLease> {
        self.write_exact_realtime_lease_with_fault(lease, LeaseWriteFault::None)
    }

    fn write_exact_realtime_lease_with_fault(
        &self,
        lease: &ExactRealtimeLease,
        fault: LeaseWriteFault,
    ) -> anyhow::Result<ExactRealtimeLease> {
        validate_exact_realtime_lease(lease)?;
        let directory = self.ensure_exact_realtime_lease_directory()?;
        let path = directory.join(LEASE_FILE_NAME);
        if let Ok(metadata) = fs::symlink_metadata(&path) {
            validate_regular_file_type(metadata.file_type(), "native exact realtime lease")?;
        }
        let stored = StoredExactRealtimeLease {
            storage_version: STORAGE_VERSION,
            lease: lease.clone(),
            checksum: lease_checksum(lease)?,
        };
        let mut bytes = serde_json::to_vec(&stored)?;
        bytes.push(b'\n');
        if bytes.len() as u64 > MAX_LEASE_BYTES {
            bail!("native exact realtime lease exceeds its bounded file size")
        }
        if fault == LeaseWriteFault::BeforePublish {
            bail!("injected native exact realtime lease pre-publish fault")
        }
        atomic_replace(&path, &bytes, &next_lease_temporary_name())?;
        sync_directory(&directory)?;
        if fault == LeaseWriteFault::AfterPublish {
            bail!("injected native exact realtime lease lost ACK")
        }
        if fault == LeaseWriteFault::CorruptAfterPublish {
            fs::write(&path, b"corrupt-native-exact-realtime-lease")?;
            bail!("injected native exact realtime lease corruption")
        }
        let readback = fs::read(&path)?;
        if readback != bytes {
            bail!("native exact realtime lease disk readback differs")
        }
        let recovered = self
            .read_exact_realtime_lease()?
            .ok_or_else(|| anyhow!("native exact realtime lease readback is missing"))?;
        if recovered != *lease {
            bail!("native exact realtime lease semantic readback differs")
        }
        Ok(recovered)
    }

    fn clear_exact_realtime_lease_file(&self) -> anyhow::Result<()> {
        self.clear_exact_realtime_lease_file_with_fault(LeaseClearFault::None)
    }

    fn clear_exact_realtime_lease_file_with_fault(
        &self,
        fault: LeaseClearFault,
    ) -> anyhow::Result<()> {
        let path = exact_realtime_lease_path(self.root());
        if fault == LeaseClearFault::BeforeRemove {
            bail!("injected native exact realtime lease clear fault")
        }
        fs::remove_file(&path)?;
        let directory = path
            .parent()
            .ok_or_else(|| anyhow!("native exact realtime lease has no parent"))?;
        sync_directory(directory)?;
        if self.read_exact_realtime_lease()?.is_some() {
            bail!("native exact realtime lease clear readback failed")
        }
        Ok(())
    }

    fn ensure_exact_realtime_lease_directory(&self) -> anyhow::Result<PathBuf> {
        let authority = self.root().join(AUTHORITY_DIRECTORY);
        ensure_direct_directory(&authority, self.root())?;
        let directory = authority.join(NORMAL_SLOT);
        ensure_direct_directory(&directory, &authority)?;
        Ok(directory)
    }
}

fn validate_exact_realtime_lease(lease: &ExactRealtimeLease) -> anyhow::Result<()> {
    if lease.schema_version != SCHEMA_VERSION || lease.kind != LEASE_KIND {
        bail!("native exact realtime lease schema identity is invalid")
    }
    if lease.mode != NORMAL_MODE || lease.slot != NORMAL_SLOT {
        bail!("native exact realtime lease is outside normal-main")
    }
    validate_logical_id(&lease.run_id, 128, "lease run ID")?;
    validate_logical_id(
        &lease.registry_fingerprint,
        256,
        "lease registry fingerprint",
    )?;
    validate_checkpoint(&lease.checkpoint)?;
    validate_state_proof(&lease.entry_proof)?;
    validate_acknowledged(&lease.acknowledged)?;
    if lease.entry_proof.revision != lease.checkpoint.revision {
        bail!("native exact realtime entry proof revision differs from checkpoint")
    }
    let acknowledged_revision = safe_add(
        lease.checkpoint.revision,
        lease.acknowledged.sequence,
        "acknowledged revision",
    )?;
    if lease.acknowledged.revision != acknowledged_revision
        || lease.acknowledged.proof.revision != lease.acknowledged.revision
        || lease.acknowledged.checkpoint.revision != lease.acknowledged.revision
        || (lease.acknowledged.sequence == 0) != lease.acknowledged.command_id.is_none()
    {
        bail!("native exact realtime acknowledged revision chain is invalid")
    }
    if lease.acknowledged.sequence == 0 && lease.acknowledged.proof != lease.entry_proof {
        bail!("native exact realtime initial acknowledged proof differs")
    }
    if lease.acknowledged.sequence == 0 && lease.acknowledged.checkpoint != lease.checkpoint {
        bail!("native exact realtime initial acknowledged checkpoint differs")
    }
    if let Some(pending) = lease.pending_tick.as_ref() {
        validate_pending_tick(pending, &lease.run_id)?;
        if pending.sequence != safe_add(lease.acknowledged.sequence, 1, "pending sequence")?
            || pending.base_revision != lease.acknowledged.revision
            || pending.expected_revision != safe_add(pending.base_revision, 1, "pending revision")?
            || pending.settled_deadline_ms
                != safe_add(
                    lease.acknowledged.settled_deadline_ms,
                    EXACT_TICK_MILLISECONDS,
                    "pending deadline",
                )?
        {
            bail!("native exact realtime pending tick is not the next exact second")
        }
    }
    match lease.phase {
        ExactRealtimeLeasePhase::Prepared => {
            if lease.acknowledged.sequence != 0
                || lease.pending_tick.is_some()
                || lease.pause.is_some()
                || lease.finalization.is_some()
            {
                bail!("prepared native exact realtime lease contains post-entry state")
            }
        }
        ExactRealtimeLeasePhase::Active => {
            if lease.pause.is_some() || lease.finalization.is_some() {
                bail!("active native exact realtime lease contains paused/finalizing state")
            }
        }
        ExactRealtimeLeasePhase::Paused => {
            let pause = lease
                .pause
                .as_ref()
                .ok_or_else(|| anyhow!("paused native exact realtime lease has no reason"))?;
            validate_logical_id(&pause.reason_code, 160, "lease pause reason")?;
            if lease.finalization.is_some() {
                bail!("paused native exact realtime lease contains finalization")
            }
        }
        ExactRealtimeLeasePhase::Finalizing => {
            if lease.pending_tick.is_some() || lease.finalization.is_none() {
                bail!("finalizing native exact realtime lease has unresolved work")
            }
        }
    }
    if let Some(finalization) = lease.finalization.as_ref() {
        validate_safe_integer(finalization.target_revision, 0, "finalization revision")?;
        validate_state_proof(&finalization.target_proof)?;
        if finalization.target_revision != lease.acknowledged.revision
            || finalization.target_proof != lease.acknowledged.proof
        {
            bail!("native exact realtime finalization proof differs from ACK")
        }
        if let Some(checkpoint) = finalization.checkpoint.as_ref() {
            validate_checkpoint(checkpoint)?;
            if checkpoint.revision != finalization.target_revision {
                bail!("native exact realtime finalization checkpoint differs from target")
            }
        }
        match finalization.status {
            ExactRealtimeFinalizationStatus::Pending => {
                if finalization.public_primary_readback_proof.is_some() {
                    bail!("pending native exact realtime finalization contains public proof")
                }
            }
            ExactRealtimeFinalizationStatus::Finalized => {
                if finalization.checkpoint.is_none() {
                    bail!("finalized native exact realtime lease has no core checkpoint")
                }
                let proof = finalization
                    .public_primary_readback_proof
                    .as_ref()
                    .ok_or_else(|| anyhow!("finalized native exact realtime lease has no proof"))?;
                validate_public_primary_proof(proof, lease)?;
            }
        }
    }
    Ok(())
}

fn validate_checkpoint(value: &ExactRealtimeCheckpoint) -> anyhow::Result<()> {
    validate_safe_integer(value.generation, 1, "checkpoint generation")?;
    validate_sha256(&value.root_hash, "checkpoint root hash")?;
    validate_safe_integer(value.revision, 0, "checkpoint revision")
}

fn validate_state_proof(value: &ExactRealtimeStateProof) -> anyhow::Result<()> {
    validate_safe_integer(value.revision, 0, "proof revision")?;
    validate_sha256(&value.canonical_sha256, "canonical proof")?;
    validate_sha256(&value.domain_sha256, "domain proof")
}

fn validate_acknowledged(value: &ExactRealtimeAcknowledged) -> anyhow::Result<()> {
    validate_safe_integer(value.sequence, 0, "acknowledged sequence")?;
    if let Some(command_id) = value.command_id.as_ref() {
        validate_logical_id(command_id, 128, "acknowledged command ID")?;
    }
    validate_safe_integer(value.revision, 0, "acknowledged revision")?;
    validate_state_proof(&value.proof)?;
    validate_checkpoint(&value.checkpoint)?;
    validate_safe_integer(value.settled_deadline_ms, 0, "acknowledged deadline")
}

fn validate_pending_tick(value: &ExactRealtimePendingTick, run_id: &str) -> anyhow::Result<()> {
    validate_safe_integer(value.sequence, 1, "pending sequence")?;
    validate_logical_id(&value.command_id, 128, "pending command ID")?;
    if value.command_id != derive_exact_tick_command_id(run_id, value.sequence)? {
        bail!("native exact realtime command ID is not derived from run and sequence")
    }
    validate_safe_integer(value.base_revision, 0, "pending base revision")?;
    validate_safe_integer(value.expected_revision, 1, "pending expected revision")?;
    validate_safe_integer(value.settled_deadline_ms, 0, "pending deadline")?;
    if value.simulation_seconds != EXACT_TICK_SECONDS || value.wall_seconds != EXACT_TICK_SECONDS {
        bail!("native exact realtime tick must settle exactly one realtime second")
    }
    Ok(())
}

fn validate_public_primary_proof(
    proof: &PublicPrimaryReadbackProof,
    lease: &ExactRealtimeLease,
) -> anyhow::Result<()> {
    if proof.kind != PUBLIC_PRIMARY_PROOF_KIND {
        bail!("native public-primary proof kind is invalid")
    }
    validate_safe_integer(proof.revision, 0, "public-primary revision")?;
    validate_sha256(&proof.canonical_sha256, "public-primary canonical proof")?;
    validate_sha256(&proof.domain_sha256, "public-primary domain proof")?;
    validate_logical_id(
        &proof.registry_fingerprint,
        256,
        "public-primary registry fingerprint",
    )?;
    validate_sha256(&proof.payload_sha256, "public-primary payload proof")?;
    validate_checksum(&proof.base_checksum, "public-primary base checksum")?;
    validate_safe_integer(proof.byte_length, 1, "public-primary byte length")?;
    validate_safe_integer(proof.saved_at_ms, 0, "public-primary timestamp")?;
    if proof.revision != lease.acknowledged.revision
        || proof.canonical_sha256 != lease.acknowledged.proof.canonical_sha256
        || proof.domain_sha256 != lease.acknowledged.proof.domain_sha256
        || proof.registry_fingerprint != lease.registry_fingerprint
        || proof.saved_at_ms != lease.acknowledged.settled_deadline_ms
    {
        bail!("native public-primary proof differs from the acknowledged lease")
    }
    Ok(())
}

fn require_lease_identity(
    lease: &ExactRealtimeLease,
    run_id: &str,
    registry_fingerprint: &str,
) -> anyhow::Result<()> {
    validate_logical_id(run_id, 128, "request run ID")?;
    validate_logical_id(registry_fingerprint, 256, "request registry fingerprint")?;
    if lease.run_id != run_id || lease.registry_fingerprint != registry_fingerprint {
        bail!("native exact realtime lease identity conflicts")
    }
    Ok(())
}

fn published_checkpoint_identity(
    checkpoint: &ExactRealtimeCheckpoint,
    registry_fingerprint: &str,
) -> PublishedCheckpointIdentity {
    PublishedCheckpointIdentity {
        slot: NORMAL_SLOT.to_owned(),
        generation: checkpoint.generation,
        revision: checkpoint.revision,
        root_hash: checkpoint.root_hash.clone(),
        mode: NORMAL_MODE.to_owned(),
        state_version: STATE_VERSION,
        registry_fingerprint: registry_fingerprint.to_owned(),
    }
}

fn exact_realtime_inspect_error_code(error: &anyhow::Error) -> &'static str {
    if error
        .chain()
        .any(|cause| cause.downcast_ref::<std::io::Error>().is_some())
    {
        "NATIVE_CORE_EXACT_REALTIME_LEASE_IO_FAILED"
    } else {
        "NATIVE_CORE_EXACT_REALTIME_LEASE_CORRUPT"
    }
}

fn validate_safe_integer(value: u64, minimum: u64, label: &str) -> anyhow::Result<()> {
    if value < minimum || value > MAX_SAFE_INTEGER {
        bail!("{label} is outside the JavaScript safe integer range")
    }
    Ok(())
}

fn safe_add(value: u64, increment: u64, label: &str) -> anyhow::Result<u64> {
    let result = value
        .checked_add(increment)
        .ok_or_else(|| anyhow!("{label} overflow"))?;
    validate_safe_integer(result, 0, label)?;
    Ok(result)
}

fn validate_logical_id(value: &str, maximum: usize, label: &str) -> anyhow::Result<()> {
    if value.is_empty()
        || value.len() > maximum
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b':' | b'.'))
    {
        bail!("{label} is invalid")
    }
    Ok(())
}

fn validate_sha256(value: &str, label: &str) -> anyhow::Result<()> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
    {
        bail!("{label} is invalid")
    }
    Ok(())
}

fn validate_checksum(value: &str, label: &str) -> anyhow::Result<()> {
    if !(8..=128).contains(&value.len())
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
    {
        bail!("{label} is invalid")
    }
    Ok(())
}

fn derive_exact_tick_command_id(run_id: &str, sequence: u64) -> anyhow::Result<String> {
    validate_logical_id(run_id, 128, "lease run ID")?;
    validate_safe_integer(sequence, 1, "tick sequence")?;
    let token = hex::encode(Sha256::digest(run_id.as_bytes()));
    Ok(format!("e1:{}:tick:{sequence}", &token[..40]))
}

fn lease_checksum(lease: &ExactRealtimeLease) -> anyhow::Result<String> {
    Ok(hex::encode(Sha256::digest(serde_json::to_vec(lease)?)))
}

fn validate_regular_file_type(file_type: FileType, label: &str) -> anyhow::Result<()> {
    if file_type.is_symlink() || !file_type.is_file() {
        bail!("{label} path is not a direct regular file")
    }
    Ok(())
}

fn validate_optional_direct_directory(path: &Path) -> anyhow::Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            bail!("native exact realtime lease directory is not direct")
        }
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.into()),
    }
}

fn ensure_direct_directory(path: &Path, parent: &Path) -> anyhow::Result<()> {
    if validate_optional_direct_directory(path)? {
        return Ok(());
    }
    fs::create_dir(path)?;
    sync_directory(parent)?;
    if !validate_optional_direct_directory(path)? {
        bail!("native exact realtime lease directory publication failed")
    }
    Ok(())
}

fn exact_realtime_lease_path(root: &Path) -> PathBuf {
    root.join(AUTHORITY_DIRECTORY)
        .join(NORMAL_SLOT)
        .join(LEASE_FILE_NAME)
}

fn next_lease_temporary_name() -> String {
    let id = NEXT_LEASE_TEMPORARY_ID.fetch_add(1, Ordering::Relaxed);
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("lease-{}-{now:032x}-{id:016x}", std::process::id())
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum LeaseWriteFault {
    None,
    BeforePublish,
    AfterPublish,
    CorruptAfterPublish,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum LeaseClearFault {
    None,
    BeforeRemove,
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    const RUN_ID: &str = "authority-run-1";
    const FINGERPRINT: &str = "builtin:test";

    fn sha(value: &str) -> String {
        hex::encode(Sha256::digest(value.as_bytes()))
    }

    fn publish_checkpoint(store: &mut SaveStore, revision: u64) -> ExactRealtimeCheckpoint {
        let exact_lease = store
            .exact_realtime_lease_for_mutation(NORMAL_SLOT)
            .unwrap();
        let transaction = if let Some(lease) = exact_lease.as_ref() {
            let saved_at_ms = lease
                .pending_tick
                .as_ref()
                .map(|pending| pending.settled_deadline_ms)
                .unwrap_or(lease.acknowledged.settled_deadline_ms);
            store
                .begin_exact_realtime_checkpoint(
                    NORMAL_SLOT,
                    NORMAL_MODE,
                    STATE_VERSION,
                    "01234567",
                    FINGERPRINT,
                    revision,
                    saved_at_ms,
                    lease,
                )
                .unwrap()
        } else {
            store
                .begin(
                    NORMAL_SLOT,
                    NORMAL_MODE,
                    STATE_VERSION,
                    "01234567",
                    FINGERPRINT,
                    revision,
                    1_000 + revision,
                )
                .unwrap()
        }
        .transaction_id;
        store
            .put(
                &transaction,
                "authority-test",
                Some(&format!("revision-{revision}")),
            )
            .unwrap();
        let committed = store.commit(&transaction).unwrap();
        ExactRealtimeCheckpoint {
            generation: committed.generation,
            root_hash: committed.root_hash,
            revision: committed.revision,
        }
    }

    fn proof(revision: u64) -> ExactRealtimeStateProof {
        ExactRealtimeStateProof {
            revision,
            canonical_sha256: sha(&format!("canonical-{revision}")),
            domain_sha256: sha(&format!("domain-{revision}")),
        }
    }

    fn pending(sequence: u64, base_revision: u64, deadline: u64) -> ExactRealtimePendingTick {
        ExactRealtimePendingTick {
            sequence,
            command_id: derive_exact_tick_command_id(RUN_ID, sequence).unwrap(),
            base_revision,
            expected_revision: base_revision + 1,
            simulation_seconds: 1,
            wall_seconds: 1,
            settled_deadline_ms: deadline,
        }
    }

    fn public_proof(revision: u64, deadline: u64) -> PublicPrimaryReadbackProof {
        PublicPrimaryReadbackProof {
            kind: PUBLIC_PRIMARY_PROOF_KIND.to_owned(),
            revision,
            canonical_sha256: proof(revision).canonical_sha256,
            domain_sha256: proof(revision).domain_sha256,
            registry_fingerprint: FINGERPRINT.to_owned(),
            payload_sha256: sha("public-payload"),
            base_checksum: "01234567".to_owned(),
            byte_length: 1024,
            saved_at_ms: deadline,
        }
    }

    fn prepare(store: &mut SaveStore) -> ExactRealtimeLease {
        let checkpoint = match store
            .latest_published_checkpoint_identity(NORMAL_SLOT)
            .unwrap()
        {
            Some(published) => ExactRealtimeCheckpoint {
                generation: published.generation,
                root_hash: published.root_hash,
                revision: published.revision,
            },
            None => publish_checkpoint(store, 7),
        };
        store
            .prepare_exact_realtime_lease(
                RUN_ID.to_owned(),
                FINGERPRINT.to_owned(),
                checkpoint,
                proof(7),
                10_000,
            )
            .unwrap()
    }

    fn assert_generic_mutation_fenced<T>(result: anyhow::Result<T>) {
        let message = format!(
            "{:#}",
            result.err().expect("generic mutation must be fenced")
        );
        assert!(message.contains("exact realtime lease"), "{message}");
    }

    #[test]
    fn strict_state_machine_persists_exact_tick_and_finalized_readback() {
        let root = tempdir().unwrap();
        let mut store = SaveStore::open(root.path()).unwrap();
        assert_eq!(
            store
                .exact_realtime_lease(ExactRealtimeLeaseRequest::Inspect)
                .unwrap(),
            json!({ "state": "missing" })
        );
        let prepared = prepare(&mut store);
        assert_eq!(prepared.phase, ExactRealtimeLeasePhase::Prepared);
        assert_eq!(prepare(&mut store), prepared);
        let active = store
            .activate_exact_realtime_lease(RUN_ID, FINGERPRINT)
            .unwrap();
        assert_eq!(active.phase, ExactRealtimeLeasePhase::Active);
        let staged = store
            .stage_exact_realtime_tick(RUN_ID, FINGERPRINT, pending(1, 7, 11_000))
            .unwrap();
        assert_eq!(staged.pending_tick.as_ref().unwrap().expected_revision, 8);
        let checkpoint = publish_checkpoint(&mut store, 8);
        let acknowledged = store
            .acknowledge_exact_realtime_tick(
                RUN_ID,
                FINGERPRINT,
                1,
                derive_exact_tick_command_id(RUN_ID, 1).unwrap(),
                8,
                proof(8),
                checkpoint,
                11_000,
            )
            .unwrap();
        assert_eq!(acknowledged.acknowledged.revision, 8);
        assert!(acknowledged.pending_tick.is_none());
        let finalizing = store
            .begin_exact_realtime_finalizing(RUN_ID, FINGERPRINT)
            .unwrap();
        assert_eq!(finalizing.phase, ExactRealtimeLeasePhase::Finalizing);
        store
            .record_exact_realtime_finalization_checkpoint(
                RUN_ID,
                FINGERPRINT,
                finalizing.acknowledged.checkpoint,
            )
            .unwrap();
        let public = public_proof(8, 11_000);
        let finalized = store
            .record_exact_realtime_public_readback(RUN_ID, FINGERPRINT, public.clone())
            .unwrap();
        assert_eq!(
            finalized.finalization.unwrap().status,
            ExactRealtimeFinalizationStatus::Finalized
        );
        assert_eq!(
            store
                .clear_exact_realtime_finalized(RUN_ID, FINGERPRINT, &public)
                .unwrap(),
            json!({ "state": "missing" })
        );
        assert_eq!(
            store
                .clear_exact_realtime_finalized(RUN_ID, FINGERPRINT, &public)
                .unwrap(),
            json!({ "state": "missing" })
        );
    }

    #[test]
    fn duplicate_requests_are_idempotent_but_conflicts_never_overwrite() {
        let root = tempdir().unwrap();
        let mut store = SaveStore::open(root.path()).unwrap();
        let prepared = prepare(&mut store);
        assert!(
            store
                .prepare_exact_realtime_lease(
                    "different-run".to_owned(),
                    FINGERPRINT.to_owned(),
                    prepared.checkpoint,
                    proof(7),
                    10_000,
                )
                .is_err()
        );
        store
            .activate_exact_realtime_lease(RUN_ID, FINGERPRINT)
            .unwrap();
        let tick = pending(1, 7, 11_000);
        let first = store
            .stage_exact_realtime_tick(RUN_ID, FINGERPRINT, tick.clone())
            .unwrap();
        assert_eq!(
            store
                .stage_exact_realtime_tick(RUN_ID, FINGERPRINT, tick.clone())
                .unwrap(),
            first
        );
        let mut conflict = tick;
        conflict.command_id = "e1:conflict:tick:1".to_owned();
        assert!(
            store
                .stage_exact_realtime_tick(RUN_ID, FINGERPRINT, conflict)
                .is_err()
        );
        assert_eq!(store.require_exact_realtime_lease().unwrap(), first);
    }

    #[test]
    fn prepare_requires_the_current_verified_normal_main_checkpoint() {
        let root = tempdir().unwrap();
        let mut store = SaveStore::open(root.path()).unwrap();
        let absent = ExactRealtimeCheckpoint {
            generation: 1,
            root_hash: sha("absent"),
            revision: 7,
        };
        assert!(
            store
                .prepare_exact_realtime_lease(
                    RUN_ID.to_owned(),
                    FINGERPRINT.to_owned(),
                    absent,
                    proof(7),
                    10_000,
                )
                .is_err()
        );
        let published = publish_checkpoint(&mut store, 7);
        let mut wrong_root = published.clone();
        wrong_root.root_hash = sha("wrong-root");
        assert!(
            store
                .prepare_exact_realtime_lease(
                    RUN_ID.to_owned(),
                    FINGERPRINT.to_owned(),
                    wrong_root,
                    proof(7),
                    10_000,
                )
                .is_err()
        );
        assert!(
            store
                .prepare_exact_realtime_lease(
                    RUN_ID.to_owned(),
                    "builtin:other".to_owned(),
                    published.clone(),
                    proof(7),
                    10_000,
                )
                .is_err()
        );
        assert_eq!(
            store
                .prepare_exact_realtime_lease(
                    RUN_ID.to_owned(),
                    FINGERPRINT.to_owned(),
                    published,
                    proof(7),
                    10_000,
                )
                .unwrap()
                .acknowledged
                .revision,
            7
        );
    }

    #[test]
    fn ack_skip_proof_fingerprint_and_deadline_conflicts_fail_closed() {
        let root = tempdir().unwrap();
        let mut store = SaveStore::open(root.path()).unwrap();
        prepare(&mut store);
        store
            .activate_exact_realtime_lease(RUN_ID, FINGERPRINT)
            .unwrap();
        store
            .stage_exact_realtime_tick(RUN_ID, FINGERPRINT, pending(1, 7, 11_000))
            .unwrap();
        let command_id = derive_exact_tick_command_id(RUN_ID, 1).unwrap();
        assert!(
            store
                .acknowledge_exact_realtime_tick(
                    RUN_ID,
                    FINGERPRINT,
                    1,
                    command_id.clone(),
                    8,
                    proof(8),
                    ExactRealtimeCheckpoint {
                        generation: 2,
                        root_hash: sha("unpublished-revision-8"),
                        revision: 8,
                    },
                    11_000,
                )
                .is_err()
        );
        let checkpoint = publish_checkpoint(&mut store, 8);
        assert!(
            store
                .acknowledge_exact_realtime_tick(
                    RUN_ID,
                    FINGERPRINT,
                    2,
                    command_id.clone(),
                    8,
                    proof(8),
                    checkpoint.clone(),
                    11_000,
                )
                .is_err()
        );
        assert!(
            store
                .acknowledge_exact_realtime_tick(
                    RUN_ID,
                    FINGERPRINT,
                    1,
                    command_id.clone(),
                    8,
                    proof(8),
                    checkpoint.clone(),
                    12_000,
                )
                .is_err()
        );
        assert!(
            store
                .acknowledge_exact_realtime_tick(
                    RUN_ID,
                    "other:fingerprint",
                    1,
                    command_id.clone(),
                    8,
                    proof(8),
                    checkpoint.clone(),
                    11_000,
                )
                .is_err()
        );
        let acknowledged = store
            .acknowledge_exact_realtime_tick(
                RUN_ID,
                FINGERPRINT,
                1,
                command_id.clone(),
                8,
                proof(8),
                checkpoint.clone(),
                11_000,
            )
            .unwrap();
        assert_eq!(
            store
                .acknowledge_exact_realtime_tick(
                    RUN_ID,
                    FINGERPRINT,
                    1,
                    command_id,
                    8,
                    proof(8),
                    checkpoint,
                    11_000,
                )
                .unwrap(),
            acknowledged
        );
    }

    #[test]
    fn lost_stage_or_ack_response_recovers_the_same_pending_command_after_restart() {
        let root = tempdir().unwrap();
        let mut store = SaveStore::open(root.path()).unwrap();
        prepare(&mut store);
        store
            .activate_exact_realtime_lease(RUN_ID, FINGERPRINT)
            .unwrap();
        let staged = store
            .stage_exact_realtime_tick(RUN_ID, FINGERPRINT, pending(1, 7, 11_000))
            .unwrap();
        drop(store);

        let mut store = SaveStore::open(root.path()).unwrap();
        let recovered = store.require_exact_realtime_lease().unwrap();
        assert_eq!(recovered, staged);
        assert_eq!(
            recovered.pending_tick.as_ref().unwrap().command_id,
            derive_exact_tick_command_id(RUN_ID, 1).unwrap()
        );
        store
            .pause_exact_realtime_lease(RUN_ID, FINGERPRINT, "e1-recovering-pending")
            .unwrap();
        let checkpoint = publish_checkpoint(&mut store, 8);
        drop(store);
        let store = SaveStore::open(root.path()).unwrap();
        assert_eq!(
            store
                .require_exact_realtime_lease()
                .unwrap()
                .pending_tick
                .unwrap()
                .expected_revision,
            8
        );
        store
            .acknowledge_exact_realtime_tick(
                RUN_ID,
                FINGERPRINT,
                1,
                derive_exact_tick_command_id(RUN_ID, 1).unwrap(),
                8,
                proof(8),
                checkpoint,
                11_000,
            )
            .unwrap();
        drop(store);
        let store = SaveStore::open(root.path()).unwrap();
        assert_eq!(
            store
                .require_exact_realtime_lease()
                .unwrap()
                .acknowledged
                .revision,
            8
        );
    }

    #[test]
    fn published_manifest_damage_blocks_lease_inspection() {
        let root = tempdir().unwrap();
        let mut store = SaveStore::open(root.path()).unwrap();
        let prepared = prepare(&mut store);
        let manifest = store
            .root()
            .join(NORMAL_SLOT)
            .join("generations")
            .join(prepared.checkpoint.generation.to_string())
            .join("manifest.json");
        fs::write(manifest, b"corrupt-manifest").unwrap();
        assert_eq!(
            store
                .exact_realtime_lease(ExactRealtimeLeaseRequest::Inspect)
                .unwrap(),
            json!({
                "state": "blocked",
                "code": "NATIVE_CORE_EXACT_REALTIME_LEASE_CORRUPT"
            })
        );
    }

    #[test]
    fn finalization_reuses_checkpoint_published_before_lost_lease_ack() {
        let root = tempdir().unwrap();
        let mut store = SaveStore::open(root.path()).unwrap();
        prepare(&mut store);
        store
            .activate_exact_realtime_lease(RUN_ID, FINGERPRINT)
            .unwrap();
        store
            .begin_exact_realtime_finalizing(RUN_ID, FINGERPRINT)
            .unwrap();
        let checkpoint = publish_checkpoint(&mut store, 7);
        drop(store);

        let store = SaveStore::open(root.path()).unwrap();
        assert!(
            store
                .require_exact_realtime_lease()
                .unwrap()
                .finalization
                .unwrap()
                .checkpoint
                .is_none()
        );
        let recorded = store
            .record_exact_realtime_finalization_checkpoint(RUN_ID, FINGERPRINT, checkpoint.clone())
            .unwrap();
        assert_eq!(
            recorded.finalization.as_ref().unwrap().checkpoint.as_ref(),
            Some(&checkpoint)
        );
        assert_eq!(
            store
                .record_exact_realtime_finalization_checkpoint(RUN_ID, FINGERPRINT, checkpoint,)
                .unwrap(),
            recorded
        );
    }

    #[test]
    fn inspect_distinguishes_io_from_corruption() {
        let io = anyhow!(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "injected permission failure",
        ));
        assert_eq!(
            exact_realtime_inspect_error_code(&io),
            "NATIVE_CORE_EXACT_REALTIME_LEASE_IO_FAILED"
        );
        assert_eq!(
            exact_realtime_inspect_error_code(&anyhow!("invalid checksum")),
            "NATIVE_CORE_EXACT_REALTIME_LEASE_CORRUPT"
        );
    }

    #[test]
    fn pre_publish_fault_preserves_old_lease_and_post_publish_lost_ack_recovers_new() {
        let root = tempdir().unwrap();
        let mut store = SaveStore::open(root.path()).unwrap();
        let prepared = prepare(&mut store);
        let mut active = prepared.clone();
        active.phase = ExactRealtimeLeasePhase::Active;
        assert!(
            store
                .write_exact_realtime_lease_with_fault(&active, LeaseWriteFault::BeforePublish)
                .is_err()
        );
        assert_eq!(store.require_exact_realtime_lease().unwrap(), prepared);
        assert!(
            store
                .write_exact_realtime_lease_with_fault(&active, LeaseWriteFault::AfterPublish)
                .is_err()
        );
        drop(store);
        let store = SaveStore::open(root.path()).unwrap();
        assert_eq!(store.require_exact_realtime_lease().unwrap(), active);
    }

    #[test]
    fn corrupt_unknown_future_and_missing_fields_inspect_as_blocked() {
        let cases = [
            b"not-json".to_vec(),
            br#"{"storageVersion":2,"lease":{},"checksum":"bad"}"#.to_vec(),
            br#"{"storageVersion":1,"lease":{},"checksum":"bad","unknown":true}"#.to_vec(),
        ];
        for bytes in cases {
            let root = tempdir().unwrap();
            let mut store = SaveStore::open(root.path()).unwrap();
            prepare(&mut store);
            fs::write(exact_realtime_lease_path(store.root()), bytes).unwrap();
            assert_eq!(
                store
                    .exact_realtime_lease(ExactRealtimeLeaseRequest::Inspect)
                    .unwrap(),
                json!({
                    "state": "blocked",
                    "code": "NATIVE_CORE_EXACT_REALTIME_LEASE_CORRUPT"
                })
            );
        }
    }

    #[test]
    fn checksum_detects_valid_json_mutation_and_readback_corruption() {
        let root = tempdir().unwrap();
        let mut store = SaveStore::open(root.path()).unwrap();
        let prepared = prepare(&mut store);
        let path = exact_realtime_lease_path(store.root());
        let mut stored = serde_json::from_slice::<Value>(&fs::read(&path).unwrap()).unwrap();
        stored["lease"]["runId"] = json!("mutated-valid-run");
        fs::write(&path, serde_json::to_vec(&stored).unwrap()).unwrap();
        assert!(store.read_exact_realtime_lease().is_err());

        fs::remove_file(&path).unwrap();
        let mut active = prepared;
        active.phase = ExactRealtimeLeasePhase::Active;
        assert!(
            store
                .write_exact_realtime_lease_with_fault(
                    &active,
                    LeaseWriteFault::CorruptAfterPublish,
                )
                .is_err()
        );
        assert!(store.read_exact_realtime_lease().is_err());
    }

    #[test]
    fn finalization_clear_failure_retains_finalized_proof_for_retry() {
        let root = tempdir().unwrap();
        let mut store = SaveStore::open(root.path()).unwrap();
        prepare(&mut store);
        store
            .activate_exact_realtime_lease(RUN_ID, FINGERPRINT)
            .unwrap();
        let finalizing = store
            .begin_exact_realtime_finalizing(RUN_ID, FINGERPRINT)
            .unwrap();
        store
            .record_exact_realtime_finalization_checkpoint(
                RUN_ID,
                FINGERPRINT,
                finalizing.acknowledged.checkpoint,
            )
            .unwrap();
        let public = public_proof(7, 10_000);
        let finalized = store
            .record_exact_realtime_public_readback(RUN_ID, FINGERPRINT, public.clone())
            .unwrap();
        assert!(
            store
                .clear_exact_realtime_lease_file_with_fault(LeaseClearFault::BeforeRemove)
                .is_err()
        );
        assert_eq!(store.require_exact_realtime_lease().unwrap(), finalized);
        store
            .clear_exact_realtime_finalized(RUN_ID, FINGERPRINT, &public)
            .unwrap();
    }

    #[test]
    fn malformed_command_id_and_non_exact_tick_never_persist() {
        let root = tempdir().unwrap();
        let mut store = SaveStore::open(root.path()).unwrap();
        prepare(&mut store);
        let active = store
            .activate_exact_realtime_lease(RUN_ID, FINGERPRINT)
            .unwrap();
        let mut invalid = pending(1, 7, 11_000);
        invalid.command_id = "other-command".to_owned();
        assert!(
            store
                .stage_exact_realtime_tick(RUN_ID, FINGERPRINT, invalid)
                .is_err()
        );
        let mut invalid = pending(1, 7, 11_000);
        invalid.wall_seconds = 2;
        assert!(
            store
                .stage_exact_realtime_tick(RUN_ID, FINGERPRINT, invalid)
                .is_err()
        );
        assert_eq!(store.require_exact_realtime_lease().unwrap(), active);
    }

    #[test]
    fn durable_lease_fences_generic_normal_main_mutations_and_preexisting_commit() {
        let root = tempdir().unwrap();
        let mut store = SaveStore::open(root.path()).unwrap();
        publish_checkpoint(&mut store, 7);
        let admitted_before_prepare = store
            .begin(
                NORMAL_SLOT,
                NORMAL_MODE,
                STATE_VERSION,
                "01234567",
                FINGERPRINT,
                8,
                11_000,
            )
            .unwrap()
            .transaction_id;
        store
            .put(
                &admitted_before_prepare,
                "authority-test",
                Some("generic-revision-8"),
            )
            .unwrap();
        prepare(&mut store);

        assert_generic_mutation_fenced(store.begin(
            NORMAL_SLOT,
            NORMAL_MODE,
            STATE_VERSION,
            "01234567",
            FINGERPRINT,
            8,
            11_000,
        ));
        assert_generic_mutation_fenced(store.commit(&admitted_before_prepare));
        assert!(!store.abort(&admitted_before_prepare));
        assert_generic_mutation_fenced(store.append_wal(
            NORMAL_SLOT,
            7,
            8,
            "generic-command-8",
            json!({}),
        ));
        assert_generic_mutation_fenced(store.append_wal_idempotent(
            NORMAL_SLOT,
            7,
            8,
            "generic-authority-8",
            json!({}),
        ));
        assert_generic_mutation_fenced(store.compact(NORMAL_SLOT, 2));
        assert_eq!(store.recover(NORMAL_SLOT).unwrap().unwrap().revision, 7);
        assert!(store.read_wal(NORMAL_SLOT, 7).unwrap().is_empty());
    }

    #[test]
    fn corrupt_lease_fails_closed_for_normal_main_without_fencing_speedrun() {
        let root = tempdir().unwrap();
        let mut store = SaveStore::open(root.path()).unwrap();
        publish_checkpoint(&mut store, 7);
        let admitted_before_prepare = store
            .begin(
                NORMAL_SLOT,
                NORMAL_MODE,
                STATE_VERSION,
                "01234567",
                FINGERPRINT,
                8,
                11_000,
            )
            .unwrap()
            .transaction_id;
        prepare(&mut store);
        fs::write(
            exact_realtime_lease_path(store.root()),
            b"corrupt-native-exact-realtime-lease",
        )
        .unwrap();

        assert_generic_mutation_fenced(store.begin(
            NORMAL_SLOT,
            NORMAL_MODE,
            STATE_VERSION,
            "01234567",
            FINGERPRINT,
            8,
            11_000,
        ));
        assert_generic_mutation_fenced(store.commit(&admitted_before_prepare));
        assert_generic_mutation_fenced(store.append_wal(
            NORMAL_SLOT,
            7,
            8,
            "generic-command-8",
            json!({}),
        ));
        assert_generic_mutation_fenced(store.compact(NORMAL_SLOT, 2));

        let speedrun = store
            .begin(
                "speedrun-main",
                "speedrun",
                STATE_VERSION,
                "01234567",
                FINGERPRINT,
                1,
                1_001,
            )
            .unwrap()
            .transaction_id;
        store.put(&speedrun, "base", Some("speedrun")).unwrap();
        assert_eq!(store.commit(&speedrun).unwrap().revision, 1);
    }

    #[test]
    fn missing_lease_and_speedrun_mutations_keep_their_existing_behavior() {
        let missing_root = tempdir().unwrap();
        let mut missing_store = SaveStore::open(missing_root.path()).unwrap();
        let normal = missing_store
            .begin(
                NORMAL_SLOT,
                NORMAL_MODE,
                STATE_VERSION,
                "01234567",
                FINGERPRINT,
                1,
                1_001,
            )
            .unwrap()
            .transaction_id;
        missing_store.put(&normal, "base", Some("normal")).unwrap();
        missing_store.commit(&normal).unwrap();
        missing_store
            .append_wal(NORMAL_SLOT, 1, 2, "normal-command-2", json!({}))
            .unwrap();
        assert_eq!(missing_store.compact(NORMAL_SLOT, 2).unwrap(), 0);

        let leased_root = tempdir().unwrap();
        let mut leased_store = SaveStore::open(leased_root.path()).unwrap();
        publish_checkpoint(&mut leased_store, 7);
        prepare(&mut leased_store);
        let speedrun = leased_store
            .begin(
                "speedrun-main",
                "speedrun",
                STATE_VERSION,
                "01234567",
                FINGERPRINT,
                1,
                1_001,
            )
            .unwrap()
            .transaction_id;
        leased_store
            .put(&speedrun, "base", Some("speedrun"))
            .unwrap();
        leased_store.commit(&speedrun).unwrap();
        leased_store
            .append_wal("speedrun-main", 1, 2, "speedrun-command-2", json!({}))
            .unwrap();
        assert_eq!(leased_store.compact("speedrun-main", 2).unwrap(), 0);
    }

    #[test]
    fn exact_pending_wal_and_checkpoint_revalidate_the_lease_snapshot() {
        let root = tempdir().unwrap();
        let mut store = SaveStore::open(root.path()).unwrap();
        publish_checkpoint(&mut store, 7);
        prepare(&mut store);
        store
            .activate_exact_realtime_lease(RUN_ID, FINGERPRINT)
            .unwrap();
        let tick = pending(1, 7, 11_000);
        let staged = store
            .stage_exact_realtime_tick(RUN_ID, FINGERPRINT, tick.clone())
            .unwrap();

        assert_generic_mutation_fenced(store.append_wal_idempotent(
            NORMAL_SLOT,
            tick.base_revision,
            tick.expected_revision,
            &tick.command_id,
            json!({ "kind": "exact-test" }),
        ));
        store
            .append_wal_idempotent_exact_realtime(
                &staged,
                NORMAL_SLOT,
                tick.base_revision,
                tick.expected_revision,
                &tick.command_id,
                json!({ "kind": "exact-test" }),
            )
            .unwrap();
        let checkpoint = store
            .begin_exact_realtime_checkpoint(
                NORMAL_SLOT,
                NORMAL_MODE,
                STATE_VERSION,
                "01234567",
                FINGERPRINT,
                tick.expected_revision,
                tick.settled_deadline_ms,
                &staged,
            )
            .unwrap()
            .transaction_id;
        store
            .put(&checkpoint, "authority-test", Some("exact-revision-8"))
            .unwrap();

        let paused = store
            .pause_exact_realtime_lease(RUN_ID, FINGERPRINT, "test-recovery")
            .unwrap();
        assert!(store.commit(&checkpoint).is_err());
        assert_eq!(store.recover(NORMAL_SLOT).unwrap().unwrap().revision, 7);

        let recovered_checkpoint = store
            .begin_exact_realtime_checkpoint(
                NORMAL_SLOT,
                NORMAL_MODE,
                STATE_VERSION,
                "01234567",
                FINGERPRINT,
                tick.expected_revision,
                tick.settled_deadline_ms,
                &paused,
            )
            .unwrap()
            .transaction_id;
        store
            .put(
                &recovered_checkpoint,
                "authority-test",
                Some("exact-revision-8"),
            )
            .unwrap();
        let published = store.commit(&recovered_checkpoint).unwrap();
        assert_eq!(published.revision, tick.expected_revision);
        assert_eq!(store.require_exact_realtime_lease().unwrap(), paused);
    }

    #[test]
    fn root_lifetime_lock_excludes_a_second_lease_writer() {
        let root = tempdir().unwrap();
        let mut first = SaveStore::open(root.path()).unwrap();
        prepare(&mut first);
        assert!(SaveStore::open(root.path()).is_err());
        drop(first);
        assert_eq!(
            SaveStore::open(root.path())
                .unwrap()
                .require_exact_realtime_lease()
                .unwrap()
                .run_id,
            RUN_ID
        );
    }
}
