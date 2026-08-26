use anyhow::anyhow;
use num_bigint::BigUint;
use num_traits::{ToPrimitive, Zero};
use serde_json::{Map, Number, Value};

use crate::state::CoreState;

const PORT_COUNT: usize = 4;
const UPLOAD_PER_MINUTE: f64 = 20_000.0;
const MAX_INTEGER_DIGITS: usize = 256;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Debug)]
struct CargoInput {
    item_id: String,
    port_index: usize,
    available: BigUint,
    planned: BigUint,
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
    let number = Number::from_f64(value)
        .ok_or_else(|| anyhow!("native orbital cargo simulation produced a non-finite number"))?;
    object.insert(key.to_owned(), Value::Number(number));
    Ok(())
}

fn station_integer(value: Option<&Value>) -> BigUint {
    match value {
        Some(Value::String(text))
            if !text.is_empty()
                && text.len() <= MAX_INTEGER_DIGITS
                && text.bytes().all(|byte| byte.is_ascii_digit()) =>
        {
            BigUint::parse_bytes(text.as_bytes(), 10).unwrap_or_default()
        }
        Some(Value::Number(number)) => number
            .as_u64()
            .filter(|value| *value <= MAX_SAFE_INTEGER)
            .map(BigUint::from)
            .unwrap_or_default(),
        _ => BigUint::zero(),
    }
}

fn station_integer_text(value: BigUint) -> String {
    if value.is_zero() {
        return "0".to_owned();
    }
    let text = value.to_string();
    if text.len() <= MAX_INTEGER_DIGITS {
        text
    } else {
        "9".repeat(MAX_INTEGER_DIGITS)
    }
}

fn positive_difference(required: BigUint, delivered: BigUint) -> BigUint {
    if required > delivered {
        required - delivered
    } else {
        BigUint::zero()
    }
}

fn active_stage_id(status: &str) -> Option<&'static str> {
    match status {
        "eligible" | "core-building" => Some("core"),
        "dock-building" => Some("dock"),
        "showcase-building" => Some("showcase"),
        _ => None,
    }
}

fn station_object(base: &Map<String, Value>) -> Option<&Map<String, Value>> {
    base.get("orbitalStation").and_then(Value::as_object)
}

fn station_status(base: &Map<String, Value>) -> &str {
    station_object(base)
        .and_then(|station| string_at(station, "status"))
        .unwrap_or("locked")
}

fn construction_remaining(base: &Map<String, Value>, item_id: &str) -> BigUint {
    let Some(station) = station_object(base) else {
        return BigUint::zero();
    };
    let Some(stage_id) = string_at(station, "status").and_then(active_stage_id) else {
        return BigUint::zero();
    };
    let Some(stage) = station
        .get("construction")
        .and_then(Value::as_object)
        .and_then(|construction| construction.get("stageRequirements"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_object)
        .find(|stage| string_at(stage, "stageId") == Some(stage_id))
    else {
        return BigUint::zero();
    };
    let delivered = stage.get("delivered").and_then(Value::as_object);
    stage
        .get("costs")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_object)
        .filter(|cost| string_at(cost, "itemId") == Some(item_id))
        .fold(BigUint::zero(), |total, cost| {
            let required = station_integer(cost.get("amount"));
            let current = station_integer(delivered.and_then(|values| values.get(item_id)));
            total + positive_difference(required, current)
        })
}

fn source_planet_allowed(requirement: &Map<String, Value>, planet_id: &str) -> bool {
    if string_at(requirement, "channel") == Some("quantum") {
        return false;
    }
    requirement
        .get("sourcePlanetIds")
        .and_then(Value::as_array)
        .is_none_or(|planets| {
            planets.is_empty()
                || planets
                    .iter()
                    .any(|value| value.as_str() == Some(planet_id))
        })
}

fn accepted_contract<'a>(
    station: &'a Map<String, Value>,
    contract_id: &str,
) -> Option<&'a Map<String, Value>> {
    station
        .get("contractBoard")
        .and_then(Value::as_object)
        .and_then(|board| board.get("accepted"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_object)
        .find(|contract| string_at(contract, "id") == Some(contract_id))
}

