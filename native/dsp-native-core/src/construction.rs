use std::collections::{BTreeMap, BTreeSet, HashMap};

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
        output_item_id: String,
        output_amount: f64,
    },
    Building {
        construction_id: String,
    },
    Fleet {
        item_id: String,
        amount: f64,
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
    let value = Number::from_f64(value)
        .map(Value::Number)
        .ok_or_else(|| anyhow!("native construction produced a non-finite number"))?;
    if let Some(target) = object.get_mut(key) {
        *target = value;
    } else {
        object.insert(key.to_owned(), value);
    }
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
            output_item_id: string_at(step, "outputItemId")
                .ok_or_else(|| anyhow!("native construction material output item is missing"))?
                .to_owned(),
            output_amount: floor_amount(finite_number(step.get("outputAmount"))),
        }),
        Some("building") => Ok(Step::Building {
            construction_id: string_at(step, "constructionId")
                .ok_or_else(|| anyhow!("native construction building ID is missing"))?
                .to_owned(),
        }),
        Some("fleet") => Ok(Step::Fleet {
            item_id: string_at(step, "itemId")
                .ok_or_else(|| anyhow!("native construction fleet item is missing"))?
                .to_owned(),
            amount: floor_amount(finite_number(step.get("amount"))),
        }),
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
            recipe_id,
            batches,
            output_item_id,
            ..
        } => state
            .catalog
            .recipes
            .get(recipe_id)
            .filter(|recipe| {
                recipe
                    .outputs
                    .iter()
                    .any(|output| output.item_id == *output_item_id)
            })
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
        Step::Fleet { item_id, amount } => Ok(vec![ItemAmount {
            item_id: item_id.clone(),
            amount: *amount,
        }]),
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
        Step::Fleet { .. } => Ok(0.01),
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

fn entity_grid_id(entity: &Map<String, Value>) -> &str {
    string_at(entity, "powerGridId").unwrap_or("grid-a")
}

/// A construction center with no possible producer on its planet/grid is an
/// exact dormant domain: both authorities only clear its runtime power and
/// activity fields, without parsing, planning or consuming its saved job.
/// Keep this proof deliberately conservative. A potential ray receiver or any
/// power entity makes the domain active even when it currently lacks fuel.
fn all_centers_provably_unpowered(state: &CoreState) -> anyhow::Result<bool> {
    let relevant = (0..state.entity_index.len())
        .filter(|&index| {
            let building = state.symbols.resolve(state.entities.buildings[index]);
            let kind = state.symbols.resolve(state.entities.kinds[index]);
            let recipe = state.symbols.resolve(state.entities.recipes[index]);
            building == Some("construction_center")
                || kind == Some("power")
                || building == Some("ray_receiver") && recipe == Some("ray_power")
        })
        .map(|index| state.parse_entity(index))
        .collect::<anyhow::Result<Vec<_>>>()?;
    let center_grids = relevant
        .iter()
        .filter_map(Value::as_object)
        .filter(|entity| string_at(entity, "buildingId") == Some("construction_center"))
        .map(|entity| {
            (
                string_at(entity, "planetId").unwrap_or_default().to_owned(),
                entity_grid_id(entity).to_owned(),
            )
        })
        .collect::<std::collections::HashSet<_>>();
    if center_grids.is_empty() {
        return Ok(false);
    }
    let has_possible_source = relevant.iter().filter_map(Value::as_object).any(|entity| {
        let key = (
            string_at(entity, "planetId").unwrap_or_default().to_owned(),
            entity_grid_id(entity).to_owned(),
        );
        center_grids.contains(&key)
            && (string_at(entity, "kind") == Some("power")
                || (string_at(entity, "buildingId") == Some("ray_receiver")
                    && string_at(entity, "recipeId") == Some("ray_power")))
    });
    Ok(!has_possible_source)
}

fn current_stock(base: &Map<String, Value>, construction_id: &str) -> f64 {
    let inventory = if matches!(construction_id, "logistics_drone" | "logistics_vessel") {
        base.get("portableFleet")
    } else {
        base.get("construction")
    };
    inventory
        .and_then(Value::as_object)
        .and_then(|inventory| inventory.get(construction_id))
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
            if matches!(construction_id, "logistics_drone" | "logistics_vessel") {
                state
                    .catalog
                    .recipes
                    .get(construction_id)
                    .and_then(|recipe| {
                        recipe
                            .outputs
                            .iter()
                            .find(|output| output.item_id == construction_id)
                    })
                    .map(|output| output.amount)
                    .unwrap_or(0.0)
            } else {
                state
                    .catalog
                    .constructions
                    .get(construction_id)
                    .map(|definition| definition.output_amount)
                    .unwrap_or(0.0)
            }
        })
        .sum()
}

fn pending_stock_in_jobs(
    state: &CoreState,
    jobs: &Map<String, Value>,
    construction_id: &str,
) -> f64 {
    jobs.values()
        .filter_map(Value::as_object)
        .filter(|job| string_at(job, "constructionId") == Some(construction_id))
        .map(|_| {
            if matches!(construction_id, "logistics_drone" | "logistics_vessel") {
                state
                    .catalog
                    .recipes
                    .get(construction_id)
                    .and_then(|recipe| {
                        recipe
                            .outputs
                            .iter()
                            .find(|output| output.item_id == construction_id)
                    })
                    .map(|output| output.amount)
                    .unwrap_or(0.0)
            } else {
                state
                    .catalog
                    .constructions
                    .get(construction_id)
                    .map(|definition| definition.output_amount)
                    .unwrap_or(0.0)
            }
        })
        .sum()
}

fn select_target(
    state: &CoreState,
    base: &Map<String, Value>,
    automation: &Map<String, Value>,
    jobs: &Map<String, Value>,
) -> Option<crate::construction_planner::Target> {
    let targets = crate::construction_planner::targets(state);
    if targets.is_empty() {
        return None;
    }
    let raw_cursor = finite_number(automation.get("cursor")).trunc();
    let cursor = if raw_cursor.is_finite() {
        raw_cursor.rem_euclid(targets.len() as f64) as usize
    } else {
        0
    };
    let target_stock = automation.get("targetStock").and_then(Value::as_object)?;
    for offset in 0..targets.len() {
        let target = &targets[(cursor + offset) % targets.len()];
        let desired = floor_amount(finite_number(target_stock.get(&target.id)));
        let current =
            current_stock(base, &target.id) + pending_stock_in_jobs(state, jobs, &target.id);
        if desired > current && crate::construction_planner::target_is_unlocked(base, target) {
            return Some(target.clone());
        }
    }
    None
}

fn planned_step_value(step: crate::construction_planner::PlannedStep) -> Value {
    match step {
        crate::construction_planner::PlannedStep::Material {
            recipe_id,
            batches,
            output_item_id,
            output_amount,
        } => serde_json::json!({
            "kind": "material",
            "recipeId": recipe_id,
            "batches": batches,
            "outputItemId": output_item_id,
            "outputAmount": output_amount,
        }),
        crate::construction_planner::PlannedStep::Building { construction_id } => {
            serde_json::json!({
                "kind": "building",
                "constructionId": construction_id,
            })
        }
        crate::construction_planner::PlannedStep::Fleet { item_id, amount } => serde_json::json!({
            "kind": "fleet",
            "itemId": item_id,
            "amount": amount,
        }),
    }
}

fn planned_job_value(
    target: &crate::construction_planner::Target,
    plan: crate::construction_planner::Plan,
) -> Value {
    let decisions = plan
        .decisions
        .into_iter()
        .map(|decision| {
            let mut value = Map::new();
            value.insert("itemId".to_owned(), Value::from(decision.item_id));
            value.insert("recipeId".to_owned(), Value::from(decision.recipe_id));
            if let Some(reason) = decision.fallback_reason {
                value.insert("fallbackReason".to_owned(), Value::from(reason));
            }
            Value::Object(value)
        })
        .collect::<Vec<_>>();
    serde_json::json!({
        "constructionId": target.id,
        "steps": plan.steps.into_iter().map(planned_step_value).collect::<Vec<_>>(),
        "stepIndex": 0,
        "elapsedSeconds": 0,
        "inventory": {},
        "recipeDecisions": decisions,
    })
}

