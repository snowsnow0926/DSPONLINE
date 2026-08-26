use std::collections::HashMap;

use anyhow::{Context, anyhow, bail};
use serde_json::{Map, Number, Value};

use crate::state::CoreState;

const EPSILON: f64 = 0.0001;

#[derive(Debug, Default)]
pub(crate) struct BeltStepReservation {
    pub allowance_by_belt: HashMap<String, f64>,
    pub output_credits: HashMap<String, f64>,
}

#[derive(Debug, Clone)]
struct Route {
    belt_index: usize,
    source_index: usize,
    target_index: usize,
    source_id: String,
    target_id: String,
    item_id: String,
    capacity: f64,
    priority: usize,
}

#[derive(Debug)]
struct Candidate {
    route_index: usize,
    target_key: String,
    allowance: f64,
    moved: f64,
}

#[derive(Debug)]
struct Group {
    source_index: usize,
    item_id: String,
    available: f64,
    candidates: Vec<Candidate>,
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

fn rounded(value: f64, digits: i32) -> f64 {
    let scale = 10_f64.powi(digits);
    (value * scale).round() / scale
}

fn set_number(object: &mut Map<String, Value>, key: &str, value: f64) -> anyhow::Result<()> {
    object.insert(
        key.to_owned(),
        Value::Number(
            Number::from_f64(value)
                .ok_or_else(|| anyhow!("native belt simulation produced a non-finite number"))?,
        ),
    );
    Ok(())
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

fn output_amount(entity: &Map<String, Value>, item_id: &str) -> f64 {
    entity
        .get("outputs")
        .and_then(Value::as_object)
        .and_then(|outputs| outputs.get(item_id))
        .map(|value| finite_number(Some(value)))
        .unwrap_or(0.0)
}

fn input_amount(entity: &Map<String, Value>, item_id: &str) -> f64 {
    entity
        .get("inputs")
        .and_then(Value::as_object)
        .and_then(|inputs| inputs.get(item_id))
        .map(|value| finite_number(Some(value)))
        .unwrap_or(0.0)
}

fn set_output(entity: &mut Map<String, Value>, item_id: &str, amount: f64) -> anyhow::Result<()> {
    let outputs = entity
        .get_mut("outputs")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| anyhow!("native belt source outputs are missing"))?;
    outputs.insert(
        item_id.to_owned(),
        Number::from_f64(amount)
            .map(Value::Number)
            .ok_or_else(|| anyhow!("native belt output is non-finite"))?,
    );
    Ok(())
}

fn add_input(entity: &mut Map<String, Value>, item_id: &str, amount: f64) -> anyhow::Result<()> {
    let inputs = entity
        .get_mut("inputs")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| anyhow!("native belt target inputs are missing"))?;
    let current = inputs
        .get(item_id)
        .map(|value| finite_number(Some(value)))
        .unwrap_or(0.0);
    inputs.insert(
        item_id.to_owned(),
        Number::from_f64((current + amount).floor())
            .map(Value::Number)
            .ok_or_else(|| anyhow!("native belt input is non-finite"))?,
    );
    Ok(())
}

fn source_produces(state: &CoreState, source: &Map<String, Value>, item_id: &str) -> bool {
    match string_at(source, "kind") {
        Some("vein") => string_at(source, "resourceId") == Some(item_id),
        Some("machine") => string_at(source, "recipeId")
            .and_then(|id| state.catalog.recipes.get(id))
            .is_some_and(|recipe| {
                recipe
                    .outputs
                    .iter()
                    .any(|output| output.item_id == item_id)
            }),
        _ => false,
    }
}

fn target_consumes(state: &CoreState, target: &Map<String, Value>, item_id: &str) -> bool {
    string_at(target, "kind") == Some("machine")
        && string_at(target, "recipeId")
            .and_then(|id| state.catalog.recipes.get(id))
            .is_some_and(|recipe| recipe.inputs.iter().any(|input| input.item_id == item_id))
}

fn target_capacity(
    state: &CoreState,
    base: &Map<String, Value>,
    target: &Map<String, Value>,
    item_id: &str,
) -> anyhow::Result<f64> {
    let building = string_at(target, "buildingId")
        .and_then(|id| state.catalog.buildings.get(id))
        .ok_or_else(|| anyhow!("native belt target building is missing"))?;
    let limit = normalized_buffer_limit(
        base.get("settings")
            .and_then(Value::as_object)
            .and_then(|settings| settings.get("productionBufferLimit")),
    );
    Ok(stacked_capacity(
        building.input_capacity,
        finite_number(target.get("machineCount")),
        limit,
    ) - input_amount(target, item_id))
}

