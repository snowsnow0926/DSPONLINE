use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use serde_json::Value;

use crate::interstellar_logistics::InterstellarRouteActivity;
use crate::local_logistics::LocalPeerDirectory;
use crate::state::CoreState;

const STATION_LEDGER_DENSE_NUMERATOR: usize = 3;
const STATION_LEDGER_DENSE_DENOMINATOR: usize = 4;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct StationRouteLedgerScan {
    pub selected_demands: usize,
    pub total_candidate_rows: usize,
    pub dense_fallback: bool,
}

/// Candidate-local, non-persisted summary of every in-flight station route.
///
/// The builder consumes the stable topology-order union of local, remote and
/// opaque/MOD demand rows. Sparse factories therefore avoid reparsing dormant
/// station rows, while a 75% active set deliberately falls back to the legacy
/// flat station order. The summary never becomes command authority and is
/// rebuilt after dispatch/advance mutations before another consumer uses it.
#[derive(Debug, Default)]
pub(crate) struct StationRouteLedger {
    local_station_ranks: Arc<HashMap<usize, usize>>,
    local_busy_floor: HashMap<usize, f64>,
    local_busy_raw: HashMap<usize, f64>,
    remote_busy_floor: HashMap<usize, f64>,
    local_reserved: HashMap<usize, HashMap<String, f64>>,
    interstellar_reserved: HashMap<usize, HashMap<String, f64>>,
    local_in_flight: HashMap<usize, HashMap<String, f64>>,
    interstellar_in_flight: HashMap<usize, HashMap<String, f64>>,
    /// Exact permissive legacy quantum views. Unlike logistics dispatch,
    /// quantum buffer settlement counts every route shape and floors only
    /// after summing raw cargo, including opaque/MOD scopes.
    quantum_reserved_outgoing: HashMap<usize, HashMap<String, f64>>,
    quantum_in_flight: HashMap<usize, HashMap<String, f64>>,
    local_active_vehicle_load: HashMap<usize, f64>,
    interstellar_active_vehicle_load: HashMap<usize, f64>,
    active_progress: HashMap<usize, f64>,
    active_local_progress: HashMap<usize, f64>,
    active_local_stations: HashSet<usize>,
    active_remote_stations: HashSet<usize>,
    scan: Option<StationRouteLedgerScan>,
}

fn finite_number(value: Option<&Value>) -> f64 {
    value
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
        .unwrap_or(0.0)
}

fn string_at<'a>(value: &'a serde_json::Map<String, Value>, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn add_item(
    target: &mut HashMap<usize, HashMap<String, f64>>,
    station_index: usize,
    item_id: &str,
    amount: f64,
) {
    *target
        .entry(station_index)
        .or_default()
        .entry(item_id.to_owned())
        .or_default() += amount;
}

fn item_amount(
    target: &HashMap<usize, HashMap<String, f64>>,
    station_index: usize,
    item_id: &str,
) -> f64 {
    target
        .get(&station_index)
        .and_then(|items| items.get(item_id))
        .copied()
        .unwrap_or(0.0)
}

fn ordered_scan_indices(
    all_station_indices: &[usize],
    local_directory: &LocalPeerDirectory,
    remote_activity: &InterstellarRouteActivity,
) -> (Vec<usize>, StationRouteLedgerScan) {
    let total_candidate_rows = all_station_indices.len()
        + remote_activity
            .opaque_route_demand_indices()
            .iter()
            .filter(|index| all_station_indices.binary_search(index).is_err())
            .count();
    let mut active = Vec::with_capacity(
        local_directory.active_local_route_demand_indices().len()
            + remote_activity.active_remote_route_demand_indices().len()
            + remote_activity.opaque_route_demand_indices().len(),
    );
    active.extend_from_slice(local_directory.active_local_route_demand_indices());
    active.extend_from_slice(remote_activity.active_remote_route_demand_indices());
    active.extend_from_slice(remote_activity.opaque_route_demand_indices());
    active.sort_unstable();
    active.dedup();

    let dense_fallback = !active.is_empty()
        && active
            .len()
            .saturating_mul(STATION_LEDGER_DENSE_DENOMINATOR)
            >= total_candidate_rows.saturating_mul(STATION_LEDGER_DENSE_NUMERATOR);
    let selected_demands = if dense_fallback {
        active.clear();
        active.reserve(total_candidate_rows);
        active.extend_from_slice(all_station_indices);
        active.extend_from_slice(remote_activity.opaque_route_demand_indices());
        active.sort_unstable();
        active.dedup();
        active.len()
    } else {
        active.len()
    };
    let scan = StationRouteLedgerScan {
        selected_demands,
        total_candidate_rows,
        dense_fallback,
    };
    (active, scan)
}

