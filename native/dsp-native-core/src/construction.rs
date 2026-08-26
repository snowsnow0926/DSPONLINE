use std::collections::{BTreeMap, HashMap};

use anyhow::{anyhow, bail};
use serde_json::{Map, Number, Value};

use crate::catalog::ItemAmount;
use crate::state::CoreState;

const EPSILON: f64 = 0.0001;
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

#[derive(Debug, Clone)]
enum Step {
    Material {
        recipe_id: String,
        batches: f64,
        output_amount: f64,
    },
    Building {
        construction_id: String,
    },
}

#[derive(Debug, Clone)]
pub(crate) struct QuantumDemand {
    pub key: String,
    pub entity_id: String,
    pub item_id: String,
    pub amount: u64,
}

fn finite_number(value: Option<&Value>) -> f64 {
    value
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
        .unwrap_or(0.0)
}

fn string_at<'a>(object: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    object.get(key).and_then(Value::as_str)
}

fn set_number(object: &mut Map<String, Value>, key: &str, value: f64) -> anyhow::Result<()> {
    object.insert(
        key.to_owned(),
        Number::from_f64(value)
            .map(Value::Number)
            .ok_or_else(|| anyhow!("native construction produced a non-finite number"))?,
    );
    Ok(())
}

fn floor_amount(value: f64) -> f64 {
    if value.is_finite() {
        value.floor().clamp(0.0, MAX_SAFE_INTEGER)
    } else {
        0.0
    }
}

fn inventory_amount(inventory: &Map<String, Value>, item_id: &str) -> f64 {
    floor_amount(finite_number(inventory.get(item_id)))
}

fn set_inventory_amount(
    inventory: &mut Map<String, Value>,
    item_id: &str,
    amount: f64,
) -> anyhow::Result<()> {
    inventory.insert(
        item_id.to_owned(),
        Number::from_f64(floor_amount(amount))
            .map(Value::Number)
            .ok_or_else(|| anyhow!("native construction inventory is non-finite"))?,
    );
    Ok(())
}

fn automation(base: &Map<String, Value>) -> anyhow::Result<&Map<String, Value>> {
    base.get("constructionAutomation")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("native construction automation state is missing"))
}

fn completed_tech(base: &Map<String, Value>, id: &str) -> bool {
    base.get("research")
        .and_then(Value::as_object)
        .and_then(|research| research.get("completedTechIds"))
        .and_then(Value::as_array)
        .is_some_and(|ids| ids.iter().any(|value| value.as_str() == Some(id)))
}

fn cycle_seconds(base: &Map<String, Value>) -> f64 {
    if completed_tech(base, "construction_capacity_2") {
        1.0
    } else if completed_tech(base, "construction_capacity_1") {
        2.5
    } else {
        5.0
    }
}

fn parse_step(value: &Value) -> anyhow::Result<Step> {
    let step = value
        .as_object()
        .ok_or_else(|| anyhow!("native construction step is invalid"))?;
    match string_at(step, "kind") {
        Some("material") => Ok(Step::Material {
            recipe_id: string_at(step, "recipeId")
                .ok_or_else(|| anyhow!("native construction material recipe is missing"))?
                .to_owned(),
            batches: floor_amount(finite_number(step.get("batches"))),
            output_amount: floor_amount(finite_number(step.get("outputAmount"))),
        }),
        Some("building") => Ok(Step::Building {
            construction_id: string_at(step, "constructionId")
                .ok_or_else(|| anyhow!("native construction building ID is missing"))?
                .to_owned(),
        }),
        Some("fleet") => bail!("native construction fleet steps are not supported yet"),
        _ => bail!("native construction step kind is invalid"),
    }
}

fn requirements(state: &CoreState, step: &Step) -> anyhow::Result<Vec<ItemAmount>> {
    match step {
        Step::Building { construction_id } => state
            .catalog
            .constructions
            .get(construction_id)
            .map(|definition| definition.costs.clone())
            .ok_or_else(|| anyhow!("native construction definition is missing")),
        Step::Material {
            recipe_id, batches, ..
        } => state
            .catalog
            .recipes
            .get(recipe_id)
            .map(|recipe| {
                recipe
                    .inputs
                    .iter()
                    .map(|input| ItemAmount {
                        item_id: input.item_id.clone(),
                        amount: floor_amount(input.amount * batches),
                    })
                    .collect()
            })
            .ok_or_else(|| anyhow!("native construction material recipe is missing")),
    }
}

