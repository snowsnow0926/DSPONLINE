//! Strict, bounded ordinary-blueprint exchange admission.
//!
//! The exchange text is renderer-originated, but Rust exclusively parses and
//! canonicalizes it. The durable marker contains the complete, already bounded
//! canonical blueprint so a cold WAL replay never depends on a Host blob store.

use std::collections::HashSet;
use std::fmt;

use anyhow::{anyhow, bail};
use serde::de::{self, MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Deserializer};
use serde_json::{Map, Number, Value, json};
use sha2::{Digest, Sha256};

use crate::blueprint_workspace::{
    validate_blueprint_directory, validate_queue_directory, validate_version_directory,
};
use crate::command::{PathSegment, SimulationCommandPatch, ValuePatch};
use crate::construction_queue_command::{
    ordinary_blueprint_definition_has_no_internal_overlap,
    ordinary_blueprint_definition_supported_on_planet,
};
use crate::state::CoreState;

pub(crate) const BLUEPRINT_IMPORT_CONTEXT_PROJECTION: &str = "blueprint-import-context-v1";
pub(crate) const BLUEPRINT_EXPORT_CONTEXT_PROJECTION: &str = "blueprint-export-context-v1";
pub(crate) const MAX_BLUEPRINT_IMPORT_BYTES: usize = 1_048_576;
pub(crate) const MAX_BLUEPRINT_IMPORT_ENTITIES: usize = 512;
pub(crate) const MAX_BLUEPRINT_IMPORT_BELTS: usize = 1_024;
pub(crate) const MAX_BLUEPRINT_IMPORT_LIBRARY_ROWS: usize = 64;
pub(crate) const MAX_BLUEPRINT_IMPORT_COMMAND_BYTES: usize = 1_048_576;

const MAX_BLUEPRINT_NAME_UTF16_UNITS: usize = 48;
const MAX_OPAQUE_ID_BYTES: usize = 512;
const MAX_EXPORTED_AT_BYTES: usize = 128;
const MAX_BUILDING_STACK_COUNT: u64 = 100_000_000;
const MAX_BELT_LANES: u64 = 4_096;
const MAX_RECIPE_OVERRIDE_ROWS: usize = 4_096;
const MAX_EXPORT_VALUE_DEPTH: usize = 8;
const MAX_JAVASCRIPT_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const MAX_POSITION_ABS: f64 = 100_000.0;
const MAX_ROUTE_OFFSET_ABS: f64 = 10_000.0;

const BLUEPRINT_KEYS: &[&str] = &[
    "id",
    "name",
    "revision",
    "entities",
    "resourceAnchors",
    "belts",
    "externalPorts",
    "rotation",
    "mirror",
    "recipeOverrides",
];
const ENTITY_KEYS: &[&str] = &[
    "key",
    "buildingId",
    "offset",
    "machineCount",
    "recipeId",
    "targetDysonOrbitId",
    "storedItemId",
    "distributionMode",
    "fuelItemId",
    "energyMode",
    "powerGridId",
    "powerPriority",
    "generationPriority",
    "sprayCoaterInstalled",
    "proliferatorTier",
    "proliferatorMode",
];
const BELT_KEYS: &[&str] = &[
    "key",
    "sourceKey",
    "targetKey",
    "itemId",
    "lanes",
    "tier",
    "sorterTier",
    "priority",
    "stackSize",
    "monitorEnabled",
    "routeMode",
    "routeOffsetY",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct BlueprintImportMarker {
    pub(crate) source_name: String,
    pub(crate) blueprint: Value,
    pub(crate) blueprint_sha256: String,
    pub(crate) revision: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct BlueprintImportPlan {
    pub(crate) expected_next_id: u64,
    pub(crate) expected_library_len: usize,
    pub(crate) blueprint: Value,
    pub(crate) next_id_after: u64,
}

pub(crate) enum BlueprintImportPreparation {
    Supported {
        plan: BlueprintImportPlan,
        marker: Value,
    },
    Unsupported(&'static str),
}

struct StrictJsonValue(Value);

struct StrictJsonVisitor;

impl<'de> Visitor<'de> for StrictJsonVisitor {
    type Value = StrictJsonValue;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a strict JSON value without duplicate object keys")
    }

    fn visit_bool<E>(self, value: bool) -> Result<Self::Value, E> {
        Ok(StrictJsonValue(Value::Bool(value)))
    }

    fn visit_i64<E>(self, value: i64) -> Result<Self::Value, E> {
        Ok(StrictJsonValue(Value::Number(Number::from(value))))
    }

    fn visit_u64<E>(self, value: u64) -> Result<Self::Value, E> {
        Ok(StrictJsonValue(Value::Number(Number::from(value))))
    }

    fn visit_f64<E>(self, value: f64) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        Number::from_f64(value)
            .map(Value::Number)
            .map(StrictJsonValue)
            .ok_or_else(|| E::custom("non-finite JSON number"))
    }

    fn visit_str<E>(self, value: &str) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        self.visit_string(value.to_owned())
    }

    fn visit_string<E>(self, value: String) -> Result<Self::Value, E> {
        Ok(StrictJsonValue(Value::String(value)))
    }

    fn visit_none<E>(self) -> Result<Self::Value, E> {
        Ok(StrictJsonValue(Value::Null))
    }

    fn visit_unit<E>(self) -> Result<Self::Value, E> {
        Ok(StrictJsonValue(Value::Null))
    }

    fn visit_seq<A>(self, mut sequence: A) -> Result<Self::Value, A::Error>
    where
        A: SeqAccess<'de>,
    {
        let mut values = Vec::with_capacity(sequence.size_hint().unwrap_or(0).min(4_096));
        while let Some(StrictJsonValue(value)) = sequence.next_element()? {
            values.push(value);
        }
        Ok(StrictJsonValue(Value::Array(values)))
    }

    fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
    where
        A: MapAccess<'de>,
    {
        let mut values = Map::new();
        while let Some(key) = map.next_key::<String>()? {
            if values.contains_key(&key) {
                return Err(de::Error::custom(format!("duplicate JSON key: {key}")));
            }
            let StrictJsonValue(value) = map.next_value()?;
            values.insert(key, value);
        }
        Ok(StrictJsonValue(Value::Object(values)))
    }
}

impl<'de> Deserialize<'de> for StrictJsonValue {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_any(StrictJsonVisitor)
    }
}

#[derive(Debug)]
struct ParsedBlueprintExchange {
    source_name: String,
    entities: Vec<Value>,
    belts: Vec<Value>,
    rotation: u64,
    mirror: String,
    recipe_overrides: Map<String, Value>,
}

impl ParsedBlueprintExchange {
    fn into_blueprint(self, id: &str, name: &str) -> Value {
        self.into_blueprint_with_revision(id, name, 1)
    }

    fn into_blueprint_with_revision(self, id: &str, name: &str, revision: u64) -> Value {
        json!({
            "id": id,
            "name": name,
            "revision": revision,
            "entities": self.entities,
            "resourceAnchors": [],
            "belts": self.belts,
            "externalPorts": [],
            "rotation": self.rotation,
            "mirror": self.mirror,
            "recipeOverrides": self.recipe_overrides,
        })
    }
}

fn nullable_optional_fields_removed(blueprint: &Map<String, Value>) -> Value {
    let mut blueprint = blueprint.clone();
    if let Some(entities) = blueprint.get_mut("entities").and_then(Value::as_array_mut) {
        for entity in entities {
            if let Some(entity) = entity.as_object_mut() {
                for key in ENTITY_KEYS {
                    if entity.get(*key).is_some_and(Value::is_null) {
                        entity.remove(*key);
                    }
                }
            }
        }
    }
    if let Some(belts) = blueprint.get_mut("belts").and_then(Value::as_array_mut) {
        for belt in belts {
            if let Some(belt) = belt.as_object_mut() {
                for key in BELT_KEYS {
                    if belt.get(*key).is_some_and(Value::is_null) {
                        belt.remove(*key);
                    }
                }
            }
        }
    }
    Value::Object(blueprint)
}

fn consume_export_bytes(remaining: &mut usize, bytes: usize) -> bool {
    if bytes > *remaining {
        false
    } else {
        *remaining -= bytes;
        true
    }
}

fn bounded_export_string_size(value: &str, remaining: &mut usize) -> bool {
    // JSON escaping can only expand one Unicode scalar to six bytes. This
    // conservative upper bound avoids serializing or cloning an untrusted
    // legacy string merely to establish the 1 MiB ceiling.
    let Some(size) = value.chars().try_fold(2usize, |size, character| {
        size.checked_add(if character.is_ascii_control() {
            6
        } else if matches!(character, '"' | '\\') {
            2
        } else {
            character.len_utf8()
        })
    }) else {
        return false;
    };
    consume_export_bytes(remaining, size)
}

