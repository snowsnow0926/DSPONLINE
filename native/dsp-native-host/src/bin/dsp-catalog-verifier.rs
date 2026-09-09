//! Readonly, single-request Windows trust helper for the Electron main process.
//! This is separate from the simulation Host and has no gameplay/save RPC.
use dsp_native_host::qualification_catalog::{
    CatalogVerificationError, verify_windows_catalog_member,
};
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::path::Path;
use std::process::ExitCode;

const MAX_REQUEST_BYTES: usize = 16 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    schema_version: u8,
    request_id: String,
    installation_root: String,
    publisher_certificate_sha256: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Response<'a> {
    schema_version: u8,
    request_id: &'a str,
    #[serde(flatten)]
    outcome: Outcome,
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
enum Outcome {
    Authenticated {
        #[serde(rename = "memberHex")]
        member_hex: String,
        #[serde(rename = "memberSha256")]
        member_sha256: String,
        #[serde(rename = "catalogSha256")]
        catalog_sha256: String,
        #[serde(rename = "publisherCertificateSha256")]
        publisher_certificate_sha256: String,
    },
    Rejected {
        #[serde(rename = "errorCode")]
        error_code: &'static str,
    },
}

fn is_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn read_request(reader: impl Read) -> Result<(Request, Vec<[u8; 32]>), ()> {
    let mut bytes = Vec::new();
    reader
        .take((MAX_REQUEST_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| ())?;
    if bytes.len() > MAX_REQUEST_BYTES {
        return Err(());
    }
    let request: Request = serde_json::from_slice(&bytes).map_err(|_| ())?;
    if request.schema_version != 1
        || !is_digest(&request.request_id)
        || request.installation_root.len() > 4096
        || request.installation_root.contains('\0')
        || !Path::new(&request.installation_root).is_absolute()
        || request.publisher_certificate_sha256.is_empty()
        || request.publisher_certificate_sha256.len() > 8
    {
        return Err(());
    }
    let mut publishers = Vec::new();
    for pin in &request.publisher_certificate_sha256 {
        if !is_digest(pin) {
            return Err(());
        }
        let mut decoded = [0; 32];
        hex::decode_to_slice(pin, &mut decoded).map_err(|_| ())?;
        if publishers.contains(&decoded) {
            return Err(());
        }
        publishers.push(decoded);
    }
    Ok((request, publishers))
}

fn error_code(error: CatalogVerificationError) -> &'static str {
    match error {
        CatalogVerificationError::UnsupportedPlatform => "unsupported-platform",
        CatalogVerificationError::InvalidPublisherPolicy => "invalid-publisher-policy",
        CatalogVerificationError::UnsafePath => "unsafe-path",
        CatalogVerificationError::InvalidFileSize => "invalid-file-size",
        CatalogVerificationError::Io(_) => "carrier-io",
        CatalogVerificationError::TrustApiUnavailable => "trust-api-unavailable",
        CatalogVerificationError::CatalogOperation(_) => "catalog-operation-failed",
        CatalogVerificationError::TrustRejected(_) => "trust-rejected",
        CatalogVerificationError::MissingPublisher => "missing-publisher",
        CatalogVerificationError::WeakSignatureDigest => "weak-signature-digest",
        CatalogVerificationError::PublisherMismatch => "publisher-mismatch",
    }
}

fn run(reader: impl Read, mut writer: impl Write) -> Result<(), ()> {
    let (request, publishers) = read_request(reader)?;
    let outcome =
        match verify_windows_catalog_member(Path::new(&request.installation_root), &publishers) {
            Ok(member) => Outcome::Authenticated {
                member_hex: hex::encode(member.member_bytes()),
                member_sha256: hex::encode(member.member_sha256()),
                catalog_sha256: hex::encode(member.catalog_sha256()),
                publisher_certificate_sha256: hex::encode(member.publisher_certificate_sha256()),
            },
            Err(error) => Outcome::Rejected {
                error_code: error_code(error),
            },
        };
    serde_json::to_writer(
        &mut writer,
        &Response {
            schema_version: 1,
            request_id: &request.request_id,
            outcome,
        },
    )
    .map_err(|_| ())?;
    writer.write_all(b"\n").map_err(|_| ())
}

fn main() -> ExitCode {
    if std::env::args_os().len() != 1
        || run(std::io::stdin().lock(), std::io::stdout().lock()).is_err()
    {
        // Do not echo paths, malformed input, certificate data or OS diagnostics.
        eprintln!("CATALOG_VERIFIER_REQUEST_REJECTED");
        return ExitCode::from(2);
    }
    ExitCode::SUCCESS
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn request() -> serde_json::Value {
        json!({"schemaVersion":1,"requestId":"ab".repeat(32),
            "installationRoot":std::env::temp_dir(),
            "publisherCertificateSha256":["cd".repeat(32)]})
    }

    #[test]
    fn bounded_request_preserves_independent_pins_and_nonce() {
        let input = serde_json::to_vec(&request()).unwrap();
        let (parsed, pins) = read_request(input.as_slice()).unwrap();
        assert_eq!(parsed.request_id, "ab".repeat(32));
        assert_eq!(pins, vec![[0xcd; 32]]);
    }

    #[test]
    fn malformed_duplicate_unknown_and_unbounded_requests_are_rejected() {
        for (key, value) in [
            ("schemaVersion", json!(2)),
            ("requestId", json!("AB".repeat(32))),
            ("installationRoot", json!("relative/path")),
            ("installationRoot", json!("x".repeat(4097))),
            ("publisherCertificateSha256", json!([])),
            (
                "publisherCertificateSha256",
                json!(["cd".repeat(32), "cd".repeat(32)]),
            ),
            ("publisherCertificateSha256", json!(["CD".repeat(32)])),
            ("authorityEligible", json!(true)),
        ] {
            let mut input = request();
            input[key] = value;
            assert!(read_request(serde_json::to_vec(&input).unwrap().as_slice()).is_err());
        }
        let mut input = serde_json::to_string(&request()).unwrap();
        input.insert_str(1, "\"schemaVersion\":1,");
        assert!(read_request(input.as_bytes()).is_err());
        assert!(read_request(b"{} trailing".as_slice()).is_err());
        assert!(read_request(std::io::repeat(b' ')).is_err());
    }

    #[test]
    fn failure_returns_nonce_and_controlled_code_without_paths_or_authority() {
        let root = tempfile::tempdir().unwrap();
        let mut input = request();
        input["installationRoot"] = json!(root.path());
        let mut output = Vec::new();
        run(serde_json::to_vec(&input).unwrap().as_slice(), &mut output).unwrap();
        let response: serde_json::Value = serde_json::from_slice(&output).unwrap();
        assert_eq!(response["status"], "rejected");
        assert_eq!(response["requestId"], input["requestId"]);
        assert_eq!(response.as_object().unwrap().len(), 4);
        assert!(
            !String::from_utf8(output)
                .unwrap()
                .contains(root.path().to_str().unwrap())
        );
    }
}
