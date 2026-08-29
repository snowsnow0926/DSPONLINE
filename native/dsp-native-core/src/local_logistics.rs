use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use anyhow::{anyhow, bail};
use serde_json::{Map, Number, Value, json};

use crate::deterministic_runtime::{DeterministicRuntime, runtime as deterministic_runtime};
use crate::state::CoreState;
#[cfg(test)]
use crate::state::ExactRowIdIndex;
use crate::station_route_ledger::StationRouteLedger;

const EPSILON: f64 = 0.0001;
const SLOT_COUNT: usize = 5;
const DRONES_PER_BUILDING: f64 = 50.0;
const CARGO_PER_DRONE: f64 = 25.0;
const BASE_TRIP_SECONDS: f64 = 8.0;
const LOCAL_ROUTE_DENSE_NUMERATOR: usize = 3;
const LOCAL_ROUTE_DENSE_DENOMINATOR: usize = 4;
const LOCAL_READY_DENSE_NUMERATOR: usize = 3;
const LOCAL_READY_DENSE_DENOMINATOR: usize = 4;
const LOCAL_DISPATCH_DENSE_NUMERATOR: usize = 3;
const LOCAL_DISPATCH_DENSE_DENOMINATOR: usize = 4;

#[derive(Debug, Clone)]
struct Slot {
    item_id: Option<Arc<str>>,
    local_mode: LocalMode,
    minimum_load: f64,
    min_stock: f64,
    max_stock: f64,
    priority: u8,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum LocalMode {
    Supply,
    Demand,
    Storage,
}

impl LocalMode {
    fn parse(value: &str) -> anyhow::Result<Self> {
        match value {
            "supply" => Ok(Self::Supply),
            "demand" => Ok(Self::Demand),
            "storage" => Ok(Self::Storage),
            _ => bail!("native local station mode is invalid"),
        }
    }
}

#[cfg(test)]
#[derive(Debug, Default)]
struct Ledger {
    busy: HashMap<usize, f64>,
    reserved: HashMap<usize, HashMap<String, f64>>,
    in_flight: HashMap<usize, HashMap<String, f64>>,
    active_vehicle_load: HashMap<usize, f64>,
    active_local_stations: HashSet<usize>,
    active_local_progress: HashMap<usize, f64>,
}

trait LocalLedgerView: Sync {
    fn local_busy(&self, station_index: usize) -> f64;
    fn in_flight(&self, station_index: usize, item_id: &str) -> f64;
    fn is_active_local_station(&self, station_index: usize) -> bool;
    #[cfg(test)]
    fn active_local_progress(&self, station_index: usize) -> f64;
}

trait LocalDispatchLedger: LocalLedgerView {
    fn reserved(&self, station_index: usize, item_id: &str) -> f64;
    fn active_vehicle_load(&self, station_index: usize) -> f64;
    #[allow(clippy::too_many_arguments)]
    fn record_dispatch(
        &mut self,
        demand_index: usize,
        supply_index: usize,
        owner_index: usize,
        item_id: &str,
        cargo: f64,
        vehicles: f64,
        progress: f64,
    );
}

#[cfg(test)]
impl LocalLedgerView for Ledger {
    fn local_busy(&self, station_index: usize) -> f64 {
        self.busy.get(&station_index).copied().unwrap_or(0.0)
    }

    fn in_flight(&self, station_index: usize, item_id: &str) -> f64 {
        ledger_item_amount(&self.in_flight, station_index, item_id)
    }

    fn is_active_local_station(&self, station_index: usize) -> bool {
        self.active_local_stations.contains(&station_index)
    }

    #[cfg(test)]
    fn active_local_progress(&self, station_index: usize) -> f64 {
        self.active_local_progress
            .get(&station_index)
            .copied()
            .unwrap_or(0.0)
    }
}

#[cfg(test)]
impl LocalDispatchLedger for Ledger {
    fn reserved(&self, station_index: usize, item_id: &str) -> f64 {
        ledger_item_amount(&self.reserved, station_index, item_id)
    }

    fn active_vehicle_load(&self, station_index: usize) -> f64 {
        self.active_vehicle_load
            .get(&station_index)
            .copied()
            .unwrap_or(0.0)
    }

    fn record_dispatch(
        &mut self,
        demand_index: usize,
        supply_index: usize,
        owner_index: usize,
        item_id: &str,
        cargo: f64,
        vehicles: f64,
        _progress: f64,
    ) {
        *self.busy.entry(owner_index).or_default() += vehicles;
        add_ledger_item_amount(&mut self.reserved, supply_index, item_id, cargo);
        add_ledger_item_amount(&mut self.in_flight, demand_index, item_id, cargo);
        for station_index in HashSet::from([demand_index, supply_index, owner_index]) {
            *self.active_vehicle_load.entry(station_index).or_default() += vehicles;
        }
    }
}

impl LocalLedgerView for StationRouteLedger {
    fn local_busy(&self, station_index: usize) -> f64 {
        StationRouteLedger::local_busy_floor(self, station_index)
    }

    fn in_flight(&self, station_index: usize, item_id: &str) -> f64 {
        StationRouteLedger::local_in_flight(self, station_index, item_id)
    }

    fn is_active_local_station(&self, station_index: usize) -> bool {
        StationRouteLedger::is_active_local_station(self, station_index)
    }

    #[cfg(test)]
    fn active_local_progress(&self, station_index: usize) -> f64 {
        StationRouteLedger::active_local_progress(self, station_index)
    }
}

impl LocalDispatchLedger for StationRouteLedger {
    fn reserved(&self, station_index: usize, item_id: &str) -> f64 {
        StationRouteLedger::local_reserved(self, station_index, item_id)
    }

    fn active_vehicle_load(&self, station_index: usize) -> f64 {
        StationRouteLedger::local_active_vehicle_load(self, station_index)
    }