fn step_duration(state: &CoreState, base: &Map<String, Value>, step: &Step) -> anyhow::Result<f64> {
    match step {
        Step::Building { .. } => Ok(cycle_seconds(base)),
        Step::Material {
            recipe_id,
            output_amount,
            ..
        } => {
            if !state.catalog.recipes.contains_key(recipe_id) {
                bail!("native construction material recipe is missing");
            }
            Ok((0.1 * cycle_seconds(base) / 5.0 * output_amount).max(0.01))
        }
    }
}

fn tray<'a>(base: &'a Map<String, Value>, planet_id: &str) -> Option<&'a Map<String, Value>> {
    if base.get("activePlanetId").and_then(Value::as_str) == Some(planet_id) {
        base.get("tray").and_then(Value::as_object)
    } else {
        base.get("planetTrays")
            .and_then(Value::as_object)
            .and_then(|trays| trays.get(planet_id))
            .and_then(Value::as_object)
    }
}

fn tray_mut<'a>(
    base: &'a mut Map<String, Value>,
    planet_id: &str,
) -> Option<&'a mut Map<String, Value>> {
    if base.get("activePlanetId").and_then(Value::as_str) == Some(planet_id) {
        base.get_mut("tray").and_then(Value::as_object_mut)
    } else {
        base.get_mut("planetTrays")
            .and_then(Value::as_object_mut)
            .and_then(|trays| trays.get_mut(planet_id))
            .and_then(Value::as_object_mut)
    }
}

fn quantum_buffer<'a>(
    automation: &'a Map<String, Value>,
    entity_id: &str,
) -> Option<&'a Map<String, Value>> {
    automation
        .get("quantumMaterialBuffer")
        .and_then(Value::as_object)
        .and_then(|buffers| buffers.get(entity_id))
        .and_then(Value::as_object)
}

fn current_stock(base: &Map<String, Value>, construction_id: &str) -> f64 {
    base.get("construction")
        .and_then(Value::as_object)
        .and_then(|construction| construction.get(construction_id))
        .map(|value| floor_amount(finite_number(Some(value))))
        .unwrap_or(0.0)
}

fn pending_stock(state: &CoreState, automation: &Map<String, Value>, construction_id: &str) -> f64 {
    automation
        .get("jobs")
        .and_then(Value::as_object)
        .into_iter()
        .flat_map(|jobs| jobs.values())
        .filter_map(Value::as_object)
        .filter(|job| string_at(job, "constructionId") == Some(construction_id))
        .map(|_| {
            state
                .catalog
                .constructions
                .get(construction_id)
                .map(|definition| definition.output_amount)
                .unwrap_or(0.0)
        })
        .sum()
}

pub(crate) fn has_deficit(state: &CoreState, base: &Map<String, Value>) -> bool {
    let Ok(automation) = automation(base) else {
        return false;
    };
    if automation.get("enabled").and_then(Value::as_bool) != Some(true) {
        return false;
    }
    if automation
        .get("jobs")
        .and_then(Value::as_object)
        .is_some_and(|jobs| !jobs.is_empty())
        || automation
            .get("quantumMaterialBuffer")
            .and_then(Value::as_object)
            .is_some_and(|buffers| !buffers.is_empty())
    {
        return true;
    }
    automation
        .get("targetStock")
        .and_then(Value::as_object)
        .is_some_and(|targets| {
            targets.iter().any(|(construction_id, target)| {
                floor_amount(finite_number(Some(target)))
                    > current_stock(base, construction_id)
                        + pending_stock(state, automation, construction_id)
            })
        })
}

fn requirements_available(
    job_inventory: &Map<String, Value>,
    tray: &Map<String, Value>,
    quantum: &Map<String, Value>,
    requirements: &[ItemAmount],
) -> bool {
    requirements.iter().all(|requirement| {
        let required = floor_amount(requirement.amount);
        inventory_amount(job_inventory, &requirement.item_id)
            + inventory_amount(tray, &requirement.item_id)
            + inventory_amount(quantum, &requirement.item_id)
            >= required
    })
}