#[derive(Debug, Clone)]
struct RepeatableBatch {
    jobs_per_cycle: usize,
    work_seconds: f64,
    tray_costs: BTreeMap<String, f64>,
    tray_returns: BTreeMap<String, f64>,
    fleet_returns: BTreeMap<String, f64>,
    produced_items: BTreeMap<String, f64>,
    relevant_items: BTreeSet<String>,
    touched_tray_items: BTreeSet<String>,
    cycle_state_items: Vec<String>,
    cycle_start_inventory: BTreeMap<String, f64>,
}

fn safe_multiply(left: f64, right: f64) -> f64 {
    let left = floor_amount(left);
    let right = floor_amount(right);
    if left < 1.0 || right < 1.0 {
        0.0
    } else if left > (MAX_SAFE_INTEGER / right).floor() {
        MAX_SAFE_INTEGER
    } else {
        left * right
    }
}

fn analyze_repeatable_plan(
    state: &CoreState,
    base: &Map<String, Value>,
    target: &crate::construction_planner::Target,
    plan: &crate::construction_planner::Plan,
) -> anyhow::Result<Option<RepeatableBatch>> {
    if plan.steps.is_empty() {
        return Ok(None);
    }
    let job_value = planned_job_value(target, plan.clone());
    let job = job_value
        .as_object()
        .ok_or_else(|| anyhow!("native construction batch job is invalid"))?;
    let mut inventory = Map::new();
    let mut tray_costs = BTreeMap::<String, f64>::new();
    let mut tray_returns = BTreeMap::<String, f64>::new();
    let mut fleet_returns = BTreeMap::<String, f64>::new();
    let mut produced_items = BTreeMap::<String, f64>::new();
    let mut relevant_items = BTreeSet::<String>::new();
    let mut touched_tray_items = BTreeSet::<String>::new();
    let mut work_seconds = 0.0;
    let values = job
        .get("steps")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("native construction batch steps are missing"))?;
    for (step_index, value) in values.iter().enumerate() {
        let step = parse_step(value)?;
        work_seconds += step_duration(state, base, &step)?;
        for requirement in requirements(state, &step)? {
            relevant_items.insert(requirement.item_id.clone());
            touched_tray_items.insert(requirement.item_id.clone());
            let mut remaining = floor_amount(requirement.amount);
            let available = inventory_amount(&inventory, &requirement.item_id);
            let consumed = remaining.min(available);
            set_inventory_amount(&mut inventory, &requirement.item_id, available - consumed)?;
            remaining -= consumed;
            if remaining > 0.0 {
                *tray_costs.entry(requirement.item_id).or_default() += remaining;
            }
        }
        if let Step::Material {
            recipe_id, batches, ..
        } = &step
        {
            let recipe = state
                .catalog
                .recipes
                .get(recipe_id)
                .ok_or_else(|| anyhow!("native construction batch recipe is missing"))?;
            for output in &recipe.outputs {
                let amount = floor_amount(output.amount * batches);
                let current = inventory_amount(&inventory, &output.item_id);
                set_inventory_amount(&mut inventory, &output.item_id, current + amount)?;
                *produced_items.entry(output.item_id.clone()).or_default() += amount;
            }
        }
        let needed = remaining_inventory_need(state, job, step_index + 1)?;
        let mut retained = Map::new();
        for (item_id, value) in inventory {
            let amount = floor_amount(finite_number(Some(&value)));
            let keep = amount.min(needed.get(&item_id).copied().unwrap_or(0.0));
            if keep > 0.0 {
                retained.insert(item_id.clone(), Value::from(keep));
            }
            let excess = amount - keep;
            if excess < 1.0 {
                continue;
            }
            if matches!(item_id.as_str(), "logistics_drone" | "logistics_vessel") {
                *fleet_returns.entry(item_id).or_default() += excess;
            } else {
                *tray_returns.entry(item_id).or_default() += excess;
            }
        }
        inventory = retained;
    }
    if inventory
        .values()
        .any(|amount| floor_amount(finite_number(Some(amount))) > 0.0)
    {
        return Ok(None);
    }
    Ok(Some(RepeatableBatch {
        jobs_per_cycle: 1,
        work_seconds,
        tray_costs,
        tray_returns,
        fleet_returns,
        produced_items,
        relevant_items,
        touched_tray_items,
        cycle_state_items: Vec::new(),
        cycle_start_inventory: BTreeMap::new(),
    }))
}

fn add_batch_amount(target: &mut BTreeMap<String, f64>, item_id: &str, amount: f64) {
    let amount = floor_amount(amount);
    if amount < 1.0 {
        return;
    }
    let current = target.get(item_id).copied().unwrap_or(0.0);
    target.insert(item_id.to_owned(), floor_amount(current + amount));
}

fn compose_repeatable_batches(
    first: &RepeatableBatch,
    second: &RepeatableBatch,
) -> RepeatableBatch {
    let material_items = first
        .tray_costs
        .keys()
        .chain(first.tray_returns.keys())
        .chain(second.tray_costs.keys())
        .chain(second.tray_returns.keys())
        .cloned()
        .collect::<BTreeSet<_>>();
    let mut tray_costs = BTreeMap::new();
    let mut tray_returns = BTreeMap::new();
    for item_id in material_items {
        let first_cost = floor_amount(first.tray_costs.get(&item_id).copied().unwrap_or(0.0));
        let first_return = floor_amount(first.tray_returns.get(&item_id).copied().unwrap_or(0.0));
        let second_cost = floor_amount(second.tray_costs.get(&item_id).copied().unwrap_or(0.0));
        let second_return = floor_amount(second.tray_returns.get(&item_id).copied().unwrap_or(0.0));
        // The first job's return is working capital for the second job. Keep
        // the exact prefix requirement and the final external return instead
        // of adding two independent net deltas.
        add_batch_amount(
            &mut tray_costs,
            &item_id,
            first_cost + (second_cost - first_return).max(0.0),
        );
        add_batch_amount(
            &mut tray_returns,
            &item_id,
            second_return + (first_return - second_cost).max(0.0),
        );
    }

    let mut fleet_returns = BTreeMap::new();
    for item_id in first
        .fleet_returns
        .keys()
        .chain(second.fleet_returns.keys())
        .cloned()
        .collect::<BTreeSet<_>>()
    {
        add_batch_amount(
            &mut fleet_returns,
            &item_id,
            first.fleet_returns.get(&item_id).copied().unwrap_or(0.0)
                + second.fleet_returns.get(&item_id).copied().unwrap_or(0.0),
        );
    }

    let mut produced_items = BTreeMap::new();
    for item_id in first
        .produced_items
        .keys()
        .chain(second.produced_items.keys())
        .cloned()
        .collect::<BTreeSet<_>>()
    {
        add_batch_amount(
            &mut produced_items,
            &item_id,
            first.produced_items.get(&item_id).copied().unwrap_or(0.0)
                + second.produced_items.get(&item_id).copied().unwrap_or(0.0),
        );
    }

    RepeatableBatch {
        jobs_per_cycle: first
            .jobs_per_cycle
            .max(1)
            .saturating_add(second.jobs_per_cycle.max(1)),
        work_seconds: first.work_seconds + second.work_seconds,
        tray_costs,
        tray_returns,
        fleet_returns,
        produced_items,
        relevant_items: first
            .relevant_items
            .union(&second.relevant_items)
            .cloned()
            .collect(),
        touched_tray_items: first
            .touched_tray_items
            .union(&second.touched_tray_items)
            .cloned()
            .collect(),
        cycle_state_items: first
            .cycle_state_items
            .iter()
            .chain(second.cycle_state_items.iter())
            .cloned()
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect(),
        cycle_start_inventory: first.cycle_start_inventory.clone(),
    }
}

