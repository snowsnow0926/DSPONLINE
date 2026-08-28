use std::cmp::Ordering;
use std::collections::{BTreeMap, HashMap, HashSet};

use anyhow::{anyhow, bail};
use num_bigint::{BigUint, ToBigUint};
use serde_json::{Map, Value};

use crate::belts::BeltFlowAggregate;
use crate::state::CoreState;

const EPSILON: f64 = 0.0001;
const SAMPLE_SECONDS: f64 = 1.0;
const RECENT_FINE_SECONDS: f64 = 70.0;
const RECENT_MEDIUM_SECONDS: f64 = 660.0;
const HISTORY_RETENTION_SECONDS: f64 = 3_660.0;

type RateAccumulator = HashMap<String, f64>;
type PlanetRateAccumulator = HashMap<String, RateAccumulator>;

const JAVASCRIPT_MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

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

fn non_negative_integer(value: Option<&Value>, require_safe: bool) -> Option<BigUint> {
    let value = finite_number(value)?;
    if value < 0.0 || value.fract() != 0.0 || require_safe && value > JAVASCRIPT_MAX_SAFE_INTEGER {
        return None;
    }
    value.to_biguint()
}

fn decimal_biguint(value: Option<&Value>) -> BigUint {
    value
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit()))
        .and_then(|value| value.parse::<BigUint>().ok())
        .unwrap_or_default()
}

fn add_biguint(target: &mut BTreeMap<String, BigUint>, key: &str, amount: BigUint) {
    *target.entry(key.to_owned()).or_default() += amount;
}

fn biguint_record(values: BTreeMap<String, BigUint>) -> Value {
    Value::Object(
        values
            .into_iter()
            .map(|(key, value)| (key, Value::String(value.to_string())))
            .collect(),
    )
}