fn bounded_export_json_size(value: &Value, depth: usize, remaining: &mut usize) -> bool {
    if depth > MAX_EXPORT_VALUE_DEPTH {
        return false;
    }
    match value {
        Value::Null => consume_export_bytes(remaining, 4),
        Value::Bool(value) => consume_export_bytes(remaining, if *value { 4 } else { 5 }),
        Value::Number(value) => consume_export_bytes(remaining, value.to_string().len()),
        Value::String(value) => bounded_export_string_size(value, remaining),
        Value::Array(values) => {
            if !consume_export_bytes(remaining, 2 + values.len().saturating_sub(1)) {
                return false;
            }
            values
                .iter()
                .all(|value| bounded_export_json_size(value, depth + 1, remaining))
        }
        Value::Object(values) => {
            if !consume_export_bytes(remaining, 2 + values.len().saturating_sub(1)) {
                return false;
            }
            values.iter().all(|(key, value)| {
                bounded_export_string_size(key, remaining)
                    && consume_export_bytes(remaining, 1)
                    && bounded_export_json_size(value, depth + 1, remaining)
            })
        }
    }
}

fn export_graph_is_bounded(blueprint: &Map<String, Value>) -> bool {
    let mut remaining = MAX_BLUEPRINT_IMPORT_BYTES;
    if remaining < 2 + blueprint.len().saturating_sub(1) {
        return false;
    }
    remaining -= 2 + blueprint.len().saturating_sub(1);
    blueprint.iter().all(|(key, value)| {
        bounded_export_string_size(key, &mut remaining)
            && consume_export_bytes(&mut remaining, 1)
            && bounded_export_json_size(value, 1, &mut remaining)
    })
}

fn canonical_export_source(blueprint: &Map<String, Value>) -> anyhow::Result<Value> {
    ensure_only_keys(blueprint, BLUEPRINT_KEYS, "export blueprint")?;
    match blueprint.get("entities") {
        Some(Value::Array(values))
            if !values.is_empty() && values.len() <= MAX_BLUEPRINT_IMPORT_ENTITIES => {}
        _ => bail!("native blueprint export entity count is unsupported"),
    }
    match blueprint.get("belts") {
        Some(Value::Array(values)) if values.len() <= MAX_BLUEPRINT_IMPORT_BELTS => {}
        _ => bail!("native blueprint export belt count is unsupported"),
    }
    for (key, label) in [
        ("resourceAnchors", "resource anchors"),
        ("externalPorts", "external ports"),
    ] {
        match blueprint.get(key) {
            None => {}
            Some(Value::Array(values)) if values.is_empty() => {}
            _ => bail!("native blueprint export {label} are unsupported"),
        }
    }
    match blueprint.get("recipeOverrides") {
        None => {}
        Some(Value::Object(values)) if values.len() <= MAX_RECIPE_OVERRIDE_ROWS => {}
        _ => bail!("native blueprint export recipe overrides are unsupported"),
    }
    if !export_graph_is_bounded(blueprint) {
        bail!("native blueprint export source exceeds the bounded graph budget")
    }
    // Do not clone an untrusted legacy graph until every variable-length root
    // and nested string has passed the same ordinary exchange caps.
    let mut value = nullable_optional_fields_removed(blueprint);
    let object = value
        .as_object_mut()
        .expect("nullable export blueprint remains an object");
    let entities = object
        .get_mut("entities")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| anyhow!("native blueprint export entities are invalid"))?;
    let mut keys = HashSet::with_capacity(entities.len());
    let mut canonical_keys = std::collections::HashMap::with_capacity(entities.len());
    for (index, entity) in entities.iter_mut().enumerate() {
        let entity = entity
            .as_object_mut()
            .ok_or_else(|| anyhow!("native blueprint export entity is invalid"))?;
        let key = entity
            .get("key")
            .and_then(Value::as_str)
            .filter(|value| valid_opaque_text(value, MAX_OPAQUE_ID_BYTES))
            .ok_or_else(|| anyhow!("native blueprint export entity key is invalid"))?
            .to_owned();
        if !keys.insert(key.clone()) {
            bail!("native blueprint export entity keys are not unique")
        }
        let canonical = format!("node_{}", index + 1);
        canonical_keys.insert(key, canonical.clone());
        entity.insert("key".to_owned(), Value::from(canonical));
    }
    let belts = object
        .get_mut("belts")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| anyhow!("native blueprint export belts are invalid"))?;
    for (index, belt) in belts.iter_mut().enumerate() {
        let belt = belt
            .as_object_mut()
            .ok_or_else(|| anyhow!("native blueprint export belt is invalid"))?;
        let source = belt
            .get("sourceKey")
            .and_then(Value::as_str)
            .and_then(|value| canonical_keys.get(value))
            .cloned()
            .ok_or_else(|| anyhow!("native blueprint export belt source is invalid"))?;
        let target = belt
            .get("targetKey")
            .and_then(Value::as_str)
            .and_then(|value| canonical_keys.get(value))
            .cloned()
            .ok_or_else(|| anyhow!("native blueprint export belt target is invalid"))?;
        belt.insert("key".to_owned(), Value::from(format!("line_{}", index + 1)));
        belt.insert("sourceKey".to_owned(), Value::from(source));
        belt.insert("targetKey".to_owned(), Value::from(target));
        let tier = belt
            .get("tier")
            .and_then(Value::as_u64)
            .ok_or_else(|| anyhow!("native blueprint export belt tier is invalid"))?;
        belt.entry("sorterTier".to_owned())
            .or_insert_with(|| Value::from(tier.min(3)));
        belt.entry("priority".to_owned())
            .or_insert_with(|| Value::from(0));
    }
    Ok(value)
}

fn safe_file_stem(name: &str) -> String {
    let mut value = name
        .chars()
        .map(|character| {
            if character.is_control()
                || matches!(
                    character,
                    '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
                )
            {
                '_'
            } else {
                character
            }
        })
        .collect::<String>();
    value = value.trim_matches(edge_whitespace).to_owned();
    while value.ends_with([' ', '.']) {
        value.pop();
    }
    value = truncate_utf16(&value, 80);
    // Truncation can expose a space or dot that was not the original suffix.
    // Windows strips both, so normalize again before empty/reserved checks.
    while value.ends_with([' ', '.']) {
        value.pop();
    }
    let upper_base = value
        .split_once('.')
        .map_or(value.as_str(), |(base, _)| base)
        .trim_end_matches([' ', '.'])
        .to_ascii_uppercase();
    let reserved = matches!(upper_base.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || upper_base
            .strip_prefix("COM")
            .or_else(|| upper_base.strip_prefix("LPT"))
            .is_some_and(|suffix| {
                matches!(
                    suffix,
                    "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
                )
            });
    if value.is_empty() {
        "blueprint".to_owned()
    } else if reserved {
        let mut escaped = truncate_utf16(&format!("_{value}"), 80);
        while escaped.ends_with([' ', '.']) {
            escaped.pop();
        }
        escaped
    } else {
        value
    }
}

fn parse_strict_json(raw: &str) -> anyhow::Result<Value> {
    let mut deserializer = serde_json::Deserializer::from_str(raw);
    let StrictJsonValue(value) = StrictJsonValue::deserialize(&mut deserializer)?;
    deserializer.end()?;
    Ok(value)
}

fn sha256_bytes(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

fn serialize_export_exchange(blueprint: &Value) -> anyhow::Result<Option<String>> {
    let raw_exchange = serde_json::to_string(&json!({
        "type": "dsp-idle-blueprint",
        "formatVersion": 2,
        "blueprint": blueprint,
    }))?;
    Ok((raw_exchange.len() <= MAX_BLUEPRINT_IMPORT_BYTES).then_some(raw_exchange))
}

fn valid_opaque_text(value: &str, maximum_bytes: usize) -> bool {
    !value.is_empty() && value.len() <= maximum_bytes && !value.chars().any(char::is_control)
}

fn builtin_content_id(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
}

fn valid_exchange_key(value: &str) -> bool {
    let bytes = value.as_bytes();
    (2..=81).contains(&bytes.len())
        && bytes[0].is_ascii_lowercase()
        && bytes[1..]
            .iter()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'_')
}

fn ensure_only_keys(
    object: &Map<String, Value>,
    allowed: &[&str],
    label: &str,
) -> anyhow::Result<()> {
    if object.keys().any(|key| !allowed.contains(&key.as_str())) {
        bail!("native blueprint import {label} contains an unknown key")
    }
    Ok(())
}

fn required_object<'a>(value: &'a Value, label: &str) -> anyhow::Result<&'a Map<String, Value>> {
    value
        .as_object()
        .ok_or_else(|| anyhow!("native blueprint import {label} is invalid"))
}

