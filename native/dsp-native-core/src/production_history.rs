use std::cmp::Ordering;
use std::collections::BTreeMap;

use anyhow::{anyhow, bail};
use serde_json::{Map, Value};

use crate::state::CoreState;

const EPSILON: f64 = 0.0001;
const SAMPLE_SECONDS: f64 = 1.0;
const RECENT_FINE_SECONDS: f64 = 70.0;
const RECENT_MEDIUM_SECONDS: f64 = 660.0;
const HISTORY_RETENTION_SECONDS: f64 = 3_660.0;

fn rounded(value: f64, digits: i32) -> f64 {
    let scale = 10_f64.powi(digits);
    (value * scale).round() / scale
}

fn finite_number(value: Option<&Value>) -> Option<f64> {
    value
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
}

fn sample_duration(sample: &Value) -> f64 {
    finite_number(sample.get("sampleDurationSeconds"))
        .filter(|value| *value > 0.0)
        .map(|value| value.round().max(1.0))
        .unwrap_or(10.0)
}

fn add_rate(target: &mut BTreeMap<String, f64>, item: &str, amount: f64) {
    target.insert(
        item.to_owned(),
        rounded(target.get(item).copied().unwrap_or(0.0) + amount, 2),
    );
}

fn rates_to_value(values: BTreeMap<String, f64>) -> Value {
    Value::Object(
        values
            .into_iter()
            .map(|(key, value)| (key, Value::from(value)))
            .collect(),
    )
}

fn clone_object(value: Option<&Value>) -> Map<String, Value> {
    value
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default()
}

fn metric_sum(base: &Map<String, Value>, key: &str) -> f64 {
    base.get("planetMetrics")
        .and_then(Value::as_object)
        .map(|metrics| {
            metrics
                .values()
                .filter_map(Value::as_object)
                .filter_map(|metric| finite_number(metric.get(key)))
                .sum()
        })
        .unwrap_or(0.0)
}

fn delivered_power(base: &Map<String, Value>) -> f64 {
    base.get("planetMetrics")
        .and_then(Value::as_object)
        .map(|metrics| {
            metrics
                .values()
                .filter_map(Value::as_object)
                .map(|metric| {
                    finite_number(metric.get("demandKw")).unwrap_or(0.0)
                        * finite_number(metric.get("powerFactor")).unwrap_or(0.0)
                })
                .sum()
        })
        .unwrap_or(0.0)
}

fn inventory_from_planet_trays(base: &Map<String, Value>) -> Value {
    let mut inventory = BTreeMap::new();
    if let Some(trays) = base.get("planetTrays").and_then(Value::as_object) {
        for tray in trays.values().filter_map(Value::as_object) {
            for (item, amount) in tray {
                if let Some(amount) = finite_number(Some(amount)) {
                    add_rate(&mut inventory, item, amount.floor());
                }
            }
        }
    }
    rates_to_value(inventory)
}

fn merge_rate_records(samples: &[Value], key: &str, duration: f64) -> Value {
    let mut weighted = BTreeMap::<String, f64>::new();
    for sample in samples {
        let weight = sample_duration(sample);
        if let Some(record) = sample.get(key).and_then(Value::as_object) {
            for (item, value) in record {
                if let Some(value) = finite_number(Some(value)) {
                    *weighted.entry(item.clone()).or_default() += value * weight;
                }
            }
        }
    }
    Value::Object(
        weighted
            .into_iter()
            .map(|(item, value)| (item, Value::from(rounded(value / duration, 6))))
            .collect(),
    )
}

