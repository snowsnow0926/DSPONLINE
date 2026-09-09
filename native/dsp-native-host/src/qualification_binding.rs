//! Bind authenticated catalog bytes to independently supplied program/session
//! identity. This does not authenticate producers or grant gameplay authority.
use crate::qualification_catalog::VerifiedCatalogMember;
use serde::{Deserialize, Serialize};

const SCOPE: &str = "windows-normal-main-1x-builtin-v1";
const SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const DAY_MS: u64 = 86_400_000;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QualificationCandidate {
    pub version: String,
    pub source_sha: String,
    pub build_id: String,
    pub edition_id: String,
    pub channel: String,
    pub platform: String,
    pub arch: String,
    pub host_sha256: String,
    pub asar_sha256: String,
    /// Game content catalog; not the external Authenticode carrier catalog.
    pub catalog_sha256: String,
    pub rules_sha256: String,
    pub matrix_sha256: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QualificationSession {
    pub profile_id: String,
    pub fixture_sha256: String,
    pub cloud_writes: bool,
}

/// Future callers must acquire these facts independently of the member,
/// renderer, save or report. Clock/revocation acquisition is not implemented here.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ValidationBindingContext {
    pub candidate: QualificationCandidate,
    pub session: QualificationSession,
    pub scope: String,
    pub publisher_certificate_sha256: String,
    pub publisher_key_version: u32,
    pub now_ms: u64,
    pub revocation_generation: u64,
    pub revoked_qualification_ids: Vec<String>,
    pub revoked_proof_set_sha256: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ValidationBody {
    schema_version: u32,
    kind: String,
    qualification_id: String,
    publisher_key_version: u32,
    candidate: QualificationCandidate,
    scope: String,
    session: QualificationSession,
    producer_set_sha256: String,
    proof_set_sha256: String,
    issued_at_ms: u64,
    expires_at_ms: u64,
    revocation_generation: u64,
}

/// Private construction and no deserializer: a decoded receipt is not a token.
#[derive(Debug)]
pub struct BoundValidationQualification {
    body: ValidationBody,
    member_sha256: [u8; 32],
    carrier_catalog_sha256: [u8; 32],
    publisher_certificate_sha256: [u8; 32],
    checked_at_ms: u64,
}

impl BoundValidationQualification {
    pub fn qualification_id(&self) -> &str {
        &self.body.qualification_id
    }
    pub fn candidate(&self) -> &QualificationCandidate {
        &self.body.candidate
    }
    pub fn session(&self) -> &QualificationSession {
        &self.body.session
    }
    pub fn producer_set_sha256(&self) -> &str {
        &self.body.producer_set_sha256
    }
    pub fn proof_set_sha256(&self) -> &str {
        &self.body.proof_set_sha256
    }
    pub fn member_sha256(&self) -> [u8; 32] {
        self.member_sha256
    }
    pub fn carrier_catalog_sha256(&self) -> [u8; 32] {
        self.carrier_catalog_sha256
    }
    pub fn publisher_certificate_sha256(&self) -> [u8; 32] {
        self.publisher_certificate_sha256
    }
    pub fn checked_at_ms(&self) -> u64 {
        self.checked_at_ms
    }
    pub fn expires_at_ms(&self) -> u64 {
        self.body.expires_at_ms
    }
    pub fn revocation_generation(&self) -> u64 {
        self.body.revocation_generation
    }
    pub fn authority_eligible(&self) -> bool {
        false
    }
}

#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub enum QualificationBindingError {
    #[error("qualification-context")]
    Context,
    #[error("qualification-format")]
    Format,
    #[error("qualification-contract")]
    Contract,
    #[error("qualification-identity")]
    Identity,
    #[error("qualification-publisher")]
    Publisher,
    #[error("qualification-candidate")]
    Candidate,
    #[error("qualification-session")]
    Session,
    #[error("qualification-time")]
    Time,
    #[error("qualification-revoked")]
    Revoked,
}