fn required_text<'a>(
    object: &'a Map<String, Value>,
    key: &str,
    maximum_bytes: usize,
    label: &str,
) -> anyhow::Result<&'a str> {
    object
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| valid_opaque_text(value, maximum_bytes))
        .ok_or_else(|| anyhow!("native blueprint import {label} is invalid"))
}

fn optional_text<'a>(
    object: &'a Map<String, Value>,
    key: &str,
    maximum_bytes: usize,
    label: &str,
) -> anyhow::Result<Option<&'a str>> {
    match object.get(key) {
        None => Ok(None),
        Some(Value::String(value)) if valid_opaque_text(value, maximum_bytes) => Ok(Some(value)),
        _ => bail!("native blueprint import {label} is invalid"),
    }
}

fn safe_integer(
    value: Option<&Value>,
    minimum: u64,
    maximum: u64,
    label: &str,
) -> anyhow::Result<u64> {
    let number = value
        .and_then(Value::as_number)
        .ok_or_else(|| anyhow!("native blueprint import {label} is invalid"))?;
    let value = if let Some(value) = number.as_u64() {
        (value <= MAX_JAVASCRIPT_SAFE_INTEGER).then_some(value)
    } else if let Some(value) = number.as_i64() {
        (value >= 0).then_some(value as u64)
    } else {
        number
            .as_f64()
            .filter(|value| {
                value.is_finite()
                    && value.fract() == 0.0
                    && *value >= 0.0
                    && *value < 9_007_199_254_740_992.0
            })
            .map(|value| value as u64)
    }
    .filter(|value| (*value >= minimum) && (*value <= maximum))
    .ok_or_else(|| anyhow!("native blueprint import {label} is invalid"))?;
    Ok(value)
}

fn finite_number(value: Option<&Value>, maximum_abs: f64, label: &str) -> anyhow::Result<f64> {
    value
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite() && value.abs() <= maximum_abs)
        .ok_or_else(|| anyhow!("native blueprint import {label} is invalid"))
}

fn js_round(value: f64) -> f64 {
    let floor = value.floor();
    let rounded = if value - floor < 0.5 {
        floor
    } else {
        floor + 1.0
    };
    if rounded == 0.0 && value.is_sign_negative() {
        -0.0
    } else {
        rounded
    }
}

fn edge_whitespace(value: char) -> bool {
    value.is_whitespace() || value == '\u{feff}'
}

fn utf16_units(value: &str) -> usize {
    value.chars().map(char::len_utf16).sum()
}

fn truncate_utf16(value: &str, maximum_units: usize) -> String {
    let mut units = 0usize;
    value
        .chars()
        .take_while(|character| {
            let next = units + character.len_utf16();
            if next > maximum_units {
                false
            } else {
                units = next;
                true
            }
        })
        .collect()
}

fn canonical_source_name(value: &str) -> anyhow::Result<String> {
    let trimmed = value.trim_matches(edge_whitespace);
    if trimmed.is_empty()
        || trimmed.chars().any(char::is_control)
        || utf16_units(trimmed) > MAX_BLUEPRINT_NAME_UTF16_UNITS
    {
        bail!("native blueprint import source name is invalid")
    }
    Ok(trimmed.to_owned())
}

fn deterministic_import_name(
    source_name: &str,
    existing_names: &HashSet<&str>,
) -> anyhow::Result<String> {
    if !existing_names.contains(source_name) {
        return Ok(source_name.to_owned());
    }
    for suffix_index in 2..=existing_names.len().saturating_add(2) {
        let suffix = format!(" {suffix_index}");
        let suffix_units = utf16_units(&suffix);
        let base = truncate_utf16(
            source_name,
            MAX_BLUEPRINT_NAME_UTF16_UNITS.saturating_sub(suffix_units),
        )
        .trim_end_matches(edge_whitespace)
        .to_owned();
        if base.is_empty() {
            continue;
        }
        let candidate = format!("{base}{suffix}");
        if utf16_units(&candidate) <= MAX_BLUEPRINT_NAME_UTF16_UNITS
            && !existing_names.contains(candidate.as_str())
        {
            return Ok(candidate);
        }
    }
    bail!("native blueprint import name allocator is exhausted")
}

fn canonical_offset(value: Option<&Value>, label: &str) -> anyhow::Result<Value> {
    let object = value
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("native blueprint import {label} is invalid"))?;
    ensure_only_keys(object, &["x", "y"], label)?;
    if object.len() != 2 {
        bail!("native blueprint import {label} is invalid")
    }
    // `js_round` retains ECMAScript negative zero for its arithmetic contract.
    // Every accepted position is integral and bounded, so store it as an i64
    // rather than a serde floating Number. Node JSON transport stringifies
    // both `-0.0` and `0.0` as integer `0`; using the same lexical canonical
    // form here keeps context, marker hash, WAL and cold replay byte-stable.
    let x = js_round(finite_number(object.get("x"), MAX_POSITION_ABS, label)?) as i64;
    let y = js_round(finite_number(object.get("y"), MAX_POSITION_ABS, label)?) as i64;
    Ok(json!({ "x": x, "y": y }))
}

fn optional_enum(
    object: &Map<String, Value>,
    key: &str,
    allowed: &[&str],
    label: &str,
) -> anyhow::Result<Option<Value>> {
    optional_text(object, key, 64, label).and_then(|value| match value {
        None => Ok(None),
        Some(value) if allowed.contains(&value) => Ok(Some(Value::from(value))),
        Some(_) => bail!("native blueprint import {label} is invalid"),
    })
}

fn optional_bounded_integer(
    object: &Map<String, Value>,
    key: &str,
    minimum: u64,
    maximum: u64,
    label: &str,
) -> anyhow::Result<Option<Value>> {
    object
        .get(key)
        .map(|value| safe_integer(Some(value), minimum, maximum, label).map(Value::from))
        .transpose()
}

fn optional_bool(
    object: &Map<String, Value>,
    key: &str,
    label: &str,
) -> anyhow::Result<Option<Value>> {
    object
        .get(key)
        .map(|value| {
            value
                .as_bool()
                .map(Value::from)
                .ok_or_else(|| anyhow!("native blueprint import {label} is invalid"))
        })
        .transpose()
}

fn parse_entity(value: &Value) -> anyhow::Result<Value> {
    let source = required_object(value, "entity")?;
    ensure_only_keys(source, ENTITY_KEYS, "entity")?;
    for required in ["key", "buildingId", "offset", "machineCount"] {
        if !source.contains_key(required) {
            bail!("native blueprint import entity is missing {required}")
        }
    }
    let key = required_text(source, "key", 81, "entity key")?;
    if !valid_exchange_key(key) {
        bail!("native blueprint import entity key is invalid")
    }
    let building_id = required_text(source, "buildingId", MAX_OPAQUE_ID_BYTES, "building ID")?;
    let mut entity = Map::new();
    entity.insert("key".to_owned(), Value::from(key));
    entity.insert("buildingId".to_owned(), Value::from(building_id));
    entity.insert(
        "offset".to_owned(),
        canonical_offset(source.get("offset"), "entity offset")?,
    );
    entity.insert(
        "machineCount".to_owned(),
        Value::from(safe_integer(
            source.get("machineCount"),
            1,
            MAX_BUILDING_STACK_COUNT,
            "machine count",
        )?),
    );

    for (key, label) in [
        ("recipeId", "recipe ID"),
        ("targetDysonOrbitId", "Dyson orbit ID"),
        ("storedItemId", "stored item ID"),
        ("fuelItemId", "fuel item ID"),
    ] {
        if let Some(value) = optional_text(source, key, MAX_OPAQUE_ID_BYTES, label)? {
            entity.insert(key.to_owned(), Value::from(value));
        }
    }
    for (key, allowed, label) in [
        (
            "distributionMode",
            &["balanced", "priority"][..],
            "distribution mode",
        ),
        (
            "energyMode",
            &["auto", "charge", "discharge"][..],
            "energy mode",
        ),
        (
            "powerGridId",
            &["grid-a", "grid-b", "grid-c"][..],
            "power grid ID",
        ),
        (
            "proliferatorMode",
            &["normal", "extra", "speed"][..],
            "proliferator mode",
        ),
    ] {
        if let Some(value) = optional_enum(source, key, allowed, label)? {
            entity.insert(key.to_owned(), value);
        }
    }
    for (key, label) in [
        ("powerPriority", "power priority"),
        ("generationPriority", "generation priority"),
        ("proliferatorTier", "proliferator tier"),
    ] {
        if let Some(value) = optional_bounded_integer(source, key, 1, 3, label)? {
            entity.insert(key.to_owned(), value);
        }
    }
    if let Some(value) = optional_bool(
        source,
        "sprayCoaterInstalled",
        "spray coater installed flag",
    )? {
        entity.insert("sprayCoaterInstalled".to_owned(), value);
    }
    Ok(Value::Object(entity))
}