fn consume_requirements(
    job_inventory: &mut Map<String, Value>,
    tray: &mut Map<String, Value>,
    quantum: &mut Map<String, Value>,
    requirements: &[ItemAmount],
) -> anyhow::Result<bool> {
    if !requirements_available(job_inventory, tray, quantum, requirements) {
        return Ok(false);
    }
    for requirement in requirements {
        let mut remaining = floor_amount(requirement.amount);
        let in_job = inventory_amount(job_inventory, &requirement.item_id);
        let from_job = remaining.min(in_job);
        set_inventory_amount(job_inventory, &requirement.item_id, in_job - from_job)?;
        remaining -= from_job;
        let in_tray = inventory_amount(tray, &requirement.item_id);
        let from_tray = remaining.min(in_tray);
        set_inventory_amount(tray, &requirement.item_id, in_tray - from_tray)?;
        remaining -= from_tray;
        let in_quantum = inventory_amount(quantum, &requirement.item_id);
        set_inventory_amount(quantum, &requirement.item_id, in_quantum - remaining)?;
    }
    Ok(true)
}

fn normalize_quantum_buffers(buffers: &mut Map<String, Value>) {
    for value in buffers.values_mut() {
        if let Some(inventory) = value.as_object_mut() {
            inventory.retain(|_, amount| floor_amount(finite_number(Some(amount))) > 0.0);
        }
    }
    buffers.retain(|_, value| {
        value
            .as_object()
            .is_some_and(|inventory| !inventory.is_empty())
    });
}

fn complete_step(
    state: &CoreState,
    base: &mut Map<String, Value>,
    automation: &mut Map<String, Value>,
    buffers: &mut Map<String, Value>,
    entity_id: &str,
    planet_id: &str,
    job: &mut Map<String, Value>,
    step: &Step,
) -> anyhow::Result<bool> {
    let requirements = requirements(state, step)?;
    let mut job_inventory = job
        .remove("inventory")
        .and_then(|value| value.as_object().cloned())
        .ok_or_else(|| anyhow!("native construction job inventory is missing"))?;
    let mut quantum = buffers
        .remove(entity_id)
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    let consumed = {
        let tray = tray_mut(base, planet_id)
            .ok_or_else(|| anyhow!("native construction planet tray is missing"))?;
        consume_requirements(&mut job_inventory, tray, &mut quantum, &requirements)?
    };
    if !consumed {
        job.insert("inventory".to_owned(), Value::Object(job_inventory));
        if !quantum.is_empty() {
            buffers.insert(entity_id.to_owned(), Value::Object(quantum));
        }
        return Ok(false);
    }
    match step {
        Step::Building { construction_id } => {
            let definition = state
                .catalog
                .constructions
                .get(construction_id)
                .ok_or_else(|| anyhow!("native construction definition is missing"))?;
            let construction = base
                .get_mut("construction")
                .and_then(Value::as_object_mut)
                .ok_or_else(|| anyhow!("native construction inventory is missing"))?;
            let current = floor_amount(finite_number(construction.get(construction_id)));
            set_inventory_amount(
                construction,
                construction_id,
                current + definition.output_amount,
            )?;
            let total = finite_number(automation.get("totalCrafted")) + definition.output_amount;
            set_number(automation, "totalCrafted", total)?;
            automation.insert(
                "lastCraftedId".to_owned(),
                Value::from(construction_id.clone()),
            );
            job_inventory.clear();
        }
        Step::Material {
            recipe_id, batches, ..
        } => {
            let recipe = state
                .catalog
                .recipes
                .get(recipe_id)
                .ok_or_else(|| anyhow!("native construction material recipe is missing"))?;
            for output in &recipe.outputs {
                let produced = floor_amount(output.amount * batches);
                let current = inventory_amount(&job_inventory, &output.item_id);
                set_inventory_amount(&mut job_inventory, &output.item_id, current + produced)?;
                let total_produced = base
                    .get_mut("totalProduced")
                    .and_then(Value::as_object_mut)
                    .ok_or_else(|| anyhow!("native total production record is missing"))?;
                let current_total =
                    floor_amount(finite_number(total_produced.get(&output.item_id)));
                set_inventory_amount(total_produced, &output.item_id, current_total + produced)?;
            }
        }
    }
    job.insert("inventory".to_owned(), Value::Object(job_inventory));
    if !quantum.is_empty() {
        buffers.insert(entity_id.to_owned(), Value::Object(quantum));
    }
    normalize_quantum_buffers(buffers);
    Ok(true)
}