fn capture_pure_idle_replication(state: &CoreState, base: &Map<String, Value>) -> Option<Value> {
    let total_produced = base.get("totalProduced")?.as_object()?;
    let mut produced = BTreeMap::<String, BigUint>::new();
    for (item_id, value) in total_produced {
        produced.insert(item_id.clone(), non_negative_integer(Some(value), false)?);
    }

    let research = base.get("research")?.as_object()?;
    let completed = research
        .get("completedTechIds")?
        .as_array()?
        .iter()
        .filter_map(Value::as_str)
        .collect::<HashSet<_>>();
    let mut investment = BTreeMap::<String, BigUint>::new();
    for technology_id in &completed {
        let Some(technology) = state.catalog.technologies.get(*technology_id) else {
            continue;
        };
        for cost in &technology.costs {
            let amount = cost.amount.to_biguint()?;
            add_biguint(&mut investment, &cost.item_id, amount);
        }
    }
    for (technology_id, progress) in research.get("progressByTech")?.as_object()? {
        if completed.contains(technology_id.as_str()) {
            continue;
        }
        for (item_id, value) in progress.as_object()? {
            add_biguint(
                &mut investment,
                item_id,
                non_negative_integer(Some(value), true)?,
            );
        }
    }

    let infinite_research = base
        .get("endgame")?
        .as_object()?
        .get("infiniteResearch")?
        .as_object()?;
    for (research_id, progress) in infinite_research {
        let progress = progress.as_object()?;
        let maximum = crate::infinite_research::maximum_level(research_id)?;
        let level = finite_number(progress.get("level"))?;
        let level = level.floor().clamp(0.0, f64::from(maximum)) as u32;
        let invested = crate::infinite_research::cumulative_investment(
            research_id,
            level,
            &decimal_biguint(progress.get("progress")),
        )
        .ok()?;
        add_biguint(&mut investment, "universe_matrix", invested);
    }

    let plans = base.get("dysonPlans")?.as_object()?;
    let mut structure = Map::new();
    let mut sails = Map::new();
    for (system_id, plan) in plans {
        let plan = plan.as_object()?;
        let structure_points = non_negative_integer(plan.get("structurePoints"), true)?;
        let shell_sails = non_negative_integer(plan.get("shellSails"), true)?;
        structure.insert(
            system_id.clone(),
            Value::from(structure_points.to_string().parse::<u64>().ok()?),
        );
        sails.insert(
            system_id.clone(),
            Value::from(shell_sails.to_string().parse::<u64>().ok()?),
        );
    }

    Some(serde_json::json!({
        "totalProduced": biguint_record(produced),
        "researchInvestmentByItem": biguint_record(investment),
        "structurePointsBySystem": structure,
        "shellSailsBySystem": sails,
    }))
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
    let mut merged = serde_json::json!({
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
    });
    if let Some(replication) = latest.get("pureIdleReplication") {
        merged
            .as_object_mut()
            .expect("merged production history sample is an object")
            .insert("pureIdleReplication".to_owned(), replication.clone());
    }
    Ok(merged)
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
        prepared_belt_flow: Option<BeltFlowAggregate>,
    ) -> anyhow::Result<()> {
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
        let elapsed = finite_number(base.get("elapsedSeconds")).unwrap_or(0.0);
        let recorded = finite_number(base.get("historyRecordedAt")).unwrap_or(0.0);
        if elapsed - recorded < SAMPLE_SECONDS - EPSILON {
            return Ok(());
        }
        let duration = SAMPLE_SECONDS.max(elapsed - recorded);
        let history = base
            .get("productionHistory")
            .and_then(Value::as_array)
            .ok_or_else(|| anyhow!("native production history is missing"))?;
        let previous = history.last();
        let pure_idle_replication = capture_pure_idle_replication(self, base);
        let previous_boundary = ((elapsed - duration).max(0.0) / 10.0).floor();
        let current_boundary = (elapsed.max(0.0) / 10.0).floor();
        let refresh =
            previous.is_none() || duration >= 10.0 || previous_boundary != current_boundary;
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
            let aggregate = if let Some(aggregate) = prepared_belt_flow {
                aggregate
            } else {
                crate::belts::aggregate_flow_from_state(self)?
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
        for (index, entity) in entities.iter().enumerate() {
            let Some(entity) = entity.as_object() else {
                continue;
            };
            // Kind, planet, building, recipe and resource are topology fields.
            // They already live in the compact columns and do not change during
            // an ordinary simulation revision. Reusing those symbols avoids
            // five hash-table lookups per entity in this once-per-second pass,
            // while the dynamic rate, utilization and inventories still come
            // from the just-simulated record below.
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
                && (kind == "machine" || kind == "vein" && self.entities.miner_counts[index] > 0.0)
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
            let rate = finite_number(entity.get("productionRate")).unwrap_or(0.0);
            if kind == "vein" {
                let Some(resource) = self.symbols.resolve(self.entities.resources[index]) else {
                    continue;
                };
                add_rate(&mut production, resource, rate);
                add_planet_rate(&mut planet_production, planet, resource, rate);
            } else if building == "orbital_collector" {
                let Some(item_id) = self.symbols.resolve(self.entities.stored_items[index]) else {
                    continue;
                };
                add_rate(&mut production, item_id, rate);
                add_planet_rate(&mut planet_production, planet, item_id, rate);
            } else if kind == "machine" {
                let recipe_symbol = self.entities.recipes[index];
                let Some(recipe) = *recipe_cache.entry(recipe_symbol).or_insert_with(|| {
                    self.symbols
                        .resolve(recipe_symbol)
                        .and_then(|id| self.catalog.recipes.get(id))
                }) else {
                    continue;
                };
                for input in &recipe.inputs {
                    let amount = rate * input.amount;
                    add_rate(&mut consumption, &input.item_id, amount);
                    add_planet_rate(&mut planet_consumption, planet, &input.item_id, amount);
                }
                for output in &recipe.outputs {
                    let amount = rate * output.amount;
                    add_rate(&mut production, &output.item_id, amount);
                    add_planet_rate(&mut planet_production, planet, &output.item_id, amount);
                }
            }
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
            let mut power_source_grids =
                HashSet::with_capacity(self.factory_topology.power_source_indices.len());
            for (index, value) in entities.iter().enumerate() {
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
                if kind != "power" && !(building_id == "ray_receiver" && recipe_id == "ray_power") {
                    continue;
                }
                let Some(entity) = value.as_object() else {
                    continue;
                };
                let planet_id = self
                    .symbols
                    .resolve(self.entities.planets[index])
                    .unwrap_or_default();
                let grid_id = entity
                    .get("powerGridId")
                    .and_then(Value::as_str)
                    .unwrap_or("grid-a");
                power_source_grids.insert((planet_id, grid_id));
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
            let mut building_cache =
                HashMap::<u32, Option<&crate::catalog::BuildingDefinition>>::new();
            let mut blocked = 0.0;
            for (index, value) in entities.iter().enumerate() {
                let Some(entity) = value.as_object() else {
                    continue;
                };
                let kind = self
                    .symbols
                    .resolve(self.entities.kinds[index])
                    .unwrap_or_default();
                let count = if kind == "machine" {
                    self.entities.machine_counts[index]
                } else if kind == "vein" && self.entities.miner_counts[index] > 0.0 {
                    self.entities.miner_counts[index]
                } else {
                    continue;
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
                        let recipe_symbol = self.entities.recipes[index];
                        let recipe = *recipe_cache.entry(recipe_symbol).or_insert_with(|| {
                            self.symbols
                                .resolve(recipe_symbol)
                                .and_then(|id| self.catalog.recipes.get(id))
                        });
                        let building_symbol = self.entities.buildings[index];
                        let building =
                            *building_cache.entry(building_symbol).or_insert_with(|| {
                                self.symbols
                                    .resolve(building_symbol)
                                    .and_then(|id| self.catalog.buildings.get(id))
                            });
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
                                            let planet_id = self
                                                .symbols
                                                .resolve(self.entities.planets[index])
                                                .unwrap_or_default();
                                            let grid_id = entity
                                                .get("powerGridId")
                                                .and_then(Value::as_str)
                                                .unwrap_or("grid-a");
                                            let power = if !power_source_grids
                                                .contains(&(planet_id, grid_id))
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
                if is_blocked {
                    blocked += count;
                }
            }
            blocked
        } else {
            0.0
        };
        profile_mark!("efficiency");
        let mut sample = serde_json::json!({
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
        if let Some(replication) = pure_idle_replication {
            sample
                .as_object_mut()
                .expect("production history sample is an object")
                .insert("pureIdleReplication".to_owned(), replication);
        }
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
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn compacted_bucket_retains_latest_replication_telemetry() {
        let first = serde_json::json!({
            "elapsedSeconds": 1,
            "sampleDurationSeconds": 1,
            "productionPerMinute": {},
            "consumptionPerMinute": {},
            "planetProductionPerMinute": {},
            "planetConsumptionPerMinute": {},
            "inventory": {},
            "generationKw": 0,
            "demandKw": 0,
            "pureIdleReplication": {
                "totalProduced": { "iron_ore": "1" },
                "researchInvestmentByItem": {},
                "structurePointsBySystem": {},
                "shellSailsBySystem": {},
            },
        });
        let latest_replication = serde_json::json!({
            "totalProduced": { "iron_ore": "2" },
            "researchInvestmentByItem": { "universe_matrix": "3" },
            "structurePointsBySystem": { "helios": 4 },
            "shellSailsBySystem": { "helios": 5 },
        });
        let second = serde_json::json!({
            "elapsedSeconds": 2,
            "sampleDurationSeconds": 1,
            "productionPerMinute": {},
            "consumptionPerMinute": {},
            "planetProductionPerMinute": {},
            "planetConsumptionPerMinute": {},
            "inventory": {},
            "generationKw": 0,
            "demandKw": 0,
            "pureIdleReplication": latest_replication,
        });

        let merged = merge_samples(&[first, second]).unwrap();
        assert_eq!(merged.get("pureIdleReplication"), Some(&latest_replication),);
    }
}