fn contract_remaining(
    base: &Map<String, Value>,
    contract_id: &str,
    item_id: &str,
    planet_id: &str,
) -> BigUint {
    let Some(contract) =
        station_object(base).and_then(|station| accepted_contract(station, contract_id))
    else {
        return BigUint::zero();
    };
    contract
        .get("requirements")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_object)
        .filter(|requirement| {
            string_at(requirement, "itemId") == Some(item_id)
                && source_planet_allowed(requirement, planet_id)
        })
        .fold(BigUint::zero(), |total, requirement| {
            let required = station_integer(requirement.get("amount"));
            let delivered = station_integer(requirement.get("delivered"));
            total + positive_difference(required, delivered)
        })
}

fn binding_contract_id(binding: &Value) -> Option<&str> {
    let binding = binding.as_object()?;
    (string_at(binding, "kind") == Some("contract"))
        .then(|| string_at(binding, "contractId"))
        .flatten()
}

fn binding_is_construction(binding: &Value) -> bool {
    binding
        .as_object()
        .and_then(|binding| string_at(binding, "kind"))
        == Some("construction")
}

fn binding_is_valid(base: &Map<String, Value>, binding: Option<&Value>) -> bool {
    let Some(binding) = binding.filter(|binding| !binding.is_null()) else {
        return true;
    };
    if binding_is_construction(binding) {
        return matches!(
            station_status(base),
            "eligible" | "core-building" | "dock-building" | "showcase-building"
        );
    }
    let Some(contract_id) = binding_contract_id(binding) else {
        return false;
    };
    station_object(base)
        .and_then(|station| accepted_contract(station, contract_id))
        .and_then(|contract| string_at(contract, "status"))
        .is_some_and(|status| matches!(status, "accepted" | "claimable"))
}

fn target_remaining(
    base: &Map<String, Value>,
    binding: Option<&Value>,
    item_id: &str,
    planet_id: &str,
) -> BigUint {
    let Some(binding) = binding.filter(|binding| !binding.is_null()) else {
        return BigUint::zero();
    };
    if binding_is_construction(binding) {
        construction_remaining(base, item_id)
    } else if let Some(contract_id) = binding_contract_id(binding) {
        contract_remaining(base, contract_id, item_id, planet_id)
    } else {
        BigUint::zero()
    }
}

fn port_items(state: &CoreState, terminal: &Map<String, Value>) -> [Option<String>; PORT_COUNT] {
    std::array::from_fn(|index| {
        terminal
            .get("orbitalCargoPortItems")
            .and_then(Value::as_array)
            .and_then(|items| items.get(index))
            .and_then(Value::as_str)
            .filter(|item_id| state.catalog.items.contains_key(*item_id))
            .map(str::to_owned)
    })
}

pub(crate) fn terminal_accepts(
    state: &CoreState,
    terminal: &Map<String, Value>,
    item_id: &str,
    requested_port: Option<u8>,
) -> bool {
    let base = state.base_value();
    if base.get("mode").and_then(Value::as_str) != Some("normal")
        || string_at(terminal, "buildingId") != Some("orbital_cargo_terminal")
        || !state.catalog.items.contains_key(item_id)
    {
        return false;
    }
    let planet_id = string_at(terminal, "planetId").unwrap_or_default();
    let colonized = base
        .get("exploration")
        .and_then(Value::as_object)
        .and_then(|exploration| exploration.get("colonizedPlanetIds"))
        .and_then(Value::as_array)
        .is_some_and(|planets| {
            planets
                .iter()
                .any(|planet| planet.as_str() == Some(planet_id))
        });
    if !colonized
        || target_remaining(
            base,
            terminal.get("orbitalCargoBinding"),
            item_id,
            planet_id,
        )
        .is_zero()
    {
        return false;
    }
    let ports = port_items(state, terminal);
    if let Some(port) = requested_port.map(usize::from) {
        return port < PORT_COUNT
            && ports[port]
                .as_deref()
                .is_none_or(|configured| configured == item_id);
    }
    ports.iter().any(|configured| {
        configured
            .as_deref()
            .is_none_or(|configured| configured == item_id)
    })
}