#[derive(Debug, Clone, PartialEq)]
struct RepeatableBatchSignature {
    work_seconds_bits: u64,
    tray_costs: BTreeMap<String, f64>,
    tray_returns: BTreeMap<String, f64>,
    fleet_returns: BTreeMap<String, f64>,
    produced_items: BTreeMap<String, f64>,
    relevant_items: BTreeSet<String>,
    touched_tray_items: BTreeSet<String>,
}

#[derive(Debug, Clone, PartialEq)]
struct ConstructionCycleFingerprint {
    batch: RepeatableBatchSignature,
    tray: Vec<(String, f64)>,
}

fn batch_signature(batch: &RepeatableBatch) -> RepeatableBatchSignature {
    RepeatableBatchSignature {
        work_seconds_bits: batch.work_seconds.to_bits(),
        tray_costs: batch.tray_costs.clone(),
        tray_returns: batch.tray_returns.clone(),
        fleet_returns: batch.fleet_returns.clone(),
        produced_items: batch.produced_items.clone(),
        relevant_items: batch.relevant_items.clone(),
        touched_tray_items: batch.touched_tray_items.clone(),
    }
}

fn construction_cycle_fingerprint(
    base: &Map<String, Value>,
    planet_id: &str,
    batch: &RepeatableBatch,
) -> ConstructionCycleFingerprint {
    let empty = Map::new();
    let planet_tray = tray(base, planet_id).unwrap_or(&empty);
    ConstructionCycleFingerprint {
        batch: batch_signature(batch),
        tray: batch
            .tray_returns
            .keys()
            .map(|item_id| (item_id.clone(), inventory_amount(planet_tray, item_id)))
            .collect(),
    }
}

fn construction_planning_base(base: &Map<String, Value>) -> Map<String, Value> {
    // A cycle probe must not duplicate the resident entity/belt domains. The
    // recursive planner and batch settlement only read or mutate these small
    // top-level construction fields.
    const KEYS: [&str; 10] = [
        "mode",
        "orbitalStation",
        "research",
        "activePlanetId",
        "tray",
        "planetTrays",
        "planetTrayItemLimits",
        "construction",
        "portableFleet",
        "totalProduced",
    ];
    KEYS.into_iter()
        .filter_map(|key| base.get(key).cloned().map(|value| (key.to_owned(), value)))
        .collect()
}

fn active_target_count(
    state: &CoreState,
    base: &Map<String, Value>,
    automation: &Map<String, Value>,
    jobs: &Map<String, Value>,
) -> usize {
    let Some(target_stock) = automation.get("targetStock").and_then(Value::as_object) else {
        return 0;
    };
    crate::construction_planner::targets(state)
        .iter()
        .filter(|target| {
            crate::construction_planner::target_is_unlocked(base, target)
                && floor_amount(finite_number(target_stock.get(&target.id)))
                    > current_stock(base, &target.id)
                        + pending_stock_in_jobs(state, jobs, &target.id)
        })
        .count()
}

fn batch_can_repeat(base: &Map<String, Value>, planet_id: &str, batch: &RepeatableBatch) -> bool {
    let empty = Map::new();
    let planet_tray = tray(base, planet_id).unwrap_or(&empty);
    let limit = tray_limit(base, planet_id);
    batch.tray_returns.iter().all(|(item_id, amount)| {
        let returned = floor_amount(*amount);
        if returned < 1.0 {
            return true;
        }
        let cost = floor_amount(batch.tray_costs.get(item_id).copied().unwrap_or(0.0));
        if cost > 0.0 {
            let current = inventory_amount(planet_tray, item_id);
            if current > limit {
                return false;
            }
            // A relevant return is the next cycle's working capital. If the
            // first return would overflow, the destroyed portion cannot be
            // reused and arithmetic batching would underpay a later cycle.
            let free_after_prefix = (limit - (current - cost).max(0.0)).max(0.0);
            if returned <= cost && returned > free_after_prefix {
                return false;
            }
        }
        !batch.relevant_items.contains(item_id) || returned <= cost
    }) && batch
        .fleet_returns
        .values()
        .all(|amount| floor_amount(*amount) < 1.0)
}

fn batch_maximum_cycles_for_stock(
    base: &Map<String, Value>,
    planet_id: &str,
    batch: &RepeatableBatch,
    quantum: &Map<String, Value>,
) -> f64 {
    let empty = Map::new();
    let planet_tray = tray(base, planet_id).unwrap_or(&empty);
    let mut maximum = MAX_SAFE_INTEGER;
    for (item_id, raw_cost) in &batch.tray_costs {
        let cost = floor_amount(*raw_cost);
        if cost < 1.0 {
            continue;
        }
        let returned = floor_amount(batch.tray_returns.get(item_id).copied().unwrap_or(0.0));
        let available = floor_amount(
            inventory_amount(planet_tray, item_id) + inventory_amount(quantum, item_id),
        );
        if available < cost {
            return 0.0;
        }
        // The first cycle needs the complete principal. Each later cycle can
        // immediately reuse its prior return and pays only the net loss.
        let net_cost = (cost - returned).max(0.0);
        if net_cost < 1.0 {
            continue;
        }
        maximum = maximum.min(1.0 + ((available - cost) / net_cost).floor());
    }
    maximum
}

fn construction_cycle_state_matches(
    base: &Map<String, Value>,
    planet_id: &str,
    batch: &RepeatableBatch,
) -> bool {
    if batch.jobs_per_cycle <= 1 {
        return true;
    }
    let empty = Map::new();
    let planet_tray = tray(base, planet_id).unwrap_or(&empty);
    batch.cycle_state_items.iter().all(|item_id| {
        inventory_amount(planet_tray, item_id)
            == floor_amount(
                batch
                    .cycle_start_inventory
                    .get(item_id)
                    .copied()
                    .unwrap_or(0.0),
            )
    })
}

#[allow(clippy::too_many_arguments)]
fn try_build_stable_cycle(
    state: &CoreState,
    base: &Map<String, Value>,
    automation: &Map<String, Value>,
    buffers: &Map<String, Value>,
    entity_id: &str,
    planet_id: &str,
    target: &crate::construction_planner::Target,
    first: &RepeatableBatch,
) -> anyhow::Result<Option<RepeatableBatch>> {
    const MAX_PROBE_JOBS: usize = 8;
    if first.jobs_per_cycle != 1 {
        return Ok(None);
    }

    let mut planning_base = construction_planning_base(base);
    let mut planning_automation = automation.clone();
    let mut planning_buffers = Map::new();
    if let Some(buffer) = buffers.get(entity_id).cloned() {
        planning_buffers.insert(entity_id.to_owned(), buffer);
    }
    let destroyed_before = planning_automation.get("destroyedByproducts").cloned();
    let initial_fingerprint = construction_cycle_fingerprint(&planning_base, planet_id, first);
    let mut current = first.clone();
    let mut cycle = first.clone();
    let mut cycle_state_items = BTreeSet::<String>::new();

    for _ in 0..MAX_PROBE_JOBS {
        cycle_state_items.extend(current.tray_returns.keys().cloned());
        let completed = match apply_repeatable_batch(
            &mut planning_base,
            &mut planning_automation,
            &mut planning_buffers,
            entity_id,
            planet_id,
            target,
            &current,
            1.0,
        ) {
            Ok(completed) => completed,
            // A speculative phase proof is never authority. Any unexpected
            // probe-only mismatch falls back to the ordinary atomic job path.
            Err(_) => return Ok(None),
        };
        if completed < 1.0
            || planning_automation.get("destroyedByproducts") != destroyed_before.as_ref()
        {
            return Ok(None);
        }

        let empty = Map::new();
        let planet_tray = tray(&planning_base, planet_id).unwrap_or(&empty);
        let quantum = planning_buffers
            .get(entity_id)
            .and_then(Value::as_object)
            .unwrap_or(&empty);
        let inventory = crate::construction_planner::inventory_from_sources(planet_tray, quantum);
        let Some(next_plan) =
            crate::construction_planner::build_plan(state, &planning_base, target, inventory)
        else {
            return Ok(None);
        };
        let Some(next) = analyze_repeatable_plan(state, &planning_base, target, &next_plan)? else {
            return Ok(None);
        };
        cycle_state_items.extend(next.tray_returns.keys().cloned());
        if construction_cycle_fingerprint(&planning_base, planet_id, &next) == initial_fingerprint {
            if !batch_can_repeat(base, planet_id, &cycle) {
                return Ok(None);
            }
            cycle.cycle_state_items = cycle_state_items.into_iter().collect();
            let initial_tray = tray(base, planet_id).unwrap_or(&empty);
            cycle.cycle_start_inventory = cycle
                .cycle_state_items
                .iter()
                .map(|item_id| (item_id.clone(), inventory_amount(initial_tray, item_id)))
                .collect();
            return Ok(Some(cycle));
        }
        cycle = compose_repeatable_batches(&cycle, &next);
        current = next;
    }
    Ok(None)
}