fn parse_belt(value: &Value, entity_keys: &HashSet<String>) -> anyhow::Result<Value> {
    let source = required_object(value, "belt")?;
    ensure_only_keys(source, BELT_KEYS, "belt")?;
    for required in [
        "key",
        "sourceKey",
        "targetKey",
        "itemId",
        "lanes",
        "tier",
        "priority",
    ] {
        if !source.contains_key(required) {
            bail!("native blueprint import belt is missing {required}")
        }
    }
    let key = required_text(source, "key", 81, "belt key")?;
    if !valid_exchange_key(key) {
        bail!("native blueprint import belt key is invalid")
    }
    let source_key = required_text(source, "sourceKey", 81, "belt source key")?;
    let target_key = required_text(source, "targetKey", 81, "belt target key")?;
    if source_key == target_key
        || !entity_keys.contains(source_key)
        || !entity_keys.contains(target_key)
    {
        bail!("native blueprint import belt endpoint is invalid")
    }
    let item_id = required_text(source, "itemId", MAX_OPAQUE_ID_BYTES, "belt item ID")?;
    let lanes = safe_integer(source.get("lanes"), 1, MAX_BELT_LANES, "belt lanes")?;
    let tier = safe_integer(source.get("tier"), 1, 3, "belt tier")?;
    if let Some(sorter_tier) = source.get("sorterTier")
        && safe_integer(Some(sorter_tier), 1, 3, "sorter tier")? != tier
    {
        bail!("native blueprint import sorter tier is not canonical")
    }
    let priority = safe_integer(source.get("priority"), 0, 2, "belt priority")?;
    let mut belt = Map::new();
    belt.insert("key".to_owned(), Value::from(key));
    belt.insert("sourceKey".to_owned(), Value::from(source_key));
    belt.insert("targetKey".to_owned(), Value::from(target_key));
    belt.insert("itemId".to_owned(), Value::from(item_id));
    belt.insert("lanes".to_owned(), Value::from(lanes));
    belt.insert("tier".to_owned(), Value::from(tier));
    belt.insert("sorterTier".to_owned(), Value::from(tier));
    belt.insert("priority".to_owned(), Value::from(priority));
    if let Some(value) = optional_bounded_integer(source, "stackSize", 1, 4, "stack size")? {
        if !matches!(value.as_u64(), Some(1 | 2 | 4)) {
            bail!("native blueprint import stack size is invalid")
        }
        belt.insert("stackSize".to_owned(), value);
    }
    if let Some(value) = optional_bool(source, "monitorEnabled", "belt monitor flag")? {
        belt.insert("monitorEnabled".to_owned(), value);
    }
    let route_mode = optional_enum(
        source,
        "routeMode",
        &["bezier", "auto", "upper", "lower", "manual"],
        "belt route mode",
    )?;
    if let Some(value) = route_mode.clone() {
        belt.insert("routeMode".to_owned(), value);
    }
    if let Some(value) = source.get("routeOffsetY") {
        let rounded = js_round(finite_number(
            Some(value),
            MAX_ROUTE_OFFSET_ABS,
            "belt route offset",
        )?);
        let rounded = rounded as i64;
        if route_mode.as_ref().and_then(Value::as_str) != Some("manual") {
            bail!("native blueprint import belt route offset requires manual routing")
        }
        belt.insert("routeOffsetY".to_owned(), Value::from(rounded));
    }
    Ok(Value::Object(belt))
}

fn parse_blueprint_object(
    blueprint: &Map<String, Value>,
    source_name_override: Option<&str>,
) -> anyhow::Result<ParsedBlueprintExchange> {
    ensure_only_keys(blueprint, BLUEPRINT_KEYS, "blueprint")?;
    for required in ["name", "entities", "belts"] {
        if !blueprint.contains_key(required) {
            bail!("native blueprint import blueprint is missing {required}")
        }
    }
    // Source IDs are never authoritative and are intentionally ignored even
    // when an older exchange wrote a non-string value. Rust always derives the
    // final ID from the current allocator.
    if let Some(revision) = blueprint.get("revision") {
        safe_integer(
            Some(revision),
            1,
            MAX_JAVASCRIPT_SAFE_INTEGER,
            "source revision",
        )?;
    }
    let source_name = canonical_source_name(source_name_override.unwrap_or(required_text(
        blueprint,
        "name",
        256,
        "source name",
    )?))?;
    let entities = blueprint
        .get("entities")
        .and_then(Value::as_array)
        .filter(|values| !values.is_empty() && values.len() <= MAX_BLUEPRINT_IMPORT_ENTITIES)
        .ok_or_else(|| anyhow!("native blueprint import entity count is invalid"))?;
    let mut entity_keys = HashSet::with_capacity(entities.len());
    let mut canonical_entities = Vec::with_capacity(entities.len());
    for value in entities {
        let canonical = parse_entity(value)?;
        let key = canonical
            .get("key")
            .and_then(Value::as_str)
            .expect("canonical import entity key");
        if !entity_keys.insert(key.to_owned()) {
            bail!("native blueprint import entity keys are not unique")
        }
        canonical_entities.push(canonical);
    }
    for key in ["resourceAnchors", "externalPorts"] {
        match blueprint.get(key) {
            None => {}
            Some(Value::Array(values)) if values.is_empty() => {}
            Some(Value::Array(_)) => bail!("native blueprint import unsupported ordinary domain"),
            _ => bail!("native blueprint import {key} is invalid"),
        }
    }
    let belts = blueprint
        .get("belts")
        .and_then(Value::as_array)
        .filter(|values| values.len() <= MAX_BLUEPRINT_IMPORT_BELTS)
        .ok_or_else(|| anyhow!("native blueprint import belt count is invalid"))?;
    let mut belt_keys = HashSet::with_capacity(belts.len());
    let mut canonical_belts = Vec::with_capacity(belts.len());
    for value in belts {
        let canonical = parse_belt(value, &entity_keys)?;
        let key = canonical
            .get("key")
            .and_then(Value::as_str)
            .expect("canonical import belt key");
        if !belt_keys.insert(key.to_owned()) {
            bail!("native blueprint import belt keys are not unique")
        }
        canonical_belts.push(canonical);
    }
    let rotation = match blueprint.get("rotation") {
        None => 0,
        Some(value) => safe_integer(Some(value), 0, 270, "rotation")?,
    };
    if !matches!(rotation, 0 | 90 | 180 | 270) {
        bail!("native blueprint import rotation is invalid")
    }
    let mirror = match blueprint.get("mirror") {
        None => "none",
        Some(Value::String(value)) if matches!(value.as_str(), "none" | "horizontal") => value,
        _ => bail!("native blueprint import mirror is invalid"),
    };
    let recipe_overrides = match blueprint.get("recipeOverrides") {
        None => Map::new(),
        Some(Value::Object(values)) if values.len() <= MAX_RECIPE_OVERRIDE_ROWS => {
            let mut canonical = Map::new();
            for (source, target) in values {
                if !valid_opaque_text(source, MAX_OPAQUE_ID_BYTES) {
                    bail!("native blueprint import recipe override source is invalid")
                }
                let target = target
                    .as_str()
                    .filter(|value| valid_opaque_text(value, MAX_OPAQUE_ID_BYTES))
                    .ok_or_else(|| {
                        anyhow!("native blueprint import recipe override target is invalid")
                    })?;
                canonical.insert(source.clone(), Value::from(target));
            }
            canonical
        }
        _ => bail!("native blueprint import recipe overrides are invalid"),
    };
    Ok(ParsedBlueprintExchange {
        source_name,
        entities: canonical_entities,
        belts: canonical_belts,
        rotation,
        mirror: mirror.to_owned(),
        recipe_overrides,
    })
}

fn valid_exported_at(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 24
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || bytes[10] != b'T'
        || bytes[13] != b':'
        || bytes[16] != b':'
        || bytes[19] != b'.'
        || bytes[23] != b'Z'
        || bytes.iter().enumerate().any(|(index, byte)| {
            !matches!(index, 4 | 7 | 10 | 13 | 16 | 19 | 23) && !byte.is_ascii_digit()
        })
    {
        return false;
    }
    let parse = |start: usize, end: usize| {
        bytes[start..end]
            .iter()
            .fold(0_u32, |value, byte| value * 10 + u32::from(byte - b'0'))
    };
    let year = parse(0, 4);
    let month = parse(5, 7);
    let day = parse(8, 10);
    let hour = parse(11, 13);
    let minute = parse(14, 16);
    let second = parse(17, 19);
    if year == 0 || !(1..=12).contains(&month) || hour > 23 || minute > 59 || second > 59 {
        return false;
    }
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let maximum_day = match month {
        2 if leap => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    };
    (1..=maximum_day).contains(&day)
}