pub(crate) fn run_centers(
    state: &CoreState,
    base: &mut Map<String, Value>,
    entities: &mut [Value],
    seconds: f64,
    power_factors: &HashMap<usize, f64>,
) -> anyhow::Result<()> {
    let mut automation = base
        .remove("constructionAutomation")
        .and_then(|value| value.as_object().cloned())
        .ok_or_else(|| anyhow!("native construction automation state is missing"))?;
    let enabled = automation.get("enabled").and_then(Value::as_bool) == Some(true);
    let mut jobs = automation
        .remove("jobs")
        .and_then(|value| value.as_object().cloned())
        .ok_or_else(|| anyhow!("native construction jobs are missing"))?;
    let mut buffers = automation
        .remove("quantumMaterialBuffer")
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    for entity_index in 0..entities.len() {
        let snapshot = entities[entity_index]
            .as_object()
            .ok_or_else(|| anyhow!("native construction entity is invalid"))?
            .clone();
        if string_at(&snapshot, "buildingId") != Some("construction_center") {
            continue;
        }
        let entity_id = string_at(&snapshot, "id").unwrap_or_default().to_owned();
        let planet_id = string_at(&snapshot, "planetId")
            .unwrap_or_default()
            .to_owned();
        let power_factor = power_factors.get(&entity_index).copied().unwrap_or(0.0);
        let center = entities[entity_index]
            .as_object_mut()
            .ok_or_else(|| anyhow!("native construction center is invalid"))?;
        if power_factors.contains_key(&entity_index) {
            set_number(
                center,
                "powerFactor",
                (power_factor * 10_000.0).round() / 10_000.0,
            )?;
        } else {
            center.remove("powerFactor");
        }
        if !enabled || power_factor <= EPSILON {
            set_number(center, "utilization", 0.0)?;
            set_number(center, "productionRate", 0.0)?;
            set_number(center, "progress", 0.0)?;
            continue;
        }
        let Some(mut job) = jobs
            .remove(&entity_id)
            .and_then(|value| value.as_object().cloned())
        else {
            set_number(center, "utilization", 0.0)?;
            set_number(center, "productionRate", 0.0)?;
            set_number(center, "progress", 0.0)?;
            continue;
        };
        let steps = job
            .get("steps")
            .and_then(Value::as_array)
            .cloned()
            .ok_or_else(|| anyhow!("native construction job steps are missing"))?;
        let machine_count = finite_number(center.get("machineCount")).max(1.0);
        let mut remaining_work = seconds.max(0.0) * machine_count * power_factor;
        let mut completed = 0.0;
        let mut worked = false;
        while remaining_work > EPSILON {
            let step_index = floor_amount(finite_number(job.get("stepIndex"))) as usize;
            let Some(step_value) = steps.get(step_index) else {
                break;
            };
            let step = parse_step(step_value)?;
            let requirements = requirements(state, &step)?;
            let job_inventory = job
                .get("inventory")
                .and_then(Value::as_object)
                .ok_or_else(|| anyhow!("native construction job inventory is missing"))?;
            let empty_quantum = Map::new();
            let quantum = buffers
                .get(&entity_id)
                .and_then(Value::as_object)
                .unwrap_or(&empty_quantum);
            let tray = tray(base, &planet_id)
                .ok_or_else(|| anyhow!("native construction planet tray is missing"))?;
            if !requirements_available(job_inventory, tray, quantum, &requirements) {
                break;
            }
            let duration = step_duration(state, base, &step)?;
            let elapsed = finite_number(job.get("elapsedSeconds"));
            let needed = (duration - elapsed).max(0.0);
            let used = remaining_work.min(needed);
            let next_elapsed = ((elapsed + used) * 1_000_000.0).round() / 1_000_000.0;
            set_number(&mut job, "elapsedSeconds", next_elapsed)?;
            remaining_work -= used;
            worked |= used > EPSILON;
            set_number(
                center,
                "progress",
                ((next_elapsed / duration).min(1.0) * 1_000_000.0).round() / 1_000_000.0,
            )?;
            if next_elapsed + EPSILON < duration {
                break;
            }
            if !complete_step(
                state,
                base,
                &mut automation,
                &mut buffers,
                &entity_id,
                &planet_id,
                &mut job,
                &step,
            )? {
                break;
            }
            if let Step::Building { construction_id } = &step {
                completed += state
                    .catalog
                    .constructions
                    .get(construction_id)
                    .map(|definition| definition.output_amount)
                    .unwrap_or(0.0);
            }
            set_number(&mut job, "stepIndex", step_index as f64 + 1.0)?;
            set_number(&mut job, "elapsedSeconds", 0.0)?;
            set_number(center, "progress", 0.0)?;
            if step_index + 1 >= steps.len() {
                job.clear();
                break;
            }
        }
        set_number(
            center,
            "utilization",
            if worked || completed > 0.0 {
                power_factor
            } else {
                0.0
            },
        )?;
        set_number(
            center,
            "productionRate",
            if seconds > EPSILON {
                (completed * 60.0 / seconds * 100.0).round() / 100.0
            } else {
                0.0
            },
        )?;
        if !job.is_empty() {
            jobs.insert(entity_id, Value::Object(job));
        }
    }
    automation.insert("jobs".to_owned(), Value::Object(jobs));
    normalize_quantum_buffers(&mut buffers);
    if !buffers.is_empty() {
        automation.insert("quantumMaterialBuffer".to_owned(), Value::Object(buffers));
    }
    base.insert(
        "constructionAutomation".to_owned(),
        Value::Object(automation),
    );
    Ok(())
}

