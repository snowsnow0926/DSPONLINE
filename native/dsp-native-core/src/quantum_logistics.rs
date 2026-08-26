use std::collections::{BTreeMap, HashMap, HashSet};

use anyhow::{anyhow, bail};
use num_bigint::BigUint;
use num_traits::{ToPrimitive, Zero};
use serde_json::{Map, Number, Value};

use crate::state::CoreState;

const SETTLEMENT_SECONDS: f64 = 5.0;
const UNIT_CAP_PER_MINUTE: f64 = 5_000.0;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const MAX_INTEGER_DIGITS: usize = 256;
const ITEM_CAPACITY_MIN: u64 = 10_000;
const ITEM_CAPACITY_MAX: u64 = 10_000_000_000;

#[derive(Debug, Clone, Default)]
pub(crate) struct BoundaryFlow {
    boundary_second: f64,
    uploaded: BTreeMap<String, BigUint>,
    downloaded: BTreeMap<String, BigUint>,
    global_upload_per_minute: f64,
    global_download_per_minute: f64,
    quantum_tower_stacks: f64,
    quantum_collector_stacks: f64,
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct RuntimeBandwidth {
    per_minute: f64,
    tower_stacks: f64,
    collector_stacks: f64,
}

#[derive(Debug, Clone, Default)]
struct Network {
    enabled: bool,
    inventory: BTreeMap<String, BigUint>,
    item_capacities: BTreeMap<String, BigUint>,
    routing_cursors: BTreeMap<String, u64>,
    upload_routing_cursors: BTreeMap<String, u64>,
    runtime_flow: Option<BoundaryFlow>,
}

#[derive(Debug)]
pub(crate) struct SupplyDepositSession {
    network: Network,
    write_required: bool,
}

#[derive(Debug, Clone)]
struct Slot {
    item_id: Option<String>,
    remote_mode: String,
    min_stock: f64,
    max_stock: f64,
    priority: i64,
}

#[derive(Debug, Clone)]
struct Request {
    key: String,
    entity_index: usize,
    item_id: String,
    amount: BigUint,
    priority: i64,
}

#[derive(Debug, Clone)]
struct TransitionRoute {
    demand_id: String,
    route_id: String,
    item_id: String,
    peer_id: String,
    cargo: String,
    duration: f64,
    progress: f64,
}

#[derive(Debug, Default)]
struct Allocation {
    values: HashMap<String, BigUint>,
    total: BigUint,
    next_cursor: u64,
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
        .ok_or_else(|| anyhow!("native quantum logistics produced a non-finite number"))?;
    if let Some(target) = object.get_mut(key) {
        *target = value;
    } else {
        object.insert(key.to_owned(), value);
    }
    Ok(())
}

fn item_amount(entity: &Map<String, Value>, record: &str, item_id: &str) -> f64 {
    entity
        .get(record)
        .and_then(Value::as_object)
        .and_then(|values| values.get(item_id))
        .map(|value| finite_number(Some(value)))
        .unwrap_or(0.0)
}

fn set_item_amount(
    entity: &mut Map<String, Value>,
    record: &str,
    item_id: &str,
    amount: f64,
) -> anyhow::Result<()> {
    entity
        .get_mut(record)
        .and_then(Value::as_object_mut)
        .ok_or_else(|| anyhow!("native quantum logistics inventory is missing"))?
        .insert(
            item_id.to_owned(),
            Number::from_f64(amount)
                .map(Value::Number)
                .ok_or_else(|| anyhow!("native quantum logistics inventory is non-finite"))?,
        );
    Ok(())
}

fn is_quantum_station(entity: &Map<String, Value>) -> bool {
    string_at(entity, "kind") == Some("station")
        && string_at(entity, "buildingId") == Some("interstellar_logistics_station")
        && string_at(entity, "quantumMode") == Some("quantum")
}

fn is_quantum_collector(entity: &Map<String, Value>) -> bool {
    string_at(entity, "kind") == Some("station")
        && string_at(entity, "buildingId") == Some("orbital_collector")
        && string_at(entity, "quantumMode") == Some("quantum")
}

pub(crate) fn is_supply_endpoint(entity: &Map<String, Value>, item_id: &str) -> bool {
    is_quantum_station(entity)
        && entity
            .get("stationSlots")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_object)
            .any(|slot| {
                string_at(slot, "itemId") == Some(item_id)
                    && string_at(slot, "remoteMode") == Some("supply")
            })
}

fn supply_deposit_session<'a>(
    base: &Map<String, Value>,
    session: &'a mut Option<SupplyDepositSession>,
) -> anyhow::Result<&'a mut SupplyDepositSession> {
    if session.is_none() {
        *session = Some(SupplyDepositSession {
            network: parse_network(base)?,
            write_required: false,
        });
    }
    session
        .as_mut()
        .ok_or_else(|| anyhow!("native quantum supply session is missing"))
}

pub(crate) fn supply_free_capacity_in_session(
    state: &CoreState,
    base: &Map<String, Value>,
    session: &mut Option<SupplyDepositSession>,
    station: &Map<String, Value>,
    item_id: &str,
) -> anyhow::Result<Option<f64>> {
    if !is_supply_endpoint(station, item_id) {
        return Ok(None);
    }
    let network = &supply_deposit_session(base, session)?.network;
    if !network.enabled {
        return Ok(Some(0.0));
    }
    let slot = slots(station)?
        .into_iter()
        .find(|slot| slot.item_id.as_deref() == Some(item_id) && slot.remote_mode == "supply")
        .ok_or_else(|| anyhow!("native quantum supply slot disappeared"))?;
    let current = network.inventory.get(item_id).cloned().unwrap_or_default();
    let capacity = item_capacity(&network, item_id);
    let network_free = if capacity > current {
        (capacity - current)
            .to_u64()
            .unwrap_or(MAX_SAFE_INTEGER)
            .min(MAX_SAFE_INTEGER) as f64
    } else {
        0.0
    };
    let local_free = (station_capacity(state, base, station, &slot)?.floor()
        - item_amount(station, "inputs", item_id).floor().max(0.0))
    .max(0.0);
    Ok(Some(
        (network_free + local_free).min(MAX_SAFE_INTEGER as f64),
    ))
}

pub(crate) fn finish_supply_deposit_session(
    base: &mut Map<String, Value>,
    session: Option<SupplyDepositSession>,
) -> anyhow::Result<()> {
    if let Some(session) = session.filter(|session| session.write_required) {
        write_network(base, &session.network)?;
    }
    Ok(())
}

fn floor_u64(value: f64) -> u64 {
    if !value.is_finite() || value <= 0.0 {
        0
    } else {
        value.floor().min(MAX_SAFE_INTEGER as f64) as u64
    }
}

fn normalized_decimal(value: Option<&Value>, fallback: &BigUint) -> BigUint {
    match value {
        Some(Value::String(value))
            if !value.is_empty()
                && value.len() <= MAX_INTEGER_DIGITS
                && value.bytes().all(|byte| byte.is_ascii_digit()) =>
        {
            BigUint::parse_bytes(value.as_bytes(), 10).unwrap_or_else(BigUint::zero)
        }
        Some(Value::Number(value)) => value
            .as_u64()
            .filter(|value| *value <= MAX_SAFE_INTEGER)
            .map(BigUint::from)
            .unwrap_or_else(|| fallback.clone()),
        _ => fallback.clone(),
    }
}

