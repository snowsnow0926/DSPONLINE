use serde::{Deserialize, Serialize};
use serde_json::Value;

use dsp_native_core::{CoreAdvanceRequest, SimulationCommandPatch};

use crate::core_runtime::{
    CoreActivatePlayerAuthorityRequest, CoreCheckpointAcknowledgeExactRealtimeRequest,
    CoreCheckpointExactRealtimeFinalizationRequest, CoreCommitOperationExactRealtimeRequest,
    CoreCommitOperationRequest, CoreCommitPlayerAuthorityCommandRequest,
    CoreCommitPlayerAuthorityMacroAdvanceRequest, CoreCommitPlayerAuthorityTickRequest,
    CoreFinishPlayerAuthorityMacroSessionRequest, CorePlayerAuthorityStartupRecoveryReceipt,
    CorePreparePlayerAuthorityRequest,
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
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CoreCommitPlayerAuthorityTickControlRequest {
    pub session_id: String,
    pub request: CoreCommitPlayerAuthorityTickRequest,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CoreCommitPlayerAuthorityCommandControlRequest {
    pub session_id: String,
    pub request: CoreCommitPlayerAuthorityCommandRequest,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CoreRecoverPlayerAuthorityCommandControlRequest {
    pub session_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CoreCommitPlayerAuthorityMacroAdvanceControlRequest {
    pub session_id: String,
    pub request: CoreCommitPlayerAuthorityMacroAdvanceRequest,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CoreFinishPlayerAuthorityMacroSessionControlRequest {
    pub session_id: String,
    pub request: CoreFinishPlayerAuthorityMacroSessionRequest,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CoreRecoverPlayerAuthorityMacroAdvanceControlRequest {
    pub session_id: String,
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
    CoreFactoryReadModelProjection {
        session_id: String,
        #[serde(default)]
        selected_entity_ids: Vec<String>,
        #[serde(default)]
        selected_belt_ids: Vec<String>,
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
    CoreTechnologyProjection {
        session_id: String,
    },
    CoreRecipeWorkspaceProjection {
        session_id: String,
        expected_registry_fingerprint: String,
        #[serde(default)]
        item_ids: Vec<String>,
        selected_item_id: String,
        #[serde(default)]
        location_planet_id: Option<String>,
        #[serde(default)]
        location_cursor: usize,
        #[serde(default)]
        location_limit: usize,
    },
    CoreCommandPaletteEntitySearchProjection {
        session_id: String,
        expected_revision: u64,
        expected_registry_fingerprint: String,
        query: String,
        #[serde(default)]
        cursor: usize,
        limit: usize,
        #[serde(default)]
        building_ids: Vec<String>,
        #[serde(default)]
        resource_ids: Vec<String>,
        #[serde(default)]
        planet_ids: Vec<String>,
    },
    CoreStarMapOverviewProjection {
        session_id: String,
        expected_revision: u64,
        expected_registry_fingerprint: String,
        #[serde(default)]
        cursor: usize,
        limit: usize,
    },
    CoreStellarIndustryProjection {
        session_id: String,
        expected_revision: u64,
        expected_registry_fingerprint: String,
        #[serde(default)]
        system_id: Option<String>,
        #[serde(default)]
        planet_id: Option<String>,
        #[serde(default)]
        planet_cursor: usize,
        planet_limit: usize,
        #[serde(default)]
        station_cursor: usize,
        station_limit: usize,
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
    CoreCommitPlayerAuthorityTick(CoreCommitPlayerAuthorityTickControlRequest),
    CoreCommitPlayerAuthorityCommand(CoreCommitPlayerAuthorityCommandControlRequest),
    CoreRecoverPlayerAuthorityCommand(CoreRecoverPlayerAuthorityCommandControlRequest),
    CoreCommitPlayerAuthorityMacroAdvance(CoreCommitPlayerAuthorityMacroAdvanceControlRequest),
    CoreFinishPlayerAuthorityMacroSession(CoreFinishPlayerAuthorityMacroSessionControlRequest),
    CoreRecoverPlayerAuthorityMacroAdvance(CoreRecoverPlayerAuthorityMacroAdvanceControlRequest),
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

    #[test]
    fn player_authority_tick_protocol_accepts_only_run_and_sequence() {
        let request = serde_json::from_value::<ControlRequest>(json!({
            "operation": "coreCommitPlayerAuthorityTick",
            "sessionId": "core-1",
            "request": {
                "runId": "player-authority-run",
                "sequence": 1
            }
        }))
        .unwrap();
        match request {
            ControlRequest::CoreCommitPlayerAuthorityTick(control) => {
                assert_eq!(control.session_id, "core-1");
                assert_eq!(control.request.run_id, "player-authority-run");
                assert_eq!(control.request.sequence, 1);
            }
            _ => panic!("player-authority tick decoded as the wrong operation"),
        }

        for forbidden in [
            "baseRevision",
            "registryFingerprint",
            "proof",
            "checkpoint",
            "commandId",
        ] {
            let mut value = json!({
                "operation": "coreCommitPlayerAuthorityTick",
                "sessionId": "core-1",
                "request": {
                    "runId": "player-authority-run",
                    "sequence": 1
                }
            });
            value["request"][forbidden] = json!(0);
            let error = serde_json::from_value::<ControlRequest>(value).unwrap_err();
            assert!(
                error.to_string().contains("unknown field"),
                "{forbidden}: {error}"
            );
        }

        let top_level_error = serde_json::from_value::<ControlRequest>(json!({
            "operation": "coreCommitPlayerAuthorityTick",
            "sessionId": "core-1",
            "request": {
                "runId": "player-authority-run",
                "sequence": 1
            },
            "checkpoint": {
                "generation": 1,
                "rootHash": "a".repeat(64),
                "revision": 0
            }
        }))
        .unwrap_err();
        assert!(top_level_error.to_string().contains("unknown field"));
    }

    #[test]
    fn player_authority_command_protocol_requires_exact_identity_and_patch() {
        let command = json!({
            "protocolVersion": 1,
            "baseRevision": 7,
            "topLevelChanges": [{
                "path": ["playerCommandProbe"],
                "operation": "set",
                "value": 1
            }],
            "changedEntities": [],
            "addedEntities": [],
            "removedEntityIds": [],
            "changedBelts": [],
            "addedBelts": [],
            "removedBeltIds": []
        });
        let value = json!({
            "operation": "coreCommitPlayerAuthorityCommand",
            "sessionId": "core-1",
            "request": {
                "runId": "player-authority-run",
                "commandId": "player-command-1",
                "baseRevision": 7,
                "command": command
            }
        });
        match serde_json::from_value::<ControlRequest>(value.clone()).unwrap() {
            ControlRequest::CoreCommitPlayerAuthorityCommand(control) => {
                assert_eq!(control.session_id, "core-1");
                assert_eq!(control.request.command_id, "player-command-1");
                assert_eq!(control.request.base_revision, 7);
                assert_eq!(control.request.command.base_revision, 7);
            }
            _ => panic!("player-authority command decoded as the wrong operation"),
        }
        for forbidden in ["proof", "checkpoint", "sequence", "simulationSeconds"] {
            let mut invalid = value.clone();
            invalid["request"][forbidden] = json!(0);
            let error = serde_json::from_value::<ControlRequest>(invalid).unwrap_err();
            assert!(
                error.to_string().contains("unknown field"),
                "{forbidden}: {error}"
            );
        }
        let mut nested_extra = value.clone();
        nested_extra["request"]["command"]["rendererProof"] = json!(true);
        assert!(
            serde_json::from_value::<ControlRequest>(nested_extra)
                .unwrap_err()
                .to_string()
                .contains("strictly normalized")
        );

        let recovered = serde_json::from_value::<ControlRequest>(json!({
            "operation": "coreRecoverPlayerAuthorityCommand",
            "sessionId": "core-1"
        }))
        .unwrap();
        assert!(matches!(
            recovered,
            ControlRequest::CoreRecoverPlayerAuthorityCommand(_)
        ));
        assert!(
            serde_json::from_value::<ControlRequest>(json!({
                "operation": "coreRecoverPlayerAuthorityCommand",
                "sessionId": "core-1",
                "command": command
            }))
            .unwrap_err()
            .to_string()
            .contains("unknown field")
        );
    }

    #[test]
    fn player_authority_macro_protocol_accepts_only_bounded_operation_identity_and_budget() {
        let value = json!({
            "operation": "coreCommitPlayerAuthorityMacroAdvance",
            "sessionId": "core-1",
            "request": {
                "runId": "player-authority-run",
                "macroSessionId": "macro-session-1",
                "operationId": "macro-operation-1",
                "baseRevision": 7,
                "simulationMilliseconds": 60_000,
                "wallMilliseconds": 4_000
            }
        });
        match serde_json::from_value::<ControlRequest>(value.clone()).unwrap() {
            ControlRequest::CoreCommitPlayerAuthorityMacroAdvance(control) => {
                assert_eq!(control.session_id, "core-1");
                assert_eq!(control.request.run_id, "player-authority-run");
                assert_eq!(control.request.macro_session_id, "macro-session-1");
                assert_eq!(control.request.operation_id, "macro-operation-1");
                assert_eq!(control.request.base_revision, 7);
                assert_eq!(control.request.simulation_milliseconds, 60_000);
                assert_eq!(control.request.wall_milliseconds, 4_000);
            }
            _ => panic!("player-authority macro decoded as the wrong operation"),
        }
        for forbidden in [
            "proof",
            "checkpoint",
            "algorithmVersion",
            "state",
            "command",
            "registryFingerprint",
        ] {
            let mut invalid = value.clone();
            invalid["request"][forbidden] = json!(0);
            let error = serde_json::from_value::<ControlRequest>(invalid).unwrap_err();
            assert!(
                error.to_string().contains("unknown field"),
                "{forbidden}: {error}"
            );
        }

        match serde_json::from_value::<ControlRequest>(json!({
            "operation": "coreFinishPlayerAuthorityMacroSession",
            "sessionId": "core-1",
            "request": {
                "runId": "player-authority-run",
                "macroSessionId": "macro-session-1"
            }
        }))
        .unwrap()
        {
            ControlRequest::CoreFinishPlayerAuthorityMacroSession(control) => {
                assert_eq!(control.session_id, "core-1");
                assert_eq!(control.request.run_id, "player-authority-run");
                assert_eq!(control.request.macro_session_id, "macro-session-1");
            }
            _ => panic!("player-authority macro finish decoded as the wrong operation"),
        }

        assert!(matches!(
            serde_json::from_value::<ControlRequest>(json!({
                "operation": "coreRecoverPlayerAuthorityMacroAdvance",
                "sessionId": "core-1"
            }))
            .unwrap(),
            ControlRequest::CoreRecoverPlayerAuthorityMacroAdvance(_)
        ));
        let error = serde_json::from_value::<ControlRequest>(json!({
            "operation": "coreRecoverPlayerAuthorityMacroAdvance",
            "sessionId": "core-1",
            "operationId": "renderer-forged"
        }))
        .unwrap_err();
        assert!(error.to_string().contains("unknown field"));
    }

    #[test]
    fn factory_read_model_protocol_preserves_bounded_opaque_selectors() {
        let request = serde_json::from_value::<ControlRequest>(json!({
            "operation": "coreFactoryReadModelProjection",
            "sessionId": "core-1",
            "selectedEntityIds": ["MOD-建筑/Ω"],
            "selectedBeltIds": ["MOD-线路/β"]
        }))
        .unwrap();
        match request {
            ControlRequest::CoreFactoryReadModelProjection {
                session_id,
                selected_entity_ids,
                selected_belt_ids,
            } => {
                assert_eq!(session_id, "core-1");
                assert_eq!(selected_entity_ids, ["MOD-建筑/Ω"]);
                assert_eq!(selected_belt_ids, ["MOD-线路/β"]);
            }
            _ => panic!("factory read-model operation decoded as the wrong variant"),
        }

        let defaults = serde_json::from_value::<ControlRequest>(json!({
            "operation": "coreFactoryReadModelProjection",
            "sessionId": "core-2"
        }))
        .unwrap();
        match defaults {
            ControlRequest::CoreFactoryReadModelProjection {
                selected_entity_ids,
                selected_belt_ids,
                ..
            } => {
                assert!(selected_entity_ids.is_empty());
                assert!(selected_belt_ids.is_empty());
            }
            _ => panic!("factory read-model defaults decoded as the wrong variant"),
        }
    }

    #[test]
    fn recipe_workspace_protocol_preserves_explicit_page_and_location_selectors() {
        let request = serde_json::from_value::<ControlRequest>(json!({
            "operation": "coreRecipeWorkspaceProjection",
            "sessionId": "core-1",
            "expectedRegistryFingerprint": "builtin:test",
            "itemIds": ["iron_ore", "iron_ingot"],
            "selectedItemId": "iron_ingot",
            "locationPlanetId": "home",
            "locationCursor": 4,
            "locationLimit": 32
        }))
        .unwrap();
        match request {
            ControlRequest::CoreRecipeWorkspaceProjection {
                session_id,
                expected_registry_fingerprint,
                item_ids,
                selected_item_id,
                location_planet_id,
                location_cursor,
                location_limit,
            } => {
                assert_eq!(session_id, "core-1");
                assert_eq!(expected_registry_fingerprint, "builtin:test");
                assert_eq!(item_ids, ["iron_ore", "iron_ingot"]);
                assert_eq!(selected_item_id, "iron_ingot");
                assert_eq!(location_planet_id.as_deref(), Some("home"));
                assert_eq!(location_cursor, 4);
                assert_eq!(location_limit, 32);
            }
            _ => panic!("recipe workspace operation decoded as the wrong variant"),
        }

        let defaults = serde_json::from_value::<ControlRequest>(json!({
            "operation": "coreRecipeWorkspaceProjection",
            "sessionId": "core-2",
            "expectedRegistryFingerprint": "builtin:test",
            "selectedItemId": "iron_ore"
        }))
        .unwrap();
        match defaults {
            ControlRequest::CoreRecipeWorkspaceProjection {
                item_ids,
                location_planet_id,
                location_cursor,
                location_limit,
                ..
            } => {
                assert!(item_ids.is_empty());
                assert!(location_planet_id.is_none());
                assert_eq!(location_cursor, 0);
                assert_eq!(location_limit, 0);
            }
            _ => panic!("recipe workspace defaults decoded as the wrong variant"),
        }
    }

    #[test]
    fn command_palette_protocol_preserves_bounded_search_page_selectors() {
        let request = serde_json::from_value::<ControlRequest>(json!({
            "operation": "coreCommandPaletteEntitySearchProjection",
            "sessionId": "core-1",
            "expectedRevision": 42,
            "expectedRegistryFingerprint": "builtin:test",
            "query": "熔炉",
            "cursor": 16,
            "limit": 16,
            "buildingIds": ["smelter"],
            "resourceIds": ["iron_ore"],
            "planetIds": ["home"]
        }))
        .unwrap();
        match request {
            ControlRequest::CoreCommandPaletteEntitySearchProjection {
                session_id,
                expected_revision,
                expected_registry_fingerprint,
                query,
                cursor,
                limit,
                building_ids,
                resource_ids,
                planet_ids,
            } => {
                assert_eq!(session_id, "core-1");
                assert_eq!(expected_revision, 42);
                assert_eq!(expected_registry_fingerprint, "builtin:test");
                assert_eq!(query, "熔炉");
                assert_eq!(cursor, 16);
                assert_eq!(limit, 16);
                assert_eq!(building_ids, ["smelter"]);
                assert_eq!(resource_ids, ["iron_ore"]);
                assert_eq!(planet_ids, ["home"]);
            }
            _ => panic!("command palette search decoded as the wrong variant"),
        }
    }

    #[test]
    fn stellar_workspace_protocol_preserves_revision_bound_pages_and_filters() {
        let overview = serde_json::from_value::<ControlRequest>(json!({
            "operation": "coreStarMapOverviewProjection",
            "sessionId": "core-1",
            "expectedRevision": 42,
            "expectedRegistryFingerprint": "builtin:test",
            "cursor": 8,
            "limit": 16
        }))
        .unwrap();
        match overview {
            ControlRequest::CoreStarMapOverviewProjection {
                session_id,
                expected_revision,
                expected_registry_fingerprint,
                cursor,
                limit,
            } => {
                assert_eq!(session_id, "core-1");
                assert_eq!(expected_revision, 42);
                assert_eq!(expected_registry_fingerprint, "builtin:test");
                assert_eq!(cursor, 8);
                assert_eq!(limit, 16);
            }
            _ => panic!("star-map overview decoded as the wrong variant"),
        }

        let industry = serde_json::from_value::<ControlRequest>(json!({
            "operation": "coreStellarIndustryProjection",
            "sessionId": "core-2",
            "expectedRevision": 43,
            "expectedRegistryFingerprint": "builtin:test",
            "systemId": "sol",
            "planetId": "home",
            "planetCursor": 1,
            "planetLimit": 32,
            "stationCursor": 2,
            "stationLimit": 16
        }))
        .unwrap();
        match industry {
            ControlRequest::CoreStellarIndustryProjection {
                session_id,
                expected_revision,
                expected_registry_fingerprint,
                system_id,
                planet_id,
                planet_cursor,
                planet_limit,
                station_cursor,
                station_limit,
            } => {
                assert_eq!(session_id, "core-2");
                assert_eq!(expected_revision, 43);
                assert_eq!(expected_registry_fingerprint, "builtin:test");
                assert_eq!(system_id.as_deref(), Some("sol"));
                assert_eq!(planet_id.as_deref(), Some("home"));
                assert_eq!(planet_cursor, 1);
                assert_eq!(planet_limit, 32);
                assert_eq!(station_cursor, 2);
                assert_eq!(station_limit, 16);
            }
            _ => panic!("stellar-industry projection decoded as the wrong variant"),
        }

        let defaults = serde_json::from_value::<ControlRequest>(json!({
            "operation": "coreStellarIndustryProjection",
            "sessionId": "core-3",
            "expectedRevision": 44,
            "expectedRegistryFingerprint": "builtin:test",
            "planetLimit": 1,
            "stationLimit": 1
        }))
        .unwrap();
        match defaults {
            ControlRequest::CoreStellarIndustryProjection {
                system_id,
                planet_id,
                planet_cursor,
                station_cursor,
                ..
            } => {
                assert!(system_id.is_none());
                assert!(planet_id.is_none());
                assert_eq!(planet_cursor, 0);
                assert_eq!(station_cursor, 0);
            }
            _ => panic!("stellar-industry defaults decoded as the wrong variant"),
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub player_authority_startup_recovery: Option<CorePlayerAuthorityStartupRecoveryReceipt>,
}
