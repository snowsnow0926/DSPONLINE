use std::collections::HashSet;
use std::fmt;
use std::io::{BufReader, Error as IoError, ErrorKind, Read};

use anyhow::{Context, bail};
use serde::de::{DeserializeSeed, Error as DeError, MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::value::RawValue;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use crate::catalog::RuntimeCatalog;
use crate::state::{CoreCheckpointIdentity, CoreState};

pub const MAX_V47_IMPORT_BYTES: u64 = 256 * 1024 * 1024;
pub const V47_IMPORT_JS_COMPATIBILITY_REQUIRED_CODE: &str =
    "NATIVE_V47_IMPORT_JS_COMPATIBILITY_REQUIRED";
const MAX_BASE_FIELD_BYTES: usize = 64 * 1024 * 1024;
const SOURCE_READ_BUFFER_BYTES: usize = 64 * 1024;
const MAX_RECORD_BYTES: usize = 8 * 1024 * 1024 - 2;
const MAX_STATE_FIELDS: usize = 512;
const MAX_ENTITY_COUNT: usize = 2_000_000;
const MAX_BELT_COUNT: usize = 4_000_000;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Debug, thiserror::Error)]
#[error(
    "native-unrepresentable: v47 JSON contains a legal lone UTF-16 surrogate; use the JavaScript compatibility importer"
)]
pub struct V47ImportJavascriptCompatibilityRequired;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct V47ImportProof {
    pub format_version: u16,
    pub state_version: u16,
    pub kind: String,
    pub envelope_slot: String,
    pub mode: String,
    pub saved_at_ms: u64,
    pub state_checksum: String,
    pub source_sha256: String,
    pub source_byte_length: u64,
    pub entity_count: usize,
    pub belt_count: usize,
}

#[derive(Debug)]
pub struct ParsedV47Envelope {
    proof: V47ImportProof,
    base: Map<String, Value>,
    entities: Vec<String>,
    belts: Vec<String>,
}

impl ParsedV47Envelope {
    pub fn proof(&self) -> &V47ImportProof {
        &self.proof
    }

    pub fn into_core_state(
        self,
        revision: u64,
        registry_fingerprint: &str,
        catalog: RuntimeCatalog,
    ) -> anyhow::Result<(CoreState, V47ImportProof)> {
        if revision > MAX_SAFE_INTEGER {
            bail!("native v47 import revision is invalid");
        }
        let slot = match self.proof.mode.as_str() {
            "normal" => "normal-main",
            "speedrun" => "speedrun-main",
            _ => bail!("native v47 import mode is invalid"),
        };
        let identity = CoreCheckpointIdentity {
            slot: slot.to_owned(),
            generation: 1,
            root_hash: self.proof.source_sha256.clone(),
            revision,
            state_version: 47,
            mode: self.proof.mode.clone(),
            registry_fingerprint: registry_fingerprint.to_owned(),
            base_primary_checksum: self.proof.state_checksum.clone(),
        };
        let state = CoreState::from_public_v47_parts(
            identity,
            self.base,
            self.entities,
            self.belts,
            catalog,
        )?;
        Ok((state, self.proof))
    }
}

struct BoundedHashReader<R> {
    inner: R,
    digest: Sha256,
    bytes_read: u64,
    utf16_compatibility: JavascriptUtf16CompatibilityScanner,
}

impl<R> BoundedHashReader<R> {
    fn new(inner: R) -> Self {
        Self {
            inner,
            digest: Sha256::new(),
            bytes_read: 0,
            utf16_compatibility: JavascriptUtf16CompatibilityScanner::default(),
        }
    }

    fn requires_javascript_compatibility(&self) -> bool {
        self.utf16_compatibility.requires_javascript_compatibility
    }

    fn finish(self) -> (u64, String) {
        (self.bytes_read, hex::encode(self.digest.finalize()))
    }
}

impl<R: Read> Read for BoundedHashReader<R> {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        if self.bytes_read >= MAX_V47_IMPORT_BYTES {
            let mut probe = [0_u8; 1];
            if self.inner.read(&mut probe)? != 0 {
                return Err(IoError::new(
                    ErrorKind::InvalidData,
                    "native v47 import exceeds the bounded file limit",
                ));
            }
            return Ok(0);
        }
        let remaining = (MAX_V47_IMPORT_BYTES - self.bytes_read) as usize;
        let capacity = buffer.len().min(remaining);
        let bytes = self.inner.read(&mut buffer[..capacity])?;
        if bytes > 0 {
            self.digest.update(&buffer[..bytes]);
            self.bytes_read += bytes as u64;
            self.utf16_compatibility.update(&buffer[..bytes]);
        }
        Ok(bytes)
    }
}