fn decimal(value: &BigUint) -> String {
    let value = value.to_str_radix(10);
    if value.len() <= MAX_INTEGER_DIGITS {
        value
    } else {
        "9".repeat(MAX_INTEGER_DIGITS)
    }
}

fn saturated(value: BigUint) -> BigUint {
    if value.to_str_radix(10).len() <= MAX_INTEGER_DIGITS {
        value
    } else {
        BigUint::parse_bytes("9".repeat(MAX_INTEGER_DIGITS).as_bytes(), 10)
            .expect("decimal saturation is valid")
    }
}

fn item_capacity(network: &Network, item_id: &str) -> BigUint {
    let value = network
        .item_capacities
        .get(item_id)
        .cloned()
        .unwrap_or_else(|| BigUint::from(ITEM_CAPACITY_MAX));
    value.clamp(
        BigUint::from(ITEM_CAPACITY_MIN),
        BigUint::from(ITEM_CAPACITY_MAX),
    )
}

fn parse_quantity_record(value: Option<&Value>, drop_zeros: bool) -> BTreeMap<String, BigUint> {
    let mut result = BTreeMap::new();
    for (item_id, amount) in value
        .and_then(Value::as_object)
        .into_iter()
        .flat_map(|record| record.iter())
    {
        let amount = normalized_decimal(Some(amount), &BigUint::zero());
        if !drop_zeros || !amount.is_zero() {
            result.insert(item_id.clone(), amount);
        }
    }
    result
}

fn parse_cursor_record(value: Option<&Value>) -> BTreeMap<String, u64> {
    value
        .and_then(Value::as_object)
        .into_iter()
        .flat_map(|record| record.iter())
        .filter_map(|(item_id, cursor)| {
            cursor
                .as_u64()
                .filter(|cursor| *cursor <= MAX_SAFE_INTEGER)
                .map(|cursor| (item_id.clone(), cursor))
        })
        .collect()
}

fn parse_flow(value: Option<&Value>) -> Option<BoundaryFlow> {
    let flow = value?.as_object()?;
    Some(BoundaryFlow {
        boundary_second: finite_number(flow.get("boundarySecond")),
        uploaded: parse_quantity_record(flow.get("uploaded"), false),
        downloaded: parse_quantity_record(flow.get("downloaded"), false),
        global_upload_per_minute: finite_number(flow.get("globalUploadPerMinute")),
        global_download_per_minute: finite_number(flow.get("globalDownloadPerMinute")),
        quantum_tower_stacks: finite_number(flow.get("quantumTowerStacks")),
        quantum_collector_stacks: finite_number(flow.get("quantumCollectorStacks")),
    })
}

fn parse_network(base: &Map<String, Value>) -> anyhow::Result<Network> {
    let raw = base
        .get("quantumLogisticsNetwork")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("native quantum logistics network is missing"))?;
    let capacities = parse_quantity_record(raw.get("itemCapacities"), false)
        .into_iter()
        .map(|(item_id, amount)| {
            (
                item_id,
                amount.clamp(
                    BigUint::from(ITEM_CAPACITY_MIN),
                    BigUint::from(ITEM_CAPACITY_MAX),
                ),
            )
        })
        .collect();
    Ok(Network {
        enabled: raw.get("enabled").and_then(Value::as_bool) == Some(true),
        inventory: parse_quantity_record(raw.get("inventory"), false),
        item_capacities: capacities,
        routing_cursors: parse_cursor_record(raw.get("routingCursors")),
        upload_routing_cursors: parse_cursor_record(raw.get("uploadRoutingCursors")),
        runtime_flow: parse_flow(raw.get("runtimeFlow")),
    })
}

fn quantity_record(values: &BTreeMap<String, BigUint>) -> Value {
    Value::Object(
        values
            .iter()
            .map(|(item_id, amount)| (item_id.clone(), Value::String(decimal(amount))))
            .collect(),
    )
}

fn cursor_record(values: &BTreeMap<String, u64>) -> Value {
    Value::Object(
        values
            .iter()
            .map(|(item_id, cursor)| (item_id.clone(), Value::from(*cursor)))
            .collect(),
    )
}

fn flow_value(flow: &BoundaryFlow) -> anyhow::Result<Value> {
    let mut value = Map::new();
    set_number(&mut value, "boundarySecond", flow.boundary_second)?;
    value.insert("uploaded".to_owned(), quantity_record(&flow.uploaded));
    value.insert("downloaded".to_owned(), quantity_record(&flow.downloaded));
    set_number(
        &mut value,
        "globalUploadPerMinute",
        flow.global_upload_per_minute,
    )?;
    set_number(
        &mut value,
        "globalDownloadPerMinute",
        flow.global_download_per_minute,
    )?;
    set_number(&mut value, "quantumTowerStacks", flow.quantum_tower_stacks)?;
    set_number(
        &mut value,
        "quantumCollectorStacks",
        flow.quantum_collector_stacks,
    )?;
    Ok(Value::Object(value))
}

fn write_network(base: &mut Map<String, Value>, network: &Network) -> anyhow::Result<()> {
    let mut value = Map::new();
    value.insert("enabled".to_owned(), Value::Bool(network.enabled));
    value.insert("inventory".to_owned(), quantity_record(&network.inventory));
    value.insert(
        "itemCapacities".to_owned(),
        quantity_record(&network.item_capacities),
    );
    value.insert(
        "routingCursors".to_owned(),
        cursor_record(&network.routing_cursors),
    );
    value.insert(
        "uploadRoutingCursors".to_owned(),
        cursor_record(&network.upload_routing_cursors),
    );
    if let Some(flow) = &network.runtime_flow {
        value.insert("runtimeFlow".to_owned(), flow_value(flow)?);
    }
    base.insert("quantumLogisticsNetwork".to_owned(), Value::Object(value));
    Ok(())
}

fn slots(entity: &Map<String, Value>) -> anyhow::Result<Vec<Slot>> {
    entity
        .get("stationSlots")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("native quantum station slots are missing"))?
        .iter()
        .map(|value| {
            let slot = value
                .as_object()
                .ok_or_else(|| anyhow!("native quantum station slot is invalid"))?;
            let remote_mode = string_at(slot, "remoteMode").unwrap_or("storage");
            if !matches!(remote_mode, "supply" | "demand" | "storage") {
                bail!("native quantum station remote mode is invalid");
            }
            Ok(Slot {
                item_id: string_at(slot, "itemId").map(str::to_owned),
                remote_mode: remote_mode.to_owned(),
                min_stock: finite_number(slot.get("minStock")).floor().max(0.0),
                max_stock: finite_number(slot.get("maxStock")).floor().max(0.0),
                priority: slot.get("priority").and_then(Value::as_i64).unwrap_or(1),
            })
        })
        .collect()
}

