//! Independent complete validation candidate, with no caller-provided facts.
//! The foundation matrix is TEST_ONLY and grants neither authority nor release.
use crate::builtin_catalog::builtin_catalog_identity;
use crate::installed_program::collect_installed_windows_program_identity;
use crate::qualification_binding::QualificationCandidate;
use dsp_native_core::canonical::canonical_sha256;
use serde::Deserialize;
use serde_json::json;
use std::sync::OnceLock;

const CHECKS: [&str; 12] = [
    "single-owner",
    "first-tick",
    "command-material-conservation",
    "pause-resume",
    "persist-reopen",
    "exit-inflight",
    "lost-ack-retry",
    "host-restart",
    "threaded-determinism",
    "compatibility-roundtrip",
    "realtime-throughput",
    "process-tree-memory",
];

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ResultPolicy {
    minimum_passed: u32,
    maximum_failed: u32,
    maximum_skipped: u32,
    maximum_flaky: u32,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Matrix {
    schema_version: u32,
    kind: String,
    scope: String,
    evidence_class: String,
    report_kind: String,
    required_checks: Vec<String>,
    result_policy: ResultPolicy,
    authority_eligible: bool,
    release_allowed: bool,
}
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error("validation-candidate-rejected")]
pub struct ValidationCandidateError;

fn matrix_sha256(bytes: &[u8]) -> Result<String, ValidationCandidateError> {
    if bytes.is_empty() || bytes.len() > 16 * 1024 {
        return Err(ValidationCandidateError);
    }
    let matrix: Matrix = serde_json::from_slice(bytes).map_err(|_| ValidationCandidateError)?;
    if matrix.schema_version != 1
        || matrix.kind != "native-foundation-evidence-matrix-v1"
        || matrix.scope != "windows-normal-main-1x-builtin-v1"
        || matrix.evidence_class != "TEST_ONLY"
        || matrix.report_kind != "native-qualification-check-v1"
        || matrix.required_checks != CHECKS
        || matrix.result_policy.minimum_passed != 1
        || matrix.result_policy.maximum_failed != 0
        || matrix.result_policy.maximum_skipped != 0
        || matrix.result_policy.maximum_flaky != 0
        || matrix.authority_eligible
        || matrix.release_allowed
    {
        return Err(ValidationCandidateError);
    }
    let value = serde_json::from_slice(bytes).map_err(|_| ValidationCandidateError)?;
    Ok(canonical_sha256(&value))
}

fn compiled_matrix_sha256() -> Result<&'static str, ValidationCandidateError> {
    static MATRIX: OnceLock<Result<String, ValidationCandidateError>> = OnceLock::new();
    MATRIX
        .get_or_init(|| {
            matrix_sha256(include_bytes!(
                "../../../desktop/native-validation-matrix-v1.json"
            ))
        })
        .as_ref()
        .map(String::as_str)
        .map_err(Clone::clone)
}

fn rules_sha256(host_sha256: &str, asar_sha256: &str, catalog_sha256: &str) -> String {
    canonical_sha256(
        &json!({ "schemaVersion": 1, "kind": "native-executable-rules-v1",
        "hostSha256": host_sha256, "asarSha256": asar_sha256, "catalogSha256": catalog_sha256 }),
    )
}

pub fn collect_installed_windows_validation_candidate()
-> Result<QualificationCandidate, ValidationCandidateError> {
    let content = builtin_catalog_identity().map_err(|_| ValidationCandidateError)?;
    let matrix = compiled_matrix_sha256()?;
    let program =
        collect_installed_windows_program_identity().map_err(|_| ValidationCandidateError)?;
    let rules = rules_sha256(
        &program.host_sha256,
        &program.asar_sha256,
        &content.catalog_sha256,
    );
    Ok(QualificationCandidate {
        version: program.version,
        source_sha: program.source_sha,
        build_id: program.build_id,
        edition_id: program.edition_id,
        channel: program.channel,
        platform: program.platform,
        arch: program.arch,
        host_sha256: program.host_sha256,
        asar_sha256: program.asar_sha256,
        catalog_sha256: content.catalog_sha256.clone(),
        rules_sha256: rules,
        matrix_sha256: matrix.to_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn compiled_matrix_is_the_complete_non_authorizing_foundation_roster() {
        assert_eq!(compiled_matrix_sha256().unwrap().len(), 64);
        let bytes = include_bytes!("../../../desktop/native-validation-matrix-v1.json");
        assert_eq!(
            matrix_sha256(bytes).unwrap(),
            compiled_matrix_sha256().unwrap()
        );
    }
    #[test]
    fn matrix_cannot_drop_checks_or_accept_skipped_results_or_grant_authority() {
        for case in 0..8 {
            let mut value: serde_json::Value = serde_json::from_slice(include_bytes!(
                "../../../desktop/native-validation-matrix-v1.json"
            ))
            .unwrap();
            match case {
                0 => {
                    value["requiredChecks"].as_array_mut().unwrap().pop();
                }
                1 => value["resultPolicy"]["maximumSkipped"] = 1.into(),
                2 => value["resultPolicy"]["minimumPassed"] = 0.into(),
                3 => value["authorityEligible"] = true.into(),
                4 => value["releaseAllowed"] = true.into(),
                5 => value["evidenceClass"] = "RELEASE".into(),
                6 => value["requiredChecks"][0] = "first-tick".into(),
                _ => value["unknownField"] = true.into(),
            }
            assert_eq!(
                matrix_sha256(&serde_json::to_vec(&value).unwrap()),
                Err(ValidationCandidateError)
            );
        }
    }
    #[test]
    fn executable_rules_digest_invalidates_any_changed_program_or_catalog() {
        let a = "a".repeat(64);
        let b = "b".repeat(64);
        let c = "c".repeat(64);
        let base = rules_sha256(&a, &b, &c);
        assert_ne!(base, rules_sha256(&b, &b, &c));
        assert_ne!(base, rules_sha256(&a, &c, &c));
        assert_ne!(base, rules_sha256(&a, &b, &a));
    }
}
