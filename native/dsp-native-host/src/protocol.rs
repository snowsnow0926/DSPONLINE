use serde::{Deserialize, Serialize};
use serde_json::Value;

use dsp_native_core::{CoreAdvanceRequest, SimulationCommandPatch};

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
    CoreOpen {
        slot: String,
        generation: u64,
        root_hash: String,
        revision: u64,
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
    CoreApplyCommand {
        session_id: String,
        command: SimulationCommandPatch,
    },
    CoreAdvance {
        session_id: String,
        request: CoreAdvanceRequest,
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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HelloResponse {
    pub protocol_version: u16,
    pub native_format_version: u16,
    pub host_version: &'static str,
    pub capabilities: Vec<&'static str>,
}