fn normalized_buffer_limit(base: &Map<String, Value>) -> f64 {
    base.get("settings")
        .and_then(Value::as_object)
        .and_then(|settings| settings.get("logisticsBufferLimit"))
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

fn station_capacity(
    state: &CoreState,
    base: &Map<String, Value>,
    entity: &Map<String, Value>,
    slot: &Slot,
) -> anyhow::Result<f64> {
    let building = string_at(entity, "buildingId")
        .and_then(|id| state.catalog.buildings.get(id))
        .ok_or_else(|| anyhow!("native quantum station building is missing"))?;
    let rated = stacked_capacity(
        building.output_capacity,
        finite_number(entity.get("machineCount")),
        normalized_buffer_limit(base),
    );
    Ok(if slot.max_stock > 0.0 {
        rated.min(slot.max_stock)
    } else {
        rated
    })
}

fn logistics_level(base: &Map<String, Value>) -> f64 {
    base.get("endgame")
        .and_then(Value::as_object)
        .and_then(|endgame| endgame.get("infiniteResearch"))
        .and_then(Value::as_object)
        .and_then(|research| research.get("galactic_logistics"))
        .and_then(Value::as_object)
        .and_then(|progress| progress.get("level"))
        .map(|value| finite_number(Some(value)).floor().max(0.0))
        .unwrap_or(0.0)
}

fn bandwidth_for_index(
    base: &Map<String, Value>,
    entities: &[Value],
    indexed_endpoint_indices: Option<&[usize]>,
) -> (f64, f64, f64) {
    let level = logistics_level(base);
    // Match JavaScript's explicit `base * base` operation. `powi(2)` may
    // differ by one ULP for very large research levels.
    let multiplier_base = 1.0 + 0.05 * level;
    let multiplier = multiplier_base * multiplier_base;
    let mut tower_stacks = 0.0;
    let mut collector_stacks = 0.0;
    let mut add_endpoint = |entity: &Map<String, Value>| {
        if is_quantum_station(entity) {
            tower_stacks += finite_number(entity.get("machineCount")).floor().max(0.0);
        } else if is_quantum_collector(entity) {
            collector_stacks += finite_number(entity.get("machineCount")).floor().max(0.0);
        }
    };
    if let Some(indices) = indexed_endpoint_indices {
        for &index in indices {
            if let Some(entity) = entities.get(index).and_then(Value::as_object) {
                add_endpoint(entity);
            }
        }
    } else {
        for entity in entities.iter().filter_map(Value::as_object) {
            add_endpoint(entity);
        }
    }
    (
        UNIT_CAP_PER_MINUTE * multiplier * tower_stacks,
        tower_stacks,
        collector_stacks,
    )
}

pub(crate) fn runtime_bandwidth(base: &Map<String, Value>, entities: &[Value]) -> RuntimeBandwidth {
    let level = logistics_level(base);
    let multiplier_base = 1.0 + 0.05 * level;
    let multiplier = multiplier_base * multiplier_base;
    let mut per_minute = 0.0;
    let mut tower_stacks = 0.0;
    let mut collector_stacks = 0.0;
    // Immediate uploads create their runtime-flow snapshot through the legacy
    // non-indexed JavaScript path. That path adds each tower's bandwidth in
    // persisted entity order instead of multiplying the aggregate stack count.
    // Preserve that operation order here because huge research levels can make
    // the two mathematically equivalent expressions differ by one ULP.
    for entity in entities.iter().filter_map(Value::as_object) {
        if is_quantum_station(entity) {
            let stacks = finite_number(entity.get("machineCount")).floor().max(0.0);
            tower_stacks += stacks;
            per_minute += UNIT_CAP_PER_MINUTE * multiplier * stacks;
        } else if is_quantum_collector(entity) {
            collector_stacks += finite_number(entity.get("machineCount")).floor().max(0.0);
        }
    }
    RuntimeBandwidth {
        per_minute,
        tower_stacks,
        collector_stacks,
    }
}

fn create_flow_with_bandwidth(
    network: &Network,
    boundary_second: f64,
    bandwidth: RuntimeBandwidth,
) -> BoundaryFlow {
    BoundaryFlow {
        boundary_second,
        uploaded: network
            .runtime_flow
            .as_ref()
            .filter(|flow| flow.boundary_second == boundary_second)
            .map(|flow| flow.uploaded.clone())
            .unwrap_or_default(),
        downloaded: BTreeMap::new(),
        global_upload_per_minute: bandwidth.per_minute,
        global_download_per_minute: bandwidth.per_minute,
        quantum_tower_stacks: bandwidth.tower_stacks,
        quantum_collector_stacks: bandwidth.collector_stacks,
    }
}

fn create_flow(
    base: &Map<String, Value>,
    entities: &[Value],
    network: &Network,
    boundary_second: f64,
) -> BoundaryFlow {
    create_flow_with_bandwidth(network, boundary_second, runtime_bandwidth(base, entities))
}

fn boundary_capacity(per_minute: f64, seconds: f64) -> BigUint {
    if !per_minute.is_finite() || per_minute <= 0.0 || !seconds.is_finite() || seconds <= 0.0 {
        BigUint::zero()
    } else {
        BigUint::from(floor_u64(per_minute * seconds / 60.0))
    }
}

fn add_flow(record: &mut BTreeMap<String, BigUint>, item_id: &str, amount: &BigUint) {
    if amount.is_zero() {
        return;
    }
    let next = record.get(item_id).cloned().unwrap_or_default() + amount;
    record.insert(item_id.to_owned(), saturated(next));
}

fn allocate_proportionally(budget: &BigUint, requests: &[Request], cursor: u64) -> Allocation {
    let ordered = requests
        .iter()
        .filter(|request| !request.amount.is_zero())
        .collect::<Vec<_>>();
    if ordered.is_empty() || budget.is_zero() {
        return Allocation::default();
    }
    let total_requested = ordered
        .iter()
        .fold(BigUint::zero(), |sum, request| sum + &request.amount);
    let available = budget.min(&total_requested).clone();
    let mut result = Allocation::default();
    for request in &ordered {
        let amount = &available * &request.amount / &total_requested;
        result.values.insert(request.key.clone(), amount.clone());
        result.total += amount;
    }
    let mut remainder = &available - &result.total;
    let normalized_cursor = cursor as usize % ordered.len();
    let mut offset = 0_usize;
    while !remainder.is_zero() && offset < ordered.len() * 2 {
        let request = ordered[(normalized_cursor + offset) % ordered.len()];
        let current = result.values.get(&request.key).cloned().unwrap_or_default();
        if current < request.amount {
            result.values.insert(request.key.clone(), current + 1_u8);
            remainder -= 1_u8;
        }
        offset += 1;
    }
    result.total = &available - &remainder;
    let advance = (&result.total % BigUint::from(ordered.len()))
        .to_usize()
        .unwrap_or(0);
    result.next_cursor = ((normalized_cursor + advance) % ordered.len()) as u64;
    result
}

fn allocate_with_priority(budget: &BigUint, requests: &[Request], cursor: u64) -> Allocation {
    let mut groups = BTreeMap::<i64, Vec<Request>>::new();
    for request in requests {
        groups
            .entry(request.priority)
            .or_default()
            .push(request.clone());
    }
    let mut remaining = budget.clone();
    let mut result = Allocation {
        next_cursor: cursor,
        ..Allocation::default()
    };
    for requests in groups.values().rev() {
        if remaining.is_zero() {
            break;
        }
        let allocation = allocate_proportionally(&remaining, requests, result.next_cursor);
        result.values.extend(allocation.values);
        result.total += &allocation.total;
        remaining -= allocation.total;
        result.next_cursor = allocation.next_cursor;
    }
    result
}

fn sorted_requests(requests: &mut [Request]) {
    requests.sort_by(|left, right| {
        right
            .priority
            .cmp(&left.priority)
            .then_with(|| left.key.cmp(&right.key))
    });
}

fn settle_outputs(
    network: &mut Network,
    requests: &[Request],
    cap: &BigUint,
) -> HashMap<String, BigUint> {
    let global = allocate_with_priority(cap, requests, 0);
    let mut by_item = BTreeMap::<String, Vec<Request>>::new();
    for request in requests {
        let mut request = request.clone();
        request.amount = global.values.get(&request.key).cloned().unwrap_or_default();
        by_item
            .entry(request.item_id.clone())
            .or_default()
            .push(request);
    }
    let mut values = HashMap::new();
    for (item_id, item_requests) in &mut by_item {
        item_requests.sort_by(|left, right| left.key.cmp(&right.key));
        let available = network.inventory.get(item_id).cloned().unwrap_or_default();
        let planned = item_requests
            .iter()
            .fold(BigUint::zero(), |sum, request| sum + &request.amount);
        let item_budget = available.clone().min(planned.clone());
        let allocation = allocate_proportionally(
            &item_budget,
            item_requests,
            network.routing_cursors.get(item_id).copied().unwrap_or(0),
        );
        for request in item_requests.iter() {
            values.insert(
                request.key.clone(),
                allocation
                    .values
                    .get(&request.key)
                    .cloned()
                    .unwrap_or_default(),
            );
        }
        network
            .inventory
            .insert(item_id.clone(), saturated(available - &allocation.total));
        if allocation.total < planned && !item_requests.is_empty() {
            *network.routing_cursors.entry(item_id.clone()).or_default() += 1;
        }
    }
    values
}

fn settle_inputs(
    network: &mut Network,
    requests: &[Request],
    cap: &BigUint,
) -> HashMap<String, BigUint> {
    let mut by_item = BTreeMap::<String, Vec<Request>>::new();
    for request in requests {
        by_item
            .entry(request.item_id.clone())
            .or_default()
            .push(request.clone());
    }
    let mut feasible = HashMap::<String, BigUint>::new();
    for (item_id, item_requests) in &by_item {
        let current = network.inventory.get(item_id).cloned().unwrap_or_default();
        let capacity = item_capacity(network, item_id);
        let free = if capacity > current {
            capacity - current
        } else {
            BigUint::zero()
        };
        let allocation = allocate_with_priority(
            &free,
            item_requests,
            network
                .upload_routing_cursors
                .get(item_id)
                .copied()
                .unwrap_or(0),
        );
        feasible.extend(allocation.values);
    }
    let global_requests = requests
        .iter()
        .cloned()
        .map(|mut request| {
            request.amount = feasible.get(&request.key).cloned().unwrap_or_default();
            request
        })
        .collect::<Vec<_>>();
    let global = allocate_with_priority(cap, &global_requests, 0);
    for (item_id, item_requests) in by_item {
        let accepted = item_requests.iter().fold(BigUint::zero(), |sum, request| {
            sum + global.values.get(&request.key).cloned().unwrap_or_default()
        });
        let requested = item_requests
            .iter()
            .fold(BigUint::zero(), |sum, request| sum + &request.amount);
        if accepted < requested && item_requests.len() > 1 {
            *network
                .upload_routing_cursors
                .entry(item_id.clone())
                .or_default() += 1;
        }
        if !accepted.is_zero() {
            let next = network.inventory.get(&item_id).cloned().unwrap_or_default() + accepted;
            network.inventory.insert(item_id, saturated(next));
        }
    }
    global.values
}

fn reserved_outgoing(entities: &[Value]) -> HashMap<(String, String), f64> {
    let mut reserved = HashMap::new();
    for station in entities.iter().filter_map(Value::as_object) {
        for route in station
            .get("stationRoutes")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_object)
        {
            let (Some(source_id), Some(item_id)) =
                (string_at(route, "peerId"), string_at(route, "itemId"))
            else {
                continue;
            };
            *reserved
                .entry((source_id.to_owned(), item_id.to_owned()))
                .or_default() += finite_number(route.get("cargo"));
        }
    }
    reserved
}

