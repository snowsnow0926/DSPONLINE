use std::cmp::Ordering;
use std::collections::{BTreeMap, HashSet};

use serde_json::{Map, Value};

use crate::catalog::{ItemAmount, RecipeDefinition};
use crate::state::CoreState;

const OPTION_LIMIT: usize = 24;

#[derive(Debug, Clone)]
pub(crate) enum PlannedStep {
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
pub(crate) struct RecipeDecision {
    pub item_id: String,
    pub recipe_id: String,
    pub fallback_reason: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct Plan {
    pub steps: Vec<PlannedStep>,
    pub decisions: Vec<RecipeDecision>,
}

#[derive(Debug, Clone)]
pub(crate) enum PlanOutcome {
    Ready(Plan),
    RawShortage {
        item_id: String,
        current: f64,
        required: f64,
    },
    Blocked,
}

#[derive(Debug, Clone)]
pub(crate) enum TargetKind {
    Building,
    Fleet { recipe_id: String },
}

#[derive(Debug, Clone)]
pub(crate) struct Target {
    pub index: usize,
    pub id: String,
    pub output_amount: f64,
    pub required_tech_id: Option<String>,
    pub kind: TargetKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BlockerReason {
    RawShortage,
    Technology,
    Cycle,
}

#[derive(Debug, Clone)]
struct Blocker {
    item_id: String,
    current: f64,
    required: f64,
    reason: BlockerReason,
    depth: usize,
}

#[derive(Debug, Clone)]
struct Fallback {
    recipe_id: String,
    blocker: Option<Blocker>,
    viable: bool,
}

#[derive(Debug, Clone)]
struct PlannerDecision {
    item_id: String,
    recipe_id: String,
    fallbacks: Vec<Fallback>,
}

#[derive(Debug, Clone)]
struct Work {
    inventory: BTreeMap<String, f64>,
    steps: Vec<PlannedStep>,
    decisions: Vec<PlannerDecision>,
}

#[derive(Debug, Default)]
struct OptionResult {
    options: Vec<Work>,
    blockers: Vec<Blocker>,
}

fn finite_number(value: Option<&Value>) -> f64 {
    value
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
        .unwrap_or(0.0)
}

fn floor_amount(value: f64) -> f64 {
    if value.is_finite() {
        value.floor().clamp(0.0, 9_007_199_254_740_991.0)
    } else {
        0.0
    }
}

pub(crate) fn completed_tech(base: &Map<String, Value>, id: &str) -> bool {
    base.get("research")
        .and_then(Value::as_object)
        .and_then(|research| research.get("completedTechIds"))
        .and_then(Value::as_array)
        .is_some_and(|ids| ids.iter().any(|value| value.as_str() == Some(id)))
}

fn recipe_net_output(recipe: &RecipeDefinition, item_id: &str) -> f64 {
    let output = recipe
        .outputs
        .iter()
        .filter(|entry| entry.item_id == item_id)
        .map(|entry| entry.amount.max(0.0))
        .sum::<f64>();
    let input = recipe
        .inputs
        .iter()
        .filter(|entry| entry.item_id == item_id)
        .map(|entry| entry.amount.max(0.0))
        .sum::<f64>();
    let net = output - input;
    if net.is_finite() { net } else { 0.0 }
}

fn producing_recipes<'a>(state: &'a CoreState, item_id: &str) -> Vec<&'a RecipeDefinition> {
    let mut recipes = state
        .catalog
        .snapshot
        .recipes
        .iter()
        .filter(|recipe| recipe.recursive_manufacturing && recipe_net_output(recipe, item_id) > 0.0)
        .collect::<Vec<_>>();
    recipes.sort_by(|left, right| {
        right
            .recursive_priority
            .partial_cmp(&left.recursive_priority)
            .unwrap_or(Ordering::Equal)
            .then_with(|| left.id.cmp(&right.id))
    });
    recipes
}

fn preferred_blocker(blockers: &[Blocker]) -> Option<Blocker> {
    fn rank(reason: BlockerReason) -> u8 {
        match reason {
            BlockerReason::RawShortage => 4,
            BlockerReason::Technology => 3,
            BlockerReason::Cycle => 1,
        }
    }
    let mut values = blockers.to_vec();
    values.sort_by(|left, right| {
        right
            .depth
            .cmp(&left.depth)
            .then_with(|| rank(right.reason).cmp(&rank(left.reason)))
            .then_with(|| {
                (right.required - right.current)
                    .partial_cmp(&(left.required - left.current))
                    .unwrap_or(Ordering::Equal)
            })
            .then_with(|| left.item_id.cmp(&right.item_id))
    });
    values.into_iter().next()
}

fn ensure_item_options(
    state: &CoreState,
    base: &Map<String, Value>,
    work: Work,
    item_id: &str,
    required_amount: f64,
    resolving: &HashSet<String>,
    depth: usize,
) -> OptionResult {
    let required = floor_amount(required_amount);
    let current = floor_amount(work.inventory.get(item_id).copied().unwrap_or(0.0));
    if current >= required {
        return OptionResult {
            options: vec![work],
            blockers: Vec::new(),
        };
    }
    if resolving.contains(item_id) {
        return OptionResult {
            options: Vec::new(),
            blockers: vec![Blocker {
                item_id: item_id.to_owned(),
                current,
                required,
                reason: BlockerReason::Cycle,
                depth,
            }],
        };
    }
    let recipes = producing_recipes(state, item_id);
    if recipes.is_empty() {
        return OptionResult {
            options: Vec::new(),
            blockers: vec![Blocker {
                item_id: item_id.to_owned(),
                current,
                required,
                reason: BlockerReason::RawShortage,
                depth,
            }],
        };
    }

    let mut next_resolving = resolving.clone();
    next_resolving.insert(item_id.to_owned());
    let mut options = Vec::new();
    let mut blockers = Vec::new();
    let mut earlier_attempts = Vec::<Fallback>::new();
    for recipe in recipes {
        if recipe
            .required_tech_id
            .as_deref()
            .is_some_and(|id| !completed_tech(base, id))
        {
            let blocker = Blocker {
                item_id: item_id.to_owned(),
                current,
                required,
                reason: BlockerReason::Technology,
                depth,
            };
            blockers.push(blocker.clone());
            earlier_attempts.push(Fallback {
                recipe_id: recipe.id.clone(),
                blocker: Some(blocker),
                viable: false,
            });
            continue;
        }
        let Some(primary) = recipe
            .outputs
            .iter()
            .find(|output| output.item_id == item_id && output.amount > 0.0)
        else {
            continue;
        };
        let net_output = recipe_net_output(recipe, item_id);
        let batches = ((required - current) / net_output).ceil().max(1.0);
        let mut candidates = vec![work.clone()];
        let mut recipe_blockers = Vec::new();
        for input in &recipe.inputs {
            let required_input = input.amount * batches;
            let mut supplied = Vec::new();
            for candidate in candidates {
                let result = ensure_item_options(
                    state,
                    base,
                    candidate,
                    &input.item_id,
                    required_input,
                    &next_resolving,
                    depth + 1,
                );
                recipe_blockers.extend(result.blockers);
                for mut option in result.options {
                    let amount = option.inventory.get(&input.item_id).copied().unwrap_or(0.0);
                    option
                        .inventory
                        .insert(input.item_id.clone(), floor_amount(amount - required_input));
                    supplied.push(option);
                    if supplied.len() >= OPTION_LIMIT {
                        break;
                    }
                }
                if supplied.len() >= OPTION_LIMIT {
                    break;
                }
            }
            candidates = supplied;
            if candidates.is_empty() {
                break;
            }
        }
        blockers.extend(recipe_blockers.clone());
        if candidates.is_empty() {
            earlier_attempts.push(Fallback {
                recipe_id: recipe.id.clone(),
                blocker: preferred_blocker(&recipe_blockers),
                viable: false,
            });
            continue;
        }
        for mut candidate in candidates {
            for output in &recipe.outputs {
                let current_output = candidate
                    .inventory
                    .get(&output.item_id)
                    .copied()
                    .unwrap_or(0.0);
                candidate.inventory.insert(
                    output.item_id.clone(),
                    floor_amount(current_output + output.amount * batches),
                );
            }
            candidate.steps.push(PlannedStep::Material {
                recipe_id: recipe.id.clone(),
                batches,
                output_item_id: item_id.to_owned(),
                output_amount: primary.amount * batches,
            });
            candidate.decisions.push(PlannerDecision {
                item_id: item_id.to_owned(),
                recipe_id: recipe.id.clone(),
                fallbacks: earlier_attempts.clone(),
            });
            options.push(candidate);
            if options.len() >= OPTION_LIMIT {
                break;
            }
        }
        earlier_attempts.push(Fallback {
            recipe_id: recipe.id.clone(),
            blocker: None,
            viable: true,
        });
        if options.len() >= OPTION_LIMIT {
            break;
        }
    }
    OptionResult { options, blockers }
}

fn plan_requirements(
    state: &CoreState,
    base: &Map<String, Value>,
    mut candidates: Vec<Work>,
    requirements: &[ItemAmount],
) -> OptionResult {
    let mut blockers = Vec::new();
    for requirement in requirements {
        let mut paid = Vec::new();
        for candidate in candidates {
            let result = ensure_item_options(
                state,
                base,
                candidate,
                &requirement.item_id,
                floor_amount(requirement.amount),
                &HashSet::new(),
                0,
            );
            blockers.extend(result.blockers);
            for mut option in result.options {
                let current = option
                    .inventory
                    .get(&requirement.item_id)
                    .copied()
                    .unwrap_or(0.0);
                option.inventory.insert(
                    requirement.item_id.clone(),
                    floor_amount(current - requirement.amount),
                );
                paid.push(option);
                if paid.len() >= OPTION_LIMIT {
                    break;
                }
            }
            if paid.len() >= OPTION_LIMIT {
                break;
            }
        }
        candidates = paid;
        if candidates.is_empty() {
            break;
        }
    }
    OptionResult {
        options: candidates,
        blockers,
    }
}

fn recipe_name(state: &CoreState, recipe_id: &str) -> String {
    state
        .catalog
        .recipes
        .get(recipe_id)
        .map(|recipe| {
            if recipe.name.is_empty() {
                recipe.id.clone()
            } else {
                recipe.name.clone()
            }
        })
        .unwrap_or_else(|| recipe_id.to_owned())
}

fn item_name(state: &CoreState, item_id: &str) -> Option<String> {
    state.catalog.items.get(item_id).map(|item| {
        if item.name.is_empty() {
            item.id.clone()
        } else {
            item.name.clone()
        }
    })
}

fn public_decisions(state: &CoreState, decisions: Vec<PlannerDecision>) -> Vec<RecipeDecision> {
    decisions
        .into_iter()
        .map(|decision| {
            let fallback_reason = (!decision.fallbacks.is_empty()).then(|| {
                decision
                    .fallbacks
                    .iter()
                    .map(|fallback| {
                        let name = recipe_name(state, &fallback.recipe_id);
                        if fallback
                            .blocker
                            .as_ref()
                            .is_some_and(|blocker| blocker.reason == BlockerReason::Technology)
                        {
                            format!("{name}科技未解锁")
                        } else if let Some(blocker_name) = fallback
                            .blocker
                            .as_ref()
                            .and_then(|blocker| item_name(state, &blocker.item_id))
                        {
                            format!("{name}缺少{blocker_name}")
                        } else {
                            let _ = fallback.viable;
                            format!("{name}材料链不可完成")
                        }
                    })
                    .collect::<Vec<_>>()
                    .join("；")
            });
            RecipeDecision {
                item_id: decision.item_id,
                recipe_id: decision.recipe_id,
                fallback_reason,
            }
        })
        .collect()
}

pub(crate) fn targets(state: &CoreState) -> Vec<Target> {
    let mut constructions = state
        .catalog
        .constructions
        .values()
        .cloned()
        .collect::<Vec<_>>();
    constructions.sort_by(|left, right| {
        left.automation_order
            .cmp(&right.automation_order)
            .then_with(|| left.id.cmp(&right.id))
    });
    let mut result = constructions
        .into_iter()
        .enumerate()
        .map(|(index, definition)| Target {
            index,
            id: definition.id,
            output_amount: definition.output_amount,
            required_tech_id: definition.required_tech_id,
            kind: TargetKind::Building,
        })
        .collect::<Vec<_>>();
    for item_id in ["logistics_drone", "logistics_vessel"] {
        let Some(recipe) = state.catalog.recipes.get(item_id) else {
            continue;
        };
        let Some(output) = recipe
            .outputs
            .iter()
            .find(|output| output.item_id == item_id)
        else {
            continue;
        };
        result.push(Target {
            index: result.len(),
            id: item_id.to_owned(),
            output_amount: output.amount,
            required_tech_id: recipe.required_tech_id.clone(),
            kind: TargetKind::Fleet {
                recipe_id: recipe.id.clone(),
            },
        });
    }
    result
}

pub(crate) fn target_is_unlocked(base: &Map<String, Value>, target: &Target) -> bool {
    if target.id == "orbital_cargo_terminal"
        && (base.get("mode").and_then(Value::as_str) != Some("normal")
            || base
                .get("orbitalStation")
                .and_then(Value::as_object)
                .and_then(|station| station.get("status"))
                .and_then(Value::as_str)
                == Some("locked"))
    {
        return false;
    }
    target
        .required_tech_id
        .as_deref()
        .is_none_or(|id| completed_tech(base, id))
}

pub(crate) fn probe_plan(
    state: &CoreState,
    base: &Map<String, Value>,
    target: &Target,
    inventory: BTreeMap<String, f64>,
) -> PlanOutcome {
    let initial = Work {
        inventory: inventory
            .into_iter()
            .map(|(item_id, amount)| (item_id, floor_amount(amount)))
            .collect(),
        steps: Vec::new(),
        decisions: Vec::new(),
    };
    let result = match &target.kind {
        TargetKind::Building => {
            let Some(definition) = state.catalog.constructions.get(&target.id) else {
                return PlanOutcome::Blocked;
            };
            plan_requirements(state, base, vec![initial], &definition.costs)
        }
        TargetKind::Fleet { recipe_id } => {
            let Some(recipe) = state.catalog.recipes.get(recipe_id) else {
                return PlanOutcome::Blocked;
            };
            if recipe
                .required_tech_id
                .as_deref()
                .is_some_and(|id| !completed_tech(base, id))
            {
                return PlanOutcome::Blocked;
            }
            let mut result = plan_requirements(state, base, vec![initial], &recipe.inputs);
            for work in &mut result.options {
                for output in &recipe.outputs {
                    let current = work.inventory.get(&output.item_id).copied().unwrap_or(0.0);
                    work.inventory.insert(
                        output.item_id.clone(),
                        floor_amount(current + output.amount),
                    );
                }
                if let Some(primary) = recipe.outputs.first() {
                    work.steps.push(PlannedStep::Material {
                        recipe_id: recipe.id.clone(),
                        batches: 1.0,
                        output_item_id: primary.item_id.clone(),
                        output_amount: primary.amount,
                    });
                    work.decisions.push(PlannerDecision {
                        item_id: primary.item_id.clone(),
                        recipe_id: recipe.id.clone(),
                        fallbacks: Vec::new(),
                    });
                }
            }
            result
        }
    };
    let Some(selected) = result.options.into_iter().next() else {
        return match preferred_blocker(&result.blockers) {
            Some(blocker) if blocker.reason == BlockerReason::RawShortage => {
                PlanOutcome::RawShortage {
                    item_id: blocker.item_id,
                    current: blocker.current,
                    required: blocker.required,
                }
            }
            _ => PlanOutcome::Blocked,
        };
    };
    let mut steps = selected.steps;
    match &target.kind {
        TargetKind::Building => steps.push(PlannedStep::Building {
            construction_id: target.id.clone(),
        }),
        TargetKind::Fleet { .. } => steps.push(PlannedStep::Fleet {
            item_id: target.id.clone(),
            amount: target.output_amount,
        }),
    }
    PlanOutcome::Ready(Plan {
        steps,
        decisions: public_decisions(state, selected.decisions),
    })
}

pub(crate) fn build_plan(
    state: &CoreState,
    base: &Map<String, Value>,
    target: &Target,
    inventory: BTreeMap<String, f64>,
) -> Option<Plan> {
    match probe_plan(state, base, target, inventory) {
        PlanOutcome::Ready(plan) => Some(plan),
        PlanOutcome::RawShortage { .. } | PlanOutcome::Blocked => None,
    }
}

pub(crate) fn inventory_from_sources(
    tray: &Map<String, Value>,
    quantum: &Map<String, Value>,
) -> BTreeMap<String, f64> {
    let mut result = tray
        .iter()
        .map(|(item_id, amount)| (item_id.clone(), floor_amount(finite_number(Some(amount)))))
        .collect::<BTreeMap<_, _>>();
    for (item_id, amount) in quantum {
        let current = result.get(item_id).copied().unwrap_or(0.0);
        result.insert(
            item_id.clone(),
            floor_amount(current + floor_amount(finite_number(Some(amount)))),
        );
    }
    result
}
