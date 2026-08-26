use std::cmp::Ordering;
use std::collections::{BTreeMap, HashMap, HashSet};

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

fn inventory_from_state(base: &Map<String, Value>, entities: &[Value]) -> Value {
    let mut inventory = BTreeMap::new();
    for entity in entities.iter().filter_map(Value::as_object) {
        for record in [entity.get("inputs"), entity.get("outputs")] {
            let Some(record) = record.and_then(Value::as_object) else {
                continue;
            };
            for (item, amount) in record {
                if let Some(amount) = finite_number(Some(amount)) {
                    add_rate(&mut inventory, item, amount.floor());
                }
            }
        }
    }
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

fn planet_rates_to_value(values: BTreeMap<String, BTreeMap<String, f64>>) -> Value {
    Value::Object(
        values
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
        let entities = (0..self.entity_index.len())
            .map(|index| self.parse_entity(index))
            .collect::<anyhow::Result<Vec<_>>>()?;
        let belts = (0..self.belt_index.len())
            .map(|index| self.parse_belt(index))
            .collect::<anyhow::Result<Vec<_>>>()?;
        let (belt_capacity, belt_flow) = crate::belts::aggregate_flow(self, &belts)?;
        let extractor_output_capacities = ["mining_machine", "oil_extractor", "water_pump"]
            .into_iter()
            .filter_map(|id| {
                self.catalog
                    .buildings
                    .get(id)
                    .map(|building| (id.to_owned(), building.output_capacity))
            })
            .collect::<HashMap<_, _>>();
        let item_kinds = self
            .catalog
            .items
            .iter()
            .map(|(id, item)| (id.clone(), item.kind.clone()))
            .collect::<HashMap<_, _>>();
        let machine_recipes = entities
            .iter()
            .filter_map(Value::as_object)
            .filter(|entity| entity.get("kind").and_then(Value::as_str) == Some("machine"))
            .filter_map(|entity| entity.get("recipeId").and_then(Value::as_str))
            .filter_map(|id| {
                self.catalog
                    .recipes
                    .get(id)
                    .cloned()
                    .map(|recipe| (id.to_owned(), recipe))
            })
            .collect::<HashMap<_, _>>();
        let machine_buildings = entities
            .iter()
            .filter_map(Value::as_object)
            .filter(|entity| entity.get("kind").and_then(Value::as_str) == Some("machine"))
            .filter_map(|entity| entity.get("buildingId").and_then(Value::as_str))
            .filter_map(|id| {
                self.catalog
                    .buildings
                    .get(id)
                    .cloned()
                    .map(|building| (id.to_owned(), building))
            })
            .collect::<HashMap<_, _>>();
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
            if entities.is_empty() {
                inventory_from_planet_trays(base)
            } else {
                inventory_from_state(base, &entities)
            }
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
        let mut production = BTreeMap::<String, f64>::new();
        let mut consumption = BTreeMap::<String, f64>::new();
        let mut planet_production = BTreeMap::<String, BTreeMap<String, f64>>::new();
        let mut planet_consumption = BTreeMap::<String, BTreeMap<String, f64>>::new();
        for entity in entities.iter().filter_map(Value::as_object) {
            let planet = entity
                .get("planetId")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let rate = finite_number(entity.get("productionRate")).unwrap_or(0.0);
            if entity.get("kind").and_then(Value::as_str) == Some("vein") {
                let Some(resource) = entity.get("resourceId").and_then(Value::as_str) else {
                    continue;
                };
                add_rate(&mut production, resource, rate);
                add_rate(
                    planet_production.entry(planet.to_owned()).or_default(),
                    resource,
                    rate,
                );
            } else if entity.get("kind").and_then(Value::as_str) == Some("machine") {
                let Some(recipe) = entity
                    .get("recipeId")
                    .and_then(Value::as_str)
                    .and_then(|id| machine_recipes.get(id))
                else {
                    continue;
                };
                for input in &recipe.inputs {
                    let amount = rate * input.amount;
                    add_rate(&mut consumption, &input.item_id, amount);
                    add_rate(
                        planet_consumption.entry(planet.to_owned()).or_default(),
                        &input.item_id,
                        amount,
                    );
                }
                for output in &recipe.outputs {
                    let amount = rate * output.amount;
                    add_rate(&mut production, &output.item_id, amount);
                    add_rate(
                        planet_production.entry(planet.to_owned()).or_default(),
                        &output.item_id,
                        amount,
                    );
                }
            }
        }
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
        let productive = entities
            .iter()
            .filter_map(Value::as_object)
            .filter(|entity| {
                entity.get("kind").and_then(Value::as_str) == Some("machine")
                    || entity.get("kind").and_then(Value::as_str) == Some("vein")
                        && finite_number(entity.get("minerCount")).unwrap_or(0.0) > 0.0
            })
            .collect::<Vec<_>>();
        let units = |entity: &&Map<String, Value>| {
            if entity.get("kind").and_then(Value::as_str) == Some("vein") {
                finite_number(entity.get("minerCount")).unwrap_or(0.0)
            } else {
                finite_number(entity.get("machineCount")).unwrap_or(0.0)
            }
        };
        let productive_units = productive.iter().map(units).sum::<f64>();
        let utilized_units = productive
            .iter()
            .map(|entity| units(entity) * finite_number(entity.get("utilization")).unwrap_or(0.0))
            .sum::<f64>();
        let active = productive
            .iter()
            .filter(|entity| finite_number(entity.get("utilization")).unwrap_or(0.0) > EPSILON)
            .map(units)
            .sum::<f64>();
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
        let power_source_grids = entities
            .iter()
            .filter_map(Value::as_object)
            .filter(|entity| entity.get("kind").and_then(Value::as_str) == Some("power"))
            .map(|entity| {
                format!(
                    "{}|{}",
                    entity
                        .get("planetId")
                        .and_then(Value::as_str)
                        .unwrap_or_default(),
                    entity
                        .get("powerGridId")
                        .and_then(Value::as_str)
                        .unwrap_or("grid-a"),
                )
            })
            .collect::<HashSet<_>>();
        let blocked = productive
            .iter()
            .filter(|entity| {
                if entity.get("kind").and_then(Value::as_str) == Some("machine") {
                    let Some(recipe) = entity
                        .get("recipeId")
                        .and_then(Value::as_str)
                        .and_then(|id| machine_recipes.get(id))
                    else {
                        return true;
                    };
                    let Some(building) = entity
                        .get("buildingId")
                        .and_then(Value::as_str)
                        .and_then(|id| machine_buildings.get(id))
                    else {
                        return true;
                    };
                    if recipe
                        .required_tech_id
                        .as_deref()
                        .is_some_and(|id| !completed_tech.contains(id))
                    {
                        return true;
                    }
                    let count = finite_number(entity.get("machineCount")).unwrap_or(0.0);
                    let capacity =
                        stacked_capacity(building.output_capacity, count, production_buffer_limit);
                    let output_blocked = recipe.outputs.iter().any(|output| {
                        capacity
                            - entity
                                .get("outputs")
                                .and_then(Value::as_object)
                                .and_then(|values| values.get(&output.item_id))
                                .and_then(Value::as_f64)
                                .unwrap_or(0.0)
                            + EPSILON
                            < output.amount
                    });
                    if output_blocked {
                        return true;
                    }
                    let missing_input = recipe.inputs.iter().any(|input| {
                        entity
                            .get("inputs")
                            .and_then(Value::as_object)
                            .and_then(|values| values.get(&input.item_id))
                            .and_then(Value::as_f64)
                            .unwrap_or(0.0)
                            + EPSILON
                            < input.amount
                    });
                    if missing_input {
                        return true;
                    }
                    let grid = format!(
                        "{}|{}",
                        entity
                            .get("planetId")
                            .and_then(Value::as_str)
                            .unwrap_or_default(),
                        entity
                            .get("powerGridId")
                            .and_then(Value::as_str)
                            .unwrap_or("grid-a"),
                    );
                    let power = if !power_source_grids.contains(&grid) {
                        0.0
                    } else if let Some(power) = finite_number(entity.get("powerFactor")) {
                        power.clamp(0.0, 1.0)
                    } else {
                        base.get("powerGridMetrics")
                            .and_then(Value::as_object)
                            .and_then(|planets| {
                                entity
                                    .get("planetId")
                                    .and_then(Value::as_str)
                                    .and_then(|id| planets.get(id))
                            })
                            .and_then(Value::as_object)
                            .and_then(|grids| {
                                grids.get(
                                    entity
                                        .get("powerGridId")
                                        .and_then(Value::as_str)
                                        .unwrap_or("grid-a"),
                                )
                            })
                            .and_then(Value::as_object)
                            .and_then(|metric| finite_number(metric.get("powerFactor")))
                            .unwrap_or(0.0)
                    };
                    return power <= EPSILON;
                }
                let resource = entity
                    .get("resourceId")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let item_kind = item_kinds
                    .get(resource)
                    .map(String::as_str)
                    .unwrap_or("solid");
                let extractor_id = match resource {
                    "crude_oil" => "oil_extractor",
                    "water" | "sulfuric_acid" => "water_pump",
                    _ => "mining_machine",
                };
                let planet_id = entity
                    .get("planetId")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let ocean_type = base
                    .get("galaxy")
                    .and_then(Value::as_object)
                    .and_then(|galaxy| galaxy.get("profiles"))
                    .and_then(Value::as_object)
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
                if !infinite {
                    let remaining = finite_number(entity.get("resourceRemaining"))
                        .unwrap_or(0.0)
                        .floor()
                        .max(0.0);
                    let remainder = finite_number(entity.get("resourceDepletionRemainder"))
                        .unwrap_or(0.0)
                        .floor()
                        .clamp(0.0, 9.0);
                    if ((remaining * 10.0 - remainder).max(0.0) / resource_consumption_tenths)
                        .floor()
                        < 1.0
                    {
                        return true;
                    }
                }
                let count = finite_number(entity.get("minerCount")).unwrap_or(0.0);
                let capacity = stacked_capacity(
                    extractor_output_capacities
                        .get(extractor_id)
                        .copied()
                        .unwrap_or(0.0),
                    count,
                    production_buffer_limit,
                );
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
            })
            .map(units)
            .sum::<f64>();
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
        let mut next = history;
        next.push(sample);
        compact_history(&mut next)?;
        base.insert("productionHistory".to_owned(), Value::Array(next));
        base.insert("historyRecordedAt".to_owned(), Value::from(elapsed));
        Ok(())
    }
}
