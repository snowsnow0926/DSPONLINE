use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::mem::size_of;
use std::sync::Arc;

use anyhow::{anyhow, bail};
use num_bigint::BigUint;
use num_traits::{ToPrimitive, Zero};
use serde_json::{Map, Number, Value};

use crate::deterministic_runtime::DeterministicRuntime;
use crate::state::{CoreState, FactoryTopology};

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

impl BoundaryFlow {
    /// Whether this boundary actually credited any download sink. An enabled
    /// network still returns an empty flow because uploads later in the same
    /// boundary must retain its bandwidth/cursor context; callers must not
    /// interpret that empty flow as station inventory movement.
    pub(crate) fn has_downloads(&self) -> bool {
        self.downloaded.values().any(|amount| !amount.is_zero())
    }
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct RuntimeBandwidth {
    per_minute: f64,
    tower_stacks: f64,
    collector_stacks: f64,
}

const QUANTUM_ACTIVE_DENSE_NUMERATOR: usize = 3;
const QUANTUM_ACTIVE_DENSE_DENOMINATOR: usize = 4;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct QuantumActiveScan {
    pub selected_rows: usize,
    pub total_rows: usize,
    pub dense_fallback: bool,
    pub directory_fallback: bool,
}

#[derive(Debug, Clone)]
struct QuantumEndpointSignature {
    entity_index: usize,
    entity_id: String,
    collector: bool,
}

#[derive(Debug, Clone)]
struct QuantumSlotPlan {
    entity_index: usize,
    entity_id: String,
    item_id: String,
    key: String,
    /// JavaScript's direct flush helper resolves the first matching supply
    /// slot even though the boundary request keeps the highest-priority slot.
    /// Preserve both views when a MOD save contains duplicate item slots.
    flush_slot: Slot,
    slot: Slot,
}

/// Runtime-only counterpart of the JavaScript `SimulationLookupContext`
/// quantum columns. Static endpoint/slot membership is tied to one immutable
/// factory topology. Dynamic pending sets survive successful revisions and
/// are woken by exact station/item reverse dependencies.
///
/// The directory is never serialized and never participates in the public
/// save hash. A command or topology rebuild discards it; a failed candidate
/// mutates only an `Arc::make_mut` clone which is never installed.
#[derive(Debug, Clone)]
pub(crate) struct QuantumLogisticsDirectory {
    topology: Arc<FactoryTopology>,
    entity_count: usize,
    endpoints: Vec<QuantumEndpointSignature>,
    endpoint_indices: Vec<usize>,
    collector_indices: Vec<usize>,
    upload_plans: Vec<QuantumSlotPlan>,
    download_plans: Vec<QuantumSlotPlan>,
    upload_by_station: HashMap<usize, Vec<usize>>,
    upload_by_item: HashMap<String, Vec<usize>>,
    download_by_station: HashMap<usize, Vec<usize>>,
    download_by_station_item: HashMap<(usize, String), Vec<usize>>,
    pending_flush: BTreeSet<usize>,
    pending_download: BTreeSet<usize>,
    runtime_written_station_indices: BTreeSet<usize>,
    inventory_written_station_indices: BTreeSet<usize>,
    flush_all_pending: bool,
    download_all_pending: bool,
    tower_stack_terms: Vec<f64>,
    tower_stacks: f64,
    collector_stacks: f64,
    cached_legacy_level_bits: Option<u64>,
    cached_legacy_bandwidth: RuntimeBandwidth,
    fallback_full_scan: bool,
}

impl Default for QuantumLogisticsDirectory {
    fn default() -> Self {
        Self {
            topology: Arc::new(FactoryTopology::default()),
            entity_count: 0,
            endpoints: Vec::new(),
            endpoint_indices: Vec::new(),
            collector_indices: Vec::new(),
            upload_plans: Vec::new(),
            download_plans: Vec::new(),
            upload_by_station: HashMap::new(),
            upload_by_item: HashMap::new(),
            download_by_station: HashMap::new(),
            download_by_station_item: HashMap::new(),
            pending_flush: BTreeSet::new(),
            pending_download: BTreeSet::new(),
            runtime_written_station_indices: BTreeSet::new(),
            inventory_written_station_indices: BTreeSet::new(),
            flush_all_pending: true,
            download_all_pending: true,
            tower_stack_terms: Vec::new(),
            tower_stacks: 0.0,
            collector_stacks: 0.0,
            cached_legacy_level_bits: None,
            cached_legacy_bandwidth: RuntimeBandwidth {
                per_minute: 0.0,
                tower_stacks: 0.0,
                collector_stacks: 0.0,
            },
            fallback_full_scan: true,
        }
    }
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

#[derive(Debug, Clone, PartialEq)]
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

#[derive(Debug, Clone)]
enum TransitionCandidateSource {
    Existing(Map<String, Value>),
    Planned,
}

#[derive(Debug, Clone)]
struct TransitionCandidate {
    entity_index: usize,
    station_id: String,
    source: TransitionCandidateSource,
}

#[derive(Debug)]
struct TransitionEntityProbe {
    route_memberships: Vec<(String, TransitionRoute)>,
    candidate: Option<TransitionCandidate>,
    #[cfg(test)]
    worker_index: Option<usize>,
}

#[derive(Debug)]
enum TransitionPatchResult {
    Active(Map<String, Value>),
    Complete(String),
}

#[derive(Debug)]
struct TransitionPatch {
    entity_index: usize,
    planned: bool,
    result: TransitionPatchResult,
}

#[derive(Debug)]
struct TransitionPatchProbe {
    patch: TransitionPatch,
    #[cfg(test)]
    worker_index: Option<usize>,
}

#[derive(Debug, Default)]
struct TransitionParallelDiagnostics {
    topology_changed: bool,
    #[cfg(test)]
    entity_probe_workers: HashSet<usize>,
    #[cfg(test)]
    transition_probe_workers: HashSet<usize>,
    #[cfg(test)]
    entity_probe_count: usize,
    #[cfg(test)]
    transition_probe_count: usize,
    #[cfg(test)]
    route_membership_count: usize,
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
    let inventory = entity
        .get_mut(record)
        .and_then(Value::as_object_mut)
        .ok_or_else(|| anyhow!("native quantum logistics inventory is missing"))?;
    let amount = Number::from_f64(amount)
        .map(Value::Number)
        .ok_or_else(|| anyhow!("native quantum logistics inventory is non-finite"))?;
    if let Some(current) = inventory.get_mut(item_id) {
        *current = amount;
    } else {
        inventory.insert(item_id.to_owned(), amount);
    }
    Ok(())
}

fn set_biguint_amount(record: &mut BTreeMap<String, BigUint>, item_id: &str, amount: BigUint) {
    if let Some(current) = record.get_mut(item_id) {
        *current = amount;
    } else {
        record.insert(item_id.to_owned(), amount);
    }
}

fn advance_routing_cursor(record: &mut BTreeMap<String, u64>, item_id: &str) {
    if let Some(cursor) = record.get_mut(item_id) {
        *cursor += 1;
    } else {
        record.insert(item_id.to_owned(), 1);
    }
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
    let capacity = item_capacity(network, item_id);
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

fn upsert_slot_plan(
    plans: &mut Vec<QuantumSlotPlan>,
    positions: &mut HashMap<String, usize>,
    plan: QuantumSlotPlan,
) {
    if let Some(&position) = positions.get(&plan.key) {
        if plan.slot.priority > plans[position].slot.priority {
            plans[position].slot = plan.slot;
        }
    } else {
        positions.insert(plan.key.clone(), plans.len());
        plans.push(plan);
    }
}

impl QuantumLogisticsDirectory {
    pub(crate) fn build(state: &CoreState, entities: &[Value]) -> Self {
        let mut directory = Self {
            topology: Arc::clone(&state.factory_topology),
            entity_count: entities.len(),
            fallback_full_scan: state.factory_topology.quantum_endpoint_full_scan_required,
            ..Self::default()
        };
        let mut upload_positions = HashMap::new();
        let mut download_positions = HashMap::new();
        let mut previous_index = None;
        for &entity_index in &state.factory_topology.quantum_endpoint_indices {
            if previous_index.is_some_and(|previous| previous >= entity_index) {
                directory.fallback_full_scan = true;
                continue;
            }
            previous_index = Some(entity_index);
            let Some(endpoint) = entities.get(entity_index).and_then(Value::as_object) else {
                directory.fallback_full_scan = true;
                continue;
            };
            if string_at(endpoint, "kind") != Some("station")
                || !matches!(
                    string_at(endpoint, "buildingId"),
                    Some("interstellar_logistics_station" | "orbital_collector")
                )
            {
                directory.fallback_full_scan = true;
                continue;
            }
            if !is_quantum_station(endpoint) && !is_quantum_collector(endpoint) {
                continue;
            }
            let Some(entity_id) = string_at(endpoint, "id").filter(|id| !id.is_empty()) else {
                directory.fallback_full_scan = true;
                continue;
            };
            if !entity_id.is_ascii() {
                directory.fallback_full_scan = true;
            }
            let collector = is_quantum_collector(endpoint);
            directory.endpoints.push(QuantumEndpointSignature {
                entity_index,
                entity_id: entity_id.to_owned(),
                collector,
            });
            directory.endpoint_indices.push(entity_index);
            let stacks = finite_number(endpoint.get("machineCount")).floor().max(0.0);
            if collector {
                directory.collector_indices.push(entity_index);
                directory.collector_stacks += stacks;
                continue;
            }
            directory.tower_stack_terms.push(stacks);
            directory.tower_stacks += stacks;
            let Ok(endpoint_slots) = slots(endpoint) else {
                directory.fallback_full_scan = true;
                continue;
            };
            for slot in endpoint_slots {
                let Some(item_id) = slot.item_id.as_deref() else {
                    continue;
                };
                let positions = match slot.remote_mode.as_str() {
                    "supply" => &mut upload_positions,
                    "demand" => &mut download_positions,
                    _ => continue,
                };
                let key = format!("{entity_id}:{item_id}");
                if !item_id.is_ascii()
                    || item_id.contains(':')
                    || !state.catalog.items.contains_key(item_id)
                    || positions.contains_key(&key)
                {
                    directory.fallback_full_scan = true;
                }
                let plans = if slot.remote_mode == "supply" {
                    &mut directory.upload_plans
                } else {
                    &mut directory.download_plans
                };
                upsert_slot_plan(
                    plans,
                    positions,
                    QuantumSlotPlan {
                        entity_index,
                        entity_id: entity_id.to_owned(),
                        item_id: item_id.to_owned(),
                        key,
                        flush_slot: slot.clone(),
                        slot,
                    },
                );
            }
        }
        for (plan_index, plan) in directory.upload_plans.iter().enumerate() {
            directory
                .upload_by_station
                .entry(plan.entity_index)
                .or_default()
                .push(plan_index);
            directory
                .upload_by_item
                .entry(plan.item_id.clone())
                .or_default()
                .push(plan_index);
        }
        for (plan_index, plan) in directory.download_plans.iter().enumerate() {
            directory
                .download_by_station
                .entry(plan.entity_index)
                .or_default()
                .push(plan_index);
            directory
                .download_by_station_item
                .entry((plan.entity_index, plan.item_id.clone()))
                .or_default()
                .push(plan_index);
        }
        directory.cached_legacy_bandwidth = RuntimeBandwidth {
            per_minute: 0.0,
            tower_stacks: directory.tower_stacks,
            collector_stacks: directory.collector_stacks,
        };
        directory
    }

    fn topology_matches(&self, state: &CoreState, entities: &[Value]) -> bool {
        Arc::ptr_eq(&self.topology, &state.factory_topology) && self.entity_count == entities.len()
    }

    fn plan_matches(entities: &[Value], plan: &QuantumSlotPlan, frozen_mode: bool) -> bool {
        let Some(endpoint) = entities
            .get(plan.entity_index)
            .and_then(Value::as_object)
            .filter(|endpoint| {
                string_at(endpoint, "id") == Some(plan.entity_id.as_str())
                    && (is_quantum_station(endpoint)
                        || (frozen_mode
                            && string_at(endpoint, "kind") == Some("station")
                            && string_at(endpoint, "buildingId")
                                == Some("interstellar_logistics_station")))
            })
        else {
            return false;
        };
        let Ok(endpoint_slots) = slots(endpoint) else {
            return false;
        };
        let mut selected = None::<Slot>;
        for slot in endpoint_slots {
            if slot.item_id.as_deref() != Some(plan.item_id.as_str())
                || slot.remote_mode != plan.slot.remote_mode
            {
                continue;
            }
            if selected
                .as_ref()
                .is_none_or(|existing| slot.priority > existing.priority)
            {
                selected = Some(slot);
            }
        }
        let highest_matches = selected.as_ref() == Some(&plan.slot);
        if !highest_matches {
            return false;
        }
        if plan.slot.remote_mode != "supply" {
            return true;
        }
        slots(endpoint).is_ok_and(|slots| {
            slots
                .into_iter()
                .find(|slot| {
                    slot.item_id.as_deref() == Some(plan.item_id.as_str())
                        && slot.remote_mode == "supply"
                })
                .as_ref()
                == Some(&plan.flush_slot)
        })
    }

    fn selected_plan_indices(
        &self,
        total_rows: usize,
        all_pending: bool,
        pending: &BTreeSet<usize>,
        directory_compatible: bool,
    ) -> (Option<Vec<usize>>, QuantumActiveScan) {
        if self.fallback_full_scan || !directory_compatible {
            return (
                None,
                QuantumActiveScan {
                    selected_rows: self.entity_count,
                    total_rows: self.entity_count,
                    dense_fallback: true,
                    directory_fallback: true,
                },
            );
        }
        let pending_rows = if all_pending {
            total_rows
        } else {
            pending.len()
        };
        let dense_fallback = pending_rows > 0
            && pending_rows.saturating_mul(QUANTUM_ACTIVE_DENSE_DENOMINATOR)
                >= total_rows.saturating_mul(QUANTUM_ACTIVE_DENSE_NUMERATOR);
        let selected = if all_pending || dense_fallback {
            (0..total_rows).collect::<Vec<_>>()
        } else {
            pending.iter().copied().collect::<Vec<_>>()
        };
        let selected_rows = selected.len();
        (
            Some(selected),
            QuantumActiveScan {
                selected_rows,
                total_rows,
                dense_fallback,
                directory_fallback: false,
            },
        )
    }

    fn selected_flush_plans(
        &self,
        state: &CoreState,
        entities: &[Value],
        frozen_mode: bool,
    ) -> (Option<Vec<usize>>, QuantumActiveScan) {
        let (selected, mut scan) = self.selected_plan_indices(
            self.upload_plans.len(),
            self.flush_all_pending,
            &self.pending_flush,
            self.topology_matches(state, entities),
        );
        if selected.as_ref().is_some_and(|indices| {
            indices
                .iter()
                .any(|&index| !Self::plan_matches(entities, &self.upload_plans[index], frozen_mode))
        }) {
            scan.selected_rows = self.entity_count;
            scan.total_rows = self.entity_count;
            scan.dense_fallback = true;
            scan.directory_fallback = true;
            return (None, scan);
        }
        (selected, scan)
    }

    fn selected_download_plans(
        &self,
        state: &CoreState,
        entities: &[Value],
    ) -> (Option<Vec<usize>>, QuantumActiveScan) {
        let (selected, mut scan) = self.selected_plan_indices(
            self.download_plans.len(),
            self.download_all_pending,
            &self.pending_download,
            self.topology_matches(state, entities),
        );
        if selected.as_ref().is_some_and(|indices| {
            indices
                .iter()
                .any(|&index| !Self::plan_matches(entities, &self.download_plans[index], false))
        }) {
            scan.selected_rows = self.entity_count;
            scan.total_rows = self.entity_count;
            scan.dense_fallback = true;
            scan.directory_fallback = true;
            return (None, scan);
        }
        (selected, scan)
    }

    pub(crate) fn endpoint_indices<'a>(
        &'a self,
        state: &CoreState,
        entities: &[Value],
    ) -> Option<&'a [usize]> {
        (!self.fallback_full_scan && self.topology_matches(state, entities))
            .then_some(self.endpoint_indices.as_slice())
    }

