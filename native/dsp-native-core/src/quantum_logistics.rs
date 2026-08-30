#[cfg(test)]
use std::cell::Cell;
use std::cmp::Ordering;
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

#[cfg(test)]
thread_local! {
    static REQUEST_ORDER_COMPARISONS: Cell<usize> = const { Cell::new(0) };
    static RUNTIME_FLOW_PARSE_ROWS: Cell<usize> = const { Cell::new(0) };
}

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

    fn estimated_bytes(&self) -> usize {
        [&self.uploaded, &self.downloaded]
            .into_iter()
            .flat_map(|record| record.iter())
            .map(|(item_id, amount)| {
                // BTreeMap node links/color plus the owned key/value. This is
                // a conservative runtime diagnostic, not a persisted byte
                // contract; shared Arc headers are counted by the owner.
                size_of::<(String, BigUint)>()
                    + size_of::<usize>() * 4
                    + item_id.capacity()
                    + amount.bits().div_ceil(8) as usize
            })
            .sum()
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
const QUANTUM_PLAN_VALIDATION_ROWS_PER_CHUNK: usize = 1_024;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct QuantumActiveScan {
    pub selected_rows: usize,
    pub total_rows: usize,
    pub dense_fallback: bool,
    pub directory_fallback: bool,
    /// Requests ordered by the topology-bound rank table plus a linear merge.
    /// These counters are runtime-only diagnostics and never enter GameState.
    pub linear_order_rows: usize,
    pub full_sort_rows: usize,
    /// Network record rows inspected by the boundary parser. The sparse path
    /// probes only the exact inventory/capacity/cursor keys that the selected
    /// endpoint items can read or mutate; the compatibility oracle reports
    /// every persisted row here.
    pub network_parse_selected_rows: usize,
    pub network_parse_total_rows: usize,
    pub network_parse_full_scan_fallback: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct QuantumSlotContract {
    min_stock: u32,
    max_stock: u32,
    priority: i8,
}

impl QuantumSlotContract {
    fn from_slot(slot: &Slot) -> Option<Self> {
        Some(Self {
            min_stock: u32::try_from(slot.min_stock as u64).ok()?,
            max_stock: u32::try_from(slot.max_stock as u64).ok()?,
            priority: i8::try_from(slot.priority).ok()?,
        })
        .filter(|contract| {
            f64::from(contract.min_stock).to_bits() == slot.min_stock.to_bits()
                && f64::from(contract.max_stock).to_bits() == slot.max_stock.to_bits()
        })
    }

    fn matches(self, slot: &Slot) -> bool {
        Self::from_slot(slot) == Some(self)
    }
}

/// Compact immutable authority proof for one selected endpoint/item slot.
/// Entity IDs remain in CoreState's exact row arena and item IDs in the
/// directory's unique pool, so a large save does not allocate three strings
/// and two complete Slot values for every supply/demand plan.
#[derive(Debug, Clone, Copy)]
struct QuantumSlotPlan {
    entity_index: u32,
    item_index: u32,
    slot: QuantumSlotContract,
}

/// Only duplicate supply slots whose first match differs from the selected
/// highest-priority match need a second contract. Ordinary one-slot plans pay
/// no per-row cost for JavaScript's first-match flush rule.
#[derive(Debug, Clone, Copy)]
struct QuantumFlushOverride {
    plan_index: u32,
    slot: QuantumSlotContract,
}

#[derive(Debug, Clone, Copy)]
struct QuantumCollectorPlan {
    entity_index: u32,
    item_index: u32,
    continuously_productive: bool,
}

#[derive(Debug, Clone, Default)]
struct EntityPlanRanges {
    offsets: Vec<u32>,
}

impl EntityPlanRanges {
    fn build(entity_count: usize, plans: &[QuantumSlotPlan]) -> Option<Self> {
        let mut offsets = Vec::with_capacity(entity_count.checked_add(1)?);
        let mut plan_index = 0_usize;
        for entity_index in 0..entity_count {
            offsets.push(u32::try_from(plan_index).ok()?);
            while plans
                .get(plan_index)
                .is_some_and(|plan| plan.entity_index as usize == entity_index)
            {
                plan_index += 1;
            }
            if plans
                .get(plan_index)
                .is_some_and(|plan| (plan.entity_index as usize) < entity_index)
            {
                return None;
            }
        }
        offsets.push(u32::try_from(plan_index).ok()?);
        (plan_index == plans.len()).then_some(Self { offsets })
    }

    fn range(&self, entity_index: usize) -> std::ops::Range<usize> {
        self.offsets
            .get(entity_index..=entity_index.saturating_add(1))
            .filter(|range| range.len() == 2)
            .map_or(0..0, |range| range[0] as usize..range[1] as usize)
    }

    fn estimated_bytes(&self) -> u64 {
        (self.offsets.capacity() * size_of::<u32>()) as u64
    }
}

#[derive(Debug, Clone, Default)]
struct ItemPlanIndex {
    offsets: Vec<u32>,
    plan_indices: Vec<u32>,
}

impl ItemPlanIndex {
    fn build(item_count: usize, plan_items: impl Iterator<Item = u32>) -> Option<Self> {
        let mut buckets = vec![Vec::<u32>::new(); item_count];
        for (plan_index, item_index) in plan_items.enumerate() {
            buckets
                .get_mut(item_index as usize)?
                .push(u32::try_from(plan_index).ok()?);
        }
        let mut offsets = Vec::with_capacity(item_count.checked_add(1)?);
        let mut plan_indices = Vec::new();
        offsets.push(0);
        for bucket in buckets {
            plan_indices.extend(bucket);
            offsets.push(u32::try_from(plan_indices.len()).ok()?);
        }
        offsets.shrink_to_fit();
        plan_indices.shrink_to_fit();
        Some(Self {
            offsets,
            plan_indices,
        })
    }

    fn plans(&self, item_index: u32) -> &[u32] {
        self.offsets
            .get(item_index as usize..=item_index as usize + 1)
            .filter(|range| range.len() == 2)
            .map_or(&[], |range| {
                &self.plan_indices[range[0] as usize..range[1] as usize]
            })
    }

    fn estimated_bytes(&self) -> u64 {
        ((self.offsets.capacity() + self.plan_indices.capacity()) * size_of::<u32>()) as u64
    }
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
    catalog: Option<Arc<crate::catalog::RuntimeCatalog>>,
    entity_count: usize,
    endpoint_indices: Vec<usize>,
    item_ids: Vec<Arc<str>>,
    item_by_id: HashMap<Arc<str>, u32>,
    collector_plans: Vec<QuantumCollectorPlan>,
    upload_plans: Vec<QuantumSlotPlan>,
    download_plans: Vec<QuantumSlotPlan>,
    /// Inverse `(priority desc, request key asc)` ranks. The expensive sort is
    /// paid once when the immutable topology directory is built; each active
    /// boundary then orders only selected rows with four stable u32 radix
    /// passes. Full/dense/permissive scans retain the historical comparator.
    boundary_upload_order_rank: Vec<u32>,
    download_order_rank: Vec<u32>,
    upload_flush_overrides: Vec<QuantumFlushOverride>,
    upload_by_station: EntityPlanRanges,
    upload_by_item: ItemPlanIndex,
    collector_by_item: ItemPlanIndex,
    download_by_station: EntityPlanRanges,
    /// Construction centers are kept in the same exact entity-ID order used
    /// by the historical full scan. The reverse table is sorted by entity row
    /// so construction progress/power evidence can wake one center in O(log C).
    construction_center_indices: Vec<usize>,
    construction_row_by_entity: Vec<(u32, u32)>,
    pending_flush: BTreeSet<usize>,
    pending_download: BTreeSet<usize>,
    pending_construction_download: BTreeSet<usize>,
    pending_boundary_upload: BTreeSet<usize>,
    runtime_written_station_indices: BTreeSet<usize>,
    inventory_written_station_indices: BTreeSet<usize>,
    construction_inventory_written_center_indices: BTreeSet<usize>,
    flush_all_pending: bool,
    download_all_pending: bool,
    construction_download_all_pending: bool,
    boundary_upload_all_pending: bool,
    tower_stack_terms: Vec<f64>,
    tower_stacks: f64,
    collector_stacks: f64,
    cached_legacy_level_bits: Option<u64>,
    cached_legacy_bandwidth: RuntimeBandwidth,
    /// A runtime-only proof established by one complete parse of the exact
    /// network record owned by this directory revision. Retained simulation
    /// revisions only mutate that record through canonical encoders in this
    /// module (pure-idle additions are canonical too); commands and topology
    /// changes discard the directory. Record-length drift is checked in O(1)
    /// and re-enters the full oracle before any partial Network is mutated.
    network_sparse_proof: Option<NetworkSparseProof>,
    fallback_full_scan: bool,
    construction_fallback_full_scan: bool,
}

impl Default for QuantumLogisticsDirectory {
    fn default() -> Self {
        Self {
            topology: Arc::new(FactoryTopology::default()),
            catalog: None,
            entity_count: 0,
            endpoint_indices: Vec::new(),
            item_ids: Vec::new(),
            item_by_id: HashMap::new(),
            collector_plans: Vec::new(),
            upload_plans: Vec::new(),
            download_plans: Vec::new(),
            boundary_upload_order_rank: Vec::new(),
            download_order_rank: Vec::new(),
            upload_flush_overrides: Vec::new(),
            upload_by_station: EntityPlanRanges::default(),
            upload_by_item: ItemPlanIndex::default(),
            collector_by_item: ItemPlanIndex::default(),
            download_by_station: EntityPlanRanges::default(),
            construction_center_indices: Vec::new(),
            construction_row_by_entity: Vec::new(),
            pending_flush: BTreeSet::new(),
            pending_download: BTreeSet::new(),
            pending_construction_download: BTreeSet::new(),
            pending_boundary_upload: BTreeSet::new(),
            runtime_written_station_indices: BTreeSet::new(),
            inventory_written_station_indices: BTreeSet::new(),
            construction_inventory_written_center_indices: BTreeSet::new(),
            flush_all_pending: true,
            download_all_pending: true,
            construction_download_all_pending: true,
            boundary_upload_all_pending: true,
            tower_stack_terms: Vec::new(),
            tower_stacks: 0.0,
            collector_stacks: 0.0,
            cached_legacy_level_bits: None,
            cached_legacy_bandwidth: RuntimeBandwidth {
                per_minute: 0.0,
                tower_stacks: 0.0,
                collector_stacks: 0.0,
            },
            network_sparse_proof: None,
            fallback_full_scan: true,
            construction_fallback_full_scan: true,
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
    runtime_flow: Option<Arc<BoundaryFlow>>,
    /// The v47 JSON record was already in the exact shape emitted by the
    /// legacy full writer. Only that shape is eligible for in-place patches;
    /// legacy, malformed and extension-shaped records keep the old rewrite.
    /// A parsed Network is a synchronous, exclusive mutation session: no
    /// helper may edit the source JSON network between parse and write. A
    /// future interleaved owner must add a runtime generation token rather
    /// than re-hashing every inventory key at every boundary.
    sparse_write_compatible: bool,
    mutable_record_rows: usize,
    dirty_inventory: BTreeSet<String>,
    dirty_routing_cursors: BTreeSet<String>,
    dirty_upload_routing_cursors: BTreeSet<String>,
    runtime_flow_dirty: bool,
    /// Partial sessions contain only keys selected by a topology-proven
    /// active boundary (plus every known zero key required by legacy deposit
    /// normalization). Such a session may only use the in-place patch writer.
    partial: bool,
    /// Fractional permissive route cargo deliberately retains the historical
    /// complete rewrite even when the parsed record was canonical.
    force_full_write: bool,
}

#[derive(Debug, Clone, Default)]
struct NetworkSparseProof {
    inventory_rows: usize,
    item_capacity_rows: usize,
    routing_cursor_rows: usize,
    upload_routing_cursor_rows: usize,
    zero_inventory: HashSet<String>,
    /// Exact flow owned by the same runtime directory revision. Sparse
    /// boundaries share this immutable snapshot instead of reparsing and
    /// reallocating every dormant uploaded/downloaded item on every pass.
    runtime_flow: Option<Arc<BoundaryFlow>>,
}

impl NetworkSparseProof {
    fn mutable_rows(&self) -> usize {
        self.inventory_rows
            .saturating_add(self.routing_cursor_rows)
            .saturating_add(self.upload_routing_cursor_rows)
    }

    fn total_rows(&self) -> usize {
        self.mutable_rows().saturating_add(self.item_capacity_rows)
    }

    fn from_complete(network: &Network) -> Option<Self> {
        (!network.partial && network.sparse_write_compatible).then(|| Self {
            inventory_rows: network.inventory.len(),
            item_capacity_rows: network.item_capacities.len(),
            routing_cursor_rows: network.routing_cursors.len(),
            upload_routing_cursor_rows: network.upload_routing_cursors.len(),
            zero_inventory: network
                .inventory
                .iter()
                .filter_map(|(item_id, amount)| amount.is_zero().then_some(item_id.clone()))
                .collect(),
            runtime_flow: network.runtime_flow.clone(),
        })
    }

    fn from_complete_write(network: &Network) -> Option<Self> {
        (!network.partial).then(|| Self {
            inventory_rows: network.inventory.len(),
            item_capacity_rows: network.item_capacities.len(),
            routing_cursor_rows: network.routing_cursors.len(),
            upload_routing_cursor_rows: network.upload_routing_cursors.len(),
            zero_inventory: network
                .inventory
                .iter()
                .filter_map(|(item_id, amount)| amount.is_zero().then_some(item_id.clone()))
                .collect(),
            runtime_flow: network.runtime_flow.clone(),
        })
    }
}

#[derive(Debug, Clone, Default)]
struct NetworkItemSelection {
    inventory: HashSet<String>,
    item_capacities: HashSet<String>,
    routing_cursors: HashSet<String>,
    upload_routing_cursors: HashSet<String>,
    remove_zero_inventory: bool,
}

impl NetworkItemSelection {
    fn select_flush(&mut self, item_id: &str) {
        self.inventory.insert(item_id.to_owned());
        self.item_capacities.insert(item_id.to_owned());
        self.remove_zero_inventory = true;
    }

    fn select_download(&mut self, item_id: &str) {
        self.inventory.insert(item_id.to_owned());
        self.routing_cursors.insert(item_id.to_owned());
    }

    fn select_upload(&mut self, item_id: &str) {
        self.inventory.insert(item_id.to_owned());
        self.item_capacities.insert(item_id.to_owned());
        self.upload_routing_cursors.insert(item_id.to_owned());
    }

    fn with_known_zeros(&self, proof: &NetworkSparseProof) -> Self {
        let mut selected = self.clone();
        if selected.remove_zero_inventory {
            selected
                .inventory
                .extend(proof.zero_inventory.iter().cloned());
        }
        selected
    }

    fn selected_rows(&self) -> usize {
        self.inventory
            .len()
            .saturating_add(self.item_capacities.len())
            .saturating_add(self.routing_cursors.len())
            .saturating_add(self.upload_routing_cursors.len())
    }

    fn potential_dirty_rows(&self) -> usize {
        self.inventory
            .len()
            .saturating_add(self.routing_cursors.len())
            .saturating_add(self.upload_routing_cursors.len())
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct NetworkParseScan {
    selected_rows: usize,
    total_rows: usize,
    full_scan_fallback: bool,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct NetworkWriteScan {
    dirty_rows: usize,
    total_rows: usize,
    dense_fallback: bool,
    signature_fallback: bool,
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

impl From<&crate::station_route_ledger::RemoteTransitionRoute> for TransitionRoute {
    fn from(route: &crate::station_route_ledger::RemoteTransitionRoute) -> Self {
        Self {
            demand_id: route.demand_id.clone(),
            route_id: route.route_id.clone(),
            item_id: route.item_id.clone(),
            peer_id: route.peer_id.clone(),
            cargo: decimal(&BigUint::from(route.cargo)),
            duration: route.duration,
            progress: route.progress,
        }
    }
}

const TRANSITION_DENSE_NUMERATOR: usize = 3;
const TRANSITION_DENSE_DENOMINATOR: usize = 4;

/// Runtime-only persisted-order active index for quantum attachment/mode
/// transitions. Commands and topology rebuilds discard it; simulation clones
/// it transactionally and installs the next value only after revision commit.
#[derive(Debug, Clone, Default)]
pub(crate) struct QuantumTransitionRuntime {
    entity_count: usize,
    active_entity_indices: Vec<usize>,
    fallback_full_scan: bool,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct QuantumTransitionScan {
    pub selected_rows: usize,
    pub total_rows: usize,
    pub transition_rows: usize,
    pub route_membership_rows: usize,
    pub route_validation_rows: usize,
    pub route_rebuild_rows: usize,
    pub dense_fallback: bool,
    pub runtime_fallback: bool,
    pub ledger_fallback: bool,
}

fn transition_candidate_marker(entity: &Map<String, Value>) -> bool {
    entity
        .get("quantumTransition")
        .and_then(Value::as_object)
        .is_some()
        || entity.get("quantumTarget").and_then(Value::as_bool) == Some(true)
}

fn transition_candidate_domain_supported(entity: &Map<String, Value>) -> bool {
    match string_at(entity, "buildingId") {
        Some("interstellar_logistics_station") => true,
        Some("orbital_collector") => entity
            .get("quantumTransition")
            .and_then(Value::as_object)
            .is_some(),
        _ => false,
    }
}

impl QuantumTransitionRuntime {
    pub(crate) fn build(entities: &[Value]) -> Self {
        let mut active_entity_indices = Vec::new();
        let mut fallback_full_scan = false;
        for (entity_index, entity) in entities.iter().enumerate() {
            let Some(entity) = entity.as_object() else {
                continue;
            };
            let marker = transition_candidate_marker(entity);
            if marker {
                active_entity_indices.push(entity_index);
                fallback_full_scan |= !transition_candidate_domain_supported(entity);
            }
            fallback_full_scan |= entity
                .get("quantumTransition")
                .is_some_and(|value| !value.is_null() && !value.is_object());
            fallback_full_scan |= entity
                .get("quantumTarget")
                .is_some_and(|value| !value.is_boolean());
        }
        Self {
            entity_count: entities.len(),
            active_entity_indices,
            fallback_full_scan,
        }
    }

    pub(crate) fn estimated_bytes(&self) -> u64 {
        (std::mem::size_of::<Self>()
            + self.active_entity_indices.capacity() * std::mem::size_of::<usize>()) as u64
    }

    fn scan_indices(&self, entities: &[Value]) -> (Option<Vec<usize>>, QuantumTransitionScan) {
        let runtime_fallback = self.fallback_full_scan
            || self.entity_count != entities.len()
            || self
                .active_entity_indices
                .windows(2)
                .any(|pair| pair[0] >= pair[1])
            || self.active_entity_indices.iter().any(|&index| {
                entities
                    .get(index)
                    .and_then(Value::as_object)
                    .is_none_or(|entity| {
                        !transition_candidate_marker(entity)
                            || !transition_candidate_domain_supported(entity)
                    })
            });
        let dense_fallback = !runtime_fallback
            && !self.active_entity_indices.is_empty()
            && self
                .active_entity_indices
                .len()
                .saturating_mul(TRANSITION_DENSE_DENOMINATOR)
                >= entities.len().saturating_mul(TRANSITION_DENSE_NUMERATOR);
        let full_scan = runtime_fallback || dense_fallback;
        (
            (!full_scan).then(|| self.active_entity_indices.clone()),
            QuantumTransitionScan {
                selected_rows: if full_scan {
                    entities.len()
                } else {
                    self.active_entity_indices.len()
                },
                total_rows: entities.len(),
                dense_fallback,
                runtime_fallback,
                ..QuantumTransitionScan::default()
            },
        )
    }

    fn refresh_after_sparse_settlement(&mut self, entities: &[Value]) {
        self.active_entity_indices.retain(|&index| {
            entities
                .get(index)
                .and_then(Value::as_object)
                .is_some_and(transition_candidate_marker)
        });
    }

    #[cfg(test)]
    pub(crate) fn active_row_count(&self) -> usize {
        self.active_entity_indices.len()
    }
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

impl Network {
    fn set_inventory_amount(&mut self, item_id: &str, amount: BigUint) {
        if self.inventory.get(item_id) == Some(&amount) {
            return;
        }
        set_biguint_amount(&mut self.inventory, item_id, amount);
        self.dirty_inventory.insert(item_id.to_owned());
    }

    fn remove_zero_inventory(&mut self) {
        let zero_items = self
            .inventory
            .iter()
            .filter_map(|(item_id, amount)| amount.is_zero().then_some(item_id.clone()))
            .collect::<Vec<_>>();
        for item_id in zero_items {
            self.inventory.remove(&item_id);
            self.dirty_inventory.insert(item_id);
        }
    }

    fn advance_routing_cursor(&mut self, item_id: &str) {
        advance_routing_cursor(&mut self.routing_cursors, item_id);
        self.dirty_routing_cursors.insert(item_id.to_owned());
    }

    fn advance_upload_routing_cursor(&mut self, item_id: &str) {
        advance_routing_cursor(&mut self.upload_routing_cursors, item_id);
        self.dirty_upload_routing_cursors.insert(item_id.to_owned());
    }

    fn set_runtime_flow(&mut self, flow: BoundaryFlow) {
        self.runtime_flow = Some(Arc::new(flow));
        self.runtime_flow_dirty = true;
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
    #[cfg(test)]
    RUNTIME_FLOW_PARSE_ROWS.with(|counter| {
        let rows = flow
            .get("uploaded")
            .and_then(Value::as_object)
            .map_or(0, Map::len)
            .saturating_add(
                flow.get("downloaded")
                    .and_then(Value::as_object)
                    .map_or(0, Map::len),
            );
        counter.set(counter.get().saturating_add(rows));
    });
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

#[cfg(test)]
fn take_runtime_flow_parse_rows() -> usize {
    RUNTIME_FLOW_PARSE_ROWS.with(|counter| {
        let rows = counter.get();
        counter.set(0);
        rows
    })
}

fn canonical_decimal_text(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_INTEGER_DIGITS
        && value.bytes().all(|byte| byte.is_ascii_digit())
        && (value == "0" || !value.starts_with('0'))
}

fn canonical_capacity_text(value: &str) -> bool {
    canonical_decimal_text(value)
        && (value.len() > 5 || (value.len() == 5 && value >= "10000"))
        && (value.len() < 11 || (value.len() == 11 && value <= "10000000000"))
}

fn canonical_quantity_record_matches(
    raw: Option<&Value>,
    parsed: &BTreeMap<String, BigUint>,
    capacities: bool,
) -> bool {
    let Some(raw) = raw.and_then(Value::as_object) else {
        return false;
    };
    raw.len() == parsed.len()
        && raw.iter().all(|(item_id, value)| {
            parsed.contains_key(item_id)
                && value.as_str().is_some_and(|value| {
                    if capacities {
                        canonical_capacity_text(value)
                    } else {
                        canonical_decimal_text(value)
                    }
                })
        })
}

fn canonical_cursor_record_matches(raw: Option<&Value>, parsed: &BTreeMap<String, u64>) -> bool {
    let Some(raw) = raw.and_then(Value::as_object) else {
        return false;
    };
    raw.len() == parsed.len()
        && parsed
            .iter()
            .all(|(item_id, cursor)| raw.get(item_id) == Some(&Value::from(*cursor)))
}

fn canonical_f64_matches(raw: Option<&Value>, value: f64) -> bool {
    Number::from_f64(value).is_some_and(|number| raw == Some(&Value::Number(number)))
}

fn canonical_flow_matches(raw: Option<&Value>, flow: &BoundaryFlow) -> bool {
    let Some(raw) = raw.and_then(Value::as_object) else {
        return false;
    };
    raw.len() == 7
        && canonical_f64_matches(raw.get("boundarySecond"), flow.boundary_second)
        && canonical_quantity_record_matches(raw.get("uploaded"), &flow.uploaded, false)
        && canonical_quantity_record_matches(raw.get("downloaded"), &flow.downloaded, false)
        && canonical_f64_matches(
            raw.get("globalUploadPerMinute"),
            flow.global_upload_per_minute,
        )
        && canonical_f64_matches(
            raw.get("globalDownloadPerMinute"),
            flow.global_download_per_minute,
        )
        && canonical_f64_matches(raw.get("quantumTowerStacks"), flow.quantum_tower_stacks)
        && canonical_f64_matches(
            raw.get("quantumCollectorStacks"),
            flow.quantum_collector_stacks,
        )
}

fn canonical_network_record_matches(raw: &Map<String, Value>, network: &Network) -> bool {
    let expected_fields = 5 + usize::from(network.runtime_flow.is_some());
    raw.len() == expected_fields
        && raw.get("enabled") == Some(&Value::Bool(network.enabled))
        && canonical_quantity_record_matches(raw.get("inventory"), &network.inventory, false)
        && canonical_quantity_record_matches(
            raw.get("itemCapacities"),
            &network.item_capacities,
            true,
        )
        && canonical_cursor_record_matches(raw.get("routingCursors"), &network.routing_cursors)
        && canonical_cursor_record_matches(
            raw.get("uploadRoutingCursors"),
            &network.upload_routing_cursors,
        )
        && match (network.runtime_flow.as_deref(), raw.get("runtimeFlow")) {
            (None, None) => true,
            (Some(flow), raw_flow) => canonical_flow_matches(raw_flow, flow),
            _ => false,
        }
}

fn network_enabled(base: &Map<String, Value>) -> anyhow::Result<bool> {
    base.get("quantumLogisticsNetwork")
        .and_then(Value::as_object)
        .map(|raw| raw.get("enabled").and_then(Value::as_bool) == Some(true))
        .ok_or_else(|| anyhow!("native quantum logistics network is missing"))
}

fn raw_network_record_rows(base: &Map<String, Value>) -> usize {
    base.get("quantumLogisticsNetwork")
        .and_then(Value::as_object)
        .map(|raw| {
            [
                "inventory",
                "itemCapacities",
                "routingCursors",
                "uploadRoutingCursors",
            ]
            .into_iter()
            .filter_map(|field| raw.get(field).and_then(Value::as_object))
            .map(Map::len)
            .fold(0_usize, usize::saturating_add)
        })
        .unwrap_or(0)
}

fn canonical_selected_quantity_record(
    raw: &Map<String, Value>,
    selected: &HashSet<String>,
    capacities: bool,
) -> Option<BTreeMap<String, BigUint>> {
    let mut parsed = BTreeMap::new();
    for item_id in selected {
        let Some(value) = raw.get(item_id) else {
            continue;
        };
        let text = value.as_str()?;
        let canonical = if capacities {
            canonical_capacity_text(text)
        } else {
            canonical_decimal_text(text)
        };
        if !canonical {
            return None;
        }
        parsed.insert(item_id.clone(), BigUint::parse_bytes(text.as_bytes(), 10)?);
    }
    Some(parsed)
}

fn canonical_selected_cursor_record(
    raw: &Map<String, Value>,
    selected: &HashSet<String>,
) -> Option<BTreeMap<String, u64>> {
    let mut parsed = BTreeMap::new();
    for item_id in selected {
        let Some(value) = raw.get(item_id) else {
            continue;
        };
        let cursor = value
            .as_u64()
            .filter(|cursor| *cursor <= MAX_SAFE_INTEGER)?;
        if value != &Value::from(cursor) {
            return None;
        }
        parsed.insert(item_id.clone(), cursor);
    }
    Some(parsed)
}

fn sparse_network_header(
    raw: &Map<String, Value>,
    proof: &NetworkSparseProof,
) -> Option<(bool, Option<Arc<BoundaryFlow>>)> {
    let inventory = raw.get("inventory")?.as_object()?;
    let item_capacities = raw.get("itemCapacities")?.as_object()?;
    let routing_cursors = raw.get("routingCursors")?.as_object()?;
    let upload_routing_cursors = raw.get("uploadRoutingCursors")?.as_object()?;
    if inventory.len() != proof.inventory_rows
        || item_capacities.len() != proof.item_capacity_rows
        || routing_cursors.len() != proof.routing_cursor_rows
        || upload_routing_cursors.len() != proof.upload_routing_cursor_rows
    {
        return None;
    }
    let enabled = raw.get("enabled")?.as_bool()?;
    let runtime_flow = match (raw.get("runtimeFlow"), proof.runtime_flow.as_ref()) {
        (Some(raw_flow), Some(flow)) if cached_runtime_flow_shape_matches(raw_flow, flow) => {
            Some(Arc::clone(flow))
        }
        (None, None) => None,
        _ => return None,
    };
    (raw.len() == 5 + usize::from(runtime_flow.is_some())).then_some((enabled, runtime_flow))
}

fn cached_runtime_flow_shape_matches(raw: &Value, cached: &BoundaryFlow) -> bool {
    let Some(raw) = raw.as_object() else {
        return false;
    };
    let scalar_matches = |key: &str, expected: f64| canonical_f64_matches(raw.get(key), expected);
    raw.len() == 7
        && raw
            .get("uploaded")
            .and_then(Value::as_object)
            .is_some_and(|values| values.len() == cached.uploaded.len())
        && raw
            .get("downloaded")
            .and_then(Value::as_object)
            .is_some_and(|values| values.len() == cached.downloaded.len())
        && scalar_matches("boundarySecond", cached.boundary_second)
        && scalar_matches("globalUploadPerMinute", cached.global_upload_per_minute)
        && scalar_matches("globalDownloadPerMinute", cached.global_download_per_minute)
        && scalar_matches("quantumTowerStacks", cached.quantum_tower_stacks)
        && scalar_matches("quantumCollectorStacks", cached.quantum_collector_stacks)
}

fn parse_sparse_network(
    base: &Map<String, Value>,
    selection: &NetworkItemSelection,
    proof: &NetworkSparseProof,
) -> Option<Network> {
    let raw = base.get("quantumLogisticsNetwork")?.as_object()?;
    let (enabled, runtime_flow) = sparse_network_header(raw, proof)?;
    let inventory = canonical_selected_quantity_record(
        raw.get("inventory")?.as_object()?,
        &selection.inventory,
        false,
    )?;
    let item_capacities = canonical_selected_quantity_record(
        raw.get("itemCapacities")?.as_object()?,
        &selection.item_capacities,
        true,
    )?;
    let routing_cursors = canonical_selected_cursor_record(
        raw.get("routingCursors")?.as_object()?,
        &selection.routing_cursors,
    )?;
    let upload_routing_cursors = canonical_selected_cursor_record(
        raw.get("uploadRoutingCursors")?.as_object()?,
        &selection.upload_routing_cursors,
    )?;
    Some(Network {
        enabled,
        inventory,
        item_capacities,
        routing_cursors,
        upload_routing_cursors,
        runtime_flow,
        sparse_write_compatible: true,
        mutable_record_rows: proof.mutable_rows(),
        partial: true,
        ..Network::default()
    })
}

fn parse_active_network(
    base: &Map<String, Value>,
    selection: &NetworkItemSelection,
    directory: &mut QuantumLogisticsDirectory,
    force_full_scan: bool,
    force_full_write: bool,
) -> anyhow::Result<(Network, NetworkParseScan)> {
    if !force_full_scan && let Some(proof) = directory.network_sparse_proof.as_ref() {
        let selection = selection.with_known_zeros(proof);
        let potential_dirty_rows = selection.potential_dirty_rows();
        let mutable_rows = proof.mutable_rows();
        let dense = potential_dirty_rows > 0
            && (mutable_rows == 0
                || potential_dirty_rows.saturating_mul(QUANTUM_ACTIVE_DENSE_DENOMINATOR)
                    >= mutable_rows.saturating_mul(QUANTUM_ACTIVE_DENSE_NUMERATOR));
        if !dense && let Some(network) = parse_sparse_network(base, &selection, proof) {
            return Ok((
                network,
                NetworkParseScan {
                    selected_rows: selection.selected_rows(),
                    total_rows: proof.total_rows(),
                    full_scan_fallback: false,
                },
            ));
        }
    }

    let mut network = parse_network(base)?;
    network.force_full_write = force_full_write;
    let total_rows = raw_network_record_rows(base);
    directory.network_sparse_proof = NetworkSparseProof::from_complete(&network);
    Ok((
        network,
        NetworkParseScan {
            selected_rows: total_rows,
            total_rows,
            full_scan_fallback: true,
        },
    ))
}

fn apply_network_parse_scan(scan: &mut QuantumActiveScan, network_scan: NetworkParseScan) {
    scan.network_parse_selected_rows = network_scan.selected_rows;
    scan.network_parse_total_rows = network_scan.total_rows;
    scan.network_parse_full_scan_fallback = network_scan.full_scan_fallback;
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
    let inventory = parse_quantity_record(raw.get("inventory"), false);
    let routing_cursors = parse_cursor_record(raw.get("routingCursors"));
    let upload_routing_cursors = parse_cursor_record(raw.get("uploadRoutingCursors"));
    let runtime_flow = parse_flow(raw.get("runtimeFlow")).map(Arc::new);
    let mutable_record_rows = inventory
        .len()
        .saturating_add(routing_cursors.len())
        .saturating_add(upload_routing_cursors.len());
    let mut network = Network {
        enabled: raw.get("enabled").and_then(Value::as_bool) == Some(true),
        inventory,
        item_capacities: capacities,
        routing_cursors,
        upload_routing_cursors,
        runtime_flow,
        mutable_record_rows,
        ..Network::default()
    };
    network.sparse_write_compatible = canonical_network_record_matches(raw, &network);
    Ok(network)
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

fn write_network_full(base: &mut Map<String, Value>, network: &Network) -> anyhow::Result<()> {
    if network.partial {
        return Err(anyhow!(
            "native partial quantum network cannot use the full writer"
        ));
    }
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

fn patch_quantity_record(
    raw: &mut Map<String, Value>,
    values: &BTreeMap<String, BigUint>,
    dirty: &BTreeSet<String>,
) {
    for item_id in dirty {
        if let Some(amount) = values.get(item_id) {
            let next = Value::String(decimal(amount));
            if let Some(current) = raw.get_mut(item_id) {
                *current = next;
            } else {
                raw.insert(item_id.clone(), next);
            }
        } else {
            raw.remove(item_id);
        }
    }
}

fn patch_cursor_record(
    raw: &mut Map<String, Value>,
    values: &BTreeMap<String, u64>,
    dirty: &BTreeSet<String>,
) {
    for item_id in dirty {
        if let Some(cursor) = values.get(item_id) {
            let next = Value::from(*cursor);
            if let Some(current) = raw.get_mut(item_id) {
                *current = next;
            } else {
                raw.insert(item_id.clone(), next);
            }
        } else {
            raw.remove(item_id);
        }
    }
}

fn write_network_with_scan(
    base: &mut Map<String, Value>,
    network: &Network,
) -> anyhow::Result<NetworkWriteScan> {
    let dirty_rows = network
        .dirty_inventory
        .len()
        .saturating_add(network.dirty_routing_cursors.len())
        .saturating_add(network.dirty_upload_routing_cursors.len());
    let dense_fallback = network.force_full_write
        || (dirty_rows > 0
            && dirty_rows.saturating_mul(QUANTUM_ACTIVE_DENSE_DENOMINATOR)
                >= network
                    .mutable_record_rows
                    .saturating_mul(QUANTUM_ACTIVE_DENSE_NUMERATOR));
    let sparse_shape_present = base
        .get("quantumLogisticsNetwork")
        .and_then(Value::as_object)
        .is_some_and(|raw| {
            raw.get("inventory").and_then(Value::as_object).is_some()
                && raw
                    .get("routingCursors")
                    .and_then(Value::as_object)
                    .is_some()
                && raw
                    .get("uploadRoutingCursors")
                    .and_then(Value::as_object)
                    .is_some()
        });
    let signature_fallback = !network.sparse_write_compatible || !sparse_shape_present;
    let scan = NetworkWriteScan {
        dirty_rows,
        total_rows: network.mutable_record_rows,
        dense_fallback,
        signature_fallback,
    };
    if dense_fallback || signature_fallback {
        if network.partial {
            return Err(anyhow!(
                "native partial quantum network lost its sparse-write proof"
            ));
        }
        write_network_full(base, network)?;
        return Ok(scan);
    }

    // Preserve the full writer's failure atomicity: serialize every fallible
    // value before borrowing and patching the authoritative base record.
    let runtime_flow_patch = if network.runtime_flow_dirty {
        Some(
            network
                .runtime_flow
                .as_deref()
                .map(flow_value)
                .transpose()?,
        )
    } else {
        None
    };

    let raw = base
        .get_mut("quantumLogisticsNetwork")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| anyhow!("native quantum logistics network is missing"))?;
    patch_quantity_record(
        raw.get_mut("inventory")
            .and_then(Value::as_object_mut)
            .ok_or_else(|| anyhow!("native quantum logistics inventory is missing"))?,
        &network.inventory,
        &network.dirty_inventory,
    );
    patch_cursor_record(
        raw.get_mut("routingCursors")
            .and_then(Value::as_object_mut)
            .ok_or_else(|| anyhow!("native quantum logistics routing cursors are missing"))?,
        &network.routing_cursors,
        &network.dirty_routing_cursors,
    );
    patch_cursor_record(
        raw.get_mut("uploadRoutingCursors")
            .and_then(Value::as_object_mut)
            .ok_or_else(|| {
                anyhow!("native quantum logistics upload routing cursors are missing")
            })?,
        &network.upload_routing_cursors,
        &network.dirty_upload_routing_cursors,
    );
    if let Some(runtime_flow) = runtime_flow_patch {
        if let Some(flow) = runtime_flow {
            raw.insert("runtimeFlow".to_owned(), flow);
        } else {
            raw.remove("runtimeFlow");
        }
    }
    Ok(scan)
}

fn write_network(base: &mut Map<String, Value>, network: &Network) -> anyhow::Result<()> {
    write_network_with_scan(base, network).map(|_| ())
}

fn update_network_sparse_proof_after_write(
    base: &Map<String, Value>,
    network: &Network,
    directory: &mut QuantumLogisticsDirectory,
) {
    if !network.partial {
        directory.network_sparse_proof = NetworkSparseProof::from_complete_write(network);
        return;
    }
    // Move the proof out while updating it. Cloning here made every sparse
    // write O(number of historically zero inventory keys), even when only one
    // active item changed.
    let Some(mut proof) = directory.network_sparse_proof.take() else {
        return;
    };
    let Some(raw) = base
        .get("quantumLogisticsNetwork")
        .and_then(Value::as_object)
    else {
        directory.network_sparse_proof = None;
        return;
    };
    let Some(inventory) = raw.get("inventory").and_then(Value::as_object) else {
        directory.network_sparse_proof = None;
        return;
    };
    let Some(item_capacities) = raw.get("itemCapacities").and_then(Value::as_object) else {
        directory.network_sparse_proof = None;
        return;
    };
    let Some(routing_cursors) = raw.get("routingCursors").and_then(Value::as_object) else {
        directory.network_sparse_proof = None;
        return;
    };
    let Some(upload_routing_cursors) = raw.get("uploadRoutingCursors").and_then(Value::as_object)
    else {
        directory.network_sparse_proof = None;
        return;
    };
    proof.inventory_rows = inventory.len();
    proof.item_capacity_rows = item_capacities.len();
    proof.routing_cursor_rows = routing_cursors.len();
    proof.upload_routing_cursor_rows = upload_routing_cursors.len();
    for (item_id, amount) in &network.inventory {
        if amount.is_zero() {
            proof.zero_inventory.insert(item_id.clone());
        } else {
            proof.zero_inventory.remove(item_id);
        }
    }
    for item_id in &network.dirty_inventory {
        if !network.inventory.contains_key(item_id) {
            proof.zero_inventory.remove(item_id);
        }
    }
    proof.runtime_flow = network.runtime_flow.clone();
    directory.network_sparse_proof = sparse_network_header(raw, &proof).map(|_| proof);
}

fn refresh_network_sparse_proof(
    base: &Map<String, Value>,
    directory: &mut QuantumLogisticsDirectory,
) -> anyhow::Result<()> {
    let network = parse_network(base)?;
    directory.network_sparse_proof = NetworkSparseProof::from_complete(&network);
    Ok(())
}

fn write_active_network(
    base: &mut Map<String, Value>,
    network: &Network,
    directory: &mut QuantumLogisticsDirectory,
) -> anyhow::Result<NetworkWriteScan> {
    let scan = write_network_with_scan(base, network)?;
    update_network_sparse_proof_after_write(base, network, directory);
    Ok(scan)
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

fn intern_quantum_item(
    item_ids: &mut Vec<Arc<str>>,
    item_by_id: &mut HashMap<Arc<str>, u32>,
    item_id: &str,
) -> Option<u32> {
    if let Some(index) = item_by_id.get(item_id) {
        return Some(*index);
    }
    let index = u32::try_from(item_ids.len()).ok()?;
    let owned = Arc::<str>::from(item_id);
    item_ids.push(Arc::clone(&owned));
    item_by_id.insert(owned, index);
    Some(index)
}

fn upsert_slot_plan(
    plans: &mut Vec<QuantumSlotPlan>,
    positions: &mut HashMap<(u32, u32), usize>,
    plan: QuantumSlotPlan,
) -> Option<(usize, QuantumSlotContract)> {
    let key = (plan.entity_index, plan.item_index);
    if let Some(&position) = positions.get(&key) {
        let first_slot = plans[position].slot;
        if plan.slot.priority > plans[position].slot.priority {
            plans[position].slot = plan.slot;
            return Some((position, first_slot));
        }
    } else {
        positions.insert(key, plans.len());
        plans.push(plan);
    }
    None
}

fn build_request_order_rank(
    mut entries: Vec<(usize, i64, String)>,
    total_rows: usize,
) -> Option<Vec<u32>> {
    if entries.len() != total_rows || total_rows > u32::MAX as usize {
        return None;
    }
    {
        let mut keys = HashSet::with_capacity(entries.len());
        if entries.iter().any(|(_, _, key)| !keys.insert(key.as_str())) {
            // The legacy collector keeps the first request position and only
            // replaces it for a strictly higher priority. A duplicate key is
            // therefore not eligible for the pre-ranked unique-plan stream.
            return None;
        }
    }
    entries.sort_by(|left, right| right.1.cmp(&left.1).then_with(|| left.2.cmp(&right.2)));
    let mut ranks = vec![u32::MAX; total_rows];
    for (rank, (row, _, _)) in entries.into_iter().enumerate() {
        let slot = ranks.get_mut(row)?;
        if *slot != u32::MAX {
            return None;
        }
        *slot = u32::try_from(rank).ok()?;
    }
    ranks.iter().all(|rank| *rank != u32::MAX).then_some(ranks)
}

fn first_invalid_selected_plan_with_runtime(
    selected: &[usize],
    runtime: &DeterministicRuntime,
    is_valid: &(dyn Fn(usize) -> bool + Sync),
) -> Option<usize> {
    if runtime.worker_count_for_items(selected.len()) == 1 {
        return selected.iter().copied().find(|&index| !is_valid(index));
    }

    // Every worker owns a fixed ascending slice and returns at most its first
    // invalid plan. Ordered chunk collection makes scheduling unobservable:
    // the coordinator still selects the earliest invalid persisted plan.
    runtime
        .ordered_chunk_map(
            selected.len(),
            QUANTUM_PLAN_VALIDATION_ROWS_PER_CHUNK,
            |_, range| {
                range
                    .map(|selected_index| selected[selected_index])
                    .find(|&plan_index| !is_valid(plan_index))
            },
        )
        .into_iter()
        .flatten()
        .next()
}

impl QuantumLogisticsDirectory {
    pub(crate) fn build(state: &CoreState, entities: &[Value]) -> Self {
        let mut directory = Self {
            topology: Arc::clone(&state.factory_topology),
            catalog: Some(Arc::clone(&state.catalog)),
            entity_count: entities.len(),
            fallback_full_scan: state.factory_topology.quantum_endpoint_full_scan_required,
            construction_fallback_full_scan: false,
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
            let Some(compact_entity_index) = u32::try_from(entity_index).ok() else {
                directory.fallback_full_scan = true;
                continue;
            };
            let collector = is_quantum_collector(endpoint);
            directory.endpoint_indices.push(entity_index);
            let stacks = finite_number(endpoint.get("machineCount")).floor().max(0.0);
            if collector {
                directory.collector_stacks += stacks;
                let Some(item_id) = string_at(endpoint, "storedItemId").filter(|id| !id.is_empty())
                else {
                    directory.fallback_full_scan = true;
                    continue;
                };
                if !item_id.is_ascii()
                    || item_id.contains(':')
                    || !state.catalog.items.contains_key(item_id)
                {
                    directory.fallback_full_scan = true;
                }
                let Some(item_index) = intern_quantum_item(
                    &mut directory.item_ids,
                    &mut directory.item_by_id,
                    item_id,
                ) else {
                    directory.fallback_full_scan = true;
                    continue;
                };
                directory.collector_plans.push(QuantumCollectorPlan {
                    entity_index: compact_entity_index,
                    item_index,
                    continuously_productive: finite_number(endpoint.get("machineCount")) > 0.0,
                });
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
                if !item_id.is_ascii()
                    || item_id.contains(':')
                    || !state.catalog.items.contains_key(item_id)
                {
                    directory.fallback_full_scan = true;
                }
                let Some(item_index) = intern_quantum_item(
                    &mut directory.item_ids,
                    &mut directory.item_by_id,
                    item_id,
                ) else {
                    directory.fallback_full_scan = true;
                    continue;
                };
                let Some(slot_contract) = QuantumSlotContract::from_slot(&slot) else {
                    directory.fallback_full_scan = true;
                    continue;
                };
                let key = (compact_entity_index, item_index);
                match slot.remote_mode.as_str() {
                    "supply" => {
                        if upload_positions.contains_key(&key) {
                            directory.fallback_full_scan = true;
                        }
                        if let Some((plan_index, first_slot)) = upsert_slot_plan(
                            &mut directory.upload_plans,
                            &mut upload_positions,
                            QuantumSlotPlan {
                                entity_index: compact_entity_index,
                                item_index,
                                slot: slot_contract,
                            },
                        ) && directory
                            .upload_flush_overrides
                            .last()
                            .is_none_or(|entry| entry.plan_index as usize != plan_index)
                        {
                            directory.upload_flush_overrides.push(QuantumFlushOverride {
                                plan_index: u32::try_from(plan_index)
                                    .expect("bounded native quantum upload plan"),
                                slot: first_slot,
                            });
                        }
                    }
                    "demand" => {
                        if download_positions.contains_key(&key) {
                            directory.fallback_full_scan = true;
                        }
                        let _ = upsert_slot_plan(
                            &mut directory.download_plans,
                            &mut download_positions,
                            QuantumSlotPlan {
                                entity_index: compact_entity_index,
                                item_index,
                                slot: slot_contract,
                            },
                        );
                    }
                    _ => continue,
                }
            }
        }
        directory.endpoint_indices.shrink_to_fit();
        directory.item_ids.shrink_to_fit();
        directory.item_by_id.shrink_to_fit();
        directory.collector_plans.shrink_to_fit();
        directory.upload_plans.shrink_to_fit();
        directory.download_plans.shrink_to_fit();
        directory.upload_flush_overrides.shrink_to_fit();
        directory.tower_stack_terms.shrink_to_fit();
        let download_order_entries = directory
            .download_plans
            .iter()
            .enumerate()
            .map(|(row, plan)| {
                let entity_index = plan.entity_index as usize;
                if entity_index >= state.entities.ids.len() {
                    return None;
                }
                let entity_id = &state.entities.ids[entity_index];
                let item_id = directory.item_id(plan.item_index)?;
                Some((
                    row,
                    i64::from(plan.slot.priority),
                    format!("{entity_id}:{item_id}"),
                ))
            })
            .collect::<Option<Vec<_>>>();
        if let Some(ranks) = download_order_entries
            .and_then(|entries| build_request_order_rank(entries, directory.download_plans.len()))
        {
            directory.download_order_rank = ranks;
        } else {
            directory.fallback_full_scan = true;
        }
        let mut upload_order_entries = Vec::with_capacity(
            directory
                .collector_plans
                .len()
                .saturating_add(directory.upload_plans.len()),
        );
        for (row, plan) in directory.collector_plans.iter().enumerate() {
            let entity_index = plan.entity_index as usize;
            if entity_index >= state.entities.ids.len() {
                directory.fallback_full_scan = true;
                continue;
            }
            let entity_id = &state.entities.ids[entity_index];
            let Some(item_id) = directory.item_id(plan.item_index) else {
                directory.fallback_full_scan = true;
                continue;
            };
            upload_order_entries.push((row, 1, format!("{entity_id}:{item_id}")));
        }
        let collector_rows = directory.collector_plans.len();
        for (plan_index, plan) in directory.upload_plans.iter().enumerate() {
            let entity_index = plan.entity_index as usize;
            if entity_index >= state.entities.ids.len() {
                directory.fallback_full_scan = true;
                continue;
            }
            let entity_id = &state.entities.ids[entity_index];
            let Some(item_id) = directory.item_id(plan.item_index) else {
                directory.fallback_full_scan = true;
                continue;
            };
            upload_order_entries.push((
                collector_rows + plan_index,
                i64::from(plan.slot.priority),
                format!("{entity_id}:{item_id}"),
            ));
        }
        if let Some(ranks) =
            build_request_order_rank(upload_order_entries, directory.boundary_upload_rows())
        {
            directory.boundary_upload_order_rank = ranks;
        } else {
            directory.fallback_full_scan = true;
        }
        directory.upload_by_station =
            EntityPlanRanges::build(directory.entity_count, &directory.upload_plans)
                .unwrap_or_else(|| {
                    directory.fallback_full_scan = true;
                    EntityPlanRanges::default()
                });
        directory.download_by_station =
            EntityPlanRanges::build(directory.entity_count, &directory.download_plans)
                .unwrap_or_else(|| {
                    directory.fallback_full_scan = true;
                    EntityPlanRanges::default()
                });
        directory.upload_by_item = ItemPlanIndex::build(
            directory.item_ids.len(),
            directory.upload_plans.iter().map(|plan| plan.item_index),
        )
        .unwrap_or_else(|| {
            directory.fallback_full_scan = true;
            ItemPlanIndex::default()
        });
        directory.collector_by_item = ItemPlanIndex::build(
            directory.item_ids.len(),
            directory.collector_plans.iter().map(|plan| plan.item_index),
        )
        .unwrap_or_else(|| {
            directory.fallback_full_scan = true;
            ItemPlanIndex::default()
        });
        directory.cached_legacy_bandwidth = RuntimeBandwidth {
            per_minute: 0.0,
            tower_stacks: directory.tower_stacks,
            collector_stacks: directory.collector_stacks,
        };
        let mut construction_centers =
            Vec::with_capacity(state.factory_topology.construction_center_indices.len());
        for &entity_index in &state.factory_topology.construction_center_indices {
            let Some(center) = entities.get(entity_index).and_then(Value::as_object) else {
                directory.construction_fallback_full_scan = true;
                continue;
            };
            let Some(entity_id) = string_at(center, "id").filter(|id| !id.is_empty()) else {
                directory.construction_fallback_full_scan = true;
                continue;
            };
            if string_at(center, "buildingId") != Some("construction_center")
                || state
                    .symbols
                    .resolve(state.entities.buildings[entity_index])
                    != Some("construction_center")
                || entity_id != &state.entities.ids[entity_index]
            {
                directory.construction_fallback_full_scan = true;
                continue;
            }
            // Extension IDs are valid in the permissive full scan. Until the
            // native directory has a signed content-pack contract for them,
            // retain exact behavior by failing closed to that oracle.
            if !entity_id.is_ascii() || entity_id.contains(':') {
                directory.construction_fallback_full_scan = true;
            }
            construction_centers.push((entity_id.to_owned(), entity_index));
        }
        construction_centers.sort_by(|left, right| left.0.cmp(&right.0));
        if construction_centers
            .windows(2)
            .any(|pair| pair[0].0 == pair[1].0)
        {
            directory.construction_fallback_full_scan = true;
        }
        directory.construction_center_indices = construction_centers
            .iter()
            .map(|(_, entity_index)| *entity_index)
            .collect();
        directory.construction_row_by_entity = directory
            .construction_center_indices
            .iter()
            .enumerate()
            .filter_map(|(row, &entity_index)| {
                Some((u32::try_from(entity_index).ok()?, u32::try_from(row).ok()?))
            })
            .collect();
        if directory.construction_row_by_entity.len() != directory.construction_center_indices.len()
        {
            directory.construction_fallback_full_scan = true;
        }
        directory
            .construction_row_by_entity
            .sort_unstable_by_key(|&(entity_index, _)| entity_index);
        directory.construction_center_indices.shrink_to_fit();
        directory.construction_row_by_entity.shrink_to_fit();
        directory
    }

    fn topology_matches(&self, state: &CoreState, entities: &[Value]) -> bool {
        Arc::ptr_eq(&self.topology, &state.factory_topology) && self.entity_count == entities.len()
    }

    fn item_id(&self, item_index: u32) -> Option<&str> {
        self.item_ids.get(item_index as usize).map(AsRef::as_ref)
    }

    fn upload_flush_contract(
        &self,
        plan_index: usize,
        selected: QuantumSlotContract,
    ) -> QuantumSlotContract {
        self.upload_flush_overrides
            .binary_search_by_key(&(plan_index as u32), |entry| entry.plan_index)
            .ok()
            .and_then(|index| self.upload_flush_overrides.get(index))
            .map_or(selected, |entry| entry.slot)
    }

    fn plan_matches(
        &self,
        state: &CoreState,
        entities: &[Value],
        plans: &[QuantumSlotPlan],
        plan_index: usize,
        remote_mode: &str,
        frozen_mode: bool,
    ) -> bool {
        let Some(plan) = plans.get(plan_index) else {
            return false;
        };
        let entity_index = plan.entity_index as usize;
        let Some(item_id) = self.item_id(plan.item_index) else {
            return false;
        };
        let Some(endpoint) = entities
            .get(entity_index)
            .and_then(Value::as_object)
            .filter(|endpoint| {
                string_at(endpoint, "id") == Some(&state.entities.ids[entity_index])
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
        let mut selected = None::<&Slot>;
        let mut first_supply = None::<&Slot>;
        for slot in &endpoint_slots {
            if remote_mode == "supply"
                && first_supply.is_none()
                && slot.item_id.as_deref() == Some(item_id)
                && slot.remote_mode == "supply"
            {
                first_supply = Some(slot);
            }
            if slot.item_id.as_deref() != Some(item_id) || slot.remote_mode != remote_mode {
                continue;
            }
            if selected
                .as_ref()
                .is_none_or(|existing| slot.priority > existing.priority)
            {
                selected = Some(slot);
            }
        }
        let highest_matches = selected
            .as_ref()
            .is_some_and(|slot| plan.slot.matches(slot));
        if !highest_matches {
            return false;
        }
        if remote_mode != "supply" {
            return true;
        }
        let flush_contract = self.upload_flush_contract(plan_index, plan.slot);
        first_supply.is_some_and(|slot| flush_contract.matches(slot))
    }

    fn collector_plan_matches(
        &self,
        state: &CoreState,
        entities: &[Value],
        plan: &QuantumCollectorPlan,
    ) -> bool {
        let entity_index = plan.entity_index as usize;
        let Some(item_id) = self.item_id(plan.item_index) else {
            return false;
        };
        entities
            .get(entity_index)
            .and_then(Value::as_object)
            .is_some_and(|endpoint| {
                string_at(endpoint, "id") == Some(&state.entities.ids[entity_index])
                    && string_at(endpoint, "storedItemId") == Some(item_id)
                    && is_quantum_collector(endpoint)
            })
    }

    fn boundary_upload_rows(&self) -> usize {
        self.collector_plans.len() + self.upload_plans.len()
    }

    fn download_rows(&self) -> usize {
        self.download_plans.len() + self.construction_center_indices.len()
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
                    ..QuantumActiveScan::default()
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
                ..QuantumActiveScan::default()
            },
        )
    }

    fn selected_flush_plans(
        &self,
        state: &CoreState,
        entities: &[Value],
        frozen_mode: bool,
    ) -> (Option<Vec<usize>>, QuantumActiveScan) {
        self.selected_flush_plans_with_runtime(
            state,
            entities,
            frozen_mode,
            crate::deterministic_runtime::runtime(),
        )
    }

    fn selected_flush_plans_with_runtime(
        &self,
        state: &CoreState,
        entities: &[Value],
        frozen_mode: bool,
        runtime: &DeterministicRuntime,
    ) -> (Option<Vec<usize>>, QuantumActiveScan) {
        let (selected, mut scan) = self.selected_plan_indices(
            self.upload_plans.len(),
            self.flush_all_pending,
            &self.pending_flush,
            self.topology_matches(state, entities),
        );
        if selected.as_ref().is_some_and(|indices| {
            first_invalid_selected_plan_with_runtime(indices, runtime, &|index| {
                self.plan_matches(
                    state,
                    entities,
                    &self.upload_plans,
                    index,
                    "supply",
                    frozen_mode,
                )
            })
            .is_some()
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
            indices.iter().any(|&index| {
                !self.plan_matches(
                    state,
                    entities,
                    &self.download_plans,
                    index,
                    "demand",
                    false,
                )
            })
        }) {
            scan.selected_rows = self.entity_count;
            scan.total_rows = self.entity_count;
            scan.dense_fallback = true;
            scan.directory_fallback = true;
            return (None, scan);
        }
        (selected, scan)
    }

    fn construction_center_matches(
        &self,
        state: &CoreState,
        entities: &[Value],
        construction_row: usize,
    ) -> bool {
        let Some(catalog) = self.catalog.as_ref() else {
            return false;
        };
        if !Arc::ptr_eq(catalog, &state.catalog) {
            return false;
        }
        let Some(&entity_index) = self.construction_center_indices.get(construction_row) else {
            return false;
        };
        let Some(center) = entities.get(entity_index).and_then(Value::as_object) else {
            return false;
        };
        string_at(center, "id") == Some(&state.entities.ids[entity_index])
            && string_at(center, "buildingId") == Some("construction_center")
            && state
                .symbols
                .resolve(state.entities.buildings[entity_index])
                == Some("construction_center")
    }

    fn selected_construction_center_rows(
        &self,
        state: &CoreState,
        entities: &[Value],
    ) -> (Option<Vec<usize>>, QuantumActiveScan) {
        let compatible = self.topology_matches(state, entities)
            && self.catalog.is_some()
            && !self.construction_fallback_full_scan;
        let (selected, mut scan) = self.selected_plan_indices(
            self.construction_center_indices.len(),
            self.construction_download_all_pending,
            &self.pending_construction_download,
            compatible,
        );
        if selected.is_none() {
            scan.selected_rows = self.construction_center_indices.len();
            scan.total_rows = self.construction_center_indices.len();
            scan.dense_fallback = true;
            scan.directory_fallback = true;
            return (None, scan);
        }
        if selected.as_ref().is_some_and(|rows| {
            rows.iter()
                .any(|&row| !self.construction_center_matches(state, entities, row))
        }) {
            scan.selected_rows = self.construction_center_indices.len();
            scan.total_rows = self.construction_center_indices.len();
            scan.dense_fallback = true;
            scan.directory_fallback = true;
            return (None, scan);
        }
        (selected, scan)
    }

    fn construction_center_indices_for_rows(&self, rows: &[usize]) -> Option<Vec<usize>> {
        rows.iter()
            .map(|&row| self.construction_center_indices.get(row).copied())
            .collect()
    }

    fn construction_row_for_entity(&self, entity_index: usize) -> Option<usize> {
        let entity_index = u32::try_from(entity_index).ok()?;
        self.construction_row_by_entity
            .binary_search_by_key(&entity_index, |&(candidate, _)| candidate)
            .ok()
            .and_then(|index| self.construction_row_by_entity.get(index))
            .map(|&(_, row)| row as usize)
    }

    fn construction_demand_is_indexable(
        &self,
        state: &CoreState,
        demand: &crate::construction::QuantumDemand,
    ) -> bool {
        demand.entity_id.is_ascii()
            && !demand.entity_id.contains(':')
            && demand.item_id.is_ascii()
            && !demand.item_id.contains(':')
            && state.catalog.items.contains_key(&demand.item_id)
    }

    fn selected_boundary_upload_rows(
        &self,
        state: &CoreState,
        entities: &[Value],
    ) -> (Option<Vec<usize>>, QuantumActiveScan) {
        let collector_rows = self.collector_plans.len();
        let (selected, mut scan) = self.selected_plan_indices(
            self.boundary_upload_rows(),
            self.boundary_upload_all_pending,
            &self.pending_boundary_upload,
            self.topology_matches(state, entities),
        );
        if selected.as_ref().is_some_and(|indices| {
            indices.iter().any(|&row| {
                if row < collector_rows {
                    !self.collector_plan_matches(state, entities, &self.collector_plans[row])
                } else {
                    !self.plan_matches(
                        state,
                        entities,
                        &self.upload_plans,
                        row - collector_rows,
                        "supply",
                        true,
                    )
                }
            })
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

    pub(crate) fn wake_from_stations(&mut self, station_indices: &[usize]) {
        if !self.flush_all_pending {
            for station_index in station_indices {
                self.pending_flush
                    .extend(self.upload_by_station.range(*station_index));
            }
        }
        if !self.boundary_upload_all_pending {
            for station_index in station_indices {
                if let Ok(collector_index) = self.collector_plans.binary_search_by_key(
                    &u32::try_from(*station_index).unwrap_or(u32::MAX),
                    |plan| plan.entity_index,
                ) {
                    self.pending_boundary_upload.insert(collector_index);
                }
                let collector_rows = self.collector_plans.len();
                self.pending_boundary_upload.extend(
                    self.upload_by_station
                        .range(*station_index)
                        .map(|index| collector_rows + index),
                );
            }
        }
        if !self.download_all_pending {
            for station_index in station_indices {
                self.pending_download
                    .extend(self.download_by_station.range(*station_index));
            }
        }
    }

    pub(crate) fn wake_construction_centers(&mut self, center_indices: &[usize]) {
        if self.construction_download_all_pending {
            return;
        }
        for &entity_index in center_indices {
            let Some(row) = self.construction_row_for_entity(entity_index) else {
                // A construction row outside the immutable directory means a
                // topology owner changed without replacing this cache. Never
                // guess: the next boundary must use the permissive oracle.
                self.construction_fallback_full_scan = true;
                self.pending_construction_download.clear();
                return;
            };
            self.pending_construction_download.insert(row);
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
            let Some(&item_index) = self.item_by_id.get(item_id) else {
                continue;
            };
            for plan_index in self.download_by_station.range(source_index) {
                if self.download_plans[plan_index].item_index == item_index {
                    self.pending_download.insert(plan_index);
                }
            }
        }
    }

    pub(crate) fn wake_flush_items<'a>(&mut self, item_ids: impl Iterator<Item = &'a String>) {
        for item_id in item_ids {
            let Some(&item_index) = self.item_by_id.get(item_id.as_str()) else {
                continue;
            };
            if !self.flush_all_pending {
                self.pending_flush.extend(
                    self.upload_by_item
                        .plans(item_index)
                        .iter()
                        .map(|&index| index as usize),
                );
            }
            if !self.boundary_upload_all_pending {
                self.pending_boundary_upload.extend(
                    self.collector_by_item
                        .plans(item_index)
                        .iter()
                        .map(|&index| index as usize),
                );
                let collector_rows = self.collector_plans.len();
                self.pending_boundary_upload.extend(
                    self.upload_by_item
                        .plans(item_index)
                        .iter()
                        .map(|&index| collector_rows + index as usize),
                );
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

    fn commit_construction_download(&mut self, selected: &[usize], retain: BTreeSet<usize>) {
        if self.construction_download_all_pending {
            self.construction_download_all_pending = false;
            self.pending_construction_download.clear();
        } else {
            for row in selected {
                self.pending_construction_download.remove(row);
            }
        }
        self.pending_construction_download.extend(retain);
    }

    fn commit_boundary_upload(&mut self, selected: &[usize], retain: BTreeSet<usize>) {
        if self.boundary_upload_all_pending {
            self.boundary_upload_all_pending = false;
            self.pending_boundary_upload.clear();
        } else {
            for index in selected {
                self.pending_boundary_upload.remove(index);
            }
        }
        self.pending_boundary_upload.extend(retain);
    }

    fn mark_download_runtime_written(&mut self, entity_index: usize) {
        self.runtime_written_station_indices.insert(entity_index);
        self.inventory_written_station_indices.insert(entity_index);
    }

    fn mark_fallback_download_runtime_rows(&mut self) {
        let indices = self
            .download_plans
            .iter()
            .map(|plan| plan.entity_index as usize)
            .collect::<Vec<_>>();
        self.runtime_written_station_indices
            .extend(indices.iter().copied());
        self.inventory_written_station_indices.extend(indices);
    }

    fn mark_inventory_written(&mut self, entity_index: usize) {
        self.inventory_written_station_indices.insert(entity_index);
    }

    fn mark_fallback_flush_runtime_rows(&mut self) {
        self.inventory_written_station_indices.extend(
            self.upload_plans
                .iter()
                .map(|plan| plan.entity_index as usize),
        );
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

    pub(crate) fn take_construction_inventory_written_center_indices(&mut self) -> Vec<usize> {
        std::mem::take(&mut self.construction_inventory_written_center_indices)
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
        let item_text_bytes = self
            .item_ids
            .iter()
            .map(|item| {
                let header = size_of::<usize>() * 2;
                let unaligned = header + item.len();
                let alignment = std::mem::align_of::<usize>();
                unaligned.div_ceil(alignment) * alignment
            })
            .sum::<usize>();
        // HashMap buckets include the stored pair plus one control byte. This
        // deliberately counts the unique item lookup separately from the item
        // arena; unlike the old plan estimate, no resident reverse index is
        // omitted from the public memory diagnostic.
        let item_lookup_bytes =
            self.item_by_id.capacity() * (size_of::<(Arc<str>, u32)>() + size_of::<u8>());
        let pending_tree_bytes = (self.pending_flush.len()
            + self.pending_download.len()
            + self.pending_construction_download.len()
            + self.pending_boundary_upload.len()
            + self.runtime_written_station_indices.len()
            + self.inventory_written_station_indices.len()
            + self.construction_inventory_written_center_indices.len())
            * (size_of::<usize>() * 4);
        let network_proof_bytes = self
            .network_sparse_proof
            .as_ref()
            .map(|proof| {
                proof.zero_inventory.capacity() * (size_of::<String>() + size_of::<u8>())
                    + proof
                        .zero_inventory
                        .iter()
                        .map(String::capacity)
                        .sum::<usize>()
                    + proof
                        .runtime_flow
                        .as_deref()
                        .map(BoundaryFlow::estimated_bytes)
                        .unwrap_or(0)
            })
            .unwrap_or(0);
        (self.endpoint_indices.capacity() * size_of::<usize>()
            + self.item_ids.capacity() * size_of::<Arc<str>>()
            + item_text_bytes
            + item_lookup_bytes
            + self.collector_plans.capacity() * size_of::<QuantumCollectorPlan>()
            + self.upload_plans.capacity() * size_of::<QuantumSlotPlan>()
            + self.download_plans.capacity() * size_of::<QuantumSlotPlan>()
            + self.boundary_upload_order_rank.capacity() * size_of::<u32>()
            + self.download_order_rank.capacity() * size_of::<u32>()
            + self.construction_center_indices.capacity() * size_of::<usize>()
            + self.construction_row_by_entity.capacity() * size_of::<(u32, u32)>()
            + self.upload_flush_overrides.capacity() * size_of::<QuantumFlushOverride>()
            + self.upload_by_station.estimated_bytes() as usize
            + self.upload_by_item.estimated_bytes() as usize
            + self.collector_by_item.estimated_bytes() as usize
            + self.download_by_station.estimated_bytes() as usize
            + self.tower_stack_terms.capacity() * size_of::<f64>()
            + pending_tree_bytes
            + network_proof_bytes) as u64
    }
}

fn combined_active_scan(left: QuantumActiveScan, right: QuantumActiveScan) -> QuantumActiveScan {
    QuantumActiveScan {
        selected_rows: left.selected_rows.saturating_add(right.selected_rows),
        total_rows: left.total_rows.saturating_add(right.total_rows),
        dense_fallback: left.dense_fallback || right.dense_fallback,
        directory_fallback: left.directory_fallback || right.directory_fallback,
        linear_order_rows: left
            .linear_order_rows
            .saturating_add(right.linear_order_rows),
        full_sort_rows: left.full_sort_rows.saturating_add(right.full_sort_rows),
        network_parse_selected_rows: left
            .network_parse_selected_rows
            .saturating_add(right.network_parse_selected_rows),
        network_parse_total_rows: left
            .network_parse_total_rows
            .saturating_add(right.network_parse_total_rows),
        network_parse_full_scan_fallback: left.network_parse_full_scan_fallback
            || right.network_parse_full_scan_fallback,
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
    station_capacity_with_max_stock(state, base, entity, slot.max_stock)
}

fn station_capacity_with_max_stock(
    state: &CoreState,
    base: &Map<String, Value>,
    entity: &Map<String, Value>,
    max_stock: f64,
) -> anyhow::Result<f64> {
    let building = string_at(entity, "buildingId")
        .and_then(|id| state.catalog.buildings.get(id))
        .ok_or_else(|| anyhow!("native quantum station building is missing"))?;
    let rated = stacked_capacity(
        building.output_capacity,
        finite_number(entity.get("machineCount")),
        normalized_buffer_limit(base),
    );
    Ok(if max_stock > 0.0 {
        rated.min(max_stock)
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

fn request_order(left: &Request, right: &Request) -> Ordering {
    #[cfg(test)]
    REQUEST_ORDER_COMPARISONS.with(|count| count.set(count.get().saturating_add(1)));
    right
        .priority
        .cmp(&left.priority)
        .then_with(|| left.key.cmp(&right.key))
}

#[cfg(test)]
fn take_request_order_comparisons() -> usize {
    REQUEST_ORDER_COMPARISONS.with(|count| {
        let comparisons = count.get();
        count.set(0);
        comparisons
    })
}

fn sorted_requests(requests: &mut [Request]) {
    requests.sort_by(request_order);
}

fn request_indices_by_topology_rank(
    request_rows: &[usize],
    order_rank_by_row: &[u32],
) -> Option<Vec<usize>> {
    let mut current = (0..request_rows.len()).collect::<Vec<_>>();
    let mut scratch = vec![0_usize; current.len()];
    for shift in [0_u32, 8, 16, 24] {
        let mut counts = [0_usize; 256];
        for &request_index in &current {
            let row = *request_rows.get(request_index)?;
            let rank = *order_rank_by_row.get(row)?;
            counts[((rank >> shift) & 0xff) as usize] += 1;
        }
        let mut next_offset = 0_usize;
        for count in &mut counts {
            let bucket_count = *count;
            *count = next_offset;
            next_offset = next_offset.checked_add(bucket_count)?;
        }
        for &request_index in &current {
            let row = *request_rows.get(request_index)?;
            let rank = *order_rank_by_row.get(row)?;
            let bucket = ((rank >> shift) & 0xff) as usize;
            let output_index = counts[bucket];
            *scratch.get_mut(output_index)? = request_index;
            counts[bucket] += 1;
        }
        std::mem::swap(&mut current, &mut scratch);
    }
    Some(current)
}

fn requests_by_topology_rank(
    requests: &[Request],
    request_rows: &[usize],
    order_rank_by_row: &[u32],
) -> Option<Vec<Request>> {
    if requests.len() != request_rows.len() {
        return None;
    }
    let indices = request_indices_by_topology_rank(request_rows, order_rank_by_row)?;
    let ordered = indices
        .into_iter()
        .map(|index| requests.get(index).cloned())
        .collect::<Option<Vec<_>>>()?;
    ordered
        .windows(2)
        .all(|pair| request_order(&pair[0], &pair[1]) != Ordering::Greater)
        .then_some(ordered)
}

fn merge_unique_request_streams(left: Vec<Request>, right: &[Request]) -> Option<Vec<Request>> {
    if left
        .windows(2)
        .any(|pair| request_order(&pair[0], &pair[1]) == Ordering::Greater)
        || right
            .windows(2)
            .any(|pair| request_order(&pair[0], &pair[1]) == Ordering::Greater)
    {
        return None;
    }
    let mut result = Vec::with_capacity(left.len().checked_add(right.len())?);
    let mut left_index = 0_usize;
    let mut right_index = 0_usize;
    while left_index < left.len() && right_index < right.len() {
        if request_order(&left[left_index], &right[right_index]) != Ordering::Greater {
            result.push(left[left_index].clone());
            left_index += 1;
        } else {
            result.push(right[right_index].clone());
            right_index += 1;
        }
    }
    result.extend(left[left_index..].iter().cloned());
    result.extend(right[right_index..].iter().cloned());
    let mut keys = HashSet::with_capacity(result.len());
    result
        .iter()
        .all(|request| keys.insert(request.key.as_str()))
        .then_some(result)
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
        network.set_inventory_amount(item_id, saturated(available - &allocation.total));
        if allocation.total < planned && !item_requests.is_empty() {
            network.advance_routing_cursor(item_id);
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
            network.advance_upload_routing_cursor(&item_id);
        }
        if !accepted.is_zero() {
            let next = network.inventory.get(&item_id).cloned().unwrap_or_default() + accepted;
            network.set_inventory_amount(&item_id, saturated(next));
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
        network.set_inventory_amount(item_id, saturated(current + &accepted));
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
        network.set_runtime_flow(create_flow_with_bandwidth(network, boundary, bandwidth));
    }
    if let Some(flow) = &mut network.runtime_flow {
        let flow = Arc::make_mut(flow);
        add_flow(&mut flow.uploaded, item_id, amount);
        network.runtime_flow_dirty = true;
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
                network.remove_zero_inventory();
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

#[allow(clippy::too_many_arguments)]
fn flush_selected_supply_buffers_with_network(
    _state: &CoreState,
    base: &mut Map<String, Value>,
    entities: &mut [Value],
    directory: &mut QuantumLogisticsDirectory,
    route_ledger: &crate::station_route_ledger::StationRouteLedger,
    runtime_bandwidth: RuntimeBandwidth,
    selected: &[usize],
    network: &mut Network,
) -> anyhow::Result<()> {
    let mut normalized_for_deposit = false;
    for &plan_index in selected {
        let plan = directory.upload_plans[plan_index];
        let entity_index = plan.entity_index as usize;
        let item_id = directory
            .item_id(plan.item_index)
            .ok_or_else(|| anyhow!("native quantum upload item index is invalid"))?;
        let flush_slot = directory.upload_flush_contract(plan_index, plan.slot);
        let station = entities[entity_index]
            .as_object_mut()
            .ok_or_else(|| anyhow!("native quantum station is invalid"))?;
        let input = item_amount(station, "inputs", item_id).floor().max(0.0);
        let output = item_amount(station, "outputs", item_id).floor().max(0.0);
        let outgoing = route_ledger
            .quantum_reserved_outgoing(entity_index, item_id)
            .floor()
            .max(0.0);
        let min_stock = f64::from(flush_slot.min_stock);
        let from_output_available = (output - min_stock - outgoing).max(0.0);
        let from_input_available = (input - (min_stock - output).max(0.0)).max(0.0);
        let requested = floor_u64(from_output_available + from_input_available);
        if requested < 1 {
            continue;
        }
        if !normalized_for_deposit {
            network.remove_zero_inventory();
            normalized_for_deposit = true;
        }
        let accepted = deposit(network, item_id, &BigUint::from(requested));
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
        record_immediate_upload(base, runtime_bandwidth, network, item_id, &accepted);
        directory.mark_inventory_written(entity_index);
    }
    directory.commit_flush(selected);
    Ok(())
}

fn select_flush_network_items(
    directory: &QuantumLogisticsDirectory,
    selected: &[usize],
) -> anyhow::Result<NetworkItemSelection> {
    let mut selection = NetworkItemSelection::default();
    for &plan_index in selected {
        let plan = directory
            .upload_plans
            .get(plan_index)
            .ok_or_else(|| anyhow!("native quantum upload plan index is invalid"))?;
        let item_id = directory
            .item_id(plan.item_index)
            .ok_or_else(|| anyhow!("native quantum upload item index is invalid"))?;
        selection.select_flush(item_id);
    }
    Ok(selection)
}

fn fractional_cargo(value: f64) -> bool {
    value.is_finite() && value.fract().abs() > f64::EPSILON
}

fn selected_flush_has_fractional_cargo(
    directory: &QuantumLogisticsDirectory,
    selected: &[usize],
    route_ledger: &crate::station_route_ledger::StationRouteLedger,
) -> bool {
    selected.iter().any(|&plan_index| {
        let Some(plan) = directory.upload_plans.get(plan_index) else {
            return true;
        };
        let Some(item_id) = directory.item_id(plan.item_index) else {
            return true;
        };
        fractional_cargo(
            route_ledger.quantum_reserved_outgoing(plan.entity_index as usize, item_id),
        )
    })
}

fn selected_download_has_fractional_cargo(
    directory: &QuantumLogisticsDirectory,
    selected: &[usize],
    route_ledger: &crate::station_route_ledger::StationRouteLedger,
) -> bool {
    selected.iter().any(|&plan_index| {
        let Some(plan) = directory.download_plans.get(plan_index) else {
            return true;
        };
        let Some(item_id) = directory.item_id(plan.item_index) else {
            return true;
        };
        fractional_cargo(route_ledger.quantum_in_flight(plan.entity_index as usize, item_id))
    })
}

fn selected_boundary_upload_has_fractional_cargo(
    directory: &QuantumLogisticsDirectory,
    selected: &[usize],
    route_ledger: &crate::station_route_ledger::StationRouteLedger,
) -> bool {
    let collector_rows = directory.collector_plans.len();
    selected.iter().any(|&row| {
        if row < collector_rows {
            return false;
        }
        let Some(plan) = directory.upload_plans.get(row - collector_rows) else {
            return true;
        };
        let Some(item_id) = directory.item_id(plan.item_index) else {
            return true;
        };
        fractional_cargo(
            route_ledger.quantum_reserved_outgoing(plan.entity_index as usize, item_id),
        )
    })
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
    if !network_enabled(base)? {
        return Ok(QuantumActiveScan {
            total_rows: directory.upload_plans.len(),
            network_parse_total_rows: raw_network_record_rows(base),
            ..QuantumActiveScan::default()
        });
    }
    let (selected, mut scan) = directory.selected_flush_plans(state, entities, frozen_mode);
    let Some(selected) = selected else {
        let total_rows = raw_network_record_rows(base);
        flush_supply_buffers_for_index(base, entities, None)?;
        refresh_network_sparse_proof(base, directory)?;
        directory.mark_fallback_flush_runtime_rows();
        scan.network_parse_selected_rows = total_rows;
        scan.network_parse_total_rows = total_rows;
        scan.network_parse_full_scan_fallback = true;
        return Ok(scan);
    };
    let selection = select_flush_network_items(directory, &selected)?;
    let force_full_write = selected_flush_has_fractional_cargo(directory, &selected, route_ledger);
    let force_full_scan =
        scan.dense_fallback || route_ledger.scan().active_order_fallback || force_full_write;
    let (mut network, network_scan) = parse_active_network(
        base,
        &selection,
        directory,
        force_full_scan,
        force_full_write,
    )?;
    apply_network_parse_scan(&mut scan, network_scan);
    flush_selected_supply_buffers_with_network(
        state,
        base,
        entities,
        directory,
        route_ledger,
        runtime_bandwidth,
        &selected,
        &mut network,
    )?;
    write_active_network(base, &network, directory)?;
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
        session.network.remove_zero_inventory();
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

fn settle_downloads_with_request_count(
    state: &CoreState,
    base: &mut Map<String, Value>,
    entities: &mut [Value],
    credits: &crate::belts::OutputCredits,
    boundary_second: f64,
    seconds: f64,
) -> anyhow::Result<(Option<BoundaryFlow>, usize)> {
    let mut network = parse_network(base)?;
    if !network.enabled {
        return Ok((None, 0));
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
    network.set_runtime_flow(flow.clone());
    write_network(base, &network)?;
    Ok((Some(flow), allocation_requests.len()))
}

#[cfg(test)]
fn settle_downloads(
    state: &CoreState,
    base: &mut Map<String, Value>,
    entities: &mut [Value],
    credits: &crate::belts::OutputCredits,
    boundary_second: f64,
    seconds: f64,
) -> anyhow::Result<Option<BoundaryFlow>> {
    settle_downloads_with_request_count(state, base, entities, credits, boundary_second, seconds)
        .map(|(flow, _)| flow)
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
    if !network_enabled(base)? {
        return Ok((
            None,
            QuantumActiveScan {
                total_rows: directory.download_rows(),
                network_parse_total_rows: raw_network_record_rows(base),
                ..QuantumActiveScan::default()
            },
        ));
    }
    directory.wake_download_credits(state, credits);
    let (selected, station_scan) = directory.selected_download_plans(state, entities);
    let (selected_construction_rows, construction_scan) =
        directory.selected_construction_center_rows(state, entities);
    let mut scan = combined_active_scan(station_scan, construction_scan);
    let (Some(selected), Some(indexed_construction_rows)) = (selected, selected_construction_rows)
    else {
        let total_rows = raw_network_record_rows(base);
        let (flow, full_sort_rows) = settle_downloads_with_request_count(
            state,
            base,
            entities,
            credits,
            boundary_second,
            seconds,
        )?;
        scan.full_sort_rows = full_sort_rows;
        scan.network_parse_selected_rows = total_rows;
        scan.network_parse_total_rows = total_rows;
        scan.network_parse_full_scan_fallback = true;
        refresh_network_sparse_proof(base, directory)?;
        directory.mark_fallback_download_runtime_rows();
        return Ok((flow, scan));
    };
    let center_indices = directory
        .construction_center_indices_for_rows(&indexed_construction_rows)
        .ok_or_else(|| anyhow!("native construction quantum row index is invalid"))?;
    let construction_demands = crate::construction::quantum_demands_for_center_indices(
        state,
        base,
        entities,
        &center_indices,
        &indexed_construction_rows,
    )?;
    if construction_demands.iter().any(|demand| {
        !directory.construction_demand_is_indexable(state, demand)
            || demand.entity_index >= state.entities.ids.len()
            || &state.entities.ids[demand.entity_index] != demand.entity_id.as_str()
            || demand.active_row.is_none_or(|row| {
                directory.construction_center_indices.get(row) != Some(&demand.entity_index)
            })
    }) {
        // A valid extension can still be simulated by the permissive oracle,
        // but bandwidth, request order and network normalization must all come
        // from that same oracle.
        scan.selected_rows = directory.download_rows();
        scan.total_rows = directory.download_rows();
        scan.dense_fallback = true;
        scan.directory_fallback = true;
        let total_rows = raw_network_record_rows(base);
        let (flow, full_sort_rows) = settle_downloads_with_request_count(
            state,
            base,
            entities,
            credits,
            boundary_second,
            seconds,
        )?;
        scan.full_sort_rows = full_sort_rows;
        scan.network_parse_selected_rows = total_rows;
        scan.network_parse_total_rows = total_rows;
        scan.network_parse_full_scan_fallback = true;
        refresh_network_sparse_proof(base, directory)?;
        directory.mark_fallback_download_runtime_rows();
        return Ok((flow, scan));
    }
    let mut network_selection = NetworkItemSelection::default();
    for &plan_index in &selected {
        let plan = directory
            .download_plans
            .get(plan_index)
            .ok_or_else(|| anyhow!("native quantum download plan index is invalid"))?;
        let item_id = directory
            .item_id(plan.item_index)
            .ok_or_else(|| anyhow!("native quantum download item index is invalid"))?;
        network_selection.select_download(item_id);
    }
    for demand in &construction_demands {
        network_selection.select_download(&demand.item_id);
    }
    let force_full_write =
        selected_download_has_fractional_cargo(directory, &selected, route_ledger);
    let force_full_scan =
        scan.dense_fallback || route_ledger.scan().active_order_fallback || force_full_write;
    let (mut network, network_scan) = parse_active_network(
        base,
        &network_selection,
        directory,
        force_full_scan,
        force_full_write,
    )?;
    apply_network_parse_scan(&mut scan, network_scan);
    let bandwidth = directory.indexed_runtime_bandwidth(base);
    let mut flow = create_flow_with_bandwidth(&network, boundary_second, bandwidth);
    let mut requests = Vec::new();
    let mut request_positions = HashMap::new();
    let mut request_plan_rows = Vec::new();
    let mut linear_order_eligible = true;
    let mut retain = BTreeSet::new();
    for &plan_index in &selected {
        let plan = directory.download_plans[plan_index];
        let entity_index = plan.entity_index as usize;
        let item_id = directory
            .item_id(plan.item_index)
            .ok_or_else(|| anyhow!("native quantum download item index is invalid"))?;
        let station = entities[entity_index]
            .as_object()
            .ok_or_else(|| anyhow!("native quantum endpoint is invalid"))?;
        let current = item_amount(station, "outputs", item_id).floor().max(0.0);
        let local_capacity =
            station_capacity_with_max_stock(state, base, station, f64::from(plan.slot.max_stock))?
                .floor()
                .max(0.0);
        let incoming = route_ledger
            .quantum_in_flight(entity_index, item_id)
            .max(0.0);
        let local_free = (local_capacity - current - incoming).max(0.0);
        let direct_through = if current <= local_capacity {
            crate::belts::output_credit(state, credits, &state.entities.ids[entity_index], item_id)
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
        let previous_len = requests.len();
        upsert_request_in_stable_order(
            &mut requests,
            &mut request_positions,
            Request {
                key: format!("{}:{item_id}", &state.entities.ids[entity_index]),
                entity_index,
                item_id: item_id.to_owned(),
                amount: BigUint::from(capacity),
                priority: i64::from(plan.slot.priority),
            },
        );
        if requests.len() == previous_len.saturating_add(1) {
            request_plan_rows.push(plan_index);
        } else {
            linear_order_eligible = false;
        }
    }
    let mut construction_retain = BTreeSet::new();
    for demand in &construction_demands {
        if let Some(row) = demand.active_row {
            construction_retain.insert(row);
        }
    }
    let construction_demands = construction_demands
        .into_iter()
        .map(|demand| (demand.key.clone(), demand))
        .collect::<BTreeMap<_, _>>();
    let station_request_count = requests.len();
    for demand in construction_demands.values() {
        let previous_len = requests.len();
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
        if requests.len() != previous_len.saturating_add(1) {
            linear_order_eligible = false;
        }
    }
    let linear_allocation_requests = (!scan.dense_fallback
        && !scan.directory_fallback
        && linear_order_eligible
        && station_request_count == request_plan_rows.len())
    .then(|| {
        requests_by_topology_rank(
            &requests[..station_request_count],
            &request_plan_rows,
            &directory.download_order_rank,
        )
        .and_then(|station_requests| {
            merge_unique_request_streams(station_requests, &requests[station_request_count..])
        })
    })
    .flatten();
    let allocation_requests = if let Some(ordered) = linear_allocation_requests {
        scan.linear_order_rows = ordered.len();
        ordered
    } else {
        scan.full_sort_rows = requests.len();
        let mut ordered = requests.clone();
        sorted_requests(&mut ordered);
        ordered
    };
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
                directory
                    .construction_inventory_written_center_indices
                    .insert(demand.entity_index);
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
    network.set_runtime_flow(flow.clone());
    write_active_network(base, &network, directory)?;
    directory.commit_download(&selected, retain);
    directory.commit_construction_download(&indexed_construction_rows, construction_retain);
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
    if !network_enabled(base)? {
        return Ok(QuantumActiveScan {
            total_rows: directory.boundary_upload_rows(),
            network_parse_total_rows: raw_network_record_rows(base),
            ..QuantumActiveScan::default()
        });
    }
    // Commands and topology changes replace the Arc-bound directory. Within
    // one immutable topology, validate only the rows selected by exact reverse
    // dependencies instead of rescanning every upload slot and collector at
    // every five-second boundary.
    let indexed_before_flush = directory.can_use_index(state, entities);
    let bandwidth = if indexed_before_flush {
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
    let (selected_flush_rows, flush_scan) = directory.selected_flush_plans(state, entities, true);
    if flush_scan.directory_fallback {
        directory.fallback_full_scan = true;
    }
    let (selected_rows, mut upload_scan) = directory.selected_boundary_upload_rows(state, entities);
    if upload_scan.directory_fallback {
        directory.fallback_full_scan = true;
    }
    let mut network_selection = NetworkItemSelection::default();
    if let Some(selected_flush_rows) = selected_flush_rows.as_ref() {
        network_selection = select_flush_network_items(directory, selected_flush_rows)?;
    }
    if let Some(selected_rows) = selected_rows.as_ref() {
        let collector_rows = directory.collector_plans.len();
        for &row in selected_rows {
            let item_index = if row < collector_rows {
                directory
                    .collector_plans
                    .get(row)
                    .map(|plan| plan.item_index)
            } else {
                directory
                    .upload_plans
                    .get(row - collector_rows)
                    .map(|plan| plan.item_index)
            }
            .ok_or_else(|| anyhow!("native quantum boundary upload row is invalid"))?;
            let item_id = directory
                .item_id(item_index)
                .ok_or_else(|| anyhow!("native quantum boundary upload item is invalid"))?;
            network_selection.select_upload(item_id);
        }
    }
    let force_full_write = selected_flush_rows.as_ref().is_some_and(|selected| {
        selected_flush_has_fractional_cargo(directory, selected, route_ledger)
    }) || selected_rows.as_ref().is_some_and(|selected| {
        selected_boundary_upload_has_fractional_cargo(directory, selected, route_ledger)
    });
    let force_full_scan = selected_flush_rows.is_none()
        || selected_rows.is_none()
        || flush_scan.dense_fallback
        || upload_scan.dense_fallback
        || route_ledger.scan().active_order_fallback
        || force_full_write;
    let (mut network, network_scan) = parse_active_network(
        base,
        &network_selection,
        directory,
        force_full_scan,
        force_full_write,
    )?;
    apply_network_parse_scan(&mut upload_scan, network_scan);
    let existing_flow = network.runtime_flow.clone();
    let mut flow = previous_flow.clone().unwrap_or_else(|| {
        if indexed_before_flush {
            create_flow_with_bandwidth(&network, boundary_second, bandwidth)
        } else {
            create_flow(base, entities, &network, boundary_second)
        }
    });
    synchronize_existing_boundary_uploads(&mut flow, existing_flow.as_deref());
    flow.global_upload_per_minute = bandwidth.per_minute;
    flow.global_download_per_minute = bandwidth.per_minute;
    flow.quantum_tower_stacks = bandwidth.tower_stacks;
    flow.quantum_collector_stacks = bandwidth.collector_stacks;
    network.set_runtime_flow(flow.clone());

    if let Some(selected_flush_rows) = selected_flush_rows.as_ref() {
        flush_selected_supply_buffers_with_network(
            state,
            base,
            entities,
            directory,
            route_ledger,
            runtime_bandwidth,
            selected_flush_rows,
            &mut network,
        )?;
    } else {
        // The permissive oracle owns its parse/write cycle. Publish this
        // boundary's flow first, then refresh the complete local session so
        // the following permissive upload allocation sees the oracle result.
        write_network(base, &network)?;
        flush_supply_buffers_for_index(base, entities, None)?;
        network = parse_network(base)?;
        directory.mark_fallback_flush_runtime_rows();
    }
    let use_index = selected_rows.is_some();
    let reserved = (!use_index).then(|| reserved_outgoing(entities));
    let mut requests = Vec::new();
    let mut request_positions = HashMap::new();
    let mut request_rows = HashMap::<String, usize>::new();
    let mut request_source_rows = Vec::new();
    let mut linear_order_eligible = true;
    let mut retain_rows = BTreeSet::new();
    if let Some(selected_rows) = selected_rows.as_ref() {
        let collector_rows = directory.collector_plans.len();
        for &row in selected_rows {
            if row < collector_rows {
                let plan = directory.collector_plans[row];
                if plan.continuously_productive {
                    retain_rows.insert(row);
                }
                let entity_index = plan.entity_index as usize;
                let item_id = directory
                    .item_id(plan.item_index)
                    .ok_or_else(|| anyhow!("native quantum collector item index is invalid"))?;
                let endpoint = entities[entity_index]
                    .as_object()
                    .ok_or_else(|| anyhow!("native quantum endpoint is invalid"))?;
                let available = floor_u64(item_amount(endpoint, "outputs", item_id));
                if available < 1 {
                    continue;
                }
                let key = format!("{}:{item_id}", &state.entities.ids[entity_index]);
                request_rows.insert(key.clone(), row);
                let previous_len = requests.len();
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
                if requests.len() == previous_len.saturating_add(1) {
                    request_source_rows.push(row);
                } else {
                    linear_order_eligible = false;
                }
                continue;
            }
            let plan = directory.upload_plans[row - collector_rows];
            let entity_index = plan.entity_index as usize;
            let item_id = directory
                .item_id(plan.item_index)
                .ok_or_else(|| anyhow!("native quantum upload item index is invalid"))?;
            let endpoint = entities[entity_index]
                .as_object()
                .ok_or_else(|| anyhow!("native quantum endpoint is invalid"))?;
            let outgoing = route_ledger.quantum_reserved_outgoing(entity_index, item_id);
            let available = floor_u64(
                (item_amount(endpoint, "outputs", item_id)
                    - f64::from(plan.slot.min_stock)
                    - outgoing)
                    .max(0.0),
            );
            if available < 1 {
                continue;
            }
            let key = format!("{}:{item_id}", &state.entities.ids[entity_index]);
            request_rows.insert(key.clone(), row);
            let previous_len = requests.len();
            upsert_request_in_stable_order(
                &mut requests,
                &mut request_positions,
                Request {
                    key,
                    entity_index,
                    item_id: item_id.to_owned(),
                    amount: BigUint::from(available),
                    priority: i64::from(plan.slot.priority),
                },
            );
            if requests.len() == previous_len.saturating_add(1) {
                request_source_rows.push(row);
            } else {
                linear_order_eligible = false;
            }
        }
    } else {
        for &entity_index in indexed_endpoint_indices {
            let endpoint = entities[entity_index]
                .as_object()
                .ok_or_else(|| anyhow!("native quantum endpoint is invalid"))?;
            if !is_quantum_collector(endpoint) {
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
    let linear_allocation_requests = (use_index
        && !upload_scan.dense_fallback
        && !upload_scan.directory_fallback
        && linear_order_eligible
        && requests.len() == request_source_rows.len())
    .then(|| {
        requests_by_topology_rank(
            &requests,
            &request_source_rows,
            &directory.boundary_upload_order_rank,
        )
    })
    .flatten();
    let allocation_requests = if let Some(ordered) = linear_allocation_requests {
        upload_scan.linear_order_rows = ordered.len();
        ordered
    } else {
        upload_scan.full_sort_rows = requests.len();
        let mut ordered = requests.clone();
        sorted_requests(&mut ordered);
        ordered
    };
    let accepted = settle_inputs(
        &mut network,
        &allocation_requests,
        &boundary_capacity(flow.global_upload_per_minute, seconds),
    );
    for request in &requests {
        let amount = accepted.get(&request.key).cloned().unwrap_or_default();
        if use_index
            && amount < request.amount
            && let Some(&row) = request_rows.get(&request.key)
        {
            retain_rows.insert(row);
        }
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
    network.set_runtime_flow(flow);
    write_active_network(base, &network, directory)?;
    if let Some(selected_rows) = selected_rows.as_ref() {
        directory.commit_boundary_upload(selected_rows, retain_rows);
    }
    Ok(upload_scan)
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

fn probe_transition_candidate(
    entity_index: usize,
    entity: &Map<String, Value>,
    quantum_tech_completed: bool,
) -> Option<TransitionCandidate> {
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
    source.map(|source| TransitionCandidate {
        entity_index,
        station_id: string_at(entity, "id").unwrap_or_default().to_owned(),
        source,
    })
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
    TransitionEntityProbe {
        route_memberships,
        candidate: probe_transition_candidate(entity_index, entity, quantum_tech_completed),
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
    probe_transition_patch_for_routes(candidate, routes, elapsed)
}

fn probe_transition_patch_for_routes(
    candidate: &TransitionCandidate,
    routes: &[TransitionRoute],
    elapsed: f64,
) -> anyhow::Result<TransitionPatchProbe> {
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

fn commit_transition_patch_probes(
    base: &mut Map<String, Value>,
    entities: &mut [Value],
    patch_probes: Vec<TransitionPatchProbe>,
    mut diagnostics: TransitionParallelDiagnostics,
) -> anyhow::Result<TransitionParallelDiagnostics> {
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
    #[allow(unused_mut)]
    let mut diagnostics = TransitionParallelDiagnostics::default();
    #[cfg(not(test))]
    #[allow(unused_mut)]
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
    commit_transition_patch_probes(base, entities, patch_probes, diagnostics)
}

fn settle_transitions_indexed_with_runtime(
    deterministic_runtime: &DeterministicRuntime,
    transition_runtime: &mut QuantumTransitionRuntime,
    base: &mut Map<String, Value>,
    entities: &mut [Value],
    route_activity: &crate::interstellar_logistics::InterstellarRouteActivity,
) -> anyhow::Result<(TransitionParallelDiagnostics, QuantumTransitionScan)> {
    let (selected_indices, mut scan) = transition_runtime.scan_indices(entities);
    let Some(selected_indices) = selected_indices else {
        let diagnostics = settle_transitions_with_runtime(deterministic_runtime, base, entities)?;
        *transition_runtime = QuantumTransitionRuntime::build(entities);
        scan.transition_rows = {
            #[cfg(test)]
            {
                diagnostics.transition_probe_count
            }
            #[cfg(not(test))]
            {
                transition_runtime.active_entity_indices.len()
            }
        };
        return Ok((diagnostics, scan));
    };

    let quantum_tech_completed = completed_tech(base, "quantum_logistics_network");
    let candidate_probes =
        deterministic_runtime.indexed_map(&selected_indices, |_, &entity_index| {
            entities
                .get(entity_index)
                .and_then(Value::as_object)
                .and_then(|entity| {
                    probe_transition_candidate(entity_index, entity, quantum_tech_completed)
                })
        });
    let candidates = candidate_probes.into_iter().flatten().collect::<Vec<_>>();
    scan.transition_rows = candidates.len();
    if candidates.is_empty() {
        #[allow(unused_mut)]
        let mut diagnostics = TransitionParallelDiagnostics::default();
        #[cfg(test)]
        {
            diagnostics.entity_probe_count = selected_indices.len();
        }
        return Ok((diagnostics, scan));
    }

    let transition_route_view = route_activity.transition_route_view(entities);
    scan.ledger_fallback = transition_route_view.is_none();
    if transition_route_view.is_none() {
        scan.selected_rows = entities.len();
        let diagnostics = settle_transitions_with_runtime(deterministic_runtime, base, entities)?;
        *transition_runtime = QuantumTransitionRuntime::build(entities);
        scan.transition_rows = {
            #[cfg(test)]
            {
                diagnostics.transition_probe_count
            }
            #[cfg(not(test))]
            {
                transition_runtime.active_entity_indices.len()
            }
        };
        return Ok((diagnostics, scan));
    }
    let transition_route_view = transition_route_view.expect("checked transition route view");
    scan.route_membership_rows = transition_route_view.membership_rows();
    scan.route_validation_rows = route_activity.active_remote_route_demand_indices().len();
    let elapsed = finite_number(base.get("elapsedSeconds"));
    let candidate_routes = candidates
        .iter()
        .map(|candidate| {
            let routes = transition_route_view
                .remote_routes(&candidate.station_id)
                .iter()
                .map(|route| TransitionRoute::from(route.as_ref()))
                .collect::<Vec<_>>();
            (candidate, routes)
        })
        .collect::<Vec<_>>();
    let patch_probes =
        deterministic_runtime.indexed_try_map(&candidate_routes, |_, (candidate, routes)| {
            probe_transition_patch_for_routes(candidate, routes.as_slice(), elapsed)
        })?;
    #[allow(unused_mut)]
    let mut diagnostics = TransitionParallelDiagnostics::default();
    #[cfg(test)]
    {
        diagnostics.entity_probe_count = selected_indices.len();
        diagnostics.route_membership_count = scan.route_membership_rows;
    }
    let diagnostics = commit_transition_patch_probes(base, entities, patch_probes, diagnostics)?;
    transition_runtime.refresh_after_sparse_settlement(entities);
    Ok((diagnostics, scan))
}

pub(crate) fn settle_transitions_indexed(
    transition_runtime: &mut QuantumTransitionRuntime,
    base: &mut Map<String, Value>,
    entities: &mut [Value],
    route_activity: &crate::interstellar_logistics::InterstellarRouteActivity,
) -> anyhow::Result<(bool, QuantumTransitionScan)> {
    settle_transitions_indexed_with_runtime(
        crate::deterministic_runtime::runtime(),
        transition_runtime,
        base,
        entities,
        route_activity,
    )
    .map(|(diagnostics, scan)| (diagnostics.topology_changed, scan))
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

    fn quantum_collector(
        id: impl Into<String>,
        item_id: &str,
        machine_count: f64,
        output: f64,
    ) -> Value {
        serde_json::json!({
            "id": id.into(),
            "kind": "station",
            "planetId": "home",
            "powerGridId": "grid-a",
            "buildingId": "orbital_collector",
            "machineCount": machine_count,
            "quantumMode": "quantum",
            "storedItemId": item_id,
            "inputs": { (item_id): 0 },
            "outputs": { (item_id): output },
            "stationRoutes": [],
            "stationLastTransfer": 0,
            "productionRate": 0,
            "utilization": 0,
            "routingCursor": 0
        })
    }

    fn construction_center(id: impl Into<String>, power_factor: f64) -> Value {
        serde_json::json!({
            "id": id.into(),
            "kind": "machine",
            "planetId": "home",
            "powerGridId": "grid-a",
            "buildingId": "construction_center",
            "recipeId": null,
            "machineCount": 1,
            "inputs": {},
            "outputs": {},
            "powerFactor": power_factor,
            "progress": 0,
            "stationLastTransfer": 0,
            "productionRate": 0,
            "utilization": 0,
            "routingCursor": 0
        })
    }

    fn construction_quantum_fixture(
        center_count: usize,
    ) -> (CoreState, Map<String, Value>, Vec<Value>) {
        let mut entities = vec![quantum_station(
            "quantum-bandwidth",
            "iron_ore",
            "supply",
            0.0,
            0.0,
            vec![],
        )];
        entities.extend(
            (0..center_count).map(|index| construction_center(format!("center-{index:05}"), 1.0)),
        );
        let mut state = crate::simple_factory::tests::fixture_state(&entities);
        let mut catalog = (*state.catalog).clone();
        catalog.constructions.insert(
            "widget".to_owned(),
            crate::catalog::ConstructionDefinition {
                id: "widget".to_owned(),
                output_amount: 1.0,
                automation_order: 0,
                required_tech_id: None,
                costs: vec![crate::catalog::ItemAmount {
                    item_id: "iron_ore".to_owned(),
                    amount: 10.0,
                }],
            },
        );
        state.catalog = Arc::new(catalog);
        assert_eq!(
            state.factory_topology.construction_center_indices.len(),
            center_count
        );
        let jobs = (0..center_count)
            .map(|index| {
                (
                    format!("center-{index:05}"),
                    serde_json::json!({
                        "constructionId": "widget",
                        "steps": [{ "kind": "building", "constructionId": "widget" }],
                        "stepIndex": 0,
                        "elapsedSeconds": 0,
                        "inventory": {},
                        "recipeDecisions": []
                    }),
                )
            })
            .collect::<Map<_, _>>();
        let mut base = active_quantum_base(0);
        base.insert("tray".to_owned(), serde_json::json!({ "iron_ore": 0 }));
        base.insert(
            "planetTrays".to_owned(),
            serde_json::json!({ "home": { "iron_ore": 0 } }),
        );
        base.insert(
            "construction".to_owned(),
            serde_json::json!({ "widget": 0 }),
        );
        base.insert("portableFleet".to_owned(), serde_json::json!({}));
        base.insert(
            "constructionAutomation".to_owned(),
            serde_json::json!({
                "enabled": true,
                "quantumSourceEnabled": true,
                "jobs": jobs,
                "quantumMaterialBuffer": {},
                "targetStock": { "widget": center_count },
                "cursor": 0,
                "totalCrafted": 0,
                "destroyedByproducts": {}
            }),
        );
        set_test_network_item(&mut base, "iron_ore", "1000000");
        (state, base, entities)
    }

    fn set_construction_quantum_item(
        base: &mut Map<String, Value>,
        center_id: &str,
        item_id: &str,
        amount: f64,
    ) {
        let automation = base
            .get_mut("constructionAutomation")
            .and_then(Value::as_object_mut)
            .expect("construction automation");
        let buffers = automation
            .get_mut("quantumMaterialBuffer")
            .and_then(Value::as_object_mut)
            .expect("construction quantum buffers");
        if amount < 1.0 {
            if let Some(buffer) = buffers.get_mut(center_id).and_then(Value::as_object_mut) {
                buffer.remove(item_id);
                if buffer.is_empty() {
                    buffers.remove(center_id);
                }
            }
            return;
        }
        if !buffers.contains_key(center_id) {
            buffers.insert(center_id.to_owned(), Value::Object(Map::new()));
        }
        buffers
            .get_mut(center_id)
            .and_then(Value::as_object_mut)
            .expect("construction center buffer")
            .insert(item_id.to_owned(), Value::from(amount));
    }

    #[allow(clippy::too_many_arguments)]
    fn settle_construction_download_pair(
        state: &CoreState,
        active_base: &mut Map<String, Value>,
        active_entities: &mut [Value],
        oracle_base: &mut Map<String, Value>,
        oracle_entities: &mut [Value],
        directory: &mut QuantumLogisticsDirectory,
        boundary_second: f64,
        seconds: f64,
    ) -> QuantumActiveScan {
        let credits = crate::belts::OutputCredits::default();
        let route_ledger = crate::station_route_ledger::StationRouteLedger::default();
        let (_, scan) = settle_active_downloads(
            state,
            active_base,
            active_entities,
            &credits,
            boundary_second,
            seconds,
            directory,
            &route_ledger,
        )
        .expect("active construction quantum settlement");
        settle_downloads(
            state,
            oracle_base,
            oracle_entities,
            &credits,
            boundary_second,
            seconds,
        )
        .expect("full construction quantum settlement");
        assert_eq!(
            quantum_oracle_bytes(active_base, active_entities),
            quantum_oracle_bytes(oracle_base, oracle_entities),
            "construction quantum boundary {boundary_second} / {seconds}s"
        );
        scan
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

    fn set_test_runtime_flow(base: &mut Map<String, Value>, boundary_second: f64, rows: usize) {
        let uploaded = (0..rows)
            .map(|index| {
                (
                    format!("dormant-upload-{index:05}"),
                    BigUint::from(index + 1),
                )
            })
            .collect();
        let downloaded = (0..rows)
            .map(|index| {
                (
                    format!("dormant-download-{index:05}"),
                    BigUint::from(index + 1),
                )
            })
            .collect();
        let flow = BoundaryFlow {
            boundary_second,
            uploaded,
            downloaded,
            global_upload_per_minute: 5_000.0,
            global_download_per_minute: 5_000.0,
            quantum_tower_stacks: 1.0,
            quantum_collector_stacks: 0.0,
        };
        base.get_mut("quantumLogisticsNetwork")
            .and_then(Value::as_object_mut)
            .expect("quantum test network")
            .insert("runtimeFlow".to_owned(), flow_value(&flow).unwrap());
    }

    fn quantum_oracle_bytes(base: &Map<String, Value>, entities: &[Value]) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({
            "base": base,
            "entities": entities,
        }))
        .unwrap()
    }

    fn settle_upload_boundary(
        state: &CoreState,
        base: &mut Map<String, Value>,
        entities: &mut [Value],
        directory: &mut QuantumLogisticsDirectory,
        boundary_second: f64,
    ) -> QuantumActiveScan {
        base.insert("elapsedSeconds".to_owned(), Value::from(boundary_second));
        let endpoint_indices = state.factory_topology.quantum_endpoint_indices.clone();
        let bandwidth = directory.legacy_runtime_bandwidth(state, base, entities);
        settle_uploads(
            state,
            base,
            entities,
            boundary_second,
            None,
            SETTLEMENT_SECONDS,
            &endpoint_indices,
            directory,
            &crate::station_route_ledger::StationRouteLedger::default(),
            bandwidth,
        )
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

    fn request_signature(requests: &[Request]) -> Vec<(String, String, String, i64)> {
        requests
            .iter()
            .map(|request| {
                (
                    request.key.clone(),
                    request.item_id.clone(),
                    request.amount.to_str_radix(10),
                    request.priority,
                )
            })
            .collect()
    }

    fn next_order_seed(seed: &mut u64) -> u64 {
        *seed = seed
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        *seed
    }

    #[test]
    fn topology_rank_radix_matches_full_sort_for_random_active_subsets() {
        let mut seed = 0x517c_c1b7_2722_0a95_u64;
        for row_count in [1_usize, 2, 17, 257, 4_096] {
            let mut all = Vec::with_capacity(row_count);
            let mut entries = Vec::with_capacity(row_count);
            for row in 0..row_count {
                let random = next_order_seed(&mut seed);
                let priority = (random % 17) as i64 - 8;
                let key = format!("station-{random:016x}-{row:05}:item-{:02}", row % 23);
                entries.push((row, priority, key.clone()));
                all.push(Request {
                    key,
                    entity_index: row,
                    item_id: format!("item-{:02}", row % 23),
                    amount: BigUint::from((random % 10_000) + 1),
                    priority,
                });
            }
            let ranks = build_request_order_rank(entries, row_count).expect("unique ranks");
            for sample in 0..32 {
                let mut active_rows = (0..row_count)
                    .filter(|row| {
                        row_count <= 2
                            || next_order_seed(&mut seed)
                                .wrapping_add(*row as u64)
                                .wrapping_add(sample)
                                % 5
                                != 0
                    })
                    .collect::<Vec<_>>();
                if sample.is_multiple_of(2) {
                    active_rows.reverse();
                }
                let active = active_rows
                    .iter()
                    .map(|&row| all[row].clone())
                    .collect::<Vec<_>>();
                let ordered = requests_by_topology_rank(&active, &active_rows, &ranks)
                    .expect("linear active order");
                let mut oracle = active;
                sorted_requests(&mut oracle);
                assert_eq!(
                    request_signature(&ordered),
                    request_signature(&oracle),
                    "row_count={row_count}, sample={sample}"
                );
            }
        }
    }

    #[test]
    fn topology_rank_order_has_linear_comparison_direction_against_full_sort() {
        let row_count = 8_192_usize;
        let mut seed = 0xa076_1d64_78bd_642f_u64;
        let requests = (0..row_count)
            .map(|row| {
                let random = next_order_seed(&mut seed);
                item_request(
                    &format!("station-{random:016x}-{row:05}:item-{:02}", row % 31),
                    &format!("item-{:02}", row % 31),
                    (random % 10_000) + 1,
                    (random % 29) as i64 - 14,
                )
            })
            .collect::<Vec<_>>();
        let entries = requests
            .iter()
            .enumerate()
            .map(|(row, request)| (row, request.priority, request.key.clone()))
            .collect();
        let ranks = build_request_order_rank(entries, row_count).unwrap();
        let rows = (0..row_count).rev().collect::<Vec<_>>();
        let active = rows
            .iter()
            .map(|&row| requests[row].clone())
            .collect::<Vec<_>>();

        let _ = take_request_order_comparisons();
        let linear = requests_by_topology_rank(&active, &rows, &ranks).unwrap();
        let linear_comparisons = take_request_order_comparisons();
        let mut oracle = active;
        sorted_requests(&mut oracle);
        let full_sort_comparisons = take_request_order_comparisons();

        assert_eq!(request_signature(&linear), request_signature(&oracle));
        assert!(
            linear_comparisons <= row_count,
            "rank path must validate with at most one adjacent comparison per row"
        );
        assert!(
            full_sort_comparisons > linear_comparisons.saturating_mul(2),
            "fixture must prove comparison-sort growth: linear={linear_comparisons}, full={full_sort_comparisons}"
        );
    }

    #[test]
    fn linear_station_construction_merge_preserves_priority_and_fair_cursor_long_run() {
        let station_requests = vec![
            item_request("tower-z:iron_ore", "iron_ore", 97, 1),
            item_request("tower-a:iron_ore", "iron_ore", 113, 3),
            item_request("tower-m:copper_ore", "copper_ore", 71, 1),
            item_request("tower-b:iron_ore", "iron_ore", 89, -2),
        ];
        let entries = station_requests
            .iter()
            .enumerate()
            .map(|(row, request)| (row, request.priority, request.key.clone()))
            .collect();
        let ranks = build_request_order_rank(entries, station_requests.len()).unwrap();
        let station_rows = vec![0, 1, 2, 3];
        let ranked = requests_by_topology_rank(&station_requests, &station_rows, &ranks).unwrap();
        let construction_requests = vec![
            item_request("construction-direct:center-a:iron_ore", "iron_ore", 61, 1),
            item_request("construction-direct:center-z:iron_ore", "iron_ore", 67, 1),
        ];
        let merged = merge_unique_request_streams(ranked, &construction_requests).unwrap();
        let mut oracle = station_requests;
        oracle.extend(construction_requests);
        sorted_requests(&mut oracle);
        assert_eq!(request_signature(&merged), request_signature(&oracle));

        let mut linear_cursor = 0_u64;
        let mut oracle_cursor = 0_u64;
        for step in 0_u64..4_096 {
            let budget = BigUint::from((step.wrapping_mul(37) % 211) + 1);
            let linear = allocate_with_priority(&budget, &merged, linear_cursor);
            let full = allocate_with_priority(&budget, &oracle, oracle_cursor);
            assert_eq!(linear.values, full.values, "allocation step {step}");
            assert_eq!(linear.total, full.total, "total step {step}");
            assert_eq!(linear.next_cursor, full.next_cursor, "cursor step {step}");
            linear_cursor = linear.next_cursor;
            oracle_cursor = full.next_cursor;
        }
    }

    #[test]
    fn duplicate_request_keeps_first_position_and_highest_priority_full_sort_semantics() {
        let mut requests = Vec::new();
        let mut positions = HashMap::new();
        for request in [
            item_request("tower-a:iron_ore", "iron_ore", 7, 1),
            item_request("tower-b:iron_ore", "iron_ore", 11, 2),
            item_request("tower-a:iron_ore", "iron_ore", 13, 5),
            item_request("tower-a:iron_ore", "iron_ore", 17, 4),
        ] {
            upsert_request_in_stable_order(&mut requests, &mut positions, request);
        }
        assert_eq!(requests.len(), 2);
        assert_eq!(requests[0].key, "tower-a:iron_ore");
        assert_eq!(requests[0].priority, 5);
        assert_eq!(requests[0].amount, BigUint::from(13_u8));
        assert!(
            build_request_order_rank(
                vec![
                    (0, 1, "tower-a:iron_ore".to_owned()),
                    (1, 5, "tower-a:iron_ore".to_owned()),
                ],
                2,
            )
            .is_none()
        );
        sorted_requests(&mut requests);
        assert_eq!(requests[0].key, "tower-a:iron_ore");
        assert_eq!(requests[0].priority, 5);
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
    fn sparse_network_write_matches_full_writer_and_survives_reload() {
        let mut sparse_base = active_quantum_base(0);
        let inventory = sparse_base["quantumLogisticsNetwork"]["inventory"]
            .as_object_mut()
            .expect("wide inventory");
        for index in 0..16 {
            inventory.insert(
                format!("item-{index:02}"),
                Value::from(format!("{}", index + 1)),
            );
        }
        inventory.insert("mod:量子/Ω🚀".to_owned(), Value::from("23"));
        inventory.insert("zero-to-remove".to_owned(), Value::from("0"));
        sparse_base["quantumLogisticsNetwork"]["routingCursors"] =
            serde_json::json!({ "item-00": 2 });
        let untouched_pointer = sparse_base["quantumLogisticsNetwork"]["inventory"]["mod:量子/Ω🚀"]
            .as_str()
            .expect("untouched Unicode/MOD value")
            .as_ptr();
        let mut full_base = sparse_base.clone();
        let mut network = parse_network(&sparse_base).expect("canonical sparse network");
        assert!(network.sparse_write_compatible);
        network.set_inventory_amount("item-00", BigUint::from(77_u8));
        network.set_inventory_amount("007/新物料", BigUint::from(31_u8));
        network.remove_zero_inventory();
        network.advance_routing_cursor("item-00");
        network.set_runtime_flow(BoundaryFlow {
            boundary_second: 5.0,
            uploaded: BTreeMap::from([("mod:量子/Ω🚀".to_owned(), BigUint::from(3_u8))]),
            downloaded: BTreeMap::from([("item-00".to_owned(), BigUint::from(5_u8))]),
            global_upload_per_minute: 5_000.0,
            global_download_per_minute: 5_000.0,
            quantum_tower_stacks: 1.0,
            quantum_collector_stacks: -0.0,
        });

        let scan = write_network_with_scan(&mut sparse_base, &network).expect("sparse write");
        write_network_full(&mut full_base, &network).expect("full oracle write");
        assert_eq!(scan.dirty_rows, 4);
        assert_eq!(scan.total_rows, 19);
        assert!(!scan.dense_fallback);
        assert!(!scan.signature_fallback);
        assert_eq!(
            sparse_base["quantumLogisticsNetwork"]["inventory"]["mod:量子/Ω🚀"]
                .as_str()
                .expect("untouched Unicode/MOD value")
                .as_ptr(),
            untouched_pointer,
            "sparse writes must not rebuild untouched inventory values"
        );
        assert_eq!(
            serde_json::to_vec(&sparse_base).expect("sparse bytes"),
            serde_json::to_vec(&full_base).expect("full bytes")
        );

        let serialized = serde_json::to_vec(&sparse_base).expect("serialize sparse network");
        let mut reloaded = serde_json::from_slice::<Value>(&serialized)
            .expect("reload sparse network")
            .as_object()
            .expect("reloaded base")
            .clone();
        let mut reload_oracle = reloaded.clone();
        let mut reloaded_network = parse_network(&reloaded).expect("parse reloaded network");
        assert!(reloaded_network.sparse_write_compatible);
        reloaded_network.set_inventory_amount("item-15", BigUint::from(101_u8));
        let reload_scan =
            write_network_with_scan(&mut reloaded, &reloaded_network).expect("reload sparse write");
        write_network_full(&mut reload_oracle, &reloaded_network)
            .expect("reload full oracle write");
        assert!(!reload_scan.dense_fallback);
        assert!(!reload_scan.signature_fallback);
        assert_eq!(
            serde_json::to_vec(&reloaded).expect("reloaded sparse bytes"),
            serde_json::to_vec(&reload_oracle).expect("reloaded full bytes")
        );
    }

    #[test]
    fn network_sparse_writer_uses_exact_three_quarters_dense_fallback() {
        let mut sparse_base = active_quantum_base(0);
        sparse_base["quantumLogisticsNetwork"]["inventory"] = serde_json::json!({
            "item-0": "1",
            "item-1": "2",
            "item-2": "3",
            "item-3": "4"
        });
        let mut full_base = sparse_base.clone();
        let mut network = parse_network(&sparse_base).expect("dense network");
        for index in 0..3 {
            network.set_inventory_amount(&format!("item-{index}"), BigUint::from(10_u8));
        }
        let scan = write_network_with_scan(&mut sparse_base, &network).expect("dense write");
        write_network_full(&mut full_base, &network).expect("dense full oracle");
        assert_eq!(scan.dirty_rows, 3);
        assert_eq!(scan.total_rows, 4);
        assert!(scan.dense_fallback);
        assert!(!scan.signature_fallback);
        assert_eq!(
            serde_json::to_vec(&sparse_base).expect("dense sparse bytes"),
            serde_json::to_vec(&full_base).expect("dense full bytes")
        );
    }

    #[test]
    fn network_sparse_writer_failure_keeps_source_bytes_unchanged() {
        let mut base = active_quantum_base(0);
        let inventory = base["quantumLogisticsNetwork"]["inventory"]
            .as_object_mut()
            .expect("atomic inventory");
        for index in 0..8 {
            inventory.insert(format!("item-{index}"), Value::from("1"));
        }
        let before = serde_json::to_vec(&base).expect("source bytes before failed write");
        let mut network = parse_network(&base).expect("atomic sparse network");
        network.set_inventory_amount("item-0", BigUint::from(2_u8));
        network.set_runtime_flow(BoundaryFlow {
            boundary_second: 5.0,
            global_upload_per_minute: f64::NAN,
            ..BoundaryFlow::default()
        });

        assert!(write_network_with_scan(&mut base, &network).is_err());
        assert_eq!(
            serde_json::to_vec(&base).expect("source bytes after failed write"),
            before
        );
    }

    #[test]
    fn disabled_noncanonical_network_remains_byte_unchanged() {
        let mut entities = Vec::new();
        let state = crate::simple_factory::tests::fixture_state(&entities);
        let mut base = active_quantum_base(0);
        base["quantumLogisticsNetwork"]["enabled"] = Value::Bool(false);
        base["quantumLogisticsNetwork"]["inventory"]["legacy-negative-zero"] = Value::from(-0.0);
        base["quantumLogisticsNetwork"]["mod:outer/字段"] = Value::from("untouched");
        let before = serde_json::to_vec(&base).expect("disabled source bytes");
        let mut directory = QuantumLogisticsDirectory::build(&state, &entities);

        flush_active_supply_buffers(
            &state,
            &mut base,
            &mut entities,
            &mut directory,
            &crate::station_route_ledger::StationRouteLedger::default(),
            RuntimeBandwidth {
                per_minute: 0.0,
                tower_stacks: 0.0,
                collector_stacks: 0.0,
            },
            false,
        )
        .expect("disabled flush");
        assert_eq!(
            serde_json::to_vec(&base).expect("disabled result bytes"),
            before
        );
    }

    #[test]
    fn network_sparse_writer_fails_closed_for_noncanonical_v47_shapes() {
        let baseline = active_quantum_base(0);
        let mut variants = Vec::new();

        let mut numeric = baseline.clone();
        numeric["quantumLogisticsNetwork"]["inventory"]["legacy-number"] = Value::from(7);
        variants.push(("numeric inventory", numeric));

        let mut negative_zero = baseline.clone();
        negative_zero["quantumLogisticsNetwork"]["inventory"]["negative-zero"] = Value::from(-0.0);
        variants.push(("negative zero", negative_zero));

        let mut fractional = baseline.clone();
        fractional["quantumLogisticsNetwork"]["inventory"]["fractional"] = Value::from(1.25);
        variants.push(("fractional inventory", fractional));

        let mut leading_zero = baseline.clone();
        leading_zero["quantumLogisticsNetwork"]["inventory"]["leading-zero"] = Value::from("0007");
        variants.push(("noncanonical decimal", leading_zero));

        let mut missing = baseline.clone();
        missing["quantumLogisticsNetwork"]
            .as_object_mut()
            .expect("network")
            .remove("uploadRoutingCursors");
        variants.push(("missing field", missing));

        let mut extension = baseline;
        extension["quantumLogisticsNetwork"]["mod:extra/字段"] = Value::from("keep-or-normalize");
        variants.push(("extension field", extension));

        let baseline = active_quantum_base(0);
        for (label, value) in [
            ("numeric capacity", Value::from(20_000)),
            ("capacity below minimum", Value::from("1")),
            ("capacity above maximum", Value::from("10000000001")),
        ] {
            let mut candidate = baseline.clone();
            candidate["quantumLogisticsNetwork"]["itemCapacities"]["iron_ore"] = value;
            variants.push((label, candidate));
        }
        for (label, value) in [
            ("string cursor", Value::from("2")),
            ("negative-zero cursor", Value::from(-0.0)),
            ("fractional cursor", Value::from(1.25)),
            ("unsafe cursor", Value::from(MAX_SAFE_INTEGER + 1)),
        ] {
            let mut candidate = baseline.clone();
            candidate["quantumLogisticsNetwork"]["routingCursors"]["iron_ore"] = value;
            variants.push((label, candidate));
        }
        let canonical_flow = flow_value(&BoundaryFlow {
            boundary_second: 5.0,
            uploaded: BTreeMap::from([("mod:量子/Ω🚀".to_owned(), BigUint::from(2_u8))]),
            downloaded: BTreeMap::new(),
            global_upload_per_minute: 5_000.0,
            global_download_per_minute: 5_000.0,
            quantum_tower_stacks: 1.0,
            quantum_collector_stacks: -0.0,
        })
        .expect("canonical fallback-test flow");
        let mut missing_flow_field = baseline.clone();
        missing_flow_field["quantumLogisticsNetwork"]["runtimeFlow"] = canonical_flow.clone();
        missing_flow_field["quantumLogisticsNetwork"]["runtimeFlow"]
            .as_object_mut()
            .expect("runtime flow")
            .remove("downloaded");
        variants.push(("runtime flow missing field", missing_flow_field));
        let mut extra_flow_field = baseline.clone();
        extra_flow_field["quantumLogisticsNetwork"]["runtimeFlow"] = canonical_flow;
        extra_flow_field["quantumLogisticsNetwork"]["runtimeFlow"]["mod:extra"] = Value::from(1);
        variants.push(("runtime flow extra field", extra_flow_field));
        let mut null_flow = baseline;
        null_flow["quantumLogisticsNetwork"]["runtimeFlow"] = Value::Null;
        variants.push(("null runtime flow", null_flow));

        for (label, mut sparse_base) in variants {
            let mut full_base = sparse_base.clone();
            let mut network = parse_network(&sparse_base).expect(label);
            network.set_inventory_amount("iron_ore", BigUint::from(9_u8));
            let scan = write_network_with_scan(&mut sparse_base, &network).expect(label);
            write_network_full(&mut full_base, &network).expect("full compatibility oracle");
            assert!(scan.signature_fallback, "{label}");
            assert_eq!(
                serde_json::to_vec(&sparse_base).expect("fallback sparse bytes"),
                serde_json::to_vec(&full_base).expect("fallback full bytes"),
                "{label}"
            );
        }
    }

    #[test]
    fn missing_or_nonobject_network_parse_failure_keeps_source_bytes_unchanged() {
        for (label, base) in [
            ("missing", Map::new()),
            (
                "nonobject",
                Map::from_iter([("quantumLogisticsNetwork".to_owned(), Value::from("invalid"))]),
            ),
        ] {
            let before = serde_json::to_vec(&base).expect("parse failure source bytes");
            assert!(parse_network(&base).is_err(), "{label}");
            assert_eq!(
                serde_json::to_vec(&base).expect("parse failure result bytes"),
                before,
                "{label}"
            );
        }
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
    fn compact_directory_accounts_for_all_reverse_indexes_without_plan_strings() {
        let entities = (0_usize..1_024)
            .map(|index| {
                quantum_station(
                    format!("tower-{index}"),
                    "iron_ore",
                    if index.is_multiple_of(2) {
                        "supply"
                    } else {
                        "demand"
                    },
                    0.0,
                    0.0,
                    vec![],
                )
            })
            .collect::<Vec<_>>();
        let state = crate::simple_factory::tests::fixture_state(&entities);
        let directory = QuantumLogisticsDirectory::build(&state, &entities);

        assert!(!directory.fallback_full_scan);
        assert_eq!(directory.item_ids.len(), 1);
        assert_eq!(directory.item_by_id.len(), 1);
        assert!(size_of::<QuantumSlotPlan>() <= 20);
        assert!(size_of::<QuantumCollectorPlan>() <= 12);
        assert_eq!(
            directory.upload_by_station.offsets.len(),
            entities.len() + 1
        );
        assert_eq!(
            directory.download_by_station.offsets.len(),
            entities.len() + 1
        );

        let reverse_index_bytes = directory.upload_by_station.estimated_bytes()
            + directory.upload_by_item.estimated_bytes()
            + directory.collector_by_item.estimated_bytes()
            + directory.download_by_station.estimated_bytes();
        assert!(directory.estimated_bytes() >= reverse_index_bytes);
        assert!(
            directory.estimated_bytes() < entities.len() as u64 * 96,
            "compact directory must not regress to per-plan entity/item/key Strings"
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
    fn sparse_download_uses_linear_order_while_dense_boundary_keeps_full_sort_oracle() {
        let source = (0..16)
            .map(|index| {
                quantum_station(
                    format!("demand-{index:02}"),
                    "iron_ore",
                    "demand",
                    0.0,
                    if index == 0 { 0.0 } else { 1_000_000.0 },
                    vec![],
                )
            })
            .collect::<Vec<_>>();
        let state = crate::simple_factory::tests::fixture_state(&source);
        let mut active_base = active_quantum_base(0);
        set_test_network_item(&mut active_base, "iron_ore", "10000");
        let mut oracle_base = active_base.clone();
        let mut active_entities = source.clone();
        let mut oracle_entities = source;
        let mut directory = QuantumLogisticsDirectory::build(&state, &active_entities);
        let credits = crate::belts::OutputCredits::default();
        let route_ledger = crate::station_route_ledger::StationRouteLedger::default();

        let (_, dense) = settle_active_downloads(
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
            &mut oracle_base,
            &mut oracle_entities,
            &credits,
            5.0,
            5.0,
        )
        .unwrap();
        assert!(dense.dense_fallback);
        assert_eq!(dense.full_sort_rows, 1);
        assert_eq!(dense.linear_order_rows, 0);
        assert_eq!(
            quantum_oracle_bytes(&active_base, &active_entities),
            quantum_oracle_bytes(&oracle_base, &oracle_entities)
        );

        set_test_item(&mut active_entities[0], "outputs", "iron_ore", 0.0);
        set_test_item(&mut oracle_entities[0], "outputs", "iron_ore", 0.0);
        set_test_network_item(&mut active_base, "iron_ore", "31");
        set_test_network_item(&mut oracle_base, "iron_ore", "31");
        directory.wake_from_stations(&[0]);

        let (_, sparse) = settle_active_downloads(
            &state,
            &mut active_base,
            &mut active_entities,
            &credits,
            10.0,
            5.0,
            &mut directory,
            &route_ledger,
        )
        .unwrap();
        settle_downloads(
            &state,
            &mut oracle_base,
            &mut oracle_entities,
            &credits,
            10.0,
            5.0,
        )
        .unwrap();
        assert_eq!(sparse.selected_rows, 1);
        assert!(!sparse.dense_fallback);
        assert!(!sparse.directory_fallback);
        assert_eq!(sparse.linear_order_rows, 1);
        assert_eq!(sparse.full_sort_rows, 0);
        assert_eq!(
            quantum_oracle_bytes(&active_base, &active_entities),
            quantum_oracle_bytes(&oracle_base, &oracle_entities)
        );
    }

    #[test]
    fn sparse_network_parse_matches_full_oracle_at_1_5_and_60_seconds() {
        let source = (0..16)
            .map(|index| {
                quantum_station(
                    format!("demand-{index:02}"),
                    "iron_ore",
                    "demand",
                    0.0,
                    if index == 0 { 0.0 } else { 1_000_000.0 },
                    vec![],
                )
            })
            .collect::<Vec<_>>();
        let state = crate::simple_factory::tests::fixture_state(&source);
        let credits = crate::belts::OutputCredits::default();
        let route_ledger = crate::station_route_ledger::StationRouteLedger::default();

        for seconds in [1.0, 5.0, 60.0] {
            let mut active_base = active_quantum_base(0);
            set_test_network_item(&mut active_base, "iron_ore", "10000");
            let inventory = active_base["quantumLogisticsNetwork"]["inventory"]
                .as_object_mut()
                .expect("network inventory");
            for index in 0..128 {
                inventory.insert(
                    format!("dormant-{index:03}"),
                    Value::from((index + 1).to_string()),
                );
            }
            let mut oracle_base = active_base.clone();
            let mut active_entities = source.clone();
            let mut oracle_entities = source.clone();
            let mut directory = QuantumLogisticsDirectory::build(&state, &active_entities);
            let complete = parse_network(&active_base).expect("canonical network proof");
            directory.network_sparse_proof = NetworkSparseProof::from_complete(&complete);
            directory.download_all_pending = false;
            directory.construction_download_all_pending = false;
            directory.pending_download.insert(0);

            let (_, scan) = settle_active_downloads(
                &state,
                &mut active_base,
                &mut active_entities,
                &credits,
                seconds,
                seconds,
                &mut directory,
                &route_ledger,
            )
            .expect("sparse network download");
            settle_downloads(
                &state,
                &mut oracle_base,
                &mut oracle_entities,
                &credits,
                seconds,
                seconds,
            )
            .expect("full network download oracle");

            assert!(!scan.network_parse_full_scan_fallback, "{seconds}s");
            assert!(
                scan.network_parse_selected_rows < scan.network_parse_total_rows,
                "{seconds}s selected {}/{}",
                scan.network_parse_selected_rows,
                scan.network_parse_total_rows
            );
            assert_eq!(scan.network_parse_selected_rows, 2, "{seconds}s");
            assert_eq!(
                quantum_oracle_bytes(&active_base, &active_entities),
                quantum_oracle_bytes(&oracle_base, &oracle_entities),
                "sparse network parse/full oracle at {seconds}s"
            );
        }
    }

    #[test]
    fn sparse_boundaries_share_dormant_runtime_flow_without_reparse_at_1_5_and_60_seconds() {
        for seconds in [1.0, 5.0, 60.0] {
            let source = (0..16)
                .map(|index| {
                    quantum_station(
                        format!("demand-{index:02}"),
                        "iron_ore",
                        "demand",
                        0.0,
                        if index == 0 { 0.0 } else { 1_000_000.0 },
                        vec![],
                    )
                })
                .collect::<Vec<_>>();
            let state = crate::simple_factory::tests::fixture_state(&source);
            let mut active_base = active_quantum_base(0);
            set_test_network_item(&mut active_base, "iron_ore", "10000");
            for index in 0..128 {
                set_test_network_item(
                    &mut active_base,
                    &format!("dormant-{index:03}"),
                    &(index + 1).to_string(),
                );
            }
            set_test_runtime_flow(&mut active_base, seconds - 1.0, 1_024);
            let mut oracle_base = active_base.clone();
            let mut active_entities = source.clone();
            let mut oracle_entities = source;
            let mut directory = QuantumLogisticsDirectory::build(&state, &active_entities);
            let complete = parse_network(&active_base).expect("canonical flow proof");
            directory.network_sparse_proof = NetworkSparseProof::from_complete(&complete);
            directory.download_all_pending = false;
            directory.construction_download_all_pending = false;
            directory.pending_download.insert(0);
            let credits = crate::belts::OutputCredits::default();
            let route_ledger = crate::station_route_ledger::StationRouteLedger::default();

            take_runtime_flow_parse_rows();
            let (_, scan) = settle_active_downloads(
                &state,
                &mut active_base,
                &mut active_entities,
                &credits,
                seconds,
                seconds,
                &mut directory,
                &route_ledger,
            )
            .expect("sparse cached-flow download");
            let sparse_parse_rows = take_runtime_flow_parse_rows();
            settle_downloads(
                &state,
                &mut oracle_base,
                &mut oracle_entities,
                &credits,
                seconds,
                seconds,
            )
            .expect("full cached-flow oracle");
            let oracle_parse_rows = take_runtime_flow_parse_rows();

            assert!(!scan.network_parse_full_scan_fallback, "{seconds}s");
            assert_eq!(sparse_parse_rows, 0, "{seconds}s");
            assert_eq!(oracle_parse_rows, 2_048, "{seconds}s");
            assert_eq!(
                quantum_oracle_bytes(&active_base, &active_entities),
                quantum_oracle_bytes(&oracle_base, &oracle_entities),
                "cached runtime flow/full oracle at {seconds}s"
            );
        }
    }

    #[test]
    fn runtime_flow_shape_or_scalar_drift_reenters_the_full_oracle() {
        for mutate in [
            |base: &mut Map<String, Value>| {
                base["quantumLogisticsNetwork"]["runtimeFlow"]["uploaded"]
                    .as_object_mut()
                    .expect("uploaded flow")
                    .insert("shape-drift".to_owned(), Value::from("1"));
            },
            |base: &mut Map<String, Value>| {
                base["quantumLogisticsNetwork"]["runtimeFlow"]["boundarySecond"] =
                    Value::from(999.0);
            },
        ] {
            let source = vec![quantum_station(
                "demand",
                "iron_ore",
                "demand",
                0.0,
                0.0,
                vec![],
            )];
            let state = crate::simple_factory::tests::fixture_state(&source);
            let mut active_base = active_quantum_base(0);
            set_test_network_item(&mut active_base, "iron_ore", "10000");
            for index in 0..128 {
                set_test_network_item(
                    &mut active_base,
                    &format!("dormant-{index:03}"),
                    &(index + 1).to_string(),
                );
            }
            set_test_runtime_flow(&mut active_base, 4.0, 64);
            let mut active_entities = source.clone();
            let mut directory = QuantumLogisticsDirectory::build(&state, &active_entities);
            let complete = parse_network(&active_base).expect("canonical flow proof");
            directory.network_sparse_proof = NetworkSparseProof::from_complete(&complete);
            directory.download_all_pending = false;
            directory.construction_download_all_pending = false;
            directory.pending_download.insert(0);
            mutate(&mut active_base);
            let mut oracle_base = active_base.clone();
            let mut oracle_entities = source.clone();
            let credits = crate::belts::OutputCredits::default();
            let route_ledger = crate::station_route_ledger::StationRouteLedger::default();

            let (_, scan) = settle_active_downloads(
                &state,
                &mut active_base,
                &mut active_entities,
                &credits,
                5.0,
                5.0,
                &mut directory,
                &route_ledger,
            )
            .expect("runtime flow drift fallback");
            settle_downloads(
                &state,
                &mut oracle_base,
                &mut oracle_entities,
                &credits,
                5.0,
                5.0,
            )
            .expect("runtime flow drift oracle");
            assert!(scan.network_parse_full_scan_fallback);
            assert_eq!(
                quantum_oracle_bytes(&active_base, &active_entities),
                quantum_oracle_bytes(&oracle_base, &oracle_entities)
            );
        }
    }

    #[test]
    fn noncanonical_selected_network_row_fails_closed_before_mutation() {
        let source = (0..16)
            .map(|index| {
                quantum_station(
                    format!("demand-{index:02}"),
                    "iron_ore",
                    "demand",
                    0.0,
                    if index == 0 { 0.0 } else { 1_000_000.0 },
                    vec![],
                )
            })
            .collect::<Vec<_>>();
        let state = crate::simple_factory::tests::fixture_state(&source);
        let mut active_base = active_quantum_base(0);
        set_test_network_item(&mut active_base, "iron_ore", "10000");
        for index in 0..128 {
            set_test_network_item(
                &mut active_base,
                &format!("dormant-{index:03}"),
                &(index + 1).to_string(),
            );
        }
        let mut active_entities = source.clone();
        let mut directory = QuantumLogisticsDirectory::build(&state, &active_entities);
        let complete = parse_network(&active_base).expect("canonical network proof");
        directory.network_sparse_proof = NetworkSparseProof::from_complete(&complete);
        directory.download_all_pending = false;
        directory.construction_download_all_pending = false;
        directory.pending_download.insert(0);
        active_base["quantumLogisticsNetwork"]["inventory"]["iron_ore"] = Value::from(1.25);
        let mut oracle_base = active_base.clone();
        let mut oracle_entities = source;
        let credits = crate::belts::OutputCredits::default();
        let route_ledger = crate::station_route_ledger::StationRouteLedger::default();

        let (_, scan) = settle_active_downloads(
            &state,
            &mut active_base,
            &mut active_entities,
            &credits,
            5.0,
            5.0,
            &mut directory,
            &route_ledger,
        )
        .expect("fallback network download");
        settle_downloads(
            &state,
            &mut oracle_base,
            &mut oracle_entities,
            &credits,
            5.0,
            5.0,
        )
        .expect("noncanonical full oracle");

        assert!(scan.network_parse_full_scan_fallback);
        assert_eq!(
            scan.network_parse_selected_rows,
            scan.network_parse_total_rows
        );
        assert_eq!(
            quantum_oracle_bytes(&active_base, &active_entities),
            quantum_oracle_bytes(&oracle_base, &oracle_entities)
        );
    }

    #[test]
    fn sparse_network_parse_removes_every_proven_zero_before_active_deposit() {
        let source = (0..16)
            .map(|index| {
                quantum_station(
                    format!("supply-{index:02}"),
                    "iron_ore",
                    "supply",
                    if index == 0 { 17.0 } else { 0.0 },
                    0.0,
                    vec![],
                )
            })
            .collect::<Vec<_>>();
        let state = crate::simple_factory::tests::fixture_state(&source);
        let mut active_base = active_quantum_base(0);
        set_test_network_item(&mut active_base, "iron_ore", "0");
        set_test_network_item(&mut active_base, "mod:dormant-zero/Ω", "0");
        for index in 0..128 {
            set_test_network_item(
                &mut active_base,
                &format!("dormant-{index:03}"),
                &(index + 1).to_string(),
            );
        }
        let mut oracle_base = active_base.clone();
        let mut active_entities = source.clone();
        let mut oracle_entities = source;
        let mut directory = QuantumLogisticsDirectory::build(&state, &active_entities);
        let complete = parse_network(&active_base).expect("canonical network proof");
        directory.network_sparse_proof = NetworkSparseProof::from_complete(&complete);
        directory.flush_all_pending = false;
        directory.pending_flush.insert(0);
        let route_ledger = crate::station_route_ledger::StationRouteLedger::default();
        let bandwidth = directory.legacy_runtime_bandwidth(&state, &active_base, &active_entities);

        let scan = flush_active_supply_buffers(
            &state,
            &mut active_base,
            &mut active_entities,
            &mut directory,
            &route_ledger,
            bandwidth,
            false,
        )
        .expect("sparse zero-normalizing deposit");
        flush_supply_buffers_for_index(&mut oracle_base, &mut oracle_entities, None)
            .expect("full zero-normalizing deposit oracle");

        assert!(!scan.network_parse_full_scan_fallback);
        assert!(scan.network_parse_selected_rows < scan.network_parse_total_rows);
        assert!(
            active_base["quantumLogisticsNetwork"]["inventory"]
                .get("mod:dormant-zero/Ω")
                .is_none()
        );
        assert_eq!(
            quantum_oracle_bytes(&active_base, &active_entities),
            quantum_oracle_bytes(&oracle_base, &oracle_entities)
        );
    }

    #[test]
    fn construction_active_downloads_match_full_scan_bytes_at_1_5_and_60_seconds() {
        for seconds in [1.0, 5.0, 60.0] {
            let (state, source_base, source_entities) = construction_quantum_fixture(8);
            let mut active_base = source_base.clone();
            let mut oracle_base = source_base;
            let mut active_entities = source_entities.clone();
            let mut oracle_entities = source_entities;
            let mut directory = QuantumLogisticsDirectory::build(&state, &active_entities);
            let scan = settle_construction_download_pair(
                &state,
                &mut active_base,
                &mut active_entities,
                &mut oracle_base,
                &mut oracle_entities,
                &mut directory,
                seconds,
                seconds,
            );
            assert_eq!(scan.selected_rows, 8);
            assert_eq!(scan.total_rows, 8);
            assert!(!scan.directory_fallback);
            assert!(scan.dense_fallback);
            assert_eq!(scan.linear_order_rows, 0);
            assert_eq!(scan.full_sort_rows, 8);
        }
    }

    #[test]
    fn construction_sparse_network_write_matches_old_full_oracle_at_1_5_and_60_seconds() {
        for seconds in [1.0, 5.0, 60.0] {
            let (state, mut source_base, source_entities) = construction_quantum_fixture(8);
            let inventory = source_base["quantumLogisticsNetwork"]["inventory"]
                .as_object_mut()
                .expect("construction network inventory");
            for index in 0..24 {
                inventory.insert(
                    format!("inactive-{index:02}"),
                    Value::from(format!("{}", index + 1)),
                );
            }
            inventory.insert("mod:未触发/Ω🚀".to_owned(), Value::from("97"));
            let mut active_base = source_base.clone();
            let mut oracle_base = source_base;
            let mut active_entities = source_entities.clone();
            let mut oracle_entities = source_entities;
            let untouched_pointer =
                active_base["quantumLogisticsNetwork"]["inventory"]["mod:未触发/Ω🚀"]
                    .as_str()
                    .expect("untouched construction item")
                    .as_ptr();
            let mut directory = QuantumLogisticsDirectory::build(&state, &active_entities);

            settle_construction_download_pair(
                &state,
                &mut active_base,
                &mut active_entities,
                &mut oracle_base,
                &mut oracle_entities,
                &mut directory,
                seconds,
                seconds,
            );
            assert_eq!(
                active_base["quantumLogisticsNetwork"]["inventory"]["mod:未触发/Ω🚀"]
                    .as_str()
                    .expect("untouched construction item")
                    .as_ptr(),
                untouched_pointer,
                "{seconds}s active settlement must patch only the dirty inventory key"
            );

            let oracle_network = parse_network(&oracle_base).expect("oracle network");
            write_network_full(&mut oracle_base, &oracle_network).expect("old full writer oracle");
            assert_eq!(
                quantum_oracle_bytes(&active_base, &active_entities),
                quantum_oracle_bytes(&oracle_base, &oracle_entities),
                "sparse/full network writer at {seconds}s"
            );
        }
    }

    #[test]
    fn construction_active_queue_is_quiet_and_reverse_wakes_inventory_and_power() {
        let (state, source_base, source_entities) = construction_quantum_fixture(16);
        let mut active_base = source_base.clone();
        let mut oracle_base = source_base;
        let mut active_entities = source_entities.clone();
        let mut oracle_entities = source_entities;
        let mut directory = QuantumLogisticsDirectory::build(&state, &active_entities);

        let first = settle_construction_download_pair(
            &state,
            &mut active_base,
            &mut active_entities,
            &mut oracle_base,
            &mut oracle_entities,
            &mut directory,
            5.0,
            5.0,
        );
        assert_eq!(first.selected_rows, 16);
        let _ = directory.take_construction_inventory_written_center_indices();
        let retained = settle_construction_download_pair(
            &state,
            &mut active_base,
            &mut active_entities,
            &mut oracle_base,
            &mut oracle_entities,
            &mut directory,
            10.0,
            5.0,
        );
        assert_eq!(retained.selected_rows, 16);
        let _ = directory.take_construction_inventory_written_center_indices();
        let quiet = settle_construction_download_pair(
            &state,
            &mut active_base,
            &mut active_entities,
            &mut oracle_base,
            &mut oracle_entities,
            &mut directory,
            15.0,
            5.0,
        );
        assert_eq!(quiet.selected_rows, 0, "satisfied centers must sleep");
        assert!(
            directory
                .take_construction_inventory_written_center_indices()
                .is_empty()
        );

        set_construction_quantum_item(&mut active_base, "center-00003", "iron_ore", 0.0);
        set_construction_quantum_item(&mut oracle_base, "center-00003", "iron_ore", 0.0);
        let center_entity_index = 4;
        directory.wake_construction_centers(&[center_entity_index]);
        let inventory_wake = settle_construction_download_pair(
            &state,
            &mut active_base,
            &mut active_entities,
            &mut oracle_base,
            &mut oracle_entities,
            &mut directory,
            20.0,
            5.0,
        );
        assert_eq!(inventory_wake.selected_rows, 1);
        assert!(!inventory_wake.dense_fallback);
        assert_eq!(
            directory.take_construction_inventory_written_center_indices(),
            vec![center_entity_index]
        );

        // A demand with no network inventory stays active. Refilling the
        // inventory therefore needs no global construction rescan and still
        // delivers on the next boundary.
        set_construction_quantum_item(&mut active_base, "center-00003", "iron_ore", 0.0);
        set_construction_quantum_item(&mut oracle_base, "center-00003", "iron_ore", 0.0);
        set_test_network_item(&mut active_base, "iron_ore", "0");
        set_test_network_item(&mut oracle_base, "iron_ore", "0");
        directory.wake_construction_centers(&[center_entity_index]);
        let empty_inventory = settle_construction_download_pair(
            &state,
            &mut active_base,
            &mut active_entities,
            &mut oracle_base,
            &mut oracle_entities,
            &mut directory,
            25.0,
            5.0,
        );
        assert_eq!(empty_inventory.selected_rows, 1);
        set_test_network_item(&mut active_base, "iron_ore", "10");
        set_test_network_item(&mut oracle_base, "iron_ore", "10");
        let inventory_refill = settle_construction_download_pair(
            &state,
            &mut active_base,
            &mut active_entities,
            &mut oracle_base,
            &mut oracle_entities,
            &mut directory,
            30.0,
            5.0,
        );
        assert_eq!(inventory_refill.selected_rows, 1);

        set_construction_quantum_item(&mut active_base, "center-00003", "iron_ore", 0.0);
        set_construction_quantum_item(&mut oracle_base, "center-00003", "iron_ore", 0.0);
        active_entities[center_entity_index]["powerFactor"] = Value::from(0.0);
        oracle_entities[center_entity_index]["powerFactor"] = Value::from(0.0);
        directory.wake_construction_centers(&[center_entity_index]);
        let power_off = settle_construction_download_pair(
            &state,
            &mut active_base,
            &mut active_entities,
            &mut oracle_base,
            &mut oracle_entities,
            &mut directory,
            35.0,
            5.0,
        );
        assert_eq!(power_off.selected_rows, 1);
        active_entities[center_entity_index]["powerFactor"] = Value::from(1.0);
        oracle_entities[center_entity_index]["powerFactor"] = Value::from(1.0);
        directory.wake_construction_centers(&[center_entity_index]);
        let power_on = settle_construction_download_pair(
            &state,
            &mut active_base,
            &mut active_entities,
            &mut oracle_base,
            &mut oracle_entities,
            &mut directory,
            40.0,
            5.0,
        );
        assert_eq!(power_on.selected_rows, 1);
    }

    #[test]
    fn construction_capacity_change_rebuild_wakes_and_matches_full_scan() {
        let (state, source_base, mut source_entities) = construction_quantum_fixture(8);
        source_entities[0]["machineCount"] = Value::from(0.0);
        let mut active_base = source_base.clone();
        let mut oracle_base = source_base;
        let mut active_entities = source_entities.clone();
        let mut oracle_entities = source_entities;
        let mut directory = QuantumLogisticsDirectory::build(&state, &active_entities);

        let blocked = settle_construction_download_pair(
            &state,
            &mut active_base,
            &mut active_entities,
            &mut oracle_base,
            &mut oracle_entities,
            &mut directory,
            5.0,
            5.0,
        );
        assert_eq!(blocked.selected_rows, 8);

        // A topology command owns the immutable directory replacement. The
        // replacement both refreshes quantum bandwidth and marks every center
        // pending, so a newly installed tower cannot leave demand asleep.
        active_entities[0]["machineCount"] = Value::from(1.0);
        oracle_entities[0]["machineCount"] = Value::from(1.0);
        directory = QuantumLogisticsDirectory::build(&state, &active_entities);
        let capacity_wake = settle_construction_download_pair(
            &state,
            &mut active_base,
            &mut active_entities,
            &mut oracle_base,
            &mut oracle_entities,
            &mut directory,
            10.0,
            5.0,
        );
        assert_eq!(capacity_wake.selected_rows, 8);
        assert!(!capacity_wake.directory_fallback);
        assert!(
            active_base["constructionAutomation"]["quantumMaterialBuffer"]
                .as_object()
                .is_some_and(|buffers| !buffers.is_empty())
        );
    }

    #[test]
    fn construction_active_queue_uses_exact_three_quarters_dense_fallback() {
        let (state, source_base, source_entities) = construction_quantum_fixture(4);
        let mut active_base = source_base.clone();
        let mut oracle_base = source_base;
        let mut active_entities = source_entities.clone();
        let mut oracle_entities = source_entities;
        let mut directory = QuantumLogisticsDirectory::build(&state, &active_entities);
        for boundary in [5.0, 10.0, 15.0] {
            settle_construction_download_pair(
                &state,
                &mut active_base,
                &mut active_entities,
                &mut oracle_base,
                &mut oracle_entities,
                &mut directory,
                boundary,
                5.0,
            );
        }
        for index in 0..3 {
            let center_id = format!("center-{index:05}");
            set_construction_quantum_item(&mut active_base, &center_id, "iron_ore", 0.0);
            set_construction_quantum_item(&mut oracle_base, &center_id, "iron_ore", 0.0);
        }
        directory.wake_construction_centers(&[1, 2, 3]);
        let dense = settle_construction_download_pair(
            &state,
            &mut active_base,
            &mut active_entities,
            &mut oracle_base,
            &mut oracle_entities,
            &mut directory,
            20.0,
            5.0,
        );
        assert_eq!(dense.selected_rows, 4);
        assert_eq!(dense.total_rows, 4);
        assert!(dense.dense_fallback);
        assert!(!dense.directory_fallback);
    }

    #[test]
    fn construction_directory_mod_catalog_and_topology_mismatch_fail_closed() {
        let (state, source_base, source_entities) = construction_quantum_fixture(2);

        let mut catalog_state = state.clone();
        catalog_state.catalog = Arc::new((*state.catalog).clone());
        let mut catalog_base = source_base.clone();
        let mut catalog_oracle_base = source_base.clone();
        let mut catalog_entities = source_entities.clone();
        let mut catalog_oracle_entities = source_entities.clone();
        let mut catalog_directory = QuantumLogisticsDirectory::build(&state, &source_entities);
        let catalog_scan = settle_construction_download_pair(
            &catalog_state,
            &mut catalog_base,
            &mut catalog_entities,
            &mut catalog_oracle_base,
            &mut catalog_oracle_entities,
            &mut catalog_directory,
            5.0,
            5.0,
        );
        assert!(catalog_scan.directory_fallback);

        let mut topology_base = source_base.clone();
        let mut topology_oracle_base = source_base.clone();
        let mut topology_entities = source_entities.clone();
        let mut topology_oracle_entities = source_entities.clone();
        let mut topology_directory = QuantumLogisticsDirectory::build(&state, &source_entities);
        topology_entities[1]["buildingId"] = Value::from("mod:construction_center");
        topology_oracle_entities[1]["buildingId"] = Value::from("mod:construction_center");
        topology_directory.wake_construction_centers(&[1]);
        let topology_scan = settle_construction_download_pair(
            &state,
            &mut topology_base,
            &mut topology_entities,
            &mut topology_oracle_base,
            &mut topology_oracle_entities,
            &mut topology_directory,
            5.0,
            5.0,
        );
        assert!(topology_scan.directory_fallback);

        let mut mod_entities = source_entities;
        mod_entities[1]["id"] = Value::from("mod:center/Ω");
        let mut mod_state = crate::simple_factory::tests::fixture_state(&mod_entities);
        mod_state.catalog = Arc::clone(&state.catalog);
        let mut mod_base = source_base;
        let jobs = mod_base["constructionAutomation"]["jobs"]
            .as_object_mut()
            .expect("mod jobs");
        let job = jobs.remove("center-00000").expect("original mod job");
        jobs.insert("mod:center/Ω".to_owned(), job);
        let mut mod_oracle_base = mod_base.clone();
        let mut mod_active_entities = mod_entities.clone();
        let mut mod_oracle_entities = mod_entities;
        let mut mod_directory = QuantumLogisticsDirectory::build(&mod_state, &mod_active_entities);
        let mod_scan = settle_construction_download_pair(
            &mod_state,
            &mut mod_base,
            &mut mod_active_entities,
            &mut mod_oracle_base,
            &mut mod_oracle_entities,
            &mut mod_directory,
            5.0,
            5.0,
        );
        assert!(mod_scan.directory_fallback);
    }

    #[test]
    fn construction_persistent_and_segment_rebuilds_are_byte_identical_for_60_seconds() {
        let (state, source_base, source_entities) = construction_quantum_fixture(12);
        let mut persistent_base = source_base.clone();
        let mut rebuilt_base = source_base;
        let mut persistent_entities = source_entities.clone();
        let mut rebuilt_entities = source_entities;
        let mut persistent_directory =
            QuantumLogisticsDirectory::build(&state, &persistent_entities);
        let credits = crate::belts::OutputCredits::default();
        let route_ledger = crate::station_route_ledger::StationRouteLedger::default();
        let mut saw_sparse = false;

        for boundary in (5_u64..=60).step_by(5) {
            if boundary == 20 {
                set_construction_quantum_item(
                    &mut persistent_base,
                    "center-00007",
                    "iron_ore",
                    0.0,
                );
                set_construction_quantum_item(&mut rebuilt_base, "center-00007", "iron_ore", 0.0);
                persistent_directory.wake_construction_centers(&[8]);
            }
            if boundary == 35 {
                persistent_entities[8]["powerFactor"] = Value::from(0.0);
                rebuilt_entities[8]["powerFactor"] = Value::from(0.0);
                persistent_directory.wake_construction_centers(&[8]);
            }
            if boundary == 45 {
                persistent_entities[8]["powerFactor"] = Value::from(1.0);
                rebuilt_entities[8]["powerFactor"] = Value::from(1.0);
                persistent_directory.wake_construction_centers(&[8]);
            }
            let (_, scan) = settle_active_downloads(
                &state,
                &mut persistent_base,
                &mut persistent_entities,
                &credits,
                boundary as f64,
                5.0,
                &mut persistent_directory,
                &route_ledger,
            )
            .unwrap();
            let mut rebuilt_directory = QuantumLogisticsDirectory::build(&state, &rebuilt_entities);
            settle_active_downloads(
                &state,
                &mut rebuilt_base,
                &mut rebuilt_entities,
                &credits,
                boundary as f64,
                5.0,
                &mut rebuilt_directory,
                &route_ledger,
            )
            .unwrap();
            saw_sparse |= scan.selected_rows < scan.total_rows;
            assert_eq!(
                quantum_oracle_bytes(&persistent_base, &persistent_entities),
                quantum_oracle_bytes(&rebuilt_base, &rebuilt_entities),
                "segmented construction boundary {boundary}"
            );
        }
        assert!(saw_sparse);
    }

    #[test]
    fn boundary_upload_directory_is_quiet_and_one_collector_wake_is_o_one() {
        let mut source = (0..32)
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
        source
            .extend((0..16).map(|index| {
                quantum_collector(format!("collector-{index}"), "iron_ore", 0.0, 0.0)
            }));
        let state = crate::simple_factory::tests::fixture_state(&source);
        let mut active_base = active_quantum_base(0);
        let mut oracle_base = active_base.clone();
        let mut active_entities = source.clone();
        let mut oracle_entities = source;
        let mut active_directory = QuantumLogisticsDirectory::build(&state, &active_entities);
        let mut oracle_directory = QuantumLogisticsDirectory::build(&state, &oracle_entities);
        oracle_directory.fallback_full_scan = true;

        let initial = settle_upload_boundary(
            &state,
            &mut active_base,
            &mut active_entities,
            &mut active_directory,
            5.0,
        );
        settle_upload_boundary(
            &state,
            &mut oracle_base,
            &mut oracle_entities,
            &mut oracle_directory,
            5.0,
        );
        assert_eq!(initial.selected_rows, 48);
        assert_eq!(
            quantum_oracle_bytes(&active_base, &active_entities),
            quantum_oracle_bytes(&oracle_base, &oracle_entities)
        );

        let quiet = settle_upload_boundary(
            &state,
            &mut active_base,
            &mut active_entities,
            &mut active_directory,
            10.0,
        );
        settle_upload_boundary(
            &state,
            &mut oracle_base,
            &mut oracle_entities,
            &mut oracle_directory,
            10.0,
        );
        assert_eq!(quiet.selected_rows, 0);
        assert_eq!(quiet.total_rows, 48);
        assert!(!quiet.dense_fallback);
        assert!(!quiet.directory_fallback);
        assert_eq!(
            quantum_oracle_bytes(&active_base, &active_entities),
            quantum_oracle_bytes(&oracle_base, &oracle_entities)
        );

        let collector_entity_index = 39;
        set_test_item(
            &mut active_entities[collector_entity_index],
            "outputs",
            "iron_ore",
            9.0,
        );
        set_test_item(
            &mut oracle_entities[collector_entity_index],
            "outputs",
            "iron_ore",
            9.0,
        );
        active_directory.wake_from_stations(&[collector_entity_index]);
        let woken = settle_upload_boundary(
            &state,
            &mut active_base,
            &mut active_entities,
            &mut active_directory,
            15.0,
        );
        settle_upload_boundary(
            &state,
            &mut oracle_base,
            &mut oracle_entities,
            &mut oracle_directory,
            15.0,
        );
        assert_eq!(woken.selected_rows, 1);
        assert_eq!(woken.linear_order_rows, 1);
        assert_eq!(woken.full_sort_rows, 0);
        assert_eq!(
            quantum_oracle_bytes(&active_base, &active_entities),
            quantum_oracle_bytes(&oracle_base, &oracle_entities)
        );

        let quiet_again = settle_upload_boundary(
            &state,
            &mut active_base,
            &mut active_entities,
            &mut active_directory,
            20.0,
        );
        settle_upload_boundary(
            &state,
            &mut oracle_base,
            &mut oracle_entities,
            &mut oracle_directory,
            20.0,
        );
        assert_eq!(quiet_again.selected_rows, 0);
        assert_eq!(
            quantum_oracle_bytes(&active_base, &active_entities),
            quantum_oracle_bytes(&oracle_base, &oracle_entities)
        );
    }

    #[test]
    fn boundary_upload_directory_uses_dense_fallback_at_three_quarters() {
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
        let mut active_base = active_quantum_base(0);
        let mut oracle_base = active_base.clone();
        let mut active_entities = source.clone();
        let mut oracle_entities = source;
        let mut active_directory = QuantumLogisticsDirectory::build(&state, &active_entities);
        let mut oracle_directory = QuantumLogisticsDirectory::build(&state, &oracle_entities);
        oracle_directory.fallback_full_scan = true;
        settle_upload_boundary(
            &state,
            &mut active_base,
            &mut active_entities,
            &mut active_directory,
            5.0,
        );
        settle_upload_boundary(
            &state,
            &mut oracle_base,
            &mut oracle_entities,
            &mut oracle_directory,
            5.0,
        );

        for entity_index in 0..3 {
            set_test_item(
                &mut active_entities[entity_index],
                "outputs",
                "iron_ore",
                1.0,
            );
            set_test_item(
                &mut oracle_entities[entity_index],
                "outputs",
                "iron_ore",
                1.0,
            );
        }
        active_directory.wake_from_stations(&[0, 1, 2]);
        let scan = settle_upload_boundary(
            &state,
            &mut active_base,
            &mut active_entities,
            &mut active_directory,
            10.0,
        );
        settle_upload_boundary(
            &state,
            &mut oracle_base,
            &mut oracle_entities,
            &mut oracle_directory,
            10.0,
        );
        assert_eq!(scan.selected_rows, 4);
        assert_eq!(scan.total_rows, 4);
        assert!(scan.dense_fallback);
        assert!(!scan.directory_fallback);
        assert_eq!(scan.linear_order_rows, 0);
        assert_eq!(scan.full_sort_rows, 0);
        assert_eq!(
            quantum_oracle_bytes(&active_base, &active_entities),
            quantum_oracle_bytes(&oracle_base, &oracle_entities)
        );
    }

    #[test]
    fn boundary_upload_mod_rows_fail_closed_to_full_scan() {
        let source = vec![quantum_station(
            "mod-station",
            "mod:量子矿石/Ω",
            "supply",
            0.0,
            7.0,
            vec![],
        )];
        let state = crate::simple_factory::tests::fixture_state(&source);
        let mut indexed_base = active_quantum_base(0);
        let mut oracle_base = indexed_base.clone();
        let mut indexed_entities = source.clone();
        let mut oracle_entities = source;
        let mut indexed_directory = QuantumLogisticsDirectory::build(&state, &indexed_entities);
        let mut oracle_directory = QuantumLogisticsDirectory::build(&state, &oracle_entities);
        oracle_directory.fallback_full_scan = true;
        let scan = settle_upload_boundary(
            &state,
            &mut indexed_base,
            &mut indexed_entities,
            &mut indexed_directory,
            5.0,
        );
        settle_upload_boundary(
            &state,
            &mut oracle_base,
            &mut oracle_entities,
            &mut oracle_directory,
            5.0,
        );
        assert!(scan.directory_fallback);
        assert_eq!(scan.linear_order_rows, 0);
        assert_eq!(scan.full_sort_rows, 0);
        assert_eq!(
            quantum_oracle_bytes(&indexed_base, &indexed_entities),
            quantum_oracle_bytes(&oracle_base, &oracle_entities)
        );
    }

    #[test]
    fn boundary_upload_persistent_and_segment_rebuilds_are_byte_identical() {
        let mut source = (0..8)
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
        source.push(quantum_collector("collector-a", "iron_ore", 0.0, 6_000.0));
        source.push(quantum_collector("collector-b", "iron_ore", 0.0, 5_000.0));
        let state = crate::simple_factory::tests::fixture_state(&source);
        let mut persistent_base = active_quantum_base(0);
        for index in 0..128 {
            set_test_network_item(
                &mut persistent_base,
                &format!("dormant-{index:03}"),
                &(index + 1).to_string(),
            );
        }
        let mut segmented_base = persistent_base.clone();
        let mut persistent_entities = source.clone();
        let mut segmented_entities = source;
        let mut persistent_directory =
            QuantumLogisticsDirectory::build(&state, &persistent_entities);
        let mut saw_sparse = false;

        for boundary in [5.0, 10.0, 15.0, 20.0] {
            if boundary == 10.0 {
                set_test_item(&mut persistent_entities[3], "outputs", "iron_ore", 17.0);
                set_test_item(&mut segmented_entities[3], "outputs", "iron_ore", 17.0);
                persistent_directory.wake_from_stations(&[3]);
            }
            let scan = settle_upload_boundary(
                &state,
                &mut persistent_base,
                &mut persistent_entities,
                &mut persistent_directory,
                boundary,
            );
            let mut segmented_directory =
                QuantumLogisticsDirectory::build(&state, &segmented_entities);
            let rebuilt_scan = settle_upload_boundary(
                &state,
                &mut segmented_base,
                &mut segmented_entities,
                &mut segmented_directory,
                boundary,
            );
            saw_sparse |= scan.selected_rows < scan.total_rows;
            if boundary > 5.0 {
                assert!(
                    !scan.network_parse_full_scan_fallback,
                    "persistent boundary {boundary} should retain its network proof"
                );
                assert!(
                    scan.network_parse_selected_rows < scan.network_parse_total_rows,
                    "persistent boundary {boundary}"
                );
            }
            assert!(
                rebuilt_scan.network_parse_full_scan_fallback,
                "directory rebuild boundary {boundary} must re-establish the proof"
            );
            assert_eq!(
                quantum_oracle_bytes(&persistent_base, &persistent_entities),
                quantum_oracle_bytes(&segmented_base, &segmented_entities),
                "boundary {boundary}"
            );
        }
        assert!(saw_sparse);
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
        let fractional_flush_rows = directory
            .selected_flush_plans(&state, &active_entities, false)
            .0
            .expect("fractional flush directory");
        assert!(selected_flush_has_fractional_cargo(
            &directory,
            &fractional_flush_rows,
            &route_ledger
        ));
        let fractional_download_rows = directory
            .selected_download_plans(&state, &active_entities)
            .0
            .expect("fractional download directory");
        assert!(selected_download_has_fractional_cargo(
            &directory,
            &fractional_download_rows,
            &route_ledger
        ));
        let bandwidth = directory.legacy_runtime_bandwidth(&state, &active_base, &active_entities);
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
        assert!(flush_scan.network_parse_full_scan_fallback);
        flush_supply_buffers_for_index(&mut full_base, &mut full_entities, None).unwrap();
        assert_eq!(
            quantum_oracle_bytes(&active_base, &active_entities),
            quantum_oracle_bytes(&full_base, &full_entities)
        );

        let credits = crate::belts::OutputCredits::default();
        let (_, download_scan) = settle_active_downloads(
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
        assert!(download_scan.network_parse_full_scan_fallback);
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
        let (selected, upload_scan) = directory.selected_boundary_upload_rows(&state, &mismatched);
        assert!(selected.is_none());
        assert!(upload_scan.directory_fallback);

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

    fn indexed_transition_activity(
        _state: &CoreState,
        entities: &[Value],
    ) -> crate::interstellar_logistics::InterstellarRouteActivity {
        crate::interstellar_logistics::prepare_route_activity(entities)
    }

    fn sparse_transition_fixture(row_count: usize) -> Vec<Value> {
        let mut entities = (0..row_count)
            .map(|index| {
                serde_json::json!({
                    "id": format!("quiet-{index:05}"),
                    "kind": "machine",
                    "planetId": "home",
                    "powerGridId": "grid-a",
                    "machineCount": 1,
                    "inputs": {},
                    "outputs": {}
                })
            })
            .collect::<Vec<_>>();
        entities[7] = serde_json::json!({
            "id": "planned-z",
            "kind": "machine",
            "planetId": "home",
            "buildingId": "interstellar_logistics_station",
            "stationTier": 2,
            "quantumMode": "legacy",
            "quantumTarget": true,
            "quantumTransition": null,
            "stationRoutes": []
        });
        entities[509] = serde_json::json!({
            "id": "active-a",
            "kind": "machine",
            "planetId": "home",
            "buildingId": "interstellar_logistics_station",
            "stationTier": 2,
            "quantumMode": "transitioning",
            "quantumTransition": {
                "targetMode": "legacy",
                "startedAtSecond": 0,
                "boundarySecond": 20,
                "bridges": []
            },
            "stationRoutes": []
        });
        entities[777] = serde_json::json!({
            "id": "route-demand",
            "kind": "station",
            "planetId": "home",
            "buildingId": "interstellar_logistics_station",
            "stationRoutes": [{
                "id": "route-planned",
                "scope": "remote",
                "peerId": "planned-z",
                "vehicleStationId": "active-a",
                "waypointStationIds": ["planned-z"],
                "itemId": "iron_ore",
                "cargo": 17,
                "duration": 9,
                "progress": 0.25
            }]
        });
        entities
    }

    #[test]
    fn sparse_transition_runtime_matches_full_oracle_at_one_five_and_sixty_seconds() {
        for elapsed in [1.0, 5.0, 60.0] {
            let source = sparse_transition_fixture(1_024);
            let state = crate::simple_factory::tests::fixture_state(&source);
            let mut expected_base = transition_base(elapsed);
            let mut expected_entities = source.clone();
            settle_transitions_with_runtime(
                &DeterministicRuntime::for_test(4),
                &mut expected_base,
                &mut expected_entities,
            )
            .unwrap();

            let mut actual_base = transition_base(elapsed);
            let mut actual_entities = source;
            let ledger = indexed_transition_activity(&state, &actual_entities);
            let mut transition_runtime = QuantumTransitionRuntime::build(&actual_entities);
            let (diagnostics, scan) = settle_transitions_indexed_with_runtime(
                &DeterministicRuntime::for_test(4),
                &mut transition_runtime,
                &mut actual_base,
                &mut actual_entities,
                &ledger,
            )
            .unwrap();
            assert_eq!(actual_base, expected_base, "elapsed {elapsed}");
            assert_eq!(actual_entities, expected_entities, "elapsed {elapsed}");
            assert_eq!(scan.selected_rows, 2);
            assert_eq!(scan.total_rows, 1_024);
            assert!(!scan.dense_fallback);
            assert!(!scan.runtime_fallback);
            assert!(!scan.ledger_fallback);
            assert_eq!(scan.transition_rows, 2);
            assert_eq!(scan.route_membership_rows, 3);
            assert_eq!(scan.route_validation_rows, 1);
            assert_eq!(scan.route_rebuild_rows, 0);
            assert_eq!(diagnostics.entity_probe_count, 2);
            assert_eq!(transition_runtime.active_row_count(), 2);
        }
    }

    #[test]
    fn sparse_transition_runtime_is_segment_and_reload_stable_without_route_rebuilds() {
        let source = sparse_transition_fixture(1_024);
        let mut oracle_base = transition_base(0.0);
        let mut oracle_entities = source.clone();
        let mut indexed_base = oracle_base.clone();
        let mut indexed_entities = source;
        let mut transition_runtime = QuantumTransitionRuntime::build(&indexed_entities);
        let mut route_activity =
            crate::interstellar_logistics::prepare_route_activity(&indexed_entities);

        for elapsed in (5..=60).step_by(5) {
            oracle_base.insert("elapsedSeconds".to_owned(), Value::from(elapsed as f64));
            indexed_base.insert("elapsedSeconds".to_owned(), Value::from(elapsed as f64));
            settle_transitions_with_runtime(
                &DeterministicRuntime::for_test(4),
                &mut oracle_base,
                &mut oracle_entities,
            )
            .unwrap();
            let (_, scan) = settle_transitions_indexed_with_runtime(
                &DeterministicRuntime::for_test(4),
                &mut transition_runtime,
                &mut indexed_base,
                &mut indexed_entities,
                &route_activity,
            )
            .unwrap();
            assert_eq!(indexed_base, oracle_base, "elapsed {elapsed}");
            assert_eq!(indexed_entities, oracle_entities, "elapsed {elapsed}");
            assert_eq!(scan.route_rebuild_rows, 0);
            assert_eq!(scan.route_validation_rows, 1);

            if elapsed == 30 {
                indexed_base = serde_json::from_slice(
                    &serde_json::to_vec(&indexed_base).expect("serialize transition base"),
                )
                .expect("reload transition base");
                indexed_entities = serde_json::from_slice(
                    &serde_json::to_vec(&indexed_entities).expect("serialize transition entities"),
                )
                .expect("reload transition entities");
                transition_runtime = QuantumTransitionRuntime::build(&indexed_entities);
                route_activity =
                    crate::interstellar_logistics::prepare_route_activity(&indexed_entities);
            }
        }
    }

    #[test]
    fn transition_runtime_dense_mod_and_entity_drift_use_exact_full_oracle() {
        let dense = (0..100)
            .map(|index| {
                if index < 75 {
                    transition_station(format!("dense-{index:03}"), index)
                } else {
                    serde_json::json!({ "id": format!("quiet-{index:03}") })
                }
            })
            .collect::<Vec<_>>();
        let mut cases = vec![(dense, "dense")];
        let mut modded = sparse_transition_fixture(1_024);
        modded[509]["buildingId"] = Value::from("MOD/quantum-station");
        cases.push((modded, "mod"));
        let drift_source = sparse_transition_fixture(1_024);
        cases.push((drift_source, "drift"));

        for (source, label) in cases {
            let state = crate::simple_factory::tests::fixture_state(&source);
            let mut expected_base = transition_base(11.0);
            let mut expected_entities = source.clone();
            if label == "drift" {
                expected_entities.push(serde_json::json!({ "id": "late-row" }));
            }
            settle_transitions_with_runtime(
                &DeterministicRuntime::for_test(4),
                &mut expected_base,
                &mut expected_entities,
            )
            .unwrap();

            let mut actual_base = transition_base(11.0);
            let mut actual_entities = source.clone();
            let mut transition_runtime = QuantumTransitionRuntime::build(&actual_entities);
            if label == "drift" {
                actual_entities.push(serde_json::json!({ "id": "late-row" }));
            }
            let ledger = indexed_transition_activity(&state, &actual_entities);
            let (_, scan) = settle_transitions_indexed_with_runtime(
                &DeterministicRuntime::for_test(4),
                &mut transition_runtime,
                &mut actual_base,
                &mut actual_entities,
                &ledger,
            )
            .unwrap();
            assert_eq!(actual_base, expected_base, "{label}");
            assert_eq!(actual_entities, expected_entities, "{label}");
            assert_eq!(scan.selected_rows, actual_entities.len(), "{label}");
            match label {
                "dense" => assert!(scan.dense_fallback),
                "mod" | "drift" => assert!(scan.runtime_fallback),
                _ => unreachable!(),
            }
        }
    }

    #[test]
    fn transition_route_runtime_opaque_dense_and_drift_use_full_oracle() {
        let mut opaque = sparse_transition_fixture(1_024);
        opaque[777]["kind"] = Value::from("machine");

        let mut dense = sparse_transition_fixture(1_024);
        for (index, entity) in dense.iter_mut().enumerate().take(769) {
            if matches!(index, 7 | 509) {
                continue;
            }
            *entity = serde_json::json!({
                "id": format!("dense-route-{index:03}"),
                "kind": "station",
                "buildingId": "interstellar_logistics_station",
                "stationRoutes": [{
                    "id": format!("route-{index:03}"),
                    "scope": "remote",
                    "peerId": "planned-z",
                    "vehicleStationId": "active-a",
                    "waypointStationIds": [],
                    "itemId": "iron_ore",
                    "cargo": 1,
                    "duration": 9,
                    "progress": 0.25
                }]
            });
        }

        for (source, label) in [(opaque, "opaque"), (dense, "dense-route")] {
            let mut expected_base = transition_base(11.0);
            let mut expected_entities = source.clone();
            settle_transitions_with_runtime(
                &DeterministicRuntime::for_test(4),
                &mut expected_base,
                &mut expected_entities,
            )
            .unwrap();
            let mut actual_base = transition_base(11.0);
            let mut actual_entities = source;
            let mut transition_runtime = QuantumTransitionRuntime::build(&actual_entities);
            let activity = crate::interstellar_logistics::prepare_route_activity(&actual_entities);
            let (_, scan) = settle_transitions_indexed_with_runtime(
                &DeterministicRuntime::for_test(4),
                &mut transition_runtime,
                &mut actual_base,
                &mut actual_entities,
                &activity,
            )
            .unwrap();
            assert_eq!(actual_base, expected_base, "{label}");
            assert_eq!(actual_entities, expected_entities, "{label}");
            assert!(scan.ledger_fallback, "{label}");
            assert_eq!(scan.selected_rows, actual_entities.len(), "{label}");
        }

        let mut drifted = sparse_transition_fixture(1_024);
        let activity = crate::interstellar_logistics::prepare_route_activity(&drifted);
        drifted[777]["stationRoutes"][0]["progress"] = Value::from(0.75);
        let mut expected_base = transition_base(11.0);
        let mut expected_entities = drifted.clone();
        settle_transitions_with_runtime(
            &DeterministicRuntime::for_test(4),
            &mut expected_base,
            &mut expected_entities,
        )
        .unwrap();
        let mut actual_base = transition_base(11.0);
        let mut transition_runtime = QuantumTransitionRuntime::build(&drifted);
        let (_, scan) = settle_transitions_indexed_with_runtime(
            &DeterministicRuntime::for_test(4),
            &mut transition_runtime,
            &mut actual_base,
            &mut drifted,
            &activity,
        )
        .unwrap();
        assert_eq!(actual_base, expected_base);
        assert_eq!(drifted, expected_entities);
        assert!(scan.ledger_fallback);
        assert_eq!(scan.selected_rows, drifted.len());
    }

    #[test]
    fn sparse_transition_failure_preserves_source_bytes_and_runtime_index() {
        let mut entities = sparse_transition_fixture(1_024);
        entities[509]["quantumTransition"]["bridges"] = serde_json::json!([7]);
        let state = crate::simple_factory::tests::fixture_state(&entities);
        let ledger = indexed_transition_activity(&state, &entities);
        let mut base = transition_base(11.0);
        let source_base = base.clone();
        let source_entities = entities.clone();
        let source_bytes = transition_bytes(&base, &entities);
        let mut transition_runtime = QuantumTransitionRuntime::build(&entities);
        let source_active_rows = transition_runtime.active_row_count();
        let error = settle_transitions_indexed_with_runtime(
            &DeterministicRuntime::for_test(4),
            &mut transition_runtime,
            &mut base,
            &mut entities,
            &ledger,
        )
        .unwrap_err();
        assert_eq!(
            error.to_string(),
            "native quantum transition bridge is invalid"
        );
        assert_eq!(base, source_base);
        assert_eq!(entities, source_entities);
        assert_eq!(transition_bytes(&base, &entities), source_bytes);
        assert_eq!(transition_runtime.active_row_count(), source_active_rows);
    }

    #[test]
    fn missing_transition_route_view_falls_back_to_full_oracle() {
        let source = sparse_transition_fixture(1_024);
        let mut expected_base = transition_base(11.0);
        let mut expected_entities = source.clone();
        settle_transitions_with_runtime(
            &DeterministicRuntime::for_test(4),
            &mut expected_base,
            &mut expected_entities,
        )
        .unwrap();

        let mut actual_base = transition_base(11.0);
        let mut actual_entities = source;
        let mut transition_runtime = QuantumTransitionRuntime::build(&actual_entities);
        let (_, scan) = settle_transitions_indexed_with_runtime(
            &DeterministicRuntime::for_test(4),
            &mut transition_runtime,
            &mut actual_base,
            &mut actual_entities,
            &crate::interstellar_logistics::InterstellarRouteActivity::default(),
        )
        .unwrap();
        assert_eq!(actual_base, expected_base);
        assert_eq!(actual_entities, expected_entities);
        assert_eq!(scan.selected_rows, 1_024);
        assert!(scan.ledger_fallback);
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

    #[test]
    fn flush_plan_validation_keeps_first_selected_failure_at_all_worker_limits() {
        let count = crate::deterministic_runtime::PARALLEL_MIN_ITEMS + 2_117;
        let selected = (0..count).rev().collect::<Vec<_>>();
        let first_invalid = selected[117];
        let later_invalid = selected[4_913];
        let selected_before = selected.clone();

        for workers in [1, 2, 4, 8] {
            let saw_worker = std::sync::atomic::AtomicBool::new(false);
            let actual = first_invalid_selected_plan_with_runtime(
                &selected,
                &DeterministicRuntime::for_test(workers),
                &|plan_index| {
                    if rayon::current_thread_index().is_some() {
                        saw_worker.store(true, std::sync::atomic::Ordering::Relaxed);
                    }
                    plan_index != first_invalid && plan_index != later_invalid
                },
            );
            assert_eq!(actual, Some(first_invalid), "worker limit {workers}");
            assert_eq!(
                saw_worker.load(std::sync::atomic::Ordering::Relaxed),
                workers != 1,
                "worker limit {workers}"
            );
            assert_eq!(selected, selected_before, "worker limit {workers}");
        }
    }

    #[test]
    fn flush_plan_validation_keeps_small_batches_serial_and_accepts_all_valid() {
        let count = crate::deterministic_runtime::PARALLEL_MIN_ITEMS - 1;
        let selected = (0..count).collect::<Vec<_>>();
        let saw_worker = std::sync::atomic::AtomicBool::new(false);
        let actual = first_invalid_selected_plan_with_runtime(
            &selected,
            &DeterministicRuntime::for_test(8),
            &|_| {
                if rayon::current_thread_index().is_some() {
                    saw_worker.store(true, std::sync::atomic::Ordering::Relaxed);
                }
                true
            },
        );
        assert_eq!(actual, None);
        assert!(!saw_worker.load(std::sync::atomic::Ordering::Relaxed));
    }
}