fn parse_exchange(raw: &str) -> anyhow::Result<ParsedBlueprintExchange> {
    let value = parse_strict_json(raw)?;
    let envelope = required_object(&value, "exchange envelope")?;
    ensure_only_keys(
        envelope,
        &["type", "formatVersion", "exportedAt", "blueprint"],
        "exchange envelope",
    )?;
    if envelope.get("type").and_then(Value::as_str) != Some("dsp-idle-blueprint") {
        bail!("native blueprint import exchange type is invalid")
    }
    let format_version = safe_integer(
        envelope.get("formatVersion"),
        1,
        2,
        "exchange format version",
    )?;
    if !matches!(format_version, 1 | 2) {
        bail!("native blueprint import exchange format version is invalid")
    }
    if let Some(exported_at) = envelope.get("exportedAt") {
        let exported_at = exported_at
            .as_str()
            .filter(|value| valid_opaque_text(value, MAX_EXPORTED_AT_BYTES))
            .ok_or_else(|| anyhow!("native blueprint import exportedAt is invalid"))?;
        if !valid_exported_at(exported_at) {
            bail!("native blueprint import exportedAt is invalid")
        }
    }
    let blueprint = envelope
        .get("blueprint")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("native blueprint import blueprint is invalid"))?;
    parse_blueprint_object(blueprint, None)
}

fn active_import_planet_id(state: &CoreState) -> anyhow::Result<&str> {
    let active_planet_id = state
        .base_value()
        .get("activePlanetId")
        .and_then(Value::as_str)
        .filter(|value| valid_opaque_text(value, MAX_OPAQUE_ID_BYTES))
        .ok_or_else(|| anyhow!("native blueprint import active planet is invalid"))?;
    if !state
        .catalog
        .planets
        .iter()
        .any(|planet| planet.id == active_planet_id)
    {
        bail!("native blueprint import active planet is missing from the catalog")
    }
    Ok(active_planet_id)
}

pub(crate) fn blueprint_allocator_available(
    state: &CoreState,
    blueprints: &[&Map<String, Value>],
    versions: &[&Map<String, Value>],
    queue: &[&Map<String, Value>],
    blueprint_id: &str,
) -> bool {
    !state.entity_index.contains_key(blueprint_id)
        && !state.belt_index.contains_key(blueprint_id)
        && !blueprints
            .iter()
            .any(|row| row.get("id").and_then(Value::as_str) == Some(blueprint_id))
        && !versions.iter().any(|row| {
            row.get("id").and_then(Value::as_str) == Some(blueprint_id)
                || row.get("blueprintId").and_then(Value::as_str) == Some(blueprint_id)
        })
        && !queue.iter().any(|row| {
            row.get("id").and_then(Value::as_str) == Some(blueprint_id)
                || row.get("blueprintId").and_then(Value::as_str) == Some(blueprint_id)
                || row.get("blueprintVersionId").and_then(Value::as_str) == Some(blueprint_id)
        })
}

struct ImportAdmission {
    active_planet_id: String,
    next_id: u64,
    next_id_after: u64,
    library_len: usize,
    blueprint_id: String,
    blueprint_name: String,
}

enum ImportAdmissionResult {
    Supported(ImportAdmission),
    Unsupported(&'static str),
}

fn import_admission(state: &CoreState, source_name: &str) -> anyhow::Result<ImportAdmissionResult> {
    let base = state.base_value();
    let blueprint_values = base
        .get("blueprints")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("native blueprint import library is invalid"))?;
    let blueprints = validate_blueprint_directory(blueprint_values)?;
    let empty_versions = Vec::new();
    let version_values = match base.get("blueprintVersions") {
        None | Some(Value::Null) => &empty_versions,
        Some(Value::Array(values)) => values,
        _ => bail!("native blueprint import version directory is invalid"),
    };
    let queue_values = base
        .get("constructionQueue")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("native blueprint import queue directory is invalid"))?;
    let versions = validate_version_directory(version_values)?;
    let queue = validate_queue_directory(queue_values)?;
    let mut existing_names = HashSet::with_capacity(blueprints.len());
    for row in &blueprints {
        let name = row
            .get("name")
            .and_then(Value::as_str)
            .filter(|value| valid_opaque_text(value, 256))
            .ok_or_else(|| anyhow!("native blueprint import library name is invalid"))?;
        existing_names.insert(name);
    }
    let blueprint_name = deterministic_import_name(source_name, &existing_names)?;
    let next_id = base
        .get("nextId")
        .and_then(Value::as_u64)
        .filter(|value| *value <= MAX_JAVASCRIPT_SAFE_INTEGER)
        .ok_or_else(|| anyhow!("native blueprint import next ID is invalid"))?;
    let Some(next_id_after) = next_id.checked_add(1) else {
        return Ok(ImportAdmissionResult::Unsupported("next-id-exhausted"));
    };
    if next_id_after > MAX_JAVASCRIPT_SAFE_INTEGER {
        return Ok(ImportAdmissionResult::Unsupported("next-id-exhausted"));
    }
    let blueprint_id = format!("blueprint_{next_id}");
    let allocator_available =
        blueprint_allocator_available(state, &blueprints, &versions, &queue, &blueprint_id);
    let active_planet_id = active_import_planet_id(state)?.to_owned();
    let active_planet = state
        .catalog
        .planets
        .iter()
        .find(|planet| planet.id == active_planet_id)
        .expect("native blueprint import active planet membership was validated");
    if active_planet.kind != "terrestrial" {
        return Ok(ImportAdmissionResult::Unsupported(
            "unsupported-active-planet",
        ));
    }
    if state.identity.registry_fingerprint
        != crate::command::EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT
        || state.catalog.snapshot.registry_fingerprint
            != crate::command::EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT
    {
        return Ok(ImportAdmissionResult::Unsupported(
            "unsupported-blueprint-domain",
        ));
    }
    if blueprints.len() >= MAX_BLUEPRINT_IMPORT_LIBRARY_ROWS {
        return Ok(ImportAdmissionResult::Unsupported("library-full"));
    }
    if !allocator_available {
        return Ok(ImportAdmissionResult::Unsupported("next-id-exhausted"));
    }
    Ok(ImportAdmissionResult::Supported(ImportAdmission {
        active_planet_id,
        next_id,
        next_id_after,
        library_len: blueprints.len(),
        blueprint_id,
        blueprint_name,
    }))
}

fn content_domain_reason(
    state: &CoreState,
    blueprint: &Map<String, Value>,
) -> Option<&'static str> {
    let entities = blueprint.get("entities")?.as_array()?;
    for value in entities {
        let entity = value.as_object()?;
        let building_id = entity.get("buildingId")?.as_str()?;
        if !builtin_content_id(building_id)
            || !crate::command::ordinary_placement_building_domain_supported(building_id)
        {
            return Some("unsupported-blueprint-domain");
        }
        if !state.catalog.buildings.contains_key(building_id) {
            return Some("catalog-incomplete");
        }
        for key in ["recipeId", "storedItemId", "fuelItemId"] {
            if let Some(id) = entity.get(key).and_then(Value::as_str) {
                if !builtin_content_id(id) {
                    return Some("unsupported-blueprint-domain");
                }
                let exists = if key == "recipeId" {
                    state.catalog.recipes.contains_key(id)
                } else {
                    state.catalog.items.contains_key(id)
                };
                if !exists {
                    return Some("catalog-incomplete");
                }
            }
        }
    }
    let belts = blueprint.get("belts")?.as_array()?;
    for value in belts {
        let item_id = value.get("itemId")?.as_str()?;
        if !builtin_content_id(item_id) {
            return Some("unsupported-blueprint-domain");
        }
        if !state.catalog.items.contains_key(item_id) {
            return Some("catalog-incomplete");
        }
    }
    let overrides = blueprint.get("recipeOverrides")?.as_object()?;
    for (source, target) in overrides {
        let target = target.as_str()?;
        if !builtin_content_id(source) || !builtin_content_id(target) {
            return Some("unsupported-blueprint-domain");
        }
        if !state.catalog.recipes.contains_key(source)
            || !state.catalog.recipes.contains_key(target)
        {
            return Some("catalog-incomplete");
        }
    }
    None
}

fn marker_value(marker: &BlueprintImportMarker) -> Value {
    json!({
        "kind": "import",
        "sourceName": marker.source_name,
        "blueprint": marker.blueprint,
        "blueprintSha256": marker.blueprint_sha256,
        "revision": marker.revision,
    })
}