fn in_flight(entities: &[Value]) -> HashMap<(String, String), f64> {
    let mut result = HashMap::new();
    for station in entities.iter().filter_map(Value::as_object) {
        let Some(station_id) = string_at(station, "id") else {
            continue;
        };
        for route in station
            .get("stationRoutes")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_object)
        {
            let Some(item_id) = string_at(route, "itemId") else {
                continue;
            };
            *result
                .entry((station_id.to_owned(), item_id.to_owned()))
                .or_default() += finite_number(route.get("cargo"));
        }
    }
    result
}

fn deposit(network: &mut Network, item_id: &str, requested: &BigUint) -> BigUint {
    if !network.enabled || requested.is_zero() {
        return BigUint::zero();
    }
    let current = network.inventory.get(item_id).cloned().unwrap_or_default();
    let capacity = item_capacity(network, item_id);
    let free = if capacity > current {
        capacity - &current
    } else {
        BigUint::zero()
    };
    let accepted = requested.min(&free).clone();
    if !accepted.is_zero() {
        network
            .inventory
            .insert(item_id.to_owned(), saturated(current + &accepted));
    }
    accepted
}

pub(crate) fn deposit_construction_refund(
    base: &mut Map<String, Value>,
    item_id: &str,
    requested: u64,
) -> anyhow::Result<u64> {
    if requested == 0 {
        return Ok(0);
    }
    let mut network = parse_network(base)?;
    let accepted = deposit(&mut network, item_id, &BigUint::from(requested));
    let accepted = accepted.to_u64().unwrap_or(requested);
    if accepted > 0 {
        write_network(base, &network)?;
    }
    Ok(accepted)
}

fn record_immediate_upload(
    base: &Map<String, Value>,
    bandwidth: RuntimeBandwidth,
    network: &mut Network,
    item_id: &str,
    amount: &BigUint,
) {
    if amount.is_zero() || !network.enabled {
        return;
    }
    let elapsed = finite_number(base.get("elapsedSeconds"));
    let boundary = (elapsed / SETTLEMENT_SECONDS).floor() * SETTLEMENT_SECONDS + SETTLEMENT_SECONDS;
    if network
        .runtime_flow
        .as_ref()
        .is_none_or(|flow| flow.boundary_second != boundary)
    {
        network.runtime_flow = Some(create_flow_with_bandwidth(network, boundary, bandwidth));
    }
    if let Some(flow) = &mut network.runtime_flow {
        add_flow(&mut flow.uploaded, item_id, amount);
    }
}