fn routes(state: &CoreState, entities: &[Value], belts: &[Value]) -> anyhow::Result<Vec<Route>> {
    let entity_index = entities
        .iter()
        .enumerate()
        .filter_map(|(index, entity)| {
            entity
                .as_object()
                .and_then(|object| string_at(object, "id"))
                .map(|id| (id.to_owned(), index))
        })
        .collect::<HashMap<_, _>>();
    belts
        .iter()
        .enumerate()
        .map(|(belt_index, belt)| {
            let belt = belt
                .as_object()
                .ok_or_else(|| anyhow!("native belt record is not an object"))?;
            let source_id = string_at(belt, "source")
                .ok_or_else(|| anyhow!("native belt source is missing"))?
                .to_owned();
            let target_id = string_at(belt, "target")
                .ok_or_else(|| anyhow!("native belt target is missing"))?
                .to_owned();
            let item_id = string_at(belt, "itemId")
                .ok_or_else(|| anyhow!("native belt item is missing"))?
                .to_owned();
            let source_index = *entity_index
                .get(&source_id)
                .ok_or_else(|| anyhow!("native belt source does not exist"))?;
            let target_index = *entity_index
                .get(&target_id)
                .ok_or_else(|| anyhow!("native belt target does not exist"))?;
            let tier = belt
                .get("tier")
                .and_then(Value::as_u64)
                .and_then(|value| u8::try_from(value).ok())
                .ok_or_else(|| anyhow!("native belt tier is invalid"))?;
            let speed = state
                .catalog
                .belt_speeds
                .get(&tier)
                .copied()
                .ok_or_else(|| anyhow!("native belt tier is not in the catalog"))?;
            let lanes = finite_number(belt.get("lanes")).floor();
            let stack_size = finite_number(belt.get("stackSize")).max(1.0).floor();
            Ok(Route {
                belt_index,
                source_index,
                target_index,
                source_id,
                target_id,
                item_id,
                capacity: speed * lanes * stack_size,
                priority: belt
                    .get("priority")
                    .and_then(Value::as_u64)
                    .unwrap_or(1)
                    .min(2) as usize,
            })
        })
        .collect()
}

pub(crate) fn admission_reason(state: &CoreState) -> anyhow::Result<Option<&'static str>> {
    if state.belt_index.is_empty() {
        return Ok(None);
    }
    let entities = (0..state.entity_index.len())
        .map(|index| state.parse_entity(index))
        .collect::<anyhow::Result<Vec<_>>>()?;
    let belts = (0..state.belt_index.len())
        .map(|index| state.parse_belt(index))
        .collect::<anyhow::Result<Vec<_>>>()?;
    let entity_index = entities
        .iter()
        .enumerate()
        .filter_map(|(index, entity)| {
            entity
                .as_object()
                .and_then(|object| string_at(object, "id"))
                .map(|id| (id.to_owned(), index))
        })
        .collect::<HashMap<_, _>>();
    for belt in &belts {
        let Some(belt) = belt.as_object() else {
            return Ok(Some("ordinary-belt-record-invalid"));
        };
        if belt
            .get("targetPortIndex")
            .is_some_and(|value| !value.is_null())
            || belt
                .get("elevatorOutputIndex")
                .is_some_and(|value| !value.is_null())
        {
            return Ok(Some("ordinary-belt-special-port-unsupported"));
        }
        let Some(source_id) = string_at(belt, "source") else {
            return Ok(Some("ordinary-belt-endpoint-invalid"));
        };
        let Some(target_id) = string_at(belt, "target") else {
            return Ok(Some("ordinary-belt-endpoint-invalid"));
        };
        let Some(item_id) = string_at(belt, "itemId") else {
            return Ok(Some("ordinary-belt-item-invalid"));
        };
        let (Some(&source_index), Some(&target_index)) =
            (entity_index.get(source_id), entity_index.get(target_id))
        else {
            return Ok(Some("ordinary-belt-endpoint-invalid"));
        };
        if source_index == target_index {
            return Ok(Some("ordinary-belt-endpoint-invalid"));
        }
        let source = entities[source_index]
            .as_object()
            .expect("validated entity");
        let target = entities[target_index]
            .as_object()
            .expect("validated entity");
        let planet = string_at(belt, "planetId");
        if planet != string_at(source, "planetId") || planet != string_at(target, "planetId") {
            return Ok(Some("ordinary-belt-planet-invalid"));
        }
        if !source_produces(state, source, item_id) || !target_consumes(state, target, item_id) {
            return Ok(Some("ordinary-belt-route-unsupported"));
        }
        let tier = belt
            .get("tier")
            .and_then(Value::as_u64)
            .and_then(|value| u8::try_from(value).ok());
        let lanes = finite_number(belt.get("lanes"));
        let stack_size = belt
            .get("stackSize")
            .map_or(1.0, |value| finite_number(Some(value)));
        let priority = belt.get("priority").and_then(Value::as_u64).unwrap_or(1);
        if tier.is_none_or(|tier| !state.catalog.belt_speeds.contains_key(&tier))
            || lanes < 1.0
            || lanes.fract().abs() > EPSILON
            || stack_size < 1.0
            || stack_size.fract().abs() > EPSILON
            || priority > 2
            || !state.catalog.items.contains_key(item_id)
        {
            return Ok(Some("ordinary-belt-definition-invalid"));
        }
    }
    Ok(None)
}

