use std::cmp::Ordering;
use std::collections::{BTreeMap, HashMap, HashSet};

use anyhow::{anyhow, bail};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::belts::{BeltFlowRequirement, PreparedBeltFlow};
use crate::deterministic_runtime::{DeterministicRuntime, runtime as deterministic_runtime};
use crate::state::CoreState;

const EPSILON: f64 = 0.0001;
const SAMPLE_SECONDS: f64 = 1.0;
const RECENT_FINE_SECONDS: f64 = 70.0;
const RECENT_MEDIUM_SECONDS: f64 = 660.0;
const HISTORY_RETENTION_SECONDS: f64 = 3_660.0;
const TIERED_MINUTE_SECONDS: f64 = 60.0;
const TIERED_TEN_MINUTE_SECONDS: f64 = 600.0;
const TIERED_HOUR_SECONDS: f64 = 3_600.0;
const TIERED_HISTORY_RETENTION_SECONDS: f64 = 24.0 * TIERED_HOUR_SECONDS;
const TIERED_HISTORY_SIDECAR_FORMAT_VERSION: u16 = 1;
const MAX_TIERED_HISTORY_SIDECAR_SAMPLES: usize = 32;

#[derive(Debug, Clone, Copy)]
struct ProductionHistoryBoundary {
    elapsed: f64,
    duration: f64,
    refresh: bool,
}

type RateAccumulator = HashMap<String, f64>;
type PlanetRateAccumulator = HashMap<String, RateAccumulator>;

fn rounded(value: f64, digits: i32) -> f64 {
    let scale = 10_f64.powi(digits);
    (value * scale).round() / scale
}

fn finite_number(value: Option<&Value>) -> Option<f64> {
    value
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
}

fn production_history_boundary(
    base: &Map<String, Value>,
) -> anyhow::Result<Option<ProductionHistoryBoundary>> {
    let elapsed = finite_number(base.get("elapsedSeconds")).unwrap_or(0.0);
    let recorded = finite_number(base.get("historyRecordedAt")).unwrap_or(0.0);
    if elapsed - recorded < SAMPLE_SECONDS - EPSILON {
        return Ok(None);
    }
    let duration = SAMPLE_SECONDS.max(elapsed - recorded);
    let history = base
        .get("productionHistory")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("native production history is missing"))?;
    let previous_boundary = ((elapsed - duration).max(0.0) / 10.0).floor();
    let current_boundary = (elapsed.max(0.0) / 10.0).floor();
    Ok(Some(ProductionHistoryBoundary {
        elapsed,
        duration,
        refresh: history.is_empty() || duration >= 10.0 || previous_boundary != current_boundary,
    }))
}

pub(crate) fn belt_flow_requirement(
    base: &Map<String, Value>,
) -> anyhow::Result<BeltFlowRequirement> {
    Ok(
        if production_history_boundary(base)?.is_some_and(|boundary| boundary.refresh) {
            BeltFlowRequirement::ExactOriginalOrder
        } else {
            BeltFlowRequirement::NotRequired
        },
    )
}

fn sample_duration(sample: &Value) -> f64 {
    finite_number(sample.get("sampleDurationSeconds"))
        .filter(|value| *value > 0.0)
        .map(|value| value.round().max(1.0))
        .unwrap_or(10.0)
}

fn add_rate(target: &mut RateAccumulator, item: &str, amount: f64) {
    if let Some(value) = target.get_mut(item) {
        *value = rounded(*value + amount, 2);
    } else {
        // Preserve the legacy accumulator's exact IEEE-754 semantics. In
        // particular, `0.0 + -0.0` produces positive zero whereas rounding
        // `amount` directly would retain negative zero and change canonical
        // save bytes even though the numeric values compare equal.
        target.insert(item.to_owned(), rounded(0.0 + amount, 2));
    }
}

fn add_planet_rate(target: &mut PlanetRateAccumulator, planet: &str, item: &str, amount: f64) {
    if let Some(values) = target.get_mut(planet) {
        add_rate(values, item, amount);
    } else {
        let mut values = RateAccumulator::new();
        add_rate(&mut values, item, amount);
        target.insert(planet.to_owned(), values);
    }
}

#[allow(clippy::too_many_arguments)]
fn add_history_entity_rates<'a>(
    state: &'a CoreState,
    index: usize,
    entity: &Map<String, Value>,
    kind: &str,
    planet: &str,
    building: &str,
    recipe_cache: &mut HashMap<u32, Option<&'a crate::catalog::RecipeDefinition>>,
    production: &mut RateAccumulator,
    consumption: &mut RateAccumulator,
    planet_production: &mut PlanetRateAccumulator,
    planet_consumption: &mut PlanetRateAccumulator,
) {
    let rate = finite_number(entity.get("productionRate")).unwrap_or(0.0);
    if kind == "vein" {
        let Some(resource) = state.symbols.resolve(state.entities.resources[index]) else {
            return;
        };
        add_rate(production, resource, rate);
        add_planet_rate(planet_production, planet, resource, rate);
    } else if building == "orbital_collector" {
        let Some(item_id) = state.symbols.resolve(state.entities.stored_items[index]) else {
            return;
        };
        add_rate(production, item_id, rate);
        add_planet_rate(planet_production, planet, item_id, rate);
    } else if kind == "machine" {
        let recipe_symbol = state.entities.recipes[index];
        let Some(recipe) = *recipe_cache.entry(recipe_symbol).or_insert_with(|| {
            state
                .symbols
                .resolve(recipe_symbol)
                .and_then(|id| state.catalog.recipes.get(id))
        }) else {
            return;
        };
        for input in &recipe.inputs {
            let amount = rate * input.amount;
            add_rate(consumption, &input.item_id, amount);
            add_planet_rate(planet_consumption, planet, &input.item_id, amount);
        }
        for output in &recipe.outputs {
            let amount = rate * output.amount;
            add_rate(production, &output.item_id, amount);
            add_planet_rate(planet_production, planet, &output.item_id, amount);
        }
    }
}