pub(crate) fn admission_reason(state: &CoreState) -> anyhow::Result<Option<&'static str>> {
    let base = state.base_value();
    for &index in &state.factory_topology.orbital_cargo_terminal_indices {
        let terminal = state.parse_entity(index)?;
        let terminal = terminal
            .as_object()
            .ok_or_else(|| anyhow!("native orbital cargo terminal is not an object"))?;
        if string_at(terminal, "kind") != Some("storage")
            || terminal.get("inputs").and_then(Value::as_object).is_none()
            || terminal.get("outputs").and_then(Value::as_object).is_none()
        {
            return Ok(Some("orbital-cargo-terminal-record-invalid"));
        }
        let binding = terminal.get("orbitalCargoBinding");
        if !binding_is_valid(base, binding) || binding.is_none_or(Value::is_null) {
            continue;
        }
    }
    Ok(None)
}

fn stage_is_complete(stage: &Map<String, Value>) -> bool {
    let delivered = stage.get("delivered").and_then(Value::as_object);
    let costs_complete = stage
        .get("costs")
        .and_then(Value::as_array)
        .is_some_and(|costs| {
            costs.iter().filter_map(Value::as_object).all(|cost| {
                let Some(item_id) = string_at(cost, "itemId") else {
                    return false;
                };
                station_integer(delivered.and_then(|values| values.get(item_id)))
                    >= station_integer(cost.get("amount"))
            })
        });
    let fleet_complete = stage
        .get("fleetCosts")
        .and_then(Value::as_object)
        .is_none_or(|costs| {
            let delivered = stage.get("deliveredFleet").and_then(Value::as_object);
            costs.iter().all(|(fleet_id, amount)| {
                finite_number(delivered.and_then(|values| values.get(fleet_id)))
                    .floor()
                    .max(0.0)
                    >= finite_number(Some(amount)).floor().max(0.0)
            })
        });
    costs_complete && fleet_complete
}

fn deliver_construction(
    base: &mut Map<String, Value>,
    item_id: &str,
    amount: &BigUint,
) -> anyhow::Result<BigUint> {
    if amount.is_zero() {
        return Ok(BigUint::zero());
    }
    let station = base
        .get_mut("orbitalStation")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| anyhow!("native orbital station state is missing"))?;
    let status = string_at(station, "status").unwrap_or("locked").to_owned();
    let Some(stage_id) = active_stage_id(&status) else {
        return Ok(BigUint::zero());
    };
    if status == "eligible" {
        station.insert("status".to_owned(), Value::from("core-building"));
    }
    let stages = station
        .get_mut("construction")
        .and_then(Value::as_object_mut)
        .and_then(|construction| construction.get_mut("stageRequirements"))
        .and_then(Value::as_array_mut)
        .ok_or_else(|| anyhow!("native orbital construction stages are missing"))?;
    let Some(stage_index) = stages.iter().position(|stage| {
        stage
            .as_object()
            .and_then(|stage| string_at(stage, "stageId"))
            == Some(stage_id)
    }) else {
        return Ok(BigUint::zero());
    };
    let stage = stages[stage_index]
        .as_object_mut()
        .ok_or_else(|| anyhow!("native orbital construction stage is invalid"))?;
    let delivered_before = stage
        .get("delivered")
        .and_then(Value::as_object)
        .and_then(|delivered| delivered.get(item_id));
    let current = station_integer(delivered_before);
    let remaining = stage
        .get("costs")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_object)
        .filter(|cost| string_at(cost, "itemId") == Some(item_id))
        .fold(BigUint::zero(), |total, cost| {
            total + positive_difference(station_integer(cost.get("amount")), current.clone())
        });
    let accepted = amount.min(&remaining).clone();
    if accepted.is_zero() {
        return Ok(accepted);
    }
    stage
        .get_mut("delivered")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| anyhow!("native orbital construction delivery record is missing"))?
        .insert(
            item_id.to_owned(),
            Value::from(station_integer_text(current + &accepted)),
        );
    let completed = stage_is_complete(stage);
    if completed {
        let next = match stage_id {
            "core" => "dock-building",
            "dock" => "showcase-building",
            _ => "operational",
        };
        station.insert("status".to_owned(), Value::from(next));
    }
    Ok(accepted)
}