#[derive(Default)]
struct JavascriptUtf16CompatibilityScanner {
    in_string: bool,
    escaped: bool,
    unicode_digits_remaining: u8,
    unicode_value: u16,
    pending_high_surrogate: bool,
    requires_javascript_compatibility: bool,
}

impl JavascriptUtf16CompatibilityScanner {
    fn update(&mut self, bytes: &[u8]) {
        for &byte in bytes {
            self.update_byte(byte);
        }
    }

    fn update_byte(&mut self, byte: u8) {
        if self.unicode_digits_remaining > 0 {
            let Some(digit) = hex_digit(byte) else {
                // The JSON parser owns malformed escape reporting. In
                // particular, do not turn an invalid document into a JS
                // compatibility fallback merely because a prior high
                // surrogate was followed by malformed JSON.
                self.unicode_digits_remaining = 0;
                self.unicode_value = 0;
                return;
            };
            self.unicode_value = (self.unicode_value << 4) | u16::from(digit);
            self.unicode_digits_remaining -= 1;
            if self.unicode_digits_remaining == 0 {
                let value = self.unicode_value;
                self.unicode_value = 0;
                self.accept_utf16_code_unit(value);
            }
            return;
        }

        if !self.in_string {
            if byte == b'"' {
                self.in_string = true;
            }
            return;
        }

        if self.escaped {
            self.escaped = false;
            if byte == b'u' {
                self.unicode_digits_remaining = 4;
            } else if matches!(byte, b'"' | b'\\' | b'/' | b'b' | b'f' | b'n' | b'r' | b't') {
                self.accept_non_surrogate_unit();
            }
            return;
        }

        match byte {
            b'\\' => self.escaped = true,
            b'"' => {
                if self.pending_high_surrogate {
                    self.requires_javascript_compatibility = true;
                    self.pending_high_surrogate = false;
                }
                self.in_string = false;
            }
            0x20..=0xff => self.accept_non_surrogate_unit(),
            _ => {
                // Raw control bytes make the JSON invalid. Leave their
                // diagnosis to serde_json instead of claiming JS support.
            }
        }
    }

    fn accept_non_surrogate_unit(&mut self) {
        if self.pending_high_surrogate {
            self.requires_javascript_compatibility = true;
            self.pending_high_surrogate = false;
        }
    }

    fn accept_utf16_code_unit(&mut self, value: u16) {
        match value {
            0xd800..=0xdbff => {
                if self.pending_high_surrogate {
                    self.requires_javascript_compatibility = true;
                }
                self.pending_high_surrogate = true;
            }
            0xdc00..=0xdfff => {
                if self.pending_high_surrogate {
                    self.pending_high_surrogate = false;
                } else {
                    self.requires_javascript_compatibility = true;
                }
            }
            _ => self.accept_non_surrogate_unit(),
        }
    }
}

fn hex_digit(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

#[derive(Default)]
struct JavascriptFnv1a {
    value: u32,
    initialized: bool,
}

impl JavascriptFnv1a {
    fn new() -> Self {
        Self {
            value: 0x811c9dc5,
            initialized: true,
        }
    }

    fn update(&mut self, text: &str) {
        debug_assert!(self.initialized);
        for unit in text.encode_utf16() {
            self.value ^= u32::from(unit);
            self.value = self.value.wrapping_mul(0x01000193);
        }
    }

    fn finish(&self) -> String {
        format!("{:08x}", self.value)
    }
}

struct JavascriptValueSeed<'a> {
    checksum: &'a mut JavascriptFnv1a,
}

impl<'de> DeserializeSeed<'de> for JavascriptValueSeed<'_> {
    type Value = Value;

    fn deserialize<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_any(JavascriptValueVisitor {
            checksum: self.checksum,
        })
    }
}

struct JavascriptSequenceElementSeed<'a> {
    checksum: &'a mut JavascriptFnv1a,
    comma: bool,
}

impl<'de> DeserializeSeed<'de> for JavascriptSequenceElementSeed<'_> {
    type Value = Value;

    fn deserialize<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
    where
        D: Deserializer<'de>,
    {
        if self.comma {
            self.checksum.update(",");
        }
        JavascriptValueSeed {
            checksum: self.checksum,
        }
        .deserialize(deserializer)
    }
}

struct JavascriptValueVisitor<'a> {
    checksum: &'a mut JavascriptFnv1a,
}

