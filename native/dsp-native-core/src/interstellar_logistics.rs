use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use anyhow::{anyhow, bail};
use serde_json::{Map, Number, Value, json};

use crate::catalog::PlanetDefinition;
use crate::deterministic_runtime::{DeterministicRuntime, runtime as deterministic_runtime};
use crate::simple_factory::StationPowerLookup;
use crate::state::{CoreState, ExactRowIdIndex, SharedArc};
use crate::station_route_ledger::StationRouteLedger;

const EPSILON: f64 = 0.0001;
const SLOT_COUNT: usize = 5;
const VESSELS_PER_BUILDING: f64 = 10.0;
const CARGO_PER_VESSEL: f64 = 100.0;
const BASE_TRIP_SECONDS: f64 = 30.0;
const WARPER_CAPACITY_PER_BUILDING: f64 = 50.0;
const DEFAULT_WARPER_TARGET: f64 = WARPER_CAPACITY_PER_BUILDING;
const REMOTE_ROUTE_DENSE_NUMERATOR: usize = 3;
const REMOTE_ROUTE_DENSE_DENOMINATOR: usize = 4;
const REMOTE_DISPATCH_DENSE_NUMERATOR: usize = 3;
const REMOTE_DISPATCH_DENSE_DENOMINATOR: usize = 4;
const REMOTE_READY_DENSE_NUMERATOR: usize = 3;
const REMOTE_READY_DENSE_DENOMINATOR: usize = 4;
const WARPER_REFILL_DENSE_NUMERATOR: usize = 3;
const WARPER_REFILL_DENSE_DENOMINATOR: usize = 4;
const STATION_POWER_DENSE_NUMERATOR: usize = 3;
const STATION_POWER_DENSE_DENOMINATOR: usize = 4;
const INTERSTELLAR_CONGESTION_DENSE_NUMERATOR: usize = 3;
const INTERSTELLAR_CONGESTION_DENSE_DENOMINATOR: usize = 4;
const ORBITAL_COLLECTOR_DENSE_NUMERATOR: usize = 3;
const ORBITAL_COLLECTOR_DENSE_DENOMINATOR: usize = 4;
const WARPER_RESERVATION_ROWS_PER_CHUNK: usize = 1_024;

#[derive(Debug, Clone)]
struct Slot {
    item_id: Option<String>,
    remote_mode: String,
    minimum_load: f64,
    min_stock: f64,
    max_stock: f64,
    priority: usize,
    route_policy: String,
    warper_budget: usize,
}

#[derive(Debug, Clone)]
struct RouteEconomics {
    requires_warp: bool,
    duration: f64,
    distance_ly: f64,
    warpers_per_vessel: f64,
    waypoint_station_ids: Vec<String>,
}

#[derive(Debug, Clone)]
struct PlannedPath {
    station_indices: Vec<usize>,
    distance_ly: f64,
    duration: f64,
    max_leg_distance_ly: f64,
    score: f64,
}

#[cfg(test)]
#[derive(Debug, Default)]
struct Ledger {
    busy: HashMap<usize, f64>,
    local_busy: HashMap<usize, f64>,
    reserved: HashMap<(usize, String), f64>,
    in_flight: HashMap<(usize, String), f64>,
    active_vehicle_load: HashMap<usize, f64>,
    active_progress: HashMap<usize, f64>,
    active_remote_stations: HashSet<usize>,
}

trait InterstellarLedgerView: Sync {
    fn remote_busy(&self, station_index: usize) -> f64;
    fn local_busy(&self, station_index: usize) -> f64;
    fn in_flight(&self, station_index: usize, item_id: &str) -> f64;
    fn is_active_remote_station(&self, station_index: usize) -> bool;
    #[cfg(test)]
    fn active_progress(&self, station_index: usize) -> f64;
}

trait InterstellarDispatchLedger: InterstellarLedgerView {
    fn reserved(&self, station_index: usize, item_id: &str) -> f64;
    fn active_vehicle_load(&self, station_index: usize) -> f64;
    #[allow(clippy::too_many_arguments)]
    fn record_dispatch(
        &mut self,
        demand_index: usize,
        supply_index: usize,
        owner_index: usize,
        waypoint_indices: &[usize],
        item_id: &str,
        cargo: f64,
        vehicles: f64,
        progress: f64,
    );
}

#[cfg(test)]
impl InterstellarLedgerView for Ledger {
    fn remote_busy(&self, station_index: usize) -> f64 {
        self.busy.get(&station_index).copied().unwrap_or(0.0)
    }

    fn local_busy(&self, station_index: usize) -> f64 {
        self.local_busy.get(&station_index).copied().unwrap_or(0.0)
    }

    fn in_flight(&self, station_index: usize, item_id: &str) -> f64 {
        self.in_flight
            .get(&(station_index, item_id.to_owned()))
            .copied()
            .unwrap_or(0.0)
    }

    fn is_active_remote_station(&self, station_index: usize) -> bool {
        self.active_remote_stations.contains(&station_index)
    }

    #[cfg(test)]
    fn active_progress(&self, station_index: usize) -> f64 {
        self.active_progress
            .get(&station_index)
            .copied()
            .unwrap_or(0.0)
    }
}

#[cfg(test)]
impl InterstellarDispatchLedger for Ledger {
    fn reserved(&self, station_index: usize, item_id: &str) -> f64 {
        self.reserved
            .get(&(station_index, item_id.to_owned()))
            .copied()
            .unwrap_or(0.0)
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
        waypoint_indices: &[usize],
        item_id: &str,
        cargo: f64,
        vehicles: f64,
        _progress: f64,
    ) {
        *self.busy.entry(owner_index).or_default() += vehicles;
        *self
            .reserved
            .entry((supply_index, item_id.to_owned()))
            .or_default() += cargo;
        *self
            .in_flight
            .entry((demand_index, item_id.to_owned()))
            .or_default() += cargo;
        for station_index in HashSet::from([demand_index, supply_index, owner_index]) {
            *self.active_vehicle_load.entry(station_index).or_default() += vehicles;
        }
        for &waypoint_index in waypoint_indices {
            *self.active_vehicle_load.entry(waypoint_index).or_default() += vehicles;
        }
    }
}

impl InterstellarLedgerView for StationRouteLedger {
    fn remote_busy(&self, station_index: usize) -> f64 {
        self.remote_busy_floor(station_index)
    }

    fn local_busy(&self, station_index: usize) -> f64 {
        self.local_busy_raw(station_index)
    }

    fn in_flight(&self, station_index: usize, item_id: &str) -> f64 {
        StationRouteLedger::interstellar_in_flight(self, station_index, item_id)
    }

    fn is_active_remote_station(&self, station_index: usize) -> bool {
        StationRouteLedger::is_active_remote_station(self, station_index)
    }

    #[cfg(test)]
    fn active_progress(&self, station_index: usize) -> f64 {
        StationRouteLedger::active_progress(self, station_index)
    }
}

impl InterstellarDispatchLedger for StationRouteLedger {
    fn reserved(&self, station_index: usize, item_id: &str) -> f64 {
        StationRouteLedger::interstellar_reserved(self, station_index, item_id)
    }

    fn active_vehicle_load(&self, station_index: usize) -> f64 {
        StationRouteLedger::interstellar_active_vehicle_load(self, station_index)
    }

    fn record_dispatch(
        &mut self,
        demand_index: usize,
        supply_index: usize,
        owner_index: usize,
        waypoint_indices: &[usize],
        item_id: &str,
        cargo: f64,
        vehicles: f64,
        progress: f64,
    ) {
        StationRouteLedger::record_remote_dispatch(
            self,
            demand_index,
            supply_index,
            owner_index,
            waypoint_indices,
            item_id,
            cargo,
            vehicles,
            progress,
        );
    }
}