fn consume_combined_item(
    base: &mut Map<String, Value>,
    quantum: &mut Map<String, Value>,
    planet_id: &str,
    item_id: &str,
    raw_amount: f64,
    raw_tray_floor: f64,
    direct: bool,
) -> anyhow::Result<bool> {
    let mut remaining = floor_amount(raw_amount);
    let tray_floor = floor_amount(raw_tray_floor);
    {
        let planet_tray = tray_mut(base, planet_id)
            .ok_or_else(|| anyhow!("native construction planet tray is missing"))?;
        let current = inventory_amount(planet_tray, item_id);
        let from_tray = remaining.min((current - tray_floor).max(0.0));
        set_inventory_amount(planet_tray, item_id, current - from_tray)?;
        remaining -= from_tray;
    }
    if direct && remaining > 0.0 {
        let current = inventory_amount(quantum, item_id);
        let from_quantum = remaining.min(current);
        let next = current - from_quantum;
        if next < 1.0 {
            quantum.remove(item_id);
        } else {
            set_inventory_amount(quantum, item_id, next)?;
        }
        remaining -= from_quantum;
    }
    Ok(remaining < 1.0)
}

fn store_tray_return(
    base: &mut Map<String, Value>,
    automation: &mut Map<String, Value>,
    planet_id: &str,
    item_id: &str,
    raw_amount: f64,
) -> anyhow::Result<()> {
    let returned = floor_amount(raw_amount);
    if returned < 1.0 {
        return Ok(());
    }
    let limit = tray_limit(base, planet_id);
    let destroyed = {
        let planet_tray = tray_mut(base, planet_id)
            .ok_or_else(|| anyhow!("native construction planet tray is missing"))?;
        let current = inventory_amount(planet_tray, item_id);
        let stored = returned.min((limit - current).max(0.0));
        if stored > 0.0 {
            set_inventory_amount(planet_tray, item_id, current + stored)?;
        }
        returned - stored
    };
    if destroyed > 0.0 {
        let byproducts = automation
            .get_mut("destroyedByproducts")
            .and_then(Value::as_object_mut)
            .ok_or_else(|| anyhow!("native construction destroyed-byproduct state is missing"))?;
        let current = inventory_amount(byproducts, item_id);
        set_inventory_amount(
            byproducts,
            item_id,
            floor_amount(current + destroyed).min(MAX_SAFE_INTEGER),
        )?;
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn apply_repeatable_batch(
    base: &mut Map<String, Value>,
    automation: &mut Map<String, Value>,
    buffers: &mut Map<String, Value>,
    entity_id: &str,
    planet_id: &str,
    target: &crate::construction_planner::Target,
    batch: &RepeatableBatch,
    cycles: f64,
) -> anyhow::Result<f64> {
    let cycles = floor_amount(cycles).max(1.0);
    let direct = automation
        .get("quantumSourceEnabled")
        .and_then(Value::as_bool)
        == Some(true)
        || buffers
            .get(entity_id)
            .and_then(Value::as_object)
            .is_some_and(|buffer| !buffer.is_empty());
    let empty = Map::new();
    let quantum_before = if direct {
        buffers
            .get(entity_id)
            .and_then(Value::as_object)
            .unwrap_or(&empty)
    } else {
        &empty
    };
    if batch_maximum_cycles_for_stock(base, planet_id, batch, quantum_before) < cycles {
        return Ok(0.0);
    }
    if batch.jobs_per_cycle > 1 && !construction_cycle_state_matches(base, planet_id, batch) {
        return Ok(0.0);
    }
    {
        let planet_tray = tray_mut(base, planet_id)
            .ok_or_else(|| anyhow!("native construction planet tray is missing"))?;
        for item_id in &batch.touched_tray_items {
            if !planet_tray.contains_key(item_id) {
                set_inventory_amount(planet_tray, item_id, 0.0)?;
            }
        }
    }
    let mut quantum = buffers
        .remove(entity_id)
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    let material_items = batch
        .tray_costs
        .keys()
        .chain(batch.tray_returns.keys())
        .cloned()
        .collect::<BTreeSet<_>>();
    for item_id in material_items {
        let cost = floor_amount(batch.tray_costs.get(&item_id).copied().unwrap_or(0.0));
        let returned = floor_amount(batch.tray_returns.get(&item_id).copied().unwrap_or(0.0));
        if cost < 1.0 {
            store_tray_return(
                base,
                automation,
                planet_id,
                &item_id,
                safe_multiply(returned, cycles),
            )?;
            continue;
        }
        if returned < 1.0 {
            if !consume_combined_item(
                base,
                &mut quantum,
                planet_id,
                &item_id,
                safe_multiply(cost, cycles),
                0.0,
                direct,
            )? {
                bail!("native construction arithmetic batch exceeded its material certificate");
            }
            continue;
        }

        // Replay the exact first prefix once, then retain its return as the
        // next cycle's working capital and aggregate only the tail net loss.
        if !consume_combined_item(base, &mut quantum, planet_id, &item_id, cost, 0.0, direct)? {
            bail!("native construction arithmetic batch exceeded its first-cycle principal");
        }
        store_tray_return(base, automation, planet_id, &item_id, returned)?;
        let tail_cycles = cycles - 1.0;
        if tail_cycles < 1.0 {
            continue;
        }
        if cost > returned {
            let current_tray = tray(base, planet_id)
                .map(|planet_tray| inventory_amount(planet_tray, &item_id))
                .unwrap_or(0.0);
            if !consume_combined_item(
                base,
                &mut quantum,
                planet_id,
                &item_id,
                safe_multiply(cost - returned, tail_cycles),
                returned.min(current_tray),
                direct,
            )? {
                bail!("native construction arithmetic batch exceeded its net material budget");
            }
        } else if returned > cost {
            store_tray_return(
                base,
                automation,
                planet_id,
                &item_id,
                safe_multiply(returned - cost, tail_cycles),
            )?;
        }
    }
    quantum.retain(|_, amount| floor_amount(finite_number(Some(amount))) > 0.0);
    if direct && !quantum.is_empty() {
        buffers.insert(entity_id.to_owned(), Value::Object(quantum));
    }
    if !batch.fleet_returns.is_empty() {
        let fleet = base
            .get_mut("portableFleet")
            .and_then(Value::as_object_mut)
            .ok_or_else(|| anyhow!("native portable fleet state is missing"))?;
        for (item_id, amount) in &batch.fleet_returns {
            let returned = safe_multiply(*amount, cycles);
            if returned > 0.0 {
                let current = inventory_amount(fleet, item_id);
                set_inventory_amount(fleet, item_id, current + returned)?;
            }
        }
    }
    {
        let produced = base
            .get_mut("totalProduced")
            .and_then(Value::as_object_mut)
            .ok_or_else(|| anyhow!("native total production record is missing"))?;
        for (item_id, amount) in &batch.produced_items {
            let current = inventory_amount(produced, item_id);
            set_inventory_amount(produced, item_id, current + safe_multiply(*amount, cycles))?;
        }
    }
    let completed = safe_multiply(
        target.output_amount,
        safe_multiply(cycles, batch.jobs_per_cycle.max(1) as f64),
    );
    if matches!(target.id.as_str(), "logistics_drone" | "logistics_vessel") {
        let fleet = base
            .get_mut("portableFleet")
            .and_then(Value::as_object_mut)
            .ok_or_else(|| anyhow!("native portable fleet state is missing"))?;
        let current = inventory_amount(fleet, &target.id);
        set_inventory_amount(fleet, &target.id, current + completed)?;
    } else {
        let construction = base
            .get_mut("construction")
            .and_then(Value::as_object_mut)
            .ok_or_else(|| anyhow!("native construction inventory is missing"))?;
        let current = inventory_amount(construction, &target.id);
        set_inventory_amount(construction, &target.id, current + completed)?;
    }
    set_number(
        automation,
        "totalCrafted",
        floor_amount(finite_number(automation.get("totalCrafted")) + completed),
    )?;
    automation.insert("lastCraftedId".to_owned(), Value::from(target.id.clone()));
    Ok(completed)
}

#[allow(clippy::too_many_arguments)]
fn try_run_repeatable_batch(
    state: &CoreState,
    base: &mut Map<String, Value>,
    automation: &mut Map<String, Value>,
    jobs: &Map<String, Value>,
    buffers: &mut Map<String, Value>,
    entity_id: &str,
    planet_id: &str,
    target: &crate::construction_planner::Target,
    plan: &crate::construction_planner::Plan,
    remaining_work: f64,
    machine_count: f64,
) -> anyhow::Result<Option<(f64, f64)>> {
    if target.output_amount < 1.0 {
        return Ok(None);
    }
    let active_targets = active_target_count(state, base, automation, jobs).max(1);
    let Some(mut batch) = analyze_repeatable_plan(state, base, target, plan)? else {
        return Ok(None);
    };
    if batch.work_seconds <= EPSILON {
        return Ok(None);
    }
    if !batch_can_repeat(base, planet_id, &batch)
        && active_targets == 1
        && let Some(stable) = try_build_stable_cycle(
            state, base, automation, buffers, entity_id, planet_id, target, &batch,
        )?
    {
        batch = stable;
    }
    if !batch_can_repeat(base, planet_id, &batch)
        || !construction_cycle_state_matches(base, planet_id, &batch)
    {
        return Ok(None);
    }
    let target_stock = automation
        .get("targetStock")
        .and_then(Value::as_object)
        .map(|targets| floor_amount(finite_number(targets.get(&target.id))))
        .unwrap_or(0.0);
    let current = current_stock(base, &target.id) + pending_stock_in_jobs(state, jobs, &target.id);
    let jobs_for_target = ((target_stock - current).max(0.0) / target.output_amount).ceil();
    let jobs_for_work = ((remaining_work.max(0.0) + EPSILON) / batch.work_seconds).floor();
    if jobs_for_target < 1.0 || jobs_for_work < 1.0 {
        return Ok(None);
    }
    let direct = automation
        .get("quantumSourceEnabled")
        .and_then(Value::as_bool)
        == Some(true)
        || buffers
            .get(entity_id)
            .and_then(Value::as_object)
            .is_some_and(|buffer| !buffer.is_empty());
    let empty = Map::new();
    let quantum = if direct {
        buffers
            .get(entity_id)
            .and_then(Value::as_object)
            .unwrap_or(&empty)
    } else {
        &empty
    };
    let cycles_for_stock = batch_maximum_cycles_for_stock(base, planet_id, &batch, quantum);
    let can_repeat = active_targets == 1 && jobs.is_empty();
    let high_load = machine_count >= 10_000.0 || remaining_work > 256.0;
    if !can_repeat && !high_load {
        return Ok(None);
    }
    let max_fair_jobs: f64 = if active_targets > 1 && machine_count >= 1_000_000.0 {
        1_000_000.0
    } else {
        4_096.0
    };
    let fair_share = max_fair_jobs.min((jobs_for_work / active_targets as f64).ceil().max(1.0));
    let jobs_per_cycle = batch.jobs_per_cycle.max(1) as f64;
    let cycles_for_target = (jobs_for_target / jobs_per_cycle).floor();
    // Keep the same conservative work guard as the JavaScript oracle for a
    // proven multi-job cycle. It may leave a small amount of work unused, but
    // cannot over-credit a construction bucket.
    let cycles_for_work = (jobs_for_work / jobs_per_cycle).floor();
    let cycles = cycles_for_target
        .min(cycles_for_work)
        .min(cycles_for_stock)
        .min(if can_repeat {
            MAX_SAFE_INTEGER
        } else {
            (fair_share / jobs_per_cycle).floor()
        });
    if cycles < 1.0 {
        return Ok(None);
    }
    let completed = apply_repeatable_batch(
        base, automation, buffers, entity_id, planet_id, target, &batch, cycles,
    )?;
    if completed < 1.0 {
        return Ok(None);
    }
    Ok(Some((batch.work_seconds * cycles, completed)))
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

fn reserve_requirements(
    base: &mut Map<String, Value>,
    buffers: &mut Map<String, Value>,
    entity_id: &str,
    planet_id: &str,
    job: &mut Map<String, Value>,
    requirements: &[ItemAmount],
) -> anyhow::Result<bool> {
    let mut inventory = job
        .get("inventory")
        .and_then(Value::as_object)
        .cloned()
        .ok_or_else(|| anyhow!("native construction job inventory is missing"))?;
    let mut planet_tray = tray(base, planet_id)
        .cloned()
        .ok_or_else(|| anyhow!("native construction planet tray is missing"))?;
    let mut quantum = buffers
        .get(entity_id)
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    for requirement in requirements {
        let required = floor_amount(requirement.amount);
        let already_reserved = required.min(inventory_amount(&inventory, &requirement.item_id));
        let mut remaining = required - already_reserved;
        let in_tray = inventory_amount(&planet_tray, &requirement.item_id);
        let from_tray = remaining.min(in_tray);
        set_inventory_amount(&mut planet_tray, &requirement.item_id, in_tray - from_tray)?;
        remaining -= from_tray;
        let in_quantum = inventory_amount(&quantum, &requirement.item_id);
        let from_quantum = remaining.min(in_quantum);
        set_inventory_amount(
            &mut quantum,
            &requirement.item_id,
            in_quantum - from_quantum,
        )?;
        remaining -= from_quantum;
        if remaining > 0.0 {
            return Ok(false);
        }
        let current = inventory_amount(&inventory, &requirement.item_id);
        set_inventory_amount(
            &mut inventory,
            &requirement.item_id,
            current + from_tray + from_quantum,
        )?;
    }
    *tray_mut(base, planet_id)
        .ok_or_else(|| anyhow!("native construction planet tray is missing"))? = planet_tray;
    job.insert("inventory".to_owned(), Value::Object(inventory));
    if quantum
        .values()
        .any(|amount| floor_amount(finite_number(Some(amount))) > 0.0)
    {
        buffers.insert(entity_id.to_owned(), Value::Object(quantum));
    } else {
        buffers.remove(entity_id);
    }
    Ok(true)
}

fn repair_job(
    state: &CoreState,
    base: &Map<String, Value>,
    buffers: &Map<String, Value>,
    entity_id: &str,
    planet_id: &str,
    job: &mut Map<String, Value>,
) -> anyhow::Result<bool> {
    let Some(construction_id) = string_at(job, "constructionId").map(str::to_owned) else {
        return Ok(false);
    };
    let Some(target) = crate::construction_planner::targets(state)
        .into_iter()
        .find(|target| target.id == construction_id)
    else {
        return Ok(false);
    };
    let empty = Map::new();
    let planet_tray = tray(base, planet_id).unwrap_or(&empty);
    let quantum = buffers
        .get(entity_id)
        .and_then(Value::as_object)
        .unwrap_or(&empty);
    let mut inventory = crate::construction_planner::inventory_from_sources(planet_tray, quantum);
    if let Some(job_inventory) = job.get("inventory").and_then(Value::as_object) {
        for (item_id, amount) in job_inventory {
            let current = inventory.get(item_id).copied().unwrap_or(0.0);
            inventory.insert(
                item_id.clone(),
                floor_amount(current + finite_number(Some(amount))),
            );
        }
    }
    let Some(plan) = crate::construction_planner::build_plan(state, base, &target, inventory)
    else {
        return Ok(false);
    };
    if plan.steps.is_empty() {
        return Ok(false);
    }
    let replacement = planned_job_value(&target, plan)
        .as_object()
        .cloned()
        .ok_or_else(|| anyhow!("native repaired construction job is invalid"))?;
    let replacement_steps = replacement
        .get("steps")
        .and_then(Value::as_array)
        .cloned()
        .ok_or_else(|| anyhow!("native repaired construction steps are invalid"))?;
    let replacement_decisions = replacement
        .get("recipeDecisions")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let step_index = floor_amount(finite_number(job.get("stepIndex"))) as usize;
    let steps = job
        .get_mut("steps")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| anyhow!("native construction job steps are missing"))?;
    steps.truncate(step_index.min(steps.len()));
    steps.extend(replacement_steps);
    job.insert(
        "recipeDecisions".to_owned(),
        Value::Array(replacement_decisions),
    );
    set_number(job, "elapsedSeconds", 0.0)?;
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

fn refund_quantum_buffer(
    base: &mut Map<String, Value>,
    buffers: &mut Map<String, Value>,
    entity_id: &str,
    planet_id: &str,
) -> anyhow::Result<()> {
    let Some(inventory) = buffers
        .remove(entity_id)
        .and_then(|value| value.as_object().cloned())
    else {
        return Ok(());
    };
    for (item_id, value) in inventory {
        let amount = floor_amount(finite_number(Some(&value)));
        if amount < 1.0 {
            continue;
        }
        let requested = amount.min(u64::MAX as f64) as u64;
        let deposited =
            crate::quantum_logistics::deposit_construction_refund(base, &item_id, requested)?;
        let remainder = amount - deposited as f64;
        if remainder > 0.0 {
            let planet_tray = tray_mut(base, planet_id)
                .ok_or_else(|| anyhow!("native construction planet tray is missing"))?;
            let current = inventory_amount(planet_tray, &item_id);
            set_inventory_amount(planet_tray, &item_id, current + remainder)?;
        }
    }
    Ok(())
}

fn remaining_inventory_need(
    state: &CoreState,
    job: &Map<String, Value>,
    start_index: usize,
) -> anyhow::Result<BTreeMap<String, f64>> {
    let steps = job
        .get("steps")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("native construction job steps are missing"))?;
    let mut needed = BTreeMap::<String, f64>::new();
    for value in steps.iter().skip(start_index).rev() {
        let step = parse_step(value)?;
        for requirement in requirements(state, &step)? {
            let current = needed.get(&requirement.item_id).copied().unwrap_or(0.0);
            needed.insert(
                requirement.item_id,
                floor_amount(current + requirement.amount),
            );
        }
        if let Step::Material {
            recipe_id, batches, ..
        } = step
        {
            let recipe = state
                .catalog
                .recipes
                .get(&recipe_id)
                .ok_or_else(|| anyhow!("native construction material recipe is missing"))?;
            for output in &recipe.outputs {
                let current = needed.get(&output.item_id).copied().unwrap_or(0.0);
                needed.insert(
                    output.item_id.clone(),
                    floor_amount(current - output.amount * batches),
                );
            }
        }
    }
    Ok(needed)
}

fn tray_limit(base: &Map<String, Value>, planet_id: &str) -> f64 {
    base.get("planetTrayItemLimits")
        .and_then(Value::as_object)
        .and_then(|limits| limits.get(planet_id))
        .map(|value| {
            finite_number(Some(value))
                .floor()
                .clamp(1_000.0, 100_000_000.0)
        })
        .unwrap_or(1_000_000.0)
}

fn settle_excess(
    state: &CoreState,
    base: &mut Map<String, Value>,
    automation: &mut Map<String, Value>,
    planet_id: &str,
    job: &mut Map<String, Value>,
    next_step_index: usize,
) -> anyhow::Result<()> {
    let needed = remaining_inventory_need(state, job, next_step_index)?;
    let inventory = job
        .remove("inventory")
        .and_then(|value| value.as_object().cloned())
        .ok_or_else(|| anyhow!("native construction job inventory is missing"))?;
    let mut retained = Map::new();
    let mut fleet_returns = Vec::<(String, f64)>::new();
    let mut tray_returns = Vec::<(String, f64)>::new();
    for (item_id, value) in inventory {
        let amount = floor_amount(finite_number(Some(&value)));
        let keep = amount.min(
            needed
                .get(&item_id)
                .copied()
                .unwrap_or(0.0)
                .max(0.0)
                .floor(),
        );
        if keep > 0.0 {
            retained.insert(item_id.clone(), Value::from(keep));
        }
        let excess = amount - keep;
        if excess < 1.0 {
            continue;
        }
        if matches!(item_id.as_str(), "logistics_drone" | "logistics_vessel") {
            fleet_returns.push((item_id, excess));
        } else {
            tray_returns.push((item_id, excess));
        }
    }
    job.insert("inventory".to_owned(), Value::Object(retained));
    if !fleet_returns.is_empty() {
        let fleet = base
            .get_mut("portableFleet")
            .and_then(Value::as_object_mut)
            .ok_or_else(|| anyhow!("native portable fleet state is missing"))?;
        for (item_id, amount) in fleet_returns {
            let current = floor_amount(finite_number(fleet.get(&item_id)));
            set_inventory_amount(fleet, &item_id, current + amount)?;
        }
    }
    let limit = tray_limit(base, planet_id);
    let mut destroyed = Vec::<(String, f64)>::new();
    {
        let planet_tray = tray_mut(base, planet_id)
            .ok_or_else(|| anyhow!("native construction planet tray is missing"))?;
        for (item_id, amount) in tray_returns {
            let current = inventory_amount(planet_tray, &item_id);
            let stored = amount.min((limit - current).max(0.0));
            if stored > 0.0 {
                set_inventory_amount(planet_tray, &item_id, current + stored)?;
            }
            let lost = amount - stored;
            if lost > 0.0 {
                destroyed.push((item_id, lost));
            }
        }
    }
    if !destroyed.is_empty() {
        let byproducts = automation
            .get_mut("destroyedByproducts")
            .and_then(Value::as_object_mut)
            .ok_or_else(|| anyhow!("native construction destroyed-byproduct state is missing"))?;
        for (item_id, amount) in destroyed {
            let current = floor_amount(finite_number(byproducts.get(&item_id)));
            set_inventory_amount(
                byproducts,
                &item_id,
                (current + amount).min(MAX_SAFE_INTEGER),
            )?;
        }
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
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
            job.insert("inventory".to_owned(), Value::Object(job_inventory));
            if !quantum.is_empty() {
                buffers.insert(entity_id.to_owned(), Value::Object(quantum));
            }
            let step_count = job
                .get("steps")
                .and_then(Value::as_array)
                .map(Vec::len)
                .unwrap_or(0);
            settle_excess(state, base, automation, planet_id, job, step_count)?;
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
            job.insert("inventory".to_owned(), Value::Object(job_inventory));
            if !quantum.is_empty() {
                buffers.insert(entity_id.to_owned(), Value::Object(quantum));
            }
            let next_step = floor_amount(finite_number(job.get("stepIndex"))) as usize + 1;
            settle_excess(state, base, automation, planet_id, job, next_step)?;
        }
        Step::Fleet { item_id, amount } => {
            let fleet = base
                .get_mut("portableFleet")
                .and_then(Value::as_object_mut)
                .ok_or_else(|| anyhow!("native portable fleet state is missing"))?;
            let current = floor_amount(finite_number(fleet.get(item_id)));
            set_inventory_amount(fleet, item_id, current + amount)?;
            let total = finite_number(automation.get("totalCrafted")) + amount;
            set_number(automation, "totalCrafted", total)?;
            automation.insert("lastCraftedId".to_owned(), Value::from(item_id.clone()));
            job.insert("inventory".to_owned(), Value::Object(job_inventory));
            if !quantum.is_empty() {
                buffers.insert(entity_id.to_owned(), Value::Object(quantum));
            }
        }
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
    center_indices: &[usize],
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
    for &entity_index in center_indices {
        if entity_index >= entities.len() {
            bail!("native construction center index is outside the entity table");
        }
        let snapshot = entities[entity_index]
            .as_object()
            .ok_or_else(|| anyhow!("native construction entity is invalid"))?
            .clone();
        if string_at(&snapshot, "buildingId") != Some("construction_center") {
            bail!("native construction center index is stale");
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
        let mut job = jobs
            .remove(&entity_id)
            .and_then(|value| value.as_object().cloned());
        let machine_count = finite_number(center.get("machineCount")).max(1.0);
        let mut remaining_work = seconds.max(0.0) * machine_count * power_factor;
        let mut completed = 0.0;
        let mut worked = false;
        let mut remaining_iterations = (seconds.max(0.0) * 512.0).ceil().max(1.0) as usize;
        while remaining_work > EPSILON && remaining_iterations > 0 {
            remaining_iterations -= 1;
            if job.is_none() {
                let Some(target) = select_target(state, base, &automation, &jobs) else {
                    refund_quantum_buffer(base, &mut buffers, &entity_id, &planet_id)?;
                    break;
                };
                let empty_quantum = Map::new();
                let quantum = buffers
                    .get(&entity_id)
                    .and_then(Value::as_object)
                    .unwrap_or(&empty_quantum);
                let planet_tray = tray(base, &planet_id)
                    .ok_or_else(|| anyhow!("native construction planet tray is missing"))?;
                let inventory =
                    crate::construction_planner::inventory_from_sources(planet_tray, quantum);
                let Some(plan) =
                    crate::construction_planner::build_plan(state, base, &target, inventory)
                else {
                    break;
                };
                let target_count = crate::construction_planner::targets(state).len().max(1);
                set_number(
                    &mut automation,
                    "cursor",
                    ((target.index + 1) % target_count) as f64,
                )?;
                if let Some((used_work, batch_completed)) = try_run_repeatable_batch(
                    state,
                    base,
                    &mut automation,
                    &jobs,
                    &mut buffers,
                    &entity_id,
                    &planet_id,
                    &target,
                    &plan,
                    remaining_work,
                    machine_count,
                )? {
                    remaining_work = (remaining_work - used_work).max(0.0);
                    completed += batch_completed;
                    worked = true;
                    set_number(center, "progress", 0.0)?;
                    continue;
                }
                job = planned_job_value(&target, plan).as_object().cloned();
            }
            let current_job = job
                .as_mut()
                .ok_or_else(|| anyhow!("native construction job could not be planned"))?;
            let steps = current_job
                .get("steps")
                .and_then(Value::as_array)
                .cloned()
                .ok_or_else(|| anyhow!("native construction job steps are missing"))?;
            let step_index = floor_amount(finite_number(current_job.get("stepIndex"))) as usize;
            let Some(step_value) = steps.get(step_index) else {
                job = None;
                continue;
            };
            let step = parse_step(step_value)?;
            let requirements = requirements(state, &step)?;
            let inputs_available = {
                let job_inventory = current_job
                    .get("inventory")
                    .and_then(Value::as_object)
                    .ok_or_else(|| anyhow!("native construction job inventory is missing"))?;
                let empty_quantum = Map::new();
                let quantum = buffers
                    .get(&entity_id)
                    .and_then(Value::as_object)
                    .unwrap_or(&empty_quantum);
                let planet_tray = tray(base, &planet_id)
                    .ok_or_else(|| anyhow!("native construction planet tray is missing"))?;
                requirements_available(job_inventory, planet_tray, quantum, &requirements)
            };
            if !inputs_available {
                if repair_job(state, base, &buffers, &entity_id, &planet_id, current_job)? {
                    continue;
                }
                break;
            }
            if !reserve_requirements(
                base,
                &mut buffers,
                &entity_id,
                &planet_id,
                current_job,
                &requirements,
            )? {
                break;
            }
            let duration = step_duration(state, base, &step)?;
            let elapsed = finite_number(current_job.get("elapsedSeconds"));
            let needed = (duration - elapsed).max(0.0);
            let used = remaining_work.min(needed);
            let next_elapsed = ((elapsed + used) * 1_000_000.0).round() / 1_000_000.0;
            set_number(current_job, "elapsedSeconds", next_elapsed)?;
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
                current_job,
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
            } else if let Step::Fleet { amount, .. } = &step {
                completed += amount;
            }
            set_number(current_job, "stepIndex", step_index as f64 + 1.0)?;
            set_number(current_job, "elapsedSeconds", 0.0)?;
            set_number(center, "progress", 0.0)?;
            if step_index + 1 >= steps.len() {
                job = None;
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
        if let Some(job) = job {
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
    base: &Map<String, Value>,
    entity: &Map<String, Value>,
) -> anyhow::Result<bool> {
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
    let jobs = automation
        .get("jobs")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("native construction jobs are missing"))?;
    let Some(job) = jobs.get(entity_id).and_then(Value::as_object) else {
        // The JavaScript status path still tries to plan the next globally
        // deficient target for an idle center. A missing plan means that the
        // center is visibly blocked even though no persisted job exists yet.
        let Some(target) = select_target(state, base, automation, jobs) else {
            return Ok(false);
        };
        let empty = Map::new();
        let planet_tray = tray(base, planet_id).unwrap_or(&empty);
        let quantum = quantum_buffer(automation, entity_id).unwrap_or(&empty);
        let inventory = crate::construction_planner::inventory_from_sources(planet_tray, quantum);
        return Ok(
            crate::construction_planner::build_plan(state, base, &target, inventory).is_none(),
        );
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
        .filter(|&index| {
            state.symbols.resolve(state.entities.buildings[index]) == Some("construction_center")
        })
        .map(|index| state.entities.ids[index].to_string())
        .collect::<std::collections::HashSet<_>>();
    let buffers = automation
        .get("quantumMaterialBuffer")
        .and_then(Value::as_object);
    if buffers.is_some_and(|buffers| {
        buffers.iter().any(|(entity_id, inventory)| {
            !entity_ids.contains(entity_id)
                || inventory.as_object().is_none_or(|inventory| {
                    inventory
                        .values()
                        .any(|amount| floor_amount(finite_number(Some(amount))) < 1.0)
                })
        })
    }) {
        return Ok(Some("construction-quantum-buffer-unsupported"));
    }
    if all_centers_provably_unpowered(state)? {
        if jobs
            .iter()
            .any(|(entity_id, job)| !entity_ids.contains(entity_id) || job.as_object().is_none())
        {
            return Ok(Some("construction-job-invalid"));
        }
        return Ok(None);
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
            && !matches!(construction_id, "logistics_drone" | "logistics_vessel")
            || job.get("inventory").and_then(Value::as_object).is_none()
        {
            return Ok(Some("construction-job-invalid"));
        }
        let Some(steps) = job.get("steps").and_then(Value::as_array) else {
            return Ok(Some("construction-job-invalid"));
        };
        let step_index = floor_amount(finite_number(job.get("stepIndex"))) as usize;
        if steps.is_empty() || steps.get(step_index).is_none() {
            return Ok(Some("construction-job-invalid"));
        }
        for value in steps {
            let step = match parse_step(value) {
                Ok(step) => step,
                Err(_) => return Ok(Some("construction-step-invalid")),
            };
            if requirements(state, &step).is_err()
                || matches!(&step, Step::Fleet { item_id, amount }
                    if !matches!(item_id.as_str(), "logistics_drone" | "logistics_vessel") || *amount < 1.0)
            {
                return Ok(Some("construction-step-invalid"));
            }
        }
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::construction_planner::TargetKind;
    use serde_json::json;

    fn object(value: Value) -> Map<String, Value> {
        value.as_object().expect("test object").clone()
    }

    fn batch(
        costs: &[(&str, f64)],
        returns: &[(&str, f64)],
        produced: &[(&str, f64)],
    ) -> RepeatableBatch {
        let tray_costs = costs
            .iter()
            .map(|(item_id, amount)| ((*item_id).to_owned(), *amount))
            .collect::<BTreeMap<_, _>>();
        let tray_returns = returns
            .iter()
            .map(|(item_id, amount)| ((*item_id).to_owned(), *amount))
            .collect::<BTreeMap<_, _>>();
        let touched_tray_items = costs
            .iter()
            .map(|(item_id, _)| (*item_id).to_owned())
            .collect::<BTreeSet<_>>();
        RepeatableBatch {
            jobs_per_cycle: 1,
            work_seconds: 1.0,
            tray_costs,
            tray_returns,
            fleet_returns: BTreeMap::new(),
            produced_items: produced
                .iter()
                .map(|(item_id, amount)| ((*item_id).to_owned(), *amount))
                .collect(),
            relevant_items: touched_tray_items.clone(),
            touched_tray_items,
            cycle_state_items: Vec::new(),
            cycle_start_inventory: BTreeMap::new(),
        }
    }

    #[test]
    fn stock_limit_uses_full_first_principal_then_only_net_loss() {
        let base = object(json!({
            "activePlanetId": "planet-a",
            "tray": { "feed": 2 },
            "planetTrays": {},
            "planetTrayItemLimits": { "planet-a": 1_000_000 },
        }));
        let quantum = object(json!({ "feed": 12 }));
        let working_capital = batch(&[("feed", 10.0)], &[("feed", 8.0)], &[]);
        let no_return = batch(&[("feed", 10.0)], &[], &[]);

        assert_eq!(
            batch_maximum_cycles_for_stock(&base, "planet-a", &working_capital, &quantum),
            3.0
        );
        assert_eq!(
            batch_maximum_cycles_for_stock(&base, "planet-a", &no_return, &quantum),
            1.0
        );
    }

    #[test]
    fn direct_quantum_batch_preserves_working_capital_and_is_atomic_when_underfunded() {
        let mut base = object(json!({
            "activePlanetId": "planet-a",
            "tray": { "feed": 2 },
            "planetTrays": {},
            "planetTrayItemLimits": { "planet-a": 1_000_000 },
            "construction": { "widget": 0 },
            "portableFleet": {},
            "totalProduced": { "intermediate": 0 },
        }));
        let mut automation = object(json!({
            "quantumSourceEnabled": true,
            "destroyedByproducts": {},
            "totalCrafted": 0,
        }));
        let mut buffers = object(json!({ "center-a": { "feed": 12 } }));
        let target = crate::construction_planner::Target {
            index: 0,
            id: "widget".to_owned(),
            output_amount: 1.0,
            required_tech_id: None,
            kind: TargetKind::Building,
        };
        let working_capital = batch(
            &[("feed", 10.0)],
            &[("feed", 8.0)],
            &[("intermediate", 2.0)],
        );

        let before_base = base.clone();
        let before_automation = automation.clone();
        let before_buffers = buffers.clone();
        assert_eq!(
            apply_repeatable_batch(
                &mut base,
                &mut automation,
                &mut buffers,
                "center-a",
                "planet-a",
                &target,
                &working_capital,
                4.0,
            )
            .expect("underfunded batch should be rejected without mutation"),
            0.0
        );
        assert_eq!(base, before_base);
        assert_eq!(automation, before_automation);
        assert_eq!(buffers, before_buffers);

        assert_eq!(
            apply_repeatable_batch(
                &mut base,
                &mut automation,
                &mut buffers,
                "center-a",
                "planet-a",
                &target,
                &working_capital,
                3.0,
            )
            .expect("funded direct batch"),
            3.0
        );
        assert_eq!(
            tray(&base, "planet-a").map(|tray| inventory_amount(tray, "feed")),
            Some(8.0)
        );
        assert!(buffers.get("center-a").is_none());
        assert_eq!(
            base.get("construction")
                .and_then(Value::as_object)
                .map(|inventory| inventory_amount(inventory, "widget")),
            Some(3.0)
        );
        assert_eq!(
            base.get("totalProduced")
                .and_then(Value::as_object)
                .map(|inventory| inventory_amount(inventory, "intermediate")),
            Some(6.0)
        );
        assert_eq!(finite_number(automation.get("totalCrafted")), 3.0);
    }

    #[test]
    fn composed_byproduct_cycle_has_exact_external_cost_and_phase_guard() {
        let first = batch(&[("ore", 5.0)], &[("catalyst", 2.0)], &[("part", 1.0)]);
        let second = batch(
            &[("ore", 3.0), ("catalyst", 2.0)],
            &[("ore", 1.0)],
            &[("part", 2.0)],
        );
        let mut cycle = compose_repeatable_batches(&first, &second);
        cycle.cycle_state_items = vec!["catalyst".to_owned()];
        cycle
            .cycle_start_inventory
            .insert("catalyst".to_owned(), 0.0);
        let mut base = object(json!({
            "activePlanetId": "planet-a",
            "tray": { "ore": 100, "catalyst": 0 },
            "planetTrays": {},
            "planetTrayItemLimits": { "planet-a": 1_000_000 },
            "construction": { "widget": 0 },
            "portableFleet": {},
            "totalProduced": { "part": 0 },
        }));

        assert_eq!(cycle.jobs_per_cycle, 2);
        assert_eq!(cycle.work_seconds, 2.0);
        assert_eq!(cycle.tray_costs.get("ore"), Some(&8.0));
        assert_eq!(cycle.tray_returns.get("ore"), Some(&1.0));
        assert!(!cycle.tray_costs.contains_key("catalyst"));
        assert!(!cycle.tray_returns.contains_key("catalyst"));
        assert_eq!(cycle.produced_items.get("part"), Some(&3.0));
        assert!(batch_can_repeat(&base, "planet-a", &cycle));
        assert!(construction_cycle_state_matches(&base, "planet-a", &cycle));

        let mut applied = base.clone();
        let mut automation = object(json!({
            "quantumSourceEnabled": false,
            "destroyedByproducts": {},
            "totalCrafted": 0,
        }));
        let mut buffers = Map::new();
        let target = crate::construction_planner::Target {
            index: 0,
            id: "widget".to_owned(),
            output_amount: 1.0,
            required_tech_id: None,
            kind: TargetKind::Building,
        };
        assert_eq!(
            apply_repeatable_batch(
                &mut applied,
                &mut automation,
                &mut buffers,
                "center-a",
                "planet-a",
                &target,
                &cycle,
                3.0,
            )
            .expect("stable cycle batch"),
            6.0
        );
        assert_eq!(
            tray(&applied, "planet-a").map(|tray| inventory_amount(tray, "ore")),
            Some(79.0)
        );
        assert_eq!(
            applied
                .get("construction")
                .and_then(Value::as_object)
                .map(|inventory| inventory_amount(inventory, "widget")),
            Some(6.0)
        );
        assert_eq!(
            applied
                .get("totalProduced")
                .and_then(Value::as_object)
                .map(|inventory| inventory_amount(inventory, "part")),
            Some(9.0)
        );

        set_inventory_amount(
            tray_mut(&mut base, "planet-a").expect("planet tray"),
            "catalyst",
            1.0,
        )
        .expect("set cycle phase");
        assert!(!construction_cycle_state_matches(&base, "planet-a", &cycle));
    }
}
