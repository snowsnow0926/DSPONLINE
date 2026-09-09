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
    visit_canonical(value, &mut |bytes| hasher.update(bytes));
}

/// Feed the same canonical bytes to independent digest streams without
/// sorting keys, formatting numbers or escaping strings a second time.
pub(crate) fn update_canonical_pair(first: &mut Sha256, second: &mut Sha256, value: &Value) {
    visit_canonical(value, &mut |bytes| {
        first.update(bytes);
        second.update(bytes);
    });
}

fn visit_canonical(value: &Value, emit: &mut impl FnMut(&[u8])) {
    match value {
        Value::Null => emit(b"null"),
        Value::Bool(true) => emit(b"true"),
        Value::Bool(false) => emit(b"false"),
        Value::Number(number) => {
            if let Some(value) = number.as_i64() {
                emit(value.to_string().as_bytes());
            } else if let Some(value) = number.as_u64() {
                emit(value.to_string().as_bytes());
            } else if let Some(value) = number.as_f64() {
                // serde_json/ryu follows Rust's display thresholds, while the
                // JavaScript authority uses ECMAScript Number::toString.
                // ryu-js keeps the canonical digest byte-identical at values
                // such as 1e-7, 1e20 and negative zero.
                let mut buffer = ryu_js::Buffer::new();
                emit(buffer.format_finite(value).as_bytes());
            }
        }
        Value::String(text) => {
            let encoded = serde_json::to_string(text).expect("JSON string serialization");
            emit(encoded.as_bytes());
        }
        Value::Array(values) => {
            emit(b"[");
            for (index, value) in values.iter().enumerate() {
                if index > 0 {
                    emit(b",");
                }
                visit_canonical(value, emit);
            }
            emit(b"]");
        }
        Value::Object(object) => visit_canonical_object(object, emit),
    }
}

pub fn update_canonical_object(hasher: &mut Sha256, object: &Map<String, Value>) {
    visit_canonical_object(object, &mut |bytes| hasher.update(bytes));
}

fn visit_canonical_object(object: &Map<String, Value>, emit: &mut impl FnMut(&[u8])) {
    emit(b"{");
    let mut keys = object.keys().collect::<Vec<_>>();
    keys.sort_unstable();
    for (index, key) in keys.iter().enumerate() {
        if index > 0 {
            emit(b",");
        }
        let encoded = serde_json::to_string(key).expect("JSON key serialization");
        emit(encoded.as_bytes());
        emit(b":");
        visit_canonical(&object[*key], emit);
    }
    emit(b"}");
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
    fn paired_streams_match_independent_canonical_bytes_with_distinct_prefixes() {
        let value: Value = serde_json::from_str(
            r#"{"z":"中文🙂\\\"\n","a":[null,true,false,-0.0,1e-7,1e20,1e21,9007199254740991],"nested":{"β":"\t","a":3}}"#,
        )
        .unwrap();
        // An explicit byte oracle, independent of either canonical visitor.
        let expected = r#"{"a":[null,true,false,0,1e-7,100000000000000000000,1e+21,9007199254740991],"nested":{"a":3,"β":"\t"},"z":"中文🙂\\\"\n"}"#;
        let mut full = Sha256::new();
        let mut component = Sha256::new();
        full.update(b"{\"entities\":[");
        component.update(b"[");
        update_canonical_pair(&mut full, &mut component, &value);
        full.update(b"]}");
        component.update(b"]");
        let expected_full = format!("{{\"entities\":[{expected}]}}");
        let expected_component = format!("[{expected}]");
        assert_eq!(full.finalize(), Sha256::digest(expected_full.as_bytes()));
        assert_eq!(
            component.finalize(),
            Sha256::digest(expected_component.as_bytes())
        );
        assert_eq!(
            canonical_sha256(&value),
            hex::encode(Sha256::digest(expected))
        );
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