    fn can_use_index(&self, state: &CoreState, entities: &[Value]) -> bool {
        !self.fallback_full_scan && self.topology_matches(state, entities)
    }

    fn upload_index_matches(&self, entities: &[Value]) -> bool {
        self.upload_plans
            .iter()
            .all(|plan| Self::plan_matches(entities, plan, true))
            && self
                .endpoints
                .iter()
                .filter(|signature| signature.collector)
                .all(|signature| {
                    entities
                        .get(signature.entity_index)
                        .and_then(Value::as_object)
                        .is_some_and(|endpoint| {
                            string_at(endpoint, "id") == Some(signature.entity_id.as_str())
                                && is_quantum_collector(endpoint)
                        })
                })
    }

    pub(crate) fn wake_from_stations(&mut self, station_indices: &[usize]) {
        if !self.flush_all_pending {
            for station_index in station_indices {
                if let Some(plan_indices) = self.upload_by_station.get(station_index) {
                    self.pending_flush.extend(plan_indices.iter().copied());
                }
            }
        }
        if !self.download_all_pending {
            for station_index in station_indices {
                if let Some(plan_indices) = self.download_by_station.get(station_index) {
                    self.pending_download.extend(plan_indices.iter().copied());
                }
            }
        }
    }

    fn wake_download_credits(&mut self, state: &CoreState, credits: &crate::belts::OutputCredits) {
        if self.download_all_pending {
            return;
        }
        for &(source_index, item_symbol) in credits.active_source_items() {
            let source_index = source_index as usize;
            let Some(item_id) = state.symbols.resolve(item_symbol) else {
                self.download_all_pending = true;
                self.pending_download.clear();
                return;
            };
            if let Some(plan_indices) = self
                .download_by_station_item
                .get(&(source_index, item_id.to_owned()))
            {
                self.pending_download.extend(plan_indices.iter().copied());
            }
        }
    }

    pub(crate) fn wake_flush_items<'a>(&mut self, item_ids: impl Iterator<Item = &'a String>) {
        if self.flush_all_pending {
            return;
        }
        for item_id in item_ids {
            if let Some(plan_indices) = self.upload_by_item.get(item_id) {
                self.pending_flush.extend(plan_indices.iter().copied());
            }
        }
    }

    pub(crate) fn wake_flush_from_downloads(&mut self, flow: &BoundaryFlow) {
        self.wake_flush_items(flow.downloaded.keys());
    }

    fn commit_flush(&mut self, selected: &[usize]) {
        if self.flush_all_pending {
            self.flush_all_pending = false;
            self.pending_flush.clear();
            return;
        }
        for index in selected {
            self.pending_flush.remove(index);
        }
    }

    fn commit_download(&mut self, selected: &[usize], retain: BTreeSet<usize>) {
        if self.download_all_pending {
            self.download_all_pending = false;
            self.pending_download.clear();
        } else {
            for index in selected {
                self.pending_download.remove(index);
            }
        }
        self.pending_download.extend(retain);
    }

    fn mark_download_runtime_written(&mut self, entity_index: usize) {
        self.runtime_written_station_indices.insert(entity_index);
        self.inventory_written_station_indices.insert(entity_index);
    }

    fn mark_fallback_download_runtime_rows(&mut self) {
        let indices = self
            .download_plans
            .iter()
            .map(|plan| plan.entity_index)
            .collect::<Vec<_>>();
        self.runtime_written_station_indices
            .extend(indices.iter().copied());
        self.inventory_written_station_indices.extend(indices);
    }

    fn mark_inventory_written(&mut self, entity_index: usize) {
        self.inventory_written_station_indices.insert(entity_index);
    }

    fn mark_fallback_flush_runtime_rows(&mut self) {
        self.inventory_written_station_indices
            .extend(self.upload_plans.iter().map(|plan| plan.entity_index));
    }

    pub(crate) fn take_runtime_written_station_indices(&mut self) -> Vec<usize> {
        std::mem::take(&mut self.runtime_written_station_indices)
            .into_iter()
            .collect()
    }

    pub(crate) fn take_inventory_written_station_indices(&mut self) -> Vec<usize> {
        std::mem::take(&mut self.inventory_written_station_indices)
            .into_iter()
            .collect()
    }