fn command_with_marker(revision: u64, marker: Value) -> SimulationCommandPatch {
    SimulationCommandPatch {
        protocol_version: crate::CORE_PROTOCOL_VERSION,
        base_revision: revision,
        top_level_changes: vec![ValuePatch {
            path: vec![
                PathSegment::Key("blueprints".to_owned()),
                PathSegment::Key("intent".to_owned()),
            ],
            operation: "set".to_owned(),
            value: Some(marker),
        }],
        changed_entities: Vec::new(),
        added_entities: Vec::new(),
        removed_entity_ids: Vec::new(),
        changed_belts: Vec::new(),
        added_belts: Vec::new(),
        removed_belt_ids: Vec::new(),
    }
}

fn validate_prepared_blueprint(
    state: &CoreState,
    blueprint: &Value,
    active_planet_id: &str,
) -> anyhow::Result<Option<&'static str>> {
    let blueprint = blueprint
        .as_object()
        .ok_or_else(|| anyhow!("native blueprint import prepared blueprint is invalid"))?;
    if let Some(reason) = content_domain_reason(state, blueprint) {
        return Ok(Some(reason));
    }
    if !ordinary_blueprint_definition_supported_on_planet(state, blueprint, active_planet_id)? {
        return Ok(Some("catalog-incomplete"));
    }
    if !ordinary_blueprint_definition_has_no_internal_overlap(blueprint)? {
        return Ok(Some("position-overlap"));
    }
    Ok(None)
}

pub(crate) fn parse_import_marker(
    intent: &Map<String, Value>,
) -> anyhow::Result<BlueprintImportMarker> {
    if intent.len() != 5
        || intent.get("kind").and_then(Value::as_str) != Some("import")
        || !intent.contains_key("sourceName")
        || !intent.contains_key("blueprint")
        || !intent.contains_key("blueprintSha256")
        || !intent.contains_key("revision")
    {
        bail!("native player-authority blueprint import intent is invalid")
    }
    let source_name = intent
        .get("sourceName")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            anyhow!("native player-authority blueprint import source name is invalid")
        })?;
    let source_name = canonical_source_name(source_name)?;
    let blueprint = intent
        .get("blueprint")
        .filter(|value| value.is_object())
        .cloned()
        .ok_or_else(|| anyhow!("native player-authority blueprint import body is invalid"))?;
    let blueprint_sha256 = intent
        .get("blueprintSha256")
        .and_then(Value::as_str)
        .filter(|value| {
            value.len() == 64
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        })
        .ok_or_else(|| anyhow!("native player-authority blueprint import hash is invalid"))?;
    if crate::canonical::canonical_sha256(&blueprint) != blueprint_sha256 {
        bail!("native player-authority blueprint import hash does not match")
    }
    if serde_json::to_vec(&blueprint)?.len() > MAX_BLUEPRINT_IMPORT_BYTES {
        bail!("native player-authority blueprint import body exceeds the byte limit")
    }
    let revision = intent
        .get("revision")
        .and_then(Value::as_u64)
        .filter(|value| *value < MAX_JAVASCRIPT_SAFE_INTEGER)
        .ok_or_else(|| anyhow!("native player-authority blueprint import revision is invalid"))?;
    Ok(BlueprintImportMarker {
        source_name,
        blueprint,
        blueprint_sha256: blueprint_sha256.to_owned(),
        revision,
    })
}

pub(crate) fn prepare_import_marker(
    state: &CoreState,
    marker: &BlueprintImportMarker,
) -> anyhow::Result<BlueprintImportPreparation> {
    let admission = match import_admission(state, &marker.source_name)? {
        ImportAdmissionResult::Supported(value) => value,
        ImportAdmissionResult::Unsupported(reason) => {
            return Ok(BlueprintImportPreparation::Unsupported(reason));
        }
    };
    let marker_blueprint = marker
        .blueprint
        .as_object()
        .ok_or_else(|| anyhow!("native blueprint import prepared blueprint is invalid"))?;
    ensure_only_keys(marker_blueprint, BLUEPRINT_KEYS, "prepared blueprint")?;
    if marker_blueprint.len() != BLUEPRINT_KEYS.len()
        || marker_blueprint.get("id").and_then(Value::as_str)
            != Some(admission.blueprint_id.as_str())
        || marker_blueprint.get("name").and_then(Value::as_str)
            != Some(admission.blueprint_name.as_str())
        || marker_blueprint.get("revision").and_then(Value::as_u64) != Some(1)
    {
        bail!("native blueprint import prepared identity is invalid")
    }
    let canonical = parse_blueprint_object(marker_blueprint, Some(&marker.source_name))?
        .into_blueprint(&admission.blueprint_id, &admission.blueprint_name);
    if canonical != marker.blueprint
        || crate::canonical::canonical_sha256(&canonical) != marker.blueprint_sha256
    {
        bail!("native blueprint import prepared body is not canonical")
    }
    if let Some(reason) =
        validate_prepared_blueprint(state, &marker.blueprint, &admission.active_planet_id)?
    {
        return Ok(BlueprintImportPreparation::Unsupported(reason));
    }
    let marker_value = marker_value(marker);
    let command_bytes =
        serde_json::to_vec(&command_with_marker(marker.revision, marker_value.clone()))?.len();
    if command_bytes > MAX_BLUEPRINT_IMPORT_COMMAND_BYTES {
        return Ok(BlueprintImportPreparation::Unsupported(
            "serialized-budget-exceeded",
        ));
    }
    Ok(BlueprintImportPreparation::Supported {
        plan: BlueprintImportPlan {
            expected_next_id: admission.next_id,
            expected_library_len: admission.library_len,
            blueprint: marker.blueprint.clone(),
            next_id_after: admission.next_id_after,
        },
        marker: marker_value,
    })
}

impl CoreState {
    pub fn blueprint_import_context_projection(
        &self,
        expected_revision: u64,
        expected_registry_fingerprint: &str,
        raw: &str,
    ) -> anyhow::Result<Value> {
        if expected_revision != self.revision
            || expected_revision >= MAX_JAVASCRIPT_SAFE_INTEGER
            || expected_registry_fingerprint != self.catalog.snapshot.registry_fingerprint
            || raw.is_empty()
            || raw.len() > MAX_BLUEPRINT_IMPORT_BYTES
        {
            bail!("native blueprint import context request is invalid")
        }
        // Validate state directories and the active planet even for malformed
        // renderer text. Corrupt authoritative state must never be disguised as
        // an ordinary unsupported import.
        let active_planet_id = active_import_planet_id(self)?.to_owned();
        // This preflight is intentionally independent of renderer JSON. It
        // forces every authoritative directory, allocator and name source to
        // validate before a malformed exchange can become `support=false`.
        let _ = import_admission(self, "导入蓝图")?;
        let raw_sha256 = sha256_bytes(raw.as_bytes());
        let parsed = parse_exchange(raw);
        let (supported, reason, prepared_intent) = match parsed {
            Err(_) => (false, Value::from("invalid-exchange"), Value::Null),
            Ok(parsed) => {
                let admission = match import_admission(self, &parsed.source_name)? {
                    ImportAdmissionResult::Supported(value) => value,
                    ImportAdmissionResult::Unsupported(reason) => {
                        let value = context_value(
                            self,
                            expected_revision,
                            expected_registry_fingerprint,
                            raw.len(),
                            &raw_sha256,
                            &active_planet_id,
                            false,
                            Value::from(reason),
                            Value::Null,
                        )?;
                        return Ok(value);
                    }
                };
                let source_name = parsed.source_name.clone();
                let blueprint =
                    parsed.into_blueprint(&admission.blueprint_id, &admission.blueprint_name);
                if let Some(reason) =
                    validate_prepared_blueprint(self, &blueprint, &admission.active_planet_id)?
                {
                    (false, Value::from(reason), Value::Null)
                } else {
                    let marker = BlueprintImportMarker {
                        source_name,
                        blueprint_sha256: crate::canonical::canonical_sha256(&blueprint),
                        blueprint,
                        revision: expected_revision,
                    };
                    match prepare_import_marker(self, &marker)? {
                        BlueprintImportPreparation::Supported { marker, .. } => {
                            (true, Value::Null, marker)
                        }
                        BlueprintImportPreparation::Unsupported(reason) => {
                            (false, Value::from(reason), Value::Null)
                        }
                    }
                }
            }
        };
        context_value(
            self,
            expected_revision,
            expected_registry_fingerprint,
            raw.len(),
            &raw_sha256,
            &active_planet_id,
            supported,
            reason,
            prepared_intent,
        )
    }

