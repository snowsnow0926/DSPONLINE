use std::env;
use std::path::PathBuf;

use anyhow::{anyhow, bail};
use dsp_native_host::rpc::serve;
use serde_json::json;

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

fn main() {
    // Readonly inspection starts from this executable's OS path. It opens no
    // SaveStore or simulation registry and accepts no caller installation root.
    let arguments: Vec<_> = env::args_os().skip(1).collect();
    if arguments
        .first()
        .is_some_and(|a| a == "hold-validation-session")
    {
        let result = if arguments.len() == 3 {
            arguments[1]
                .to_str()
                .zip(arguments[2].to_str())
                .ok_or(dsp_native_host::validation_session::ValidationSessionError)
                .and_then(|(id, challenge)| {
                    dsp_native_host::validation_session_process::run_validation_session_process(
                        id, challenge,
                    )
                })
        } else {
            Err(dsp_native_host::validation_session::ValidationSessionError)
        };
        if result.is_err() {
            eprintln!("dsp-native-host: validation-session-lease-rejected");
            std::process::exit(1);
        }
        return;
    }
    if arguments
        .first()
        .is_some_and(|a| a == "inspect-validation-session")
    {
        let snapshot = arguments
            .get(1)
            .and_then(|id| id.to_str())
            .filter(|_| arguments.len() == 2)
            .ok_or(dsp_native_host::validation_session::ValidationSessionError)
            .and_then(dsp_native_host::validation_session::inspect_validation_session);
        match snapshot {
            Ok(snapshot) => println!("{}", serde_json::to_string(&snapshot).unwrap()),
            Err(_) => {
                eprintln!("dsp-native-host: validation-session-rejected");
                std::process::exit(1);
            }
        }
        return;
    }
    if arguments
        .first()
        .is_some_and(|a| a == "inspect-validation-candidate")
    {
        let candidate = if arguments.len() == 1 {
            dsp_native_host::validation_candidate::collect_installed_windows_validation_candidate()
        } else {
            Err(dsp_native_host::validation_candidate::ValidationCandidateError)
        };
        match candidate {
            Ok(candidate) => println!(
                "{}",
                json!({"schemaVersion": 1,
                "kind": "installed-validation-candidate-v1", "candidate": candidate,
                "authorityEligible": false, "releaseAllowed": false})
            ),
            Err(_) => {
                eprintln!("dsp-native-host: validation-candidate-rejected");
                std::process::exit(1);
            }
        }
        return;
    }
    if arguments
        .first()
        .is_some_and(|a| a == "inspect-builtin-catalog")
    {
        match arguments.len() == 1 {
            true => match dsp_native_host::builtin_catalog::builtin_catalog_identity() {
                Ok(content) => println!(
                    "{}",
                    json!({"schemaVersion": 1,
                    "kind": "builtin-catalog-identity-v1", "content": content, "authorityEligible": false})
                ),
                Err(_) => {
                    eprintln!("dsp-native-host: builtin-catalog-invalid");
                    std::process::exit(1);
                }
            },
            false => {
                eprintln!("dsp-native-host: builtin-catalog-arguments");
                std::process::exit(1);
            }
        }
        return;
    }
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
