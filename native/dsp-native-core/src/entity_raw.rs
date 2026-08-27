use std::sync::Arc;

use anyhow::{Context, bail};
use serde_json::Value;

use crate::deterministic_runtime::{DeterministicRuntime, runtime as deterministic_runtime};
use crate::state::ExactRowIds;

#[derive(Debug)]
pub(crate) struct EntityRawEncodeResult {
    records: Vec<Arc<str>>,
    inventory_entry_count: usize,
    shared_rows: usize,
}

impl EntityRawEncodeResult {
    pub(crate) fn into_parts(self) -> (Vec<Arc<str>>, usize, usize) {
        (self.records, self.inventory_entry_count, self.shared_rows)
    }
}

/// Deterministically serializes every simulated entity through the shared
/// process-lifetime worker pool. Results retain input order, and a row whose
/// encoded bytes are unchanged reuses the authoritative Arc rather than
/// allocating a replacement record.
pub(crate) fn encode_entity_records_full(
    entities: &[Value],
    previous: &[Arc<str>],
    expected_ids: &ExactRowIds,
) -> anyhow::Result<EntityRawEncodeResult> {
    encode_entity_records_with(deterministic_runtime(), entities, previous, expected_ids)
}

fn encode_entity_records_with(
    runtime: &DeterministicRuntime,
    entities: &[Value],
    previous: &[Arc<str>],
    expected_ids: &ExactRowIds,
) -> anyhow::Result<EntityRawEncodeResult> {
    if entities.len() != previous.len() || entities.len() != expected_ids.len() {
        bail!("native entity full encode topology changed");
    }
    let encoded = runtime.indexed_try_map(entities, |index, entity| {
        let object = entity.as_object().ok_or_else(|| {
            anyhow::anyhow!("native simulated entity is not an object at index {index}")
        })?;
        if object.get("id").and_then(Value::as_str) != Some(&expected_ids[index]) {
            bail!("native simulation changed entity identity at index {index}");
        }
        let inventory_entry_count = ["inputs", "outputs"]
            .into_iter()
            .filter_map(|key| object.get(key).and_then(Value::as_object))
            .try_fold(0_usize, |total, inventory| {
                total
                    .checked_add(inventory.len())
                    .ok_or_else(|| anyhow::anyhow!("native entity inventory entry count overflow"))
            })?;
        let encoded = serde_json::to_string(entity)
            .with_context(|| format!("encode native simulated entity at index {index}"))?;
        let raw = if encoded.as_str() == previous[index].as_ref() {
            previous[index].clone()
        } else {
            Arc::<str>::from(encoded)
        };
        Ok((raw, inventory_entry_count))
    })?;

    let mut records = Vec::with_capacity(encoded.len());
    let mut inventory_entry_count = 0_usize;
    let mut shared_rows = 0_usize;
    for (index, (raw, row_inventory_entry_count)) in encoded.into_iter().enumerate() {
        inventory_entry_count = inventory_entry_count
            .checked_add(row_inventory_entry_count)
            .ok_or_else(|| anyhow::anyhow!("native entity inventory entry count overflow"))?;
        shared_rows += usize::from(Arc::ptr_eq(&raw, &previous[index]));
        records.push(raw);
    }
    Ok(EntityRawEncodeResult {
        records,
        inventory_entry_count,
        shared_rows,
    })
}

