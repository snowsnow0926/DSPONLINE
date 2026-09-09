use std::env;
use std::io::{self, BufReader, BufWriter};
use std::path::PathBuf;

use anyhow::{Context, anyhow, bail};
use dsp_native_core::{
    V47_IMPORT_JS_COMPATIBILITY_REQUIRED_CODE, V47ImportJavascriptCompatibilityRequired,
};
use dsp_native_host::core_runtime::{
    CorePlayerAuthorityStartupRecoveryReceipt, CoreRegistry,
    NATIVE_CORE_VIEWPORT_ENTITY_PRESENTATION_V1_CAPABILITY, PLAYER_AUTHORITY_COMMAND_CAPABILITY,
    PLAYER_AUTHORITY_GATE_CAPABILITY, PLAYER_AUTHORITY_MACRO_ADVANCE_CAPABILITY,
    PLAYER_AUTHORITY_OPERATIONS_SETTING_COMMAND_CAPABILITY,
    PLAYER_AUTHORITY_OPERATIONS_SETTING_PRE_STAGE_REJECTED_CODE,
    PLAYER_AUTHORITY_ORBITAL_CONTRACT_COMMAND_CAPABILITY,
    PLAYER_AUTHORITY_ORBITAL_CONTRACT_PRE_STAGE_REJECTED_CODE, PLAYER_AUTHORITY_PAUSE_CAPABILITY,
    PLAYER_AUTHORITY_STARTUP_RECOVERY_CAPABILITY,
    PLAYER_AUTHORITY_SYSTEM_SPACE_STATION_COMMAND_CAPABILITY,
    PLAYER_AUTHORITY_SYSTEM_SPACE_STATION_PRE_STAGE_REJECTED_CODE,
    PLAYER_AUTHORITY_TICK_CAPABILITY, PlayerAuthorityOperationsSettingPreStageRejected,
    PlayerAuthorityOrbitalContractPreStageRejected,
    PlayerAuthoritySystemSpaceStationPreStageRejected,
};
use dsp_native_host::exact_realtime_lease::{
    EXACT_REALTIME_LEASE_CAPABILITY, EXACT_REALTIME_WRITER_FENCE_CAPABILITY,
};
use dsp_native_host::frame::{Frame, FrameKind, read_frame, write_frame};
use dsp_native_host::protocol::{ControlRequest, ControlResponse, HelloResponse};
use dsp_native_host::save_store::SaveStore;
use dsp_native_host::v47_import::open_v47_import_source;
use serde_json::{Value, json, to_value};

const NATIVE_CORE_BLUEPRINT_CAPTURE_CONTEXT_V1_CAPABILITY: &str =
    "native-core-blueprint-capture-context-v1";
const NATIVE_CORE_BLUEPRINT_IMPORT_CONTEXT_V1_CAPABILITY: &str =
    "native-core-blueprint-import-context-v1";
const NATIVE_CORE_BLUEPRINT_EXPORT_CONTEXT_V1_CAPABILITY: &str =
    "native-core-blueprint-export-context-v1";

enum HostAction {
    Continue(Value),
    Shutdown(Value),
}

fn profile_operation_duration_is_valid(
    purpose: dsp_native_core::ProfileOperationPurpose,
    request: &dsp_native_core::CoreAdvanceRequest,
) -> bool {
    match purpose {
        dsp_native_core::ProfileOperationPurpose::QuantumOactiveShapeV1 => {
            request.simulation_seconds == request.wall_seconds
                && matches!(request.simulation_seconds, 1.0 | 5.0 | 60.0)
        }
        dsp_native_core::ProfileOperationPurpose::LocalDispatchTimingV1
        | dsp_native_core::ProfileOperationPurpose::LocalDispatchShapeV1 => {
            request.simulation_seconds == 1.0 && request.wall_seconds == 1.0
        }
    }
}

fn parse_serve_root() -> anyhow::Result<PathBuf> {
    let mut arguments = env::args_os().skip(1);
    let command = arguments
        .next()
        .ok_or_else(|| anyhow!("missing native host command"))?;
    if command != "serve" {
        bail!("usage: dsp-native-host serve --root <absolute-user-data-path>");
    }
    let flag = arguments.next().ok_or_else(|| anyhow!("missing --root"))?;
    if flag != "--root" {
        bail!("native host accepts only --root after serve");
    }
    let root = PathBuf::from(
        arguments
            .next()
            .ok_or_else(|| anyhow!("missing native save root"))?,
    );
    if arguments.next().is_some() {
        bail!("native host received unexpected arguments");
    }
    if !root.is_absolute() {
        bail!("native save root must be absolute");
    }
    Ok(root)
}