    pub fn blueprint_export_context_projection(
        &self,
        expected_revision: u64,
        expected_registry_fingerprint: &str,
        blueprint_id: &str,
        blueprint_revision: u64,
    ) -> anyhow::Result<Value> {
        if expected_revision != self.revision
            || expected_revision > MAX_JAVASCRIPT_SAFE_INTEGER
            || expected_registry_fingerprint != self.catalog.snapshot.registry_fingerprint
            || !valid_opaque_text(blueprint_id, MAX_OPAQUE_ID_BYTES)
            || blueprint_revision == 0
            || blueprint_revision > MAX_JAVASCRIPT_SAFE_INTEGER
        {
            bail!("native blueprint export context request is invalid")
        }
        let active_planet_id = active_import_planet_id(self)?.to_owned();
        let blueprint_values = self
            .base_value()
            .get("blueprints")
            .and_then(Value::as_array)
            .ok_or_else(|| anyhow!("native blueprint export library is invalid"))?;
        let blueprints = validate_blueprint_directory(blueprint_values)?;
        let version_values: &[Value] = match self.base_value().get("blueprintVersions") {
            None | Some(Value::Null) => &[],
            Some(Value::Array(values)) => values.as_slice(),
            _ => bail!("native blueprint export versions are invalid"),
        };
        let queue_values = self
            .base_value()
            .get("constructionQueue")
            .and_then(Value::as_array)
            .ok_or_else(|| anyhow!("native blueprint export queue is invalid"))?;
        let versions = validate_version_directory(version_values)?;
        let queue = validate_queue_directory(queue_values)?;
        // The selected library row is the owning object. Immutable versions
        // and queue rows may legitimately refer to it through `blueprintId`,
        // but no independent object ID may reuse it. Export is read-only, yet
        // accepting an ambiguous owner would bind bytes to the wrong durable
        // object after cold replay or allocator repair.
        let ambiguous_owner = self.entity_index.contains_key(blueprint_id)
            || self.belt_index.contains_key(blueprint_id)
            || versions
                .iter()
                .any(|row| row.get("id").and_then(Value::as_str) == Some(blueprint_id))
            || queue.iter().any(|row| {
                row.get("id").and_then(Value::as_str) == Some(blueprint_id)
                    || row.get("blueprintVersionId").and_then(Value::as_str) == Some(blueprint_id)
            });
        if ambiguous_owner {
            return export_context_value(
                self,
                expected_revision,
                expected_registry_fingerprint,
                blueprint_id,
                blueprint_revision,
                &active_planet_id,
                false,
                Value::from("version-conflict"),
                None,
            );
        }
        let mut target = None;
        for row in blueprints {
            if row.get("id").and_then(Value::as_str) == Some(blueprint_id) {
                if target.is_some() {
                    bail!("native blueprint export target is not unique")
                }
                target = Some(row);
            }
        }
        let Some(target) = target else {
            return export_context_value(
                self,
                expected_revision,
                expected_registry_fingerprint,
                blueprint_id,
                blueprint_revision,
                &active_planet_id,
                false,
                Value::from("version-conflict"),
                None,
            );
        };
        let current_revision = match target.get("revision") {
            None | Some(Value::Null) => 1,
            Some(value) => value
                .as_u64()
                .filter(|value| *value > 0 && *value <= MAX_JAVASCRIPT_SAFE_INTEGER)
                .ok_or_else(|| anyhow!("native blueprint export revision is invalid"))?,
        };
        if current_revision != blueprint_revision {
            return export_context_value(
                self,
                expected_revision,
                expected_registry_fingerprint,
                blueprint_id,
                blueprint_revision,
                &active_planet_id,
                false,
                Value::from("version-conflict"),
                None,
            );
        }
        let active_planet = self
            .catalog
            .planets
            .iter()
            .find(|planet| planet.id == active_planet_id)
            .expect("native blueprint export active planet membership was validated");
        if active_planet.kind != "terrestrial" {
            return export_context_value(
                self,
                expected_revision,
                expected_registry_fingerprint,
                blueprint_id,
                blueprint_revision,
                &active_planet_id,
                false,
                Value::from("unsupported-active-planet"),
                None,
            );
        }
        if self.identity.registry_fingerprint
            != crate::command::EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT
            || self.catalog.snapshot.registry_fingerprint
                != crate::command::EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT
        {
            return export_context_value(
                self,
                expected_revision,
                expected_registry_fingerprint,
                blueprint_id,
                blueprint_revision,
                &active_planet_id,
                false,
                Value::from("unsupported-blueprint-domain"),
                None,
            );
        }
        let source_name = target
            .get("name")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow!("native blueprint export name is invalid"))?;
        let source_name = canonical_source_name(source_name)?;
        let canonical_source = match canonical_export_source(target) {
            Ok(value) => value,
            Err(_) => {
                return export_context_value(
                    self,
                    expected_revision,
                    expected_registry_fingerprint,
                    blueprint_id,
                    blueprint_revision,
                    &active_planet_id,
                    false,
                    Value::from("unsupported-blueprint-domain"),
                    None,
                );
            }
        };
        let canonical_source = canonical_source
            .as_object()
            .expect("canonical export source is an object");
        let parsed = match parse_blueprint_object(canonical_source, Some(&source_name)) {
            Ok(value) => value,
            Err(_) => {
                return export_context_value(
                    self,
                    expected_revision,
                    expected_registry_fingerprint,
                    blueprint_id,
                    blueprint_revision,
                    &active_planet_id,
                    false,
                    Value::from("unsupported-blueprint-domain"),
                    None,
                );
            }
        };
        let canonical =
            parsed.into_blueprint_with_revision(blueprint_id, &source_name, blueprint_revision);
        if let Some(reason) = validate_prepared_blueprint(self, &canonical, &active_planet_id)? {
            return export_context_value(
                self,
                expected_revision,
                expected_registry_fingerprint,
                blueprint_id,
                blueprint_revision,
                &active_planet_id,
                false,
                Value::from(reason),
                None,
            );
        }
        let Some(raw_exchange) = serialize_export_exchange(&canonical)? else {
            return export_context_value(
                self,
                expected_revision,
                expected_registry_fingerprint,
                blueprint_id,
                blueprint_revision,
                &active_planet_id,
                false,
                Value::from("serialized-budget-exceeded"),
                None,
            );
        };
        let raw_sha256 = sha256_bytes(raw_exchange.as_bytes());
        export_context_value(
            self,
            expected_revision,
            expected_registry_fingerprint,
            blueprint_id,
            blueprint_revision,
            &active_planet_id,
            true,
            Value::Null,
            Some(ExportPayload {
                raw_exchange,
                raw_sha256,
                blueprint_name: source_name.clone(),
                file_name_stem: safe_file_stem(&source_name),
            }),
        )
    }
}

struct ExportPayload {
    raw_exchange: String,
    raw_sha256: String,
    blueprint_name: String,
    file_name_stem: String,
}

#[allow(clippy::too_many_arguments)]
fn export_context_value(
    state: &CoreState,
    expected_revision: u64,
    expected_registry_fingerprint: &str,
    blueprint_id: &str,
    blueprint_revision: u64,
    active_planet_id: &str,
    supported: bool,
    reason: Value,
    payload: Option<ExportPayload>,
) -> anyhow::Result<Value> {
    if supported != payload.is_some() {
        bail!("native blueprint export context payload state is inconsistent")
    }
    let (raw_exchange, raw_bytes, raw_sha256, blueprint_name, file_name_stem) = match payload {
        Some(payload) => (
            Value::from(payload.raw_exchange.clone()),
            Value::from(payload.raw_exchange.len()),
            Value::from(payload.raw_sha256),
            Value::from(payload.blueprint_name),
            Value::from(payload.file_name_stem),
        ),
        None => (
            Value::Null,
            Value::Null,
            Value::Null,
            Value::Null,
            Value::Null,
        ),
    };
    let value = json!({
        "schemaVersion": 1,
        "projectionType": BLUEPRINT_EXPORT_CONTEXT_PROJECTION,
        "source": "native-core",
        "revision": state.revision,
        "stateVersion": state.identity.state_version,
        "registryFingerprint": state.catalog.snapshot.registry_fingerprint,
        "request": {
            "expectedRevision": expected_revision,
            "expectedRegistryFingerprint": expected_registry_fingerprint,
            "blueprintId": blueprint_id,
            "blueprintRevision": blueprint_revision,
        },
        "activePlanetId": active_planet_id,
        "support": {
            "supported": supported,
            "reason": reason,
        },
        "rawExchange": raw_exchange,
        "rawBytes": raw_bytes,
        "rawSha256": raw_sha256,
        "blueprintName": blueprint_name,
        "fileNameStem": file_name_stem,
        "limits": {
            "exchangeBytes": MAX_BLUEPRINT_IMPORT_BYTES,
            "projectionBytes": MAX_BLUEPRINT_IMPORT_BYTES,
            "blueprintEntities": MAX_BLUEPRINT_IMPORT_ENTITIES,
            "blueprintBelts": MAX_BLUEPRINT_IMPORT_BELTS,
        },
    });
    if serde_json::to_vec(&value)?.len() > MAX_BLUEPRINT_IMPORT_BYTES {
        if supported {
            return export_context_value(
                state,
                expected_revision,
                expected_registry_fingerprint,
                blueprint_id,
                blueprint_revision,
                active_planet_id,
                false,
                Value::from("serialized-budget-exceeded"),
                None,
            );
        }
        bail!("native blueprint export context exceeds the byte limit")
    }
    Ok(value)
}