impl StationRouteLedger {
    pub(crate) fn build(
        state: &CoreState,
        entities: &[Value],
        local_directory: &LocalPeerDirectory,
        remote_activity: &InterstellarRouteActivity,
    ) -> Self {
        let (scan_indices, scan) = ordered_scan_indices(
            &state.factory_topology.station_indices,
            local_directory,
            remote_activity,
        );
        Self::build_for_indices(state, entities, local_directory, &scan_indices, scan)
    }

    fn build_for_indices(
        state: &CoreState,
        entities: &[Value],
        local_directory: &LocalPeerDirectory,
        scan_indices: &[usize],
        scan: StationRouteLedgerScan,
    ) -> Self {
        let mut ledger = Self {
            local_station_ranks: local_directory.shared_station_ranks(),
            scan: Some(scan),
            ..Self::default()
        };
        let mut active_stations = Vec::<usize>::with_capacity(8);
        for &demand_index in scan_indices {
            let Some(demand) = entities.get(demand_index).and_then(Value::as_object) else {
                continue;
            };
            let Some(routes) = demand.get("stationRoutes").and_then(Value::as_array) else {
                continue;
            };
            // The former local ledger deliberately ignored custom station
            // kinds and elevator-mode ILS rows, while the interstellar ledger
            // parsed every object. Keep those two legacy visibility domains
            // distinct even though the JSON row is parsed only once here.
            let visible_to_local = local_directory.contains_local_station(demand_index);
            for route in routes.iter().filter_map(Value::as_object) {
                let owner = string_at(route, "vehicleStationId")
                    .or_else(|| string_at(demand, "id"))
                    .and_then(|id| state.entity_index.get(id))
                    .copied()
                    .unwrap_or(demand_index);
                let supply = string_at(route, "peerId")
                    .and_then(|id| state.entity_index.get(id))
                    .copied();
                let raw_cargo = finite_number(route.get("cargo"));
                if let Some(item_id) = string_at(route, "itemId") {
                    add_item(
                        &mut ledger.quantum_in_flight,
                        demand_index,
                        item_id,
                        raw_cargo,
                    );
                    if let Some(supply) = supply {
                        add_item(
                            &mut ledger.quantum_reserved_outgoing,
                            supply,
                            item_id,
                            raw_cargo,
                        );
                    }
                }
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
                    .filter_map(|id| state.entity_index.get(id).copied())
                {
                    if !active_stations.contains(&waypoint) {
                        active_stations.push(waypoint);
                    }
                }

                let progress = finite_number(route.get("progress"));
                for &station_index in &active_stations {
                    let current = ledger.active_progress.entry(station_index).or_default();
                    *current = current.max(progress);
                }

                let scope = string_at(route, "scope");
                if !matches!(scope, Some("local" | "remote")) {
                    continue;
                }
                let raw_vehicles = finite_number(route.get("vehicleCount"));
                let vehicles = raw_vehicles.floor().max(0.0);
                let cargo = finite_number(route.get("cargo")).floor().max(0.0);
                let item_id = string_at(route, "itemId").unwrap_or_default();
                if scope == Some("local") {
                    *ledger.local_busy_raw.entry(owner).or_default() += raw_vehicles;
                    if visible_to_local {
                        *ledger.local_busy_floor.entry(owner).or_default() += vehicles;
                        for &station_index in &active_stations {
                            ledger.active_local_stations.insert(station_index);
                            let current = ledger
                                .active_local_progress
                                .entry(station_index)
                                .or_default();
                            *current = current.max(progress);
                        }
                    }
                } else {
                    *ledger.remote_busy_floor.entry(owner).or_default() += vehicles;
                    ledger
                        .active_remote_stations
                        .extend(active_stations.iter().copied());
                }
                add_item(
                    &mut ledger.interstellar_in_flight,
                    demand_index,
                    item_id,
                    cargo,
                );
                if let Some(supply) = supply {
                    add_item(&mut ledger.interstellar_reserved, supply, item_id, cargo);
                }
                for &station_index in &active_stations {
                    *ledger
                        .interstellar_active_vehicle_load
                        .entry(station_index)
                        .or_default() += vehicles;
                }
                if visible_to_local {
                    add_item(&mut ledger.local_in_flight, demand_index, item_id, cargo);
                    if let Some(supply) = supply {
                        add_item(&mut ledger.local_reserved, supply, item_id, cargo);
                    }
                    for &station_index in &active_stations {
                        *ledger
                            .local_active_vehicle_load
                            .entry(station_index)
                            .or_default() += vehicles;
                    }
                }
            }
        }
        ledger
    }