fn handle_request(
    store: &mut SaveStore,
    cores: &mut CoreRegistry,
    player_authority_startup_recovery: &mut Option<CorePlayerAuthorityStartupRecoveryReceipt>,
    request_id: u64,
    request: ControlRequest,
) -> anyhow::Result<HostAction> {
    let value = match request {
        ControlRequest::Hello { client_version } => {
            if client_version.is_empty() || client_version.len() > 64 {
                bail!("native host client version is invalid");
            }
            to_value(HelloResponse {
                protocol_version: dsp_native_host::NATIVE_PROTOCOL_VERSION,
                native_format_version: dsp_native_host::NATIVE_FORMAT_VERSION,
                host_version: env!("CARGO_PKG_VERSION"),
                capabilities: vec![
                    "native-save-v1",
                    "native-save-put-batch-v1",
                    "dual-superblock",
                    "content-addressed-chunks",
                    "contiguous-wal",
                    "compaction-v1",
                    "native-core-state-v1",
                    "native-core-shadow-v1",
                    "native-core-command-v1",
                    "native-core-projection-v1",
                    "native-core-viewport-projection-v1",
                    "native-core-viewport-projection-v2",
                    NATIVE_CORE_VIEWPORT_ENTITY_PRESENTATION_V1_CAPABILITY,
                    "native-core-factory-read-model-v1",
                    "native-core-factory-inventory-v1",
                    "native-core-construction-inventory-v1",
                    "native-core-blueprint-workspace-v1",
                    "native-core-blueprint-enqueue-context-v1",
                    NATIVE_CORE_BLUEPRINT_CAPTURE_CONTEXT_V1_CAPABILITY,
                    NATIVE_CORE_BLUEPRINT_IMPORT_CONTEXT_V1_CAPABILITY,
                    NATIVE_CORE_BLUEPRINT_EXPORT_CONTEXT_V1_CAPABILITY,
                    "native-core-blueprint-direct-deploy-context-v1",
                    "native-core-construction-placement-context-v1",
                    "native-core-construction-belt-placement-context-v1",
                    "native-core-construction-belt-lane-context-v1",
                    "native-core-construction-belt-removal-context-v1",
                    "native-core-construction-removal-context-v1",
                    "native-core-construction-stack-context-v1",
                    "native-core-statistics-projection-v1",
                    "native-core-technology-projection-v1",
                    "native-core-recipe-workspace-projection-v1",
                    "native-core-command-palette-entity-search-v1",
                    "native-core-star-map-overview-projection-v1",
                    "native-core-star-map-catalog-projection-v1",
                    "native-core-stellar-industry-projection-v1",
                    "native-core-stellar-industry-projection-v2",
                    "native-core-stellar-quantum-projection-v1",
                    "native-core-dyson-workspace-projection-v1",
                    "native-core-system-space-station-workspace-projection-v1",
                    "native-core-orbital-contract-workspace-projection-v1",
                    "native-core-campaign-workspace-projection-v1",
                    "native-core-operations-workspace-projection-v1",
                    "native-core-galaxy-account-workspace-projection-v1",
                    "native-core-authority-wal-v1",
                    "native-core-checkpoint-v1",
                    "native-core-v47-stream-export-v1",
                    "native-core-v47-stream-import-v1",
                    "native-core-v46-to-v47-stream-adapter-v1",
                    "native-core-offline-macro-v1",
                    "native-core-offline-candidate-export-v1",
                    "native-core-offline-runtime-source-export-v1",
                    EXACT_REALTIME_LEASE_CAPABILITY,
                    EXACT_REALTIME_WRITER_FENCE_CAPABILITY,
                    PLAYER_AUTHORITY_GATE_CAPABILITY,
                    PLAYER_AUTHORITY_TICK_CAPABILITY,
                    PLAYER_AUTHORITY_COMMAND_CAPABILITY,
                    PLAYER_AUTHORITY_SYSTEM_SPACE_STATION_COMMAND_CAPABILITY,
                    PLAYER_AUTHORITY_ORBITAL_CONTRACT_COMMAND_CAPABILITY,
                    PLAYER_AUTHORITY_OPERATIONS_SETTING_COMMAND_CAPABILITY,
                    PLAYER_AUTHORITY_PAUSE_CAPABILITY,
                    PLAYER_AUTHORITY_MACRO_ADVANCE_CAPABILITY,
                    PLAYER_AUTHORITY_STARTUP_RECOVERY_CAPABILITY,
                ],
                player_authority_startup_recovery: player_authority_startup_recovery.take(),
            })?
        }
        ControlRequest::SaveBegin {
            slot,
            mode,
            state_version,
            base_checksum,
            registry_fingerprint,
            revision,
            saved_at_ms,
        } => to_value(store.begin(
            &slot,
            &mode,
            state_version,
            &base_checksum,
            &registry_fingerprint,
            revision,
            saved_at_ms,
        )?)?,
        ControlRequest::SavePut {
            transaction_id,
            key,
            value,
        } => {
            store.put(&transaction_id, &key, value.as_deref())?;
            json!({ "accepted": true })
        }
        ControlRequest::SavePutBatch {
            transaction_id,
            records,
        } => {
            let batch = records
                .iter()
                .map(|record| (record.key.as_str(), record.value.as_deref()))
                .collect::<Vec<_>>();
            store.put_batch(&transaction_id, &batch)?;
            json!({ "acceptedRecords": records.len() })
        }
        ControlRequest::SaveCommit { transaction_id } => to_value(store.commit(&transaction_id)?)?,
        ControlRequest::SaveAbort { transaction_id } => {
            json!({ "aborted": store.abort(&transaction_id) })
        }
        ControlRequest::SaveRecover { slot } => to_value(store.recover(&slot)?)?,
        ControlRequest::SaveRead {
            slot,
            key,
            generation,
            root_hash,
        } => {
            let value = store
                .read_record_at(&slot, &key, generation, &root_hash)?
                .map(String::from_utf8)
                .transpose()
                .context("native save record is not UTF-8")?;
            json!({
                "slot": slot,
                "generation": generation,
                "rootHash": root_hash,
                "key": key,
                "value": value,
            })
        }
        ControlRequest::WalAppend {
            slot,
            base_revision,
            revision,
            command_id,
            payload,
        } => to_value(store.append_wal(&slot, base_revision, revision, &command_id, payload)?)?,
        ControlRequest::Compact {
            slot,
            retain_generations,
        } => {
            json!({ "removedGenerations": store.compact(&slot, retain_generations.unwrap_or(2))? })
        }
        ControlRequest::ExactRealtimeLease { request } => store.exact_realtime_lease(request)?,
        ControlRequest::CoreOpen {
            slot,
            generation,
            root_hash,
            revision,
            registry_fingerprint,
            catalog,
        } => to_value(cores.open(
            store,
            &slot,
            generation,
            &root_hash,
            revision,
            &registry_fingerprint,
            catalog,
        )?)?,
        ControlRequest::CoreImportV47 {
            source_path,
            registry_fingerprint,
            catalog,
        } => {
            let source = open_v47_import_source(&PathBuf::from(source_path))?;
            let (reader, expected_byte_length) = source.into_decoded_reader();
            let imported = if let Some(expected_byte_length) = expected_byte_length {
                cores.import_v47(
                    store,
                    reader,
                    expected_byte_length,
                    &registry_fingerprint,
                    catalog,
                )?
            } else {
                cores.import_v47_stream(store, reader, &registry_fingerprint, catalog)?
            };
            to_value(imported)?
        }
        ControlRequest::CoreStatus { session_id } => to_value(cores.status(&session_id)?)?,
        ControlRequest::CoreProjection {
            session_id,
            base_fields,
            entity_ids,
            belt_ids,
        } => cores.projection(&session_id, &base_fields, &entity_ids, &belt_ids)?,
        ControlRequest::CoreViewportProjection {
            session_id,
            base_fields,
            planet_id,
            min_x,
            min_y,
            max_x,
            max_y,
            entity_cursor,
            entity_limit,
            belt_limit,
        } => cores.viewport_projection(
            &session_id,
            &base_fields,
            &planet_id,
            min_x,
            min_y,
            max_x,
            max_y,
            entity_cursor,
            entity_limit,
            belt_limit,
        )?,
        ControlRequest::CoreViewportProjectionV2 {
            session_id,
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
            entity_presentation_version,
        } => cores.viewport_projection_v2_with_entity_presentation(
            &session_id,
            &base_fields,
            &planet_id,
            min_x,
            min_y,
            max_x,
            max_y,
            entity_cursor,
            entity_limit,
            belt_cursor,
            belt_limit,
            &pinned_entity_ids,
            &pinned_belt_ids,
            entity_presentation_version,
        )?,
        ControlRequest::CoreFactoryReadModelProjection {
            session_id,
            selected_entity_ids,
            selected_belt_ids,
        } => cores.factory_read_model_projection(
            &session_id,
            &selected_entity_ids,
            &selected_belt_ids,
        )?,
        ControlRequest::CoreFactoryInventoryProjection {
            session_id,
            expected_revision,
            cursor,
            limit,
        } => cores.factory_inventory_projection(&session_id, expected_revision, cursor, limit)?,
        ControlRequest::CoreConstructionInventoryProjection {
            session_id,
            expected_revision,
            expected_registry_fingerprint,
            cursor,
            limit,
        } => cores.construction_inventory_projection(
            &session_id,
            expected_revision,
            &expected_registry_fingerprint,
            cursor,
            limit,
        )?,
        ControlRequest::CoreBlueprintWorkspaceProjection {
            session_id,
            expected_revision,
            expected_registry_fingerprint,
            section,
            blueprint_id,
            queue_entry_id,
            cursor,
            limit,
        } => cores.blueprint_workspace_projection(
            &session_id,
            expected_revision,
            &expected_registry_fingerprint,
            &section,
            blueprint_id.as_deref(),
            queue_entry_id.as_deref(),
            cursor,
            limit,
        )?,
        ControlRequest::CoreBlueprintEnqueueContext {
            session_id,
            expected_revision,
            expected_registry_fingerprint,
            blueprint_id,
            blueprint_revision,
        } => cores.blueprint_enqueue_context(
            &session_id,
            expected_revision,
            &expected_registry_fingerprint,
            &blueprint_id,
            blueprint_revision,
        )?,
        ControlRequest::CoreBlueprintCaptureContext {
            session_id,
            expected_revision,
            expected_registry_fingerprint,
            entity_ids,
        } => cores.blueprint_capture_context(
            &session_id,
            expected_revision,
            &expected_registry_fingerprint,
            &entity_ids,
        )?,
        ControlRequest::CoreBlueprintImportContext(request) => cores.blueprint_import_context(
            &request.session_id,
            request.expected_revision,
            &request.expected_registry_fingerprint,
            &request.raw,
        )?,
        ControlRequest::CoreBlueprintExportContext(request) => cores.blueprint_export_context(
            &request.session_id,
            request.expected_revision,
            &request.expected_registry_fingerprint,
            &request.blueprint_id,
            request.blueprint_revision,
        )?,
        ControlRequest::CoreBlueprintDirectDeployContext {
            session_id,
            expected_revision,
            expected_registry_fingerprint,
            blueprint_id,
            blueprint_revision,
            position,
        } => cores.blueprint_direct_deploy_context(
            &session_id,
            expected_revision,
            &expected_registry_fingerprint,
            &blueprint_id,
            blueprint_revision,
            position.x,
            position.y,
        )?,
        ControlRequest::CoreConstructionPlacementContext {
            session_id,
            expected_revision,
            expected_registry_fingerprint,
            building_id,
        } => cores.construction_placement_context(
            &session_id,
            expected_revision,
            &expected_registry_fingerprint,
            &building_id,
        )?,
        ControlRequest::CoreConstructionBeltPlacementContext {
            session_id,
            expected_revision,
            expected_registry_fingerprint,
            source_id,
            target_id,
            item_id,
            tier,
            lanes,
        } => cores.construction_belt_placement_context(
            &session_id,
            expected_revision,
            &expected_registry_fingerprint,
            &source_id,
            &target_id,
            &item_id,
            tier,
            lanes,
        )?,
        ControlRequest::CoreConstructionBeltRemovalContext {
            session_id,
            expected_revision,
            expected_registry_fingerprint,
            belt_id,
        } => cores.construction_belt_removal_context(
            &session_id,
            expected_revision,
            &expected_registry_fingerprint,
            &belt_id,
        )?,
        ControlRequest::CoreConstructionBeltLaneContext {
            session_id,
            expected_revision,
            expected_registry_fingerprint,
            belt_id,
            target_lanes,
        } => cores.construction_belt_lane_context(
            &session_id,
            expected_revision,
            &expected_registry_fingerprint,
            &belt_id,
            target_lanes,
        )?,
        ControlRequest::CoreConstructionRemovalContext {
            session_id,
            expected_revision,
            expected_registry_fingerprint,
            entity_id,
        } => cores.construction_removal_context(
            &session_id,
            expected_revision,
            &expected_registry_fingerprint,
            &entity_id,
        )?,
        ControlRequest::CoreConstructionStackContext {
            session_id,
            expected_revision,
            expected_registry_fingerprint,
            entity_id,
            target_count,
        } => cores.construction_stack_context(
            &session_id,
            expected_revision,
            &expected_registry_fingerprint,
            &entity_id,
            target_count,
        )?,
        ControlRequest::CoreStatisticsProjection {
            session_id,
            min_elapsed_seconds,
            max_elapsed_seconds,
            cursor,
            limit,
            planet_id,
            item_id,
        } => cores.statistics_projection(
            &session_id,
            min_elapsed_seconds,
            max_elapsed_seconds,
            cursor,
            limit,
            planet_id.as_deref(),
            item_id.as_deref(),
        )?,
        ControlRequest::CoreTechnologyProjection { session_id } => {
            cores.technology_projection(&session_id)?
        }
        ControlRequest::CoreRecipeWorkspaceProjection {
            session_id,
            expected_registry_fingerprint,
            item_ids,
            selected_item_id,
            location_planet_id,
            location_cursor,
            location_limit,
        } => cores.recipe_workspace_projection(
            &session_id,
            &expected_registry_fingerprint,
            &item_ids,
            &selected_item_id,
            location_planet_id.as_deref(),
            location_cursor,
            location_limit,
        )?,
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
        } => cores.command_palette_entity_search_projection(
            &session_id,
            expected_revision,
            &expected_registry_fingerprint,
            &query,
            cursor,
            limit,
            &building_ids,
            &resource_ids,
            &planet_ids,
        )?,
        ControlRequest::CoreStarMapOverviewProjection {
            session_id,
            expected_revision,
            expected_registry_fingerprint,
            cursor,
            limit,
        } => cores.star_map_overview_projection(
            &session_id,
            expected_revision,
            &expected_registry_fingerprint,
            cursor,
            limit,
        )?,
        ControlRequest::CoreStarMapCatalogProjection {
            session_id,
            expected_revision,
            expected_registry_fingerprint,
            system_cursor,
            system_limit,
            planet_cursor,
            planet_limit,
        } => cores.star_map_catalog_projection(
            &session_id,
            expected_revision,
            &expected_registry_fingerprint,
            system_cursor,
            system_limit,
            planet_cursor,
            planet_limit,
        )?,
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
        } => cores.stellar_industry_projection(
            &session_id,
            expected_revision,
            &expected_registry_fingerprint,
            system_id.as_deref(),
            planet_id.as_deref(),
            planet_cursor,
            planet_limit,
            station_cursor,
            station_limit,
        )?,
        ControlRequest::CoreStellarIndustryProjectionV2 {
            session_id,
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
        } => cores.stellar_industry_v2_projection(
            &session_id,
            expected_revision,
            &expected_registry_fingerprint,
            system_id.as_deref(),
            planet_id.as_deref(),
            planet_cursor,
            planet_limit,
            station_cursor,
            station_limit,
            route_cursor,
            route_limit,
            &route_filter,
            &query,
        )?,
        ControlRequest::CoreStellarQuantumProjection {
            session_id,
            expected_revision,
            expected_registry_fingerprint,
            item_cursor,
            item_limit,
            collector_cursor,
            collector_limit,
        } => cores.stellar_quantum_projection(
            &session_id,
            expected_revision,
            &expected_registry_fingerprint,
            item_cursor,
            item_limit,
            collector_cursor,
            collector_limit,
        )?,
        ControlRequest::CoreDysonWorkspaceProjection {
            session_id,
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
        } => cores.dyson_workspace_projection(
            &session_id,
            expected_revision,
            &expected_registry_fingerprint,
            &selected_system_id,
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
        )?,
        ControlRequest::CoreSystemSpaceStationWorkspaceProjection {
            session_id,
            run_id,
            expected_revision,
            expected_registry_fingerprint,
            system_id,
            requirement_cursor,
            requirement_limit,
            inventory_cursor,
            inventory_limit,
            tray_cursor,
            tray_limit,
            station_cursor,
            station_limit,
        } => cores.system_space_station_workspace_projection(
            &session_id,
            &run_id,
            expected_revision,
            &expected_registry_fingerprint,
            &system_id,
            requirement_cursor,
            requirement_limit,
            inventory_cursor,
            inventory_limit,
            tray_cursor,
            tray_limit,
            station_cursor,
            station_limit,
        )?,
        ControlRequest::CoreOrbitalContractWorkspaceProjection {
            session_id,
            run_id,
            expected_revision,
            expected_registry_fingerprint,
            confirmed_wall_clock_ms,
        } => cores.orbital_contract_workspace_projection(
            store,
            &session_id,
            &run_id,
            expected_revision,
            &expected_registry_fingerprint,
            confirmed_wall_clock_ms,
        )?,
        ControlRequest::CoreCampaignWorkspaceProjection {
            session_id,
            run_id,
            expected_revision,
            expected_registry_fingerprint,
        } => cores.campaign_workspace_projection(
            store,
            &session_id,
            &run_id,
            expected_revision,
            &expected_registry_fingerprint,
        )?,
        ControlRequest::CoreOperationsWorkspaceProjection {
            session_id,
            run_id,
            expected_revision,
            expected_registry_fingerprint,
        } => cores.operations_workspace_projection(
            store,
            &session_id,
            &run_id,
            expected_revision,
            &expected_registry_fingerprint,
        )?,
        ControlRequest::CoreGalaxyAccountWorkspaceProjection {
            session_id,
            run_id,
            expected_revision,
            expected_registry_fingerprint,
        } => cores.galaxy_account_workspace_projection(
            store,
            &session_id,
            &run_id,
            expected_revision,
            &expected_registry_fingerprint,
        )?,
        ControlRequest::CoreApplyCommand {
            session_id,
            command,
        } => to_value(cores.apply_command(&session_id, &command)?)?,
        ControlRequest::CoreAdvance {
            session_id,
            request,
            profile_purpose,
        } => {
            if let Some(purpose) = profile_purpose {
                if std::env::var("DSP_NATIVE_CORE_PROFILE").as_deref() != Ok("1") {
                    bail!("native core profile purpose requires the fixed profile environment");
                }
                if !profile_operation_duration_is_valid(purpose, &request)
                    || request.advance_mode != dsp_native_core::CoreAdvanceMode::Exact
                    || request.include_diagnostics
                {
                    bail!(
                        "native core profile purpose requires an approved exact diagnostic-free duration"
                    );
                }
                let binding = dsp_native_core::ProfileOperationBinding::new(
                    request_id,
                    &session_id,
                    request.base_revision,
                    purpose,
                )
                .ok_or_else(|| anyhow!("native core profile operation binding is invalid"))?;
                let capture = dsp_native_core::with_profile_operation_binding(binding, || {
                    cores.advance(&session_id, &request)
                });
                let mut value = to_value(capture.result?)?;
                value
                    .as_object_mut()
                    .ok_or_else(|| anyhow!("native core profile response must be an object"))?
                    .insert(
                        "profileEvidence".to_owned(),
                        serde_json::json!({
                            "protocol": "native-core-advance-profile-response-v1",
                            "requestId": request_id,
                            "overflowed": capture.overflowed,
                            "records": capture.records,
                        }),
                    );
                value
            } else {
                to_value(cores.advance(&session_id, &request)?)?
            }
        }
        ControlRequest::CoreCommitOperation {
            session_id,
            request,
        } => to_value(cores.commit_operation(store, &session_id, request)?)?,
        ControlRequest::CoreCommitOfflineSettlement {
            session_id,
            request,
        } => to_value(cores.commit_offline_settlement(store, &session_id, request)?)?,
        ControlRequest::CorePrepareOfflineSourceExport {
            source_path,
            request,
        } => {
            let source = open_v47_import_source(&PathBuf::from(source_path))?;
            let (reader, byte_length) = source.into_decoded_reader();
            let byte_length = byte_length
                .ok_or_else(|| anyhow!("native offline runtime source must be plain JSON"))?;
            to_value(cores.prepare_offline_source_export(store, reader, byte_length, request)?)?
        }
        ControlRequest::CorePrepareOfflineSettlementExport {
            session_id,
            request,
        } => to_value(cores.prepare_offline_settlement_export(store, &session_id, request)?)?,
        ControlRequest::CoreCommitOperationExactRealtime {
            session_id,
            request,
        } => to_value(cores.commit_operation_exact_realtime(store, &session_id, request)?)?,
        ControlRequest::CorePreparePlayerAuthority(control) => to_value(
            cores.prepare_player_authority(store, &control.session_id, control.request)?,
        )?,
        ControlRequest::CoreActivatePlayerAuthority(control) => to_value(
            cores.activate_player_authority(store, &control.session_id, control.request)?,
        )?,
        ControlRequest::CoreCommitPlayerAuthorityTick(control) => to_value(
            cores.commit_player_authority_tick(store, &control.session_id, control.request)?,
        )?,
        ControlRequest::CoreCommitPlayerAuthorityCommand(control) => to_value(
            cores.commit_player_authority_command(store, &control.session_id, control.request)?,
        )?,
        ControlRequest::CorePlayerAuthorityHistoryStatus(control) => {
            to_value(cores.player_authority_history_status(&control.session_id)?)?
        }
        ControlRequest::CoreCommitPlayerAuthorityHistory(control) => to_value(
            cores.commit_player_authority_history(store, &control.session_id, control.request)?,
        )?,
        ControlRequest::CoreCommitPlayerAuthoritySystemSpaceStationCommand(control) => {
            to_value(cores.commit_player_authority_system_space_station_command(
                store,
                &control.session_id,
                control.request,
            )?)?
        }
        ControlRequest::CoreCommitPlayerAuthorityOrbitalContractCommand(control) => {
            to_value(cores.commit_player_authority_orbital_contract_command(
                store,
                &control.session_id,
                control.request,
            )?)?
        }
        ControlRequest::CoreCommitPlayerAuthorityOperationsSettingCommand(control) => {
            to_value(cores.commit_player_authority_operations_setting_command(
                store,
                &control.session_id,
                control.request,
            )?)?
        }
        ControlRequest::CoreCommitPlayerAuthorityPause(control) => {
            to_value(cores.commit_player_authority_pause_transition(
                store,
                &control.session_id,
                control.request,
            )?)?
        }
        ControlRequest::CoreRecoverPlayerAuthorityCommand(control) => {
            to_value(cores.recover_player_authority_pending_command(store, &control.session_id)?)?
        }
        ControlRequest::CoreCommitPlayerAuthorityMacroAdvance(control) => {
            to_value(cores.commit_player_authority_macro_advance(
                store,
                &control.session_id,
                control.request,
            )?)?
        }
        ControlRequest::CoreFinishPlayerAuthorityMacroSession(control) => {
            to_value(cores.finish_player_authority_macro_session(
                store,
                &control.session_id,
                control.request,
            )?)?
        }
        ControlRequest::CoreRecoverPlayerAuthorityMacroAdvance(control) => to_value(
            cores.recover_player_authority_pending_macro_advance(store, &control.session_id)?,
        )?,
        ControlRequest::CoreCheckpoint {
            session_id,
            saved_at_ms,
        } => to_value(cores.checkpoint(store, &session_id, saved_at_ms)?)?,
        ControlRequest::CoreCheckpointAcknowledgeExactRealtime {
            session_id,
            request,
        } => to_value(cores.checkpoint_and_acknowledge_exact_realtime(
            store,
            &session_id,
            request,
        )?)?,
        ControlRequest::CoreCheckpointExactRealtimeFinalization {
            session_id,
            request,
        } => {
            to_value(cores.checkpoint_exact_realtime_finalization(store, &session_id, request)?)?
        }
        ControlRequest::CoreExportV47 {
            session_id,
            export_id,
            saved_at_ms,
        } => to_value(cores.export_v47(store, &session_id, &export_id, saved_at_ms)?)?,
        ControlRequest::CoreCompare {
            session_id,
            revision,
            canonical_sha256,
            domain_sha256,
        } => to_value(cores.compare(&session_id, revision, &canonical_sha256, &domain_sha256)?)?,
        ControlRequest::CoreClose { session_id } => {
            json!({ "closed": cores.close(&session_id)? })
        }
        ControlRequest::Shutdown => {
            cores.close_all();
            return Ok(HostAction::Shutdown(json!({ "accepted": true })));
        }
    };
    Ok(HostAction::Continue(value))
}