fn contract_is_complete(contract: &Map<String, Value>) -> bool {
    contract
        .get("requirements")
        .and_then(Value::as_array)
        .is_some_and(|requirements| {
            requirements
                .iter()
                .filter_map(Value::as_object)
                .all(|requirement| {
                    station_integer(requirement.get("delivered"))
                        >= station_integer(requirement.get("amount"))
                })
        })
}

fn deliver_contract(
    base: &mut Map<String, Value>,
    contract_id: &str,
    item_id: &str,
    amount: &BigUint,
    planet_id: &str,
) -> anyhow::Result<BigUint> {
    if amount.is_zero() {
        return Ok(BigUint::zero());
    }
    let station = base
        .get_mut("orbitalStation")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| anyhow!("native orbital station state is missing"))?;
    let contract_index = station
        .get("contractBoard")
        .and_then(Value::as_object)
        .and_then(|board| board.get("accepted"))
        .and_then(Value::as_array)
        .and_then(|contracts| {
            contracts.iter().position(|contract| {
                contract
                    .as_object()
                    .and_then(|contract| string_at(contract, "id"))
                    == Some(contract_id)
            })
        });
    let Some(contract_index) = contract_index else {
        return Ok(BigUint::zero());
    };
    let mut accepted = BigUint::zero();
    {
        let contract = station
            .get_mut("contractBoard")
            .and_then(Value::as_object_mut)
            .and_then(|board| board.get_mut("accepted"))
            .and_then(Value::as_array_mut)
            .and_then(|contracts| contracts.get_mut(contract_index))
            .and_then(Value::as_object_mut)
            .ok_or_else(|| anyhow!("native orbital contract is invalid"))?;
        match string_at(contract, "status") {
            Some("accepted") => {}
            Some("claimable") => return Ok(BigUint::zero()),
            _ => return Ok(BigUint::zero()),
        }
        let requirements = contract
            .get_mut("requirements")
            .and_then(Value::as_array_mut)
            .ok_or_else(|| anyhow!("native orbital contract requirements are missing"))?;
        let mut remaining = amount.clone();
        for requirement in requirements.iter_mut().filter_map(Value::as_object_mut) {
            if remaining.is_zero()
                || string_at(requirement, "itemId") != Some(item_id)
                || !source_planet_allowed(requirement, planet_id)
            {
                continue;
            }
            let required = station_integer(requirement.get("amount"));
            let delivered = station_integer(requirement.get("delivered"));
            let need = positive_difference(required, delivered.clone());
            let moved = if remaining < need {
                remaining.clone()
            } else {
                need
            };
            if moved.is_zero() {
                continue;
            }
            requirement.insert(
                "delivered".to_owned(),
                Value::from(station_integer_text(delivered + &moved)),
            );
            remaining -= &moved;
            accepted += moved;
        }
        if !accepted.is_zero() && contract_is_complete(contract) {
            contract.insert("status".to_owned(), Value::from("claimable"));
        }
    }
    if !accepted.is_zero() {
        let exported = station
            .get_mut("totals")
            .and_then(Value::as_object_mut)
            .and_then(|totals| totals.get_mut("exportedByItem"))
            .and_then(Value::as_object_mut)
            .ok_or_else(|| anyhow!("native orbital export totals are missing"))?;
        let total = station_integer(exported.get(item_id)) + &accepted;
        exported.insert(item_id.to_owned(), Value::from(station_integer_text(total)));
    }
    Ok(accepted)
}

fn deliver_item(
    base: &mut Map<String, Value>,
    binding: &Value,
    item_id: &str,
    amount: &BigUint,
    planet_id: &str,
) -> anyhow::Result<BigUint> {
    if binding_is_construction(binding) {
        deliver_construction(base, item_id, amount)
    } else if let Some(contract_id) = binding_contract_id(binding) {
        deliver_contract(base, contract_id, item_id, amount, planet_id)
    } else {
        Ok(BigUint::zero())
    }
}

fn reconcile_binding(
    base: &Map<String, Value>,
    entity: &mut Map<String, Value>,
) -> anyhow::Result<()> {
    if binding_is_valid(base, entity.get("orbitalCargoBinding")) {
        return Ok(());
    }
    entity.insert("orbitalCargoBinding".to_owned(), Value::Null);
    set_number(entity, "orbitalCargoProgress", 0.0)
}