    #[cfg(test)]
    pub(crate) fn build_full_oracle(
        state: &CoreState,
        entities: &[Value],
        local_directory: &LocalPeerDirectory,
    ) -> Self {
        let indices = (0..entities.len()).collect::<Vec<_>>();
        Self::build_for_indices(
            state,
            entities,
            local_directory,
            &indices,
            StationRouteLedgerScan {
                selected_demands: indices.len(),
                total_candidate_rows: indices.len(),
                dense_fallback: true,
            },
        )
    }

    pub(crate) fn scan(&self) -> StationRouteLedgerScan {
        self.scan.unwrap_or(StationRouteLedgerScan {
            selected_demands: 0,
            total_candidate_rows: 0,
            dense_fallback: false,
        })
    }

    pub(crate) fn local_busy_floor(&self, station_index: usize) -> f64 {
        self.local_busy_floor
            .get(&station_index)
            .copied()
            .unwrap_or(0.0)
    }

    pub(crate) fn local_busy_raw(&self, station_index: usize) -> f64 {
        self.local_busy_raw
            .get(&station_index)
            .copied()
            .unwrap_or(0.0)
    }

    pub(crate) fn remote_busy_floor(&self, station_index: usize) -> f64 {
        self.remote_busy_floor
            .get(&station_index)
            .copied()
            .unwrap_or(0.0)
    }

    pub(crate) fn local_in_flight(&self, station_index: usize, item_id: &str) -> f64 {
        item_amount(&self.local_in_flight, station_index, item_id)
    }

    pub(crate) fn local_reserved(&self, station_index: usize, item_id: &str) -> f64 {
        item_amount(&self.local_reserved, station_index, item_id)
    }

    pub(crate) fn local_active_vehicle_load(&self, station_index: usize) -> f64 {
        self.local_active_vehicle_load
            .get(&station_index)
            .copied()
            .unwrap_or(0.0)
    }

    pub(crate) fn interstellar_in_flight(&self, station_index: usize, item_id: &str) -> f64 {
        item_amount(&self.interstellar_in_flight, station_index, item_id)
    }

    pub(crate) fn interstellar_reserved(&self, station_index: usize, item_id: &str) -> f64 {
        item_amount(&self.interstellar_reserved, station_index, item_id)
    }

    pub(crate) fn quantum_reserved_outgoing(&self, station_index: usize, item_id: &str) -> f64 {
        item_amount(&self.quantum_reserved_outgoing, station_index, item_id)
    }

    pub(crate) fn quantum_in_flight(&self, station_index: usize, item_id: &str) -> f64 {
        item_amount(&self.quantum_in_flight, station_index, item_id)
    }

