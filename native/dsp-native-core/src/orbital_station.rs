use anyhow::anyhow;
use num_bigint::BigUint;
use num_traits::{ToPrimitive, Zero};
use serde_json::{Map, Number, Value};

use crate::deterministic_runtime::{DeterministicRuntime, runtime as deterministic_runtime};
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

#[derive(Debug)]
struct CargoRequestProbe {
    item_id: String,
    port_index: usize,
    buffered_amount: u64,
}

#[derive(Debug)]
struct ActiveTerminalProbe {
    entity_index: usize,
    entity_id: Option<String>,
    binding: Value,
    planet_id: String,
    power_factor: f64,
    progress: f64,
    routing_cursor: usize,
    requests: Vec<CargoRequestProbe>,
}

#[derive(Debug)]
struct TerminalProbe {
    entity_index: usize,
    reconcile_binding: bool,
    active: Option<ActiveTerminalProbe>,
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

fn collect_ordered_terminal_probes_with_runtime<R, F>(
    runtime: &DeterministicRuntime,
    entity_indices: &[usize],
    probe: F,
) -> anyhow::Result<Vec<R>>
where
    R: Send,
    F: Fn(usize) -> anyhow::Result<R> + Send + Sync,
{
    // Collect every result before choosing an error. `indexed_map` retains
    // the topology order, so a parallel failure always reports the lowest
    // original terminal position instead of the first worker to finish.
    runtime
        .indexed_map(entity_indices, |_, entity_index| probe(*entity_index))
        .into_iter()
        .collect()
}

fn probe_terminal(
    state: &CoreState,
    base: &Map<String, Value>,
    entities: &[Value],
    entity_index: usize,
) -> anyhow::Result<TerminalProbe> {
    let entity = entities
        .get(entity_index)
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("native orbital cargo terminal is invalid"))?;
    let binding = entity
        .get("orbitalCargoBinding")
        .cloned()
        .unwrap_or(Value::Null);
    let binding_valid = binding_is_valid(base, Some(&binding));
    if !binding_valid || binding.is_null() {
        return Ok(TerminalProbe {
            entity_index,
            reconcile_binding: !binding_valid,
            active: None,
        });
    }

    let ports = port_items(state, entity);
    let buffered = entity.get("inputs").and_then(Value::as_object);
    let mut seen = Vec::<String>::with_capacity(PORT_COUNT);
    let mut requests = Vec::<CargoRequestProbe>::with_capacity(PORT_COUNT);
    for (port_index, item_id) in ports.into_iter().enumerate() {
        let Some(item_id) = item_id else {
            continue;
        };
        if seen.iter().any(|seen| seen == &item_id) {
            continue;
        }
        seen.push(item_id.clone());
        requests.push(CargoRequestProbe {
            buffered_amount: finite_number(buffered.and_then(|inputs| inputs.get(&item_id)))
                .floor()
                .max(0.0) as u64,
            item_id,
            port_index,
        });
    }