pub(crate) fn quantum_demands(
    state: &CoreState,
    base: &Map<String, Value>,
    entities: &[Value],
) -> anyhow::Result<Vec<QuantumDemand>> {
    let automation = automation(base)?;
    if automation.get("enabled").and_then(Value::as_bool) != Some(true)
        || automation
            .get("quantumSourceEnabled")
            .and_then(Value::as_bool)
            != Some(true)
    {
        return Ok(Vec::new());
    }
    let jobs = automation
        .get("jobs")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("native construction jobs are missing"))?;
    let mut centers = entities
        .iter()
        .filter_map(Value::as_object)
        .filter(|entity| string_at(entity, "buildingId") == Some("construction_center"))
        .collect::<Vec<_>>();
    centers.sort_by(|left, right| {
        string_at(left, "id")
            .unwrap_or_default()
            .cmp(string_at(right, "id").unwrap_or_default())
    });
    let mut result = Vec::new();
    for center in centers {
        if center
            .get("powerFactor")
            .and_then(Value::as_f64)
            .is_some_and(|factor| factor <= EPSILON)
        {
            continue;
        }
        let entity_id = string_at(center, "id").unwrap_or_default();
        let planet_id = string_at(center, "planetId").unwrap_or_default();
        let Some(job) = jobs.get(entity_id).and_then(Value::as_object) else {
            continue;
        };
        let step_index = floor_amount(finite_number(job.get("stepIndex"))) as usize;
        let Some(step) = job
            .get("steps")
            .and_then(Value::as_array)
            .and_then(|steps| steps.get(step_index))
        else {
            continue;
        };
        let step = parse_step(step)?;
        let job_inventory = job
            .get("inventory")
            .and_then(Value::as_object)
            .ok_or_else(|| anyhow!("native construction job inventory is missing"))?;
        let empty = Map::new();
        let tray = tray(base, planet_id).unwrap_or(&empty);
        let quantum = quantum_buffer(automation, entity_id).unwrap_or(&empty);
        let mut missing = BTreeMap::<String, f64>::new();
        for requirement in requirements(state, &step)? {
            if matches!(
                requirement.item_id.as_str(),
                "logistics_drone" | "logistics_vessel"
            ) {
                continue;
            }
            let required = floor_amount(requirement.amount);
            let available = inventory_amount(job_inventory, &requirement.item_id)
                + inventory_amount(tray, &requirement.item_id)
                + inventory_amount(quantum, &requirement.item_id);
            let amount = (required - available).max(0.0);
            if amount > 0.0 {
                *missing.entry(requirement.item_id).or_default() += amount;
            }
        }
        for (item_id, amount) in missing {
            let amount = floor_amount(amount) as u64;
            if amount > 0 {
                result.push(QuantumDemand {
                    key: format!("construction-direct:{entity_id}:{item_id}"),
                    entity_id: entity_id.to_owned(),
                    item_id,
                    amount,
                });
            }
        }
    }
    Ok(result)
}