impl<'de> Visitor<'de> for JavascriptValueVisitor<'_> {
    type Value = Value;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a JSON value compatible with JavaScript JSON.stringify")
    }

    fn visit_bool<E>(self, value: bool) -> Result<Self::Value, E> {
        self.checksum.update(if value { "true" } else { "false" });
        Ok(Value::Bool(value))
    }

    fn visit_i64<E>(self, value: i64) -> Result<Self::Value, E> {
        self.checksum.update(&value.to_string());
        Ok(Value::Number(value.into()))
    }

    fn visit_u64<E>(self, value: u64) -> Result<Self::Value, E> {
        self.checksum.update(&value.to_string());
        Ok(Value::Number(value.into()))
    }

    fn visit_f64<E: DeError>(self, value: f64) -> Result<Self::Value, E> {
        if !value.is_finite() {
            return Err(E::custom("native v47 import number is not finite"));
        }
        let mut buffer = ryu_js::Buffer::new();
        self.checksum.update(buffer.format_finite(value));
        serde_json::Number::from_f64(value)
            .map(Value::Number)
            .ok_or_else(|| E::custom("native v47 import number is invalid"))
    }

    fn visit_str<E: DeError>(self, value: &str) -> Result<Self::Value, E> {
        self.checksum
            .update(&serde_json::to_string(value).map_err(E::custom)?);
        Ok(Value::String(value.to_owned()))
    }

    fn visit_string<E: DeError>(self, value: String) -> Result<Self::Value, E> {
        self.checksum
            .update(&serde_json::to_string(&value).map_err(E::custom)?);
        Ok(Value::String(value))
    }

    fn visit_none<E>(self) -> Result<Self::Value, E> {
        self.checksum.update("null");
        Ok(Value::Null)
    }

    fn visit_unit<E>(self) -> Result<Self::Value, E> {
        self.checksum.update("null");
        Ok(Value::Null)
    }

    fn visit_some<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
    where
        D: Deserializer<'de>,
    {
        JavascriptValueSeed {
            checksum: self.checksum,
        }
        .deserialize(deserializer)
    }

    fn visit_newtype_struct<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
    where
        D: Deserializer<'de>,
    {
        self.visit_some(deserializer)
    }

    fn visit_seq<A>(self, mut sequence: A) -> Result<Self::Value, A::Error>
    where
        A: SeqAccess<'de>,
    {
        self.checksum.update("[");
        let mut values = Vec::with_capacity(sequence.size_hint().unwrap_or(0).min(4096));
        while let Some(value) = sequence.next_element_seed(JavascriptSequenceElementSeed {
            checksum: self.checksum,
            comma: !values.is_empty(),
        })? {
            values.push(value);
        }
        self.checksum.update("]");
        Ok(Value::Array(values))
    }

    fn visit_map<A>(self, mut object: A) -> Result<Self::Value, A::Error>
    where
        A: MapAccess<'de>,
    {
        self.checksum.update("{");
        let mut values = Map::new();
        let mut first = true;
        while let Some(key) = object.next_key::<String>()? {
            if values.contains_key(&key) {
                return Err(A::Error::custom("native v47 import repeats an object key"));
            }
            if !first {
                self.checksum.update(",");
            }
            first = false;
            self.checksum
                .update(&serde_json::to_string(&key).map_err(A::Error::custom)?);
            self.checksum.update(":");
            let value = object.next_value_seed(JavascriptValueSeed {
                checksum: self.checksum,
            })?;
            values.insert(key, value);
        }
        self.checksum.update("}");
        Ok(Value::Object(values))
    }
}

fn update_javascript_value(raw: &str, checksum: &mut JavascriptFnv1a) -> anyhow::Result<Value> {
    let mut deserializer = serde_json::Deserializer::from_str(raw);
    let value = JavascriptValueSeed { checksum }
        .deserialize(&mut deserializer)
        .context("decode native v47 import value")?;
    deserializer
        .end()
        .context("native v47 import value contains trailing data")?;
    Ok(value)
}

struct RawRecordsSeed<'a> {
    checksum: &'a mut JavascriptFnv1a,
    maximum: usize,
    label: &'static str,
}

impl<'de> DeserializeSeed<'de> for RawRecordsSeed<'_> {
    type Value = Vec<String>;

    fn deserialize<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_seq(RawRecordsVisitor {
            checksum: self.checksum,
            maximum: self.maximum,
            label: self.label,
        })
    }
}

struct RawRecordsVisitor<'a> {
    checksum: &'a mut JavascriptFnv1a,
    maximum: usize,
    label: &'static str,
}