pub(crate) fn transfer(
    state: &CoreState,
    base: &Map<String, Value>,
    entities: &mut [Value],
    belts: &mut [Value],
    seconds: f64,
    defer_source_depletion_reset: bool,
    allowance_caps: Option<&HashMap<String, f64>>,
    flow_window_seconds: f64,
) -> anyhow::Result<()> {
    if belts.is_empty() {
        return Ok(());
    }
    let routes = routes(state, entities, belts)?;
    let belt_limit = normalized_buffer_limit(
        base.get("settings")
            .and_then(Value::as_object)
            .and_then(|settings| settings.get("beltBufferLimit")),
    );
    let flow_decay = 0.8_f64.powf(seconds.max(0.0));
    let congestion_decay = 0.85_f64.powf(seconds.max(0.0));
    let mut target_free = HashMap::<String, f64>::new();
    let mut groups = Vec::<Group>::new();
    let mut group_index = HashMap::<String, usize>::new();

    for (route_index, route) in routes.iter().enumerate() {
        let belt = belts[route.belt_index]
            .as_object_mut()
            .ok_or_else(|| anyhow!("native belt record is not an object"))?;
        let last_flow = rounded(finite_number(belt.get("lastFlow")) * flow_decay, 3);
        let congestion = rounded(finite_number(belt.get("congestion")) * congestion_decay, 3);
        set_number(belt, "lastFlow", last_flow)?;
        set_number(belt, "congestion", congestion)?;
        if seconds > 0.0 {
            let current = finite_number(belt.get("progress")).max(0.0);
            let progress = if current > belt_limit {
                current
            } else {
                (current + route.capacity * seconds).min(belt_limit)
            };
            set_number(belt, "progress", rounded(progress, 4))?;
        }

        let key = format!("{}:{}", route.source_id, route.item_id);
        let index = *group_index.entry(key).or_insert_with(|| {
            let index = groups.len();
            let source = entities[route.source_index]
                .as_object()
                .expect("validated source");
            groups.push(Group {
                source_index: route.source_index,
                item_id: route.item_id.clone(),
                available: (output_amount(source, &route.item_id) + EPSILON).floor(),
                candidates: Vec::new(),
            });
            index
        });
        if groups[index].available < 1.0 {
            if !defer_source_depletion_reset {
                set_number(belt, "progress", 0.0)?;
            }
            continue;
        }
        let target_key = format!("{}:{}", route.target_id, route.item_id);
        if !target_free.contains_key(&target_key) {
            let target = entities[route.target_index]
                .as_object()
                .ok_or_else(|| anyhow!("native belt target is not an object"))?;
            target_free.insert(
                target_key.clone(),
                target_capacity(state, base, target, &route.item_id)?
                    .floor()
                    .max(0.0),
            );
        }
        if target_free.get(&target_key).copied().unwrap_or(0.0) < 1.0 {
            set_number(belt, "progress", 0.0)?;
            continue;
        }
        let cap = allowance_caps
            .and_then(|caps| string_at(belt, "id").and_then(|id| caps.get(id).copied()))
            .unwrap_or(9_007_199_254_740_991.0);
        let allowance = (finite_number(belt.get("progress")) + EPSILON)
            .floor()
            .min(cap);
        groups[index].candidates.push(Candidate {
            route_index,
            target_key,
            allowance,
            moved: 0.0,
        });
    }

    for group in &mut groups {
        group.candidates.sort_by(|left, right| {
            let left_id = belts[routes[left.route_index].belt_index]
                .as_object()
                .and_then(|belt| string_at(belt, "id"))
                .unwrap_or_default();
            let right_id = belts[routes[right.route_index].belt_index]
                .as_object()
                .and_then(|belt| string_at(belt, "id"))
                .unwrap_or_default();
            left_id.cmp(right_id)
        });
        let mut available = group.available;
        let priorities: &[usize] = if group.candidates.len() == 1 {
            &[3]
        } else {
            &[2, 1, 0]
        };
        for &priority in priorities {
            let candidate_indexes = group
                .candidates
                .iter()
                .enumerate()
                .filter_map(|(index, candidate)| {
                    let route = &routes[candidate.route_index];
                    (priority == 3 || route.priority == priority).then_some(index)
                })
                .collect::<Vec<_>>();
            let usable = candidate_indexes
                .into_iter()
                .filter(|&index| {
                    group.candidates[index].allowance > 0.0
                        && target_free
                            .get(&group.candidates[index].target_key)
                            .copied()
                            .unwrap_or(0.0)
                            > 0.0
                })
                .collect::<Vec<_>>();
            if usable.is_empty() || available <= 0.0 {
                continue;
            }
            if usable.len() == 1 {
                let index = usable[0];
                let candidate = &mut group.candidates[index];
                let free = target_free
                    .get(&candidate.target_key)
                    .copied()
                    .unwrap_or(0.0);
                let moved = available
                    .min(candidate.allowance)
                    .min(free)
                    .floor()
                    .max(0.0);
                if moved > 0.0 {
                    let route = &routes[candidate.route_index];
                    add_input(
                        entities[route.target_index]
                            .as_object_mut()
                            .ok_or_else(|| anyhow!("native belt target is not an object"))?,
                        &route.item_id,
                        moved,
                    )?;
                    *target_free
                        .get_mut(&candidate.target_key)
                        .expect("target ledger") -= moved;
                    candidate.allowance -= moved;
                    candidate.moved += moved;
                    available -= moved;
                    set_number(
                        entities[group.source_index]
                            .as_object_mut()
                            .ok_or_else(|| anyhow!("native belt source is not an object"))?,
                        "routingCursor",
                        0.0,
                    )?;
                }
                continue;
            }
            let source_cursor = finite_number(
                entities[group.source_index]
                    .as_object()
                    .and_then(|source| source.get("routingCursor")),
            )
            .floor()
            .max(0.0) as usize;
            let mut cursor = source_cursor % usable.len();
            while available > 0.0 {
                let active = usable
                    .iter()
                    .copied()
                    .filter(|&index| {
                        group.candidates[index].allowance > 0.0
                            && target_free
                                .get(&group.candidates[index].target_key)
                                .copied()
                                .unwrap_or(0.0)
                                > 0.0
                    })
                    .collect::<Vec<_>>();
                if active.is_empty() {
                    break;
                }
                let start = cursor % active.len();
                let fair_share = (available / active.len() as f64).floor().max(1.0);
                let mut successful = 0;
                for offset in 0..active.len() {
                    if available <= 0.0 {
                        break;
                    }
                    let index = active[(start + offset) % active.len()];
                    let candidate = &mut group.candidates[index];
                    let free = target_free
                        .get(&candidate.target_key)
                        .copied()
                        .unwrap_or(0.0);
                    let moved = available
                        .min(fair_share)
                        .min(candidate.allowance)
                        .min(free)
                        .floor()
                        .max(0.0);
                    if moved <= 0.0 {
                        continue;
                    }
                    let route = &routes[candidate.route_index];
                    add_input(
                        entities[route.target_index]
                            .as_object_mut()
                            .ok_or_else(|| anyhow!("native belt target is not an object"))?,
                        &route.item_id,
                        moved,
                    )?;
                    *target_free
                        .get_mut(&candidate.target_key)
                        .expect("target ledger") -= moved;
                    candidate.allowance -= moved;
                    candidate.moved += moved;
                    available -= moved;
                    successful += 1;
                    cursor = (cursor + 1) % usable.len();
                }
                if successful == 0 {
                    break;
                }
            }
            set_number(
                entities[group.source_index]
                    .as_object_mut()
                    .ok_or_else(|| anyhow!("native belt source is not an object"))?,
                "routingCursor",
                cursor as f64,
            )?;
            if available <= 0.0 {
                break;
            }
        }

        set_output(
            entities[group.source_index]
                .as_object_mut()
                .ok_or_else(|| anyhow!("native belt source is not an object"))?,
            &group.item_id,
            available,
        )?;
        for candidate in &group.candidates {
            let route = &routes[candidate.route_index];
            let free = target_free
                .get(&candidate.target_key)
                .copied()
                .unwrap_or(0.0);
            let belt = belts[route.belt_index]
                .as_object_mut()
                .ok_or_else(|| anyhow!("native belt record is not an object"))?;
            let progress = if !defer_source_depletion_reset && available <= 0.0 || free <= 0.0 {
                0.0
            } else {
                rounded(
                    (finite_number(belt.get("progress")) - candidate.moved).max(0.0),
                    4,
                )
            };
            set_number(belt, "progress", progress)?;
            if candidate.moved > 0.0 {
                if flow_window_seconds > 0.0 {
                    let prior = if seconds > 0.0 {
                        0.0
                    } else {
                        finite_number(belt.get("lastFlow"))
                    };
                    set_number(
                        belt,
                        "lastFlow",
                        rounded(
                            route
                                .capacity
                                .min(prior + candidate.moved / flow_window_seconds),
                            3,
                        ),
                    )?;
                }
                let total = (finite_number(belt.get("totalTransferred")) + candidate.moved).floor();
                set_number(belt, "totalTransferred", total)?;
            }
            let source_waiting = available > 0.0;
            let target_blocked = free <= 0.0;
            let load = if route.capacity > EPSILON {
                finite_number(belt.get("lastFlow")) / route.capacity
            } else {
                0.0
            };
            set_number(
                belt,
                "congestion",
                rounded(
                    1.0_f64.min(load.max(if source_waiting && target_blocked {
                        1.0
                    } else {
                        0.0
                    })),
                    3,
                ),
            )?;
        }
    }
    Ok(())
}