fn response_bytes(result: anyhow::Result<HostAction>) -> anyhow::Result<(Vec<u8>, bool)> {
    match result {
        Ok(HostAction::Continue(value)) => {
            Ok((serde_json::to_vec(&ControlResponse::success(value))?, false))
        }
        Ok(HostAction::Shutdown(value)) => {
            Ok((serde_json::to_vec(&ControlResponse::success(value))?, true))
        }
        Err(error) => {
            let code = if error
                .downcast_ref::<V47ImportJavascriptCompatibilityRequired>()
                .is_some()
            {
                V47_IMPORT_JS_COMPATIBILITY_REQUIRED_CODE
            } else if error
                .downcast_ref::<PlayerAuthoritySystemSpaceStationPreStageRejected>()
                .is_some()
            {
                PLAYER_AUTHORITY_SYSTEM_SPACE_STATION_PRE_STAGE_REJECTED_CODE
            } else if error
                .downcast_ref::<PlayerAuthorityOrbitalContractPreStageRejected>()
                .is_some()
            {
                PLAYER_AUTHORITY_ORBITAL_CONTRACT_PRE_STAGE_REJECTED_CODE
            } else if error
                .downcast_ref::<PlayerAuthorityOperationsSettingPreStageRejected>()
                .is_some()
            {
                PLAYER_AUTHORITY_OPERATIONS_SETTING_PRE_STAGE_REJECTED_CODE
            } else {
                "NATIVE_OPERATION_FAILED"
            };
            let response = ControlResponse::<Value>::failure(code, format!("{error:#}"));
            Ok((serde_json::to_vec(&response)?, false))
        }
    }
}