pub(crate) fn flush_supply_buffers(
    base: &mut Map<String, Value>,
    entities: &mut [Value],
) -> anyhow::Result<()> {
    flush_supply_buffers_for_index(base, entities, None)
}

fn flush_supply_buffers_for_index(
    base: &mut Map<String, Value>,
    entities: &mut [Value],
    indexed_endpoint_indices: Option<&[usize]>,
) -> anyhow::Result<()> {
    let mut network = parse_network(base)?;
    if !network.enabled {
        return Ok(());
    }
    let reserved = reserved_outgoing(entities);
    let (per_minute, tower_stacks, collector_stacks) =
        bandwidth_for_index(base, entities, indexed_endpoint_indices);
    let runtime_bandwidth = RuntimeBandwidth {
        per_minute,
        tower_stacks,
        collector_stacks,
    };
    let mut normalized_for_deposit = false;
    let endpoint_indices = indexed_endpoint_indices
        .map(|indices| indices.to_vec())
        .unwrap_or_else(|| (0..entities.len()).collect());
    for entity_index in endpoint_indices {
        let Some((station_id, station_slots)) = (|| -> anyhow::Result<Option<_>> {
            let snapshot = entities[entity_index]
                .as_object()
                .ok_or_else(|| anyhow!("native quantum endpoint is invalid"))?;
            if !is_quantum_station(snapshot) {
                return Ok(None);
            }
            Ok(Some((
                string_at(snapshot, "id").unwrap_or_default().to_owned(),
                slots(snapshot)?,
            )))
        })()?
        else {
            continue;
        };
        for slot in station_slots {
            let Some(item_id) = slot.item_id.as_deref() else {
                continue;
            };
            if slot.remote_mode != "supply" {
                continue;
            }
            let station = entities[entity_index]
                .as_object_mut()
                .ok_or_else(|| anyhow!("native quantum station is invalid"))?;
            let input = item_amount(station, "inputs", item_id).floor().max(0.0);
            let output = item_amount(station, "outputs", item_id).floor().max(0.0);
            let outgoing = reserved
                .get(&(station_id.clone(), item_id.to_owned()))
                .copied()
                .unwrap_or(0.0)
                .floor()
                .max(0.0);
            let from_output_available = (output - slot.min_stock - outgoing).max(0.0);
            let from_input_available = (input - (slot.min_stock - output).max(0.0)).max(0.0);
            let requested = floor_u64(from_output_available + from_input_available);
            if requested < 1 {
                continue;
            }
            if !normalized_for_deposit {
                network.inventory.retain(|_, amount| !amount.is_zero());
                normalized_for_deposit = true;
            }
            let accepted = deposit(&mut network, item_id, &BigUint::from(requested));
            let accepted_number = accepted.to_u64().unwrap_or(MAX_SAFE_INTEGER) as f64;
            if accepted_number < 1.0 {
                continue;
            }
            let from_output = from_output_available.min(accepted_number);
            if from_output > 0.0 {
                set_item_amount(station, "outputs", item_id, output - from_output)?;
            }
            let remaining = accepted_number - from_output;
            if remaining > 0.0 {
                set_item_amount(station, "inputs", item_id, (input - remaining).max(0.0))?;
            }
            record_immediate_upload(base, runtime_bandwidth, &mut network, item_id, &accepted);
        }
    }
    write_network(base, &network)
}

pub(crate) fn receive_supply_material(
    state: &CoreState,
    base: &mut Map<String, Value>,
    bandwidth: RuntimeBandwidth,
    station: &mut Map<String, Value>,
    item_id: &str,
    amount: f64,
) -> anyhow::Result<f64> {
    let mut session = None;
    let accepted = receive_supply_material_in_session(
        state,
        base,
        bandwidth,
        &mut session,
        station,
        item_id,
        amount,
    )?;
    finish_supply_deposit_session(base, session)?;
    Ok(accepted)
}

pub(crate) fn receive_supply_material_in_session(
    state: &CoreState,
    base: &Map<String, Value>,
    bandwidth: RuntimeBandwidth,
    session: &mut Option<SupplyDepositSession>,
    station: &mut Map<String, Value>,
    item_id: &str,
    amount: f64,
) -> anyhow::Result<f64> {
    if amount < 1.0 || !is_quantum_station(station) {
        return Ok(0.0);
    }
    let Some(slot) = slots(station)?
        .into_iter()
        .find(|slot| slot.item_id.as_deref() == Some(item_id) && slot.remote_mode == "supply")
    else {
        return Ok(0.0);
    };
    let session = supply_deposit_session(base, session)?;
    if !session.network.enabled {
        return Ok(0.0);
    }
    // JavaScript normalizes the network for every accepted supply call, even
    // when all cargo stays in the station reserve. The shared session preserves
    // that final shape while paying the parse/write cost only once per batch.
    session.write_required = true;
    let requested = floor_u64(amount) as f64;
    let current_input = item_amount(station, "inputs", item_id).floor().max(0.0);
    let current_output = item_amount(station, "outputs", item_id).floor().max(0.0);
    let input_capacity = station_capacity(state, base, station, &slot)?
        .floor()
        .max(0.0);
    let input_free = (input_capacity - current_input).max(0.0);
    let local_reserve = (slot.min_stock - current_input - current_output).max(0.0);
    let kept = requested.min(input_free).min(local_reserve);
    if kept > 0.0 {
        set_item_amount(station, "inputs", item_id, current_input + kept)?;
    }
    let mut remaining = requested - kept;
    if remaining > 0.0 {
        session
            .network
            .inventory
            .retain(|_, amount| !amount.is_zero());
        let accepted = deposit(
            &mut session.network,
            item_id,
            &BigUint::from(floor_u64(remaining)),
        );
        let accepted_number = accepted.to_u64().unwrap_or(MAX_SAFE_INTEGER) as f64;
        if accepted_number > 0.0 {
            record_immediate_upload(base, bandwidth, &mut session.network, item_id, &accepted);
        }
        remaining -= accepted_number;
    }
    let local_remainder = remaining.min((input_free - kept).max(0.0));
    if local_remainder > 0.0 {
        let current = item_amount(station, "inputs", item_id).floor().max(0.0);
        set_item_amount(station, "inputs", item_id, current + local_remainder)?;
    }
    let accepted_total = requested - remaining + local_remainder;
    Ok(accepted_total)
}

