use serde::{Deserialize, Serialize};
use serde_json::Value;

use dsp_native_core::{CoreAdvanceRequest, SimulationCommandPatch};

use crate::core_runtime::{
    CoreActivatePlayerAuthorityRequest, CoreCheckpointAcknowledgeExactRealtimeRequest,
    CoreCheckpointExactRealtimeFinalizationRequest, CoreCommitOperationExactRealtimeRequest,
    CoreCommitOperationRequest, CorePreparePlayerAuthorityRequest,
};
use crate::exact_realtime_lease::ExactRealtimeLeaseRequest;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavePutRecord {
    pub key: String,
    pub value: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CorePreparePlayerAuthorityControlRequest {
    pub session_id: String,
    pub request: CorePreparePlayerAuthorityRequest,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CoreActivatePlayerAuthorityControlRequest {
    pub session_id: String,
    pub request: CoreActivatePlayerAuthorityRequest,
}

#[derive(Debug, Deserialize)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "operation"
)]
pub enum ControlRequest {
    Hello {
        client_version: String,
    },
    SaveBegin {
        slot: String,
        mode: String,
        state_version: u16,
        base_checksum: String,
        registry_fingerprint: String,
        revision: u64,
        saved_at_ms: u64,
    },
    SavePut {
        transaction_id: String,
        key: String,
        value: Option<String>,
    },
    SavePutBatch {
        transaction_id: String,
        records: Vec<SavePutRecord>,
    },
    SaveCommit {
        transaction_id: String,
    },
    SaveAbort {
        transaction_id: String,
    },
    SaveRecover {
        slot: String,
    },
    SaveRead {
        slot: String,
        key: String,
        generation: u64,
        root_hash: String,
    },
    WalAppend {
        slot: String,
        base_revision: u64,
        revision: u64,
        command_id: String,
        payload: Value,
    },
    Compact {
        slot: String,
        retain_generations: Option<usize>,
    },
    ExactRealtimeLease {
        request: ExactRealtimeLeaseRequest,
    },
    CoreOpen {
        slot: String,
        generation: u64,
        root_hash: String,
        revision: u64,
        registry_fingerprint: String,
        catalog: Value,
    },
    CoreImportV47 {
        source_path: String,
        registry_fingerprint: String,
        catalog: Value,
    },
    CoreStatus {
        session_id: String,
    },
    CoreProjection {
        session_id: String,
        #[serde(default)]
        base_fields: Vec<String>,
        #[serde(default)]
        entity_ids: Vec<String>,
        #[serde(default)]
        belt_ids: Vec<String>,
    },
    CoreViewportProjection {
        session_id: String,
        #[serde(default)]
        base_fields: Vec<String>,
        planet_id: String,
        min_x: f64,
        min_y: f64,
        max_x: f64,
        max_y: f64,
        #[serde(default)]
        entity_cursor: usize,
        entity_limit: usize,
        belt_limit: usize,
    },
    CoreViewportProjectionV2 {
        session_id: String,
        #[serde(default)]
        base_fields: Vec<String>,
        planet_id: String,
        min_x: f64,
        min_y: f64,
        max_x: f64,
        max_y: f64,
        #[serde(default)]
        entity_cursor: usize,
        entity_limit: usize,
        #[serde(default)]
        belt_cursor: usize,
        belt_limit: usize,
        #[serde(default)]
        pinned_entity_ids: Vec<String>,
        #[serde(default)]
        pinned_belt_ids: Vec<String>,
    },
    CoreStatisticsProjection {
        session_id: String,
        min_elapsed_seconds: f64,
        max_elapsed_seconds: f64,
        #[serde(default)]
        cursor: usize,
        limit: usize,
        #[serde(default)]
        planet_id: Option<String>,
        #[serde(default)]
        item_id: Option<String>,
    },
    CoreApplyCommand {
        session_id: String,
        command: SimulationCommandPatch,
    },
    CoreAdvance {
        session_id: String,
        request: CoreAdvanceRequest,
    },
    CoreCommitOperation {
        session_id: String,
        request: CoreCommitOperationRequest,
    },
    CoreCommitOperationExactRealtime {
        session_id: String,
        request: CoreCommitOperationExactRealtimeRequest,
    },
    CorePreparePlayerAuthority(CorePreparePlayerAuthorityControlRequest),
    CoreActivatePlayerAuthority(CoreActivatePlayerAuthorityControlRequest),
    CoreCheckpoint {
        session_id: String,
        saved_at_ms: u64,
    },
    CoreCheckpointAcknowledgeExactRealtime {
        session_id: String,
        request: CoreCheckpointAcknowledgeExactRealtimeRequest,
    },
    CoreCheckpointExactRealtimeFinalization {
        session_id: String,
        request: CoreCheckpointExactRealtimeFinalizationRequest,
    },
    CoreExportV47 {
        session_id: String,
        export_id: String,
        saved_at_ms: u64,
    },
    CoreCompare {
        session_id: String,
        revision: u64,
        canonical_sha256: String,
        domain_sha256: String,
    },
    CoreClose {
        session_id: String,
    },
    Shutdown,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlResponse<T: Serialize> {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<T>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<ProtocolError>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProtocolError {
    pub code: String,
    pub message: String,
}

impl<T: Serialize> ControlResponse<T> {
    pub fn success(value: T) -> Self {
        Self {
            ok: true,
            value: Some(value),
            error: None,
        }
    }
}

impl ControlResponse<Value> {
    pub fn failure(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            ok: false,
            value: None,
            error: Some(ProtocolError {
                code: code.into(),
                message: message.into(),
            }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn player_authority_prepare_protocol_rejects_caller_supplied_proof() {
        let nested_proof = json!({
            "operation": "corePreparePlayerAuthority",
            "sessionId": "core-1",
            "request": {
                "runId": "player-authority-run",
                "expectedCheckpoint": {
                    "generation": 1,
                    "rootHash": "a".repeat(64),
                    "revision": 0
                },
                "settledDeadlineMs": 42_000,
                "proof": {
                    "revision": 0,
                    "canonicalSha256": "b".repeat(64),
                    "domainSha256": "c".repeat(64)
                }
            }
        });
        let error = serde_json::from_value::<ControlRequest>(nested_proof).unwrap_err();
        assert!(error.to_string().contains("unknown field `proof`"));

        let top_level_proof = json!({
            "operation": "corePreparePlayerAuthority",
            "sessionId": "core-1",
            "request": {
                "runId": "player-authority-run",
                "expectedCheckpoint": {
                    "generation": 1,
                    "rootHash": "a".repeat(64),
                    "revision": 0
                },
                "settledDeadlineMs": 42_000
            },
            "proof": {
                "revision": 0,
                "canonicalSha256": "b".repeat(64),
                "domainSha256": "c".repeat(64)
            }
        });
        let error = serde_json::from_value::<ControlRequest>(top_level_proof).unwrap_err();
        assert!(error.to_string().contains("unknown field `proof`"));
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HelloResponse {
    pub protocol_version: u16,
    pub native_format_version: u16,
    pub host_version: &'static str,
    pub capabilities: Vec<&'static str>,
}