fn hex_string(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|v| v.is_ascii_digit() || (b'a'..=b'f').contains(&v))
}
fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value.as_bytes()[0].is_ascii_alphanumeric()
        && value
            .bytes()
            .all(|v| v.is_ascii_digit() || v.is_ascii_lowercase() || v == b'-')
}
fn safe_positive(value: u64) -> bool {
    value > 0 && value <= SAFE_INTEGER
}
fn valid_candidate(c: &QualificationCandidate) -> bool {
    let parts: Vec<_> = c.version.split('.').collect();
    parts.len() == 3
        && parts
            .iter()
            .all(|p| !p.is_empty() && p.len() <= 5 && p.bytes().all(|v| v.is_ascii_digit()))
        && hex_string(&c.source_sha, 40)
        && c.build_id == format!("{}+{}", c.version, &c.source_sha[..12])
        && c.edition_id == "windows-performance-development-v1"
        && c.channel == "beta"
        && c.platform == "win32"
        && c.arch == "x64"
        && [
            &c.host_sha256,
            &c.asar_sha256,
            &c.catalog_sha256,
            &c.rules_sha256,
            &c.matrix_sha256,
        ]
        .iter()
        .all(|v| hex_string(v, 64))
}
fn valid_session(s: &QualificationSession) -> bool {
    hex_string(&s.profile_id, 32) && hex_string(&s.fixture_sha256, 64) && !s.cloud_writes
}
fn valid_list(values: &[String], validate: impl Fn(&str) -> bool) -> bool {
    values.len() <= 128
        && values
            .iter()
            .enumerate()
            .all(|(index, value)| validate(value) && !values[..index].contains(value))
}

pub fn bind_authenticated_validation_qualification(
    member: &VerifiedCatalogMember,
    context: &ValidationBindingContext,
) -> Result<BoundValidationQualification, QualificationBindingError> {
    use QualificationBindingError as E;
    if !valid_candidate(&context.candidate)
        || !valid_session(&context.session)
        || context.scope != SCOPE
        || !hex_string(&context.publisher_certificate_sha256, 64)
        || context.publisher_key_version == 0
        || !safe_positive(context.now_ms)
        || !safe_positive(context.revocation_generation)
        || !valid_list(&context.revoked_qualification_ids, valid_id)
        || !valid_list(&context.revoked_proof_set_sha256, |v| hex_string(v, 64))
    {
        return Err(E::Context);
    }
    let bytes = member.member_bytes();
    if bytes.is_empty() || bytes.len() > 16 * 1024 {
        return Err(E::Format);
    }
    let body: ValidationBody = serde_json::from_slice(bytes).map_err(|_| E::Format)?;
    let mut canonical = serde_json::to_vec(&body).map_err(|_| E::Format)?;
    canonical.push(b'\n');
    if canonical != bytes {
        return Err(E::Format);
    }
    if body.schema_version != 1
        || body.kind != "dsp-windows-validation-qualification-v1"
        || body.scope != SCOPE
    {
        return Err(E::Contract);
    }
    if !valid_id(&body.qualification_id)
        || !hex_string(&body.producer_set_sha256, 64)
        || !hex_string(&body.proof_set_sha256, 64)
    {
        return Err(E::Identity);
    }
    if hex::encode(member.publisher_certificate_sha256()) != context.publisher_certificate_sha256
        || body.publisher_key_version != context.publisher_key_version
    {
        return Err(E::Publisher);
    }
    if !valid_candidate(&body.candidate) || body.candidate != context.candidate {
        return Err(E::Candidate);
    }
    if !valid_session(&body.session) || body.session != context.session {
        return Err(E::Session);
    }
    if !safe_positive(body.issued_at_ms)
        || !safe_positive(body.expires_at_ms)
        || body.issued_at_ms > context.now_ms
        || body.expires_at_ms <= context.now_ms
        || body.expires_at_ms <= body.issued_at_ms
        || body.expires_at_ms - body.issued_at_ms > DAY_MS
    {
        return Err(E::Time);
    }
    if !safe_positive(body.revocation_generation)
        || body.revocation_generation != context.revocation_generation
        || context
            .revoked_qualification_ids
            .contains(&body.qualification_id)
        || context
            .revoked_proof_set_sha256
            .contains(&body.proof_set_sha256)
    {
        return Err(E::Revoked);
    }
    Ok(BoundValidationQualification {
        body,
        member_sha256: member.member_sha256(),
        carrier_catalog_sha256: member.catalog_sha256(),
        publisher_certificate_sha256: member.publisher_certificate_sha256(),
        checked_at_ms: context.now_ms,
    })
}

#[cfg(test)]
mod tests;