    pub(crate) fn interstellar_active_vehicle_load(&self, station_index: usize) -> f64 {
        self.interstellar_active_vehicle_load
            .get(&station_index)
            .copied()
            .unwrap_or(0.0)
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn record_local_dispatch(
        &mut self,
        demand_index: usize,
        supply_index: usize,
        owner_index: usize,
        item_id: &str,
        cargo: f64,
        vehicles: f64,
        progress: f64,
    ) {
        *self.local_busy_floor.entry(owner_index).or_default() += vehicles;
        *self.local_busy_raw.entry(owner_index).or_default() += vehicles;
        add_item(&mut self.local_reserved, supply_index, item_id, cargo);
        add_item(
            &mut self.interstellar_reserved,
            supply_index,
            item_id,
            cargo,
        );
        add_item(&mut self.local_in_flight, demand_index, item_id, cargo);
        add_item(
            &mut self.interstellar_in_flight,
            demand_index,
            item_id,
            cargo,
        );
        add_item(
            &mut self.quantum_reserved_outgoing,
            supply_index,
            item_id,
            cargo,
        );
        add_item(&mut self.quantum_in_flight, demand_index, item_id, cargo);
        let mut active_stations = Vec::with_capacity(3);
        for station_index in [demand_index, supply_index, owner_index] {
            if !active_stations.contains(&station_index) {
                active_stations.push(station_index);
            }
        }
        for station_index in active_stations {
            *self
                .local_active_vehicle_load
                .entry(station_index)
                .or_default() += vehicles;
            *self
                .interstellar_active_vehicle_load
                .entry(station_index)
                .or_default() += vehicles;
            self.active_local_stations.insert(station_index);
            let local_progress = self.active_local_progress.entry(station_index).or_default();
            *local_progress = local_progress.max(progress);
            let active_progress = self.active_progress.entry(station_index).or_default();
            *active_progress = active_progress.max(progress);
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn record_remote_dispatch(
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
        *self.remote_busy_floor.entry(owner_index).or_default() += vehicles;
        add_item(
            &mut self.interstellar_reserved,
            supply_index,
            item_id,
            cargo,
        );
        add_item(
            &mut self.interstellar_in_flight,
            demand_index,
            item_id,
            cargo,
        );
        add_item(
            &mut self.quantum_reserved_outgoing,
            supply_index,
            item_id,
            cargo,
        );
        add_item(&mut self.quantum_in_flight, demand_index, item_id, cargo);
        let visible_to_local = self.local_station_ranks.contains_key(&demand_index);
        if visible_to_local {
            add_item(&mut self.local_reserved, supply_index, item_id, cargo);
            add_item(&mut self.local_in_flight, demand_index, item_id, cargo);
        }
        let mut active_stations = Vec::with_capacity(3);
        for station_index in [demand_index, supply_index, owner_index] {
            if !active_stations.contains(&station_index) {
                active_stations.push(station_index);
            }
        }
        for station_index in active_stations {
            *self
                .interstellar_active_vehicle_load
                .entry(station_index)
                .or_default() += vehicles;
            self.active_remote_stations.insert(station_index);
            let active_progress = self.active_progress.entry(station_index).or_default();
            *active_progress = active_progress.max(progress);
            if visible_to_local {
                *self
                    .local_active_vehicle_load
                    .entry(station_index)
                    .or_default() += vehicles;
            }
        }
        // Preserve the legacy incremental-dispatch behavior: the three route
        // endpoints are de-duplicated together, while every persisted waypoint
        // contributes its own vehicle-load entry in route order.
        for &waypoint_index in waypoint_indices {
            *self
                .interstellar_active_vehicle_load
                .entry(waypoint_index)
                .or_default() += vehicles;
            self.active_remote_stations.insert(waypoint_index);
            let active_progress = self.active_progress.entry(waypoint_index).or_default();
            *active_progress = active_progress.max(progress);
            if visible_to_local {
                *self
                    .local_active_vehicle_load
                    .entry(waypoint_index)
                    .or_default() += vehicles;
            }
        }
    }

    pub(crate) fn active_progress(&self, station_index: usize) -> f64 {
        self.active_progress
            .get(&station_index)
            .copied()
            .unwrap_or(0.0)
    }

    /// Exact post-route membership used by station-mode settlement. Every
    /// parsed route inserts its demand, owner, peer and resolvable waypoint
    /// before scope-specific filtering, so membership remains true even for a
    /// zero-progress route or an opaque/MOD scope.
    pub(crate) fn references_station(&self, station_index: usize) -> bool {
        self.active_progress.contains_key(&station_index)
    }

    /// A default/placeholder ledger cannot prove absence. Callers that use a
    /// negative membership result must fall back unless the ledger came from a
    /// complete sparse/dense build.
    pub(crate) fn has_route_reference_index(&self) -> bool {
        self.scan.is_some()
    }

    pub(crate) fn active_local_progress(&self, station_index: usize) -> f64 {
        self.active_local_progress
            .get(&station_index)
            .copied()
            .unwrap_or(0.0)
    }

    pub(crate) fn is_active_local_station(&self, station_index: usize) -> bool {
        self.active_local_stations.contains(&station_index)
    }

    pub(crate) fn is_active_remote_station(&self, station_index: usize) -> bool {
        self.active_remote_stations.contains(&station_index)
    }

    pub(crate) fn active_station_indices(&self) -> Vec<usize> {
        let mut indices = self.active_progress.keys().copied().collect::<Vec<_>>();
        indices.sort_unstable();
        indices
    }

    pub(crate) fn active_local_station_indices(&self) -> Vec<usize> {
        let mut indices = self
            .active_local_stations
            .iter()
            .copied()
            .collect::<Vec<_>>();
        indices.sort_unstable();
        indices
    }
}