pub(crate) fn apply_quantum_delivery(
    base: &mut Map<String, Value>,
    demand: &QuantumDemand,
    delivered: u64,
) -> anyhow::Result<u64> {
    let amount = delivered.min(demand.amount);
    if amount < 1 {
        return Ok(0);
    }
    let automation = base
        .get_mut("constructionAutomation")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| anyhow!("native construction automation state is missing"))?;
    if !automation.contains_key("quantumMaterialBuffer") {
        automation.insert(
            "quantumMaterialBuffer".to_owned(),
            Value::Object(Map::new()),
        );
    }
    let buffers = automation
        .get_mut("quantumMaterialBuffer")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| anyhow!("native construction quantum buffers are invalid"))?;
    if !buffers.contains_key(&demand.entity_id) {
        buffers.insert(demand.entity_id.clone(), Value::Object(Map::new()));
    }
    let inventory = buffers
        .get_mut(&demand.entity_id)
        .and_then(Value::as_object_mut)
        .ok_or_else(|| anyhow!("native construction quantum buffer is invalid"))?;
    let current = inventory_amount(inventory, &demand.item_id);
    set_inventory_amount(inventory, &demand.item_id, current + amount as f64)?;
    Ok(amount)
}

pub(crate) fn is_operating_blocked(
    state: &CoreState,
    entity: &Map<String, Value>,
) -> anyhow::Result<bool> {
    let base = state.base_value();
    let automation = automation(base)?;
    if automation.get("enabled").and_then(Value::as_bool) != Some(true) || !has_deficit(state, base)
    {
        return Ok(false);
    }
    if finite_number(entity.get("powerFactor")) <= EPSILON {
        return Ok(true);
    }
    let entity_id = string_at(entity, "id").unwrap_or_default();
    let planet_id = string_at(entity, "planetId").unwrap_or_default();
    let Some(job) = automation
        .get("jobs")
        .and_then(Value::as_object)
        .and_then(|jobs| jobs.get(entity_id))
        .and_then(Value::as_object)
    else {
        return Ok(false);
    };
    let step_index = floor_amount(finite_number(job.get("stepIndex"))) as usize;
    let Some(step) = job
        .get("steps")
        .and_then(Value::as_array)
        .and_then(|steps| steps.get(step_index))
    else {
        return Ok(true);
    };
    let step = parse_step(step)?;
    let requirements = requirements(state, &step)?;
    let empty = Map::new();
    let inventory = job
        .get("inventory")
        .and_then(Value::as_object)
        .unwrap_or(&empty);
    let planet_tray = tray(base, planet_id).unwrap_or(&empty);
    let quantum = quantum_buffer(automation, entity_id).unwrap_or(&empty);
    Ok(!requirements_available(
        inventory,
        planet_tray,
        quantum,
        &requirements,
    ))
}