fn merge_planet_rate_records(samples: &[Value], key: &str, duration: f64) -> Value {
    let mut weighted = BTreeMap::<String, BTreeMap<String, f64>>::new();
    for sample in samples {
        let weight = sample_duration(sample);
        if let Some(planets) = sample.get(key).and_then(Value::as_object) {
            for (planet, values) in planets {
                let Some(values) = values.as_object() else {
                    continue;
                };
                let target = weighted.entry(planet.clone()).or_default();
                for (item, value) in values {
                    if let Some(value) = finite_number(Some(value)) {
                        *target.entry(item.clone()).or_default() += value * weight;
                    }
                }
            }
        }
    }
    Value::Object(
        weighted
            .into_iter()
            .map(|(planet, values)| {
                let values = values
                    .into_iter()
                    .map(|(item, value)| (item, Value::from(rounded(value / duration, 6))))
                    .collect();
                (planet, Value::Object(values))
            })
            .collect(),
    )
}

fn weighted_optional(samples: &[Value], key: &str, duration: f64) -> Option<f64> {
    let mut total = 0.0;
    let mut covered = 0.0;
    for sample in samples {
        let Some(value) = finite_number(sample.get(key)) else {
            continue;
        };
        let weight = sample_duration(sample);
        total += value * weight;
        covered += weight;
    }
    (covered > 0.0).then(|| rounded(total / duration.min(covered), 4))
}

fn merge_samples(samples: &[Value]) -> anyhow::Result<Value> {
    if samples.is_empty() {
        bail!("native production history bucket is empty");
    }
    let duration = samples.iter().map(sample_duration).sum::<f64>();
    let latest = samples.last().expect("non-empty history bucket");
    let latest_number = |key: &str| finite_number(latest.get(key)).unwrap_or(0.0);
    let active = weighted_optional(samples, "activeMachines", duration)
        .unwrap_or_else(|| latest_number("activeMachines"))
        .round()
        .max(0.0);
    let blocked = weighted_optional(samples, "blockedMachines", duration)
        .unwrap_or_else(|| latest_number("blockedMachines"))
        .round()
        .max(0.0);
    Ok(serde_json::json!({
        "elapsedSeconds": latest_number("elapsedSeconds"),
        "sampleDurationSeconds": duration,
        "productionPerMinute": merge_rate_records(samples, "productionPerMinute", duration),
        "consumptionPerMinute": merge_rate_records(samples, "consumptionPerMinute", duration),
        "planetProductionPerMinute": merge_planet_rate_records(samples, "planetProductionPerMinute", duration),
        "planetConsumptionPerMinute": merge_planet_rate_records(samples, "planetConsumptionPerMinute", duration),
        "inventory": clone_object(latest.get("inventory")),
        "generationKw": weighted_optional(samples, "generationKw", duration).unwrap_or_else(|| latest_number("generationKw")),
        "demandKw": weighted_optional(samples, "demandKw", duration).unwrap_or_else(|| latest_number("demandKw")),
        "machineEfficiency": weighted_optional(samples, "machineEfficiency", duration),
        "logisticsEfficiency": weighted_optional(samples, "logisticsEfficiency", duration),
        "powerEfficiency": weighted_optional(samples, "powerEfficiency", duration),
        "activeMachines": active,
        "blockedMachines": blocked,
    }))
}

fn compact_buckets_before(
    history: &mut Vec<Value>,
    cutoff_elapsed_seconds: f64,
    target_duration_seconds: f64,
) -> anyhow::Result<()> {
    loop {
        let Some(start) = history.iter().position(|sample| {
            finite_number(sample.get("elapsedSeconds")).unwrap_or(0.0) <= cutoff_elapsed_seconds
                && sample_duration(sample) < target_duration_seconds
        }) else {
            return Ok(());
        };
        let mut duration = 0.0;
        let mut end = start;
        while end < history.len()
            && finite_number(history[end].get("elapsedSeconds")).unwrap_or(0.0)
                <= cutoff_elapsed_seconds
            && sample_duration(&history[end]) < target_duration_seconds
            && duration < target_duration_seconds
        {
            duration += sample_duration(&history[end]);
            end += 1;
        }
        if end - start < 2 || duration < target_duration_seconds {
            return Ok(());
        }
        let merged = merge_samples(&history[start..end])?;
        history.splice(start..end, [merged]);
    }
}