pub(crate) fn settle_downloads(
    state: &CoreState,
    base: &mut Map<String, Value>,
    entities: &mut [Value],
    credits: &crate::belts::OutputCredits,
    boundary_second: f64,
    seconds: f64,
) -> anyhow::Result<Option<BoundaryFlow>> {
    let mut network = parse_network(base)?;
    if !network.enabled {
        return Ok(None);
    }
    let mut flow = create_flow(base, entities, &network, boundary_second);
    let cargo = in_flight(entities);
    let mut by_key = BTreeMap::<String, (usize, Slot)>::new();
    for (entity_index, entity) in entities.iter().enumerate() {
        let station = entity
            .as_object()
            .ok_or_else(|| anyhow!("native quantum endpoint is invalid"))?;
        if !is_quantum_station(station) {
            continue;
        }
        let station_id = string_at(station, "id").unwrap_or_default();
        for slot in slots(station)? {
            let Some(item_id) = slot.item_id.as_deref() else {
                continue;
            };
            if slot.remote_mode != "demand" {
                continue;
            }
            let key = format!("{station_id}:{item_id}");
            if by_key
                .get(&key)
                .is_none_or(|(_, existing)| slot.priority > existing.priority)
            {
                by_key.insert(key, (entity_index, slot));
            }
        }
    }
    let mut requests = Vec::new();
    for (key, (entity_index, slot)) in by_key {
        let station = entities[entity_index]
            .as_object()
            .ok_or_else(|| anyhow!("native quantum demand is invalid"))?;
        let station_id = string_at(station, "id").unwrap_or_default();
        let item_id = slot.item_id.as_deref().expect("quantum demand item");
        let current = item_amount(station, "outputs", item_id).floor().max(0.0);
        let local_capacity = station_capacity(state, base, station, &slot)?
            .floor()
            .max(0.0);
        let incoming = cargo
            .get(&(station_id.to_owned(), item_id.to_owned()))
            .copied()
            .unwrap_or(0.0);
        let local_free = (local_capacity - current - incoming).max(0.0);
        let direct_through = if current <= local_capacity {
            crate::belts::output_credit(state, credits, station_id, item_id)
        } else {
            0.0
        };
        let capacity = floor_u64((local_free + direct_through).min(MAX_SAFE_INTEGER as f64));
        if capacity < 1 {
            continue;
        }
        requests.push(Request {
            key,
            entity_index,
            item_id: item_id.to_owned(),
            amount: BigUint::from(capacity),
            priority: slot.priority,
        });
    }
    let construction_demands = crate::construction::quantum_demands(state, base, entities)?
        .into_iter()
        .map(|demand| (demand.key.clone(), demand))
        .collect::<BTreeMap<_, _>>();
    for demand in construction_demands.values() {
        requests.push(Request {
            key: demand.key.clone(),
            entity_index: usize::MAX,
            item_id: demand.item_id.clone(),
            amount: BigUint::from(demand.amount),
            priority: 1,
        });
    }
    sorted_requests(&mut requests);
    let delivered = settle_outputs(
        &mut network,
        &requests,
        &boundary_capacity(flow.global_download_per_minute, seconds),
    );
    for request in &requests {
        let amount = delivered.get(&request.key).cloned().unwrap_or_default();
        let amount_number = amount.to_u64().unwrap_or(MAX_SAFE_INTEGER) as f64;
        if amount_number < 1.0 {
            continue;
        }
        if let Some(demand) = construction_demands.get(&request.key) {
            let applied = crate::construction::apply_quantum_delivery(
                base,
                demand,
                amount.to_u64().unwrap_or(MAX_SAFE_INTEGER),
            )?;
            if applied > 0 {
                add_flow(
                    &mut flow.downloaded,
                    &request.item_id,
                    &BigUint::from(applied),
                );
            }
            continue;
        }
        let station = entities[request.entity_index]
            .as_object_mut()
            .ok_or_else(|| anyhow!("native quantum demand is invalid"))?;
        let current = item_amount(station, "outputs", &request.item_id)
            .floor()
            .max(0.0);
        set_item_amount(
            station,
            "outputs",
            &request.item_id,
            current + amount_number,
        )?;
        set_number(station, "stationLastTransfer", amount_number)?;
        let production_rate = finite_number(station.get("productionRate"))
            + if seconds > 0.0001 {
                amount_number * 60.0 / seconds
            } else {
                0.0
            };
        set_number(station, "productionRate", production_rate)?;
        add_flow(&mut flow.downloaded, &request.item_id, &amount);
    }
    network.runtime_flow = Some(flow.clone());
    write_network(base, &network)?;
    Ok(Some(flow))
}

pub(crate) fn settle_uploads(
    base: &mut Map<String, Value>,
    entities: &mut [Value],
    boundary_second: f64,
    previous_flow: Option<BoundaryFlow>,
    seconds: f64,
    indexed_endpoint_indices: &[usize],
) -> anyhow::Result<()> {
    let mut network = parse_network(base)?;
    if !network.enabled {
        return Ok(());
    }
    let existing_flow = network.runtime_flow.clone();
    let mut flow = previous_flow
        .clone()
        .unwrap_or_else(|| create_flow(base, entities, &network, boundary_second));
    if previous_flow.is_none() {
        if let Some(existing) = &existing_flow {
            for (item_id, amount) in &existing.uploaded {
                add_flow(&mut flow.uploaded, item_id, amount);
            }
        }
    }
    let (per_minute, tower_stacks, collector_stacks) =
        bandwidth_for_index(base, entities, Some(indexed_endpoint_indices));
    flow.global_upload_per_minute = per_minute;
    flow.global_download_per_minute = per_minute;
    flow.quantum_tower_stacks = tower_stacks;
    flow.quantum_collector_stacks = collector_stacks;
    network.runtime_flow = Some(flow.clone());
    write_network(base, &network)?;

    flush_supply_buffers_for_index(base, entities, Some(indexed_endpoint_indices))?;
    network = parse_network(base)?;

    let reserved = reserved_outgoing(entities);
    let mut by_key = BTreeMap::<String, Request>::new();
    for &entity_index in indexed_endpoint_indices {
        let endpoint = entities[entity_index]
            .as_object()
            .ok_or_else(|| anyhow!("native quantum endpoint is invalid"))?;
        if is_quantum_collector(endpoint) {
            let Some(item_id) = string_at(endpoint, "storedItemId") else {
                continue;
            };
            let available = floor_u64(item_amount(endpoint, "outputs", item_id));
            if available > 0 {
                let key = format!(
                    "{}:{item_id}",
                    string_at(endpoint, "id").unwrap_or_default()
                );
                by_key.insert(
                    key.clone(),
                    Request {
                        key,
                        entity_index,
                        item_id: item_id.to_owned(),
                        amount: BigUint::from(available),
                        priority: 1,
                    },
                );
            }
            continue;
        }
        if !is_quantum_station(endpoint) {
            continue;
        }
        let station_id = string_at(endpoint, "id").unwrap_or_default();
        for slot in slots(endpoint)? {
            let Some(item_id) = slot.item_id.as_deref() else {
                continue;
            };
            if slot.remote_mode != "supply" {
                continue;
            }
            let outgoing = reserved
                .get(&(station_id.to_owned(), item_id.to_owned()))
                .copied()
                .unwrap_or(0.0);
            let available = floor_u64(
                (item_amount(endpoint, "outputs", item_id) - slot.min_stock - outgoing).max(0.0),
            );
            if available < 1 {
                continue;
            }
            let key = format!("{station_id}:{item_id}");
            if by_key
                .get(&key)
                .is_none_or(|existing| slot.priority > existing.priority)
            {
                by_key.insert(
                    key.clone(),
                    Request {
                        key,
                        entity_index,
                        item_id: item_id.to_owned(),
                        amount: BigUint::from(available),
                        priority: slot.priority,
                    },
                );
            }
        }
    }
    let mut requests = by_key.into_values().collect::<Vec<_>>();
    sorted_requests(&mut requests);
    let accepted = settle_inputs(
        &mut network,
        &requests,
        &boundary_capacity(flow.global_upload_per_minute, seconds),
    );
    for request in &requests {
        let amount = accepted.get(&request.key).cloned().unwrap_or_default();
        let amount_number = amount.to_u64().unwrap_or(MAX_SAFE_INTEGER) as f64;
        if amount_number < 1.0 {
            continue;
        }
        let endpoint = entities[request.entity_index]
            .as_object_mut()
            .ok_or_else(|| anyhow!("native quantum endpoint is invalid"))?;
        let current = item_amount(endpoint, "outputs", &request.item_id)
            .floor()
            .max(0.0);
        set_item_amount(
            endpoint,
            "outputs",
            &request.item_id,
            (current - amount_number).max(0.0),
        )?;
        set_number(endpoint, "stationLastTransfer", amount_number)?;
        add_flow(&mut flow.uploaded, &request.item_id, &amount);
    }
    network.runtime_flow = Some(flow);
    write_network(base, &network)
}