pub(crate) fn admission_reason(state: &CoreState) -> anyhow::Result<Option<&'static str>> {
    let base = state.base_value();
    let automation = automation(base)?;
    let jobs = automation
        .get("jobs")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("native construction jobs are missing"))?;
    let entity_ids = (0..state.entity_index.len())
        .map(|index| state.parse_entity(index))
        .collect::<anyhow::Result<Vec<_>>>()?
        .into_iter()
        .filter_map(|entity| {
            let entity = entity.as_object()?.clone();
            (string_at(&entity, "buildingId") == Some("construction_center"))
                .then(|| string_at(&entity, "id").unwrap_or_default().to_owned())
        })
        .collect::<std::collections::HashSet<_>>();
    let buffers = automation
        .get("quantumMaterialBuffer")
        .and_then(Value::as_object);
    if buffers.is_some_and(|buffers| {
        buffers.iter().any(|(entity_id, inventory)| {
            !entity_ids.contains(entity_id)
                || !jobs.contains_key(entity_id)
                || inventory.as_object().is_none_or(|inventory| {
                    inventory
                        .values()
                        .any(|amount| floor_amount(finite_number(Some(amount))) < 1.0)
                })
        })
    }) {
        return Ok(Some("construction-quantum-buffer-unsupported"));
    }
    for (entity_id, job) in jobs {
        if !entity_ids.contains(entity_id) {
            return Ok(Some("construction-job-center-missing"));
        }
        let Some(job) = job.as_object() else {
            return Ok(Some("construction-job-invalid"));
        };
        let Some(construction_id) = string_at(job, "constructionId") else {
            return Ok(Some("construction-job-invalid"));
        };
        if !state.catalog.constructions.contains_key(construction_id)
            || job.get("inventory").and_then(Value::as_object).is_none()
        {
            return Ok(Some("construction-job-invalid"));
        }
        let Some(steps) = job.get("steps").and_then(Value::as_array) else {
            return Ok(Some("construction-job-invalid"));
        };
        let step_index = floor_amount(finite_number(job.get("stepIndex"))) as usize;
        if steps.len() != 1 || step_index != 0 {
            return Ok(Some("construction-step-unsupported"));
        }
        let step = match parse_step(&steps[0]) {
            Ok(Step::Building {
                construction_id: step_id,
            }) if step_id == construction_id => Step::Building {
                construction_id: step_id,
            },
            _ => return Ok(Some("construction-step-unsupported")),
        };
        let requirements = match requirements(state, &step) {
            Ok(requirements) => requirements,
            Err(_) => return Ok(Some("construction-step-invalid")),
        };
        let required_by_item = requirements
            .iter()
            .map(|requirement| {
                (
                    requirement.item_id.as_str(),
                    floor_amount(requirement.amount),
                )
            })
            .collect::<HashMap<_, _>>();
        let inventory = job
            .get("inventory")
            .and_then(Value::as_object)
            .expect("validated construction inventory");
        if inventory.iter().any(|(item_id, amount)| {
            floor_amount(finite_number(Some(amount)))
                > required_by_item
                    .get(item_id.as_str())
                    .copied()
                    .unwrap_or(0.0)
        }) {
            return Ok(Some("construction-job-excess-unsupported"));
        }
        let empty = Map::new();
        let buffer = buffers
            .and_then(|buffers| buffers.get(entity_id))
            .and_then(Value::as_object)
            .unwrap_or(&empty);
        let planet_id = (0..state.entity_index.len())
            .find_map(|index| {
                let entity = state.parse_entity(index).ok()?;
                let entity = entity.as_object()?;
                (string_at(entity, "id") == Some(entity_id.as_str()))
                    .then(|| string_at(entity, "planetId").unwrap_or_default().to_owned())
            })
            .unwrap_or_default();
        let empty_tray = Map::new();
        let planet_tray = tray(base, &planet_id).unwrap_or(&empty_tray);
        if buffer.iter().any(|(item_id, amount)| {
            let required = required_by_item
                .get(item_id.as_str())
                .copied()
                .unwrap_or(0.0);
            let ordinary_available =
                inventory_amount(inventory, item_id) + inventory_amount(planet_tray, item_id);
            floor_amount(finite_number(Some(amount))) > (required - ordinary_available).max(0.0)
        }) {
            return Ok(Some("construction-quantum-excess-unsupported"));
        }
    }
    if automation
        .get("targetStock")
        .and_then(Value::as_object)
        .is_some_and(|targets| {
            targets.iter().any(|(construction_id, target)| {
                let target = floor_amount(finite_number(Some(target)));
                !state.catalog.constructions.contains_key(construction_id)
                    || target
                        > current_stock(base, construction_id)
                            + pending_stock(state, automation, construction_id)
            })
        })
    {
        return Ok(Some("construction-planning-unsupported"));
    }
    Ok(None)
}