impl<'de> Visitor<'de> for RawRecordsVisitor<'_> {
    type Value = Vec<String>;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "a bounded native v47 {} array", self.label)
    }

    fn visit_seq<A>(self, mut sequence: A) -> Result<Self::Value, A::Error>
    where
        A: SeqAccess<'de>,
    {
        self.checksum.update("[");
        let mut values = Vec::with_capacity(sequence.size_hint().unwrap_or(0).min(self.maximum));
        while let Some(raw) = sequence.next_element::<Box<RawValue>>()? {
            if values.len() >= self.maximum {
                return Err(A::Error::custom(format!(
                    "native v47 import {} count exceeds its limit",
                    self.label
                )));
            }
            if raw.get().len() > MAX_RECORD_BYTES {
                return Err(A::Error::custom(format!(
                    "native v47 import {} record exceeds its limit",
                    self.label
                )));
            }
            if !values.is_empty() {
                self.checksum.update(",");
            }
            let value =
                update_javascript_value(raw.get(), self.checksum).map_err(A::Error::custom)?;
            if !value.is_object() {
                return Err(A::Error::custom(format!(
                    "native v47 import {} record is not an object",
                    self.label
                )));
            }
            values.push(raw.get().to_owned());
        }
        self.checksum.update("]");
        Ok(values)
    }
}

struct ImportedState {
    base: Map<String, Value>,
    entities: Vec<String>,
    belts: Vec<String>,
    checksum: String,
}

impl<'de> Deserialize<'de> for ImportedState {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_map(ImportedStateVisitor)
    }
}

struct ImportedStateVisitor;