fn next_active_port(inputs: &[CargoInput], active: &[usize], after_port: usize) -> Option<usize> {
    (0..PORT_COUNT)
        .map(|offset| (after_port + offset + 1) % PORT_COUNT)
        .find(|port| {
            active.iter().any(|index| {
                inputs[*index].port_index == *port && !inputs[*index].available.is_zero()
            })
        })
}

pub(crate) fn settle(
    state: &CoreState,
    base: &mut Map<String, Value>,
    entities: &mut [Value],
    seconds: f64,
) -> anyhow::Result<()> {
    if base.get("mode").and_then(Value::as_str) != Some("normal")
        || base.get("paused").and_then(Value::as_bool).unwrap_or(false)
        || seconds <= 0.0
        || !seconds.is_finite()
        || station_status(base) == "locked"
    {
        return Ok(());
    }
    for &index in &state.factory_topology.orbital_cargo_terminal_indices {
        let entity = entities[index]
            .as_object_mut()
            .ok_or_else(|| anyhow!("native orbital cargo terminal is invalid"))?;
        reconcile_binding(base, entity)?;
    }
    let mut terminal_indices = state
        .factory_topology
        .orbital_cargo_terminal_indices
        .iter()
        .copied()
        .filter(|&index| {
            entities[index]
                .as_object()
                .and_then(|entity| entity.get("orbitalCargoBinding"))
                .is_some_and(|binding| !binding.is_null())
        })
        .collect::<Vec<_>>();
    terminal_indices.sort_by(|left, right| {
        entities[*left]
            .as_object()
            .and_then(|entity| string_at(entity, "id"))
            .cmp(
                &entities[*right]
                    .as_object()
                    .and_then(|entity| string_at(entity, "id")),
            )
    });
    if terminal_indices.is_empty() {
        return Ok(());
    }
    for entity_index in terminal_indices {
        let (binding, planet_id, ports, power_factor, progress, routing_cursor, buffered) = {
            let entity = entities[entity_index]
                .as_object()
                .ok_or_else(|| anyhow!("native orbital cargo terminal is invalid"))?;
            let binding = entity
                .get("orbitalCargoBinding")
                .cloned()
                .unwrap_or(Value::Null);
            let planet_id = string_at(entity, "planetId").unwrap_or_default().to_owned();
            let ports = port_items(state, entity);
            let power_factor = finite_number(entity.get("powerFactor")).clamp(0.0, 1.0);
            let progress = finite_number(entity.get("orbitalCargoProgress")).max(0.0);
            let routing_cursor =
                finite_number(entity.get("routingCursor")).floor().max(0.0) as usize % PORT_COUNT;
            let buffered = entity
                .get("inputs")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            (
                binding,
                planet_id,
                ports,
                power_factor,
                progress,
                routing_cursor,
                buffered,
            )
        };
        let mut seen = Vec::<String>::new();
        let mut inputs = Vec::<CargoInput>::new();
        for (port_index, item_id) in ports.into_iter().enumerate() {
            let Some(item_id) = item_id else {
                continue;
            };
            if seen.iter().any(|seen| seen == &item_id) {
                continue;
            }
            seen.push(item_id.clone());
            let buffered_amount = finite_number(buffered.get(&item_id)).floor().max(0.0) as u64;
            let remaining = target_remaining(base, Some(&binding), &item_id, &planet_id);
            let available = BigUint::from(buffered_amount).min(remaining);
            if !available.is_zero() {
                inputs.push(CargoInput {
                    item_id,
                    port_index,
                    available,
                    planned: BigUint::zero(),
                });
            }
        }
        if power_factor <= 0.0 || inputs.is_empty() {
            let entity = entities[entity_index]
                .as_object_mut()
                .expect("validated terminal");
            set_number(entity, "utilization", 0.0)?;
            set_number(entity, "productionRate", 0.0)?;
            continue;
        }
        let accumulated = progress + UPLOAD_PER_MINUTE * seconds * power_factor / 60.0;
        let budget = (accumulated + 1e-9).floor().max(0.0) as u64;
        let fractional = (accumulated - budget as f64).clamp(0.0, 0.999_999_999);
        let mut remaining_budget = BigUint::from(budget);
        let mut cursor = routing_cursor;
        while !remaining_budget.is_zero() {
            let active = inputs
                .iter()
                .enumerate()
                .filter_map(|(index, input)| (!input.available.is_zero()).then_some(index))
                .collect::<Vec<_>>();
            if active.is_empty() {
                break;
            }
            let mut ordered_active = active.clone();
            ordered_active.sort_by_key(|index| {
                (inputs[*index].port_index + PORT_COUNT - cursor) % PORT_COUNT
            });
            let count = BigUint::from(active.len());
            let full_rounds = &remaining_budget / &count;
            let minimum = active
                .iter()
                .map(|index| inputs[*index].available.clone())
                .min()
                .unwrap_or_default();
            let rounds = full_rounds.min(minimum);
            if !rounds.is_zero() {
                for &index in &active {
                    inputs[index].available -= &rounds;
                    inputs[index].planned += &rounds;
                }
                remaining_budget -= &rounds * &count;
                let last_port = inputs[*ordered_active.last().expect("active cargo")].port_index;
                cursor = next_active_port(&inputs, &active, last_port)
                    .unwrap_or((last_port + 1) % PORT_COUNT);
                continue;
            }
            let start_cursor = cursor;
            let mut allocated = false;
            for offset in 0..PORT_COUNT {
                if remaining_budget.is_zero() {
                    break;
                }
                let port = (start_cursor + offset) % PORT_COUNT;
                let Some(index) = active.iter().copied().find(|index| {
                    inputs[*index].port_index == port && !inputs[*index].available.is_zero()
                }) else {
                    continue;
                };
                inputs[index].available -= 1_u8;
                inputs[index].planned += 1_u8;
                remaining_budget -= 1_u8;
                cursor =
                    next_active_port(&inputs, &active, port).unwrap_or((port + 1) % PORT_COUNT);
                allocated = true;
            }
            if !allocated {
                break;
            }
        }
        let mut uploaded = BigUint::zero();
        for input in &inputs {
            if input.planned.is_zero() {
                continue;
            }
            let accepted =
                deliver_item(base, &binding, &input.item_id, &input.planned, &planet_id)?;
            if accepted.is_zero() {
                continue;
            }
            let accepted_number = accepted
                .to_u64()
                .ok_or_else(|| anyhow!("native orbital cargo accepted amount exceeds u64"))?
                as f64;
            let entity = entities[entity_index]
                .as_object_mut()
                .expect("validated terminal");
            let current = entity
                .get("inputs")
                .and_then(Value::as_object)
                .and_then(|inputs| inputs.get(&input.item_id))
                .map(|value| finite_number(Some(value)).floor().max(0.0))
                .unwrap_or(0.0);
            entity
                .get_mut("inputs")
                .and_then(Value::as_object_mut)
                .expect("validated terminal inputs")
                .insert(
                    input.item_id.clone(),
                    Value::from((current - accepted_number).max(0.0)),
                );
            uploaded += accepted;
        }
        let entity = entities[entity_index]
            .as_object_mut()
            .expect("validated terminal");
        set_number(entity, "orbitalCargoProgress", fractional)?;
        set_number(entity, "routingCursor", cursor as f64)?;
        let total = station_integer(entity.get("orbitalCargoTotalUploaded")) + &uploaded;
        entity.insert(
            "orbitalCargoTotalUploaded".to_owned(),
            Value::from(station_integer_text(total)),
        );
        let uploaded_number = uploaded
            .to_u64()
            .ok_or_else(|| anyhow!("native orbital cargo upload exceeds u64"))?
            as f64;
        set_number(
            entity,
            "utilization",
            if uploaded.is_zero() {
                0.0
            } else {
                power_factor
            },
        )?;
        set_number(entity, "productionRate", uploaded_number * 60.0 / seconds)?;
    }
    crate::station_contracts::synchronize(state, base)?;
    for &index in &state.factory_topology.orbital_cargo_terminal_indices {
        let entity = entities[index]
            .as_object_mut()
            .ok_or_else(|| anyhow!("native orbital cargo terminal is invalid"))?;
        reconcile_binding(base, entity)?;
    }
    Ok(())
}
