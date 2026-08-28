use std::env;
use std::io::{self, BufReader, BufWriter};
use std::path::PathBuf;

use anyhow::{Context, anyhow, bail};
use dsp_native_core::{
    V47_IMPORT_JS_COMPATIBILITY_REQUIRED_CODE, V47ImportJavascriptCompatibilityRequired,
};
use dsp_native_host::core_runtime::{
    CorePlayerAuthorityStartupRecoveryReceipt, CoreRegistry, PLAYER_AUTHORITY_COMMAND_CAPABILITY,
    PLAYER_AUTHORITY_GATE_CAPABILITY, PLAYER_AUTHORITY_STARTUP_RECOVERY_CAPABILITY,
    PLAYER_AUTHORITY_TICK_CAPABILITY,
};
use dsp_native_host::exact_realtime_lease::{
    EXACT_REALTIME_LEASE_CAPABILITY, EXACT_REALTIME_WRITER_FENCE_CAPABILITY,
};
use dsp_native_host::frame::{Frame, FrameKind, read_frame, write_frame};
use dsp_native_host::protocol::{ControlRequest, ControlResponse, HelloResponse};
use dsp_native_host::save_store::SaveStore;
use dsp_native_host::v47_import::open_v47_import_source;
use serde_json::{Value, json, to_value};

enum HostAction {
    Continue(Value),
    Shutdown(Value),
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
                    "native-core-factory-read-model-v1",
                    "native-core-statistics-projection-v1",
                    "native-core-technology-projection-v1",
                    "native-core-authority-wal-v1",
                    "native-core-checkpoint-v1",
                    "native-core-v47-stream-export-v1",
                    "native-core-v47-stream-import-v1",
                    EXACT_REALTIME_LEASE_CAPABILITY,
                    EXACT_REALTIME_WRITER_FENCE_CAPABILITY,
                    PLAYER_AUTHORITY_GATE_CAPABILITY,
                    PLAYER_AUTHORITY_TICK_CAPABILITY,
                    PLAYER_AUTHORITY_COMMAND_CAPABILITY,
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
        } => cores.viewport_projection_v2(
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
        ControlRequest::CoreApplyCommand {
            session_id,
            command,
        } => to_value(cores.apply_command(&session_id, &command)?)?,
        ControlRequest::CoreAdvance {
            session_id,
            request,
        } => to_value(cores.advance(&session_id, &request)?)?,
        ControlRequest::CoreCommitOperation {
            session_id,
            request,
        } => to_value(cores.commit_operation(store, &session_id, request)?)?,
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
        ControlRequest::CoreRecoverPlayerAuthorityCommand(control) => {
            to_value(cores.recover_player_authority_pending_command(store, &control.session_id)?)?
        }
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
    if let Err(error) = parse_serve_root().and_then(serve) {
        eprintln!("dsp-native-host: {error:#}");
        std::process::exit(1);
    }
}