fn rates_to_value(values: RateAccumulator) -> Value {
    let mut entries = values.into_iter().collect::<Vec<_>>();
    // Hash iteration order is deliberately irrelevant to both simulation and
    // persistence. Sort explicitly before materializing JSON so this remains
    // byte-identical to the former BTreeMap accumulator even if serde_json's
    // map backend changes in a future dependency update.
    entries.sort_unstable_by(|left, right| left.0.cmp(&right.0));
    Value::Object(
        entries
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

fn metric_sum(base: &Map<String, Value>, planet_ids: &[&str], key: &str) -> f64 {
    base.get("planetMetrics")
        .and_then(Value::as_object)
        .map(|metrics| {
            planet_ids
                .iter()
                .filter_map(|planet_id| metrics.get(*planet_id))
                .filter_map(Value::as_object)
                .filter_map(|metric| finite_number(metric.get(key)))
                .sum()
        })
        .unwrap_or(0.0)
}

fn delivered_power(base: &Map<String, Value>, planet_ids: &[&str]) -> f64 {
    base.get("planetMetrics")
        .and_then(Value::as_object)
        .map(|metrics| {
            planet_ids
                .iter()
                .filter_map(|planet_id| metrics.get(*planet_id))
                .filter_map(Value::as_object)
                .map(|metric| {
                    finite_number(metric.get("demandKw")).unwrap_or(0.0)
                        * finite_number(metric.get("powerFactor")).unwrap_or(0.0)
                })
                .sum()
        })
        .unwrap_or(0.0)
}

fn planet_rates_to_value(values: PlanetRateAccumulator) -> Value {
    let mut entries = values.into_iter().collect::<Vec<_>>();
    entries.sort_unstable_by(|left, right| left.0.cmp(&right.0));
    Value::Object(
        entries
            .into_iter()
            .map(|(planet, values)| (planet, rates_to_value(values)))
            .collect(),
    )
}

fn normalized_buffer_limit(value: Option<&Value>) -> f64 {
    value
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
        .unwrap_or(1_000_000.0)
        .floor()
        .clamp(1_000.0, 100_000_000.0)
}

fn stacked_capacity(base: f64, count: f64, limit: f64) -> f64 {
    let base = base.max(0.0).floor();
    let count = count.floor().max(1.0);
    if base == 0.0 {
        0.0
    } else if base > limit / count {
        limit
    } else {
        (base * count).min(limit)
    }
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

fn split_sample_at_duration(
    sample: &Value,
    prefix_duration: f64,
    previous_inventory: Option<&Value>,
) -> anyhow::Result<(Value, Value)> {
    let duration = sample_duration(sample);
    if prefix_duration <= 0.0 || prefix_duration >= duration {
        bail!("native production history split duration is invalid");
    }
    let elapsed = finite_number(sample.get("elapsedSeconds"))
        .ok_or_else(|| anyhow!("native production history sample elapsed time is invalid"))?;
    let mut prefix = sample.clone();
    let mut suffix = sample.clone();
    let prefix_object = prefix
        .as_object_mut()
        .ok_or_else(|| anyhow!("native production history sample is invalid"))?;
    prefix_object.insert(
        "elapsedSeconds".to_owned(),
        Value::from(elapsed - duration + prefix_duration),
    );
    prefix_object.insert(
        "sampleDurationSeconds".to_owned(),
        Value::from(prefix_duration),
    );
    // Inventory is an endpoint snapshot, not a rate. The source sample only
    // proves its inventory at the end of the complete interval, so copying it
    // into an earlier split would make a statistics query observe the future.
    // Use the latest snapshot known at or before the prefix boundary instead.
    prefix_object.insert(
        "inventory".to_owned(),
        Value::Object(clone_object(previous_inventory)),
    );
    suffix
        .as_object_mut()
        .ok_or_else(|| anyhow!("native production history sample is invalid"))?
        .insert(
            "sampleDurationSeconds".to_owned(),
            Value::from(duration - prefix_duration),
        );
    Ok((prefix, suffix))
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

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TieredHistorySource {
    public_len: usize,
    history_recorded_at_bits: u64,
    latest_elapsed_bits: Option<u64>,
    latest_duration_bits: Option<u64>,
}

/// Private desktop-only cache payload. It is intentionally independent from
/// public v47 state and the authoritative checkpoint manifest: losing or
/// rejecting it may shorten the visible diagnostic window, but can never
/// change gameplay state or prevent recovery.
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TieredHistorySidecar {
    format_version: u16,
    source: TieredHistorySource,
    cold_samples: Vec<Value>,
}

fn validate_sidecar_timeline(
    cold_samples: &[Value],
    public_start: f64,
    public_end: f64,
) -> anyhow::Result<()> {
    let mut first_start: Option<f64> = None;
    let mut previous_elapsed: Option<f64> = None;
    for sample in cold_samples {
        let elapsed = finite_number(sample.get("elapsedSeconds"))
            .filter(|value| *value >= 0.0)
            .ok_or_else(|| anyhow!("native production history sidecar sample is invalid"))?;
        let duration = finite_number(sample.get("sampleDurationSeconds"))
            .filter(|value| *value > 0.0 && *value <= elapsed + EPSILON)
            .ok_or_else(|| anyhow!("native production history sidecar duration is invalid"))?;
        let start = elapsed - duration;
        if !start.is_finite() || start < -EPSILON {
            bail!("native production history sidecar start is invalid");
        }
        if let Some(previous) = previous_elapsed
            && (start - previous).abs() > EPSILON
        {
            bail!("native production history sidecar timeline is not contiguous");
        }
        first_start.get_or_insert(start.max(0.0));
        previous_elapsed = Some(elapsed);
    }
    let first_start = first_start
        .ok_or_else(|| anyhow!("native production history sidecar timeline is empty"))?;
    let cold_end = previous_elapsed.expect("non-empty sidecar timeline has an end");
    if (cold_end - public_start).abs() > EPSILON {
        bail!("native production history sidecar boundary is stale");
    }
    let restored_window = public_end - first_start;
    if !restored_window.is_finite()
        || !(-EPSILON..=TIERED_HISTORY_RETENTION_SECONDS + EPSILON).contains(&restored_window)
    {
        bail!("native production history sidecar retention window is invalid");
    }
    Ok(())
}

fn tiered_history_source(
    base: &Map<String, Value>,
) -> anyhow::Result<(TieredHistorySource, &[Value])> {
    let history = match base.get("productionHistory") {
        Some(Value::Array(history)) => history.as_slice(),
        Some(_) => bail!("native production history is invalid"),
        None => &[],
    };
    let latest = history.last();
    for sample in history {
        if !sample.is_object() || finite_number(sample.get("elapsedSeconds")).is_none() {
            bail!("native production history sample is invalid");
        }
    }
    let latest_elapsed = latest.and_then(|sample| finite_number(sample.get("elapsedSeconds")));
    let recorded = finite_number(base.get("historyRecordedAt"))
        .or(latest_elapsed)
        .or_else(|| finite_number(base.get("elapsedSeconds")))
        .unwrap_or(0.0);
    Ok((
        TieredHistorySource {
            public_len: history.len(),
            history_recorded_at_bits: recorded.to_bits(),
            latest_elapsed_bits: latest_elapsed.map(f64::to_bits),
            latest_duration_bits: latest.map(sample_duration).map(f64::to_bits),
        },
        history,
    ))
}

fn compact_tiered_buckets_before(
    history: &mut Vec<Value>,
    cutoff_elapsed_seconds: f64,
    target_duration_seconds: f64,
) -> anyhow::Result<()> {
    let mut start = 0;
    while start < history.len() {
        let source_is_eligible = |sample: &Value| {
            finite_number(sample.get("elapsedSeconds")).unwrap_or(f64::INFINITY)
                <= cutoff_elapsed_seconds
                && sample_duration(sample) < target_duration_seconds
        };
        if !source_is_eligible(&history[start]) {
            start += 1;
            continue;
        }
        let mut duration = 0.0;
        let mut end = start;
        while end < history.len() && source_is_eligible(&history[end]) {
            let next_duration = sample_duration(&history[end]);
            if duration + next_duration <= target_duration_seconds {
                duration += next_duration;
                end += 1;
            } else {
                // Publications can cover 1, 4, 5, 12, or more simulation
                // seconds. Split only the private diagnostic sample at the
                // promotion boundary so its weighted rates remain exact and
                // promoted durations never drift to 64/604/3604 seconds.
                let needed = target_duration_seconds - duration;
                let previous_inventory = end
                    .checked_sub(1)
                    .and_then(|index| history.get(index))
                    .and_then(|sample| sample.get("inventory"))
                    .cloned();
                let (prefix, suffix) =
                    split_sample_at_duration(&history[end], needed, previous_inventory.as_ref())?;
                history.splice(end..=end, [prefix, suffix]);
                duration = target_duration_seconds;
                end += 1;
            }
            if duration >= target_duration_seconds {
                break;
            }
        }
        if duration < target_duration_seconds {
            start += 1;
            continue;
        }
        let merged = merge_samples(&history[start..end])?;
        history.splice(start..end, [merged]);
        start += 1;
    }
    Ok(())
}

fn compact_tiered_history(history: &mut Vec<Value>) -> anyhow::Result<()> {
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
    compact_tiered_buckets_before(
        history,
        latest - TIERED_MINUTE_SECONDS,
        TIERED_MINUTE_SECONDS,
    )?;
    compact_tiered_buckets_before(
        history,
        latest - TIERED_TEN_MINUTE_SECONDS,
        TIERED_TEN_MINUTE_SECONDS,
    )?;
    compact_tiered_buckets_before(history, latest - TIERED_HOUR_SECONDS, TIERED_HOUR_SECONDS)?;
    let mut retained = history.iter().map(sample_duration).sum::<f64>();
    while history.len() > 1
        && retained - sample_duration(&history[0]) >= TIERED_HISTORY_RETENTION_SECONDS
    {
        retained -= sample_duration(&history[0]);
        history.remove(0);
    }
    Ok(())
}

/// Private, runtime-only statistics index. It is rebuilt from the public v47
/// history on open and is deliberately excluded from public serialization,
/// canonical hashes, checkpoints, and migrations. Consequently the JS
/// authority keeps its established 1/10/60-second history bytes while native
/// statistics can query bounded 1-second/1-minute/10-minute/1-hour tiers.
#[derive(Debug, Clone)]
pub(crate) struct TieredProductionHistory {
    samples: Vec<Value>,
    source: Option<TieredHistorySource>,
    available: bool,
    dirty: bool,
}

impl TieredProductionHistory {
    pub(crate) fn from_base(base: &Map<String, Value>) -> Self {
        let Ok((source, history)) = tiered_history_source(base) else {
            return Self {
                samples: Vec::new(),
                source: None,
                available: false,
                dirty: false,
            };
        };
        let mut samples = history.to_vec();
        let available = compact_tiered_history(&mut samples).is_ok();
        Self {
            samples: if available { samples } else { Vec::new() },
            source: available.then_some(source),
            available,
            dirty: false,
        }
    }

    pub(crate) fn refresh_from_base(&mut self, base: &Map<String, Value>) {
        *self = Self::from_base(base);
    }

    /// Fast path used only after the native simulator itself appended the
    /// public v47 sample. Commands and arbitrary base patches always rebuild
    /// this cache, so an edit to an older sample is never silently trusted.
    pub(crate) fn refresh_after_internal_sample(&mut self, base: &Map<String, Value>) {
        let Ok((source, public_history)) = tiered_history_source(base) else {
            self.samples.clear();
            self.source = None;
            self.available = false;
            self.dirty = false;
            return;
        };
        if self.available && self.source == Some(source) {
            self.dirty = false;
            return;
        }
        let append_latest = self.source.filter(|_| self.available).and_then(|previous| {
            let previous_recorded = f64::from_bits(previous.history_recorded_at_bits);
            let current_recorded = f64::from_bits(source.history_recorded_at_bits);
            let latest = public_history.last()?;
            let latest_elapsed = finite_number(latest.get("elapsedSeconds"))?;
            let latest_duration = sample_duration(latest);
            (current_recorded > previous_recorded + EPSILON
                && (latest_elapsed - current_recorded).abs() <= EPSILON
                && (current_recorded - previous_recorded - latest_duration).abs() <= EPSILON)
                .then(|| latest.clone())
        });
        if let Some(sample) = append_latest {
            self.samples.push(sample);
            if compact_tiered_history(&mut self.samples).is_ok() {
                self.source = Some(source);
                self.dirty = false;
                return;
            }
        }
        *self = Self::from_base(base);
    }

    pub(crate) fn invalidate(&mut self) {
        self.dirty = true;
    }

    pub(crate) fn samples_if_current<'a>(
        &'a self,
        base: &'a Map<String, Value>,
    ) -> anyhow::Result<&'a [Value]> {
        let (source, public_history) = tiered_history_source(base)?;
        if !self.dirty && self.available && self.source == Some(source) {
            return Ok(&self.samples);
        }
        // Commands may mutate the public history between private-cache
        // refreshes. A bounded public-history fallback is always safer than a
        // stale private result or making statistics temporarily unavailable.
        Ok(public_history)
    }

    pub(crate) fn sidecar_value(&self, base: &Map<String, Value>) -> Option<Value> {
        let source = self.source.filter(|_| self.available && !self.dirty)?;
        let (current_source, public_history) = tiered_history_source(base).ok()?;
        if current_source != source {
            return None;
        }
        let first_public = public_history.first()?;
        let public_start = finite_number(first_public.get("elapsedSeconds"))?
            - finite_number(first_public.get("sampleDurationSeconds"))?;
        let mut cold_samples = Vec::new();
        let mut previous_inventory = None;
        for sample in &self.samples {
            let elapsed = finite_number(sample.get("elapsedSeconds"))?;
            let duration = finite_number(sample.get("sampleDurationSeconds"))?;
            let start = elapsed - duration;
            if elapsed <= public_start + EPSILON {
                cold_samples.push(sample.clone());
                previous_inventory = sample.get("inventory").cloned();
                continue;
            }
            if start < public_start - EPSILON {
                let (prefix, _) = split_sample_at_duration(
                    sample,
                    public_start - start,
                    previous_inventory.as_ref(),
                )
                .ok()?;
                cold_samples.push(prefix);
            }
            break;
        }
        if cold_samples.is_empty() || cold_samples.len() > MAX_TIERED_HISTORY_SIDECAR_SAMPLES {
            return None;
        }
        let public_end = public_history
            .last()
            .and_then(|sample| finite_number(sample.get("elapsedSeconds")))?;
        validate_sidecar_timeline(&cold_samples, public_start, public_end).ok()?;
        serde_json::to_value(TieredHistorySidecar {
            format_version: TIERED_HISTORY_SIDECAR_FORMAT_VERSION,
            source,
            cold_samples,
        })
        .ok()
    }

    pub(crate) fn restore_sidecar(
        &mut self,
        base: &Map<String, Value>,
        value: Value,
    ) -> anyhow::Result<()> {
        let sidecar = serde_json::from_value::<TieredHistorySidecar>(value)
            .map_err(|error| anyhow!("decode native production history sidecar: {error}"))?;
        if sidecar.format_version != TIERED_HISTORY_SIDECAR_FORMAT_VERSION
            || sidecar.cold_samples.is_empty()
            || sidecar.cold_samples.len() > MAX_TIERED_HISTORY_SIDECAR_SAMPLES
        {
            bail!("native production history sidecar bounds are invalid");
        }
        let (source, public_history) = tiered_history_source(base)?;
        if sidecar.source != source {
            bail!("native production history sidecar source is stale");
        }
        let first_public = public_history
            .first()
            .ok_or_else(|| anyhow!("native production history sidecar has no public boundary"))?;
        let public_start = finite_number(first_public.get("elapsedSeconds"))
            .zip(finite_number(first_public.get("sampleDurationSeconds")))
            .map(|(elapsed, duration)| elapsed - duration)
            .filter(|value| value.is_finite() && *value >= 0.0)
            .ok_or_else(|| anyhow!("native production history sidecar boundary is invalid"))?;
        let public_end = public_history
            .last()
            .and_then(|sample| finite_number(sample.get("elapsedSeconds")))
            .ok_or_else(|| anyhow!("native production history sidecar public end is invalid"))?;
        validate_sidecar_timeline(&sidecar.cold_samples, public_start, public_end)?;
        let mut canonical = sidecar.cold_samples.clone();
        compact_tiered_history(&mut canonical)?;
        if serde_json::to_vec(&canonical)? != serde_json::to_vec(&sidecar.cold_samples)? {
            bail!("native production history sidecar is not canonical");
        }
        let mut samples = sidecar.cold_samples;
        samples.extend(self.samples.iter().cloned());
        compact_tiered_history(&mut samples)?;
        self.samples = samples;
        self.source = Some(source);
        self.available = true;
        self.dirty = false;
        Ok(())
    }
}

impl CoreState {
    pub(crate) fn record_production_history(&mut self) -> anyhow::Result<()> {
        let entities = self.parse_entities_parallel()?;
        let mut base = std::mem::take(self.base_value_mut());
        let result = self.record_production_history_with_records(&mut base, &entities, None);
        *self.base_value_mut() = base;
        result
    }

    pub(crate) fn record_production_history_with_records(
        &self,
        base: &mut Map<String, Value>,
        entities: &[Value],
        prepared_belt_flow: Option<PreparedBeltFlow>,
    ) -> anyhow::Result<()> {
        self.record_production_history_with_records_and_runtime(
            base,
            entities,
            prepared_belt_flow,
            deterministic_runtime(),
        )
        .map(|_| ())
    }

    pub(crate) fn record_production_history_with_campaign_metrics(
        &self,
        base: &mut Map<String, Value>,
        entities: &[Value],
        prepared_belt_flow: Option<PreparedBeltFlow>,
    ) -> anyhow::Result<Option<crate::campaign::CampaignFactoryMetrics>> {
        self.record_production_history_with_records_and_runtime(
            base,
            entities,
            prepared_belt_flow,
            deterministic_runtime(),
        )
    }

    fn record_production_history_with_records_and_runtime(
        &self,
        base: &mut Map<String, Value>,
        entities: &[Value],
        prepared_belt_flow: Option<PreparedBeltFlow>,
        runtime: &DeterministicRuntime,
    ) -> anyhow::Result<Option<crate::campaign::CampaignFactoryMetrics>> {
        let profile_enabled = std::env::var_os("DSP_NATIVE_CORE_PROFILE").is_some();
        let mut profile_checkpoint = std::time::Instant::now();
        macro_rules! profile_mark {
            ($label:literal) => {
                if profile_enabled {
                    eprintln!(
                        "DSP_NATIVE_CORE_PROFILE\thistory-{}\t{:.3}",
                        $label,
                        profile_checkpoint.elapsed().as_secs_f64() * 1_000.0
                    );
                    profile_checkpoint = std::time::Instant::now();
                }
            };
        }
        macro_rules! profile_last {
            ($label:literal) => {
                if profile_enabled {
                    eprintln!(
                        "DSP_NATIVE_CORE_PROFILE\thistory-{}\t{:.3}",
                        $label,
                        profile_checkpoint.elapsed().as_secs_f64() * 1_000.0
                    );
                }
            };
        }
        // Production history is sampled, not recomputed every simulation
        // second. Check the sample clock before building any whole-factory
        // aggregates so the common no-sample path is O(1).
        let Some(boundary) = production_history_boundary(base)? else {
            return Ok(None);
        };
        let elapsed = boundary.elapsed;
        let duration = boundary.duration;
        let history = base
            .get("productionHistory")
            .and_then(Value::as_array)
            .ok_or_else(|| anyhow!("native production history is missing"))?;
        let previous = history.last();
        let refresh = boundary.refresh;
        let mut ordered_planets = self.catalog.planets.iter().collect::<Vec<_>>();
        ordered_planets.sort_by(|left, right| {
            left.simulation_order
                .cmp(&right.simulation_order)
                .then_with(|| left.id.cmp(&right.id))
        });
        let planet_ids = ordered_planets
            .into_iter()
            .map(|planet| planet.id.as_str())
            .collect::<Vec<_>>();
        // JavaScript only computes logistics diagnostics at the 10-second
        // refresh boundary. On the intervening samples the previous value is
        // copied below, so scanning every belt here cannot affect the sample.
        let (belt_capacity, belt_flow) = if refresh {
            let aggregate = match prepared_belt_flow {
                Some(PreparedBeltFlow::Exact(aggregate)) => aggregate,
                Some(PreparedBeltFlow::NotRequired) => {
                    bail!("native prepared belt flow was skipped at a required boundary")
                }
                None => crate::belts::aggregate_flow_from_state(self)?,
            };
            (aggregate.capacity, aggregate.flow)
        } else {
            (0.0, 0.0)
        };
        profile_mark!("belt-flow");
        let mut inventory_values = refresh.then(RateAccumulator::new);
        let generation = metric_sum(base, &planet_ids, "generationKw");
        let demand = metric_sum(base, &planet_ids, "demandKw");
        let delivered = delivered_power(base, &planet_ids);
        let previous_number =
            |key: &str| previous.and_then(|sample| finite_number(sample.get(key)));
        let mut production = RateAccumulator::new();
        let mut consumption = RateAccumulator::new();
        let mut planet_production = PlanetRateAccumulator::new();
        let mut planet_consumption = PlanetRateAccumulator::new();
        let mut recipe_cache = HashMap::<u32, Option<&crate::catalog::RecipeDefinition>>::new();
        let mut productive_units = 0.0;
        let mut utilized_units = 0.0;
        let mut active = 0.0;
        // A pending campaign otherwise performs another whole-factory entity
        // scan immediately after this history sample. Its topology metrics are
        // read-only and use the same persisted entity order, so collect them
        // here and hand the finished probe to the fixed-order campaign commit.
        // Completed campaigns pay no extra per-entity work.
        let mut campaign_factory_metrics = crate::campaign::factory_metrics_needed(base)
            .then(crate::campaign::CampaignFactoryMetrics::default);
        let rate_indices = &self.factory_topology.production_history_rate_indices;
        let rate_index_dense =
            rate_indices.len().saturating_mul(4) >= entities.len().saturating_mul(3);
        let rate_index_invalid = rate_indices
            .last()
            .is_some_and(|index| *index >= entities.len());
        let full_entity_scan =
            refresh || campaign_factory_metrics.is_some() || rate_index_dense || rate_index_invalid;
        if profile_enabled {
            eprintln!(
                "DSP_NATIVE_CORE_PROFILE\thistory-rate-index\t{}/{}\tdense={}\tfull-scan={}",
                rate_indices.len(),
                entities.len(),
                rate_index_dense,
                full_entity_scan,
            );
        }
        if full_entity_scan {
            for (index, entity) in entities.iter().enumerate() {
                let Some(entity) = entity.as_object() else {
                    continue;
                };
                if let Some(metrics) = &mut campaign_factory_metrics {
                    metrics.observe_indexed_entity(self, index, entity);
                }
                // Kind, planet, building, recipe and resource are topology
                // fields. They already live in compact columns and do not
                // change during an ordinary simulation revision.
                let kind = self
                    .symbols
                    .resolve(self.entities.kinds[index])
                    .unwrap_or_default();
                let planet = self
                    .symbols
                    .resolve(self.entities.planets[index])
                    .unwrap_or_default();
                let building = self
                    .symbols
                    .resolve(self.entities.buildings[index])
                    .unwrap_or_default();
                if let Some(inventory) = &mut inventory_values {
                    for record in [entity.get("inputs"), entity.get("outputs")] {
                        let Some(record) = record.and_then(Value::as_object) else {
                            continue;
                        };
                        for (item, amount) in record {
                            if let Some(amount) = finite_number(Some(amount)) {
                                add_rate(inventory, item, amount.floor());
                            }
                        }
                    }
                }
                if refresh
                    && (kind == "machine"
                        || kind == "vein" && self.entities.miner_counts[index] > 0.0)
                {
                    let count = if kind == "vein" {
                        self.entities.miner_counts[index]
                    } else {
                        self.entities.machine_counts[index]
                    };
                    let utilization = finite_number(entity.get("utilization")).unwrap_or(0.0);
                    productive_units += count;
                    utilized_units += count * utilization;
                    if utilization > EPSILON {
                        active += count;
                    }
                }
                add_history_entity_rates(
                    self,
                    index,
                    entity,
                    kind,
                    planet,
                    building,
                    &mut recipe_cache,
                    &mut production,
                    &mut consumption,
                    &mut planet_production,
                    &mut planet_consumption,
                );
            }
        } else {
            for &index in rate_indices {
                let Some(entity) = entities.get(index).and_then(Value::as_object) else {
                    continue;
                };
                let kind = self
                    .symbols
                    .resolve(self.entities.kinds[index])
                    .unwrap_or_default();
                let planet = self
                    .symbols
                    .resolve(self.entities.planets[index])
                    .unwrap_or_default();
                let building = self
                    .symbols
                    .resolve(self.entities.buildings[index])
                    .unwrap_or_default();
                add_history_entity_rates(
                    self,
                    index,
                    entity,
                    kind,
                    planet,
                    building,
                    &mut recipe_cache,
                    &mut production,
                    &mut consumption,
                    &mut planet_production,
                    &mut planet_consumption,
                );
            }
        }
        if let Some(metrics) = &mut campaign_factory_metrics {
            metrics.observe_belts(&self.belts.tiers);
        }
        let inventory = if let Some(mut inventory) = inventory_values {
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
        } else {
            Value::Object(clone_object(
                previous.and_then(|sample| sample.get("inventory")),
            ))
        };
        profile_mark!("inventory-and-rates");
        let blocked = if refresh {
            let production_buffer_limit = normalized_buffer_limit(
                base.get("settings")
                    .and_then(Value::as_object)
                    .and_then(|settings| settings.get("productionBufferLimit")),
            );
            let vein_level = base
                .get("endgame")
                .and_then(Value::as_object)
                .and_then(|endgame| endgame.get("infiniteResearch"))
                .and_then(Value::as_object)
                .and_then(|research| research.get("vein_utilization"))
                .and_then(Value::as_object)
                .and_then(|progress| progress.get("level"))
                .and_then(Value::as_f64)
                .unwrap_or(0.0)
                .floor()
                .clamp(0.0, 1_000.0);
            let consumption_tenths = (10.0 - vein_level.min(10.0)).max(0.0).floor();
            let infinite_resource_mode = base
                .get("settings")
                .and_then(Value::as_object)
                .and_then(|settings| settings.get("resourceMode"))
                .and_then(Value::as_str)
                == Some("infinite");
            let completed_tech = base
                .get("research")
                .and_then(Value::as_object)
                .and_then(|research| research.get("completedTechIds"))
                .and_then(Value::as_array)
                .map(|values| {
                    values
                        .iter()
                        .filter_map(Value::as_str)
                        .collect::<HashSet<_>>()
                })
                .unwrap_or_default();
            let has_active_research = crate::simple_factory::has_active_research(base);
            let remaining_research_costs = has_active_research
                .then(|| crate::simple_factory::remaining_research_costs(self, base));
            let power_grid_metrics = base.get("powerGridMetrics").and_then(Value::as_object);
            let galaxy_profiles = base
                .get("galaxy")
                .and_then(Value::as_object)
                .and_then(|galaxy| galaxy.get("profiles"))
                .and_then(Value::as_object);

            // Borrow the exact strings used by the save. The previous compact
            // tuple used topology indices, which collapsed every unknown MOD
            // planet/grid into usize::MAX and could make an unrelated custom
            // grid appear powered. Borrowed string pairs avoid allocations
            // without changing identity or the missing-field defaults.
            let power_source_probes =
                runtime.indexed_map(entities, |index, value| -> Option<(u32, String)> {
                    let kind = self
                        .symbols
                        .resolve(self.entities.kinds[index])
                        .unwrap_or_default();
                    let building_id = self
                        .symbols
                        .resolve(self.entities.buildings[index])
                        .unwrap_or_default();
                    let recipe_id = self
                        .symbols
                        .resolve(self.entities.recipes[index])
                        .unwrap_or_default();
                    if kind != "power"
                        && !(building_id == "ray_receiver" && recipe_id == "ray_power")
                    {
                        return None;
                    }
                    let entity = value.as_object()?;
                    let grid_id = entity
                        .get("powerGridId")
                        .and_then(Value::as_str)
                        .unwrap_or("grid-a");
                    Some((self.entities.planets[index], grid_id.to_owned()))
                });
            let mut power_source_grids = HashMap::<u32, HashSet<String>>::with_capacity(
                self.factory_topology.power_source_indices.len(),
            );
            // Replaying the indexed probe vector preserves the historical
            // first-seen order even though membership is queried as a set.
            for (planet, grid) in power_source_probes.into_iter().flatten() {
                power_source_grids.entry(planet).or_default().insert(grid);
            }

            let mining_output_capacity = self
                .catalog
                .buildings
                .get("mining_machine")
                .map(|building| building.output_capacity)
                .unwrap_or(0.0);
            let oil_output_capacity = self
                .catalog
                .buildings
                .get("oil_extractor")
                .map(|building| building.output_capacity)
                .unwrap_or(0.0);
            let water_output_capacity = self
                .catalog
                .buildings
                .get("water_pump")
                .map(|building| building.output_capacity)
                .unwrap_or(0.0);
            let blocked_probes = runtime.indexed_map(entities, |index, value| {
                let entity = value.as_object()?;
                let kind = self
                    .symbols
                    .resolve(self.entities.kinds[index])
                    .unwrap_or_default();
                let count = if kind == "machine" {
                    self.entities.machine_counts[index]
                } else if kind == "vein" && self.entities.miner_counts[index] > 0.0 {
                    self.entities.miner_counts[index]
                } else {
                    return None;
                };
                let is_blocked = if kind == "machine" {
                    let building_id = self
                        .symbols
                        .resolve(self.entities.buildings[index])
                        .unwrap_or_default();
                    if matches!(
                        building_id,
                        "time_warp_device" | "micro_black_hole_connector"
                    ) {
                        false
                    } else if building_id == "construction_center" {
                        crate::construction::is_operating_blocked(self, base, entity)
                            .unwrap_or(false)
                    } else if building_id == "galactic_material_exporter" {
                        crate::galactic_exports::operating_blocked(entity)
                    } else {
                        let recipe = self
                            .symbols
                            .resolve(self.entities.recipes[index])
                            .and_then(|id| self.catalog.recipes.get(id));
                        let building = self
                            .symbols
                            .resolve(self.entities.buildings[index])
                            .and_then(|id| self.catalog.buildings.get(id));
                        match (recipe, building) {
                            (Some(recipe), Some(building)) => {
                                if recipe
                                    .required_tech_id
                                    .as_deref()
                                    .is_some_and(|id| !completed_tech.contains(id))
                                    || recipe.id == "matrix_research" && !has_active_research
                                {
                                    true
                                } else {
                                    let capacity = stacked_capacity(
                                        building.output_capacity,
                                        count,
                                        production_buffer_limit,
                                    );
                                    let output_blocked = recipe.outputs.iter().any(|output| {
                                        let bonus =
                                            crate::simple_factory::next_proliferated_output_bonus(
                                                self,
                                                entity,
                                                recipe,
                                                &output.item_id,
                                                output.amount,
                                            );
                                        capacity
                                            - entity
                                                .get("outputs")
                                                .and_then(Value::as_object)
                                                .and_then(|values| values.get(&output.item_id))
                                                .and_then(Value::as_f64)
                                                .unwrap_or(0.0)
                                            + EPSILON
                                            < output.amount + bonus
                                    });
                                    if output_blocked {
                                        true
                                    } else {
                                        let inputs =
                                            entity.get("inputs").and_then(Value::as_object);
                                        let missing_input = if recipe.id == "matrix_research" {
                                            remaining_research_costs
                                                .as_deref()
                                                .unwrap_or_default()
                                                .iter()
                                                .any(|(item_id, _)| {
                                                    inputs
                                                        .and_then(|values| values.get(item_id))
                                                        .and_then(Value::as_f64)
                                                        .unwrap_or(0.0)
                                                        + EPSILON
                                                        < 1.0
                                                })
                                        } else {
                                            recipe.inputs.iter().any(|input| {
                                                inputs
                                                    .and_then(|values| values.get(&input.item_id))
                                                    .and_then(Value::as_f64)
                                                    .unwrap_or(0.0)
                                                    + EPSILON
                                                    < input.amount
                                            })
                                        };
                                        if missing_input {
                                            true
                                        } else {
                                            let planet_symbol = self.entities.planets[index];
                                            let planet_id = self
                                                .symbols
                                                .resolve(planet_symbol)
                                                .unwrap_or_default();
                                            let grid_id = entity
                                                .get("powerGridId")
                                                .and_then(Value::as_str)
                                                .unwrap_or("grid-a");
                                            let power = if !power_source_grids
                                                .get(&planet_symbol)
                                                .is_some_and(|grids| grids.contains(grid_id))
                                            {
                                                0.0
                                            } else if let Some(power) =
                                                finite_number(entity.get("powerFactor"))
                                            {
                                                power.clamp(0.0, 1.0)
                                            } else {
                                                power_grid_metrics
                                                    .and_then(|planets| planets.get(planet_id))
                                                    .and_then(Value::as_object)
                                                    .and_then(|grids| grids.get(grid_id))
                                                    .and_then(Value::as_object)
                                                    .and_then(|metric| {
                                                        finite_number(metric.get("powerFactor"))
                                                    })
                                                    .unwrap_or(0.0)
                                            };
                                            power <= EPSILON
                                        }
                                    }
                                }
                            }
                            _ => true,
                        }
                    }
                } else {
                    let resource = self
                        .symbols
                        .resolve(self.entities.resources[index])
                        .unwrap_or_default();
                    let item_kind = self
                        .catalog
                        .items
                        .get(resource)
                        .map(|item| item.kind.as_str())
                        .unwrap_or("solid");
                    let planet_id = self
                        .symbols
                        .resolve(self.entities.planets[index])
                        .unwrap_or_default();
                    let ocean_type = galaxy_profiles
                        .and_then(|profiles| profiles.get(planet_id))
                        .and_then(Value::as_object)
                        .and_then(|profile| profile.get("oceanType"))
                        .and_then(Value::as_str)
                        .unwrap_or("none");
                    let infinite = infinite_resource_mode
                        || item_kind == "solid" && consumption_tenths <= 0.0
                        || resource == "water" && ocean_type == "water"
                        || resource == "sulfuric_acid" && ocean_type == "sulfuric-acid";
                    let resource_consumption_tenths = if item_kind == "solid" {
                        consumption_tenths
                    } else {
                        10.0
                    };
                    let depleted = if infinite {
                        false
                    } else {
                        let remaining = finite_number(entity.get("resourceRemaining"))
                            .unwrap_or(0.0)
                            .floor()
                            .max(0.0);
                        let remainder = finite_number(entity.get("resourceDepletionRemainder"))
                            .unwrap_or(0.0)
                            .floor()
                            .clamp(0.0, 9.0);
                        ((remaining * 10.0 - remainder).max(0.0) / resource_consumption_tenths)
                            .floor()
                            < 1.0
                    };
                    if depleted {
                        true
                    } else {
                        let output_capacity = match resource {
                            "crude_oil" => oil_output_capacity,
                            "water" | "sulfuric_acid" => water_output_capacity,
                            _ => mining_output_capacity,
                        };
                        let capacity =
                            stacked_capacity(output_capacity, count, production_buffer_limit);
                        let output = entity
                            .get("outputs")
                            .and_then(Value::as_object)
                            .and_then(|outputs| outputs.get(resource))
                            .and_then(Value::as_f64)
                            .unwrap_or(0.0);
                        let power = finite_number(entity.get("powerFactor"))
                            .unwrap_or(0.0)
                            .clamp(0.0, 1.0);
                        output >= capacity - EPSILON || power <= EPSILON
                    }
                };
                Some((count, is_blocked))
            });
            // Float additions intentionally remain in persisted entity order;
            // workers only perform independent read-only classification.
            let mut blocked = 0.0;
            for (count, is_blocked) in blocked_probes.into_iter().flatten() {
                if is_blocked {
                    blocked += count;
                }
            }
            blocked
        } else {
            0.0
        };
        profile_mark!("efficiency");
        let sample = serde_json::json!({
            "elapsedSeconds": elapsed,
            "sampleDurationSeconds": duration,
            "productionPerMinute": rates_to_value(production),
            "consumptionPerMinute": rates_to_value(consumption),
            "planetProductionPerMinute": planet_rates_to_value(planet_production),
            "planetConsumptionPerMinute": planet_rates_to_value(planet_consumption),
            "inventory": inventory,
            "generationKw": rounded(generation, 2),
            "demandKw": rounded(demand, 2),
            "machineEfficiency": if refresh { rounded(if productive_units > 0.0 { utilized_units / productive_units } else { 0.0 }, 4) } else { previous_number("machineEfficiency").unwrap_or(0.0) },
            "logisticsEfficiency": if refresh { rounded(if belt_capacity > 0.0 { (belt_flow / belt_capacity).min(1.0) } else { 0.0 }, 4) } else { previous_number("logisticsEfficiency").unwrap_or(0.0) },
            "powerEfficiency": rounded(if demand > 0.0 { (delivered / demand).min(1.0) } else { 1.0 }, 4),
            "activeMachines": if refresh { active.floor().max(0.0) } else { previous_number("activeMachines").unwrap_or(0.0).floor().max(0.0) },
            "blockedMachines": if refresh { blocked.floor().max(0.0) } else { previous_number("blockedMachines").unwrap_or(0.0).floor().max(0.0) },
        });
        // The history was only borrowed while this sample was calculated. Move
        // the existing array out now instead of cloning every retained bucket
        // (and all of its nested item maps) once per simulation second.
        let mut next = match base.remove("productionHistory") {
            Some(Value::Array(history)) => history,
            _ => bail!("native production history changed while sampling"),
        };
        next.push(sample);
        compact_history(&mut next)?;
        base.insert("productionHistory".to_owned(), Value::Array(next));
        base.insert("historyRecordedAt".to_owned(), Value::from(elapsed));
        profile_last!("compact");
        Ok(campaign_factory_metrics)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::{
        BeltDefinition, BuildingDefinition, CatalogSnapshot, ItemAmount, ItemDefinition,
        PlanetDefinition, RecipeDefinition, RuntimeCatalog,
    };
    use crate::state::CoreCheckpointIdentity;
    use serde_json::json;
    use std::time::Instant;

    fn fixture_checksum(bytes: &[u8]) -> String {
        let mut hash = 0x811c9dc5_u32;
        for byte in bytes {
            hash ^= u32::from(*byte);
            hash = hash.wrapping_mul(0x01000193);
        }
        format!("{hash:08x}")
    }

    fn history_fixture_building(id: &str, kind: &str, generation_kw: f64) -> BuildingDefinition {
        BuildingDefinition {
            id: id.to_owned(),
            kind: kind.to_owned(),
            speed: 1.0,
            input_capacity: 100.0,
            output_capacity: 100.0,
            power_demand_kw: if kind == "machine" { 1.0 } else { 0.0 },
            power_generation_kw: generation_kw,
            power_charge_kw: 0.0,
            energy_capacity_mj: 0.0,
            fuel_item_ids: Vec::new(),
            fuel_efficiency: 1.0,
            family: (kind == "machine").then(|| "smelting".to_owned()),
            accepts: None,
        }
    }

    fn history_fixture_catalog() -> RuntimeCatalog {
        RuntimeCatalog::validate(
            CatalogSnapshot {
                protocol_version: 1,
                registry_fingerprint: "history-parallel-v1".to_owned(),
                planets: vec![PlanetDefinition {
                    id: "home".to_owned(),
                    name: "home".to_owned(),
                    system_id: "helios".to_owned(),
                    kind: "terrestrial".to_owned(),
                    orbit_index: 1,
                    simulation_order: 0,
                    orbital_yields: HashMap::new(),
                }],
                items: ["iron_ore", "iron_ingot"]
                    .into_iter()
                    .map(|id| ItemDefinition {
                        id: id.to_owned(),
                        name: id.to_owned(),
                        kind: "solid".to_owned(),
                        fuel_energy_mj: 0.0,
                    })
                    .collect(),
                buildings: vec![
                    history_fixture_building("arc_smelter", "machine", 0.0),
                    history_fixture_building("solar_panel", "power", 1_000.0),
                ],
                recipes: vec![RecipeDefinition {
                    id: "iron_ingot".to_owned(),
                    name: "iron_ingot".to_owned(),
                    building_id: "arc_smelter".to_owned(),
                    duration: 1.0,
                    required_tech_id: None,
                    recursive_priority: 0.0,
                    recursive_manufacturing: false,
                    inputs: vec![ItemAmount {
                        item_id: "iron_ore".to_owned(),
                        amount: 1.0,
                    }],
                    outputs: vec![ItemAmount {
                        item_id: "iron_ingot".to_owned(),
                        amount: 1.0,
                    }],
                }],
                constructions: Vec::new(),
                belts: vec![BeltDefinition {
                    tier: 1,
                    speed: 6.0,
                }],
                proliferators: Vec::new(),
                technologies: Vec::new(),
            },
            "history-parallel-v1",
        )
        .unwrap()
    }

    fn history_parallel_fixture() -> (CoreState, Map<String, Value>, Vec<Value>, f64) {
        let mut entities = Vec::with_capacity(4_097);
        entities.push(json!({
            "id": "power",
            "kind": "power",
            "planetId": "home",
            "powerGridId": "grid-a",
            "buildingId": "solar_panel",
            "machineCount": 1,
            "minerCount": 0,
            "inputs": {},
            "outputs": {},
            "progress": 0,
            "utilization": 1,
            "productionRate": 0,
            "routingCursor": 0
        }));
        let mut expected_blocked = 0.0;
        for index in 0..4_096 {
            let count = 1.0 + (index % 3) as f64;
            let power_factor = if index % 2 == 0 { 0.0 } else { 1.0 };
            if power_factor == 0.0 {
                expected_blocked += count;
            }
            entities.push(json!({
                "id": format!("machine-{index:05}"),
                "kind": "machine",
                "planetId": "home",
                "powerGridId": "grid-a",
                "buildingId": "arc_smelter",
                "recipeId": "iron_ingot",
                "machineCount": count,
                "minerCount": 0,
                "inputs": { "iron_ore": 100 },
                "outputs": { "iron_ingot": 0 },
                "progress": 0.25,
                "utilization": power_factor,
                "productionRate": 0.01 + index as f64 / 10_000.0,
                "powerFactor": power_factor,
                "routingCursor": 0,
                "proliferatorBonusProgress": {}
            }));
        }
        let base = json!({
            "version": 47,
            "mode": "normal",
            "activePlanetId": "home",
            "elapsedSeconds": 10,
            "historyRecordedAt": 0,
            "productionHistory": [],
            "paused": false,
            "settings": {
                "difficulty": "standard",
                "productionBufferLimit": 1_000_000,
                "resourceMode": "infinite"
            },
            "research": {
                "completedTechIds": [],
                "selectedTechId": null,
                "progressByTech": {}
            },
            "endgame": { "infiniteResearch": { "vein_utilization": { "level": 0 } } },
            "powerGridMetrics": { "home": { "grid-a": {
                "generationKw": 1_000,
                "demandKw": 4_096,
                "deliveredKw": 2_048,
                "powerFactor": 0.5
            } } },
            "planetTrays": { "home": {} },
            "galaxy": { "profiles": { "home": { "oceanType": "none" } } },
            "totalProduced": {}
        });
        let base_bytes = serde_json::to_vec(&base).unwrap();
        let entity_bytes = serde_json::to_vec(&entities).unwrap();
        let belt_bytes = serde_json::to_vec(&Vec::<Value>::new()).unwrap();
        let chunks = [
            ("base", "base", &base_bytes, 0, 1),
            (
                "entities:00000000",
                "entities",
                &entity_bytes,
                0,
                entities.len(),
            ),
            ("belts:00000000", "belts", &belt_bytes, 0, 0),
        ]
        .into_iter()
        .map(|(id, kind, bytes, offset, count)| {
            json!({
                "id": id,
                "kind": kind,
                "offset": offset,
                "count": count,
                "checksum": fixture_checksum(bytes),
                "bytes": bytes.len()
            })
        })
        .collect::<Vec<_>>();
        let manifest = serde_json::to_vec(&json!({
            "formatVersion": 1,
            "envelopeFormatVersion": 2,
            "mode": "normal",
            "slot": "main",
            "stateVersion": 47,
            "savedAt": 1,
            "basePrimaryChecksum": "12345678",
            "chunkRootChecksum": "12345678",
            "totalBytes": base_bytes.len() + entity_bytes.len() + belt_bytes.len(),
            "entityCount": entities.len(),
            "beltCount": 0,
            "chunks": chunks
        }))
        .unwrap();
        let records = BTreeMap::from([
            (
                "dsp-idle-network.internal.v1.chunked.v1.normal.manifest".to_owned(),
                manifest,
            ),
            (
                "dsp-idle-network.internal.v1.chunked.v1.normal.chunk.base".to_owned(),
                base_bytes,
            ),
            (
                "dsp-idle-network.internal.v1.chunked.v1.normal.chunk.entities%3A00000000"
                    .to_owned(),
                entity_bytes,
            ),
            (
                "dsp-idle-network.internal.v1.chunked.v1.normal.chunk.belts%3A00000000".to_owned(),
                belt_bytes,
            ),
        ]);
        let state = CoreState::from_internal_records(
            CoreCheckpointIdentity {
                slot: "normal-main".to_owned(),
                generation: 1,
                root_hash: "a".repeat(64),
                revision: 7,
                state_version: 47,
                mode: "normal".to_owned(),
                registry_fingerprint: "history-parallel-v1".to_owned(),
                base_primary_checksum: "12345678".to_owned(),
            },
            &records,
            history_fixture_catalog(),
        )
        .unwrap();
        (
            state,
            base.as_object().unwrap().clone(),
            entities,
            expected_blocked,
        )
    }

    fn history_sample(elapsed_seconds: f64, rate: f64, duration: f64) -> Value {
        serde_json::json!({
            "elapsedSeconds": elapsed_seconds,
            "sampleDurationSeconds": duration,
            "productionPerMinute": {"iron_ingot": rate},
            "consumptionPerMinute": {"iron_ore": rate / 5.0},
            "planetProductionPerMinute": {"home": {"iron_ingot": rate}},
            "planetConsumptionPerMinute": {"home": {"iron_ore": rate / 5.0}},
            "inventory": {"iron_ingot": elapsed_seconds},
            "generationKw": rate * 10.0,
            "demandKw": rate * 4.0,
            "machineEfficiency": rate / 100.0,
            "logisticsEfficiency": rate / 200.0,
            "powerEfficiency": 1.0,
            "activeMachines": rate / 10.0,
            "blockedMachines": rate / 30.0,
        })
    }

    fn covered_seconds(history: &[Value]) -> f64 {
        history.iter().map(sample_duration).sum()
    }

    fn flow_boundary_base(elapsed: f64, recorded: f64, history: Vec<Value>) -> Map<String, Value> {
        Map::from_iter([
            ("elapsedSeconds".to_owned(), Value::from(elapsed)),
            ("historyRecordedAt".to_owned(), Value::from(recorded)),
            ("productionHistory".to_owned(), Value::Array(history)),
        ])
    }

    fn reference_add_rate(target: &mut BTreeMap<String, f64>, item: &str, amount: f64) {
        target.insert(
            item.to_owned(),
            rounded(target.get(item).copied().unwrap_or(0.0) + amount, 2),
        );
    }

    fn reference_add_planet_rate(
        target: &mut BTreeMap<String, BTreeMap<String, f64>>,
        planet: &str,
        item: &str,
        amount: f64,
    ) {
        reference_add_rate(target.entry(planet.to_owned()).or_default(), item, amount);
    }

    fn reference_rates_to_value(values: BTreeMap<String, f64>) -> Value {
        Value::Object(
            values
                .into_iter()
                .map(|(key, value)| (key, Value::from(value)))
                .collect(),
        )
    }

    fn reference_planet_rates_to_value(values: BTreeMap<String, BTreeMap<String, f64>>) -> Value {
        Value::Object(
            values
                .into_iter()
                .map(|(planet, values)| (planet, reference_rates_to_value(values)))
                .collect(),
        )
    }

    fn assert_rate_bits_equal(actual: &RateAccumulator, expected: &BTreeMap<String, f64>) {
        assert_eq!(actual.len(), expected.len());
        for (item, expected) in expected {
            assert_eq!(
                actual.get(item).expect("actual rate is present").to_bits(),
                expected.to_bits(),
                "rate bits differ for {item:?}",
            );
        }
    }

    fn assert_planet_rate_bits_equal(
        actual: &PlanetRateAccumulator,
        expected: &BTreeMap<String, BTreeMap<String, f64>>,
    ) {
        assert_eq!(actual.len(), expected.len());
        for (planet, expected_rates) in expected {
            let actual_rates = actual.get(planet).expect("actual planet is present");
            assert_rate_bits_equal(actual_rates, expected_rates);
        }
    }

    #[test]
    fn blocked_history_probes_preserve_exact_bytes_at_one_two_four_and_eight_workers() {
        let (state, base, entities, expected_blocked) = history_parallel_fixture();
        let mut encoded = Vec::new();
        for workers in [1, 2, 4, 8] {
            let runtime = DeterministicRuntime::for_test(workers);
            let mut candidate = base.clone();
            state
                .record_production_history_with_records_and_runtime(
                    &mut candidate,
                    &entities,
                    Some(PreparedBeltFlow::Exact(
                        crate::belts::BeltFlowAggregate::default(),
                    )),
                    &runtime,
                )
                .unwrap();
            let sample = candidate
                .get("productionHistory")
                .and_then(Value::as_array)
                .and_then(|history| history.last())
                .expect("history sample");
            assert_eq!(
                finite_number(sample.get("blockedMachines")),
                Some(expected_blocked),
                "worker count {workers}",
            );
            encoded.push(serde_json::to_vec(&candidate).unwrap());
        }
        for candidate in &encoded[1..] {
            assert_eq!(candidate, &encoded[0]);
        }
    }

    #[test]
    fn sparse_rate_index_matches_persisted_order_full_scan_oracle() {
        let (state, mut base, mut entities, _) = history_parallel_fixture();
        base.insert("elapsedSeconds".to_owned(), Value::from(11));
        base.insert("historyRecordedAt".to_owned(), Value::from(10));
        base.insert(
            "productionHistory".to_owned(),
            Value::Array(vec![history_sample(10.0, 1.0, 10.0)]),
        );
        // Only the first 64 machines contribute a non-zero rate in this
        // snapshot. Keeping thousands of zero-rate producers in the oracle
        // proves that the indexed path preserves the exact per-item rounding
        // and materialization bytes of the former persisted-order scan.
        for entity in entities.iter_mut().skip(65) {
            entity
                .as_object_mut()
                .expect("fixture entity")
                .insert("productionRate".to_owned(), Value::from(0));
        }

        let mut indexed_state = state.clone();
        std::sync::Arc::make_mut(&mut indexed_state.factory_topology)
            .production_history_rate_indices = (1..65).collect();
        let mut full_scan_state = state;
        std::sync::Arc::make_mut(&mut full_scan_state.factory_topology)
            .production_history_rate_indices = (1..entities.len()).collect();

        let mut indexed = base.clone();
        let indexed_started = Instant::now();
        indexed_state
            .record_production_history_with_records_and_runtime(
                &mut indexed,
                &entities,
                Some(PreparedBeltFlow::NotRequired),
                &DeterministicRuntime::for_test(8),
            )
            .unwrap();
        let indexed_micros = indexed_started.elapsed().as_micros();
        let mut oracle = base;
        let oracle_started = Instant::now();
        full_scan_state
            .record_production_history_with_records_and_runtime(
                &mut oracle,
                &entities,
                Some(PreparedBeltFlow::NotRequired),
                &DeterministicRuntime::for_test(1),
            )
            .unwrap();
        let oracle_micros = oracle_started.elapsed().as_micros();
        eprintln!(
            "production-history-rate-index-synthetic\tentities={}\tindexed={}\tindexed-us={indexed_micros}\tfull-scan-us={oracle_micros}",
            entities.len(),
            indexed_state
                .factory_topology
                .production_history_rate_indices
                .len(),
        );

        assert_eq!(
            serde_json::to_vec(&indexed).unwrap(),
            serde_json::to_vec(&oracle).unwrap()
        );
        assert_eq!(
            indexed_state
                .factory_topology
                .production_history_rate_indices
                .len(),
            64
        );
        assert!(
            indexed_state
                .factory_topology
                .production_history_rate_indices
                .len()
                * 4
                < entities.len() * 3,
            "fixture must exercise the sparse indexed path"
        );
    }

    #[test]
    fn sampled_history_reuses_campaign_probe_without_changing_campaign_bytes() {
        let (state, mut base, entities, _) = history_parallel_fixture();
        base.insert("manualMined".to_owned(), Value::from(1));
        base.insert("totalProduced".to_owned(), json!({ "iron_ingot": 4 }));
        base.insert(
            "campaign".to_owned(),
            json!({
                "activeChapterId": "foundation",
                "activeTaskId": "mine_first_ore",
                "completedTaskIds": [],
                "rewardedTaskIds": []
            }),
        );

        let mut canonical = None;
        for workers in [1, 2, 4, 8] {
            let runtime = DeterministicRuntime::for_test(workers);
            let mut sampled = base.clone();
            let shared_metrics = state
                .record_production_history_with_records_and_runtime(
                    &mut sampled,
                    &entities,
                    Some(PreparedBeltFlow::Exact(
                        crate::belts::BeltFlowAggregate::default(),
                    )),
                    &runtime,
                )
                .unwrap()
                .expect("pending campaign history sample should return shared metrics");
            let mut reused = sampled.clone();
            let mut fallback = sampled;
            let reused_started = Instant::now();
            crate::campaign::synchronize_with_factory_metrics(
                &state,
                &mut reused,
                &entities,
                Some(shared_metrics),
            )
            .unwrap();
            let reused_micros = reused_started.elapsed().as_micros();
            let fallback_started = Instant::now();
            crate::campaign::synchronize_with_factory_metrics(
                &state,
                &mut fallback,
                &entities,
                None,
            )
            .unwrap();
            let fallback_micros = fallback_started.elapsed().as_micros();
            if workers == 8 {
                eprintln!(
                    "post-stage-campaign-reuse-synthetic\tentities={}\treused-us={reused_micros}\tfallback-full-scan-us={fallback_micros}",
                    entities.len(),
                );
            }

            let reused = serde_json::to_vec(&reused).unwrap();
            assert_eq!(reused, serde_json::to_vec(&fallback).unwrap());
            if let Some(canonical) = &canonical {
                assert_eq!(&reused, canonical, "worker count {workers}");
            } else {
                canonical = Some(reused);
            }
            assert_eq!(
                fallback
                    .get("campaign")
                    .and_then(Value::as_object)
                    .and_then(|campaign| campaign.get("completedTaskIds")),
                Some(&json!(["mine_first_ore", "smelt_iron"]))
            );
        }
    }

    #[test]
    fn rate_accumulation_reuses_existing_key_and_preserves_incremental_rounding() {
        let mut actual = RateAccumulator::new();
        let mut expected = BTreeMap::new();
        let amounts = [0.014, 0.014, 91.337, -0.004, 4_294_967_295.125];

        add_rate(&mut actual, "modded_item", amounts[0]);
        reference_add_rate(&mut expected, "modded_item", amounts[0]);
        let key_pointer = actual.keys().next().expect("inserted key").as_ptr();
        for amount in &amounts[1..] {
            add_rate(&mut actual, "modded_item", *amount);
            reference_add_rate(&mut expected, "modded_item", *amount);
        }

        assert_rate_bits_equal(&actual, &expected);
        assert_eq!(
            actual.keys().next().expect("retained key").as_ptr(),
            key_pointer
        );
    }

    #[test]
    fn first_rate_preserves_legacy_negative_zero_bits() {
        let mut actual = RateAccumulator::new();
        let mut expected = BTreeMap::new();

        add_rate(&mut actual, "negative_zero", -0.0);
        reference_add_rate(&mut expected, "negative_zero", -0.0);

        assert_eq!(
            actual["negative_zero"].to_bits(),
            expected["negative_zero"].to_bits()
        );
        assert_eq!(actual["negative_zero"].to_bits(), 0.0_f64.to_bits());
    }

    #[test]
    fn belt_flow_requirement_matches_sample_refresh_boundaries_and_segments() {
        let prior = vec![history_sample(1.0, 1.0, 1.0)];
        let requirement = |elapsed, recorded, history| {
            belt_flow_requirement(&flow_boundary_base(elapsed, recorded, history)).unwrap()
        };

        assert_eq!(
            requirement(0.9998, 0.0, Vec::new()),
            BeltFlowRequirement::NotRequired
        );
        assert_eq!(
            requirement(0.9999, 0.0, Vec::new()),
            BeltFlowRequirement::ExactOriginalOrder
        );
        assert_eq!(
            requirement(2.0, 1.0, prior.clone()),
            BeltFlowRequirement::NotRequired
        );

        // Segmented one-second revisions skip 8->9, refresh exactly at the
        // 9->10 diagnostics boundary, then skip 10->11 again.
        assert_eq!(
            requirement(9.0, 8.0, prior.clone()),
            BeltFlowRequirement::NotRequired
        );
        assert_eq!(
            requirement(10.0, 9.0, prior.clone()),
            BeltFlowRequirement::ExactOriginalOrder
        );
        assert_eq!(
            requirement(11.0, 10.0, prior.clone()),
            BeltFlowRequirement::NotRequired
        );
        // An unsegmented ten-second sample refreshes by duration even when
        // both endpoints would otherwise lie in adjacent bucket math.
        assert_eq!(
            requirement(11.0, 1.0, prior),
            BeltFlowRequirement::ExactOriginalOrder
        );
    }

    #[test]
    fn belt_flow_requirement_keeps_negative_zero_and_early_return_validation() {
        let negative_zero = flow_boundary_base(-0.0, -0.0, Vec::new());
        let before = serde_json::to_vec(&negative_zero).unwrap();
        assert_eq!(
            belt_flow_requirement(&negative_zero).unwrap(),
            BeltFlowRequirement::NotRequired
        );
        assert_eq!(serde_json::to_vec(&negative_zero).unwrap(), before);
        assert_eq!(
            negative_zero["elapsedSeconds"].as_f64().unwrap().to_bits(),
            (-0.0_f64).to_bits()
        );

        let mut malformed_before_sample = flow_boundary_base(0.5, 0.0, Vec::new());
        malformed_before_sample.insert("productionHistory".to_owned(), Value::Null);
        assert_eq!(
            belt_flow_requirement(&malformed_before_sample).unwrap(),
            BeltFlowRequirement::NotRequired
        );
        malformed_before_sample.insert("elapsedSeconds".to_owned(), Value::from(1.0));
        assert!(belt_flow_requirement(&malformed_before_sample).is_err());
    }

    #[test]
    fn hash_rate_materialization_matches_legacy_bits_unicode_and_bytes() {
        let operations = [
            ("zeta", -0.0),
            ("mod:β/未知", 0.014),
            ("", 1.005),
            ("A", 91.337),
            ("a", -0.004),
            ("mod:β/未知", 0.014),
            ("zeta", 0.0),
            ("A", -91.337),
            ("mod:β/未知", 4_294_967_295.125),
        ];
        let mut stable_bytes = None;

        // Every HashMap receives an independently randomized seed. Explicit
        // materialization order must nevertheless remain byte-identical.
        for _ in 0..32 {
            let mut actual = RateAccumulator::new();
            let mut expected = BTreeMap::new();
            for (item, amount) in operations {
                add_rate(&mut actual, item, amount);
                reference_add_rate(&mut expected, item, amount);
            }
            assert_rate_bits_equal(&actual, &expected);

            let actual_bytes =
                serde_json::to_vec(&rates_to_value(actual)).expect("serialize hash rates");
            let expected_bytes = serde_json::to_vec(&reference_rates_to_value(expected))
                .expect("serialize legacy rates");
            assert_eq!(actual_bytes, expected_bytes);
            if let Some(stable_bytes) = &stable_bytes {
                assert_eq!(&actual_bytes, stable_bytes);
            } else {
                stable_bytes = Some(actual_bytes);
            }
        }
    }

    #[test]
    fn planet_rate_accumulation_reuses_planet_and_item_keys() {
        let mut actual = PlanetRateAccumulator::new();
        add_planet_rate(&mut actual, "custom|planet", "custom_item", 1.234);
        let planet_pointer = actual.keys().next().expect("inserted planet").as_ptr();
        let item_pointer = actual
            .get("custom|planet")
            .and_then(|values| values.keys().next())
            .expect("inserted item")
            .as_ptr();

        add_planet_rate(&mut actual, "custom|planet", "custom_item", 2.345);

        assert_eq!(actual["custom|planet"]["custom_item"], 3.58);
        assert_eq!(
            actual.keys().next().expect("retained planet").as_ptr(),
            planet_pointer
        );
        assert_eq!(
            actual["custom|planet"]
                .keys()
                .next()
                .expect("retained item")
                .as_ptr(),
            item_pointer
        );
    }

    #[test]
    fn hash_planet_rate_materialization_matches_legacy_order_bits_and_bytes() {
        let operations = [
            ("星球-β", "mod:铜", -0.0),
            ("custom|planet", "zeta", 1.234),
            ("", "missing-planet-item", 2.345),
            ("custom|planet", "alpha", 0.014),
            ("星球-β", "mod:铜", 3.456),
            ("custom|planet", "alpha", 0.014),
            ("另一个行星", "物料/γ", 4_294_967_295.125),
            ("", "missing-planet-item", -0.004),
        ];
        let mut stable_bytes = None;

        for _ in 0..32 {
            let mut actual = PlanetRateAccumulator::new();
            let mut expected = BTreeMap::new();
            for (planet, item, amount) in operations {
                add_planet_rate(&mut actual, planet, item, amount);
                reference_add_planet_rate(&mut expected, planet, item, amount);
            }
            assert_planet_rate_bits_equal(&actual, &expected);

            let actual_bytes = serde_json::to_vec(&planet_rates_to_value(actual))
                .expect("serialize hash planet rates");
            let expected_bytes = serde_json::to_vec(&reference_planet_rates_to_value(expected))
                .expect("serialize legacy planet rates");
            assert_eq!(actual_bytes, expected_bytes);
            if let Some(stable_bytes) = &stable_bytes {
                assert_eq!(&actual_bytes, stable_bytes);
            } else {
                stable_bytes = Some(actual_bytes);
            }
        }
    }

    #[test]
    fn tiered_history_promotes_exact_minute_ten_minute_and_hour_boundaries() {
        let mut history = (1..=7_200)
            .map(|second| history_sample(f64::from(second), 60.0, 1.0))
            .collect::<Vec<_>>();

        compact_tiered_history(&mut history).unwrap();

        let count_duration = |duration: f64| {
            history
                .iter()
                .filter(|sample| sample_duration(sample) == duration)
                .count()
        };
        assert_eq!(history.len(), 75);
        assert_eq!(count_duration(1.0), 60);
        assert_eq!(count_duration(TIERED_MINUTE_SECONDS), 9);
        assert_eq!(count_duration(TIERED_TEN_MINUTE_SECONDS), 5);
        assert_eq!(count_duration(TIERED_HOUR_SECONDS), 1);
        assert_eq!(covered_seconds(&history), 7_200.0);
        assert_eq!(history.last().unwrap()["elapsedSeconds"], 7_200.0);

        let mut previous_end = 0.0;
        for sample in &history {
            let end = finite_number(sample.get("elapsedSeconds")).unwrap();
            assert_eq!(end - sample_duration(sample), previous_end);
            previous_end = end;
        }
    }

    #[test]
    fn tiered_history_retains_a_complete_day_without_dropping_below_the_horizon() {
        let mut history = (1..=30)
            .map(|hour| {
                history_sample(
                    f64::from(hour) * TIERED_HOUR_SECONDS,
                    f64::from(hour),
                    TIERED_HOUR_SECONDS,
                )
            })
            .collect::<Vec<_>>();

        compact_tiered_history(&mut history).unwrap();

        assert_eq!(history.len(), 24);
        assert_eq!(covered_seconds(&history), TIERED_HISTORY_RETENTION_SECONDS);
        assert_eq!(history.first().unwrap()["elapsedSeconds"], 7.0 * 3_600.0);
        assert_eq!(history.last().unwrap()["elapsedSeconds"], 30.0 * 3_600.0);
        assert!(
            covered_seconds(&history) - sample_duration(&history[0])
                < TIERED_HISTORY_RETENTION_SECONDS
        );
    }

    #[test]
    fn tiered_history_merge_uses_duration_weights_and_latest_inventory() {
        let mut first = history_sample(20.0, 30.0, 20.0);
        first["machineEfficiency"] = Value::from(0.25);
        first["activeMachines"] = Value::from(2);
        first["blockedMachines"] = Value::from(1);
        let mut second = history_sample(60.0, 90.0, 40.0);
        second["machineEfficiency"] = Value::from(0.75);
        second["activeMachines"] = Value::from(5);
        second["blockedMachines"] = Value::from(4);

        let merged = merge_samples(&[first, second]).unwrap();

        assert_eq!(merged["sampleDurationSeconds"], 60.0);
        assert_eq!(merged["productionPerMinute"]["iron_ingot"], 70.0);
        assert_eq!(merged["consumptionPerMinute"]["iron_ore"], 14.0);
        assert_eq!(
            merged["planetProductionPerMinute"]["home"]["iron_ingot"],
            70.0
        );
        assert_eq!(merged["inventory"]["iron_ingot"], 60.0);
        assert_eq!(merged["generationKw"], 700.0);
        assert_eq!(merged["demandKw"], 280.0);
        assert_eq!(merged["machineEfficiency"], 0.5833);
        assert_eq!(merged["activeMachines"], 4.0);
        assert_eq!(merged["blockedMachines"], 3.0);
    }

    #[test]
    fn tiered_history_split_does_not_expose_future_inventory() {
        let first = history_sample(20.0, 30.0, 20.0);
        let second = history_sample(70.0, 90.0, 50.0);
        let mut history = vec![first, second];

        compact_tiered_buckets_before(&mut history, 100.0, 60.0).unwrap();

        assert_eq!(history.len(), 2);
        assert_eq!(history[0]["elapsedSeconds"], 60.0);
        assert_eq!(history[0]["sampleDurationSeconds"], 60.0);
        assert_eq!(history[0]["inventory"]["iron_ingot"], 20.0);
        assert_eq!(history[1]["elapsedSeconds"], 70.0);
        assert_eq!(history[1]["sampleDurationSeconds"], 10.0);
        assert_eq!(history[1]["inventory"]["iron_ingot"], 70.0);
    }

    #[test]
    fn tiered_history_is_deterministic_across_irregular_publication_segments() {
        let pattern: [f64; 3] = [4.0, 5.0, 12.0];
        let mut elapsed = 0.0_f64;
        let mut source = Vec::new();
        let mut index = 0;
        while elapsed < 7_200.0 {
            let duration = pattern[index % pattern.len()].min(7_200.0 - elapsed);
            elapsed += duration;
            let rate = rounded(17.0 + f64::from((index % 29) as u32) * 0.37, 2);
            source.push(history_sample(elapsed, rate, duration));
            index += 1;
        }

        let mut whole = source.clone();
        compact_tiered_history(&mut whole).unwrap();
        let mut segmented = Vec::new();
        for chunk in source.chunks(137) {
            segmented.extend_from_slice(chunk);
            compact_tiered_history(&mut segmented).unwrap();
        }

        assert_eq!(
            serde_json::to_vec(&segmented).unwrap(),
            serde_json::to_vec(&whole).unwrap()
        );
        assert_eq!(covered_seconds(&segmented), 7_200.0);
        assert!(segmented.iter().all(|sample| {
            let duration = sample_duration(sample);
            duration <= TIERED_MINUTE_SECONDS
                || duration == TIERED_TEN_MINUTE_SECONDS
                || duration == TIERED_HOUR_SECONDS
        }));
    }

    #[test]
    fn tiered_history_serialization_is_stable_and_does_not_mutate_public_v47_history() {
        let public_history = (1..=7_200)
            .map(|second| history_sample(f64::from(second), 60.0, 1.0))
            .collect::<Vec<_>>();
        let base = Map::from_iter([
            ("version".to_owned(), Value::from(47)),
            ("elapsedSeconds".to_owned(), Value::from(7_200)),
            ("historyRecordedAt".to_owned(), Value::from(7_200)),
            ("productionHistory".to_owned(), Value::Array(public_history)),
        ]);
        let public_before = serde_json::to_vec(&base).unwrap();

        let first = TieredProductionHistory::from_base(&base);
        let first_bytes = serde_json::to_vec(first.samples_if_current(&base).unwrap()).unwrap();
        let second = TieredProductionHistory::from_base(&base);
        let second_bytes = serde_json::to_vec(second.samples_if_current(&base).unwrap()).unwrap();
        let mut decoded = serde_json::from_slice::<Vec<Value>>(&first_bytes).unwrap();
        compact_tiered_history(&mut decoded).unwrap();

        assert_eq!(first_bytes, second_bytes);
        assert_eq!(serde_json::to_vec(&decoded).unwrap(), first_bytes);
        assert_eq!(serde_json::to_vec(&base).unwrap(), public_before);
        assert_eq!(base["version"], 47);
    }

    #[test]
    fn tiered_history_detects_earlier_public_edits_and_falls_back_without_stale_data() {
        let mut base = Map::from_iter([
            ("version".to_owned(), Value::from(47)),
            ("elapsedSeconds".to_owned(), Value::from(3)),
            ("historyRecordedAt".to_owned(), Value::from(3)),
            (
                "productionHistory".to_owned(),
                Value::Array(vec![
                    history_sample(1.0, 60.0, 1.0),
                    history_sample(2.0, 70.0, 1.0),
                    history_sample(3.0, 80.0, 1.0),
                ]),
            ),
        ]);
        let mut tiered = TieredProductionHistory::from_base(&base);
        tiered.invalidate();
        base.get_mut("productionHistory")
            .and_then(Value::as_array_mut)
            .unwrap()[0]["productionPerMinute"]["iron_ingot"] = Value::from(777.0);

        // Before refresh, never serve the old private cache merely because
        // length, latest timestamp, and historyRecordedAt are unchanged.
        let fallback = tiered.samples_if_current(&base).unwrap();
        assert_eq!(fallback[0]["productionPerMinute"]["iron_ingot"], 777.0);

        tiered.refresh_from_base(&base);
        let refreshed = tiered.samples_if_current(&base).unwrap();
        assert_eq!(refreshed[0]["productionPerMinute"]["iron_ingot"], 777.0);
    }

    #[test]
    fn tiered_history_handles_whole_replacement_and_empty_history_without_unavailability() {
        let mut base = Map::from_iter([
            ("version".to_owned(), Value::from(47)),
            ("elapsedSeconds".to_owned(), Value::from(2)),
            ("historyRecordedAt".to_owned(), Value::from(2)),
            (
                "productionHistory".to_owned(),
                Value::Array(vec![
                    history_sample(1.0, 60.0, 1.0),
                    history_sample(2.0, 70.0, 1.0),
                ]),
            ),
        ]);
        let mut tiered = TieredProductionHistory::from_base(&base);

        tiered.invalidate();
        base.insert(
            "productionHistory".to_owned(),
            Value::Array(vec![
                history_sample(1.0, 160.0, 1.0),
                history_sample(2.0, 170.0, 1.0),
            ]),
        );
        let replacement = tiered.samples_if_current(&base).unwrap();
        assert_eq!(replacement[0]["productionPerMinute"]["iron_ingot"], 160.0);
        tiered.refresh_from_base(&base);
        assert_eq!(
            tiered.samples_if_current(&base).unwrap()[1]["productionPerMinute"]["iron_ingot"],
            170.0
        );

        tiered.invalidate();
        base.insert("productionHistory".to_owned(), Value::Array(Vec::new()));
        assert!(tiered.samples_if_current(&base).unwrap().is_empty());
        tiered.refresh_from_base(&base);
        assert!(tiered.samples_if_current(&base).unwrap().is_empty());
    }

    #[test]
    fn tiered_history_refresh_retains_private_hours_while_public_history_keeps_legacy_layout() {
        let mut base = Map::from_iter([
            ("version".to_owned(), Value::from(47)),
            ("elapsedSeconds".to_owned(), Value::from(0)),
            ("historyRecordedAt".to_owned(), Value::from(0)),
            ("productionHistory".to_owned(), Value::Array(Vec::new())),
        ]);
        let mut tiered = TieredProductionHistory::from_base(&base);
        for second in 1..=7_200 {
            let history = base
                .get_mut("productionHistory")
                .and_then(Value::as_array_mut)
                .unwrap();
            history.push(history_sample(f64::from(second), 60.0, 1.0));
            compact_history(history).unwrap();
            base.insert("elapsedSeconds".to_owned(), Value::from(second));
            base.insert("historyRecordedAt".to_owned(), Value::from(second));
            tiered.refresh_after_internal_sample(&base);
        }

        let public_history = base["productionHistory"].as_array().unwrap();
        let private_history = tiered.samples_if_current(&base).unwrap();
        assert!(covered_seconds(public_history) >= 3_600.0);
        assert!(covered_seconds(public_history) <= HISTORY_RETENTION_SECONDS);
        assert!(public_history.iter().all(|sample| {
            let duration = sample_duration(sample);
            duration == 1.0 || duration == 10.0 || duration == 60.0
        }));
        assert_eq!(covered_seconds(private_history), 7_200.0);
        assert!(
            private_history
                .iter()
                .any(|sample| sample_duration(sample) == TIERED_HOUR_SECONDS)
        );
        assert!(
            private_history
                .iter()
                .any(|sample| sample_duration(sample) == TIERED_TEN_MINUTE_SECONDS)
        );

        let public_before = serde_json::to_vec(&base).unwrap();
        let sidecar = tiered.sidecar_value(&base).unwrap();
        let mut reopened = TieredProductionHistory::from_base(&base);
        assert!(covered_seconds(reopened.samples_if_current(&base).unwrap()) < 7_200.0);
        reopened.restore_sidecar(&base, sidecar).unwrap();
        assert_eq!(
            covered_seconds(reopened.samples_if_current(&base).unwrap()),
            7_200.0
        );
        assert_eq!(serde_json::to_vec(&base).unwrap(), public_before);
    }

    #[test]
    fn tiered_history_sidecar_rejects_stale_or_noncanonical_payloads_without_installing_them() {
        let base = Map::from_iter([
            ("version".to_owned(), Value::from(47)),
            ("elapsedSeconds".to_owned(), Value::from(102)),
            ("historyRecordedAt".to_owned(), Value::from(102)),
            (
                "productionHistory".to_owned(),
                Value::Array(vec![
                    history_sample(101.0, 60.0, 1.0),
                    history_sample(102.0, 70.0, 1.0),
                ]),
            ),
        ]);
        let source = tiered_history_source(&base).unwrap().0;
        let payload = serde_json::to_value(TieredHistorySidecar {
            format_version: TIERED_HISTORY_SIDECAR_FORMAT_VERSION,
            source,
            cold_samples: vec![
                history_sample(50.0, 40.0, 50.0),
                history_sample(100.0, 50.0, 50.0),
            ],
        })
        .unwrap();

        let mut stale_base = base.clone();
        stale_base.insert("historyRecordedAt".to_owned(), Value::from(103));
        let mut target = TieredProductionHistory::from_base(&stale_base);
        assert!(
            target
                .restore_sidecar(&stale_base, payload.clone())
                .is_err()
        );
        assert_eq!(
            target.samples_if_current(&stale_base).unwrap(),
            stale_base["productionHistory"].as_array().unwrap()
        );

        let mut noncanonical = payload;
        noncanonical["coldSamples"]
            .as_array_mut()
            .unwrap()
            .reverse();
        let mut target = TieredProductionHistory::from_base(&base);
        assert!(target.restore_sidecar(&base, noncanonical).is_err());
        assert_eq!(
            target.samples_if_current(&base).unwrap(),
            base["productionHistory"].as_array().unwrap()
        );

        let assert_timeline_rejected = |cold_samples: Vec<Value>| {
            let invalid = serde_json::to_value(TieredHistorySidecar {
                format_version: TIERED_HISTORY_SIDECAR_FORMAT_VERSION,
                source,
                cold_samples,
            })
            .unwrap();
            let mut target = TieredProductionHistory::from_base(&base);
            assert!(target.restore_sidecar(&base, invalid).is_err());
            assert_eq!(
                target.samples_if_current(&base).unwrap(),
                base["productionHistory"].as_array().unwrap()
            );
        };
        // Each payload below is ordered and would stay byte-canonical after
        // compaction. It must still be rejected because a correctly signed
        // cache cannot invent, overlap, or omit a slice of diagnostic time.
        assert_timeline_rejected(vec![
            history_sample(40.0, 40.0, 40.0),
            history_sample(100.0, 50.0, 50.0),
        ]);
        assert_timeline_rejected(vec![
            history_sample(60.0, 40.0, 60.0),
            history_sample(100.0, 50.0, 50.0),
        ]);
        assert_timeline_rejected(vec![history_sample(99.0, 40.0, 99.0)]);

        let long_base = Map::from_iter([
            ("version".to_owned(), Value::from(47)),
            ("elapsedSeconds".to_owned(), Value::from(90_002)),
            ("historyRecordedAt".to_owned(), Value::from(90_002)),
            (
                "productionHistory".to_owned(),
                Value::Array(vec![
                    history_sample(90_001.0, 60.0, 1.0),
                    history_sample(90_002.0, 70.0, 1.0),
                ]),
            ),
        ]);
        let overlong = serde_json::to_value(TieredHistorySidecar {
            format_version: TIERED_HISTORY_SIDECAR_FORMAT_VERSION,
            source: tiered_history_source(&long_base).unwrap().0,
            cold_samples: vec![history_sample(90_000.0, 40.0, 90_000.0)],
        })
        .unwrap();
        let mut target = TieredProductionHistory::from_base(&long_base);
        assert!(target.restore_sidecar(&long_base, overlong).is_err());
        assert_eq!(
            target.samples_if_current(&long_base).unwrap(),
            long_base["productionHistory"].as_array().unwrap()
        );
    }
}