    fn record_dispatch(
        &mut self,
        demand_index: usize,
        supply_index: usize,
        owner_index: usize,
        item_id: &str,
        cargo: f64,
        vehicles: f64,
        progress: f64,
    ) {
        StationRouteLedger::record_local_dispatch(
            self,
            demand_index,
            supply_index,
            owner_index,
            item_id,
            cargo,
            vehicles,
            progress,
        );
    }
}

#[cfg(test)]
fn ledger_item_amount(
    values: &HashMap<usize, HashMap<String, f64>>,
    station_index: usize,
    item_id: &str,
) -> f64 {
    values
        .get(&station_index)
        .and_then(|items| items.get(item_id))
        .copied()
        .unwrap_or(0.0)
}

#[cfg(test)]
fn add_ledger_item_amount(
    values: &mut HashMap<usize, HashMap<String, f64>>,
    station_index: usize,
    item_id: &str,
    amount: f64,
) {
    let items = values.entry(station_index).or_default();
    if let Some(current) = items.get_mut(item_id) {
        *current += amount;
    } else {
        items.insert(item_id.to_owned(), amount);
    }
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
    let value = Number::from_f64(value)
        .map(Value::Number)
        .ok_or_else(|| anyhow!("native local logistics produced a non-finite number"))?;
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
        .ok_or_else(|| anyhow!("native local logistics inventory is missing"))?;
    let amount = Number::from_f64(amount)
        .map(Value::Number)
        .ok_or_else(|| anyhow!("native local logistics inventory is non-finite"))?;
    if let Some(current) = inventory.get_mut(item_id) {
        *current = amount;
    } else {
        inventory.insert(item_id.to_owned(), amount);
    }
    Ok(())
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

fn slots_with_item_symbols(
    entity: &Map<String, Value>,
    item_symbols: &mut HashMap<String, Arc<str>>,
) -> anyhow::Result<Vec<Slot>> {
    let values = entity
        .get("stationSlots")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("native local station slots are missing"))?;
    if values.len() != SLOT_COUNT {
        bail!("native local station slot count is invalid");
    }
    values
        .iter()
        .map(|value| {
            let slot = value
                .as_object()
                .ok_or_else(|| anyhow!("native local station slot is invalid"))?;
            let local_mode = LocalMode::parse(string_at(slot, "localMode").unwrap_or("storage"))?;
            let minimum_load = finite_number(slot.get("minimumLoad"));
            if ![0.1, 0.25, 0.5, 1.0]
                .iter()
                .any(|value| (minimum_load - value).abs() <= f64::EPSILON)
            {
                bail!("native local station minimum load is invalid");
            }
            let item_id = string_at(slot, "itemId").map(|item_id| {
                if let Some(symbol) = item_symbols.get(item_id) {
                    Arc::clone(symbol)
                } else {
                    let symbol = Arc::<str>::from(item_id);
                    item_symbols.insert(item_id.to_owned(), Arc::clone(&symbol));
                    symbol
                }
            });
            Ok(Slot {
                item_id,
                local_mode,
                minimum_load,
                min_stock: finite_number(slot.get("minStock")).floor().max(0.0),
                max_stock: finite_number(slot.get("maxStock")).floor().max(0.0),
                priority: slot
                    .get("priority")
                    .and_then(Value::as_u64)
                    .unwrap_or(1)
                    .min(2) as u8,
            })
        })
        .collect()
}

fn slots(entity: &Map<String, Value>) -> anyhow::Result<Vec<Slot>> {
    slots_with_item_symbols(entity, &mut HashMap::new())
}

fn station_indices(entities: &[Value]) -> Vec<usize> {
    entities
        .iter()
        .enumerate()
        .filter_map(|(index, entity)| {
            entity.as_object().and_then(|object| {
                let building = string_at(object, "buildingId");
                (string_at(object, "kind") == Some("station")
                    && matches!(
                        building,
                        Some("planetary_logistics_station" | "interstellar_logistics_station")
                    )
                    && !(building == Some("interstellar_logistics_station")
                        && finite_number(object.get("stationTier")).floor() == 2.0
                        && string_at(object, "stationOperationMode") == Some("elevator")))
                .then_some(index)
            })
        })
        .collect()
}

#[derive(Debug, Clone, Default)]
pub(crate) struct LocalPeerDirectory {
    station_indices: Arc<[usize]>,
    runtime_station_indices: Arc<[usize]>,
    station_ranks: Arc<HashMap<usize, usize>>,
    by_planet_item: Arc<HashMap<usize, HashMap<Arc<str>, LocalPeers>>>,
    station_slots: Arc<HashMap<usize, Vec<Slot>>>,
    slot_item_allocation_bytes: usize,
    station_planets: Arc<HashMap<usize, usize>>,
    has_local_pair: bool,
    local_waiting_station_indices: Arc<[usize]>,
    local_route_demand_indices: Vec<usize>,
    buffer_active_station_indices: Vec<usize>,
    buffer_activity_initialized: bool,
    /// Stations that were inventory/capacity ready at the previous power
    /// boundary. They remain active while unpowered so a later grid recovery
    /// can be observed without scanning every dormant station.
    ready_station_indices: Vec<usize>,
    /// Stable topology-order rows whose readiness may have changed since the
    /// previous probe. Reverse peer expansion is installed only after the
    /// inventory mutation that produced the wake has succeeded.
    pending_readiness_station_indices: Vec<usize>,
    readiness_all_pending: bool,
    readiness_full_scan_required: bool,
    readiness_signature: Option<LocalReadinessSignature>,
    /// Stable topology-order demand rows whose local dispatch eligibility may
    /// have changed. Supply-side inventory and vehicle changes are expanded
    /// through `by_planet_item`, so sources never become outer work rows.
    pending_dispatch_demand_indices: Vec<usize>,
    /// Represents the initial/topology-reset wake without cloning the full
    /// immutable demand index into every retained revision.
    dispatch_all_pending: bool,
    /// Opaque/MOD route shapes or an inexact immutable directory retain the
    /// legacy complete station order. Once observed, the cache stays closed.
    dispatch_full_scan_required: bool,
    /// Local station rows that had usable power at the previous successful
    /// dispatch boundary. A false -> true edge wakes the exact paired demand
    /// rows even when no inventory changed in that step.
    powered_dispatch_station_indices: Vec<usize>,
    runtime_reset_station_indices: Vec<usize>,
    local_congestion_reset_station_indices: Vec<usize>,
    interstellar_congestion_reset_station_indices: Vec<usize>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct LocalReadinessSignature {
    cargo_capacity_bits: u64,
    buffer_limit_bits: u64,
}

impl LocalReadinessSignature {
    fn capture(base: &Map<String, Value>) -> Self {
        Self {
            cargo_capacity_bits: cargo_capacity(base).to_bits(),
            buffer_limit_bits: normalized_buffer_limit(base).to_bits(),
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct LocalReadyStationScan {
    pub selected_station_rows: usize,
    pub total_station_rows: usize,
    pub dense_fallback: bool,
    pub directory_fallback: bool,
    pub signature_fallback: bool,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct LocalDispatchScan {
    pub selected_station_rows: usize,
    pub total_station_rows: usize,
    pub selected_demand_rows: usize,
    pub total_demand_rows: usize,
    pub dense_fallback: bool,
    pub directory_fallback: bool,
}

impl LocalPeerDirectory {
    pub(crate) fn estimated_bytes(&self) -> u64 {
        let station_index_bytes = self.station_indices.len() * std::mem::size_of::<usize>()
            + self.runtime_station_indices.len() * std::mem::size_of::<usize>()
            + self.local_waiting_station_indices.len() * std::mem::size_of::<usize>()
            + (self.local_route_demand_indices.capacity()
                + self.buffer_active_station_indices.capacity()
                + self.ready_station_indices.capacity()
                + self.pending_readiness_station_indices.capacity()
                + self.pending_dispatch_demand_indices.capacity()
                + self.powered_dispatch_station_indices.capacity()
                + self.runtime_reset_station_indices.capacity()
                + self.local_congestion_reset_station_indices.capacity()
                + self
                    .interstellar_congestion_reset_station_indices
                    .capacity())
                * std::mem::size_of::<usize>();
        let planet_item_bytes = self
            .by_planet_item
            .values()
            .map(|items| {
                items.capacity()
                    * (std::mem::size_of::<(Arc<str>, LocalPeers)>() + std::mem::size_of::<u8>())
                    + items
                        .values()
                        .map(|peers| {
                            (peers.supply.capacity() + peers.demand.capacity())
                                * std::mem::size_of::<(usize, usize)>()
                        })
                        .sum::<usize>()
            })
            .sum::<usize>();
        let slot_bytes = self
            .station_slots
            .values()
            .map(|slots| slots.capacity() * std::mem::size_of::<Slot>())
            .sum::<usize>()
            + self.slot_item_allocation_bytes;
        let hash_entry_bytes = self.by_planet_item.capacity()
            * (std::mem::size_of::<(usize, HashMap<Arc<str>, LocalPeers>)>()
                + std::mem::size_of::<u8>())
            + self.station_slots.capacity()
                * (std::mem::size_of::<(usize, Vec<Slot>)>() + std::mem::size_of::<u8>())
            + self.station_planets.capacity()
                * (std::mem::size_of::<(usize, usize)>() + std::mem::size_of::<u8>())
            + self.station_ranks.capacity()
                * (std::mem::size_of::<(usize, usize)>() + std::mem::size_of::<u8>());
        (station_index_bytes + planet_item_bytes + slot_bytes + hash_entry_bytes) as u64
    }

    fn has_local_routes(&self) -> bool {
        !self.local_route_demand_indices.is_empty()
    }

    fn has_local_pair(&self) -> bool {
        self.has_local_pair
    }

    pub(crate) fn active_local_route_demand_indices(&self) -> &[usize] {
        &self.local_route_demand_indices
    }

    pub(crate) fn contains_local_station(&self, station_index: usize) -> bool {
        self.station_ranks.contains_key(&station_index)
    }

    pub(crate) fn shared_station_ranks(&self) -> Arc<HashMap<usize, usize>> {
        Arc::clone(&self.station_ranks)
    }

    /// Append the exact local power rows that can become dispatchable when
    /// one of `changed_station_indices` mutates after readiness was sampled.
    /// Non-local rows are irrelevant. A missing indexed local row signals a
    /// stale or incomplete directory so the caller can fail closed.
    pub(crate) fn append_station_power_dependencies(
        &self,
        changed_station_indices: &[usize],
        target: &mut Vec<usize>,
    ) -> bool {
        let mut dependency_keys = Vec::new();
        let mut seen_dependency_keys = HashSet::new();
        for &station_index in changed_station_indices {
            if !self.station_ranks.contains_key(&station_index) {
                continue;
            }
            let Some(station_slots) = self.station_slots.get(&station_index) else {
                return false;
            };
            let Some(planet_key) = self.station_planets.get(&station_index).copied() else {
                return false;
            };
            target.push(station_index);
            for slot in station_slots {
                let Some(item_id) = slot.item_id.as_deref() else {
                    continue;
                };
                if slot.local_mode == LocalMode::Storage {
                    continue;
                }
                let key = (planet_key, item_id, slot.local_mode);
                if seen_dependency_keys.insert(key) {
                    dependency_keys.push(key);
                }
            }
        }
        // A dense initial refill wake commonly contains both endpoints of the
        // same item bucket. Expand each immutable bucket/direction once so a
        // same-item fanout remains linear instead of transiently materializing
        // one peer list per changed station.
        for (planet_key, item_id, local_mode) in dependency_keys {
            let Some(peers) = self
                .by_planet_item
                .get(&planet_key)
                .and_then(|items| items.get(item_id))
            else {
                return false;
            };
            let opposite = match local_mode {
                LocalMode::Supply => peers.demand.as_slice(),
                LocalMode::Demand => peers.supply.as_slice(),
                LocalMode::Storage => unreachable!("storage slots were filtered"),
            };
            target.extend(opposite.iter().map(|(peer_index, _)| *peer_index));
        }
        true
    }

    /// Append demand rows whose local dispatch eligibility can change when
    /// one of the supplied station rows changes. Demand-side capacity and
    /// vehicle changes wake that row; supply-side inventory and vehicle
    /// changes follow the immutable `(planet, item)` reverse directory.
    fn append_dispatch_demand_dependencies(
        &self,
        changed_station_indices: &[usize],
        target: &mut Vec<usize>,
    ) -> bool {
        let mut dependency_keys = Vec::new();
        let mut seen_dependency_keys = HashSet::new();
        for &station_index in changed_station_indices {
            if !self.station_ranks.contains_key(&station_index) {
                continue;
            }
            let Some(station_slots) = self.station_slots.get(&station_index) else {
                return false;
            };
            let Some(planet_key) = self.station_planets.get(&station_index).copied() else {
                return false;
            };
            for slot in station_slots {
                let Some(item_id) = slot.item_id.as_deref() else {
                    continue;
                };
                if slot.local_mode == LocalMode::Storage {
                    continue;
                }
                // A parsed non-storage slot must always be represented in the
                // immutable peer directory, including a one-sided bucket.
                if self
                    .by_planet_item
                    .get(&planet_key)
                    .and_then(|items| items.get(item_id))
                    .is_none()
                {
                    return false;
                }
                match slot.local_mode {
                    LocalMode::Demand => {
                        if self
                            .local_waiting_station_indices
                            .binary_search(&station_index)
                            .is_ok()
                        {
                            target.push(station_index);
                        }
                    }
                    LocalMode::Supply => {
                        let key = (planet_key, item_id);
                        if seen_dependency_keys.insert(key) {
                            dependency_keys.push(key);
                        }
                    }
                    LocalMode::Storage => unreachable!("storage slots were filtered"),
                }
            }
        }
        for (planet_key, item_id) in dependency_keys {
            let Some(peers) = self
                .by_planet_item
                .get(&planet_key)
                .and_then(|items| items.get(item_id))
            else {
                return false;
            };
            target.extend(peers.demand.iter().filter_map(|(demand_index, _)| {
                self.local_waiting_station_indices
                    .binary_search(demand_index)
                    .is_ok()
                    .then_some(*demand_index)
            }));
        }
        true
    }

    fn force_full_readiness(&mut self) {
        self.readiness_full_scan_required = true;
        self.readiness_all_pending = true;
        self.pending_readiness_station_indices.clear();
    }

    fn force_full_dispatch(&mut self) {
        self.dispatch_full_scan_required = true;
        self.dispatch_all_pending = true;
        self.pending_dispatch_demand_indices.clear();
    }

    fn wake_dispatch_from_changed_stations(&mut self, changed_station_indices: &[usize]) {
        if self.dispatch_all_pending || self.dispatch_full_scan_required {
            return;
        }
        let mut dependencies = Vec::new();
        if !self.append_dispatch_demand_dependencies(changed_station_indices, &mut dependencies)
            || dependencies.iter().any(|index| {
                self.local_waiting_station_indices
                    .binary_search(index)
                    .is_err()
            })
        {
            self.force_full_dispatch();
            return;
        }
        self.pending_dispatch_demand_indices.extend(dependencies);
        self.pending_dispatch_demand_indices
            .sort_by_key(|index| self.station_ranks.get(index).copied().unwrap_or(usize::MAX));
        self.pending_dispatch_demand_indices.dedup();
    }

    /// Wake the exact local endpoints whose inventory, capacity, vehicle
    /// availability or route reservation can be affected by these station
    /// rows. Any stale reverse key fails closed to the persisted full order.
    pub(crate) fn wake_ready_from_changed_stations(&mut self, changed_station_indices: &[usize]) {
        // Dispatch happens after readiness in the production step. Retain an
        // independent wake so a late belt/quantum/capacity change cannot be
        // consumed by the earlier readiness probe.
        self.wake_dispatch_from_changed_stations(changed_station_indices);
        if self.readiness_all_pending || self.readiness_full_scan_required {
            return;
        }
        let mut dependencies = Vec::new();
        if !self.append_station_power_dependencies(changed_station_indices, &mut dependencies) {
            self.force_full_readiness();
            return;
        }
        if dependencies
            .iter()
            .any(|index| !self.station_ranks.contains_key(index))
        {
            self.force_full_readiness();
            return;
        }
        self.pending_readiness_station_indices.extend(dependencies);
        self.pending_readiness_station_indices
            .sort_by_key(|index| self.station_ranks.get(index).copied().unwrap_or(usize::MAX));
        self.pending_readiness_station_indices.dedup();
    }

    fn readiness_scan_indices(
        &self,
        base: &Map<String, Value>,
        ledger: &StationRouteLedger,
    ) -> (Vec<usize>, LocalReadinessSignature, LocalReadyStationScan) {
        let signature = LocalReadinessSignature::capture(base);
        let signature_fallback = self.readiness_signature != Some(signature);
        let mut directory_fallback = self.readiness_full_scan_required;
        let mut selected = Vec::new();
        if !directory_fallback && !self.readiness_all_pending && !signature_fallback {
            selected.extend_from_slice(&self.ready_station_indices);
            selected.extend_from_slice(&self.pending_readiness_station_indices);
            selected.extend(
                ledger
                    .active_station_indices()
                    .into_iter()
                    .filter(|index| self.station_ranks.contains_key(index)),
            );
            directory_fallback |= selected
                .iter()
                .any(|index| !self.station_ranks.contains_key(index));
            selected
                .sort_by_key(|index| self.station_ranks.get(index).copied().unwrap_or(usize::MAX));
            selected.dedup();
        }
        let dense_fallback = !directory_fallback
            && !self.readiness_all_pending
            && !signature_fallback
            && !selected.is_empty()
            && selected.len().saturating_mul(LOCAL_READY_DENSE_DENOMINATOR)
                >= self
                    .station_indices
                    .len()
                    .saturating_mul(LOCAL_READY_DENSE_NUMERATOR);
        if directory_fallback || self.readiness_all_pending || signature_fallback || dense_fallback
        {
            selected.clear();
            selected.extend_from_slice(&self.station_indices);
        }
        let scan = LocalReadyStationScan {
            selected_station_rows: selected.len(),
            total_station_rows: self.station_indices.len(),
            dense_fallback,
            directory_fallback,
            signature_fallback,
        };
        (selected, signature, scan)
    }

    fn commit_readiness(&mut self, planned: &[Option<usize>], signature: LocalReadinessSignature) {
        let planned_ready = planned.iter().flatten().copied().collect::<Vec<_>>();
        // Inventory-ready rows are deliberately independent of power. Keeping
        // their demand closure pending ensures an unpowered pair is retried at
        // the next grid boundary, while a same-step recovery is also caught by
        // the explicit dispatch power edge below.
        self.wake_dispatch_from_changed_stations(&planned_ready);
        self.ready_station_indices.clear();
        self.ready_station_indices.extend(planned_ready);
        self.pending_readiness_station_indices.clear();
        self.readiness_all_pending = false;
        self.readiness_signature = Some(signature);
    }

    fn plan_dispatch_power_wakes(
        &self,
        powers: &HashMap<usize, f64>,
    ) -> (Vec<usize>, Vec<usize>, bool) {
        let mut next_powered = powers
            .iter()
            .filter_map(|(station_index, power)| {
                (*power > EPSILON && self.station_ranks.contains_key(station_index))
                    .then_some(*station_index)
            })
            .collect::<Vec<_>>();
        next_powered
            .sort_by_key(|index| self.station_ranks.get(index).copied().unwrap_or(usize::MAX));
        next_powered.dedup();
        let mut directory_fallback = self
            .powered_dispatch_station_indices
            .iter()
            .any(|index| !self.station_ranks.contains_key(index));
        let recovered = next_powered
            .iter()
            .copied()
            .filter(|index| {
                self.powered_dispatch_station_indices
                    .binary_search(index)
                    .is_err()
            })
            .collect::<Vec<_>>();
        let mut dependencies = Vec::new();
        directory_fallback |=
            !self.append_dispatch_demand_dependencies(&recovered, &mut dependencies);
        dependencies
            .sort_by_key(|index| self.station_ranks.get(index).copied().unwrap_or(usize::MAX));
        dependencies.dedup();
        directory_fallback |= dependencies.iter().any(|index| {
            self.local_waiting_station_indices
                .binary_search(index)
                .is_err()
        });
        (next_powered, dependencies, directory_fallback)
    }

    fn dispatch_scan_indices(
        &self,
        power_wakes: &[usize],
        power_directory_fallback: bool,
        force_full_scan: bool,
    ) -> (Vec<usize>, LocalDispatchScan) {
        let total_station_rows = self.station_indices.len();
        let total_demand_rows = self.local_waiting_station_indices.len();
        let mut directory_fallback = self.dispatch_full_scan_required
            || power_directory_fallback
            || self.pending_dispatch_demand_indices.iter().any(|index| {
                self.local_waiting_station_indices
                    .binary_search(index)
                    .is_err()
            });
        let mut selected = if self.dispatch_all_pending {
            self.local_waiting_station_indices.to_vec()
        } else {
            self.pending_dispatch_demand_indices.clone()
        };
        if !directory_fallback {
            selected.extend_from_slice(power_wakes);
            selected
                .sort_by_key(|index| self.station_ranks.get(index).copied().unwrap_or(usize::MAX));
            selected.dedup();
            directory_fallback |= selected.iter().any(|index| {
                self.local_waiting_station_indices
                    .binary_search(index)
                    .is_err()
            });
        }
        let selected_demand_rows = selected.len();
        let dense_fallback = !force_full_scan
            && !directory_fallback
            && !selected.is_empty()
            && selected
                .len()
                .saturating_mul(LOCAL_DISPATCH_DENSE_DENOMINATOR)
                >= total_station_rows.saturating_mul(LOCAL_DISPATCH_DENSE_NUMERATOR);
        if force_full_scan || directory_fallback || dense_fallback {
            selected.clear();
            selected.extend_from_slice(&self.station_indices);
        }
        let scan = LocalDispatchScan {
            selected_station_rows: selected.len(),
            total_station_rows,
            selected_demand_rows,
            total_demand_rows,
            dense_fallback,
            directory_fallback,
        };
        (selected, scan)
    }

    fn commit_dispatch(
        &mut self,
        next_powered: Vec<usize>,
        activated_local_demands: &[usize],
        directory_fallback: bool,
    ) {
        self.pending_dispatch_demand_indices.clear();
        self.dispatch_all_pending = false;
        self.powered_dispatch_station_indices = next_powered;
        if directory_fallback {
            self.force_full_dispatch();
        }
        for &demand_index in activated_local_demands {
            self.update_local_route_demand(demand_index, true);
        }
    }

    pub(crate) fn runtime_reset_station_indices(&self) -> &[usize] {
        &self.runtime_reset_station_indices
    }

    pub(crate) fn replace_runtime_reset_station_indices(
        &mut self,
        mut station_indices: Vec<usize>,
    ) {
        station_indices.sort_unstable();
        station_indices.dedup();
        debug_assert!(
            station_indices
                .iter()
                .all(|index| { self.runtime_station_indices.binary_search(index).is_ok() })
        );
        self.runtime_reset_station_indices = station_indices;
    }

    pub(crate) fn local_waiting_station_indices(&self) -> &[usize] {
        &self.local_waiting_station_indices
    }

    pub(crate) fn has_local_peer_match(
        &self,
        station_index: usize,
        slot_index: usize,
    ) -> anyhow::Result<bool> {
        has_peer_match(self, station_index, slot_index)
    }

    pub(crate) fn local_congestion_reset_station_indices(&self) -> &[usize] {
        &self.local_congestion_reset_station_indices
    }

    pub(crate) fn replace_local_congestion_reset_station_indices(
        &mut self,
        mut station_indices: Vec<usize>,
    ) {
        station_indices.sort_unstable();
        station_indices.dedup();
        debug_assert!(
            station_indices
                .iter()
                .all(|index| self.station_indices.binary_search(index).is_ok())
        );
        self.local_congestion_reset_station_indices = station_indices;
    }

    pub(crate) fn interstellar_congestion_reset_station_indices(&self) -> &[usize] {
        &self.interstellar_congestion_reset_station_indices
    }

    pub(crate) fn replace_interstellar_congestion_reset_station_indices(
        &mut self,
        mut station_indices: Vec<usize>,
    ) {
        station_indices.sort_unstable();
        station_indices.dedup();
        debug_assert!(
            station_indices
                .iter()
                .all(|index| self.runtime_station_indices.binary_search(index).is_ok())
        );
        self.interstellar_congestion_reset_station_indices = station_indices;
    }

    fn route_scan_indices(&self) -> (Vec<usize>, bool) {
        let active = self.local_route_demand_indices.len();
        let total = self.station_indices.len();
        let dense = active > 0
            && active.saturating_mul(LOCAL_ROUTE_DENSE_DENOMINATOR)
                >= total.saturating_mul(LOCAL_ROUTE_DENSE_NUMERATOR);
        if dense {
            (self.station_indices.to_vec(), true)
        } else {
            (self.local_route_demand_indices.clone(), false)
        }
    }

    fn buffer_scan_indices(&self) -> (Vec<usize>, bool) {
        if !self.buffer_activity_initialized {
            return (self.station_indices.to_vec(), true);
        }
        let active = self.buffer_active_station_indices.len();
        let total = self.station_indices.len();
        let dense = active > 0
            && active.saturating_mul(LOCAL_ROUTE_DENSE_DENOMINATOR)
                >= total.saturating_mul(LOCAL_ROUTE_DENSE_NUMERATOR);
        if dense {
            (self.station_indices.to_vec(), true)
        } else {
            (self.buffer_active_station_indices.clone(), false)
        }
    }

    fn update_local_route_demand(&mut self, station_index: usize, active: bool) {
        let Some(rank) = self.station_ranks.get(&station_index).copied() else {
            return;
        };
        match (
            self.local_route_demand_indices
                .binary_search_by_key(&rank, |candidate| {
                    self.station_ranks
                        .get(candidate)
                        .copied()
                        .unwrap_or(usize::MAX)
                }),
            active,
        ) {
            (Ok(position), false) => {
                self.local_route_demand_indices.remove(position);
            }
            (Err(position), true) => {
                self.local_route_demand_indices
                    .insert(position, station_index);
            }
            (Ok(_), true) | (Err(_), false) => {}
        }
    }

    fn update_buffer_station(&mut self, station_index: usize, active: bool) {
        let Some(rank) = self.station_ranks.get(&station_index).copied() else {
            return;
        };
        match (
            self.buffer_active_station_indices
                .binary_search_by_key(&rank, |candidate| {
                    self.station_ranks
                        .get(candidate)
                        .copied()
                        .unwrap_or(usize::MAX)
                }),
            active,
        ) {
            (Ok(position), false) => {
                self.buffer_active_station_indices.remove(position);
            }
            (Err(position), true) => {
                self.buffer_active_station_indices
                    .insert(position, station_index);
            }
            (Ok(_), true) | (Err(_), false) => {}
        }
    }

    fn replace_scanned_buffer_activity(&mut self, updates: &[(usize, bool)]) {
        self.buffer_active_station_indices.clear();
        self.buffer_active_station_indices.extend(
            updates
                .iter()
                .filter_map(|(station_index, active)| active.then_some(*station_index)),
        );
        self.buffer_activity_initialized = true;
    }

    fn replace_scanned_local_route_activity(&mut self, updates: &[(usize, bool)]) {
        // Sparse scans contain every previously active demand; dense scans
        // contain every station. In either case this stable-order filter is a
        // complete next activity set and avoids quadratic Vec removals when a
        // dense batch completes many routes together.
        self.local_route_demand_indices.clear();
        self.local_route_demand_indices.extend(
            updates
                .iter()
                .filter_map(|(station_index, active)| active.then_some(*station_index)),
        );
    }
}

#[derive(Debug, Default)]
struct LocalPeers {
    supply: Vec<(usize, usize)>,
    demand: Vec<(usize, usize)>,
}

fn readiness_directory_is_exact(
    station_indices: &[usize],
    station_ranks: &HashMap<usize, usize>,
    station_slots: &HashMap<usize, Vec<Slot>>,
    station_planets: &HashMap<usize, usize>,
) -> bool {
    station_indices.windows(2).all(|pair| pair[0] < pair[1])
        && station_indices.len() == station_ranks.len()
        && station_indices.len() == station_slots.len()
        && station_indices.len() == station_planets.len()
        && station_indices.iter().enumerate().all(|(rank, index)| {
            station_ranks.get(index) == Some(&rank)
                && station_slots.contains_key(index)
                && station_planets.contains_key(index)
        })
}

fn has_opaque_local_dispatch_shape(entities: &[Value], station_indices: &[usize]) -> bool {
    station_indices.iter().copied().any(|station_index| {
        entities
            .get(station_index)
            .and_then(Value::as_object)
            .and_then(|station| station.get("stationRoutes"))
            .and_then(Value::as_array)
            .is_some_and(|routes| {
                routes.iter().any(|route| {
                    route.as_object().is_none_or(|route| {
                        !matches!(string_at(route, "scope"), Some("local" | "remote"))
                    })
                })
            })
    })
}

fn build_peer_directory(
    entities: &[Value],
    station_indices: &[usize],
    runtime_station_indices: &[usize],
) -> anyhow::Result<LocalPeerDirectory> {
    let mut by_planet_item = HashMap::<usize, HashMap<Arc<str>, LocalPeers>>::new();
    let mut station_slots = HashMap::with_capacity(station_indices.len());
    let mut station_planets = HashMap::with_capacity(station_indices.len());
    let mut local_route_demand_indices = Vec::new();
    let mut planet_symbols = HashMap::<String, usize>::new();
    let mut item_symbols = HashMap::<String, Arc<str>>::new();
    for &station_index in station_indices {
        let station = entities[station_index].as_object().expect("station object");
        if !matches!(
            string_at(station, "buildingId"),
            Some("planetary_logistics_station" | "interstellar_logistics_station")
        ) {
            continue;
        }
        let planet_id = string_at(station, "planetId").unwrap_or_default();
        let planet_key = if let Some(&key) = planet_symbols.get(planet_id) {
            key
        } else {
            let key = planet_symbols.len();
            planet_symbols.insert(planet_id.to_owned(), key);
            key
        };
        let parsed_slots = slots_with_item_symbols(station, &mut item_symbols)?;
        for (slot_index, slot) in parsed_slots.iter().enumerate() {
            let Some(item_id) = slot.item_id.as_ref() else {
                continue;
            };
            if slot.local_mode == LocalMode::Storage {
                continue;
            }
            let items = by_planet_item.entry(planet_key).or_default();
            let peers = items.entry(Arc::clone(item_id)).or_default();
            match slot.local_mode {
                LocalMode::Supply => peers.supply.push((station_index, slot_index)),
                LocalMode::Demand => peers.demand.push((station_index, slot_index)),
                LocalMode::Storage => unreachable!("storage slots were filtered"),
            }
        }
        station_planets.insert(station_index, planet_key);
        station_slots.insert(station_index, parsed_slots);
        if station
            .get("stationRoutes")
            .and_then(Value::as_array)
            .is_some_and(|routes| {
                routes
                    .iter()
                    .filter_map(Value::as_object)
                    .any(|route| string_at(route, "scope") == Some("local"))
            })
        {
            local_route_demand_indices.push(station_index);
        }
    }
    let sort_matches = |matches: &mut Vec<(usize, usize)>| {
        matches.sort_by(|(left_index, left_slot), (right_index, right_slot)| {
            let left = entities[*left_index].as_object().expect("station object");
            let right = entities[*right_index].as_object().expect("station object");
            let left_priority = station_slots
                .get(left_index)
                .and_then(|values| values.get(*left_slot).map(|slot| slot.priority))
                .unwrap_or(1);
            let right_priority = station_slots
                .get(right_index)
                .and_then(|values| values.get(*right_slot).map(|slot| slot.priority))
                .unwrap_or(1);
            right_priority
                .cmp(&left_priority)
                .then_with(|| {
                    string_at(left, "id")
                        .unwrap_or_default()
                        .cmp(string_at(right, "id").unwrap_or_default())
                })
                .then_with(|| left_slot.cmp(right_slot))
        });
    };
    for peers in by_planet_item.values_mut().flat_map(HashMap::values_mut) {
        sort_matches(&mut peers.supply);
        sort_matches(&mut peers.demand);
        peers.supply.shrink_to_fit();
        peers.demand.shrink_to_fit();
    }
    let has_local_demand = by_planet_item
        .values()
        .flat_map(HashMap::values)
        .any(|peers| !peers.demand.is_empty());
    let has_local_supply = by_planet_item
        .values()
        .flat_map(HashMap::values)
        .any(|peers| !peers.supply.is_empty());
    let mut local_waiting_station_indices = by_planet_item
        .values()
        .flat_map(HashMap::values)
        .flat_map(|peers| {
            peers.demand.iter().filter_map(|(demand_index, _)| {
                peers
                    .supply
                    .iter()
                    .any(|(supply_index, _)| supply_index != demand_index)
                    .then_some(*demand_index)
            })
        })
        .collect::<Vec<_>>();
    local_waiting_station_indices.sort_unstable();
    local_waiting_station_indices.dedup();
    local_waiting_station_indices.shrink_to_fit();
    for items in by_planet_item.values_mut() {
        items.shrink_to_fit();
    }
    by_planet_item.shrink_to_fit();
    station_slots.shrink_to_fit();
    station_planets.shrink_to_fit();
    local_route_demand_indices.shrink_to_fit();
    // All slot and peer keys share the same immutable item symbols. Account
    // for each Arc allocation exactly once; the temporary interning map is
    // released before the directory becomes resident.
    let slot_item_allocation_bytes = item_symbols
        .values()
        .map(|item_id| {
            let header = std::mem::size_of::<usize>() * 2;
            let unaligned = header + item_id.len();
            let alignment = std::mem::align_of::<usize>();
            unaligned.div_ceil(alignment) * alignment
        })
        .sum();
    let station_ranks = station_indices
        .iter()
        .copied()
        .enumerate()
        .map(|(rank, station_index)| (station_index, rank))
        .collect::<HashMap<_, _>>();
    let readiness_full_scan_required = !readiness_directory_is_exact(
        station_indices,
        &station_ranks,
        &station_slots,
        &station_planets,
    );
    let dispatch_full_scan_required =
        readiness_full_scan_required || has_opaque_local_dispatch_shape(entities, station_indices);
    Ok(LocalPeerDirectory {
        station_indices: Arc::from(station_indices),
        runtime_station_indices: Arc::from(runtime_station_indices),
        station_ranks: Arc::new(station_ranks),
        by_planet_item: Arc::new(by_planet_item),
        station_slots: Arc::new(station_slots),
        slot_item_allocation_bytes,
        station_planets: Arc::new(station_planets),
        has_local_pair: has_local_demand && has_local_supply,
        local_waiting_station_indices: Arc::from(local_waiting_station_indices),
        local_route_demand_indices,
        buffer_active_station_indices: Vec::new(),
        buffer_activity_initialized: false,
        ready_station_indices: Vec::new(),
        pending_readiness_station_indices: Vec::new(),
        readiness_all_pending: true,
        readiness_full_scan_required,
        readiness_signature: None,
        pending_dispatch_demand_indices: Vec::new(),
        dispatch_all_pending: true,
        dispatch_full_scan_required,
        powered_dispatch_station_indices: Vec::new(),
        // A newly imported/rebuilt directory cannot prove which station was
        // active in the previous JS/native step. Clear every persisted runtime
        // display once; successful native steps replace this with the exact
        // active set for the following second.
        runtime_reset_station_indices: runtime_station_indices.to_vec(),
        local_congestion_reset_station_indices: station_indices.to_vec(),
        interstellar_congestion_reset_station_indices: runtime_station_indices.to_vec(),
    })
}

pub(crate) fn prepare_step_directory(
    entities: &[Value],
    station_indices: &[usize],
) -> anyhow::Result<LocalPeerDirectory> {
    let local_station_indices = station_indices
        .iter()
        .copied()
        .filter(|&index| {
            entities[index].as_object().is_some_and(|object| {
                let building = string_at(object, "buildingId");
                string_at(object, "kind") == Some("station")
                    && matches!(
                        building,
                        Some("planetary_logistics_station" | "interstellar_logistics_station")
                    )
                    && !(building == Some("interstellar_logistics_station")
                        && finite_number(object.get("stationTier")).floor() == 2.0
                        && string_at(object, "stationOperationMode") == Some("elevator"))
            })
        })
        .collect::<Vec<_>>();
    build_peer_directory(entities, &local_station_indices, station_indices)
}

fn entity_index(entities: &[Value]) -> HashMap<String, usize> {
    entities
        .iter()
        .enumerate()
        .filter_map(|(index, entity)| {
            entity
                .as_object()
                .and_then(|object| string_at(object, "id"))
                .map(|id| (id.to_owned(), index))
        })
        .collect()
}

fn station_capacity(
    state: &CoreState,
    entity: &Map<String, Value>,
    slot: &Slot,
    buffer_limit: f64,
) -> anyhow::Result<f64> {
    let building = string_at(entity, "buildingId")
        .and_then(|id| state.catalog.buildings.get(id))
        .ok_or_else(|| anyhow!("native local station building is missing"))?;
    let rated = stacked_capacity(
        building.output_capacity,
        finite_number(entity.get("machineCount")),
        buffer_limit,
    );
    Ok(if slot.max_stock > 0.0 {
        rated.min(slot.max_stock)
    } else {
        rated
    })
}

fn installed_drones(entity: &Map<String, Value>) -> f64 {
    (DRONES_PER_BUILDING * finite_number(entity.get("machineCount")).floor().max(0.0))
        .min(finite_number(entity.get("stationDrones")).floor().max(0.0))
}

fn drone_capacity(entity: &Map<String, Value>) -> f64 {
    DRONES_PER_BUILDING * finite_number(entity.get("machineCount")).floor().max(0.0)
}

fn logistics_level(base: &Map<String, Value>) -> f64 {
    base.get("endgame")
        .and_then(Value::as_object)
        .and_then(|endgame| endgame.get("infiniteResearch"))
        .and_then(Value::as_object)
        .and_then(|research| research.get("galactic_logistics"))
        .and_then(Value::as_object)
        .and_then(|progress| progress.get("level"))
        .map(|value| finite_number(Some(value)).floor().clamp(0.0, 1_000.0))
        .unwrap_or(0.0)
}

fn completed_tech(base: &Map<String, Value>, id: &str) -> bool {
    base.get("research")
        .and_then(Value::as_object)
        .and_then(|research| research.get("completedTechIds"))
        .and_then(Value::as_array)
        .is_some_and(|ids| ids.iter().any(|value| value.as_str() == Some(id)))
}

fn cargo_capacity(base: &Map<String, Value>) -> f64 {
    let multiplier =
        (1.0 + if completed_tech(base, "logistics_capacity_1") {
            0.5
        } else {
            0.0
        } + if completed_tech(base, "logistics_capacity_2") {
            0.5
        } else {
            0.0
        }) * (1.0 + logistics_level(base) * 0.05);
    (CARGO_PER_DRONE * multiplier).round()
}

fn logistics_speed(base: &Map<String, Value>) -> f64 {
    let research =
        1.0 + if completed_tech(base, "logistics_engine_1") {
            0.5
        } else {
            0.0
        } + if completed_tech(base, "logistics_engine_2") {
            0.5
        } else {
            0.0
        };
    let difficulty = match base
        .get("settings")
        .and_then(Value::as_object)
        .and_then(|settings| settings.get("difficulty"))
        .and_then(Value::as_str)
        .unwrap_or("standard")
    {
        "relaxed" => 1.1,
        "hard" => 0.9,
        _ => 1.0,
    };
    research * (1.0 + logistics_level(base) * 0.05) * difficulty
}

fn minimum_cargo(cargo_capacity: f64, slot: &Slot) -> f64 {
    (cargo_capacity * slot.minimum_load).ceil()
}

fn route_owner_id<'a>(demand: &'a Map<String, Value>, route: &'a Map<String, Value>) -> &'a str {
    string_at(route, "vehicleStationId")
        .unwrap_or_else(|| string_at(demand, "id").unwrap_or_default())
}

#[cfg(test)]
fn build_ledger(
    entities: &[Value],
    indexes: &ExactRowIdIndex,
    station_indices: &[usize],
) -> Ledger {
    let mut ledger = Ledger::default();
    for &demand_index in station_indices {
        let demand = entities[demand_index].as_object().expect("station object");
        let Some(routes) = demand.get("stationRoutes").and_then(Value::as_array) else {
            continue;
        };
        for route in routes.iter().filter_map(Value::as_object) {
            let Some(scope) = string_at(route, "scope") else {
                continue;
            };
            if !matches!(scope, "local" | "remote") {
                continue;
            }
            let vehicles = finite_number(route.get("vehicleCount")).floor().max(0.0);
            let cargo = finite_number(route.get("cargo")).floor().max(0.0);
            let item = string_at(route, "itemId").unwrap_or_default();
            let owner = indexes
                .get(route_owner_id(demand, route))
                .copied()
                .unwrap_or(demand_index);
            let supply = string_at(route, "peerId")
                .and_then(|id| indexes.get(id))
                .copied();
            if scope == "local" {
                *ledger.busy.entry(owner).or_default() += vehicles;
            }
            add_ledger_item_amount(&mut ledger.in_flight, demand_index, item, cargo);
            let mut active_stations = HashSet::from([demand_index, owner]);
            if let Some(supply) = supply {
                add_ledger_item_amount(&mut ledger.reserved, supply, item, cargo);
                active_stations.insert(supply);
            }
            for waypoint in route
                .get("waypointStationIds")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .filter_map(|id| indexes.get(id))
            {
                active_stations.insert(*waypoint);
            }
            for station_index in active_stations {
                *ledger.active_vehicle_load.entry(station_index).or_default() += vehicles;
                if scope == "local" {
                    ledger.active_local_stations.insert(station_index);
                    let progress = finite_number(route.get("progress"));
                    let current = ledger
                        .active_local_progress
                        .entry(station_index)
                        .or_default();
                    *current = current.max(progress);
                }
            }
        }
    }
    ledger
}

fn peer_matches(
    directory: &LocalPeerDirectory,
    station_index: usize,
    slot_index: usize,
) -> anyhow::Result<Vec<(usize, usize)>> {
    let slot = directory
        .station_slots
        .get(&station_index)
        .ok_or_else(|| anyhow!("native local station slots are missing"))?
        .get(slot_index)
        .ok_or_else(|| anyhow!("native local station slot index is invalid"))?;
    let Some(item_id) = slot.item_id.as_deref() else {
        return Ok(Vec::new());
    };
    if slot.local_mode == LocalMode::Storage {
        return Ok(Vec::new());
    }
    let planet_key = directory
        .station_planets
        .get(&station_index)
        .copied()
        .unwrap_or_default();
    let matches = directory
        .by_planet_item
        .get(&planet_key)
        .and_then(|items| items.get(item_id))
        .map(|peers| match slot.local_mode {
            LocalMode::Supply => peers.demand.as_slice(),
            LocalMode::Demand => peers.supply.as_slice(),
            LocalMode::Storage => &[],
        })
        .into_iter()
        .flatten()
        .copied()
        .filter(|(peer_index, _)| *peer_index != station_index)
        .collect();
    Ok(matches)
}

fn has_peer_match(
    directory: &LocalPeerDirectory,
    station_index: usize,
    slot_index: usize,
) -> anyhow::Result<bool> {
    let slot = directory
        .station_slots
        .get(&station_index)
        .ok_or_else(|| anyhow!("native local station slots are missing"))?
        .get(slot_index)
        .ok_or_else(|| anyhow!("native local station slot index is invalid"))?;
    let Some(item_id) = slot.item_id.as_deref() else {
        return Ok(false);
    };
    if slot.local_mode == LocalMode::Storage {
        return Ok(false);
    }
    let planet_key = directory
        .station_planets
        .get(&station_index)
        .copied()
        .unwrap_or_default();
    Ok(directory
        .by_planet_item
        .get(&planet_key)
        .and_then(|items| items.get(item_id))
        .map(|peers| match slot.local_mode {
            LocalMode::Supply => peers.demand.as_slice(),
            LocalMode::Demand => peers.supply.as_slice(),
            LocalMode::Storage => &[],
        })
        .is_some_and(|matches| {
            matches
                .iter()
                .any(|(peer_index, _)| *peer_index != station_index)
        }))
}

pub(crate) fn admission_reason(state: &CoreState) -> anyhow::Result<Option<&'static str>> {
    let entities = (0..state.entity_index.len())
        .map(|index| state.parse_entity(index))
        .collect::<anyhow::Result<Vec<_>>>()?;
    let indexes = entity_index(&entities);
    for station_index in station_indices(&entities) {
        let station = entities[station_index].as_object().expect("station object");
        if string_at(station, "buildingId") == Some("orbital_collector") {
            continue;
        }
        if !matches!(
            string_at(station, "buildingId"),
            Some("planetary_logistics_station" | "interstellar_logistics_station")
        ) {
            return Ok(Some("local-logistics-station-type-unsupported"));
        }
        if string_at(station, "buildingId") == Some("interstellar_logistics_station")
            && !matches!(
                string_at(station, "stationOperationMode"),
                None | Some("legacy")
            )
        {
            return Ok(Some("local-logistics-operation-mode-unsupported"));
        }
        if station.get("stationModeTransition").is_some_and(|value| {
            !value.is_null() && !matches!(value.as_str(), Some("to-elevator" | "to-legacy"))
        }) {
            return Ok(Some("local-logistics-transition-unsupported"));
        }
        let station_slots = match slots(station) {
            Ok(values) => values,
            Err(_) => return Ok(Some("local-logistics-slots-invalid")),
        };
        if station_slots
            .iter()
            .filter_map(|slot| slot.item_id.as_deref())
            .any(|id| !state.catalog.items.contains_key(id))
        {
            return Ok(Some("local-logistics-slot-item-invalid"));
        }
        let Some(routes) = station.get("stationRoutes").and_then(Value::as_array) else {
            return Ok(Some("local-logistics-routes-invalid"));
        };
        for route_value in routes {
            let Some(route) = route_value.as_object() else {
                return Ok(Some("local-logistics-route-invalid"));
            };
            if string_at(route, "scope") == Some("remote") {
                continue;
            }
            let peer_valid = string_at(route, "peerId")
                .and_then(|id| indexes.get(id))
                .is_some();
            let owner_valid = indexes.contains_key(route_owner_id(station, route));
            if string_at(route, "scope") != Some("local")
                || !peer_valid
                || !owner_valid
                || string_at(route, "itemId").is_none_or(|id| !state.catalog.items.contains_key(id))
            {
                return Ok(Some("local-logistics-route-invalid"));
            }
        }
    }
    Ok(None)
}

pub(crate) fn reset_runtime_for_indices(
    entities: &mut [Value],
    station_indices: &[usize],
) -> anyhow::Result<()> {
    for &station_index in station_indices {
        let station = entities[station_index]
            .as_object_mut()
            .ok_or_else(|| anyhow!("native local station is invalid"))?;
        set_number(station, "utilization", 0.0)?;
        set_number(station, "productionRate", 0.0)?;
        station.remove("stationPeerId");
    }
    Ok(())
}

fn station_has_pending_buffer_input(
    entities: &[Value],
    directory: &LocalPeerDirectory,
    station_index: usize,
) -> anyhow::Result<bool> {
    let station_slots = directory
        .station_slots
        .get(&station_index)
        .ok_or_else(|| anyhow!("native local station slots are missing"))?;
    let station = entities[station_index]
        .as_object()
        .ok_or_else(|| anyhow!("native local station is invalid"))?;
    Ok(station_slots.iter().any(|slot| {
        slot.item_id.as_deref().is_some_and(|item_id| {
            (item_amount(station, "inputs", item_id) + EPSILON).floor() >= 1.0
        })
    }))
}

fn plan_buffer_activity(
    entities: &[Value],
    directory: &LocalPeerDirectory,
    station_indices: &[usize],
) -> anyhow::Result<Vec<(usize, bool)>> {
    station_indices
        .iter()
        .copied()
        .map(|station_index| {
            station_has_pending_buffer_input(entities, directory, station_index)
                .map(|active| (station_index, active))
        })
        .collect()
}

fn transfer_buffers_for_indices(
    state: &CoreState,
    base: &Map<String, Value>,
    entities: &mut [Value],
    directory: &LocalPeerDirectory,
    station_indices: &[usize],
) -> anyhow::Result<Vec<(usize, bool)>> {
    let buffer_limit = normalized_buffer_limit(base);
    for &station_index in station_indices {
        let station_slots = directory
            .station_slots
            .get(&station_index)
            .ok_or_else(|| anyhow!("native local station slots are missing"))?;
        let station = entities[station_index]
            .as_object_mut()
            .ok_or_else(|| anyhow!("native local station is invalid"))?;
        if !matches!(
            string_at(station, "buildingId"),
            Some("planetary_logistics_station" | "interstellar_logistics_station")
        ) {
            continue;
        }
        for slot in station_slots {
            let Some(item_id) = slot.item_id.as_deref() else {
                continue;
            };
            let capacity = station_capacity(state, station, slot, buffer_limit)?;
            let incoming = (item_amount(station, "inputs", item_id) + EPSILON).floor();
            let stored = (item_amount(station, "outputs", item_id) + EPSILON).floor();
            let moved = incoming.min((capacity - stored).max(0.0));
            set_item_amount(station, "inputs", item_id, incoming - moved)?;
            set_item_amount(station, "outputs", item_id, stored + moved)?;
        }
    }
    plan_buffer_activity(entities, directory, station_indices)
}

pub(crate) fn transfer_buffers(
    state: &CoreState,
    base: &Map<String, Value>,
    entities: &mut [Value],
    directory: &mut LocalPeerDirectory,
) -> anyhow::Result<Vec<usize>> {
    let (station_indices, _dense_fallback) = directory.buffer_scan_indices();
    let updates = transfer_buffers_for_indices(state, base, entities, directory, &station_indices)?;
    directory.replace_scanned_buffer_activity(&updates);
    Ok(station_indices)
}

/// Installs exact wake evidence produced by inventory-moving subsystems. The
/// caller supplies sorted, de-duplicated entity indices and only invokes this
/// after the candidate inventory mutation succeeded. Non-local-station rows
/// are ignored through the immutable topology rank map.
pub(crate) fn wake_transfer_buffers_from_changed_entities(
    entities: &[Value],
    changed_entity_indices: &[usize],
    directory: &mut LocalPeerDirectory,
) -> anyhow::Result<()> {
    let station_indices = changed_entity_indices
        .iter()
        .copied()
        .filter(|station_index| directory.station_ranks.contains_key(station_index))
        .collect::<Vec<_>>();
    let updates = plan_buffer_activity(entities, directory, &station_indices)?;
    for (station_index, active) in updates {
        directory.update_buffer_station(station_index, active);
    }
    Ok(())
}

pub(crate) fn refresh_step_directory_after_topology_change(
    entities: &[Value],
    station_indices: &[usize],
    topology_changed: bool,
    directory: &mut Arc<LocalPeerDirectory>,
) -> anyhow::Result<()> {
    if topology_changed {
        *directory = Arc::new(prepare_step_directory(entities, station_indices)?);
    }
    Ok(())
}

fn plan_ready_station_indices_with<F, L>(
    runtime: &DeterministicRuntime,
    entities: &[Value],
    directory: &LocalPeerDirectory,
    station_indices: &[usize],
    ledger: &L,
    cargo_capacity: f64,
    station_capacity: F,
) -> anyhow::Result<Vec<Option<usize>>>
where
    F: Fn(usize, &Map<String, Value>, &Slot) -> anyhow::Result<f64> + Send + Sync,
    L: LocalLedgerView + ?Sized,
{
    runtime.indexed_try_map(
        station_indices,
        |_, station_index| -> anyhow::Result<Option<usize>> {
            let station_index = *station_index;
            let station = entities[station_index].as_object().expect("station object");
            if !matches!(
                string_at(station, "buildingId"),
                Some("planetary_logistics_station" | "interstellar_logistics_station")
            ) {
                return Ok(None);
            }
            if ledger.is_active_local_station(station_index) {
                return Ok(Some(station_index));
            }
            let station_slots = directory
                .station_slots
                .get(&station_index)
                .ok_or_else(|| anyhow!("native local station slots are missing"))?;
            for (slot_index, slot) in station_slots.iter().enumerate() {
                let Some(item_id) = slot.item_id.as_deref() else {
                    continue;
                };
                if slot.local_mode == LocalMode::Storage {
                    continue;
                }
                for (peer_index, peer_slot_index) in
                    peer_matches(directory, station_index, slot_index)?
                {
                    let peer_slots = directory
                        .station_slots
                        .get(&peer_index)
                        .ok_or_else(|| anyhow!("native local peer slots are missing"))?;
                    let (demand_index, demand_slot, supply_index, supply_slot) =
                        if slot.local_mode == LocalMode::Demand {
                            (
                                station_index,
                                slot,
                                peer_index,
                                &peer_slots[peer_slot_index],
                            )
                        } else {
                            (
                                peer_index,
                                &peer_slots[peer_slot_index],
                                station_index,
                                slot,
                            )
                        };
                    let demand = entities[demand_index].as_object().expect("station object");
                    let supply = entities[supply_index].as_object().expect("station object");
                    let available = (item_amount(supply, "outputs", item_id)
                        - supply_slot.min_stock)
                        .max(0.0)
                        .floor();
                    let free = (station_capacity(demand_index, demand, demand_slot)?
                        - item_amount(demand, "outputs", item_id)
                        - ledger.in_flight(demand_index, item_id))
                    .max(0.0)
                    .floor();
                    for (owner_index, owner_slot) in
                        [(demand_index, demand_slot), (supply_index, supply_slot)]
                    {
                        let owner = entities[owner_index].as_object().expect("station object");
                        let has_vehicle =
                            installed_drones(owner) - ledger.local_busy(owner_index) > 0.0;
                        let minimum = minimum_cargo(cargo_capacity, owner_slot);
                        if has_vehicle && available >= minimum && free >= minimum {
                            return Ok(Some(station_index));
                        }
                    }
                }
            }
            Ok(None)
        },
    )
}

fn replay_ready_station_indices(planned: Vec<Option<usize>>) -> HashSet<usize> {
    let mut ready = HashSet::with_capacity(planned.len());
    // Replay in original topology order even though the public result is a
    // set. The caller later sorts this set before power probes; retaining the
    // historical insertion order also keeps this boundary ready for a future
    // ordered representation without making it worker-schedule dependent.
    for station_index in planned.into_iter().flatten() {
        ready.insert(station_index);
    }
    ready
}

pub(crate) fn ready_station_indices(
    state: &CoreState,
    base: &Map<String, Value>,
    entities: &[Value],
    directory: &mut LocalPeerDirectory,
    route_ledger: &StationRouteLedger,
) -> anyhow::Result<HashSet<usize>> {
    ready_station_indices_with_scan(state, base, entities, directory, route_ledger)
        .map(|(ready, _)| ready)
}

fn ready_station_indices_with_scan(
    state: &CoreState,
    base: &Map<String, Value>,
    entities: &[Value],
    directory: &mut LocalPeerDirectory,
    route_ledger: &StationRouteLedger,
) -> anyhow::Result<(HashSet<usize>, LocalReadyStationScan)> {
    if !directory.has_local_pair() && !directory.has_local_routes() {
        return Ok((HashSet::new(), LocalReadyStationScan::default()));
    }
    let buffer_limit = normalized_buffer_limit(base);
    let (station_indices, signature, scan) = directory.readiness_scan_indices(base, route_ledger);
    let planned = plan_ready_station_indices_with(
        deterministic_runtime(),
        entities,
        directory,
        &station_indices,
        route_ledger,
        cargo_capacity(base),
        |_, demand, demand_slot| station_capacity(state, demand, demand_slot, buffer_limit),
    )?;
    let ready = replay_ready_station_indices(planned.clone());
    directory.commit_readiness(&planned, signature);
    Ok((ready, scan))
}

fn add_max_field(
    entities: &mut [Value],
    index: usize,
    key: &str,
    value: f64,
) -> anyhow::Result<()> {
    let entity = entities[index]
        .as_object_mut()
        .ok_or_else(|| anyhow!("native local station is invalid"))?;
    set_number(entity, key, finite_number(entity.get(key)).max(value))
}

fn set_peer(entities: &mut [Value], index: usize, peer_id: &str) {
    if let Some(entity) = entities[index].as_object_mut() {
        let peer_id = Value::from(peer_id);
        if let Some(current) = entity.get_mut("stationPeerId") {
            *current = peer_id;
        } else {
            entity.insert("stationPeerId".to_owned(), peer_id);
        }
    }
}

fn dispatch_for_indices<L: LocalDispatchLedger + ?Sized>(
    state: &CoreState,
    base: &mut Map<String, Value>,
    entities: &mut [Value],
    powers: &HashMap<usize, f64>,
    directory: &LocalPeerDirectory,
    demand_indices: &[usize],
    ledger: &mut L,
) -> anyhow::Result<Vec<usize>> {
    if !directory.has_local_pair() && !directory.has_local_routes() {
        return Ok(Vec::new());
    }
    let buffer_limit = normalized_buffer_limit(base);
    let cargo_capacity = cargo_capacity(base);
    let logistics_speed = logistics_speed(base);
    let mut activated_local_demands = Vec::new();
    for &demand_index in demand_indices {
        let (eligible, cursor, demand_id) = {
            let demand = entities[demand_index]
                .as_object()
                .ok_or_else(|| anyhow!("native local demand station is invalid"))?;
            (
                matches!(
                    string_at(demand, "buildingId"),
                    Some("planetary_logistics_station" | "interstellar_logistics_station")
                ),
                finite_number(demand.get("stationDispatchCursor"))
                    .floor()
                    .max(0.0) as usize,
                string_at(demand, "id").unwrap_or_default().to_owned(),
            )
        };
        if !eligible {
            continue;
        }
        let demand_slots = directory
            .station_slots
            .get(&demand_index)
            .ok_or_else(|| anyhow!("native local demand slots are missing"))?;
        let mut ordered_slots = demand_slots
            .iter()
            .enumerate()
            .filter(|(_, slot)| slot.item_id.is_some() && slot.local_mode == LocalMode::Demand)
            .collect::<Vec<_>>();
        ordered_slots.sort_by(|(left_index, left), (right_index, right)| {
            right
                .priority
                .cmp(&left.priority)
                .then_with(|| left_index.cmp(right_index))
        });
        if ordered_slots.is_empty() {
            continue;
        }
        for offset in 0..ordered_slots.len() {
            let (slot_index, slot) = ordered_slots[(cursor + offset) % ordered_slots.len()];
            let item_id = slot.item_id.as_deref().expect("demand item").to_owned();
            let fairness_key = format!("local:{slot_index}");
            let last_peer_id = entities[demand_index]
                .as_object()
                .and_then(|demand| demand.get("stationLastSupplyPeerBySlot"))
                .and_then(Value::as_object)
                .and_then(|values| values.get(&fairness_key))
                .and_then(Value::as_str)
                .map(str::to_owned);
            let mut matches = peer_matches(directory, demand_index, slot_index)?;
            matches.sort_by(|(left_index, left_slot), (right_index, right_slot)| {
                let left = entities[*left_index].as_object().expect("station object");
                let right = entities[*right_index].as_object().expect("station object");
                let left_priority = directory
                    .station_slots
                    .get(left_index)
                    .and_then(|values| values.get(*left_slot).map(|slot| slot.priority))
                    .unwrap_or(1);
                let right_priority = directory
                    .station_slots
                    .get(right_index)
                    .and_then(|values| values.get(*right_slot).map(|slot| slot.priority))
                    .unwrap_or(1);
                right_priority
                    .cmp(&left_priority)
                    .then_with(|| {
                        ledger
                            .active_vehicle_load(*left_index)
                            .partial_cmp(&ledger.active_vehicle_load(*right_index))
                            .unwrap_or(Ordering::Equal)
                    })
                    .then_with(|| {
                        if let Some(last) = last_peer_id.as_deref() {
                            let left_after =
                                usize::from(string_at(left, "id").unwrap_or_default() <= last);
                            let right_after =
                                usize::from(string_at(right, "id").unwrap_or_default() <= last);
                            left_after.cmp(&right_after)
                        } else {
                            Ordering::Equal
                        }
                    })
                    .then_with(|| {
                        string_at(left, "id")
                            .unwrap_or_default()
                            .cmp(string_at(right, "id").unwrap_or_default())
                    })
                    .then_with(|| left_slot.cmp(right_slot))
            });
            let demand_now = entities[demand_index].as_object().expect("station object");
            let mut remaining_free = (station_capacity(state, demand_now, slot, buffer_limit)?
                - item_amount(demand_now, "outputs", &item_id)
                - ledger.in_flight(demand_index, &item_id)
                + EPSILON)
                .floor()
                .max(0.0);
            for (supply_index, peer_slot_index) in matches {
                if remaining_free < 1.0 {
                    break;
                }
                let supply_slot = directory
                    .station_slots
                    .get(&supply_index)
                    .and_then(|values| values.get(peer_slot_index))
                    .ok_or_else(|| anyhow!("native local supply slot is missing"))?;
                let (supply_output, supply_id) = {
                    let supply = entities[supply_index].as_object().expect("station object");
                    (
                        item_amount(supply, "outputs", &item_id),
                        string_at(supply, "id").unwrap_or_default().to_owned(),
                    )
                };
                for (owner_index, owner_slot) in [(demand_index, slot), (supply_index, supply_slot)]
                {
                    let (free_vehicles, owner_id) = {
                        let owner = entities[owner_index].as_object().expect("station object");
                        (
                            (installed_drones(owner) - ledger.local_busy(owner_index)).max(0.0),
                            string_at(owner, "id").unwrap_or_default().to_owned(),
                        )
                    };
                    if free_vehicles < 1.0
                        || powers.get(&owner_index).copied().unwrap_or(0.0) <= EPSILON
                    {
                        continue;
                    }
                    let available = (supply_output
                        - supply_slot.min_stock
                        - ledger.reserved(supply_index, &item_id)
                        + EPSILON)
                        .floor()
                        .max(0.0);
                    let minimum = minimum_cargo(cargo_capacity, owner_slot);
                    let dispatchable = free_vehicles
                        .min((available / minimum).floor())
                        .min((remaining_free / minimum).floor());
                    if dispatchable < 1.0 {
                        continue;
                    }
                    let cargo = available
                        .min(remaining_free)
                        .min(cargo_capacity * dispatchable);
                    let demand_route_count = entities[demand_index]
                        .as_object()
                        .and_then(|entity| entity.get("stationRoutes"))
                        .and_then(Value::as_array)
                        .map(Vec::len)
                        .unwrap_or(0);
                    let initial_progress = if demand_route_count == 0 {
                        finite_number(
                            entities[demand_index]
                                .as_object()
                                .and_then(|entity| entity.get("stationProgress")),
                        )
                        .clamp(0.0, 0.999999)
                    } else {
                        0.0
                    };
                    let next_id = finite_number(base.get("nextId")).floor().max(0.0);
                    let route = json!({
                        "id": format!("route_{}", next_id as u64),
                        "slotIndex": slot_index,
                        "peerId": supply_id,
                        "itemId": item_id,
                        "scope": "local",
                        "cargo": cargo,
                        "vehicleCount": dispatchable,
                        "progress": initial_progress,
                        "duration": BASE_TRIP_SECONDS / logistics_speed,
                        "requiresWarp": false,
                        "waypointStationIds": [],
                        "distanceLy": 0,
                        "warpersPerVessel": 0,
                        "vehicleStationId": owner_id,
                    });
                    let demand_routes = entities[demand_index]
                        .as_object_mut()
                        .ok_or_else(|| anyhow!("native local demand station is invalid"))?;
                    if !demand_routes
                        .get("stationRoutes")
                        .is_some_and(Value::is_array)
                    {
                        demand_routes.insert("stationRoutes".to_owned(), Value::Array(Vec::new()));
                    }
                    demand_routes
                        .get_mut("stationRoutes")
                        .and_then(Value::as_array_mut)
                        .expect("initialized local demand routes")
                        .push(route);
                    activated_local_demands.push(demand_index);
                    ledger.record_dispatch(
                        demand_index,
                        supply_index,
                        owner_index,
                        &item_id,
                        cargo,
                        dispatchable,
                        initial_progress,
                    );
                    remaining_free = (remaining_free - cargo).max(0.0);
                    set_number(base, "nextId", next_id + 1.0)?;
                    {
                        let demand = entities[demand_index]
                            .as_object_mut()
                            .expect("station object");
                        set_number(
                            demand,
                            "stationProgress",
                            finite_number(demand.get("stationProgress")).max(initial_progress),
                        )?;
                        set_number(demand, "stationDispatchCursor", slot_index as f64 + 1.0)?;
                        let fairness = demand
                            .get_mut("stationLastSupplyPeerBySlot")
                            .and_then(Value::as_object_mut)
                            .ok_or_else(|| anyhow!("native local fairness record is missing"))?;
                        let peer = Value::from(supply_id.clone());
                        if let Some(current) = fairness.get_mut(&fairness_key) {
                            *current = peer;
                        } else {
                            fairness.insert(fairness_key.clone(), peer);
                        }
                    }
                    set_peer(entities, demand_index, &supply_id);
                    set_peer(entities, supply_index, &demand_id);
                    set_peer(
                        entities,
                        owner_index,
                        if owner_index == demand_index {
                            &supply_id
                        } else {
                            &demand_id
                        },
                    );
                }
            }
        }
    }
    activated_local_demands.sort_unstable();
    activated_local_demands.dedup();
    Ok(activated_local_demands)
}

fn dispatch_with_ledger_mode<L: LocalDispatchLedger + ?Sized>(
    state: &CoreState,
    base: &mut Map<String, Value>,
    entities: &mut [Value],
    powers: &HashMap<usize, f64>,
    directory: &mut LocalPeerDirectory,
    ledger: &mut L,
    force_full_scan: bool,
) -> anyhow::Result<LocalDispatchScan> {
    let (next_powered, power_wakes, power_directory_fallback) =
        directory.plan_dispatch_power_wakes(powers);
    let (dispatch_indices, scan) =
        directory.dispatch_scan_indices(&power_wakes, power_directory_fallback, force_full_scan);
    let activated_local_demands = dispatch_for_indices(
        state,
        base,
        entities,
        powers,
        directory,
        &dispatch_indices,
        ledger,
    )?;
    // The pending and power caches are candidate-local runtime state. Install
    // their next values only after every JSON/ledger mutation above succeeds.
    directory.commit_dispatch(
        next_powered,
        &activated_local_demands,
        scan.directory_fallback,
    );
    Ok(scan)
}

fn dispatch_with_ledger<L: LocalDispatchLedger + ?Sized>(
    state: &CoreState,
    base: &mut Map<String, Value>,
    entities: &mut [Value],
    powers: &HashMap<usize, f64>,
    directory: &mut LocalPeerDirectory,
    ledger: &mut L,
) -> anyhow::Result<LocalDispatchScan> {
    dispatch_with_ledger_mode(state, base, entities, powers, directory, ledger, false)
}

#[cfg(test)]
fn dispatch_full_scan_oracle<L: LocalDispatchLedger + ?Sized>(
    state: &CoreState,
    base: &mut Map<String, Value>,
    entities: &mut [Value],
    powers: &HashMap<usize, f64>,
    directory: &mut LocalPeerDirectory,
    ledger: &mut L,
) -> anyhow::Result<LocalDispatchScan> {
    dispatch_with_ledger_mode(state, base, entities, powers, directory, ledger, true)
}

pub(crate) fn dispatch(
    state: &CoreState,
    base: &mut Map<String, Value>,
    entities: &mut [Value],
    powers: &HashMap<usize, f64>,
    directory: &mut LocalPeerDirectory,
    route_ledger: &mut StationRouteLedger,
) -> anyhow::Result<LocalDispatchScan> {
    dispatch_with_ledger(state, base, entities, powers, directory, route_ledger)
}

struct LocalRouteAdvanceOutcome {
    activity_updates: Vec<(usize, bool)>,
    changed_station_indices: Vec<usize>,
}

fn advance_routes_for_indices(
    state: &CoreState,
    base: &mut Map<String, Value>,
    entities: &mut [Value],
    quantum_bandwidth: crate::quantum_logistics::RuntimeBandwidth,
    seconds: f64,
    powers: &HashMap<usize, f64>,
    route_scan_indices: &[usize],
) -> anyhow::Result<LocalRouteAdvanceOutcome> {
    let indexes = &state.entity_index;
    let mut activity_updates = Vec::with_capacity(route_scan_indices.len());
    let mut changed_station_indices = Vec::new();
    for &demand_index in route_scan_indices {
        let demand_id = entities[demand_index]
            .as_object()
            .ok_or_else(|| anyhow!("native local demand is invalid"))?
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let Some(routes) = entities[demand_index]
            .as_object_mut()
            .and_then(|demand| demand.get_mut("stationRoutes"))
            .and_then(Value::as_array_mut)
            .map(std::mem::take)
        else {
            activity_updates.push((demand_index, false));
            continue;
        };
        let mut remaining = Vec::new();
        let mut completed_cargo = 0.0;
        for mut route_value in routes {
            let route = route_value
                .as_object_mut()
                .ok_or_else(|| anyhow!("native local route is invalid"))?;
            if string_at(route, "scope") != Some("local") {
                remaining.push(route_value);
                continue;
            }
            let supply_index = string_at(route, "peerId")
                .and_then(|id| indexes.get(id))
                .copied()
                .ok_or_else(|| anyhow!("native local route peer is missing"))?;
            let owner_index = indexes
                .get(string_at(route, "vehicleStationId").unwrap_or(&demand_id))
                .copied()
                .unwrap_or(demand_index);
            let power = powers.get(&owner_index).copied().unwrap_or(0.0);
            let duration = finite_number(route.get("duration")).max(1.0);
            let progress = rounded(
                finite_number(route.get("progress")) + seconds * power / duration,
                6,
            );
            set_number(route, "progress", progress)?;
            add_max_field(entities, demand_index, "utilization", power)?;
            add_max_field(entities, supply_index, "utilization", power)?;
            add_max_field(entities, owner_index, "utilization", power)?;
            if progress + EPSILON < 1.0 {
                remaining.push(route_value);
                continue;
            }
            let item_id = string_at(route, "itemId").unwrap_or_default().to_owned();
            let cargo = finite_number(route.get("cargo")).floor().max(0.0);
            let vehicles = finite_number(route.get("vehicleCount")).floor().max(0.0);
            let quantum_supply = crate::quantum_logistics::is_supply_endpoint(
                entities[demand_index].as_object().expect("station object"),
                &item_id,
            );
            let delivered_cargo = if quantum_supply {
                crate::quantum_logistics::receive_supply_material(
                    state,
                    base,
                    quantum_bandwidth,
                    entities[demand_index]
                        .as_object_mut()
                        .expect("station object"),
                    &item_id,
                    cargo,
                )?
            } else {
                let demand_current = item_amount(
                    entities[demand_index].as_object().expect("station object"),
                    "outputs",
                    &item_id,
                );
                set_item_amount(
                    entities[demand_index]
                        .as_object_mut()
                        .expect("station object"),
                    "outputs",
                    &item_id,
                    (demand_current + cargo).floor(),
                )?;
                cargo
            };
            let retain_route = delivered_cargo < cargo;
            if retain_route {
                set_number(route, "cargo", cargo - delivered_cargo)?;
            }
            let supply_current = item_amount(
                entities[supply_index].as_object().expect("station object"),
                "outputs",
                &item_id,
            );
            set_item_amount(
                entities[supply_index]
                    .as_object_mut()
                    .expect("station object"),
                "outputs",
                &item_id,
                (supply_current - delivered_cargo).max(0.0).floor(),
            )?;
            for index in [demand_index, supply_index] {
                let station = entities[index].as_object_mut().expect("station object");
                let trips = finite_number(station.get("stationTrips"));
                set_number(station, "stationTrips", (trips + vehicles).floor())?;
                set_number(station, "stationLastTransfer", delivered_cargo)?;
            }
            changed_station_indices.extend([demand_index, supply_index, owner_index]);
            completed_cargo += delivered_cargo;
            if retain_route {
                remaining.push(route_value);
            }
        }
        let demand = entities[demand_index]
            .as_object_mut()
            .expect("station object");
        let has_local_route = remaining
            .iter()
            .filter_map(Value::as_object)
            .any(|route| string_at(route, "scope") == Some("local"));
        let max_progress = remaining
            .iter()
            .filter_map(Value::as_object)
            .map(|route| finite_number(route.get("progress")))
            .fold(0.0_f64, f64::max);
        demand.insert("stationRoutes".to_owned(), Value::Array(remaining));
        let rate = finite_number(demand.get("productionRate"))
            + if seconds > EPSILON {
                completed_cargo * 60.0 / seconds
            } else {
                0.0
            };
        set_number(demand, "productionRate", rate)?;
        set_number(demand, "stationProgress", max_progress)?;
        activity_updates.push((demand_index, has_local_route));
    }
    changed_station_indices.sort_unstable();
    changed_station_indices.dedup();
    Ok(LocalRouteAdvanceOutcome {
        activity_updates,
        changed_station_indices,
    })
}

#[cfg(test)]
pub(crate) fn advance_routes(
    state: &CoreState,
    base: &mut Map<String, Value>,
    entities: &mut [Value],
    seconds: f64,
    powers: &HashMap<usize, f64>,
    directory: &mut LocalPeerDirectory,
) -> anyhow::Result<Vec<usize>> {
    let quantum_bandwidth = crate::quantum_logistics::runtime_bandwidth(base, entities);
    advance_routes_with_bandwidth(
        state,
        base,
        entities,
        quantum_bandwidth,
        seconds,
        powers,
        directory,
    )
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn advance_routes_with_bandwidth(
    state: &CoreState,
    base: &mut Map<String, Value>,
    entities: &mut [Value],
    quantum_bandwidth: crate::quantum_logistics::RuntimeBandwidth,
    seconds: f64,
    powers: &HashMap<usize, f64>,
    directory: &mut LocalPeerDirectory,
) -> anyhow::Result<Vec<usize>> {
    if !directory.has_local_routes() {
        return Ok(Vec::new());
    }
    let (route_scan_indices, _dense_fallback) = directory.route_scan_indices();
    let outcome = advance_routes_for_indices(
        state,
        base,
        entities,
        quantum_bandwidth,
        seconds,
        powers,
        &route_scan_indices,
    )?;
    // A quantum-supply demand can retain completed local cargo in its station
    // input buffer. Derive that wake only from the successfully mutated
    // demand rows; ordinary route completions add outputs and remain dormant.
    let buffer_updates = plan_buffer_activity(entities, directory, &route_scan_indices)?;
    directory.replace_scanned_local_route_activity(&outcome.activity_updates);
    for (station_index, active) in buffer_updates {
        directory.update_buffer_station(station_index, active);
    }
    Ok(outcome.changed_station_indices)
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct CongestionUpdate {
    station_index: usize,
    congestion: f64,
    active_progress: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct LocalCongestionScan {
    pub selected_station_rows: usize,
    pub total_station_rows: usize,
    pub dense_fallback: bool,
}

fn select_congestion_station_indices(
    directory: &LocalPeerDirectory,
    route_ledger: &StationRouteLedger,
) -> (Vec<usize>, LocalCongestionScan) {
    let mut selected = directory.local_waiting_station_indices().to_vec();
    selected.extend_from_slice(directory.local_congestion_reset_station_indices());
    selected.extend(route_ledger.active_local_station_indices());
    selected.sort_unstable();
    selected.dedup();
    selected.retain(|index| directory.station_indices.binary_search(index).is_ok());
    let total_station_rows = directory.station_indices.len();
    let dense_fallback = !selected.is_empty()
        && selected.len().saturating_mul(LOCAL_ROUTE_DENSE_DENOMINATOR)
            >= total_station_rows.saturating_mul(LOCAL_ROUTE_DENSE_NUMERATOR);
    if dense_fallback {
        selected.clear();
        selected.extend_from_slice(&directory.station_indices);
    }
    let scan = LocalCongestionScan {
        selected_station_rows: selected.len(),
        total_station_rows,
        dense_fallback,
    };
    (selected, scan)
}

fn plan_idle_congestion_updates(
    runtime: &DeterministicRuntime,
    entities: &[Value],
    station_indices: &[usize],
) -> Vec<Option<CongestionUpdate>> {
    runtime.indexed_map(station_indices, |_, station_index| {
        let station_index = *station_index;
        let station = entities[station_index].as_object().expect("station object");
        matches!(
            string_at(station, "buildingId"),
            Some("planetary_logistics_station" | "interstellar_logistics_station")
        )
        .then_some(CongestionUpdate {
            station_index,
            congestion: 0.0,
            active_progress: 0.0,
        })
    })
}

#[cfg(test)]
fn plan_congestion_updates<L: LocalLedgerView + ?Sized>(
    runtime: &DeterministicRuntime,
    entities: &[Value],
    directory: &LocalPeerDirectory,
    ledger: &L,
) -> anyhow::Result<Vec<Option<CongestionUpdate>>> {
    runtime.indexed_try_map(
        directory.station_indices.as_ref(),
        |_, station_index| -> anyhow::Result<Option<CongestionUpdate>> {
            let station_index = *station_index;
            let station = entities[station_index].as_object().expect("station object");
            if !matches!(
                string_at(station, "buildingId"),
                Some("planetary_logistics_station" | "interstellar_logistics_station")
            ) {
                return Ok(None);
            }
            let station_slots = directory
                .station_slots
                .get(&station_index)
                .ok_or_else(|| anyhow!("native local station slots are missing"))?;
            let mut waiting = 0.0;
            for (slot_index, slot) in station_slots.iter().enumerate() {
                if slot.item_id.is_some()
                    && slot.local_mode == LocalMode::Demand
                    && has_peer_match(directory, station_index, slot_index)?
                {
                    waiting += 1.0;
                }
            }
            let installed = drone_capacity(station);
            let busy = ledger.local_busy(station_index);
            let fleet_load = if installed > 0.0 {
                busy / installed
            } else if waiting > 0.0 {
                1.0
            } else {
                0.0
            };
            let congestion = fleet_load
                .max(if waiting > 0.0 && busy == 0.0 {
                    0.35
                } else {
                    0.0
                })
                .clamp(0.0, 1.0);
            let active_progress = ledger.active_local_progress(station_index);
            Ok(Some(CongestionUpdate {
                station_index,
                congestion: rounded(congestion, 3),
                active_progress,
            }))
        },
    )
}

fn apply_congestion_updates(
    entities: &mut [Value],
    updates: Vec<Option<CongestionUpdate>>,
) -> anyhow::Result<()> {
    // Replay in the original topology order. Apart from preserving the legacy
    // local-before-remote overwrite contract, this keeps insertion order for
    // absent JSON keys and every opaque MOD field byte-for-byte stable.
    for update in updates.into_iter().flatten() {
        let target = entities[update.station_index]
            .as_object_mut()
            .expect("station object");
        set_number(target, "stationCongestion", update.congestion)?;
        set_number(target, "stationProgress", update.active_progress)?;
    }
    Ok(())
}

pub(crate) fn update_congestion(
    _state: &CoreState,
    entities: &mut [Value],
    directory: &mut LocalPeerDirectory,
    route_ledger: &StationRouteLedger,
) -> anyhow::Result<LocalCongestionScan> {
    let runtime = deterministic_runtime();
    let (station_indices, scan) = select_congestion_station_indices(directory, route_ledger);
    let updates = if !directory.has_local_pair() && !directory.has_local_routes() {
        plan_idle_congestion_updates(runtime, entities, &station_indices)
    } else {
        runtime.indexed_try_map(
            &station_indices,
            |_, station_index| -> anyhow::Result<Option<CongestionUpdate>> {
                let station_index = *station_index;
                let station = entities[station_index].as_object().expect("station object");
                if !matches!(
                    string_at(station, "buildingId"),
                    Some("planetary_logistics_station" | "interstellar_logistics_station")
                ) {
                    return Ok(None);
                }
                let station_slots = directory
                    .station_slots
                    .get(&station_index)
                    .ok_or_else(|| anyhow!("native local station slots are missing"))?;
                let mut waiting = 0.0;
                for (slot_index, slot) in station_slots.iter().enumerate() {
                    if slot.item_id.is_some()
                        && slot.local_mode == LocalMode::Demand
                        && has_peer_match(directory, station_index, slot_index)?
                    {
                        waiting += 1.0;
                    }
                }
                let installed = drone_capacity(station);
                let busy = route_ledger.local_busy(station_index);
                let fleet_load = if installed > 0.0 {
                    busy / installed
                } else if waiting > 0.0 {
                    1.0
                } else {
                    0.0
                };
                let congestion = fleet_load
                    .max(if waiting > 0.0 && busy == 0.0 {
                        0.35
                    } else {
                        0.0
                    })
                    .clamp(0.0, 1.0);
                Ok(Some(CongestionUpdate {
                    station_index,
                    congestion: rounded(congestion, 3),
                    active_progress: route_ledger.active_local_progress(station_index),
                }))
            },
        )?
    };
    apply_congestion_updates(entities, updates)?;
    let mut next_reset = route_ledger.active_local_station_indices();
    next_reset.retain(|index| directory.station_indices.binary_search(index).is_ok());
    directory.replace_local_congestion_reset_station_indices(next_reset);
    Ok(scan)
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
    use std::collections::BTreeMap;
    use std::sync::atomic::{AtomicBool, Ordering as AtomicOrdering};

    fn json_key_pointer(record: &Map<String, Value>, key: &str) -> usize {
        record
            .keys()
            .find(|candidate| candidate.as_str() == key)
            .expect("test JSON key")
            .as_ptr() as usize
    }

    fn legacy_set_item_amount(
        entity: &mut Map<String, Value>,
        record: &str,
        item_id: &str,
        amount: f64,
    ) -> anyhow::Result<()> {
        entity
            .get_mut(record)
            .and_then(Value::as_object_mut)
            .ok_or_else(|| anyhow!("native local logistics inventory is missing"))?
            .insert(
                item_id.to_owned(),
                Number::from_f64(amount)
                    .map(Value::Number)
                    .ok_or_else(|| anyhow!("native local logistics inventory is non-finite"))?,
            );
        Ok(())
    }

    #[test]
    fn item_amount_updates_reuse_existing_keys_and_match_legacy_bytes() {
        let item_id = "mod:本地物流/Ω🚀";
        let source = Map::from_iter([(
            "outputs".to_owned(),
            Value::Object(Map::from_iter([
                ("alpha".to_owned(), Value::from(1)),
                (item_id.to_owned(), Value::from(2)),
                ("zeta".to_owned(), Value::from(3)),
            ])),
        )]);
        let mut actual = source.clone();
        let mut expected = source;
        let before = actual["outputs"].as_object().expect("outputs object");
        let pointer = json_key_pointer(before, item_id);
        let order = before.keys().cloned().collect::<Vec<_>>();

        set_item_amount(&mut actual, "outputs", item_id, -0.0).unwrap();
        legacy_set_item_amount(&mut expected, "outputs", item_id, -0.0).unwrap();

        let after = actual["outputs"].as_object().expect("outputs object");
        assert_eq!(json_key_pointer(after, item_id), pointer);
        assert_eq!(after.keys().cloned().collect::<Vec<_>>(), order);
        assert!(after[item_id].as_f64().unwrap().is_sign_negative());
        assert_eq!(
            serde_json::to_vec(&actual).unwrap(),
            serde_json::to_vec(&expected).unwrap()
        );
    }

    #[test]
    fn item_amount_updates_preserve_missing_insert_and_error_order() {
        let mut entity = Map::from_iter([("inputs".to_owned(), Value::Object(Map::new()))]);
        set_item_amount(&mut entity, "inputs", "mod:新物料/β", 7.0).unwrap();
        assert_eq!(item_amount(&entity, "inputs", "mod:新物料/β"), 7.0);

        let snapshot = entity.clone();
        let error = set_item_amount(&mut entity, "inputs", "mod:新物料/β", f64::NAN)
            .expect_err("non-finite amount must fail");
        assert_eq!(
            error.to_string(),
            "native local logistics inventory is non-finite"
        );
        assert_eq!(entity, snapshot);

        let error = set_item_amount(&mut entity, "missing", "mod:新物料/β", f64::NAN)
            .expect_err("missing record must win error order");
        assert_eq!(
            error.to_string(),
            "native local logistics inventory is missing"
        );
        assert_eq!(entity, snapshot);
    }

    #[test]
    fn peer_updates_reuse_existing_key_and_keep_map_order() {
        let mut entities = vec![Value::Object(Map::from_iter([
            ("alpha".to_owned(), Value::from(1)),
            ("stationPeerId".to_owned(), Value::from("station-old")),
            ("zeta".to_owned(), Value::from(3)),
        ]))];
        let before = entities[0].as_object().expect("station object");
        let pointer = json_key_pointer(before, "stationPeerId");
        let order = before.keys().cloned().collect::<Vec<_>>();

        set_peer(&mut entities, 0, "mod:station/新");

        let after = entities[0].as_object().expect("station object");
        assert_eq!(json_key_pointer(after, "stationPeerId"), pointer);
        assert_eq!(after.keys().cloned().collect::<Vec<_>>(), order);
        assert_eq!(after["stationPeerId"], Value::from("mod:station/新"));

        let mut missing = vec![Value::Object(Map::new())];
        set_peer(&mut missing, 0, "station-first");
        assert_eq!(missing[0]["stationPeerId"], Value::from("station-first"));
    }

    fn local_station(id: &str, mode: &str) -> Value {
        let mut configured = json!({
            "itemId": "mod:物流物料/Ω",
            "localMode": mode,
            "minimumLoad": 0.1,
            "minStock": 0,
            "maxStock": 100,
            "priority": 1
        });
        let empty = json!({
            "itemId": null,
            "localMode": "storage",
            "minimumLoad": 0.1,
            "minStock": 0,
            "maxStock": 0,
            "priority": 1
        });
        json!({
            "id": id,
            "kind": "station",
            "planetId": "mod:行星/β",
            "buildingId": "planetary_logistics_station",
            "machineCount": 1,
            "stationSlots": [
                std::mem::take(&mut configured),
                empty.clone(),
                empty.clone(),
                empty.clone(),
                empty
            ],
            "inputs": {},
            "outputs": { "mod:物流物料/Ω": 10 }
        })
    }

    #[test]
    fn local_directory_interns_repeated_slot_items_and_keeps_compact_slots() {
        let entities = (0_usize..64)
            .map(|index| {
                local_station(
                    &format!("station-{index}"),
                    if index.is_multiple_of(2) {
                        "supply"
                    } else {
                        "demand"
                    },
                )
            })
            .collect::<Vec<_>>();
        let indices = station_indices(&entities);
        let directory = prepare_step_directory(&entities, &indices).unwrap();
        let first_item = directory.station_slots[&indices[0]][0]
            .item_id
            .as_ref()
            .expect("first station item");
        let last_item = directory.station_slots[indices.last().expect("last station")][0]
            .item_id
            .as_ref()
            .expect("last station item");
        let peer_item = directory
            .by_planet_item
            .values()
            .flat_map(HashMap::keys)
            .next()
            .expect("peer item");

        assert!(Arc::ptr_eq(first_item, last_item));
        assert!(Arc::ptr_eq(first_item, peer_item));
        assert!(std::mem::size_of::<Slot>() <= 48);
        assert!(
            directory.slot_item_allocation_bytes < first_item.len() * directory.station_slots.len(),
            "the resident estimate must count one shared item allocation, not one String per slot"
        );
    }

    fn fixture_checksum(bytes: &[u8]) -> String {
        let mut hash = 0x811c9dc5_u32;
        for byte in bytes {
            hash ^= u32::from(*byte);
            hash = hash.wrapping_mul(0x01000193);
        }
        format!("{hash:08x}")
    }

    fn route_fixture_catalog() -> RuntimeCatalog {
        RuntimeCatalog::validate(
            CatalogSnapshot {
                protocol_version: 1,
                registry_fingerprint: "local-route-active-test".to_owned(),
                planets: vec![PlanetDefinition {
                    id: "home".to_owned(),
                    name: "route-test".to_owned(),
                    system_id: "helios".to_owned(),
                    kind: "terrestrial".to_owned(),
                    orbit_index: 1,
                    simulation_order: 0,
                    orbital_yields: HashMap::new(),
                }],
                items: vec![ItemDefinition {
                    id: "iron_ore".to_owned(),
                    name: "route-item".to_owned(),
                    kind: "solid".to_owned(),
                    fuel_energy_mj: 0.0,
                }],
                buildings: [
                    "planetary_logistics_station",
                    "interstellar_logistics_station",
                ]
                .into_iter()
                .map(|id| BuildingDefinition {
                    id: id.to_owned(),
                    kind: "station".to_owned(),
                    speed: 1.0,
                    input_capacity: 100_000.0,
                    output_capacity: 100_000.0,
                    power_demand_kw: 1.0,
                    power_generation_kw: 0.0,
                    power_charge_kw: 0.0,
                    energy_capacity_mj: 0.0,
                    fuel_item_ids: Vec::new(),
                    fuel_efficiency: 1.0,
                    family: None,
                    accepts: None,
                })
                .collect(),
                recipes: Vec::new(),
                constructions: Vec::new(),
                belts: vec![BeltDefinition {
                    tier: 1,
                    speed: 6.0,
                }],
                proliferators: Vec::new(),
                technologies: Vec::new(),
            },
            "local-route-active-test",
        )
        .unwrap()
    }

    fn route_fixture_base() -> Value {
        json!({
            "version": 47,
            "mode": "normal",
            "paused": false,
            "activePlanetId": "home",
            "nextId": 1000,
            "settings": {
                "logisticsBufferLimit": 1000000,
                "difficulty": "standard"
            },
            "research": { "completedTechIds": [] },
            "endgame": {
                "infiniteResearch": { "galactic_logistics": { "level": 0 } }
            },
            "mod:base/opaque": { "signedZero": -0.0, "text": "保持原样" }
        })
    }

    fn route_station(index: usize, mode: &str) -> Value {
        let mut station = local_station(&format!("station/{index:05}/Ω"), mode);
        let station = station.as_object_mut().expect("route fixture station");
        station.insert("planetId".to_owned(), Value::from("home"));
        station["stationSlots"]
            .as_array_mut()
            .and_then(|slots| slots.first_mut())
            .and_then(Value::as_object_mut)
            .expect("route fixture primary slot")
            .insert("itemId".to_owned(), Value::from("iron_ore"));
        station.insert("inputs".to_owned(), json!({ "iron_ore": 0.0 }));
        station.insert(
            "outputs".to_owned(),
            json!({ "iron_ore": if index == 0 { 100000000.0 } else { 0.0 } }),
        );
        station.insert("stationDrones".to_owned(), Value::from(50));
        station.insert("stationRoutes".to_owned(), Value::Array(Vec::new()));
        station.insert("stationDispatchCursor".to_owned(), Value::from(0.0));
        station.insert(
            "stationLastSupplyPeerBySlot".to_owned(),
            Value::Object(Map::new()),
        );
        station.insert("stationProgress".to_owned(), Value::from(0.0));
        station.insert("stationCongestion".to_owned(), Value::from(0.0));
        station.insert("stationTrips".to_owned(), Value::from(0.0));
        station.insert("stationLastTransfer".to_owned(), Value::from(0.0));
        station.insert("utilization".to_owned(), Value::from(0.0));
        station.insert("productionRate".to_owned(), Value::from(0.0));
        station.insert(
            "mod:route/opaque".to_owned(),
            json!({ "index": index, "signedZero": -0.0, "text": "原样" }),
        );
        Value::Object(station.clone())
    }

    #[test]
    fn runtime_reset_is_full_once_then_exactly_sparse_and_byte_identical() {
        let mut source = route_matrix(8, &[], 0.0, 10.0);
        let all_indices = (0..source.len()).collect::<Vec<_>>();
        let mut directory = prepare_step_directory(&source, &all_indices).unwrap();
        assert_eq!(directory.runtime_reset_station_indices(), all_indices);

        for index in [2_usize, 6] {
            let station = source[index].as_object_mut().unwrap();
            station.insert("utilization".to_owned(), Value::from(0.75));
            station.insert("productionRate".to_owned(), Value::from(123.5));
            station.insert(
                "stationPeerId".to_owned(),
                Value::from(format!("station/runtime-peer/{index}")),
            );
        }
        directory.replace_runtime_reset_station_indices(vec![6, 2, 6]);
        assert_eq!(directory.runtime_reset_station_indices(), [2, 6]);

        let mut sparse = source.clone();
        let mut full = source;
        reset_runtime_for_indices(&mut sparse, directory.runtime_reset_station_indices()).unwrap();
        reset_runtime_for_indices(&mut full, &all_indices).unwrap();
        assert_eq!(
            serde_json::to_vec(&sparse).unwrap(),
            serde_json::to_vec(&full).unwrap(),
        );
    }

    #[test]
    fn sparse_congestion_scans_waiting_and_route_activity_then_clears_once() {
        let count = 256;
        let mut entities = (0..count)
            .map(|index| {
                route_station(
                    index,
                    if index == 0 {
                        "supply"
                    } else if index == 7 {
                        "demand"
                    } else {
                        "storage"
                    },
                )
            })
            .collect::<Vec<_>>();
        entities[113]["stationRoutes"] =
            Value::Array(vec![local_route(113, 113, 0.25, 120.0, 11.0)]);
        let state = route_fixture_state(&entities);
        let activity = crate::interstellar_logistics::prepare_route_activity(&entities);
        let mut directory =
            prepare_step_directory(&entities, &state.factory_topology.station_indices).unwrap();
        directory.replace_local_congestion_reset_station_indices(Vec::new());
        let ledger = StationRouteLedger::build(&state, &entities, &directory, &activity);

        let full_updates = plan_congestion_updates(
            &DeterministicRuntime::for_test(4),
            &entities,
            &directory,
            &ledger,
        )
        .unwrap();
        let mut expected = entities.clone();
        apply_congestion_updates(&mut expected, full_updates).unwrap();
        let scan = update_congestion(&state, &mut entities, &mut directory, &ledger).unwrap();
        assert_eq!(scan.selected_station_rows, 3);
        assert_eq!(scan.total_station_rows, count);
        assert!(!scan.dense_fallback);
        assert_eq!(
            serde_json::to_vec(&entities).unwrap(),
            serde_json::to_vec(&expected).unwrap()
        );
        assert_eq!(directory.local_congestion_reset_station_indices(), [0, 113]);

        // A completed route leaves its former endpoints in the reset set for
        // exactly one more step; after their progress is cleared, only the
        // statically waiting demand remains observable work.
        entities[113]["stationRoutes"] = Value::Array(Vec::new());
        let activity = crate::interstellar_logistics::prepare_route_activity(&entities);
        let ledger = StationRouteLedger::build(&state, &entities, &directory, &activity);
        let scan = update_congestion(&state, &mut entities, &mut directory, &ledger).unwrap();
        assert_eq!(scan.selected_station_rows, 3);
        assert!(
            directory
                .local_congestion_reset_station_indices()
                .is_empty()
        );
        let scan = update_congestion(&state, &mut entities, &mut directory, &ledger).unwrap();
        assert_eq!(scan.selected_station_rows, 1);
        assert_eq!(entities[0]["stationProgress"], Value::from(0.0));
        assert_eq!(entities[113]["stationProgress"], Value::from(0.0));
    }

    fn local_route(
        id: usize,
        demand_index: usize,
        progress: f64,
        duration: f64,
        cargo: f64,
    ) -> Value {
        json!({
            "id": format!("local-route/{id:05}"),
            "slotIndex": 0,
            "peerId": "station/00000/Ω",
            "itemId": "iron_ore",
            "scope": "local",
            "cargo": cargo,
            "vehicleCount": 1,
            "progress": progress,
            "duration": duration,
            "requiresWarp": false,
            "waypointStationIds": [],
            "distanceLy": 0,
            "warpersPerVessel": 0,
            "vehicleStationId": format!("station/{demand_index:05}/Ω")
        })
    }

    fn route_matrix(count: usize, active: &[usize], progress: f64, duration: f64) -> Vec<Value> {
        let active = active.iter().copied().collect::<HashSet<_>>();
        (0..count)
            .map(|index| {
                let mut station =
                    route_station(index, if index == 0 { "supply" } else { "demand" });
                if active.contains(&index) {
                    station["stationRoutes"] =
                        Value::Array(vec![local_route(index, index, progress, duration, 11.0)]);
                }
                station
            })
            .collect()
    }

    fn route_fixture_state(entities: &[Value]) -> CoreState {
        let entity_count = entities.len();
        let base = serde_json::to_vec(&route_fixture_base()).unwrap();
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
                registry_fingerprint: "local-route-active-test".to_owned(),
                base_primary_checksum: "12345678".to_owned(),
            },
            &records,
            route_fixture_catalog(),
        )
        .unwrap()
    }

    fn route_powers(count: usize, factor: f64) -> HashMap<usize, f64> {
        (0..count).map(|index| (index, factor)).collect()
    }

    #[test]
    fn prepared_directory_survives_dynamic_updates_and_rebuilds_for_elevator_mode() {
        let mut entities = vec![
            local_station("supply", "supply"),
            local_station("demand", "demand"),
        ];
        let station_indices = vec![0, 1];
        let cached = prepare_step_directory(&entities, &station_indices).unwrap();
        assert_eq!(peer_matches(&cached, 1, 0).unwrap(), vec![(0, 0)]);

        entities[0]["outputs"]["mod:物流物料/Ω"] = Value::from(7);
        entities[1]["stationProgress"] = Value::from(0.75);
        let rebuilt_dynamic = prepare_step_directory(&entities, &station_indices).unwrap();
        assert_eq!(
            peer_matches(&cached, 1, 0).unwrap(),
            peer_matches(&rebuilt_dynamic, 1, 0).unwrap()
        );

        entities[0]["buildingId"] = Value::from("interstellar_logistics_station");
        entities[0]["stationTier"] = Value::from(2);
        entities[0]["stationOperationMode"] = Value::from("elevator");
        let rebuilt_boundary = prepare_step_directory(&entities, &station_indices).unwrap();
        assert!(peer_matches(&rebuilt_boundary, 1, 0).unwrap().is_empty());
        assert_eq!(rebuilt_boundary.station_indices.as_ref(), &[1]);
    }

    fn run_buffer_activity_steps(
        source: &[Value],
        iterations: usize,
        force_full_scan: bool,
    ) -> (Vec<Value>, LocalPeerDirectory, Vec<(usize, bool)>) {
        let state = route_fixture_state(source);
        let base = route_fixture_base();
        let base = base.as_object().expect("buffer fixture base");
        let mut entities = source.to_vec();
        let mut directory =
            prepare_step_directory(&entities, &state.factory_topology.station_indices).unwrap();
        transfer_buffers(&state, base, &mut entities, &mut directory).unwrap();
        assert!(directory.buffer_activity_initialized);

        let active = [7, source.len() / 2, source.len() - 1];
        let changed = [0, active[0], active[1], active[2]];
        let mut scans = Vec::with_capacity(iterations);
        for _ in 0..iterations {
            for station_index in active {
                let station = entities[station_index]
                    .as_object_mut()
                    .expect("buffer fixture station");
                let current = item_amount(station, "inputs", "iron_ore");
                set_item_amount(station, "inputs", "iron_ore", current + 1.0).unwrap();
            }
            wake_transfer_buffers_from_changed_entities(&entities, &changed, &mut directory)
                .unwrap();
            let (scheduled, dense) = directory.buffer_scan_indices();
            scans.push((scheduled.len(), dense));
            if force_full_scan {
                let full_indices = directory.station_indices.to_vec();
                let updates = transfer_buffers_for_indices(
                    &state,
                    base,
                    &mut entities,
                    &directory,
                    &full_indices,
                )
                .unwrap();
                directory.replace_scanned_buffer_activity(&updates);
            } else {
                transfer_buffers(&state, base, &mut entities, &mut directory).unwrap();
            }
        }
        (entities, directory, scans)
    }

    #[test]
    fn sparse_buffer_activity_matches_full_oracle_for_1_5_60_steps() {
        let count = PARALLEL_MIN_ITEMS + 113;
        let source = route_matrix(count, &[], 0.0, 1.0);
        let state = route_fixture_state(&source);
        let source_hash = state.canonical_sha256().unwrap();

        for iterations in [1, 5, 60] {
            let scheduled = run_buffer_activity_steps(&source, iterations, false);
            let oracle = run_buffer_activity_steps(&source, iterations, true);
            assert!(scheduled.2.iter().all(|scan| *scan == (3, false)));
            assert_eq!(
                serde_json::to_vec(&scheduled.0).unwrap(),
                serde_json::to_vec(&oracle.0).unwrap(),
                "sparse buffer replay diverged at {iterations} steps"
            );
            assert_eq!(
                scheduled.1.buffer_active_station_indices,
                oracle.1.buffer_active_station_indices
            );
        }
        assert_eq!(state.canonical_sha256().unwrap(), source_hash);
    }

    #[test]
    fn dense_buffer_activity_falls_back_at_exact_three_quarters() {
        let count = 100;
        let state_source = route_matrix(count, &[], 0.0, 1.0);
        let state = route_fixture_state(&state_source);
        let base = route_fixture_base();
        let base = base.as_object().unwrap();
        let mut scheduled_entities = state_source.clone();
        let mut scheduled =
            prepare_step_directory(&scheduled_entities, &state.factory_topology.station_indices)
                .unwrap();
        transfer_buffers(&state, base, &mut scheduled_entities, &mut scheduled).unwrap();
        for entity in scheduled_entities.iter_mut().take(75) {
            set_item_amount(entity.as_object_mut().unwrap(), "inputs", "iron_ore", 1.0).unwrap();
        }
        let changed = (0..75).collect::<Vec<_>>();
        wake_transfer_buffers_from_changed_entities(&scheduled_entities, &changed, &mut scheduled)
            .unwrap();
        let (scan_indices, dense) = scheduled.buffer_scan_indices();
        assert!(dense);
        assert_eq!(scan_indices, scheduled.station_indices.as_ref());

        let mut oracle_entities = scheduled_entities.clone();
        let mut oracle = scheduled.clone();
        transfer_buffers(&state, base, &mut scheduled_entities, &mut scheduled).unwrap();
        let full_indices = oracle.station_indices.to_vec();
        let updates = transfer_buffers_for_indices(
            &state,
            base,
            &mut oracle_entities,
            &oracle,
            &full_indices,
        )
        .unwrap();
        oracle.replace_scanned_buffer_activity(&updates);
        assert_eq!(
            serde_json::to_vec(&scheduled_entities).unwrap(),
            serde_json::to_vec(&oracle_entities).unwrap()
        );
        assert_eq!(
            scheduled.buffer_active_station_indices,
            oracle.buffer_active_station_indices
        );
    }

    #[test]
    fn blocked_buffer_stays_awake_then_drain_completion_removes_it() {
        let mut entities = route_matrix(32, &[], 0.0, 1.0);
        entities[7]["outputs"]["iron_ore"] = Value::from(100_000.0);
        entities[7]["inputs"]["iron_ore"] = Value::from(9.0);
        let state = route_fixture_state(&entities);
        let base = route_fixture_base();
        let mut directory =
            prepare_step_directory(&entities, &state.factory_topology.station_indices).unwrap();

        transfer_buffers(
            &state,
            base.as_object().unwrap(),
            &mut entities,
            &mut directory,
        )
        .unwrap();
        assert_eq!(directory.buffer_active_station_indices, vec![7]);
        assert_eq!(entities[7]["inputs"]["iron_ore"], Value::from(9.0));

        entities[7]["outputs"]["iron_ore"] = Value::from(0.0);
        transfer_buffers(
            &state,
            base.as_object().unwrap(),
            &mut entities,
            &mut directory,
        )
        .unwrap();
        assert!(directory.buffer_active_station_indices.is_empty());
        assert_eq!(entities[7]["inputs"]["iron_ore"], Value::from(0.0));
        assert_eq!(entities[7]["outputs"]["iron_ore"], Value::from(9.0));
    }

    #[test]
    fn external_input_arrival_wakes_buffer_and_empty_evidence_does_not() {
        let mut entities = route_matrix(32, &[], 0.0, 1.0);
        let state = route_fixture_state(&entities);
        let base = route_fixture_base();
        let mut directory =
            prepare_step_directory(&entities, &state.factory_topology.station_indices).unwrap();
        transfer_buffers(
            &state,
            base.as_object().unwrap(),
            &mut entities,
            &mut directory,
        )
        .unwrap();
        wake_transfer_buffers_from_changed_entities(&entities, &[], &mut directory).unwrap();
        assert!(directory.buffer_active_station_indices.is_empty());

        entities[11]["inputs"]["iron_ore"] = Value::from(4.0);
        wake_transfer_buffers_from_changed_entities(&entities, &[0, 11], &mut directory).unwrap();
        assert_eq!(directory.buffer_active_station_indices, vec![11]);
        transfer_buffers(
            &state,
            base.as_object().unwrap(),
            &mut entities,
            &mut directory,
        )
        .unwrap();
        assert_eq!(entities[11]["outputs"]["iron_ore"], Value::from(4.0));
        assert!(directory.buffer_active_station_indices.is_empty());
    }

    #[test]
    fn topology_refresh_reuses_arc_without_transition_and_rebuilds_on_change() {
        let mut entities = vec![
            local_station("supply", "supply"),
            local_station("demand", "demand"),
        ];
        let station_indices = vec![0, 1];
        let mut directory = Arc::new(prepare_step_directory(&entities, &station_indices).unwrap());
        let shared = Arc::clone(&directory);
        refresh_step_directory_after_topology_change(
            &entities,
            &station_indices,
            false,
            &mut directory,
        )
        .unwrap();
        assert!(Arc::ptr_eq(&directory, &shared));

        entities[0]["buildingId"] = Value::from("interstellar_logistics_station");
        entities[0]["stationTier"] = Value::from(2);
        entities[0]["stationOperationMode"] = Value::from("elevator");
        refresh_step_directory_after_topology_change(
            &entities,
            &station_indices,
            true,
            &mut directory,
        )
        .unwrap();
        assert!(!Arc::ptr_eq(&directory, &shared));
        assert_eq!(directory.station_indices.as_ref(), &[1]);
        assert!(!directory.buffer_activity_initialized);
    }

    #[test]
    fn failed_buffer_candidate_keeps_source_cache_and_json_atomic() {
        let mut source = route_matrix(128, &[], 0.0, 1.0);
        source[7]["inputs"]["iron_ore"] = Value::from(3.0);
        source[83]["inputs"]["iron_ore"] = Value::from(5.0);
        source[83]["outputs"] = Value::Null;
        let state = route_fixture_state(&source);
        let base = route_fixture_base();
        let source_json = serde_json::to_vec(&source).unwrap();
        let source_hash = state.canonical_sha256().unwrap();
        let source_directory = Arc::new(
            prepare_step_directory(&source, &state.factory_topology.station_indices).unwrap(),
        );
        let source_activity = source_directory.buffer_active_station_indices.clone();
        let mut candidate_directory = Arc::clone(&source_directory);
        let candidate_runtime = Arc::make_mut(&mut candidate_directory);
        let mut candidate = source.clone();
        let error = transfer_buffers(
            &state,
            base.as_object().unwrap(),
            &mut candidate,
            candidate_runtime,
        )
        .unwrap_err();
        assert_eq!(
            error.to_string(),
            "native local logistics inventory is missing"
        );
        assert_eq!(
            source_directory.buffer_active_station_indices,
            source_activity
        );
        assert_eq!(
            candidate_directory.buffer_active_station_indices,
            source_activity
        );
        assert!(!source_directory.buffer_activity_initialized);
        assert!(!candidate_directory.buffer_activity_initialized);
        assert_eq!(serde_json::to_vec(&source).unwrap(), source_json);
        assert_eq!(state.canonical_sha256().unwrap(), source_hash);
    }

    fn local_congestion_matrix(count: usize) -> (Vec<Value>, LocalPeerDirectory, Ledger) {
        let mut entities = (0..count)
            .map(|index| {
                let mut station = local_station(
                    &format!("mod:本地站/{index:05}/Ω"),
                    if index == 0 { "supply" } else { "demand" },
                );
                let record = station.as_object_mut().expect("local congestion station");
                record.insert("stationDrones".to_owned(), Value::from(50));
                record.insert("stationRoutes".to_owned(), Value::Array(Vec::new()));
                record.insert("stationCongestion".to_owned(), Value::from(-1));
                record.insert("stationProgress".to_owned(), Value::from(-1));
                record.insert(
                    "mod:拥堵探针/原样保留".to_owned(),
                    json!({ "index": index, "signedZero": -0.0, "opaque": "Ω🚀" }),
                );
                station
            })
            .collect::<Vec<_>>();
        // A non-station row in the topology slice exercises the legacy skip
        // without changing the relative replay order of station updates.
        entities.push(json!({
            "id": "mod:非物流实体/保持",
            "kind": "machine",
            "buildingId": "mod:machine",
            "mod:payload": [3, 2, 1]
        }));
        let station_indices = (0..entities.len()).collect::<Vec<_>>();
        let directory = prepare_step_directory(&entities, &station_indices).unwrap();
        let mut ledger = Ledger::default();
        for station_index in 0..count {
            ledger
                .busy
                .insert(station_index, (station_index % 67) as f64);
            ledger.active_local_progress.insert(
                station_index,
                f64::from((station_index % 101) as u32) / 101.0,
            );
        }
        (entities, directory, ledger)
    }

    fn run_local_congestion_plan(worker_count: usize) -> Vec<Value> {
        let (mut entities, directory, ledger) = local_congestion_matrix(PARALLEL_MIN_ITEMS + 37);
        let source = serde_json::to_vec(&entities).unwrap();
        let updates = plan_congestion_updates(
            &DeterministicRuntime::for_test(worker_count),
            &entities,
            &directory,
            &ledger,
        )
        .unwrap();
        assert_eq!(
            serde_json::to_vec(&entities).unwrap(),
            source,
            "read-only probes must not mutate their source"
        );
        apply_congestion_updates(&mut entities, updates).unwrap();
        entities
    }

    #[test]
    fn local_congestion_parallel_probe_is_bitwise_stable_for_1_2_4_8_workers() {
        let expected = run_local_congestion_plan(1);
        let expected_bytes = serde_json::to_vec(&expected).unwrap();
        for worker_count in [2, 4, 8] {
            let actual = run_local_congestion_plan(worker_count);
            assert_eq!(serde_json::to_vec(&actual).unwrap(), expected_bytes);
        }

        let first = expected[0].as_object().unwrap();
        let waiting = expected[67].as_object().unwrap();
        let saturated = expected[66].as_object().unwrap();
        assert_eq!(first["stationCongestion"], Value::from(0.0));
        assert_eq!(waiting["stationCongestion"], Value::from(0.35));
        assert_eq!(saturated["stationCongestion"], Value::from(1.0));
        assert_eq!(
            waiting["mod:拥堵探针/原样保留"]["opaque"],
            Value::from("Ω🚀")
        );
    }

    #[test]
    fn local_congestion_parallel_failure_keeps_source_atomic() {
        let (entities, mut directory, ledger) = local_congestion_matrix(PARALLEL_MIN_ITEMS + 11);
        Arc::make_mut(&mut directory.station_slots).remove(&7);
        Arc::make_mut(&mut directory.station_slots).remove(&(PARALLEL_MIN_ITEMS + 3));
        let source = serde_json::to_vec(&entities).unwrap();

        for worker_count in [1, 2, 4, 8] {
            let error = plan_congestion_updates(
                &DeterministicRuntime::for_test(worker_count),
                &entities,
                &directory,
                &ledger,
            )
            .expect_err("missing station slots must reject the whole probe batch");
            assert_eq!(error.to_string(), "native local station slots are missing");
            assert_eq!(serde_json::to_vec(&entities).unwrap(), source);
        }
    }

    fn run_ready_station_plan(worker_count: usize) -> (Vec<Option<usize>>, Vec<usize>) {
        let (entities, directory, mut ledger) = local_congestion_matrix(PARALLEL_MIN_ITEMS + 43);
        ledger.active_local_stations.insert(7);
        let source = serde_json::to_vec(&entities).unwrap();
        let planned = plan_ready_station_indices_with(
            &DeterministicRuntime::for_test(worker_count),
            &entities,
            &directory,
            directory.station_indices.as_ref(),
            &ledger,
            25.0,
            |demand_index, _, _| Ok(if demand_index % 2 == 0 { 100.0 } else { 10.0 }),
        )
        .unwrap();
        assert_eq!(
            serde_json::to_vec(&entities).unwrap(),
            source,
            "ready probes must not mutate routes, inventories, or MOD fields"
        );
        let mut ready = replay_ready_station_indices(planned.clone())
            .into_iter()
            .collect::<Vec<_>>();
        ready.sort_unstable();
        (planned, ready)
    }

    #[test]
    fn ready_station_parallel_probe_is_exact_for_1_2_4_8_workers() {
        let expected = run_ready_station_plan(1);
        for worker_count in [2, 4, 8] {
            assert_eq!(run_ready_station_plan(worker_count), expected);
        }

        let (planned, ready) = expected;
        assert_eq!(planned[0], Some(0));
        assert_eq!(planned[1], None);
        assert_eq!(planned[2], Some(2));
        assert_eq!(planned[7], Some(7));
        assert!(ready.contains(&0));
        assert!(ready.contains(&2));
        assert!(ready.contains(&7));
        assert!(!ready.contains(&1));
        assert!(!ready.contains(&9));
    }

    #[test]
    fn ready_station_parallel_failure_uses_lowest_index_and_keeps_source_atomic() {
        let (entities, directory, ledger) = local_congestion_matrix(PARALLEL_MIN_ITEMS + 23);
        let source = serde_json::to_vec(&entities).unwrap();
        let later_failure = PARALLEL_MIN_ITEMS + 11;

        for worker_count in [1, 2, 4, 8] {
            let visited_later_failure = AtomicBool::new(false);
            let error = plan_ready_station_indices_with(
                &DeterministicRuntime::for_test(worker_count),
                &entities,
                &directory,
                directory.station_indices.as_ref(),
                &ledger,
                25.0,
                |demand_index, _, _| {
                    if demand_index == later_failure {
                        visited_later_failure.store(true, AtomicOrdering::SeqCst);
                        bail!("later local ready probe failure");
                    }
                    if demand_index == 7 {
                        bail!("first local ready probe failure");
                    }
                    Ok(100.0)
                },
            )
            .expect_err("any failed readiness probe must reject the whole batch");
            assert_eq!(error.to_string(), "first local ready probe failure");
            assert!(
                visited_later_failure.load(AtomicOrdering::SeqCst),
                "all probes must finish before the lowest input error is selected"
            );
            assert_eq!(serde_json::to_vec(&entities).unwrap(), source);
        }
    }

    #[test]
    fn small_ready_station_batches_stay_serial() {
        let (entities, directory, ledger) = local_congestion_matrix(31);
        let saw_rayon_worker = AtomicBool::new(false);
        let planned = plan_ready_station_indices_with(
            &DeterministicRuntime::for_test(8),
            &entities,
            &directory,
            directory.station_indices.as_ref(),
            &ledger,
            25.0,
            |_, _, _| {
                if rayon::current_thread_index().is_some() {
                    saw_rayon_worker.store(true, AtomicOrdering::SeqCst);
                }
                Ok(100.0)
            },
        )
        .unwrap();
        assert_eq!(planned.len(), directory.station_indices.len());
        assert!(!saw_rayon_worker.load(AtomicOrdering::SeqCst));
    }

    fn sparse_readiness_matrix(count: usize, demand_count: usize) -> Vec<Value> {
        assert!(demand_count < count);
        let mut entities = (0..count)
            .map(|index| {
                route_station(
                    index,
                    if index == 0 {
                        "supply"
                    } else if index <= demand_count {
                        "demand"
                    } else {
                        "storage"
                    },
                )
            })
            .collect::<Vec<_>>();
        entities[0]["outputs"]["iron_ore"] = Value::from(0.0);
        entities
    }

    #[test]
    fn sparse_readiness_wake_matches_full_power_dispatch_and_route_oracle_at_1_5_60() {
        let count = 32;
        let source = sparse_readiness_matrix(count, 1);
        let state = route_fixture_state(&source);
        let base = route_fixture_base();
        let base = base.as_object().expect("local readiness base");
        let mut initialized_directory =
            prepare_step_directory(&source, &state.factory_topology.station_indices).unwrap();
        let initial_activity = crate::interstellar_logistics::prepare_route_activity(&source);
        let initial_ledger =
            StationRouteLedger::build(&state, &source, &initialized_directory, &initial_activity);
        let (initial_ready, initial_scan) = ready_station_indices_with_scan(
            &state,
            base,
            &source,
            &mut initialized_directory,
            &initial_ledger,
        )
        .unwrap();
        assert!(initial_ready.is_empty());
        assert_eq!(initial_scan.selected_station_rows, count);
        assert!(initial_scan.signature_fallback);

        for seconds in [1.0, 5.0, 60.0] {
            let mut indexed_entities = source.clone();
            indexed_entities[0]["outputs"]["iron_ore"] = Value::from(100.0);
            let mut oracle_entities = indexed_entities.clone();
            let mut indexed_base = base.clone();
            let mut oracle_base = base.clone();
            let mut indexed_directory = initialized_directory.clone();
            let mut oracle_directory = initialized_directory.clone();
            indexed_directory.wake_ready_from_changed_stations(&[0]);

            let indexed_activity =
                crate::interstellar_logistics::prepare_route_activity(&indexed_entities);
            let oracle_activity =
                crate::interstellar_logistics::prepare_route_activity(&oracle_entities);
            let mut indexed_ledger = StationRouteLedger::build(
                &state,
                &indexed_entities,
                &indexed_directory,
                &indexed_activity,
            );
            let mut oracle_ledger = StationRouteLedger::build(
                &state,
                &oracle_entities,
                &oracle_directory,
                &oracle_activity,
            );
            let (indexed_ready, scan) = ready_station_indices_with_scan(
                &state,
                &indexed_base,
                &indexed_entities,
                &mut indexed_directory,
                &indexed_ledger,
            )
            .unwrap();
            assert_eq!(scan.selected_station_rows, 2, "sparse scan at {seconds}s");
            assert_eq!(scan.total_station_rows, count);
            assert!(!scan.dense_fallback);
            assert!(!scan.directory_fallback);
            assert!(!scan.signature_fallback);

            let full_planned = plan_ready_station_indices_with(
                &DeterministicRuntime::for_test(4),
                &oracle_entities,
                &oracle_directory,
                oracle_directory.station_indices.as_ref(),
                &oracle_ledger,
                cargo_capacity(&oracle_base),
                |_, demand, slot| {
                    station_capacity(&state, demand, slot, normalized_buffer_limit(&oracle_base))
                },
            )
            .unwrap();
            let full_ready = replay_ready_station_indices(full_planned);
            let mut indexed_ready_ordered = indexed_ready.iter().copied().collect::<Vec<_>>();
            let mut full_ready_ordered = full_ready.iter().copied().collect::<Vec<_>>();
            indexed_ready_ordered.sort_unstable();
            full_ready_ordered.sort_unstable();
            assert_eq!(indexed_ready_ordered, vec![0, 1]);
            assert_eq!(indexed_ready_ordered, full_ready_ordered);

            let indexed_powers = indexed_ready
                .iter()
                .map(|index| (*index, 1.0))
                .collect::<HashMap<_, _>>();
            let oracle_powers = full_ready
                .iter()
                .map(|index| (*index, 1.0))
                .collect::<HashMap<_, _>>();
            let dispatch_scan = dispatch(
                &state,
                &mut indexed_base,
                &mut indexed_entities,
                &indexed_powers,
                &mut indexed_directory,
                &mut indexed_ledger,
            )
            .unwrap();
            assert_eq!(dispatch_scan.selected_station_rows, 1);
            assert_eq!(dispatch_scan.total_station_rows, count);
            assert!(!dispatch_scan.dense_fallback);
            assert!(!dispatch_scan.directory_fallback);
            dispatch_full_scan_oracle(
                &state,
                &mut oracle_base,
                &mut oracle_entities,
                &oracle_powers,
                &mut oracle_directory,
                &mut oracle_ledger,
            )
            .unwrap();
            advance_routes(
                &state,
                &mut indexed_base,
                &mut indexed_entities,
                seconds,
                &indexed_powers,
                &mut indexed_directory,
            )
            .unwrap();
            advance_routes(
                &state,
                &mut oracle_base,
                &mut oracle_entities,
                seconds,
                &oracle_powers,
                &mut oracle_directory,
            )
            .unwrap();
            assert_eq!(
                serde_json::to_vec(&json!({
                    "base": indexed_base,
                    "entities": indexed_entities,
                }))
                .unwrap(),
                serde_json::to_vec(&json!({
                    "base": oracle_base,
                    "entities": oracle_entities,
                }))
                .unwrap(),
                "sparse local readiness diverged from full scan at {seconds}s"
            );
        }
    }

    #[test]
    fn readiness_uses_exact_three_quarter_dense_signature_and_mismatch_fallbacks() {
        let count = 16;
        let mut entities = sparse_readiness_matrix(count, 11);
        let state = route_fixture_state(&entities);
        let mut base = route_fixture_base();
        let mut directory =
            prepare_step_directory(&entities, &state.factory_topology.station_indices).unwrap();
        let activity = crate::interstellar_logistics::prepare_route_activity(&entities);
        let ledger = StationRouteLedger::build(&state, &entities, &directory, &activity);
        ready_station_indices_with_scan(
            &state,
            base.as_object().unwrap(),
            &entities,
            &mut directory,
            &ledger,
        )
        .unwrap();

        entities[0]["outputs"]["iron_ore"] = Value::from(1_000.0);
        directory.wake_ready_from_changed_stations(&[0]);
        let activity = crate::interstellar_logistics::prepare_route_activity(&entities);
        let ledger = StationRouteLedger::build(&state, &entities, &directory, &activity);
        let (_, dense_scan) = ready_station_indices_with_scan(
            &state,
            base.as_object().unwrap(),
            &entities,
            &mut directory,
            &ledger,
        )
        .unwrap();
        assert_eq!(dense_scan.selected_station_rows, count);
        assert!(dense_scan.dense_fallback);
        assert!(!dense_scan.directory_fallback);

        base["settings"]["logisticsBufferLimit"] = Value::from(2_000.0);
        let (_, _, signature_scan) =
            directory.readiness_scan_indices(base.as_object().unwrap(), &ledger);
        assert_eq!(signature_scan.selected_station_rows, count);
        assert!(signature_scan.signature_fallback);

        let mut substituted_ranks = directory.station_ranks.as_ref().clone();
        let rank = substituted_ranks.remove(&0).unwrap();
        substituted_ranks.insert(count + 9, rank);
        assert_eq!(substituted_ranks.len(), directory.station_ranks.len());
        assert!(!readiness_directory_is_exact(
            directory.station_indices.as_ref(),
            &substituted_ranks,
            &directory.station_slots,
            &directory.station_planets,
        ));

        let mut mismatched_indices = directory.station_indices.to_vec();
        mismatched_indices[1] = mismatched_indices[0];
        let mismatched = build_peer_directory(
            &entities,
            &mismatched_indices,
            &state.factory_topology.station_indices,
        )
        .unwrap();
        let (_, _, mismatch_scan) =
            mismatched.readiness_scan_indices(base.as_object().unwrap(), &ledger);
        assert_eq!(mismatch_scan.selected_station_rows, count);
        assert!(mismatch_scan.directory_fallback);
    }

    fn run_local_dispatch_slice(
        source: &[Value],
        seconds: usize,
        force_full_scan: bool,
    ) -> (Vec<u8>, Vec<LocalDispatchScan>) {
        let state = route_fixture_state(source);
        let mut base = route_fixture_base();
        let mut entities = source.to_vec();
        let mut directory =
            prepare_step_directory(&entities, &state.factory_topology.station_indices).unwrap();
        let powers = HashMap::from([(0, 1.0), (1, 1.0)]);
        let mut scans = Vec::with_capacity(seconds);
        for _ in 0..seconds {
            let remote_activity = crate::interstellar_logistics::prepare_route_activity(&entities);
            let mut ledger =
                StationRouteLedger::build(&state, &entities, &directory, &remote_activity);
            let scan = if force_full_scan {
                dispatch_full_scan_oracle(
                    &state,
                    base.as_object_mut().unwrap(),
                    &mut entities,
                    &powers,
                    &mut directory,
                    &mut ledger,
                )
            } else {
                dispatch(
                    &state,
                    base.as_object_mut().unwrap(),
                    &mut entities,
                    &powers,
                    &mut directory,
                    &mut ledger,
                )
            }
            .unwrap();
            scans.push(scan);
            let changed = advance_routes(
                &state,
                base.as_object_mut().unwrap(),
                &mut entities,
                1.0,
                &powers,
                &mut directory,
            )
            .unwrap();
            directory.wake_ready_from_changed_stations(&changed);
        }
        (
            serde_json::to_vec(&json!({ "base": base, "entities": entities })).unwrap(),
            scans,
        )
    }

    #[test]
    fn persistent_dispatch_queue_matches_full_station_oracle_at_1_5_60_seconds() {
        let count = 32;
        let mut source = sparse_readiness_matrix(count, 1);
        // Two complete drone fleets depart per cycle. Leaving another cycle's
        // cargo behind proves that local route completion re-wakes dispatch.
        source[0]["outputs"]["iron_ore"] = Value::from(5_000.0);

        for seconds in [1_usize, 5, 60] {
            let (indexed, indexed_scans) = run_local_dispatch_slice(&source, seconds, false);
            let (oracle, oracle_scans) = run_local_dispatch_slice(&source, seconds, true);
            assert_eq!(
                indexed, oracle,
                "local dispatch slice diverged from the full station oracle at {seconds}s"
            );
            assert_eq!(indexed_scans[0].selected_station_rows, 1);
            assert_eq!(indexed_scans[0].total_station_rows, count);
            assert_eq!(indexed_scans[0].selected_demand_rows, 1);
            assert_eq!(indexed_scans[0].total_demand_rows, 1);
            assert!(!indexed_scans[0].dense_fallback);
            assert!(!indexed_scans[0].directory_fallback);
            assert!(
                indexed_scans
                    .iter()
                    .all(|scan| scan.selected_station_rows <= 1)
            );
            assert!(
                oracle_scans
                    .iter()
                    .all(|scan| scan.selected_station_rows == count)
            );
            if seconds >= 5 {
                assert!(
                    indexed_scans
                        .iter()
                        .skip(1)
                        .any(|scan| scan.selected_station_rows == 0),
                    "dormant steps must not rescan the demand row"
                );
            }
        }
    }

    #[test]
    fn dispatch_reverse_wakes_are_stable_and_power_recovery_is_explicit() {
        let source = sparse_readiness_matrix(16, 3);
        let state = route_fixture_state(&source);
        let mut directory =
            prepare_step_directory(&source, &state.factory_topology.station_indices).unwrap();
        let (initial, initial_scan) = directory.dispatch_scan_indices(&[], false, false);
        assert_eq!(initial, vec![1, 2, 3]);
        assert_eq!(initial_scan.selected_station_rows, 3);
        directory.commit_dispatch(Vec::new(), &[], false);

        // A source-side inventory/vehicle change expands to all matching
        // demands in persisted entity order.
        directory.wake_ready_from_changed_stations(&[0]);
        let (source_wake, _) = directory.dispatch_scan_indices(&[], false, false);
        assert_eq!(source_wake, vec![1, 2, 3]);
        directory.commit_dispatch(Vec::new(), &[], false);

        // A demand-side capacity release only wakes that demand.
        directory.wake_ready_from_changed_stations(&[2]);
        let (capacity_wake, _) = directory.dispatch_scan_indices(&[], false, false);
        assert_eq!(capacity_wake, vec![2]);
        directory.commit_dispatch(Vec::new(), &[], false);

        // No inventory wake is needed for a grid recovery. The successful
        // dispatch boundary remembers power separately from the demand queue.
        let off = HashMap::from([(0, 0.0), (1, 0.0), (2, 0.0), (3, 0.0)]);
        let (off_powered, off_wakes, off_fallback) = directory.plan_dispatch_power_wakes(&off);
        assert!(off_powered.is_empty());
        assert!(off_wakes.is_empty());
        assert!(!off_fallback);
        directory.commit_dispatch(off_powered, &[], false);
        let on = HashMap::from([(0, 1.0), (1, 1.0), (2, 1.0), (3, 1.0)]);
        let (on_powered, on_wakes, on_fallback) = directory.plan_dispatch_power_wakes(&on);
        assert_eq!(on_wakes, vec![1, 2, 3]);
        assert!(!on_fallback);
        let (recovered, _) = directory.dispatch_scan_indices(&on_wakes, false, false);
        assert_eq!(recovered, vec![1, 2, 3]);
        directory.commit_dispatch(on_powered, &[], false);

        // Storage-only writes have no local dispatch dependency.
        directory.wake_ready_from_changed_stations(&[9]);
        let (storage_wake, _) = directory.dispatch_scan_indices(&[], false, false);
        assert!(storage_wake.is_empty());
    }

    #[test]
    fn dispatch_capacity_release_and_power_recovery_create_routes_without_full_scan() {
        let mut capacity_source = route_matrix(2, &[], 0.0, 8.0);
        capacity_source[1]["outputs"]["iron_ore"] = Value::from(100.0);
        let capacity_state = route_fixture_state(&capacity_source);
        let mut capacity_base = route_fixture_base();
        let mut capacity_entities = capacity_source;
        let mut capacity_directory = prepare_step_directory(
            &capacity_entities,
            &capacity_state.factory_topology.station_indices,
        )
        .unwrap();
        let activity = crate::interstellar_logistics::prepare_route_activity(&capacity_entities);
        let mut ledger = StationRouteLedger::build(
            &capacity_state,
            &capacity_entities,
            &capacity_directory,
            &activity,
        );
        let powers = route_powers(2, 1.0);
        dispatch(
            &capacity_state,
            capacity_base.as_object_mut().unwrap(),
            &mut capacity_entities,
            &powers,
            &mut capacity_directory,
            &mut ledger,
        )
        .unwrap();
        assert!(
            capacity_entities[1]["stationRoutes"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        capacity_entities[1]["outputs"]["iron_ore"] = Value::from(0.0);
        capacity_directory.wake_ready_from_changed_stations(&[1]);
        let scan = dispatch(
            &capacity_state,
            capacity_base.as_object_mut().unwrap(),
            &mut capacity_entities,
            &powers,
            &mut capacity_directory,
            &mut ledger,
        )
        .unwrap();
        assert_eq!(scan.selected_station_rows, 1);
        assert_eq!(
            capacity_entities[1]["stationRoutes"]
                .as_array()
                .unwrap()
                .len(),
            1
        );

        let power_source = route_matrix(2, &[], 0.0, 8.0);
        let power_state = route_fixture_state(&power_source);
        let mut power_base = route_fixture_base();
        let mut power_entities = power_source;
        let mut power_directory = prepare_step_directory(
            &power_entities,
            &power_state.factory_topology.station_indices,
        )
        .unwrap();
        let activity = crate::interstellar_logistics::prepare_route_activity(&power_entities);
        let mut ledger =
            StationRouteLedger::build(&power_state, &power_entities, &power_directory, &activity);
        dispatch(
            &power_state,
            power_base.as_object_mut().unwrap(),
            &mut power_entities,
            &route_powers(2, 0.0),
            &mut power_directory,
            &mut ledger,
        )
        .unwrap();
        assert!(
            power_entities[1]["stationRoutes"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        let recovered_scan = dispatch(
            &power_state,
            power_base.as_object_mut().unwrap(),
            &mut power_entities,
            &route_powers(2, 1.0),
            &mut power_directory,
            &mut ledger,
        )
        .unwrap();
        assert_eq!(recovered_scan.selected_station_rows, 1);
        assert_eq!(
            power_entities[1]["stationRoutes"].as_array().unwrap().len(),
            1
        );
    }

    #[test]
    fn dispatch_uses_exact_three_quarter_and_fail_closed_directory_boundaries() {
        let dense_source = sparse_readiness_matrix(16, 12);
        let dense_state = route_fixture_state(&dense_source);
        let mut dense_base = route_fixture_base();
        let mut dense_entities = dense_source;
        let mut dense_directory = prepare_step_directory(
            &dense_entities,
            &dense_state.factory_topology.station_indices,
        )
        .unwrap();
        let activity = crate::interstellar_logistics::prepare_route_activity(&dense_entities);
        let mut ledger =
            StationRouteLedger::build(&dense_state, &dense_entities, &dense_directory, &activity);
        let dense_scan = dispatch(
            &dense_state,
            dense_base.as_object_mut().unwrap(),
            &mut dense_entities,
            &route_powers(16, 1.0),
            &mut dense_directory,
            &mut ledger,
        )
        .unwrap();
        assert_eq!(dense_scan.selected_demand_rows, 12);
        assert_eq!(dense_scan.selected_station_rows, 16);
        assert!(dense_scan.dense_fallback);
        assert!(!dense_scan.directory_fallback);

        let mut opaque_entities = sparse_readiness_matrix(16, 1);
        opaque_entities[7]["stationRoutes"] = json!([{
            "scope": "mod:wormhole/local",
            "mod:payload": { "signedZero": -0.0, "text": "保持" }
        }]);
        let opaque_directory =
            prepare_step_directory(&opaque_entities, &(0..16).collect::<Vec<_>>()).unwrap();
        let (opaque_indices, opaque_scan) =
            opaque_directory.dispatch_scan_indices(&[], false, false);
        assert_eq!(opaque_indices, (0..16).collect::<Vec<_>>());
        assert!(opaque_scan.directory_fallback);

        let exact_directory =
            prepare_step_directory(&opaque_entities, &(0..16).collect::<Vec<_>>()).unwrap();
        let mut invalid_pending = exact_directory.clone();
        invalid_pending.dispatch_full_scan_required = false;
        invalid_pending.dispatch_all_pending = false;
        invalid_pending.pending_dispatch_demand_indices = vec![9];
        let (invalid_indices, invalid_scan) =
            invalid_pending.dispatch_scan_indices(&[], false, false);
        assert_eq!(invalid_indices, (0..16).collect::<Vec<_>>());
        assert!(invalid_scan.directory_fallback);

        let mut mismatched_indices = (0..16).collect::<Vec<_>>();
        mismatched_indices[1] = mismatched_indices[0];
        let mismatched = build_peer_directory(
            &opaque_entities,
            &mismatched_indices,
            &(0..16).collect::<Vec<_>>(),
        )
        .unwrap();
        let (_, mismatch_scan) = mismatched.dispatch_scan_indices(&[], false, false);
        assert!(mismatch_scan.directory_fallback);
    }

    #[test]
    fn readiness_technology_and_topology_boundaries_rewake_local_dispatch() {
        let mut source = sparse_readiness_matrix(16, 1);
        source[0]["outputs"]["iron_ore"] = Value::from(100.0);
        let state = route_fixture_state(&source);
        let mut base = route_fixture_base();
        let mut directory =
            prepare_step_directory(&source, &state.factory_topology.station_indices).unwrap();
        let activity = crate::interstellar_logistics::prepare_route_activity(&source);
        let ledger = StationRouteLedger::build(&state, &source, &directory, &activity);
        ready_station_indices_with_scan(
            &state,
            base.as_object().unwrap(),
            &source,
            &mut directory,
            &ledger,
        )
        .unwrap();
        directory.commit_dispatch(Vec::new(), &[], false);

        base["research"]["completedTechIds"] = json!(["logistics_capacity_1"]);
        let (_, signature_scan) = ready_station_indices_with_scan(
            &state,
            base.as_object().unwrap(),
            &source,
            &mut directory,
            &ledger,
        )
        .unwrap();
        assert!(signature_scan.signature_fallback);
        let (technology_wake, _) = directory.dispatch_scan_indices(&[], false, false);
        assert_eq!(technology_wake, vec![1]);

        let mut retained = Arc::new(directory);
        refresh_step_directory_after_topology_change(
            &source,
            &state.factory_topology.station_indices,
            true,
            &mut retained,
        )
        .unwrap();
        let (topology_wake, _) = retained.dispatch_scan_indices(&[], false, false);
        assert_eq!(topology_wake, vec![1]);
    }

    #[test]
    fn failed_dispatch_keeps_pending_power_and_route_caches_uncommitted() {
        let source = route_matrix(2, &[], 0.0, 8.0);
        let state = route_fixture_state(&source);
        let mut base = route_fixture_base();
        let mut entities = source;
        entities[1]["stationLastSupplyPeerBySlot"] = Value::Null;
        let mut directory =
            prepare_step_directory(&entities, &state.factory_topology.station_indices).unwrap();
        let activity = crate::interstellar_logistics::prepare_route_activity(&entities);
        let mut ledger = StationRouteLedger::build(&state, &entities, &directory, &activity);
        let pending_before = directory.pending_dispatch_demand_indices.clone();
        let all_before = directory.dispatch_all_pending;
        let powered_before = directory.powered_dispatch_station_indices.clone();
        let routes_before = directory.local_route_demand_indices.clone();

        let error = dispatch(
            &state,
            base.as_object_mut().unwrap(),
            &mut entities,
            &route_powers(2, 1.0),
            &mut directory,
            &mut ledger,
        )
        .expect_err("invalid fairness map must reject the candidate");
        assert_eq!(error.to_string(), "native local fairness record is missing");
        assert_eq!(directory.pending_dispatch_demand_indices, pending_before);
        assert_eq!(directory.dispatch_all_pending, all_before);
        assert_eq!(directory.powered_dispatch_station_indices, powered_before);
        assert_eq!(directory.local_route_demand_indices, routes_before);
    }

    fn run_route_step(
        state: &CoreState,
        source: &[Value],
        seconds: f64,
        force_full_scan: bool,
    ) -> (Value, Vec<Value>, LocalPeerDirectory, usize, bool) {
        let mut base = route_fixture_base();
        let mut entities = source.to_vec();
        let mut directory =
            prepare_step_directory(&entities, &state.factory_topology.station_indices).unwrap();
        let (planned_indices, dense) = directory.route_scan_indices();
        let scan_count = if force_full_scan {
            directory.station_indices.len()
        } else {
            planned_indices.len()
        };
        if force_full_scan {
            let full_indices = directory.station_indices.to_vec();
            let quantum_bandwidth =
                crate::quantum_logistics::runtime_bandwidth(base.as_object().unwrap(), &entities);
            let outcome = advance_routes_for_indices(
                state,
                base.as_object_mut().unwrap(),
                &mut entities,
                quantum_bandwidth,
                seconds,
                &route_powers(source.len(), 1.0),
                &full_indices,
            )
            .unwrap();
            directory.replace_scanned_local_route_activity(&outcome.activity_updates);
        } else {
            advance_routes(
                state,
                base.as_object_mut().unwrap(),
                &mut entities,
                seconds,
                &route_powers(source.len(), 1.0),
                &mut directory,
            )
            .unwrap();
        }
        (base, entities, directory, scan_count, dense)
    }

    fn assert_shared_local_ledger_matches_legacy(
        state: &CoreState,
        entities: &[Value],
        directory: &LocalPeerDirectory,
    ) {
        let remote_activity = crate::interstellar_logistics::prepare_route_activity(entities);
        let shared = StationRouteLedger::build(state, entities, directory, &remote_activity);
        let full = StationRouteLedger::build_full_oracle(state, entities, directory);
        let legacy = build_ledger(
            entities,
            &state.entity_index,
            directory.station_indices.as_ref(),
        );

        for &station_index in directory.station_indices.iter() {
            assert_eq!(
                shared.local_busy_floor(station_index),
                legacy.busy.get(&station_index).copied().unwrap_or(0.0)
            );
            assert_eq!(
                shared.local_in_flight(station_index, "iron_ore"),
                ledger_item_amount(&legacy.in_flight, station_index, "iron_ore")
            );
            assert_eq!(
                shared.local_reserved(station_index, "iron_ore"),
                ledger_item_amount(&legacy.reserved, station_index, "iron_ore")
            );
            assert_eq!(
                shared.local_active_vehicle_load(station_index),
                legacy
                    .active_vehicle_load
                    .get(&station_index)
                    .copied()
                    .unwrap_or(0.0)
            );
            assert_eq!(
                shared.is_active_local_station(station_index),
                legacy.active_local_stations.contains(&station_index)
            );
            assert_eq!(
                shared.active_local_progress(station_index),
                legacy
                    .active_local_progress
                    .get(&station_index)
                    .copied()
                    .unwrap_or(0.0)
            );
            assert_eq!(
                shared.local_busy_floor(station_index),
                full.local_busy_floor(station_index)
            );
            assert_eq!(
                shared.local_in_flight(station_index, "iron_ore"),
                full.local_in_flight(station_index, "iron_ore")
            );
            assert_eq!(
                shared.local_reserved(station_index, "iron_ore"),
                full.local_reserved(station_index, "iron_ore")
            );
            assert_eq!(
                shared.local_active_vehicle_load(station_index),
                full.local_active_vehicle_load(station_index)
            );
        }

        let runtime = DeterministicRuntime::for_test(4);
        let legacy_ready = plan_ready_station_indices_with(
            &runtime,
            entities,
            directory,
            directory.station_indices.as_ref(),
            &legacy,
            25.0,
            |_, _, _| Ok(100_000.0),
        )
        .unwrap();
        let shared_ready = plan_ready_station_indices_with(
            &runtime,
            entities,
            directory,
            directory.station_indices.as_ref(),
            &shared,
            25.0,
            |_, _, _| Ok(100_000.0),
        )
        .unwrap();
        assert_eq!(shared_ready, legacy_ready);

        let legacy_congestion =
            plan_congestion_updates(&runtime, entities, directory, &legacy).unwrap();
        let shared_congestion =
            plan_congestion_updates(&runtime, entities, directory, &shared).unwrap();
        assert_eq!(shared_congestion, legacy_congestion);
    }

    #[test]
    fn shared_station_route_ledger_matches_legacy_local_oracle_at_1_5_60_seconds() {
        let count = 256;
        let active = [7, 113, 251];
        let source = route_matrix(count, &active, 0.125, 120.0);
        let state = route_fixture_state(&source);
        let source_hash = state.canonical_sha256().unwrap();

        for seconds in [1.0, 5.0, 60.0] {
            let (_, entities, directory, _, _) = run_route_step(&state, &source, seconds, false);
            let remote_activity = crate::interstellar_logistics::prepare_route_activity(&entities);
            let ledger = StationRouteLedger::build(&state, &entities, &directory, &remote_activity);
            let active_order_input_rows = directory.active_local_route_demand_indices().len()
                + remote_activity.active_remote_route_demand_indices().len()
                + remote_activity.opaque_route_demand_indices().len();
            assert_eq!(
                ledger.scan(),
                crate::station_route_ledger::StationRouteLedgerScan {
                    selected_demands: active.len(),
                    total_candidate_rows: count,
                    dense_fallback: false,
                    active_order_input_rows,
                    active_order_duplicate_rows: active_order_input_rows - active.len(),
                    active_order_fallback: false,
                },
                "unexpected shared-ledger scan at {seconds}s"
            );
            assert_shared_local_ledger_matches_legacy(&state, &entities, &directory);
        }
        assert_eq!(state.canonical_sha256().unwrap(), source_hash);
    }

    #[test]
    fn sparse_route_advancement_scans_only_active_and_matches_full_oracle_at_1_5_60_seconds() {
        let count = PARALLEL_MIN_ITEMS + 113;
        let active = [7, 2_057, count - 1];
        let source = route_matrix(count, &active, 0.125, 120.0);
        let state = route_fixture_state(&source);
        let state_hash = state.canonical_sha256().unwrap();

        for seconds in [1.0, 5.0, 60.0] {
            let sparse = run_route_step(&state, &source, seconds, false);
            let oracle = run_route_step(&state, &source, seconds, true);
            assert_eq!(sparse.3, active.len(), "sparse scan count at {seconds}s");
            assert!(!sparse.4);
            assert_eq!(
                serde_json::to_vec(&(&sparse.0, &sparse.1)).unwrap(),
                serde_json::to_vec(&(&oracle.0, &oracle.1)).unwrap(),
                "active route replay diverged from full scan at {seconds}s"
            );
            assert_eq!(
                sparse.2.local_route_demand_indices,
                oracle.2.local_route_demand_indices
            );
            assert_eq!(sparse.2.local_route_demand_indices, active);
            for (before, after) in source.iter().zip(&sparse.1) {
                assert_eq!(
                    serde_json::to_vec(&before["mod:route/opaque"]).unwrap(),
                    serde_json::to_vec(&after["mod:route/opaque"]).unwrap()
                );
            }
        }
        assert_eq!(state.canonical_sha256().unwrap(), state_hash);
    }

    #[test]
    fn dense_route_activity_explicitly_falls_back_to_full_station_order() {
        let count = 80;
        let active = (1..=60).collect::<Vec<_>>();
        let source = route_matrix(count, &active, 0.2, 90.0);
        let state = route_fixture_state(&source);
        let directory =
            prepare_step_directory(&source, &state.factory_topology.station_indices).unwrap();
        let (scan_indices, dense) = directory.route_scan_indices();
        assert!(dense);
        assert_eq!(scan_indices, directory.station_indices.as_ref());
        assert_eq!(scan_indices.len(), count);
        let remote_activity = crate::interstellar_logistics::prepare_route_activity(&source);
        let shared = StationRouteLedger::build(&state, &source, &directory, &remote_activity);
        let active_order_input_rows = directory.active_local_route_demand_indices().len()
            + remote_activity.active_remote_route_demand_indices().len()
            + remote_activity.opaque_route_demand_indices().len();
        assert_eq!(
            shared.scan(),
            crate::station_route_ledger::StationRouteLedgerScan {
                selected_demands: count,
                total_candidate_rows: count,
                dense_fallback: true,
                active_order_input_rows,
                active_order_duplicate_rows: active_order_input_rows - active.len(),
                active_order_fallback: false,
            }
        );
        assert_shared_local_ledger_matches_legacy(&state, &source, &directory);

        for seconds in [1.0, 5.0, 60.0] {
            let scheduled = run_route_step(&state, &source, seconds, false);
            let oracle = run_route_step(&state, &source, seconds, true);
            assert!(scheduled.4);
            assert_eq!(scheduled.3, count);
            assert_eq!(
                serde_json::to_vec(&(&scheduled.0, &scheduled.1)).unwrap(),
                serde_json::to_vec(&(&oracle.0, &oracle.1)).unwrap()
            );
        }
    }

    #[test]
    fn powerless_route_stays_awake_then_completion_removes_it_without_material_loss() {
        let source = route_matrix(32, &[7], 0.0, 8.0);
        let state = route_fixture_state(&source);
        let mut base = route_fixture_base();
        let mut entities = source.clone();
        let mut directory =
            prepare_step_directory(&entities, &state.factory_topology.station_indices).unwrap();
        let material_before = item_amount(entities[0].as_object().unwrap(), "outputs", "iron_ore")
            + item_amount(entities[7].as_object().unwrap(), "outputs", "iron_ore");
        let powerless = route_powers(entities.len(), 0.0);

        advance_routes(
            &state,
            base.as_object_mut().unwrap(),
            &mut entities,
            60.0,
            &powerless,
            &mut directory,
        )
        .unwrap();
        assert_eq!(directory.local_route_demand_indices, vec![7]);
        assert_eq!(
            entities[7]["stationRoutes"][0]["progress"],
            Value::from(0.0)
        );

        let powered = route_powers(entities.len(), 1.0);
        advance_routes(
            &state,
            base.as_object_mut().unwrap(),
            &mut entities,
            8.0,
            &powered,
            &mut directory,
        )
        .unwrap();
        assert!(directory.local_route_demand_indices.is_empty());
        assert_eq!(entities[7]["stationRoutes"], json!([]));
        let material_after = item_amount(entities[0].as_object().unwrap(), "outputs", "iron_ore")
            + item_amount(entities[7].as_object().unwrap(), "outputs", "iron_ore");
        assert_eq!(material_after, material_before);
        assert_eq!(entities[7]["outputs"]["iron_ore"], Value::from(11.0));
    }

    #[test]
    fn quantum_local_route_completion_wakes_retained_station_input() {
        let mut entities = route_matrix(2, &[1], 0.0, 1.0);
        entities[1]["buildingId"] = Value::from("interstellar_logistics_station");
        entities[1]["quantumMode"] = Value::from("quantum");
        entities[1]["stationSlots"][0]["remoteMode"] = Value::from("supply");
        entities[1]["stationSlots"][0]["minStock"] = Value::from(100);
        let state = route_fixture_state(&entities);
        let mut base = route_fixture_base();
        base["quantumLogisticsNetwork"] = json!({
            "enabled": true,
            "inventory": {},
            "itemCapacities": { "iron_ore": "1000000" },
            "routingCursors": {},
            "uploadRoutingCursors": {}
        });
        let mut directory =
            prepare_step_directory(&entities, &state.factory_topology.station_indices).unwrap();
        transfer_buffers(
            &state,
            base.as_object().unwrap(),
            &mut entities,
            &mut directory,
        )
        .unwrap();
        // Model the prior successful dispatch boundary so this assertion
        // observes the route-completion wake rather than the initial all-wake.
        directory.commit_dispatch(Vec::new(), &[], false);
        let powers = route_powers(entities.len(), 1.0);

        let changed = advance_routes(
            &state,
            base.as_object_mut().unwrap(),
            &mut entities,
            1.0,
            &powers,
            &mut directory,
        )
        .unwrap();
        directory.wake_ready_from_changed_stations(&changed);
        let (dispatch_wake, _) = directory.dispatch_scan_indices(&[], false, false);
        assert_eq!(dispatch_wake, vec![1]);
        assert_eq!(entities[1]["inputs"]["iron_ore"], Value::from(11.0));
        assert_eq!(directory.buffer_active_station_indices, vec![1]);

        transfer_buffers(
            &state,
            base.as_object().unwrap(),
            &mut entities,
            &mut directory,
        )
        .unwrap();
        assert_eq!(entities[1]["inputs"]["iron_ore"], Value::from(0.0));
        assert_eq!(entities[1]["outputs"]["iron_ore"], Value::from(11.0));
        assert!(directory.buffer_active_station_indices.is_empty());
    }

    fn assert_local_dispatch_shared_ledger_matches_full_scan(
        source: &[Value],
        power_factor: f64,
        label: &str,
    ) {
        let state = route_fixture_state(source);
        let source_hash = state.canonical_sha256().unwrap();
        let powers = route_powers(source.len(), power_factor);

        let mut legacy_base = route_fixture_base();
        let mut legacy_entities = source.to_vec();
        let mut legacy_directory =
            prepare_step_directory(&legacy_entities, &state.factory_topology.station_indices)
                .unwrap();
        let mut legacy_ledger = build_ledger(
            &legacy_entities,
            &state.entity_index,
            legacy_directory.station_indices.as_ref(),
        );
        dispatch_full_scan_oracle(
            &state,
            legacy_base.as_object_mut().unwrap(),
            &mut legacy_entities,
            &powers,
            &mut legacy_directory,
            &mut legacy_ledger,
        )
        .unwrap();

        let mut shared_base = route_fixture_base();
        let mut shared_entities = source.to_vec();
        let mut shared_directory =
            prepare_step_directory(&shared_entities, &state.factory_topology.station_indices)
                .unwrap();
        let remote_activity =
            crate::interstellar_logistics::prepare_route_activity(&shared_entities);
        let mut shared_ledger = StationRouteLedger::build(
            &state,
            &shared_entities,
            &shared_directory,
            &remote_activity,
        );
        let expected_active = shared_directory.active_local_route_demand_indices().len();
        assert_eq!(
            shared_ledger.scan().selected_demands,
            expected_active,
            "{label}"
        );
        assert!(!shared_ledger.scan().dense_fallback, "{label}");
        dispatch_with_ledger(
            &state,
            shared_base.as_object_mut().unwrap(),
            &mut shared_entities,
            &powers,
            &mut shared_directory,
            &mut shared_ledger,
        )
        .unwrap();

        assert_eq!(
            serde_json::to_vec(&(&shared_base, &shared_entities)).unwrap(),
            serde_json::to_vec(&(&legacy_base, &legacy_entities)).unwrap(),
            "dispatch result diverged for {label}"
        );
        assert_eq!(
            shared_directory.local_route_demand_indices,
            legacy_directory.local_route_demand_indices,
            "active route order diverged for {label}"
        );

        let full =
            StationRouteLedger::build_full_oracle(&state, &shared_entities, &shared_directory);
        for &station_index in state.factory_topology.station_indices.iter() {
            assert_eq!(
                shared_ledger.local_busy_floor(station_index),
                legacy_ledger
                    .busy
                    .get(&station_index)
                    .copied()
                    .unwrap_or(0.0),
                "busy ledger diverged for {label}"
            );
            assert_eq!(
                shared_ledger.local_reserved(station_index, "iron_ore"),
                ledger_item_amount(&legacy_ledger.reserved, station_index, "iron_ore"),
                "reserved ledger diverged for {label}"
            );
            assert_eq!(
                shared_ledger.local_in_flight(station_index, "iron_ore"),
                ledger_item_amount(&legacy_ledger.in_flight, station_index, "iron_ore"),
                "in-flight ledger diverged for {label}"
            );
            assert_eq!(
                shared_ledger.local_active_vehicle_load(station_index),
                legacy_ledger
                    .active_vehicle_load
                    .get(&station_index)
                    .copied()
                    .unwrap_or(0.0),
                "vehicle-load ledger diverged for {label}"
            );
            assert_eq!(
                shared_ledger.local_reserved(station_index, "iron_ore"),
                full.local_reserved(station_index, "iron_ore"),
                "incremental reserved ledger diverged from full scan for {label}"
            );
            assert_eq!(
                shared_ledger.local_in_flight(station_index, "iron_ore"),
                full.local_in_flight(station_index, "iron_ore"),
                "incremental in-flight ledger diverged from full scan for {label}"
            );
            assert_eq!(
                shared_ledger.interstellar_reserved(station_index, "iron_ore"),
                full.interstellar_reserved(station_index, "iron_ore"),
                "local dispatch did not update the remote reserved view for {label}"
            );
            assert_eq!(
                shared_ledger.interstellar_in_flight(station_index, "iron_ore"),
                full.interstellar_in_flight(station_index, "iron_ore"),
                "local dispatch did not update the remote in-flight view for {label}"
            );
            assert_eq!(
                shared_ledger.interstellar_active_vehicle_load(station_index),
                full.interstellar_active_vehicle_load(station_index),
                "local dispatch did not update the remote load view for {label}"
            );
        }
        assert_eq!(state.canonical_sha256().unwrap(), source_hash);
    }

    #[test]
    fn dispatch_reuses_shared_ledger_and_matches_full_scan_for_sparse_wake_states() {
        let normal = route_matrix(2, &[], 0.0, 8.0);

        let mut source_empty = normal.clone();
        source_empty[0]["outputs"]["iron_ore"] = Value::from(0.0);

        let mut target_full = normal.clone();
        target_full[1]["outputs"]["iron_ore"] = Value::from(100.0);

        let preexisting_route = route_matrix(2, &[1], 0.25, 8.0);

        for (source, power_factor, label) in [
            (&normal, 1.0, "normal inventory wake"),
            (&source_empty, 1.0, "source empty"),
            (&target_full, 1.0, "target full"),
            (&normal, 0.0, "power limited"),
            (&preexisting_route, 1.0, "route already active"),
        ] {
            assert_local_dispatch_shared_ledger_matches_full_scan(source, power_factor, label);
        }
    }

    #[test]
    fn dispatch_after_external_inventory_arrival_immediately_wakes_route_advancement() {
        let mut entities = route_matrix(2, &[], 0.0, 8.0);
        entities[0]["outputs"]["iron_ore"] = Value::from(0.0);
        let state = route_fixture_state(&entities);
        let mut base = route_fixture_base();
        let mut directory =
            prepare_step_directory(&entities, &state.factory_topology.station_indices).unwrap();
        let powers = route_powers(entities.len(), 1.0);
        let remote_activity = crate::interstellar_logistics::prepare_route_activity(&entities);
        let mut route_ledger =
            StationRouteLedger::build(&state, &entities, &directory, &remote_activity);

        dispatch(
            &state,
            base.as_object_mut().unwrap(),
            &mut entities,
            &powers,
            &mut directory,
            &mut route_ledger,
        )
        .unwrap();
        assert!(!directory.has_local_routes());

        entities[0]["outputs"]["iron_ore"] = Value::from(100.0);
        directory.wake_ready_from_changed_stations(&[0]);
        dispatch(
            &state,
            base.as_object_mut().unwrap(),
            &mut entities,
            &powers,
            &mut directory,
            &mut route_ledger,
        )
        .unwrap();
        assert_eq!(directory.local_route_demand_indices, vec![1]);
        assert_eq!(entities[1]["stationRoutes"].as_array().unwrap().len(), 1);
        let remote_activity = crate::interstellar_logistics::prepare_route_activity(&entities);
        assert_eq!(
            StationRouteLedger::build(&state, &entities, &directory, &remote_activity)
                .scan()
                .selected_demands,
            1,
            "inventory-triggered dispatch must wake the shared ledger"
        );

        advance_routes(
            &state,
            base.as_object_mut().unwrap(),
            &mut entities,
            8.0,
            &powers,
            &mut directory,
        )
        .unwrap();
        assert!(!directory.has_local_routes());
        let remote_activity = crate::interstellar_logistics::prepare_route_activity(&entities);
        assert_eq!(
            StationRouteLedger::build(&state, &entities, &directory, &remote_activity)
                .scan()
                .selected_demands,
            0,
            "route completion must leave no stale shared-ledger demand"
        );
        assert_eq!(entities[0]["outputs"]["iron_ore"], Value::from(0.0));
        assert_eq!(entities[1]["outputs"]["iron_ore"], Value::from(100.0));
    }

    #[test]
    fn failed_candidate_keeps_source_activity_cache_and_source_json_unchanged() {
        let source = route_matrix(128, &[7, 83], 0.2, 30.0);
        let state = route_fixture_state(&source);
        let state_hash = state.canonical_sha256().unwrap();
        let source_json = serde_json::to_vec(&source).unwrap();
        let source_directory = Arc::new(
            prepare_step_directory(&source, &state.factory_topology.station_indices).unwrap(),
        );
        let source_activity = source_directory.local_route_demand_indices.clone();
        let source_station_indices = Arc::clone(&source_directory.station_indices);
        let mut candidate_directory = Arc::clone(&source_directory);
        let candidate_runtime = Arc::make_mut(&mut candidate_directory);
        assert!(Arc::ptr_eq(
            &source_station_indices,
            &candidate_runtime.station_indices
        ));
        let mut candidate = source.clone();
        candidate[7]["stationRoutes"][0] = Value::Null;
        let candidate_before = serde_json::to_vec(&candidate).unwrap();
        let mut base = route_fixture_base();
        let powers = route_powers(candidate.len(), 1.0);

        let error = advance_routes(
            &state,
            base.as_object_mut().unwrap(),
            &mut candidate,
            1.0,
            &powers,
            candidate_runtime,
        )
        .unwrap_err();
        assert_eq!(error.to_string(), "native local route is invalid");
        assert_eq!(source_directory.local_route_demand_indices, source_activity);
        assert_eq!(
            candidate_directory.local_route_demand_indices, source_activity,
            "failed replay must not partially install activity updates"
        );
        assert_eq!(serde_json::to_vec(&source).unwrap(), source_json);
        assert_ne!(serde_json::to_vec(&candidate).unwrap(), candidate_before);
        assert_eq!(state.canonical_sha256().unwrap(), state_hash);
    }
}