pub(crate) fn reserve(
    state: &CoreState,
    base: &Map<String, Value>,
    entities: &[Value],
    belts: &[Value],
) -> anyhow::Result<BeltStepReservation> {
    let routes = routes(state, entities, belts)?;
    let belt_limit = normalized_buffer_limit(
        base.get("settings")
            .and_then(Value::as_object)
            .and_then(|settings| settings.get("beltBufferLimit")),
    );
    let mut result = BeltStepReservation::default();
    let mut target_free = HashMap::<String, f64>::new();
    for route in &routes {
        let belt = belts[route.belt_index]
            .as_object()
            .ok_or_else(|| anyhow!("native belt record is not an object"))?;
        let allowance = (finite_number(belt.get("progress")) + EPSILON)
            .floor()
            .max(0.0);
        if allowance < 1.0 {
            continue;
        }
        let key = format!("{}:{}", route.target_id, route.item_id);
        if !target_free.contains_key(&key) {
            let target = entities[route.target_index]
                .as_object()
                .ok_or_else(|| anyhow!("native belt target is not an object"))?;
            target_free.insert(
                key.clone(),
                target_capacity(state, base, target, &route.item_id)?
                    .floor()
                    .max(0.0),
            );
        }
        let free = target_free.get(&key).copied().unwrap_or(0.0);
        let reserved = allowance.min(free.floor().max(0.0));
        if reserved < 1.0 {
            continue;
        }
        let belt_id = string_at(belt, "id")
            .ok_or_else(|| anyhow!("native belt ID is missing"))?
            .to_owned();
        result.allowance_by_belt.insert(belt_id, reserved);
        *target_free.get_mut(&key).expect("target ledger") -= reserved;
        let source_key = format!("{}:{}", route.source_id, route.item_id);
        let credit = result.output_credits.entry(source_key).or_default();
        *credit = (*credit + reserved).min(belt_limit);
    }
    Ok(result)
}