fn completed_tech(base: &Map<String, Value>, id: &str) -> bool {
    base.get("research")
        .and_then(Value::as_object)
        .and_then(|research| research.get("completedTechIds"))
        .and_then(Value::as_array)
        .is_some_and(|ids| ids.iter().any(|value| value.as_str() == Some(id)))
}

fn transition_routes(entities: &[Value], station_id: &str) -> Vec<TransitionRoute> {
    let mut result = Vec::new();
    for demand in entities.iter().filter_map(Value::as_object) {
        let demand_id = string_at(demand, "id").unwrap_or_default();
        let Some(routes) = demand.get("stationRoutes").and_then(Value::as_array) else {
            continue;
        };
        for route in routes.iter().filter_map(Value::as_object) {
            if string_at(route, "scope") != Some("remote") {
                continue;
            }
            let peer_id = string_at(route, "peerId").unwrap_or_default();
            let vehicle_station_id = string_at(route, "vehicleStationId").unwrap_or(demand_id);
            let waypoint = route
                .get("waypointStationIds")
                .and_then(Value::as_array)
                .is_some_and(|ids| ids.iter().any(|id| id.as_str() == Some(station_id)));
            if demand_id != station_id
                && peer_id != station_id
                && vehicle_station_id != station_id
                && !waypoint
            {
                continue;
            }
            result.push(TransitionRoute {
                demand_id: demand_id.to_owned(),
                route_id: string_at(route, "id").unwrap_or_default().to_owned(),
                item_id: string_at(route, "itemId").unwrap_or_default().to_owned(),
                peer_id: peer_id.to_owned(),
                cargo: decimal(&BigUint::from(floor_u64(finite_number(route.get("cargo"))))),
                duration: finite_number(route.get("duration")),
                progress: finite_number(route.get("progress")).clamp(0.0, 1.0),
            });
        }
    }
    result
}

fn transition_bridge(station_id: &str, route: &TransitionRoute, elapsed: f64) -> Value {
    serde_json::json!({
        "id": format!("quantum_bridge_{station_id}_{}", route.route_id),
        "itemId": route.item_id,
        "sourceStationId": route.peer_id,
        "targetStationId": route.demand_id,
        "cargo": route.cargo,
        "remainingCargo": route.cargo,
        "arriveAtSecond": elapsed + (route.duration * (1.0 - route.progress)).max(1.0),
    })
}

fn bridge_matches(station_id: &str, bridge_id: &str, route_id: &str) -> bool {
    bridge_id == format!("quantum_bridge_{route_id}")
        || bridge_id == format!("quantum_bridge_{station_id}_{route_id}")
}

fn synchronized_bridges(
    station_id: &str,
    transition: &Map<String, Value>,
    routes: &[TransitionRoute],
    elapsed: f64,
) -> anyhow::Result<Vec<Value>> {
    let persisted = transition
        .get("bridges")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("native quantum transition bridges are missing"))?;
    let mut used = HashSet::new();
    let mut bridges = Vec::new();
    for bridge in persisted {
        let bridge_object = bridge
            .as_object()
            .ok_or_else(|| anyhow!("native quantum transition bridge is invalid"))?;
        let bridge_id = string_at(bridge_object, "id").unwrap_or_default();
        let matched = routes.iter().find(|route| {
            !used.contains(&route.route_id)
                && bridge_matches(station_id, bridge_id, &route.route_id)
        });
        if let Some(route) = matched {
            used.insert(route.route_id.clone());
            bridges.push(transition_bridge(station_id, route, elapsed));
        } else {
            let mut settled = bridge_object.clone();
            settled.insert("remainingCargo".to_owned(), Value::from("0"));
            bridges.push(Value::Object(settled));
        }
    }
    for route in routes {
        if used.insert(route.route_id.clone()) {
            bridges.push(transition_bridge(station_id, route, elapsed));
        }
    }
    Ok(bridges)
}