fn serve(root: PathBuf) -> anyhow::Result<()> {
    let mut store = SaveStore::open(root).context("open native save store")?;
    let mut cores = CoreRegistry::default();
    let mut player_authority_startup_recovery = cores
        .recover_player_authority_pending_command_on_startup(&mut store)
        .context("recover staged native player-authority command at host startup")?;
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut reader = BufReader::new(stdin.lock());
    let mut writer = BufWriter::new(stdout.lock());
    while let Some(frame) = read_frame(&mut reader).context("read native host frame")? {
        if frame.kind != FrameKind::ControlRequest {
            bail!("native host received an unexpected frame kind");
        }
        let request = serde_json::from_slice::<ControlRequest>(&frame.payload)
            .context("decode native host request");
        let (payload, shutdown) = match request {
            Ok(request) => response_bytes(handle_request(
                &mut store,
                &mut cores,
                &mut player_authority_startup_recovery,
                frame.request_id,
                request,
            ))?,
            Err(error) => response_bytes(Err(error))?,
        };
        write_frame(
            &mut writer,
            &Frame::control_response(frame.request_id, payload),
        )
        .context("write native host response")?;
        if shutdown {
            break;
        }
    }
    Ok(())
}

fn main() {
    // Readonly inspection starts from this executable's OS path. It opens no
    // SaveStore or simulation registry and accepts no caller installation root.
    let arguments: Vec<_> = env::args_os().skip(1).collect();
    if arguments.first().is_some_and(|a| a == "inspect-program") {
        let identity = if arguments.len() == 1 {
            dsp_native_host::installed_program::collect_installed_windows_program_identity()
        } else {
            Err(dsp_native_host::installed_program::InstalledProgramError)
        };
        match identity {
            Ok(program) => println!(
                "{}",
                json!({"schemaVersion": 1, "kind": "installed-program-identity-v1",
                "program": program, "authorityEligible": false})
            ),
            Err(_) => {
                eprintln!("dsp-native-host: installed-program-rejected");
                std::process::exit(1);
            }
        }
        return;
    }
    if let Err(error) = parse_serve_root().and_then(serve) {
        eprintln!("dsp-native-host: {error:#}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile_request(
        simulation_seconds: f64,
        wall_seconds: f64,
    ) -> dsp_native_core::CoreAdvanceRequest {
        dsp_native_core::CoreAdvanceRequest {
            base_revision: 7,
            simulation_seconds,
            wall_seconds,
            advance_mode: dsp_native_core::CoreAdvanceMode::Exact,
            include_diagnostics: false,
        }
    }

    #[test]
    fn quantum_profile_accepts_only_the_bounded_1_5_60_matrix() {
        for seconds in [1.0, 5.0, 60.0] {
            assert!(profile_operation_duration_is_valid(
                dsp_native_core::ProfileOperationPurpose::QuantumOactiveShapeV1,
                &profile_request(seconds, seconds),
            ));
        }
        for (simulation_seconds, wall_seconds) in [(0.0, 0.0), (2.0, 2.0), (61.0, 61.0), (5.0, 1.0)]
        {
            assert!(!profile_operation_duration_is_valid(
                dsp_native_core::ProfileOperationPurpose::QuantumOactiveShapeV1,
                &profile_request(simulation_seconds, wall_seconds),
            ));
        }
        assert!(!profile_operation_duration_is_valid(
            dsp_native_core::ProfileOperationPurpose::LocalDispatchShapeV1,
            &profile_request(5.0, 5.0),
        ));
        assert!(profile_operation_duration_is_valid(
            dsp_native_core::ProfileOperationPurpose::LocalDispatchTimingV1,
            &profile_request(1.0, 1.0),
        ));
    }

    #[test]
    fn hello_advertises_blueprint_capture_context_capability() {
        let root = tempfile::tempdir().unwrap();
        let mut store = SaveStore::open(root.path()).unwrap();
        let mut cores = CoreRegistry::default();
        let mut recovery = None;
        let action = handle_request(
            &mut store,
            &mut cores,
            &mut recovery,
            1,
            ControlRequest::Hello {
                client_version: "capture-capability-test".to_owned(),
            },
        )
        .unwrap();
        let HostAction::Continue(value) = action else {
            panic!("hello unexpectedly requested shutdown");
        };
        let capabilities = value["capabilities"].as_array().unwrap();
        assert!(capabilities.iter().any(|capability| {
            capability.as_str() == Some(NATIVE_CORE_BLUEPRINT_CAPTURE_CONTEXT_V1_CAPABILITY)
        }));
        assert!(capabilities.iter().any(|capability| {
            capability.as_str() == Some(NATIVE_CORE_BLUEPRINT_IMPORT_CONTEXT_V1_CAPABILITY)
        }));
        assert!(capabilities.iter().any(|capability| {
            capability.as_str() == Some(NATIVE_CORE_BLUEPRINT_EXPORT_CONTEXT_V1_CAPABILITY)
        }));
        assert!(capabilities.iter().any(|capability| {
            capability.as_str() == Some("native-core-campaign-workspace-projection-v1")
        }));
        assert!(capabilities.iter().any(|capability| {
            capability.as_str() == Some("native-core-galaxy-account-workspace-projection-v1")
        }));
    }

    #[test]
    fn response_exposes_only_the_typed_station_pre_stage_rejection_code() {
        let (typed_bytes, shutdown) = response_bytes(Err(anyhow::Error::new(
            PlayerAuthoritySystemSpaceStationPreStageRejected::new(
                "native system-space-station module inventory is insufficient",
            ),
        )))
        .unwrap();
        assert!(!shutdown);
        let typed: Value = serde_json::from_slice(&typed_bytes).unwrap();
        assert_eq!(typed["ok"], false);
        assert_eq!(
            typed["error"]["code"],
            PLAYER_AUTHORITY_SYSTEM_SPACE_STATION_PRE_STAGE_REJECTED_CODE
        );

        let (generic_bytes, shutdown) = response_bytes(Err(anyhow!(
            "native system-space-station lost response after durable stage"
        )))
        .unwrap();
        assert!(!shutdown);
        let generic: Value = serde_json::from_slice(&generic_bytes).unwrap();
        assert_eq!(generic["error"]["code"], "NATIVE_OPERATION_FAILED");
    }
}