#[cfg(test)]
pub(crate) fn json_bitwise_eq(left: &Value, right: &Value) -> bool {
    match (left, right) {
        (Value::Null, Value::Null) => true,
        (Value::Bool(left), Value::Bool(right)) => left == right,
        (Value::Number(left), Value::Number(right)) => {
            if left.is_f64() || right.is_f64() {
                left.is_f64()
                    && right.is_f64()
                    && left
                        .as_f64()
                        .zip(right.as_f64())
                        .is_some_and(|(left, right)| left.to_bits() == right.to_bits())
            } else {
                left == right
            }
        }
        (Value::String(left), Value::String(right)) => left == right,
        (Value::Array(left), Value::Array(right)) => {
            left.len() == right.len()
                && left
                    .iter()
                    .zip(right)
                    .all(|(left, right)| json_bitwise_eq(left, right))
        }
        (Value::Object(left), Value::Object(right)) => {
            left.len() == right.len()
                && left.iter().all(|(key, left)| {
                    right
                        .get(key)
                        .is_some_and(|right| json_bitwise_eq(left, right))
                })
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::deterministic_runtime::PARALLEL_MIN_ITEMS;
    use serde_json::{Map, json};

    fn exact_ids(entities: &[Value]) -> ExactRowIds {
        ExactRowIds::from_boxed(
            entities
                .iter()
                .map(|entity| entity["id"].as_str().unwrap().into())
                .collect(),
            "test entity",
        )
        .unwrap()
    }

    fn next_random(seed: &mut u64) -> u64 {
        *seed = seed
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        *seed
    }

    fn random_leaf(seed: &mut u64, index: usize) -> Value {
        match next_random(seed) % 6 {
            0 => Value::Null,
            1 => Value::Bool(next_random(seed).is_multiple_of(2)),
            2 => Value::from(-0.0),
            3 => serde_json::from_str("1.25e-7").unwrap(),
            4 => Value::from((next_random(seed) >> 11) as i64),
            _ => Value::from(format!("mod-\\\"-{index}-{}", next_random(seed))),
        }
    }

    fn random_value(seed: &mut u64, index: usize, depth: usize) -> Value {
        if depth == 0 {
            return random_leaf(seed, index);
        }
        match next_random(seed) % 4 {
            0 => random_leaf(seed, index),
            1 => Value::Array(
                (0..(next_random(seed) % 4) as usize)
                    .map(|slot| random_value(seed, index + slot, depth - 1))
                    .collect(),
            ),
            _ => {
                let mut object = Map::new();
                for slot in 0..(next_random(seed) % 4) as usize {
                    object.insert(
                        format!("mod-key-{index}-{slot}"),
                        random_value(seed, index + slot, depth - 1),
                    );
                }
                Value::Object(object)
            }
        }
    }

    #[test]
    fn full_encode_matches_bitwise_value_oracle_for_2048_random_entities() {
        let mut seed = 0x5eed_e7f0_11e0_c0de_u64;
        let entities = (0_usize..2_048)
            .map(|index| {
                let mut object = Map::from_iter([
                    ("id".to_owned(), Value::from(format!("random-{index}"))),
                    ("kind".to_owned(), Value::from("mod-entity")),
                    ("planetId".to_owned(), Value::from("home")),
                ]);
                for key in [
                    "progress",
                    "inputs",
                    "outputs",
                    "stationLastSupplyPeerBySlot",
                    "blackHolePorts",
                    "modPayload",
                ] {
                    if !next_random(&mut seed).is_multiple_of(3) {
                        object.insert(key.to_owned(), random_value(&mut seed, index, 3));
                    }
                }
                Value::Object(object)
            })
            .collect::<Vec<_>>();
        let previous = (0..entities.len())
            .map(|_| Arc::<str>::from("{}"))
            .collect::<Vec<_>>();
        let expected_ids = exact_ids(&entities);
        let encoded = encode_entity_records_with(
            &DeterministicRuntime::for_test(8),
            &entities,
            &previous,
            &expected_ids,
        )
        .unwrap();
        let (encoded, inventory_entry_count, shared_rows) = encoded.into_parts();
        let expected_inventory_entry_count = entities
            .iter()
            .map(|entity| {
                ["inputs", "outputs"]
                    .into_iter()
                    .filter_map(|key| entity.get(key).and_then(Value::as_object))
                    .map(Map::len)
                    .sum::<usize>()
            })
            .sum::<usize>();
        assert_eq!(inventory_entry_count, expected_inventory_entry_count);
        assert_eq!(shared_rows, 0);

        for (index, (raw, expected)) in encoded.iter().zip(&entities).enumerate() {
            assert_eq!(raw.as_ref(), serde_json::to_string(expected).unwrap());
            let actual: Value = serde_json::from_str(raw).unwrap();
            assert!(json_bitwise_eq(&actual, expected), "index={index}");
        }
    }

    #[test]
    fn full_encode_is_ordered_and_byte_shares_across_worker_limits() {
        let rows = PARALLEL_MIN_ITEMS + 257;
        let entities = (0..rows)
            .map(|index| {
                json!({
                    "id":format!("entity-{index}"),
                    "progress":if index.is_multiple_of(17) {-0.0} else {index as f64},
                    "modPayload":{"nested":[index,true,null]}
                })
            })
            .collect::<Vec<_>>();
        let previous = entities
            .iter()
            .map(|entity| Arc::<str>::from(serde_json::to_string(entity).unwrap()))
            .collect::<Vec<_>>();
        let expected_ids = exact_ids(&entities);

        for workers in [1, 2, 4, 8] {
            let encoded = encode_entity_records_with(
                &DeterministicRuntime::for_test(workers),
                &entities,
                &previous,
                &expected_ids,
            )
            .unwrap();
            let (encoded, inventory_entry_count, shared_rows) = encoded.into_parts();
            assert_eq!(inventory_entry_count, 0);
            assert_eq!(shared_rows, rows);
            assert!(
                encoded
                    .iter()
                    .zip(&previous)
                    .all(|(actual, expected)| Arc::ptr_eq(actual, expected))
            );
            for (index, raw) in encoded.iter().enumerate() {
                let value: Value = serde_json::from_str(raw).unwrap();
                assert_eq!(value["id"], format!("entity-{index}"));
            }
        }

        let mut changed = entities.clone();
        changed[17]["progress"] = Value::from(99.0);
        let encoded = encode_entity_records_with(
            &DeterministicRuntime::for_test(8),
            &changed,
            &previous,
            &expected_ids,
        )
        .unwrap();
        let (encoded, inventory_entry_count, shared_rows) = encoded.into_parts();
        assert_eq!(inventory_entry_count, 0);
        assert_eq!(shared_rows, rows - 1);
        assert!(!Arc::ptr_eq(&encoded[17], &previous[17]));
        assert!(
            encoded
                .iter()
                .enumerate()
                .all(|(index, raw)| { index == 17 || Arc::ptr_eq(raw, &previous[index]) })
        );
    }

    #[test]
    fn full_encode_keeps_last_wins_mod_and_negative_zero_semantics() {
        let raw = Arc::<str>::from(
            r#"{"id":"dup","progress":1,"pro\u0067ress":-0.0,"inputs":{"mod-item":1e3},"modPayload":{"nested":[true,{"keep":"yes"}]}}"#,
        );
        let entity: Value = serde_json::from_str(&raw).unwrap();
        let expected_ids = exact_ids(std::slice::from_ref(&entity));
        let encoded = encode_entity_records_with(
            &DeterministicRuntime::for_test(1),
            std::slice::from_ref(&entity),
            std::slice::from_ref(&raw),
            &expected_ids,
        )
        .unwrap();
        let (encoded, inventory_entry_count, shared_rows) = encoded.into_parts();
        assert_eq!(inventory_entry_count, 1);
        assert_eq!(shared_rows, 0);
        assert!(!Arc::ptr_eq(&encoded[0], &raw));
        assert_eq!(encoded[0].matches("\"progress\":").count(), 1);
        assert!(!encoded[0].contains(r#"pro\u0067ress"#));
        let actual: Value = serde_json::from_str(&encoded[0]).unwrap();
        assert!(json_bitwise_eq(&actual, &entity));
        assert_eq!(
            actual["progress"].as_f64().unwrap().to_bits(),
            (-0.0_f64).to_bits()
        );
        assert_eq!(actual["inputs"]["mod-item"], 1_000.0);
        assert_eq!(actual["modPayload"]["nested"][1]["keep"], "yes");
    }

    #[test]
    fn full_encode_fuses_identity_and_inventory_evidence_in_worker_order() {
        let rows = PARALLEL_MIN_ITEMS + 97;
        let entities = (0..rows)
            .map(|index| {
                json!({
                    "id":format!("mod-entity-{index}"),
                    "inputs":if index.is_multiple_of(3) {
                        json!({"iron":index,"null-entry":null})
                    } else {
                        Value::Null
                    },
                    "outputs":if index.is_multiple_of(5) {
                        json!({"mod-output":-0.0})
                    } else {
                        json!([])
                    },
                    "modPayload":{"missingIsPreserved":true}
                })
            })
            .collect::<Vec<_>>();
        let expected_ids = exact_ids(&entities);
        let previous = entities
            .iter()
            .map(|entity| Arc::<str>::from(serde_json::to_string(entity).unwrap()))
            .collect::<Vec<_>>();
        let expected_inventory_entry_count = entities
            .iter()
            .map(|entity| {
                ["inputs", "outputs"]
                    .into_iter()
                    .filter_map(|key| entity.get(key).and_then(Value::as_object))
                    .map(Map::len)
                    .sum::<usize>()
            })
            .sum::<usize>();

        for workers in [1, 2, 4, 8] {
            let result = encode_entity_records_with(
                &DeterministicRuntime::for_test(workers),
                &entities,
                &previous,
                &expected_ids,
            )
            .unwrap();
            let (records, inventory_entry_count, shared_rows) = result.into_parts();
            assert_eq!(inventory_entry_count, expected_inventory_entry_count);
            assert_eq!(shared_rows, rows);
            assert!(
                records
                    .iter()
                    .zip(&previous)
                    .all(|(actual, expected)| Arc::ptr_eq(actual, expected))
            );
        }

        let mut wrong_first = entities.clone();
        wrong_first[17]["id"] = Value::from("forged-17");
        wrong_first[PARALLEL_MIN_ITEMS]["id"] = Value::from("forged-late");
        for workers in [1, 2, 4, 8] {
            let error = encode_entity_records_with(
                &DeterministicRuntime::for_test(workers),
                &wrong_first,
                &previous,
                &expected_ids,
            )
            .unwrap_err();
            assert!(error.to_string().contains("index 17"));
        }
    }
}
