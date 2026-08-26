use std::env;
use std::io::{self, BufReader, BufWriter};
use std::path::PathBuf;

use anyhow::{Context, anyhow, bail};
use dsp_native_host::core_runtime::CoreRegistry;
use dsp_native_host::frame::{Frame, FrameKind, read_frame, write_frame};
use dsp_native_host::protocol::{ControlRequest, ControlResponse, HelloResponse};
use dsp_native_host::save_store::SaveStore;
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
                    "dual-superblock",
                    "content-addressed-chunks",
                    "contiguous-wal",
                    "compaction-v1",
                    "native-core-state-v1",
                    "native-core-shadow-v1",
                    "native-core-command-v1",
                ],
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
            revision,
            command_id,
            payload,
        } => to_value(store.append_wal(&slot, revision, &command_id, payload)?)?,
        ControlRequest::Compact {
            slot,
            retain_generations,
        } => {
            json!({ "removedGenerations": store.compact(&slot, retain_generations.unwrap_or(2))? })
        }
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
        ControlRequest::CoreStatus { session_id } => to_value(cores.status(&session_id)?)?,
        ControlRequest::CoreApplyCommand {
            session_id,
            command,
        } => to_value(cores.apply_command(&session_id, &command)?)?,
        ControlRequest::CoreAdvance {
            session_id,
            request,
        } => to_value(cores.advance(&session_id, &request)?)?,
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
            let response =
                ControlResponse::<Value>::failure("NATIVE_OPERATION_FAILED", error.to_string());
            Ok((serde_json::to_vec(&response)?, false))
        }
    }
}

fn serve(root: PathBuf) -> anyhow::Result<()> {
    let mut store = SaveStore::open(root).context("open native save store")?;
    let mut cores = CoreRegistry::default();
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
            Ok(request) => response_bytes(handle_request(&mut store, &mut cores, request))?,
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