impl<'de> Visitor<'de> for ImportedStateVisitor {
    type Value = ImportedState;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a current v47 GameState object")
    }

    fn visit_map<A>(self, mut object: A) -> Result<Self::Value, A::Error>
    where
        A: MapAccess<'de>,
    {
        let mut checksum = JavascriptFnv1a::new();
        checksum.update("{\"formatVersion\":2,\"state\":{");
        let mut base = Map::new();
        let mut entities = None;
        let mut belts = None;
        let mut seen = HashSet::new();
        let mut first = true;
        while let Some(key) = object.next_key::<String>()? {
            if seen.len() >= MAX_STATE_FIELDS {
                return Err(A::Error::custom(
                    "native v47 import has too many state fields",
                ));
            }
            if !seen.insert(key.clone()) {
                return Err(A::Error::custom("native v47 import repeats a state field"));
            }
            if !first {
                checksum.update(",");
            }
            first = false;
            checksum.update(&serde_json::to_string(&key).map_err(A::Error::custom)?);
            checksum.update(":");
            match key.as_str() {
                "entities" => {
                    entities = Some(object.next_value_seed(RawRecordsSeed {
                        checksum: &mut checksum,
                        maximum: MAX_ENTITY_COUNT,
                        label: "entity",
                    })?);
                }
                "belts" => {
                    belts = Some(object.next_value_seed(RawRecordsSeed {
                        checksum: &mut checksum,
                        maximum: MAX_BELT_COUNT,
                        label: "belt",
                    })?);
                }
                _ => {
                    let raw = object.next_value::<Box<RawValue>>()?;
                    if raw.get().len() > MAX_BASE_FIELD_BYTES {
                        return Err(A::Error::custom(
                            "native v47 import base field exceeds its bounded limit",
                        ));
                    }
                    let value = update_javascript_value(raw.get(), &mut checksum)
                        .map_err(A::Error::custom)?;
                    base.insert(key, value);
                }
            }
        }
        checksum.update("}}");
        Ok(ImportedState {
            base,
            entities: entities
                .ok_or_else(|| A::Error::custom("native v47 import entities are missing"))?,
            belts: belts.ok_or_else(|| A::Error::custom("native v47 import belts are missing"))?,
            checksum: checksum.finish(),
        })
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Envelope {
    format_version: u16,
    kind: String,
    #[serde(default)]
    reason: Option<String>,
    saved_at: u64,
    mode: String,
    slot: Value,
    state: ImportedState,
    checksum: String,
}

pub fn parse_v47_envelope<R: Read>(
    reader: R,
    expected_byte_length: u64,
) -> anyhow::Result<ParsedV47Envelope> {
    if expected_byte_length == 0 || expected_byte_length > MAX_V47_IMPORT_BYTES {
        bail!("native v47 import file size is invalid");
    }
    parse_v47_envelope_with_length(reader, Some(expected_byte_length))
}

/// Parses a decoded v47 JSON stream whose final byte length is not known in
/// advance. This is used for compressed file containers; the proof still
/// hashes and counts the decoded JSON bytes, and `BoundedHashReader` enforces
/// the same 256 MiB ceiling as an uncompressed import.
pub fn parse_v47_envelope_stream<R: Read>(reader: R) -> anyhow::Result<ParsedV47Envelope> {
    parse_v47_envelope_with_length(reader, None)
}

fn parse_v47_envelope_with_length<R: Read>(
    reader: R,
    expected_byte_length: Option<u64>,
) -> anyhow::Result<ParsedV47Envelope> {
    // serde_json requests individual bytes. Buffer the source so file-backed
    // imports do not issue one disk read per byte. Keep hashing and UTF-16
    // inspection outside the buffer: read-ahead must not change which bytes
    // count toward error classification after an earlier syntax error.
    let mut reader =
        BoundedHashReader::new(BufReader::with_capacity(SOURCE_READ_BUFFER_BYTES, reader));
    let mut deserializer = serde_json::Deserializer::from_reader(&mut reader);
    let envelope_result = Envelope::deserialize(&mut deserializer);
    let trailing_result = if envelope_result.is_ok() {
        Some(deserializer.end())
    } else {
        None
    };
    drop(deserializer);
    if envelope_result.is_err() && reader.requires_javascript_compatibility() {
        return Err(V47ImportJavascriptCompatibilityRequired.into());
    }
    let envelope = envelope_result.context("decode native v47 envelope")?;
    if let Some(result) = trailing_result {
        result.context("native v47 envelope contains trailing data")?;
    }
    let (source_byte_length, source_sha256) = reader.finish();
    if source_byte_length == 0 {
        bail!("native v47 import decoded stream is empty");
    }
    if expected_byte_length.is_some_and(|expected| source_byte_length != expected) {
        bail!("native v47 import file identity changed while reading");
    }
    let _ = envelope.reason;
    if envelope.format_version != 2
        || !matches!(envelope.kind.as_str(), "primary" | "slot" | "snapshot")
        || !matches!(envelope.mode.as_str(), "normal" | "speedrun")
        || envelope.saved_at > MAX_SAFE_INTEGER
        || envelope.checksum.len() != 8
        || !envelope
            .checksum
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        || envelope.checksum != envelope.state.checksum
    {
        bail!("native v47 import envelope identity or checksum is invalid");
    }
    let envelope_slot = match envelope.slot {
        Value::String(value) if value == "main" => value,
        Value::Number(value) if matches!(value.as_u64(), Some(1..=3)) => value.to_string(),
        _ => bail!("native v47 import envelope slot is invalid"),
    };
    let source_state_version = envelope.state.base.get("version").and_then(Value::as_u64);
    if !matches!(source_state_version, Some(46 | 47))
        || envelope.state.base.get("mode").and_then(Value::as_str) != Some(envelope.mode.as_str())
    {
        bail!("native v47 import state version or mode is invalid");
    }
    let mut base = envelope.state.base;
    if source_state_version == Some(46) {
        adapt_v46_base_to_v47(&mut base, &envelope.mode, envelope.saved_at)?;
    }
    let proof = V47ImportProof {
        format_version: 2,
        state_version: 47,
        kind: envelope.kind,
        envelope_slot,
        mode: envelope.mode,
        saved_at_ms: envelope.saved_at,
        state_checksum: envelope.checksum,
        source_sha256,
        source_byte_length,
        entity_count: envelope.state.entities.len(),
        belt_count: envelope.state.belts.len(),
    };
    Ok(ParsedV47Envelope {
        proof,
        base,
        entities: envelope.state.entities,
        belts: envelope.state.belts,
    })
}

/// The v46 -> v47 persistence change was additive: v47 introduced the
/// orbital-station namespace. Keep this adapter deliberately narrow and
/// deterministic. It validates the v46 envelope/checksum first, discards any
/// forged pre-v47 station field, and derives the new empty board from the
/// envelope timestamp rather than wall-clock time. All other opaque fields
/// remain byte-semantically represented by the parsed JSON values.
fn adapt_v46_base_to_v47(
    base: &mut Map<String, Value>,
    mode: &str,
    saved_at_ms: u64,
) -> anyhow::Result<()> {
    if base.get("version").and_then(Value::as_u64) != Some(46) {
        bail!("native v46 compatibility adapter received the wrong state version");
    }
    let universe_matrix_produced = base
        .get("totalProduced")
        .and_then(Value::as_object)
        .and_then(|totals| totals.get("universe_matrix"))
        .and_then(Value::as_f64)
        .is_some_and(|amount| amount.is_finite() && amount >= 1.0);
    let eligible = mode == "normal" && universe_matrix_produced;
    let task_day = saved_at_ms.saturating_add(8 * 60 * 60 * 1_000) / (24 * 60 * 60 * 1_000);
    base.insert("version".to_owned(), Value::from(47));
    base.insert(
        "orbitalStation".to_owned(),
        json!({
            "stateVersion": 1,
            "status": if eligible { "eligible" } else { "locked" },
            "construction": {
                "costRevision": 1,
                "stageRequirements": [
                    {
                        "stageId": "core",
                        "costs": [
                            {"itemId":"titanium_alloy","amount":"200000"},
                            {"itemId":"frame_material","amount":"100000"},
                            {"itemId":"processor","amount":"200000"},
                            {"itemId":"universe_matrix","amount":"20000"}
                        ],
                        "fleetCosts": {}, "delivered": {}, "deliveredFleet": {}
                    },
                    {
                        "stageId": "dock",
                        "costs": [
                            {"itemId":"quantum_chip","amount":"100000"},
                            {"itemId":"particle_container","amount":"200000"},
                            {"itemId":"space_warper","amount":"20000"}
                        ],
                        "fleetCosts": {"logistics_vessel":200}, "delivered": {}, "deliveredFleet": {}
                    },
                    {
                        "stageId": "showcase",
                        "costs": [
                            {"itemId":"titanium_glass","amount":"300000"},
                            {"itemId":"particle_broadband","amount":"200000"},
                            {"itemId":"plastic","amount":"500000"},
                            {"itemId":"universe_matrix","amount":"50000"}
                        ],
                        "fleetCosts": {}, "delivered": {}, "deliveredFleet": {}
                    }
                ]
            },
            "viewport": {"x":0,"y":0,"zoom":0.72},
            "contractBoard": {
                "rulesVersion":1,
                "taskDay":task_day,
                "lastConfirmedWallClockMs":saved_at_ms,
                "offers":[], "accepted":[], "history":[], "settledIds":[],
                "featuredContractId":null
            },
            "economy": {"orbitalMarks":"0","stationReputation":"0","unlockedDecorationIds":[]},
            "layout": {"themeId":"orbital_teal","placements":[],"featuredAchievementIds":[]},
            "profile": {
                "title":"我的轨道空间站",
                "motto":"让每一条生产线通向群星。",
                "featuredMetricKeys":["total-generation","peak-throughput","dyson-power"]
            },
            "totals": {"completedContracts":0,"exportedByItem":{}}
        }),
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TinyChunkReader<'a> {
        bytes: &'a [u8],
        offset: usize,
        reads: usize,
        maximum_chunk: usize,
    }

    impl Read for TinyChunkReader<'_> {
        fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
            if self.offset == self.bytes.len() {
                return Ok(0);
            }
            let count = (self.bytes.len() - self.offset)
                .min(buffer.len())
                .min(self.maximum_chunk);
            buffer[..count].copy_from_slice(&self.bytes[self.offset..self.offset + count]);
            self.offset += count;
            self.reads += 1;
            Ok(count)
        }
    }

    fn checksum(state: &str) -> String {
        let mut checksum = JavascriptFnv1a::new();
        checksum.update("{\"formatVersion\":2,\"state\":");
        update_javascript_value(state, &mut checksum).unwrap();
        checksum.update("}");
        checksum.finish()
    }

    fn fixture(pretty: bool) -> Vec<u8> {
        let state = r#"{"version":47,"mode":"normal","activePlanetId":"home","elapsedSeconds":0,"paused":false,"tray":{},"entities":[{"id":"vein","kind":"vein","planetId":"home","resourceId":"iron_ore","minerCount":2,"inputs":{},"outputs":{"iron_ore":3},"progress":0,"utilization":0,"productionRate":0,"routingCursor":0}],"belts":[]}"#;
        let state_value = serde_json::from_str::<Value>(state).unwrap();
        let serialized_state = serde_json::to_string(&state_value).unwrap();
        let envelope = serde_json::json!({
            "formatVersion": 2,
            "kind": "primary",
            "savedAt": 42,
            "mode": "normal",
            "slot": "main",
            "state": state_value,
            "checksum": checksum(&serialized_state),
        });
        if pretty {
            serde_json::to_vec_pretty(&envelope).unwrap()
        } else {
            serde_json::to_vec(&envelope).unwrap()
        }
    }

    #[test]
    fn parses_pretty_v47_without_materializing_the_complete_envelope() {
        let bytes = fixture(true);
        let parsed = parse_v47_envelope(bytes.as_slice(), bytes.len() as u64).unwrap();
        assert_eq!(parsed.proof().state_checksum.len(), 8);
        assert_eq!(parsed.proof().entity_count, 1);
        assert_eq!(parsed.proof().belt_count, 0);
        assert_eq!(
            parsed.proof().source_sha256,
            hex::encode(Sha256::digest(&bytes))
        );
    }

    #[test]
    fn parses_a_bounded_stream_without_a_predeclared_length() {
        let bytes = fixture(true);
        let parsed = parse_v47_envelope_stream(bytes.as_slice()).unwrap();
        assert_eq!(parsed.proof().source_byte_length, bytes.len() as u64);
        assert_eq!(
            parsed.proof().source_sha256,
            hex::encode(Sha256::digest(&bytes))
        );
    }

    #[test]
    fn migrates_a_v46_envelope_with_only_the_additive_station_namespace() {
        let state = r#"{"version":46,"mode":"normal","activePlanetId":"home","elapsedSeconds":0,"paused":false,"totalProduced":{"universe_matrix":1},"orbitalStation":{"forged":true},"entities":[],"belts":[]}"#;
        let state_value = serde_json::from_str::<Value>(state).unwrap();
        let serialized_state = serde_json::to_string(&state_value).unwrap();
        let bytes = serde_json::to_vec(&json!({
            "formatVersion": 2,
            "kind": "primary",
            "savedAt": 86_400_000,
            "mode": "normal",
            "slot": "main",
            "state": state_value,
            "checksum": checksum(&serialized_state),
        }))
        .unwrap();

        let parsed = parse_v47_envelope(bytes.as_slice(), bytes.len() as u64).unwrap();

        assert_eq!(parsed.proof.state_version, 47);
        assert_eq!(parsed.base["version"], 47);
        assert_eq!(parsed.base["orbitalStation"]["stateVersion"], 1);
        assert_eq!(parsed.base["orbitalStation"]["status"], "eligible");
        assert_eq!(parsed.base["orbitalStation"]["contractBoard"]["taskDay"], 1);
        assert!(parsed.base["orbitalStation"].get("forged").is_none());
    }

    #[test]
    fn decoded_stream_reader_rejects_the_byte_after_the_256_mib_limit() {
        let mut reader = BoundedHashReader {
            inner: b"ab".as_slice(),
            digest: Sha256::new(),
            bytes_read: MAX_V47_IMPORT_BYTES - 1,
            utf16_compatibility: JavascriptUtf16CompatibilityScanner::default(),
        };
        let error = reader.read_to_end(&mut Vec::new()).unwrap_err();
        assert!(error.to_string().contains("bounded file limit"));
    }

    #[test]
    fn rejects_checksum_corruption_and_trailing_json() {
        let mut value: Value = serde_json::from_slice(&fixture(false)).unwrap();
        value["checksum"] = Value::String("00000000".to_owned());
        let bytes = serde_json::to_vec(&value).unwrap();
        assert!(
            parse_v47_envelope(bytes.as_slice(), bytes.len() as u64)
                .unwrap_err()
                .to_string()
                .contains("checksum")
        );

        let mut trailing = fixture(false);
        trailing.extend_from_slice(b" {}");
        assert!(parse_v47_envelope(trailing.as_slice(), trailing.len() as u64).is_err());
    }

    #[test]
    fn rejects_length_changes_before_returning_parsed_state() {
        let bytes = fixture(false);
        assert!(parse_v47_envelope(bytes.as_slice(), bytes.len() as u64 + 1).is_err());
        assert!(parse_v47_envelope(bytes.as_slice(), MAX_V47_IMPORT_BYTES + 1).is_err());
    }

    #[test]
    fn parses_large_record_arrays_from_tiny_bounded_read_chunks() {
        let entities = (0..5_000)
            .map(|index| format!("{{\"id\":\"entity-{index}\",\"kind\":\"marker\"}}"))
            .collect::<Vec<_>>()
            .join(",");
        let state = format!(
            "{{\"version\":47,\"mode\":\"normal\",\"activePlanetId\":\"home\",\"elapsedSeconds\":0,\"paused\":false,\"entities\":[{entities}],\"belts\":[]}}"
        );
        let checksum = checksum(&state);
        let bytes = format!(
            "{{\"formatVersion\":2,\"kind\":\"primary\",\"savedAt\":1,\"mode\":\"normal\",\"slot\":\"main\",\"state\":{state},\"checksum\":\"{checksum}\"}}"
        )
        .into_bytes();
        let mut reader = TinyChunkReader {
            bytes: &bytes,
            offset: 0,
            reads: 0,
            maximum_chunk: 31,
        };
        let parsed = parse_v47_envelope(&mut reader, bytes.len() as u64).unwrap();
        assert_eq!(parsed.proof().entity_count, 5_000);
        assert!(reader.reads > 1_000);
    }

    #[test]
    fn matches_javascript_utf16_checksum_for_unicode_escapes_and_number_spelling() {
        // Expected value was produced by the v2 JavaScript implementation:
        // FNV-1a over JSON.stringify({ formatVersion: 2, state }). The source
        // intentionally differs from JSON.stringify spelling so the parser
        // must normalize escapes, negative zero, and exponent thresholds.
        let state = r#"{"version":47,"mode":"normal","activePlanetId":"home","elapsedSeconds":-0,"paused":false,"note":"\u78c1\u77f3\ud83d\ude80\n\"\\","ratio":1e-7,"large":1e21,"near":1e20,"entities":[{"id":"\u77ff\u673a\ud83d\ude80","kind":"marker","progress":-0,"small":1e-7,"large":1e21,"text":"A\u2028B"}],"belts":[]}"#;
        assert_eq!(checksum(state), "9c35dbff");
        let bytes = format!(
            "{{\n  \"formatVersion\": 2,\n  \"kind\": \"primary\",\n  \"savedAt\": 1,\n  \"mode\": \"normal\",\n  \"slot\": \"main\",\n  \"state\": {state},\n  \"checksum\": \"9c35dbff\"\n}}"
        )
        .into_bytes();
        let parsed = parse_v47_envelope(bytes.as_slice(), bytes.len() as u64).unwrap();
        assert_eq!(parsed.proof().state_checksum, "9c35dbff");
    }

    #[test]
    fn batches_underlying_reads_without_changing_envelope_proofs() {
        let mut bytes = fixture(false);
        // Legal trailing whitespace crosses several reader-buffer boundaries.
        bytes.extend(std::iter::repeat_n(b' ', 512 * 1024));
        let expected = parse_v47_envelope(bytes.as_slice(), bytes.len() as u64).unwrap();
        let mut reader = TinyChunkReader {
            bytes: &bytes,
            offset: 0,
            reads: 0,
            maximum_chunk: usize::MAX,
        };
        let parsed = parse_v47_envelope(&mut reader, bytes.len() as u64).unwrap();
        assert_eq!(reader.offset, bytes.len());
        assert_eq!(parsed.proof().source_sha256, expected.proof().source_sha256);
        assert_eq!(parsed.proof().source_byte_length, bytes.len() as u64);
        assert_eq!(
            parsed.proof().state_checksum,
            expected.proof().state_checksum
        );
        assert_eq!(parsed.base, expected.base);
        assert_eq!(parsed.entities, expected.entities);
        assert_eq!(parsed.belts, expected.belts);
        assert!(
            reader.reads <= bytes.len().div_ceil(64 * 1024),
            "expected bounded chunk reads, got {} for {} bytes",
            reader.reads,
            bytes.len()
        );
    }

    #[test]
    fn buffered_source_still_requires_successful_final_eof() {
        struct RejectEof<'a>(&'a [u8]);
        impl Read for RejectEof<'_> {
            fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
                if self.0.is_empty() {
                    return Err(IoError::new(
                        ErrorKind::InvalidData,
                        "fixture identity changed at EOF",
                    ));
                }
                self.0.read(buffer)
            }
        }
        let bytes = fixture(false);
        let error = parse_v47_envelope(RejectEof(&bytes), bytes.len() as u64).unwrap_err();
        assert!(format!("{error:#}").contains("fixture identity changed at EOF"));
    }

    #[test]
    fn unread_surrogate_after_a_syntax_error_does_not_change_error_classification() {
        let bytes = br#"{! "later":"\ud800"}"#;
        let error = parse_v47_envelope(bytes.as_slice(), bytes.len() as u64).unwrap_err();
        assert!(
            error
                .downcast_ref::<V47ImportJavascriptCompatibilityRequired>()
                .is_none()
        );
        assert!(format!("{error:#}").contains("decode native v47 envelope"));
    }

    #[test]
    fn legal_lone_utf16_surrogates_use_the_javascript_compatibility_importer() {
        for escaped_surrogate in [r"\ud800", r"\udfff", r"\ud800A"] {
            let state = format!(
                "{{\"version\":47,\"mode\":\"normal\",\"activePlanetId\":\"home\",\"elapsedSeconds\":0,\"paused\":false,\"note\":\"{escaped_surrogate}\",\"entities\":[],\"belts\":[]}}"
            );
            let bytes = format!(
                "{{\"formatVersion\":2,\"kind\":\"primary\",\"savedAt\":1,\"mode\":\"normal\",\"slot\":\"main\",\"state\":{state},\"checksum\":\"00000000\"}}"
            )
            .into_bytes();
            let mut reader = TinyChunkReader {
                bytes: &bytes,
                offset: 0,
                reads: 0,
                maximum_chunk: 1,
            };
            let error = parse_v47_envelope(&mut reader, bytes.len() as u64).unwrap_err();
            assert!(
                error
                    .downcast_ref::<V47ImportJavascriptCompatibilityRequired>()
                    .is_some(),
                "unexpected error for {escaped_surrogate}: {error:#}"
            );
            assert_eq!(
                V47_IMPORT_JS_COMPATIBILITY_REQUIRED_CODE,
                "NATIVE_V47_IMPORT_JS_COMPATIBILITY_REQUIRED"
            );
            assert!(
                error
                    .to_string()
                    .contains("JavaScript compatibility importer")
            );
        }
    }
}