    pub(crate) fn legacy_runtime_bandwidth(
        &mut self,
        state: &CoreState,
        base: &Map<String, Value>,
        entities: &[Value],
    ) -> RuntimeBandwidth {
        if self.fallback_full_scan || !self.topology_matches(state, entities) {
            return runtime_bandwidth(base, entities);
        }
        let level = logistics_level(base);
        let level_bits = level.to_bits();
        if self.cached_legacy_level_bits != Some(level_bits) {
            let multiplier_base = 1.0 + 0.05 * level;
            let multiplier = multiplier_base * multiplier_base;
            let mut per_minute = 0.0;
            for stacks in &self.tower_stack_terms {
                per_minute += UNIT_CAP_PER_MINUTE * multiplier * stacks;
            }
            self.cached_legacy_bandwidth = RuntimeBandwidth {
                per_minute,
                tower_stacks: self.tower_stacks,
                collector_stacks: self.collector_stacks,
            };
            self.cached_legacy_level_bits = Some(level_bits);
        }
        self.cached_legacy_bandwidth
    }

    fn indexed_runtime_bandwidth(&self, base: &Map<String, Value>) -> RuntimeBandwidth {
        let level = logistics_level(base);
        let multiplier_base = 1.0 + 0.05 * level;
        let multiplier = multiplier_base * multiplier_base;
        RuntimeBandwidth {
            per_minute: UNIT_CAP_PER_MINUTE * multiplier * self.tower_stacks,
            tower_stacks: self.tower_stacks,
            collector_stacks: self.collector_stacks,
        }
    }