#[cfg(test)]
#[derive(Debug, Default)]
struct LocalSupplyDirectory {
    by_planet_item: HashMap<String, HashMap<String, Vec<usize>>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct PeerSlotRef {
    station_index: usize,
    slot_index: usize,
    planet_index: usize,
    system_unlocked: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct RoutingBaseSignature {
    completed_tech_ids: Vec<String>,
    unlocked_system_ids: Vec<String>,
    galactic_logistics_level: u64,
}

impl RoutingBaseSignature {
    fn capture(base: &Map<String, Value>) -> Self {
        let strings = |value: Option<&Value>| {
            value
                .and_then(Value::as_array)
                .map(|values| {
                    values
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default()
        };
        Self {
            completed_tech_ids: strings(
                base.get("research")
                    .and_then(Value::as_object)
                    .and_then(|research| research.get("completedTechIds")),
            ),
            unlocked_system_ids: strings(
                base.get("exploration")
                    .and_then(Value::as_object)
                    .and_then(|exploration| exploration.get("unlockedSystemIds")),
            ),
            galactic_logistics_level: logistics_level(base).to_bits(),
        }
    }

    fn estimated_bytes(&self) -> u64 {
        (self.completed_tech_ids.capacity() + self.unlocked_system_ids.capacity()) as u64
            * std::mem::size_of::<String>() as u64
            + self
                .completed_tech_ids
                .iter()
                .chain(self.unlocked_system_ids.iter())
                .map(|value| value.capacity() as u64)
                .sum::<u64>()
    }
}

/// Immutable, candidate-local reverse lookup for traditional interstellar
/// peers. Rows retain topology station order followed by persisted slot order.
/// Invalid or unsupported topology never produces a partial index: the whole
/// directory switches to the legacy full-scan oracle for the current step.
#[derive(Debug, Default)]
pub(crate) struct InterstellarPeerDirectory {
    supply_by_item: HashMap<String, Vec<PeerSlotRef>>,
    demand_by_item: HashMap<String, Vec<PeerSlotRef>>,
    demand_stations_by_item: HashMap<String, Vec<usize>>,
    supply_items_by_station: HashMap<usize, Vec<String>>,
    /// Linear-size reverse key for resolving a woken demand to the existing
    /// per-item supply directory without materializing a quadratic closure.
    demand_items_by_station: HashMap<usize, Vec<String>>,
    demand_station_set: HashSet<usize>,
    demand_station_indices: Vec<usize>,
    hub_station_indices: Vec<usize>,
    hub_station_set: HashSet<usize>,
    orbital_supply_station_indices: Vec<usize>,
    total_station_rows: usize,
    fallback_full_scan: bool,
    station_power_index_valid: bool,
    routing_base_signature: RoutingBaseSignature,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct PeerLookupScan {
    candidate_rows_visited: usize,
    full_scan_rows_visited: usize,
    used_full_scan: bool,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct InterstellarDispatchScan {
    pub selected_demands: usize,
    pub total_demand_rows: usize,
    pub demand_rows_probed: usize,
    pub dense_fallback: bool,
    pub peer_candidate_rows_visited: usize,
    pub peer_full_scan_rows_visited: usize,
    pub directory_fallback: bool,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct WarperRefillScan {
    pub selected_station_rows: usize,
    pub total_station_rows: usize,
    pub reservation_rows_visited: usize,
    pub dense_fallback: bool,
    pub directory_fallback: bool,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct StationPowerScan {
    pub selected_station_rows: usize,
    pub total_station_rows: usize,
    pub dense_fallback: bool,
    pub directory_fallback: bool,
    pub runtime_fallback: bool,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct InterstellarReadyStationScan {
    pub selected_station_rows: usize,
    pub total_station_rows: usize,
    pub dense_fallback: bool,
    pub directory_fallback: bool,
}

/// Runtime-only wake set for demand stations that own at least one remote
/// route. The static station order is shared across candidate revisions while
/// only the compact activity vector is copied on write. Nothing in this
/// structure is persisted or included in canonical state hashes.
#[derive(Debug, Clone, Default)]
pub(crate) struct InterstellarRouteActivity {
    station_indices: Arc<[usize]>,
    active_demand_indices: Vec<usize>,
    /// Runtime-only exact reverse dependency view used by quantum mode
    /// transitions. Route dispatch/advance updates only the affected demand
    /// rows on the transactional candidate. It is never persisted or hashed.
    transition_route_view: crate::station_route_ledger::RemoteTransitionRouteView,
    /// Route-bearing rows that cannot be maintained by the legacy local or
    /// remote wake queues (custom station kinds and opaque/MOD scopes). They
    /// remain in the shared ledger scan until a record command rebuilds the
    /// topology, preserving the old permissive route-summary semantics.
    opaque_route_demand_indices: Vec<usize>,
    /// Stable topology-order queue of configured demands whose dispatch
    /// eligibility may have changed. A successful probe drains a row until a
    /// reverse dependency explicitly wakes it again. This runtime-only queue
    /// is cloned transactionally and installed only with a committed revision.
    pending_dispatch_demand_indices: Vec<usize>,
    /// The same reverse wakes retained until the next readiness boundary.
    /// Dispatch occurs later in the step and drains its own queue, so sharing
    /// that queue would lose a post-readiness inventory/warper wake whenever
    /// the station is currently unpowered and cannot start a route.
    pending_readiness_demand_indices: Vec<usize>,
    /// One-time validation that the immutable activity order is an exact
    /// subset of the CoreState station topology. The first readiness boundary
    /// pays this O(S) guard; every retained revision thereafter reads it in
    /// O(1), instead of disguising a full outer scan as a per-step invariant.
    readiness_topology_valid: Option<bool>,
    /// Remote readiness rows that remain true across steps. In particular an
    /// inventory-ready but unpowered pair stays in the station power graph so
    /// its later false -> true grid transition is observable.
    ready_station_indices: Vec<usize>,
    /// Stations that had usable power at the previous dispatch boundary.
    /// Only the false -> true transition can create new dispatch eligibility.
    powered_station_indices: Vec<usize>,
    /// Stable persisted-order list of every vanilla ILS row that can
    /// participate in automatic warper refill. Runtime mode, target and
    /// inventory fields deliberately do not affect membership: those fields
    /// can change without rebuilding topology at a five-second boundary.
    warper_refill_station_indices: Arc<[usize]>,
    /// Candidate stations grouped by planet in first-seen persisted order.
    /// Only the scalar tray amount for these planets is compared between
    /// revisions; a changed tray wakes that planet's candidates.
    warper_refill_planets: Arc<[(String, Arc<[usize]>)]>,
    /// Represents the initial/topology-reset wake without cloning the complete
    /// immutable candidate index into every transactional revision.
    warper_refill_all_pending: bool,
    pending_warper_refill_station_indices: Vec<usize>,
    warper_tray_amount_bits: Vec<Option<u64>>,
    /// A non-station row masquerading as a vanilla ILS, or a vanilla ILS
    /// without a planet, is outside the indexed authority contract. Preserve
    /// the permissive legacy behavior by scanning every row in that case.
    warper_refill_full_scan_required: bool,
}

impl InterstellarRouteActivity {
    pub(crate) fn estimated_bytes(&self) -> u64 {
        (self.station_indices.len() * std::mem::size_of::<usize>()
            + (self.active_demand_indices.capacity() + self.opaque_route_demand_indices.capacity())
                * std::mem::size_of::<usize>()
            + (self.pending_dispatch_demand_indices.capacity()
                + self.pending_readiness_demand_indices.capacity()
                + self.ready_station_indices.capacity()
                + self.powered_station_indices.capacity()
                + self.warper_refill_station_indices.len()
                + self.pending_warper_refill_station_indices.capacity())
                * std::mem::size_of::<usize>()
            + self
                .warper_refill_planets
                .iter()
                .map(|(planet_id, indices)| {
                    planet_id.capacity() + indices.len() * std::mem::size_of::<usize>()
                })
                .sum::<usize>()
            + self.warper_tray_amount_bits.capacity() * std::mem::size_of::<Option<u64>>())
            as u64
            + self.transition_route_view.estimated_bytes()
    }

    fn has_remote_routes(&self) -> bool {
        !self.active_demand_indices.is_empty()
    }

    pub(crate) fn active_remote_route_demand_indices(&self) -> &[usize] {
        &self.active_demand_indices
    }

    pub(crate) fn opaque_route_demand_indices(&self) -> &[usize] {
        &self.opaque_route_demand_indices
    }

    pub(crate) fn transition_route_view(
        &self,
        entities: &[Value],
    ) -> Option<&crate::station_route_ledger::RemoteTransitionRouteView> {
        let dense = !self.active_demand_indices.is_empty()
            && self.active_demand_indices.len().saturating_mul(4)
                >= entities.len().saturating_mul(3);
        (!dense
            && self.transition_route_view.is_exact_for(
                entities,
                &self.active_demand_indices,
                &self.opaque_route_demand_indices,
            ))
        .then_some(&self.transition_route_view)
    }

    fn route_scan_indices(&self) -> (Vec<usize>, bool) {
        let active = self.active_demand_indices.len();
        let total = self.station_indices.len();
        let dense = active > 0
            && active.saturating_mul(REMOTE_ROUTE_DENSE_DENOMINATOR)
                >= total.saturating_mul(REMOTE_ROUTE_DENSE_NUMERATOR);
        if dense {
            (self.station_indices.to_vec(), true)
        } else {
            (self.active_demand_indices.clone(), false)
        }
    }

    fn update_remote_demand(&mut self, station_index: usize, active: bool) {
        if self.station_indices.binary_search(&station_index).is_err() {
            return;
        }
        match (
            self.active_demand_indices.binary_search(&station_index),
            active,
        ) {
            (Ok(position), false) => {
                self.active_demand_indices.remove(position);
            }
            (Err(position), true) => {
                self.active_demand_indices.insert(position, station_index);
            }
            (Ok(_), true) | (Err(_), false) => {}
        }
    }

    fn replace_scanned_activity(&mut self, updates: &[(usize, bool)]) {
        // Sparse scans cover the complete previous wake set; dense scans cover
        // the complete static station order. Replaying the booleans in that
        // same order therefore installs an exact next wake set atomically.
        self.active_demand_indices.clear();
        self.active_demand_indices.extend(
            updates
                .iter()
                .filter_map(|(station_index, active)| active.then_some(*station_index)),
        );
    }

    fn wake_dispatch_demand(&mut self, station_index: usize) {
        if self.station_indices.binary_search(&station_index).is_err() {
            return;
        }
        if let Err(position) = self
            .pending_dispatch_demand_indices
            .binary_search(&station_index)
        {
            self.pending_dispatch_demand_indices
                .insert(position, station_index);
        }
        if let Err(position) = self
            .pending_readiness_demand_indices
            .binary_search(&station_index)
        {
            self.pending_readiness_demand_indices
                .insert(position, station_index);
        }
    }

    fn wake_warper_refill_station(&mut self, station_index: usize) {
        if self.warper_refill_all_pending {
            return;
        }
        if self
            .warper_refill_station_indices
            .binary_search(&station_index)
            .is_err()
        {
            return;
        }
        if let Err(position) = self
            .pending_warper_refill_station_indices
            .binary_search(&station_index)
        {
            self.pending_warper_refill_station_indices
                .insert(position, station_index);
        }
    }

    fn wake_warper_refill_from_changed_stations(&mut self, station_indices: &[usize]) {
        for &station_index in station_indices {
            self.wake_warper_refill_station(station_index);
        }
    }

    fn wake_all_warper_refill_stations(&mut self) {
        self.warper_refill_all_pending = true;
        self.pending_warper_refill_station_indices.clear();
    }

    fn wake_changed_warper_trays(&mut self, base: &Map<String, Value>) {
        if self.warper_refill_all_pending {
            return;
        }
        let mut changed = Vec::new();
        for (planet_rank, (planet_id, station_indices)) in
            self.warper_refill_planets.iter().enumerate()
        {
            let amount_bits = planet_tray_warper_amount(base, planet_id).to_bits();
            if self
                .warper_tray_amount_bits
                .get(planet_rank)
                .and_then(|value| *value)
                .is_some_and(|previous| previous != amount_bits)
            {
                changed.extend_from_slice(station_indices);
            }
        }
        self.wake_warper_refill_from_changed_stations(&changed);
    }

    fn record_warper_trays(&mut self, base: &Map<String, Value>) {
        self.warper_tray_amount_bits.clear();
        self.warper_tray_amount_bits.extend(
            self.warper_refill_planets
                .iter()
                .map(|(planet_id, _)| Some(planet_tray_warper_amount(base, planet_id).to_bits())),
        );
    }

    fn take_warper_refill_indices(
        &mut self,
        entity_count: usize,
        force_full_scan: bool,
    ) -> (Option<Vec<usize>>, WarperRefillScan) {
        let total = self.warper_refill_station_indices.len();
        let active = if self.warper_refill_all_pending {
            total
        } else {
            self.pending_warper_refill_station_indices.len()
        };
        let dense_fallback = active > 0
            && active.saturating_mul(WARPER_REFILL_DENSE_DENOMINATOR)
                >= total.saturating_mul(WARPER_REFILL_DENSE_NUMERATOR);
        let directory_fallback = self.warper_refill_full_scan_required;
        let full_scan = force_full_scan || dense_fallback || directory_fallback;
        let selected = if full_scan {
            self.pending_warper_refill_station_indices.clear();
            None
        } else {
            Some(std::mem::take(
                &mut self.pending_warper_refill_station_indices,
            ))
        };
        self.warper_refill_all_pending = false;
        (
            selected,
            WarperRefillScan {
                selected_station_rows: if full_scan { entity_count } else { active },
                total_station_rows: total,
                reservation_rows_visited: 0,
                dense_fallback,
                directory_fallback,
            },
        )
    }

    fn wake_all_dispatch_demands(&mut self, directory: &InterstellarPeerDirectory) {
        self.pending_dispatch_demand_indices.clear();
        self.pending_dispatch_demand_indices
            .extend_from_slice(&directory.demand_station_indices);
        self.pending_readiness_demand_indices.clear();
        self.pending_readiness_demand_indices
            .extend_from_slice(&directory.demand_station_indices);
    }

    fn readiness_scan_indices(
        &mut self,
        all_station_indices: &[usize],
        directory: &InterstellarPeerDirectory,
        ledger: &StationRouteLedger,
    ) -> (Vec<usize>, InterstellarReadyStationScan) {
        if self.readiness_topology_valid.is_none() {
            self.readiness_topology_valid = Some(
                directory.station_power_index_valid
                    && directory.total_station_rows == all_station_indices.len()
                    && all_station_indices.windows(2).all(|pair| pair[0] < pair[1])
                    && self
                        .station_indices
                        .windows(2)
                        .all(|pair| pair[0] < pair[1])
                    && ordered_subset(&self.station_indices, all_station_indices),
            );
        }
        let mut directory_fallback = directory.fallback_full_scan
            || !self.opaque_route_demand_indices.is_empty()
            || self.readiness_topology_valid != Some(true)
            || directory.total_station_rows != all_station_indices.len()
            || self
                .pending_readiness_demand_indices
                .iter()
                .any(|index| !directory.demand_station_set.contains(index))
            || self
                .ready_station_indices
                .iter()
                .any(|index| all_station_indices.binary_search(index).is_err());
        let mut selected = self.ready_station_indices.clone();
        if !directory_fallback {
            directory_fallback |= !directory.append_power_dependencies_for_demands(
                &self.pending_readiness_demand_indices,
                &mut selected,
            );
            selected.extend(
                ledger
                    .active_station_indices()
                    .into_iter()
                    .filter(|index| ledger.is_active_remote_station(*index)),
            );
            selected.sort_unstable();
            selected.dedup();
            directory_fallback |= selected
                .iter()
                .any(|index| all_station_indices.binary_search(index).is_err());
        }
        let dense_fallback = !directory_fallback
            && !selected.is_empty()
            && selected
                .len()
                .saturating_mul(REMOTE_READY_DENSE_DENOMINATOR)
                >= all_station_indices
                    .len()
                    .saturating_mul(REMOTE_READY_DENSE_NUMERATOR);
        if directory_fallback || dense_fallback {
            selected.clear();
            selected.extend_from_slice(all_station_indices);
        }
        let scan = InterstellarReadyStationScan {
            selected_station_rows: selected.len(),
            total_station_rows: all_station_indices.len(),
            dense_fallback,
            directory_fallback,
        };
        (selected, scan)
    }

    fn commit_readiness(&mut self, planned: &[Option<usize>]) {
        self.ready_station_indices.clear();
        self.ready_station_indices
            .extend(planned.iter().flatten().copied());
        self.pending_readiness_demand_indices.clear();
    }

    fn wake_dispatch_from_changed_stations(
        &mut self,
        directory: &InterstellarPeerDirectory,
        changed_station_indices: &[usize],
    ) {
        if directory.fallback_full_scan {
            return;
        }
        for &station_index in changed_station_indices {
            if directory.demand_station_set.contains(&station_index) {
                self.wake_dispatch_demand(station_index);
            }
            if directory.hub_station_set.contains(&station_index) {
                self.wake_all_dispatch_demands(directory);
                continue;
            }
            let Some(items) = directory.supply_items_by_station.get(&station_index) else {
                continue;
            };
            for item_id in items {
                if let Some(demands) = directory.demand_stations_by_item.get(item_id) {
                    for &demand_index in demands {
                        self.wake_dispatch_demand(demand_index);
                    }
                }
            }
        }
    }

    fn refresh_power_wakes<P: StationPowerLookup + ?Sized>(
        &mut self,
        directory: &InterstellarPeerDirectory,
        station_indices: &[usize],
        powers: &P,
    ) {
        let mut next_powered = Vec::new();
        for &station_index in station_indices {
            let powered = powers.get(&station_index).copied().unwrap_or(0.0) > EPSILON;
            if !powered {
                continue;
            }
            if self
                .powered_station_indices
                .binary_search(&station_index)
                .is_err()
            {
                self.wake_dispatch_from_changed_stations(directory, &[station_index]);
            }
            next_powered.push(station_index);
        }
        self.powered_station_indices = next_powered;
    }

    fn take_dispatch_probe_indices(
        &mut self,
        directory: &InterstellarPeerDirectory,
    ) -> (Vec<usize>, bool) {
        if directory.fallback_full_scan {
            return (Vec::new(), true);
        }
        let active = self.pending_dispatch_demand_indices.len();
        let total = directory.demand_station_indices.len();
        let dense = active > 0
            && active.saturating_mul(REMOTE_DISPATCH_DENSE_DENOMINATOR)
                >= total.saturating_mul(REMOTE_DISPATCH_DENSE_NUMERATOR);
        if dense {
            self.pending_dispatch_demand_indices.clear();
            (directory.demand_station_indices.clone(), true)
        } else {
            (
                std::mem::take(&mut self.pending_dispatch_demand_indices),
                false,
            )
        }
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
        .ok_or_else(|| anyhow!("native interstellar logistics produced a non-finite number"))?;
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
        .ok_or_else(|| anyhow!("native interstellar inventory is missing"))?
        .insert(
            item_id.to_owned(),
            Number::from_f64(amount)
                .map(Value::Number)
                .ok_or_else(|| anyhow!("native interstellar inventory is non-finite"))?,
        );
    Ok(())
}

fn slots(entity: &Map<String, Value>) -> anyhow::Result<Vec<Slot>> {
    let values = entity
        .get("stationSlots")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("native interstellar slots are missing"))?;
    if values.len() != SLOT_COUNT {
        bail!("native interstellar slot count is invalid");
    }
    values
        .iter()
        .map(|value| {
            let slot = value
                .as_object()
                .ok_or_else(|| anyhow!("native interstellar slot is invalid"))?;
            let remote_mode = string_at(slot, "remoteMode").unwrap_or("storage");
            if !matches!(remote_mode, "supply" | "demand" | "storage") {
                bail!("native interstellar slot mode is invalid");
            }
            let minimum_load = finite_number(slot.get("minimumLoad"));
            if ![0.1, 0.25, 0.5, 1.0]
                .iter()
                .any(|value| (minimum_load - value).abs() <= f64::EPSILON)
            {
                bail!("native interstellar minimum load is invalid");
            }
            let route_policy = string_at(slot, "routePolicy").unwrap_or("relay-preferred");
            if !matches!(
                route_policy,
                "direct" | "relay-preferred" | "relay-required"
            ) {
                bail!("native interstellar route policy is invalid");
            }
            let warper_budget = finite_number(slot.get("warperBudget"))
                .floor()
                .clamp(1.0, 4.0) as usize;
            Ok(Slot {
                item_id: string_at(slot, "itemId").map(str::to_owned),
                remote_mode: remote_mode.to_owned(),
                minimum_load,
                min_stock: finite_number(slot.get("minStock")).floor().max(0.0),
                max_stock: finite_number(slot.get("maxStock")).floor().max(0.0),
                priority: slot
                    .get("priority")
                    .and_then(Value::as_u64)
                    .unwrap_or(1)
                    .min(2) as usize,
                route_policy: route_policy.to_owned(),
                warper_budget,
            })
        })
        .collect()
}

fn station_indices(entities: &[Value]) -> Vec<usize> {
    entities
        .iter()
        .enumerate()
        .filter_map(|(index, entity)| {
            entity.as_object().and_then(|object| {
                let building = string_at(object, "buildingId");
                (string_at(object, "kind") == Some("station")
                    && (building == Some("orbital_collector")
                        || building == Some("interstellar_logistics_station")
                            && !(finite_number(object.get("stationTier")).floor() == 2.0
                                && string_at(object, "stationOperationMode") == Some("elevator"))))
                .then_some(index)
            })
        })
        .collect()
}

fn ordered_subset(subset: &[usize], superset: &[usize]) -> bool {
    let mut superset_rank = 0;
    for &candidate in subset {
        while superset
            .get(superset_rank)
            .is_some_and(|value| *value < candidate)
        {
            superset_rank += 1;
        }
        if superset.get(superset_rank).copied() != Some(candidate) {
            return false;
        }
        superset_rank += 1;
    }
    true
}

impl InterstellarPeerDirectory {
    pub(crate) fn build(state: &CoreState, base: &Map<String, Value>, entities: &[Value]) -> Self {
        let station_rows: &[usize] = &state.factory_topology.station_indices;
        let mut directory = Self {
            total_station_rows: station_rows.len(),
            station_power_index_valid: station_rows.windows(2).all(|pair| pair[0] < pair[1]),
            routing_base_signature: RoutingBaseSignature::capture(base),
            ..Self::default()
        };
        let mut hub_by_system = HashMap::<String, usize>::new();

        for &station_index in station_rows {
            let Some(station) = entities.get(station_index).and_then(Value::as_object) else {
                directory.fallback_full_scan = true;
                return directory;
            };
            let building_id = string_at(station, "buildingId");
            let Some(station_planet) = planet(state, station) else {
                directory.fallback_full_scan = true;
                return directory;
            };
            let station_planet_index = state
                .factory_topology
                .entity_planet_indices
                .get(station_index)
                .copied()
                .filter(|index| *index < state.catalog.planets.len());
            let Some(station_planet_index) = station_planet_index else {
                directory.fallback_full_scan = true;
                return directory;
            };
            let station_system_unlocked = system_unlocked(base, &station_planet.system_id);
            let add_peer = |target: &mut HashMap<String, Vec<PeerSlotRef>>,
                            item_id: &str,
                            slot_index: usize| {
                target
                    .entry(item_id.to_owned())
                    .or_default()
                    .push(PeerSlotRef {
                        station_index,
                        slot_index,
                        planet_index: station_planet_index,
                        system_unlocked: station_system_unlocked,
                    });
            };

            if is_legacy_interstellar_station(station)
                && station
                    .get("stationHubEnabled")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                && station_system_unlocked
            {
                let replace =
                    hub_by_system
                        .get(&station_planet.system_id)
                        .is_none_or(|previous_index| {
                            let previous = entities[*previous_index]
                                .as_object()
                                .expect("station object");
                            let priority = finite_number(station.get("stationHubPriority"));
                            let previous_priority =
                                finite_number(previous.get("stationHubPriority"));
                            priority > previous_priority
                                || (priority == previous_priority
                                    && string_at(station, "id").unwrap_or_default()
                                        < string_at(previous, "id").unwrap_or_default())
                        });
                if replace {
                    hub_by_system.insert(station_planet.system_id.clone(), station_index);
                }
            }

            if building_id == Some("orbital_collector") {
                if !traditional_remote_disabled(station)
                    && let Some(item_id) = string_at(station, "storedItemId")
                {
                    add_peer(&mut directory.supply_by_item, item_id, 0);
                    directory
                        .supply_items_by_station
                        .entry(station_index)
                        .or_default()
                        .push(item_id.to_owned());
                    directory.orbital_supply_station_indices.push(station_index);
                }
                continue;
            }
            if !is_legacy_interstellar_station(station) || traditional_remote_disabled(station) {
                continue;
            }
            let station_slots = match slots(station) {
                Ok(slots) => slots,
                Err(_) => {
                    directory.fallback_full_scan = true;
                    return directory;
                }
            };
            let mut has_demand = false;
            for (slot_index, slot) in station_slots.iter().enumerate() {
                let Some(item_id) = slot.item_id.as_deref() else {
                    continue;
                };
                match slot.remote_mode.as_str() {
                    "supply" => {
                        add_peer(&mut directory.supply_by_item, item_id, slot_index);
                        let items = directory
                            .supply_items_by_station
                            .entry(station_index)
                            .or_default();
                        if !items.iter().any(|candidate| candidate == item_id) {
                            items.push(item_id.to_owned());
                        }
                    }
                    "demand" => {
                        add_peer(&mut directory.demand_by_item, item_id, slot_index);
                        let items = directory
                            .demand_items_by_station
                            .entry(station_index)
                            .or_default();
                        if !items.iter().any(|candidate| candidate == item_id) {
                            items.push(item_id.to_owned());
                        }
                        has_demand = true;
                    }
                    "storage" => {}
                    _ => unreachable!("validated native interstellar slot mode"),
                }
            }
            if has_demand {
                directory.demand_station_indices.push(station_index);
                directory.demand_station_set.insert(station_index);
            }
        }

        for (item_id, slots) in &directory.demand_by_item {
            let demands = directory
                .demand_stations_by_item
                .entry(item_id.clone())
                .or_default();
            for slot in slots {
                if demands.last().copied() != Some(slot.station_index) {
                    demands.push(slot.station_index);
                }
            }
        }

        // The route planner historically selected one best relay in each
        // unlocked system, then sorted those relays by station id. Materialize
        // that stable system bucket once instead of rescanning every entity for
        // every supply/demand pair.
        directory.hub_station_indices = hub_by_system.into_values().collect::<Vec<_>>();
        directory.hub_station_indices.sort_by(|left, right| {
            let left = entities[*left].as_object().expect("station object");
            let right = entities[*right].as_object().expect("station object");
            string_at(left, "id")
                .unwrap_or_default()
                .cmp(string_at(right, "id").unwrap_or_default())
        });
        directory
            .hub_station_set
            .extend(directory.hub_station_indices.iter().copied());
        directory
    }

    pub(crate) fn estimated_bytes(&self) -> u64 {
        let slot_bytes = self
            .supply_by_item
            .values()
            .chain(self.demand_by_item.values())
            .map(|values| values.capacity() * std::mem::size_of::<PeerSlotRef>())
            .sum::<usize>();
        let index_bytes = self
            .demand_stations_by_item
            .values()
            .map(|values| values.capacity() * std::mem::size_of::<usize>())
            .sum::<usize>()
            + self
                .supply_items_by_station
                .values()
                .chain(self.demand_items_by_station.values())
                .map(|values| {
                    values.capacity() * std::mem::size_of::<String>()
                        + values.iter().map(String::capacity).sum::<usize>()
                })
                .sum::<usize>()
            + (self.demand_station_indices.capacity()
                + self.hub_station_indices.capacity()
                + self.orbital_supply_station_indices.capacity())
                * std::mem::size_of::<usize>();
        let key_bytes = self
            .supply_by_item
            .keys()
            .chain(self.demand_by_item.keys())
            .chain(self.demand_stations_by_item.keys())
            .map(String::capacity)
            .sum::<usize>();
        let station_item_bucket_bytes = (self.supply_items_by_station.capacity()
            + self.demand_items_by_station.capacity())
            * std::mem::size_of::<(usize, Vec<String>)>();
        (slot_bytes + index_bytes + key_bytes + station_item_bucket_bytes) as u64
            + self.routing_base_signature.estimated_bytes()
    }

    pub(crate) fn matches_routing_base(&self, base: &Map<String, Value>) -> bool {
        self.routing_base_signature == RoutingBaseSignature::capture(base)
    }

    fn peer_candidates(&self, item_id: &str, opposite_mode: &str) -> &[PeerSlotRef] {
        let values = if opposite_mode == "supply" {
            self.supply_by_item.get(item_id)
        } else {
            self.demand_by_item.get(item_id)
        };
        values.map(Vec::as_slice).unwrap_or_default()
    }

    pub(crate) fn congestion_demand_station_indices(&self) -> &[usize] {
        &self.demand_station_indices
    }

    pub(crate) fn congestion_requires_full_scan(&self) -> bool {
        self.fallback_full_scan
    }

    fn append_power_dependencies_for_demands(
        &self,
        demand_indices: &[usize],
        target: &mut Vec<usize>,
    ) -> bool {
        if self.fallback_full_scan || !self.station_power_index_valid {
            return false;
        }
        let mut unique_demands = demand_indices.to_vec();
        unique_demands.sort_unstable();
        unique_demands.dedup();
        let mut item_ids = Vec::new();
        let mut seen_item_ids = HashSet::new();
        for demand_index in unique_demands {
            if !self.demand_station_set.contains(&demand_index) {
                return false;
            }
            let Some(items) = self.demand_items_by_station.get(&demand_index) else {
                return false;
            };
            target.push(demand_index);
            for item_id in items {
                if seen_item_ids.insert(item_id.as_str()) {
                    item_ids.push(item_id.as_str());
                }
            }
        }
        // A large wake can contain many demands for one item. Expand its
        // immutable supply list once, not once per demand, so transient query
        // work and memory stay linear in the affected directory edges.
        for item_id in item_ids {
            if let Some(supplies) = self.supply_by_item.get(item_id) {
                target.extend(supplies.iter().map(|supply| supply.station_index));
            }
        }
        true
    }

    fn append_power_dependencies_from_changed_stations(
        &self,
        changed_station_indices: &[usize],
        target: &mut Vec<usize>,
    ) -> bool {
        if self.fallback_full_scan || !self.station_power_index_valid {
            return false;
        }
        let mut demands = Vec::new();
        let mut affected_item_ids = Vec::new();
        let mut seen_item_ids = HashSet::new();
        let mut wake_all_demands = false;
        for &station_index in changed_station_indices {
            if self.hub_station_set.contains(&station_index) {
                wake_all_demands = true;
                continue;
            }
            if self.demand_station_set.contains(&station_index) {
                demands.push(station_index);
            }
            let Some(items) = self.supply_items_by_station.get(&station_index) else {
                continue;
            };
            for item_id in items {
                if seen_item_ids.insert(item_id.as_str()) {
                    affected_item_ids.push(item_id.as_str());
                }
            }
        }
        if wake_all_demands {
            demands.extend_from_slice(&self.demand_station_indices);
        } else {
            for item_id in affected_item_ids {
                if let Some(item_demands) = self.demand_stations_by_item.get(item_id) {
                    demands.extend_from_slice(item_demands);
                }
            }
        }
        demands.sort_unstable();
        demands.dedup();
        self.append_power_dependencies_for_demands(&demands, target)
    }
}

pub(crate) fn prepare_route_activity(entities: &[Value]) -> InterstellarRouteActivity {
    // Build every immutable route/refill index in one persisted-order pass.
    // These predicates used to rescan the complete entity JSON three times at
    // open; keeping them adjacent also makes their shared kind/building/route
    // lookups explicit without changing any permissive legacy predicate.
    let mut station_indices = Vec::new();
    let mut active_demand_indices = Vec::new();
    let mut opaque_route_demand_indices = Vec::new();
    let mut pending_dispatch_demand_indices = Vec::new();
    let mut warper_refill_station_indices = Vec::new();
    let mut warper_planet_ranks = HashMap::<&str, usize>::new();
    let mut warper_refill_planets = Vec::<(String, Vec<usize>)>::new();
    let mut warper_refill_full_scan_required = false;
    let mut transition_route_view =
        crate::station_route_ledger::RemoteTransitionRouteView::for_entity_count(entities.len());
    for (entity_index, entity) in entities.iter().enumerate() {
        transition_route_view.refresh_demand(entities, entity_index);
        let Some(entity) = entity.as_object() else {
            continue;
        };
        let kind = string_at(entity, "kind");
        let building = string_at(entity, "buildingId");
        let routes = entity.get("stationRoutes").and_then(Value::as_array);
        let remote_trackable = kind == Some("station")
            && matches!(
                building,
                Some("interstellar_logistics_station" | "orbital_collector")
            );

        // Keep every station that can ever participate in a remote route in
        // immutable persisted order, including an ILS currently in elevator
        // mode. Runtime transitions therefore need no O(all) rebuild.
        if remote_trackable {
            station_indices.push(entity_index);
            if routes.is_some_and(|routes| {
                routes
                    .iter()
                    .filter_map(Value::as_object)
                    .any(|route| string_at(route, "scope") == Some("remote"))
            }) {
                active_demand_indices.push(entity_index);
            }
            if is_legacy_interstellar_station(entity)
                && !traditional_remote_disabled(entity)
                && entity
                    .get("stationSlots")
                    .and_then(Value::as_array)
                    .is_some_and(|slots| {
                        slots.iter().filter_map(Value::as_object).any(|slot| {
                            slot.get("itemId").is_some_and(|value| !value.is_null())
                                && string_at(slot, "remoteMode") == Some("demand")
                        })
                    })
            {
                pending_dispatch_demand_indices.push(entity_index);
            }
        }

        if building == Some("interstellar_logistics_station") {
            warper_refill_station_indices.push(entity_index);
            if kind != Some("station") {
                warper_refill_full_scan_required = true;
            }
            if let Some(planet_id) = string_at(entity, "planetId") {
                let planet_rank = if let Some(rank) = warper_planet_ranks.get(planet_id).copied() {
                    rank
                } else {
                    let rank = warper_refill_planets.len();
                    warper_planet_ranks.insert(planet_id, rank);
                    warper_refill_planets.push((planet_id.to_owned(), Vec::new()));
                    rank
                };
                warper_refill_planets[planet_rank].1.push(entity_index);
            } else {
                warper_refill_full_scan_required = true;
            }
        }

        if routes.is_some() {
            let building = string_at(entity, "buildingId");
            let local_trackable = kind == Some("station")
                && matches!(
                    building,
                    Some("planetary_logistics_station" | "interstellar_logistics_station")
                )
                && !(building == Some("interstellar_logistics_station")
                    && finite_number(entity.get("stationTier")).floor() == 2.0
                    && string_at(entity, "stationOperationMode") == Some("elevator"));
            if routes.is_some_and(|routes| {
                routes.iter().filter_map(Value::as_object).any(|route| {
                    match string_at(route, "scope") {
                        Some("local") => !local_trackable,
                        Some("remote") => !remote_trackable,
                        _ => true,
                    }
                })
            }) {
                opaque_route_demand_indices.push(entity_index);
            }
        }
    }
    let warper_refill_planets = warper_refill_planets
        .into_iter()
        .map(|(planet_id, indices)| (planet_id, Arc::from(indices)))
        .collect::<Vec<_>>();
    // The legacy refill path reserves space warpers for every route shape,
    // including MOD-defined scopes. The compact ledger intentionally only
    // understands local/remote routes, so any opaque dependency must fail
    // closed to the persisted-order legacy scan instead of treating its cargo
    // as available inventory.
    warper_refill_full_scan_required |= !opaque_route_demand_indices.is_empty();
    InterstellarRouteActivity {
        station_indices: Arc::from(station_indices),
        active_demand_indices,
        transition_route_view,
        opaque_route_demand_indices,
        pending_readiness_demand_indices: pending_dispatch_demand_indices.clone(),
        pending_dispatch_demand_indices,
        readiness_topology_valid: None,
        ready_station_indices: Vec::new(),
        powered_station_indices: Vec::new(),
        warper_refill_station_indices: Arc::from(warper_refill_station_indices),
        warper_refill_planets: Arc::from(warper_refill_planets),
        warper_refill_all_pending: true,
        pending_warper_refill_station_indices: Vec::new(),
        warper_tray_amount_bits: Vec::new(),
        warper_refill_full_scan_required,
    }
}

pub(crate) fn refresh_route_activity_after_topology_change(
    entities: &[Value],
    topology_changed: bool,
    runtime: &mut Arc<InterstellarRouteActivity>,
) {
    if topology_changed {
        *runtime = Arc::new(prepare_route_activity(entities));
    }
}

pub(crate) fn refresh_peer_directory(
    state: &CoreState,
    base: &Map<String, Value>,
    entities: &[Value],
    force_rebuild: bool,
    directory: &mut Arc<InterstellarPeerDirectory>,
    route_activity: &mut Arc<InterstellarRouteActivity>,
) {
    if !force_rebuild && directory.matches_routing_base(base) {
        return;
    }
    *directory = Arc::new(InterstellarPeerDirectory::build(state, base, entities));
    reset_dispatch_wakes(directory, Arc::make_mut(route_activity));
}

pub(crate) fn wake_dispatch_from_changed_stations(
    changed_station_indices: &[usize],
    peer_directory: &InterstellarPeerDirectory,
    route_activity: &mut InterstellarRouteActivity,
) {
    route_activity.wake_dispatch_from_changed_stations(peer_directory, changed_station_indices);
}

pub(crate) fn wake_warper_refill_from_changed_stations(
    changed_station_indices: &[usize],
    route_activity: &mut InterstellarRouteActivity,
) {
    route_activity.wake_warper_refill_from_changed_stations(changed_station_indices);
}

pub(crate) fn refresh_warper_tray_wakes(
    base: &Map<String, Value>,
    route_activity: &mut InterstellarRouteActivity,
) {
    route_activity.wake_changed_warper_trays(base);
}

pub(crate) fn wake_orbital_supply_demands(
    peer_directory: &InterstellarPeerDirectory,
    route_activity: &mut InterstellarRouteActivity,
) {
    route_activity.wake_dispatch_from_changed_stations(
        peer_directory,
        &peer_directory.orbital_supply_station_indices,
    );
}

pub(crate) fn refresh_dispatch_power_wakes<P: StationPowerLookup + ?Sized>(
    station_indices: &[usize],
    powers: &P,
    peer_directory: &InterstellarPeerDirectory,
    route_activity: &mut InterstellarRouteActivity,
) {
    route_activity.refresh_power_wakes(peer_directory, station_indices, powers);
}

/// Select the only station rows whose power can be observed by this step's
/// local/remote dispatch or route advance. Readiness is deliberately computed
/// without power, so an inventory-ready station remains selected while its
/// grid is off and can wake dispatch on the exact false -> true transition.
/// Relay hubs are explicit prospective dependencies. Active route owners and
/// waypoints are already part of the shared readiness ledger.
pub(crate) fn select_station_power_indices(
    all_station_indices: &[usize],
    ready_station_indices: &[usize],
    changed_since_readiness: &[usize],
    local_directory: &crate::local_logistics::LocalPeerDirectory,
    peer_directory: &InterstellarPeerDirectory,
    route_activity: &InterstellarRouteActivity,
) -> (Vec<usize>, StationPowerScan) {
    let mut selected = ready_station_indices.to_vec();
    selected.extend_from_slice(&peer_directory.hub_station_indices);
    let directory_fallback = peer_directory.fallback_full_scan
        || !route_activity.opaque_route_demand_indices.is_empty()
        || route_activity.warper_refill_full_scan_required
        || !peer_directory.station_power_index_valid
        || peer_directory.total_station_rows != all_station_indices.len();
    let mut runtime_fallback = false;
    if !directory_fallback {
        // Late local inventory writes can make one configured pair ready after
        // the ordinary readiness pass. Resolve only that station's immutable
        // opposite-peer closure instead of powering every station.
        runtime_fallback |= !local_directory
            .append_station_power_dependencies(changed_since_readiness, &mut selected);

        // Pending remote demands already represent the complete reverse wake
        // queue for inventory, capacity, power, route, hub and topology
        // changes. Add their immutable endpoint closure before dispatch.
        runtime_fallback |= !peer_directory.append_power_dependencies_for_demands(
            &route_activity.pending_dispatch_demand_indices,
            &mut selected,
        );
        runtime_fallback |= !peer_directory.append_power_dependencies_from_changed_stations(
            changed_since_readiness,
            &mut selected,
        );

        // Refill happens after the power map is constructed. A tray/input/
        // output wake can therefore make its station a warp-capable vehicle
        // owner on this same boundary. Resolve the candidate's affected
        // demands now; the later refill still decides whether anything moves.
        let pending_warper_indices = if route_activity.warper_refill_all_pending {
            route_activity.warper_refill_station_indices.as_ref()
        } else {
            route_activity
                .pending_warper_refill_station_indices
                .as_slice()
        };
        runtime_fallback |= !local_directory
            .append_station_power_dependencies(pending_warper_indices, &mut selected);
        runtime_fallback |= !peer_directory
            .append_power_dependencies_from_changed_stations(pending_warper_indices, &mut selected);
    }
    selected.sort_unstable();
    selected.dedup();
    runtime_fallback |= selected
        .iter()
        .any(|index| all_station_indices.binary_search(index).is_err());
    let dense_fallback = !directory_fallback
        && !runtime_fallback
        && !selected.is_empty()
        && selected
            .len()
            .saturating_mul(STATION_POWER_DENSE_DENOMINATOR)
            >= all_station_indices
                .len()
                .saturating_mul(STATION_POWER_DENSE_NUMERATOR);
    if directory_fallback || runtime_fallback || dense_fallback {
        selected.clear();
        selected.extend_from_slice(all_station_indices);
    }
    let scan = StationPowerScan {
        selected_station_rows: selected.len(),
        total_station_rows: all_station_indices.len(),
        dense_fallback,
        directory_fallback,
        runtime_fallback,
    };
    (selected, scan)
}

pub(crate) fn reset_dispatch_wakes(
    peer_directory: &InterstellarPeerDirectory,
    route_activity: &mut InterstellarRouteActivity,
) {
    route_activity.wake_all_dispatch_demands(peer_directory);
    route_activity.powered_station_indices.clear();
    route_activity.wake_all_warper_refill_stations();
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

fn planet<'a>(state: &'a CoreState, entity: &Map<String, Value>) -> Option<&'a PlanetDefinition> {
    let planet_id = string_at(entity, "planetId")?;
    state
        .catalog
        .planets
        .iter()
        .find(|planet| planet.id == planet_id)
}

fn same_system(state: &CoreState, left: &Map<String, Value>, right: &Map<String, Value>) -> bool {
    planet(state, left)
        .zip(planet(state, right))
        .is_some_and(|(left, right)| left.system_id == right.system_id)
}

fn system_unlocked(base: &Map<String, Value>, system_id: &str) -> bool {
    base.get("exploration")
        .and_then(Value::as_object)
        .and_then(|exploration| exploration.get("unlockedSystemIds"))
        .and_then(Value::as_array)
        .is_some_and(|systems| {
            systems
                .iter()
                .any(|value| value.as_str() == Some(system_id))
        })
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
        .ok_or_else(|| anyhow!("native interstellar station building is missing"))?;
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

fn installed_vessels(entity: &Map<String, Value>) -> f64 {
    (VESSELS_PER_BUILDING * finite_number(entity.get("machineCount")).floor().max(0.0))
        .min(finite_number(entity.get("stationVessels")).floor().max(0.0))
}

fn vessel_capacity(entity: &Map<String, Value>) -> f64 {
    VESSELS_PER_BUILDING * finite_number(entity.get("machineCount")).floor().max(0.0)
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

fn traditional_remote_disabled(entity: &Map<String, Value>) -> bool {
    string_at(entity, "quantumMode") == Some("quantum")
        || entity
            .get("quantumTransition")
            .is_some_and(|value| !value.is_null())
}

fn is_legacy_interstellar_station(entity: &Map<String, Value>) -> bool {
    string_at(entity, "buildingId") == Some("interstellar_logistics_station")
        && !(finite_number(entity.get("stationTier")).floor() == 2.0
            && string_at(entity, "stationOperationMode") == Some("elevator"))
}

fn legacy_warper_reservations(entities: &[Value]) -> HashMap<String, f64> {
    let mut reserved_outgoing = HashMap::<String, f64>::new();
    for station in entities.iter().filter_map(Value::as_object) {
        let Some(routes) = station.get("stationRoutes").and_then(Value::as_array) else {
            continue;
        };
        for route in routes.iter().filter_map(Value::as_object) {
            if string_at(route, "itemId") != Some("space_warper") {
                continue;
            }
            let Some(source_id) = string_at(route, "peerId") else {
                continue;
            };
            *reserved_outgoing.entry(source_id.to_owned()).or_default() +=
                finite_number(route.get("cargo"));
        }
    }
    reserved_outgoing
}

fn legacy_warper_reservation_contributions(
    entities: &[Value],
    range: std::ops::Range<usize>,
) -> Vec<(&str, f64)> {
    let mut contributions = Vec::new();
    for station in entities[range].iter().filter_map(Value::as_object) {
        let Some(routes) = station.get("stationRoutes").and_then(Value::as_array) else {
            continue;
        };
        for route in routes.iter().filter_map(Value::as_object) {
            if string_at(route, "itemId") != Some("space_warper") {
                continue;
            }
            let Some(source_id) = string_at(route, "peerId") else {
                continue;
            };
            contributions.push((source_id, finite_number(route.get("cargo"))));
        }
    }
    contributions
}

fn legacy_warper_reservations_with_runtime(
    entities: &[Value],
    runtime: &DeterministicRuntime,
) -> HashMap<String, f64> {
    // The serial path is deliberately the original implementation. Besides
    // avoiding the chunk buffers for small saves, this keeps the one-worker
    // execution path byte-for-byte equivalent to the pre-parallel code.
    if runtime.worker_count_for_items(entities.len()) == 1 {
        return legacy_warper_reservations(entities);
    }

    // Probing JSON rows is read-only. Each fixed ascending chunk owns its
    // contribution buffer; the serial replay below retains the original
    // entity/route order, including floating-point addition order and the
    // first insertion of a peer id into the HashMap.
    let chunks = runtime.ordered_chunk_map(
        entities.len(),
        WARPER_RESERVATION_ROWS_PER_CHUNK,
        |_, range| legacy_warper_reservation_contributions(entities, range),
    );
    let mut reserved_outgoing = HashMap::<String, f64>::new();
    for (source_id, cargo) in chunks.into_iter().flatten() {
        *reserved_outgoing.entry(source_id.to_owned()).or_default() += cargo;
    }
    reserved_outgoing
}

fn planet_tray_warper_amount(base: &Map<String, Value>, planet_id: &str) -> f64 {
    let active_planet = base.get("activePlanetId").and_then(Value::as_str);
    (if active_planet == Some(planet_id) {
        base.get("tray")
    } else {
        base.get("planetTrays")
            .and_then(Value::as_object)
            .and_then(|trays| trays.get(planet_id))
    })
    .and_then(Value::as_object)
    .and_then(|tray| tray.get("space_warper"))
    .map(|value| finite_number(Some(value)).floor().max(0.0))
    .unwrap_or(0.0)
}

fn refill_station_warper(
    base: &mut Map<String, Value>,
    entity: &mut Value,
    output_reserved: f64,
) -> anyhow::Result<bool> {
    let Some(station) = entity.as_object_mut() else {
        return Ok(false);
    };
    if string_at(station, "buildingId") != Some("interstellar_logistics_station")
        || traditional_remote_disabled(station)
        || !station
            .get("stationWarperAutoRefill")
            .and_then(Value::as_bool)
            .unwrap_or(false)
    {
        return Ok(false);
    }

    let planet_id = string_at(station, "planetId")
        .ok_or_else(|| anyhow!("native warper refill station planet is missing"))?
        .to_owned();
    let loaded = finite_number(station.get("stationWarpers"))
        .floor()
        .max(0.0);
    let capacity =
        WARPER_CAPACITY_PER_BUILDING * finite_number(station.get("machineCount")).floor().max(0.0);
    if capacity < 1.0 {
        return Ok(false);
    }
    let target = station
        .get("stationWarperTarget")
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
        .map(f64::floor)
        .unwrap_or(DEFAULT_WARPER_TARGET)
        .max(1.0)
        .min(capacity);
    let input_available = item_amount(station, "inputs", "space_warper")
        .floor()
        .max(0.0);
    let output_stored = item_amount(station, "outputs", "space_warper")
        .floor()
        .max(0.0);
    let output_reserved = output_reserved.floor().max(0.0).min(output_stored);
    let output_available = (output_stored - output_reserved).max(0.0);
    let tray_available = planet_tray_warper_amount(base, &planet_id);

    let mut needed = (target - loaded).max(0.0);
    if needed < 1.0 {
        return Ok(false);
    }
    let before = loaded;
    let from_input = needed.min(input_available);
    if from_input > 0.0 {
        set_item_amount(
            station,
            "inputs",
            "space_warper",
            input_available - from_input,
        )?;
        set_number(station, "stationWarpers", loaded + from_input)?;
        needed -= from_input;
    }
    let from_output = needed.min(output_available);
    if from_output > 0.0 {
        set_item_amount(
            station,
            "outputs",
            "space_warper",
            output_stored - from_output,
        )?;
        let current = finite_number(station.get("stationWarpers"))
            .floor()
            .max(0.0);
        set_number(station, "stationWarpers", current + from_output)?;
        needed -= from_output;
    }
    if needed >= 1.0 {
        let from_tray = needed.min(tray_available);
        if from_tray > 0.0 {
            let active_planet = base.get("activePlanetId").and_then(Value::as_str);
            let tray = if active_planet == Some(planet_id.as_str()) {
                base.get_mut("tray").and_then(Value::as_object_mut)
            } else {
                base.get_mut("planetTrays")
                    .and_then(Value::as_object_mut)
                    .and_then(|trays| trays.get_mut(&planet_id))
                    .and_then(Value::as_object_mut)
            }
            .ok_or_else(|| anyhow!("native warper refill planet tray is missing"))?;
            tray.insert(
                "space_warper".to_owned(),
                Number::from_f64(tray_available - from_tray)
                    .map(Value::Number)
                    .ok_or_else(|| anyhow!("native warper refill tray value is non-finite"))?,
            );
            let current = finite_number(station.get("stationWarpers"))
                .floor()
                .max(0.0);
            set_number(station, "stationWarpers", current + from_tray)?;
        }
    }
    Ok(finite_number(station.get("stationWarpers")) > before + EPSILON)
}

fn refill_station_warpers_with_scan<L: InterstellarDispatchLedger + ?Sized>(
    base: &mut Map<String, Value>,
    entities: &mut [Value],
    route_activity: &mut InterstellarRouteActivity,
    route_ledger: &L,
    force_full_scan: bool,
) -> anyhow::Result<(Vec<usize>, WarperRefillScan)> {
    route_activity.wake_changed_warper_trays(base);
    if !completed_tech(base, "space_warp") {
        // Drain the runtime-only wake just like an empty refill pass. A later
        // technology transition rebuilds the routing signature and wakes all
        // candidates again; retaining this wake before unlock would otherwise
        // force a dense station-power closure every simulated second.
        let _ = route_activity.take_warper_refill_indices(entities.len(), force_full_scan);
        route_activity.record_warper_trays(base);
        return Ok((
            Vec::new(),
            WarperRefillScan {
                total_station_rows: route_activity.warper_refill_station_indices.len(),
                ..WarperRefillScan::default()
            },
        ));
    }

    let (selected_indices, mut scan) =
        route_activity.take_warper_refill_indices(entities.len(), force_full_scan);
    let legacy_reservations = selected_indices
        .is_none()
        .then(|| legacy_warper_reservations_with_runtime(entities, deterministic_runtime()));
    if legacy_reservations.is_some() {
        scan.reservation_rows_visited = entities.len();
    }

    let mut changed_station_indices = Vec::new();
    if let Some(indices) = selected_indices.as_deref() {
        for &entity_index in indices {
            if refill_station_warper(
                base,
                &mut entities[entity_index],
                route_ledger.reserved(entity_index, "space_warper"),
            )? {
                changed_station_indices.push(entity_index);
            }
        }
    } else {
        let reservations = legacy_reservations
            .as_ref()
            .expect("full scan reservations");
        for (entity_index, entity) in entities.iter_mut().enumerate() {
            let station_id = entity
                .as_object()
                .and_then(|station| string_at(station, "id"))
                .unwrap_or_default();
            if refill_station_warper(
                base,
                entity,
                reservations.get(station_id).copied().unwrap_or(0.0),
            )? {
                changed_station_indices.push(entity_index);
            }
        }
    }
    route_activity.record_warper_trays(base);
    Ok((changed_station_indices, scan))
}

pub(crate) fn refill_station_warpers(
    base: &mut Map<String, Value>,
    entities: &mut [Value],
    route_activity: &mut InterstellarRouteActivity,
    route_ledger: &StationRouteLedger,
) -> anyhow::Result<(Vec<usize>, WarperRefillScan)> {
    refill_station_warpers_with_scan(base, entities, route_activity, route_ledger, false)
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
    (CARGO_PER_VESSEL * multiplier).round()
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

fn minimum_cargo(base: &Map<String, Value>, slot: &Slot) -> f64 {
    (cargo_capacity(base) * slot.minimum_load).ceil()
}

fn travel_multiplier(base: &Map<String, Value>, planet_id: &str) -> f64 {
    base.get("galaxy")
        .and_then(Value::as_object)
        .and_then(|galaxy| galaxy.get("profiles"))
        .and_then(Value::as_object)
        .and_then(|profiles| profiles.get(planet_id))
        .and_then(Value::as_object)
        .and_then(|profile| profile.get("travelTimeMultiplier"))
        .map(|value| finite_number(Some(value)))
        .filter(|value| *value > 0.0)
        .unwrap_or(1.0)
}

fn system_distance_ly(base: &Map<String, Value>, source_system: &str, target_system: &str) -> f64 {
    if source_system == target_system {
        return 0.0;
    }
    let profile = |system_id: &str, key: &str| {
        base.get("galaxy")
            .and_then(Value::as_object)
            .and_then(|galaxy| galaxy.get("systemProfiles"))
            .and_then(Value::as_object)
            .and_then(|profiles| profiles.get(system_id))
            .and_then(Value::as_object)
            .and_then(|profile| profile.get(key))
            .map(|value| finite_number(Some(value)))
            .unwrap_or(0.0)
    };
    let dx = profile(source_system, "positionX") - profile(target_system, "positionX");
    let dy = profile(source_system, "positionY") - profile(target_system, "positionY");
    rounded(dx.hypot(dy).max(0.1), 4)
}

fn interstellar_leg(
    state: &CoreState,
    base: &Map<String, Value>,
    entities: &[Value],
    source_index: usize,
    target_index: usize,
) -> anyhow::Result<(f64, f64)> {
    let source = entities[source_index]
        .as_object()
        .ok_or_else(|| anyhow!("native interstellar leg source is invalid"))?;
    let target = entities[target_index]
        .as_object()
        .ok_or_else(|| anyhow!("native interstellar leg target is invalid"))?;
    let source_planet = planet(state, source)
        .ok_or_else(|| anyhow!("native interstellar leg source planet is missing"))?;
    let target_planet = planet(state, target)
        .ok_or_else(|| anyhow!("native interstellar leg target planet is missing"))?;
    let distance = system_distance_ly(base, &source_planet.system_id, &target_planet.system_id);
    let environment = (travel_multiplier(base, &source_planet.id)
        + travel_multiplier(base, &target_planet.id))
        / 2.0;
    let distance_factor = 0.75 + distance / 24.0;
    let long_leg_penalty = if distance > 12.0 {
        1.0 + (distance - 12.0) / 14.0
    } else {
        1.0
    };
    Ok((
        distance,
        12.0 / logistics_speed(base) * environment * distance_factor * long_leg_penalty,
    ))
}

fn collect_path_candidate(
    state: &CoreState,
    base: &Map<String, Value>,
    entities: &[Value],
    station_indices: Vec<usize>,
) -> anyhow::Result<PlannedPath> {
    let mut distance = 0.0;
    let mut duration = 0.0;
    let mut max_leg_distance = 0.0_f64;
    for leg in station_indices.windows(2) {
        let (leg_distance, leg_duration) = interstellar_leg(state, base, entities, leg[0], leg[1])?;
        distance += leg_distance;
        duration += leg_duration;
        max_leg_distance = max_leg_distance.max(leg_distance);
    }
    let priority_bonus = station_indices[1..station_indices.len() - 1]
        .iter()
        .map(|index| {
            entities[*index]
                .as_object()
                .map(|station| finite_number(station.get("stationHubPriority")))
                .unwrap_or(1.0)
                * 0.025
        })
        .sum::<f64>();
    Ok(PlannedPath {
        station_indices,
        distance_ly: distance,
        duration,
        max_leg_distance_ly: max_leg_distance,
        score: duration * (1.0 - priority_bonus).max(0.85),
    })
}

#[allow(clippy::too_many_arguments)]
fn visit_paths(
    state: &CoreState,
    base: &Map<String, Value>,
    entities: &[Value],
    target_index: usize,
    route_policy: &str,
    maximum_hops: usize,
    stations: &mut Vec<usize>,
    remaining_hubs: &[usize],
    candidates: &mut Vec<PlannedPath>,
) -> anyhow::Result<()> {
    let hops_used = stations.len() - 1;
    if hops_used >= maximum_hops {
        return Ok(());
    }
    let mut direct = stations.clone();
    direct.push(target_index);
    if route_policy != "relay-required" || direct.len() > 2 {
        candidates.push(collect_path_candidate(state, base, entities, direct)?);
    }
    if route_policy == "direct" || hops_used + 1 >= maximum_hops {
        return Ok(());
    }
    let current = *stations.last().expect("path source");
    for hub_index in remaining_hubs {
        let (distance, _) = interstellar_leg(state, base, entities, current, *hub_index)?;
        if distance > 18.0 {
            continue;
        }
        stations.push(*hub_index);
        let next_hubs = remaining_hubs
            .iter()
            .copied()
            .filter(|candidate| candidate != hub_index)
            .collect::<Vec<_>>();
        visit_paths(
            state,
            base,
            entities,
            target_index,
            route_policy,
            maximum_hops,
            stations,
            &next_hubs,
            candidates,
        )?;
        stations.pop();
    }
    Ok(())
}

fn plan_path(
    state: &CoreState,
    base: &Map<String, Value>,
    entities: &[Value],
    supply_index: usize,
    demand_index: usize,
    demand_slot: &Slot,
    indexed_hubs: Option<&[usize]>,
) -> anyhow::Result<Option<PlannedPath>> {
    let supply = entities[supply_index].as_object().expect("station object");
    let demand = entities[demand_index].as_object().expect("station object");
    let supply_system = &planet(state, supply)
        .ok_or_else(|| anyhow!("native interstellar supply planet is missing"))?
        .system_id;
    let demand_system = &planet(state, demand)
        .ok_or_else(|| anyhow!("native interstellar demand planet is missing"))?
        .system_id;
    let hubs = if let Some(indexed_hubs) = indexed_hubs {
        indexed_hubs
            .iter()
            .copied()
            .filter(|index| {
                let station = entities[*index].as_object().expect("station object");
                planet(state, station).is_some_and(|planet| {
                    planet.system_id != *supply_system && planet.system_id != *demand_system
                })
            })
            .collect::<Vec<_>>()
    } else {
        let mut hub_by_system = HashMap::<String, usize>::new();
        for index in station_indices(entities) {
            if index == supply_index || index == demand_index {
                continue;
            }
            let station = entities[index].as_object().expect("station object");
            if string_at(station, "buildingId") != Some("interstellar_logistics_station")
                || !station
                    .get("stationHubEnabled")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
            {
                continue;
            }
            let Some(system_id) = planet(state, station).map(|planet| planet.system_id.as_str())
            else {
                continue;
            };
            if system_id == supply_system
                || system_id == demand_system
                || !system_unlocked(base, system_id)
            {
                continue;
            }
            let replace = hub_by_system.get(system_id).is_none_or(|previous_index| {
                let previous = entities[*previous_index]
                    .as_object()
                    .expect("station object");
                let priority = finite_number(station.get("stationHubPriority"));
                let previous_priority = finite_number(previous.get("stationHubPriority"));
                priority > previous_priority
                    || (priority == previous_priority
                        && string_at(station, "id").unwrap_or_default()
                            < string_at(previous, "id").unwrap_or_default())
            });
            if replace {
                hub_by_system.insert(system_id.to_owned(), index);
            }
        }
        let mut hubs = hub_by_system.into_values().collect::<Vec<_>>();
        hubs.sort_by(|left, right| {
            let left = entities[*left].as_object().expect("station object");
            let right = entities[*right].as_object().expect("station object");
            string_at(left, "id")
                .unwrap_or_default()
                .cmp(string_at(right, "id").unwrap_or_default())
        });
        hubs
    };
    let mut candidates = Vec::new();
    visit_paths(
        state,
        base,
        entities,
        demand_index,
        &demand_slot.route_policy,
        demand_slot.warper_budget,
        &mut vec![supply_index],
        &hubs,
        &mut candidates,
    )?;
    candidates.sort_by(|left, right| {
        left.score
            .partial_cmp(&right.score)
            .unwrap_or(Ordering::Equal)
            .then_with(|| left.station_indices.len().cmp(&right.station_indices.len()))
            .then_with(|| {
                let ids = |path: &PlannedPath| {
                    path.station_indices
                        .iter()
                        .map(|index| {
                            entities[*index]
                                .as_object()
                                .and_then(|station| string_at(station, "id"))
                                .unwrap_or_default()
                        })
                        .collect::<Vec<_>>()
                        .join(":")
                };
                ids(left).cmp(&ids(right))
            })
    });
    Ok(candidates.into_iter().next())
}

fn route_economics(
    state: &CoreState,
    base: &Map<String, Value>,
    entities: &[Value],
    supply_index: usize,
    demand_index: usize,
    demand_slot: &Slot,
    indexed_hubs: Option<&[usize]>,
) -> anyhow::Result<Option<RouteEconomics>> {
    let supply = entities[supply_index].as_object().expect("station object");
    let demand = entities[demand_index].as_object().expect("station object");
    let supply_planet = planet(state, supply)
        .ok_or_else(|| anyhow!("native interstellar supply planet is missing"))?;
    let demand_planet = planet(state, demand)
        .ok_or_else(|| anyhow!("native interstellar demand planet is missing"))?;
    let environment = (travel_multiplier(base, &supply_planet.id)
        + travel_multiplier(base, &demand_planet.id))
        / 2.0;
    if supply_planet.system_id == demand_planet.system_id {
        let orbit_span = supply_planet
            .orbit_index
            .abs_diff(demand_planet.orbit_index)
            .max(1) as f64;
        return Ok(Some(RouteEconomics {
            requires_warp: false,
            duration: rounded(
                BASE_TRIP_SECONDS / logistics_speed(base) * environment * (0.9 + orbit_span * 0.1),
                2,
            ),
            distance_ly: 0.0,
            warpers_per_vessel: 0.0,
            waypoint_station_ids: Vec::new(),
        }));
    }
    let Some(path) = plan_path(
        state,
        base,
        entities,
        supply_index,
        demand_index,
        demand_slot,
        indexed_hubs,
    )?
    else {
        return Ok(None);
    };
    let waypoint_station_ids = path.station_indices[1..path.station_indices.len() - 1]
        .iter()
        .map(|index| {
            entities[*index]
                .as_object()
                .and_then(|station| string_at(station, "id"))
                .unwrap_or_default()
                .to_owned()
        })
        .collect::<Vec<_>>();
    let hop_count = path.station_indices.len() - 1;
    let _ = path.max_leg_distance_ly;
    Ok(Some(RouteEconomics {
        requires_warp: true,
        duration: rounded(path.duration, 2),
        distance_ly: rounded(path.distance_ly, 2),
        warpers_per_vessel: hop_count as f64,
        waypoint_station_ids,
    }))
}

fn route_owner_id<'a>(demand: &'a Map<String, Value>, route: &'a Map<String, Value>) -> &'a str {
    string_at(route, "vehicleStationId")
        .unwrap_or_else(|| string_at(demand, "id").unwrap_or_default())
}

fn orbital_slot(entity: &Map<String, Value>) -> Slot {
    Slot {
        item_id: string_at(entity, "storedItemId").map(str::to_owned),
        remote_mode: "supply".to_owned(),
        minimum_load: 1.0,
        min_stock: 0.0,
        max_stock: 0.0,
        priority: 1,
        route_policy: "relay-preferred".to_owned(),
        warper_budget: 2,
    }
}

fn orbital_yield(base: &Map<String, Value>, planet_id: &str, item_id: &str) -> f64 {
    base.get("galaxy")
        .and_then(Value::as_object)
        .and_then(|galaxy| galaxy.get("profiles"))
        .and_then(Value::as_object)
        .and_then(|profiles| profiles.get(planet_id))
        .and_then(Value::as_object)
        .and_then(|profile| profile.get("orbitalYields"))
        .and_then(Value::as_object)
        .and_then(|yields| yields.get(item_id))
        .map(|value| finite_number(Some(value)))
        .unwrap_or(0.0)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct OrbitalCollectorScanDiagnostics {
    selected_rows: usize,
    total_rows: usize,
    dense_fallback: bool,
    directory_fallback: bool,
}

fn orbital_collector_scan<'a>(
    state: &'a CoreState,
    entities: &[Value],
    force_full_scan: bool,
) -> (Option<&'a [usize]>, OrbitalCollectorScanDiagnostics) {
    let topology = &state.factory_topology;
    let indexed = topology.orbital_collector_indices.as_slice();
    let directory_fallback = topology.orbital_collector_full_scan_required
        || indexed.windows(2).any(|pair| pair[0] >= pair[1])
        || indexed.iter().copied().any(|index| {
            entities
                .get(index)
                .and_then(Value::as_object)
                .and_then(|entity| string_at(entity, "buildingId"))
                != Some("orbital_collector")
        });
    let dense_fallback = !force_full_scan
        && !directory_fallback
        && !indexed.is_empty()
        && indexed
            .len()
            .saturating_mul(ORBITAL_COLLECTOR_DENSE_DENOMINATOR)
            >= entities
                .len()
                .saturating_mul(ORBITAL_COLLECTOR_DENSE_NUMERATOR);
    let full_scan = force_full_scan || directory_fallback || dense_fallback;
    (
        (!full_scan).then_some(indexed),
        OrbitalCollectorScanDiagnostics {
            selected_rows: if full_scan {
                entities.len()
            } else {
                indexed.len()
            },
            total_rows: entities.len(),
            dense_fallback,
            directory_fallback,
        },
    )
}

fn run_orbital_collector(
    state: &CoreState,
    base: &mut Map<String, Value>,
    entity: &mut Value,
    seconds: f64,
    output_credits: &crate::belts::OutputCredits,
    infinite_multiplier: f64,
) -> anyhow::Result<()> {
    let Some(entity) = entity.as_object_mut() else {
        return Ok(());
    };
    if string_at(entity, "buildingId") != Some("orbital_collector") {
        return Ok(());
    }
    let planet_id = string_at(entity, "planetId").unwrap_or_default().to_owned();
    let item_id = string_at(entity, "storedItemId")
        .ok_or_else(|| anyhow!("native orbital collector item is missing"))?
        .to_owned();
    if orbital_yield(base, &planet_id, &item_id) <= 0.0 {
        bail!("native orbital collector item has no configured yield");
    }
    entity.insert("storedItemId".to_owned(), Value::from(item_id.clone()));
    entity.insert("stationMode".to_owned(), Value::from("supply"));
    let capacity = station_capacity(state, base, entity, &orbital_slot(entity))?;
    let incoming = (item_amount(entity, "inputs", &item_id) + EPSILON).floor();
    let stored = (item_amount(entity, "outputs", &item_id) + EPSILON).floor();
    let buffered = incoming.min((capacity - stored).max(0.0));
    set_item_amount(entity, "inputs", &item_id, incoming - buffered)?;
    let current = stored + buffered;
    set_item_amount(entity, "outputs", &item_id, current)?;
    let entity_id = string_at(entity, "id").unwrap_or_default();
    let credit = crate::belts::output_credit(state, output_credits, entity_id, &item_id);
    let free = (capacity - current).max(0.0) + credit;
    if free < 1.0 {
        set_number(entity, "progress", 0.0)?;
        return Ok(());
    }
    let profile_multiplier = base
        .get("galaxy")
        .and_then(Value::as_object)
        .and_then(|galaxy| galaxy.get("profiles"))
        .and_then(Value::as_object)
        .and_then(|profiles| profiles.get(&planet_id))
        .and_then(Value::as_object)
        .and_then(|profile| profile.get("orbitalYieldMultiplier"))
        .map(|value| finite_number(Some(value)))
        .unwrap_or(1.0);
    let rate = orbital_yield(base, &planet_id, &item_id)
        * finite_number(entity.get("machineCount"))
        * profile_multiplier
        * infinite_multiplier;
    let progress = rounded(finite_number(entity.get("progress")) + rate * seconds, 6);
    let produced = free.min((progress + EPSILON).floor());
    set_item_amount(entity, "outputs", &item_id, current + produced)?;
    set_number(
        entity,
        "progress",
        if produced >= free {
            0.0
        } else {
            rounded(progress - produced, 6)
        },
    )?;
    set_number(entity, "utilization", 1.0)?;
    set_number(entity, "productionRate", rounded(rate * 60.0, 2))?;
    let total_produced = base
        .get_mut("totalProduced")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| anyhow!("native total-produced record is missing"))?;
    let total = finite_number(total_produced.get(&item_id));
    set_number(total_produced, &item_id, (total + produced).floor())?;
    Ok(())
}

fn run_orbital_collectors_with_scan(
    state: &CoreState,
    base: &mut Map<String, Value>,
    entities: &mut [Value],
    seconds: f64,
    output_credits: &crate::belts::OutputCredits,
    force_full_scan: bool,
) -> anyhow::Result<OrbitalCollectorScanDiagnostics> {
    let infinite_multiplier = 1.0
        + base
            .get("endgame")
            .and_then(Value::as_object)
            .and_then(|endgame| endgame.get("infiniteResearch"))
            .and_then(Value::as_object)
            .and_then(|research| research.get("vein_utilization"))
            .and_then(Value::as_object)
            .and_then(|progress| progress.get("level"))
            .map(|value| finite_number(Some(value)).floor().clamp(0.0, 1_000.0))
            .unwrap_or(0.0)
            * 0.1;
    let (indexed, diagnostics) = orbital_collector_scan(state, entities, force_full_scan);
    if let Some(indexed) = indexed {
        for &index in indexed {
            run_orbital_collector(
                state,
                base,
                &mut entities[index],
                seconds,
                output_credits,
                infinite_multiplier,
            )?;
        }
    } else {
        for entity in entities {
            run_orbital_collector(
                state,
                base,
                entity,
                seconds,
                output_credits,
                infinite_multiplier,
            )?;
        }
    }
    Ok(diagnostics)
}

pub(crate) fn run_orbital_collectors(
    state: &CoreState,
    base: &mut Map<String, Value>,
    entities: &mut [Value],
    seconds: f64,
    output_credits: &crate::belts::OutputCredits,
) -> anyhow::Result<()> {
    run_orbital_collectors_with_scan(state, base, entities, seconds, output_credits, false)
        .map(|_| ())
}

trait EntityIndexLookup {
    fn get(&self, id: &str) -> Option<&usize>;
}

impl EntityIndexLookup for ExactRowIdIndex {
    fn get(&self, id: &str) -> Option<&usize> {
        self.get(id)
    }
}

impl EntityIndexLookup for SharedArc<ExactRowIdIndex> {
    fn get(&self, id: &str) -> Option<&usize> {
        ExactRowIdIndex::get(self, id)
    }
}

#[cfg(test)]
impl EntityIndexLookup for HashMap<String, usize> {
    fn get(&self, id: &str) -> Option<&usize> {
        HashMap::get(self, id)
    }
}

#[cfg(test)]
fn build_ledger<I: EntityIndexLookup + ?Sized>(entities: &[Value], indexes: &I) -> Ledger {
    let mut ledger = Ledger::default();
    let mut active_stations = Vec::<usize>::with_capacity(8);
    for (demand_index, demand) in entities
        .iter()
        .enumerate()
        .filter_map(|(index, value)| value.as_object().map(|object| (index, object)))
    {
        let Some(routes) = demand.get("stationRoutes").and_then(Value::as_array) else {
            continue;
        };
        for route in routes.iter().filter_map(Value::as_object) {
            let scope = string_at(route, "scope");
            let owner = indexes
                .get(route_owner_id(demand, route))
                .copied()
                .unwrap_or(demand_index);
            let supply = string_at(route, "peerId")
                .and_then(|id| indexes.get(id))
                .copied();
            active_stations.clear();
            active_stations.push(demand_index);
            if owner != demand_index {
                active_stations.push(owner);
            }
            if let Some(supply) = supply
                && !active_stations.contains(&supply)
            {
                active_stations.push(supply);
            }
            for waypoint in route
                .get("waypointStationIds")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .filter_map(|id| indexes.get(id).copied())
            {
                if !active_stations.contains(&waypoint) {
                    active_stations.push(waypoint);
                }
            }
            let progress = finite_number(route.get("progress"));
            for &station_index in &active_stations {
                let active_progress = ledger.active_progress.entry(station_index).or_default();
                *active_progress = active_progress.max(progress);
            }
            if !matches!(scope, Some("local" | "remote")) {
                continue;
            }
            let raw_vehicles = finite_number(route.get("vehicleCount"));
            let vehicles = raw_vehicles.floor().max(0.0);
            let cargo = finite_number(route.get("cargo")).floor().max(0.0);
            let item = string_at(route, "itemId").unwrap_or_default().to_owned();
            if scope == Some("remote") {
                *ledger.busy.entry(owner).or_default() += vehicles;
                ledger
                    .active_remote_stations
                    .extend(active_stations.iter().copied());
            } else {
                *ledger.local_busy.entry(owner).or_default() += raw_vehicles;
            }
            *ledger
                .in_flight
                .entry((demand_index, item.clone()))
                .or_default() += cargo;
            if let Some(supply) = supply {
                *ledger.reserved.entry((supply, item)).or_default() += cargo;
            }
            for &station_index in &active_stations {
                *ledger.active_vehicle_load.entry(station_index).or_default() += vehicles;
            }
        }
    }
    ledger
}

fn sort_peer_matches(entities: &[Value], matches: &mut [(usize, usize)]) {
    matches.sort_by(|(left_index, left_slot), (right_index, right_slot)| {
        let left = entities[*left_index].as_object().expect("station object");
        let right = entities[*right_index].as_object().expect("station object");
        let left_priority = if string_at(left, "buildingId") == Some("orbital_collector") {
            1
        } else {
            slots(left)
                .ok()
                .and_then(|values| values.get(*left_slot).map(|slot| slot.priority))
                .unwrap_or(1)
        };
        let right_priority = if string_at(right, "buildingId") == Some("orbital_collector") {
            1
        } else {
            slots(right)
                .ok()
                .and_then(|values| values.get(*right_slot).map(|slot| slot.priority))
                .unwrap_or(1)
        };
        right_priority
            .cmp(&left_priority)
            .then_with(|| {
                string_at(left, "id")
                    .unwrap_or_default()
                    .cmp(string_at(right, "id").unwrap_or_default())
            })
            .then_with(|| left_slot.cmp(right_slot))
    });
}

fn peer_matches_full_scan(
    state: &CoreState,
    base: &Map<String, Value>,
    entities: &[Value],
    station_index: usize,
    slot_index: usize,
) -> anyhow::Result<Vec<(usize, usize)>> {
    let station = entities[station_index]
        .as_object()
        .ok_or_else(|| anyhow!("native interstellar station is invalid"))?;
    if string_at(station, "buildingId") != Some("interstellar_logistics_station") {
        return Ok(Vec::new());
    }
    if traditional_remote_disabled(station) {
        return Ok(Vec::new());
    }
    let station_slots = slots(station)?;
    let slot = station_slots
        .get(slot_index)
        .ok_or_else(|| anyhow!("native interstellar slot index is invalid"))?;
    let Some(item_id) = slot.item_id.as_deref() else {
        return Ok(Vec::new());
    };
    if slot.remote_mode == "storage" {
        return Ok(Vec::new());
    }
    let opposite = if slot.remote_mode == "supply" {
        "demand"
    } else {
        "supply"
    };
    let planet_id = string_at(station, "planetId");
    let mut matches = Vec::new();
    for peer_index in state.factory_topology.station_indices.iter().copied() {
        if peer_index == station_index {
            continue;
        }
        let peer = entities[peer_index].as_object().expect("station object");
        if traditional_remote_disabled(peer)
            || string_at(peer, "planetId") == planet_id
            || planet(state, peer).is_none_or(|planet| !system_unlocked(base, &planet.system_id))
        {
            continue;
        }
        if string_at(peer, "buildingId") == Some("orbital_collector") {
            if opposite == "supply" && string_at(peer, "storedItemId") == Some(item_id) {
                let (supply_index, demand_index, demand_slot) = (peer_index, station_index, slot);
                if route_economics(
                    state,
                    base,
                    entities,
                    supply_index,
                    demand_index,
                    demand_slot,
                    None,
                )?
                .is_some()
                {
                    matches.push((peer_index, 0));
                }
            }
            continue;
        }
        if !is_legacy_interstellar_station(peer) {
            continue;
        }
        for (peer_slot_index, peer_slot) in slots(peer)?.iter().enumerate() {
            if peer_slot.item_id.as_deref() == Some(item_id) && peer_slot.remote_mode == opposite {
                let (supply_index, demand_index, demand_slot) = if slot.remote_mode == "demand" {
                    (peer_index, station_index, slot)
                } else {
                    (station_index, peer_index, peer_slot)
                };
                if route_economics(
                    state,
                    base,
                    entities,
                    supply_index,
                    demand_index,
                    demand_slot,
                    None,
                )?
                .is_some()
                {
                    matches.push((peer_index, peer_slot_index));
                }
            }
        }
    }
    sort_peer_matches(entities, &mut matches);
    Ok(matches)
}

fn peer_matches_indexed(
    state: &CoreState,
    base: &Map<String, Value>,
    entities: &[Value],
    station_index: usize,
    slot_index: usize,
    directory: &InterstellarPeerDirectory,
) -> anyhow::Result<(Vec<(usize, usize)>, PeerLookupScan)> {
    if directory.fallback_full_scan {
        return Ok((
            peer_matches_full_scan(state, base, entities, station_index, slot_index)?,
            PeerLookupScan {
                full_scan_rows_visited: directory.total_station_rows,
                used_full_scan: true,
                ..PeerLookupScan::default()
            },
        ));
    }
    let station = entities[station_index]
        .as_object()
        .ok_or_else(|| anyhow!("native interstellar station is invalid"))?;
    if string_at(station, "buildingId") != Some("interstellar_logistics_station")
        || traditional_remote_disabled(station)
    {
        return Ok((Vec::new(), PeerLookupScan::default()));
    }
    let station_slots = slots(station)?;
    let slot = station_slots
        .get(slot_index)
        .ok_or_else(|| anyhow!("native interstellar slot index is invalid"))?;
    let Some(item_id) = slot.item_id.as_deref() else {
        return Ok((Vec::new(), PeerLookupScan::default()));
    };
    if slot.remote_mode == "storage" {
        return Ok((Vec::new(), PeerLookupScan::default()));
    }
    let opposite = if slot.remote_mode == "supply" {
        "demand"
    } else {
        "supply"
    };
    let station_planet_index = state
        .factory_topology
        .entity_planet_indices
        .get(station_index)
        .copied()
        .unwrap_or(usize::MAX);
    let candidates = directory.peer_candidates(item_id, opposite);
    let mut matches = Vec::new();
    for candidate in candidates {
        if candidate.station_index == station_index
            || candidate.planet_index == station_planet_index
            || !candidate.system_unlocked
        {
            continue;
        }
        let peer = entities[candidate.station_index]
            .as_object()
            .expect("station object");
        if traditional_remote_disabled(peer) {
            continue;
        }
        let peer_slot = if string_at(peer, "buildingId") == Some("orbital_collector") {
            orbital_slot(peer)
        } else {
            slots(peer)?
                .get(candidate.slot_index)
                .cloned()
                .ok_or_else(|| anyhow!("native interstellar slot index is invalid"))?
        };
        if peer_slot.item_id.as_deref() != Some(item_id) || peer_slot.remote_mode != opposite {
            return Ok((
                peer_matches_full_scan(state, base, entities, station_index, slot_index)?,
                PeerLookupScan {
                    full_scan_rows_visited: directory.total_station_rows,
                    used_full_scan: true,
                    ..PeerLookupScan::default()
                },
            ));
        }
        let (supply_index, demand_index, demand_slot) = if slot.remote_mode == "demand" {
            (candidate.station_index, station_index, slot)
        } else {
            (station_index, candidate.station_index, &peer_slot)
        };
        if route_economics(
            state,
            base,
            entities,
            supply_index,
            demand_index,
            demand_slot,
            Some(&directory.hub_station_indices),
        )?
        .is_some()
        {
            matches.push((candidate.station_index, candidate.slot_index));
        }
    }
    sort_peer_matches(entities, &mut matches);
    Ok((
        matches,
        PeerLookupScan {
            candidate_rows_visited: candidates.len(),
            ..PeerLookupScan::default()
        },
    ))
}

fn lookup_peer_matches(
    state: &CoreState,
    base: &Map<String, Value>,
    entities: &[Value],
    station_index: usize,
    slot_index: usize,
    directory: Option<&InterstellarPeerDirectory>,
) -> anyhow::Result<(Vec<(usize, usize)>, PeerLookupScan)> {
    if let Some(directory) = directory {
        peer_matches_indexed(state, base, entities, station_index, slot_index, directory)
    } else {
        Ok((
            peer_matches_full_scan(state, base, entities, station_index, slot_index)?,
            PeerLookupScan {
                full_scan_rows_visited: state.factory_topology.station_indices.len(),
                used_full_scan: true,
                ..PeerLookupScan::default()
            },
        ))
    }
}

pub(crate) fn admission_reason(state: &CoreState) -> anyhow::Result<Option<&'static str>> {
    let entities = (0..state.entity_index.len())
        .map(|index| state.parse_entity(index))
        .collect::<anyhow::Result<Vec<_>>>()?;
    let indexes = entity_index(&entities);
    let base = state.base_value();
    for station_index in station_indices(&entities) {
        let station = entities[station_index].as_object().expect("station object");
        match string_at(station, "buildingId") {
            Some("planetary_logistics_station") => continue,
            Some("interstellar_logistics_station") => {}
            Some("orbital_collector") => {
                let item_id = string_at(station, "storedItemId");
                let planet_id = string_at(station, "planetId").unwrap_or_default();
                if !matches!(
                    string_at(station, "quantumMode"),
                    None | Some("legacy" | "quantum" | "transitioning")
                ) || item_id.is_none_or(|id| {
                    !state.catalog.items.contains_key(id)
                        || orbital_yield(base, planet_id, id) <= 0.0
                }) || station
                    .get("stationRoutes")
                    .and_then(Value::as_array)
                    .is_some_and(|routes| !routes.is_empty())
                    || planet(state, station)
                        .is_none_or(|planet| !system_unlocked(base, &planet.system_id))
                {
                    return Ok(Some("orbital-collector-invalid"));
                }
                continue;
            }
            _ => return Ok(Some("interstellar-station-type-unsupported")),
        }
        if !matches!(
            string_at(station, "stationOperationMode"),
            None | Some("legacy")
        ) || station.get("stationModeTransition").is_some_and(|value| {
            !value.is_null() && !matches!(value.as_str(), Some("to-elevator" | "to-legacy"))
        }) || !matches!(
            string_at(station, "quantumMode"),
            None | Some("legacy" | "quantum" | "transitioning")
        ) {
            return Ok(Some("interstellar-station-mode-unsupported"));
        }
        let station_slots = match slots(station) {
            Ok(values) => values,
            Err(_) => return Ok(Some("interstellar-slots-invalid")),
        };
        if station_slots
            .iter()
            .filter_map(|slot| slot.item_id.as_deref())
            .any(|id| !state.catalog.items.contains_key(id))
        {
            return Ok(Some("interstellar-slot-item-invalid"));
        }
        let Some(routes) = station.get("stationRoutes").and_then(Value::as_array) else {
            return Ok(Some("interstellar-routes-invalid"));
        };
        for route_value in routes {
            let Some(route) = route_value.as_object() else {
                return Ok(Some("interstellar-route-invalid"));
            };
            if string_at(route, "scope") == Some("local") {
                continue;
            }
            let peer_index = string_at(route, "peerId")
                .and_then(|id| indexes.get(id))
                .copied();
            let owner_valid = indexes.contains_key(route_owner_id(station, route));
            let same_system_route = peer_index.and_then(|peer_index| {
                entities[peer_index]
                    .as_object()
                    .map(|peer| same_system(state, station, peer))
            });
            let expected_warp = same_system_route.map(|same| !same);
            let waypoints = route.get("waypointStationIds").and_then(Value::as_array);
            let waypoints_valid = waypoints.is_some_and(|ids| {
                ids.iter().all(|value| {
                    value
                        .as_str()
                        .and_then(|id| indexes.get(id))
                        .and_then(|index| entities[*index].as_object())
                        .is_some_and(|entity| {
                            string_at(entity, "buildingId")
                                == Some("interstellar_logistics_station")
                        })
                })
            });
            let expected_warpers = if expected_warp == Some(true) {
                waypoints.map(Vec::len).unwrap_or(0) as f64 + 1.0
            } else {
                0.0
            };
            if string_at(route, "scope") != Some("remote")
                || expected_warp.is_none()
                || !owner_valid
                || string_at(route, "itemId").is_none_or(|id| !state.catalog.items.contains_key(id))
                || route.get("requiresWarp").and_then(Value::as_bool) != expected_warp
                || !waypoints_valid
                || (finite_number(route.get("warpersPerVessel")) - expected_warpers).abs() > EPSILON
            {
                return Ok(Some("interstellar-route-invalid"));
            }
        }
        let planet = planet(state, station);
        if planet.is_none_or(|planet| !system_unlocked(base, &planet.system_id)) {
            return Ok(Some("interstellar-system-locked"));
        }
    }
    Ok(None)
}

struct ReadyProbeEnvironment<P, E, C> {
    peer_matches: P,
    route_economics: E,
    station_capacity: C,
}

fn plan_ready_station_indices_with<P, E, C, L>(
    runtime: &DeterministicRuntime,
    base: &Map<String, Value>,
    entities: &[Value],
    station_indices: &[usize],
    ledger: &L,
    probes: ReadyProbeEnvironment<P, E, C>,
) -> anyhow::Result<Vec<Option<usize>>>
where
    P: Fn(usize, usize) -> anyhow::Result<Vec<(usize, usize)>> + Send + Sync,
    E: Fn(usize, usize, &Slot) -> anyhow::Result<Option<RouteEconomics>> + Send + Sync,
    C: Fn(usize, &Map<String, Value>, &Slot) -> anyhow::Result<f64> + Send + Sync,
    L: InterstellarLedgerView + ?Sized,
{
    runtime.indexed_try_map(
        station_indices,
        |_, station_index| -> anyhow::Result<Option<usize>> {
            let station_index = *station_index;
            let station = entities[station_index].as_object().expect("station object");
            if !is_legacy_interstellar_station(station) {
                return Ok(None);
            }
            if traditional_remote_disabled(station) {
                return Ok(None);
            }
            if ledger.is_active_remote_station(station_index) {
                return Ok(Some(station_index));
            }
            let station_slots = slots(station)?;
            for (slot_index, slot) in station_slots.iter().enumerate() {
                let Some(item_id) = slot.item_id.as_deref() else {
                    continue;
                };
                if slot.remote_mode == "storage" {
                    continue;
                }
                for (peer_index, peer_slot_index) in
                    (probes.peer_matches)(station_index, slot_index)?
                {
                    let peer = entities[peer_index].as_object().expect("station object");
                    let peer_slots = if string_at(peer, "buildingId") == Some("orbital_collector") {
                        vec![orbital_slot(peer)]
                    } else {
                        slots(peer)?
                    };
                    let (demand_index, demand_slot, supply_index, supply_slot) =
                        if slot.remote_mode == "demand" {
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
                    let Some(economics) =
                        (probes.route_economics)(supply_index, demand_index, demand_slot)?
                    else {
                        continue;
                    };
                    let available = (item_amount(supply, "outputs", item_id)
                        - supply_slot.min_stock)
                        .max(0.0)
                        .floor();
                    let free = ((probes.station_capacity)(demand_index, demand, demand_slot)?
                        - item_amount(demand, "outputs", item_id)
                        - ledger.in_flight(demand_index, item_id))
                    .max(0.0)
                    .floor();
                    for (owner_index, owner_slot) in
                        [(demand_index, demand_slot), (supply_index, supply_slot)]
                    {
                        let owner = entities[owner_index].as_object().expect("station object");
                        let has_vehicle =
                            installed_vessels(owner) - ledger.remote_busy(owner_index) > 0.0;
                        let warp_ready = !economics.requires_warp
                            || (completed_tech(base, "space_warp")
                                && owner
                                    .get("stationWarpEnabled")
                                    .and_then(Value::as_bool)
                                    .unwrap_or(false)
                                && finite_number(owner.get("stationWarpers"))
                                    >= economics.warpers_per_vessel);
                        let minimum = minimum_cargo(base, owner_slot);
                        if has_vehicle && warp_ready && available >= minimum && free >= minimum {
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
    // Preserve topology order at the merge boundary. The caller sorts the
    // combined local/remote set before power probes, so worker scheduling can
    // never affect the following simulation phase.
    for station_index in planned.into_iter().flatten() {
        ready.insert(station_index);
    }
    ready
}

pub(crate) fn ready_station_indices(
    state: &CoreState,
    base: &Map<String, Value>,
    entities: &[Value],
    peer_directory: &InterstellarPeerDirectory,
    route_activity: &mut InterstellarRouteActivity,
    route_ledger: &StationRouteLedger,
) -> anyhow::Result<HashSet<usize>> {
    ready_station_indices_with_scan(
        state,
        base,
        entities,
        peer_directory,
        route_activity,
        route_ledger,
    )
    .map(|(ready, _)| ready)
}

fn ready_station_indices_with_scan(
    state: &CoreState,
    base: &Map<String, Value>,
    entities: &[Value],
    peer_directory: &InterstellarPeerDirectory,
    route_activity: &mut InterstellarRouteActivity,
    route_ledger: &StationRouteLedger,
) -> anyhow::Result<(HashSet<usize>, InterstellarReadyStationScan)> {
    let station_indices = &state.factory_topology.station_indices;
    let (readiness_indices, scan) =
        route_activity.readiness_scan_indices(station_indices, peer_directory, route_ledger);
    let planned = plan_ready_station_indices_with(
        deterministic_runtime(),
        base,
        entities,
        &readiness_indices,
        route_ledger,
        ReadyProbeEnvironment {
            peer_matches: |station_index, slot_index| {
                if peer_directory.fallback_full_scan {
                    peer_matches_full_scan(state, base, entities, station_index, slot_index)
                } else {
                    peer_matches_indexed(
                        state,
                        base,
                        entities,
                        station_index,
                        slot_index,
                        peer_directory,
                    )
                    .map(|(matches, _)| matches)
                }
            },
            route_economics: |supply_index, demand_index, demand_slot: &Slot| {
                route_economics(
                    state,
                    base,
                    entities,
                    supply_index,
                    demand_index,
                    demand_slot,
                    (!peer_directory.fallback_full_scan)
                        .then_some(peer_directory.hub_station_indices.as_slice()),
                )
            },
            station_capacity: |_, demand: &Map<String, Value>, demand_slot: &Slot| {
                station_capacity(state, base, demand, demand_slot)
            },
        },
    )?;
    let ready = replay_ready_station_indices(planned.clone());
    route_activity.commit_readiness(&planned);
    Ok((ready, scan))
}

fn set_peer(entities: &mut [Value], index: usize, peer_id: &str) {
    if let Some(entity) = entities[index].as_object_mut() {
        entity.insert("stationPeerId".to_owned(), Value::from(peer_id));
    }
}

#[derive(Debug, Clone, Copy)]
struct DispatchDemandProbe {
    station_index: usize,
    dispatchable: bool,
    peer_candidate_rows_visited: usize,
    peer_full_scan_rows_visited: usize,
    directory_fallback: bool,
}

#[allow(clippy::too_many_arguments)]
fn probe_dispatch_demand<P: StationPowerLookup + ?Sized, L: InterstellarDispatchLedger + ?Sized>(
    state: &CoreState,
    base: &Map<String, Value>,
    entities: &[Value],
    powers: &P,
    demand_index: usize,
    peer_directory: &InterstellarPeerDirectory,
    ledger: &L,
) -> anyhow::Result<DispatchDemandProbe> {
    let mut probe = DispatchDemandProbe {
        station_index: demand_index,
        dispatchable: false,
        peer_candidate_rows_visited: 0,
        peer_full_scan_rows_visited: 0,
        directory_fallback: false,
    };
    let demand = entities[demand_index]
        .as_object()
        .ok_or_else(|| anyhow!("native interstellar demand is invalid"))?;
    if !is_legacy_interstellar_station(demand) || traditional_remote_disabled(demand) {
        return Ok(probe);
    }
    let mut ordered_slots = slots(demand)?
        .into_iter()
        .enumerate()
        .filter(|(_, slot)| slot.item_id.is_some() && slot.remote_mode == "demand")
        .collect::<Vec<_>>();
    ordered_slots.sort_by(|(left_index, left), (right_index, right)| {
        right
            .priority
            .cmp(&left.priority)
            .then_with(|| left_index.cmp(right_index))
    });
    for (slot_index, slot) in ordered_slots {
        let item_id = slot.item_id.as_deref().expect("demand item");
        let remaining_free = (station_capacity(state, base, demand, &slot)?
            - item_amount(demand, "outputs", item_id)
            - ledger.in_flight(demand_index, item_id)
            + EPSILON)
            .floor()
            .max(0.0);
        if remaining_free < 1.0 {
            continue;
        }
        let (matches, scan) = lookup_peer_matches(
            state,
            base,
            entities,
            demand_index,
            slot_index,
            Some(peer_directory),
        )?;
        probe.peer_candidate_rows_visited += scan.candidate_rows_visited;
        probe.peer_full_scan_rows_visited += scan.full_scan_rows_visited;
        probe.directory_fallback |= scan.used_full_scan;
        for (supply_index, peer_slot_index) in matches {
            let supply = entities[supply_index].as_object().expect("station object");
            let supply_is_orbital = string_at(supply, "buildingId") == Some("orbital_collector");
            let supply_slot = if supply_is_orbital {
                orbital_slot(supply)
            } else {
                slots(supply)?
                    .get(peer_slot_index)
                    .cloned()
                    .ok_or_else(|| anyhow!("native interstellar slot index is invalid"))?
            };
            let Some(economics) = route_economics(
                state,
                base,
                entities,
                supply_index,
                demand_index,
                &slot,
                (!scan.used_full_scan).then_some(peer_directory.hub_station_indices.as_slice()),
            )?
            else {
                continue;
            };
            if economics.requires_warp && !completed_tech(base, "space_warp") {
                continue;
            }
            let source_power = if supply_is_orbital {
                1.0
            } else {
                powers.get(&supply_index).copied().unwrap_or(0.0)
            };
            let target_power = powers.get(&demand_index).copied().unwrap_or(0.0);
            let hub_power = economics
                .waypoint_station_ids
                .iter()
                .filter_map(|id| state.entity_index.get(id))
                .fold(1.0_f64, |factor, index| {
                    factor.min(powers.get(index).copied().unwrap_or(0.0))
                });
            if source_power.min(target_power).min(hub_power) <= EPSILON {
                continue;
            }
            let available = (item_amount(supply, "outputs", item_id)
                - supply_slot.min_stock
                - ledger.reserved(supply_index, item_id)
                + EPSILON)
                .floor()
                .max(0.0);
            for (owner_index, owner_slot) in [(demand_index, &slot), (supply_index, &supply_slot)] {
                if supply_is_orbital && owner_index == supply_index {
                    continue;
                }
                let owner = entities[owner_index].as_object().expect("station object");
                let free_vehicles =
                    (installed_vessels(owner) - ledger.remote_busy(owner_index)).max(0.0);
                let warp_available = finite_number(owner.get("stationWarpers")).floor().max(0.0);
                if free_vehicles < 1.0
                    || (economics.requires_warp
                        && (!owner
                            .get("stationWarpEnabled")
                            .and_then(Value::as_bool)
                            .unwrap_or(false)
                            || warp_available < economics.warpers_per_vessel))
                {
                    continue;
                }
                let minimum = minimum_cargo(base, owner_slot);
                let mut dispatchable = free_vehicles
                    .min((available / minimum).floor())
                    .min((remaining_free / minimum).floor());
                if economics.requires_warp {
                    dispatchable = dispatchable
                        .min((warp_available / economics.warpers_per_vessel.max(1.0)).floor());
                }
                if dispatchable >= 1.0 {
                    probe.dispatchable = true;
                    return Ok(probe);
                }
            }
        }
    }
    Ok(probe)
}

#[allow(clippy::too_many_arguments)]
fn plan_dispatch_demand_indices_with<
    P: StationPowerLookup + Sync + ?Sized,
    L: InterstellarDispatchLedger + ?Sized,
>(
    runtime: &DeterministicRuntime,
    state: &CoreState,
    base: &Map<String, Value>,
    entities: &[Value],
    powers: &P,
    route_activity: &mut InterstellarRouteActivity,
    peer_directory: &InterstellarPeerDirectory,
    ledger: &L,
) -> anyhow::Result<(Vec<usize>, InterstellarDispatchScan)> {
    let (demand_rows, dense_fallback) = if peer_directory.fallback_full_scan {
        (state.factory_topology.station_indices.clone(), false)
    } else {
        route_activity.take_dispatch_probe_indices(peer_directory)
    };
    let probes = runtime.indexed_try_map(&demand_rows, |_, demand_index| {
        probe_dispatch_demand(
            state,
            base,
            entities,
            powers,
            *demand_index,
            peer_directory,
            ledger,
        )
    })?;
    let peer_candidate_rows_visited = probes
        .iter()
        .map(|probe| probe.peer_candidate_rows_visited)
        .sum();
    let peer_full_scan_rows_visited = probes
        .iter()
        .map(|probe| probe.peer_full_scan_rows_visited)
        .sum();
    let directory_fallback = probes.iter().any(|probe| probe.directory_fallback);
    let selected = probes
        .into_iter()
        .filter_map(|probe| probe.dispatchable.then_some(probe.station_index))
        .collect::<Vec<_>>();
    let total_demand_rows = if peer_directory.fallback_full_scan {
        peer_directory.total_station_rows
    } else {
        peer_directory.demand_station_indices.len()
    };
    let demand_rows_probed = demand_rows.len();
    let selected_demands = selected.len();
    Ok((
        selected,
        InterstellarDispatchScan {
            selected_demands,
            total_demand_rows,
            demand_rows_probed,
            dense_fallback,
            peer_candidate_rows_visited,
            peer_full_scan_rows_visited,
            directory_fallback,
        },
    ))
}

#[allow(clippy::too_many_arguments)]
fn dispatch_with_ledger_mode<
    P: StationPowerLookup + Sync + ?Sized,
    L: InterstellarDispatchLedger + ?Sized,
>(
    runtime: &DeterministicRuntime,
    state: &CoreState,
    base: &mut Map<String, Value>,
    entities: &mut [Value],
    powers: &P,
    route_activity: &mut InterstellarRouteActivity,
    peer_directory: &InterstellarPeerDirectory,
    ledger: &mut L,
    force_full_scan: bool,
) -> anyhow::Result<InterstellarDispatchScan> {
    let station_indices = &state.factory_topology.station_indices;
    if !station_indices.iter().copied().any(|index| {
        entities[index].as_object().is_some_and(|station| {
            is_legacy_interstellar_station(station) && !traditional_remote_disabled(station)
        })
    }) {
        return Ok(InterstellarDispatchScan::default());
    }
    let (dispatch_demand_indices, mut dispatch_scan) = if force_full_scan {
        (
            station_indices.to_vec(),
            InterstellarDispatchScan {
                selected_demands: station_indices.len(),
                total_demand_rows: station_indices.len(),
                demand_rows_probed: station_indices.len(),
                directory_fallback: true,
                ..InterstellarDispatchScan::default()
            },
        )
    } else {
        plan_dispatch_demand_indices_with(
            runtime,
            state,
            base,
            entities,
            powers,
            route_activity,
            peer_directory,
            ledger,
        )?
    };
    let indexes = &state.entity_index;
    let mut activated_remote_demands = Vec::new();
    for demand_index in dispatch_demand_indices {
        let demand_snapshot = entities[demand_index]
            .as_object()
            .ok_or_else(|| anyhow!("native interstellar demand is invalid"))?
            .clone();
        if !is_legacy_interstellar_station(&demand_snapshot) {
            continue;
        }
        if traditional_remote_disabled(&demand_snapshot) {
            continue;
        }
        let demand_slots = slots(&demand_snapshot)?;
        let mut ordered_slots = demand_slots
            .iter()
            .enumerate()
            .filter(|(_, slot)| slot.item_id.is_some() && slot.remote_mode == "demand")
            .map(|(index, slot)| (index, slot.clone()))
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
        let cursor = finite_number(demand_snapshot.get("stationDispatchCursor"))
            .floor()
            .max(0.0) as usize;
        for offset in 0..ordered_slots.len() {
            let (slot_index, slot) = &ordered_slots[(cursor + offset) % ordered_slots.len()];
            let item_id = slot.item_id.as_deref().expect("demand item").to_owned();
            let fairness_key = format!("remote:{slot_index}");
            let last_peer_id = demand_snapshot
                .get("stationLastSupplyPeerBySlot")
                .and_then(Value::as_object)
                .and_then(|values| values.get(&fairness_key))
                .and_then(Value::as_str)
                .map(str::to_owned);
            let (mut matches, peer_scan) = lookup_peer_matches(
                state,
                base,
                entities,
                demand_index,
                *slot_index,
                (!force_full_scan).then_some(peer_directory),
            )?;
            dispatch_scan.peer_candidate_rows_visited += peer_scan.candidate_rows_visited;
            dispatch_scan.peer_full_scan_rows_visited += peer_scan.full_scan_rows_visited;
            dispatch_scan.directory_fallback |= peer_scan.used_full_scan;
            matches.sort_by(|(left_index, left_slot), (right_index, right_slot)| {
                let left = entities[*left_index].as_object().expect("station object");
                let right = entities[*right_index].as_object().expect("station object");
                let left_priority = if string_at(left, "buildingId") == Some("orbital_collector") {
                    1
                } else {
                    slots(left)
                        .ok()
                        .and_then(|values| values.get(*left_slot).map(|slot| slot.priority))
                        .unwrap_or(1)
                };
                let right_priority = if string_at(right, "buildingId") == Some("orbital_collector")
                {
                    1
                } else {
                    slots(right)
                        .ok()
                        .and_then(|values| values.get(*right_slot).map(|slot| slot.priority))
                        .unwrap_or(1)
                };
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
            let mut remaining_free = (station_capacity(state, base, demand_now, slot)?
                - item_amount(demand_now, "outputs", &item_id)
                - ledger.in_flight(demand_index, &item_id)
                + EPSILON)
                .floor()
                .max(0.0);
            for (supply_index, peer_slot_index) in matches {
                if remaining_free < 1.0 {
                    break;
                }
                let supply_snapshot = entities[supply_index]
                    .as_object()
                    .expect("station object")
                    .clone();
                let supply_is_orbital =
                    string_at(&supply_snapshot, "buildingId") == Some("orbital_collector");
                let supply_slot = if supply_is_orbital {
                    orbital_slot(&supply_snapshot)
                } else {
                    slots(&supply_snapshot)?[peer_slot_index].clone()
                };
                let Some(economics) = route_economics(
                    state,
                    base,
                    entities,
                    supply_index,
                    demand_index,
                    slot,
                    (!force_full_scan && !peer_scan.used_full_scan)
                        .then_some(peer_directory.hub_station_indices.as_slice()),
                )?
                else {
                    continue;
                };
                if economics.requires_warp && !completed_tech(base, "space_warp") {
                    continue;
                }
                let source_power = if supply_is_orbital {
                    1.0
                } else {
                    powers.get(&supply_index).copied().unwrap_or(0.0)
                };
                let target_power = powers.get(&demand_index).copied().unwrap_or(0.0);
                let hub_power = economics
                    .waypoint_station_ids
                    .iter()
                    .filter_map(|id| indexes.get(id))
                    .fold(1.0_f64, |factor, index| {
                        factor.min(powers.get(index).copied().unwrap_or(0.0))
                    });
                let power_factor = source_power.min(target_power).min(hub_power);
                let mut vehicle_owners = vec![(demand_index, slot.clone())];
                if !supply_is_orbital {
                    vehicle_owners.push((supply_index, supply_slot.clone()));
                }
                for (owner_index, owner_slot) in vehicle_owners {
                    let owner = entities[owner_index].as_object().expect("station object");
                    let free_vehicles =
                        (installed_vessels(owner) - ledger.remote_busy(owner_index)).max(0.0);
                    let warp_available =
                        finite_number(owner.get("stationWarpers")).floor().max(0.0);
                    if free_vehicles < 1.0
                        || power_factor <= EPSILON
                        || (economics.requires_warp
                            && (!owner
                                .get("stationWarpEnabled")
                                .and_then(Value::as_bool)
                                .unwrap_or(false)
                                || warp_available < economics.warpers_per_vessel))
                    {
                        continue;
                    }
                    let available = (item_amount(&supply_snapshot, "outputs", &item_id)
                        - supply_slot.min_stock
                        - ledger.reserved(supply_index, &item_id)
                        + EPSILON)
                        .floor()
                        .max(0.0);
                    let minimum = minimum_cargo(base, &owner_slot);
                    let mut dispatchable = free_vehicles
                        .min((available / minimum).floor())
                        .min((remaining_free / minimum).floor());
                    if economics.requires_warp {
                        dispatchable = dispatchable
                            .min((warp_available / economics.warpers_per_vessel.max(1.0)).floor());
                    }
                    if dispatchable < 1.0 {
                        continue;
                    }
                    let cargo = available
                        .min(remaining_free)
                        .min(cargo_capacity(base) * dispatchable);
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
                    let demand_id = string_at(
                        entities[demand_index].as_object().expect("station object"),
                        "id",
                    )
                    .unwrap_or_default()
                    .to_owned();
                    let supply_id = string_at(&supply_snapshot, "id")
                        .unwrap_or_default()
                        .to_owned();
                    let owner_id = string_at(owner, "id").unwrap_or_default().to_owned();
                    let route = json!({
                        "id": format!("route_{}", next_id as u64),
                        "slotIndex": *slot_index,
                        "peerId": supply_id,
                        "itemId": item_id,
                        "scope": "remote",
                        "cargo": cargo,
                        "vehicleCount": dispatchable,
                        "progress": initial_progress,
                        "duration": economics.duration,
                        "requiresWarp": economics.requires_warp,
                        "waypointStationIds": economics.waypoint_station_ids.clone(),
                        "distanceLy": economics.distance_ly,
                        "warpersPerVessel": economics.warpers_per_vessel,
                        "vehicleStationId": owner_id,
                    });
                    entities[demand_index]
                        .as_object_mut()
                        .and_then(|entity| entity.get_mut("stationRoutes"))
                        .and_then(Value::as_array_mut)
                        .ok_or_else(|| anyhow!("native interstellar demand routes are missing"))?
                        .push(route);
                    activated_remote_demands.push(demand_index);
                    let waypoint_indices = economics
                        .waypoint_station_ids
                        .iter()
                        .filter_map(|waypoint| indexes.get(waypoint).copied())
                        .collect::<Vec<_>>();
                    ledger.record_dispatch(
                        demand_index,
                        supply_index,
                        owner_index,
                        &waypoint_indices,
                        &item_id,
                        cargo,
                        dispatchable,
                        initial_progress,
                    );
                    // A remote dispatch can consume the owner's loaded
                    // warpers and immediately reserves the source output.
                    // Wake both rows for the post-dispatch refill boundary;
                    // insertion is rank ordered and de-duplicated.
                    route_activity.wake_warper_refill_station(owner_index);
                    route_activity.wake_warper_refill_station(supply_index);
                    remaining_free = (remaining_free - cargo).max(0.0);
                    set_number(base, "nextId", next_id + 1.0)?;
                    if economics.requires_warp {
                        let owner = entities[owner_index]
                            .as_object_mut()
                            .expect("station object");
                        set_number(
                            owner,
                            "stationWarpers",
                            warp_available - dispatchable * economics.warpers_per_vessel,
                        )?;
                    }
                    {
                        let demand = entities[demand_index]
                            .as_object_mut()
                            .expect("station object");
                        set_number(
                            demand,
                            "stationProgress",
                            finite_number(demand.get("stationProgress")).max(initial_progress),
                        )?;
                        set_number(demand, "stationDispatchCursor", *slot_index as f64 + 1.0)?;
                        demand
                            .get_mut("stationLastSupplyPeerBySlot")
                            .and_then(Value::as_object_mut)
                            .ok_or_else(|| {
                                anyhow!("native interstellar fairness record is missing")
                            })?
                            .insert(fairness_key.clone(), Value::from(supply_id.clone()));
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
    activated_remote_demands.sort_unstable();
    activated_remote_demands.dedup();
    for demand_index in activated_remote_demands {
        route_activity.update_remote_demand(demand_index, true);
        route_activity
            .transition_route_view
            .refresh_demand(entities, demand_index);
    }
    Ok(dispatch_scan)
}

fn dispatch_with_ledger<
    P: StationPowerLookup + Sync + ?Sized,
    L: InterstellarDispatchLedger + ?Sized,
>(
    state: &CoreState,
    base: &mut Map<String, Value>,
    entities: &mut [Value],
    powers: &P,
    route_activity: &mut InterstellarRouteActivity,
    peer_directory: &InterstellarPeerDirectory,
    ledger: &mut L,
) -> anyhow::Result<InterstellarDispatchScan> {
    dispatch_with_ledger_mode(
        deterministic_runtime(),
        state,
        base,
        entities,
        powers,
        route_activity,
        peer_directory,
        ledger,
        false,
    )
}

#[cfg(test)]
fn dispatch_full_scan_oracle<
    P: StationPowerLookup + Sync + ?Sized,
    L: InterstellarDispatchLedger + ?Sized,
>(
    state: &CoreState,
    base: &mut Map<String, Value>,
    entities: &mut [Value],
    powers: &P,
    route_activity: &mut InterstellarRouteActivity,
    peer_directory: &InterstellarPeerDirectory,
    ledger: &mut L,
) -> anyhow::Result<InterstellarDispatchScan> {
    dispatch_with_ledger_mode(
        deterministic_runtime(),
        state,
        base,
        entities,
        powers,
        route_activity,
        peer_directory,
        ledger,
        true,
    )
}

pub(crate) fn dispatch<P: StationPowerLookup + Sync + ?Sized>(
    state: &CoreState,
    base: &mut Map<String, Value>,
    entities: &mut [Value],
    powers: &P,
    route_activity: &mut InterstellarRouteActivity,
    peer_directory: &InterstellarPeerDirectory,
    route_ledger: &mut StationRouteLedger,
) -> anyhow::Result<InterstellarDispatchScan> {
    dispatch_with_ledger(
        state,
        base,
        entities,
        powers,
        route_activity,
        peer_directory,
        route_ledger,
    )
}

fn add_max_field(
    entities: &mut [Value],
    index: usize,
    key: &str,
    value: f64,
) -> anyhow::Result<()> {
    let entity = entities[index]
        .as_object_mut()
        .ok_or_else(|| anyhow!("native interstellar station is invalid"))?;
    set_number(entity, key, finite_number(entity.get(key)).max(value))
}

struct InterstellarRouteAdvanceOutcome {
    activity_updates: Vec<(usize, bool)>,
    changed_station_indices: Vec<usize>,
}

fn advance_routes_for_indices<I: EntityIndexLookup + ?Sized, P: StationPowerLookup + ?Sized>(
    entities: &mut [Value],
    seconds: f64,
    powers: &P,
    indexes: &I,
    route_scan_indices: &[usize],
) -> anyhow::Result<InterstellarRouteAdvanceOutcome> {
    let mut activity_updates = Vec::with_capacity(route_scan_indices.len());
    let mut changed_station_indices = Vec::new();
    for &demand_index in route_scan_indices {
        let demand_snapshot = entities[demand_index]
            .as_object()
            .ok_or_else(|| anyhow!("native interstellar demand is invalid"))?
            .clone();
        let has_remote_route = demand_snapshot
            .get("stationRoutes")
            .and_then(Value::as_array)
            .is_some_and(|routes| {
                routes
                    .iter()
                    .filter_map(Value::as_object)
                    .any(|route| string_at(route, "scope") == Some("remote"))
            });
        if !has_remote_route {
            activity_updates.push((demand_index, false));
            continue;
        }
        let routes = entities[demand_index]
            .as_object_mut()
            .and_then(|demand| demand.get_mut("stationRoutes"))
            .and_then(Value::as_array_mut)
            .map(std::mem::take)
            .ok_or_else(|| anyhow!("native interstellar demand routes are missing"))?;
        let mut remaining = Vec::new();
        let mut completed_cargo = 0.0;
        for mut route_value in routes {
            let route = route_value
                .as_object_mut()
                .ok_or_else(|| anyhow!("native interstellar route is invalid"))?;
            if string_at(route, "scope") != Some("remote") {
                remaining.push(route_value);
                continue;
            }
            let supply_index = string_at(route, "peerId")
                .and_then(|id| indexes.get(id))
                .copied()
                .ok_or_else(|| anyhow!("native interstellar route peer is missing"))?;
            let owner_index = string_at(route, "vehicleStationId")
                .and_then(|id| indexes.get(id))
                .copied()
                .unwrap_or(demand_index);
            let waypoint_indices = route
                .get("waypointStationIds")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .filter_map(|id| indexes.get(id).copied())
                .collect::<Vec<_>>();
            let source_power = if entities[supply_index]
                .as_object()
                .is_some_and(|entity| string_at(entity, "buildingId") == Some("orbital_collector"))
            {
                1.0
            } else {
                powers.get(&supply_index).copied().unwrap_or(0.0)
            };
            let target_power = powers.get(&demand_index).copied().unwrap_or(0.0);
            let hub_power = waypoint_indices.iter().fold(1.0_f64, |factor, index| {
                factor.min(powers.get(index).copied().unwrap_or(0.0))
            });
            let power = source_power.min(target_power).min(hub_power);
            let duration = finite_number(route.get("duration")).max(1.0);
            let progress = rounded(
                finite_number(route.get("progress")) + seconds * power / duration,
                6,
            );
            set_number(route, "progress", progress)?;
            add_max_field(entities, demand_index, "utilization", power)?;
            add_max_field(entities, supply_index, "utilization", power)?;
            for &waypoint_index in &waypoint_indices {
                add_max_field(entities, waypoint_index, "utilization", power)?;
            }
            if progress + EPSILON < 1.0 {
                remaining.push(route_value);
                continue;
            }
            let item_id = string_at(route, "itemId").unwrap_or_default().to_owned();
            let cargo = finite_number(route.get("cargo")).floor().max(0.0);
            let vehicles = finite_number(route.get("vehicleCount")).floor().max(0.0);
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
                (supply_current - cargo).max(0.0).floor(),
            )?;
            for index in [demand_index, supply_index] {
                let station = entities[index].as_object_mut().expect("station object");
                let trips = finite_number(station.get("stationTrips"));
                set_number(station, "stationTrips", (trips + vehicles).floor())?;
                set_number(station, "stationLastTransfer", cargo)?;
            }
            changed_station_indices.extend([demand_index, supply_index, owner_index]);
            changed_station_indices.extend(waypoint_indices.iter().copied());
            completed_cargo += cargo;
        }
        let demand = entities[demand_index]
            .as_object_mut()
            .expect("station object");
        let has_remote_route = remaining
            .iter()
            .filter_map(Value::as_object)
            .any(|route| string_at(route, "scope") == Some("remote"));
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
        activity_updates.push((demand_index, has_remote_route));
    }
    changed_station_indices.sort_unstable();
    changed_station_indices.dedup();
    Ok(InterstellarRouteAdvanceOutcome {
        activity_updates,
        changed_station_indices,
    })
}

fn advance_routes_with_activity<I: EntityIndexLookup + ?Sized, P: StationPowerLookup + ?Sized>(
    entities: &mut [Value],
    seconds: f64,
    powers: &P,
    indexes: &I,
    route_activity: &mut InterstellarRouteActivity,
) -> anyhow::Result<Vec<usize>> {
    if !route_activity.has_remote_routes() {
        return Ok(Vec::new());
    }
    let (route_scan_indices, _dense_fallback) = route_activity.route_scan_indices();
    let outcome =
        advance_routes_for_indices(entities, seconds, powers, indexes, &route_scan_indices)?;
    for &(demand_index, _) in &outcome.activity_updates {
        route_activity
            .transition_route_view
            .refresh_demand(entities, demand_index);
    }
    route_activity.replace_scanned_activity(&outcome.activity_updates);
    Ok(outcome.changed_station_indices)
}

pub(crate) fn advance_routes<P: StationPowerLookup + ?Sized>(
    state: &CoreState,
    entities: &mut [Value],
    seconds: f64,
    powers: &P,
    route_activity: &mut InterstellarRouteActivity,
) -> anyhow::Result<Vec<usize>> {
    advance_routes_with_activity(
        entities,
        seconds,
        powers,
        &state.entity_index,
        route_activity,
    )
}

#[cfg(test)]
fn build_local_supply_directory(
    entities: &[Value],
    station_indices: &[usize],
) -> LocalSupplyDirectory {
    let mut directory = LocalSupplyDirectory::default();
    for &station_index in station_indices {
        let Some(station) = entities.get(station_index).and_then(Value::as_object) else {
            continue;
        };
        let building = string_at(station, "buildingId");
        if !matches!(building, Some("interstellar_logistics_station"))
            || (finite_number(station.get("stationTier")).floor() == 2.0
                && string_at(station, "stationOperationMode") == Some("elevator"))
        {
            continue;
        }
        let planet_id = string_at(station, "planetId").unwrap_or_default();
        for slot in station
            .get("stationSlots")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_object)
        {
            if string_at(slot, "localMode") != Some("supply") {
                continue;
            }
            let Some(item_id) = string_at(slot, "itemId") else {
                continue;
            };
            if !directory.by_planet_item.contains_key(planet_id) {
                directory
                    .by_planet_item
                    .insert(planet_id.to_owned(), HashMap::new());
            }
            let items = directory
                .by_planet_item
                .get_mut(planet_id)
                .expect("inserted native local supply planet");
            if !items.contains_key(item_id) {
                items.insert(item_id.to_owned(), Vec::new());
            }
            let stations = items
                .get_mut(item_id)
                .expect("inserted native local supply item");
            if stations.last().copied() != Some(station_index) {
                stations.push(station_index);
            }
        }
    }
    directory
}

#[cfg(test)]
fn local_peer_exists(
    directory: &LocalSupplyDirectory,
    entities: &[Value],
    station_index: usize,
    slot_index: usize,
) -> anyhow::Result<bool> {
    let station = entities[station_index].as_object().expect("station object");
    let station_slot = station
        .get("stationSlots")
        .and_then(Value::as_array)
        .and_then(|slots| slots.get(slot_index))
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("native interstellar slot index is invalid"))?;
    let Some(item_id) = string_at(station_slot, "itemId") else {
        return Ok(false);
    };
    let local_mode = string_at(station_slot, "localMode").unwrap_or("storage");
    if local_mode != "demand" {
        return Ok(false);
    }
    let planet_id = string_at(station, "planetId").unwrap_or_default();
    Ok(directory
        .by_planet_item
        .get(planet_id)
        .and_then(|items| items.get(item_id))
        .is_some_and(|stations| stations.iter().any(|&peer| peer != station_index)))
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct CongestionUpdate {
    station_index: usize,
    congestion: f64,
    active_progress: f64,
}

#[cfg(test)]
fn plan_congestion_updates_with<F, L>(
    runtime: &DeterministicRuntime,
    entities: &[Value],
    station_indices: &[usize],
    ledger: &L,
    local_supply_directory: &LocalSupplyDirectory,
    remote_peer_waiting: F,
) -> anyhow::Result<Vec<Option<CongestionUpdate>>>
where
    F: Fn(usize, usize, &Slot) -> anyhow::Result<bool> + Send + Sync,
    L: InterstellarLedgerView + ?Sized,
{
    runtime.indexed_try_map(
        station_indices,
        |_, station_index| -> anyhow::Result<Option<CongestionUpdate>> {
            let station_index = *station_index;
            let station = entities[station_index].as_object().expect("station object");
            if !is_legacy_interstellar_station(station) {
                return Ok(None);
            }
            if traditional_remote_disabled(station) {
                return Ok(None);
            }
            let station_slots = slots(station)?;
            let mut waiting = 0.0;
            for (slot_index, slot) in station_slots.iter().enumerate() {
                if slot.item_id.is_none() {
                    continue;
                }
                let remote_waiting = slot.remote_mode == "demand"
                    && remote_peer_waiting(station_index, slot_index, slot)?;
                if remote_waiting
                    || local_peer_exists(
                        local_supply_directory,
                        entities,
                        station_index,
                        slot_index,
                    )?
                {
                    waiting += 1.0;
                }
            }
            let installed = 50.0 * finite_number(station.get("machineCount")).floor().max(0.0)
                + vessel_capacity(station);
            let local_busy = ledger.local_busy(station_index);
            let busy = local_busy + ledger.remote_busy(station_index);
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
            let active_progress = ledger.active_progress(station_index);
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
    // Keep replay serial and in topology order. Interstellar intentionally
    // runs after local congestion and therefore remains the final writer for
    // shared station fields without making JSON/MOD key order scheduler-bound.
    for update in updates.into_iter().flatten() {
        let target = entities[update.station_index]
            .as_object_mut()
            .expect("station object");
        set_number(target, "stationCongestion", update.congestion)?;
        set_number(target, "stationProgress", update.active_progress)?;
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct InterstellarCongestionScan {
    pub selected_station_rows: usize,
    pub total_station_rows: usize,
    pub dense_fallback: bool,
    pub directory_fallback: bool,
}

fn select_congestion_station_indices(
    all_station_indices: &[usize],
    local_directory: &crate::local_logistics::LocalPeerDirectory,
    peer_directory: &InterstellarPeerDirectory,
    route_ledger: &StationRouteLedger,
) -> (Vec<usize>, InterstellarCongestionScan) {
    let mut selected = local_directory.local_waiting_station_indices().to_vec();
    selected.extend_from_slice(peer_directory.congestion_demand_station_indices());
    selected.extend_from_slice(local_directory.interstellar_congestion_reset_station_indices());
    selected.extend(route_ledger.active_station_indices());
    selected.sort_unstable();
    selected.dedup();
    selected.retain(|index| all_station_indices.binary_search(index).is_ok());
    let directory_fallback = peer_directory.congestion_requires_full_scan();
    let dense_fallback = !directory_fallback
        && !selected.is_empty()
        && selected
            .len()
            .saturating_mul(INTERSTELLAR_CONGESTION_DENSE_DENOMINATOR)
            >= all_station_indices
                .len()
                .saturating_mul(INTERSTELLAR_CONGESTION_DENSE_NUMERATOR);
    if directory_fallback || dense_fallback {
        selected.clear();
        selected.extend_from_slice(all_station_indices);
    }
    let scan = InterstellarCongestionScan {
        selected_station_rows: selected.len(),
        total_station_rows: all_station_indices.len(),
        dense_fallback,
        directory_fallback,
    };
    (selected, scan)
}

#[allow(clippy::too_many_arguments)]
fn plan_indexed_congestion_updates(
    runtime: &DeterministicRuntime,
    state: &CoreState,
    base: &Map<String, Value>,
    entities: &[Value],
    station_indices: &[usize],
    ledger: &StationRouteLedger,
    local_directory: &crate::local_logistics::LocalPeerDirectory,
    peer_directory: &InterstellarPeerDirectory,
) -> anyhow::Result<Vec<Option<CongestionUpdate>>> {
    runtime.indexed_try_map(
        station_indices,
        |_, station_index| -> anyhow::Result<Option<CongestionUpdate>> {
            let station_index = *station_index;
            let station = entities[station_index].as_object().expect("station object");
            if !is_legacy_interstellar_station(station) || traditional_remote_disabled(station) {
                return Ok(None);
            }
            let station_slots = slots(station)?;
            let mut waiting = 0.0;
            for (slot_index, slot) in station_slots.iter().enumerate() {
                if slot.item_id.is_none() {
                    continue;
                }
                let remote_waiting = slot.remote_mode == "demand"
                    && !peer_matches_indexed(
                        state,
                        base,
                        entities,
                        station_index,
                        slot_index,
                        peer_directory,
                    )?
                    .0
                    .is_empty();
                if remote_waiting
                    || local_directory.has_local_peer_match(station_index, slot_index)?
                {
                    waiting += 1.0;
                }
            }
            let installed = 50.0 * finite_number(station.get("machineCount")).floor().max(0.0)
                + vessel_capacity(station);
            let busy = ledger.local_busy(station_index) + ledger.remote_busy(station_index);
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
                active_progress: ledger.active_progress(station_index),
            }))
        },
    )
}

pub(crate) fn update_congestion(
    state: &CoreState,
    base: &Map<String, Value>,
    entities: &mut [Value],
    local_directory: &mut crate::local_logistics::LocalPeerDirectory,
    peer_directory: &InterstellarPeerDirectory,
    route_ledger: &StationRouteLedger,
) -> anyhow::Result<InterstellarCongestionScan> {
    let station_indices = &state.factory_topology.station_indices;
    let (selected_indices, scan) = select_congestion_station_indices(
        station_indices,
        local_directory,
        peer_directory,
        route_ledger,
    );
    let updates = plan_indexed_congestion_updates(
        deterministic_runtime(),
        state,
        base,
        entities,
        &selected_indices,
        route_ledger,
        local_directory,
        peer_directory,
    )?;
    apply_congestion_updates(entities, updates)?;
    let mut next_reset = route_ledger.active_station_indices();
    next_reset.retain(|index| station_indices.binary_search(index).is_ok());
    local_directory.replace_interstellar_congestion_reset_station_indices(next_reset);
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

    #[derive(Clone, Copy)]
    struct Lcg(u64);

    impl Lcg {
        fn next(&mut self) -> u64 {
            self.0 = self
                .0
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            self.0
        }

        fn pick(&mut self, upper: usize) -> usize {
            (self.next() as usize) % upper
        }
    }

    fn random_slot(rng: &mut Lcg, slot_index: usize) -> Value {
        let item = [None, Some("iron_ingot"), Some("copper_ingot")][rng.pick(3)];
        let local_mode = ["storage", "supply", "demand"][rng.pick(3)];
        let remote_mode = ["storage", "supply", "demand"][rng.pick(3)];
        let minimum_load = [0.1, 0.25, 0.5, 1.0][rng.pick(4)];
        json!({
            "itemId": item,
            "localMode": local_mode,
            "remoteMode": remote_mode,
            "minimumLoad": minimum_load,
            "minStock": rng.pick(8),
            "maxStock": 1000,
            "priority": rng.pick(3),
            "routePolicy": "relay-preferred",
            "warperBudget": 1,
            "modSlotPayload": { "slot": slot_index, "unknown": [1, 2, 3] },
        })
    }

    fn random_entities(seed: u64) -> Vec<Value> {
        let mut rng = Lcg(seed ^ 0x9e37_79b9_7f4a_7c15);
        let station_count = 4 + rng.pick(13);
        let mut entities = Vec::with_capacity(station_count + 2);
        for index in 0..station_count {
            let building = match rng.pick(7) {
                0 => "orbital_collector",
                1 => "planetary_logistics_station",
                _ => "interstellar_logistics_station",
            };
            let mut routes = Vec::new();
            for route_index in 0..rng.pick(5) {
                let peer = if rng.pick(5) == 0 {
                    "unknown-peer".to_owned()
                } else {
                    format!("station_{}", rng.pick(station_count))
                };
                let owner = if rng.pick(4) == 0 {
                    None
                } else if rng.pick(5) == 0 {
                    Some("unknown-owner".to_owned())
                } else {
                    Some(format!("station_{}", rng.pick(station_count)))
                };
                let scope = [Some("local"), Some("remote"), Some("mod-scope"), None][rng.pick(4)];
                let item_id = ["", "iron_ingot", "copper_ingot"][rng.pick(3)];
                let cargo = [0.0, 1.0, 10.75, -2.0][rng.pick(4)];
                let vehicle_count = [0.0, 1.0, 2.75, -1.0][rng.pick(4)];
                let progress = [0.0, 0.25, 0.75, 1.0][rng.pick(4)];
                let mut route = json!({
                    "id": format!("route_{index}_{route_index}"),
                    "peerId": peer,
                    "itemId": item_id,
                    "cargo": cargo,
                    "vehicleCount": vehicle_count,
                    "progress": progress,
                    "waypointStationIds": [
                        format!("station_{}", rng.pick(station_count)),
                        format!("station_{}", rng.pick(station_count)),
                        "unknown-waypoint",
                    ],
                    "modRoutePayload": { "nested": { "value": route_index } },
                });
                let route = route.as_object_mut().expect("random route object");
                if let Some(scope) = scope {
                    route.insert("scope".to_owned(), Value::from(scope));
                }
                if let Some(owner) = owner {
                    route.insert("vehicleStationId".to_owned(), Value::from(owner));
                }
                routes.push(Value::Object(route.clone()));
            }
            let slots = (0..SLOT_COUNT)
                .map(|slot| random_slot(&mut rng, slot))
                .collect::<Vec<_>>();
            entities.push(json!({
                "id": format!("station_{index}"),
                "kind": "station",
                "buildingId": building,
                "planetId": format!("planet_{}", rng.pick(4)),
                "stationTier": if rng.pick(7) == 0 { 2 } else { 1 },
                "stationOperationMode": if rng.pick(7) == 0 { "elevator" } else { "legacy" },
                "stationSlots": slots,
                "stationRoutes": routes,
                "modStationPayload": { "preserve": true, "values": [seed, index as u64] },
            }));
        }
        entities.push(json!({
            "id": "machine_with_mod_route",
            "kind": "machine",
            "buildingId": "assembler_mk1",
            "stationRoutes": [{
                "scope": "mod-scope",
                "peerId": "station_0",
                "progress": 0.875,
                "waypointStationIds": ["station_1", "station_1"],
                "modOnly": true,
            }],
        }));
        entities
    }

    fn indexes(entities: &[Value]) -> HashMap<String, usize> {
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

    fn route_touches_station(
        demand_index: usize,
        demand: &Map<String, Value>,
        route: &Map<String, Value>,
        indexes: &HashMap<String, usize>,
        station_index: usize,
    ) -> bool {
        let supply = string_at(route, "peerId")
            .and_then(|id| indexes.get(id))
            .copied();
        let owner = indexes
            .get(route_owner_id(demand, route))
            .copied()
            .unwrap_or(demand_index);
        let waypoint = route
            .get("waypointStationIds")
            .and_then(Value::as_array)
            .is_some_and(|ids| {
                ids.iter()
                    .filter_map(Value::as_str)
                    .any(|id| indexes.get(id).copied() == Some(station_index))
            });
        demand_index == station_index
            || supply == Some(station_index)
            || owner == station_index
            || waypoint
    }

    fn legacy_local_peer_exists(
        entities: &[Value],
        legacy_station_indices: &[usize],
        station_index: usize,
        slot_index: usize,
    ) -> bool {
        let station = entities[station_index].as_object().expect("station object");
        let Some(station_slot) = station
            .get("stationSlots")
            .and_then(Value::as_array)
            .and_then(|slots| slots.get(slot_index))
            .and_then(Value::as_object)
        else {
            return false;
        };
        let Some(item_id) = string_at(station_slot, "itemId") else {
            return false;
        };
        if string_at(station_slot, "localMode").unwrap_or("storage") != "demand" {
            return false;
        }
        legacy_station_indices.iter().copied().any(|peer_index| {
            if peer_index == station_index {
                return false;
            }
            let peer = entities[peer_index].as_object().expect("station object");
            if string_at(peer, "planetId") != string_at(station, "planetId")
                || !matches!(
                    string_at(peer, "buildingId"),
                    Some("planetary_logistics_station" | "interstellar_logistics_station")
                )
            {
                return false;
            }
            peer.get("stationSlots")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_object)
                .any(|peer_slot| {
                    string_at(peer_slot, "itemId") == Some(item_id)
                        && string_at(peer_slot, "localMode") == Some("supply")
                })
        })
    }

    #[test]
    fn single_pass_route_ledger_matches_nested_scan_oracle_for_2048_random_states() {
        for seed in 0..2048_u64 {
            let entities = random_entities(seed);
            let original = entities.clone();
            let indexes = indexes(&entities);
            let ledger = build_ledger(&entities, &indexes);
            let items = ["", "iron_ingot", "copper_ingot"];
            for station_index in 0..entities.len() {
                let mut expected_remote_busy = 0.0;
                let mut expected_local_busy = 0.0;
                let mut expected_active_load = 0.0;
                let mut expected_progress = 0.0_f64;
                let mut expected_remote_active = false;
                for (demand_index, demand) in entities
                    .iter()
                    .enumerate()
                    .filter_map(|(index, value)| value.as_object().map(|object| (index, object)))
                {
                    for route in demand
                        .get("stationRoutes")
                        .and_then(Value::as_array)
                        .into_iter()
                        .flatten()
                        .filter_map(Value::as_object)
                    {
                        if !route_touches_station(
                            demand_index,
                            demand,
                            route,
                            &indexes,
                            station_index,
                        ) {
                            continue;
                        }
                        expected_progress =
                            expected_progress.max(finite_number(route.get("progress")));
                        match string_at(route, "scope") {
                            Some("remote") => {
                                expected_remote_active = true;
                                expected_active_load +=
                                    finite_number(route.get("vehicleCount")).floor().max(0.0);
                            }
                            Some("local") => {
                                expected_active_load +=
                                    finite_number(route.get("vehicleCount")).floor().max(0.0);
                            }
                            _ => {}
                        }
                        let owner = indexes
                            .get(route_owner_id(demand, route))
                            .copied()
                            .unwrap_or(demand_index);
                        if owner == station_index {
                            match string_at(route, "scope") {
                                Some("remote") => {
                                    expected_remote_busy +=
                                        finite_number(route.get("vehicleCount")).floor().max(0.0);
                                }
                                Some("local") => {
                                    expected_local_busy += finite_number(route.get("vehicleCount"));
                                }
                                _ => {}
                            }
                        }
                    }
                }
                assert_eq!(
                    ledger.busy.get(&station_index).copied().unwrap_or(0.0),
                    expected_remote_busy,
                    "remote busy mismatch for seed {seed}, station {station_index}"
                );
                assert_eq!(
                    ledger
                        .local_busy
                        .get(&station_index)
                        .copied()
                        .unwrap_or(0.0),
                    expected_local_busy,
                    "local busy mismatch for seed {seed}, station {station_index}"
                );
                assert_eq!(
                    ledger
                        .active_vehicle_load
                        .get(&station_index)
                        .copied()
                        .unwrap_or(0.0),
                    expected_active_load,
                    "active load mismatch for seed {seed}, station {station_index}"
                );
                assert_eq!(
                    ledger
                        .active_progress
                        .get(&station_index)
                        .copied()
                        .unwrap_or(0.0),
                    expected_progress,
                    "active progress mismatch for seed {seed}, station {station_index}"
                );
                assert_eq!(
                    ledger.active_remote_stations.contains(&station_index),
                    expected_remote_active,
                    "remote activity mismatch for seed {seed}, station {station_index}"
                );
                for item_id in items {
                    let mut expected_in_flight = 0.0;
                    let mut expected_reserved = 0.0;
                    for (demand_index, demand) in
                        entities.iter().enumerate().filter_map(|(index, value)| {
                            value.as_object().map(|object| (index, object))
                        })
                    {
                        for route in demand
                            .get("stationRoutes")
                            .and_then(Value::as_array)
                            .into_iter()
                            .flatten()
                            .filter_map(Value::as_object)
                            .filter(|route| {
                                matches!(string_at(route, "scope"), Some("local" | "remote"))
                                    && string_at(route, "itemId").unwrap_or_default() == item_id
                            })
                        {
                            let cargo = finite_number(route.get("cargo")).floor().max(0.0);
                            if demand_index == station_index {
                                expected_in_flight += cargo;
                            }
                            if string_at(route, "peerId")
                                .and_then(|id| indexes.get(id))
                                .copied()
                                == Some(station_index)
                            {
                                expected_reserved += cargo;
                            }
                        }
                    }
                    assert_eq!(
                        ledger
                            .in_flight
                            .get(&(station_index, item_id.to_owned()))
                            .copied()
                            .unwrap_or(0.0),
                        expected_in_flight,
                        "in-flight mismatch for seed {seed}, station {station_index}, item {item_id}"
                    );
                    assert_eq!(
                        ledger
                            .reserved
                            .get(&(station_index, item_id.to_owned()))
                            .copied()
                            .unwrap_or(0.0),
                        expected_reserved,
                        "reserved mismatch for seed {seed}, station {station_index}, item {item_id}"
                    );
                }
            }
            assert_eq!(
                entities, original,
                "ledger mutated MOD payload for seed {seed}"
            );
        }
    }

    #[test]
    fn indexed_local_supply_lookup_matches_legacy_station_scan_for_2048_random_states() {
        for seed in 0..2048_u64 {
            let entities = random_entities(seed);
            let all_station_indices = entities
                .iter()
                .enumerate()
                .filter_map(|(index, entity)| {
                    entity
                        .as_object()
                        .is_some_and(|object| string_at(object, "kind") == Some("station"))
                        .then_some(index)
                })
                .collect::<Vec<_>>();
            let legacy_station_indices = station_indices(&entities);
            let directory = build_local_supply_directory(&entities, &all_station_indices);
            for &station_index in &legacy_station_indices {
                let station = entities[station_index].as_object().expect("station object");
                if string_at(station, "buildingId") != Some("interstellar_logistics_station") {
                    continue;
                }
                for slot_index in 0..SLOT_COUNT {
                    assert_eq!(
                        local_peer_exists(&directory, &entities, station_index, slot_index)
                            .expect("indexed local peer lookup"),
                        legacy_local_peer_exists(
                            &entities,
                            &legacy_station_indices,
                            station_index,
                            slot_index,
                        ),
                        "local peer mismatch for seed {seed}, station {station_index}, slot {slot_index}"
                    );
                }
            }
        }
    }

    fn congestion_slot(item_id: Option<&str>, remote_mode: &str) -> Value {
        json!({
            "itemId": item_id,
            "localMode": "storage",
            "remoteMode": remote_mode,
            "minimumLoad": 0.1,
            "minStock": 0,
            "maxStock": 1000,
            "priority": 1,
            "routePolicy": "direct",
            "warperBudget": 1,
            "mod:slot/opaque": { "keep": "Ω🚀" }
        })
    }

    fn interstellar_congestion_matrix(
        count: usize,
    ) -> (Vec<Value>, Vec<usize>, Ledger, LocalSupplyDirectory) {
        let entities = (0..count)
            .map(|index| {
                json!({
                    "id": format!("mod:星际站/{index:05}/Ω"),
                    "kind": "station",
                    "buildingId": "interstellar_logistics_station",
                    "planetId": format!("mod:行星/{:03}", index % 127),
                    "stationTier": 1,
                    "stationOperationMode": "legacy",
                    "machineCount": 1,
                    "stationSlots": [
                        congestion_slot(Some("mod:星际物料/Ω🚀"), "demand"),
                        congestion_slot(None, "storage"),
                        congestion_slot(None, "storage"),
                        congestion_slot(None, "storage"),
                        congestion_slot(None, "storage")
                    ],
                    "stationRoutes": [],
                    // These pre-existing local-pass values must be overwritten
                    // by the later interstellar replay in exactly this order.
                    "stationCongestion": 0.777,
                    "stationProgress": 0.888,
                    "mod:station/opaque": {
                        "index": index,
                        "signedZero": -0.0,
                        "text": "保持原样"
                    }
                })
            })
            .collect::<Vec<_>>();
        let station_indices = (0..count).collect::<Vec<_>>();
        let mut ledger = Ledger::default();
        for station_index in 0..count {
            ledger
                .busy
                .insert(station_index, (station_index % 83) as f64);
            ledger
                .local_busy
                .insert(station_index, f64::from((station_index % 3) as u32) / 4.0);
            ledger
                .active_progress
                .insert(station_index, f64::from((station_index % 97) as u32) / 97.0);
        }
        let directory = build_local_supply_directory(&entities, &station_indices);
        (entities, station_indices, ledger, directory)
    }

    fn run_interstellar_congestion_plan(worker_count: usize) -> Vec<Value> {
        let (mut entities, station_indices, ledger, directory) =
            interstellar_congestion_matrix(PARALLEL_MIN_ITEMS + 53);
        let source = serde_json::to_vec(&entities).unwrap();
        let updates = plan_congestion_updates_with(
            &DeterministicRuntime::for_test(worker_count),
            &entities,
            &station_indices,
            &ledger,
            &directory,
            |station_index, slot_index, slot| {
                assert_eq!(slot_index, 0);
                assert_eq!(slot.item_id.as_deref(), Some("mod:星际物料/Ω🚀"));
                Ok(station_index % 89 == 0)
            },
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
    fn interstellar_congestion_parallel_probe_is_bitwise_stable_for_1_2_4_8_workers() {
        let expected = run_interstellar_congestion_plan(1);
        let expected_bytes = serde_json::to_vec(&expected).unwrap();
        for worker_count in [2, 4, 8] {
            let actual = run_interstellar_congestion_plan(worker_count);
            assert_eq!(serde_json::to_vec(&actual).unwrap(), expected_bytes);
        }

        let waiting = expected[0].as_object().unwrap();
        let saturated = expected[82].as_object().unwrap();
        assert_eq!(waiting["stationCongestion"], Value::from(0.35));
        assert_eq!(waiting["stationProgress"], Value::from(0.0));
        assert_eq!(saturated["stationCongestion"], Value::from(1.0));
        assert_eq!(
            saturated["mod:station/opaque"]["text"],
            Value::from("保持原样")
        );
    }

    #[test]
    fn interstellar_congestion_parallel_failure_uses_lowest_index_and_is_atomic() {
        let (entities, station_indices, ledger, directory) =
            interstellar_congestion_matrix(PARALLEL_MIN_ITEMS + 19);
        let source = serde_json::to_vec(&entities).unwrap();
        let later_failure = PARALLEL_MIN_ITEMS + 7;

        for worker_count in [1, 2, 4, 8] {
            let visited_later_failure = AtomicBool::new(false);
            let error = plan_congestion_updates_with(
                &DeterministicRuntime::for_test(worker_count),
                &entities,
                &station_indices,
                &ledger,
                &directory,
                |station_index, _, _| {
                    if station_index == later_failure {
                        visited_later_failure.store(true, AtomicOrdering::SeqCst);
                        bail!("later interstellar congestion probe failure");
                    }
                    if station_index == 7 {
                        bail!("first interstellar congestion probe failure");
                    }
                    Ok(false)
                },
            )
            .expect_err("any failed probe must reject the whole update batch");
            assert_eq!(
                error.to_string(),
                "first interstellar congestion probe failure"
            );
            assert!(
                visited_later_failure.load(AtomicOrdering::SeqCst),
                "all read-only probes must finish before ordered error selection"
            );
            assert_eq!(serde_json::to_vec(&entities).unwrap(), source);
        }
    }

    #[test]
    fn small_interstellar_congestion_batches_stay_off_worker_pool() {
        let (entities, station_indices, ledger, directory) = interstellar_congestion_matrix(31);
        let saw_rayon_worker = AtomicBool::new(false);
        let updates = plan_congestion_updates_with(
            &DeterministicRuntime::for_test(8),
            &entities,
            &station_indices,
            &ledger,
            &directory,
            |_, _, _| {
                if rayon::current_thread_index().is_some() {
                    saw_rayon_worker.store(true, AtomicOrdering::SeqCst);
                }
                Ok(false)
            },
        )
        .unwrap();
        assert_eq!(updates.len(), station_indices.len());
        assert!(!saw_rayon_worker.load(AtomicOrdering::SeqCst));
    }

    fn interstellar_ready_matrix(
        count: usize,
    ) -> (Vec<Value>, Vec<usize>, Ledger, Map<String, Value>) {
        let (mut entities, station_indices, ledger, _) = interstellar_congestion_matrix(count);
        for (index, value) in entities.iter_mut().enumerate() {
            let station = value.as_object_mut().expect("ready station object");
            station["stationSlots"]
                .as_array_mut()
                .expect("ready station slots")[0]["remoteMode"] =
                Value::from(if index == 0 { "supply" } else { "demand" });
            station.insert("stationVessels".to_owned(), Value::from(10));
            station.insert("stationWarpEnabled".to_owned(), Value::from(true));
            station.insert("stationWarpers".to_owned(), Value::from(100));
            station.insert(
                "outputs".to_owned(),
                json!({ "mod:星际物料/Ω🚀": if index == 0 { 1000 } else { 0 } }),
            );
        }
        let base = json!({
            "settings": { "difficulty": "standard" },
            "research": { "completedTechIds": ["space_warp"] },
            "endgame": { "infiniteResearch": { "galactic_logistics": { "level": 0 } } },
        })
        .as_object()
        .expect("ready base object")
        .clone();
        (entities, station_indices, ledger, base)
    }

    fn direct_ready_economics() -> RouteEconomics {
        RouteEconomics {
            requires_warp: false,
            duration: 1.0,
            distance_ly: 0.0,
            warpers_per_vessel: 0.0,
            waypoint_station_ids: Vec::new(),
        }
    }

    fn run_interstellar_ready_plan(worker_count: usize) -> (Vec<Option<usize>>, Vec<usize>) {
        let (entities, station_indices, mut ledger, base) =
            interstellar_ready_matrix(PARALLEL_MIN_ITEMS + 61);
        ledger.active_remote_stations.insert(7);
        let source = serde_json::to_vec(&entities).unwrap();
        let base_source = serde_json::to_vec(&base).unwrap();
        let planned = plan_ready_station_indices_with(
            &DeterministicRuntime::for_test(worker_count),
            &base,
            &entities,
            &station_indices,
            &ledger,
            ReadyProbeEnvironment {
                peer_matches: |station_index, slot_index| {
                    assert_eq!(slot_index, 0);
                    Ok(vec![(if station_index == 0 { 2 } else { 0 }, 0)])
                },
                route_economics: |_, _, _: &Slot| Ok(Some(direct_ready_economics())),
                station_capacity: |demand_index, _: &Map<String, Value>, _: &Slot| {
                    Ok(if demand_index % 2 == 0 { 1000.0 } else { 0.0 })
                },
            },
        )
        .unwrap();
        assert_eq!(serde_json::to_vec(&entities).unwrap(), source);
        assert_eq!(serde_json::to_vec(&base).unwrap(), base_source);
        let mut ready = replay_ready_station_indices(planned.clone())
            .into_iter()
            .collect::<Vec<_>>();
        ready.sort_unstable();
        (planned, ready)
    }

    #[test]
    fn interstellar_ready_parallel_probe_is_exact_for_1_2_4_8_workers() {
        let expected = run_interstellar_ready_plan(1);
        for worker_count in [2, 4, 8] {
            assert_eq!(run_interstellar_ready_plan(worker_count), expected);
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
    fn interstellar_ready_failure_uses_lowest_input_and_keeps_sources_atomic() {
        let (entities, station_indices, ledger, base) =
            interstellar_ready_matrix(PARALLEL_MIN_ITEMS + 29);
        let source = serde_json::to_vec(&entities).unwrap();
        let base_source = serde_json::to_vec(&base).unwrap();
        let later_failure = PARALLEL_MIN_ITEMS + 17;

        for worker_count in [1, 2, 4, 8] {
            let visited_later_failure = AtomicBool::new(false);
            let error = plan_ready_station_indices_with(
                &DeterministicRuntime::for_test(worker_count),
                &base,
                &entities,
                &station_indices,
                &ledger,
                ReadyProbeEnvironment {
                    peer_matches: |station_index, _| {
                        Ok(vec![(if station_index == 0 { 2 } else { 0 }, 0)])
                    },
                    route_economics: |_, _, _: &Slot| Ok(Some(direct_ready_economics())),
                    station_capacity: |demand_index, _: &Map<String, Value>, _: &Slot| {
                        if demand_index == later_failure {
                            visited_later_failure.store(true, AtomicOrdering::SeqCst);
                            bail!("later interstellar ready probe failure");
                        }
                        if demand_index == 7 {
                            bail!("first interstellar ready probe failure");
                        }
                        Ok(1000.0)
                    },
                },
            )
            .expect_err("any failed readiness probe must reject the whole batch");
            assert_eq!(error.to_string(), "first interstellar ready probe failure");
            assert!(
                visited_later_failure.load(AtomicOrdering::SeqCst),
                "all probes must complete before ordered error selection"
            );
            assert_eq!(serde_json::to_vec(&entities).unwrap(), source);
            assert_eq!(serde_json::to_vec(&base).unwrap(), base_source);
        }
    }

    #[test]
    fn small_interstellar_ready_batches_stay_serial() {
        let (entities, station_indices, ledger, base) = interstellar_ready_matrix(31);
        let saw_rayon_worker = AtomicBool::new(false);
        let planned = plan_ready_station_indices_with(
            &DeterministicRuntime::for_test(8),
            &base,
            &entities,
            &station_indices,
            &ledger,
            ReadyProbeEnvironment {
                peer_matches: |station_index, _| {
                    if rayon::current_thread_index().is_some() {
                        saw_rayon_worker.store(true, AtomicOrdering::SeqCst);
                    }
                    Ok(vec![(if station_index == 0 { 2 } else { 0 }, 0)])
                },
                route_economics: |_, _, _: &Slot| Ok(Some(direct_ready_economics())),
                station_capacity: |_, _: &Map<String, Value>, _: &Slot| Ok(1000.0),
            },
        )
        .unwrap();
        assert_eq!(planned.len(), station_indices.len());
        assert!(!saw_rayon_worker.load(AtomicOrdering::SeqCst));
    }

    fn route_activity_slot(remote_mode: &str) -> Value {
        json!({
            "itemId": if remote_mode == "storage" { Value::Null } else { Value::from("iron_ore") },
            "localMode": "storage",
            "remoteMode": remote_mode,
            "minimumLoad": 0.1,
            "minStock": 0,
            "maxStock": 1000000000,
            "priority": 1,
            "routePolicy": "direct",
            "warperBudget": 2,
            "mod:slot/opaque": { "signedZero": -0.0, "text": "保持" }
        })
    }

    fn route_activity_station(index: usize) -> Value {
        json!({
            "id": format!("remote-station/{index:05}/Ω"),
            "kind": "station",
            "buildingId": "interstellar_logistics_station",
            "planetId": format!("remote-planet/{:03}", index % 7),
            "stationTier": 1,
            "stationOperationMode": "legacy",
            "machineCount": 1,
            "stationSlots": [
                route_activity_slot(if index == 0 { "supply" } else { "demand" }),
                route_activity_slot("storage"),
                route_activity_slot("storage"),
                route_activity_slot("storage"),
                route_activity_slot("storage")
            ],
            "stationRoutes": [],
            "stationVessels": 10,
            "stationWarpEnabled": true,
            "stationWarpers": 100,
            "stationDispatchCursor": 0,
            "stationLastSupplyPeerBySlot": {},
            "stationProgress": 0.0,
            "stationCongestion": 0.0,
            "stationTrips": 0.0,
            "stationLastTransfer": 0.0,
            "utilization": 0.0,
            "productionRate": 0.0,
            "inputs": { "iron_ore": 0.0 },
            "outputs": { "iron_ore": if index == 0 { 1000000000.0 } else { 0.0 } },
            "mod:station/opaque": { "index": index, "signedZero": -0.0, "text": "原样" }
        })
    }

    fn route_activity_remote_route(
        id: usize,
        demand_index: usize,
        progress: f64,
        duration: f64,
        requires_warp: bool,
        waypoint_indices: &[usize],
    ) -> Value {
        json!({
            "id": format!("remote-route/{id:05}"),
            "slotIndex": 0,
            "peerId": "remote-station/00000/Ω",
            "itemId": "iron_ore",
            "scope": "remote",
            "cargo": 11.0,
            "vehicleCount": 1.0,
            "progress": progress,
            "duration": duration,
            "requiresWarp": requires_warp,
            "waypointStationIds": waypoint_indices
                .iter()
                .map(|index| Value::from(format!("remote-station/{index:05}/Ω")))
                .collect::<Vec<_>>(),
            "distanceLy": if requires_warp { 9.5 } else { 0.0 },
            "warpersPerVessel": if requires_warp { waypoint_indices.len() + 1 } else { 0 },
            "vehicleStationId": format!("remote-station/{demand_index:05}/Ω"),
            "mod:route/opaque": { "signedZero": -0.0, "text": "路线原样" }
        })
    }

    fn route_activity_matrix(
        count: usize,
        active: &[(usize, bool, Vec<usize>)],
        progress: f64,
        duration: f64,
    ) -> Vec<Value> {
        let mut entities = (0..count).map(route_activity_station).collect::<Vec<_>>();
        for (demand_index, requires_warp, waypoints) in active {
            entities[*demand_index]["stationRoutes"] = Value::Array(vec![
                json!({
                    "id": format!("local-preserved/{demand_index:05}"),
                    "scope": "local",
                    "progress": 0.25,
                    "mod:local/opaque": true
                }),
                route_activity_remote_route(
                    *demand_index,
                    *demand_index,
                    progress,
                    duration,
                    *requires_warp,
                    waypoints,
                ),
            ]);
        }
        entities
    }

    fn route_activity_powers(count: usize, factor: f64) -> HashMap<usize, f64> {
        (0..count).map(|index| (index, factor)).collect()
    }

    fn dispatch_fixture_checksum(bytes: &[u8]) -> String {
        let mut hash = 0x811c9dc5_u32;
        for byte in bytes {
            hash ^= u32::from(*byte);
            hash = hash.wrapping_mul(0x01000193);
        }
        format!("{hash:08x}")
    }

    fn dispatch_fixture_catalog() -> RuntimeCatalog {
        RuntimeCatalog::validate(
            CatalogSnapshot {
                protocol_version: 1,
                registry_fingerprint: "remote-route-active-test".to_owned(),
                planets: vec![
                    PlanetDefinition {
                        id: "source_planet".to_owned(),
                        name: "source".to_owned(),
                        system_id: "source_system".to_owned(),
                        kind: "terrestrial".to_owned(),
                        orbit_index: 1,
                        simulation_order: 0,
                        orbital_yields: HashMap::from([("iron_ore".to_owned(), 2.5)]),
                    },
                    PlanetDefinition {
                        id: "demand_planet".to_owned(),
                        name: "demand".to_owned(),
                        system_id: "demand_system".to_owned(),
                        kind: "terrestrial".to_owned(),
                        orbit_index: 1,
                        simulation_order: 1,
                        orbital_yields: HashMap::new(),
                    },
                    PlanetDefinition {
                        id: "relay_planet".to_owned(),
                        name: "relay".to_owned(),
                        system_id: "relay_system".to_owned(),
                        kind: "terrestrial".to_owned(),
                        orbit_index: 1,
                        simulation_order: 2,
                        orbital_yields: HashMap::new(),
                    },
                    PlanetDefinition {
                        id: "locked_planet".to_owned(),
                        name: "locked".to_owned(),
                        system_id: "locked_system".to_owned(),
                        kind: "terrestrial".to_owned(),
                        orbit_index: 1,
                        simulation_order: 3,
                        orbital_yields: HashMap::new(),
                    },
                ],
                items: vec![
                    ItemDefinition {
                        id: "iron_ore".to_owned(),
                        name: "iron".to_owned(),
                        kind: "solid".to_owned(),
                        fuel_energy_mj: 0.0,
                    },
                    ItemDefinition {
                        id: "space_warper".to_owned(),
                        name: "warper".to_owned(),
                        kind: "solid".to_owned(),
                        fuel_energy_mj: 0.0,
                    },
                ],
                buildings: vec![
                    BuildingDefinition {
                        id: "interstellar_logistics_station".to_owned(),
                        kind: "station".to_owned(),
                        speed: 1.0,
                        input_capacity: 1_000_000.0,
                        output_capacity: 1_000_000.0,
                        power_demand_kw: 1.0,
                        power_generation_kw: 0.0,
                        power_charge_kw: 0.0,
                        energy_capacity_mj: 0.0,
                        fuel_item_ids: Vec::new(),
                        fuel_efficiency: 1.0,
                        family: None,
                        accepts: None,
                    },
                    BuildingDefinition {
                        id: "orbital_collector".to_owned(),
                        kind: "station".to_owned(),
                        speed: 1.0,
                        input_capacity: 1_000_000.0,
                        output_capacity: 10_000.0,
                        power_demand_kw: 0.0,
                        power_generation_kw: 0.0,
                        power_charge_kw: 0.0,
                        energy_capacity_mj: 0.0,
                        fuel_item_ids: Vec::new(),
                        fuel_efficiency: 1.0,
                        family: None,
                        accepts: None,
                    },
                ],
                recipes: Vec::new(),
                constructions: Vec::new(),
                belts: vec![BeltDefinition {
                    tier: 1,
                    speed: 6.0,
                }],
                proliferators: Vec::new(),
                technologies: Vec::new(),
            },
            "remote-route-active-test",
        )
        .unwrap()
    }

    fn dispatch_fixture_base() -> Value {
        json!({
            "version": 47,
            "mode": "normal",
            "paused": false,
            "activePlanetId": "source_planet",
            "nextId": 100,
            "settings": { "difficulty": "standard", "logisticsBufferLimit": 1000000 },
            "research": { "completedTechIds": ["space_warp"] },
            "handcraftQueue": [],
            "exploration": {
                "unlockedSystemIds": ["source_system", "demand_system", "relay_system"],
                "colonizedPlanetIds": ["source_planet", "demand_planet", "relay_planet"],
                "surveyProgressBySystem": {
                    "source_system": 1.0,
                    "demand_system": 1.0,
                    "relay_system": 1.0
                },
                "missions": []
            },
            "galaxy": {
                "profiles": {
                    "source_planet": {
                        "travelTimeMultiplier": 1.0,
                        "orbitalYieldMultiplier": 1.25,
                        "orbitalYields": { "iron_ore": 2.5 }
                    },
                    "demand_planet": { "travelTimeMultiplier": 1.0 },
                    "relay_planet": { "travelTimeMultiplier": 1.0 },
                    "locked_planet": { "travelTimeMultiplier": 1.0 }
                },
                "systemProfiles": {
                    "source_system": { "positionX": 0.0, "positionY": 0.0 },
                    "demand_system": { "positionX": 4.0, "positionY": 0.0 },
                    "relay_system": { "positionX": 2.0, "positionY": 0.0 },
                    "locked_system": { "positionX": 6.0, "positionY": 0.0 }
                }
            },
            "endgame": { "infiniteResearch": { "galactic_logistics": { "level": 0 } } },
            "tray": {},
            "planetTrays": {
                "source_planet": {},
                "demand_planet": {},
                "relay_planet": {}
            },
            "totalProduced": {},
            "mod:base/opaque": { "signedZero": -0.0, "text": "保持原样" }
        })
    }

    fn dispatch_fixture_entities() -> Vec<Value> {
        let mut supply = route_activity_station(0);
        supply["planetId"] = Value::from("source_planet");
        supply["stationSlots"][0]["remoteMode"] = Value::from("supply");
        supply["stationSlots"][0]["routePolicy"] = Value::from("direct");
        supply["stationSlots"][0]["warperBudget"] = Value::from(1);
        supply["outputs"]["iron_ore"] = Value::from(100.0);
        supply["stationWarpers"] = Value::from(0.0);

        let mut demand = route_activity_station(1);
        demand["planetId"] = Value::from("demand_planet");
        demand["stationSlots"][0]["remoteMode"] = Value::from("demand");
        demand["stationSlots"][0]["routePolicy"] = Value::from("direct");
        demand["stationSlots"][0]["warperBudget"] = Value::from(1);
        demand["stationWarpers"] = Value::from(0.0);
        vec![supply, demand]
    }

    fn warper_refill_station(index: usize, planet_id: &str) -> Value {
        let mut station = route_activity_station(index);
        station["planetId"] = Value::from(planet_id);
        station["stationWarperAutoRefill"] = Value::from(true);
        station["stationWarperTarget"] = Value::from(20.0);
        station["stationWarpers"] = Value::from(0.0);
        station["inputs"]["space_warper"] = Value::from(0.0);
        station["outputs"]["space_warper"] = Value::from(0.0);
        station
    }

    fn warper_refill_base() -> Map<String, Value> {
        let mut base = dispatch_fixture_base();
        base["activePlanetId"] = Value::from("source_planet");
        base["tray"] = json!({ "space_warper": 0.0 });
        base["planetTrays"] = json!({
            "source_planet": { "space_warper": 0.0 },
            "demand_planet": { "space_warper": 0.0 },
            "relay_planet": { "space_warper": 0.0 }
        });
        base.as_object().expect("warper base object").clone()
    }

    fn warper_reservation_bits(reservations: HashMap<String, f64>) -> Vec<(String, u64)> {
        let mut rows = reservations
            .into_iter()
            .map(|(peer_id, cargo)| (peer_id, cargo.to_bits()))
            .collect::<Vec<_>>();
        rows.sort_unstable_by(|left, right| left.0.cmp(&right.0));
        rows
    }

    fn dense_warper_reservation_rows(count: usize) -> Vec<Value> {
        (0..count)
            .map(|index| {
                if index % 97 == 0 {
                    return Value::Null;
                }
                let primary_cargo = match index % 8 {
                    0 => 10_000_000_000_000_000.0,
                    1 => 1.0,
                    2 => -10_000_000_000_000_000.0,
                    3 => -0.0,
                    4 => 0.125,
                    5 => -0.25,
                    6 => 3.0,
                    _ => 0.5,
                };
                json!({
                    "id": format!("mod:星际站/{index:05}/Ω🚀"),
                    "stationRoutes": [
                        {
                            "itemId": "space_warper",
                            "peerId": format!("mod:来源/{:03}/Ω🚀", index % 19),
                            "cargo": primary_cargo
                        },
                        {
                            "itemId": "space_warper",
                            "peerId": format!("mod:备用/{:03}/保持", index % 13),
                            "cargo": if index % 5 == 0 { Value::Null } else { Value::from(0.75) }
                        },
                        {
                            "itemId": "space_warper",
                            "peerId": "mod:缺失数量/Ω"
                        },
                        {
                            "itemId": "space_warper",
                            "peerId": "mod:非数字数量/Ω",
                            "cargo": "不是数字"
                        },
                        {
                            "itemId": "iron_ore",
                            "peerId": "mod:应忽略/Ω",
                            "cargo": 999999
                        },
                        {
                            "itemId": "space_warper",
                            "peerId": null,
                            "cargo": 123
                        },
                        null
                    ],
                    "mod:opaque": { "signedZero": -0.0, "text": "保持原样" }
                })
            })
            .collect()
    }

    fn sparse_warper_reservation_rows(count: usize) -> Vec<Value> {
        (0..count)
            .map(|index| {
                if index % 257 == 0 {
                    json!({
                        "id": format!("mod:稀疏站/{index:05}/Ω"),
                        "stationRoutes": [{
                            "itemId": "space_warper",
                            "peerId": format!("mod:稀疏来源/{:02}/🚀", index % 7),
                            "cargo": f64::from((index % 11) as u32) / 3.0
                        }],
                        "mod:opaque": { "signedZero": -0.0 }
                    })
                } else if index % 113 == 0 {
                    json!({ "stationRoutes": "mod:opaque-route-container", "keep": "Ω" })
                } else if index % 89 == 0 {
                    Value::Null
                } else {
                    json!({
                        "id": format!("dormant-machine-{index}"),
                        "kind": "machine",
                        "mod:opaque": { "signedZero": -0.0, "text": "保持原样" }
                    })
                }
            })
            .collect()
    }

    #[test]
    fn warper_reservation_probe_is_bitwise_stable_for_dense_and_sparse_1_2_4_8_workers() {
        for entities in [
            dense_warper_reservation_rows(PARALLEL_MIN_ITEMS + 73),
            sparse_warper_reservation_rows(PARALLEL_MIN_ITEMS + 211),
        ] {
            let source = serde_json::to_vec(&entities).unwrap();
            let expected = warper_reservation_bits(legacy_warper_reservations(&entities));
            for worker_count in [1, 2, 4, 8] {
                let actual = warper_reservation_bits(legacy_warper_reservations_with_runtime(
                    &entities,
                    &DeterministicRuntime::for_test(worker_count),
                ));
                assert_eq!(actual, expected, "worker count {worker_count} diverged");
                assert_eq!(
                    serde_json::to_vec(&entities).unwrap(),
                    source,
                    "read-only reservation probes mutated their source"
                );
            }
        }
    }

    #[test]
    fn warper_reservation_probe_preserves_mod_missing_null_and_signed_zero_semantics() {
        let entities = dense_warper_reservation_rows(PARALLEL_MIN_ITEMS + 1);
        let expected = warper_reservation_bits(legacy_warper_reservations(&entities));
        let actual = warper_reservation_bits(legacy_warper_reservations_with_runtime(
            &entities,
            &DeterministicRuntime::for_test(8),
        ));
        assert_eq!(actual, expected);

        let reservations =
            legacy_warper_reservations_with_runtime(&entities, &DeterministicRuntime::for_test(8));
        assert_eq!(
            reservations
                .get("mod:缺失数量/Ω")
                .map(|value| value.to_bits()),
            Some(0.0_f64.to_bits())
        );
        assert_eq!(
            reservations
                .get("mod:非数字数量/Ω")
                .map(|value| value.to_bits()),
            Some(0.0_f64.to_bits())
        );
        assert!(reservations.keys().any(|peer_id| peer_id.contains("Ω🚀")));
        assert!(!reservations.contains_key("mod:应忽略/Ω"));
    }

    #[test]
    fn single_pass_route_activity_preserves_persisted_order_and_fail_closed_membership() {
        let mut supply = route_activity_station(1);
        supply["stationSlots"][0]["remoteMode"] = Value::from("supply");

        let mut demand = route_activity_station(2);
        demand["stationRoutes"] = Value::Array(vec![route_activity_remote_route(
            1,
            2,
            0.25,
            1.0,
            false,
            &[],
        )]);

        let mut orbital = route_activity_station(3);
        orbital["buildingId"] = Value::from("orbital_collector");
        orbital["stationRoutes"] = Value::Array(vec![route_activity_remote_route(
            2,
            3,
            0.25,
            1.0,
            false,
            &[],
        )]);

        let mut local = route_activity_station(4);
        local["buildingId"] = Value::from("planetary_logistics_station");
        local["stationRoutes"] = json!([{ "scope": "local" }]);

        let mut opaque = route_activity_station(5);
        opaque["kind"] = Value::from("mod:station");
        opaque
            .as_object_mut()
            .expect("opaque station")
            .remove("planetId");
        opaque["stationRoutes"] = json!([{ "scope": "remote" }]);

        let mut elevator = route_activity_station(6);
        elevator["stationTier"] = Value::from(2);
        elevator["stationOperationMode"] = Value::from("elevator");
        elevator["stationRoutes"] = json!([{ "scope": "local" }]);

        let entities = vec![
            Value::Null,
            supply,
            demand,
            orbital,
            local,
            opaque,
            elevator,
        ];
        let activity = prepare_route_activity(&entities);

        assert_eq!(activity.station_indices.as_ref(), &[1, 2, 3, 6]);
        assert_eq!(activity.active_demand_indices, vec![2, 3]);
        assert_eq!(activity.opaque_route_demand_indices, vec![5, 6]);
        assert_eq!(activity.pending_dispatch_demand_indices, vec![2]);
        assert_eq!(
            activity.warper_refill_station_indices.as_ref(),
            &[1, 2, 5, 6]
        );
        assert_eq!(
            activity
                .warper_refill_planets
                .iter()
                .map(|(planet_id, indices)| (planet_id.as_str(), indices.as_ref()))
                .collect::<Vec<_>>(),
            vec![
                ("remote-planet/001", &[1][..]),
                ("remote-planet/002", &[2][..]),
                ("remote-planet/006", &[6][..]),
            ]
        );
        assert!(activity.warper_refill_full_scan_required);
        assert!(activity.warper_refill_all_pending);
        assert!(activity.pending_warper_refill_station_indices.is_empty());

        let source = Arc::new(activity);
        let mut transactional = Arc::clone(&source);
        let copied = Arc::make_mut(&mut transactional);
        assert!(copied.warper_refill_all_pending);
        assert_eq!(copied.pending_warper_refill_station_indices.capacity(), 0);
        assert!(source.warper_refill_all_pending);
    }

    fn assert_warper_refill_bytes_equal(
        indexed_base: &Map<String, Value>,
        indexed_entities: &[Value],
        oracle_base: &Map<String, Value>,
        oracle_entities: &[Value],
        boundary: usize,
    ) {
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
            "indexed warper refill diverged from the legacy oracle at {boundary}s"
        );
    }

    #[test]
    fn active_warper_refill_matches_full_scan_oracle_at_1_5_60_and_wakes_every_source() {
        let mut source = vec![
            warper_refill_station(0, "source_planet"),
            warper_refill_station(1, "demand_planet"),
            warper_refill_station(2, "relay_planet"),
            warper_refill_station(3, "source_planet"),
        ];
        source.extend((0..128).map(|index| {
            json!({
                "id": format!("dormant-machine-{index}"),
                "kind": "machine",
                "buildingId": "assembler_mk1",
                "mod:opaque": { "index": index, "signedZero": -0.0 }
            })
        }));
        let mut indexed_base = warper_refill_base();
        let mut oracle_base = indexed_base.clone();
        let mut indexed_entities = source.clone();
        let mut oracle_entities = source;
        let mut indexed_activity = prepare_route_activity(&indexed_entities);
        let mut oracle_activity = prepare_route_activity(&oracle_entities);
        let mut ledger = Ledger::default();

        // Initial construction deliberately takes the 75% dense oracle path.
        let (_, initial_scan) = refill_station_warpers_with_scan(
            &mut indexed_base,
            &mut indexed_entities,
            &mut indexed_activity,
            &ledger,
            false,
        )
        .unwrap();
        refill_station_warpers_with_scan(
            &mut oracle_base,
            &mut oracle_entities,
            &mut oracle_activity,
            &ledger,
            true,
        )
        .unwrap();
        assert!(initial_scan.dense_fallback);
        assert_eq!(initial_scan.selected_station_rows, 132);
        assert_eq!(initial_scan.reservation_rows_visited, 132);
        assert_warper_refill_bytes_equal(
            &indexed_base,
            &indexed_entities,
            &oracle_base,
            &oracle_entities,
            0,
        );

        // 1s: a belt/local-buffer delivery wakes exactly one station.
        indexed_entities[1]["inputs"]["space_warper"] = Value::from(7.0);
        oracle_entities[1]["inputs"]["space_warper"] = Value::from(7.0);
        indexed_activity.wake_warper_refill_from_changed_stations(&[1]);
        let (_, one_scan) = refill_station_warpers_with_scan(
            &mut indexed_base,
            &mut indexed_entities,
            &mut indexed_activity,
            &ledger,
            false,
        )
        .unwrap();
        refill_station_warpers_with_scan(
            &mut oracle_base,
            &mut oracle_entities,
            &mut oracle_activity,
            &ledger,
            true,
        )
        .unwrap();
        assert_eq!(one_scan.selected_station_rows, 1);
        assert_eq!(one_scan.reservation_rows_visited, 0);
        assert_warper_refill_bytes_equal(
            &indexed_base,
            &indexed_entities,
            &oracle_base,
            &oracle_entities,
            1,
        );

        // 5s: a quantum download reaches one endpoint. The caller supplies
        // that stable endpoint index, so no other station row is revisited.
        indexed_entities[2]["outputs"]["space_warper"] = Value::from(9.0);
        oracle_entities[2]["outputs"]["space_warper"] = Value::from(9.0);
        indexed_activity.wake_warper_refill_from_changed_stations(&[2]);
        let (_, five_scan) = refill_station_warpers_with_scan(
            &mut indexed_base,
            &mut indexed_entities,
            &mut indexed_activity,
            &ledger,
            false,
        )
        .unwrap();
        refill_station_warpers_with_scan(
            &mut oracle_base,
            &mut oracle_entities,
            &mut oracle_activity,
            &ledger,
            true,
        )
        .unwrap();
        assert_eq!(five_scan.selected_station_rows, 1);
        assert_eq!(five_scan.reservation_rows_visited, 0);
        assert_warper_refill_bytes_equal(
            &indexed_base,
            &indexed_entities,
            &oracle_base,
            &oracle_entities,
            5,
        );

        // A tray change is detected from the compact per-planet snapshot and
        // wakes the two source-planet candidates without an entity scan.
        indexed_base["tray"]["space_warper"] = Value::from(6.0);
        oracle_base["tray"]["space_warper"] = Value::from(6.0);
        let (_, tray_scan) = refill_station_warpers_with_scan(
            &mut indexed_base,
            &mut indexed_entities,
            &mut indexed_activity,
            &ledger,
            false,
        )
        .unwrap();
        refill_station_warpers_with_scan(
            &mut oracle_base,
            &mut oracle_entities,
            &mut oracle_activity,
            &ledger,
            true,
        )
        .unwrap();
        assert_eq!(tray_scan.selected_station_rows, 2);
        assert_eq!(tray_scan.reservation_rows_visited, 0);

        // 60s: a completed route releases an output reservation. Both the
        // indexed route ledger and the legacy peer-id scan must make exactly
        // the same refill decision.
        indexed_entities[3]["stationWarpers"] = Value::from(0.0);
        oracle_entities[3]["stationWarpers"] = Value::from(0.0);
        indexed_entities[3]["outputs"]["space_warper"] = Value::from(10.0);
        oracle_entities[3]["outputs"]["space_warper"] = Value::from(10.0);
        indexed_entities[1]["stationRoutes"] = json!([{
            "scope": "remote",
            "peerId": "remote-station/00003/Ω",
            "itemId": "space_warper",
            "cargo": 10.0,
            "vehicleCount": 1.0,
            "progress": 0.5
        }]);
        oracle_entities[1]["stationRoutes"] = indexed_entities[1]["stationRoutes"].clone();
        ledger.reserved.insert((3, "space_warper".to_owned()), 10.0);
        indexed_activity.wake_warper_refill_from_changed_stations(&[3]);
        refill_station_warpers_with_scan(
            &mut indexed_base,
            &mut indexed_entities,
            &mut indexed_activity,
            &ledger,
            false,
        )
        .unwrap();
        refill_station_warpers_with_scan(
            &mut oracle_base,
            &mut oracle_entities,
            &mut oracle_activity,
            &ledger,
            true,
        )
        .unwrap();
        indexed_entities[1]["stationRoutes"] = Value::Array(Vec::new());
        oracle_entities[1]["stationRoutes"] = Value::Array(Vec::new());
        ledger.reserved.clear();
        indexed_activity.wake_warper_refill_from_changed_stations(&[1, 3]);
        let (_, sixty_scan) = refill_station_warpers_with_scan(
            &mut indexed_base,
            &mut indexed_entities,
            &mut indexed_activity,
            &ledger,
            false,
        )
        .unwrap();
        refill_station_warpers_with_scan(
            &mut oracle_base,
            &mut oracle_entities,
            &mut oracle_activity,
            &ledger,
            true,
        )
        .unwrap();
        assert_eq!(sixty_scan.selected_station_rows, 2);
        assert_eq!(sixty_scan.reservation_rows_visited, 0);
        assert_warper_refill_bytes_equal(
            &indexed_base,
            &indexed_entities,
            &oracle_base,
            &oracle_entities,
            60,
        );

        let (_, resting_scan) = refill_station_warpers_with_scan(
            &mut indexed_base,
            &mut indexed_entities,
            &mut indexed_activity,
            &ledger,
            false,
        )
        .unwrap();
        assert_eq!(resting_scan.selected_station_rows, 0);
        assert_eq!(resting_scan.reservation_rows_visited, 0);
    }

    #[test]
    fn warper_refill_dense_and_mod_fallbacks_preserve_legacy_bytes() {
        let mut source = (0..4)
            .map(|index| warper_refill_station(index, "source_planet"))
            .collect::<Vec<_>>();
        source[0]["kind"] = Value::from("mod:opaque-station-shape");
        source[0]["inputs"]["space_warper"] = Value::from(3.0);
        let mut indexed_base = warper_refill_base();
        let state = dispatch_fixture_state(&source);
        let power_directory = InterstellarPeerDirectory::build(&state, &indexed_base, &source);
        let power_activity = prepare_route_activity(&source);
        let local_directory = crate::local_logistics::prepare_step_directory(
            &source,
            &state.factory_topology.station_indices,
        )
        .unwrap();
        let (power_indices, power_scan) = select_station_power_indices(
            &state.factory_topology.station_indices,
            &[],
            &[],
            &local_directory,
            &power_directory,
            &power_activity,
        );
        assert_eq!(power_indices, state.factory_topology.station_indices);
        assert!(power_scan.directory_fallback);
        assert!(!power_scan.dense_fallback);
        assert!(!power_scan.runtime_fallback);

        let mut oracle_base = indexed_base.clone();
        let mut indexed_entities = source.clone();
        let mut oracle_entities = source;
        let mut indexed_activity = prepare_route_activity(&indexed_entities);
        let mut oracle_activity = prepare_route_activity(&oracle_entities);
        let ledger = Ledger::default();

        let (_, scan) = refill_station_warpers_with_scan(
            &mut indexed_base,
            &mut indexed_entities,
            &mut indexed_activity,
            &ledger,
            false,
        )
        .unwrap();
        refill_station_warpers_with_scan(
            &mut oracle_base,
            &mut oracle_entities,
            &mut oracle_activity,
            &ledger,
            true,
        )
        .unwrap();
        assert!(scan.directory_fallback);
        assert_eq!(scan.selected_station_rows, 4);
        assert_eq!(scan.reservation_rows_visited, 4);
        assert_warper_refill_bytes_equal(
            &indexed_base,
            &indexed_entities,
            &oracle_base,
            &oracle_entities,
            0,
        );

        // A MOD scope can reserve warpers even when every station row itself
        // has a vanilla shape. The compact local/remote ledger cannot prove
        // that dependency, so it must use the same full peer-id reservation
        // oracle as the legacy implementation.
        let mut mod_route_entities = (0..4)
            .map(|index| warper_refill_station(index, "source_planet"))
            .collect::<Vec<_>>();
        mod_route_entities[0]["outputs"]["space_warper"] = Value::from(10.0);
        mod_route_entities[1]["stationRoutes"] = json!([{
            "scope": "mod:wormhole",
            "peerId": "remote-station/00000/Ω",
            "itemId": "space_warper",
            "cargo": 10.0,
            "vehicleCount": 1.0,
            "progress": 0.5
        }]);
        let mut indexed_base = warper_refill_base();
        let mut oracle_base = indexed_base.clone();
        let mut indexed_entities = mod_route_entities.clone();
        let mut oracle_entities = mod_route_entities;
        let mut indexed_activity = prepare_route_activity(&indexed_entities);
        let mut oracle_activity = prepare_route_activity(&oracle_entities);

        let (_, mod_scan) = refill_station_warpers_with_scan(
            &mut indexed_base,
            &mut indexed_entities,
            &mut indexed_activity,
            &ledger,
            false,
        )
        .unwrap();
        refill_station_warpers_with_scan(
            &mut oracle_base,
            &mut oracle_entities,
            &mut oracle_activity,
            &ledger,
            true,
        )
        .unwrap();
        assert!(mod_scan.directory_fallback);
        assert_eq!(mod_scan.selected_station_rows, 4);
        assert_eq!(mod_scan.reservation_rows_visited, 4);
        assert_warper_refill_bytes_equal(
            &indexed_base,
            &indexed_entities,
            &oracle_base,
            &oracle_entities,
            0,
        );
    }

    #[test]
    fn locked_space_warp_drains_refill_wakes_and_rearms_them_on_unlock() {
        let mut entities = (0..8)
            .map(|index| warper_refill_station(index, "source_planet"))
            .collect::<Vec<_>>();
        for station in &mut entities {
            station["stationWarperTarget"] = Value::from(1.0);
        }
        entities[0]["inputs"]["space_warper"] = Value::from(1.0);
        let state = dispatch_fixture_state(&entities);
        let mut base = warper_refill_base();
        base["research"]["completedTechIds"] = Value::Array(Vec::new());
        let mut directory = Arc::new(InterstellarPeerDirectory::build(&state, &base, &entities));
        let mut activity = Arc::new(prepare_route_activity(&entities));
        Arc::make_mut(&mut activity)
            .pending_dispatch_demand_indices
            .clear();
        let local_directory = crate::local_logistics::prepare_step_directory(
            &entities,
            &state.factory_topology.station_indices,
        )
        .unwrap();
        let ledger = Ledger::default();
        let original_entities = serde_json::to_vec(&entities).unwrap();

        let (changed, initial_scan) = refill_station_warpers_with_scan(
            &mut base,
            &mut entities,
            Arc::make_mut(&mut activity),
            &ledger,
            false,
        )
        .unwrap();
        assert!(changed.is_empty());
        assert!(!initial_scan.dense_fallback);
        assert_eq!(initial_scan.selected_station_rows, 0);
        assert_eq!(serde_json::to_vec(&entities).unwrap(), original_entities);

        let (_, resting_refill_scan) = refill_station_warpers_with_scan(
            &mut base,
            &mut entities,
            Arc::make_mut(&mut activity),
            &ledger,
            false,
        )
        .unwrap();
        assert_eq!(resting_refill_scan.selected_station_rows, 0);
        let (resting_power_indices, resting_power_scan) = select_station_power_indices(
            &state.factory_topology.station_indices,
            &[],
            &[],
            &local_directory,
            &directory,
            &activity,
        );
        assert!(resting_power_indices.is_empty());
        assert_eq!(resting_power_scan.selected_station_rows, 0);

        base["research"]["completedTechIds"] = json!(["space_warp"]);
        let locked_directory = Arc::clone(&directory);
        refresh_peer_directory(
            &state,
            &base,
            &entities,
            false,
            &mut directory,
            &mut activity,
        );
        assert!(!Arc::ptr_eq(&locked_directory, &directory));
        assert!(activity.warper_refill_all_pending);

        let (changed, unlocked_scan) = refill_station_warpers_with_scan(
            &mut base,
            &mut entities,
            Arc::make_mut(&mut activity),
            &ledger,
            false,
        )
        .unwrap();
        assert_eq!(changed, vec![0]);
        assert!(unlocked_scan.dense_fallback);
        assert_eq!(entities[0]["stationWarpers"], Value::from(1.0));
        assert_eq!(entities[0]["inputs"]["space_warper"], Value::from(0.0));
    }

    fn dispatch_fixture_state(entities: &[Value]) -> CoreState {
        let entity_count = entities.len();
        let base = serde_json::to_vec(&dispatch_fixture_base()).unwrap();
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
                "checksum": dispatch_fixture_checksum(bytes),
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
                registry_fingerprint: "remote-route-active-test".to_owned(),
                base_primary_checksum: "12345678".to_owned(),
            },
            &records,
            dispatch_fixture_catalog(),
        )
        .unwrap()
    }

    fn orbital_collector_fixture(index: usize) -> Value {
        let mut entity = route_activity_station(index);
        entity["buildingId"] = Value::from("orbital_collector");
        entity["planetId"] = Value::from("source_planet");
        entity["storedItemId"] = Value::from("iron_ore");
        entity["machineCount"] = Value::from(2.0);
        entity["inputs"] = json!({ "iron_ore": (index % 3) as f64 });
        entity["outputs"] = json!({ "iron_ore": (index % 7) as f64 });
        entity["progress"] = Value::from((index % 5) as f64 * 0.125);
        entity["mod:collector/opaque"] = json!({
            "index": index,
            "signedZero": -0.0,
            "text": "保持原样"
        });
        entity
    }

    fn orbital_collector_matrix(count: usize, collectors: &[usize]) -> Vec<Value> {
        (0..count)
            .map(|index| {
                if collectors.contains(&index) {
                    orbital_collector_fixture(index)
                } else {
                    route_activity_station(index)
                }
            })
            .collect()
    }

    fn run_orbital_collector_fixture(
        state: &CoreState,
        source: &[Value],
        seconds: f64,
        force_full_scan: bool,
    ) -> (Vec<u8>, OrbitalCollectorScanDiagnostics) {
        let mut base = dispatch_fixture_base().as_object().unwrap().clone();
        let mut entities = source.to_vec();
        let diagnostics = run_orbital_collectors_with_scan(
            state,
            &mut base,
            &mut entities,
            seconds,
            &crate::belts::OutputCredits::default(),
            force_full_scan,
        )
        .unwrap();
        (
            serde_json::to_vec(&json!({
                "base": base,
                "entities": entities,
            }))
            .unwrap(),
            diagnostics,
        )
    }

    fn run_route_activity_step(
        source: &[Value],
        seconds: f64,
        force_full_scan: bool,
        powers: &HashMap<usize, f64>,
    ) -> (Vec<Value>, InterstellarRouteActivity, usize, bool) {
        let indexes = indexes(source);
        let mut entities = source.to_vec();
        let mut activity = prepare_route_activity(&entities);
        let (scheduled, dense) = activity.route_scan_indices();
        let scan_count = if force_full_scan {
            activity.station_indices.len()
        } else {
            scheduled.len()
        };
        if force_full_scan {
            let full = activity.station_indices.to_vec();
            let outcome =
                advance_routes_for_indices(&mut entities, seconds, powers, &indexes, &full)
                    .unwrap();
            activity.replace_scanned_activity(&outcome.activity_updates);
        } else {
            advance_routes_with_activity(&mut entities, seconds, powers, &indexes, &mut activity)
                .unwrap();
        }
        (entities, activity, scan_count, dense)
    }

    fn assert_shared_interstellar_ledger_matches_legacy(
        state: &CoreState,
        entities: &[Value],
        activity: &InterstellarRouteActivity,
    ) {
        let local_directory = crate::local_logistics::prepare_step_directory(
            entities,
            &state.factory_topology.station_indices,
        )
        .unwrap();
        let shared = StationRouteLedger::build(state, entities, &local_directory, activity);
        let full = StationRouteLedger::build_full_oracle(state, entities, &local_directory);
        let legacy = build_ledger(entities, &state.entity_index);

        for station_index in 0..entities.len() {
            assert_eq!(
                shared.remote_busy_floor(station_index),
                legacy.busy.get(&station_index).copied().unwrap_or(0.0)
            );
            assert_eq!(
                shared.local_busy_raw(station_index),
                legacy
                    .local_busy
                    .get(&station_index)
                    .copied()
                    .unwrap_or(0.0)
            );
            assert_eq!(
                shared.interstellar_in_flight(station_index, "iron_ore"),
                legacy
                    .in_flight
                    .get(&(station_index, "iron_ore".to_owned()))
                    .copied()
                    .unwrap_or(0.0)
            );
            assert_eq!(
                shared.interstellar_reserved(station_index, "iron_ore"),
                legacy
                    .reserved
                    .get(&(station_index, "iron_ore".to_owned()))
                    .copied()
                    .unwrap_or(0.0)
            );
            assert_eq!(
                shared.interstellar_active_vehicle_load(station_index),
                legacy
                    .active_vehicle_load
                    .get(&station_index)
                    .copied()
                    .unwrap_or(0.0)
            );
            assert_eq!(
                shared.is_active_remote_station(station_index),
                legacy.active_remote_stations.contains(&station_index)
            );
            assert_eq!(
                shared.active_progress(station_index),
                legacy
                    .active_progress
                    .get(&station_index)
                    .copied()
                    .unwrap_or(0.0)
            );
            assert_eq!(
                shared.remote_busy_floor(station_index),
                full.remote_busy_floor(station_index)
            );
            assert_eq!(
                shared.local_busy_raw(station_index),
                full.local_busy_raw(station_index)
            );
            assert_eq!(
                shared.interstellar_in_flight(station_index, "iron_ore"),
                full.interstellar_in_flight(station_index, "iron_ore")
            );
            assert_eq!(
                shared.interstellar_reserved(station_index, "iron_ore"),
                full.interstellar_reserved(station_index, "iron_ore")
            );
            assert_eq!(
                shared.interstellar_active_vehicle_load(station_index),
                full.interstellar_active_vehicle_load(station_index)
            );
            assert_eq!(
                shared.active_progress(station_index),
                full.active_progress(station_index)
            );
        }

        let runtime = DeterministicRuntime::for_test(4);
        let base = dispatch_fixture_base();
        let base = base.as_object().unwrap();
        let ready_environment = || ReadyProbeEnvironment {
            peer_matches: |station_index, _| Ok(vec![(if station_index == 0 { 1 } else { 0 }, 0)]),
            route_economics: |_, _, _: &Slot| Ok(Some(direct_ready_economics())),
            station_capacity: |_, _: &Map<String, Value>, _: &Slot| Ok(1_000_000_000.0),
        };
        let legacy_ready = plan_ready_station_indices_with(
            &runtime,
            base,
            entities,
            activity.station_indices.as_ref(),
            &legacy,
            ready_environment(),
        )
        .unwrap();
        let shared_ready = plan_ready_station_indices_with(
            &runtime,
            base,
            entities,
            activity.station_indices.as_ref(),
            &shared,
            ready_environment(),
        )
        .unwrap();
        assert_eq!(shared_ready, legacy_ready);

        let local_supply =
            build_local_supply_directory(entities, activity.station_indices.as_ref());
        let legacy_congestion = plan_congestion_updates_with(
            &runtime,
            entities,
            activity.station_indices.as_ref(),
            &legacy,
            &local_supply,
            |_, _, _| Ok(false),
        )
        .unwrap();
        let shared_congestion = plan_congestion_updates_with(
            &runtime,
            entities,
            activity.station_indices.as_ref(),
            &shared,
            &local_supply,
            |_, _, _| Ok(false),
        )
        .unwrap();
        assert_eq!(shared_congestion, legacy_congestion);
    }

    #[test]
    fn shared_station_route_ledger_matches_interstellar_oracle_at_1_5_60_seconds() {
        let count = 256;
        let active = vec![
            (7, false, vec![]),
            (113, true, vec![]),
            (251, true, vec![89]),
        ];
        let source = route_activity_matrix(count, &active, 0.125, 120.0);
        let state = dispatch_fixture_state(&source);
        let source_hash = state.canonical_sha256().unwrap();
        let powers = route_activity_powers(count, 1.0);

        for seconds in [1.0, 5.0, 60.0] {
            let (entities, activity, _, _) =
                run_route_activity_step(&source, seconds, false, &powers);
            let local_directory = crate::local_logistics::prepare_step_directory(
                &entities,
                &state.factory_topology.station_indices,
            )
            .unwrap();
            let ledger = StationRouteLedger::build(&state, &entities, &local_directory, &activity);
            let active_order_input_rows = local_directory.active_local_route_demand_indices().len()
                + activity.active_remote_route_demand_indices().len()
                + activity.opaque_route_demand_indices().len();
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
            assert_shared_interstellar_ledger_matches_legacy(&state, &entities, &activity);
        }
        assert_eq!(state.canonical_sha256().unwrap(), source_hash);
    }

    #[test]
    fn shared_station_route_ledger_preserves_mixed_legacy_and_opaque_route_domains() {
        let mut entities = (0..8).map(route_activity_station).collect::<Vec<_>>();
        entities[1]["buildingId"] = Value::from("planetary_logistics_station");
        entities[1]["stationRoutes"] = json!([{
            "id": "pls-remote-route",
            "scope": "remote",
            "peerId": "remote-station/00000/Ω",
            "vehicleStationId": "remote-station/00001/Ω",
            "itemId": "iron_ore",
            "cargo": 5.0,
            "vehicleCount": 2.75,
            "progress": 0.4,
            "waypointStationIds": []
        }]);
        entities.push(json!({
            "id": "mod-machine-route-owner",
            "kind": "machine",
            "buildingId": "mod:custom/router",
            "stationRoutes": [
                {
                    "id": "mod-local-route",
                    "scope": "local",
                    "peerId": "remote-station/00001/Ω",
                    "vehicleStationId": "remote-station/00000/Ω",
                    "itemId": "iron_ore",
                    "cargo": 7.0,
                    "vehicleCount": 1.5,
                    "progress": 0.6,
                    "waypointStationIds": []
                },
                {
                    "id": "mod-unknown-route",
                    "scope": "mod:unknown",
                    "peerId": "remote-station/00002/Ω",
                    "progress": 0.9,
                    "waypointStationIds": ["remote-station/00003/Ω"]
                }
            ]
        }));
        let state = dispatch_fixture_state(&entities);
        let local_directory = crate::local_logistics::prepare_step_directory(
            &entities,
            &state.factory_topology.station_indices,
        )
        .unwrap();
        let activity = prepare_route_activity(&entities);
        assert!(activity.active_remote_route_demand_indices().is_empty());
        assert_eq!(activity.opaque_route_demand_indices(), &[1, 8]);

        let shared = StationRouteLedger::build(&state, &entities, &local_directory, &activity);
        let active_order_input_rows = local_directory.active_local_route_demand_indices().len()
            + activity.active_remote_route_demand_indices().len()
            + activity.opaque_route_demand_indices().len();
        assert_eq!(
            shared.scan(),
            crate::station_route_ledger::StationRouteLedgerScan {
                selected_demands: 2,
                total_candidate_rows: 9,
                dense_fallback: false,
                active_order_input_rows,
                active_order_duplicate_rows: active_order_input_rows - 2,
                active_order_fallback: false,
            }
        );
        assert_eq!(shared.local_in_flight(1, "iron_ore"), 5.0);
        assert_eq!(shared.local_busy_floor(0), 0.0);
        assert!(!shared.is_active_local_station(0));
        assert_eq!(shared.remote_busy_floor(1), 2.0);
        assert_eq!(shared.local_busy_raw(0), 1.5);
        assert_eq!(shared.interstellar_in_flight(8, "iron_ore"), 7.0);
        assert_eq!(shared.active_progress(3), 0.9);
        assert_shared_interstellar_ledger_matches_legacy(&state, &entities, &activity);

        let legacy_local = crate::local_logistics::prepare_step_directory(
            &entities,
            &state.factory_topology.station_indices,
        )
        .unwrap();
        assert!(legacy_local.contains_local_station(1));
        assert!(!legacy_local.contains_local_station(8));
    }

    fn assert_interstellar_dispatch_shared_ledger_matches_full_scan(
        source: &[Value],
        power_factor: f64,
        expected_ledger_demands: usize,
        expected_dispatch_demands: usize,
        label: &str,
    ) {
        let state = dispatch_fixture_state(source);
        let source_hash = state.canonical_sha256().unwrap();
        let powers = route_activity_powers(source.len(), power_factor);

        let mut legacy_base = dispatch_fixture_base();
        let mut legacy_entities = source.to_vec();
        let mut legacy_activity = prepare_route_activity(&legacy_entities);
        let mut legacy_ledger = build_ledger(&legacy_entities, &state.entity_index);
        let legacy_peer_directory = InterstellarPeerDirectory::build(
            &state,
            legacy_base.as_object().unwrap(),
            &legacy_entities,
        );
        dispatch_full_scan_oracle(
            &state,
            legacy_base.as_object_mut().unwrap(),
            &mut legacy_entities,
            &powers,
            &mut legacy_activity,
            &legacy_peer_directory,
            &mut legacy_ledger,
        )
        .unwrap();

        let mut shared_base = dispatch_fixture_base();
        let mut shared_entities = source.to_vec();
        let mut shared_activity = prepare_route_activity(&shared_entities);
        let shared_peer_directory = InterstellarPeerDirectory::build(
            &state,
            shared_base.as_object().unwrap(),
            &shared_entities,
        );
        let mut shared_local_directory = crate::local_logistics::prepare_step_directory(
            &shared_entities,
            &state.factory_topology.station_indices,
        )
        .unwrap();
        let mut shared_ledger = StationRouteLedger::build(
            &state,
            &shared_entities,
            &shared_local_directory,
            &shared_activity,
        );
        assert_eq!(
            shared_ledger.scan().selected_demands,
            expected_ledger_demands,
            "selected demand diagnostic diverged for {label}"
        );
        assert!(!shared_ledger.scan().dense_fallback, "{label}");
        let dispatch_scan = dispatch_with_ledger(
            &state,
            shared_base.as_object_mut().unwrap(),
            &mut shared_entities,
            &powers,
            &mut shared_activity,
            &shared_peer_directory,
            &mut shared_ledger,
        )
        .unwrap();
        assert_eq!(
            dispatch_scan.selected_demands, expected_dispatch_demands,
            "dispatch wake diagnostic diverged for {label}"
        );

        assert_eq!(
            serde_json::to_vec(&(&shared_base, &shared_entities)).unwrap(),
            serde_json::to_vec(&(&legacy_base, &legacy_entities)).unwrap(),
            "dispatch result diverged for {label}"
        );
        assert_eq!(
            shared_activity.active_demand_indices, legacy_activity.active_demand_indices,
            "active remote route order diverged for {label}"
        );
        assert_eq!(
            shared_activity.opaque_route_demand_indices(),
            legacy_activity.opaque_route_demand_indices(),
            "opaque route order diverged for {label}"
        );

        shared_local_directory = crate::local_logistics::prepare_step_directory(
            &shared_entities,
            &state.factory_topology.station_indices,
        )
        .unwrap();
        let full = StationRouteLedger::build_full_oracle(
            &state,
            &shared_entities,
            &shared_local_directory,
        );
        for station_index in 0..shared_entities.len() {
            assert_eq!(
                shared_ledger.remote_busy_floor(station_index),
                legacy_ledger
                    .busy
                    .get(&station_index)
                    .copied()
                    .unwrap_or(0.0),
                "busy ledger diverged for {label}"
            );
            assert_eq!(
                shared_ledger.interstellar_reserved(station_index, "iron_ore"),
                legacy_ledger
                    .reserved
                    .get(&(station_index, "iron_ore".to_owned()))
                    .copied()
                    .unwrap_or(0.0),
                "reserved ledger diverged for {label}"
            );
            assert_eq!(
                shared_ledger.interstellar_in_flight(station_index, "iron_ore"),
                legacy_ledger
                    .in_flight
                    .get(&(station_index, "iron_ore".to_owned()))
                    .copied()
                    .unwrap_or(0.0),
                "in-flight ledger diverged for {label}"
            );
            assert_eq!(
                shared_ledger.interstellar_active_vehicle_load(station_index),
                legacy_ledger
                    .active_vehicle_load
                    .get(&station_index)
                    .copied()
                    .unwrap_or(0.0),
                "vehicle-load ledger diverged for {label}"
            );
            assert_eq!(
                shared_ledger.interstellar_reserved(station_index, "iron_ore"),
                full.interstellar_reserved(station_index, "iron_ore"),
                "incremental reserved ledger diverged from full scan for {label}"
            );
            assert_eq!(
                shared_ledger.interstellar_in_flight(station_index, "iron_ore"),
                full.interstellar_in_flight(station_index, "iron_ore"),
                "incremental in-flight ledger diverged from full scan for {label}"
            );
        }
        assert_eq!(state.canonical_sha256().unwrap(), source_hash);
    }

    #[test]
    fn dispatch_reuses_shared_ledger_and_matches_full_scan_for_remote_wake_states() {
        let mut normal = dispatch_fixture_entities();
        normal[1]["stationWarpers"] = Value::from(1.0);

        let mut source_empty = normal.clone();
        source_empty[0]["outputs"]["iron_ore"] = Value::from(0.0);

        let mut target_full = normal.clone();
        target_full[1]["outputs"]["iron_ore"] = Value::from(1_000_000.0);

        let warper_empty = dispatch_fixture_entities();

        let mut preexisting_route = normal.clone();
        preexisting_route[1]["stationRoutes"] = Value::Array(vec![route_activity_remote_route(
            1,
            1,
            0.25,
            120.0,
            true,
            &[],
        )]);

        let mut opaque_mod_route = normal.clone();
        opaque_mod_route[1]["stationRoutes"] = json!([{
            "id": "mod:route/unknown",
            "scope": "mod:unknown-scope",
            "progress": 0.5,
            "waypointStationIds": ["missing-mod-waypoint"],
            "mod:payload": { "signedZero": -0.0, "text": "保持原样" }
        }]);

        for (source, power_factor, ledger_selected, dispatch_selected, label) in [
            (&normal, 1.0, 0, 1, "normal inventory and warper wake"),
            (&source_empty, 1.0, 0, 0, "source empty"),
            (&target_full, 1.0, 0, 0, "target full"),
            (&normal, 0.0, 0, 0, "power limited"),
            (&warper_empty, 1.0, 0, 0, "warper empty"),
            (&preexisting_route, 1.0, 1, 1, "route already active"),
            (&opaque_mod_route, 1.0, 1, 1, "opaque MOD route"),
        ] {
            assert_interstellar_dispatch_shared_ledger_matches_full_scan(
                source,
                power_factor,
                ledger_selected,
                dispatch_selected,
                label,
            );
        }
    }

    #[test]
    fn sparse_planner_does_not_prevalidate_a_later_demand_exhausted_by_fair_order() {
        let mut entities = dispatch_fixture_entities();
        entities[1]["stationWarpers"] = Value::from(1.0);
        let mut later = route_activity_station(2);
        later["planetId"] = Value::from("demand_planet");
        later["stationSlots"][0]["remoteMode"] = Value::from("demand");
        later["stationSlots"][0]["routePolicy"] = Value::from("direct");
        later["stationSlots"][0]["warperBudget"] = Value::from(1);
        later["stationWarpers"] = Value::from(1.0);
        later["stationLastSupplyPeerBySlot"] = Value::Null;
        entities.push(later);

        // The first persisted demand reserves the only 100 items. Legacy
        // dispatch therefore never reaches the later demand's malformed
        // fairness write. Candidate selection may be a conservative superset,
        // but it must not eagerly validate and reject that unreachable write.
        assert_interstellar_dispatch_shared_ledger_matches_full_scan(
            &entities,
            1.0,
            0,
            2,
            "fair-order source exhaustion before later malformed fairness",
        );
    }

    fn indexed_dispatch_matrix(count: usize, active_demands: &[usize]) -> Vec<Value> {
        let active_demands = active_demands.iter().copied().collect::<HashSet<_>>();
        (0..count)
            .map(|index| {
                let mut station = route_activity_station(index);
                station["planetId"] = Value::from(if index == 0 {
                    "source_planet"
                } else {
                    "demand_planet"
                });
                station["stationSlots"][0]["routePolicy"] = Value::from("direct");
                if index == 0 {
                    station["stationSlots"][0]["remoteMode"] = Value::from("supply");
                    station["outputs"]["iron_ore"] = Value::from(1_000_000_000.0);
                    station["stationWarpers"] = Value::from(100.0);
                } else {
                    station["stationSlots"][0]["remoteMode"] = Value::from("demand");
                    station["outputs"]["iron_ore"] =
                        Value::from(if active_demands.contains(&index) {
                            0.0
                        } else {
                            1_000_000.0
                        });
                    station["stationWarpers"] = Value::from(1.0);
                }
                station
            })
            .collect()
    }

    fn run_indexed_dispatch_at_workers(
        source: &[Value],
        workers: usize,
    ) -> (Vec<u8>, InterstellarDispatchScan) {
        let state = dispatch_fixture_state(source);
        let source_hash = state.canonical_sha256().unwrap();
        let mut base = dispatch_fixture_base();
        let mut entities = source.to_vec();
        let powers = route_activity_powers(entities.len(), 1.0);
        let mut activity = prepare_route_activity(&entities);
        let local_directory = crate::local_logistics::prepare_step_directory(
            &entities,
            &state.factory_topology.station_indices,
        )
        .unwrap();
        let mut route_ledger =
            StationRouteLedger::build(&state, &entities, &local_directory, &activity);
        let peer_directory =
            InterstellarPeerDirectory::build(&state, base.as_object().unwrap(), &entities);
        let scan = dispatch_with_ledger_mode(
            &DeterministicRuntime::for_test(workers),
            &state,
            base.as_object_mut().unwrap(),
            &mut entities,
            &powers,
            &mut activity,
            &peer_directory,
            &mut route_ledger,
            false,
        )
        .unwrap();
        assert_eq!(state.canonical_sha256().unwrap(), source_hash);
        (
            serde_json::to_vec(&json!({
                "base": base,
                "entities": entities,
                "active": activity.active_demand_indices,
            }))
            .unwrap(),
            scan,
        )
    }

    #[test]
    fn orbital_collector_index_matches_full_scan_at_one_five_and_sixty_seconds() {
        let source = orbital_collector_matrix(128, &[7, 63, 127]);
        let state = dispatch_fixture_state(&source);
        assert_eq!(
            state.factory_topology.orbital_collector_indices,
            [7, 63, 127]
        );
        assert!(!state.factory_topology.orbital_collector_full_scan_required);

        for seconds in [1.0, 5.0, 60.0] {
            let indexed = run_orbital_collector_fixture(&state, &source, seconds, false);
            let oracle = run_orbital_collector_fixture(&state, &source, seconds, true);
            assert_eq!(
                indexed.0, oracle.0,
                "indexed orbital settlement diverged at {seconds} seconds"
            );
            assert_eq!(indexed.1.selected_rows, 3);
            assert_eq!(indexed.1.total_rows, 128);
            assert!(!indexed.1.dense_fallback);
            assert!(!indexed.1.directory_fallback);
        }
    }

    #[test]
    fn orbital_collector_scan_falls_back_at_three_quarters_and_for_mod_shape() {
        let dense_source = orbital_collector_matrix(4, &[0, 1, 2]);
        let dense_state = dispatch_fixture_state(&dense_source);
        let dense = run_orbital_collector_fixture(&dense_state, &dense_source, 5.0, false);
        let dense_oracle = run_orbital_collector_fixture(&dense_state, &dense_source, 5.0, true);
        assert_eq!(dense.0, dense_oracle.0);
        assert_eq!(dense.1.selected_rows, 4);
        assert!(dense.1.dense_fallback);
        assert!(!dense.1.directory_fallback);

        let mut mod_source = orbital_collector_matrix(16, &[7]);
        mod_source[7]["kind"] = Value::from("mod:orbital_station");
        let mod_state = dispatch_fixture_state(&mod_source);
        assert!(
            mod_state
                .factory_topology
                .orbital_collector_full_scan_required
        );
        let indexed = run_orbital_collector_fixture(&mod_state, &mod_source, 5.0, false);
        let oracle = run_orbital_collector_fixture(&mod_state, &mod_source, 5.0, true);
        assert_eq!(indexed.0, oracle.0);
        assert_eq!(indexed.1.selected_rows, 16);
        assert!(!indexed.1.dense_fallback);
        assert!(indexed.1.directory_fallback);
        let settled: Value = serde_json::from_slice(&indexed.0).unwrap();
        assert_eq!(
            settled["entities"][7]["mod:collector/opaque"],
            mod_source[7]["mod:collector/opaque"]
        );
    }

    #[test]
    fn stale_orbital_collector_index_replays_full_scan_and_failure_keeps_state_immutable() {
        let source = orbital_collector_matrix(16, &[2, 9]);
        let state = dispatch_fixture_state(&source);
        let mut stale = source.clone();
        stale[2]["buildingId"] = Value::from("interstellar_logistics_station");
        let indexed = run_orbital_collector_fixture(&state, &stale, 1.0, false);
        let oracle = run_orbital_collector_fixture(&state, &stale, 1.0, true);
        assert_eq!(indexed.0, oracle.0);
        assert!(indexed.1.directory_fallback);

        let mut invalid = source.clone();
        invalid[9]["storedItemId"] = Value::Null;
        let invalid_state = dispatch_fixture_state(&invalid);
        let state_before = invalid_state.canonical_sha256().unwrap();
        let mut indexed_base = dispatch_fixture_base().as_object().unwrap().clone();
        let mut indexed_entities = invalid.clone();
        let indexed_error = run_orbital_collectors_with_scan(
            &invalid_state,
            &mut indexed_base,
            &mut indexed_entities,
            1.0,
            &crate::belts::OutputCredits::default(),
            false,
        )
        .unwrap_err();
        assert_eq!(invalid_state.canonical_sha256().unwrap(), state_before);

        let mut oracle_base = dispatch_fixture_base().as_object().unwrap().clone();
        let mut oracle_entities = invalid;
        let oracle_error = run_orbital_collectors_with_scan(
            &invalid_state,
            &mut oracle_base,
            &mut oracle_entities,
            1.0,
            &crate::belts::OutputCredits::default(),
            true,
        )
        .unwrap_err();
        assert_eq!(indexed_error.to_string(), oracle_error.to_string());
        assert_eq!(
            indexed_error.to_string(),
            "native orbital collector item is missing"
        );
        assert_eq!(indexed_base, oracle_base);
        assert_eq!(indexed_entities, oracle_entities);
        assert_eq!(invalid_state.canonical_sha256().unwrap(), state_before);
    }

    #[test]
    fn initial_dispatch_scan_is_deterministic_and_indexes_only_matching_peers_at_all_worker_limits()
    {
        let source = indexed_dispatch_matrix(256, &[7, 113, 251]);
        let oracle = run_indexed_dispatch_at_workers(&source, 1);
        assert_eq!(oracle.1.selected_demands, 3);
        assert_eq!(oracle.1.total_demand_rows, 255);
        assert_eq!(oracle.1.demand_rows_probed, 255);
        assert!(oracle.1.dense_fallback);
        assert!(!oracle.1.directory_fallback);
        assert_eq!(oracle.1.peer_candidate_rows_visited, 6);
        assert_eq!(oracle.1.peer_full_scan_rows_visited, 0);

        for workers in [2, 4, 8] {
            let actual = run_indexed_dispatch_at_workers(&source, workers);
            assert_eq!(
                actual.0, oracle.0,
                "dispatch hash diverged at {workers} workers"
            );
            assert_eq!(
                actual.1, oracle.1,
                "dispatch scan diverged at {workers} workers"
            );
        }
    }

    #[test]
    fn dispatch_dense_fallback_activates_at_exactly_three_quarters() {
        let entities = indexed_dispatch_matrix(9, &[1, 2, 3, 4, 5, 6, 7, 8]);
        let state = dispatch_fixture_state(&entities);
        let base = dispatch_fixture_base();
        let directory =
            InterstellarPeerDirectory::build(&state, base.as_object().unwrap(), &entities);
        let local_directory = crate::local_logistics::prepare_step_directory(
            &entities,
            &state.factory_topology.station_indices,
        )
        .unwrap();
        let powers = route_activity_powers(entities.len(), 1.0);

        let scan_for = |pending: Vec<usize>| {
            let mut activity = prepare_route_activity(&entities);
            activity.pending_dispatch_demand_indices = pending;
            let ledger = StationRouteLedger::build(&state, &entities, &local_directory, &activity);
            plan_dispatch_demand_indices_with(
                &DeterministicRuntime::for_test(4),
                &state,
                base.as_object().unwrap(),
                &entities,
                &powers,
                &mut activity,
                &directory,
                &ledger,
            )
            .unwrap()
            .1
        };

        let sparse = scan_for(vec![1, 2, 3, 4, 5]);
        assert_eq!(sparse.total_demand_rows, 8);
        assert_eq!(sparse.demand_rows_probed, 5);
        assert!(!sparse.dense_fallback);

        let dense = scan_for(vec![1, 2, 3, 4, 5, 6]);
        assert_eq!(dense.total_demand_rows, 8);
        assert_eq!(dense.demand_rows_probed, 8);
        assert_eq!(dense.selected_demands, 8);
        assert!(dense.dense_fallback);
        assert!(!dense.directory_fallback);
        assert_eq!(dense.peer_full_scan_rows_visited, 0);
    }

    #[test]
    fn persistent_demand_queue_probes_zero_at_rest_and_only_item_dependents_after_supply_wake() {
        let mut entities = indexed_dispatch_matrix(128, &[]);
        entities[0]["outputs"]["iron_ore"] = Value::from(0.0);
        for (index, station) in entities.iter_mut().enumerate().skip(1) {
            if matches!(index, 7 | 63 | 127) {
                station["stationSlots"][0]["itemId"] = Value::from("iron_ore");
                station["outputs"]["iron_ore"] = Value::from(0.0);
            } else {
                station["stationSlots"][0]["itemId"] = Value::from("copper_ore");
                station["outputs"]["copper_ore"] = Value::from(1_000_000.0);
            }
        }
        let state = dispatch_fixture_state(&entities);
        let base = dispatch_fixture_base();
        let directory =
            InterstellarPeerDirectory::build(&state, base.as_object().unwrap(), &entities);
        let mut activity = prepare_route_activity(&entities);
        let local_directory = crate::local_logistics::prepare_step_directory(
            &entities,
            &state.factory_topology.station_indices,
        )
        .unwrap();
        let ledger = StationRouteLedger::build(&state, &entities, &local_directory, &activity);
        let powers = route_activity_powers(entities.len(), 1.0);
        let runtime = DeterministicRuntime::for_test(4);

        let (_, initial) = plan_dispatch_demand_indices_with(
            &runtime,
            &state,
            base.as_object().unwrap(),
            &entities,
            &powers,
            &mut activity,
            &directory,
            &ledger,
        )
        .unwrap();
        assert_eq!(initial.demand_rows_probed, 127);
        assert_eq!(initial.selected_demands, 0);
        assert!(initial.dense_fallback);

        let (_, resting) = plan_dispatch_demand_indices_with(
            &runtime,
            &state,
            base.as_object().unwrap(),
            &entities,
            &powers,
            &mut activity,
            &directory,
            &ledger,
        )
        .unwrap();
        assert_eq!(resting.demand_rows_probed, 0);
        assert_eq!(resting.selected_demands, 0);
        assert!(!resting.dense_fallback);

        entities[0]["outputs"]["iron_ore"] = Value::from(1_000_000.0);
        activity.wake_dispatch_from_changed_stations(&directory, &[0]);
        let (_, woken) = plan_dispatch_demand_indices_with(
            &runtime,
            &state,
            base.as_object().unwrap(),
            &entities,
            &powers,
            &mut activity,
            &directory,
            &ledger,
        )
        .unwrap();
        assert_eq!(woken.total_demand_rows, 127);
        assert_eq!(woken.demand_rows_probed, 3);
        assert_eq!(woken.selected_demands, 3);
        assert!(!woken.dense_fallback);
        assert_eq!(woken.peer_candidate_rows_visited, 3);
        assert_eq!(woken.peer_full_scan_rows_visited, 0);
    }

    #[test]
    fn indexed_peer_lookup_matches_full_scan_and_rebuilds_after_topology_change() {
        let mut entities = indexed_dispatch_matrix(128, &[127]);
        for station in entities.iter_mut().take(127).skip(1) {
            station["stationSlots"][0]["remoteMode"] = Value::from("storage");
            station["stationSlots"][0]["itemId"] = Value::Null;
        }
        let state = dispatch_fixture_state(&entities);
        let base = dispatch_fixture_base();
        let directory =
            InterstellarPeerDirectory::build(&state, base.as_object().unwrap(), &entities);
        let indexed = peer_matches_indexed(
            &state,
            base.as_object().unwrap(),
            &entities,
            127,
            0,
            &directory,
        )
        .unwrap();
        let full =
            peer_matches_full_scan(&state, base.as_object().unwrap(), &entities, 127, 0).unwrap();
        assert_eq!(indexed.0, full);
        assert_eq!(indexed.1.candidate_rows_visited, 1);
        assert_eq!(indexed.1.full_scan_rows_visited, 0);

        entities[0]["stationSlots"][0]["remoteMode"] = Value::from("storage");
        let stale = peer_matches_indexed(
            &state,
            base.as_object().unwrap(),
            &entities,
            127,
            0,
            &directory,
        )
        .unwrap();
        assert!(stale.1.used_full_scan);
        assert!(stale.0.is_empty());

        entities[0]["stationSlots"][0]["remoteMode"] = Value::from("supply");
        let rebuilt =
            InterstellarPeerDirectory::build(&state, base.as_object().unwrap(), &entities);
        assert_eq!(
            peer_matches_indexed(
                &state,
                base.as_object().unwrap(),
                &entities,
                127,
                0,
                &rebuilt,
            )
            .unwrap()
            .0,
            full
        );
    }

    #[test]
    fn invalid_peer_topology_falls_back_to_the_exact_full_scan_error() {
        let mut entities = indexed_dispatch_matrix(3, &[1]);
        entities[2]["planetId"] = Value::from("relay_planet");
        entities[2]["stationSlots"] = Value::Array(Vec::new());
        let state = dispatch_fixture_state(&entities);
        let base = dispatch_fixture_base();
        let directory =
            InterstellarPeerDirectory::build(&state, base.as_object().unwrap(), &entities);
        assert!(directory.fallback_full_scan);

        let indexed_error = peer_matches_indexed(
            &state,
            base.as_object().unwrap(),
            &entities,
            1,
            0,
            &directory,
        )
        .unwrap_err();
        let full_error =
            peer_matches_full_scan(&state, base.as_object().unwrap(), &entities, 1, 0).unwrap_err();
        assert_eq!(indexed_error.to_string(), full_error.to_string());
        assert_eq!(
            indexed_error.to_string(),
            "native interstellar slot count is invalid"
        );
    }

    #[test]
    fn indexed_relay_directory_preserves_system_policy_and_best_hub_order() {
        let mut entities = dispatch_fixture_entities();
        entities[1]["stationSlots"][0]["routePolicy"] = Value::from("relay-required");
        entities[1]["stationSlots"][0]["warperBudget"] = Value::from(2);
        entities[1]["stationWarpers"] = Value::from(2.0);

        let mut lower_priority_hub = route_activity_station(2);
        lower_priority_hub["planetId"] = Value::from("relay_planet");
        lower_priority_hub["stationSlots"][0] = route_activity_slot("storage");
        lower_priority_hub["stationHubEnabled"] = Value::from(true);
        lower_priority_hub["stationHubPriority"] = Value::from(1.0);
        let mut selected_hub = route_activity_station(3);
        selected_hub["planetId"] = Value::from("relay_planet");
        selected_hub["stationSlots"][0] = route_activity_slot("storage");
        selected_hub["stationHubEnabled"] = Value::from(true);
        selected_hub["stationHubPriority"] = Value::from(2.0);
        let mut same_planet_supply = route_activity_station(4);
        same_planet_supply["planetId"] = Value::from("demand_planet");
        same_planet_supply["stationSlots"][0]["remoteMode"] = Value::from("supply");
        same_planet_supply["outputs"]["iron_ore"] = Value::from(1_000_000.0);
        let mut locked_system_supply = route_activity_station(5);
        locked_system_supply["planetId"] = Value::from("locked_planet");
        locked_system_supply["stationSlots"][0]["remoteMode"] = Value::from("supply");
        locked_system_supply["outputs"]["iron_ore"] = Value::from(1_000_000.0);
        entities.extend([
            lower_priority_hub,
            selected_hub,
            same_planet_supply,
            locked_system_supply,
        ]);

        let state = dispatch_fixture_state(&entities);
        let base = dispatch_fixture_base();
        let directory =
            InterstellarPeerDirectory::build(&state, base.as_object().unwrap(), &entities);
        assert!(!directory.fallback_full_scan);
        assert_eq!(directory.hub_station_indices, vec![3]);
        let indexed = peer_matches_indexed(
            &state,
            base.as_object().unwrap(),
            &entities,
            1,
            0,
            &directory,
        )
        .unwrap();
        let full =
            peer_matches_full_scan(&state, base.as_object().unwrap(), &entities, 1, 0).unwrap();
        assert_eq!(indexed.0, full);
        assert_eq!(indexed.0, vec![(0, 0)]);
        assert_eq!(indexed.1.candidate_rows_visited, 3);
        assert_eq!(indexed.1.full_scan_rows_visited, 0);

        assert_interstellar_dispatch_shared_ledger_matches_full_scan(
            &entities,
            1.0,
            0,
            1,
            "relay-required route and stable best hub",
        );

        let (serialized, scan) = run_indexed_dispatch_at_workers(&entities, 4);
        assert_eq!(scan.selected_demands, 1);
        let settled: Value = serde_json::from_slice(&serialized).unwrap();
        assert_eq!(
            settled["entities"][1]["stationRoutes"][0]["waypointStationIds"],
            json!(["remote-station/00003/Ω"])
        );
    }

    #[test]
    fn inventory_power_capacity_and_warper_changes_reprobe_the_same_directory() {
        let mut entities = dispatch_fixture_entities();
        entities[1]["stationWarpers"] = Value::from(1.0);
        entities[0]["outputs"]["iron_ore"] = Value::from(0.0);
        let state = dispatch_fixture_state(&entities);
        let base = dispatch_fixture_base();
        let directory =
            InterstellarPeerDirectory::build(&state, base.as_object().unwrap(), &entities);
        let mut activity = prepare_route_activity(&entities);
        let local_directory = crate::local_logistics::prepare_step_directory(
            &entities,
            &state.factory_topology.station_indices,
        )
        .unwrap();
        let ledger = StationRouteLedger::build(&state, &entities, &local_directory, &activity);
        let runtime = DeterministicRuntime::for_test(4);
        let powered = route_activity_powers(entities.len(), 1.0);
        let unpowered = route_activity_powers(entities.len(), 0.0);

        activity.pending_dispatch_demand_indices.clear();
        activity.refresh_power_wakes(
            &directory,
            &state.factory_topology.station_indices,
            &unpowered,
        );
        assert!(activity.pending_dispatch_demand_indices.is_empty());
        activity.refresh_power_wakes(
            &directory,
            &state.factory_topology.station_indices,
            &powered,
        );
        assert_eq!(activity.pending_dispatch_demand_indices, vec![1]);
        activity.pending_dispatch_demand_indices.clear();
        activity.refresh_power_wakes(
            &directory,
            &state.factory_topology.station_indices,
            &powered,
        );
        assert!(
            activity.pending_dispatch_demand_indices.is_empty(),
            "steady powered stations must not cause repeated dispatch probes"
        );
        activity.refresh_power_wakes(
            &directory,
            &state.factory_topology.station_indices,
            &unpowered,
        );
        activity.refresh_power_wakes(
            &directory,
            &state.factory_topology.station_indices,
            &powered,
        );
        assert_eq!(activity.pending_dispatch_demand_indices, vec![1]);

        let selected = |entities: &[Value],
                        powers: &HashMap<usize, f64>,
                        activity: &mut InterstellarRouteActivity| {
            activity.wake_all_dispatch_demands(&directory);
            plan_dispatch_demand_indices_with(
                &runtime,
                &state,
                base.as_object().unwrap(),
                entities,
                powers,
                activity,
                &directory,
                &ledger,
            )
            .unwrap()
            .1
            .selected_demands
        };

        assert_eq!(
            selected(&entities, &powered, &mut activity),
            0,
            "source empty"
        );
        entities[0]["outputs"]["iron_ore"] = Value::from(100.0);
        assert_eq!(
            selected(&entities, &powered, &mut activity),
            1,
            "inventory arrival"
        );
        assert_eq!(
            selected(&entities, &unpowered, &mut activity),
            0,
            "power loss"
        );
        entities[1]["outputs"]["iron_ore"] = Value::from(1_000_000.0);
        assert_eq!(
            selected(&entities, &powered, &mut activity),
            0,
            "target full"
        );
        entities[1]["outputs"]["iron_ore"] = Value::from(0.0);
        entities[1]["stationWarpers"] = Value::from(0.0);
        assert_eq!(
            selected(&entities, &powered, &mut activity),
            0,
            "warper empty"
        );
        entities[1]["stationWarpers"] = Value::from(1.0);
        assert_eq!(
            selected(&entities, &powered, &mut activity),
            1,
            "warper arrival"
        );
    }

    #[test]
    fn power_view_active_selection_matches_full_interstellar_dispatch_and_route_oracle_at_1_5_60() {
        let mut entities = dispatch_fixture_entities();
        entities[1]["stationWarpers"] = Value::from(1.0);
        for index in 2..14 {
            let mut dormant = route_activity_station(index);
            dormant["buildingId"] = Value::from("planetary_logistics_station");
            dormant["planetId"] = Value::from("source_planet");
            for slot in dormant["stationSlots"]
                .as_array_mut()
                .expect("dormant slots")
            {
                slot["itemId"] = Value::Null;
                slot["localMode"] = Value::from("storage");
                slot["remoteMode"] = Value::from("storage");
            }
            entities.push(dormant);
        }
        let state = dispatch_fixture_state(&entities);
        let base = dispatch_fixture_base();
        let base = base.as_object().expect("station power base");
        let directory = InterstellarPeerDirectory::build(&state, base, &entities);
        let mut selection_activity = prepare_route_activity(&entities);
        let local_directory = crate::local_logistics::prepare_step_directory(
            &entities,
            &state.factory_topology.station_indices,
        )
        .unwrap();
        let shared_ledger =
            StationRouteLedger::build(&state, &entities, &local_directory, &selection_activity);
        let (ready, readiness_scan) = ready_station_indices_with_scan(
            &state,
            base,
            &entities,
            &directory,
            &mut selection_activity,
            &shared_ledger,
        )
        .unwrap();
        assert_eq!(readiness_scan.selected_station_rows, 2);
        assert_eq!(readiness_scan.total_station_rows, 14);
        assert!(!readiness_scan.dense_fallback);
        assert!(!readiness_scan.directory_fallback);
        let mut ready = ready.into_iter().collect::<Vec<_>>();
        ready.sort_unstable();
        assert_eq!(ready, vec![0, 1]);
        let (selected, scan) = select_station_power_indices(
            &state.factory_topology.station_indices,
            &ready,
            &[],
            &local_directory,
            &directory,
            &selection_activity,
        );
        assert_eq!(selected, vec![0, 1]);
        assert_eq!(scan.selected_station_rows, 2);
        assert_eq!(scan.total_station_rows, 14);
        assert!(!scan.dense_fallback);
        assert!(!scan.directory_fallback);
        assert!(!scan.runtime_fallback);

        for seconds in [1.0, 5.0, 60.0] {
            let full_powers = route_activity_powers(entities.len(), 1.0);
            let sparse_power_values = selected
                .iter()
                .map(|index| full_powers[index])
                .collect::<Vec<_>>();
            let sparse_powers =
                crate::simple_factory::PowerView::new(&selected, &sparse_power_values);
            let mut indexed_base = base.clone();
            let mut oracle_base = base.clone();
            let mut indexed_entities = entities.clone();
            let mut oracle_entities = entities.clone();
            let mut indexed_activity = prepare_route_activity(&indexed_entities);
            let mut oracle_activity = prepare_route_activity(&oracle_entities);
            let mut indexed_ledger = build_ledger(&indexed_entities, &indexes(&indexed_entities));
            let mut oracle_ledger = build_ledger(&oracle_entities, &indexes(&oracle_entities));

            dispatch_with_ledger(
                &state,
                &mut indexed_base,
                &mut indexed_entities,
                &sparse_powers,
                &mut indexed_activity,
                &directory,
                &mut indexed_ledger,
            )
            .unwrap();
            dispatch_full_scan_oracle(
                &state,
                &mut oracle_base,
                &mut oracle_entities,
                &full_powers,
                &mut oracle_activity,
                &directory,
                &mut oracle_ledger,
            )
            .unwrap();
            let indexed_indexes = indexes(&indexed_entities);
            let oracle_indexes = indexes(&oracle_entities);
            advance_routes_with_activity(
                &mut indexed_entities,
                seconds,
                &sparse_powers,
                &indexed_indexes,
                &mut indexed_activity,
            )
            .unwrap();
            advance_routes_with_activity(
                &mut oracle_entities,
                seconds,
                &full_powers,
                &oracle_indexes,
                &mut oracle_activity,
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
                "active station-power map diverged from full scan at {seconds}s"
            );
        }

        // A ready-but-unpowered demand stays selected. Its exact false -> true
        // transition therefore wakes dispatch without scanning dormant rows.
        selection_activity.pending_dispatch_demand_indices.clear();
        selection_activity
            .pending_warper_refill_station_indices
            .clear();
        selection_activity.warper_refill_all_pending = false;
        let off_values = vec![0.0; selected.len()];
        let off = crate::simple_factory::PowerView::new(&selected, &off_values);
        selection_activity.refresh_power_wakes(&directory, &selected, &off);
        assert!(
            selection_activity
                .pending_dispatch_demand_indices
                .is_empty()
        );
        let on_values = vec![1.0; selected.len()];
        let on = crate::simple_factory::PowerView::new(&selected, &on_values);
        selection_activity.refresh_power_wakes(&directory, &selected, &on);
        assert_eq!(selection_activity.pending_dispatch_demand_indices, vec![1]);
    }

    #[test]
    fn late_readiness_wake_survives_dispatch_drain_and_power_recovery() {
        let mut entities = dispatch_fixture_entities();
        entities[0]["outputs"]["iron_ore"] = Value::from(0.0);
        entities[1]["stationWarpers"] = Value::from(1.0);
        for index in 2..14 {
            let mut dormant = route_activity_station(index);
            dormant["buildingId"] = Value::from("planetary_logistics_station");
            dormant["planetId"] = Value::from("source_planet");
            for slot in dormant["stationSlots"]
                .as_array_mut()
                .expect("dormant readiness slots")
            {
                slot["itemId"] = Value::Null;
                slot["localMode"] = Value::from("storage");
                slot["remoteMode"] = Value::from("storage");
            }
            entities.push(dormant);
        }
        let state = dispatch_fixture_state(&entities);
        let base = dispatch_fixture_base();
        let base = base.as_object().expect("late readiness base");
        let directory = InterstellarPeerDirectory::build(&state, base, &entities);
        let local_directory = crate::local_logistics::prepare_step_directory(
            &entities,
            &state.factory_topology.station_indices,
        )
        .unwrap();
        let mut activity = prepare_route_activity(&entities);
        let ledger = StationRouteLedger::build(&state, &entities, &local_directory, &activity);
        let (initial_ready, initial_scan) = ready_station_indices_with_scan(
            &state,
            base,
            &entities,
            &directory,
            &mut activity,
            &ledger,
        )
        .unwrap();
        assert!(initial_ready.is_empty());
        assert_eq!(initial_scan.selected_station_rows, 2);
        activity.take_dispatch_probe_indices(&directory);
        assert!(activity.pending_dispatch_demand_indices.is_empty());
        assert!(activity.pending_readiness_demand_indices.is_empty());

        // This models a quantum download, belt output or warper refill after
        // the readiness boundary. An unpowered dispatch probe consumes only
        // its queue; the next readiness boundary must retain the reverse wake.
        entities[0]["outputs"]["iron_ore"] = Value::from(100.0);
        activity.wake_dispatch_from_changed_stations(&directory, &[0]);
        assert_eq!(activity.pending_dispatch_demand_indices, vec![1]);
        assert_eq!(activity.pending_readiness_demand_indices, vec![1]);
        activity.take_dispatch_probe_indices(&directory);
        assert!(activity.pending_dispatch_demand_indices.is_empty());
        assert_eq!(activity.pending_readiness_demand_indices, vec![1]);

        let ledger = StationRouteLedger::build(&state, &entities, &local_directory, &activity);
        let (ready, scan) = ready_station_indices_with_scan(
            &state,
            base,
            &entities,
            &directory,
            &mut activity,
            &ledger,
        )
        .unwrap();
        let mut ready = ready.into_iter().collect::<Vec<_>>();
        ready.sort_unstable();
        assert_eq!(ready, vec![0, 1]);
        assert_eq!(scan.selected_station_rows, 2);
        assert_eq!(scan.total_station_rows, 14);
        assert!(!scan.dense_fallback);
        assert!(!scan.directory_fallback);
        assert!(activity.pending_readiness_demand_indices.is_empty());

        activity.pending_dispatch_demand_indices.clear();
        let off = HashMap::from([(0, 0.0), (1, 0.0)]);
        activity.refresh_power_wakes(&directory, &[0, 1], &off);
        assert!(activity.pending_dispatch_demand_indices.is_empty());
        let on = HashMap::from([(0, 1.0), (1, 1.0)]);
        activity.refresh_power_wakes(&directory, &[0, 1], &on);
        assert_eq!(activity.pending_dispatch_demand_indices, vec![1]);
        assert_eq!(activity.pending_readiness_demand_indices, vec![1]);
    }

    #[test]
    fn readiness_dense_and_opaque_or_mismatched_dependencies_fail_closed() {
        let mut entities = (0..8)
            .map(|index| {
                let mut station = route_activity_station(index);
                station["planetId"] = Value::from("source_planet");
                station
            })
            .collect::<Vec<_>>();
        entities[0]["stationSlots"][0]["remoteMode"] = Value::from("supply");
        let state = dispatch_fixture_state(&entities);
        let base = dispatch_fixture_base();
        let base = base.as_object().expect("readiness fallback base");
        let directory = InterstellarPeerDirectory::build(&state, base, &entities);
        let local_directory = crate::local_logistics::prepare_step_directory(
            &entities,
            &state.factory_topology.station_indices,
        )
        .unwrap();
        let mut activity = prepare_route_activity(&entities);
        let ledger = StationRouteLedger::build(&state, &entities, &local_directory, &activity);
        let (_, dense_scan) = ready_station_indices_with_scan(
            &state,
            base,
            &entities,
            &directory,
            &mut activity,
            &ledger,
        )
        .unwrap();
        assert_eq!(dense_scan.selected_station_rows, entities.len());
        assert!(dense_scan.dense_fallback);
        assert!(!dense_scan.directory_fallback);

        activity.opaque_route_demand_indices.push(7);
        let (_, opaque_scan) = activity.readiness_scan_indices(
            &state.factory_topology.station_indices,
            &directory,
            &ledger,
        );
        assert_eq!(opaque_scan.selected_station_rows, entities.len());
        assert!(opaque_scan.directory_fallback);

        activity.opaque_route_demand_indices.clear();
        activity.pending_readiness_demand_indices.push(99);
        let (_, mismatch_scan) = activity.readiness_scan_indices(
            &state.factory_topology.station_indices,
            &directory,
            &ledger,
        );
        assert_eq!(mismatch_scan.selected_station_rows, entities.len());
        assert!(mismatch_scan.directory_fallback);
    }

    fn assert_pending_warper_refill_power_owner_matches_full_oracle(owner_index: usize) {
        let mut entities = dispatch_fixture_entities();
        entities[owner_index]["stationWarperAutoRefill"] = Value::from(true);
        entities[owner_index]["stationWarperTarget"] = Value::from(1.0);
        entities[owner_index]["inputs"]["space_warper"] = Value::from(1.0);
        for index in 2..16 {
            let mut dormant = route_activity_station(index);
            dormant["planetId"] = Value::from("source_planet");
            for slot in dormant["stationSlots"]
                .as_array_mut()
                .expect("dormant warper slots")
            {
                slot["itemId"] = Value::Null;
                slot["localMode"] = Value::from("storage");
                slot["remoteMode"] = Value::from("storage");
            }
            entities.push(dormant);
        }

        let state = dispatch_fixture_state(&entities);
        let base = dispatch_fixture_base();
        let base = base.as_object().expect("warper power base");
        let directory = InterstellarPeerDirectory::build(&state, base, &entities);
        let local_directory = crate::local_logistics::prepare_step_directory(
            &entities,
            &state.factory_topology.station_indices,
        )
        .unwrap();
        let mut activity = prepare_route_activity(&entities);
        activity.pending_dispatch_demand_indices.clear();
        activity.warper_refill_all_pending = false;
        activity.pending_warper_refill_station_indices = vec![owner_index];
        let readiness_ledger =
            StationRouteLedger::build(&state, &entities, &local_directory, &activity);
        let ready = ready_station_indices(
            &state,
            base,
            &entities,
            &directory,
            &mut activity,
            &readiness_ledger,
        )
        .unwrap();
        assert!(ready.is_empty(), "the vehicle owner has no warper yet");

        let (selected, scan) = select_station_power_indices(
            &state.factory_topology.station_indices,
            &[],
            &[],
            &local_directory,
            &directory,
            &activity,
        );
        assert_eq!(selected, vec![0, 1]);
        assert_eq!(scan.selected_station_rows, 2);
        assert_eq!(scan.total_station_rows, 16);
        assert!(!scan.dense_fallback);
        assert!(!scan.directory_fallback);
        assert!(!scan.runtime_fallback);

        for seconds in [1.0, 5.0, 60.0] {
            let mut indexed_base = base.clone();
            let mut oracle_base = base.clone();
            let mut indexed_entities = entities.clone();
            let mut oracle_entities = entities.clone();
            let mut indexed_activity = activity.clone();
            let mut oracle_activity = activity.clone();
            let mut indexed_ledger = StationRouteLedger::build(
                &state,
                &indexed_entities,
                &local_directory,
                &indexed_activity,
            );
            let mut oracle_ledger =
                StationRouteLedger::build_full_oracle(&state, &oracle_entities, &local_directory);
            let sparse_powers = selected
                .iter()
                .map(|index| (*index, 1.0))
                .collect::<HashMap<_, _>>();
            let full_powers = route_activity_powers(entities.len(), 1.0);

            let (warper_changed_station_indices, _) = refill_station_warpers_with_scan(
                &mut indexed_base,
                &mut indexed_entities,
                &mut indexed_activity,
                &indexed_ledger,
                false,
            )
            .unwrap();
            refill_station_warpers_with_scan(
                &mut oracle_base,
                &mut oracle_entities,
                &mut oracle_activity,
                &oracle_ledger,
                true,
            )
            .unwrap();
            wake_dispatch_from_changed_stations(
                &warper_changed_station_indices,
                &directory,
                &mut indexed_activity,
            );
            dispatch_with_ledger(
                &state,
                &mut indexed_base,
                &mut indexed_entities,
                &sparse_powers,
                &mut indexed_activity,
                &directory,
                &mut indexed_ledger,
            )
            .unwrap();
            dispatch_full_scan_oracle(
                &state,
                &mut oracle_base,
                &mut oracle_entities,
                &full_powers,
                &mut oracle_activity,
                &directory,
                &mut oracle_ledger,
            )
            .unwrap();
            let indexed_indexes = indexes(&indexed_entities);
            let oracle_indexes = indexes(&oracle_entities);
            advance_routes_with_activity(
                &mut indexed_entities,
                seconds,
                &sparse_powers,
                &indexed_indexes,
                &mut indexed_activity,
            )
            .unwrap();
            advance_routes_with_activity(
                &mut oracle_entities,
                seconds,
                &full_powers,
                &oracle_indexes,
                &mut oracle_activity,
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
                "owner {owner_index} warper-woken station power diverged at {seconds}s"
            );
        }
    }

    #[test]
    fn pending_warper_refill_uses_reverse_power_dependencies_and_matches_full_oracle_at_1_5_60() {
        for owner_index in [0, 1] {
            assert_pending_warper_refill_power_owner_matches_full_oracle(owner_index);
        }
    }

    #[test]
    fn pending_warper_refill_frees_local_capacity_and_matches_full_oracle_at_1_5_60() {
        let mut entities = dispatch_fixture_entities();
        for (index, station) in entities.iter_mut().enumerate() {
            station["planetId"] = Value::from("source_planet");
            station["stationDrones"] = Value::from(if index == 0 { 10.0 } else { 0.0 });
            station["stationWarpers"] = Value::from(0.0);
            station["stationWarperAutoRefill"] = Value::from(index == 1);
            station["stationWarperTarget"] = Value::from(if index == 1 { 20.0 } else { 0.0 });
            station["inputs"]["space_warper"] = Value::from(0.0);
            station["outputs"]["space_warper"] = Value::from(if index == 0 { 100.0 } else { 20.0 });
            for slot in station["stationSlots"]
                .as_array_mut()
                .expect("local warper slots")
            {
                slot["itemId"] = Value::Null;
                slot["localMode"] = Value::from("storage");
                slot["remoteMode"] = Value::from("storage");
            }
            station["stationSlots"][0]["itemId"] = Value::from("space_warper");
            station["stationSlots"][0]["localMode"] =
                Value::from(if index == 0 { "supply" } else { "demand" });
            station["stationSlots"][0]["maxStock"] =
                Value::from(if index == 0 { 1000.0 } else { 20.0 });
        }
        for index in 2..16 {
            let mut dormant = route_activity_station(index);
            dormant["planetId"] = Value::from("source_planet");
            for slot in dormant["stationSlots"]
                .as_array_mut()
                .expect("dormant local warper slots")
            {
                slot["itemId"] = Value::Null;
                slot["localMode"] = Value::from("storage");
                slot["remoteMode"] = Value::from("storage");
            }
            entities.push(dormant);
        }

        let state = dispatch_fixture_state(&entities);
        let base = dispatch_fixture_base();
        let base = base.as_object().expect("local warper base");
        let directory = InterstellarPeerDirectory::build(&state, base, &entities);
        let mut local_directory = crate::local_logistics::prepare_step_directory(
            &entities,
            &state.factory_topology.station_indices,
        )
        .unwrap();
        let mut activity = prepare_route_activity(&entities);
        activity.pending_dispatch_demand_indices.clear();
        activity.warper_refill_all_pending = false;
        activity.pending_warper_refill_station_indices = vec![1];
        let pre_refill_ledger =
            StationRouteLedger::build(&state, &entities, &local_directory, &activity);
        assert!(
            crate::local_logistics::ready_station_indices(
                &state,
                base,
                &entities,
                &mut local_directory,
                &pre_refill_ledger,
            )
            .unwrap()
            .is_empty(),
            "the demand is full until auto-refill consumes its output warpers"
        );

        let (selected, scan) = select_station_power_indices(
            &state.factory_topology.station_indices,
            &[],
            &[],
            &local_directory,
            &directory,
            &activity,
        );
        assert_eq!(selected, vec![0, 1]);
        assert_eq!(scan.selected_station_rows, 2);
        assert_eq!(scan.total_station_rows, 16);
        assert!(!scan.dense_fallback);
        assert!(!scan.directory_fallback);
        assert!(!scan.runtime_fallback);

        for seconds in [1.0, 5.0, 60.0] {
            let mut indexed_base = base.clone();
            let mut oracle_base = base.clone();
            let mut indexed_entities = entities.clone();
            let mut oracle_entities = entities.clone();
            let mut indexed_activity = activity.clone();
            let mut oracle_activity = activity.clone();
            let mut indexed_local = crate::local_logistics::prepare_step_directory(
                &indexed_entities,
                &state.factory_topology.station_indices,
            )
            .unwrap();
            let mut oracle_local = crate::local_logistics::prepare_step_directory(
                &oracle_entities,
                &state.factory_topology.station_indices,
            )
            .unwrap();
            let mut indexed_ledger = StationRouteLedger::build(
                &state,
                &indexed_entities,
                &indexed_local,
                &indexed_activity,
            );
            let mut oracle_ledger =
                StationRouteLedger::build_full_oracle(&state, &oracle_entities, &oracle_local);
            let sparse_powers = selected
                .iter()
                .map(|index| (*index, 1.0))
                .collect::<HashMap<_, _>>();
            let full_powers = state
                .factory_topology
                .station_indices
                .iter()
                .map(|index| (*index, 1.0))
                .collect::<HashMap<_, _>>();

            let (changed, _) = refill_station_warpers_with_scan(
                &mut indexed_base,
                &mut indexed_entities,
                &mut indexed_activity,
                &indexed_ledger,
                false,
            )
            .unwrap();
            refill_station_warpers_with_scan(
                &mut oracle_base,
                &mut oracle_entities,
                &mut oracle_activity,
                &oracle_ledger,
                true,
            )
            .unwrap();
            assert_eq!(changed, vec![1]);
            crate::local_logistics::dispatch(
                &state,
                &mut indexed_base,
                &mut indexed_entities,
                &sparse_powers,
                &mut indexed_local,
                &mut indexed_ledger,
            )
            .unwrap();
            crate::local_logistics::dispatch(
                &state,
                &mut oracle_base,
                &mut oracle_entities,
                &full_powers,
                &mut oracle_local,
                &mut oracle_ledger,
            )
            .unwrap();
            crate::local_logistics::advance_routes(
                &state,
                &mut indexed_base,
                &mut indexed_entities,
                seconds,
                &sparse_powers,
                &mut indexed_local,
            )
            .unwrap();
            crate::local_logistics::advance_routes(
                &state,
                &mut oracle_base,
                &mut oracle_entities,
                seconds,
                &full_powers,
                &mut oracle_local,
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
                "local warper-refill power closure diverged at {seconds}s"
            );
        }
    }

    fn station_power_fanout_fixture(count: usize) -> Vec<Value> {
        let split = count / 2;
        (0..count)
            .map(|index| {
                let mut station = route_activity_station(index);
                station["planetId"] = Value::from("source_planet");
                station["stationSlots"][0]["remoteMode"] =
                    Value::from(if index < split { "supply" } else { "demand" });
                station["stationSlots"][0]["localMode"] =
                    Value::from(if index < split { "supply" } else { "demand" });
                station["outputs"]["iron_ore"] =
                    Value::from(if index < split { 1000.0 } else { 0.0 });
                station
            })
            .collect()
    }

    #[test]
    fn station_power_reverse_index_memory_and_selection_scale_linearly_under_high_fanout() {
        let small_entities = station_power_fanout_fixture(64);
        let small_state = dispatch_fixture_state(&small_entities);
        let base = dispatch_fixture_base();
        let base = base.as_object().expect("fanout base");
        let small_directory = InterstellarPeerDirectory::build(&small_state, base, &small_entities);
        let small_local = crate::local_logistics::prepare_step_directory(
            &small_entities,
            &small_state.factory_topology.station_indices,
        )
        .unwrap();

        let large_entities = station_power_fanout_fixture(128);
        let large_state = dispatch_fixture_state(&large_entities);
        let large_directory = InterstellarPeerDirectory::build(&large_state, base, &large_entities);
        let local_directory = crate::local_logistics::prepare_step_directory(
            &large_entities,
            &large_state.factory_topology.station_indices,
        )
        .unwrap();
        assert!(
            large_directory.estimated_bytes() <= small_directory.estimated_bytes() * 3,
            "doubling same-item fanout must remain linear: small={} large={}",
            small_directory.estimated_bytes(),
            large_directory.estimated_bytes()
        );
        assert!(
            local_directory.estimated_bytes() <= small_local.estimated_bytes() * 3,
            "doubling local same-item fanout must remain linear: small={} large={}",
            small_local.estimated_bytes(),
            local_directory.estimated_bytes()
        );

        let all_demands = (64..128).collect::<Vec<_>>();
        let mut remote_demand_raw = Vec::new();
        assert!(
            large_directory
                .append_power_dependencies_for_demands(&all_demands, &mut remote_demand_raw)
        );
        assert_eq!(remote_demand_raw.len(), 128);
        let all_supplies = (0..64).collect::<Vec<_>>();
        let mut remote_supply_raw = Vec::new();
        assert!(
            large_directory.append_power_dependencies_from_changed_stations(
                &all_supplies,
                &mut remote_supply_raw,
            )
        );
        assert_eq!(remote_supply_raw.len(), 128);
        let mut local_raw = Vec::new();
        assert!(local_directory.append_station_power_dependencies(
            &large_state.factory_topology.station_indices,
            &mut local_raw,
        ));
        assert_eq!(local_raw.len(), 256);

        let mut activity = prepare_route_activity(&large_entities);
        activity.pending_dispatch_demand_indices.clear();
        activity.warper_refill_all_pending = false;
        activity.pending_warper_refill_station_indices.clear();

        let (demand_wake, demand_scan) = select_station_power_indices(
            &large_state.factory_topology.station_indices,
            &[],
            &[64],
            &local_directory,
            &large_directory,
            &activity,
        );
        assert_eq!(demand_wake.len(), 65);
        assert_eq!(demand_wake[0], 0);
        assert_eq!(demand_wake[64], 64);
        assert!(!demand_scan.dense_fallback);
        assert!(!demand_scan.directory_fallback);
        assert!(!demand_scan.runtime_fallback);

        let (supply_wake, supply_scan) = select_station_power_indices(
            &large_state.factory_topology.station_indices,
            &[],
            &[0],
            &local_directory,
            &large_directory,
            &activity,
        );
        assert_eq!(supply_wake, large_state.factory_topology.station_indices);
        assert!(supply_scan.dense_fallback);
        assert!(!supply_scan.directory_fallback);
        assert!(!supply_scan.runtime_fallback);
    }

    #[test]
    fn active_route_power_selection_includes_supply_demand_owner_and_waypoint_when_not_dispatchable()
     {
        let mut entities = dispatch_fixture_entities();
        entities[0]["outputs"]["iron_ore"] = Value::from(0.0);
        entities[1]["stationWarpers"] = Value::from(0.0);

        let mut waypoint = route_activity_station(2);
        waypoint["planetId"] = Value::from("relay_planet");
        waypoint["stationHubEnabled"] = Value::from(true);
        for slot in waypoint["stationSlots"]
            .as_array_mut()
            .expect("waypoint slots")
        {
            slot["itemId"] = Value::Null;
            slot["remoteMode"] = Value::from("storage");
        }
        let mut owner = route_activity_station(3);
        owner["planetId"] = Value::from("demand_planet");
        for slot in owner["stationSlots"].as_array_mut().expect("owner slots") {
            slot["itemId"] = Value::Null;
            slot["remoteMode"] = Value::from("storage");
        }
        entities.extend([waypoint, owner]);
        entities[1]["stationRoutes"] = json!([{
            "id": "strict-active-route",
            "slotIndex": 0,
            "peerId": "remote-station/00000/Ω",
            "itemId": "iron_ore",
            "scope": "remote",
            "cargo": 10.0,
            "vehicleCount": 1.0,
            "progress": 0.25,
            "duration": 100.0,
            "requiresWarp": true,
            "waypointStationIds": ["remote-station/00002/Ω"],
            "distanceLy": 4.0,
            "warpersPerVessel": 2.0,
            "vehicleStationId": "remote-station/00003/Ω"
        }]);
        for index in 4..20 {
            let mut dormant = route_activity_station(index);
            dormant["buildingId"] = Value::from("planetary_logistics_station");
            dormant["planetId"] = Value::from("source_planet");
            for slot in dormant["stationSlots"]
                .as_array_mut()
                .expect("dormant route slots")
            {
                slot["itemId"] = Value::Null;
                slot["localMode"] = Value::from("storage");
                slot["remoteMode"] = Value::from("storage");
            }
            entities.push(dormant);
        }

        let state = dispatch_fixture_state(&entities);
        let base = dispatch_fixture_base();
        let base = base.as_object().expect("strict route base");
        let directory = InterstellarPeerDirectory::build(&state, base, &entities);
        let mut activity = prepare_route_activity(&entities);
        let local_directory = crate::local_logistics::prepare_step_directory(
            &entities,
            &state.factory_topology.station_indices,
        )
        .unwrap();
        let ledger = StationRouteLedger::build(&state, &entities, &local_directory, &activity);
        let mut ready =
            ready_station_indices(&state, base, &entities, &directory, &mut activity, &ledger)
                .unwrap()
                .into_iter()
                .collect::<Vec<_>>();
        ready.sort_unstable();
        assert_eq!(
            ready,
            vec![0, 1, 2, 3],
            "the active ledger must surface the pure supply, demand, separate vehicle owner and waypoint"
        );
        let (selected, scan) = select_station_power_indices(
            &state.factory_topology.station_indices,
            &ready,
            &[],
            &local_directory,
            &directory,
            &activity,
        );
        assert_eq!(selected, vec![0, 1, 2, 3]);
        assert!(!scan.dense_fallback);
        assert!(!scan.directory_fallback);
        assert!(!scan.runtime_fallback);

        let sparse_powers = selected
            .iter()
            .map(|index| (*index, 1.0))
            .collect::<HashMap<_, _>>();
        let full_powers = state
            .factory_topology
            .station_indices
            .iter()
            .map(|index| (*index, 1.0))
            .collect::<HashMap<_, _>>();
        let mut indexed_entities = entities.clone();
        let mut oracle_entities = entities;
        let mut indexed_activity = prepare_route_activity(&indexed_entities);
        let mut oracle_activity = prepare_route_activity(&oracle_entities);
        let indexed_indexes = indexes(&indexed_entities);
        let oracle_indexes = indexes(&oracle_entities);
        advance_routes_with_activity(
            &mut indexed_entities,
            5.0,
            &sparse_powers,
            &indexed_indexes,
            &mut indexed_activity,
        )
        .unwrap();
        advance_routes_with_activity(
            &mut oracle_entities,
            5.0,
            &full_powers,
            &oracle_indexes,
            &mut oracle_activity,
        )
        .unwrap();
        assert_eq!(
            serde_json::to_vec(&indexed_entities).unwrap(),
            serde_json::to_vec(&oracle_entities).unwrap()
        );
        assert_eq!(
            indexed_entities[1]["stationRoutes"][0]["progress"],
            Value::from(0.3)
        );
    }

    #[test]
    fn late_quantum_supply_keeps_legacy_same_boundary_local_dispatch_with_full_power_oracle() {
        let mut entities = dispatch_fixture_entities();
        for (index, entity) in entities.iter_mut().enumerate() {
            entity["planetId"] = Value::from("source_planet");
            entity["stationDrones"] = Value::from(10.0);
            entity["outputs"]["iron_ore"] = Value::from(0.0);
            for slot in entity["stationSlots"]
                .as_array_mut()
                .expect("quantum local slots")
            {
                slot["itemId"] = Value::Null;
                slot["localMode"] = Value::from("storage");
                slot["remoteMode"] = Value::from("storage");
            }
            entity["stationSlots"][0]["itemId"] = Value::from("iron_ore");
            entity["stationSlots"][0]["localMode"] =
                Value::from(if index == 0 { "supply" } else { "demand" });
        }
        entities[0]["quantumMode"] = Value::from("quantum");
        for index in 2..18 {
            let mut dormant = route_activity_station(index);
            dormant["planetId"] = Value::from("source_planet");
            dormant["stationDrones"] = Value::from(10.0);
            for slot in dormant["stationSlots"]
                .as_array_mut()
                .expect("quantum dormant slots")
            {
                slot["itemId"] = Value::Null;
                slot["localMode"] = Value::from("storage");
                slot["remoteMode"] = Value::from("storage");
            }
            entities.push(dormant);
        }

        let state = dispatch_fixture_state(&entities);
        let base = dispatch_fixture_base();
        let base = base.as_object().expect("quantum local base");
        let directory = InterstellarPeerDirectory::build(&state, base, &entities);
        let mut activity = prepare_route_activity(&entities);
        activity.pending_dispatch_demand_indices.clear();
        activity.pending_warper_refill_station_indices.clear();
        activity.warper_refill_all_pending = false;
        let mut local_directory = crate::local_logistics::prepare_step_directory(
            &entities,
            &state.factory_topology.station_indices,
        )
        .unwrap();
        let pre_delivery_ledger =
            StationRouteLedger::build(&state, &entities, &local_directory, &activity);
        assert!(
            crate::local_logistics::ready_station_indices(
                &state,
                base,
                &entities,
                &mut local_directory,
                &pre_delivery_ledger,
            )
            .unwrap()
            .is_empty(),
            "the ordinary readiness snapshot must precede the quantum download"
        );

        // simple_factory proactively powers the indexed quantum endpoint even
        // before delivery. The persistent local reverse index must add its
        // ordinary demand peer without waking the other dormant stations.
        let (selected, scan) = select_station_power_indices(
            &state.factory_topology.station_indices,
            &[0],
            &[0],
            &local_directory,
            &directory,
            &activity,
        );
        assert!(!scan.runtime_fallback);
        assert!(!scan.dense_fallback);
        assert_eq!(selected, vec![0, 1]);

        let mut indexed_entities = entities.clone();
        let mut oracle_entities = entities;
        indexed_entities[0]["outputs"]["iron_ore"] = Value::from(100.0);
        oracle_entities[0]["outputs"]["iron_ore"] = Value::from(100.0);
        let mut indexed_base = base.clone();
        let mut oracle_base = base.clone();
        let mut indexed_local = crate::local_logistics::prepare_step_directory(
            &indexed_entities,
            &state.factory_topology.station_indices,
        )
        .unwrap();
        let mut oracle_local = crate::local_logistics::prepare_step_directory(
            &oracle_entities,
            &state.factory_topology.station_indices,
        )
        .unwrap();
        let indexed_activity = prepare_route_activity(&indexed_entities);
        let oracle_activity = prepare_route_activity(&oracle_entities);
        let mut indexed_ledger =
            StationRouteLedger::build(&state, &indexed_entities, &indexed_local, &indexed_activity);
        let mut oracle_ledger =
            StationRouteLedger::build(&state, &oracle_entities, &oracle_local, &oracle_activity);
        let indexed_powers = selected
            .iter()
            .map(|index| (*index, 1.0))
            .collect::<HashMap<_, _>>();
        let full_powers = state
            .factory_topology
            .station_indices
            .iter()
            .map(|index| (*index, 1.0))
            .collect::<HashMap<_, _>>();
        crate::local_logistics::dispatch(
            &state,
            &mut indexed_base,
            &mut indexed_entities,
            &indexed_powers,
            &mut indexed_local,
            &mut indexed_ledger,
        )
        .unwrap();
        crate::local_logistics::dispatch(
            &state,
            &mut oracle_base,
            &mut oracle_entities,
            &full_powers,
            &mut oracle_local,
            &mut oracle_ledger,
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
            .unwrap()
        );
        assert_eq!(
            indexed_entities[1]["stationRoutes"]
                .as_array()
                .expect("same-boundary local route")
                .len(),
            1
        );
    }

    #[test]
    fn quantum_endpoint_download_is_not_a_legacy_remote_supply_in_sparse_or_full_dispatch() {
        let mut entities = dispatch_fixture_entities();
        entities[0]["stationTier"] = Value::from(2.0);
        entities[0]["quantumMode"] = Value::from("quantum");
        entities[0]["outputs"]["iron_ore"] = Value::from(0.0);
        entities[0]["stationWarpers"] = Value::from(100.0);
        entities[1]["stationWarpers"] = Value::from(100.0);
        let state = dispatch_fixture_state(&entities);
        let base = dispatch_fixture_base();
        let base = base.as_object().expect("quantum remote base");
        let directory = InterstellarPeerDirectory::build(&state, base, &entities);
        assert!(
            !directory.supply_items_by_station.contains_key(&0),
            "a quantum ILS must stay outside the traditional remote directory"
        );

        // The five-second download happens before both dispatch scopes. Even
        // with fresh cargo, TS excludes a quantum-mode ILS from traditional
        // remote routing. Consuming the pending queue before this boundary is
        // therefore exact: both sparse and force-full remote dispatch create
        // no route. Local drone behavior is covered by the preceding test.
        let mut indexed_entities = entities.clone();
        let mut oracle_entities = entities;
        indexed_entities[0]["outputs"]["iron_ore"] = Value::from(100.0);
        oracle_entities[0]["outputs"]["iron_ore"] = Value::from(100.0);
        let mut indexed_base = base.clone();
        let mut oracle_base = base.clone();
        let mut indexed_activity = prepare_route_activity(&indexed_entities);
        indexed_activity.pending_dispatch_demand_indices.clear();
        let mut oracle_activity = prepare_route_activity(&oracle_entities);
        oracle_activity.pending_dispatch_demand_indices.clear();
        let mut indexed_ledger = build_ledger(&indexed_entities, &indexes(&indexed_entities));
        let mut oracle_ledger = build_ledger(&oracle_entities, &indexes(&oracle_entities));
        let powers = route_activity_powers(indexed_entities.len(), 1.0);

        let indexed_scan = dispatch_with_ledger(
            &state,
            &mut indexed_base,
            &mut indexed_entities,
            &powers,
            &mut indexed_activity,
            &directory,
            &mut indexed_ledger,
        )
        .unwrap();
        let oracle_scan = dispatch_full_scan_oracle(
            &state,
            &mut oracle_base,
            &mut oracle_entities,
            &powers,
            &mut oracle_activity,
            &directory,
            &mut oracle_ledger,
        )
        .unwrap();
        assert_eq!(indexed_scan.demand_rows_probed, 0);
        assert_eq!(oracle_scan.demand_rows_probed, 2);
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
            .unwrap()
        );
        assert!(indexed_entities.iter().all(|entity| {
            entity["stationRoutes"]
                .as_array()
                .is_some_and(Vec::is_empty)
        }));
    }

    #[test]
    fn station_power_selection_falls_back_for_dense_runtime_and_opaque_dependencies() {
        let entities = (0..8)
            .map(|index| {
                let mut station = route_activity_station(index);
                station["planetId"] = Value::from("source_planet");
                station
            })
            .collect::<Vec<_>>();
        let state = dispatch_fixture_state(&entities);
        let base = dispatch_fixture_base();
        let directory = InterstellarPeerDirectory::build(
            &state,
            base.as_object().expect("power fallback base"),
            &entities,
        );
        let local_directory = crate::local_logistics::prepare_step_directory(
            &entities,
            &state.factory_topology.station_indices,
        )
        .unwrap();
        let mut activity = prepare_route_activity(&entities);
        activity.pending_dispatch_demand_indices.clear();
        activity.pending_warper_refill_station_indices.clear();
        activity.warper_refill_all_pending = false;

        let (dense, dense_scan) = select_station_power_indices(
            &state.factory_topology.station_indices,
            &[0, 1, 2, 3, 4, 5],
            &[],
            &local_directory,
            &directory,
            &activity,
        );
        assert_eq!(dense, state.factory_topology.station_indices);
        assert!(dense_scan.dense_fallback);

        activity.pending_dispatch_demand_indices.push(99);
        let (_, runtime_scan) = select_station_power_indices(
            &state.factory_topology.station_indices,
            &[0],
            &[],
            &local_directory,
            &directory,
            &activity,
        );
        assert!(runtime_scan.runtime_fallback);

        activity.pending_dispatch_demand_indices.clear();
        activity.opaque_route_demand_indices.push(7);
        let (_, opaque_scan) = select_station_power_indices(
            &state.factory_topology.station_indices,
            &[0],
            &[],
            &local_directory,
            &directory,
            &activity,
        );
        assert!(opaque_scan.directory_fallback);
    }

    #[test]
    fn indexed_directory_preserves_ready_and_congestion_full_scan_oracles() {
        let mut entities = dispatch_fixture_entities();
        entities[1]["stationWarpers"] = Value::from(1.0);
        let state = dispatch_fixture_state(&entities);
        let base = dispatch_fixture_base();
        let base = base.as_object().unwrap();
        let directory = InterstellarPeerDirectory::build(&state, base, &entities);
        let mut activity = prepare_route_activity(&entities);
        let mut local_directory = crate::local_logistics::prepare_step_directory(
            &entities,
            &state.factory_topology.station_indices,
        )
        .unwrap();
        let ledger = StationRouteLedger::build(&state, &entities, &local_directory, &activity);
        let runtime = DeterministicRuntime::for_test(4);

        let indexed_ready =
            ready_station_indices(&state, base, &entities, &directory, &mut activity, &ledger)
                .unwrap();
        let full_ready = replay_ready_station_indices(
            plan_ready_station_indices_with(
                &runtime,
                base,
                &entities,
                &state.factory_topology.station_indices,
                &ledger,
                ReadyProbeEnvironment {
                    peer_matches: |station_index, slot_index| {
                        peer_matches_full_scan(&state, base, &entities, station_index, slot_index)
                    },
                    route_economics: |supply_index, demand_index, demand_slot: &Slot| {
                        route_economics(
                            &state,
                            base,
                            &entities,
                            supply_index,
                            demand_index,
                            demand_slot,
                            None,
                        )
                    },
                    station_capacity: |_, demand: &Map<String, Value>, slot: &Slot| {
                        station_capacity(&state, base, demand, slot)
                    },
                },
            )
            .unwrap(),
        );
        assert_eq!(indexed_ready, full_ready);

        let local_supply =
            build_local_supply_directory(&entities, &state.factory_topology.station_indices);
        let full_updates = plan_congestion_updates_with(
            &runtime,
            &entities,
            &state.factory_topology.station_indices,
            &ledger,
            &local_supply,
            |station_index, slot_index, _| {
                Ok(
                    !peer_matches_full_scan(&state, base, &entities, station_index, slot_index)?
                        .is_empty(),
                )
            },
        )
        .unwrap();
        let mut expected = entities.clone();
        apply_congestion_updates(&mut expected, full_updates).unwrap();
        update_congestion(
            &state,
            base,
            &mut entities,
            &mut local_directory,
            &directory,
            &ledger,
        )
        .unwrap();
        assert_eq!(
            serde_json::to_vec(&entities).unwrap(),
            serde_json::to_vec(&expected).unwrap()
        );
    }

    #[test]
    fn sparse_congestion_matches_full_oracle_and_clears_completed_routes_once() {
        let count = 256;
        let mut entities = route_activity_matrix(240 + 16, &[(113, false, vec![])], 0.25, 120.0);
        for (index, entity) in entities.iter_mut().enumerate() {
            entity["planetId"] = Value::from(if index == 0 {
                "source_planet"
            } else {
                "demand_planet"
            });
            entity["stationSlots"][0]["itemId"] = if matches!(index, 0 | 7) {
                Value::from("iron_ore")
            } else {
                Value::Null
            };
            entity["stationSlots"][0]["remoteMode"] = Value::from(if index == 0 {
                "supply"
            } else if index == 7 {
                "demand"
            } else {
                "storage"
            });
        }
        let state = dispatch_fixture_state(&entities);
        let base = dispatch_fixture_base();
        let base = base.as_object().unwrap();
        let directory = InterstellarPeerDirectory::build(&state, base, &entities);
        assert!(!directory.congestion_requires_full_scan());
        assert_eq!(directory.congestion_demand_station_indices(), [7]);
        let mut local_directory = crate::local_logistics::prepare_step_directory(
            &entities,
            &state.factory_topology.station_indices,
        )
        .unwrap();
        local_directory.replace_interstellar_congestion_reset_station_indices(Vec::new());

        let apply_full_oracle = |source: &[Value], ledger: &StationRouteLedger| {
            let local_supply =
                build_local_supply_directory(source, &state.factory_topology.station_indices);
            let updates = plan_congestion_updates_with(
                &DeterministicRuntime::for_test(4),
                source,
                &state.factory_topology.station_indices,
                ledger,
                &local_supply,
                |station_index, slot_index, _| {
                    Ok(
                        !peer_matches_full_scan(&state, base, source, station_index, slot_index)?
                            .is_empty(),
                    )
                },
            )?;
            let mut expected = source.to_vec();
            apply_congestion_updates(&mut expected, updates)?;
            Ok::<_, anyhow::Error>(expected)
        };

        let activity = prepare_route_activity(&entities);
        let ledger = StationRouteLedger::build(&state, &entities, &local_directory, &activity);
        let expected = apply_full_oracle(&entities, &ledger).unwrap();
        let scan = update_congestion(
            &state,
            base,
            &mut entities,
            &mut local_directory,
            &directory,
            &ledger,
        )
        .unwrap();
        assert_eq!(scan.selected_station_rows, 3);
        assert_eq!(scan.total_station_rows, count);
        assert!(!scan.dense_fallback);
        assert_eq!(
            serde_json::to_vec(&entities).unwrap(),
            serde_json::to_vec(&expected).unwrap()
        );
        assert_eq!(
            local_directory.interstellar_congestion_reset_station_indices(),
            [0, 113]
        );

        entities[113]["stationRoutes"] = Value::Array(Vec::new());
        let activity = prepare_route_activity(&entities);
        let ledger = StationRouteLedger::build(&state, &entities, &local_directory, &activity);
        let expected = apply_full_oracle(&entities, &ledger).unwrap();
        let scan = update_congestion(
            &state,
            base,
            &mut entities,
            &mut local_directory,
            &directory,
            &ledger,
        )
        .unwrap();
        assert_eq!(scan.selected_station_rows, 3);
        assert_eq!(
            serde_json::to_vec(&entities).unwrap(),
            serde_json::to_vec(&expected).unwrap()
        );
        assert!(
            local_directory
                .interstellar_congestion_reset_station_indices()
                .is_empty()
        );

        let expected = apply_full_oracle(&entities, &ledger).unwrap();
        let scan = update_congestion(
            &state,
            base,
            &mut entities,
            &mut local_directory,
            &directory,
            &ledger,
        )
        .unwrap();
        assert_eq!(scan.selected_station_rows, 1);
        assert_eq!(
            serde_json::to_vec(&entities).unwrap(),
            serde_json::to_vec(&expected).unwrap()
        );
    }

    #[test]
    fn rebuilt_directory_wakes_player_slot_and_quantum_mode_changes() {
        let mut entities = dispatch_fixture_entities();
        entities[1]["stationWarpers"] = Value::from(1.0);
        entities[1]["stationSlots"][0]["remoteMode"] = Value::from("storage");
        entities[1]["quantumMode"] = Value::from("quantum");
        let state = dispatch_fixture_state(&entities);
        let base = dispatch_fixture_base();
        let stale_directory =
            InterstellarPeerDirectory::build(&state, base.as_object().unwrap(), &entities);
        assert!(stale_directory.demand_station_indices.is_empty());

        // Command and mode-transition changes occur between simulation calls.
        // The step entry point rebuilds this candidate-local directory before
        // readiness/dispatch, so the new demand is never omitted in production.
        entities[1]["stationSlots"][0]["remoteMode"] = Value::from("demand");
        entities[1]["quantumMode"] = Value::from("legacy");
        let rebuilt =
            InterstellarPeerDirectory::build(&state, base.as_object().unwrap(), &entities);
        assert_eq!(rebuilt.demand_station_indices, vec![1]);

        let mut activity = prepare_route_activity(&entities);
        let local_directory = crate::local_logistics::prepare_step_directory(
            &entities,
            &state.factory_topology.station_indices,
        )
        .unwrap();
        let ledger = StationRouteLedger::build(&state, &entities, &local_directory, &activity);
        let (_, scan) = plan_dispatch_demand_indices_with(
            &DeterministicRuntime::for_test(4),
            &state,
            base.as_object().unwrap(),
            &entities,
            &route_activity_powers(entities.len(), 1.0),
            &mut activity,
            &rebuilt,
            &ledger,
        )
        .unwrap();
        assert_eq!(scan.selected_demands, 1);
        assert!(!scan.directory_fallback);
    }

    #[test]
    fn peer_directory_reuses_same_base_and_rebuilds_research_exploration_or_mode_membership() {
        let mut entities = dispatch_fixture_entities();
        let state = dispatch_fixture_state(&entities);
        let mut base = dispatch_fixture_base();
        let mut directory = Arc::new(InterstellarPeerDirectory::build(
            &state,
            base.as_object().unwrap(),
            &entities,
        ));
        let mut activity = Arc::new(prepare_route_activity(&entities));
        Arc::make_mut(&mut activity)
            .pending_dispatch_demand_indices
            .clear();

        let stable = Arc::clone(&directory);
        refresh_peer_directory(
            &state,
            base.as_object().unwrap(),
            &entities,
            false,
            &mut directory,
            &mut activity,
        );
        assert!(Arc::ptr_eq(&stable, &directory));
        assert!(activity.pending_dispatch_demand_indices.is_empty());

        base["research"]["completedTechIds"]
            .as_array_mut()
            .unwrap()
            .push(Value::from("logistics_capacity_2"));
        refresh_peer_directory(
            &state,
            base.as_object().unwrap(),
            &entities,
            false,
            &mut directory,
            &mut activity,
        );
        assert!(!Arc::ptr_eq(&stable, &directory));
        assert_eq!(activity.pending_dispatch_demand_indices, vec![1]);

        Arc::make_mut(&mut activity)
            .pending_dispatch_demand_indices
            .clear();
        base["endgame"]["infiniteResearch"]["galactic_logistics"]["level"] = Value::from(1);
        let research_directory = Arc::clone(&directory);
        refresh_peer_directory(
            &state,
            base.as_object().unwrap(),
            &entities,
            false,
            &mut directory,
            &mut activity,
        );
        assert!(!Arc::ptr_eq(&research_directory, &directory));
        assert_eq!(activity.pending_dispatch_demand_indices, vec![1]);

        Arc::make_mut(&mut activity)
            .pending_dispatch_demand_indices
            .clear();
        entities[1]["quantumMode"] = Value::from("quantum");
        let logistics_directory = Arc::clone(&directory);
        refresh_peer_directory(
            &state,
            base.as_object().unwrap(),
            &entities,
            true,
            &mut directory,
            &mut activity,
        );
        assert!(!Arc::ptr_eq(&logistics_directory, &directory));
        assert!(directory.demand_station_indices.is_empty());
        assert!(activity.pending_dispatch_demand_indices.is_empty());
    }

    #[test]
    fn completed_routes_release_vessels_and_wake_dispatch_without_topology_rebuild() {
        let mut entities = dispatch_fixture_entities();
        entities[1]["stationWarpers"] = Value::from(1.0);
        let mut demand_owned = route_activity_remote_route(10, 1, 0.99, 1.0, true, &[]);
        demand_owned["vehicleCount"] = Value::from(10.0);
        let mut supply_owned = route_activity_remote_route(11, 1, 0.99, 1.0, true, &[]);
        supply_owned["vehicleCount"] = Value::from(10.0);
        supply_owned["vehicleStationId"] = Value::from("remote-station/00000/Ω");
        entities[1]["stationRoutes"] = Value::Array(vec![demand_owned, supply_owned]);

        let state = dispatch_fixture_state(&entities);
        let mut base = dispatch_fixture_base();
        let powers = route_activity_powers(entities.len(), 1.0);
        let directory =
            InterstellarPeerDirectory::build(&state, base.as_object().unwrap(), &entities);
        let mut activity = prepare_route_activity(&entities);
        let local_directory = crate::local_logistics::prepare_step_directory(
            &entities,
            &state.factory_topology.station_indices,
        )
        .unwrap();
        let mut ledger = StationRouteLedger::build(&state, &entities, &local_directory, &activity);
        let (_, blocked) = plan_dispatch_demand_indices_with(
            &DeterministicRuntime::for_test(4),
            &state,
            base.as_object().unwrap(),
            &entities,
            &powers,
            &mut activity,
            &directory,
            &ledger,
        )
        .unwrap();
        assert_eq!(blocked.selected_demands, 0);

        let changed = advance_routes(&state, &mut entities, 1.0, &powers, &mut activity).unwrap();
        activity.wake_dispatch_from_changed_stations(&directory, &changed);
        assert!(entities[1]["stationRoutes"].as_array().unwrap().is_empty());
        let local_directory = crate::local_logistics::prepare_step_directory(
            &entities,
            &state.factory_topology.station_indices,
        )
        .unwrap();
        ledger = StationRouteLedger::build(&state, &entities, &local_directory, &activity);
        let scan = dispatch_with_ledger(
            &state,
            base.as_object_mut().unwrap(),
            &mut entities,
            &powers,
            &mut activity,
            &directory,
            &mut ledger,
        )
        .unwrap();
        assert_eq!(scan.selected_demands, 1);
        assert_eq!(entities[1]["stationRoutes"].as_array().unwrap().len(), 1);
        assert_eq!(activity.active_demand_indices, vec![1]);
    }

    #[test]
    fn warper_arrival_allows_dispatch_and_immediately_wakes_remote_route() {
        let mut entities = dispatch_fixture_entities();
        let state = dispatch_fixture_state(&entities);
        let mut base = dispatch_fixture_base();
        let powers = route_activity_powers(entities.len(), 1.0);
        let mut activity = prepare_route_activity(&entities);
        let local_directory = crate::local_logistics::prepare_step_directory(
            &entities,
            &state.factory_topology.station_indices,
        )
        .unwrap();
        let mut route_ledger =
            StationRouteLedger::build(&state, &entities, &local_directory, &activity);
        let peer_directory =
            InterstellarPeerDirectory::build(&state, base.as_object().unwrap(), &entities);

        dispatch(
            &state,
            base.as_object_mut().unwrap(),
            &mut entities,
            &powers,
            &mut activity,
            &peer_directory,
            &mut route_ledger,
        )
        .unwrap();
        assert!(!activity.has_remote_routes());
        assert!(entities[1]["stationRoutes"].as_array().unwrap().is_empty());
        let local_directory = crate::local_logistics::prepare_step_directory(
            &entities,
            &state.factory_topology.station_indices,
        )
        .unwrap();
        assert_eq!(
            StationRouteLedger::build(&state, &entities, &local_directory, &activity)
                .scan()
                .selected_demands,
            0
        );

        entities[1]["stationWarpers"] = Value::from(1.0);
        activity.wake_dispatch_from_changed_stations(&peer_directory, &[1]);
        dispatch(
            &state,
            base.as_object_mut().unwrap(),
            &mut entities,
            &powers,
            &mut activity,
            &peer_directory,
            &mut route_ledger,
        )
        .unwrap();
        assert_eq!(activity.active_demand_indices, vec![1]);
        assert_eq!(entities[1]["stationRoutes"].as_array().unwrap().len(), 1);
        assert_eq!(
            entities[1]["stationRoutes"][0]["scope"],
            Value::from("remote")
        );
        assert_eq!(
            entities[1]["stationRoutes"][0]["requiresWarp"],
            Value::from(true)
        );
        assert_eq!(entities[1]["stationWarpers"], Value::from(0.0));
        let local_directory = crate::local_logistics::prepare_step_directory(
            &entities,
            &state.factory_topology.station_indices,
        )
        .unwrap();
        assert_eq!(
            StationRouteLedger::build(&state, &entities, &local_directory, &activity)
                .scan()
                .selected_demands,
            1,
            "warper/inventory-triggered dispatch must wake the shared ledger"
        );
    }

    #[test]
    fn failed_dispatch_candidate_does_not_install_activity_or_mutate_source_clone() {
        let source = dispatch_fixture_entities();
        let state = dispatch_fixture_state(&source);
        let source_json = serde_json::to_vec(&source).unwrap();
        let source_activity = Arc::new(prepare_route_activity(&source));
        let source_pending = source_activity.pending_dispatch_demand_indices.clone();
        let mut candidate_activity = Arc::clone(&source_activity);
        let candidate_runtime = Arc::make_mut(&mut candidate_activity);
        let mut candidate = source.clone();
        candidate[1]["stationWarpers"] = Value::from(1.0);
        candidate[1]["stationLastSupplyPeerBySlot"] = Value::Null;
        let candidate_before = serde_json::to_vec(&candidate).unwrap();
        let mut base = dispatch_fixture_base();
        let powers = route_activity_powers(candidate.len(), 1.0);
        let local_directory = crate::local_logistics::prepare_step_directory(
            &candidate,
            &state.factory_topology.station_indices,
        )
        .unwrap();
        let mut route_ledger =
            StationRouteLedger::build(&state, &candidate, &local_directory, candidate_runtime);
        let peer_directory =
            InterstellarPeerDirectory::build(&state, base.as_object().unwrap(), &candidate);

        let error = dispatch(
            &state,
            base.as_object_mut().unwrap(),
            &mut candidate,
            &powers,
            candidate_runtime,
            &peer_directory,
            &mut route_ledger,
        )
        .unwrap_err();
        assert_eq!(
            error.to_string(),
            "native interstellar fairness record is missing"
        );
        assert!(source_activity.active_demand_indices.is_empty());
        assert_eq!(
            source_activity.pending_dispatch_demand_indices, source_pending,
            "a failed candidate must not drain the source revision wake queue"
        );
        assert!(candidate_activity.active_demand_indices.is_empty());
        assert_eq!(serde_json::to_vec(&source).unwrap(), source_json);
        assert_ne!(
            serde_json::to_vec(&candidate).unwrap(),
            candidate_before,
            "the failed candidate may be partially mutated before its outer transaction discards it"
        );
    }

    #[test]
    fn successful_candidate_installs_route_activity_without_mutating_source_clone() {
        let mut entities = dispatch_fixture_entities();
        let dispatch_state = dispatch_fixture_state(&entities);
        let mut base = dispatch_fixture_base();
        let powers = route_activity_powers(entities.len(), 1.0);
        let mut activity = prepare_route_activity(&entities);
        entities[1]["stationWarpers"] = Value::from(1.0);
        let local_directory = crate::local_logistics::prepare_step_directory(
            &entities,
            &dispatch_state.factory_topology.station_indices,
        )
        .unwrap();
        let mut route_ledger =
            StationRouteLedger::build(&dispatch_state, &entities, &local_directory, &activity);
        let peer_directory =
            InterstellarPeerDirectory::build(&dispatch_state, base.as_object().unwrap(), &entities);
        dispatch(
            &dispatch_state,
            base.as_object_mut().unwrap(),
            &mut entities,
            &powers,
            &mut activity,
            &peer_directory,
            &mut route_ledger,
        )
        .unwrap();

        let mut state = dispatch_fixture_state(&entities);
        state.install_prepared_interstellar_route_activity(Arc::new(prepare_route_activity(
            &entities,
        )));
        let source = state.clone();
        let source_hash = source.canonical_sha256().unwrap();
        let source_activity = source.prepared_interstellar_route_activity().unwrap();
        assert_eq!(source_activity.active_demand_indices, vec![1]);
        let mut candidate_activity = state.prepared_interstellar_route_activity().unwrap();
        let candidate_runtime = Arc::make_mut(&mut candidate_activity);
        let mut candidate_entities = entities.clone();
        advance_routes(
            &state,
            &mut candidate_entities,
            1.0,
            &powers,
            candidate_runtime,
        )
        .unwrap();
        state.install_prepared_interstellar_route_activity(candidate_activity);
        let committed_activity = state.prepared_interstellar_route_activity().unwrap();
        assert_eq!(committed_activity.active_demand_indices, vec![1]);
        assert!(!Arc::ptr_eq(&source_activity, &committed_activity));
        assert_eq!(state.canonical_sha256().unwrap(), source_hash);
        assert_eq!(source.canonical_sha256().unwrap(), source_hash);
        assert_eq!(source_activity.active_demand_indices, vec![1]);
    }

    #[test]
    fn route_activity_keeps_runtime_elevator_rank_and_topology_rebuild_drops_removed_station() {
        let mut entities = dispatch_fixture_entities();
        let initial = prepare_route_activity(&entities);
        assert_eq!(initial.station_indices.as_ref(), &[0, 1]);
        entities[1]["stationOperationMode"] = Value::from("elevator");
        entities[1]["stationTier"] = Value::from(2);
        let runtime_transition = prepare_route_activity(&entities);
        assert_eq!(runtime_transition.station_indices.as_ref(), &[0, 1]);
        entities[1]["buildingId"] = Value::from("planetary_logistics_station");
        let rebuilt = prepare_route_activity(&entities);
        assert_eq!(rebuilt.station_indices.as_ref(), &[0]);
        assert!(rebuilt.active_demand_indices.is_empty());
    }

    #[test]
    fn elevator_transition_reclassifies_legacy_local_route_as_opaque_without_stale_arc() {
        let mut entities = dispatch_fixture_entities();
        entities[1]["stationRoutes"] = json!([{
            "id": "local-route-before-elevator",
            "scope": "local",
            "peerId": "remote-station/00000/Ω",
            "vehicleStationId": "remote-station/00001/Ω",
            "itemId": "iron_ore",
            "cargo": 4.0,
            "vehicleCount": 1.0,
            "progress": 0.25,
            "waypointStationIds": []
        }]);
        let mut runtime = Arc::new(prepare_route_activity(&entities));
        assert!(runtime.opaque_route_demand_indices().is_empty());
        let stable = Arc::clone(&runtime);
        refresh_route_activity_after_topology_change(&entities, false, &mut runtime);
        assert!(Arc::ptr_eq(&stable, &runtime));

        entities[1]["stationTier"] = Value::from(2);
        entities[1]["stationOperationMode"] = Value::from("elevator");
        refresh_route_activity_after_topology_change(&entities, true, &mut runtime);
        assert!(!Arc::ptr_eq(&stable, &runtime));
        assert_eq!(runtime.station_indices.as_ref(), &[0, 1]);
        assert_eq!(runtime.opaque_route_demand_indices(), &[1]);
        let state = dispatch_fixture_state(&entities);
        let local_directory = crate::local_logistics::prepare_step_directory(
            &entities,
            &state.factory_topology.station_indices,
        )
        .unwrap();
        assert!(!local_directory.contains_local_station(1));
        let ledger = StationRouteLedger::build(&state, &entities, &local_directory, &runtime);
        assert_eq!(ledger.scan().selected_demands, 1);
        assert_eq!(ledger.local_busy_raw(1), 1.0);
        assert_eq!(ledger.interstellar_in_flight(1, "iron_ore"), 4.0);
    }

    #[test]
    fn sparse_remote_route_advance_matches_full_oracle_for_direct_warp_and_relay_at_1_5_60() {
        let count = 256;
        let active = vec![
            (7, false, vec![]),
            (113, true, vec![]),
            (251, true, vec![89]),
        ];
        let source = route_activity_matrix(count, &active, 0.125, 120.0);
        let source_bytes = serde_json::to_vec(&source).unwrap();
        let powers = route_activity_powers(count, 1.0);

        for seconds in [1.0, 5.0, 60.0] {
            let sparse = run_route_activity_step(&source, seconds, false, &powers);
            let oracle = run_route_activity_step(&source, seconds, true, &powers);
            assert_eq!(sparse.2, active.len());
            assert!(!sparse.3);
            assert_eq!(
                serde_json::to_vec(&sparse.0).unwrap(),
                serde_json::to_vec(&oracle.0).unwrap(),
                "remote active replay diverged from full scan at {seconds}s"
            );
            assert_eq!(
                sparse.1.active_demand_indices,
                oracle.1.active_demand_indices
            );
            assert_eq!(
                sparse.1.active_demand_indices,
                active.iter().map(|entry| entry.0).collect::<Vec<_>>()
            );
        }
        assert_eq!(serde_json::to_vec(&source).unwrap(), source_bytes);
    }

    #[test]
    fn dense_remote_route_activity_falls_back_at_exactly_three_quarters() {
        let count = 80;
        let active = (1..=60)
            .map(|index| (index, index % 2 == 0, Vec::new()))
            .collect::<Vec<_>>();
        let source = route_activity_matrix(count, &active, 0.2, 90.0);
        let activity = prepare_route_activity(&source);
        let (indices, dense) = activity.route_scan_indices();
        assert!(dense);
        assert_eq!(indices, activity.station_indices.as_ref());
        let state = dispatch_fixture_state(&source);
        let local_directory = crate::local_logistics::prepare_step_directory(
            &source,
            &state.factory_topology.station_indices,
        )
        .unwrap();
        let shared = StationRouteLedger::build(&state, &source, &local_directory, &activity);
        let active_order_input_rows = local_directory.active_local_route_demand_indices().len()
            + activity.active_remote_route_demand_indices().len()
            + activity.opaque_route_demand_indices().len();
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
        assert_shared_interstellar_ledger_matches_legacy(&state, &source, &activity);
        for seconds in [1.0, 5.0, 60.0] {
            let scheduled = run_route_activity_step(
                &source,
                seconds,
                false,
                &route_activity_powers(count, 1.0),
            );
            let oracle =
                run_route_activity_step(&source, seconds, true, &route_activity_powers(count, 1.0));
            assert!(scheduled.3);
            assert_eq!(scheduled.2, count);
            assert_eq!(
                serde_json::to_vec(&scheduled.0).unwrap(),
                serde_json::to_vec(&oracle.0).unwrap()
            );
        }
    }

    #[test]
    fn relay_power_loss_keeps_route_awake_until_powered_completion_and_conserves_cargo() {
        let mut entities = route_activity_matrix(32, &[(7, true, vec![19])], 0.0, 8.0);
        entities[0]["outputs"]["iron_ore"] = Value::from(11.0);
        let indexes = indexes(&entities);
        let mut activity = prepare_route_activity(&entities);
        let source_total = item_amount(entities[0].as_object().unwrap(), "outputs", "iron_ore")
            + item_amount(entities[7].as_object().unwrap(), "outputs", "iron_ore");
        let mut powers = route_activity_powers(entities.len(), 1.0);
        powers.insert(19, 0.0);
        assert_eq!(
            activity
                .transition_route_view(&entities)
                .unwrap()
                .remote_routes("remote-station/00007/Ω")
                .len(),
            1
        );

        advance_routes_with_activity(&mut entities, 60.0, &powers, &indexes, &mut activity)
            .unwrap();
        assert_eq!(activity.active_demand_indices, vec![7]);
        assert_eq!(
            entities[7]["stationRoutes"][1]["progress"],
            Value::from(0.0)
        );
        assert_eq!(
            activity
                .transition_route_view(&entities)
                .unwrap()
                .remote_routes("remote-station/00007/Ω")[0]
                .progress,
            0.0
        );

        powers.insert(19, 1.0);
        let changed =
            advance_routes_with_activity(&mut entities, 8.0, &powers, &indexes, &mut activity)
                .unwrap();
        assert_eq!(changed, vec![0, 7, 19]);
        assert!(activity.active_demand_indices.is_empty());
        assert_eq!(entities[7]["stationRoutes"].as_array().unwrap().len(), 1);
        assert!(
            activity
                .transition_route_view(&entities)
                .unwrap()
                .remote_routes("remote-station/00007/Ω")
                .is_empty()
        );
        let completed_total = item_amount(entities[0].as_object().unwrap(), "outputs", "iron_ore")
            + item_amount(entities[7].as_object().unwrap(), "outputs", "iron_ore");
        assert_eq!(completed_total, source_total);
        assert_eq!(entities[0]["outputs"]["iron_ore"], Value::from(0.0));
        assert_eq!(entities[7]["outputs"]["iron_ore"], Value::from(11.0));
    }

    #[test]
    fn failed_remote_candidate_preserves_source_activity_static_cache_and_json() {
        let source =
            route_activity_matrix(128, &[(7, true, vec![]), (83, false, vec![])], 0.2, 30.0);
        let source_json = serde_json::to_vec(&source).unwrap();
        let source_activity = Arc::new(prepare_route_activity(&source));
        let source_active = source_activity.active_demand_indices.clone();
        let source_static = Arc::clone(&source_activity.station_indices);
        let mut candidate_activity = Arc::clone(&source_activity);
        let candidate_runtime = Arc::make_mut(&mut candidate_activity);
        assert!(Arc::ptr_eq(
            &source_static,
            &candidate_runtime.station_indices
        ));
        let mut candidate = source.clone();
        candidate[7]["stationRoutes"][0] = Value::Null;
        let candidate_before = serde_json::to_vec(&candidate).unwrap();
        let powers = route_activity_powers(candidate.len(), 1.0);

        let error = advance_routes_with_activity(
            &mut candidate,
            1.0,
            &powers,
            &indexes(&source),
            candidate_runtime,
        )
        .unwrap_err();
        assert_eq!(error.to_string(), "native interstellar route is invalid");
        assert_eq!(source_activity.active_demand_indices, source_active);
        assert_eq!(candidate_activity.active_demand_indices, source_active);
        assert!(source_activity.transition_route_view(&source).is_some());
        assert!(
            candidate_activity
                .transition_route_view(&candidate)
                .is_none()
        );
        assert_eq!(serde_json::to_vec(&source).unwrap(), source_json);
        assert_ne!(serde_json::to_vec(&candidate).unwrap(), candidate_before);
    }

    fn remote_route_pipeline_bytes(worker_count: usize) -> Vec<u8> {
        let count = PARALLEL_MIN_ITEMS + 31;
        let mut entities = route_activity_matrix(
            count,
            &[
                (7, false, vec![]),
                (2_057, true, vec![1_003]),
                (count - 1, true, vec![]),
            ],
            0.1,
            120.0,
        );
        let indexes = indexes(&entities);
        let mut activity = prepare_route_activity(&entities);
        advance_routes_with_activity(
            &mut entities,
            5.0,
            &route_activity_powers(count, 1.0),
            &indexes,
            &mut activity,
        )
        .unwrap();
        let ledger = build_ledger(&entities, &indexes);
        let local_supply =
            build_local_supply_directory(&entities, activity.station_indices.as_ref());
        let updates = plan_congestion_updates_with(
            &DeterministicRuntime::for_test(worker_count),
            &entities,
            activity.station_indices.as_ref(),
            &ledger,
            &local_supply,
            |_, _, _| Ok(false),
        )
        .unwrap();
        apply_congestion_updates(&mut entities, updates).unwrap();
        serde_json::to_vec(&json!({
            "entities": entities,
            "active": activity.active_demand_indices,
        }))
        .unwrap()
    }

    #[test]
    fn remote_route_pipeline_serialized_bytes_are_exact_for_1_2_4_8_workers() {
        let expected = remote_route_pipeline_bytes(1);
        for worker_count in [2, 4, 8] {
            assert_eq!(remote_route_pipeline_bytes(worker_count), expected);
        }
    }
}