#[allow(clippy::too_many_arguments)]
fn context_value(
    state: &CoreState,
    expected_revision: u64,
    expected_registry_fingerprint: &str,
    raw_bytes: usize,
    raw_sha256: &str,
    active_planet_id: &str,
    supported: bool,
    reason: Value,
    prepared_intent: Value,
) -> anyhow::Result<Value> {
    let value = json!({
        "schemaVersion": 1,
        "projectionType": BLUEPRINT_IMPORT_CONTEXT_PROJECTION,
        "source": "native-core",
        "revision": state.revision,
        "stateVersion": state.identity.state_version,
        "registryFingerprint": state.catalog.snapshot.registry_fingerprint,
        "request": {
            "expectedRevision": expected_revision,
            "expectedRegistryFingerprint": expected_registry_fingerprint,
            "rawBytes": raw_bytes,
            "rawSha256": raw_sha256,
        },
        "activePlanetId": active_planet_id,
        "support": {
            "supported": supported,
            "reason": reason,
        },
        "preparedIntent": prepared_intent,
        "limits": {
            "rawBytes": MAX_BLUEPRINT_IMPORT_BYTES,
            "projectionBytes": MAX_BLUEPRINT_IMPORT_BYTES,
            "commandBytes": MAX_BLUEPRINT_IMPORT_COMMAND_BYTES,
            "libraryRows": MAX_BLUEPRINT_IMPORT_LIBRARY_ROWS,
            "blueprintEntities": MAX_BLUEPRINT_IMPORT_ENTITIES,
            "blueprintBelts": MAX_BLUEPRINT_IMPORT_BELTS,
        },
    });
    if serde_json::to_vec(&value)?.len() > MAX_BLUEPRINT_IMPORT_BYTES {
        if supported {
            return context_value(
                state,
                expected_revision,
                expected_registry_fingerprint,
                raw_bytes,
                raw_sha256,
                active_planet_id,
                false,
                Value::from("serialized-budget-exceeded"),
                Value::Null,
            );
        }
        bail!("native blueprint import context exceeds the byte limit")
    }
    Ok(value)
}

#[cfg(test)]
pub(crate) fn export_projection_budget_probe(
    state: &CoreState,
    raw_bytes: usize,
) -> anyhow::Result<Value> {
    export_context_value(
        state,
        state.revision,
        &state.catalog.snapshot.registry_fingerprint,
        "budget_probe",
        1,
        state
            .base_value()
            .get("activePlanetId")
            .and_then(Value::as_str)
            .unwrap_or("invalid"),
        true,
        Value::Null,
        Some(ExportPayload {
            raw_exchange: "x".repeat(raw_bytes),
            raw_sha256: "0".repeat(64),
            blueprint_name: "预算探针".to_owned(),
            file_name_stem: "预算探针".to_owned(),
        }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blueprint_import_math_round_matches_ecmascript_at_half_adjacent_values() {
        let positive_half = 0.5_f64;
        let positive_below = f64::from_bits(positive_half.to_bits() - 1);
        let positive_above = f64::from_bits(positive_half.to_bits() + 1);
        assert_eq!(js_round(positive_below), 0.0);
        assert_eq!(js_round(positive_half), 1.0);
        assert_eq!(js_round(positive_above), 1.0);

        let negative_half = -0.5_f64;
        let negative_above = f64::from_bits(negative_half.to_bits() - 1);
        let negative_below = f64::from_bits(negative_half.to_bits() + 1);
        assert_eq!(js_round(negative_below), -1.0);
        assert_eq!(js_round(negative_above), -0.0);
        assert!(js_round(negative_above).is_sign_negative());
        assert_eq!(js_round(negative_half), -0.0);
        assert!(js_round(negative_half).is_sign_negative());
        assert_eq!(js_round(-0.0), -0.0);
        assert!(js_round(-0.0).is_sign_negative());
    }

    #[test]
    fn blueprint_import_offset_uses_node_stable_integer_zero_after_ecmascript_rounding() {
        let canonical =
            canonical_offset(Some(&json!({ "x": -0.0, "y": -0.5 })), "test offset").unwrap();
        assert_eq!(canonical, json!({ "x": 0, "y": 0 }));
        assert_eq!(
            serde_json::to_string(&canonical).unwrap(),
            r#"{"x":0,"y":0}"#
        );
    }

    #[test]
    fn blueprint_import_exported_at_is_strict_utc_millisecond_calendar_time() {
        for valid in [
            "2026-09-01T00:00:00.000Z",
            "2000-02-29T23:59:59.999Z",
            "2024-02-29T12:34:56.789Z",
        ] {
            assert!(valid_exported_at(valid), "{valid}");
        }
        for invalid in [
            "not-a-date",
            "2026-13-01T00:00:00.000Z",
            "2026-02-29T00:00:00.000Z",
            "1900-02-29T00:00:00.000Z",
            "2026-09-31T00:00:00.000Z",
            "2026-09-01T24:00:00.000Z",
            "2026-09-01T00:60:00.000Z",
            "2026-09-01T00:00:60.000Z",
            "2026-09-01T00:00:00.000+08:00",
            "2026-09-01T00:00:00.000Ztail",
        ] {
            assert!(!valid_exported_at(invalid), "{invalid}");
        }
    }

    #[test]
    fn blueprint_export_file_stem_handles_windows_devices_extensions_and_trailing_characters() {
        assert_eq!(safe_file_stem("CON"), "_CON");
        assert_eq!(safe_file_stem("con.txt"), "_con.txt");
        assert_eq!(safe_file_stem("AUX.foo"), "_AUX.foo");
        assert_eq!(safe_file_stem("COM1.bar"), "_COM1.bar");
        assert_eq!(safe_file_stem("LPT9"), "_LPT9");
        for prefix in ["COM", "LPT"] {
            for digit in ["¹", "²", "³"] {
                assert_eq!(
                    safe_file_stem(&format!("{prefix}{digit}")),
                    format!("_{prefix}{digit}")
                );
                assert_eq!(
                    safe_file_stem(&format!("{prefix}{digit}.json")),
                    format!("_{prefix}{digit}.json")
                );
            }
        }
        assert_eq!(safe_file_stem("COM¹ .json"), "_COM¹ .json");
        assert_eq!(safe_file_stem("COM0.txt"), "COM0.txt");
        assert_eq!(safe_file_stem("COM⁴.txt"), "COM⁴.txt");
        assert_eq!(
            safe_file_stem(&format!("COM¹.{}", "x".repeat(75))),
            format!("_COM¹.{}", "x".repeat(74))
        );
        assert_eq!(safe_file_stem(" 报告.  "), "报告");
        assert_eq!(safe_file_stem("<>:\"/\\|?*"), "_________");
        assert_eq!(safe_file_stem("...   "), "blueprint");

        let seventy_nine = "a".repeat(79);
        assert_eq!(
            safe_file_stem(&format!("{seventy_nine}.suffix")),
            seventy_nine
        );
        let seventy_eight = "a".repeat(78);
        assert_eq!(
            safe_file_stem(&format!("{seventy_eight}🚀suffix")),
            format!("{seventy_eight}🚀")
        );
        assert_eq!(safe_file_stem(&format!("{seventy_nine}🚀")), seventy_nine);
    }

    #[test]
    fn blueprint_export_exchange_serializer_accepts_exact_limit_and_rejects_just_over() {
        let empty = json!({ "padding": "" });
        let overhead = serialize_export_exchange(&empty).unwrap().unwrap().len();
        let exact = json!({ "padding": "x".repeat(MAX_BLUEPRINT_IMPORT_BYTES - overhead) });
        let exact = serialize_export_exchange(&exact).unwrap().unwrap();
        assert_eq!(exact.len(), MAX_BLUEPRINT_IMPORT_BYTES);

        let over = json!({
            "padding": "x".repeat(MAX_BLUEPRINT_IMPORT_BYTES - overhead + 1)
        });
        assert!(serialize_export_exchange(&over).unwrap().is_none());
    }
}
