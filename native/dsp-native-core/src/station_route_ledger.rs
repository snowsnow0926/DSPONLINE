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
    /// Total rows consumed from the local, remote and opaque activity
    /// vectors while reconstructing the stable persisted-row order. This is
    /// bounded by the active set on the sparse path.
    pub active_order_input_rows: usize,
    /// Repeated wake membership shared by two activity domains is collapsed
    /// without changing the first persisted-row position.
    pub active_order_duplicate_rows: usize,
    /// Defensive compatibility path used only if an upstream activity vector
    /// violates its monotonic-order invariant. Healthy retained revisions use
    /// the linear merge and keep this false.
    pub active_order_fallback: bool,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct StableIndexOrderStats {
    input_rows: usize,
    duplicate_rows: usize,
    order_fallback: bool,
}

#[derive(Debug, Default, PartialEq, Eq)]
struct StableIndexOrder {
    indices: Vec<usize>,
    stats: StableIndexOrderStats,
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

/// Merge a fixed number of already persisted-row-ordered activity vectors.
///
/// Local, remote and opaque route runtimes all maintain non-decreasing entity
/// indices as routes wake and retire. A fixed-way merge therefore preserves
/// the exact legacy `sort_unstable + dedup` result while visiting each input
/// row once. The defensive sort is deliberately observable and only applies
/// if an internal caller violates that runtime invariant.
fn stable_index_union<const SOURCE_COUNT: usize>(
    sources: [&[usize]; SOURCE_COUNT],
) -> StableIndexOrder {
    let input_rows = sources.iter().map(|source| source.len()).sum::<usize>();
    let order_fallback = sources
        .iter()
        .any(|source| source.windows(2).any(|pair| pair[0] > pair[1]));
    if order_fallback {
        let mut indices = Vec::with_capacity(input_rows);
        for source in sources {
            indices.extend_from_slice(source);
        }
        indices.sort_unstable();
        indices.dedup();
        return StableIndexOrder {
            stats: StableIndexOrderStats {
                input_rows,
                duplicate_rows: input_rows.saturating_sub(indices.len()),
                order_fallback: true,
            },
            indices,
        };
    }

    let mut indices = Vec::with_capacity(input_rows);
    let mut cursors = [0usize; SOURCE_COUNT];
    loop {
        let next = sources
            .iter()
            .enumerate()
            .filter_map(|(source_index, source)| source.get(cursors[source_index]).copied())
            .min();
        let Some(next) = next else {
            break;
        };
        indices.push(next);
        for (source_index, source) in sources.iter().enumerate() {
            while source.get(cursors[source_index]).copied() == Some(next) {
                cursors[source_index] += 1;
            }
        }
    }
    StableIndexOrder {
        stats: StableIndexOrderStats {
            input_rows,
            duplicate_rows: input_rows.saturating_sub(indices.len()),
            order_fallback: false,
        },
        indices,
    }
}

fn opaque_rows_outside_station_topology(
    entities: &[Value],
    opaque_route_demand_indices: &[usize],
) -> usize {
    // CoreState's immutable station topology contains every persisted object
    // whose kind is `station`. Counting only opaque non-station rows keeps the
    // exact union cardinality without binary-searching the complete station
    // topology once per active MOD row.
    opaque_route_demand_indices
        .iter()
        .filter(|&&index| {
            entities
                .get(index)
                .and_then(Value::as_object)
                .and_then(|entity| string_at(entity, "kind"))
                != Some("station")
        })
        .count()
}

fn ordered_scan_indices(
    all_station_indices: &[usize],
    entities: &[Value],
    local_directory: &LocalPeerDirectory,
    remote_activity: &InterstellarRouteActivity,
) -> (Vec<usize>, StationRouteLedgerScan) {
    let active_order = stable_index_union([
        local_directory.active_local_route_demand_indices(),
        remote_activity.active_remote_route_demand_indices(),
        remote_activity.opaque_route_demand_indices(),
    ]);
    let mut active = active_order.indices;
    let mut total_candidate_rows = all_station_indices.len()
        + opaque_rows_outside_station_topology(
            entities,
            remote_activity.opaque_route_demand_indices(),
        );
    // A stale internal topology must never report fewer candidates than the
    // activity union that will actually be parsed. Valid sessions keep the
    // exact CoreState count above.
    total_candidate_rows = total_candidate_rows.max(active.len());

    let dense_fallback = !active.is_empty()
        && active
            .len()
            .saturating_mul(STATION_LEDGER_DENSE_DENOMINATOR)
            >= total_candidate_rows.saturating_mul(STATION_LEDGER_DENSE_NUMERATOR);
    let selected_demands = if dense_fallback {
        let dense_order = stable_index_union([
            all_station_indices,
            remote_activity.opaque_route_demand_indices(),
        ]);
        active = dense_order.indices;
        total_candidate_rows = total_candidate_rows.max(active.len());
        active.len()
    } else {
        active.len()
    };
    let scan = StationRouteLedgerScan {
        selected_demands,
        total_candidate_rows,
        dense_fallback,
        active_order_input_rows: active_order.stats.input_rows,
        active_order_duplicate_rows: active_order.stats.duplicate_rows,
        active_order_fallback: active_order.stats.order_fallback,
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
            entities,
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
                active_order_input_rows: 0,
                active_order_duplicate_rows: 0,
                active_order_fallback: false,
            },
        )
    }

    pub(crate) fn scan(&self) -> StationRouteLedgerScan {
        self.scan.unwrap_or(StationRouteLedgerScan {
            selected_demands: 0,
            total_candidate_rows: 0,
            dense_fallback: false,
            active_order_input_rows: 0,
            active_order_duplicate_rows: 0,
            active_order_fallback: false,
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

#[cfg(test)]
mod tests {
    use super::*;

    fn legacy_sorted_union<const SOURCE_COUNT: usize>(
        sources: [&[usize]; SOURCE_COUNT],
    ) -> Vec<usize> {
        let mut oracle = sources
            .iter()
            .flat_map(|source| source.iter().copied())
            .collect::<Vec<_>>();
        oracle.sort_unstable();
        oracle.dedup();
        oracle
    }

    fn insert_wake(indices: &mut Vec<usize>, index: usize) {
        if let Err(position) = indices.binary_search(&index) {
            indices.insert(position, index);
        }
    }

    fn retire(indices: &mut Vec<usize>, index: usize) {
        if let Ok(position) = indices.binary_search(&index) {
            indices.remove(position);
        }
    }

    fn next_random(seed: &mut u64) -> u64 {
        *seed = seed
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        *seed
    }

    #[test]
    fn stable_active_order_matches_legacy_sort_oracle_for_random_overlapping_sources() {
        let mut seed = 0x9e37_79b9_7f4a_7c15u64;
        for round in 0..2_048usize {
            let row_count = 1 + (next_random(&mut seed) as usize % 1_024);
            let mut local = Vec::new();
            let mut remote = Vec::new();
            let mut opaque = Vec::new();
            for index in 0..row_count {
                let mask = next_random(&mut seed);
                if mask & 1 != 0 {
                    local.push(index);
                }
                if mask & 2 != 0 {
                    remote.push(index);
                }
                if mask & 4 != 0 {
                    opaque.push(index);
                }
                // Repeated wakes within one queue remain legal input and are
                // collapsed by the same linear cursor advance.
                if mask & 0x80 != 0 && index == round % row_count {
                    opaque.push(index);
                }
            }
            let sources = [local.as_slice(), remote.as_slice(), opaque.as_slice()];
            let expected = legacy_sorted_union(sources);
            let merged = stable_index_union(sources);
            assert_eq!(merged.indices, expected, "random round {round}");
            assert_eq!(
                merged.stats.input_rows,
                local.len() + remote.len() + opaque.len()
            );
            assert_eq!(
                merged.stats.duplicate_rows,
                merged.stats.input_rows - merged.indices.len()
            );
            assert!(!merged.stats.order_fallback);
        }
    }

    #[test]
    fn stable_active_order_survives_repeated_wakes_retires_and_topology_rebuilds_long_run() {
        let mut seed = 0xd1b5_4a32_d192_ed03u64;
        let mut local = Vec::new();
        let mut remote = Vec::new();
        let mut opaque = Vec::new();
        let mut topology_rows = 512usize;

        for step in 0..50_000usize {
            let event = next_random(&mut seed);
            let index = event as usize % topology_rows;
            let target = match (event >> 16) % 3 {
                0 => &mut local,
                1 => &mut remote,
                _ => &mut opaque,
            };
            if event & 1 == 0 {
                insert_wake(target, index);
                // A second identical wake must be a no-op.
                insert_wake(target, index);
            } else {
                retire(target, index);
            }

            let topology_rebuilt = step > 0 && step % 997 == 0;
            if topology_rebuilt {
                // Model an entity-table rebuild: removed rows disappear and
                // the remaining active sets are reconstructed in the new
                // persisted-row order before simulation resumes.
                topology_rows = 257 + (next_random(&mut seed) as usize % 768);
                local.retain(|index| *index < topology_rows);
                remote.retain(|index| *index < topology_rows);
                opaque.retain(|index| *index < topology_rows);
            }

            // Keep the mutation stream long without making the regression
            // suite allocate two oracle vectors after every individual wake.
            // Every rebuild and a stable cadence across all other operations
            // is still checked, plus the exact terminal state below.
            if !topology_rebuilt && step % 31 != 0 {
                continue;
            }
            let sources = [local.as_slice(), remote.as_slice(), opaque.as_slice()];
            let expected = legacy_sorted_union(sources);
            let merged = stable_index_union(sources);
            assert_eq!(merged.indices, expected, "long-run step {step}");
            assert!(!merged.stats.order_fallback);
            assert_eq!(
                merged.stats.input_rows,
                local.len() + remote.len() + opaque.len()
            );
        }
        let sources = [local.as_slice(), remote.as_slice(), opaque.as_slice()];
        let merged = stable_index_union(sources);
        assert_eq!(merged.indices, legacy_sorted_union(sources));
        assert!(!merged.stats.order_fallback);
    }

    #[test]
    fn stable_active_order_has_deterministic_compatibility_fallback_for_invalid_source_order() {
        let local = [1, 9, 4, 9];
        let remote = [2, 4, 8];
        let opaque = [0, 9];
        let sources = [local.as_slice(), remote.as_slice(), opaque.as_slice()];
        let merged = stable_index_union(sources);
        assert_eq!(merged.indices, legacy_sorted_union(sources));
        assert!(merged.stats.order_fallback);
        assert_eq!(merged.stats.input_rows, 9);
        assert_eq!(merged.stats.duplicate_rows, 3);
    }

    #[test]
    fn stable_dense_candidate_order_is_linear_and_matches_persisted_union_oracle() {
        let all_stations = (0..100_000usize).step_by(2).collect::<Vec<_>>();
        let opaque = (0..100_000usize).step_by(5).collect::<Vec<_>>();
        let sources = [all_stations.as_slice(), opaque.as_slice()];
        let merged = stable_index_union(sources);
        assert_eq!(merged.indices, legacy_sorted_union(sources));
        assert_eq!(merged.stats.input_rows, 70_000);
        assert_eq!(merged.stats.duplicate_rows, 10_000);
        assert!(!merged.stats.order_fallback);
    }
}
