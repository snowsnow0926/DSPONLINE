use sha2::{Digest, Sha256};

use serde_json::{Map, Value};

/// Hashes JSON with object keys sorted recursively. Arrays preserve their
/// persisted order. This is the cross-language checkpoint oracle used by
/// shadow mode; it is intentionally independent from Rust map iteration.
pub fn canonical_sha256(value: &Value) -> String {
    let mut hasher = Sha256::new();
    update_canonical(&mut hasher, value);
    hex::encode(hasher.finalize())
}

pub fn update_canonical(hasher: &mut Sha256, value: &Value) {
    match value {
        Value::Null => hasher.update(b"null"),
        Value::Bool(true) => hasher.update(b"true"),
        Value::Bool(false) => hasher.update(b"false"),
        Value::Number(number) => {
            if let Some(value) = number.as_i64() {
                hasher.update(value.to_string().as_bytes());
            } else if let Some(value) = number.as_u64() {
                hasher.update(value.to_string().as_bytes());
            } else if let Some(value) = number.as_f64() {
                // serde_json/ryu follows Rust's display thresholds, while the
                // JavaScript authority uses ECMAScript Number::toString.
                // ryu-js keeps the canonical digest byte-identical at values
                // such as 1e-7, 1e20 and negative zero.
                let mut buffer = ryu_js::Buffer::new();
                hasher.update(buffer.format_finite(value).as_bytes());
            }
        }
        Value::String(text) => {
            let encoded = serde_json::to_string(text).expect("JSON string serialization");
            hasher.update(encoded.as_bytes());
        }
        Value::Array(values) => {
            hasher.update(b"[");
            for (index, value) in values.iter().enumerate() {
                if index > 0 {
                    hasher.update(b",");
                }
                update_canonical(hasher, value);
            }
            hasher.update(b"]");
        }
        Value::Object(object) => update_canonical_object(hasher, object),
    }
}

pub fn update_canonical_object(hasher: &mut Sha256, object: &Map<String, Value>) {
    hasher.update(b"{");
    let mut keys = object.keys().collect::<Vec<_>>();
    keys.sort_unstable();
    for (index, key) in keys.iter().enumerate() {
        if index > 0 {
            hasher.update(b",");
        }
        let encoded = serde_json::to_string(key).expect("JSON key serialization");
        hasher.update(encoded.as_bytes());
        hasher.update(b":");
        update_canonical(hasher, &object[*key]);
    }
    hasher.update(b"}");
}

pub fn fnv1a_utf8(bytes: &[u8]) -> String {
    let mut hash = 0x811c9dc5_u32;
    for byte in bytes {
        hash ^= u32::from(*byte);
        hash = hash.wrapping_mul(0x01000193);
    }
    format!("{hash:08x}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn canonical_hash_ignores_object_insertion_order() {
        let left = json!({"b": [2, {"z": true, "a": null}], "a": 1});
        let right = json!({"a": 1, "b": [2, {"a": null, "z": true}]});
        assert_eq!(canonical_sha256(&left), canonical_sha256(&right));
    }

    #[test]
    fn fnv_matches_public_chunk_checksum_contract() {
        assert_eq!(fnv1a_utf8("中文🙂".as_bytes()), "f02a36cb");
    }

    #[test]
    fn json_float_parsing_and_formatting_match_javascript_exactly() {
        // This value sits on a parser-sensitive boundary in the real 77 MB
        // player save. serde_json's float_roundtrip feature is mandatory: the
        // default fast parser selected the adjacent IEEE-754 value and caused
        // a false native-shadow divergence.
        let value = serde_json::from_str::<Value>("0.9297819999999999").unwrap();
        let number = value.as_f64().unwrap();
        let mut buffer = ryu_js::Buffer::new();
        assert_eq!(buffer.format_finite(number), "0.9297819999999999");
    }
}