    Ok(TerminalProbe {
        entity_index,
        reconcile_binding: false,
        active: Some(ActiveTerminalProbe {
            entity_index,
            entity_id: string_at(entity, "id").map(str::to_owned),
            binding,
            planet_id: string_at(entity, "planetId").unwrap_or_default().to_owned(),
            power_factor: finite_number(entity.get("powerFactor")).clamp(0.0, 1.0),
            progress: finite_number(entity.get("orbitalCargoProgress")).max(0.0),
            routing_cursor: finite_number(entity.get("routingCursor")).floor().max(0.0) as usize
                % PORT_COUNT,
            requests,
        }),
    })
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

fn settle_with_runtime(
    runtime: &DeterministicRuntime,
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
    // Entity-local terminal snapshots are independent. Parse and normalize
    // them on the shared deterministic pool, then replay every shared target,
    // inventory and cursor mutation in the original ID order below. Nothing
    // is written until all probes (and the lowest-index error) are known.
    let probes = collect_ordered_terminal_probes_with_runtime(
        runtime,
        &state.factory_topology.orbital_cargo_terminal_indices,
        |entity_index| probe_terminal(state, base, entities, entity_index),
    )?;
    for probe in &probes {
        if !probe.reconcile_binding {
            continue;
        }
        let entity = entities[probe.entity_index]
            .as_object_mut()
            .expect("validated orbital cargo terminal disappeared before replay");
        reconcile_binding(base, entity)?;
    }
    let mut terminals = probes
        .into_iter()
        .filter_map(|probe| probe.active)
        .collect::<Vec<_>>();
    terminals.sort_by(|left, right| left.entity_id.cmp(&right.entity_id));
    if terminals.is_empty() {
        return Ok(());
    }
    for terminal in terminals {
        let ActiveTerminalProbe {
            entity_index,
            binding,
            planet_id,
            power_factor,
            progress,
            routing_cursor,
            requests,
            ..
        } = terminal;
        let mut inputs = Vec::<CargoInput>::new();
        for request in requests {
            let remaining = target_remaining(base, Some(&binding), &request.item_id, &planet_id);
            let available = BigUint::from(request.buffered_amount).min(remaining);
            if !available.is_zero() {
                inputs.push(CargoInput {
                    item_id: request.item_id,
                    port_index: request.port_index,
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

pub(crate) fn settle(
    state: &CoreState,
    base: &mut Map<String, Value>,
    entities: &mut [Value],
    seconds: f64,
) -> anyhow::Result<()> {
    settle_with_runtime(deterministic_runtime(), state, base, entities, seconds)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::{
        BeltDefinition, BuildingDefinition, CatalogSnapshot, ItemDefinition, PlanetDefinition,
        RuntimeCatalog,
    };
    use crate::deterministic_runtime::PARALLEL_MIN_ITEMS;
    use crate::state::CoreCheckpointIdentity;
    use serde_json::json;
    use std::collections::{BTreeMap, HashMap};
    use std::sync::atomic::{AtomicBool, Ordering as AtomicOrdering};

    fn fixture_checksum(bytes: &[u8]) -> String {
        let mut hash = 0x811c9dc5_u32;
        for byte in bytes {
            hash ^= u32::from(*byte);
            hash = hash.wrapping_mul(0x01000193);
        }
        format!("{hash:08x}")
    }

    fn fixture_catalog() -> RuntimeCatalog {
        RuntimeCatalog::validate(
            CatalogSnapshot {
                protocol_version: 1,
                registry_fingerprint: "orbital-terminal-parallel-test".to_owned(),
                planets: vec![PlanetDefinition {
                    id: "home".to_owned(),
                    name: "home".to_owned(),
                    system_id: "helios".to_owned(),
                    kind: "terrestrial".to_owned(),
                    orbit_index: 1,
                    simulation_order: 0,
                    orbital_yields: HashMap::new(),
                }],
                items: vec![ItemDefinition {
                    id: "iron_ore".to_owned(),
                    name: "iron_ore".to_owned(),
                    kind: "solid".to_owned(),
                    fuel_energy_mj: 0.0,
                }],
                buildings: vec![BuildingDefinition {
                    id: "orbital_cargo_terminal".to_owned(),
                    kind: "storage".to_owned(),
                    speed: 1.0,
                    input_capacity: 1_000_000.0,
                    output_capacity: 0.0,
                    power_demand_kw: 1.0,
                    power_generation_kw: 0.0,
                    power_charge_kw: 0.0,
                    energy_capacity_mj: 0.0,
                    fuel_item_ids: Vec::new(),
                    fuel_efficiency: 1.0,
                    family: None,
                    accepts: None,
                }],
                recipes: Vec::new(),
                constructions: Vec::new(),
                belts: vec![BeltDefinition {
                    tier: 1,
                    speed: 6.0,
                }],
                proliferators: Vec::new(),
                technologies: Vec::new(),
            },
            "orbital-terminal-parallel-test",
        )
        .unwrap()
    }

    fn fixture_base() -> Value {
        json!({
            "version": 47,
            "mode": "normal",
            "paused": false,
            "activePlanetId": "home",
            "exploration": { "colonizedPlanetIds": ["home"] },
            "orbitalStation": {
                "status": "core-building",
                "construction": {
                    "stageRequirements": [{
                        "stageId": "core",
                        "costs": [{ "itemId": "iron_ore", "amount": "1000000000" }],
                        "delivered": { "iron_ore": "0" },
                        "fleetCosts": {},
                        "deliveredFleet": {}
                    }]
                },
                "contractBoard": {
                    "taskDay": 0,
                    "lastConfirmedWallClockMs": 0,
                    "offers": [],
                    "accepted": [],
                    "history": [],
                    "settledIds": []
                },
                "totals": { "exportedByItem": {} }
            },
            "mod:base/opaque": { "signedZero": -0.0, "text": "必须保持原样" }
        })
    }

    fn terminal_entity(index: usize, count: usize) -> Value {
        let buffered = 200 + index % 37;
        json!({
            "id": format!("terminal/{:05}/Ω", count - index),
            "kind": "storage",
            "planetId": "home",
            "buildingId": "orbital_cargo_terminal",
            "inputs": { "iron_ore": buffered },
            "outputs": {},
            "powerFactor": if index.is_multiple_of(41) { 0.0 } else { 0.25 + (index % 4) as f64 * 0.25 },
            "orbitalCargoProgress": (index % 13) as f64 / 13.0,
            "routingCursor": index % PORT_COUNT,
            "orbitalCargoTotalUploaded": "0",
            "orbitalCargoBinding": { "kind": "construction" },
            "orbitalCargoPortItems": ["iron_ore", "iron_ore", null, null],
            "utilization": -1,
            "productionRate": -1,
            "mod:terminal/opaque": {
                "index": index,
                "signedZero": -0.0,
                "text": "保持原样"
            }
        })
    }

    fn terminal_matrix(count: usize) -> Vec<Value> {
        (0..count)
            .map(|index| terminal_entity(index, count))
            .collect()
    }

    fn fixture_state(entities: &[Value]) -> CoreState {
        let entity_count = entities.len();
        let base = serde_json::to_vec(&fixture_base()).unwrap();
        let entities = serde_json::to_vec(entities).unwrap();
        let belts = serde_json::to_vec(&Vec::<Value>::new()).unwrap();
        let chunks = [
            ("base", "base", &base, 0, 1),
            ("entities:00000000", "entities", &entities, 0, entity_count),
            ("belts:00000000", "belts", &belts, 0, 0),
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
            "totalBytes": base.len() + entities.len() + belts.len(),
            "entityCount": entity_count,
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
                base,
            ),
            (
                "dsp-idle-network.internal.v1.chunked.v1.normal.chunk.entities%3A00000000"
                    .to_owned(),
                entities,
            ),
            (
                "dsp-idle-network.internal.v1.chunked.v1.normal.chunk.belts%3A00000000".to_owned(),
                belts,
            ),
        ]);
        CoreState::from_internal_records(
            CoreCheckpointIdentity {
                slot: "normal-main".to_owned(),
                generation: 1,
                root_hash: "a".repeat(64),
                revision: 7,
                state_version: 47,
                mode: "normal".to_owned(),
                registry_fingerprint: "orbital-terminal-parallel-test".to_owned(),
                base_primary_checksum: "12345678".to_owned(),
            },
            &records,
            fixture_catalog(),
        )
        .unwrap()
    }

    fn run_terminal_matrix(
        state: &CoreState,
        source: &[Value],
        worker_count: usize,
    ) -> (Value, Vec<Value>) {
        let runtime = DeterministicRuntime::for_test(worker_count);
        let mut base = fixture_base();
        let mut entities = source.to_vec();
        settle_with_runtime(
            &runtime,
            state,
            base.as_object_mut().unwrap(),
            &mut entities,
            0.375,
        )
        .unwrap();
        (base, entities)
    }

    #[test]
    fn terminal_probe_and_serial_replay_are_byte_exact_at_all_worker_limits() {
        let source = terminal_matrix(PARALLEL_MIN_ITEMS + 137);
        let state = fixture_state(&source);
        let state_hash = state.canonical_sha256().unwrap();
        assert_eq!(
            state.factory_topology.orbital_cargo_terminal_indices.len(),
            source.len()
        );

        let baseline = run_terminal_matrix(&state, &source, 1);
        let baseline_bytes = serde_json::to_vec(&baseline).unwrap();
        for worker_count in [2, 4, 8] {
            let observed = run_terminal_matrix(&state, &source, worker_count);
            assert_eq!(
                serde_json::to_vec(&observed).unwrap(),
                baseline_bytes,
                "orbital terminal state diverged for {worker_count} workers"
            );
        }

        assert_eq!(state.canonical_sha256().unwrap(), state_hash);
        assert_ne!(baseline.1, source);
        assert!(
            station_integer(
                baseline
                    .0
                    .get("orbitalStation")
                    .and_then(Value::as_object)
                    .and_then(|station| station.get("construction"))
                    .and_then(Value::as_object)
                    .and_then(|construction| construction.get("stageRequirements"))
                    .and_then(Value::as_array)
                    .and_then(|stages| stages.first())
                    .and_then(Value::as_object)
                    .and_then(|stage| stage.get("delivered"))
                    .and_then(Value::as_object)
                    .and_then(|delivered| delivered.get("iron_ore"))
            ) > BigUint::zero()
        );
        for (before, after) in source.iter().zip(&baseline.1) {
            assert_eq!(
                serde_json::to_vec(&before["mod:terminal/opaque"]).unwrap(),
                serde_json::to_vec(&after["mod:terminal/opaque"]).unwrap()
            );
        }
    }

    #[test]
    fn large_probe_batches_enter_rayon_and_small_batches_stay_serial() {
        let large = (0..PARALLEL_MIN_ITEMS + 73).collect::<Vec<_>>();
        let large_saw_worker = AtomicBool::new(false);
        let observed = collect_ordered_terminal_probes_with_runtime(
            &DeterministicRuntime::for_test(8),
            &large,
            |entity_index| {
                if rayon::current_thread_index().is_some() {
                    large_saw_worker.store(true, AtomicOrdering::SeqCst);
                }
                Ok(entity_index)
            },
        )
        .unwrap();
        assert_eq!(observed, large);
        assert!(large_saw_worker.load(AtomicOrdering::SeqCst));

        let small = (0..31).collect::<Vec<_>>();
        let small_saw_worker = AtomicBool::new(false);
        let observed = collect_ordered_terminal_probes_with_runtime(
            &DeterministicRuntime::for_test(8),
            &small,
            |entity_index| {
                if rayon::current_thread_index().is_some() {
                    small_saw_worker.store(true, AtomicOrdering::SeqCst);
                }
                Ok(entity_index)
            },
        )
        .unwrap();
        assert_eq!(observed, small);
        assert!(!small_saw_worker.load(AtomicOrdering::SeqCst));
    }

    #[test]
    fn parallel_probe_failure_uses_lowest_index_and_leaves_candidate_unchanged() {
        let indices = (0..PARALLEL_MIN_ITEMS + 97).collect::<Vec<_>>();
        for worker_count in [1, 2, 4, 8] {
            let later_visited = AtomicBool::new(false);
            let error = collect_ordered_terminal_probes_with_runtime(
                &DeterministicRuntime::for_test(worker_count),
                &indices,
                |entity_index| {
                    if entity_index == PARALLEL_MIN_ITEMS + 41 {
                        later_visited.store(true, AtomicOrdering::SeqCst);
                        return Err(anyhow!("later terminal failure"));
                    }
                    if entity_index == 7 {
                        return Err(anyhow!("lowest terminal failure"));
                    }
                    Ok(entity_index)
                },
            )
            .unwrap_err();
            assert_eq!(error.to_string(), "lowest terminal failure");
            assert!(later_visited.load(AtomicOrdering::SeqCst));
        }

        let source = terminal_matrix(PARALLEL_MIN_ITEMS + 97);
        let state = fixture_state(&source);
        let state_hash = state.canonical_sha256().unwrap();
        for worker_count in [1, 2, 4, 8] {
            let mut base = fixture_base();
            let mut candidate = source.clone();
            candidate[1]["orbitalCargoBinding"] = json!({ "kind": "invalid" });
            candidate[7] = Value::Null;
            candidate[PARALLEL_MIN_ITEMS + 41] = Value::Null;
            let base_bytes = serde_json::to_vec(&base).unwrap();
            let candidate_bytes = serde_json::to_vec(&candidate).unwrap();
            let error = settle_with_runtime(
                &DeterministicRuntime::for_test(worker_count),
                &state,
                base.as_object_mut().unwrap(),
                &mut candidate,
                1.0,
            )
            .unwrap_err();
            assert_eq!(
                error.to_string(),
                "native orbital cargo terminal is invalid"
            );
            assert_eq!(serde_json::to_vec(&base).unwrap(), base_bytes);
            assert_eq!(serde_json::to_vec(&candidate).unwrap(), candidate_bytes);
            assert_eq!(state.canonical_sha256().unwrap(), state_hash);
        }
    }
}