pub(crate) fn settle_transitions(
    base: &mut Map<String, Value>,
    entities: &mut [Value],
) -> anyhow::Result<()> {
    let elapsed = finite_number(base.get("elapsedSeconds"));
    if completed_tech(base, "quantum_logistics_network") {
        let mut planned = entities
            .iter()
            .enumerate()
            .filter_map(|(index, entity)| {
                let entity = entity.as_object()?;
                (string_at(entity, "buildingId") == Some("interstellar_logistics_station")
                    && entity.get("quantumTarget").and_then(Value::as_bool) == Some(true)
                    && finite_number(entity.get("stationTier")).floor() >= 2.0
                    && string_at(entity, "quantumMode") != Some("quantum")
                    && entity.get("quantumTransition").is_none_or(Value::is_null))
                .then(|| {
                    (
                        string_at(entity, "id").unwrap_or_default().to_owned(),
                        index,
                    )
                })
            })
            .collect::<Vec<_>>();
        planned.sort_by(|left, right| left.0.cmp(&right.0));
        for (station_id, index) in planned {
            let bridges = transition_routes(entities, &station_id)
                .iter()
                .map(|route| transition_bridge(&station_id, route, elapsed))
                .collect::<Vec<_>>();
            let station = entities[index]
                .as_object_mut()
                .ok_or_else(|| anyhow!("native quantum target station is invalid"))?;
            station.insert("quantumMode".to_owned(), Value::from("transitioning"));
            station.insert(
                "quantumTransition".to_owned(),
                serde_json::json!({
                    "targetMode": "quantum",
                    "startedAtSecond": elapsed,
                    "boundarySecond": ((elapsed / SETTLEMENT_SECONDS).floor() + 1.0) * SETTLEMENT_SECONDS,
                    "bridges": bridges,
                }),
            );
            station.remove("quantumTarget");
        }
    }

    let snapshots = entities.to_vec();
    let mut enable_network = false;
    for index in 0..snapshots.len() {
        let Some(station) = snapshots[index].as_object() else {
            continue;
        };
        let Some(transition) = station.get("quantumTransition").and_then(Value::as_object) else {
            continue;
        };
        let station_id = string_at(station, "id").unwrap_or_default();
        let routes = transition_routes(&snapshots, station_id);
        let bridges = synchronized_bridges(station_id, transition, &routes, elapsed)?;
        let boundary = finite_number(transition.get("boundarySecond"));
        let bridge_cargo_pending = bridges.iter().filter_map(Value::as_object).any(|bridge| {
            !normalized_decimal(bridge.get("remainingCargo"), &BigUint::zero()).is_zero()
        });
        let target_mode = string_at(transition, "targetMode").unwrap_or("legacy");
        let entity = entities[index]
            .as_object_mut()
            .ok_or_else(|| anyhow!("native quantum transition station is invalid"))?;
        if elapsed < boundary || !routes.is_empty() || bridge_cargo_pending {
            let mut next = transition.clone();
            next.insert("bridges".to_owned(), Value::Array(bridges));
            entity.insert("quantumTransition".to_owned(), Value::Object(next));
        } else {
            entity.insert("quantumMode".to_owned(), Value::from(target_mode));
            entity.insert("quantumTransition".to_owned(), Value::Null);
            enable_network |= target_mode == "quantum";
        }
    }
    if enable_network {
        base.get_mut("quantumLogisticsNetwork")
            .and_then(Value::as_object_mut)
            .ok_or_else(|| anyhow!("native quantum network is missing"))?
            .insert("enabled".to_owned(), Value::Bool(true));
    }
    Ok(())
}

pub(crate) fn admission_reason(state: &CoreState) -> anyhow::Result<Option<&'static str>> {
    let base = state.base_value();
    let network = parse_network(base)?;
    for index in 0..state.entity_index.len() {
        let entity = state.parse_entity(index)?;
        let entity = entity
            .as_object()
            .ok_or_else(|| anyhow!("native quantum admission entity is invalid"))?;
        if entity.get("quantumTarget").is_some_and(|value| {
            !value.is_boolean()
                || string_at(entity, "buildingId") != Some("interstellar_logistics_station")
        }) {
            return Ok(Some("quantum-target-invalid"));
        }
        let transition = entity
            .get("quantumTransition")
            .filter(|value| !value.is_null());
        if let Some(transition) = transition {
            let Some(transition) = transition.as_object() else {
                return Ok(Some("quantum-transition-invalid"));
            };
            let target = string_at(transition, "targetMode");
            let building = string_at(entity, "buildingId");
            let transition_building_valid = match building {
                Some("interstellar_logistics_station") => {
                    target == Some("quantum")
                        && finite_number(entity.get("stationTier")).floor() >= 2.0
                }
                Some("orbital_collector") => matches!(target, Some("quantum" | "legacy")),
                _ => false,
            };
            let bridges_valid = transition
                .get("bridges")
                .and_then(Value::as_array)
                .is_some_and(|bridges| {
                    bridges.iter().all(|bridge| {
                        bridge.as_object().is_some_and(|bridge| {
                            string_at(bridge, "id").is_some_and(|id| !id.is_empty())
                                && string_at(bridge, "itemId")
                                    .is_some_and(|id| state.catalog.items.contains_key(id))
                                && string_at(bridge, "sourceStationId")
                                    .is_some_and(|id| !id.is_empty())
                                && string_at(bridge, "targetStationId")
                                    .is_some_and(|id| !id.is_empty())
                                && matches!(bridge.get("cargo"), Some(Value::String(_)))
                                && matches!(bridge.get("remainingCargo"), Some(Value::String(_)))
                                && finite_number(bridge.get("arriveAtSecond")) >= 0.0
                        })
                    })
                });
            if string_at(entity, "quantumMode") != Some("transitioning")
                || !transition_building_valid
                || finite_number(transition.get("startedAtSecond")) < 0.0
                || finite_number(transition.get("boundarySecond")) < 0.0
                || !bridges_valid
            {
                return Ok(Some("quantum-transition-invalid"));
            }
        } else if string_at(entity, "quantumMode") == Some("transitioning") {
            return Ok(Some("quantum-transition-invalid"));
        }
        if is_quantum_station(entity) {
            if !network.enabled
                || finite_number(entity.get("stationTier")).floor() < 2.0
                || entity
                    .get("stationRoutes")
                    .and_then(Value::as_array)
                    .is_some_and(|routes| {
                        routes
                            .iter()
                            .filter_map(Value::as_object)
                            .any(|route| string_at(route, "scope") == Some("remote"))
                    })
            {
                return Ok(Some("quantum-station-invalid"));
            }
        } else if is_quantum_collector(entity) && !network.enabled {
            return Ok(Some("quantum-collector-invalid"));
        } else if string_at(entity, "quantumMode")
            .is_some_and(|mode| !matches!(mode, "legacy" | "quantum" | "transitioning"))
        {
            return Ok(Some("quantum-mode-invalid"));
        }
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(key: &str, amount: u64) -> Request {
        Request {
            key: key.to_owned(),
            entity_index: 0,
            item_id: "iron_ore".to_owned(),
            amount: BigUint::from(amount),
            priority: 1,
        }
    }

    #[test]
    fn proportional_allocation_is_order_independent_and_rotates_remainders() {
        let mut requests = vec![request("station-b", 5), request("station-a", 5)];
        sorted_requests(&mut requests);
        let first = allocate_proportionally(&BigUint::from(5_u8), &requests, 0);
        assert_eq!(first.total, BigUint::from(5_u8));
        assert_eq!(first.values["station-a"], BigUint::from(3_u8));
        assert_eq!(first.values["station-b"], BigUint::from(2_u8));
        let second = allocate_proportionally(&BigUint::from(5_u8), &requests, 1);
        assert_eq!(second.values["station-a"], BigUint::from(2_u8));
        assert_eq!(second.values["station-b"], BigUint::from(3_u8));
    }

    #[test]
    fn downloads_release_capacity_before_uploads() {
        let mut network = Network {
            enabled: true,
            inventory: BTreeMap::from([("iron_ore".to_owned(), BigUint::from(15_000_u64))]),
            item_capacities: BTreeMap::from([("iron_ore".to_owned(), BigUint::from(10_000_u64))]),
            ..Network::default()
        };
        let outputs = vec![request("download", 7_000)];
        let delivered = settle_outputs(&mut network, &outputs, &BigUint::from(7_000_u64));
        assert_eq!(delivered["download"], BigUint::from(7_000_u64));
        let inputs = vec![request("upload", 5_000)];
        let accepted = settle_inputs(&mut network, &inputs, &BigUint::from(5_000_u64));
        assert_eq!(accepted["upload"], BigUint::from(2_000_u64));
        assert_eq!(network.inventory["iron_ore"], BigUint::from(10_000_u64));
    }
}
