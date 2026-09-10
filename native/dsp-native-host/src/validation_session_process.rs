//! Process-entry transport for a continuously pinned synthetic session.
//! Not a gameplay lease, signing credential, writer fence or Host serve RPC.
use crate::validation_session::{
    ValidationSessionError, ValidationSessionLease, ValidationSessionSnapshot,
};
use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Read, Write};
use std::sync::mpsc::{self, SyncSender};
use std::time::Duration;

const MAX_REQUEST_BYTES: usize = 256;
const MAX_SEQUENCE: u64 = 9_007_199_254_740_991;
const IDLE_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum Command {
    Probe,
    Release,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    schema_version: u8,
    sequence: u64,
    challenge: String,
    command: Command,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Response<'a> {
    schema_version: u8,
    kind: &'static str,
    event: &'static str,
    sequence: u64,
    challenge: &'a str,
    snapshot: &'a ValidationSessionSnapshot,
}

fn valid_challenge(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn read_request(reader: &mut impl BufRead) -> Result<Option<Request>, ValidationSessionError> {
    let mut bytes = Vec::new();
    reader
        .take(MAX_REQUEST_BYTES as u64 + 1)
        .read_until(b'\n', &mut bytes)
        .map_err(|_| ValidationSessionError)?;
    if bytes.is_empty() {
        return Ok(None);
    }
    if bytes.len() > MAX_REQUEST_BYTES || bytes.last() != Some(&b'\n') {
        return Err(ValidationSessionError);
    }
    let request: Request = serde_json::from_slice(&bytes).map_err(|_| ValidationSessionError)?;
    if request.schema_version != 1
        || request.sequence == 0
        || request.sequence > MAX_SEQUENCE
        || !valid_challenge(&request.challenge)
    {
        return Err(ValidationSessionError);
    }
    let mut canonical = serde_json::to_vec(&request).map_err(|_| ValidationSessionError)?;
    canonical.push(b'\n');
    if canonical != bytes {
        return Err(ValidationSessionError);
    }
    Ok(Some(request))
}

fn write_response(
    writer: &mut impl Write,
    snapshot: &ValidationSessionSnapshot,
    event: &'static str,
    sequence: u64,
    challenge: &str,
) -> Result<(), ValidationSessionError> {
    serde_json::to_writer(
        &mut *writer,
        &Response {
            schema_version: 1,
            kind: "windows-validation-session-lease-v1",
            event,
            sequence,
            challenge,
            snapshot,
        },
    )
    .map_err(|_| ValidationSessionError)?;
    writer
        .write_all(b"\n")
        .and_then(|()| writer.flush())
        .map_err(|_| ValidationSessionError)
}

fn read_pipe(sender: SyncSender<Result<Option<Request>, ValidationSessionError>>) {
    let mut reader = BufReader::new(std::io::stdin().lock());
    loop {
        let request = read_request(&mut reader);
        let terminal = !matches!(request, Ok(Some(_)));
        if sender.send(request).is_err() || terminal {
            break;
        }
    }
}

/// Must be the final action of a dedicated binary entry. The bounded input
/// reader owns no lease/locks and may remain blocked until process exit after
/// timeout. The owning thread drops all filesystem handles before returning.
/// No caller can configure the deadline, root, fixture or authority policy.
pub fn run_validation_session_process(
    id: &str,
    challenge: &str,
) -> Result<(), ValidationSessionError> {
    if !valid_challenge(challenge) {
        return Err(ValidationSessionError);
    }
    let lease = ValidationSessionLease::open(id)?;
    let (sender, receiver) = mpsc::sync_channel(1);
    std::thread::Builder::new()
        .name("validation-session-input".into())
        .spawn(move || read_pipe(sender))
        .map_err(|_| ValidationSessionError)?;
    let mut writer = std::io::stdout().lock();
    write_response(&mut writer, lease.snapshot(), "ready", 0, challenge)?;
    let mut expected_sequence = 1;
    loop {
        // Partial/malformed input never refreshes the idle deadline. A dead
        // parent, EOF, output failure or stale sequence drops the pinned lease.
        let request = receiver
            .recv_timeout(IDLE_TIMEOUT)
            .map_err(|_| ValidationSessionError)??
            .ok_or(ValidationSessionError)?;
        if request.sequence != expected_sequence {
            return Err(ValidationSessionError);
        }
        if request.command == Command::Release {
            write_response(
                &mut writer,
                lease.snapshot(),
                "released",
                request.sequence,
                &request.challenge,
            )?;
            return Ok(());
        }
        write_response(
            &mut writer,
            lease.snapshot(),
            "live",
            request.sequence,
            &request.challenge,
        )?;
        expected_sequence = expected_sequence
            .checked_add(1)
            .filter(|n| *n <= MAX_SEQUENCE)
            .ok_or(ValidationSessionError)?;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request(command: Command) -> Vec<u8> {
        let mut bytes = serde_json::to_vec(&Request {
            schema_version: 1,
            sequence: 1,
            challenge: "ab".repeat(32),
            command,
        })
        .unwrap();
        bytes.push(b'\n');
        bytes
    }
    #[test]
    fn bounded_pipe_reads_exactly_one_canonical_request() {
        let mut bytes = request(Command::Probe);
        bytes.extend(request(Command::Release));
        let mut input = bytes.as_slice();
        assert_eq!(
            read_request(&mut input).unwrap().unwrap().command,
            Command::Probe
        );
        assert_eq!(
            read_request(&mut input).unwrap().unwrap().command,
            Command::Release
        );
        assert!(read_request(&mut input).unwrap().is_none());
    }
    #[test]
    fn malformed_duplicate_oversized_and_noncanonical_inputs_are_rejected() {
        let text = String::from_utf8(request(Command::Probe)).unwrap();
        for bad in [
            text.replace("{", "{\"schemaVersion\":1,"),
            text.replace("\"sequence\":1", "\"sequence\":1.0"),
            text.replace("\"sequence\":1", "\"sequence\":0"),
            text.replace("\"sequence\":1", "\"sequence\":9007199254740992"),
            text.replace("probe", "activate"),
            text.replace("{", "{\"authorityEligible\":true,"),
            text.replace("\n", "\r\n"),
            text.trim_end().to_owned(),
            text.replace("ab", "AB"),
        ] {
            assert!(read_request(&mut bad.as_bytes()).is_err());
        }
        assert!(read_request(&mut &[0xff, b'\n'][..]).is_err());
        assert!(
            read_request(&mut std::io::Cursor::new(vec![b' '; MAX_REQUEST_BYTES + 1])).is_err()
        );
        assert_eq!(IDLE_TIMEOUT, Duration::from_secs(15));
    }
}