fn compact_history(history: &mut Vec<Value>) -> anyhow::Result<()> {
    history.sort_by(|left, right| {
        finite_number(left.get("elapsedSeconds"))
            .unwrap_or(0.0)
            .partial_cmp(&finite_number(right.get("elapsedSeconds")).unwrap_or(0.0))
            .unwrap_or(Ordering::Equal)
    });
    let latest = history
        .last()
        .and_then(|sample| finite_number(sample.get("elapsedSeconds")))
        .unwrap_or(0.0);
    compact_buckets_before(history, latest - RECENT_FINE_SECONDS, 10.0)?;
    compact_buckets_before(
        history,
        latest - RECENT_FINE_SECONDS - RECENT_MEDIUM_SECONDS,
        60.0,
    )?;
    let mut retained = history.iter().map(sample_duration).sum::<f64>();
    while history.len() > 1 && retained > HISTORY_RETENTION_SECONDS {
        retained -= sample_duration(&history[0]);
        history.remove(0);
    }
    Ok(())
}

impl CoreState {
    pub(crate) fn record_quiescent_production_history(&mut self) -> anyhow::Result<()> {
        if !self.entity_index.is_empty() || !self.belt_index.is_empty() {
            bail!("native quiescent history requires an empty factory");
        }
        let base = self.base_value_mut();
        let elapsed = finite_number(base.get("elapsedSeconds")).unwrap_or(0.0);
        let recorded = finite_number(base.get("historyRecordedAt")).unwrap_or(0.0);
        if elapsed - recorded < SAMPLE_SECONDS - EPSILON {
            return Ok(());
        }
        let duration = SAMPLE_SECONDS.max(elapsed - recorded);
        let history = base
            .get("productionHistory")
            .and_then(Value::as_array)
            .cloned()
            .ok_or_else(|| anyhow!("native production history is missing"))?;
        let previous = history.last();
        let previous_boundary = ((elapsed - duration).max(0.0) / 10.0).floor();
        let current_boundary = (elapsed.max(0.0) / 10.0).floor();
        let refresh =
            previous.is_none() || duration >= 10.0 || previous_boundary != current_boundary;
        let inventory = if refresh {
            inventory_from_planet_trays(base)
        } else {
            Value::Object(clone_object(
                previous.and_then(|sample| sample.get("inventory")),
            ))
        };
        let generation = metric_sum(base, "generationKw");
        let demand = metric_sum(base, "demandKw");
        let delivered = delivered_power(base);
        let previous_number =
            |key: &str| previous.and_then(|sample| finite_number(sample.get(key)));
        let sample = serde_json::json!({
            "elapsedSeconds": elapsed,
            "sampleDurationSeconds": duration,
            "productionPerMinute": {},
            "consumptionPerMinute": {},
            "planetProductionPerMinute": {},
            "planetConsumptionPerMinute": {},
            "inventory": inventory,
            "generationKw": rounded(generation, 2),
            "demandKw": rounded(demand, 2),
            "machineEfficiency": if refresh { 0.0 } else { previous_number("machineEfficiency").unwrap_or(0.0) },
            "logisticsEfficiency": if refresh { 0.0 } else { previous_number("logisticsEfficiency").unwrap_or(0.0) },
            "powerEfficiency": rounded(if demand > 0.0 { (delivered / demand).min(1.0) } else { 1.0 }, 4),
            "activeMachines": if refresh { 0.0 } else { previous_number("activeMachines").unwrap_or(0.0).floor().max(0.0) },
            "blockedMachines": if refresh { 0.0 } else { previous_number("blockedMachines").unwrap_or(0.0).floor().max(0.0) },
        });
        let mut next = history;
        next.push(sample);
        compact_history(&mut next)?;
        base.insert("productionHistory".to_owned(), Value::Array(next));
        base.insert("historyRecordedAt".to_owned(), Value::from(elapsed));
        Ok(())
    }
}