pub(crate) fn output_credit(credits: &HashMap<String, f64>, entity_id: &str, item_id: &str) -> f64 {
    credits
        .get(&format!("{entity_id}:{item_id}"))
        .copied()
        .unwrap_or(0.0)
}

pub(crate) fn aggregate_flow(state: &CoreState, belts: &[Value]) -> anyhow::Result<(f64, f64)> {
    let mut capacity = 0.0;
    let mut flow = 0.0;
    for belt in belts {
        let belt = belt
            .as_object()
            .ok_or_else(|| anyhow!("native belt record is not an object"))?;
        let tier = belt
            .get("tier")
            .and_then(Value::as_u64)
            .and_then(|value| u8::try_from(value).ok())
            .ok_or_else(|| anyhow!("native belt tier is invalid"))?;
        let speed = state
            .catalog
            .belt_speeds
            .get(&tier)
            .copied()
            .with_context(|| format!("native belt tier {tier} is missing"))?;
        capacity += speed
            * finite_number(belt.get("lanes")).floor()
            * finite_number(belt.get("stackSize")).max(1.0).floor();
        flow += finite_number(belt.get("lastFlow")).max(0.0);
    }
    if !capacity.is_finite() || !flow.is_finite() {
        bail!("native belt aggregate is non-finite");
    }
    Ok((capacity, flow))
}