    pub(crate) fn estimated_bytes(&self) -> u64 {
        let string_bytes = self
            .endpoints
            .iter()
            .map(|endpoint| endpoint.entity_id.capacity())
            .chain(self.upload_plans.iter().flat_map(|plan| {
                [
                    plan.entity_id.capacity(),
                    plan.item_id.capacity(),
                    plan.key.capacity(),
                    plan.flush_slot.remote_mode.capacity(),
                    plan.slot.remote_mode.capacity(),
                ]
            }))
            .chain(self.download_plans.iter().flat_map(|plan| {
                [
                    plan.entity_id.capacity(),
                    plan.item_id.capacity(),
                    plan.key.capacity(),
                    plan.flush_slot.remote_mode.capacity(),
                    plan.slot.remote_mode.capacity(),
                ]
            }))
            .sum::<usize>();
        (self.endpoints.capacity() * size_of::<QuantumEndpointSignature>()
            + self.endpoint_indices.capacity() * size_of::<usize>()
            + self.collector_indices.capacity() * size_of::<usize>()
            + self.upload_plans.capacity() * size_of::<QuantumSlotPlan>()
            + self.download_plans.capacity() * size_of::<QuantumSlotPlan>()
            + self.tower_stack_terms.capacity() * size_of::<f64>()
            + (self.pending_flush.len()
                + self.pending_download.len()
                + self.runtime_written_station_indices.len()
                + self.inventory_written_station_indices.len())
                * size_of::<usize>()
            + string_bytes) as u64
    }
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
    set_biguint_amount(record, item_id, saturated(next));
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

fn upsert_request_in_stable_order(
    requests: &mut Vec<Request>,
    positions: &mut HashMap<String, usize>,
    request: Request,
) {
    if let Some(&position) = positions.get(&request.key) {
        if request.priority > requests[position].priority {
            requests[position] = request;
        }
    } else {
        positions.insert(request.key.clone(), requests.len());
        requests.push(request);
    }
}

fn synchronize_existing_boundary_uploads(flow: &mut BoundaryFlow, existing: Option<&BoundaryFlow>) {
    let Some(existing) =
        existing.filter(|existing| existing.boundary_second == flow.boundary_second)
    else {
        return;
    };
    // `settle_downloads` writes one clone into the network and returns another
    // to the caller. Immediate local deliveries append to the network clone
    // before `settle_uploads` runs. Copy those cumulative values by key: adding
    // them would count the pre-download prefix twice.
    for (item_id, amount) in &existing.uploaded {
        set_biguint_amount(&mut flow.uploaded, item_id, amount.clone());
    }
}

fn apply_quantum_download_to_station(
    station: &mut Map<String, Value>,
    item_id: &str,
    amount: f64,
    seconds: f64,
) -> anyhow::Result<()> {
    let current = item_amount(station, "outputs", item_id).floor().max(0.0);
    set_item_amount(station, "outputs", item_id, current + amount)?;
    set_number(station, "stationLastTransfer", amount)?;
    let production_rate = finite_number(station.get("productionRate"))
        + if seconds > 0.0001 {
            amount * 60.0 / seconds
        } else {
            0.0
        };
    set_number(station, "productionRate", production_rate)
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
        set_biguint_amount(
            &mut network.inventory,
            item_id,
            saturated(available - &allocation.total),
        );
        if allocation.total < planned && !item_requests.is_empty() {
            advance_routing_cursor(&mut network.routing_cursors, item_id);
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
            advance_routing_cursor(&mut network.upload_routing_cursors, &item_id);
        }
        if !accepted.is_zero() {
            let next = network.inventory.get(&item_id).cloned().unwrap_or_default() + accepted;
            set_biguint_amount(&mut network.inventory, &item_id, saturated(next));
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
        set_biguint_amount(
            &mut network.inventory,
            item_id,
            saturated(current + &accepted),
        );
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
    // `recordImmediateQuantumUpload` creates its flow without the JavaScript
    // lookup, so its observable IEEE-754 addition is the persisted entity-
    // order legacy sum even when the buffer rows themselves are indexed.
    let runtime_bandwidth = runtime_bandwidth(base, entities);
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

pub(crate) fn flush_active_supply_buffers(
    state: &CoreState,
    base: &mut Map<String, Value>,
    entities: &mut [Value],
    directory: &mut QuantumLogisticsDirectory,
    route_ledger: &crate::station_route_ledger::StationRouteLedger,
    runtime_bandwidth: RuntimeBandwidth,
    frozen_mode: bool,
) -> anyhow::Result<QuantumActiveScan> {
    let mut network = parse_network(base)?;
    if !network.enabled {
        return Ok(QuantumActiveScan {
            total_rows: directory.upload_plans.len(),
            ..QuantumActiveScan::default()
        });
    }
    let (selected, scan) = directory.selected_flush_plans(state, entities, frozen_mode);
    let Some(selected) = selected else {
        flush_supply_buffers_for_index(base, entities, None)?;
        directory.mark_fallback_flush_runtime_rows();
        return Ok(scan);
    };
    let mut normalized_for_deposit = false;
    for &plan_index in &selected {
        let plan = &directory.upload_plans[plan_index];
        let station = entities[plan.entity_index]
            .as_object_mut()
            .ok_or_else(|| anyhow!("native quantum station is invalid"))?;
        let input = item_amount(station, "inputs", &plan.item_id)
            .floor()
            .max(0.0);
        let output = item_amount(station, "outputs", &plan.item_id)
            .floor()
            .max(0.0);
        let outgoing = route_ledger
            .quantum_reserved_outgoing(plan.entity_index, &plan.item_id)
            .floor()
            .max(0.0);
        let from_output_available = (output - plan.flush_slot.min_stock - outgoing).max(0.0);
        let from_input_available = (input - (plan.flush_slot.min_stock - output).max(0.0)).max(0.0);
        let requested = floor_u64(from_output_available + from_input_available);
        if requested < 1 {
            continue;
        }
        if !normalized_for_deposit {
            network.inventory.retain(|_, amount| !amount.is_zero());
            normalized_for_deposit = true;
        }
        let accepted = deposit(&mut network, &plan.item_id, &BigUint::from(requested));
        let accepted_number = accepted.to_u64().unwrap_or(MAX_SAFE_INTEGER) as f64;
        if accepted_number < 1.0 {
            continue;
        }
        let from_output = from_output_available.min(accepted_number);
        if from_output > 0.0 {
            set_item_amount(station, "outputs", &plan.item_id, output - from_output)?;
        }
        let remaining = accepted_number - from_output;
        if remaining > 0.0 {
            set_item_amount(
                station,
                "inputs",
                &plan.item_id,
                (input - remaining).max(0.0),
            )?;
        }
        record_immediate_upload(
            base,
            runtime_bandwidth,
            &mut network,
            &plan.item_id,
            &accepted,
        );
        directory.mark_inventory_written(plan.entity_index);
    }
    write_network(base, &network)?;
    directory.commit_flush(&selected);
    Ok(scan)
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
    let mut requests = Vec::new();
    let mut request_positions = HashMap::new();
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
            upsert_request_in_stable_order(
                &mut requests,
                &mut request_positions,
                Request {
                    key,
                    entity_index,
                    item_id: item_id.to_owned(),
                    amount: BigUint::from(capacity),
                    priority: slot.priority,
                },
            );
        }
    }
    let construction_demands = crate::construction::quantum_demands(state, base, entities)?
        .into_iter()
        .map(|demand| (demand.key.clone(), demand))
        .collect::<BTreeMap<_, _>>();
    for demand in construction_demands.values() {
        upsert_request_in_stable_order(
            &mut requests,
            &mut request_positions,
            Request {
                key: demand.key.clone(),
                entity_index: usize::MAX,
                item_id: demand.item_id.clone(),
                amount: BigUint::from(demand.amount),
                priority: 1,
            },
        );
    }
    let mut allocation_requests = requests.clone();
    sorted_requests(&mut allocation_requests);
    let delivered = settle_outputs(
        &mut network,
        &allocation_requests,
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
        apply_quantum_download_to_station(station, &request.item_id, amount_number, seconds)?;
        add_flow(&mut flow.downloaded, &request.item_id, &amount);
    }
    network.runtime_flow = Some(flow.clone());
    write_network(base, &network)?;
    Ok(Some(flow))
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn settle_active_downloads(
    state: &CoreState,
    base: &mut Map<String, Value>,
    entities: &mut [Value],
    credits: &crate::belts::OutputCredits,
    boundary_second: f64,
    seconds: f64,
    directory: &mut QuantumLogisticsDirectory,
    route_ledger: &crate::station_route_ledger::StationRouteLedger,
) -> anyhow::Result<(Option<BoundaryFlow>, QuantumActiveScan)> {
    let mut network = parse_network(base)?;
    if !network.enabled {
        return Ok((
            None,
            QuantumActiveScan {
                total_rows: directory.download_plans.len(),
                ..QuantumActiveScan::default()
            },
        ));
    }
    directory.wake_download_credits(state, credits);
    let (selected, scan) = directory.selected_download_plans(state, entities);
    let Some(selected) = selected else {
        let flow = settle_downloads(state, base, entities, credits, boundary_second, seconds)?;
        directory.mark_fallback_download_runtime_rows();
        return Ok((flow, scan));
    };
    let bandwidth = directory.indexed_runtime_bandwidth(base);
    let mut flow = create_flow_with_bandwidth(&network, boundary_second, bandwidth);
    let mut requests = Vec::new();
    let mut request_positions = HashMap::new();
    let mut retain = BTreeSet::new();
    for &plan_index in &selected {
        let plan = &directory.download_plans[plan_index];
        let station = entities[plan.entity_index]
            .as_object()
            .ok_or_else(|| anyhow!("native quantum endpoint is invalid"))?;
        let current = item_amount(station, "outputs", &plan.item_id)
            .floor()
            .max(0.0);
        let local_capacity = station_capacity(state, base, station, &plan.slot)?
            .floor()
            .max(0.0);
        let incoming = route_ledger
            .quantum_in_flight(plan.entity_index, &plan.item_id)
            .max(0.0);
        let local_free = (local_capacity - current - incoming).max(0.0);
        let direct_through = if current <= local_capacity {
            crate::belts::output_credit(state, credits, &plan.entity_id, &plan.item_id)
        } else {
            0.0
        };
        let capacity = floor_u64((local_free + direct_through).min(MAX_SAFE_INTEGER as f64));
        if capacity < 1 {
            continue;
        }
        // A positive-capacity request remains semantically active even when
        // its item has zero inventory: JavaScript first allocates the global
        // bandwidth and only then applies the per-item inventory budget.
        retain.insert(plan_index);
        upsert_request_in_stable_order(
            &mut requests,
            &mut request_positions,
            Request {
                key: plan.key.clone(),
                entity_index: plan.entity_index,
                item_id: plan.item_id.clone(),
                amount: BigUint::from(capacity),
                priority: plan.slot.priority,
            },
        );
    }
    let construction_demands = crate::construction::quantum_demands(state, base, entities)?
        .into_iter()
        .map(|demand| (demand.key.clone(), demand))
        .collect::<BTreeMap<_, _>>();
    for demand in construction_demands.values() {
        upsert_request_in_stable_order(
            &mut requests,
            &mut request_positions,
            Request {
                key: demand.key.clone(),
                entity_index: usize::MAX,
                item_id: demand.item_id.clone(),
                amount: BigUint::from(demand.amount),
                priority: 1,
            },
        );
    }
    let mut allocation_requests = requests.clone();
    sorted_requests(&mut allocation_requests);
    let delivered = settle_outputs(
        &mut network,
        &allocation_requests,
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
        apply_quantum_download_to_station(station, &request.item_id, amount_number, seconds)?;
        directory.mark_download_runtime_written(request.entity_index);
        add_flow(&mut flow.downloaded, &request.item_id, &amount);
    }
    network.runtime_flow = Some(flow.clone());
    write_network(base, &network)?;
    directory.commit_download(&selected, retain);
    Ok((Some(flow), scan))
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn settle_uploads(
    state: &CoreState,
    base: &mut Map<String, Value>,
    entities: &mut [Value],
    boundary_second: f64,
    previous_flow: Option<BoundaryFlow>,
    seconds: f64,
    indexed_endpoint_indices: &[usize],
    directory: &mut QuantumLogisticsDirectory,
    route_ledger: &crate::station_route_ledger::StationRouteLedger,
    runtime_bandwidth: RuntimeBandwidth,
) -> anyhow::Result<QuantumActiveScan> {
    let mut network = parse_network(base)?;
    if !network.enabled {
        return Ok(QuantumActiveScan::default());
    }
    // This boundary already visits every upload plan and collector to build
    // the shared budget. Fold exact frozen-lookup validation into that same
    // O(upload) phase, then latch the legacy path if an impossible internal
    // membership/key/rank mismatch is observed. Ordinary per-second steps do
    // not rescan all endpoints merely to guard an immutable Arc-bound cache.
    if directory.can_use_index(state, entities) && !directory.upload_index_matches(entities) {
        directory.fallback_full_scan = true;
    }
    let existing_flow = network.runtime_flow.clone();
    let mut flow = previous_flow
        .clone()
        .unwrap_or_else(|| create_flow(base, entities, &network, boundary_second));
    synchronize_existing_boundary_uploads(&mut flow, existing_flow.as_ref());
    let bandwidth = if directory.can_use_index(state, entities) {
        directory.indexed_runtime_bandwidth(base)
    } else {
        let (per_minute, tower_stacks, collector_stacks) =
            bandwidth_for_index(base, entities, Some(indexed_endpoint_indices));
        RuntimeBandwidth {
            per_minute,
            tower_stacks,
            collector_stacks,
        }
    };
    flow.global_upload_per_minute = bandwidth.per_minute;
    flow.global_download_per_minute = bandwidth.per_minute;
    flow.quantum_tower_stacks = bandwidth.tower_stacks;
    flow.quantum_collector_stacks = bandwidth.collector_stacks;
    network.runtime_flow = Some(flow.clone());
    write_network(base, &network)?;

    let flush_scan = flush_active_supply_buffers(
        state,
        base,
        entities,
        directory,
        route_ledger,
        runtime_bandwidth,
        true,
    )?;
    network = parse_network(base)?;

    let use_index = directory.can_use_index(state, entities);
    let reserved = (!use_index).then(|| reserved_outgoing(entities));
    let mut requests = Vec::new();
    let mut request_positions = HashMap::new();
    let collector_indices = if use_index {
        directory.collector_indices.as_slice()
    } else {
        indexed_endpoint_indices
    };
    for &entity_index in collector_indices {
        let endpoint = entities[entity_index]
            .as_object()
            .ok_or_else(|| anyhow!("native quantum endpoint is invalid"))?;
        if !use_index && !is_quantum_collector(endpoint) {
            continue;
        }
        let Some(item_id) = string_at(endpoint, "storedItemId") else {
            continue;
        };
        let available = floor_u64(item_amount(endpoint, "outputs", item_id));
        if available > 0 {
            let key = format!(
                "{}:{item_id}",
                string_at(endpoint, "id").unwrap_or_default()
            );
            upsert_request_in_stable_order(
                &mut requests,
                &mut request_positions,
                Request {
                    key,
                    entity_index,
                    item_id: item_id.to_owned(),
                    amount: BigUint::from(available),
                    priority: 1,
                },
            );
        }
    }
    if use_index {
        for plan in &directory.upload_plans {
            let endpoint = entities[plan.entity_index]
                .as_object()
                .ok_or_else(|| anyhow!("native quantum endpoint is invalid"))?;
            let outgoing = route_ledger.quantum_reserved_outgoing(plan.entity_index, &plan.item_id);
            let available = floor_u64(
                (item_amount(endpoint, "outputs", &plan.item_id) - plan.slot.min_stock - outgoing)
                    .max(0.0),
            );
            if available < 1 {
                continue;
            }
            upsert_request_in_stable_order(
                &mut requests,
                &mut request_positions,
                Request {
                    key: plan.key.clone(),
                    entity_index: plan.entity_index,
                    item_id: plan.item_id.clone(),
                    amount: BigUint::from(available),
                    priority: plan.slot.priority,
                },
            );
        }
    } else {
        for &entity_index in indexed_endpoint_indices {
            let endpoint = entities[entity_index]
                .as_object()
                .ok_or_else(|| anyhow!("native quantum endpoint is invalid"))?;
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
                    .as_ref()
                    .and_then(|reserved| {
                        reserved
                            .get(&(station_id.to_owned(), item_id.to_owned()))
                            .copied()
                    })
                    .unwrap_or(0.0);
                let available = floor_u64(
                    (item_amount(endpoint, "outputs", item_id) - slot.min_stock - outgoing)
                        .max(0.0),
                );
                if available < 1 {
                    continue;
                }
                let key = format!("{station_id}:{item_id}");
                upsert_request_in_stable_order(
                    &mut requests,
                    &mut request_positions,
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
    let mut allocation_requests = requests.clone();
    sorted_requests(&mut allocation_requests);
    let accepted = settle_inputs(
        &mut network,
        &allocation_requests,
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
        directory.mark_inventory_written(request.entity_index);
        add_flow(&mut flow.uploaded, &request.item_id, &amount);
    }
    network.runtime_flow = Some(flow);
    write_network(base, &network)?;
    Ok(flush_scan)
}

fn completed_tech(base: &Map<String, Value>, id: &str) -> bool {
    base.get("research")
        .and_then(Value::as_object)
        .and_then(|research| research.get("completedTechIds"))
        .and_then(Value::as_array)
        .is_some_and(|ids| ids.iter().any(|value| value.as_str() == Some(id)))
}

fn push_unique_station_id(station_ids: &mut Vec<String>, station_id: &str) {
    if !station_ids.iter().any(|candidate| candidate == station_id) {
        station_ids.push(station_id.to_owned());
    }
}

fn probe_transition_entity(
    entity_index: usize,
    value: &Value,
    quantum_tech_completed: bool,
) -> TransitionEntityProbe {
    let Some(entity) = value.as_object() else {
        return TransitionEntityProbe {
            route_memberships: Vec::new(),
            candidate: None,
            #[cfg(test)]
            worker_index: rayon::current_thread_index(),
        };
    };
    let demand_id = string_at(entity, "id").unwrap_or_default();
    let mut route_memberships = Vec::new();
    if let Some(routes) = entity.get("stationRoutes").and_then(Value::as_array) {
        for route in routes.iter().filter_map(Value::as_object) {
            if string_at(route, "scope") != Some("remote") {
                continue;
            }
            let peer_id = string_at(route, "peerId").unwrap_or_default();
            let vehicle_station_id = string_at(route, "vehicleStationId").unwrap_or(demand_id);
            let mut station_ids = Vec::new();
            push_unique_station_id(&mut station_ids, demand_id);
            push_unique_station_id(&mut station_ids, peer_id);
            push_unique_station_id(&mut station_ids, vehicle_station_id);
            if let Some(waypoints) = route.get("waypointStationIds").and_then(Value::as_array) {
                for station_id in waypoints.iter().filter_map(Value::as_str) {
                    push_unique_station_id(&mut station_ids, station_id);
                }
            }
            let route = TransitionRoute {
                demand_id: demand_id.to_owned(),
                route_id: string_at(route, "id").unwrap_or_default().to_owned(),
                item_id: string_at(route, "itemId").unwrap_or_default().to_owned(),
                peer_id: peer_id.to_owned(),
                cargo: decimal(&BigUint::from(floor_u64(finite_number(route.get("cargo"))))),
                duration: finite_number(route.get("duration")),
                progress: finite_number(route.get("progress")).clamp(0.0, 1.0),
            };
            route_memberships.extend(
                station_ids
                    .into_iter()
                    .map(|station_id| (station_id, route.clone())),
            );
        }
    }
    let existing = entity
        .get("quantumTransition")
        .and_then(Value::as_object)
        .cloned();
    let planned = quantum_tech_completed
        && existing.is_none()
        && string_at(entity, "buildingId") == Some("interstellar_logistics_station")
        && entity.get("quantumTarget").and_then(Value::as_bool) == Some(true)
        && finite_number(entity.get("stationTier")).floor() >= 2.0
        && string_at(entity, "quantumMode") != Some("quantum")
        && entity.get("quantumTransition").is_none_or(Value::is_null);
    let source = existing
        .map(TransitionCandidateSource::Existing)
        .or_else(|| planned.then_some(TransitionCandidateSource::Planned));
    TransitionEntityProbe {
        route_memberships,
        candidate: source.map(|source| TransitionCandidate {
            entity_index,
            station_id: demand_id.to_owned(),
            source,
        }),
        #[cfg(test)]
        worker_index: rayon::current_thread_index(),
    }
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

fn probe_transition_patch(
    candidate: &TransitionCandidate,
    routes_by_station: &HashMap<String, Vec<TransitionRoute>>,
    elapsed: f64,
) -> anyhow::Result<TransitionPatchProbe> {
    let routes = routes_by_station
        .get(&candidate.station_id)
        .map(Vec::as_slice)
        .unwrap_or_default();
    let planned = matches!(&candidate.source, TransitionCandidateSource::Planned);
    let transition = match &candidate.source {
        TransitionCandidateSource::Existing(transition) => transition.clone(),
        TransitionCandidateSource::Planned => {
            let bridges = routes
                .iter()
                .map(|route| transition_bridge(&candidate.station_id, route, elapsed))
                .collect::<Vec<_>>();
            serde_json::json!({
                "targetMode": "quantum",
                "startedAtSecond": elapsed,
                "boundarySecond": ((elapsed / SETTLEMENT_SECONDS).floor() + 1.0) * SETTLEMENT_SECONDS,
                "bridges": bridges,
            })
            .as_object()
            .expect("planned quantum transition")
            .clone()
        }
    };
    let bridges = synchronized_bridges(&candidate.station_id, &transition, routes, elapsed)?;
    let boundary = finite_number(transition.get("boundarySecond"));
    let bridge_cargo_pending = bridges.iter().filter_map(Value::as_object).any(|bridge| {
        !normalized_decimal(bridge.get("remainingCargo"), &BigUint::zero()).is_zero()
    });
    let target_mode = string_at(&transition, "targetMode")
        .unwrap_or("legacy")
        .to_owned();
    let result = if elapsed < boundary || !routes.is_empty() || bridge_cargo_pending {
        let mut next = transition;
        next.insert("bridges".to_owned(), Value::Array(bridges));
        TransitionPatchResult::Active(next)
    } else {
        TransitionPatchResult::Complete(target_mode)
    };
    Ok(TransitionPatchProbe {
        patch: TransitionPatch {
            entity_index: candidate.entity_index,
            planned,
            result,
        },
        #[cfg(test)]
        worker_index: rayon::current_thread_index(),
    })
}

fn settle_transitions_with_runtime(
    runtime: &DeterministicRuntime,
    base: &mut Map<String, Value>,
    entities: &mut [Value],
) -> anyhow::Result<TransitionParallelDiagnostics> {
    let elapsed = finite_number(base.get("elapsedSeconds"));
    let quantum_tech_completed = completed_tech(base, "quantum_logistics_network");
    let entity_probes = runtime.indexed_map(entities, |entity_index, entity| {
        probe_transition_entity(entity_index, entity, quantum_tech_completed)
    });
    let mut routes_by_station = HashMap::<String, Vec<TransitionRoute>>::new();
    let mut candidates = Vec::new();
    #[cfg(test)]
    let mut diagnostics = TransitionParallelDiagnostics::default();
    #[cfg(not(test))]
    let mut diagnostics = TransitionParallelDiagnostics::default();
    #[cfg(test)]
    {
        diagnostics.entity_probe_count = entity_probes.len();
    }
    for probe in entity_probes {
        #[cfg(test)]
        if let Some(worker_index) = probe.worker_index {
            diagnostics.entity_probe_workers.insert(worker_index);
        }
        for (station_id, route) in probe.route_memberships {
            #[cfg(test)]
            {
                diagnostics.route_membership_count += 1;
            }
            routes_by_station.entry(station_id).or_default().push(route);
        }
        if let Some(candidate) = probe.candidate {
            candidates.push(candidate);
        }
    }
    let patch_probes = runtime.indexed_try_map(&candidates, |_, candidate| {
        probe_transition_patch(candidate, &routes_by_station, elapsed)
    })?;
    #[cfg(test)]
    {
        diagnostics.transition_probe_count = patch_probes.len();
    }
    let mut patches = Vec::with_capacity(patch_probes.len());
    let mut enable_network = false;
    for probe in patch_probes {
        #[cfg(test)]
        if let Some(worker_index) = probe.worker_index {
            diagnostics.transition_probe_workers.insert(worker_index);
        }
        if matches!(probe.patch.result, TransitionPatchResult::Complete(ref mode) if mode == "quantum")
        {
            enable_network = true;
        }
        patches.push(probe.patch);
    }
    diagnostics.topology_changed = !patches.is_empty();

    // No source field is written until every parallel probe and every commit
    // target has been validated. This turns malformed transition data into a
    // deterministic, lowest-entity-index rejection instead of a partial
    // transition commit.
    for patch in &patches {
        if entities
            .get(patch.entity_index)
            .and_then(Value::as_object)
            .is_none()
        {
            return Err(anyhow!("native quantum transition station is invalid"));
        }
    }
    if enable_network
        && base
            .get("quantumLogisticsNetwork")
            .and_then(Value::as_object)
            .is_none()
    {
        return Err(anyhow!("native quantum network is missing"));
    }

    for patch in patches {
        let entity = entities[patch.entity_index]
            .as_object_mut()
            .expect("preflighted quantum transition station");
        if patch.planned {
            entity.insert("quantumMode".to_owned(), Value::from("transitioning"));
            entity.remove("quantumTarget");
        }
        match patch.result {
            TransitionPatchResult::Active(transition) => {
                entity.insert("quantumTransition".to_owned(), Value::Object(transition));
            }
            TransitionPatchResult::Complete(target_mode) => {
                entity.insert("quantumMode".to_owned(), Value::from(target_mode));
                entity.insert("quantumTransition".to_owned(), Value::Null);
            }
        }
    }
    if enable_network {
        base.get_mut("quantumLogisticsNetwork")
            .and_then(Value::as_object_mut)
            .expect("preflighted quantum network")
            .insert("enabled".to_owned(), Value::Bool(true));
    }
    Ok(diagnostics)
}

pub(crate) fn settle_transitions(
    base: &mut Map<String, Value>,
    entities: &mut [Value],
) -> anyhow::Result<bool> {
    settle_transitions_with_runtime(crate::deterministic_runtime::runtime(), base, entities)
        .map(|diagnostics| diagnostics.topology_changed)
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
    use sha2::{Digest, Sha256};

    fn active_quantum_base(level: u64) -> Map<String, Value> {
        serde_json::json!({
            "elapsedSeconds": 0,
            "settings": { "logisticsBufferLimit": 1_000_000 },
            "research": { "completedTechIds": ["quantum_logistics_network"] },
            "endgame": {
                "infiniteResearch": {
                    "galactic_logistics": { "level": level }
                }
            },
            "constructionAutomation": {
                "enabled": false,
                "quantumSourceEnabled": false
            },
            "quantumLogisticsNetwork": {
                "enabled": true,
                "inventory": {},
                "itemCapacities": {
                    "iron_ore": "10000",
                    "iron_ingot": "10000"
                },
                "routingCursors": {},
                "uploadRoutingCursors": {}
            }
        })
        .as_object()
        .expect("quantum test base")
        .clone()
    }

    fn quantum_station(
        id: impl Into<String>,
        item_id: &str,
        remote_mode: &str,
        input: f64,
        output: f64,
        routes: Vec<Value>,
    ) -> Value {
        let id = id.into();
        serde_json::json!({
            "id": id,
            "kind": "station",
            "planetId": "home",
            "powerGridId": "grid-a",
            "buildingId": "interstellar_logistics_station",
            "machineCount": 1,
            "stationTier": 2,
            "quantumMode": "quantum",
            "stationSlots": [{
                "itemId": item_id,
                "localMode": "storage",
                "remoteMode": remote_mode,
                "minStock": 0,
                "maxStock": 0,
                "priority": 1
            }],
            "inputs": { (item_id): input },
            "outputs": { (item_id): output },
            "stationRoutes": routes,
            "stationLastTransfer": 0,
            "productionRate": 0,
            "utilization": 0,
            "routingCursor": 0
        })
    }

    fn set_test_item(entity: &mut Value, record: &str, item_id: &str, amount: f64) {
        set_item_amount(
            entity.as_object_mut().expect("quantum test station"),
            record,
            item_id,
            amount,
        )
        .unwrap();
    }

    fn set_test_network_item(base: &mut Map<String, Value>, item_id: &str, amount: &str) {
        base.get_mut("quantumLogisticsNetwork")
            .and_then(Value::as_object_mut)
            .and_then(|network| network.get_mut("inventory"))
            .and_then(Value::as_object_mut)
            .expect("quantum test inventory")
            .insert(item_id.to_owned(), Value::from(amount));
    }

    fn quantum_oracle_bytes(base: &Map<String, Value>, entities: &[Value]) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({
            "base": base,
            "entities": entities,
        }))
        .unwrap()
    }

    fn legacy_settle_outputs(
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

    fn legacy_settle_inputs(
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

    fn string_key_pointer<T>(record: &BTreeMap<String, T>, item_id: &str) -> usize {
        record
            .keys()
            .find(|key| key.as_str() == item_id)
            .expect("test item key")
            .as_ptr() as usize
    }

    fn json_key_pointer(record: &Map<String, Value>, item_id: &str) -> usize {
        record
            .keys()
            .find(|key| key.as_str() == item_id)
            .expect("test JSON item key")
            .as_ptr() as usize
    }

    fn request(key: &str, amount: u64) -> Request {
        Request {
            key: key.to_owned(),
            entity_index: 0,
            item_id: "iron_ore".to_owned(),
            amount: BigUint::from(amount),
            priority: 1,
        }
    }

    fn item_request(key: &str, item_id: &str, amount: u64, priority: i64) -> Request {
        Request {
            key: key.to_owned(),
            entity_index: 0,
            item_id: item_id.to_owned(),
            amount: BigUint::from(amount),
            priority,
        }
    }

    #[test]
    fn item_amount_updates_reuse_existing_key_and_preserve_error_order() {
        let item_id = "mod:量子物流/Ω🚀";
        let mut entity = Map::from_iter([(
            "inputs".to_owned(),
            Value::Object(Map::from_iter([
                ("alpha".to_owned(), Value::from(1)),
                (item_id.to_owned(), Value::from(2)),
                ("zeta".to_owned(), Value::from(3)),
            ])),
        )]);
        let before = entity["inputs"].as_object().expect("inputs object");
        let key_pointer = json_key_pointer(before, item_id);
        let order = before.keys().cloned().collect::<Vec<_>>();

        set_item_amount(&mut entity, "inputs", item_id, -0.0).unwrap();
        let after = entity["inputs"].as_object().expect("inputs object");
        assert_eq!(json_key_pointer(after, item_id), key_pointer);
        assert_eq!(after.keys().cloned().collect::<Vec<_>>(), order);
        assert!(after[item_id].as_f64().unwrap().is_sign_negative());

        let snapshot = entity.clone();
        let error = set_item_amount(&mut entity, "inputs", item_id, f64::NAN).unwrap_err();
        assert_eq!(
            error.to_string(),
            "native quantum logistics inventory is non-finite"
        );
        assert_eq!(entity, snapshot);

        let error = set_item_amount(&mut entity, "missing", item_id, f64::NAN).unwrap_err();
        assert_eq!(
            error.to_string(),
            "native quantum logistics inventory is missing"
        );
        assert_eq!(entity, snapshot);
    }

    #[test]
    fn item_amount_updates_clone_only_missing_unicode_and_mod_keys() {
        let mut entity = Map::from_iter([("outputs".to_owned(), Value::Object(Map::new()))]);
        for (item_id, amount) in [
            ("mod:zeta/量子", 7.0),
            ("原版:alpha/Ω", 11.0),
            ("mod:middle/🚀", 13.0),
        ] {
            set_item_amount(&mut entity, "outputs", item_id, amount).unwrap();
        }
        let outputs = entity["outputs"].as_object().expect("outputs object");
        assert_eq!(
            outputs.keys().map(String::as_str).collect::<Vec<_>>(),
            vec!["mod:middle/🚀", "mod:zeta/量子", "原版:alpha/Ω"]
        );
        assert_eq!(finite_number(outputs.get("mod:middle/🚀")), 13.0);
    }

    #[test]
    fn biguint_and_cursor_updates_reuse_existing_keys_and_keep_limits() {
        let item_id = "mod:量子网络/Ω🚀";
        let maximum = BigUint::parse_bytes("9".repeat(MAX_INTEGER_DIGITS).as_bytes(), 10).unwrap();
        let mut amounts = BTreeMap::from([
            ("alpha".to_owned(), BigUint::from(1_u8)),
            (item_id.to_owned(), maximum.clone()),
            ("zeta".to_owned(), BigUint::from(3_u8)),
        ]);
        let amount_pointer = string_key_pointer(&amounts, item_id);
        let order = amounts.keys().cloned().collect::<Vec<_>>();
        add_flow(&mut amounts, item_id, &BigUint::from(1_u8));
        assert_eq!(string_key_pointer(&amounts, item_id), amount_pointer);
        assert_eq!(amounts.keys().cloned().collect::<Vec<_>>(), order);
        assert_eq!(amounts[item_id], maximum);

        set_biguint_amount(&mut amounts, "mod:missing/新", BigUint::from(5_u8));
        assert_eq!(amounts["mod:missing/新"], BigUint::from(5_u8));
        assert_eq!(
            amounts.keys().map(String::as_str).collect::<Vec<_>>(),
            vec!["alpha", "mod:missing/新", "mod:量子网络/Ω🚀", "zeta"]
        );

        let mut cursors = BTreeMap::from([(item_id.to_owned(), 7_u64)]);
        let cursor_pointer = string_key_pointer(&cursors, item_id);
        advance_routing_cursor(&mut cursors, item_id);
        assert_eq!(string_key_pointer(&cursors, item_id), cursor_pointer);
        assert_eq!(cursors[item_id], 8);
        advance_routing_cursor(&mut cursors, "mod:missing/游标");
        assert_eq!(cursors["mod:missing/游标"], 1);
    }

    #[test]
    fn in_place_network_updates_match_clone_reinsert_settlement() {
        let special = "mod:量子矿石/Ω🚀";
        let mut optimized = Network {
            enabled: true,
            inventory: BTreeMap::from([
                (special.to_owned(), BigUint::from(13_u8)),
                ("iron_ore".to_owned(), BigUint::from(9_998_u64)),
            ]),
            item_capacities: BTreeMap::from([
                (special.to_owned(), BigUint::from(10_000_u64)),
                ("iron_ore".to_owned(), BigUint::from(10_000_u64)),
                ("mod:new/物料".to_owned(), BigUint::from(10_000_u64)),
            ]),
            routing_cursors: BTreeMap::from([(special.to_owned(), 2)]),
            upload_routing_cursors: BTreeMap::from([("iron_ore".to_owned(), 4)]),
            ..Network::default()
        };
        let mut legacy = optimized.clone();
        let outputs = vec![
            item_request("out-b", special, 11, 2),
            item_request("out-a", special, 7, 2),
            item_request("out-new", "mod:new/物料", 5, 1),
        ];
        let optimized_delivered = settle_outputs(&mut optimized, &outputs, &BigUint::from(23_u8));
        let legacy_delivered = legacy_settle_outputs(&mut legacy, &outputs, &BigUint::from(23_u8));
        assert_eq!(optimized_delivered, legacy_delivered);

        let inputs = vec![
            item_request("in-b", "iron_ore", 9, 2),
            item_request("in-a", "iron_ore", 5, 2),
            item_request("in-new", "mod:new/物料", 3, 1),
        ];
        let optimized_accepted = settle_inputs(&mut optimized, &inputs, &BigUint::from(7_u8));
        let legacy_accepted = legacy_settle_inputs(&mut legacy, &inputs, &BigUint::from(7_u8));
        assert_eq!(optimized_accepted, legacy_accepted);
        assert_eq!(optimized.inventory, legacy.inventory);
        assert_eq!(optimized.routing_cursors, legacy.routing_cursors);
        assert_eq!(
            optimized.upload_routing_cursors,
            legacy.upload_routing_cursors
        );
        assert_eq!(optimized.item_capacities, legacy.item_capacities);
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

    #[test]
    fn boundary_flow_distinguishes_enabled_zero_delivery_from_real_downloads() {
        let empty = BoundaryFlow::default();
        assert!(!empty.has_downloads());

        let zero_record = BoundaryFlow {
            downloaded: BTreeMap::from([("iron_ore".to_owned(), BigUint::zero())]),
            ..BoundaryFlow::default()
        };
        assert!(!zero_record.has_downloads());

        let delivered = BoundaryFlow {
            downloaded: BTreeMap::from([("iron_ore".to_owned(), BigUint::from(1_u8))]),
            ..BoundaryFlow::default()
        };
        assert!(delivered.has_downloads());
    }

    #[test]
    fn cached_bandwidth_preserves_both_legacy_and_indexed_ieee_order() {
        let mut first = quantum_station("tower-a", "iron_ore", "supply", 0.0, 0.0, vec![]);
        first
            .as_object_mut()
            .unwrap()
            .insert("machineCount".to_owned(), Value::from(1));
        let mut second = quantum_station("tower-b", "iron_ore", "demand", 0.0, 0.0, vec![]);
        second
            .as_object_mut()
            .unwrap()
            .insert("machineCount".to_owned(), Value::from(13));
        let entities = vec![first, second];
        let state = crate::simple_factory::tests::fixture_state(&entities);
        let mut base = active_quantum_base(100_000_000);
        let mut directory = QuantumLogisticsDirectory::build(&state, &entities);

        let full_legacy = runtime_bandwidth(&base, &entities);
        let cached_legacy = directory.legacy_runtime_bandwidth(&state, &base, &entities);
        assert_eq!(
            cached_legacy.per_minute.to_bits(),
            full_legacy.per_minute.to_bits()
        );
        assert_eq!(cached_legacy.tower_stacks.to_bits(), 14.0_f64.to_bits());

        let indexed = directory.indexed_runtime_bandwidth(&base);
        let (indexed_per_minute, indexed_towers, indexed_collectors) =
            bandwidth_for_index(&base, &entities, Some(&directory.endpoint_indices));
        assert_eq!(indexed.per_minute.to_bits(), indexed_per_minute.to_bits());
        assert_eq!(indexed.tower_stacks.to_bits(), indexed_towers.to_bits());
        assert_eq!(
            indexed.collector_stacks.to_bits(),
            indexed_collectors.to_bits()
        );
        assert_ne!(
            cached_legacy.per_minute.to_bits(),
            indexed.per_minute.to_bits(),
            "the fixture must exercise JavaScript's observable addition-order split"
        );

        base["endgame"]["infiniteResearch"]["galactic_logistics"]["level"] =
            Value::from(100_000_001_u64);
        let refreshed = directory.legacy_runtime_bandwidth(&state, &base, &entities);
        let refreshed_full = runtime_bandwidth(&base, &entities);
        assert_eq!(
            refreshed.per_minute.to_bits(),
            refreshed_full.per_minute.to_bits(),
            "a live logistics-level boundary must invalidate the scalar cache"
        );
        assert_ne!(
            refreshed.per_minute.to_bits(),
            cached_legacy.per_minute.to_bits()
        );
    }

    #[test]
    fn active_quantum_1_to_60_seconds_match_full_scan_bytes() {
        let mut source = Vec::new();
        for index in 0..4 {
            source.push(quantum_station(
                format!("supply-{index}"),
                if index == 3 { "iron_ingot" } else { "iron_ore" },
                "supply",
                if index == 0 {
                    17.0
                } else if index == 3 {
                    40.0
                } else {
                    0.0
                },
                if index == 0 { 43.0 } else { 0.0 },
                vec![],
            ));
        }
        for index in 0..4 {
            source.push(quantum_station(
                format!("demand-{index}"),
                "iron_ingot",
                "demand",
                0.0,
                if index == 0 { 0.0 } else { 100.0 },
                vec![],
            ));
        }
        let state = crate::simple_factory::tests::fixture_state(&source);
        let mut active_base = active_quantum_base(0);
        set_test_network_item(&mut active_base, "iron_ingot", "10000");
        let mut full_base = active_base.clone();
        let mut active_entities = source.clone();
        let mut full_entities = source;
        let mut directory = QuantumLogisticsDirectory::build(&state, &active_entities);
        let route_ledger = crate::station_route_ledger::StationRouteLedger::default();
        let credits = crate::belts::OutputCredits::default();
        let mut saw_sparse_flush = false;
        let mut saw_sparse_download = false;

        for second in 1_u64..=60 {
            active_base.insert("elapsedSeconds".to_owned(), Value::from(second - 1));
            full_base.insert("elapsedSeconds".to_owned(), Value::from(second - 1));
            if second == 3 {
                set_test_item(&mut active_entities[1], "inputs", "iron_ore", 19.0);
                set_test_item(&mut full_entities[1], "inputs", "iron_ore", 19.0);
                directory.wake_from_stations(&[1]);
            }
            if second == 35 {
                set_test_item(&mut active_entities[5], "outputs", "iron_ingot", 0.0);
                set_test_item(&mut full_entities[5], "outputs", "iron_ingot", 0.0);
                directory.wake_from_stations(&[5]);
                set_test_network_item(&mut active_base, "iron_ingot", "31");
                set_test_network_item(&mut full_base, "iron_ingot", "31");
            }

            let bandwidth =
                directory.legacy_runtime_bandwidth(&state, &active_base, &active_entities);
            let flush_scan = flush_active_supply_buffers(
                &state,
                &mut active_base,
                &mut active_entities,
                &mut directory,
                &route_ledger,
                bandwidth,
                false,
            )
            .unwrap();
            flush_supply_buffers_for_index(&mut full_base, &mut full_entities, None).unwrap();
            assert_eq!(
                quantum_oracle_bytes(&active_base, &active_entities),
                quantum_oracle_bytes(&full_base, &full_entities),
                "flush second {second}"
            );
            if second == 2 {
                assert_eq!(
                    flush_scan.selected_rows, 0,
                    "quiescent flush must stay O(0)"
                );
            } else if matches!(second, 3 | 6) {
                assert_eq!(
                    flush_scan.selected_rows, 1,
                    "one station/item wake must visit one upload plan at second {second}"
                );
            }
            saw_sparse_flush |= flush_scan.selected_rows < flush_scan.total_rows;
            let _ = directory.take_inventory_written_station_indices();

            if second.is_multiple_of(5) {
                let (flow, download_scan) = settle_active_downloads(
                    &state,
                    &mut active_base,
                    &mut active_entities,
                    &credits,
                    second as f64,
                    5.0,
                    &mut directory,
                    &route_ledger,
                )
                .unwrap();
                settle_downloads(
                    &state,
                    &mut full_base,
                    &mut full_entities,
                    &credits,
                    second as f64,
                    5.0,
                )
                .unwrap();
                assert_eq!(
                    quantum_oracle_bytes(&active_base, &active_entities),
                    quantum_oracle_bytes(&full_base, &full_entities),
                    "download boundary {second}"
                );
                saw_sparse_download |= download_scan.selected_rows < download_scan.total_rows;
                if let Some(flow) = flow.as_ref() {
                    directory.wake_flush_from_downloads(flow);
                }
                let _ = directory.take_inventory_written_station_indices();
                let _ = directory.take_runtime_written_station_indices();
            }
            active_base.insert("elapsedSeconds".to_owned(), Value::from(second));
            full_base.insert("elapsedSeconds".to_owned(), Value::from(second));
        }
        assert!(saw_sparse_flush);
        assert!(saw_sparse_download);
    }

    #[test]
    fn opaque_fractional_routes_match_permissive_full_scan_reservations() {
        let routes = vec![
            serde_json::json!({
                "id": "opaque-a",
                "scope": "mod:wormhole",
                "peerId": "supply",
                "itemId": "iron_ore",
                "cargo": 0.6,
                "vehicleCount": 1,
                "progress": 0.25
            }),
            serde_json::json!({
                "id": "opaque-b",
                "peerId": "supply",
                "itemId": "iron_ore",
                "cargo": 0.6,
                "vehicleCount": 1,
                "progress": 0.5
            }),
        ];
        let source = vec![
            quantum_station("supply", "iron_ore", "supply", 0.0, 10.0, vec![]),
            quantum_station("demand", "iron_ore", "demand", 0.0, 0.0, routes),
        ];
        let state = crate::simple_factory::tests::fixture_state(&source);
        let local_directory = crate::local_logistics::LocalPeerDirectory::default();
        let remote_activity = crate::interstellar_logistics::prepare_route_activity(&source);
        assert_eq!(remote_activity.opaque_route_demand_indices(), &[1]);
        let route_ledger = crate::station_route_ledger::StationRouteLedger::build(
            &state,
            &source,
            &local_directory,
            &remote_activity,
        );
        assert_eq!(
            route_ledger
                .quantum_reserved_outgoing(0, "iron_ore")
                .to_bits(),
            1.2_f64.to_bits()
        );
        assert_eq!(
            route_ledger.quantum_in_flight(1, "iron_ore").to_bits(),
            1.2_f64.to_bits()
        );
        assert_eq!(route_ledger.interstellar_reserved(0, "iron_ore"), 0.0);

        let mut active_base = active_quantum_base(0);
        let mut full_base = active_base.clone();
        let mut active_entities = source.clone();
        let mut full_entities = source;
        let mut directory = QuantumLogisticsDirectory::build(&state, &active_entities);
        let bandwidth = directory.legacy_runtime_bandwidth(&state, &active_base, &active_entities);
        flush_active_supply_buffers(
            &state,
            &mut active_base,
            &mut active_entities,
            &mut directory,
            &route_ledger,
            bandwidth,
            false,
        )
        .unwrap();
        flush_supply_buffers_for_index(&mut full_base, &mut full_entities, None).unwrap();
        assert_eq!(
            quantum_oracle_bytes(&active_base, &active_entities),
            quantum_oracle_bytes(&full_base, &full_entities)
        );

        let credits = crate::belts::OutputCredits::default();
        settle_active_downloads(
            &state,
            &mut active_base,
            &mut active_entities,
            &credits,
            5.0,
            5.0,
            &mut directory,
            &route_ledger,
        )
        .unwrap();
        settle_downloads(
            &state,
            &mut full_base,
            &mut full_entities,
            &credits,
            5.0,
            5.0,
        )
        .unwrap();
        assert_eq!(
            quantum_oracle_bytes(&active_base, &active_entities),
            quantum_oracle_bytes(&full_base, &full_entities)
        );
    }

    #[test]
    fn directory_density_mod_and_exact_plan_mismatch_fail_closed() {
        let source = (0..4)
            .map(|index| {
                quantum_station(
                    format!("supply-{index}"),
                    "iron_ore",
                    "supply",
                    0.0,
                    0.0,
                    vec![],
                )
            })
            .collect::<Vec<_>>();
        let state = crate::simple_factory::tests::fixture_state(&source);
        let mut directory = QuantumLogisticsDirectory::build(&state, &source);
        directory.flush_all_pending = false;
        directory.pending_flush.extend([0, 1, 2]);
        let (selected, scan) = directory.selected_flush_plans(&state, &source, false);
        assert_eq!(selected.unwrap(), vec![0, 1, 2, 3]);
        assert!(scan.dense_fallback);
        assert!(!scan.directory_fallback);

        directory.pending_flush.clear();
        directory.pending_flush.insert(0);
        let mut mismatched = source.clone();
        mismatched[0]["stationSlots"][0]["priority"] = Value::from(7);
        let (selected, scan) = directory.selected_flush_plans(&state, &mismatched, false);
        assert!(selected.is_none());
        assert!(scan.directory_fallback);
        assert!(!directory.upload_index_matches(&mismatched));

        let mut mod_source = source;
        mod_source[0]["stationSlots"][0]["itemId"] = Value::from("mod:量子矿石/Ω");
        let mod_state = crate::simple_factory::tests::fixture_state(&mod_source);
        let mod_directory = QuantumLogisticsDirectory::build(&mod_state, &mod_source);
        let (selected, scan) = mod_directory.selected_flush_plans(&mod_state, &mod_source, false);
        assert!(selected.is_none());
        assert!(scan.directory_fallback);
    }

    #[test]
    fn same_boundary_upload_sync_is_idempotent_and_next_boundary_resets() {
        let mut returned = BoundaryFlow {
            boundary_second: 5.0,
            uploaded: BTreeMap::from([
                ("copper_ore".to_owned(), BigUint::from(2_u8)),
                ("iron_ore".to_owned(), BigUint::from(3_u8)),
            ]),
            ..BoundaryFlow::default()
        };
        let existing = BoundaryFlow {
            boundary_second: 5.0,
            uploaded: BTreeMap::from([
                ("coal".to_owned(), BigUint::from(7_u8)),
                ("iron_ore".to_owned(), BigUint::from(11_u8)),
            ]),
            ..BoundaryFlow::default()
        };

        synchronize_existing_boundary_uploads(&mut returned, Some(&existing));
        synchronize_existing_boundary_uploads(&mut returned, Some(&existing));
        assert_eq!(returned.uploaded["copper_ore"], BigUint::from(2_u8));
        assert_eq!(returned.uploaded["coal"], BigUint::from(7_u8));
        assert_eq!(returned.uploaded["iron_ore"], BigUint::from(11_u8));

        let mut next_boundary = BoundaryFlow {
            boundary_second: 10.0,
            ..BoundaryFlow::default()
        };
        synchronize_existing_boundary_uploads(&mut next_boundary, Some(&existing));
        assert!(next_boundary.uploaded.is_empty());
    }

    #[test]
    fn allocation_sort_does_not_change_multi_slot_last_transfer_order() {
        let mut requests = Vec::new();
        let mut positions = HashMap::new();
        for (key, item_id, amount) in [
            ("station:zinc", "zinc", 3_u64),
            ("station:aluminum", "aluminum", 7_u64),
        ] {
            upsert_request_in_stable_order(
                &mut requests,
                &mut positions,
                Request {
                    key: key.to_owned(),
                    entity_index: 0,
                    item_id: item_id.to_owned(),
                    amount: BigUint::from(amount),
                    priority: 1,
                },
            );
        }
        let mut allocation_requests = requests.clone();
        sorted_requests(&mut allocation_requests);
        assert_eq!(
            requests
                .iter()
                .map(|request| request.item_id.as_str())
                .collect::<Vec<_>>(),
            vec!["zinc", "aluminum"]
        );
        assert_eq!(
            allocation_requests
                .iter()
                .map(|request| request.item_id.as_str())
                .collect::<Vec<_>>(),
            vec!["aluminum", "zinc"]
        );

        let delivered = HashMap::from([
            ("station:zinc".to_owned(), BigUint::from(3_u8)),
            ("station:aluminum".to_owned(), BigUint::from(7_u8)),
        ]);
        let mut station = Map::from_iter([
            ("outputs".to_owned(), Value::Object(Map::new())),
            ("productionRate".to_owned(), Value::from(0)),
        ]);
        for request in &requests {
            let amount = delivered[&request.key].to_u64().unwrap() as f64;
            apply_quantum_download_to_station(&mut station, &request.item_id, amount, 5.0).unwrap();
        }
        assert_eq!(finite_number(station.get("stationLastTransfer")), 7.0);
        assert_eq!(item_amount(&station, "outputs", "zinc"), 3.0);
        assert_eq!(item_amount(&station, "outputs", "aluminum"), 7.0);
    }

    fn legacy_transition_routes(entities: &[Value], station_id: &str) -> Vec<TransitionRoute> {
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

    fn legacy_settle_transitions(
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
                let bridges = legacy_transition_routes(entities, &station_id)
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
            let Some(transition) = station.get("quantumTransition").and_then(Value::as_object)
            else {
                continue;
            };
            let station_id = string_at(station, "id").unwrap_or_default();
            let routes = legacy_transition_routes(&snapshots, station_id);
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

    fn transition_base(elapsed: f64) -> Map<String, Value> {
        serde_json::json!({
            "elapsedSeconds": elapsed,
            "research": { "completedTechIds": ["quantum_logistics_network"] },
            "quantumLogisticsNetwork": { "enabled": false },
        })
        .as_object()
        .expect("transition base")
        .clone()
    }

    fn transition_station(id: String, index: usize) -> Value {
        let peer = format!("transition-{:05}", (index + 1) % 4_096);
        let waypoint = format!("transition-{:05}", (index + 17) % 4_096);
        serde_json::json!({
            "id": id,
            "buildingId": "interstellar_logistics_station",
            "stationTier": 2,
            "quantumMode": "transitioning",
            "quantumTransition": {
                "targetMode": if index.is_multiple_of(7) { "legacy" } else { "quantum" },
                "startedAtSecond": 5,
                "boundarySecond": 20,
                "bridges": [],
            },
            "stationRoutes": [{
                "id": format!("route-{index:05}"),
                "scope": "remote",
                "peerId": peer,
                "itemId": if index.is_multiple_of(2) { "iron_ore" } else { "copper_ore" },
                "cargo": (index % 19) + 1,
                "duration": 15 + (index % 11),
                "progress": (index % 5) as f64 / 5.0,
                "waypointStationIds": [waypoint],
            }],
        })
    }

    fn transition_bytes(base: &Map<String, Value>, entities: &[Value]) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({
            "base": base,
            "entities": entities,
        }))
        .unwrap()
    }

    #[test]
    fn transition_route_index_and_parallel_patches_match_serial_oracle() {
        let base = transition_base(11.0);
        let entities = vec![
            serde_json::json!({
                "id": "planned-z",
                "buildingId": "interstellar_logistics_station",
                "stationTier": 2,
                "quantumMode": "legacy",
                "quantumTarget": true,
                "quantumTransition": null,
                "stationRoutes": [],
            }),
            serde_json::json!({
                "id": "demand",
                "stationRoutes": [{
                    "id": "route-planned",
                    "scope": "remote",
                    "peerId": "planned-z",
                    "vehicleStationId": "active-a",
                    "waypointStationIds": ["complete-c", "planned-z"],
                    "itemId": "iron_ore",
                    "cargo": 17,
                    "duration": 9,
                    "progress": 0.25,
                }],
            }),
            serde_json::json!({
                "id": "active-a",
                "buildingId": "interstellar_logistics_station",
                "stationTier": 2,
                "quantumMode": "transitioning",
                "quantumTransition": {
                    "targetMode": "legacy",
                    "startedAtSecond": 0,
                    "boundarySecond": 5,
                    "bridges": [{
                        "id": "quantum_bridge_route-planned",
                        "itemId": "iron_ore",
                        "sourceStationId": "planned-z",
                        "targetStationId": "demand",
                        "cargo": "17",
                        "remainingCargo": "17",
                        "arriveAtSecond": 20,
                    }],
                },
            }),
            serde_json::json!({
                "id": "complete-b",
                "buildingId": "interstellar_logistics_station",
                "stationTier": 2,
                "quantumMode": "transitioning",
                "quantumTransition": {
                    "targetMode": "quantum",
                    "startedAtSecond": 0,
                    "boundarySecond": 5,
                    "bridges": [],
                },
            }),
            Value::String("ignored".to_owned()),
        ];
        let mut expected_base = base.clone();
        let mut expected_entities = entities.clone();
        legacy_settle_transitions(&mut expected_base, &mut expected_entities).unwrap();

        let runtime = DeterministicRuntime::for_test(8);
        let mut actual_base = base;
        let mut actual_entities = entities;
        let diagnostics =
            settle_transitions_with_runtime(&runtime, &mut actual_base, &mut actual_entities)
                .unwrap();
        assert_eq!(actual_base, expected_base);
        assert_eq!(actual_entities, expected_entities);
        assert_eq!(
            transition_bytes(&actual_base, &actual_entities),
            transition_bytes(&expected_base, &expected_entities)
        );
        assert_eq!(diagnostics.entity_probe_count, 5);
        assert_eq!(diagnostics.transition_probe_count, 3);
        assert!(diagnostics.entity_probe_workers.is_empty());
        assert!(diagnostics.transition_probe_workers.is_empty());
    }

    #[test]
    fn transition_parallel_matrix_is_byte_identical_and_enters_rayon() {
        let entities = (0..4_096)
            .map(|index| transition_station(format!("transition-{index:05}"), index))
            .collect::<Vec<_>>();
        let base = transition_base(11.0);
        let mut expected_bytes = None;
        let mut expected_hash = None;
        for worker_limit in [1, 2, 4, 8] {
            let runtime = DeterministicRuntime::for_test(worker_limit);
            let mut candidate_base = base.clone();
            let mut candidate_entities = entities.clone();
            let diagnostics = settle_transitions_with_runtime(
                &runtime,
                &mut candidate_base,
                &mut candidate_entities,
            )
            .unwrap();
            let bytes = transition_bytes(&candidate_base, &candidate_entities);
            let hash = hex::encode(Sha256::digest(&bytes));
            if let Some(expected) = &expected_bytes {
                assert_eq!(&bytes, expected, "worker limit {worker_limit}");
                assert_eq!(Some(&hash), expected_hash.as_ref());
            } else {
                expected_hash = Some(hash.clone());
                expected_bytes = Some(bytes);
            }
            assert_eq!(diagnostics.entity_probe_count, 4_096);
            assert_eq!(diagnostics.transition_probe_count, 4_096);
            assert_eq!(diagnostics.route_membership_count, 12_288);
            if worker_limit == 1 {
                assert!(diagnostics.entity_probe_workers.is_empty());
                assert!(diagnostics.transition_probe_workers.is_empty());
            } else {
                assert!(!diagnostics.entity_probe_workers.is_empty());
                assert!(!diagnostics.transition_probe_workers.is_empty());
                assert!(
                    diagnostics
                        .entity_probe_workers
                        .iter()
                        .all(|index| *index < worker_limit)
                );
                assert!(
                    diagnostics
                        .transition_probe_workers
                        .iter()
                        .all(|index| *index < worker_limit)
                );
            }
        }
        assert_eq!(
            expected_hash.unwrap(),
            "fc4f4b31343179473d12f5ce92e22986101d1c351defc5c8a7053101b1bf993f"
        );
    }

    #[test]
    fn transition_parallel_errors_use_lowest_entity_and_leave_source_unchanged() {
        let mut entities = (0..4_096)
            .map(|index| {
                serde_json::json!({
                    "id": format!("transition-{index:05}"),
                    "buildingId": "interstellar_logistics_station",
                    "stationTier": 2,
                    "quantumMode": "transitioning",
                    "quantumTransition": {
                        "targetMode": "quantum",
                        "startedAtSecond": 0,
                        "boundarySecond": 20,
                        "bridges": [],
                    },
                })
            })
            .collect::<Vec<_>>();
        entities[117]["quantumTransition"]["bridges"] = serde_json::json!([7]);
        entities[2_913]["quantumTransition"]
            .as_object_mut()
            .unwrap()
            .remove("bridges");
        let mut base = transition_base(11.0);
        let source_base = base.clone();
        let source_entities = entities.clone();
        let source_bytes = transition_bytes(&base, &entities);
        let error = settle_transitions_with_runtime(
            &DeterministicRuntime::for_test(8),
            &mut base,
            &mut entities,
        )
        .unwrap_err();
        assert_eq!(
            error.to_string(),
            "native quantum transition bridge is invalid"
        );
        assert_eq!(base, source_base);
        assert_eq!(entities, source_entities);
        assert_eq!(transition_bytes(&base, &entities), source_bytes);
    }
}
